"use client";

import { useState } from "react";
import { Action, ErrorBlock, Field, Form, Panel, request, Select, Table, Tag, text, useLoad } from "./ui";
import type { Actor } from "../packages/core/common";

type Row = Record<string, any>;

function fmtMoney(cents: number, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

export function AdminCostMarginPanel({ actor }: { actor: Actor }) {
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<Record<string, any> | null>(null);
  const [simOut, setSimOut] = useState<Row | null>(null);
  const [matrixOut, setMatrixOut] = useState<Row | null>(null);
  const [matrixQtyFilter, setMatrixQtyFilter] = useState<string>("all");
  const [banner, setBanner] = useState("");
  const [actionError, setActionError] = useState("");

  const overviewLoad = useLoad("/staff/admin/cost-models/overview");
  const modelsLoad = useLoad("/staff/admin/cost-models");
  const detailLoad = useLoad(selectedModelId ? `/staff/admin/cost-models/${selectedModelId}` : null);
  const statsLoad = useLoad("/staff/labor/stats?days=30");
  const baselinesLoad = useLoad("/staff/admin/cost-models/baselines");

  const canEdit = actor.roles.some((r) => r === "super_admin" || r === "finance");
  const canReview = actor.roles.some((r) => r === "super_admin" || r === "reviewer");

  const overview = overviewLoad.data as Row | undefined;
  const models = ((modelsLoad.data as Row | undefined)?.models as Row[] | undefined) ?? [];
  const detail = detailLoad.data as Row | undefined;
  const model = (detail?.model as Row | undefined) ?? null;
  const versions = (detail?.versions as Row[] | undefined) ?? [];
  const stats = statsLoad.data as Row | undefined;
  const baselines = ((baselinesLoad.data as Row | undefined)?.baselines as Row[] | undefined) ?? [];

  const activeModel = draftModel ?? model;
  const activeCurrency = String(activeModel?.currency ?? "USD");

  function reloadAll() {
    overviewLoad.reload();
    modelsLoad.reload();
    if (selectedModelId) detailLoad.reload();
    statsLoad.reload();
    baselinesLoad.reload();
  }

  return (
    <div className="desk-stack">
      <Panel
        title="真实工时采集、成本模型与贡献毛利沙盘（§10 / §43.3）"
        subtitle="区分有效人工、不可并行等待、后台异步耗时与工作中断；初始暂估与现场实测严格标明，绝不自动修改已发布价格。"
        badge={
          canEdit ? (
            <div className="actions">
              <Action
                sm
                primary
                run={async () => {
                  const res = (await request("/staff/admin/cost-models/seed-init", "POST", {})) as Row;
                  setBanner(
                    `§43.3 成本与工时暂估基线初始化完成（${String(res.seed_version)}）：新增工时基准 ${String(res.inserted_counts?.labor_baselines ?? 0)} 项、成本模型 ${String(res.inserted_counts?.cost_models ?? 0)} 套。`,
                  );
                  reloadAll();
                }}
              >
                幂等初始化 §43.3 成本与工时基线
              </Action>
            </div>
          ) : null
        }
      >
        {overviewLoad.error && <ErrorBlock error={overviewLoad.error} />}
        {modelsLoad.error && <ErrorBlock error={modelsLoad.error} />}
        {statsLoad.error && <ErrorBlock error={statsLoad.error} />}
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
        {overview && (
          <div className="metric-grid">
            <div className="metric-card">
              <span className="muted small">成本模型</span>
              <strong>{overview.models?.total_models ?? 0} 套（已发布 {overview.models?.published_models ?? 0}）</strong>
              <span className="small muted">business_approved=false · 禁止管理费双计</span>
            </div>
            <div className="metric-card">
              <span className="muted small">真实工时事件</span>
              <strong>{overview.labor_events?.total_events ?? 0} 条（进行中 {overview.labor_events?.open_events ?? 0}）</strong>
              <span className="small muted">待校正离线超时：{overview.labor_events?.pending_calibration_events ?? 0}</span>
            </div>
            <div className="metric-card">
              <span className="muted small">统计样本置信度（近30天）</span>
              <strong>{String(stats?.statistical_confidence ?? "insufficient_samples")}</strong>
              <span className="small muted">有效人工样本 {stats?.total_active_labor_samples ?? 0} 条</span>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="1. 成本模型列表与三权分立审批" subtitle="支持综合时薪、QA时薪、管理费不重计开关、设备折旧、耗材、媒体存储/带宽/转码、AI、支付手续费与目标贡献利润率配置。">
        <Table
          headers={["编码", "名称", "人工/QA时薪", "支付费率 / 目标毛利", "状态 / 数据来源", "操作"]}
          rows={models.map((m) => {
            const cur = String(m.currency ?? "USD");
            const isAuthor = m.created_by === actor.id || m.submitted_by === actor.id;
            return [
              <span key="c" className="code">{String(m.code)}</span>,
              <strong key="n" className="small">{String(m.name_zh)}</strong>,
              <span key="l" className="small">{fmtMoney(Number(m.labor_hourly_rate_cents), cur)} / {fmtMoney(Number(m.qa_hourly_rate_cents), cur)}</span>,
              <span key="p" className="small">{(Number(m.payment_fee_rate_bps) / 100).toFixed(2)}%+{fmtMoney(Number(m.payment_fixed_fee_cents), cur)} · 目标 {(Number(m.target_contribution_margin_bps) / 100).toFixed(1)}%</span>,
              <div key="s" className="cell-stack">
                <Tag tone={m.status === "published" ? "green" : m.status === "retired" ? "red" : "yellow"}>{String(m.status)}</Tag>
                <small className="muted">{String(m.data_source)} · 终批:{m.business_approved ? "是" : "否"}</small>
              </div>,
              <div key="op" className="row flexwrap" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="button sm primary"
                  onClick={() => {
                    setSelectedModelId(String(m.id));
                    setDraftModel(null);
                    setSimOut(null);
                    setMatrixOut(null);
                  }}
                >
                  配置与毛利沙盘
                </button>
                {canEdit && m.status === "draft" && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/admin/cost-models/${m.id}/submit`, "POST", {});
                      setBanner(`成本模型 ${String(m.code)} 已提交独立审核`);
                      reloadAll();
                    }}
                  >
                    提审
                  </Action>
                )}
                {canReview && (m.status === "draft" || m.status === "in_review") && !isAuthor && (
                  <Action
                    sm
                    primary
                    run={async () => {
                      await request(`/staff/admin/cost-models/${m.id}/publish`, "POST", {});
                      setBanner(`已独立审核并冻结发布成本模型 ${String(m.code)}`);
                      reloadAll();
                    }}
                  >
                    独立发布
                  </Action>
                )}
                {canEdit && m.status === "published" && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/admin/cost-models/${m.id}/retire`, "POST", {});
                      reloadAll();
                    }}
                  >
                    退役
                  </Action>
                )}
              </div>,
            ];
          })}
          empty="尚未初始化成本模型，请点击上方按钮初始化 §43.3 沙盘模型。"
        />

        {activeModel && (
          <div className="card-soft" style={{ marginTop: 14 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <strong>成本参数编辑器：{String(activeModel.name_zh)} ({String(activeModel.code)})</strong>
              {canEdit && draftModel && (
                <div className="actions">
                  <Action
                    sm
                    primary
                    run={async () => {
                      setActionError("");
                      try {
                        await request("/staff/admin/cost-models", "POST", draftModel);
                        setDraftModel(null);
                        setBanner("成本模型草稿已保存（若修改管理费防重计约束会被服务端校验）");
                        reloadAll();
                      } catch (err) {
                        setActionError(err instanceof Error ? err.message : "保存失败");
                      }
                    }}
                  >
                    保存成本模型草稿
                  </Action>
                  <button type="button" className="button sm" onClick={() => setDraftModel(null)}>
                    放弃修改
                  </button>
                </div>
              )}
            </div>
            <div className="inline-form">
              {[
                ["labor_hourly_rate_cents", "综合人工时薪 (cents)"],
                ["qa_hourly_rate_cents", "QA 复核时薪 (cents)"],
                ["warehouse_fixed_monthly_cents", "仓库月固定成本 (cents)"],
                ["expected_monthly_orders", "月预计分摊订单数"],
                ["equipment_depreciation_per_order_cents", "设备折旧/单 (cents)"],
                ["camera_lighting_per_item_cents", "相机照明/件 (cents)"],
                ["barcode_label_per_item_cents", "条码标签/件 (cents)"],
                ["packaging_consumable_per_item_cents", "包装耗材/件 (cents)"],
                ["storage_gb_month_cents", "媒体存储 cents/GB·月"],
                ["bandwidth_gb_cents", "带宽出网 cents/GB"],
                ["video_transcode_per_min_cents", "视频转码 cents/分钟"],
                ["ai_estimated_per_order_cents", "AI 预估成本/单 (cents)"],
                ["domestic_logistics_handling_per_order_cents", "国内段处理/单 (cents)"],
                ["payment_fixed_fee_cents", "支付固定手续费 (cents)"],
                ["payment_fee_rate_bps", "支付比例费率 (bps, 340=3.4%)"],
                ["other_variable_revenue_rate_bps", "其他收入比例费 (bps)"],
                ["rework_reserve_rate_bps", "异常返工准备金 (bps)"],
                ["support_cost_per_order_cents", "客服支持成本/单 (cents)"],
                ["target_contribution_margin_bps", "目标贡献利润率 m (bps, 2500=25%)"],
              ].map(([k, label]) => (
                <label key={k}>
                  <span>{label}</span>
                  <input
                    type="number"
                    disabled={!canEdit}
                    value={Number(activeModel[k] ?? 0)}
                    onChange={(e) => setDraftModel({ ...activeModel, [k]: Number(e.target.value) })}
                  />
                </label>
              ))}
              <label>
                <span>管理费用已计入综合人工时薪（防双计）</span>
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={Boolean(activeModel.management_overhead_included_in_labor)}
                  onChange={(e) =>
                    setDraftModel({
                      ...activeModel,
                      management_overhead_included_in_labor: e.target.checked,
                      management_overhead_pct: e.target.checked ? 0 : Number(activeModel.management_overhead_pct ?? 0),
                    })
                  }
                />
              </label>
              <label>
                <span>独立管理费加计比例 (%)</span>
                <input
                  type="number"
                  disabled={!canEdit || Boolean(activeModel.management_overhead_included_in_labor)}
                  value={Number(activeModel.management_overhead_pct ?? 0)}
                  onChange={(e) => setDraftModel({ ...activeModel, management_overhead_pct: Number(e.target.value) })}
                />
              </label>
            </div>

            {versions.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Table
                  headers={["成本版本", "状态", "哈希", "发布时间", "操作"]}
                  rows={versions.map((v) => [
                    <span key="v" className="code">v{String(v.version)}</span>,
                    <Tag key="s" tone={v.state === "PUBLISHED" ? "green" : "gray"}>{String(v.state)}</Tag>,
                    <code key="h" className="code">{String(v.content_hash).slice(0, 12)}…</code>,
                    <span key="t" className="small muted">{String(v.published_at)}</span>,
                    canEdit ? (
                      <Action
                        key="rb"
                        sm
                        run={async () => {
                          await request(`/staff/admin/cost-models/${activeModel.id}/rollback`, "POST", { target_version: Number(v.version) });
                          setBanner(`已从 v${String(v.version)} 回滚生成成本模型草稿`);
                          reloadAll();
                        }}
                      >
                        回滚 v{String(v.version)}
                      </Action>
                    ) : null,
                  ])}
                />
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="2. 单位经济毛利沙盘与 1/3/10/30/50/100 成本矩阵（P = C / (1 - f - m)）"
        subtitle="改价前自动测算预计工时、分项成本、$5单件亏损警告、可行参考售价及不同缺陷/返工率敏感度。"
      >
        <Form
          label="运行单笔/组合利润沙盘模拟"
          run={async (f) => {
            const res = (await request("/staff/admin/cost-models/simulate-margin", "POST", {
              cost_model_id: activeModel?.id,
              service_type: text(f, "service_type") || "inspection",
              product_type_code: text(f, "product_type_code") || "t_shirt",
              base_qty: Number(text(f, "base_qty") || 1),
              modules: text(f, "include_m02") === "yes" ? [{ module_code: "M02", option_code: "points_5" }] : [],
              defect_rate_bps: Number(text(f, "defect_pct") || 8) * 100,
              rework_rate_bps: Number(text(f, "rework_pct") || 4) * 100,
              allow_unpublished_catalog_in_sim: true,
            })) as Row;
            setSimOut(res);
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
            <Field name="product_type_code" label="服装品类" value="t_shirt" />
            <Field name="base_qty" label="委托件数" value="1" />
            <Select name="include_m02" label="附带 5 点测量" choices={[{ id: "no", label: "仅基础外观" }, { id: "yes", label: "含 M02 5点测量" }]} />
            <Field name="defect_pct" label="缺陷率 (%)" value="8" />
            <Field name="rework_pct" label="返工率 (%)" value="4" />
          </div>
        </Form>

        {simOut && (
          <div style={{ marginTop: 12 }}>
            <div className="notice" style={{ borderColor: simOut.is_loss_making || !simOut.feasible ? "#dc2626" : undefined }}>
              <strong>数据口径：{String(simOut.data_source_provenance)}</strong> · 报价收入 {fmtMoney(Number(simOut.quoted_revenue_cents), activeCurrency)} ·
              直接可变成本 {fmtMoney(Number(simOut.direct_variable_cost_cents), activeCurrency)} ·
              贡献利润 <strong>{fmtMoney(Number(simOut.contribution_profit_cents), activeCurrency)}</strong> ·
              经营利润 <strong>{fmtMoney(Number(simOut.operating_profit_cents), activeCurrency)}</strong> ·{" "}
              {simOut.feasible ? (
                <>参考净售价 P=C/(1-f-m)：<strong>{fmtMoney(Number(simOut.recommended_net_price_cents), activeCurrency)}</strong></>
              ) : (
                <Tag tone="red">模型不可行：{String(simOut.infeasibility_reason)}</Tag>
              )}{" "}
              {simOut.is_loss_making && <Tag tone="red">亏损警告（当前定价低于全成本）</Tag>}
            </div>
            <Table
              headers={["缺陷/返工敏感场景", "缺陷%", "返工%", "直接可变成本", "贡献利润", "经营利润", "推荐售价 P", "状态"]}
              rows={(simOut.sensitivity_scenarios ?? []).map((sc: Row) => [
                <span key="s" className="small">{String(sc.scenario)}</span>,
                <span key="d" className="code">{String(sc.defect_rate_pct)}%</span>,
                <span key="r" className="code">{String(sc.rework_rate_pct)}%</span>,
                <span key="v">{fmtMoney(Number(sc.direct_variable_cost_cents), activeCurrency)}</span>,
                <span key="c">{fmtMoney(Number(sc.contribution_profit_cents), activeCurrency)}</span>,
                <strong key="o">{fmtMoney(Number(sc.operating_profit_cents), activeCurrency)}</strong>,
                <span key="p">{sc.recommended_net_price_cents != null ? fmtMoney(Number(sc.recommended_net_price_cents), activeCurrency) : "不可行"}</span>,
                <Tag key="st" tone={sc.is_loss_making ? "red" : "green"}>{sc.is_loss_making ? "亏损" : "盈利"}</Tag>,
              ])}
            />
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <Action
            sm
            run={async () => {
              const res = (await request("/staff/admin/cost-models/standard-matrix", "POST", {
                cost_model_id: activeModel?.id,
              })) as Row;
              setMatrixOut(res);
            }}
          >
            生成 1 / 3 / 10 / 30 / 50 / 100 件 × L1–L4 标准全成本矩阵
          </Action>
          {matrixOut && (
            <div style={{ marginTop: 10 }}>
              <div className="inline-form" style={{ marginBottom: 8 }}>
                <label>
                  <span>按数量档位筛选（共 {(matrixOut.rows ?? []).length} 组）</span>
                  <select value={matrixQtyFilter} onChange={(e) => setMatrixQtyFilter(e.target.value)}>
                    <option value="all">全部 1 / 3 / 10 / 30 / 50 / 100 件</option>
                    {["1", "3", "10", "30", "50", "100"].map((qVal) => (
                      <option key={qVal} value={qVal}>{qVal} 件</option>
                    ))}
                  </select>
                </label>
              </div>
              <Table
                headers={["件数", "复杂度", "组合", "估算直接分钟", "报价收入", "直接成本", "贡献利润", "经营利润", "推荐P", "结论"]}
                rows={(matrixOut.rows ?? [])
                  .filter((r: Row) => matrixQtyFilter === "all" || String(r.qty) === matrixQtyFilter)
                  .map((r: Row, i: number) => [
                  <span key={`q${i}`} className="code">{String(r.qty)}</span>,
                  <span key={`c${i}`} className="code">{String(r.complexity)}</span>,
                  <span key={`b${i}`} className="small">{String(r.bundle_label)}</span>,
                  <span key={`m${i}`} className="small">{String(r.estimated_direct_minutes)}m</span>,
                  <span key={`rv${i}`}>{fmtMoney(Number(r.quoted_revenue_cents), String(matrixOut.currency ?? "USD"))}</span>,
                  <span key={`dc${i}`}>{fmtMoney(Number(r.direct_variable_cost_cents), String(matrixOut.currency ?? "USD"))}</span>,
                  <span key={`cp${i}`}>{fmtMoney(Number(r.contribution_profit_cents), String(matrixOut.currency ?? "USD"))}</span>,
                  <span key={`op${i}`}>{fmtMoney(Number(r.operating_profit_cents), String(matrixOut.currency ?? "USD"))}</span>,
                  <span key={`p${i}`}>{r.recommended_net_price_cents != null ? fmtMoney(Number(r.recommended_net_price_cents), String(matrixOut.currency ?? "USD")) : "—"}</span>,
                  <Tag key={`l${i}`} tone={r.is_loss_making ? "red" : "green"}>{r.is_loss_making ? "亏损" : "正毛利"}</Tag>,
                ])}
              />
            </div>
          )}
        </div>
      </Panel>

      <Panel title="3. 实测工时分位数（P50/P75/P90/Max）与 §43.3 暂估基准对照" subtitle="样本不足明确标记，并行上传等后台系统时间独立统计，绝不重复累计人工工时或自动改价。">
        {stats && (
          <div className="card-soft" style={{ marginBottom: 12 }}>
            <div className="small">
              人工有效总秒数：<strong>{String(stats.bucket_totals_seconds?.active_labor ?? 0)}s</strong> ·
              不可并行等待：<strong>{String(stats.bucket_totals_seconds?.non_parallel_wait ?? 0)}s</strong> ·
              后台异步系统时间（不计人工）：<strong>{String(stats.bucket_totals_seconds?.background_system ?? 0)}s</strong> ·
              中断：<strong>{String(stats.bucket_totals_seconds?.interruption ?? 0)}s</strong>
            </div>
            {(stats.pricing_advisory_alerts ?? []).length > 0 && (
              <div className="notice" style={{ marginTop: 8 }}>
                <strong>调价预警建议（人工审批生效，绝不自动改价）：</strong>{" "}
                {(stats.pricing_advisory_alerts ?? []).map((a: Row) => `${String(a.activity_code)} P50=${String(a.measured_p50_seconds)}s vs 暂估=${String(a.baseline_seconds)}s (${String(a.deviation_pct)}%)`).join(" | ")}
              </div>
            )}
          </div>
        )}
        <Table
          headers={["作业动作", "时间归属桶", "样本数", "P50 (s)", "P75 (s)", "P90 (s)", "Max (s)", "§43.3 暂估 (s)"]}
          rows={(stats?.activity_breakdown ?? []).map((r: Row) => [
            <span key="a" className="code">{String(r.activity_code)}</span>,
            <Tag key="b" tone={r.time_bucket === "active_labor" ? "green" : "gray"}>{String(r.time_bucket)}</Tag>,
            <span key="n" className="code">{String(r.sample_size)}</span>,
            <span key="p50">{String(r.p50_seconds ?? "—")}</span>,
            <span key="p75">{String(r.p75_seconds ?? "—")}</span>,
            <span key="p90">{String(r.p90_seconds ?? "—")}</span>,
            <span key="max">{String(r.max_seconds ?? "—")}</span>,
            <span key="base" className="small muted">{r.estimated_baseline_seconds != null ? `${String(r.estimated_baseline_seconds)}s (${String(r.baseline_data_source)})` : "待建基线"}</span>,
          ])}
          empty="尚无已完成实测工时事件（质检/收货/调度动作将自动产生真实时钟样本）"
        />

        {baselines.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <strong>§43.3 初始暂估作业基准表（明确标注来源，等待 TASK-199B 实仓复验校准）</strong>
            <Table
              headers={["作业", "复杂度", "单位", "暂估区间 (分钟)", "当前模型假设 (分钟)", "来源 / 样本数"]}
              rows={baselines.map((b) => [
                <span key="a" className="code">{String(b.activity_code)}</span>,
                <span key="c" className="code">{String(b.complexity_code)}</span>,
                <span key="u" className="small">{String(b.unit_label)}</span>,
                <span key="r" className="small">{String(b.estimated_min_minutes)}–{String(b.estimated_max_minutes)}</span>,
                <strong key="d">{String(b.default_assumption_minutes)}</strong>,
                <Tag key="s" tone={b.data_source === "field_calibrated" ? "green" : "yellow"}>{String(b.data_source)} ({String(b.sample_size)})</Tag>,
              ])}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
