-- 019: Staff shifts, task dispatch, execution leases, task handovers, late-evidence quarantine,
-- and DB-enforced author immutability triggers (TASK-184)

ALTER TABLE inspection_tasks
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id),
  ADD COLUMN IF NOT EXISTS workstation_id uuid REFERENCES workstations(id),
  ADD COLUMN IF NOT EXISTS planned_assignee_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS execution_generation int NOT NULL DEFAULT 1 CHECK (execution_generation >= 1),
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS required_skill_code text;

CREATE INDEX IF NOT EXISTS inspection_tasks_dispatch_idx
  ON inspection_tasks (warehouse_id, state, assignee_id);

CREATE TABLE IF NOT EXISTS staff_work_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  user_id uuid NOT NULL REFERENCES users(id),
  workstation_id uuid REFERENCES workstations(id),
  shift_date date NOT NULL,
  shift_code text NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  available_minutes int NOT NULL CHECK (available_minutes > 0 AND available_minutes <= 960),
  role_scope text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'on_leave', 'completed', 'cancelled')),
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, user_id, shift_date, shift_code)
);

CREATE INDEX IF NOT EXISTS staff_work_shifts_wh_date_idx
  ON staff_work_shifts (warehouse_id, shift_date, status);

CREATE TABLE IF NOT EXISTS dispatch_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  task_domain text NOT NULL CHECK (task_domain IN ('inspection', 'receiving', 'packing', 'qa_review', 'stocktake', 'ticket')),
  source_entity_id text NOT NULL,
  inspection_task_id uuid UNIQUE REFERENCES inspection_tasks(id),
  required_role text NOT NULL,
  required_skill_code text,
  priority int NOT NULL DEFAULT 100,
  dispatch_status text NOT NULL DEFAULT 'queued' CHECK (dispatch_status IN (
    'queued', 'assigned', 'in_progress', 'paused', 'handover_pending', 'completed', 'cancelled'
  )),
  planned_assignee_id uuid REFERENCES users(id),
  current_assignee_id uuid REFERENCES users(id),
  workstation_id uuid REFERENCES workstations(id),
  execution_generation int NOT NULL DEFAULT 1 CHECK (execution_generation >= 1),
  pause_reason text,
  paused_at timestamptz,
  sla_due_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_domain, source_entity_id)
);

CREATE INDEX IF NOT EXISTS dispatch_work_items_wh_idx
  ON dispatch_work_items (warehouse_id, dispatch_status, task_domain, priority);

CREATE TABLE IF NOT EXISTS task_execution_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES dispatch_work_items(id),
  holder_user_id uuid NOT NULL REFERENCES users(id),
  workstation_id uuid REFERENCES workstations(id),
  execution_generation int NOT NULL CHECK (execution_generation >= 1),
  lease_token_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'released', 'expired', 'revoked', 'handed_over')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz,
  ended_at timestamptz,
  end_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_task_lease
  ON task_execution_leases (work_item_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS task_execution_leases_holder_idx
  ON task_execution_leases (holder_user_id, status);

CREATE TABLE IF NOT EXISTS task_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES dispatch_work_items(id),
  from_user_id uuid REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  from_workstation_id uuid REFERENCES workstations(id),
  to_workstation_id uuid REFERENCES workstations(id),
  from_generation int NOT NULL,
  to_generation int NOT NULL,
  handover_type text NOT NULL CHECK (handover_type IN (
    'assign', 'relay', 'reassign', 'emergency_takeover', 'qa_return_reassign'
  )),
  reason text NOT NULL,
  preflight_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  initiated_by uuid NOT NULL REFERENCES users(id),
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  status text NOT NULL CHECK (status IN ('pending_acceptance', 'accepted', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_handovers_work_item_idx
  ON task_handovers (work_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS late_evidence_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES dispatch_work_items(id),
  inspection_task_id uuid REFERENCES inspection_tasks(id),
  captured_by uuid NOT NULL REFERENCES users(id),
  device_id uuid REFERENCES warehouse_devices(id),
  submitted_generation int NOT NULL,
  current_generation_at_receipt int NOT NULL,
  evidence_sha256 text NOT NULL,
  item_key text,
  component text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  quarantine_reason text NOT NULL,
  resolution_status text NOT NULL DEFAULT 'quarantined' CHECK (resolution_status IN (
    'quarantined', 'accepted_preserving_author', 'rejected_reshoot'
  )),
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS late_evidence_quarantine_work_idx
  ON late_evidence_quarantine (work_item_id, resolution_status, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_inspection_result_author_overwrite() RETURNS trigger AS $$
BEGIN
  IF OLD.recorded_by IS DISTINCT FROM NEW.recorded_by THEN
    RAISE EXCEPTION 'HISTORICAL_AUTHOR_IMMUTABLE: inspection_results.recorded_by cannot be overwritten (% -> %)', OLD.recorded_by, NEW.recorded_by;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inspection_results_author_immutable ON inspection_results;
CREATE TRIGGER inspection_results_author_immutable
  BEFORE UPDATE ON inspection_results
  FOR EACH ROW EXECUTE FUNCTION prevent_inspection_result_author_overwrite();

CREATE OR REPLACE FUNCTION prevent_quarantine_author_overwrite() RETURNS trigger AS $$
BEGIN
  IF OLD.captured_by IS DISTINCT FROM NEW.captured_by THEN
    RAISE EXCEPTION 'HISTORICAL_AUTHOR_IMMUTABLE: late_evidence_quarantine.captured_by cannot be overwritten (% -> %)', OLD.captured_by, NEW.captured_by;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quarantine_author_immutable ON late_evidence_quarantine;
CREATE TRIGGER quarantine_author_immutable
  BEFORE UPDATE ON late_evidence_quarantine
  FOR EACH ROW EXECUTE FUNCTION prevent_quarantine_author_overwrite();
