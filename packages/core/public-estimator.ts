import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db";
import { guard, hash, one, Problem } from "./common";
import {
  applyPricingBookTranslations,
  calculateUnifiedQuote,
  loadCatalogPricingContext,
  resolveCurrentEffectiveVersion,
  type BillingUnit,
  type PricingLineItem,
  type discountRuleSchema,
} from "./pricing-engine";

export const ANON_DRAFT_DEFAULT_TTL_DAYS = 14;
export const ALLOWED_ESTIMATOR_NEXT_PATHS = [
  "/orders/new",
  "/contact",
  "/zh/contact",
  "/pricing",
  "/zh/pricing",
  "/login",
] as const;

export const estimatorModuleSelectionSchema = z
  .object({
    module_code: z.string().trim().regex(/^M[0-9]{2}$/),
    option_code: z.string().trim().min(1).max(80).optional(),
    coverage_mode: z.enum(["exact_count", "percentage"]).default("exact_count"),
    coverage_qty: z.number().int().min(1).max(10_000).optional(),
    coverage_pct: z.number().min(0.1).max(100).optional(),
    extra_points: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const estimatorServiceGroupSchema = z
  .object({
    group_id: z.string().trim().min(1).max(64),
    service_type: z.enum(["inspection", "compare", "reference_match"]).default("inspection"),
    product_type_code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
    base_qty: z.number().int().min(1).max(10_000),
    preset: z.enum(["basic", "standard", "custom"]).default("custom"),
    modules: z.array(estimatorModuleSelectionSchema).max(12).default([]),
    has_existing_golden_sample: z.boolean().default(false),
    golden_reference_count: z.number().int().min(1).max(10).default(1),
    archive_new_golden_samples: z.number().int().min(0).max(50).default(0),
    customer_authorized_destructive: z.boolean().default(false),
  })
  .strict();

export const publicEstimateRequestSchema = z
  .object({
    mode: z.enum(["quick", "advanced"]).default("quick"),
    locale: z.enum(["en-US", "zh-CN"]).default("en-US"),
    source_route: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\\"), "source_route must be a safe relative path.")
      .default("/pricing"),
    service_groups: z.array(estimatorServiceGroupSchema).min(1).max(20),
    promo_codes: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
  })
  .strict();

export const draftTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, "Invalid anonymous draft token format.");

export type EstimatorServiceGroupInput = z.infer<typeof estimatorServiceGroupSchema>;
export type PublicEstimateInput = z.infer<typeof publicEstimateRequestSchema>;

// Bounded in-memory rate limiter for anonymous estimate endpoints (max 10k buckets)
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

export function resetPublicEstimateRateLimiter(): void {
  rateBuckets.clear();
}

export function assertPublicEstimateRateLimit(key: string, maxPerMinute = 120): void {
  const now = Date.now();
  const bucketKey = key.slice(0, 128) || "anon";
  const current = rateBuckets.get(bucketKey);
  if (!current || now - current.windowStart >= 60_000) {
    if (rateBuckets.size >= 10_000) {
      const oldest = rateBuckets.keys().next().value;
      if (oldest) rateBuckets.delete(oldest);
    }
    rateBuckets.set(bucketKey, { windowStart: now, count: 1 });
    return;
  }
  if (current.count >= maxPerMinute) {
    throw new Problem("RATE_LIMITED", "Too many public estimate requests. Please retry in a moment.", 429);
  }
  current.count += 1;
}

export function buildSafeEstimatorNextPath(
  target: (typeof ALLOWED_ESTIMATOR_NEXT_PATHS)[number] | string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): string {
  const cleanTarget = target.trim();
  const baseAllowed = (ALLOWED_ESTIMATOR_NEXT_PATHS as readonly string[]).includes(cleanTarget);
  guard(
    baseAllowed && cleanTarget.startsWith("/") && !cleanTarget.startsWith("//") && !cleanTarget.includes("\\"),
    "INVALID_REDIRECT_TARGET",
    "Target route is not in estimator allowlist.",
    422,
  );
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    // Never serialize tokens, credentials, prices, or emails into URLs
    if (/token|secret|price|total|cents|email|phone|golden_sample_id/i.test(k)) continue;
    sp.set(k, String(v).slice(0, 80));
  }
  const qs = sp.toString();
  return qs ? `${cleanTarget}?${qs}` : cleanTarget;
}

