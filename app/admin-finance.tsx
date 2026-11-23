"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Action,
  Empty,
  ErrorBlock,
  Field,
  Form,
  Panel,
  request,
  RequestError,
  stamp,
  Table,
  Tag,
  text,
  upload,
  useLoad,
  type Row,
} from "./ui";
import type { Actor } from "../packages/core/common";
import {
  AdminTabs,
  AUDIT_ACTION_ZH,
  BizTag,
  CopyId,
  EmptyState,
  Money,
  ORDER_STATE_ZH,
  PAYMENT_STATE_ZH,
  PURPOSE_ZH,
  RECON_STATE_ZH,
  REFUND_STATE_ZH,
  SERVICE_CODE_ZH,
  StatusBanner,
  USER_STATUS_ZH,
} from "./admin-labels";

function formatBalanceAmount(amount:number|string,currency:string) {
  const formatter=new Intl.NumberFormat("zh-CN",{style:"currency",currency,currencyDisplay:"code"});
  const decimals=currency==="ISK"||currency==="UGX"?2:formatter.resolvedOptions().maximumFractionDigits??2;
  return formatter.format(Number(amount)/10**decimals);
}

function FinanceSubNav({ active }: { active: "payments" | "refunds" | "finance" }) {
  return (
    <div className="actions" style={{ marginBottom: 14 }}>
      <Link className={`button sm${active === "payments" ? " primary" : ""}`} href="/admin/payments">支付流水与对账</Link>
      <Link className={`button sm${active === "refunds" ? " primary" : ""}`} href="/admin/refunds">退款审批工作台</Link>
      <Link className={`button sm${active === "finance" ? " primary" : ""}`} href="/admin/finance">财务收入与毛利分析</Link>
    </div>
  );
}

const MANUAL_PAYPAL_STATE_ZH: Record<string, { label: string; tone: "green" | "blue" | "yellow" | "red" | "gray" }> = {
  requested: { label: "待开具发票", tone: "yellow" },
  invoice_sent: { label: "已发发票 · 待付款", tone: "blue" },
  receipt_recorded: { label: "已录收款 · 待独立核销", tone: "blue" },
  underpaid: { label: "实收少付 · 阻断激活", tone: "red" },
  overpaid: { label: "实收超付 · 待财务确认", tone: "yellow" },
  verified: { label: "收款已复核", tone: "green" },
  rejected: { label: "核销退回", tone: "red" },
  canceled: { label: "已作废取消", tone: "gray" },
};

