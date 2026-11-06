import { env, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { sha256Hex } from "../src/crypto";
import { CONSENT_VERSION } from "../src/env";
import type { ClinicConfig } from "../src/config";

export const ADMIN_KEY = "A".repeat(43);
export const INBOX_KEY = "B".repeat(43);
export const CLINIC_ID = "0123456789abcdef0123456789abcdef";
export const HANDLE = "jimclinic";
export const SERVER_URL = "https://pb.hospital-clinic.dev";

const migrations = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

export async function resetDatabase(): Promise<void> {
  // Children first: SQLite enforces the foreign keys immediately.
  for (const name of ["requests", "request_counters", "challenges", "admission_context", "rate", "clinics", "d1_migrations"]) {
    await env.DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  await applyD1Migrations(env.DB, migrations);
}

export function baseConfig(overrides: Partial<ClinicConfig> = {}): ClinicConfig {
  return {
    profile: {
      name: "Jim Dental Clinic",
      phone: "+966551234567",
      address: "12 King Fahd Rd, Riyadh",
      welcome: "We look forward to seeing you.",
      accentColor: "#0078d4",
      defaultLanguage: "en",
    },
    timeZone: "UTC",
    dialCode: "+966",
    hours: {
      mon: [["09:00", "13:00"]],
      tue: [["09:00", "13:00"]],
      wed: [],
      thu: [["09:00", "21:00"]],
      fri: [],
      sat: [["10:00", "14:00"]],
      sun: [["09:00", "13:00"]],
    },
    closedDates: [],
    contactEmail: null,
    enabled: true,
    ...overrides,
  };
}

export async function seedClinic(options: {
  config?: ClinicConfig;
  enabled?: boolean;
  status?: "live" | "suspended";
  handle?: string;
} = {}): Promise<void> {
  const config = options.config ?? baseConfig();
  const adminHash = await sha256Hex(ADMIN_KEY);
  const inboxHash = await sha256Hex(INBOX_KEY);
  await env.DB.prepare(
    `INSERT INTO clinics (
       clinic_id, handle, status, enabled, server_url, admin_key_hash, inbox_key_hash,
       key_revision, inbox_revision, profile, time_zone, dial_code, hours, closed_dates,
       contact_email, config_rev, created_at, consent_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      CLINIC_ID,
      options.handle ?? HANDLE,
      options.status ?? "live",
      options.enabled === false ? 0 : (config.enabled ? 1 : 0),
      SERVER_URL,
      adminHash,
      inboxHash,
      JSON.stringify(config.profile),
      config.timeZone,
      config.dialCode,
      JSON.stringify(config.hours),
      JSON.stringify(config.closedDates),
      config.contactEmail,
      Date.now(),
      CONSENT_VERSION,
    )
    .run();
}

export function authHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}
