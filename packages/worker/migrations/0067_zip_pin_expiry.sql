-- Keep ZIP pin expiry scans bounded without changing existing rows or pin authority.
CREATE INDEX blob_pins_zip_expiry ON blob_pins(expires_at,pin_id) WHERE purpose='zip';
