-- Round 5: Multi-channel payments, PayPal manual invoice SoD, integration hub, encrypted secrets, and OCR pipeline

DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'payments'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~* '\yprovider\y'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', v_con);
  END LOOP;
END $$;

ALTER TABLE payments
  ADD CONSTRAINT payments_provider_check CHECK (
    provider IN ('stripe', 'paypal_manual', 'paypal_auto', 'creem', 'dodo_payments', 'airwallex', 'oceanpayment')
  );

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'live')),
  ADD COLUMN IF NOT EXISTS manual_state text CHECK (
    manual_state IS NULL OR manual_state IN (
      'requested', 'invoice_sent', 'receipt_recorded', 'verified', 'rejected', 'canceled', 'underpaid', 'overpaid'
    )
  ),
  ADD COLUMN IF NOT EXISTS external_invoice_no text,
  ADD COLUMN IF NOT EXISTS external_transaction_id text,
  ADD COLUMN IF NOT EXISTS payer_email text,
  ADD COLUMN IF NOT EXISTS invoice_url text,
  ADD COLUMN IF NOT EXISTS expected_amount_cents int CHECK (expected_amount_cents IS NULL OR expected_amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS received_amount_cents int CHECK (received_amount_cents IS NULL OR received_amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS fee_amount_cents int DEFAULT 0 CHECK (fee_amount_cents IS NULL OR fee_amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS net_amount_cents int CHECK (net_amount_cents IS NULL OR net_amount_cents >= 0),
  ADD COLUMN IF NOT EXISTS evidence_media_id uuid REFERENCES media_assets(id),
  ADD COLUMN IF NOT EXISTS issued_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS recorded_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_notes text;

ALTER TABLE payments
  ADD CONSTRAINT payments_manual_verify_sod CHECK (verified_by IS NULL OR recorded_by IS DISTINCT FROM verified_by);

CREATE UNIQUE INDEX IF NOT EXISTS payments_external_tx_uniq
  ON payments(provider, external_transaction_id)
  WHERE external_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_manual_queue_idx
  ON payments(provider, manual_state, updated_at DESC)
  WHERE provider = 'paypal_manual';

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS manual_refund_ref text,
  ADD COLUMN IF NOT EXISTS evidence_media_id uuid REFERENCES media_assets(id),
  ADD COLUMN IF NOT EXISTS executed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS notes text;

CREATE UNIQUE INDEX IF NOT EXISTS refunds_manual_ref_uniq
  ON refunds(channel, manual_refund_ref)
  WHERE manual_refund_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL UNIQUE,
  domain text NOT NULL CHECK (domain IN ('payment', 'ocr', 'logistics', 'email', 'storage', 'webhook')),
  display_name text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'disabled' CHECK (
    lifecycle_state IN ('configured', 'verified', 'enabled', 'degraded', 'disabled', 'requires_approval')
  ),
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'live')),
  enabled boolean NOT NULL DEFAULT false,
  priority int NOT NULL DEFAULT 100,
  is_primary boolean NOT NULL DEFAULT false,
  is_fallback boolean NOT NULL DEFAULT false,
  requires_icp boolean NOT NULL DEFAULT false,
  compliance_status text NOT NULL DEFAULT 'pending' CHECK (
    compliance_status IN ('pending', 'approved', 'manual_only', 'requires_review', 'prohibited_aup', 'disabled_future')
  ),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_status text NOT NULL DEFAULT 'unknown' CHECK (
    health_status IN ('healthy', 'degraded', 'unconfigured', 'error', 'unknown', 'blocked')
  ),
  last_checked_at timestamptz,
  last_check_summary text,
  last_error text,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL REFERENCES integration_providers(provider_key) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  secret_name text NOT NULL,
  ciphertext bytea NOT NULL,
  masked_hint text NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_by uuid REFERENCES users(id),
  rotated_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_secrets_active_uniq
  ON integration_secrets(provider_key, environment, secret_name)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS integration_events (
  id bigserial PRIMARY KEY,
  provider_key text NOT NULL REFERENCES integration_providers(provider_key) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  event_kind text NOT NULL CHECK (
    event_kind IN (
      'config_saved', 'config_validated', 'connection_tested', 'secret_saved', 'secret_rotated',
      'secret_revoked', 'state_changed', 'webhook_received', 'ocr_executed', 'payment_sync', 'error'
    )
  ),
  status text NOT NULL CHECK (status IN ('ok', 'warn', 'error', 'blocked')),
  latency_ms int,
  cost_estimate_usd numeric(10, 6) DEFAULT 0,
  summary text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_events_provider_idx
  ON integration_events(provider_key, created_at DESC);

CREATE TABLE IF NOT EXISTS ocr_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  order_id uuid REFERENCES orders(id),
  media_id uuid REFERENCES media_assets(id),
  batch_key text,
  file_sha256 text NOT NULL,
  file_mime text NOT NULL,
  page_count int NOT NULL DEFAULT 1 CHECK (page_count >= 1),
  provider_key text NOT NULL,
  fallback_provider_key text,
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'processing', 'completed', 'needs_review', 'failed', 'canceled')
  ),
  confidence numeric(5, 4),
  raw_text text,
  raw_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  parsed_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  error_message text,
  latency_ms int,
  attempts int NOT NULL DEFAULT 0,
  is_test boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS ocr_jobs_org_idx ON ocr_jobs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ocr_jobs_media_idx ON ocr_jobs(media_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ocr_jobs_sha_idx ON ocr_jobs(org_id, file_sha256, state);

CREATE TABLE IF NOT EXISTS ocr_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ocr_jobs(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id),
  sort_index int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'merged', 'split')),
  platform text,
  supplier_name text,
  platform_order_no text,
  tracking_no text,
  item_name text NOT NULL DEFAULT '',
  sku_code text,
  color text,
  size text,
  quantity int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  unit_price_text text,
  currency text,
  order_date text,
  confidence numeric(5, 4) NOT NULL DEFAULT 0,
  field_confidences jsonb NOT NULL DEFAULT '{}'::jsonb,
  bbox jsonb,
  raw_excerpt text,
  confirmed_line_id uuid,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ocr_candidates_job_idx ON ocr_candidates(job_id, sort_index);

