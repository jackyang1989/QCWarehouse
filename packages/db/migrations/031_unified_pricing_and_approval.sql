-- TASK-197 / PKG-4 (E385-E389): Unified Modular Pricing Engine, Approval Workflow, §43.2 Draft Matrix & Quote Locking
-- Strictly additive migration preserving 001-030 and immutable historical quote/book snapshots.

create table pricing_books (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,80}$'),
  name_zh text not null,
  name_en text not null,
  description_zh text not null default '',
  description_en text not null default '',
  currency text not null default 'USD' check (currency in ('USD','CNY','HKD','EUR','GBP')),
  rounding_mode text not null default 'ceil' check (rounding_mode in ('ceil','round','floor')),
  auto_volume_discount_enabled boolean not null default false,
  volume_discount_justification text,
  minimum_order_cents int not null default 0 check (minimum_order_cents >= 0),
  order_fixed_fee_cents int not null default 0 check (order_fixed_fee_cents >= 0),
  max_online_quantity int not null default 300 check (max_online_quantity >= 1),
  max_online_total_cents int not null default 5000000 check (max_online_total_cents >= 0),
  quote_validity_hours int not null default 72 check (quote_validity_hours between 1 and 720),
  complexity_rates jsonb not null,
  module_rates jsonb not null,
  service_rules jsonb not null,
  product_type_overrides jsonb not null default '{}'::jsonb,
  customer_overrides jsonb not null default '{}'::jsonb,
  discount_rules jsonb not null default '[]'::jsonb,
  volume_discount_tiers jsonb not null default '[]'::jsonb,
  commercial_policy_matrix jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  publication_scope text not null default 'sandbox_acceptance' check (publication_scope in ('sandbox_acceptance','production_pending_197b')),
  current_draft_version int not null default 1 check (current_draft_version >= 1),
  latest_published_version_id uuid,
  is_seed_default boolean not null default false,
  admin_modified boolean not null default false,
  effective_from timestamptz,
  created_by uuid not null references users(id),
  submitted_by uuid references users(id),
  approved_by uuid references users(id),
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_books_sod_check check (
    status <> 'published'
    or (
      approved_by is not null
      and created_by is not null
      and approved_by <> created_by
      and (submitted_by is null or approved_by <> submitted_by)
    )
  )
);

create table pricing_book_versions (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references pricing_books(id),
  book_code text not null,
  version int not null check (version >= 1),
  state text not null default 'PUBLISHED' check (state in ('PUBLISHED','RETIRED')),
  publication_scope text not null default 'sandbox_acceptance' check (publication_scope in ('sandbox_acceptance','production_pending_197b')),
  business_approved boolean not null default false,
  effective_snapshot jsonb not null,
  content_hash text not null,
  prepublish_checks jsonb not null default '{}'::jsonb,
  author_id uuid not null references users(id),
  submitted_by uuid references users(id),
  reviewer_id uuid not null references users(id),
  note text,
  effective_from timestamptz not null default now(),
  published_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (book_id, version),
  constraint pricing_book_versions_sod_check check (
    reviewer_id <> author_id
    and (submitted_by is null or reviewer_id <> submitted_by)
  )
);

alter table pricing_books
  add constraint pricing_books_latest_pub_fk
  foreign key (latest_published_version_id) references pricing_book_versions(id);

create or replace function freeze_pricing_book_version_fn()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pricing_book_versions rows are immutable and cannot be deleted';
  end if;
  if old.effective_snapshot is distinct from new.effective_snapshot
     or old.content_hash is distinct from new.content_hash
     or old.book_id is distinct from new.book_id
     or old.book_code is distinct from new.book_code
     or old.version is distinct from new.version
     or old.author_id is distinct from new.author_id
     or old.submitted_by is distinct from new.submitted_by
     or old.reviewer_id is distinct from new.reviewer_id
     or old.publication_scope is distinct from new.publication_scope
     or old.business_approved is distinct from new.business_approved
     or old.effective_from is distinct from new.effective_from
     or old.published_at is distinct from new.published_at then
    raise exception 'pricing_book_versions content and review metadata are immutable once published';
  end if;
  if old.state = 'RETIRED' and new.state <> 'RETIRED' then
    raise exception 'Retired pricing_book_versions cannot be reactivated';
  end if;
  return new;
end;
$$;

create trigger freeze_pricing_book_version
  before update or delete on pricing_book_versions
  for each row execute function freeze_pricing_book_version_fn();

create table pricing_quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id),
  book_id uuid not null references pricing_books(id),
  book_version_id uuid not null references pricing_book_versions(id),
  book_version int not null check (book_version >= 1),
  quote_kind text not null check (quote_kind in ('simulation','formal','supplement')),
  service_type text not null check (service_type in ('inspection','compare','reference_match')),
  request_payload jsonb not null,
  line_items jsonb not null,
  compiled_task_plan jsonb not null,
  subtotal_cents int not null check (subtotal_cents >= 0),
  discount_cents int not null default 0 check (discount_cents >= 0),
  minimum_topup_cents int not null default 0 check (minimum_topup_cents >= 0),
  total_cents int not null check (total_cents >= 0),
  currency text not null default 'USD',
  manual_quote_required boolean not null default false,
  manual_quote_reasons jsonb not null default '[]'::jsonb,
  snapshot_hash text not null,
  status text not null default 'open' check (status in ('open','locked','expired','superseded')),
  expires_at timestamptz not null,
  locked_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table pricing_seed_runs (
  id uuid primary key default gen_random_uuid(),
  seed_version text not null,
  actor_id uuid not null references users(id),
  inserted_counts jsonb not null,
  skipped_existing_counts jsonb not null,
  ran_at timestamptz not null default now()
);

create index idx_pricing_books_status on pricing_books (status, published_at desc nulls last);
create index idx_pricing_book_versions_book on pricing_book_versions (book_id, version desc);
create index idx_pricing_quotes_org_status on pricing_quotes (org_id, status, created_at desc);
create index idx_pricing_quotes_version on pricing_quotes (book_version_id, status);
