import { z } from "zod";
import type { DB } from "../db";
import { currentTerms, requireCustomerActive, requireTerms } from "./auth";
import { audit, code, event, guard, isDemo, lock, one, orderCode, organization, revision, role, unresolvedQuotePayment, uuid, type Actor } from "./common";
import { inboundParcelOrders, inboundShortageConfirmed, orderAttributedParcelItems, orderInboundRegistration, orderQuotes, orderShipments } from "./fulfillment-reads";
import { scopeSupplementForOrder } from "./scope-payment";
import { customerItemHandlingHoldSql } from "./storage";
import { newQuoteValidity } from "./quote-policy";
import { itemInspectionStageSql } from "./inspection-stage";
import { skuNoteLimit } from "./order-note-limits";

export const checkSchema = z.object({
  key:z.string().min(1).max(80), label:z.string().min(1).max(120), zh:z.string().min(1).max(120),
  type:z.enum(["boolean","number","text"]), unit:z.string().optional(), method:z.string().min(1),
  required:z.boolean().default(true), evidence:z.boolean().default(false),
  kind:z.enum(["measurement","observation","shot","order_shot"]).optional(),
  component:z.string().min(1).max(40).optional(),
  precision:z.number().positive().optional(),
  diagram:z.string().max(200).nullable().optional(),
  derived:z.object({circumference_cm:z.string().optional()}).optional(),
  retry_threshold:z.number().positive().optional(),
  parts:z.array(z.string().min(1).max(60)).optional(),
  applies_if:z.record(z.string(),z.unknown()).optional(),
  required_if:z.record(z.string(),z.unknown()).optional(),
});
export const templateShotSchema = z.object({
  code:z.string().min(1).max(80),
  name:z.string().min(1).max(120),
  zh:z.string().max(120).optional(),
  required:z.boolean().default(true),
  component:z.string().min(1).max(40).optional(),
  required_if:z.record(z.string(),z.unknown()).optional(),
});
export const templateSchema=z.object({
  subcategory:z.string().max(60).optional(),
  checks:z.array(checkSchema).min(1).max(60),
  components:z.array(z.union([
    z.string().min(1).max(40),
    z.object({id:z.string().min(1).max(40),code:z.string().min(1).max(80)}),
  ])).optional(),
  diagram:z.string().max(200).nullable().optional(),
  parts:z.array(z.union([
    z.string().min(1).max(60),
    z.object({code:z.string().min(1).max(60),label:z.string().min(1).max(120)}),
  ])).optional(),
  measure_conditions:z.string().max(1000).optional(),
  measurement_policy:z.object({
    attempts:z.number().int().min(1).max(3).default(2),
    extra_attempt_on_difference:z.boolean().default(true),
    threshold_by_unit:z.record(z.string(),z.number().positive()).optional(),
  }).optional(),
  shots:z.array(templateShotSchema).optional(),
  order_shots:z.array(z.string().min(1).max(80)).optional(),
}).refine(
  t=>new Set(t.checks.map(c=>c.key)).size===t.checks.length,"Check keys must be unique.");
export const priceSchema=z.object({
  minimum:z.number().int().positive(),maximum:z.number().int().positive(),unit_cents:z.number().int().positive().optional(),
  package_cents:z.number().int().positive().optional(),business_days:z.number().int().positive(),demo:z.boolean().optional()
}).refine(p=>p.maximum>=p.minimum && Number(!!p.unit_cents)+Number(!!p.package_cents)===1);
export type LineInput={category_id:string; offer_id:string; template_version_id?:string; quantity:number; options?:object; attributes?:object; items?:object[]};
async function validateLineSamples(db:DB,org:string,line:{category_id:string;quantity?:number;options?:unknown;attributes?:unknown;items?:unknown[];draft_items?:unknown[]},service:string) {
  const items=(Array.isArray(line.items)?line.items:Array.isArray(line.draft_items)?line.draft_items:[]) as {category_id?:string;size_label?:string;size?:string;attachment_ids?:unknown}[];
  const attrs=(line.attributes??{}) as {attachment_ids?:unknown;purchase_evidences?:unknown;expected_lines?:unknown};
  const expectedLines=Array.isArray(attrs.expected_lines)?(attrs.expected_lines as {quantity?:unknown}[]):[];
  if(expectedLines.length>0 && typeof line.quantity==="number") {
    const expectedSum=expectedLines.reduce((sum,entry)=>sum+Math.max(0,Math.floor(Number(entry?.quantity)||0)),0);
    guard(
      expectedSum===line.quantity,
      "VALIDATION_FAILED",
      `Expected product lines total (${expectedSum}) must equal commissioned quantity (${line.quantity}).`,
      422
    );
  }
  const lineAttachments=Array.isArray(attrs.attachment_ids)?attrs.attachment_ids:[];
  const evidences=Array.isArray(attrs.purchase_evidences)
    ?(attrs.purchase_evidences as {media_id?:unknown;extraction_status?:unknown;candidates?:unknown}[])
    :[];
  const hasBlockingEvidence=evidences.some(ev=>
    ev?.extraction_status==="pending_reassociation"
  );
  guard(
    !hasBlockingEvidence,
    "VALIDATION_FAILED",
    "Confirm or remove retained purchase evidence from the previous service before saving or requesting a quote.",
    422
  );
  const evidenceMediaIds=evidences.map(e=>e?.media_id).filter(Boolean);
  const itemAttachments=items.flatMap(item=>Array.isArray(item?.attachment_ids)?item.attachment_ids:[]);
  const allAttachments=[...new Set([...lineAttachments,...evidenceMediaIds,...itemAttachments])];
  for(const rawId of allAttachments) {
    const mediaId=z.string().uuid().parse(rawId);
    const media=(await db.query("select 1 from media_assets where id=$1 and org_id=$2 and kind='attachment' and status='ready'",[mediaId,org])).rowCount;
    guard(media,"EVIDENCE_MISMATCH","Attachment does not belong to this account.",422);
  }
  if(service==="compare") {
    const mismatch=items.some(item=>typeof item?.category_id==="string" && item.category_id!==line.category_id);
    const optCategories=(line.options as {item_categories?:unknown})?.item_categories;
    const optMismatch=Array.isArray(optCategories) && optCategories.some(cat=>typeof cat==="string" && cat!==line.category_id);
    guard(!mismatch && !optMismatch,"INCOMPATIBLE_SAMPLES","Direct comparison requires items from the same product category.",422);
    const sizes=items.map(item=>String(item?.size_label??item?.size??"").trim()).filter(Boolean);
    const sizeMismatchConfirmed=(line.options as {size_mismatch_confirmed?:unknown})?.size_mismatch_confirmed===true ||
      (line.attributes as {size_mismatch_confirmed?:unknown})?.size_mismatch_confirmed===true;
    guard(new Set(sizes).size<=1 || sizeMismatchConfirmed,"VALIDATION_FAILED","Confirm size mismatch before comparing items of different sizes.",422);
  }
  if(service==="reference_match") {
    const ref=z.object({reference_id:z.string().uuid()}).parse(line.options);
    const sample=(await db.query<{id:string;state:string;not_expired:boolean;category_id:string|null}>(`
      select r.id,r.state,r.expires_at>now() not_expired,
        ${referenceCategorySql} category_id
      from reference_samples r where r.id=$1 and r.org_id=$2`,[ref.reference_id,org])).rows[0];
    guard(sample,"NOT_FOUND","Record not found.",404);
    const sampleCat=sample.category_id;
    guard(!sampleCat || sampleCat===line.category_id,"INCOMPATIBLE_SAMPLES","The reference sample belongs to a different product category.",422);
    guard(sample.state==="active" && sample.not_expired,"REFERENCE_UNAVAILABLE","The selected reference sample is expired or unavailable.");
  }
}
export const referenceCategorySql=`coalesce(
  (select l.category_id::text from order_line_item_links a join order_lines l on l.id=a.order_line_id
   where a.item_id=r.item_id order by a.linked_at desc limit 1),
  r.authorization_snapshot->>'category_id'
)`;