INSERT INTO integration_providers (
  provider_key, domain, display_name, lifecycle_state, environment, enabled, priority,
  is_primary, is_fallback, requires_icp, compliance_status, health_status, config
) VALUES
  (
    'stripe', 'payment', 'Stripe (HK Merchant)', 'enabled', 'sandbox', true, 10,
    true, false, false, 'approved', 'unknown',
    jsonb_build_object(
      'entity_region', 'HK',
      'account_type', 'individual_sole_proprietor',
      'kyc_status', 'verified',
      'payout_bank', 'ZA Bank (HK)',
      'live_checkout_verified', false,
      'live_webhook_verified', false,
      'live_payout_verified', false,
      'checkout_mode', 'redirect',
      'supported_currencies', jsonb_build_array('USD'),
      'timeout_ms', 15000,
      'max_retries', 2,
      'no_icp_required', true
    )
  ),
  (
    'paypal_manual', 'payment', 'PayPal Manual Invoice', 'enabled', 'live', true, 20,
    false, true, false, 'manual_only', 'healthy',
    jsonb_build_object(
      'account_region', 'CN',
      'account_type', 'personal_pre_2026_06_30',
      'invoice_flow', 'manual_invoice_and_verify',
      'requires_two_person_verification', true,
      'supported_currencies', jsonb_build_array('USD'),
      'no_icp_required', true
    )
  ),
  (
    'paypal_auto', 'payment', 'PayPal Orders v2 (Auto Checkout)', 'requires_approval', 'sandbox', false, 30,
    false, false, false, 'requires_review', 'blocked',
    jsonb_build_object(
      'account_type', 'personal_pre_2026_06_30',
      'requires_business_upgrade', true,
      'business_account_verified', false,
      'api_base_sandbox', 'https://api-m.sandbox.paypal.com',
      'api_base_live', 'https://api-m.paypal.com',
      'supported_currencies', jsonb_build_array('USD'),
      'timeout_ms', 15000,
      'no_icp_required', true,
      'block_reason', 'PayPal mainland personal accounts cannot enable Live REST Orders v2 Checkout until upgraded to a verified Business account.'
    )
  ),
  (
    'creem', 'payment', 'Creem (MoR)', 'requires_approval', 'sandbox', false, 90,
    false, false, false, 'prohibited_aup', 'blocked',
    jsonb_build_object(
      'aup_eligible', false,
      'eligibility_note', 'Merchant-of-Record AUP restricts service to digital goods/SaaS and prohibits offline physical inspection services without written approval.',
      'no_icp_required', true
    )
  ),
  (
    'dodo_payments', 'payment', 'Dodo Payments (MoR)', 'requires_approval', 'sandbox', false, 91,
    false, false, false, 'prohibited_aup', 'blocked',
    jsonb_build_object(
      'aup_eligible', false,
      'eligibility_note', 'Merchant-of-Record AUP targets software/digital products and excludes offline physical QC inspection services without written approval.',
      'no_icp_required', true
    )
  ),
  (
    'airwallex', 'payment', 'Airwallex (Corporate Future)', 'disabled', 'sandbox', false, 95,
    false, false, false, 'disabled_future', 'unknown',
    jsonb_build_object(
      'requires_corporate_entity', true,
      'eligibility_note', 'Reserved for future HK or Mainland corporate entity onboarding.',
      'no_icp_required', true
    )
  ),
  (
    'oceanpayment', 'payment', 'Oceanpayment (Corporate Future)', 'disabled', 'sandbox', false, 96,
    false, false, false, 'disabled_future', 'unknown',
    jsonb_build_object(
      'requires_corporate_entity', true,
      'eligibility_note', 'Reserved for future corporate gateway integration.',
      'no_icp_required', true
    )
  ),
  (
    'paddle_ocr', 'ocr', 'Self-Hosted PaddleOCR (PP-OCRv4 ONNX)', 'enabled', 'live', true, 10,
    true, false, false, 'approved', 'unknown',
    jsonb_build_object(
      'engine', 'rapidocr_onnxruntime',
      'model', 'PP-OCRv4',
      'languages', jsonb_build_array('zh', 'en'),
      'max_pages', 10,
      'max_file_mb', 15,
      'timeout_ms', 25000,
      'retention_days', 90,
      'no_icp_required', true
    )
  ),
  (
    'google_vision_ocr', 'ocr', 'Google Cloud Vision OCR', 'configured', 'live', false, 20,
    false, true, false, 'approved', 'unconfigured',
    jsonb_build_object(
      'endpoint', 'https://vision.googleapis.com/v1/images:annotate',
      'feature', 'DOCUMENT_TEXT_DETECTION',
      'free_tier_units_monthly', 1000,
      'unit_price_per_1k_usd', 1.5,
      'timeout_ms', 15000,
      'no_icp_required', true
    )
  ),
  (
    'google_docai', 'ocr', 'Google Document AI (Optional)', 'disabled', 'live', false, 30,
    false, true, false, 'approved', 'unconfigured',
    jsonb_build_object(
      'location', 'us',
      'free_tier_units_monthly', 1000,
      'unit_price_per_1k_usd', 1.5,
      'timeout_ms', 20000,
      'no_icp_required', true
    )
  ),
  (
    'kuaidi100', 'logistics', 'Kuaidi100 Tracking', 'configured', 'live', true, 10,
    true, false, false, 'approved', 'unknown',
    jsonb_build_object(
      'api_url', 'https://poll.kuaidi100.com/poll/query.do',
      'timeout_ms', 10000,
      'no_icp_required', true
    )
  ),
  (
    'postmark', 'email', 'Postmark Transactional Email', 'configured', 'live', true, 10,
    true, false, false, 'approved', 'unknown',
    jsonb_build_object(
      'api_url', 'https://api.postmarkapp.com/email',
      'timeout_ms', 10000,
      'no_icp_required', true
    )
  ),
  (
    'local_storage', 'storage', 'Local Private Object Storage', 'enabled', 'live', true, 10,
    true, false, false, 'approved', 'healthy',
    jsonb_build_object(
      'driver', 'filesystem_private',
      'max_attachment_mb', 15,
      'no_icp_required', true
    )
  ),
  (
    'outbound_webhooks', 'webhook', 'Platform Outbound Webhooks', 'configured', 'live', false, 50,
    false, false, false, 'approved', 'unknown',
    jsonb_build_object(
      'signing', 'hmac-sha256',
      'timeout_ms', 10000,
      'no_icp_required', true
    )
  )
ON CONFLICT (provider_key) DO NOTHING;
