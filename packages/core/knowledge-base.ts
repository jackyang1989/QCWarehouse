import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, guard, lock, one, role, type Actor } from "./common";
import { resolvePublishedMeasurementForProductType } from "./measurement-templates";

export const KNOWLEDGE_READ_ROLES = [
  "super_admin",
  "template_admin",
  "reviewer",
  "warehouse_admin",
  "inspector",
  "support",
] as const;
export const KNOWLEDGE_EDIT_ROLES = ["super_admin", "template_admin"] as const;
export const KNOWLEDGE_REVIEW_ROLES = ["super_admin", "reviewer"] as const;

export const KNOWLEDGE_KINDS = [
  "complexity_level",
  "inspection_module",
  "product_type",
  "check_item",
  "garment_part",
  "defect_type",
  "rework_type",
  "terminology",
  "sop",
] as const;

export type KnowledgeEntityKind = (typeof KNOWLEDGE_KINDS)[number];

const KIND_TABLE: Record<KnowledgeEntityKind, { table: string; codeCol: string }> = {
  complexity_level: { table: "complexity_levels", codeCol: "code" },
  inspection_module: { table: "inspection_modules", codeCol: "code" },
  product_type: { table: "catalog_product_types", codeCol: "code" },
  check_item: { table: "knowledge_check_items", codeCol: "code" },
  garment_part: { table: "knowledge_garment_parts", codeCol: "code" },
  defect_type: { table: "knowledge_defect_types", codeCol: "code" },
  rework_type: { table: "knowledge_rework_types", codeCol: "code" },
  terminology: { table: "knowledge_terminology_entries", codeCol: "term_code" },
  sop: { table: "knowledge_sops", codeCol: "code" },
};

export function parseKnowledgeKind(raw: string): KnowledgeEntityKind {
  return z.enum(KNOWLEDGE_KINDS).parse(raw);
}

async function recordRevision(
  db: DB,
  kind: KnowledgeEntityKind,
  entityId: string,
  entityCode: string,
  version: number,
  action: "save_draft" | "clone" | "submit" | "publish" | "retire" | "rollback",
  actorId: string,
  snapshot: unknown,
  note?: string | null,
) {
  await db.query(
    `insert into knowledge_revision_history (
      entity_kind, entity_id, entity_code, version, action, actor_id, snapshot, note
    ) values ($1, $2::uuid, $3, $4::int, $5, $6::uuid, $7::jsonb, $8::text)`,
    [kind, entityId, entityCode, version, action, actorId, JSON.stringify(snapshot), note ?? null],
  );
}

function getCodeFromRow(kind: KnowledgeEntityKind, row: Record<string, unknown>): string {
  const col = KIND_TABLE[kind].codeCol;
  return String(row[col] ?? row.id ?? "");
}

export async function getKnowledgeCoverageMatrix(db: DB) {
  const complexity = await db.query<{ total: number; published: number; draft_prices: number }>(`
    select
      count(*)::int as total,
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where pricing_status = 'draft_unverified')::int as draft_prices
    from complexity_levels
  `);
  const modules = await db.query<{ total: number; published: number; base_count: number; addon_count: number; manual_count: number }>(`
    select
      count(*)::int as total,
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where module_tier = 'base_included')::int as base_count,
      count(*) filter (where module_tier = 'optional_addon')::int as addon_count,
      count(*) filter (where module_tier = 'manual_quote')::int as manual_count
    from inspection_modules
  `);
  const productTypes = await db.query<{
    total: number;
    apparel_total: number;
    apparel_published: number;
    apparel_sellable: number;
    non_apparel_total: number;
    non_apparel_sellable: number;
    retired: number;
  }>(`
    select
      count(*)::int as total,
      count(*) filter (where category_slug = 'apparel')::int as apparel_total,
      count(*) filter (where category_slug = 'apparel' and status = 'published')::int as apparel_published,
      count(*) filter (where category_slug = 'apparel' and public_sellable)::int as apparel_sellable,
      count(*) filter (where category_slug <> 'apparel')::int as non_apparel_total,
      count(*) filter (where category_slug <> 'apparel' and public_sellable)::int as non_apparel_sellable,
      count(*) filter (where status = 'retired')::int as retired
    from catalog_product_types
  `);
  const checkItems = await db.query<{ total: number; published: number }>(`
    select count(*)::int as total, count(*) filter (where status = 'published')::int as published from knowledge_check_items
  `);
  const parts = await db.query<{ total: number; published: number }>(`
    select count(*)::int as total, count(*) filter (where status = 'published')::int as published from knowledge_garment_parts
  `);
  const defects = await db.query<{ total: number; published: number }>(`
    select count(*)::int as total, count(*) filter (where status = 'published')::int as published from knowledge_defect_types
  `);
  const reworks = await db.query<{ total: number; published: number; platform_free: number }>(`
    select
      count(*)::int as total,
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where platform_fault_free_rework)::int as platform_free
    from knowledge_rework_types
  `);
  const terms = await db.query<{ total: number; published: number; distinct_terms: number }>(`
    select
      count(*)::int as total,
      count(*) filter (where status = 'published')::int as published,
      count(distinct term_code)::int as distinct_terms
    from knowledge_terminology_entries
  `);
  const sops = await db.query<{ total: number; published: number }>(`
    select count(*)::int as total, count(*) filter (where status = 'published')::int as published from knowledge_sops
  `);
  const seedRuns = await db.query(
    `select id, seed_version, actor_id, inserted_counts, skipped_existing_counts, ran_at
     from knowledge_seed_runs order by ran_at desc limit 10`,
  );

  const groupRows = (
    await db.query<{
      group_code: string;
      group_name_zh: string;
      group_name_en: string;
      category_slug: string;
      total: number;
      published: number;
      sellable: number;
    }>(`
      select group_code, min(group_name_zh) as group_name_zh, min(group_name_en) as group_name_en,
             min(category_slug) as category_slug,
             count(*)::int as total,
             count(*) filter (where status = 'published')::int as published,
             count(*) filter (where public_sellable)::int as sellable
      from catalog_product_types
      group by group_code
      order by min(sort_order)
    `)
  ).rows;

  return {
    complexity_levels: complexity.rows[0],
    inspection_modules: modules.rows[0],
    product_types: productTypes.rows[0],
    check_items: checkItems.rows[0],
    garment_parts: parts.rows[0],
    defect_types: defects.rows[0],
    rework_types: reworks.rows[0],
    terminology_entries: terms.rows[0],
    sops: sops.rows[0],
    groups: groupRows,
    seed_runs: seedRuns.rows,
  };
}

export async function listKnowledgeOverview(db: DB, actor: Actor) {
  role(actor, ...KNOWLEDGE_READ_ROLES);
  const matrix = await getKnowledgeCoverageMatrix(db);
  return {
    coverage_matrix: matrix,
    draft_pricing_notice:
      "All seeded L1-L5 complexity rates and M01-M11 module rates are unverified commercial drafts requiring formal pricing approval before commercial rollout.",
  };
}