export type PublicEstimateGroupResult = {
  group_id: string;
  service_type: "inspection" | "compare" | "reference_match";
  product_type_code: string;
  product_type_name_zh: string | null;
  product_type_name_en: string | null;
  base_qty: number;
  preset: "basic" | "standard" | "custom";
  status: "priced" | "manual_quote_required" | "unavailable";
  unavailable_reason_zh: string | null;
  unavailable_reason_en: string | null;
  line_items: PricingLineItem[];
  base_cents: number;
  service_fees_cents: number;
  addons_cents: number;
  subtotal_cents: number;
  manual_quote_required: boolean;
  manual_quote_reasons: string[];
  disclosures: string[];
  conditional_disclosures: string[];
};

export type PublicMultiGroupEstimateResult = {
  status: "priced" | "sandbox_priced" | "manual_quote_required" | "unavailable" | "no_published_pricing";
  book_id: string | null;
  book_version_id: string | null;
  book_version: number | null;
  book_name_zh: string | null;
  book_name_en: string | null;
  business_approved: boolean;
  publication_scope: string | null;
  currency: string;
  rounding_mode: "ceil" | "round" | "floor";
  can_checkout_online: boolean;
  total_base_qty: number;
  base_subtotal_cents: number | null;
  service_fees_subtotal_cents: number | null;
  addons_subtotal_cents: number | null;
  order_fixed_fee_cents: number;
  subtotal_cents: number | null;
  discount_cents: number;
  minimum_topup_cents: number;
  total_cents: number | null;
  groups: PublicEstimateGroupResult[];
  order_adjustments: PricingLineItem[];
  manual_quote_required: boolean;
  manual_quote_reasons: string[];
  disclosures: string[];
  post_inspection_charges: {
    domestic_shipping: {
      status: "estimated_later";
      amount_cents: null;
      label_zh: string;
      label_en: string;
    };
    storage: {
      free_days: number;
      overdue_daily_cents: number | null;
      label_zh: string;
      label_en: string;
    };
  };
  turnaround_note_zh: string;
  turnaround_note_en: string;
  normalized_input: PublicEstimateInput;
};

function resolvePresetModules(
  group: EstimatorServiceGroupInput,
  applicableModuleCodes: string[],
): z.infer<typeof estimatorModuleSelectionSchema>[] {
  if (group.preset === "basic") {
    return [];
  }
  if (group.preset === "standard") {
    if (applicableModuleCodes.length === 0 || applicableModuleCodes.includes("M02")) {
      return [
        {
          module_code: "M02",
          option_code: "points_3",
          coverage_mode: "exact_count",
          coverage_qty: group.base_qty,
        },
      ];
    }
    return [];
  }
  return group.modules;
}

