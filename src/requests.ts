import {
  configFromRow,
  requestItem,
  requestReference,
  type ClinicRow,
  type RequestRow,
} from "./db";
import { errorJson, json } from "./http";
import { normalizeEmail, normalizePhone } from "./phone";
import { resolvePreference, validatePreferenceSyntax, type Preference } from "./preference";
import {
  bucketId,
  consumeRate,
  dayReset,
  dayWindow,
  hourReset,
  hourWindow,
  minuteReset,
  minuteWindow,
  signSnapshot,
  verifySnapshot,
} from "./rate";
import { codePointLength, isPlainObject, onlyKeys, trimmedNfc } from "./text";
import { canonicalJson } from "./canonical";
import { sha256Hex } from "./crypto";
import { verifyTurnstile } from "./turnstile";
import { logEvent } from "./log";
import { zoneDate } from "./time";
import {
  PENDING_CAP,
  PENDING_RETENTION_MS,
  TERMINAL_RETENTION_MS,
  type Env,
} from "./env";
import { LANGUAGES, type Language } from "./config";

const SUBMISSION_KEYS = [
  "name",
  "phone",
  "email",
  "note",
  "preference",
  "language",
  "consentVersion",
  "consentAccepted",
  "turnstileToken",
];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ValidSubmission {
  name: string;
  phone: string;
  email: string | null;
  note: string | null;
  preference: Preference;
  language: Language;
  consentVersion: string;
  consentAccepted: true;
  turnstileToken: string;
}

export type SubmissionResult =
  | { ok: true; value: ValidSubmission }
  | { ok: false; fields: Record<string, string> };

export function validateSubmission(raw: unknown, clinic: ClinicRow): SubmissionResult {
  if (!isPlainObject(raw) || !onlyKeys(raw, SUBMISSION_KEYS)) {
    return { ok: false, fields: { body: "invalid" } };
  }
  const fields: Record<string, string> = {};

  const name = typeof raw["name"] === "string" ? trimmedNfc(raw["name"]) : null;
  if (name === null || codePointLength(name) < 1 || codePointLength(name) > 100) {
    fields["name"] = "invalid";
  }

  const phone = typeof raw["phone"] === "string" ? normalizePhone(raw["phone"]) : null;
  if (phone === null) fields["phone"] = "invalid";

  let email: string | null = null;
  if (raw["email"] !== undefined && raw["email"] !== null && raw["email"] !== "") {
    if (typeof raw["email"] !== "string") {
      fields["email"] = "invalid";
    } else {
      email = normalizeEmail(raw["email"]);
      if (email === null) fields["email"] = "invalid";
    }
  }

  let note: string | null = null;
  if (raw["note"] !== undefined && raw["note"] !== null && raw["note"] !== "") {
    if (typeof raw["note"] !== "string") {
      fields["note"] = "invalid";
    } else {
      const normalized = trimmedNfc(raw["note"], true);
      if (normalized === null || codePointLength(normalized) > 500) {
        fields["note"] = "invalid";
      } else {
        note = normalized;
      }
    }
  }

  const preference = validatePreferenceSyntax(raw["preference"]);
  if (!preference.ok) fields["preference"] = "invalid";

  const language = raw["language"];
  if (typeof language !== "string" || !(LANGUAGES as readonly string[]).includes(language)) {
    fields["language"] = "invalid";
  }

  if (raw["consentVersion"] !== clinic.consent_version) fields["consentVersion"] = "invalid";
  if (raw["consentAccepted"] !== true) fields["consentAccepted"] = "invalid";

  const token = raw["turnstileToken"];
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
    fields["turnstileToken"] = "invalid";
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      name: name!,
      phone: phone!,
      email,
      note,
      preference: (preference as { ok: true; value: Preference }).value,
      language: language as Language,
      consentVersion: raw["consentVersion"] as string,
      consentAccepted: true,
      turnstileToken: token as string,
    },
  };
}

export async function submissionFingerprint(submission: ValidSubmission): Promise<string> {
  return sha256Hex(
    canonicalJson({
      name: submission.name,
      phone: submission.phone,
      email: submission.email,
      note: submission.note,
      preference: submission.preference as unknown as never,
      language: submission.language,
      consentVersion: submission.consentVersion,
      consentAccepted: submission.consentAccepted,
    }),
  );
}

