import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, lock, role, type Actor } from "./common";

export const PRICING_SEED_VERSION = "2026-11-pricing-v1";

export const SEED_PRICING_BOOK = {
  code: "apparel_modular_usd",
  name_zh: "服装模块化标准定价簿（隔离验收草稿）",
  name_en: "Apparel Modular Pricing Schedule (Sandbox Verification Draft)",
  description_zh:
    "按服装结构复杂度与可选检测模块分项透明计价，支持基础核验、尺寸测量、颜色/面料深度检查及比对/确认样服务，默认关闭自动批量折扣。",
  description_en:
    "Modular apparel pricing separated by base garment complexity, selectable inspection add-ons, and comparison/golden-sample services (auto volume discounts disabled by default).",
  currency: "USD" as const,
  rounding_mode: "ceil" as const,
  auto_volume_discount_enabled: false,
  volume_discount_justification: null as string | null,
  minimum_order_cents: 0,
  order_fixed_fee_cents: 0,
  max_online_quantity: 300,
  max_online_total_cents: 5_000_000,
  quote_validity_hours: 72,
  complexity_rates: {
    L1: {
      code: "L1",
      name_zh: "L1 基础复杂度",
      name_en: "L1 Basic Complexity",
      unit_cents: 500,
      billing_unit: "per_piece",
      manual_quote: false,
      note_zh: "T恤、背心、短裤、瑜伽裤等基础单件结构（建议草稿 $5/件）",
      note_en: "Basic garments e.g. tee, tank, shorts, leggings (draft $5/pc).",
    },
    L2: {
      code: "L2",
      name_zh: "L2 常规复杂度",
      name_en: "L2 Regular Complexity",
      unit_cents: 800,
      billing_unit: "per_piece",
      manual_quote: false,
      note_zh: "Polo、衬衫、休闲长裤、牛仔裤、连帽卫衣等（建议草稿 $8/件）",
      note_en: "Polo, shirt, casual pants, jeans, hoodie (draft $8/pc).",
    },
    L3: {
      code: "L3",
      name_zh: "L3 中高复杂度",
      name_en: "L3 Mid-High Complexity",
      unit_cents: 1200,
      billing_unit: "per_piece",
      manual_quote: false,
      note_zh: "薄夹克、西装外套、百褶裙、两件套/运动套装等（建议草稿 $12/件或套）",
      note_en: "Light jacket, blazer, pleated skirt, two-piece/tracksuit set (draft $12/unit).",
    },
    L4: {
      code: "L4",
      name_zh: "L4 高复杂度",
      name_en: "L4 High Complexity",
      unit_cents: 1800,
      billing_unit: "per_piece",
      manual_quote: false,
      note_zh: "羽绒服、棉服、厚大衣、多层冲锋衣、多件组合（建议草稿 $18/件或套）",
      note_en: "Down jacket, padded coat, overcoat, multi-layer shell (draft $18/unit).",
    },
    L5: {
      code: "L5",
      name_zh: "L5 特殊/重工（人工报价）",
      name_en: "L5 Special Craft (Manual Quote)",
      unit_cents: null,
      billing_unit: "manual_quote",
      manual_quote: true,
      note_zh: "婚纱、晚礼服、重工满绣/钉珠、真丝/真皮等须工单人工核价",
      note_en: "Formal gown, wedding dress, heavy embroidery, silk/leather — requires manual quote.",
    },
  },
  module_rates: {
    M01: {
      code: "M01",
      name_zh: "基础核验与外观检查",
      name_en: "Base Verification & Visual Inspection",
      included_in_base: true,
      billing_unit: "per_piece",
      default_option: "standard",
      requires: [],
      mutually_exclusive_with: [],
      options: {
        standard: { label_zh: "含于基础复杂度定价", label_en: "Included in Base Rate", unit_cents: 0, manual_quote: false },
      },
    },
    M02: {
      code: "M02",
      name_zh: "尺寸测量 (POM)",
      name_en: "POM Dimension Measurement",
      included_in_base: false,
      billing_unit: "per_piece",
      default_option: "points_5",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        points_3: { label_zh: "基础 3 点测量", label_en: "Basic 3-Point POM", unit_cents: 800, manual_quote: false },
        points_5: { label_zh: "标准 5 点测量", label_en: "Standard 5-Point POM", unit_cents: 1200, manual_quote: false },
        points_8: { label_zh: "完整 8 点测量", label_en: "Extended 8-Point POM", unit_cents: 1800, manual_quote: false },
        extra_point: { label_zh: "每加测 1 点", label_en: "Per Extra POM Point", unit_cents: 300, billing_unit: "per_measurement_point", manual_quote: false },
      },
    },
    M03: {
      code: "M03",
      name_zh: "颜色检查",
      name_en: "Color & Shade Assessment",
      included_in_base: false,
      billing_unit: "per_piece",
      default_option: "standard",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        standard: { label_zh: "标准光源目视与参考色卡/同批比对", label_en: "Daylight Visual & Swatch Color Check", unit_cents: 500, manual_quote: false },
      },
    },
    M04: {
      code: "M04",
      name_zh: "面料与做工深度检查",
      name_en: "Fabric Feel, Trim & Stitching Deep Check",
      included_in_base: false,
      billing_unit: "per_piece",
      default_option: "standard",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        standard: { label_zh: "面料外观手感/线头/对称/止口深检", label_en: "Fabric Handfeel, Seam & Stitch Deep Audit", unit_cents: 700, manual_quote: false },
      },
    },
    M05: {
      code: "M05",
      name_zh: "重量与克重检查",
      name_en: "Garment Weight / Destructive GSM",
      included_in_base: false,
      billing_unit: "per_piece",
      default_option: "garment_weight",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        garment_weight: { label_zh: "整衣高精度称重（无损）", label_en: "Finished Garment Weight (Non-Destructive)", unit_cents: 200, manual_quote: false },
        fabric_gsm_destructive: {
          label_zh: "标准圆盘取样测面料克重 (GSM · 需客户破样授权)",
          label_en: "Fabric GSM Circular Cut Test (Destructive · Auth Required)",
          unit_cents: 1200,
          requires_destructive_auth: true,
          manual_quote: false,
        },
      },
    },
    M06: {
      code: "M06",
      name_zh: "五金及功能测试",
      name_en: "Hardware & Functional Mechanics Test",
      included_in_base: false,
      billing_unit: "per_test_group",
      default_option: "standard",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        standard: { label_zh: "拉链开合/按扣拉力/调节扣功能组", label_en: "Zipper/Snap/Hardware Function Test Group", unit_cents: 500, manual_quote: false },
        trim_item: { label_zh: "辅料逐件外观与缝固检查", label_en: "Trims & Fastener Per-Piece Audit", unit_cents: 500, billing_unit: "per_piece", manual_quote: false },
      },
    },
    M07: {
      code: "M07",
      name_zh: "标识标签、印花及刺绣",
      name_en: "Labels, Print & Embroidery Verification",
      included_in_base: false,
      billing_unit: "per_piece",
      default_option: "label_verification",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        label_verification: { label_zh: "主标/洗水唛/尺码标核对（非实验室成分鉴定）", label_en: "Care/Brand/Size Label Check", unit_cents: 400, manual_quote: false },
        print_embroidery: { label_zh: "印花清晰度/绣花密度/对位检查", label_en: "Print & Embroidery Alignment Inspection", unit_cents: 500, manual_quote: false },
      },
    },
    M08: {
      code: "M08",
      name_zh: "包装及外箱检查",
      name_en: "Piece Packaging & Outer Carton Audit",
      included_in_base: false,
      billing_unit: "per_piece",
      default_option: "piece_packaging",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        piece_packaging: { label_zh: "单件内包装/PE袋警示/SKU条码核验", label_en: "Unit Polybag/Barcode/Folding Audit", unit_cents: 300, manual_quote: false },
        outer_carton: { label_zh: "外箱箱唛与装箱整箱核查", label_en: "Outer Carton & Shipping Mark Audit", unit_cents: 600, billing_unit: "per_carton", manual_quote: false },
      },
    },
    M09: {
      code: "M09",
      name_zh: "加拍高清证据照",
      name_en: "Extra HD Evidence Photography",
      included_in_base: false,
      billing_unit: "per_photo_group",
      default_option: "extra_5_photos",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        extra_5_photos: { label_zh: "5 张定制视角高清加拍组", label_en: "5 Extra Custom Photos Pack", unit_cents: 500, manual_quote: false },
        detail_photo: { label_zh: "单张指定微距细节加拍", label_en: "Single Macro Detail Photo", unit_cents: 300, billing_unit: "per_photo", manual_quote: false },
      },
    },
    M10: {
      code: "M10",
      name_zh: "视频拍摄服务",
      name_en: "HD Video Demonstration Service",
      included_in_base: false,
      billing_unit: "per_video_duration_tier",
      default_option: "up_to_30s",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        up_to_30s: { label_zh: "30秒以内实拍演示视频", label_en: "Video Clip up to 30s", unit_cents: 800, manual_quote: false },
        up_to_60s: { label_zh: "60秒以内结构与操作视频", label_en: "Video Clip up to 60s", unit_cents: 1200, manual_quote: false },
        up_to_120s: { label_zh: "120秒以内深度全流程视频", label_en: "Video Clip up to 120s", unit_cents: 2000, manual_quote: false },
      },
    },
    M11: {
      code: "M11",
      name_zh: "特殊检查与定制人工服务",
      name_en: "Custom Special Inspection (Manual Quote)",
      included_in_base: false,
      billing_unit: "manual_quote",
      default_option: "custom_manual",
      requires: ["M01"],
      mutually_exclusive_with: [],
      options: {
        custom_manual: { label_zh: "特殊工艺/复杂 Tech Pack 人工核价", label_en: "Custom Tech-Pack / Special Service Manual Quote", unit_cents: 0, manual_quote: true },
      },
    },
  },
  service_rules: {
    compare_2_items_cents: 2500,
    compare_3_items_cents: 3500,
    compare_extra_item_cents: 1200,
    compare_max_online_items: 10,
    golden_archive_seal_cents: 1500,
    golden_call_batch_cents: 1000,
    golden_match_item_cents: 800,
    free_storage_days_default: 15,
    overdue_storage_daily_cents: null as number | null,
    outbound_handling_base_cents: null as number | null,
    deduplicate_base_m01: true,
    prevent_duplicate_compare_photo_fee: true,
    charge_golden_call_once_per_batch: true,
  },
  commercial_policy_matrix: {
    minimum_order_fee: { status: "draft_unconfirmed", current_cents: 0, target_owner: "TASK-197B", note: "Wait for commercial signoff" },
    free_storage_days: { status: "draft_confirmed_initial", days: 15, target_owner: "TASK-197B", note: "15天常规初始保管，禁用未确认的30天默认" },
    overdue_storage_daily: { status: "draft_unconfirmed", historical_clues: "$0.10-$0.25/day", target_owner: "TASK-197B" },
    outbound_handling_fee: { status: "draft_unconfirmed", historical_clues: "$2-$3/parcel not sufficient for bulk", target_owner: "TASK-197B" },
    quote_validity_hours: { status: "draft_initial", hours: 72, historical_clues: "48h vs 72h" },
  },
};

