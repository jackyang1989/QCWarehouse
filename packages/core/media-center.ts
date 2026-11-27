import { createHash } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { EVIDENCE_PURPOSES, EVIDENCE_SOURCE_TYPES, TIME_SOURCES } from "./capture-evidence";
import { audit, guard, one, role, uuid, type Actor } from "./common";
import {
  resolveObjectStorageProviderForRead,
  streamPrivateObjectResponse,
} from "./storage-service";

export const MEDIA_CENTER_READ_ROLES = [
  "super_admin",
  "warehouse_admin",
  "reviewer",
  "inspector",
  "support",
  "finance",
] as const;

export const MEDIA_EXPORT_ROLES = ["super_admin", "support", "reviewer"] as const;
export const MEDIA_RETENTION_OPERATORS = ["warehouse_admin", "super_admin"] as const;

const METRIC_DISCLAIMERS = {
  employee_count:
    "Photo/video counts reflect recorded capture or upload events only and must not be used to evaluate employee quality, performance, or compensation.",
  cost_unknown:
    "No approved storage rate card or verified provider invoice is configured for this bucket/instance; cost is reported truthfully as unknown rather than 0.",
  cost_estimated:
    "Estimated monthly storage cost is derived from the active versioned rate card applied to deduplicated physical bytes per unique storage object (shared citations are counted once).",
} as const;

export const listMediaCenterSchema = z.object({
  date_basis: z.enum(["captured_at", "uploaded_at"]).default("uploaded_at"),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tz: z.string().trim().min(1).max(64).default("Asia/Shanghai"),
  device_id: z.uuid().optional(),
  employee_id: z.uuid().optional(),
  employee_role: z.enum(["any", "capture_responsible", "command_issuer", "uploader"]).default("any"),
  org_id: z.uuid().optional(),
  order_id: z.uuid().optional(),
  package_id: z.uuid().optional(),
  warehouse_item_id: z.uuid().optional(),
  warehouse_id: z.uuid().optional(),
  workstation_id: z.uuid().optional(),
  evidence_purpose: z.enum(EVIDENCE_PURPOSES).optional(),
  source_type: z.enum(EVIDENCE_SOURCE_TYPES).optional(),
  source_trust_level: z.string().trim().min(1).max(40).optional(),
  media_kind: z.enum(["photo", "video", "document"]).optional(),
  processing_state: z
    .enum([
      "awaiting_upload",
      "uploaded_unverified",
      "scanning",
      "processing",
      "ready",
      "quarantined",
      "failed",
      "cancelled",
    ])
    .optional(),
  has_report_citation: z.enum(["true", "false"]).optional(),
  include_device_test: z.enum(["true", "false"]).default("false"),
  q: z.string().trim().max(120).optional(),
  sort: z
    .enum(["captured_desc", "captured_asc", "uploaded_desc", "uploaded_asc", "size_desc"])
    .default("uploaded_desc"),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(24),
});

export const createExportJobSchema = z.object({
  purpose_reason: z.string().trim().min(4).max(500),
  include_originals: z.boolean().default(false),
  max_items: z.number().int().min(1).max(500).default(100),
  filters: z
    .object({
      org_id: z.uuid().optional(),
      order_id: z.uuid().optional(),
      device_id: z.uuid().optional(),
      employee_id: z.uuid().optional(),
      evidence_purpose: z.enum(EVIDENCE_PURPOSES).optional(),
      source_type: z.enum(EVIDENCE_SOURCE_TYPES).optional(),
      has_report_citation: z.boolean().optional(),
    })
    .default({}),
});

export const createRetentionRequestSchema = z.object({
  action_type: z.enum([
    "quarantine",
    "release_quarantine",
    "set_legal_hold",
    "release_legal_hold",
    "archive",
    "controlled_delete",
    "restore_archived",
  ]),
  reason: z.string().trim().min(4).max(500),
});

export const decideRetentionRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().min(2).max(500).optional(),
});

export const createCostRateCardSchema = z.object({
  storage_instance_id: z.uuid().nullable().optional(),
  currency: z.string().trim().min(3).max(8).default("USD"),
  rate_version: z.string().trim().min(1).max(60),
  storage_gb_month_cents: z.number().min(0).max(100_000_000),
  egress_gb_cents: z.number().min(0).max(100_000_000).nullable().optional(),
  class_a_per_million_cents: z.number().min(0).max(100_000_000).nullable().optional(),
  class_b_per_million_cents: z.number().min(0).max(100_000_000).nullable().optional(),
});

type StaffMediaScope = {
  isGlobalReader: boolean;
  canDownloadOriginal: boolean;
  canExport: boolean;
  canExportOriginals: boolean;
  canManageRetention: boolean;
  canControlledDelete: boolean;
  canManageMigrations: boolean;
  canViewDeviceTests: boolean;
  allowedWarehouseIds: string[];
};

function assertStaffScopeForEvidence(
  scope: StaffMediaScope,
  actor: Actor,
  record: {
    source_type: string;
    evidence_purpose: string;
    warehouse_id: string | null;
    capture_responsible_user_id: string | null;
    command_issuer_user_id: string | null;
    uploader_user_id: string;
  },
) {
  if (!scope.canViewDeviceTests && (record.source_type === "device_test" || record.evidence_purpose === "device_test")) {
    guard(false, "FORBIDDEN", "Access to device test media requires warehouse admin or super admin role.", 403);
  }
  if (!scope.isGlobalReader) {
    const allowed =
      (record.warehouse_id && scope.allowedWarehouseIds.includes(record.warehouse_id)) ||
      record.capture_responsible_user_id === actor.id ||
      record.command_issuer_user_id === actor.id ||
      record.uploader_user_id === actor.id;
    guard(allowed, "NOT_FOUND", "Evidence record not found in your warehouse scope.", 404);
  }
}

async function resolveStaffMediaScope(db: DB, actor: Actor): Promise<StaffMediaScope> {
  role(actor, ...MEDIA_CENTER_READ_ROLES);
  const roles = actor.roles;
  const isSuperAdmin = roles.includes("super_admin");
  const isWarehouseAdmin = roles.includes("warehouse_admin");
  const isReviewer = roles.includes("reviewer");
  const isInspector = roles.includes("inspector");
  const isSupport = roles.includes("support");

  const profile = (
    await db.query<{
      default_warehouse_id: string | null;
      allowed_warehouse_ids: string[] | null;
    }>(
      `select default_warehouse_id, allowed_warehouse_ids
       from staff_profiles where user_id = $1`,
      [actor.id],
    )
  ).rows[0];

  const warehouseSet = new Set<string>();
  if (profile?.default_warehouse_id && /^[0-9a-f-]{36}$/i.test(profile.default_warehouse_id)) {
    warehouseSet.add(profile.default_warehouse_id);
  }
  for (const wid of profile?.allowed_warehouse_ids ?? []) {
    if (/^[0-9a-f-]{36}$/i.test(wid)) warehouseSet.add(wid);
  }

  const isGlobalReader = isSuperAdmin || isWarehouseAdmin || isReviewer || isSupport || roles.includes("finance");
  return {
    isGlobalReader,
    canDownloadOriginal: isSuperAdmin || isWarehouseAdmin || isReviewer || isInspector,
    canExport: isSuperAdmin || isSupport || isReviewer,
    canExportOriginals: isSuperAdmin,
    canManageRetention: isSuperAdmin || isWarehouseAdmin,
    canControlledDelete: isSuperAdmin,
    canManageMigrations: isSuperAdmin,
    canViewDeviceTests: isSuperAdmin || isWarehouseAdmin,
    allowedWarehouseIds: [...warehouseSet],
  };
}

async function assertValidTimezone(db: DB, tz: string): Promise<string> {
  const row = (
    await db.query<{ name: string }>("select name from pg_timezone_names where name = $1 limit 1", [tz])
  ).rows[0];
  guard(row, "INVALID_TIMEZONE", `Unsupported timezone '${tz}'.`, 422);
  return row.name;
}

