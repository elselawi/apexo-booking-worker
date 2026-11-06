import { emptyWeek, validateWeeklyHours, type WeeklyHours } from "./hours";
import { isDialCode, normalizeEmail, normalizePhone } from "./phone";
import { codePointLength, hasControl, isPlainObject, nfc, onlyKeys, trimmedNfc, utf8Length } from "./text";
import { isValidDate, isValidTimeZone } from "./time";

export const MAX_CONFIG_BYTES = 24 * 1024;
export const LANGUAGES = ["en", "ar", "es", "el", "fa", "ku", "fr", "tr", "it", "ur"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Right-to-left dictionaries; the page shell mirrors its direction for these. */
export const RTL_LANGUAGES: readonly Language[] = ["ar", "fa", "ku", "ur"];

export interface Profile {
  name: string;
  phone: string;
  address: string;
  welcome: string;
  accentColor: string;
  defaultLanguage: Language;
}

export interface ClinicConfig {
  profile: Profile;
  timeZone: string;
  dialCode: string;
  hours: WeeklyHours;
  closedDates: string[];
  contactEmail: string | null;
  enabled: boolean;
}

export type ConfigResult = { ok: true; value: ClinicConfig } | { ok: false; field: string };

const PROFILE_KEYS = ["name", "phone", "address", "welcome", "accentColor", "defaultLanguage"];
const CONFIG_KEYS = [
  "profile",
  "timeZone",
  "dialCode",
  "hours",
  "closedDates",
  "contactEmail",
  "enabled",
];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function isAccentColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value);
}

/**
 * Validates and normalizes a clinic configuration.
 *
 * Unknown fields are rejected recursively; text is NFC-normalized and trimmed;
 * the accent colour is lowercased. The accent may be empty, which means the
 * public page keeps its own palette.
 */
export function validateConfig(raw: unknown): ConfigResult {
  if (!isPlainObject(raw)) return { ok: false, field: "config" };
  if (!onlyKeys(raw, CONFIG_KEYS)) return { ok: false, field: "config" };
  if (utf8Length(JSON.stringify(raw)) > MAX_CONFIG_BYTES) return { ok: false, field: "config" };

  const profileRaw = raw["profile"];
  if (!isPlainObject(profileRaw) || !onlyKeys(profileRaw, PROFILE_KEYS)) {
    return { ok: false, field: "profile" };
  }

  const name = typeof profileRaw["name"] === "string" ? trimmedNfc(profileRaw["name"]) : null;
  if (name === null || codePointLength(name) < 1 || codePointLength(name) > 100) {
    return { ok: false, field: "profile.name" };
  }

  const phone =
    typeof profileRaw["phone"] === "string" ? normalizePhone(profileRaw["phone"]) : null;
  if (phone === null) return { ok: false, field: "profile.phone" };

  let address = "";
  if (profileRaw["address"] !== undefined && profileRaw["address"] !== null) {
    if (typeof profileRaw["address"] !== "string") return { ok: false, field: "profile.address" };
    const normalized = trimmedNfc(profileRaw["address"], true);
    if (normalized === null || codePointLength(normalized) > 300) {
      return { ok: false, field: "profile.address" };
    }
    address = normalized;
  }

  let welcome = "";
  if (profileRaw["welcome"] !== undefined && profileRaw["welcome"] !== null) {
    if (typeof profileRaw["welcome"] !== "string") return { ok: false, field: "profile.welcome" };
    const normalized = trimmedNfc(profileRaw["welcome"], true);
    if (normalized === null || codePointLength(normalized) > 500) {
      return { ok: false, field: "profile.welcome" };
    }
    welcome = normalized;
  }

  let accentColor = "";
  if (profileRaw["accentColor"] !== undefined && profileRaw["accentColor"] !== null) {
    if (typeof profileRaw["accentColor"] !== "string") {
      return { ok: false, field: "profile.accentColor" };
    }
    const normalized = profileRaw["accentColor"].trim().toLowerCase();
    if (normalized !== "") {
      if (!isAccentColor(normalized)) return { ok: false, field: "profile.accentColor" };
      accentColor = normalized;
    }
  }

  const defaultLanguage = profileRaw["defaultLanguage"];
  if (!isLanguage(defaultLanguage)) return { ok: false, field: "profile.defaultLanguage" };

  const timeZone = raw["timeZone"];
  if (!isValidTimeZone(timeZone)) return { ok: false, field: "timeZone" };

  const dialCode = raw["dialCode"];
  if (!isDialCode(dialCode)) return { ok: false, field: "dialCode" };

  const hours = validateWeeklyHours(raw["hours"], "hours");
  if (!hours.ok) return { ok: false, field: hours.field };

  const closedDatesRaw = raw["closedDates"];
  if (!Array.isArray(closedDatesRaw) || closedDatesRaw.length > 366) {
    return { ok: false, field: "closedDates" };
  }
  const closedDates: string[] = [];
  for (const candidate of closedDatesRaw) {
    if (!isValidDate(candidate) || closedDates.includes(candidate)) {
      return { ok: false, field: "closedDates" };
    }
    closedDates.push(candidate);
  }

  let contactEmail: string | null = null;
  const contactRaw = raw["contactEmail"];
  if (contactRaw !== undefined && contactRaw !== null && contactRaw !== "") {
    if (typeof contactRaw !== "string") return { ok: false, field: "contactEmail" };
    contactEmail = normalizeEmail(contactRaw);
    if (contactEmail === null) return { ok: false, field: "contactEmail" };
  }

  const enabled = raw["enabled"];
  if (typeof enabled !== "boolean") return { ok: false, field: "enabled" };

  return {
    ok: true,
    value: {
      profile: { name, phone, address, welcome, accentColor, defaultLanguage },
      timeZone,
      dialCode,
      hours: hours.value,
      closedDates,
      contactEmail,
      enabled,
    },
  };
}

export function emptyConfig(): ClinicConfig {
  return {
    profile: {
      name: "",
      phone: "",
      address: "",
      welcome: "",
      accentColor: "",
      defaultLanguage: "en",
    },
    timeZone: "UTC",
    dialCode: "+1",
    hours: emptyWeek(),
    closedDates: [],
    contactEmail: null,
    enabled: false,
  };
}

export function configHasControlCharacters(config: ClinicConfig): boolean {
  return [config.profile.name, config.profile.address, config.profile.welcome].some((value) =>
    hasControl(value, true),
  );
}

export function configTextsNfc(config: ClinicConfig): boolean {
  return [config.profile.name, config.profile.address, config.profile.welcome].every(
    (value) => nfc(value) === value,
  );
}
