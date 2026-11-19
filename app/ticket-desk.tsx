"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Action, Empty, ErrorBlock, Field, FileInput, Form, MediaButton, Panel, Photo, request, Select, stamp, useWorkspaceStamp, Table, Tag, text, usd, useLoad, type Row } from "./ui";
import {
  BizTag,
  CopyId,
  INCIDENT_KIND_ZH,
  INCIDENT_STATE_ZH,
  ORDER_STATE_ZH,
  SlaCountdownBadge,
  TICKET_CATEGORY_ZH,
  TICKET_STATE_ZH,
} from "./admin-labels";

const status:Record<string,[string,string]>={
  open:["Open","待处理"],waiting_customer:["Awaiting your reply","待客户回复"],
  waiting_internal:["With support","待内部处理"],resolved:["Resolved","已解决"],closed:["Closed","已关闭"],
};
const categories:Record<string,string>={
  identity_unclear:"包裹认领",receipt_mismatch:"实物不符",measurement_dispute:"质检异议",
  return_info_incomplete:"退货资料",damage_or_loss:"丢损",payment_refund:"付款与退款",
  privacy_share:"隐私与分享",non_standard_quote:"非标咨询",
};
const isOpen=(state:string)=>state!=="resolved"&&state!=="closed";
const claimStatus=(claim:Row,state:string)=>claim.decision==="approve"?"Ownership confirmed":claim.decision==="reject"?
  "Ownership unverified":state==="waiting_customer"?"Awaiting your reply":isOpen(state)?"Under review":"Review closed";
const customerIncidentStatus:Record<string,string>={
  approved_awaiting_customer:"Decision required",awaiting_payout:"Payout pending",
  customer_rejected:"Further review requested",resolved:"Resolved",closed:"Closed",
};
const customerIncidentKind:Record<string,string>={damage:"Damage",loss:"Missing item",wrong_inspection:"Inspection issue"};

function incidentMoney(cents:number,currency:string) {
  return /^[A-Z]{3}$/.test(currency)?new Intl.NumberFormat("en-US",{style:"currency",currency}).format(cents/100):
    `${(cents/100).toFixed(2)} ${currency}`;
}