function buildScopedWhereClause(
  scope: StaffMediaScope,
  actor: Actor,
  filters: {
    date_basis?: "captured_at" | "uploaded_at";
    date_from?: string;
    date_to?: string;
    tz?: string;
    device_id?: string;
    employee_id?: string;
    employee_role?: "any" | "capture_responsible" | "command_issuer" | "uploader";
    org_id?: string;
    order_id?: string;
    package_id?: string;
    warehouse_item_id?: string;
    warehouse_id?: string;
    workstation_id?: string;
    evidence_purpose?: string;
    source_type?: string;
    source_trust_level?: string;
    media_kind?: string;
    processing_state?: string;
    has_report_citation?: "true" | "false" | boolean;
    include_device_test?: "true" | "false" | boolean;
    q?: string;
  },
  params: unknown[],
): string {
  const clauses: string[] = [];
  const add = (val: unknown) => {
    params.push(val);
    return `$${params.length}`;
  };

  if (!scope.isGlobalReader) {
    const uidP = add(actor.id);
    if (scope.allowedWarehouseIds.length > 0) {
      const whP = add(scope.allowedWarehouseIds);
      clauses.push(
        `(r.warehouse_id = any(${whP}::uuid[]) or r.capture_responsible_user_id = ${uidP} or r.command_issuer_user_id = ${uidP} or r.uploader_user_id = ${uidP})`,
      );
    } else {
      clauses.push(
        `(r.capture_responsible_user_id = ${uidP} or r.command_issuer_user_id = ${uidP} or r.uploader_user_id = ${uidP})`,
      );
    }
  }

  const includeTest = filters.include_device_test === true || filters.include_device_test === "true";
  if (!includeTest || !scope.canViewDeviceTests) {
    clauses.push(`r.source_type <> 'device_test' and r.evidence_purpose <> 'device_test'`);
  }

  if (filters.date_from || filters.date_to) {
    const tzP = add(filters.tz ?? "Asia/Shanghai");
    const col = filters.date_basis === "captured_at" ? "r.actual_captured_at" : "r.server_received_at";
    if (filters.date_basis === "captured_at") {
      // Unknown capture timestamps are never stuffed into a captured_at date window.
      clauses.push(`r.actual_captured_at is not null`);
    }
    if (filters.date_from) {
      const fromP = add(filters.date_from);
      clauses.push(`${col} >= (${fromP}::date::timestamp at time zone ${tzP})`);
    }
    if (filters.date_to) {
      const toP = add(filters.date_to);
      clauses.push(`${col} < ((${toP}::date + 1)::timestamp at time zone ${tzP})`);
    }
  }

  if (filters.device_id) clauses.push(`r.device_id = ${add(filters.device_id)}`);
  if (filters.warehouse_id) clauses.push(`r.warehouse_id = ${add(filters.warehouse_id)}`);
  if (filters.workstation_id) clauses.push(`r.workstation_id = ${add(filters.workstation_id)}`);
  if (filters.evidence_purpose) clauses.push(`r.evidence_purpose = ${add(filters.evidence_purpose)}`);
  if (filters.source_type) clauses.push(`r.source_type = ${add(filters.source_type)}`);
  if (filters.source_trust_level) clauses.push(`r.source_trust_level = ${add(filters.source_trust_level)}`);
  if (filters.media_kind) clauses.push(`r.media_kind = ${add(filters.media_kind)}`);
  if (filters.processing_state) clauses.push(`r.processing_state = ${add(filters.processing_state)}`);

  if (filters.employee_id) {
    const empP = add(filters.employee_id);
    if (filters.employee_role === "capture_responsible") {
      clauses.push(`r.capture_responsible_user_id = ${empP}`);
    } else if (filters.employee_role === "command_issuer") {
      clauses.push(`r.command_issuer_user_id = ${empP}`);
    } else if (filters.employee_role === "uploader") {
      clauses.push(`r.uploader_user_id = ${empP}`);
    } else {
      clauses.push(
        `(r.capture_responsible_user_id = ${empP} or r.command_issuer_user_id = ${empP} or r.uploader_user_id = ${empP})`,
      );
    }
  }

  if (filters.org_id) {
    const orgP = add(filters.org_id);
    clauses.push(
      `exists (select 1 from media_evidence_links l where l.evidence_id = r.id and l.status = 'active' and l.org_id = ${orgP})`,
    );
  }
  if (filters.order_id) {
    const ordP = add(filters.order_id);
    clauses.push(
      `exists (select 1 from media_evidence_links l where l.evidence_id = r.id and l.status = 'active' and l.entity_type = 'order' and l.entity_id = ${ordP})`,
    );
  }
  if (filters.package_id) {
    const pkgP = add(filters.package_id);
    clauses.push(
      `exists (select 1 from media_evidence_links l where l.evidence_id = r.id and l.status = 'active' and l.entity_type = 'package' and l.entity_id = ${pkgP})`,
    );
  }
  if (filters.warehouse_item_id) {
    const itemP = add(filters.warehouse_item_id);
    clauses.push(
      `exists (select 1 from media_evidence_links l where l.evidence_id = r.id and l.status = 'active' and l.entity_type = 'warehouse_item' and l.entity_id = ${itemP})`,
    );
  }

  if (filters.has_report_citation !== undefined) {
    const wantCitation = filters.has_report_citation === true || filters.has_report_citation === "true";
    clauses.push(
      wantCitation
        ? `exists (select 1 from media_evidence_links l where l.evidence_id = r.id and l.status = 'active' and (l.entity_type = 'report_version' or l.link_role = 'report_citation'))`
        : `not exists (select 1 from media_evidence_links l where l.evidence_id = r.id and l.status = 'active' and (l.entity_type = 'report_version' or l.link_role = 'report_citation'))`,
    );
  }

  if (filters.q) {
    const likeP = add(`%${filters.q}%`);
    clauses.push(
      `(r.capture_key ilike ${likeP} or r.original_sha256 ilike ${likeP} or exists (
        select 1 from media_evidence_links l
        left join orders o on l.entity_type = 'order' and o.id = l.entity_id
        left join warehouse_items wi on l.entity_type = 'warehouse_item' and wi.id = l.entity_id
        left join packages pk on l.entity_type = 'package' and pk.id = l.entity_id
        where l.evidence_id = r.id and l.status = 'active'
          and (o.public_no ilike ${likeP} or wi.code ilike ${likeP} or pk.code ilike ${likeP})
      ))`,
    );
  }

  return clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
}

function orderBySql(sort: z.infer<typeof listMediaCenterSchema>["sort"]): string {
  switch (sort) {
    case "captured_desc":
      return "order by r.actual_captured_at desc nulls last, r.id desc";
    case "captured_asc":
      return "order by r.actual_captured_at asc nulls last, r.id asc";
    case "uploaded_asc":
      return "order by r.server_received_at asc, r.id asc";
    case "size_desc":
      return "order by r.original_size_bytes desc, r.id desc";
    case "uploaded_desc":
    default:
      return "order by r.server_received_at desc, r.id desc";
  }
}

export async function listAdminMediaCenter(db: DB, actor: Actor, rawQuery: Record<string, unknown>) {
  const scope = await resolveStaffMediaScope(db, actor);
  const filters = listMediaCenterSchema.parse(rawQuery);
  await assertValidTimezone(db, filters.tz);

  const params: unknown[] = [];
  const whereSql = buildScopedWhereClause(scope, actor, filters, params);

  const countRes = await one<{ total: number }>(
    db,
    `select count(*)::int as total from media_evidence_records r ${whereSql}`,
    params,
  );

  const offset = (filters.page - 1) * filters.page_size;
  const limitP = `$${params.length + 1}`;
  const offsetP = `$${params.length + 2}`;

  const items = (
    await db.query(
      `select r.id, r.capture_key, r.source_type, r.source_trust_level, r.evidence_purpose, r.media_kind,
              r.warehouse_id, wh.warehouse_code, wh.name_zh as warehouse_name_zh,
              r.workstation_id, ws.station_code,
              r.device_id, wd.device_code, wd.approval_status as device_approval_status,
              r.camera_role, r.device_auth_generation,
              r.command_issuer_user_id, cu.display_name as command_issuer_name,
              r.capture_responsible_user_id, au.display_name as capture_author_name, asp.employee_no as capture_author_emp_no,
              r.uploader_user_id, uu.display_name as uploader_name,
              r.actual_captured_at, r.video_started_at, r.video_ended_at, r.actual_duration_ms,
              r.time_source, r.time_unknown_reason, r.clock_skew_flagged,
              r.server_received_at, r.server_verified_at,
              r.original_sha256, r.original_size_bytes::text, r.original_mime,
              r.pixel_width, r.pixel_height,
              r.processing_state, r.original_ready, r.derivatives_ready, r.quarantine_reason,
              r.late_submission_flag, r.is_business_evidence, r.retention_class, r.legal_hold, r.customer_visible,
              so.status as storage_object_status, si.instance_key as storage_instance_key,
              (select v.id from media_evidence_variants v where v.evidence_id = r.id and v.variant_kind = 'thumbnail' order by v.variant_version desc limit 1) as thumbnail_variant_id,
              (select v.id from media_evidence_variants v where v.evidence_id = r.id and v.variant_kind = 'annotated' order by v.variant_version desc limit 1) as annotated_variant_id,
              (select v.id from media_evidence_variants v where v.evidence_id = r.id and v.variant_kind = 'video_poster' order by v.variant_version desc limit 1) as poster_variant_id,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'entity_type', l.entity_type,
                  'entity_id', l.entity_id,
                  'link_role', l.link_role,
                  'org_id', l.org_id,
                  'org_name', org.name,
                  'order_no', ord.public_no,
                  'item_code', wi.code,
                  'package_code', pk.code
                ) order by l.created_at asc)
                from media_evidence_links l
                left join organizations org on org.id = l.org_id
                left join orders ord on l.entity_type = 'order' and ord.id = l.entity_id
                left join warehouse_items wi on l.entity_type = 'warehouse_item' and wi.id = l.entity_id
                left join packages pk on l.entity_type = 'package' and pk.id = l.entity_id
                where l.evidence_id = r.id and l.status = 'active'
              ), '[]'::jsonb) as links,
              r.created_at
       from media_evidence_records r
       join storage_objects so on so.id = r.original_object_id
       left join storage_instances si on si.id = so.storage_instance_id
       left join warehouses wh on wh.id = r.warehouse_id
       left join workstations ws on ws.id = r.workstation_id
       left join warehouse_devices wd on wd.id = r.device_id
       left join users cu on cu.id = r.command_issuer_user_id
       left join users au on au.id = r.capture_responsible_user_id
       left join staff_profiles asp on asp.user_id = r.capture_responsible_user_id
       left join users uu on uu.id = r.uploader_user_id
       ${whereSql}
       ${orderBySql(filters.sort)}
       limit ${limitP} offset ${offsetP}`,
      [...params, filters.page_size, offset],
    )
  ).rows.map((row) => ({
    ...row,
    deleted: row.quarantine_reason === "controlled_delete_executed" || row.storage_object_status === "archived",
    playable:
      row.processing_state === "ready" &&
      row.original_ready === true &&
      row.quarantine_reason !== "controlled_delete_executed" &&
      row.storage_object_status === "ready",
    detail_path: `/admin/media/${row.id}`,
  }));

  return {
    items,
    total: countRes.total,
    page: filters.page,
    page_size: filters.page_size,
    view_capabilities: {
      can_download_original: scope.canDownloadOriginal,
      can_export: scope.canExport,
      can_export_originals: scope.canExportOriginals,
      can_manage_retention: scope.canManageRetention,
      can_controlled_delete: scope.canControlledDelete,
      can_manage_migrations: scope.canManageMigrations,
      can_view_device_tests: scope.canViewDeviceTests,
    },
    disclaimers: {
      employee_count: METRIC_DISCLAIMERS.employee_count,
    },
  };
}

