export interface Env {
  DB: D1Database;

  PUBLIC_ORIGIN: string;
  APP_ORIGINS: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_HOSTNAME: string;
  TURNSTILE_VERIFY_TIMEOUT_MS?: string;
  /** `public-only` once connection-time public-address egress is verified. */
  PROOF_EGRESS?: string;

  TURNSTILE_SECRET?: string;
  BOOKING_HMAC_KEY?: string;
  /**
   * `1` only in local dev: permits Turnstile's always-pass test secrets, which
   * production must never accept.
   */
  ALLOW_TEST_SECRET?: string;
}

export const PENDING_CAP = 500;
export const REQUEST_BODY_LIMIT = 8 * 1024;
export const CONFIG_BODY_LIMIT = 32 * 1024;

export const CONSENT_VERSION = "booking-privacy-v1";

export const PENDING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function hmacKey(env: Env): string {
  const key = env.BOOKING_HMAC_KEY;
  if (!key) throw new Error("missing_hmac_key");
  return key;
}

export function appOrigins(env: Env): string[] {
  return (env.APP_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
