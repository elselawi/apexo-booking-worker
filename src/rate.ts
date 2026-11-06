import { hmacKey, type Env } from "./env";
import { base64UrlDecode, base64UrlEncode, constantTimeEqual, hmacSha256Hex, randomHex } from "./crypto";

export interface RateBucket {
  bucket: string;
  ceiling: number;
  reset: number;
}

/**
 * Guarded fixed-window upsert. A rejected call leaves the stored count alone;
 * the window number is part of the bucket key, so resets need no cron.
 */
export async function consumeRate(db: D1Database, spec: RateBucket, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO rate (bucket, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate.reset_at <= ? THEN 1 ELSE rate.count + 1 END,
         reset_at = excluded.reset_at
       WHERE rate.reset_at <= ? OR rate.count < ?
       RETURNING count`,
    )
    .bind(spec.bucket, spec.reset, now, now, spec.ceiling)
    .first<{ count: number }>();
  return row !== null && row.count <= spec.ceiling;
}

export async function consumeRates(
  db: D1Database,
  specs: readonly RateBucket[],
  now: number,
): Promise<boolean> {
  for (const spec of specs) {
    if (!(await consumeRate(db, spec, now))) return false;
  }
  return true;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

export function minuteWindow(now: number): number {
  return Math.floor(now / MINUTE);
}

export function hourWindow(now: number): number {
  return Math.floor(now / HOUR);
}

export function dayWindow(now: number): number {
  return Math.floor(now / DAY);
}

export function minuteReset(now: number): number {
  return (minuteWindow(now) + 1) * MINUTE;
}

export function hourReset(now: number): number {
  return (hourWindow(now) + 1) * HOUR;
}

export function dayReset(now: number): number {
  return (dayWindow(now) + 1) * DAY;
}

/** Domain-separated, secret-derived bucket ids — never a plain IP/phone hash. */
export async function bucketId(env: Env, label: string, value: string): Promise<string> {
  const digest = await hmacSha256Hex(hmacKey(env), `${label}|${value}`);
  return digest.slice(0, 32);
}

export function retryAfterSeconds(reset: number, now: number): string {
  return String(Math.max(1, Math.ceil((reset - now) / 1000)));
}

// ---------------------------------------------------------------------------
// Snapshot tokens: tenant/filter-bound, short-lived, signed with the Worker
// HMAC key so a pull cannot be reassembled against a different revision.
// ---------------------------------------------------------------------------

export interface SnapshotPayload {
  clinicId: string;
  status: string;
  revision: number;
  exp: number;
  filter: string;
}

export async function signSnapshot(env: Env, payload: SnapshotPayload): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256Hex(hmacKey(env), body);
  return `${body}.${signature}`;
}

export async function verifySnapshot(
  env: Env,
  token: string,
  expected: { clinicId: string; status: string; filter: string },
  now: number,
): Promise<SnapshotPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const expectedSignature = await hmacSha256Hex(hmacKey(env), body);
  if (!constantTimeEqual(expectedSignature, signature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as SnapshotPayload;
    if (payload.clinicId !== expected.clinicId) return null;
    if (payload.status !== expected.status) return null;
    if (payload.filter !== expected.filter) return null;
    if (payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newRequestId(): string {
  return randomHex(16);
}