export async function getAdminMediaDetail(db: DB, actor: Actor, evidenceId: string) {
  const scope = await resolveStaffMediaScope(db, actor);
  const record = (
    await db.query(
      `select r.*, wh.warehouse_code, wh.name_zh as warehouse_name_zh,
              ws.station_code, ws.station_type,
              wd.device_code, wd.device_role, wd.ownership_type, wd.approval_status as device_approval_status,
              wd.model as device_model, wd.auth_generation as current_device_auth_generation,
              cu.display_name as command_issuer_name,
              au.display_name as capture_author_name, asp.employee_no as capture_author_emp_no, asp.employment_status as capture_author_employment_status,
              uu.display_name as uploader_name,
              so.storage_instance_id, so.storage_provider_key, so.bucket, so.object_key, so.object_version_id,
              so.status as storage_object_status, so.verified_sha256, so.size_bytes::text as storage_size_bytes,
              si.instance_key as storage_instance_key, si.display_name as storage_instance_name
       from media_evidence_records r
       join storage_objects so on so.id = r.original_object_id
       left join storage_instances si on si.id = so.storage_instance_id
       left join warehouses wh on wh.id = r.warehouse_id
       left join workstations ws on ws.id = r.workstation_id
       left join warehouse_devices wd on wd.id = r.device_id
       left join users cu on cu.id = r.command_issuer_user_id
       left join users au on au.id = r.capture_responsible_user_id
       left join staff_profiles asp on asp.user_id = r.capture_responsible_user_id
       left join users uu on uu.id = r.uploader_user_id
       where r.id = $1`,
      [evidenceId],
    )
  ).rows[0];
  guard(record, "NOT_FOUND", "Evidence record not found.", 404);
  assertStaffScopeForEvidence(scope, actor, record);

  const variants = (
    await db.query(
      `select v.id, v.variant_kind, v.variant_version, v.storage_object_id, v.sha256, v.size_bytes::text,
              v.mime, v.width, v.height, v.duration_ms, v.transform_spec, v.created_by, v.created_at,
              so.status as storage_object_status
       from media_evidence_variants v
       join storage_objects so on so.id = v.storage_object_id
       where v.evidence_id = $1
       order by v.variant_kind asc, v.variant_version desc`,
      [evidenceId],
    )
  ).rows;

  const links = (
    await db.query(
      `select l.*, org.name as org_name, ord.public_no as order_no, wi.code as item_code, pk.code as package_code,
              rv.version as report_version_no, rv.state as report_version_state
       from media_evidence_links l
       left join organizations org on org.id = l.org_id
       left join orders ord on l.entity_type = 'order' and ord.id = l.entity_id
       left join warehouse_items wi on l.entity_type = 'warehouse_item' and wi.id = l.entity_id
       left join packages pk on l.entity_type = 'package' and pk.id = l.entity_id
       left join report_versions rv on l.entity_type = 'report_version' and rv.id = l.entity_id
       where l.evidence_id = $1
       order by l.created_at asc`,
      [evidenceId],
    )
  ).rows.map((l) => ({
    ...l,
    deep_link:
      l.entity_type === "order" && l.order_no
        ? `/admin/orders/${l.order_no}`
        : l.entity_type === "package" && l.package_code
          ? `/wh/packages/${l.package_code}`
          : l.entity_type === "warehouse_item" && l.item_code
            ? `/wh/samples/${l.item_code}`
            : l.entity_type === "inspection_task"
              ? `/admin/inspections/tasks/${l.entity_id}`
              : null,
  }));

  const retentionRequests = (
    await db.query(
      `select rr.*, req_u.display_name as requested_by_name, app_u.display_name as approved_by_name
       from media_retention_requests rr
       left join users req_u on req_u.id = rr.requested_by
       left join users app_u on app_u.id = rr.approved_by
       where rr.evidence_id = $1
       order by rr.created_at desc`,
      [evidenceId],
    )
  ).rows;

  const auditTimeline = (
    await db.query(
      `select id, at, actor_type, actor_id, action, entity_type, entity_id, meta
       from audit_events
       where entity_id = $1 or (meta->>'evidence_id') = $2
       order by at desc, id desc
       limit 50`,
      [evidenceId, evidenceId],
    )
  ).rows;

  const deleted =
    record.quarantine_reason === "controlled_delete_executed" || record.storage_object_status === "archived";
  const playable = record.processing_state === "ready" && record.original_ready === true && !deleted;

  return {
    record: {
      ...record,
      original_size_bytes: String(record.original_size_bytes),
      deleted,
      playable,
    },
    variants,
    links,
    retention_requests: retentionRequests,
    audit_timeline: auditTimeline,
    view_capabilities: {
      can_download_original: scope.canDownloadOriginal,
      can_manage_retention: scope.canManageRetention,
      can_controlled_delete: scope.canControlledDelete,
    },
  };
}

export async function streamAdminMediaObject(
  db: DB,
  actor: Actor,
  evidenceId: string,
  variant: string,
  rangeHeader: string | null,
): Promise<Response> {
  const scope = await resolveStaffMediaScope(db, actor);
  const record = (
    await db.query<{
      id: string;
      original_object_id: string;
      warehouse_id: string | null;
      capture_responsible_user_id: string | null;
      command_issuer_user_id: string | null;
      uploader_user_id: string;
      source_type: string;
      evidence_purpose: string;
      processing_state: string;
      quarantine_reason: string | null;
      storage_status: string;
    }>(
      `select r.id, r.original_object_id, r.warehouse_id, r.capture_responsible_user_id, r.command_issuer_user_id,
              r.uploader_user_id, r.source_type, r.evidence_purpose, r.processing_state, r.quarantine_reason,
              so.status as storage_status
       from media_evidence_records r
       join storage_objects so on so.id = r.original_object_id
       where r.id = $1`,
      [evidenceId],
    )
  ).rows[0];
  guard(record, "NOT_FOUND", "Evidence record not found.", 404);
  assertStaffScopeForEvidence(scope, actor, record);

  guard(
    record.quarantine_reason !== "controlled_delete_executed" &&
      record.processing_state !== "cancelled" &&
      record.storage_status !== "archived",
    "MEDIA_DELETED_OR_ARCHIVED",
    "This evidence object has been controlled-deleted or archived and is no longer playable.",
    410,
  );

  if (["original", "normalized", "video_playback"].includes(variant)) {
    guard(
      scope.canDownloadOriginal,
      "FORBIDDEN",
      "Your role may inspect thumbnails, posters, and metadata only; streaming full-resolution originals, normalized copies, or playback videos requires QA, inspector, warehouse admin, or super admin.",
      403,
    );
  }

  let targetObjectId = record.original_object_id;
  if (variant !== "original") {
    const vRow = (
      await db.query<{ storage_object_id: string; status: string }>(
        `select v.storage_object_id, so.status
         from media_evidence_variants v
         join storage_objects so on so.id = v.storage_object_id
         where v.evidence_id = $1 and v.variant_kind = $2
         order by v.variant_version desc
         limit 1`,
        [evidenceId, variant],
      )
    ).rows[0];
    guard(vRow && vRow.status === "ready", "NOT_FOUND", `Variant '${variant}' is not available.`, 404);
    targetObjectId = vRow.storage_object_id;
  }

  return streamPrivateObjectResponse(actor, targetObjectId, rangeHeader);
}

export async function getDeviceMediaHistory(db: DB, actor: Actor, deviceId: string, rawQuery: Record<string, unknown>) {
  const scope = await resolveStaffMediaScope(db, actor);
  const device = (
    await db.query(
      `select d.id, d.device_code, d.warehouse_id, wh.warehouse_code, wh.name_zh as warehouse_name_zh,
              d.workstation_id, ws.station_code, d.device_role, d.ownership_type,
              d.manufacturer, d.model, d.approval_status, d.online_status, d.auth_generation,
              d.capability_tags, d.calibration_due_at, d.last_calibrated_at,
              d.approved_at, d.revoked_at, d.revocation_reason, d.created_at
       from warehouse_devices d
       left join warehouses wh on wh.id = d.warehouse_id
       left join workstations ws on ws.id = d.workstation_id
       where d.id = $1`,
      [deviceId],
    )
  ).rows[0];
  guard(device, "NOT_FOUND", "Warehouse device not found.", 404);
  if (!scope.isGlobalReader && !scope.allowedWarehouseIds.includes(device.warehouse_id)) {
    guard(false, "FORBIDDEN", "Device belongs to a warehouse outside your scope.", 403);
  }

  const list = await listAdminMediaCenter(db, actor, { ...rawQuery, device_id: deviceId });
  const events = (
    await db.query(
      `select 'auth_request' as event_source, id, request_status as status, registration_mode as detail, created_at as at
       from device_authorization_requests where device_id = $1
       union all
       select 'control_lease' as event_source, id, status, coalesce(end_reason, 'active') as detail, granted_at as at
       from device_control_leases where device_id = $1
       union all
       select 'calibration' as event_source, id, outcome as status, log_type as detail, created_at as at
       from device_calibration_logs where device_id = $1
       order by at desc
       limit 40`,
      [deviceId],
    )
  ).rows;

  const syncCounts = await one<{
    total_records: number;
    ready_count: number;
    awaiting_upload_count: number;
    quarantined_count: number;
    failed_count: number;
  }>(
    db,
    `select count(*)::int as total_records,
            count(*) filter (where processing_state = 'ready')::int as ready_count,
            count(*) filter (where processing_state = 'awaiting_upload')::int as awaiting_upload_count,
            count(*) filter (where processing_state = 'quarantined')::int as quarantined_count,
            count(*) filter (where processing_state = 'failed')::int as failed_count
     from media_evidence_records
     where device_id = $1 and source_type <> 'device_test'`,
    [deviceId],
  );

  return { device, sync_counts: syncCounts, events, media: list };
}

export async function getEmployeeMediaHistory(db: DB, actor: Actor, userId: string, rawQuery: Record<string, unknown>) {
  const scope = await resolveStaffMediaScope(db, actor);
  const employee = (
    await db.query(
      `select u.id, u.display_name as name, u.status as user_status,
              sp.employee_no, sp.employment_status, sp.account_security_status, sp.offboarded_at,
              coalesce((select array_agg(sr.role order by sr.role) from staff_roles sr where sr.user_id = u.id), ARRAY[]::text[]) as roles
       from users u
       left join staff_profiles sp on sp.user_id = u.id
       where u.id = $1`,
      [userId],
    )
  ).rows[0];
  guard(employee, "NOT_FOUND", "Employee not found.", 404);
  if (!scope.isGlobalReader && userId !== actor.id) {
    guard(false, "FORBIDDEN", "Inspectors may only query their own employee photography history.", 403);
  }

  const list = await listAdminMediaCenter(db, actor, { ...rawQuery, employee_id: userId });
  const breakdown = await one<{
    direct_capture_count: number;
    remote_command_count: number;
    uploaded_count: number;
    quarantined_or_reshoot_count: number;
  }>(
    db,
    `select count(*) filter (where capture_responsible_user_id = $1 and is_business_evidence and source_type <> 'legacy_migration')::int as direct_capture_count,
            count(*) filter (where command_issuer_user_id = $1 and is_business_evidence)::int as remote_command_count,
            count(*) filter (where uploader_user_id = $1 and is_business_evidence)::int as uploaded_count,
            count(*) filter (where (capture_responsible_user_id = $1 or uploader_user_id = $1) and (processing_state = 'quarantined' or retention_class = 'unselected_reshoot'))::int as quarantined_or_reshoot_count
     from media_evidence_records`,
    [userId],
  );

  return {
    employee,
    breakdown,
    disclaimer: METRIC_DISCLAIMERS.employee_count,
    media: list,
  };
}

