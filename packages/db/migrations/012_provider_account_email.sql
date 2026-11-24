ALTER TABLE auth_identities ADD COLUMN provider_email varchar(320);
ALTER TABLE pending_registrations ADD COLUMN provider_email varchar(320);
