import bookingCss from "../assets/booking.css";
import { BOOKING_CLIENT_CSS, BOOKING_CLIENT_JS as bookingJs } from "./client_script.generated";

if (typeof bookingCss === "object" && bookingCss !== null) {
  (bookingCss as { toString?: () => string; valueOf?: () => string }).toString = () =>
    BOOKING_CLIENT_CSS;
  (bookingCss as { toString?: () => string; valueOf?: () => string }).valueOf = () =>
    BOOKING_CLIENT_CSS;
}
// JSON modules, not text: Wrangler inlines `.json` imports as values in the
// deployed bundle (the Text rule is not honoured there), so parsing them as
// strings would fail only after deploy.
import enDictionary from "../assets/i18n/en.json";
import arDictionary from "../assets/i18n/ar.json";
import esDictionary from "../assets/i18n/es.json";
import elDictionary from "../assets/i18n/el.json";
import faDictionary from "../assets/i18n/fa.json";
import kuDictionary from "../assets/i18n/ku.json";
import frDictionary from "../assets/i18n/fr.json";
import trDictionary from "../assets/i18n/tr.json";
import itDictionary from "../assets/i18n/it.json";
import urDictionary from "../assets/i18n/ur.json";

import type { ClinicRow } from "./db";
import { configFromRow } from "./db";
import { RTL_LANGUAGES, type Language } from "./config";
import { WEEKDAYS } from "./hours";
import { addDays, weekdayOf, zoneDate } from "./time";

type Dictionary = Record<string, string>;

const DICTIONARIES: Record<Language, Dictionary> = {
  en: enDictionary as Dictionary,
  ar: arDictionary as Dictionary,
  es: esDictionary as Dictionary,
  el: elDictionary as Dictionary,
  fa: faDictionary as Dictionary,
  ku: kuDictionary as Dictionary,
  fr: frDictionary as Dictionary,
  tr: trDictionary as Dictionary,
  it: itDictionary as Dictionary,
  ur: urDictionary as Dictionary,
};

const DAY_KEYS = ["dayMon", "dayTue", "dayWed", "dayThu", "dayFri", "daySat", "daySun"] as const;

export const LOCALE_COOKIE = "booking_lang";

/** Native names, so the picker never shows a bare two-letter code. */
const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ar: "العربية",
  es: "Español",
  el: "Ελληνικά",
  fa: "فارسی",
  ku: "کوردی",
  fr: "Français",
  tr: "Türkçe",
  it: "Italiano",
  ur: "اردو",
};

function readCookie(request: Request, name: string): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

/** Remembered explicitly by the patient; the page itself is never cached. */
export function localeCookie(locale: Language, secure: boolean): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function resolveLocale(request: Request, clinicDefault: string): Language {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("lang");
  if (explicit && explicit in DICTIONARIES) return explicit as Language;
  // An explicit choice outranks the clinic default and the browser's tag.
  const remembered = readCookie(request, LOCALE_COOKIE);
  if (remembered in DICTIONARIES) return remembered as Language;
  const header = request.headers.get("accept-language") ?? "";
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    const base = tag.split("-")[0] ?? "";
    if (base in DICTIONARIES) return base as Language;
  }
  if (clinicDefault in DICTIONARIES) return clinicDefault as Language;
  return "en";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Serializes embedded JSON without allowing a closing script sequence. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function randomNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const ASSET_VERSION = fnv1a(bookingCss + bookingJs).slice(0, 12);

export function assetPath(name: "booking.css" | "booking.js"): string {
  return `/assets/${name.replace(".", `-${ASSET_VERSION}.`)}`;
}

