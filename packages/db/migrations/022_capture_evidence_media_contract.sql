-- 022: Capture commands, immutable evidence origin & time/author contracts, non-destructive variants,
-- purpose-scoped multi-entity links & async media processing jobs (TASK-187)

CREATE TABLE IF NOT EXISTS capture_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_key text NOT NULL UNIQUE,
  source_type text NOT NULL CHECK (
    source_type IN (
      'pc_remote_mobile', 'mobile_local_capture', 'pc_camera_capture',
      'gallery_file_import', 'customer_attachment', 'legacy_migration',
      'system_derived', 'device_test'
    )
  ),
  capture_mode text NOT NULL CHECK (capture_mode IN ('photo', 'burst', 'video', 'import', 'device_test')),
  command_status text NOT NULL DEFAULT 'issued' CHECK (
    command_status IN ('issued', 'acknowledged', 'captured', 'cancelled', 'expired', 'failed')
  ),
  evidence_purpose text NOT NULL CHECK (
    evidence_purpose IN (
      'receiving_outer', 'receiving_open', 'unmatched_package',
      'inspection_shot', 'inspection_measurement', 'inspection_defect',
      'comparison_group', 'golden_sample_baseline', 'stocktake',
      'storage_move', 'incident', 'packing_dispatch', 'after_sales',
      'customer_reference', 'device_test'
    )
  ),
  org_id uuid REFERENCES organizations(id),
  order_id uuid REFERENCES orders(id),
  package_id uuid REFERENCES packages(id),
  warehouse_item_id uuid REFERENCES warehouse_items(id),
  comparison_member_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  work_item_id uuid REFERENCES dispatch_work_items(id),
  inspection_task_id uuid REFERENCES inspection_tasks(id),
  execution_generation int CHECK (execution_generation IS NULL OR execution_generation >= 1),
  checkpoint_code text,
  measurement_attempt_id uuid,
  defect_id uuid,
  frozen_business_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  warehouse_id uuid REFERENCES warehouses(id),
  workstation_id uuid REFERENCES workstations(id),
  device_id uuid REFERENCES warehouse_devices(id),
  camera_role text,
  device_auth_generation int CHECK (device_auth_generation IS NULL OR device_auth_generation >= 1),
  control_lease_id uuid REFERENCES device_control_leases(id),
  command_issuer_user_id uuid NOT NULL REFERENCES users(id),
  capture_responsible_user_id uuid NOT NULL REFERENCES users(id),
  preset_version text,
  capture_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capture_commands_device_idx
  ON capture_commands (device_id, created_at DESC) WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS capture_commands_work_item_idx
  ON capture_commands (work_item_id, execution_generation) WHERE work_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_capture_command_context_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.command_key IS DISTINCT FROM OLD.command_key
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.capture_mode IS DISTINCT FROM OLD.capture_mode
     OR NEW.evidence_purpose IS DISTINCT FROM OLD.evidence_purpose
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.warehouse_item_id IS DISTINCT FROM OLD.warehouse_item_id
     OR NEW.comparison_member_ids IS DISTINCT FROM OLD.comparison_member_ids
     OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     OR NEW.inspection_task_id IS DISTINCT FROM OLD.inspection_task_id
     OR NEW.execution_generation IS DISTINCT FROM OLD.execution_generation
     OR NEW.checkpoint_code IS DISTINCT FROM OLD.checkpoint_code
     OR NEW.measurement_attempt_id IS DISTINCT FROM OLD.measurement_attempt_id
     OR NEW.defect_id IS DISTINCT FROM OLD.defect_id
     OR NEW.frozen_business_snapshot IS DISTINCT FROM OLD.frozen_business_snapshot
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.workstation_id IS DISTINCT FROM OLD.workstation_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.camera_role IS DISTINCT FROM OLD.camera_role
     OR NEW.device_auth_generation IS DISTINCT FROM OLD.device_auth_generation
     OR NEW.control_lease_id IS DISTINCT FROM OLD.control_lease_id
     OR NEW.command_issuer_user_id IS DISTINCT FROM OLD.command_issuer_user_id
     OR NEW.capture_responsible_user_id IS DISTINCT FROM OLD.capture_responsible_user_id
     OR NEW.preset_version IS DISTINCT FROM OLD.preset_version
     OR NEW.capture_params IS DISTINCT FROM OLD.capture_params
     OR NEW.server_issued_at IS DISTINCT FROM OLD.server_issued_at THEN
    RAISE EXCEPTION 'CAPTURE_COMMAND_FROZEN: frozen business, device, and author context of capture_commands cannot be mutated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS capture_commands_frozen_context_guard ON capture_commands;
