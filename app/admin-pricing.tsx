"use client";

import { useState } from "react";
import { AdminCapacitySlaPanel } from "./admin-capacity-sla";
import { AdminCostMarginPanel } from "./admin-cost-margin";
import { BilingualEntityPanel } from "./bilingual-editor";
import { Action, ErrorBlock, Field, Form, Panel, request, Select, Table, Tag, text, useLoad } from "./ui";
import type { Actor } from "../packages/core/common";

type Row = Record<string, any>;

const STATUS_TONE: Record<string, "green" | "yellow" | "blue" | "red" | "gray" | "outline"> = {
  published: "green",
  in_review: "blue",
  draft: "yellow",
  retired: "red",
};

const WORKED_TITLES: Record<string, string> = {
  ex1_single_l1_m01_m02: "算例 1：1 件 L1 基础 + 5点测量 ($5+$12 = $17)",
  ex2_batch_50_partial_10m02_5m04: "算例 2：50件基础 + 10件5点 + 5件面料 (50×5+10×12+5×7 = $405)",
  ex3_compare_3_l1_full: "算例 3：3件比较 + 全项模块 + 比较费 ($35 + 3×29 = $122)",
  ex4_golden_match_5_l1_same_ref: "算例 4：同一确认样匹配5件 + 基础/5点 ($10 + 5×25 = $135)",
};

const TRANSLATOR_ELIGIBLE_ROLES = new Set(["super_admin", "template_admin", "reviewer", "support"]);

