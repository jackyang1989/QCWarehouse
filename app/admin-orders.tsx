"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Action,
  CodeButton,
  Empty,
  ErrorBlock,
  Field,
  FileInput,
  Form,
  MediaButton,
  ModalDrawer,
  Panel,
  request,
  StaffObjectDrawer,
  type StaffObjectTarget,
  stamp,
  Table,
  Tag,
  text,
  upload,
  useLoad,
  usd,
  type Row,
} from "./ui";
import {
  AdminTabs,
  AUDIT_ACTION_ZH,
  BizTag,
  CopyId,
  describeOrderNextResponsibility,
  DISPOSITION_ACTION_ZH,
  EmptyState,
  Money,
  ORDER_STATE_ZH,
  PAYMENT_STATE_ZH,
  PURPOSE_ZH,
  REFUND_STATE_ZH,
  REPORT_STATE_ZH,
  SERVICE_CODE_ZH,
  SlaCountdownBadge,
  StatusBanner,
  SYNC_STATE_ZH,
  TASK_STATE_ZH,
  TICKET_CATEGORY_ZH,
  TICKET_STATE_ZH,
  TRANSPORT_STATE_ZH,
  USER_STATUS_ZH,
  WarehouseItemLifecycleTags,
} from "./admin-labels";

export function AdminOrdersWorkbench({
  deskData,
  reloadDesk,
  actor,
}: {
  deskData?: Row;
  reloadDesk: () => void;
  actor?: Row;
}) {
  const canIntakeRoute = Boolean(actor?.roles?.some((r: string) => ["receiver", "warehouse_admin", "super_admin"].includes(r)));
  const searchParams = useSearchParams();
  const initQuery = (searchParams.get("query") ?? "").trim();
  const initState = searchParams.get("state") ?? "";
  const initException = searchParams.get("exception") === "1";
  const rawTest = searchParams.get("test");
  const initTest: "all" | "production" | "test" =
    rawTest === "production" || rawTest === "test" ? rawTest : "all";
  const initTab: "orders" | "exceptions" | "claims" =
    searchParams.get("tab") === "claims"
      ? "claims"
      : initException || searchParams.get("tab") === "exceptions"
        ? "exceptions"
        : "orders";

  const [sectionTab, setSectionTab] = useState<"orders" | "exceptions" | "claims">(initTab);
  const [searchText, setSearchText] = useState(initQuery);
  const [stateFilter, setStateFilter] = useState(initState);
  const [testFilter, setTestFilter] = useState<"all" | "production" | "test">(initTest);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<{
    query: string;
    state: string;
    exception: "all" | "1";
    test: "all" | "production" | "test";
    from: string;
    to: string;
    cursor: string | null;
  }>({
    query: initQuery,
    state: initState,
    exception: initTab === "exceptions" ? "1" : "all",
    test: initTest,
    from: "",
    to: "",
    cursor: null,
  });

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash.startsWith("#case-")) {
      setSectionTab("claims");
      return;
    }
    setSectionTab(initTab);
    setSearchText(initQuery);
    setStateFilter(initState);
    setTestFilter(initTest);
    setApplied(prev => ({
      ...prev,
      query: initQuery,
      state: initState,
      exception: initTab === "exceptions" ? "1" : "all",
      test: initTest,
      cursor: null,
    }));
  }, [initTab, initQuery, initState, initTest]);

  const [drawer, setDrawer] = useState<StaffObjectTarget | null>(null);
  const [bindingPkg, setBindingPkg] = useState<Row | null>(null);
  const [claimNote, setClaimNote] = useState("");
  const [boundOrderNotice, setBoundOrderNotice] = useState("");

  const params = new URLSearchParams({ limit: "30", test: applied.test });
  if (applied.query) params.set("query", applied.query);
  if (applied.state) params.set("state", applied.state);
  if (sectionTab === "exceptions" || applied.exception === "1") params.set("exception", "1");
  if (applied.from) params.set("from", applied.from);
  if (applied.to) params.set("to", applied.to);
  if (applied.cursor) params.set("cursor", applied.cursor);

  const ordersRes = useLoad(sectionTab === "claims" ? null : `/staff/orders?${params.toString()}`);

  const claims: Row[] = deskData?.claims ?? [];
  const pendingClaimsCount = claims.filter((c: Row) => c.can_decide).length;
  const unmatchedPackages: Row[] = deskData?.unmatchedPackages ?? [];
  const rows: Row[] = ordersRes.data?.rows ?? [];

  function submitSearch(e?: React.FormEvent) {
    e?.preventDefault();
    setApplied({
      query: searchText.trim(),
      state: stateFilter,
      exception: sectionTab === "exceptions" ? "1" : "all",
      test: testFilter,
      from,
      to,
      cursor: null,
    });
  }

  function resetSearch() {
    setSearchText("");
    setStateFilter("");
    setTestFilter("all");
    setFrom("");
    setTo("");
    setApplied({ query: "", state: "", exception: sectionTab === "exceptions" ? "1" : "all", test: "all", from: "", to: "", cursor: null });
  }

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>订单中心与包裹认领核验</h1>
          <p className="muted">按业务阶段、客户码、6 类数量口径（委托/预报/实收/核身/已检/差异）、下一步责任方、付款与 SLA 全面追踪每笔订单。</p>
        </div>
        <div className="head-actions">
          <Link className="button sm" href="/admin/customers">客户档案目录</Link>
          <Link className="button sm" href="/admin/inspections">质检与报告监督</Link>
          <button type="button" className="button sm" onClick={() => { ordersRes.reload(); reloadDesk(); }}>刷新订单</button>
        </div>
      </div>

      <AdminTabs
        active={sectionTab}
        onChange={next => {
          setSectionTab(next as "orders" | "exceptions" | "claims");
          setApplied(prev => ({ ...prev, exception: next === "exceptions" ? "1" : "all", cursor: null }));
        }}
        tabs={[
          { id: "orders", label: "全部订单工作队列", count: ordersRes.data && sectionTab === "orders" ? rows.length : undefined },
          {
            id: "exceptions",
            label: "阻塞 / 异常 / SLA 超时",
            count: deskData?.overviewMetrics
              ? Number(applied.test === "production" ? (deskData.overviewMetrics.exception_orders ?? deskData.overviewMetrics.sla_overdue ?? 0) : (deskData.overviewMetrics.exception_orders_all ?? deskData.overviewMetrics.sla_overdue_all ?? 0))
              : undefined,
          },
          { id: "claims", label: "未认领包裹与客户申诉核验", count: pendingClaimsCount || undefined },
        ]}
      />

      {sectionTab !== "claims" && (
        <>
          <form className="admin-toolbar" onSubmit={submitSearch}>
            <label>
              精确检索 (订单号 / 客户码 / 运单 / 实物 / 完整邮箱)
              <input
                type="search"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder="例如 QW-... / QCW-... / 完整运单号或邮箱"
              />
            </label>
            <label>
              业务阶段
              <select value={stateFilter} onChange={e => setStateFilter(e.target.value)}>
                <option value="">全部阶段</option>
                {Object.entries(ORDER_STATE_ZH).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <label>
              环境隔离
              <select value={testFilter} onChange={e => setTestFilter(e.target.value as "all" | "production" | "test")}>
                <option value="all">全部订单 (含测试单)</option>
                <option value="production">仅正式业务单</option>
                <option value="test">仅测试单</option>
              </select>
            </label>
            <label>
              创建起始日期
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </label>
            <label>
              创建截止日期
              <input type="date" value={to} onChange={e => setTo(e.target.value)} />
            </label>
            <div className="actions">
              <button type="submit" className="button primary sm">查询队列</button>
              <button type="button" className="button sm" onClick={resetSearch}>重置</button>
            </div>
          </form>

          {ordersRes.error && <ErrorBlock error={ordersRes.error} />}
          {!ordersRes.data && !ordersRes.error && <p role="status">正在加载订单工作队列…</p>}

          {ordersRes.data && (
            <Panel
              title={sectionTab === "exceptions" ? "待介入处理异常订单" : "订单业务队列"}
              subtitle={`本页展示 ${rows.length} 笔订单；点击订单号进入统一 7 分组详情工作台。`}
            >
              {rows.length === 0 ? (
                <EmptyState
                  kind={applied.query || applied.state || sectionTab === "exceptions" ? "filtered" : "empty"}
                  title={sectionTab === "exceptions" ? "当前没有阻塞或 SLA 超时订单" : "没有符合筛选条件的订单"}
                  description={sectionTab === "exceptions" ? "所有在途质检单均按正常流转推进，可切回「全部订单工作队列」查看完整台账。" : "请核对订单号/客户码拼写（需至少 5 位字符或完整邮箱），或点击重置查看全部订单。"}
                  actionLabel="查看全部订单"
                  onAction={() => { setSectionTab("orders"); resetSearch(); }}
                />
              ) : (
                <>
                  <Table
                    headers={["订单编号", "客户", "服务与品类", "委托 / 预报包裹", "实收 / 核身 / 已检 / 差异", "付款状态", "当前阶段与责任方", "异常与 SLA 时限", "最近更新", "详情"]}
                    rows={rows.map(o => {
                      const expected = Number(o.expected_units ?? 0);
                      const arrived = Number(o.arrived_units ?? 0);
                      const identified = Number(o.identified_units ?? 0);
                      const inspected = Number(o.qa_approved_tasks ?? 0);
                      const diff = arrived - expected;
                      const slaActive = ["queued", "inspecting", "qa_review"].includes(o.state);
                      const resp = describeOrderNextResponsibility(o);
                      const backQuery = params.toString();
                      const detailHref = `/admin/orders/${o.public_no}${backQuery ? `?from_orders=${encodeURIComponent(backQuery)}` : ""}`;
                      return [
                        <div key="no" className="cell-stack">
                          <Link href={detailHref}><strong className="code nowrap">{o.public_no}</strong></Link>
                          <small>{o.is_test ? <Tag tone="gray">测试单</Tag> : "正式订单"}</small>
                        </div>,
                        <div key="cust" className="cell-stack">
                          {o.customer_user_id ? (
                            <Link href={`/admin/customers/${o.customer_user_id}`}><strong className="code nowrap">{o.receiving_code ?? "客户详情"}</strong></Link>
                          ) : <span className="code">{o.receiving_code ?? "—"}</span>}
                          <small>{o.customer_name ?? "客户"}</small>
                        </div>,
                        <div key="srv" className="cell-stack">
                          <span>{o.service_title ?? (SERVICE_CODE_ZH[o.service_code] ?? "质检委托")}</span>
                          <small>{o.category_label ?? "通用/服装"}</small>
                        </div>,
                        <div key="sku" className="cell-stack nowrap">
                          <strong>委托 {expected} 件 ({o.sku_count ?? 1} 组 SKU)</strong>
                          <small>预报包裹 {o.parcel_count ?? 0} 个（到仓 {o.arrived_parcel_count ?? 0}）</small>
                        </div>,
                        <div key="prog" className="cell-stack nowrap">
                          <span>实收 <strong>{arrived}</strong> · 核身 <strong>{identified}</strong> · 已检 <strong>{inspected}</strong></span>
                          <small>
                            {arrived === 0 && Number(o.arrived_parcel_count ?? 0) === 0
                              ? "包裹未到仓"
                              : arrived === 0 && Number(o.arrived_parcel_count ?? 0) > 0
                                ? "包裹已到待拆包登记"
                                : diff === 0 && identified === expected
                                  ? "账实核身一致"
                                  : arrived > identified
                                    ? `待核身 ${arrived - identified} 件${diff < 0 ? ` · 包差/在途 ${Math.abs(diff)} 件` : ""}`
                                    : Number(o.parcel_count ?? 0) === 0 || Number(o.arrived_parcel_count ?? 0) < Number(o.parcel_count ?? 0)
                                      ? `部分到仓（${o.arrived_parcel_count ?? 0}/${o.parcel_count ?? 0} 包）· 待到/待核 ${Math.max(0, expected - arrived)} 件`
                                      : diff < 0
                                        ? `确认实少 ${Math.abs(diff)} 件`
                                        : diff > 0
                                          ? `多收 +${diff} 件`
                                          : "待核对"}
                            {o.report_version ? ` · 已发报告 v${o.report_version}` : ""}
                          </small>
                        </div>,
                        <div key="pay" className="cell-stack">
                          <BizTag dict={PAYMENT_STATE_ZH} value={o.payment_state ?? (o.paid_at ? "paid" : o.state === "draft" ? "open" : "paid")} />
                          {o.price_cents != null && <small><Money cents={o.price_cents} align="left" /></small>}
                        </div>,
                        <div key="st" className="cell-stack">
                          <BizTag dict={ORDER_STATE_ZH} value={o.state} />
                          <small className="muted" title={resp.action}>责任：{resp.owner}</small>
                        </div>,
                        <div key="exc" className="cell-stack">
                          <div className="actions">
                            {o.open_block_count > 0 && <Tag tone="red">阻塞 {o.open_block_count} 项</Tag>}
                            {o.open_ticket_count > 0 && <Tag tone="yellow">工单 {o.open_ticket_count}</Tag>}
                            <SlaCountdownBadge dueAt={o.sla_due_at} active={slaActive} />
                          </div>
                          {o.sla_due_at && <small className="nowrap">截止 {stamp(o.sla_due_at, true)}</small>}
                        </div>,
                        <span key="up" className="nowrap">{stamp(o.updated_at ?? o.created_at, true)}</span>,
                        <Link key="go" className="button sm nowrap" href={detailHref}>进入工作台 →</Link>,
                      ];
                    })}
                  />
                  {(applied.cursor || ordersRes.data.next_cursor) && (
                    <div className="actions" style={{ marginTop: 12 }}>
                      {applied.cursor && (
                        <button type="button" className="button sm" onClick={() => setApplied(p => ({ ...p, cursor: null }))}>返回首页</button>
                      )}
                      {(() => {
                        const nextCursor = ordersRes.data?.next_cursor;
                        return nextCursor ? (
                          <button type="button" className="button sm" onClick={() => setApplied(p => ({ ...p, cursor: nextCursor }))}>下一页 →</button>
                        ) : null;
                      })()}
                    </div>
                  )}
                </>
              )}
            </Panel>
          )}
        </>
      )}

      {sectionTab === "claims" && (
        <>
          <Panel title="客户未认领包裹认领审核" subtitle="核对客户提交的购买与快递运单凭证与仓库外箱实收照片，确认归属后才可绑定客户档案。">
            {claimNote && <StatusBanner tone="success" title="核验结果">{claimNote}</StatusBanner>}
            {claims.length === 0 ? (
              <EmptyState title="暂无包裹认领申诉" description="客户未在工作台发起认领申诉时队列为空。" />
            ) : (
              claims.map(claim => (
                <div className="card" id={"case-" + claim.id} key={claim.id} style={{ marginBottom: 12 }}>
                  <div className="row between flexwrap" style={{ marginBottom: 8 }}>
                    <div className="actions">
                      <Link className="code" href={`/admin/tickets/${claim.id}`}><strong>{claim.public_no}</strong></Link>
                      <BizTag dict={TICKET_STATE_ZH} value={claim.state} />
                      <span>运单：<CodeButton code={claim.tracking_no} onClick={() => setDrawer({ kind: "tracking", ref: claim.tracking_no })} /></span>
                      <span>承运商：{claim.carrier_code}</span>
                    </div>
                    <div className="actions">
                      {claim.proof_id && <MediaButton ids={[claim.proof_id]} label="查看客户发货凭证" />}
                      {claim.outer_photo_ids?.length > 0 && <MediaButton ids={claim.outer_photo_ids} label={`查看仓库外箱实拍照 (${claim.outer_photo_ids.length})`} />}
                    </div>
                  </div>
                  {claim.can_decide ? (
                    <div className="actions">
                      <Action primary sm run={async () => {
                        if (!claim.outer_photo_ids?.length) throw new Error("先确认实物入库及外箱实收凭证后再确认归属。");
                        await request(`/staff/intake-claims/${claim.id}/decision`, "POST", { decision: "approve", reason: "核对发货凭证与仓库外箱实收匹配，确认归属" });
                        setClaimNote(`已批准申诉 ${claim.public_no} 并将包裹绑定至客户档案。`);
                        reloadDesk();
                      }}>批准归属并绑定客户</Action>
                      <Action sm run={async () => {
                        const reason = window.prompt("请输入驳回申诉理由（至少 4 字）：", "凭证运单或实物外箱核验不一致");
                        if (!reason || reason.trim().length < 4) return;
                        await request(`/staff/intake-claims/${claim.id}/decision`, "POST", { decision: "reject", reason: reason.trim() });
                        setClaimNote(`已驳回申诉 ${claim.public_no}，保留原未认领件隔离状态。`);
                        reloadDesk();
                      }}>驳回认领申诉</Action>
                    </div>
                  ) : (
                    <p className="muted">审核决定：{claim.decision === "approve" ? "已确认归属" : claim.decision === "reject" ? "已驳回" : "已结案"}</p>
                  )}
                </div>
              ))
            )}
          </Panel>

          <Panel title={`待人工绑定客户的无主实收包裹 (${unmatchedPackages.length})`} subtitle="仓库收到无收件码或未知客户包裹时，需核验或补拍外箱面单凭证后再绑定客户专属收件码。">
            {boundOrderNotice && <StatusBanner tone="success" title="绑定结果">{boundOrderNotice}</StatusBanner>}
            <Table
              headers={["包裹编号", "承运商 / 运单号", "实收凭证与状况", "实收时间", "人工核验操作"]}
              rows={unmatchedPackages.map(pkg => [
                canIntakeRoute
                  ? <Link key="p" className="code nowrap" href={`/wh/packages/${pkg.code}`}>{pkg.code}</Link>
                  : <CodeButton key="p" code={pkg.code} onClick={() => setDrawer({ kind: "package", ref: pkg.code })} />,
                <span key="t" className="code nowrap">{pkg.tracking_norm ?? "无运单号"}</span>,
                <div key="m" className="cell-stack">
                  <span>{pkg.condition_note ?? "无异常备注"}{pkg.location_code ? ` · ${pkg.location_code}` : ""}</span>
                  {(pkg.outer_photo_ids?.length ?? 0) > 0 && <MediaButton ids={pkg.outer_photo_ids} label={`实收外箱照 (${pkg.outer_photo_ids.length})`} />}
                </div>,
                stamp(pkg.received_at, true),
                <button
                  key="bind"
                  type="button"
                  className="button sm primary nowrap"
                  onClick={() => setBindingPkg(pkg)}
                >核验并绑定客户 →</button>,
              ])}
              empty="当前没有待认领归属的在库无主包裹。"
            />
          </Panel>
        </>
      )}

      <ModalDrawer
        open={Boolean(bindingPkg)}
        onClose={() => setBindingPkg(null)}
        title={bindingPkg ? `无主包裹人工绑定客户 · ${bindingPkg.code}` : ""}
        subtitle={bindingPkg ? `运单号：${bindingPkg.tracking_norm ?? "无运单号"} · 库位：${bindingPkg.location_code ?? "未分配"}` : ""}
      >
        {bindingPkg && (
          <>
            {(bindingPkg.outer_photo_ids?.length ?? 0) > 0 && (
              <div className="actions" style={{ marginBottom: 12 }}>
                <MediaButton ids={bindingPkg.outer_photo_ids} label={`核对仓库外箱实拍照 (${bindingPkg.outer_photo_ids.length})`} />
              </div>
            )}
            <Form
              key={`bind-${bindingPkg.id}-${bindingPkg.revision}`}
              label="确认绑定客户"
              run={async f => {
                const file = f.get("photo");
                if (!(file instanceof File) || file.size === 0) {
                  throw new Error("请上传外箱/面单核验凭证照片 (label_photo) 后再确认归属绑定。");
                }
                const proofId = await upload(file, "label_photo");
                const res = await request(`/staff/packages/${bindingPkg.id}/bind-owner`, "POST", {
                  revision: Number(bindingPkg.revision ?? 1),
                  receiving_code: text(f, "receiving_code").toUpperCase(),
                  reason: text(f, "reason"),
                  evidence_ids: [proofId],
                });
                setBoundOrderNotice(`包裹 ${bindingPkg.code} 已安全绑定至 ${res.receiving_code}`);
                setBindingPkg(null);
                reloadDesk();
              }}
            >
              <Field name="receiving_code" label="客户收件码 (例如 QCW56084 或 @QCW56084@)" />
              <Field name="reason" label="核实依据说明（审计必填）" value="人工核验客户凭证及卖家订单确认" />
              <label>面单收件码核对照（必填）<FileInput name="photo" accept="image/*" required /></label>
            </Form>
          </>
        )}
      </ModalDrawer>

      <StaffObjectDrawer target={drawer} actor={actor} onClose={() => setDrawer(null)} />
    </>
  );
}