CREATE TRIGGER capture_commands_frozen_context_guard
  BEFORE UPDATE ON capture_commands
  FOR EACH ROW EXECUTE FUNCTION prevent_capture_command_context_mutation();

CREATE TABLE IF NOT EXISTS media_evidence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_key text NOT NULL UNIQUE,
  command_id uuid REFERENCES capture_commands(id),
  burst_sequence int CHECK (burst_sequence IS NULL OR burst_sequence >= 1),
  original_object_id uuid NOT NULL UNIQUE REFERENCES storage_objects(id),
  legacy_media_asset_id uuid REFERENCES media_assets(id),
  source_type text NOT NULL CHECK (
    source_type IN (
      'pc_remote_mobile', 'mobile_local_capture', 'pc_camera_capture',
      'gallery_file_import', 'customer_attachment', 'legacy_migration',
      'system_derived', 'device_test'
    )
  ),
  source_trust_level text NOT NULL CHECK (
    source_trust_level IN (
      'system_captured', 'offline_synced', 'device_clock_skewed',
      'exif_only', 'user_declared', 'legacy_unknown', 'device_test'
    )
  ),
  evidence_purpose text NOT NULL CHECK (
    evidence_purpose IN (
      'receiving_outer', 'receiving_open', 'unmatched_package',
      'inspection_shot', 'inspection_measurement', 'inspection_defect',
      'comparison_group', 'golden_sample_baseline', 'stocktake',
      'storage_move', 'incident', 'packing_dispatch', 'after_sales',
      'customer_reference', 'device_test'
    )
  ),
  media_kind text NOT NULL CHECK (media_kind IN ('photo', 'video', 'document')),
  warehouse_id uuid REFERENCES warehouses(id),
  workstation_id uuid REFERENCES workstations(id),
  device_id uuid REFERENCES warehouse_devices(id),
  camera_role text,
  device_auth_generation int CHECK (device_auth_generation IS NULL OR device_auth_generation >= 1),
  command_issuer_user_id uuid REFERENCES users(id),
  capture_responsible_user_id uuid REFERENCES users(id),
  uploader_user_id uuid NOT NULL REFERENCES users(id),
  actual_captured_at timestamptz,
  video_started_at timestamptz,
  video_ended_at timestamptz,
  actual_duration_ms int CHECK (actual_duration_ms IS NULL OR actual_duration_ms >= 0),
  time_source text NOT NULL CHECK (
    time_source IN (
      'device_monotonic_calibrated', 'device_wall_clock', 'exif_metadata',
      'user_declared', 'legacy_migrated', 'unknown'
    )
  ),
  time_unknown_reason text,
  device_timezone text,
  device_clock_offset_ms bigint,
  clock_skew_flagged boolean NOT NULL DEFAULT false,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  server_verified_at timestamptz,
  original_sha256 text NOT NULL,
  original_size_bytes bigint NOT NULL CHECK (original_size_bytes > 0),
  original_mime text NOT NULL,
  pixel_width int CHECK (pixel_width IS NULL OR pixel_width > 0),
  pixel_height int CHECK (pixel_height IS NULL OR pixel_height > 0),
  exif_orientation int,
  processing_state text NOT NULL DEFAULT 'awaiting_upload' CHECK (
    processing_state IN (
      'awaiting_upload', 'uploaded_unverified', 'scanning', 'processing',
      'ready', 'quarantined', 'failed', 'cancelled'
    )
  ),
  original_ready boolean NOT NULL DEFAULT false,
  derivatives_ready boolean NOT NULL DEFAULT false,
  quarantine_reason text,
  late_submission_flag boolean NOT NULL DEFAULT false,
  is_business_evidence boolean NOT NULL DEFAULT true,
  retention_class text NOT NULL DEFAULT 'standard_evidence' CHECK (
    retention_class IN (
      'standard_evidence', 'report_evidence', 'unselected_reshoot',
      'quarantined_mistake', 'device_test', 'customer_attachment', 'legal_hold'
    )
  ),
  retention_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  customer_visible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_evidence_capture_time_or_reason_check CHECK (
    actual_captured_at IS NOT NULL OR time_unknown_reason IS NOT NULL
  ),
  CONSTRAINT media_evidence_device_test_non_business_check CHECK (
    (source_type <> 'device_test' AND evidence_purpose <> 'device_test') OR is_business_evidence = false
  ),
  CONSTRAINT media_evidence_import_not_system_captured_check CHECK (
    source_type NOT IN ('gallery_file_import', 'customer_attachment', 'legacy_migration')
    OR source_trust_level <> 'system_captured'
  )
);