const offersSql=`
  select o.id offer_id,o.sku_code,o.title,c.id category_id,c.slug category_slug,c.labels category,c.admission_snapshot,t.id template_version_id,t.content,
    st.code service,p.id price_version,p.rules
  from service_offers o join service_types st on st.id=o.service_type_id
  join offer_templates ot on ot.offer_id=o.id join categories c on c.id=ot.category_id
  join template_versions t on t.id=ot.template_version_id
  join lateral(select * from sku_prices sp where sp.offer_id=o.id and effective_from<=now()
    and (effective_to is null or effective_to>now()) order by effective_from desc,version desc limit 1) p on true
  where o.enabled and c.status='ACTIVE' and c.admission_snapshot is not null and t.state='PUBLISHED'
    and exists(select 1 from template_capabilities tc where tc.template_version_id=t.id)
    and not exists(select 1 from template_capabilities tc join capabilities cap on cap.id=tc.capability_id
      where tc.template_version_id=t.id and (cap.revoked_at is not null or cap.approved_by is null))
`;
function allowOfferRow(row:{rules?:{demo?:boolean};admission_snapshot?:{demo?:boolean}}) {
  return isDemo() || (row.rules?.demo!==true && row.admission_snapshot?.demo!==true);
}
export async function catalog(db: DB) {
  return (await db.query(offersSql+" order by o.sku_code,t.version desc")).rows
    .filter(allowOfferRow)
    .map(({admission_snapshot: _admission, ...rest}) => rest);
}
async function eligible(db: DB, line: LineInput,manual=false) {
  const offer=(await db.query(offersSql+" and o.id=$1 and c.id=$2 order by t.version desc limit 1",[line.offer_id,line.category_id])).rows[0];
  guard(offer && allowOfferRow(offer),"OFFER_UNAVAILABLE","This offer is not available.");
  const p=priceSchema.parse(offer.rules);
  guard(line.quantity>=p.minimum && (!line.items || line.items.length<=line.quantity) &&
    (offer.service!=="compare" || [2,3].includes(line.quantity)), "QUANTITY_UNAVAILABLE","Choose a valid quantity for this service.",422);
  guard(line.quantity<=p.maximum || manual && offer.service==="inspection","MANUAL_QUOTE_REQUIRED","Request a staff quote for this quantity.",422);
  return {offer,p};
}
export async function ownOrder(db:DB,actor:Actor,id:string,write=false) {
  const org=organization(actor);
  if(write) await lock(db,"org:"+org);
  return one(db,"select * from orders where id=$1 and org_id=$2"+(write?" for update":""),[id,org]);
}
export async function saveOrder(db:DB,actor:Actor,input:{lines:LineInput[];customer_notes?:string;revision?:number},id?:string) {
  const org=organization(actor);
  await lock(db,"org:"+org);
  guard(input.lines.length<=20 && input.lines.reduce((n,l)=>n+l.quantity,0)<=300,"QUANTITY_UNAVAILABLE","This request needs a custom quote.",422);
  let order;
  if(id) {
    order=await ownOrder(db,actor,id,true);
    revision(order.revision,input.revision!);
    guard(order.state==="draft","ORDER_NOT_EDITABLE","Only draft orders can be edited.");
    await db.query("delete from order_lines where order_id=$1",[id]);
    order=await one(db,"update orders set customer_notes=coalesce($2,customer_notes),revision=revision+1,updated_at=now() where id=$1 returning *",[id,input.customer_notes??null]);
  } else {
    let createdOrder = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const inserted = await db.query(
        `insert into orders(id,public_no,org_id,created_by,customer_notes,is_test)
         values($1,$2,$3,$4,$5,$6)
         on conflict (public_no) do nothing
         returning *`,
        [uuid(), orderCode(attempt >= 5 ? 1 : 0), org, actor.id, input.customer_notes ?? null, isDemo()],
      );
      if (inserted.rows[0]) {
        createdOrder = inserted.rows[0];
        break;
      }
    }
    guard(createdOrder, "ORDER_CODE_EXHAUSTED", "Could not allocate a unique order number. Try again.", 503);
    order = createdOrder;
  }
  for(const [lineIndex,line] of input.lines.entries()) {
    const {offer}=await eligible(db,line,true);
    guard(!line.template_version_id||line.template_version_id===offer.template_version_id,
      "TEMPLATE_CHANGED","The checklist changed. Reload the service and review the current checklist.");
    if(offer.category_slug==="apparel"&&offer.content.subcategory) {
      const declarations=[line.attributes,...(line.items??[])] as ({garment_type?:unknown}|undefined)[];
      guard(declarations.every(fields=>!fields?.garment_type||fields.garment_type===offer.content.subcategory),
        "INCOMPATIBLE_SAMPLES","Choose the checklist that matches the declared garment type.",422);
    }
    await validateLineSamples(db,org,line,offer.service);
    const rawExpected=Array.isArray((line.attributes as Record<string,unknown>|undefined)?.expected_lines)
      ?((line.attributes as Record<string,unknown>).expected_lines as Record<string,unknown>[])
      :[];
    const skuNotes=new Map<string,string>();
    for(const [index,el] of rawExpected.entries()) {
      const note=el?.inspection_note;
      if(note===undefined||note===null) continue;
      guard(typeof note==="string"&&Array.from(note.trim()).length<=skuNoteLimit,
        "SKU_NOTE_TOO_LONG",`Keep each SKU note within ${skuNoteLimit} characters.`,422);
      if(note.trim()) skuNotes.set(String(el.id??`EL-${index+1}`),note.trim());
    }
    const expandedFromExpected:Record<string,unknown>[]=[];
    if(!line.items?.length && rawExpected.length>0) {
      for(let elIdx=0;elIdx<rawExpected.length;elIdx++) {
        const el=rawExpected[elIdx]??{};
        const count=Math.max(0,Math.floor(Number(el.quantity??0)||0));
        for(let q=0;q<count&&expandedFromExpected.length<line.quantity;q++) {
          expandedFromExpected.push({
            expected_line_id:String(el.id??`EL-${elIdx+1}`),
            sku_code:typeof el.sku_code==="string"?el.sku_code.trim():undefined,
            name:typeof el.product_name==="string"&&el.product_name.trim()?el.product_name.trim():((line.attributes as Record<string,unknown>|undefined)?.name??undefined),
            color_declared:typeof el.color_declared==="string"?el.color_declared.trim():undefined,
            size_label:typeof el.size_label==="string"?el.size_label.trim():undefined,
            supplier_alias:typeof el.supplier_alias==="string"?el.supplier_alias.trim():undefined,
            declared_tracking_no:typeof el.tracking_no==="string"?el.tracking_no.trim():undefined,
            garment_type:(line.attributes as Record<string,unknown>|undefined)?.garment_type,
          });
        }
      }
    }
    const normalizedItems=Array.from({length:line.quantity},(_,idx)=>{
      const raw=(line.items?.[idx]??expandedFromExpected[idx]??{}) as Record<string,unknown>;
      const note=skuNotes.get(String(raw.expected_line_id??""));
      const defaultCode=`L${lineIndex+1}-P${String(idx+1).padStart(2,"0")}`;
      return {
        position:idx+1,
        sample_code:typeof raw.sample_code==="string"&&raw.sample_code.trim()?raw.sample_code.trim():defaultCode,
        ...raw,
        ...(note&&raw.notes===undefined?{notes:note}:{}),
      };
    });
    await db.query(`insert into order_lines(order_id,org_id,offer_id,category_id,template_version_id,quantity,options,attributes,draft_items)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [order.id,org,line.offer_id,line.category_id,offer.template_version_id,line.quantity,line.options??{},line.attributes??{},JSON.stringify(normalizedItems)]);
  }
  await audit(db,actor,id?"edit_draft":"create_draft","orders",order.id);
  return orderDTO(order as Parameters<typeof orderDTO>[0]);
}
export function orderDTO(o:{id:string;public_no:string;state:string;revision:number}) {
  return {id:o.id,public_no:o.public_no,state:o.state,revision:o.revision};
}
const orderTerms=["terms","privacy","restricted_items","report_notice"];
async function pricedLines(db:DB,id:string,manual=false) {
  const lines=(await db.query("select * from order_lines where order_id=$1 order by id",[id])).rows;
  guard(lines.length,"ORDER_EMPTY","Add at least one service.");
  const snapshot=[];
  for(const line of lines) {
    const {offer,p}=await eligible(db,line,manual);
    guard(offer.template_version_id===line.template_version_id,"TEMPLATE_CHANGED","Review the latest inspection template.");
    const pendingEvidence=(Array.isArray(line.attributes?.purchase_evidences)?line.attributes.purchase_evidences:[])
      .some((ev:{extraction_status?:unknown;candidates?:unknown})=>
        ev?.extraction_status==="needs_confirmation" && Array.isArray(ev?.candidates) && ev.candidates.length>0);
    guard(!pendingEvidence,"VALIDATION_FAILED","Confirm or discard pending extracted purchase rows before requesting an official quote.",422);
    await validateLineSamples(db,line.org_id,line,offer.service);
    snapshot.push({order_line_id:line.id,category_id:line.category_id,offer_id:line.offer_id,template_version_id:line.template_version_id,
      quantity:line.quantity,price_version:offer.price_version,amount_cents:p.package_cents??p.unit_cents!*line.quantity,
      business_days:p.business_days,options:line.options});
  }
  return snapshot;
}
export async function quoteOrder(db:DB,actor:Actor,id:string,rev:number) {
  const order=await ownOrder(db,actor,id,true);
  revision(order.revision,rev);
  guard(order.state==="draft" || order.state==="awaiting_payment","ORDER_NOT_EDITABLE","Order is already in fulfillment.");
  const snapshot=await pricedLines(db,id),terms=await currentTerms(db,orderTerms);
  guard(terms.length===4,"TERMS_UNAVAILABLE","Ordering is unavailable until current terms are published.");
  const validity=await newQuoteValidity(db,"inspection");
  return storeQuote(db,id,snapshot,{terms:terms.map(t=>t.id),order_revision:rev,quote_validity:validity.snapshot},validity.expires_at);
}
async function storeQuote(db:DB,id:string,snapshot:Awaited<ReturnType<typeof pricedLines>>,terms:object,expires:Date) {
  const previous=await one<{n:number}>(db,"select coalesce(max(revision),0) n from inspection_quotes where order_id=$1",[id]);
  return one(db,`insert into inspection_quotes(order_id,revision,line_snapshot,terms_snapshot,amount_cents,currency,expires_at)
    values($1,$2,$3,$4,$5,'USD',$6)
    returning id,order_id,revision,line_snapshot,amount_cents,currency,expires_at`,
    [id,previous.n+1,JSON.stringify(snapshot),terms,snapshot.reduce((n,l)=>n+l.amount_cents,0),expires]);
}

export const expiredManualInspectionPaymentSql=`o.state='awaiting_payment' and exists(
  select 1 from inspection_quotes q join charge_items c on c.inspection_quote_id=q.id and c.org_id=o.org_id
  where q.order_id=o.id and q.id::text=o.submission_snapshot->>'quote_id'
    and q.terms_snapshot ? 'manual_request_id' and q.accepted_at is not null and q.expires_at<=now()
    and c.scope_revision_id is null and c.voided_at is null and c.applied_payment_id is null and c.free_authorization is null
    and not ${unresolvedQuotePayment}
)`;
export const eligibleManualQuoteOrderSql=`(o.state='draft' or (${expiredManualInspectionPaymentSql}))`;

async function canRenewManualInspection(db:DB,id:string,state:string) {
  if(state!=="awaiting_payment") return false;
  return (await one<{renewable:boolean}>(db,`select (${expiredManualInspectionPaymentSql}) renewable from orders o where o.id=$1`,[id])).renewable;
}

export async function requestManualQuote(db:DB,actor:Actor,id:string,rev:number,reason:string) {
  const order=await ownOrder(db,actor,id,true);
  revision(order.revision,rev);
  guard(order.state==="draft"||await canRenewManualInspection(db,id,order.state),"ORDER_NOT_EDITABLE",
    "An updated manual quote is available after the current quote expires and pending payments are resolved.");
  await pricedLines(db,id,true);
  const current=(await db.query(`select r.id,r.state from manual_quote_requests r
    left join inspection_quotes q on q.id=r.accepted_quote_id
    where r.order_id=$1 and r.revision=$2
      and (r.state='requested' or (r.state='offered' and q.expires_at>now() and q.accepted_at is null))`,[id,rev])).rows[0];
  if(current) return current;
  const req=await one(db,`insert into manual_quote_requests(id,org_id,order_id,revision,state,due_at,reason)
    values($1,$2,$3,$4,'requested',now()+interval '2 days',$5)
    on conflict(order_id,revision) do update set state='requested',reason=excluded.reason,
      due_at=excluded.due_at,assignee_id=null,accepted_quote_id=null
    returning id,state`,[uuid(),order.org_id,id,rev,reason]);
  await audit(db,actor,"request_manual_quote","manual_quote_requests",req.id);
  return req;
}
type ManualQuote={revision:number;reason:string;expires_at:string;terms_version_ids:string[];
  lines:{order_line_id:string;amount_cents:number;business_days:number}[]};
export async function issueManualQuote(db:DB,actor:Actor,id:string,input:ManualQuote) {
  role(actor,"support","super_admin");
  const initial=await one(db,"select org_id from orders where id=$1",[id]);
  await lock(db,"org:"+initial.org_id);
  const order=await one(db,"select * from orders where id=$1 for update",[id]);
  revision(order.revision,input.revision);
  guard(order.state==="draft"||await canRenewManualInspection(db,id,order.state),"ORDER_NOT_EDITABLE",
    "This order is no longer eligible for a manual quote.");
  const request=await one(db,`select * from manual_quote_requests where order_id=$1 and revision=$2
    and state in ('requested','offered') for update`,[id,input.revision]);
  guard(!request.assignee_id || request.assignee_id===actor.id,"QUOTE_ASSIGNEE_REQUIRED","Another staff member owns this request.",403);
  const expires=new Date(input.expires_at),now=Date.now();
  guard(expires.valueOf()>now && expires.valueOf()<=now+30*86400_000,"QUOTE_EXPIRY_INVALID","Set a future expiry within 30 days.",422);
  const terms=await currentTerms(db,orderTerms);
  requireTerms(terms,input.terms_version_ids,4);
  const scoped=await pricedLines(db,id,true);
  const byLine=new Map(input.lines.map(line=>[line.order_line_id,line]));
  guard(byLine.size===input.lines.length && byLine.size===scoped.length &&
    scoped.every(line=>byLine.has(line.order_line_id)) && input.lines.every(line=>line.amount_cents<=10_000_000 && line.business_days<=180),
    "QUOTE_LINES_INVALID","Enter a valid amount and lead time for each current order line.",422);
  const snapshot=scoped.map(line=>({...line,...byLine.get(line.order_line_id)!}));
  if(snapshot.every(line=>line.amount_cents===0)) role(actor,"super_admin");
  const quote=await storeQuote(db,id,snapshot,{
    terms:terms.map(t=>t.id),order_revision:input.revision,manual_request_id:request.id,issued_by:actor.id
  },expires);
  await db.query("update manual_quote_requests set assignee_id=$2,state='offered',accepted_quote_id=$3 where id=$1",[request.id,actor.id,quote.id]);
  await audit(db,actor,"issue_manual_quote","manual_quote_requests",request.id,{quote_id:quote.id,reason:input.reason});
  await event(db,"quote.offered",{order_id:id,quote_id:quote.id});
  return quote;
}
export async function submitOrder(db:DB,actor:Actor,id:string,input:{revision:number;quote_id:string;terms_version_ids:string[];acknowledgements:object}) {
  await requireCustomerActive(db,actor);
  const order=await ownOrder(db,actor,id,true);
  revision(order.revision,input.revision);
  guard(order.state==="draft" || order.state==="awaiting_payment","ORDER_NOT_EDITABLE","Order is already in fulfillment.");
  const q=await one(db,`select *,expires_at>now() valid from inspection_quotes where id=$1 and order_id=$2 for update`,[input.quote_id,id]);
  const terms=await currentTerms(db,orderTerms);
  requireTerms(terms,input.terms_version_ids,4);
  const manualId=q.terms_snapshot.manual_request_id as string|undefined;
  const current=await pricedLines(db,id,!!manualId);
  if(manualId) await one(db,`select id from manual_quote_requests where id=$1 and order_id=$2
    and state='offered' and accepted_quote_id=$3 for update`,[manualId,id,q.id]);
  guard(q.valid && !q.accepted_at && q.terms_snapshot.order_revision===order.revision &&
    terms.every(t=>q.terms_snapshot.terms.includes(t.id)) &&
    current.every((l,i)=>q.line_snapshot[i]?.price_version===l.price_version && (manualId || q.line_snapshot[i]?.amount_cents===l.amount_cents)) &&
    current.length===q.line_snapshot.length,
    "QUOTE_STALE","Request a new quote before paying.");
  const existing=(await db.query(`select c.id from charge_items c join inspection_quotes q on q.id=c.inspection_quote_id
    where q.order_id=$1 and c.org_id=$2 and c.voided_at is null and ${unresolvedQuotePayment}`,[id,order.org_id])).rowCount;
  guard(!existing,"PAYMENT_PROCESSING","Wait for the existing payment to resolve.");
  await db.query(`update charge_items c set voided_at=now() from inspection_quotes q
    where q.id=c.inspection_quote_id and q.order_id=$1 and c.applied_payment_id is null and c.voided_at is null`,[id]);
  await db.query("update inspection_quotes set accepted_at=now() where id=$1",[q.id]);
  if(manualId) await db.query("update manual_quote_requests set state='accepted' where id=$1",[manualId]);
  await db.query("insert into consents(id,order_id,user_id,terms_version_ids,acknowledgements) values($1,$2,$3,$4,$5)",[uuid(),id,actor.id,input.terms_version_ids,input.acknowledgements]);
  const charge=await one(db,`insert into charge_items(org_id,purpose,inspection_quote_id,amount_cents,currency,snapshot)
    values($1,'inspection',$2,$3,'USD',$4) returning id as charge_item_id,amount_cents,currency`,
    [order.org_id,q.id,q.amount_cents,{order_id:id,quote_revision:q.revision}]);
  const updated=await one(db,`update orders set state='awaiting_payment',price_cents=$2,submission_snapshot=$3,revision=revision+1
    where id=$1 returning *`,[id,q.amount_cents,{quote_id:q.id,lines:q.line_snapshot,terms:input.terms_version_ids}]);
  if(q.amount_cents===0) {
    guard(manualId && q.terms_snapshot.issued_by,"FREE_AUTHORIZATION_REQUIRED","A zero-price inspection requires staff authorization.");
    await db.query("update charge_items set free_authorization=$2 where id=$1",[charge.charge_item_id,{quote_id:q.id,authorized_by:q.terms_snapshot.issued_by}]);
    await activatePaidOrder(db,id);
  }
  await audit(db,actor,"submit_order","orders",id);
  const result=q.amount_cents===0?await ownOrder(db,actor,id):updated;
  return {order:orderDTO(result as Parameters<typeof orderDTO>[0]),charge};
}

export async function activatePaidOrder(db:DB,orderId:string) {
  await db.query(`insert into expected_items(order_line_id,position,declared_fields)
    select l.id,n,coalesce(l.draft_items->(n-1),'{}'::jsonb) from order_lines l
    cross join lateral generate_series(1,l.quantity) n where l.order_id=$1 on conflict do nothing`,[orderId]);
  await db.query("update orders set state='awaiting_samples',paid_at=now(),revision=revision+1 where id=$1",[orderId]);
  await readyOrder(db,orderId);
}

function parseDateList(raw:unknown):Set<string> {
  if(!raw) return new Set();
  if(Array.isArray(raw)) {
    return new Set(raw.map(x=>String(x).trim()).filter(Boolean));
  }
  if(typeof raw!=="string") return new Set();
  const trimmed=raw.trim();
  if(!trimmed) return new Set();
  try {
    const parsed=JSON.parse(trimmed);
    if(Array.isArray(parsed)) return new Set(parsed.map(x=>String(x).trim()).filter(Boolean));
  } catch {
    // Fallback to comma/space separated YYYY-MM-DD strings
  }
  return new Set(trimmed.split(/[\s,]+/).map(x=>x.trim()).filter(Boolean));
}

export function businessDeadline(start:Date,days:number,holidays:Iterable<string>=[],extraWorkdays:Iterable<string>=[]) {
  const holidaySet=new Set(holidays);
  const extraSet=new Set(extraWorkdays);
  const d=new Date(start);
  while(days>0) {
    d.setUTCDate(d.getUTCDate()+1);
    const cn=new Date(d.valueOf()+8*3600000);
    const dateKey=cn.toISOString().slice(0,10);
    const dow=cn.getUTCDay();
    const isWorkday=extraSet.has(dateKey) || (dow!==0 && dow!==6 && !holidaySet.has(dateKey));
    if(isWorkday) days--;
  }
  return d;
}
export function orderItemReadiness(db:DB,id:string) {
  return one<{total:number;ready:number}>(db,`select count(*)::int total,count(*) filter(where w.identity_state='identified' and w.custody_state in ('received','stored'))::int ready
    from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
    left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
    left join warehouse_items w on w.id=a.item_id where l.order_id=$1`,[id]);
}

export const orderAcceptsSampleAssignmentSql=`o.paid_at is not null and (
  o.state='awaiting_samples' or (o.state='on_hold' and o.held_from_state='awaiting_samples'
    and exists(select 1 from order_blocks b where b.order_id=o.id and b.reason='quantity_discrepancy'
      and b.resolved_at is null and exists(select 1 from tickets k where k.order_id=o.id and k.org_id=o.org_id
        and k.public_no like 'QTY-%' and k.details->>'package_id'=b.object_key and k.details->>'discrepancy_type'='shortage'))
    and not exists(select 1 from order_blocks b where b.order_id=o.id and b.reason<>'quantity_discrepancy' and b.resolved_at is null)
  )
)`;

export async function readyOrder(db:DB,id:string) {
  const order=await one(db,"select * from orders where id=$1 for update",[id]);
  if(order.state!=="awaiting_samples" || !order.paid_at) return;
  const counts=await orderItemReadiness(db,id);
  if(!counts.total || counts.total!==counts.ready || (await db.query("select 1 from order_blocks where order_id=$1 and resolved_at is null",[id])).rowCount) return;
  const lines=(await db.query(`select l.*,st.code service from order_lines l join service_offers o on o.id=l.offer_id join service_types st on st.id=o.service_type_id where l.order_id=$1`,[id])).rows;
  for(const line of lines) {
    const inScopeCount=await one<{n:number}>(db,"select count(*)::int n from expected_items where order_line_id=$1 and in_scope",[line.id]);
    if(!inScopeCount.n) continue;
    if(line.service==="inspection") {
      await db.query(`insert into inspection_tasks(order_line_id,template_version_id,assignment_id,state)
        select a.order_line_id,$2,a.id,'READY' from order_line_item_links a join expected_items e on e.id=a.expected_item_id
        where a.order_line_id=$1 and a.unlinked_at is null and e.in_scope on conflict do nothing`,[line.id,line.template_version_id]);
      continue;
    }
    const referenceId=line.options.reference_id??null;
    if(line.service==="reference_match") {
      const ref=(await db.query(`select r.id from reference_samples r join warehouse_items w on w.id=r.item_id where r.id=$1
        and r.org_id=$2 and r.state='active' and r.expires_at>now() and w.custody_state='stored'
        and not exists(select 1 from reference_reservations where reference_id=r.id and released_at is null)
        and not exists(select 1 from disposition_requests where item_id=w.id and state not in ('completed','cancelled')) for update of r,w`,[referenceId,order.org_id])).rows[0];
      guard(ref,"REFERENCE_UNAVAILABLE","The selected reference sample is expired or unavailable.");
    }
    const group=await one<{id:string}>(db,`insert into inspection_groups(order_line_id,purpose,reference_id) values($1,$2,$3) returning id`,[line.id,line.service,referenceId]);
    await db.query(`insert into group_members(group_id,assignment_id,order_line_id)
      select $1,a.id,a.order_line_id from order_line_item_links a join expected_items e on e.id=a.expected_item_id
      where a.order_line_id=$2 and a.unlinked_at is null and e.in_scope`,[group.id,line.id]);
    if(referenceId) await db.query("insert into reference_reservations(id,reference_id,group_id,reserved_at) values($1,$2,$3,now())",[uuid(),referenceId,group.id]);
    await db.query("insert into inspection_tasks(order_line_id,template_version_id,group_id,state) values($1,$2,$3,'READY')",[line.id,line.template_version_id,group.id]);
  }
  const calendarRows=(await db.query<{key:string;value:string}>("select key,value from app_config where key in ('calendar.holidays','business_holidays','calendar.extra_workdays')")).rows;
  const holidays=new Set<string>();
  const extraWorkdays=new Set<string>();
  for(const row of calendarRows) {
    const parsed=parseDateList(row.value);
    if(row.key==="calendar.extra_workdays") parsed.forEach(d=>extraWorkdays.add(d));
    else parsed.forEach(d=>holidays.add(d));
  }
  const days=Math.max(...order.submission_snapshot.lines.map((x:{business_days:number})=>x.business_days));
  await db.query("update orders set state='queued',samples_ready_at=coalesce(samples_ready_at,now()),sla_due_at=coalesce(sla_due_at,$2),revision=revision+1 where id=$1",
    [id,businessDeadline(new Date(),days,holidays,extraWorkdays)]);
  await event(db,"order.ready",{order_id:id});
}
export type ExpectedLineBreakdown={
  order_line_id:string;
  expected_line_id:string;
  sku_code:string;
  product_name:string;
  color_declared:string;
  size_label:string;
  supplier_alias:string;
  tracking_no:string;
  carrier_code:string;
  purchase_order_ref:string;
  unit_price_note:string;
  expected_qty:number;
  arrived_qty:number;
  identified_qty:number;
  mismatch_qty:number;
  damaged_qty:number;
  missing_qty:number;
  unverified_short_qty:number;
  confirmed_short_qty:number;
  unidentified_pending_qty:number;
  extra_qty:number;
  inspected_qty:number;
  outstanding_qty:number;
  linked_item_codes:string[];
  evidence_ids:string[];
};

export type ParcelReconciliationRow={
  advice_id:string;
  tracking_norm:string;
  carrier_code:string|null;
  carrier_name:string|null;
  package_code:string|null;
  warehouse_state:string|null;
  received_at:Date|string|null;
  outer_condition:string|null;
  supplier_alias:string;
  contents_unknown:boolean;
  declared_qty:number;
  logged_item_count:number;
  identified_item_count:number;
  unidentified_item_count:number;
  damaged_item_count:number;
  short_qty:number;
  unverified_short_qty:number;
  confirmed_short_qty:number;
  extra_qty:number;
  item_codes:string[];
};

export function summarizeExpectedLines(
  lines:{id:string;quantity:number;attributes?:Record<string,unknown>|null;draft_items?:unknown[]|null}[],
  expectedRows:{
    id?:string;
    expected_item_id?:string;
    order_line_id:string;
    position?:number;
    declared_fields?:Record<string,unknown>|null;
    item_id?:string|null;
    linked_item_id?:string|null;
    code?:string|null;
    identity_state?:string|null;
    condition_state?:string|null;
    inspection_stage?:string|null;
  }[],
  parcelRows:{
    id:string;
    tracking_norm:string;
    carrier_code?:string|null;
    carrier_name?:string|null;
    package_code?:string|null;
    warehouse_state?:string|null;
    received_at?:Date|string|null;
    outer_condition?:string|null;
    received_quantity?:number|null;
    logged_item_count?:number|null;
    identified_item_count?:number|null;
    damaged_item_count?:number|null;
    item_codes?:string[]|null;
    shared_parcel?:boolean;
    shortage_confirmed?:boolean;
  }[]=[]
) {
  const breakdown:ExpectedLineBreakdown[]=[];
  const purchaseEvidences:Record<string,unknown>[]=[];
  const plannedParcels:Record<string,unknown>[]=[];
  const supplierSet=new Set<string>();
  const waybillSet=new Set<string>();
  const normTrack=(v:unknown)=>String(v??"").replace(/\s+/g,"").toUpperCase();

  for(const line of lines) {
    const attrs=(line.attributes??{}) as Record<string,unknown>;
    if(Array.isArray(attrs.purchase_evidences)) {
      for(const ev of attrs.purchase_evidences) {
        if(ev && typeof ev==="object") purchaseEvidences.push({...(ev as Record<string,unknown>),order_line_id:line.id});
      }
    }
    if(Array.isArray(attrs.planned_parcels)) {
      for(const pp of attrs.planned_parcels) {
        if(pp && typeof pp==="object") {
          const rec=pp as Record<string,unknown>;
          plannedParcels.push({...rec,order_line_id:line.id});
          const tn=normTrack(rec.tracking_no);
          if(tn && tn.length>=5) waybillSet.add(tn);
          const sup=String(rec.supplier_alias??"").trim();
          if(sup) supplierSet.add(sup);
        }
      }
    }
    const lineRows=expectedRows.filter(r=>r.order_line_id===line.id && (r.id || r.expected_item_id));
    const draftFallback=Array.isArray(line.draft_items)?(line.draft_items as Record<string,unknown>[]):[];
    const declaredExpected=Array.isArray(attrs.expected_lines)?(attrs.expected_lines as Record<string,unknown>[]):[];

    if(declaredExpected.length>0) {
      const assignedRowIds=new Set<string>();
      const matchedByIdx:(typeof lineRows)[]=[];
      const bucketMeta:Array<{
        el:Record<string,unknown>;elId:string;skuCode:string;productName:string;colorDeclared:string;
        sizeLabel:string;supplierAlias:string;trackingNo:string;carrierCode:string;poRef:string;
        unitPriceNote:string;declaredQty:number;
      }>=[];
      for(let idx=0;idx<declaredExpected.length;idx++) {
        const el=declaredExpected[idx]??{};
        const elId=String(el.id??`EL-${idx+1}`);
        const skuCode=String(el.sku_code??"").trim();
        const productName=String(el.product_name??attrs.name??"").trim();
        const colorDeclared=String(el.color_declared??"").trim();
        const sizeLabel=String(el.size_label??"").trim();
        const supplierAlias=String(el.supplier_alias??attrs.supplier_alias??attrs.supplier_ref??"").trim();
        const trackingNo=normTrack(el.tracking_no??attrs.tracking_no);
        const carrierCode=String(el.carrier_code??"").trim().toUpperCase();
        const poRef=String(el.purchase_order_ref??"").trim();
        const unitPriceNote=String(el.unit_price_note??"").trim();
        const declaredQty=Math.max(0,Number(el.quantity??0)||0);
        if(supplierAlias) supplierSet.add(supplierAlias);
        if(trackingNo && trackingNo.length>=5) waybillSet.add(trackingNo);

        const matched=lineRows.filter(r=>{
          const rowKey=String(r.expected_item_id??r.id);
          if(assignedRowIds.has(rowKey)) return false;
          const df=(r.declared_fields??{}) as Record<string,unknown>;
          if(df.expected_line_id && String(df.expected_line_id)===elId) return true;
          const rSku=String(df.sku_code??df.sample_code??"").trim();
          const rColor=String(df.color_declared??df.color??"").trim();
          const rSize=String(df.size_label??df.size??"").trim();
          return !df.expected_line_id && (
            (skuCode && rSku===skuCode)
            || (!skuCode && colorDeclared && sizeLabel && rColor===colorDeclared && rSize===sizeLabel)
          );
        });
        const boundedMatched=matched.slice(0,declaredQty||matched.length);
        for(const m of boundedMatched) assignedRowIds.add(String(m.expected_item_id??m.id));
        matchedByIdx.push(boundedMatched);
        bucketMeta.push({el,elId,skuCode,productName,colorDeclared,sizeLabel,supplierAlias,trackingNo,carrierCode,poRef,unitPriceNote,declaredQty});
      }
      const leftoverRows=lineRows.filter(r=>!assignedRowIds.has(String(r.expected_item_id??r.id)));
      for(let idx=0;idx<bucketMeta.length&&leftoverRows.length>0;idx++) {
        const cap=bucketMeta[idx].declaredQty;
        const cur=matchedByIdx[idx];
        while((cap===0||cur.length<cap)&&leftoverRows.length>0) {
          cur.push(leftoverRows.shift()!);
        }
      }
      for(let idx=0;idx<bucketMeta.length;idx++) {
        const {el,elId,skuCode,productName,colorDeclared,sizeLabel,supplierAlias,trackingNo,carrierCode,poRef,unitPriceNote,declaredQty}=bucketMeta[idx];
        const boundedMatched=matchedByIdx[idx];
        const arrivedQty=boundedMatched.filter(r=>Boolean(r.item_id||r.linked_item_id)).length;
        const identifiedQty=boundedMatched.filter(r=>r.identity_state==="identified").length;
        const mismatchQty=boundedMatched.filter(r=>r.identity_state==="mismatch").length;
        const damagedQty=boundedMatched.filter(r=>Boolean(r.item_id||r.linked_item_id)&&r.condition_state&&!["good","unchecked"].includes(r.condition_state)).length;
        const inspectedQty=boundedMatched.filter(r=>r.inspection_stage==="inspected").length;
        const extraQty=Math.max(0,arrivedQty-declaredQty);
        const linkedItemCodes=boundedMatched.map(r=>String(r.code??"").trim()).filter(Boolean);
        const evidenceIds=Array.isArray(el.evidence_ids)?el.evidence_ids.map(x=>String(x)):[];
        breakdown.push({
          order_line_id:line.id,
          expected_line_id:elId,
          sku_code:skuCode,
          product_name:productName,
          color_declared:colorDeclared,
          size_label:sizeLabel,
          supplier_alias:supplierAlias,
          tracking_no:trackingNo,
          carrier_code:carrierCode,
          purchase_order_ref:poRef,
          unit_price_note:unitPriceNote,
          expected_qty:declaredQty,
          arrived_qty:arrivedQty,
          identified_qty:identifiedQty,
          mismatch_qty:mismatchQty,
          damaged_qty:damagedQty,
          missing_qty:0,
          unverified_short_qty:0,
          confirmed_short_qty:0,
          unidentified_pending_qty:0,
          extra_qty:extraQty,
          inspected_qty:inspectedQty,
          outstanding_qty:Math.max(0,declaredQty-identifiedQty),
          linked_item_codes:linkedItemCodes,
          evidence_ids:evidenceIds,
        });
      }
      continue;
    }

    // Legacy / item-level fallback: group identical variant tuples
    const groupMap=new Map<string,{item:ExpectedLineBreakdown;ids:Set<string>}>();
    const sourceRows=lineRows.length>0
      ?lineRows.map(r=>({
        rowId:String(r.expected_item_id??r.id),
        df:(r.declared_fields??{}) as Record<string,unknown>,
        code:String(r.code??"").trim(),
        arrived:Boolean(r.item_id||r.linked_item_id),
        identified:r.identity_state==="identified",
        mismatch:r.identity_state==="mismatch",
        damaged:Boolean(r.item_id||r.linked_item_id)&&Boolean(r.condition_state)&&!["good","unchecked"].includes(String(r.condition_state)),
        inspected:r.inspection_stage==="inspected",
      }))
      :draftFallback.map((df,idx)=>({
        rowId:`draft-${idx}`,
        df,
        code:"",
        arrived:false,
        identified:false,
        mismatch:false,
        damaged:false,
        inspected:false,
      }));
    for(const entry of sourceRows) {
      const df=entry.df;
      const sku=String(df.sku_code??df.sample_code??attrs.sample_code_prefix??"").trim();
      const prod=String(df.name??attrs.name??"").trim();
      const color=String(df.color_declared??df.color??attrs.color_declared??"").trim();
      const size=String(df.size_label??df.size??attrs.size_label??"").trim();
      const sup=String(df.supplier_alias??df.supplier??attrs.supplier_alias??attrs.supplier_ref??"").trim();
      const track=normTrack(df.declared_tracking_no??df.tracking_no??attrs.tracking_no);
      if(sup) supplierSet.add(sup);
      if(track && track.length>=5) waybillSet.add(track);
      const groupKey=[line.id,prod,color,size,sup,track,sourceRows.length<=3?sku:""].join("|");
      let bucket=groupMap.get(groupKey);
      if(!bucket) {
        bucket={
          item:{
            order_line_id:line.id,
            expected_line_id:String(df.expected_line_id??`LEGACY-${groupMap.size+1}`),
            sku_code:sku,
            product_name:prod,
            color_declared:color,
            size_label:size,
            supplier_alias:sup,
            tracking_no:track,
            carrier_code:String(df.carrier_code??"").trim().toUpperCase(),
            purchase_order_ref:String(df.purchase_order_ref??"").trim(),
            unit_price_note:String(df.unit_price_note??"").trim(),
            expected_qty:0,
            arrived_qty:0,
            identified_qty:0,
            mismatch_qty:0,
            damaged_qty:0,
            missing_qty:0,
            unverified_short_qty:0,
            confirmed_short_qty:0,
            unidentified_pending_qty:0,
            extra_qty:0,
            inspected_qty:0,
            outstanding_qty:0,
            linked_item_codes:[],
            evidence_ids:[],
          },
          ids:new Set(),
        };
        groupMap.set(groupKey,bucket);
      }
      bucket.item.expected_qty+=1;
      if(entry.arrived) bucket.item.arrived_qty+=1;
      if(entry.identified) bucket.item.identified_qty+=1;
      if(entry.mismatch) bucket.item.mismatch_qty+=1;
      if(entry.damaged) bucket.item.damaged_qty+=1;
      if(entry.inspected) bucket.item.inspected_qty+=1;
      if(entry.code) bucket.item.linked_item_codes.push(entry.code);
      bucket.item.outstanding_qty=Math.max(0,bucket.item.expected_qty-bucket.item.identified_qty);
    }
    for(const b of groupMap.values()) breakdown.push(b.item);
  }

  const expectedUnitsTotal=breakdown.reduce((s,r)=>s+r.expected_qty,0) || lines.reduce((s,l)=>s+(Number(l.quantity)||0),0);
  const arrivedUnitsTotal=breakdown.reduce((s,r)=>s+r.arrived_qty,0);
  const identifiedUnitsTotal=breakdown.reduce((s,r)=>s+r.identified_qty,0);
  const inspectedUnitsTotal=breakdown.reduce((s,r)=>s+r.inspected_qty,0);
  const mismatchUnitsTotal=breakdown.reduce((s,r)=>s+r.mismatch_qty,0);
  const checkedInParcels=parcelRows.filter(p=>Boolean(p.warehouse_state));
  const parcelLoggedTotal=checkedInParcels.reduce((s,p)=>s+(Number(p.logged_item_count??p.received_quantity??0)||0),0);
  const loggedUnitsTotal=Math.max(parcelLoggedTotal,arrivedUnitsTotal);
  const unidentifiedUnitsTotal=Math.max(0,parcelLoggedTotal-identifiedUnitsTotal-mismatchUnitsTotal);
  const parcelDamagedTotal=checkedInParcels.reduce((s,p)=>s+(Number(p.damaged_item_count??0)||0),0);
  const damagedUnitsTotal=Math.max(parcelDamagedTotal,breakdown.reduce((s,r)=>s+r.damaged_qty,0));
  const anyContentsUnknown=plannedParcels.some(pp=>Boolean(pp.contents_unknown));
  const allExpectedParcelsCheckedIn=checkedInParcels.length>0
    && checkedInParcels.length===parcelRows.length
    && (plannedParcels.length===0 || checkedInParcels.length>=plannedParcels.length);
  const allExpectedParcelsCounted=allExpectedParcelsCheckedIn&&checkedInParcels.every(p=>
    p.shortage_confirmed||Number(p.logged_item_count??p.received_quantity??0)>0);

  const parcelReconciliation:ParcelReconciliationRow[]=parcelRows.map(p=>{
    const tn=normTrack(p.tracking_norm);
    const matchingPlanned=plannedParcels.find(pp=>normTrack(pp.tracking_no)===tn);
    const matchingLines=breakdown.filter(b=>b.tracking_no===tn);
    const trackingDeclaredQty=matchingLines.reduce((s,b)=>s+b.expected_qty,0);
    const singleBoxFallback=parcelRows.length===1 && plannedParcels.length<=1 && !anyContentsUnknown && breakdown.every(b=>!b.tracking_no);
    const declaredQty=trackingDeclaredQty>0?trackingDeclaredQty:singleBoxFallback?expectedUnitsTotal:0;
    const contentsUnknown=Boolean(matchingPlanned?.contents_unknown)||(trackingDeclaredQty===0 && parcelRows.length>1);
    const loggedCount=Number(p.logged_item_count??p.received_quantity??0)||0;
    const identifiedCount=Number(p.identified_item_count??0)||0;
    const unidentifiedCount=Math.max(0,loggedCount-identifiedCount);
    const damagedCount=Number(p.damaged_item_count??0)||0;
    const checkedIn=Boolean(p.warehouse_state);
    const shortQty=checkedIn && (p.shortage_confirmed||loggedCount>0&&!p.shared_parcel)&&declaredQty>0?Math.max(0,declaredQty-loggedCount):0;
    const extraQty=checkedIn && declaredQty>0?Math.max(0,loggedCount-declaredQty):0;
    const confirmedShortQty=p.shortage_confirmed&&unidentifiedCount===0?shortQty:0;
    const unverifiedShortQty=shortQty-confirmedShortQty;
    return {
      advice_id:p.id,
      tracking_norm:p.tracking_norm,
      carrier_code:p.carrier_code??null,
      carrier_name:p.carrier_name??null,
      package_code:p.package_code??null,
      warehouse_state:p.warehouse_state??null,
      received_at:p.received_at??null,
      outer_condition:p.outer_condition??null,
      supplier_alias:String(matchingPlanned?.supplier_alias??"").trim()||matchingLines.map(m=>m.supplier_alias).filter(Boolean).join(", ")||"—",
      contents_unknown:contentsUnknown,
      declared_qty:declaredQty,
      logged_item_count:loggedCount,
      identified_item_count:identifiedCount,
      unidentified_item_count:unidentifiedCount,
      damaged_item_count:damagedCount,
      short_qty:shortQty,
      unverified_short_qty:unverifiedShortQty,
      confirmed_short_qty:confirmedShortQty,
      extra_qty:extraQty,
      item_codes:Array.isArray(p.item_codes)?p.item_codes:[],
    };
  });

  // Never attribute per-SKU Missing to in-transit parcels or while physically logged units are awaiting SKU identification
  for(const row of breakdown) {
    const rowCheckedIn=row.tracking_no
      ?checkedInParcels.some(p=>p.shortage_confirmed&&normTrack(p.tracking_norm)===row.tracking_no)
      :parcelRows.length===1&&parcelRows.some(p=>p.shortage_confirmed);
    if(!rowCheckedIn) {
      row.unidentified_pending_qty=0;
      row.missing_qty=0;
      row.unverified_short_qty=0;
      row.confirmed_short_qty=0;
    } else if(unidentifiedUnitsTotal>0) {
      row.unidentified_pending_qty=Math.max(0,row.expected_qty-row.identified_qty);
      row.missing_qty=0;
      row.unverified_short_qty=0;
      row.confirmed_short_qty=0;
    } else if(row.arrived_qty<row.expected_qty) {
      const short=Math.max(0,row.expected_qty-row.arrived_qty);
      row.missing_qty=short;
      row.confirmed_short_qty=short;
      row.unverified_short_qty=0;
      row.unidentified_pending_qty=0;
    }
  }

  const parcelDeclaredSum=parcelReconciliation.reduce((s,pr)=>s+pr.declared_qty,0);
  const canUseOrderTotalShort=allExpectedParcelsCounted&&!parcelRows.some(p=>p.shared_parcel)
    && (plannedParcels.length===0 || parcelDeclaredSum>=expectedUnitsTotal);
  const shortUnitsTotal=canUseOrderTotalShort
    ?Math.max(0,expectedUnitsTotal-loggedUnitsTotal)
    :parcelReconciliation.reduce((s,pr)=>s+pr.short_qty,0);
  const extraUnitsTotal=allExpectedParcelsCounted
    ?Math.max(0,loggedUnitsTotal-expectedUnitsTotal)
    :parcelReconciliation.reduce((s,pr)=>s+pr.extra_qty,0);
  const unarrivedUnitsTotal=canUseOrderTotalShort
    ?0
    :Math.max(0,expectedUnitsTotal-loggedUnitsTotal-shortUnitsTotal);
  const confirmedShortUnitsTotal=Math.min(shortUnitsTotal,parcelReconciliation.reduce((s,p)=>s+p.confirmed_short_qty,0));
  const unverifiedShortUnitsTotal=shortUnitsTotal-confirmedShortUnitsTotal;
  const reconciliationStatus=checkedInParcels.length===0
    ?"awaiting_arrival"
    :confirmedShortUnitsTotal>0
      ?"confirmed_shortage"
      :(unverifiedShortUnitsTotal>0 || extraUnitsTotal>0 || damagedUnitsTotal>0 || mismatchUnitsTotal>0)
        ?"discrepancy_under_review"
        :unidentifiedUnitsTotal>0||allExpectedParcelsCheckedIn&&!allExpectedParcelsCounted
          ?"received_pending_identification"
          :!allExpectedParcelsCheckedIn||unarrivedUnitsTotal>0
            ?"awaiting_arrival"
            :"matched";
  const hasIntakeDiscrepancy=checkedInParcels.length>0 && (
    shortUnitsTotal>0
    || extraUnitsTotal>0
    || parcelReconciliation.some(pr=>["crushed","torn","wet"].includes(String(pr.outer_condition??"")))
    || damagedUnitsTotal>0
    || mismatchUnitsTotal>0
  );

  return {
    lines_breakdown:breakdown,
    expected_lines_count:breakdown.length,
    expected_units_total:expectedUnitsTotal,
    arrived_units_total:arrivedUnitsTotal,
    logged_units_total:loggedUnitsTotal,
    identified_units_total:identifiedUnitsTotal,
    unidentified_units_total:unidentifiedUnitsTotal,
    unarrived_units_total:unarrivedUnitsTotal,
    short_units_total:shortUnitsTotal,
    unverified_short_units_total:unverifiedShortUnitsTotal,
    confirmed_short_units_total:confirmedShortUnitsTotal,
    reconciliation_status:reconciliationStatus,
    extra_units_total:extraUnitsTotal,
    damaged_units_total:damagedUnitsTotal,
    mismatch_units_total:mismatchUnitsTotal,
    checked_in_parcels_count:checkedInParcels.length,
    all_expected_parcels_checked_in:allExpectedParcelsCheckedIn,
    any_contents_unknown:anyContentsUnknown,
    has_intake_discrepancy:hasIntakeDiscrepancy,
    parcel_reconciliation:parcelReconciliation,
    inspected_units_total:inspectedUnitsTotal,
    outstanding_units_total:Math.max(0,expectedUnitsTotal-identifiedUnitsTotal),
    suppliers:[...supplierSet],
    declared_waybills:[...waybillSet],
    purchase_evidences:purchaseEvidences,
    planned_parcels:plannedParcels,
  };
}

export async function orderDetail(db:DB,actor:Actor,id:string) {
  const order=await ownOrder(db,actor,id);
  const lines=(await db.query(`select l.id,l.offer_id,l.category_id,l.template_version_id,l.quantity,l.options,l.attributes,l.draft_items,
    so.title,so.sku_code,st.code service
    from order_lines l join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    where l.order_id=$1 order by l.id`,[id])).rows;
  const rows=(await db.query(`select e.id,e.position,e.declared_fields,e.in_scope,l.id as order_line_id,l.quantity,so.title,st.code service,
    w.id item_id,w.code,w.identity_state,w.condition_state,w.custody_state,w.storage_until,pkg.code package_code,
    ${itemInspectionStageSql} inspection_stage,
    ${customerItemHandlingHoldSql} handling_hold,
    (select max(p.ends_at) from storage_periods p where p.item_id=w.id) paid_storage_until,
    (select jsonb_build_object('id',d.id,'action',d.action,'state',d.state,
      'awaiting_batch',d.action<>'retain' and not exists(select 1 from dispatch_batch_items bi where bi.disposition_id=d.id and bi.released_at is null))
      from disposition_requests d where d.item_id=w.id and d.org_id=w.org_id and d.state not in ('completed','cancelled')) instruction
    from order_lines l join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    left join expected_items e on e.order_line_id=l.id and e.in_scope
    left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
    left join warehouse_items w on w.id=a.item_id
    left join packages pkg on pkg.id=w.package_id
    where l.order_id=$1 order by l.id,e.position`,[id])).rows;
  const progress=await one(db,`select r.published_version,${scopeSupplementForOrder} scope_payment,
    inbound_registration.parcel_registration_due,inbound_registration.unregistered_waybills
    from orders o left join reports r on r.order_id=o.id ${orderInboundRegistration}
    where o.id=$1 and o.org_id=$2`,[id,order.org_id]);
  const manualQuoteRenewable=await canRenewManualInspection(db,id,order.state);
  const manual=(order.state==="draft"||manualQuoteRenewable)?(await db.query(`
    select case when r.state='offered' and q.id is null then 'expired' else r.state end state,
      q.id,q.order_id,q.revision,q.amount_cents,q.expires_at,q.line_snapshot
    from manual_quote_requests r left join inspection_quotes q on q.id=r.accepted_quote_id
      and q.expires_at>now() and q.accepted_at is null
    where r.order_id=$1 and r.revision=$2`,[id,order.revision])).rows[0]:null;
  const parcels=(await db.query(`select ao.advice_id id,t.tracking_norm,t.carrier_code,c.labels->>'en' carrier_name,
    t.transport_state,t.sync_state,p.id package_id,p.code package_code,p.state warehouse_state,p.received_quantity,
    p.received_at,
    substring(p.condition_note from '^\\[outer:(intact|crushed|torn|wet)\\]') outer_condition,
    attributed.logged logged_item_count,attributed.identified identified_item_count,
    attributed.damaged damaged_item_count,attributed.item_codes,${inboundParcelOrders}>1 shared_parcel,
    ${inboundShortageConfirmed} shortage_confirmed
    from advice_orders ao join tracking_records t on t.advice_id=ao.advice_id and t.org_id=ao.org_id and t.closed_at is null
    left join packages p on p.id=t.package_id and p.org_id=ao.org_id
    ${orderAttributedParcelItems}
    left join carriers c on c.code=t.carrier_code
    where ao.order_id=$1 and ao.org_id=$2 order by t.tracking_norm`,[id,order.org_id])).rows;
  const cases=(await db.query(`select id,public_no,subject,state from tickets
    where order_id=$1 and org_id=$2 order by created_at desc limit 50`,[id,order.org_id])).rows;
  const lateSampleRegistration=(await db.query(`select 1 from scope_revisions where order_id=$1 and accepted_at is not null
    and proposed_snapshot->>'conversion'='three_to_two' limit 1`,[id])).rowCount===1;
  const discrepancyResolutionRecord=(await db.query(`select id,public_no,state,details->>'discrepancy_resolution' discrepancy_resolution,created_at
    from tickets where order_id=$1 and org_id=$2 and category in ('receipt_mismatch','damage_or_loss') and details ? 'discrepancy_resolution'
    order by created_at desc limit 1`,[id,order.org_id])).rows[0]??null;
  const consents=(await db.query(`select c.id,c.created_at,c.acknowledgements,
    jsonb_agg(jsonb_build_object('kind',t.kind,'version',t.version) order by t.kind) policies
    from consents c join terms_versions t on t.id=any(c.terms_version_ids)
    where c.order_id=$1 group by c.id order by c.created_at desc,c.id`,[id])).rows;
  const shipments=await orderShipments(db,id,order.org_id);
  const quotes=(await orderQuotes(db,id,order.org_id)).map(({id,revision,purpose,action,state,amount_cents,expires_at,batch_id,item_codes})=>
    ({id,revision,purpose,action,state,amount_cents,expires_at,batch_id:batch_id??null,item_codes:item_codes??null}));
  const tasks=(await db.query(`select t.id,t.state,tv.template_key,w.code item_code,
    so.title->>'en' service_title,st.code service,
    e.declared_fields->>'name' product_name,e.declared_fields->>'sku_code' sku_code,
    e.declared_fields->>'color_declared' color_declared,e.declared_fields->>'size_label' size_label
    from inspection_tasks t join order_lines l on l.id=t.order_line_id
    join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    join template_versions tv on tv.id=t.template_version_id
    left join order_line_item_links a on a.id=t.assignment_id
    left join expected_items e on e.id=a.expected_item_id
    left join warehouse_items w on w.id=a.item_id
    where l.order_id=$1 and t.state<>'VOID'
    order by l.id,w.code nulls last,t.id`,[id])).rows;
  const tasks_summary={
    total:tasks.length,
    ready:tasks.filter(t=>t.state==="READY").length,
    in_progress:tasks.filter(t=>t.state==="IN_PROGRESS").length,
    submitted:tasks.filter(t=>t.state==="SUBMITTED").length,
    completed:tasks.filter(t=>["QA_APPROVED","COMPLETED"].includes(t.state)).length,
    returned:tasks.filter(t=>order.state==="inspecting"&&t.state==="IN_PROGRESS").length,
  };
  const expected_lines_summary={...summarizeExpectedLines(lines,rows,parcels),discrepancy_resolution_record:discrepancyResolutionRecord};
  return {...orderDTO(order as Parameters<typeof orderDTO>[0]),price_cents:order.price_cents,
    late_sample_registration:lateSampleRegistration,
    customer_notes:order.customer_notes??null,held_at:order.held_at??null,held_from_state:order.held_from_state??null,hold_reason:order.hold_reason??null,
    created_at:order.created_at,report_published_at:order.report_published_at??null,closed_at:order.closed_at??null,paid_at:order.paid_at??null,samples_ready_at:order.samples_ready_at??null,sla_due_at:order.sla_due_at??null,
    lines,items:rows,expected_lines_summary,tasks_summary,tasks,report_version:progress.published_version??null,scope_payment:progress.scope_payment,manual_quote:manual??null,manual_quote_renewable:manualQuoteRenewable,
    parcel_registration_due:progress.parcel_registration_due,unregistered_waybills:progress.unregistered_waybills,
    parcels,cases,shipments,quotes,consents};
}
