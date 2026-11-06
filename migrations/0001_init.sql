-- Apexo online booking — initial D1 schema.
--
-- The Worker owns booking state. PocketBase only holds identity proofs and the
-- clinic's keys; nothing here syncs into the clinic's PMS.

CREATE TABLE clinics (
  clinic_id       TEXT PRIMARY KEY,
  handle          TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('live', 'suspended')),
  enabled         INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  server_url      TEXT NOT NULL UNIQUE,
  admin_key_hash  TEXT NOT NULL UNIQUE,
  inbox_key_hash  TEXT NOT NULL UNIQUE,
  key_revision    INTEGER NOT NULL DEFAULT 1,
  inbox_revision  INTEGER NOT NULL DEFAULT 0,
  profile         TEXT NOT NULL,
  time_zone       TEXT NOT NULL,
  dial_code       TEXT NOT NULL,
  hours           TEXT NOT NULL,
  closed_dates    TEXT NOT NULL DEFAULT '[]',
  staff           TEXT NOT NULL DEFAULT '[]',
  contact_email   TEXT,
  relay_key_enc   TEXT,
  notify_error_at INTEGER,
  notify_error_code TEXT,
  config_rev      INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  last_pull_at    INTEGER,
  consent_version TEXT NOT NULL DEFAULT 'booking-privacy-v1'
);

CREATE TABLE challenges (
  challenge      TEXT PRIMARY KEY,
  clinic_id      TEXT NOT NULL REFERENCES clinics(clinic_id),
  operation_hash TEXT NOT NULL,
  used_at        INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE requests (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT NOT NULL UNIQUE,
  clinic_id   TEXT NOT NULL REFERENCES clinics(clinic_id),
  idem_key    TEXT NOT NULL,
  body_hash   TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT,
  note        TEXT,
  preference  TEXT NOT NULL,
  candidate_dates TEXT NOT NULL,
  config_rev  INTEGER NOT NULL,
  from_date   TEXT NOT NULL,
  to_date     TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to   TEXT NOT NULL,
  time_zone   TEXT NOT NULL,
  staff_id    TEXT,
  staff_name  TEXT,
  language    TEXT NOT NULL,
  consent     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'handled', 'declined')),
  version     INTEGER NOT NULL DEFAULT 1,
  handled_at  INTEGER,
  linked_id   TEXT,
  UNIQUE (clinic_id, idem_key),
  CHECK (
    (status = 'pending' AND handled_at IS NULL AND linked_id IS NULL) OR
    (status = 'handled' AND handled_at IS NOT NULL AND linked_id IS NOT NULL AND length(linked_id) BETWEEN 1 AND 64) OR
    (status = 'declined' AND handled_at IS NOT NULL AND linked_id IS NULL)
  ),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_requests_clinic_status ON requests (clinic_id, status, seq DESC);
CREATE INDEX idx_requests_clinic_seq ON requests (clinic_id, seq DESC);
CREATE INDEX idx_requests_expiry ON requests (expires_at);
CREATE INDEX idx_challenges_expiry ON challenges (expires_at);

CREATE TRIGGER requests_insert_revision AFTER INSERT ON requests BEGIN
  UPDATE clinics SET inbox_revision = inbox_revision + 1 WHERE clinic_id = NEW.clinic_id;
END;
CREATE TRIGGER requests_update_revision AFTER UPDATE ON requests BEGIN
  UPDATE clinics SET inbox_revision = inbox_revision + 1 WHERE clinic_id = NEW.clinic_id;
END;
CREATE TRIGGER requests_delete_revision AFTER DELETE ON requests BEGIN
  UPDATE clinics SET inbox_revision = inbox_revision + 1 WHERE clinic_id = OLD.clinic_id;
END;

CREATE TABLE rate (
  bucket   TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Trusted per-attempt staging row. Every admission predicate lives in a
-- trigger so it is evaluated inside the same transaction as the insert.
CREATE TABLE admission_context (
  request_id  TEXT PRIMARY KEY,
  pending_cap INTEGER NOT NULL,
  quotas      TEXT NOT NULL
);

CREATE TRIGGER admission_guard BEFORE INSERT ON requests BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM admission_context WHERE request_id = NEW.request_id
  ) THEN RAISE(ABORT, 'missing_context') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM clinics WHERE clinic_id = NEW.clinic_id
      AND status = 'live' AND enabled = 1 AND config_rev = NEW.config_rev
  ) THEN RAISE(ABORT, 'config_changed') END;
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM requests WHERE clinic_id = NEW.clinic_id
      AND status = 'pending' AND expires_at > NEW.created_at
  ) >= (SELECT pending_cap FROM admission_context WHERE request_id = NEW.request_id)
  THEN RAISE(ABORT, 'queue_full') END;
END;

CREATE TRIGGER admission_quota AFTER INSERT ON requests BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM admission_context c, json_each(c.quotas) j
      JOIN rate r ON r.bucket = json_extract(j.value, '$.bucket')
    WHERE c.request_id = NEW.request_id AND r.reset_at > NEW.created_at
      AND r.count >= json_extract(j.value, '$.ceiling')
  ) THEN RAISE(ABORT, 'rate_limited') END;
  INSERT INTO rate (bucket, count, reset_at)
    SELECT json_extract(j.value, '$.bucket'), 1, json_extract(j.value, '$.reset')
    FROM admission_context c, json_each(c.quotas) j WHERE c.request_id = NEW.request_id
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE WHEN rate.reset_at <= NEW.created_at THEN 1 ELSE rate.count + 1 END,
      reset_at = excluded.reset_at;
END;
