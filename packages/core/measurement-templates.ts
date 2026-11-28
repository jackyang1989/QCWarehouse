import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, guard, hash, lock, one, role, type Actor } from "./common";
import { validateAndSanitizeSvg } from "./svg-sanitizer";

export const MEASUREMENT_READ_ROLES = [
  "super_admin",
  "template_admin",
  "reviewer",
  "warehouse_admin",
  "inspector",
  "support",
] as const;
export const MEASUREMENT_EDIT_ROLES = ["super_admin", "template_admin"] as const;
// Strictly matches catalog.review / catalog.publish_rollback parity (no template_admin self-publish)
export const MEASUREMENT_REVIEW_ROLES = ["super_admin", "reviewer"] as const;

export const VIEW_KEYS = ["front", "back", "side", "inside", "detail"] as const;
export type MeasurementViewKey = (typeof VIEW_KEYS)[number];

const NON_GEOMETRIC_POINT_PATTERN = /(?:^|_)(?:weight|gross_weight|net_weight|gsm|fabric_gsm|areal_weight)(?:$|_)/i;
const NON_GEOMETRIC_ZH_PATTERN = /克重|重量|净重|毛重|克\/平米|gsm/i;
const NON_GEOMETRIC_EN_PATTERN = /\b(?:weight|gross\s+weight|net\s+weight|gsm|g\/m2|grammage)\b/i;

export const svgViewSchema = z.object({
  view_key: z.enum(VIEW_KEYS),
  label_zh: z.string().trim().min(1).max(80),
  label_en: z.string().trim().min(1).max(80),
  svg: z.string().min(20),
});

export const measurementPointSchema = z.object({
  point_id: z.string().trim().regex(/^[a-z0-9_]{2,64}$/),
  marker_code: z.string().trim().regex(/^[A-Z0-9]{1,8}$/),
  view_key: z.enum(VIEW_KEYS).default("front"),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  location_zh: z.string().trim().min(1).max(300),
  location_en: z.string().trim().min(1).max(300),
  method_zh: z.string().trim().min(1).max(600),
  method_en: z.string().trim().min(1).max(600),
  start_x: z.number().min(0).max(4000),
  start_y: z.number().min(0).max(4000),
  end_x: z.number().min(0).max(4000),
  end_y: z.number().min(0).max(4000),
  label_x: z.number().min(0).max(4000),
  label_y: z.number().min(0).max(4000),
  guide_line_style: z.enum(["solid", "dashed", "arrow"]).default("dashed"),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb"),
  unit: z.enum(["cm", "inch"]).default("cm"),
  value_type: z.enum(["numeric", "derived_circumference"]).default("numeric"),
  precision_decimals: z.number().int().min(0).max(3).default(1),
  default_tolerance_plus: z.number().min(0).max(50).default(1.0),
  default_tolerance_minus: z.number().min(0).max(50).default(1.0),
  is_required: z.boolean().default(true),
  requires_target: z.boolean().default(false),
  requires_tolerance: z.boolean().default(true),
  requires_photo: z.boolean().default(true),
  allow_na: z.boolean().default(true),
  retest_threshold: z.number().min(0).max(20).default(0.5),
  report_visible: z.boolean().default(true),
  camera_preset_code: z.string().trim().min(2).max(80).default("macro_ruler_pom"),
  check_item_code: z.string().trim().min(2).max(80).nullable().optional(),
  sort_order: z.number().int().min(0).default(10),
});

export type MeasurementPoint = z.infer<typeof measurementPointSchema>;
export type MeasurementSvgView = z.infer<typeof svgViewSchema> & { viewBox?: string; width?: number; height?: number };

export const pointOverridesSchema = z.object({
  disabled_point_ids: z.array(z.string().trim().min(1)).default([]),
  overridden_points: z.record(z.string().trim().min(1), measurementPointSchema.partial()).default({}),
  added_points: z.array(measurementPointSchema).default([]),
});

export type PointOverrides = z.infer<typeof pointOverridesSchema>;

