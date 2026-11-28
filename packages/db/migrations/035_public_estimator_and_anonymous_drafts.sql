-- PKG-5 Wave 28 (TASK-201 · E408–E412): Public Modular Estimator & Anonymous Estimate Drafts

create table anonymous_estimate_drafts (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  session_binding_hash text not null check (session_binding_hash ~ '^[a-f0-9]{64}$'),
  locale text not null default 'en-US' check (locale in ('en-US', 'zh-CN')),
  mode text not null default 'quick' check (mode in ('quick', 'advanced')),
  source_route text not null default '/pricing' check (
    source_route like '/%'
    and source_route not like '//%'
    and position(chr(92) in source_route) = 0
  ),
  draft_payload jsonb not null,
  last_book_id uuid references pricing_books(id),
  last_book_version_id uuid references pricing_book_versions(id),
  last_book_version integer,
  last_currency text not null default 'USD',
  last_total_cents integer check (last_total_cents is null or last_total_cents >= 0),
  last_manual_quote_required boolean not null default false,
  last_estimate_snapshot jsonb not null,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked', 'claimed')),
  revision integer not null default 1 check (revision >= 1),
  expires_at timestamptz not null,
  claimed_by_user_id uuid references users(id),
  claimed_org_id uuid references organizations(id),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint anonymous_estimate_drafts_claim_check check (
    (status = 'claimed' and claimed_by_user_id is not null and claimed_org_id is not null and claimed_at is not null)
    or (status <> 'claimed' and claimed_by_user_id is null and claimed_org_id is null and claimed_at is null)
  )
);

create index idx_anon_estimate_drafts_expires on anonymous_estimate_drafts (status, expires_at);
create index idx_anon_estimate_drafts_session on anonymous_estimate_drafts (session_binding_hash, status, updated_at desc);
