-- 028: Unified Communication Foundation, Notification Masters/Recipients/Deliveries/Attempts,
-- Basic Ticket Locale/Dedupe Extensions, Bilingual Event Templates, and Legacy Idempotent Backfill (TASK-194)

CREATE TABLE IF NOT EXISTS notification_masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('auto_event', 'manual_targeted', 'announcement', 'security_alert')),
  event_type text NOT NULL,
  event_id text,
  entity_type text NOT NULL,
  entity_id text,
  entity_version int NOT NULL DEFAULT 1 CHECK (entity_version > 0),
  template_code text NOT NULL,
  template_version int,
  locale text NOT NULL CHECK (locale IN ('en-US', 'zh-CN')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  title_snapshot text,
  body_snapshot text,
  cta_path text,
  content_origin text NOT NULL DEFAULT 'template_snapshot' CHECK (content_origin IN ('template_snapshot', 'explicit_snapshot', 'legacy_unknown')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'scheduled', 'published', 'delivering', 'completed', 'partial_failure', 'failed', 'cancelled', 'suppressed')),
  created_by uuid REFERENCES users(id),
  scheduled_at timestamptz,
  published_at timestamptz,
  cancelled_at timestamptz,
  is_test boolean NOT NULL DEFAULT false,
  migrated_from_legacy_id uuid UNIQUE REFERENCES notifications(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_masters_event_created_idx
  ON notification_masters (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS notification_masters_entity_idx
  ON notification_masters (entity_type, entity_id)
  WHERE entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notification_masters(id) ON DELETE CASCADE,
  legacy_notification_id uuid UNIQUE REFERENCES notifications(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('customer', 'staff')),
  org_id uuid REFERENCES organizations(id),
  category text NOT NULL DEFAULT 'system' CHECK (category IN ('orders', 'reports', 'parcels', 'billing', 'support', 'security', 'system', 'announcements')),
  locale text NOT NULL CHECK (locale IN ('en-US', 'zh-CN')),
  title_snapshot text,
  body_snapshot text,
  cta_path text,
  associated_todo_kind text,
  associated_todo_id text,
  read_at timestamptz,
  archived_at timestamptz,
  retracted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS notification_recipients_inbox_idx
  ON notification_recipients (recipient_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS notification_recipients_unread_idx
  ON notification_recipients (recipient_user_id)
  WHERE read_at IS NULL AND retracted_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_channel_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notification_masters(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES notification_recipients(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'whatsapp')),
  channel_instance_key text,
  template_code text NOT NULL,
  template_version int,
  rendered_locale text CHECK (rendered_locale IS NULL OR rendered_locale IN ('en-US', 'zh-CN')),
  rendered_subject text,
  rendered_body text,
  content_origin text NOT NULL DEFAULT 'template_snapshot' CHECK (content_origin IN ('template_snapshot', 'explicit_snapshot', 'legacy_unknown')),
  masked_contact text,
  contact_ciphertext bytea,
  state text NOT NULL CHECK (state IN ('queued', 'submitted', 'delivered', 'read', 'deferred', 'bounced', 'complained', 'suppressed', 'failed', 'unknown', 'cancelled')),
  provider text,
  provider_message_id text,
  legacy_email_delivery_id uuid UNIQUE REFERENCES email_deliveries(id),
  error_code text,
  error_detail text,
  is_test boolean NOT NULL DEFAULT false,
  queued_at timestamptz,
  submitted_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_id, channel)
);

CREATE INDEX IF NOT EXISTS notification_channel_deliveries_state_idx
  ON notification_channel_deliveries (channel, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_delivery_id uuid NOT NULL REFERENCES notification_channel_deliveries(id) ON DELETE CASCADE,
  attempt_no int NOT NULL CHECK (attempt_no > 0),
  idempotency_key text NOT NULL UNIQUE,
  provider text,
  state text NOT NULL,
  provider_message_id text,
  provider_event_id text,
  error_code text,
  response_summary text,
  retry_by uuid REFERENCES users(id),
  retry_reason text,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_delivery_id, attempt_no)
);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS original_locale text NOT NULL DEFAULT 'en-US' CHECK (original_locale IN ('en-US', 'zh-CN'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'portal';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_dedupe_key_unique_idx
  ON tickets (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS original_locale text CHECK (original_locale IS NULL OR original_locale IN ('en-US', 'zh-CN'));

INSERT INTO notification_templates (
  template_code, locale, version, status, subject_template, body_template, allowed_variables, published_at
) VALUES
  ('owner.legal_entity_activated', 'en-US', 1, 'published', 'Default legal entity activated{ref}', 'A legal entity configuration{ref} has been activated for new orders. Review details at {link}.', '["ref","link"]'::jsonb, now()),
  ('owner.legal_entity_activated', 'zh-CN', 1, 'published', '默认经营主体已启用{ref}', '新的默认经营主体{ref}已启用生效，可前往 {link} 核对主体与商户配置。', '["ref","link"]'::jsonb, now()),
  ('owner.legal_entity_retired', 'en-US', 1, 'published', 'Legal entity retired{ref}', 'A legal entity{ref} has been retired. Review governance records at {link}.', '["ref","link"]'::jsonb, now()),
  ('owner.legal_entity_retired', 'zh-CN', 1, 'published', '经营主体已退役{ref}', '经营主体{ref}已标记为退役归档。请前往 {link} 查看记录。', '["ref","link"]'::jsonb, now()),
  ('owner.merchant_instance_changed', 'en-US', 1, 'published', 'Merchant instance configuration updated{ref}', 'A payment merchant instance{ref} has been created or transitioned. Review status at {link}.', '["ref","link"]'::jsonb, now()),
  ('owner.merchant_instance_changed', 'zh-CN', 1, 'published', '收款商户实例已变更{ref}', '收款商户实例{ref}已新增或变更状态。请前往 {link} 核对配置。', '["ref","link"]'::jsonb, now()),
  ('staff.activated', 'en-US', 1, 'published', 'Staff account activated{ref}', 'Your QC Warehouse staff account{ref} is now active with MFA enabled. Open {link} to enter your workspace.', '["ref","link"]'::jsonb, now()),
  ('staff.activated', 'zh-CN', 1, 'published', '员工账号已激活{ref}', '您的 QC Warehouse 员工账号{ref}已完成密码与 MFA 激活。请访问 {link} 进入工作台。', '["ref","link"]'::jsonb, now()),
  ('staff.sessions_revoked', 'en-US', 1, 'published', 'Active sessions revoked{ref}', 'All active staff sessions{ref} were revoked by an administrator. Sign in again at {link} if needed.', '["ref","link"]'::jsonb, now()),
  ('staff.sessions_revoked', 'zh-CN', 1, 'published', '员工会话已全部吊销{ref}', '管理员已吊销您账号{ref}的全部在线会话。如需继续操作请前往 {link} 重新登录。', '["ref","link"]'::jsonb, now()),
  ('staff.offboarded', 'en-US', 1, 'published', 'Staff offboarding recorded{ref}', 'An employee offboarding action{ref} has been recorded with audit history preserved. Review staff directory at {link}.', '["ref","link"]'::jsonb, now()),
  ('staff.offboarded', 'zh-CN', 1, 'published', '员工离职与交接已生效{ref}', '员工离职与会话撤销{ref}已执行并保留历史作者归属。请前往 {link} 查看详情。', '["ref","link"]'::jsonb, now()),
  ('staff.handover_assigned', 'en-US', 1, 'published', 'Work handover assigned{ref}', 'Offboarding handover items{ref} have been assigned to you. Open {link} to review assigned responsibilities.', '["ref","link"]'::jsonb, now()),
  ('staff.handover_assigned', 'zh-CN', 1, 'published', '有待接收的离职工作交接{ref}', '您有新的离职交接事项{ref}待跟进。请前往 {link} 查看具体对象与范围。', '["ref","link"]'::jsonb, now()),
  ('staff.role_changed', 'en-US', 1, 'published', 'Staff role permissions updated{ref}', 'Your assigned roles or scope{ref} have been updated. Review your active permissions at {link}.', '["ref","link"]'::jsonb, now()),
  ('staff.role_changed', 'zh-CN', 1, 'published', '员工岗位权限已更新{ref}', '您的员工角色或作用域配置{ref}已变更。请前往 {link} 查看生效权限。', '["ref","link"]'::jsonb, now()),
  ('ticket.created', 'en-US', 1, 'published', 'New support case created{ref}', 'A new support case{ref} has been created and queued for review. Open {link} to respond.', '["ref","link"]'::jsonb, now()),
  ('ticket.created', 'zh-CN', 1, 'published', '有新的客服工单待处理{ref}', '收到新的客服工单或补充说明{ref}。请前往 {link} 查看与处理。', '["ref","link"]'::jsonb, now()),
  ('ticket.customer_replied', 'en-US', 1, 'published', 'Customer replied on support case{ref}', 'The customer posted a new message on support case{ref}. Review and reply at {link}.', '["ref","link"]'::jsonb, now()),
  ('ticket.customer_replied', 'zh-CN', 1, 'published', '客户已回复客服工单{ref}', '客户在工单{ref}中提交了新的补充回复。请前往 {link} 查看并跟进。', '["ref","link"]'::jsonb, now()),
  ('email.delivery_failed', 'en-US', 1, 'published', 'We could not deliver email to your address{ref}', 'Email delivery to your primary address failed{ref}. Please review or update your email status at {link}.', '["ref","link"]'::jsonb, now()),
  ('email.delivery_failed', 'zh-CN', 1, 'published', '主邮箱邮件投递失败提醒{ref}', '系统向您的主邮箱发送事务通知失败并已触发退信保护{ref}。请前往 {link} 核对邮箱状态。', '["ref","link"]'::jsonb, now()),
  ('email.channel_degraded', 'en-US', 1, 'published', 'Transactional email channel degraded{ref}', 'One or more email deliveries entered unknown or deferred state{ref}. Inspect channel health at {link}.', '["ref","link"]'::jsonb, now()),
  ('email.channel_degraded', 'zh-CN', 1, 'published', '事务邮件投递通道异常告警{ref}', '检测到邮件投递超时未知或延迟异常{ref}。请前往 {link} 核查通道与尝试日志。', '["ref","link"]'::jsonb, now())
ON CONFLICT (template_code, locale, version) DO NOTHING;

-- Idempotent migration of legacy notifications into unified communication master/recipient/channel tables (T125 / COM22)
INSERT INTO notification_masters (
  source_kind, event_type, entity_type, entity_id, entity_version, template_code, template_version,
  locale, priority, content_origin, metadata, dedupe_key, status, published_at, is_test, migrated_from_legacy_id, created_at, updated_at
)
SELECT
  CASE
    WHEN n.template IN ('email.delivery_failed', 'email.channel_degraded', 'account.security_alert', 'staff.sessions_revoked') THEN 'security_alert'
    ELSE 'auto_event'
  END,
  n.template,
  CASE
    WHEN n.order_id IS NOT NULL THEN 'orders'
    WHEN n.payload ? 'ticket_id' THEN 'tickets'
    WHEN n.payload ? 'package_id' THEN 'packages'
    WHEN n.payload ? 'shipment_id' THEN 'shipments'
    WHEN n.payload ? 'device_id' THEN 'warehouse_devices'
    ELSE 'notifications'
  END,
  COALESCE(
    n.order_id::text,
    n.payload->>'ticket_id',
    n.payload->>'package_id',
    n.payload->>'shipment_id',
    n.payload->>'device_id',
    n.payload->>'charge_id',
    n.payload->>'invitation_id',
    n.id::text
  ),
  1,
  n.template,
  NULL,
  CASE WHEN n.locale IN ('zh-CN', 'zh') THEN 'zh-CN' ELSE 'en-US' END,
  CASE WHEN n.template IN ('email.delivery_failed', 'email.channel_degraded', 'order.identity_mismatch') THEN 'high' ELSE 'normal' END,
  'legacy_unknown',
  COALESCE(n.payload, '{}'::jsonb) - 'previous_email' - 'new_email' - 'contact_email' - 'email' - 'activation_token' - 'raw_token' - 'secret' - 'token',
  CASE
    WHEN n.template = 'email.delivery_failed' THEN 'email.delivery_failed:' || COALESCE(n.user_id::text, '') || ':' || left(encode(sha256(n.dedupe_key::bytea), 'hex'), 16)
    ELSE n.dedupe_key
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM email_deliveries d WHERE d.notification_id = n.id AND d.state IN ('bounced', 'complained')) THEN 'partial_failure'
    WHEN EXISTS (SELECT 1 FROM email_deliveries d WHERE d.notification_id = n.id AND d.state IN ('unknown', 'deferred', 'queued')) THEN 'delivering'
    ELSE 'completed'
  END,
  COALESCE(n.created_at, now()),
  false,
  n.id,
  COALESCE(n.created_at, now()),
  COALESCE(n.created_at, now())
FROM notifications n
WHERE n.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO notification_recipients (
  notification_id, legacy_notification_id, recipient_user_id, recipient_kind, org_id,
  category, locale, read_at, created_at
)
SELECT
  nm.id,
  n.id,
  n.user_id,
  CASE WHEN crp.org_id IS NOT NULL THEN 'customer' ELSE 'staff' END,
  crp.org_id,
  CASE
    WHEN n.template LIKE 'order.%' THEN 'orders'
    WHEN n.template LIKE 'report.%' THEN 'reports'
    WHEN n.template LIKE 'package.%' OR n.template LIKE 'tracking.%' OR n.template LIKE 'shipment.%' OR n.template = 'reference.sealed' THEN 'parcels'
    WHEN n.template LIKE 'payment.%' OR n.template LIKE 'refund.%' OR n.template LIKE '%.quoted' OR n.template = 'quote.offered' OR n.template LIKE 'owner.merchant%' THEN 'billing'
    WHEN n.template LIKE 'ticket.%' OR n.template LIKE 'incident.%' OR n.template IN ('email.delivery_failed', 'account.registered') THEN 'support'
    WHEN n.template IN ('email.channel_degraded', 'staff.sessions_revoked', 'account.security_alert', 'staff.invited', 'staff.activated', 'staff.offboarded', 'staff.role_changed') THEN 'security'
    ELSE 'system'
  END,
  CASE WHEN n.locale IN ('zh-CN', 'zh') THEN 'zh-CN' ELSE 'en-US' END,
  n.read_at,
  COALESCE(n.created_at, now())
FROM notifications n
JOIN notification_masters nm ON nm.migrated_from_legacy_id = n.id
LEFT JOIN LATERAL (
  SELECT p.org_id FROM customer_receiving_profiles p WHERE p.user_id = n.user_id LIMIT 1
) crp ON true
WHERE n.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO notification_channel_deliveries (
  notification_id, recipient_id, recipient_user_id, channel, template_code,
  rendered_locale, content_origin, state, delivered_at, read_at, created_at, updated_at
)
SELECT
  nr.notification_id,
  nr.id,
  nr.recipient_user_id,
  'in_app',
  nm.template_code,
  nr.locale,
  'legacy_unknown',
  CASE WHEN nr.read_at IS NOT NULL THEN 'read' ELSE 'delivered' END,
  nr.created_at,
  nr.read_at,
  nr.created_at,
  COALESCE(nr.read_at, nr.created_at)
FROM notification_recipients nr
JOIN notification_masters nm ON nm.id = nr.notification_id
ON CONFLICT DO NOTHING;

INSERT INTO notification_channel_deliveries (
  notification_id, recipient_id, recipient_user_id, channel, template_code, template_version,
  rendered_locale, content_origin, state, provider, provider_message_id, legacy_email_delivery_id,
  error_code, queued_at, submitted_at, delivered_at, failed_at, created_at, updated_at
)
SELECT
  nr.notification_id,
  nr.id,
  nr.recipient_user_id,
  'email',
  nm.template_code,
  d.template_version,
  CASE WHEN d.locale IN ('zh-CN', 'zh') THEN 'zh-CN' WHEN d.locale IN ('en-US', 'en') THEN 'en-US' ELSE nr.locale END,
  'legacy_unknown',
  CASE
    WHEN d.error_code = 'ADDRESS_SUPPRESSED' THEN 'suppressed'
    WHEN d.state IN ('queued', 'submitted', 'delivered', 'deferred', 'bounced', 'complained', 'unknown') THEN d.state
    ELSE 'failed'
  END,
  d.provider,
  d.provider_message_id,
  d.id,
  d.error_code,
  CASE WHEN d.state = 'queued' THEN d.updated_at ELSE NULL END,
  CASE WHEN d.state = 'submitted' THEN d.updated_at ELSE NULL END,
  CASE WHEN d.state = 'delivered' THEN d.updated_at ELSE NULL END,
  CASE WHEN d.state IN ('bounced', 'complained', 'failed') THEN d.updated_at ELSE NULL END,
  nr.created_at,
  d.updated_at
FROM (
  SELECT DISTINCT ON (notification_id) *
  FROM email_deliveries
  ORDER BY notification_id, attempt DESC, updated_at DESC
) d
JOIN notification_recipients nr ON nr.legacy_notification_id = d.notification_id
JOIN notification_masters nm ON nm.id = nr.notification_id
ON CONFLICT DO NOTHING;

INSERT INTO notification_delivery_attempts (
  channel_delivery_id, attempt_no, idempotency_key, provider, state,
  provider_message_id, error_code, response_summary, created_at
)
SELECT
  ncd.id,
  d.attempt,
  'legacy-email:' || d.id::text || ':a' || d.attempt::text,
  d.provider,
  CASE
    WHEN d.error_code = 'ADDRESS_SUPPRESSED' THEN 'suppressed'
    WHEN d.state IN ('queued', 'submitted', 'delivered', 'deferred', 'bounced', 'complained', 'unknown') THEN d.state
    ELSE 'failed'
  END,
  d.provider_message_id,
  d.error_code,
  d.delivery_evidence_note,
  d.updated_at
FROM email_deliveries d
JOIN notification_recipients nr ON nr.legacy_notification_id = d.notification_id
JOIN notification_channel_deliveries ncd ON ncd.recipient_id = nr.id AND ncd.channel = 'email'
ON CONFLICT DO NOTHING;
