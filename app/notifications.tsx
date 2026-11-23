"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { billingChargePath, billingQuotePath } from "../packages/core/portal-routes";
import { Action, Empty, ErrorBlock, Panel, request, useWorkspaceStamp, Table, useLoad, type Row } from "./ui";

const noticeTitles:Record<string,string>={
  "account.registered":"Your workspace is ready",
  "reference.sealed":"Your Golden Sample is active",
  "ticket.reply":"Support has replied to your case",
  "report.published":"Your inspection report is ready",
  "report.amended":"An updated report has been published",
  "payment.confirmed":"Payment confirmed",
  "package.received":"The warehouse received your parcel",
  "order.ready":"Your items are ready for inspection",
  "order.held":"Order placed on hold for confirmation",
  "order.resumed":"Inspection order resumed",
  "incident.resolved":"Warehouse incident resolved",
  "order.identity_mismatch":"Action required: Sample identity mismatch detected",
  "order.cancelled":"Inspection cancelled",
  "dispatch.quoted":"Your shipping quote is ready",
  "storage.quoted":"Your storage extension quote is ready",
  "quote.offered":"A manual inspection quote is ready",
  "shipment.handed_over":"Your parcel has been handed to the carrier",
  "shipment.return_received":"Returned items have been received at the warehouse",
  "tracking.exception_opened":"Carrier reported a delivery exception",
  "email.delivery_failed":"We couldn't deliver email to this address",
};
function UpdatesTable({notices,onRead}:{notices:Row[];onRead:()=>void}) {
  const stamp=useWorkspaceStamp();
  return <>
    {notices.length?<Table headers={["Update","Received","Status",""]} rows={notices.map(notice=>{
      const href=notice.case_id?"/support/cases/"+notice.case_id:
        notice.report_version&&notice.order_number?"/orders/"+notice.order_number+"/report/versions/"+notice.report_version:
        notice.quote_id?billingQuotePath(notice.quote_id):
        notice.template==="storage.quoted"?"/account/billing":
        notice.item_code?"/items?item="+encodeURIComponent(notice.item_code):
        notice.shipment_id?"/shipments/"+notice.shipment_id:
        notice.advice_id?"/parcels/"+notice.advice_id:
        notice.charge_id?billingChargePath(notice.charge_id):
        notice.order_number?"/orders/"+notice.order_number+(notice.template==="quote.offered"?"#manual-quote-request":""):
        notice.template==="account.registered"||notice.template==="email.delivery_failed"?"/account":
        notice.template==="payment.confirmed"||notice.template==="dispatch.quoted"?"/account/billing":null;
      const title=noticeTitles[notice.template]??"Account update";
      return [<span className="cell-stack"><span style={{fontWeight:notice.read_at?500:750}}>{title}</span>
          {notice.item_code&&<small className="code">{notice.item_code}</small>}
          {notice.parcel_tracking_number&&<small>Tracking <span className="code">{notice.parcel_tracking_number}</span></small>}
          {notice.case_number&&<small>Case <span className="code">{notice.case_number}</span></small>}
          {notice.order_number&&<small>Order <span className="code">{notice.order_number}</span>{notice.report_version?` · Report v${notice.report_version}`:""}</small>}</span>,
        stamp(notice.created_at),notice.read_at?"Read":"Unread",
        <div className="actions">{href&&<Link href={href} onClick={()=>{
            if(!notice.read_at) {
              void request("/me/notifications/"+notice.id+"/read","POST",{}).then(onRead).catch(()=>{});
            }
          }}>Open</Link>}
          {!notice.read_at&&<Action run={async()=>{
            await request("/me/notifications/"+notice.id+"/read","POST",{});onRead();
          }}>Mark as read</Action>}
        </div>];
    })}/>:<Empty>No updates yet.</Empty>}
  </>;
}
export function RecentUpdates({notices,onRead}:{notices:Row[];onRead:()=>void}) {
  return <Panel title="Recent activity"><UpdatesTable notices={notices.slice(0,5)} onRead={onRead}/>
    <Link href="/account/notifications">View all notifications →</Link>
  </Panel>;
}
export function NotificationInbox() {
  const search=useSearchParams(),params=new URLSearchParams();
  const cat=search.get("category")??"all";
  const unread=search.get("unread")==="1",before=search.get("before");
  if(unread)params.set("unread","1");
  if(cat!=="all")params.set("category",cat);
  if(before)params.set("before",before);
  const {data,error,reload}=useLoad("/me/notifications"+(params.size?"?"+params:""));
  function firstPage(category:string,onlyUnread:boolean) {
    const first=new URLSearchParams();
    if(category!=="all")first.set("category",category);
    if(onlyUnread)first.set("unread","1");
    return "/account/notifications"+(first.size?"?"+first:"");
  }
  const next=new URLSearchParams(params);
  if(data?.next_before)next.set("before",data.next_before);
  return <>
    <div className="page-head"><Link href="/account">← Account</Link>
      <h1>Notifications</h1><p className="muted">Find updates about reports, payments, parcels, and support cases.</p></div>
    <Panel title={unread?"Unread updates":"All updates"}>
      <div className="actions" style={{flexWrap:"wrap"}}>
        <Link className="button sm" href={firstPage(cat,false)} aria-current={!unread?"page":undefined}>All</Link>
        <Link className="button sm" href={firstPage(cat,true)} aria-current={unread?"page":undefined}>Unread{data?` (${data.unread_count})`:""}</Link>
        {(data?.unread_count??0)>0&&<Action sm primary run={async()=>{await request("/me/notifications/read-all","POST",{});reload();}}>Mark all read</Action>}
        <button className="button sm" type="button" onClick={reload}>Refresh</button>
      </div>
      <div className="actions" style={{marginTop:8,flexWrap:"wrap"}}>
        {([
          ["all","All Categories"],
          ["orders","Orders"],
          ["reports","Reports"],
          ["parcels","Parcels & Tracking"],
          ["billing","Billing & Quotes"],
          ["support","Support & Account"],
        ] as const).map(([cid,clabel])=><Link key={cid} href={firstPage(cid,unread)} aria-current={cat===cid?"page":undefined}
          className={"button sm"+(cat===cid?" primary":"")}>{clabel}</Link>)}
      </div>
      {error&&<ErrorBlock error={error}/>}
      {!data&&!error&&<p role="status">Loading updates…</p>}
      {data&&!error&&<UpdatesTable notices={data.rows} onRead={reload}/>}
      <div className="actions">{before&&<Link href={firstPage(cat,unread)}>Back to first page</Link>}
        {!error&&data?.next_before&&<Link href={"/account/notifications?"+next}>Older updates →</Link>}</div>
    </Panel>
  </>;
}
