-- 026: 9-Purpose AI Routing, Immutable Published Prompt Versions, Professional Bilingual Glossary,
-- Tenant-Isolated Translation Cache, Async Translation Jobs & Bilingual Eval Runs (TASK-192)

-- 1. Versioned Prompt Templates per Purpose (§53.8)
CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_code text NOT NULL CHECK (
    purpose_code IN (
      'SUPPORT_INBOUND_TRANSLATE',
      'SUPPORT_OUTBOUND_TRANSLATE',
      'INSPECTION_REQUIREMENT_TRANSLATE',
      'INSPECTION_FINDING_TRANSLATE',
      'REPORT_TEXT_LOCALIZE',
      'NOTIFICATION_TRANSLATE',
      'KNOWLEDGE_TRANSLATION_DRAFT',
      'CMS_TEMPLATE_TRANSLATION_DRAFT',
      'TRANSLATION_CONSISTENCY_REVIEW'
    )
  ),
  version int NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(trim(title)) >= 2),
  semantic_guidance text NOT NULL CHECK (char_length(trim(semantic_guidance)) >= 10),
  output_schema_version text NOT NULL DEFAULT 'v1',
  allowed_variables text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deprecated', 'rolled_back')),
  content_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purpose_code, version)
);

CREATE OR REPLACE FUNCTION prevent_ai_prompt_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'AI_PROMPT_VERSION_IMMUTABLE: published prompt version cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.purpose_code IS DISTINCT FROM OLD.purpose_code
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.semantic_guidance IS DISTINCT FROM OLD.semantic_guidance
      OR NEW.output_schema_version IS DISTINCT FROM OLD.output_schema_version
      OR NEW.allowed_variables IS DISTINCT FROM OLD.allowed_variables
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
      OR NEW.status NOT IN ('published', 'deprecated', 'rolled_back') THEN
      RAISE EXCEPTION 'AI_PROMPT_VERSION_IMMUTABLE: published prompt content cannot be mutated' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_prompt_versions_immutable_guard ON ai_prompt_versions;
CREATE TRIGGER ai_prompt_versions_immutable_guard
  BEFORE UPDATE OR DELETE ON ai_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_prompt_mutation();

