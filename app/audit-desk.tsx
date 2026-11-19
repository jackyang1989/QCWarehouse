"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { Empty, ErrorBlock, Field, Panel, stamp, Table, Tag, type Row, useLoad } from "./ui";
import { AUDIT_ACTION_ZH, CopyId, ROLE_ZH, StatusBanner } from "./admin-labels";

const actorLabels:Record<string,string>={customer:"客户",staff:"员工",system:"系统"};
const ENTITY_ZH:Record<string,string>={
  orders:"质检订单",tickets:"客服工单",payments:"收款流水",refunds:"退款单",
  disposal_cases:"处置案",incident_cases:"库存事故",users:"用户账号",
  package_advices:"包裹预报",packages:"仓内包裹",warehouse_items:"实物样品",
  report_versions:"检查报告",reports:"质检报告",warehouse_addresses:"公仓地址",terms_versions:"合规条款",
  templates:"检查模板",template_versions:"模板版本",shipping_rate_versions:"运费版本",app_config:"平台配置",
  media_assets:"媒体凭证文件",http_request:"接口权限守卫",dispatch_batches:"出库发运批次",
  disposition_requests:"检后处置指令",inspection_tasks:"单件质检任务",charge_items:"应收费用项",
  storage_locations:"仓库库位",stocktakes:"库存盘点单",tracking_records:"物流运单",
  service_offers:"服务目录项",categories:"商品品类",capabilities:"品类作业能力",
  order_blocks:"订单阻塞项",manual_quote_requests:"非标人工询价",dispatch_quote_versions:"出库运费报价",
  reference_samples:"确认样档案",shipments:"出库发运单",tracking_alerts:"物流异常告警",
  tracking_translations:"物流轨迹译文",recovery_runs:"灾备恢复演练",recovery_requests:"账号找回申请",
  auth_identities:"第三方身份绑定",sessions:"登录设备会话",user_emails:"用户登录邮箱",
  report_shares:"报告分享链接",outbox_events:"异步出站作业",
};
const VALUE_KEY_ZH:Record<string,string>={
  reason:"操作依据/原因",status:"状态",state:"阶段状态",decision:"核验决定",
  roles:"角色集合",amount_cents:"金额(分)",provider_ref:"渠道凭据号",
  receiving_code:"客户收件码",revision:"版本号",enabled:"启用",
  service_refund_cents:"退服务费(分)",compensation_cents:"货值赔偿(分)",
  payout_reference:"打款水单号",method:"处置方式",
  location_id:"目标库位 ID",code:"编码",zone:"库区",capacity:"库位容量",active:"启用状态",
  count:"记录条数",task_count:"关联任务数",base_version:"基准版本",version:"版本号",
  days:"天数",job_id:"作业 ID",type:"类型",previous_attempts:"已重试次数",
  previous_error:"上次错误",event_id:"关联事件 ID",assignment_id:"期望位置绑定 ID",
  quote_id:"报价 ID",tracking_id:"运单记录 ID",carrier:"承运商",
  previous_status:"变更前状态",kind:"类别",is_default:"默认地址",
};
const fields=[
  ["actor_id","操作人 ID"],["action","动作编码"],["entity_type","对象类型"],["entity_id","对象 ID"],
] as const;

const HIGH_RISK_ACTIONS = new Set([
  "approve_refund", "reject_refund", "request_refund", "refund_executed",
  "resolve_payment_dispute", "approve_incident_resolution", "resolve_incident_compensation",
  "approve_disposal_case", "execute_disposal_case", "update_user_roles", "update_user_status",
  "staff_update_user_roles", "staff_update_user_status", "approve_account_recovery",
  "publish_terms_version", "publish_template", "publish_sku_price", "publish_shipping_rate",
  "set_default_address", "record_launch_signoff",
]);

