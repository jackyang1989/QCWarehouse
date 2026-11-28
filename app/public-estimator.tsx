"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { localizePublicPath } from "../packages/core/locale-contract";
import { useLocale } from "./i18n-client";

function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const csrf = document.cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("qcw_csrf="))
    ?.slice("qcw_csrf=".length);
  return csrf ? { "x-csrf-token": csrf } : {};
}

type KnowledgeGroup = {
  group_code: string;
  group_name_zh: string;
  group_name_en: string;
  count: number;
};

type KnowledgeProductType = {
  code: string;
  group_code: string;
  group_name_zh: string;
  group_name_en: string;
  name_zh: string;
  name_en: string;
  billing_unit: string;
  applicable_module_codes: string[];
  quote_mode: string;
};

type KnowledgeModule = {
  code: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  billing_unit: string;
  is_destructive_possible: boolean;
  requires_customer_authorization: boolean;
  depends_on_codes: string[];
  conflicts_with_codes: string[];
};

type PricingModuleOption = {
  label_zh: string;
  label_en: string;
  unit_cents: number;
  billing_unit?: string;
  requires_destructive_auth?: boolean;
  manual_quote?: boolean;
};

type PricingModule = {
  code: string;
  name_zh: string;
  name_en: string;
  included_in_base: boolean;
  billing_unit: string;
  default_option: string;
  requires: string[];
  options: Record<string, PricingModuleOption>;
};

export type PublicEstimatorKnowledgeCatalog = {
  groups: KnowledgeGroup[];
  product_types: KnowledgeProductType[];
  modules: KnowledgeModule[];
};

export type PublicEstimatorPricingCatalog = {
  book_id: string;
  book_version_id: string;
  book_version: number;
  name_zh: string;
  name_en: string;
  currency: string;
  rounding_mode: "ceil" | "round" | "floor";
  max_online_quantity: number;
  business_approved: boolean;
  publication_scope: string;
  modules: PricingModule[];
  service_rules?: Record<string, unknown>;
} | null;

type EstimatorModuleSelection = {
  module_code: string;
  option_code?: string;
  coverage_mode: "exact_count" | "percentage";
  coverage_qty?: number;
  coverage_pct?: number;
  extra_points?: number;
};

type EstimatorGroupDraft = {
  group_id: string;
  service_type: "inspection" | "compare" | "reference_match";
  product_type_code: string;
  base_qty: number;
  preset: "basic" | "standard" | "custom";
  modules: EstimatorModuleSelection[];
  has_existing_golden_sample: boolean;
  golden_reference_count: number;
  archive_new_golden_samples: number;
  customer_authorized_destructive: boolean;
};

type LineItemOut = {
  code: string;
  module_code: string | null;
  option_code: string | null;
  label_zh: string;
  label_en: string;
  billing_unit: string;
  quantity: number;
  unit_cents: number;
  amount_cents: number;
  disclosure?: string;
};

type EstimateGroupOut = {
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
  line_items: LineItemOut[];
  subtotal_cents: number;
  manual_quote_reasons: string[];
  conditional_disclosures: string[];
};

type EstimateResponse = {
  status: "priced" | "sandbox_priced" | "manual_quote_required" | "unavailable" | "no_published_pricing";
  book_version: number | null;
  business_approved: boolean;
  currency: string;
  rounding_mode: string;
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
  groups: EstimateGroupOut[];
  order_adjustments: LineItemOut[];
  manual_quote_required: boolean;
  manual_quote_reasons: string[];
  disclosures: string[];
  post_inspection_charges: {
    domestic_shipping: { status: string; amount_cents: null; label_zh: string; label_en: string };
    storage: { free_days: number; label_zh: string; label_en: string };
  };
  turnaround_note_zh: string;
  turnaround_note_en: string;
};

type StoredDraftPointer = {
  draft_token: string;
  draft_id: string;
  expires_at: string;
};

const STORAGE_KEY = "qcw_anon_estimate_v1";

function newGroupId(): string {
  return `grp_${Math.random().toString(36).slice(2, 8)}`;
}

function makeDefaultGroup(productCode = "t_shirt", qty = 10, service: "inspection" | "compare" | "reference_match" = "inspection"): EstimatorGroupDraft {
  return {
    group_id: newGroupId(),
    service_type: service,
    product_type_code: productCode,
    base_qty: service === "compare" ? Math.max(2, Math.min(10, qty)) : qty,
    preset: "basic",
    modules: [],
    has_existing_golden_sample: false,
    golden_reference_count: 1,
    archive_new_golden_samples: 0,
    customer_authorized_destructive: false,
  };
}

function fmtCurrency(cents: number | null, currency = "USD"): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function billingUnitLabel(unit: string, isZh: boolean): string {
  const map: Record<string, { zh: string; en: string }> = {
    per_piece: { zh: "/ 件", en: "/ item" },
    per_set: { zh: "/ 套", en: "/ set" },
    per_order: { zh: "/ 单", en: "/ order" },
    per_comparison_group: { zh: "/ 组", en: "/ group" },
    per_golden_sample: { zh: "/ 份标杆样", en: "/ sample" },
    per_golden_sample_call: { zh: "/ 批次调出", en: "/ call" },
    per_measurement_point: { zh: "/ 点次", en: "/ point" },
    per_photo: { zh: "/ 张", en: "/ photo" },
    per_photo_group: { zh: "/ 组图", en: "/ photo set" },
    per_video: { zh: "/ 条视频", en: "/ video" },
    per_sku: { zh: "/ 款式", en: "/ SKU" },
    manual_quote: { zh: "人工报价", en: "manual quote" },
  };
  const hit = map[unit];
  return hit ? (isZh ? hit.zh : hit.en) : unit;
}