-- 2. Purpose Routing Versions (Primary + Optional Fallback with Data Policy Parity, §53.8)
CREATE TABLE IF NOT EXISTS ai_purpose_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_code text NOT NULL CHECK (
    purpose_code IN (
      'SUPPORT_INBOUND_TRANSLATE',
      'SUPPORT_OUTBOUND_TRANSLATE',
      'INSPECTION_REQUIREMENT_TRANSLATE',
      'INSPECTION_FINDING_TRANSLATE',
      'REPORT_TEXT_LOCALIZE',
      'NOTIFICATION_TRANSLATE',
      'KNOWLEDGE_TRANSLATION_DRAFT',
      'CMS_TEMPLATE_TRANSLATION_DRAFT',
      'TRANSLATION_CONSISTENCY_REVIEW'
    )
  ),
  version int NOT NULL CHECK (version >= 1),
  auto_enabled boolean NOT NULL DEFAULT true,
  allowed_source_locales text[] NOT NULL DEFAULT ARRAY['en-US', 'zh-CN']::text[],
  allowed_target_locales text[] NOT NULL DEFAULT ARRAY['en-US', 'zh-CN']::text[],
  primary_instance_id uuid NOT NULL REFERENCES ai_provider_instances(id) ON DELETE RESTRICT,
  primary_model_id uuid NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  fallback_instance_id uuid REFERENCES ai_provider_instances(id) ON DELETE RESTRICT,
  fallback_model_id uuid REFERENCES ai_models(id) ON DELETE RESTRICT,
  prompt_version_id uuid NOT NULL REFERENCES ai_prompt_versions(id) ON DELETE RESTRICT,
  glossary_domain text NOT NULL DEFAULT 'apparel_qc',
  max_input_chars int NOT NULL DEFAULT 4000 CHECK (max_input_chars BETWEEN 64 AND 50000),
  max_output_tokens int NOT NULL DEFAULT 1500 CHECK (max_output_tokens BETWEEN 64 AND 32000),
  timeout_ms int NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  max_retries int NOT NULL DEFAULT 1 CHECK (max_retries BETWEEN 0 AND 5),
  requires_human_confirmation boolean NOT NULL DEFAULT false,
  high_risk_purpose boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deprecated', 'rolled_back')),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purpose_code, version),
  CONSTRAINT ai_purpose_routes_fallback_pair_check CHECK (
    (fallback_instance_id IS NULL AND fallback_model_id IS NULL)
    OR (fallback_instance_id IS NOT NULL AND fallback_model_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_purpose_routes_one_published_idx
  ON ai_purpose_routes (purpose_code)
  WHERE status = 'published';

CREATE OR REPLACE FUNCTION prevent_ai_route_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'AI_ROUTE_VERSION_IMMUTABLE: published purpose route cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.purpose_code IS DISTINCT FROM OLD.purpose_code
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.primary_instance_id IS DISTINCT FROM OLD.primary_instance_id
      OR NEW.primary_model_id IS DISTINCT FROM OLD.primary_model_id
      OR NEW.fallback_instance_id IS DISTINCT FROM OLD.fallback_instance_id
      OR NEW.fallback_model_id IS DISTINCT FROM OLD.fallback_model_id
      OR NEW.prompt_version_id IS DISTINCT FROM OLD.prompt_version_id
      OR NEW.status NOT IN ('published', 'deprecated', 'rolled_back') THEN
      RAISE EXCEPTION 'AI_ROUTE_VERSION_IMMUTABLE: published route definition cannot be mutated' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_purpose_routes_immutable_guard ON ai_purpose_routes;
CREATE TRIGGER ai_purpose_routes_immutable_guard
  BEFORE UPDATE OR DELETE ON ai_purpose_routes
  FOR EACH ROW EXECUTE FUNCTION prevent_ai_route_mutation();

-- 3. Professional Domain Bilingual Glossary (§53.11: glossary first, human approval required)
CREATE TABLE IF NOT EXISTS ai_glossary_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL DEFAULT 'apparel_qc',
  term_key text NOT NULL CHECK (char_length(trim(term_key)) >= 1),
  category_slug text,
  context_note text,
  source_locale text NOT NULL REFERENCES i18n_locales(code),
  source_term text NOT NULL CHECK (char_length(trim(source_term)) >= 1),
  target_locale text NOT NULL REFERENCES i18n_locales(code),
  target_term text NOT NULL CHECK (char_length(trim(target_term)) >= 1),
  disallowed_translations text[] NOT NULL DEFAULT ARRAY[]::text[],
  version int NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'deprecated')),
  author_kind text NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human', 'ai_draft')),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, term_key, source_locale, target_locale, version)
);