export async function calculatePublicMultiGroupEstimate(
  db: DB,
  rawInput: unknown,
): Promise<PublicMultiGroupEstimateResult> {
  const input = publicEstimateRequestSchema.parse(rawInput);

  // Enforce unique group IDs cleanly
  const seenGroupIds = new Set<string>();
  for (const g of input.service_groups) {
    guard(!seenGroupIds.has(g.group_id), "DUPLICATE_GROUP_ID", `Duplicate service group '${g.group_id}'.`, 422);
    seenGroupIds.add(g.group_id);
  }

  const pubRow = await resolveCurrentEffectiveVersion(db);
  if (!pubRow) {
    return {
      status: "no_published_pricing",
      book_id: null,
      book_version_id: null,
      book_version: null,
      book_name_zh: null,
      book_name_en: null,
      business_approved: false,
      publication_scope: null,
      currency: "USD",
      rounding_mode: "ceil",
      can_checkout_online: false,
      total_base_qty: input.service_groups.reduce((s, g) => s + g.base_qty, 0),
      base_subtotal_cents: null,
      service_fees_subtotal_cents: null,
      addons_subtotal_cents: null,
      order_fixed_fee_cents: 0,
      subtotal_cents: null,
      discount_cents: 0,
      minimum_topup_cents: 0,
      total_cents: null,
      groups: [],
      order_adjustments: [],
      manual_quote_required: false,
      manual_quote_reasons: ["No published unified pricing book is currently effective."],
      disclosures: [
        "No published pricing schedule is active at this moment. Your entered items are preserved—please retry or request a staff quote.",
      ],
      post_inspection_charges: {
        domestic_shipping: {
          status: "estimated_later",
          amount_cents: null,
          label_zh: "国内退回或发往集运仓快递费将在验货后按实重核价（非 0 元包邮）",
          label_en: "Estimated later based on actual outbound carton weight & China destination (never included as $0)",
        },
        storage: {
          free_days: 15,
          overdue_daily_cents: null,
          label_zh: "标准质检报告发布后享 15 天免费看护期，超期或确认样留存按公开政策计费",
          label_en: "15 free days after reviewed report publication; extended/Golden Sample custody billed per published schedule",
        },
      },
      turnaround_note_zh: "工期与排期取决于正式价格表发布与全件到仓点收齐备时间。",
      turnaround_note_en: "Turnaround depends on an active published schedule and physical check-in of all commissioned parcels.",
      normalized_input: input,
    };
  }

  const bookSnap = await applyPricingBookTranslations(db, pubRow.book_id, pubRow.effective_snapshot, {
    verifyFrozenSource: true,
  });
  const bookForPerGroup = {
    ...bookSnap,
    order_fixed_fee_cents: 0,
    minimum_order_cents: 0,
    discount_rules: [],
  };

  const currency = String(bookSnap.currency ?? "USD");
  const roundingMode: "ceil" | "round" | "floor" = bookSnap.rounding_mode ?? "ceil";
  const sr = (bookSnap.service_rules ?? {}) as Record<string, any>;
  const freeStorageDays = Number(sr.free_storage_days_default ?? 15);
  const overdueDailyCents = typeof sr.overdue_storage_daily_cents === "number" ? sr.overdue_storage_daily_cents : null;

  const groupResults: PublicEstimateGroupResult[] = [];
  const allDisclosures = new Set<string>();
  const allManualReasons: string[] = [];

  for (const grp of input.service_groups) {
    let catalogCtx;
    try {
      catalogCtx = await loadCatalogPricingContext(db, grp.product_type_code);
    } catch (err) {
      if (err instanceof Problem && err.code === "NOT_FOUND") {
        groupResults.push({
          group_id: grp.group_id,
          service_type: grp.service_type,
          product_type_code: grp.product_type_code,
          product_type_name_zh: null,
          product_type_name_en: null,
          base_qty: grp.base_qty,
          preset: grp.preset,
          status: "unavailable",
          unavailable_reason_zh: `所选商品类型 '${grp.product_type_code}' 未在开放目录中启用或已下线。`,
          unavailable_reason_en: `Product type '${grp.product_type_code}' is not available in the published catalog.`,
          line_items: [],
          base_cents: 0,
          service_fees_cents: 0,
          addons_cents: 0,
          subtotal_cents: 0,
          manual_quote_required: false,
          manual_quote_reasons: [],
          disclosures: [],
          conditional_disclosures: [],
        });
        continue;
      }
      throw err;
    }

    const effectiveModules = resolvePresetModules(grp, catalogCtx.applicable_module_codes);
    const anonRefIds =
      grp.service_type === "reference_match"
        ? Array.from({ length: Math.max(1, grp.golden_reference_count) }, (_, i) => `anon_ref_${i + 1}`)
        : [];

    let calc;
    try {
      calc = calculateUnifiedQuote(
        bookForPerGroup,
        catalogCtx,
        {
          service_type: grp.service_type,
          product_type_code: grp.product_type_code,
          base_qty: grp.base_qty,
          modules: effectiveModules,
          golden_sample_ids: anonRefIds,
          archive_new_golden_samples: grp.archive_new_golden_samples,
          customer_authorized_destructive: grp.customer_authorized_destructive,
          promo_codes: [],
          apply_volume_discount: false,
          quote_kind: "simulation",
          allow_unpublished_catalog_in_sim: false,
        },
        { callerIsStaff: false },
      );
    } catch (err) {
      if (err instanceof Problem && err.code === "CATEGORY_NOT_ACTIVE") {
        groupResults.push({
          group_id: grp.group_id,
          service_type: grp.service_type,
          product_type_code: grp.product_type_code,
          product_type_name_zh: catalogCtx.name_zh,
          product_type_name_en: catalogCtx.name_en,
          base_qty: grp.base_qty,
          preset: grp.preset,
          status: "unavailable",
          unavailable_reason_zh: `商品品类 '${catalogCtx.name_zh}' 当前暂未开放购买或能力未就绪。`,
          unavailable_reason_en: `Product type '${catalogCtx.name_en}' is currently inactive or restricted from checkout.`,
          line_items: [],
          base_cents: 0,
          service_fees_cents: 0,
          addons_cents: 0,
          subtotal_cents: 0,
          manual_quote_required: false,
          manual_quote_reasons: [],
          disclosures: [],
          conditional_disclosures: [],
        });
        continue;
      }
      throw err;
    }

    const condDisclosures: string[] = [];
    if (grp.service_type === "reference_match") {
      condDisclosures.push(
        grp.has_existing_golden_sample
          ? "Conditional estimate: requires signing in and selecting eligible sealed Golden Sample(s) from your account before checkout."
          : "Prerequisite required before matching: no active Golden Sample selected yet — convert/seal a reference sample first or include archival with a preceding sample.",
      );
    }
    if (grp.archive_new_golden_samples > 0) {
      condDisclosures.push(
        `Includes one-time archival & tamper-evident sealing fee for ${grp.archive_new_golden_samples} reference sample(s); post-window custody renews per schedule.`,
      );
    }

    let baseCents = 0;
    let serviceFeesCents = 0;
    let addonsCents = 0;
    for (const li of calc.line_items) {
      if (li.module_code === "M01") {
        baseCents += li.amount_cents;
      } else if (li.module_code) {
        addonsCents += li.amount_cents;
      } else {
        serviceFeesCents += li.amount_cents;
      }
    }

    for (const d of calc.disclosures) allDisclosures.add(d);
    for (const d of condDisclosures) allDisclosures.add(d);
    for (const r of calc.manual_quote_reasons) allManualReasons.push(`[${grp.group_id}] ${r}`);

    groupResults.push({
      group_id: grp.group_id,
      service_type: grp.service_type,
      product_type_code: grp.product_type_code,
      product_type_name_zh: catalogCtx.name_zh,
      product_type_name_en: catalogCtx.name_en,
      base_qty: grp.base_qty,
      preset: grp.preset,
      status: calc.manual_quote_required ? "manual_quote_required" : "priced",
      unavailable_reason_zh: null,
      unavailable_reason_en: null,
      line_items: calc.line_items,
      base_cents: baseCents,
      service_fees_cents: serviceFeesCents,
      addons_cents: addonsCents,
      subtotal_cents: calc.subtotal_cents,
      manual_quote_required: calc.manual_quote_required,
      manual_quote_reasons: calc.manual_quote_reasons,
      disclosures: calc.disclosures,
      conditional_disclosures: condDisclosures,
    });
  }

  const totalBaseQty = groupResults.reduce((s, g) => s + g.base_qty, 0);
  const anyUnavailable = groupResults.some((g) => g.status === "unavailable");

  if (anyUnavailable) {
    return {
      status: "unavailable",
      book_id: pubRow.book_id,
      book_version_id: pubRow.version_id,
      book_version: pubRow.version,
      book_name_zh: String(bookSnap.name_zh ?? ""),
      book_name_en: String(bookSnap.name_en ?? ""),
      business_approved: pubRow.business_approved,
      publication_scope: pubRow.publication_scope,
      currency,
      rounding_mode: roundingMode,
      can_checkout_online: false,
      total_base_qty: totalBaseQty,
      base_subtotal_cents: null,
      service_fees_subtotal_cents: null,
      addons_subtotal_cents: null,
      order_fixed_fee_cents: 0,
      subtotal_cents: null,
      discount_cents: 0,
      minimum_topup_cents: 0,
      total_cents: null,
      groups: groupResults,
      order_adjustments: [],
      manual_quote_required: allManualReasons.length > 0,
      manual_quote_reasons: allManualReasons,
      disclosures: [...allDisclosures],
      post_inspection_charges: {
        domestic_shipping: {
          status: "estimated_later",
          amount_cents: null,
          label_zh: "中国境内退回/发往集运仓运费按实重后付核算（非 0 元包邮）",
          label_en: "Estimated later based on actual outbound carton weight & China destination (never included as $0)",
        },
        storage: {
          free_days: freeStorageDays,
          overdue_daily_cents: overdueDailyCents,
          label_zh: `报告发布后含 ${freeStorageDays} 天免费保管，超期或确认样留存按公开政策计费`,
          label_en: `${freeStorageDays} free days after reviewed report publication; extended/Golden custody billed per published schedule`,
        },
      },
      turnaround_note_zh: "当前组合存在未开放或已下线品类，请移除或替换后再试算。",
      turnaround_note_en: "One or more selected product types are currently unavailable; remove or replace unavailable items to estimate.",
      normalized_input: input,
    };
  }

  const baseSubtotalCents = groupResults.reduce((s, g) => s + g.base_cents, 0);
  const serviceFeesSubtotalCents = groupResults.reduce((s, g) => s + g.service_fees_cents, 0);
  const addonsSubtotalCents = groupResults.reduce((s, g) => s + g.addons_cents, 0);
  const orderAdjustments: PricingLineItem[] = [];

  const fixedFeeCents = Number(bookSnap.order_fixed_fee_cents ?? 0);
  if (fixedFeeCents > 0) {
    orderAdjustments.push({
      code: "ORDER_FIXED_FEE",
      module_code: null,
      option_code: "order_fixed",
      label_zh: "订单固定受理/准备费",
      label_en: "Fixed Order Preparation Fee",
      billing_unit: "per_order",
      quantity: 1,
      unit_cents: fixedFeeCents,
      amount_cents: fixedFeeCents,
      source_rule: "book:order_fixed_fee_cents",
    });
  }

  const subtotalCents = baseSubtotalCents + serviceFeesSubtotalCents + addonsSubtotalCents + fixedFeeCents;

  // Apply explicit promo_codes once at order level (mirrors pricing-engine.ts rules)
  let discountCents = 0;
  const promoCodes = [...new Set(input.promo_codes.map((p) => p.toUpperCase()))];
  if (promoCodes.length > 0) {
    const ruleMap = new Map(
      ((bookSnap.discount_rules as z.infer<typeof discountRuleSchema>[] | undefined) ?? [])
        .filter((r) => r.active)
        .map((r) => [r.code.toUpperCase(), r]),
    );
    const matchedRules = promoCodes.map((pc) => {
      const r = ruleMap.get(pc);
      guard(r, "INVALID_PROMO_CODE", `Promo code '${pc}' is not valid or active.`, 422);
      guard(subtotalCents >= r.min_subtotal_cents, "PROMO_MIN_SUBTOTAL_NOT_MET", `Promo '${pc}' requires minimum subtotal ${r.min_subtotal_cents} cents.`, 422);
      return r;
    });
    if (matchedRules.length > 1 && matchedRules.some((r) => !r.stackable)) {
      guard(false, "PROMO_CONFLICT", "Non-stackable promo codes cannot be combined.", 422);
    }
    for (const r of matchedRules) {
      const off = r.kind === "fixed_cents" ? r.value : Math.floor((subtotalCents * r.value) / 100);
      const bounded = Math.min(off, subtotalCents - discountCents);
      if (bounded > 0) {
        discountCents += bounded;
        orderAdjustments.push({
          code: `DISCOUNT_${r.code}`,
          module_code: null,
          option_code: r.code,
          label_zh: `优惠减免 (${r.label_zh})`,
          label_en: `Discount (${r.label_en})`,
          billing_unit: "per_order",
          quantity: 1,
          unit_cents: -bounded,
          amount_cents: -bounded,
          source_rule: `discount_rules:${r.code}`,
        });
      }
    }
  }

  const afterDiscount = Math.max(0, subtotalCents - discountCents);
  const minOrderCents = Number(bookSnap.minimum_order_cents ?? 0);
  let minimumTopupCents = 0;
  if (minOrderCents > 0 && afterDiscount > 0 && afterDiscount < minOrderCents) {
    minimumTopupCents = minOrderCents - afterDiscount;
    orderAdjustments.push({
      code: "MINIMUM_ORDER_TOPUP",
      module_code: null,
      option_code: "min_topup",
      label_zh: "最低消费差额补足（独立明示）",
      label_en: "Minimum Order Fee Top-Up (Itemized)",
      billing_unit: "per_order",
      quantity: 1,
      unit_cents: minimumTopupCents,
      amount_cents: minimumTopupCents,
      source_rule: "book:minimum_order_cents",
    });
  }

  const totalCents = afterDiscount + minimumTopupCents;

  // Order-level online quantity / amount ceilings
  const maxOnlineQty = Number(bookSnap.max_online_quantity ?? 300);
  if (totalBaseQty > maxOnlineQty && !groupResults.every((g) => g.manual_quote_required)) {
    allManualReasons.push(`Combined item count (${totalBaseQty}) exceeds online limit (${maxOnlineQty}).`);
  }
  const maxOnlineTotalCents = Number(bookSnap.max_online_total_cents ?? 5_000_000);
  if (totalCents > maxOnlineTotalCents) {
    allManualReasons.push(`Combined order total (${totalCents} cents) exceeds online checkout ceiling (${maxOnlineTotalCents} cents).`);
  }

  const manualQuoteRequired = allManualReasons.length > 0;
  const status: PublicMultiGroupEstimateResult["status"] = manualQuoteRequired
    ? "manual_quote_required"
    : !pubRow.business_approved || pubRow.publication_scope !== "production"
      ? "sandbox_priced"
      : "priced";

  return {
    status,
    book_id: pubRow.book_id,
    book_version_id: pubRow.version_id,
    book_version: pubRow.version,
    book_name_zh: String(bookSnap.name_zh ?? ""),
    book_name_en: String(bookSnap.name_en ?? ""),
    business_approved: pubRow.business_approved,
    publication_scope: pubRow.publication_scope,
    currency,
    rounding_mode: roundingMode,
    can_checkout_online: !manualQuoteRequired && pubRow.business_approved && pubRow.publication_scope === "production",
    total_base_qty: totalBaseQty,
    base_subtotal_cents: baseSubtotalCents,
    service_fees_subtotal_cents: serviceFeesSubtotalCents,
    addons_subtotal_cents: addonsSubtotalCents,
    order_fixed_fee_cents: fixedFeeCents,
    subtotal_cents: subtotalCents,
    discount_cents: discountCents,
    minimum_topup_cents: minimumTopupCents,
    total_cents: totalCents,
    groups: groupResults,
    order_adjustments: orderAdjustments,
    manual_quote_required: manualQuoteRequired,
    manual_quote_reasons: allManualReasons,
    disclosures: [...allDisclosures],
    post_inspection_charges: {
      domestic_shipping: {
        status: "estimated_later",
        amount_cents: null,
        label_zh: "中国境内退回/发往集运仓快递费按实重后付核算（非 0 元包邮）",
        label_en: "Estimated later based on actual outbound carton weight & China destination (never included as $0)",
      },
      storage: {
        free_days: freeStorageDays,
        overdue_daily_cents: overdueDailyCents,
        label_zh: `常规质检报告发布后含 ${freeStorageDays} 天免费保管期，超期或独立确认样按政策计费`,
        label_en: `${freeStorageDays} free days after reviewed report publication; extended/Golden custody billed per published schedule`,
      },
    },
    turnaround_note_zh: manualQuoteRequired
      ? "当前估价含需人工工位确认项或超在线上限，最终交付周期以人工报价单批复为准；计费工期均自全部实物到仓点收齐备起算。"
      : "通常于全部委托货物到仓扫码点收并确认基准样齐备后的 2–4 个工作日完成初检与 QA 审核；最终交期以结账时仓内排期为准。",
    turnaround_note_en: manualQuoteRequired
      ? "Manual bench/capacity review required for one or more lines; turnaround starts only after physical intake of all commissioned items and reference availability."
      : "Typical inspection & QA review runs 2–4 business days after physical arrival check-in of all items and required reference samples; exact commitment confirms at checkout.",
    normalized_input: input,
  };
}

