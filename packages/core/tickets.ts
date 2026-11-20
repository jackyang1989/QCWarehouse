import { z } from "zod";
import type { DB } from "../db";
import { audit, code, event, guard, hash, lock, one, organization, revision, role, uuid, type Actor } from "./common";
import { approvedIntakeAdviceSql, savePhoto } from "./intake";
import { hasStaffAccess, staffAccess } from "./staff-access";
import { customerIncidentProposal } from "./storage";

const body=z.string().trim().min(2).max(2000);
const version=z.number().int().positive();
const publicInquiryLimit=5;
export const publicInquiry=z.object({
  email:z.string().trim().toLowerCase().pipe(z.email().max(254)),
  category_id:z.uuid(),sample_count:z.number().int().positive().max(2147483647),
  description:z.string().trim().min(1).max(1000),
});
export const customerTicketMessage=z.object({revision:version,body});
export const customerCaseQuery=z.object({
  q:z.string().trim().max(80).default(""),
  state:z.enum(["open","waiting_customer","waiting_internal","resolved","closed"]).optional(),
  page:z.coerce.number().int().min(1).max(10000).default(1),
});
export const staffTicketEvent=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("claim"),revision:version}),
  z.object({kind:z.literal("assign"),revision:version,assignee_id:z.uuid().nullable(),body:body.optional()}),
  z.object({kind:z.literal("reply"),revision:version,body,reply_by:z.iso.datetime().optional()}),
  z.object({kind:z.literal("internal_note"),revision:version,body}),
  z.object({kind:z.literal("resolve"),revision:version,body}),
]);

export async function inquiryCategories(db:DB) {
  return (await db.query(`select id,labels->>'en' label from categories
    where status in ('ACTIVE','PLANNED') and nullif(labels->>'en','') is not null order by label,id`)).rows;
}
export async function createPublicInquiry(db:DB,actor:Actor|null,browser:string,input:z.infer<typeof publicInquiry>) {
  const org=actor?organization(actor):null;
  const {email,category_id,sample_count,description}=input;
  const emailKey=hash(email),browserKey=hash(browser);
  await lock(db,"public-inquiry:email:"+emailKey);
  await lock(db,"public-inquiry:browser:"+browserKey);
  const {by_email,by_browser}=await one<{by_email:number;by_browser:number}>(db,`select
    count(*) filter (where details->>'email_key'=$1)::int by_email,
    count(*) filter (where details->>'browser_key'=$2)::int by_browser
    from tickets where category='non_standard_quote' and created_at>=now()-interval '1 hour'
    and (details->>'email_key'=$1 or details->>'browser_key'=$2)`,[emailKey,browserKey]);
  guard(by_email<publicInquiryLimit&&by_browser<publicInquiryLimit,"INQUIRY_RATE_LIMIT","Too many inquiries. Try again later.",429);
  const category=(await db.query(`select labels from categories where id=$1 and status in ('ACTIVE','PLANNED')
    and nullif(labels->>'en','') is not null for share`,[category_id])).rows[0];
  guard(category,"INQUIRY_CATEGORY_UNAVAILABLE","Select an available category.",422);
  const id=uuid(),public_no=code("C-");
  await db.query(`insert into tickets(id,public_no,org_id,category,subject,details,next_action_at)
    values($1,$2,$3,'non_standard_quote','Custom inspection inquiry',$4,now()+interval '24 hours')`,
    [id,public_no,org,{public_inquiry:true,contact_email:email,category_id,category_labels:category.labels,sample_count,
      email_key:emailKey,browser_key:browserKey}]);
  await append(db,actor,id,"message",description);
  return {public_no,...(org?{case_id:id}:{})};
}