export function OrderRefundDesk({ number, onDone }: { number: string; onDone?: () => void }) {
  const { data, error, reload } = useLoad(`/staff/orders/by-number/${number}/refund-options`);
  const [requested, setRequested] = useState<string>();
  const rows: Row[] = data?.rows ?? [];
  const stage = data?.stage_preview;

  return (
    <Panel title="依据服务执行阶段发起退款申请" subtitle="支持客服/运营按真实实付余额发起退款申请，提交后由独立超管审核批准（禁止自申自审）。">
      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在加载可退支付余额与服务阶段策略…</p>}
      {stage && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <strong>当前服务阶段退费政策：</strong>{stage.policy_summary} · 建议退款比例 <strong>{stage.refund_rate_pct}%</strong>（参考可退 <Money cents={stage.recommended_refund_cents} align="left" />）
        </div>
      )}
      {data && rows.length === 0 && <Empty>该订单尚无可用可退余额的成功付款记录。</Empty>}
      {rows.map(payment => (
        <details className="card" key={payment.id} open={rows.length === 1}>
          <summary>
            <span>
              支付单 <strong className="code">PAY-{String(payment.id).replace(/-/g, "").slice(0, 8).toUpperCase()}</strong> · 实付 <Money cents={payment.amount_cents} align="left" /> · 剩余可退{" "}
              <Money cents={payment.refundable_cents} align="left" />
            </span>
            <BizTag dict={PAYMENT_STATE_ZH} value={payment.state} />
          </summary>
          {payment.refundable_cents > 0 ? (
            <Form
              label="提交退款申请至独立审批队列"
              run={async fields => {
                const orderId = data?.order?.id;
                if (!orderId) return;
                const cents = Math.round(Number(text(fields, "dollars")) * 100);
                if (!Number.isFinite(cents) || cents <= 0 || cents > payment.refundable_cents) {
                  throw new Error(`退款金额须大于 $0.00 且不超过剩余可退余额 $${(payment.refundable_cents / 100).toFixed(2)}。`);
                }
                const result = await request(`/staff/orders/${orderId}/refunds`, "POST", {
                  payment_id: payment.id,
                  amount_cents: cents,
                  reason: text(fields, "reason"),
                });
                setRequested(result.refund_id);
                reload();
                onDone?.();
              }}
            >
              <div className="fields">
                <Field
                  label="申请退款金额 (USD 美元，例如 29.00)"
                  name="dollars"
                  type="number"
                  step="0.01"
                  min={0.01}
                  max={payment.refundable_cents / 100}
                  value={(payment.refundable_cents / 100).toFixed(2)}
                />
                <Field label="退款原因与证据说明" name="reason" />
              </div>
            </Form>
          ) : (
            <p className="muted">该笔支付的可退余额已全额用尽或已被批准中退款占用。</p>
          )}
        </details>
      ))}
      {requested && (
        <StatusBanner tone="success" title="退款申请已登记">
          退款单 <Link className="code" href={`/admin/refunds/${requested}`}>RFD-{requested.replace(/-/g, "").slice(0, 8).toUpperCase()}</Link> 已进入独立审批队列。{" "}
          <Link href={`/admin/refunds/${requested}`}>前往退款决策工作台查看 →</Link>
        </StatusBanner>
      )}
    </Panel>
  );
}

