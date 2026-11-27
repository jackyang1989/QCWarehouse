-- 015: Complete employee security lifecycle & dynamic RBAC formal management

CREATE TABLE IF NOT EXISTS staff_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  employee_no text NOT NULL UNIQUE,
  work_email text NOT NULL UNIQUE,
  employment_status text NOT NULL CHECK (employment_status IN ('pending_onboarding', 'active', 'on_leave', 'offboarded')),
  account_security_status text NOT NULL CHECK (account_security_status IN ('pending_activation', 'active', 'locked', 'disabled', 'recovering')),
  preferred_locale text NOT NULL DEFAULT 'zh-CN' CHECK (preferred_locale IN ('en-US', 'zh-CN')),
  default_warehouse_id text,
  allowed_warehouse_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  mfa_enrolled_at timestamptz,
  mfa_secret_ciphertext bytea,
  recovery_code_hashes text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_login_at timestamptz,
  offboarded_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  target_email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  auth_version_snapshot int NOT NULL DEFAULT 1,
  preassigned_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  allowed_warehouse_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  locale text NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('en-US', 'zh-CN')),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired', 'superseded')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_invitations_user_idx
  ON staff_invitations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_handovers_users_idx
  ON staff_handovers (from_user_id, to_user_id, status);

CREATE TABLE IF NOT EXISTS rbac_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code text NOT NULL UNIQUE,
  display_name_zh text NOT NULL,
  display_name_en text NOT NULL,
  is_system_preset boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
  data_scope_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_custom_role_assignments (
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES rbac_roles(id),
  warehouse_scope text[] NOT NULL DEFAULT ARRAY[]::text[],
  assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS rbac_role_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES rbac_roles(id),
  version int NOT NULL CHECK (version > 0),
  permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
  change_reason text NOT NULL,
  changed_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, version)
);

INSERT INTO rbac_roles (
  role_code, display_name_zh, display_name_en, is_system_preset, status, version, permissions
) VALUES
  ('receiver', '收货员', 'Warehouse Receiver', true, 'active', 1, ARRAY['notifications.read_own','warehouse.intake','warehouse.claim_decide','warehouse.print','warehouse.move','warehouse.stocktake_entry','warehouse.incident','qc.upload_evidence','device.apply','media.read','media.upload']::text[]),
  ('inspector', '质检员', 'Quality Inspector', true, 'active', 1, ARRAY['orders.read','notifications.read_own','qc.claim_task','qc.execute','qc.upload_evidence','qc.retest','qc.submit','device.apply','device.control_lease','media.read','media.upload','media.annotate','ai.translate_field']::text[]),
  ('reviewer', '独立复核员', 'Independent QA Reviewer', true, 'active', 1, ARRAY['orders.read','notifications.read_own','qc.retest','qc.qa_reject','qc.qa_approve','qc.report_publish','catalog.review','catalog.publish_rollback','media.read','media.annotate','media.export','ai.read','ai.translate_field','ai.review_publish']::text[]),
  ('warehouse_admin', '仓库主管', 'Warehouse Administrator', true, 'active', 1, ARRAY['orders.read','notifications.read_own','warehouse.intake','warehouse.claim_decide','warehouse.print','warehouse.move','warehouse.stocktake_entry','warehouse.stocktake_approve','warehouse.freeze','warehouse.incident','qc.upload_evidence','logistics.pick_pack','logistics.quote','logistics.address_edit','logistics.dispatch','logistics.handover','logistics.tracking_correct','device.apply','device.approve','device.control_lease','device.revoke','media.read','media.upload']::text[]),
  ('support', '客户支持', 'Customer Support', true, 'active', 1, ARRAY['orders.read','orders.manual_quote','orders.scope_change','orders.cancel','tickets.manage','notifications.read_own','notifications.read_scoped','notifications.send','warehouse.incident','logistics.address_edit','logistics.tracking_correct','finance.refund_request','media.read','media.upload','media.export','ai.read','ai.translate_field']::text[]),
  ('finance', '财务专员', 'Finance Specialist', true, 'active', 1, ARRAY['orders.read','notifications.read_own','logistics.cost_read','finance.read_receivables','finance.read_cost_profit','finance.manual_receipt_record','finance.manual_receipt_verify','finance.refund_request','finance.dispute','finance.reconcile','finance.export','media.read']::text[]),
  ('template_admin', '模板配置员', 'Template Administrator', true, 'active', 1, ARRAY['notifications.read_own','catalog.edit_draft','ai.read','ai.translate_field','ai.translate_batch','ai.review_publish']::text[]),
  ('super_admin', '超级管理员', 'Super Administrator', true, 'active', 1, ARRAY['staff.read','staff.invite','staff.edit','staff.grant_roles','staff.assign_warehouse','staff.disable','staff.revoke_session','staff.recover','audit.read','orders.read','orders.manual_quote','orders.scope_change','orders.cancel','tickets.manage','customers.read_pii','customers.export','notifications.read_own','notifications.read_scoped','notifications.send','notifications.broadcast','notifications.templates','warehouse.intake','warehouse.claim_decide','warehouse.print','warehouse.move','warehouse.stocktake_entry','warehouse.stocktake_approve','warehouse.freeze','warehouse.incident','qc.claim_task','qc.execute','qc.upload_evidence','qc.retest','qc.submit','qc.qa_reject','qc.qa_approve','qc.report_publish','logistics.pick_pack','logistics.quote','logistics.address_edit','logistics.dispatch','logistics.handover','logistics.tracking_correct','logistics.cost_read','finance.read_receivables','finance.read_cost_profit','finance.manual_receipt_record','finance.manual_receipt_verify','finance.refund_request','finance.refund_approve','finance.dispute','finance.reconcile','finance.export','catalog.edit_draft','catalog.review','catalog.publish_rollback','shipping_rates.configure','legal.configure','config.configure','device.apply','device.approve','device.control_lease','device.revoke','media.read','media.upload','media.annotate','media.export','media.delete_approve','ai.read','ai.configure','ai.translate_field','ai.translate_batch','ai.review_publish','ai.export','system.integrations','system.secrets_rotate','system.outbox_retry','system.backup_run','system.recovery_approve','system.health']::text[])
ON CONFLICT (role_code) DO NOTHING;
