import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, lock, role, type Actor } from "./common";

export const LABOR_COST_SEED_VERSION = "2026-11-labor-cost-v1";

export const SEED_LABOR_BASELINES = [
  {
    activity_code: "order_prep",
    complexity_code: "ALL",
    unit_label: "order",
    estimated_min_minutes: 5,
    estimated_max_minutes: 15,
    default_assumption_minutes: 8,
    notes_zh: "订单核对、规格准备与工单下发（§43.3 暂估基线）",
    notes_en: "Order checklist preparation & work-item staging (§43.3 draft baseline).",
  },
  {
    activity_code: "parcel_intake",
    complexity_code: "ALL",
    unit_label: "parcel",
    estimated_min_minutes: 2,
    estimated_max_minutes: 5,
    default_assumption_minutes: 3.5,
    notes_zh: "运单扫描/外箱检查/拍照入库（§43.3 暂估 2–5 分钟/包裹）",
    notes_en: "Waybill scan, outer carton inspection & intake photo (draft 2-5 min/parcel).",
  },
  {
    activity_code: "unbox_count",
    complexity_code: "ALL",
    unit_label: "parcel",
    estimated_min_minutes: 3,
    estimated_max_minutes: 8,
    default_assumption_minutes: 5,
    notes_zh: "拆包与实物清点（§43.3 暂估 3–8+ 分钟/包裹）",
    notes_en: "Unboxing & physical count verification (draft 3-8+ min/parcel).",
  },
  {
    activity_code: "sku_label",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 1,
    estimated_max_minutes: 3,
    default_assumption_minutes: 2,
    notes_zh: "SKU 核身、绑定及打印贴标（§43.3 暂估 1–3 分钟/件）",
    notes_en: "SKU identification & thermal barcode labeling (draft 1-3 min/pc).",
  },
  {
    activity_code: "garment_prep",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 1,
    estimated_max_minutes: 4,
    default_assumption_minutes: 2,
    notes_zh: "拆袋、整理、自然平铺（§43.3 暂估 1–4 分钟/件）",
    notes_en: "De-bagging, smoothing & flat layout prep (draft 1-4 min/pc).",
  },
  {
    activity_code: "visual_inspect",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 3,
    estimated_max_minutes: 20,
    default_assumption_minutes: 7.5,
    notes_zh: "服装外观检查综合暂估区间（L1 3–6m 至 L3+ 8–20+m）",
    notes_en: "General apparel visual inspection range across complexities (draft 3-20+ min/pc).",
  },
  {
    activity_code: "visual_inspect",
    complexity_code: "L1",
    unit_label: "piece",
    estimated_min_minutes: 3,
    estimated_max_minutes: 6,
    default_assumption_minutes: 4.5,
    notes_zh: "基础服装外观实际检查（§43.3 暂估 3–6 分钟/件）",
    notes_en: "Basic garment visual inspection excluding add-ons (draft 3-6 min/pc).",
  },
  {
    activity_code: "visual_inspect",
    complexity_code: "L2",
    unit_label: "piece",
    estimated_min_minutes: 5,
    estimated_max_minutes: 9,
    default_assumption_minutes: 7,
    notes_zh: "常规服装外观实际检查（§43.3 暂估 5–9 分钟/件）",
    notes_en: "Regular garment visual inspection excluding add-ons (draft 5-9 min/pc).",
  },
  {
    activity_code: "visual_inspect",
    complexity_code: "L3",
    unit_label: "piece",
    estimated_min_minutes: 8,
    estimated_max_minutes: 20,
    default_assumption_minutes: 12,
    notes_zh: "复杂服装外观实际检查（§43.3 暂估 8–20+ 分钟/件）",
    notes_en: "Complex garment visual inspection (draft 8-20+ min/pc).",
  },
  {
    activity_code: "visual_inspect",
    complexity_code: "L4",
    unit_label: "piece",
    estimated_min_minutes: 12,
    estimated_max_minutes: 25,
    default_assumption_minutes: 16,
    notes_zh: "高复杂度外套/羽绒服外观检查（§43.3 暂估 12–25+ 分钟/件）",
    notes_en: "High-complexity outerwear/down garment visual inspection (draft 12-25+ min/pc).",
  },
  {
    activity_code: "measurement_point",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 6,
    estimated_max_minutes: 28,
    default_assumption_minutes: 13,
    notes_zh: "3/5/8点尺寸测量含录入及复测（§43.3 暂估 6-12 / 10-18 / 15-28+ 分钟）",
    notes_en: "POM 3/5/8-point measuring incl. remeasure (draft 6-12/10-18/15-28+ min).",
  },
  {
    activity_code: "photo_capture",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 3,
    estimated_max_minutes: 8,
    default_assumption_minutes: 5,
    notes_zh: "标准整体及细节摄影（§43.3 暂估 3–8 分钟/件）",
    notes_en: "Standard overview & detail photography (draft 3-8 min/pc).",
  },
  {
    activity_code: "exception_log",
    complexity_code: "ALL",
    unit_label: "issue",
    estimated_min_minutes: 1.5,
    estimated_max_minutes: 4,
    default_assumption_minutes: 2.5,
    notes_zh: "缺陷拍摄、框选标注与记录（§43.3 暂估 1.5–4 分钟/处）",
    notes_en: "Defect photography, annotation & logging (draft 1.5-4 min/defect).",
  },
  {
    activity_code: "video_capture",
    complexity_code: "ALL",
    unit_label: "clip",
    estimated_min_minutes: 3,
    estimated_max_minutes: 8,
    default_assumption_minutes: 5.5,
    notes_zh: "30–60秒视频准备/录制/预览（§43.3 暂估 3–8 分钟/段）",
    notes_en: "30-60s video prep, recording & preview (draft 3-8 min/clip).",
  },
  {
    activity_code: "video_retake",
    complexity_code: "ALL",
    unit_label: "clip",
    estimated_min_minutes: 1,
    estimated_max_minutes: 5,
    default_assumption_minutes: 3,
    notes_zh: "视频必要重拍（§43.3 暂估额外 1–5+ 分钟/段）",
    notes_en: "Necessary video retake (draft extra 1-5+ min/clip).",
  },
  {
    activity_code: "module_inspect",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 5,
    estimated_max_minutes: 15,
    default_assumption_minutes: 9,
    notes_zh: "确认样对照或专项模块检查（§43.3 暂估 5–15 分钟/件）",
    notes_en: "Golden sample comparison or specialized module audit (draft 5-15 min/pc).",
  },
  {
    activity_code: "qa_review",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 2,
    estimated_max_minutes: 6,
    default_assumption_minutes: 4,
    notes_zh: "QA 证据与测量数据逐件复核（§43.3 暂估 2–6+ 分钟/件）",
    notes_en: "QA evidence & measurement data audit (draft 2-6+ min/pc).",
  },
  {
    activity_code: "report_compile",
    complexity_code: "ALL",
    unit_label: "order",
    estimated_min_minutes: 5,
    estimated_max_minutes: 20,
    default_assumption_minutes: 10,
    notes_zh: "自动报告生成后的人工发布核查（§43.3 暂估 5–20+ 分钟/单）",
    notes_en: "Human pre-publish inspection of compiled report (draft 5-20+ min/order).",
  },
  {
    activity_code: "repack_putaway",
    complexity_code: "ALL",
    unit_label: "piece",
    estimated_min_minutes: 1,
    estimated_max_minutes: 4,
    default_assumption_minutes: 2.5,
    notes_zh: "复包、分拣与重新上架（§43.3 暂估 1–4 分钟/件）",
    notes_en: "Repacking, sorting & bin putaway (draft 1-4 min/pc).",
  },
] as const;