/**
 * Idempotently seeds the unified §43.2 apparel pricing book as an unapproved `draft` in `sandbox_acceptance` scope.
 * Strictly preserves administrator edits via ON CONFLICT (code) DO NOTHING.
 */
export async function initializeUnifiedPricing(db: DB, actor: Actor, sessionHash: string) {
  role(actor, "super_admin", "finance");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "pricing_books:seed-init");

  const res = await db.query<{ id: string }>(
    `insert into pricing_books (
      code, name_zh, name_en, description_zh, description_en,
      currency, rounding_mode, auto_volume_discount_enabled, volume_discount_justification,
      minimum_order_cents, order_fixed_fee_cents, max_online_quantity, max_online_total_cents, quote_validity_hours,
      complexity_rates, module_rates, service_rules,
      product_type_overrides, customer_overrides, discount_rules, volume_discount_tiers, commercial_policy_matrix,
      status, publication_scope, is_seed_default, admin_modified, created_by
    ) values (
      $1, $2, $3, $4, $5,
      $6, $7, $8::boolean, $9,
      $10::int, $11::int, $12::int, $13::int, $14::int,
      $15::jsonb, $16::jsonb, $17::jsonb,
      '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, $18::jsonb,
      'draft', 'sandbox_acceptance', true, false, $19::uuid
    ) on conflict (code) do nothing returning id`,
    [
      SEED_PRICING_BOOK.code,
      SEED_PRICING_BOOK.name_zh,
      SEED_PRICING_BOOK.name_en,
      SEED_PRICING_BOOK.description_zh,
      SEED_PRICING_BOOK.description_en,
      SEED_PRICING_BOOK.currency,
      SEED_PRICING_BOOK.rounding_mode,
      SEED_PRICING_BOOK.auto_volume_discount_enabled,
      SEED_PRICING_BOOK.volume_discount_justification,
      SEED_PRICING_BOOK.minimum_order_cents,
      SEED_PRICING_BOOK.order_fixed_fee_cents,
      SEED_PRICING_BOOK.max_online_quantity,
      SEED_PRICING_BOOK.max_online_total_cents,
      SEED_PRICING_BOOK.quote_validity_hours,
      JSON.stringify(SEED_PRICING_BOOK.complexity_rates),
      JSON.stringify(SEED_PRICING_BOOK.module_rates),
      JSON.stringify(SEED_PRICING_BOOK.service_rules),
      JSON.stringify(SEED_PRICING_BOOK.commercial_policy_matrix),
      actor.id,
    ],
  );

  const insertedBooks = res.rowCount ?? 0;
  const skippedBooks = insertedBooks > 0 ? 0 : 1;
  const insertedCounts = { pricing_books: insertedBooks };
  const skippedCounts = { pricing_books: skippedBooks };

  const runRow = (
    await db.query<{ id: string; ran_at: Date }>(
      `insert into pricing_seed_runs (seed_version, actor_id, inserted_counts, skipped_existing_counts)
       values ($1, $2::uuid, $3::jsonb, $4::jsonb)
       returning id, ran_at`,
      [PRICING_SEED_VERSION, actor.id, JSON.stringify(insertedCounts), JSON.stringify(skippedCounts)],
    )
  ).rows[0]!;

  await audit(db, actor, "pricing_seed_init", "pricing_seed_runs", runRow.id, {
    seed_version: PRICING_SEED_VERSION,
    inserted_counts: insertedCounts,
    skipped_existing_counts: skippedCounts,
  });

  const totalBooks = (await db.query<{ n: number }>("select count(*)::int n from pricing_books")).rows[0]!.n;
  return {
    seed_version: PRICING_SEED_VERSION,
    ran_at: runRow.ran_at.toISOString(),
    inserted_counts: insertedCounts,
    skipped_existing_counts: skippedCounts,
    total_books: totalBooks,
  };
}
