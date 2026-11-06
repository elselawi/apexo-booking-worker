-- Keep receipt ordinals even after requests are erased or expire. No patient
-- data is retained here, and leaving the platform removes the counters too.
CREATE TABLE request_counters (
  clinic_id TEXT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
  ref_day TEXT NOT NULL,
  ref_seq INTEGER NOT NULL,
  PRIMARY KEY (clinic_id, ref_day)
);

INSERT INTO request_counters (clinic_id, ref_day, ref_seq)
  SELECT clinic_id, ref_day, MAX(ref_seq) FROM requests GROUP BY clinic_id, ref_day;