export async function getAdminMediaStats(db: DB, actor: Actor) {
  const scope = await resolveStaffMediaScope(db, actor);
  const params: unknown[] = [];
  const scopeWhere = buildScopedWhereClause(scope, actor, { include_device_test: scope.canViewDeviceTests }, params);

  const counts = await one<{
    total_records: number;
    business_captures_count: number;
    imported_count: number;
    customer_attachment_count: number;
    legacy_unknown_count: number;
    device_test_count: number;
    qa_selected_or_cited_count: number;
    quarantined_or_reshoot_count: number;
    unique_original_objects_count: number;
    unique_variant_objects_count: number;
  }>(
    db,
    `select count(*)::int as total_records,
            count(*) filter (where r.is_business_evidence and r.source_type not in ('gallery_file_import','customer_attachment','legacy_migration','device_test'))::int as business_captures_count,
            count(*) filter (where r.source_type = 'gallery_file_import')::int as imported_count,
            count(*) filter (where r.source_type = 'customer_attachment')::int as customer_attachment_count,
            count(*) filter (where r.source_type = 'legacy_migration' or r.source_trust_level = 'legacy_unknown')::int as legacy_unknown_count,
            count(*) filter (where r.source_type = 'device_test' or r.evidence_purpose = 'device_test')::int as device_test_count,
            count(*) filter (where exists (select 1 from media_evidence_links l where l.evidence_id = r.id and l.status = 'active' and l.link_role in ('qa_selected','report_citation')))::int as qa_selected_or_cited_count,
            count(*) filter (where r.processing_state = 'quarantined' or r.retention_class = 'unselected_reshoot')::int as quarantined_or_reshoot_count,
            count(distinct r.original_object_id)::int as unique_original_objects_count,
            (select count(distinct v.storage_object_id)::int from media_evidence_variants v join media_evidence_records r2 on r2.id = v.evidence_id where r2.id = any(array(select r.id from media_evidence_records r ${scopeWhere}))) as unique_variant_objects_count
     from media_evidence_records r
     ${scopeWhere}`,
    params,
  );

  const linkCountRow = await one<{ logical_entity_links_count: number }>(
    db,
    `select count(*)::int as logical_entity_links_count
     from media_evidence_links l
     join media_evidence_records r on r.id = l.evidence_id
     ${scopeWhere ? `${scopeWhere} and l.status = 'active'` : "where l.status = 'active'"}`,
    params,
  );

  const cmdStats = scope.isGlobalReader
    ? (
        await db.query<{ status: string; count: number }>(
          "select command_status as status, count(*)::int as count from capture_commands group by command_status order by command_status",
        )
      ).rows
    : [];

  // Deduplicated physical bytes: count each distinct storage_objects.id ONCE regardless of how many links reference it.
  const phys = await one<{
    originals_bytes: string;
    variants_bytes: string;
    quarantined_bytes: string;
    archived_bytes: string;
    staging_pending_bytes: string;
    total_physical_bytes: string;
  }>(
    db,
    `with scoped_ev as (
       select r.id, r.original_object_id, r.processing_state
       from media_evidence_records r
       ${scopeWhere}
     ),
     distinct_orig as (
       select distinct so.id, so.size_bytes, so.status, ev.processing_state
       from scoped_ev ev
       join storage_objects so on so.id = ev.original_object_id
     ),
     distinct_var as (
       select distinct so.id, so.size_bytes, so.status
       from scoped_ev ev
       join media_evidence_variants mv on mv.evidence_id = ev.id
       join storage_objects so on so.id = mv.storage_object_id
     ),
     all_distinct as (
       select id, size_bytes, status from distinct_orig
       union
       select id, size_bytes, status from distinct_var
     )
     select
       coalesce((select sum(size_bytes) from distinct_orig where status = 'ready'), 0)::text as originals_bytes,
       coalesce((select sum(size_bytes) from distinct_var where status = 'ready'), 0)::text as variants_bytes,
       coalesce((select sum(size_bytes) from distinct_orig where status = 'quarantined' or processing_state = 'quarantined'), 0)::text as quarantined_bytes,
       coalesce((select sum(size_bytes) from all_distinct where status = 'archived'), 0)::text as archived_bytes,
       coalesce((select sum(size_bytes) from all_distinct where status in ('authorized','uploading','uploaded_unverified')), 0)::text as staging_pending_bytes,
       coalesce((select sum(size_bytes) from all_distinct where status <> 'cancelled'), 0)::text as total_physical_bytes`,
    params,
  );

  const legacyBytesRow = scope.isGlobalReader
    ? await one<{ legacy_private_files_bytes: string; legacy_private_files_count: number }>(
        db,
        `select coalesce(sum(octet_length(data)), 0)::text as legacy_private_files_bytes,
                count(*)::int as legacy_private_files_count
         from private_files where key not like 'staging/%'`,
      )
    : { legacy_private_files_bytes: "0", legacy_private_files_count: 0 };

  const byInstance = (
    await db.query<{
      storage_instance_id: string | null;
      instance_key: string;
      object_count: number;
      physical_bytes: string;
    }>(
      `with scoped_objs as (
         select distinct so.id, so.storage_instance_id, so.storage_provider_key, so.size_bytes, so.status
         from media_evidence_records r
         join storage_objects so on so.id = r.original_object_id
         ${scopeWhere ? `${scopeWhere} and so.status <> 'cancelled'` : "where so.status <> 'cancelled'"}
         union
         select distinct so.id, so.storage_instance_id, so.storage_provider_key, so.size_bytes, so.status
         from media_evidence_records r
         join media_evidence_variants mv on mv.evidence_id = r.id
         join storage_objects so on so.id = mv.storage_object_id
         ${scopeWhere ? `${scopeWhere} and so.status <> 'cancelled'` : "where so.status <> 'cancelled'"}
       )
       select s.storage_instance_id,
              coalesce(si.instance_key, s.storage_provider_key) as instance_key,
              count(*)::int as object_count,
              coalesce(sum(s.size_bytes), 0)::text as physical_bytes
       from scoped_objs s
       left join storage_instances si on si.id = s.storage_instance_id
       group by s.storage_instance_id, coalesce(si.instance_key, s.storage_provider_key)
       order by physical_bytes desc`,
      params,
    )
  ).rows;

  const rateCards = (
    await db.query<{
      id: string;
      storage_instance_id: string | null;
      currency: string;
      rate_version: string;
      storage_gb_month_cents: string;
      effective_from: Date;
    }>(
      `select distinct on (coalesce(storage_instance_id::text, '__default__'))
              id, storage_instance_id, currency, rate_version, storage_gb_month_cents::text, effective_from
       from storage_cost_rate_cards
       where effective_from <= now()
       order by coalesce(storage_instance_id::text, '__default__'), effective_from desc, created_at desc`,
    )
  ).rows;

  const defaultRate = rateCards.find((c) => c.storage_instance_id === null) ?? null;
  let estimatedMonthlyCostCents: number | null = null;
  const usedRateVersions: string[] = [];
  let costCurrency: string | null = null;
  for (const instRow of byInstance) {
    const matched =
      rateCards.find((c) => c.storage_instance_id && c.storage_instance_id === instRow.storage_instance_id) ??
      defaultRate;
    if (!matched) continue;
    const gb = Number(instRow.physical_bytes) / (1024 * 1024 * 1024);
    const cents = Math.round(gb * Number(matched.storage_gb_month_cents) * 100) / 100;
    estimatedMonthlyCostCents = Math.round(((estimatedMonthlyCostCents ?? 0) + cents) * 100) / 100;
    usedRateVersions.push(matched.rate_version);
    costCurrency = costCurrency ?? matched.currency;
  }

  return {
    counts: {
      ...counts,
      logical_entity_links_count: linkCountRow.logical_entity_links_count,
      command_attempts: cmdStats,
    },
    physical_bytes: {
      ...phys,
      ...legacyBytesRow,
    },
    by_storage_instance: byInstance,
    cost_accounting:
      usedRateVersions.length > 0
        ? {
            cost_basis: "estimated_rate_card" as const,
            currency: costCurrency,
            rate_versions: [...new Set(usedRateVersions)],
            estimated_monthly_cost_cents: estimatedMonthlyCostCents,
            actual_provider_bill_cents: null,
            shared_object_allocation_rule: "deduplicated_by_storage_object_id",
            note: METRIC_DISCLAIMERS.cost_estimated,
          }
        : {
            cost_basis: "unknown" as const,
            currency: null,
            rate_versions: [],
            estimated_monthly_cost_cents: null,
            actual_provider_bill_cents: null,
            shared_object_allocation_rule: "deduplicated_by_storage_object_id",
            note: METRIC_DISCLAIMERS.cost_unknown,
          },
    disclaimers: {
      employee_count: METRIC_DISCLAIMERS.employee_count,
    },
  };
}

export async function createStorageCostRateCard(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  const input = createCostRateCardSchema.parse(rawBody);
  if (input.storage_instance_id) {
    await one(db, "select id from storage_instances where id = $1", [input.storage_instance_id]);
  }
  const id = uuid();
  const row = await one(
    db,
    `insert into storage_cost_rate_cards (
       id, storage_instance_id, currency, rate_version, storage_gb_month_cents,
       egress_gb_cents, class_a_per_million_cents, class_b_per_million_cents, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id, storage_instance_id, currency, rate_version, storage_gb_month_cents::text, effective_from, created_at`,
    [
      id,
      input.storage_instance_id ?? null,
      input.currency.toUpperCase(),
      input.rate_version,
      input.storage_gb_month_cents,
      input.egress_gb_cents ?? null,
      input.class_a_per_million_cents ?? null,
      input.class_b_per_million_cents ?? null,
      actor.id,
    ],
  );
  await audit(db, actor, "storage_cost_rate_card_created", "storage_cost_rate_cards", id, {
    rate_version: input.rate_version,
    storage_instance_id: input.storage_instance_id ?? null,
  });
  return { rate_card: row };
}