export function PublicModularEstimator({
  knowledgeCatalog,
  pricingCatalog,
}: {
  knowledgeCatalog?: PublicEstimatorKnowledgeCatalog;
  pricingCatalog?: PublicEstimatorPricingCatalog;
}) {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const searchParams = useSearchParams();

  const productTypes = useMemo(() => knowledgeCatalog?.product_types ?? [], [knowledgeCatalog]);
  const knowledgeModules = useMemo(() => knowledgeCatalog?.modules ?? [], [knowledgeCatalog]);
  const pricingModules = useMemo(() => pricingCatalog?.modules ?? [], [pricingCatalog]);

  const knowledgeModByCode = useMemo(() => new Map(knowledgeModules.map((m) => [m.code, m])), [knowledgeModules]);
  const pricingModByCode = useMemo(() => new Map(pricingModules.map((m) => [m.code, m])), [pricingModules]);
  const ptByCode = useMemo(() => new Map(productTypes.map((p) => [p.code, p])), [productTypes]);

  const defaultPtCode = useMemo(() => {
    return productTypes.find((p) => p.code === "t_shirt")?.code ?? productTypes[0]?.code ?? "t_shirt";
  }, [productTypes]);

  const [mode, setMode] = useState<"quick" | "advanced">("quick");
  const [groups, setGroups] = useState<EstimatorGroupDraft[]>(() => [makeDefaultGroup(defaultPtCode, 10, "inspection")]);
  const [promoInput, setPromoInput] = useState("");
  const [promoCodes, setPromoCodes] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [undoTrash, setUndoTrash] = useState<{ index: number; group: EstimatorGroupDraft } | null>(null);
  const [batchModuleCode, setBatchModuleCode] = useState("M02");
  const [reloadTick, setReloadTick] = useState(0);

  // Anonymous draft persistence state
  const [draftPointer, setDraftPointer] = useState<StoredDraftPointer | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [priceChangedBanner, setPriceChangedBanner] = useState<{
    savedVersion: number | null;
    savedCents: number | null;
    currentVersion: number | null;
    currentCents: number | null;
  } | null>(null);
  const [expiredRecoverable, setExpiredRecoverable] = useState<{
    mode: "quick" | "advanced";
    groups: EstimatorGroupDraft[];
    promo_codes: string[];
  } | null>(null);

  const requestSeqRef = useRef(0);
  const initializedRef = useRef(false);

  // Initial URL param entry context + localStorage draft recovery (run once)
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const urlService = searchParams.get("service");
    const urlPt = searchParams.get("product_type");
    const urlQtyRaw = Number(searchParams.get("qty"));
    const urlMode = searchParams.get("mode");
    const hasSafeQueryContext = Boolean(urlService || urlPt || (Number.isInteger(urlQtyRaw) && urlQtyRaw > 0) || urlMode);

    if (hasSafeQueryContext) {
      const safeSvc: "inspection" | "compare" | "reference_match" =
        urlService === "compare" || urlService === "reference_match" ? urlService : "inspection";
      const safeQty = Number.isInteger(urlQtyRaw) && urlQtyRaw >= 1 && urlQtyRaw <= 5000 ? urlQtyRaw : safeSvc === "compare" ? 3 : 10;
      const safePt = urlPt && /^[a-z0-9_]{2,80}$/.test(urlPt) ? urlPt : defaultPtCode;
      if (urlMode === "advanced") setMode("advanced");
      setGroups([makeDefaultGroup(safePt, safeQty, safeSvc)]);
      return;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredDraftPointer;
      if (!parsed?.draft_token) return;
      setDraftPointer(parsed);
      void (async () => {
        try {
          const res = await fetch(`/api/v1/public/estimate-drafts/${encodeURIComponent(parsed.draft_token)}`, {
            credentials: "same-origin",
            cache: "no-store",
          });
          if (res.status === 404 || res.status === 410) {
            window.localStorage.removeItem(STORAGE_KEY);
            setDraftPointer(null);
            setDraftNotice(
              res.status === 410
                ? isZh
                  ? "此前保存的匿名估价草稿已删除。"
                  : "Previously saved anonymous estimate draft was removed."
                : null,
            );
            return;
          }
          if (!res.ok) return;
          const body = await res.json();
          if (body.status === "expired" && body.recoverable_input?.service_groups) {
            setExpiredRecoverable({
              mode: body.recoverable_input.mode === "advanced" ? "advanced" : "quick",
              groups: body.recoverable_input.service_groups,
              promo_codes: Array.isArray(body.recoverable_input.promo_codes) ? body.recoverable_input.promo_codes : [],
            });
            return;
          }
          if (body.status === "active" && body.draft_payload?.service_groups) {
            setMode(body.draft_payload.mode === "advanced" ? "advanced" : "quick");
            setGroups(body.draft_payload.service_groups);
            setPromoCodes(Array.isArray(body.draft_payload.promo_codes) ? body.draft_payload.promo_codes : []);
            if (body.estimate) setEstimate(body.estimate);
            if (body.price_changed) {
              setPriceChangedBanner({
                savedVersion: body.saved_book_version ?? null,
                savedCents: body.saved_total_cents ?? null,
                currentVersion: body.estimate?.book_version ?? null,
                currentCents: body.estimate?.total_cents ?? null,
              });
            }
          }
        } catch {
          // Non-fatal: keep live estimator usable
        }
      })();
    } catch {
      // Ignore malformed storage
    }
  }, [defaultPtCode, isZh, searchParams]);

  // Keep default product type synced when catalog loads if still untouched placeholder
  useEffect(() => {
    if (!productTypes.length) return;
    setGroups((prev) =>
      prev.map((g) => (ptByCode.has(g.product_type_code) ? g : { ...g, product_type_code: defaultPtCode })),
    );
  }, [defaultPtCode, productTypes.length, ptByCode]);

  // Debounced server-side unified estimate fetch with AbortController + sequence guard
  useEffect(() => {
    if (!groups.length) return;
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    setEstimating(true);
    setEstimateError(null);

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/v1/public/estimate", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", ...csrfHeaders() },
          signal: controller.signal,
          body: JSON.stringify({
            mode,
            locale,
            source_route: hrefFor("/pricing"),
            service_groups: groups,
            promo_codes: promoCodes,
          }),
        });
        const body = await res.json().catch(() => null);
        if (seq !== requestSeqRef.current) return;
        if (!res.ok) {
          const msg = body?.error?.message ?? (isZh ? "估价服务暂不可用，您的输入已保留。" : "Estimate calculation failed; your inputs are preserved.");
          setEstimateError(msg);
          setEstimating(false);
          return;
        }
        setEstimate(body as EstimateResponse);
        setEstimating(false);
      } catch (err) {
        if (controller.signal.aborted || seq !== requestSeqRef.current) return;
        setEstimateError(err instanceof Error ? err.message : isZh ? "网络请求失败" : "Network error");
        setEstimating(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [groups, locale, mode, promoCodes, reloadTick]);

  function updateGroup(idx: number, patch: Partial<EstimatorGroupDraft>) {
    setGroups((prev) =>
      prev.map((g, i) => {
        if (i !== idx) return g;
        const next = { ...g, ...patch };
        if (patch.service_type === "compare" && next.base_qty < 2) next.base_qty = 2;
        if (patch.preset === "basic" || patch.preset === "standard") next.modules = [];
        return next;
      }),
    );
  }

  function addGroup() {
    setGroups((prev) => [...prev, makeDefaultGroup(defaultPtCode, 5, "inspection")]);
  }

  function duplicateGroup(idx: number) {
    setGroups((prev) => {
      const target = prev[idx];
      if (!target) return prev;
      const copy: EstimatorGroupDraft = { ...target, group_id: newGroupId(), modules: target.modules.map((m) => ({ ...m })) };
      const out = [...prev];
      out.splice(idx + 1, 0, copy);
      return out;
    });
  }

  function removeGroup(idx: number) {
    setGroups((prev) => {
      if (prev.length <= 1) return prev;
      const removed = prev[idx];
      setUndoTrash({ index: idx, group: removed });
      return prev.filter((_, i) => i !== idx);
    });
  }

  function undoRemove() {
    if (!undoTrash) return;
    setGroups((prev) => {
      const out = [...prev];
      out.splice(Math.min(undoTrash.index, out.length), 0, undoTrash.group);
      return out;
    });
    setUndoTrash(null);
  }

  function toggleModule(idx: number, modCode: string) {
    const g = groups[idx];
    if (!g) return;
    const pMod = pricingModByCode.get(modCode);
    if (!pMod) return;
    const exists = g.modules.some((m) => m.module_code === modCode);
    if (exists) {
      updateGroup(idx, {
        preset: "custom",
        modules: g.modules.filter((m) => m.module_code !== modCode),
      });
    } else {
      const nextMod: EstimatorModuleSelection = {
        module_code: modCode,
        option_code: pMod.default_option,
        coverage_mode: "exact_count",
        coverage_qty: pMod.billing_unit === "per_piece" || pMod.billing_unit === "per_set" ? g.base_qty : 1,
      };
      updateGroup(idx, {
        preset: "custom",
        modules: [...g.modules, nextMod],
      });
    }
  }

  function updateGroupModule(idx: number, modCode: string, patch: Partial<EstimatorModuleSelection>) {
    const g = groups[idx];
    if (!g) return;
    updateGroup(idx, {
      preset: "custom",
      modules: g.modules.map((m) => (m.module_code === modCode ? { ...m, ...patch } : m)),
    });
  }

  function batchApplyModule() {
    const pMod = pricingModByCode.get(batchModuleCode);
    if (!pMod) return;
    let appliedCount = 0;
    setGroups((prev) =>
      prev.map((g) => {
        const pt = ptByCode.get(g.product_type_code);
        const applicable = pt?.applicable_module_codes ?? [];
        if (applicable.length > 0 && !applicable.includes(batchModuleCode)) return g;
        if (g.modules.some((m) => m.module_code === batchModuleCode)) return g;
        appliedCount += 1;
        return {
          ...g,
          preset: "custom",
          modules: [
            ...g.modules,
            {
              module_code: batchModuleCode,
              option_code: pMod.default_option,
              coverage_mode: "exact_count",
              coverage_qty: pMod.billing_unit === "per_piece" || pMod.billing_unit === "per_set" ? g.base_qty : 1,
            },
          ],
        };
      }),
    );
    setDraftNotice(
      appliedCount > 0
        ? isZh
          ? `已为 ${appliedCount} 个兼容商品组批量应用模块 ${batchModuleCode}。`
          : `Batch-applied module ${batchModuleCode} to ${appliedCount} compatible product group(s).`
        : isZh
          ? `无新增可应用 ${batchModuleCode} 的兼容商品组。`
          : `No additional compatible product groups needed module ${batchModuleCode}.`,
    );
  }

  async function handleSaveDraft() {
    setDraftBusy(true);
    setDraftNotice(null);
    try {
      const payload = {
        mode,
        locale,
        source_route: hrefFor("/pricing"),
        service_groups: groups,
        promo_codes: promoCodes,
      };
      if (draftPointer?.draft_token) {
        const res = await fetch(`/api/v1/public/estimate-drafts/${encodeURIComponent(draftPointer.draft_token)}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json", ...csrfHeaders() },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const body = await res.json();
          const nextPtr = {
            draft_token: draftPointer.draft_token,
            draft_id: body.draft_id,
            expires_at: body.expires_at,
          };
          setDraftPointer(nextPtr);
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPtr));
          if (body.estimate) setEstimate(body.estimate);
          setDraftNotice(isZh ? `匿名草稿已更新（第 ${body.revision} 版，有效期至 ${String(body.expires_at).slice(0, 10)}）。` : `Anonymous draft updated (rev ${body.revision}, valid until ${String(body.expires_at).slice(0, 10)}).`);
          setDraftBusy(false);
          return;
        }
        if (res.status !== 404 && res.status !== 409 && res.status !== 410) {
          const errBody = await res.json().catch(() => null);
          setDraftNotice(errBody?.error?.message ?? (isZh ? "更新匿名草稿失败，请重试。" : "Failed to update anonymous draft; please retry."));
          setDraftBusy(false);
          return;
        }
      }
      const res = await fetch("/api/v1/public/estimate-drafts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setDraftNotice(body?.error?.message ?? (isZh ? "保存草稿失败" : "Failed to save anonymous draft."));
      } else {
        const nextPtr: StoredDraftPointer = {
          draft_token: body.draft_token,
          draft_id: body.draft_id,
          expires_at: body.expires_at,
        };
        setDraftPointer(nextPtr);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPtr));
        if (body.estimate) setEstimate(body.estimate);
        setExpiredRecoverable(null);
        setDraftNotice(isZh ? `已生成匿名草稿（有效期至 ${String(body.expires_at).slice(0, 10)}），刷新页面不丢失。` : `Anonymous draft saved (expires ${String(body.expires_at).slice(0, 10)}); safe across refreshes.`);
      }
    } catch {
      setDraftNotice(isZh ? "保存匿名草稿时网络异常，当前输入已保留。" : "Network error while saving draft; your current inputs remain intact.");
    } finally {
      setDraftBusy(false);
    }
  }

  async function handleClearDraft() {
    setDraftBusy(true);
    setDraftNotice(null);
    try {
      if (draftPointer?.draft_token) {
        await fetch(`/api/v1/public/estimate-drafts/${encodeURIComponent(draftPointer.draft_token)}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { ...csrfHeaders() },
        });
      }
    } finally {
      window.localStorage.removeItem(STORAGE_KEY);
      setDraftPointer(null);
      setPriceChangedBanner(null);
      setExpiredRecoverable(null);
      setDraftBusy(false);
      setDraftNotice(isZh ? "已清除已保存的匿名草稿令牌。" : "Saved anonymous draft token cleared.");
    }
  }

  function restoreExpiredDraft() {
    if (!expiredRecoverable) return;
    setMode(expiredRecoverable.mode);
    setGroups(expiredRecoverable.groups);
    setPromoCodes(expiredRecoverable.promo_codes);
    setExpiredRecoverable(null);
    window.localStorage.removeItem(STORAGE_KEY);
    setDraftPointer(null);
    setDraftNotice(isZh ? "已恢复过期草稿的商品配置与数量，并按当前最新规则重新试算。" : "Expired draft inputs restored and recalculated against current pricing rules.");
  }

  const displayedGroups = mode === "quick" ? groups.slice(0, 1) : groups;
  const assignableModules = pricingModules.filter((m) => m.code !== "M01");
  const totalQtySummary = estimate?.total_base_qty ?? groups.reduce((s, g) => s + g.base_qty, 0);

  return (
    <div className="pub-est-shell">
      {/* Mode Switcher & Draft Status Strip */}
      <div className="pub-est-topbar">
        <div className="pub-filter-pills" role="tablist" aria-label={isZh ? "估价模式切换" : "Estimator mode"}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "quick"}
            className={`pub-filter-pill${mode === "quick" ? " active" : ""}`}
            onClick={() => setMode("quick")}
          >
            {isZh ? "快速估价（Quick Estimate）" : "Quick Estimate"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "advanced"}
            className={`pub-filter-pill${mode === "advanced" ? " active" : ""}`}
            onClick={() => setMode("advanced")}
          >
            {isZh ? `高级多品类选配（${groups.length} 组）` : `Advanced / Select Products (${groups.length})`}
          </button>
        </div>

        <div className="row flexwrap" style={{ gap: 8 }}>
          <button type="button" className="button sm" disabled={draftBusy} onClick={handleSaveDraft}>
            {draftPointer
              ? (isZh ? "更新匿名草稿" : "Update Saved Draft")
              : (isZh ? "保存匿名草稿" : "Save Estimate Draft")}
          </button>
          {draftPointer && (
            <button type="button" className="button sm" disabled={draftBusy} onClick={handleClearDraft}>
              {isZh ? "清除草稿" : "Clear Draft"}
            </button>
          )}
        </div>
      </div>

      {expiredRecoverable && (
        <div className="line-note warning" style={{ marginBottom: 14 }}>
          <strong>{isZh ? "发现已过期的匿名估价草稿：" : "Expired anonymous draft found:"}</strong>{" "}
          {isZh
            ? "旧报价快照已超过有效期，但您的品类、模块与数量输入已完整保留。"
            : "Your saved quote snapshot expired, but all entered product types, modules, and quantities were preserved."}{" "}
          <button type="button" className="button sm primary" style={{ marginLeft: 8 }} onClick={restoreExpiredDraft}>
            {isZh ? "恢复输入并按最新规则重算" : "Restore Inputs & Recalculate"}
          </button>
        </div>
      )}

      {priceChangedBanner && (
        <div className="line-note warning" style={{ marginBottom: 14 }}>
          <strong>{isZh ? "价目版本已更新：" : "Pricing schedule changed:"}</strong>{" "}
          {isZh
            ? `保存时为 v${priceChangedBanner.savedVersion ?? "?"} (${fmtCurrency(priceChangedBanner.savedCents, estimate?.currency ?? "USD")})，当前已按 v${priceChangedBanner.currentVersion ?? "?"} 重新核算为 ${fmtCurrency(priceChangedBanner.currentCents, estimate?.currency ?? "USD")}。`
            : `Saved under v${priceChangedBanner.savedVersion ?? "?"} (${fmtCurrency(priceChangedBanner.savedCents, estimate?.currency ?? "USD")}); recalculated under v${priceChangedBanner.currentVersion ?? "?"} as ${fmtCurrency(priceChangedBanner.currentCents, estimate?.currency ?? "USD")}.`}
        </div>
      )}

      {draftNotice && (
        <div className="line-note" style={{ marginBottom: 14 }} role="status">
          {draftNotice}
        </div>
      )}

      {undoTrash && (
        <div className="line-note" style={{ marginBottom: 14 }}>
          {isZh ? `已移除商品组（${undoTrash.group.product_type_code}）。` : `Removed product group (${undoTrash.group.product_type_code}).`}{" "}
          <button type="button" className="button sm" style={{ marginLeft: 8 }} onClick={undoRemove}>
            {isZh ? "撤销误删" : "Undo Delete"}
          </button>
        </div>
      )}

      <div className="pub-calc-grid">
        {/* Left Column: Unified Interactive Configurator */}
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {mode === "advanced" && assignableModules.length > 0 && (
            <div className="pub-est-batchbar">
              <label htmlFor="batch-mod-select" className="small" style={{ fontWeight: 700 }}>
                {isZh ? "批量添加兼容检测模块：" : "Batch-apply compatible module:"}
              </label>
              <select
                id="batch-mod-select"
                value={batchModuleCode}
                onChange={(e) => setBatchModuleCode(e.target.value)}
                style={{ width: "auto", minWidth: 200 }}
              >
                {assignableModules.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.code} · {isZh ? m.name_zh : m.name_en}
                  </option>
                ))}
              </select>
              <button type="button" className="button sm" onClick={batchApplyModule}>
                {isZh ? "应用到全部兼容组" : "Apply to Compatible Groups"}
              </button>
            </div>
          )}

          {displayedGroups.map((grp, idx) => {
            const pt = ptByCode.get(grp.product_type_code);
            const applicableCodes = pt?.applicable_module_codes ?? [];
            const availableMods = assignableModules.filter(
              (m) => applicableCodes.length === 0 || applicableCodes.includes(m.code),
            );
            const hasDestructiveSelected = grp.modules.some((sel) => {
              const pMod = pricingModByCode.get(sel.module_code);
              const optCode = sel.option_code ?? pMod?.default_option ?? "";
              return Boolean(optCode && pMod?.options?.[optCode]?.requires_destructive_auth);
            });

            return (
              <div className="pub-est-group-card" key={grp.group_id}>
                <div className="row between flexwrap" style={{ gap: 8, marginBottom: 10 }}>
                  <strong>
                    {mode === "advanced"
                      ? isZh
                        ? `服务组 #${idx + 1} · ${pt?.name_zh ?? grp.product_type_code}`
                        : `Group #${idx + 1} · ${pt?.name_en ?? grp.product_type_code}`
                      : isZh
                        ? "质检服务与标准服装规格"
                        : "Inspection Service & Standard Garment Type"}
                  </strong>
                  {mode === "advanced" && (
                    <div className="row" style={{ gap: 6 }}>
                      <button type="button" className="button sm" onClick={() => duplicateGroup(idx)}>
                        {isZh ? "复制" : "Duplicate"}
                      </button>
                      {groups.length > 1 && (
                        <button type="button" className="button sm" onClick={() => removeGroup(idx)}>
                          {isZh ? "删除" : "Remove"}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid cols2" style={{ gap: 12 }}>
                  <div className="field">
                    <label htmlFor={`svc-${grp.group_id}`}>{isZh ? "质检服务类型" : "Service Type"}</label>
                    <select
                      id={`svc-${grp.group_id}`}
                      value={grp.service_type}
                      onChange={(e) =>
                        updateGroup(idx, {
                          service_type: e.target.value as "inspection" | "compare" | "reference_match",
                        })
                      }
                    >
                      <option value="inspection">{isZh ? "实物逐件质检（1 至 100+ 件）" : "Product Inspection (1–100+ pcs)"}</option>
                      <option value="compare">{isZh ? "供应商样品横向对比（2–10 件同组）" : "Sample Comparison (2–10 items)"}</option>
                      <option value="reference_match">{isZh ? "标杆确认样对照（需已有基准样）" : "Golden Sample Matching (Conditional)"}</option>
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor={`pt-${grp.group_id}`}>{isZh ? "标准成衣品类（无需关注内部等级）" : "Standard Product Type"}</label>
                    <select
                      id={`pt-${grp.group_id}`}
                      value={grp.product_type_code}
                      onChange={(e) => updateGroup(idx, { product_type_code: e.target.value })}
                    >
                      {productTypes.length === 0 ? (
                        <option value={grp.product_type_code}>{grp.product_type_code}</option>
                      ) : (
                        productTypes.map((p) => (
                          <option key={p.code} value={p.code}>
                            {isZh ? `${p.group_name_zh} · ${p.name_zh}` : `${p.group_name_en} · ${p.name_en}`}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                </div>

                <div className="grid cols2" style={{ gap: 12, marginTop: 10 }}>
                  <div className="field">
                    <label htmlFor={`qty-${grp.group_id}`}>
                      {grp.service_type === "compare"
                        ? isZh
                          ? "同组比较样品件数（至少 2 件）"
                          : "Comparison Sample Count (min 2)"
                        : isZh
                          ? "委托件数"
                          : "Quantity (Physical Units)"}
                    </label>
                    <input
                      id={`qty-${grp.group_id}`}
                      type="number"
                      min={grp.service_type === "compare" ? 2 : 1}
                      max={10000}
                      step={1}
                      value={grp.base_qty}
                      onChange={(e) => {
                        const raw = Math.floor(Number(e.target.value) || 1);
                        const minQ = grp.service_type === "compare" ? 2 : 1;
                        updateGroup(idx, { base_qty: Math.max(minQ, raw) });
                      }}
                    />
                    <div className="pub-qty-pills">
                      {(grp.service_type === "compare" ? [2, 3, 5] : [1, 3, 10, 30, 50, 100]).map((presetQty) => (
                        <button
                          key={presetQty}
                          type="button"
                          className={`pub-qty-pill${grp.base_qty === presetQty ? " active" : ""}`}
                          onClick={() => updateGroup(idx, { base_qty: presetQty })}
                        >
                          {presetQty}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <label>{isZh ? "检测档位预设" : "Scope Preset"}</label>
                    <div className="pub-filter-pills">
                      {(
                        [
                          ["basic", isZh ? "Basic 基础必检 (M01)" : "Basic (M01)"],
                          ["standard", isZh ? "Standard + 3 点实测" : "Standard (+3 POM)"],
                          ["custom", isZh ? "Custom 自由勾选模块" : "Custom Modules"],
                        ] as const
                      ).map(([pKey, pLabel]) => (
                        <button
                          key={pKey}
                          type="button"
                          className={`pub-filter-pill${grp.preset === pKey ? " active" : ""}`}
                          onClick={() => updateGroup(idx, { preset: pKey })}
                        >
                          {pLabel}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {grp.service_type === "reference_match" && (
                  <div className="line-note" style={{ marginTop: 10 }}>
                    <label className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        checked={grp.has_existing_golden_sample}
                        onChange={(e) => updateGroup(idx, { has_existing_golden_sample: e.target.checked })}
                      />
                      <span>
                        {isZh
                          ? "我名下已有封存好的有效标杆确认样（登录后选择具体样衣编号）"
                          : "I already have an active sealed Golden Sample in my account (selected after sign-in)"}
                      </span>
                    </label>
                    <span className="small muted">
                      {isZh
                        ? "访客态仅做条件试算（不选他/私密基准样）；若尚无标杆样，须先建档封存。"
                        : "Anonymous estimation never accesses private sample IDs; exact reference eligibility is verified upon sign-in."}
                    </span>
                  </div>
                )}

                <div className="field" style={{ marginTop: 10 }}>
                  <label htmlFor={`arch-${grp.group_id}`}>
                    {isZh ? "检后新建封存标杆确认样数量（可选）" : "New Golden Samples to Archive After QC (Optional)"}
                  </label>
                  <input
                    id={`arch-${grp.group_id}`}
                    type="number"
                    min={0}
                    max={20}
                    value={grp.archive_new_golden_samples}
                    onChange={(e) =>
                      updateGroup(idx, {
                        archive_new_golden_samples: Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0))),
                      })
                    }
                    style={{ maxWidth: 160 }}
                  />
                </div>

                {(grp.preset === "custom" || grp.modules.length > 0 || mode === "advanced") && (
                  <div className="pub-est-modules">
                    <strong className="small" style={{ display: "block", marginBottom: 8 }}>
                      {isZh ? "适用增强检验模块与抽检覆盖（M02–M11）" : "Applicable Add-On Modules & Coverage (M02–M11)"}
                    </strong>
                    <div className="pub-est-mod-grid">
                      {availableMods.map((mod) => {
                        const kMod = knowledgeModByCode.get(mod.code);
                        const activeSel = grp.modules.find((m) => m.module_code === mod.code);
                        const optEntries = Object.entries(mod.options ?? {});
                        return (
                          <div className={`pub-est-mod-item${activeSel ? " active" : ""}`} key={mod.code}>
                            <label className="row between" style={{ gap: 8, cursor: "pointer" }}>
                              <span>
                                <input
                                  type="checkbox"
                                  checked={Boolean(activeSel)}
                                  onChange={() => toggleModule(idx, mod.code)}
                                  style={{ marginRight: 6 }}
                                />
                                <strong>{mod.code} · {isZh ? mod.name_zh : mod.name_en}</strong>
                              </span>
                              <span className="small muted">{billingUnitLabel(mod.billing_unit, isZh)}</span>
                            </label>
                            {kMod && (kMod.depends_on_codes.length > 0 || kMod.conflicts_with_codes.length > 0) && (
                              <div className="small muted" style={{ fontSize: 11, marginTop: 2 }}>
                                {kMod.depends_on_codes.length > 0 && `${isZh ? "依赖" : "Requires"}: ${kMod.depends_on_codes.join(",")}`}
                                {kMod.conflicts_with_codes.length > 0 && ` · ${isZh ? "互斥" : "Conflicts"}: ${kMod.conflicts_with_codes.join(",")}`}
                              </div>
                            )}
                            {activeSel && (
                              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                                {optEntries.length > 1 && (
                                  <select
                                    aria-label={`${mod.code} option`}
                                    value={activeSel.option_code ?? mod.default_option}
                                    onChange={(e) =>
                                      updateGroupModule(idx, mod.code, { option_code: e.target.value })
                                    }
                                  >
                                    {optEntries.map(([oKey, oVal]) => (
                                      <option key={oKey} value={oKey}>
                                        {isZh ? oVal.label_zh : oVal.label_en} (
                                        {oVal.manual_quote ? (isZh ? "人工报价" : "Manual") : fmtCurrency(oVal.unit_cents, estimate?.currency ?? "USD")})
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <div className="row flexwrap" style={{ gap: 6 }}>
                                  <select
                                    aria-label={`${mod.code} coverage mode`}
                                    value={activeSel.coverage_mode}
                                    onChange={(e) => {
                                      const nextMode = e.target.value as "exact_count" | "percentage";
                                      updateGroupModule(idx, mod.code, {
                                        coverage_mode: nextMode,
                                        coverage_qty: nextMode === "exact_count" ? (activeSel.coverage_qty ?? grp.base_qty) : undefined,
                                        coverage_pct: nextMode === "percentage" ? (activeSel.coverage_pct ?? 50) : undefined,
                                      });
                                    }}
                                    style={{ width: "auto" }}
                                  >
                                    <option value="exact_count">{isZh ? "指定件/次" : "Exact count"}</option>
                                    <option value="percentage">{isZh ? "抽检百分比" : "Percentage"}</option>
                                  </select>
                                  {activeSel.coverage_mode === "exact_count" ? (
                                    <input
                                      type="number"
                                      min={1}
                                      max={grp.base_qty}
                                      aria-label={`${mod.code} coverage count`}
                                      value={activeSel.coverage_qty ?? grp.base_qty}
                                      onChange={(e) =>
                                        updateGroupModule(idx, mod.code, {
                                          coverage_qty: Math.max(1, Math.floor(Number(e.target.value) || 1)),
                                        })
                                      }
                                      style={{ width: 90 }}
                                    />
                                  ) : (
                                    <input
                                      type="number"
                                      min={1}
                                      max={100}
                                      step={5}
                                      aria-label={`${mod.code} coverage percentage`}
                                      value={activeSel.coverage_pct ?? 50}
                                      onChange={(e) =>
                                        updateGroupModule(idx, mod.code, {
                                          coverage_pct: Math.max(1, Math.min(100, Number(e.target.value) || 100)),
                                        })
                                      }
                                      style={{ width: 90 }}
                                    />
                                  )}
                                  {mod.code === "M02" && activeSel.option_code !== "extra_point" && (
                                    <input
                                      type="number"
                                      min={0}
                                      max={20}
                                      placeholder={isZh ? "+加点" : "+pts"}
                                      aria-label="M02 extra points"
                                      value={activeSel.extra_points ?? 0}
                                      onChange={(e) => {
                                        const v = Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0)));
                                        updateGroupModule(idx, mod.code, { extra_points: v > 0 ? v : undefined });
                                      }}
                                      style={{ width: 82 }}
                                    />
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {hasDestructiveSelected && (
                  <label className="line-note warning" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={grp.customer_authorized_destructive}
                      onChange={(e) => updateGroup(idx, { customer_authorized_destructive: e.target.checked })}
                    />
                    <span>
                      {isZh
                        ? "我确认授权对所选抽样实物执行破坏性剪裁取样（如剪样称重/破坏测试）。"
                        : "I authorize destructive sampling for the selected test option."}
                    </span>
                  </label>
                )}
              </div>
            );
          })}

          {mode === "advanced" && groups.length < 20 && (
            <button type="button" className="button" onClick={addGroup}>
              {isZh ? "+ 添加其他服装品类 / 独立服务组" : "+ Add Another Garment Type / Service Group"}
            </button>
          )}

          {/* Optional Promo Code (validated only against published rules) */}
          <div className="row flexwrap" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="text"
              placeholder={isZh ? "优惠码（可选，若有已发布规则）" : "Promo code (optional)"}
              value={promoInput}
              onChange={(e) => setPromoInput(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <button
              type="button"
              className="button sm"
              onClick={() => {
                const clean = promoInput.trim().toUpperCase();
                if (!clean) return;
                if (!promoCodes.includes(clean)) setPromoCodes((prev) => [...prev, clean]);
                setPromoInput("");
              }}
            >
              {isZh ? "应用校验" : "Apply"}
            </button>
            {promoCodes.map((pc) => (
              <button
                key={pc}
                type="button"
                className="tag blue"
                onClick={() => setPromoCodes((prev) => prev.filter((x) => x !== pc))}
              >
                {pc} ✕
              </button>
            ))}
          </div>
        </div>

        {/* Right Column: Live Unified Server Pricing Summary */}
        <div className="pub-calc-result" aria-live="polite">
          <div>
            <div className="pub-eyebrow" style={{ color: "#93b8ff", marginBottom: 2 }}>
              {estimate?.book_version != null
                ? isZh
                  ? `统一引擎实时试算 · 价目表 v${estimate.book_version}`
                  : `UNIFIED ENGINE ESTIMATE · SCHEDULE v${estimate.book_version}`
                : isZh
                  ? "统一报价引擎试算"
                  : "UNIFIED ENGINE ESTIMATE"}
            </div>
            <div className="pub-calc-amount">
              {estimating
                ? isZh
                  ? "正在同步核价…"
                  : "Calculating…"
                : estimate?.status === "no_published_pricing"
                  ? isZh
                    ? "暂无已发布价格表"
                    : "Pricing Unavailable"
                  : estimate?.status === "unavailable"
                    ? isZh
                      ? "含不可售/未开放品类"
                      : "Unavailable Item"
                    : fmtCurrency(estimate?.total_cents ?? null, estimate?.currency ?? "USD")}
            </div>
            <div style={{ fontSize: 13, color: "#bfd4ef", fontWeight: 650 }}>
              {isZh ? `共 ${totalQtySummary} 件实物` : `${totalQtySummary} physical unit(s)`}
              {estimate && !estimate.business_approved && estimate.total_cents !== null && (
                <span> · {isZh ? "沙盒参考价（待营业批准）" : "Sandbox rate (pre-launch)"}</span>
              )}
            </div>
          </div>

          {estimateError && (
            <div className="line-note error" style={{ margin: 0, color: "#fff", background: "rgba(185,28,28,0.35)", borderColor: "#f87171" }}>
              <div>{estimateError}</div>
              <button
                type="button"
                className="button sm"
                style={{ marginTop: 6 }}
                onClick={() => setReloadTick((t) => t + 1)}
              >
                {isZh ? "重新核价" : "Retry"}
              </button>
            </div>
          )}

          {estimate && (
            <>
              <div className="pub-calc-breakdown">
                {estimate.groups.map((grp, idx) => (
                  <div key={grp.group_id} style={{ display: "grid", gap: 4 }}>
                    <div className="row between" style={{ gap: 8 }}>
                      <span>
                        #{idx + 1} {isZh ? (grp.product_type_name_zh ?? grp.product_type_code) : (grp.product_type_name_en ?? grp.product_type_code)} ({grp.base_qty})
                      </span>
                      <strong>
                        {grp.status === "unavailable"
                          ? (isZh ? "不可开放" : "Unavailable")
                          : fmtCurrency(grp.subtotal_cents, estimate.currency)}
                      </strong>
                    </div>
                    {grp.unavailable_reason_zh && (
                      <div style={{ fontSize: 11.5, color: "#fca5a5" }}>
                        {isZh ? grp.unavailable_reason_zh : grp.unavailable_reason_en}
                      </div>
                    )}
                    {grp.line_items.map((li) => (
                      <div key={`${grp.group_id}:${li.code}:${li.option_code ?? ""}`} className="row between" style={{ fontSize: 11.5, color: "#cbd8ea" }}>
                        <span>
                          {isZh ? li.label_zh : li.label_en} × {li.quantity} ({fmtCurrency(li.unit_cents, estimate.currency)} {billingUnitLabel(li.billing_unit, isZh)})
                        </span>
                        <span>{fmtCurrency(li.amount_cents, estimate.currency)}</span>
                      </div>
                    ))}
                  </div>
                ))}

                {estimate.order_adjustments.map((adj) => (
                  <div key={adj.code} className="row between" style={{ fontSize: 12, color: "#fde68a" }}>
                    <span>{isZh ? adj.label_zh : adj.label_en}</span>
                    <strong>{fmtCurrency(adj.amount_cents, estimate.currency)}</strong>
                  </div>
                ))}

                <div className="row between" style={{ borderTop: "1px solid rgba(255,255,255,0.16)", paddingTop: 6 }}>
                  <span>{isZh ? "检后国内运费与超期仓储" : "Post-QC Domestic Shipping & Storage"}</span>
                  <strong>{isZh ? "验后按实重单独核价（非 $0）" : "Estimated later (Not included)"}</strong>
                </div>
              </div>

              <p style={{ margin: 0, fontSize: 12, color: "#cbd8ea", lineHeight: 1.5 }}>
                {isZh ? estimate.post_inspection_charges.storage.label_zh : estimate.post_inspection_charges.storage.label_en}
                <br />
                {isZh ? estimate.turnaround_note_zh : estimate.turnaround_note_en}
              </p>

              {estimate.manual_quote_reasons.length > 0 && (
                <div className="line-note warning" style={{ margin: 0, fontSize: 12 }}>
                  <strong>{isZh ? "需转人工排期/核价：" : "Manual review required:"}</strong>{" "}
                  {estimate.manual_quote_reasons.join(" · ")}
                </div>
              )}

              {estimate.disclosures.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: "#bfd4ef" }}>
                  {estimate.disclosures.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div style={{ display: "grid", gap: 8 }}>
            <Link className="button primary full" href="/login?next=/pricing">
              {isZh ? "登录后继续正式下单 / 认领草稿 →" : "Sign In to Continue With Draft →"}
            </Link>
            <Link
              className="button full"
              href={hrefFor(`/contact?topic=quote&qty=${totalQtySummary}&mode=${mode}`)}
            >
              {estimate?.manual_quote_required
                ? (isZh ? "转人工报价咨询 →" : "Request Staff Manual Quote →")
                : (isZh ? "有疑问？提交售前询价 →" : "Questions? Request Custom Scope →")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
