import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, guard, hash, lock, one, role, type Actor } from "./common";

export const PRICING_READ_ROLES = ["super_admin", "finance", "reviewer", "template_admin", "support"] as const;
export const PRICING_EDIT_ROLES = ["super_admin", "finance"] as const;
export const PRICING_REVIEW_ROLES = ["super_admin", "reviewer"] as const;

// Authoritative modular billing units derived from §06
export const BILLING_UNITS = [
  "per_order",
  "per_order_line",
  "per_piece",
  "per_set",
  "per_component",
  "per_sku",
  "per_style",
  "per_supplier",
  "per_measurement_point",
  "per_check_item",
  "per_test_group",
  "per_comparison_group",
  "per_golden_sample",
  "per_golden_sample_call",
  "per_photo",
  "per_photo_group",
  "per_video",
  "per_video_duration_tier",
  "per_carton",
  "per_storage_period",
  "by_labor_hours",
  "manual_quote",
] as const;

export type BillingUnit = (typeof BILLING_UNITS)[number];

export const billingUnitSchema = z.enum(BILLING_UNITS);

export const complexityRateItemSchema = z.object({
  code: z.enum(["L1", "L2", "L3", "L4", "L5"]),
  name_zh: z.string().trim().min(1).max(120),
  name_en: z.string().trim().min(1).max(120),
  unit_cents: z.number().int().min(0).max(500_000).nullable(),
  billing_unit: billingUnitSchema.default("per_piece"),
  manual_quote: z.boolean().default(false),
  note_zh: z.string().trim().max(400).optional(),
  note_en: z.string().trim().max(400).optional(),
});

export const moduleOptionSchema = z.object({
  label_zh: z.string().trim().min(1).max(160),
  label_en: z.string().trim().min(1).max(160),
  unit_cents: z.number().int().min(0).max(500_000),
  billing_unit: billingUnitSchema.optional(),
  requires_destructive_auth: z.boolean().optional(),
  manual_quote: z.boolean().optional().default(false),
});

export const moduleRateSchema = z.object({
  code: z.string().trim().regex(/^M[0-9]{2}$/),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  included_in_base: z.boolean().default(false),
  billing_unit: billingUnitSchema,
  default_option: z.string().trim().min(1).max(80),
  requires: z.array(z.string().trim().min(1).max(40)).default(["M01"]),
  mutually_exclusive_with: z.array(z.string().trim().min(1).max(40)).default([]),
  options: z.record(z.string().trim().min(1), moduleOptionSchema),
});

export const serviceRulesSchema = z.object({
  compare_2_items_cents: z.number().int().min(0).max(500_000),
  compare_3_items_cents: z.number().int().min(0).max(500_000),
  compare_extra_item_cents: z.number().int().min(0).max(500_000),
  compare_max_online_items: z.number().int().min(2).max(50).default(10),
  golden_archive_seal_cents: z.number().int().min(0).max(500_000),
  golden_call_batch_cents: z.number().int().min(0).max(500_000),
  golden_match_item_cents: z.number().int().min(0).max(500_000),
  free_storage_days_default: z.number().int().min(0).max(365).default(15),
  overdue_storage_daily_cents: z.number().int().min(0).max(100_000).nullable().optional(),
  outbound_handling_base_cents: z.number().int().min(0).max(100_000).nullable().optional(),
  deduplicate_base_m01: z.boolean().default(true),
  prevent_duplicate_compare_photo_fee: z.boolean().default(true),
  charge_golden_call_once_per_batch: z.boolean().default(true),
});

export const discountRuleSchema = z
  .object({
    code: z.string().trim().regex(/^[A-Z0-9_]{2,40}$/),
    label_zh: z.string().trim().min(1).max(120),
    label_en: z.string().trim().min(1).max(120),
    kind: z.enum(["fixed_cents", "percent_off"]),
    value: z.number().int().min(1).max(100_000),
    stackable: z.boolean().default(false),
    min_subtotal_cents: z.number().int().min(0).default(0),
    active: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.kind === "percent_off" && r.value > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percent_off discount value must be between 1 and 100." });
    }
  });

export const volumeDiscountTierSchema = z.object({
  min_qty: z.number().int().min(2),
  percent_off: z.number().int().min(1).max(50),
});

