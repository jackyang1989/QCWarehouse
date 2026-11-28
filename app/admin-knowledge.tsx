"use client";

import { useState } from "react";
import Link from "next/link";
import { BilingualEntityPanel } from "./bilingual-editor";
import { Action, ErrorBlock, Field, Form, Panel, request, Select, Table, Tag, text, useLoad } from "./ui";
import type { Actor } from "../packages/core/common";

type Row = Record<string, any>;

const TABS = [
  { id: "product_type", label: "商品目录与服装分类" },
  { id: "inspection_module", label: "M01–M11 检查模块" },
  { id: "complexity_level", label: "L1–L5 复杂度分级" },
  { id: "check_item", label: "标准检查项" },
  { id: "garment_part", label: "服装解剖部位" },
  { id: "defect_type", label: "19类标准缺陷" },
  { id: "rework_type", label: "9类返工/重检" },
  { id: "terminology", label: "中英专业术语库" },
  { id: "sop", label: "作业规范 SOP" },
  { id: "compiler", label: "任务编译预览" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const STATUS_TONE: Record<string, "green" | "yellow" | "blue" | "red" | "gray" | "outline"> = {
  published: "green",
  in_review: "blue",
  draft: "yellow",
  paused: "gray",
  retired: "red",
};

const TRANSLATABLE_ENTITY_TYPE: Record<string, string | null> = {
  product_type: "catalog_product_type",
  inspection_module: "inspection_module",
  complexity_level: "complexity_level",
  check_item: "knowledge_check_item",
  garment_part: "knowledge_garment_part",
  defect_type: "knowledge_defect_type",
  rework_type: "knowledge_rework_type",
  terminology: "knowledge_terminology_entry",
  sop: "knowledge_sop",
};

export function AdminKnowledgeDesk({ actor }: { actor: Actor }) {
  const [tab, setTab] = useState<TabId>("product_type");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [banner, setBanner] = useState<string>("");
  const [selectedItem, setSelectedItem] = useState<Row | null>(null);
  const [historyItem, setHistoryItem] = useState<{ kind: string; id: string; code: string; entries: Row[] } | null>(null);
  const [editingKind, setEditingKind] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<Row | null>(null);
  const [cloningItem, setCloningItem] = useState<Row | null>(null);
  const [publishSellable, setPublishSellable] = useState<boolean>(true);
  const [compileResult, setCompileResult] = useState<Row | null>(null);

  const overviewLoad = useLoad("/staff/admin/knowledge/overview");
  const activeKind = tab === "compiler" ? "product_type" : tab;
  const queryParams = new URLSearchParams();
  if (statusFilter) queryParams.set("status", statusFilter);
  if (search.trim()) queryParams.set("search", search.trim());
  const entitiesLoad = useLoad(`/staff/admin/knowledge/entities/${activeKind}?${queryParams.toString()}`);

  const canEdit = actor.roles.some((r) => r === "super_admin" || r === "template_admin");
  // Strictly enforce catalog.review / catalog.publish_rollback parity (reviewer or super_admin only)
  const canReview = actor.roles.some((r) => r === "super_admin" || r === "reviewer");
  const overview = (overviewLoad.data as Row | undefined)?.coverage_matrix as Row | undefined;
  const items = ((entitiesLoad.data as Row | undefined)?.items as Row[] | undefined) ?? [];

  function reloadAll() {
    overviewLoad.reload();
    entitiesLoad.reload();
  }

  async function openHistory(kind: string, item: Row) {
    const res = (await request(`/staff/admin/knowledge/entities/${kind}/${item.id}/history`)) as Row;
    setHistoryItem({
      kind,
      id: String(item.id),
      code: String(item.code ?? item.term_code ?? item.id),
      entries: (res.history as Row[]) ?? [],
    });
  }

  const bilingualEntityType = TRANSLATABLE_ENTITY_TYPE[activeKind];
  const submittableDraftIds = items.filter((i) => i.status === "draft").map((i) => String(i.id));
  const publishableIds = items
    .filter(
      (i) =>
        (i.status === "in_review" || i.status === "draft") &&
        i.created_by !== actor.id &&
        i.submitted_by !== actor.id &&
        (activeKind !== "product_type" || i.capability_status !== "not_admitted"),
    )
    .map((i) => String(i.id));

  return (
    <div className="desk-stack">
      <Panel
        title="商品目录与服装专业知识库中心（PAGE-M47）"
        subtitle="管理 L1–L5 复杂度、M01–M11 检验模块、54 类服装目录、标准检查项、24 部位、19 类缺陷、9 类返工、双语专业术语及 SOP。"
        badge={
          <div className="actions">
            <Link className="button sm" href="/admin/measurement-templates">
              动态测量 SVG 编辑器 (PAGE-M23) →
            </Link>
            {canEdit && (
              <Action
                sm
                primary
                run={async () => {
                  const res = (await request("/staff/admin/knowledge/seed-init", "POST", {})) as Row;
                  setBanner(
                    `幂等初始化完成（${String(res.seed_version)}）：新增商品类目 ${String(res.inserted_counts?.product_types ?? 0)} 条，保留既有/人工修改 ${String(res.skipped_existing_counts?.product_types ?? 0)} 条。`,
                  );
                  reloadAll();
                }}
              >
                全量幂等初始化知识库
              </Action>
            )}
            {canEdit && (
              <a className="button sm" href="/api/v1/staff/admin/knowledge/export" target="_blank" rel="noreferrer">
                导出快照 JSON
              </a>
            )}
          </div>
        }
      >
        {overviewLoad.error && <ErrorBlock error={overviewLoad.error} />}
        {entitiesLoad.error && <ErrorBlock error={entitiesLoad.error} />}
        <div className="notice" style={{ marginBottom: 12 }}>
          <strong>商业准入与定价安全声明：</strong>
          所有知识库建议价格（L1–L5 / M01–M11）均标注为 <code className="code">draft_unverified</code>（未经商业批准草稿），
          且箱包 / 家居等非服装类目默认处于 <code className="code">not_admitted / draft</code>（不对公众开放售卖）。
        </div>
        {banner && (
          <div className="notice" style={{ marginBottom: 12 }}>
            {banner}
          </div>
        )}
        {overview && (
          <div className="metric-grid">
            <div className="metric-card">
              <span className="muted small">开放服装分类 / 全部品类</span>
              <strong>{overview.product_types?.apparel_published ?? 0} / {overview.product_types?.apparel_total ?? 0}</strong>
              <span className="small muted">非服装默认关闭：{overview.product_types?.non_apparel_total ?? 0} 类（可售 {overview.product_types?.non_apparel_sellable ?? 0}）</span>
            </div>
            <div className="metric-card">
              <span className="muted small">检验模块 / 复杂度分级</span>
              <strong>{overview.inspection_modules?.total ?? 0} 模块 / {overview.complexity_levels?.total ?? 0} 级</strong>
              <span className="small muted">含基础 {overview.inspection_modules?.base_count ?? 0} · 增值 {overview.inspection_modules?.addon_count ?? 0} · 人工 {overview.inspection_modules?.manual_count ?? 0}</span>
            </div>
            <div className="metric-card">
              <span className="muted small">检查项 / 部位 / 缺陷 / 返工</span>
              <strong>
                {overview.check_items?.total ?? 0} / {overview.garment_parts?.total ?? 0} / {overview.defect_types?.total ?? 0} / {overview.rework_types?.total ?? 0}
              </strong>
              <span className="small muted">含平台免费返工 {overview.rework_types?.platform_free ?? 0} 类（非 AQL 全检）</span>
            </div>
            <div className="metric-card">
              <span className="muted small">双语专业术语 / 作业 SOP</span>
              <strong>{overview.terminology_entries?.distinct_terms ?? 0} 术语对 / {overview.sops?.total ?? 0} SOP</strong>
              <span className="small muted">已发布术语行：{overview.terminology_entries?.published ?? 0} / {overview.terminology_entries?.total ?? 0}</span>
            </div>
          </div>
        )}
      </Panel>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${tab === t.id ? " active" : ""}`}
            onClick={() => {
              setTab(t.id);
              setSelectedItem(null);
              setHistoryItem(null);
              setEditingKind(null);
              setEditingDraft(null);
              setCloningItem(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "compiler" ? (
        <Panel
          title={TABS.find((t) => t.id === tab)?.label ?? "知识库列表"}
          subtitle="任何内容编辑将保存为全新版本草稿并清空审核人，须经非作者独立复核员批准后方可发布生效。"
          badge={
            <div className="actions">
              {canEdit && (
                <button
                  type="button"
                  className="button sm"
                  onClick={() => {
                    setEditingKind(editingKind === activeKind && !editingDraft ? null : activeKind);
                    setEditingDraft(null);
                  }}
                >
                  新建条目
                </button>
              )}
              {canEdit && submittableDraftIds.length > 0 && (
                <Action
                  sm
                  run={async () => {
                    const res = (await request(`/staff/admin/knowledge/entities/${activeKind}/batch-submit`, "POST", {
                      ids: submittableDraftIds.slice(0, 200),
                      note: "Batch submit from PAGE-M47",
                    })) as Row;
                    setBanner(`已批量提审 ${String(res.count)} 条草稿`);
                    reloadAll();
                  }}
                >
                  批量提审（{submittableDraftIds.length}）
                </Action>
              )}
              {canReview && publishableIds.length > 0 && (
                <Action
                  sm
                  primary
                  run={async () => {
                    const res = (await request(`/staff/admin/knowledge/entities/${activeKind}/batch-publish`, "POST", {
                      ids: publishableIds.slice(0, 200),
                      ...(activeKind === "product_type" ? { public_sellable: publishSellable } : {}),
                      note: "Independent reviewer batch publish",
                    })) as Row;
                    setBanner(`独立复核已批准发布 ${String(res.count)} 条记录`);
                    reloadAll();
                  }}
                >
                  批量独立发布（{publishableIds.length}）
                </Action>
              )}
            </div>
          }
        >
          <div className="inline-form" style={{ marginBottom: 12 }}>
            <label>
              <span>状态筛选</span>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">全部状态</option>
                <option value="draft">草稿 (draft)</option>
                <option value="in_review">待审核 (in_review)</option>
                <option value="published">已发布 (published)</option>
                <option value="retired">已退役 (retired)</option>
              </select>
            </label>
            <label>
              <span>关键字检索</span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="编码 / 中英文名称" />
            </label>
            {activeKind === "product_type" && canReview && (
              <label>
                <span>发布公开售卖开关</span>
                <select value={publishSellable ? "yes" : "no"} onChange={(e) => setPublishSellable(e.target.value === "yes")}>
                  <option value="yes">公开可售（须品类已激活）</option>
                  <option value="no">仅内部发布（不对外开放）</option>
                </select>
              </label>
            )}
          </div>

          {cloningItem && canEdit && (
            <div className="card-soft" style={{ marginBottom: 14 }}>
              <Form
                label={`基于「${String(cloningItem.name_zh)} (${String(cloningItem.code)})」复制继承新类型`}
                run={async (f) => {
                  await request(`/staff/admin/knowledge/product-types/${cloningItem.id}/clone`, "POST", {
                    code: text(f, "code").toLowerCase(),
                    name_zh: text(f, "name_zh"),
                    name_en: text(f, "name_en"),
                    note: "Cloned via PAGE-M47",
                  });
                  setCloningItem(null);
                  setBanner("已生成继承草稿并保留父子级关联");
                  reloadAll();
                }}
              >
                <div className="inline-form">
                  <Field name="code" label="新编码（小写字母/数字/下划线）" value={`${String(cloningItem.code)}_custom`} />
                  <Field name="name_zh" label="新中文名称" value={`${String(cloningItem.name_zh)}（延伸）`} />
                  <Field name="name_en" label="New English Name" value={`${String(cloningItem.name_en)} (Variant)`} />
                </div>
              </Form>
            </div>
          )}

          {editingKind === activeKind && canEdit && (
            <div className="card-soft" style={{ marginBottom: 14 }}>
              <Form
                label={editingDraft ? `编辑知识库草稿：${String(editingDraft.code ?? editingDraft.term_code)}` : `新建 ${activeKind} 草稿`}
                run={async (f) => {
                  if (activeKind === "product_type") {
                    await request(`/staff/admin/knowledge/entities/product_type`, "POST", {
                      ...(editingDraft ? { id: editingDraft.id } : {}),
                      code: text(f, "code").toLowerCase(),
                      category_slug: text(f, "category_slug"),
                      group_code: text(f, "group_code"),
                      group_name_zh: text(f, "group_name_zh"),
                      group_name_en: text(f, "group_name_en"),
                      name_zh: text(f, "name_zh"),
                      name_en: text(f, "name_en"),
                      default_complexity_code: text(f, "complexity_code"),
                      billing_unit: text(f, "billing_unit"),
                      applicable_module_codes: text(f, "modules").split(",").map((s) => s.trim()).filter(Boolean),
                      quote_mode: text(f, "quote_mode"),
                      capability_status: text(f, "capability_status"),
                      note: "Edited in PAGE-M47",
                    });
                  } else if (activeKind === "inspection_module") {
                    await request(`/staff/admin/knowledge/entities/inspection_module`, "POST", {
                      ...(editingDraft ? { id: editingDraft.id } : {}),
                      code: text(f, "code").toUpperCase(),
                      name_zh: text(f, "name_zh"),
                      name_en: text(f, "name_en"),
                      description_zh: text(f, "desc_zh"),
                      description_en: text(f, "desc_en"),
                      module_tier: editingDraft?.module_tier ?? "optional_addon",
                      billing_unit: editingDraft?.billing_unit ?? "per_piece",
                      suggested_price_cents: text(f, "price_cents") ? Number(text(f, "price_cents")) : null,
                      scope_boundary_zh: text(f, "scope_zh"),
                      scope_boundary_en: text(f, "scope_en"),
                      note: "Edited in PAGE-M47",
                    });
                  } else if (activeKind === "terminology") {
                    await request(`/staff/admin/knowledge/entities/terminology`, "POST", {
                      ...(editingDraft ? { id: editingDraft.id } : {}),
                      term_code: text(f, "code"),
                      domain: editingDraft?.domain ?? "measurement_pom",
                      locale: text(f, "locale"),
                      standard_name: text(f, "name_zh"),
                      definition: text(f, "desc_zh"),
                      forbidden_translations: text(f, "forbidden").split(",").map((s) => s.trim()).filter(Boolean),
                      note: "Edited in PAGE-M47",
                    });
                  } else {
                    await request(`/staff/admin/knowledge/entities/${activeKind}`, "POST", {
                      ...(editingDraft ? { id: editingDraft.id } : {}),
                      code: text(f, "code"),
                      ...(activeKind === "sop"
                        ? {
                            title_zh: text(f, "name_zh"),
                            title_en: text(f, "name_en"),
                            steps_zh: [text(f, "desc_zh") || "1. 按标准规范执行"],
                            steps_en: [text(f, "desc_en") || "1. Follow standard SOP"],
                          }
                        : {
                            name_zh: text(f, "name_zh"),
                            name_en: text(f, "name_en"),
                            description_zh: text(f, "desc_zh"),
                            description_en: text(f, "desc_en"),
                            ...(activeKind === "check_item"
                              ? {
                                  module_code: editingDraft?.module_code ?? "M01",
                                  method_zh: text(f, "desc_zh") || "目视及标尺核验",
                                  method_en: text(f, "desc_en") || "Visual & scale check",
                                }
                              : {}),
                            ...(activeKind === "complexity_level"
                              ? { pricing_mode: editingDraft?.pricing_mode ?? "fixed_draft" }
                              : {}),
                            ...(activeKind === "defect_type"
                              ? {
                                  category_group: editingDraft?.category_group ?? "appearance",
                                  default_severity: editingDraft?.default_severity ?? "major",
                                  severity_guidance_zh: text(f, "desc_zh") || "按重大缺陷记录",
                                  severity_guidance_en: text(f, "desc_en") || "Log as Major defect",
                                  non_aql_disclaimer_zh: "非 AQL 整批放行判定。",
                                  non_aql_disclaimer_en: "NOT statistical AQL sampling.",
                                }
                              : {}),
                          }),
                      note: "Edited in PAGE-M47",
                    });
                  }
                  setEditingKind(null);
                  setEditingDraft(null);
                  setBanner("已保存为草稿并生成修订快照，等待独立审核发布");
                  reloadAll();
                }}
              >
                <div className="inline-form">
                  <Field name="code" label="编码" value={String(editingDraft?.code ?? editingDraft?.term_code ?? "")} />
                  <Field name="name_zh" label="中文名称 / 标准名" value={String(editingDraft?.name_zh ?? editingDraft?.title_zh ?? editingDraft?.standard_name ?? "")} />
                  <Field name="name_en" label="English Name / Title" value={String(editingDraft?.name_en ?? editingDraft?.title_en ?? "")} />
                </div>
                {activeKind === "product_type" && (
                  <div className="inline-form">
                    <Field name="category_slug" label="所属类目" value={String(editingDraft?.category_slug ?? "apparel")} />
                    <Field name="group_code" label="服装分组" value={String(editingDraft?.group_code ?? "tops")} />
                    <Field name="group_name_zh" label="分组中文" value={String(editingDraft?.group_name_zh ?? "上装")} />
                    <Field name="group_name_en" label="Group EN" value={String(editingDraft?.group_name_en ?? "Tops")} />
                    <Field name="complexity_code" label="默认复杂度(内部)" value={String(editingDraft?.default_complexity_code ?? "L1")} />
                    <Field name="billing_unit" label="计费单位" value={String(editingDraft?.billing_unit ?? "piece")} />
                    <Field name="modules" label="适用模块" value={Array.isArray(editingDraft?.applicable_module_codes) ? editingDraft.applicable_module_codes.join(",") : "M01,M02,M03,M04"} />
                    <Field name="quote_mode" label="报价模式" value={String(editingDraft?.quote_mode ?? "online_standard")} />
                    <Field name="capability_status" label="能力状态" value={String(editingDraft?.capability_status ?? "ready")} />
                  </div>
                )}
                {activeKind === "inspection_module" && (
                  <div className="inline-form">
                    <Field name="price_cents" label="建议草稿价(分)" value={String(editingDraft?.suggested_price_cents ?? "")} />
                    <Field name="desc_zh" label="中文说明" value={String(editingDraft?.description_zh ?? "")} />
                    <Field name="desc_en" label="English Description" value={String(editingDraft?.description_en ?? "")} />
                    <Field name="scope_zh" label="边界声明(中文)" value={String(editingDraft?.scope_boundary_zh ?? "")} />
                    <Field name="scope_en" label="Boundary (EN)" value={String(editingDraft?.scope_boundary_en ?? "")} />
                  </div>
                )}
                {activeKind === "terminology" && (
                  <div className="inline-form">
                    <Field name="locale" label="语言 (zh-CN/en-US)" value={String(editingDraft?.locale ?? "zh-CN")} />
                    <Field name="desc_zh" label="术语定义" value={String(editingDraft?.definition ?? "")} />
                    <Field name="forbidden" label="禁止误译(逗号分隔)" value={Array.isArray(editingDraft?.forbidden_translations) ? editingDraft.forbidden_translations.join(",") : ""} />
                  </div>
                )}
                {activeKind !== "product_type" && activeKind !== "inspection_module" && activeKind !== "terminology" && (
                  <div className="inline-form">
                    <Field name="desc_zh" label="中文说明/方法" value={String(editingDraft?.description_zh ?? editingDraft?.method_zh ?? editingDraft?.severity_guidance_zh ?? "")} />
                    <Field name="desc_en" label="English Description / Method" value={String(editingDraft?.description_en ?? editingDraft?.method_en ?? editingDraft?.severity_guidance_en ?? "")} />
                  </div>
                )}
              </Form>
            </div>
          )}

          <Table
            headers={["编码", "名称 / 标题", "关键属性", "版本与状态", "审核 / 可售状态", "操作"]}
            rows={items.map((item) => {
              const itemCode = String(item.code ?? item.term_code ?? item.id);
              const itemNameZh = String(item.name_zh ?? item.title_zh ?? item.standard_name ?? "");
              const itemNameEn = String(item.name_en ?? item.title_en ?? item.locale ?? "");
              const isAuthor = item.created_by === actor.id || item.submitted_by === actor.id;
              return [
                <span key="c" className="code">
                  {itemCode}
                </span>,
                <div key="n" className="cell-stack">
                  <strong>{itemNameZh}</strong>
                  <small className="muted">{itemNameEn}</small>
                </div>,
                <div key="m" className="cell-stack small">
                  {activeKind === "product_type" && (
                    <span>
                      {String(item.group_name_zh)} · 内部参考 {String(item.default_complexity_code)} · {String(item.quote_mode)}
                    </span>
                  )}
                  {activeKind === "inspection_module" && (
                    <span>
                      {String(item.module_tier)} · {String(item.billing_unit)} · 草稿建议{" "}
                      {item.suggested_price_cents != null ? `$${(Number(item.suggested_price_cents) / 100).toFixed(2)}` : "人工报价"} ({String(item.pricing_status)})
                    </span>
                  )}
                  {activeKind === "complexity_level" && (
                    <span>
                      {String(item.pricing_mode)} · 草稿建议{" "}
                      {item.suggested_base_price_cents != null ? `$${(Number(item.suggested_base_price_cents) / 100).toFixed(2)}` : "人工报价"} ({String(item.pricing_status)})
                    </span>
                  )}
                  {activeKind === "terminology" && (
                    <span>
                      {String(item.domain)} · {String(item.locale)} · 禁用词：{Array.isArray(item.forbidden_translations) ? item.forbidden_translations.length : 0}
                    </span>
                  )}
                  {activeKind === "defect_type" && <span>级别：{String(item.default_severity)} · {String(item.category_group)}</span>}
                  {activeKind === "rework_type" && <span>{item.platform_fault_free_rework ? "平台责免费返工" : "常规返工/需确认"}</span>}
                  {activeKind === "check_item" && <span>所属模块：{String(item.module_code)} · 取证：{String(item.evidence_requirement)}</span>}
                  {activeKind === "garment_part" && <span>适用组别：{Array.isArray(item.applicable_group_codes) ? item.applicable_group_codes.length : 0}</span>}
                  {activeKind === "sop" && <span>适用模块：{(item.applicable_module_codes ?? []).join(", ")}</span>}
                </div>,
                <div key="v" className="cell-stack">
                  <Tag tone={STATUS_TONE[String(item.status)] ?? "gray"}>{String(item.status)}</Tag>
                  <small className="muted">v{String(item.version ?? 1)}</small>
                </div>,
                <div key="s" className="cell-stack small">
                  {activeKind === "product_type" && (
                    <Tag tone={item.public_sellable ? "green" : "gray"}>
                      {item.public_sellable ? "公开可售" : `未公开 (${String(item.capability_status)})`}
                    </Tag>
                  )}
                  <code className="code">{String(item.id).slice(0, 8)}</code>
                </div>,
                <div key="op" className="row flexwrap" style={{ gap: 6 }}>
                  {canEdit && (
                    <button
                      type="button"
                      className="button sm"
                      onClick={() => {
                        setEditingKind(activeKind);
                        setEditingDraft(item);
                      }}
                    >
                      编辑
                    </button>
                  )}
                  {canEdit && activeKind === "product_type" && (
                    <button type="button" className="button sm" onClick={() => setCloningItem(item)}>
                      复制继承
                    </button>
                  )}
                  <button
                    type="button"
                    className="button sm"
                    onClick={() => setSelectedItem(selectedItem?.id === item.id ? null : item)}
                  >
                    {selectedItem?.id === item.id ? "收起双语" : "双语译文"}
                  </button>
                  <button type="button" className="button sm" onClick={() => void openHistory(activeKind, item)}>
                    历史/回滚
                  </button>
                  {canEdit && item.status === "draft" && (
                    <Action
                      sm
                      run={async () => {
                        await request(`/staff/admin/knowledge/entities/${activeKind}/${item.id}/submit`, "POST", {});
                        reloadAll();
                      }}
                    >
                      提审
                    </Action>
                  )}
                  {canReview && (item.status === "in_review" || item.status === "draft") && !isAuthor && (
                    <Action
                      sm
                      primary
                      run={async () => {
                        await request(`/staff/admin/knowledge/entities/${activeKind}/${item.id}/publish`, "POST", {
                          ...(activeKind === "product_type" ? { public_sellable: publishSellable } : {}),
                        });
                        reloadAll();
                      }}
                    >
                      独立发布
                    </Action>
                  )}
                  {canEdit && item.status === "published" && (
                    <Action
                      sm
                      run={async () => {
                        await request(`/staff/admin/knowledge/entities/${activeKind}/${item.id}/retire`, "POST", {});
                        reloadAll();
                      }}
                    >
                      退役停用
                    </Action>
                  )}
                </div>,
              ];
            })}
            empty="暂无数据，可点击上方「全量幂等初始化知识库」导入权威默认目录与专业条目。"
          />

          {historyItem && (
            <div className="card-soft" style={{ marginTop: 14 }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <strong>版本修订历史：{historyItem.code}</strong>
                <button type="button" className="button sm" onClick={() => setHistoryItem(null)}>
                  关闭历史
                </button>
              </div>
              <Table
                headers={["版本", "动作", "时间", "说明", "操作"]}
                rows={historyItem.entries.map((h) => [
                  <span key="v" className="code">v{String(h.version)}</span>,
                  <span key="a">{String(h.action)}</span>,
                  <span key="t" className="small muted">{String(h.created_at)}</span>,
                  <span key="n" className="small">{String(h.note ?? "—")}</span>,
                  canEdit ? (
                    <Action
                      key="rb"
                      sm
                      run={async () => {
                        await request(`/staff/admin/knowledge/entities/${historyItem.kind}/${historyItem.id}/rollback`, "POST", {
                          target_version: Number(h.version),
                          note: `Rollback to v${String(h.version)} via PAGE-M47`,
                        });
                        setBanner(`已回滚至 v${String(h.version)} 作为新草稿，需重新独立复核发布`);
                        reloadAll();
                      }}
                    >
                      回滚至此版本
                    </Action>
                  ) : null,
                ])}
                empty="暂无历史快照"
              />
            </div>
          )}

          {selectedItem && bilingualEntityType && (
            <div style={{ marginTop: 14 }}>
              <BilingualEntityPanel
                key={String(selectedItem.id)}
                entityType={bilingualEntityType}
                entityId={String(selectedItem.id)}
                entityLabel={`${String(selectedItem.code ?? selectedItem.term_code ?? "")} · ${String(selectedItem.name_zh ?? selectedItem.title_zh ?? selectedItem.standard_name ?? "")}`}
                actor={actor}
                sourceLocale={activeKind === "terminology" && selectedItem.locale === "en-US" ? "en-US" : "zh-CN"}
                targetLocale={activeKind === "terminology" && selectedItem.locale === "en-US" ? "zh-CN" : "en-US"}
                fields={[
                  {
                    field_key: "name",
                    label: "标准名称 / 标题",
                    source_text: String(selectedItem.name_zh ?? selectedItem.title_zh ?? selectedItem.standard_name ?? ""),
                    source_revision: Number(selectedItem.version ?? 1),
                  },
                  {
                    field_key: "description",
                    label: "定义 / 方法 / 边界说明",
                    source_text: String(
                      selectedItem.description_zh ??
                        selectedItem.method_zh ??
                        selectedItem.scope_boundary_zh ??
                        selectedItem.definition ??
                        selectedItem.safety_and_boundary_zh ??
                        "",
                    ),
                    source_revision: Number(selectedItem.version ?? 1),
                  },
                ]}
              />
            </div>
          )}
        </Panel>
      ) : (
        <Panel
          title="知识库任务编译消费者预览"
          subtitle="验证特定服装分类、已选检验模块与破坏性授权校验如何编译为真实仓库检查项、部位、缺陷、SOP 与双语术语。"
        >
          <Form
            label="运行知识库任务编译预览"
            run={async (f) => {
              const code = text(f, "product_type_code").trim();
              const mods = text(f, "selected_modules")
                .split(",")
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean);
              const gsmOpt = text(f, "gsm_option") === "gsm";
              const res = (await request("/staff/admin/knowledge/compile-preview", "POST", {
                product_type_code: code,
                selected_module_codes: mods,
                ...(gsmOpt ? { selected_module_options: { M05: "fabric_gsm_destructive" } } : {}),
                customer_authorized_destructive: text(f, "destructive_auth") === "yes",
              })) as Row;
              setCompileResult(res);
            }}
          >
            <div className="inline-form">
              <Field name="product_type_code" label="已发布服装编码 (如 t_shirt, down_jacket)" value="t_shirt" />
              <Field name="selected_modules" label="附加模块 (逗号分隔，如 M02,M03,M05)" value="M02,M03" />
              <Select
                name="gsm_option"
                label="M05 重量 / GSM 子选项"
                choices={[
                  { id: "weight", label: "整衣实称克重 (非破坏性 $2)" },
                  { id: "gsm", label: "面料 GSM 破坏性圆盘取样 ($12)" },
                ]}
              />
              <Select
                name="destructive_auth"
                label="破坏性 GSM 客户授权"
                choices={[
                  { id: "no", label: "未授权破坏性取样" },
                  { id: "yes", label: "已获客户明确破坏性授权" },
                ]}
              />
            </div>
          </Form>

          {compileResult && (
            <div className="card-soft" style={{ marginTop: 14 }}>
              <p>
                <strong>已编译品类：</strong> {String(compileResult.product_type?.name_zh)} ({String(compileResult.product_type?.code)}) ·{" "}
                <strong>人工报价要求：</strong> {compileResult.manual_quote_required ? "是（L5/M11）" : "否"}
              </p>
              <p className="small muted">
                基础包含模块（不重复加收）：{(compileResult.included_base_modules ?? []).map((m: Row) => m.code).join(", ")} | 增值模块：
                {(compileResult.billable_addon_modules ?? []).map((m: Row) => m.code).join(", ") || "无"} | 检查项：
                {(compileResult.check_items ?? []).length} 项 | 部位：{(compileResult.garment_parts ?? []).length} 处 | 缺陷：
                {(compileResult.defect_types ?? []).length} 类 | SOP：{(compileResult.sops ?? []).length} 份 | 双语术语：
                {(compileResult.terminology ?? []).length} 条
              </p>
              <p className="small muted">{String(compileResult.disclaimers?.zh ?? "")}</p>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
