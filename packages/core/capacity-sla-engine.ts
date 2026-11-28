import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, event, guard, hash, lock, one, role, uuid, type Actor } from "./common";
import {
  DEFAULT_COMPLEXITY_PROFILES,
  DEFAULT_MODULE_WORKLOAD_PROFILES,
  DEFAULT_SERVICE_MODE_RULES,
  DEFAULT_STAGE_WEIGHTS,
} from "./capacity-sla-seed";

export const CAPACITY_READ_ROLES = [
  "super_admin",
  "warehouse_admin",
  "finance",
  "reviewer",
  "inspector",
  "receiver",
  "support",
] as const;
export const CAPACITY_EDIT_ROLES = ["super_admin", "warehouse_admin", "finance"] as const;
export const CAPACITY_REVIEW_ROLES = ["super_admin", "reviewer"] as const;

export const COMPLEXITY_CODES = ["L1", "L2", "L3", "L4", "L5"] as const;
export const SERVICE_MODES = ["batch_standard", "compare_horizontal", "golden_sample"] as const;

const complexityProfileItemSchema = z.object({
  label_zh: z.string().trim().min(1).max(160).optional(),
  label_en: z.string().trim().min(1).max(160).optional(),
  visual_min_per_unit: z.number().min(0.5).max(300),
  prep_min_per_unit: z.number().min(0).max(60),
  repack_min_per_unit: z.number().min(0).max(60),
  qa_min_per_unit: z.number().min(0.2).max(120),
  rework_factor: z.number().min(0).max(0.8),
  required_skill_level: z.number().int().min(1).max(5).default(1),
  requires_calibrated_scale: z.boolean().default(false),
});

const moduleWorkloadProfileItemSchema = z.object({
  extra_min_per_unit: z.number().min(0).max(120),
  order_setup_minutes: z.number().min(0).max(120),
  bottleneck_resource: z.enum(["inspector", "photo_rig", "measurement_bench", "qa"]).default("inspector"),
  independent_batch_eligible: z.boolean().default(true),
  name_zh: z.string().trim().max(160).optional(),
  name_en: z.string().trim().max(160).optional(),
});

const serviceModeRuleItemSchema = z.object({
  independent_batch_allowed: z.boolean(),
  dependency_lock: z.boolean(),
  group_setup_minutes: z.number().min(0).max(240),
  qa_multiplier: z.number().min(0.5).max(5),
  golden_call_minutes: z.number().min(0).max(120).default(0),
});

export const capacityPolicyDraftSchema = z
  .object({
    id: z.string().uuid().optional(),
    policy_code: z.string().trim().min(3).max(80).regex(/^[A-Z0-9_-]+$/i, "Use letters, numbers, underscores or hyphens"),
    name_zh: z.string().trim().min(2).max(180),
    name_en: z.string().trim().min(2).max(180),
    description_zh: z.string().trim().max(1000).default(""),
    description_en: z.string().trim().max(1000).default(""),
    warehouse_id: z.string().uuid().nullable().optional(),
    model_provenance: z.enum(["estimated_baseline", "field_calibrated", "hybrid"]).default("estimated_baseline"),
    effective_inspector_utilization: z.coerce.number().min(0.2).max(1).default(0.78),
    effective_qa_utilization: z.coerce.number().min(0.2).max(1).default(0.8),
    default_daily_inspector_minutes: z.coerce.number().int().min(60).max(100000).default(1440),
    default_daily_qa_minutes: z.coerce.number().int().min(30).max(100000).default(480),
    default_workstation_slots: z.coerce.number().int().min(1).max(200).default(4),
    default_photo_rig_slots: z.coerce.number().int().min(1).max(200).default(2),
    daily_break_minutes_per_shift: z.coerce.number().int().min(0).max(240).default(45),
    daily_prep_minutes_per_shift: z.coerce.number().int().min(0).max(180).default(20),
    task_switch_overhead_minutes: z.coerce.number().min(0).max(60).default(4.5),
    qa_bottleneck_ratio: z.coerce.number().min(1).max(5).default(1.25),
    upload_queue_buffer_minutes: z.coerce.number().min(0).max(480).default(15),
    base_rework_rate: z.coerce.number().min(0).max(0.8).default(0.08),
    safety_buffer_pct: z.coerce.number().min(0).max(1).default(0.15),
    safety_buffer_min_minutes: z.coerce.number().int().min(0).max(2880).default(60),
    warn_utilization_pct: z.coerce.number().min(0.3).max(0.95).default(0.7),
    review_utilization_pct: z.coerce.number().min(0.4).max(0.98).default(0.85),
    pause_heavy_intake_pct: z.coerce.number().min(0.5).max(1.5).default(0.95),
    manual_quote_workload_minutes: z.coerce.number().int().min(60).max(200000).default(720),
    manual_quote_min_items: z.coerce.number().int().min(1).max(10000).default(30),
    complexity_profiles: z.record(z.string(), complexityProfileItemSchema).default(DEFAULT_COMPLEXITY_PROFILES as unknown as Record<string, z.infer<typeof complexityProfileItemSchema>>),
    module_workload_profiles: z.record(z.string(), moduleWorkloadProfileItemSchema).default(DEFAULT_MODULE_WORKLOAD_PROFILES as unknown as Record<string, z.infer<typeof moduleWorkloadProfileItemSchema>>),
    service_mode_rules: z.record(z.string(), serviceModeRuleItemSchema).default(DEFAULT_SERVICE_MODE_RULES as unknown as Record<string, z.infer<typeof serviceModeRuleItemSchema>>),
    stage_weights: z.record(z.string(), z.number().min(0.1).max(5)).default({ ...DEFAULT_STAGE_WEIGHTS }),
  })
  .superRefine((v, ctx) => {
    if (v.review_utilization_pct <= v.warn_utilization_pct) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "review_utilization_pct must exceed warn_utilization_pct" });
    }
    if (v.pause_heavy_intake_pct < v.review_utilization_pct) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pause_heavy_intake_pct must be >= review_utilization_pct" });
    }
  });

export const capacitySimulationSchema = z.object({
  policy_id: z.string().uuid().optional(),
  warehouse_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  product_type_code: z.string().trim().min(1).max(80).default("apparel_general"),
  complexity_code: z.enum(COMPLEXITY_CODES).default("L1"),
  quantity: z.coerce.number().int().min(1).max(50000).default(1),
  parcel_count: z.coerce.number().int().min(1).max(500).default(1),
  service_mode: z.enum(SERVICE_MODES).default("batch_standard"),
  module_codes: z.array(z.string().trim().min(2).max(20)).max(20).default(["M01"]),
  measurement_coverage_qty: z.coerce.number().int().min(0).max(50000).default(0),
  measurement_points_per_unit: z.coerce.number().int().min(0).max(80).default(5),
  photo_shots_per_unit: z.coerce.number().int().min(0).max(60).default(3),
  video_seconds_per_unit: z.coerce.number().int().min(0).max(600).default(0),
  compare_group_size: z.coerce.number().int().min(0).max(50).default(0),
  golden_sample_calls: z.coerce.number().int().min(0).max(50).default(0),
  ready_units_count: z.coerce.number().int().min(0).max(50000).optional(),
  estimated_rework_rate_override: z.coerce.number().min(0).max(0.8).optional(),
  requires_custom_coordination: z.boolean().default(false),
  start_at: z.iso.datetime({ offset: true }).optional(),
  persist_commitment: z.boolean().default(false),
  batch_key: z.string().trim().min(1).max(80).default("ORDER"),
});

export const startOrderSlaSchema = z.object({
  batch_key: z.string().trim().min(1).max(80).default("ORDER"),
  commitment_kind: z.enum(["order_total", "independent_batch", "compare_group", "golden_group"]).default("order_total"),
  partial_batch_allowed: z.boolean().default(false),
  dependency_group_ready: z.boolean().default(true),
  simulation: capacitySimulationSchema.optional(),
  reason: z.string().trim().min(3).max(500).default("Order passed payment, arrival & block checks; SLA started"),
});

export const slaPauseSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  notify_customer: z.boolean().default(true),
});

export const slaResumeSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  notify_customer: z.boolean().default(true),
});

export const slaExtendSchema = z.object({
  new_due_at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(5).max(500),
  notify_customer: z.boolean().default(true),
  override_type: z.enum(["extended", "manual_override"]).default("extended"),
});

export const warehouseDashboardQuerySchema = z.object({
  warehouse_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(30).default(7),
});

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePolicyRow(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    effective_inspector_utilization: num(row.effective_inspector_utilization, 0.78),
    effective_qa_utilization: num(row.effective_qa_utilization, 0.8),
    default_daily_inspector_minutes: num(row.default_daily_inspector_minutes, 1440),
    default_daily_qa_minutes: num(row.default_daily_qa_minutes, 480),
    default_workstation_slots: num(row.default_workstation_slots, 4),
    default_photo_rig_slots: num(row.default_photo_rig_slots, 2),
    daily_break_minutes_per_shift: num(row.daily_break_minutes_per_shift, 45),
    daily_prep_minutes_per_shift: num(row.daily_prep_minutes_per_shift, 20),
    task_switch_overhead_minutes: num(row.task_switch_overhead_minutes, 4.5),
    qa_bottleneck_ratio: num(row.qa_bottleneck_ratio, 1.25),
    upload_queue_buffer_minutes: num(row.upload_queue_buffer_minutes, 15),
    base_rework_rate: num(row.base_rework_rate, 0.08),
    safety_buffer_pct: num(row.safety_buffer_pct, 0.15),
    safety_buffer_min_minutes: num(row.safety_buffer_min_minutes, 60),
    warn_utilization_pct: num(row.warn_utilization_pct, 0.7),
    review_utilization_pct: num(row.review_utilization_pct, 0.85),
    pause_heavy_intake_pct: num(row.pause_heavy_intake_pct, 0.95),
    manual_quote_workload_minutes: num(row.manual_quote_workload_minutes, 720),
    manual_quote_min_items: num(row.manual_quote_min_items, 30),
  };
}