export function AdminPaymentsWorkbench({ demo = false, actor }: { demo?: boolean; actor?: Row }) {
  const searchParams = useSearchParams();
  const initTab = searchParams.get("tab") ?? "all";
  const [tab, setTab] = useState(initTab);
  useEffect(() => {
    setTab(searchParams.get("tab") ?? "all");
  }, [searchParams]);
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [purpose, setPurpose] = useState("all");
  const [testMode, setTestMode] = useState("all");
  const [page, setPage] = useState(1);
  const [channelNotice, setChannelNotice] = useState<{ tone: "info" | "success" | "warning" | "error"; text: string }>();
  const [channelError, setChannelError] = useState<string>();
  const [activeManualId, setActiveManualId] = useState<string | null>(null);

  const params = new URLSearchParams({ tab, purpose, test: testMode, page: String(page), limit: "25" });
  if (q) params.set("q", q);
  const { data, error, reload } = useLoad("/staff/admin/payments?" + params.toString());
  const disputes = useLoad("/staff/admin/desk");
  const paypalQueue = useLoad("/staff/finance/paypal-invoices");
  const d = data;
  const counts = d?.counts ?? {};
  const summary = d?.summary ?? {};
  const rows: Row[] = d?.rows ?? [];
  const disputeRows: Row[] = disputes.data?.disputes ?? [];
  const paypalRows: Row[] = paypalQueue.data?.rows ?? [];
  const selectedPaypal = paypalRows.find((r) => r.id === activeManualId) ?? paypalRows.find((r) => r.state !== "canceled" && r.state !== "succeeded") ?? paypalRows[0];

  function reloadAll() {
    reload();
    disputes.reload();
    paypalQueue.reload();
  }

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>支付与渠道对账工作台</h1>
          <p className="muted">统一处理 Stripe HK 与 PayPal Manual Invoice 人工开票/录收款/双人核销/主动对账，所有状态直接展示。</p>
        </div>
        <div className="head-actions">
          <Link className="button sm" href="/admin/integrations/payments">支付渠道设置 →</Link>
          <Action
            sm
            run={async () => {
              setChannelError(undefined);
              try {
                const res = await request("/staff/finance/stripe/reconcile", "POST", {});
                setChannelNotice({
                  tone: res.ok ? "success" : "warning",
                  text: res.configured
                    ? `Stripe 已核查 ${res.checked} 笔，处理 ${res.reconciled} 笔付款事件，${res.still_pending} 笔仍待核对。`
                    : `Stripe 主动对账未执行实时拉取（未配置 Secret Key，待核会话 ${res.checked} 笔）。`,
                });
                reloadAll();
              } catch (e) {
                setChannelError(e instanceof Error ? e.message : "主动对账失败");
              }
            }}
          >
            Stripe 主动对账
          </Action>
          <button type="button" className="button sm" onClick={reloadAll}>刷新数据</button>
        </div>
      </div>

      <FinanceSubNav active="payments" />

      {demo && (
        <StatusBanner tone="warning" title="演示环境账本边界提醒">
          当前运行在本地演示模式（<code>QCW_DEMO=1</code>），标记为 <code>demo_</code> 的交易使用本地模拟结账，PayPal 人工开票与双人核销全程走真实数据库 SoD 约束与统一 <code>applyPayment</code> 激活规则。
        </StatusBanner>
      )}
      {channelNotice && <StatusBanner tone={channelNotice.tone} title="渠道核销结果">{channelNotice.text}</StatusBanner>}
      {channelError && <ErrorBlock error={channelError} />}

      {error && <ErrorBlock error={error} />}

      {d && (
        <div className="metric-strip" aria-label="支付统计概览">
          <div className="metric">
            <span>累计成功收款</span>
            <strong><Money cents={summary.succeeded_cents ?? 0} align="left" /></strong>
            <small>包含已部分/全额退款原收款</small>
          </div>
          <div className="metric">
            <span>已执行成功退款</span>
            <strong><Money cents={summary.refunded_cents ?? 0} align="left" /></strong>
            <small>受原交易可退余额与独立审批约束</small>
          </div>
          <div className="metric">
            <span>待支付 / 确认中</span>
            <strong><Money cents={summary.pending_cents ?? 0} align="left" /></strong>
            <small>尚未收到最终入账确认</small>
          </div>
          <div className="metric">
            <span>对账关注 / 异常笔数</span>
            <strong>{summary.reconciliation_issue_count ?? 0}</strong>
            <small>争议冻结、迟到回调或账目待核销</small>
          </div>
        </div>
      )}

      <AdminTabs
        active={tab}
        onChange={next => { setTab(next); setPage(1); }}
        tabs={[
          { id: "all", label: "全部支付", count: counts.all },
          { id: "pending", label: "待确认 / 处理中", count: counts.pending },
          { id: "succeeded", label: "支付成功", count: counts.succeeded },
          { id: "failed", label: "失败 / 取消", count: counts.failed },
          { id: "refund_related", label: "退款相关", count: counts.refund_related },
          { id: "reconciliation_issues", label: "对账异常 / 争议", count: counts.reconciliation_issues },
        ]}
      />

      <form
        className="admin-toolbar"
        onSubmit={e => {
          e.preventDefault();
          setQ(searchInput.trim());
          setPage(1);
        }}
      >
        <label>
          搜索单号 / 客户 / 渠道凭据
          <input
            type="search"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="PAY-... / QW-... / QCW-... / 邮箱 / cs_..."
          />
        </label>
        <label>
          收费类型
          <select value={purpose} onChange={e => { setPurpose(e.target.value); setPage(1); }}>
            <option value="all">全部用途</option>
            <option value="inspection">质检服务费</option>
            <option value="dispatch">出库/退货运费</option>
            <option value="storage">延期仓储费</option>
          </select>
        </label>
        <label>
          环境范围
          <select value={testMode} onChange={e => { setTestMode(e.target.value); setPage(1); }}>
            <option value="all">全部订单 (含测试单)</option>
            <option value="production">仅正式业务订单</option>
            <option value="test">仅测试订单</option>
          </select>
        </label>
        <div className="actions">
          <button type="submit" className="button primary sm">筛选查询</button>
          <button
            type="button"
            className="button sm"
            onClick={() => { setSearchInput(""); setQ(""); setPurpose("all"); setTestMode("all"); setTab("all"); setPage(1); }}
          >
            重置条件
          </button>
        </div>
      </form>

      <Panel title="支付交易明细" subtitle={`当前视图共 ${d?.total ?? 0} 笔记录（第 ${page} 页）`}>
        {!d && !error && <p role="status">正在加载支付流水…</p>}
        {d && rows.length === 0 && (
          <EmptyState
            kind={q || purpose !== "all" || tab !== "all" ? "filtered" : "empty"}
            title={q || purpose !== "all" || tab !== "all" ? "当前筛选条件下没有支付记录" : "尚无支付交易记录"}
            description={q || purpose !== "all" || tab !== "all"
              ? "请尝试清空关键词、切换全部状态页签或包含测试订单范围。"
              : "客户确认报价并发起结账后，系统会自动记录每笔收费单与支付尝试。"}
            onAction={() => { setSearchInput(""); setQ(""); setPurpose("all"); setTestMode("all"); setTab("all"); setPage(1); }}
            actionLabel="查看全部支付记录"
          />
        )}
        {d && rows.length > 0 && (
          <>
            <Table
              headers={["支付单号", "客户", "关联订单 / 批次", "收费类型", "金额 (USD)", "支付渠道", "支付状态", "退款情况", "对账状态", "付款/创建时间", "操作"]}
              rows={rows.map(r => {
                const orders: Row[] = r.linked_orders ?? [];
                return [
                  <div key="ref" className="cell-stack">
                    <Link href={`/admin/payments/${r.id}`}>
                      <strong className="code nowrap">{r.display_ref}</strong>
                    </Link>
                    {r.is_test && <Tag tone="gray">测试单</Tag>}
                  </div>,
                  <div key="cust" className="cell-stack">
                    {r.customer_user_id ? (
                      <Link href={`/admin/customers/${r.customer_user_id}`}>
                        <strong className="code nowrap">{r.receiving_code ?? "查看客户"}</strong>
                      </Link>
                    ) : <span className="muted">未关联客户</span>}
                    <small>{r.customer_email ?? r.customer_name ?? "—"}</small>
                  </div>,
                  <div key="ord" className="cell-stack">
                    {orders.length > 0
                      ? orders.map(o => <Link key={o.id} className="code nowrap" href={`/admin/orders/${o.public_no}`}>{o.public_no}</Link>)
                      : <span className="muted">{r.purpose === "dispatch" && r.dispatch_batch_id ? "未分摊出库批次" : "未直接绑单"}</span>}
                    {r.dispatch_batch_id && <Link className="small code" href={`/wh/dispatch/${r.dispatch_batch_id}`}>批次 #{String(r.dispatch_batch_id).slice(0, 8)}</Link>}
                  </div>,
                  <div key="purp" className="cell-stack">
                    <span className="nowrap">{PURPOSE_ZH[r.purpose] ?? r.purpose}</span>
                    {r.scope_revision_id && <small>增补检测范围费用</small>}
                  </div>,
                  <Money key="amt" cents={r.amount_cents} currency={r.currency} />,
                  <div key="ch" className="cell-stack">
                    <span className="nowrap">
                      {r.is_demo_tx ? "Stripe (模拟)" : r.provider === "paypal_manual" ? "PayPal 人工发票" : String(r.provider).toUpperCase()}
                    </span>
                    <small className="code mono-wrap">
                      {r.external_invoice_no ?? r.external_transaction_id ?? (r.provider_ref ? (r.provider_ref.length > 20 ? `${r.provider_ref.slice(0, 16)}…` : r.provider_ref) : "待外部凭据")}
                    </small>
                    {r.manual_state && (
                      <Tag tone={(MANUAL_PAYPAL_STATE_ZH[r.manual_state]?.tone ?? "gray")}>{MANUAL_PAYPAL_STATE_ZH[r.manual_state]?.label ?? r.manual_state}</Tag>
                    )}
                  </div>,
                  <BizTag key="st" dict={PAYMENT_STATE_ZH} value={r.state} />,
                  <div key="rf" className="cell-stack">
                    <BizTag dict={REFUND_STATE_ZH} value={r.refund_status} />
                    {r.refunded_cents > 0 && <small>已退 <Money cents={r.refunded_cents} align="left" /></small>}
                  </div>,
                  <div key="rc" className="cell-stack">
                    <BizTag dict={RECON_STATE_ZH} value={r.reconciliation_status} />
                    {r.recon_ticket_id && r.recon_ticket_no && (
                      <Link className="small code" href={`/admin/tickets/${r.recon_ticket_id}`}>异常工单 {r.recon_ticket_no}</Link>
                    )}
                  </div>,
                  <div key="tm" className="cell-stack nowrap">
                    <span>{stamp(r.paid_at ?? r.created_at, true)}</span>
                    {r.paid_at && <small>创建 {stamp(r.created_at, true)}</small>}
                  </div>,
                  <Link key="act" className="button sm nowrap" href={`/admin/payments/${r.id}`}>支付详情 →</Link>,
                ];
              })}
            />
            {(page > 1 || d.has_more) && (
              <div className="actions" style={{ marginTop: 12 }}>
                <button type="button" className="button sm" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</button>
                <span className="small">第 {page} 页</span>
                <button type="button" className="button sm" disabled={!d.has_more} onClick={() => setPage(p => p + 1)}>下一页</button>
              </div>
            )}
          </>
        )}
      </Panel>

      {paypalRows.length > 0 && <Panel
        title={`PayPal 人工开票与双人核销队列 (${paypalRows.length})`}
        subtitle="所有待处理与历史 PayPal Manual Invoice 直接展开可见：客户申请后不可自激活，必须由财务开票录实收并由另一位财务/超管 MFA 独立核销。"
      >
        {paypalRows.length === 0 ? (
          <p className="muted">当前暂无 PayPal 人工开票申请。</p>
        ) : (
          <Table
            headers={["关联订单 / 客户", "应收金额", "实收 / 手续费 / 净额", "发票号 / PayPal 交易号", "经办人与 SoD 状态", "当前阶段", "操作"]}
            rows={paypalRows.map((pr) => {
              const st = pr.manual_state==="verified"&&!pr.applied
                ? {label:"实收已核实 · 待对账",tone:"yellow" as const}
                : MANUAL_PAYPAL_STATE_ZH[pr.manual_state ?? pr.state] ?? { label: pr.manual_state ?? pr.state, tone: "gray" as const };
              const sameRecorder = Boolean(actor && pr.recorded_by && pr.recorded_by === actor.id);
              return [
                <div key="o" className="cell-stack">
                  <strong className="code">{pr.order_public_no ?? `PAY-${String(pr.id).slice(0, 8)}`}</strong>
                  <small>{pr.receiving_code ?? "—"} · {pr.payer_email ?? pr.customer_email ?? "—"}</small>
                </div>,
                <Money key="exp" cents={pr.expected_amount_cents ?? pr.amount_cents} currency={pr.currency} />,
                <div key="rec" className="cell-stack">
                  <span>实收：{pr.received_amount_cents != null ? <Money cents={pr.received_amount_cents} currency={pr.currency} align="left" /> : "—"}</span>
                  <small>净额：{pr.net_amount_cents != null ? <Money cents={pr.net_amount_cents} currency={pr.currency} align="left" /> : "—"}</small>
                  {pr.received_at&&<small>到账：{stamp(pr.received_at,true)}</small>}
                </div>,
                <div key="ref" className="cell-stack">
                  <span className="code mono-wrap">发票: {pr.external_invoice_no ?? "待开具"}</span>
                  <small className="code mono-wrap">TX: {pr.external_transaction_id ?? (pr.provider_data?.customer_reported_tx_ref ? `客户自报 ${pr.provider_data.customer_reported_tx_ref}` : "待录实收")}</small>
                </div>,
                <div key="sod" className="cell-stack">
                  <small>开票：{pr.issued_by_name ?? "—"} · 录款：{pr.recorded_by_name ?? "—"}</small>
                  <small>核销：{pr.verified_by_name ?? (sameRecorder ? "⚠️ 需换另一人核销" : "待第二人核销")}</small>
                </div>,
                <Tag key="st" tone={st.tone}>{st.label}</Tag>,
                <button
                  key="sel"
                  type="button"
                  className={`button sm${selectedPaypal?.id === pr.id ? " primary" : ""}`}
                  onClick={() => setActiveManualId(pr.id)}
                >
                  {selectedPaypal?.id === pr.id ? "处理中" : "打开处理台"}
                </button>,
              ];
            })}
          />
        )}

        {selectedPaypal && (
          <div key={selectedPaypal.id} className="split-grid" style={{ marginTop: 14 }}>
            <div className="panel" style={{ padding: 14 }}>
              <h3>1. 开具发票 &amp; 2. 登记实收 · {selectedPaypal.order_public_no ?? selectedPaypal.id.slice(0, 8)}</h3>
              <p className="small muted">
                客户申请金额：<Money cents={selectedPaypal.expected_amount_cents ?? selectedPaypal.amount_cents} currency={selectedPaypal.currency} align="left" /> · 客户 PayPal 邮箱：<code className="code">{selectedPaypal.payer_email ?? selectedPaypal.customer_email ?? "—"}</code>
                {selectedPaypal.provider_data?.customer_reported_tx_ref ? ` · 客户自报交易号：${selectedPaypal.provider_data.customer_reported_tx_ref}` : ""}
              </p>

              {!['succeeded','partially_refunded','refunded','canceled'].includes(selectedPaypal.state) && (
                <>
                  <Form
                    label="步骤 A：记录已发送的 PayPal Invoice 编号"
                    idempotent
                    run={async (f, key) => {
                      setChannelError(undefined);
                      try {
                        await request(`/staff/finance/paypal-invoices/${selectedPaypal.id}/issue`, "POST", {
                          external_invoice_no: text(f, "external_invoice_no"),
                          ...(text(f, "invoice_url") ? { invoice_url: text(f, "invoice_url") } : {}),
                          ...(text(f, "payer_email") ? { payer_email: text(f, "payer_email") } : {}),
                          ...(text(f, "notes") ? { notes: text(f, "notes") } : {}),
                        }, key);
                        setChannelNotice({ tone: "success", text: `已记录发票号并标记为“已发发票”。` });
                        reloadAll();
                      } catch (e) {
                        setChannelError(e instanceof Error ? e.message : "记录发票失败");
                        throw e;
                      }
                    }}
                  >
                    <div className="filters-grid">
                      <label>
                        PayPal 发票号 (如 INV2-XXXX)
                        <input name="external_invoice_no" required defaultValue={selectedPaypal.external_invoice_no ?? ""} placeholder="INV2-2026-0001" />
                      </label>
                      <label>
                        发票链接 (可选，必须为 paypal.com HTTPS)
                        <input name="invoice_url" type="url" defaultValue={selectedPaypal.invoice_url ?? ""} placeholder="https://www.paypal.com/invoice/p/..." />
                      </label>
                    </div>
                  </Form>

                  <hr className="sep" />

                  <Form
                    label="步骤 B：登记到账实收（PayPal TX ID 与净额）"
                    idempotent
                    run={async (f, key) => {
                      setChannelError(undefined);
                      try {
                        const fileEntry = f.get("proof");
                        let evidenceId: string | undefined;
                        if (fileEntry instanceof File && fileEntry.size > 0) {
                          evidenceId = await upload(fileEntry, "attachment");
                        }
                        const recCents = Math.round(Number(text(f, "received_usd")) * 100);
                        const feeCents = Math.round(Number(text(f, "fee_usd") || "0") * 100);
                        const receivedAt=new Date(text(f,"received_at")+"Z");
                        if(!Number.isFinite(receivedAt.valueOf()))throw new Error("请填写 PayPal 凭证上的到账时间（UTC）。");
                        const res = await request(`/staff/finance/paypal-invoices/${selectedPaypal.id}/record-receipt`, "POST", {
                          external_transaction_id: text(f, "external_transaction_id"),
                          received_amount_cents: recCents,
                          fee_amount_cents: feeCents,
                          received_at: receivedAt.toISOString(),
                          ...(evidenceId ? { evidence_media_id: evidenceId } : {}),
                          ...(text(f, "notes") ? { notes: text(f, "notes") } : {}),
                        }, key);
                        setChannelNotice({
                          tone: res.manual_state === "receipt_recorded" ? "success" : "warning",
                          text: `已录入交易 ${res.external_transaction_id}（阶段：${MANUAL_PAYPAL_STATE_ZH[res.manual_state]?.label ?? res.manual_state}），现等待另一位财务/超管独立核销。`,
                        });
                        reloadAll();
                      } catch (e) {
                        setChannelError(e instanceof Error ? e.message : "录入实收失败");
                        throw e;
                      }
                    }}
                  >
                    <div className="filters-grid">
                      <label>
                        PayPal 交易号 (唯一防重)
                        <input name="external_transaction_id" required defaultValue={selectedPaypal.external_transaction_id ?? selectedPaypal.provider_data?.customer_reported_tx_ref ?? ""} placeholder="例如 9AB12345CD678901E" />
                      </label>
                      <label>
                        实收总金额 (USD)
                        <input name="received_usd" type="number" step="0.01" min="0.01" required defaultValue={((selectedPaypal.received_amount_cents ?? selectedPaypal.expected_amount_cents ?? selectedPaypal.amount_cents) / 100).toFixed(2)} />
                      </label>
                      <label>
                        PayPal 手续费 (USD)
                        <input name="fee_usd" type="number" step="0.01" min="0" defaultValue={((selectedPaypal.fee_amount_cents ?? 0) / 100).toFixed(2)} />
                      </label>
                      <label>
                        凭证到账时间（UTC）
                        <input name="received_at" type="datetime-local" step="1" required defaultValue={selectedPaypal.received_at?.slice(0,19)??""}/>
                      </label>
                    </div>
                    <label>
                      上传收款截图或凭证 PDF（可选）
                      <input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" />
                    </label>
                    <label>
                      财务对账备注
                      <input name="notes" defaultValue={selectedPaypal.manual_notes ?? ""} placeholder="核实汇款人、货币与 PayPal 到账状态" />
                    </label>
                  </Form>
                </>
              )}
            </div>

            <div className="panel" style={{ padding: 14 }}>
              <h3>3. 独立二次核销激活 (SoD) / 作废取消</h3>
              <p className="small muted">
                服务端强制校验：<code>verified_by !== recorded_by</code>。少付（Underpaid）严禁激活订单。
              </p>
              {['succeeded','partially_refunded','refunded'].includes(selectedPaypal.state) ? (
                <StatusBanner tone={selectedPaypal.applied?"success":"warning"} title={selectedPaypal.applied?"收款已应用到收费项":"实收已核实，等待人工对账"}>
                  交易号 <code className="code">{selectedPaypal.external_transaction_id}</code> 已由 {selectedPaypal.verified_by_name ?? "独立审核人"} 复核。
                </StatusBanner>
              ) : selectedPaypal.state === "canceled" ? (
                <StatusBanner tone="info" title="该发票申请已作废">理由：{selectedPaypal.manual_notes ?? "—"}</StatusBanner>
              ) : (
                <>
                  {selectedPaypal.recorded_by&&<p className="small">凭证到账时间（UTC）：{selectedPaypal.received_at??"缺失，请根据原凭证补录"}</p>}
                  {actor && selectedPaypal.recorded_by === actor.id && (
                    <StatusBanner tone="warning" title="职责分离提醒 (SoD)">
                      该笔实收由您本人（{actor.id.slice(0, 8)}）录入，无法自录自核；请由另一位财务或超管账号登录验证并核销。
                    </StatusBanner>
                  )}
                  <div className="actions" style={{ flexWrap: "wrap", marginTop: 8 }}>
                    <Action
                      primary
                      disabled={!selectedPaypal.received_at || !selectedPaypal.recorded_by || (Boolean(actor) && selectedPaypal.recorded_by === actor?.id)}
                      run={async () => {
                        setChannelError(undefined);
                        const acceptOver = selectedPaypal.manual_state === "overpaid"
                          ? window.confirm("检测到实收大于应收（超付），是否明确确认接受超付并激活关联订单/发运？")
                          : false;
                        const result=await request(`/staff/finance/paypal-invoices/${selectedPaypal.id}/verify`, "POST", {
                          decision: "approve",
                          accept_overpayment: acceptOver,
                          note: "Independent finance verification passed",
                          expected_recorded_at:selectedPaypal.recorded_at,
                        });
                        setChannelNotice(result.applied
                          ? {tone:"success",text:"已复核实收并应用到收费项。"}
                          : {tone:"warning",text:"实收已复核，暂未应用到收费项。请处理关联的对账工单。"});
                        reloadAll();
                      }}
                    >
                      复核并确认实收
                    </Action>
                    <Action
                      disabled={!selectedPaypal.recorded_by || (Boolean(actor) && selectedPaypal.recorded_by === actor?.id)}
                      run={async () => {
                        const note = window.prompt("填写驳回退回原因（将清空待核实收以便重录）：", "Transaction details mismatch");
                        if (!note) return;
                        await request(`/staff/finance/paypal-invoices/${selectedPaypal.id}/verify`, "POST", { decision: "reject", note,expected_recorded_at:selectedPaypal.recorded_at });
                        setChannelNotice({ tone: "warning", text: "已驳回该条收款登记，等待重新核对。" });
                        reloadAll();
                      }}
                    >
                      核销驳回退回
                    </Action>
                    <Action
                      run={async () => {
                        const reason = window.prompt("填写取消发票原因：", "Customer canceled manual invoice");
                        if (!reason) return;
                        await request(`/staff/finance/paypal-invoices/${selectedPaypal.id}/cancel`, "POST", { reason });
                        setChannelNotice({ tone: "info", text: "已作废该笔 PayPal 人工发票申请。" });
                        reloadAll();
                      }}
                    >
                      作废取消发票
                    </Action>
                    <Link className="button sm" href={`/admin/payments/${selectedPaypal.id}`}>查看完整支付详情 →</Link>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </Panel>}

      {disputeRows.length > 0 && (
        <Panel title={`渠道争议与拒付冻结队列 (${disputeRows.length})`} subtitle="涉及支付争议的订单会自动进入暂停（on_hold）并冻结关联出库批次，需在外部争议完结后人工核销解冻。">
          <Table
            headers={["争议单号", "关联支付", "关联订单", "争议金额", "当前状态", "举证截止", "人工处理结果"]}
            rows={disputeRows.map(dp => [
              <CopyId key="id" value={dp.provider_dispute_id} />,
              <Link key="p" className="code nowrap" href={`/admin/payments/${dp.payment_id}`}>查看支付单 →</Link>,
              dp.public_no ? <Link key="o" className="code nowrap" href={`/admin/orders/${dp.public_no}`}>{dp.public_no}</Link> : "—",
              <Money key="a" cents={dp.amount_cents} currency={dp.currency} />,
              <Tag key="s" tone={dp.status === "resolved_by_staff" ? "green" : "red"}>{dp.status === "resolved_by_staff" ? "已人工核销" : dp.status}</Tag>,
              stamp(dp.evidence_due_at, true),
              dp.status === "resolved_by_staff"
                ? <span>{dp.staff_decision === "release_freeze" ? "已解冻订单与发运" : "维持人工冻结"} · {dp.staff_note ?? ""}</span>
                : (
                  <div className="actions">
                    <Action sm run={async () => {
                      const note = window.prompt("填写争议关闭核验依据并解冻订单：", "Stripe dispute resolved in favor of merchant");
                      if (!note || note.trim().length < 2) return;
                      await request(`/staff/disputes/${encodeURIComponent(dp.provider_dispute_id)}/resolve`, "POST", { decision: "release_freeze", reason: note.trim() });
                      disputes.reload();
                      reload();
                    }}>解冻恢复</Action>
                  </div>
                ),
            ])}
          />
        </Panel>
      )}
    </>
  );
}

export function AdminPaymentDetail({ id, demo = false }: { id: string; demo?: boolean }) {
  const { data, error, reload } = useLoad(`/staff/admin/payments/${id}`);
  const p = data?.payment;
  const cust = data?.customer;
  const charge = data?.charge;
  const quote = data?.quote;
  const refundSummary = data?.refund_summary;
  const recon = data?.reconciliation;

  return (
    <>
      <div className="page-head row">
        <div>
          <Link href="/admin/payments">← 返回支付流水与对账工作台</Link>
          <h1 style={{ marginTop: 6 }}>
            支付交易详情 · <span className="code">{p?.display_ref ?? `#${id.slice(0, 8)}`}</span>
          </h1>
          {p && (
            <div className="actions" style={{ marginTop: 6 }}>
              <BizTag dict={PAYMENT_STATE_ZH} value={p.state} />
              <BizTag dict={RECON_STATE_ZH} value={recon?.status} />
              {p.is_demo_tx && <Tag tone="yellow">本地模拟结账 (QCW_DEMO)</Tag>}
              {p.is_test && <Tag tone="gray">测试订单交易</Tag>}
            </div>
          )}
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新交易与回调状态</button>
          {data?.primary_order_no && (
            <Link className="button sm primary" href={`/admin/orders/${data.primary_order_no}`}>打开所属订单 {data.primary_order_no}</Link>
          )}
        </div>
      </div>

      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在加载完整支付交易与对账上下文…</p>}

      {data && p && (
        <>
          {demo && p.is_demo_tx && (
            <StatusBanner tone="warning" title="模拟支付数据边界">
              本笔交易通过本机测试结算端点（<code>demo_</code>）完成确认，内部收费状态机、退款余额扣减及对账工单规则与生产一致，但未经过外部银行清算。
            </StatusBanner>
          )}

          {recon?.notes?.length > 0 && (
            <StatusBanner tone={recon.status === "issue" || recon.status === "disputed" ? "error" : "info"} title="对账检查提示">
              {recon.notes.join("；")}
            </StatusBanner>
          )}

          {/* A. 交易概览 */}
          <Panel title="A. 交易概览">
            <div className="metric-strip">
              <div className="metric">
                <span>本次实付金额</span>
                <strong><Money cents={p.amount_cents} currency={p.currency} align="left" /></strong>
                <small>原收费单金额 <Money cents={charge?.amount_cents} currency={charge?.currency} align="left" /></small>
              </div>
              <div className="metric">
                <span>支付状态 / 对账状态</span>
                <strong style={{ fontSize: 18 }}>{PAYMENT_STATE_ZH[p.state]?.label ?? p.state}</strong>
                <small>{RECON_STATE_ZH[recon?.status]?.label ?? recon?.status}</small>
              </div>
              <div className="metric">
                <span>已退 / 剩余可退余额</span>
                <strong><Money cents={refundSummary?.remaining_refundable_cents ?? 0} currency={p.currency} align="left" /></strong>
                <small>已成功退 <Money cents={refundSummary?.refunded_succeeded_cents ?? 0} align="left" /> · 审批中 <Money cents={refundSummary?.refund_pending_cents ?? 0} align="left" /></small>
              </div>
              <div className="metric">
                <span>收费用途</span>
                <strong style={{ fontSize: 18 }}>{PURPOSE_ZH[charge?.purpose] ?? charge?.purpose}</strong>
                <small>{p.paid_at ? `确认时间 ${stamp(p.paid_at, true)}` : `发起时间 ${stamp(p.created_at, true)}`}</small>
              </div>
            </div>
            <dl className="admin-kv-grid">
              <div className="admin-kv-item"><dt>可读支付编号</dt><dd><CopyId value={p.display_ref} short={false} /></dd></div>
              <div className="admin-kv-item"><dt>支付渠道</dt><dd>{p.is_demo_tx ? "Stripe (Demo 模拟)" : `Stripe (${p.checkout_mode ?? "live/test"})`}</dd></div>
              <div className="admin-kv-item"><dt>币种</dt><dd>{p.currency}</dd></div>
              <div className="admin-kv-item"><dt>发起创建时间</dt><dd>{stamp(p.created_at, true)}</dd></div>
              <div className="admin-kv-item"><dt>到账确认时间</dt><dd>{p.paid_at ? stamp(p.paid_at, true) : "尚未收到到账确认"}</dd></div>
              <div className="admin-kv-item"><dt>最近状态更新</dt><dd>{stamp(p.updated_at, true)}</dd></div>
            </dl>
          </Panel>

          {/* B. 客户、订单与收费明细 */}
          <Panel title="B. 客户、关联订单、原始报价与收费项目">
            <div className="ops-columns">
              <div>
                <h3 style={{ marginTop: 0 }}>付款客户资料</h3>
                <dl className="admin-kv-grid">
                  <div className="admin-kv-item">
                    <dt>专属收件码</dt>
                    <dd>{cust?.user_id ? <Link className="code" href={`/admin/customers/${cust.user_id}`}>{cust.receiving_code ?? "查看客户档案"}</Link> : "—"}</dd>
                  </div>
                  <div className="admin-kv-item"><dt>客户账号状态</dt><dd><BizTag dict={USER_STATUS_ZH} value={cust?.status} /></dd></div>
                  <div className="admin-kv-item"><dt>客户邮箱 / 名称</dt><dd>{cust?.email ?? cust?.display_name ?? "—"}</dd></div>
                  <div className="admin-kv-item"><dt>客户组织 ID</dt><dd><CopyId value={cust?.org_id} /></dd></div>
                </dl>
              </div>
              <div>
                <h3 style={{ marginTop: 0 }}>关联报价与收费项目快照</h3>
                {quote ? (
                  <dl className="admin-kv-grid">
                    <div className="admin-kv-item"><dt>报价版本 / 金额</dt><dd>v{quote.revision ?? 1} · <Money cents={quote.amount_cents} currency={p.currency} align="left" /></dd></div>
                    <div className="admin-kv-item"><dt>客户确认报价时间</dt><dd>{quote.accepted_at ? stamp(quote.accepted_at, true) : "尚未确认"}</dd></div>
                    <div className="admin-kv-item"><dt>报价有效期</dt><dd>{stamp(quote.expires_at, true)}</dd></div>
                    <div className="admin-kv-item">
                      <dt>收费入账绑定</dt>
                      <dd>{charge?.is_applied_payment ? <Tag tone="green">当前交易已入账抵扣本收费单</Tag> : charge?.voided_at ? <Tag tone="red">收费单已作废</Tag> : <Tag tone="yellow">尚未绑定生效入账</Tag>}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="muted">当前收费项目未绑定历史报价版本（人工直接建账或无需单独确认）。</p>
                )}
              </div>
            </div>
            <h3 style={{ marginTop: 8 }}>关联订单 ({(data.orders ?? []).length})</h3>
            <Table
              headers={["订单号", "订单阶段", "服务类型", "样件数", "订单总额", "订单付款时间"]}
              rows={(data.orders ?? []).map((o: Row) => [
                <Link key="no" className="code nowrap" href={`/admin/orders/${o.public_no}`}>{o.public_no}</Link>,
                <BizTag key="st" dict={ORDER_STATE_ZH} value={o.state} />,
                <span key="svc">{o.service_title ?? (SERVICE_CODE_ZH[o.service_code] ?? o.service_code ?? "—")}</span>,
                <span key="cnt" className="nowrap">{o.sample_count ?? 0} 件</span>,
                <Money key="pr" cents={o.price_cents} />,
                <span key="pt" className="nowrap">{stamp(o.paid_at, true)}</span>,
              ])}
              empty="该笔收费未直接绑定单个质检订单（如独立仓储/合并出库批次收费，可查看下方分摊记录）。"
            />
          </Panel>

          {/* C. 支付渠道与回调技术信息 */}
          <Panel title="C. 支付渠道对象与 Webhook 回调记录" subtitle="保留完整底层技术标识供客服与财务对账排障使用，支持一键复制。">
            <dl className="admin-kv-grid" style={{ marginBottom: 14 }}>
              <div className="admin-kv-item"><dt>支付记录 UUID</dt><dd><CopyId value={p.id} /></dd></div>
              <div className="admin-kv-item"><dt>收费项目 UUID</dt><dd><CopyId value={charge?.id} /></dd></div>
              <div className="admin-kv-item"><dt>渠道会话 / 凭据 (provider_ref)</dt><dd><CopyId value={p.provider_ref} short={false} /></dd></div>
              <div className="admin-kv-item"><dt>PaymentIntent ID</dt><dd><CopyId value={p.payment_intent} short={false} /></dd></div>
              <div className="admin-kv-item"><dt>幂等键 (Idempotency Key)</dt><dd><CopyId value={p.idempotency_key} /></dd></div>
            </dl>
            <Table
              headers={["回调事件 ID", "事件类型", "渠道付款状态", "接收时间", "处理完成时间"]}
              rows={(data.provider_events ?? []).map((ev: Row) => [
                <CopyId key="id" value={ev.event_id} short={false} />,
                <span className="code">{ev.type}</span>,
                ev.payment_status || ev.object_status || "—",
                stamp(ev.received_at, true),
                ev.processed_at ? stamp(ev.processed_at, true) : <Tag tone="yellow">待处理</Tag>,
              ])}
              empty={p.is_demo_tx ? "本笔为本地模拟结算（demo_），未经过外部 Stripe Webhook。" : "暂未检索到匹配的 Stripe Webhook 事件记录。"}
            />
          </Panel>

          {/* D. 退款明细 */}
          <Panel
            title={`D. 退款明细与余额核对 (${(data.refunds ?? []).length})`}
            badge={refundSummary?.remaining_refundable_cents > 0 && data.primary_order_no ? (
              <Link className="button sm" href={`/admin/orders/${data.primary_order_no}#tab-billing`}>前往所属订单发起退款申请 →</Link>
            ) : undefined}
          >
            <Table
              headers={["退款单号", "申请来源", "申请金额", "审批状态", "申请原因", "申请人 / 审批人", "渠道退款凭据", "发起时间", "操作"]}
              rows={(data.refunds ?? []).map((rf: Row) => [
                <Link key="r" className="code nowrap" href={`/admin/refunds/${rf.id}`}>{rf.display_ref}</Link>,
                rf.source === "provider_dashboard" ? "渠道后台发起" : "平台内部申请",
                <Money key="amt" cents={rf.amount_cents} currency={p.currency} />,
                <BizTag key="st" dict={REFUND_STATE_ZH} value={rf.state} />,
                rf.reason,
                <span>{rf.requested_by_name ?? "—"} / {rf.approved_by_name ?? "待审批"}</span>,
                <CopyId key="pr" value={rf.provider_ref} />,
                <span key="dt" className="nowrap">{stamp(rf.created_at, true)}</span>,
                <Link key="go" className="button sm nowrap" href={`/admin/refunds/${rf.id}`}>审批详情 →</Link>,
              ])}
              empty="该笔支付名下尚未发生任何退款申请或退款执行记录。"
            />
          </Panel>

          {/* E. 财务对账 */}
          <Panel title="E. 内部账本分摊、渠道结算与异常工单">
            <div className="ops-columns">
              <div>
                <h3 style={{ marginTop: 0 }}>收费分摊明细 ({(recon?.allocations ?? []).length})</h3>
                <Table
                  headers={["关联订单", "订单状态", "分摊金额"]}
                  rows={(recon?.allocations ?? []).map((a: Row) => [
                    <Link key="o" className="code" href={`/admin/orders/${a.public_no}`}>{a.public_no}</Link>,
                    <BizTag key="s" dict={ORDER_STATE_ZH} value={a.order_state} />,
                    <Money key="m" cents={a.amount_cents} currency={p.currency} />,
                  ])}
                  empty={charge?.purpose === "inspection" ? "单笔质检收费直接归属原质检订单。" : "暂无跨单分摊记录（多笔合批出库分摊将在结算分账时写入）。"}
                />
                {recon?.settlement ? (
                  <dl className="admin-kv-grid" style={{ marginTop: 12 }}>
                    <div className="admin-kv-item"><dt>渠道结算毛额</dt><dd>{formatBalanceAmount(recon.settlement.gross_minor,recon.settlement.currency.toUpperCase())}</dd></div>
                    <div className="admin-kv-item"><dt>渠道手续费</dt><dd>{formatBalanceAmount(recon.settlement.fee_minor,recon.settlement.currency.toUpperCase())}</dd></div>
                    <div className="admin-kv-item"><dt>{p.provider==="stripe"?"Stripe 余额净额":"渠道净结算金额"}</dt><dd>{formatBalanceAmount(recon.settlement.net_minor,recon.settlement.currency.toUpperCase())}</dd></div>
                    <div className="admin-kv-item"><dt>{p.provider==="stripe"?"Stripe 余额可用时间":"凭证到账时间"}</dt>
                      <dd>{recon.settlement.settled_at?stamp(recon.settlement.settled_at,true):"等待渠道余额可用"}</dd>
                    </div>
                    {recon.settlement.exchange_rate&&<div className="admin-kv-item"><dt>渠道汇兑率</dt>
                      <dd>{recon.settlement.exchange_rate} <small>（渠道最小货币单位）</small></dd>
                    </div>}
                    <div className="admin-kv-item"><dt>渠道流水编号</dt><dd><CopyId value={recon.settlement.provider_transaction_id}/></dd></div>
                  </dl>
                ) : (
                  <p className="muted" style={{ marginTop: 10 }}>{recon?.settlement_job?.last_error?
                    "结算同步异常，等待管理员重试。":
                    p.provider==="stripe"&&["succeeded","partially_refunded","refunded"].includes(p.state)&&!p.is_demo_tx?
                    "等待 Stripe 提供可核对的结算流水。":"暂无渠道结算流水。"}</p>
                )}
              </div>
              <div>
                <h3 style={{ marginTop: 0 }}>关联对账异常工单与争议 ({(recon?.related_tickets ?? []).length})</h3>
                <Table
                  headers={["工单号", "分类", "状态", "摘要", "关联订单"]}
                  rows={(recon?.related_tickets ?? []).map((k: Row) => [
                    <Link key="id" className="code nowrap" href={`/admin/tickets/${k.id}`}>{k.public_no}</Link>,
                    "财务/退款",
                    <Tag key="st">{k.state}</Tag>,
                    k.subject,
                    k.order_no ? <Link key="o" className="code" href={`/admin/orders/${k.order_no}`}>{k.order_no}</Link> : "—",
                  ])}
                  empty="当前未产生对账异常工单。"
                />
              </div>
            </div>
          </Panel>

          {/* F. 交易事件时间线 */}
          <Panel title="F. 真实交易事件时间线">
            {(data.timeline ?? []).length === 0 ? <Empty>暂无事件时间线记录。</Empty> : (
              <ol className="timeline">
                {(data.timeline as Row[]).map((ev, idx) => (
                  <li key={idx}>
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{ev.title}</strong>
                      <small className="muted">{ev.source} · {stamp(ev.at, true)}</small>
                    </div>
                    <p style={{ margin: "2px 0 0" }}>{ev.detail}</p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

export function AdminRefundsWorkbench() {
  const [state, setState] = useState("all");
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ state, page: String(page), limit: "25" });
  if (q) params.set("q", q);
  const { data, error, reload } = useLoad("/staff/admin/refunds?" + params.toString());
  const d = data;
  const counts = d?.counts ?? {};
  const summary = d?.summary ?? {};
  const rows: Row[] = d?.rows ?? [];

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>退款审批与执行工作台</h1>
          <p className="muted">每笔退款申请必须进入完整详情工作台核对客户、原始订单、报告交付状态、剩余可退余额及职责分离要求后，方可由独立复核人批准或驳回。</p>
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新队列</button>
        </div>
      </div>

      <FinanceSubNav active="refunds" />

      {error && <ErrorBlock error={error} />}

      {d && (
        <div className="metric-strip" aria-label="退款审批概览">
          <div className="metric">
            <span>待独立审批笔数</span>
            <strong>{summary.pending_count ?? 0}</strong>
            <small>需 super_admin + 近 15 分钟 MFA 确认</small>
          </div>
          <div className="metric">
            <span>待审申请金额合计</span>
            <strong><Money cents={summary.requested_cents ?? 0} align="left" /></strong>
            <small>批准后才触发后台原路退款作业</small>
          </div>
          <div className="metric">
            <span>已执行成功退款总额</span>
            <strong><Money cents={summary.succeeded_cents ?? 0} align="left" /></strong>
            <small>已原路结算并同步客户账单</small>
          </div>
          <div className="metric">
            <span>驳回 / 执行失败</span>
            <strong>{(counts.rejected ?? 0) + (counts.failed ?? 0)}</strong>
            <small>驳回 {counts.rejected ?? 0} 笔 · 失败 {counts.failed ?? 0} 笔</small>
          </div>
        </div>
      )}

      <AdminTabs
        active={state}
        onChange={next => { setState(next); setPage(1); }}
        tabs={[
          { id: "all", label: "全部退款", count: counts.all },
          { id: "requested", label: "待独立审批", count: counts.requested },
          { id: "approved", label: "已批待渠道退款", count: counts.approved },
          { id: "succeeded", label: "退款已成功", count: counts.succeeded },
          { id: "rejected", label: "已驳回", count: counts.rejected },
          { id: "failed", label: "渠道失败", count: counts.failed },
        ]}
      />

      <form
        className="admin-toolbar"
        onSubmit={e => {
          e.preventDefault();
          setQ(searchInput.trim());
          setPage(1);
        }}
      >
        <label>
          检索退款号 / 订单号 / 客户 / 原因
          <input
            type="search"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="RFD-... / QW-... / QCW-... / 邮箱 / 退款原因"
          />
        </label>
        <div className="actions">
          <button type="submit" className="button primary sm">查询退款</button>
          <button type="button" className="button sm" onClick={() => { setSearchInput(""); setQ(""); setState("all"); setPage(1); }}>重置</button>
        </div>
      </form>

      <Panel title="退款申请及处理列表" subtitle="安全门禁：列表仅展示完整上下文并引导进入决策工作台，禁止未核对订单与余额的盲目快捷审批。">
        {!d && !error && <p role="status">正在加载退款队列…</p>}
        {d && rows.length === 0 && (
          <EmptyState
            kind={q || state !== "all" ? "filtered" : "empty"}
            title={q || state !== "all" ? "当前筛选条件下没有退款记录" : "当前没有待处理的退款申请"}
            description={q || state !== "all" ? "尝试切换为全部状态或清除搜索关键词。" : "需发起退款时，可前往对应订单详情的「报价与账本」区块依据服务阶段发起申请。"}
            onAction={() => { setSearchInput(""); setQ(""); setState("all"); setPage(1); }}
            actionLabel="查看全部退款"
          />
        )}
        {d && rows.length > 0 && (
          <Table
            headers={["退款单号", "客户", "原订单", "原收费 / 实付", "申请退款金额", "当前可退余额", "原因摘要", "审批状态", "渠道执行", "申请人 / 审批人", "申请时间", "决策入口"]}
            rows={rows.map(r => {
              const orders: Row[] = r.linked_orders ?? [];
              return [
                <div key="id" className="cell-stack">
                  <Link href={`/admin/refunds/${r.id}`}><strong className="code nowrap">{r.display_ref}</strong></Link>
                  <small>{r.source === "provider_dashboard" ? "渠道后台" : "平台申请"}</small>
                </div>,
                <div key="c" className="cell-stack">
                  {r.customer_user_id ? <Link className="code nowrap" href={`/admin/customers/${r.customer_user_id}`}>{r.receiving_code ?? "客户档案"}</Link> : "—"}
                  <small>{r.customer_email ?? r.customer_name ?? "—"}</small>
                </div>,
                <div key="o" className="cell-stack">
                  {orders.length > 0 ? orders.map(o => <Link key={o.id} className="code nowrap" href={`/admin/orders/${o.public_no}`}>{o.public_no}</Link>) : "—"}
                </div>,
                <div key="chg" className="cell-stack">
                  <span className="nowrap">{PURPOSE_ZH[r.purpose] ?? r.purpose}</span>
                  <small>实付 <Money cents={r.payment_amount_cents} currency={r.currency} align="left" /></small>
                </div>,
                <Money key="amt" cents={r.amount_cents} currency={r.currency} />,
                <Money key="rem" cents={r.remaining_refundable_cents} currency={r.currency} />,
                <span key="rsn" title={r.reason}>{r.reason.length > 40 ? `${r.reason.slice(0, 40)}…` : r.reason}</span>,
                <BizTag key="st" dict={REFUND_STATE_ZH} value={r.state} />,
                <span key="ch" className="nowrap">
                  {r.channel_status === "settled" ? "渠道已退款" : r.channel_status === "queued" ? "待后台下发" : r.channel_status === "failed" ? "渠道执行失败" : r.channel_status === "cancelled" ? "未发送渠道" : "等待审批通过"}
                </span>,
                <div key="actr" className="cell-stack">
                  <span>申：{r.requested_by_name ?? "—"}</span>
                  <small>审：{r.approved_by_name ?? (r.state === "requested" ? "待独立复核" : "—")}</small>
                </div>,
                <span key="tm" className="nowrap">{stamp(r.created_at, true)}</span>,
                <Link key="go" className={`button sm nowrap${r.state === "requested" ? " primary" : ""}`} href={`/admin/refunds/${r.id}`}>
                  {r.state === "requested" ? "核对与审批" : "查看详情"}
                </Link>,
              ];
            })}
          />
        )}
      </Panel>
    </>
  );
}

export function AdminRefundDetail({ id, demo = false, actor: _actor }: { id: string; demo?: boolean; actor?: Actor }) {
  const { data, error, reload } = useLoad(`/staff/admin/refunds/${id}`);
  const [notice, setNotice] = useState("");
  const [reauthNeeded, setReauthNeeded] = useState(false);

  const rf = data?.refund;
  const cust = data?.customer;
  const p = data?.payment;
  const funds = data?.funds_check;
  const oc = data?.order_context;
  const ctrl = data?.decision_controls;

  return (
    <>
      <div className="page-head row">
        <div>
          <Link href="/admin/refunds">← 返回退款审批列表</Link>
          <h1 style={{ marginTop: 6 }}>
            退款审批决策台 · <span className="code">{rf?.display_ref ?? `#${id.slice(0, 8)}`}</span>
          </h1>
          {rf && (
            <div className="actions" style={{ marginTop: 6 }}>
              <BizTag dict={REFUND_STATE_ZH} value={rf.state} />
              <span className="code">申请金额：<Money cents={rf.amount_cents} currency={rf.currency} align="left" /></span>
              {p && <Link className="button sm" href={`/admin/payments/${p.id}`}>查看原支付单 {p.display_ref}</Link>}
              {oc?.public_no && <Link className="button sm" href={`/admin/orders/${oc.public_no}`}>查看原订单 {oc.public_no}</Link>}
            </div>
          )}
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新审批状态</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在加载退款完整上下文与资金余额…</p>}

      {data && rf && (
        <>
          <StatusBanner tone="info" title="退款与执行语义区分">
            流程链条：<strong>提交退款申请 → 独立审批通过/驳回 → 后台任务异步调用原路退款 → 渠道确认成功 → 原支付单与客户账单更新</strong>。批准申请成功（<code>202 Accepted</code>）仅完成审核授权，若渠道或后台队列暂未执行，列表与本页会明确区分「已批待渠道退款」与「退款已成功」。
          </StatusBanner>

          {notice && <StatusBanner tone="success" title="操作已提交">{notice}</StatusBanner>}
          {reauthNeeded && (
            <StatusBanner tone="warning" title="需要高风险操作二次验证">
              退款审批与驳回属于敏感资金操作，要求管理员最近 15 分钟内完成员工身份校验。{" "}
              <Link href={`/staff/login?next=${encodeURIComponent(`/admin/refunds/${id}`)}`}>立即重新验证员工身份 →</Link>
            </StatusBanner>
          )}

          <div className="admin-split-detail">
            <div className="admin-detail-main">
              <Panel title="1. 客户资料与原始订单履约上下文">
                <dl className="admin-kv-grid">
                  <div className="admin-kv-item">
                    <dt>客户专属收件码</dt>
                    <dd>{cust?.user_id ? <Link className="code" href={`/admin/customers/${cust.user_id}`}>{cust.receiving_code ?? "客户详情"}</Link> : "—"}</dd>
                  </div>
                  <div className="admin-kv-item"><dt>客户邮箱</dt><dd>{cust?.email ?? cust?.display_name ?? "—"}</dd></div>
                  <div className="admin-kv-item"><dt>原收费项目</dt><dd>{PURPOSE_ZH[data.charge?.purpose] ?? data.charge?.purpose}</dd></div>
                  <div className="admin-kv-item"><dt>原支付时间</dt><dd>{p?.created_at ? stamp(p.created_at, true) : "—"}</dd></div>
                </dl>

                {oc ? (
                  <div style={{ marginTop: 14 }}>
                    <dl className="admin-kv-grid">
                      <div className="admin-kv-item"><dt>原始订单</dt><dd><Link className="code" href={`/admin/orders/${oc.public_no}`}>{oc.public_no}</Link></dd></div>
                      <div className="admin-kv-item"><dt>当前订单阶段</dt><dd><BizTag dict={ORDER_STATE_ZH} value={oc.state} /></dd></div>
                      <div className="admin-kv-item"><dt>购买服务与委托件数</dt><dd>{oc.service_title ?? (SERVICE_CODE_ZH[oc.service_code] ?? oc.service_code)} · {oc.expected_units ?? 0} 件</dd></div>
                      <div className="admin-kv-item">
                        <dt>质检报告交付状态</dt>
                        <dd>{oc.report_version ? <Tag tone="green">正式报告 v{oc.report_version} 已发布 ({stamp(oc.report_published_at, true)})</Tag> : <Tag tone="yellow">正式报告尚未发布</Tag>}</dd>
                      </div>
                    </dl>
                    {oc.refund_stage && (
                      <div className="notice" style={{ marginTop: 12 }}>
                        <strong>系统阶段退费规则参考：</strong> {oc.refund_stage.policy_summary ?? oc.refund_stage.stage}（标准退费比例 {oc.refund_stage.refund_rate_pct ?? 0}%，参考建议金额 <Money cents={oc.refund_stage.recommended_refund_cents} align="left" />）
                      </div>
                    )}
                    {(oc.related_tickets ?? []).length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <strong className="small">关联客服工单与纠纷：</strong>
                        <Table
                          headers={["工单号", "分类", "状态", "摘要"]}
                          rows={oc.related_tickets.map((k: Row) => [
                            <Link key="id" className="code" href={`/admin/tickets/${k.id}`}>{k.public_no}</Link>,
                            k.category,
                            <Tag key="st">{k.state}</Tag>,
                            k.subject,
                          ])}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="muted" style={{ marginTop: 12 }}>该笔付款为出库批次或跨单收费（可点击上方原支付单查看分摊明细）。</p>
                )}
              </Panel>

              <Panel title="2. 退款申请内容与同笔支付历史退款记录">
                <dl className="admin-kv-grid" style={{ marginBottom: 14 }}>
                  <div className="admin-kv-item"><dt>退款单完整 UUID</dt><dd><CopyId value={rf.id} /></dd></div>
                  <div className="admin-kv-item"><dt>申请发起人</dt><dd>{rf.requested_by_name}</dd></div>
                  <div className="admin-kv-item"><dt>申请时间</dt><dd>{stamp(rf.created_at, true)}</dd></div>
                  <div className="admin-kv-item"><dt>乐观锁版本</dt><dd>v{rf.revision}</dd></div>
                  <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}><dt>申请退款原因与依据</dt><dd>{rf.reason}</dd></div>
                  {rf.provider_ref && <div className="admin-kv-item"><dt>渠道退款凭据</dt><dd><CopyId value={rf.provider_ref} short={false} /></dd></div>}
                </dl>

                <h3>同笔支付下的全部历史退款事件 ({(data.history ?? []).length})</h3>
                <Table
                  headers={["退款单号", "申请金额", "状态", "原因", "申请人 / 审批人", "时间"]}
                  rows={(data.history ?? []).map((h: Row) => [
                    h.id === rf.id ? <strong key="c" className="code">{h.display_ref} (当前)</strong> : <Link key="c" className="code" href={`/admin/refunds/${h.id}`}>{h.display_ref}</Link>,
                    <Money key="a" cents={h.amount_cents} currency={rf.currency} />,
                    <BizTag key="s" dict={REFUND_STATE_ZH} value={h.state} />,
                    h.reason,
                    `${h.requested_by_name ?? "—"} / ${h.approved_by_name ?? "—"}`,
                    stamp(h.created_at, true),
                  ])}
                />
              </Panel>

              <Panel title="3. 退款审批与执行审计记录">
                <Table
                  headers={["时间", "操作人", "业务动作", "审批理由 / 详情"]}
                  rows={(data.audit_events ?? []).map((a: Row) => [
                    stamp(a.at, true),
                    a.actor_name ?? (a.actor_type === "system" ? "后台系统作业" : "员工"),
                    AUDIT_ACTION_ZH[a.action] ?? a.action,
                    a.after?.reason ?? a.after?.provider_ref ?? "—",
                  ])}
                  empty="暂无该退款单后续审批或执行审计日志。"
                />
              </Panel>
            </div>

            <div className="admin-detail-side">
              <Panel title="资金可退余额核对">
                <dl className="admin-kv-grid">
                  <div className="admin-kv-item"><dt>原收费单金额</dt><dd><Money cents={funds.original_charge_cents} currency={rf.currency} align="left" /></dd></div>
                  <div className="admin-kv-item"><dt>客户实付金额</dt><dd><Money cents={funds.paid_cents} currency={rf.currency} align="left" /></dd></div>
                  <div className="admin-kv-item"><dt>已成功退款累计</dt><dd><Money cents={funds.succeeded_refunds_cents} currency={rf.currency} align="left" /></dd></div>
                  <div className="admin-kv-item"><dt>已批待执行退款</dt><dd><Money cents={funds.approved_pending_cents} currency={rf.currency} align="left" /></dd></div>
                  <div className="admin-kv-item"><dt>当前可退余额上限</dt><dd><Money cents={funds.remaining_refundable_cents} currency={rf.currency} align="left" /></dd></div>
                  <div className="admin-kv-item"><dt>本次申请退款金额</dt><dd><strong style={{ color: "#1d4ed8" }}><Money cents={funds.requested_cents} currency={rf.currency} align="left" /></strong></dd></div>
                  {rf.state === "requested" && (
                    <div className="admin-kv-item" style={{ gridColumn: "1 / -1" }}>
                      <dt>批准后剩余余额</dt>
                      <dd>
                        {funds.amount_within_balance
                          ? <span className="ok"><Money cents={funds.post_approval_remaining_cents} currency={rf.currency} align="left" />（未超可退上限）</span>
                          : <span className="danger">超出余额上限，服务端将拒绝批准</span>}
                      </dd>
                    </div>
                  )}
                </dl>
              </Panel>

              <Panel title="独立审批与风控决策" subtitle="严格执行服务端 SoD 职责分离（申请人 ≠ 审批人）、乐观锁版本校验及 15 分钟 MFA 认证。">
                {ctrl?.block_reasons?.length > 0 && (
                  <StatusBanner tone={rf.state === "requested" ? "warning" : "info"} title="当前不可审批原因">
                    {ctrl.block_reasons.join("；")}
                  </StatusBanner>
                )}

                {ctrl?.can_decide && (
                  <>
                    <Form
                      label="批准退款并提交后台原路退款"
                      idempotent
                      run={async (f, key) => {
                        if (!window.confirm(`确认独立批准 ${rf.display_ref}（$${(rf.amount_cents / 100).toFixed(2)}）并触发原路退款？`)) return;
                        try {
                          const reason = text(f, "reason");
                          await request(`/staff/admin/refunds/${rf.id}/approve`, "POST", {
                            revision: rf.revision,
                            ...(reason ? { reason } : {}),
                          }, key);
                          setReauthNeeded(false);
                          setNotice(demo
                            ? "已通过独立复核并加入退款执行队列（当前处于本地模拟模式，将在后台作业执行后完成 demo_refund 核销）。"
                            : "已通过独立复核并加入退款执行队列，请稍后刷新查看渠道退款结果。");
                          reload();
                        } catch (e) {
                          if (e instanceof RequestError && e.code === "STAFF_REAUTH_REQUIRED") setReauthNeeded(true);
                          throw e;
                        }
                      }}
                    >
                      <label>
                        财务/超管审核批准备注（计入审计日志）
                        <textarea name="reason" rows={2} placeholder="例如：已核对原收费单、未发现重复申请及报告争议，同意退还对应金额" />
                      </label>
                    </Form>

                    <hr className="sep" />

                    <Form
                      label="驳回该退款申请"
                      idempotent
                      run={async (f, key) => {
                        try {
                          const reason = text(f, "reason");
                          await request(`/staff/admin/refunds/${rf.id}/reject`, "POST", {
                            revision: rf.revision,
                            reason,
                          }, key);
                          setReauthNeeded(false);
                          setNotice("已驳回该退款申请并记录完整审核理由（资金余额已自动释放，未调用任何渠道打款）。");
                          reload();
                        } catch (e) {
                          if (e instanceof RequestError && e.code === "STAFF_REAUTH_REQUIRED") setReauthNeeded(true);
                          throw e;
                        }
                      }}
                    >
                      <label>
                        驳回原因（必填，至少 4 字）
                        <textarea name="reason" required minLength={4} maxLength={1000} rows={2} placeholder="明确说明拒绝理由，例如：报告已发布且非平台原因，改为重检处理" />
                      </label>
                    </Form>
                  </>
                )}

                {!ctrl?.can_decide && rf.state !== "requested" && (
                  <p className="muted" style={{ marginTop: 8 }}>
                    审批结论：<strong>{REFUND_STATE_ZH[rf.state]?.label ?? rf.state}</strong>
                    {rf.approved_by_name ? `（由 ${rf.approved_by_name} 处理）` : ""}。
                  </p>
                )}

                {rf.state === "approved" && p?.provider && p.provider !== "stripe" && (
                  <div style={{ marginTop: 14 }}>
                    <hr className="sep" />
                    <Form
                      label="线下/人工通道退款执行回执（PayPal / 非 Stripe 渠道）"
                      idempotent
                      run={async (f, key) => {
                        try {
                          const fileEntry = f.get("proof");
                          let evidenceId: string | undefined;
                          if (fileEntry instanceof File && fileEntry.size > 0) {
                            evidenceId = await upload(fileEntry, "attachment");
                          }
                          await request(`/staff/finance/refunds/${rf.id}/execute-manual`, "POST", {
                            manual_refund_ref: text(f, "manual_refund_ref"),
                            ...(evidenceId ? { evidence_media_id: evidenceId } : {}),
                            ...(text(f, "notes") ? { notes: text(f, "notes") } : {}),
                          }, key);
                          setReauthNeeded(false);
                          setNotice("已登记人工退款交易号与凭证并完成支付账本退款状态同步。");
                          reload();
                        } catch (e) {
                          if (e instanceof RequestError && e.code === "STAFF_REAUTH_REQUIRED") setReauthNeeded(true);
                          throw e;
                        }
                      }}
                    >
                      <label>
                        外部退款流水号 / PayPal Refund TX ID
                        <input name="manual_refund_ref" required placeholder="例如 RF-PP-987654321" />
                      </label>
                      <label>
                        上传打款凭证截图或 PDF（可选）
                        <input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" />
                      </label>
                      <label>
                        退款执行说明
                        <input name="notes" placeholder="已通过 PayPal 原路/全额退回客户账号" />
                      </label>
                    </Form>
                  </div>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export function AdminFinanceAnalytics({ demo = false }: { demo?: boolean }) {
  const [includeTest, setIncludeTest] = useState(false);
  const [limit, setLimit] = useState(50);
  const [orderSearch, setOrderSearch] = useState("");
  const [purposeFilter, setPurposeFilter] = useState("all");
  const [chargePage,setChargePage]=useState(1);

  const recon=useLoad("/staff/admin/reconciliation?"+new URLSearchParams({
    include_test:includeTest?"1":"0",q:orderSearch.trim(),purpose:purposeFilter,page:String(chargePage),
  }));
  const ledger = useLoad(`/staff/admin/finance/ledger?include_test=${includeTest ? "1" : "0"}&limit=${limit}`);
  const summary = recon.data?.summary;
  const rows:Row[]=recon.data?.rows??[];
  const ld = ledger.data;
  const ldOrders: Row[] = (ld?.orders ?? []).filter((o: Row) =>
    !orderSearch.trim() || o.public_no.toUpperCase().includes(orderSearch.trim().toUpperCase()) || String(o.receiving_code ?? "").toUpperCase().includes(orderSearch.trim().toUpperCase())
  );

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>业务财务对账与订单贡献毛利</h1>
          <p className="muted">严格区分平台服务收入、代收代付运费（Pass-through）、已退款支出及估算检查工时成本（显式标记估算口径）。</p>
        </div>
        <div className="head-actions">
          <a className="button sm primary" href={`/api/v1/staff/admin/finance/ledger.csv?include_test=${includeTest ? "1" : "0"}&limit=${limit}`}>导出订单账本 CSV</a>
        </div>
      </div>

      <FinanceSubNav active="finance" />

      {demo && (
        <StatusBanner tone="warning" title="口径与演示边界">
          人工工时成本当前按计件模型 <strong>每小时 $15.00 USD 费率估算</strong>（标记为估算值，并非实际工资发放账单）；代收运费按外部承运商实报代收口径独立列示，不计入平台质检毛收入。
        </StatusBanner>
      )}

      {(recon.error || ledger.error) && <ErrorBlock error={recon.error || ledger.error} />}

      <div className="admin-toolbar">
        <label>
          订单 / 客户收件码过滤
          <input type="search" value={orderSearch} maxLength={80} onChange={e=>{setOrderSearch(e.target.value);setChargePage(1);}} placeholder="订单号或客户收件码" />
        </label>
        <label>
          费用类型筛选
          <select value={purposeFilter} onChange={e=>{setPurposeFilter(e.target.value);setChargePage(1);}}>
            <option value="all">全部收费类型</option>
            <option value="inspection">质检服务费</option>
            <option value="dispatch">发运代收运费</option>
            <option value="storage">延期仓储费</option>
          </select>
        </label>
        <label>
          账本统计样本上限
          <select value={String(limit)} onChange={e => setLimit(Number(e.target.value))}>
            <option value="30">最近 30 单</option>
            <option value="50">最近 50 单</option>
            <option value="100">最近 100 单</option>
            <option value="200">最近 200 单</option>
          </select>
        </label>
        <div className="actions">
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={includeTest} onChange={e=>{setIncludeTest(e.target.checked);setChargePage(1);}} />
            <span>包含测试交易</span>
          </label>
          <button type="button" className="button sm" onClick={() => { recon.reload(); ledger.reload(); }}>刷新</button>
        </div>
      </div>

      {summary && (
        <div className="metric-strip" aria-label="对账财务汇总">
          <div className="metric">
            <span>质检服务实收</span>
            <strong><Money cents={summary.inspection_paid_cents ?? 0} align="left" /></strong>
            <small>不含待付及已作废收费</small>
          </div>
          <div className="metric">
            <span>代收发运运费 (Pass-through)</span>
            <strong><Money cents={summary.dispatch_paid_cents ?? 0} align="left" /></strong>
            <small>待分摊余款 <Money cents={summary.unallocated_dispatch_cents ?? 0} align="left" /></small>
          </div>
          <div className="metric">
            <span>延期仓储服务收入</span>
            <strong><Money cents={summary.storage_paid_cents ?? 0} align="left" /></strong>
            <small>按实际入账周期核算</small>
          </div>
          <div className="metric">
            <span>全渠道净收款（扣减退款后）</span>
            <strong><Money cents={summary.net_received_cents ?? 0} align="left" /></strong>
            <small>总实收 <Money cents={summary.paid_cents ?? 0} align="left" /> · 已退 <Money cents={summary.refunded_cents ?? 0} align="left" /></small>
            {(summary.pending_refund_cents??0)>0&&<small>已批准待结算 <Money cents={summary.pending_refund_cents} align="left" /></small>}
          </div>
        </div>
      )}

      {ld && (
        <Panel title={`订单盈利能力与估算工时核算（共 ${ldOrders.length} / ${ld.summary.order_count} 单）`}>
          <div className="metric-strip" style={{ marginBottom: 14 }}>
            <div className="metric"><span>质检净收入</span><strong><Money cents={ld.summary.net_inspection_cents} align="left" /></strong><small>实收扣减退款</small></div>
            <div className="metric"><span>估算工时成本（费率模型）</span><strong><Money cents={ld.summary.total_labor_cost_cents} align="left" /></strong><small>总工时 {(ld.summary.total_inspection_seconds / 60).toFixed(1)} 分钟</small></div>
            <div className="metric"><span>订单估算贡献毛利</span><strong><Money cents={ld.summary.total_contribution_cents} align="left" /></strong>
              <small>已记录渠道手续费 <Money cents={ld.summary.channel_fee_cents??0} align="left"/></small>
              {(ld.summary.orders_pending_stripe_settlement??0)>0&&<small>{ld.summary.orders_pending_stripe_settlement} 单待 Stripe 结算</small>}
              {!ld.summary.recomputable_balanced&&<small>勾稽差异告警</small>}
            </div>
            <div className="metric"><span>渠道流水对账率</span><strong>{ld.summary.all_channel_reconciled ? "全部齐备" : "存在待补凭据"}</strong><small>{ld.summary.include_test ? "含测试单" : "已隔离测试单"}</small></div>
          </div>

          <Table
            headers={["品类", "服务类型", "订单数", "样件数", "实录工时 (分)", "单件平均秒数", "质检净收入", "估算工时成本(估)", "贡献毛利"]}
            rows={(ld.by_category_service ?? []).map((g: Row) => [
              g.category_slug,
              SERVICE_CODE_ZH[g.service_code] ?? g.service_code,
              g.order_count,
              g.sample_count,
              (g.inspection_seconds / 60).toFixed(1),
              `${g.avg_seconds_per_sample}s`,
              <Money key="ni" cents={g.net_inspection_cents} />,
              <Money key="lc" cents={g.labor_cost_cents} />,
              <Money key="c" cents={g.contribution_cents} />,
            ])}
            empty="当前口径下尚无订单盈利数据。"
          />

          <details className="card" style={{ marginTop: 14 }} open={ldOrders.length <= 20}>
            <summary>查看单笔订单收入、退款与估算毛利明细 ({ldOrders.length} 单)</summary>
            <Table
              headers={["订单编号", "客户", "状态", "品类/服务", "件数", "应收报价", "实收质检", "退款", "质检净收", "代收运费", "估算工时(估)", "渠道手续费", "贡献毛利", "渠道对账"]}
              rows={ldOrders.map((o: Row) => [
                <div key="n" className="cell-stack">
                  <Link className="code nowrap" href={`/admin/orders/${o.public_no}`}>{o.public_no}</Link>
                  {o.is_test && <Tag tone="gray">测试</Tag>}
                </div>,
                <span key="c" className="code nowrap">{o.receiving_code ?? "—"}</span>,
                <BizTag key="st" dict={ORDER_STATE_ZH} value={o.state} />,
                `${o.category_slug} / ${SERVICE_CODE_ZH[o.service_code] ?? o.service_code}`,
                o.sample_count,
                <Money key="rec" cents={o.receivable_cents} />,
                <Money key="p" cents={o.inspection_paid_cents} />,
                <Money key="r" cents={o.inspection_refunded_cents} mutedZero />,
                <Money key="n2" cents={o.net_inspection_cents} />,
                <Money key="d" cents={o.pass_through_shipping_cents} mutedZero />,
                <span key="l" className="nowrap"><Money cents={o.labor_cost_cents} align="left" /> <Tag tone="outline">估</Tag></span>,
                <div key="fee" className="cell-stack"><Money cents={o.channel_fee_cents??0} mutedZero/>
                  {o.stripe_settlement_pending_count>0&&<small>Stripe 待结算</small>}
                </div>,
                <Money key="co" cents={o.contribution_cents} />,
                <Tag key="ch" tone={o.channel_reconciled ? "green" : "red"}>{o.channel_reconciled ? "已齐备" : "待核对"}</Tag>,
              ])}
            />
          </details>
        </Panel>
      )}

      <Panel title="收费项分摊与收支勾稽明细" subtitle="按订单或收件码筛选明细。上方总额统计当前环境的全部收费项。">
        {!recon.data&&!recon.error&&<p role="status">正在加载收费明细…</p>}
        {recon.data&&<Table
          headers={["收费编号", "类型", "客户", "原订单 / 分摊订单", "应收金额", "实收", "已退款", "净额", "状态", "关联支付单"]}
          rows={rows.map(r => [
            <CopyId key="id" value={r.charge_item_id} />,
            PURPOSE_ZH[r.purpose] ?? r.purpose,
            <span key="rc" className="code nowrap">{r.receiving_code ?? "—"}</span>,
            <div key="ord" className="cell-stack">
              {r.order_public_no && <Link className="code nowrap" href={`/admin/orders/${r.order_public_no}`}>{r.order_public_no}</Link>}
              {(r.allocations ?? []).filter((a: Row) => a.public_no !== r.order_public_no).map((a: Row) => (
                <small key={a.order_id}>
                  分摊 <Link className="code" href={`/admin/orders/${a.public_no}`}>{a.public_no}</Link> (<Money cents={a.amount_cents} align="left" />)
                </small>
              ))}
              {!r.order_public_no && !(r.allocations ?? []).length && <span className="muted">待分摊</span>}
            </div>,
            <Money key="a" cents={r.amount_cents} currency={r.currency} />,
            <Money key="p" cents={r.paid_cents} currency={r.currency} />,
            <div key="rf" className="cell-stack"><Money cents={r.refunded_cents} currency={r.currency} mutedZero />
              {(r.pending_refund_cents??0)>0&&<small>待结算 <Money cents={r.pending_refund_cents} currency={r.currency} align="left" /></small>}
            </div>,
            <Money key="nt" cents={r.net_cents} currency={r.currency} />,
            <BizTag key="st" dict={PAYMENT_STATE_ZH} value={r.state} />,
            r.payment_id ? <Link key="pay" className="button sm nowrap" href={`/admin/payments/${r.payment_id}`}>{r.payment_display_ref}</Link> : "—",
          ])}
          empty="当前筛选条件下暂无收费分摊记录。"
        />}
        {(chargePage>1||recon.data?.has_more)&&<nav className="actions" aria-label="收费明细分页">
          <button type="button" className="button sm" disabled={chargePage===1} onClick={()=>setChargePage(page=>page-1)}>上一页</button>
          <span>第 {chargePage} 页</span>
          <button type="button" className="button sm" disabled={!recon.data?.has_more} onClick={()=>setChargePage(page=>page+1)}>下一页</button>
        </nav>}
      </Panel>
    </>
  );
}