export interface SubmitContext {
  env: Env;
  request: Request;
  clinic: ClinicRow;
  body: string;
  address: string;
  now: number;
  /** Short correlation id echoed in the response and every log line. */
  rid: string;
}

export async function submitRequest(context: SubmitContext): Promise<Response> {
  const { env, request, clinic, body, address, now, rid } = context;
  const started = Date.now();
  const idemKey = request.headers.get("idempotency-key") ?? "";
  const fail = (response: Response, code: string, extra: Record<string, unknown> = {}) => {
    logEvent(response.status >= 500 ? "error" : "warn", "submit_failed", {
      rid,
      handle: clinic.handle,
      code,
      status: response.status,
      ms: Date.now() - started,
      ...extra,
    });
    return response;
  };

  const addressBucket = await bucketId(env, "address", address);
  const attemptAllowed = await consumeRate(
    env.DB,
    {
      bucket: `post:${addressBucket}:${minuteWindow(now)}`,
      ceiling: 30,
      reset: minuteReset(now),
    },
    now,
  );
  if (!attemptAllowed) {
    return fail(
      errorJson(429, "rate_limited", undefined, {
        "retry-after": String(Math.max(1, Math.ceil((minuteReset(now) - now) / 1000))),
      }),
      "rate_limited",
    );
  }

  if (!UUID_V4.test(idemKey)) {
    return fail(errorJson(400, "bad_request", { "Idempotency-Key": "invalid" }), "bad_idempotency_key");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail(errorJson(400, "bad_request"), "bad_json");
  }

  const validated = validateSubmission(parsed, clinic);
  if (!validated.ok) {
    return fail(errorJson(422, "invalid_fields", validated.fields), "invalid_fields", {
      fields: Object.keys(validated.fields).join(","),
    });
  }
  const submission = validated.value;

  const fingerprint = await submissionFingerprint(submission);

  const retained = await env.DB.prepare(
    "SELECT * FROM requests WHERE clinic_id = ? AND idem_key = ?",
  )
    .bind(clinic.clinic_id, idemKey)
    .first<RequestRow>();
  if (retained && retained.expires_at > now) {
    if (retained.body_hash === fingerprint) {
      logEvent("info", "submit_replay", {
        rid,
        handle: clinic.handle,
        requestId: retained.request_id,
        ms: Date.now() - started,
      });
      return json(
        {
          ok: true,
          requestId: retained.request_id,
          reference: requestReference(retained.ref_day, retained.ref_seq),
          status: "received",
        },
        200,
      );
    }
    return fail(errorJson(409, "idempotency_conflict"), "idempotency_conflict");
  }

  if (clinic.status !== "live" || clinic.enabled !== 1) {
    return fail(errorJson(409, "clinic_disabled"), "clinic_disabled");
  }

  const config = configFromRow(clinic);
  const resolved = resolvePreference(
    submission.preference,
    config.hours,
    config.closedDates,
    config.timeZone,
    now,
  );
  if (!resolved.ok) {
    return fail(errorJson(422, "invalid_fields", { preference: "invalid" }), "invalid_preference");
  }

  const turnstile = await verifyTurnstile(env, submission.turnstileToken, address);
  if (!turnstile.ok) {
    const diagnostic = {
      turnstile: turnstile.reason ?? "unknown",
      siteverifyStatus: turnstile.status ?? 0,
      codes: (turnstile.codes ?? []).join(",") || "none",
      siteverifyMs: turnstile.elapsedMs ?? 0,
      // Metadata only: a wrong secret is measurable, the secret itself never is.
      secretLength: env.TURNSTILE_SECRET?.trim().length ?? 0,
    };
    if (turnstile.reason === "unavailable") {
      return fail(errorJson(503, "unavailable"), "turnstile_unavailable", diagnostic);
    }
    // A rejected token is something the patient can retry, not a field error.
    return fail(errorJson(422, "verification_failed"), "verification_failed", diagnostic);
  }
  logEvent("info", "turnstile_ok", {
    rid,
    handle: clinic.handle,
    siteverifyMs: turnstile.elapsedMs ?? 0,
  });

  const requestId = crypto.randomUUID().replace(/-/g, "");
  const refDay = zoneDate(now, config.timeZone);

  const quotas = [
    {
      bucket: `req-addr-clinic:${addressBucket}:${clinic.clinic_id}:${hourWindow(now)}`,
      ceiling: 5,
      reset: hourReset(now),
    },
    {
      bucket: `req-addr:${addressBucket}:${hourWindow(now)}`,
      ceiling: 20,
      reset: hourReset(now),
    },
    {
      bucket: `req-clinic:${clinic.clinic_id}:${dayWindow(now)}`,
      ceiling: 100,
      reset: dayReset(now),
    },
    {
      bucket: `req-global:${dayWindow(now)}`,
      ceiling: 10_000,
      reset: dayReset(now),
    },
  ];

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO admission_context (request_id, pending_cap, quotas) VALUES (?, ?, ?)",
      ).bind(requestId, PENDING_CAP, JSON.stringify(quotas)),
      env.DB.prepare(
        "DELETE FROM requests WHERE clinic_id = ? AND idem_key = ? AND expires_at <= ?",
      ).bind(clinic.clinic_id, idemKey, now),
      env.DB.prepare(
        `INSERT INTO request_counters (clinic_id, ref_day, ref_seq) VALUES (?, ?, 1)
         ON CONFLICT (clinic_id, ref_day) DO UPDATE SET ref_seq = ref_seq + 1`,
      ).bind(clinic.clinic_id, refDay),
      env.DB.prepare(
        `INSERT INTO requests (
           request_id, clinic_id, idem_key, body_hash, name, phone, email, note, preference,
           candidate_dates, config_rev, from_date, to_date, window_from, window_to, time_zone,
           language, consent, created_at, expires_at, ref_day, ref_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (
           SELECT ref_seq FROM request_counters WHERE clinic_id = ? AND ref_day = ?
         ))`,
      ).bind(
        requestId,
        clinic.clinic_id,
        idemKey,
        fingerprint,
        submission.name,
        submission.phone,
        submission.email,
        submission.note,
        JSON.stringify(submission.preference),
        JSON.stringify(resolved.value.candidateDates),
        clinic.config_rev,
        resolved.value.fromDate,
        resolved.value.toDate,
        resolved.value.windowFrom,
        resolved.value.windowTo,
        config.timeZone,
        submission.language,
        submission.consentVersion,
        now,
        now + PENDING_RETENTION_MS,
        refDay,
        clinic.clinic_id,
        refDay,
      ),
      env.DB.prepare("DELETE FROM admission_context WHERE request_id = ?").bind(requestId),
    ]);
  } catch (error) {
    const raced = await resolveAdmissionFailure(env, clinic, idemKey, fingerprint, now);
    if (raced) {
      logEvent("info", "submit_replay", {
        rid,
        handle: clinic.handle,
        reason: "admission_race",
        ms: Date.now() - started,
      });
      return raced;
    }
    const classified = classifyAdmissionError(error);
    return fail(classified, "admission_failed", {
      reason: error instanceof Error ? error.message.slice(0, 80) : "unknown",
    });
  }

  const stored = await env.DB.prepare(
    "SELECT ref_day, ref_seq FROM requests WHERE request_id = ?",
  )
    .bind(requestId)
    .first<{ ref_day: string; ref_seq: number }>();
  const reference = requestReference(stored?.ref_day ?? refDay, stored?.ref_seq ?? 1);

  logEvent("info", "submit_admitted", {
    rid,
    handle: clinic.handle,
    requestId,
    reference,
    language: submission.language,
    ms: Date.now() - started,
  });

  return json({ ok: true, requestId, reference, status: "received" }, 201);
}