function buildPolicySnapshot(p: Record<string, any>) {
  return {
    policy_code: p.policy_code,
    name_zh: p.name_zh,
    name_en: p.name_en,
    description_zh: p.description_zh,
    description_en: p.description_en,
    warehouse_id: p.warehouse_id ?? null,
    model_provenance: p.model_provenance,
    effective_inspector_utilization: num(p.effective_inspector_utilization),
    effective_qa_utilization: num(p.effective_qa_utilization),
    default_daily_inspector_minutes: num(p.default_daily_inspector_minutes),
    default_daily_qa_minutes: num(p.default_daily_qa_minutes),
    default_workstation_slots: num(p.default_workstation_slots),
    default_photo_rig_slots: num(p.default_photo_rig_slots),
    daily_break_minutes_per_shift: num(p.daily_break_minutes_per_shift),
    daily_prep_minutes_per_shift: num(p.daily_prep_minutes_per_shift),
    task_switch_overhead_minutes: num(p.task_switch_overhead_minutes),
    qa_bottleneck_ratio: num(p.qa_bottleneck_ratio),
    upload_queue_buffer_minutes: num(p.upload_queue_buffer_minutes),
    base_rework_rate: num(p.base_rework_rate),
    safety_buffer_pct: num(p.safety_buffer_pct),
    safety_buffer_min_minutes: num(p.safety_buffer_min_minutes),
    warn_utilization_pct: num(p.warn_utilization_pct),
    review_utilization_pct: num(p.review_utilization_pct),
    pause_heavy_intake_pct: num(p.pause_heavy_intake_pct),
    manual_quote_workload_minutes: num(p.manual_quote_workload_minutes),
    manual_quote_min_items: num(p.manual_quote_min_items),
    complexity_profiles: p.complexity_profiles ?? {},
    module_workload_profiles: p.module_workload_profiles ?? {},
    service_mode_rules: p.service_mode_rules ?? {},
    stage_weights: p.stage_weights ?? {},
  };
}

function parseDateList(raw: unknown): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function formatDateInTimezone(date: Date, timeZone: string): { dateStr: string; dayOfWeekIso: number; hourMinute: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "2026";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  const hr = parts.find((p) => p.type === "hour")?.value ?? "00";
  const min = parts.find((p) => p.type === "minute")?.value ?? "00";
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const wdMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { dateStr: `${y}-${m}-${d}`, dayOfWeekIso: wdMap[wd] ?? 1, hourMinute: `${hr}:${min}` };
}

function computeBusinessDeadline(
  startAt: Date,
  businessDaysNeeded: number,
  timeZone: string,
  cutoffReceivingTime: string,
  workingDays: Set<number>,
  holidays: Set<string>,
  extraWorkdays: Set<string>,
): Date {
  const days = Math.max(1, Math.ceil(businessDaysNeeded));
  const cur = new Date(startAt.getTime());
  const startInfo = formatDateInTimezone(cur, timeZone);
  let remaining = days;
  if (startInfo.hourMinute >= cutoffReceivingTime) {
    // Past receiving cutoff: Day 0 does not count toward same-day intake progress
    remaining += 1;
  }
  while (remaining > 0) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const info = formatDateInTimezone(cur, timeZone);
    if (holidays.has(info.dateStr) && !extraWorkdays.has(info.dateStr)) continue;
    const isWorking = workingDays.has(info.dayOfWeekIso) || extraWorkdays.has(info.dateStr);
    if (!isWorking) continue;
    remaining -= 1;
  }
  return cur;
}

async function hydratePolicyFromPublishedVersion(db: DB, policyRow: Record<string, any>): Promise<Record<string, any>> {
  if (!policyRow.latest_published_version_id) return normalizePolicyRow(policyRow);
  const ver = (
    await db.query<{ snapshot: Record<string, any>; version: number; id: string }>(
      "select id, version, snapshot from capacity_sla_policy_versions where id=$1",
      [policyRow.latest_published_version_id],
    )
  ).rows[0];
  if (!ver) return normalizePolicyRow(policyRow);
  return normalizePolicyRow({
    ...policyRow,
    ...ver.snapshot,
    id: policyRow.id,
    status: "published",
    current_version: ver.version,
    latest_published_version_id: ver.id,
  });
}

async function resolvePolicyForCalculation(
  db: DB,
  policyId?: string,
  warehouseId?: string,
  options: { preferPublishedSnapshot?: boolean } = {},
) {
  const preferPub = options.preferPublishedSnapshot !== false;
  if (policyId) {
    const row = await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1", [policyId]);
    if (preferPub && row.latest_published_version_id) {
      return hydratePolicyFromPublishedVersion(db, row);
    }
    return normalizePolicyRow(row);
  }
  if (warehouseId) {
    const whPub = (
      await db.query<Record<string, any>>(
        `select * from capacity_sla_policies
         where warehouse_id=$1 and (status='published' or latest_published_version_id is not null)
         order by (status='published') desc, published_at desc nulls last, updated_at desc limit 1`,
        [warehouseId],
      )
    ).rows[0];
    if (whPub) return hydratePolicyFromPublishedVersion(db, whPub);
  }
  const pub = (
    await db.query<Record<string, any>>(
      `select * from capacity_sla_policies
       where status='published' or latest_published_version_id is not null
       order by (status='published') desc, (warehouse_id is null) asc, published_at desc nulls last, updated_at desc limit 1`,
    )
  ).rows[0];
  if (pub) return hydratePolicyFromPublishedVersion(db, pub);
  const draftSeed = (
    await db.query<Record<string, any>>(
      `select * from capacity_sla_policies where status in ('in_review','draft') order by is_seed_default desc, updated_at desc limit 1`,
    )
  ).rows[0];
  guard(draftSeed, "CAPACITY_POLICY_NOT_FOUND", "No capacity & SLA policy found. Initialize capacity seed defaults first.", 404);
  return normalizePolicyRow(draftSeed);
}

async function loadWarehouseResourceSnapshot(db: DB, warehouseId: string | null | undefined, policy: Record<string, any>, planningDays = 7) {
  const wh = warehouseId
    ? (await db.query<{
        id: string;
        code: string;
        name_zh: string;
        name_en: string;
        timezone: string;
        cutoff_receiving_time: string;
        cutoff_dispatch_time: string;
        working_days: number[];
      }>(
        "select id,warehouse_code as code,name_zh,name_en,timezone,cutoff_receiving_time,cutoff_dispatch_time,working_days from warehouses where id=$1",
        [warehouseId],
      )).rows[0] ?? null
    : (await db.query<{
        id: string;
        code: string;
        name_zh: string;
        name_en: string;
        timezone: string;
        cutoff_receiving_time: string;
        cutoff_dispatch_time: string;
        working_days: number[];
      }>(
        "select id,warehouse_code as code,name_zh,name_en,timezone,cutoff_receiving_time,cutoff_dispatch_time,working_days from warehouses where status='active' order by accept_new_orders desc, created_at asc limit 1",
      )).rows[0] ?? null;

  const targetWhId = wh?.id ?? warehouseId ?? null;
  const timeZone = wh?.timezone ?? "Asia/Shanghai";
  const cutoffReceiving = wh?.cutoff_receiving_time ?? "17:30";
  const cutoffDispatch = wh?.cutoff_dispatch_time ?? "16:00";
  const workingDays = new Set<number>(Array.isArray(wh?.working_days) && wh.working_days.length > 0 ? wh.working_days : [1, 2, 3, 4, 5, 6]);

  const calendarRows = (
    await db.query<{ key: string; value: string }>(
      "select key,value from app_config where key in ('calendar.holidays','business_holidays','calendar.extra_workdays')",
    )
  ).rows;
  const holidays = new Set<string>();
  const extraWorkdays = new Set<string>();
  for (const r of calendarRows) {
    const parsed = parseDateList(r.value);
    if (r.key === "calendar.extra_workdays") parsed.forEach((d) => extraWorkdays.add(d));
    else parsed.forEach((d) => holidays.add(d));
  }

  let inspectorShiftMinutes = 0;
  let qaShiftMinutes = 0;
  let scheduledShiftCount = 0;
  const distinctInspectorDays = new Set<string>();
  const distinctQaDays = new Set<string>();
  let activeInspectWorkstations = num(policy.default_workstation_slots, 4);
  let activePhotoRigs = num(policy.default_photo_rig_slots, 2);
  let skillMaxLevel = 5;
  let backlogMinutes = 0;
  let openWorkItemCount = 0;

  if (targetWhId) {
    const shiftRows = (
      await db.query<{ shift_date: string; available_minutes: number; role_scope: string[] }>(
        `select shift_date::text, available_minutes, role_scope
         from staff_work_shifts
         where warehouse_id=$1
           and status='scheduled'
           and shift_date >= current_date
           and shift_date < current_date + $2::int`,
        [targetWhId, Math.max(1, planningDays)],
      )
    ).rows;
    scheduledShiftCount = shiftRows.length;
    const perShiftDeduction = num(policy.daily_break_minutes_per_shift) + num(policy.daily_prep_minutes_per_shift);
    for (const s of shiftRows) {
      const net = Math.max(0, Number(s.available_minutes) - perShiftDeduction);
      const roles = Array.isArray(s.role_scope) ? s.role_scope : [];
      if (roles.includes("reviewer") || roles.includes("qa")) {
        qaShiftMinutes += net;
        distinctQaDays.add(s.shift_date);
      } else {
        inspectorShiftMinutes += net;
        distinctInspectorDays.add(s.shift_date);
      }
    }

    const wsRow = (
      await db.query<{ active_b: string }>(
        `select count(*) filter (where station_type='B_inspection_shoot' and status='active')::text as active_b
         from workstations where warehouse_id=$1`,
        [targetWhId],
      )
    ).rows[0];
    if (wsRow && Number(wsRow.active_b) > 0) activeInspectWorkstations = Number(wsRow.active_b);

    const camRow = (
      await db.query<{ active_cam: string }>(
        `select count(*) filter (where device_role='camera' and approval_status='approved' and online_status='online')::text as active_cam
         from warehouse_devices where warehouse_id=$1`,
        [targetWhId],
      )
    ).rows[0];
    if (camRow && Number(camRow.active_cam) > 0) activePhotoRigs = Number(camRow.active_cam);

    const backlogRow = (
      await db.query<{ open_cnt: string }>(
        `select count(*)::text as open_cnt
         from dispatch_work_items
         where warehouse_id=$1 and dispatch_status in ('queued','assigned','in_progress','paused','handover_pending')`,
        [targetWhId],
      )
    ).rows[0];
    openWorkItemCount = Number(backlogRow?.open_cnt ?? 0);

    const commitBacklog = (
      await db.query<{ total_min: string }>(
        `select coalesce(sum(estimated_workload_minutes),0)::text as total_min
         from order_sla_commitments
         where warehouse_id=$1 and status in ('active','paused','extended','manual_review_required')`,
        [targetWhId],
      )
    ).rows[0];
    backlogMinutes = Math.max(num(commitBacklog?.total_min, 0), openWorkItemCount * 18);
  }

  const skillRow = (
    await db.query<{ max_lvl: number | null; active_cnt: string }>(
      `select max(case when g.skill_code ~ 'L[1-5]' then substring(g.skill_code from 'L([1-5])')::int else 3 end) as max_lvl,
              count(*)::text as active_cnt
       from inspector_skill_grants g
       where g.status='active'
         and (g.valid_until is null or g.valid_until > now())
         and (
           $1::uuid is null
           or not exists (select 1 from staff_work_shifts s where s.warehouse_id=$1 and s.status='scheduled' and s.shift_date >= current_date)
           or exists (select 1 from staff_work_shifts s where s.warehouse_id=$1 and s.user_id=g.user_id and s.status='scheduled' and s.shift_date >= current_date)
         )`,
      [targetWhId],
    )
  ).rows[0];
  const activeSkillGrantsCount = Number(skillRow?.active_cnt ?? 0);
  const skillSource = activeSkillGrantsCount > 0 ? "certified_grants" : "uncertified_default";
  skillMaxLevel = skillRow?.max_lvl ? Number(skillRow.max_lvl) : 2;

  const shiftSource = scheduledShiftCount > 0 ? "scheduled_staff_shifts" : "policy_draft_fallback";
  const grossInspectorDailyMinutes =
    distinctInspectorDays.size > 0
      ? Math.max(60, inspectorShiftMinutes / distinctInspectorDays.size)
      : num(policy.default_daily_inspector_minutes, 1440);
  const grossQaDailyMinutes =
    distinctQaDays.size > 0
      ? Math.max(30, qaShiftMinutes / distinctQaDays.size)
      : num(policy.default_daily_qa_minutes, 480);

  const effInspectorDaily = grossInspectorDailyMinutes * num(policy.effective_inspector_utilization, 0.78);
  const effQaDaily = grossQaDailyMinutes * num(policy.effective_qa_utilization, 0.8);
  const effWorkstationDaily = activeInspectWorkstations * 420 * num(policy.effective_inspector_utilization, 0.78);
  const photoRigDaily = activePhotoRigs * 420 * num(policy.effective_inspector_utilization, 0.78);
  const effectiveDailyCapacityMinutes = Math.min(
    effInspectorDaily,
    effQaDaily * num(policy.qa_bottleneck_ratio, 1.25),
    effWorkstationDaily,
    photoRigDaily * 1.6,
  );

  return {
    warehouse_id: targetWhId,
    warehouse_code: wh?.code ?? "DEFAULT",
    warehouse_name_zh: wh?.name_zh ?? "默认仓库",
    warehouse_name_en: wh?.name_en ?? "Default Warehouse",
    timezone: timeZone,
    cutoff_receiving_time: cutoffReceiving,
    cutoff_dispatch_time: cutoffDispatch,
    working_days: workingDays,
    holidays,
    extra_workdays: extraWorkdays,
    shift_source: shiftSource,
    scheduled_shift_count: scheduledShiftCount,
    active_inspect_workstations: activeInspectWorkstations,
    active_photo_rigs: activePhotoRigs,
    skill_max_level: skillMaxLevel,
    skill_certifications_count: activeSkillGrantsCount,
    skill_source: skillSource,
    gross_inspector_daily_minutes: Number(grossInspectorDailyMinutes.toFixed(2)),
    gross_qa_daily_minutes: Number(grossQaDailyMinutes.toFixed(2)),
    effective_inspector_daily_minutes: Number(effInspectorDaily.toFixed(2)),
    effective_qa_daily_minutes: Number(effQaDaily.toFixed(2)),
    effective_workstation_daily_minutes: Number(effWorkstationDaily.toFixed(2)),
    effective_photo_rig_daily_minutes: Number(photoRigDaily.toFixed(2)),
    effective_daily_capacity_minutes: Number(Math.max(60, effectiveDailyCapacityMinutes).toFixed(2)),
    open_work_items: openWorkItemCount,
    open_backlog_minutes: Number(backlogMinutes.toFixed(2)),
  };
}

