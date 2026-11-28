import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, guard, hash, lock, one, role, type Actor } from "./common";
import { calculateUnifiedQuote, type CatalogPricingContext } from "./pricing-engine";

export const COST_READ_ROLES = ["super_admin", "finance", "reviewer", "warehouse_admin"] as const;
export const COST_EDIT_ROLES = ["super_admin", "finance"] as const;
export const COST_REVIEW_ROLES = ["super_admin", "reviewer"] as const;
export const LABOR_CAPTURE_ROLES = ["super_admin", "warehouse_admin", "receiver", "inspector", "reviewer", "support"] as const;
export const LABOR_CORRECT_ROLES = ["super_admin", "warehouse_admin", "finance"] as const;

export const LABOR_ACTIVITY_CODES = [
  "order_prep",
  "parcel_intake",
  "unbox_count",
  "sku_label",
  "garment_prep",
  "visual_inspect",
  "module_inspect",
  "measurement_point",
  "remeasurement",
  "photo_capture",
  "photo_retake",
  "video_capture",
  "video_retake",
  "file_upload",
  "transcode_process",
  "upload_retry",
  "exception_log",
  "qa_review",
  "qa_rework",
  "report_compile",
  "repack_putaway",
  "outbound_prep",
  "support",
] as const;

export const TIME_BUCKETS = ["active_labor", "non_parallel_wait", "background_system", "interruption"] as const;

