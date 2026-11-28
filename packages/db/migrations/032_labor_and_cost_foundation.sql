-- TASK-198 (PKG-4 Wave 25 · E390-E394): Real-Clock Labor Capture, Statistical Percentiles, Cost Models & Margin Sandbox
-- §10, §31, §43.3, §71.2, §82, §89, §112.2, R06, G07, G16

create table labor_time_events (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid references warehouses(id),
  order_id uuid references orders(id),
  inspection_task_id uuid references inspection_tasks(id),
  dispatch_work_item_id uuid references dispatch_work_items(id),
  package_id uuid references packages(id),
  item_id uuid references warehouse_items(id),
  sku_code text,
  product_type_code text,
  complexity_code text check (complexity_code is null or complexity_code in ('L1','L2','L3','L4','L5')),
  module_code text,
  measurement_point_code text,
  evidence_id uuid references media_evidence_records(id),
  activity_code text not null check (activity_code in (
    'order_prep',
    'parcel_intake',
    'unbox_count',
    'sku_label',
    'garment_prep',
    'visual_inspect',
    'module_inspect',
    'measurement_point',
    'remeasurement',
    'photo_capture',
    'photo_retake',
    'video_capture',
    'video_retake',
    'file_upload',
    'transcode_process',
    'upload_retry',
    'exception_log',
    'qa_review',
    'qa_rework',
    'report_compile',
    'repack_putaway',
    'outbound_prep',
    'support'
  )),
  time_bucket text not null check (time_bucket in ('active_labor','non_parallel_wait','background_system','interruption')),
  operator_id uuid not null references users(id),
  device_id uuid references warehouse_devices(id),
  workstation_id uuid references workstations(id),
  timezone text not null default 'Asia/Shanghai',
  source_kind text not null check (source_kind in ('system_event','auto_hook','operator_timer','worker_metric','manual_correction')),
  data_provenance text not null default 'measured_system' check (data_provenance in ('estimated_baseline','simulated_software','measured_field','measured_system')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  raw_elapsed_seconds int generated always as (
    case
      when ended_at is null then null
      else greatest(0, extract(epoch from (ended_at - started_at))::int)
    end
  ) stored,
  effective_seconds int check (effective_seconds is null or effective_seconds >= 0),
  pause_started_at timestamptz,
  accumulated_pause_seconds int not null default 0 check (accumulated_pause_seconds >= 0),
  status text not null default 'active' check (status in ('active','paused','completed','pending_calibration','corrected','voided')),
  wait_reason text,
  rework_attribution text,
  is_rework boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint labor_time_events_end_after_start check (ended_at is null or ended_at >= started_at)
);

create table labor_time_corrections (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references labor_time_events(id),
  original_started_at timestamptz not null,
  original_ended_at timestamptz,
  original_effective_seconds int,
  original_time_bucket text not null,
  original_status text not null,
  corrected_started_at timestamptz not null,
  corrected_ended_at timestamptz not null,
  corrected_effective_seconds int not null check (corrected_effective_seconds >= 0),
  corrected_time_bucket text not null check (corrected_time_bucket in ('active_labor','non_parallel_wait','background_system','interruption')),
  reason text not null check (char_length(trim(reason)) >= 5),
  corrected_by uuid not null references users(id),
  corrected_at timestamptz not null default now(),
  constraint labor_time_corrections_end_after_start check (corrected_ended_at >= corrected_started_at)
);

create or replace function freeze_labor_time_correction_fn()
returns trigger
language plpgsql
as $$
begin
  raise exception 'labor_time_corrections rows are append-only immutable audit records';
end;
$$;

create trigger freeze_labor_time_correction
  before update or delete on labor_time_corrections
  for each row execute function freeze_labor_time_correction_fn();

create table labor_baseline_assumptions (
  id uuid primary key default gen_random_uuid(),
  activity_code text not null,
  complexity_code text not null default 'ALL' check (complexity_code in ('ALL','L1','L2','L3','L4','L5')),
  unit_label text not null,
  estimated_min_minutes numeric(8,2) not null check (estimated_min_minutes >= 0),
  estimated_max_minutes numeric(8,2) not null check (estimated_max_minutes >= estimated_min_minutes),
  default_assumption_minutes numeric(8,2) not null check (default_assumption_minutes >= 0),
  data_source text not null default 'estimated_baseline' check (data_source in ('estimated_baseline','field_calibrated')),
  sample_size int not null default 0 check (sample_size >= 0),
  notes_zh text not null default '',
  notes_en text not null default '',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (activity_code, complexity_code)
);

create table cost_models (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,80}$'),
  name_zh text not null,
  name_en text not null,
  description_zh text not null default '',
  description_en text not null default '',
  currency text not null default 'USD' check (currency in ('USD','CNY','HKD','EUR','GBP')),
  labor_hourly_rate_cents int not null check (labor_hourly_rate_cents >= 0),
  qa_hourly_rate_cents int not null check (qa_hourly_rate_cents >= 0),
  management_overhead_included_in_labor boolean not null default true,
  management_overhead_pct numeric(5,2) not null default 0 check (management_overhead_pct >= 0 and management_overhead_pct <= 100),
  warehouse_fixed_monthly_cents int not null default 0 check (warehouse_fixed_monthly_cents >= 0),
  expected_monthly_orders int not null default 200 check (expected_monthly_orders >= 1),
  equipment_depreciation_per_order_cents int not null default 0 check (equipment_depreciation_per_order_cents >= 0),
  camera_lighting_per_item_cents int not null default 0 check (camera_lighting_per_item_cents >= 0),
  barcode_label_per_item_cents int not null default 0 check (barcode_label_per_item_cents >= 0),
  packaging_consumable_per_item_cents int not null default 0 check (packaging_consumable_per_item_cents >= 0),
  storage_gb_month_cents int not null default 0 check (storage_gb_month_cents >= 0),
  bandwidth_gb_cents int not null default 0 check (bandwidth_gb_cents >= 0),
  video_transcode_per_min_cents int not null default 0 check (video_transcode_per_min_cents >= 0),
  ai_estimated_per_order_cents int not null default 0 check (ai_estimated_per_order_cents >= 0),
  domestic_logistics_handling_per_order_cents int not null default 0 check (domestic_logistics_handling_per_order_cents >= 0),
  payment_fixed_fee_cents int not null default 30 check (payment_fixed_fee_cents >= 0),
  payment_fee_rate_bps int not null default 340 check (payment_fee_rate_bps >= 0 and payment_fee_rate_bps <= 5000),
  other_variable_revenue_rate_bps int not null default 0 check (other_variable_revenue_rate_bps >= 0 and other_variable_revenue_rate_bps <= 5000),
  rework_reserve_rate_bps int not null default 300 check (rework_reserve_rate_bps >= 0 and rework_reserve_rate_bps <= 5000),
  support_cost_per_order_cents int not null default 150 check (support_cost_per_order_cents >= 0),
  target_contribution_margin_bps int not null default 2500 check (target_contribution_margin_bps >= 0 and target_contribution_margin_bps <= 9500),
  tax_policy_note text not null default 'Net of pass-through shipping & payment processing fees; exclusive of external indirect taxes',
  default_defect_rate_bps int not null default 800 check (default_defect_rate_bps >= 0 and default_defect_rate_bps <= 10000),
  default_rework_rate_bps int not null default 400 check (default_rework_rate_bps >= 0 and default_rework_rate_bps <= 10000),
  default_avg_mb_per_item numeric(8,2) not null default 12.00 check (default_avg_mb_per_item >= 0),
  fx_cny_per_usd numeric(10,4) not null default 7.2000 check (fx_cny_per_usd > 0),
  fx_source text not null default 'manual_sandbox_baseline',
  data_source text not null default 'estimated_baseline' check (data_source in ('estimated_baseline','field_calibrated')),
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  publication_scope text not null default 'sandbox_acceptance' check (publication_scope in ('sandbox_acceptance','production')),
  business_approved boolean not null default false,
  current_draft_version int not null default 1 check (current_draft_version >= 1),
  latest_published_version_id uuid,
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid not null references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cost_models_no_double_mgmt_overhead check (not management_overhead_included_in_labor or management_overhead_pct = 0)
);