async function resolveEmpiricalCalibration(db: DB) {
  const [baselineRows, sampleRows] = await Promise.all([
    db.query<{ activity_code: string; complexity_code: string; default_assumption_minutes: string }>(
      "select activity_code, complexity_code, default_assumption_minutes::text from labor_baseline_assumptions",
    ),
    db.query<{ activity_code: string; complexity_code: string; sample_count: string; p50_minutes: string }>(
      `select activity_code,
              coalesce(complexity_code, 'ALL') as complexity_code,
              count(*)::text as sample_count,
              coalesce(percentile_cont(0.5) within group (order by coalesce(effective_seconds, raw_elapsed_seconds, 0) / 60.0), 0)::text as p50_minutes
       from labor_time_events
       where status in ('completed','corrected')
         and time_bucket = 'active_labor'
         and data_provenance in ('measured_field','measured_system')
       group by activity_code, coalesce(complexity_code, 'ALL')`,
    ),
  ]);

  const baselines = new Map<string, number>();
  for (const b of baselineRows.rows) {
    baselines.set(`${b.activity_code}:${b.complexity_code}`, Number(b.default_assumption_minutes));
  }
  let totalFieldSamples = 0;
  const empiricalP50 = new Map<string, { samples: number; p50: number }>();
  for (const s of sampleRows.rows) {
    const cnt = Number(s.sample_count);
    totalFieldSamples += cnt;
    empiricalP50.set(`${s.activity_code}:${s.complexity_code}`, { samples: cnt, p50: Number(s.p50_minutes) });
  }
  return { baselines, empiricalP50, totalFieldSamples };
}

export async function listCapacitySlaPolicies(db: DB, actor: Actor) {
  role(actor, ...CAPACITY_READ_ROLES);
  const { rows } = await db.query<Record<string, any>>(
    `select p.*, w.warehouse_code, w.name_zh as warehouse_name_zh, w.name_en as warehouse_name_en
     from capacity_sla_policies p
     left join warehouses w on w.id = p.warehouse_id
     order by p.is_seed_default desc, p.updated_at desc`,
  );
  return { policies: rows.map(normalizePolicyRow) };
}

