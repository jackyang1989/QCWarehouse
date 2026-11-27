-- 025: AI Provider Instances, Encrypted Secrets, Models, Immutable Rate Versions,
-- Atomic Budget Reservations, Invocation Audit & Cost Reconciliation Ledger (TASK-191)

-- 1. Registered AI Provider Instances (§53.7)
CREATE TABLE IF NOT EXISTS ai_provider_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_key text NOT NULL UNIQUE CHECK (char_length(trim(instance_key)) >= 2),
  display_name text NOT NULL CHECK (char_length(trim(display_name)) >= 2),
  adapter_type text NOT NULL CHECK (adapter_type IN ('openai_official', 'openai_compatible')),
  api_protocol text NOT NULL CHECK (api_protocol IN ('openai_responses', 'openai_chat_completions')),
  protocol_version text NOT NULL DEFAULT 'v1',
  environment text NOT NULL CHECK (environment IN ('test', 'production')),
  base_url text NOT NULL CHECK (char_length(trim(base_url)) >= 8),
  account_or_project_id text,
  data_region_policy text NOT NULL CHECK (char_length(trim(data_region_policy)) >= 2),
  retention_policy text NOT NULL DEFAULT 'standard_api_terms',
  training_opt_out_verified boolean NOT NULL DEFAULT false,
  allowed_purposes text[] NOT NULL DEFAULT ARRAY[]::text[],
  requested_capabilities text[] NOT NULL DEFAULT ARRAY['language_translation_only']::text[]
    CHECK (requested_capabilities = ARRAY['language_translation_only']::text[]),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'tested', 'approved', 'disabled', 'archived')),
  timeout_ms int NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  max_retries int NOT NULL DEFAULT 1 CHECK (max_retries BETWEEN 0 AND 5),
  rate_limit_rpm int NOT NULL DEFAULT 60 CHECK (rate_limit_rpm BETWEEN 1 AND 10000),
  max_concurrency int NOT NULL DEFAULT 4 CHECK (max_concurrency BETWEEN 1 AND 100),
  daily_budget_cents int NOT NULL DEFAULT 1000 CHECK (daily_budget_cents >= 0),
  monthly_budget_cents int NOT NULL DEFAULT 10000 CHECK (monthly_budget_cents >= 0),
  warn_threshold_pct int NOT NULL DEFAULT 80 CHECK (warn_threshold_pct BETWEEN 1 AND 100),
  last_health_status text NOT NULL DEFAULT 'unconfigured'
    CHECK (last_health_status IN ('unconfigured', 'unknown', 'verified', 'degraded', 'error')),
  last_probe_at timestamptz,
  last_probe_summary text,
  last_probe_error_code text,
  last_probe_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Versioned Encrypted Credentials Vault for AI Instances (§53.12)
CREATE TABLE IF NOT EXISTS ai_provider_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES ai_provider_instances(id) ON DELETE CASCADE,
  secret_name text NOT NULL CHECK (secret_name IN ('api_key', 'organization_header', 'project_header')),
  version int NOT NULL CHECK (version >= 1),
  encrypted_value bytea NOT NULL,
  masked_preview text NOT NULL,
  fingerprint_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
  created_by uuid NOT NULL REFERENCES users(id),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, secret_name, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_secrets_one_active_idx
  ON ai_provider_secrets (instance_id, secret_name)
  WHERE status = 'active';

-- 3. AI Models per Instance (Provider List Sync or Manual Exact Model Registration)
CREATE TABLE IF NOT EXISTS ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES ai_provider_instances(id) ON DELETE RESTRICT,
  requested_model_id text NOT NULL CHECK (char_length(trim(requested_model_id)) >= 1),
  observed_model_snapshot text,
  source_discovery text NOT NULL DEFAULT 'manual' CHECK (source_discovery IN ('provider_list', 'manual')),
  supports_text boolean NOT NULL DEFAULT true,
  supports_structured_output boolean NOT NULL DEFAULT false,
  supports_json_object boolean NOT NULL DEFAULT false,
  supported_locales text[] NOT NULL DEFAULT ARRAY['en-US', 'zh-CN']::text[],
  max_input_tokens int NOT NULL DEFAULT 8192 CHECK (max_input_tokens BETWEEN 128 AND 1000000),
  max_output_tokens int NOT NULL DEFAULT 2048 CHECK (max_output_tokens BETWEEN 64 AND 128000),
  allowed_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  deprecated boolean NOT NULL DEFAULT false,
  last_verified_at timestamptz,
  last_test_status text NOT NULL DEFAULT 'untested' CHECK (last_test_status IN ('untested', 'passed', 'failed')),
  last_test_error_code text,
  last_test_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, requested_model_id)
);

-- 4. Immutable Versioned Rate Schedule per Model (§53.12: historic rates cannot be retroactively altered)
CREATE TABLE IF NOT EXISTS ai_model_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  version int NOT NULL CHECK (version >= 1),
  currency text NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  input_micros_per_1k_tokens bigint CHECK (input_micros_per_1k_tokens IS NULL OR input_micros_per_1k_tokens >= 0),
  output_micros_per_1k_tokens bigint CHECK (output_micros_per_1k_tokens IS NULL OR output_micros_per_1k_tokens >= 0),
  cached_input_micros_per_1k_tokens bigint CHECK (cached_input_micros_per_1k_tokens IS NULL OR cached_input_micros_per_1k_tokens >= 0),
  unknown_rate_fallback_cap_cents int CHECK (unknown_rate_fallback_cap_cents IS NULL OR unknown_rate_fallback_cap_cents >= 0),
  rate_source text NOT NULL DEFAULT 'unknown'
    CHECK (rate_source IN ('official_schedule', 'contract_rate', 'manual_unverified', 'unknown')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);

