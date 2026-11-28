-- TASK-199 (PKG-4 Wave 26 · E405-E407): Capacity Modeling & Dynamic SLA Calculation Foundation
-- §11, §58.1, §58.4, §58.5, §89.2, T32, G07, G16

create table capacity_sla_policies (
  id uuid primary key default gen_random_uuid(),
  policy_code text not null unique,
  name_zh text not null,
  name_en text not null,
  description_zh text not null default '',
  description_en text not null default '',
  warehouse_id uuid references warehouses(id),
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  current_version int not null default 1 check (current_version >= 1),
  latest_published_version_id uuid,
  model_provenance text not null default 'estimated_baseline' check (model_provenance in ('estimated_baseline','field_calibrated','hybrid')),
  effective_inspector_utilization numeric(5,4) not null default 0.7800 check (effective_inspector_utilization > 0 and effective_inspector_utilization <= 1),
  effective_qa_utilization numeric(5,4) not null default 0.8000 check (effective_qa_utilization > 0 and effective_qa_utilization <= 1),
  default_daily_inspector_minutes int not null default 1440 check (default_daily_inspector_minutes > 0),
  default_daily_qa_minutes int not null default 480 check (default_daily_qa_minutes > 0),
  default_workstation_slots int not null default 4 check (default_workstation_slots >= 1),
  default_photo_rig_slots int not null default 2 check (default_photo_rig_slots >= 1),
  daily_break_minutes_per_shift int not null default 45 check (daily_break_minutes_per_shift >= 0),
  daily_prep_minutes_per_shift int not null default 20 check (daily_prep_minutes_per_shift >= 0),
  task_switch_overhead_minutes numeric(6,2) not null default 4.50 check (task_switch_overhead_minutes >= 0),
  qa_bottleneck_ratio numeric(6,4) not null default 1.2500 check (qa_bottleneck_ratio >= 1),
  upload_queue_buffer_minutes numeric(8,2) not null default 15.00 check (upload_queue_buffer_minutes >= 0),
  base_rework_rate numeric(5,4) not null default 0.0800 check (base_rework_rate >= 0 and base_rework_rate <= 0.8),
  safety_buffer_pct numeric(5,4) not null default 0.1500 check (safety_buffer_pct >= 0 and safety_buffer_pct <= 1),
  safety_buffer_min_minutes int not null default 60 check (safety_buffer_min_minutes >= 0),
  warn_utilization_pct numeric(5,4) not null default 0.7000 check (warn_utilization_pct > 0 and warn_utilization_pct < 1),
  review_utilization_pct numeric(5,4) not null default 0.8500 check (review_utilization_pct > warn_utilization_pct and review_utilization_pct < 1),
  pause_heavy_intake_pct numeric(5,4) not null default 0.9500 check (pause_heavy_intake_pct >= review_utilization_pct and pause_heavy_intake_pct <= 1.5),
  manual_quote_workload_minutes int not null default 720 check (manual_quote_workload_minutes > 0),
  manual_quote_min_items int not null default 30 check (manual_quote_min_items >= 1),
  complexity_profiles jsonb not null default '{}'::jsonb,
  module_workload_profiles jsonb not null default '{}'::jsonb,
  service_mode_rules jsonb not null default '{}'::jsonb,
  stage_weights jsonb not null default '{}'::jsonb,
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid not null references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table capacity_sla_policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references capacity_sla_policies(id),
  policy_code text not null,
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
  unique (policy_id, version),
  constraint capacity_sla_policy_versions_sod_check check (
    reviewer_id <> author_id
    and (submitted_by is null or reviewer_id <> submitted_by)
  )
);

alter table capacity_sla_policies
  add constraint capacity_sla_policies_latest_pub_fk
  foreign key (latest_published_version_id) references capacity_sla_policy_versions(id);

create or replace function freeze_capacity_sla_policy_version_fn()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'capacity_sla_policy_versions rows are immutable and cannot be deleted';
  end if;
  if old.snapshot is distinct from new.snapshot
     or old.content_hash is distinct from new.content_hash
     or old.policy_id is distinct from new.policy_id
     or old.policy_code is distinct from new.policy_code
     or old.version is distinct from new.version
     or old.author_id is distinct from new.author_id
     or old.submitted_by is distinct from new.submitted_by
     or old.reviewer_id is distinct from new.reviewer_id
     or old.publication_scope is distinct from new.publication_scope
     or old.business_approved is distinct from new.business_approved
     or old.published_at is distinct from new.published_at then
    raise exception 'capacity_sla_policy_versions snapshot and review metadata are immutable once published';
  end if;
  if old.state = 'RETIRED' and new.state <> 'RETIRED' then
    raise exception 'Retired capacity_sla_policy_versions cannot be reactivated';
  end if;
  return new;