function classifyAuditRisk(action: string): { label: string; tone: "red" | "yellow" | "blue" | "gray" } {
  if (action === "rejected_forbidden" || action.startsWith("rejected_")) return { label: "安全拦截", tone: "red" };
  if (HIGH_RISK_ACTIONS.has(action)) return { label: "高风险资金/权限", tone: "yellow" };
  if (["publish_report", "approve_report", "return_report", "hold_order", "resume_order", "bind_unmatched_owner", "bind_unmatched_package"].includes(action)) {
    return { label: "核心履约审批", tone: "blue" };
  }
  return { label: "常规业务", tone: "gray" };
}

function entityHref(
  entityType?:string,
  entityId?:string|null,
  orderPublicNo?:string|null,
  entityLabel?:string|null,
  relatedPaymentId?:string|null,
):string|null {
  if(!entityType||!entityId) return null;
  if(entityType==="orders"&&orderPublicNo) return `/admin/orders/${orderPublicNo}`;
  if(entityType==="tickets") return `/admin/tickets/${entityId}`;
  if(entityType==="payments") return `/admin/payments/${entityId}`;
  if(entityType==="charge_items") {
    if(relatedPaymentId) return `/admin/payments/${relatedPaymentId}`;
    if(orderPublicNo) return `/admin/orders/${orderPublicNo}`;
    return null;
  }
  if(entityType==="refunds") return `/admin/refunds/${entityId}`;
  if(entityType==="disposal_cases") return `/admin/disposals/${entityId}`;
  if(entityType==="incident_cases") return `/admin/incidents/${entityId}`;
  if(entityType==="storage_locations") return `/admin/storage/locations`;
  if(entityType==="users"&&entityLabel&&entityLabel.startsWith("QCW-")) return `/admin/customers/${entityId}`;
  if(entityType==="packages"&&entityLabel&&entityLabel.startsWith("P-")) return `/wh/packages/${encodeURIComponent(entityLabel)}`;
  if(entityType==="warehouse_items"&&entityLabel&&entityLabel.startsWith("S-")) return `/wh/samples/${encodeURIComponent(entityLabel)}`;
  if(entityType==="inspection_tasks") return `/admin/inspections/tasks/${entityId}`;
  return null;
}