CREATE INDEX IF NOT EXISTS media_evidence_state_idx
  ON media_evidence_records (processing_state, created_at DESC);

CREATE INDEX IF NOT EXISTS media_evidence_device_idx
  ON media_evidence_records (device_id, created_at DESC) WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_evidence_author_idx
  ON media_evidence_records (capture_responsible_user_id, created_at DESC) WHERE capture_responsible_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_media_evidence_origin_overwrite() RETURNS trigger AS $$
BEGIN
  IF NEW.capture_key IS DISTINCT FROM OLD.capture_key
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.burst_sequence IS DISTINCT FROM OLD.burst_sequence
     OR NEW.original_object_id IS DISTINCT FROM OLD.original_object_id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_trust_level IS DISTINCT FROM OLD.source_trust_level
     OR NEW.evidence_purpose IS DISTINCT FROM OLD.evidence_purpose
     OR NEW.media_kind IS DISTINCT FROM OLD.media_kind
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id
     OR NEW.workstation_id IS DISTINCT FROM OLD.workstation_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.camera_role IS DISTINCT FROM OLD.camera_role
     OR NEW.device_auth_generation IS DISTINCT FROM OLD.device_auth_generation
     OR NEW.command_issuer_user_id IS DISTINCT FROM OLD.command_issuer_user_id
     OR NEW.capture_responsible_user_id IS DISTINCT FROM OLD.capture_responsible_user_id
     OR NEW.uploader_user_id IS DISTINCT FROM OLD.uploader_user_id
     OR NEW.actual_captured_at IS DISTINCT FROM OLD.actual_captured_at
     OR NEW.video_started_at IS DISTINCT FROM OLD.video_started_at
     OR NEW.video_ended_at IS DISTINCT FROM OLD.video_ended_at
     OR NEW.actual_duration_ms IS DISTINCT FROM OLD.actual_duration_ms
     OR NEW.time_source IS DISTINCT FROM OLD.time_source
     OR NEW.time_unknown_reason IS DISTINCT FROM OLD.time_unknown_reason
     OR NEW.device_timezone IS DISTINCT FROM OLD.device_timezone
     OR NEW.device_clock_offset_ms IS DISTINCT FROM OLD.device_clock_offset_ms
     OR NEW.clock_skew_flagged IS DISTINCT FROM OLD.clock_skew_flagged
     OR NEW.server_received_at IS DISTINCT FROM OLD.server_received_at
     OR NEW.original_sha256 IS DISTINCT FROM OLD.original_sha256
     OR NEW.original_size_bytes IS DISTINCT FROM OLD.original_size_bytes
     OR NEW.original_mime IS DISTINCT FROM OLD.original_mime
     OR NEW.is_business_evidence IS DISTINCT FROM OLD.is_business_evidence THEN
    RAISE EXCEPTION 'EVIDENCE_ORIGIN_IMMUTABLE: original capture author, device, timestamps, and SHA-256 cannot be mutated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_evidence_immutable_origin_guard ON media_evidence_records;
