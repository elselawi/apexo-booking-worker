import { canonicalJson, type CanonicalValue } from "./canonical";
import { validateConfig, type ClinicConfig } from "./config";
import { generateKey, isKey, keyHash, operationHash, randomHex } from "./crypto";
import { clinicByHandle, clinicById, type ClinicRow } from "./db";
import { errorJson, json } from "./http";
import { isPublicEgressConfigured, canonicalOrigin } from "./origin";
import {
  bucketId,
  consumeRates,
  hourReset,
  hourWindow,
  minuteWindow,
} from "./rate";
import { isPlainObject, onlyKeys } from "./text";
import { CONSENT_VERSION, type Env } from "./env";

export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_HANDLES = [
  "api",
  "v1",
  "health",
  "assets",
  "static",
  "admin",
  "privacy",
  "terms",
  "report",
  "book",
  "www",
];
export const MAX_CLINICS = 1000;
export const PROOF_TTL_MS = 24 * 60 * 60 * 1000;
export const PROOF_VALID_MS = 10 * 60 * 1000;
export const PROOF_MAX_FUTURE_MS = 60 * 1000;
export const PROOF_BODY_LIMIT = 32 * 1024;
const PROOF_TIMEOUT_MS = 5000;

export function isHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 63 &&
    HANDLE_PATTERN.test(value) &&
    !RESERVED_HANDLES.includes(value)
  );
}

export function handleSuggestions(desired: string): string[] {
  const base = desired.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "clinic";
  return [`${base}-1`, `${base}-2`, `${base}-3`].map((candidate) =>
    candidate.length >= 3 ? candidate : `clinic-${candidate}`,
  );
}

interface OperationFields {
  action: "register" | "recover";
  handle: string;
  clinicId: string;
  serverUrl: string;
  challenge: string;
  adminKey: string;
  inboxKey: string;
  initialConfig: ClinicConfig | null;
}

const OPERATION_KEYS = [
  "action",
  "handle",
  "clinicId",
  "serverUrl",
  "challenge",
  "adminKey",
  "inboxKey",
  "initialConfig",
];

export class ProofError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly fields?: Record<string, string>,
  ) {
    super(code);
  }
}

/** Verifies the operation envelope and normalizes the bound fields. */
export async function parseOperation(
  body: unknown,
  action: "register" | "recover",
): Promise<{
  fields: OperationFields;
  adminKeyHash: string;
  inboxKeyHash: string;
  operationHash: string;
}> {
  if (!isPlainObject(body) || !onlyKeys(body, OPERATION_KEYS)) {
    throw new ProofError("bad_request");
  }
  if (body["action"] !== action) throw new ProofError("bad_request");
  const handleRaw = body["handle"];
  const handle = typeof handleRaw === "string" ? handleRaw.trim().toLowerCase() : "";
  if (!isHandle(handle)) throw new ProofError("bad_request");
  const clinicId = body["clinicId"];
  if (typeof clinicId !== "string" || !/^[0-9a-f]{32}$/.test(clinicId)) {
    throw new ProofError("bad_request");
  }
  const serverUrl = canonicalOrigin(body["serverUrl"]);
  if (serverUrl === null) throw new ProofError("bad_request");
  const challenge = body["challenge"];
  if (typeof challenge !== "string" || !/^[0-9a-f]{64}$/.test(challenge)) {
    throw new ProofError("bad_request");
  }
  const adminKey = body["adminKey"];
  const inboxKey = body["inboxKey"];
  if (!isKey(adminKey) || !isKey(inboxKey) || adminKey === inboxKey) {
    throw new ProofError("bad_request");
  }

  let initialConfig: ClinicConfig | null = null;
  if (action === "register") {
    const validated = validateConfig(body["initialConfig"]);
    if (!validated.ok) {
      // Name the offending field so the app can mark the control instead of
      // showing a blanket "check the fields".
      throw new ProofError("invalid_fields", 422, { [validated.field]: "invalid" });
    }
    // The proof binds the *normalized* submitted configuration exactly as the
    // client serialized it.
    initialConfig = validated.value;
  } else if (body["initialConfig"] !== null && body["initialConfig"] !== undefined) {
    throw new ProofError("bad_request");
  }

  const adminKeyHash = await keyHash(adminKey);
  const inboxKeyHash = await keyHash(inboxKey);
  const bound: CanonicalValue = {
    version: 1,
    action,
    handle,
    clinicId,
    serverUrl,
    challenge,
    adminKeyHash,
    inboxKeyHash,
    initialConfig: initialConfig === null ? null : (JSON.parse(JSON.stringify(initialConfig)) as CanonicalValue),
  };
  const hash = await operationHash(bound);
  return {
    fields: { action, handle, clinicId, serverUrl, challenge, adminKey, inboxKey, initialConfig },
    adminKeyHash,
    inboxKeyHash,
    operationHash: hash,
  };
}

function parseProofTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : null;
}

async function readProofBody(response: Response): Promise<unknown> {
  const stream = response.body;
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > PROOF_BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw new ProofError("proof_unavailable", 502);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged));
  } catch {
    throw new ProofError("proof_unavailable", 502);
  }
}

/**
 * One bounded proof fetch against the claimed origin.
 *
 * The URL is built from the canonical origin and a fixed path. No redirects,
 * cookies or authorization are forwarded, and the body is streamed into a
 * ceiling rather than buffered blindly.
 */
export async function fetchProof(
  serverUrl: string,
  challenge: string,
): Promise<{ clinicId: string; operationHash: string; created: number }> {
  const endpoint = new URL("/api/collections/booking_verification/records", serverUrl);
  endpoint.searchParams.set("c", challenge);
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("perPage", "2");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROOF_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status !== 200) throw new ProofError("proof_missing", 502);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new ProofError("proof_unavailable", 502);
    }
    const payload = await readProofBody(response);
    if (!isPlainObject(payload)) throw new ProofError("proof_unavailable", 502);
    if (payload["totalItems"] !== 1) throw new ProofError("proof_missing", 409);
    const items = payload["items"];
    if (!Array.isArray(items) || items.length !== 1) throw new ProofError("proof_missing", 409);
    const record = items[0];
    if (!isPlainObject(record)) throw new ProofError("proof_unavailable", 502);
    const clinicId = record["clinic_id"];
    const operationHashValue = record["operation_hash"];
    const created = parseProofTimestamp(record["created"]);
    if (typeof clinicId !== "string" || typeof operationHashValue !== "string" || created === null) {
      throw new ProofError("proof_unavailable", 502);
    }
    return { clinicId, operationHash: operationHashValue, created };
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError("proof_unavailable", 502);
  } finally {
    clearTimeout(timer);
  }
}

async function assertProofMatches(
  proof: { clinicId: string; operationHash: string; created: number },
  expected: { clinicId: string; operationHash: string },
  nowMs: number,
): Promise<void> {
  if (proof.clinicId !== expected.clinicId) throw new ProofError("proof_mismatch", 409);
  if (proof.operationHash !== expected.operationHash) throw new ProofError("proof_mismatch", 409);
  if (proof.created < nowMs - PROOF_VALID_MS) throw new ProofError("proof_expired", 409);
  if (proof.created > nowMs + PROOF_MAX_FUTURE_MS) throw new ProofError("proof_expired", 409);
}

export interface RegistrationResult {
  clinicId: string;
  publicUrl: string;
  keyRevision: number;
}

function registrationResult(env: Env, clinic: ClinicRow): RegistrationResult {
  return {
    clinicId: clinic.clinic_id,
    publicUrl: publicUrl(env, clinic.handle),
    keyRevision: clinic.key_revision,
  };
}

export function publicUrl(env: Env, handle: string): string {
  return `${env.PUBLIC_ORIGIN.replace(/\/+$/, "")}/${encodeURIComponent(handle)}`;
}

