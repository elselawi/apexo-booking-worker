import { hasFutureIntersection, type WeeklyHours } from "./hours";
import { isPlainObject, onlyKeys } from "./text";
import {
  addDays,
  daysBetween,
  enumerateDates,
  isValidDate,
  isValidTime,
  weekdayOf,
  zoneDate,
  zoneMinutes,
} from "./time";

export const HORIZON_DAYS = 90;
export const MAX_RANGE_DAYS = 30;
export const MAX_WEEKS = 4;

export type Preference =
  | { kind: "exact"; date: string; from: string; to: string }
  | { kind: "range"; start: string; end: string; from: string; to: string }
  | { kind: "weekday"; weekday: number; weeks: number; from: string; to: string };

export interface ResolvedPreference {
  preference: Preference;
  candidateDates: string[];
  fromDate: string;
  toDate: string;
  windowFrom: string;
  windowTo: string;
}

export type PreferenceResult =
  | { ok: true; value: ResolvedPreference }
  | { ok: false; field: string };

export function validatePreferenceSyntax(raw: unknown): { ok: true; value: Preference } | { ok: false; field: string } {
  if (!isPlainObject(raw)) return { ok: false, field: "preference" };
  const kind = raw["kind"];
  if (kind === "exact") {
    if (!onlyKeys(raw, ["kind", "date", "from", "to"])) return { ok: false, field: "preference" };
    const { date, from, to } = raw;
    if (!isValidDate(date) || !isValidTime(from) || !isValidTime(to) || from >= to) {
      return { ok: false, field: "preference" };
    }
    return { ok: true, value: { kind, date, from, to } };
  }
  if (kind === "range") {
    if (!onlyKeys(raw, ["kind", "start", "end", "from", "to"])) return { ok: false, field: "preference" };
    const { start, end, from, to } = raw;
    if (
      !isValidDate(start) ||
      !isValidDate(end) ||
      !isValidTime(from) ||
      !isValidTime(to) ||
      from >= to ||
      start > end
    ) {
      return { ok: false, field: "preference" };
    }
    return { ok: true, value: { kind, start, end, from, to } };
  }
  if (kind === "weekday") {
    if (!onlyKeys(raw, ["kind", "weekday", "weeks", "from", "to"])) {
      return { ok: false, field: "preference" };
    }
    const { weekday, weeks, from, to } = raw;
    if (
      typeof weekday !== "number" ||
      !Number.isInteger(weekday) ||
      weekday < 1 ||
      weekday > 7 ||
      typeof weeks !== "number" ||
      !Number.isInteger(weeks) ||
      weeks < 1 ||
      weeks > MAX_WEEKS ||
      !isValidTime(from) ||
      !isValidTime(to) ||
      from >= to
    ) {
      return { ok: false, field: "preference" };
    }
    return { ok: true, value: { kind, weekday, weeks, from, to } };
  }
  return { ok: false, field: "preference" };
}

/**
 * Resolves a syntactically valid preference against the clinic's *current*
 * hours. Only dates with a positive-duration future intersection are retained.
 */
export function resolvePreference(
  preference: Preference,
  hours: WeeklyHours,
  closedDates: readonly string[],
  timeZone: string,
  nowMs: number,
): PreferenceResult {
  const today = zoneDate(nowMs, timeZone);
  const nowMinutes = zoneMinutes(nowMs, timeZone);
  const horizon = addDays(today, HORIZON_DAYS);

  const candidates = (dates: readonly string[]): string[] =>
    dates.filter((date) =>
      hasFutureIntersection(date, hours, closedDates, preference.from, preference.to, today, nowMinutes),
    );

  if (preference.kind === "exact") {
    if (preference.date < today || preference.date > horizon) return { ok: false, field: "preference.date" };
    const resolved = candidates([preference.date]);
    if (resolved.length === 0) return { ok: false, field: "preference.date" };
    return {
      ok: true,
      value: {
        preference,
        candidateDates: resolved,
        fromDate: preference.date,
        toDate: preference.date,
        windowFrom: preference.from,
        windowTo: preference.to,
      },
    };
  }

  if (preference.kind === "range") {
    if (preference.start < today || preference.end > horizon) {
      return { ok: false, field: "preference.start" };
    }
    if (daysBetween(preference.start, preference.end) + 1 > MAX_RANGE_DAYS) {
      return { ok: false, field: "preference.end" };
    }
    const resolved = candidates(enumerateDates(preference.start, preference.end));
    if (resolved.length === 0) return { ok: false, field: "preference.start" };
    return {
      ok: true,
      value: {
        preference,
        candidateDates: resolved,
        fromDate: preference.start,
        toDate: preference.end,
        windowFrom: preference.from,
        windowTo: preference.to,
      },
    };
  }

  const occurrences: string[] = [];
  let cursor = today;
  const daysAhead = (preference.weekday - weekdayOf(today) + 7) % 7;
  if (daysAhead === 0) {
    // Today counts only while a matching window still has future availability.
    const todayCandidate = candidates([today]).length > 0;
    cursor = todayCandidate ? today : addDays(today, 7);
  } else {
    cursor = addDays(today, daysAhead);
  }
  for (let index = 0; index < preference.weeks; index++) {
    occurrences.push(cursor);
    cursor = addDays(cursor, 7);
  }
  const resolved = candidates(occurrences);
  if (resolved.length === 0) return { ok: false, field: "preference.weekday" };
  return {
    ok: true,
    value: {
      preference,
      candidateDates: resolved,
      fromDate: resolved[0]!,
      toDate: resolved[resolved.length - 1]!,
      windowFrom: preference.from,
      windowTo: preference.to,
    },
  };
}

/** A locally translated preference label is derived from these fields. */
export function preferenceWeekdayName(weekday: number): string {
  const names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  return names[weekday - 1] ?? "mon";
}