function fmtMoney(cents: number, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function toDatetimeLocalValue(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AdminPricingDesk({ actor }: { actor: Actor }) {
  const [deskTab, setDeskTab] = useState<"pricing" | "cost_margin" | "capacity_sla">("pricing");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [draftMeta, setDraftMeta] = useState<Record<string, any> | null>(null);
  const [draftComplexity, setDraftComplexity] = useState<Record<string, any> | null>(null);
  const [draftModules, setDraftModules] = useState<Record<string, any> | null>(null);
  const [draftServiceRules, setDraftServiceRules] = useState<Record<string, any> | null>(null);
  const [draftOrderRules, setDraftOrderRules] = useState<Record<string, any> | null>(null);
  const [draftPtOverrides, setDraftPtOverrides] = useState<Record<string, any> | null>(null);
  const [draftDiscountRules, setDraftDiscountRules] = useState<Row[] | null>(null);
  const [draftVolumeTiers, setDraftVolumeTiers] = useState<Row[] | null>(null);

  const [cloningBook, setCloningBook] = useState<Row | null>(null);
  const [batchDiffs, setBatchDiffs] = useState<Row[] | null>(null);
  const [batchPayload, setBatchPayload] = useState<Record<string, any> | null>(null);
  const [simResult, setSimResult] = useState<Row | null>(null);
  const [exportSnapshot, setExportSnapshot] = useState<Row | null>(null);
  const [diffBaseVer, setDiffBaseVer] = useState<string>("");
  const [diffTargetVer, setDiffTargetVer] = useState<string>("");
  const [banner, setBanner] = useState("");
  const [actionError, setActionError] = useState("");

  const overviewLoad = useLoad("/staff/admin/pricing/overview");
  const q = new URLSearchParams();
  if (statusFilter) q.set("status", statusFilter);
  if (search.trim()) q.set("search", search.trim());
  const listLoad = useLoad(`/staff/admin/pricing/books?${q.toString()}`);
  const detailLoad = useLoad(selectedId ? `/staff/admin/pricing/books/${selectedId}` : null);

  const canEdit = actor.roles.some((r) => r === "super_admin" || r === "finance");
  const canReview = actor.roles.some((r) => r === "super_admin" || r === "reviewer");
  const canTranslate = actor.roles.some((r) => TRANSLATOR_ELIGIBLE_ROLES.has(r));

  const overview = overviewLoad.data as Row | undefined;
  const books = ((listLoad.data as Row | undefined)?.books as Row[] | undefined) ?? [];
  const detail = detailLoad.data as Row | undefined;
  const book = detail?.book as Row | undefined;
  const versions = (detail?.versions as Row[] | undefined) ?? [];
  const workedExamples = (detail?.worked_examples as Row[] | undefined) ?? [];

  const activeCurrency = String(draftMeta?.currency ?? book?.currency ?? "USD");
  const activeComplexity = draftComplexity ?? (book?.complexity_rates as Record<string, any> | undefined) ?? {};
  const activeModules = draftModules ?? (book?.module_rates as Record<string, any> | undefined) ?? {};
  const activeServiceRules = draftServiceRules ?? (book?.service_rules as Record<string, any> | undefined) ?? {};
  const activePtOverrides = draftPtOverrides ?? (book?.product_type_overrides as Record<string, any> | undefined) ?? {};
  const activeDiscountRules = draftDiscountRules ?? ((book?.discount_rules as Row[] | undefined) ?? []);
  const activeVolumeTiers = draftVolumeTiers ?? ((book?.volume_discount_tiers as Row[] | undefined) ?? []);
  const activeEffectiveFrom =
    draftOrderRules && "effective_from" in draftOrderRules
      ? (draftOrderRules.effective_from as string | null)
      : ((book?.effective_from as string | null) ?? null);

  const hasUnsaved = Boolean(
    draftMeta ||
      draftComplexity ||
      draftModules ||
      draftServiceRules ||
      draftOrderRules ||
      draftPtOverrides ||
      draftDiscountRules ||
      draftVolumeTiers,
  );

  function resetDrafts(clearContext = true) {
    setDraftMeta(null);
    setDraftComplexity(null);
    setDraftModules(null);
    setDraftServiceRules(null);
    setDraftOrderRules(null);
    setDraftPtOverrides(null);
    setDraftDiscountRules(null);
    setDraftVolumeTiers(null);
    setBatchDiffs(null);
    setBatchPayload(null);
    setActionError("");
    if (clearContext) {
      setSimResult(null);
      setCloningBook(null);
      setExportSnapshot(null);
      setDiffBaseVer("");
      setDiffTargetVer("");
    }
  }

  function reloadAll() {
    overviewLoad.reload();
    listLoad.reload();
    if (selectedId) detailLoad.reload();
  }

  async function saveBookDraft() {
    if (!book) return;
    setActionError("");
    try {
      const effectiveIso =
        activeEffectiveFrom && String(activeEffectiveFrom).trim()
          ? new Date(String(activeEffectiveFrom)).toISOString()
          : null;
      await request("/staff/admin/pricing/books", "POST", {
        id: book.id,
        code: book.code,
        name_zh: draftMeta?.name_zh ?? book.name_zh,
        name_en: draftMeta?.name_en ?? book.name_en,
        description_zh: draftMeta?.description_zh ?? book.description_zh ?? "",
        description_en: draftMeta?.description_en ?? book.description_en ?? "",
        currency: activeCurrency,
        rounding_mode: draftOrderRules?.rounding_mode ?? book.rounding_mode ?? "ceil",
        auto_volume_discount_enabled:
          draftOrderRules?.auto_volume_discount_enabled ?? Boolean(book.auto_volume_discount_enabled),
        volume_discount_justification:
          draftOrderRules && "volume_discount_justification" in draftOrderRules
            ? draftOrderRules.volume_discount_justification
            : (book.volume_discount_justification ?? null),
        minimum_order_cents: Number(draftOrderRules?.minimum_order_cents ?? book.minimum_order_cents ?? 0),
        order_fixed_fee_cents: Number(draftOrderRules?.order_fixed_fee_cents ?? book.order_fixed_fee_cents ?? 0),
        max_online_quantity: Number(draftOrderRules?.max_online_quantity ?? book.max_online_quantity ?? 300),
        max_online_total_cents: Number(draftOrderRules?.max_online_total_cents ?? book.max_online_total_cents ?? 5_000_000),
        quote_validity_hours: Number(draftOrderRules?.quote_validity_hours ?? book.quote_validity_hours ?? 72),
        effective_from: effectiveIso,
        complexity_rates: activeComplexity,
        module_rates: activeModules,
        service_rules: activeServiceRules,
        product_type_overrides: activePtOverrides,
        customer_overrides: book.customer_overrides ?? {},
        discount_rules: activeDiscountRules,
        volume_discount_tiers: activeVolumeTiers,
        commercial_policy_matrix: book.commercial_policy_matrix ?? {},
        note: "Saved via PAGE-M22 Unified Pricing Console",
      });
      resetDrafts();
      setBanner("已保存统一价格簿修订草稿，等待非作者独立审核后生效");
      reloadAll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "保存失败");
    }
  }

  const verA = versions.find((v) => String(v.version) === diffBaseVer);
  const verB = versions.find((v) => String(v.version) === diffTargetVer);
  const versionDiffRows: Row[] = (() => {
    if (!verA || !verB) return [];
    const sA = (verA.effective_snapshot ?? {}) as Row;
    const sB = (verB.effective_snapshot ?? {}) as Row;
    const rows: Row[] = [];
    for (const lvl of ["L1", "L2", "L3", "L4", "L5"]) {
      const a = sA.complexity_rates?.[lvl]?.unit_cents ?? null;
      const b = sB.complexity_rates?.[lvl]?.unit_cents ?? null;
      if (a !== b) rows.push({ key: `complexity:${lvl}`, a: a == null ? "人工核价" : fmtMoney(Number(a), String(sA.currency ?? "USD")), b: b == null ? "人工核价" : fmtMoney(Number(b), String(sB.currency ?? "USD")) });
    }
    const modKeys = new Set([...Object.keys(sA.module_rates ?? {}), ...Object.keys(sB.module_rates ?? {})]);
    for (const mk of modKeys) {
      const optsA = (sA.module_rates?.[mk]?.options ?? {}) as Row;
      const optsB = (sB.module_rates?.[mk]?.options ?? {}) as Row;
      for (const ok of new Set([...Object.keys(optsA), ...Object.keys(optsB)])) {
        const va = optsA[ok]?.unit_cents ?? null;
        const vb = optsB[ok]?.unit_cents ?? null;
        if (va !== vb) rows.push({ key: `${mk}:${ok}`, a: va == null ? "—" : fmtMoney(Number(va), String(sA.currency ?? "USD")), b: vb == null ? "—" : fmtMoney(Number(vb), String(sB.currency ?? "USD")) });
      }
    }
    for (const field of ["minimum_order_cents", "order_fixed_fee_cents", "rounding_mode", "auto_volume_discount_enabled", "max_online_quantity", "quote_validity_hours"]) {
      if (String(sA[field] ?? "") !== String(sB[field] ?? "")) {
        rows.push({ key: `rule:${field}`, a: String(sA[field] ?? "—"), b: String(sB[field] ?? "—") });
      }
    }
    return rows;
  })();

  return (
    <div className="desk-stack">
      <div className="actions" style={{ marginBottom: 4 }}>
        <button
          type="button"
          className={`button sm${deskTab === "pricing" ? " primary" : ""}`}
          onClick={() => setDeskTab("pricing")}
        >
          统一价格簿与审批（TASK-197）
        </button>
        <button
          type="button"
          className={`button sm${deskTab === "cost_margin" ? " primary" : ""}`}
          onClick={() => setDeskTab("cost_margin")}
        >
          工时统计、成本模型与毛利沙盘（TASK-198）
        </button>
        <button
          type="button"
          className={`button sm${deskTab === "capacity_sla" ? " primary" : ""}`}
          onClick={() => setDeskTab("capacity_sla")}
        >
          产能与 SLA 计算底座（TASK-199）
        </button>
      </div>
      {deskTab === "capacity_sla" ? (
        <AdminCapacitySlaPanel actor={actor} />
      ) : deskTab === "cost_margin" ? (
        <AdminCostMarginPanel actor={actor} />
      ) : (
        <>
      <Panel
        title="统一商业定价与审批配置中心（PAGE-M22）"
        subtitle="管理内部复杂度基价（对客严格隐藏）、M01–M11 模块分项定价与依赖/互斥、21 种合法计费单位、Compare/Golden 专项模型、优惠与覆盖规则、批量调价预览与 §43.2 算例核算。"
        badge={
          <div className="actions">
            {canEdit && (
              <>
                <button
                  type="button"
                  className="button sm"
                  onClick={() => setShowCreateForm((prev) => !prev)}
                >
                  {showCreateForm ? "收起新建表单" : "+ 新建定价簿"}
                </button>
                <Action
                  sm
                  primary
                  run={async () => {
                    const res = (await request("/staff/admin/pricing/seed-init", "POST", {})) as Row;
                    setBanner(
                      `§43.2 定价簿幂等初始化完成（${String(res.seed_version)}）：新增 ${String(res.inserted_counts?.pricing_books ?? 0)} 套，保留既有 ${String(res.skipped_existing_counts?.pricing_books ?? 0)} 套（默认沙盒草稿态，需 TASK-197B 商业签收后方可开放真实生产售卖）。`,
                    );
                    reloadAll();
                  }}
                >
                  幂等初始化 §43.2 定价草稿簿
                </Action>
              </>
            )}
          </div>
        }
      >
        {overviewLoad.error && <ErrorBlock error={overviewLoad.error} />}
        {listLoad.error && <ErrorBlock error={listLoad.error} />}
        {detailLoad.error && <ErrorBlock error={detailLoad.error} />}
        {actionError && (
          <div className="notice" style={{ borderColor: "#dc2626", color: "#991b1b", marginBottom: 12 }}>
            {actionError}
          </div>
        )}
        {banner && (
          <div className="notice" style={{ marginBottom: 12 }}>
            {banner}
          </div>
        )}

        {showCreateForm && canEdit && (
          <div className="card-soft" style={{ marginBottom: 14 }}>
            <Form
              label="新建统一商业定价草稿簿（基于现有基线结构创建）"
              run={async (f) => {
                const baselineId = text(f, "baseline_id");
                if (!baselineId) {
                  throw new Error("请先点击右上角「幂等初始化 §43.2 定价草稿簿」生成基线模板后再新建。");
                }
                const baseRes = (await request(`/staff/admin/pricing/books/${baselineId}`)) as Row;
                const base = baseRes.book as Row;
                const created = (await request("/staff/admin/pricing/books", "POST", {
                  code: text(f, "code").toLowerCase(),
                  name_zh: text(f, "name_zh"),
                  name_en: text(f, "name_en"),
                  description_zh: text(f, "description_zh"),
                  description_en: text(f, "description_en"),
                  currency: text(f, "currency") || "USD",
                  rounding_mode: base.rounding_mode ?? "ceil",
                  auto_volume_discount_enabled: false,
                  volume_discount_justification: null,
                  minimum_order_cents: Number(base.minimum_order_cents ?? 0),
                  order_fixed_fee_cents: Number(base.order_fixed_fee_cents ?? 0),
                  max_online_quantity: Number(base.max_online_quantity ?? 300),
                  max_online_total_cents: Number(base.max_online_total_cents ?? 5_000_000),
                  quote_validity_hours: Number(base.quote_validity_hours ?? 72),
                  complexity_rates: base.complexity_rates,
                  module_rates: base.module_rates,
                  service_rules: base.service_rules,
                  product_type_overrides: {},
                  customer_overrides: {},
                  discount_rules: [],
                  volume_discount_tiers: [],
                  commercial_policy_matrix: {},
                  note: "Created via PAGE-M22 + New Pricing Book",
                })) as Row;
                setShowCreateForm(false);
                setSelectedId(String(created.id));
                resetDrafts();
                setBanner(`已创建新定价草稿簿 ${String(created.code)}`);
                reloadAll();
              }}
            >
              <div className="inline-form">
                <Select
                  name="baseline_id"
                  label="参考结构基线"
                  choices={books.map((b) => ({ id: String(b.id), label: `${String(b.code)} · ${String(b.name_zh)}` }))}
                />
                <Field name="code" label="唯一编码（小写字母/数字/下划线）" value="apparel_custom_usd" />
                <Field name="name_zh" label="中文名称" value="定制服装质检定价草稿" />
                <Field name="name_en" label="English Name" value="Custom Apparel Pricing Schedule" />
                <Select
                  name="currency"
                  label="结算币种"
                  choices={[
                    { id: "USD", label: "USD" },
                    { id: "CNY", label: "CNY" },
                    { id: "HKD", label: "HKD" },
                    { id: "EUR", label: "EUR" },
                    { id: "GBP", label: "GBP" },
                  ]}
                />
                <Field name="description_zh" label="中文说明" value="新建模块化定价草稿簿" required={false} />
                <Field name="description_en" label="English Description" value="New modular pricing draft" required={false} />
              </div>
            </Form>
          </div>
        )}

        {overview?.summary && (
          <div className="metric-grid">
            <div className="metric-card">
              <span className="muted small">统一价格簿</span>
              <strong>{overview.summary.total_books ?? 0} 套（已发布 {overview.summary.published_books ?? 0}）</strong>
              <span className="small muted">支持 21 种标准计费单位 · 自动批量折扣默认关闭</span>
            </div>
            <div className="metric-card">
              <span className="muted small">不可变冻结版本</span>
              <strong>{overview.summary.versions_total ?? 0} 个历史版本</strong>
              <span className="small muted">business_approved=false（仅限验收/沙盒测试）</span>
            </div>
            <div className="metric-card">
              <span className="muted small">已存档服务端正式报价单</span>
              <strong>{overview.summary.quotes_total ?? 0} 笔有效/锁定报价</strong>
              <span className="small muted">新价发布自动拦截过期/PRICE_CHANGED（T01/T30）</span>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="价格簿目录与独立审核状态" subtitle="遵循严格三权分立：财务/超管起草与提审，非作者独立审核人（reviewer/super_admin）批准发布不可变版本。">
        <div className="inline-form" style={{ marginBottom: 12 }}>
          <label>
            <span>状态筛选</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">全部</option>
              <option value="draft">草稿 (draft)</option>
              <option value="in_review">待审核 (in_review)</option>
              <option value="published">已发布 (published)</option>
              <option value="retired">已退役 (retired)</option>
            </select>
          </label>
          <label>
            <span>编码/名称搜索</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="apparel_modular_usd" />
          </label>
        </div>

        {cloningBook && canEdit && (
          <div className="card-soft" style={{ marginBottom: 14 }}>
            <Form
              key={String(cloningBook.id)}
              label={`复制「${String(cloningBook.name_zh)}」为新定价簿`}
              run={async (f) => {
                const created = (await request(`/staff/admin/pricing/books/${cloningBook.id}/clone`, "POST", {
                  code: text(f, "code").toLowerCase(),
                  name_zh: text(f, "name_zh"),
                  name_en: text(f, "name_en"),
                })) as Row;
                setSelectedId(String(created.id));
                resetDrafts();
                setBanner(`已复制定价簿 ${String(created.code)} 为新草稿`);
                reloadAll();
              }}
            >
              <div className="inline-form">
                <Field name="code" label="新编码" value={`${String(cloningBook.code)}_v2`} />
                <Field name="name_zh" label="中文名称" value={`${String(cloningBook.name_zh)}（副本）`} />
                <Field name="name_en" label="English Name" value={`${String(cloningBook.name_en)} (Clone)`} />
                <button type="button" className="button sm" onClick={() => setCloningBook(null)}>
                  取消复制
                </button>
              </div>
            </Form>
          </div>
        )}

        <Table
          headers={["编码", "名称 / 范围", "币种与自动折扣", "状态 / 版本", "操作"]}
          rows={books.map((b) => {
            const isAuthor = b.created_by === actor.id || b.submitted_by === actor.id;
            const cur = String(b.currency ?? "USD");
            return [
              <span key="c" className="code">{String(b.code)}</span>,
              <div key="n" className="cell-stack">
                <strong>{String(b.name_zh)}</strong>
                <small className="muted">作用域：{String(b.publication_scope)} · 商业终批：{b.business_approved ? "是" : "否（仅测试验收）"}</small>
              </div>,
              <div key="cur" className="cell-stack small">
                <span>{cur} · 最低消费 {fmtMoney(Number(b.minimum_order_cents ?? 0), cur)}</span>
                <span className="muted">自动数量折扣：{b.auto_volume_discount_enabled ? "开启（有工时依据）" : "关闭（默认）"}</span>
              </div>,
              <div key="st" className="cell-stack">
                <Tag tone={STATUS_TONE[String(b.status)] ?? "gray"}>{String(b.status)}</Tag>
                <small className="muted">草稿 d{String(b.current_draft_version)} {b.published_version ? `· 已发布 v${String(b.published_version)}` : ""}</small>
              </div>,
              <div key="op" className="row flexwrap" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="button sm primary"
                  onClick={() => {
                    setSelectedId(String(b.id));
                    resetDrafts();
                  }}
                >
                  可视化配置与算例
                </button>
                {canEdit && (
                  <button type="button" className="button sm" onClick={() => setCloningBook(b)}>
                    复制
                  </button>
                )}
                {canEdit && (
                  <Action
                    sm
                    run={async () => {
                      const snap = (await request(`/staff/admin/pricing/books/${b.id}/export`)) as Row;
                      setSelectedId(String(b.id));
                      setExportSnapshot(snap);
                    }}
                  >
                    导出快照
                  </Action>
                )}
                {canEdit && b.status === "draft" && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/admin/pricing/books/${b.id}/submit`, "POST", {});
                      resetDrafts();
                      setBanner(`价格簿 ${String(b.code)} 已提交独立审核`);
                      reloadAll();
                    }}
                  >
                    提审
                  </Action>
                )}
                {canReview && (b.status === "draft" || b.status === "in_review") && !isAuthor && (
                  <Action
                    sm
                    primary
                    run={async () => {
                      await request(`/staff/admin/pricing/books/${b.id}/publish`, "POST", { note: "Independent review publish (sandbox)" });
                      resetDrafts();
                      setBanner(`已独立审核并冻结发布价格簿 ${String(b.code)}`);
                      reloadAll();
                    }}
                  >
                    独立发布
                  </Action>
                )}
                {canEdit && b.status === "published" && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/admin/pricing/books/${b.id}/retire`, "POST", {});
                      resetDrafts();
                      setBanner(`已下线退役价格簿 ${String(b.code)}`);
                      reloadAll();
                    }}
                  >
                    退役
                  </Action>
                )}
              </div>,
            ];
          })}
          empty="尚未初始化定价簿，请点击上方按钮初始化 §43.2 服装模块化定价草稿。"
        />

        {exportSnapshot && (
          <div className="card-soft" style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <strong>快照导出：{String(exportSnapshot.book?.code ?? "")}（{String(exportSnapshot.exported_at ?? "")}）</strong>
              <button type="button" className="button sm" onClick={() => setExportSnapshot(null)}>
                关闭导出预览
              </button>
            </div>
            <pre className="small" style={{ maxHeight: 240, overflow: "auto", margin: 0 }}>
              {JSON.stringify(exportSnapshot, null, 2)}
            </pre>
          </div>
        )}
      </Panel>

      {selectedId && book && (
        <>
          <Panel
            title={`可视化定价矩阵编辑器：${String(draftMeta?.name_zh ?? book.name_zh)} (${String(book.code)})`}
            subtitle="禁止散落硬编码，全部费率使用整数最小货币单位，支持所见即所得调整后一键运行 §43.2 四组算例检验。"
            badge={
              canEdit && hasUnsaved ? (
                <div className="actions">
                  <Action sm primary run={saveBookDraft}>
                    保存全部价格改动为新草稿
                  </Action>
                  <button type="button" className="button sm" onClick={() => resetDrafts(false)}>
                    放弃未保存改动
                  </button>
                </div>
              ) : null
            }
          >
            <div className="card-soft" style={{ marginBottom: 14 }}>
              <strong>0. 价格簿基础信息、币种与排期设置</strong>
              <div className="inline-form" style={{ marginTop: 8 }}>
                <label>
                  <span>中文名称</span>
                  <input
                    disabled={!canEdit}
                    value={String(draftMeta?.name_zh ?? book.name_zh ?? "")}
                    onChange={(e) => setDraftMeta({ ...(draftMeta ?? {}), name_zh: e.target.value })}
                  />
                </label>
                <label>
                  <span>English Name</span>
                  <input
                    disabled={!canEdit}
                    value={String(draftMeta?.name_en ?? book.name_en ?? "")}
                    onChange={(e) => setDraftMeta({ ...(draftMeta ?? {}), name_en: e.target.value })}
                  />
                </label>
                <label>
                  <span>结算币种</span>
                  <select
                    disabled={!canEdit}
                    value={activeCurrency}
                    onChange={(e) => setDraftMeta({ ...(draftMeta ?? {}), currency: e.target.value })}
                  >
                    {["USD", "CNY", "HKD", "EUR", "GBP"].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>取整模式</span>
                  <select
                    disabled={!canEdit}
                    value={String(draftOrderRules?.rounding_mode ?? book.rounding_mode ?? "ceil")}
                    onChange={(e) => setDraftOrderRules({ ...(draftOrderRules ?? {}), rounding_mode: e.target.value })}
                  >
                    <option value="ceil">向上取整 (ceil)</option>
                    <option value="round">四舍五入 (round)</option>
                    <option value="floor">向下取整 (floor)</option>
                  </select>
                </label>
                <label>
                  <span>中文说明</span>
                  <input
                    disabled={!canEdit}
                    value={String(draftMeta?.description_zh ?? book.description_zh ?? "")}
                    onChange={(e) => setDraftMeta({ ...(draftMeta ?? {}), description_zh: e.target.value })}
                  />
                </label>
                <label>
                  <span>English Description</span>
                  <input
                    disabled={!canEdit}
                    value={String(draftMeta?.description_en ?? book.description_en ?? "")}
                    onChange={(e) => setDraftMeta({ ...(draftMeta ?? {}), description_en: e.target.value })}
                  />
                </label>
                <label>
                  <span>定时生效时间（effective_from，留空则发布即刻生效）</span>
                  <input
                    type="datetime-local"
                    disabled={!canEdit}
                    value={toDatetimeLocalValue(activeEffectiveFrom)}
                    onChange={(e) =>
                      setDraftOrderRules({
                        ...(draftOrderRules ?? {}),
                        effective_from: e.target.value ? new Date(e.target.value).toISOString() : null,
                      })
                    }
                  />
                </label>
              </div>
            </div>

            <div className="card-soft" style={{ marginBottom: 14 }}>
              <strong>1. 内部复杂度基价（L1–L5 · 对客户端及公开目录严格隐藏）</strong>
              <Table
                headers={["等级编码（内部）", "说明", "单件基价（最小货币单位）", "折算金额", "计价模式"]}
                rows={["L1", "L2", "L3", "L4", "L5"].map((lvl) => {
                  const def = activeComplexity[lvl] ?? {};
                  return [
                    <span key="l" className="code">{lvl}</span>,
                    <span key="n" className="small">{String(def.name_zh ?? lvl)}</span>,
                    lvl === "L5" ? (
                      <span key="c" className="muted small">人工专员核价</span>
                    ) : (
                      <input
                        key="c"
                        type="number"
                        disabled={!canEdit}
                        value={Number(def.unit_cents ?? 0)}
                        onChange={(e) => {
                          const next = structuredClone(activeComplexity);
                          next[lvl] = { ...def, unit_cents: Number(e.target.value) };
                          setDraftComplexity(next);
                        }}
                      />
                    ),
                    <strong key="u">{def.unit_cents != null ? fmtMoney(Number(def.unit_cents), activeCurrency) : "Manual Quote"}</strong>,
                    <span key="m" className="small code">{String(def.billing_unit ?? "per_piece")}</span>,
                  ];
                })}
              />
            </div>

            <div className="card-soft" style={{ marginBottom: 14 }}>
              <strong>2. 服务模块费用、依赖与互斥配置（M01–M11）</strong>
              <Table
                headers={["模块", "模块名称与选项", "计费单位", "前置依赖 (requires)", "互斥模块 (mutually_exclusive_with)", "单价（cents）", "金额"]}
                rows={Object.entries(activeModules).flatMap(([mCode, mod]) => {
                  const modObj = mod as Row;
                  return Object.entries(modObj.options ?? {}).map(([optKey, opt]: [string, any]) => [
                    <span key="m" className="code">{mCode}:{optKey}</span>,
                    <div key="n" className="cell-stack small">
                      <strong>{String(modObj.name_zh)}</strong>
                      <span className="muted">{String(opt.label_zh)}</span>
                    </div>,
                    <span key="u" className="code small">{String(opt.billing_unit ?? modObj.billing_unit)}</span>,
                    <input
                      key="req"
                      disabled={!canEdit || mCode === "M01"}
                      value={(modObj.requires ?? []).join(",")}
                      placeholder="M01"
                      onChange={(e) => {
                        const next = structuredClone(activeModules);
                        next[mCode].requires = e.target.value
                          .split(",")
                          .map((s) => s.trim().toUpperCase())
                          .filter(Boolean);
                        setDraftModules(next);
                      }}
                    />,
                    <input
                      key="ex"
                      disabled={!canEdit || mCode === "M01"}
                      value={(modObj.mutually_exclusive_with ?? []).join(",")}
                      placeholder="无"
                      onChange={(e) => {
                        const next = structuredClone(activeModules);
                        next[mCode].mutually_exclusive_with = e.target.value
                          .split(",")
                          .map((s) => s.trim().toUpperCase())
                          .filter(Boolean);
                        setDraftModules(next);
                      }}
                    />,
                    <input
                      key="c"
                      type="number"
                      disabled={!canEdit || opt.manual_quote}
                      value={Number(opt.unit_cents ?? 0)}
                      onChange={(e) => {
                        const next = structuredClone(activeModules);
                        next[mCode].options[optKey].unit_cents = Number(e.target.value);
                        setDraftModules(next);
                      }}
                    />,
                    <strong key="usd">{opt.manual_quote ? "人工报价" : fmtMoney(Number(opt.unit_cents ?? 0), activeCurrency)}</strong>,
                  ]);
                })}
              />
            </div>

            <div className="card-soft" style={{ marginBottom: 14 }}>
              <strong>3. 样品比较、确认样匹配、自动数量折扣政策与订单/风险阈值（§07–§08 / §43.2）</strong>
              <div className="inline-form" style={{ marginTop: 8 }}>
                <label>
                  <span>两件比较费 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(activeServiceRules.compare_2_items_cents ?? 0)}
                    onChange={(e) => setDraftServiceRules({ ...activeServiceRules, compare_2_items_cents: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>三件比较费 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(activeServiceRules.compare_3_items_cents ?? 0)}
                    onChange={(e) => setDraftServiceRules({ ...activeServiceRules, compare_3_items_cents: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>超3件每增加1件 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(activeServiceRules.compare_extra_item_cents ?? 0)}
                    onChange={(e) => setDraftServiceRules({ ...activeServiceRules, compare_extra_item_cents: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>确认样建档封存 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(activeServiceRules.golden_archive_seal_cents ?? 0)}
                    onChange={(e) => setDraftServiceRules({ ...activeServiceRules, golden_archive_seal_cents: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>单批次调用确认样 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(activeServiceRules.golden_call_batch_cents ?? 0)}
                    onChange={(e) => setDraftServiceRules({ ...activeServiceRules, golden_call_batch_cents: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>单件确认样匹配费 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(activeServiceRules.golden_match_item_cents ?? 0)}
                    onChange={(e) => setDraftServiceRules({ ...activeServiceRules, golden_match_item_cents: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>订单固定受理费 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(draftOrderRules?.order_fixed_fee_cents ?? book.order_fixed_fee_cents ?? 0)}
                    onChange={(e) =>
                      setDraftOrderRules({ ...(draftOrderRules ?? {}), order_fixed_fee_cents: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>最低订单金额 (cents, 0=不设)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(draftOrderRules?.minimum_order_cents ?? book.minimum_order_cents ?? 0)}
                    onChange={(e) =>
                      setDraftOrderRules({ ...(draftOrderRules ?? {}), minimum_order_cents: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>在线自动报价数量上限</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(draftOrderRules?.max_online_quantity ?? book.max_online_quantity ?? 300)}
                    onChange={(e) =>
                      setDraftOrderRules({ ...(draftOrderRules ?? {}), max_online_quantity: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>在线自动报价总额上限 (cents)</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(draftOrderRules?.max_online_total_cents ?? book.max_online_total_cents ?? 5_000_000)}
                    onChange={(e) =>
                      setDraftOrderRules({ ...(draftOrderRules ?? {}), max_online_total_cents: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>报价有效期（小时）</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(draftOrderRules?.quote_validity_hours ?? book.quote_validity_hours ?? 72)}
                    onChange={(e) =>
                      setDraftOrderRules({ ...(draftOrderRules ?? {}), quote_validity_hours: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  <span>启用自动数量折扣（须填工时效率依据）</span>
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={Boolean(draftOrderRules?.auto_volume_discount_enabled ?? book.auto_volume_discount_enabled)}
                    onChange={(e) =>
                      setDraftOrderRules({ ...(draftOrderRules ?? {}), auto_volume_discount_enabled: e.target.checked })
                    }
                  />
                </label>
                <label>
                  <span>工时效率依据说明（开启批量折扣必填）</span>
                  <input
                    disabled={!canEdit}
                    value={String(
                      draftOrderRules && "volume_discount_justification" in draftOrderRules
                        ? (draftOrderRules.volume_discount_justification ?? "")
                        : (book.volume_discount_justification ?? ""),
                    )}
                    placeholder="如：同款连续测量可复用量尺基准节约20%工时"
                    onChange={(e) =>
                      setDraftOrderRules({ ...(draftOrderRules ?? {}), volume_discount_justification: e.target.value || null })
                    }
                  />
                </label>
              </div>
            </div>

            <div className="card-soft" style={{ marginBottom: 14 }}>
              <strong>4. 品类特化覆盖价、优惠券/促销规则与批量效率阶梯</strong>
              <div style={{ marginTop: 8 }}>
                <Table
                  headers={["品类编码 (product_type)", "覆盖单价 (cents)", "转人工核价", "备注", "操作"]}
                  rows={Object.entries(activePtOverrides).map(([ptCode, cfg]: [string, any]) => [
                    <span key="c" className="code">{ptCode}</span>,
                    <input
                      key="u"
                      type="number"
                      disabled={!canEdit}
                      value={Number(cfg.unit_cents ?? 0)}
                      onChange={(e) => {
                        const next = structuredClone(activePtOverrides);
                        next[ptCode] = { ...cfg, unit_cents: Number(e.target.value) };
                        setDraftPtOverrides(next);
                      }}
                    />,
                    <Tag key="m" tone={cfg.manual_quote ? "yellow" : "green"}>{cfg.manual_quote ? "manual" : "auto"}</Tag>,
                    <span key="n" className="small muted">{String(cfg.note ?? "—")}</span>,
                    canEdit ? (
                      <button
                        key="rm"
                        type="button"
                        className="button sm"
                        onClick={() => {
                          const next = structuredClone(activePtOverrides);
                          delete next[ptCode];
                          setDraftPtOverrides(next);
                        }}
                      >
                        移除
                      </button>
                    ) : null,
                  ])}
                  empty="暂无品类覆盖特价（默认遵循 L1–L4 复杂度基价）"
                />
                {canEdit && (
                  <Form
                    label="新增品类特价覆盖"
                    run={async (f) => {
                      const code = text(f, "pt_code").toLowerCase();
                      if (!code) return;
                      const next = structuredClone(activePtOverrides);
                      next[code] = {
                        unit_cents: Number(text(f, "unit_cents") || 0),
                        manual_quote: text(f, "manual_quote") === "yes",
                        note: text(f, "note") || undefined,
                      };
                      setDraftPtOverrides(next);
                    }}
                  >
                    <div className="inline-form">
                      <Field name="pt_code" label="品类编码" value="denim_jacket" />
                      <Field name="unit_cents" label="单价 (cents)" value="1500" />
                      <Select name="manual_quote" label="人工核价" choices={[{ id: "no", label: "否" }, { id: "yes", label: "是" }]} />
                      <Field name="note" label="说明" value="" required={false} />
                    </div>
                  </Form>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                <Table
                  headers={["优惠码", "名称", "类型 / 幅度", "可叠加 / 门槛", "状态", "操作"]}
                  rows={activeDiscountRules.map((r, idx) => [
                    <span key="c" className="code">{String(r.code)}</span>,
                    <span key="n" className="small">{String(r.label_zh)} / {String(r.label_en)}</span>,
                    <span key="v" className="small">{r.kind === "percent_off" ? `${String(r.value)}% OFF` : fmtMoney(Number(r.value), activeCurrency)}</span>,
                    <span key="s" className="small muted">{r.stackable ? "可叠加" : "互斥不可叠加"} · 门槛 {fmtMoney(Number(r.min_subtotal_cents ?? 0), activeCurrency)}</span>,
                    <Tag key="a" tone={r.active ? "green" : "gray"}>{r.active ? "启用" : "停用"}</Tag>,
                    canEdit ? (
                      <div key="op" className="row" style={{ gap: 6 }}>
                        <button
                          type="button"
                          className="button sm"
                          onClick={() => {
                            const next = structuredClone(activeDiscountRules);
                            next[idx].active = !next[idx].active;
                            setDraftDiscountRules(next);
                          }}
                        >
                          {r.active ? "停用" : "启用"}
                        </button>
                        <button
                          type="button"
                          className="button sm"
                          onClick={() => setDraftDiscountRules(activeDiscountRules.filter((_, i) => i !== idx))}
                        >
                          删除
                        </button>
                      </div>
                    ) : null,
                  ])}
                  empty="暂无优惠券/促销规则"
                />
                {canEdit && (
                  <Form
                    label="新增优惠券/折扣规则"
                    run={async (f) => {
                      const code = text(f, "code").toUpperCase();
                      if (!code) return;
                      const next = structuredClone(activeDiscountRules.filter((x) => x.code !== code));
                      next.push({
                        code,
                        label_zh: text(f, "label_zh"),
                        label_en: text(f, "label_en"),
                        kind: text(f, "kind") === "percent_off" ? "percent_off" : "fixed_cents",
                        value: Number(text(f, "value") || 1),
                        stackable: text(f, "stackable") === "yes",
                        min_subtotal_cents: Number(text(f, "min_subtotal_cents") || 0),
                        active: true,
                      });
                      setDraftDiscountRules(next);
                    }}
                  >
                    <div className="inline-form">
                      <Field name="code" label="优惠码" value="WELCOME10" />
                      <Field name="label_zh" label="中文说明" value="新客立减" />
                      <Field name="label_en" label="English Label" value="New Client Credit" />
                      <Select name="kind" label="折扣类型" choices={[{ id: "fixed_cents", label: "固定减免 (cents)" }, { id: "percent_off", label: "百分比 (% , 1-100)" }]} />
                      <Field name="value" label="优惠幅度" value="500" />
                      <Select name="stackable" label="可叠加" choices={[{ id: "no", label: "不可叠加" }, { id: "yes", label: "允许叠加" }]} />
                      <Field name="min_subtotal_cents" label="最低小计门槛 (cents)" value="2000" />
                    </div>
                  </Form>
                )}
              </div>

              <div style={{ marginTop: 12 }}>
                <Table
                  headers={["最小件数门槛 (min_qty)", "折扣比例 (%)", "操作"]}
                  rows={activeVolumeTiers.map((t, idx) => [
                    <span key="q" className="code">{String(t.min_qty)} 件+</span>,
                    <strong key="p">{String(t.percent_off)}% OFF</strong>,
                    canEdit ? (
                      <button
                        key="rm"
                        type="button"
                        className="button sm"
                        onClick={() => setDraftVolumeTiers(activeVolumeTiers.filter((_, i) => i !== idx))}
                      >
                        删除
                      </button>
                    ) : null,
                  ])}
                  empty="暂无批量效率阶梯（默认关闭自动数量折扣）"
                />
                {canEdit && (
                  <Form
                    label="新增批量效率折扣阶梯（仅在开启自动折扣并填写工时依据后生效）"
                    run={async (f) => {
                      const minQty = Number(text(f, "min_qty") || 50);
                      const pct = Number(text(f, "percent_off") || 5);
                      const next = structuredClone(activeVolumeTiers.filter((t) => Number(t.min_qty) !== minQty));
                      next.push({ min_qty: minQty, percent_off: pct });
                      next.sort((a, b) => Number(a.min_qty) - Number(b.min_qty));
                      setDraftVolumeTiers(next);
                    }}
                  >
                    <div className="inline-form">
                      <Field name="min_qty" label="件数门槛 (min_qty >= 2)" value="50" />
                      <Field name="percent_off" label="折扣比例 (1-50%)" value="5" />
                    </div>
                  </Form>
                )}
              </div>
            </div>

            {canEdit && (
              <div className="card-soft" style={{ marginBottom: 14 }}>
                <Form
                  label="5. 批量调价预演（必先生成差异预览，再确认写入草稿）"
                  run={async (f) => {
                    const payload = {
                      scope: text(f, "scope") || "module_rates",
                      operation: text(f, "operation") || "percent",
                      delta_value: Number(text(f, "delta_value") || 0),
                      dry_run: true,
                    };
                    const res = (await request(`/staff/admin/pricing/books/${book.id}/batch-adjust`, "POST", payload)) as Row;
                    setBatchDiffs(res.diffs ?? []);
                    setBatchPayload({ ...payload, dry_run: false });
                  }}
                >
                  <div className="inline-form">
                    <Select
                      name="scope"
                      label="调整范围"
                      choices={[
                        { id: "module_rates", label: "M01–M11 模块费率" },
                        { id: "complexity_rates", label: "L1–L4 复杂度基价" },
                        { id: "service_rules", label: "Compare / Golden 专项费率" },
                        { id: "product_type_overrides", label: "品类特价覆盖项" },
                        { id: "all", label: "全部标准费率" },
                      ]}
                    />
                    <Select
                      name="operation"
                      label="调价方式"
                      choices={[
                        { id: "percent", label: "按百分比 (%)" },
                        { id: "fixed_cents", label: "固定增减最小货币单位 (cents)" },
                      ]}
                    />
                    <Field name="delta_value" label="调整幅度（支持负数）" value="10" />
                  </div>
                </Form>
                {batchDiffs && (
                  <div style={{ marginTop: 10 }}>
                    <Table
                      headers={["目标项", "调整前", "调整后"]}
                      rows={batchDiffs.map((d) => [
                        <span key="t" className="code">{String(d.target)}</span>,
                        <span key="b">{fmtMoney(Number(d.before_cents), activeCurrency)}</span>,
                        <strong key="a">{fmtMoney(Number(d.after_cents), activeCurrency)}</strong>,
                      ])}
                      empty="无费率发生变化"
                    />
                    {batchPayload && batchDiffs.length > 0 && (
                      <div className="actions" style={{ marginTop: 8 }}>
                        <Action
                          sm
                          primary
                          run={async () => {
                            await request(`/staff/admin/pricing/books/${book.id}/batch-adjust`, "POST", batchPayload);
                            resetDrafts(false);
                            setBanner("批量调价已写入草稿，请重新核算算例并提交独立审核");
                            reloadAll();
                          }}
                        >
                          确认应用以上 {batchDiffs.length} 项调价到草稿
                        </Action>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Panel>

          <Panel
            title="§43.2 四组强制算例自动核算与沙盒报价模拟器"
            subtitle="验证四组逐项金额、计费单位与编译任务数；测试草稿即使发布也不代表真实营业批准（TASK-197B）。"
          >
            <Table
              headers={["算例场景", "标准预期", "引擎实算总额", "明细分项", "编译任务覆盖", "结论"]}
              rows={workedExamples.map((ex) => {
                const res = ex.result as Row;
                return [
                  <strong key="k" className="small">{WORKED_TITLES[String(ex.key)] ?? String(ex.key)}</strong>,
                  <span key="e" className="code">{fmtMoney(Number(ex.expected_cents), activeCurrency)}</span>,
                  <strong key="a" className="code">{fmtMoney(Number(res.total_cents), activeCurrency)}</strong>,
                  <span key="l" className="small">
                    {(res.line_items ?? []).map((li: Row) => `${String(li.code)}:${fmtMoney(Number(li.amount_cents), activeCurrency)}`).join(" + ")}
                  </span>,
                  <span key="t" className="small">
                    基础 {String(res.compiled_task_plan?.base_task_count)} · {(res.compiled_task_plan?.module_coverages ?? []).map((mc: Row) => `${String(mc.module_code)}×${String(mc.task_count)}`).join(", ")}
                  </span>,
                  <Tag key="m" tone={ex.matched ? "green" : "red"}>{ex.matched ? "PASS" : "MISMATCH"}</Tag>,
                ];
              })}
              empty="暂无算例"
            />

            <div className="card-soft" style={{ marginTop: 14 }}>
              <Form
                label="自定义沙盒报价模拟（支持按比例覆盖取整验证）"
                run={async (f) => {
                  const qty = Number(text(f, "base_qty") || 10);
                  const pct = Number(text(f, "m02_pct") || 0);
                  const modules = pct > 0
                    ? [{ module_code: "M02", option_code: "points_5", coverage_mode: "percentage", coverage_pct: pct }]
                    : [];
                  const res = (await request(`/staff/admin/pricing/books/${book.id}/simulate`, "POST", {
                    service_type: text(f, "service_type") || "inspection",
                    product_type_code: text(f, "product_type_code") || "t_shirt",
                    base_qty: qty,
                    modules,
                    golden_sample_ids: text(f, "service_type") === "reference_match" ? ["SIM-GS-1"] : [],
                    allow_unpublished_catalog_in_sim: true,
                  })) as Row;
                  setSimResult(res);
                }}
              >
                <div className="inline-form">
                  <Select
                    name="service_type"
                    label="服务类型"
                    choices={[
                      { id: "inspection", label: "Product Inspection" },
                      { id: "compare", label: "Sample Comparison" },
                      { id: "reference_match", label: "Golden Sample Matching" },
                    ]}
                  />
                  <Field name="product_type_code" label="服装品类编码" value="t_shirt" />
                  <Field name="base_qty" label="委托数量" value="7" />
                  <Field name="m02_pct" label="M02 抽检比例 (% , 0=不选)" value="20" />
                </div>
              </Form>
              {simResult && (
                <div className="notice" style={{ marginTop: 10 }}>
                  <strong>模拟总计：{fmtMoney(Number(simResult.total_cents), String(simResult.currency ?? activeCurrency))}</strong> · 人工报价触发：{simResult.manual_quote_required ? "是" : "否"} ·{" "}
                  {(simResult.line_items ?? []).map((l: Row) => `${String(l.label_zh)}(${String(l.quantity)}×${fmtMoney(Number(l.unit_cents), String(simResult.currency ?? activeCurrency))}=${fmtMoney(Number(l.amount_cents), String(simResult.currency ?? activeCurrency))})`).join(" | ")}
                </div>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              {canTranslate ? (
                <BilingualEntityPanel
                  key={String(book.id)}
                  entityType="pricing_book"
                  entityId={String(book.id)}
                  entityLabel={`价格簿双语显示说明：${String(book.name_zh)}（严禁翻译更改货币/数值）`}
                  actor={actor}
                  fields={[
                    { field_key: "name", label: "价格簿标题 (Name)", source_text: String(book.name_zh), source_revision: Number(book.current_draft_version ?? 1) },
                    { field_key: "description", label: "价格政策与范围说明 (Description)", source_text: String(book.description_zh ?? ""), source_revision: Number(book.current_draft_version ?? 1) },
                  ]}
                />
              ) : (
                <div className="card-soft small muted">
                  当前账号仅持财务/定价编辑权限，已保存的基础中英文名称与说明会直接随版本冻结；如需维护公开目录的 AI 润色双语覆盖译文，请由具备翻译权限的管理员（super_admin / reviewer / template_admin）在双语工作台发布。
                </div>
              )}
            </div>

            <div className="card-soft" style={{ marginTop: 14 }}>
              <strong>不可变定价发布历史、定时生效撤销与版本对比</strong>
              <Table
                headers={["版本", "状态", "生效时间 (effective_from)", "范围 / 商业终批", "哈希", "发布时间", "操作"]}
                rows={versions.map((v) => {
                  const isFutureScheduled = v.state === "PUBLISHED" && v.effective_from && new Date(String(v.effective_from)).getTime() > Date.now();
                  return [
                    <span key="v" className="code">v{String(v.version)}</span>,
                    <Tag key="s" tone={v.state === "PUBLISHED" ? (isFutureScheduled ? "blue" : "green") : "gray"}>
                      {isFutureScheduled ? "SCHEDULED" : String(v.state)}
                    </Tag>,
                    <span key="ef" className="small muted">{String(v.effective_from ?? v.published_at)}</span>,
                    <span key="p" className="small">{String(v.publication_scope)} · {v.business_approved ? "已商业审批" : "沙盒验收态"}</span>,
                    <code key="h" className="code">{String(v.content_hash).slice(0, 12)}…</code>,
                    <span key="t" className="small muted">{String(v.published_at)}</span>,
                    canEdit ? (
                      <div key="ops" className="row flexwrap" style={{ gap: 6 }}>
                        <Action
                          sm
                          run={async () => {
                            await request(`/staff/admin/pricing/books/${book.id}/rollback`, "POST", { target_version: Number(v.version) });
                            resetDrafts();
                            setBanner(`已从 v${String(v.version)} 回滚生成新草稿，等待独立复核发布`);
                            reloadAll();
                          }}
                        >
                          回滚至 v{String(v.version)} 为草稿
                        </Action>
                        {isFutureScheduled && (
                          <Action
                            sm
                            run={async () => {
                              await request(`/staff/admin/pricing/books/${book.id}/versions/${v.version}/revoke`, "POST", { note: "Revoked before effective_from via PAGE-M22" });
                              resetDrafts();
                              setBanner(`已撤销尚未生效的定时版本 v${String(v.version)}`);
                              reloadAll();
                            }}
                          >
                            撤销未生效排期
                          </Action>
                        )}
                      </div>
                    ) : null,
                  ];
                })}
                empty="尚未发布冻结版本"
              />

              {versions.length >= 2 && (
                <div style={{ marginTop: 12 }}>
                  <div className="inline-form">
                    <label>
                      <span>版本差异对比基准</span>
                      <select value={diffBaseVer} onChange={(e) => setDiffBaseVer(e.target.value)}>
                        <option value="">选择版本 A…</option>
                        {versions.map((v) => (
                          <option key={String(v.version)} value={String(v.version)}>v{String(v.version)} ({String(v.state)})</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>对比目标版本</span>
                      <select value={diffTargetVer} onChange={(e) => setDiffTargetVer(e.target.value)}>
                        <option value="">选择版本 B…</option>
                        {versions.map((v) => (
                          <option key={String(v.version)} value={String(v.version)}>v{String(v.version)} ({String(v.state)})</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {verA && verB && (
                    <div style={{ marginTop: 8 }}>
                      <Table
                        headers={["变更字段", `v${String(verA.version)}`, `v${String(verB.version)}`]}
                        rows={versionDiffRows.map((d) => [
                          <span key="k" className="code">{d.key}</span>,
                          <span key="a">{d.a}</span>,
                          <strong key="b">{d.b}</strong>,
                        ])}
                        empty="所选两版本费率与规则完全一致"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </Panel>
        </>
      )}
        </>
      )}
    </div>
  );
}