export const savePricingBookSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
  name_zh: z.string().trim().min(1).max(160),
  name_en: z.string().trim().min(1).max(160),
  description_zh: z.string().trim().max(1000).default(""),
  description_en: z.string().trim().max(1000).default(""),
  currency: z.enum(["USD", "CNY", "HKD", "EUR", "GBP"]).default("USD"),
  rounding_mode: z.enum(["ceil", "round", "floor"]).default("ceil"),
  auto_volume_discount_enabled: z.boolean().default(false),
  volume_discount_justification: z.string().trim().max(500).nullable().optional(),
  minimum_order_cents: z.number().int().min(0).max(5_000_000).default(0),
  order_fixed_fee_cents: z.number().int().min(0).max(5_000_000).default(0),
  max_online_quantity: z.number().int().min(1).max(5000).default(300),
  max_online_total_cents: z.number().int().min(0).max(50_000_000).default(5_000_000),
  quote_validity_hours: z.number().int().min(1).max(720).default(72),
  complexity_rates: z.record(z.enum(["L1", "L2", "L3", "L4", "L5"]), complexityRateItemSchema),
  module_rates: z.record(z.string().trim().regex(/^M[0-9]{2}$/), moduleRateSchema),
  service_rules: serviceRulesSchema,
  product_type_overrides: z
    .record(
      z.string().trim().min(2),
      z.object({
        unit_cents: z.number().int().min(0).max(500_000),
        manual_quote: z.boolean().optional(),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .default({}),
  customer_overrides: z
    .record(
      z.string().trim().min(2),
      z.object({
        product_type_unit_cents: z.record(z.string(), z.number().int().min(0)).optional(),
        complexity_unit_cents: z.record(z.string(), z.number().int().min(0)).optional(),
      }),
    )
    .default({}),
  discount_rules: z.array(discountRuleSchema).default([]),
  volume_discount_tiers: z.array(volumeDiscountTierSchema).default([]),
  commercial_policy_matrix: z.record(z.string(), z.unknown()).default({}),
  effective_from: z.string().datetime().nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

export const moduleSelectionSchema = z.object({
  module_code: z.string().trim().regex(/^M[0-9]{2}$/),
  option_code: z.string().trim().min(1).max(80).optional(),
  coverage_mode: z.enum(["exact_count", "percentage"]).default("exact_count"),
  coverage_qty: z.number().int().min(1).max(10_000).optional(),
  coverage_pct: z.number().min(0.1).max(100).optional(),
  extra_points: z.number().int().min(1).max(50).optional(),
});

export const quoteRequestSchema = z.object({
  service_type: z.enum(["inspection", "compare", "reference_match"]).default("inspection"),
  product_type_code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
  base_qty: z.number().int().min(1).max(10_000),
  modules: z.array(moduleSelectionSchema).default([]),
  golden_sample_ids: z.array(z.string().trim().min(1).max(80)).default([]),
  archive_new_golden_samples: z.number().int().min(0).max(100).default(0),
  customer_authorized_destructive: z.boolean().default(false),
  promo_codes: z.array(z.string().trim().min(1).max(40)).default([]),
  apply_volume_discount: z.boolean().default(false),
  quote_kind: z.enum(["simulation", "formal", "supplement"]).default("formal"),
  draft_book_id: z.string().uuid().optional(),
  allow_unpublished_catalog_in_sim: z.boolean().default(false),
  org_id: z.string().uuid().optional(),
});

export const batchAdjustSchema = z.object({
  scope: z.enum(["complexity_rates", "module_rates", "service_rules", "product_type_overrides", "all"]).default("module_rates"),
  operation: z.enum(["percent", "fixed_cents"]),
  delta_value: z.number().finite(),
  target_codes: z.array(z.string().trim().min(1)).optional(),
  dry_run: z.boolean().default(true),
  note: z.string().trim().max(500).optional(),
});

export type PricingLineItem = {
  code: string;
  module_code: string | null;
  option_code: string | null;
  label_zh: string;
  label_en: string;
  billing_unit: BillingUnit;
  quantity: number;
  unit_cents: number;
  amount_cents: number;
  source_rule: string;
  disclosure?: string;
};

export type CompiledTaskPlan = {
  service_type: "inspection" | "compare" | "reference_match";
  product_type_code: string;
  billing_unit: string;
  base_task_count: number;
  included_components: string[];
  comparison_group_size: number;
  golden_sample_call_batches: number;
  golden_sample_match_count: number;
  golden_sample_archive_count: number;
  module_coverages: { module_code: string; option_code: string; task_count: number; billing_unit: string }[];
};

export type CatalogPricingContext = {
  product_type_code: string;
  category_slug: string;
  category_status: string;
  product_type_status: string;
  public_sellable: boolean;
  capability_status: string;
  quote_mode: string;
  default_complexity_code: "L1" | "L2" | "L3" | "L4" | "L5";
  billing_unit: string;
  included_components: string[];
  applicable_module_codes: string[];
  name_zh: string;
  name_en: string;
};

export type UnifiedQuoteCalculation = {
  service_type: "inspection" | "compare" | "reference_match";
  currency: string;
  rounding_mode: "ceil" | "round" | "floor";
  product_type_code: string;
  base_qty: number;
  line_items: PricingLineItem[];
  compiled_task_plan: CompiledTaskPlan;
  subtotal_cents: number;
  discount_cents: number;
  minimum_topup_cents: number;
  total_cents: number;
  manual_quote_required: boolean;
  manual_quote_reasons: string[];
  disclosures: string[];
};

function applyRounding(value: number, mode: "ceil" | "round" | "floor"): number {
  if (mode === "floor") return Math.max(1, Math.floor(value));
  if (mode === "round") return Math.max(1, Math.round(value));
  return Math.max(1, Math.ceil(value));
}

function assertValidBookConfiguration(book: z.output<typeof savePricingBookSchema>) {
  for (const level of ["L1", "L2", "L3", "L4", "L5"] as const) {
    guard(Boolean(book.complexity_rates[level]), "PRICING_INCOMPLETE", `Missing complexity rate '${level}'.`, 422);
    if (level !== "L5" && !book.complexity_rates[level]!.manual_quote) {
      guard(
        book.complexity_rates[level]!.unit_cents !== null && book.complexity_rates[level]!.unit_cents! > 0,
        "PRICING_INVALID_RATE",
        `Complexity '${level}' must specify positive integer unit_cents.`,
        422,
      );
    }
  }
  if (book.auto_volume_discount_enabled) {
    guard(
      Boolean(book.volume_discount_justification && book.volume_discount_justification.trim().length >= 5),
      "VOLUME_DISCOUNT_JUSTIFICATION_REQUIRED",
      "Enabling automatic volume discounts requires documented labor-savings justification (§06/§43.1).",
      422,
    );
  }
  const modCodes = Object.keys(book.module_rates);
  guard(modCodes.includes("M01") && modCodes.includes("M02"), "PRICING_INCOMPLETE", "Modules M01 and M02 must exist.", 422);
  for (const [mCode, mod] of Object.entries(book.module_rates)) {
    guard(Boolean(mod.options[mod.default_option]), "PRICING_INVALID_DEFAULT", `Module '${mCode}' default_option missing.`, 422);
    guard(!mod.mutually_exclusive_with.includes(mCode), "PRICING_CONFLICT_CONFIG", `Module '${mCode}' cannot exclude itself.`, 422);
    for (const reqCode of mod.requires) {
      guard(Boolean(book.module_rates[reqCode]), "PRICING_MISSING_DEP", `Module '${mCode}' requires unknown module '${reqCode}'.`, 422);
      guard(
        !mod.mutually_exclusive_with.includes(reqCode) && !(book.module_rates[reqCode]?.mutually_exclusive_with ?? []).includes(mCode),
        "PRICING_CONFLICT_CONFIG",
        `Module '${mCode}' conflicts symmetrically with required dependency '${reqCode}'.`,
        422,
      );
    }
  }

  // DFS cycle detection and transitive dependency-exclusion conflict check (§09)
  const color = new Map<string, 0 | 1 | 2>();
  const depsClosure = new Map<string, Set<string>>();
  const visit = (code: string): Set<string> => {
    const state = color.get(code) ?? 0;
    guard(state !== 1, "MODULE_DEPENDENCY_CYCLE", `Cyclic module dependency detected involving '${code}'.`, 422);
    if (state === 2) return depsClosure.get(code)!;
    color.set(code, 1);
    const closure = new Set<string>();
    const def = book.module_rates[code];
    if (def) {
      for (const req of def.requires) {
        closure.add(req);
        for (const t of visit(req)) closure.add(t);
      }
    }
    color.set(code, 2);
    depsClosure.set(code, closure);
    return closure;
  };
  for (const mCode of modCodes) {
    const closure = visit(mCode);
    const def = book.module_rates[mCode]!;
    for (const dep of closure) {
      guard(
        !def.mutually_exclusive_with.includes(dep) && !(book.module_rates[dep]?.mutually_exclusive_with ?? []).includes(mCode),
        "PRICING_CONFLICT_CONFIG",
        `Module '${mCode}' transitively requires '${dep}' which is mutually exclusive.`,
        422,
      );
    }
  }
}

/**
 * Pure deterministic integer-cents quote calculator implementing §06–§08 & §43.1–§43.2.
 * Never trusts client-supplied amounts, enforces exact dependency/exclusion rules, and hides L1–L5 codes from non-staff callers.
 */
export function calculateUnifiedQuote(
  rawBook: Record<string, any>,
  catalogCtx: CatalogPricingContext,
  req: z.infer<typeof quoteRequestSchema>,
  opts: { callerIsStaff?: boolean } = {},
): UnifiedQuoteCalculation {
  const callerIsStaff = Boolean(opts.callerIsStaff);
  const manualReasons: string[] = [];
  const disclosures: string[] = [
    "Sample inspection coverage rates verify only submitted units and are never an AQL or full-batch quality certification (§06).",
  ];

  // Category & capability gate (G01 / AT-15 / T02) — staff-only simulation override never available to customers/anon
  const allowUnpub = callerIsStaff && req.quote_kind === "simulation" && req.allow_unpublished_catalog_in_sim;
  if (!allowUnpub) {
    guard(
      catalogCtx.category_status.toUpperCase() === "ACTIVE" &&
        catalogCtx.product_type_status === "published" &&
        catalogCtx.public_sellable &&
        catalogCtx.capability_status === "ready",
      "CATEGORY_NOT_ACTIVE",
      `Product type '${catalogCtx.product_type_code}' (${catalogCtx.category_slug}) is not active/published for quoting.`,
      422,
    );
  }

  const complexityRates = rawBook.complexity_rates as Record<string, z.infer<typeof complexityRateItemSchema>>;
  const moduleRates = rawBook.module_rates as Record<string, z.infer<typeof moduleRateSchema>>;
  const serviceRules = rawBook.service_rules as z.infer<typeof serviceRulesSchema>;
  const roundingMode: "ceil" | "round" | "floor" = rawBook.rounding_mode ?? "ceil";
  const currency = String(rawBook.currency ?? "USD");

  // 1. Validate & deduplicate selected modules (M01 base deduplication, M02 extra_point composition, dependency & exclusion)
  const selectedModules: {
    module_code: string;
    option_code: string;
    resolved_qty: number;
    billing_unit: BillingUnit;
    disclosure?: string;
  }[] = [];
  const seenPrimaryModuleCodes = new Set<string>();
  const seenExactOptionKeys = new Set<string>();

  for (const sel of req.modules) {
    if (sel.module_code === "M01") {
      // §06/§43: M01 is bundled into base unit inspection rate; deduplicate cleanly without double-charging
      continue;
    }
    const modDef = moduleRates[sel.module_code];
    guard(modDef, "UNKNOWN_MODULE", `Module '${sel.module_code}' is not configured in pricing book.`, 422);
    if (!allowUnpub && catalogCtx.applicable_module_codes.length > 0) {
      guard(
        catalogCtx.applicable_module_codes.includes(sel.module_code),
        "MODULE_NOT_APPLICABLE",
        `Module '${sel.module_code}' is not enabled for product type '${catalogCtx.product_type_code}'.`,
        422,
      );
    }

    const optCode = sel.option_code ?? modDef.default_option;
    const optDef = modDef.options[optCode];
    guard(optDef, "INVALID_MODULE_OPTION", `Option '${optCode}' not found on module '${sel.module_code}'.`, 422);

    const exactKey = `${sel.module_code}:${optCode}`;
    guard(!seenExactOptionKeys.has(exactKey), "MODULE_CONFLICT", `Duplicate module option '${exactKey}'.`, 422);
    seenExactOptionKeys.add(exactKey);

    // Allow M02 base POM tier (`points_3`/`points_5`/`points_8`) to combine with `extra_point`, while blocking conflicting base tiers!
    const isAdditiveExtraPoint = sel.module_code === "M02" && optCode === "extra_point";
    if (!isAdditiveExtraPoint) {
      guard(
        !seenPrimaryModuleCodes.has(sel.module_code),
        "MODULE_CONFLICT",
        `Module '${sel.module_code}' cannot be selected twice or with conflicting tier options.`,
        422,
      );
      seenPrimaryModuleCodes.add(sel.module_code);
    }

    if (optDef.requires_destructive_auth) {
      guard(
        req.customer_authorized_destructive === true,
        "DESTRUCTIVE_AUTHORIZATION_REQUIRED",
        `Option '${sel.module_code}:${optCode}' requires explicit customer destructive sample authorization.`,
        422,
      );
    }

    const effectiveBillingUnit = (optDef.billing_unit ?? modDef.billing_unit) as BillingUnit;
    const boundedByBaseQty = effectiveBillingUnit === "per_piece" || effectiveBillingUnit === "per_set";

    let resolvedQty: number;
    let covDisclosure: string | undefined;
    if (sel.coverage_mode === "percentage") {
      guard(typeof sel.coverage_pct === "number", "INVALID_COVERAGE", "Percentage coverage requires coverage_pct.", 422);
      const rawCount = (req.base_qty * sel.coverage_pct) / 100;
      resolvedQty = Math.min(req.base_qty, applyRounding(rawCount, roundingMode));
      covDisclosure = `百分比取整（${roundingMode}）：${req.base_qty} × ${sel.coverage_pct}% = ${resolvedQty} 件/次`;
      disclosures.push(covDisclosure);
    } else {
      resolvedQty = sel.coverage_qty ?? (boundedByBaseQty ? req.base_qty : 1);
      guard(resolvedQty >= 1, "INVALID_COVERAGE_QTY", `Coverage quantity for '${sel.module_code}' must be >= 1.`, 422);
      if (boundedByBaseQty) {
        guard(
          resolvedQty <= req.base_qty,
          "INVALID_COVERAGE_QTY",
          `Per-item/set coverage quantity (${resolvedQty}) for '${sel.module_code}' cannot exceed base_qty (${req.base_qty}).`,
          422,
        );
      }
    }

    if (optDef.manual_quote) {
      manualReasons.push(`Module ${sel.module_code}:${optCode} requires manual review quote.`);
    }

    selectedModules.push({
      module_code: sel.module_code,
      option_code: optCode,
      resolved_qty: resolvedQty,
      billing_unit: effectiveBillingUnit,
      disclosure: covDisclosure,
    });

    // If extra_points inline shorthand is specified on M02 base tier, add M02:extra_point itemized charge cleanly
    if (sel.module_code === "M02" && sel.extra_points && sel.extra_points > 0 && !isAdditiveExtraPoint) {
      guard(Boolean(modDef.options.extra_point), "INVALID_MODULE_OPTION", "M02:extra_point is not configured in pricing book.", 422);
      guard(!seenExactOptionKeys.has("M02:extra_point"), "MODULE_CONFLICT", "Cannot combine inline extra_points with separate M02:extra_point entry.", 422);
      seenExactOptionKeys.add("M02:extra_point");
      selectedModules.push({
        module_code: "M02",
        option_code: "extra_point",
        resolved_qty: sel.extra_points * resolvedQty,
        billing_unit: (modDef.options.extra_point!.billing_unit ?? "per_measurement_point") as BillingUnit,
        disclosure: `加测点位：${resolvedQty} 件 × 每件加测 ${sel.extra_points} 点 = ${sel.extra_points * resolvedQty} 点次`,
      });
    }
  }

  // Enforce bidirectional inter-module dependencies & mutual exclusions
  const activeSet = new Set(["M01", ...selectedModules.map((m) => m.module_code)]);
  for (const m of selectedModules) {
    const def = moduleRates[m.module_code]!;
    for (const reqDep of def.requires) {
      guard(activeSet.has(reqDep), "MODULE_DEPENDENCY_MISSING", `Module '${m.module_code}' requires module '${reqDep}' to be selected.`, 422);
    }
    for (const conflict of def.mutually_exclusive_with) {
      guard(!activeSet.has(conflict), "MODULE_CONFLICT", `Module '${m.module_code}' is mutually exclusive with '${conflict}'.`, 422);
    }
  }

  // 2. Determine authoritative unit base rate (Customer override -> ProductType override -> Complexity rate; NO unintended stacking)
  const customerOv = req.org_id ? rawBook.customer_overrides?.[req.org_id] : undefined;
  const ptOv = rawBook.product_type_overrides?.[catalogCtx.product_type_code];
  const compDef = complexityRates[catalogCtx.default_complexity_code];
  guard(compDef, "PRICING_MISSING_COMPLEXITY", "No base complexity rate configured for selected product type.", 422);

  let baseUnitCents = 0;
  let baseSourceRule = callerIsStaff ? `complexity:${catalogCtx.default_complexity_code}` : "complexity_tier";
  if (typeof customerOv?.product_type_unit_cents?.[catalogCtx.product_type_code] === "number") {
    baseUnitCents = Number(customerOv.product_type_unit_cents[catalogCtx.product_type_code]);
    baseSourceRule = `customer_override:product_type:${catalogCtx.product_type_code}`;
  } else if (typeof customerOv?.complexity_unit_cents?.[catalogCtx.default_complexity_code] === "number") {
    baseUnitCents = Number(customerOv.complexity_unit_cents[catalogCtx.default_complexity_code]);
    baseSourceRule = callerIsStaff
      ? `customer_override:complexity:${catalogCtx.default_complexity_code}`
      : "customer_override:complexity_tier";
  } else if (typeof ptOv?.unit_cents === "number") {
    baseUnitCents = Number(ptOv.unit_cents);
    baseSourceRule = `product_type_override:${catalogCtx.product_type_code}`;
    if (ptOv.manual_quote) manualReasons.push(`Product type '${catalogCtx.product_type_code}' flagged for manual quote.`);
  } else if (compDef.manual_quote || compDef.unit_cents === null) {
    baseUnitCents = 0;
    manualReasons.push(
      callerIsStaff
        ? `Complexity '${catalogCtx.default_complexity_code}' or special craft requires manual quote.`
        : "Special craft or complexity requires manual review quote.",
    );
  } else {
    baseUnitCents = compDef.unit_cents;
  }

  if (catalogCtx.quote_mode === "manual_quote") {
    manualReasons.push(`Product type '${catalogCtx.product_type_code}' requires manual quote mode.`);
  }

  const maxOnlineQty = Number(rawBook.max_online_quantity ?? 300);
  if (req.base_qty > maxOnlineQty) {
    manualReasons.push(`Quantity (${req.base_qty}) exceeds online limit (${maxOnlineQty}).`);
  }

  const unitBilling: BillingUnit = catalogCtx.billing_unit === "set" ? "per_set" : "per_piece";
  const lineItems: PricingLineItem[] = [];

  // Base M01 unit line (set billed per_set; never leak L1-L5 code outside staff!)
  lineItems.push({
    code: callerIsStaff ? `BASE_${catalogCtx.default_complexity_code}` : "BASE_INSPECTION",
    module_code: "M01",
    option_code: "standard",
    label_zh: `基础核验与外观检查 (${catalogCtx.name_zh})`,
    label_en: `Base Inspection M01 (${catalogCtx.name_en})`,
    billing_unit: unitBilling,
    quantity: req.base_qty,
    unit_cents: baseUnitCents,
    amount_cents: baseUnitCents * req.base_qty,
    source_rule: baseSourceRule,
  });

  // 3. Service-specific comparison & golden-sample pricing (§07, §08, §43.2)
  let comparisonGroupSize = 0;
  let goldenCallBatches = 0;
  let goldenMatchCount = 0;

  if (req.service_type === "compare") {
    guard(req.base_qty >= 2, "COMPARE_MIN_ITEMS", "Sample comparison requires at least 2 items.", 422);
    comparisonGroupSize = req.base_qty;
    if (req.base_qty > serviceRules.compare_max_online_items) {
      manualReasons.push(`Comparison group size (${req.base_qty}) exceeds online max (${serviceRules.compare_max_online_items}).`);
    }
    const compareFee =
      req.base_qty === 2
        ? serviceRules.compare_2_items_cents
        : req.base_qty === 3
          ? serviceRules.compare_3_items_cents
          : serviceRules.compare_3_items_cents + (req.base_qty - 3) * serviceRules.compare_extra_item_cents;

    lineItems.push({
      code: "SERVICE_COMPARE_GROUP",
      module_code: null,
      option_code: `compare_${req.base_qty}`,
      label_zh: `横向样品比较服务费 (${req.base_qty} 件同条件摄影+差异矩阵)`,
      label_en: `Side-by-Side Comparison Fee (${req.base_qty} samples + matrix)`,
      billing_unit: "per_comparison_group",
      quantity: 1,
      unit_cents: compareFee,
      amount_cents: compareFee,
      source_rule: "service_rules:compare",
    });
  } else if (req.service_type === "reference_match") {
    const uniqueGoldenIds = [...new Set(req.golden_sample_ids)];
    guard(uniqueGoldenIds.length >= 1, "GOLDEN_SAMPLE_REQUIRED", "Reference matching requires at least one Golden Sample ID.", 422);
    // §08 / §43.2: Retrieval/resealing batch call charged ONCE per unique Golden Sample per batch (not per matched unit!)
    goldenCallBatches = uniqueGoldenIds.length;
    goldenMatchCount = req.base_qty;

    lineItems.push({
      code: "GOLDEN_SAMPLE_BATCH_CALL",
      module_code: null,
      option_code: "batch_call",
      label_zh: `调用/启封/复封确认样批次费 (${goldenCallBatches} 份独立确认样)`,
      label_en: `Golden Sample Retrieval & Reseal Batch Fee (${goldenCallBatches} unique reference)`,
      billing_unit: "per_golden_sample_call",
      quantity: goldenCallBatches,
      unit_cents: serviceRules.golden_call_batch_cents,
      amount_cents: goldenCallBatches * serviceRules.golden_call_batch_cents,
      source_rule: "service_rules:golden_call_batch",
    });

    lineItems.push({
      code: "GOLDEN_SAMPLE_MATCH_EXEC",
      module_code: null,
      option_code: "per_item_match",
      label_zh: "新样品与确认样逐件比对匹配服务费",
      label_en: "Per-Unit Golden Sample Matching Execution",
      billing_unit: "per_piece",
      quantity: req.base_qty,
      unit_cents: serviceRules.golden_match_item_cents,
      amount_cents: req.base_qty * serviceRules.golden_match_item_cents,
      source_rule: "service_rules:golden_match_item",
    });
  }

  // Archiving/sealing new Golden Samples can occur with ANY service_type (inspection, compare, or reference_match)
  if (req.archive_new_golden_samples > 0) {
    lineItems.push({
      code: "GOLDEN_SAMPLE_ARCHIVE_SEAL",
      module_code: null,
      option_code: "archive_seal",
      label_zh: "新建确认样建档与专柜封存费",
      label_en: "New Golden Sample Archival & Sealing Fee",
      billing_unit: "per_golden_sample",
      quantity: req.archive_new_golden_samples,
      unit_cents: serviceRules.golden_archive_seal_cents,
      amount_cents: req.archive_new_golden_samples * serviceRules.golden_archive_seal_cents,
      source_rule: "service_rules:golden_archive_seal",
    });
  }

  // 4. Add-on module lines
  const moduleCoverages: CompiledTaskPlan["module_coverages"] = [
    { module_code: "M01", option_code: "standard", task_count: req.base_qty, billing_unit: unitBilling },
  ];

  for (const m of selectedModules) {
    const modDef = moduleRates[m.module_code]!;
    const optDef = modDef.options[m.option_code]!;
    lineItems.push({
      code: `${m.module_code}_${m.option_code}`.toUpperCase(),
      module_code: m.module_code,
      option_code: m.option_code,
      label_zh: `${modDef.name_zh} · ${optDef.label_zh}`,
      label_en: `${modDef.name_en} · ${optDef.label_en}`,
      billing_unit: m.billing_unit,
      quantity: m.resolved_qty,
      unit_cents: optDef.unit_cents,
      amount_cents: optDef.unit_cents * m.resolved_qty,
      source_rule: `module_rates:${m.module_code}:${m.option_code}`,
      ...(m.disclosure ? { disclosure: m.disclosure } : {}),
    });
    moduleCoverages.push({
      module_code: m.module_code,
      option_code: m.option_code,
      task_count: m.resolved_qty,
      billing_unit: m.billing_unit,
    });
  }

  const fixedFeeCents = Number(rawBook.order_fixed_fee_cents ?? 0);
  if (fixedFeeCents > 0) {
    lineItems.push({
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

  const subtotalCents = lineItems.reduce((acc, item) => acc + item.amount_cents, 0);

  // 5. Explicit Discount & Conflict Rules (NO hidden automatic volume discounts!)
  let discountCents = 0;
  const promoCodes = [...new Set(req.promo_codes.map((p) => p.toUpperCase()))];
  if (promoCodes.length > 0) {
    const ruleMap = new Map(
      ((rawBook.discount_rules as z.infer<typeof discountRuleSchema>[] | undefined) ?? [])
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
        lineItems.push({
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

  if (req.apply_volume_discount) {
    guard(
      rawBook.auto_volume_discount_enabled === true,
      "VOLUME_DISCOUNT_DISABLED",
      "Automatic quantity discounts are disabled by policy (§06/§43.1).",
      422,
    );
    const tiers = ([...((rawBook.volume_discount_tiers as z.infer<typeof volumeDiscountTierSchema>[] | undefined) ?? [])]).sort(
      (a, b) => b.min_qty - a.min_qty,
    );
    const hit = tiers.find((t) => req.base_qty >= t.min_qty);
    if (hit) {
      const off = Math.min(subtotalCents - discountCents, Math.floor(((subtotalCents - discountCents) * hit.percent_off) / 100));
      if (off > 0) {
        discountCents += off;
        lineItems.push({
          code: `VOLUME_DISCOUNT_${hit.min_qty}PLUS`,
          module_code: null,
          option_code: `pct_${hit.percent_off}`,
          label_zh: `经工时验证批量效率减免 (${hit.min_qty}+ 件 ${hit.percent_off}%)`,
          label_en: `Labor-Verified Batch Efficiency Discount (${hit.min_qty}+ units ${hit.percent_off}% off)`,
          billing_unit: "per_order",
          quantity: 1,
          unit_cents: -off,
          amount_cents: -off,
          source_rule: `volume_discount_tiers:min_${hit.min_qty}`,
        });
      }
    }
  }

  const afterDiscount = Math.max(0, subtotalCents - discountCents);

  // 6. Minimum Order Fee (always transparent line item, NEVER hidden in total!)
  const minOrderCents = Number(rawBook.minimum_order_cents ?? 0);
  let minimumTopupCents = 0;
  if (minOrderCents > 0 && afterDiscount > 0 && afterDiscount < minOrderCents) {
    minimumTopupCents = minOrderCents - afterDiscount;
    lineItems.push({
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
  const maxOnlineTotalCents = Number(rawBook.max_online_total_cents ?? 5_000_000);
  if (totalCents > maxOnlineTotalCents) {
    manualReasons.push(`Order total (${totalCents} cents) exceeds online checkout ceiling (${maxOnlineTotalCents} cents).`);
  }

  return {
    service_type: req.service_type,
    currency,
    rounding_mode: roundingMode,
    product_type_code: catalogCtx.product_type_code,
    base_qty: req.base_qty,
    line_items: lineItems,
    compiled_task_plan: {
      service_type: req.service_type,
      product_type_code: catalogCtx.product_type_code,
      billing_unit: catalogCtx.billing_unit,
      base_task_count: req.base_qty,
      included_components: catalogCtx.included_components,
      comparison_group_size: comparisonGroupSize,
      golden_sample_call_batches: goldenCallBatches,
      golden_sample_match_count: goldenMatchCount,
      golden_sample_archive_count: req.archive_new_golden_samples,
      module_coverages: moduleCoverages,
    },
    subtotal_cents: subtotalCents,
    discount_cents: discountCents,
    minimum_topup_cents: minimumTopupCents,
    total_cents: totalCents,
    manual_quote_required: manualReasons.length > 0,
    manual_quote_reasons: manualReasons,
    disclosures,
  };
}

/**
 * Evaluates all 4 mandatory §43.2 worked scenarios against a given book snapshot.
 */
export function runSection43WorkedExamples(rawBook: Record<string, any>) {
  const sampleTeeCtx: CatalogPricingContext = {
    product_type_code: "t_shirt",
    category_slug: "apparel",
    category_status: "ACTIVE",
    product_type_status: "published",
    public_sellable: true,
    capability_status: "ready",
    quote_mode: "online_standard",
    default_complexity_code: "L1",
    billing_unit: "piece",
    included_components: [],
    applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09", "M10"],
    name_zh: "T恤",
    name_en: "T-Shirt",
  };

  const s1 = calculateUnifiedQuote(
    rawBook,
    sampleTeeCtx,
    quoteRequestSchema.parse({
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 1,
      modules: [{ module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 1 }],
      quote_kind: "simulation",
      allow_unpublished_catalog_in_sim: true,
    }),
    { callerIsStaff: true },
  );

  const s2 = calculateUnifiedQuote(
    rawBook,
    sampleTeeCtx,
    quoteRequestSchema.parse({
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 50,
      modules: [
        { module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 10 },
        { module_code: "M04", option_code: "standard", coverage_mode: "exact_count", coverage_qty: 5 },
      ],
      quote_kind: "simulation",
      allow_unpublished_catalog_in_sim: true,
    }),
    { callerIsStaff: true },
  );

  const s3 = calculateUnifiedQuote(
    rawBook,
    sampleTeeCtx,
    quoteRequestSchema.parse({
      service_type: "compare",
      product_type_code: "t_shirt",
      base_qty: 3,
      modules: [
        { module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 3 },
        { module_code: "M04", option_code: "standard", coverage_mode: "exact_count", coverage_qty: 3 },
        { module_code: "M03", option_code: "standard", coverage_mode: "exact_count", coverage_qty: 3 },
      ],
      quote_kind: "simulation",
      allow_unpublished_catalog_in_sim: true,
    }),
    { callerIsStaff: true },
  );

  const s4 = calculateUnifiedQuote(
    rawBook,
    sampleTeeCtx,
    quoteRequestSchema.parse({
      service_type: "reference_match",
      product_type_code: "t_shirt",
      base_qty: 5,
      golden_sample_ids: ["GS-BASELINE-1"],
      modules: [{ module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 5 }],
      quote_kind: "simulation",
      allow_unpublished_catalog_in_sim: true,
    }),
    { callerIsStaff: true },
  );

  return [
    { key: "ex1_single_l1_m01_m02", expected_cents: 1700, matched: s1.total_cents === 1700, result: s1 },
    { key: "ex2_batch_50_partial_10m02_5m04", expected_cents: 40500, matched: s2.total_cents === 40500, result: s2 },
    { key: "ex3_compare_3_l1_full", expected_cents: 12200, matched: s3.total_cents === 12200, result: s3 },
    { key: "ex4_golden_match_5_l1_same_ref", expected_cents: 13500, matched: s4.total_cents === 13500, result: s4 },
  ];
}

async function loadCatalogPricingContext(db: DB, productTypeCode: string): Promise<CatalogPricingContext> {
  const row = (
    await db.query<{
      code: string;
      category_slug: string;
      category_status: string;
      status: string;
      public_sellable: boolean;
      capability_status: string;
      quote_mode: string;
      default_complexity_code: string;
      billing_unit: string;
      included_components: unknown;
      applicable_module_codes: string[];
      name_zh: string;
      name_en: string;
    }>(
      `select
         pt.code, pt.category_slug, c.status as category_status,
         pt.status, pt.public_sellable, pt.capability_status, pt.quote_mode,
         pt.default_complexity_code, pt.billing_unit, pt.included_components,
         pt.applicable_module_codes, pt.name_zh, pt.name_en
       from catalog_product_types pt
       join categories c on c.slug = pt.category_slug
       where pt.code = $1`,
      [productTypeCode],
    )
  ).rows[0];
  guard(row, "NOT_FOUND", `Product type '${productTypeCode}' not found in catalog.`, 404);
  return {
    product_type_code: row.code,
    category_slug: row.category_slug,
    category_status: row.category_status,
    product_type_status: row.status,
    public_sellable: row.public_sellable,
    capability_status: row.capability_status,
    quote_mode: row.quote_mode,
    default_complexity_code: (row.default_complexity_code as CatalogPricingContext["default_complexity_code"]) || "L2",
    billing_unit: row.billing_unit || "piece",
    included_components: Array.isArray(row.included_components) ? row.included_components.map(String) : [],
    applicable_module_codes: Array.isArray(row.applicable_module_codes) ? row.applicable_module_codes : [],
    name_zh: row.name_zh,
    name_en: row.name_en,
  };
}

async function applyPricingBookTranslations(
  db: DB,
  bookId: string,
  snap: Record<string, any>,
  opts: { verifyFrozenSource?: boolean } = {},
) {
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
       where entity_type = 'pricing_book'
         and entity_id = $1::uuid
         and status = 'published'
       order by field_key, locale, revision desc`,
      [bookId],
    )
  ).rows;
  if (rows.length === 0) return snap;

  const byKey = new Map(rows.map((r) => [`${r.field_key}:${r.locale}`, r]));
  const pick = (fk: string, locale: "zh-CN" | "en-US", fallback: string, sourceZh: string) => {
    const r = byKey.get(`${fk}:${locale}`);
    if (!r || !r.translated_text) return fallback;
    if (opts.verifyFrozenSource && r.source_hash && r.source_hash !== hash(sourceZh) && r.source_text !== sourceZh) {
      return fallback;
    }
    return r.translated_text;
  };

  return {
    ...snap,
    name_zh: pick("name", "zh-CN", String(snap.name_zh ?? ""), String(snap.name_zh ?? "")),
    name_en: pick("name", "en-US", String(snap.name_en ?? ""), String(snap.name_zh ?? "")),
    description_zh: pick("description", "zh-CN", String(snap.description_zh ?? ""), String(snap.description_zh ?? "")),
    description_en: pick("description", "en-US", String(snap.description_en ?? ""), String(snap.description_zh ?? "")),
  };
}

async function resolveCurrentEffectiveVersion(db: DB) {
  return (
    await db.query<{
      book_id: string;
      version_id: string;
      version: number;
      publication_scope: string;
      business_approved: boolean;
      effective_snapshot: Record<string, any>;
      published_at: Date;
      effective_from: Date;
    }>(
      `select b.id as book_id, v.id as version_id, v.version, v.publication_scope, v.business_approved,
              v.effective_snapshot, v.published_at, v.effective_from
       from pricing_books b
       join pricing_book_versions v on v.book_id = b.id
       where b.status <> 'retired'
         and v.state = 'PUBLISHED'
         and v.effective_from <= now()
       order by v.effective_from desc, v.version desc, b.code asc
       limit 1`,
    )
  ).rows[0] ?? null;
}

export async function getPricingOverview(db: DB, actor: Actor) {
  role(actor, ...PRICING_READ_ROLES);
  const summary = (
    await db.query(`
      select
        count(*)::int as total_books,
        count(*) filter (where status = 'published')::int as published_books,
        count(*) filter (where status = 'draft')::int as draft_books,
        count(*) filter (where status = 'in_review')::int as in_review_books,
        count(*) filter (where status = 'retired')::int as retired_books
      from pricing_books
    `)
  ).rows[0];
  const versionsCount = (await db.query<{ n: number }>("select count(*)::int n from pricing_book_versions")).rows[0]!.n;
  const openQuotesCount = (await db.query<{ n: number }>("select count(*)::int n from pricing_quotes where status in ('open','locked')")).rows[0]!.n;
  const seedRuns = (await db.query("select * from pricing_seed_runs order by ran_at desc limit 10")).rows;
  return {
    summary: { ...summary, versions_total: versionsCount, quotes_total: openQuotesCount },
    billing_units: BILLING_UNITS,
    seed_runs: seedRuns,
  };
}

export async function listPricingBooks(db: DB, actor: Actor, filters: { status?: string; search?: string } = {}) {
  role(actor, ...PRICING_READ_ROLES);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    where.push(`b.status = $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(b.code ilike ${p} or b.name_zh ilike ${p} or b.name_en ilike ${p})`);
  }
  const rows = (
    await db.query(
      `select b.*, v.version as published_version, v.published_at as version_published_at, v.business_approved
       from pricing_books b
       left join pricing_book_versions v on v.id = b.latest_published_version_id
       ${where.length ? `where ${where.join(" and ")}` : ""}
       order by b.created_at asc, b.code asc`,
      params,
    )
  ).rows;
  return { books: rows };
}

export async function getPricingBookDetail(db: DB, actor: Actor, id: string) {
  role(actor, ...PRICING_READ_ROLES);
  const book = await one<Record<string, any>>(db, "select * from pricing_books where id = $1::uuid", [id]);
  const versions = (
    await db.query(
      `select id, book_id, book_code, version, state, publication_scope, business_approved,
              content_hash, prepublish_checks, author_id, submitted_by, reviewer_id, note, effective_from, published_at, retired_at
       from pricing_book_versions
       where book_id = $1::uuid
       order by version desc`,
      [id],
    )
  ).rows;
  const workedExamples = runSection43WorkedExamples(book);
  return { book, versions, worked_examples: workedExamples };
}

export async function savePricingBookDraft(db: DB, actor: Actor, rawInput: unknown, sessionHash: string) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "pricing_books:write");

  const input = savePricingBookSchema.parse(rawInput);
  assertValidBookConfiguration(input);

  const existing = input.id
    ? (await db.query<{ id: string; status: string }>("select id, status from pricing_books where id = $1::uuid for update", [input.id])).rows[0]
    : null;
  if (input.id) {
    guard(existing, "NOT_FOUND", "Pricing book not found.", 404);
  }
  if (!input.id) {
    const clash = (await db.query<{ id: string }>("select id from pricing_books where code = $1", [input.code])).rows[0];
    guard(!clash, "DUPLICATE_PRICING_BOOK_CODE", `Pricing book '${input.code}' already exists.`, 409);
  }

  const row = existing
    ? await one<Record<string, unknown>>(
        db,
        `update pricing_books set
          name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
          currency = $6, rounding_mode = $7,
          auto_volume_discount_enabled = $8::boolean, volume_discount_justification = $9,
          minimum_order_cents = $10::int, order_fixed_fee_cents = $11::int,
          max_online_quantity = $12::int, max_online_total_cents = $13::int, quote_validity_hours = $14::int,
          complexity_rates = $15::jsonb, module_rates = $16::jsonb, service_rules = $17::jsonb,
          product_type_overrides = $18::jsonb, customer_overrides = $19::jsonb,
          discount_rules = $20::jsonb, volume_discount_tiers = $21::jsonb, commercial_policy_matrix = $22::jsonb,
          effective_from = $23::timestamptz,
          status = 'draft', current_draft_version = current_draft_version + 1,
          latest_published_version_id = case when $25::text = 'retired' then null else latest_published_version_id end,
          admin_modified = true, created_by = $24::uuid, submitted_by = null, approved_by = null,
          published_at = null, retired_at = null, updated_at = now()
        where id = $1::uuid returning *`,
        [
          existing.id,
          input.name_zh,
          input.name_en,
          input.description_zh,
          input.description_en,
          input.currency,
          input.rounding_mode,
          input.auto_volume_discount_enabled,
          input.volume_discount_justification ?? null,
          input.minimum_order_cents,
          input.order_fixed_fee_cents,
          input.max_online_quantity,
          input.max_online_total_cents,
          input.quote_validity_hours,
          JSON.stringify(input.complexity_rates),
          JSON.stringify(input.module_rates),
          JSON.stringify(input.service_rules),
          JSON.stringify(input.product_type_overrides),
          JSON.stringify(input.customer_overrides),
          JSON.stringify(input.discount_rules),
          JSON.stringify(input.volume_discount_tiers),
          JSON.stringify(input.commercial_policy_matrix),
          input.effective_from ?? null,
          actor.id,
          existing.status,
        ],
      )
    : await one<Record<string, unknown>>(
        db,
        `insert into pricing_books (
          code, name_zh, name_en, description_zh, description_en,
          currency, rounding_mode, auto_volume_discount_enabled, volume_discount_justification,
          minimum_order_cents, order_fixed_fee_cents, max_online_quantity, max_online_total_cents, quote_validity_hours,
          complexity_rates, module_rates, service_rules,
          product_type_overrides, customer_overrides, discount_rules, volume_discount_tiers, commercial_policy_matrix,
          effective_from, status, publication_scope, is_seed_default, admin_modified, created_by
        ) values (
          $1, $2, $3, $4, $5,
          $6, $7, $8::boolean, $9,
          $10::int, $11::int, $12::int, $13::int, $14::int,
          $15::jsonb, $16::jsonb, $17::jsonb,
          $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb,
          $23::timestamptz, 'draft', 'sandbox_acceptance', false, true, $24::uuid
        ) returning *`,
        [
          input.code,
          input.name_zh,
          input.name_en,
          input.description_zh,
          input.description_en,
          input.currency,
          input.rounding_mode,
          input.auto_volume_discount_enabled,
          input.volume_discount_justification ?? null,
          input.minimum_order_cents,
          input.order_fixed_fee_cents,
          input.max_online_quantity,
          input.max_online_total_cents,
          input.quote_validity_hours,
          JSON.stringify(input.complexity_rates),
          JSON.stringify(input.module_rates),
          JSON.stringify(input.service_rules),
          JSON.stringify(input.product_type_overrides),
          JSON.stringify(input.customer_overrides),
          JSON.stringify(input.discount_rules),
          JSON.stringify(input.volume_discount_tiers),
          JSON.stringify(input.commercial_policy_matrix),
          input.effective_from ?? null,
          actor.id,
        ],
      );

  await audit(db, actor, "pricing_book_save_draft", "pricing_books", String(row.id), {
    code: row.code,
    draft_version: row.current_draft_version,
    note: input.note ?? null,
  });
  return row;
}

export async function clonePricingBook(
  db: DB,
  actor: Actor,
  sourceId: string,
  rawInput: { code: string; name_zh: string; name_en: string; note?: string },
  sessionHash: string,
) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const parsed = z
    .object({
      code: z.string().trim().regex(/^[a-z0-9_]{2,80}$/),
      name_zh: z.string().trim().min(1).max(160),
      name_en: z.string().trim().min(1).max(160),
      note: z.string().trim().max(500).optional(),
    })
    .parse(rawInput);

  const clash = (await db.query("select id from pricing_books where code = $1", [parsed.code])).rows[0];
  guard(!clash, "DUPLICATE_PRICING_BOOK_CODE", `Pricing book '${parsed.code}' already exists.`, 409);

  const src = await one<Record<string, any>>(db, "select * from pricing_books where id = $1::uuid", [sourceId]);
  const inserted = await one<Record<string, unknown>>(
    db,
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
      $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb,
      'draft', 'sandbox_acceptance', false, true, $23::uuid
    ) returning *`,
    [
      parsed.code,
      parsed.name_zh,
      parsed.name_en,
      src.description_zh,
      src.description_en,
      src.currency,
      src.rounding_mode,
      src.auto_volume_discount_enabled,
      src.volume_discount_justification ?? null,
      src.minimum_order_cents,
      src.order_fixed_fee_cents,
      src.max_online_quantity,
      src.max_online_total_cents,
      src.quote_validity_hours,
      JSON.stringify(src.complexity_rates),
      JSON.stringify(src.module_rates),
      JSON.stringify(src.service_rules),
      JSON.stringify(src.product_type_overrides ?? {}),
      JSON.stringify(src.customer_overrides ?? {}),
      JSON.stringify(src.discount_rules ?? []),
      JSON.stringify(src.volume_discount_tiers ?? []),
      JSON.stringify(src.commercial_policy_matrix ?? {}),
      actor.id,
    ],
  );
  await audit(db, actor, "pricing_book_clone", "pricing_books", String(inserted.id), {
    source_id: sourceId,
    code: parsed.code,
    note: parsed.note ?? null,
  });
  return inserted;
}

export async function batchAdjustPricingBook(
  db: DB,
  actor: Actor,
  id: string,
  rawInput: unknown,
  sessionHash: string,
) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = batchAdjustSchema.parse(rawInput);

  const cur = await one<Record<string, any>>(db, "select * from pricing_books where id = $1::uuid for update", [id]);
  guard(cur.status !== "retired", "INVALID_STATE", "Cannot batch-adjust a retired pricing book; rollback to draft first.", 422);

  const nextComp = structuredClone(cur.complexity_rates) as Record<string, any>;
  const nextMods = structuredClone(cur.module_rates) as Record<string, any>;
  const nextSvc = structuredClone(cur.service_rules) as Record<string, any>;
  const nextPtOv = structuredClone(cur.product_type_overrides ?? {}) as Record<string, any>;
  const diffs: { target: string; before_cents: number; after_cents: number }[] = [];
  const targets = input.target_codes ? new Set(input.target_codes) : null;

  const adjustVal = (oldVal: number, minVal = 0) => {
    const next =
      input.operation === "percent"
        ? Math.round(oldVal * (1 + input.delta_value / 100))
        : Math.round(oldVal + input.delta_value);
    guard(next >= minVal && next <= 500_000, "PRICING_INVALID_RATE", `Adjusted rate ${next} cents out of valid [${minVal}..500000] bounds.`, 422);
    return next;
  };

  if (input.scope === "complexity_rates" || input.scope === "all") {
    for (const [k, def] of Object.entries(nextComp)) {
      if (targets && !targets.has(k)) continue;
      if (def.manual_quote || typeof def.unit_cents !== "number") continue;
      const after = adjustVal(def.unit_cents, 1);
      if (after !== def.unit_cents) diffs.push({ target: `complexity:${k}`, before_cents: def.unit_cents, after_cents: after });
      def.unit_cents = after;
    }
  }
  if (input.scope === "module_rates" || input.scope === "all") {
    for (const [mCode, mod] of Object.entries(nextMods)) {
      if (targets && !targets.has(mCode)) continue;
      if (mod.included_in_base) continue;
      for (const [optKey, optDef] of Object.entries(mod.options as Record<string, any>)) {
        if (optDef.manual_quote || typeof optDef.unit_cents !== "number") continue;
        const after = adjustVal(optDef.unit_cents, 0);
        if (after !== optDef.unit_cents) {
          diffs.push({ target: `module:${mCode}:${optKey}`, before_cents: optDef.unit_cents, after_cents: after });
        }
        optDef.unit_cents = after;
      }
    }
  }
  if (input.scope === "service_rules" || input.scope === "all") {
    for (const key of [
      "compare_2_items_cents",
      "compare_3_items_cents",
      "compare_extra_item_cents",
      "golden_archive_seal_cents",
      "golden_call_batch_cents",
      "golden_match_item_cents",
    ]) {
      if (targets && !targets.has(key)) continue;
      if (typeof nextSvc[key] === "number") {
        const after = adjustVal(nextSvc[key], 0);
        if (after !== nextSvc[key]) diffs.push({ target: `service_rules:${key}`, before_cents: nextSvc[key], after_cents: after });
        nextSvc[key] = after;
      }
    }
  }
  if (input.scope === "product_type_overrides" || input.scope === "all") {
    for (const [ptCode, ov] of Object.entries(nextPtOv)) {
      if (targets && !targets.has(ptCode)) continue;
      if (typeof ov?.unit_cents === "number") {
        const after = adjustVal(ov.unit_cents, 0);
        if (after !== ov.unit_cents) diffs.push({ target: `product_type_override:${ptCode}`, before_cents: ov.unit_cents, after_cents: after });
        ov.unit_cents = after;
      }
    }
  }

  assertValidBookConfiguration({
    ...cur,
    complexity_rates: nextComp,
    module_rates: nextMods,
    service_rules: nextSvc,
    product_type_overrides: nextPtOv,
  } as unknown as z.output<typeof savePricingBookSchema>);

  if (input.dry_run) {
    return { dry_run: true, count: diffs.length, diffs };
  }
  if (diffs.length === 0) {
    return { dry_run: false, count: 0, diffs: [], unchanged: true, book: cur };
  }

  const saved = await one<Record<string, unknown>>(
    db,
    `update pricing_books set
      complexity_rates = $2::jsonb, module_rates = $3::jsonb, service_rules = $4::jsonb, product_type_overrides = $5::jsonb,
      status = 'draft', current_draft_version = current_draft_version + 1,
      admin_modified = true, created_by = $6::uuid, submitted_by = null, approved_by = null,
      published_at = null, retired_at = null, updated_at = now()
     where id = $1::uuid returning *`,
    [id, JSON.stringify(nextComp), JSON.stringify(nextMods), JSON.stringify(nextSvc), JSON.stringify(nextPtOv), actor.id],
  );
  await audit(db, actor, "pricing_book_batch_adjust", "pricing_books", id, {
    scope: input.scope,
    operation: input.operation,
    delta_value: input.delta_value,
    changed_count: diffs.length,
    note: input.note ?? null,
  });
  return { dry_run: false, count: diffs.length, diffs, book: saved };
}

export async function submitPricingBook(db: DB, actor: Actor, id: string, note: string | undefined, sessionHash: string) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const cur = await one<Record<string, any>>(db, "select * from pricing_books where id = $1::uuid for update", [id]);
  guard(cur.status === "draft" || cur.status === "in_review", "INVALID_STATE", "Only draft or in-review pricing books can be submitted.", 422);
  assertValidBookConfiguration(cur as unknown as z.output<typeof savePricingBookSchema>);

  const row = await one<Record<string, unknown>>(
    db,
    "update pricing_books set status = 'in_review', submitted_by = $2::uuid, updated_at = now() where id = $1::uuid returning *",
    [id, actor.id],
  );
  await audit(db, actor, "pricing_book_submit", "pricing_books", id, { code: row.code, note: note ?? null });
  return row;
}

export async function publishPricingBook(
  db: DB,
  actor: Actor,
  id: string,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...PRICING_REVIEW_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const cur = await one<Record<string, any>>(db, "select * from pricing_books where id = $1::uuid for update", [id]);
  guard(cur.status === "draft" || cur.status === "in_review", "INVALID_STATE", "Only draft or in-review pricing books can be published.", 422);
  guard(
    cur.created_by && cur.created_by !== actor.id && cur.submitted_by !== actor.id,
    "SELF_REVIEW_FORBIDDEN",
    "An author or submitter cannot independently publish their own pricing book.",
    403,
  );
  assertValidBookConfiguration(cur as unknown as z.output<typeof savePricingBookSchema>);

  const checksSummary = {
    billing_units_valid: true,
    dependencies_acyclic_and_complete: true,
    bilingual_content_present: Boolean(cur.name_zh && cur.name_en),
    auto_volume_discount_guarded: !cur.auto_volume_discount_enabled || Boolean(cur.volume_discount_justification),
  };

  const nextVerRow = await one<{ n: number }>(
    db,
    "select coalesce(max(version), 0)::int + 1 as n from pricing_book_versions where book_id = $1::uuid",
    [id],
  );

  const snapshot = {
    book_id: cur.id,
    code: cur.code,
    name_zh: cur.name_zh,
    name_en: cur.name_en,
    description_zh: cur.description_zh,
    description_en: cur.description_en,
    currency: cur.currency,
    rounding_mode: cur.rounding_mode,
    auto_volume_discount_enabled: cur.auto_volume_discount_enabled,
    volume_discount_justification: cur.volume_discount_justification ?? null,
    minimum_order_cents: cur.minimum_order_cents,
    order_fixed_fee_cents: cur.order_fixed_fee_cents,
    max_online_quantity: cur.max_online_quantity,
    max_online_total_cents: cur.max_online_total_cents,
    quote_validity_hours: cur.quote_validity_hours,
    complexity_rates: cur.complexity_rates,
    module_rates: cur.module_rates,
    service_rules: cur.service_rules,
    product_type_overrides: cur.product_type_overrides ?? {},
    customer_overrides: cur.customer_overrides ?? {},
    discount_rules: cur.discount_rules ?? [],
    volume_discount_tiers: cur.volume_discount_tiers ?? [],
    commercial_policy_matrix: cur.commercial_policy_matrix ?? {},
  };
  const contentHash = hash(JSON.stringify(snapshot));

  // Draft acceptance publication strictly preserves business_approved = false until TASK-197B
  const versionRow = await one<Record<string, unknown>>(
    db,
    `insert into pricing_book_versions (
      book_id, book_code, version, state, publication_scope, business_approved,
      effective_snapshot, content_hash, prepublish_checks,
      author_id, submitted_by, reviewer_id, note, effective_from
    ) values (
      $1::uuid, $2, $3::int, 'PUBLISHED', $4, false,
      $5::jsonb, $6, $7::jsonb,
      $8::uuid, $9::uuid, $10::uuid, $11::text, coalesce($12::timestamptz, now())
    ) returning *`,
    [
      id,
      String(cur.code),
      nextVerRow.n,
      String(cur.publication_scope ?? "sandbox_acceptance"),
      JSON.stringify(snapshot),
      contentHash,
      JSON.stringify(checksSummary),
      cur.created_by,
      cur.submitted_by ?? null,
      actor.id,
      note ?? null,
      cur.effective_from ?? null,
    ],
  );

  const updated = await one<Record<string, unknown>>(
    db,
    `update pricing_books set
      status = 'published', approved_by = $2::uuid, latest_published_version_id = $3::uuid,
      published_at = now(), updated_at = now()
     where id = $1::uuid returning *`,
    [id, actor.id, versionRow.id],
  );

  await audit(db, actor, "pricing_book_publish", "pricing_book_versions", String(versionRow.id), {
    book_id: id,
    code: cur.code,
    version: nextVerRow.n,
    publication_scope: cur.publication_scope,
    business_approved: false,
    content_hash: contentHash,
  });
  return { book: updated, version: versionRow };
}

export async function revokeScheduledPricingBookVersion(
  db: DB,
  actor: Actor,
  bookId: string,
  versionNumber: number,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await one(db, "select id from pricing_books where id = $1::uuid for update", [bookId]);
  const ver = await one<{ id: string; state: string; effective_from: Date }>(
    db,
    "select id, state, effective_from from pricing_book_versions where book_id = $1::uuid and version = $2::int for update",
    [bookId, versionNumber],
  );
  guard(ver.state === "PUBLISHED", "INVALID_STATE", "Only PUBLISHED scheduled versions can be revoked.", 422);
  guard(
    new Date(ver.effective_from).getTime() > Date.now(),
    "CANNOT_REVOKE_ACTIVE_VERSION",
    "Already effective versions cannot be revoked; publish a rollback instead.",
    422,
  );

  const retired = await one<Record<string, unknown>>(
    db,
    "update pricing_book_versions set state = 'RETIRED', retired_at = now(), note = coalesce($2, note) where id = $1::uuid returning *",
    [ver.id, note ?? null],
  );

  const priorActive = (
    await db.query<{ id: string }>(
      `select id from pricing_book_versions
       where book_id = $1::uuid and state = 'PUBLISHED'
       order by effective_from desc, version desc limit 1`,
      [bookId],
    )
  ).rows[0];
  await db.query(
    "update pricing_books set latest_published_version_id = $2::uuid, updated_at = now() where id = $1::uuid and latest_published_version_id = $3::uuid",
    [bookId, priorActive?.id ?? null, ver.id],
  );

  await audit(db, actor, "pricing_book_revoke_scheduled", "pricing_book_versions", ver.id, {
    book_id: bookId,
    version: versionNumber,
    note: note ?? null,
  });
  return retired;
}

export async function retirePricingBook(db: DB, actor: Actor, id: string, note: string | undefined, sessionHash: string) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  await one(db, "select id from pricing_books where id = $1::uuid for update", [id]);
  await db.query(
    "update pricing_book_versions set state = 'RETIRED', retired_at = now() where book_id = $1::uuid and state = 'PUBLISHED'",
    [id],
  );
  const row = await one<Record<string, unknown>>(
    db,
    "update pricing_books set status = 'retired', latest_published_version_id = null, retired_at = now(), updated_at = now() where id = $1::uuid returning *",
    [id],
  );
  await audit(db, actor, "pricing_book_retire", "pricing_books", id, { code: row.code, note: note ?? null });
  return row;
}

export async function rollbackPricingBook(
  db: DB,
  actor: Actor,
  id: string,
  targetVersion: number,
  note: string | undefined,
  sessionHash: string,
) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const cur = await one<{ id: string; status: string }>(db, "select id, status from pricing_books where id = $1::uuid for update", [id]);
  const ver = (
    await db.query<{ effective_snapshot: Record<string, any> }>(
      "select effective_snapshot from pricing_book_versions where book_id = $1::uuid and version = $2::int",
      [id, targetVersion],
    )
  ).rows[0];
  guard(ver, "NOT_FOUND", `Published version ${targetVersion} not found for pricing book.`, 404);
  const s = ver.effective_snapshot;

  const row = await one<Record<string, unknown>>(
    db,
    `update pricing_books set
      name_zh = $2, name_en = $3, description_zh = $4, description_en = $5,
      currency = $6, rounding_mode = $7,
      auto_volume_discount_enabled = $8::boolean, volume_discount_justification = $9,
      minimum_order_cents = $10::int, order_fixed_fee_cents = $11::int,
      max_online_quantity = $12::int, max_online_total_cents = $13::int, quote_validity_hours = $14::int,
      complexity_rates = $15::jsonb, module_rates = $16::jsonb, service_rules = $17::jsonb,
      product_type_overrides = $18::jsonb, customer_overrides = $19::jsonb,
      discount_rules = $20::jsonb, volume_discount_tiers = $21::jsonb, commercial_policy_matrix = $22::jsonb,
      status = 'draft', current_draft_version = current_draft_version + 1,
      latest_published_version_id = case when $24::text = 'retired' then null else latest_published_version_id end,
      admin_modified = true, created_by = $23::uuid, submitted_by = null, approved_by = null,
      published_at = null, retired_at = null, updated_at = now()
     where id = $1::uuid returning *`,
    [
      id,
      String(s.name_zh ?? ""),
      String(s.name_en ?? ""),
      String(s.description_zh ?? ""),
      String(s.description_en ?? ""),
      String(s.currency ?? "USD"),
      String(s.rounding_mode ?? "ceil"),
      Boolean(s.auto_volume_discount_enabled),
      s.volume_discount_justification ?? null,
      Number(s.minimum_order_cents ?? 0),
      Number(s.order_fixed_fee_cents ?? 0),
      Number(s.max_online_quantity ?? 300),
      Number(s.max_online_total_cents ?? 5_000_000),
      Number(s.quote_validity_hours ?? 72),
      JSON.stringify(s.complexity_rates ?? {}),
      JSON.stringify(s.module_rates ?? {}),
      JSON.stringify(s.service_rules ?? {}),
      JSON.stringify(s.product_type_overrides ?? {}),
      JSON.stringify(s.customer_overrides ?? {}),
      JSON.stringify(s.discount_rules ?? []),
      JSON.stringify(s.volume_discount_tiers ?? []),
      JSON.stringify(s.commercial_policy_matrix ?? {}),
      actor.id,
      cur.status,
    ],
  );
  await audit(db, actor, "pricing_book_rollback_to_draft", "pricing_books", id, {
    target_version: targetVersion,
    draft_version: row.current_draft_version,
    note: note ?? null,
  });
  return row;
}

export async function listPricingBookVersions(db: DB, actor: Actor, id: string) {
  role(actor, ...PRICING_READ_ROLES);
  return (
    await db.query(
      `select id, book_id, book_code, version, state, publication_scope, business_approved,
              content_hash, prepublish_checks, author_id, submitted_by, reviewer_id, note, effective_from, published_at, retired_at
       from pricing_book_versions
       where book_id = $1::uuid
       order by version desc`,
      [id],
    )
  ).rows;
}

export async function exportPricingBookSnapshot(db: DB, actor: Actor, id: string, sessionHash: string) {
  role(actor, ...PRICING_EDIT_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const book = await one<Record<string, unknown>>(db, "select * from pricing_books where id = $1::uuid", [id]);
  const versions = await listPricingBookVersions(db, actor, id);
  await audit(db, actor, "pricing_book_export", "pricing_books", id, { code: book.code });
  return { exported_at: new Date().toISOString(), book, versions };
}

/**
 * Resolves the latest non-retired, currently effective (`effective_from <= now()`) published book version.
 * Strictly strips internal L1–L5 codes and customer_overrides in public projection!
 */
export async function getPublicPublishedPricingProjection(db: DB) {
  const row = await resolveCurrentEffectiveVersion(db);
  if (!row) return null;

  const snap = await applyPricingBookTranslations(db, row.book_id, row.effective_snapshot, { verifyFrozenSource: true });
  const modulesPublic = Object.values((snap.module_rates ?? {}) as Record<string, any>).map((m) => ({
    code: m.code,
    name_zh: m.name_zh,
    name_en: m.name_en,
    included_in_base: Boolean(m.included_in_base),
    billing_unit: m.billing_unit,
    default_option: m.default_option,
    requires: m.requires ?? [],
    options: m.options,
  }));

  return {
    book_id: row.book_id,
    book_version_id: row.version_id,
    book_version: row.version,
    code: snap.code,
    name_zh: snap.name_zh,
    name_en: snap.name_en,
    description_zh: snap.description_zh,
    description_en: snap.description_en,
    currency: snap.currency,
    rounding_mode: snap.rounding_mode,
    auto_volume_discount_enabled: Boolean(snap.auto_volume_discount_enabled),
    minimum_order_cents: Number(snap.minimum_order_cents ?? 0),
    order_fixed_fee_cents: Number(snap.order_fixed_fee_cents ?? 0),
    max_online_quantity: Number(snap.max_online_quantity ?? 300),
    quote_validity_hours: Number(snap.quote_validity_hours ?? 72),
    publication_scope: row.publication_scope,
    business_approved: row.business_approved,
    published_at: row.published_at,
    effective_from: row.effective_from,
    modules: modulesPublic,
    service_rules: {
      compare_2_items_cents: snap.service_rules?.compare_2_items_cents,
      compare_3_items_cents: snap.service_rules?.compare_3_items_cents,
      compare_extra_item_cents: snap.service_rules?.compare_extra_item_cents,
      compare_max_online_items: snap.service_rules?.compare_max_online_items,
      golden_archive_seal_cents: snap.service_rules?.golden_archive_seal_cents,
      golden_call_batch_cents: snap.service_rules?.golden_call_batch_cents,
      golden_match_item_cents: snap.service_rules?.golden_match_item_cents,
      free_storage_days_default: snap.service_rules?.free_storage_days_default ?? 15,
    },
    disclosures: [
      "Sampling inspection covers only commissioned samples and does not certify factory batch quality or AQL compliance.",
      "Commercial rates in sandbox verification scope await formal commercial signoff before production sales open.",
    ],
  };
}

export async function createUnifiedQuote(db: DB, actor: Actor | null, rawInput: unknown) {
  const req = quoteRequestSchema.parse(rawInput);

  // Strict authorization & anti-spoofing guards (fixes P0 cross-tenant & category-bypass findings)
  const callerIsStaff = Boolean(actor && actor.kind === "staff");
  if (!actor) {
    guard(req.quote_kind === "simulation", "UNAUTHORIZED", "Anonymous visitors may only run 'simulation' quotes; sign in for formal quotes.", 401);
    guard(!req.org_id, "FORBIDDEN", "Anonymous visitors cannot supply org_id.", 403);
    guard(!req.allow_unpublished_catalog_in_sim, "FORBIDDEN", "Anonymous visitors cannot bypass admitted catalog checks.", 403);
    guard(!req.draft_book_id, "FORBIDDEN", "Anonymous visitors cannot simulate draft pricing books.", 403);
  } else if (actor.kind === "customer") {
    guard(!req.org_id || req.org_id === actor.org, "FORBIDDEN", "Cross-tenant org_id access is forbidden.", 403);
    guard(!req.allow_unpublished_catalog_in_sim, "FORBIDDEN", "Customers cannot bypass admitted catalog checks.", 403);
    guard(!req.draft_book_id, "FORBIDDEN", "Customers cannot simulate draft pricing books.", 403);
  } else {
    if (req.quote_kind === "simulation") {
      role(actor, ...PRICING_READ_ROLES);
    } else {
      role(actor, ...PRICING_EDIT_ROLES, "support");
    }
  }

  let bookId: string;
  let bookVersionId: string | null = null;
  let bookVersionNum = 0;
  let bookSnap: Record<string, any>;

  if (req.draft_book_id) {
    guard(callerIsStaff, "FORBIDDEN", "Only authorized staff can simulate against an unpublished draft pricing book.", 403);
    guard(req.quote_kind === "simulation", "INVALID_QUOTE_KIND", "Draft pricing books can only produce 'simulation' quotes.", 422);
    const draftRow = await one<Record<string, any>>(db, "select * from pricing_books where id = $1::uuid", [req.draft_book_id]);
    bookId = String(draftRow.id);
    bookSnap = draftRow;
  } else {
    const pubRow = await resolveCurrentEffectiveVersion(db);
    guard(pubRow, "PRICING_UNAVAILABLE", "No published unified pricing book is currently effective.", 422);
    bookId = pubRow.book_id;
    bookVersionId = pubRow.version_id;
    bookVersionNum = pubRow.version;
    bookSnap = pubRow.effective_snapshot;
  }

  const catalogCtx = await loadCatalogPricingContext(db, req.product_type_code);
  const resolvedOrgId = actor?.kind === "customer" ? actor.org : callerIsStaff ? (req.org_id ?? null) : null;
  const effectiveReq = { ...req, org_id: resolvedOrgId ?? undefined };
  const calc = calculateUnifiedQuote(bookSnap, catalogCtx, effectiveReq, { callerIsStaff });

  if (req.quote_kind === "simulation") {
    return {
      quote_id: null,
      quote_kind: "simulation" as const,
      book_id: bookId,
      book_version_id: bookVersionId,
      book_version: bookVersionNum,
      ...calc,
    };
  }

  // Persist formal / supplement quote pinned to exact book_version_id
  guard(bookVersionId, "PRICING_UNAVAILABLE", "Formal quotes require an approved pricing_book_version.", 422);
  const validityHours = Number(bookSnap.quote_validity_hours ?? 72);
  const expiresAt = new Date(Date.now() + validityHours * 3600_000);
  const snapshotHash = hash(JSON.stringify({ bookVersionId, calc }));

  const inserted = await one<Record<string, unknown>>(
    db,
    `insert into pricing_quotes (
      org_id, book_id, book_version_id, book_version, quote_kind, service_type,
      request_payload, line_items, compiled_task_plan,
      subtotal_cents, discount_cents, minimum_topup_cents, total_cents, currency,
      manual_quote_required, manual_quote_reasons, snapshot_hash, status, expires_at, created_by
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6,
      $7::jsonb, $8::jsonb, $9::jsonb,
      $10::int, $11::int, $12::int, $13::int, $14,
      $15::boolean, $16::jsonb, $17, 'open', $18::timestamptz, $19::uuid
    ) returning *`,
    [
      resolvedOrgId,
      bookId,
      bookVersionId,
      bookVersionNum,
      req.quote_kind,
      calc.service_type,
      JSON.stringify(effectiveReq),
      JSON.stringify(calc.line_items),
      JSON.stringify(calc.compiled_task_plan),
      calc.subtotal_cents,
      calc.discount_cents,
      calc.minimum_topup_cents,
      calc.total_cents,
      calc.currency,
      calc.manual_quote_required,
      JSON.stringify(calc.manual_quote_reasons),
      snapshotHash,
      expiresAt.toISOString(),
      actor?.id ?? null,
    ],
  );

  return {
    quote_id: inserted.id,
    status: inserted.status,
    expires_at: inserted.expires_at,
    snapshot_hash: snapshotHash,
    book_id: bookId,
    book_version_id: bookVersionId,
    book_version: bookVersionNum,
    ...calc,
  };
}

export async function getUnifiedQuoteDetail(db: DB, actor: Actor, quoteId: string) {
  const row = await one<Record<string, any>>(db, "select * from pricing_quotes where id = $1::uuid", [quoteId]);
  if (actor.kind === "customer") {
    guard(row.org_id === actor.org, "NOT_FOUND", "Quote not found.", 404);
  } else {
    role(actor, ...PRICING_READ_ROLES);
  }
  return row;
}

export type VerifyLockResult =
  | { ok: true; quote: Record<string, unknown> }
  | { ok: false; status: number; errorCode: string; message: string };

/**
 * Verifies quote freshness and currently effective pricing version BEFORE checkout lock (`T01 PRICE_CHANGED`, `T30` immutability).
 * Returns structured failure on expired/superseded so state transition commits in DB without rollback.
 */
export async function verifyAndLockUnifiedQuote(db: DB, actor: Actor, quoteId: string): Promise<VerifyLockResult> {
  const q = await one<Record<string, any>>(db, "select * from pricing_quotes where id = $1::uuid for update", [quoteId]);
  if (actor.kind === "customer") {
    guard(q.org_id === actor.org, "NOT_FOUND", "Quote not found.", 404);
  } else {
    role(actor, ...PRICING_EDIT_ROLES, "support");
  }

  if (q.status === "locked") {
    return { ok: true, quote: q };
  }
  if (q.status === "expired") {
    return { ok: false, status: 409, errorCode: "QUOTE_EXPIRED", message: "Quote validity window expired; please generate a new quote." };
  }
  if (q.status === "superseded") {
    return { ok: false, status: 409, errorCode: "PRICE_CHANGED", message: "Published pricing has changed since this quote was created; request a fresh quote." };
  }
  guard(q.status === "open", "QUOTE_NOT_LOCKABLE", `Quote status '${q.status}' cannot be locked.`, 409);

  if (new Date(q.expires_at).getTime() <= Date.now()) {
    await db.query("update pricing_quotes set status = 'expired' where id = $1::uuid", [quoteId]);
    await audit(db, actor, "pricing_quote_expired", "pricing_quotes", quoteId, { total_cents: q.total_cents });
    return { ok: false, status: 409, errorCode: "QUOTE_EXPIRED", message: "Quote validity window expired; please generate a new quote." };
  }

  if (q.manual_quote_required) {
    return { ok: false, status: 422, errorCode: "MANUAL_QUOTE_REQUIRED", message: "This quote requires manual staff pricing review." };
  }

  // Compare against the currently effective published version of this book (respecting future effective_from!)
  const activeBookVer = (
    await db.query<{ id: string }>(
      `select v.id
       from pricing_books b
       join pricing_book_versions v on v.book_id = b.id
       where b.id = $1::uuid
         and b.status <> 'retired'
         and v.state = 'PUBLISHED'
         and v.effective_from <= now()
       order by v.effective_from desc, v.version desc
       limit 1`,
      [q.book_id],
    )
  ).rows[0];

  if (!activeBookVer || activeBookVer.id !== q.book_version_id) {
    await db.query("update pricing_quotes set status = 'superseded' where id = $1::uuid", [quoteId]);
    await audit(db, actor, "pricing_quote_superseded", "pricing_quotes", quoteId, {
      stale_version_id: q.book_version_id,
      active_version_id: activeBookVer?.id ?? null,
    });
    return {
      ok: false,
      status: 409,
      errorCode: "PRICE_CHANGED",
      message: "Published pricing has changed since this quote was created; request a fresh quote.",
    };
  }

  const locked = await one<Record<string, unknown>>(
    db,
    "update pricing_quotes set status = 'locked', locked_at = now() where id = $1::uuid returning *",
    [quoteId],
  );
  await audit(db, actor, "pricing_quote_lock", "pricing_quotes", quoteId, {
    book_id: q.book_id,
    book_version_id: q.book_version_id,
    total_cents: q.total_cents,
  });
  return { ok: true, quote: locked };
}