export const laborEventStartSchema = z.object({
  warehouse_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  inspection_task_id: z.string().uuid().optional(),
  dispatch_work_item_id: z.string().uuid().optional(),
  package_id: z.string().uuid().optional(),
  item_id: z.string().uuid().optional(),
  sku_code: z.string().trim().max(80).optional(),
  product_type_code: z.string().trim().max(80).optional(),
  complexity_code: z.enum(["L1", "L2", "L3", "L4", "L5"]).optional(),
  module_code: z.string().trim().max(20).optional(),
  measurement_point_code: z.string().trim().max(60).optional(),
  evidence_id: z.string().uuid().optional(),
  activity_code: z.enum(LABOR_ACTIVITY_CODES),
  time_bucket: z.enum(TIME_BUCKETS).default("active_labor"),
  device_id: z.string().uuid().optional(),
  workstation_id: z.string().uuid().optional(),
  timezone: z.string().trim().min(1).max(80).default("Asia/Shanghai"),
  source_kind: z.enum(["system_event", "auto_hook", "operator_timer", "worker_metric", "manual_correction"]).default("operator_timer"),
  data_provenance: z.enum(["estimated_baseline", "simulated_software", "measured_field", "measured_system"]).default("measured_system"),
  started_at: z.iso.datetime({ offset: true }).optional(),
  wait_reason: z.string().trim().max(300).optional(),
  rework_attribution: z.string().trim().max(300).optional(),
  is_rework: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const backgroundMetricSchema = z.object({
  order_id: z.string().uuid().optional(),
  inspection_task_id: z.string().uuid().optional(),
  evidence_id: z.string().uuid().optional(),
  product_type_code: z.string().trim().max(80).optional(),
  module_code: z.string().trim().max(20).optional(),
  activity_code: z.enum(["file_upload", "transcode_process", "upload_retry"]),
  bytes_transferred: z.number().int().min(0).optional(),
  elapsed_seconds: z.number().int().min(1).max(86_400),
  upload_failed: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const laborCorrectionSchema = z.object({
  corrected_started_at: z.iso.datetime({ offset: true }),
  corrected_ended_at: z.iso.datetime({ offset: true }),
  corrected_effective_seconds: z.number().int().min(0).max(86_400 * 7),
  corrected_time_bucket: z.enum(TIME_BUCKETS).optional(),
  reason: z.string().trim().min(5).max(500),
});

export const listLaborEventsQuerySchema = z.object({
  order_id: z.string().uuid().optional(),
  inspection_task_id: z.string().uuid().optional(),
  operator_id: z.string().uuid().optional(),
  status: z.enum(["active", "paused", "completed", "pending_calibration", "corrected", "voided"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(80),
});

export const laborStatsQuerySchema = z.object({
  product_type_code: z.string().trim().min(1).max(80).optional(),
  complexity_code: z.enum(["L1", "L2", "L3", "L4", "L5"]).optional(),
  module_code: z.string().trim().min(1).max(20).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const saveCostModelSchema = z
  .object({
    id: z.string().uuid().optional(),
    code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
    name_zh: z.string().trim().min(1).max(160),
    name_en: z.string().trim().min(1).max(160),
    description_zh: z.string().trim().max(1000).default(""),
    description_en: z.string().trim().max(1000).default(""),
    currency: z.enum(["USD", "CNY", "HKD", "EUR", "GBP"]).default("USD"),
    labor_hourly_rate_cents: z.number().int().min(0).max(500_000),
    qa_hourly_rate_cents: z.number().int().min(0).max(500_000),
    management_overhead_included_in_labor: z.boolean().default(true),
    management_overhead_pct: z.coerce.number().min(0).max(100).default(0),
    warehouse_fixed_monthly_cents: z.number().int().min(0).max(500_000_000).default(0),
    expected_monthly_orders: z.number().int().min(1).max(1_000_000).default(200),
    equipment_depreciation_per_order_cents: z.number().int().min(0).max(500_000).default(0),
    camera_lighting_per_item_cents: z.number().int().min(0).max(500_000).default(0),
    barcode_label_per_item_cents: z.number().int().min(0).max(500_000).default(0),
    packaging_consumable_per_item_cents: z.number().int().min(0).max(500_000).default(0),
    storage_gb_month_cents: z.number().int().min(0).max(500_000).default(0),
    bandwidth_gb_cents: z.number().int().min(0).max(500_000).default(0),
    video_transcode_per_min_cents: z.number().int().min(0).max(500_000).default(0),
    ai_estimated_per_order_cents: z.number().int().min(0).max(500_000).default(0),
    domestic_logistics_handling_per_order_cents: z.number().int().min(0).max(500_000).default(0),
    payment_fixed_fee_cents: z.number().int().min(0).max(50_000).default(30),
    payment_fee_rate_bps: z.number().int().min(0).max(5000).default(340),
    other_variable_revenue_rate_bps: z.number().int().min(0).max(5000).default(0),
    rework_reserve_rate_bps: z.number().int().min(0).max(5000).default(300),
    support_cost_per_order_cents: z.number().int().min(0).max(500_000).default(150),
    target_contribution_margin_bps: z.number().int().min(0).max(9500).default(2500),
    tax_policy_note: z.string().trim().min(1).max(300).default("Net of pass-through shipping & payment processing fees"),
    default_defect_rate_bps: z.number().int().min(0).max(10000).default(800),
    default_rework_rate_bps: z.number().int().min(0).max(10000).default(400),
    default_avg_mb_per_item: z.coerce.number().min(0).max(5000).default(12),
    fx_cny_per_usd: z.coerce.number().positive().max(100).default(7.2),
    fx_source: z.string().trim().min(1).max(120).default("manual_sandbox_baseline"),
    data_source: z.enum(["estimated_baseline", "field_calibrated"]).default("estimated_baseline"),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.management_overhead_included_in_labor && v.management_overhead_pct > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Management overhead cannot be added when already included in burdened labor rate (§43.3 anti-double-counting).",
      });
    }
  });

export const marginSimulateSchema = z.object({
  cost_model_id: z.string().uuid().optional(),
  pricing_book_id: z.string().uuid().optional(),
  service_type: z.enum(["inspection", "compare", "reference_match"]).default("inspection"),
  product_type_code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/).default("t_shirt"),
  base_qty: z.number().int().min(1).max(10_000).default(10),
  modules: z
    .array(
      z.object({
        module_code: z.string().trim().regex(/^M[0-9]{2}$/),
        option_code: z.string().trim().min(1).max(80).optional(),
        coverage_mode: z.enum(["exact_count", "percentage"]).default("exact_count"),
        coverage_qty: z.number().int().min(1).max(10_000).optional(),
        coverage_pct: z.number().min(0.1).max(100).optional(),
        extra_points: z.number().int().min(1).max(50).optional(),
      }),
    )
    .default([]),
  golden_sample_ids: z.array(z.string().trim().min(1).max(80)).default([]),
  archive_new_golden_samples: z.number().int().min(0).max(100).default(0),
  customer_authorized_destructive: z.boolean().default(false),
  defect_rate_bps: z.number().int().min(0).max(10000).optional(),
  rework_rate_bps: z.number().int().min(0).max(10000).optional(),
  video_minutes: z.number().min(0).max(500).default(0),
  override_target_margin_bps: z.number().int().min(0).max(9500).optional(),
  override_quoted_revenue_cents: z.number().int().min(0).max(500_000_000).optional(),
  allow_unpublished_catalog_in_sim: z.boolean().default(false),
});

export const orderCostEntrySchema = z.object({
  cost_category: z.enum([
    "labor_direct",
    "labor_qa",
    "payment_fee",
    "consumables",
    "packaging",
    "domestic_shipping",
    "media_storage",
    "media_bandwidth",
    "media_transcode",
    "ai_service",
    "rework_reserve",
    "customer_support",
    "fixed_allocation",
  ]),
  cost_nature: z.enum(["direct_variable", "fixed_allocated"]),
  provenance: z.enum(["actual", "estimated", "allocated"]),
  amount_cents: z.number().int().min(0).max(500_000_000),
  original_amount_minor: z.number().int().min(0).max(500_000_000).optional(),
  original_currency: z.enum(["USD", "CNY", "HKD", "EUR", "GBP"]).optional(),
  fx_rate: z.number().positive().max(100).optional(),
  fx_source: z.string().trim().max(120).optional(),
  source_ref: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(500).optional(),
});

// Helper: auto-pause any currently active 'active_labor' session for the same operator so parallel uploads/tasks never double-count labor
async function pauseOtherActiveOperatorLabor(db: DB, operatorId: string, exceptEventId?: string) {
  await db.query(
    `update labor_time_events
     set status = 'paused',
         pause_started_at = coalesce(pause_started_at, now()),
         updated_at = now()
     where operator_id = $1::uuid
       and time_bucket = 'active_labor'
       and status = 'active'
       and ($2::uuid is null or id <> $2::uuid)`,
    [operatorId, exceptEventId ?? null],
  );
}

export async function startLaborEvent(db: DB, actor: Actor, rawInput: unknown) {
  role(actor, ...LABOR_CAPTURE_ROLES);
  const input = laborEventStartSchema.parse(rawInput);

  if (input.time_bucket === "active_labor") {
    await lock(db, `labor_operator:${actor.id}`);
    await pauseOtherActiveOperatorLabor(db, actor.id);
  }

  const row = await one<Record<string, unknown>>(
    db,
    `insert into labor_time_events (
      warehouse_id, order_id, inspection_task_id, dispatch_work_item_id,
      package_id, item_id, sku_code, product_type_code, complexity_code,
      module_code, measurement_point_code, evidence_id,
      activity_code, time_bucket, operator_id, device_id, workstation_id,
      timezone, source_kind, data_provenance, started_at, status,
      wait_reason, rework_attribution, is_rework, metadata
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid,
      $5::uuid, $6::uuid, $7, $8, $9,
      $10, $11, $12::uuid,
      $13, $14, $15::uuid, $16::uuid, $17::uuid,
      $18, $19, $20, coalesce($21::timestamptz, now()), 'active',
      $22, $23, $24::boolean, $25::jsonb
    ) returning *`,
    [
      input.warehouse_id ?? null,
      input.order_id ?? null,
      input.inspection_task_id ?? null,
      input.dispatch_work_item_id ?? null,
      input.package_id ?? null,
      input.item_id ?? null,
      input.sku_code ?? null,
      input.product_type_code ?? null,
      input.complexity_code ?? null,
      input.module_code ?? null,
      input.measurement_point_code ?? null,
      input.evidence_id ?? null,
      input.activity_code,
      input.time_bucket,
      actor.id,
      input.device_id ?? null,
      input.workstation_id ?? null,
      input.timezone,
      input.source_kind,
      input.data_provenance,
      input.started_at ?? null,
      input.wait_reason ?? null,
      input.rework_attribution ?? null,
      input.is_rework,
      JSON.stringify(input.metadata),
    ],
  );
  return row;
}

export async function pauseLaborEvent(db: DB, actor: Actor, eventId: string, waitReason?: string) {
  role(actor, ...LABOR_CAPTURE_ROLES);
  const ev = await one<Record<string, any>>(db, "select * from labor_time_events where id = $1::uuid for update", [eventId]);
  const isSupervisor = actor.roles.some((r) => ["super_admin", "warehouse_admin"].includes(r));
  guard(isSupervisor || ev.operator_id === actor.id, "FORBIDDEN", "Cannot pause another operator's labor timer.", 403);
  guard(ev.status === "active", "INVALID_STATE", `Labor event status '${ev.status}' cannot be paused.`, 409);

  return one<Record<string, unknown>>(
    db,
    `update labor_time_events
     set status = 'paused',
         pause_started_at = now(),
         wait_reason = coalesce($2, wait_reason),
         updated_at = now()
     where id = $1::uuid returning *`,
    [eventId, waitReason ?? null],
  );
}

export async function resumeLaborEvent(db: DB, actor: Actor, eventId: string) {
  role(actor, ...LABOR_CAPTURE_ROLES);
  const ev = await one<Record<string, any>>(db, "select * from labor_time_events where id = $1::uuid for update", [eventId]);
  const isSupervisor = actor.roles.some((r) => ["super_admin", "warehouse_admin"].includes(r));
  guard(isSupervisor || ev.operator_id === actor.id, "FORBIDDEN", "Cannot resume another operator's labor timer.", 403);
  guard(ev.status === "paused", "INVALID_STATE", `Labor event status '${ev.status}' is not paused.`, 409);

  if (ev.time_bucket === "active_labor") {
    await lock(db, `labor_operator:${String(ev.operator_id)}`);
    await pauseOtherActiveOperatorLabor(db, String(ev.operator_id), eventId);
  }

  return one<Record<string, unknown>>(
    db,
    `update labor_time_events
     set status = 'active',
         accumulated_pause_seconds = accumulated_pause_seconds + coalesce(
           greatest(0, extract(epoch from (now() - pause_started_at))::int), 0
         ),
         pause_started_at = null,
         updated_at = now()
     where id = $1::uuid returning *`,
    [eventId],
  );
}

export async function completeLaborEvent(
  db: DB,
  actor: Actor,
  eventId: string,
  opts: { endedAt?: string; isRework?: boolean; reworkAttribution?: string } = {},
) {
  role(actor, ...LABOR_CAPTURE_ROLES);
  const ev = await one<Record<string, any>>(db, "select * from labor_time_events where id = $1::uuid for update", [eventId]);
  const isSupervisor = actor.roles.some((r) => ["super_admin", "warehouse_admin", "finance"].includes(r));
  guard(isSupervisor || ev.operator_id === actor.id, "FORBIDDEN", "Cannot complete another operator's labor timer.", 403);
  guard(ev.status === "active" || ev.status === "paused", "INVALID_STATE", `Labor event status '${ev.status}' cannot be completed.`, 409);
  if (opts.endedAt) {
    const endMs = Date.parse(opts.endedAt);
    const startMs = new Date(ev.started_at).getTime();
    guard(Number.isFinite(endMs) && endMs >= startMs, "INVALID_TIME_RANGE", "ended_at must be >= started_at.", 422);
  }

  return one<Record<string, unknown>>(
    db,
    `update labor_time_events
     set ended_at = coalesce($2::timestamptz, now()),
         accumulated_pause_seconds = accumulated_pause_seconds + case
           when status = 'paused' and pause_started_at is not null then
             greatest(0, extract(epoch from (coalesce($2::timestamptz, now()) - pause_started_at))::int)
           else 0
         end,
         effective_seconds = greatest(
           0,
           extract(epoch from (coalesce($2::timestamptz, now()) - started_at))::int
           - (accumulated_pause_seconds + case
               when status = 'paused' and pause_started_at is not null then
                 greatest(0, extract(epoch from (coalesce($2::timestamptz, now()) - pause_started_at))::int)
               else 0
             end)
         ),
         pause_started_at = null,
         status = 'completed',
         is_rework = coalesce($3::boolean, is_rework),
         rework_attribution = coalesce($4, rework_attribution),
         updated_at = now()
     where id = $1::uuid returning *`,
    [eventId, opts.endedAt ?? null, opts.isRework ?? null, opts.reworkAttribution ?? null],
  );
}

export async function completeOpenTaskLaborEvents(db: DB, inspectionTaskId: string, operatorId?: string) {
  await db.query(
    `update labor_time_events
     set ended_at = now(),
         accumulated_pause_seconds = accumulated_pause_seconds + case
           when status = 'paused' and pause_started_at is not null then
             greatest(0, extract(epoch from (now() - pause_started_at))::int)
           else 0
         end,
         effective_seconds = greatest(
           0,
           extract(epoch from (now() - started_at))::int
           - (accumulated_pause_seconds + case
               when status = 'paused' and pause_started_at is not null then
                 greatest(0, extract(epoch from (now() - pause_started_at))::int)
               else 0
             end)
         ),
         pause_started_at = null,
         status = 'completed',
         updated_at = now()
     where inspection_task_id = $1::uuid
       and status in ('active','paused')
       and ($2::uuid is null or operator_id = $2::uuid)`,
    [inspectionTaskId, operatorId ?? null],
  );
}

export async function pauseOpenTaskOrWorkItemLaborEvents(
  db: DB,
  target: { inspectionTaskId?: string | null; dispatchWorkItemId?: string | null; waitReason?: string },
) {
  if (!target.inspectionTaskId && !target.dispatchWorkItemId) return;
  await db.query(
    `update labor_time_events
     set status = 'paused',
         pause_started_at = coalesce(pause_started_at, now()),
         wait_reason = coalesce($3, wait_reason),
         updated_at = now()
     where status = 'active'
       and time_bucket = 'active_labor'
       and (
         ($1::uuid is not null and inspection_task_id = $1::uuid)
         or ($2::uuid is not null and dispatch_work_item_id = $2::uuid)
       )`,
    [target.inspectionTaskId ?? null, target.dispatchWorkItemId ?? null, target.waitReason ?? null],
  );
}

export async function resumeOpenTaskOrWorkItemLaborEvents(
  db: DB,
  target: { inspectionTaskId?: string | null; dispatchWorkItemId?: string | null },
) {
  if (!target.inspectionTaskId && !target.dispatchWorkItemId) return;
  const rows = (
    await db.query<{ id: string; operator_id: string }>(
      `select id, operator_id from labor_time_events
       where status = 'paused'
         and time_bucket = 'active_labor'
         and (
           ($1::uuid is not null and inspection_task_id = $1::uuid)
           or ($2::uuid is not null and dispatch_work_item_id = $2::uuid)
         )
       order by updated_at desc limit 1`,
      [target.inspectionTaskId ?? null, target.dispatchWorkItemId ?? null],
    )
  ).rows;
    for (const r of rows) {
    await lock(db, `labor_operator:${r.operator_id}`);
    await pauseOtherActiveOperatorLabor(db, r.operator_id, r.id);
    await db.query(
      `update labor_time_events
       set status = 'active',
           accumulated_pause_seconds = accumulated_pause_seconds + coalesce(
             greatest(0, extract(epoch from (now() - pause_started_at))::int), 0
           ),
           pause_started_at = null,
           updated_at = now()
       where id = $1::uuid`,
      [r.id],
    );
  }
}

export async function openHandoverTaskLaborEvent(
  db: DB,
  params: { warehouseId?: string | null; inspectionTaskId: string; dispatchWorkItemId?: string | null; operatorId: string; workstationId?: string | null },
) {
  const taskMeta = (
    await db.query<{ order_id: string }>(
      "select l.order_id from inspection_tasks t join order_lines l on l.id = t.order_line_id where t.id = $1::uuid",
      [params.inspectionTaskId],
    )
  ).rows[0];
  await lock(db, `labor_operator:${params.operatorId}`);
  await pauseOtherActiveOperatorLabor(db, params.operatorId);
  await db.query(
    `insert into labor_time_events (
      warehouse_id, order_id, inspection_task_id, dispatch_work_item_id,
      activity_code, time_bucket, operator_id, workstation_id,
      source_kind, data_provenance, started_at, status
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid,
      'visual_inspect', 'active_labor', $5::uuid, $6::uuid,
      'auto_hook', 'measured_system', now(), 'active'
    )`,
    [
      params.warehouseId ?? null,
      taskMeta?.order_id ?? null,
      params.inspectionTaskId,
      params.dispatchWorkItemId ?? null,
      params.operatorId,
      params.workstationId ?? null,
    ],
  );
}

export async function recordBackgroundSystemMetric(db: DB, actor: Actor, rawInput: unknown) {
  role(actor, ...LABOR_CAPTURE_ROLES);
  const input = backgroundMetricSchema.parse(rawInput);
  return one<Record<string, unknown>>(
    db,
    `insert into labor_time_events (
      order_id, inspection_task_id, evidence_id, product_type_code, module_code,
      activity_code, time_bucket, operator_id, source_kind, data_provenance,
      started_at, ended_at, effective_seconds, status, metadata
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4, $5,
      $6, 'background_system', $7::uuid, 'worker_metric', 'measured_system',
      now() - ($8::int * interval '1 second'), now(), $8::int, 'completed', $9::jsonb
    ) returning *`,
    [
      input.order_id ?? null,
      input.inspection_task_id ?? null,
      input.evidence_id ?? null,
      input.product_type_code ?? null,
      input.module_code ?? null,
      input.activity_code,
      actor.id,
      input.elapsed_seconds,
      JSON.stringify({
        ...input.metadata,
        bytes_transferred: input.bytes_transferred ?? null,
        upload_failed: input.upload_failed,
      }),
    ],
  );
}

export async function markStaleOpenLaborEventsPendingCalibration(
  db: DB,
  actor: Actor,
  maxAgeMinutes = 240,
  sessionHash?: string,
) {
  role(actor, ...COST_EDIT_ROLES, "warehouse_admin");
  if (sessionHash !== undefined) {
    await requireStaffMfa(db, actor, sessionHash, 15);
  }
  const res = (
    await db.query<Record<string, unknown>>(
      `update labor_time_events
       set status = 'pending_calibration',
           wait_reason = coalesce(wait_reason, 'stale_open_session_or_offline_close'),
           updated_at = now()
       where status in ('active','paused')
         and time_bucket = 'active_labor'
         and started_at <= now() - ($1::int * interval '1 minute')
       returning id, activity_code, operator_id, started_at, status`,
      [maxAgeMinutes],
    )
  ).rows;
  return { flagged_count: res.length, flagged_events: res };
}

export async function correctLaborEvent(db: DB, actor: Actor, eventId: string, rawInput: unknown, sessionHash: string) {
  role(actor, ...LABOR_CORRECT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = laborCorrectionSchema.parse(rawInput);

  const ev = await one<Record<string, any>>(db, "select * from labor_time_events where id = $1::uuid for update", [eventId]);
  const cStartMs = Date.parse(input.corrected_started_at);
  const cEndMs = Date.parse(input.corrected_ended_at);
  guard(Number.isFinite(cStartMs) && Number.isFinite(cEndMs) && cEndMs >= cStartMs, "INVALID_TIME_RANGE", "corrected_ended_at must be >= corrected_started_at.", 422);
  const maxSeconds = Math.floor((cEndMs - cStartMs) / 1000);
  guard(
    input.corrected_effective_seconds <= maxSeconds,
    "INVALID_CORRECTION_DURATION",
    `corrected_effective_seconds (${input.corrected_effective_seconds}) cannot exceed interval span (${maxSeconds}s).`,
    422,
  );

  const correction = await one<Record<string, unknown>>(
    db,
    `insert into labor_time_corrections (
      event_id, original_started_at, original_ended_at, original_effective_seconds,
      original_time_bucket, original_status,
      corrected_started_at, corrected_ended_at, corrected_effective_seconds, corrected_time_bucket,
      reason, corrected_by
    ) values (
      $1::uuid, $2::timestamptz, $3::timestamptz, $4::int, $5, $6,
      $7::timestamptz, $8::timestamptz, $9::int, $10, $11, $12::uuid
    ) returning *`,
    [
      eventId,
      ev.started_at,
      ev.ended_at ?? null,
      ev.effective_seconds ?? null,
      ev.time_bucket,
      ev.status,
      input.corrected_started_at,
      input.corrected_ended_at,
      input.corrected_effective_seconds,
      input.corrected_time_bucket ?? ev.time_bucket,
      input.reason,
      actor.id,
    ],
  );

  const updated = await one<Record<string, unknown>>(
    db,
    `update labor_time_events
     set started_at = $2::timestamptz,
         ended_at = $3::timestamptz,
         effective_seconds = $4::int,
         time_bucket = $5,
         pause_started_at = null,
         status = 'corrected',
         updated_at = now()
     where id = $1::uuid returning *`,
    [
      eventId,
      input.corrected_started_at,
      input.corrected_ended_at,
      input.corrected_effective_seconds,
      input.corrected_time_bucket ?? ev.time_bucket,
    ],
  );

  await audit(db, actor, "labor_event_corrected", "labor_time_events", eventId, {
    correction_id: correction.id,
    reason: input.reason,
    original_seconds: ev.effective_seconds,
    corrected_seconds: input.corrected_effective_seconds,
  });
  return { event: updated, correction };
}

export async function listLaborEvents(
  db: DB,
  actor: Actor,
  rawFilters: Record<string, unknown> = {},
) {
  role(actor, ...LABOR_CAPTURE_ROLES, ...COST_READ_ROLES);
  const filters = listLaborEventsQuerySchema.parse(rawFilters);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.order_id) {
    params.push(filters.order_id);
    where.push(`e.order_id = $${params.length}::uuid`);
  }
  if (filters.inspection_task_id) {
    params.push(filters.inspection_task_id);
    where.push(`e.inspection_task_id = $${params.length}::uuid`);
  }
  if (filters.operator_id) {
    params.push(filters.operator_id);
    where.push(`e.operator_id = $${params.length}::uuid`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`e.status = $${params.length}`);
  }
  params.push(filters.limit);
  const rows = (
    await db.query(
      `select e.*, u.display_name as operator_name
       from labor_time_events e
       join users u on u.id = e.operator_id
       ${where.length ? `where ${where.join(" and ")}` : ""}
       order by e.started_at desc, e.id desc
       limit $${params.length}`,
      params,
    )
  ).rows;
  return { events: rows };
}

export async function getLaborStatistics(
  db: DB,
  actor: Actor,
  rawFilters: Record<string, unknown> = {},
) {
  role(actor, ...COST_READ_ROLES);
  const filters = laborStatsQuerySchema.parse(rawFilters);
  const days = filters.days;
  const where = [
    "status in ('completed','corrected')",
    "effective_seconds is not null",
    `started_at >= now() - ($1::int * interval '1 day')`,
  ];
  const params: unknown[] = [days];
  if (filters.product_type_code) {
    params.push(filters.product_type_code);
    where.push(`product_type_code = $${params.length}`);
  }
  if (filters.complexity_code) {
    params.push(filters.complexity_code);
    where.push(`complexity_code = $${params.length}`);
  }
  if (filters.module_code) {
    params.push(filters.module_code);
    where.push(`module_code = $${params.length}`);
  }

  const bucketStats = (
    await db.query<{
      activity_code: string;
      time_bucket: string;
      sample_size: number;
      avg_seconds: number | null;
      p50_seconds: number | null;
      p75_seconds: number | null;
      p90_seconds: number | null;
      max_seconds: number | null;
      total_seconds: number;
    }>(
      `select
         activity_code,
         time_bucket,
         count(*)::int as sample_size,
         round(avg(effective_seconds))::int as avg_seconds,
         round((percentile_cont(0.50) within group (order by effective_seconds)))::int as p50_seconds,
         round((percentile_cont(0.75) within group (order by effective_seconds)))::int as p75_seconds,
         round((percentile_cont(0.90) within group (order by effective_seconds)))::int as p90_seconds,
         max(effective_seconds)::int as max_seconds,
         coalesce(sum(effective_seconds), 0)::int as total_seconds
       from labor_time_events
       where ${where.join(" and ")}
       group by activity_code, time_bucket
       order by sample_size desc, activity_code asc`,
      params,
    )
  ).rows;

  const rateStats = (
    await db.query<{
      total_completed_active: number;
      remeasure_count: number;
      retake_count: number;
      qa_rework_count: number;
      exception_count: number;
      upload_count: number;
      upload_fail_count: number;
    }>(
      `select
         count(*) filter (where time_bucket = 'active_labor')::int as total_completed_active,
         count(*) filter (where activity_code = 'remeasurement')::int as remeasure_count,
         count(*) filter (where activity_code in ('photo_retake','video_retake'))::int as retake_count,
         count(*) filter (where activity_code = 'qa_rework' or is_rework = true)::int as qa_rework_count,
         count(*) filter (where activity_code = 'exception_log')::int as exception_count,
         count(*) filter (where activity_code in ('file_upload','upload_retry'))::int as upload_count,
         count(*) filter (where activity_code = 'upload_retry' or coalesce(metadata->>'upload_failed','false') = 'true')::int as upload_fail_count
       from labor_time_events
       where ${where.join(" and ")}`,
      params,
    )
  ).rows[0]!;

  const baselines = (await db.query<Record<string, any>>("select * from labor_baseline_assumptions order by activity_code, complexity_code")).rows;
  const targetComplexity = filters.complexity_code ?? "ALL";
  const baselineByAct = new Map<string, Record<string, any>>();
  for (const b of baselines) {
    const existing = baselineByAct.get(b.activity_code);
    if (b.complexity_code === targetComplexity) {
      baselineByAct.set(b.activity_code, b);
    } else if (!existing && b.complexity_code === "ALL") {
      baselineByAct.set(b.activity_code, b);
    }
  }
  for (const b of baselines) {
    if (!baselineByAct.has(b.activity_code)) baselineByAct.set(b.activity_code, b);
  }

  const totalActiveSamples = bucketStats.filter((r) => r.time_bucket === "active_labor").reduce((n, r) => n + r.sample_size, 0);
  const statisticalConfidence =
    totalActiveSamples < 10 ? "insufficient_samples" : totalActiveSamples < 30 ? "provisional" : "measured_stable";

  // Compare measured P50 against §43.3 draft baseline — emit advisory alert ONLY (NEVER auto-mutate pricing!)
  const pricingAdvisoryAlerts: { activity_code: string; measured_p50_seconds: number; baseline_seconds: number; deviation_pct: number; note: string }[] = [];
  const enrichedRows = bucketStats.map((r) => {
    const b = baselineByAct.get(r.activity_code);
    const baselineSec = b ? Math.round(Number(b.default_assumption_minutes) * 60) : null;
    if (r.time_bucket === "active_labor" && r.p50_seconds != null && baselineSec && baselineSec > 0 && r.sample_size >= 3) {
      const devPct = Math.round(((r.p50_seconds - baselineSec) / baselineSec) * 100);
      if (Math.abs(devPct) >= 20) {
        pricingAdvisoryAlerts.push({
          activity_code: r.activity_code,
          measured_p50_seconds: r.p50_seconds,
          baseline_seconds: baselineSec,
          deviation_pct: devPct,
          note: "Advisory only — pricing books are NEVER automatically modified without independent review approval (§10/§43.3).",
        });
      }
    }
    return {
      ...r,
      estimated_baseline_seconds: baselineSec,
      baseline_data_source: b?.data_source ?? null,
    };
  });

  const denom = rateStats.total_completed_active;
  const uploadDenom = rateStats.upload_count;
  const safeRate = (num: number, d: number) => (d > 0 ? Number((num / d).toFixed(4)) : null);

  return {
    window_days: days,
    statistical_confidence: statisticalConfidence,
    total_active_labor_samples: totalActiveSamples,
    bucket_totals_seconds: {
      active_labor: bucketStats.filter((r) => r.time_bucket === "active_labor").reduce((n, r) => n + r.total_seconds, 0),
      non_parallel_wait: bucketStats.filter((r) => r.time_bucket === "non_parallel_wait").reduce((n, r) => n + r.total_seconds, 0),
      background_system: bucketStats.filter((r) => r.time_bucket === "background_system").reduce((n, r) => n + r.total_seconds, 0),
      interruption: bucketStats.filter((r) => r.time_bucket === "interruption").reduce((n, r) => n + r.total_seconds, 0),
    },
    rates: {
      remeasurement_rate: safeRate(rateStats.remeasure_count, denom),
      retake_rate: safeRate(rateStats.retake_count, denom),
      qa_return_rate: safeRate(rateStats.qa_rework_count, denom),
      exception_rate: safeRate(rateStats.exception_count, denom),
      upload_failure_rate: safeRate(rateStats.upload_fail_count, uploadDenom),
    },
    activity_breakdown: enrichedRows,
    estimated_baselines: baselines,
    pricing_advisory_alerts: pricingAdvisoryAlerts,
    auto_price_mutation_blocked: true,
  };
}

export async function getLaborCostOverview(db: DB, actor: Actor) {
  role(actor, ...COST_READ_ROLES);
  const counts = (
    await db.query(`
      select
        count(*)::int as total_models,
        count(*) filter (where status = 'published')::int as published_models,
        count(*) filter (where status = 'draft')::int as draft_models
      from cost_models
    `)
  ).rows[0];
  const eventCounts = (
    await db.query(`
      select
        count(*)::int as total_events,
        count(*) filter (where status in ('active','paused'))::int as open_events,
        count(*) filter (where status = 'pending_calibration')::int as pending_calibration_events
      from labor_time_events
    `)
  ).rows[0];
  const seedRuns = (await db.query("select * from labor_cost_seed_runs order by ran_at desc limit 5")).rows;
  return { models: counts, labor_events: eventCounts, seed_runs: seedRuns };
}

export async function listCostModels(db: DB, actor: Actor) {
  role(actor, ...COST_READ_ROLES);
  const models = (
    await db.query(
      `select m.*, v.version as published_version
       from cost_models m
       left join cost_model_versions v on v.id = m.latest_published_version_id
       order by m.updated_at desc, m.code asc`,
    )
  ).rows;
  return { models };
}

export async function getCostModelDetail(db: DB, actor: Actor, id: string) {
  role(actor, ...COST_READ_ROLES);
  const model = await one<Record<string, any>>(db, "select * from cost_models where id = $1::uuid", [id]);
  const versions = (
    await db.query("select * from cost_model_versions where model_id = $1::uuid order by version desc", [id])
  ).rows;
  return { model, versions };
}

export async function saveCostModelDraft(db: DB, actor: Actor, rawInput: unknown, sessionHash: string) {
  role(actor, ...COST_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "cost_models:write");
  const input = saveCostModelSchema.parse(rawInput);

  if (input.id) {
    const existing = (await db.query<{ id: string; status: string }>("select id, status from cost_models where id = $1::uuid for update", [input.id])).rows[0];
    guard(existing, "NOT_FOUND", "Cost model not found.", 404);
    const updated = await one<Record<string, unknown>>(
      db,
      `update cost_models set
        name_zh = $2, name_en = $3, description_zh = $4, description_en = $5, currency = $6,
        labor_hourly_rate_cents = $7, qa_hourly_rate_cents = $8,
        management_overhead_included_in_labor = $9, management_overhead_pct = $10,
        warehouse_fixed_monthly_cents = $11, expected_monthly_orders = $12,
        equipment_depreciation_per_order_cents = $13, camera_lighting_per_item_cents = $14,
        barcode_label_per_item_cents = $15, packaging_consumable_per_item_cents = $16,
        storage_gb_month_cents = $17, bandwidth_gb_cents = $18, video_transcode_per_min_cents = $19,
        ai_estimated_per_order_cents = $20, domestic_logistics_handling_per_order_cents = $21,
        payment_fixed_fee_cents = $22, payment_fee_rate_bps = $23, other_variable_revenue_rate_bps = $24,
        rework_reserve_rate_bps = $25, support_cost_per_order_cents = $26, target_contribution_margin_bps = $27,
        tax_policy_note = $28, default_defect_rate_bps = $29, default_rework_rate_bps = $30,
        default_avg_mb_per_item = $31, fx_cny_per_usd = $32, fx_source = $33, data_source = $34,
        status = 'draft', current_draft_version = current_draft_version + 1,
        latest_published_version_id = case when $36::text = 'retired' then null else latest_published_version_id end,
        admin_modified = true, created_by = $35::uuid, submitted_by = null, approved_by = null,
        published_at = null, retired_at = null, updated_at = now()
      where id = $1::uuid returning *`,
      [
        existing.id,
        input.name_zh,
        input.name_en,
        input.description_zh,
        input.description_en,
        input.currency,
        input.labor_hourly_rate_cents,
        input.qa_hourly_rate_cents,
        input.management_overhead_included_in_labor,
        input.management_overhead_pct,
        input.warehouse_fixed_monthly_cents,
        input.expected_monthly_orders,
        input.equipment_depreciation_per_order_cents,
        input.camera_lighting_per_item_cents,
        input.barcode_label_per_item_cents,
        input.packaging_consumable_per_item_cents,
        input.storage_gb_month_cents,
        input.bandwidth_gb_cents,
        input.video_transcode_per_min_cents,
        input.ai_estimated_per_order_cents,
        input.domestic_logistics_handling_per_order_cents,
        input.payment_fixed_fee_cents,
        input.payment_fee_rate_bps,
        input.other_variable_revenue_rate_bps,
        input.rework_reserve_rate_bps,
        input.support_cost_per_order_cents,
        input.target_contribution_margin_bps,
        input.tax_policy_note,
        input.default_defect_rate_bps,
        input.default_rework_rate_bps,
        input.default_avg_mb_per_item,
        input.fx_cny_per_usd,
        input.fx_source,
        input.data_source,
        actor.id,
        existing.status,
      ],
    );
    await audit(db, actor, "cost_model_save_draft", "cost_models", existing.id, { note: input.note ?? null });
    return updated;
  }

  const clash = (await db.query("select 1 from cost_models where code = $1", [input.code])).rowCount;
  guard(!clash, "DUPLICATE_COST_MODEL_CODE", `Cost model '${input.code}' already exists.`, 409);

  const inserted = await one<Record<string, unknown>>(
    db,
    `insert into cost_models (
      code, name_zh, name_en, description_zh, description_en, currency,
      labor_hourly_rate_cents, qa_hourly_rate_cents,
      management_overhead_included_in_labor, management_overhead_pct,
      warehouse_fixed_monthly_cents, expected_monthly_orders,
      equipment_depreciation_per_order_cents, camera_lighting_per_item_cents,
      barcode_label_per_item_cents, packaging_consumable_per_item_cents,
      storage_gb_month_cents, bandwidth_gb_cents, video_transcode_per_min_cents,
      ai_estimated_per_order_cents, domestic_logistics_handling_per_order_cents,
      payment_fixed_fee_cents, payment_fee_rate_bps, other_variable_revenue_rate_bps,
      rework_reserve_rate_bps, support_cost_per_order_cents, target_contribution_margin_bps,
      tax_policy_note, default_defect_rate_bps, default_rework_rate_bps,
      default_avg_mb_per_item, fx_cny_per_usd, fx_source, data_source,
      status, publication_scope, business_approved, admin_modified, created_by
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
      $28, $29, $30, $31, $32, $33, $34,
      'draft', 'sandbox_acceptance', false, true, $35::uuid
    ) returning *`,
    [
      input.code,
      input.name_zh,
      input.name_en,
      input.description_zh,
      input.description_en,
      input.currency,
      input.labor_hourly_rate_cents,
      input.qa_hourly_rate_cents,
      input.management_overhead_included_in_labor,
      input.management_overhead_pct,
      input.warehouse_fixed_monthly_cents,
      input.expected_monthly_orders,
      input.equipment_depreciation_per_order_cents,
      input.camera_lighting_per_item_cents,
      input.barcode_label_per_item_cents,
      input.packaging_consumable_per_item_cents,
      input.storage_gb_month_cents,
      input.bandwidth_gb_cents,
      input.video_transcode_per_min_cents,
      input.ai_estimated_per_order_cents,
      input.domestic_logistics_handling_per_order_cents,
      input.payment_fixed_fee_cents,
      input.payment_fee_rate_bps,
      input.other_variable_revenue_rate_bps,
      input.rework_reserve_rate_bps,
      input.support_cost_per_order_cents,
      input.target_contribution_margin_bps,
      input.tax_policy_note,
      input.default_defect_rate_bps,
      input.default_rework_rate_bps,
      input.default_avg_mb_per_item,
      input.fx_cny_per_usd,
      input.fx_source,
      input.data_source,
      actor.id,
    ],
  );
  await audit(db, actor, "cost_model_create", "cost_models", String(inserted.id), { code: input.code });
  return inserted;
}

export async function submitCostModel(db: DB, actor: Actor, id: string, note: string | undefined, sessionHash: string) {
  role(actor, ...COST_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const cur = await one<{ id: string; status: string }>(db, "select id, status from cost_models where id = $1::uuid for update", [id]);
  guard(cur.status === "draft", "INVALID_STATE", `Cost model status '${cur.status}' cannot be submitted.`, 422);
  const row = await one<Record<string, unknown>>(
    db,
    "update cost_models set status = 'in_review', submitted_by = $2::uuid, updated_at = now() where id = $1::uuid returning *",
    [id, actor.id],
  );
  await audit(db, actor, "cost_model_submit", "cost_models", id, { note: note ?? null });
  return row;
}

export async function publishCostModel(db: DB, actor: Actor, id: string, note: string | undefined, sessionHash: string) {
  role(actor, ...COST_REVIEW_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `cost_models:publish:${id}`);

  const cur = await one<Record<string, any>>(db, "select * from cost_models where id = $1::uuid for update", [id]);
  guard(cur.status === "draft" || cur.status === "in_review", "INVALID_STATE", `Cost model status '${cur.status}' cannot be published.`, 422);
  guard(
    cur.created_by !== actor.id && (!cur.submitted_by || cur.submitted_by !== actor.id),
    "SELF_REVIEW_FORBIDDEN",
    "Independent non-author reviewer required to publish cost model.",
    403,
  );

  const nextVer = (await one<{ n: number }>(db, "select coalesce(max(version),0)::int + 1 as n from cost_model_versions where model_id = $1::uuid", [id])).n;
  const contentHash = hash(JSON.stringify(cur));
  const versionRow = await one<Record<string, unknown>>(
    db,
    `insert into cost_model_versions (
      model_id, model_code, version, state, publication_scope, business_approved,
      snapshot, content_hash, author_id, submitted_by, reviewer_id, note
    ) values (
      $1::uuid, $2, $3::int, 'PUBLISHED', $4, false,
      $5::jsonb, $6, $7::uuid, $8::uuid, $9::uuid, $10::text
    ) returning *`,
    [
      id,
      String(cur.code),
      nextVer,
      String(cur.publication_scope ?? "sandbox_acceptance"),
      JSON.stringify(cur),
      contentHash,
      cur.created_by,
      cur.submitted_by ?? null,
      actor.id,
      note ?? null,
    ],
  );
  const updated = await one<Record<string, unknown>>(
    db,
    `update cost_models set
      status = 'published', approved_by = $2::uuid, latest_published_version_id = $3::uuid,
      published_at = now(), updated_at = now()
     where id = $1::uuid returning *`,
    [id, actor.id, versionRow.id],
  );
  await audit(db, actor, "cost_model_publish", "cost_model_versions", String(versionRow.id), { version: nextVer, content_hash: contentHash });
  return { model: updated, version: versionRow };
}

export async function retireCostModel(db: DB, actor: Actor, id: string, note: string | undefined, sessionHash: string) {
  role(actor, ...COST_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await one(db, "select id from cost_models where id = $1::uuid for update", [id]);
  await db.query("update cost_model_versions set state = 'RETIRED', retired_at = now() where model_id = $1::uuid and state = 'PUBLISHED'", [id]);
  const updated = await one<Record<string, unknown>>(
    db,
    "update cost_models set status = 'retired', latest_published_version_id = null, retired_at = now(), updated_at = now() where id = $1::uuid returning *",
    [id],
  );
  await audit(db, actor, "cost_model_retire", "cost_models", id, { note: note ?? null });
  return updated;
}

export async function rollbackCostModel(db: DB, actor: Actor, id: string, targetVersion: number, note: string | undefined, sessionHash: string) {
  role(actor, ...COST_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const cur = await one<{ status: string }>(db, "select status from cost_models where id = $1::uuid for update", [id]);
  const ver = await one<{ snapshot: Record<string, any> }>(
    db,
    "select snapshot from cost_model_versions where model_id = $1::uuid and version = $2::int",
    [id, targetVersion],
  );
  const s = ver.snapshot;
  const updated = await one<Record<string, unknown>>(
    db,
    `update cost_models set
      name_zh = $2, name_en = $3, description_zh = $4, description_en = $5, currency = $6,
      labor_hourly_rate_cents = $7, qa_hourly_rate_cents = $8,
      management_overhead_included_in_labor = $9, management_overhead_pct = $10,
      warehouse_fixed_monthly_cents = $11, expected_monthly_orders = $12,
      equipment_depreciation_per_order_cents = $13, camera_lighting_per_item_cents = $14,
      barcode_label_per_item_cents = $15, packaging_consumable_per_item_cents = $16,
      storage_gb_month_cents = $17, bandwidth_gb_cents = $18, video_transcode_per_min_cents = $19,
      ai_estimated_per_order_cents = $20, domestic_logistics_handling_per_order_cents = $21,
      payment_fixed_fee_cents = $22, payment_fee_rate_bps = $23, other_variable_revenue_rate_bps = $24,
      rework_reserve_rate_bps = $25, support_cost_per_order_cents = $26, target_contribution_margin_bps = $27,
      tax_policy_note = $28, default_defect_rate_bps = $29, default_rework_rate_bps = $30,
      default_avg_mb_per_item = $31, fx_cny_per_usd = $32, fx_source = $33, data_source = $34,
      status = 'draft', current_draft_version = current_draft_version + 1,
      latest_published_version_id = case when $36::text = 'retired' then null else latest_published_version_id end,
      admin_modified = true, created_by = $35::uuid, submitted_by = null, approved_by = null,
      published_at = null, retired_at = null, updated_at = now()
    where id = $1::uuid returning *`,
    [
      id,
      s.name_zh,
      s.name_en,
      s.description_zh ?? "",
      s.description_en ?? "",
      s.currency ?? "USD",
      Number(s.labor_hourly_rate_cents),
      Number(s.qa_hourly_rate_cents),
      Boolean(s.management_overhead_included_in_labor),
      Number(s.management_overhead_pct ?? 0),
      Number(s.warehouse_fixed_monthly_cents ?? 0),
      Number(s.expected_monthly_orders ?? 200),
      Number(s.equipment_depreciation_per_order_cents ?? 0),
      Number(s.camera_lighting_per_item_cents ?? 0),
      Number(s.barcode_label_per_item_cents ?? 0),
      Number(s.packaging_consumable_per_item_cents ?? 0),
      Number(s.storage_gb_month_cents ?? 0),
      Number(s.bandwidth_gb_cents ?? 0),
      Number(s.video_transcode_per_min_cents ?? 0),
      Number(s.ai_estimated_per_order_cents ?? 0),
      Number(s.domestic_logistics_handling_per_order_cents ?? 0),
      Number(s.payment_fixed_fee_cents ?? 30),
      Number(s.payment_fee_rate_bps ?? 340),
      Number(s.other_variable_revenue_rate_bps ?? 0),
      Number(s.rework_reserve_rate_bps ?? 300),
      Number(s.support_cost_per_order_cents ?? 150),
      Number(s.target_contribution_margin_bps ?? 2500),
      String(s.tax_policy_note ?? "Net of pass-through shipping & payment processing fees"),
      Number(s.default_defect_rate_bps ?? 800),
      Number(s.default_rework_rate_bps ?? 400),
      Number(s.default_avg_mb_per_item ?? 12),
      Number(s.fx_cny_per_usd ?? 7.2),
      String(s.fx_source ?? "manual_sandbox_baseline"),
      String(s.data_source ?? "estimated_baseline"),
      actor.id,
      cur.status,
    ],
  );
  await audit(db, actor, "cost_model_rollback", "cost_models", id, { target_version: targetVersion, note: note ?? null });
  return updated;
}

export async function listLaborBaselines(db: DB, actor: Actor) {
  role(actor, ...COST_READ_ROLES);
  const rows = (await db.query("select * from labor_baseline_assumptions order by activity_code, complexity_code")).rows;
  return { baselines: rows };
}

export async function updateLaborBaselineAssumption(
  db: DB,
  actor: Actor,
  rawInput: unknown,
  sessionHash: string,
) {
  role(actor, ...COST_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = z
    .object({
      activity_code: z.enum(LABOR_ACTIVITY_CODES),
      complexity_code: z.enum(["ALL", "L1", "L2", "L3", "L4", "L5"]).default("ALL"),
      default_assumption_minutes: z.number().min(0).max(1440),
      data_source: z.enum(["estimated_baseline", "field_calibrated"]).default("estimated_baseline"),
      sample_size: z.number().int().min(0).default(0),
      notes_zh: z.string().trim().max(400).optional(),
    })
    .parse(rawInput);

  const updated = await one<Record<string, unknown>>(
    db,
    `update labor_baseline_assumptions set
      default_assumption_minutes = $3,
      data_source = $4,
      sample_size = $5,
      notes_zh = coalesce($6, notes_zh),
      updated_by = $7::uuid,
      updated_at = now()
     where activity_code = $1 and complexity_code = $2
     returning *`,
    [
      input.activity_code,
      input.complexity_code,
      input.default_assumption_minutes,
      input.data_source,
      input.sample_size,
      input.notes_zh ?? null,
      actor.id,
    ],
  );
  await audit(db, actor, "labor_baseline_updated", "labor_baseline_assumptions", String(updated.id), input);
  return updated;
}

function computeUnitEconomicsCore(params: {
  model: Record<string, any>;
  baselines: Map<string, number>;
  quotedRevenueCents: number;
  baseQty: number;
  complexityCode: string;
  selectedModules: { module_code: string; quantity: number }[];
  defectRateBps: number;
  reworkRateBps: number;
  videoMinutes: number;
  targetMarginBps: number;
}) {
  const { model, baselines, quotedRevenueCents, baseQty, complexityCode, selectedModules, defectRateBps, reworkRateBps, videoMinutes, targetMarginBps } = params;

  const minFor = (act: string, fallbackMin: number) => {
    const complexKey = `${act}:${complexityCode}`;
    if (baselines.has(complexKey)) return baselines.get(complexKey)!;
    if (baselines.has(`${act}:ALL`)) return baselines.get(`${act}:ALL`)!;
    return fallbackMin;
  };

  // Fixed prep/report + per-item base labor + module labor
  const fixedPrepMin = minFor("order_prep", 8) + minFor("report_compile", 10);
  const visualMinPerPc = complexityCode === "L3" || complexityCode === "L4" ? minFor("visual_inspect", 12) : minFor("visual_inspect", 4.5);
  const baseHandlingMin = minFor("sku_label", 2) + minFor("garment_prep", 2) + minFor("repack_putaway", 2.5);
  let moduleMinTotal = 0;
  for (const mod of selectedModules) {
    if (mod.module_code === "M01") continue;
    const perUnit =
      mod.module_code === "M02"
        ? minFor("measurement_point", 13)
        : mod.module_code === "M09"
          ? minFor("photo_capture", 5)
          : mod.module_code === "M10"
            ? minFor("video_capture", 5.5)
            : minFor("module_inspect", 6);
    moduleMinTotal += perUnit * mod.quantity;
  }

  const reworkFactor = reworkRateBps / 10_000;
  const defectFactor = defectRateBps / 10_000;
  const directMinutesBase = fixedPrepMin + (baseHandlingMin + visualMinPerPc) * baseQty + moduleMinTotal;
  const extraDefectMinutes = baseQty * defectFactor * minFor("exception_log", 2.5);
  const effectiveDirectMinutes = directMinutesBase * (1 + reworkFactor) + extraDefectMinutes;
  const qaMinutes = minFor("qa_review", 4) * baseQty * (1 + reworkFactor * 0.5);

  const directLaborCents = Math.round((effectiveDirectMinutes / 60) * Number(model.labor_hourly_rate_cents));
  const qaLaborCents = Math.round((qaMinutes / 60) * Number(model.qa_hourly_rate_cents));
  const mgmtOverheadCents = model.management_overhead_included_in_labor
    ? 0
    : Math.round(((directLaborCents + qaLaborCents) * Number(model.management_overhead_pct ?? 0)) / 100);

  const itemConsumablesCents =
    (Number(model.camera_lighting_per_item_cents ?? 0) +
      Number(model.barcode_label_per_item_cents ?? 0) +
      Number(model.packaging_consumable_per_item_cents ?? 0)) *
    baseQty;

  const avgMbPerItem = Number(model.default_avg_mb_per_item ?? 12);
  const totalGb = (baseQty * avgMbPerItem) / 1024;
  const mediaInfraCents = Math.round(
    totalGb * (Number(model.storage_gb_month_cents ?? 0) + Number(model.bandwidth_gb_cents ?? 0)) +
      videoMinutes * Number(model.video_transcode_per_min_cents ?? 0),
  );

  const equipmentDepCents = Number(model.equipment_depreciation_per_order_cents ?? 0);
  const aiCents = Number(model.ai_estimated_per_order_cents ?? 0);
  const domesticLogisticsCents = Number(model.domestic_logistics_handling_per_order_cents ?? 0);
  const supportCents = Number(model.support_cost_per_order_cents ?? 0);
  const reworkReserveCents = Math.round(((directLaborCents + qaLaborCents) * Number(model.rework_reserve_rate_bps ?? 0)) / 10_000);
  const fixedAllocationCents = Math.round(Number(model.warehouse_fixed_monthly_cents ?? 0) / Math.max(1, Number(model.expected_monthly_orders ?? 200)));

  // Non-proportional cost C per §43.3 L2122
  const nonProportionalVariableCents =
    directLaborCents +
    qaLaborCents +
    mgmtOverheadCents +
    itemConsumablesCents +
    mediaInfraCents +
    aiCents +
    domesticLogisticsCents +
    supportCents +
    reworkReserveCents +
    Number(model.payment_fixed_fee_cents ?? 30);

  const nonProportionalTotalCents = nonProportionalVariableCents + equipmentDepCents + fixedAllocationCents;

  // Proportional fee rate f and target margin m per §43.3 L2122: P = C / (1 - f - m)
  const feeRate = (Number(model.payment_fee_rate_bps ?? 0) + Number(model.other_variable_revenue_rate_bps ?? 0)) / 10_000;
  const marginRate = targetMarginBps / 10_000;
  const denominator = 1 - feeRate - marginRate;
  const feasible = denominator > 0;
  const recommendedNetPriceCents = feasible ? Math.ceil(nonProportionalTotalCents / denominator) : null;

  const paymentFeeOnQuotedCents =
    quotedRevenueCents > 0
      ? Number(model.payment_fixed_fee_cents ?? 0) + Math.round(quotedRevenueCents * feeRate)
      : 0;
  const totalDirectVariableCostCents = nonProportionalVariableCents - Number(model.payment_fixed_fee_cents ?? 0) + paymentFeeOnQuotedCents;
  const contributionProfitCents = quotedRevenueCents - totalDirectVariableCostCents;
  const operatingProfitCents = contributionProfitCents - equipmentDepCents - fixedAllocationCents;

  return {
    estimated_direct_minutes: Number(effectiveDirectMinutes.toFixed(1)),
    estimated_qa_minutes: Number(qaMinutes.toFixed(1)),
    cost_breakdown_cents: {
      direct_labor_cents: directLaborCents,
      qa_labor_cents: qaLaborCents,
      management_overhead_cents: mgmtOverheadCents,
      consumables_and_camera_cents: itemConsumablesCents,
      media_storage_bandwidth_transcode_cents: mediaInfraCents,
      ai_service_cents: aiCents,
      domestic_logistics_handling_cents: domesticLogisticsCents,
      support_cents: supportCents,
      rework_reserve_cents: reworkReserveCents,
      payment_fee_on_quoted_cents: paymentFeeOnQuotedCents,
      equipment_depreciation_cents: equipmentDepCents,
      warehouse_fixed_allocation_cents: fixedAllocationCents,
    },
    non_proportional_cost_c_cents: nonProportionalTotalCents,
    proportional_fee_rate: Number(feeRate.toFixed(4)),
    target_margin_rate: Number(marginRate.toFixed(4)),
    feasible,
    infeasibility_reason: feasible ? null : `1 - f (${feeRate.toFixed(4)}) - m (${marginRate.toFixed(4)}) <= 0: infeasible target margin under fee structure.`,
    recommended_net_price_cents: recommendedNetPriceCents,
    tax_policy_note: String(model.tax_policy_note ?? ""),
    quoted_revenue_cents: quotedRevenueCents,
    direct_variable_cost_cents: totalDirectVariableCostCents,
    contribution_profit_cents: contributionProfitCents,
    operating_profit_cents: operatingProfitCents,
    actual_contribution_margin_pct: quotedRevenueCents > 0 ? Number(((contributionProfitCents / quotedRevenueCents) * 100).toFixed(2)) : null,
    is_loss_making: operatingProfitCents < 0,
  };
}

export async function simulateUnitEconomicsAndMargin(db: DB, actor: Actor, rawInput: unknown) {
  role(actor, ...COST_READ_ROLES);
  const input = marginSimulateSchema.parse(rawInput);

  const model = input.cost_model_id
    ? await one<Record<string, any>>(db, "select * from cost_models where id = $1::uuid", [input.cost_model_id])
    : (
        await db.query<Record<string, any>>(
          `select m.* from cost_models m
           order by (case when m.status = 'published' then 0 else 1 end), m.updated_at desc limit 1`,
        )
      ).rows[0];
  guard(model, "COST_MODEL_UNAVAILABLE", "No cost model configured; initialize §43.3 defaults first.", 422);

  // Load product type + pricing book for quoted revenue (unless override passed)
  const ptRow = (
    await db.query<CatalogPricingContext & { category_status: string; product_type_status: string }>(
      `select pt.code as product_type_code, pt.category_slug, c.status as category_status,
              pt.status as product_type_status, pt.public_sellable, pt.capability_status, pt.quote_mode,
              pt.default_complexity_code, pt.billing_unit, pt.included_components,
              pt.applicable_module_codes, pt.name_zh, pt.name_en
       from catalog_product_types pt join categories c on c.slug = pt.category_slug
       where pt.code = $1`,
      [input.product_type_code],
    )
  ).rows[0];
  guard(ptRow, "NOT_FOUND", `Product type '${input.product_type_code}' not found.`, 404);

  let quotedRevenueCents = input.override_quoted_revenue_cents ?? 0;
  let compiledModules: { module_code: string; quantity: number }[] = [];
  let pricingSource = "override_quoted_revenue";

  if (input.override_quoted_revenue_cents === undefined) {
    const bookRow = input.pricing_book_id
      ? await one<Record<string, any>>(db, "select * from pricing_books where id = $1::uuid", [input.pricing_book_id])
      : (
          await db.query<Record<string, any>>(
            `select coalesce(v.effective_snapshot, to_jsonb(b)) as snap
             from pricing_books b
             left join pricing_book_versions v on v.book_id = b.id and v.state = 'PUBLISHED' and v.effective_from <= now()
             where b.status <> 'retired'
             order by (case when v.id is not null then 0 else 1 end), v.effective_from desc nulls last, b.updated_at desc limit 1`,
          )
        ).rows[0]?.snap;
    guard(bookRow, "PRICING_UNAVAILABLE", "No pricing book available for margin simulation.", 422);
    const quote = calculateUnifiedQuote(
      bookRow,
      ptRow,
      {
        service_type: input.service_type,
        product_type_code: input.product_type_code,
        base_qty: input.base_qty,
        modules: input.modules,
        golden_sample_ids: input.golden_sample_ids,
        archive_new_golden_samples: input.archive_new_golden_samples,
        customer_authorized_destructive: input.customer_authorized_destructive,
        promo_codes: [],
        apply_volume_discount: false,
        quote_kind: "simulation",
        allow_unpublished_catalog_in_sim: input.allow_unpublished_catalog_in_sim,
      },
      { callerIsStaff: true },
    );
    quotedRevenueCents = quote.total_cents;
    compiledModules = quote.compiled_task_plan.module_coverages.map((m) => ({
      module_code: m.module_code,
      quantity: m.task_count,
    }));
    pricingSource = String(bookRow.code ?? "pricing_book");
  }

  const baselineRows = (await db.query<Record<string, any>>("select * from labor_baseline_assumptions")).rows;
  const baselineMap = new Map<string, number>();
  let anyFieldCalibrated = false;
  for (const b of baselineRows) {
    baselineMap.set(`${b.activity_code}:${b.complexity_code}`, Number(b.default_assumption_minutes));
    if (b.data_source === "field_calibrated" && Number(b.sample_size) >= 10) anyFieldCalibrated = true;
  }

  const defectBps = input.defect_rate_bps ?? Number(model.default_defect_rate_bps ?? 800);
  const reworkBps = input.rework_rate_bps ?? Number(model.default_rework_rate_bps ?? 400);
  const marginBps = input.override_target_margin_bps ?? Number(model.target_contribution_margin_bps ?? 2500);

  const primary = computeUnitEconomicsCore({
    model,
    baselines: baselineMap,
    quotedRevenueCents,
    baseQty: input.base_qty,
    complexityCode: ptRow.default_complexity_code,
    selectedModules: compiledModules,
    defectRateBps: defectBps,
    reworkRateBps: reworkBps,
    videoMinutes: input.video_minutes,
    targetMarginBps: marginBps,
  });

  // Sensitivity matrix across defect & rework rates
  const scenarios = [
    { label: "Optimistic (3% defect / 1% rework)", defect_bps: 300, rework_bps: 100 },
    { label: "Baseline Config", defect_bps: defectBps, rework_bps: reworkBps },
    { label: "Elevated Defects (15% defect / 8% rework)", defect_bps: 1500, rework_bps: 800 },
    { label: "High Rework Stress (25% defect / 15% rework)", defect_bps: 2500, rework_bps: 1500 },
  ].map((sc) => {
    const out = computeUnitEconomicsCore({
      model,
      baselines: baselineMap,
      quotedRevenueCents,
      baseQty: input.base_qty,
      complexityCode: ptRow.default_complexity_code,
      selectedModules: compiledModules,
      defectRateBps: sc.defect_bps,
      reworkRateBps: sc.rework_bps,
      videoMinutes: input.video_minutes,
      targetMarginBps: marginBps,
    });
    return {
      scenario: sc.label,
      defect_rate_pct: sc.defect_bps / 100,
      rework_rate_pct: sc.rework_bps / 100,
      direct_variable_cost_cents: out.direct_variable_cost_cents,
      contribution_profit_cents: out.contribution_profit_cents,
      operating_profit_cents: out.operating_profit_cents,
      recommended_net_price_cents: out.recommended_net_price_cents,
      is_loss_making: out.is_loss_making,
    };
  });

  return {
    data_source_provenance: anyFieldCalibrated ? "mixed_calibrated" : String(model.data_source ?? "estimated_baseline"),
    business_approved: Boolean(model.business_approved),
    model_id: model.id,
    model_code: model.code,
    pricing_source: pricingSource,
    complexity_code: ptRow.default_complexity_code,
    base_qty: input.base_qty,
    ...primary,
    sensitivity_scenarios: scenarios,
  };
}

export async function generateStandardCostMatrix(
  db: DB,
  actor: Actor,
  opts: { cost_model_id?: string; pricing_book_id?: string } = {},
) {
  role(actor, ...COST_READ_ROLES);
  const model = opts.cost_model_id
    ? await one<Record<string, any>>(db, "select * from cost_models where id = $1::uuid", [opts.cost_model_id])
    : (await db.query<Record<string, any>>("select * from cost_models order by (case when status='published' then 0 else 1 end), updated_at desc limit 1")).rows[0];
  guard(model, "COST_MODEL_UNAVAILABLE", "No cost model configured; initialize defaults first.", 422);

  const bookRow = opts.pricing_book_id
    ? (
        await db.query<{ snap: Record<string, any> }>(
          `select coalesce(v.effective_snapshot, to_jsonb(b)) as snap
           from pricing_books b
           left join pricing_book_versions v on v.book_id = b.id and v.state = 'PUBLISHED' and v.effective_from <= now()
           where b.id = $1::uuid
           order by v.effective_from desc nulls last, v.version desc nulls last limit 1`,
          [opts.pricing_book_id],
        )
      ).rows[0]?.snap
    : (
        await db.query<{ snap: Record<string, any> }>(
          `select coalesce(v.effective_snapshot, to_jsonb(b)) as snap
           from pricing_books b
           left join pricing_book_versions v on v.book_id = b.id and v.state = 'PUBLISHED' and v.effective_from <= now()
           where b.status <> 'retired'
           order by (case when v.id is not null then 0 else 1 end), v.effective_from desc nulls last, b.updated_at desc limit 1`,
        )
      ).rows[0]?.snap;
  guard(bookRow, "PRICING_UNAVAILABLE", "No pricing book available for cost matrix generation (initialize §43.2 pricing first).", 422);

  const baselineRows = (await db.query<Record<string, any>>("select * from labor_baseline_assumptions")).rows;
  const baselineMap = new Map<string, number>();
  for (const b of baselineRows) baselineMap.set(`${b.activity_code}:${b.complexity_code}`, Number(b.default_assumption_minutes));

  const quantities = [1, 3, 10, 30, 50, 100];
  const complexities = ["L1", "L2", "L3", "L4"] as const;
  const bundles = [
    { key: "base", label: "M01 Base", modules: [] as string[] },
    { key: "pom_5pt", label: "M01 + M02(5pt)", modules: ["M02"] },
    { key: "full", label: "M01 + M02 + M03 + M04", modules: ["M02", "M03", "M04"] },
  ];

  const matrix: Record<string, unknown>[] = [];
  for (const qty of quantities) {
    for (const comp of complexities) {
      const compUnitCentsRaw = bookRow.complexity_rates?.[comp]?.unit_cents;
      guard(typeof compUnitCentsRaw === "number", "PRICING_INCOMPLETE", `Pricing book missing numeric rate for '${comp}'.`, 422);
      const compUnitCents = Number(compUnitCentsRaw);
      for (const bnd of bundles) {
        let revCents = compUnitCents * qty;
        for (const mc of bnd.modules) {
          const def = bookRow.module_rates?.[mc];
          const optUnitRaw = def?.options?.[def?.default_option]?.unit_cents;
          guard(typeof optUnitRaw === "number", "PRICING_INCOMPLETE", `Pricing book missing numeric default option rate for '${mc}'.`, 422);
          revCents += Number(optUnitRaw) * qty;
        }
        const res = computeUnitEconomicsCore({
          model,
          baselines: baselineMap,
          quotedRevenueCents: revCents,
          baseQty: qty,
          complexityCode: comp,
          selectedModules: bnd.modules.map((mc) => ({ module_code: mc, quantity: qty })),
          defectRateBps: Number(model.default_defect_rate_bps ?? 800),
          reworkRateBps: Number(model.default_rework_rate_bps ?? 400),
          videoMinutes: 0,
          targetMarginBps: Number(model.target_contribution_margin_bps ?? 2500),
        });
        matrix.push({
          qty,
          complexity: comp,
          bundle: bnd.key,
          bundle_label: bnd.label,
          data_source: model.data_source,
          quoted_revenue_cents: res.quoted_revenue_cents,
          estimated_direct_minutes: res.estimated_direct_minutes,
          estimated_qa_minutes: res.estimated_qa_minutes,
          direct_variable_cost_cents: res.direct_variable_cost_cents,
          non_proportional_cost_c_cents: res.non_proportional_cost_c_cents,
          contribution_profit_cents: res.contribution_profit_cents,
          operating_profit_cents: res.operating_profit_cents,
          recommended_net_price_cents: res.recommended_net_price_cents,
          is_loss_making: res.is_loss_making,
        });
      }
    }
  }
  return { model_code: model.code, currency: model.currency, data_source: model.data_source, rows: matrix };
}

export async function recordOrderCostEntry(db: DB, actor: Actor, orderId: string, rawInput: unknown, sessionHash: string) {
  role(actor, ...COST_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await one(db, "select id from orders where id = $1::uuid", [orderId]);
  const input = orderCostEntrySchema.parse(rawInput);
  const row = await one<Record<string, unknown>>(
    db,
    `insert into order_cost_ledger_entries (
      order_id, cost_category, cost_nature, provenance, amount_cents,
      original_amount_minor, original_currency, fx_rate, fx_source, source_ref, notes, recorded_by
    ) values (
      $1::uuid, $2, $3, $4, $5::int,
      $6::int, $7, $8, $9, $10, $11, $12::uuid
    ) returning *`,
    [
      orderId,
      input.cost_category,
      input.cost_nature,
      input.provenance,
      input.amount_cents,
      input.original_amount_minor ?? null,
      input.original_currency ?? "USD",
      input.fx_rate ?? null,
      input.fx_source ?? null,
      input.source_ref ?? null,
      input.notes ?? null,
      actor.id,
    ],
  );
  await audit(db, actor, "order_cost_entry_recorded", "order_cost_ledger_entries", String(row.id), {
    order_id: orderId,
    cost_category: input.cost_category,
    provenance: input.provenance,
    amount_cents: input.amount_cents,
  });
  return row;
}

export async function getOrderCostProfitBreakdown(db: DB, actor: Actor, orderId: string) {
  role(actor, ...COST_READ_ROLES);
  const ord = await one<{ id: string; public_no: string; state: string; is_test: boolean }>(
    db,
    "select id, public_no, state, coalesce(is_test, false) as is_test from orders where id = $1::uuid",
    [orderId],
  );

  const revenueRow = (
    await db.query<{ paid_cents: number; refunded_cents: number }>(
      `select
         coalesce(sum(c.amount_cents) filter (where p.state in ('succeeded','partially_refunded','refunded')), 0)::int as paid_cents,
         coalesce((
           select sum(r.amount_cents)::int
           from inspection_quotes iq2
           join charge_items c2 on c2.inspection_quote_id = iq2.id and c2.voided_at is null and c2.purpose = 'inspection'
           join payments p2 on p2.id = c2.applied_payment_id
           join refunds r on r.payment_id = p2.id and r.state = 'succeeded'
           where iq2.order_id = $1::uuid
         ), 0)::int as refunded_cents
       from inspection_quotes iq
       join charge_items c on c.inspection_quote_id = iq.id and c.voided_at is null and c.purpose = 'inspection'
       left join payments p on p.id = c.applied_payment_id
       where iq.order_id = $1::uuid`,
      [orderId],
    )
  ).rows[0]!;

  const laborRow = (
    await db.query<{ active_seconds: number; qa_seconds: number; wait_seconds: number; bg_seconds: number }>(
      `select
         coalesce(sum(effective_seconds) filter (where time_bucket = 'active_labor' and activity_code <> 'qa_review' and status in ('completed','corrected')), 0)::int as active_seconds,
         coalesce(sum(effective_seconds) filter (where time_bucket = 'active_labor' and activity_code = 'qa_review' and status in ('completed','corrected')), 0)::int as qa_seconds,
         coalesce(sum(effective_seconds) filter (where time_bucket = 'non_parallel_wait' and status in ('completed','corrected')), 0)::int as wait_seconds,
         coalesce(sum(effective_seconds) filter (where time_bucket = 'background_system' and status in ('completed','corrected')), 0)::int as bg_seconds
       from labor_time_events
       where order_id = $1::uuid`,
      [orderId],
    )
  ).rows[0]!;

  const ledgerEntries = (
    await db.query<Record<string, any>>(
      "select * from order_cost_ledger_entries where order_id = $1::uuid order by created_at asc",
      [orderId],
    )
  ).rows;

  const model = (
    await db.query<Record<string, any>>("select * from cost_models order by (case when status='published' then 0 else 1 end), updated_at desc limit 1")
  ).rows[0];

  const grossRevenueCents = revenueRow.paid_cents;
  const refundedCents = revenueRow.refunded_cents;
  const netRevenueCents = grossRevenueCents - refundedCents;

  const directLedgerCents = ledgerEntries.filter((e) => e.cost_nature === "direct_variable").reduce((n, e) => n + Number(e.amount_cents), 0);
  const fixedLedgerCents = ledgerEntries.filter((e) => e.cost_nature === "fixed_allocated").reduce((n, e) => n + Number(e.amount_cents), 0);

  const hasExplicitDirectLabor = ledgerEntries.some((e) => e.cost_category === "labor_direct");
  const hasExplicitQaLabor = ledgerEntries.some((e) => e.cost_category === "labor_qa");
  const laborRate = Number(model?.labor_hourly_rate_cents ?? 1500);
  const qaRate = Number(model?.qa_hourly_rate_cents ?? 2000);
  const derivedDirectLaborCents = hasExplicitDirectLabor ? 0 : Math.round((laborRow.active_seconds / 3600) * laborRate);
  const derivedQaLaborCents = hasExplicitQaLabor ? 0 : Math.round((laborRow.qa_seconds / 3600) * qaRate);

  const missingActualData: string[] = [];
  if (laborRow.active_seconds === 0 && !hasExplicitDirectLabor) missingActualData.push("labor_direct_pending_capture");
  if (!ledgerEntries.some((e) => e.cost_category === "payment_fee")) missingActualData.push("payment_settlement_fee_pending");
  if (!ledgerEntries.some((e) => e.cost_category === "consumables" || e.cost_category === "packaging")) missingActualData.push("consumables_pending_entry");

  const directVariableCostCents = directLedgerCents + derivedDirectLaborCents + derivedQaLaborCents;
  const contributionProfitCents = netRevenueCents - directVariableCostCents;
  const operatingProfitCents = contributionProfitCents - fixedLedgerCents;

  return {
    order: ord,
    gross_revenue_cents: grossRevenueCents,
    refunded_cents: refundedCents,
    net_revenue_cents: netRevenueCents,
    labor_timings_seconds: laborRow,
    derived_labor_cost_cents: derivedDirectLaborCents + derivedQaLaborCents,
    ledger_entries: ledgerEntries,
    direct_variable_cost_cents: directVariableCostCents,
    contribution_profit_cents: contributionProfitCents,
    fixed_allocated_cost_cents: fixedLedgerCents,
    operating_profit_cents: operatingProfitCents,
    missing_actual_data: missingActualData,
    cost_model_code: model?.code ?? null,
    cost_model_data_source: model?.data_source ?? null,
  };
}