async function ticket(db:DB,actor:Actor,id:string,orderNumber:string|null,write=false) {
  const org=actor.kind==="customer"?organization(actor):null;
  if(org===null)role(actor,...staffAccess.orders);
  return one(db,`select k.id,k.org_id,k.order_id,k.public_no,k.subject,k.category,k.state,k.revision,k.created_at,k.resolved_at,k.next_action_at,k.assignee_id,
    u.display_name assignee,o.public_no order_number,o.state order_state,k.details
    from tickets k left join orders o on o.id=k.order_id and o.org_id=k.org_id left join users u on u.id=k.assignee_id
    where k.id=$1 and ($2::uuid is null or k.org_id=$2) and ($3::text is null or o.public_no=$3)${write?" for update of k":""}`,
    [id,org,orderNumber]);
}
export async function caseDetail(db:DB,actor:Actor,id:string,orderNumber:string|null) {
  const k=await ticket(db,actor,id,orderNumber);
  const parcel=k.details.parcel_advice_id?(await db.query(`select a.id,t.tracking_norm from package_advices a
    left join tracking_records t on t.advice_id=a.id and t.closed_at is null
    where a.id::text=$1 and a.org_id=$2`,[k.details.parcel_advice_id,k.org_id])).rows[0]??null:null;
  const ownershipReview=k.category==="identity_unclear"&&k.details.proof_id?{
    tracking_no:k.details.tracking_no,
    decision:k.details.decision??null,
    proof_id:k.details.proof_id,
    advice_id:k.details.decision==="approve"?(await one(db,`select ${approvedIntakeAdviceSql} advice_id from tickets k where id=$1`,[id])).advice_id:null,
  }:null;
  const {rows:events}=await db.query(`select e.id,e.actor_type,e.kind,e.body,e.media_ids,e.created_at,
    case when $2::boolean then u.display_name else null end actor_name
    from ticket_events e left join users u on u.id=e.actor_id
    where e.ticket_id=$1 and ($2::boolean or e.kind='message') order by e.created_at,e.id`,[id,actor.kind==="staff"]);
  const recovery=actor.kind==="staff"?(await db.query(`select r.id,r.user_id,r.state,r.requested_by as support_reviewer_id,
    r.approved_by as admin_approver_id,r.execute_after as executable_after,r.executed_at,p.receiving_code,u.status as user_status
    from recovery_requests r left join users u on u.id=r.user_id left join customer_receiving_profiles p on p.user_id=u.id
    where r.evidence_ticket_id=$1 order by r.verified_at desc nulls last limit 1`,[id])).rows[0]??null:null;
  const incidentRow=(await db.query(`select ic.id,ic.item_id,s.code as item_code,ic.order_line_id,ic.state,ic.resolution,ic.payment_proof
    from incident_cases ic left join warehouse_items s on s.id=ic.item_id
    where ic.ticket_id=$1 limit 1`,[id])).rows[0]??null;
  const res=(incidentRow?.resolution??{}) as Record<string,unknown>;
  const proof=(incidentRow?.payment_proof??{}) as Record<string,unknown>;
  const incident=incidentRow?{
    id:incidentRow.id,
    item_id:incidentRow.item_id,
    item_code:incidentRow.item_code,
    order_line_id:incidentRow.order_line_id,
    kind:res.kind??"damage",
    status:incidentRow.state,
    summary_en:res.summary_en??"",
    ...customerIncidentProposal(incidentRow.state,res),
    paid:Boolean(incidentRow.payment_proof),
    payout_reference:proof.payout_reference??null,
    payout_method:proof.payout_method??null,
    paid_amount_cents:proof.paid_amount_cents??null,
    resolved_at:proof.paid_at??null,
    ...(actor.kind==="staff"?{internal_note:res.internal_note??null,proposal_summary_en:res.proposal_summary_en??null,
      service_refund_cents:res.service_refund_cents??0,compensation_cents:res.compensation_cents??0,currency:res.currency??"USD",
      customer_decision:res.customer_decision??null,customer_note:res.customer_note??null}:{}),
  }:null;
  const staffCandidates=actor.kind==="staff"?(await db.query(`select distinct u.id,coalesce(u.display_name,u.id::text) as display_name
    from users u join staff_roles sr on sr.user_id=u.id
    where u.status='active' and sr.role in ('support','super_admin')
    order by display_name,u.id`)).rows:[];
  const customer=(actor.kind==="staff"&&k.org_id)?(await db.query(`select u.id user_id,p.org_id,p.receiving_code,u.display_name,u.status,
    e.original_email email
    from customer_receiving_profiles p join users u on u.id=p.user_id left join user_emails e on e.user_id=u.id and e.is_primary
    where p.org_id=$1 limit 1`,[k.org_id])).rows[0]??null:null;
  const linkedPaymentId=actor.kind==="staff"&&typeof k.details?.payment_id==="string"?k.details.payment_id:null;
  const linkedChargeItemId=actor.kind==="staff"&&typeof k.details?.charge_item_id==="string"?k.details.charge_item_id:null;
  const teamOf=(cat:string)=>["receipt_mismatch","damage_or_loss","identity_unclear"].includes(cat)?"Warehouse & Ops":cat==="return_info_incomplete"?"Logistics & Billing":"Customer Support";
  return {id:k.id,public_no:k.public_no,subject:k.subject,category:k.category,state:k.state,revision:k.revision,
    created_at:k.created_at,resolved_at:k.resolved_at,
    next_action_at:k.next_action_at,order_number:k.order_number,
    handling_team:teamOf(k.category),assigned:Boolean(k.assignee_id),
    discrepancy_resolution:typeof k.details?.discrepancy_resolution==="string"?k.details.discrepancy_resolution:null,
    ...(actor.kind==="staff"?{order_state:k.order_state,customer,linked_payment_id:linkedPaymentId,linked_charge_item_id:linkedChargeItemId}:{}),
    incident,...(parcel?{parcel}:{}),
    ...(ownershipReview?{ownership_review:ownershipReview}:{}),
    ...(actor.kind==="staff"?{assignee_id:k.assignee_id,assignee:k.assignee,account_recovery:recovery,staff_candidates:staffCandidates,
      ...(k.details.public_inquiry?{inquiry:{contact_email:k.details.contact_email,category:k.details.category_labels,
        sample_count:k.details.sample_count,portal_reply:!!k.org_id}}:{})}:{}),events};
}
export async function canReadCasePhoto(db:DB,actor:Actor,id:string) {
  const staff=actor.kind==="staff"&&hasStaffAccess(actor.roles,staffAccess.orders);
  const org=actor.kind==="customer"?organization(actor):null;
  if(!staff&&!org)return false;
  const match=await db.query(`select 1 from ticket_events e join tickets k on k.id=e.ticket_id
    where $1=any(e.media_ids) and ($2::boolean or k.org_id=$3 and e.kind='message') limit 1`,[id,staff,org]);
  return !!match.rowCount;
}

