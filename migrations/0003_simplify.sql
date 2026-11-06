-- Simplify the booking platform: no staff selection, no push notifications.
--
-- Preferred dentists and the notification relay were removed from the product.
-- The columns are dropped so no stale patient-linked staff names survive.

ALTER TABLE requests DROP COLUMN staff_id;
ALTER TABLE requests DROP COLUMN staff_name;

ALTER TABLE clinics DROP COLUMN staff;
ALTER TABLE clinics DROP COLUMN relay_key_enc;
ALTER TABLE clinics DROP COLUMN notify_error_at;
ALTER TABLE clinics DROP COLUMN notify_error_code;