export async function createMediaExportJob(
  db: DB,
  actor: Actor,
  sessionHash: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...MEDIA_EXPORT_ROLES);
  const input = createExportJobSchema.parse(rawBody);
  if (input.include_originals) {
    guard(
      actor.roles.includes("super_admin"),
      "FORBIDDEN",
      "Exporting manifests with include_originals requires super_admin approval and fresh MFA.",
      403,
    );
    await requireStaffMfa(db, actor, sessionHash, 15);
  }

  const scope = await resolveStaffMediaScope(db, actor);
  const params: unknown[] = [];
  const whereSql = buildScopedWhereClause(scope, actor, input.filters, params);
  const limitP = `$${params.length + 1}`;

  const rows = (
    await db.query<{
      id: string;
      capture_key: string;
      original_object_id: string;
      original_sha256: string;
      original_size_bytes: string;
      original_mime: string;
      source_type: string;
      source_trust_level: string;
      evidence_purpose: string;
      actual_captured_at: Date | null;
      time_source: string;
      time_unknown_reason: string | null;
      processing_state: string;
      report_versions: unknown;
    }>(
      `select r.id, r.capture_key, r.original_object_id, r.original_sha256, r.original_size_bytes::text,
              r.original_mime, r.source_type, r.source_trust_level, r.evidence_purpose,
              r.actual_captured_at, r.time_source, r.time_unknown_reason, r.processing_state,
              coalesce((
                select jsonb_agg(jsonb_build_object('report_version_id', l.entity_id, 'version', rv.version, 'state', rv.state))
                from media_evidence_links l
                join report_versions rv on rv.id = l.entity_id
                where l.evidence_id = r.id and l.status = 'active' and l.entity_type = 'report_version'
              ), '[]'::jsonb) as report_versions
       from media_evidence_records r
       ${whereSql}
       order by r.created_at desc, r.id desc
       limit ${limitP}`,
      [...params, input.max_items],
    )
  ).rows;

  const manifest = rows.map((r) => ({
    evidence_id: r.id,
    capture_key: r.capture_key,
    original_sha256: r.original_sha256,
    original_size_bytes: Number(r.original_size_bytes),
    original_mime: r.original_mime,
    source_type: r.source_type,
    source_trust_level: r.source_trust_level,
    evidence_purpose: r.evidence_purpose,
    actual_captured_at: r.actual_captured_at ? r.actual_captured_at.toISOString() : null,
    time_source: r.time_source,
    time_unknown_reason: r.time_unknown_reason,
    processing_state: r.processing_state,
    report_versions: r.report_versions,
    original_object_id: input.include_originals ? r.original_object_id : null,
  }));

  const manifestSha = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const totalBytes = manifest.reduce((acc, item) => acc + item.original_size_bytes, 0);
  const jobId = uuid();
  const jobKey = `exp-${Date.now()}-${jobId.slice(0, 8)}`;

  const job = await one(
    db,
    `insert into media_export_jobs (
       id, job_key, requested_by, purpose_reason, filter_snapshot, include_originals,
       max_items, matched_count, exported_count, total_bytes, manifest_json, manifest_sha256,
       status, expires_at
     ) values (
       $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$8,$9,$10::jsonb,$11,'completed',now() + interval '24 hours'
     )
     returning id, job_key, requested_by, purpose_reason, include_originals, max_items,
               matched_count, exported_count, total_bytes::text, manifest_sha256, status, expires_at, created_at`,
    [
      jobId,
      jobKey,
      actor.id,
      input.purpose_reason,
      JSON.stringify(input.filters),
      input.include_originals,
      input.max_items,
      manifest.length,
      totalBytes,
      JSON.stringify(manifest),
      manifestSha,
    ],
  );

  await audit(db, actor, "media_export_job_created", "media_export_jobs", jobId, {
    job_key: jobKey,
    purpose_reason: input.purpose_reason,
    include_originals: input.include_originals,
    exported_count: manifest.length,
    manifest_sha256: manifestSha,
  });

  return { job, manifest };
}

export async function listMediaExportJobs(db: DB, actor: Actor) {
  role(actor, ...MEDIA_EXPORT_ROLES);
  const isSuper = actor.roles.includes("super_admin");
  const rows = (
    await db.query(
      `select j.id, j.job_key, j.requested_by, u.display_name as requested_by_name, j.purpose_reason,
              j.include_originals, j.max_items, j.matched_count, j.exported_count, j.total_bytes::text,
              j.manifest_sha256, j.status, j.expires_at, j.cancelled_at, j.created_at
       from media_export_jobs j
       left join users u on u.id = j.requested_by
       ${isSuper ? "" : "where j.requested_by = $1"}
       order by j.created_at desc
       limit 30`,
      isSuper ? [] : [actor.id],
    )
  ).rows;
  return { exports: rows };
}

export async function getMediaExportJob(db: DB, actor: Actor, jobId: string) {
  role(actor, ...MEDIA_EXPORT_ROLES);
  const job = await one<{ requested_by: string; expires_at: Date; status: string } & Record<string, unknown>>(
    db,
    `select j.*, j.total_bytes::text as total_bytes
     from media_export_jobs j where j.id = $1`,
    [jobId],
  );
  if (!actor.roles.includes("super_admin") && job.requested_by !== actor.id) {
    guard(false, "FORBIDDEN", "Cannot view another staff member's export job.", 403);
  }
  return { job };
}

export async function cancelMediaExportJob(db: DB, actor: Actor, jobId: string) {
  role(actor, ...MEDIA_EXPORT_ROLES);
  const job = await one<{ id: string; requested_by: string; status: string }>(
    db,
    "select id, requested_by, status from media_export_jobs where id = $1 for update",
    [jobId],
  );
  if (!actor.roles.includes("super_admin") && job.requested_by !== actor.id) {
    guard(false, "FORBIDDEN", "Cannot cancel another staff member's export job.", 403);
  }
  guard(["queued", "running", "completed"].includes(job.status), "EXPORT_ALREADY_FINAL", `Cannot cancel export in status '${job.status}'.`, 409);
  const updated = await one(
    db,
    `update media_export_jobs
     set status = 'cancelled', cancelled_by = $2, cancelled_at = now(), updated_at = now()
     where id = $1
     returning id, job_key, status, cancelled_at`,
    [job.id, actor.id],
  );
  await audit(db, actor, "media_export_job_cancelled", "media_export_jobs", job.id, {});
  return { job: updated };
}

export async function listMediaRetentionRequests(db: DB, actor: Actor) {
  role(actor, ...MEDIA_RETENTION_OPERATORS, "reviewer");
  const rows = (
    await db.query(
      `select rr.*, r.capture_key, r.processing_state, r.legal_hold,
              req_u.display_name as requested_by_name, app_u.display_name as approved_by_name
       from media_retention_requests rr
       join media_evidence_records r on r.id = rr.evidence_id
       left join users req_u on req_u.id = rr.requested_by
       left join users app_u on app_u.id = rr.approved_by
       order by rr.created_at desc
       limit 50`,
    )
  ).rows;
  return { requests: rows };
}

export async function createMediaRetentionRequest(
  db: DB,
  actor: Actor,
  evidenceId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "inspector", "reviewer", ...MEDIA_RETENTION_OPERATORS);
  const scope = await resolveStaffMediaScope(db, actor);
  const input = createRetentionRequestSchema.parse(rawBody);
  const ev = await one<{
    id: string;
    original_object_id: string;
    legal_hold: boolean;
    processing_state: string;
    retention_until: Date | null;
    source_type: string;
    evidence_purpose: string;
    warehouse_id: string | null;
    capture_responsible_user_id: string | null;
    command_issuer_user_id: string | null;
    uploader_user_id: string;
  }>(
    db,
    `select id, original_object_id, legal_hold, processing_state, retention_until,
            source_type, evidence_purpose, warehouse_id,
            capture_responsible_user_id, command_issuer_user_id, uploader_user_id
     from media_evidence_records where id = $1 for share`,
    [evidenceId],
  );
  assertStaffScopeForEvidence(scope, actor, ev);

  const impact = await one<{
    active_links_count: number;
    published_report_citations: number;
    variants_count: number;
  }>(
    db,
    `select
       (select count(*)::int from media_evidence_links where evidence_id = $1 and status = 'active') as active_links_count,
       (select count(*)::int from media_evidence_links l
        join report_versions rv on rv.id = l.entity_id
        where l.evidence_id = $1 and l.status = 'active' and l.entity_type = 'report_version' and rv.state in ('qa_approved','published')) as published_report_citations,
       (select count(*)::int from media_evidence_variants where evidence_id = $1) as variants_count`,
    [ev.id],
  );

  const reqId = uuid();
  const request = await one(
    db,
    `insert into media_retention_requests (
       id, evidence_id, action_type, reason, requested_by, status, impact_snapshot
     ) values ($1, $2, $3, $4, $5, 'pending', $6::jsonb)
     returning *`,
    [
      reqId,
      ev.id,
      input.action_type,
      input.reason,
      actor.id,
      JSON.stringify({
        ...impact,
        legal_hold: ev.legal_hold,
        processing_state: ev.processing_state,
        retention_until: ev.retention_until ? ev.retention_until.toISOString() : null,
      }),
    ],
  );

  await audit(db, actor, "media_retention_request_created", "media_retention_requests", reqId, {
    evidence_id: ev.id,
    action_type: input.action_type,
    impact,
  });

  return { request };
}