CREATE TRIGGER media_evidence_immutable_origin_guard
  BEFORE UPDATE ON media_evidence_records
  FOR EACH ROW EXECUTE FUNCTION prevent_media_evidence_origin_overwrite();

CREATE OR REPLACE FUNCTION prevent_media_evidence_physical_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EVIDENCE_IMMUTABLE_NO_DELETE: media_evidence_records rows cannot be physically deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_evidence_no_delete ON media_evidence_records;
CREATE TRIGGER media_evidence_no_delete
  BEFORE DELETE ON media_evidence_records
  FOR EACH ROW EXECUTE FUNCTION prevent_media_evidence_physical_delete();

CREATE TABLE IF NOT EXISTS media_evidence_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES media_evidence_records(id),
  variant_kind text NOT NULL CHECK (
    variant_kind IN ('normalized', 'thumbnail', 'annotated', 'video_playback', 'video_poster')
  ),
  variant_version int NOT NULL DEFAULT 1 CHECK (variant_version >= 1),
  storage_object_id uuid NOT NULL UNIQUE REFERENCES storage_objects(id),
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  mime text NOT NULL,
  width int CHECK (width IS NULL OR width > 0),
  height int CHECK (height IS NULL OR height > 0),
  duration_ms int CHECK (duration_ms IS NULL OR duration_ms >= 0),
  transform_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_id, variant_kind, variant_version)
);

CREATE TABLE IF NOT EXISTS media_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES media_evidence_records(id),
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'org', 'order', 'package', 'warehouse_item', 'comparison_group',
      'golden_sample', 'work_item', 'inspection_task', 'measurement_attempt',
      'defect', 'stocktake', 'incident', 'shipment', 'ticket', 'report_version', 'device_test'
    )
  ),
  entity_id uuid NOT NULL,
  link_role text NOT NULL CHECK (
    link_role IN (
      'primary_capture', 'post_bind_owner', 'comparison_member',
      'qa_selected', 'report_citation', 'reshoot_replacement', 'audit_reference'
    )
  ),
  org_id uuid REFERENCES organizations(id),
  execution_generation int CHECK (execution_generation IS NULL OR execution_generation >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
  linked_by uuid NOT NULL REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS media_evidence_links_active_uniq
  ON media_evidence_links (evidence_id, entity_type, entity_id, link_role)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS media_evidence_links_entity_idx
  ON media_evidence_links (entity_type, entity_id, status);

CREATE OR REPLACE FUNCTION prevent_cross_tenant_evidence_link_rebind() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.org_id IS NOT NULL AND NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'CROSS_TENANT_EVIDENCE_FORBIDDEN: cannot reassign tenant ownership on an existing evidence link';
  END IF;
  IF NEW.status = 'active' AND NEW.org_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM media_evidence_links
      WHERE evidence_id = NEW.evidence_id
        AND status = 'active'
        AND id <> NEW.id
        AND org_id IS NOT NULL
        AND org_id <> NEW.org_id
    ) THEN
      RAISE EXCEPTION 'CROSS_TENANT_EVIDENCE_FORBIDDEN: evidence cannot simultaneously link to distinct tenant organizations';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_evidence_links_tenant_guard ON media_evidence_links;
CREATE TRIGGER media_evidence_links_tenant_guard
  BEFORE INSERT OR UPDATE ON media_evidence_links
  FOR EACH ROW EXECUTE FUNCTION prevent_cross_tenant_evidence_link_rebind();

CREATE TABLE IF NOT EXISTS media_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES media_evidence_records(id),
  job_type text NOT NULL CHECK (job_type IN ('image_derivatives', 'video_probe_poster', 'cleanup_orphan')),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter', 'cancelled')
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  last_error text,
  result_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_processing_jobs_evidence_idx
  ON media_processing_jobs (evidence_id, status, created_at DESC);
