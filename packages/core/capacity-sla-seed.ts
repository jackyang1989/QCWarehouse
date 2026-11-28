import { hash, type Actor } from "./common";
import { audit, lock, role } from "./common";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";

export const CAPACITY_SLA_SEED_VERSION = "2026-11-capacity-sla-v1";

export const DEFAULT_COMPLEXITY_PROFILES = {
  L1: {
    label_zh: "L1 基础简款（T恤/短裤/简单配饰）",
    label_en: "L1 Basic Apparel (Tees / Shorts / Simple)",
    visual_min_per_unit: 4.5,
    prep_min_per_unit: 1.5,
    repack_min_per_unit: 1.5,
    qa_min_per_unit: 1.0,
    rework_factor: 0.05,
    required_skill_level: 1,
    requires_calibrated_scale: false,
  },
  L2: {
    label_zh: "L2 常规服饰（衬衫/卫衣/长裤）",
    label_en: "L2 Regular Apparel (Shirts / Hoodies / Trousers)",
    visual_min_per_unit: 7.0,
    prep_min_per_unit: 2.0,
    repack_min_per_unit: 2.0,
    qa_min_per_unit: 1.5,
    rework_factor: 0.08,
    required_skill_level: 2,
    requires_calibrated_scale: false,
  },
  L3: {
    label_zh: "L3 复杂结构（多口袋工装/西装/夹克）",
    label_en: "L3 Complex Garment (Multi-pocket / Tailored / Jacket)",
    visual_min_per_unit: 12.0,
    prep_min_per_unit: 3.0,
    repack_min_per_unit: 2.5,
    qa_min_per_unit: 2.5,
    rework_factor: 0.12,
    required_skill_level: 3,
    requires_calibrated_scale: true,
  },
  L4: {
    label_zh: "L4 高密工艺（羽绒/防水压胶/礼服/复杂箱包）",
    label_en: "L4 Heavy Craft (Down / Seam-sealed / Structured Bags)",
    visual_min_per_unit: 18.0,
    prep_min_per_unit: 4.0,
    repack_min_per_unit: 3.5,
    qa_min_per_unit: 4.0,
    rework_factor: 0.18,
    required_skill_level: 4,
    requires_calibrated_scale: true,
  },
  L5: {
    label_zh: "L5 专项定制/高精度（需人工复核交期）",
    label_en: "L5 Custom High-Spec (Mandatory Manual SLA Review)",
    visual_min_per_unit: 26.0,
    prep_min_per_unit: 5.5,
    repack_min_per_unit: 4.5,
    qa_min_per_unit: 6.0,
    rework_factor: 0.25,
    required_skill_level: 5,
    requires_calibrated_scale: true,
  },
} as const;

export const DEFAULT_MODULE_WORKLOAD_PROFILES = {
  M01: { extra_min_per_unit: 2.0, order_setup_minutes: 3, bottleneck_resource: "inspector", independent_batch_eligible: true, name_zh: "基础外观与做工", name_en: "Visual & Workmanship" },
  M02: { extra_min_per_unit: 3.5, order_setup_minutes: 4, bottleneck_resource: "measurement_bench", independent_batch_eligible: true, name_zh: "标准尺寸测量（5点）", name_en: "5-Point Measurements" },
  M03: { extra_min_per_unit: 7.0, order_setup_minutes: 6, bottleneck_resource: "measurement_bench", independent_batch_eligible: true, name_zh: "全尺寸高密测量", name_en: "Full Extended Measurements" },
  M04: { extra_min_per_unit: 2.5, order_setup_minutes: 3, bottleneck_resource: "inspector", independent_batch_eligible: true, name_zh: "克重/面料纹理核验", name_en: "Fabric & GSM Check" },
  M05: { extra_min_per_unit: 2.0, order_setup_minutes: 2, bottleneck_resource: "inspector", independent_batch_eligible: true, name_zh: "洗唛/吊牌/辅料核对", name_en: "Labels & Trims" },
  M06: { extra_min_per_unit: 3.0, order_setup_minutes: 5, bottleneck_resource: "inspector", independent_batch_eligible: true, name_zh: "功能/拉链/牢度测试", name_en: "Hardware & Functional Test" },
  M07: { extra_min_per_unit: 2.5, order_setup_minutes: 4, bottleneck_resource: "photo_rig", independent_batch_eligible: true, name_zh: "包装/条码/合规检查", name_en: "Packaging & Barcode Audit" },
  M08: { extra_min_per_unit: 3.5, order_setup_minutes: 5, bottleneck_resource: "photo_rig", independent_batch_eligible: true, name_zh: "高清平铺/细节精拍", name_en: "HD Detail Photo Rig" },
  M09: { extra_min_per_unit: 5.0, order_setup_minutes: 8, bottleneck_resource: "photo_rig", independent_batch_eligible: true, name_zh: "动态实操短视频拍摄", name_en: "Operation Video Capture" },
  M10: { extra_min_per_unit: 4.5, order_setup_minutes: 12, bottleneck_resource: "qa", independent_batch_eligible: false, name_zh: "2-3件同组横向对比（锁组同出）", name_en: "Horizontal Compare (Group Locked)" },
  M11: { extra_min_per_unit: 4.0, order_setup_minutes: 10, bottleneck_resource: "qa", independent_batch_eligible: false, name_zh: "确认样/Golden对照（依赖锁组）", name_en: "Golden Sample Reference Match" },
} as const;

