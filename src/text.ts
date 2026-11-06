/** Shared text rules: NFC, code-point lengths, control characters. */

export function nfc(value: string): string {
  return value.normalize("NFC");
}

export function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

export function hasControl(value: string, allowNewlines = false): boolean {
  return (allowNewlines ? CONTROL_EXCEPT_NEWLINES : CONTROL).test(value);
}

export function trimmedNfc(value: string, allowNewlines = false): string | null {
  if (hasControl(value, allowNewlines)) return null;
  const normalized = nfc(value.trim());
  if (hasControl(normalized, allowNewlines)) return null;
  return normalized;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects any key outside the allowlist, recursively where requested. */
export function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
