"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Empty, ErrorBlock, Field, Panel, stamp, Table, Tag, type Row, useLoad } from "./ui";
import { AUDIT_ACTION_ZH, CopyId, ROLE_ZH } from "./admin-labels";

const actorLabels:Record<string,string>={customer:"客户",staff:"员工",system:"系统"};
const ENTITY_ZH:Record<string,string>={
  orders:"质检订单",tickets:"客服工单",payments:"收款流水",refunds:"退款单",
  disposal_cases:"处置案",incident_cases:"库存事故",users:"用户账号",
  package_advices:"包裹预报",packages:"仓内包裹",warehouse_items:"实物样品",
  report_versions:"检查报告",reports:"质检报告",warehouse_addresses:"公仓地址",terms_versions:"合规条款",
  templates:"检查模板",shipping_rate_versions:"运费版本",app_config:"平台配置",
  media_assets:"媒体凭证文件",http_request:"接口权限守卫",dispatch_batches:"出库发运批次",
  disposition_requests:"检后处置指令",inspection_tasks:"单件质检任务",charge_items:"应收费用项",
  storage_locations:"仓库库位",stocktakes:"库存盘点单",tracking_records:"物流运单",
};
const VALUE_KEY_ZH:Record<string,string>={
  reason:"操作依据/原因",status:"状态",state:"阶段状态",decision:"核验决定",
  roles:"角色集合",amount_cents:"金额(分)",provider_ref:"渠道凭据号",
  receiving_code:"客户收件码",revision:"版本号",enabled:"启用",
};
const fields=[
  ["actor_id","操作人 ID"],["action","动作编码"],["entity_type","对象类型"],["entity_id","对象 ID"],
] as const;

function entityHref(entityType?:string,entityId?:string|null,orderPublicNo?:string|null,entityLabel?:string|null):string|null {
  if(!entityType||!entityId) return null;
  if(entityType==="orders"&&orderPublicNo) return `/admin/orders/${orderPublicNo}`;
  if(entityType==="tickets") return `/admin/tickets/${entityId}`;
  if(entityType==="payments") return `/admin/payments/${entityId}`;
  if(entityType==="refunds") return `/admin/refunds/${entityId}`;
  if(entityType==="disposal_cases") return `/admin/disposals/${entityId}`;
  if(entityType==="incident_cases") return `/admin/incidents/${entityId}`;
  if(entityType==="users"&&entityLabel&&entityLabel.startsWith("QCW-")) return `/admin/customers/${entityId}`;
  if(entityType==="packages"&&entityLabel&&entityLabel.startsWith("P-")) return `/wh/packages/${encodeURIComponent(entityLabel)}`;
  if(entityType==="warehouse_items"&&entityLabel&&entityLabel.startsWith("S-")) return `/wh/samples/${encodeURIComponent(entityLabel)}`;
  return null;
}

function AuditValues({values}:{values:Record<string,string|number|boolean>}) {
  const entries=Object.entries(values);
  return entries.length?<dl className="location-facts">
    {entries.map(([key,value])=><div key={key}><dt>{VALUE_KEY_ZH[key]??key}</dt><dd>{String(value)}</dd></div>)}
  </dl>:<Empty>无记录字段。</Empty>;
}
export function AuditDesk() {
  const search=useSearchParams(),params=new URLSearchParams();
  for(const name of [...fields.map(([key])=>key),"actor_type","from","to","before_id"]) {
    const value=search.get(name)?.trim();
    if(value)params.set(name,value);
  }
  const query=params.toString();
  const {data,error,reload}=useLoad("/staff/audit"+(query?"?"+query:""));
  const next=new URLSearchParams(params),first=new URLSearchParams(params);
  if(data?.next_before_id)next.set("before_id",data.next_before_id);
  first.delete("before_id");
  return <>
    <div className="page-head row">
      <div>
        <p className="eyebrow">OPERATIONS / AUDIT TRAIL</p>
        <h1>系统操作与风控审计日志</h1>
        <p className="muted">不可变记录全部关键操作人、业务对象、所属客户及变更前后快照；支持从业务单号或操作人直接穿透溯源。</p>
      </div>
      <div className="head-actions">
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
    <Panel title="历史操作与变更溯源" subtitle="业务操作人、中文动作定义、目标业务实体及 Before/After 对照统一展示。">
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">正在查询不可变审计记录…</p>}
      {data&&!error&&<Table headers={["操作时间","业务动作","操作人 / 岗位","客户 / 订单","目标业务对象","变更对照详情"]} rows={data.rows.map((event:Row)=>{
        const actionLabel=AUDIT_ACTION_ZH[event.action]??event.action;
        const href=entityHref(event.entity_type,event.entity_id,event.order_public_no,event.entity_label);
        return [
          <span key="t" className="nowrap">{stamp(event.at)}</span>,
          <div key="act" className="cell-stack">
            <strong>{actionLabel}</strong>
            <CopyId value={event.action}/>
          </div>,
          <div key="actor" className="cell-stack">
            <div className="actions">
              <Tag tone={event.actor_type==="staff"?"blue":event.actor_type==="customer"?"green":"gray"}>{actorLabels[event.actor_type]??event.actor_type}</Tag>
              <strong>{event.actor_name??event.actor_receiving_code??(event.actor_id?`#${String(event.actor_id).slice(0,8)}`:"系统")}</strong>
            </div>
            {(event.actor_roles?.length??0)>0&&<div className="actions">
              {(event.actor_roles as string[]).map(r=><Tag key={r} tone="blue">{ROLE_ZH[r]??r}</Tag>)}
            </div>}
            {event.actor_id&&<CopyId value={event.actor_id}/>}
          </div>,
          <div key="co" className="cell-stack">
            {event.receiving_code&&<span className="code">{event.receiving_code}</span>}
            {event.order_public_no&&<Link className="code nowrap" href={`/admin/orders/${event.order_public_no}`}>{event.order_public_no}</Link>}
            {!event.receiving_code&&!event.order_public_no&&"—"}
          </div>,
          <div key="ent" className="cell-stack">
            <small className="muted">{ENTITY_ZH[event.entity_type]??event.entity_type}</small>
            {href?<Link className="code nowrap" href={href}>{event.entity_label??`#${String(event.entity_id).slice(0,8)}`}</Link>:
              <span>{event.entity_label??(event.entity_id?<CopyId value={event.entity_id}/>:"—")}</span>}
            {event.entity_id&&<CopyId value={event.entity_id}/>}
          </div>,
          <details key="diff">
            <summary>查看变更前后 (#{event.id})</summary>
            <div className="ops-columns" style={{marginTop:8}}>
              <div><strong className="small muted">变更前 (Before)</strong><AuditValues values={event.before}/></div>
              <div><strong className="small muted">变更后 (After)</strong><AuditValues values={event.after}/></div>
            </div>
          </details>,
        ];
      })} empty="没有符合条件的审计记录。"/>}
      <div className="actions" style={{marginTop:12}}><button type="button" className="button sm" onClick={reload}>刷新</button>
        {params.has("before_id")&&<Link className="button sm" href={"/admin/audit"+(first.size?"?"+first:"")}>返回首批</Link>}
        {!error&&data?.next_before_id&&<Link className="button sm" href={"/admin/audit?"+next}>下一批 →</Link>}
      </div>
    </Panel>
  </>;
}