export const DEFAULT_SERVICE_MODE_RULES = {
  batch_standard: {
    independent_batch_allowed: true,
    dependency_lock: false,
    group_setup_minutes: 5,
    qa_multiplier: 1.0,
    golden_call_minutes: 0,
  },
  compare_horizontal: {
    independent_batch_allowed: false,
    dependency_lock: true,
    group_setup_minutes: 14,
    qa_multiplier: 1.25,
    golden_call_minutes: 4,
  },
  golden_sample: {
    independent_batch_allowed: false,
    dependency_lock: true,
    group_setup_minutes: 12,
    qa_multiplier: 1.2,
    golden_call_minutes: 6,
  },
} as const;

export const DEFAULT_STAGE_WEIGHTS = {
  order_prep: 1.0,
  intake_unbox: 1.0,
  inspection_measure: 1.0,
  photo_video_capture: 1.0,
  upload_transcode: 1.0,
  qa_review: 1.0,
  repack_outbound: 1.0,
} as const;

export const SEED_CAPACITY_SLA_POLICY = {
  policy_code: "CAP_SLA_APPAREL_SANDBOX_V1",
  name_zh: "服装仓标准产能与动态交期暂估策略 v1（未实测草稿）",
  name_en: "Apparel Warehouse Dynamic Capacity & SLA Policy v1 (Draft Baseline)",
  description_zh: "依据 §11 与 §58 建模：综合复杂度、模块、测量/拍摄密度、横向对比/确认样依赖锁定、班次扣减、QA/拍摄机位瓶颈与 70%/85%/95% 负荷告警。未完成真实实测前仅作沙盘草稿。",
  description_en: "Models §11 & §58 dynamic workload, shift deductions, workstation/QA bottlenecks, safety buffers and 70/85/95% utilization gates.",
  model_provenance: "estimated_baseline" as const,
  effective_inspector_utilization: 0.78,
  effective_qa_utilization: 0.8,
  default_daily_inspector_minutes: 1440,
  default_daily_qa_minutes: 480,
  default_workstation_slots: 4,
  default_photo_rig_slots: 2,
  daily_break_minutes_per_shift: 45,
  daily_prep_minutes_per_shift: 20,
  task_switch_overhead_minutes: 4.5,
  qa_bottleneck_ratio: 1.25,
  upload_queue_buffer_minutes: 15,
  base_rework_rate: 0.08,
  safety_buffer_pct: 0.15,
  safety_buffer_min_minutes: 60,
  warn_utilization_pct: 0.7,
  review_utilization_pct: 0.85,
  pause_heavy_intake_pct: 0.95,
  manual_quote_workload_minutes: 720,
  manual_quote_min_items: 30,
};

export async function initializeCapacitySlaDefaults(db: DB, actor: Actor, sessionHash: string) {
  role(actor, "super_admin", "warehouse_admin", "finance");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "capacity_sla_seed");

  const s = SEED_CAPACITY_SLA_POLICY;
  const res = await db.query<{ id: string }>(
    `insert into capacity_sla_policies (
      policy_code, name_zh, name_en, description_zh, description_en,
      status, current_version, model_provenance,
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
      $1,$2,$3,$4,$5,
      'draft',1,$6,
      $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
      $26::jsonb,$27::jsonb,$28::jsonb,$29::jsonb,
      true,false,$30::uuid
    ) on conflict (policy_code) do nothing
    returning id`,
    [
      s.policy_code,
      s.name_zh,
      s.name_en,
      s.description_zh,
      s.description_en,
      s.model_provenance,
      s.effective_inspector_utilization,
      s.effective_qa_utilization,
      s.default_daily_inspector_minutes,
      s.default_daily_qa_minutes,
      s.default_workstation_slots,
      s.default_photo_rig_slots,
      s.daily_break_minutes_per_shift,
      s.daily_prep_minutes_per_shift,
      s.task_switch_overhead_minutes,
      s.qa_bottleneck_ratio,
      s.upload_queue_buffer_minutes,
      s.base_rework_rate,
      s.safety_buffer_pct,
      s.safety_buffer_min_minutes,
      s.warn_utilization_pct,
      s.review_utilization_pct,
      s.pause_heavy_intake_pct,
      s.manual_quote_workload_minutes,
      s.manual_quote_min_items,
      JSON.stringify(DEFAULT_COMPLEXITY_PROFILES),
      JSON.stringify(DEFAULT_MODULE_WORKLOAD_PROFILES),
      JSON.stringify(DEFAULT_SERVICE_MODE_RULES),
      JSON.stringify(DEFAULT_STAGE_WEIGHTS),
      actor.id,
    ],
  );

  const inserted = (res.rowCount ?? 0) > 0 ? 1 : 0;
  const skipped = inserted === 0 ? 1 : 0;
  const checksum = hash(
    JSON.stringify({
      version: CAPACITY_SLA_SEED_VERSION,
      policy: s,
      DEFAULT_COMPLEXITY_PROFILES,
      DEFAULT_MODULE_WORKLOAD_PROFILES,
      DEFAULT_SERVICE_MODE_RULES,
      DEFAULT_STAGE_WEIGHTS,
    }),
  );

  const runRow = (
    await db.query<{ id: string }>(
      `insert into capacity_seed_runs (seed_version, checksum, seeded_policies, actor_id)
       values ($1, $2, $3, $4::uuid) returning id`,
      [CAPACITY_SLA_SEED_VERSION, checksum, inserted, actor.id],
    )
  ).rows[0]!;

  await audit(db, actor, "capacity_sla_seed_init", "capacity_seed_runs", runRow.id, {
    seed_version: CAPACITY_SLA_SEED_VERSION,
    checksum,
    inserted_policies: inserted,
    skipped_policies: skipped,
  });

  return {
    seed_version: CAPACITY_SLA_SEED_VERSION,
    checksum,
    inserted_counts: { policies: inserted },
    skipped_existing_counts: { policies: skipped },
  };
}
