-- 024: Full-Site Internationalization Registry, Independent User Preferences, Dynamic Translations,
-- and Immutable Historical Locale Snapshots (TASK-190)

-- 1. BCP47 Locale Registry: core en-US & zh-CN active; future locales isolated with enabled=false, selectable=false
CREATE TABLE IF NOT EXISTS i18n_locales (
  code text PRIMARY KEY,
  bcp47 text NOT NULL UNIQUE,
  native_label text NOT NULL,
  english_label text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  selectable boolean NOT NULL DEFAULT false,
  public_path_prefix text NOT NULL,
  legacy_db_code text NOT NULL,
  is_core boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT i18n_locales_core_always_enabled_check CHECK (NOT is_core OR (enabled = true AND selectable = true)),
  CONSTRAINT i18n_locales_selectable_requires_enabled_check CHECK (NOT selectable OR enabled = true)
);

INSERT INTO i18n_locales (code, bcp47, native_label, english_label, enabled, selectable, public_path_prefix, legacy_db_code, is_core)
VALUES
  ('en-US', 'en-US', 'English', 'English', true, true, '', 'en', true),
  ('zh-CN', 'zh-CN', '简体中文', 'Simplified Chinese', true, true, '/zh', 'zh-CN', true),
  ('fr-FR', 'fr-FR', 'Français', 'French', false, false, '/fr', 'fr-FR', false),
  ('es-ES', 'es-ES', 'Español', 'Spanish', false, false, '/es', 'es-ES', false)
ON CONFLICT (code) DO NOTHING;

-- 2. Three independent language preference columns on users (§53.2, I18N02)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ui_locale text REFERENCES i18n_locales(code);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_locale text REFERENCES i18n_locales(code);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS report_locale text CHECK (report_locale IS NULL OR report_locale IN ('en-US', 'zh-CN', 'both'));

-- 3. Extensible dynamic entity field translations (§53.1, §53.3)
CREATE TABLE IF NOT EXISTS i18n_dynamic_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (char_length(trim(entity_type)) >= 2),
  entity_id uuid NOT NULL,
  field_key text NOT NULL CHECK (char_length(trim(field_key)) >= 1),
  locale text NOT NULL REFERENCES i18n_locales(code),
  revision int NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_locale text NOT NULL REFERENCES i18n_locales(code),
  source_revision int NOT NULL DEFAULT 1 CHECK (source_revision >= 1),
  source_hash text NOT NULL,
  translated_text text,
  status text NOT NULL CHECK (
    status IN (
      'untranslated', 'queued', 'machine_draft', 'human_draft',
      'pending_review', 'approved', 'published', 'stale', 'failed'
    )
  ),
  translator_kind text NOT NULL DEFAULT 'human' CHECK (translator_kind IN ('human', 'ai')),
  human_locked boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, field_key, locale, revision)
);

CREATE INDEX IF NOT EXISTS i18n_dynamic_translations_lookup_idx
  ON i18n_dynamic_translations (entity_type, entity_id, locale, status, revision DESC);

-- 4. Immutable historical locale snapshots (§53.3, §53.5)
CREATE TABLE IF NOT EXISTS i18n_historical_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_version int NOT NULL CHECK (entity_version >= 1),
  locale text NOT NULL REFERENCES i18n_locales(code),
  source_hash text NOT NULL,
  frozen_fields jsonb NOT NULL,
  frozen_by uuid REFERENCES users(id),
  frozen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, entity_version, locale)
);

CREATE OR REPLACE FUNCTION prevent_i18n_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'I18N_SNAPSHOT_IMMUTABLE: frozen historical locale snapshots cannot be altered or deleted' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS i18n_historical_snapshots_immutable_guard ON i18n_historical_snapshots;
CREATE TRIGGER i18n_historical_snapshots_immutable_guard
  BEFORE UPDATE OR DELETE ON i18n_historical_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_i18n_snapshot_mutation();
