"use client";

import Link from "next/link";
import { useState } from "react";
import { Action, ErrorBlock, Form, Panel, request, stamp, Table, Tag, text, useLoad, type Row } from "./ui";
import { BilingualEntityPanel } from "./bilingual-editor";
import { AI_PURPOSE_CODES } from "../packages/core/ai-contract";
import type { Actor } from "../packages/core/common";

const BATCH_STATUS_TONE: Record<string, "green" | "blue" | "yellow" | "red" | "gray"> = {
  completed: "green",
  running: "blue",
  queued: "blue",
  paused: "yellow",
  partial_failed: "yellow",
  failed: "red",
  cancelled: "gray",
};

export function AdminTranslationsDesk({ actor }: { actor: Actor }) {
  const overview = useLoad("/staff/admin/i18n/overview");
  const translationsLoad = useLoad("/staff/admin/i18n/translations");
  const batchesLoad = useLoad("/staff/admin/translations/batches");

  const [tab, setTab] = useState<"completeness" | "review" | "batches" | "editor">("completeness");
  const [selectedTransId, setSelectedTransId] = useState<string>("");
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");
  const [previewParams, setPreviewParams] = useState<{
    purpose_code: string;
    source_locale: string;
    target_locale: string;
    entity_types: string[];
  } | null>(null);
  const [previewInfo, setPreviewInfo] = useState<Record<string, any> | null>(null);
  const [diffInfo, setDiffInfo] = useState<Record<string, any> | null>(null);
  const [batchDetail, setBatchDetail] = useState<Record<string, any> | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const ov = overview.data as Record<string, any> | undefined;
  const locales = (ov?.locales ?? []) as Row[];
  const breakdown = ((ov?.dynamic_completeness?.breakdown ?? []) as Row[]);
  const totals = ov?.dynamic_completeness as Record<string, number> | undefined;
  const translations = ((translationsLoad.data as { translations?: Row[] } | undefined)?.translations ?? []) as Row[];
  const batches = ((batchesLoad.data as { batches?: Row[] } | undefined)?.batches ?? []) as Row[];
  const isSuperAdmin = actor.kind === "staff" && actor.roles.includes("super_admin");
  const canReview = actor.kind === "staff" && (actor.roles.includes("reviewer") || isSuperAdmin);
  const canBatch = actor.kind === "staff" && (isSuperAdmin || actor.roles.includes("template_admin"));

  function reloadAll() {
    overview.reload();
    translationsLoad.reload();
    batchesLoad.reload();
  }

  return (
    <div className="stack">
      <Panel
        title="PAGE-M43 · 全站动态翻译组件、审校队列与批量任务中心"
        subtitle="自动去抖 · 单字段 / 整表 / 批量翻译 · 源变更待更新 & 候选差异 · 人工防覆盖 · 成本预估与暂停取消重试"
      >
        <div className="row flexwrap" style={{ gap: 8, alignItems: "center" }}>
          {([
            ["completeness", "完整度与语种注册"],
            ["review", `动态译文与审校队列 (${translations.length})`],
            ["batches", `批量任务中心 (${batches.length})`],
            ["editor", "独立双语组件工作台"],
          ] as const).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              className={`button sm${tab === k ? " primary" : ""}`}
              onClick={() => setTab(k)}
            >
              {lbl}
            </button>
          ))}
          <Link className="button sm" href="/admin/integrations/ai">
            AI 供应商与 9 用途配置 →
          </Link>
        </div>
        {banner && <div className="line-note" style={{ marginTop: 10 }}>{banner}</div>}
      </Panel>

      {overview.error && <ErrorBlock error={overview.error} />}
      {translationsLoad.error && <ErrorBlock error={translationsLoad.error} />}
      {batchesLoad.error && <ErrorBlock error={batchesLoad.error} />}
      {err ? <ErrorBlock error={err instanceof Error ? err.message : String(err)} /> : null}

      {tab === "completeness" && (
        <div className="stack">
          <Panel title="已注册语言架构与隔离控制（未来语种架构存在但不提前发布）">
            <Table
              headers={["BCP47", "名称", "公开路径", "核心语种", "启用", "可选切换", "管理"]}
              empty="暂无语种"
              rows={locales.map((l) => [
                <code key="c">{String(l.code)}</code>,
                `${String(l.native_label)} / ${String(l.english_label)}`,
                <code>{String(l.public_path_prefix || "/")}</code>,
                l.is_core ? <Tag key="core" tone="blue">核心</Tag> : "扩展预留",
                <Tag key="en" tone={l.enabled ? "green" : "gray"}>{l.enabled ? "已启用" : "隔离禁用"}</Tag>,
                <Tag key="sel" tone={l.selectable ? "green" : "gray"}>{l.selectable ? "可选" : "隐藏"}</Tag>,
                isSuperAdmin && !l.is_core ? (
                  <Action
                    key="tog"
                    sm
                    run={async () => {
                      await request(`/staff/admin/i18n/locales/${encodeURIComponent(String(l.code))}/status`, "POST", {
                        enabled: !l.enabled,
                      });
                      setBanner(`已更新语种 ${l.code} 启用状态`);
                      reloadAll();
                    }}
                  >
                    {l.enabled ? "禁用隔离" : "校验后启用"}
                  </Action>
                ) : null,
              ])}
            />
          </Panel>

          <Panel title="动态字段双语真实完整度统计（未翻译/待更新计入分母，不虚报 100%）">
            {totals && (
              <div className="row flexwrap" style={{ gap: 16, marginBottom: 12 }}>
                <div><strong>动态记录总字段数：</strong>{totals.total_latest}</div>
                <div><strong>已发布：</strong>{totals.published_count}</div>
                <div><strong>已审待发：</strong>{totals.approved_count}</div>
                <div><strong>待翻译 / 草稿 / 待审：</strong>{totals.pending_or_draft_count}</div>
                <div><strong>源变更待更新 / 失败：</strong>{totals.stale_or_failed_count}</div>
              </div>
            )}
            <Table
              headers={["业务对象类型", "目标语言", "状态", "最新字段数"]}
              empty="暂无动态翻译明细记录"
              rows={breakdown.map((b) => [
                <code key="et">{String(b.entity_type)}</code>,
                <code key="loc">{String(b.locale)}</code>,
                String(b.status),
                String(b.count),
              ])}
            />
          </Panel>
        </div>
      )}

      {tab === "review" && (
        <div className="stack">
          <Panel title="动态译文队列与候选差异对照（SoD 审批 / 人工锁定防覆盖）">
            <Table
              headers={["对象 / 字段", "语言", "版本", "当前状态", "候选状态", "译文摘要", "操作"]}
              empty="暂无动态译文记录"
              rows={translations.map((r) => [
                <span key="ef"><code>{String(r.entity_type)}</code> · {String(r.field_key)}</span>,
                <code key="l">{String(r.locale)}</code>,
                `r${r.revision}`,
                <Tag key="st" tone={r.status === "published" ? "green" : r.status === "stale" || r.status === "failed" ? "red" : "yellow"}>{String(r.status)}</Tag>,
                r.candidate_status ? <Tag key="cs" tone={r.candidate_status === "stale_candidate" ? "red" : "blue"}>{String(r.candidate_status)}</Tag> : "—",
                String(r.translated_text ?? "(待翻译)").slice(0, 48),
                <div key="op" className="row flexwrap" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="button sm"
                    onClick={async () => {
                      setSelectedTransId(String(r.id));
                      setErr(null);
                      try {
                        const d = (await request(`/staff/admin/translations/${r.id}/diff`)) as Record<string, any>;
                        setDiffInfo(d);
                      } catch (e) {
                        setErr(e);
                      }
                    }}
                  >
                    差异对照
                  </button>
                  {canReview && !["stale", "failed", "untranslated", "queued", "published"].includes(String(r.status)) && (
                    <Action sm run={async () => { await request(`/staff/admin/i18n/translations/${r.id}/decide`, "POST", { decision: "publish" }); setBanner("已审核并发布译文"); reloadAll(); }}>审核发布</Action>
                  )}
                </div>,
              ])}
            />
          </Panel>

          {diffInfo && (
            <Panel title={`译文差异与版本历史对照 (${selectedTransId.slice(0, 8)}…)`}>
              <div className="stack" style={{ gap: 6 }}>
                <div><strong>源文：</strong>{String(diffInfo.source_text ?? "（无记录）")}</div>
                <div><strong>当前生效/草稿译文：</strong>{String(diffInfo.current_text ?? "（空）")}</div>
                <div><strong>AI 候选译文：</strong>{String(diffInfo.candidate_text ?? "（无待应用候选）")}</div>
                <div><strong>候选状态：</strong><code>{String(diffInfo.candidate_status ?? "none")}</code> {diffInfo.source_changed_since_candidate ? "（警告：源文已变化，禁止自动应用）" : ""}</div>
                {diffInfo.candidate_text && (diffInfo.candidate_status === "pending_apply" || diffInfo.candidate_status === "stale_candidate") && (
                  <div className="row flexwrap" style={{ gap: 8, marginTop: 6 }}>
                    {diffInfo.candidate_status === "pending_apply" && (
                      <Action
                        sm
                        primary
                        run={async () => {
                          await request(`/staff/admin/translations/${selectedTransId}/apply-candidate`, "POST", {
                            expected_revision: Number(diffInfo.translation?.revision ?? 1),
                            confirm_overwrite_human_lock: Boolean(diffInfo.translation?.human_locked),
                          });
                          setBanner("已应用候选译文生成新修订版");
                          setDiffInfo(null);
                          reloadAll();
                        }}
                      >
                        应用候选（生成新修订版）
                      </Action>
                    )}
                    <Action
                      sm
                      run={async () => {
                        await request(`/staff/admin/translations/${selectedTransId}/reject-candidate`, "POST", {});
                        setBanner("已拒绝该候选译文");
                        setDiffInfo(null);
                        reloadAll();
                      }}
                    >
                      拒绝候选
                    </Action>
                  </div>
                )}
              </div>
            </Panel>
          )}
        </div>
      )}

      {tab === "batches" && (
        <div className="stack">
          <Panel title="受控批量翻译运行与队列监控">
            <Table
              headers={["用途", "语言对", "计划/跳过受保护", "费用预估", "状态", "进度(完成/失败/剩余)", "操作"]}
              empty="暂无批量翻译运行记录"
              rows={batches.map((b) => [
                <code key="p">{String(b.purpose_code)}</code>,
                `${String(b.source_locale)} → ${String(b.target_locale)}`,
                `${b.total_items} / 保护跳过 ${b.skipped_protected_items}`,
                b.estimated_cost_cents === null ? "未知(待核费率)" : `${b.estimated_cost_cents} cents (${String(b.estimate_currency)})`,
                <Tag key="s" tone={BATCH_STATUS_TONE[String(b.status)] ?? "gray"}>{String(b.status)}</Tag>,
                `${b.done_count ?? 0} / ${b.failed_count ?? 0} / ${b.remaining_count ?? 0}`,
                <div key="op" className="row flexwrap" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="button sm"
                    onClick={async () => {
                      setSelectedBatchId(String(b.id));
                      setErr(null);
                      try {
                        const res = (await request(`/staff/admin/translations/batches/${b.id}`)) as Record<string, any>;
                        setBatchDetail(res);
                      } catch (e) {
                        setErr(e);
                      }
                    }}
                  >
                    明细
                  </button>
                  {canBatch && (b.status === "queued" || b.status === "running") && (
                    <Action sm run={async () => { await request(`/staff/admin/translations/batches/${b.id}/pause`, "POST", {}); setBanner("批量任务已暂停"); reloadAll(); }}>暂停</Action>
                  )}
                  {canBatch && b.status === "paused" && (
                    <Action sm run={async () => { await request(`/staff/admin/translations/batches/${b.id}/resume`, "POST", {}); setBanner("已恢复执行"); reloadAll(); }}>恢复</Action>
                  )}
                  {canBatch && !["completed", "cancelled"].includes(String(b.status)) && (
                    <Action sm run={async () => { await request(`/staff/admin/translations/batches/${b.id}/cancel`, "POST", {}); setBanner("已取消未发送项"); reloadAll(); }}>取消</Action>
                  )}
                  {canBatch && Number(b.failed_count ?? 0) > 0 && b.status !== "cancelled" && (
                    <Action sm run={async () => { await request(`/staff/admin/translations/batches/${b.id}/retry-failed`, "POST", {}); setBanner("已重试失败子项"); reloadAll(); }}>仅重试失败</Action>
                  )}
                  {isSuperAdmin && (
                    <a className="button sm" href={`/api/v1/staff/admin/translations/batches/${b.id}/export`}>导出脱敏CSV</a>
                  )}
                </div>,
              ])}
            />
          </Panel>

          {batchDetail && (
            <Panel title={`批量任务分项明细 (${selectedBatchId.slice(0, 8)}…)`}>
              <Table
                headers={["对象", "字段", "状态", "错误码", "源文本摘要"]}
                empty="无分项"
                rows={((batchDetail.items ?? []) as Row[]).map((it) => [
                  <code>{String(it.entity_type)}:{String(it.entity_id).slice(0, 8)}</code>,
                  <code>{String(it.field_key)}</code>,
                  String(it.status),
                  String(it.error_code ?? "—"),
                  String(it.source_text ?? "").slice(0, 50),
                ])}
              />
            </Panel>
          )}

          {canBatch && (
            <Panel title="预估用量成本并创建批量翻译任务">
              <Form
                label="预估批量范围与成本（不实际扣费）"
                run={async (fd) => {
                  const types = text(fd, "entity_types").split(",").map((s) => s.trim()).filter(Boolean);
                  const params = {
                    purpose_code: text(fd, "purpose_code"),
                    source_locale: text(fd, "source_locale"),
                    target_locale: text(fd, "target_locale"),
                    entity_types: types,
                  };
                  const res = (await request("/staff/admin/translations/batches/preview", "POST", {
                    ...params,
                    only_missing_or_stale: true,
                    protect_human_locked: true,
                  })) as Record<string, any>;
                  setPreviewParams(params);
                  setPreviewInfo(res);
                }}
              >
                <label>用途路由
                  <select name="purpose_code" defaultValue="KNOWLEDGE_TRANSLATION_DRAFT">
                    {AI_PURPOSE_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label>源语言
                  <select name="source_locale" defaultValue="zh-CN">
                    <option value="zh-CN">zh-CN</option>
                    <option value="en-US">en-US</option>
                  </select>
                </label>
                <label>目标语言
                  <select name="target_locale" defaultValue="en-US">
                    <option value="en-US">en-US</option>
                    <option value="zh-CN">zh-CN</option>
                  </select>
                </label>
                <label>筛选对象类型 (逗号分隔，留空扫描全部缺失/待更新项) <input name="entity_types" placeholder="category, inspection_template" /></label>
              </Form>

              {previewInfo && previewParams && (
                <div className="line-note" style={{ marginTop: 10 }}>
                  <div>
                    待处理：{previewInfo.total_to_process} 项 · 保护跳过：{previewInfo.skipped_protected_items} 项 ·
                    术语直击(0费)：{previewInfo.glossary_hits} 项 ·
                    预估上限费用：{previewInfo.estimated_cost_cents === null ? "未知(待配置费率)" : `${previewInfo.estimated_cost_cents} cents (${previewInfo.estimate_currency})`}
                  </div>
                  <div className="muted" style={{ marginBottom: 8 }}>{String(previewInfo.estimate_disclaimer)}</div>
                  {Number(previewInfo.total_to_process ?? 0) > 0 && (
                    <Action
                      sm
                      primary
                      run={async () => {
                        await request("/staff/admin/translations/batches", "POST", {
                          idempotency_key: `ui-batch-${Date.now()}`,
                          ...previewParams,
                          only_missing_or_stale: true,
                          protect_human_locked: true,
                        });
                        setBanner("已按确认的费用预估创建并入队批量翻译任务（默认保护人工已审内容）。");
                        setPreviewInfo(null);
                        setPreviewParams(null);
                        reloadAll();
                      }}
                    >
                      确认范围与预估并启动批量翻译任务
                    </Action>
                  )}
                </div>
              )}
            </Panel>
          )}
        </div>
      )}

      {tab === "editor" && (
        <BilingualEntityPanel
          entityType="knowledge_preview"
          entityId="00000000-0000-4000-8000-000000000193"
          entityLabel="共享多语言组件示例上下文"
          actor={actor}
          fields={[
            { field_key: "name", label: "名称", source_text: "平铺半胸宽检测项", source_revision: 1 },
            { field_key: "description", label: "说明", source_text: "腋下 2.5 cm 处平铺测量，公差 -0.5 cm。", source_revision: 1 },
          ]}
        />
      )}
    </div>
  );
}