export const saveMeasurementTemplateSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
  parent_template_id: z.string().uuid().nullable().optional(),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  description_zh: z.string().trim().max(1000).default(""),
  description_en: z.string().trim().max(1000).default(""),
  applicable_product_type_codes: z.array(z.string().trim().min(2).max(80)).default([]),
  applicable_group_codes: z.array(z.string().trim().min(2).max(60)).default([]),
  default_unit: z.enum(["cm", "inch"]).default("cm"),
  views: z.array(svgViewSchema).default([]),
  points: z.array(measurementPointSchema).default([]),
  point_overrides: pointOverridesSchema.default({ disabled_point_ids: [], overridden_points: {}, added_points: [] }),
  camera_preset_codes: z.array(z.string().trim().min(2).max(80)).default(["overhead_flat_front", "macro_ruler_pom"]),
  note: z.string().trim().max(500).optional(),
});

export const cameraPresetSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
  name_zh: z.string().trim().min(1).max(120),
  name_en: z.string().trim().min(1).max(120),
  view_key: z.enum(VIEW_KEYS),
  framing_notes_zh: z.string().trim().max(600).default(""),
  framing_notes_en: z.string().trim().max(600).default(""),
  requires_scale_ruler: z.boolean().default(true),
  recommended_resolution: z.string().trim().min(3).max(40).default("1920x1080"),
  sort_order: z.number().int().min(0).default(10),
  active: z.boolean().default(true),
});

function assertGeometricPointsOnly(points: MeasurementPoint[]) {
  for (const p of points) {
    guard(
      !NON_GEOMETRIC_POINT_PATTERN.test(p.point_id) &&
        !NON_GEOMETRIC_EN_PATTERN.test(p.name_en) &&
        !NON_GEOMETRIC_ZH_PATTERN.test(p.name_zh),
      "NON_GEOMETRIC_POINT_FORBIDDEN",
      `Point '${p.point_id}' (${p.name_en}) represents non-geometric weight/GSM and belongs in M05 input panels rather than SVG POM diagrams (§14 L725).`,
      422,
    );
  }
}

function assertUniquePointsAndMarkers(points: MeasurementPoint[]) {
  const seenIds = new Set<string>();
  const seenMarkers = new Set<string>();
  for (const p of points) {
    guard(!seenIds.has(p.point_id), "DUPLICATE_POINT_ID", `Duplicate measurement point_id '${p.point_id}'.`, 422);
    guard(!seenMarkers.has(p.marker_code), "DUPLICATE_MARKER_CODE", `Duplicate measurement marker_code '${p.marker_code}'.`, 422);
    seenIds.add(p.point_id);
    seenMarkers.add(p.marker_code);
  }
}

function sanitizeAllViews(views: z.infer<typeof svgViewSchema>[]) {
  const seenViewKeys = new Set<string>();
  return views.map((v) => {
    guard(!seenViewKeys.has(v.view_key), "DUPLICATE_VIEW_KEY", `Duplicate view_key '${v.view_key}'.`, 422);
    seenViewKeys.add(v.view_key);
    const san = validateAndSanitizeSvg(v.svg);
    return {
      view_key: v.view_key,
      label_zh: v.label_zh,
      label_en: v.label_en,
      svg: san.svg,
      viewBox: san.viewBox,
      width: san.width,
      height: san.height,
    };
  });
}

async function applyPointTranslationOverlays(
  db: DB,
  templateId: string,
  points: MeasurementPoint[],
  opts: { verifyFrozenSource?: boolean } = {},
) {
  if (points.length === 0) return points;
  const rows = (
    await db.query<{
      field_key: string;
      locale: string;
      translated_text: string;
      source_hash: string | null;
      source_text: string | null;
    }>(
      `select distinct on (field_key, locale)
         field_key, locale, translated_text, source_hash, source_text
       from i18n_dynamic_translations
       where entity_type = 'measurement_template_point'
         and entity_id = $1::uuid
         and status = 'published'
       order by field_key, locale, revision desc`,
      [templateId],
    )
  ).rows;
  if (rows.length === 0) return points;
  const byKey = new Map(rows.map((r) => [`${r.field_key}:${r.locale}`, r]));
  const pickOverlay = (pointId: string, attr: "name" | "method" | "location", locale: "zh-CN" | "en-US", fallback: string, frozenSourceZh: string) => {
    const row = byKey.get(`${pointId}.${attr}:${locale}`);
    if (!row || !row.translated_text) return fallback;
    if (opts.verifyFrozenSource) {
      const expectedHash = hash(frozenSourceZh);
      if (row.source_hash && row.source_hash !== expectedHash && row.source_text !== frozenSourceZh) {
        return fallback;
      }
    }
    return row.translated_text;
  };
  return points.map((p) => ({
    ...p,
    // Strictly translate bilingual text ONLY; never alter coordinates, markers, view_key, or unit geometry (§53.9)
    name_zh: pickOverlay(p.point_id, "name", "zh-CN", p.name_zh, p.name_zh),
    name_en: pickOverlay(p.point_id, "name", "en-US", p.name_en, p.name_zh),
    method_zh: pickOverlay(p.point_id, "method", "zh-CN", p.method_zh, p.method_zh),
    method_en: pickOverlay(p.point_id, "method", "en-US", p.method_en, p.method_zh),
    location_zh: pickOverlay(p.point_id, "location", "zh-CN", p.location_zh, p.location_zh),
    location_en: pickOverlay(p.point_id, "location", "en-US", p.location_en, p.location_zh),
  }));
}