export async function listKnowledgeEntities(
  db: DB,
  actor: Actor,
  kind: KnowledgeEntityKind,
  filters: { status?: string; group_code?: string; module_code?: string; locale?: string; search?: string } = {},
) {
  role(actor, ...KNOWLEDGE_READ_ROLES);
  const { table } = KIND_TABLE[kind];
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  if (filters.group_code) {
    if (kind === "product_type") {
      params.push(filters.group_code);
      where.push(`group_code = $${params.length}`);
    } else if (kind === "check_item" || kind === "garment_part" || kind === "defect_type" || kind === "sop") {
      params.push(filters.group_code);
      where.push(`$${params.length} = any(applicable_group_codes)`);
    }
  }
  if (filters.module_code && kind === "check_item") {
    params.push(filters.module_code);
    where.push(`module_code = $${params.length}`);
  }
  if (filters.locale && kind === "terminology") {
    params.push(filters.locale);
    where.push(`locale = $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const p = `$${params.length}`;
    if (kind === "terminology") {
      where.push(`(term_code ilike ${p} or standard_name ilike ${p} or definition ilike ${p})`);
    } else if (kind === "sop") {
      where.push(`(code ilike ${p} or title_zh ilike ${p} or title_en ilike ${p})`);
    } else {
      where.push(`(code ilike ${p} or name_zh ilike ${p} or name_en ilike ${p})`);
    }
  }

  const orderBy =
    kind === "terminology"
      ? "term_code asc, locale asc, version desc"
      : "sort_order asc, created_at asc";

  const sql = `select * from ${table}${where.length ? ` where ${where.join(" and ")}` : ""} order by ${orderBy}`;
  return { kind, items: (await db.query(sql, params)).rows };
}

const productTypeSaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
  category_slug: z.string().trim().min(2).max(60).default("apparel"),
  group_code: z.enum([
    "tops",
    "bottoms",
    "dresses_sets",
    "outerwear",
    "underwear_activewear",
    "special_apparel",
    "bags_non_open",
    "home_non_open",
  ]),
  group_name_zh: z.string().trim().min(1).max(120),
  group_name_en: z.string().trim().min(1).max(120),
  parent_type_id: z.string().uuid().nullable().optional(),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim().min(1).max(120)).default([]),
  default_complexity_code: z.enum(["L1", "L2", "L3", "L4", "L5"]),
  structural_options: z.array(z.record(z.string(), z.unknown())).default([]),
  billing_unit: z.enum(["piece", "set", "component"]).default("piece"),
  included_components: z.array(z.string().trim().min(1).max(80)).default([]),
  applicable_module_codes: z.array(z.string().trim().regex(/^M[0-9]{2}$/)).default(["M01", "M02", "M03", "M04"]),
  default_evidence_rules: z.record(z.string(), z.unknown()).default({}),
  quote_mode: z.enum(["online_standard", "conditional", "manual_quote"]).default("online_standard"),
  capability_status: z.enum(["ready", "requires_capability_approval", "not_admitted"]).default("ready"),
  sort_order: z.number().int().min(0).default(100),
  note: z.string().trim().max(500).optional(),
});

const moduleSaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().regex(/^M[0-9]{2}$/),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  description_zh: z.string().trim().max(1000).default(""),
  description_en: z.string().trim().max(1000).default(""),
  module_tier: z.enum(["base_included", "optional_addon", "manual_quote"]),
  billing_unit: z.enum(["included_in_base", "per_piece", "per_order", "per_item_batch", "manual_quote"]),
  suggested_price_cents: z.number().int().min(0).nullable().default(null),
  pricing_tiers: z.record(z.string(), z.unknown()).default({}),
  depends_on_codes: z.array(z.string().trim().regex(/^M[0-9]{2}$/)).default([]),
  conflicts_with_codes: z.array(z.string().trim().regex(/^M[0-9]{2}$/)).default([]),
  requires_capability_codes: z.array(z.string().trim().min(1).max(80)).default([]),
  scope_boundary_zh: z.string().trim().max(1000).default(""),
  scope_boundary_en: z.string().trim().max(1000).default(""),
  is_destructive_possible: z.boolean().default(false),
  requires_customer_authorization: z.boolean().default(false),
  sort_order: z.number().int().min(0).default(50),
  note: z.string().trim().max(500).optional(),
});

const complexitySaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.enum(["L1", "L2", "L3", "L4", "L5"]),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  description_zh: z.string().trim().max(1000).default(""),
  description_en: z.string().trim().max(1000).default(""),
  suggested_base_price_cents: z.number().int().min(0).nullable().default(null),
  pricing_mode: z.enum(["fixed_draft", "manual_quote"]),
  adjustment_factors: z.array(z.record(z.string(), z.unknown())).default([]),
  sort_order: z.number().int().min(0).default(10),
  note: z.string().trim().max(500).optional(),
});

const checkItemSaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(2).max(80),
  module_code: z.string().trim().regex(/^M[0-9]{2}$/),
  name_zh: z.string().trim().min(1).max(200),
  name_en: z.string().trim().min(1).max(200),
  method_zh: z.string().trim().min(1).max(1000),
  method_en: z.string().trim().min(1).max(1000),
  scope_limit_zh: z.string().trim().max(1000).default(""),
  scope_limit_en: z.string().trim().max(1000).default(""),
  applicable_group_codes: z.array(z.string().trim().min(1)).default([]),
  applicable_part_codes: z.array(z.string().trim().min(1)).default([]),
  evidence_requirement: z
    .enum(["mandatory_photo", "photo_if_defect", "measurement_record", "label_photo", "video_optional", "none"])
    .default("photo_if_defect"),
  billing_included_in_base: z.boolean().default(false),
  requires_capability_code: z.string().trim().min(1).max(80).nullable().optional(),
  sort_order: z.number().int().min(0).default(50),
  note: z.string().trim().max(500).optional(),
});

const garmentPartSaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(2).max(80),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  description_zh: z.string().trim().max(1000).default(""),
  description_en: z.string().trim().max(1000).default(""),
  applicable_group_codes: z.array(z.string().trim().min(1)).default([]),
  sort_order: z.number().int().min(0).default(50),
  note: z.string().trim().max(500).optional(),
});

const defectTypeSaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(2).max(80),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  category_group: z.string().trim().min(1).max(80),
  default_severity: z.enum(["minor", "major", "critical_safety"]),
  severity_guidance_zh: z.string().trim().min(1).max(1000),
  severity_guidance_en: z.string().trim().min(1).max(1000),
  non_aql_disclaimer_zh: z.string().trim().min(1).max(1000),
  non_aql_disclaimer_en: z.string().trim().min(1).max(1000),
  applicable_part_codes: z.array(z.string().trim().min(1)).default([]),
  applicable_group_codes: z.array(z.string().trim().min(1)).default([]),
  sort_order: z.number().int().min(0).default(50),
  note: z.string().trim().max(500).optional(),
});

const reworkTypeSaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(2).max(80),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  description_zh: z.string().trim().min(1).max(1000),
  description_en: z.string().trim().min(1).max(1000),
  platform_fault_free_rework: z.boolean().default(false),
  requires_customer_approval: z.boolean().default(false),
  sort_order: z.number().int().min(0).default(50),
  note: z.string().trim().max(500).optional(),
});

const terminologySaveSchema = z.object({
  id: z.string().uuid().optional(),
  term_code: z.string().trim().min(2).max(100),
  domain: z.enum(["garment_type", "measurement_pom", "defect", "part", "module", "sop", "boundary_disclaimer"]),
  locale: z.enum(["en-US", "zh-CN"]),
  standard_name: z.string().trim().min(1).max(200),
  definition: z.string().trim().min(1).max(2000),
  context_categories: z.array(z.string().trim().min(1)).default([]),
  synonyms: z.array(z.string().trim().min(1)).default([]),
  forbidden_translations: z.array(z.string().trim().min(1)).default([]),
  method_and_limits: z.string().trim().max(1000).default(""),
  source_license: z.string().trim().min(1).max(240).default("QC Warehouse Internal Bilingual Standard v1"),
  note: z.string().trim().max(500).optional(),
});

const sopSaveSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(2).max(80),
  title_zh: z.string().trim().min(1).max(200),
  title_en: z.string().trim().min(1).max(200),
  applicable_group_codes: z.array(z.string().trim().min(1)).default([]),
  applicable_module_codes: z.array(z.string().trim().min(1)).default([]),
  steps_zh: z.array(z.string().trim().min(1)).min(1),
  steps_en: z.array(z.string().trim().min(1)).min(1),
  safety_and_boundary_zh: z.string().trim().max(1000).default(""),
  safety_and_boundary_en: z.string().trim().max(1000).default(""),
  sort_order: z.number().int().min(0).default(50),
  note: z.string().trim().max(500).optional(),
});

export async function saveKnowledgeEntity(
  db: DB,
  actor: Actor,
  kind: KnowledgeEntityKind,
  rawInput: unknown,
  sessionHash: string,
) {
  role(actor, ...KNOWLEDGE_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `knowledge:write:${kind}`);

  if (kind === "product_type") {
    const input = productTypeSaveSchema.parse(rawInput);
    const catRow = (await db.query<{ id: string }>("select id from categories where slug = $1", [input.category_slug])).rows[0] ?? null;
    const existing = input.id
      ? (await db.query<{ id: string; status: string; version: number }>("select id, status, version from catalog_product_types where id = $1 for update", [input.id])).rows[0]
      : (await db.query<{ id: string; status: string; version: number }>("select id, status, version from catalog_product_types where code = $1 for update", [input.code])).rows[0];

    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update catalog_product_types set
            category_id = $2::uuid, category_slug = $3, group_code = $4, group_name_zh = $5, group_name_en = $6,
            parent_type_id = $7::uuid, name_zh = $8, name_en = $9, aliases = $10::jsonb,
            default_complexity_code = $11, structural_options = $12::jsonb, billing_unit = $13,
            included_components = $14::jsonb, applicable_module_codes = $15::text[],
            default_evidence_rules = $16::jsonb, quote_mode = $17, capability_status = $18,
            sort_order = $19::int, public_sellable = false, status = 'draft',
            version = version + 1,
            admin_modified = true, created_by = $20::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [
            existing.id,
            catRow?.id ?? null,
            input.category_slug,
            input.group_code,
            input.group_name_zh,
            input.group_name_en,
            input.parent_type_id ?? null,
            input.name_zh,
            input.name_en,
            JSON.stringify(input.aliases),
            input.default_complexity_code,
            JSON.stringify(input.structural_options),
            input.billing_unit,
            JSON.stringify(input.included_components),
            input.applicable_module_codes,
            JSON.stringify(input.default_evidence_rules),
            input.quote_mode,
            input.capability_status,
            input.sort_order,
            actor.id,
          ],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into catalog_product_types (
            code, category_id, category_slug, group_code, group_name_zh, group_name_en,
            parent_type_id, name_zh, name_en, aliases, default_complexity_code, structural_options,
            billing_unit, included_components, applicable_module_codes, default_evidence_rules,
            quote_mode, capability_status, sort_order, public_sellable, status,
            is_seed_default, admin_modified, created_by
          ) values (
            $1, $2::uuid, $3, $4, $5, $6,
            $7::uuid, $8, $9, $10::jsonb, $11, $12::jsonb,
            $13, $14::jsonb, $15::text[], $16::jsonb,
            $17, $18, $19::int, false, 'draft',
            false, true, $20::uuid
          ) returning *`,
          [
            input.code,
            catRow?.id ?? null,
            input.category_slug,
            input.group_code,
            input.group_name_zh,
            input.group_name_en,
            input.parent_type_id ?? null,
            input.name_zh,
            input.name_en,
            JSON.stringify(input.aliases),
            input.default_complexity_code,
            JSON.stringify(input.structural_options),
            input.billing_unit,
            JSON.stringify(input.included_components),
            input.applicable_module_codes,
            JSON.stringify(input.default_evidence_rules),
            input.quote_mode,
            input.capability_status,
            input.sort_order,
            actor.id,
          ],
        );

    await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "catalog_product_types", String(row.id), { code: row.code, version: row.version });
    return row;
  }

  if (kind === "inspection_module") {
    const input = moduleSaveSchema.parse(rawInput);
    const existing = input.id
      ? (await db.query<{ id: string }>("select id from inspection_modules where id = $1 for update", [input.id])).rows[0]
      : (await db.query<{ id: string }>("select id from inspection_modules where code = $1 for update", [input.code])).rows[0];
    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update inspection_modules set
            name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
            module_tier = $6, billing_unit = $7, suggested_price_cents = $8::int, pricing_tiers = $9::jsonb,
            pricing_status = 'draft_unverified', requires_commercial_approval = true,
            depends_on_codes = $10::text[], conflicts_with_codes = $11::text[],
            requires_capability_codes = $12::text[], scope_boundary_zh = $13, scope_boundary_en = $14,
            is_destructive_possible = $15::boolean, requires_customer_authorization = $16::boolean,
            sort_order = $17::int, status = 'draft',
            version = version + 1,
            admin_modified = true, created_by = $18::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [
            existing.id,
            input.name_zh,
            input.name_en,
            input.description_zh,
            input.description_en,
            input.module_tier,
            input.billing_unit,
            input.suggested_price_cents,
            JSON.stringify(input.pricing_tiers),
            input.depends_on_codes,
            input.conflicts_with_codes,
            input.requires_capability_codes,
            input.scope_boundary_zh,
            input.scope_boundary_en,
            input.is_destructive_possible,
            input.requires_customer_authorization,
            input.sort_order,
            actor.id,
          ],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into inspection_modules (
            code, name_zh, name_en, description_zh, description_en,
            module_tier, billing_unit, suggested_price_cents, pricing_tiers, pricing_status, requires_commercial_approval,
            depends_on_codes, conflicts_with_codes, requires_capability_codes,
            scope_boundary_zh, scope_boundary_en, is_destructive_possible, requires_customer_authorization,
            sort_order, status, is_seed_default, admin_modified, created_by
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8::int, $9::jsonb, 'draft_unverified', true,
            $10::text[], $11::text[], $12::text[], $13, $14, $15::boolean, $16::boolean,
            $17::int, 'draft', false, true, $18::uuid
          ) returning *`,
          [
            input.code,
            input.name_zh,
            input.name_en,
            input.description_zh,
            input.description_en,
            input.module_tier,
            input.billing_unit,
            input.suggested_price_cents,
            JSON.stringify(input.pricing_tiers),
            input.depends_on_codes,
            input.conflicts_with_codes,
            input.requires_capability_codes,
            input.scope_boundary_zh,
            input.scope_boundary_en,
            input.is_destructive_possible,
            input.requires_customer_authorization,
            input.sort_order,
            actor.id,
          ],
        );
    await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "inspection_modules", String(row.id), { code: row.code, version: row.version });
    return row;
  }

  if (kind === "complexity_level") {
    const input = complexitySaveSchema.parse(rawInput);
    const existing = input.id
      ? (await db.query<{ id: string }>("select id from complexity_levels where id = $1 for update", [input.id])).rows[0]
      : (await db.query<{ id: string }>("select id from complexity_levels where code = $1 for update", [input.code])).rows[0];
    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update complexity_levels set
            name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
            suggested_base_price_cents = $6::int, pricing_mode = $7, pricing_status = 'draft_unverified',
            requires_commercial_approval = true, adjustment_factors = $8::jsonb, sort_order = $9::int,
            status = 'draft',
            version = version + 1,
            admin_modified = true, created_by = $10::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [
            existing.id,
            input.name_zh,
            input.name_en,
            input.description_zh,
            input.description_en,
            input.suggested_base_price_cents,
            input.pricing_mode,
            JSON.stringify(input.adjustment_factors),
            input.sort_order,
            actor.id,
          ],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into complexity_levels (
            code, name_zh, name_en, description_zh, description_en,
            suggested_base_price_cents, pricing_mode, pricing_status, requires_commercial_approval,
            adjustment_factors, sort_order, status, is_seed_default, admin_modified, created_by
          ) values (
            $1, $2, $3, $4, $5, $6::int, $7, 'draft_unverified', true, $8::jsonb, $9::int,
            'draft', false, true, $10::uuid
          ) returning *`,
          [
            input.code,
            input.name_zh,
            input.name_en,
            input.description_zh,
            input.description_en,
            input.suggested_base_price_cents,
            input.pricing_mode,
            JSON.stringify(input.adjustment_factors),
            input.sort_order,
            actor.id,
          ],
        );
    await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "complexity_levels", String(row.id), { code: row.code, version: row.version });
    return row;
  }

  if (kind === "check_item") {
    const input = checkItemSaveSchema.parse(rawInput);
    const existing = input.id
      ? (await db.query<{ id: string }>("select id from knowledge_check_items where id = $1 for update", [input.id])).rows[0]
      : (await db.query<{ id: string }>("select id from knowledge_check_items where code = $1 for update", [input.code])).rows[0];
    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update knowledge_check_items set
            module_code = $2, name_zh = $3, name_en = $4, method_zh = $5, method_en = $6,
            scope_limit_zh = $7, scope_limit_en = $8, applicable_group_codes = $9::text[],
            applicable_part_codes = $10::text[], evidence_requirement = $11,
            billing_included_in_base = $12::boolean, requires_capability_code = $13::text,
            sort_order = $14::int, status = 'draft',
            version = version + 1,
            admin_modified = true, created_by = $15::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [
            existing.id,
            input.module_code,
            input.name_zh,
            input.name_en,
            input.method_zh,
            input.method_en,
            input.scope_limit_zh,
            input.scope_limit_en,
            input.applicable_group_codes,
            input.applicable_part_codes,
            input.evidence_requirement,
            input.billing_included_in_base,
            input.requires_capability_code ?? null,
            input.sort_order,
            actor.id,
          ],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into knowledge_check_items (
            code, module_code, name_zh, name_en, method_zh, method_en,
            scope_limit_zh, scope_limit_en, applicable_group_codes, applicable_part_codes,
            evidence_requirement, billing_included_in_base, requires_capability_code,
            sort_order, status, is_seed_default, admin_modified, created_by
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12::boolean, $13::text,
            $14::int, 'draft', false, true, $15::uuid
          ) returning *`,
          [
            input.code,
            input.module_code,
            input.name_zh,
            input.name_en,
            input.method_zh,
            input.method_en,
            input.scope_limit_zh,
            input.scope_limit_en,
            input.applicable_group_codes,
            input.applicable_part_codes,
            input.evidence_requirement,
            input.billing_included_in_base,
            input.requires_capability_code ?? null,
            input.sort_order,
            actor.id,
          ],
        );
    await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "knowledge_check_items", String(row.id), { code: row.code, version: row.version });
    return row;
  }

  if (kind === "garment_part") {
    const input = garmentPartSaveSchema.parse(rawInput);
    const existing = input.id
      ? (await db.query<{ id: string }>("select id from knowledge_garment_parts where id = $1 for update", [input.id])).rows[0]
      : (await db.query<{ id: string }>("select id from knowledge_garment_parts where code = $1 for update", [input.code])).rows[0];
    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update knowledge_garment_parts set
            name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
            applicable_group_codes = $6::text[], sort_order = $7::int, status = 'draft',
            version = version + 1,
            admin_modified = true, created_by = $8::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [existing.id, input.name_zh, input.name_en, input.description_zh, input.description_en, input.applicable_group_codes, input.sort_order, actor.id],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into knowledge_garment_parts (
            code, name_zh, name_en, description_zh, description_en,
            applicable_group_codes, sort_order, status, is_seed_default, admin_modified, created_by
          ) values ($1, $2, $3, $4, $5, $6::text[], $7::int, 'draft', false, true, $8::uuid) returning *`,
          [input.code, input.name_zh, input.name_en, input.description_zh, input.description_en, input.applicable_group_codes, input.sort_order, actor.id],
        );
    await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "knowledge_garment_parts", String(row.id), { code: row.code, version: row.version });
    return row;
  }

  if (kind === "defect_type") {
    const input = defectTypeSaveSchema.parse(rawInput);
    const existing = input.id
      ? (await db.query<{ id: string }>("select id from knowledge_defect_types where id = $1 for update", [input.id])).rows[0]
      : (await db.query<{ id: string }>("select id from knowledge_defect_types where code = $1 for update", [input.code])).rows[0];
    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update knowledge_defect_types set
            name_zh = $2, name_en = $3, category_group = $4, default_severity = $5,
            severity_guidance_zh = $6, severity_guidance_en = $7, non_aql_disclaimer_zh = $8, non_aql_disclaimer_en = $9,
            applicable_part_codes = $10::text[], applicable_group_codes = $11::text[], sort_order = $12::int,
            status = 'draft', version = version + 1,
            admin_modified = true, created_by = $13::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [
            existing.id,
            input.name_zh,
            input.name_en,
            input.category_group,
            input.default_severity,
            input.severity_guidance_zh,
            input.severity_guidance_en,
            input.non_aql_disclaimer_zh,
            input.non_aql_disclaimer_en,
            input.applicable_part_codes,
            input.applicable_group_codes,
            input.sort_order,
            actor.id,
          ],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into knowledge_defect_types (
            code, name_zh, name_en, category_group, default_severity,
            severity_guidance_zh, severity_guidance_en, non_aql_disclaimer_zh, non_aql_disclaimer_en,
            applicable_part_codes, applicable_group_codes, sort_order,
            status, is_seed_default, admin_modified, created_by
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::text[],$12::int,'draft',false,true,$13::uuid) returning *`,
          [
            input.code,
            input.name_zh,
            input.name_en,
            input.category_group,
            input.default_severity,
            input.severity_guidance_zh,
            input.severity_guidance_en,
            input.non_aql_disclaimer_zh,
            input.non_aql_disclaimer_en,
            input.applicable_part_codes,
            input.applicable_group_codes,
            input.sort_order,
            actor.id,
          ],
        );
    await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "knowledge_defect_types", String(row.id), { code: row.code, version: row.version });
    return row;
  }

  if (kind === "rework_type") {
    const input = reworkTypeSaveSchema.parse(rawInput);
    const existing = input.id
      ? (await db.query<{ id: string }>("select id from knowledge_rework_types where id = $1 for update", [input.id])).rows[0]
      : (await db.query<{ id: string }>("select id from knowledge_rework_types where code = $1 for update", [input.code])).rows[0];
    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update knowledge_rework_types set
            name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
            platform_fault_free_rework = $6::boolean, requires_customer_approval = $7::boolean,
            sort_order = $8::int, status = 'draft',
            version = version + 1,
            admin_modified = true, created_by = $9::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [
            existing.id,
            input.name_zh,
            input.name_en,
            input.description_zh,
            input.description_en,
            input.platform_fault_free_rework,
            input.requires_customer_approval,
            input.sort_order,
            actor.id,
          ],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into knowledge_rework_types (
            code, name_zh, name_en, description_zh, description_en,
            platform_fault_free_rework, requires_customer_approval, sort_order,
            status, is_seed_default, admin_modified, created_by
          ) values ($1,$2,$3,$4,$5,$6::boolean,$7::boolean,$8::int,'draft',false,true,$9::uuid) returning *`,
          [
            input.code,
            input.name_zh,
            input.name_en,
            input.description_zh,
            input.description_en,
            input.platform_fault_free_rework,
            input.requires_customer_approval,
            input.sort_order,
            actor.id,
          ],
        );
    await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "knowledge_rework_types", String(row.id), { code: row.code, version: row.version });
    return row;
  }

  if (kind === "terminology") {
    const input = terminologySaveSchema.parse(rawInput);
    const existing = input.id
      ? (await db.query<{ id: string }>("select id from knowledge_terminology_entries where id = $1 for update", [input.id])).rows[0]
      : (
          await db.query<{ id: string }>(
            "select id from knowledge_terminology_entries where term_code = $1 and locale = $2 order by version desc limit 1 for update",
            [input.term_code, input.locale],
          )
        ).rows[0];
    const row = existing
      ? await one<Record<string, unknown>>(
          db,
          `update knowledge_terminology_entries set
            domain = $2, standard_name = $3, definition = $4,
            context_categories = $5::text[], synonyms = $6::text[],
            forbidden_translations = $7::text[], method_and_limits = $8, source_license = $9,
            status = 'draft', version = version + 1,
            admin_modified = true, created_by = $10::uuid, submitted_by = null, approved_by = null,
            published_at = null, retired_at = null, updated_at = now()
          where id = $1::uuid returning *`,
          [
            existing.id,
            input.domain,
            input.standard_name,
            input.definition,
            input.context_categories,
            input.synonyms,
            input.forbidden_translations,
            input.method_and_limits,
            input.source_license,
            actor.id,
          ],
        )
      : await one<Record<string, unknown>>(
          db,
          `insert into knowledge_terminology_entries (
            term_code, domain, locale, version, standard_name, definition,
            context_categories, synonyms, forbidden_translations, method_and_limits,
            source_license, status, is_seed_default, admin_modified, created_by
          ) values ($1,$2,$3,1,$4,$5,$6::text[],$7::text[],$8::text[],$9,$10,'draft',false,true,$11::uuid) returning *`,
          [
            input.term_code,
            input.domain,
            input.locale,
            input.standard_name,
            input.definition,
            input.context_categories,
            input.synonyms,
            input.forbidden_translations,
            input.method_and_limits,
            input.source_license,
            actor.id,
          ],
        );
    await recordRevision(db, kind, String(row.id), String(row.term_code), Number(row.version), "save_draft", actor.id, row, input.note);
    await audit(db, actor, "knowledge_save_draft", "knowledge_terminology_entries", String(row.id), { term_code: row.term_code, locale: row.locale, version: row.version });
    return row;
  }

  // sop
  const input = sopSaveSchema.parse(rawInput);
  const existing = input.id
    ? (await db.query<{ id: string }>("select id from knowledge_sops where id = $1 for update", [input.id])).rows[0]
    : (await db.query<{ id: string }>("select id from knowledge_sops where code = $1 for update", [input.code])).rows[0];
  const row = existing
    ? await one<Record<string, unknown>>(
        db,
        `update knowledge_sops set
          title_zh = $2, title_en = $3, applicable_group_codes = $4::text[], applicable_module_codes = $5::text[],
          steps_zh = $6::jsonb, steps_en = $7::jsonb, safety_and_boundary_zh = $8, safety_and_boundary_en = $9,
          sort_order = $10::int, status = 'draft',
          version = version + 1,
          admin_modified = true, created_by = $11::uuid, submitted_by = null, approved_by = null,
          published_at = null, retired_at = null, updated_at = now()
        where id = $1::uuid returning *`,
        [
          existing.id,
          input.title_zh,
          input.title_en,
          input.applicable_group_codes,
          input.applicable_module_codes,
          JSON.stringify(input.steps_zh),
          JSON.stringify(input.steps_en),
          input.safety_and_boundary_zh,
          input.safety_and_boundary_en,
          input.sort_order,
          actor.id,
        ],
      )
    : await one<Record<string, unknown>>(
        db,
        `insert into knowledge_sops (
          code, title_zh, title_en, applicable_group_codes, applicable_module_codes,
          steps_zh, steps_en, safety_and_boundary_zh, safety_and_boundary_en,
          sort_order, status, is_seed_default, admin_modified, created_by
        ) values ($1,$2,$3,$4::text[],$5::text[],$6::jsonb,$7::jsonb,$8,$9,$10::int,'draft',false,true,$11::uuid) returning *`,
        [
          input.code,
          input.title_zh,
          input.title_en,
          input.applicable_group_codes,
          input.applicable_module_codes,
          JSON.stringify(input.steps_zh),
          JSON.stringify(input.steps_en),
          input.safety_and_boundary_zh,
          input.safety_and_boundary_en,
          input.sort_order,
          actor.id,
        ],
      );
  await recordRevision(db, kind, String(row.id), String(row.code), Number(row.version), "save_draft", actor.id, row, input.note);
  await audit(db, actor, "knowledge_save_draft", "knowledge_sops", String(row.id), { code: row.code, version: row.version });
  return row;
}

