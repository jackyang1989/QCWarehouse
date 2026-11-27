-- 021: Configurable object storage hub, encrypted instance secrets, live RW/CORS probes & legacy migration jobs (TASK-186)

CREATE TABLE IF NOT EXISTS storage_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_key text NOT NULL UNIQUE CHECK (instance_key ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  display_name text NOT NULL,
  provider_type text NOT NULL CHECK (provider_type IN ('cloudflare_r2', 'amazon_s3', 'backblaze_b2', 'generic_s3')),
  storage_role text NOT NULL CHECK (
    storage_role IN ('primary', 'secondary_failover', 'independent_backup', 'archive', 'public_assets', 'test_sandbox')
  ),
  visibility_scope text NOT NULL CHECK (visibility_scope IN ('private_evidence', 'public_assets')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  lifecycle_state text NOT NULL DEFAULT 'draft' CHECK (
    lifecycle_state IN ('draft', 'verified', 'active', 'read_only_legacy', 'disabled')
  ),
  allow_new_writes boolean NOT NULL DEFAULT false,
  allow_reads boolean NOT NULL DEFAULT true,
  endpoint_url text NOT NULL,
  region text NOT NULL DEFAULT 'auto',
  bucket text NOT NULL,
  account_identifier text,
  key_prefix text NOT NULL DEFAULT '',
  addressing_style text NOT NULL DEFAULT 'path' CHECK (addressing_style IN ('path', 'virtual_hosted')),
  public_cdn_base_url text,
  encryption_policy text NOT NULL DEFAULT 'provider_managed' CHECK (
    encryption_policy IN ('sse_s3', 'sse_kms', 'provider_managed')
  ),
  connect_timeout_ms int NOT NULL DEFAULT 5000 CHECK (connect_timeout_ms BETWEEN 500 AND 60000),
  upload_timeout_ms int NOT NULL DEFAULT 30000 CHECK (upload_timeout_ms BETWEEN 1000 AND 300000),
  max_retries int NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
  presign_put_ttl_sec int NOT NULL DEFAULT 600 CHECK (presign_put_ttl_sec BETWEEN 60 AND 900),
  presign_get_ttl_sec int NOT NULL DEFAULT 180 CHECK (presign_get_ttl_sec BETWEEN 30 AND 300),
  max_file_size_bytes bigint NOT NULL DEFAULT 2000000000 CHECK (max_file_size_bytes BETWEEN 1024 AND 5000000000),
  multipart_threshold_bytes bigint NOT NULL DEFAULT 20971520 CHECK (multipart_threshold_bytes >= 5242880),
  multipart_part_size_bytes bigint NOT NULL DEFAULT 10485760 CHECK (multipart_part_size_bytes >= 5242880),
  max_concurrent_uploads int NOT NULL DEFAULT 4 CHECK (max_concurrent_uploads BETWEEN 1 AND 16),
  allowed_mimes jsonb NOT NULL DEFAULT '["image/jpeg","image/png","image/webp","image/heic","video/mp4","video/quicktime","application/pdf"]'::jsonb,
  routing_purposes jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_cors_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
  health_status text NOT NULL DEFAULT 'unknown' CHECK (
    health_status IN ('unknown', 'verified', 'degraded', 'error', 'unconfigured')
  ),
  last_probe_at timestamptz,
  last_probe_summary text,
  last_probe_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_class text,
  last_error_message text,
  requires_icp boolean NOT NULL DEFAULT false CHECK (requires_icp = false),
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_instances_role_visibility_check CHECK (
    (storage_role = 'public_assets' AND visibility_scope = 'public_assets')
    OR (storage_role <> 'public_assets' AND visibility_scope = 'private_evidence')
  ),
  CONSTRAINT storage_instances_private_no_cdn_check CHECK (
    visibility_scope = 'public_assets' OR public_cdn_base_url IS NULL
  ),
  CONSTRAINT storage_instances_no_wildcard_cors_check CHECK (
    NOT (allowed_cors_origins ? '*')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS storage_instances_primary_env_uniq
  ON storage_instances (environment)
  WHERE storage_role = 'primary' AND lifecycle_state = 'active' AND allow_new_writes = true;

CREATE UNIQUE INDEX IF NOT EXISTS storage_instances_public_env_uniq
  ON storage_instances (environment)
  WHERE storage_role = 'public_assets' AND lifecycle_state = 'active' AND allow_new_writes = true;

CREATE UNIQUE INDEX IF NOT EXISTS storage_instances_endpoint_bucket_env_uniq
  ON storage_instances (endpoint_url, bucket, environment);

CREATE TABLE IF NOT EXISTS storage_instance_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES storage_instances(id) ON DELETE CASCADE,
  secret_name text NOT NULL CHECK (secret_name IN ('access_key_id', 'secret_access_key', 'session_token')),
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

CREATE UNIQUE INDEX IF NOT EXISTS storage_instance_secrets_active_uniq
  ON storage_instance_secrets (instance_id, secret_name)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS storage_probe_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES storage_instances(id) ON DELETE CASCADE,
  probe_kind text NOT NULL CHECK (probe_kind IN ('full_rw', 'cors_preflight', 'config_validate')),
  ok boolean NOT NULL,
  error_class text,
  latency_ms int,
  step_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text NOT NULL,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_probe_runs_instance_idx
  ON storage_probe_runs (instance_id, created_at DESC);

ALTER TABLE storage_objects
  ADD COLUMN IF NOT EXISTS storage_instance_id uuid REFERENCES storage_instances(id);

CREATE INDEX IF NOT EXISTS storage_objects_instance_idx
  ON storage_objects (storage_instance_id) WHERE storage_instance_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_storage_instance_delete_with_objects() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM storage_objects
    WHERE storage_instance_id = OLD.id OR storage_provider_key = OLD.instance_key
  ) THEN
    RAISE EXCEPTION 'STORAGE_INSTANCE_HAS_OBJECTS: storage instance % has referenced objects and cannot be deleted', OLD.instance_key;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS storage_instances_protect_delete ON storage_instances;
CREATE TRIGGER storage_instances_protect_delete
  BEFORE DELETE ON storage_instances
  FOR EACH ROW EXECUTE FUNCTION prevent_storage_instance_delete_with_objects();

CREATE TABLE IF NOT EXISTS storage_migration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key text NOT NULL UNIQUE,
  target_instance_id uuid NOT NULL REFERENCES storage_instances(id),
  phase text NOT NULL DEFAULT 'expand' CHECK (phase IN ('expand', 'migrate', 'verify', 'switch', 'contract')),
  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'running', 'paused', 'completed', 'completed_with_errors', 'rolled_back')
  ),
  batch_size int NOT NULL DEFAULT 20 CHECK (batch_size BETWEEN 1 AND 200),
  total_objects int NOT NULL DEFAULT 0,
  total_bytes bigint NOT NULL DEFAULT 0,
  migrated_objects int NOT NULL DEFAULT 0,
  verified_objects int NOT NULL DEFAULT 0,
  failed_objects int NOT NULL DEFAULT 0,
  source_reference_count int NOT NULL DEFAULT 0,
  verified_reference_count int NOT NULL DEFAULT 0,
  retain_source_copy boolean NOT NULL DEFAULT true CHECK (retain_source_copy = true),
  last_cursor text,
  last_error text,
  created_by uuid REFERENCES users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_migration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES storage_migration_jobs(id) ON DELETE CASCADE,
  source_table text NOT NULL DEFAULT 'private_files',
  source_key text NOT NULL,
  source_sha256 text NOT NULL,
  source_size_bytes bigint NOT NULL CHECK (source_size_bytes >= 0),
  source_mime text NOT NULL,
  reference_count int NOT NULL DEFAULT 0,
  target_object_id uuid REFERENCES storage_objects(id),
  target_object_key text,
  target_version_id text,
  verified_sha256 text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'migrated', 'verified', 'failed', 'rolled_back')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, source_key)
);

CREATE INDEX IF NOT EXISTS storage_migration_items_job_idx
  ON storage_migration_items (job_id, status, source_key);