export const SEED_COST_MODEL = {
  code: "standard_apparel_cost_v1",
  name_zh: "服装全成本及贡献毛利沙盘基线（暂估草稿）",
  name_en: "Apparel Full-Cost & Contribution Margin Model (Estimated Draft)",
  description_zh:
    "按 §43.3 综合工时、QA复核、返工准备金、器材折旧、耗材、媒体存储/带宽/转码、AI翻译、固定分摊及支付手续费建立的沙盘基线；管理成本默认已含于综合时薪（禁止重复加计）。",
  description_en:
    "Estimated sandbox baseline per §43.3 covering burdened labor, QA, rework reserve, equipment, consumables, media storage/bandwidth/transcode, AI, fixed allocation & payment fees. Management overhead included in burdened hourly rate by default.",
  currency: "USD" as const,
  labor_hourly_rate_cents: 1500, // $15/hr burdened inspector labor (sandbox USD equivalent)
  qa_hourly_rate_cents: 2000, // $20/hr burdened QA reviewer labor
  management_overhead_included_in_labor: true,
  management_overhead_pct: 0,
  warehouse_fixed_monthly_cents: 450_000, // $4,500/month
  expected_monthly_orders: 300, // $15/order fixed allocation
  equipment_depreciation_per_order_cents: 80,
  camera_lighting_per_item_cents: 15,
  barcode_label_per_item_cents: 10,
  packaging_consumable_per_item_cents: 35,
  storage_gb_month_cents: 12,
  bandwidth_gb_cents: 10,
  video_transcode_per_min_cents: 2,
  ai_estimated_per_order_cents: 25,
  domestic_logistics_handling_per_order_cents: 50,
  payment_fixed_fee_cents: 30,
  payment_fee_rate_bps: 340, // 3.4%
  other_variable_revenue_rate_bps: 0,
  rework_reserve_rate_bps: 300, // 3%
  support_cost_per_order_cents: 150,
  target_contribution_margin_bps: 2500, // 25% target contribution margin
  tax_policy_note: "Net of pass-through shipping & payment fees; external tax excluded",
  default_defect_rate_bps: 800,
  default_rework_rate_bps: 400,
  default_avg_mb_per_item: 12,
  fx_cny_per_usd: 7.2,
  fx_source: "manual_sandbox_baseline",
  data_source: "estimated_baseline" as const,
};