export async function resolveEffectiveMeasurementTemplate(
  db: DB,
  idOrCode: string,
  opts: { versionId?: string | null; applyDynamicTranslations?: boolean } = {},
) {
  if (opts.versionId) {
    const ver = (
      await db.query<{
        id: string;
        template_id: string;
        template_code: string;
        version: number;
        state: string;
        effective_snapshot: Record<string, unknown>;
        content_hash: string;
        published_at: Date;
      }>("select * from measurement_template_versions where id = $1::uuid", [opts.versionId])
    ).rows[0];
    guard(ver, "NOT_FOUND", "Measurement template version not found.", 404);
    const snap = ver.effective_snapshot as {
      views: MeasurementSvgView[];
      points: MeasurementPoint[];
      camera_presets?: Record<string, unknown>[];
      [k: string]: unknown;
    };
    const points = opts.applyDynamicTranslations !== false
      ? await applyPointTranslationOverlays(db, ver.template_id, snap.points ?? [], { verifyFrozenSource: true })
      : (snap.points ?? []);
    return {
      ...snap,
      points,
      measurement_template_version_id: ver.id,
      published_version: ver.version,
      version_state: ver.state,
      content_hash: ver.content_hash,
      published_at: ver.published_at,
    };
  }

  const isUuid = /^[a-f0-9-]{36}$/i.test(idOrCode);
  const chain: Record<string, any>[] = [];
  const visited = new Set<string>();
  let cursor: string | null = idOrCode;
  let cursorByUuid = isUuid;

  while (cursor) {
    const row: Record<string, any> | undefined = (
      await db.query<Record<string, any>>(
        cursorByUuid
          ? "select * from measurement_templates where id = $1::uuid"
          : "select * from measurement_templates where code = $1",
        [cursor],
      )
    ).rows[0];
    guard(row, "NOT_FOUND", `Measurement template '${idOrCode}' not found.`, 404);
    guard(!visited.has(row.id), "TEMPLATE_CYCLE", "Cyclic parent_template_id inheritance detected.", 422);
    visited.add(row.id);
    chain.unshift(row); // root parent first
    cursor = row.parent_template_id ?? null;
    cursorByUuid = true;
    guard(chain.length <= 8, "TEMPLATE_INHERITANCE_DEPTH", "Inheritance chain exceeds maximum depth of 8.", 422);
  }

  const leaf = chain[chain.length - 1]!;
  const viewMap = new Map<string, MeasurementSvgView>();
  let mergedPoints: MeasurementPoint[] = [];

  for (const node of chain) {
    const nodeViews = sanitizeAllViews(Array.isArray(node.views) ? node.views : []);
    for (const v of nodeViews) viewMap.set(v.view_key, v);

    const directPoints = (Array.isArray(node.points) ? node.points : []).map((p) => measurementPointSchema.parse(p));
    if (mergedPoints.length === 0) {
      mergedPoints = directPoints;
    } else {
      const ov = pointOverridesSchema.parse(node.point_overrides ?? {});
      const disabled = new Set(ov.disabled_point_ids);
      mergedPoints = mergedPoints
        .filter((p) => !disabled.has(p.point_id))
        .map((p) => {
          const patch = ov.overridden_points[p.point_id];
          return patch ? measurementPointSchema.parse({ ...p, ...patch, point_id: p.point_id }) : p;
        });
      for (const extra of directPoints) {
        const idx = mergedPoints.findIndex((x) => x.point_id === extra.point_id);
        if (idx >= 0) mergedPoints[idx] = extra;
        else mergedPoints.push(extra);
      }
      for (const added of ov.added_points) {
        const idx = mergedPoints.findIndex((x) => x.point_id === added.point_id);
        if (idx >= 0) mergedPoints[idx] = added;
        else mergedPoints.push(added);
      }
    }
  }

  const views = [...viewMap.values()];
  guard(views.length > 0, "TEMPLATE_VIEW_REQUIRED", "Effective measurement template must provide at least one sanitized SVG view.", 422);
  mergedPoints.sort((a, b) => a.sort_order - b.sort_order || a.marker_code.localeCompare(b.marker_code));
  assertGeometricPointsOnly(mergedPoints);
  assertUniquePointsAndMarkers(mergedPoints);

  const viewKeysSet = new Set(views.map((v) => v.view_key));
  for (const p of mergedPoints) {
    guard(viewKeysSet.has(p.view_key), "INVALID_POINT_VIEW", `Point '${p.point_id}' references missing view '${p.view_key}'.`, 422);
  }

  const finalPoints = opts.applyDynamicTranslations !== false
    ? await applyPointTranslationOverlays(db, leaf.id, mergedPoints)
    : mergedPoints;

  const presetCodes: string[] = Array.isArray(leaf.camera_preset_codes) ? leaf.camera_preset_codes : [];
  const cameraPresets = presetCodes.length
    ? (await db.query("select * from measurement_camera_presets where code = any($1::text[]) order by sort_order asc", [presetCodes])).rows
    : [];

  return {
    template_id: leaf.id,
    code: leaf.code,
    parent_template_id: leaf.parent_template_id ?? null,
    name_zh: leaf.name_zh,
    name_en: leaf.name_en,
    description_zh: leaf.description_zh,
    description_en: leaf.description_en,
    applicable_product_type_codes: leaf.applicable_product_type_codes ?? [],
    applicable_group_codes: leaf.applicable_group_codes ?? [],
    default_unit: leaf.default_unit,
    views,
    points: finalPoints,
    point_overrides: leaf.point_overrides ?? {},
    camera_preset_codes: presetCodes,
    camera_presets: cameraPresets,
    status: leaf.status,
    current_draft_version: leaf.current_draft_version,
    latest_published_version_id: leaf.latest_published_version_id ?? null,
    is_seed_default: leaf.is_seed_default,
    admin_modified: leaf.admin_modified,
  };
}

