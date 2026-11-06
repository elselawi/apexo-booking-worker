import type { Env } from "./env";

export interface TurnstileResult {
  ok: boolean;
  /** `denied` = the provider rejected the token; `unavailable` = we could not ask. */
  reason?: "denied" | "unavailable";
  /** Diagnostics for the caller to log once — never the token or the secret. */
  status?: number;
  codes?: string[];
  elapsedMs?: number;
}

interface SiteVerifyPayload {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

/**
 * Codes that mean "this token is not usable", not "our secret is wrong".
 * Cloudflare answers HTTP 400 for both kinds, so the codes decide.
 */
const TOKEN_CODES = [
  "invalid-input-response",
  "timeout-or-duplicate",
  "bad-request",
  "missing-input-response",
];

/** Turnstile's documented always-pass secrets: only with `ALLOW_TEST_SECRET=1`. */
const TEST_SECRETS = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];

/**
 * Server-side Turnstile verification. Missing verification or a provider
 * failure never admits a request.
 */
export async function verifyTurnstile(
  env: Env,
  token: string,
  remoteIp: string,
): Promise<TurnstileResult> {
  // A pasted secret can arrive with a trailing newline; Cloudflare compares it
  // byte for byte, so trim it here rather than fail every patient.
  const secret = env.TURNSTILE_SECRET?.trim();
  if (!secret) return { ok: false, reason: "unavailable", codes: ["missing-secret"] };
  if (TEST_SECRETS.includes(secret) && env.ALLOW_TEST_SECRET !== "1") {
    // A test secret in production would accept every token: fail closed.
    return { ok: false, reason: "unavailable", codes: ["test-secret-not-allowed"] };
  }
  // Turnstile's test sitekey mints tokens without an action or hostname, so the
  // local bypass also skips those two checks. Production never sets the flag.
  const testBypass = env.ALLOW_TEST_SECRET === "1" && TEST_SECRETS.includes(secret);
  const timeout = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS ?? "8000");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeout) ? timeout : 8000);
  const started = Date.now();
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as SiteVerifyPayload | null;
    const codes = payload?.["error-codes"] ?? [];
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const tokenProblem = codes.some((code) => TOKEN_CODES.includes(code));
      return {
        ok: false,
        reason: tokenProblem ? "denied" : "unavailable",
        status: response.status,
        codes: codes.length > 0 ? codes : [`http-${response.status}`],
        elapsedMs,
      };
    }
    if (payload === null || payload.success !== true) {
      return { ok: false, reason: "denied", status: response.status, codes, elapsedMs };
    }
    if (payload.action !== "booking_submit" && !testBypass) {
      return {
        ok: false,
        reason: "denied",
        status: response.status,
        codes: ["action-mismatch"],
        elapsedMs,
      };
    }
    const expectedHost = env.TURNSTILE_HOSTNAME?.trim();
    if (expectedHost && payload.hostname !== expectedHost && !testBypass) {
      return {
        ok: false,
        reason: "denied",
        status: response.status,
        codes: ["hostname-mismatch"],
        elapsedMs,
      };
    }
    return { ok: true, elapsedMs };
  } catch (error) {
    return {
      ok: false,
      reason: "unavailable",
      codes: [error instanceof Error ? error.name : "network"],
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