async function rateLimitRegistration(env: Env, address: string, now: number): Promise<Response | null> {
  const addressBucket = await bucketId(env, "register-address", address);
  const allowed = await consumeRates(
    env.DB,
    [
      {
        bucket: `reg:${addressBucket}:${hourWindow(now)}`,
        ceiling: 5,
        reset: hourReset(now),
      },
      {
        bucket: `reg-global:${hourWindow(now)}`,
        ceiling: 100,
        reset: hourReset(now),
      },
    ],
    now,
  );
  if (allowed) return null;
  return errorJson(429, "rate_limited", undefined, {
    "retry-after": String(Math.ceil((hourReset(now) - now) / 1000)),
  });
}

async function clinicCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM clinics").first<{ count: number }>();
  return row?.count ?? 0;
}

export interface RegisterRequest {
  env: Env;
  body: unknown;
  address: string;
  now: number;
  action: "register" | "recover";
}

export async function handleRegistration(request: RegisterRequest): Promise<Response> {
  const { env, body, address, now, action } = request;

  const limited = await rateLimitRegistration(env, address, now);
  if (limited) return limited;

  if (!isPublicEgressConfigured(env.PROOF_EGRESS)) {
    // Enrollment is deliberately closed until connection-time public-only
    // egress is verified. Never fall back to an unrestricted fetch.
    return errorJson(503, "enrollment_disabled");
  }

  const handleGuess =
    isPlainObject(body) && typeof body["handle"] === "string"
      ? body["handle"].trim().toLowerCase()
      : "";
  const existing = isOperationLike(body) ? await clinicByHandle(env.DB, handleGuess) : null;

  let parsed: Awaited<ReturnType<typeof parseOperation>>;
  try {
    parsed = await parseOperation(body, action);
  } catch (error) {
    if (error instanceof ProofError) return errorJson(error.status, error.code, error.fields);
    throw error;
  }
  const { fields, adminKeyHash, inboxKeyHash, operationHash: hash } = parsed;

  // Publication to PocketBase can fail after the Worker commits. A retry with
  // the already-current pair is read-only, even after the proof marker expires.
  if (existing && existing.clinic_id === fields.clinicId &&
      existing.server_url === fields.serverUrl &&
      existing.admin_key_hash === adminKeyHash && existing.inbox_key_hash === inboxKeyHash) {
    return json(registrationResult(env, existing));
  }

  // 1. Completed retry: the consumed proof marker still exists and the current
  //    key hashes must still match. Never restore superseded credentials.
  const marker = await env.DB.prepare("SELECT * FROM challenges WHERE challenge = ?")
    .bind(fields.challenge)
    .first<{ challenge: string; clinic_id: string; operation_hash: string; used_at: number }>();
  if (marker) {
    if (marker.operation_hash === hash && marker.clinic_id === fields.clinicId) {
      const clinic = await clinicById(env.DB, fields.clinicId);
      if (clinic && clinic.admin_key_hash === adminKeyHash && clinic.inbox_key_hash === inboxKeyHash) {
        return json(registrationResult(env, clinic));
      }
    }
    return errorJson(409, "operation_conflict");
  }

  if (action === "register") {
    if (existing) {
      if (existing.handle === fields.handle) {
        return errorJson(409, "handle_taken", undefined, {
          "x-suggested-handles": handleSuggestions(fields.handle).join(","),
        });
      }
      return errorJson(409, "handle_taken");
    }
    const byServer = await env.DB.prepare("SELECT clinic_id FROM clinics WHERE server_url = ?")
      .bind(fields.serverUrl)
      .first<{ clinic_id: string }>();
    if (byServer) return errorJson(409, "server_taken");
  } else {
    if (!existing) return errorJson(404, "unknown_clinic");
    if (existing.clinic_id !== fields.clinicId) return errorJson(403, "forbidden");
    if (existing.server_url !== fields.serverUrl) return errorJson(403, "forbidden");
    if (existing.handle !== fields.handle) return errorJson(403, "forbidden");
  }

  if (!fields.initialConfig && action === "register") return errorJson(422, "invalid_fields");

  // 2. Fresh proof fetch.
  try {
    const proof = await fetchProof(fields.serverUrl, fields.challenge);
    await assertProofMatches(proof, { clinicId: fields.clinicId, operationHash: hash }, now);
  } catch (error) {
    if (error instanceof ProofError) return errorJson(error.status, error.code, error.fields);
    throw error;
  }

  if (action === "register") {
    if ((await clinicCount(env)) >= MAX_CLINICS) return errorJson(503, "unavailable");
    const config = fields.initialConfig!;
    if (config.enabled) return errorJson(422, "invalid_fields", { enabled: "invalid" });
    const stored = config;
    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO clinics (
             clinic_id, handle, status, enabled, server_url, admin_key_hash, inbox_key_hash,
             key_revision, inbox_revision, profile, time_zone, dial_code, hours, closed_dates,
             contact_email, config_rev, created_at, consent_version
           ) SELECT ?, ?, 'live', 0, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?
             WHERE (SELECT COUNT(*) FROM clinics) < ?`,
        ).bind(
          fields.clinicId,
          fields.handle,
          fields.serverUrl,
          adminKeyHash,
          inboxKeyHash,
          JSON.stringify(stored.profile),
          stored.timeZone,
          stored.dialCode,
          JSON.stringify(stored.hours),
          JSON.stringify(stored.closedDates),
          stored.contactEmail,
          now,
          CONSENT_VERSION,
          MAX_CLINICS,
        ),
        env.DB.prepare(
          `INSERT INTO challenges (challenge, clinic_id, operation_hash, used_at, expires_at)
           SELECT ?, ?, ?, ?, ? WHERE changes() > 0`,
        ).bind(fields.challenge, fields.clinicId, hash, now, now + PROOF_TTL_MS),
      ]);
      if (results[0]!.meta.changes === 0) return errorJson(503, "unavailable");
    } catch (error) {
      const raced = await resolveInsertConflict(env, fields, adminKeyHash, inboxKeyHash, hash);
      if (raced) return raced;
      throw error;
    }
    return json({ clinicId: fields.clinicId, publicUrl: publicUrl(env, fields.handle), keyRevision: 1 }, 201);
  }

  // A proof fetched against an older key revision must not overwrite a newer
  // recovery/rotation. Consume the challenge only when the CAS succeeds.
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE clinics SET admin_key_hash = ?, inbox_key_hash = ?, key_revision = key_revision + 1
         WHERE clinic_id = ? AND key_revision = ?`,
      ).bind(adminKeyHash, inboxKeyHash, fields.clinicId, existing!.key_revision),
      env.DB.prepare(
        `INSERT INTO challenges (challenge, clinic_id, operation_hash, used_at, expires_at)
         SELECT ?, ?, ?, ?, ? WHERE changes() > 0`,
      ).bind(fields.challenge, fields.clinicId, hash, now, now + PROOF_TTL_MS),
    ]);
    if (results[0]!.meta.changes === 0) {
      const raced = await resolveInsertConflict(env, fields, adminKeyHash, inboxKeyHash, hash);
      return raced ?? errorJson(409, "operation_conflict");
    }
  } catch (error) {
    const raced = await resolveInsertConflict(env, fields, adminKeyHash, inboxKeyHash, hash);
    if (raced) return raced;
    throw error;
  }
  return json({ clinicId: fields.clinicId, publicUrl: publicUrl(env, fields.handle), keyRevision: existing!.key_revision + 1 });
}

