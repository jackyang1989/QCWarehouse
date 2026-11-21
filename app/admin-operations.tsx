"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Action,
  checked,
  CodeButton,
  Empty,
  ErrorBlock,
  Field,
  Form,
  MediaButton,
  ModalDrawer,
  Panel,
  request,
  Select,
  StaffObjectDrawer,
  type StaffObjectTarget,
  stamp,
  Table,
  Tag,
  text,
  upload,
  usd,
  useLoad,
  type Row,
} from "./ui";
import {
  AdminTabs,
  AUDIT_ACTION_ZH,
  BATCH_STATE_ZH,
  BizTag,
  CopyId,
  DISPOSAL_STATE_ZH,
  DISPOSITION_ACTION_ZH,
  EmptyState,
  formatAuditSnapshotSummary,
  INCIDENT_KIND_ZH,
  INCIDENT_STATE_ZH,
  Money,
  ORDER_STATE_ZH,
  REPORT_STATE_ZH,
  SERVICE_CODE_ZH,
  SlaCountdownBadge,
  StatusBanner,
  STOCKTAKE_STATE_ZH,
  TASK_STATE_ZH,
  WarehouseItemLifecycleTags,
} from "./admin-labels";
import { hasStaffAccess, staffAccess } from "../packages/core/staff-access";

export function AdminOverviewDashboard({
  deskData,
  error,
  reload,
  actor,
}: {
  deskData?: Row;
  error: string;
  reload: () => void;
  actor: Row;
}) {
  const [jumpNo, setJumpNo] = useState("");
  const m = deskData?.overviewMetrics;
  const defaultScope: "production" | "all" =
    m && Number(m.production_orders ?? 0) === 0 && Number(m.test_orders ?? 0) > 0 ? "all" : "production";
  const [scope, setScope] = useState<"production" | "all">(defaultScope);
  const trend: Row[] = deskData?.dailyTrend ?? [];
  const maxTrend = Math.max(1, ...trend.map(t => Number(t.total ?? 0)));
  const isFinance = hasStaffAccess(actor.roles ?? [], staffAccess.finance);
  const isOrders = hasStaffAccess(actor.roles ?? [], staffAccess.orders);
  const isTracking = hasStaffAccess(actor.roles ?? [], staffAccess.tracking);
  const isSuper = (actor.roles ?? []).includes("super_admin");
  const isTemplates = hasStaffAccess(actor.roles ?? [], staffAccess.templates);

  const awaitingSamplesCount = scope === "all" ? Number(m?.awaiting_samples_all ?? m?.awaiting_samples ?? 0) : Number(m?.awaiting_samples ?? 0);
  const queuedOrInspectingCount = scope === "all" ? Number(m?.queued_or_inspecting_all ?? m?.queued_or_inspecting ?? 0) : Number(m?.queued_or_inspecting ?? 0);
  const qaReviewCount = scope === "all" ? Number(m?.qa_review_all ?? m?.qa_review ?? 0) : Number(m?.qa_review ?? 0);
  const exceptionOrdersCount = scope === "all" ? Number(m?.exception_orders_all ?? m?.sla_overdue_all ?? 0) : Number(m?.exception_orders ?? m?.sla_overdue ?? 0);
  const slaOverdueCount = scope === "all" ? Number(m?.sla_overdue_all ?? m?.sla_overdue ?? 0) : Number(m?.sla_overdue ?? 0);
  const scopeLabel = scope === "all" ? "含测试单全量口径" : "正式业务单口径";

  const todoCards: {
    show: boolean;
    label: string;
    count: number;
    hint: string;
    href: string;
    urgency?: "urgent" | "danger";
  }[] = [
    {
      show: isFinance,
      label: "待独立审批退款",
      count: Number(m?.pending_refunds ?? 0),
      hint: "全库待审申请 · 须复核执行阶段与余额",
      href: "/admin/refunds",
      urgency: Number(m?.pending_refunds ?? 0) > 0 ? "urgent" : undefined,
    },
    {
      show: isOrders,
      label: "待人工核定非标报价",
      count: Number(m?.pending_manual_quotes ?? 0),
      hint: "全库待报价 · 复杂件数等待人工核价",
      href: "/admin/dispositions",
      urgency: Number(m?.pending_manual_quotes ?? 0) > 0 ? "urgent" : undefined,
    },
    {
      show: isOrders || hasStaffAccess(actor.roles ?? [], staffAccess.inspection),
      label: "待 QA 复核报告版本",
      count: Number(m?.pending_report_reviews ?? 0),
      hint: "全库已提交报告 · 待独立复核生成 PDF",
      href: "/admin/inspections",
      urgency: Number(m?.pending_report_reviews ?? 0) > 0 ? "urgent" : undefined,
    },
    {
      show: isTracking,
      label: "承运商已签收未实收",
      count: Number(m?.delivered_unreceived ?? 0),
      hint: "入仓运单显示签收但仓库未扫码实收",
      href: "/admin/logistics",
      urgency: Number(m?.delivered_unreceived ?? 0) > 0 ? "danger" : undefined,
    },
    {
      show: isOrders,
      label: "未认领/无主待核验包裹",
      count: Number(m?.unmatched_packages ?? 0),
      hint: "全仓无主件 · 缺少专属码待绑定客户",
      href: "/admin/orders?tab=claims",
      urgency: Number(m?.unmatched_packages ?? 0) > 0 ? "urgent" : undefined,
    },
    {
      show: isOrders,
      label: "待跟进客服工单",
      count: Number(m?.open_tickets ?? 0),
      hint: "全库未结案工单 · 收货差异/异议/咨询",
      href: "/admin/tickets",
    },
    {
      show: isFinance,
      label: "支付争议 / 拒付冻结",
      count: Number(m?.open_disputes ?? 0),
      hint: "全库未决争议 · 关联订单已冻结待核销",
      href: "/admin/payments?tab=reconciliation_issues",
      urgency: Number(m?.open_disputes ?? 0) > 0 ? "danger" : undefined,
    },
    {
      show: isOrders,
      label: `阻塞 / 异常 / SLA 超期订单`,
      count: exceptionOrdersCount,
      hint: `${scopeLabel}（其中 SLA 超期 ${slaOverdueCount} 单）`,
      href: `/admin/orders?tab=exceptions&test=${scope}`,
      urgency: exceptionOrdersCount > 0 ? "danger" : undefined,
    },
    {
      show: isOrders || isFinance,
      label: "未结案库内事故 / 盘点复核",
      count: Number(m?.open_incidents ?? 0) + Number(m?.submitted_stocktakes ?? 0),
      hint: `事故 ${m?.open_incidents ?? 0} 起 · 盘点差异 ${m?.submitted_stocktakes ?? 0} 单`,
      href: "/admin/incidents",
      urgency: Number(m?.open_incidents ?? 0) > 0 ? "urgent" : undefined,
    },
    {
      show: isSuper,
      label: "异常失败后台作业",
      count: Number(m?.failed_jobs ?? 0),
      hint: "含报告渲染、自动退款或邮件重试队列",
      href: "/admin/operations",
      urgency: Number(m?.failed_jobs ?? 0) > 0 ? "danger" : undefined,
    },
  ];

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>运营管理指挥台</h1>
          <p className="muted">集中呈现待审批、待核验、异常告警与在途质检负荷；每张卡片统计口径与点击进入的目标队列严格一致。</p>
        </div>
        <div className="head-actions">
          <div className="quick-switch" role="group" aria-label="订单统计口径切换">
            <button
              type="button"
              className={scope === "production" ? "on" : ""}
              onClick={() => setScope("production")}
            >
              仅正式单 ({m?.production_orders ?? 0})
            </button>
            <button
              type="button"
              className={scope === "all" ? "on" : ""}
              onClick={() => setScope("all")}
            >
              含测试单全量 ({Number(m?.production_orders ?? 0) + Number(m?.test_orders ?? 0)})
            </button>
          </div>
          <Tag tone={deskData?.effectiveLaunchMode === "production" ? "green" : "yellow"}>
            {deskData?.effectiveLaunchMode === "production" ? "正式生产运行模式" : "预发布隔离模式 (staging_only)"}
          </Tag>
          <button type="button" className="button sm" onClick={reload}>刷新全景状态</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}

      {m && (
        <>
          <Panel title="优先待办与异常处理队列" subtitle={`当前订单类指标口径：${scopeLabel}（正式单 ${m.production_orders} 笔 · 隔离测试单 ${m.test_orders} 笔）。点击卡片直达对应筛选队列。`}>
            <div className="todo-grid">
              {todoCards.filter(c => c.show).map(card => (
                <Link key={card.label} href={card.href} className={`todo-card${card.urgency ? ` ${card.urgency}` : ""}`}>
                  <span className="small muted">{card.label}</span>
                  <strong>{card.count}</strong>
                  <small className="muted">{card.hint} →</small>
                </Link>
              ))}
            </div>
          </Panel>

          <div className="metric-strip" aria-label="订单阶段负荷指标">
            <Link className="metric" href={`/admin/orders?state=awaiting_samples&test=${scope}`} style={{ textDecoration: "none", color: "inherit" }}>
              <span>待样件到仓（{scope === "all" ? "全量" : "正式单"}）</span>
              <strong>{awaitingSamplesCount}</strong>
              <small>点击查看待到仓订单队列 →</small>
            </Link>
            <Link className="metric" href={`/admin/orders?state=inspecting&test=${scope}`} style={{ textDecoration: "none", color: "inherit" }}>
              <span>排队及质检中（{scope === "all" ? "全量" : "正式单"}）</span>
              <strong>{queuedOrInspectingCount}</strong>
              <small>其中 QA 复核中 {qaReviewCount} 单 →</small>
            </Link>
            <Link className="metric" href="/admin/dispositions" style={{ textDecoration: "none", color: "inherit" }}>
              <span>待处理发运批次（全库）</span>
              <strong>{m.dispatch_pending}</strong>
              <small>含待称重、待付款与待打包交接 →</small>
            </Link>
            <Link className="metric" href={`/admin/orders?tab=exceptions&test=${scope}`} style={{ textDecoration: "none", color: "inherit" }}>
              <span>阻塞 / 异常 / SLA 超期（{scope === "all" ? "全量" : "正式单"}）</span>
              <strong>{exceptionOrdersCount}</strong>
              <small>SLA 逾期 {slaOverdueCount} 单 · 拒付 {m.open_disputes} · 签收未入库 {m.delivered_unreceived} →</small>
            </Link>
          </div>
        </>
      )}

      <form
        className="admin-toolbar"
        onSubmit={e => {
          e.preventDefault();
          const clean = jumpNo.trim().toUpperCase();
          if (/^QW-[A-Z0-9]{4,16}$/.test(clean)) location.assign(`/admin/orders/${clean}`);
        }}
      >
        <label>
          快捷直达订单详情工作台
          <input
            value={jumpNo}
            onChange={e => setJumpNo(e.target.value)}
            placeholder="输入完整订单号，如 QW-XXXXXXXX，按回车直达详情"
          />
        </label>
        <div className="actions">
          <button type="submit" className="button primary sm" disabled={!/^QW-[A-Z0-9]{4,16}$/i.test(jumpNo.trim())}>打开订单详情</button>
          {isOrders && <Link className="button sm" href="/admin/customers">客户档案 ({m?.active_customers ?? "—"})</Link>}
          {isFinance && <Link className="button sm" href="/admin/payments">支付流水与对账</Link>}
          {isFinance && <Link className="button sm" href="/admin/refunds">退款审批台</Link>}
          {isTemplates && <Link className="button sm" href="/admin/templates">检查模板配置</Link>}
        </div>
      </form>

      {trend.length > 0 && (
        <Panel title="近 9 日正式订单建单趋势（UTC · 已排除测试单）">
          <div className="bars" aria-label="近 9 日订单柱状图">
            {trend.map(day => {
              const h = Math.max(8, Math.round((Number(day.total ?? 0) / maxTrend) * 100));
              return (
                <span
                  key={day.day}
                  style={{ height: `${h}%` }}
                  data-v={`${day.day}: ${day.total}单(完结${day.completed})`}
                  title={`${day.day}: 总计 ${day.total} 单，完结 ${day.completed} 单`}
                />
              );
            })}
          </div>
          <div className="row between flexwrap" style={{ marginTop: 6, gap: 4 }}>
            {trend.map(day => <small key={day.day} className="code">{day.day}</small>)}
          </div>
        </Panel>
      )}
    </>
  );
}