create table cost_model_versions (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references cost_models(id),
  model_code text not null,
  version int not null check (version >= 1),
  state text not null default 'PUBLISHED' check (state in ('PUBLISHED','RETIRED')),
  publication_scope text not null default 'sandbox_acceptance' check (publication_scope in ('sandbox_acceptance','production')),
  business_approved boolean not null default false,
  snapshot jsonb not null,
  content_hash text not null,
  author_id uuid not null references users(id),
  submitted_by uuid references users(id),
  reviewer_id uuid not null references users(id),
  note text,
  published_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (model_id, version),
  constraint cost_model_versions_sod_check check (
    reviewer_id <> author_id
    and (submitted_by is null or reviewer_id <> submitted_by)
  )
);

alter table cost_models
  add constraint cost_models_latest_pub_fk
  foreign key (latest_published_version_id) references cost_model_versions(id);

create or replace function freeze_cost_model_version_fn()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cost_model_versions rows are immutable and cannot be deleted';
  end if;
  if old.snapshot is distinct from new.snapshot
     or old.content_hash is distinct from new.content_hash
     or old.model_id is distinct from new.model_id
     or old.model_code is distinct from new.model_code
     or old.version is distinct from new.version
     or old.author_id is distinct from new.author_id
     or old.submitted_by is distinct from new.submitted_by
     or old.reviewer_id is distinct from new.reviewer_id
     or old.publication_scope is distinct from new.publication_scope
     or old.business_approved is distinct from new.business_approved
     or old.published_at is distinct from new.published_at then
    raise exception 'cost_model_versions snapshot and review metadata are immutable once published';
  end if;
  if old.state = 'RETIRED' and new.state <> 'RETIRED' then
    raise exception 'Retired cost_model_versions cannot be reactivated';
  end if;
  return new;
