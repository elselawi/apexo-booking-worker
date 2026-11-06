import bookingCss from "../assets/booking.css";
import { BOOKING_CLIENT_JS as bookingJs } from "./client_script.generated";

import { authenticate, configRead, deleteClinic, diagnostics, publicConfig, requireAdmin, rotate, throttleInvalidKeys, writeConfig } from "./clinic";
import { clinicByHandle } from "./db";
import { CONFIG_BODY_LIMIT, REQUEST_BODY_LIMIT, type Env } from "./env";
import { sweep } from "./cron";
import {
  BodyTooLarge,
  corsHeadersFor,
  errorJson,
  html,
  isAllowedAppOrigin,
  isSameOrigin,
  json,
  readBoundedText,
  text,
  clientAddress,
} from "./http";
import { handleRegistration } from "./register";
import {
  assetPath,
  localeCookie,
  pageHeaders,
  randomNonce,
  renderClinicPage,
  renderNotFound,
  renderPrivacy,
  renderSuspended,
  resolveLocale,
} from "./pages";
import { deleteRequest, pullRequests, setRequestState, submitRequest } from "./requests";
import { verifyTurnstile } from "./turnstile";
import { logEvent } from "./log";
import { configFromRow } from "./db";

const ASSET_CACHE = "public, max-age=31536000, immutable";

function isReady(env: Env): boolean {
  return Boolean(
    env.DB &&
      env.PUBLIC_ORIGIN &&
      env.BOOKING_HMAC_KEY &&
      env.TURNSTILE_SECRET &&
      env.TURNSTILE_SITE_KEY,
  );
}

async function readJsonBody(request: Request, limit: number): Promise<unknown | Response> {
  let body: string;
  try {
    body = await readBoundedText(request, limit);
  } catch (error) {
    if (error instanceof BodyTooLarge) return errorJson(413, "too_large");
    return errorJson(400, "bad_request");
  }
  if (body.length === 0) return errorJson(400, "bad_request");
  try {
    return JSON.parse(body);
  } catch {
    return errorJson(400, "bad_request");
  }
}

function options(request: Request, env: Env): Response {
  const cors = corsHeadersFor(request, env);
  if (!cors) return errorJson(403, "forbidden");
  return new Response(null, { status: 204, headers: cors });
}