export function AdminInspectionsWorkbench({ actor }: { actor?: Row }) {
  const [tab, setTab] = useState<"tasks" | "qa" | "reports">("tasks");
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [stateFilter, setStateFilter] = useState("");

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (stateFilter) params.set("state", stateFilter);
  const { data, error, reload } = useLoad(`/staff/admin/inspections${params.size ? `?${params.toString()}` : ""}`);
  const s = data?.summary ?? {};
  const tasks: Row[] = data?.tasks ?? [];
  const qaReviews: Row[] = data?.qa_reviews ?? [];
  const reports: Row[] = data?.reports ?? [];
  const isInspector = Boolean(actor?.roles?.includes("inspector"));
  const canReviewReport = Boolean(actor?.roles?.some((r: string) => ["reviewer", "warehouse_admin", "super_admin"].includes(r)));

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>质检任务、QA 复核与报告运营监督</h1>
          <p className="muted">全局监控所有检查任务推进、独立 QA 复核队列与客户可见正式报告发布状态（严格保留检查员与独立复核员职责分离）。</p>
        </div>
        <div className="head-actions">
          {isInspector && <Link className="button sm" href="/wh/inspection">仓库检查队列</Link>}
          {canReviewReport && <Link className="button sm" href="/wh/review">QA 复核与修订工作台</Link>}
          <button type="button" className="button sm" onClick={reload}>刷新数据</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}

      {data && (
        <div className="metric-strip" aria-label="质检与 QA 统计">
          <div className="metric"><span>待检 / 进行中任务</span><strong>{s.pending_tasks ?? 0}</strong><small>仓库现场检查任务</small></div>
          <div className="metric"><span>已提交待 QA 审核任务</span><strong>{s.submitted_for_qa ?? 0}</strong><small>等待汇总或独立 QA 检查</small></div>
          <div className="metric"><span>待复核报告版本</span><strong>{s.awaiting_report_review ?? 0}</strong><small>已批待出 PDF：{s.awaiting_pdf ?? 0} 份</small></div>
          <div className="metric"><span>已正式发布报告</span><strong>{s.published_reports ?? 0}</strong><small>含历史修订快照版本</small></div>
        </div>
      )}

      <AdminTabs
        active={tab}
        onChange={next => setTab(next as "tasks" | "qa" | "reports")}
        tabs={[
          { id: "tasks", label: "质检任务监督队列", count: tasks.length },
          { id: "qa", label: "QA 复核与待发布报告", count: qaReviews.length },
          { id: "reports", label: "已发布报告版本台账", count: reports.length },
        ]}
      />

      <form
        className="admin-toolbar"
        onSubmit={e => {
          e.preventDefault();
          setQ(searchInput.trim());
        }}
      >
        <label>
          检索订单号 / 客户收件码 / 实物编号
          <input type="search" value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="QW-... / QCW-... / S-..." />
        </label>
        {tab === "tasks" && (
          <label>
            任务状态
            <select value={stateFilter} onChange={e => setStateFilter(e.target.value)}>
              <option value="">全部非作废任务</option>
              {Object.entries(TASK_STATE_ZH).filter(([k]) => k !== "VOID").map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
        )}
        <div className="actions">
          <button type="submit" className="button primary sm">筛选</button>
          <button type="button" className="button sm" onClick={() => { setSearchInput(""); setQ(""); setStateFilter(""); }}>重置</button>
        </div>
      </form>

      {tab === "tasks" && (
        <Panel title={`质检任务明细 (${tasks.length})`} subtitle="点击「监督详情」打开管理后台只读监督工作台，核验模板版本、逐项实测数据与证据照；现场录入仅限检查员在仓库工作台执行。">
          <Table
            headers={["任务编号", "所属订单", "客户码", "实物 / 对比组", "服务与品类", "锁定模板", "执行检查员", "任务状态", "已录结果 / 照片", "SLA 时限", "监督与执行"]}
            rows={tasks.map(t => [
              <Link key="id" className="code nowrap" href={`/admin/inspections/tasks/${t.id}`}><strong>TSK-{t.id.slice(0, 8).toUpperCase()}</strong></Link>,
              <Link key="o" className="code nowrap" href={`/admin/orders/${t.order_no}`}>{t.order_no}</Link>,
              <span key="c" className="code nowrap">{t.receiving_code ?? "—"}</span>,
              <div key="it" className="cell-stack">
                <span className="code">{t.item_codes ?? "—"}</span>
                {t.is_group_task && <small>横向对比 / 确认样组</small>}
              </div>,
              `${t.service_label ?? t.service_code} · ${t.category_label ?? ""}`,
              <span key="tp" className="code nowrap">{t.template_key} v{t.template_version}</span>,
              t.assignee_name ?? <Tag tone="yellow">待检查员领取</Tag>,
              <BizTag key="st" dict={TASK_STATE_ZH} value={t.state} />,
              `${t.result_count} 项 / ${t.evidence_count} 图`,
              <div key="sla" className="cell-stack">
                <span className="nowrap">{stamp(t.sla_due_at, true)}</span>
                <SlaCountdownBadge dueAt={t.sla_due_at} active={!["SUBMITTED", "QA_APPROVED", "VOID"].includes(t.state)} />
              </div>,
              <div key="go" className="actions">
                <Link className="button sm primary nowrap" href={`/admin/inspections/tasks/${t.id}`}>监督详情 →</Link>
                {isInspector && <Link className="button sm nowrap" href={`/wh/task/${t.id}`}>现场录入</Link>}
              </div>,
            ])}
            empty="当前筛选条件下暂无质检任务。"
          />
        </Panel>
      )}

      {tab === "qa" && (
        <Panel title={`QA 复核与 PDF 生成队列 (${qaReviews.length})`} subtitle="强制职责分离：检查员及提交人不可对自己提交的报告执行英文校对批准。">
          <Table
            headers={["报告编号", "所属订单", "客户码", "版本", "当前状态", "提交人 / 复核人", "修订原因", "建立时间", "复核工作台"]}
            rows={qaReviews.map(r => [
              <span key="r" className="code nowrap">{r.report_no}</span>,
              <Link key="o" className="code nowrap" href={`/admin/orders/${r.order_no}`}>{r.order_no}</Link>,
              <span key="c" className="code nowrap">{r.receiving_code ?? "—"}</span>,
              `v${r.version}`,
              <BizTag key="st" dict={REPORT_STATE_ZH} value={r.state} />,
              `${r.created_by_name ?? "—"} / ${r.reviewed_by_name ?? "待独立复核"}`,
              r.amend_reason ?? "首次提交",
              stamp(r.created_at, true),
              <Link key="go" className="button sm primary nowrap" href={`/wh/review/${r.id}`}>
                {canReviewReport ? "QA 校对与审批 →" : "只读查看报告 →"}
              </Link>,
            ])}
            empty="当前没有待独立 QA 复核或待生成 PDF 的报告。"
          />
        </Panel>
      )}

      {tab === "reports" && (
        <Panel title={`已发布正式报告台账 (${reports.length})`}>
          <Table
            headers={["报告编号", "所属订单", "客户码", "版本", "版本状态", "提交人 / QA 审批人", "正式发布时间", "查看与修订"]}
            rows={reports.map(r => [
              <span key="r" className="code nowrap">{r.report_no}</span>,
              <Link key="o" className="code nowrap" href={`/admin/orders/${r.order_no}`}>{r.order_no}</Link>,
              <span key="c" className="code nowrap">{r.receiving_code ?? "—"}</span>,
              `v${r.version}`,
              <BizTag key="st" dict={REPORT_STATE_ZH} value={r.state} />,
              `${r.created_by_name ?? "—"} / ${r.reviewed_by_name ?? "—"}`,
              stamp(r.published_at ?? r.created_at, true),
              <Link key="go" className="button sm nowrap" href={`/wh/review/${r.id}`}>查看报告快照 →</Link>,
            ])}
            empty="尚未发布正式质检报告。"
          />
        </Panel>
      )}
    </>
  );
}

const RESULT_STATUS_ZH: Record<string, { label: string; tone: "green" | "yellow" | "red" | "gray" }> = {
  RECORDED: { label: "正常已记录", tone: "green" },
  OBSERVED_ISSUE: { label: "发现异常/瑕疵", tone: "red" },
  NOT_OBSERVED: { label: "未观察到异常", tone: "green" },
  NOT_TESTED: { label: "未测试", tone: "yellow" },
  NOT_APPLICABLE: { label: "不适用 (N/A)", tone: "gray" },
  BLOCKED: { label: "受阻待解除", tone: "red" },
};