end;
$$;

create trigger freeze_capacity_sla_policy_version
  before update or delete on capacity_sla_policy_versions
  for each row execute function freeze_capacity_sla_policy_version_fn();

create table order_sla_commitments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  batch_key text not null default 'ORDER',
  commitment_kind text not null default 'order_total' check (commitment_kind in ('order_total','independent_batch','compare_group','golden_group')),
  policy_id uuid references capacity_sla_policies(id),
  policy_version_id uuid references capacity_sla_policy_versions(id),
  warehouse_id uuid references warehouses(id),
  dependency_locked boolean not null default false,
  dependency_reason text,
  status text not null default 'pending_start' check (status in ('pending_start','active','paused','extended','manual_review_required','met','breached','cancelled')),
  manual_sla_required boolean not null default false,
  manual_sla_reasons jsonb not null default '[]'::jsonb,
  provenance text not null default 'estimated_baseline' check (provenance in ('estimated_baseline','field_calibrated','hybrid','manual_override')),
  estimated_workload_minutes numeric(10,2) not null check (estimated_workload_minutes >= 0),
  effective_capacity_minutes_per_day numeric(10,2) not null check (effective_capacity_minutes_per_day > 0),
  safety_buffer_minutes numeric(10,2) not null check (safety_buffer_minutes >= 0),
  bottleneck_stage text not null default 'inspector',
  stage_breakdown jsonb not null default '{}'::jsonb,
  capacity_utilization_ratio numeric(7,4) not null default 0 check (capacity_utilization_ratio >= 0),
  capacity_alert_level text not null default 'normal' check (capacity_alert_level in ('normal','warn_70','review_85','pause_heavy_95')),
  sla_started_at timestamptz,
  original_due_at timestamptz,
  current_due_at timestamptz,
  pause_started_at timestamptz,
  total_paused_seconds int not null default 0 check (total_paused_seconds >= 0),
  completed_at timestamptz,
  created_by uuid not null references users(id),
  updated_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, batch_key)
);

create or replace function protect_order_sla_start_fn()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'order_sla_commitments rows are audit-protected and cannot be deleted';
  end if;
  if old.sla_started_at is not null and new.sla_started_at is distinct from old.sla_started_at then
    raise exception 'sla_started_at is strictly immutable once started';
  end if;
  if old.original_due_at is not null and new.original_due_at is distinct from old.original_due_at then
    raise exception 'original_due_at is strictly immutable once committed';
  end if;
  return new;
end;
$$;

create trigger protect_order_sla_start
  before update or delete on order_sla_commitments
  for each row execute function protect_order_sla_start_fn();

create table sla_clock_events (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references order_sla_commitments(id),
  order_id uuid not null references orders(id),
  event_type text not null check (event_type in ('simulated','started','paused','resumed','extended','manual_override','completed','breached','recalculated','cancelled')),
  reason text not null check (char_length(trim(reason)) >= 3),
  actor_id uuid not null references users(id),
  previous_due_at timestamptz,
  new_due_at timestamptz,
  paused_delta_seconds int not null default 0 check (paused_delta_seconds >= 0),
  customer_notified boolean not null default false,
  notification_id uuid references notifications(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function freeze_sla_clock_event_fn()
returns trigger
language plpgsql
as $$
begin
  raise exception 'sla_clock_events rows are append-only immutable audit records';
end;
$$;

create trigger freeze_sla_clock_event
  before update or delete on sla_clock_events
  for each row execute function freeze_sla_clock_event_fn();

create table capacity_seed_runs (
  id uuid primary key default gen_random_uuid(),
  seed_version text not null,
  checksum text not null,
  seeded_policies int not null check (seeded_policies >= 0),
  actor_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create index idx_capacity_policies_status on capacity_sla_policies(status, warehouse_id, updated_at desc);
create index idx_capacity_policy_versions_lookup on capacity_sla_policy_versions(policy_id, version desc);
create index idx_order_sla_commitments_order on order_sla_commitments(order_id, created_at desc);
create index idx_order_sla_commitments_status on order_sla_commitments(warehouse_id, status, current_due_at);
create index idx_sla_clock_events_commitment on sla_clock_events(commitment_id, created_at desc);
create index idx_sla_clock_events_order on sla_clock_events(order_id, created_at desc);