function isOperationLike(body: unknown): boolean {
  return isPlainObject(body) && typeof body["handle"] === "string";
}

/**
 * After a raced insert, the committed row decides the outcome: a matching
 * receipt wins, anything else is a conflict. Never a 500.
 */
async function resolveInsertConflict(
  env: Env,
  fields: OperationFields,
  adminKeyHash: string,
  inboxKeyHash: string,
  hash: string,
): Promise<Response | null> {
  const marker = await env.DB.prepare("SELECT * FROM challenges WHERE challenge = ?")
    .bind(fields.challenge)
    .first<{ clinic_id: string; operation_hash: string }>();
  if (marker && marker.operation_hash === hash && marker.clinic_id === fields.clinicId) {
    const clinic = await clinicById(env.DB, fields.clinicId);
    if (clinic && clinic.admin_key_hash === adminKeyHash && clinic.inbox_key_hash === inboxKeyHash) {
      return json(registrationResult(env, clinic));
    }
  }
  if (marker || fields.action === "recover") return errorJson(409, "operation_conflict");
  const existing = await clinicByHandle(env.DB, fields.handle);
  if (existing) return errorJson(409, "handle_taken");
  const byServer = await env.DB.prepare("SELECT clinic_id FROM clinics WHERE server_url = ?")
    .bind(fields.serverUrl).first();
  if (byServer) return errorJson(409, "server_taken");
  if (await clinicById(env.DB, fields.clinicId)) return errorJson(409, "operation_conflict");
  return null;
}

