import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { CONSENT_VERSION } from "../src/env";
import { addDays, weekdayOf, zoneDate } from "../src/time";
import { sweep } from "../src/cron";
import { baseConfig, resetDatabase, ADMIN_KEY, CLINIC_ID, HANDLE, INBOX_KEY, authHeaders, seedClinic } from "./helpers";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

function stubTurnstile(): void {
  (globalThis as unknown as { fetch: FetchHandler }).fetch = async () =>
    new Response(
      JSON.stringify({ success: true, hostname: "book.test", action: "booking_submit" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function nextMonday(): string {
  const today = zoneDate(Date.now(), "UTC");
  const delta = (1 - weekdayOf(today) + 7) % 7 || 7;
  return addDays(today, delta);
}

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Jane Doe",
    phone: "+966551234567",
    email: "jane@example.com",
    note: "Please call after 16:00",
    preference: { kind: "exact", date: nextMonday(), from: "09:00", to: "13:00" },
    language: "en",
    consentVersion: CONSENT_VERSION,
    consentAccepted: true,
    turnstileToken: "token-value",
    ...overrides,
  };
}

async function submit(
  options: {
    body?: Record<string, unknown>;
    idem?: string;
    ip?: string;
    origin?: string;
    handle?: string;
  } = {},
): Promise<Response> {
  return SELF.fetch(`https://book.test/v1/clinics/${options.handle ?? HANDLE}/requests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: options.origin ?? "https://book.test",
      "idempotency-key": options.idem ?? crypto.randomUUID(),
      "cf-connecting-ip": options.ip ?? "203.0.113.7",
    },
    body: JSON.stringify(options.body ?? submission()),
  });
}

async function clinicCall(
  path: string,
  body: unknown,
  key = INBOX_KEY,
): Promise<Response> {
  return SELF.fetch(`https://book.test${path}`, {
    method: "POST",
    headers: authHeaders(key),
    body: JSON.stringify(body),
  });
}

interface SeedRequestOptions {
  requestId: string;
  status?: "pending" | "handled" | "declined";
  version?: number;
  createdAt?: number;
  expiresAt?: number;
  clinicId?: string;
  linkedId?: string | null;
  handledAt?: number | null;
  candidateDates?: string[];
}

let seqCounter = 0;

async function insertRequest(options: SeedRequestOptions): Promise<void> {
  const now = options.createdAt ?? Date.now();
  const clinicId = options.clinicId ?? CLINIC_ID;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO admission_context (request_id, pending_cap, quotas) VALUES (?, 500, '[]')",
    ).bind(options.requestId),
    env.DB.prepare(
      `INSERT INTO requests (
         request_id, clinic_id, idem_key, body_hash, name, phone, email, note, preference,
         candidate_dates, config_rev, from_date, to_date, window_from, window_to, time_zone,
         language, consent, created_at, expires_at, ref_day, ref_seq,
         status, version, handled_at, linked_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', ?, ?, ?, ?, ?)`,
    ).bind(
      options.requestId,
      clinicId,
      `idem-${options.requestId}`,
      "hash",
      "Jane Doe",
      "+966551234567",
      null,
      null,
      JSON.stringify({ kind: "exact", date: nextMonday(), from: "09:00", to: "13:00" }),
      JSON.stringify(options.candidateDates ?? [nextMonday()]),
      1,
      nextMonday(),
      nextMonday(),
      "09:00",
      "13:00",
      "UTC",
      "en",
      CONSENT_VERSION,
      now,
      options.expiresAt ?? now + 90 * 24 * 60 * 60 * 1000,
      seqCounter++,
      options.status ?? "pending",
      options.version ?? 1,
      options.handledAt ?? null,
      options.linkedId ?? null,
    ),
    env.DB.prepare("DELETE FROM admission_context WHERE request_id = ?").bind(options.requestId),
  ]);
}

beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetDatabase();
});

