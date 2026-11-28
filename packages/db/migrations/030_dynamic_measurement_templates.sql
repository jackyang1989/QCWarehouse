-- TASK-196 / PKG-4 (E379-E384): Dynamic Measurement Knowledge Base, Multi-View SVG Editor, Inheritance & Camera Presets
-- Strictly additive migration preserving 001-029 and immutable template/task history.

create table measurement_camera_presets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,80}$'),
  name_zh text not null,
  name_en text not null,
  view_key text not null check (view_key in ('front','back','side','inside','detail')),
  framing_notes_zh text not null default '',
  framing_notes_en text not null default '',
  requires_scale_ruler boolean not null default true,
  recommended_resolution text not null default '1920x1080',
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table measurement_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,80}$'),
  parent_template_id uuid references measurement_templates(id),
  name_zh text not null,
  name_en text not null,
  description_zh text not null default '',
  description_en text not null default '',
  applicable_product_type_codes text[] not null default '{}'::text[],
  applicable_group_codes text[] not null default '{}'::text[],
  default_unit text not null default 'cm' check (default_unit in ('cm','inch')),
  views jsonb not null default '[]'::jsonb,
  points jsonb not null default '[]'::jsonb,
  point_overrides jsonb not null default '{}'::jsonb,
  camera_preset_codes text[] not null default '{}'::text[],
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  current_draft_version int not null default 1 check (current_draft_version >= 1),
  latest_published_version_id uuid,
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint measurement_templates_no_self_parent check (parent_template_id is null or parent_template_id <> id),
  constraint measurement_templates_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table measurement_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references measurement_templates(id),
  template_code text not null,
  version int not null check (version >= 1),
  state text not null default 'PUBLISHED' check (state in ('PUBLISHED','RETIRED')),
  effective_snapshot jsonb not null,
  content_hash text not null,
  author_id uuid not null references users(id),
  submitted_by uuid references users(id),
  reviewer_id uuid not null references users(id),
  note text,
  published_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (template_id, version),
  constraint measurement_template_versions_sod_check check (
    reviewer_id <> author_id
    and (submitted_by is null or reviewer_id <> submitted_by)
  )
);

alter table measurement_templates
  add constraint measurement_templates_latest_pub_fk
  foreign key (latest_published_version_id) references measurement_template_versions(id);

create or replace function freeze_measurement_template_version_fn()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'measurement_template_versions rows are immutable and cannot be deleted';
  end if;
  if old.effective_snapshot is distinct from new.effective_snapshot
     or old.content_hash is distinct from new.content_hash
     or old.template_id is distinct from new.template_id
     or old.template_code is distinct from new.template_code
     or old.version is distinct from new.version
     or old.author_id is distinct from new.author_id
     or old.submitted_by is distinct from new.submitted_by
     or old.reviewer_id is distinct from new.reviewer_id
     or old.published_at is distinct from new.published_at then
    raise exception 'measurement_template_versions content and review metadata are immutable once published';
  end if;
  if old.state = 'RETIRED' and new.state <> 'RETIRED' then
    raise exception 'Retired measurement_template_versions cannot be reactivated';
  end if;
  return new;
end;
$$;

create trigger freeze_measurement_template_version
  before update or delete on measurement_template_versions
  for each row execute function freeze_measurement_template_version_fn();

create table measurement_template_seed_runs (
  id uuid primary key default gen_random_uuid(),
  seed_version text not null,
  actor_id uuid references users(id),
  inserted_counts jsonb not null default '{}'::jsonb,
  skipped_existing_counts jsonb not null default '{}'::jsonb,
  ran_at timestamptz not null default now()
);

alter table inspection_tasks
  add column if not exists measurement_template_version_id uuid references measurement_template_versions(id);

create index measurement_templates_status_idx on measurement_templates(status, parent_template_id);
create index measurement_templates_pt_gin_idx on measurement_templates using gin(applicable_product_type_codes);
create index measurement_template_versions_tpl_idx on measurement_template_versions(template_id, version desc);
create index inspection_tasks_meas_ver_idx on inspection_tasks(measurement_template_version_id);
