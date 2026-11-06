import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { canonicalOrigin } from "../src/origin";
import { fetchProof, handleSuggestions, isHandle, MAX_CLINICS, parseOperation } from "../src/register";
import { sha256Hex } from "../src/crypto";
import { baseConfig, resetDatabase, ADMIN_KEY, CLINIC_ID, HANDLE, INBOX_KEY, SERVER_URL, authHeaders } from "./helpers";
import { validateConfig } from "../src/config";

const APP_ORIGIN = "https://app.test";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;

function stubFetch(handler: FetchHandler): void {
  (globalThis as unknown as { fetch: FetchHandler }).fetch = handler;
}

function proofResponse(operationHash: string, created = new Date().toISOString()): Response {
  return new Response(
    JSON.stringify({
      page: 1,
      perPage: 2,
      totalItems: 1,
      totalPages: 1,
      items: [
        {
          clinic_id: CLINIC_ID,
          operation_hash: operationHash,
          created: created.replace("T", " ").replace("Z", "Z"),
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function registrationBody(action: "register" | "recover", challenge = "c".repeat(64)) {
  const config = validateConfig({ ...baseConfig(), enabled: false });
  if (!config.ok) throw new Error("fixture");
  return {
    action,
    handle: HANDLE,
    clinicId: CLINIC_ID,
    serverUrl: SERVER_URL,
    challenge,
    adminKey: ADMIN_KEY,
    inboxKey: INBOX_KEY,
    initialConfig: action === "register" ? config.value : null,
  };
}

async function operationHashFor(action: "register" | "recover", challenge?: string): Promise<string> {
  const parsed = await parseOperation(registrationBody(action, challenge), action);
  return parsed.operationHash;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://book.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetDatabase();
});

describe("canonical origin policy", () => {
  it("accepts only a bare public https origin", () => {
    expect(canonicalOrigin("https://PB.Hospital-Clinic.dev")).toBe("https://pb.hospital-clinic.dev");
    expect(canonicalOrigin("https://pb.hospital-clinic.dev:443/")).toBe("https://pb.hospital-clinic.dev");
    expect(canonicalOrigin("http://pb.hospital-clinic.dev")).toBeNull();
    expect(canonicalOrigin("https://user:pass@pb.hospital-clinic.dev")).toBeNull();
    expect(canonicalOrigin("https://pb.hospital-clinic.dev/pb")).toBeNull();
    expect(canonicalOrigin("https://pb.hospital-clinic.dev?x=1")).toBeNull();
    expect(canonicalOrigin("https://127.0.0.1")).toBeNull();
    expect(canonicalOrigin("https://[::1]")).toBeNull();
    expect(canonicalOrigin("https://localhost")).toBeNull();
    expect(canonicalOrigin("https://pb.local")).toBeNull();
    expect(canonicalOrigin("https://pb.hospital-clinic.dev:8443")).toBeNull();
  });

  it("validates handles and suggests alternatives", () => {
    expect(isHandle("jimclinic")).toBe(true);
    expect(isHandle("jim-clinic-2")).toBe(true);
    expect(isHandle("JimClinic")).toBe(false);
    expect(isHandle("-jim")).toBe(false);
    expect(isHandle("api")).toBe(false);
    expect(isHandle("ab")).toBe(false);
    expect(handleSuggestions("jimclinic")).toEqual(["jimclinic-1", "jimclinic-2", "jimclinic-3"]);
  });
});

describe("registration", () => {
  it("claims a handle after verifying an operation-bound proof", async () => {
    const hash = await operationHashFor("register");
    stubFetch(async (input) => {
      const url = input.toString();
      expect(url).toContain(`/api/collections/booking_verification/records?c=${"c".repeat(64)}`);
      expect(url).toContain("page=1");
      expect(url).toContain("perPage=2");
      return proofResponse(hash);
    });

    const response = await post("/v1/register", registrationBody("register"));
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { clinicId: string; publicUrl: string; keyRevision: number };
    expect(payload.clinicId).toBe(CLINIC_ID);
    expect(payload.publicUrl).toBe(`https://book.test/${HANDLE}`);
    expect(payload.keyRevision).toBe(1);

    const clinic = await env.DB.prepare("SELECT * FROM clinics WHERE clinic_id = ?")
      .bind(CLINIC_ID)
      .first<{ enabled: number; status: string; key_revision: number; admin_key_hash: string }>();
    expect(clinic?.enabled).toBe(0);
    expect(clinic?.status).toBe("live");
    expect(clinic?.key_revision).toBe(1);
    expect(clinic?.admin_key_hash).toBe(await sha256Hex(ADMIN_KEY));
  });

  it("enforces the clinic ceiling when two claims compete for the final place", async () => {
    await env.DB.prepare(`
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
      INSERT INTO clinics (clinic_id, handle, status, server_url, admin_key_hash, inbox_key_hash,
        profile, time_zone, dial_code, hours, created_at)
      SELECT printf('%032x', x), 'filled-' || x, 'live', 'https://filled-' || x || '.example',
        'admin-' || x, 'inbox-' || x, '{}', 'UTC', '+1', '{}', 0 FROM n
    `).bind(MAX_CLINICS - 1).run();
    const first = registrationBody("register");
    const second = { ...registrationBody("register", "d".repeat(64)),
      clinicId: "f".repeat(32), handle: "otherclinic", serverUrl: "https://other.hospital-clinic.dev",
      adminKey: "C".repeat(43), inboxKey: "D".repeat(43) };
    let arrivals = 0;
    let release!: () => void;
    const bothProofs = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async (input) => {
      const body = input.toString().startsWith(second.serverUrl) ? second : first;
      const hash = (await parseOperation(body, "register")).operationHash;
      if (++arrivals === 2) release();
      await bothProofs;
      const payload = await proofResponse(hash).json() as { items: Array<{ clinic_id: string }> };
      payload.items[0]!.clinic_id = body.clinicId;
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    });
    const claims = await Promise.all([post("/v1/register", first), post("/v1/register", second)]);
    expect(claims.map((result) => result.status).sort()).toEqual([201, 503]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM clinics").first<{ count: number }>();
    expect(count?.count).toBe(MAX_CLINICS);
    const markers = await env.DB.prepare("SELECT COUNT(*) AS count FROM challenges").first<{ count: number }>();
    expect(markers?.count).toBe(1);
  });

  it("resumes an identical retry without duplicating the clinic", async () => {
    const hash = await operationHashFor("register");
    stubFetch(async () => proofResponse(hash));
    const body = registrationBody("register");
    expect((await post("/v1/register", body)).status).toBe(201);
    // The proof record is deleted after publication; a retry must not refetch.
    stubFetch(async () => {
      throw new Error("must not fetch again");
    });
    const retry = await post("/v1/register", body);
    expect(retry.status).toBe(200);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM clinics").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("resumes recovery with the authoritative revision even after the marker expires", async () => {
    const body = registrationBody("register");
    stubFetch(async () => proofResponse((await parseOperation(body, "register")).operationHash));
    expect((await post("/v1/register", body)).status).toBe(201);
    const recovery = { ...registrationBody("recover", "d".repeat(64)),
      adminKey: "C".repeat(43), inboxKey: "D".repeat(43) };
    stubFetch(async () => proofResponse((await parseOperation(recovery, "recover")).operationHash));
    const recovered = await post("/v1/recover", recovery);
    expect(await recovered.json()).toMatchObject({ keyRevision: 2 });
    await env.DB.prepare("DELETE FROM challenges").run();
    stubFetch(async () => { throw new Error("completed recovery must not fetch"); });
    const retried = await post("/v1/recover", recovery);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ keyRevision: 2 });
    const row = await env.DB.prepare("SELECT key_revision FROM clinics WHERE clinic_id = ?")
      .bind(CLINIC_ID).first<{ key_revision: number }>();
    expect(row?.key_revision).toBe(2);
  });

  it("rejects a proof bound to a different handle", async () => {
    const hash = await operationHashFor("register");
    stubFetch(async () => proofResponse(hash));
    const body = { ...registrationBody("register"), handle: "otherclinic" };
    const response = await post("/v1/register", body);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("proof_mismatch");
  });

  it("rejects stale proofs and non-JSON origins", async () => {
    const hash = await operationHashFor("register");
    stubFetch(async () => proofResponse(hash, new Date(Date.now() - 11 * 60 * 1000).toISOString()));
    expect((await post("/v1/register", registrationBody("register"))).status).toBe(409);

    stubFetch(async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const second = await post("/v1/register", registrationBody("register", "d".repeat(64)));
    expect(second.status).toBe(502);
  });

  it("names the field it rejected instead of a blanket invalid_fields", async () => {
    const body = registrationBody("register");
    const base = body.initialConfig!;
    body.initialConfig = {
      ...base,
      profile: { ...base.profile, phone: "0551234567" },
    };
    const response = await post("/v1/register", body);
    expect(response.status).toBe(422);
    const payload = (await response.json()) as {
      error: { code: string; fields: Record<string, string> };
    };
    expect(payload.error.code).toBe("invalid_fields");
    expect(payload.error.fields["profile.phone"]).toBe("invalid");
  });

  it("accepts a claim without an accent colour", async () => {
    const body = registrationBody("register");
    const base = body.initialConfig!;
    body.initialConfig = {
      ...base,
      profile: { ...base.profile, accentColor: "" },
    };
    // The proof binds the submitted configuration, so hash the modified body.
    const hash = (await parseOperation(body, "register")).operationHash;
    stubFetch(async () => proofResponse(hash));
    const response = await post("/v1/register", body);
    expect(response.status).toBe(201);
  });

  it("bounds proof-body reading with the same timeout as the headers", async () => {
    stubFetch(async (_input, init) => {
      const signal = init!.signal!;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      // If the deadline is cleared after headers, this body never completes.
      return new Response(body, { headers: { "content-type": "application/json" } });
    });
    await expect(fetchProof(SERVER_URL, "c".repeat(64))).rejects.toMatchObject({ code: "proof_unavailable" });
  }, 7000);

  it("does not let a delayed recovery overwrite a newer recovery", async () => {
    const registration = registrationBody("register");
    stubFetch(async () => proofResponse((await parseOperation(registration, "register")).operationHash));
    expect((await post("/v1/register", registration)).status).toBe(201);
    const slow = { ...registrationBody("recover", "d".repeat(64)), adminKey: "D".repeat(43), inboxKey: "E".repeat(43) };
    const fast = { ...registrationBody("recover", "e".repeat(64)), adminKey: "F".repeat(43), inboxKey: "G".repeat(43) };
    const slowHash = (await parseOperation(slow, "recover")).operationHash;
    const fastHash = (await parseOperation(fast, "recover")).operationHash;
    let started!: () => void;
    const fetched = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async (input) => {
      if (String(input).includes(slow.challenge)) {
        started();
        await barrier;
        return proofResponse(slowHash);
      }
      return proofResponse(fastHash);
    });
    const delayed = post("/v1/recover", slow);
    await fetched;
    const winner = await post("/v1/recover", fast);
    release();
    expect(winner.status).toBe(200);
    expect((await delayed).status).toBe(409);
    const row = await env.DB.prepare("SELECT admin_key_hash, key_revision FROM clinics WHERE clinic_id = ?")
      .bind(CLINIC_ID).first<{ admin_key_hash: string; key_revision: number }>();
    expect(row).toMatchObject({ admin_key_hash: await sha256Hex(fast.adminKey), key_revision: 2 });
    expect(await env.DB.prepare("SELECT challenge FROM challenges WHERE challenge = ?").bind(slow.challenge).first()).toBeNull();
  });

  it("classifies a raced claim of the same server rather than returning 500", async () => {
    const first = registrationBody("register");
    const second = {
      ...registrationBody("register", "d".repeat(64)), handle: "other-clinic",
      clinicId: "fedcba9876543210fedcba9876543210", adminKey: "D".repeat(43), inboxKey: "E".repeat(43),
    };
    const hashes = await Promise.all([parseOperation(first, "register"), parseOperation(second, "register")]);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    stubFetch(async (input) => {
      if (++arrived === 2) release();
      await barrier;
      const isFirst = String(input).includes(first.challenge);
      const response = proofResponse(hashes[isFirst ? 0 : 1]!.operationHash);
      const payload = await response.json() as { items: Array<{ clinic_id: string }> };
      payload.items[0]!.clinic_id = isFirst ? first.clinicId : second.clinicId;
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    });
    const results = await Promise.all([post("/v1/register", first), post("/v1/register", second)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const loser = results.find((result) => result.status === 409)!;
    expect(await loser.json()).toMatchObject({ error: { code: "server_taken" } });
  });

  it("refuses an unapproved web origin", async () => {
    const response = await SELF.fetch("https://book.test/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify(registrationBody("register")),
    });
    expect(response.status).toBe(403);
  });

  it("keeps enrollment closed while public-only egress is unverified", async () => {
    const original = env.PROOF_EGRESS;
    (env as unknown as { PROOF_EGRESS?: string }).PROOF_EGRESS = "disabled";
    try {
      const response = await post("/v1/register", registrationBody("register"));
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("enrollment_disabled");
    } finally {
      (env as unknown as { PROOF_EGRESS?: string }).PROOF_EGRESS = original;
    }
  });
});

describe("key scopes", () => {
  it("separates inbox and admin capabilities", async () => {
    const hash = await operationHashFor("register");
    stubFetch(async () => proofResponse(hash));
    await post("/v1/register", registrationBody("register"));

    const inboxConfig = await post("/v1/clinic/config/read", {}, authHeaders(INBOX_KEY));
    expect(inboxConfig.status).toBe(403);

    const adminConfig = await post("/v1/clinic/config/read", {}, authHeaders(ADMIN_KEY));
    expect(adminConfig.status).toBe(200);

    const inboxDiagnostics = await post("/v1/clinic/diagnostics", {}, authHeaders(INBOX_KEY));
    expect(inboxDiagnostics.status).toBe(200);

    const wrong = await post("/v1/clinic/diagnostics", {}, authHeaders("C".repeat(43)));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });

  it("rotates both keys atomically and rejects stale revisions", async () => {
    const hash = await operationHashFor("register");
    stubFetch(async () => proofResponse(hash));
    await post("/v1/register", registrationBody("register"));

    const newAdmin = "D".repeat(43);
    const newInbox = "E".repeat(43);
    const rotate = (body: unknown, key = ADMIN_KEY) =>
      post("/v1/clinic/rotate", body, authHeaders(key));

    expect((await rotate({ expectedKeyRevision: 2, adminKey: newAdmin, inboxKey: newInbox })).status).toBe(409);
    const rotated = await rotate({ expectedKeyRevision: 1, adminKey: newAdmin, inboxKey: newInbox });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { keyRevision: number }).keyRevision).toBe(2);

    // Old keys stop authorizing immediately.
    expect((await post("/v1/clinic/diagnostics", {}, authHeaders(ADMIN_KEY))).status).toBe(401);
    // Identical retry using the new admin key returns success without another increment.
    const retry = await rotate({ expectedKeyRevision: 1, adminKey: newAdmin, inboxKey: newInbox }, newAdmin);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { keyRevision: number }).keyRevision).toBe(2);
    // PocketBase may already have published revision 2 before the final admin save failed.
    const publishedRetry = await rotate({ expectedKeyRevision: 2, adminKey: newAdmin, inboxKey: newInbox }, newAdmin);
    expect(publishedRetry.status).toBe(200);
    expect(await publishedRetry.json()).toMatchObject({ keyRevision: 2 });
  });
});