export async function initializeLaborAndCostDefaults(db: DB, actor: Actor, sessionHash: string) {
  role(actor, "super_admin", "finance");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "labor_cost:seed_init");

  let baselinesInserted = 0;
  let baselinesSkipped = 0;
  for (const b of SEED_LABOR_BASELINES) {
    const res = await db.query(
      `insert into labor_baseline_assumptions (
        activity_code, complexity_code, unit_label,
        estimated_min_minutes, estimated_max_minutes, default_assumption_minutes,
        data_source, sample_size, notes_zh, notes_en, updated_by
      ) values (
        $1, $2, $3, $4, $5, $6, 'estimated_baseline', 0, $7, $8, $9::uuid
      ) on conflict (activity_code, complexity_code) do nothing`,
      [
        b.activity_code,
        b.complexity_code,
        b.unit_label,
        b.estimated_min_minutes,
        b.estimated_max_minutes,
        b.default_assumption_minutes,
        b.notes_zh,
        b.notes_en,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) baselinesInserted += 1;
    else baselinesSkipped += 1;
  }

  const m = SEED_COST_MODEL;
  const modelRes = await db.query(
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
      status, publication_scope, business_approved, is_seed_default, admin_modified, created_by
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
      $28, $29, $30, $31, $32, $33, $34,
      'draft', 'sandbox_acceptance', false, true, false, $35::uuid
    ) on conflict (code) do nothing`,
    [
      m.code,
      m.name_zh,
      m.name_en,
      m.description_zh,
      m.description_en,
      m.currency,
      m.labor_hourly_rate_cents,
      m.qa_hourly_rate_cents,
      m.management_overhead_included_in_labor,
      m.management_overhead_pct,
      m.warehouse_fixed_monthly_cents,
      m.expected_monthly_orders,
      m.equipment_depreciation_per_order_cents,
      m.camera_lighting_per_item_cents,
      m.barcode_label_per_item_cents,
      m.packaging_consumable_per_item_cents,
      m.storage_gb_month_cents,
      m.bandwidth_gb_cents,
      m.video_transcode_per_min_cents,
      m.ai_estimated_per_order_cents,
      m.domestic_logistics_handling_per_order_cents,
      m.payment_fixed_fee_cents,
      m.payment_fee_rate_bps,
      m.other_variable_revenue_rate_bps,
      m.rework_reserve_rate_bps,
      m.support_cost_per_order_cents,
      m.target_contribution_margin_bps,
      m.tax_policy_note,
      m.default_defect_rate_bps,
      m.default_rework_rate_bps,
      m.default_avg_mb_per_item,
      m.fx_cny_per_usd,
      m.fx_source,
      m.data_source,
      actor.id,
    ],
  );
  const modelsInserted = (modelRes.rowCount ?? 0) > 0 ? 1 : 0;
  const modelsSkipped = modelsInserted === 0 ? 1 : 0;

  const insertedCounts = { labor_baselines: baselinesInserted, cost_models: modelsInserted };
  const skippedCounts = { labor_baselines: baselinesSkipped, cost_models: modelsSkipped };

  const runRow = (
    await db.query<{ id: string }>(
      `insert into labor_cost_seed_runs (seed_version, actor_id, inserted_counts, skipped_existing_counts)
       values ($1, $2::uuid, $3::jsonb, $4::jsonb) returning id`,
      [LABOR_COST_SEED_VERSION, actor.id, JSON.stringify(insertedCounts), JSON.stringify(skippedCounts)],
    )
  ).rows[0]!;
  await audit(db, actor, "labor_cost_seed_init", "labor_cost_seed_runs", runRow.id, {
    seed_version: LABOR_COST_SEED_VERSION,
    inserted_counts: insertedCounts,
    skipped_existing_counts: skippedCounts,
  });

  return {
    seed_version: LABOR_COST_SEED_VERSION,
    inserted_counts: insertedCounts,
    skipped_existing_counts: skippedCounts,
  };
}
