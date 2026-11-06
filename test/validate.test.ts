import { describe, expect, it } from "vitest";
import { canonicalJson, CanonicalError } from "../src/canonical";
import { normalizeEmail, normalizePhone } from "../src/phone";
import { validateWeeklyHours, intersectIntervals, emptyWeek } from "../src/hours";
import { LANGUAGES, validateConfig } from "../src/config";
import { resolvePreference, validatePreferenceSyntax } from "../src/preference";
import { addDays, localDateTimeToInstant, weekdayOf, zoneDate, zoneMinutes, zoneTime } from "../src/time";
import { baseConfig } from "./helpers";

describe("canonical JSON", () => {
  it("sorts keys by UTF-16 code unit and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [2, 1], A: "x" })).toBe('{"A":"x","a":[2,1],"b":1}');
  });

  it("matches the shared fixture values", () => {
    expect(canonicalJson({ version: 1, action: "register", initialConfig: null })).toBe(
      '{"action":"register","initialConfig":null,"version":1}',
    );
    expect(canonicalJson("é\u0001\"\\")).toBe('"é\\u0001\\"\\\\"');
  });

  it("rejects unsafe numbers and lone surrogates", () => {
    expect(() => canonicalJson({ value: 1.5 })).toThrow(CanonicalError);
    expect(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(CanonicalError);
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalError);
  });
});

describe("phone normalization", () => {
  it("maps Arabic-Indic and Persian digits and strips separators", () => {
    expect(normalizePhone("+٩٦٦ ٥٥ ١٢٣ ٤٥٦٧")).toBe("+966551234567");
    expect(normalizePhone("+۹۶۶۵۵۱۲۳۴۵۶۷")).toBe("+966551234567");
    expect(normalizePhone("+966 (55) 123-4567")).toBe("+966551234567");
  });

  it("rejects national formats instead of guessing a country", () => {
    expect(normalizePhone("0551234567")).toBeNull();
    expect(normalizePhone("+0123456789")).toBeNull();
    expect(normalizePhone("+966551")).toBeNull();
  });

  it("accepts a single @ with non-empty parts", () => {
    expect(normalizeEmail(" jane@example.com ")).toBe("jane@example.com");
    expect(normalizeEmail("jane@@example.com")).toBeNull();
    expect(normalizeEmail("@example.com")).toBeNull();
    expect(normalizeEmail("jane doe@example.com")).toBeNull();
  });
});

describe("weekly hours", () => {
  it("requires all seven days, sorted non-overlapping intervals", () => {
    expect(validateWeeklyHours({ mon: [] }, "hours").ok).toBe(false);
    const overlapping = {
      ...emptyWeek(),
      mon: [["09:00", "12:00"], ["11:00", "13:00"]] as [string, string][],
    };
    expect(validateWeeklyHours(overlapping, "hours").ok).toBe(false);
    const reversed = { ...emptyWeek(), mon: [["13:00", "09:00"]] as [string, string][] };
    expect(validateWeeklyHours(reversed, "hours").ok).toBe(false);
    const valid = {
      ...emptyWeek(),
      mon: [["09:00", "12:00"], ["13:00", "17:00"]] as [string, string][],
    };
    expect(validateWeeklyHours(valid, "hours").ok).toBe(true);
  });

  it("intersects overlapping intervals", () => {
    expect(intersectIntervals([["09:00", "13:00"]], [["10:00", "11:00"]])).toEqual([
      ["10:00", "11:00"],
    ]);
    expect(intersectIntervals([["09:00", "13:00"]], [["13:00", "17:00"]])).toEqual([]);
  });
});

describe("clinic configuration", () => {
  it("rejects unknown fields recursively", () => {
    const config = baseConfig() as unknown as Record<string, unknown>;
    config["extra"] = true;
    expect(validateConfig(config).ok).toBe(false);

    const profile = baseConfig() as unknown as { profile: Record<string, unknown> };
    profile.profile["logo"] = "x";
    expect(validateConfig(profile).ok).toBe(false);
  });

  it("normalizes the accent colour and trims text", () => {
    const config = baseConfig();
    config.profile.accentColor = " #AABBCC ";
    config.profile.name = "  Clinic  ";
    const result = validateConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile.accentColor).toBe("#aabbcc");
      expect(result.value.profile.name).toBe("Clinic");
    }
  });

  it("treats an empty accent colour as the default palette", () => {
    const config = baseConfig();
    config.profile.accentColor = "";
    const result = validateConfig(config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profile.accentColor).toBe("");

    config.profile.accentColor = "  ";
    const spaced = validateConfig(config);
    expect(spaced.ok).toBe(true);
    if (spaced.ok) expect(spaced.value.profile.accentColor).toBe("");

    config.profile.accentColor = "#12345";
    expect(validateConfig(config).ok).toBe(false);
  });

  it("accepts every language the app ships and nothing else", () => {
    const config = baseConfig();
    for (const language of LANGUAGES) {
      config.profile.defaultLanguage = language;
      expect(validateConfig(config).ok, language).toBe(true);
    }
    config.profile.defaultLanguage = "de" as never;
    expect(validateConfig(config).ok).toBe(false);
  });

  it("rejects a retired staff section from older clients", () => {
    const config = baseConfig() as unknown as Record<string, unknown>;
    config["staff"] = [];
    expect(validateConfig(config).ok).toBe(false);
  });
});