function makeDraftToken(): string {
  return randomBytes(32).toString("base64url");
}

function summarizeDraftSnapshot(estimate: PublicMultiGroupEstimateResult) {
  return {
    status: estimate.status,
    book_version_id: estimate.book_version_id,
    book_version: estimate.book_version,
    currency: estimate.currency,
    total_base_qty: estimate.total_base_qty,
    subtotal_cents: estimate.subtotal_cents,
    discount_cents: estimate.discount_cents,
    minimum_topup_cents: estimate.minimum_topup_cents,
    total_cents: estimate.total_cents,
    manual_quote_required: estimate.manual_quote_required,
  };
}

export async function createAnonymousEstimateDraft(
  db: DB,
  browserSessionKey: string,
  rawInput: unknown,
  opts: { ttlDays?: number } = {},
) {
  guard(browserSessionKey.trim().length >= 8, "SESSION_BINDING_REQUIRED", "Browser session binding is required.", 422);
  const estimate = await calculatePublicMultiGroupEstimate(db, rawInput);
  const input = estimate.normalized_input;
  const draftToken = makeDraftToken();
  const tokenHash = hash(draftToken);
  const sessionBindingHash = hash(browserSessionKey);
  const ttlDays = Math.max(1, Math.min(30, opts.ttlDays ?? ANON_DRAFT_DEFAULT_TTL_DAYS));
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();

  const row = await one<{
    id: string;
    status: string;
    revision: number;
    locale: string;
    mode: string;
    expires_at: Date;
    created_at: Date;
    updated_at: Date;
  }>(
    db,
    `insert into anonymous_estimate_drafts (
       token_hash, session_binding_hash, locale, mode, source_route,
       draft_payload, last_book_id, last_book_version_id, last_book_version,
       last_currency, last_total_cents, last_manual_quote_required,
       last_estimate_snapshot, status, revision, expires_at
     ) values (
       $1, $2, $3, $4, $5,
       $6::jsonb, $7::uuid, $8::uuid, $9::int,
       $10, $11::int, $12::boolean,
       $13::jsonb, 'active', 1, $14::timestamptz
     )
     returning id, status, revision, locale, mode, expires_at, created_at, updated_at`,
    [
      tokenHash,
      sessionBindingHash,
      input.locale,
      input.mode,
      input.source_route,
      JSON.stringify(input),
      estimate.book_id,
      estimate.book_version_id,
      estimate.book_version,
      estimate.currency,
      estimate.total_cents,
      estimate.manual_quote_required,
      JSON.stringify(summarizeDraftSnapshot(estimate)),
      expiresAt,
    ],
  );

  return {
    draft_id: row.id,
    draft_token: draftToken,
    status: row.status,
    revision: row.revision,
    locale: row.locale as "en-US" | "zh-CN",
    mode: row.mode as "quick" | "advanced",
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    estimate,
  };
}

