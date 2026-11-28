-- TASK-200 (PKG-5 Wave 27 · E395–E399): Bilingual Public Website Foundation
-- Configurable non-realtime contact channels (§53.6, §65.11) & retired 301/410 route registry (§102)

create table if not exists public_contact_settings (
  id text primary key default 'default' check (id = 'default'),
  support_email text not null default 'support@qcwarehouse.com',
  whatsapp_enabled boolean not null default false,
  whatsapp_verified boolean not null default false,
  whatsapp_number text,
  whatsapp_url text,
  business_hours_zh text not null default '周一至周六 09:00–18:00（北京时间 / Asia/Shanghai）',
  business_hours_en text not null default 'Mon–Sat 09:00–18:00 (Asia/Shanghai · UTC+8)',
  response_sla_zh text not null default '工单与邮件通常于 1 个工作日内人工回复（非实时在线聊天）',
  response_sla_en text not null default 'Inquiries & tickets are reviewed within 1 business day (no live chat)',
  timezone text not null default 'Asia/Shanghai',
  widget_enabled boolean not null default true,
  widget_notice_zh text not null default '欢迎提交售前或物流质检咨询，我们会通过邮件与工单记录跟进。',
  widget_notice_en text not null default 'Submit pre-order or inspection questions anytime—we follow up via email and ticket threads.',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  constraint public_contact_whatsapp_verified_check check (
    not whatsapp_enabled
    or (whatsapp_verified and whatsapp_number is not null and whatsapp_url is not null)
  )
);

insert into public_contact_settings (id)
values ('default')
on conflict (id) do nothing;

create table if not exists public_retired_routes (
  path text primary key check (path ~ '^/[a-z0-9/_-]+$'),
  http_status int not null check (http_status in (301, 410)),
  redirect_to text,
  title_zh text not null,
  title_en text not null,
  reason_zh text not null,
  reason_en text not null,
  replacement_path text not null default '/catalog',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  constraint public_retired_routes_redirect_check check (
    (http_status = 301 and redirect_to is not null and redirect_to like '/%' and redirect_to not like '//%')
    or (http_status = 410 and redirect_to is null)
  ),
  constraint public_retired_routes_replacement_check check (
    replacement_path like '/%' and replacement_path not like '//%'
  )
);

insert into public_retired_routes (
  path, http_status, redirect_to, title_zh, title_en, reason_zh, reason_en, replacement_path
) values
  (
    '/services/aql',
    410,
    null,
    '整厂驻场 AQL 验厂入口已永久下线',
    'Factory-Floor AQL Audits Are Permanently Discontinued',
    'QC Warehouse 专注中国独立收货仓拆包质检、横向样品对比与确认样比对，不提供驻厂整批 AQL 抽检或贸易代采服务。',
    'QC Warehouse operates exclusively at our independent China receiving center and no longer lists factory-floor AQL audit pages.',
    '/catalog'
  ),
  (
    '/legacy-pricing',
    301,
    '/pricing',
    '旧版定价页面已永久迁移',
    'Legacy Pricing Page Moved Permanently',
    '公开价格目录已升级为统一版本化定价内核与实时费用试算器，请访问最新定价页面。',
    'Public rates now reflect our unified versioned pricing schedule and estimator at /pricing.',
    '/pricing'
  )
on conflict (path) do nothing;

create index if not exists idx_public_retired_routes_status on public_retired_routes(http_status, updated_at desc);
