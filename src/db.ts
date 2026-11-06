import type { ClinicConfig } from "./config";
import type { WeeklyHours } from "./hours";

export interface ClinicRow {
  clinic_id: string;
  handle: string;
  status: "live" | "suspended";
  enabled: number;
  server_url: string;
  admin_key_hash: string;
  inbox_key_hash: string;
  key_revision: number;
  inbox_revision: number;
  profile: string;
  time_zone: string;
  dial_code: string;
  hours: string;
  closed_dates: string;
  contact_email: string | null;
  config_rev: number;
  created_at: number;
  last_pull_at: number | null;
  consent_version: string;
}

export interface RequestRow {
  seq: number;
  request_id: string;
  clinic_id: string;
  idem_key: string;
  body_hash: string;
  name: string;
  phone: string;
  email: string | null;
  note: string | null;
  preference: string;
  candidate_dates: string;
  config_rev: number;
  from_date: string;
  to_date: string;
  window_from: string;
  window_to: string;
  time_zone: string;
  language: string;
  consent: string;
  created_at: number;
  /** Clinic-local date of submission, `YYYY-MM-DD`. */
  ref_day: string;
  /** 1-based ordinal of this request within `ref_day` for the clinic. */
  ref_seq: number;
  expires_at: number;
  status: "pending" | "handled" | "declined";
  version: number;
  handled_at: number | null;
  linked_id: string | null;
}

export async function clinicByHandle(db: D1Database, handle: string): Promise<ClinicRow | null> {
  return db.prepare("SELECT * FROM clinics WHERE handle = ?").bind(handle).first<ClinicRow>();
}

export async function clinicById(db: D1Database, clinicId: string): Promise<ClinicRow | null> {
  return db.prepare("SELECT * FROM clinics WHERE clinic_id = ?").bind(clinicId).first<ClinicRow>();
}

export async function clinicByKeyHash(db: D1Database, hash: string): Promise<ClinicRow | null> {
  return db
    .prepare("SELECT * FROM clinics WHERE admin_key_hash = ? OR inbox_key_hash = ?")
    .bind(hash, hash)
    .first<ClinicRow>();
}

export function isAdminKey(row: ClinicRow, hash: string): boolean {
  return row.admin_key_hash === hash;
}

/** Rebuilds the validated config from the stored JSON columns. */
export function configFromRow(row: ClinicRow): ClinicConfig {
  return {
    profile: JSON.parse(row.profile) as ClinicConfig["profile"],
    timeZone: row.time_zone,
    dialCode: row.dial_code,
    hours: JSON.parse(row.hours) as WeeklyHours,
    closedDates: JSON.parse(row.closed_dates) as string[],
    contactEmail: row.contact_email,
    enabled: row.enabled === 1,
  };
}

/**
 * Human-facing reference: the clinic-local submission day plus that day’s
 * ordinal, e.g. `1106-03`. Short enough to read over the phone, meaningful
 * enough to remember, and it carries no patient data.
 */
export function requestReference(day: string, seq: number): string {
  const compact = day.replace(/-/g, "").slice(4);
  return `${compact}-${String(seq).padStart(2, "0")}`;
}

export interface RequestItem {
  seq: number;
  requestId: string;
  reference: string;
  name: string;
  phone: string;
  email: string | null;
  note: string | null;
  preference: unknown;
  candidateDates: string[];
  configRevision: number;
  fromDate: string;
  toDate: string;
  windowFrom: string;
  windowTo: string;
  timeZone: string;
  language: string;
  createdAt: number;
  expiresAt: number;
  version: number;
  status: string;
  handledAt: number | null;
  linkedId: string | null;
}

export function requestItem(row: RequestRow): RequestItem {
  return {
    seq: row.seq,
    requestId: row.request_id,
    reference: requestReference(row.ref_day, row.ref_seq),
    name: row.name,
    phone: row.phone,
    email: row.email,
    note: row.note,
    preference: JSON.parse(row.preference) as unknown,
    candidateDates: JSON.parse(row.candidate_dates) as string[],
    configRevision: row.config_rev,
    fromDate: row.from_date,
    toDate: row.to_date,
    windowFrom: row.window_from,
    windowTo: row.window_to,
    timeZone: row.time_zone,
    language: row.language,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    version: row.version,
    status: row.status,
    handledAt: row.handled_at,
    linkedId: row.linked_id,
  };
}