export async function decideMediaRetentionRequest(
  db: DB,
  actor: Actor,
  sessionHash: string,
  requestId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...MEDIA_RETENTION_OPERATORS);
  const input = decideRetentionRequestSchema.parse(rawBody);
  const reqRow = await one<{
    id: string;
    evidence_id: string;
    action_type: string;
    reason: string;
    requested_by: string;
    status: string;
  }>(
    db,
    "select id, evidence_id, action_type, reason, requested_by, status from media_retention_requests where id = $1 for update",
    [requestId],
  );
  guard(reqRow.status === "pending", "INVALID_RETENTION_STATE", `Request is already in status '${reqRow.status}'.`, 409);

  if (input.decision === "reject") {
    const updated = await one(
      db,
      `update media_retention_requests
       set status = 'rejected', approved_by = $2, approved_at = now(), decision_note = $3, updated_at = now()
       where id = $1
       returning *`,
      [reqRow.id, actor.id, input.note ?? "Rejected by operator"],
    );
    await audit(db, actor, "media_retention_request_rejected", "media_retention_requests", reqRow.id, {
      evidence_id: reqRow.evidence_id,
      action_type: reqRow.action_type,
    });
    return { request: updated };
  }

  const highRiskAction = reqRow.action_type === "controlled_delete" || reqRow.action_type === "release_legal_hold";
  if (highRiskAction) {
    role(actor, "super_admin");
    await requireStaffMfa(db, actor, sessionHash, 15);
    guard(
      reqRow.requested_by !== actor.id,
      "SOD_VIOLATION",
      `Separation of duties forbids requester from self-approving '${reqRow.action_type}'.`,
      403,
    );
  }

  const ev = await one<{
    id: string;
    original_object_id: string;
    processing_state: string;
    original_ready: boolean;
    legal_hold: boolean;
    retention_until: Date | null;
    quarantine_reason: string | null;
  }>(
    db,
    `select id, original_object_id, processing_state, original_ready, legal_hold, retention_until, quarantine_reason
     from media_evidence_records where id = $1 for update`,
    [reqRow.evidence_id],
  );

  const obj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    object_key: string;
    status: string;
    legal_hold: boolean;
    retention_until: Date | null;
  }>(
    db,
    `select id, storage_instance_id, storage_provider_key, object_key, status, legal_hold, retention_until
     from storage_objects where id = $1 for update`,
    [ev.original_object_id],
  );

  if (reqRow.action_type === "quarantine") {
    await db.query(
      `update media_evidence_records
       set processing_state = 'quarantined', customer_visible = false, quarantine_reason = $2, updated_at = now()
       where id = $1`,
      [ev.id, reqRow.reason],
    );
  } else if (reqRow.action_type === "release_quarantine") {
    guard(ev.quarantine_reason !== "controlled_delete_executed", "MEDIA_DELETED_OR_ARCHIVED", "Deleted media cannot be un-quarantined.", 409);
    guard(ev.original_ready && obj.status === "ready", "OBJECT_NOT_READY", "Verified original object is required before releasing quarantine.", 409);
    await db.query(
      `update media_evidence_records
       set processing_state = 'ready', quarantine_reason = null, updated_at = now()
       where id = $1`,
      [ev.id],
    );
  } else if (reqRow.action_type === "set_legal_hold") {
    await db.query("update storage_objects set legal_hold = true, updated_at = now() where id = $1", [obj.id]);
    await db.query("update media_evidence_records set legal_hold = true, updated_at = now() where id = $1", [ev.id]);
  } else if (reqRow.action_type === "release_legal_hold") {
    await db.query("update storage_objects set legal_hold = false, updated_at = now() where id = $1", [obj.id]);
    await db.query("update media_evidence_records set legal_hold = false, updated_at = now() where id = $1", [ev.id]);
  } else if (reqRow.action_type === "archive") {
    guard(!ev.legal_hold && !obj.legal_hold, "DELETION_PROTECTED", "Cannot archive media while legal_hold is active.", 409);
    if (obj.status === "ready") {
      await db.query("update storage_objects set status = 'archived', updated_at = now() where id = $1", [obj.id]);
    }
  } else if (reqRow.action_type === "restore_archived") {
    guard(ev.quarantine_reason !== "controlled_delete_executed", "MEDIA_DELETED_OR_ARCHIVED", "Controlled-deleted media cannot be restored via archive restore.", 409);
    const { provider } = await resolveObjectStorageProviderForRead(db, obj);
    const head = await provider.headObject(obj.object_key);
    guard(head.exists, "OBJECT_MISSING_IN_STORAGE", "Underlying object is missing in storage provider.", 404);
    await db.query("update storage_objects set status = 'ready', updated_at = now() where id = $1", [obj.id]);
  } else if (reqRow.action_type === "controlled_delete") {
    const blockingRefs = await one<{
      published_reports: number;
      open_incidents: number;
      open_disputes: number;
    }>(
      db,
      `select
         (select count(*)::int from media_evidence_links l
          join report_versions rv on rv.id = l.entity_id
          where l.evidence_id = $1 and l.status = 'active' and l.entity_type = 'report_version' and rv.state in ('qa_approved','published')) as published_reports,
         (select count(*)::int from media_evidence_links l
          join incident_cases ic on ic.id = l.entity_id
          where l.evidence_id = $1 and l.status = 'active' and l.entity_type = 'incident' and ic.state not in ('resolved','closed')) as open_incidents,
         (select count(*)::int from media_evidence_links l
          join orders o on o.id = l.entity_id
          join charge_allocations ca on ca.order_id = o.id
          join payments p on p.charge_item_id = ca.charge_id
          join payment_disputes pd on pd.payment_id = p.id
          where l.evidence_id = $1 and l.status = 'active' and l.entity_type = 'order' and pd.state = 'open') as open_disputes`,
      [ev.id],
    );

    const retentionActive =
      (ev.retention_until && ev.retention_until.getTime() > Date.now()) ||
      (obj.retention_until && obj.retention_until.getTime() > Date.now());
    if (
      ev.legal_hold ||
      obj.legal_hold ||
      retentionActive ||
      blockingRefs.published_reports > 0 ||
      blockingRefs.open_incidents > 0 ||
      blockingRefs.open_disputes > 0
    ) {
      const reasonCode =
        ev.legal_hold || obj.legal_hold
          ? "legal_hold"
          : blockingRefs.published_reports > 0
            ? "published_report_citation"
            : blockingRefs.open_incidents > 0 || blockingRefs.open_disputes > 0
              ? "open_incident_or_dispute"
              : "retention_active";
      await db.query(
        `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
         values($1, $2, $3, 'delete_blocked', $4)`,
        [obj.id, actor.id, actor.kind, `controlled_delete_blocked:${reasonCode}`.slice(0, 120)],
      );
      return {
        http_status: 409 as const,
        error: {
          code: "DELETION_PROTECTED",
          message: `Controlled deletion blocked (${reasonCode}): protected by legal hold, published report citation, open dispute/incident, or active retention.`,
        },
      };
    }

    const { provider } = await resolveObjectStorageProviderForRead(db, obj);
    const variantRows = (
      await db.query<{ id: string; storage_object_id: string; storage_instance_id: string | null; storage_provider_key: string; object_key: string; status: string }>(
        `select v.id, v.storage_object_id, so.storage_instance_id, so.storage_provider_key, so.object_key, so.status
         from media_evidence_variants v
         join storage_objects so on so.id = v.storage_object_id
         where v.evidence_id = $1`,
        [ev.id],
      )
    ).rows;

    try {
      await provider.deleteObject(obj.object_key);
      for (const vr of variantRows) {
        if (vr.status === "ready") {
          const vp = await resolveObjectStorageProviderForRead(db, vr);
          await vp.provider.deleteObject(vr.object_key);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Remote object delete failed.";
      await db.query(
        `update media_retention_requests
         set status = 'failed', approved_by = $2, approved_at = now(), decision_note = $3,
             execution_error = $4, updated_at = now()
         where id = $1`,
        [reqRow.id, actor.id, input.note ?? null, msg.slice(0, 500)],
      );
      await db.query(
        `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
         values($1, $2, $3, 'delete_blocked', $4)`,
        [obj.id, actor.id, actor.kind, `remote_delete_failed:${msg.slice(0, 80)}`],
      );
      return {
        http_status: 502 as const,
        error: {
          code: "REMOTE_DELETE_FAILED",
          message: `Controlled deletion failed at storage provider: ${msg}`,
        },
      };
    }

    for (const vr of variantRows) {
      if (vr.status === "ready") {
        await db.query("update storage_objects set status = 'archived', updated_at = now() where id = $1", [
          vr.storage_object_id,
        ]);
      }
    }
    if (obj.status === "ready") {
      await db.query("update storage_objects set status = 'archived', updated_at = now() where id = $1", [obj.id]);
    }
    await db.query(
      `update media_evidence_records
       set processing_state = 'cancelled',
           original_ready = false,
           derivatives_ready = false,
           customer_visible = false,
           quarantine_reason = 'controlled_delete_executed',
           updated_at = now()
       where id = $1`,
      [ev.id],
    );
    await db.query(
      `update media_evidence_links
       set status = 'revoked', reason = coalesce(reason, $2), updated_at = now()
       where evidence_id = $1 and status = 'active'`,
      [ev.id, reqRow.reason],
    );
    await db.query(
      `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
       values($1, $2, $3, 'delete_executed', 'controlled_delete_executed')`,
      [obj.id, actor.id, actor.kind],
    );
    await recordRevocationTombstone(db, {
      entityType: "media_controlled_delete",
      entityId: ev.id,
      revokedBy: actor.id,
      reason: reqRow.reason,
      details: { request_id: reqRow.id, object_id: obj.id },
    });
  }

  const executed = await one(
    db,
    `update media_retention_requests
     set status = 'executed', approved_by = $2, approved_at = now(), decision_note = $3,
         executed_at = now(), execution_error = null, updated_at = now()
     where id = $1
     returning *`,
    [reqRow.id, actor.id, input.note ?? null],
  );

  await audit(db, actor, "media_retention_request_executed", "media_retention_requests", reqRow.id, {
    evidence_id: reqRow.evidence_id,
    action_type: reqRow.action_type,
  });

  return { request: executed };
}

export async function switchVerifiedLegacyMigrationPointers(
  db: DB,
  actor: Actor,
  sessionHash: string,
  jobId: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const job = await one<{
    id: string;
    job_key: string;
    status: string;
    failed_objects: number;
  }>(
    db,
    "select id, job_key, status, failed_objects from storage_migration_jobs where id = $1 for update",
    [jobId],
  );
  guard(
    job.status === "completed" && job.failed_objects === 0,
    "MIGRATION_NOT_READY_FOR_SWITCH",
    "Migration job must be 'completed' with 0 failed objects before pointer switch.",
    409,
  );

  const items = (
    await db.query<{
      id: string;
      source_key: string;
      target_object_id: string;
      verified_sha256: string;
    }>(
      `select id, source_key, target_object_id, verified_sha256
       from storage_migration_items
       where job_id = $1 and status = 'verified' and target_object_id is not null
       order by source_key asc`,
      [job.id],
    )
  ).rows;

  let switchedReports = 0;
  let switchedMediaAssets = 0;
  let switchedThumbs = 0;
  let backfilledEvidence = 0;

  for (const item of items) {
    await db.query("savepoint mig_switch_item");
    try {
      const rv = (
        await db.query<{ id: string; pdf_sha256: string | null }>(
          "select id, pdf_sha256 from report_versions where pdf_key = $1",
          [item.source_key],
        )
      ).rows[0];
      if (rv) {
        guard(
          !rv.pdf_sha256 || rv.pdf_sha256 === item.verified_sha256,
          "LEGACY_PDF_HASH_MISMATCH",
          `Published report version ${rv.id} pdf_sha256 (${rv.pdf_sha256}) does not match migrated object SHA-256 (${item.verified_sha256}).`,
          409,
        );
        // Published report_versions rows are strictly immutable under freeze_report; record dual-read localization in legacy_file_storage_pointers.
        await db.query(
          `insert into legacy_file_storage_pointers (legacy_key, storage_object_id, verified_sha256, migration_job_id, switched_by, switched_at)
           values ($1, $2, $3, $4, $5, now())
           on conflict (legacy_key) do update set
             storage_object_id = excluded.storage_object_id,
             verified_sha256 = excluded.verified_sha256,
             migration_job_id = excluded.migration_job_id,
             switched_by = excluded.switched_by,
             switched_at = now()`,
          [item.source_key, item.target_object_id, item.verified_sha256, job.id, actor.id],
        );
        switchedReports += 1;
      }

      const ma = (
        await db.query<{
          id: string;
          org_id: string | null;
          order_id: string | null;
          item_id: string | null;
          package_id: string | null;
          task_id: string | null;
          kind: string;
          mime: string;
          size_bytes: number;
          sha256: string;
          status: string;
          captured_at: Date | null;
          uploaded_by: string | null;
        }>(
          `select id, org_id, order_id, item_id, package_id, task_id, kind, mime, size_bytes, sha256, status, captured_at, uploaded_by
           from media_assets where object_key = $1 for update`,
          [item.source_key],
        )
      ).rows[0];

      if (ma) {
        guard(
          ma.sha256 === item.verified_sha256,
          "LEGACY_MEDIA_HASH_MISMATCH",
          `Legacy media_asset ${ma.id} sha256 does not match migrated object SHA-256.`,
          409,
        );
        await db.query("update media_assets set storage_object_id = $2 where id = $1", [ma.id, item.target_object_id]);
        await db.query(
          `insert into legacy_file_storage_pointers (legacy_key, storage_object_id, verified_sha256, migration_job_id, switched_by, switched_at)
           values ($1, $2, $3, $4, $5, now())
           on conflict (legacy_key) do update set
             storage_object_id = excluded.storage_object_id,
             verified_sha256 = excluded.verified_sha256,
             migration_job_id = excluded.migration_job_id,
             switched_by = excluded.switched_by,
             switched_at = now()`,
          [item.source_key, item.target_object_id, item.verified_sha256, job.id, actor.id],
        );
        switchedMediaAssets += 1;

        const existingEv = (
          await db.query<{ id: string }>(
            "select id from media_evidence_records where legacy_media_asset_id = $1 limit 1",
            [ma.id],
          )
        ).rows[0];

        if (!existingEv) {
          const evId = uuid();
          const purposeMap: Record<string, (typeof EVIDENCE_PURPOSES)[number]> = {
            intake_outer: "receiving_outer",
            intake_open: "receiving_open",
            shot: "inspection_shot",
            defect: "inspection_defect",
            attachment: "customer_reference",
            label_photo: "receiving_open",
            dispatch: "packing_dispatch",
          };
          const purpose = purposeMap[ma.kind] ?? "inspection_shot";
          const mediaKind = ma.mime === "application/pdf" ? "document" : ma.mime.startsWith("video/") ? "video" : "photo";
          const timeSource: (typeof TIME_SOURCES)[number] = ma.captured_at ? "legacy_migrated" : "unknown";
          const timeUnknownReason = ma.captured_at ? null : "legacy_asset_missing_captured_at";
          const isReady = ma.status === "ready";

          // Never invent capture_responsible_user_id from uploaded_by and never fabricate device_id.
          await db.query(
            `insert into media_evidence_records (
               id, capture_key, original_object_id, legacy_media_asset_id,
               source_type, source_trust_level, evidence_purpose, media_kind,
               command_issuer_user_id, capture_responsible_user_id, uploader_user_id,
               actual_captured_at, time_source, time_unknown_reason,
               server_received_at, server_verified_at,
               original_sha256, original_size_bytes, original_mime,
               processing_state, original_ready, derivatives_ready, is_business_evidence, retention_class
             ) values (
               $1, $2, $3, $4,
               'legacy_migration', 'legacy_unknown', $5, $6,
               null, null, $7,
               $8, $9, $10,
               now(), now(),
               $11, $12, $13,
               $14, $15, false, true, 'standard_evidence'
             )`,
            [
              evId,
              `legacy-${ma.id}`,
              item.target_object_id,
              ma.id,
              purpose,
              mediaKind,
              ma.uploaded_by ?? actor.id,
              ma.captured_at,
              timeSource,
              timeUnknownReason,
              ma.sha256,
              ma.size_bytes,
              ma.mime,
              isReady ? "ready" : "quarantined",
              isReady,
            ],
          );

          const linkSpecs: Array<{ entityType: string; entityId: string }> = [];
          if (ma.order_id) linkSpecs.push({ entityType: "order", entityId: ma.order_id });
          if (ma.package_id) linkSpecs.push({ entityType: "package", entityId: ma.package_id });
          if (ma.item_id) linkSpecs.push({ entityType: "warehouse_item", entityId: ma.item_id });
          if (ma.task_id) linkSpecs.push({ entityType: "inspection_task", entityId: ma.task_id });
          if (linkSpecs.length === 0 && ma.org_id) {
            linkSpecs.push({ entityType: "org", entityId: ma.org_id });
          }

          for (const ls of linkSpecs) {
            await db.query(
              `insert into media_evidence_links (
                 id, evidence_id, entity_type, entity_id, link_role, org_id, status, linked_by, reason
               ) values ($1, $2, $3, $4, 'primary_capture', $5, 'active', $6, 'legacy_migration_backfill')`,
              [uuid(), evId, ls.entityType, ls.entityId, ma.org_id, actor.id],
            );
          }
          backfilledEvidence += 1;
        }
      }

      const thumbRes = await db.query(
        "update media_assets set thumb_storage_object_id = $2 where thumb_key = $1",
        [item.source_key, item.target_object_id],
      );
      if ((thumbRes.rowCount ?? 0) > 0) {
        await db.query(
          `insert into legacy_file_storage_pointers (legacy_key, storage_object_id, verified_sha256, migration_job_id, switched_by, switched_at)
           values ($1, $2, $3, $4, $5, now())
           on conflict (legacy_key) do update set
             storage_object_id = excluded.storage_object_id,
             verified_sha256 = excluded.verified_sha256,
             migration_job_id = excluded.migration_job_id,
             switched_by = excluded.switched_by,
             switched_at = now()`,
          [item.source_key, item.target_object_id, item.verified_sha256, job.id, actor.id],
        );
      }
      switchedThumbs += thumbRes.rowCount ?? 0;

      await db.query("release savepoint mig_switch_item");
    } catch (err) {
      await db.query("rollback to savepoint mig_switch_item");
      await db.query("release savepoint mig_switch_item");
      throw err;
    }
  }

  await db.query(
    "update storage_migration_jobs set phase = 'switch', updated_at = now() where id = $1",
    [job.id],
  );
  await audit(db, actor, "storage_migration_pointers_switched", "storage_migration_jobs", job.id, {
    job_key: job.job_key,
    switched_reports: switchedReports,
    switched_media_assets: switchedMediaAssets,
    switched_thumbs: switchedThumbs,
    backfilled_evidence: backfilledEvidence,
    retain_source_copy: true,
  });

  return {
    job_id: job.id,
    phase: "switch",
    switched_reports: switchedReports,
    switched_media_assets: switchedMediaAssets,
    switched_thumbs: switchedThumbs,
    backfilled_evidence: backfilledEvidence,
    retain_source_copy: true,
  };
}

export async function rollbackLegacyMigrationPointers(
  db: DB,
  actor: Actor,
  sessionHash: string,
  jobId: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const job = await one<{ id: string; job_key: string }>(
    db,
    "select id, job_key from storage_migration_jobs where id = $1 for update",
    [jobId],
  );

  const r1 = await db.query(
    "delete from legacy_file_storage_pointers where migration_job_id = $1",
    [job.id],
  );
  const r2 = await db.query(
    `update media_assets set storage_object_id = null
     where storage_object_id in (select target_object_id from storage_migration_items where job_id = $1 and target_object_id is not null)`,
    [job.id],
  );
  const r3 = await db.query(
    `update media_assets set thumb_storage_object_id = null
     where thumb_storage_object_id in (select target_object_id from storage_migration_items where job_id = $1 and target_object_id is not null)`,
    [job.id],
  );

  await db.query(
    "update storage_migration_jobs set phase = 'verify', updated_at = now() where id = $1",
    [job.id],
  );
  await audit(db, actor, "storage_migration_pointers_rolled_back", "storage_migration_jobs", job.id, {
    job_key: job.job_key,
    cleared_pointers: r1.rowCount ?? 0,
    cleared_media_assets: r2.rowCount ?? 0,
    cleared_thumbs: r3.rowCount ?? 0,
  });

  return {
    job_id: job.id,
    phase: "verify",
    cleared_pointers: r1.rowCount ?? 0,
    cleared_media_assets: r2.rowCount ?? 0,
    cleared_thumbs: r3.rowCount ?? 0,
  };
}

export async function readLegacyCompatibleBinary(
  db: DB,
  target: { storageObjectId?: string | null; legacyKey: string },
): Promise<{ data: Buffer; mime: string }> {
  let resolvedObjId = target.storageObjectId ?? null;
  if (!resolvedObjId && target.legacyKey) {
    const ptr = (
      await db.query<{ storage_object_id: string }>(
        "select storage_object_id from legacy_file_storage_pointers where legacy_key = $1",
        [target.legacyKey],
      )
    ).rows[0];
    resolvedObjId = ptr?.storage_object_id ?? null;
  }
  if (resolvedObjId) {
    const obj = (
      await db.query<{
        id: string;
        storage_instance_id: string | null;
        storage_provider_key: string;
        object_key: string;
        visibility: string;
        status: string;
        declared_mime: string;
        detected_mime: string | null;
      }>(
        `select id, storage_instance_id, storage_provider_key, object_key, visibility, status, declared_mime, detected_mime
         from storage_objects where id = $1`,
        [resolvedObjId],
      )
    ).rows[0];
    if (obj && obj.status === "ready") {
      const { provider } = await resolveObjectStorageProviderForRead(db, obj);
      const streamRes = await provider.getObjectStream(obj.object_key);
      const data = Buffer.from(await new Response(streamRes.body).arrayBuffer());
      return { data, mime: obj.detected_mime ?? obj.declared_mime };
    }
  }
  return one<{ data: Buffer; mime: string }>(
    db,
    "select data, mime from private_files where key = $1",
    [target.legacyKey],
  );
}

export async function runMediaReconciliation(db: DB, actor: Actor) {
  role(actor, "warehouse_admin", "super_admin");
  const runId = uuid();
  const candidates: Array<{
    key: string;
    type:
      | "missing_storage_object"
      | "orphan_storage_object"
      | "legacy_pdf_hash_mismatch"
      | "legacy_pdf_unmigrated"
      | "legacy_media_missing_provenance"
      | "unresolved_late_quarantine"
      | "command_without_evidence"
      | "revoked_device_active_lease"
      | "cross_tenant_link_risk";
    severity: "low" | "medium" | "high" | "critical";
    evidence_id?: string;
    storage_object_id?: string;
    report_version_id?: string;
    legacy_key?: string;
    details: Record<string, unknown>;
  }> = [];

  const badPdfs = (
    await db.query<{ id: string; pdf_key: string; pdf_sha256: string | null; pdf_storage_object_id: string | null; verified_sha256: string | null; so_status: string | null }>(
      `select rv.id, rv.pdf_key, rv.pdf_sha256, lfp.storage_object_id as pdf_storage_object_id,
              so.verified_sha256, so.status as so_status
       from report_versions rv
       left join legacy_file_storage_pointers lfp on lfp.legacy_key = rv.pdf_key
       left join storage_objects so on so.id = lfp.storage_object_id
       where rv.state in ('published','superseded') and rv.pdf_key is not null`,
    )
  ).rows;
  for (const r of badPdfs) {
    if (!r.pdf_storage_object_id) {
      candidates.push({
        key: `legacy_pdf_unmigrated:${r.id}`,
        type: "legacy_pdf_unmigrated",
        severity: "low",
        report_version_id: r.id,
        legacy_key: r.pdf_key,
        details: { pdf_key: r.pdf_key, pdf_sha256: r.pdf_sha256 },
      });
    } else if (r.so_status !== "ready" || (r.pdf_sha256 && r.verified_sha256 !== r.pdf_sha256)) {
      candidates.push({
        key: `legacy_pdf_hash_mismatch:${r.id}`,
        type: "legacy_pdf_hash_mismatch",
        severity: "critical",
        report_version_id: r.id,
        storage_object_id: r.pdf_storage_object_id,
        legacy_key: r.pdf_key,
        details: { pdf_sha256: r.pdf_sha256, verified_sha256: r.verified_sha256, so_status: r.so_status },
      });
    }
  }

  const missingObjs = (
    await db.query<{ id: string; original_object_id: string; processing_state: string; so_status: string }>(
      `select r.id, r.original_object_id, r.processing_state, so.status as so_status
       from media_evidence_records r
       join storage_objects so on so.id = r.original_object_id
       where r.processing_state = 'ready' and so.status <> 'ready'`,
    )
  ).rows;
  for (const m of missingObjs) {
    candidates.push({
      key: `missing_storage_object:${m.id}`,
      type: "missing_storage_object",
      severity: "high",
      evidence_id: m.id,
      storage_object_id: m.original_object_id,
      details: { evidence_state: m.processing_state, storage_object_status: m.so_status },
    });
  }

  const lateQuarantined = (
    await db.query<{ id: string; capture_key: string; quarantine_reason: string | null }>(
      `select id, capture_key, quarantine_reason
       from media_evidence_records
       where processing_state = 'quarantined' and late_submission_flag = true`,
    )
  ).rows;
  for (const lq of lateQuarantined) {
    candidates.push({
      key: `unresolved_late_quarantine:${lq.id}`,
      type: "unresolved_late_quarantine",
      severity: "medium",
      evidence_id: lq.id,
      details: { capture_key: lq.capture_key, quarantine_reason: lq.quarantine_reason },
    });
  }

  const zombieLeases = (
    await db.query<{ lease_id: string; device_id: string; device_code: string }>(
      `select l.id as lease_id, d.id as device_id, d.device_code
       from device_control_leases l
       join warehouse_devices d on d.id = l.device_id
       where d.approval_status = 'revoked' and l.status = 'active'`,
    )
  ).rows;
  for (const zl of zombieLeases) {
    candidates.push({
      key: `revoked_device_active_lease:${zl.lease_id}`,
      type: "revoked_device_active_lease",
      severity: "critical",
      details: { device_id: zl.device_id, device_code: zl.device_code, lease_id: zl.lease_id },
    });
  }

  const legacyMissing = (
    await db.query<{ id: string; object_key: string }>(
      `select ma.id, ma.object_key
       from media_assets ma
       where ma.status = 'ready'
         and ma.storage_object_id is not null
         and not exists (select 1 from media_evidence_records r where r.legacy_media_asset_id = ma.id)`,
    )
  ).rows;
  for (const lm of legacyMissing) {
    candidates.push({
      key: `legacy_media_missing_provenance:${lm.id}`,
      type: "legacy_media_missing_provenance",
      severity: "medium",
      legacy_key: lm.object_key,
      details: { media_asset_id: lm.id, object_key: lm.object_key },
    });
  }

  const summary = {
    total_anomalies: candidates.length,
    by_type: candidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.type] = (acc[c.type] ?? 0) + 1;
      return acc;
    }, {}),
  };

  await db.query(
    `insert into media_reconciliation_runs (id, triggered_by, summary, anomalies_detected)
     values ($1, $2, $3::jsonb, $4)`,
    [runId, actor.id, JSON.stringify(summary), candidates.length],
  );

  for (const c of candidates) {
    await db.query(
      `insert into media_reconciliation_anomalies (
         id, run_id, anomaly_key, anomaly_type, severity, evidence_id, storage_object_id, report_version_id, legacy_key, details, status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'open')
       on conflict (anomaly_key) do update set
         run_id = excluded.run_id,
         severity = excluded.severity,
         details = excluded.details,
         updated_at = now()`,
      [
        uuid(),
        runId,
        c.key,
        c.type,
        c.severity,
        c.evidence_id ?? null,
        c.storage_object_id ?? null,
        c.report_version_id ?? null,
        c.legacy_key ?? null,
        JSON.stringify(c.details),
      ],
    );
  }

  await audit(db, actor, "media_reconciliation_run", "media_reconciliation_runs", runId, summary);
  return { run_id: runId, summary, anomalies_detected: candidates.length };
}

