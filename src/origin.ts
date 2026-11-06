/**
 * Canonical public HTTPS origin policy for caller-supplied clinic servers.
 *
 * Syntax rejection is *not* SSRF protection on its own: the deployed egress must
 * also restrict connections to globally routable addresses (see `PROOF_EGRESS`).
 */

const RESERVED_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".home",
  ".lan",
  ".test",
  ".example",
  ".invalid",
  ".onion",
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function canonicalOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;

  const host = url.hostname;
  if (host.length === 0 || host.length > 253) return null;
  if (host.endsWith(".")) return null;
  if (host.startsWith("[") || host.includes(":")) return null;
  if (IPV4.test(host)) return null;
  if (!host.includes(".")) return null;
  if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  if (host.split(".").some((label) => label.length === 0 || label.length > 63)) return null;
  if (url.port !== "") return null;

  return `https://${host}`;
}

export function isPublicEgressConfigured(value: string | undefined): boolean {
  return value === "public-only";
}