function shortUuid(value?: string | null): string {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function AuditDiffTable({before,after}:{before?:Record<string,unknown>;after?:Record<string,unknown>}) {
  const b = before ?? {};
  const a = after ?? {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  if (keys.length === 0) return <Empty>本次操作无附加字段快照。</Empty>;
  return (
    <Table
      headers={["业务字段", "变更前 (Before)", "变更后 (After)"]}
      rows={keys.map(k => [
        <strong key="k">{VALUE_KEY_ZH[k] ?? k}</strong>,
        b[k] !== undefined && b[k] !== null ? <span key="b" className="code">{String(b[k])}</span> : <span key="b" className="muted">—</span>,
        a[k] !== undefined && a[k] !== null ? <strong key="a" className="code">{String(a[k])}</strong> : <span key="a" className="muted">—</span>,
      ])}
    />
  );
}

const AUDIT_HEADERS = ["操作时间", "风险与业务动作", "操作人 / 岗位", "客户 / 订单", "目标业务对象", "变更对照"] as const;

export function AuditDesk() {
  const search=useSearchParams(),params=new URLSearchParams();
  for(const name of [...fields.map(([key])=>key),"actor_type","from","to","before_id"]) {
    const value=search.get(name)?.trim();
    if(value)params.set(name,value);
  }
  const explicitActionFilter = params.get("action") ?? "";
  const [collapse403, setCollapse403] = useState(explicitActionFilter !== "rejected_forbidden");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const query=params.toString();
  const {data,error,reload}=useLoad("/staff/audit"+(query?"?"+query:""));
  const next=new URLSearchParams(params),first=new URLSearchParams(params);
  if(data?.next_before_id)next.set("before_id",data.next_before_id);
  first.delete("before_id");

  const allRows: Row[] = data?.rows ?? [];
  const forbiddenRows = allRows.filter(r => r.action === "rejected_forbidden");
  const visibleRows = (collapse403 && explicitActionFilter !== "rejected_forbidden")
    ? allRows.filter(r => r.action !== "rejected_forbidden")
    : allRows;

  return <>
    <div className="page-head row">
      <div>
        <h1>系统操作与风控审计日志</h1>
        <p className="muted">不可变记录全部关键操作人、风险等级、业务对象、所属客户及字段级 Before/After 快照；支持聚合折叠高频 403 越权拦截噪音。</p>
      </div>
      <div className="head-actions">
        <div className="quick-switch" role="group" aria-label="403 拦截折叠开关">
          <button
            type="button"
            className={collapse403 ? "on" : ""}
            onClick={() => setCollapse403(true)}
          >
            业务视图 (折叠 403)
          </button>
          <button
            type="button"
            className={!collapse403 ? "on" : ""}
            onClick={() => setCollapse403(false)}
          >
            全量安全 ({forbiddenRows.length} 条 403)
          </button>
        </div>
        <button type="button" className="button sm" onClick={reload}>刷新日志</button>
      </div>
    </div>
    <Panel title="筛选记录">
      <form className="form" action="/admin/audit" method="get" key={query}>
        <div className="inline-form">{fields.map(([name,label])=><label key={name}>{label}
          <input name={name} maxLength={64} defaultValue={params.get(name)??""}/></label>)}</div>
        <div className="inline-form">
          <label>操作者类型<select name="actor_type" defaultValue={params.get("actor_type")??""}>
            <option value="">全部</option>{Object.entries(actorLabels).map(([type,label])=><option value={type} key={type}>{label}</option>)}
          </select></label>
          <Field name="from" label="日期从（UTC）" type="date" required={false} value={params.get("from")??""}/>
          <Field name="to" label="日期至（UTC）" type="date" required={false} value={params.get("to")??""}/>
          <button type="submit" className="button primary">查审计</button><Link className="button" href="/admin/audit">清除筛选</Link>
        </div>
      </form>
    </Panel>
    {collapse403 && forbiddenRows.length > 0 && explicitActionFilter !== "rejected_forbidden" && (
      <StatusBanner tone="info" title={`已自动聚合折叠本页 ${forbiddenRows.length} 条权限守卫拦截事件 (rejected_forbidden)`}>
        这些记录来自自动化权限回归验证或越权拦截守卫（403），底层不可变审计表已 100% 保留。{" "}
        <button type="button" className="button sm" style={{ marginLeft: 8 }} onClick={() => setCollapse403(false)}>
          展开查看全部 {forbiddenRows.length} 条 403 拦截明细
        </button>
      </StatusBanner>
    )}
    <Panel title={`历史操作与变更溯源（当前展示 ${visibleRows.length} 条）`} subtitle="包含风险等级、业务操作人、中文动作定义、目标业务实体及字段级 Before → After 对照。">
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">正在查询不可变审计记录…</p>}
      {data&&!error&&(visibleRows.length===0 ? (
        <Empty>当前过滤条件下无业务审计记录（可切换至全量安全视图查看 403 拦截记录）。</Empty>
      ) : (
        <div className="table-wrap responsive-table">
          <table className="tbl audit-tbl">
            <thead>
              <tr>{AUDIT_HEADERS.map(h=><th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {visibleRows.map((event:Row)=>{
                const actionLabel=AUDIT_ACTION_ZH[event.action]??event.action;
                const href=entityHref(event.entity_type,event.entity_id,event.order_public_no,event.entity_label,event.related_payment_id);
                const risk=classifyAuditRisk(event.action);
                const rowId = String(event.id);
                const isOpen = expandedId === rowId;
                const diffCount = new Set([
                  ...Object.keys((event.before as Record<string,unknown>) ?? {}),
                  ...Object.keys((event.after as Record<string,unknown>) ?? {}),
                ]).size;
                const roleSummary = (event.actor_roles?.length ?? 0) > 0
                  ? (event.actor_roles as string[]).map(r => ROLE_ZH[r] ?? r).join(" · ")
                  : "";
                const targetDisplay = event.entity_label ?? (event.entity_id ? shortUuid(event.entity_id) : null);

                return (
                  <Fragment key={rowId}>
                    <tr>
                      <td>
                        <span className="table-cell-label" aria-hidden="true">{AUDIT_HEADERS[0]}</span>
                        <span className="nowrap audit-time">{stamp(event.at)}</span>
                        <span className="audit-subcode">#{rowId}</span>
                      </td>
                      <td>
                        <span className="table-cell-label" aria-hidden="true">{AUDIT_HEADERS[1]}</span>
                        <div className="audit-primary-line">
                          <strong>{actionLabel}</strong>
                          <Tag tone={risk.tone}>{risk.label}</Tag>
                        </div>
                        <span className="audit-subcode" title={event.action}>{event.action}</span>
                      </td>
                      <td>
                        <span className="table-cell-label" aria-hidden="true">{AUDIT_HEADERS[2]}</span>
                        <div className="audit-primary-line">
                          <Tag tone={event.actor_type==="staff"?"blue":event.actor_type==="customer"?"green":"gray"}>{actorLabels[event.actor_type]??event.actor_type}</Tag>
                          <strong>{event.actor_name??event.actor_receiving_code??(event.actor_id?`#${String(event.actor_id).slice(0,8)}`:"系统")}</strong>
                        </div>
                        {roleSummary && <span className="audit-roles-line">{roleSummary}</span>}
                      </td>
                      <td>
                        <span className="table-cell-label" aria-hidden="true">{AUDIT_HEADERS[3]}</span>
                        {event.order_public_no || event.receiving_code ? (
                          <div className="cell-stack">
                            {event.order_public_no && <Link className="code nowrap audit-link" href={`/admin/orders/${event.order_public_no}`}>{event.order_public_no}</Link>}
                            {event.receiving_code && <span className="audit-subcode">{event.receiving_code}</span>}
                          </div>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <span className="table-cell-label" aria-hidden="true">{AUDIT_HEADERS[4]}</span>
                        <span className="audit-entity-type">{ENTITY_ZH[event.entity_type]??event.entity_type}</span>
                        {href ? (
                          <Link className="code nowrap audit-link" href={href} title={event.entity_id ?? undefined}>{targetDisplay ?? `#${shortUuid(event.entity_id)}`}</Link>
                        ) : targetDisplay ? (
                          <span className={event.entity_label ? "audit-entity-label" : "audit-subcode"} title={event.entity_id ?? undefined}>{targetDisplay}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <span className="table-cell-label" aria-hidden="true">{AUDIT_HEADERS[5]}</span>
                        <button
                          type="button"
                          className="audit-expand-btn"
                          aria-expanded={isOpen}
                          onClick={() => setExpandedId(prev => prev === rowId ? null : rowId)}
                        >
                          {isOpen ? "收起详情" : diffCount > 0 ? `变更对照 (${diffCount})` : "技术编号"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="audit-detail-row">
                        <td colSpan={6}>
                          <div className="audit-detail-box">
                            <div className="audit-meta-strip">
                              <span><strong>审计事件</strong> #{rowId}</span>
                              <span><strong>动作编码</strong> <CopyId value={event.action} short={false}/></span>
                              {event.actor_id && <span><strong>操作人 UUID</strong> <CopyId value={event.actor_id}/></span>}
                              {event.entity_id && <span><strong>对象 UUID</strong> <CopyId value={event.entity_id}/></span>}
                            </div>
                            <AuditDiffTable before={event.before} after={event.after}/>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      <div className="actions" style={{marginTop:12}}><button type="button" className="button sm" onClick={reload}>刷新</button>
        {params.has("before_id")&&<Link className="button sm" href={"/admin/audit"+(first.size?"?"+first:"")}>返回首批</Link>}
        {!error&&data?.next_before_id&&<Link className="button sm" href={"/admin/audit?"+next}>下一批 →</Link>}
      </div>
    </Panel>
  </>;
}