export async function listMediaReconciliationAnomalies(db: DB, actor: Actor, status?: string) {
  role(actor, "warehouse_admin", "super_admin", "reviewer");
  const params: unknown[] = [];
  let whereSql = "";
  if (status) {
    params.push(status);
    whereSql = "where status = $1";
  }
  const anomalies = (
    await db.query(
      `select * from media_reconciliation_anomalies ${whereSql} order by created_at desc limit 100`,
      params,
    )
  ).rows;
  return { anomalies };
}

export async function resolveMediaReconciliationAnomaly(
  db: DB,
  actor: Actor,
  anomalyId: string,
  note: string,
) {
  role(actor, "warehouse_admin", "super_admin");
  const updated = await one(
    db,
    `update media_reconciliation_anomalies
     set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3, updated_at = now()
     where id = $1
     returning *`,
    [anomalyId, actor.id, note],
  );
  await audit(db, actor, "media_reconciliation_anomaly_resolved", "media_reconciliation_anomalies", anomalyId, {
    note,
  });
  return { anomaly: updated };
}

export async function recordRevocationTombstone(
  db: DB,
  params: {
    entityType: "device_revocation" | "staff_session_revocation" | "report_share_revocation" | "media_controlled_delete";
    entityId: string;
    minAuthGeneration?: number | null;
    revokedBy: string | null;
    reason: string;
    details?: Record<string, unknown>;
  },
) {
  await db.query(
    `insert into recovery_revocation_tombstones (
       id, entity_type, entity_id, min_auth_generation, revoked_by, reason, details
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (entity_type, entity_id, COALESCE(min_auth_generation, 0)) do update set
       revoked_by = excluded.revoked_by,
       reason = excluded.reason,
       details = excluded.details,
       revoked_at = now()`,
    [
      uuid(),
      params.entityType,
      params.entityId,
      params.minAuthGeneration ?? null,
      params.revokedBy,
      params.reason,
      JSON.stringify(params.details ?? {}),
    ],
  );
}