export function AdminOrderDetailWorkbench({ number, actor }: { number: string; actor?: Row }) {
  const canIntakeRoute = Boolean(actor?.roles?.some((r: string) => ["receiver", "warehouse_admin", "super_admin"].includes(r)));
  const canDispatchRoute = Boolean(actor?.roles?.some((r: string) => ["warehouse_admin", "super_admin"].includes(r)));
  const searchParams = useSearchParams();
  const fromOrders = searchParams.get("from_orders") ?? "";
  const backHref = fromOrders ? `/admin/orders?${fromOrders}` : "/admin/orders";
  const { data, error, reload } = useLoad(`/staff/orders/by-number/${number}`);
  const [tab, setTab] = useState("overview");
  const [drawer, setDrawer] = useState<StaffObjectTarget | null>(null);
  const [actionNotice, setActionNotice] = useState("");

  const order = data?.order;
  const cust = data?.customer;
  const skuSummary = data?.expected_lines_summary;
  const breakdown: Row[] = skuSummary?.lines_breakdown ?? [];
  const evidences: Row[] = skuSummary?.purchase_evidences ?? [];
  const parcelRecons: Row[] = skuSummary?.parcel_reconciliation ?? [];
  const tasks: Row[] = data?.tasks ?? [];
  const reports: Row[] = data?.reports ?? [];
  const charges: Row[] = data?.charges ?? [];
  const payments: Row[] = data?.payments ?? [];
  const refunds: Row[] = data?.refunds ?? [];
  const openBlocks = (data?.blocks ?? []).filter((b: Row) => !b.resolved_at);
  const nextResp = order
    ? describeOrderNextResponsibility({
      state: order.state,
      open_block_count: openBlocks.length,
      arrived_units: skuSummary?.logged_units_total ?? 0,
      identified_units: skuSummary?.identified_units_total ?? 0,
      expected_units: skuSummary?.expected_units_total ?? 0,
    })
    : null;

  return (
    <>
      <div className="page-head row">
        <div>
          <Link href={backHref}>← 返回订单队列</Link>
          <h1 style={{ marginTop: 6 }}>
            订单详情工作台 · <span className="code">{order?.public_no ?? number}</span>
          </h1>
          {order && (
            <div className="actions" style={{ marginTop: 6 }}>
              <BizTag dict={ORDER_STATE_ZH} value={order.state} />
              {data.is_test && <Tag tone="gray">测试订单</Tag>}
              {openBlocks.length > 0 && <Tag tone="red">当前阻塞 {openBlocks.length} 项</Tag>}
              {nextResp && <Tag tone={nextResp.tone}>下一步责任方：{nextResp.owner}（{nextResp.action}）</Tag>}
              {cust?.id && (
                <Link className="button sm" href={`/admin/customers/${cust.id}`}>
                  客户 {cust.receiving_code} ({cust.display_name ?? cust.email})
                </Link>
              )}
            </div>
          )}
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新订单事实</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在加载订单全链路工作台数据…</p>}

      {data && order && (
        <>
          {actionNotice && <StatusBanner tone="success" title="受控状态更新成功">{actionNotice}</StatusBanner>}

          <div className="metric-strip" aria-label="订单 6 维数量与执行关键指标">
            <div className="metric">
              <span>① 委托 / ② 预报包裹</span>
              <strong>{skuSummary?.expected_units_total ?? 0} 件 ({skuSummary?.expected_lines_count ?? 0} 组 SKU)</strong>
              <small>已预报包裹 {data.parcels.length} 个（已到仓 {data.parcels.filter((p: Row) => Boolean(p.code)).length} 个）</small>
            </div>
            <div className="metric">
              <span>③ 实收 / ④ 核身 / ⑤ 已检 / ⑥ 差异</span>
              <strong>实收 {skuSummary?.logged_units_total ?? 0} · 核身 {skuSummary?.identified_units_total ?? 0} · 已检 {skuSummary?.inspected_units_total ?? 0}</strong>
              <small>
                {(skuSummary?.confirmed_short_units_total ?? 0) > 0
                  ? `仓库确认实少 ${skuSummary.confirmed_short_units_total} 件`
                  : (skuSummary?.unidentified_units_total ?? 0) > 0
                    ? `待 SKU 核身 ${skuSummary.unidentified_units_total} 件${(skuSummary?.unverified_short_units_total ?? 0) > 0 ? ` · 包差/在途 ${skuSummary.unverified_short_units_total} 件` : ""}`
                    : (skuSummary?.unverified_short_units_total ?? 0) > 0
                      ? `未核实差异 ${skuSummary.unverified_short_units_total} 件`
                      : (skuSummary?.unarrived_units_total ?? 0) > 0
                        ? `未到仓 ${skuSummary.unarrived_units_total} 件`
                        : "实收与核身口径无差异"}
              </small>
            </div>
            <div className="metric">
              <span>订单金额 / 实付</span>
              <strong><Money cents={data.price_cents} align="left" /></strong>
              <small>{data.paid_at ? `已付款 ${stamp(data.paid_at, true)}` : "待付款确认"}</small>
            </div>
            <div className="metric">
              <span>SLA 承诺与报告状态</span>
              <strong style={{ fontSize: 17 }}>{data.report_published_at ? `已发布 v${reports[0]?.published_version ?? 1}` : (data.sla_due_at ? stamp(data.sla_due_at, true) : "待排期")}</strong>
              <small>{data.hold_reason ? `阻塞原因：${data.hold_reason}` : `当前版本 v${order.revision}`}</small>
            </div>
          </div>

          <AdminTabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: "overview", label: "概览与受控流转", count: openBlocks.length || undefined },
              { id: "items", label: "SKU 对账与采购凭证", count: breakdown.length },
              { id: "parcels", label: "包裹清点与实物", count: data.parcels.length },
              { id: "inspection", label: "质检任务与报告", count: tasks.length },
              { id: "handling", label: "处置留样与出库", count: (data.dispositions ?? []).length + (data.shipments ?? []).length },
              { id: "billing", label: "报价与财务账本", count: payments.length + refunds.length },
              { id: "support", label: "工单与操作时间线", count: data.tickets.length },
            ]}
          />

          {tab === "overview" && (
            <div className="admin-split-detail">
              <div className="admin-detail-main">
                <Panel title="订单基本信息与关键时间节点">
                  <dl className="admin-kv-grid">
                    <div className="admin-kv-item"><dt>订单编号</dt><dd><CopyId value={order.public_no} short={false} /></dd></div>
                    <div className="admin-kv-item"><dt>当前业务阶段</dt><dd><BizTag dict={ORDER_STATE_ZH} value={order.state} /></dd></div>
                    <div className="admin-kv-item"><dt>创建时间</dt><dd>{stamp(data.created_at, true)}</dd></div>
                    <div className="admin-kv-item"><dt>付款确认时间</dt><dd>{data.paid_at ? stamp(data.paid_at, true) : "—"}</dd></div>
                    <div className="admin-kv-item"><dt>样件全部核身就绪</dt><dd>{data.samples_ready_at ? stamp(data.samples_ready_at, true) : "—"}</dd></div>
                    <div className="admin-kv-item"><dt>SLA 截至时间</dt><dd>{data.sla_due_at ? stamp(data.sla_due_at, true) : "—"}</dd></div>
                    <div className="admin-kv-item"><dt>报告发布时间</dt><dd>{data.report_published_at ? stamp(data.report_published_at, true) : "—"}</dd></div>
                    <div className="admin-kv-item"><dt>结案归档时间</dt><dd>{data.closed_at ? stamp(data.closed_at, true) : "—"}</dd></div>
                  </dl>
                  {data.customer_notes && (
                    <div className="notice" style={{ marginTop: 14 }}>
                      <strong>客户下单补充说明：</strong>{data.customer_notes}
                    </div>
                  )}
                </Panel>

                <Panel title="订单阻塞记录 (Order Blocks)" subtitle="所有异常阻塞均由业务事件打开与关闭，禁止后台直接下拉覆盖订单状态。">
                  <Table
                    headers={["阻塞原因", "打开时间", "解除时间"]}
                    rows={(data.blocks ?? []).map((b: Row) => [
                      <Tag key="r" tone={b.resolved_at ? "gray" : "red"}>{b.reason}</Tag>,
                      stamp(b.opened_at, true),
                      b.resolved_at ? stamp(b.resolved_at, true) : <Tag key="o" tone="yellow">尚未解除</Tag>,
                    ])}
                    empty="当前订单无任何历史或未解决的阻塞记录。"
                  />
                </Panel>
              </div>

              <div className="admin-detail-side">
                <Panel title="所属客户信息">
                  {cust ? (
                    <dl className="admin-kv-grid">
                      <div className="admin-kv-item"><dt>客户收件码</dt><dd><Link className="code" href={`/admin/customers/${cust.id}`}>{cust.receiving_code}</Link></dd></div>
                      <div className="admin-kv-item"><dt>账号状态</dt><dd><BizTag dict={USER_STATUS_ZH} value={cust.status} /></dd></div>
                      <div className="admin-kv-item"><dt>客户邮箱</dt><dd>{cust.email ?? "—"}</dd></div>
                      <div className="admin-kv-item"><dt>昵称</dt><dd>{cust.display_name ?? "—"}</dd></div>
                    </dl>
                  ) : <Empty>未查询到客户档案</Empty>}
                </Panel>

                <Panel title="受控业务操作" subtitle="仅开放符合当前状态机的合法受控命令，记录审计原因与时间补偿。">
                  {order.state === "on_hold" && (
                    <Form
                      label="确认原因并恢复订单流转"
                      run={async f => {
                        await request(`/staff/orders/${order.id}/resume`, "POST", { reason: text(f, "reason") });
                        setActionNotice("订单已恢复正常状态流转，SLA 顺延时间已记录。");
                        reload();
                      }}
                    >
                      <Field label="恢复流转依据" name="reason" />
                    </Form>
                  )}
                  {["awaiting_payment", "awaiting_samples", "samples_ready", "queued", "inspecting", "qa_review"].includes(order.state) && (
                    <Form
                      label="暂停订单并锁定出库 (Hold)"
                      run={async f => {
                        await request(`/staff/orders/${order.id}/hold`, "POST", { reason: text(f, "reason") });
                        setActionNotice("订单已进入受控暂停（on_hold）并写入审计台账。");
                        reload();
                      }}
                    >
                      <Field label="暂停原因（将冻结下游作业）" name="reason" />
                    </Form>
                  )}
                  {["report_ready", "action_pending"].includes(order.state) && (
                    <div className="actions" style={{ marginTop: 10 }}>
                      <Action primary run={async () => {
                        await request(`/staff/orders/${order.id}/close`, "POST", { revision: order.revision });
                        setActionNotice("所有件后处置与账务均已结清，订单已正式完结。");
                        reload();
                      }}>验证条件并完结关闭订单</Action>
                    </div>
                  )}
                </Panel>
              </div>
            </div>
          )}

          {tab === "items" && (
            <>
              <Panel title="SKU / 颜色 / 尺码双轨对账明细" subtitle="对比客户申报预期明细（委托数量）与仓库实际清点、SKU 核身及检验结果，绝不覆盖原始申报数量。">
                {skuSummary?.has_intake_discrepancy && (
                  <StatusBanner tone="warning" title="检测到收货数量或外箱异常差异">
                    委托总计 {skuSummary.expected_units_total} 件，仓库累计实收 {skuSummary.logged_units_total} 件，已核身 {skuSummary.identified_units_total} 件
                    {skuSummary.confirmed_short_units_total > 0 ? `，仓库已确认短缺 ${skuSummary.confirmed_short_units_total} 件` : ""}
                    {(skuSummary.unverified_short_units_total ?? 0) > 0 ? `，未核实包差/在途差 ${skuSummary.unverified_short_units_total} 件` : ""}
                    {skuSummary.unidentified_units_total > 0 ? `（尚有 ${skuSummary.unidentified_units_total} 件在库待 SKU 核身）` : ""}。
                  </StatusBanner>
                )}
                <Table
                  headers={["商品 / SKU", "颜色 / 尺码", "供应商", "关联预报运单", "委托数", "已关联 / 核身", "待核身", "确认短缺 / 未核实差", "破损", "已检验", "关联实物码"]}
                  rows={breakdown.map(b => [
                    <div key="sku" className="cell-stack">
                      <strong>{b.product_name || "标准商品"}</strong>
                      <small className="code">{b.sku_code || b.expected_line_id}</small>
                    </div>,
                    `${b.color_declared || "—"} / ${b.size_label || "—"}`,
                    b.supplier_alias || "—",
                    b.tracking_no ? <CodeButton key="tr" code={b.tracking_no} onClick={() => setDrawer({ kind: "tracking", ref: b.tracking_no })} /> : "未拆分包裹",
                    b.expected_qty,
                    b.identified_qty,
                    b.unidentified_pending_qty > 0 ? <Tag tone="yellow">{b.unidentified_pending_qty}</Tag> : 0,
                    b.confirmed_short_qty > 0
                      ? <Tag tone="red">确认少 {b.confirmed_short_qty}</Tag>
                      : b.unverified_short_qty > 0
                        ? <Tag tone="yellow">差 {b.unverified_short_qty} (待核)</Tag>
                        : b.missing_qty > 0
                          ? <Tag tone="red">{b.missing_qty}</Tag>
                          : 0,
                    b.damaged_qty > 0 ? <Tag tone="red">{b.damaged_qty}</Tag> : 0,
                    b.inspected_qty,
                    <div key="itms" className="actions">
                      {(b.linked_item_codes ?? []).slice(0, 4).map((cd: string) => (
                        <CodeButton key={cd} code={cd} onClick={() => setDrawer({ kind: "item", ref: cd })} />
                      ))}
                      {(b.linked_item_codes ?? []).length > 4 && <small className="muted">+{b.linked_item_codes.length - 4}</small>}
                      {!(b.linked_item_codes ?? []).length && <span className="muted">—</span>}
                    </div>,
                  ])}
                  empty="暂无 SKU 明细行数据。"
                />
              </Panel>

              <Panel title={`客户提交采购原始凭证与人工确认状态 (${evidences.length})`} subtitle="截图/PDF 仅作为原始采购证据留档，经客户结构化确认的 SKU 行方可用于报价与仓库核身。">
                <Table
                  headers={["文件 / 凭证编号", "采购平台 / 供应商", "解析与确认状态", "附件证据"]}
                  rows={evidences.map((ev, idx) => [
                    <CopyId key="id" value={ev.media_id ?? `EV-${idx + 1}`} />,
                    `${ev.platform ?? "订单截图"} · ${ev.supplier_alias ?? "未标注"}`,
                    <Tag key="st" tone={ev.confirmed_by_customer ? "green" : "yellow"}>{ev.confirmed_by_customer ? "客户已人工核对确认" : (ev.extraction_status ?? "仅作原始凭据附件")}</Tag>,
                    ev.media_id ? <MediaButton key="m" ids={[ev.media_id]} label="查看采购截图凭证" /> : "—",
                  ])}
                  empty="客户提交该订单时未附带采购截图文件（直接以结构化明细提交）。"
                />
              </Panel>
            </>
          )}

          {tab === "parcels" && (
            <>
              <Panel title={`预报包裹与到货清点对账 (${data.parcels.length})`}>
                <Table
                  headers={["运单号", "承运商", "物流与同步状态", "实收包裹编号", "实收件数 / 申报", "外箱 / 重量", "收货时间", "拆包/外箱照片"]}
                  rows={data.parcels.map((p: Row) => {
                    const pr = parcelRecons.find(x => x.tracking_norm === p.tracking_norm);
                    return [
                      <CodeButton key="tr" code={p.tracking_norm} onClick={() => setDrawer({ kind: "tracking", ref: p.tracking_norm })} />,
                      p.carrier_name ?? p.carrier_code ?? "—",
                      <div key="ts" className="cell-stack">
                        <BizTag dict={TRANSPORT_STATE_ZH} value={p.transport_state} />
                        <BizTag dict={SYNC_STATE_ZH} value={p.sync_state} />
                      </div>,
                      p.code
                        ? (canIntakeRoute
                          ? <Link key="pk" className="code" href={`/wh/packages/${p.code}`}>{p.code}</Link>
                          : <CodeButton key="pk" code={p.code} onClick={() => setDrawer({ kind: "package", ref: p.code })} />)
                        : <Tag tone="yellow">尚未收货入库</Tag>,
                      p.code ? `${p.logged_item_count ?? p.received_quantity ?? 0} 件 (${pr?.declared_qty ? `申报 ${pr.declared_qty}` : "多箱混装"})` : "—",
                      p.code ? `${p.outer_condition ?? "intact"} · ${p.weight_g ? `${p.weight_g}g` : "未称重"}` : "—",
                      stamp(p.received_at, true),
                      p.media_ids?.length > 0 ? <MediaButton key="m" ids={p.media_ids} label={`查看照片 (${p.media_ids.length})`} /> : "—",
                    ];
                  })}
                  empty="客户尚未登记卖家快递运单。"
                />
              </Panel>

              <Panel title={`在单实物条码明细 (${data.items.length})`}>
                <Table
                  headers={["实物编号", "序号", "SKU / 颜色 / 尺码", "来源包裹", "保管与核身状态", "检验阶段", "当前库位"]}
                  rows={data.items.map((item: Row) => {
                    const df = (item.declared_fields ?? {}) as Row;
                    return [
                      <div key="c" className="actions">
                        <CodeButton code={item.code} onClick={() => setDrawer({ kind: "item", ref: item.code })} />
                        {canIntakeRoute && <Link className="small" href={`/wh/samples/${item.code}`}>工作台</Link>}
                      </div>,
                      `#${item.position}`,
                      `${df.sku_code ?? df.sample_code ?? "—"} · ${df.color_declared ?? df.color ?? "—"} / ${df.size_label ?? "—"}`,
                      <CodeButton key="pk" code={item.package_code} onClick={() => setDrawer({ kind: "package", ref: item.package_code })} />,
                      <WarehouseItemLifecycleTags key="st" item={{ ...item, order_no: order.public_no }} compact />,
                      <Tag key="in" tone={item.inspection_stage === "inspected" ? "green" : "blue"}>
                        {item.inspection_stage === "inspected" ? "已完成检验" : item.inspection_stage === "in_inspection" ? "检验进行中" : "待检验"}
                      </Tag>,
                      item.location ?? "—",
                    ];
                  })}
                  empty="尚未分配实物入此订单。"
                />
              </Panel>
            </>
          )}

          {tab === "inspection" && (
            <div className="ops-columns">
              <Panel title={`质检任务列表 (${tasks.length})`}>
                <Table
                  headers={["任务监督入口", "关联实物", "检查模板", "检查员", "状态", "检查项 / 证据"]}
                  rows={tasks.map(t => [
                    <Link key="id" className="code nowrap" href={`/admin/inspections/tasks/${t.id}`}><strong>TSK-{t.id.slice(0, 8).toUpperCase()}</strong></Link>,
                    t.item_code ? <CodeButton key="it" code={t.item_code} onClick={() => setDrawer({ kind: "item", ref: t.item_code })} /> : (t.is_group_task ? <Tag tone="blue">同框对比/留样组</Tag> : "—"),
                    `${t.template_key} v${t.template_version}`,
                    t.assignee_name ?? "未领取",
                    <BizTag key="st" dict={TASK_STATE_ZH} value={t.state} />,
                    `${t.result_count} 项 · ${t.evidence_count} 图`,
                  ])}
                  empty="样件全部核身就绪后系统会自动生成质检任务。"
                />
              </Panel>

              <Panel title={`报告版本与 QA 复核历史 (${reports.length})`}>
                <Table
                  headers={["报告编号", "版本", "状态", "提交人 / QA 复核人", "发布时间", "详情"]}
                  rows={reports.map(r => [
                    <span key="no" className="code">{r.report_no}</span>,
                    `v${r.version}`,
                    <BizTag key="st" dict={REPORT_STATE_ZH} value={r.state} />,
                    `${r.created_by_name ?? "—"} / ${r.reviewed_by_name ?? "待复核"}`,
                    stamp(r.published_at ?? r.created_at, true),
                    <Link key="go" className="button sm nowrap" href={`/wh/review/${r.version_id}`}>打开报告复核台</Link>,
                  ])}
                  empty="检查任务全部提交后由检查员生成报告草稿。"
                />
              </Panel>
            </div>
          )}

          {tab === "handling" && (
            <div className="ops-columns">
              <Panel title={`检后客户处置指令 (${(data.dispositions ?? []).length})`}>
                <Table
                  headers={["实物编码", "处置方向", "处置状态", "发运批次"]}
                  rows={(data.dispositions ?? []).map((dp: Row) => [
                    <CodeButton key="it" code={dp.item_code} onClick={() => setDrawer({ kind: "item", ref: dp.item_code })} />,
                    DISPOSITION_ACTION_ZH[dp.action] ?? dp.action,
                    <Tag key="st">{dp.state}</Tag>,
                    dp.batch_id
                      ? (canDispatchRoute
                        ? <Link key="b" className="code" href={`/wh/dispatch/${dp.batch_id}`}>批次 #{String(dp.batch_id).slice(0, 8)} ({dp.batch_state})</Link>
                        : <CodeButton key="b" code={`批次 #${String(dp.batch_id).slice(0, 8)} (${dp.batch_state})`} onClick={() => setDrawer({ kind: "batch", ref: String(dp.batch_id) })} />)
                      : "—",
                  ])}
                  empty="报告发布后客户暂未提交检后处置指令。"
                />
              </Panel>

              <Panel title={`出库发运物流 (${(data.shipments ?? []).length})`}>
                <Table
                  headers={["出库运单号", "承运商", "用途", "物流状态", "交接时间", "详情"]}
                  rows={(data.shipments ?? []).map((s: Row) => [
                    s.tracking_norm ? <CodeButton key="tr" code={s.tracking_norm} onClick={() => setDrawer({ kind: "tracking", ref: s.tracking_norm })} /> : "待填单",
                    s.carrier_code ?? "—",
                    DISPOSITION_ACTION_ZH[s.action] ?? s.action,
                    <Tag key="st">{s.state}</Tag>,
                    stamp(s.shipped_at, true),
                    canDispatchRoute
                      ? <Link key="b" className="button sm" href={`/wh/dispatch/${s.batch_id}`}>出库工作台</Link>
                      : <CodeButton key="b" code={`批次 #${String(s.batch_id).slice(0, 8)}`} onClick={() => setDrawer({ kind: "batch", ref: String(s.batch_id) })} />,
                  ])}
                  empty="该订单尚未发生出库发运交接。"
                />
              </Panel>
            </div>
          )}

          {tab === "billing" && (
            <>
              <div className="ops-columns">
                <Panel title={`报价与收费单 (${charges.length})`}>
                  <Table
                    headers={["收费用途", "报价版本", "应收金额", "收费状态", "关联支付单"]}
                    rows={charges.map(c => [
                      PURPOSE_ZH[c.purpose] ?? c.purpose,
                      c.quote_revision ? `v${c.quote_revision}` : "—",
                      <Money key="amt" cents={c.amount_cents} currency={c.currency} />,
                      <BizTag key="st" dict={PAYMENT_STATE_ZH} value={c.voided_at ? "void" : (c.applied_payment_id || c.free_authorization) ? "paid" : "open"} />,
                      c.applied_payment_id ? <Link key="p" className="code" href={`/admin/payments/${c.applied_payment_id}`}>查看支付详情</Link> : "—",
                    ])}
                    empty="尚未生成收费单。"
                  />
                </Panel>

                <Panel title={`支付流水与退款明细 (${payments.length} / ${refunds.length})`}>
                  <Table
                    headers={["支付单", "用途", "金额", "支付状态", "已成功退款", "详情"]}
                    rows={payments.map(p => [
                      <Link key="id" className="code" href={`/admin/payments/${p.id}`}>{p.display_ref}</Link>,
                      PURPOSE_ZH[p.purpose] ?? p.purpose,
                      <Money key="amt" cents={p.amount_cents} currency={p.currency} />,
                      <BizTag key="st" dict={PAYMENT_STATE_ZH} value={p.state} />,
                      <Money key="rf" cents={p.refunded_cents} currency={p.currency} mutedZero />,
                      <Link key="go" className="button sm" href={`/admin/payments/${p.id}`}>支付详情</Link>,
                    ])}
                    empty="尚无支付记录。"
                  />
                  {refunds.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <strong className="small">关联退款记录 ({refunds.length})：</strong>
                      <Table
                        headers={["退款单", "申请金额", "审批状态", "原因", "详情"]}
                        rows={refunds.map(rf => [
                          <Link key="id" className="code" href={`/admin/refunds/${rf.id}`}>{rf.display_ref}</Link>,
                          <Money key="a" cents={rf.amount_cents} />,
                          <BizTag key="s" dict={REFUND_STATE_ZH} value={rf.state} />,
                          rf.reason,
                          <Link key="go" className="button sm" href={`/admin/refunds/${rf.id}`}>审批详情</Link>,
                        ])}
                      />
                    </div>
                  )}
                </Panel>
              </div>
              <div id="tab-billing">
                <OrderRefundDesk number={number} onDone={reload} />
              </div>
            </>
          )}

          {tab === "support" && (
            <div className="ops-columns">
              <Panel title={`关联客服工单 (${data.tickets.length})`}>
                <Table
                  headers={["工单号", "分类", "主题", "状态", "负责人", "操作"]}
                  rows={data.tickets.map((k: Row) => [
                    <Link key="id" className="code" href={`/admin/tickets/${k.id}`}>{k.public_no}</Link>,
                    TICKET_CATEGORY_ZH[k.category] ?? k.category,
                    k.subject,
                    <BizTag key="st" dict={TICKET_STATE_ZH} value={k.state} />,
                    k.assignee_name ?? "未领取",
                    <Link key="go" className="button sm" href={`/admin/tickets/${k.id}`}>处理工单 →</Link>,
                  ])}
                  empty="该订单无关联工单。"
                />
              </Panel>

              <Panel title="订单状态与审计时间线">
                <Table
                  headers={["时间", "业务动作", "操作人角色", "操作员"]}
                  rows={(data.activity ?? []).map((a: Row) => [
                    stamp(a.at, true),
                    AUDIT_ACTION_ZH[a.action] ?? a.action,
                    a.actor_type === "customer" ? "客户" : a.actor_type === "staff" ? "员工" : "系统",
                    a.display_name ?? "—",
                  ])}
                  empty="暂无审计事件。"
                />
              </Panel>
            </div>
          )}
        </>
      )}

      <StaffObjectDrawer target={drawer} actor={actor} onClose={() => setDrawer(null)} />
    </>
  );
}
