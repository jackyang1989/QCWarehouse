UPDATE integration_providers
SET lifecycle_state = 'disabled',
    enabled = false,
    health_status = 'unknown',
    updated_at = now()
WHERE provider_key = 'paypal_manual';