export async function listRevocationTombstones(db: DB, actor: Actor) {
  role(actor, "super_admin", "warehouse_admin");
  const tombstones = (
    await db.query("select * from recovery_revocation_tombstones order by revoked_at desc limit 100")
  ).rows;
  return { tombstones };
}

export async function replayRevocationTombstones(db: DB, actor: Actor, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const rows = (
    await db.query<{
      id: string;
      entity_type: string;
      entity_id: string;
      min_auth_generation: number | null;
      reason: string;
    }>("select id, entity_type, entity_id, min_auth_generation, reason from recovery_revocation_tombstones order by revoked_at asc")
  ).rows;

  let devicesEnforced = 0;
  let sessionsRevoked = 0;
  let sharesRevoked = 0;
  let mediaDeletedEnforced = 0;

  for (const t of rows) {
    if (t.entity_type === "device_revocation") {
      await db.query(
        `update warehouse_devices
         set approval_status = 'revoked',
             online_status = 'offline',
             device_secret_hash = null,
             auth_generation = greatest(auth_generation, coalesce($2, auth_generation + 1)),
             revoked_at = coalesce(revoked_at, now()),
             revocation_reason = coalesce(revocation_reason, $3),
             updated_at = now()
         where id = $1`,
        [t.entity_id, t.min_auth_generation, t.reason],
      );
      await db.query(
        `update device_control_leases
         set status = 'revoked', ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'recovery_tombstone_replay')
         where device_id = $1 and status = 'active'`,
        [t.entity_id],
      );
      devicesEnforced += 1;
    } else if (t.entity_type === "staff_session_revocation") {
      const res = await db.query(
        "update sessions set revoked_at = coalesce(revoked_at, now()) where user_id = $1 and revoked_at is null",
        [t.entity_id],
      );
      sessionsRevoked += res.rowCount ?? 0;
    } else if (t.entity_type === "report_share_revocation") {
      const res = await db.query(
        "update report_shares set revoked_at = coalesce(revoked_at, now()) where id = $1 and revoked_at is null",
        [t.entity_id],
      );
      sharesRevoked += res.rowCount ?? 0;
    } else if (t.entity_type === "media_controlled_delete") {
      const ev = (
        await db.query<{ id: string; original_object_id: string }>(
          "select id, original_object_id from media_evidence_records where id = $1",
          [t.entity_id],
        )
      ).rows[0];
      if (ev) {
        await db.query(
          `update media_evidence_records
           set processing_state = 'cancelled', original_ready = false, derivatives_ready = false,
               customer_visible = false, quarantine_reason = 'controlled_delete_executed', updated_at = now()
           where id = $1`,
          [ev.id],
        );
        await db.query(
          `update storage_objects
           set status = 'archived', updated_at = now()
           where (id = $1 or parent_object_id = $1) and status = 'ready' and legal_hold = false`,
          [ev.original_object_id],
        );
        await db.query(
          "update media_evidence_links set status = 'revoked', updated_at = now() where evidence_id = $1 and status = 'active'",
          [ev.id],
        );
        mediaDeletedEnforced += 1;
      }
    }
    await db.query("update recovery_revocation_tombstones set last_replayed_at = now() where id = $1", [t.id]);
  }

  const summary = {
    replayed_tombstones: rows.length,
    devices_enforced: devicesEnforced,
    sessions_revoked: sessionsRevoked,
    shares_revoked: sharesRevoked,
    media_deleted_enforced: mediaDeletedEnforced,
  };
  await audit(db, actor, "recovery_revocation_tombstones_replayed", "recovery_revocation_tombstones", actor.id, summary);
  return summary;
}