export async function getCapacityPolicyDetail(db: DB, actor: Actor, policyId: string) {
  role(actor, ...CAPACITY_READ_ROLES);
  const policy = normalizePolicyRow(await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1", [policyId]));
  const versions = (
    await db.query<Record<string, any>>(
      `select v.*,
              (select ue.normalized_email::text from user_emails ue where ue.user_id = v.author_id order by ue.verified_at desc nulls last, ue.id asc limit 1) as author_email,
              (select ue.normalized_email::text from user_emails ue where ue.user_id = v.reviewer_id order by ue.verified_at desc nulls last, ue.id asc limit 1) as reviewer_email
       from capacity_sla_policy_versions v
       where v.policy_id=$1
       order by v.version desc`,
      [policyId],
    )
  ).rows;
  return { policy, versions };
}

export async function saveCapacityPolicyDraft(db: DB, actor: Actor, rawInput: unknown, sessionHash: string = "") {
  role(actor, ...CAPACITY_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const rawObj = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const preId = typeof rawObj.id === "string" && rawObj.id ? rawObj.id : undefined;

  let mergedInput: Record<string, unknown> = rawObj;
  let existingCur: Record<string, any> | null = null;
  if (preId) {
    existingCur = normalizePolicyRow(await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1 for update", [preId]));
    const {
      status: _st,
      current_version: _cv,
      latest_published_version_id: _lp,
      is_seed_default: _isd,
      admin_modified: _am,
      created_by: _cb,
      submitted_by: _sb,
      approved_by: _ab,
      published_at: _pa,
      retired_at: _ra,
      created_at: _ca,
      updated_at: _ua,
      ...editableExisting
    } = existingCur;
    mergedInput = { ...editableExisting };
    for (const [k, v] of Object.entries(rawObj)) {
      if (v !== undefined) mergedInput[k] = v;
    }
  }

  const parsed = capacityPolicyDraftSchema.parse(mergedInput);
  if (parsed.model_provenance === "field_calibrated" || parsed.model_provenance === "hybrid") {
    const empirical = await resolveEmpiricalCalibration(db);
    let calibratedStages = 0;
    for (const v of empirical.empiricalP50.values()) {
      if (v.samples >= 10 && v.p50 > 0) calibratedStages += 1;
    }
    guard(
      parsed.model_provenance === "hybrid" ? calibratedStages >= 1 : calibratedStages >= 3,
      "EMPIRICAL_CALIBRATION_REQUIRED",
      "Cannot mark policy provenance as field_calibrated/hybrid without >= 10 measured empirical samples per active stage (§58.5).",
      422,
    );
  }

  await lock(db, `capacity_policy:${parsed.policy_code}`);
  if (parsed.id) {
    const cur = existingCur ?? (await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1 for update", [parsed.id]));
    const nextVersion = cur.status === "published" || cur.status === "retired" ? Number(cur.current_version) + 1 : Number(cur.current_version);
    const updated = await one<Record<string, any>>(db,
      `update capacity_sla_policies set
         policy_code=$2, name_zh=$3, name_en=$4, description_zh=$5, description_en=$6,
         warehouse_id=$7, status='draft', current_version=$8, model_provenance=$9,
         effective_inspector_utilization=$10, effective_qa_utilization=$11,
         default_daily_inspector_minutes=$12, default_daily_qa_minutes=$13,
         default_workstation_slots=$14, default_photo_rig_slots=$15,
         daily_break_minutes_per_shift=$16, daily_prep_minutes_per_shift=$17,
         task_switch_overhead_minutes=$18, qa_bottleneck_ratio=$19,
         upload_queue_buffer_minutes=$20, base_rework_rate=$21,
         safety_buffer_pct=$22, safety_buffer_min_minutes=$23,
         warn_utilization_pct=$24, review_utilization_pct=$25, pause_heavy_intake_pct=$26,
         manual_quote_workload_minutes=$27, manual_quote_min_items=$28,
         complexity_profiles=$29::jsonb, module_workload_profiles=$30::jsonb,
         service_mode_rules=$31::jsonb, stage_weights=$32::jsonb,
         admin_modified=true, created_by=$33::uuid, submitted_by=null, approved_by=null, updated_at=now()
       where id=$1 returning *`,
      [
        parsed.id,
        parsed.policy_code,
        parsed.name_zh,
        parsed.name_en,
        parsed.description_zh,
        parsed.description_en,
        parsed.warehouse_id ?? null,
        nextVersion,
        parsed.model_provenance,
        parsed.effective_inspector_utilization,
        parsed.effective_qa_utilization,
        parsed.default_daily_inspector_minutes,
        parsed.default_daily_qa_minutes,
        parsed.default_workstation_slots,
        parsed.default_photo_rig_slots,
        parsed.daily_break_minutes_per_shift,
        parsed.daily_prep_minutes_per_shift,
        parsed.task_switch_overhead_minutes,
        parsed.qa_bottleneck_ratio,
        parsed.upload_queue_buffer_minutes,
        parsed.base_rework_rate,
        parsed.safety_buffer_pct,
        parsed.safety_buffer_min_minutes,
        parsed.warn_utilization_pct,
        parsed.review_utilization_pct,
        parsed.pause_heavy_intake_pct,
        parsed.manual_quote_workload_minutes,
        parsed.manual_quote_min_items,
        JSON.stringify(parsed.complexity_profiles),
        JSON.stringify(parsed.module_workload_profiles),
        JSON.stringify(parsed.service_mode_rules),
        JSON.stringify(parsed.stage_weights),
        actor.id,
      ],
    );
    await audit(db, actor, "capacity_policy_saved", "capacity_sla_policies", updated.id, {
      policy_code: updated.policy_code,
      version: updated.current_version,
    });
    return { policy: normalizePolicyRow(updated) };
  }

  const created = await one<Record<string, any>>(db,
    `insert into capacity_sla_policies (
      policy_code, name_zh, name_en, description_zh, description_en,
      warehouse_id, status, current_version, model_provenance,
      effective_inspector_utilization, effective_qa_utilization,
      default_daily_inspector_minutes, default_daily_qa_minutes,
      default_workstation_slots, default_photo_rig_slots,
      daily_break_minutes_per_shift, daily_prep_minutes_per_shift,
      task_switch_overhead_minutes, qa_bottleneck_ratio,
      upload_queue_buffer_minutes, base_rework_rate,
      safety_buffer_pct, safety_buffer_min_minutes,
      warn_utilization_pct, review_utilization_pct, pause_heavy_intake_pct,
      manual_quote_workload_minutes, manual_quote_min_items,
      complexity_profiles, module_workload_profiles, service_mode_rules, stage_weights,
      is_seed_default, admin_modified, created_by
    ) values (
      $1,$2,$3,$4,$5,$6,'draft',1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
      $27::jsonb,$28::jsonb,$29::jsonb,$30::jsonb,false,true,$31::uuid
    ) returning *`,
    [
      parsed.policy_code,
      parsed.name_zh,
      parsed.name_en,
      parsed.description_zh,
      parsed.description_en,
      parsed.warehouse_id ?? null,
      parsed.model_provenance,
      parsed.effective_inspector_utilization,
      parsed.effective_qa_utilization,
      parsed.default_daily_inspector_minutes,
      parsed.default_daily_qa_minutes,
      parsed.default_workstation_slots,
      parsed.default_photo_rig_slots,
      parsed.daily_break_minutes_per_shift,
      parsed.daily_prep_minutes_per_shift,
      parsed.task_switch_overhead_minutes,
      parsed.qa_bottleneck_ratio,
      parsed.upload_queue_buffer_minutes,
      parsed.base_rework_rate,
      parsed.safety_buffer_pct,
      parsed.safety_buffer_min_minutes,
      parsed.warn_utilization_pct,
      parsed.review_utilization_pct,
      parsed.pause_heavy_intake_pct,
      parsed.manual_quote_workload_minutes,
      parsed.manual_quote_min_items,
      JSON.stringify(parsed.complexity_profiles),
      JSON.stringify(parsed.module_workload_profiles),
      JSON.stringify(parsed.service_mode_rules),
      JSON.stringify(parsed.stage_weights),
      actor.id,
    ],
  );
  await audit(db, actor, "capacity_policy_created", "capacity_sla_policies", created.id, {
    policy_code: created.policy_code,
    version: created.current_version,
  });
  return { policy: normalizePolicyRow(created) };
}

export async function submitCapacityPolicy(db: DB, actor: Actor, policyId: string, note?: string, sessionHash: string = "") {
  role(actor, ...CAPACITY_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `capacity_policy_id:${policyId}`);
  const cur = await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1 for update", [policyId]);
  guard(cur.status === "draft", "INVALID_STATE", "Only draft capacity policies can be submitted for review.");
  const updated = await one<Record<string, any>>(db,
    `update capacity_sla_policies set status='in_review', submitted_by=$2::uuid, updated_at=now() where id=$1 returning *`,
    [policyId, actor.id],
  );
  await audit(db, actor, "capacity_policy_submitted", "capacity_sla_policies", policyId, {
    version: updated.current_version,
    ...(note?.trim() ? { note: note.trim() } : {}),
  });
  return { policy: normalizePolicyRow(updated) };
}

export async function publishCapacityPolicy(
  db: DB,
  actor: Actor,
  policyId: string,
  inputData?: { publication_scope?: "sandbox_acceptance" | "production"; note?: string },
  sessionHash: string = "",
) {
  role(actor, ...CAPACITY_REVIEW_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `capacity_policy_id:${policyId}`);
  const cur = await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1 for update", [policyId]);
  guard(cur.status === "in_review", "INVALID_STATE", "Only in-review capacity policies can be published.");
  guard(cur.created_by !== actor.id, "SOD_VIOLATION", "Policy author cannot approve/publish their own policy version.", 403);
  guard(!cur.submitted_by || cur.submitted_by !== actor.id, "SOD_VIOLATION", "Submitter cannot approve/publish the same submission.", 403);

  const scope = inputData?.publication_scope === "production" ? "production" : "sandbox_acceptance";
  guard(scope === "sandbox_acceptance", "PRODUCTION_APPROVAL_REQUIRED", "Production promotion requires formal business calibration & sign-off.", 403);

  const snapshot = buildPolicySnapshot(cur);
  const contentHash = hash(JSON.stringify(snapshot));
  const versionRow = await one<Record<string, any>>(db,
    `insert into capacity_sla_policy_versions (
      policy_id, policy_code, version, state, publication_scope, business_approved,
      snapshot, content_hash, author_id, submitted_by, reviewer_id, note
    ) values ($1,$2,$3,'PUBLISHED','sandbox_acceptance',false,$4::jsonb,$5,$6::uuid,$7::uuid,$8::uuid,$9)
    returning *`,
    [
      cur.id,
      cur.policy_code,
      cur.current_version,
      JSON.stringify(snapshot),
      contentHash,
      cur.created_by,
      cur.submitted_by ?? null,
      actor.id,
      inputData?.note?.trim() ?? null,
    ],
  );

  const updated = await one<Record<string, any>>(db,
    `update capacity_sla_policies set
       status='published', latest_published_version_id=$2, approved_by=$3::uuid, published_at=now(), updated_at=now()
     where id=$1 returning *`,
    [policyId, versionRow.id, actor.id],
  );
  await audit(db, actor, "capacity_policy_published", "capacity_sla_policies", policyId, {
    version: versionRow.version,
    content_hash: contentHash,
    publication_scope: scope,
  });
  return { policy: normalizePolicyRow(updated), published_version: versionRow };
}

export async function retireCapacityPolicy(db: DB, actor: Actor, policyId: string, reason: string, sessionHash: string = "") {
  role(actor, ...CAPACITY_REVIEW_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  guard(reason.trim().length >= 3, "INVALID_REQUEST", "Retire reason is required.", 422);
  await lock(db, `capacity_policy_id:${policyId}`);
  const cur = await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1 for update", [policyId]);
  guard(cur.status === "published", "INVALID_STATE", "Only published capacity policies can be retired.");
  await db.query("update capacity_sla_policy_versions set state='RETIRED', retired_at=now() where policy_id=$1 and state='PUBLISHED'", [policyId]);
  const updated = await one<Record<string, any>>(db,
    "update capacity_sla_policies set status='retired', retired_at=now(), updated_at=now() where id=$1 returning *",
    [policyId],
  );
  await audit(db, actor, "capacity_policy_retired", "capacity_sla_policies", policyId, { reason: reason.trim() });
  return { policy: normalizePolicyRow(updated) };
}

export async function rollbackCapacityPolicy(db: DB, actor: Actor, policyId: string, targetVersion: number, sessionHash: string = "") {
  role(actor, ...CAPACITY_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `capacity_policy_id:${policyId}`);
  const cur = await one<Record<string, any>>(db, "select * from capacity_sla_policies where id=$1 for update", [policyId]);
  const target = await one<Record<string, any>>(db,
    "select * from capacity_sla_policy_versions where policy_id=$1 and version=$2",
    [policyId, targetVersion],
  );
  const snap = target.snapshot as Record<string, any>;
  const nextVersion = Number(cur.current_version) + 1;
  const updated = await one<Record<string, any>>(db,
    `update capacity_sla_policies set
       name_zh=$2, name_en=$3, description_zh=$4, description_en=$5, warehouse_id=$6,
       model_provenance=$7, effective_inspector_utilization=$8, effective_qa_utilization=$9,
       default_daily_inspector_minutes=$10, default_daily_qa_minutes=$11,
       default_workstation_slots=$12, default_photo_rig_slots=$13,
       daily_break_minutes_per_shift=$14, daily_prep_minutes_per_shift=$15,
       task_switch_overhead_minutes=$16, qa_bottleneck_ratio=$17,
       upload_queue_buffer_minutes=$18, base_rework_rate=$19,
       safety_buffer_pct=$20, safety_buffer_min_minutes=$21,
       warn_utilization_pct=$22, review_utilization_pct=$23, pause_heavy_intake_pct=$24,
       manual_quote_workload_minutes=$25, manual_quote_min_items=$26,
       complexity_profiles=$27::jsonb, module_workload_profiles=$28::jsonb,
       service_mode_rules=$29::jsonb, stage_weights=$30::jsonb,
       status='draft', current_version=$31, created_by=$32::uuid, submitted_by=null, approved_by=null, updated_at=now()
     where id=$1 returning *`,
    [
      policyId,
      snap.name_zh ?? cur.name_zh,
      snap.name_en ?? cur.name_en,
      snap.description_zh ?? "",
      snap.description_en ?? "",
      snap.warehouse_id ?? null,
      snap.model_provenance ?? "estimated_baseline",
      num(snap.effective_inspector_utilization, 0.78),
      num(snap.effective_qa_utilization, 0.8),
      num(snap.default_daily_inspector_minutes, 1440),
      num(snap.default_daily_qa_minutes, 480),
      num(snap.default_workstation_slots, 4),
      num(snap.default_photo_rig_slots, 2),
      num(snap.daily_break_minutes_per_shift, 45),
      num(snap.daily_prep_minutes_per_shift, 20),
      num(snap.task_switch_overhead_minutes, 4.5),
      num(snap.qa_bottleneck_ratio, 1.25),
      num(snap.upload_queue_buffer_minutes, 15),
      num(snap.base_rework_rate, 0.08),
      num(snap.safety_buffer_pct, 0.15),
      num(snap.safety_buffer_min_minutes, 60),
      num(snap.warn_utilization_pct, 0.7),
      num(snap.review_utilization_pct, 0.85),
      num(snap.pause_heavy_intake_pct, 0.95),
      num(snap.manual_quote_workload_minutes, 720),
      num(snap.manual_quote_min_items, 30),
      JSON.stringify(snap.complexity_profiles ?? {}),
      JSON.stringify(snap.module_workload_profiles ?? {}),
      JSON.stringify(snap.service_mode_rules ?? {}),
      JSON.stringify(snap.stage_weights ?? {}),
      nextVersion,
      actor.id,
    ],
  );
  await audit(db, actor, "capacity_policy_rollback_drafted", "capacity_sla_policies", policyId, {
    from_version: targetVersion,
    new_draft_version: nextVersion,
  });
  return { policy: normalizePolicyRow(updated) };
}

export async function calculateWorkloadAndSla(db: DB, actor: Actor, rawInput: unknown, sessionHash: string = "") {
  role(actor, ...CAPACITY_READ_ROLES);
  const input = capacitySimulationSchema.parse(rawInput);
  if (input.persist_commitment) {
    role(actor, ...CAPACITY_EDIT_ROLES);
    await requireStaffMfa(db, actor, sessionHash, 15);
  }

  const policy = await resolvePolicyForCalculation(db, input.policy_id, input.warehouse_id, {
    preferPublishedSnapshot: Boolean(input.persist_commitment),
  });
  const whSnapshot = await loadWarehouseResourceSnapshot(db, input.warehouse_id ?? policy.warehouse_id, policy, 7);
  const empirical = await resolveEmpiricalCalibration(db);

  const complexityMap = (policy.complexity_profiles ?? DEFAULT_COMPLEXITY_PROFILES) as Record<string, any>;
  const moduleMap = (policy.module_workload_profiles ?? DEFAULT_MODULE_WORKLOAD_PROFILES) as Record<string, any>;
  const modeMap = (policy.service_mode_rules ?? DEFAULT_SERVICE_MODE_RULES) as Record<string, any>;
  const stageWeights = (policy.stage_weights ?? DEFAULT_STAGE_WEIGHTS) as Record<string, number>;

  const cProfile = complexityMap[input.complexity_code] ?? DEFAULT_COMPLEXITY_PROFILES[input.complexity_code];
  const mRule = modeMap[input.service_mode] ?? DEFAULT_SERVICE_MODE_RULES[input.service_mode];

  // Empirical calibration lookup helper (falls back to policy/032 draft baseline when <10 field samples)
  let fieldCalibratedStages = 0;
  const pickDuration = (activityCode: string, policyDefault: number, complexity: string = input.complexity_code) => {
    const exact = empirical.empiricalP50.get(`${activityCode}:${complexity}`) ?? empirical.empiricalP50.get(`${activityCode}:ALL`);
    if (exact && exact.samples >= 10 && exact.p50 > 0) {
      fieldCalibratedStages += 1;
      return exact.p50;
    }
    const base = empirical.baselines.get(`${activityCode}:${complexity}`) ?? empirical.baselines.get(`${activityCode}:ALL`);
    return base ? (policyDefault * 0.7 + base * 0.3) : policyDefault;
  };

  const visualMinPerUnit = pickDuration("visual_inspect", num(cProfile.visual_min_per_unit, 4.5));
  const prepMinPerUnit = pickDuration("garment_prep", num(cProfile.prep_min_per_unit, 1.5));
  const repackMinPerUnit = pickDuration("repack_putaway", num(cProfile.repack_min_per_unit, 1.5));
  const qaMinPerUnit = pickDuration("qa_review", num(cProfile.qa_min_per_unit, 1.0), "ALL");
  const intakeParcelMin = pickDuration("parcel_intake", 3.5, "ALL") + pickDuration("unbox_count", 5.0, "ALL");
  const skuLabelMin = pickDuration("sku_label", 2.0, "ALL");

  // Module decomposition & setup
  let moduleUnitMinutes = 0;
  let moduleSetupMinutes = 0;
  let photoRigModuleMinutes = 0;
  let measurementModulePresent = false;
  let independentEligibleByModules = Boolean(mRule.independent_batch_allowed);

  const uniqueModules = Array.from(new Set(input.module_codes));
  const moduleDetails: Array<Record<string, unknown>> = [];
  for (const modCode of uniqueModules) {
    const mp = moduleMap[modCode];
    if (!mp) continue;
    const perUnit = num(mp.extra_min_per_unit, 0);
    const setup = num(mp.order_setup_minutes, 0);
    if (modCode === "M02" || modCode === "M03") measurementModulePresent = true;
    if (mp.independent_batch_eligible === false) independentEligibleByModules = false;
    moduleSetupMinutes += setup;
    const effectiveModUnits = modCode === "M02" || modCode === "M03" ? Math.max(input.measurement_coverage_qty, 0) || input.quantity : input.quantity;
    const totalModMin = perUnit * effectiveModUnits + setup;
    if (mp.bottleneck_resource === "photo_rig") photoRigModuleMinutes += totalModMin;
    else moduleUnitMinutes += perUnit * effectiveModUnits;
    moduleDetails.push({
      module_code: modCode,
      units_covered: effectiveModUnits,
      extra_min_per_unit: perUnit,
      order_setup_minutes: setup,
      total_minutes: Number(totalModMin.toFixed(2)),
      bottleneck_resource: mp.bottleneck_resource ?? "inspector",
    });
  }

  // Dedicated measurement point workload beyond baseline M02/M03
  const measuredUnits = measurementModulePresent ? (input.measurement_coverage_qty > 0 ? input.measurement_coverage_qty : input.quantity) : input.measurement_coverage_qty;
  const measureMinPerPoint = pickDuration("measurement_point", 0.55, "ALL");
  const extraMeasurementMinutes = measuredUnits * input.measurement_points_per_unit * measureMinPerPoint;

  // Photo & Video capture workload (rig-constrained)
  const photoMinPerShot = pickDuration("photo_capture", 0.45, "ALL");
  const videoMinPerOrderUnit = input.video_seconds_per_unit > 0 ? Math.max(1.2, input.video_seconds_per_unit / 15) : 0;
  const mediaCaptureMinutes =
    photoRigModuleMinutes +
    input.quantity * input.photo_shots_per_unit * photoMinPerShot +
    input.quantity * videoMinPerOrderUnit;

  // Compare & Golden dependency calculations
  const compareLockActive = Boolean(mRule.dependency_lock) || input.compare_group_size > 1 || input.golden_sample_calls > 0 || !independentEligibleByModules;
  const compareCoordinationMinutes =
    num(mRule.group_setup_minutes, 0) +
    (input.compare_group_size > 1 ? input.compare_group_size * 3.5 : 0) +
    input.golden_sample_calls * num(mRule.golden_call_minutes, 5);

  const stageOrderPrep =
    (pickDuration("order_prep", 8.0, "ALL") + moduleSetupMinutes + compareCoordinationMinutes + num(policy.task_switch_overhead_minutes, 4.5)) *
    num(stageWeights.order_prep, 1);

  const stageIntakeUnbox =
    (input.parcel_count * intakeParcelMin + input.quantity * (skuLabelMin + prepMinPerUnit)) *
    num(stageWeights.intake_unbox, 1);

  const reworkRate = input.estimated_rework_rate_override ?? Math.max(num(policy.base_rework_rate, 0.08), num(cProfile.rework_factor, 0.08));
  const rawInspectAndMeasure = input.quantity * visualMinPerUnit + moduleUnitMinutes + extraMeasurementMinutes;
  const reworkMinutes = rawInspectAndMeasure * reworkRate;
  const stageInspectionMeasure = (rawInspectAndMeasure + reworkMinutes) * num(stageWeights.inspection_measure, 1);

  const stagePhotoVideoCapture = mediaCaptureMinutes * num(stageWeights.photo_video_capture, 1);

  // Async background queue (upload/transcode) contributes queue delay buffer, kept distinct from inspector active minutes
  const stageUploadTranscode =
    (num(policy.upload_queue_buffer_minutes, 15) + (input.quantity * input.photo_shots_per_unit * 0.08) + (input.quantity * (input.video_seconds_per_unit / 30))) *
    num(stageWeights.upload_transcode, 1);

  const stageQaReview =
    (input.quantity * qaMinPerUnit * num(mRule.qa_multiplier, 1) * num(policy.qa_bottleneck_ratio, 1.25) + compareCoordinationMinutes * 0.4) *
    num(stageWeights.qa_review, 1);

  const stageRepackOutbound = (input.quantity * repackMinPerUnit + input.parcel_count * 2.5) * num(stageWeights.repack_outbound, 1);

  const activeInspectionMinutes = stageOrderPrep + stageIntakeUnbox + stageInspectionMeasure + stagePhotoVideoCapture + stageRepackOutbound;
  const totalWorkloadMinutes = activeInspectionMinutes + stageQaReview + stageUploadTranscode;

  const safetyBufferMinutes = Math.max(
    num(policy.safety_buffer_min_minutes, 60),
    totalWorkloadMinutes * num(policy.safety_buffer_pct, 0.15),
  );

  // Bottleneck stage determination against daily capacities
  const inspectorLoadRatio = (whSnapshot.open_backlog_minutes * 0.72 + activeInspectionMinutes) / Math.max(60, whSnapshot.effective_inspector_daily_minutes);
  const qaLoadRatio = (whSnapshot.open_backlog_minutes * 0.28 + stageQaReview) / Math.max(30, whSnapshot.effective_qa_daily_minutes);
  const workstationLoadRatio = (whSnapshot.open_backlog_minutes * 0.72 + activeInspectionMinutes) / Math.max(60, whSnapshot.effective_workstation_daily_minutes);
  const photoLoadRatio = stagePhotoVideoCapture / Math.max(30, whSnapshot.effective_photo_rig_daily_minutes);
  const totalUtilizationRatio = (whSnapshot.open_backlog_minutes + totalWorkloadMinutes) / Math.max(60, whSnapshot.effective_daily_capacity_minutes);

  const requiredSkill = num(cProfile.required_skill_level, 1);
  const skillScarce = requiredSkill > whSnapshot.skill_max_level;

  let bottleneckStage = "inspector";
  if (skillScarce) bottleneckStage = "skill_scarcity";
  else if (qaLoadRatio >= inspectorLoadRatio && qaLoadRatio >= photoLoadRatio && qaLoadRatio >= workstationLoadRatio) bottleneckStage = "qa";
  else if (workstationLoadRatio > inspectorLoadRatio && workstationLoadRatio >= photoLoadRatio) bottleneckStage = "workstation";
  else if (photoLoadRatio > inspectorLoadRatio) bottleneckStage = "photo_rig";

  let capacityAlertLevel: "normal" | "warn_70" | "review_85" | "pause_heavy_95" = "normal";
  if (totalUtilizationRatio >= num(policy.pause_heavy_intake_pct, 0.95)) capacityAlertLevel = "pause_heavy_95";
  else if (totalUtilizationRatio >= num(policy.review_utilization_pct, 0.85)) capacityAlertLevel = "review_85";
  else if (totalUtilizationRatio >= num(policy.warn_utilization_pct, 0.7)) capacityAlertLevel = "warn_70";

  const manualSlaReasons: string[] = [];
  if (input.complexity_code === "L4" || input.complexity_code === "L5") {
    manualSlaReasons.push(`Complexity ${input.complexity_code} requires custom engineering / manual due confirmation`);
  }
  if (input.quantity >= num(policy.manual_quote_min_items, 30) && totalWorkloadMinutes >= num(policy.manual_quote_workload_minutes, 720)) {
    manualSlaReasons.push(`Heavy workload (${Math.round(totalWorkloadMinutes)}m across ${input.quantity} pcs) exceeds automatic SLA cap`);
  }
  if (capacityAlertLevel === "review_85" || capacityAlertLevel === "pause_heavy_95") {
    manualSlaReasons.push(`Warehouse utilization alert ${capacityAlertLevel} (${(totalUtilizationRatio * 100).toFixed(1)}%)`);
  }
  if (skillScarce) {
    manualSlaReasons.push(`Required skill level L${requiredSkill} exceeds certified warehouse max L${whSnapshot.skill_max_level}`);
  }
  if (input.requires_custom_coordination) {
    manualSlaReasons.push("Explicit custom coordination / manual delivery promise requested");
  }
  const manualSlaRequired = manualSlaReasons.length > 0;

  const readyUnits = input.ready_units_count ?? input.quantity;
  const partialUnitsRemaining = Math.max(0, input.quantity - readyUnits);
  const partialBatchEligible = !compareLockActive && readyUnits > 0 && partialUnitsRemaining > 0;

  const effectiveQueueAndWorkMinutes = whSnapshot.open_backlog_minutes * 0.35 + totalWorkloadMinutes + safetyBufferMinutes;
  const rawDaysNeeded = Math.max(1, effectiveQueueAndWorkMinutes / Math.max(60, whSnapshot.effective_daily_capacity_minutes));
  const startAt = input.start_at ? new Date(input.start_at) : new Date();
  const estimatedDueAt = computeBusinessDeadline(
    startAt,
    rawDaysNeeded,
    whSnapshot.timezone,
    whSnapshot.cutoff_receiving_time,
    whSnapshot.working_days,
    whSnapshot.holidays,
    whSnapshot.extra_workdays,
  );

  const provenance =
    fieldCalibratedStages >= 3 ? "field_calibrated" : fieldCalibratedStages > 0 ? "hybrid" : "estimated_baseline";

  const stageBreakdown = {
    order_prep_minutes: Number(stageOrderPrep.toFixed(2)),
    intake_unbox_minutes: Number(stageIntakeUnbox.toFixed(2)),
    inspection_measure_minutes: Number(stageInspectionMeasure.toFixed(2)),
    rework_allowance_minutes: Number(reworkMinutes.toFixed(2)),
    photo_video_capture_minutes: Number(stagePhotoVideoCapture.toFixed(2)),
    upload_transcode_async_minutes: Number(stageUploadTranscode.toFixed(2)),
    qa_review_minutes: Number(stageQaReview.toFixed(2)),
    repack_outbound_minutes: Number(stageRepackOutbound.toFixed(2)),
    module_breakdown: moduleDetails,
  };

  let persistedCommitment: Record<string, any> | null = null;
  if (input.persist_commitment && input.order_id) {
    const orderRow = await one<{ id: string }>(db, "select id from orders where id=$1", [input.order_id]);
    const commitKind =
      input.service_mode === "compare_horizontal"
        ? "compare_group"
        : input.service_mode === "golden_sample"
          ? "golden_group"
          : partialBatchEligible
            ? "independent_batch"
            : "order_total";

    const existingStarted = (
      await db.query<{ sla_started_at: string | null }>(
        "select sla_started_at from order_sla_commitments where order_id=$1 and batch_key=$2",
        [orderRow.id, input.batch_key],
      )
    ).rows[0];
    guard(!existingStarted?.sla_started_at, "SLA_ALREADY_STARTED", "Cannot overwrite an already-started SLA commitment via simulation.", 409);

    persistedCommitment = await one<Record<string, any>>(db,
      `insert into order_sla_commitments (
        order_id, batch_key, commitment_kind, policy_id, policy_version_id, warehouse_id,
        dependency_locked, dependency_reason, status, manual_sla_required, manual_sla_reasons,
        provenance, estimated_workload_minutes, effective_capacity_minutes_per_day,
        safety_buffer_minutes, bottleneck_stage, stage_breakdown,
        capacity_utilization_ratio, capacity_alert_level, current_due_at,
        created_by, updated_by
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21::uuid,$21::uuid
      )
      on conflict (order_id, batch_key) do update set
        commitment_kind=excluded.commitment_kind,
        policy_id=excluded.policy_id,
        policy_version_id=excluded.policy_version_id,
        warehouse_id=excluded.warehouse_id,
        dependency_locked=excluded.dependency_locked,
        dependency_reason=excluded.dependency_reason,
        status=case when order_sla_commitments.sla_started_at is null then excluded.status else order_sla_commitments.status end,
        manual_sla_required=excluded.manual_sla_required,
        manual_sla_reasons=excluded.manual_sla_reasons,
        provenance=excluded.provenance,
        estimated_workload_minutes=excluded.estimated_workload_minutes,
        effective_capacity_minutes_per_day=excluded.effective_capacity_minutes_per_day,
        safety_buffer_minutes=excluded.safety_buffer_minutes,
        bottleneck_stage=excluded.bottleneck_stage,
        stage_breakdown=excluded.stage_breakdown,
        capacity_utilization_ratio=excluded.capacity_utilization_ratio,
        capacity_alert_level=excluded.capacity_alert_level,
        current_due_at=case when order_sla_commitments.sla_started_at is null then excluded.current_due_at else order_sla_commitments.current_due_at end,
        updated_by=excluded.updated_by,
        updated_at=now()
      returning *`,
      [
        orderRow.id,
        input.batch_key,
        commitKind,
        policy.id,
        policy.latest_published_version_id ?? null,
        whSnapshot.warehouse_id,
        compareLockActive,
        compareLockActive ? `Service mode ${input.service_mode} / dependency lock active` : null,
        manualSlaRequired ? "manual_review_required" : "pending_start",
        manualSlaRequired,
        JSON.stringify(manualSlaReasons),
        provenance,
        Number(totalWorkloadMinutes.toFixed(2)),
        whSnapshot.effective_daily_capacity_minutes,
        Number(safetyBufferMinutes.toFixed(2)),
        bottleneckStage,
        JSON.stringify(stageBreakdown),
        Number(totalUtilizationRatio.toFixed(4)),
        capacityAlertLevel,
        estimatedDueAt.toISOString(),
        actor.id,
      ],
    );

    await db.query(
      `insert into sla_clock_events (
        commitment_id, order_id, event_type, reason, actor_id, new_due_at, metadata
      ) values ($1,$2,'simulated',$3,$4::uuid,$5,$6::jsonb)`,
      [
        persistedCommitment.id,
        orderRow.id,
        "Calculated dynamic workload & SLA draft",
        actor.id,
        estimatedDueAt.toISOString(),
        JSON.stringify({ provenance, bottleneckStage, capacityAlertLevel }),
      ],
    );
  }

  return {
    policy: {
      id: policy.id,
      policy_code: policy.policy_code,
      status: policy.status,
      current_version: policy.current_version,
      latest_published_version_id: policy.latest_published_version_id ?? null,
    },
    provenance,
    is_draft_uncalibrated: provenance === "estimated_baseline",
    field_calibrated_stages: fieldCalibratedStages,
    empirical_sample_count: empirical.totalFieldSamples,
    warehouse: {
      warehouse_id: whSnapshot.warehouse_id,
      warehouse_code: whSnapshot.warehouse_code,
      timezone: whSnapshot.timezone,
      cutoff_receiving_time: whSnapshot.cutoff_receiving_time,
      shift_source: whSnapshot.shift_source,
      scheduled_shift_count: whSnapshot.scheduled_shift_count,
      active_inspect_workstations: whSnapshot.active_inspect_workstations,
      active_photo_rigs: whSnapshot.active_photo_rigs,
      effective_daily_capacity_minutes: whSnapshot.effective_daily_capacity_minutes,
      effective_inspector_daily_minutes: whSnapshot.effective_inspector_daily_minutes,
      effective_qa_daily_minutes: whSnapshot.effective_qa_daily_minutes,
      effective_workstation_daily_minutes: whSnapshot.effective_workstation_daily_minutes,
      effective_photo_rig_daily_minutes: whSnapshot.effective_photo_rig_daily_minutes,
      open_backlog_minutes: whSnapshot.open_backlog_minutes,
    },
    workload: {
      total_workload_minutes: Number(totalWorkloadMinutes.toFixed(2)),
      active_inspection_minutes: Number(activeInspectionMinutes.toFixed(2)),
      qa_review_minutes: Number(stageQaReview.toFixed(2)),
      async_upload_buffer_minutes: Number(stageUploadTranscode.toFixed(2)),
      safety_buffer_minutes: Number(safetyBufferMinutes.toFixed(2)),
      effective_queue_plus_work_minutes: Number(effectiveQueueAndWorkMinutes.toFixed(2)),
      stage_breakdown: stageBreakdown,
    },
    bottleneck: {
      bottleneck_stage: bottleneckStage,
      inspector_load_ratio: Number(inspectorLoadRatio.toFixed(4)),
      qa_load_ratio: Number(qaLoadRatio.toFixed(4)),
      workstation_load_ratio: Number(workstationLoadRatio.toFixed(4)),
      photo_rig_load_ratio: Number(photoLoadRatio.toFixed(4)),
      total_utilization_ratio: Number(totalUtilizationRatio.toFixed(4)),
      capacity_alert_level: capacityAlertLevel,
    },
    dependencies: {
      dependency_locked: compareLockActive,
      independent_batch_eligible: partialBatchEligible,
      ready_units: readyUnits,
      remaining_units: partialUnitsRemaining,
    },
    sla_decision: {
      manual_sla_required: manualSlaRequired,
      manual_sla_reasons: manualSlaReasons,
      estimated_business_days: Math.ceil(rawDaysNeeded),
      start_at: startAt.toISOString(),
      estimated_due_at: estimatedDueAt.toISOString(),
    },
    commitment: persistedCommitment,
  };
}

async function createCustomerSlaNotification(
  db: DB,
  orderId: string,
  template: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const order = (
    await db.query<{ created_by: string; public_no: string }>(
      "select created_by, public_no from orders where id=$1",
      [orderId],
    )
  ).rows[0];
  if (!order) return null;
  const userLocale = (
    await db.query<{ locale: string | null }>(
      "select coalesce(notification_locale, locale, 'en') as locale from users where id=$1",
      [order.created_by],
    )
  ).rows[0]?.locale ?? "en";

  const inserted = (
    await db.query<{ id: string }>(
      `insert into notifications (user_id, order_id, template, locale, payload, dedupe_key)
       values ($1,$2,$3,$4,$5::jsonb,$6)
       on conflict (dedupe_key) do nothing
       returning id`,
      [
        order.created_by,
        orderId,
        template,
        userLocale,
        JSON.stringify({ public_no: order.public_no, ...payload }),
        dedupeKey,
      ],
    )
  ).rows[0];
  return inserted?.id ?? null;
}

export async function startOrderSlaCommitment(
  db: DB,
  actor: Actor,
  orderId: string,
  rawInput: unknown,
  sessionHash: string = "",
) {
  role(actor, ...CAPACITY_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = startOrderSlaSchema.parse(rawInput);

  await lock(db, `order_sla:${orderId}`);
  const order = await one<Record<string, any>>(db, "select * from orders where id=$1 for update", [orderId]);
  guard(
    !["cancelled", "closed", "draft", "report_ready", "action_pending"].includes(order.state),
    "SLA_GATE_ORDER_STATE",
    `Order in state '${order.state}' is not eligible to start SLA.`,
    409,
  );

  const paidCharge = (
    await db.query<{ id: string }>(
      `select c.id
       from charge_items c
       join inspection_quotes q on q.id = c.inspection_quote_id
       where q.order_id=$1 and c.voided_at is null and (c.applied_payment_id is not null or c.free_authorization is not null)
       limit 1`,
      [orderId],
    )
  ).rows[0];
  const isPaid = Boolean(order.paid_at) || Boolean(paidCharge);
  guard(isPaid, "SLA_GATE_UNPAID", "SLA cannot start before order payment / authorization is confirmed.", 409);

  const openBlocks = (
    await db.query<{ reason: string }>(
      "select reason from order_blocks where order_id=$1 and resolved_at is null",
      [orderId],
    )
  ).rows;
  guard(openBlocks.length === 0, "SLA_GATE_BLOCKED", `SLA blocked by active order blocks: ${openBlocks.map((b) => b.reason).join(", ")}`, 409);

  const existing = (
    await db.query<Record<string, any>>(
      "select * from order_sla_commitments where order_id=$1 and batch_key=$2 for update",
      [orderId, input.batch_key],
    )
  ).rows[0];
  if (existing?.sla_started_at) {
    guard(false, "SLA_ALREADY_STARTED", "sla_started_at is immutable once started and cannot be restarted or overwritten.", 409);
  }

  let preSim: Awaited<ReturnType<typeof calculateWorkloadAndSla>> | null = null;
  if (!existing) {
    preSim = await calculateWorkloadAndSla(
      db,
      actor,
      {
        ...(input.simulation ?? {}),
        order_id: orderId,
        batch_key: input.batch_key,
        persist_commitment: false,
      },
      sessionHash,
    );
  }

  const effectiveDependencyLocked = Boolean(existing?.dependency_locked) || Boolean(preSim?.dependencies.dependency_locked);
  const effectiveKind =
    (existing?.commitment_kind as string | undefined) ??
    (preSim?.dependencies.dependency_locked
      ? input.simulation?.service_mode === "golden_sample"
        ? "golden_group"
        : "compare_group"
      : input.commitment_kind);

  if (effectiveDependencyLocked || effectiveKind === "compare_group" || effectiveKind === "golden_group") {
    guard(input.dependency_group_ready, "SLA_GATE_DEPENDENCY_LOCKED", "Compare/Golden dependency group samples are not all ready; SLA remains locked.", 409);
  }

  const samplesReady = Boolean(order.samples_ready_at) || ["samples_ready", "queued", "inspecting", "qa_review"].includes(order.state);
  if (!samplesReady) {
    guard(
      !effectiveDependencyLocked && input.partial_batch_allowed && effectiveKind === "independent_batch",
      "SLA_GATE_SAMPLES_NOT_READY",
      "SLA cannot start before physical arrival & ownership verification completes (unless an independent non-locked ready batch is explicitly authorized).",
      409,
    );
  }

  let commitment = existing;
  if (!commitment) {
    const simResult = await calculateWorkloadAndSla(
      db,
      actor,
      {
        ...(input.simulation ?? {}),
        order_id: orderId,
        batch_key: input.batch_key,
        persist_commitment: true,
      },
      sessionHash,
    );
    commitment = simResult.commitment!;
  }

  guard(!commitment.manual_sla_required, "MANUAL_SLA_REVIEW_REQUIRED", "Manual SLA confirmation is required before auto-starting this high-load/high-complexity commitment.", 409);

  const now = new Date();
  const targetDue = commitment.current_due_at ? new Date(commitment.current_due_at) : new Date(now.getTime() + 48 * 3600 * 1000);
  const started = await one<Record<string, any>>(db,
    `update order_sla_commitments set
       status='active',
       sla_started_at=coalesce(sla_started_at, now()),
       original_due_at=coalesce(original_due_at, $2),
       current_due_at=coalesce(current_due_at, $2),
       updated_by=$3::uuid,
       updated_at=now()
     where id=$1 returning *`,
    [commitment.id, targetDue.toISOString(), actor.id],
  );

  await db.query("update orders set sla_due_at=coalesce(sla_due_at,$2), updated_at=now() where id=$1", [orderId, started.current_due_at]);

  const notifId = await createCustomerSlaNotification(db, orderId, "sla.started", `sla_started:${started.id}`, {
    commitment_id: started.id,
    batch_key: started.batch_key,
    sla_started_at: started.sla_started_at,
    due_at: started.current_due_at,
  });

  const evRow = await one<Record<string, any>>(db,
    `insert into sla_clock_events (
      commitment_id, order_id, event_type, reason, actor_id, new_due_at, customer_notified, notification_id, metadata
    ) values ($1,$2,'started',$3,$4::uuid,$5,$6,$7,$8::jsonb) returning *`,
    [
      started.id,
      orderId,
      input.reason,
      actor.id,
      started.current_due_at,
      Boolean(notifId),
      notifId,
      JSON.stringify({ batch_key: started.batch_key }),
    ],
  );

  await audit(db, actor, "order_sla_started", "order_sla_commitments", started.id, {
    order_id: orderId,
    batch_key: started.batch_key,
    sla_started_at: started.sla_started_at,
    original_due_at: started.original_due_at,
  });
  await event(db, "order.sla_started", { order_id: orderId, commitment_id: started.id, due_at: started.current_due_at });
  return { commitment: started, event: evRow };
}

export async function pauseOrderSlaCommitment(
  db: DB,
  actor: Actor,
  commitmentId: string,
  rawInput: unknown,
  sessionHash: string = "",
) {
  role(actor, ...CAPACITY_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = slaPauseSchema.parse(rawInput);

  const cur = await one<Record<string, any>>(db, "select * from order_sla_commitments where id=$1 for update", [commitmentId]);
  await lock(db, `order_sla:${cur.order_id}`);
  guard(cur.status === "active" || cur.status === "extended", "SLA_NOT_ACTIVE", "Only active SLA commitments can be paused.", 409);

  const paused = await one<Record<string, any>>(db,
    `update order_sla_commitments set
       status='paused',
       pause_started_at=now(),
       updated_by=$2::uuid,
       updated_at=now()
     where id=$1 returning *`,
    [commitmentId, actor.id],
  );

  const notifId = input.notify_customer
    ? await createCustomerSlaNotification(db, cur.order_id, "sla.paused", `sla_paused:${commitmentId}:${uuid()}`, {
        commitment_id: commitmentId,
        reason: input.reason,
      })
    : null;

  const evRow = await one<Record<string, any>>(db,
    `insert into sla_clock_events (
      commitment_id, order_id, event_type, reason, actor_id, previous_due_at, new_due_at, customer_notified, notification_id
    ) values ($1,$2,'paused',$3,$4::uuid,$5,$5,$6,$7) returning *`,
    [commitmentId, cur.order_id, input.reason, actor.id, paused.current_due_at, Boolean(notifId), notifId],
  );

  await audit(db, actor, "order_sla_paused", "order_sla_commitments", commitmentId, {
    order_id: cur.order_id,
    reason: input.reason,
  });
  return { commitment: paused, event: evRow };
}

export async function resumeOrderSlaCommitment(
  db: DB,
  actor: Actor,
  commitmentId: string,
  rawInput: unknown,
  sessionHash: string = "",
) {
  role(actor, ...CAPACITY_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = slaResumeSchema.parse(rawInput);

  const cur = await one<Record<string, any>>(db, "select * from order_sla_commitments where id=$1 for update", [commitmentId]);
  await lock(db, `order_sla:${cur.order_id}`);
  guard(cur.status === "paused" && cur.pause_started_at, "SLA_NOT_PAUSED", "SLA commitment is not currently paused.", 409);

  const resumed = await one<Record<string, any>>(db,
    `update order_sla_commitments set
       status='active',
       total_paused_seconds = total_paused_seconds + greatest(0, extract(epoch from (now() - pause_started_at))::int),
       current_due_at = case
         when current_due_at is not null then current_due_at + greatest(now() - pause_started_at, interval '0 seconds')
         else current_due_at
       end,
       pause_started_at=null,
       updated_by=$2::uuid,
       updated_at=now()
     where id=$1 returning *, greatest(0, extract(epoch from (now() - $3::timestamptz))::int) as delta_secs`,
    [commitmentId, actor.id, cur.pause_started_at],
  );

  if (resumed.current_due_at) {
    await db.query("update orders set sla_due_at=greatest(coalesce(sla_due_at,$2),$2), updated_at=now() where id=$1", [
      cur.order_id,
      resumed.current_due_at,
    ]);
  }

  const deltaSecs = Math.max(0, Number(resumed.delta_secs ?? 0));
  const notifId = input.notify_customer
    ? await createCustomerSlaNotification(db, cur.order_id, "sla.resumed", `sla_resumed:${commitmentId}:${uuid()}`, {
        commitment_id: commitmentId,
        reason: input.reason,
        new_due_at: resumed.current_due_at,
      })
    : null;

  const evRow = await one<Record<string, any>>(db,
    `insert into sla_clock_events (
      commitment_id, order_id, event_type, reason, actor_id, previous_due_at, new_due_at, paused_delta_seconds, customer_notified, notification_id
    ) values ($1,$2,'resumed',$3,$4::uuid,$5,$6,$7,$8,$9) returning *`,
    [
      commitmentId,
      cur.order_id,
      input.reason,
      actor.id,
      cur.current_due_at,
      resumed.current_due_at,
      deltaSecs,
      Boolean(notifId),
      notifId,
    ],
  );

  await audit(db, actor, "order_sla_resumed", "order_sla_commitments", commitmentId, {
    order_id: cur.order_id,
    reason: input.reason,
    paused_delta_seconds: deltaSecs,
    new_due_at: resumed.current_due_at,
  });
  return { commitment: resumed, event: evRow };
}

export async function extendOrderSlaCommitment(
  db: DB,
  actor: Actor,
  commitmentId: string,
  rawInput: unknown,
  sessionHash: string = "",
) {
  role(actor, ...CAPACITY_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = slaExtendSchema.parse(rawInput);

  const cur = await one<Record<string, any>>(db, "select * from order_sla_commitments where id=$1 for update", [commitmentId]);
  await lock(db, `order_sla:${cur.order_id}`);
  guard(!["cancelled", "met"].includes(cur.status), "SLA_TERMINAL", "Cannot extend a completed or cancelled SLA commitment.", 409);
  guard(cur.status !== "paused", "SLA_PAUSED_RESUME_FIRST", "Resume a paused SLA commitment before extending or adjusting its due date.", 409);

  const newDue = new Date(input.new_due_at);
  if (cur.current_due_at && input.override_type === "extended") {
    guard(newDue.getTime() > new Date(cur.current_due_at).getTime(), "INVALID_SLA_EXTENSION", "New SLA due timestamp must be later than current due timestamp.", 422);
  }

  let canActivateNow = Boolean(cur.sla_started_at);
  if (!canActivateNow) {
    const order = await one<Record<string, any>>(db, "select state, paid_at, samples_ready_at from orders where id=$1 for update", [cur.order_id]);
    const paidCharge = (
      await db.query<{ id: string }>(
        `select c.id
         from charge_items c
         join inspection_quotes q on q.id = c.inspection_quote_id
         where q.order_id=$1 and c.voided_at is null and (c.applied_payment_id is not null or c.free_authorization is not null)
         limit 1`,
        [cur.order_id],
      )
    ).rows[0];
    const openBlocks = (
      await db.query<{ reason: string }>("select reason from order_blocks where order_id=$1 and resolved_at is null limit 1", [cur.order_id])
    ).rowCount ?? 0;
    const isPaid = Boolean(order.paid_at) || Boolean(paidCharge);
    const samplesReady = Boolean(order.samples_ready_at) || ["samples_ready", "queued", "inspecting", "qa_review", "report_ready"].includes(order.state);
    canActivateNow = isPaid && openBlocks === 0 && (samplesReady || cur.commitment_kind === "independent_batch");
  }

  const nextStatus = !canActivateNow
    ? "pending_start"
    : cur.status === "manual_review_required" || cur.status === "pending_start"
      ? "active"
      : input.override_type === "extended"
        ? "extended"
        : cur.status;
  const updated = await one<Record<string, any>>(db,
    `update order_sla_commitments set
       status=$2,
       manual_sla_required=false,
       sla_started_at=case when $6::boolean then coalesce(sla_started_at, now()) else sla_started_at end,
       original_due_at=case when $6::boolean then coalesce(original_due_at, $3) else original_due_at end,
       current_due_at=$3,
       provenance=case when $4='manual_override' then 'manual_override' else provenance end,
       updated_by=$5::uuid,
       updated_at=now()
     where id=$1 returning *`,
    [commitmentId, nextStatus, newDue.toISOString(), input.override_type, actor.id, canActivateNow],
  );

  if (canActivateNow) {
    await db.query("update orders set sla_due_at=$2, updated_at=now() where id=$1", [cur.order_id, updated.current_due_at]);
  }

  const notifId = input.notify_customer
    ? await createCustomerSlaNotification(db, cur.order_id, "sla.extended", `sla_extended:${commitmentId}:${uuid()}`, {
        commitment_id: commitmentId,
        reason: input.reason,
        previous_due_at: cur.current_due_at,
        new_due_at: updated.current_due_at,
      })
    : null;

  const evRow = await one<Record<string, any>>(db,
    `insert into sla_clock_events (
      commitment_id, order_id, event_type, reason, actor_id, previous_due_at, new_due_at, customer_notified, notification_id
    ) values ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9) returning *`,
    [
      commitmentId,
      cur.order_id,
      input.override_type,
      input.reason,
      actor.id,
      cur.current_due_at,
      updated.current_due_at,
      Boolean(notifId),
      notifId,
    ],
  );

  await audit(db, actor, "order_sla_extended", "order_sla_commitments", commitmentId, {
    order_id: cur.order_id,
    reason: input.reason,
    previous_due_at: cur.current_due_at,
    new_due_at: updated.current_due_at,
  });
  return { commitment: updated, event: evRow };
}

export async function getOrderSlaCommitments(db: DB, actor: Actor, orderId: string) {
  role(actor, ...CAPACITY_READ_ROLES);
  await one(db, "select id from orders where id=$1", [orderId]);
  const commitments = (
    await db.query<Record<string, any>>(
      "select * from order_sla_commitments where order_id=$1 order by created_at asc",
      [orderId],
    )
  ).rows;
  const events = (
    await db.query<Record<string, any>>(
      "select * from sla_clock_events where order_id=$1 order by created_at desc limit 100",
      [orderId],
    )
  ).rows;
  return { commitments, events };
}

export async function getWarehouseCapacityDashboard(db: DB, actor: Actor, rawQuery: unknown) {
  role(actor, ...CAPACITY_READ_ROLES);
  const query = warehouseDashboardQuerySchema.parse(rawQuery ?? {});
  const policy = await resolvePolicyForCalculation(db, undefined, query.warehouse_id);
  const snapshot = await loadWarehouseResourceSnapshot(db, query.warehouse_id ?? policy.warehouse_id, policy, query.days);

  const loadRatio = snapshot.open_backlog_minutes / Math.max(60, snapshot.effective_daily_capacity_minutes);
  let alertLevel: "normal" | "warn_70" | "review_85" | "pause_heavy_95" = "normal";
  if (loadRatio >= policy.pause_heavy_intake_pct) alertLevel = "pause_heavy_95";
  else if (loadRatio >= policy.review_utilization_pct) alertLevel = "review_85";
  else if (loadRatio >= policy.warn_utilization_pct) alertLevel = "warn_70";

  const activeCommitments = (
    await db.query<Record<string, any>>(
      `select c.*, o.public_no as order_public_no
       from order_sla_commitments c
       join orders o on o.id = c.order_id
       where ($1::uuid is null or c.warehouse_id = $1::uuid)
       order by c.updated_at desc
       limit 30`,
      [query.warehouse_id ?? null],
    )
  ).rows;

  return {
    policy: {
      id: policy.id,
      policy_code: policy.policy_code,
      status: policy.status,
      model_provenance: policy.model_provenance,
      warn_utilization_pct: policy.warn_utilization_pct,
      review_utilization_pct: policy.review_utilization_pct,
      pause_heavy_intake_pct: policy.pause_heavy_intake_pct,
    },
    warehouse: snapshot,
    current_utilization_ratio: Number(loadRatio.toFixed(4)),
    current_alert_level: alertLevel,
    commitments: activeCommitments,
  };
}

export async function syncOrderSlaOnHold(db: DB, actor: Actor, orderId: string, reason: string) {
  const { rows } = await db.query<Record<string, any>>(
    `select * from order_sla_commitments
     where order_id=$1 and status in ('active','extended') for update`,
    [orderId],
  );
  if (rows.length === 0) return { updated: 0 };

  for (const row of rows) {
    await db.query(
      `update order_sla_commitments set
         status='paused',
         pause_started_at=now(),
         updated_by=$2::uuid,
         updated_at=now()
       where id=$1`,
      [row.id, actor.id],
    );
    const notifId = await createCustomerSlaNotification(db, orderId, "sla.paused", `sla_hold:${row.id}:${uuid()}`, {
      commitment_id: row.id,
      reason,
    });
    await db.query(
      `insert into sla_clock_events (
        commitment_id, order_id, event_type, reason, actor_id, previous_due_at, new_due_at, customer_notified, notification_id
      ) values ($1,$2,'paused',$3,$4::uuid,$5,$5,$6,$7)`,
      [row.id, orderId, `Order held: ${reason}`, actor.id, row.current_due_at, Boolean(notifId), notifId],
    );
  }
  return { updated: rows.length };
}

export async function syncOrderSlaOnResume(db: DB, actor: Actor, orderId: string, reason: string, pauseDeltaExprSql?: string) {
  const { rows } = await db.query<Record<string, any>>(
    `select * from order_sla_commitments
     where order_id=$1 and status='paused' and pause_started_at is not null for update`,
    [orderId],
  );
  if (rows.length === 0) return { updated: 0 };

  for (const row of rows) {
    const resumed = await one<Record<string, any>>(db,
      `update order_sla_commitments set
         status='active',
         total_paused_seconds = total_paused_seconds + greatest(0, extract(epoch from (now() - pause_started_at))::int),
         current_due_at = case
           when current_due_at is not null then current_due_at + greatest(now() - pause_started_at, interval '0 seconds')
           else current_due_at
         end,
         pause_started_at=null,
         updated_by=$2::uuid,
         updated_at=now()
       where id=$1 returning *, greatest(0, extract(epoch from (now() - $3::timestamptz))::int) as delta_secs`,
      [row.id, actor.id, row.pause_started_at],
    );
    const deltaSecs = Math.max(0, Number(resumed.delta_secs ?? 0));
    const notifId = await createCustomerSlaNotification(db, orderId, "sla.resumed", `sla_unhold:${row.id}:${uuid()}`, {
      commitment_id: row.id,
      reason,
      new_due_at: resumed.current_due_at,
    });
    await db.query(
      `insert into sla_clock_events (
        commitment_id, order_id, event_type, reason, actor_id, previous_due_at, new_due_at, paused_delta_seconds, customer_notified, notification_id, metadata
      ) values ($1,$2,'resumed',$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        row.id,
        orderId,
        `Order resumed: ${reason}`,
        actor.id,
        row.current_due_at,
        resumed.current_due_at,
        deltaSecs,
        Boolean(notifId),
        notifId,
        JSON.stringify({ source: pauseDeltaExprSql ?? "hold_resume_hook" }),
      ],
    );
  }
  return { updated: rows.length };
}

export async function syncOrderSlaOnCancel(db: DB, actor: Actor, orderId: string, reason: string) {
  const { rows } = await db.query<Record<string, any>>(
    `select * from order_sla_commitments
     where order_id=$1 and status not in ('cancelled','met') for update`,
    [orderId],
  );
  if (rows.length === 0) return { updated: 0 };

  for (const row of rows) {
    await db.query(
      `update order_sla_commitments set
         status='cancelled',
         pause_started_at=null,
         updated_by=$2::uuid,
         updated_at=now()
       where id=$1`,
      [row.id, actor.id],
    );
    await db.query(
      `insert into sla_clock_events (
        commitment_id, order_id, event_type, reason, actor_id, previous_due_at, new_due_at
      ) values ($1,$2,'cancelled',$3,$4::uuid,$5,$5)`,
      [row.id, orderId, reason, actor.id, row.current_due_at],
    );
  }
  return { updated: rows.length };
}