export async function getAnonymousEstimateDraft(
  db: DB,
  browserSessionKey: string,
  rawToken: string,
) {
  const token = draftTokenSchema.parse(rawToken);
  guard(browserSessionKey.trim().length >= 8, "NOT_FOUND", "Anonymous draft not found.", 404);
  const tokenHash = hash(token);
  const sessionBindingHash = hash(browserSessionKey);

  const row = (
    await db.query<{
      id: string;
      status: string;
      revision: number;
      locale: "en-US" | "zh-CN";
      mode: "quick" | "advanced";
      source_route: string;
      draft_payload: PublicEstimateInput;
      last_book_version_id: string | null;
      last_book_version: number | null;
      last_total_cents: number | null;
      expires_at: Date;
      updated_at: Date;
    }>(
      `select id, status, revision, locale, mode, source_route, draft_payload,
              last_book_version_id, last_book_version, last_total_cents, expires_at, updated_at
       from anonymous_estimate_drafts
       where token_hash = $1 and session_binding_hash = $2`,
      [tokenHash, sessionBindingHash],
    )
  ).rows[0];

  guard(row, "NOT_FOUND", "Anonymous estimate draft not found for current browser session.", 404);

  if (row.status === "revoked") {
    throw new Problem("DRAFT_REVOKED", "This anonymous estimate draft was deleted or revoked.", 410);
  }
  if (row.status === "claimed") {
    return {
      draft_id: row.id,
      status: "claimed" as const,
      revision: row.revision,
      locale: row.locale,
      mode: row.mode,
      expires_at: row.expires_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      recoverable_input: row.draft_payload,
      can_recalculate: true,
      estimate: null,
    };
  }

  const isExpired = row.status === "expired" || row.expires_at.getTime() <= Date.now();
  if (isExpired) {
    if (row.status === "active") {
      await db.query(
        "update anonymous_estimate_drafts set status = 'expired', updated_at = now() where id = $1::uuid",
        [row.id],
      );
    }
    return {
      draft_id: row.id,
      status: "expired" as const,
      revision: row.revision,
      locale: row.locale,
      mode: row.mode,
      expires_at: row.expires_at.toISOString(),
      updated_at: new Date().toISOString(),
      recoverable_input: row.draft_payload,
      can_recalculate: true,
      price_changed: false,
      saved_book_version: row.last_book_version,
      saved_total_cents: row.last_total_cents,
      estimate: null,
    };
  }

  // Active draft: always recalculate live against current effective pricing book & catalog availability!
  const estimate = await calculatePublicMultiGroupEstimate(db, row.draft_payload);
  const priceChanged =
    (row.last_total_cents !== null || estimate.total_cents !== null) &&
    (row.last_total_cents !== estimate.total_cents || row.last_book_version_id !== estimate.book_version_id);

  return {
    draft_id: row.id,
    status: "active" as const,
    revision: row.revision,
    locale: row.locale,
    mode: row.mode,
    source_route: row.source_route,
    expires_at: row.expires_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    draft_payload: row.draft_payload,
    recoverable_input: row.draft_payload,
    can_recalculate: true,
    price_changed: priceChanged,
    saved_book_version: row.last_book_version,
    saved_total_cents: row.last_total_cents,
    estimate,
  };
}