async function handleClinicApi(env: Env, request: Request, path: string): Promise<Response> {
  const cors = corsHeadersFor(request, env);
  if (cors === null) return errorJson(403, "forbidden");
  const session = await authenticate(env, request);
  if (session instanceof Response) {
    await throttleInvalidKeys(env, request);
    return withHeaders(session, cors);
  }
  const adminOnly = [
    "/v1/clinic/config/read",
    "/v1/clinic/config",
      "/v1/clinic/requests/delete",
    "/v1/clinic/rotate",
    "/v1/clinic/delete",
  ].includes(path);
  if (adminOnly) {
    const denied = requireAdmin(session);
    if (denied) return withHeaders(denied, cors);
  }

  const now = Date.now();

  if (path === "/v1/clinic/diagnostics") {
    return withHeaders(await diagnostics(env, session), cors);
  }
  if (path === "/v1/clinic/config/read") {
    return withHeaders(configRead(env, session), cors);
  }
  if (path === "/v1/clinic/config") {
    const body = await readJsonBody(request, CONFIG_BODY_LIMIT);
    if (body instanceof Response) return withHeaders(body, cors);
    return withHeaders(await writeConfig(env, session, body), cors);
  }
  if (path === "/v1/clinic/rotate") {
    const body = await readJsonBody(request, CONFIG_BODY_LIMIT);
    if (body instanceof Response) return withHeaders(body, cors);
    return withHeaders(await rotate(env, session, body), cors);
  }
  if (path === "/v1/clinic/delete") {
    const body = await readJsonBody(request, CONFIG_BODY_LIMIT);
    if (body instanceof Response) return withHeaders(body, cors);
    return withHeaders(await deleteClinic(env, session, body), cors);
  }
  if (path === "/v1/clinic/requests/pull") {
    const body = await readJsonBody(request, CONFIG_BODY_LIMIT);
    if (body instanceof Response) return withHeaders(body, cors);
    return withHeaders(await pullRequests({ env, clinic: session.clinic, now, body }), cors);
  }
  if (path === "/v1/clinic/requests/state") {
    const body = await readJsonBody(request, CONFIG_BODY_LIMIT);
    if (body instanceof Response) return withHeaders(body, cors);
    return withHeaders(await setRequestState(env, session.clinic, body, now), cors);
  }
  if (path === "/v1/clinic/requests/delete") {
    const body = await readJsonBody(request, CONFIG_BODY_LIMIT);
    if (body instanceof Response) return withHeaders(body, cors);
    return withHeaders(await deleteRequest(env, session.clinic, body), cors);
  }
  return withHeaders(errorJson(404, "not_found"), cors);
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "OPTIONS" && path.startsWith("/v1/")) {
        return options(request, env);
      }

      if (path === "/health") {
        if (!isReady(env)) return json({ ok: false, version: 1 }, 503);
        // `?deep=1` proves the Turnstile secret against siteverify with a dummy
        // token: a valid secret rejects the token, an invalid one says so.
        if (url.searchParams.get("deep") === "1") {
          const probe = await verifyTurnstile(env, "XXXX.DUMMY.TOKEN.XXXX", "127.0.0.1");
          const codes = probe.codes ?? [];
          const secret = codes.some(
            (code) => code === "invalid-input-secret" || code === "missing-input-secret",
          )
            ? "invalid-secret"
            : probe.ok || codes.includes("invalid-input-response")
              ? "ok"
              : codes.join(",") || "unknown";
          return json({ ok: true, version: 1, turnstile: secret });
        }
        return json({ ok: true, version: 1 });
      }

      if (path === "/privacy") {
        if (!isReady(env)) return errorJson(503, "unavailable");
        const locale = resolveLocale(request, "en");
        const nonce = randomNonce();
        const headers = pageHeaders(nonce);
        if (url.searchParams.get("lang") === locale) {
          headers["set-cookie"] = localeCookie(locale, url.protocol === "https:");
        }
        return html(renderPrivacy(locale, nonce), 200, headers);
      }

      if (path.startsWith("/assets/")) {
        const file = path.slice("/assets/".length);
        if (file === assetPath("booking.css").slice("/assets/".length)) {
          return text(bookingCss, "text/css; charset=utf-8", ASSET_CACHE);
        }
        if (file === assetPath("booking.js").slice("/assets/".length)) {
          return text(bookingJs, "text/javascript; charset=utf-8", ASSET_CACHE);
        }
        return errorJson(404, "not_found");
      }

      if (request.method === "POST" && (path === "/v1/register" || path === "/v1/recover")) {
        const rid = crypto.randomUUID().slice(0, 8);
        const started = Date.now();
        const action = path === "/v1/register" ? "register" : "recover";
        if (!isReady(env)) {
          logEvent("warn", "register_failed", { rid, action, code: "not_ready", status: 503 });
          return errorJson(503, "unavailable");
        }
        if (!isAllowedAppOrigin(env, request)) {
          logEvent("warn", "register_failed", {
            rid,
            action,
            code: "origin_not_allowed",
            status: 403,
          });
          return errorJson(403, "forbidden");
        }
        const body = await readJsonBody(request, CONFIG_BODY_LIMIT);
        if (body instanceof Response) return body;
        const response = await handleRegistration({
          env,
          body,
          address: clientAddress(request),
          now: Date.now(),
          action,
        });
        logEvent(response.ok ? "info" : "warn", response.ok ? "register_ok" : "register_refused", {
          rid,
          action,
          status: response.status,
          ms: Date.now() - started,
        });
        const cors = corsHeadersFor(request, env);
        const headers = { ...(cors ?? {}), "x-request-id": rid };
        return withHeaders(response, headers);
      }

      if (request.method === "POST" && path.startsWith("/v1/clinic/")) {
        if (!isReady(env)) return withHeaders(errorJson(503, "unavailable"), corsHeadersFor(request, env) ?? {});
        return await handleClinicApi(env, request, path);
      }

      const publicClinic = /^\/v1\/clinics\/([a-z0-9-]{3,63})$/.exec(path);
      if (publicClinic && request.method === "GET") {
        const cors = corsHeadersFor(request, env);
        if (cors === null) return errorJson(403, "forbidden");
        if (!isReady(env)) return withHeaders(errorJson(503, "unavailable"), cors);
        const clinic = await clinicByHandle(env.DB, publicClinic[1]!);
        if (!clinic || clinic.status !== "live") return withHeaders(errorJson(404, "unknown_clinic"), cors);
        return withHeaders(json(publicConfig(clinic)), cors);
      }

      const submission = /^\/v1\/clinics\/([a-z0-9-]{3,63})\/requests$/.exec(path);
      if (submission && request.method === "POST") {
        const rid = crypto.randomUUID().slice(0, 8);
        if (!isReady(env)) return errorJson(503, "unavailable");
        if (!isSameOrigin(env, request)) {
          logEvent("warn", "submit_failed", {
            rid,
            handle: submission[1]!,
            code: "origin_mismatch",
            status: 403,
            origin: request.headers.get("origin") ?? "",
          });
          return errorJson(403, "forbidden");
        }
        const clinic = await clinicByHandle(env.DB, submission[1]!);
        if (!clinic || clinic.status !== "live") {
          logEvent("warn", "submit_failed", {
            rid,
            handle: submission[1]!,
            code: "unknown_clinic",
            status: 404,
          });
          return errorJson(404, "unknown_clinic");
        }
        let body: string;
        try {
          body = await readBoundedText(request, REQUEST_BODY_LIMIT);
        } catch (error) {
          if (error instanceof BodyTooLarge) return errorJson(413, "too_large");
          return errorJson(400, "bad_request");
        }
        const response = await submitRequest({
          env,
          request,
          clinic,
          body,
          address: clientAddress(request),
          now: Date.now(),
          rid,
              });
        return withHeaders(response, { "x-request-id": rid });
      }

      if (request.method === "GET" && /^\/[a-z0-9-]{3,63}$/.test(path)) {
        if (!isReady(env)) return errorJson(503, "unavailable");
        const handle = path.slice(1);
        const clinic = await clinicByHandle(env.DB, handle);
        if (!clinic) {
          const nonce = randomNonce();
          return html(renderNotFound(resolveLocale(request, "en"), nonce), 404, pageHeaders(nonce));
        }
        if (clinic.status !== "live") {
          const nonce = randomNonce();
          return html(renderSuspended(resolveLocale(request, "en"), nonce), 404, pageHeaders(nonce));
        }
        const config = configFromRow(clinic);
        const locale = resolveLocale(request, config.profile.defaultLanguage);
        const page = renderClinicPage(
          clinic,
          {
            origin: env.PUBLIC_ORIGIN,
            consentVersion: clinic.consent_version,
            turnstileSiteKey: env.TURNSTILE_SITE_KEY,
            nowMs: Date.now(),
          },
          locale,
        );
        const headers = pageHeaders(page.nonce);
        if (url.searchParams.get("lang") === locale) {
          headers["set-cookie"] = localeCookie(locale, url.protocol === "https:");
        }
        return html(page.html, 200, headers);
      }

      return errorJson(404, "not_found");
    } catch (error) {
      console.error("booking_worker_error", error instanceof Error ? error.message : "unknown");
      return withHeaders(errorJson(500, "unavailable"), corsHeadersFor(request, env) ?? {});
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
};