export async function getMeasurementOverview(db: DB, actor: Actor) {
  role(actor, ...MEASUREMENT_READ_ROLES);
  const summary = (
    await db.query<{
      total: number;
      published: number;
      draft: number;
      in_review: number;
      retired: number;
      inherited_count: number;
    }>(`
      select
        count(*)::int as total,
        count(*) filter (where status = 'published')::int as published,
        count(*) filter (where status = 'draft')::int as draft,
        count(*) filter (where status = 'in_review')::int as in_review,
        count(*) filter (where status = 'retired')::int as retired,
        count(*) filter (where parent_template_id is not null)::int as inherited_count
      from measurement_templates
    `)
  ).rows[0];
  const presets = (await db.query("select * from measurement_camera_presets order by sort_order asc")).rows;
  const seedRuns = (await db.query("select * from measurement_template_seed_runs order by ran_at desc limit 10")).rows;
  const versionsCount = (await db.query<{ n: number }>("select count(*)::int n from measurement_template_versions")).rows[0]!.n;

  return {
    summary: { ...summary, published_versions_total: versionsCount },
    camera_presets: presets,
    seed_runs: seedRuns,
  };
}

export async function listMeasurementTemplates(
  db: DB,
  actor: Actor,
  filters: { status?: string; product_type_code?: string; search?: string } = {},
) {
  role(actor, ...MEASUREMENT_READ_ROLES);
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    params.push(filters.status);
    where.push(`t.status = $${params.length}`);
  }
  if (filters.product_type_code) {
    params.push(filters.product_type_code);
    where.push(`$${params.length} = any(t.applicable_product_type_codes)`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(t.code ilike ${p} or t.name_zh ilike ${p} or t.name_en ilike ${p})`);
  }

  const rows = (
    await db.query(
      `select t.*, v.version as published_version, v.published_at as version_published_at
       from measurement_templates t
       left join measurement_template_versions v on v.id = t.latest_published_version_id
       ${where.length ? `where ${where.join(" and ")}` : ""}
       order by t.created_at asc, t.code asc`,
      params,
    )
  ).rows;
  return { templates: rows };
}

export async function getMeasurementTemplateDetail(db: DB, actor: Actor, id: string) {
  role(actor, ...MEASUREMENT_READ_ROLES);
  const effective = await resolveEffectiveMeasurementTemplate(db, id, { applyDynamicTranslations: true });
  const raw = await one(db, "select * from measurement_templates where id = $1::uuid", [id]);
  const versions = (
    await db.query(
      `select id, version, state, content_hash, author_id, submitted_by, reviewer_id, note, published_at, retired_at
       from measurement_template_versions
       where template_id = $1::uuid
       order by version desc`,
      [id],
    )
  ).rows;
  return { template: raw, effective, versions };
}

export async function saveMeasurementTemplateDraft(
  db: DB,
  actor: Actor,
  rawInput: unknown,
  sessionHash: string,
) {
  role(actor, ...MEASUREMENT_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "measurement_templates:write");

  const input = saveMeasurementTemplateSchema.parse(rawInput);
  const sanitizedViews = sanitizeAllViews(input.views);
  assertGeometricPointsOnly(input.points);
  assertUniquePointsAndMarkers(input.points);

  if (input.parent_template_id) {
    await one(db, "select id from measurement_templates where id = $1::uuid", [input.parent_template_id]);
  } else {
    guard(sanitizedViews.length > 0, "TEMPLATE_VIEW_REQUIRED", "Root templates must include at least one sanitized SVG view.", 422);
    guard(input.points.length > 0, "TEMPLATE_POINTS_REQUIRED", "Root templates must define at least one POM point.", 422);
  }

  const existing = input.id
    ? (await db.query<{ id: string; status: string }>("select id, status from measurement_templates where id = $1::uuid for update", [input.id])).rows[0]
    : null;
  if (!input.id) {
    const clash = (await db.query<{ id: string }>("select id from measurement_templates where code = $1", [input.code])).rows[0];
    guard(!clash, "DUPLICATE_TEMPLATE_CODE", `Measurement template code '${input.code}' already exists.`, 409);
  }

  if (existing && input.parent_template_id) {
    guard(existing.id !== input.parent_template_id, "TEMPLATE_CYCLE", "A template cannot inherit from itself.", 422);
  }

  const row = existing
    ? await one<Record<string, unknown>>(
        db,
        `update measurement_templates set
          parent_template_id = $2::uuid, name_zh = $3, name_en = $4,
          description_zh = $5, description_en = $6,
          applicable_product_type_codes = $7::text[], applicable_group_codes = $8::text[],
          default_unit = $9, views = $10::jsonb, points = $11::jsonb, point_overrides = $12::jsonb,
          camera_preset_codes = $13::text[],
          status = 'draft', current_draft_version = current_draft_version + 1,
          latest_published_version_id = case when $15::text = 'retired' then null else latest_published_version_id end,
          admin_modified = true, created_by = $14::uuid, submitted_by = null, approved_by = null,
          published_at = null, retired_at = null, updated_at = now()
        where id = $1::uuid returning *`,
        [
          existing.id,
          input.parent_template_id ?? null,
          input.name_zh,
          input.name_en,
          input.description_zh,
          input.description_en,
          input.applicable_product_type_codes,
          input.applicable_group_codes,
          input.default_unit,
          JSON.stringify(sanitizedViews),
          JSON.stringify(input.points),
          JSON.stringify(input.point_overrides),
          input.camera_preset_codes,
          actor.id,
          existing.status,
        ],
      )
    : await one<Record<string, unknown>>(
        db,
        `insert into measurement_templates (
          code, parent_template_id, name_zh, name_en, description_zh, description_en,
          applicable_product_type_codes, applicable_group_codes, default_unit,
          views, points, point_overrides, camera_preset_codes,
          status, is_seed_default, admin_modified, created_by
        ) values (
          $1, $2::uuid, $3, $4, $5, $6,
          $7::text[], $8::text[], $9,
          $10::jsonb, $11::jsonb, $12::jsonb, $13::text[],
          'draft', false, true, $14::uuid
        ) returning *`,
        [
          input.code,
          input.parent_template_id ?? null,
          input.name_zh,
          input.name_en,
          input.description_zh,
          input.description_en,
          input.applicable_product_type_codes,
          input.applicable_group_codes,
          input.default_unit,
          JSON.stringify(sanitizedViews),
          JSON.stringify(input.points),
          JSON.stringify(input.point_overrides),
          input.camera_preset_codes,
          actor.id,
        ],
      );

  // Validate full effective resolved tree (detects cycle / missing view / overridden duplicate marker immediately)
  await resolveEffectiveMeasurementTemplate(db, String(row.id), { applyDynamicTranslations: false });
  await audit(db, actor, "measurement_template_save_draft", "measurement_templates", String(row.id), {
    code: row.code,
    draft_version: row.current_draft_version,
    note: input.note ?? null,
  });
  return row;
}

export async function cloneMeasurementTemplate(
  db: DB,
  actor: Actor,
  sourceId: string,
  rawInput: { code: string; name_zh: string; name_en: string; inherit?: boolean; applicable_product_type_codes?: string[] },
  sessionHash: string,
) {
  role(actor, ...MEASUREMENT_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const parsed = z
    .object({
      code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
      name_zh: z.string().trim().min(1).max(160),
      name_en: z.string().trim().min(1).max(160),
      inherit: z.boolean().default(true),
      applicable_product_type_codes: z.array(z.string().trim().min(2)).optional(),
    })
    .parse(rawInput);

  const src = await one<Record<string, any>>(db, "select * from measurement_templates where id = $1::uuid", [sourceId]);
  const inserted = await one<Record<string, unknown>>(
    db,
    `insert into measurement_templates (
      code, parent_template_id, name_zh, name_en, description_zh, description_en,
      applicable_product_type_codes, applicable_group_codes, default_unit,
      views, points, point_overrides, camera_preset_codes,
      status, is_seed_default, admin_modified, created_by
    ) values (
      $1, $2::uuid, $3, $4, $5, $6,
      $7::text[], $8::text[], $9,
      $10::jsonb, $11::jsonb, $12::jsonb, $13::text[],
      'draft', false, true, $14::uuid
    ) returning *`,
    [
      parsed.code,
      parsed.inherit ? src.id : null,
      parsed.name_zh,
      parsed.name_en,
      src.description_zh,
      src.description_en,
      parsed.applicable_product_type_codes ?? src.applicable_product_type_codes ?? [],
      src.applicable_group_codes ?? [],
      src.default_unit,
      parsed.inherit ? JSON.stringify([]) : JSON.stringify(src.views ?? []),
      parsed.inherit ? JSON.stringify([]) : JSON.stringify(src.points ?? []),
      JSON.stringify({ disabled_point_ids: [], overridden_points: {}, added_points: [] }),
      src.camera_preset_codes ?? [],
      actor.id,
    ],
  );
  await audit(db, actor, "measurement_template_clone", "measurement_templates", String(inserted.id), {
    source_id: sourceId,
    inherit: parsed.inherit,
    code: parsed.code,
  });
  return inserted;
}

export async function submitMeasurementTemplate(
  db: DB,
  actor: Actor,
  id: string,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...MEASUREMENT_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const cur = await one<Record<string, unknown>>(db, "select * from measurement_templates where id = $1::uuid for update", [id]);
  guard(cur.status === "draft" || cur.status === "in_review", "INVALID_STATE", "Only draft or in-review measurement templates can be submitted.", 422);
  await resolveEffectiveMeasurementTemplate(db, id, { applyDynamicTranslations: false });
  const row = await one<Record<string, unknown>>(
    db,
    "update measurement_templates set status = 'in_review', submitted_by = $2::uuid, updated_at = now() where id = $1::uuid returning *",
    [id, actor.id],
  );
  await audit(db, actor, "measurement_template_submit", "measurement_templates", id, { code: row.code, note: note ?? null });
  return row;
}

export async function publishMeasurementTemplate(
  db: DB,
  actor: Actor,
  id: string,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...MEASUREMENT_REVIEW_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const cur = await one<Record<string, any>>(db, "select * from measurement_templates where id = $1::uuid for update", [id]);
  guard(cur.status === "draft" || cur.status === "in_review", "INVALID_STATE", "Only draft or in-review measurement templates can be published.", 422);
  guard(
    cur.created_by && cur.created_by !== actor.id && cur.submitted_by !== actor.id,
    "SELF_REVIEW_FORBIDDEN",
    "An author or submitter cannot independently publish their own measurement template.",
    403,
  );

  // Resolve full inherited & sanitized snapshot WITHOUT dynamic translation mutation of raw geometry
  const effective = await resolveEffectiveMeasurementTemplate(db, id, { applyDynamicTranslations: false });
  const nextVerRow = await one<{ n: number }>(
    db,
    "select coalesce(max(version), 0)::int + 1 as n from measurement_template_versions where template_id = $1::uuid",
    [id],
  );
  const contentHash = hash(JSON.stringify(effective));
  const versionRow = await one<Record<string, unknown>>(
    db,
    `insert into measurement_template_versions (
      template_id, template_code, version, state, effective_snapshot, content_hash,
      author_id, submitted_by, reviewer_id, note
    ) values ($1::uuid, $2, $3::int, 'PUBLISHED', $4::jsonb, $5, $6::uuid, $7::uuid, $8::uuid, $9::text)
    returning *`,
    [
      id,
      String(cur.code),
      nextVerRow.n,
      JSON.stringify(effective),
      contentHash,
      cur.created_by,
      cur.submitted_by ?? null,
      actor.id,
      note ?? null,
    ],
  );

  const updated = await one<Record<string, unknown>>(
    db,
    `update measurement_templates set
      status = 'published', approved_by = $2::uuid, latest_published_version_id = $3::uuid,
      published_at = now(), updated_at = now()
     where id = $1::uuid returning *`,
    [id, actor.id, versionRow.id],
  );
  await audit(db, actor, "measurement_template_publish", "measurement_template_versions", String(versionRow.id), {
    template_id: id,
    code: cur.code,
    version: nextVerRow.n,
    content_hash: contentHash,
  });
  return { template: updated, version: versionRow };
}

export async function batchPublishMeasurementTemplates(
  db: DB,
  actor: Actor,
  ids: string[],
  note: string | undefined,
  sessionHash: string,
) {
  const uniqueIds = [...new Set(ids)];
  guard(uniqueIds.length > 0 && uniqueIds.length <= 100, "VALIDATION_FAILED", "Provide 1-100 template IDs.", 422);
  const published = [];
  for (const id of uniqueIds) {
    published.push(await publishMeasurementTemplate(db, actor, id, note, sessionHash));
  }
  return { count: published.length, items: published };
}

export async function retireMeasurementTemplate(
  db: DB,
  actor: Actor,
  id: string,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...MEASUREMENT_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await one(db, "select id from measurement_templates where id = $1::uuid for update", [id]);
  const row = await one<Record<string, unknown>>(
    db,
    "update measurement_templates set status = 'retired', retired_at = now(), updated_at = now() where id = $1::uuid returning *",
    [id],
  );
  // Historical frozen versions in measurement_template_versions remain queryable for existing tasks/reports!
  await audit(db, actor, "measurement_template_retire", "measurement_templates", id, { code: row.code, note: note ?? null });
  return row;
}

export async function rollbackMeasurementTemplate(
  db: DB,
  actor: Actor,
  id: string,
  targetVersion: number,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...MEASUREMENT_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const curTpl = await one<{ id: string; status: string }>(
    db,
    "select id, status from measurement_templates where id = $1::uuid for update",
    [id],
  );
  const ver = (
    await db.query<{ effective_snapshot: Record<string, any> }>(
      "select effective_snapshot from measurement_template_versions where template_id = $1::uuid and version = $2::int",
      [id, targetVersion],
    )
  ).rows[0];
  guard(ver, "NOT_FOUND", `Published version ${targetVersion} not found for this template.`, 404);
  const snap = ver.effective_snapshot;
  const sanitizedViews = sanitizeAllViews(Array.isArray(snap.views) ? snap.views : []);
  const points = (Array.isArray(snap.points) ? snap.points : []).map((p) => measurementPointSchema.parse(p));

  const row = await one<Record<string, unknown>>(
    db,
    `update measurement_templates set
      parent_template_id = null,
      name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
      applicable_product_type_codes = $6::text[], applicable_group_codes = $7::text[],
      default_unit = $8, views = $9::jsonb, points = $10::jsonb,
      point_overrides = '{"disabled_point_ids":[],"overridden_points":{},"added_points":[]}'::jsonb,
      camera_preset_codes = $11::text[],
      status = 'draft', current_draft_version = current_draft_version + 1,
      latest_published_version_id = case when $13::text = 'retired' then null else latest_published_version_id end,
      admin_modified = true, created_by = $12::uuid, submitted_by = null, approved_by = null,
      published_at = null, retired_at = null, updated_at = now()
     where id = $1::uuid returning *`,
    [
      id,
      String(snap.name_zh ?? "Rolled Back Template"),
      String(snap.name_en ?? "Rolled Back Template"),
      String(snap.description_zh ?? ""),
      String(snap.description_en ?? ""),
      Array.isArray(snap.applicable_product_type_codes) ? snap.applicable_product_type_codes : [],
      Array.isArray(snap.applicable_group_codes) ? snap.applicable_group_codes : [],
      snap.default_unit === "inch" ? "inch" : "cm",
      JSON.stringify(sanitizedViews),
      JSON.stringify(points),
      Array.isArray(snap.camera_preset_codes) ? snap.camera_preset_codes : [],
      actor.id,
      curTpl.status,
    ],
  );
  await audit(db, actor, "measurement_template_rollback_to_draft", "measurement_templates", id, {
    target_version: targetVersion,
    draft_version: row.current_draft_version,
    note: note ?? null,
  });
  return row;
}

export async function listMeasurementTemplateVersions(db: DB, actor: Actor, id: string) {
  role(actor, ...MEASUREMENT_READ_ROLES);
  return (
    await db.query(
      `select id, template_id, template_code, version, state, content_hash, author_id, submitted_by, reviewer_id, note, published_at, retired_at
       from measurement_template_versions
       where template_id = $1::uuid
       order by version desc`,
      [id],
    )
  ).rows;
}

export async function saveCameraPreset(db: DB, actor: Actor, rawInput: unknown, sessionHash: string) {
  role(actor, ...MEASUREMENT_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = cameraPresetSchema.parse(rawInput);
  const row = await one<Record<string, unknown>>(
    db,
    `insert into measurement_camera_presets (
      code, name_zh, name_en, view_key, framing_notes_zh, framing_notes_en,
      requires_scale_ruler, recommended_resolution, sort_order, active
    ) values ($1, $2, $3, $4, $5, $6, $7::boolean, $8, $9::int, $10::boolean)
    on conflict (code) do update set
      name_zh = excluded.name_zh, name_en = excluded.name_en, view_key = excluded.view_key,
      framing_notes_zh = excluded.framing_notes_zh, framing_notes_en = excluded.framing_notes_en,
      requires_scale_ruler = excluded.requires_scale_ruler, recommended_resolution = excluded.recommended_resolution,
      sort_order = excluded.sort_order, active = excluded.active, updated_at = now()
    returning *`,
    [
      input.code,
      input.name_zh,
      input.name_en,
      input.view_key,
      input.framing_notes_zh,
      input.framing_notes_en,
      input.requires_scale_ruler,
      input.recommended_resolution,
      input.sort_order,
      input.active,
    ],
  );
  await audit(db, actor, "measurement_camera_preset_save", "measurement_camera_presets", String(row.id), { code: input.code });
  return row;
}

/**
 * Consumer lookup (§14 / §41.3 / T127):
 * - If frozenVersionId is passed (e.g. an in-progress/completed inspection task), resolves strictly that frozen version!
 * - Otherwise resolves the latest published measurement template mapped to productTypeCode (returns null if none published).
 */
export async function resolvePublishedMeasurementForProductType(
  db: DB,
  productTypeCode: string,
  frozenVersionId?: string | null,
) {
  if (frozenVersionId) {
    return resolveEffectiveMeasurementTemplate(db, frozenVersionId, {
      versionId: frozenVersionId,
      applyDynamicTranslations: true,
    });
  }
  const tpl = (
    await db.query<{ id: string; latest_published_version_id: string }>(
      `select t.id, t.latest_published_version_id
       from measurement_templates t
       join measurement_template_versions v on v.id = t.latest_published_version_id
       where t.status <> 'retired'
         and t.latest_published_version_id is not null
         and v.effective_snapshot->'applicable_product_type_codes' ? $1
       order by (t.parent_template_id is not null) desc, v.published_at desc, t.code asc
       limit 1`,
      [productTypeCode],
    )
  ).rows[0];
  if (!tpl) return null;
  return resolveEffectiveMeasurementTemplate(db, tpl.id, {
    versionId: tpl.latest_published_version_id,
    applyDynamicTranslations: true,
  });
}
