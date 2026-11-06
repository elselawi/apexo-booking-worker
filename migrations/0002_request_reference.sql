-- Memorable booking references.
--
-- The 32-hex request id stays the internal key; patients get a short code made
-- from the clinic-local submission day plus that day's ordinal (`1106-03`).

ALTER TABLE requests ADD COLUMN ref_day TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN ref_seq INTEGER NOT NULL DEFAULT 0;

-- Backfill legacy rows with their UTC day and a per-day ordinal. The platform
-- had no live traffic when this migration shipped, so this is a safety net.
UPDATE requests SET
  ref_day = date(created_at / 1000, 'unixepoch'),
  ref_seq = (
    SELECT COUNT(*) FROM requests r2
    WHERE r2.clinic_id = requests.clinic_id
      AND date(r2.created_at / 1000, 'unixepoch') = date(requests.created_at / 1000, 'unixepoch')
      AND r2.seq <= requests.seq
  );

CREATE UNIQUE INDEX idx_requests_reference ON requests (clinic_id, ref_day, ref_seq);