describe("submission", () => {
  it("stores a request and returns a receipt", async () => {
    await seedClinic();
    stubTurnstile();
    const response = await submit();
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      ok: boolean;
      requestId: string;
      reference: string;
      status: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("received");
    expect(payload.reference).toMatch(/^\d{4}-\d{2}$/);

    const row = await env.DB.prepare("SELECT * FROM requests WHERE request_id = ?")
      .bind(payload.requestId)
      .first<{
        name: string;
        phone: string;
        candidate_dates: string;
        time_zone: string;
        config_rev: number;
        status: string;
      }>();
    expect(row?.name).toBe("Jane Doe");
    expect(row?.phone).toBe("+966551234567");
    expect(JSON.parse(row!.candidate_dates)).toEqual([nextMonday()]);
    expect(row?.time_zone).toBe("UTC");
    expect(row?.status).toBe("pending");

    const revision = await env.DB.prepare("SELECT inbox_revision FROM clinics WHERE clinic_id = ?")
      .bind(CLINIC_ID)
      .first<{ inbox_revision: number }>();
    expect(revision?.inbox_revision).toBe(1);
  });

  it("numbers references per clinic and day", async () => {
    await seedClinic();
    stubTurnstile();
    const first = (await (await submit()).json()) as { reference: string };
    stubTurnstile();
    const second = (await (await submit({ body: submission({ phone: "+966551234568" }) })).json()) as {
      reference: string;
    };
    expect(first.reference).toMatch(/^\d{4}-01$/);
    expect(second.reference).toBe(first.reference.replace(/-01$/, "-02"));

    await resetDatabase();
    await seedClinic({ handle: "secondclinic" });
    stubTurnstile();
    const other = (await (await submit({ handle: "secondclinic" })).json()) as { reference: string };
    expect(other.reference).toMatch(/^\d{4}-01$/);
  });

  it("returns the original receipt for a replay and never duplicates", async () => {
    await seedClinic();
    stubTurnstile();
    const idem = crypto.randomUUID();
    const first = await submit({ idem });
    const firstPayload = (await first.json()) as { requestId: string; reference: string };
    stubTurnstile();
    const second = await submit({ idem });
    expect(second.status).toBe(200);
    const secondPayload = (await second.json()) as { requestId: string; reference: string };
    expect(secondPayload.requestId).toBe(firstPayload.requestId);
    expect(secondPayload.reference).toBe(firstPayload.reference);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM requests").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("returns the complete receipt for racing identical submissions", async () => {
    await seedClinic();
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    (globalThis as unknown as { fetch: FetchHandler }).fetch = async () => {
      if (++arrived === 2) release();
      await barrier;
      return new Response(JSON.stringify({ success: true, hostname: "book.test", action: "booking_submit" }));
    };
    const idem = crypto.randomUUID();
    const responses = await Promise.all([submit({ idem }), submit({ idem })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(responses.map((response) => response.json()));
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]).toHaveProperty("reference", expect.stringMatching(/^\d{4}-01$/));
  });

  it("never reuses a receipt number after deleting the newest request", async () => {
    await seedClinic();
    stubTurnstile();
    const first = await (await submit()).json() as { requestId: string; reference: string };
    const second = await (await submit()).json() as { requestId: string; reference: string };
    expect((await clinicCall("/v1/clinic/requests/delete", { requestId: second.requestId }, ADMIN_KEY)).status).toBe(200);
    const third = await (await submit()).json() as { reference: string };
    expect(third.reference).toBe(first.reference.replace(/-01$/, "-03"));
  });

  it("reports a conflicting fingerprint for the same idempotency key", async () => {
    await seedClinic();
    stubTurnstile();
    const idem = crypto.randomUUID();
    expect((await submit({ idem })).status).toBe(201);
    const conflict = await submit({ idem, body: submission({ name: "Someone Else" }) });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });

  it("rejects disabled clinics, wrong origins and unknown fields", async () => {
    await seedClinic({ config: { ...baseConfig(), enabled: false } });
    stubTurnstile();
    const disabled = await submit();
    expect(disabled.status).toBe(409);
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe("clinic_disabled");

    await resetDatabase();
    await seedClinic();
    const wrongOrigin = await submit({ origin: "https://evil.test" });
    expect(wrongOrigin.status).toBe(403);

    const unknown = await submit({ body: submission({ extra: true }) });
    expect(unknown.status).toBe(422);
    const unknownPayload = (await unknown.json()) as { error: { fields: Record<string, string> } };
    expect(unknownPayload.error.fields["body"]).toBe("invalid");
  });

  it("reports field codes without echoing values", async () => {
    await seedClinic();
    stubTurnstile();
    const response = await submit({ body: submission({ phone: "0551234567", email: "nope" }) });
    expect(response.status).toBe(422);
    const text = await response.text();
    const payload = JSON.parse(text) as { error: { code: string; fields: Record<string, string> } };
    expect(payload.error.code).toBe("invalid_fields");
    expect(payload.error.fields["phone"]).toBe("invalid");
    expect(payload.error.fields["email"]).toBe("invalid");
    expect(text).not.toContain("0551234567");
  });

  it("never admits a request without a verified Turnstile token", async () => {
    await seedClinic();
    (globalThis as unknown as { fetch: FetchHandler }).fetch = async () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const response = await submit();
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "verification_failed",
    );

    // A bad secret is answered with HTTP 400 by siteverify: that is our
    // problem, not the patient's, and must not look like a retryable token.
    (globalThis as unknown as { fetch: FetchHandler }).fetch = async () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    expect((await submit()).status).toBe(503);

    // A rejected token on an HTTP 400 is still the token's fault.
    (globalThis as unknown as { fetch: FetchHandler }).fetch = async () =>
      new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    expect((await submit()).status).toBe(422);

    (globalThis as unknown as { fetch: FetchHandler }).fetch = async () => {
      throw new Error("network down");
    };
    expect((await submit()).status).toBe(503);
  });

  it("enforces the per-address admission quota", async () => {
    await seedClinic();
    const ip = "198.51.100.9";
    for (let index = 0; index < 5; index++) {
      stubTurnstile();
      const response = await submit({
        ip,
        body: submission({ name: `Patient ${index}` }),
      });
      expect(response.status).toBe(201);
    }
    stubTurnstile();
    const limited = await submit({ ip, body: submission({ name: "Patient 6" }) });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});

describe("pull", () => {
  it("pages through a snapshot and refuses a stale revision", async () => {
    await seedClinic();
    for (let index = 0; index < 3; index++) {
      await insertRequest({ requestId: `req0000000000${index}` });
    }
    const first = await clinicCall("/v1/clinic/requests/pull", {
      status: "pending",
      beforeSeq: null,
      snapshot: null,
      limit: 2,
    });
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<{ requestId: string }>;
      nextBeforeSeq: number | null;
      snapshot: string | null;
      pending: number;
    };
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.pending).toBe(3);
    expect(firstPage.nextBeforeSeq).not.toBeNull();
    expect(firstPage.snapshot).not.toBeNull();

    const second = await clinicCall("/v1/clinic/requests/pull", {
      status: "pending",
      beforeSeq: firstPage.nextBeforeSeq,
      snapshot: firstPage.snapshot,
      limit: 2,
    });
    const secondPage = (await second.json()) as {
      items: Array<{ requestId: string }>;
      nextBeforeSeq: number | null;
    };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextBeforeSeq).toBeNull();

    // A mutation between pages invalidates the snapshot rather than losing a row.
    const third = await clinicCall("/v1/clinic/requests/pull", {
      status: "pending",
      beforeSeq: 1,
      snapshot: firstPage.snapshot,
      limit: 2,
    });
    expect(third.status).toBe(200);

    await insertRequest({ requestId: "req00000000009" });
    const stale = await clinicCall("/v1/clinic/requests/pull", {
      status: "pending",
      beforeSeq: firstPage.nextBeforeSeq,
      snapshot: firstPage.snapshot,
      limit: 2,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("snapshot_changed");
  });

  it("excludes expired requests without waiting for cron", async () => {
    await seedClinic();
    const now = Date.now();
    await insertRequest({
      requestId: "reqexpired0001",
      createdAt: now - 100_000,
      expiresAt: now - 1000,
    });
    await insertRequest({ requestId: "reqlive00000001" });
    const response = await clinicCall("/v1/clinic/requests/pull", {
      status: "pending",
      beforeSeq: null,
      snapshot: null,
      limit: 50,
    });
    const page = (await response.json()) as {
      items: Array<{ requestId: string }>;
      pending: number;
    };
    expect(page.items.map((item) => item.requestId)).toEqual(["reqlive00000001"]);
    expect(page.pending).toBe(1);

    await sweep(env, now);
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM requests").first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it("keeps tenants separate", async () => {
    await seedClinic();
    await insertRequest({ requestId: "reqotherclinic1" });
    await env.DB.prepare(
      `INSERT INTO clinics (
         clinic_id, handle, status, enabled, server_url, admin_key_hash, inbox_key_hash,
         profile, time_zone, dial_code, hours, closed_dates, config_rev, created_at, consent_version
       ) VALUES (?, ?, 'live', 1, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, ?)`,
    )
      .bind(
        "fedcba9876543210fedcba9876543210",
        "otherclinic",
        "https://pb.other-clinic.dev",
        await import("../src/crypto").then((module) => module.sha256Hex("F".repeat(43))),
        await import("../src/crypto").then((module) => module.sha256Hex("G".repeat(43))),
        JSON.stringify(baseConfig().profile),
        "UTC",
        "+1",
        JSON.stringify(baseConfig().hours),
        Date.now(),
        CONSENT_VERSION,
      )
      .run();
    const response = await clinicCall("/v1/clinic/requests/pull", {
      status: "all",
      beforeSeq: null,
      snapshot: null,
      limit: 50,
    });
    const page = (await response.json()) as { items: unknown[] };
    expect(page.items).toHaveLength(1);

    const foreignKey = "G".repeat(43);
    const otherClinic = await clinicCall(
      "/v1/clinic/requests/pull",
      { status: "all", beforeSeq: null, snapshot: null, limit: 50 },
      foreignKey,
    );
    const otherPage = (await otherClinic.json()) as { items: unknown[] };
    expect(otherPage.items).toHaveLength(0);
  });
});

