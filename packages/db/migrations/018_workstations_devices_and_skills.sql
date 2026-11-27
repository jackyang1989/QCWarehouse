-- 018: Workstations (Type A/B/C), Device Authorization Center, Control Leases, Calibration/Fault Logs,
-- and Inspector Skill Certifications with anti-self-approval & sellability guard foundations (TASK-183)

CREATE TABLE IF NOT EXISTS workstations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  station_code text NOT NULL UNIQUE,
  station_type text NOT NULL CHECK (station_type IN ('A_receiving', 'B_inspection_shoot', 'C_pack_handover')),
  name_zh text NOT NULL,
  name_en text NOT NULL,
  zone_id uuid REFERENCES warehouse_zones(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'disabled')),
  required_device_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workstations_warehouse_idx
  ON workstations (warehouse_id, station_type, status);

CREATE TABLE IF NOT EXISTS device_access_policies (
  warehouse_id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('manual_first_approval', 'preregistered_only', 'controlled_self_register')),
  allow_owner_self_confirm boolean NOT NULL DEFAULT false,
  max_lease_minutes int NOT NULL DEFAULT 480 CHECK (max_lease_minutes > 0 AND max_lease_minutes <= 1440),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO device_access_policies (warehouse_id, mode, allow_owner_self_confirm, max_lease_minutes)
VALUES ('*', 'manual_first_approval', false, 480)
ON CONFLICT (warehouse_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS warehouse_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  workstation_id uuid REFERENCES workstations(id),
  device_role text NOT NULL CHECK (device_role IN ('camera', 'scanner', 'scale', 'printer', 'workstation_terminal')),
  ownership_type text NOT NULL CHECK (ownership_type IN ('warehouse_owned', 'shared_terminal', 'temp_mobile')),
  manufacturer text,
  model text,
  serial_number text,
  hardware_fingerprint_hash text NOT NULL UNIQUE,
  device_secret_hash text,
  approval_status text NOT NULL CHECK (approval_status IN ('preregistered', 'pending_approval', 'approved', 'rejected', 'revoked', 'maintenance')),
  online_status text NOT NULL DEFAULT 'offline' CHECK (online_status IN ('offline', 'online', 'fault', 'calibration_expired')),
  auth_generation int NOT NULL DEFAULT 1 CHECK (auth_generation >= 1),
  capability_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  spec_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  calibration_due_at timestamptz,
  last_calibrated_at timestamptz,
  registered_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warehouse_devices_wh_idx
  ON warehouse_devices (warehouse_id, approval_status, online_status);

CREATE TABLE IF NOT EXISTS device_authorization_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  workstation_id uuid REFERENCES workstations(id),
  device_id uuid REFERENCES warehouse_devices(id),
  device_code text NOT NULL,
  device_role text NOT NULL CHECK (device_role IN ('camera', 'scanner', 'scale', 'printer', 'workstation_terminal')),
  ownership_type text NOT NULL CHECK (ownership_type IN ('warehouse_owned', 'shared_terminal', 'temp_mobile')),
  requested_by uuid NOT NULL REFERENCES users(id),
  registration_mode text NOT NULL CHECK (registration_mode IN ('manual_first_approval', 'preregistered_only', 'controlled_self_register')),
  hardware_fingerprint_hash text NOT NULL,
  request_status text NOT NULL CHECK (request_status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decision_by uuid REFERENCES users(id),
  decision_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_auth_requests_wh_idx
  ON device_authorization_requests (warehouse_id, request_status, created_at DESC);

CREATE TABLE IF NOT EXISTS device_control_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES warehouse_devices(id),
  workstation_id uuid REFERENCES workstations(id),
  holder_user_id uuid NOT NULL REFERENCES users(id),
  auth_generation int NOT NULL,
  lease_token_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'released', 'expired', 'revoked')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz,
  ended_at timestamptz,
  end_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_device
  ON device_control_leases (device_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS device_calibration_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES warehouse_devices(id),
  log_type text NOT NULL CHECK (log_type IN ('calibration', 'maintenance', 'fault_report', 'fault_resolved')),
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'open', 'resolved')),
  recorded_by uuid NOT NULL REFERENCES users(id),
  measured_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_due_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_calibration_logs_dev_idx
  ON device_calibration_logs (device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inspector_skill_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  skill_code text NOT NULL,
  category_code text,
  service_code text,
  status text NOT NULL CHECK (status IN ('pending_exam', 'active', 'suspended', 'expired', 'revoked')),
  certified_by uuid REFERENCES users(id),
  valid_until timestamptz,
  evidence_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, skill_code),
  CHECK (certified_by IS NULL OR certified_by <> user_id)
);

CREATE INDEX IF NOT EXISTS inspector_skill_grants_status_idx
  ON inspector_skill_grants (status, skill_code);