export async function cloneProductType(
  db: DB,
  actor: Actor,
  sourceId: string,
  input: { code: string; name_zh: string; name_en: string; note?: string },
  sessionHash: string,
) {
  role(actor, ...KNOWLEDGE_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const parsed = z
    .object({
      code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
      name_zh: z.string().trim().min(1).max(160),
      name_en: z.string().trim().min(1).max(160),
      note: z.string().trim().max(500).optional(),
    })
    .parse(input);
  const src = await one<Record<string, unknown>>(db, "select * from catalog_product_types where id = $1::uuid", [sourceId]);
  const inserted = await one<Record<string, unknown>>(
    db,
    `insert into catalog_product_types (
      code, category_id, category_slug, group_code, group_name_zh, group_name_en,
      parent_type_id, name_zh, name_en, aliases, default_complexity_code, structural_options,
      billing_unit, included_components, applicable_module_codes, default_evidence_rules,
      quote_mode, capability_status, public_sellable, status, sort_order,
      is_seed_default, admin_modified, created_by
    ) values (
      $1, $2::uuid, $3, $4, $5, $6,
      $7::uuid, $8, $9, $10::jsonb, $11, $12::jsonb,
      $13, $14::jsonb, $15::text[], $16::jsonb,
      $17, $18, false, 'draft', $19::int,
      false, true, $20::uuid
    ) returning *`,
    [
      parsed.code,
      src.category_id ?? null,
      src.category_slug,
      src.group_code,
      src.group_name_zh,
      src.group_name_en,
      src.id,
      parsed.name_zh,
      parsed.name_en,
      JSON.stringify(src.aliases ?? []),
      src.default_complexity_code,
      JSON.stringify(src.structural_options ?? []),
      src.billing_unit,
      JSON.stringify(src.included_components ?? []),
      src.applicable_module_codes ?? [],
      JSON.stringify(src.default_evidence_rules ?? {}),
      src.quote_mode,
      src.capability_status,
      Number(src.sort_order ?? 100) + 1,
      actor.id,
    ],
  );
  await recordRevision(db, "product_type", String(inserted.id), String(inserted.code), 1, "clone", actor.id, inserted, parsed.note ?? `Cloned from ${src.code}`);
  await audit(db, actor, "knowledge_clone_product_type", "catalog_product_types", String(inserted.id), { source_id: sourceId, code: inserted.code });
  return inserted;
}

export async function submitKnowledgeEntity(
  db: DB,
  actor: Actor,
  kind: KnowledgeEntityKind,
  id: string,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...KNOWLEDGE_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const { table } = KIND_TABLE[kind];
  const cur = await one<Record<string, unknown>>(db, `select * from ${table} where id = $1::uuid for update`, [id]);
  guard(cur.status === "draft" || cur.status === "in_review", "INVALID_STATE", "Only draft or in-review knowledge entries can be submitted.", 422);
  const row = await one<Record<string, unknown>>(
    db,
    `update ${table} set status = 'in_review', submitted_by = $2::uuid, updated_at = now() where id = $1::uuid returning *`,
    [id, actor.id],
  );
  await recordRevision(db, kind, id, getCodeFromRow(kind, row), Number(row.version), "submit", actor.id, row, note);
  await audit(db, actor, "knowledge_submit", table, id, { kind, code: getCodeFromRow(kind, row) });
  return row;
}

export async function publishKnowledgeEntity(
  db: DB,
  actor: Actor,
  kind: KnowledgeEntityKind,
  id: string,
  input: { public_sellable?: boolean; note?: string },
  sessionHash: string,
) {
  role(actor, ...KNOWLEDGE_REVIEW_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const { table } = KIND_TABLE[kind];
  const cur = await one<Record<string, unknown>>(db, `select * from ${table} where id = $1::uuid for update`, [id]);
  guard(cur.status === "in_review" || cur.status === "draft", "INVALID_STATE", "Only draft or in-review knowledge entries can be published.", 422);
  guard(
    cur.created_by && cur.created_by !== actor.id && cur.submitted_by !== actor.id,
    "SELF_REVIEW_FORBIDDEN",
    "An author or submitter cannot independently approve and publish their own knowledge entry.",
    403,
  );

  if (kind === "product_type") {
    const wantSellable = input.public_sellable ?? cur.category_slug === "apparel";
    if (wantSellable) {
      guard(
        cur.capability_status !== "not_admitted",
        "CATEGORY_NOT_ADMITTED",
        `Product type ${String(cur.code)} is marked '${String(cur.capability_status)}' and cannot be publicly opened.`,
        422,
      );
      const cat = (
        await db.query<{ status: string }>("select status from categories where slug = $1", [String(cur.category_slug)])
      ).rows[0];
      guard(
        Boolean(cat && cat.status === "ACTIVE"),
        "CATEGORY_NOT_ADMITTED",
        `Category '${String(cur.category_slug)}' is not ACTIVE/admitted for public sale.`,
        422,
      );
    }
    const row = await one<Record<string, unknown>>(
      db,
      `update catalog_product_types set
        status = 'published', public_sellable = $3::boolean, approved_by = $2::uuid, published_at = now(), updated_at = now()
       where id = $1::uuid returning *`,
      [id, actor.id, wantSellable],
    );
    await recordRevision(db, kind, id, String(row.code), Number(row.version), "publish", actor.id, row, input.note);
    await audit(db, actor, "knowledge_publish", table, id, { kind, code: row.code, public_sellable: wantSellable });
    return row;
  }

  const row = await one<Record<string, unknown>>(
    db,
    `update ${table} set status = 'published', approved_by = $2::uuid, published_at = now(), updated_at = now()
     where id = $1::uuid returning *`,
    [id, actor.id],
  );
  await recordRevision(db, kind, id, getCodeFromRow(kind, row), Number(row.version), "publish", actor.id, row, input.note);
  await audit(db, actor, "knowledge_publish", table, id, { kind, code: getCodeFromRow(kind, row) });
  return row;
}

export async function batchKnowledgeTransition(
  db: DB,
  actor: Actor,
  action: "submit" | "publish",
  kind: KnowledgeEntityKind,
  ids: string[],
  input: { public_sellable?: boolean; note?: string },
  sessionHash: string,
) {
  const uniqueIds = [...new Set(ids)];
  guard(uniqueIds.length > 0 && uniqueIds.length <= 200, "VALIDATION_FAILED", "Provide 1-200 entity ids.", 422);
  const results = [];
  for (const id of uniqueIds) {
    if (action === "submit") {
      results.push(await submitKnowledgeEntity(db, actor, kind, id, input.note, sessionHash));
    } else {
      results.push(await publishKnowledgeEntity(db, actor, kind, id, input, sessionHash));
    }
  }
  return { kind, action, count: results.length, items: results };
}

export async function retireKnowledgeEntity(
  db: DB,
  actor: Actor,
  kind: KnowledgeEntityKind,
  id: string,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...KNOWLEDGE_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const { table } = KIND_TABLE[kind];
  await one(db, `select id from ${table} where id = $1::uuid for update`, [id]);
  const extraSet = kind === "product_type" ? ", public_sellable = false" : "";
  const row = await one<Record<string, unknown>>(
    db,
    `update ${table} set status = 'retired', retired_at = now(), updated_at = now()${extraSet} where id = $1::uuid returning *`,
    [id],
  );
  await recordRevision(db, kind, id, getCodeFromRow(kind, row), Number(row.version), "retire", actor.id, row, note);
  await audit(db, actor, "knowledge_retire", table, id, { kind, code: getCodeFromRow(kind, row), note });
  return row;
}

export async function rollbackKnowledgeEntity(
  db: DB,
  actor: Actor,
  kind: KnowledgeEntityKind,
  id: string,
  targetVersion: number,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...KNOWLEDGE_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const { table } = KIND_TABLE[kind];
  const current = await one<Record<string, unknown>>(db, `select * from ${table} where id = $1::uuid for update`, [id]);
  const rev = (
    await db.query<{ snapshot: Record<string, unknown> }>(
      `select snapshot from knowledge_revision_history
       where entity_kind = $1 and entity_id = $2::uuid and version = $3::int
       order by created_at desc limit 1`,
      [kind, id, targetVersion],
    )
  ).rows[0];
  guard(rev, "NOT_FOUND", `No revision snapshot found for version ${targetVersion}.`, 404);
  const snap = rev.snapshot;
  const nextVer = Number(current.version ?? 1) + 1;

  let restored: Record<string, unknown>;
  if (kind === "product_type") {
    restored = await one<Record<string, unknown>>(
      db,
      `update catalog_product_types set
        category_id = $2::uuid, category_slug = $3, group_code = $4, group_name_zh = $5, group_name_en = $6,
        parent_type_id = $7::uuid, name_zh = $8, name_en = $9, aliases = $10::jsonb,
        default_complexity_code = $11, structural_options = $12::jsonb, billing_unit = $13,
        included_components = $14::jsonb, applicable_module_codes = $15::text[],
        default_evidence_rules = $16::jsonb, quote_mode = $17, capability_status = $18, sort_order = $19::int,
        public_sellable = false, status = 'draft', version = $20::int,
        admin_modified = true, created_by = $21::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        snap.category_id != null ? String(snap.category_id) : null,
        String(snap.category_slug ?? current.category_slug),
        String(snap.group_code ?? current.group_code),
        String(snap.group_name_zh ?? current.group_name_zh),
        String(snap.group_name_en ?? current.group_name_en),
        snap.parent_type_id != null ? String(snap.parent_type_id) : null,
        String(snap.name_zh ?? current.name_zh),
        String(snap.name_en ?? current.name_en),
        JSON.stringify(snap.aliases ?? current.aliases ?? []),
        String(snap.default_complexity_code ?? current.default_complexity_code),
        JSON.stringify(snap.structural_options ?? current.structural_options ?? []),
        String(snap.billing_unit ?? current.billing_unit),
        JSON.stringify(snap.included_components ?? current.included_components ?? []),
        Array.isArray(snap.applicable_module_codes) ? snap.applicable_module_codes : (current.applicable_module_codes ?? []),
        JSON.stringify(snap.default_evidence_rules ?? current.default_evidence_rules ?? {}),
        String(snap.quote_mode ?? current.quote_mode),
        String(snap.capability_status ?? current.capability_status),
        Number(snap.sort_order ?? current.sort_order ?? 100),
        nextVer,
        actor.id,
      ],
    );
  } else if (kind === "inspection_module") {
    restored = await one<Record<string, unknown>>(
      db,
      `update inspection_modules set
        name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
        module_tier = $6, billing_unit = $7, suggested_price_cents = $8::int, pricing_tiers = $9::jsonb,
        pricing_status = 'draft_unverified', requires_commercial_approval = true,
        depends_on_codes = $10::text[], conflicts_with_codes = $11::text[],
        requires_capability_codes = $12::text[], scope_boundary_zh = $13, scope_boundary_en = $14,
        is_destructive_possible = $15::boolean, requires_customer_authorization = $16::boolean,
        status = 'draft', version = $17::int, admin_modified = true,
        created_by = $18::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.name_zh ?? current.name_zh),
        String(snap.name_en ?? current.name_en),
        String(snap.description_zh ?? current.description_zh),
        String(snap.description_en ?? current.description_en),
        String(snap.module_tier ?? current.module_tier),
        String(snap.billing_unit ?? current.billing_unit),
        snap.suggested_price_cents != null ? Number(snap.suggested_price_cents) : null,
        JSON.stringify(snap.pricing_tiers ?? current.pricing_tiers ?? {}),
        Array.isArray(snap.depends_on_codes) ? snap.depends_on_codes : (current.depends_on_codes ?? []),
        Array.isArray(snap.conflicts_with_codes) ? snap.conflicts_with_codes : (current.conflicts_with_codes ?? []),
        Array.isArray(snap.requires_capability_codes) ? snap.requires_capability_codes : (current.requires_capability_codes ?? []),
        String(snap.scope_boundary_zh ?? current.scope_boundary_zh),
        String(snap.scope_boundary_en ?? current.scope_boundary_en),
        Boolean(snap.is_destructive_possible ?? current.is_destructive_possible),
        Boolean(snap.requires_customer_authorization ?? current.requires_customer_authorization),
        nextVer,
        actor.id,
      ],
    );
  } else if (kind === "complexity_level") {
    restored = await one<Record<string, unknown>>(
      db,
      `update complexity_levels set
        name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
        suggested_base_price_cents = $6::int, pricing_mode = $7, pricing_status = 'draft_unverified',
        requires_commercial_approval = true, adjustment_factors = $8::jsonb,
        status = 'draft', version = $9::int, admin_modified = true,
        created_by = $10::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.name_zh ?? current.name_zh),
        String(snap.name_en ?? current.name_en),
        String(snap.description_zh ?? current.description_zh),
        String(snap.description_en ?? current.description_en),
        snap.suggested_base_price_cents != null ? Number(snap.suggested_base_price_cents) : null,
        String(snap.pricing_mode ?? current.pricing_mode),
        JSON.stringify(snap.adjustment_factors ?? current.adjustment_factors ?? []),
        nextVer,
        actor.id,
      ],
    );
  } else if (kind === "check_item") {
    restored = await one<Record<string, unknown>>(
      db,
      `update knowledge_check_items set
        module_code = $2, name_zh = $3, name_en = $4, method_zh = $5, method_en = $6,
        scope_limit_zh = $7, scope_limit_en = $8, applicable_group_codes = $9::text[],
        applicable_part_codes = $10::text[], evidence_requirement = $11,
        billing_included_in_base = $12::boolean, requires_capability_code = $13::text,
        status = 'draft', version = $14::int, admin_modified = true,
        created_by = $15::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.module_code ?? current.module_code),
        String(snap.name_zh ?? current.name_zh),
        String(snap.name_en ?? current.name_en),
        String(snap.method_zh ?? current.method_zh),
        String(snap.method_en ?? current.method_en),
        String(snap.scope_limit_zh ?? current.scope_limit_zh),
        String(snap.scope_limit_en ?? current.scope_limit_en),
        Array.isArray(snap.applicable_group_codes) ? snap.applicable_group_codes : (current.applicable_group_codes ?? []),
        Array.isArray(snap.applicable_part_codes) ? snap.applicable_part_codes : (current.applicable_part_codes ?? []),
        String(snap.evidence_requirement ?? current.evidence_requirement),
        Boolean(snap.billing_included_in_base ?? current.billing_included_in_base),
        snap.requires_capability_code ? String(snap.requires_capability_code) : null,
        nextVer,
        actor.id,
      ],
    );
  } else if (kind === "garment_part") {
    restored = await one<Record<string, unknown>>(
      db,
      `update knowledge_garment_parts set
        name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
        applicable_group_codes = $6::text[], status = 'draft', version = $7::int, admin_modified = true,
        created_by = $8::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.name_zh ?? current.name_zh),
        String(snap.name_en ?? current.name_en),
        String(snap.description_zh ?? current.description_zh),
        String(snap.description_en ?? current.description_en),
        Array.isArray(snap.applicable_group_codes) ? snap.applicable_group_codes : (current.applicable_group_codes ?? []),
        nextVer,
        actor.id,
      ],
    );
  } else if (kind === "defect_type") {
    restored = await one<Record<string, unknown>>(
      db,
      `update knowledge_defect_types set
        name_zh = $2, name_en = $3, category_group = $4, default_severity = $5,
        severity_guidance_zh = $6, severity_guidance_en = $7, non_aql_disclaimer_zh = $8, non_aql_disclaimer_en = $9,
        applicable_part_codes = $10::text[], applicable_group_codes = $11::text[],
        status = 'draft', version = $12::int, admin_modified = true,
        created_by = $13::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.name_zh ?? current.name_zh),
        String(snap.name_en ?? current.name_en),
        String(snap.category_group ?? current.category_group),
        String(snap.default_severity ?? current.default_severity),
        String(snap.severity_guidance_zh ?? current.severity_guidance_zh),
        String(snap.severity_guidance_en ?? current.severity_guidance_en),
        String(snap.non_aql_disclaimer_zh ?? current.non_aql_disclaimer_zh),
        String(snap.non_aql_disclaimer_en ?? current.non_aql_disclaimer_en),
        Array.isArray(snap.applicable_part_codes) ? snap.applicable_part_codes : (current.applicable_part_codes ?? []),
        Array.isArray(snap.applicable_group_codes) ? snap.applicable_group_codes : (current.applicable_group_codes ?? []),
        nextVer,
        actor.id,
      ],
    );
  } else if (kind === "rework_type") {
    restored = await one<Record<string, unknown>>(
      db,
      `update knowledge_rework_types set
        name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
        platform_fault_free_rework = $6::boolean, requires_customer_approval = $7::boolean,
        status = 'draft', version = $8::int, admin_modified = true,
        created_by = $9::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.name_zh ?? current.name_zh),
        String(snap.name_en ?? current.name_en),
        String(snap.description_zh ?? current.description_zh),
        String(snap.description_en ?? current.description_en),
        Boolean(snap.platform_fault_free_rework ?? current.platform_fault_free_rework),
        Boolean(snap.requires_customer_approval ?? current.requires_customer_approval),
        nextVer,
        actor.id,
      ],
    );
  } else if (kind === "terminology") {
    restored = await one<Record<string, unknown>>(
      db,
      `update knowledge_terminology_entries set
        domain = $2, standard_name = $3, definition = $4,
        context_categories = $5::text[], synonyms = $6::text[],
        forbidden_translations = $7::text[], method_and_limits = $8, source_license = $9,
        status = 'draft', version = $10::int, admin_modified = true,
        created_by = $11::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.domain ?? current.domain),
        String(snap.standard_name ?? current.standard_name),
        String(snap.definition ?? current.definition),
        Array.isArray(snap.context_categories) ? snap.context_categories : (current.context_categories ?? []),
        Array.isArray(snap.synonyms) ? snap.synonyms : (current.synonyms ?? []),
        Array.isArray(snap.forbidden_translations) ? snap.forbidden_translations : (current.forbidden_translations ?? []),
        String(snap.method_and_limits ?? current.method_and_limits),
        String(snap.source_license ?? current.source_license),
        nextVer,
        actor.id,
      ],
    );
  } else {
    restored = await one<Record<string, unknown>>(
      db,
      `update knowledge_sops set
        title_zh = $2, title_en = $3, applicable_group_codes = $4::text[], applicable_module_codes = $5::text[],
        steps_zh = $6::jsonb, steps_en = $7::jsonb, safety_and_boundary_zh = $8, safety_and_boundary_en = $9,
        status = 'draft', version = $10::int, admin_modified = true,
        created_by = $11::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        id,
        String(snap.title_zh ?? current.title_zh),
        String(snap.title_en ?? current.title_en),
        Array.isArray(snap.applicable_group_codes) ? snap.applicable_group_codes : (current.applicable_group_codes ?? []),
        Array.isArray(snap.applicable_module_codes) ? snap.applicable_module_codes : (current.applicable_module_codes ?? []),
        JSON.stringify(snap.steps_zh ?? current.steps_zh ?? []),
        JSON.stringify(snap.steps_en ?? current.steps_en ?? []),
        String(snap.safety_and_boundary_zh ?? current.safety_and_boundary_zh),
        String(snap.safety_and_boundary_en ?? current.safety_and_boundary_en),
        nextVer,
        actor.id,
      ],
    );
  }

  await recordRevision(
    db,
    kind,
    id,
    getCodeFromRow(kind, restored),
    nextVer,
    "rollback",
    actor.id,
    restored,
    note ?? `Rolled back to v${targetVersion} as new draft v${nextVer}`,
  );
  await audit(db, actor, "knowledge_rollback_to_draft", table, id, { kind, target_version: targetVersion, new_version: nextVer });
  return restored;
}

export async function getKnowledgeRevisionHistory(db: DB, actor: Actor, kind: KnowledgeEntityKind, id: string) {
  role(actor, ...KNOWLEDGE_READ_ROLES);
  return (
    await db.query(
      `select id, entity_kind, entity_id, entity_code, version, action, actor_id, snapshot, note, created_at
       from knowledge_revision_history
       where entity_kind = $1 and entity_id = $2::uuid
       order by created_at desc`,
      [kind, id],
    )
  ).rows;
}

export async function exportKnowledgeSnapshot(db: DB, actor: Actor, sessionHash: string, kind?: KnowledgeEntityKind) {
  role(actor, ...KNOWLEDGE_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const kinds = kind ? [kind] : [...KNOWLEDGE_KINDS];
  const payload: Record<string, unknown[]> = {};
  for (const k of kinds) {
    const res = await listKnowledgeEntities(db, actor, k);
    payload[k] = res.items;
  }
  await audit(db, actor, "knowledge_export", "knowledge_base", null, { kind: kind ?? "all", kinds });
  return {
    exported_at: new Date().toISOString(),
    kinds,
    data: payload,
  };
}

/**
 * Resolve published dynamic translations (from Wave 17/20 i18n_dynamic_translations)
 * so bilingual edits published via <BilingualEntityPanel> reflect in live consumers.
 */
async function loadPublishedTranslationOverlays(db: DB, entityTypes: string[], entityIds: string[]) {
  if (entityIds.length === 0) return new Map<string, string>();
  const rows = (
    await db.query<{
      entity_type: string;
      entity_id: string;
      field_key: string;
      locale: string;
      translated_text: string;
    }>(
      `select distinct on (entity_type, entity_id, field_key, locale)
         entity_type, entity_id::text, field_key, locale, translated_text
       from i18n_dynamic_translations
       where status = 'published'
         and entity_type = any($1::text[])
         and entity_id = any($2::uuid[])
       order by entity_type, entity_id, field_key, locale, revision desc`,
      [entityTypes, entityIds],
    )
  ).rows;
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(`${r.entity_type}:${r.entity_id}:${r.field_key}:${r.locale}`, r.translated_text);
  }
  return map;
}

/**
 * Customer/Public Catalog consumer:
 * Returns ONLY published, publicly sellable product types belonging to ACTIVE categories,
 * stripping internal complexity codes (L1-L5) per frozen spec §04.1 L242,
 * and applying published i18n_dynamic_translations overlays when present.
 */
export async function getPublicCatalogKnowledge(db: DB) {
  const productTypes = (
    await db.query<{
      id: string;
      code: string;
      category_slug: string;
      group_code: string;
      group_name_zh: string;
      group_name_en: string;
      name_zh: string;
      name_en: string;
      aliases: string[];
      structural_options: unknown[];
      billing_unit: string;
      included_components: string[];
      applicable_module_codes: string[];
      quote_mode: string;
      sort_order: number;
    }>(`
      select pt.id, pt.code, pt.category_slug, pt.group_code, pt.group_name_zh, pt.group_name_en,
             pt.name_zh, pt.name_en, pt.aliases, pt.structural_options, pt.billing_unit,
             pt.included_components, pt.applicable_module_codes, pt.quote_mode, pt.sort_order
      from catalog_product_types pt
      join categories c on c.slug = pt.category_slug
      where pt.status = 'published'
        and pt.public_sellable = true
        and pt.capability_status <> 'not_admitted'
        and c.status = 'ACTIVE'
      order by pt.sort_order asc, pt.code asc
    `)
  ).rows;

  const modules = (
    await db.query<{
      id: string;
      code: string;
      name_zh: string;
      name_en: string;
      description_zh: string;
      description_en: string;
      module_tier: string;
      billing_unit: string;
      pricing_tiers: Record<string, unknown>;
      scope_boundary_zh: string;
      scope_boundary_en: string;
      is_destructive_possible: boolean;
      requires_customer_authorization: boolean;
      depends_on_codes: string[];
      conflicts_with_codes: string[];
      sort_order: number;
    }>(`
      select id, code, name_zh, name_en, description_zh, description_en, module_tier, billing_unit, pricing_tiers,
             scope_boundary_zh, scope_boundary_en, is_destructive_possible,
             requires_customer_authorization, depends_on_codes, conflicts_with_codes, sort_order
      from inspection_modules
      where status = 'published'
      order by sort_order asc
    `)
  ).rows;

  const overlayMap = await loadPublishedTranslationOverlays(
    db,
    ["catalog_product_type", "inspection_module"],
    [...productTypes.map((p) => p.id), ...modules.map((m) => m.id)],
  );

  const enrichedProductTypes = productTypes.map((pt) => ({
    ...pt,
    name_zh: overlayMap.get(`catalog_product_type:${pt.id}:name:zh-CN`) ?? pt.name_zh,
    name_en: overlayMap.get(`catalog_product_type:${pt.id}:name:en-US`) ?? pt.name_en,
  }));
  const enrichedModules = modules.map((m) => ({
    ...m,
    name_zh: overlayMap.get(`inspection_module:${m.id}:name:zh-CN`) ?? m.name_zh,
    name_en: overlayMap.get(`inspection_module:${m.id}:name:en-US`) ?? m.name_en,
    description_zh: overlayMap.get(`inspection_module:${m.id}:description:zh-CN`) ?? m.description_zh,
    description_en: overlayMap.get(`inspection_module:${m.id}:description:en-US`) ?? m.description_en,
  }));

  const groupMap = new Map<string, { group_code: string; group_name_zh: string; group_name_en: string; count: number }>();
  for (const pt of enrichedProductTypes) {
    const existing = groupMap.get(pt.group_code);
    if (existing) existing.count += 1;
    else {
      groupMap.set(pt.group_code, {
        group_code: pt.group_code,
        group_name_zh: pt.group_name_zh,
        group_name_en: pt.group_name_en,
        count: 1,
      });
    }
  }

  return {
    groups: [...groupMap.values()],
    product_types: enrichedProductTypes,
    modules: enrichedModules,
    pricing_notice:
      "Public catalog exposes verified apparel categories, structural options, and inspection modules. Internal complexity tiers are omitted; final pricing uses approved SKU or quote workflows.",
  };
}

export async function getCatalogFormSchema(
  db: DB,
  query: { offer_id?: string | null; product_type_code?: string | null },
) {
  const pub = await getPublicCatalogKnowledge(db);
  let selectedType = null as (typeof pub.product_types)[number] | null;
  if (query.product_type_code) {
    selectedType = pub.product_types.find((pt) => pt.code === query.product_type_code) ?? null;
    guard(selectedType, "PRODUCT_TYPE_UNAVAILABLE", "Requested product type is unavailable or retired.", 404);
  }

  let offerTemplate: Record<string, unknown> | null = null;
  if (query.offer_id) {
    offerTemplate =
      (
        await db.query(
          `select o.id as offer_id, o.sku_code, o.title, c.slug as category_slug,
                  t.id as template_version_id, t.version as template_version, t.content
           from service_offers o
           join offer_templates ot on ot.offer_id = o.id
           join categories c on c.id = ot.category_id
           join template_versions t on t.id = ot.template_version_id
           where o.id = $1::uuid and o.enabled = true and c.status = 'ACTIVE' and t.state = 'PUBLISHED'
           order by t.version desc limit 1`,
          [query.offer_id],
        )
      ).rows[0] ?? null;
    guard(offerTemplate, "OFFER_UNAVAILABLE", "This offer is not available.", 404);
  }

  const applicableSet = selectedType ? new Set(selectedType.applicable_module_codes) : null;
  const scopedModules = applicableSet ? pub.modules.filter((m) => applicableSet.has(m.code)) : pub.modules;

  const measurementTemplate = selectedType
    ? await resolvePublishedMeasurementForProductType(db, selectedType.code)
    : null;

  return {
    product_type: selectedType,
    measurement_template: measurementTemplate,
    available_product_types: pub.product_types,
    offer_template: offerTemplate,
    structural_options: selectedType?.structural_options ?? [],
    included_base_modules: scopedModules
      .filter((m) => m.module_tier === "base_included")
      .map((m) => ({ ...m, addon_billable: false })),
    optional_addon_modules: scopedModules
      .filter((m) => m.module_tier === "optional_addon")
      .map((m) => ({ ...m, addon_billable: true })),
    manual_quote_modules: scopedModules.filter((m) => m.module_tier === "manual_quote"),
  };
}

export const compileKnowledgeSchema = z.object({
  product_type_code: z.string().trim().min(2).max(80),
  selected_module_codes: z.array(z.string().trim().regex(/^M[0-9]{2}$/)).default([]),
  selected_module_options: z.record(z.string(), z.string()).default({}),
  structural_flags: z.record(z.string(), z.unknown()).default({}),
  customer_authorized_destructive: z.boolean().default(false),
  available_capabilities: z.array(z.string().trim().min(1)).optional(),
});

/**
 * Real Task Compilation Consumer (§04, §05, §19, §46.7):
 * Compiles an authoritative published product type belonging to an ACTIVE/admitted category
 * into concrete warehouse check items, garment parts, defect catalog, SOPs, and bilingual terminology,
 * guaranteeing M01 base deduplication and capability/destructive authorization guards (M05 GSM).
 */
export async function compileKnowledgeTaskBlueprint(db: DB, rawInput: unknown) {
  const input = compileKnowledgeSchema.parse(rawInput);

  const productType = (
    await db.query<{
      id: string;
      code: string;
      category_slug: string;
      group_code: string;
      name_zh: string;
      name_en: string;
      default_complexity_code: string;
      billing_unit: string;
      included_components: string[];
      applicable_module_codes: string[];
      quote_mode: string;
      capability_status: string;
      status: string;
      category_status: string | null;
    }>(
      `select pt.*, c.status as category_status
       from catalog_product_types pt
       left join categories c on c.slug = pt.category_slug
       where pt.code = $1`,
      [input.product_type_code],
    )
  ).rows[0];
  guard(
    productType && productType.status === "published",
    "PRODUCT_TYPE_UNAVAILABLE",
    "Knowledge task compilation requires a published product type.",
    422,
  );
  guard(
    productType.capability_status !== "not_admitted" && productType.category_status === "ACTIVE",
    "CATEGORY_NOT_ADMITTED",
    `Category '${productType.category_slug}' is not admitted/ACTIVE for compilation.`,
    422,
  );

  const modules = (
    await db.query<{
      id: string;
      code: string;
      name_zh: string;
      name_en: string;
      module_tier: "base_included" | "optional_addon" | "manual_quote";
      billing_unit: string;
      pricing_tiers: Record<string, unknown>;
      depends_on_codes: string[];
      conflicts_with_codes: string[];
      requires_capability_codes: string[];
      scope_boundary_zh: string;
      scope_boundary_en: string;
      is_destructive_possible: boolean;
      requires_customer_authorization: boolean;
    }>("select * from inspection_modules where status = 'published' order by sort_order asc")
  ).rows;
  const moduleByCode = new Map(modules.map((m) => [m.code, m]));

  const dbApprovedCaps = new Set(
    (await db.query<{ code: string }>("select code from capabilities where approved_by is not null and revoked_at is null")).rows.map(
      (r) => r.code,
    ),
  );
  const approvedCapabilities = input.available_capabilities ? new Set(input.available_capabilities) : dbApprovedCaps;

  const baseModules = modules.filter(
    (m) => m.module_tier === "base_included" && productType.applicable_module_codes.includes(m.code),
  );
  const requestedSet = new Set(input.selected_module_codes);

  for (const code of requestedSet) {
    guard(
      productType.applicable_module_codes.includes(code),
      "MODULE_NOT_APPLICABLE",
      `Module ${code} is not configured as applicable for product type ${productType.code}.`,
      422,
    );
    const mod = moduleByCode.get(code);
    guard(mod, "MODULE_UNAVAILABLE", `Module ${code} is not published.`, 422);
  }

  const effectiveModuleCodes = new Set([...baseModules.map((m) => m.code), ...requestedSet]);
  const billableAddonModules: typeof modules = [];
  const manualQuoteModules: typeof modules = [];
  const destructiveGsmRequested = input.selected_module_options.M05 === "fabric_gsm_destructive";

  for (const code of requestedSet) {
    const mod = moduleByCode.get(code)!;
    if (mod.module_tier === "base_included") {
      // Base module M01 is already included; deduplicate and NEVER double-bill as add-on.
      continue;
    }
    for (const dep of mod.depends_on_codes) {
      guard(
        effectiveModuleCodes.has(dep),
        "MODULE_DEPENDENCY_MISSING",
        `Module ${mod.code} depends on published module ${dep}.`,
        422,
      );
    }
    for (const conflict of mod.conflicts_with_codes) {
      guard(
        !effectiveModuleCodes.has(conflict),
        "MODULE_CONFLICT",
        `Module ${mod.code} conflicts with ${conflict}.`,
        422,
      );
    }
    for (const capCode of mod.requires_capability_codes) {
      guard(
        approvedCapabilities.has(capCode),
        "CAPABILITY_NOT_APPROVED",
        `Module ${mod.code} requires approved warehouse capability '${capCode}'.`,
        422,
      );
    }
    if (mod.is_destructive_possible && mod.requires_customer_authorization) {
      // For M05 (Weight & Fabric GSM), non-destructive gross weight is permitted unless GSM cutting option is requested
      const requiresDestructiveGuard = mod.code !== "M05" || destructiveGsmRequested;
      if (requiresDestructiveGuard) {
        guard(
          approvedCapabilities.has("fabric_gsm_cutter"),
          "CAPABILITY_NOT_APPROVED",
          `Destructive GSM sampling in ${mod.code} requires approved capability 'fabric_gsm_cutter'.`,
          422,
        );
        guard(
          input.customer_authorized_destructive === true,
          "DESTRUCTIVE_AUTHORIZATION_REQUIRED",
          `Module ${mod.code} (${mod.name_en}) requires explicit customer authorization for destructive sampling.`,
          422,
        );
      }
    }
    if (mod.module_tier === "manual_quote") manualQuoteModules.push(mod);
    else billableAddonModules.push(mod);
  }

  const allEffectiveCodes = [...effectiveModuleCodes];
  const checkItems = (
    await db.query(
      `select code, module_code, name_zh, name_en, method_zh, method_en, scope_limit_zh, scope_limit_en,
              applicable_part_codes, evidence_requirement, billing_included_in_base, requires_capability_code
       from knowledge_check_items
       where status = 'published'
         and module_code = any($1::text[])
         and (cardinality(applicable_group_codes) = 0 or $2 = any(applicable_group_codes))
         and ($3::boolean or code <> 'CHK_M05_DESTRUCTIVE_GSM_CUT')
       order by sort_order asc`,
      [allEffectiveCodes, productType.group_code, destructiveGsmRequested && input.customer_authorized_destructive],
    )
  ).rows;

  const garmentParts = (
    await db.query(
      `select code, name_zh, name_en, description_zh, description_en
       from knowledge_garment_parts
       where status = 'published'
         and (cardinality(applicable_group_codes) = 0 or $1 = any(applicable_group_codes))
       order by sort_order asc`,
      [productType.group_code],
    )
  ).rows;

  const defectTypes = (
    await db.query(
      `select code, name_zh, name_en, category_group, default_severity,
              severity_guidance_zh, severity_guidance_en, non_aql_disclaimer_zh, non_aql_disclaimer_en,
              applicable_part_codes
       from knowledge_defect_types
       where status = 'published'
         and (cardinality(applicable_group_codes) = 0 or $1 = any(applicable_group_codes))
       order by sort_order asc`,
      [productType.group_code],
    )
  ).rows;

  const sops = (
    await db.query(
      `select code, title_zh, title_en, applicable_module_codes, steps_zh, steps_en, safety_and_boundary_zh, safety_and_boundary_en
       from knowledge_sops
       where status = 'published'
         and (cardinality(applicable_group_codes) = 0 or $1 = any(applicable_group_codes))
         and applicable_module_codes && $2::text[]
       order by sort_order asc`,
      [productType.group_code, allEffectiveCodes],
    )
  ).rows;

  const terminology = (
    await db.query(
      `select term_code, domain, locale, standard_name, definition, synonyms, forbidden_translations, method_and_limits
       from knowledge_terminology_entries
       where status = 'published'
         and (cardinality(context_categories) = 0 or $1 = any(context_categories))
       order by term_code asc, locale asc`,
      [productType.group_code],
    )
  ).rows;

  const manualQuoteRequired =
    productType.quote_mode === "manual_quote" ||
    productType.default_complexity_code === "L5" ||
    manualQuoteModules.length > 0;

  const bpOverlayMap = await loadPublishedTranslationOverlays(
    db,
    ["catalog_product_type", "inspection_module"],
    [productType.id, ...baseModules.map((m) => m.id), ...billableAddonModules.map((m) => m.id)],
  );
  const measurementTemplate = await resolvePublishedMeasurementForProductType(db, productType.code);

  return {
    product_type: {
      id: productType.id,
      code: productType.code,
      category_slug: productType.category_slug,
      group_code: productType.group_code,
      name_zh: bpOverlayMap.get(`catalog_product_type:${productType.id}:name:zh-CN`) ?? productType.name_zh,
      name_en: bpOverlayMap.get(`catalog_product_type:${productType.id}:name:en-US`) ?? productType.name_en,
      billing_unit: productType.billing_unit,
      included_components: productType.included_components,
      quote_mode: productType.quote_mode,
      internal_complexity_code: productType.default_complexity_code,
    },
    measurement_template: measurementTemplate,
    manual_quote_required: manualQuoteRequired,
    structural_flags: input.structural_flags,
    included_base_modules: baseModules.map((m) => ({
      ...m,
      name_zh: bpOverlayMap.get(`inspection_module:${m.id}:name:zh-CN`) ?? m.name_zh,
      name_en: bpOverlayMap.get(`inspection_module:${m.id}:name:en-US`) ?? m.name_en,
      addon_billable: false,
    })),
    billable_addon_modules: billableAddonModules.map((m) => ({
      ...m,
      name_zh: bpOverlayMap.get(`inspection_module:${m.id}:name:zh-CN`) ?? m.name_zh,
      name_en: bpOverlayMap.get(`inspection_module:${m.id}:name:en-US`) ?? m.name_en,
      addon_billable: true,
    })),
    manual_quote_modules: manualQuoteModules,
    check_items: checkItems,
    garment_parts: garmentParts,
    defect_types: defectTypes,
    sops,
    terminology,
    disclaimers: {
      zh: "逐件全检客观记录（非 AQL 抽检放行）；整衣实称克重 ≠ 面料 GSM；洗水唛外观核查 ≠ 实验室成分或合规认证。",
      en: "Piece-by-piece factual documentation (NOT AQL certification); finished garment gross weight != fabric GSM; label visual check != lab/regulatory compliance.",
    },
  };
}