describe("clinic clock", () => {
  it("adds calendar days, not 24-hour increments", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(weekdayOf("2026-11-09")).toBe(1);
  });

  it("reports DST gaps and folds instead of sliding", () => {
    const gap = localDateTimeToInstant("2026-03-29", "02:30", "Europe/Berlin");
    expect(gap.instantMs).toBeNull();
    const fold = localDateTimeToInstant("2026-10-25", "02:30", "Europe/Berlin");
    expect(fold.instantMs).not.toBeNull();
    expect(fold.ambiguous).toBe(true);
    const normal = localDateTimeToInstant("2026-11-20", "16:00", "Asia/Riyadh");
    expect(normal.instantMs).not.toBeNull();
    expect(normal.ambiguous).toBe(false);
  });

  it("formats in the clinic zone", () => {
    const instant = Date.UTC(2026, 10, 20, 13, 0);
    expect(zoneDate(instant, "Asia/Riyadh")).toBe("2026-11-20");
    expect(zoneTime(instant, "Asia/Riyadh")).toBe("16:00");
    expect(zoneMinutes(instant, "Asia/Riyadh")).toBe(16 * 60);
  });
});

describe("preference resolution", () => {
  const hours = baseConfig().hours;
  const now = Date.UTC(2026, 10, 6, 8, 0); // Friday 2026-11-06 08:00 UTC

  it("rejects syntactically invalid variants", () => {
    expect(validatePreferenceSyntax({ kind: "exact", date: "2026-11-20", from: "17:00", to: "16:00" }).ok).toBe(false);
    expect(validatePreferenceSyntax({ kind: "weekday", weekday: 0, weeks: 2, from: "16:00", to: "21:00" }).ok).toBe(false);
    expect(
      validatePreferenceSyntax({
        kind: "weekday",
        weekday: 1,
        weeks: 2,
        from: "16:00",
        to: "21:00",
        extra: true,
      }).ok,
    ).toBe(false);
  });

  it("retains only dates with a positive future intersection", () => {
    const preference = validatePreferenceSyntax({
      kind: "exact",
      date: "2026-11-09",
      from: "09:00",
      to: "13:00",
    });
    expect(preference.ok).toBe(true);
    if (!preference.ok) return;
    const resolved = resolvePreference(preference.value, hours, [], "UTC", now);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.candidateDates).toEqual(["2026-11-09"]);

    const closed = resolvePreference(preference.value, hours, ["2026-11-09"], "UTC", now);
    expect(closed.ok).toBe(false);
  });

  it("removes elapsed time from today", () => {
    const preference = validatePreferenceSyntax({
      kind: "exact",
      date: "2026-11-06",
      from: "08:00",
      to: "13:00",
    });
    if (!preference.ok) throw new Error("bad fixture");
    // Friday has no hours in the fixture, so keep a dedicated weekday open.
    const fridayHours = { ...hours, fri: [["09:00", "12:00"]] as ["09:00", "12:00"][] };
    const beforeClose = resolvePreference(
      preference.value,
      fridayHours,
      [],
      "UTC",
      Date.UTC(2026, 10, 6, 11, 0),
    );
    expect(beforeClose.ok).toBe(true);
    const afterClose = resolvePreference(
      preference.value,
      fridayHours,
      [],
      "UTC",
      Date.UTC(2026, 10, 6, 12, 0),
    );
    expect(afterClose.ok).toBe(false);
  });

  it("counts closed occurrences toward the weekday count", () => {
    const preference = validatePreferenceSyntax({
      kind: "weekday",
      weekday: 3,
      weeks: 2,
      from: "09:00",
      to: "13:00",
    });
    if (!preference.ok) throw new Error("bad fixture");
    const resolved = resolvePreference(preference.value, hours, [], "UTC", now);
    // Wednesdays are closed in the fixture; both occurrences are counted and none survive.
    expect(resolved.ok).toBe(false);
  });

  it("uses the next N calendar occurrences of a weekday", () => {
    const preference = validatePreferenceSyntax({
      kind: "weekday",
      weekday: 1,
      weeks: 2,
      from: "09:00",
      to: "13:00",
    });
    if (!preference.ok) throw new Error("bad fixture");
    const resolved = resolvePreference(preference.value, hours, [], "UTC", now);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.candidateDates).toEqual(["2026-11-09", "2026-11-16"]);
      expect(resolved.value.fromDate).toBe("2026-11-09");
      expect(resolved.value.toDate).toBe("2026-11-16");
    }
  });

  it("rejects ranges beyond the horizon or longer than 30 days", () => {
    const tooLong = validatePreferenceSyntax({
      kind: "range",
      start: "2026-11-09",
      end: "2026-12-20",
      from: "09:00",
      to: "13:00",
    });
    if (!tooLong.ok) throw new Error("bad fixture");
    expect(resolvePreference(tooLong.value, hours, [], "UTC", now).ok).toBe(false);

    const beyond = validatePreferenceSyntax({
      kind: "range",
      start: "2026-11-09",
      end: "2027-03-01",
      from: "09:00",
      to: "13:00",
    });
    if (!beyond.ok) throw new Error("bad fixture");
    expect(resolvePreference(beyond.value, hours, [], "UTC", now).ok).toBe(false);
  });
});