describe("queue capacity", () => {
  it("refuses a new request once 500 unexpired pending rows exist", async () => {
    await seedClinic();
    const now = Date.now();
    for (let start = 0; start < 500; start += 100) {
      const statements: D1PreparedStatement[] = [];
      for (let index = start; index < start + 100; index++) {
        const id = `reqbulk${String(index).padStart(8, "0")}`;
        statements.push(
          env.DB.prepare(
            "INSERT INTO admission_context (request_id, pending_cap, quotas) VALUES (?, 500, '[]')",
          ).bind(id),
          env.DB.prepare(
            `INSERT INTO requests (
               request_id, clinic_id, idem_key, body_hash, name, phone, preference, candidate_dates,
               config_rev, from_date, to_date, window_from, window_to, time_zone, language, consent,
               created_at, expires_at, ref_day, ref_seq
             ) VALUES (?, ?, ?, 'hash', 'Jane Doe', '+966551234567', '{}', '[]', 1, '2026-11-09',
                       '2026-11-09', '09:00', '13:00', 'UTC', 'en', ?, ?, ?, '2026-01-02', ?)`,
          ).bind(id, CLINIC_ID, `idem-${id}`, CONSENT_VERSION, now, now + 86_400_000, index),
          env.DB.prepare("DELETE FROM admission_context WHERE request_id = ?").bind(id),
        );
      }
      await env.DB.batch(statements);
    }
    stubTurnstile();
    const response = await submit({ body: submission({ name: "Another Patient" }) });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("queue_full");
  });
});

