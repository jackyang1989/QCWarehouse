ALTER TABLE email_deliveries ADD COLUMN provider text CHECK (provider IN ('postmark', 'resend'));

UPDATE email_deliveries
SET provider = 'postmark'
WHERE (provider_message_id IS NOT NULL AND provider_message_id NOT LIKE 'demo-%')
   OR error_code IN ('REQUEST_TIMEOUT', 'NETWORK_ERROR', 'INACTIVE_RECIPIENT')
   OR left(error_code, 9) = 'POSTMARK_';

CREATE INDEX email_deliveries_provider_message_idx ON email_deliveries (provider, provider_message_id);

UPDATE integration_providers
SET is_primary = false, is_fallback = true, priority = 20
WHERE provider_key = 'postmark';

INSERT INTO integration_providers (
  provider_key, domain, display_name, lifecycle_state, environment, enabled, priority,
  is_primary, is_fallback, requires_icp, compliance_status, health_status, config
) VALUES (
  'resend', 'email', 'Resend', 'configured', 'live', false, 10, true, false, false, 'approved', 'unconfigured',
  '{"from_email": "", "no_icp_required": true}'
) ON CONFLICT (provider_key) DO NOTHING;
