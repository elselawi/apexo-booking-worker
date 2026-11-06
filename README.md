# Apexo online booking Worker

The public booking page and request inbox API for Apexo, running on Cloudflare
Workers + D1 at `https://book.apexo.app`.

Patients open `https://book.apexo.app/<handle>`, see the clinic's hours, and send
a request (name, phone, optional email and note, and when they can come). The
request lands in the clinic's inbox inside the Apexo app; staff schedule it
through the normal patient/appointment dialogs. **Nothing is booked
automatically** — this is a request inbox, not a reservation engine.

This project is a sibling repository of `apexo-flutter`; the app talks to it over
the `/v1/clinic/*` API with the keys a clinic enrolls.

## Quick start

```powershell
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest (workers pool) + the browser client tests
npm run build       # wrangler deploy --dry-run --outdir=dist
npm run dev         # local Worker on http://127.0.0.1:8787
```

`npm test` runs two suites: `vitest run` against a miniflare D1 (every migration
is applied from `migrations/`, so a schema change must ship as a migration), and
`node --test test/browser-client.test.mjs`, which exercises the real
`assets/booking.js` in a DOM.

## Layout

| Path | Contents |
|---|---|
| `src/index.ts` | Routing, request ids, readiness, `/health` |
| `src/pages.ts` | Server-rendered clinic page and privacy notice |
| `src/requests.ts` | Submission validation, Turnstile, admission, inbox pull/state |
| `src/register.ts` | Enrollment, recovery and key rotation (operation proofs) |
| `src/clinic.ts` | Authenticated clinic API: config, diagnostics, deletion |
| `src/config.ts` | Clinic configuration validation, `LANGUAGES` |
| `src/hours.ts`, `src/time.ts`, `src/preference.ts` | Opening hours, clinic clock, when-can-you-come |
| `src/turnstile.ts`, `src/rate.ts`, `src/crypto.ts` | Abuse control |
| `src/db.ts` | Row shapes and the request projection |
| `src/log.ts` | Structured logging (one JSON object per line) |
| `assets/` | `booking.css`, `booking.js`, `i18n/*.json` (10 locales) |
| `migrations/` | D1 schema, applied in order |
| `test/` | Worker tests and the browser-client tests |
| `tools/` | `embed-client.mjs` inlines the assets into the bundle |

## Deployment

```powershell
npx wrangler d1 migrations apply apexo-booking --remote   # additive first
npx wrangler deploy
```

Migrations are additive and safe to run before the deploy; a migration that
drops columns goes in its own file so it can run after the new version is
serving.

- **D1**: `apexo-booking`, binding **`DB`** (the code reads `env.DB`). Never set
  `remote: true` on that binding — tests drop and recreate the schema.
- **Secrets** (`wrangler secret put …`): `TURNSTILE_SECRET`,
  `BOOKING_HMAC_KEY`.
- **Vars** (`wrangler.jsonc`): `PUBLIC_ORIGIN` must be the *exact* origin serving
  the page (it is the submission `Origin` check); `TURNSTILE_SITE_KEY` /
  `TURNSTILE_HOSTNAME` (widget hostname + action `booking_submit`);
  `APP_ORIGINS` lists every Flutter web origin allowed to call the studio API
  (currently `https://web.apexo.app`; native clients send no `Origin`).
- **Enrollment gate**: `PROOF_EGRESS` must stay `disabled` until connection-time
  public-address egress is verified — `/v1/register` and `/v1/recover` answer
  `503 enrollment_disabled` otherwise. To verify again, deploy a throwaway
  Worker that fetches private targets and confirm Cloudflare refuses to connect
  (`1003` for private/link-local/CGNAT/loopback literals, `1016` for a hostname
  resolving to a private address).

### Checking a deployment

```powershell
curl https://book.apexo.app/health          # {"ok":true,"version":1}
curl "https://book.apexo.app/health?deep=1" # also proves the Turnstile secret
```

`deep=1` posts a dummy token to siteverify and reports `"turnstile":"ok"` or
`"turnstile":"invalid-secret"`. Run it right after rotating `TURNSTILE_SECRET`: a
wrong secret is otherwise indistinguishable from a patient's rejected token in
the logs, and every submission fails with `503 turnstile_unavailable`.

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` (gitignored) holds Turnstile's always-pass test pair and
`ALLOW_TEST_SECRET=1`, which is what lets the Worker accept them — production
never sets it, so a test secret fails closed. `wrangler dev` rewrites the request
host to the `routes` entry, so `PUBLIC_ORIGIN` is `http://book.apexo.app` in that
file, and a page served from `localhost` is rejected by the origin check. Use
plain `wrangler dev` for UI work; `--remote` would use the production vars and
secrets.

## Contracts the app depends on

- **Receipts.** A submission returns `{requestId, reference}`. `reference` is the
  memorable code patients quote — the clinic-local submission day plus that
  day's ordinal (`1106-03`). Ordinals come from `request_counters`
  (`clinic_id`, `ref_day` → last issued number), so a deleted or expired request
  never reissues its number. `requestId` (32 hex) stays internal.
- **Inbox.** `POST /v1/clinic/requests/pull` takes `status`, `beforeSeq` and the
  signed `snapshot` cursor, and returns `items`, `nextBeforeSeq`, `snapshot` and
  the pending count. Cursors only move backwards through `seq`; a non-advancing
  page is an error, never a silent truncation.
- **State.** `POST /v1/clinic/requests/state` applies a versioned
  `handled`/`declined` transition (`expectedVersion`, and `linkedId` for
  handled). A stale version answers `409 state_conflict`, which the app surfaces
  as "someone else decided first".
- **Public config.** `GET /v1/clinics/:handle` publishes exactly
  `clinicId, handle, enabled, profile, timeZone, dialCode, hours, closedDates,
  configRevision, consentVersion` — no contact email, no keys.
- **Privacy.** The page collects only what the clinic needs to call back; the
  inbox stores requests for 90 days (30 after handling) and the app keeps them in
  memory only.

## Logging

Every line is one JSON object with an `evt` key, so Workers Logs can filter on
`submit_admitted`, `submit_failed`, `submit_replay`, `turnstile_ok`,
`register_ok`, … Failures carry a short `rid` (also returned as `x-request-id`)
and Turnstile diagnostics (`turnstile`, `siteverifyStatus`, `codes`,
`secretLength`). Never a token, a secret or a patient field. A rejected token
answers `422 verification_failed` ("please complete the verification") rather
than pretending the service is down.

## Tests to run before deploying

```powershell
npm run typecheck
npm test
```

The suite covers admission atomicity and quotas, idempotent replays, reference
numbering, versioned state transitions, retention sweeps, the registration proof
(including races and interrupted retries), CORS, Turnstile classification and the
public page's locale/RTL behaviour. A schema change belongs in
`migrations/` and needs a test that a fresh database passes.
