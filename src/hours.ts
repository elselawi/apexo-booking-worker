import { isPlainObject, onlyKeys } from "./text";
import { isValidTime, timeToMinutes, weekdayOf } from "./time";

export type Interval = [string, string];
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type WeeklyHours = Record<Weekday, Interval[]>;

export const MAX_INTERVALS_PER_DAY = 4;

export function emptyWeek(): WeeklyHours {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

export type HoursResult =
  | { ok: true; value: WeeklyHours }
  | { ok: false; field: string };

/** Validates the seven-key weekly hours object shared by clinics and staff. */
export function validateWeeklyHours(raw: unknown, field: string): HoursResult {
  if (!isPlainObject(raw) || !onlyKeys(raw, WEEKDAYS)) return { ok: false, field };
  const out = emptyWeek();
  for (const day of WEEKDAYS) {
    const value = raw[day];
    if (!Array.isArray(value)) return { ok: false, field: `${field}.${day}` };
    if (value.length > MAX_INTERVALS_PER_DAY) return { ok: false, field: `${field}.${day}` };
    const intervals: Interval[] = [];
    let previousEnd = -1;
    for (const candidate of value) {
      if (!Array.isArray(candidate) || candidate.length !== 2) {
        return { ok: false, field: `${field}.${day}` };
      }
      const [start, end] = candidate as unknown[];
      if (!isValidTime(start) || !isValidTime(end)) {
        return { ok: false, field: `${field}.${day}` };
      }
      const startMinutes = timeToMinutes(start);
      const endMinutes = timeToMinutes(end);
      if (startMinutes >= endMinutes) return { ok: false, field: `${field}.${day}` };
      if (startMinutes <= previousEnd) return { ok: false, field: `${field}.${day}` };
      previousEnd = endMinutes;
      intervals.push([start, end]);
    }
    out[day] = intervals;
  }
  return { ok: true, value: out };
}

export function weekdayKey(date: string): Weekday {
  return WEEKDAYS[weekdayOf(date) - 1]!;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(timeToMinutes(aStart), timeToMinutes(bStart));
      const end = Math.min(timeToMinutes(aEnd), timeToMinutes(bEnd));
      if (end > start) {
        out.push([
          `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`,
          `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`,
        ]);
      }
    }
  }
  return out;
}

export function intervalsForDate(
  date: string,
  hours: WeeklyHours,
  closedDates: readonly string[],
): Interval[] {
  if (closedDates.includes(date)) return [];
  return hours[weekdayKey(date)];
}

/**
 * Removes elapsed time from a same-day window and requires a *positive*
 * duration intersection with the opening hours.
 */
export function hasFutureIntersection(
  date: string,
  hours: WeeklyHours,
  closedDates: readonly string[],
  from: string,
  to: string,
  today: string,
  nowMinutes: number,
): boolean {
  if (date < today) return false;
  const fromMinutes = timeToMinutes(from);
  const toMinutes = timeToMinutes(to);
  const floor = date === today ? nowMinutes : 0;
  for (const [openStart, openEnd] of intervalsForDate(date, hours, closedDates)) {
    const start = Math.max(fromMinutes, timeToMinutes(openStart), floor);
    const end = Math.min(toMinutes, timeToMinutes(openEnd));
    if (end > start) return true;
  }
  return false;
}
