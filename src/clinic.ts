import { validateConfig, type ClinicConfig } from "./config";
import {
  clinicByKeyHash,
  configFromRow,
  isAdminKey,
  type ClinicRow,
} from "./db";
import { keyHash } from "./crypto";
import { errorJson, json, bearerKey, clientAddress } from "./http";
import { bucketId, consumeRate, minuteReset, minuteWindow } from "./rate";
import { publicUrl, rotateKeys } from "./register";
import type { Env } from "./env";
import { isPlainObject } from "./text";

export interface Session {
  clinic: ClinicRow;
  isAdmin: boolean;
}

/** Resolves the clinic from the key; never from a caller-supplied tenant id. */
export async function authenticate(env: Env, request: Request): Promise<Session | Response> {
  const key = bearerKey(request);
  if (!key) return errorJson(401, "unauthorized");
  const hash = await keyHash(key);
  const clinic = await clinicByKeyHash(env.DB, hash);
  if (!clinic) return errorJson(401, "unauthorized");
  const isAdmin = isAdminKey(clinic, hash);
  const bucket = `auth:${await bucketId(env, "clinic", clinic.clinic_id)}:${minuteWindow(Date.now())}`;
  const allowed = await consumeRate(
    env.DB,
    { bucket, ceiling: 120, reset: minuteReset(Date.now()) },
    Date.now(),
  );
  if (!allowed) {
    return errorJson(429, "rate_limited", undefined, {
      "retry-after": String(Math.max(1, Math.ceil((minuteReset(Date.now()) - Date.now()) / 1000))),
    });
  }
  return { clinic, isAdmin };
}

export async function throttleInvalidKeys(env: Env, request: Request): Promise<void> {
  const address = clientAddress(request);
  const now = Date.now();
  const bucket = `invalid-key:${await bucketId(env, "address", address)}:${minuteWindow(now)}`;
  await consumeRate(env.DB, { bucket, ceiling: 60, reset: minuteReset(now) }, now);
}

export function requireAdmin(session: Session): Response | null {
  return session.isAdmin ? null : errorJson(403, "forbidden");
}

export function publicConfig(row: ClinicRow): Record<string, unknown> {
  const config = configFromRow(row);
  return {
    clinicId: row.clinic_id,
    handle: row.handle,
    enabled: row.enabled === 1,
    profile: config.profile,
    timeZone: config.timeZone,
    dialCode: config.dialCode,
    hours: config.hours,
    closedDates: config.closedDates,
    configRevision: row.config_rev,
    consentVersion: row.consent_version,
  };
}

export async function diagnostics(env: Env, session: Session): Promise<Response> {
  const now = Date.now();
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM requests WHERE clinic_id = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(session.clinic.clinic_id, now)
    .first<{ count: number }>();
  return json({
    handle: session.clinic.handle,
    publicUrl: publicUrl(env, session.clinic.handle),
    status: session.clinic.status,
    enabled: session.clinic.enabled === 1,
    pending: pending?.count ?? 0,
    lastPullAt: session.clinic.last_pull_at,
    configRevision: session.clinic.config_rev,
    keyRevision: session.clinic.key_revision,
  });
}

export function configRead(env: Env, session: Session): Response {
  return json({
    config: configFromRow(session.clinic),
    revision: session.clinic.config_rev,
    handle: session.clinic.handle,
    publicUrl: publicUrl(env, session.clinic.handle),
  });
}

export async function writeConfig(
  env: Env,
  session: Session,
  body: unknown,
): Promise<Response> {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "expectedRevision" && key !== "config")) {
    return errorJson(400, "bad_request");
  }
  const expected = body["expectedRevision"];
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
    return errorJson(400, "bad_request");
  }
  const validated = validateConfig(body["config"]);
  if (!validated.ok) return errorJson(422, "invalid_fields", { [validated.field]: "invalid" });
  const config: ClinicConfig = validated.value;

  const result = await env.DB.prepare(
    `UPDATE clinics SET
       enabled = ?, profile = ?, time_zone = ?, dial_code = ?, hours = ?, closed_dates = ?,
       contact_email = ?, config_rev = config_rev + 1
     WHERE clinic_id = ? AND config_rev = ?`,
  )
    .bind(
      config.enabled ? 1 : 0,
      JSON.stringify(config.profile),
      config.timeZone,
      config.dialCode,
      JSON.stringify(config.hours),
      JSON.stringify(config.closedDates),
      config.contactEmail,
      session.clinic.clinic_id,
      expected,
    )
    .run();
  if (result.meta.changes === 0) return errorJson(409, "config_conflict");
  return json({
    handle: session.clinic.handle,
    publicUrl: publicUrl(env, session.clinic.handle),
    revision: expected + 1,
  });
}

export async function rotate(env: Env, session: Session, body: unknown): Promise<Response> {
  const denied = requireAdmin(session);
  if (denied) return denied;
  return rotateKeys(env, session.clinic, body);
}

/**
 * Leaves the platform: every request the clinic holds, its ownership proofs,
 * and the clinic row itself are erased, so the handle is free again and the
 * public page stops resolving. The caller must spell the handle out.
 */
export async function deleteClinic(
  env: Env,
  session: Session,
  body: unknown,
): Promise<Response> {
  const denied = requireAdmin(session);
  if (denied) return denied;
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "confirmHandle")) {
    return errorJson(400, "bad_request");
  }
  if (body["confirmHandle"] !== session.clinic.handle) {
    return errorJson(422, "invalid_fields", { confirmHandle: "invalid" });
  }
  const clinicId = session.clinic.clinic_id;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM admission_context WHERE request_id IN (SELECT request_id FROM requests WHERE clinic_id = ?)",
    ).bind(clinicId),
    env.DB.prepare("DELETE FROM requests WHERE clinic_id = ?").bind(clinicId),
    env.DB.prepare("DELETE FROM request_counters WHERE clinic_id = ?").bind(clinicId),
    env.DB.prepare("DELETE FROM challenges WHERE clinic_id = ?").bind(clinicId),
    env.DB.prepare("DELETE FROM clinics WHERE clinic_id = ?").bind(clinicId),
  ]);
  return json({ ok: true });
}
