-- 014: Email bilingual templates, outbox lease/pool columns, legal entities, merchant instances & owner bootstrap audit

CREATE TABLE IF NOT EXISTS notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_code text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en-US', 'zh-CN')),
  version int NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  subject_template text NOT NULL,
  body_template text NOT NULL,
  allowed_variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_code, locale, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_one_published_idx
  ON notification_templates (template_code, locale)
  WHERE status = 'published';

INSERT INTO notification_templates (
  template_code, locale, version, status, subject_template, body_template, allowed_variables, published_at
) VALUES
  ('payment.confirmed', 'en-US', 1, 'published', 'Payment confirmed{ref}', 'Your payment{ref} has been confirmed. Open {link} to register seller tracking numbers or review your billing receipt.', '["ref","link"]'::jsonb, now()),
  ('payment.confirmed', 'zh-CN', 1, 'published', '付款已确认{ref}', '您的款项{ref}已确认到账。请打开 {link} 填写卖家快递单号或查看账单收据。', '["ref","link"]'::jsonb, now()),
  ('package.received', 'en-US', 1, 'published', 'Parcel received at QC Warehouse{ref}', 'Your parcel{ref} has been checked in at the warehouse. Open {link} to review its status.', '["ref","link"]'::jsonb, now()),
  ('package.received', 'zh-CN', 1, 'published', '仓库已签收包裹{ref}', '您的包裹{ref}已在仓核收。请打开 {link} 查看最新状态。', '["ref","link"]'::jsonb, now()),
  ('order.ready', 'en-US', 1, 'published', 'All samples received and queued for inspection{ref}', 'All commissioned samples{ref} have been received and identified. Your order is queued at {link}.', '["ref","link"]'::jsonb, now()),
  ('order.ready', 'zh-CN', 1, 'published', '委托样品已到齐待质检{ref}', '委托涉及的全部样品{ref}均已收齐并完成核身。订单已进入质检队列：{link}。', '["ref","link"]'::jsonb, now()),
  ('report.published', 'en-US', 1, 'published', 'Inspection report ready{ref}', 'Your inspection report{ref} has been published. Open {link} to review findings and choose item dispositions.', '["ref","link"]'::jsonb, now()),
  ('report.published', 'zh-CN', 1, 'published', '质检报告已发布{ref}', '您的质检报告{ref}已审核发布。请打开 {link} 查看明细并选择逐件处置方案。', '["ref","link"]'::jsonb, now()),
  ('shipment.handed_over', 'en-US', 1, 'published', 'Shipment handed over to carrier{ref}', 'Your outbound parcel{ref} has been handed over to the carrier. Open {link} to view tracking updates.', '["ref","link"]'::jsonb, now()),
  ('shipment.handed_over', 'zh-CN', 1, 'published', '出库包裹已交寄承运商{ref}', '您的出库包裹{ref}已交寄承运商。请打开 {link} 查看物流轨迹。', '["ref","link"]'::jsonb, now()),
  ('ticket.reply', 'en-US', 1, 'published', 'New support reply{ref}', 'Our support team has replied to your case{ref}. Open {link} to view the message and respond.', '["ref","link"]'::jsonb, now()),
  ('ticket.reply', 'zh-CN', 1, 'published', '客服工单有新回复{ref}', '客服团队已回复您的工单{ref}。请打开 {link} 查看内容。', '["ref","link"]'::jsonb, now()),
  ('staff.invited', 'en-US', 1, 'published', 'QC Warehouse staff activation{ref}', 'You have been invited to QC Warehouse staff portal{ref}. Complete password and MFA activation at {link}.', '["ref","link"]'::jsonb, now()),
  ('staff.invited', 'zh-CN', 1, 'published', 'QC Warehouse 员工账号激活邀请{ref}', '管理员已为您创建员工账号{ref}。请通过受控链接 {link} 设置密码并绑定双因素认证。', '["ref","link"]'::jsonb, now()),
  ('account.security_alert', 'en-US', 1, 'published', 'Account security notice{ref}', 'A security change occurred on your QC Warehouse account{ref}. Review activity at {link}.', '["ref","link"]'::jsonb, now()),
  ('account.security_alert', 'zh-CN', 1, 'published', '账号安全变动提醒{ref}', '您的 QC Warehouse 账号发生了安全变动{ref}。请登录 {link} 核对详情。', '["ref","link"]'::jsonb, now())
ON CONFLICT (template_code, locale, version) DO NOTHING;

ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS locale text;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS template_version int;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS delivery_evidence_note text;

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS pool text NOT NULL DEFAULT 'delivery_notification';
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS outcome_state text NOT NULL DEFAULT 'normal'
  CHECK (outcome_state IN ('normal', 'unknown_outcome', 'reconciled'));

CREATE TABLE IF NOT EXISTS legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code text NOT NULL UNIQUE,
  entity_type text NOT NULL CHECK (entity_type IN ('sole_proprietor', 'individual_operator', 'company')),
  public_trade_name text NOT NULL,
  legal_name text NOT NULL,
  jurisdiction text NOT NULL,
  registration_no text,
  tax_id text,
  contact_email text NOT NULL,
  service_address text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'suspended', 'retired')),
  is_default_for_new_orders boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_entities_one_default_idx
  ON legal_entities ((true))
  WHERE is_default_for_new_orders;

CREATE TABLE IF NOT EXISTS merchant_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_code text NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'paypal_manual', 'paypal_auto')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  external_account_id text NOT NULL,
  supported_currencies text[] NOT NULL DEFAULT ARRAY['USD'],
  settlement_account_masked text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepting_new', 'legacy_only', 'paused', 'revoked', 'retired')),
  is_primary_for_new_orders boolean NOT NULL DEFAULT false,
  config_version int NOT NULL DEFAULT 1 CHECK (config_version > 0),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merchant_instances_entity_idx
  ON merchant_instances (legal_entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_instances_one_primary_idx
  ON merchant_instances (provider, environment)
  WHERE is_primary_for_new_orders AND status = 'accepting_new';

CREATE TABLE IF NOT EXISTS owner_bootstrap_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bootstrapped_user_id uuid NOT NULL REFERENCES users(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  completed_at timestamptz NOT NULL DEFAULT now(),
  notes text
);