async function resolveAdmissionFailure(
  env: Env,
  clinic: ClinicRow,
  idemKey: string,
  fingerprint: string,
  now: number,
): Promise<Response | null> {
  const retained = await env.DB.prepare(
    "SELECT * FROM requests WHERE clinic_id = ? AND idem_key = ?",
  )
    .bind(clinic.clinic_id, idemKey)
    .first<RequestRow>();
  if (!retained) return null;
  if (retained.expires_at > now && retained.body_hash === fingerprint) {
    return json({
      ok: true,
      requestId: retained.request_id,
      reference: requestReference(retained.ref_day, retained.ref_seq),
      status: "received",
    }, 200);
  }
  return errorJson(409, "idempotency_conflict");
}

function classifyAdmissionError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  if (message.includes("queue_full")) {
    return errorJson(429, "queue_full", undefined, {
      "retry-after": String(Math.max(1, Math.ceil((hourReset(now) - now) / 1000))),
    });
  }
  if (message.includes("rate_limited")) {
    return errorJson(429, "rate_limited", undefined, {
      "retry-after": String(Math.max(1, Math.ceil((hourReset(now) - now) / 1000))),
    });
  }
  if (message.includes("config_changed")) return errorJson(409, "clinic_disabled");
  return errorJson(503, "unavailable");
}

