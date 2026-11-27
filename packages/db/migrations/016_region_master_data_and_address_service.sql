-- 016: Complete authoritative China region master data & unified address service (TASK-181)

CREATE TABLE IF NOT EXISTS region_dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_code text NOT NULL UNIQUE,
  source_name text NOT NULL,
  source_url text NOT NULL,
  license text NOT NULL,
  data_as_of date NOT NULL,
  source_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('staged', 'active', 'superseded', 'rolled_back', 'failed')),
  province_count int NOT NULL DEFAULT 0,
  prefecture_count int NOT NULL DEFAULT 0,
  county_count int NOT NULL DEFAULT 0,
  township_count int NOT NULL DEFAULT 0,
  diff_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  impact_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_region_dataset
  ON region_dataset_versions(status)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_region_key text NOT NULL,
  version_id uuid NOT NULL REFERENCES region_dataset_versions(id),
  code_system text NOT NULL CHECK (code_system IN ('mca_gbt2260', 'mca_township')),
  official_code text NOT NULL,
  level text NOT NULL CHECK (level IN ('province', 'prefecture', 'county', 'township')),
  admin_type text NOT NULL,
  name_zh text NOT NULL,
  short_name_zh text NOT NULL,
  name_en text NOT NULL,
  pinyin text NOT NULL,
  parent_id uuid REFERENCES regions(id),
  market_scope text NOT NULL DEFAULT 'cn_mainland' CHECK (market_scope IN ('cn_mainland', 'hk_mo_tw', 'international')),
  is_terminal_official boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'abolished')),
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, code_system, official_code),
  UNIQUE (version_id, stable_region_key)
);

CREATE INDEX IF NOT EXISTS regions_version_parent_idx ON regions (version_id, parent_id);
CREATE INDEX IF NOT EXISTS regions_version_level_idx ON regions (version_id, level);
CREATE INDEX IF NOT EXISTS regions_version_code_idx ON regions (version_id, official_code);
CREATE INDEX IF NOT EXISTS regions_version_pinyin_idx ON regions (version_id, lower(pinyin));
CREATE INDEX IF NOT EXISTS regions_version_name_en_idx ON regions (version_id, lower(name_en));
CREATE INDEX IF NOT EXISTS regions_version_name_zh_idx ON regions (version_id, name_zh);

CREATE TABLE IF NOT EXISTS region_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_region_key text NOT NULL,
  alias_text text NOT NULL,
  alias_kind text NOT NULL CHECK (alias_kind IN ('short_name', 'historical_name', 'pinyin', 'english', 'traditional_zh', 'logistics_park')),
  locale text NOT NULL DEFAULT 'zh-CN',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  source_note text,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stable_region_key, alias_text, alias_kind)
);

CREATE INDEX IF NOT EXISTS region_aliases_text_idx
  ON region_aliases (lower(alias_text))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS region_change_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_version_id uuid REFERENCES region_dataset_versions(id),
  to_version_id uuid NOT NULL REFERENCES region_dataset_versions(id),
  from_region_id uuid REFERENCES regions(id),
  from_official_code text NOT NULL,
  to_region_id uuid REFERENCES regions(id),
  to_official_code text,
  change_type text NOT NULL CHECK (change_type IN ('renamed', 'merged', 'split', 'reparented', 'code_changed', 'abolished', 'added')),
  effective_date date,
  evidence_note text,
  requires_manual_confirm boolean NOT NULL DEFAULT false,
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS region_change_mappings_to_idx
  ON region_change_mappings (to_version_id, change_type);

CREATE TABLE IF NOT EXISTS address_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  owner_user_id uuid REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('freight_forwarder', 'supplier_return', 'other_domestic', 'warehouse_receiving', 'warehouse_dispatch', 'international_billing')),
  raw_input_text text,
  recipient_name text NOT NULL,
  contact_phone_raw text NOT NULL,
  contact_phone_normalized text,
  region_dataset_version_id uuid REFERENCES region_dataset_versions(id),
  province_region_id uuid REFERENCES regions(id),
  prefecture_region_id uuid REFERENCES regions(id),
  county_region_id uuid REFERENCES regions(id),
  township_region_id uuid REFERENCES regions(id),
  region_path_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  region_path_names_zh text[] NOT NULL DEFAULT ARRAY[]::text[],
  detail_address text NOT NULL,
  postal_code text,
  delivery_note text,
  market_scope text NOT NULL DEFAULT 'cn_mainland' CHECK (market_scope IN ('cn_mainland', 'hk_mo_tw', 'international')),
  parse_status text NOT NULL CHECK (parse_status IN ('structured', 'parsed_confirmed', 'manual_unstandardized', 'needs_confirmation')),
  domestic_deliverable boolean NOT NULL DEFAULT true,
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS address_snapshots_org_idx
  ON address_snapshots (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION forbid_address_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'address_snapshots rows are immutable after creation';
END;
$$;

DROP TRIGGER IF EXISTS address_snapshots_immutable ON address_snapshots;
CREATE TRIGGER address_snapshots_immutable
  BEFORE UPDATE OR DELETE ON address_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_address_snapshot_mutation();

CREATE TABLE IF NOT EXISTS region_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid REFERENCES region_dataset_versions(id),
  mode text NOT NULL CHECK (mode IN ('seed', 'import_draft', 'publish', 'rollback')),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  row_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
