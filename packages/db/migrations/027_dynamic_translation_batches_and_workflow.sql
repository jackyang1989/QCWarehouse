-- 027: Dynamic Translation Component Workflow, Candidate Diffs, Concurrent Revision Staging & Batch Runs (TASK-193)

-- 1. Additive candidate staging, source tracking, glossary match, and job lineage on i18n_dynamic_translations (§53.9, §53.10)
ALTER TABLE i18n_dynamic_translations
  ADD COLUMN IF NOT EXISTS source_text text,
  ADD COLUMN IF NOT EXISTS purpose_code text CHECK (
    purpose_code IS NULL
    OR purpose_code IN (
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
  ADD COLUMN IF NOT EXISTS ai_job_id uuid REFERENCES ai_translation_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_job_item_id uuid REFERENCES ai_translation_job_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS candidate_text text,
  ADD COLUMN IF NOT EXISTS candidate_source_hash text,
  ADD COLUMN IF NOT EXISTS candidate_source_revision int,
  ADD COLUMN IF NOT EXISTS candidate_status text CHECK (
    candidate_status IS NULL
    OR candidate_status IN ('pending_apply', 'stale_candidate', 'applied', 'rejected')
  ),
  ADD COLUMN IF NOT EXISTS candidate_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS candidate_job_item_id uuid REFERENCES ai_translation_job_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS glossary_matched jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS i18n_dynamic_translations_job_idx
  ON i18n_dynamic_translations (ai_job_id, ai_job_item_id)
  WHERE ai_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS i18n_dynamic_translations_candidate_idx
  ON i18n_dynamic_translations (candidate_status, updated_at DESC)
  WHERE candidate_status IS NOT NULL;

-- 2. Controlled Multi-Entity Batch Translation Runs (§53.9, §53.10)
CREATE TABLE IF NOT EXISTS translation_batch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
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
  source_locale text NOT NULL REFERENCES i18n_locales(code),
  target_locale text NOT NULL REFERENCES i18n_locales(code),
  entity_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  filter_statuses text[] NOT NULL DEFAULT ARRAY[]::text[],
  only_missing_or_stale boolean NOT NULL DEFAULT true,
  protect_human_locked boolean NOT NULL DEFAULT true,
  total_items int NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  skipped_protected_items int NOT NULL DEFAULT 0 CHECK (skipped_protected_items >= 0),
  estimated_input_chars int NOT NULL DEFAULT 0 CHECK (estimated_input_chars >= 0),
  estimated_cost_cents int,
  estimate_currency text NOT NULL DEFAULT 'USD',
  estimate_disclaimer text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled')
  ),
  created_by uuid NOT NULL REFERENCES users(id),
  paused_by uuid REFERENCES users(id),
  paused_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS translation_batch_run_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES translation_batch_runs(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  field_key text NOT NULL,
  source_revision int NOT NULL DEFAULT 1 CHECK (source_revision >= 1),
  source_hash text NOT NULL,
  source_text text NOT NULL,
  expected_target_revision int,
  ai_job_id uuid REFERENCES ai_translation_jobs(id) ON DELETE SET NULL,
  ai_job_item_id uuid REFERENCES ai_translation_job_items(id) ON DELETE SET NULL,
  applied_translation_id uuid REFERENCES i18n_dynamic_translations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued',
      'running',
      'candidate_ready',
      'applied',
      'skipped_protected',
      'stale_candidate',
      'failed',
      'paused',
      'cancelled'
    )
  ),
  error_code text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, entity_type, entity_id, field_key)
);

CREATE INDEX IF NOT EXISTS translation_batch_run_items_job_idx
  ON translation_batch_run_items (ai_job_id, ai_job_item_id);

CREATE INDEX IF NOT EXISTS translation_batch_run_items_batch_status_idx
  ON translation_batch_run_items (batch_id, status);
