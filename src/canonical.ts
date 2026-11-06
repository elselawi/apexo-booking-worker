/**
 * The constrained RFC 8785 subset used for operation proofs.
 *
 * Only JSON-native values are accepted, numbers must be safe integers, and
 * strings must be well-formed Unicode (no lone surrogates). Object keys are
 * sorted by UTF-16 code unit, which is what JavaScript's default string
 * comparison does and what the Dart fixture mirrors.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class CanonicalError extends Error {}

export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

const MAX_DEPTH = 64;

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalError("too_deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalError("unsafe_number");
      return String(value);
    case "string":
      return encodeString(value);
    case "object":
      break;
    default:
      throw new CanonicalError("unsupported_type");
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(encode(item, depth + 1));
    return "[" + parts.join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) throw new CanonicalError("undefined_value");
    parts.push(encodeString(key) + ":" + encode(item, depth + 1));
  }
  return "{" + parts.join(",") + "}";
}

function encodeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const char = value[i]!;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalError("lone_surrogate");
      out += char + value[i + 1]!;
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new CanonicalError("lone_surrogate");
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : char;
    }
  }
  return out + '"';
}