export async function rotateKeys(
  env: Env,
  clinic: ClinicRow,
  body: unknown,
): Promise<Response> {
  if (!isPlainObject(body) || !onlyKeys(body, ["expectedKeyRevision", "adminKey", "inboxKey"])) {
    return errorJson(400, "bad_request");
  }
  const expected = body["expectedKeyRevision"];
  const adminKey = body["adminKey"];
  const inboxKey = body["inboxKey"];
  if (
    typeof expected !== "number" ||
    !Number.isInteger(expected) ||
    expected < 1 ||
    !isKey(adminKey) ||
    !isKey(inboxKey) ||
    adminKey === inboxKey
  ) {
    return errorJson(400, "bad_request");
  }
  const adminKeyHash = await keyHash(adminKey);
  const inboxKeyHash = await keyHash(inboxKey);
  if ((clinic.key_revision === expected || clinic.key_revision === expected + 1) &&
      clinic.admin_key_hash === adminKeyHash && clinic.inbox_key_hash === inboxKeyHash) {
    return json({ ok: true, keyRevision: clinic.key_revision });
  }
  if (clinic.key_revision === expected) {
    const result = await env.DB.prepare(
      `UPDATE clinics SET admin_key_hash = ?, inbox_key_hash = ?, key_revision = key_revision + 1
       WHERE clinic_id = ? AND key_revision = ?`,
    )
      .bind(adminKeyHash, inboxKeyHash, clinic.clinic_id, expected)
      .run();
    if (result.meta.changes === 0) {
      const latest = await clinicById(env.DB, clinic.clinic_id);
      if (
        latest &&
        latest.key_revision === expected + 1 &&
        latest.admin_key_hash === adminKeyHash &&
        latest.inbox_key_hash === inboxKeyHash
      ) {
        return json({ ok: true, keyRevision: latest.key_revision });
      }
      return errorJson(409, "key_conflict");
    }
    return json({ ok: true, keyRevision: expected + 1 });
  }
  // Identical retry of an already-applied rotation returns success; anything
  // else is stale.
  if (
    clinic.key_revision === expected + 1 &&
    clinic.admin_key_hash === adminKeyHash &&
    clinic.inbox_key_hash === inboxKeyHash
  ) {
    return json({ ok: true, keyRevision: clinic.key_revision });
  }
  return errorJson(409, "key_conflict");
}

export function openClinicId(): string {
  return randomHex(16);
}

export function freshKeys(): { adminKey: string; inboxKey: string } {
  return { adminKey: generateKey(), inboxKey: generateKey() };
}

export function canonicalOperation(input: CanonicalValue): string {
  return canonicalJson(input);
}

/** Bucket helper kept here so tests can assert domain separation. */
export async function registerBucket(env: Env, address: string, now: number): Promise<string> {
  return `reg:${await bucketId(env, "register-address", address)}:${minuteWindow(now)}`;
}