export function AdminInspectionTaskDetail({ id, actor }: { id: string; actor: Row }) {
  const { data, error, reload } = useLoad(`/staff/admin/inspections/tasks/${id}`);
  const [drawer, setDrawer] = useState<StaffObjectTarget | null>(null);
  const meta = data?.meta ?? {};
  const checks: Row[] = data?.content?.checks ?? [];
  const tplShots: Row[] = data?.content?.shots ?? [];
  const results: Row[] = data?.results ?? [];
  const shots: Row[] = data?.shots ?? [];
  const componentsList: Row[] = data?.components ?? [{ id: "main", code: meta.item_code ?? "Item" }];
  const completeness = data?.completeness;
  const reports: Row[] = data?.reports ?? [];
  const canExecute = Boolean(data?.permissions?.can_execute_in_warehouse || actor?.roles?.includes("inspector"));

  return (
    <>
      <div className="page-head row">
        <div>
          <Link href="/admin/inspections">← 返回质检与报告监督台</Link>
          <h1 style={{ marginTop: 6 }}>
            质检任务监督工作台 · <span className="code">TSK-{id.slice(0, 8).toUpperCase()}</span>
          </h1>
          {data && (
            <div className="actions" style={{ marginTop: 6 }}>
              <BizTag dict={TASK_STATE_ZH} value={data.state} />
              <Tag tone="blue">{meta.service_label ?? meta.service_code} · {meta.category_label ?? meta.category_slug}</Tag>
              <span className="code">模板：{meta.template_key} v{meta.template_version}</span>
              {data.public_no && <Link className="button sm" href={`/admin/orders/${data.public_no}`}>所属订单 {data.public_no}</Link>}
              {meta.customer_user_id && <Link className="button sm" href={`/admin/customers/${meta.customer_user_id}`}>客户 {meta.receiving_code}</Link>}
            </div>
          )}
        </div>
        <div className="head-actions">
          {canExecute ? (
            <Link className="button sm primary" href={`/wh/task/${id}`}>进入仓库现场执行工作台 →</Link>
          ) : (
            <Tag tone="outline">只读监督模式（现场录入仅限检查员 inspector）</Tag>
          )}
          <button type="button" className="button sm" onClick={reload}>刷新任务数据</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在加载质检任务监督详情、实测结果与证据照…</p>}

      {data && (
        <>
          {data.review_feedback && (
            <StatusBanner tone="warning" title="QA 复核退回补正意见">
              {data.review_feedback}
            </StatusBanner>
          )}

          <div className="metric-strip" aria-label="任务执行关键指标">
            <div className="metric">
              <span>执行检查员</span>
              <strong>{meta.assignee_name ?? "待领取"}</strong>
              <small>状态：{TASK_STATE_ZH[data.state]?.label ?? data.state}</small>
            </div>
            <div className="metric">
              <span>检查项完成度</span>
              <strong>{results.filter(r => r.is_final).length} / {checks.length * componentsList.length}</strong>
              <small>{completeness?.ok ? "所有必测项与必拍图已齐备" : `尚缺 ${completeness?.missing?.length ?? 0} 项待补`}</small>
            </div>
            <div className="metric">
              <span>已上传机位与证据照</span>
              <strong>{shots.length + results.reduce((n, r) => n + (r.evidence_ids?.length ?? 0), 0)} 张</strong>
              <small>机位照 {shots.length} 张 · 检查项证据 {results.reduce((n, r) => n + (r.evidence_ids?.length ?? 0), 0)} 张</small>
            </div>
            <div className="metric">
              <span>订单 SLA 截止</span>
              <strong style={{ fontSize: 17 }}>{data.sla_due_at ? stamp(data.sla_due_at, true) : "—"}</strong>
              <small><SlaCountdownBadge dueAt={data.sla_due_at} active={!["SUBMITTED", "QA_APPROVED", "VOID"].includes(data.state)} /></small>
            </div>
          </div>

          <div className="admin-split-detail">
            <div className="admin-detail-main">
              <Panel title="1. 任务关联业务档案与锁定模板规范">
                <dl className="admin-kv-grid">
                  <div className="admin-kv-item"><dt>任务完整 UUID</dt><dd><CopyId value={data.id} /></dd></div>
                  <div className="admin-kv-item"><dt>所属订单 / 阶段</dt><dd><Link className="code" href={`/admin/orders/${data.public_no}`}>{data.public_no}</Link> · <BizTag dict={ORDER_STATE_ZH} value={data.order_state} /></dd></div>
                  <div className="admin-kv-item"><dt>所属客户</dt><dd>{meta.customer_user_id ? <Link className="code" href={`/admin/customers/${meta.customer_user_id}`}>{meta.receiving_code} ({meta.customer_email ?? meta.customer_name ?? "—"})</Link> : (meta.receiving_code ?? "—")}</dd></div>
                  <div className="admin-kv-item"><dt>服务套餐</dt><dd>{meta.offer_title ?? meta.service_label} (<span className="code">{meta.offer_sku_code}</span>)</dd></div>
                  <div className="admin-kv-item">
                    <dt>检验对象（实物 / 组件）</dt>
                    <dd className="actions">
                      {meta.item_code ? <CodeButton code={meta.item_code} onClick={() => setDrawer({ kind: "item", ref: meta.item_code })} /> : componentsList.map(c => <Tag key={c.id} tone="blue">{c.code}</Tag>)}
                    </dd>
                  </div>
                  <div className="admin-kv-item">
                    <dt>实物当前库位与状态</dt>
                    <dd>{meta.location_code ?? "—"} · {meta.item_code ? <WarehouseItemLifecycleTags item={meta} compact /> : "对比/确认样任务"}</dd>
                  </div>
                  <div className="admin-kv-item"><dt>锁定检验模板版本</dt><dd><span className="code">{meta.template_key} v{meta.template_version}</span></dd></div>
                  <div className="admin-kv-item"><dt>绑定获批检验能力</dt><dd>{(meta.capability_codes ?? []).join("、") || "标准检验"}</dd></div>
                  {data.content?.measure_conditions && (
                    <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}>
                      <dt>锁定测量环境与工器具条件</dt>
                      <dd>{data.content.measure_conditions}</dd>
                    </div>
                  )}
                  {(meta.customer_notes || data.customer_notes) && (
                    <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}>
                      <dt>客户订单特别说明</dt>
                      <dd>{meta.customer_notes ?? data.customer_notes}</dd>
                    </div>
                  )}
                  {(meta.declared_fields || data.declared_fields) && (
                    <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}>
                      <dt>委托商品申报与参考附件</dt>
                      <dd className="stack" style={{ gap: 4 }}>
                        <span>
                          品名：{(meta.declared_fields ?? data.declared_fields).name ?? "—"} · 款号：{(meta.declared_fields ?? data.declared_fields).sku_code ?? (meta.declared_fields ?? data.declared_fields).sample_code ?? "—"} · 颜色：{(meta.declared_fields ?? data.declared_fields).color_declared ?? (meta.declared_fields ?? data.declared_fields).color ?? "—"} · 尺码：{(meta.declared_fields ?? data.declared_fields).size_label ?? (meta.declared_fields ?? data.declared_fields).size ?? "—"}
                        </span>
                        {(meta.declared_fields ?? data.declared_fields).notes && <small className="muted">单品备注：{(meta.declared_fields ?? data.declared_fields).notes}</small>}
                        {(data.attachment_ids?.length ?? 0) > 0 && <MediaButton ids={data.attachment_ids} label={`查看客户参考附件 (${data.attachment_ids.length})`} />}
                      </dd>
                    </div>
                  )}
                  {(data.tolerances?.length ?? 0) > 0 && (
                    <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}>
                      <dt>客户设定测量目标与公差范围 ({data.tolerances.length} 项)</dt>
                      <dd className="actions" style={{ flexWrap: "wrap" }}>
                        {data.tolerances.map((t: Row) => (
                          <Tag key={t.point_code} tone="blue">
                            {t.point_code}: 目标 {t.target ?? "—"} · 允许 [{t.min ?? "—"} ~ {t.max ?? "—"}] {t.unit ?? ""}
                          </Tag>
                        ))}
                      </dd>
                    </div>
                  )}
                </dl>
              </Panel>

              <Panel title={`2. 逐项检验标准与实测记录 (${checks.length} 项标准 × ${componentsList.length} 个对象)`} subtitle="展示该任务锁定的全部检查项、测量方法、公差比对、多次复测尝试及现场证据照片。">
                <Table
                  headers={["对象/部位", "检查项名称", "方法与单位", "要求 / 客户公差", "当前结论", "实测值 / 多次复测", "客观说明", "证据照片"]}
                  rows={componentsList.flatMap(comp =>
                    checks.map(chk => {
                      const attempts = results.filter(r => r.component === comp.id && r.item_key === chk.key);
                      const finalRes = attempts.find(r => r.is_final) ?? attempts.at(-1);
                      const tol = (data.tolerances ?? []).find((x: Row) => x.point_code === chk.key);
                      const allEvidenceIds = [...new Set(attempts.flatMap(a => a.evidence_ids ?? []))];
                      return [
                        <span key="c" className="code nowrap">{comp.code}</span>,
                        <div key="nm" className="cell-stack">
                          <strong>{chk.zh ?? chk.label}</strong>
                          <small className="muted">{chk.label} (<span className="code">{chk.key}</span>)</small>
                        </div>,
                        <div key="m" className="cell-stack">
                          <span>{chk.method}</span>
                          {chk.unit && <small className="code">单位: {chk.unit}</small>}
                        </div>,
                        <div key="req" className="cell-stack">
                          <div className="actions">
                            {chk.required ? <Tag tone="blue">必检</Tag> : <Tag tone="gray">选检</Tag>}
                            {chk.evidence && <Tag tone="yellow">必拍图</Tag>}
                          </div>
                          {tol && <small className="muted">公差 [{tol.min ?? "—"}~{tol.max ?? "—"}] {tol.unit ?? chk.unit ?? ""}</small>}
                        </div>,
                        finalRes ? <BizTag key="st" dict={RESULT_STATUS_ZH} value={finalRes.status} /> : <Tag key="st" tone="gray">尚未录入</Tag>,
                        finalRes ? (
                          <div key="val" className="cell-stack">
                            <strong>
                              {finalRes.typed_value !== null && finalRes.typed_value !== undefined
                                ? `${String(finalRes.typed_value)}${finalRes.unit ? ` ${finalRes.unit}` : ""}`
                                : "—"}
                            </strong>
                            {attempts.length > 1 && (
                              <small className="muted">
                                {attempts.map(a => `#${a.attempt}: ${a.typed_value ?? a.status}`).join(" | ")}
                              </small>
                            )}
                          </div>
                        ) : "—",
                        finalRes?.reason || (finalRes?.details?.note as string) || <span className="muted">—</span>,
                        allEvidenceIds.length > 0 ? <MediaButton key="ev" ids={allEvidenceIds} label={`照片 (${allEvidenceIds.length})`} /> : <span className="muted">—</span>,
                      ];
                    })
                  )}
                  empty="该模板未配置检查项。"
                />
              </Panel>

              <Panel title={`3. 必拍标准机位与对比组照片 (${shots.length} 张已上传)`}>
                <Table
                  headers={["适用对象", "机位编码", "机位要求", "上传状态", "拍摄时间", "查看原图"]}
                  rows={componentsList.flatMap(comp =>
                    tplShots.map(sh => {
                      const uploaded = shots.filter(s => s.shot_code === sh.code && (s.component ?? "main") === comp.id);
                      return [
                        <span key="c" className="code">{comp.code}</span>,
                        <span key="cd" className="code">{sh.code}</span>,
                        `${sh.zh ?? sh.name} (${sh.name})`,
                        uploaded.length > 0 ? <Tag key="st" tone="green">已上传 ({uploaded.length})</Tag> : <Tag key="st" tone="yellow">待拍摄上传</Tag>,
                        uploaded[0]?.created_at ? stamp(uploaded[0].created_at, true) : "—",
                        uploaded.length > 0 ? <MediaButton key="m" ids={uploaded.map(u => u.id)} label="查看机位照片" /> : "—",
                      ];
                    })
                  )}
                  empty="该模板无独立机位要求。"
                />
              </Panel>
            </div>

            <div className="admin-detail-side">
              <Panel title="提交前完整性校验结果">
                {completeness?.ok ? (
                  <StatusBanner tone="success" title="完整性核验通过">
                    所有必检项、测量复测规则、异常取证照及标准机位照均已齐备。
                  </StatusBanner>
                ) : (
                  <>
                    <StatusBanner tone="warning" title={`尚有 ${completeness?.missing?.length ?? 0} 项未满足提交条件`}>
                      检查员需在仓库执行台补齐以下项目后方可提交至 QA 复核：
                    </StatusBanner>
                    <ul style={{ paddingLeft: 18, margin: "8px 0 0", fontSize: 13 }}>
                      {(completeness?.missing ?? []).map((m: Row, idx: number) => (
                        <li key={idx} style={{ marginBottom: 4 }}>
                          <strong>{m.sample_id} · {m.label}</strong>：{m.hint}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Panel>

              <Panel title={`同订单关联报告版本 (${reports.length})`}>
                <Table
                  headers={["版本", "状态", "复核人", "操作"]}
                  rows={reports.map(r => [
                    `v${r.version}`,
                    <BizTag key="st" dict={REPORT_STATE_ZH} value={r.state} />,
                    r.reviewed_by_name ?? "待复核",
                    <Link key="go" className="button sm nowrap" href={`/wh/review/${r.version_id}`}>打开报告 →</Link>,
                  ])}
                  empty="订单内全部质检任务提交后生成报告版本。"
                />
              </Panel>

              <Panel title={`同订单全部质检任务 (${(data.sibling_tasks ?? []).length})`}>
                <Table
                  headers={["任务", "实物", "状态"]}
                  rows={(data.sibling_tasks ?? []).map((st: Row) => [
                    st.id === id ? <strong key="id" className="code">当前任务</strong> : <Link key="id" className="code" href={`/admin/inspections/tasks/${st.id}`}>TSK-{st.id.slice(0, 8).toUpperCase()}</Link>,
                    <span key="it" className="code">{st.item_code ?? (st.position ? `#${st.position}` : "对比组")}</span>,
                    <BizTag key="s" dict={TASK_STATE_ZH} value={st.state} />,
                  ])}
                />
              </Panel>
            </div>
          </div>
        </>
      )}

      <StaffObjectDrawer target={drawer} actor={actor} onClose={() => setDrawer(null)} />
    </>
  );
}

export function AdminDispositionsWorkbench({
  deskData,
  reloadDesk,
  actor,
  terms,
}: {
  deskData?: Row;
  reloadDesk: () => void;
  actor?: Row;
  terms?: Row[];
}) {
  const [tab, setTab] = useState<"dispatch" | "manual_quotes" | "disposals">("dispatch");
  const overview = useLoad("/staff/admin/dispositions-overview");
  const disposals = useLoad("/staff/disposals");
  const termsRes = useLoad(!terms ? "/public/terms" : null);
  const resolvedTerms: Row[] = terms ?? termsRes.data?.terms ?? [];
  const defaultExpiry = new Date(Date.now() + 48 * 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [drawer, setDrawer] = useState<StaffObjectTarget | null>(null);
  const [quoteNotice, setQuoteNotice] = useState("");

  const batches: Row[] = overview.data?.batches ?? [];
  const storageReqs: Row[] = overview.data?.storage_requests ?? [];
  const manualQuotes: Row[] = overview.data?.manual_quotes ?? deskData?.manualQuotes ?? [];
  const d = disposals.data;
  const prodEnabled = Boolean(d?.production_execution_switch?.enabled);
  const canOpenDispatch = Boolean(actor?.roles?.some((r: string) => ["warehouse_admin", "super_admin"].includes(r)));
  const candidates: Row[] = d?.candidate_items ?? [];
  const activeCaseItemIds = new Set<string>(
    (d?.cases ?? []).filter((c: Row) => c.state !== "cancelled").flatMap((c: Row) => c.item_ids ?? [])
  );
  const firstSelected = candidates.find(c => selectedIds.includes(c.id));
  const lockedOrgKey = firstSelected ? (firstSelected.org_id ?? "__unassigned__") : null;

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>处置发运、人工询价与特殊处置台</h1>
          <p className="muted">按业务职责严格拆分三类工作流：正常检后发运/留存批次监控、非标质检人工报价核定，以及逾期/违禁件双人审批特殊处置。</p>
        </div>
        <div className="head-actions">
          {canOpenDispatch && <Link className="button sm" href="/wh/dispatch">仓库称重打包出库队列</Link>}
          <button type="button" className="button sm" onClick={() => { overview.reload(); disposals.reload(); reloadDesk(); }}>刷新数据</button>
        </div>
      </div>

      <AdminTabs
        active={tab}
        onChange={next => setTab(next as "dispatch" | "manual_quotes" | "disposals")}
        tabs={[
          { id: "dispatch", label: "正常发运与保管处置监控", count: batches.length + storageReqs.length },
          { id: "manual_quotes", label: "非标人工询价与报价", count: manualQuotes.length },
          { id: "disposals", label: "逾期/违禁双人审批处置", count: (d?.cases ?? []).length },
        ]}
      />

      {tab === "dispatch" && (
        <>
          {overview.error && <ErrorBlock error={overview.error} />}
          <Panel title={`客户检后发运与退货批次监控 (${batches.length})`} subtitle="展示全部转寄集运仓、国内快递或退回卖家的出库批次、关联订单、报价支付状态与物流单号。">
            <Table
              headers={["出库批次", "客户", "处置方式", "含实物与原订单", "报价与付款", "状态", "出库运单", "仓库工作台"]}
              rows={batches.map(b => {
                const items: Row[] = b.items ?? [];
                const ships: Row[] = b.shipments ?? [];
                return [
                  <strong key="id" className="code nowrap">#{String(b.id).slice(0, 8)}</strong>,
                  <span key="c" className="code nowrap">{b.receiving_code ?? "—"}</span>,
                  DISPOSITION_ACTION_ZH[b.action] ?? b.action,
                  <div key="it" className="cell-stack">
                    <span>{items.length} 件实物</span>
                    <small>{[...new Set(items.map(i => i.order_no).filter(Boolean))].join(", ") || "—"}</small>
                  </div>,
                  b.financial_restricted
                    ? <span key="f" className="muted">仅财务/超管可见</span>
                    : (
                      <div key="f" className="cell-stack">
                        <span>{b.amount_cents != null ? <Money cents={b.amount_cents} align="left" /> : "待称重计价"}</span>
                        <small>{b.paid ? "已付款" : b.quote_id ? `截止 ${stamp(b.expires_at, true)}` : "尚未报价"}</small>
                      </div>
                    ),
                  <BizTag key="st" dict={BATCH_STATE_ZH} value={b.state} />,
                  <div key="sh" className="cell-stack">
                    {ships.length > 0
                      ? ships.map(sh => sh.tracking_norm ? <CodeButton key={sh.id} code={sh.tracking_norm} onClick={() => setDrawer({ kind: "tracking", ref: sh.tracking_norm })} /> : <span key={sh.id}>已打包待填单</span>)
                      : <span className="muted">未打包</span>}
                  </div>,
                  canOpenDispatch
                    ? <Link key="go" className="button sm nowrap" href={`/wh/dispatch/${b.id}`}>打开出库详情 →</Link>
                    : <span key="go" className="muted small">仓库出库权限受限</span>,
                ];
              })}
              empty="暂无客户提交的发运或退回卖家批次。"
            />
          </Panel>

          <Panel title={`延长保管申请与付费记录 (${storageReqs.length})`}>
            <Table
              headers={["实物编码", "客户码", "申请状态", "申请延长期限", "保管报价", "支付状态", "当前保管到期"]}
              rows={storageReqs.map(sr => [
                <CodeButton key="it" code={sr.item_code} onClick={() => setDrawer({ kind: "item", ref: sr.item_code })} />,
                <span key="c" className="code">{sr.receiving_code ?? "—"}</span>,
                <Tag key="st">{sr.state}</Tag>,
                sr.return_info?.days ? `${sr.return_info.days} 天` : "—",
                sr.amount_cents != null ? <Money key="a" cents={sr.amount_cents} /> : "待报价",
                sr.paid ? <Tag key="p" tone="green">已付款延展</Tag> : <Tag key="p" tone="yellow">待确认/付款</Tag>,
                stamp(sr.storage_until, true),
              ])}
              empty="暂无客户提交的延期仓储处置请求。"
            />
          </Panel>
        </>
      )}

      {tab === "manual_quotes" && (
        <Panel title={`待核定与已发出人工报价 (${manualQuotes.length})`} subtitle="人工审核客户提交的超规/多件非标委托，下发版本化锁定报价供客户确认付款（历史已确认报价不受后续改价影响）。">
          {quoteNotice && <StatusBanner tone="success" title="报价已下发">{quoteNotice}</StatusBanner>}
          {manualQuotes.length === 0 ? (
            <EmptyState title="当前没有待处理的人工询价" description="当客户提交超常规数量或非标类目询价单时，请求会自动进入本队列。" />
          ) : (
            manualQuotes.map(q => (
              <div className="card" key={q.id} style={{ marginBottom: 14 }}>
                <div className="row between flexwrap" style={{ marginBottom: 10 }}>
                  <div className="actions">
                    <Link className="code" href={`/admin/orders/${q.public_no}`}><strong>{q.public_no}</strong></Link>
                    {q.receiving_code && <Link className="code" href={`/admin/customers/${q.customer_user_id}`}>{q.receiving_code}</Link>}
                    <Tag tone={q.state === "offered" ? "blue" : "yellow"}>{q.state === "offered" ? "已发出报价待客户付款" : "待运营核价"}</Tag>
                    <small className="muted">客户：{q.customer_email ?? "—"} · 截止：{stamp(q.due_at, true)}</small>
                  </div>
                  <Link className="button sm" href={`/admin/orders/${q.public_no}`}>打开订单完整信息 →</Link>
                </div>
                <p className="muted" style={{ marginBottom: 8 }}><strong>询价依据与范围说明：</strong>{q.reason}</p>
                <div className="actions" style={{ marginBottom: 10 }}>
                  {(q.lines ?? []).map((line: Row) => (
                    <Tag key={line.id} tone="outline">{line.title} × {line.quantity} 件 ({line.sku_count} SKU 组)</Tag>
                  ))}
                  {q.offered_amount_cents != null && (
                    <Tag tone="green">当前已报 <Money cents={q.offered_amount_cents} align="left" /> · 有效至 {stamp(q.offered_expires_at, true)}</Tag>
                  )}
                </div>
                {(!q.assignee_id || !actor?.id || q.assignee_id === actor.id) ? (
                  <Form
                    label={q.state === "offered" ? "更新人工报价版本" : "下发正式人工报价"}
                    run={async fields => {
                      if (!resolvedTerms.length) throw new Error("尚未读取到有效条款版本，请刷新页面后重试。");
                      const lines = (q.lines ?? []).map((line: Row) => {
                        const val = Number(text(fields, `${line.id}_amount`));
                        const days = Number(text(fields, `${line.id}_days`));
                        if (!Number.isFinite(val) || val < 0) throw new Error("请输入合法的美元金额。");
                        if (!Number.isInteger(days) || days < 1) throw new Error("承诺工作日须为至少 1 天的整数。");
                        return { order_line_id: line.id, amount_cents: Math.round(val * 100), business_days: days };
                      });
                      const expiryRaw = text(fields, "expiry");
                      const res = await request(`/staff/orders/${q.order_id}/quotes`, "POST", {
                        revision: Number(q.revision ?? 1),
                        lines,
                        reason: text(fields, "reason"),
                        expires_at: new Date(expiryRaw).toISOString(),
                        terms_version_ids: resolvedTerms.map((t: Row) => t.id),
                      });
                      setQuoteNotice(`已为订单 ${q.public_no} 生成报价版本 v${res.revision ?? ""}（有效期内锁定，不可静默覆盖）。`);
                      overview.reload();
                      reloadDesk();
                    }}
                  >
                    {(q.lines ?? []).map((line: Row) => (
                      <div key={line.id} className="inline-form">
                        <Field name={`${line.id}_amount`} label={`${line.title} (${line.quantity}件) 合计 USD`} type="number" step="0.01" min={0} />
                        <Field name={`${line.id}_days`} label="承诺工作日" type="number" min={1} max={180} value={5} />
                      </div>
                    ))}
                    <div className="inline-form">
                      <Field name="expiry" label="报价到期时间" type="datetime-local" value={defaultExpiry} />
                      <Field name="reason" label="报价构成说明与 SLA 备注" />
                    </div>
                  </Form>
                ) : (
                  <StatusBanner tone="info" title="当前询价已分配给其他处理人">
                    负责人：{q.assignee_name ?? q.assignee_id}，避免并发重复报价。
                  </StatusBanner>
                )}
              </div>
            ))
          )}
        </Panel>
      )}

      {tab === "disposals" && (
        <>
          {disposals.error && <ErrorBlock error={disposals.error} />}
          {d && (
            <>
              <div className="row between flexwrap" style={{ marginBottom: 14, padding: "12px 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 10 }}>
                <div>
                  <strong>生产物理处置执行门禁：</strong>
                  <Tag tone={prodEnabled ? "green" : "yellow"}>{prodEnabled ? "已开启物理处置执行" : "默认关闭（仅预演立项与审批）"}</Tag>
                  <span className="muted"> · 逾期在库 {d.overdue_items.length} 件 · 违禁隔离 {d.restricted_items.length} 件</span>
                </div>
                <button type="button" className="button sm" onClick={() => setSwitchOpen(true)}>
                  {prodEnabled ? "关闭生产处置执行开关" : "开启生产处置执行开关"}
                </button>
              </div>

              <Panel title={`01 / 特殊处置审批单队列 (${(d.cases ?? []).length})`} subtitle="每张处置单须经独立复核人审批，且点击进入完整审批详情台核验清单快照（list_hash）、通知取证与现场销毁证据。">
                <Table
                  headers={["处置单号", "客户码", "审批状态", "涉及实物", "清单摘要哈希", "条款版本", "申请人 / 审批人", "详细审批"]}
                  rows={(d.cases ?? []).map((c: Row) => {
                    const auth = c.authorization_snapshot ?? {};
                    const pol = c.policy_snapshot ?? {};
                    const codes: string[] = c.item_codes ?? [];
                    return [
                      <Link key="id" href={`/admin/disposals/${c.id}`}><strong className="code">DSP-{String(c.id).replace(/-/g, "").slice(0, 8).toUpperCase()}</strong></Link>,
                      <span key="rc" className="code">{c.receiving_code ?? "未归属组织"}</span>,
                      <BizTag key="st" dict={DISPOSAL_STATE_ZH} value={c.state} />,
                      <div key="it" className="actions">
                        <span>{codes.length || (c.item_ids ?? []).length} 件</span>
                        {codes.slice(0, 3).map(cd => <CodeButton key={cd} code={cd} onClick={() => setDrawer({ kind: "item", ref: cd })} />)}
                      </div>,
                      <code key="hash" className="code">{(auth.list_hash ?? pol.list_hash ?? "").slice(0, 12)}</code>,
                      pol.legal_basis_version ?? pol.legal_basis ?? "TOS-2026-V2",
                      <span>{c.approved_by ? "已完成独立审批" : "待独立审批"}</span>,
                      <Link key="go" className="button sm primary nowrap" href={`/admin/disposals/${c.id}`}>进入审批详情 →</Link>,
                    ];
                  })}
                  empty="暂无逾期或违禁隔离特殊处置单。"
                />
              </Panel>

              <Panel title={`02 / 勾选逾期或隔离在库实物立项 (已选 ${selectedIds.length} 件)`}>
                <Table
                  headers={["选择", "实物编码", "来源包裹 / 客户", "触发规则与保管截止", "当前库位"]}
                  rows={candidates.map((it: Row) => {
                    const inCase = activeCaseItemIds.has(it.id);
                    const itemOrgKey = it.org_id ?? "__unassigned__";
                    const orgMismatch = Boolean(lockedOrgKey && lockedOrgKey !== itemOrgKey && !selectedIds.includes(it.id));
                    return [
                      <input
                        key={it.id}
                        type="checkbox"
                        checked={selectedIds.includes(it.id)}
                        disabled={inCase || orgMismatch}
                        title={inCase ? "已在处置单中" : orgMismatch ? "同一处置单仅限同一客户组织实物" : "选择该实物"}
                        onChange={() => setSelectedIds(prev => prev.includes(it.id) ? prev.filter(x => x !== it.id) : [...prev, it.id])}
                      />,
                      <CodeButton key="code" code={it.code} onClick={() => setDrawer({ kind: "item", ref: it.code })} />,
                      <div key="pkg" className="cell-stack">
                        {it.package_code ? <CodeButton code={it.package_code} onClick={() => setDrawer({ kind: "package", ref: it.package_code })} /> : "—"}
                        <small>{it.receiving_code ?? "未绑定客户"}</small>
                      </div>,
                      <div key="due" className="cell-stack">
                        <div className="actions">
                          {it.quarantined && <Tag tone="red">违禁隔离件</Tag>}
                          {it.overdue && <Tag tone="yellow">保管逾期</Tag>}
                          {inCase && <Tag tone="outline">已立项</Tag>}
                        </div>
                        <small>免费保管截止：{stamp(it.storage_until, true)}</small>
                      </div>,
                      it.location_code ?? "—",
                    ];
                  })}
                  empty="当前仓库中无保管逾期或违禁隔离的待处置实物。"
                />
                {selectedIds.length > 0 && (
                  <Form label={`为已选 ${selectedIds.length} 件实物创建特殊处置审批单`} run={async f => {
                    await request("/staff/disposals", "POST", {
                      ...(firstSelected?.org_id ? { org_id: firstSelected.org_id } : {}),
                      item_ids: selectedIds,
                      reason: text(f, "reason"),
                      legal_basis_version: text(f, "legal_basis_version") || "TOS-2026-V2",
                      customer_authorized: checked(f, "customer_authorized"),
                    });
                    setSelectedIds([]);
                    disposals.reload();
                  }}>
                    <div className="fields">
                      <Field label="适用协议条款版本号" name="legal_basis_version" value="TOS-2026-V2" required={false} />
                      <Field label="立项理由与客户通知取证说明" name="reason" />
                    </div>
                    <label className="check"><input type="checkbox" name="customer_authorized" /> 已确认客户书面弃货授权或届满催告留证完备</label>
                  </Form>
                )}
              </Panel>
            </>
          )}

          <ModalDrawer
            open={switchOpen}
            onClose={() => setSwitchOpen(false)}
            centered
            title={prodEnabled ? "关闭生产处置执行门禁" : "开启生产处置执行门禁"}
            subtitle="物理销毁/变卖属于不可逆高危操作，须核验正式协议条款版本与审计原因。"
          >
            <Form label={prodEnabled ? "确认关闭执行开关" : "确认开启执行开关"} run={async f => {
              await request("/staff/admin/disposal-execution-switch", "POST", {
                enabled: !prodEnabled,
                legal_basis_version: text(f, "legal_basis_version") || "TOS-2026-V2",
                reason: text(f, "reason"),
              });
              setSwitchOpen(false);
              disposals.reload();
            }}>
              <Field label="正式条款版本号" name="legal_basis_version" value="TOS-2026-V2" />
              <Field label="审计原因" name="reason" value={prodEnabled ? "临时关闭生产物理处置执行开关" : "法务条款与通知留证已就绪，开启物理处置执行"} />
            </Form>
          </ModalDrawer>
        </>
      )}

      <StaffObjectDrawer target={drawer} actor={actor} onClose={() => setDrawer(null)} />
    </>
  );
}

export function AdminDisposalDetail({ id, actor }: { id: string; actor?: Row }) {
  const { data, error, reload } = useLoad(`/staff/admin/disposals/${id}`);
  const [drawer, setDrawer] = useState<StaffObjectTarget | null>(null);
  const [notice, setNotice] = useState("");
  const dc = data?.case;
  const auth = dc?.authorization_snapshot ?? {};
  const pol = dc?.policy_snapshot ?? {};
  const listHash = auth.list_hash ?? pol.list_hash ?? "";
  const execMediaIds: string[] = dc?.execution_evidence?.media_ids ?? [];

  return (
    <>
      <div className="page-head row">
        <div>
          <Link href="/admin/dispositions">← 返回处置与报价工作台</Link>
          <h1 style={{ marginTop: 6 }}>特殊处置单详情 · <span className="code">{dc?.display_ref ?? `#${id.slice(0, 8)}`}</span></h1>
          {dc && (
            <div className="actions" style={{ marginTop: 6 }}>
              <BizTag dict={DISPOSAL_STATE_ZH} value={dc.state} />
              <Tag tone={dc.production_execution_enabled ? "green" : "yellow"}>
                {dc.production_execution_enabled ? "生产物理处置开关：已开启" : "生产物理处置开关：关闭"}
              </Tag>
            </div>
          )}
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新处置单</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在加载处置单详情与快照…</p>}

      {data && dc && (
        <>
          {notice && <StatusBanner tone="success" title="处置状态更新">{notice}</StatusBanner>}

          <div className="admin-split-detail">
            <div className="admin-detail-main">
              <Panel title="立项规则依据、客户归属与不可变清单快照">
                <dl className="admin-kv-grid">
                  <div className="admin-kv-item"><dt>处置单 UUID</dt><dd><CopyId value={dc.id} /></dd></div>
                  <div className="admin-kv-item"><dt>所属客户</dt><dd>{data.customer?.user_id ? <Link className="code" href={`/admin/customers/${data.customer.user_id}`}>{data.customer.receiving_code} ({data.customer.email})</Link> : "未绑定客户/无主品"}</dd></div>
                  <div className="admin-kv-item"><dt>适用协议条款版本</dt><dd>{pol.legal_basis_version ?? pol.legal_basis ?? "TOS-2026-V2"}</dd></div>
                  <div className="admin-kv-item"><dt>清单快照哈希 (list_hash)</dt><dd><CopyId value={listHash} /></dd></div>
                  <div className="admin-kv-item"><dt>立项发起人</dt><dd>{dc.requested_by_name ?? dc.requested_by}</dd></div>
                  <div className="admin-kv-item"><dt>独立审批人</dt><dd>{dc.approved_by_name ?? "待独立审批"}</dd></div>
                  <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}><dt>立项说明与客户催告依据</dt><dd>{pol.reason ?? auth.reason ?? "—"}</dd></div>
                </dl>
              </Panel>

              <Panel title={`涉及在库/隔离实物清单 (${(data.items ?? []).length})`}>
                <Table
                  headers={["实物编号", "关联订单", "来源包裹 / 运单", "当前库位", "保管与核身状态", "保管到期"]}
                  rows={(data.items ?? []).map((it: Row) => [
                    <CodeButton key="c" code={it.code} onClick={() => setDrawer({ kind: "item", ref: it.code })} />,
                    it.order_no ? <Link key="o" className="code" href={`/admin/orders/${it.order_no}`}>{it.order_no}</Link> : "未绑单",
                    `${it.package_code}${it.tracking_norm ? ` · ${it.tracking_norm}` : ""}`,
                    it.location_code ?? "已出库/已处置",
                    <WarehouseItemLifecycleTags key="id" item={it} compact />,
                    stamp(it.storage_until, true),
                  ])}
                />
              </Panel>

              <Panel title="审批、执行证据与审计历史">
                {execMediaIds.length > 0 && (
                  <div className="actions" style={{ marginBottom: 10 }}>
                    <MediaButton ids={execMediaIds} label={`查看现场销毁/交接照片 (${execMediaIds.length})`} />
                  </div>
                )}
                {dc.execution_evidence && (
                  <div className="notice" style={{ marginBottom: 12 }}>
                    <strong>执行档案：</strong>方式 {dc.execution_evidence.method} · 现场见证人记录：{dc.execution_evidence.witness_note ?? dc.execution_evidence.execution_note ?? "—"}
                  </div>
                )}
                <Table
                  headers={["时间", "操作人", "动作", "详情"]}
                  rows={(data.audit_events ?? []).map((a: Row) => [
                    stamp(a.at, true),
                    a.actor_name ?? "员工",
                    AUDIT_ACTION_ZH[a.action] ?? a.action,
                    a.after?.reason ?? a.after?.method ?? "—",
                  ])}
                  empty="暂无审计记录。"
                />
              </Panel>
            </div>

            <div className="admin-detail-side">
              <Panel title="双人审批与受控执行" subtitle="强制职责分离：立项创建人禁止自审批；物理销毁须在生产执行门禁开启后记录现场见证。">
                {dc.state === "pending_approval" && (
                  dc.can_approve_sod ? (
                    <Form label="独立审批通过并锁定清单快照" run={async f => {
                      await request(`/staff/disposals/${dc.id}/approve`, "POST", {
                        revision: dc.revision,
                        list_hash: listHash,
                        reason: text(f, "reason"),
                      });
                      setNotice("已完成独立审批通过，待授权执行归档。");
                      reload();
                    }}>
                      <Field label="独立审批意见与核验依据" name="reason" value="独立复核逾期/隔离件清单与催告记录一致，批准处置" />
                    </Form>
                  ) : (
                    <StatusBanner tone="warning" title="等待其他独立复核人审批">
                      当前账号为立项发起人或缺少审批角色权限，按双人职责分离规则不可自审。
                    </StatusBanner>
                  )
                )}

                {dc.state === "approved" && (
                  dc.production_execution_enabled ? (
                    <Form label="登记完成物理处置并归档" run={async f => {
                      const file = f.get("photo");
                      const mediaIds: string[] = [];
                      if (file instanceof File && file.size > 0) mediaIds.push(await upload(file, "attachment"));
                      await request(`/staff/disposals/${dc.id}/execute`, "POST", {
                        revision: dc.revision,
                        method: text(f, "method") || "destroy",
                        witness_note: text(f, "witness_note"),
                        execution_note: text(f, "witness_note"),
                        ...(mediaIds.length ? { media_ids: mediaIds } : {}),
                      });
                      setNotice("已完成物理处置归档并同步更新实物保管状态。");
                      reload();
                    }}>
                      <Select label="物理处置方式" name="method" value="destroy" choices={[
                        { id: "destroy", label: "集中销毁 (destroy)" },
                        { id: "liquidate", label: "合规变卖折抵 (liquidate)" },
                        { id: "donate", label: "公益捐赠 (donate)" },
                      ]} />
                      <Field label="双人现场见证记录" name="witness_note" value="仓库主管与复核人现场核对清单并完成处置" />
                      <Field label="现场处置照片（可选）" name="photo" type="file" required={false} />
                    </Form>
                  ) : (
                    <StatusBanner tone="warning" title="生产执行门禁尚未开启">
                      处置单已批准，但系统级「生产处置执行门禁」当前处于关闭状态。请在「处置与报价」页签开启开关后执行。
                    </StatusBanner>
                  )
                )}

                {dc.state === "executed" && (
                  <p className="ok"><strong>该特殊处置单已执行归档完毕，无法重复执行。</strong></p>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}

      <StaffObjectDrawer target={drawer} actor={actor} onClose={() => setDrawer(null)} />
    </>
  );
}

const stocktakeZones: Record<string, string> = {
  receiving: "收货区", queue: "待检区", inspecting: "检查区", post_inspection: "检后区",
  reference: "确认样区", unmatched: "未认领区", quarantine: "隔离区",
};

export function AdminIncidentsWorkbench({ actor }: { actor?: Row }) {
  const [tab, setTab] = useState<"incidents" | "create" | "stocktakes">("incidents");
  const canSeeStocktakes = Boolean(!actor?.roles || actor.roles.some((r: string) => ["receiver", "warehouse_admin", "super_admin"].includes(r)));
  const canApproveStocktake = Boolean(actor?.roles?.some((r: string) => ["warehouse_admin", "super_admin"].includes(r)));
  const canCreateIncident = Boolean(!actor?.roles || actor.roles.some((r: string) => ["receiver", "warehouse_admin", "support", "super_admin"].includes(r)));
  const incidents = useLoad("/staff/incidents");
  const stocktakes = useLoad(canSeeStocktakes ? "/staff/stocktakes" : null);
  const [reviewSt, setReviewSt] = useState<Row | null>(null);
  const [drawer, setDrawer] = useState<StaffObjectTarget | null>(null);
  const [notice, setNotice] = useState("");

  const incRows: Row[] = incidents.data?.rows ?? [];
  const eligibleItems: Row[] = incidents.data?.eligible_items ?? [];
  const stRows: Row[] = stocktakes.data?.rows ?? [];

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>库存事故赔付调查与盘点差异复核</h1>
          <p className="muted">集中追踪库内破损、缺失及质检差错事故的调查、双人赔偿审批与打款结案，同时处理盘点提交的库位/数量差异独立复核。</p>
        </div>
        <div className="head-actions">
          {canSeeStocktakes && <Link className="button sm" href="/wh/stocktakes">仓库盘点扫码工作台</Link>}
          <button type="button" className="button sm" onClick={() => { incidents.reload(); if (canSeeStocktakes) stocktakes.reload(); }}>刷新队列</button>
        </div>
      </div>

      <AdminTabs
        active={tab}
        onChange={next => setTab(next as "incidents" | "create" | "stocktakes")}
        tabs={[
          { id: "incidents", label: "库内事故调查与赔付队列", count: incRows.length },
          ...(canCreateIncident ? [{ id: "create", label: "登记新库存事故" }] : []),
          ...(canSeeStocktakes ? [{ id: "stocktakes", label: "盘点差异独立复核", count: stRows.filter(s => s.state === "submitted").length }] : []),
        ]}
      />

      {notice && <StatusBanner tone="success" title="操作已保存">{notice}</StatusBanner>}
      {incidents.error && <ErrorBlock error={incidents.error} />}
      {stocktakes.error && <ErrorBlock error={stocktakes.error} />}

      {tab === "incidents" && (
        <Panel title={`库内事故队列 (${incRows.length})`} subtitle="禁止仅靠弹窗草草结案：每起事故均须进入详情工作台核验实物历程、照片证据与双人赔付审批。">
          <Table
            headers={["事故编号", "类型", "关联实物", "所属订单", "处理状态", "退服务费 / 货值赔付", "证据 / 打款水单", "详情工作台"]}
            rows={incRows.map(inc => {
              const evIds: string[] = inc.evidence?.media_ids ?? [];
              const proofIds: string[] = inc.payment_proof?.proof_media_ids ?? [];
              return [
                <Link key="id" href={`/admin/incidents/${inc.id}`}><strong className="code nowrap">{inc.ticket_no}</strong></Link>,
                INCIDENT_KIND_ZH[inc.resolution?.kind] ?? inc.resolution?.kind ?? "—",
                <CodeButton key="it" code={inc.item_code} onClick={() => setDrawer({ kind: "item", ref: inc.item_code })} />,
                inc.order_no ? <Link key="o" className="code nowrap" href={`/admin/orders/${inc.order_no}`}>{inc.order_no}</Link> : "未关联订单",
                <BizTag key="st" dict={INCIDENT_STATE_ZH} value={inc.state} />,
                inc.resolution?.financial_restricted
                  ? <span key="fin" className="muted">仅财务/超管可见</span>
                  : (
                    <div key="fin" className="cell-stack">
                      <span>退费 <Money cents={inc.resolution?.service_refund_cents ?? 0} align="left" /> · 赔货 <Money cents={inc.resolution?.compensation_cents ?? 0} align="left" /></span>
                      <small>{inc.payment_proof ? `已打款 (${inc.payment_proof.payout_reference ?? "已核销"})` : "待确认/待打款"}</small>
                    </div>
                  ),
                <div key="ev" className="actions">
                  {evIds.length > 0 && <MediaButton ids={evIds} label={`事故照 (${evIds.length})`} />}
                  {proofIds.length > 0 && <MediaButton ids={proofIds} label={`水单 (${proofIds.length})`} />}
                  {!evIds.length && !proofIds.length && <span className="muted">—</span>}
                </div>,
                <Link key="go" className="button sm primary nowrap" href={`/admin/incidents/${inc.id}`}>进入事故工作台 →</Link>,
              ];
            })}
            empty="当前没有库内丢失、破损或重大差错事故记录。"
          />
        </Panel>
      )}

      {tab === "create" && (
        <Panel title="立项登记新库内异常事故" subtitle="登记后会自动冻结相关订单发运并生成客户可见纠纷工单。">
          <Form label="立项登记库存事故" run={async f => {
            const file = f.get("evidence_photo");
            const evidenceIds: string[] = [];
            if (file instanceof File && file.size > 0) evidenceIds.push(await upload(file, "attachment"));
            const res = await request("/staff/incidents", "POST", {
              item_code: text(f, "item_code").toUpperCase(),
              kind: text(f, "kind"),
              summary_en: text(f, "summary_en"),
              ...(text(f, "internal_note") ? { internal_note: text(f, "internal_note") } : {}),
              ...(evidenceIds.length ? { evidence_ids: evidenceIds } : {}),
            });
            setNotice(`已立项事故 ${res.ticket_no}，请前往详情工作台进一步调查并拟定赔偿方案。`);
            incidents.reload();
            setTab("incidents");
          }}>
            <div className="fields">
              <label>
                关联实物编码（支持扫码或搜索）
                <input name="item_code" list="admin-incident-eligible-items" placeholder="例如 S-1001" required />
              </label>
              <datalist id="admin-incident-eligible-items">
                {eligibleItems.map(it => <option key={it.id} value={it.code}>{`${it.receiving_code ?? "—"} · ${it.order_no ?? "未委托"} · ${it.custody_state}`}</option>)}
              </datalist>
              <Select label="事故类型" name="kind" choices={[
                { id: "loss", label: "库内缺失 (loss)" },
                { id: "damage", label: "库内物理破损 (damage)" },
                { id: "wrong_inspection", label: "质检重大差错 (wrong_inspection)" },
              ]} />
            </div>
            <Field label="对客英文说明与客观事实摘要 (English)" name="summary_en" />
            <Field label="内部交接调查备注（仅员工可见，可选）" name="internal_note" required={false} />
            <Field label="现场破损/异常照片证据（强烈建议上传）" name="evidence_photo" type="file" required={false} />
          </Form>
        </Panel>
      )}

      {tab === "stocktakes" && canSeeStocktakes && (
        <Panel title={`盘点差异独立复核队列 (${stRows.length})`} subtitle="明确区分原始发现差异、已批准调整与当前冻结调查项；缺失调账后实物仍冻结于库内事故流，严禁直接洗白。">
          <Table
            headers={["盘点编号", "盘点范围", "状态", "总数 / 原差异 / 已调账 / 待决", "快照与审批人", "独立主管复核"]}
            rows={stRows.map(st => {
              const items: Row[] = st.items ?? [];
              const origDisc = st.original_discrepancy_count ?? items.filter(i => i.state === "investigating" || i.state === "adjusted" || Boolean(i.adjustment_id)).length;
              const adjCount = st.approved_adjustment_count ?? items.filter(i => i.state === "adjusted" || Boolean(i.approved_by)).length;
              const openDisc = items.filter(i => i.state === "investigating" || i.state === "recount_required").length;
              const isSelf = Boolean(actor?.id && (st.operator_id === actor.id || items.some(i => i.requested_by === actor.id)));
              return [
                <strong key="id" className="code">#{String(st.id).slice(0, 8)}</strong>,
                st.scope?.zone ? `仓区：${stocktakeZones[st.scope.zone] ?? st.scope.zone}` : "全仓范围",
                <BizTag key="st" dict={STOCKTAKE_STATE_ZH} value={st.state} />,
                `${items.length} 件 · 原始差异 ${origDisc} · 已调账 ${adjCount} · 待决 ${openDisc}`,
                <div key="tm" className="cell-stack">
                  <span>{stamp(st.snapshot_at, true)}</span>
                  <small className="muted">发起 {st.operator_name ?? "—"}{st.approved_by_name ? ` / 批 ${st.approved_by_name}` : ""}</small>
                </div>,
                st.state === "submitted"
                  ? (canApproveStocktake && !isSelf
                    ? <button key="act" type="button" className="button sm primary" onClick={() => setReviewSt(st)}>复核差异 ({openDisc})</button>
                    : <span key="act" className="muted small">{isSelf ? "发起人不可自审" : "仅主管/超管可批"}</span>)
                  : "已结案 / 作业中",
              ];
            })}
            empty="暂无仓库盘点记录。"
          />
        </Panel>
      )}

      <ModalDrawer
        open={Boolean(reviewSt)}
        onClose={() => setReviewSt(null)}
        wide
        title={reviewSt ? `复核盘点差异 · #${String(reviewSt.id).slice(0, 8)}` : ""}
        subtitle="核对以下全部盘点差异实物及调整前后位置后，决定批准库存调整或退回现场重新盘点（禁止创建人自审）。"
      >
        {reviewSt && (
          <>
            <Panel title="待复核差异实物清单">
              <Table
                headers={["实物码", "订单 / 客户", "原快照库位", "实盘库位 / 拟调整", "差异说明"]}
                rows={(reviewSt.items ?? []).filter((i: Row) => i.state === "investigating" || i.adjustment_id).map((i: Row) => [
                  <CodeButton key={i.id} code={i.item_code} onClick={() => setDrawer({ kind: "item", ref: i.item_code })} />,
                  <div key="o" className="cell-stack"><span>{i.receiving_code ?? "—"}</span>{i.order_no && <small className="code">{i.order_no}</small>}</div>,
                  <span key="ex" className="code">{i.expected_location_code ?? "—"}</span>,
                  <span key="ac" className="code">{i.actual_location_code ?? "确认缺失（入事故冻结）"}</span>,
                  i.adjustment_reason || "—",
                ])}
                empty="无差异条目。"
              />
            </Panel>
            <Form label="提交复核决定" run={async f => {
              await request(`/staff/stocktakes/${reviewSt.id}/approve`, "POST", {
                decision: text(f, "decision"),
                reason: text(f, "reason"),
              });
              setReviewSt(null);
              setNotice("已提交盘点差异独立复核结论。");
              stocktakes.reload();
            }}>
              <Select label="复核决定" name="decision" value="approve" choices={[
                { id: "approve", label: "批准差异调账并结案 (approve)" },
                { id: "recount", label: "退回要求现场重新复盘 (recount)" },
              ]} />
              <Field label="复核核验依据" name="reason" value="主管核对监控与库位记录后确认盘点结果" />
            </Form>
          </>
        )}
      </ModalDrawer>

      <StaffObjectDrawer target={drawer} actor={actor} onClose={() => setDrawer(null)} />
    </>
  );
}

export function AdminIncidentDetail({ id, actor }: { id: string; actor: Row }) {
  const { data, error, reload } = useLoad(`/staff/admin/incidents/${id}`);
  const [srvUsd, setSrvUsd] = useState("0.00");
  const [compUsd, setCompUsd] = useState("20.00");
  const [notice, setNotice] = useState("");
  const [drawer, setDrawer] = useState<StaffObjectTarget | null>(null);

  const inc = data?.incident;
  const cust = data?.customer;
  const item = data?.item;
  const res = inc?.resolution ?? {};
  const canFinance = hasStaffAccess(actor.roles ?? [], ["finance", "super_admin"]);
  const canPropose = hasStaffAccess(actor.roles ?? [], ["warehouse_admin", "support", "finance", "super_admin"]);

  return (
    <>
      <div className="page-head row">
        <div>
          <Link href="/admin/incidents">← 返回库存事故列表</Link>
          <h1 style={{ marginTop: 6 }}>事故调查与赔偿工作台 · <span className="code">{inc?.ticket_no ?? `#${id.slice(0, 8)}`}</span></h1>
          {inc && (
            <div className="actions" style={{ marginTop: 6 }}>
              <BizTag dict={INCIDENT_STATE_ZH} value={inc.state} />
              <Tag tone="outline">{INCIDENT_KIND_ZH[res.kind] ?? res.kind ?? "库内事故"}</Tag>
              {inc.ticket_id && <Link className="button sm" href={`/admin/tickets/${inc.ticket_id}`}>查看客户纠纷工单 {inc.ticket_no}</Link>}
            </div>
          )}
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新事故全貌</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在加载事故调查档案与赔偿核验上下文…</p>}

      {data && inc && (
        <>
          {notice && <StatusBanner tone="success" title="事故处理推进">{notice}</StatusBanner>}

          <div className="admin-split-detail">
            <div className="admin-detail-main">
              <Panel title="1. 关联客户、订单、包裹及实物档案">
                <dl className="admin-kv-grid">
                  <div className="admin-kv-item"><dt>所属客户</dt><dd>{cust?.user_id ? <Link className="code" href={`/admin/customers/${cust.user_id}`}>{cust.receiving_code} ({cust.email})</Link> : "—"}</dd></div>
                  <div className="admin-kv-item"><dt>关联订单</dt><dd>{item?.order_no ? <Link className="code" href={`/admin/orders/${item.order_no}`}>{item.order_no}</Link> : "未委托件"}</dd></div>
                  <div className="admin-kv-item"><dt>涉事唯一实物编号</dt><dd><CodeButton code={item?.code} onClick={() => setDrawer({ kind: "item", ref: item.code })} /></dd></div>
                  <div className="admin-kv-item"><dt>来源包裹 / 入库运单</dt><dd>{item?.package_code}{item?.inbound_tracking_norm ? ` · ${item.inbound_tracking_norm}` : ""}</dd></div>
                  <div className="admin-kv-item"><dt>当前库位 / 保管状态</dt><dd className="actions"><span>{item?.location_code ?? "—"}</span>{item && <WarehouseItemLifecycleTags item={item} compact />}</dd></div>
                  <div className="admin-kv-item"><dt>立项发起人员</dt><dd>{inc.created_by_name ?? "—"} ({stamp(inc.created_at, true)})</dd></div>
                  <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}><dt>对客英文事故说明</dt><dd>{res.summary_en || inc.ticket_subject}</dd></div>
                </dl>

                <div className="actions" style={{ marginTop: 12 }}>
                  {(inc.evidence_ids ?? []).length > 0 && <MediaButton ids={inc.evidence_ids} label={`查看事故现场照片 (${inc.evidence_ids.length})`} />}
                  {(inc.payment_proof?.proof_media_ids ?? []).length > 0 && <MediaButton ids={inc.payment_proof.proof_media_ids} label="查看赔偿打款水单" />}
                </div>
              </Panel>

              <Panel title="2. 涉事物理实物库位移动历史与工单沟通记录">
                <div className="ops-columns">
                  <div>
                    <h3 style={{ marginTop: 0 }}>库内移动流转历史</h3>
                    <Table
                      headers={["时间", "动作", "原库位 → 目标库位", "操作员"]}
                      rows={(data.storage_events ?? []).map((ev: Row) => [
                        stamp(ev.created_at, true),
                        ev.action,
                        `${ev.from_location ?? "—"} → ${ev.to_location ?? "—"}`,
                        ev.operator_name ?? "—",
                      ])}
                      empty="暂无移库历史记录。"
                    />
                  </div>
                  <div>
                    <h3 style={{ marginTop: 0 }}>调查与沟通记录</h3>
                    {(data.ticket_events ?? []).length === 0 ? <Empty>暂无工单对话。</Empty> : (
                      <ol className="timeline">
                        {(data.ticket_events as Row[]).map(ev => (
                          <li key={ev.id}>
                            <div className="row" style={{ gap: 8 }}>
                              <strong>{ev.kind === "internal_note" ? "内部调查备注" : ev.actor_type === "customer" ? "客户回应" : "平台通知"}</strong>
                              <small className="muted">{ev.actor_name ?? ""} · {stamp(ev.created_at, true)}</small>
                            </div>
                            <p style={{ margin: "2px 0 0" }}>{ev.body}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              </Panel>

              <Panel title="3. 事故处置与赔付审计轨迹">
                <Table
                  headers={["时间", "操作人", "业务动作", "结构化变更记录"]}
                  rows={(data.audit_events ?? []).map((a: Row) => [
                    stamp(a.at, true),
                    a.actor_name ?? "系统",
                    AUDIT_ACTION_ZH[a.action] ?? a.action,
                    formatAuditSnapshotSummary(a.after),
                  ])}
                  empty="暂无审计轨迹。"
                />
              </Panel>
            </div>

            <div className="admin-detail-side">
              <Panel title="赔偿方案与资金核验">
                {inc.financial_restricted ? (
                  <EmptyState kind="forbidden" title="金额详情权限隔离" description="仅财务（finance）与超级管理员可查看及审批服务费退回与货值赔付金额。" />
                ) : (
                  <>
                    <dl className="admin-kv-grid" style={{ marginBottom: 12 }}>
                      <div className="admin-kv-item"><dt>拟定人</dt><dd>{inc.proposed_by_name ?? "尚未拟定方案"}</dd></div>
                      <div className="admin-kv-item"><dt>独立审批人</dt><dd>{inc.approved_by_name ?? "待独立审批"}</dd></div>
                      <div className="admin-kv-item"><dt>平台服务费退回</dt><dd><Money cents={res.service_refund_cents ?? 0} align="left" /></dd></div>
                      <div className="admin-kv-item"><dt>货值协商赔付</dt><dd><Money cents={res.compensation_cents ?? 0} align="left" /></dd></div>
                      <div className="admin-kv-item"><dt>原单可退服务费余额</dt><dd>{data.order_refund_capacity ? <Money cents={data.order_refund_capacity.refundable} align="left" /> : "无适用付费单"}</dd></div>
                      <div className="admin-kv-item"><dt>客户确认决定</dt><dd>{res.customer_decision ? `${res.customer_decision} (${res.customer_note ?? "无附言"})` : "待客户确认"}</dd></div>
                    </dl>
                    {res.proposal_summary_en && <p className="muted">方案说明：{res.proposal_summary_en}</p>}
                  </>
                )}

                {canPropose && ["open", "proposed", "customer_rejected"].includes(inc.state) && (
                  <Form label={inc.state === "proposed" ? "修订赔偿方案" : "拟定赔偿方案待独立审批"} run={async f => {
                    const srvCents = Math.round(Number(srvUsd || "0") * 100);
                    const compCents = Math.round(Number(compUsd || "0") * 100);
                    await request(`/staff/incidents/${inc.id}/propose`, "POST", {
                      service_refund_cents: srvCents,
                      compensation_cents: compCents,
                      currency: "USD",
                      summary_en: text(f, "summary_en"),
                      ...(text(f, "internal_note") ? { internal_note: text(f, "internal_note") } : {}),
                    });
                    setNotice("已提交赔偿方案，等待另一位独立财务/超管审批。");
                    reload();
                  }}>
                    <div className="fields">
                      <label>退还服务费 (USD)
                        <input type="number" min={0} step="0.01" value={srvUsd} onChange={e => setSrvUsd(e.target.value)} required />
                      </label>
                      <label>货值赔偿 (USD)
                        <input type="number" min={0} step="0.01" value={compUsd} onChange={e => setCompUsd(e.target.value)} required />
                      </label>
                    </div>
                    <Field label="对客方案说明 (English)" name="summary_en" value={res.proposal_summary_en ?? "We sincerely apologize for the warehouse incident and propose this compensation resolution."} />
                    <Field label="内部审批附注（可选）" name="internal_note" required={false} />
                  </Form>
                )}

                {inc.state === "proposed" && (
                  inc.can_approve_sod ? (
                    <Form label="独立复核并批准发送给客户确认" run={async f => {
                      await request(`/staff/incidents/${inc.id}/approve`, "POST", { reason: text(f, "reason") });
                      setNotice("已独立批准赔偿方案并推送客户工作台确认。");
                      reload();
                    }}>
                      <Field label="独立财务审批依据" name="reason" value="核实责任归属与可退上限无误，批准向客户发起确认" />
                    </Form>
                  ) : (
                    <StatusBanner tone="warning" title="待另一位独立财务/超管审批">
                      方案拟定人与审批人不得为同一员工账号（或当前角色非财务/超管）。
                    </StatusBanner>
                  )
                )}

                {inc.awaiting_customer && (
                  <StatusBanner tone="info" title="等待客户确认">
                    方案已发送至客户 My Workspace 工单页面，须由客户点击接受后方可办理货值赔付打款。
                  </StatusBanner>
                )}

                {inc.state === "awaiting_payout" && canFinance && (
                  <Form label="登记线下/银行赔付打款水单并结案" run={async f => {
                    const file = f.get("proof_photo");
                    const proofIds: string[] = [];
                    if (file instanceof File && file.size > 0) proofIds.push(await upload(file, "attachment"));
                    const payoutRef = text(f, "payout_reference").trim();
                    const compCents = Number(res.compensation_cents ?? 0);
                    if (compCents > 0 && payoutRef.length < 4) {
                      throw new Error("货值赔偿金额大于 $0 时，必须填写至少 4 位的银行/渠道真实打款水单号。");
                    }
                    if (compCents > 0 && proofIds.length === 0 && !checked(f, "verified_without_upload")) {
                      throw new Error("请上传银行打款水单截图，或勾选已核验外部渠道凭证。");
                    }
                    await request(`/staff/incidents/${inc.id}/resolve`, "POST", {
                      payout_reference: payoutRef,
                      payout_method: text(f, "payout_method") || "bank_transfer",
                      paid_amount_cents: compCents,
                      currency: "USD",
                      ...(proofIds.length ? { proof_media_ids: proofIds } : {}),
                      ...(text(f, "note") ? { note: text(f, "note") } : {}),
                    });
                    setNotice("打款凭证已归档，事故单与阻塞已正式结案。");
                    reload();
                  }}>
                    <Field label="外部打款流水号 / 水单编号（必填）" name="payout_reference" />
                    <Select label="打款渠道" name="payout_method" value="bank_transfer" choices={[
                      { id: "bank_transfer", label: "银行转账 (Bank Transfer)" },
                      { id: "wire", label: "跨境电汇 (Wire)" },
                      { id: "paypal", label: "PayPal 企业打款" },
                      { id: "other", label: "其他约定渠道" },
                    ]} />
                    <Field label="银行水单截图（赔偿 > $0 强烈建议上传）" name="proof_photo" type="file" required={false} />
                    <label className="check"><input type="checkbox" name="verified_without_upload" /> 已在财务系统核对打款流水号与收款回执一致</label>
                    <Field label="财务核销备注" name="note" value="已按客户同意方案金额完成货值打款" required={false} />
                  </Form>
                )}

                {inc.state === "resolved" && inc.payment_proof && !inc.financial_restricted && (
                  <div className="notice success">
                    <strong>已赔付结案：</strong>流水号 <code className="code">{inc.payment_proof.payout_reference}</code> · 金额 <Money cents={inc.payment_proof.paid_amount_cents} align="left" /> · {stamp(inc.payment_proof.paid_at, true)}
                  </div>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}

      <StaffObjectDrawer target={drawer} actor={actor} onClose={() => setDrawer(null)} />
    </>
  );
}