export interface PullContext {
  env: Env;
  clinic: ClinicRow;
  now: number;
  body: unknown;
}

const PULL_KEYS = ["status", "beforeSeq", "snapshot", "limit"];
const PULL_STATUSES = ["pending", "handled", "declined", "all"];
const SNAPSHOT_TTL_MS = 60_000;

export async function pullRequests(context: PullContext): Promise<Response> {
  const { env, clinic, now, body } = context;
  if (!isPlainObject(body) || !onlyKeys(body, PULL_KEYS)) return errorJson(400, "bad_request");
  const status = body["status"] ?? "pending";
  if (typeof status !== "string" || !PULL_STATUSES.includes(status)) {
    return errorJson(400, "bad_request");
  }
  const limitRaw = body["limit"] ?? 50;
  if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    return errorJson(400, "bad_request");
  }
  const beforeSeq = body["beforeSeq"];
  if (beforeSeq !== null && beforeSeq !== undefined && (typeof beforeSeq !== "number" || !Number.isInteger(beforeSeq))) {
    return errorJson(400, "bad_request");
  }
  const token = body["snapshot"];
  if (token !== null && token !== undefined && typeof token !== "string") {
    return errorJson(400, "bad_request");
  }

  const filter = status;
  let revision: number;
  let snapshotToken: string;
  if (!token || beforeSeq === null || beforeSeq === undefined) {
    const current = await env.DB.prepare("SELECT inbox_revision FROM clinics WHERE clinic_id = ?")
      .bind(clinic.clinic_id)
      .first<{ inbox_revision: number }>();
    revision = current?.inbox_revision ?? 0;
    const earliest = await env.DB.prepare(
      "SELECT MIN(expires_at) AS earliest FROM requests WHERE clinic_id = ? AND expires_at > ?",
    )
      .bind(clinic.clinic_id, now)
      .first<{ earliest: number | null }>();
    const exp = Math.min(now + SNAPSHOT_TTL_MS, earliest?.earliest ?? now + SNAPSHOT_TTL_MS);
    snapshotToken = await signSnapshot(env, {
      clinicId: clinic.clinic_id,
      status: filter,
      revision,
      exp,
      filter,
    });
  } else {
    const payload = await verifySnapshot(
      env,
      token,
      { clinicId: clinic.clinic_id, status: filter, filter },
      now,
    );
    if (!payload) return errorJson(409, "snapshot_changed");
    revision = payload.revision;
    snapshotToken = token;
  }

  const seqBound = typeof beforeSeq === "number" ? beforeSeq : Number.MAX_SAFE_INTEGER;
  const statusClause = status === "all" ? "" : " AND status = ?";
  const statements = [
    env.DB.prepare(
      `SELECT * FROM requests
       WHERE clinic_id = ? AND expires_at > ? AND seq < ?${statusClause}
       ORDER BY seq DESC LIMIT ?`,
    ).bind(
      ...[
        clinic.clinic_id,
        now,
        seqBound,
        ...(status === "all" ? [] : [status]),
        limitRaw,
      ]
    ),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM requests WHERE clinic_id = ? AND status = 'pending' AND expires_at > ?",
    ).bind(clinic.clinic_id, now),
    env.DB.prepare("SELECT inbox_revision FROM clinics WHERE clinic_id = ?").bind(clinic.clinic_id),
  ];

  const batchResults = await env.DB.batch<unknown>(statements);
  const rows = (batchResults[0]?.results ?? []) as RequestRow[];
  const pending =
    ((batchResults[1]?.results ?? []) as Array<{ count: number }>)[0]?.count ?? 0;
  const freshRevision =
    ((batchResults[2]?.results ?? []) as Array<{ inbox_revision: number }>)[0]?.inbox_revision ?? 0;

  if (freshRevision !== revision) return errorJson(409, "snapshot_changed");

  const items = rows.map(requestItem);
  const nextBeforeSeq = rows.length === limitRaw ? rows[rows.length - 1]!.seq : null;

  await env.DB.prepare("UPDATE clinics SET last_pull_at = ? WHERE clinic_id = ?")
    .bind(now, clinic.clinic_id)
    .run();

  return json({
    items,
    nextBeforeSeq,
    snapshot: nextBeforeSeq === null ? null : snapshotToken,
    pending,
  });
}