end;
$$;

create trigger freeze_cost_model_version
  before update or delete on cost_model_versions
  for each row execute function freeze_cost_model_version_fn();

create table order_cost_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  cost_category text not null check (cost_category in (
    'labor_direct',
    'labor_qa',
    'payment_fee',
    'consumables',
    'packaging',
    'domestic_shipping',
    'media_storage',
    'media_bandwidth',
    'media_transcode',
    'ai_service',
    'rework_reserve',
    'customer_support',
    'fixed_allocation'
  )),
  cost_nature text not null check (cost_nature in ('direct_variable','fixed_allocated')),
  provenance text not null check (provenance in ('actual','estimated','allocated')),
  amount_cents int not null check (amount_cents >= 0),
  original_amount_minor int check (original_amount_minor is null or original_amount_minor >= 0),
  original_currency text default 'USD' check (original_currency is null or original_currency in ('USD','CNY','HKD','EUR','GBP')),
  fx_rate numeric(10,4),
  fx_source text,
  source_ref text,
  notes text,
  recorded_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table labor_cost_seed_runs (
  id uuid primary key default gen_random_uuid(),
  seed_version text not null,
  actor_id uuid not null references users(id),
  inserted_counts jsonb not null,
  skipped_existing_counts jsonb not null,
  ran_at timestamptz not null default now()
);

create index idx_labor_events_operator_active on labor_time_events (operator_id, status, time_bucket) where status in ('active','paused');
create index idx_labor_events_order on labor_time_events (order_id, activity_code, time_bucket);
create index idx_labor_events_task on labor_time_events (inspection_task_id, status);
create index idx_labor_events_stats on labor_time_events (time_bucket, status, product_type_code, complexity_code, module_code, started_at desc);
create index idx_order_cost_ledger_order on order_cost_ledger_entries (order_id, cost_category, created_at desc);