CREATE OR REPLACE FUNCTION prevent_ai_rate_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AI_RATE_VERSION_IMMUTABLE: historical AI model rate versions cannot be modified or deleted' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_model_rate_versions_immutable_guard ON ai_model_rate_versions;
CREATE TRIGGER ai_model_rate_versions_immutable_guard
  BEFORE UPDATE OR DELETE ON ai_model_rate_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_rate_version_mutation();

-- 5. Global / Instance / Purpose Budget Policies (§53.12)
CREATE TABLE IF NOT EXISTS ai_budget_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'instance', 'purpose')),
  scope_key text NOT NULL CHECK (char_length(trim(scope_key)) >= 1),
  period_type text NOT NULL CHECK (period_type IN ('daily', 'monthly')),
  hard_limit_cents int NOT NULL CHECK (hard_limit_cents >= 0),
  warn_threshold_pct int NOT NULL DEFAULT 80 CHECK (warn_threshold_pct BETWEEN 1 AND 100),
  max_single_call_cents int CHECK (max_single_call_cents IS NULL OR max_single_call_cents >= 0),
  approved boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_key, period_type)
);

-- 6. Atomic Pre-Call Budget Reservations (Concurrent-Safe Hard Cap Guard)
CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_key text NOT NULL UNIQUE,
  instance_id uuid NOT NULL REFERENCES ai_provider_instances(id) ON DELETE RESTRICT,
  model_id uuid NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  rate_version_id uuid REFERENCES ai_model_rate_versions(id) ON DELETE RESTRICT,
  purpose_code text NOT NULL,
  period_day date NOT NULL DEFAULT CURRENT_DATE,
  period_month text NOT NULL,
  reserved_cents int NOT NULL CHECK (reserved_cents >= 0),
  settled_cents int CHECK (settled_cents IS NULL OR settled_cents >= 0),
  status text NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'unknown_pending')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_budget_reservations_day_idx
  ON ai_budget_reservations (instance_id, period_day, status);
CREATE INDEX IF NOT EXISTS ai_budget_reservations_month_idx
  ON ai_budget_reservations (period_month, status);

-- 7. Sanitized AI Invocations & Usage Cost Ledger (NEVER stores raw prompts/PII/secrets)
CREATE TABLE IF NOT EXISTS ai_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_key text NOT NULL UNIQUE,
  logical_task_id uuid,
  reservation_id uuid REFERENCES ai_budget_reservations(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES ai_provider_instances(id) ON DELETE RESTRICT,
  model_id uuid REFERENCES ai_models(id) ON DELETE RESTRICT,
  rate_version_id uuid REFERENCES ai_model_rate_versions(id) ON DELETE RESTRICT,
  purpose_code text NOT NULL,
  invocation_kind text NOT NULL
    CHECK (invocation_kind IN ('connection_probe', 'model_list', 'synthetic_translation_test', 'production_translation')),
  environment text NOT NULL CHECK (environment IN ('test', 'production')),
  actor_user_id uuid REFERENCES users(id),
  entity_type text,
  entity_id uuid,
  cost_center text NOT NULL CHECK (cost_center IN ('order', 'report', 'ticket', 'notification', 'operating_expense')),
  cost_attribution_id uuid,
  source_locale text,
  target_locale text,
  provider_request_id text,
  observed_model_snapshot text,
  status text NOT NULL
    CHECK (status IN ('succeeded', 'failed', 'timeout_unknown', 'refused', 'truncated', 'invalid_output', 'budget_blocked')),
  error_code text,
  error_summary text,
  cache_hit boolean NOT NULL DEFAULT false,
  used_fallback_route boolean NOT NULL DEFAULT false,
  input_tokens int CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens int CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cached_input_tokens int CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  usage_source text NOT NULL CHECK (usage_source IN ('provider_reported', 'local_estimate', 'cache_zero', 'unknown')),
  cost_cents int CHECK (cost_cents IS NULL OR cost_cents >= 0),
  cost_status text NOT NULL CHECK (cost_status IN ('estimated', 'provider_billed', 'cache_zero', 'unknown_pending', 'reconciled')),
  currency text NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  duration_ms int CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_invocations_instance_created_idx
  ON ai_invocations (instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_invocations_purpose_created_idx
  ON ai_invocations (purpose_code, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_invocations_cost_center_idx
  ON ai_invocations (cost_center, cost_attribution_id);

-- 8. Provider Invoice / Finance Reconciliation Adjustments (separates estimates from actual billing)
CREATE TABLE IF NOT EXISTS ai_cost_reconciliation_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id uuid REFERENCES ai_invocations(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL REFERENCES ai_provider_instances(id) ON DELETE RESTRICT,
  billing_period text NOT NULL CHECK (char_length(trim(billing_period)) >= 4),
  provider_invoice_ref text,
  billed_cents int NOT NULL CHECK (billed_cents >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (char_length(currency) = 3),
  fx_rate_to_usd numeric(14,6),
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
