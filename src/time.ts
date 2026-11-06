/**
 * Clinic-zone calendar helpers.
 *
 * A clinic has exactly one IANA time zone. Calendar days are added in that zone
 * (never as 24-hour UTC increments) and wall-clock conversions report DST gaps
 * and folds instead of silently sliding.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function zoneParts(instantMs: number, timeZone: string): ZoneParts {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const read = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  let hour = read("hour");
  if (hour === 24) hour = 0;
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function zoneDate(instantMs: number, timeZone: string): string {
  const parts = zoneParts(instantMs, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function zoneTime(instantMs: number, timeZone: string): string {
  const parts = zoneParts(instantMs, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function zoneMinutes(instantMs: number, timeZone: string): number {
  const parts = zoneParts(instantMs, timeZone);
  return parts.hour * 60 + parts.minute;
}

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number) as [number, number];
  return hour * 60 + minute;
}

export function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  return `${pad(hour)}:${pad(minutes % 60)}`;
}

function dateToUtc(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

export function addDays(date: string, days: number): string {
  const shifted = new Date(dateToUtc(date) + days * 86_400_000);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dateToUtc(to) - dateToUtc(from)) / 86_400_000);
}

/** 1 = Monday … 7 = Sunday. */
export function weekdayOf(date: string): number {
  const day = new Date(dateToUtc(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  const count = daysBetween(start, end);
  for (let i = 0; i <= count; i++) out.push(addDays(start, i));
  return out;
}

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = zoneParts(instantMs, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

export interface WallClockResolution {
  instantMs: number | null;
  ambiguous: boolean;
}

/**
 * Resolves a clinic-local date and time to an instant.
 *
 * A wall clock that does not exist (spring-forward gap) returns `null`; a time
 * that occurs twice (fall-back fold) returns the earlier instant with
 * `ambiguous: true`.
 */
export function localDateTimeToInstant(
  date: string,
  time: string,
  timeZone: string,
): WallClockResolution {
  if (!isValidDate(date) || !isValidTime(time)) return { instantMs: null, ambiguous: false };
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(year, month - 1, day, hour, minute);

  const offsets = new Set<number>();
  for (const probe of [guess - 26 * 3_600_000, guess, guess + 26 * 3_600_000]) {
    offsets.add(zoneOffsetMs(probe, timeZone));
  }
  let probe = guess;
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffsetMs(probe, timeZone);
    offsets.add(offset);
    probe = guess - offset;
  }

  const valid = [...offsets]
    .map((offset) => guess - offset)
    .filter((instant) => {
      const parts = zoneParts(instant, timeZone);
      return (
        parts.year === year &&
        parts.month === month &&
        parts.day === day &&
        parts.hour === hour &&
        parts.minute === minute
      );
    })
    .sort((a, b) => a - b);

  if (valid.length === 0) return { instantMs: null, ambiguous: false };
  return { instantMs: valid[0]!, ambiguous: valid.length > 1 };
}
