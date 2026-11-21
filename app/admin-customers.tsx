"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Action,
  Empty,
  ErrorBlock,
  Field,
  Form,
  Panel,
  request,
  Select,
  stamp,
  Table,
  Tag,
  text,
  useLoad,
  type Row,
} from "./ui";
import {
  AdminTabs,
  BizTag,
  CopyId,
  DISPOSITION_ACTION_ZH,
  EmptyState,
  INCIDENT_KIND_ZH,
  INCIDENT_STATE_ZH,
  Money,
  ORDER_STATE_ZH,
  PAYMENT_STATE_ZH,
  PURPOSE_ZH,
  REFUND_STATE_ZH,
  StatusBanner,
  TICKET_CATEGORY_ZH,
  TICKET_STATE_ZH,
  USER_STATUS_ZH,
  WarehouseItemLifecycleTags,
} from "./admin-labels";

export function AdminCustomersDirectory() {
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ status: statusFilter, page: String(page), limit: "30" });
  if (q) params.set("q", q);
  const { data, error, reload } = useLoad(`/staff/admin/customers?${params.toString()}`);
  const rows: Row[] = data?.rows ?? [];

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>客户档案与业务全景中心</h1>
          <p className="muted">按专属收件码、邮箱、昵称或关联订单号查询客户；点击进入完整客户工作台查看全部订单、在库样品、确认样、财务账单与客服记录。</p>
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新客户列表</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}

      <form
        className="admin-toolbar"
        onSubmit={e => {
          e.preventDefault();
          setQ(searchInput.trim());
          setPage(1);
        }}
      >
        <label>
          检索收件码 / 邮箱 / 昵称 / 订单号
          <input
            type="search"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="例如 QCW56084 / @ / QW261121835"
          />
        </label>
        <label>
          账号状态
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="all">全部状态</option>
            <option value="active">正常启用</option>
            <option value="restricted">受限管控</option>
            <option value="disabled">已停用</option>
            <option value="closed">已注销</option>
          </select>
        </label>
        <div className="actions">
          <button type="submit" className="button primary sm">查找客户</button>
          <button type="button" className="button sm" onClick={() => { setSearchInput(""); setQ(""); setStatusFilter("all"); setPage(1); }}>重置</button>
        </div>
      </form>

      <Panel title="注册客户台账" subtitle={`共匹配 ${data?.total ?? 0} 位客户`}>
        {!data && !error && <p role="status">正在读取客户档案…</p>}
        {data && rows.length === 0 && (
          <EmptyState
            kind={q || statusFilter !== "all" ? "filtered" : "empty"}
            title="未匹配到符合条件的客户"
            description="请确认收件码（QCW56084）或邮箱拼写，或清除过滤条件查看全部客户。"
            actionLabel="查看全部客户"
            onAction={() => { setSearchInput(""); setQ(""); setStatusFilter("all"); setPage(1); }}
          />
        )}
        {data && rows.length > 0 && (
          <>
            <Table
              headers={["专属收件码", "邮箱与名称", "账号状态", "订单 / 在办", "在库样品 / 确认样", "待处理工单", "累计实付 / 已退", "最近下单", "详情"]}
              rows={rows.map(c => [
                <Link key="rc" href={`/admin/customers/${c.id}`}><strong className="code nowrap">{c.receiving_code}</strong></Link>,
                <div key="em" className="cell-stack">
                  <span>{c.email ?? "未绑定邮箱"}</span>
                  <small>{c.display_name ?? "—"} · 邮件状态：{c.email_delivery_state ?? "正常"}</small>
                </div>,
                <BizTag key="st" dict={USER_STATUS_ZH} value={c.status} />,
                <div key="ord" className="cell-stack nowrap">
                  <strong>总 {c.order_count} 单</strong>
                  <small>{c.active_order_count > 0 ? `进行中 ${c.active_order_count}` : "无进行中"}</small>
                </div>,
                <span key="it" className="nowrap">在库 {c.stored_item_count} · 确认样 {c.reference_count}</span>,
                c.open_ticket_count > 0 ? <Tag key="tk" tone="yellow">{c.open_ticket_count} 条待处理</Tag> : <span key="tk" className="muted">无</span>,
                data.financial_restricted
                  ? <span key="fin" className="muted">仅财务/超管可见</span>
                  : (
                    <div key="fin" className="cell-stack">
                      <Money cents={c.total_paid_cents} align="left" />
                      {c.total_refunded_cents > 0 && <small>已退 <Money cents={c.total_refunded_cents} align="left" /></small>}
                    </div>
                  ),
                <span key="lo" className="nowrap">{c.last_order_at ? stamp(c.last_order_at, true) : stamp(c.created_at, true)}</span>,
                <Link key="go" className="button sm nowrap" href={`/admin/customers/${c.id}`}>客户工作台 →</Link>,
              ])}
            />
            {(page > 1 || data.has_more) && (
              <div className="actions" style={{ marginTop: 12 }}>
                <button type="button" className="button sm" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</button>
                <span className="small">第 {page} 页</span>
                <button type="button" className="button sm" disabled={!data.has_more} onClick={() => setPage(p => p + 1)}>下一页</button>
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}

export function AdminCustomerDetail({ id, actor }: { id: string; actor: Row }) {
  const { data, error, reload } = useLoad(`/staff/admin/customers/${id}`);
  const [tab, setTab] = useState("orders");
  const [notice, setNotice] = useState("");
  const p = data?.profile;
  const s = data?.summary;
  const isSuperAdmin = Boolean(actor.roles?.includes("super_admin"));

  return (
    <>
      <div className="page-head row">
        <div>
          <Link href="/admin/customers">← 返回客户档案目录</Link>
          <h1 style={{ marginTop: 6 }}>
            客户详情工作台 · <span className="code">{p?.receiving_code ?? `#${id.slice(0, 8)}`}</span>
          </h1>
          {p && (
            <div className="actions" style={{ marginTop: 6 }}>
              <BizTag dict={USER_STATUS_ZH} value={p.status} />
              <span>{p.email ?? "—"}</span>
              {p.email_delivery_state && ["bounced", "complained"].includes(p.email_delivery_state) && (
                <Tag tone="red">邮箱投递抑制：{p.email_delivery_state}</Tag>
              )}
            </div>
          )}
        </div>
        <div className="head-actions">
          <button type="button" className="button sm" onClick={reload}>刷新档案</button>
        </div>
      </div>

      {error && <ErrorBlock error={error} />}
      {!data && !error && <p role="status">正在聚合并加载客户全链路业务数据…</p>}

      {data && p && (
        <>
          {notice && <StatusBanner tone="success" title="账号变更已记录">{notice}</StatusBanner>}

          <div className="metric-strip" aria-label="客户业务摘要">
            <div className="metric">
              <span>累计质检订单 / 在办</span>
              <strong>{s.order_count} / {s.active_inspection_count}</strong>
              <small>已发布报告 {s.published_report_count} 份</small>
            </div>
            <div className="metric">
              <span>当前在库样品 / 确认样</span>
              <strong>{s.stored_item_count} / {s.reference_count}</strong>
              <small>包裹记录 {(data.parcels ?? []).length} 个</small>
            </div>
            <div className="metric">
              <span>累计实付 / 已退款</span>
              <strong>
                {data.financial_restricted ? "受限" : <Money cents={s.paid_cents} align="left" />}
              </strong>
              <small>
                {data.financial_restricted ? "仅财务与超管可见资金明细" : <>已退 <Money cents={s.refunded_cents} align="left" /></>}
              </small>
            </div>
            <div className="metric">
              <span>待处理工单 / 历史通知</span>
              <strong>{s.open_ticket_count} / {(data.notifications ?? []).length}</strong>
              <small>库内事故 {(data.incidents ?? []).length} 起</small>
            </div>
          </div>

          <Panel title="身份资料、收件编码与登录绑定">
            <dl className="admin-kv-grid">
              <div className="admin-kv-item"><dt>用户 UUID</dt><dd><CopyId value={p.id} /></dd></div>
              <div className="admin-kv-item"><dt>组织 UUID / 类型</dt><dd><CopyId value={p.org_id} /> · {p.org_name}</dd></div>
              <div className="admin-kv-item"><dt>永久专属收件码</dt><dd><CopyId value={p.receiving_code} short={false} /></dd></div>
              <div className="admin-kv-item"><dt>主登录邮箱与认证</dt><dd>{p.email ?? "—"} ({p.email_verified_at ? "已验证" : "未验证"})</dd></div>
              <div className="admin-kv-item"><dt>已绑定登录方式</dt><dd>{(p.auth_identities ?? []).map((ai: Row) => ai.provider).join(" / ") || "email_otp"}</dd></div>
              <div className="admin-kv-item"><dt>注册与时区偏好</dt><dd>{stamp(p.created_at, true)} · {p.timezone ?? "UTC"}</dd></div>
            </dl>
            {isSuperAdmin && p.status !== "closed" && (
              <>
                <hr className="divider" />
                <Form
                  inline
                  key={`cust-status-${p.id}-${p.status}`}
                  label="更新客户账号状态"
                  run={async f => {
                    const nextStatus = text(f, "status");
                    const reason = text(f, "reason");
                    await request(`/staff/users/${p.id}/status`, "POST", { status: nextStatus, reason });
                    setNotice(
                      nextStatus === "disabled"
                        ? "客户账号已停用并吊销所有活跃登录会话。"
                        : nextStatus === "restricted"
                          ? "客户账号已限制新建订单与付款，保留在途订单查收。"
                          : "客户账号状态已恢复为正常启用。"
                    );
                    reload();
                  }}
                >
                  <Select
                    name="status"
                    label="目标风控状态"
                    value={p.status}
                    choices={[
                      { id: "active", label: "正常启用 (active)" },
                      { id: "restricted", label: "限制新单与付款，保留查收 (restricted)" },
                      { id: "disabled", label: "停用并撤销全部会话 (disabled)" },
                    ]}
                  />
                  <Field name="reason" label="变更依据与审批原因（审计必填）" />
                </Form>
              </>
            )}
          </Panel>

          <AdminTabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: "orders", label: "全部订单与质检", count: (data.orders ?? []).length },
              { id: "items", label: "包裹与在库实物", count: (data.items ?? []).length },
              { id: "references", label: "确认样 (Golden Samples)", count: (data.reference_samples ?? []).length },
              { id: "reports", label: "已发布报告", count: (data.reports ?? []).length },
              { id: "billing", label: "支付与退款明细", count: (data.payments ?? []).length + (data.refunds ?? []).length },
              { id: "support", label: "工单、事故与通知", count: (data.tickets ?? []).length },
            ]}
          />

          {tab === "orders" && (
            <Panel title="客户全部订单">
              <Table
                headers={["订单编号", "服务类型", "委托件数", "当前阶段", "订单总额", "报告版本", "SLA 截止", "创建时间", "详情"]}
                rows={(data.orders ?? []).map((o: Row) => [
                  <Link key="no" className="code nowrap" href={`/admin/orders/${o.public_no}`}>{o.public_no}</Link>,
                  o.service_title ?? "质检服务",
                  o.expected_units ?? 0,
                  <BizTag key="st" dict={ORDER_STATE_ZH} value={o.state} />,
                  <Money key="pr" cents={o.price_cents} />,
                  o.report_version ? `v${o.report_version}` : "—",
                  stamp(o.sla_due_at, true),
                  stamp(o.created_at, true),
                  <Link key="go" className="button sm nowrap" href={`/admin/orders/${o.public_no}`}>订单工作台 →</Link>,
                ])}
                empty="该客户尚无任何订单。"
              />
            </Panel>
          )}

          {tab === "items" && (
            <div className="ops-columns">
              <Panel title={`物流预报与入库包裹 (${(data.parcels ?? []).length})`}>
                <Table
                  headers={["入库包裹", "运单号", "承运商", "实收件数", "关联订单", "到货时间"]}
                  rows={(data.parcels ?? []).map((pk: Row) => [
                    pk.package_code ? <Link key="p" className="code" href={`/wh/packages/${pk.package_code}`}>{pk.package_code}</Link> : "在途未到仓",
                    <span key="t" className="code">{pk.tracking_norm ?? "—"}</span>,
                    pk.carrier_code ?? "—",
                    pk.received_quantity ?? "—",
                    (pk.order_numbers ?? []).map((no: string) => <Link key={no} className="code" href={`/admin/orders/${no}`}>{no}</Link>),
                    stamp(pk.received_at, true),
                  ])}
                  empty="暂无包裹预报或实收记录。"
                />
              </Panel>
              <Panel title={`在库及历史实物 (${(data.items ?? []).length})`}>
                <Table
                  headers={["实物编码", "来源包裹", "绑定订单", "保管与核身状态", "库位", "活跃处置"]}
                  rows={(data.items ?? []).map((it: Row) => [
                    <Link key="c" className="code" href={`/wh/samples/${it.code}`}>{it.code}</Link>,
                    it.package_code,
                    it.order_no ? <Link key="o" className="code" href={`/admin/orders/${it.order_no}`}>{it.order_no}</Link> : "未委托件",
                    <WarehouseItemLifecycleTags key="s" item={it} compact />,
                    it.location_code ?? "—",
                    it.active_disposition ? (DISPOSITION_ACTION_ZH[it.active_disposition.split(":")[0]] ?? it.active_disposition) : "—",
                  ])}
                  empty="暂无实物记录。"
                />
              </Panel>
            </div>
          )}

          {tab === "references" && (
            <Panel title="客户确认样档案 (Golden Samples)">
              <Table
                headers={["实物编号", "确认样状态", "铅封编号", "确认样专柜库位", "有效期至", "保管说明"]}
                rows={(data.reference_samples ?? []).map((rs: Row) => [
                  <Link key="c" className="code" href={`/wh/samples/${rs.item_code}`}>{rs.item_code}</Link>,
                  <Tag key="s" tone={rs.state === "active" ? "green" : "yellow"}>{rs.state}</Tag>,
                  <span key="sl" className="code">{rs.seal_code ?? "待铅封"}</span>,
                  rs.safe_location_code ?? "—",
                  stamp(rs.expires_at, true),
                  rs.condition_note ?? "—",
                ])}
                empty="该客户未保留过任何确认样（Golden Sample）。"
              />
            </Panel>
          )}

          {tab === "reports" && (
            <Panel title="已发布正式质检报告">
              <Table
                headers={["报告编号", "所属订单", "最新发布版本", "发布时间", "操作"]}
                rows={(data.reports ?? []).map((rp: Row) => [
                  <span key="no" className="code">{rp.public_no}</span>,
                  <Link key="o" className="code" href={`/admin/orders/${rp.order_no}`}>{rp.order_no}</Link>,
                  `v${rp.published_version}`,
                  stamp(rp.published_at, true),
                  <Link key="go" className="button sm" href={`/wh/review/${rp.version_id}`}>查看/复核报告 →</Link>,
                ])}
                empty="暂无已发布的正式质检报告。"
              />
            </Panel>
          )}

          {tab === "billing" && (
            data.financial_restricted ? (
              <EmptyState kind="forbidden" title="财务敏感数据已权限隔离" description="当前员工账号未分配 finance 或 super_admin 角色，故隐藏客户详细支付与退款流水金额。" />
            ) : (
              <div className="ops-columns">
                <Panel title={`客户支付记录 (${(data.payments ?? []).length})`}>
                  <Table
                    headers={["支付单号", "用途", "关联订单", "金额", "状态", "已退", "时间", "详情"]}
                    rows={(data.payments ?? []).map((py: Row) => [
                      <Link key="id" className="code" href={`/admin/payments/${py.id}`}>{py.display_ref}</Link>,
                      PURPOSE_ZH[py.purpose] ?? py.purpose,
                      py.order_no ? <Link key="o" className="code" href={`/admin/orders/${py.order_no}`}>{py.order_no}</Link> : "—",
                      <Money key="a" cents={py.amount_cents} currency={py.currency} />,
                      <BizTag key="st" dict={PAYMENT_STATE_ZH} value={py.state} />,
                      <Money key="rf" cents={py.refunded_cents} mutedZero />,
                      stamp(py.created_at, true),
                      <Link key="go" className="button sm" href={`/admin/payments/${py.id}`}>支付详情</Link>,
                    ])}
                    empty="无支付流水。"
                  />
                </Panel>
                <Panel title={`客户退款记录 (${(data.refunds ?? []).length})`}>
                  <Table
                    headers={["退款单号", "原订单", "退款金额", "状态", "原因", "时间", "详情"]}
                    rows={(data.refunds ?? []).map((rf: Row) => [
                      <Link key="id" className="code" href={`/admin/refunds/${rf.id}`}>{rf.display_ref}</Link>,
                      rf.order_no ? <Link key="o" className="code" href={`/admin/orders/${rf.order_no}`}>{rf.order_no}</Link> : "—",
                      <Money key="a" cents={rf.amount_cents} />,
                      <BizTag key="s" dict={REFUND_STATE_ZH} value={rf.state} />,
                      rf.reason,
                      stamp(rf.created_at, true),
                      <Link key="go" className="button sm" href={`/admin/refunds/${rf.id}`}>审批详情</Link>,
                    ])}
                    empty="无退款记录。"
                  />
                </Panel>
              </div>
            )
          )}

          {tab === "support" && (
            <div className="ops-columns">
              <Panel title={`工单与库存事故 (${(data.tickets ?? []).length} / ${(data.incidents ?? []).length})`}>
                <Table
                  headers={["工单号", "分类", "主题", "状态", "关联订单", "操作"]}
                  rows={(data.tickets ?? []).map((k: Row) => [
                    <Link key="id" className="code" href={`/admin/tickets/${k.id}`}>{k.public_no}</Link>,
                    TICKET_CATEGORY_ZH[k.category] ?? k.category,
                    k.subject,
                    <BizTag key="st" dict={TICKET_STATE_ZH} value={k.state} />,
                    k.order_no ? <Link key="o" className="code" href={`/admin/orders/${k.order_no}`}>{k.order_no}</Link> : "—",
                    <Link key="go" className="button sm" href={`/admin/tickets/${k.id}`}>进入工单</Link>,
                  ])}
                  empty="该客户无客服工单。"
                />
                {(data.incidents ?? []).length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <strong className="small">库内丢损与事故 ({data.incidents.length})：</strong>
                    <Table
                      headers={["工单号", "实物", "类型", "状态", "操作"]}
                      rows={data.incidents.map((ic: Row) => [
                        <span key="no" className="code">{ic.ticket_no}</span>,
                        ic.item_code,
                        INCIDENT_KIND_ZH[ic.kind] ?? ic.kind,
                        <BizTag key="st" dict={INCIDENT_STATE_ZH} value={ic.state} />,
                        <Link key="go" className="button sm" href={`/admin/incidents/${ic.id}`}>事故详情 →</Link>,
                      ])}
                    />
                  </div>
                )}
              </Panel>
              <Panel title={`客户站内通知历史 (${(data.notifications ?? []).length})`}>
                <Table
                  headers={["通知模板", "关联订单", "已读状态", "发送时间"]}
                  rows={(data.notifications ?? []).map((n: Row) => [
                    <span key="t" className="code">{n.template}</span>,
                    n.order_no ? <Link key="o" className="code" href={`/admin/orders/${n.order_no}`}>{n.order_no}</Link> : "—",
                    n.read_at ? <Tag key="r" tone="green">已读</Tag> : <Tag key="r" tone="yellow">未读</Tag>,
                    stamp(n.created_at, true),
                  ])}
                  empty="暂无站内通知。"
                />
              </Panel>
            </div>
          )}
        </>
      )}
    </>
  );
}
