-- 020: Object storage foundation: object metadata, upload sessions, access audit & immutability guard (TASK-185)

CREATE TABLE IF NOT EXISTS storage_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_provider_key text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  object_version_id text,
  org_id uuid REFERENCES organizations(id),
  owner_user_id uuid REFERENCES users(id),
  purpose text NOT NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public_asset')),
  original_filename text,
  declared_mime text NOT NULL,
  detected_mime text,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  expected_sha256 text NOT NULL,
  verified_sha256 text,
  status text NOT NULL DEFAULT 'authorized' CHECK (status IN (
    'authorized', 'uploading', 'uploaded_unverified', 'ready', 'quarantined', 'failed', 'cancelled', 'archived'
  )),
  is_immutable boolean NOT NULL DEFAULT true,
  parent_object_id uuid REFERENCES storage_objects(id),
  variant_kind text NOT NULL DEFAULT 'original' CHECK (variant_kind IN (
    'original', 'normalized', 'thumbnail', 'annotated', 'video_playback', 'video_poster', 'report_pdf', 'export'
  )),
  retention_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_provider_key, bucket, object_key)
);

CREATE INDEX IF NOT EXISTS storage_objects_org_idx
  ON storage_objects (org_id, status, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS storage_objects_parent_idx
  ON storage_objects (parent_object_id) WHERE parent_object_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS storage_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES storage_objects(id),
  upload_mode text NOT NULL CHECK (upload_mode IN ('presigned_put', 'multipart')),
  provider_upload_id text,
  part_size_bytes int CHECK (part_size_bytes IS NULL OR part_size_bytes > 0),
  expected_parts int CHECK (expected_parts IS NULL OR expected_parts > 0),
  uploaded_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completing', 'completed', 'aborted', 'expired')),
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_upload_sessions_obj_idx
  ON storage_upload_sessions (object_id, status);

CREATE TABLE IF NOT EXISTS storage_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES storage_objects(id),
  actor_id uuid REFERENCES users(id),
  actor_kind text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'presign_put', 'presign_get', 'stream_read', 'range_read', 'delete_blocked', 'delete_executed', 'quarantine'
  )),
  range_header text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_access_audit_obj_idx
  ON storage_access_audit (object_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_storage_object_immutability() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ready' AND OLD.is_immutable THEN
    IF NEW.is_immutable IS DISTINCT FROM OLD.is_immutable
       OR NEW.storage_provider_key IS DISTINCT FROM OLD.storage_provider_key
       OR NEW.bucket IS DISTINCT FROM OLD.bucket
       OR NEW.object_key IS DISTINCT FROM OLD.object_key
       OR NEW.object_version_id IS DISTINCT FROM OLD.object_version_id
       OR NEW.declared_mime IS DISTINCT FROM OLD.declared_mime
       OR NEW.detected_mime IS DISTINCT FROM OLD.detected_mime
       OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
       OR NEW.verified_sha256 IS DISTINCT FROM OLD.verified_sha256
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION 'OBJECT_IMMUTABLE_NO_OVERWRITE: verified ready object metadata/digest/location cannot be mutated';
    END IF;
    IF NEW.status NOT IN ('ready', 'archived') THEN
      RAISE EXCEPTION 'OBJECT_IMMUTABLE_NO_OVERWRITE: ready object cannot transition to status %', NEW.status;
    END IF;
    IF NEW.status = 'archived' AND OLD.legal_hold THEN
      RAISE EXCEPTION 'DELETION_PROTECTED: cannot archive ready object while legal_hold is enabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS storage_objects_immutable_guard ON storage_objects;
CREATE TRIGGER storage_objects_immutable_guard
  BEFORE UPDATE ON storage_objects
  FOR EACH ROW EXECUTE FUNCTION enforce_storage_object_immutability();

CREATE OR REPLACE FUNCTION prevent_storage_object_physical_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OBJECT_IMMUTABLE_NO_DELETE: storage_objects rows cannot be physically deleted; archive logically instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS storage_objects_no_delete ON storage_objects;
CREATE TRIGGER storage_objects_no_delete
  BEFORE DELETE ON storage_objects
  FOR EACH ROW EXECUTE FUNCTION prevent_storage_object_physical_delete();