const STATE_KEYS = ["requestId", "expectedVersion", "state", "linkedId"];

export async function setRequestState(
  env: Env,
  clinic: ClinicRow,
  body: unknown,
  now: number,
): Promise<Response> {
  if (!isPlainObject(body) || !onlyKeys(body, STATE_KEYS)) return errorJson(400, "bad_request");
  const requestId = body["requestId"];
  const expectedVersion = body["expectedVersion"];
  const state = body["state"];
  const linkedId = body["linkedId"] ?? null;
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 64) {
    return errorJson(400, "bad_request");
  }
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return errorJson(400, "bad_request");
  }
  if (state !== "handled" && state !== "declined") return errorJson(400, "bad_request");
  if (state === "handled") {
    if (typeof linkedId !== "string" || linkedId.length < 1 || linkedId.length > 64) {
      return errorJson(400, "bad_request");
    }
  } else if (linkedId !== null) {
    return errorJson(400, "bad_request");
  }

  const result = await env.DB.prepare(
    `UPDATE requests
     SET status = ?, version = version + 1, handled_at = ?, linked_id = ?,
         expires_at = MIN(created_at + ?, ?)
     WHERE clinic_id = ? AND request_id = ? AND status = 'pending' AND version = ? AND expires_at > ?`,
  )
    .bind(
      state,
      now,
      state === "handled" ? linkedId : null,
      PENDING_RETENTION_MS,
      now + TERMINAL_RETENTION_MS,
      clinic.clinic_id,
      requestId,
      expectedVersion,
      now,
    )
    .run();

  if (result.meta.changes > 0) {
    return json({ ok: true, version: expectedVersion + 1 });
  }

  const current = await env.DB.prepare(
    "SELECT * FROM requests WHERE clinic_id = ? AND request_id = ?",
  )
    .bind(clinic.clinic_id, requestId)
    .first<RequestRow>();
  if (!current || current.expires_at <= now) return errorJson(404, "not_found");
  if (
    current.status === state &&
    (state === "handled" ? current.linked_id === linkedId : current.linked_id === null) &&
    current.version === expectedVersion + 1
  ) {
    return json({ ok: true, version: current.version });
  }
  return errorJson(409, "state_conflict");
}

export async function deleteRequest(env: Env, clinic: ClinicRow, body: unknown): Promise<Response> {
  if (!isPlainObject(body) || !onlyKeys(body, ["requestId"])) return errorJson(400, "bad_request");
  const requestId = body["requestId"];
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 64) {
    return errorJson(400, "bad_request");
  }
  await env.DB.prepare("DELETE FROM requests WHERE clinic_id = ? AND request_id = ?")
    .bind(clinic.clinic_id, requestId)
    .run();
  return json({ ok: true });
}

/** Retained interface used by tests to confirm expiry is honoured without cron. */
export async function pendingCount(env: Env, clinicId: string, now: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM requests WHERE clinic_id = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(clinicId, now)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
