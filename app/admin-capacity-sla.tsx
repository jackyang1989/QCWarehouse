"use client";

import { useState } from "react";
import { Action, ErrorBlock, Field, Form, Panel, request, Select, Table, Tag, text, useLoad } from "./ui";
import type { Actor } from "../packages/core/common";

type Row = Record<string, any>;

const ALERT_TONE: Record<string, "green" | "yellow" | "red" | "blue" | "gray"> = {
  normal: "green",
  warn_70: "yellow",
  review_85: "red",
  pause_heavy_95: "red",
};

const SLA_STATUS_TONE: Record<string, "green" | "yellow" | "red" | "blue" | "gray"> = {
  active: "green",
  extended: "blue",
  paused: "yellow",
  manual_review_required: "red",
  pending_start: "gray",
  met: "green",
  breached: "red",
  cancelled: "gray",
};

export function AdminCapacitySlaPanel({ actor }: { actor: Actor }) {
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<Row | null>(null);
  const [compareSampleOut, setCompareSampleOut] = useState<{ l1?: Row; l4?: Row } | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [banner, setBanner] = useState("");
  const [actionError, setActionError] = useState("");

  const dashboardLoad = useLoad("/staff/admin/capacity/dashboard?days=7");
  const policiesLoad = useLoad("/staff/admin/capacity/policies");
  const detailLoad = useLoad(selectedPolicyId ? `/staff/admin/capacity/policies/${selectedPolicyId}` : null);
  const orderSlaLoad = useLoad(selectedOrderId ? `/staff/admin/orders/${selectedOrderId}/sla` : null);

  const canEdit = actor.roles.some((r) => r === "super_admin" || r === "warehouse_admin" || r === "finance");
  const canReview = actor.roles.some((r) => r === "super_admin" || r === "reviewer");

  const dashboard = dashboardLoad.data as Row | undefined;
  const policies = ((policiesLoad.data as Row | undefined)?.policies as Row[] | undefined) ?? [];
  const policyDetail = detailLoad.data as Row | undefined;
  const activePolicy = (policyDetail?.policy as Row | undefined) ?? policies[0] ?? null;
  const versions = (policyDetail?.versions as Row[] | undefined) ?? [];
  const commitments = ((dashboard?.commitments as Row[] | undefined) ?? []) as Row[];
  const orderSla = orderSlaLoad.data as Row | undefined;

  function reloadAll() {
    dashboardLoad.reload();
    policiesLoad.reload();
    if (selectedPolicyId) detailLoad.reload();
    if (selectedOrderId) orderSlaLoad.reload();
  }

  async function runBenchmarkComparison() {
    setActionError("");
    try {
      const [l1, l4] = await Promise.all([
        request("/staff/admin/capacity/simulate", "POST", {
          policy_id: activePolicy?.id,
          complexity_code: "L1",
          quantity: 50,
          service_mode: "batch_standard",
          module_codes: ["M01"],
          photo_shots_per_unit: 3,
        }) as Promise<Row>,
        request("/staff/admin/capacity/simulate", "POST", {
          policy_id: activePolicy?.id,
          complexity_code: "L4",
          quantity: 50,
          service_mode: "compare_horizontal",
          module_codes: ["M01", "M03", "M08", "M09", "M10"],
          measurement_coverage_qty: 50,
          measurement_points_per_unit: 12,
          photo_shots_per_unit: 8,
          video_seconds_per_unit: 30,
          compare_group_size: 3,
          golden_sample_calls: 2,
        }) as Promise<Row>,
      ]);
      setCompareSampleOut({ l1, l4 });
      setBanner("已完成 50 件 L1 标准批 vs 50 件 L4 锁定横向对比同规模不同交期对比试算。");
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "对比试算失败");
    }
  }

  return (
    <div className="desk-stack">
      <Panel
        title="仓库有效产能与动态 SLA 引擎（§11 / §58 / E405–E407）"
        subtitle="基于班次净有效工时（扣减休息/开班准备/任务切换）、复杂度/模块/测量拍照负荷、QA 与机位瓶颈、70%/85%/95% 阈值与法定工作日截止历自动计算。"
        badge={
          <div className="actions">
            {canEdit && (
              <Action
                sm
                primary
                run={async () => {
                  setActionError("");
                  const res = (await request("/staff/admin/capacity/seed", "POST", {})) as Row;
                  setBanner(`Seed ${String(res.seed_version)}：新增 ${String(res.inserted_counts?.policies ?? 0)} 条策略，跳过 ${String(res.skipped_existing_counts?.policies ?? 0)} 条。`);
                  reloadAll();
                }}
              >
                初始化产能与 SLA 暂估策略
              </Action>
            )}
            <button type="button" className="button sm" onClick={runBenchmarkComparison}>
              运行 50 件 L1 vs L4 交期差异对比
            </button>
          </div>
        }
      >
        {dashboardLoad.error && <ErrorBlock error={dashboardLoad.error} />}
        {policiesLoad.error && <ErrorBlock error={policiesLoad.error} />}
        {actionError && <ErrorBlock error={actionError} />}
        {banner && (
          <div className="notice" role="status" style={{ marginBottom: 12 }}>
            {banner}
          </div>
        )}

        {dashboard?.warehouse && (
          <div className="metric-grid" style={{ marginBottom: 14 }}>
            <div className="metric-card">
              <span className="muted small">当前目标仓 / 时区 / 截单线</span>
              <strong>{String(dashboard.warehouse.warehouse_code)} · {String(dashboard.warehouse.timezone)}</strong>
              <span className="small muted">收货截单 {String(dashboard.warehouse.cutoff_receiving_time)} · 排班来源：{String(dashboard.warehouse.shift_source)}</span>
            </div>
            <div className="metric-card">
              <span className="muted small">日净有效产能（瓶颈最小值）</span>
              <strong>{Math.round(Number(dashboard.warehouse.effective_daily_capacity_minutes ?? 0))} min/天</strong>
              <span className="small muted">
                检验 {Math.round(Number(dashboard.warehouse.effective_inspector_daily_minutes ?? 0))}m · QA {Math.round(Number(dashboard.warehouse.effective_qa_daily_minutes ?? 0))}m · 拍台 {String(dashboard.warehouse.active_photo_rigs)} 席
              </span>
            </div>
            <div className="metric-card">
              <span className="muted small">当前在手积压与利用率</span>
              <strong>
                {(Number(dashboard.current_utilization_ratio ?? 0) * 100).toFixed(1)}% ({Math.round(Number(dashboard.warehouse.open_backlog_minutes ?? 0))}m)
              </strong>
              <Tag tone={ALERT_TONE[String(dashboard.current_alert_level)] ?? "gray"}>{String(dashboard.current_alert_level)}</Tag>
            </div>
            <div className="metric-card">
              <span className="muted small">策略数据源与准出状态</span>
              <strong>{String(dashboard.policy?.model_provenance ?? "estimated_baseline")}</strong>
              <Tag tone={dashboard.policy?.model_provenance === "estimated_baseline" ? "yellow" : "green"}>
                {dashboard.policy?.model_provenance === "estimated_baseline" ? "未实测草稿（需 199B 实测校准）" : "已含实测样本校准"}
              </Tag>
            </div>
          </div>
        )}

        {compareSampleOut?.l1 && compareSampleOut?.l4 && (
          <div className="notice" style={{ marginBottom: 12 }}>
            <strong>同数量不同负荷对比：</strong>
            50 件 L1 标准批 → 总工作量 {String(compareSampleOut.l1.workload.total_workload_minutes)} 分钟，瓶颈{" "}
            <span className="code">{String(compareSampleOut.l1.bottleneck.bottleneck_stage)}</span>，预计 {String(compareSampleOut.l1.sla_decision.estimated_business_days)} 个工作日，人工复核：
            {String(compareSampleOut.l1.sla_decision.manual_sla_required)}；
            <br />
            50 件 L4 横向对比+全测+拍摄 → 总工作量 {String(compareSampleOut.l4.workload.total_workload_minutes)} 分钟，瓶颈{" "}
            <span className="code">{String(compareSampleOut.l4.bottleneck.bottleneck_stage)}</span>，锁组依赖：{String(compareSampleOut.l4.dependencies.dependency_locked)}，预计{" "}
            {String(compareSampleOut.l4.sla_decision.estimated_business_days)} 个工作日，强制转人工交期确认：{String(compareSampleOut.l4.sla_decision.manual_sla_required)}。
          </div>
        )}
      </Panel>

      <Panel
        title="1. 产能与 SLA 策略版本治理（SoD 双人审批）"
        subtitle="作者编制/编辑与提交人不可自批发布；正式发布仅写入沙盘验收（sandbox_acceptance）并保留不可变快照与 content_hash。"
      >
        <Table
          headers={["策略编码", "名称", "数据口径", "审批状态", "预警/复核/重单阈值", "操作"]}
          empty="暂无策略，请先点击上方初始化。"
          rows={policies.map((r) => {
            const isAuthor = r.created_by === actor.id || r.submitted_by === actor.id;
            return [
              <span key="c" className="code">{String(r.policy_code)}</span>,
              <strong key="n" className="small">{String(r.name_zh)}</strong>,
              <Tag key="p" tone={r.model_provenance === "estimated_baseline" ? "yellow" : "green"}>{String(r.model_provenance)}</Tag>,
              <Tag key="s" tone={r.status === "published" ? "green" : r.status === "in_review" ? "blue" : "yellow"}>
                {`${String(r.status)} · v${String(r.current_version)}`}
              </Tag>,
              <span key="t" className="small">
                {`${Math.round(Number(r.warn_utilization_pct) * 100)}% / ${Math.round(Number(r.review_utilization_pct) * 100)}% / ${Math.round(Number(r.pause_heavy_intake_pct) * 100)}%`}
              </span>,
              <div key="op" className="actions">
                <button type="button" className="button sm" onClick={() => setSelectedPolicyId(String(r.id))}>
                  查看详情
                </button>
                {canEdit && r.status === "draft" && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/admin/capacity/policies/${r.id}/submit`, "POST", {});
                      reloadAll();
                    }}
                  >
                    提交审核
                  </Action>
                )}
                {canReview && r.status === "in_review" && !isAuthor && (
                  <Action
                    sm
                    primary
                    run={async () => {
                      await request(`/staff/admin/capacity/policies/${r.id}/publish`, "POST", {
                        publication_scope: "sandbox_acceptance",
                        note: "Approved in Admin panel",
                      });
                      reloadAll();
                    }}
                  >
                    审批发布（沙盘）
                  </Action>
                )}
              </div>,
            ];
          })}
        />

        {activePolicy && (
          <div style={{ marginTop: 14 }}>
            <Form
              key={`${String(activePolicy.id)}-${String(activePolicy.current_version)}-${String(activePolicy.updated_at)}`}
              label={canEdit ? "保存为新草稿版本" : "只读"}
              disabled={!canEdit}
              inline
              run={async (fd) => {
                if (!canEdit) return;
                setActionError("");
                await request("/staff/admin/capacity/policies", "POST", {
                  id: activePolicy.id,
                  warehouse_id: activePolicy.warehouse_id ?? null,
                  policy_code: text(fd, "policy_code"),
                  name_zh: text(fd, "name_zh"),
                  name_en: text(fd, "name_en"),
                  description_zh: activePolicy.description_zh ?? "",
                  description_en: activePolicy.description_en ?? "",
                  effective_inspector_utilization: Number(text(fd, "effective_inspector_utilization")),
                  effective_qa_utilization: Number(text(fd, "effective_qa_utilization")),
                  default_daily_inspector_minutes: Number(text(fd, "default_daily_inspector_minutes")),
                  default_daily_qa_minutes: Number(text(fd, "default_daily_qa_minutes")),
                  default_workstation_slots: Number(text(fd, "default_workstation_slots")),
                  default_photo_rig_slots: Number(text(fd, "default_photo_rig_slots")),
                  daily_break_minutes_per_shift: Number(text(fd, "daily_break_minutes_per_shift")),
                  daily_prep_minutes_per_shift: Number(text(fd, "daily_prep_minutes_per_shift")),
                  task_switch_overhead_minutes: Number(text(fd, "task_switch_overhead_minutes")),
                  qa_bottleneck_ratio: Number(text(fd, "qa_bottleneck_ratio")),
                  upload_queue_buffer_minutes: Number(text(fd, "upload_queue_buffer_minutes")),
                  base_rework_rate: Number(text(fd, "base_rework_rate")),
                  safety_buffer_pct: Number(text(fd, "safety_buffer_pct")),
                  safety_buffer_min_minutes: Number(text(fd, "safety_buffer_min_minutes")),
                  warn_utilization_pct: Number(text(fd, "warn_utilization_pct")),
                  review_utilization_pct: Number(text(fd, "review_utilization_pct")),
                  pause_heavy_intake_pct: Number(text(fd, "pause_heavy_intake_pct")),
                  manual_quote_workload_minutes: Number(text(fd, "manual_quote_workload_minutes")),
                  manual_quote_min_items: Number(text(fd, "manual_quote_min_items")),
                  complexity_profiles: activePolicy.complexity_profiles,
                  module_workload_profiles: activePolicy.module_workload_profiles,
                  service_mode_rules: activePolicy.service_mode_rules,
                  stage_weights: activePolicy.stage_weights,
                });
                setBanner(`已更新策略 ${String(activePolicy.policy_code)} 草稿参数（完整保留仓库与矩阵配置）。`);
                reloadAll();
              }}
            >
              <Field label="策略编码" name="policy_code" value={String(activePolicy.policy_code)} required />
              <Field label="策略中文名" name="name_zh" value={String(activePolicy.name_zh)} required />
              <Field label="策略英文名" name="name_en" value={String(activePolicy.name_en)} required />
              <Field label="日默认检验分钟（无排班回退）" name="default_daily_inspector_minutes" type="number" value={String(activePolicy.default_daily_inspector_minutes)} />
              <Field label="日默认 QA 分钟（无排班回退）" name="default_daily_qa_minutes" type="number" value={String(activePolicy.default_daily_qa_minutes)} />
              <Field label="默认检验拍台席位数" name="default_workstation_slots" type="number" value={String(activePolicy.default_workstation_slots)} />
              <Field label="默认摄影机位席位数" name="default_photo_rig_slots" type="number" value={String(activePolicy.default_photo_rig_slots)} />
              <Field label="每班休息扣减(分)" name="daily_break_minutes_per_shift" type="number" value={String(activePolicy.daily_break_minutes_per_shift)} />
              <Field label="每班开班准备扣减(分)" name="daily_prep_minutes_per_shift" type="number" value={String(activePolicy.daily_prep_minutes_per_shift)} />
              <Field label="任务切换损耗(分/单)" name="task_switch_overhead_minutes" type="number" step="0.5" value={String(activePolicy.task_switch_overhead_minutes)} />
              <Field label="上传队列异步缓冲(分)" name="upload_queue_buffer_minutes" type="number" step="1" value={String(activePolicy.upload_queue_buffer_minutes)} />
              <Field label="基准返工预期 (0–0.8)" name="base_rework_rate" type="number" step="0.01" value={String(activePolicy.base_rework_rate)} />
              <Field label="最小安全缓冲(分)" name="safety_buffer_min_minutes" type="number" value={String(activePolicy.safety_buffer_min_minutes)} />
              <Field label="检验员有效利用率 (0.2–1)" name="effective_inspector_utilization" type="number" step="0.01" value={String(activePolicy.effective_inspector_utilization)} />
              <Field label="QA 有效利用率 (0.2–1)" name="effective_qa_utilization" type="number" step="0.01" value={String(activePolicy.effective_qa_utilization)} />
              <Field label="QA 瓶颈放大系数 (>=1)" name="qa_bottleneck_ratio" type="number" step="0.05" value={String(activePolicy.qa_bottleneck_ratio)} />
              <Field label="安全缓冲比例 (0–1)" name="safety_buffer_pct" type="number" step="0.01" value={String(activePolicy.safety_buffer_pct)} />
              <Field label="预警阈值 (默认 0.70)" name="warn_utilization_pct" type="number" step="0.01" value={String(activePolicy.warn_utilization_pct)} />
              <Field label="转复核阈值 (默认 0.85)" name="review_utilization_pct" type="number" step="0.01" value={String(activePolicy.review_utilization_pct)} />
              <Field label="重单暂停阈值 (默认 0.95)" name="pause_heavy_intake_pct" type="number" step="0.01" value={String(activePolicy.pause_heavy_intake_pct)} />
              <Field label="人工交期工作量上限(分)" name="manual_quote_workload_minutes" type="number" value={String(activePolicy.manual_quote_workload_minutes)} />
              <Field label="人工交期触发件数阈值" name="manual_quote_min_items" type="number" value={String(activePolicy.manual_quote_min_items)} />
            </Form>

            {versions.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Table
                  headers={["版本", "状态", "作用域", "内容哈希", "复核人", "回滚"]}
                  empty="暂无已发布不可变版本。"
                  rows={versions.map((v) => [
                    `v${String(v.version)}`,
                    <Tag key="vs" tone={v.state === "PUBLISHED" ? "green" : "gray"}>{String(v.state)}</Tag>,
                    String(v.publication_scope),
                    <span key="vh" className="code">{`${String(v.content_hash).slice(0, 12)}…`}</span>,
                    String(v.reviewer_email ?? "—"),
                    canEdit ? (
                      <Action
                        key="vrb"
                        sm
                        run={async () => {
                          await request(`/staff/admin/capacity/policies/${activePolicy.id}/rollback`, "POST", {
                            target_version: Number(v.version),
                          });
                          reloadAll();
                        }}
                      >
                        {`基于 v${String(v.version)} 回滚新建草稿`}
                      </Action>
                    ) : (
                      "—"
                    ),
                  ])}
                />
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="2. 动态 SLA 与负荷沙盘模拟（Simulator）"
        subtitle="支持传入复杂度、模块覆盖、测点数、拍/录时长、对比组大小与 Golden 样调用，输出分阶段工作量、瓶颈环节、70/85/95 负荷告警及工作日历预计完成时间。"
      >
        <Form
          label="计算工作量与预计交期"
          inline
          run={async (fd) => {
            setActionError("");
            const mods = text(fd, "module_codes")
              .split(",")
              .map((x) => x.trim().toUpperCase())
              .filter(Boolean);
            const out = (await request("/staff/admin/capacity/simulate", "POST", {
              policy_id: activePolicy?.id,
              complexity_code: text(fd, "complexity_code"),
              quantity: Number(text(fd, "quantity")),
              parcel_count: Number(text(fd, "parcel_count")),
              service_mode: text(fd, "service_mode"),
              module_codes: mods.length > 0 ? mods : ["M01"],
              measurement_coverage_qty: Number(text(fd, "measurement_coverage_qty")),
              measurement_points_per_unit: Number(text(fd, "measurement_points_per_unit")),
              photo_shots_per_unit: Number(text(fd, "photo_shots_per_unit")),
              video_seconds_per_unit: Number(text(fd, "video_seconds_per_unit")),
              compare_group_size: Number(text(fd, "compare_group_size")),
              golden_sample_calls: Number(text(fd, "golden_sample_calls")),
            })) as Row;
            setSimResult(out);
          }}
        >
          <Select
            label="产品复杂度 (L1–L5)"
            name="complexity_code"
            value="L2"
            choices={[
              { id: "L1", label: "L1 基础简款" },
              { id: "L2", label: "L2 常规服饰" },
              { id: "L3", label: "L3 复杂结构" },
              { id: "L4", label: "L4 高密工艺（触发人工）" },
              { id: "L5", label: "L5 专项定制（触发人工）" },
            ]}
          />
          <Field label="检验件数" name="quantity" type="number" value="20" required />
          <Field label="包裹数" name="parcel_count" type="number" value="2" required />
          <Select
            label="服务模式"
            name="service_mode"
            value="batch_standard"
            choices={[
              { id: "batch_standard", label: "batch_standard（允许独立就绪批次）" },
              { id: "compare_horizontal", label: "compare_horizontal（依赖锁组同出）" },
              { id: "golden_sample", label: "golden_sample（确认样锁定对照）" },
            ]}
          />
          <Field label="模块列表 (逗号分隔 M01–M11)" name="module_codes" value="M01,M02,M08" />
          <Field label="测量覆盖件数 (0=按全单)" name="measurement_coverage_qty" type="number" value="10" />
          <Field label="每件测点数" name="measurement_points_per_unit" type="number" value="5" />
          <Field label="每件精拍张数" name="photo_shots_per_unit" type="number" value="4" />
          <Field label="每件短视频(秒)" name="video_seconds_per_unit" type="number" value="10" />
          <Field label="横向对比组规模" name="compare_group_size" type="number" value="0" />
          <Field label="Golden 样调用次数" name="golden_sample_calls" type="number" value="0" />
        </Form>

        {simResult && (
          <div className="notice" style={{ marginTop: 12 }}>
            <div>
              <strong>工作量合计：</strong>
              {String(simResult.workload.total_workload_minutes)} 分钟（有效作业 {String(simResult.workload.active_inspection_minutes)}m · QA 审核{" "}
              {String(simResult.workload.qa_review_minutes)}m · 异步上传排队 {String(simResult.workload.async_upload_buffer_minutes)}m · 安全缓冲{" "}
              {String(simResult.workload.safety_buffer_minutes)}m）
            </div>
            <div>
              <strong>瓶颈与告警：</strong>
              主瓶颈 <span className="code">{String(simResult.bottleneck.bottleneck_stage)}</span> · 综合利用率 {(Number(simResult.bottleneck.total_utilization_ratio) * 100).toFixed(1)}% ·{" "}
              <Tag tone={ALERT_TONE[String(simResult.bottleneck.capacity_alert_level)] ?? "gray"}>{String(simResult.bottleneck.capacity_alert_level)}</Tag>
              {" · "}口径：<Tag tone={simResult.is_draft_uncalibrated ? "yellow" : "green"}>{String(simResult.provenance)}</Tag>
            </div>
            <div>
              <strong>依赖与交期判定：</strong>
              依赖锁定 {String(simResult.dependencies.dependency_locked)} · 预计 {String(simResult.sla_decision.estimated_business_days)} 个工作日（预计完成{" "}
              <span className="code">{String(simResult.sla_decision.estimated_due_at)}</span>）· 人工交期：{String(simResult.sla_decision.manual_sla_required)}
              {simResult.sla_decision.manual_sla_reasons?.length > 0 ? `（${simResult.sla_decision.manual_sla_reasons.join("；")}）` : ""}
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title="3. 订单 SLA 时钟承诺与暂停/延展记录（保护 sla_started_at 不可变）"
        subtitle="支持按订单查看承诺批次、独立先就绪子批、暂停顺延（T32）、人工延期与审计事件。"
      >
        <Table
          headers={["订单号", "批次/组", "类型", "状态", "工作量(分)", "主瓶颈", "当前承诺交期", "控制"]}
          empty="暂无持久化订单 SLA 承诺记录。"
          rows={commitments.map((r) => [
            <span key="o" className="code">{String(r.order_public_no)}</span>,
            String(r.batch_key),
            String(r.commitment_kind),
            <Tag key="st" tone={SLA_STATUS_TONE[String(r.status)] ?? "gray"}>{String(r.status)}</Tag>,
            String(r.estimated_workload_minutes),
            String(r.bottleneck_stage),
            String(r.current_due_at ?? "—"),
            <div key="op" className="actions">
              <button type="button" className="button sm" onClick={() => setSelectedOrderId(String(r.order_id))}>
                事件日志
              </button>
              {canEdit && r.status === "active" && (
                <Action
                  sm
                  run={async () => {
                    await request(`/staff/admin/sla/${r.id}/pause`, "POST", {
                      reason: "Customer sample clarification / warehouse pause from Admin desk",
                      notify_customer: true,
                    });
                    reloadAll();
                  }}
                >
                  暂停计时
                </Action>
              )}
              {canEdit && r.status === "paused" && (
                <Action
                  sm
                  primary
                  run={async () => {
                    await request(`/staff/admin/sla/${r.id}/resume`, "POST", {
                      reason: "Blocker resolved; resuming SLA and shifting deadline",
                      notify_customer: true,
                    });
                    reloadAll();
                  }}
                >
                  恢复并顺延
                </Action>
              )}
            </div>,
          ])}
        />

        {orderSlaLoad.error && <ErrorBlock error={orderSlaLoad.error} />}
        {orderSla?.events && (
          <div style={{ marginTop: 12 }}>
            <Table
              headers={["时间", "事件", "原因", "顺延秒数", "变更后交期", "通知客户"]}
              empty="暂无时钟审计事件。"
              rows={(orderSla.events as Row[]).map((e) => [
                String(e.created_at),
                <span key="et" className="code">{String(e.event_type)}</span>,
                String(e.reason),
                String(e.paused_delta_seconds ?? 0),
                String(e.new_due_at ?? "—"),
                e.customer_notified ? "是" : "否",
              ])}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
