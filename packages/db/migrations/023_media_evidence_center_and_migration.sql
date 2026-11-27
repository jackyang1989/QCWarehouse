-- 023: Global Media & Evidence Center, Export Jobs, Retention/Deletion SoD, Legacy Dual-Read Pointers,
-- Conservation Reconciliation, Cost Rate Cards, and Recovery Revocation Tombstones (TASK-188)

-- 1. Compatible dual-read storage object pointers for §40 expand -> migrate -> verify -> switch -> contract
ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS storage_object_id uuid REFERENCES storage_objects(id);

ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS thumb_storage_object_id uuid REFERENCES storage_objects(id);

CREATE INDEX IF NOT EXISTS media_assets_storage_obj_idx
  ON media_assets (storage_object_id) WHERE storage_object_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS legacy_file_storage_pointers (
  legacy_key text PRIMARY KEY,
  storage_object_id uuid NOT NULL REFERENCES storage_objects(id),
  verified_sha256 text NOT NULL,
  migration_job_id uuid REFERENCES storage_migration_jobs(id),
  switched_by uuid REFERENCES users(id),
  switched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_file_storage_pointers_job_idx
  ON legacy_file_storage_pointers (migration_job_id) WHERE migration_job_id IS NOT NULL;

-- 2. Evidence center query & idempotent legacy migration backfill indexes
CREATE UNIQUE INDEX IF NOT EXISTS media_evidence_legacy_asset_uniq
  ON media_evidence_records (legacy_media_asset_id) WHERE legacy_media_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_evidence_captured_at_idx
  ON media_evidence_records (actual_captured_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS media_evidence_created_at_idx
  ON media_evidence_records (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS media_evidence_purpose_trust_idx
  ON media_evidence_records (evidence_purpose, source_trust_level, media_kind, processing_state);

CREATE INDEX IF NOT EXISTS media_evidence_uploader_idx
  ON media_evidence_records (uploader_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS media_evidence_links_org_idx
  ON media_evidence_links (org_id, status, evidence_id) WHERE org_id IS NOT NULL;

-- 3. Controlled async private export jobs (CAP25, CAP27, §115.9)
CREATE TABLE IF NOT EXISTS media_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key text NOT NULL UNIQUE,
  requested_by uuid NOT NULL REFERENCES users(id),
  purpose_reason text NOT NULL CHECK (char_length(trim(purpose_reason)) >= 4),
  filter_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  include_originals boolean NOT NULL DEFAULT false,
  max_items int NOT NULL CHECK (max_items BETWEEN 1 AND 500),
  matched_count int NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  exported_count int NOT NULL DEFAULT 0 CHECK (exported_count >= 0),
  total_bytes bigint NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  manifest_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest_sha256 text,
  manifest_object_id uuid REFERENCES storage_objects(id),
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'running', 'completed', 'cancelled', 'failed', 'expired')
  ),
  expires_at timestamptz NOT NULL,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_export_jobs_requester_idx
  ON media_export_jobs (requested_by, created_at DESC);

-- 4. Retention, legal hold, quarantine, archival, and SoD controlled deletion requests (CAP24, CAP27)
CREATE TABLE IF NOT EXISTS media_retention_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES media_evidence_records(id),
  action_type text NOT NULL CHECK (
    action_type IN (
      'quarantine', 'release_quarantine', 'set_legal_hold', 'release_legal_hold',
      'archive', 'controlled_delete', 'restore_archived'
    )
  ),
  reason text NOT NULL CHECK (char_length(trim(reason)) >= 4),
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'cancelled')
  ),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  decision_note text,
  impact_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  executed_at timestamptz,
  execution_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_retention_requests_ev_idx
  ON media_retention_requests (evidence_id, status, created_at DESC);

-- 5. Evidence conservation reconciliation runs & anomalies (§115.10, CAP28, ST-04)
CREATE TABLE IF NOT EXISTS media_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by uuid NOT NULL REFERENCES users(id),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  anomalies_detected int NOT NULL DEFAULT 0 CHECK (anomalies_detected >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_reconciliation_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES media_reconciliation_runs(id),
  anomaly_key text NOT NULL UNIQUE,
  anomaly_type text NOT NULL CHECK (
    anomaly_type IN (
      'missing_storage_object', 'orphan_storage_object', 'legacy_pdf_hash_mismatch',
      'legacy_pdf_unmigrated', 'legacy_media_missing_provenance', 'unresolved_late_quarantine',
      'command_without_evidence', 'revoked_device_active_lease', 'cross_tenant_link_risk'
    )
  ),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  evidence_id uuid REFERENCES media_evidence_records(id),
  storage_object_id uuid REFERENCES storage_objects(id),
  report_version_id uuid REFERENCES report_versions(id),
  legacy_key text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_reconciliation_anomalies_status_idx
  ON media_reconciliation_anomalies (status, severity, created_at DESC);

-- 6. Recovery revocation tombstones preventing zombie revival after backup restore (CAP28, §115.10)
CREATE TABLE IF NOT EXISTS recovery_revocation_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'device_revocation', 'staff_session_revocation',
      'report_share_revocation', 'media_controlled_delete'
    )
  ),
  entity_id uuid NOT NULL,
  min_auth_generation int CHECK (min_auth_generation IS NULL OR min_auth_generation >= 1),
  revoked_by uuid REFERENCES users(id),
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  last_replayed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS recovery_revocation_tombstones_uniq
  ON recovery_revocation_tombstones (entity_type, entity_id, COALESCE(min_auth_generation, 0));

-- 7. Versioned storage cost rate cards for honest capacity/cost accounting (CAP26, §115.9)
CREATE TABLE IF NOT EXISTS storage_cost_rate_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_instance_id uuid REFERENCES storage_instances(id),
  currency text NOT NULL DEFAULT 'USD' CHECK (char_length(trim(currency)) >= 3),
  rate_version text NOT NULL,
  storage_gb_month_cents numeric(12,4) NOT NULL CHECK (storage_gb_month_cents >= 0),
  egress_gb_cents numeric(12,4) CHECK (egress_gb_cents IS NULL OR egress_gb_cents >= 0),
  class_a_per_million_cents numeric(12,4) CHECK (class_a_per_million_cents IS NULL OR class_a_per_million_cents >= 0),
  class_b_per_million_cents numeric(12,4) CHECK (class_b_per_million_cents IS NULL OR class_b_per_million_cents >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_cost_rate_cards_eff_idx
  ON storage_cost_rate_cards (storage_instance_id, effective_from DESC);