function Conversation({events,staff=false}:{events:Row[];staff?:boolean}) {
  const stamp=useWorkspaceStamp();
  if(!events.length)return <Empty>{staff?"暂无工单记录。":"There are no messages yet."}</Empty>;
  return <ol className="timeline case-conversation">{events.map(entry=><li key={entry.id}>
    <div className="row"><strong>{staff?entry.kind==="internal_note"?`内部备注${entry.actor_name?` · ${entry.actor_name}`:""}`:entry.kind==="state_change"?`操作记录${entry.actor_name?` · ${entry.actor_name}`:""}`:
      entry.actor_type==="customer"?`客户${entry.actor_name?` (${entry.actor_name})`:""}`:`客服${entry.actor_name?` (${entry.actor_name})`:""}`:entry.actor_type==="customer"?"You":"QC Warehouse"}</strong>
      <small>{stamp(entry.created_at)}</small></div><p>{entry.body}</p>
      {entry.media_ids?.length>0&&<div className="actions" style={{marginTop:6}}>
        <MediaButton ids={entry.media_ids} label={staff?`查看附件照片 (${entry.media_ids.length})`:`View attached photo${entry.media_ids.length>1?`s (${entry.media_ids.length})`:""}`}/>
      </div>}
  </li>)}</ol>;
}
export function ParcelOwnershipReviews({carriers,carrierError,onReloadCarriers,page}:{
  carriers?:Row[];carrierError:string;onReloadCarriers:()=>void;page:number;
}) {
  const claims=useLoad("/me/intake-claims?page="+page);
  const [submitted,setSubmitted]=useState<Row>();
  const formSection=useRef<HTMLDetailsElement>(null);
  const href=(target:number)=>"/parcels?tab=attention"+(target>1?"&claim_page="+target:"");
  return <Panel title="Parcel ownership reviews">
    {carrierError?<><ErrorBlock error={carrierError}/><button type="button" onClick={onReloadCarriers}>Retry review carriers</button></>:
      !carriers?<p role="status">Loading review carriers…</p>:<details className="card" ref={formSection}>
      <summary>Find a missing parcel</summary>
      <p className="muted">Enter the seller’s tracking number for the missing parcel and attach their shipment proof. Our team will verify ownership against the warehouse record.</p>
      <Form key={submitted?.public_no} label="Request ownership review" idempotent run={async (fields,key)=>{
        try {
          const result=await request("/me/intake-claims","POST",fields,key);
          setSubmitted(result);
          if(formSection.current)formSection.current.open=false;
        } finally {claims.reload();}
      }}>
        <Field name="tracking_no" label="Seller’s tracking number"/>
        <Select name="carrier_code" label="Carrier" choices={carriers.map(carrier=>({id:carrier.code,label:carrier.labels.en}))}/>
        <Photo label="Seller shipment proof"/>
      </Form>
    </details>}
    {submitted&&<p role="status">Review request {submitted.id?<Link href={"/support/cases/"+submitted.id}>{submitted.public_no}</Link>:submitted.public_no} is with support.</p>}
    {claims.error&&<><ErrorBlock error={claims.error}/><button className="button sm" onClick={claims.reload}>Retry reviews</button></>}
    {!claims.data&&!claims.error&&<p role="status">Loading ownership reviews…</p>}
    {claims.data&&<>
      <Table headers={["Case","Seller tracking number","Review status","Parcel"]} rows={claims.data.rows.map((claim:Row)=>[
        <Link className="code" href={"/support/cases/"+claim.id}>{claim.public_no}</Link>,
        <span className="code">{claim.tracking_no}</span>,
        <Tag>{claimStatus(claim,claim.state)}</Tag>,
        claim.advice_id?<Link href={"/parcels/"+claim.advice_id}>Open parcel →</Link>:"—",
      ])} empty="You have no ownership review requests on this page."/>
      {(page>1||claims.data.has_more)&&<nav className="actions" aria-label="Ownership review pages">
        {page>1&&<Link className="button" href={href(page-1)}>Previous page</Link>}
        <span>Page {page}</span>
        {claims.data.has_more&&<Link className="button" href={href(page+1)}>Next page</Link>}
      </nav>}
    </>}
  </Panel>;
}
export function CustomerCase({id,order}:{id:string;order?:string}) {
  const stamp=useWorkspaceStamp();
  const api="/cases/"+id;
  const {data,error,reload}=useLoad(api+(order?"?"+new URLSearchParams({order}):""));
  const incident=data?.incident;
  const claim=data?.ownership_review;
  const [sent,setSent]=useState<number>();
  useEffect(()=>{
    if(incident?.decision_required&&location.hash==="#incident-decision") {
      document.getElementById("incident-decision")?.scrollIntoView({block:"start"});
    }
  },[id,incident?.decision_required]);
  return <>
    <div className="page-head"><Link href={order?"/orders/"+order:claim?"/parcels?tab=attention":"/support"}>{order?"← Inspection order":claim?"← Parcel ownership reviews":"← Support"}</Link>
      <p className="eyebrow report-eyebrow">CLIENT WORKSPACE / SUPPORT</p><h1>{data?.subject??"Support case"}</h1>
      {data&&<div className="actions"><span className="code">{data.public_no}</span><Tag>{claim?claimStatus(claim,data.state):incident?.decision_required?"Decision required":status[data.state]?.[0]}</Tag>
        {data.order_number&&<Link className="code-btn" href={"/orders/"+data.order_number}>{data.order_number}</Link>}
        {data.parcel&&<Link className="code-btn" href={"/parcels/"+data.parcel.id}>Parcel {data.parcel.tracking_norm??"details"}</Link>}
      </div>}</div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry</button></>}
    {!error&&!data&&<p role="status">Loading your support case…</p>}
    {!error&&data&&<>
      {claim&&<Panel title="Seller parcel">
        <dl className="def"><dt>Seller tracking number</dt><dd className="code">{claim.tracking_no}</dd></dl>
        <div className="actions"><MediaButton ids={[claim.proof_id]} label="View seller shipment proof"/>
          {claim.advice_id&&<Link className="button sm" href={"/parcels/"+claim.advice_id}>Open parcel →</Link>}</div>
      </Panel>}
      <Panel title="Messages">
        {data.state==="waiting_customer"&&data.next_action_at&&<p className="notice">Please reply by {stamp(data.next_action_at)}.</p>}
        <Conversation events={data.events}/>
      </Panel>
      {incident&&<div id="incident-decision" style={{scrollMarginTop:88}}><Panel title="Incident resolution">
        <dl className="location-facts">
          <div><dt>Incident type</dt><dd>{customerIncidentKind[incident.kind]??"Warehouse incident"}</dd></div>
          <div><dt>Status</dt><dd><Tag>{incident.paid?"Payout recorded":customerIncidentStatus[incident.status]??"Under review"}</Tag></dd></div>
          {incident.proposal_visible&&incident.service_refund_cents>0&&<div><dt>Service fee refund in proposal</dt><dd>{incidentMoney(incident.service_refund_cents,incident.currency)}</dd></div>}
          {incident.proposal_visible&&incident.compensation_cents>0&&<div><dt>Merchandise compensation</dt><dd>{incidentMoney(incident.compensation_cents,incident.currency)}</dd></div>}
        </dl>
        {incident.proposal_summary_en&&<p>{incident.proposal_summary_en}</p>}
        {incident.customer_decision&&<p role="status">{incident.customer_decision==="accept"?"You accepted this proposal.":"You requested further review."}</p>}
        {incident.paid&&incident.payout_reference&&<p className="muted">Payout reference <span className="code">{incident.payout_reference}</span></p>}
        {incident.decision_required&&<Form label="Submit compensation decision" idempotent run={async (fields,key)=>{
          await request("/me/incidents/"+incident.id+"/response","POST",{
            decision:text(fields,"decision"),
            note:text(fields,"note")||undefined,
          },key);
          reload();
        }}>
          <div className="field"><label htmlFor="incident-decision-choice">Decision</label><select id="incident-decision-choice" name="decision" required defaultValue="">
            <option value="">Choose a decision</option>
            <option value="accept">Accept compensation proposal</option>
            <option value="reject">Reject and request further review</option>
          </select></div>
          <Field name="note" label="Response note (optional)" required={false}/>
        </Form>}
      </Panel></div>}
      {isOpen(data.state)&&<Panel title="Reply to support">
        <Form key={sent} label="Send reply" idempotent run={async (fields,key)=>{
          const photo=fields.get("photo");
          const message={revision:data.revision,body:text(fields,"body")};
          const payload=photo instanceof File&&photo.size?fields:message;
          if(payload instanceof FormData)payload.set("revision",String(message.revision));
          const result=await request(api+"/messages","POST",payload,key);
          setSent(result.revision);reload();
        }}><label>Reply<textarea name="body" required minLength={2} maxLength={2000}/></label>
          <label>Evidence photo (optional)<FileInput name="photo"/></label>
        </Form>
        {sent&&<p role="status">Your reply was sent.</p>}
      </Panel>}
    </>}
  </>;
}

