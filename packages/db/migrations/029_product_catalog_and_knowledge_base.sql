-- TASK-195 / PKG-4 (E370-E375): Full Authoritative Product Catalog & Apparel Knowledge Base
-- Strictly additive migration preserving 001-028, existing categories/service_offers/template_versions, and shadow category tests.

create table complexity_levels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^L[1-5]$'),
  name_zh text not null,
  name_en text not null,
  description_zh text not null default '',
  description_en text not null default '',
  suggested_base_price_cents int,
  pricing_mode text not null check (pricing_mode in ('fixed_draft','manual_quote')),
  pricing_status text not null default 'draft_unverified' check (pricing_status in ('draft_unverified','commercial_approved')),
  requires_commercial_approval boolean not null default true,
  adjustment_factors jsonb not null default '[]'::jsonb,
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  version int not null default 1 check (version >= 1),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint complexity_levels_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table inspection_modules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^M[0-9]{2}$'),
  name_zh text not null,
  name_en text not null,
  description_zh text not null default '',
  description_en text not null default '',
  module_tier text not null check (module_tier in ('base_included','optional_addon','manual_quote')),
  billing_unit text not null check (billing_unit in ('included_in_base','per_piece','per_order','per_item_batch','manual_quote')),
  suggested_price_cents int,
  pricing_tiers jsonb not null default '{}'::jsonb,
  pricing_status text not null default 'draft_unverified' check (pricing_status in ('draft_unverified','commercial_approved')),
  requires_commercial_approval boolean not null default true,
  depends_on_codes text[] not null default '{}'::text[],
  conflicts_with_codes text[] not null default '{}'::text[],
  requires_capability_codes text[] not null default '{}'::text[],
  scope_boundary_zh text not null default '',
  scope_boundary_en text not null default '',
  is_destructive_possible boolean not null default false,
  requires_customer_authorization boolean not null default false,
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  version int not null default 1 check (version >= 1),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inspection_modules_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table catalog_product_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,80}$'),
  category_id uuid references categories(id),
  category_slug text not null,
  group_code text not null check (group_code in (
    'tops','bottoms','dresses_sets','outerwear','underwear_activewear','special_apparel','bags_non_open','home_non_open'
  )),
  group_name_zh text not null,
  group_name_en text not null,
  parent_type_id uuid references catalog_product_types(id),
  name_zh text not null,
  name_en text not null,
  aliases jsonb not null default '[]'::jsonb,
  default_complexity_code text not null references complexity_levels(code),
  structural_options jsonb not null default '[]'::jsonb,
  billing_unit text not null default 'piece' check (billing_unit in ('piece','set','component')),
  included_components jsonb not null default '[]'::jsonb,
  applicable_module_codes text[] not null default '{}'::text[],
  default_evidence_rules jsonb not null default '{}'::jsonb,
  quote_mode text not null default 'online_standard' check (quote_mode in ('online_standard','conditional','manual_quote')),
  capability_status text not null default 'ready' check (capability_status in ('ready','requires_capability_approval','not_admitted')),
  public_sellable boolean not null default false,
  status text not null default 'draft' check (status in ('draft','in_review','published','paused','retired')),
  version int not null default 1 check (version >= 1),
  sort_order int not null default 0,
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_product_types_sellable_check check (
    not public_sellable
    or (status = 'published' and capability_status <> 'not_admitted')
  ),
  constraint catalog_product_types_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table knowledge_check_items (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  module_code text not null references inspection_modules(code),
  name_zh text not null,
  name_en text not null,
  method_zh text not null,
  method_en text not null,
  scope_limit_zh text not null default '',
  scope_limit_en text not null default '',
  applicable_group_codes text[] not null default '{}'::text[],
  applicable_part_codes text[] not null default '{}'::text[],
  evidence_requirement text not null default 'photo_if_defect' check (
    evidence_requirement in ('mandatory_photo','photo_if_defect','measurement_record','label_photo','video_optional','none')
  ),
  billing_included_in_base boolean not null default false,
  requires_capability_code text,
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  version int not null default 1 check (version >= 1),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_check_items_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table knowledge_garment_parts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_zh text not null,
  name_en text not null,
  description_zh text not null default '',
  description_en text not null default '',
  applicable_group_codes text[] not null default '{}'::text[],
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  version int not null default 1 check (version >= 1),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_garment_parts_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table knowledge_defect_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_zh text not null,
  name_en text not null,
  category_group text not null,
  default_severity text not null check (default_severity in ('minor','major','critical_safety')),
  severity_guidance_zh text not null,
  severity_guidance_en text not null,
  non_aql_disclaimer_zh text not null,
  non_aql_disclaimer_en text not null,
  applicable_part_codes text[] not null default '{}'::text[],
  applicable_group_codes text[] not null default '{}'::text[],
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  version int not null default 1 check (version >= 1),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_defect_types_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table knowledge_rework_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_zh text not null,
  name_en text not null,
  description_zh text not null,
  description_en text not null,
  platform_fault_free_rework boolean not null default false,
  requires_customer_approval boolean not null default false,
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  version int not null default 1 check (version >= 1),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_rework_types_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table knowledge_terminology_entries (
  id uuid primary key default gen_random_uuid(),
  term_code text not null,
  domain text not null check (domain in (
    'garment_type','measurement_pom','defect','part','module','sop','boundary_disclaimer'
  )),
  locale text not null check (locale in ('en-US','zh-CN')),
  version int not null default 1 check (version >= 1),
  standard_name text not null,
  definition text not null,
  context_categories text[] not null default '{}'::text[],
  synonyms text[] not null default '{}'::text[],
  forbidden_translations text[] not null default '{}'::text[],
  method_and_limits text not null default '',
  source_license text not null default 'QC Warehouse Internal Bilingual Standard v1',
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (term_code, locale, version),
  constraint knowledge_terminology_entries_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table knowledge_sops (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title_zh text not null,
  title_en text not null,
  applicable_group_codes text[] not null default '{}'::text[],
  applicable_module_codes text[] not null default '{}'::text[],
  steps_zh jsonb not null default '[]'::jsonb,
  steps_en jsonb not null default '[]'::jsonb,
  safety_and_boundary_zh text not null default '',
  safety_and_boundary_en text not null default '',
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  version int not null default 1 check (version >= 1),
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  created_by uuid references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_sops_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table knowledge_seed_runs (
  id uuid primary key default gen_random_uuid(),
  seed_version text not null,
  actor_id uuid references users(id),
  inserted_counts jsonb not null default '{}'::jsonb,
  skipped_existing_counts jsonb not null default '{}'::jsonb,
  ran_at timestamptz not null default now()
);

create table knowledge_revision_history (
  id uuid primary key default gen_random_uuid(),
  entity_kind text not null check (entity_kind in (
    'complexity_level','inspection_module','product_type','check_item',
    'garment_part','defect_type','rework_type','terminology','sop'
  )),
  entity_id uuid not null,
  entity_code text not null,
  version int not null check (version >= 1),
  action text not null check (action in ('seed_v1','save_draft','clone','submit','publish','retire','rollback')),
  actor_id uuid references users(id),
  snapshot jsonb not null,
  note text,
  created_at timestamptz not null default now()
);

create index catalog_product_types_status_idx on catalog_product_types(status, public_sellable, group_code, sort_order);
create index catalog_product_types_cat_idx on catalog_product_types(category_slug, status);
create index knowledge_check_items_mod_idx on knowledge_check_items(module_code, status, sort_order);
create index knowledge_terminology_term_idx on knowledge_terminology_entries(term_code, locale, status);
create index knowledge_revision_history_ent_idx on knowledge_revision_history(entity_kind, entity_id, version desc, created_at desc);