export async function updateAnonymousEstimateDraft(
  db: DB,
  browserSessionKey: string,
  rawToken: string,
  rawInput: unknown,
  opts: { ttlDays?: number } = {},
) {
  const token = draftTokenSchema.parse(rawToken);
  guard(browserSessionKey.trim().length >= 8, "NOT_FOUND", "Anonymous draft not found.", 404);
  const tokenHash = hash(token);
  const sessionBindingHash = hash(browserSessionKey);

  const cur = (
    await db.query<{ id: string; status: string; expires_at: Date }>(
      `select id, status, expires_at
       from anonymous_estimate_drafts
       where token_hash = $1 and session_binding_hash = $2
       for update`,
      [tokenHash, sessionBindingHash],
    )
  ).rows[0];

  guard(cur, "NOT_FOUND", "Anonymous estimate draft not found for current browser session.", 404);
  guard(cur.status !== "revoked" && cur.status !== "claimed", "DRAFT_NOT_EDITABLE", `Draft in status '${cur.status}' cannot be edited.`, 409);

  if (cur.status === "expired" || cur.expires_at.getTime() <= Date.now()) {
    if (cur.status === "active") {
      await db.query("update anonymous_estimate_drafts set status = 'expired', updated_at = now() where id = $1::uuid", [cur.id]);
    }
    throw new Problem("DRAFT_EXPIRED", "Anonymous estimate draft has expired. Restore inputs into a fresh draft to continue.", 409);
  }

  const estimate = await calculatePublicMultiGroupEstimate(db, rawInput);
  const input = estimate.normalized_input;
  const ttlDays = Math.max(1, Math.min(30, opts.ttlDays ?? ANON_DRAFT_DEFAULT_TTL_DAYS));
  const nextExpiry = new Date(Date.now() + ttlDays * 86_400_000).toISOString();

  const updated = await one<{
    id: string;
    status: string;
    revision: number;
    locale: "en-US" | "zh-CN";
    mode: "quick" | "advanced";
    expires_at: Date;
    updated_at: Date;
  }>(
    db,
    `update anonymous_estimate_drafts set
       locale = $2,
       mode = $3,
       source_route = $4,
       draft_payload = $5::jsonb,
       last_book_id = $6::uuid,
       last_book_version_id = $7::uuid,
       last_book_version = $8::int,
       last_currency = $9,
       last_total_cents = $10::int,
       last_manual_quote_required = $11::boolean,
       last_estimate_snapshot = $12::jsonb,
       revision = revision + 1,
       expires_at = $13::timestamptz,
       updated_at = now()
     where id = $1::uuid
     returning id, status, revision, locale, mode, expires_at, updated_at`,
    [
      cur.id,
      input.locale,
      input.mode,
      input.source_route,
      JSON.stringify(input),
      estimate.book_id,
      estimate.book_version_id,
      estimate.book_version,
      estimate.currency,
      estimate.total_cents,
      estimate.manual_quote_required,
      JSON.stringify(summarizeDraftSnapshot(estimate)),
      nextExpiry,
    ],
  );

  return {
    draft_id: updated.id,
    status: updated.status,
    revision: updated.revision,
    locale: updated.locale,
    mode: updated.mode,
    expires_at: updated.expires_at.toISOString(),
    updated_at: updated.updated_at.toISOString(),
    estimate,
  };
}

export async function deleteAnonymousEstimateDraft(
  db: DB,
  browserSessionKey: string,
  rawToken: string,
) {
  const token = draftTokenSchema.parse(rawToken);
  guard(browserSessionKey.trim().length >= 8, "NOT_FOUND", "Anonymous draft not found.", 404);
  const tokenHash = hash(token);
  const sessionBindingHash = hash(browserSessionKey);

  const cur = (
    await db.query<{ id: string; status: string }>(
      `select id, status
       from anonymous_estimate_drafts
       where token_hash = $1 and session_binding_hash = $2
       for update`,
      [tokenHash, sessionBindingHash],
    )
  ).rows[0];
  guard(cur, "NOT_FOUND", "Anonymous estimate draft not found for current browser session.", 404);

  if (cur.status !== "revoked") {
    await db.query(
      `update anonymous_estimate_drafts set
         status = 'revoked',
         claimed_by_user_id = null,
         claimed_org_id = null,
         claimed_at = null,
         updated_at = now()
       where id = $1::uuid`,
      [cur.id],
    );
  }
  return { deleted: true, draft_id: cur.id, status: "revoked" };
}