const PRIORITY_ZH:Record<string,{label:string;tone:"red"|"yellow"|"gray"}>={
  urgent:{label:"紧急",tone:"red"},
  high:{label:"高优",tone:"yellow"},
  normal:{label:"常规",tone:"gray"},
};

export function StaffTicketQueue() {
  const [state,setState]=useState("");
  const [category,setCategory]=useState("");
  const [assignee,setAssignee]=useState("");
  const [reference,setReference]=useState("");
  const params=new URLSearchParams();
  if(state)params.set("state",state);
  if(category)params.set("category",category);
  if(assignee)params.set("assignee",assignee);
  if(reference)params.set("reference",reference);
  const {data,error,reload}=useLoad("/staff/tickets"+(params.size?"?"+params:""));
  return <>
    <div className="page-head row">
      <div>
        <h1>客户工单处理台</h1>
        <p className="muted">按分类、紧急度、指派状态与处理时限追踪全部售后、包裹认领、质量异议与账号恢复工单，直达关联客户与订单上下文。</p>
      </div>
      <div className="head-actions">
        <Link className="button sm" href="/admin/customers">客户 360 目录</Link>
        <Link className="button sm" href="/admin/orders">订单工作台</Link>
        <button type="button" className="button sm" onClick={reload}>刷新队列</button>
      </div>
    </div>
    <Panel title="多维筛选工单队列">
      <div className="admin-toolbar">
        <label>工单状态<select value={state} onChange={e=>setState(e.target.value)}>
          <option value="">全部状态</option>{Object.entries(status).map(([value,names])=><option key={value} value={value}>{names[1]}</option>)}
        </select></label>
        <label>业务分类<select value={category} onChange={e=>setCategory(e.target.value)}>
          <option value="">全部分类</option>{Object.entries(categories).map(([value,labelText])=><option key={value} value={value}>{labelText}</option>)}
        </select></label>
        <label>指派归属<select value={assignee} onChange={e=>setAssignee(e.target.value)}>
          <option value="">全部处理人</option>
          <option value="unassigned">未领取 (待接单)</option>
          <option value="mine">我负责的工单</option>
        </select></label>
        <div className="actions">
          {(state||category||assignee||reference)&&<button type="button" className="button sm" onClick={()=>{setState("");setCategory("");setAssignee("");setReference("");}}>重置筛选</button>}
        </div>
      </div>
      <Form inline label="按单号或客户码精确查询" run={async fields=>setReference(text(fields,"reference").toUpperCase())}>
        <Field name="reference" label="完整工单号 / QW 订单号 / 客户码 QCW-..." required={false}/>
      </Form>
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">正在读取工单队列…</p>}
      {data&&!error&&<Table headers={["工单与最新消息","所属客户","业务分类","优先级 / 状态","关联订单","负责人","响应时限 / 详情"]} rows={data.rows.map((entry:Row)=>[
        <div key="t" className="cell-stack">
          <Link className="case-queue-link" href={"/admin/tickets/"+entry.id}><strong className="code">{entry.public_no}</strong> · {entry.subject}</Link>
          {entry.latest_message&&<small className="muted">{entry.latest_message}</small>}
        </div>,
        <div key="c" className="cell-stack">
          {entry.receiving_code&&entry.customer_user_id?<Link className="code nowrap" href={`/admin/customers/${entry.customer_user_id}`}>{entry.receiving_code}</Link>:<span className="muted">访客/未绑定</span>}
          {entry.customer_name&&<small className="muted">{entry.customer_name}</small>}
        </div>,
        <Tag key="cat" tone="blue">{TICKET_CATEGORY_ZH[entry.category]??entry.category}</Tag>,
        <div key="st" className="cell-stack">
          <BizTag dict={TICKET_STATE_ZH} value={entry.state}/>
          {entry.priority&&<BizTag dict={PRIORITY_ZH} value={entry.priority}/>}
        </div>,
        entry.order_number?<div key="o" className="cell-stack">
          <Link className="code nowrap" href={`/admin/orders/${entry.order_number}`}>{entry.order_number}</Link>
          {entry.order_state&&<BizTag dict={ORDER_STATE_ZH} value={entry.order_state}/>}
        </div>:"—",
        entry.assignee??<Tag tone="yellow">未领取</Tag>,
        <div key="op" className="cell-stack">
          <div className="actions">
            <SlaCountdownBadge dueAt={entry.next_action_at} active={isOpen(entry.state)}/>
            <Link className="button sm nowrap" href={`/admin/tickets/${entry.id}`}>进入处理 →</Link>
          </div>
          <small>{entry.next_action_at?`截止 ${stamp(entry.next_action_at)}`:`创建 ${stamp(entry.created_at,true)}`}</small>
        </div>,
      ])} empty="没有符合条件的工单记录。"/>}
    </Panel>
  </>;
}