describe("outbound calls", () => {
  it("touches only Turnstile and never a notification relay", async () => {
    await seedClinic();
    const urls: string[] = [];
    (globalThis as unknown as { fetch: FetchHandler }).fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://challenges.cloudflare.com")) {
        return new Response(
          JSON.stringify({ success: true, hostname: "book.test", action: "booking_submit" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const response = await submit();
    expect(response.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(urls).toEqual(["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  });
});

describe("state", () => {
  it("applies a versioned transition and tolerates identical retries", async () => {
    await seedClinic();
    await insertRequest({ requestId: "reqstatetest01" });
    const handled = await clinicCall("/v1/clinic/requests/state", {
      requestId: "reqstatetest01",
      expectedVersion: 1,
      state: "handled",
      linkedId: "appointment001",
    });
    expect(handled.status).toBe(200);
    expect(((await handled.json()) as { version: number }).version).toBe(2);

    const retry = await clinicCall("/v1/clinic/requests/state", {
      requestId: "reqstatetest01",
      expectedVersion: 1,
      state: "handled",
      linkedId: "appointment001",
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { version: number }).version).toBe(2);

    const conflict = await clinicCall("/v1/clinic/requests/state", {
      requestId: "reqstatetest01",
      expectedVersion: 1,
      state: "declined",
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("state_conflict");

    const row = await env.DB.prepare("SELECT status, linked_id, handled_at FROM requests WHERE request_id = ?")
      .bind("reqstatetest01")
      .first<{ status: string; linked_id: string; handled_at: number }>();
    expect(row?.status).toBe("handled");
    expect(row?.linked_id).toBe("appointment001");
    expect(row?.handled_at).toBeGreaterThan(0);
  });

  it("requires a bounded linked appointment id for handled", async () => {
    await seedClinic();
    await insertRequest({ requestId: "reqstatetest02" });
    const missing = await clinicCall("/v1/clinic/requests/state", {
      requestId: "reqstatetest02",
      expectedVersion: 1,
      state: "handled",
    });
    expect(missing.status).toBe(400);
    const tooLong = await clinicCall("/v1/clinic/requests/state", {
      requestId: "reqstatetest02",
      expectedVersion: 1,
      state: "handled",
      linkedId: "x".repeat(65),
    });
    expect(tooLong.status).toBe(400);
  });

  it("treats erased and unknown requests the same", async () => {
    await seedClinic();
    await insertRequest({ requestId: "reqstatetest03" });
    const deleted = await clinicCall("/v1/clinic/requests/delete", { requestId: "reqstatetest03" }, ADMIN_KEY);
    expect(deleted.status).toBe(200);
    const again = await clinicCall("/v1/clinic/requests/delete", { requestId: "reqstatetest03" }, ADMIN_KEY);
    expect(again.status).toBe(200);

    const state = await clinicCall("/v1/clinic/requests/state", {
      requestId: "reqstatetest03",
      expectedVersion: 1,
      state: "declined",
    });
    expect(state.status).toBe(404);
    const unknown = await clinicCall("/v1/clinic/requests/state", {
      requestId: "requnknown0001",
      expectedVersion: 1,
      state: "declined",
    });
    expect(unknown.status).toBe(404);
  });
});

describe("clinic configuration", () => {
  it("detects concurrent configuration edits", async () => {
    await seedClinic();
    const read = await clinicCall("/v1/clinic/config/read", {}, ADMIN_KEY);
    const current = (await read.json()) as { config: Record<string, unknown>; revision: number };
    const update = { ...current.config, profile: { ...(current.config["profile"] as object), welcome: "Hello" } };

    const first = await clinicCall("/v1/clinic/config", { expectedRevision: current.revision, config: update }, ADMIN_KEY);
    expect(first.status).toBe(200);
    const stale = await clinicCall("/v1/clinic/config", { expectedRevision: current.revision, config: update }, ADMIN_KEY);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("config_conflict");
  });

  it("reports diagnostics without leaking account ids", async () => {
    await seedClinic();
    const response = await clinicCall("/v1/clinic/diagnostics", {});
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      handle: HANDLE,
      status: "live",
      enabled: true,
      pending: 0,
    });
    expect(body).not.toContain("pbaccountid");
  });
});

describe("leaving the platform", () => {
  it("erases the clinic, its requests, its counters and its proofs", async () => {
    await seedClinic();
    await insertRequest({ requestId: "7d6f5c7e-1a2b-4c3d-9e8f-0a1b2c3d4e5f" });
    // A real admission leaves a receipt counter behind; that must not outlive
    // the clinic either.
    stubTurnstile();
    expect((await submit()).status).toBe(201);

    const byInboxKey = await clinicCall(
      "/v1/clinic/delete",
      { confirmHandle: HANDLE },
      INBOX_KEY,
    );
    expect(byInboxKey.status).toBe(403);

    const wrongHandle = await clinicCall(
      "/v1/clinic/delete",
      { confirmHandle: "not-this-one" },
      ADMIN_KEY,
    );
    expect(wrongHandle.status).toBe(422);

    const confirmed = await clinicCall(
      "/v1/clinic/delete",
      { confirmHandle: HANDLE },
      ADMIN_KEY,
    );
    expect(confirmed.status).toBe(200);

    for (const table of ["clinics", "requests", "request_counters", "challenges"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
        count: number;
      }>();
      expect(row?.count, table).toBe(0);
    }

    const page = await SELF.fetch(`https://book.test/${HANDLE}`);
    expect(page.status).toBe(404);
    const key = await clinicCall("/v1/clinic/diagnostics", {}, ADMIN_KEY);
    expect(key.status).toBe(401);
  });
});