export function csp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function pageHeaders(nonce: string): Record<string, string> {
  return {
    "content-security-policy": csp(nonce),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

export interface PageContext {
  origin: string;
  consentVersion: string;
  turnstileSiteKey: string;
  nowMs: number;
}

const ICON_PIN = `<svg class="icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 17.5s5.5-4.7 5.5-9A5.5 5.5 0 0 0 4.5 8.5c0 4.3 5.5 9 5.5 9Z"/><circle cx="10" cy="8.5" r="2"/></svg>`;
const ICON_PHONE = `<svg class="icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.2 3.5h2.7l1.2 3.2-1.6 1.2a10.2 10.2 0 0 0 5.6 5.6l1.2-1.6 3.2 1.2v2.7a1.5 1.5 0 0 1-1.6 1.5A13.8 13.8 0 0 1 2.7 5.1 1.5 1.5 0 0 1 4.2 3.5Z"/></svg>`;
const ICON_CLOCK = `<svg class="icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="7.5"/><path d="M10 6v4.2l2.8 1.6"/></svg>`;
const ICON_INFO = `<svg class="icon" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v4.5M10 6.5h.01"/></svg>`;
const ICON_CHECK = `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>`;
const ICON_ALERT = `<svg class="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>`;
const ICON_SHIELD = `<svg class="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3 4.5 6.3v5.3c0 5 3.2 8.7 7.5 9.9 4.3-1.2 7.5-4.9 7.5-9.9V6.3L12 3Z"/><path d="m9.5 12 1.8 1.8 3.4-3.6"/></svg>`;

function channelLum(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

function wcagContrast(l1: number, l2: number): number {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function mixToward(
  rgb: [number, number, number],
  target: [number, number, number],
  bgLum: number,
  minRatio: number,
): string {
  const [r, g, b] = rgb;
  if (wcagContrast(relLuminance(r, g, b), bgLum) >= minRatio) {
    return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  }
  for (let step = 1; step <= 25; step++) {
    const t = step / 25;
    const mr = r + (target[0] - r) * t;
    const mg = g + (target[1] - g) * t;
    const mb = b + (target[2] - b) * t;
    if (wcagContrast(relLuminance(mr, mg, mb), bgLum) >= minRatio) {
      return `#${toHexByte(mr)}${toHexByte(mg)}${toHexByte(mb)}`;
    }
  }
  return `#${toHexByte(target[0])}${toHexByte(target[1])}${toHexByte(target[2])}`;
}

/**
 * Derives WCAG AA contrast-safe tokens from the clinic's `--accent` hex colour
 * so foreground text on buttons and accent links on light/dark surfaces always
 * meet >= 4.5:1 contrast.
 */
function buildAccentCss(raw?: string): string {
  if (!raw || !/^#[0-9a-fA-F]{6}$/.test(raw)) return "";
  const hex = raw.toLowerCase();
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = relLuminance(r, g, b);
  const darkInkLum = relLuminance(11, 19, 27);
  const onAccent = wcagContrast(lum, 1) >= wcagContrast(lum, darkInkLum) ? "#ffffff" : "#0b131b";
  const textLight = mixToward([r, g, b], [11, 19, 27], 0.91, 4.6);
  const textDark = mixToward([r, g, b], [255, 255, 255], 0.025, 4.6);
  return `:root{--accent:${escapeHtml(hex)};--on-accent:${onAccent};--accent-text:${textLight};--accent-text-dark:${textDark}}`;
}

function shell(options: {
  locale: Language;
  title: string;
  nonce: string;
  body: string;
  script?: string;
  accent?: string;
}): string {
  const dir = RTL_LANGUAGES.includes(options.locale) ? "rtl" : "ltr";
  const accent = buildAccentCss(options.accent);
  return `<!doctype html>
<html lang="${options.locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="${assetPath("booking.css")}">
<style nonce="${options.nonce}">${accent}</style>
</head>
<body>
<main class="page-shell">
${options.body}
</main>
${options.script ?? ""}
</body>
</html>`;
}

export function renderNotFound(locale: Language, nonce: string): string {
  const dictionary = DICTIONARIES[locale];
  return shell({
    locale,
    title: dictionary["notFoundTitle"] ?? "Clinic not found",
    nonce,
    body: `<section class="notice status-page"><div class="status-badge" aria-hidden="true">${ICON_ALERT}</div><h1>${escapeHtml(dictionary["notFoundTitle"] ?? "")}</h1><p>${escapeHtml(dictionary["notFoundBody"] ?? "")}</p></section>
<footer>${escapeHtml(dictionary["poweredBy"] ?? "")}</footer>`,
  });
}

export function renderSuspended(locale: Language, nonce: string): string {
  const dictionary = DICTIONARIES[locale];
  return shell({
    locale,
    title: dictionary["notFoundTitle"] ?? "Unavailable",
    nonce,
    body: `<section class="notice status-page"><div class="status-badge" aria-hidden="true">${ICON_ALERT}</div><h1>${escapeHtml(dictionary["notFoundTitle"] ?? "")}</h1><p>${escapeHtml(dictionary["notFoundBody"] ?? "")}</p></section>
<footer>${escapeHtml(dictionary["poweredBy"] ?? "")}</footer>`,
  });
}

export function renderPrivacy(locale: Language, nonce: string): string {
  const dictionary = DICTIONARIES[locale];
  return shell({
    locale,
    title: dictionary["privacyTitle"] ?? "Privacy",
    nonce,
    body: `<section class="privacy-card"><div class="section-heading"><span class="section-icon" aria-hidden="true">${ICON_SHIELD}</span><h1>${escapeHtml(dictionary["privacyTitle"] ?? "")}</h1></div><p class="privacy-prose">${escapeHtml(dictionary["privacyBody"] ?? "")}</p></section>
<footer>${escapeHtml(dictionary["poweredBy"] ?? "")}</footer>`,
  });
}

function hoursTable(row: ClinicRow, locale: Language, todayWeekday: number): string {
  const dictionary = DICTIONARIES[locale];
  const config = configFromRow(row);
  const rows: string[] = [];
  // Patients read the week starting today, not on Monday.
  const start = (todayWeekday - 1) % 7;
  for (let offset = 0; offset < WEEKDAYS.length; offset++) {
    const index = (start + offset) % WEEKDAYS.length;
    const day = WEEKDAYS[index]!;
    const intervals = config.hours[day];
    const isToday = offset === 0;
    const isClosed = intervals.length === 0;
    const rowClass = `hours-row${isToday ? " is-today" : ""}${isClosed ? " is-closed" : ""}`;
    const currentAttr = isToday ? ' aria-current="date"' : "";
    const value = isClosed
      ? `<span class="badge-closed">${escapeHtml(dictionary["closed"] ?? "Closed")}</span>`
      : intervals
          .map(
            ([from, to]) =>
              `<span class="hours-slot" dir="ltr">${escapeHtml(from)}–${escapeHtml(to)}</span>`,
          )
          .join('<span class="hours-sep">, </span>');
    rows.push(
      `<div class="${rowClass}"${currentAttr}><dt><span class="day-dot" aria-hidden="true"></span><span class="day-name">${escapeHtml(dictionary[DAY_KEYS[index]!] ?? day)}</span></dt><dd>${value}</dd></div>`,
    );
  }
  return `<dl class="hours">${rows.join("")}</dl>`;
}

function languagePicker(locale: Language, t: (key: string) => string): string {
  const options = (Object.keys(LANGUAGE_NAMES) as Language[])
    .map(
      (code) =>
        `<option value="${code}"${code === locale ? " selected" : ""} lang="${code}">${escapeHtml(LANGUAGE_NAMES[code])}</option>`,
    )
    .join("");
  // A GET form needs no script; with JS the change is applied immediately.
  return `<form class="language-picker" method="get">
<label class="sr-only" for="booking-language">${t("language")}</label>
<select id="booking-language" name="lang">${options}</select>
<noscript><button class="ghost small" type="submit">${t("applyLanguage")}</button></noscript>
</form>`;
}

export function renderClinicPage(
  row: ClinicRow,
  context: PageContext,
  locale: Language,
): { html: string; nonce: string } {
  const dictionary = DICTIONARIES[locale];
  const config = configFromRow(row);
  const nonce = randomNonce();
  const t = (key: string): string => escapeHtml(dictionary[key] ?? key);
  const today = zoneDate(context.nowMs, config.timeZone);
  const todayWeekday = weekdayOf(today);
  const maxDate = addDays(today, 90);

  const intakeSection = config.enabled
    ? `<section class="card intake-card">
<form id="booking-form" novalidate>
<div class="reassurance-bar">
<span class="reassurance-icon" aria-hidden="true">${ICON_INFO}</span>
<p>${t("notConfirmed")}</p>
</div>

<fieldset class="form-step">
<legend class="step-legend"><span class="step-badge" aria-hidden="true">1</span><span class="step-title">${t("yourDetails")}</span></legend>
<div class="step-body">
<div class="row row-2">
<div class="field">
<label for="name">${t("name")} <span class="req-mark" aria-hidden="true">*</span></label>
<input id="name" name="name" type="text" autocomplete="name" maxlength="100" required aria-describedby="err-name">
<div class="field-error" id="err-name" data-error-for="name" role="alert"></div>
</div>

<div class="field">
<label for="phone">${t("phone")} <span class="req-mark" aria-hidden="true">*</span></label>
<input id="phone" name="phone" type="tel" dir="ltr" inputmode="tel" autocomplete="tel" placeholder="${escapeHtml(config.dialCode)}" required aria-describedby="phone-hint err-phone">
<span class="hint" id="phone-hint">${t("phoneHint")}</span>
<div class="field-error" id="err-phone" data-error-for="phone" role="alert"></div>
</div>
</div>

<div class="field">
<label for="email">${t("email")}</label>
<input id="email" name="email" type="email" dir="ltr" inputmode="email" autocomplete="email" maxlength="254" aria-describedby="err-email">
<div class="field-error" id="err-email" data-error-for="email" role="alert"></div>
</div>

<div class="field">
<label for="note">${t("note")}</label>
<textarea id="note" name="note" rows="3" maxlength="600" aria-describedby="note-hint err-note"></textarea>
<span class="hint" id="note-hint">${t("notePrivacy")}</span>
<div class="field-error" id="err-note" data-error-for="note" role="alert"></div>
</div>
</div>
</fieldset>

<fieldset class="form-step">
<legend class="step-legend"><span class="step-badge" aria-hidden="true">2</span><span class="step-title">${t("whenCanYouCome")}</span></legend>
<div class="step-body">
<div class="choices" role="radiogroup" aria-label="${t("whenCanYouCome")}">
<label class="choice-pill"><input type="radio" name="preference-kind" value="exact" checked><span class="choice-label">${t("exactDate")}</span></label>
<label class="choice-pill"><input type="radio" name="preference-kind" value="range"><span class="choice-label">${t("dateRange")}</span></label>
<label class="choice-pill"><input type="radio" name="preference-kind" value="weekday"><span class="choice-label">${t("weekdayOption")}</span></label>
</div>

<div id="exact-fields" class="pref-panel">
<div class="row row-3">
<div class="field">
<label for="exact-date">${t("exactDate")}</label>
<input id="exact-date" type="date" min="${today}" max="${maxDate}" value="${today}" aria-describedby="err-preference">
</div>
<div class="field">
<label for="exact-from">${t("from")}</label>
<input id="exact-from" type="time" value="09:00" aria-describedby="err-preference">
</div>
<div class="field">
<label for="exact-to">${t("to")}</label>
<input id="exact-to" type="time" value="17:00" aria-describedby="err-preference">
</div>
</div>
</div>

<div id="range-fields" class="pref-panel" hidden>
<div class="row row-2">
<div class="field">
<label for="range-start">${t("startDate")}</label>
<input id="range-start" type="date" min="${today}" max="${maxDate}" value="${today}" aria-describedby="err-preference">
</div>
<div class="field">
<label for="range-end">${t("endDate")}</label>
<input id="range-end" type="date" min="${today}" max="${maxDate}" value="${maxDate}" aria-describedby="err-preference">
</div>
<div class="field">
<label for="range-from">${t("from")}</label>
<input id="range-from" type="time" value="09:00" aria-describedby="err-preference">
</div>
<div class="field">
<label for="range-to">${t("to")}</label>
<input id="range-to" type="time" value="17:00" aria-describedby="err-preference">
</div>
</div>
</div>

<div id="weekday-fields" class="pref-panel" hidden>
<div class="row row-2">
<div class="field">
<label for="weekday">${t("dayOfWeek")}</label>
<select id="weekday" aria-describedby="weekday-summary err-preference">
<option value="1">${t("weekday1")}</option>
<option value="2">${t("weekday2")}</option>
<option value="3">${t("weekday3")}</option>
<option value="4">${t("weekday4")}</option>
<option value="5">${t("weekday5")}</option>
<option value="6">${t("weekday6")}</option>
<option value="7">${t("weekday7")}</option>
</select>
</div>
<div class="field">
<label for="weeks">${t("numberOfWeeks")}</label>
<select id="weeks" aria-describedby="weekday-summary err-preference"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option><option value="4">4</option></select>
</div>
<div class="field">
<label for="weekday-from">${t("from")}</label>
<input id="weekday-from" type="time" value="09:00" aria-describedby="err-preference">
</div>
<div class="field">
<label for="weekday-to">${t("to")}</label>
<input id="weekday-to" type="time" value="17:00" aria-describedby="err-preference">
</div>
</div>
<p class="hint weekday-summary-chip" id="weekday-summary" aria-live="polite"></p>
</div>
<div class="field-error" id="err-preference" data-error-for="preference" role="alert"></div>
</div>
</fieldset>

<div class="form-step step-finalize">
<div class="step-legend"><span class="step-badge" aria-hidden="true">3</span><span class="step-title">${t("sendRequest")}</span></div>
<div class="step-body">
<div class="consent-box">
<div class="consent-row">
<input id="consent" type="checkbox" required aria-describedby="err-consentAccepted">
<label for="consent">${t("consent")} — <a href="/privacy?lang=${locale}">${t("privacyNotice")}</a></label>
</div>
<div class="field-error" id="err-consentAccepted" data-error-for="consentAccepted" role="alert"></div>
</div>

<div id="turnstile" class="turnstile-slot"${context.turnstileSiteKey ? ' data-sitekey="active"' : ""}></div>
<div class="field-error form-error-banner" id="form-error" role="alert" aria-live="assertive" hidden></div>
<noscript><style nonce="${nonce}">#submit{display:none}</style><p class="notice noscript-notice" role="status">${t("noscript")}</p></noscript>
<button class="primary" id="submit" type="submit">${t("sendRequest")}</button>
</div>
</div>
</form>
<div id="receipt" class="receipt" role="status" aria-live="polite" hidden>
<div class="receipt-header">
<span class="receipt-check" aria-hidden="true">${ICON_CHECK}</span>
<h2>${t("requestReceived")}</h2>
</div>
<div class="receipt-hero">
<span class="receipt-label">${t("reference")}</span>
<div class="receipt-code-row">
<code id="receipt-id" dir="ltr"></code>
<button class="secondary copy-button" id="copy-receipt" type="button">${t("copy")}</button>
</div>
</div>
<div class="receipt-disclaimer">
<span class="reassurance-icon" aria-hidden="true">${ICON_INFO}</span>
<p>${t("notConfirmed")}</p>
</div>
<div class="receipt-footer">
<button class="ghost" id="request-another" type="button">${t("requestAnother")}</button>
</div>
</div>
</section>`
    : `<section class="notice disabled-banner" role="status"><span class="notice-icon" aria-hidden="true">${ICON_ALERT}</span><p>${t("notAcceptingRequests")}</p></section>`;

  const metaItems: string[] = [];
  if (config.profile.address) {
    metaItems.push(
      `<p class="clinic-meta-item">${ICON_PIN}<span>${escapeHtml(config.profile.address)}</span></p>`,
    );
  }
  if (config.profile.phone) {
    metaItems.push(
      `<p class="clinic-meta-item">${ICON_PHONE}<a class="clinic-phone-link" href="tel:${escapeHtml(config.profile.phone)}" dir="ltr">${escapeHtml(config.profile.phone)}</a></p>`,
    );
  }
  const metaBlock =
    metaItems.length > 0 ? `<div class="clinic-meta">${metaItems.join("")}</div>` : "";

  const body = `<header class="clinic">
<div class="clinic-header-inner">
${languagePicker(locale, t)}
<h1>${escapeHtml(config.profile.name)}</h1>
${config.profile.welcome ? `<p class="clinic-welcome">${escapeHtml(config.profile.welcome)}</p>` : ""}
${metaBlock}
</div>
</header>
<section class="card hours-card">
<div class="section-heading">
<span class="section-icon" aria-hidden="true">${ICON_CLOCK}</span>
<h2>${t("openingHours")}</h2>
</div>
${hoursTable(row, locale, todayWeekday)}
</section>
${intakeSection}
<footer>${t("poweredBy")}</footer>`;

  const embedded = {
    apiPath: `/v1/clinics/${encodeURIComponent(row.handle)}/requests`,
    language: locale,
    consentVersion: context.consentVersion,
    turnstileSiteKey: config.enabled ? context.turnstileSiteKey : "",
    nonce,
    storageKey: `apexo-booking-receipt:${row.handle}`,
    i18n: dictionary,
  };
  const script = `<script nonce="${nonce}">window.__BOOKING__=${safeJson(embedded)}</script>
<script nonce="${nonce}" src="${assetPath("booking.js")}"></script>`;

  return {
    html: shell({
      locale,
      title: config.profile.name,
      nonce,
      body,
      script,
      accent: config.profile.accentColor || undefined,
    }),
    nonce,
  };
}
