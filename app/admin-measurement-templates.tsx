"use client";

import { useState } from "react";
import { BilingualEntityPanel } from "./bilingual-editor";
import { Action, ErrorBlock, Field, Form, Panel, request, Select, Table, Tag, text, useLoad } from "./ui";
import type { Actor } from "../packages/core/common";
import { sanitizeSvgPure } from "../packages/core/svg-sanitizer-pure";

type Row = Record<string, any>;

const STATUS_TONE: Record<string, "green" | "yellow" | "blue" | "red" | "gray" | "outline"> = {
  published: "green",
  in_review: "blue",
  draft: "yellow",
  retired: "red",
};

const PREVIEW_STATE_BADGES = [
  { key: "pending", label: "待测量", color: "#64748b", icon: "○", sample: "—" },
  { key: "measuring", label: "测量中", color: "#2563eb", icon: "◎", sample: "54.0" },
  { key: "pass", label: "符合公差", color: "#059669", icon: "✓", sample: "54.2" },
  { key: "fail", label: "超出公差", color: "#dc2626", icon: "✕", sample: "56.8" },
  { key: "retest", label: "需复测", color: "#d97706", icon: "↻", sample: "55.9" },
  { key: "missing_photo", label: "已测缺照", color: "#7c3aed", icon: "📷", sample: "54.4" },
  { key: "observed", label: "仅记录值", color: "#475569", icon: "•", sample: "54.1" },
] as const;

function sanitizePreviewMarkup(rawSvg: unknown): { html: string; safe: boolean; reason?: string } {
  const res = sanitizeSvgPure(String(rawSvg ?? ""));
  return res.ok ? { html: res.value.svg, safe: true } : { html: "", safe: false, reason: res.message };
}

function assertClientSafeSvg(rawSvg: string) {
  const res = sanitizeSvgPure(rawSvg);
  if (!res.ok) throw new Error(res.message);
  return res.value;
}

