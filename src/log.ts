/**
 * One JSON object per line, so Workers Logs can filter on `evt`.
 *
 * Never log patient fields, tokens or keys: ids, codes and timings only.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(
  level: "info" | "warn" | "error",
  evt: string,
  fields: Fields = {},
): void {
  const payload: Record<string, unknown> = { evt };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  const line = JSON.stringify(payload);
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
}