-- 4. Strictly Tenant-Scoped Translation Cache (§53.10: private customer content never crosses tenants)
CREATE TABLE IF NOT EXISTS ai_translation_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL UNIQUE,
  tenant_scope_key text NOT NULL CHECK (char_length(trim(tenant_scope_key)) >= 3),
  purpose_code text NOT NULL,
  source_locale text NOT NULL REFERENCES i18n_locales(code),
  target_locale text NOT NULL REFERENCES i18n_locales(code),
  source_hash text NOT NULL,
  prompt_version_id uuid NOT NULL REFERENCES ai_prompt_versions(id) ON DELETE RESTRICT,
  route_version_id uuid NOT NULL REFERENCES ai_purpose_routes(id) ON DELETE RESTRICT,
  model_id uuid NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  glossary_hash text NOT NULL,
  translated_text text NOT NULL,
  status text NOT NULL CHECK (status IN ('translated', 'ambiguous', 'needs_review')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  invalidated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_translation_cache_scope_idx
  ON ai_translation_cache (tenant_scope_key, invalidated_at, created_at DESC);

-- 5. Async Translation Jobs & Per-Field Items (§53.10)
CREATE TABLE IF NOT EXISTS ai_translation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  purpose_code text NOT NULL,
  tenant_scope_key text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  source_locale text NOT NULL REFERENCES i18n_locales(code),
  target_locale text NOT NULL REFERENCES i18n_locales(code),
  route_version_id uuid NOT NULL REFERENCES ai_purpose_routes(id) ON DELETE RESTRICT,
  prompt_version_id uuid NOT NULL REFERENCES ai_prompt_versions(id) ON DELETE RESTRICT,
  glossary_hash text NOT NULL,
  cost_center text NOT NULL CHECK (cost_center IN ('order', 'report', 'ticket', 'notification', 'operating_expense')),
  cost_attribution_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'succeeded', 'needs_review', 'failed', 'retry_wait', 'cancelled', 'stale', 'unknown_outcome')
  ),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_summary text,
  used_fallback_route boolean NOT NULL DEFAULT false,
  cache_hits int NOT NULL DEFAULT 0,
  provider_calls int NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_scope_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_translation_jobs_status_idx
  ON ai_translation_jobs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_translation_job_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ai_translation_jobs(id) ON DELETE CASCADE,
  field_id text NOT NULL CHECK (char_length(trim(field_id)) >= 1),
  source_revision int NOT NULL DEFAULT 1,
  source_hash text NOT NULL,
  source_text text NOT NULL,
  placeholders text[] NOT NULL DEFAULT ARRAY[]::text[],
  expected_target_revision int,
  candidate_text text,
  candidate_status text CHECK (candidate_status IN ('translated', 'ambiguous', 'needs_review', 'rejected')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  semantic_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  from_cache boolean NOT NULL DEFAULT false,
  invocation_id uuid REFERENCES ai_invocations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'succeeded', 'needs_review', 'failed', 'cancelled', 'stale')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, field_id)
);

-- 6. Versioned Bilingual Professional Evaluation Corpus & Regression Runs (§53.11)
CREATE TABLE IF NOT EXISTS ai_translation_eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_code text NOT NULL UNIQUE CHECK (char_length(trim(case_code)) >= 2),
  category_slug text NOT NULL DEFAULT 'apparel',
  purpose_code text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  source_locale text NOT NULL REFERENCES i18n_locales(code),
  target_locale text NOT NULL REFERENCES i18n_locales(code),
  source_text text NOT NULL,
  protected_tokens text[] NOT NULL DEFAULT ARRAY[]::text[],
  must_preserve_semantics text[] NOT NULL DEFAULT ARRAY[]::text[],
  forbidden_inferences text[] NOT NULL DEFAULT ARRAY[]::text[],
  reference_translations text[] NOT NULL DEFAULT ARRAY[]::text[],
  version int NOT NULL DEFAULT 1,
  approved_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_translation_eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_code text NOT NULL,
  route_version_id uuid NOT NULL REFERENCES ai_purpose_routes(id) ON DELETE RESTRICT,
  prompt_version_id uuid NOT NULL REFERENCES ai_prompt_versions(id) ON DELETE RESTRICT,
  model_id uuid NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  total_cases int NOT NULL CHECK (total_cases >= 0),
  passed_semantic_guards int NOT NULL CHECK (passed_semantic_guards >= 0),
  failed_semantic_guards int NOT NULL CHECK (failed_semantic_guards >= 0),
  protected_fact_errors int NOT NULL CHECK (protected_fact_errors >= 0),
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  automated_status text NOT NULL CHECK (automated_status IN ('passed', 'failed')),
  human_qa_status text NOT NULL DEFAULT 'pending_human_qa'
    CHECK (human_qa_status IN ('pending_human_qa', 'approved', 'rejected')),
  human_qa_reviewer_id uuid REFERENCES users(id),
  human_qa_notes text,
  human_qa_reviewed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