export function AdminMeasurementTemplatesDesk({ actor }: { actor: Actor }) {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<string>("front");
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [pickStep, setPickStep] = useState<"off" | "start" | "end" | "label">("off");
  const [draftPoints, setDraftPoints] = useState<Row[] | null>(null);
  const [draftViews, setDraftViews] = useState<Row[] | null>(null);
  const [draftOverrides, setDraftOverrides] = useState<Row | null>(null);
  const [draftMeta, setDraftMeta] = useState<{
    applicable_product_types_text?: string;
    default_unit?: "cm" | "inch";
    camera_presets_text?: string;
  } | null>(null);
  const [previewMode, setPreviewMode] = useState<string>("pass");
  const [banner, setBanner] = useState<string>("");
  const [editorError, setEditorError] = useState<string>("");
  const [showCreateRoot, setShowCreateRoot] = useState(false);
  const [showAddPoint, setShowAddPoint] = useState(false);
  const [showPresetForm, setShowPresetForm] = useState(false);
  const [cloningSource, setCloningSource] = useState<Row | null>(null);
  const [svgUploadViewKey, setSvgUploadViewKey] = useState<string>("front");
  const [svgUploadText, setSvgUploadText] = useState<string>("");

  const overviewLoad = useLoad("/staff/admin/measurement-templates/overview");
  const q = new URLSearchParams();
  if (statusFilter) q.set("status", statusFilter);
  if (search.trim()) q.set("search", search.trim());
  const listLoad = useLoad(`/staff/admin/measurement-templates?${q.toString()}`);
  const detailLoad = useLoad(selectedId ? `/staff/admin/measurement-templates/${selectedId}` : null);

  const canEdit = actor.roles.some((r) => r === "super_admin" || r === "template_admin");
  const canReview = actor.roles.some((r) => r === "super_admin" || r === "reviewer");

  const overview = overviewLoad.data as Row | undefined;
  const templates = ((listLoad.data as Row | undefined)?.templates as Row[] | undefined) ?? [];
  const cameraPresets = ((overview?.camera_presets as Row[] | undefined) ?? []);
  const detail = detailLoad.data as Row | undefined;
  const rawTpl = detail?.template as Row | undefined;
  const effective = detail?.effective as Row | undefined;
  const versions = ((detail?.versions as Row[] | undefined) ?? []);

  const isInheritedChild = Boolean(rawTpl?.parent_template_id);
  const activeViews: Row[] = draftViews ?? (effective?.views as Row[] | undefined) ?? [];
  const activePoints: Row[] = draftPoints ?? (effective?.points as Row[] | undefined) ?? [];
  const activeOverrides: Row = draftOverrides ??
    (rawTpl?.point_overrides as Row | undefined) ?? { disabled_point_ids: [], overridden_points: {}, added_points: [] };
  const currentViewObj = activeViews.find((v) => v.view_key === activeView) ?? activeViews[0];
  const visiblePoints = activePoints.filter((p) => p.view_key === (currentViewObj?.view_key ?? "front"));
  const selectedPoint = activePoints.find((p) => p.point_id === selectedPointId) ?? visiblePoints[0] ?? null;

  function reloadAll() {
    overviewLoad.reload();
    listLoad.reload();
    if (selectedId) detailLoad.reload();
  }

  function resetDraftBuffers() {
    setDraftPoints(null);
    setDraftViews(null);
    setDraftOverrides(null);
    setDraftMeta(null);
    setPickStep("off");
    setEditorError("");
  }

  function cloneEffectiveBuffers() {
    const pts = draftPoints ? draftPoints.map((p) => ({ ...p })) : ((effective?.points as Row[] | undefined) ?? []).map((p) => ({ ...p }));
    const vws = draftViews ? draftViews.map((v) => ({ ...v })) : ((effective?.views as Row[] | undefined) ?? []).map((v) => ({ ...v }));
    const ovSource = draftOverrides ?? (rawTpl?.point_overrides as Row | undefined) ?? {};
    const ov: Row = {
      disabled_point_ids: [...(Array.isArray(ovSource.disabled_point_ids) ? ovSource.disabled_point_ids : [])],
      overridden_points: { ...(typeof ovSource.overridden_points === "object" && ovSource.overridden_points ? ovSource.overridden_points : {}) },
      added_points: (Array.isArray(ovSource.added_points) ? ovSource.added_points : []).map((p: Row) => ({ ...p })),
    };
    return { pts, vws, ov };
  }

  /**
   * Apply a point update while strictly preserving parent-child inheritance (`point_overrides`) on inherited children!
   */
  function updatePointBuffer(updatedPt: Row) {
    const { pts, ov } = cloneEffectiveBuffers();
    const idx = pts.findIndex((p) => p.point_id === updatedPt.point_id);
    if (idx < 0) return;
    pts[idx] = updatedPt;
    setDraftPoints(pts);

    if (isInheritedChild) {
      const addedIdx = (ov.added_points as Row[]).findIndex((a) => a.point_id === updatedPt.point_id);
      if (addedIdx >= 0) {
        ov.added_points[addedIdx] = updatedPt;
      } else {
        ov.overridden_points[String(updatedPt.point_id)] = { ...updatedPt };
      }
      setDraftOverrides(ov);
    }
  }

  function handleSvgCanvasClick(e: React.MouseEvent<SVGSVGElement>) {
    if (pickStep === "off" || !selectedPoint) return;
    const svgEl = e.currentTarget;
    const rect = svgEl.getBoundingClientRect();
    const vbWidth = Number(currentViewObj?.width ?? 520);
    const vbHeight = Number(currentViewObj?.height ?? 360);
    const x = Math.round(((e.clientX - rect.left) / rect.width) * vbWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * vbHeight);

    const nextPt = { ...selectedPoint };
    if (pickStep === "start") {
      nextPt.start_x = x;
      nextPt.start_y = y;
      setPickStep("end");
    } else if (pickStep === "end") {
      nextPt.end_x = x;
      nextPt.end_y = y;
      nextPt.label_x = Math.round((Number(nextPt.start_x) + x) / 2);
      nextPt.label_y = Math.round((Number(nextPt.start_y) + y) / 2);
      setPickStep("label");
    } else {
      nextPt.label_x = x;
      nextPt.label_y = y;
      setPickStep("off");
    }
    updatePointBuffer(nextPt);
  }

  /**
   * Persist explicit next buffers directly (never relies on stale React state closures).
   */
  async function persistEditorBuffers(explicit?: {
    views?: Row[];
    points?: Row[];
    overrides?: Row;
    meta?: { applicable_product_types_text?: string; default_unit?: "cm" | "inch"; camera_presets_text?: string };
    viewsTouched?: boolean;
  }) {
    if (!rawTpl || !effective) return;
    setEditorError("");
    const current = cloneEffectiveBuffers();
    const nextPts = explicit?.points ?? current.pts;
    const nextVws = explicit?.views ?? current.vws;
    const nextOv = explicit?.overrides ?? current.ov;
    const nextMeta = explicit?.meta ?? draftMeta ?? {};
    const splitCsv = (raw: string) =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    // Re-verify every SVG view through pure-vector sanitizer BEFORE transmission
    const sanitizedViews = nextVws.map((v) => {
      const san = assertClientSafeSvg(String(v.svg ?? ""));
      return { view_key: v.view_key, label_zh: v.label_zh, label_en: v.label_en, svg: san.svg };
    });

    const sendRawViews = isInheritedChild && !explicit?.viewsTouched && !draftViews ? (rawTpl.views ?? []) : sanitizedViews;
    const sendRawPoints = isInheritedChild ? (rawTpl.points ?? []) : nextPts;

    await request("/staff/admin/measurement-templates", "POST", {
      id: rawTpl.id,
      code: rawTpl.code,
      parent_template_id: rawTpl.parent_template_id ?? null,
      name_zh: rawTpl.name_zh,
      name_en: rawTpl.name_en,
      description_zh: rawTpl.description_zh,
      description_en: rawTpl.description_en,
      applicable_product_type_codes:
        nextMeta.applicable_product_types_text !== undefined
          ? splitCsv(nextMeta.applicable_product_types_text)
          : (rawTpl.applicable_product_type_codes ?? []),
      applicable_group_codes: rawTpl.applicable_group_codes ?? [],
      default_unit: nextMeta.default_unit ?? rawTpl.default_unit ?? "cm",
      views: sendRawViews,
      points: sendRawPoints,
      point_overrides: nextOv,
      camera_preset_codes:
        nextMeta.camera_presets_text !== undefined
          ? splitCsv(nextMeta.camera_presets_text)
          : (rawTpl.camera_preset_codes ?? []),
      note: isInheritedChild ? "Updated inherited child overrides via PAGE-M23 visual editor" : "Updated via PAGE-M23 visual SVG editor",
    });
    resetDraftBuffers();
    setBanner("已保存矢量图、点位坐标、绑定规则与公差为新修订草稿，等待独立复核发布");
    reloadAll();
  }

  const badgeSample = PREVIEW_STATE_BADGES.find((b) => b.key === previewMode) ?? PREVIEW_STATE_BADGES[2];
  const publishableIds = templates
    .filter((t) => (t.status === "draft" || t.status === "in_review") && t.created_by !== actor.id && t.submitted_by !== actor.id)
    .map((t) => String(t.id));

  const viewSafeRender = currentViewObj ? sanitizePreviewMarkup(currentViewObj.svg) : { html: "", safe: false };

  return (
    <div className="desk-stack">
      <Panel
        title="动态服装测量图与点位知识库编辑器（PAGE-M23）"
        subtitle="管理 23+ 服装品类专属矢量图模板（覆盖 §04 全部 54 类）、父子继承与局部覆盖、稳定 POM 点位、引导线坐标、多视图、单位公差、摄影机位预设与严格 SVG XSS 清洗。"
        badge={
          <div className="actions">
            {canEdit && (
              <>
                <Action
                  sm
                  primary
                  run={async () => {
                    const res = (await request("/staff/admin/measurement-templates/seed-init", "POST", {})) as Row;
                    setBanner(
                      `23 类服装测量图库幂等初始化完成：新增模板 ${String(res.inserted_counts?.measurement_templates ?? 0)} 套，保留既有/人工修改 ${String(res.skipped_existing_counts?.measurement_templates ?? 0)} 套；摄影机位预设 ${String(res.inserted_counts?.camera_presets ?? 0)} 新增。`,
                    );
                    reloadAll();
                  }}
                >
                  全量幂等初始化测量图库
                </Action>
                <button type="button" className="button sm" onClick={() => setShowCreateRoot(!showCreateRoot)}>
                  {showCreateRoot ? "收起新建根模板" : "+ 新建根模板"}
                </button>
              </>
            )}
            {canReview && publishableIds.length > 0 && (
              <Action
                sm
                primary
                run={async () => {
                  const res = (await request("/staff/admin/measurement-templates/batch-publish", "POST", {
                    ids: publishableIds,
                    note: "Independent reviewer batch publish",
                  })) as Row;
                  setBanner(`独立复核已签发 ${String(res.count)} 套不可变测量模板版本`);
                  reloadAll();
                }}
              >
                批量独立发布（{publishableIds.length}）
              </Action>
            )}
          </div>
        }
      >
        {overviewLoad.error && <ErrorBlock error={overviewLoad.error} />}
        {listLoad.error && <ErrorBlock error={listLoad.error} />}
        {detailLoad.error && <ErrorBlock error={detailLoad.error} />}
        {editorError && (
          <div className="notice" style={{ borderColor: "#dc2626", color: "#991b1b", marginBottom: 12 }}>
            {editorError}
          </div>
        )}
        {banner && (
          <div className="notice" style={{ marginBottom: 12 }}>
            {banner}
          </div>
        )}
        {overview?.summary && (
          <div className="metric-grid">
            <div className="metric-card">
              <span className="muted small">服装测量模板家族</span>
              <strong>{overview.summary.total ?? 0} 套（已发布 {overview.summary.published ?? 0}）</strong>
              <span className="small muted">继承子模板：{overview.summary.inherited_count ?? 0} 套 · 已退役 {overview.summary.retired ?? 0} 套</span>
            </div>
            <div className="metric-card">
              <span className="muted small">不可变发布历史版本数</span>
              <strong>{overview.summary.published_versions_total ?? 0} 个冻结版本</strong>
              <span className="small muted">在检旧任务锁定原版本不漂移（T127）</span>
            </div>
            <div className="metric-card">
              <span className="muted small">仓库摄影机位预设</span>
              <strong>{cameraPresets.length} 组标准机位</strong>
              <span className="small muted">含带刻度皮尺特写 / 正反俯拍 / 翻面内里</span>
            </div>
          </div>
        )}

        {showCreateRoot && canEdit && (
          <div className="card-soft" style={{ marginTop: 14 }}>
            <Form
              label="新建自定义根测量图模板（纯矢量 SVG + 初始 POM 点位）"
              run={async (f) => {
                const san = assertClientSafeSvg(text(f, "svg"));
                const created = (await request("/staff/admin/measurement-templates", "POST", {
                  code: text(f, "code").toLowerCase(),
                  name_zh: text(f, "name_zh"),
                  name_en: text(f, "name_en"),
                  description_zh: text(f, "description_zh"),
                  description_en: text(f, "description_en"),
                  applicable_product_type_codes: text(f, "product_types")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  applicable_group_codes: ["tops"],
                  default_unit: text(f, "default_unit") === "inch" ? "inch" : "cm",
                  views: [{ view_key: "front", label_zh: "正面平铺视图", label_en: "Front Flat-Lay View", svg: san.svg }],
                  points: [
                    {
                      point_id: "pom_body_length_hps",
                      marker_code: "A",
                      view_key: "front",
                      name_zh: "衣长 (HPS)",
                      name_en: "Body Length (HPS)",
                      location_zh: "肩颈点至下摆底边",
                      location_en: "HPS to bottom hem",
                      method_zh: "垂直平铺拉直量取",
                      method_en: "Measure vertically flat.",
                      start_x: 240,
                      start_y: 60,
                      end_x: 240,
                      end_y: 300,
                      label_x: 240,
                      label_y: 180,
                      camera_preset_code: "macro_ruler_pom",
                      check_item_code: "CHK_M02_UPPER_BODY_POM",
                    },
                  ],
                  camera_preset_codes: ["overhead_flat_front", "macro_ruler_pom"],
                })) as Row;
                setShowCreateRoot(false);
                setSelectedId(String(created.id));
                setBanner(`已创建根测量模板 ${String(created.code)}，请继续在下方画布编辑点位后提审`);
                reloadAll();
              }}
            >
              <div className="inline-form">
                <Field name="code" label="模板唯一编码（例：custom_raglan_top）" value="" />
                <Field name="name_zh" label="中文名称" value="" />
                <Field name="name_en" label="English Name" value="" />
                <Field name="product_types" label="绑定服装品类编码（逗号分隔）" value="" />
                <Select name="default_unit" label="默认测量单位" choices={[{ id: "cm", label: "厘米 (cm)" }, { id: "inch", label: "英寸 (inch)" }]} />
              </div>
              <div className="inline-form" style={{ marginTop: 8 }}>
                <Field name="description_zh" label="中文工艺与量法说明" value="适用于特定服装版型几何测量。" />
                <Field name="description_en" label="English Spec Note" value="Custom geometric garment POM template." />
              </div>
              <Field
                name="svg"
                label="正面安全纯矢量底图 SVG"
                value='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 360" width="520" height="360"><rect width="520" height="360" rx="10" fill="#f8fafc" stroke="#cbd5e1"/><path d="M170 72 L350 72 L340 308 L180 308 Z" fill="#e2e8f0" stroke="#334155" stroke-width="2"/></svg>'
              />
            </Form>
          </div>
        )}
      </Panel>

      <Panel title="测量图模板家族目录与审批状态" subtitle="选择任意模板可在下方打开可视化点位拾取画布、点位编辑器、继承覆盖管理与版本冻结历史。">
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
            <span>编码 / 品类检索</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="如 hoodie_sweatshirt / briefs_underwear / tracksuit_set" />
          </label>
        </div>

        {cloningSource && canEdit && (
          <div className="card-soft" style={{ marginBottom: 14 }}>
            <Form
              label={`复制或继承「${String(cloningSource.name_zh)}」生成子模板`}
              run={async (f) => {
                const ptCodes = text(f, "product_types")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                const created = (await request(`/staff/admin/measurement-templates/${cloningSource.id}/clone`, "POST", {
                  code: text(f, "code").toLowerCase(),
                  name_zh: text(f, "name_zh"),
                  name_en: text(f, "name_en"),
                  inherit: text(f, "inherit") === "yes",
                  ...(ptCodes.length ? { applicable_product_type_codes: ptCodes } : {}),
                })) as Row;
                setCloningSource(null);
                setSelectedId(String(created.id));
                resetDraftBuffers();
                setBanner(`已创建子模板 ${String(created.code)}（可仅配置点位差异覆盖而保持父版继承关系）`);
                reloadAll();
              }}
            >
              <div className="inline-form">
                <Field name="code" label="新模板编码" value={`${String(cloningSource.code)}_variant`} />
                <Field name="name_zh" label="中文名称" value={`${String(cloningSource.name_zh)}（延伸版）`} />
                <Field name="name_en" label="English Name" value={`${String(cloningSource.name_en)} (Variant)`} />
                <Field name="product_types" label="绑定服装品类（逗号分隔，可改）" value={(cloningSource.applicable_product_type_codes ?? []).join(",")} />
                <Select
                  name="inherit"
                  label="继承模式"
                  choices={[
                    { id: "yes", label: "继承父模板（仅配置差异覆盖）" },
                    { id: "no", label: "独立副本（完全复制 SVG 与点位）" },
                  ]}
                />
              </div>
            </Form>
          </div>
        )}

        <Table
          headers={["模板编码", "中文 / 英文名称", "适用服装品类", "状态与版本", "操作"]}
          rows={templates.map((t) => {
            const isAuthor = t.created_by === actor.id || t.submitted_by === actor.id;
            return [
              <span key="c" className="code">
                {String(t.code)}
                {t.parent_template_id ? <small className="muted">（继承子版）</small> : null}
              </span>,
              <div key="n" className="cell-stack">
                <strong>{String(t.name_zh)}</strong>
                <small className="muted">{String(t.name_en)}</small>
              </div>,
              <span key="pt" className="small">{(t.applicable_product_type_codes ?? []).join(", ") || "—"}</span>,
              <div key="st" className="cell-stack">
                <Tag tone={STATUS_TONE[String(t.status)] ?? "gray"}>{String(t.status)}</Tag>
                <small className="muted">
                  草稿 d{String(t.current_draft_version)} {t.published_version ? `· 已发布 v${String(t.published_version)}` : ""}
                </small>
              </div>,
              <div key="op" className="row flexwrap" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="button sm primary"
                  onClick={() => {
                    setSelectedId(String(t.id));
                    resetDraftBuffers();
                    setSelectedPointId(null);
                  }}
                >
                  可视化编辑 SVG/点位
                </button>
                {canEdit && (
                  <button type="button" className="button sm" onClick={() => setCloningSource(t)}>
                    继承/复制
                  </button>
                )}
                {canEdit && t.status === "draft" && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/admin/measurement-templates/${t.id}/submit`, "POST", {});
                      reloadAll();
                    }}
                  >
                    提审
                  </Action>
                )}
                {canReview && (t.status === "draft" || t.status === "in_review") && !isAuthor && (
                  <Action
                    sm
                    primary
                    run={async () => {
                      await request(`/staff/admin/measurement-templates/${t.id}/publish`, "POST", {});
                      setBanner(`已独立审核并冻结发布模板 ${String(t.code)}`);
                      reloadAll();
                    }}
                  >
                    独立发布
                  </Action>
                )}
                {canEdit && t.status === "published" && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/admin/measurement-templates/${t.id}/retire`, "POST", {});
                      reloadAll();
                    }}
                  >
                    退役
                  </Action>
                )}
              </div>,
            ];
          })}
          empty="暂无动态测量模板，请点击上方「全量幂等初始化测量图库」。"
        />
      </Panel>

      {selectedId && rawTpl && effective && (
        <Panel
          title={`可视化 SVG 测量图与点位编辑器：${String(rawTpl.name_zh)} (${String(rawTpl.code)})`}
          subtitle={
            isInheritedChild
              ? "当前为继承子模板：编辑点位或公差/绑定将自动写入 point_overrides 差异覆盖区，保持父版引用不断链。"
              : "点击视图标签切换正反面，支持图面拾取坐标、可视化增删与编辑点位、绑定检验项与机位，严格屏蔽可执行 SVG 脚本。"
          }
          badge={
            canEdit && (draftPoints || draftViews || draftOverrides || draftMeta) ? (
              <div className="actions">
                <Action sm primary run={async () => persistEditorBuffers()}>
                  保存全部画布与点位改动为新草稿
                </Action>
                <button type="button" className="button sm" onClick={resetDraftBuffers}>
                  放弃未保存改动
                </button>
              </div>
            ) : null
          }
        >
          <div className="row between flexwrap" style={{ gap: 10, marginBottom: 12 }}>
            <div className="actions">
              {activeViews.map((v) => (
                <button
                  key={String(v.view_key)}
                  type="button"
                  className={`button sm${(currentViewObj?.view_key ?? "front") === v.view_key ? " primary" : ""}`}
                  onClick={() => setActiveView(String(v.view_key))}
                >
                  {String(v.label_zh)} ({String(v.view_key)})
                </button>
              ))}
            </div>
            <label className="row" style={{ gap: 6, fontSize: 12 }}>
              <span>实测联调预览态（§41.4 颜色+图标+文字）：</span>
              <select value={previewMode} onChange={(e) => setPreviewMode(e.target.value)}>
                {PREVIEW_STATE_BADGES.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.icon} {b.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {canEdit && (
            <div className="card-soft" style={{ marginBottom: 14 }}>
              <div className="inline-form">
                <label>
                  <span>适用服装品类编码（逗号分隔）</span>
                  <input
                    value={draftMeta?.applicable_product_types_text ?? (rawTpl.applicable_product_type_codes ?? []).join(",")}
                    onChange={(e) =>
                      setDraftMeta({
                        ...(draftMeta ?? {}),
                        applicable_product_types_text: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  <span>默认单位</span>
                  <select
                    value={draftMeta?.default_unit ?? String(rawTpl.default_unit ?? "cm")}
                    onChange={(e) =>
                      setDraftMeta({
                        ...(draftMeta ?? {}),
                        default_unit: e.target.value === "inch" ? "inch" : "cm",
                      })
                    }
                  >
                    <option value="cm">厘米 (cm)</option>
                    <option value="inch">英寸 (inch)</option>
                  </select>
                </label>
                <label>
                  <span>默认机位组合（逗号分隔）</span>
                  <input
                    value={draftMeta?.camera_presets_text ?? (rawTpl.camera_preset_codes ?? []).join(",")}
                    onChange={(e) =>
                      setDraftMeta({
                        ...(draftMeta ?? {}),
                        camera_presets_text: e.target.value,
                      })
                    }
                  />
                </label>
              </div>
            </div>
          )}

          <div className="split-grid" style={{ display: "grid", gridTemplateColumns: "minmax(340px, 1.15fr) minmax(320px, 1fr)", gap: 16 }}>
            <div className="card-soft">
              {currentViewObj && (
                <>
                  <div className="row between flexwrap" style={{ marginBottom: 8, gap: 6 }}>
                    <span className="small muted">
                      {pickStep === "off"
                        ? "点击图中点位编号可联动定位右侧配置"
                        : `坐标拾取中：请在图上点击「${selectedPoint?.marker_code}」的 ${pickStep === "start" ? "起点" : pickStep === "end" ? "终点" : "标签放置位置"}`}
                    </span>
                    {canEdit && selectedPoint && (
                      <button
                        type="button"
                        className="button sm"
                        onClick={() => setPickStep(pickStep === "off" ? "start" : "off")}
                      >
                        {pickStep === "off" ? `点击图面拾取 ${String(selectedPoint.marker_code)} 坐标` : "退出拾取"}
                      </button>
                    )}
                  </div>
                  <div style={{ position: "relative", border: "1px solid #cbd5e1", borderRadius: 10, overflow: "hidden", background: "#f8fafc" }}>
                    {viewSafeRender.safe ? (
                      <div dangerouslySetInnerHTML={{ __html: viewSafeRender.html }} style={{ width: "100%", display: "block" }} />
                    ) : (
                      <div style={{ padding: 24, color: "#b91c1c" }}>SVG 视图安全校验失败：{viewSafeRender.reason}</div>
                    )}
                    <svg
                      viewBox={`0 0 ${Number(currentViewObj.width ?? 520)} ${Number(currentViewObj.height ?? 360)}`}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: pickStep === "off" ? "pointer" : "crosshair" }}
                      onClick={handleSvgCanvasClick}
                    >
                      {visiblePoints.map((pt) => {
                        const isSel = selectedPoint?.point_id === pt.point_id;
                        const activeColor = previewMode === "pending" ? String(pt.color ?? "#2563eb") : badgeSample.color;
                        return (
                          <g
                            key={String(pt.point_id)}
                            onClick={(ev) => {
                              if (pickStep !== "off") return;
                              ev.stopPropagation();
                              setSelectedPointId(String(pt.point_id));
                            }}
                          >
                            <line
                              x1={Number(pt.start_x)}
                              y1={Number(pt.start_y)}
                              x2={Number(pt.end_x)}
                              y2={Number(pt.end_y)}
                              stroke={activeColor}
                              strokeWidth={isSel ? 3.5 : 2.2}
                              strokeDasharray={pt.guide_line_style === "dashed" ? "6,3" : undefined}
                            />
                            <circle cx={Number(pt.label_x)} cy={Number(pt.label_y)} r={isSel ? 13 : 11} fill={activeColor} stroke="#fff" strokeWidth="2" />
                            <text
                              x={Number(pt.label_x)}
                              y={Number(pt.label_y) + 4}
                              textAnchor="middle"
                              fontSize="11"
                              fontWeight="bold"
                              fill="#fff"
                            >
                              {String(pt.marker_code)}
                            </text>
                            <rect
                              x={Number(pt.label_x) + 14}
                              y={Number(pt.label_y) - 10}
                              width="96"
                              height="20"
                              rx="4"
                              fill="#0f172a"
                              fillOpacity="0.82"
                            />
                            <text x={Number(pt.label_x) + 18} y={Number(pt.label_y) + 4} fontSize="10" fill="#fff">
                              {badgeSample.icon} {badgeSample.sample} {String(pt.unit)}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                </>
              )}

              {canEdit && (
                <div className="card-soft" style={{ marginTop: 12 }}>
                  <strong className="small">上传或更新当前/指定视图安全 SVG 矢量底图（自动清洗拦截脚本与实体绕过）</strong>
                  <div className="inline-form" style={{ marginTop: 8 }}>
                    <select value={svgUploadViewKey} onChange={(e) => setSvgUploadViewKey(e.target.value)}>
                      <option value="front">正面 (front)</option>
                      <option value="back">背面 (back)</option>
                      <option value="side">侧面 (side)</option>
                      <option value="inside">内里 (inside)</option>
                      <option value="detail">局部细节 (detail)</option>
                    </select>
                    <input
                      type="file"
                      accept=".svg,image/svg+xml"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        setSvgUploadText(await file.text());
                      }}
                    />
                  </div>
                  <textarea
                    rows={3}
                    style={{ width: "100%", marginTop: 6 }}
                    value={svgUploadText}
                    onChange={(e) => setSvgUploadText(e.target.value)}
                    placeholder='在此选择 .svg 文件或粘贴纯矢量 <svg viewBox="0 0 520 360">...</svg>（严格禁用 script/on*/style=/外部链接）'
                  />
                  <div className="actions" style={{ marginTop: 6 }}>
                    <Action
                      sm
                      run={async () => {
                        setEditorError("");
                        const res = sanitizeSvgPure(svgUploadText);
                        if (!res.ok) {
                          setEditorError(res.message);
                          return;
                        }
                        const san = res.value;
                        const { pts, vws, ov } = cloneEffectiveBuffers();
                        const nextView = {
                          view_key: svgUploadViewKey,
                          label_zh: `${svgUploadViewKey} 视图`,
                          label_en: `${svgUploadViewKey} view`,
                          svg: san.svg,
                          viewBox: san.viewBox,
                          width: san.width,
                          height: san.height,
                        };
                        const existingIdx = vws.findIndex((v) => v.view_key === svgUploadViewKey);
                        const nextViews = existingIdx >= 0 ? vws.map((v, i) => (i === existingIdx ? nextView : v)) : [...vws, nextView];
                        await persistEditorBuffers({ views: nextViews, points: pts, overrides: ov, viewsTouched: true });
                        setSvgUploadText("");
                        setActiveView(svgUploadViewKey);
                      }}
                    >
                      校验安全并保存 SVG 视图
                    </Action>
                  </div>
                </div>
              )}
            </div>

            <div className="card-soft">
              <div className="row between flexwrap" style={{ marginBottom: 8, gap: 6 }}>
                <strong>测量点位清单（{activePoints.length} 点 · 点击定位图形）</strong>
                {canEdit && (
                  <button type="button" className="button sm primary" onClick={() => setShowAddPoint(!showAddPoint)}>
                    {showAddPoint ? "收起新增点位" : "+ 新增 POM 点位"}
                  </button>
                )}
              </div>

              {showAddPoint && canEdit && (
                <div className="card-soft" style={{ marginBottom: 12 }}>
                  <Form
                    label="新增几何测量点位（严禁填写重量/GSM）"
                    run={async (f) => {
                      const { pts, ov } = cloneEffectiveBuffers();
                      const newPoint: Row = {
                        point_id: text(f, "point_id").toLowerCase(),
                        marker_code: text(f, "marker_code").toUpperCase(),
                        view_key: text(f, "view_key") || currentViewObj?.view_key || "front",
                        name_zh: text(f, "name_zh"),
                        name_en: text(f, "name_en"),
                        location_zh: text(f, "location_zh") || "待补充定位说明",
                        location_en: text(f, "location_en") || "Position description",
                        method_zh: text(f, "method_zh") || "平铺拉直测量",
                        method_en: text(f, "method_en") || "Measure flat without tension.",
                        start_x: 180,
                        start_y: 120,
                        end_x: 340,
                        end_y: 120,
                        label_x: 260,
                        label_y: 120,
                        guide_line_style: text(f, "guide_line_style") || "dashed",
                        color: "#2563eb",
                        unit: text(f, "unit") === "inch" ? "inch" : "cm",
                        value_type: "numeric",
                        precision_decimals: 1,
                        default_tolerance_plus: Number(text(f, "tol") || 1.0),
                        default_tolerance_minus: Number(text(f, "tol") || 1.0),
                        is_required: true,
                        requires_target: false,
                        requires_tolerance: true,
                        requires_photo: true,
                        allow_na: true,
                        retest_threshold: 0.5,
                        report_visible: true,
                        camera_preset_code: text(f, "camera_preset_code") || "macro_ruler_pom",
                        check_item_code: text(f, "check_item_code") || "CHK_M02_UPPER_BODY_POM",
                        sort_order: activePoints.length + 1,
                      };
                      const nextPts = [...pts, newPoint];
                      setDraftPoints(nextPts);
                      if (isInheritedChild) {
                        ov.added_points = [...(ov.added_points ?? []), newPoint];
                        setDraftOverrides(ov);
                      }
                      setSelectedPointId(String(newPoint.point_id));
                      setShowAddPoint(false);
                    }}
                  >
                    <div className="inline-form">
                      <Field name="point_id" label="稳定 point_id" value={`pom_custom_${activePoints.length + 1}`} />
                      <Field name="marker_code" label="标号" value={String.fromCharCode(65 + (activePoints.length % 26))} />
                      <Select
                        name="view_key"
                        label="视图"
                        choices={activeViews.map((v) => ({ id: String(v.view_key), label: `${String(v.label_zh)} (${String(v.view_key)})` }))}
                      />
                      <Field name="name_zh" label="中文名称（如：肩斜高度）" value="" />
                      <Field name="name_en" label="English Name (e.g. Shoulder Slope)" value="" />
                      <Field name="tol" label="默认正负公差" value="1.0" />
                      <Select name="unit" label="单位" choices={[{ id: "cm", label: "cm" }, { id: "inch", label: "inch" }]} />
                      <Select
                        name="guide_line_style"
                        label="引导线"
                        choices={[{ id: "dashed", label: "虚线" }, { id: "solid", label: "实线" }, { id: "arrow", label: "箭头" }]}
                      />
                      <Select
                        name="camera_preset_code"
                        label="绑定机位"
                        choices={cameraPresets.map((c) => ({ id: String(c.code), label: String(c.name_zh) }))}
                      />
                      <Field name="check_item_code" label="关联检验项" value="CHK_M02_UPPER_BODY_POM" />
                      <Field name="location_zh" label="部位说明（中）" value="平铺对应接缝处" />
                      <Field name="location_en" label="Location (EN)" value="Flat seam landmark" />
                      <Field name="method_zh" label="量测方法（中）" value="自然平铺不拉伸" />
                      <Field name="method_en" label="Method (EN)" value="Measure flat without stretch" />
                    </div>
                  </Form>
                </div>
              )}

              <Table
                headers={["标号", "中/英文点位名称", "视图 / 机位 / 检验项", "公差", "状态预览"]}
                rows={activePoints.map((pt) => {
                  const isSel = selectedPoint?.point_id === pt.point_id;
                  return [
                    <button
                      key="m"
                      type="button"
                      className={`button sm${isSel ? " primary" : ""}`}
                      onClick={() => {
                        setActiveView(String(pt.view_key));
                        setSelectedPointId(String(pt.point_id));
                      }}
                    >
                      {String(pt.marker_code)}
                    </button>,
                    <div key="n" className="cell-stack small">
                      <strong>{String(pt.name_zh)}</strong>
                      <span className="muted">{String(pt.name_en)}</span>
                    </div>,
                    <div key="v" className="cell-stack small">
                      <span className="code">{String(pt.view_key)} · {String(pt.check_item_code ?? "—")}</span>
                      <span className="muted">{String(pt.camera_preset_code)}</span>
                    </div>,
                    <span key="t" className="small">+{String(pt.default_tolerance_plus)} / -{String(pt.default_tolerance_minus)} {String(pt.unit)}</span>,
                    <span key="p" className="small">{badgeSample.icon} {badgeSample.label}</span>,
                  ];
                })}
                empty="暂无测量点位"
              />

              {selectedPoint && canEdit && (
                <div className="card-soft" style={{ marginTop: 12 }}>
                  <div className="row between" style={{ marginBottom: 8 }}>
                    <strong>当前选中点位属性编辑器：{String(selectedPoint.marker_code)} ({String(selectedPoint.point_id)})</strong>
                    <button
                      type="button"
                      className="button sm"
                      onClick={() => {
                        const { pts, ov } = cloneEffectiveBuffers();
                        const nextPts = pts.filter((p) => p.point_id !== selectedPoint.point_id);
                        setDraftPoints(nextPts);
                        if (isInheritedChild) {
                          const wasAdded = (ov.added_points as Row[]).some((a) => a.point_id === selectedPoint.point_id);
                          if (wasAdded) {
                            ov.added_points = (ov.added_points as Row[]).filter((a) => a.point_id !== selectedPoint.point_id);
                          } else {
                            ov.disabled_point_ids = [...new Set([...(ov.disabled_point_ids ?? []), String(selectedPoint.point_id)])];
                          }
                          setDraftOverrides(ov);
                        }
                        setSelectedPointId(nextPts[0]?.point_id ? String(nextPts[0].point_id) : null);
                      }}
                    >
                      {isInheritedChild ? "在子模板中禁用该点位" : "删除该点位"}
                    </button>
                  </div>
                  <div className="inline-form">
                    <label>
                      <span>标号</span>
                      <input
                        value={String(selectedPoint.marker_code)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, marker_code: e.target.value.toUpperCase() })}
                      />
                    </label>
                    <label>
                      <span>中文名称</span>
                      <input
                        value={String(selectedPoint.name_zh)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, name_zh: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>English Name</span>
                      <input
                        value={String(selectedPoint.name_en)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, name_en: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>所在视图</span>
                      <select
                        value={String(selectedPoint.view_key)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, view_key: e.target.value })}
                      >
                        {activeViews.map((v) => (
                          <option key={String(v.view_key)} value={String(v.view_key)}>
                            {String(v.label_zh)} ({String(v.view_key)})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>单位</span>
                      <select
                        value={String(selectedPoint.unit ?? "cm")}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, unit: e.target.value === "inch" ? "inch" : "cm" })}
                      >
                        <option value="cm">cm</option>
                        <option value="inch">inch</option>
                      </select>
                    </label>
                    <label>
                      <span>正公差 (+)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={Number(selectedPoint.default_tolerance_plus ?? 1)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, default_tolerance_plus: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      <span>负公差 (-)</span>
                      <input
                        type="number"
                        step="0.1"
                        value={Number(selectedPoint.default_tolerance_minus ?? 1)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, default_tolerance_minus: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      <span>复测触发阈值</span>
                      <input
                        type="number"
                        step="0.1"
                        value={Number(selectedPoint.retest_threshold ?? 0.5)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, retest_threshold: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      <span>引导线样式</span>
                      <select
                        value={String(selectedPoint.guide_line_style ?? "dashed")}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, guide_line_style: e.target.value })}
                      >
                        <option value="dashed">虚线 (dashed)</option>
                        <option value="solid">实线 (solid)</option>
                        <option value="arrow">箭头 (arrow)</option>
                      </select>
                    </label>
                    <label>
                      <span>推荐摄影机位</span>
                      <select
                        value={String(selectedPoint.camera_preset_code ?? "macro_ruler_pom")}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, camera_preset_code: e.target.value })}
                      >
                        {cameraPresets.map((c) => (
                          <option key={String(c.code)} value={String(c.code)}>
                            {String(c.name_zh)} ({String(c.code)})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>关联检验项目编码</span>
                      <input
                        value={String(selectedPoint.check_item_code ?? "")}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, check_item_code: e.target.value || null })}
                      />
                    </label>
                    <label>
                      <span>起点 X / Y · 终点 X / Y</span>
                      <span className="code">
                        ({String(selectedPoint.start_x)},{String(selectedPoint.start_y)}) → ({String(selectedPoint.end_x)},{String(selectedPoint.end_y)}) · L({String(selectedPoint.label_x)},{String(selectedPoint.label_y)})
                      </span>
                    </label>
                  </div>
                  <div className="inline-form" style={{ marginTop: 8 }}>
                    <label className="row" style={{ gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedPoint.is_required)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, is_required: e.target.checked })}
                      />
                      <span>必测项</span>
                    </label>
                    <label className="row" style={{ gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedPoint.requires_photo)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, requires_photo: e.target.checked })}
                      />
                      <span>要求带尺拍照</span>
                    </label>
                    <label className="row" style={{ gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedPoint.requires_tolerance)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, requires_tolerance: e.target.checked })}
                      />
                      <span>校验公差</span>
                    </label>
                    <label className="row" style={{ gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedPoint.allow_na)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, allow_na: e.target.checked })}
                      />
                      <span>允许不适用(N/A)</span>
                    </label>
                    <label className="row" style={{ gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedPoint.report_visible)}
                        onChange={(e) => updatePointBuffer({ ...selectedPoint, report_visible: e.target.checked })}
                      />
                      <span>客户报告展示</span>
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>

          {selectedPoint && (
            <div style={{ marginTop: 14 }}>
              <BilingualEntityPanel
                key={`${String(rawTpl.id)}:${String(selectedPoint.point_id)}`}
                entityType="measurement_template_point"
                entityId={String(rawTpl.id)}
                entityLabel={`点位 ${String(selectedPoint.marker_code)} · ${String(selectedPoint.name_zh)}（仅翻译双语文字，不修改 SVG 坐标几何）`}
                actor={actor}
                fields={[
                  {
                    field_key: `${String(selectedPoint.point_id)}.name`,
                    label: "点位名称 (POM Name)",
                    source_text: String(selectedPoint.name_zh),
                    source_revision: Number(rawTpl.current_draft_version ?? 1),
                  },
                  {
                    field_key: `${String(selectedPoint.point_id)}.location`,
                    label: "测量位置描述 (Location)",
                    source_text: String(selectedPoint.location_zh),
                    source_revision: Number(rawTpl.current_draft_version ?? 1),
                  },
                  {
                    field_key: `${String(selectedPoint.point_id)}.method`,
                    label: "标准量测方法 (Method)",
                    source_text: String(selectedPoint.method_zh),
                    source_revision: Number(rawTpl.current_draft_version ?? 1),
                  },
                ]}
              />
            </div>
          )}

          <div className="card-soft" style={{ marginTop: 14 }}>
            <strong>不可变发布版本历史（在检旧任务锁定原版本不漂移）</strong>
            <Table
              headers={["版本", "状态", "内容哈希", "发布时间", "操作"]}
              rows={versions.map((v) => [
                <span key="v" className="code">v{String(v.version)}</span>,
                <Tag key="s" tone={v.state === "PUBLISHED" ? "green" : "gray"}>{String(v.state)}</Tag>,
                <code key="h" className="code">{String(v.content_hash).slice(0, 14)}…</code>,
                <span key="t" className="small muted">{String(v.published_at)}</span>,
                canEdit ? (
                  <Action
                    key="rb"
                    sm
                    run={async () => {
                      await request(`/staff/admin/measurement-templates/${rawTpl.id}/rollback`, "POST", {
                        target_version: Number(v.version),
                        note: `Rollback to v${String(v.version)} via PAGE-M23`,
                      });
                      setBanner(`已从 v${String(v.version)} 回滚生成新草稿，等待独立复核发布`);
                      reloadAll();
                    }}
                  >
                    回滚至 v{String(v.version)} 为草稿
                  </Action>
                ) : null,
              ])}
              empty="尚未发布冻结版本"
            />
          </div>
        </Panel>
      )}

      <Panel
        title="仓库标准化摄影机位预设库"
        subtitle="与实测点位强绑定的拍摄角度、带尺要求、分辨率及站内拍摄说明。"
        badge={
          canEdit ? (
            <button type="button" className="button sm" onClick={() => setShowPresetForm(!showPresetForm)}>
              {showPresetForm ? "收起预设表单" : "+ 新增/更新摄影机位预设"}
            </button>
          ) : null
        }
      >
        {showPresetForm && canEdit && (
          <div className="card-soft" style={{ marginBottom: 14 }}>
            <Form
              label="保存摄影机位预设"
              run={async (f) => {
                await request("/staff/admin/measurement-templates/presets", "POST", {
                  code: text(f, "code").toLowerCase(),
                  name_zh: text(f, "name_zh"),
                  name_en: text(f, "name_en"),
                  view_key: text(f, "view_key") || "detail",
                  framing_notes_zh: text(f, "framing_notes_zh"),
                  framing_notes_en: text(f, "framing_notes_en"),
                  requires_scale_ruler: text(f, "requires_scale_ruler") === "yes",
                  recommended_resolution: text(f, "recommended_resolution") || "2560x1920",
                  sort_order: Number(text(f, "sort_order") || 10),
                  active: true,
                });
                setShowPresetForm(false);
                setBanner("摄影机位预设已保存");
                reloadAll();
              }}
            >
              <div className="inline-form">
                <Field name="code" label="机位编码" value="macro_collar_ruler" />
                <Field name="name_zh" label="中文名称" value="领口标尺微距机位" />
                <Field name="name_en" label="English Name" value="Collar Ruler Macro Camera" />
                <Select
                  name="view_key"
                  label="关联视图"
                  choices={[
                    { id: "front", label: "front" },
                    { id: "back", label: "back" },
                    { id: "side", label: "side" },
                    { id: "inside", label: "inside" },
                    { id: "detail", label: "detail" },
                  ]}
                />
                <Select name="requires_scale_ruler" label="要求带刻度皮尺" choices={[{ id: "yes", label: "是" }, { id: "no", label: "否" }]} />
                <Field name="recommended_resolution" label="推荐分辨率" value="2560x1920" />
                <Field name="sort_order" label="排序" value="7" />
              </div>
              <div className="inline-form" style={{ marginTop: 8 }}>
                <Field name="framing_notes_zh" label="拍摄取景说明（中）" value="领口平铺对齐游标尺零点。" />
                <Field name="framing_notes_en" label="Framing Notes (EN)" value="Align neckline edge with calibrated ruler zero mark." />
              </div>
            </Form>
          </div>
        )}
        <Table
          headers={["机位编码", "中/英文机位名", "视图", "要求皮尺", "推荐分辨率", "取景说明"]}
          rows={cameraPresets.map((p) => [
            <span key="c" className="code">{String(p.code)}</span>,
            <div key="n" className="cell-stack small">
              <strong>{String(p.name_zh)}</strong>
              <span className="muted">{String(p.name_en)}</span>
            </div>,
            <span key="v" className="code">{String(p.view_key)}</span>,
            <Tag key="r" tone={p.requires_scale_ruler ? "green" : "gray"}>{p.requires_scale_ruler ? "必含刻度尺" : "常规构图"}</Tag>,
            <span key="res" className="small">{String(p.recommended_resolution)}</span>,
            <span key="note" className="small muted">{String(p.framing_notes_zh)}</span>,
          ])}
          empty="暂无机位预设"
        />
      </Panel>
    </div>
  );
}