export function StaffTicket({id,actor}:{id:string;actor:Row}) {
  const api="/staff/tickets/"+id;
  const {data,error,reload}=useLoad(api);
  const [saved,setSaved]=useState<number>();
  async function update(body:Row) {
    const result=await request(api+"/events","POST",{revision:data?.revision,...body});
    setSaved(result.revision);reload();
  }
  const open=data&&isOpen(data.state);
  const canWork=open&&(data.assignee_id===actor.id||actor.roles.includes("super_admin"));
  return <>
    <div className="page-head row">
      <div>
        <Link href="/admin/tickets">← 返回工单处理台</Link>
        <h1 style={{marginTop:6}}>{data?.subject??"工单详情工作台"}</h1>
        {data&&<div className="actions" style={{marginTop:6}}>
          <CopyId value={data.public_no} short={false}/>
          <Tag tone="blue">{TICKET_CATEGORY_ZH[data.category]??data.category}</Tag>
          <BizTag dict={TICKET_STATE_ZH} value={data.state}/>
          <SlaCountdownBadge dueAt={data.next_action_at} active={isOpen(data.state)}/>
        </div>}
      </div>
      <div className="head-actions">
        {data?.customer?.user_id&&<Link className="button sm" href={`/admin/customers/${data.customer.user_id}`}>客户档案 {data.customer.receiving_code} →</Link>}
        {data?.order_number&&<Link className="button sm" href={`/admin/orders/${data.order_number}`}>订单 {data.order_number} →</Link>}
        {data?.linked_payment_id&&<Link className="button sm" href={`/admin/payments/${data.linked_payment_id}`}>查看关联付款 →</Link>}
        {data?.incident?.id&&<Link className="button sm" href={`/admin/incidents/${data.incident.id}`}>查看事故详情 →</Link>}
      </div>
    </div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!error&&!data&&<p role="status">正在读取工单完整上下文…</p>}
    {data&&!error&&<>
      <Panel title="关联业务档案与工单信息">
        <div className="admin-kv-grid" style={{marginBottom:14}}>
          <div className="kv-card"><span className="k">工单分类 / 状态</span><div className="actions"><Tag tone="blue">{TICKET_CATEGORY_ZH[data.category]??data.category}</Tag><BizTag dict={TICKET_STATE_ZH} value={data.state}/></div></div>
          <div className="kv-card"><span className="k">关联客户档案</span>{data.customer?<Link href={`/admin/customers/${data.customer.user_id}`}><strong className="code">{data.customer.receiving_code}</strong> · {data.customer.display_name??data.customer.email??"—"}</Link>:"访客 / 未关联客户"}</div>
          <div className="kv-card"><span className="k">关联质检订单</span>{data.order_number?<div className="actions"><Link className="code" href={"/admin/orders/"+data.order_number}>{data.order_number}</Link>{data.order_state&&<BizTag dict={ORDER_STATE_ZH} value={data.order_state}/>}</div>:"无关联订单"}</div>
          <div className="kv-card"><span className="k">当前负责人 / 时限</span><span>{data.assignee??"未领取"} · {stamp(data.next_action_at)}</span></div>
          {data.parcel&&<div className="kv-card"><span className="k">入库关联运单</span><span className="code">{data.parcel.tracking_norm??"待核对运单"}</span></div>}
          {data.ownership_review&&<div className="kv-card"><span className="k">认领核验待办</span><Link className="code" href={"/admin/orders?tab=claims#case-"+data.id}>{data.ownership_review.tracking_no} · 去审核 →</Link></div>}
          {data.linked_payment_id&&<div className="kv-card"><span className="k">关联收费付款</span><Link className="code" href={`/admin/payments/${data.linked_payment_id}`}>查看原付款单 →</Link></div>}
          {data.inquiry&&<div className="kv-card"><span className="k">售前非标咨询</span><span>{data.inquiry.category["zh-CN"]??data.inquiry.category.en} · {data.inquiry.sample_count} 件 · {data.inquiry.contact_email}</span></div>}
        </div>
        {open&&!data.assignee_id&&<div className="actions"><Action primary run={()=>update({kind:"claim"})}>领取并接手本工单</Action></div>}
        {open&&(data.staff_candidates?.length??0)>0&&<Form inline label="指派 / 转派负责人" run={async f=>{
          const target=text(f,"assignee_id");
          await update({kind:"assign",assignee_id:target||null,body:text(f,"body")||undefined});
        }}>
          <label>指派负责人<select name="assignee_id" defaultValue={data.assignee_id??""}>
            <option value="">未领取（释放指派）</option>
            {data.staff_candidates.map((c:Row)=><option key={c.id} value={c.id}>{c.display_name} ({c.email})</option>)}
          </select></label>
          <Field name="body" label="转派说明（可选）" required={false}/>
        </Form>}
        {data.category==="identity_unclear"&&open&&<p style={{marginTop:8}}><Link className="button sm primary" href={"/admin/orders?tab=claims#case-"+id}>前往订单台核验包裹归属与拍照凭证 →</Link></p>}
      </Panel>
      {data.incident&&<Panel title="关联库存丢损与赔付处置" badge={data.incident.id?<Link className="button sm" href={`/admin/incidents/${data.incident.id}`}>打开事故完整工作台 →</Link>:undefined}>
        <dl className="admin-kv-grid">
          <div className="admin-kv-item"><dt>实物编码</dt><dd className="code">{data.incident.item_code??data.incident.item_id}</dd></div>
          <div className="admin-kv-item"><dt>事故类型</dt><dd><Tag tone="yellow">{INCIDENT_KIND_ZH[data.incident.kind]??data.incident.kind}</Tag></dd></div>
          <div className="admin-kv-item"><dt>事故状态</dt><dd><BizTag dict={INCIDENT_STATE_ZH} value={data.incident.status}/></dd></div>
          <div className="admin-kv-item"><dt>建议退质检费</dt><dd className="nowrap">{usd(data.incident.service_refund_cents??0)}</dd></div>
          <div className="admin-kv-item"><dt>建议现金赔付</dt><dd className="nowrap">{usd(data.incident.compensation_cents??0)}</dd></div>
          <div className="admin-kv-item"><dt>客户确认结论</dt><dd>{data.incident.customer_decision??"待客户确认"}</dd></div>
        </dl>
        <p style={{marginTop:10}}>{data.incident.summary_en}</p>
        {data.incident.internal_note&&<p className="muted">内部调查备注：{data.incident.internal_note}</p>}
      </Panel>}
      {data.account_recovery&&<Panel title="账号恢复与双人审批">
        <dl className="location-facts">
          <div><dt>恢复状态</dt><dd><Tag>{data.account_recovery.state}</Tag></dd></div>
          <div><dt>专属收件码</dt><dd className="code">{data.account_recovery.receiving_code??"—"}</dd></div>
          <div><dt>账号状态</dt><dd>{data.account_recovery.user_status??"—"}</dd></div>
          <div><dt>可最终执行时间</dt><dd>{stamp(data.account_recovery.executable_after)}</dd></div>
        </dl>
        <p className="muted">客户提交核验说明：{data.account_recovery.evidence_summary}</p>
        {["pending_review","awaiting_approval"].includes(data.account_recovery.state)&&<Form label={data.account_recovery.state==="pending_review"?"客服初审通过并提交超管审批":"超管独立复核批准"} run={async f=>{
          const decision=text(f,"decision");
          await request("/staff/account-recoveries/"+data.account_recovery.id+"/"+decision,"POST",{
            reason:text(f,"reason"),
            ...(f.get("emergency")==="on"?{emergency:true}:{}),
          });
          reload();
        }}>
          <label>审批结论<select name="decision" defaultValue="approve"><option value="approve">通过</option><option value="reject">驳回</option></select></label>
          <Field name="reason" label="核验依据与审批说明"/>
          {actor.roles.includes("super_admin")&&data.account_recovery.state==="awaiting_approval"&&
            <label className="check"><input type="checkbox" name="emergency"/> 紧急跳过 24 小时冷静期（仅超管经核实后勾选）</label>}
        </Form>}
        {data.account_recovery.state==="approved"&&actor.roles.includes("super_admin")&&
          <Action primary run={async()=>{await request("/staff/account-recoveries/"+data.account_recovery.id+"/execute","POST",{});reload();}}>执行账号恢复换绑并撤销旧会话</Action>}
      </Panel>}
      <Panel title="沟通与处理记录"><Conversation events={data.events} staff/></Panel>
      {canWork&&<>
        {data.inquiry?.portal_reply===false?<Panel title="访客跟进">
          <p>请通过咨询邮箱联系访客，并在内部备注记录跟进结果。</p>
        </Panel>:<Panel title="公开回复">
          <Form key={"reply-"+saved} label="发送给客户" run={async fields=>{
            const replyBy=text(fields,"reply_by");
            await update({kind:"reply",body:text(fields,"body"),...(replyBy?{reply_by:new Date(replyBy).toISOString()}:{})});
          }}><label>回复内容<textarea name="body" required minLength={2} maxLength={2000}/></label>
            <Field name="reply_by" label="要求客户回复的期限（可选，本地时间）" type="datetime-local" required={false}/>
          </Form>
        </Panel>}
        <Panel title="内部处理">
          <Form key={"note-"+saved} label="保存内部备注" run={async f=>update({kind:"internal_note",body:text(f,"body")})}>
            <label>内部备注<textarea name="body" required minLength={2} maxLength={2000}/></label>
          </Form>
          {data.category!=="identity_unclear"&&<Form label="结案" run={async f=>update({kind:"resolve",body:text(f,"body")})}>
            <label>结案原因<textarea name="body" required minLength={2} maxLength={2000}/></label>
          </Form>}
        </Panel>
      </>}
      {saved&&<p className="notice" role="status">工单操作已保存。</p>}
    </>}
  </>;
}
