import { appOrigins, type Env } from "./env";

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

export function errorJson(
  status: number,
  code: string,
  fields?: Record<string, string>,
  extra: Record<string, string> = {},
): Response {
  const payload: Record<string, unknown> = { ok: false, error: { code } };
  if (fields && Object.keys(fields).length > 0) {
    (payload["error"] as Record<string, unknown>)["fields"] = fields;
  }
  return json(payload, status, extra);
}

export function html(body: string, status = 200, headers: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...headers,
    },
  });
}

export function text(body: string, contentType: string, cache: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": cache,
      "x-content-type-options": "nosniff",
    },
  });
}

export function isSameOrigin(env: Env, request: Request): boolean {
  return request.headers.get("origin") === env.PUBLIC_ORIGIN;
}

export function isAllowedAppOrigin(env: Env, request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true; // native clients omit Origin
  return appOrigins(env).includes(origin);
}

export function corsHeadersFor(request: Request, env: Env): Record<string, string> | null {
  const origin = request.headers.get("origin");
  if (origin === null) return {};
  if (!appOrigins(env).includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
    "access-control-expose-headers": "x-suggested-handles, retry-after",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export class BodyTooLarge extends Error {}

/** Streams a request body into text without ever buffering more than `limit`. */
export async function readBoundedText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge();
  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
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
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged);
  } catch {
    throw new BodyTooLarge();
  }
}

export function bearerKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  return match ? match[1]! : null;
}

export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}