export async function customerCaseHistory(db:DB,actor:Actor,{q,state,page}:z.infer<typeof customerCaseQuery>) {
  const pageSize=20;
  const {rows}=await db.query(`select k.id,k.public_no,k.subject,k.category,k.state,k.created_at,k.next_action_at,
      (k.assignee_id is not null) assigned,
      case when k.category in ('receipt_mismatch','damage_or_loss','identity_unclear') then 'Warehouse & Ops'
           when k.category='return_info_incomplete' then 'Logistics & Billing'
           else 'Customer Support' end handling_team,
      o.public_no order_no,
      greatest(k.created_at,k.resolved_at,(select max(e.created_at) from ticket_events e
        where e.ticket_id=k.id and e.kind='message')) updated_at
    from tickets k left join orders o on o.id=k.order_id and o.org_id=k.org_id
    where k.org_id=$1 and ($2::text is null or k.state=$2)
      and ($3='' or strpos(upper(k.public_no),upper($3))>0 or strpos(upper(o.public_no),upper($3))>0)
    order by updated_at desc,k.id desc limit $4 offset $5`,[organization(actor),state??null,q,pageSize+1,(page-1)*pageSize]);
  return {rows:rows.slice(0,pageSize),page,has_more:rows.length>pageSize};
}
export async function staffTicketQueue(
  db:DB,
  actor:Actor,
  state:string|null,
  reference:string|null,
  category:string|null=null,
  assignee:string|null=null
) {
  role(actor,...staffAccess.orders);
  const {rows}=await db.query(`select k.id,k.public_no,k.subject,k.category,k.state,k.next_action_at,k.created_at,
      k.assignee_id,u.display_name assignee,o.public_no order_number,o.state order_state,
      crp.user_id customer_user_id,crp.receiving_code,cu.display_name customer_name,
      k.details->>'priority' priority,
      (select e.created_at from ticket_events e where e.ticket_id=k.id and e.actor_type='customer' order by e.created_at desc limit 1) last_customer_at,
      (select left(e.body,140) from ticket_events e where e.ticket_id=k.id and e.kind='message' order by e.created_at desc limit 1) latest_message
    from tickets k left join users u on u.id=k.assignee_id
    left join orders o on o.id=k.order_id and o.org_id=k.org_id
    left join customer_receiving_profiles crp on crp.org_id=k.org_id
    left join users cu on cu.id=crp.user_id
    where ($1::text is null or k.state=$1)
      and ($2::text is null or k.public_no=$2 or o.public_no=$2 or upper(coalesce(crp.receiving_code,''))=$2)
      and ($3::text is null or k.category=$3)
      and ($4::text is null
        or ($4='unassigned' and k.assignee_id is null)
        or ($4='mine' and k.assignee_id=$5::uuid)
        or ($4 not in ('unassigned','mine') and k.assignee_id::text=$4))
    order by k.next_action_at nulls last,k.created_at desc,k.id limit 100`,[state,reference,category,assignee,actor.id]);
  return {rows};
}
async function append(db:DB,actor:Actor|null,id:string,kind:string,message:string,mediaIds:string[]=[]){
  const eventId=uuid();
  await db.query("insert into ticket_events(id,ticket_id,actor_type,actor_id,kind,body,media_ids) values($1,$2,$3,$4,$5,$6,$7)",
    [eventId,id,actor?.kind??"customer",actor?.id??null,kind,message,mediaIds]);
  await audit(db,actor,"ticket_"+kind,"tickets",id,{event_id:eventId});
}
function ensureOpen(state:string) {
  guard(!["resolved","closed"].includes(state),"CASE_CLOSED","This support case is closed.");
}
export async function replyToCase(db:DB,actor:Actor,id:string,input:z.infer<typeof customerTicketMessage>,photo?:Buffer|Buffer[]) {
  organization(actor);
  const k=await ticket(db,actor,id,null,true);
  revision(k.revision,input.revision);
  ensureOpen(k.state);
  const photos=Array.isArray(photo)?photo:photo?[photo]:[];
  const media:string[]=[];
  for(const bytes of photos) media.push((await savePhoto(db,actor,bytes,"attachment")).id);
  await append(db,actor,id,"message",input.body,media);
  await db.query(`update tickets set state='waiting_internal',next_action_at=now()+interval '24 hours',revision=revision+1 where id=$1`,[id]);
  return {id,state:"waiting_internal",revision:k.revision+1};
}
export async function writeStaffTicket(db:DB,actor:Actor,id:string,input:z.infer<typeof staffTicketEvent>) {
  role(actor,...staffAccess.orders);
  const k=await ticket(db,actor,id,null,true);
  revision(k.revision,input.revision);
  ensureOpen(k.state);
  let state=k.state,assignee=k.assignee_id,due=k.next_action_at;
  if(input.kind==="claim") {
    guard(!assignee||assignee===actor.id,"CASE_ASSIGNED","This case is already assigned to another employee.");
    if(assignee===actor.id)return {id,state,revision:k.revision};
    assignee=actor.id;
    await append(db,actor,id,"state_change","Assigned to current employee.");
  } else if(input.kind==="assign") {
    if(input.assignee_id) {
      const target=(await db.query(`select u.id,coalesce(u.display_name,u.id::text) as name
        from users u join staff_roles sr on sr.user_id=u.id
        where u.id=$1 and u.status='active' and sr.role in ('support','super_admin') limit 1`,[input.assignee_id])).rows[0];
      guard(target,"ASSIGNEE_INVALID","Select an active support or admin employee.",422);
      assignee=target.id;
      await append(db,actor,id,"state_change",input.body?.trim()||`Assigned to ${target.name}.`);
    } else {
      assignee=null;
      await append(db,actor,id,"state_change",input.body?.trim()||"Unassigned from current employee.");
    }
  } else {
    guard(assignee===actor.id||actor.roles.includes("super_admin"),"CASE_ASSIGNED","Claim this case before making changes.");
    if(input.kind==="resolve") {
      guard(k.category!=="identity_unclear","CLAIM_DECISION_REQUIRED","Use the separate parcel ownership decision.");
      state="resolved";due=null;
      await append(db,actor,id,"internal_note",input.body);
    } else if(input.kind==="internal_note") {
      await append(db,actor,id,"internal_note",input.body);
    } else {
      guard(!k.details.public_inquiry||k.org_id,"CASE_CONTACT_REQUIRED","Contact the guest using the inquiry email and record the follow-up internally.");
      guard(!input.reply_by||new Date(input.reply_by)>new Date(),"INVALID_DEADLINE","Choose a future reply deadline.",422);
      state=input.reply_by?"waiting_customer":"waiting_internal";
      due=input.reply_by??null;
      await append(db,actor,id,"message",input.body);
      if(k.org_id)await event(db,"ticket.reply",{ticket_id:id,org_id:k.org_id});
    }
  }
  await db.query(`update tickets set state=$2,assignee_id=$3,next_action_at=$4,revision=revision+1,
    resolved_at=case when $2='resolved' then now() else resolved_at end where id=$1`,[id,state,assignee,due]);
  return {id,state,revision:k.revision+1};
}
