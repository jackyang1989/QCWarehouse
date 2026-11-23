import type { DB } from "../db";
import { z } from "zod";
import { extractReceivingCode, guard, hash, one, organization, paymentAwaitingResolution, paymentGrossCents, resolveSampleCode, role, unresolvedQuotePayment, type Actor } from "./common";
import { receiving } from "./auth";
import { customerEmailDeliveryStatus } from "./email";
import { eligibleManualQuoteOrderSql, expiredManualInspectionPaymentSql, orderAcceptsSampleAssignmentSql, orderDTO, referenceCategorySql, summarizeExpectedLines } from "./orders";
import { declaredItemTracking, inboundParcelOrders, orderAttributedParcelItems, orderInboundRegistration, orderShipments } from "./fulfillment-reads";
import { getIntakeContext, pendingIntakeClaimSql, waybill } from "./intake";
import { scopeSupplementForOrder, scopeSupplementState } from "./scope-payment";
import { customerItemHandlingHoldSql, incidentAwaitingCustomer, itemHandlingHoldSql, itemQuarantineSql } from "./storage";
import { hasStaffAccess, staffAccess } from "./staff-access";
import { effectiveDispatchCharge, pendingDispatchQuote, pendingStorageQuote, renewableFulfillmentQuote } from "./dispatch";
import { inspectionPaymentForOrder, isProviderDisputeClosed } from "./payments";
import { quotePolicy } from "./quote-policy";
import { itemInspectionStageSql } from "./inspection-stage";
import { orderOperationNotes } from "./order-operation-notes";
import { effectiveLaunchMode } from "./operations";

const inventoryJoins=`from warehouse_items w
    left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
    left join order_lines l on l.id=a.order_line_id left join orders o on o.id=l.order_id and o.org_id=w.org_id`;
const awaitingItemInstructions=`(o.id is null or o.state in ('report_ready','action_pending','cancelled','closed'))
    and not (o.id is null and w.identity_state='pending' and exists(
      select 1 from packages pkg join advice_orders ao on ao.advice_id=pkg.advice_id
      join orders o2 on o2.id=ao.order_id and o2.org_id=w.org_id
      where pkg.id=w.package_id and o2.paid_at is not null
        and o2.state in ('awaiting_samples','samples_ready','queued','inspecting','qa_review','on_hold')
    ))
    and w.custody_state in ('received','stored') and (${customerItemHandlingHoldSql}) is null
    and not exists(select 1 from disposition_requests d where d.item_id=w.id and d.state not in ('completed','cancelled'))
    and not exists(select 1 from reference_samples r where r.item_id=w.id
      and (r.state='pending_safe_storage' or (r.state='active' and r.expires_at>now())))`;
const activeReference=`exists(select 1 from reference_samples r where r.item_id=w.id and r.org_id=w.org_id
    and r.state='active' and r.expires_at>now())`;
const inspectedItem=`${itemInspectionStageSql}='inspected'`;
const awaitingOrInInspection=`w.identity_state='identified' and o.state in ('awaiting_samples','samples_ready','queued','inspecting','qa_review') and coalesce(${itemInspectionStageSql},'pending')<>'inspected'`;
const itemFilters={all:"true",in_warehouse:"w.custody_state in ('received','stored')",inspection:awaitingOrInInspection,inspected:inspectedItem,handling:awaitingItemInstructions,reference:activeReference};
const referenceLocationCode=`case when r.state='active' and sl.zone='reference' then sl.code
  else r.authorization_snapshot->>'safe_location_code' end`;
export async function items(db:DB,actor:Actor,options?:{page:number;filter:keyof typeof itemFilters;code?:string}) {
  return (await db.query(`select w.id item_id,w.code,w.custody_state,w.revision,w.identity_state,w.condition_state,w.storage_until,w.received_at,
    ${customerItemHandlingHoldSql} handling_hold,${itemInspectionStageSql} inspection_stage,
    p.code package_code,p.advice_id inbound_advice_id,
    (select t.tracking_norm from tracking_records t where t.package_id=p.id and t.direction='inbound' and t.closed_at is null order by t.generation desc limit 1) inbound_tracking_norm,
    (select max(sp.ends_at) from storage_periods sp where sp.item_id=w.id) paid_storage_until,
    a.order_line_id,e.declared_fields,o.id order_id,o.public_no order_no,o.state order_state,sl.code location_code,
    coalesce(
      case when exists(select 1 from reports r where r.order_id=o.id and r.published_version is not null)
        then (select m.id from media_assets m where m.item_id=w.id and m.kind='shot' and m.status='ready' and (m.result_id is not null or m.shot_code is not null or m.point_code is not null) order by m.captured_at asc nulls last,m.id asc limit 1) end,
      (select m.id from media_assets m where m.package_id=w.package_id and m.org_id=w.org_id and m.kind='intake_open' and m.status='ready' order by m.captured_at desc nulls last,m.id desc limit 1)
    ) thumbnail_media_id,
    coalesce(nullif(e.declared_fields->>'sku_code',''),nullif(e.declared_fields->>'sample_code',''),'') sku_code,
    coalesce(nullif(e.declared_fields->>'supplier_alias',''),nullif(l.attributes->>'supplier_alias',''),'') supplier_alias,
    coalesce(nullif(e.declared_fields->>'name',''),'') product_name,
    (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'custody_state',c.custody_state) order by c.code),'[]'::jsonb)
     from warehouse_items c where c.parent_item_id=w.id) components,
    (select jsonb_build_object(
      'reference_id',r.id,'state',r.state,'revision',r.revision,'expires_at',r.expires_at,
      'seal_code',r.authorization_snapshot->>'seal_code',
      'safe_location_code',${referenceLocationCode},
      'expired',r.expires_at<=now(),
      'in_use',exists(select 1 from reference_reservations rr where rr.reference_id=r.id and rr.released_at is null)
    ) from reference_samples r where r.item_id=w.id order by r.revision desc limit 1) reference_sample,
    (select jsonb_build_object('id',d.id,'action',d.action,'state',d.state,'destination',d.destination,'return_info',d.return_info)
     from disposition_requests d where d.item_id=w.id and d.state not in ('completed','cancelled') order by d.revision desc limit 1) active_disposition,
    (select bi.batch_id from dispatch_batch_items bi where bi.item_id=w.id and bi.released_at is null limit 1) active_batch_id,
    (select jsonb_build_object('id',s.id,'batch_id',s.batch_id,'tracking_norm',s.tracking_norm,'carrier_code',s.carrier_code,'state',s.state,'shipped_at',s.shipped_at)
     from shipment_items si join shipments s on s.id=si.shipment_id where si.item_id=w.id order by s.shipped_at desc nulls last,s.id desc limit 1) outbound_shipment,
    array(select d.id from disposition_requests d where d.item_id=w.id and d.state='requested'
      and d.action in ('to_forwarder','to_domestic_address','return_to_seller')
      and not exists(select 1 from dispatch_batch_items bi where bi.disposition_id=d.id and bi.released_at is null)) instructions,
    coalesce((select array_agg(o2.public_no order by o2.public_no) from advice_orders ao join orders o2 on o2.id=ao.order_id and o2.org_id=w.org_id
      where ao.advice_id=p.advice_id and o2.paid_at is not null and o2.state in ('awaiting_samples','samples_ready','queued','inspecting','qa_review','on_hold')),array[]::text[]) pending_order_numbers
    ${inventoryJoins} join packages p on p.id=w.package_id
    left join expected_items e on e.id=a.expected_item_id
    left join storage_locations sl on sl.id=w.location_id
    where w.org_id=$1 and w.parent_item_id is null and ($2::text is null or replace(upper(w.code),'-','')=replace(upper($2),'-',''))
      and (${itemFilters[options?.filter??"all"]})
    order by w.received_at desc,w.id desc limit $3 offset $4`,[
      organization(actor),options?.code??null,options?21:400,options?(options.page-1)*20:0,
    ])).rows.map(w=>({
      ...w,allowed_actions:["stored","received"].includes(w.custody_state)&&!w.handling_hold&&!( !w.order_id && w.identity_state==="pending" && Array.isArray(w.pending_order_numbers) && w.pending_order_numbers.length>0 )?["request_disposition"]:[],
    }));
}
export async function customerInventory(db:DB,actor:Actor,page:number,filter:keyof typeof itemFilters,code?:string) {
  const org=organization(actor);
  const rows=(await items(db,actor,{page:code?1:page,filter:code?"all":filter,code})).map(({location_code,reference_sample,...row})=>{
    if(!reference_sample) return {...row,reference_sample:null};
    const {safe_location_code,...reference}=reference_sample;
    return {...row,reference_sample:reference};
  });
  if(code) {
    guard(rows[0],"NOT_FOUND","Item not found.",404);
    return {rows,has_more:false};
  }
  const summary=await one(db,`select count(*)::int total,
    count(*) filter (where ${awaitingOrInInspection})::int inspection,
    count(*) filter (where ${awaitingItemInstructions})::int handling,
    count(*) filter (where ${inspectedItem})::int inspected,
    count(*) filter (where ${activeReference})::int reference
    ${inventoryJoins} where w.org_id=$1 and w.parent_item_id is null`,[org]);
  const custody_summary=await one(db,`select
    count(*) filter (where w.custody_state in ('received','stored'))::int in_warehouse,
    count(*) filter (where w.custody_state not in ('received','stored'))::int shipped_or_closed,
    count(*) filter (where w.custody_state in ('received','stored') and w.identity_state='pending')::int pending_identification
    from warehouse_items w where w.org_id=$1 and w.parent_item_id is null`,[org]);
  const awaiting_arrival_orders=(await db.query(`select o.id,o.public_no,o.state,
    inbound_registration.parcel_registration_due,
    (select count(*)::int from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope where l.order_id=o.id) expected_units,
    (select count(*)::int from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
      join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null where l.order_id=o.id) identified_units,
    (select count(distinct wi.id)::int from warehouse_items wi
      left join order_line_item_links a on a.item_id=wi.id and a.unlinked_at is null
      left join order_lines l on l.id=a.order_line_id
      join packages p on p.id=wi.package_id
      left join advice_orders ao on ao.advice_id=p.advice_id and ao.order_id=o.id
      where wi.org_id=o.org_id and wi.parent_item_id is null
        and (l.order_id=o.id or (a.id is null and ao.order_id=o.id and (select count(*) from advice_orders ao2 where ao2.advice_id=p.advice_id)=1))) physically_received_units,
    greatest(
      (select count(*)::int from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
        join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null where l.order_id=o.id),
      (select count(distinct wi.id)::int from warehouse_items wi
        left join order_line_item_links a on a.item_id=wi.id and a.unlinked_at is null
        left join order_lines l on l.id=a.order_line_id
        join packages p on p.id=wi.package_id
        left join advice_orders ao on ao.advice_id=p.advice_id and ao.order_id=o.id
        where wi.org_id=o.org_id and wi.parent_item_id is null
          and (l.order_id=o.id or (a.id is null and ao.order_id=o.id and (select count(*) from advice_orders ao2 where ao2.advice_id=p.advice_id)=1)))
    )::int arrived_units
    from orders o ${orderInboundRegistration}
    where o.org_id=$1 and o.paid_at is not null and o.state in ('awaiting_samples','on_hold')
    order by o.created_at desc limit 20`,[org])).rows;
  return {rows:rows.slice(0,20),has_more:rows.length>20,summary,custody_summary,awaiting_arrival_orders};
}
const chargeOrderOriginsSql=`left join lateral(
    select array_agg(related.id order by related.public_no) order_ids,
      array_agg(related.public_no order by related.public_no) order_numbers
    from (
      select o.id,o.public_no from orders o where o.id=i.order_id and o.org_id=c.org_id
      union
      select o.id,o.public_no from charge_allocations a join orders o on o.id=a.order_id and o.org_id=c.org_id
        where a.charge_id=c.id
      union
      select o.id,o.public_no from disposition_requests dr
        join order_line_item_links a on a.item_id=dr.item_id and a.org_id=dr.org_id
          and a.linked_at<=s.accepted_at and (a.unlinked_at is null or a.unlinked_at>s.accepted_at)
        join order_lines l on l.id=a.order_line_id and l.org_id=a.org_id
        join orders o on o.id=l.order_id and o.org_id=l.org_id
        where dr.id=s.disposition_id and dr.org_id=c.org_id
    ) related
  ) linked on true`;

const billingPageSize=20;

export async function bills(db:DB,actor:Actor,focusedCharge:string|null=null,page?:number) {
  const org=organization(actor);
  return (await db.query(`select c.id charge_item_id,c.purpose,c.amount_cents,c.currency,
    case when c.voided_at is not null then 'void' when c.applied_payment_id is not null or c.free_authorization is not null then 'paid'
      when exists(select 1 from payments p where p.charge_item_id=c.id and ${paymentAwaitingResolution}) then 'processing' else 'open' end state,
    coalesce((select sum(r.amount_cents)::int from refunds r join payments p on p.id=r.payment_id where p.charge_item_id=c.id and r.state='succeeded'),0) refunded_cents,
    (select coalesce(sum(${paymentGrossCents}),0)::int from payments p where p.charge_item_id=c.id
      and p.state in ('succeeded','partially_refunded','refunded')) gross_paid_cents,
    coalesce((select sum(r.amount_cents)::int from refunds r join payments p on p.id=r.payment_id where p.charge_item_id=c.id and r.state in ('requested','approved')),0) pending_refund_cents,
    coalesce(linked.order_ids,array[]::uuid[]) order_ids,coalesce(linked.order_numbers,array[]::text[]) order_numbers,
    d.batch_id,c.scope_revision_id,
    case when inspection_payment.id=c.id then inspection_payment.state end inspection_payment_state,
    case when inspection_payment.id=c.id then o.public_no end inspection_order_number,
    (select w.code from disposition_requests dr join warehouse_items w on w.id=dr.item_id and w.org_id=dr.org_id
      where dr.id=s.disposition_id and dr.org_id=c.org_id) storage_item_code,
    ${unresolvedQuotePayment} unresolved_payment,
    (select p.state from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_attempt_state,
    (select p.id from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_payment_id,
    (select p.provider from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_attempt_provider,
    (select p.manual_state from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_manual_state,
    (select p.external_invoice_no from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_external_invoice_no,
    (select p.invoice_url from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_invoice_url,
    (select p.payer_email from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_payer_email,
    (select p.provider_data->>'customer_reported_paid_at' from payments p where p.charge_item_id=c.id order by p.updated_at desc nulls last,p.id desc limit 1) latest_customer_reported_at,
    paid.provider_ref paid_ref,
    coalesce(paid.provider='stripe' and paid.state in ('succeeded','partially_refunded','refunded')
      and paid.provider_ref ~ '^cs_(live|test)_' and left(paid.provider_data->>'payment_intent',3)='pi_',false) receipt_available,
    confirmation.paid_at,
    coalesce(confirmation.paid_at,i.accepted_at,d.accepted_at,s.accepted_at) posted_at,
    coalesce(i.expires_at,d.expires_at,s.expires_at) expires_at,
    case when c.free_authorization is not null then 'FREE-AUTH' else null end receipt_summary,
    coalesce(i.revision,d.revision,s.revision) quote_revision
    from charge_items c left join inspection_quotes i on i.id=c.inspection_quote_id left join dispatch_quote_versions d on d.id=c.dispatch_quote_id
    left join storage_quotes s on s.id=c.storage_quote_id
    left join orders o on o.id=i.order_id and o.org_id=c.org_id and c.purpose='inspection' and c.scope_revision_id is null
    ${inspectionPaymentForOrder}
    left join payments paid on paid.id=c.applied_payment_id and paid.charge_item_id=c.id
    left join lateral(select min(a.at) paid_at from audit_events a
      where a.entity_type='charge_items' and a.entity_id=c.id and a.action='payment_confirmed') confirmation on true
    ${chargeOrderOriginsSql}
    where c.org_id=$1 order by (c.id=$2::uuid) desc nulls last,posted_at desc nulls last,c.id desc limit $3 offset $4`,
  [org,focusedCharge,page?billingPageSize+1:200,page?(page-1)*billingPageSize:0])).rows;
}
const currentOfferedManualQuote=`from manual_quote_requests m join orders o on o.id=m.order_id and o.revision=m.revision
    join inspection_quotes q on q.id=m.accepted_quote_id and q.order_id=o.id
    where o.org_id=$1 and ${eligibleManualQuoteOrderSql} and m.state='offered' and q.accepted_at is null and q.expires_at>now()`;

export async function customerActions(db:DB,actor:Actor,page?:number) {
  const org=organization(actor);
  const {rows}=await db.query(`select * from (
    select o.id,'order' kind,o.state,o.public_no reference,null::timestamptz due_at,
      case when inbound_registration.parcel_registration_due then 3 else 3 end urgency_rank,
      o.public_no order_public_no,
      (select so.title->>'en' from order_lines l join service_offers so on so.id=l.offer_id where l.order_id=o.id order by l.id limit 1) summary,
      case
        when o.state='draft' then 'Complete service setup and submit order for inspection quote.'
        when inbound_registration.parcel_registration_due then 'Add seller waybills so warehouse can match incoming parcels.'
        else 'Select retention, forwarder dispatch, or seller return for inspected items.'
      end impact,
      o.price_cents amount_cents,coalesce(o.currency,'USD') currency,
      null::int expected_units,null::int received_units,null::int discrepancy_units,
      null::int short_units,null::int extra_units,null::int unidentified_units,null::text parcel_code,null::text outer_condition
    from orders o ${orderInboundRegistration} where o.org_id=$1 and (
      (o.state='draft' and not exists(select 1 from manual_quote_requests m where m.order_id=o.id
        and m.revision=o.revision and m.state in ('requested','offered'))) or
      inbound_registration.parcel_registration_due or
      (o.state in ('report_ready','action_pending') and exists(
        select 1 from order_lines l join order_line_item_links a on a.order_line_id=l.id and a.unlinked_at is null
        join warehouse_items w on w.id=a.item_id and w.org_id=o.org_id
        where l.order_id=o.id and w.custody_state in ('received','stored') and w.parent_item_id is null
        and (${customerItemHandlingHoldSql}) is null
        and not exists(select 1 from disposition_requests d where d.item_id=w.id and d.state<>'cancelled' and d.state<>'completed')
        and not exists(select 1 from reference_samples r where r.item_id=w.id and (r.state='pending_safe_storage' or (r.state='active' and r.expires_at>now())))))
    )
    union all select o.id,'order',case inspection_payment.state when 'open' then 'awaiting_payment'
      when 'reconciliation' then 'inspection_payment_reconciliation' else 'inspection_quote_expired' end,
      o.public_no,case when inspection_payment.state='open' then inspection_payment.expires_at end,
      case when inspection_payment.state='open' and inspection_payment.expires_at<=now()+interval '48 hours' then 1 else 1 end,
      o.public_no,
      coalesce((select so.title->>'en' from order_lines l join service_offers so on so.id=l.offer_id where l.order_id=o.id order by l.id limit 1),'Inspection payment'),
      case inspection_payment.state when 'open' then 'Warehouse cannot start intake or inspection until paid.' when 'reconciliation' then 'Payment recorded; reconciling gateway webhook.' else 'Quote expired; refresh quote to proceed.' end,
      coalesce(inspection_payment.amount_cents,o.price_cents),coalesce(o.currency,'USD'),
      null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from orders o ${inspectionPaymentForOrder}
      where o.org_id=$1 and o.state='awaiting_payment'
      and (inspection_payment.state='open' or (inspection_payment.state in ('expired','reconciliation')
        and not (${expiredManualInspectionPaymentSql})))
    union all select q.id,'inspection_quote','manual_quote_ready',o.public_no,q.expires_at,
      1,o.public_no,'Custom manual quote ready','Accept and pay custom quote before expiry to activate order.',q.amount_cents,coalesce(q.currency,'USD'),null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      ${currentOfferedManualQuote}
    union all select o.id,'inspection_quote','manual_quote_expired',o.public_no,null,
      2,o.public_no,'Custom inspection quote expired','Request quote renewal so order can proceed.',coalesce(q.amount_cents,o.price_cents),coalesce(q.currency,o.currency,'USD'),null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from orders o left join manual_quote_requests m on m.order_id=o.id and m.revision=o.revision
      left join inspection_quotes q on q.id=m.accepted_quote_id and q.order_id=o.id
      where o.org_id=$1 and ((${eligibleManualQuoteOrderSql} and m.state='offered' and q.expires_at<=now())
        or ((${expiredManualInspectionPaymentSql}) and m.id is null))
    union all select q.id,'quote',b.action,
      coalesce((select string_agg(distinct o2.public_no,', ' order by o2.public_no) from dispatch_batch_items bi join order_line_item_links a2 on a2.item_id=bi.item_id and a2.unlinked_at is null join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id where bi.batch_id=b.id),'DSP-'||upper(substr(replace(b.id::text,'-',''),1,8))),
      q.expires_at,
      1,
      (select o2.public_no from dispatch_batch_items bi join order_line_item_links a2 on a2.item_id=bi.item_id and a2.unlinked_at is null join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id where bi.batch_id=b.id order by o2.public_no limit 1),
      case b.action when 'return_to_seller' then 'Return to seller shipping quote' when 'to_forwarder' then 'Forwarder shipping quote' when 'to_domestic_address' then 'Domestic shipping quote' else 'Shipping quote' end,
      'Approve shipping quote and pay before expiry to release dispatch batch.',
      q.amount_cents,'USD',null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from dispatch_quote_versions q
      join dispatch_batches b on b.id=q.batch_id where b.org_id=$1 and ${pendingDispatchQuote}
    union all select q.id,'quote','retain',w.code,q.expires_at,
      1,
      (select o2.public_no from order_line_item_links a2 join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id where a2.item_id=w.id and a2.unlinked_at is null limit 1),
      'Extended storage quote ('||w.code||')','Approve storage extension quote before expiry to avoid overdue charges.',q.amount_cents,'USD',null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from storage_quotes q
      join disposition_requests d on d.id=q.disposition_id join warehouse_items w on w.id=d.item_id and w.org_id=d.org_id
      where d.org_id=$1 and ${pendingStorageQuote}
    union all select c.id,'charge',c.purpose,
      coalesce((select string_agg(distinct o2.public_no,', ' order by o2.public_no) from charge_allocations ca join orders o2 on o2.id=ca.order_id where ca.charge_id=c.id),
        case when c.dispatch_quote_id is not null then 'DSP-'||upper(substr(replace((select dq.batch_id::text from dispatch_quote_versions dq where dq.id=c.dispatch_quote_id),'-',''),1,8))
        else 'CHG-'||upper(substr(replace(c.id::text,'-',''),1,8)) end),
      coalesce(q.expires_at,s.expires_at),
      1,
      (select o2.public_no from charge_allocations ca join orders o2 on o2.id=ca.order_id where ca.charge_id=c.id order by o2.public_no limit 1),
      case c.purpose when 'dispatch' then 'Shipping charge payment due' when 'storage' then 'Extended storage payment due' else 'Charge payment due' end,
      'Complete payment so warehouse can proceed with packing or storage extension.',
      c.amount_cents,c.currency,null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from charge_items c
      left join dispatch_quote_versions q on q.id=c.dispatch_quote_id left join storage_quotes s on s.id=c.storage_quote_id
      where c.org_id=$1 and c.purpose in ('dispatch','storage')
      and c.voided_at is null and c.applied_payment_id is null and c.free_authorization is null
      and coalesce(q.expires_at,s.expires_at)>now()
      and not exists(select 1 from payments p where p.charge_item_id=c.id and p.state='processing')
    union all select t.advice_id,'parcel',t.sync_state,t.tracking_norm,null,
      2,
      (select o2.public_no from advice_orders ao2 join orders o2 on o2.id=ao2.order_id where ao2.advice_id=t.advice_id order by o2.public_no limit 1),
      'Carrier or label phone verification needed',
      'Provide carrier or shipping label phone digits so live tracking can sync.',
      null::int,null::text,null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from tracking_records t
      where t.org_id=$1 and t.direction='inbound' and t.advice_id is not null and t.closed_at is null
      and t.sync_state in ('needs_verification','needs_carrier')
    union all select ao.advice_id,'parcel_discrepancy',
      case when p.condition_note ~ '^\\[outer:(crushed|torn|wet)\\]' and coalesce(logged.cnt,p.received_quantity)=declared.cnt then 'condition_discrepancy' else 'quantity_discrepancy' end,
      o.public_no,null,
      2,
      o.public_no,
      case when p.condition_note ~ '^\\[outer:(crushed|torn|wet)\\]' and coalesce(logged.cnt,p.received_quantity)=declared.cnt
        then 'Damaged outer carton reported at intake ('||p.code||')'
        else 'Warehouse receipt vs declared SKU count discrepancy ('||p.code||')'
      end,
      case when coalesce(logged.cnt,p.received_quantity,0)<declared.cnt
        then 'Review received units ('||coalesce(logged.cnt,p.received_quantity,0)||'/'||declared.cnt||') & choose how to proceed before QC.'
        else 'Confirm outer condition / count variance with warehouse before inspection.'
      end,
      null::int,null::text,declared.cnt,coalesce(logged.cnt,p.received_quantity,0)::int,
      (coalesce(logged.cnt,p.received_quantity,0)-declared.cnt)::int,
      greatest(0,declared.cnt-coalesce(logged.cnt,p.received_quantity,0))::int,
      greatest(0,coalesce(logged.cnt,p.received_quantity,0)-declared.cnt)::int,
      greatest(0,coalesce(logged.cnt,p.received_quantity,0)-coalesce(ident.cnt,0))::int,
      p.code,
      substring(p.condition_note from '^\\[outer:(intact|crushed|torn|wet)\\]')
      from advice_orders ao
      join orders o on o.id=ao.order_id and o.org_id=ao.org_id
      join tracking_records t on t.advice_id=ao.advice_id and t.org_id=ao.org_id and t.closed_at is null and t.direction='inbound'
      join packages p on p.id=t.package_id and p.org_id=ao.org_id
      ${orderAttributedParcelItems}
      cross join lateral (select attributed.logged cnt) logged
      cross join lateral (select attributed.identified cnt) ident
      cross join lateral (select count(*)::int cnt from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
        where l.order_id=o.id and l.org_id=o.org_id
          and (${declaredItemTracking}=t.tracking_norm or (${declaredItemTracking}='' and (select count(*) from advice_orders ao2 where ao2.order_id=o.id and ao2.org_id=o.org_id)=1))
      ) declared
      where o.org_id=$1 and o.state in ('awaiting_samples','samples_ready','queued','on_hold')
        and ((declared.cnt>0 and (logged.cnt>declared.cnt or (${inboundParcelOrders}=1 and logged.cnt>0 and logged.cnt<declared.cnt)))
          or p.condition_note ~ '^\\[outer:(crushed|torn|wet)\\]')
        and not exists(select 1 from tickets k where k.order_id=o.id and k.org_id=o.org_id
          and k.category in ('receipt_mismatch','damage_or_loss') and k.details->>'package_id'=p.id::text)
    union all select k.id,'support',case when incident.decision_required then 'incident_decision' else k.state end,
      k.public_no,case when not incident.decision_required then k.next_action_at end,
      case when incident.decision_required or (k.next_action_at is not null and k.next_action_at<=now()+interval '48 hours') then 1 else 2 end,
      (select o2.public_no from orders o2 where o2.id=k.order_id),k.subject,
      case when incident.decision_required then 'Review warehouse incident resolution and respond.'
        when k.details->>'late_comparison_parcel'='true' then 'Review the late parcel in this order and reply to the warehouse.'
        else 'Support case requires your reply.' end,
      null::int,null::text,null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from tickets k cross join lateral (select exists(select 1 from incident_cases ic
        where ic.ticket_id=k.id and ic.state=$3) decision_required) incident
      where k.org_id=$1 and (k.state='waiting_customer' or incident.decision_required)
    union all select s.id,'scope','scope_review',o.public_no,null,
      2,
      o.public_no,'Order scope revision requires confirmation','Confirm updated inspection scope so warehouse can proceed.',null::int,null::text,null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from scope_revisions s join orders o on o.id=s.order_id
      where o.org_id=$1 and o.state='awaiting_samples' and s.accepted_at is null
      and s.previous_snapshot->>'order_revision'=o.revision::text
    union all select scope_id,'scope',case when payment_state='expired' then 'scope_payment_expired' else 'scope_payment_due' end,
      public_no,case when payment_state='open' then expires_at end,
      1,
      public_no,'Supplemental scope payment due','Settle scope upgrade payment so added units enter inspection.',amount_cents,'USD',null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text from (
        select s.id scope_id,o.public_no,q.amount_cents,q.expires_at,${scopeSupplementState} payment_state
        from scope_revisions s join orders o on o.id=s.order_id
        join charge_items c on c.scope_revision_id=s.id and c.org_id=o.org_id
        join inspection_quotes q on q.id=c.inspection_quote_id and q.order_id=o.id where o.org_id=$1
      ) supplemental where payment_state in ('open','expired')
    union all select e.id,'email',e.delivery_state,'PRIMARY-EMAIL',null,
      2,
      null::text,'Primary notification email delivery issue','Verify or update primary email address to ensure delivery.',null::int,null::text,null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from user_emails e
      where e.user_id=$2 and e.is_primary and e.delivery_state in ('bounced','complained')
    union all select r.id,'reference',
      case when r.expires_at<=now() then 'reference_expired' else 'reference_conflict' end,
      w.code,r.expires_at,
      case when r.expires_at<=now() then 1 else 2 end,
      (select o2.public_no from order_line_item_links a2 join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id where a2.item_id=w.id and a2.unlinked_at is null limit 1),
      'Golden sample archive attention ('||w.code||')','Renew, extend, or release sealed reference sample.',null::int,null::text,null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from reference_samples r join warehouse_items w on w.id=r.item_id
      where r.org_id=$1 and r.state='active' and (
        r.expires_at<=now() or (
          r.authorization_snapshot ? 'outbound_conflict_at'
          and exists(select 1 from reference_reservations rr where rr.reference_id=r.id and rr.released_at is null)
        )
      )
    union all select w.id,'storage',
      case when w.storage_until<=now() then 'storage_expired' else 'storage_expiring' end,
      w.code,w.storage_until,
      case when w.storage_until<=now() then 1 else 3 end,
      (select o2.public_no from order_line_item_links a2 join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id where a2.item_id=w.id and a2.unlinked_at is null limit 1),
      'Sample storage deadline ('||w.code||')','Request dispatch, return, or extended storage before deadline.',null::int,null::text,null::int,null::int,null::int,null::int,null::int,null::int,null::text,null::text
      from warehouse_items w
      where w.org_id=$1 and w.custody_state in ('received','stored') and w.parent_item_id is null
        and (${customerItemHandlingHoldSql}) is null
        and w.storage_until is not null and w.storage_until<=now()+interval '3 days'
        and not exists(select 1 from disposition_requests d where d.item_id=w.id and d.state not in ('cancelled','completed'))
  ) actions order by urgency_rank asc, due_at asc nulls last, kind, reference, id limit $4 offset $5`,
  [org,actor.id,incidentAwaitingCustomer,page?21:200,page?(page-1)*20:0]);
  return page?{rows:rows.slice(0,20),has_more:rows.length>20}:{rows};
}
const customerOrderSelect=`select o.id,o.public_no,o.state,o.revision,o.price_cents,o.created_at,
    greatest(o.updated_at,o.paid_at,o.samples_ready_at,o.report_published_at,o.closed_at,o.held_at,
      (select max(a.at) from audit_events a where a.entity_type='orders' and a.entity_id=o.id)) updated_at,
    o.sla_due_at,${scopeSupplementForOrder} scope_payment,inbound_registration.parcel_registration_due,
    (select coalesce(sum(l.quantity),0)::int from order_lines l where l.order_id=o.id) item_count,
    (select coalesce(sum(case when jsonb_typeof(l.attributes->'expected_lines')='array' and jsonb_array_length(l.attributes->'expected_lines')>0
      then jsonb_array_length(l.attributes->'expected_lines') else 1 end),0)::int from order_lines l where l.order_id=o.id) expected_lines_count,
    (select count(distinct nullif(trim(sup.s),''))::int from (
      select l.attributes->>'supplier_alias' s from order_lines l where l.order_id=o.id
      union all
      select el->>'supplier_alias' s from order_lines l,jsonb_array_elements(coalesce(l.attributes->'expected_lines','[]'::jsonb)) el where l.order_id=o.id
    ) sup) supplier_count,
    (select count(*)::int from advice_orders ao where ao.order_id=o.id and ao.org_id=o.org_id) parcel_count,
    (select count(*)::int from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
      join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null where l.order_id=o.id) identified_item_count,
    (select count(distinct wi.id)::int from warehouse_items wi
      left join order_line_item_links a on a.item_id=wi.id and a.unlinked_at is null
      left join order_lines l on l.id=a.order_line_id
      join packages p on p.id=wi.package_id
      left join advice_orders ao on ao.advice_id=p.advice_id and ao.order_id=o.id
      where wi.org_id=o.org_id and wi.parent_item_id is null
        and (l.order_id=o.id or (a.id is null and ao.order_id=o.id and (select count(*) from advice_orders ao2 where ao2.advice_id=p.advice_id)=1))) physically_received_count,
    greatest(
      (select count(*)::int from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
        join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null where l.order_id=o.id),
      (select count(distinct wi.id)::int from warehouse_items wi
        left join order_line_item_links a on a.item_id=wi.id and a.unlinked_at is null
        left join order_lines l on l.id=a.order_line_id
        join packages p on p.id=wi.package_id
        left join advice_orders ao on ao.advice_id=p.advice_id and ao.order_id=o.id
        where wi.org_id=o.org_id and wi.parent_item_id is null
          and (l.order_id=o.id or (a.id is null and ao.order_id=o.id and (select count(*) from advice_orders ao2 where ao2.advice_id=p.advice_id)=1)))
    )::int arrived_item_count,
    (select count(distinct a.item_id)::int from order_lines l join order_line_item_links a on a.order_line_id=l.id and a.unlinked_at is null
      where l.order_id=o.id and exists(select 1 from inspection_tasks it where it.order_line_id=l.id and it.state in ('SUBMITTED','QA_APPROVED')
        and (it.assignment_id=a.id or exists(select 1 from group_members gm where gm.group_id=it.group_id and gm.assignment_id=a.id)))) inspected_item_count,
    (select s.title->>'en' from order_lines l join service_offers s on s.id=l.offer_id where l.order_id=o.id order by l.id limit 1) service_title,
    (select st.code from order_lines l join service_offers s on s.id=l.offer_id join service_types st on st.id=s.service_type_id where l.order_id=o.id order by l.id limit 1) service_code,
    (select r.published_version from reports r where r.order_id=o.id limit 1) report_version,
    nullif(inspection_payment.state,'not_due') payment_state,
    (exists(select 1 from advice_orders ao join tracking_records tr on tr.advice_id=ao.advice_id and tr.closed_at is null
      join packages p on p.id=tr.package_id where ao.order_id=o.id and (p.condition_note ~ '^\\[outer:(crushed|torn|wet)\\]' or p.state='quarantined'))
      or exists(select 1 from order_blocks b where b.order_id=o.id and b.resolved_at is null and b.reason='quantity_discrepancy')
    ) has_intake_discrepancy
    from orders o ${orderInboundRegistration} ${inspectionPaymentForOrder}`;

export async function listCustomerOrders(db:DB,actor:Actor,query:string,state:string,page:number) {
  const pageSize=20;
  const {rows}=await db.query(customerOrderSelect+` where o.org_id=$1
    and ($2='' or strpos(replace(upper(o.public_no),'-',''),replace(upper($2),'-',''))>0
      or exists(select 1 from advice_orders ao join tracking_records tr on tr.advice_id=ao.advice_id and tr.closed_at is null where ao.order_id=o.id and strpos(upper(tr.tracking_norm),upper($2))>0)
      or exists(select 1 from order_lines l where l.order_id=o.id and (strpos(upper(coalesce(l.attributes::text,'')),upper($2))>0))
      or exists(select 1 from order_lines l join expected_items e on e.order_line_id=l.id where l.order_id=o.id and strpos(upper(coalesce(e.declared_fields::text,'')),upper($2))>0))
    and ($3='' or o.state=$3)
    order by updated_at desc,o.id desc limit $4 offset $5`,[organization(actor),query,state,pageSize+1,(page-1)*pageSize]);
  return {rows:rows.slice(0,pageSize),has_more:rows.length>pageSize};
}

const customerAdviceFields=`a.id,t.tracking_norm,t.carrier_code,t.transport_state,t.sync_state,p.code package_code,p.state warehouse_state,p.received_quantity,
    substring(p.condition_note from '^\\[outer:(intact|crushed|torn|wet)\\]') outer_condition,
    case when p.id is not null then array(select m.id from media_assets m where m.package_id=p.id and m.org_id=a.org_id and m.kind='intake_open' and m.status='ready' order by m.captured_at asc nulls last,m.id asc limit 8) else array[]::uuid[] end open_media_ids,
    (select count(*)::int from warehouse_items wi where wi.package_id=p.id and wi.parent_item_id is null) logged_item_count,
    array(select order_id from advice_orders where advice_id=a.id) order_ids,
    array(select o.public_no from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=a.id order by o.public_no) order_numbers,
    planned.item_count declared_item_count,planned.suppliers declared_suppliers,
    (select coalesce(jsonb_agg(jsonb_build_object(
      'order_no',g.order_no,'sku_code',g.sku_code,'product_name',g.product_name,
      'color_declared',g.color_declared,'size_label',g.size_label,'supplier_alias',g.supplier_alias,'qty',g.qty
    ) order by g.order_no,g.sku_code),'[]'::jsonb)
    from (
      select o.public_no order_no,
        coalesce(nullif(e.declared_fields->>'sku_code',''),nullif(e.declared_fields->>'sample_code',''),'') sku_code,
        coalesce(nullif(e.declared_fields->>'name',''),'') product_name,
        coalesce(nullif(e.declared_fields->>'color_declared',''),nullif(e.declared_fields->>'color',''),'') color_declared,
        coalesce(nullif(e.declared_fields->>'size_label',''),'') size_label,
        coalesce(nullif(e.declared_fields->>'supplier_alias',''),'') supplier_alias,
        count(*)::int qty
      from advice_orders ao
      join orders o on o.id=ao.order_id and o.org_id=ao.org_id
      join order_lines l on l.order_id=o.id and l.org_id=o.org_id
      join expected_items e on e.order_line_id=l.id and e.in_scope
      where ao.advice_id=a.id and ao.org_id=a.org_id
        and (${declaredItemTracking}=t.tracking_norm or (${declaredItemTracking}='' and (select count(*) from advice_orders ao2 where ao2.order_id=o.id and ao2.org_id=o.org_id)=1))
      group by o.public_no,2,3,4,5,6
    ) g) declared_line_breakdown`;
const customerAdviceSource=`
    from package_advices a
    join tracking_records t on t.advice_id=a.id and t.org_id=a.org_id and t.closed_at is null
    left join packages p on p.advice_id=a.id and p.org_id=a.org_id
    left join lateral(select count(*)::int item_count,
      array_agg(distinct nullif(e.declared_fields->>'supplier_alias','')) filter (where nullif(e.declared_fields->>'supplier_alias','') is not null) suppliers
      from advice_orders ao join orders o on o.id=ao.order_id and o.org_id=ao.org_id
      join order_lines l on l.order_id=o.id and l.org_id=o.org_id
      join expected_items e on e.order_line_id=l.id and e.in_scope
      where ao.advice_id=a.id and ao.org_id=a.org_id
        and (${declaredItemTracking}=t.tracking_norm or (${declaredItemTracking}='' and (select count(*) from advice_orders ao2 where ao2.order_id=o.id and ao2.org_id=o.org_id)=1))
        and not exists(select 1 from advice_orders other join tracking_records tr on tr.advice_id=other.advice_id
          and tr.closed_at is null and tr.tracking_norm=t.tracking_norm
          where other.order_id=ao.order_id and other.org_id=ao.org_id and other.advice_id<>a.id)
    ) planned on true where a.org_id=$1`;
const customerShipmentSelect=`select s.id,s.batch_id,s.state,s.tracking_norm,s.carrier_code,s.shipped_at,b.action
    from shipments s join dispatch_batches b on b.id=s.batch_id where b.org_id=$1 and s.shipped_at is not null`;
const attentionCond=`(t.sync_state in ('needs_carrier','needs_verification') or p.state='quarantined' or p.condition_note ~ '^\\[outer:(crushed|torn|wet)\\]' or (p.id is not null and coalesce(planned.item_count,0)>0 and coalesce((select count(*)::int from warehouse_items wi where wi.package_id=p.id and wi.parent_item_id is null),p.received_quantity,0)<>planned.item_count))`;
const parcelFilters={all:"true",incoming:"p.id is null",received:"p.id is not null",
  attention:attentionCond} as const;
export const customerParcelTab=z.enum(["all","incoming","received","attention","outgoing"]);

export async function listCustomerParcels(db:DB,actor:Actor,tab:z.infer<typeof customerParcelTab>,page:number) {
  const size=20;
  const org=organization(actor);
  const query=tab==="outgoing"?customerShipmentSelect+" order by s.shipped_at desc,s.id desc":
    `select ${customerAdviceFields} ${customerAdviceSource} and ${parcelFilters[tab]} order by a.created_at desc nulls last,a.id desc`;
  const {rows}=await db.query(query+" limit $2 offset $3",[org,size+1,(page-1)*size]);
  const adviceCounts=await one<{all:number;incoming:number;received:number;attention:number}>(db,`select
    count(*)::int "all",
    count(*) filter (where ${parcelFilters.incoming})::int incoming,
    count(*) filter (where ${parcelFilters.received})::int received,
    count(*) filter (where ${parcelFilters.attention})::int attention
    ${customerAdviceSource}`,[org]);
  const outgoingCount=await one<{n:number}>(db,`select count(*)::int n from shipments s join dispatch_batches b on b.id=s.batch_id where b.org_id=$1 and s.shipped_at is not null`,[org]);
  return {rows:rows.slice(0,size),page,has_more:rows.length>size,counts:{...adviceCounts,outgoing:outgoingCount.n}};
}

export async function referenceSamples(db:DB,actor:Actor) {
  const org=organization(actor);
  return (await db.query(`select r.id reference_id,r.item_id,r.state,r.expires_at,
    r.authorization_snapshot->>'seal_code' seal_code,${referenceLocationCode} safe_location_code,
    w.code,${referenceCategorySql} category_id,
    exists(select 1 from reference_reservations rr where rr.reference_id=r.id and rr.released_at is null) in_use
    from reference_samples r join warehouse_items w on w.id=r.item_id and w.org_id=r.org_id
    left join storage_locations sl on sl.id=w.location_id
    where r.org_id=$1 order by r.expires_at desc`,[org])).rows;
}

export async function customerDesk(db:DB,actor:Actor,includeItems=true,focusedCharge:string|null=null,includeActivity=true,
  chargePage?:number,refundPage?:number) {
  const org=organization(actor);
  const orders=(await db.query(customerOrderSelect+" where o.org_id=$1 order by updated_at desc,o.id desc limit 200",[org])).rows;
  const advices=(await db.query(`select ${customerAdviceFields},a.address_snapshot,
    count(*) filter (where p.id is null) over()::int awaiting_check_in_count,
    count(*) filter (where p.id is not null) over()::int checked_in_count
    ${customerAdviceSource} order by a.created_at desc nulls last,a.id desc limit 200`,[org])).rows;
  const shipments=(await db.query(customerShipmentSelect+" order by s.shipped_at desc,s.id desc limit 200",[org])).rows;
  const quotes=(await db.query(`select pending.*,count(*) over()::int quote_count from (
    select q.id,q.revision,q.amount_cents,q.expires_at,'dispatch' purpose,q.batch_id,b.action,
    q.snapshot, (select jsonb_object_agg(w.id::text,w.code) from dispatch_batch_items bi join warehouse_items w
      on w.id=bi.item_id and w.org_id=bi.org_id where bi.batch_id=b.id and bi.org_id=b.org_id) item_codes
    from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id where b.org_id=$1 and ${pendingDispatchQuote}
    union all select q.id,q.revision,q.amount_cents,q.expires_at,'storage',null,d.action,q.snapshot,jsonb_build_object(w.id::text,w.code)
    from storage_quotes q join disposition_requests d on d.id=q.disposition_id join warehouse_items w on w.id=d.item_id and w.org_id=d.org_id
    where d.org_id=$1 and ${pendingStorageQuote}
    ) pending order by expires_at,id limit 100`,[org])).rows;
  const batches=(await db.query("select id,state,revision,action from dispatch_batches where org_id=$1 and state='draft' limit 100",[org])).rows;
  const active_batches=(await db.query(`select b.id,b.state,b.revision,b.action,b.destination_snapshot,
    q.id quote_id,q.amount_cents quote_amount_cents,q.expires_at quote_expires_at,
    coalesce((select array_agg(w.code order by w.code) from dispatch_batch_items bi join warehouse_items w on w.id=bi.item_id where bi.batch_id=b.id and bi.released_at is null),array[]::text[]) item_codes,
    coalesce((select array_agg(distinct s.tracking_norm) filter (where s.tracking_norm is not null) from shipments s where s.batch_id=b.id),array[]::text[]) waybills,
    coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'tracking_norm',s.tracking_norm) order by s.shipped_at,s.id)
      from shipments s where s.batch_id=b.id and s.shipped_at is not null and s.tracking_norm is not null),'[]'::jsonb) outbound_shipments
    from dispatch_batches b
    left join lateral(select id,amount_cents,expires_at from dispatch_quote_versions where batch_id=b.id order by revision desc limit 1) q on true
    where b.org_id=$1 order by b.id desc limit 60`,[org])).rows;
  const destRows=(await db.query<{action:string;destination:Record<string,unknown>}>(
    `select action,destination from disposition_requests
     where org_id=$1 and destination is not null and action in ('to_forwarder','to_domestic_address','return_to_seller')
     order by id desc limit 80`,
    [org]
  )).rows;
  const seenDest=new Set<string>();
  const recent_destinations:{action:string;recipient:string;phone:string;address:string;member_code?:string}[]=[];
  for(const row of destRows) {
    const d=row.destination??{};
    const recipient=String(d.recipient??"").trim(),phone=String(d.phone??"").trim(),address=String(d.address??"").trim();
    const member_code=d.member_code?String(d.member_code).trim():undefined;
    if(!recipient || !phone || !address) continue;
    const key=`${row.action}|${recipient.toLowerCase()}|${phone}|${address.toLowerCase()}|${member_code??""}`;
    if(seenDest.has(key)) continue;
    seenDest.add(key);
    recent_destinations.push({action:row.action,recipient,phone,address,...(member_code?{member_code}:{})});
    if(recent_destinations.length>=12) break;
  }
  const reports=(await db.query(`select r.order_id,r.public_no,r.published_version,o.public_no order_no from reports r join orders o on o.id=r.order_id
    where o.org_id=$1 and r.published_version is not null limit 200`,[org])).rows;
  const tickets=(await db.query(`select k.id,k.public_no,k.category,k.subject,k.state,k.created_at,k.next_action_at,k.details->>'decision' decision,o.public_no order_no,
    coalesce((select max(e.created_at) from ticket_events e where e.ticket_id=k.id and e.kind<>'internal_note'),k.created_at) updated_at
    from tickets k left join orders o on o.id=k.order_id and o.org_id=k.org_id where k.org_id=$1 order by k.created_at desc limit 100`,[org])).rows;
  const refunds=(await db.query(`select r.id,r.amount_cents,r.state,r.reason,r.provider_ref,r.source,r.created_at,c.purpose,
    o.public_no order_no,coalesce(linked.order_numbers,array[]::text[]) order_numbers
    from refunds r join payments p on p.id=r.payment_id join charge_items c on c.id=p.charge_item_id
    left join inspection_quotes i on i.id=c.inspection_quote_id left join orders o on o.id=i.order_id and o.org_id=c.org_id
    left join storage_quotes s on s.id=c.storage_quote_id
    ${chargeOrderOriginsSql}
    where c.org_id=$1 order by r.created_at desc,r.id desc limit $2 offset $3`,
  [org,refundPage?billingPageSize+1:100,refundPage?(refundPage-1)*billingPageSize:0])).rows;
  const inspectionQuotes=(await db.query(`select q.id,q.amount_cents,q.currency,q.expires_at,o.public_no order_number
    ${currentOfferedManualQuote}
    order by q.expires_at,q.id`,[org])).rows;
  const notices=includeActivity?(await customerNotifications(db,actor,false,null,5)).rows:[];
  const references=(await db.query(`select r.id reference_id,r.item_id,r.state,r.revision,r.condition_note,r.expires_at,
    r.authorization_snapshot->>'seal_code' seal_code,
    ${referenceLocationCode} safe_location_code,
    r.expires_at<=now() expired,
    exists(select 1 from reference_reservations rr where rr.reference_id=r.id and rr.released_at is null) in_use,
    ${referenceCategorySql} category_id,
    w.code,w.custody_state
    from reference_samples r join warehouse_items w on w.id=r.item_id
    left join storage_locations sl on sl.id=w.location_id
    where r.org_id=$1 order by r.expires_at desc,r.revision desc limit 100`,[org])).rows;
  const counts=await one(db,`select
    (select count(*)::int from orders o where o.org_id=$1 and o.state not in ('draft','closed','cancelled')) active_inspections,
    (select count(*)::int from warehouse_items w where w.org_id=$1 and w.parent_item_id is null
      and w.custody_state in ('received','stored')) in_custody,
    (select count(*)::int ${inventoryJoins} where w.org_id=$1 and w.parent_item_id is null
      and ${awaitingItemInstructions}) awaiting_instructions`,[org]);
  const summary={...counts,awaiting_check_in:advices[0]?.awaiting_check_in_count??0,checked_in:advices[0]?.checked_in_count??0,
    pending_quotes:(quotes[0]?.quote_count??0)+inspectionQuotes.length};
  const profile=await receiving(db,actor.id);
  const addressChange=(await db.query<{at:Date}>(`select e.at from audit_events e join customer_receiving_profiles p on p.user_id=$2
    where e.entity_type='warehouse_addresses' and e.entity_id=$1 and e.action='set_default_address'
      and e.after->>'previous_default_address_id' is not null and e.at>=p.created_at
    order by e.at desc limit 1`,[profile.warehouse_address?.id??null,actor.id])).rows[0];
  const charges=await bills(db,actor,focusedCharge,chargePage);
  return {summary,orders,advices,shipments,quotes,inspectionQuotes,batches,active_batches,recent_destinations,reports,tickets,
    refunds:refundPage?refunds.slice(0,billingPageSize):refunds,notices,references,
    profile,warehouse_address_changed_at:addressChange?.at??null,email_delivery:await customerEmailDeliveryStatus(db,actor),
    items:includeItems?await items(db,actor):[],bills:chargePage?charges.slice(0,billingPageSize):charges,
    ...(chargePage?{has_more_charges:charges.length>billingPageSize}:{}),
    ...(refundPage?{has_more_refunds:refunds.length>billingPageSize}:{})};
}
export const notificationCategory=z.enum(["all","orders","reports","parcels","billing","support"]);
export async function customerNotifications(db:DB,actor:Actor,unread=false,before:string|null=null,pageSize=50,
  category:z.infer<typeof notificationCategory>="all") {
  const org=organization(actor);
  if(before)await one(db,"select id from notifications where id=$1 and user_id=$2",[before,actor.id]);
  const {rows}=await db.query(`with batch as (
    select n.id,n.template,n.read_at,n.created_at,n.order_id,n.payload
    from notifications n where n.user_id=$1 and (not $3::boolean or n.read_at is null)
    and case $6::text
      when 'orders' then n.template like 'order.%'
      when 'reports' then n.template like 'report.%'
      when 'parcels' then n.template like 'package.%' or n.template like 'tracking.%' or n.template like 'shipment.%' or n.template='reference.sealed'
      when 'billing' then n.template like 'payment.%' or n.template like 'refund.%' or n.template like '%.quoted' or n.template='quote.offered'
      when 'support' then n.template like 'ticket.%' or n.template like 'incident.%' or n.template in ('email.delivery_failed','account.registered')
      else true end
    and ($4::uuid is null or (coalesce(n.created_at,'-infinity'),n.id)<(
      select coalesce(prev.created_at,'-infinity'),prev.id from notifications prev where prev.id=$4 and prev.user_id=$1))
    order by n.created_at desc nulls last,n.id desc limit $5
  )
  select n.id,n.template,n.read_at,n.created_at,o.public_no order_number,
    (select v.version from reports r join report_versions v on v.report_id=r.id
      where r.order_id=o.id and v.version::text=n.payload->>'version' and v.state in ('published','superseded')) report_version,
    k.id case_id,k.public_no case_number,s.id shipment_id,a.id advice_id,
    coalesce(s.tracking_norm,parcel_tracking.tracking_norm) parcel_tracking_number,
    (select c.id from charge_items c where c.id::text=n.payload->>'charge_id' and c.org_id=$2) charge_id,
    case n.template
      when 'dispatch.quoted' then (select q.id from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id
        where q.id::text=n.payload->>'quote_id' and b.org_id=$2)
      when 'storage.quoted' then (select q.id from storage_quotes q join disposition_requests d on d.id=q.disposition_id
        where q.id::text=n.payload->>'quote_id' and d.org_id=$2)
    end quote_id,
    (select w.code from warehouse_items w where w.id::text=n.payload->>'item_id' and w.org_id=$2) item_code
  from batch n left join orders o on o.id=n.order_id and o.org_id=$2
  left join tickets k on k.id::text=n.payload->>'ticket_id' and k.org_id=$2
  left join tracking_records tr on tr.id::text=n.payload->>'tracker_id' and tr.org_id=$2
  left join packages p on p.id::text=n.payload->>'package_id' and p.org_id=$2
  left join package_advices a on a.id=coalesce(p.advice_id,tr.advice_id) and a.org_id=$2
  left join lateral(select s.id,s.tracking_norm from shipments s join dispatch_batches b on b.id=s.batch_id
    where b.org_id=$2 and (s.id::text=n.payload->>'shipment_id' or s.id=tr.shipment_id)
    order by (s.id::text=n.payload->>'shipment_id') desc nulls last limit 1) s on true
  left join lateral(select t.tracking_norm from tracking_records t where t.advice_id=a.id and t.org_id=$2
    and t.direction='inbound' and t.closed_at is null order by t.generation desc limit 1) parcel_tracking on true
  order by n.created_at desc nulls last,n.id desc`,[actor.id,org,unread,before,pageSize+1,category]);
  const page=rows.slice(0,pageSize);
  const unread_count=(await one<{n:number}>(db,"select count(*)::int n from notifications where user_id=$1 and read_at is null",[actor.id])).n;
  return {rows:page,unread_count,next_before:rows.length>pageSize?page.at(-1)?.id:null};
}
export async function markNotificationRead(db:DB,actor:Actor,id:string) {
  organization(actor);
  return one(db,`update notifications set read_at=coalesce(read_at,now()) where id=$1 and user_id=$2 returning id,read_at`,[id,actor.id]);
}
export async function markAllNotificationsRead(db:DB,actor:Actor) {
  organization(actor);
  const {rowCount}=await db.query(`update notifications set read_at=now() where user_id=$1 and read_at is null`,[actor.id]);
  return {updated:rowCount??0};
}
export async function warehousePackage(db:DB,actor:Actor,value:string,byCode=false) {
  role(actor,...staffAccess.intake);
  const parcel=await one(db,`select p.id,p.code,p.state,p.revision,p.received_quantity,p.received_at,p.weight_g,
    p.condition_note,p.org_id,sl.code location_code,sl.zone location_zone,
    coalesce(substring(p.condition_note from '^\\[outer:([a-z_]+)\\]'),'intact') outer_condition,
    array(select m.id from media_assets m where m.package_id=p.id and m.kind='intake_outer' and m.status='ready' order by m.captured_at) outer_media_ids,
    array(select m.id from media_assets m where m.package_id=p.id and m.kind='intake_open' and m.status='ready' order by m.captured_at) open_media_ids,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=p.org_id limit 1) receiving_code,
    (select k.public_no from tickets k where k.org_id=p.org_id and k.details->>'package_id'=p.id::text
      and k.details->>'late_comparison_parcel'='true' and not (k.details ? 'warehouse_verified_at')
      and not exists(select 1 from audit_events a where a.entity_type='packages' and a.entity_id=p.id and a.action='quarantine_package') limit 1) late_sample_review,
    t.tracking_norm,t.transport_state,t.sync_state,
    (select s.events_json from tracking_snapshots s where s.tracker_id=t.id and s.locale='zh-CN'
      order by s.latest_event_at desc nulls last,s.fetched_at desc limit 1) tracking_events,
    array(select o.public_no from advice_orders ao join orders o on o.id=ao.order_id
      where ao.advice_id=p.advice_id order by o.public_no) order_numbers
    from packages p
    left join storage_locations sl on sl.id=p.location_id
    left join tracking_records t on t.package_id=p.id and t.direction='inbound' and t.closed_at is null
    where ${byCode?"replace(upper(p.code),'-','')=replace(upper($1),'-','')":"p.id=$1"}`,[value]);
  const items=(await db.query(`select w.id,w.code,w.revision,w.parent_item_id,w.intake_batch_id,w.identity_state,w.condition_state,w.custody_state,
    l.code location,l.zone location_zone,o.public_no order_number,e.position expected_position,e.declared_fields,
    exists(select 1 from reference_samples r where r.item_id=w.id and r.state='active') is_reference_sample,
    ${itemInspectionStageSql} inspection_stage
    from warehouse_items w left join storage_locations l on l.id=w.location_id
    left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
    left join expected_items e on e.id=a.expected_item_id
    left join order_lines ol on ol.id=a.order_line_id
    left join orders o on o.id=ol.order_id
    where w.package_id=$1 order by w.received_at,w.code`,[parcel.id])).rows;
  const history=(await db.query(`
    select ae.id::text id,ae.action,ae.at created_at,u.display_name actor_name,null::text item_code,null::text from_location,null::text to_location
    from audit_events ae left join users u on u.id=ae.actor_id
    where ae.entity_type='packages' and ae.entity_id=$1
    union all
    select se.id::text id,se.action,se.created_at,u.display_name actor_name,wi.code item_code,fl.code from_location,tl.code to_location
    from storage_events se join warehouse_items wi on wi.id=se.item_id left join users u on u.id=se.operator_id
    left join storage_locations fl on fl.id=se.from_location_id left join storage_locations tl on tl.id=se.to_location_id
    where wi.package_id=$1
    order by created_at desc,id desc limit 40`,[parcel.id])).rows;
  const intakeContext=await getIntakeContext(db,actor,{package_id:parcel.id});
  return {parcel:{...parcel,intake_context:intakeContext},items,history,intake_context:intakeContext};
}
export async function warehouseItem(db:DB,actor:Actor,code:string) {
  role(actor,...staffAccess.intake);
  const sample=await resolveSampleCode(db,code);
  guard(sample,"NOT_FOUND","Warehouse item code not found.",404);
  const item=await one(db,`select w.id,w.code,w.org_id,w.revision,w.parent_item_id,w.intake_batch_id,w.received_at,w.storage_until,e.declared_fields->'actual_label_info' actual_label_info,
    w.identity_state,w.condition_state,w.custody_state,
    ${itemHandlingHoldSql} handling_hold,
    p.code package_code,p.received_at package_received_at,
    coalesce(substring(p.condition_note from '^\\[outer:([a-z_]+)\\]'),'intact') package_outer_condition,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=w.org_id limit 1) customer_receiving_code,
    (select tr.tracking_norm from tracking_records tr where tr.package_id=p.id and tr.direction='inbound' and tr.closed_at is null limit 1) source_tracking_no,
    sl.code location,sl.zone location_zone,o.id order_id,o.public_no order_number,o.state order_state,
    so.title service_title,cat.labels category_labels,
    a.order_line_id,a.expected_item_id,e.position expected_position,e.declared_fields,l.attributes line_attributes,
    exists(select 1 from disposition_requests d where d.item_id=w.id and d.state not in ('completed','cancelled')) reserved,
    (select jsonb_build_object('id',d.id,'action',d.action,'state',d.state) from disposition_requests d where d.item_id=w.id and d.state not in ('completed','cancelled') order by d.revision desc limit 1) active_disposition,
    (select bi.batch_id from dispatch_batch_items bi where bi.item_id=w.id and bi.released_at is null limit 1) active_batch_id,
    exists(select 1 from reference_samples r where r.item_id=w.id and r.state='active') is_reference_sample,
    (select r.id from reference_samples r where r.item_id=w.id order by r.revision desc limit 1) reference_id,
    (select r.state from reference_samples r where r.item_id=w.id order by r.revision desc limit 1) reference_sample_state,
    (select r.expires_at from reference_samples r where r.item_id=w.id order by r.revision desc limit 1) reference_expires_at,
    (select r.condition_note from reference_samples r where r.item_id=w.id order by r.revision desc limit 1) reference_condition_note,
    (select r.authorization_snapshot->>'seal_code' from reference_samples r where r.item_id=w.id order by r.revision desc limit 1) reference_seal_code,
    (select exists(select 1 from reference_samples r join reference_reservations rr on rr.reference_id=r.id where r.item_id=w.id and rr.released_at is null)) reference_in_use,
    ${itemInspectionStageSql} inspection_stage,
    array(select m.id from media_assets m where m.item_id=w.id and m.kind in ('label_photo','shot','intake_open') and m.status='ready' order by m.captured_at desc nulls last,m.id desc limit 10) label_media_ids,
    (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'custody_state',c.custody_state) order by c.code),'[]'::jsonb)
     from warehouse_items c where c.parent_item_id=w.id) components
    from warehouse_items w join packages p on p.id=w.package_id
    left join storage_locations sl on sl.id=w.location_id
    left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
    left join expected_items e on e.id=a.expected_item_id
    left join order_lines l on l.id=a.order_line_id left join orders o on o.id=l.order_id
    left join service_offers so on so.id=l.offer_id left join categories cat on cat.id=l.category_id
    where w.id=$1`,[sample.id]);
  const storageEvents=(await db.query(`select se.id,se.action,se.created_at,fl.code from_location,tl.code to_location,u.display_name operator_name
    from storage_events se left join storage_locations fl on fl.id=se.from_location_id
    left join storage_locations tl on tl.id=se.to_location_id left join users u on u.id=se.operator_id
    where se.item_id=$1 order by se.created_at desc,se.id desc limit 20`,[item.id])).rows;
  const inspectionTasks=(await db.query(`select t.id,t.state,u.display_name assignee_name,tv.content->>'key' template_key
    from inspection_tasks t join template_versions tv on tv.id=t.template_version_id
    left join users u on u.id=t.assignee_id
    left join group_members gm on gm.group_id=t.group_id
    join order_line_item_links olil on olil.id=coalesce(t.assignment_id,gm.assignment_id)
    where olil.item_id=$1 and olil.unlinked_at is null and t.state<>'VOID'
    order by t.state,t.id`,[item.id])).rows;
  const activeTickets=item.org_id?(await db.query(`select k.id,k.public_no,k.category,k.state,k.subject
    from tickets k where k.org_id=$1 and k.state<>'closed' and (k.order_id=$2 or k.details->>'item_id'=$3)
    order by k.created_at desc limit 10`,[item.org_id,item.order_id,item.id])).rows:[];
  const movable=["received","stored"].includes(item.custody_state);
  const eligible=item.org_id&&!item.parent_item_id&&!item.order_number&&!item.reserved&&movable&&item.identity_state!=="quarantined";
  const rawPositions=eligible?(await db.query(`select e.id,e.position,e.declared_fields,l.id order_line_id,l.attributes line_attributes,o.public_no,s.title,
    (select array_agg(tr.tracking_norm order by tr.tracking_norm) from advice_orders ao join tracking_records tr on tr.advice_id=ao.advice_id and tr.direction='inbound' and tr.closed_at is null where ao.order_id=o.id) advised_tracking_nos
    from expected_items e join order_lines l on l.id=e.order_line_id
    join orders o on o.id=l.order_id join service_offers s on s.id=l.offer_id
    where l.org_id=$1 and ${orderAcceptsSampleAssignmentSql} and e.in_scope
    and not exists(select 1 from order_line_item_links a where a.expected_item_id=e.id and a.unlinked_at is null)
    order by o.public_no,l.id,e.position`,[item.org_id])).rows:[];
  const positions=rawPositions.map(pos=>{
    const df=(pos.declared_fields??{}) as Record<string,unknown>;
    const attr=(pos.line_attributes??{}) as Record<string,unknown>;
    const declaredTracking=String(df.declared_tracking_no??df.tracking_no??df.waybill??df.source_tracking_no??(Array.isArray(pos.advised_tracking_nos)?pos.advised_tracking_nos.join(", "):""));
    const perItemTracking=String(df.declared_tracking_no??df.tracking_no??df.waybill??df.source_tracking_no??"").trim();
    const advisedList=Array.isArray(pos.advised_tracking_nos)?(pos.advised_tracking_nos as string[]).filter(Boolean):[];
    return {
      ...pos,
      sample_code:String(df.sku_code??df.sample_code??df.sku??df.style_code??attr.sample_code??`POS-${pos.position}`),
      color:String(df.color??df.color_declared??df.colour??attr.color??attr.color_declared??""),
      size:String(df.size_label??df.size??attr.size??""),
      supplier_alias:String(df.supplier_alias??df.supplier??df.seller_name??attr.supplier_alias??""),
      declared_tracking_no:declaredTracking,
      source_tracking_no:declaredTracking,
      per_item_tracking_no:perItemTracking,
      advised_tracking_nos:advisedList,
      garment_type:String(df.garment_type??attr.garment_type??""),
    };
  });
  const df=(item.declared_fields??{}) as Record<string,unknown>;
  const attr=(item.line_attributes??{}) as Record<string,unknown>;
  const declaredSummary=item.declared_fields?{
    product_name:String(df.name??attr.name??""),
    sample_code:String(df.sku_code??df.sample_code??df.sku??df.style_code??attr.sample_code??""),
    color:String(df.color??df.color_declared??df.colour??attr.color??attr.color_declared??""),
    size:String(df.size_label??df.size??attr.size??""),
    supplier_alias:String(df.supplier_alias??df.supplier??df.seller_name??attr.supplier_alias??""),
    declared_tracking_no:String(df.declared_tracking_no??df.tracking_no??df.waybill??df.source_tracking_no??item.source_tracking_no??""),
    garment_type:String(df.garment_type??attr.garment_type??""),
  }:null;
  const refZoneWarning=(item.is_reference_sample || item.reference_sample_state==="pending_safe_storage") && item.location_zone!=="reference"
    ?(item.reference_sample_state==="pending_safe_storage"
      ?`客户已申请转为确认样（铅封号 ${item.reference_seal_code??"待核验"}），请前往库位移转扫码铅封并移入确认样专区（如 A-04-02-03）后生效。`
      :"该确认样当前不在确认样专区（reference），请立即核查并移入确认样安全专柜！")
    :null;
  return {item:{id:item.id,code:item.code,revision:item.revision,parent_item_id:item.parent_item_id,
    intake_batch_id:item.intake_batch_id,identity_state:item.identity_state,condition_state:item.condition_state,
    custody_state:item.custody_state,handling_hold:item.handling_hold??null,
    received_at:item.received_at,storage_until:item.storage_until??null,
    actual_label_info:item.actual_label_info??null,
    inspection_stage:item.inspection_stage??"pending",
    is_reference_sample:Boolean(item.is_reference_sample),
    reference_id:item.reference_id??null,
    reference_sample_state:item.reference_sample_state??null,
    reference_expires_at:item.reference_expires_at??null,
    reference_condition_note:item.reference_condition_note??null,
    reference_in_use:Boolean(item.reference_in_use),
    reference_seal_code:item.reference_seal_code??null,
    reference_zone_warning:refZoneWarning,
    package_code:item.package_code,package_outer_condition:item.package_outer_condition,package_received_at:item.package_received_at,
    customer_receiving_code:item.customer_receiving_code??null,
    service_title:item.service_title??null,category_labels:item.category_labels??null,
    source_tracking_no:item.source_tracking_no??null,
    location:item.location,location_zone:item.location_zone??null,
    order_id:item.order_id??null,order_number:item.order_number,order_state:item.order_state??null,
    order_line_id:item.order_line_id??null,expected_item_id:item.expected_item_id??null,
    expected_position:item.expected_position??null,declared_fields:item.declared_fields??null,
    declared_summary:declaredSummary,
    label_media_ids:item.label_media_ids??[],
    active_disposition:item.active_disposition??null,
    active_batch_id:item.active_batch_id??null,
    reserved:Boolean(item.reserved),
    can_unassign:Boolean(item.order_number && item.order_state==="awaiting_samples"),
    can_identify:Boolean(item.order_number && ["awaiting_samples","on_hold","samples_ready","queued"].includes(item.order_state) && item.identity_state!=="quarantined" && !["in_inspection","inspected"].includes(item.inspection_stage??"")),
    components:item.components,ownership_verified:!!item.org_id,movable},
    storage_events:storageEvents,inspection_tasks:inspectionTasks,active_tickets:activeTickets,positions};
}
const warehouseBatches=`select b.id,b.revision,b.state,b.action,b.destination_snapshot,
  (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=b.org_id limit 1) receiving_code,
  coalesce((select array_agg(distinct o2.public_no order by o2.public_no)
    from dispatch_batch_items bi2 join order_line_item_links a2 on a2.item_id=bi2.item_id and a2.unlinked_at is null
    join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id
    where bi2.batch_id=b.id),array[]::text[]) order_numbers,
  q.id quote_id,q.snapshot,
  q.revision quote_revision,q.amount_cents,q.expires_at,q.accepted_at,
  b.state='quoted' and ${renewableFulfillmentQuote} renewable_quote,
  (select jsonb_agg(jsonb_build_object(
    'id',w.id,'code',w.code,'location_code',sl.code,'quarantined',${itemQuarantineSql},
    'product_name',coalesce(nullif(e.declared_fields->>'name',''),''),
    'sku_code',coalesce(nullif(e.declared_fields->>'sku_code',''),nullif(e.declared_fields->>'sample_code',''),''),
    'order_no',o3.public_no
  ) order by w.code)
    from dispatch_batch_items bi join warehouse_items w on w.id=bi.item_id and w.org_id=bi.org_id
    left join storage_locations sl on sl.id=w.location_id
    left join order_line_item_links a3 on a3.item_id=w.id and a3.unlinked_at is null
    left join expected_items e on e.id=a3.expected_item_id
    left join order_lines l3 on l3.id=a3.order_line_id
    left join orders o3 on o3.id=l3.order_id
    where bi.batch_id=b.id and bi.released_at is null) items,
  array(select si.item_id from shipment_items si where si.batch_id=b.id) packed_item_ids
  from dispatch_batches b left join lateral(
    select * from dispatch_quote_versions q where q.batch_id=b.id order by revision desc limit 1
  ) q on true left join charge_items c on c.dispatch_quote_id=q.id`;
const activeLocations="select id,code from storage_locations where active order by code";
const activeRates="select id,version from shipping_rate_versions where effective_at<=now() order by version desc";
export const dispatchQueueStates=["weighing","payment","packing","handover","shipped","returned","blocked"] as const;
export async function warehouseDispatchQueue(db:DB,actor:Actor,state:typeof dispatchQueueStates[number],reference:string|null) {
  role(actor,...staffAccess.dispatch);
  const {rows}=await db.query(`with queue as (
    select b.id,b.action,q.expires_at,
      (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=b.org_id limit 1) receiving_code,
      coalesce((select array_agg(distinct o2.public_no order by o2.public_no)
        from dispatch_batch_items bi2 join order_line_item_links a2 on a2.item_id=bi2.item_id and a2.unlinked_at is null
        join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id
        where bi2.batch_id=b.id),array[]::text[]) order_numbers,
      (select min((d.return_info->>'deadline')::timestamptz) from dispatch_batch_items i
        join disposition_requests d on d.id=i.disposition_id where i.batch_id=b.id and i.released_at is null) return_deadline,
      (select count(*)::int from dispatch_batch_items i where i.batch_id=b.id and i.released_at is null) remaining,
      s.packed,s.ready_packed,s.shipped,s.returns,s.last_handover,s.waybills,
      exists(select 1 from dispatch_quote_versions dq join charge_items c on c.dispatch_quote_id=dq.id
        where dq.batch_id=b.id and ${effectiveDispatchCharge}) paid,
      exists(select 1 from dispatch_batch_items i join warehouse_items w on w.id=i.item_id
        where i.batch_id=b.id and i.released_at is null and ${itemQuarantineSql}) has_quarantine,
      exists(select 1 from jsonb_array_elements(coalesce(q.snapshot->'parcels','[]'::jsonb)) plan
        where exists(select 1 from dispatch_batch_items i where i.batch_id=b.id and i.released_at is null
          and (plan->'item_ids') ? i.item_id::text
          and not exists(select 1 from shipment_items si where si.batch_id=i.batch_id and si.item_id=i.item_id))
        and not exists(select 1 from dispatch_batch_items i join warehouse_items w on w.id=i.item_id
          where i.batch_id=b.id and i.released_at is null and (plan->'item_ids') ? i.item_id::text and ${itemQuarantineSql})) needs_packing,
      b.state,${renewableFulfillmentQuote} renewable
    from dispatch_batches b left join lateral(select id,expires_at,accepted_at,snapshot from dispatch_quote_versions
      where batch_id=b.id order by revision desc limit 1) q on true
    left join charge_items c on c.dispatch_quote_id=q.id
    left join lateral(select count(*) filter (where sh.state='packed')::int packed,
      count(*) filter(where sh.state='packed' and not exists(select 1 from shipment_items si join warehouse_items w on w.id=si.item_id
        where si.shipment_id=sh.id and ${itemQuarantineSql}))::int ready_packed,
      count(*) filter (where sh.shipped_at is not null)::int shipped,
      count(*) filter (where exists(select 1 from shipment_return_items sr where sr.shipment_id=sh.id))::int returns,
      max(sh.shipped_at) last_handover,
      array_agg(distinct sh.tracking_norm order by sh.tracking_norm) filter (where sh.tracking_norm is not null) waybills
      from shipments sh where sh.batch_id=b.id) s on true
    where b.state<>'draft'
  ) select id,action,state,receiving_code,order_numbers,expires_at,return_deadline,remaining,packed,shipped,returns,last_handover,waybills,has_quarantine from queue where ($2::text is null or id::text=$2 or $2=any(waybills) or upper(coalesce(receiving_code,''))=upper($2) or upper($2)=any(select upper(onum) from unnest(order_numbers) onum)) and case $1::text
    when 'weighing' then state='confirmed' or state='quoted' and renewable
    when 'payment' then state='quoted' and not coalesce(renewable,false)
    when 'packing' then state='paid' and paid and needs_packing
    when 'handover' then state='paid' and paid and ready_packed>0
    when 'shipped' then shipped>0
    when 'returned' then returns>0
    when 'blocked' then state='paid' and (not paid or has_quarantine)
    else false end
  order by case when $1 in ('weighing','payment','packing','handover') then least(return_deadline,
    case when $1 in ('weighing','payment') then expires_at end) end nulls last,
    last_handover desc nulls last,id limit 100`,[state,reference]);
  return {rows};
}
export async function warehouseDispatchBatch(db:DB,actor:Actor,id:string) {
  role(actor,...staffAccess.dispatch);
  const batch=await one(db,warehouseBatches+" where b.id=$1 and b.state<>'draft'",[id]);
  const {rows:shipments}=await db.query(`select s.id,s.revision,s.state,s.weight_g,s.carrier_code,s.tracking_norm,
    s.shipped_at,s.returned_at,t.transport_state,t.sync_state,zh.fetched_at tracking_updated_at,zh.events_json tracking_events,
    array(select jsonb_build_object('id',ae.id,'at',ae.at,'action',ae.action,'body',ae.after->>'body','display_name',u.display_name)
      from audit_events ae left join users u on u.id=ae.actor_id where ae.entity_type='shipments' and ae.entity_id=s.id
      and ae.action in ('pack_shipment','handover') and ae.after->>'body' is not null order by ae.at desc,ae.id desc) operation_notes,
    (select jsonb_agg(jsonb_build_object('id',w.id,'code',w.code,'received_at',r.received_at,'quarantined',${itemQuarantineSql}) order by w.code)
      from shipment_items si join warehouse_items w on w.id=si.item_id and w.org_id=b.org_id
      left join shipment_return_items r on r.shipment_id=si.shipment_id and r.item_id=si.item_id
      where si.shipment_id=s.id) items,
    array(select m.id from media_assets m where m.shipment_id=s.id and m.org_id=b.org_id and m.kind='dispatch'
      and m.status='ready' order by m.id) evidence_ids
    from shipments s join dispatch_batches b on b.id=s.batch_id
    left join tracking_records t on t.shipment_id=s.id and t.batch_id=b.id and t.org_id=b.org_id and t.closed_at is null
    left join lateral(select fetched_at,events_json from tracking_snapshots
      where tracker_id=t.id and locale='zh-CN' order by latest_event_at desc nulls last,fetched_at desc limit 1) zh on true
    where s.batch_id=$1 order by s.shipped_at nulls first,s.id`,[id]);
  return {batch,shipments,rates:(await db.query(activeRates)).rows,locations:(await db.query(activeLocations)).rows};
}
export async function warehouseDesk(db:DB,actor:Actor) {
  role(actor,"receiver","warehouse_admin","inspector","reviewer","super_admin");
  const canReceive=actor.roles.some(r=>["receiver","warehouse_admin","super_admin"].includes(r)),canShip=actor.roles.some(r=>["warehouse_admin","super_admin"].includes(r));
  const canInspect=actor.roles.some(r=>["inspector","reviewer","warehouse_admin","super_admin"].includes(r));
  const canReview=actor.roles.some(r=>["reviewer","warehouse_admin","super_admin"].includes(r));
  const metrics=await one(db,`select
    ${canReceive?"(select count(*)::int from tracking_records where closed_at is null and direction='inbound' and transport_state='delivered' and package_id is null)":"0::int"} delivered_unreceived_count,
    ${canReceive?"(select count(*)::int from packages p where p.state in ('checked_in','unmatched') and coalesce(p.received_quantity,0)=0 and not exists(select 1 from warehouse_items wi where wi.package_id=p.id))":"0::int"} unpacked_pending_count,
    ${canReceive?"(select count(*)::int from packages where state='unmatched' or org_id is null)":"0::int"} unmatched_parcel_count,
    ${canReceive?"(select count(*)::int from warehouse_items where custody_state in ('received','stored') and parent_item_id is null and identity_state<>'identified')":"0::int"} pending_id_count,
    ${canReceive?"(select count(*)::int from packages where state='quarantined')":"0::int"} quarantined_packages_count,
    ${canReceive?"(select count(*)::int from reference_samples where state='pending_safe_storage')":"0::int"} pending_reference_count,
    ${canReceive?"(select count(*)::int from stocktakes where state in ('in_progress','submitted'))":"0::int"} active_stocktakes_count,
    ${canInspect?"(select count(*)::int from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id where t.state='READY' and o.state in ('queued','inspecting'))":"0::int"} ready_task_count,
    ${canInspect?"(select count(*)::int from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id where t.state='IN_PROGRESS' and o.state in ('queued','inspecting'))":"0::int"} in_progress_task_count,
    ${canInspect?"(select count(*)::int from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id where t.state='IN_PROGRESS' and o.state='inspecting' and exists(select 1 from reports r join report_versions rv on rv.report_id=r.id where r.order_id=o.id and rv.state='draft' and rv.reviewed_at is not null))":"0::int"} returned_task_count,
    ${canInspect?"(select count(*)::int from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id where t.state in ('READY','IN_PROGRESS','SUBMITTED') and o.state in ('queued','inspecting','qa_review'))":"0::int"} total_active_task_count,
    ${canInspect?"(select count(*)::int from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id where t.state in ('READY','IN_PROGRESS','SUBMITTED') and o.state in ('queued','inspecting','qa_review') and o.sla_due_at is not null and o.sla_due_at<=now())":"0::int"} overdue_task_count,
    ${canReview?"(select count(*)::int from report_versions where state='submitted')":"0::int"} pending_qa_count,
    ${canShip?"(select count(*)::int from dispatch_batches where state in ('confirmed','quoted','paid'))":"0::int"} actionable_dispatch_count`);
  const packages=canReceive?(await db.query(`select p.id,p.code,p.state,p.org_id,p.revision,p.received_quantity,p.received_at,p.weight_g,p.condition_note,
    substring(p.condition_note from '^\\[outer:(intact|crushed|torn|wet)\\]') outer_condition,
    t.tracking_norm,ru.display_name received_by_name,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=p.org_id limit 1) receiving_code,
    coalesce((select array_agg(distinct o.public_no order by o.public_no) from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=p.advice_id),array[]::text[]) order_numbers,
    (select count(*)::int from warehouse_items wi where wi.package_id=p.id and wi.parent_item_id is null) logged_item_count,
    (select min(o.sla_due_at) from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=p.advice_id) sla_due_at
    from packages p left join tracking_records t on t.package_id=p.id and t.direction='inbound' and t.closed_at is null
    left join users ru on ru.id=p.received_by
    order by p.received_at desc limit 100`)).rows:[];
  const items=canReceive?(await db.query(`select w.id,w.code,w.package_id,w.org_id,w.revision,w.identity_state,w.condition_state,w.custody_state,
    ${itemInspectionStageSql} inspection_stage,l.code location,p.code package_code,o.public_no order_no,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=w.org_id limit 1) receiving_code,
    e.declared_fields,
    coalesce(
      (select m.id from media_assets m where m.item_id=w.id and m.kind='shot' and m.status='ready' order by m.captured_at asc nulls last,m.id asc limit 1),
      (select m.id from media_assets m where m.package_id=w.package_id and m.kind in ('intake_open','intake_outer') and m.status='ready' order by m.captured_at desc nulls last,m.id desc limit 1)
    ) thumbnail_media_id
    from warehouse_items w join packages p on p.id=w.package_id
    left join storage_locations l on l.id=w.location_id
    left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
    left join expected_items e on e.id=a.expected_item_id
    left join order_lines ol on ol.id=a.order_line_id
    left join orders o on o.id=ol.order_id
    where w.custody_state in ('received','stored') order by w.received_at desc limit 400`)).rows:[];
  const locations=canReceive?(await db.query(activeLocations)).rows:[];
  const tasks=canInspect?(await db.query(`select t.id,t.state,t.revision,t.assignee_id,au.display_name assignee_name,l.order_id,o.public_no,o.state order_state,o.sla_due_at,o.samples_ready_at,
    o.customer_notes,
    (o.sla_due_at is not null and o.sla_due_at<=now()) sla_overdue,
    so.title,st.code service,c.labels category_labels,w.id item_id,w.code item_code,sl.code location_code,p.code package_code,e.declared_fields,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=o.org_id limit 1) receiving_code,
    ((l.attributes->'tolerances' is not null and jsonb_typeof(l.attributes->'tolerances') in ('object','array') and l.attributes->'tolerances'<>'{}'::jsonb and l.attributes->'tolerances'<>'[]'::jsonb)
      or (l.options ? 'tolerances' and jsonb_typeof(l.options->'tolerances') in ('object','array'))) has_tolerances,
    (select coalesce(array_agg(ob.reason order by ob.opened_at),'{}'::text[]) from order_blocks ob where ob.order_id=o.id and ob.resolved_at is null) order_blocks,
    case when t.state='IN_PROGRESS' then (
      select ae.after->>'reason' from reports r join report_versions rv on rv.report_id=r.id
      join audit_events ae on ae.entity_id=rv.id and ae.entity_type='report_versions' and ae.action='return_report'
      where r.order_id=o.id and rv.state='draft' order by rv.version desc limit 1
    ) end returned_reason
    from inspection_tasks t join order_lines l on l.id=t.order_line_id join orders o on o.id=l.order_id
    left join users au on au.id=t.assignee_id
    join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    join categories c on c.id=l.category_id
    left join order_line_item_links a on a.id=t.assignment_id left join expected_items e on e.id=a.expected_item_id
    left join warehouse_items w on w.id=a.item_id left join storage_locations sl on sl.id=w.location_id left join packages p on p.id=w.package_id
    where t.state in ('READY','IN_PROGRESS','SUBMITTED') and o.state in ('queued','inspecting','qa_review')
    order by o.sla_due_at asc nulls last,o.samples_ready_at asc nulls last,o.created_at asc,t.id asc limit 400`)).rows:[];
  const reports=canReview?(await db.query(`select v.id,v.version,v.state,v.revision,v.snapshot,v.amend_reason,v.created_by,
    v.created_at submitted_at,r.published_version,o.id order_id,o.public_no,o.sla_due_at,cu.display_name created_by_name,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=o.org_id limit 1) receiving_code,
    (select so.title from order_lines ol join service_offers so on so.id=ol.offer_id where ol.order_id=o.id order by ol.id limit 1) service_title,
    (select coalesce(array_agg(distinct wi.code order by wi.code),array[]::text[]) from order_lines ol2 join order_line_item_links olil2 on olil2.order_line_id=ol2.id and olil2.unlinked_at is null join warehouse_items wi on wi.id=olil2.item_id where ol2.order_id=o.id) item_codes
    from report_versions v join reports r on r.id=v.report_id
    join orders o on o.id=r.order_id left join users cu on cu.id=v.created_by
    where (v.state in ('submitted','qa_approved') and o.state='qa_review') or v.state='submitted'
    order by v.created_at desc,v.id limit 100`)).rows:[];
  const batches=canShip?(await db.query(warehouseBatches+
    " where b.state in ('confirmed','quoted','paid') order by q.expires_at nulls last,b.id limit 100")).rows:[];
  const shipments=canShip?(await db.query(`select s.id,s.state,s.revision,s.tracking_norm,s.batch_id,b.action,s.weight_g,
    array(select item_id from shipment_items where shipment_id=s.id) item_ids,
    (select jsonb_object_agg(w.id::text,w.code) from shipment_items si join warehouse_items w on w.id=si.item_id where si.shipment_id=s.id) item_codes,
    array(select item_id from shipment_return_items where shipment_id=s.id) returned_item_ids from shipments s join dispatch_batches b on b.id=s.batch_id
    order by s.shipped_at desc nulls first limit 100`)).rows:[];
  const rates=canShip?(await db.query(activeRates)).rows:[];
  const retain=canShip?(await db.query(`select d.id,w.code,q.id is not null renewal,d.return_info->'days' days,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=w.org_id limit 1) receiving_code,
    (select o2.public_no from order_line_item_links a2 join order_lines l2 on l2.id=a2.order_line_id join orders o2 on o2.id=l2.order_id where a2.item_id=w.id and a2.unlinked_at is null limit 1) order_no
    from disposition_requests d join warehouse_items w on w.id=d.item_id
    left join lateral(select id,expires_at,accepted_at from storage_quotes where disposition_id=d.id order by revision desc limit 1) q on true
    left join charge_items c on c.storage_quote_id=q.id
    where d.action='retain' and d.state='requested' and (q.id is null or ${renewableFulfillmentQuote})`)).rows:[];
  const delivered_unreceived=canReceive?(await db.query(`select t.id,t.tracking_norm,t.carrier_code,t.advice_id,
    (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=t.org_id limit 1) receiving_code,
    coalesce((select array_agg(distinct o.public_no order by o.public_no) from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=t.advice_id),array[]::text[]) order_numbers,
    (select max(ts.latest_event_at) from tracking_snapshots ts where ts.tracker_id=t.id) delivered_at
    from tracking_records t
    where t.closed_at is null and t.direction='inbound' and t.transport_state='delivered' and t.package_id is null
    order by delivered_at desc nulls last,t.id desc limit 10`)).rows:[];
  return {metrics,packages,items,locations,tasks,reports,batches,shipments,rates,retain,delivered_unreceived};
}
export async function adminDesk(db:DB,actor:Actor) {
  role(actor,...staffAccess.administration);
  const finance=hasStaffAccess(actor.roles,staffAccess.finance);
  const ops=hasStaffAccess(actor.roles,staffAccess.orders);
  const templates=hasStaffAccess(actor.roles,staffAccess.templates);
  const overviewMetrics=ops?(await db.query(`select
    count(*) filter (where coalesce(is_test,false)=false and state='awaiting_samples')::int awaiting_samples,
    count(*) filter (where state='awaiting_samples')::int awaiting_samples_all,
    count(*) filter (where coalesce(is_test,false)=false and state in ('queued','inspecting'))::int queued_or_inspecting,
    count(*) filter (where state in ('queued','inspecting'))::int queued_or_inspecting_all,
    count(*) filter (where coalesce(is_test,false)=false and state in ('queued','inspecting','qa_review') and sla_due_at is not null and sla_due_at<=now())::int sla_overdue,
    count(*) filter (where state in ('queued','inspecting','qa_review') and sla_due_at is not null and sla_due_at<=now())::int sla_overdue_all,
    count(*) filter (where coalesce(is_test,false)=false and (
      state='on_hold' or
      (sla_due_at is not null and sla_due_at<=now() and state in ('queued','inspecting','qa_review')) or
      exists(select 1 from order_blocks ob where ob.order_id=orders.id and ob.resolved_at is null) or
      exists(select 1 from tickets k where k.order_id=orders.id and k.state in ('open','waiting_customer','waiting_internal'))
    ))::int exception_orders,
    count(*) filter (where (
      state='on_hold' or
      (sla_due_at is not null and sla_due_at<=now() and state in ('queued','inspecting','qa_review')) or
      exists(select 1 from order_blocks ob where ob.order_id=orders.id and ob.resolved_at is null) or
      exists(select 1 from tickets k where k.order_id=orders.id and k.state in ('open','waiting_customer','waiting_internal'))
    ))::int exception_orders_all,
    count(*) filter (where coalesce(is_test,false)=false and state='qa_review')::int qa_review,
    count(*) filter (where state='qa_review')::int qa_review_all,
    count(*) filter (where coalesce(is_test,false)=false)::int production_orders,
    count(*) filter (where coalesce(is_test,false)=true)::int test_orders,
    count(*)::int total_orders,
    (select count(*)::int from dispatch_batches where state in ('confirmed','quoted','paid')) dispatch_pending,
    (select count(*)::int from tickets where state in ('open','waiting_customer','waiting_internal')) open_tickets,
    (select count(*)::int from payment_disputes where state<>'resolved_by_staff') open_disputes,
    (select count(*)::int from packages where state='unmatched' or org_id is null) unmatched_packages,
    (select count(*)::int from refunds where state='requested') pending_refunds,
    (select count(*)::int from manual_quote_requests where state='requested') pending_manual_quotes,
    (select count(*)::int from tracking_records where closed_at is null and direction='inbound' and transport_state='delivered' and package_id is null) delivered_unreceived,
    (select count(*)::int from disposal_cases where state='pending_approval') pending_disposals,
    (select count(*)::int from incident_cases where state in ('open','proposed','customer_rejected','awaiting_payout')) open_incidents,
    (select count(*)::int from stocktakes where state='submitted') submitted_stocktakes,
    (select count(*)::int from report_versions where state='submitted') pending_report_reviews,
    (select count(*)::int from outbox_events where processed_at is null and attempts>0) failed_jobs,
    (select count(*)::int from customer_receiving_profiles) active_customers
    from orders`)).rows[0]:null;
  const dailyTrend=ops?(await db.query<{day:string;total:number;completed:number}>(`
    select to_char(d.ts,'MM-DD') as day,
      count(o.id)::int as total,
      count(o.id) filter (where o.state in ('report_ready','action_pending','closed'))::int as completed
    from generate_series(
      date_trunc('day',now() at time zone 'UTC') - interval '8 days',
      date_trunc('day',now() at time zone 'UTC'),
      interval '1 day'
    ) as d(ts)
    left join orders o on coalesce(o.is_test,false)=false
      and o.created_at >= (d.ts at time zone 'UTC')
      and o.created_at < ((d.ts + interval '1 day') at time zone 'UTC')
    group by d.ts
    order by d.ts asc`)).rows:[];
  return {
    overviewMetrics,
    dailyTrend,
    effectiveLaunchMode:await effectiveLaunchMode(db),
    orders:ops?(await db.query("select id,public_no,state,coalesce(is_test,false) is_test,sla_due_at,created_at from orders order by created_at desc limit 150")).rows:[],
    tickets:ops?(await db.query("select id,public_no,subject,category,state,next_action_at from tickets order by created_at desc limit 150")).rows:[],
    claims:ops?(await db.query(`select k.id,k.public_no,k.state,k.details->>'tracking_no' tracking_no,
      k.details->>'carrier_code' carrier_code,k.details->>'proof_id' proof_id,k.details->>'decision' decision,
      (${pendingIntakeClaimSql}) can_decide,
      array(select m.id from tracking_records t join media_assets m on m.package_id=t.package_id
        where t.direction='inbound' and t.closed_at is null and t.org_id is null
        and t.tracking_norm=k.details->>'tracking_no' and coalesce(t.carrier_code,k.details->>'carrier_code')=k.details->>'carrier_code'
        and m.kind='intake_outer' and m.status='ready') outer_photo_ids
      from tickets k where category='identity_unclear' and details ? 'proof_id'
      order by (${pendingIntakeClaimSql}) desc,created_at desc limit 100`)).rows:[],
    unmatchedPackages:ops?(await db.query(`select p.id,p.code,p.revision,p.condition_note,p.received_at,p.received_quantity,
      (select t.tracking_norm from tracking_records t where t.package_id=p.id and t.direction='inbound' and t.closed_at is null limit 1) tracking_norm,
      (select t.carrier_code from tracking_records t where t.package_id=p.id and t.direction='inbound' and t.closed_at is null limit 1) carrier_code,
      sl.code location_code,
      array(select m.id from media_assets m where m.package_id=p.id and m.kind in ('intake_outer','label_photo') and m.status='ready' order by m.captured_at) outer_photo_ids
      from packages p left join storage_locations sl on sl.id=p.location_id
      where p.state='unmatched' and p.org_id is null
      order by p.received_at desc nulls last,p.id desc limit 100`)).rows:[],
    manualQuotes:ops?(await db.query(`select r.id,r.order_id,r.revision,r.state,r.assignee_id,r.reason,o.public_no,
      (select jsonb_agg(jsonb_build_object('id',l.id,'quantity',l.quantity,'title',s.title->>'zh-CN') order by l.id)
       from order_lines l join service_offers s on s.id=l.offer_id where l.order_id=r.order_id) lines
      from manual_quote_requests r join orders o on o.id=r.order_id and o.revision=r.revision
      where ${eligibleManualQuoteOrderSql} and r.state in ('requested','offered') order by r.due_at limit 100`)).rows:[],
    refunds:finance?(await db.query(`select r.id,r.payment_id,r.amount_cents,r.state,r.reason,r.revision,r.requested_by,
      r.provider_ref,r.source,c.purpose,o.public_no from refunds r join payments p on p.id=r.payment_id
      join charge_items c on c.id=p.charge_item_id left join inspection_quotes q on q.id=c.inspection_quote_id
      left join orders o on o.id=q.order_id order by r.created_at desc limit 100`)).rows:[],
    payments:finance?(await db.query(`select p.id,p.charge_item_id,p.state,p.amount_cents,p.provider_ref,p.created_at,
      c.purpose,o.public_no,coalesce(o.is_test,false) is_test
      from payments p join charge_items c on c.id=p.charge_item_id
      left join inspection_quotes q on q.id=c.inspection_quote_id
      left join orders o on o.id=q.order_id
      order by p.created_at desc limit 150`)).rows:[],
    disputes:finance?(await db.query(`select d.provider_id provider_dispute_id,d.payment_id,p.charge_item_id,
      q.order_id,dq.batch_id,d.state status,p.amount_cents,c.currency,
      d.evidence_due_at,d.updated_at,p.provider_ref payment_provider_ref,o.public_no,
      ae.after->>'decision' staff_decision,ae.after->>'reason' staff_note
      from payment_disputes d
      join payments p on p.id=d.payment_id
      join charge_items c on c.id=p.charge_item_id
      left join inspection_quotes q on q.id=c.inspection_quote_id
      left join orders o on o.id=q.order_id
      left join dispatch_quote_versions dq on dq.id=c.dispatch_quote_id
      left join lateral (
        select after from audit_events
        where action='resolve_payment_dispute' and entity_type='payments'
          and entity_id=d.payment_id and after->>'provider_id'=d.provider_id
        order by id desc limit 1
      ) ae on true
      order by d.updated_at desc limit 100`)).rows.map(dispute=>({...dispute,can_review:isProviderDisputeClosed(dispute.status)})):[],
    shippingRates:(finance||actor.roles.includes("super_admin"))?(await db.query("select id,version,rules,effective_at from shipping_rate_versions order by version desc limit 50")).rows:[],
    warehouseAddressAlert:actor.roles.includes("super_admin")?(await db.query(`select 1 from notifications
      where user_id=$1 and template='warehouse.address_required'
      and not exists(select 1 from warehouse_addresses where is_default and active) limit 1`,[actor.id])).rowCount===1:false,
    addresses:actor.roles.includes("super_admin")?(await db.query(
      `select w.id,w.address_zh,w.address_en,w.contact_name,w.contact_phone,w.active,w.is_default,w.created_at,
              (select count(*)::int from package_advices pa where pa.address_id=w.id) advice_count
       from warehouse_addresses w
       order by w.is_default desc,w.active desc,w.created_at desc`
    )).rows:[],
    quote_policy:actor.roles.includes("super_admin")?await quotePolicy(db):null,
    calendar:actor.roles.includes("super_admin")?await (async()=>{
      const cfg=(await db.query<{key:string;value:unknown}>("select key,value from app_config where key in ('calendar.holidays','business_holidays','calendar.extra_workdays')")).rows;
      const holidays=new Set<string>();
      const extraWorkdays=new Set<string>();
      for(const r of cfg) {
        if((r.key==="calendar.holidays"||r.key==="business_holidays")&&Array.isArray(r.value)) {
          for(const d of r.value) if(typeof d==="string") holidays.add(d);
        }
        if(r.key==="calendar.extra_workdays"&&Array.isArray(r.value)) {
          for(const d of r.value) if(typeof d==="string") extraWorkdays.add(d);
        }
      }
      return {holidays:[...holidays].sort(),extra_workdays:[...extraWorkdays].sort()};
    })():{holidays:[],extra_workdays:[]},
    termsVersions:actor.roles.includes("super_admin")?(await db.query(
      `select tv.id,tv.kind,tv.version,tv.effective_at,tv.content_md,tv.content_hash,
              case when tv.effective_at is not null and tv.effective_at<=now() then 'published' else 'draft' end state,
              (tv.content_md ilike '%Development fixture%' or tv.version ilike 'demo-%') is_demo_fixture,
              (select count(*)::int from account_consents ac where ac.terms_version_id=tv.id) consent_count,
              (tv.effective_at is not null and tv.effective_at<=now() and tv.id=(
                select tv2.id from terms_versions tv2
                where tv2.kind=tv.kind and tv2.effective_at is not null and tv2.effective_at<=now()
                order by tv2.effective_at desc,tv2.version desc limit 1
              )) is_current_active
       from terms_versions tv
       order by tv.kind,tv.effective_at desc nulls first,tv.version desc`
    )).rows:[],
    staffUsers:actor.roles.includes("super_admin")?(await db.query(
      `select u.id,u.display_name,u.status,u.auth_version,u.created_at,u.updated_at,
              (select ue.original_email from user_emails ue where ue.user_id=u.id order by ue.is_primary desc,ue.id limit 1) email,
              coalesce(array(select sr.role from staff_roles sr where sr.user_id=u.id order by sr.role), array[]::text[]) roles
       from users u
       where exists(select 1 from staff_roles sr where sr.user_id=u.id)
          or u.mfa_secret_enc is not null
       order by u.created_at asc`
    )).rows:[],
    customerUsers:(ops || actor.roles.includes("super_admin"))?(await db.query<{
      id:string;org_id:string;receiving_code:string;status:string;created_at:Date;
      original_email:string|null;normalized_email:string|null;order_count:number;stored_item_count:number;
    }>(
      `select u.id,p.org_id,p.receiving_code,u.status,u.created_at,
              ue.original_email,ue.normalized_email::text as normalized_email,
              (select count(*)::int from orders o where o.org_id=p.org_id) order_count,
              (select count(*)::int from warehouse_items w where w.org_id=p.org_id and w.custody_state in ('received','stored') and w.parent_item_id is null) stored_item_count
       from customer_receiving_profiles p
       join users u on u.id=p.user_id
       left join user_emails ue on ue.user_id=u.id and ue.is_primary
       order by u.created_at desc limit 150`
    )).rows.map(r=>({
      id:r.id,
      org_id:r.org_id,
      receiving_code:r.receiving_code,
      status:r.status,
      created_at:r.created_at,
      email:actor.roles.includes("super_admin")
        ?(r.original_email??r.normalized_email)
        :(r.normalized_email?r.normalized_email.replace(/(^.).*(@.*$)/,"$1***$2"):null),
      order_count:r.order_count,
      stored_item_count:r.stored_item_count,
    })):[],
    templates:templates?(await db.query(`select t.id,t.template_key,t.category_id,t.service_type_id,t.version,t.state,t.content,
      t.content_hash,t.author_id,t.reviewer_id,t.published_at,
      au.display_name author_name,ru.display_name reviewer_name,
      cat.labels->>'zh-CN' category_label,st.labels->>'zh-CN' service_label,
      (select count(distinct l.order_id)::int from order_lines l where l.template_version_id=t.id) order_count,
      array(select c.code from template_capabilities tc join capabilities c on c.id=tc.capability_id
        where tc.template_version_id=t.id order by c.code) capability_codes
      from template_versions t
      left join users au on au.id=t.author_id
      left join users ru on ru.id=t.reviewer_id
      left join categories cat on cat.id=t.category_id
      left join service_types st on st.id=t.service_type_id
      order by t.published_at desc nulls first,t.template_key,t.version desc limit 100`)).rows:[],
    categories:templates?(await db.query("select id,slug,labels,status,revision,admission_snapshot from categories order by slug")).rows:[],
    services:templates?(await db.query("select id,code,labels from service_types order by code")).rows:[],
    capabilities:templates?(await db.query("select id,code,method from capabilities where approved_by is not null and revoked_at is null order by code")).rows:[],
    allCapabilities:templates?(await db.query("select id,code,method,approval,approved_by,revoked_at from capabilities order by code")).rows:[],
    offers:templates?(await db.query(`select o.id,o.sku_code,o.title,o.enabled,o.service_type_id,ot.category_id,ot.template_version_id,
      p.version price_version,p.rules,p.effective_from from service_offers o
      left join offer_templates ot on ot.offer_id=o.id
      left join lateral(select version,rules,effective_from from sku_prices sp where sp.offer_id=o.id and effective_from<=now()
        and (effective_to is null or effective_to>now()) order by effective_from desc,version desc limit 1) p on true
      order by o.sku_code`)).rows:[],
    jobErrors:actor.roles.includes("super_admin")?(await db.query("select id,type,attempts,last_error,next_attempt_at from outbox_events where processed_at is null and attempts>0 order by id desc limit 50")).rows:[],
  };
}
export async function readOrderByPublicNumber(db:DB,actor:Actor,publicNo:string) {
  const row=await one<{id:string;public_no:string;revision:number;state:string}>(db,"select id,public_no,revision,state from orders where replace(upper(public_no),'-','')=replace(upper($1),'-','') and org_id=$2",[publicNo,organization(actor)]);
  return orderDTO(row);
}
const inboundBelongsToOrder=`t.org_id=o.org_id and (exists(
  select 1 from advice_orders ao where ao.advice_id=t.advice_id and ao.org_id=o.org_id and ao.order_id=o.id
) or exists(
  select 1 from warehouse_items w join order_line_item_links a on a.item_id=w.id and a.org_id=w.org_id and a.unlinked_at is null
  join order_lines l on l.id=a.order_line_id
  where w.package_id=t.package_id and w.org_id=o.org_id and l.order_id=o.id
))`;
export const staffOrderFilters=z.object({
  query:z.string().trim().max(254).default(""),
  state:z.enum(["draft","awaiting_payment","awaiting_samples","samples_ready","queued","inspecting","qa_review",
    "report_ready","action_pending","closed","on_hold","cancelled"]).optional(),
  exception:z.enum(["all","1"]).default("all"),
  from:z.iso.date().optional(),to:z.iso.date().optional(),
  test:z.enum(["all","production","test"]).default("all"),
  limit:z.coerce.number().int().min(1).max(100).default(50),
  cursor:z.string().regex(/^[A-Za-z0-9_-]+$/).max(512).optional(),
}).refine(v=>!v.from||!v.to||v.from<=v.to,{message:"The end date must be on or after the start date."});
const staffOrderCursor=z.object({at:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
  id:z.uuid(),filter:z.string().length(64)});
export async function searchStaffOrders(db:DB,actor:Actor,filters:z.infer<typeof staffOrderFilters>) {
  role(actor,...staffAccess.orders);
  const {query,state,exception,from,to,test,limit,cursor}=filters;
  const trimmed=query.trim();
  const isTaggedCode=/@(QCW-?[A-Z0-9]{4,12}|\d{5,8})@/i.test(trimmed);
  const key=trimmed?(isTaggedCode?extractReceivingCode(trimmed):trimmed.includes("@")?z.email().parse(trimmed.toLowerCase()):waybill(trimmed)):"";
  const filter=hash(JSON.stringify({key,state,exception,from,to,test,limit}));
  let after:z.infer<typeof staffOrderCursor>|undefined;
  if(cursor) {
    let decoded:unknown;
    try {decoded=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));}
    catch {guard(false,"INVALID_CURSOR","Reload the order search.",422);}
    after=staffOrderCursor.parse(decoded);
    guard(after.filter===filter,"INVALID_CURSOR","Restart pagination after changing search filters.",422);
  }
  const {rows}=await db.query(`select o.id,o.public_no,o.state,o.revision,o.created_at,o.updated_at,o.paid_at,o.sla_due_at,
    o.report_published_at,o.hold_reason,o.price_cents,o.is_test,
    crp.user_id customer_user_id,crp.receiving_code,u.display_name customer_name,
    (select so.title->>'zh-CN' from order_lines l join service_offers so on so.id=l.offer_id where l.order_id=o.id order by l.id limit 1) service_title,
    (select st.code from order_lines l join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id where l.order_id=o.id order by l.id limit 1) service_code,
    (select cat.labels->>'zh-CN' from order_lines l join categories cat on cat.id=l.category_id where l.order_id=o.id order by l.id limit 1) category_label,
    (select coalesce(sum(case when jsonb_typeof(l.attributes->'expected_lines')='array' and jsonb_array_length(l.attributes->'expected_lines')>0
      then jsonb_array_length(l.attributes->'expected_lines') else 1 end),0)::int from order_lines l where l.order_id=o.id) sku_count,
    (select coalesce(sum(l.quantity),0)::int from order_lines l where l.order_id=o.id) expected_units,
    (select count(*)::int from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
      join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null where l.order_id=o.id) identified_units,
    (select count(*)::int from advice_orders ao where ao.order_id=o.id and ao.org_id=o.org_id) parcel_count,
    (select count(*)::int from advice_orders ao join tracking_records tr on tr.advice_id=ao.advice_id and tr.closed_at is null and tr.direction='inbound'
      join packages pkg on pkg.id=tr.package_id and pkg.received_at is not null and pkg.state<>'quarantined' where ao.order_id=o.id and ao.org_id=o.org_id) arrived_parcel_count,
    coalesce((select sum(coalesce((select count(*)::int from warehouse_items wi where wi.package_id=pkg.id and wi.parent_item_id is null),pkg.received_quantity,0))::int
      from advice_orders ao join tracking_records tr on tr.advice_id=ao.advice_id and tr.closed_at is null and tr.direction='inbound'
      join packages pkg on pkg.id=tr.package_id and pkg.received_at is not null and pkg.state<>'quarantined' where ao.order_id=o.id and ao.org_id=o.org_id),0) arrived_units,
    (select count(*)::int from inspection_tasks it join order_lines l on l.id=it.order_line_id
      where l.order_id=o.id and it.state='QA_APPROVED') qa_approved_tasks,
    (select count(*)::int from inspection_tasks it join order_lines l on l.id=it.order_line_id
      where l.order_id=o.id and it.state<>'VOID') total_tasks,
    (select count(*)::int from order_blocks ob where ob.order_id=o.id and ob.resolved_at is null) open_block_count,
    (select count(*)::int from tickets k where k.order_id=o.id and k.state in ('open','waiting_customer','waiting_internal')) open_ticket_count,
    (select rp.published_version from reports rp where rp.order_id=o.id limit 1) report_version,
    nullif(inspection_payment.state,'not_due') payment_state,
    to_char(o.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time
    from orders o
    left join customer_receiving_profiles crp on crp.org_id=o.org_id
    left join users u on u.id=crp.user_id
    ${inspectionPaymentForOrder}
    where ($1='' or o.public_no=$1 or replace(upper(o.public_no),'-','')=replace($1,'-','') or upper(coalesce(crp.receiving_code,''))=$1 or replace(upper(coalesce(crp.receiving_code,'')),'-','')=replace($1,'-','') or exists(
      select 1 from tracking_records t where t.tracking_norm=$1 and t.direction='inbound'
      and t.closed_at is null and ${inboundBelongsToOrder}
    ) or exists(
      select 1 from order_lines l join order_line_item_links a on a.order_line_id=l.id and a.org_id=o.org_id
      join warehouse_items w on w.id=a.item_id and w.org_id=a.org_id
      where l.order_id=o.id and (upper(w.code)=$1 or replace(upper(w.code),'-','')=replace($1,'-','')) and a.unlinked_at is null
    ) or exists(select 1 from memberships m join user_emails e on e.user_id=m.user_id
      where m.org_id=o.org_id and e.normalized_email=$1 and e.verified_at is not null))
    and ($2::text is null or o.state=$2)
    and ($3='all' or (
      o.state='on_hold' or
      (o.sla_due_at is not null and o.sla_due_at<=now() and o.state in ('queued','inspecting','qa_review')) or
      exists(select 1 from order_blocks ob where ob.order_id=o.id and ob.resolved_at is null) or
      exists(select 1 from tickets k where k.order_id=o.id and k.state in ('open','waiting_customer','waiting_internal'))
    ))
    and ($4::date is null or o.created_at>=($4::date)::timestamp at time zone 'UTC')
    and ($5::date is null or o.created_at<($5::date+1)::timestamp at time zone 'UTC')
    and ($6='all' or o.is_test=($6='test'))
    and ($7::timestamptz is null or (o.created_at,o.id)<($7::timestamptz,$8::uuid))
    order by o.created_at desc,o.id desc limit $9`,[key,state??null,exception,from??null,to??null,test,after?.at??null,after?.id??null,limit+1]);
  const page=rows.slice(0,limit),last=page.at(-1);
  return {rows:page.map(({cursor_time,...row})=>row),
    next_cursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.cursor_time,id:last.id,filter})).toString("base64url"):null};
}
export async function staffOrderDetail(db:DB,actor:Actor,publicNo:string) {
  role(actor,...staffAccess.orders);
  const order=await one<Parameters<typeof orderDTO>[0]&{org_id:string;created_at:Date;updated_at:Date|null;paid_at:Date|null;samples_ready_at:Date|null;
    sla_due_at:Date|null;report_published_at:Date|null;closed_at:Date|null;held_at:Date|null;held_from_state:string|null;hold_reason:string|null;
    price_cents:number|null;currency:string|null;customer_notes:string|null;is_test:boolean}>(
    db,
    `select id,org_id,public_no,state,revision,created_at,updated_at,paid_at,samples_ready_at,sla_due_at,
            report_published_at,closed_at,held_at,held_from_state,hold_reason,price_cents,currency,customer_notes,coalesce(is_test,false) is_test
     from orders where replace(upper(public_no),'-','')=replace(upper($1),'-','')`,
    [publicNo]
  );
  const {id,org_id}=order;
  const {rows:lines}=await db.query(`select l.id,l.offer_id,l.category_id,l.template_version_id,l.quantity,l.options,l.attributes,l.draft_items,
    s.title,s.sku_code,st.code service_code,cat.labels category_labels,
    (select count(*)::int from expected_items e where e.order_line_id=l.id and e.in_scope) current_positions
    from order_lines l join service_offers s on s.id=l.offer_id join service_types st on st.id=s.service_type_id
    join categories cat on cat.id=l.category_id where l.order_id=$1 order by l.id`,[id]);
  const {rows:expectedRows}=await db.query(`select e.id,e.position,e.declared_fields,e.in_scope,l.id as order_line_id,l.quantity,so.title,st.code service,
    w.id item_id,w.code,w.identity_state,w.condition_state,w.custody_state,w.storage_until,pkg.code package_code,loc.code location,
    ${itemInspectionStageSql} inspection_stage,
    ${itemHandlingHoldSql} handling_hold,
    (select d.action||':'||d.state from disposition_requests d where d.item_id=w.id and d.org_id=w.org_id and d.state not in ('completed','cancelled') order by d.revision desc limit 1) active_disposition,
    (select r.state from reference_samples r where r.item_id=w.id and r.org_id=w.org_id order by r.revision desc limit 1) reference_sample_state
    from order_lines l join service_offers so on so.id=l.offer_id join service_types st on st.id=so.service_type_id
    left join expected_items e on e.order_line_id=l.id and e.in_scope
    left join order_line_item_links a on a.expected_item_id=e.id and a.unlinked_at is null
    left join warehouse_items w on w.id=a.item_id and w.org_id=l.org_id
    left join packages pkg on pkg.id=w.package_id
    left join storage_locations loc on loc.id=w.location_id
    where l.order_id=$1 order by l.id,e.position`,[id]);
  const items=expectedRows.filter(r=>Boolean(r.code));
  const {rows:parcels}=await db.query(`select t.tracking_norm,t.carrier_code,c.labels->>'zh-CN' carrier_name,
    t.transport_state,t.sync_state,t.advice_id as id,p.id package_id,p.code,p.state custody,p.state warehouse_state,
    p.received_at,p.weight_g,p.received_quantity,p.condition_note,
    substring(p.condition_note from '^\\[outer:(intact|crushed|torn|wet)\\]') outer_condition,
    (select count(*)::int from warehouse_items wi where wi.package_id=p.id and wi.parent_item_id is null) logged_item_count,
    (select count(*)::int from warehouse_items wi join order_line_item_links olil on olil.item_id=wi.id and olil.unlinked_at is null
      join order_lines ol on ol.id=olil.order_line_id where wi.package_id=p.id and wi.parent_item_id is null and ol.order_id=$1) identified_item_count,
    (select count(*)::int from warehouse_items wi where wi.package_id=p.id and wi.parent_item_id is null and wi.condition_state not in ('good','unchecked')) damaged_item_count,
    coalesce((select array_agg(wi.code order by wi.code) from warehouse_items wi where wi.package_id=p.id and wi.parent_item_id is null),array[]::text[]) item_codes,
    coalesce(array(select m.id from media_assets m where m.package_id=p.id and m.kind in ('intake_outer','intake_open') and m.status='ready' order by m.captured_at),array[]::uuid[]) media_ids
    from orders o join tracking_records t on t.org_id=o.org_id and t.direction='inbound' and t.closed_at is null
    left join packages p on p.id=t.package_id and p.org_id=o.org_id
    left join carriers c on c.code=t.carrier_code
    where o.id=$1 and ${inboundBelongsToOrder} order by t.tracking_norm`,[id]);
  const expected_lines_summary=summarizeExpectedLines(lines,expectedRows,parcels);
  const {rows:tasks}=await db.query(`select t.id,t.state,t.revision,t.assignee_id,u.display_name assignee_name,
    tv.template_key,tv.version template_version,w.code item_code,t.group_id is not null is_group_task,
    (select count(*)::int from inspection_results ir where ir.task_id=t.id) result_count,
    (select count(*)::int from task_evidence te where te.task_id=t.id) evidence_count
    from inspection_tasks t join order_lines l on l.id=t.order_line_id
    join template_versions tv on tv.id=t.template_version_id
    left join users u on u.id=t.assignee_id
    left join order_line_item_links a on a.id=t.assignment_id
    left join warehouse_items w on w.id=a.item_id
    where l.order_id=$1 and t.state<>'VOID' order by l.id,w.code nulls last,t.id`,[id]);
  const {rows:reports}=await db.query(`select r.id report_id,r.public_no report_no,r.published_version,
    v.id version_id,v.version,v.state,v.amend_reason,v.created_at,v.reviewed_at,v.published_at,
    cu.display_name created_by_name,ru.display_name reviewed_by_name
    from reports r join report_versions v on v.report_id=r.id
    left join users cu on cu.id=v.created_by left join users ru on ru.id=v.reviewed_by
    where r.order_id=$1 order by v.version desc`,[id]);
  const {rows:quotes}=await db.query(`select id,revision,amount_cents,currency,expires_at,accepted_at
    from inspection_quotes where order_id=$1 order by revision desc`,[id]);
  const {rows:charges}=await db.query(`select c.id,c.purpose,c.amount_cents,c.currency,c.voided_at,c.applied_payment_id,
    c.scope_revision_id,c.free_authorization,iq.revision quote_revision,iq.expires_at
    from charge_items c left join inspection_quotes iq on iq.id=c.inspection_quote_id
    where c.org_id=$2 and (iq.order_id=$1 or exists(select 1 from charge_allocations ca where ca.charge_id=c.id and ca.order_id=$1))
    order by c.voided_at nulls first,c.id desc`,[id,org_id]);
  const {rows:payments}=await db.query(`select distinct on (p.id) p.id,p.charge_item_id,c.purpose,p.amount_cents,p.currency,
    p.state,p.provider,p.provider_ref,p.created_at,p.updated_at,
    coalesce((select sum(r.amount_cents)::int from refunds r where r.payment_id=p.id and r.state='succeeded'),0) refunded_cents
    from charge_items c join payments p on p.charge_item_id=c.id
    left join inspection_quotes iq on iq.id=c.inspection_quote_id
    where c.org_id=$2 and (iq.order_id=$1 or exists(select 1 from charge_allocations ca where ca.charge_id=c.id and ca.order_id=$1))
    order by p.id,p.created_at desc`,[id,org_id]);
  const {rows:refunds}=await db.query(`select r.id,r.payment_id,r.amount_cents,r.reason,r.state,r.source,r.provider_ref,r.created_at,
    ru.display_name requested_by_name,au.display_name approved_by_name
    from refunds r join payments p on p.id=r.payment_id join charge_items c on c.id=p.charge_item_id
    left join inspection_quotes iq on iq.id=c.inspection_quote_id
    left join users ru on ru.id=r.requested_by left join users au on au.id=r.approved_by
    where c.org_id=$2 and (iq.order_id=$1 or exists(select 1 from charge_allocations ca where ca.charge_id=c.id and ca.order_id=$1))
    order by r.created_at desc`,[id,org_id]);
  const {rows:dispositions}=await db.query(`select d.id,d.action,d.state,d.destination,d.return_info,w.code item_code,
    bi.batch_id,db.state batch_state
    from order_lines l join order_line_item_links a on a.order_line_id=l.id and a.org_id=$2 and a.unlinked_at is null
    join warehouse_items w on w.id=a.item_id
    join disposition_requests d on d.item_id=w.id and d.org_id=$2
    left join dispatch_batch_items bi on bi.disposition_id=d.id and bi.released_at is null
    left join dispatch_batches db on db.id=bi.batch_id
    where l.order_id=$1 order by w.code,d.revision desc`,[id,org_id]);
  const {rows:tickets}=await db.query(`select k.id,k.public_no,k.category,k.subject,k.state,k.created_at,k.next_action_at,u.display_name assignee_name
    from tickets k left join users u on u.id=k.assignee_id where k.order_id=$1 and k.org_id=$2
    order by k.created_at desc,k.id limit 100`,[id,org_id]);
  const {rows:blocks}=await db.query(`select reason,opened_at,resolved_at from order_blocks
    where order_id=$1 order by opened_at desc,id`,[id]);
  const {rows:activity}=await db.query(`select a.id,a.at,a.actor_type,a.action,u.display_name
    from audit_events a left join users u on u.id=a.actor_id where a.entity_type='orders' and a.entity_id=$1
    order by a.at desc,a.id desc limit 100`,[id]);
  const customer=(await db.query(`select u.id,u.display_name,u.status,p.org_id,p.receiving_code,e.normalized_email::text as email
    from customer_receiving_profiles p join users u on u.id=p.user_id left join user_emails e on e.user_id=u.id and e.is_primary
    where p.org_id=$1 limit 1`,[org_id])).rows[0]??null;
  const shipments=(await orderShipments(db,id,org_id)).map(({id:shipment_id,batch_id,carrier_code,state,tracking_norm,shipped_at,action})=>({id:shipment_id,batch_id,carrier_code,state,tracking_norm,shipped_at,action}));
  return {order:orderDTO(order),is_test:order.is_test,price_cents:order.price_cents,currency:order.currency??"USD",
    customer_notes:order.customer_notes??null,held_at:order.held_at,held_from_state:order.held_from_state,hold_reason:order.hold_reason,
    created_at:order.created_at,updated_at:order.updated_at,paid_at:order.paid_at,
    samples_ready_at:order.samples_ready_at,sla_due_at:order.sla_due_at,report_published_at:order.report_published_at,closed_at:order.closed_at,
    customer,lines,items,expected_lines_summary,parcels,tasks,reports,quotes,charges,
    payments:payments.map(p=>({...p,display_ref:`PAY-${String(p.id).replace(/-/g,"").slice(0,8).toUpperCase()}`})),
    refunds:refunds.map(r=>({...r,display_ref:`RFD-${String(r.id).replace(/-/g,"").slice(0,8).toUpperCase()}`})),
    dispositions,tickets,blocks,activity,shipments,operation_notes:await orderOperationNotes(db,id)};
}

export async function reconcileFinance(db:DB,actor:Actor,includeTest=true,filters?:{query:string;purpose:string;page?:number}) {
  role(actor,...staffAccess.finance);
  type ChargeRow={
    charge_item_id:string;purpose:string;amount_cents:number;currency:string;
    state:string;paid_cents:number;refunded_cents:number;pending_refund_cents:number;batch_id:string|null;
    inspection_order_id:string|null;inspection_order_no:string|null;is_test:boolean;
    receiving_code:string|null;applied_payment_id:string|null;
    allocations:{order_id:string;public_no:string;amount_cents:number}[];
    balance_cents:number;
  };
  const limit=filters?.page?50:400;
  const result=await one<{summary:{
    inspection_paid_cents:number;dispatch_paid_cents:number;storage_paid_cents:number;paid_cents:number;
    refunded_cents:number;pending_refund_cents:number;unallocated_dispatch_cents:number;all_balanced:boolean
  };rows:ChargeRow[]}>(db,
    `with charges as (
      select c.id charge_item_id,c.purpose,c.amount_cents,c.currency,
            case when c.voided_at is not null then 'void'
                 when c.applied_payment_id is not null or c.free_authorization is not null then 'paid'
                 else 'open' end state,
            coalesce(cash.paid_cents,0)::int paid_cents,
            coalesce(refunds.succeeded_cents,0)::int refunded_cents,
            coalesce(refunds.pending_cents,0)::int pending_refund_cents,
            dq.batch_id,
            iq.order_id inspection_order_id,
            io.public_no inspection_order_no,
            coalesce(io.is_test,false) is_test,
            crp.receiving_code,
            c.applied_payment_id,
            coalesce(iq.accepted_at,dq.accepted_at,sq.accepted_at) posted_at,
            case when c.purpose='inspection' then 0 else c.amount_cents-coalesce(alloc.total,0) end balance_cents,
            coalesce(alloc.rows,'[]'::jsonb) allocations
     from charge_items c
     left join customer_receiving_profiles crp on crp.org_id=c.org_id
     left join inspection_quotes iq on iq.id=c.inspection_quote_id
     left join orders io on io.id=iq.order_id
     left join dispatch_quote_versions dq on dq.id=c.dispatch_quote_id
     left join storage_quotes sq on sq.id=c.storage_quote_id
    left join lateral(
      select sum(${paymentGrossCents}) paid_cents from payments p
      where p.charge_item_id=c.id and p.state in ('succeeded','partially_refunded','refunded')
    ) cash on true
    left join lateral(
      select sum(r.amount_cents) filter(where r.state='succeeded') succeeded_cents,
             sum(r.amount_cents) filter(where r.state='approved') pending_cents
      from refunds r join payments p on p.id=r.payment_id where p.charge_item_id=c.id
    ) refunds on true
    left join lateral(
      select sum(a.amount_cents) total,
        jsonb_agg(jsonb_build_object('order_id',a.order_id,'public_no',o.public_no,'amount_cents',a.amount_cents)
          order by o.public_no) rows
      from charge_allocations a join orders o on o.id=a.order_id where a.charge_id=c.id
    ) alloc on true
     where ($1::boolean or not (coalesce(io.is_test,false) or exists(
       select 1 from payments p where p.charge_item_id=c.id and
       (p.provider_ref ~ '^(demo_|cs_test_)'
        or p.provider_data->>'checkout_mode'='test' or p.provider<>'stripe' and p.environment='sandbox')
     )))
    ), page as (
      select x.* from charges x
      where ($2::text='all' or x.purpose=$2) and ($3::text='' or
        strpos(upper(coalesce(x.receiving_code,'')),$3)>0 or strpos(upper(coalesce(x.inspection_order_no,'')),$3)>0
        or exists(select 1 from jsonb_array_elements(x.allocations) a where strpos(upper(a->>'public_no'),$3)>0))
      order by posted_at desc nulls last,charge_item_id desc limit $4 offset $5
    ) select (select jsonb_build_object(
      'inspection_paid_cents',coalesce(sum(paid_cents) filter(where purpose='inspection'),0),
      'dispatch_paid_cents',coalesce(sum(paid_cents) filter(where purpose='dispatch'),0),
      'storage_paid_cents',coalesce(sum(paid_cents) filter(where purpose='storage'),0),
      'paid_cents',coalesce(sum(paid_cents),0),
      'refunded_cents',coalesce(sum(refunded_cents),0),
      'pending_refund_cents',coalesce(sum(pending_refund_cents),0),
      'unallocated_dispatch_cents',coalesce(sum(balance_cents) filter(where purpose='dispatch' and state='paid'),0),
      'all_balanced',coalesce(bool_and(balance_cents>=0),true)
    ) from charges) summary,
    (select coalesce(jsonb_agg(page order by posted_at desc nulls last,charge_item_id desc),'[]'::jsonb) from page) rows`,
    [includeTest,filters?.purpose??"all",filters?.query.toUpperCase()??"",limit+1,((filters?.page??1)-1)*limit]
  );

  const items=result.rows.slice(0,limit).map(r=>{
    const allocs=r.purpose==="inspection" && r.inspection_order_id && r.inspection_order_no
      ?[{order_id:r.inspection_order_id,public_no:r.inspection_order_no,amount_cents:r.amount_cents}]
      :(r.allocations??[]);
    const allocatedCents=r.amount_cents-r.balance_cents;
    const netCents=r.paid_cents-r.refunded_cents;
    return {
      charge_id:r.charge_item_id,
      charge_item_id:r.charge_item_id,
      purpose:r.purpose,
      order_public_no:r.inspection_order_no,
      receiving_code:r.receiving_code??null,
      payment_id:r.applied_payment_id??null,
      payment_display_ref:r.applied_payment_id?`PAY-${r.applied_payment_id.replace(/-/g,"").slice(0,8).toUpperCase()}`:null,
      amount_cents:r.amount_cents,
      currency:r.currency,
      state:r.state,
      paid_cents:r.paid_cents,
      refunded_cents:r.refunded_cents,
      pending_refund_cents:r.pending_refund_cents,
      net_cents:netCents,
      batch_id:r.batch_id,
      allocations:allocs,
      allocated_cents:allocatedCents,
      unallocated_cents:r.balance_cents,
      allocation_balanced:r.balance_cents>=0,
    };
  });

  const netReceived=result.summary.paid_cents-result.summary.refunded_cents;
  const summary={
    ...result.summary,
    inspection_cents:result.summary.inspection_paid_cents,
    dispatch_cents:result.summary.dispatch_paid_cents,
    storage_cents:result.summary.storage_paid_cents,
    net_cents:netReceived,
    net_received_cents:netReceived,
  };

  return {summary,rows:items,has_more:result.rows.length>limit};
}

export async function orderLedger(db:DB,actor:Actor,opts:{includeTest?:boolean;limit?:number}={}) {
  role(actor,...staffAccess.finance);
  const includeTest=opts.includeTest===true;
  const limit=Math.min(Math.max(opts.limit??30,1),200);
  const hourlyLaborCents=1500;

  const {rows:orderRows}=await db.query<{
    id:string;
    public_no:string;
    state:string;
    is_test:boolean;
    created_at:string;
    receiving_code:string|null;
    price_cents:number|null;
    category_slugs:string[];
    service_codes:string[];
    sample_count:number;
    inspection_paid_cents:number;
    inspection_refunded_cents:number;
    pass_through_shipping_cents:number;
    storage_allocated_cents:number;
    inspection_seconds:number;
    provider_refs:string[];
    anomaly_count:number;
    channel_fee_cents:number;
    stripe_settlement_pending_count:number;
  }>(
    `select o.id,
            o.public_no,
            o.state,
            coalesce(o.is_test,false) is_test,
            o.created_at,
            (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=o.org_id limit 1) receiving_code,
            o.price_cents,
            coalesce(array(
              select distinct cat.slug from order_lines ol join categories cat on cat.id=ol.category_id where ol.order_id=o.id order by cat.slug
            ), array[]::text[]) category_slugs,
            coalesce(array(
              select distinct st.code from order_lines ol join service_offers so on so.id=ol.offer_id join service_types st on st.id=so.service_type_id where ol.order_id=o.id order by st.code
            ), array[]::text[]) service_codes,
            coalesce((select sum(ol.quantity)::int from order_lines ol where ol.order_id=o.id),0)::int sample_count,
            coalesce((
              select sum(${paymentGrossCents})::int
              from inspection_quotes iq
              join charge_items c on c.inspection_quote_id=iq.id and c.purpose='inspection' and c.voided_at is null
              join payments p on p.id=c.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')
              where iq.order_id=o.id
            ),0)::int inspection_paid_cents,
            coalesce((
              select sum(r.amount_cents)::int
              from inspection_quotes iq
              join charge_items c on c.inspection_quote_id=iq.id and c.purpose='inspection'
              join payments p on p.id=c.applied_payment_id
              join refunds r on r.payment_id=p.id and r.state='succeeded'
              where iq.order_id=o.id
            ),0)::int inspection_refunded_cents,
            coalesce((
              select sum(ca.amount_cents)::int
              from charge_allocations ca
              join charge_items c on c.id=ca.charge_id and c.purpose='dispatch' and c.voided_at is null
              join payments p on p.id=c.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')
              where ca.order_id=o.id
            ),0)::int pass_through_shipping_cents,
            coalesce((
              select sum(ca.amount_cents)::int
              from charge_allocations ca
              join charge_items c on c.id=ca.charge_id and c.purpose='storage' and c.voided_at is null
              join payments p on p.id=c.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')
              where ca.order_id=o.id
            ),0)::int storage_allocated_cents,
            coalesce((
              select sum(coalesce(st_row.seconds,0))::int
              from step_timings st_row
              where st_row.order_id=o.id
            ),0)::int inspection_seconds,
            coalesce(array(
              select distinct ref from (
                select p.provider_ref as ref
                from inspection_quotes iq
                join charge_items c on c.inspection_quote_id=iq.id
                join payments p on p.charge_item_id=c.id
                where iq.order_id=o.id and p.provider_ref is not null
                union
                select r.provider_ref as ref
                from inspection_quotes iq
                join charge_items c on c.inspection_quote_id=iq.id
                join payments p on p.charge_item_id=c.id
                join refunds r on r.payment_id=p.id
                where iq.order_id=o.id and r.provider_ref is not null
                union
                select p.provider_ref as ref
                from charge_allocations ca
                join charge_items c on c.id=ca.charge_id
                join payments p on p.charge_item_id=c.id
                where ca.order_id=o.id and p.provider_ref is not null
              ) refs where ref is not null and ref<>'' order by ref
            ), array[]::text[]) provider_refs,
            coalesce((
              select count(*)::int
              from inspection_quotes iq
              join charge_items c on c.inspection_quote_id=iq.id
              join payments p on p.charge_item_id=c.id
              where iq.order_id=o.id and p.state in ('amount_mismatch','disputed','late_payment')
            ),0)::int anomaly_count,
            fees.channel_fee_cents,fees.stripe_settlement_pending_count
     from orders o
     left join lateral(
       select coalesce(sum(
         round(cost.usd_cents*a.allocated_through/nullif(a.amount_cents,0))-
         round(cost.usd_cents*(a.allocated_through-a.allocated_here)/nullif(a.amount_cents,0))
       ),0)::int channel_fee_cents,
       count(*) filter(where p.provider='stripe' and p.provider_ref ~ '^cs_(test|live)_'
         and coalesce(p.provider_data->>'demo','false')<>'true' and s.settled_at is null)::int stripe_settlement_pending_count
       from (
         select c.applied_payment_id,c.amount_cents,c.amount_cents allocated_here,c.amount_cents allocated_through
         from inspection_quotes q join charge_items c on c.inspection_quote_id=q.id and c.voided_at is null
         where q.order_id=o.id
         union all
         select c.applied_payment_id,c.amount_cents,ca.amount_cents,
           (select sum(prior.amount_cents) from charge_allocations prior where prior.charge_id=c.id and prior.order_id<=o.id)
         from charge_allocations ca join charge_items c on c.id=ca.charge_id and c.voided_at is null
         where ca.order_id=o.id and c.purpose in ('storage','dispatch')
       ) a join payments p on p.id=a.applied_payment_id and p.state in ('succeeded','partially_refunded','refunded')
       left join lateral(
         select s.* from payment_settlements s where s.payment_id=p.id
         order by s.settled_at desc nulls last,s.provider_transaction_id limit 1
       ) s on true
       cross join lateral(select case when upper(s.currency)='USD' then s.fee_minor::numeric
         when s.exchange_rate>0 then round(s.fee_minor/s.exchange_rate) end usd_cents) cost
     ) fees on true
     where ($1::boolean or coalesce(o.is_test,false)=false)
       and o.state<>'draft'
     order by o.created_at desc,o.id desc
     limit $2`,
    [includeTest,limit]
  );

  const orders=orderRows.map(r=>{
    const netInspectionCents=r.inspection_paid_cents-r.inspection_refunded_cents;
    const laborCostCents=Math.round((r.inspection_seconds/3600)*hourlyLaborCents);
    const contributionCents=netInspectionCents+r.storage_allocated_cents-laborCostCents-r.channel_fee_cents;
    const hasPaid=r.inspection_paid_cents>0||r.pass_through_shipping_cents>0||r.storage_allocated_cents>0;
    const channelReconciled=r.anomaly_count===0&&(!hasPaid||r.provider_refs.length>0);
    return {
      order_id:r.id,
      public_no:r.public_no,
      state:r.state,
      is_test:r.is_test,
      created_at:r.created_at,
      receiving_code:r.receiving_code??null,
      receivable_cents:r.price_cents??null,
      category_slug:r.category_slugs[0]??"apparel",
      category_slugs:r.category_slugs,
      service_code:r.service_codes[0]??"std",
      service_codes:r.service_codes,
      sample_count:r.sample_count,
      inspection_paid_cents:r.inspection_paid_cents,
      inspection_refunded_cents:r.inspection_refunded_cents,
      net_inspection_cents:netInspectionCents,
      pass_through_shipping_cents:r.pass_through_shipping_cents,
      storage_allocated_cents:r.storage_allocated_cents,
      inspection_seconds:r.inspection_seconds,
      inspection_minutes:Number((r.inspection_seconds/60).toFixed(2)),
      labor_cost_cents:laborCostCents,
      labor_cost_estimated:true,
      channel_fee_cents:r.channel_fee_cents,
      stripe_settlement_pending_count:r.stripe_settlement_pending_count,
      contribution_cents:contributionCents,
      provider_refs:r.provider_refs,
      channel_reconciled:channelReconciled,
    };
  });

  const groupMap=new Map<string,{
    category_slug:string;
    service_code:string;
    order_count:number;
    sample_count:number;
    inspection_seconds:number;
    net_inspection_cents:number;
    labor_cost_cents:number;
    channel_fee_cents:number;
    contribution_cents:number;
  }>();
  for(const row of orders) {
    const key=`${row.category_slug}:${row.service_code}`;
    const cur=groupMap.get(key)??{
      category_slug:row.category_slug,
      service_code:row.service_code,
      order_count:0,
      sample_count:0,
      inspection_seconds:0,
      net_inspection_cents:0,
      labor_cost_cents:0,
      channel_fee_cents:0,
      contribution_cents:0,
    };
    cur.order_count+=1;
    cur.sample_count+=row.sample_count;
    cur.inspection_seconds+=row.inspection_seconds;
    cur.net_inspection_cents+=row.net_inspection_cents;
    cur.labor_cost_cents+=row.labor_cost_cents;
    cur.channel_fee_cents+=row.channel_fee_cents;
    cur.contribution_cents+=row.contribution_cents;
    groupMap.set(key,cur);
  }
  const byCategoryService=[...groupMap.values()].map(g=>({
    ...g,
    avg_seconds_per_sample:g.sample_count>0?Math.round(g.inspection_seconds/g.sample_count):0,
  }));

  const sumInspectionPaid=orders.reduce((n,r)=>n+r.inspection_paid_cents,0);
  const sumInspectionRefunded=orders.reduce((n,r)=>n+r.inspection_refunded_cents,0);
  const sumNetInspection=orders.reduce((n,r)=>n+r.net_inspection_cents,0);
  const sumPassThroughShipping=orders.reduce((n,r)=>n+r.pass_through_shipping_cents,0);
  const sumStorageAllocated=orders.reduce((n,r)=>n+r.storage_allocated_cents,0);
  const sumInspectionSeconds=orders.reduce((n,r)=>n+r.inspection_seconds,0);
  const sumLaborCost=orders.reduce((n,r)=>n+r.labor_cost_cents,0);
  const sumChannelFee=orders.reduce((n,r)=>n+r.channel_fee_cents,0);
  const sumContribution=orders.reduce((n,r)=>n+r.contribution_cents,0);

  const summary={
    include_test:includeTest,
    limit,
    order_count:orders.length,
    hourly_labor_cents:hourlyLaborCents,
    labor_cost_estimated:true,
    inspection_paid_cents:sumInspectionPaid,
    inspection_refunded_cents:sumInspectionRefunded,
    net_inspection_cents:sumNetInspection,
    pass_through_shipping_cents:sumPassThroughShipping,
    storage_allocated_cents:sumStorageAllocated,
    total_inspection_seconds:sumInspectionSeconds,
    total_labor_cost_cents:sumLaborCost,
    channel_fee_cents:sumChannelFee,
    orders_pending_stripe_settlement:orders.filter(r=>r.stripe_settlement_pending_count>0).length,
    total_contribution_cents:sumContribution,
    recomputable_balanced:
      sumNetInspection===sumInspectionPaid-sumInspectionRefunded &&
      sumContribution===sumNetInspection+sumStorageAllocated-sumLaborCost-sumChannelFee,
    all_channel_reconciled:orders.every(r=>r.channel_reconciled),
  };

  return {summary,orders,by_category_service:byCategoryService};
}

function csvCell(value:unknown) {
  const s=String(value??"");
  return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}

export async function orderLedgerCsv(db:DB,actor:Actor,opts:{includeTest?:boolean;limit?:number}={}) {
  const ledger=await orderLedger(db,actor,opts);
  const headers=[
    "public_no",
    "state",
    "is_test",
    "category_slug",
    "service_code",
    "sample_count",
    "inspection_paid_cents",
    "inspection_refunded_cents",
    "net_inspection_cents",
    "pass_through_shipping_cents",
    "storage_allocated_cents",
    "inspection_seconds",
    "labor_cost_cents",
    "contribution_cents",
    "channel_reconciled",
    "provider_refs",
    "channel_fee_cents",
    "pending_stripe_settlement",
  ];
  const lines=[headers.join(",")];
  for(const r of ledger.orders) {
    lines.push([
      r.public_no,
      r.state,
      r.is_test?"1":"0",
      r.category_slug,
      r.service_code,
      r.sample_count,
      r.inspection_paid_cents,
      r.inspection_refunded_cents,
      r.net_inspection_cents,
      r.pass_through_shipping_cents,
      r.storage_allocated_cents,
      r.inspection_seconds,
      r.labor_cost_cents,
      r.contribution_cents,
      r.channel_reconciled?"1":"0",
      r.provider_refs.join("|"),
      r.channel_fee_cents,
      r.stripe_settlement_pending_count>0?"1":"0",
    ].map(csvCell).join(","));
  }
  const s=ledger.summary;
  lines.push([
    "SUMMARY",
    "TOTAL",
    s.include_test?"1":"0",
    "ALL",
    "ALL",
    ledger.orders.reduce((n,r)=>n+r.sample_count,0),
    s.inspection_paid_cents,
    s.inspection_refunded_cents,
    s.net_inspection_cents,
    s.pass_through_shipping_cents,
    s.storage_allocated_cents,
    s.total_inspection_seconds,
    s.total_labor_cost_cents,
    s.total_contribution_cents,
    s.all_channel_reconciled?"1":"0",
    "",
    s.channel_fee_cents,
    s.orders_pending_stripe_settlement,
  ].map(csvCell).join(","));
  return lines.join("\n")+"\n";
}

export async function readStaffObjectSummary(
  db:DB,
  actor:Actor,
  kind:"tracking"|"package"|"item"|"batch",
  ref:string
) {
  const clean=ref.trim();
  const canReadAllStaffMedia=actor.roles.some(r=>["warehouse_admin","super_admin"].includes(r));
  const isReceiver=actor.roles.includes("receiver");
  const isSupport=actor.roles.includes("support");
  const pkgMediaWhere=canReadAllStaffMedia
    ?"package_id=$1 and status='ready' and kind<>'attachment'"
    :isReceiver
      ?"package_id=$1 and status='ready' and (kind in ('intake_outer','intake_open','label_photo') or uploaded_by=$2)"
      :isSupport
        ?"package_id=$1 and status='ready' and ((org_id is null and kind in ('intake_outer','label_photo')) or uploaded_by=$2)"
        :"false";
  const itemMediaWhere=canReadAllStaffMedia
    ?"item_id=$1 and status='ready' and kind<>'attachment'"
    :isReceiver
      ?"item_id=$1 and status='ready' and (kind in ('intake_outer','intake_open','label_photo') or uploaded_by=$2)"
      :isSupport
        ?"item_id=$1 and status='ready' and uploaded_by=$2"
        :"false";
  if(kind==="tracking") {
    role(actor,"warehouse_admin","receiver","support","finance","super_admin");
    const norm=waybill(clean);
    const tracker=(await db.query(
      `select t.id,t.direction,t.tracking_norm,t.carrier_code,t.transport_state,t.sync_state,
              t.latest_event_at,t.last_success_at,t.next_query_at,t.advice_id,t.package_id,t.shipment_id,
              p.code package_code,p.state package_state,p.received_at package_received_at,
              s.batch_id,s.state shipment_state,s.shipped_at,coalesce(s.packed_media_ids,array[]::uuid[]) shipment_media_ids,
              (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=t.org_id limit 1) receiving_code,
              (select coalesce(array_agg(distinct o.public_no order by o.public_no),array[]::text[])
               from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=t.advice_id) order_numbers,
              (select ts.events_json from tracking_snapshots ts where ts.tracker_id=t.id and ts.locale='zh-CN'
               order by ts.latest_event_at desc nulls last,ts.fetched_at desc limit 1) events_zh,
              (select count(*)::int from tracking_events te where te.tracker_id=t.id) event_count,
              (select count(*)::int from tracking_events te join tracking_translations tr on tr.event_id=te.id and tr.locale='en'
               where te.tracker_id=t.id and tr.source not like 'draft:%') published_en_count
       from tracking_records t
       left join packages p on p.id=t.package_id
       left join shipments s on s.id=t.shipment_id
       where t.tracking_norm=$1 and t.closed_at is null
       order by t.generation desc,t.id desc limit 1`,
      [norm]
    )).rows[0];
    guard(tracker,"NOT_FOUND","Tracking record not found.",404);
    const mediaIds=tracker.package_id && (canReadAllStaffMedia||isReceiver||isSupport)
      ?(await db.query<{id:string}>(`select id from media_assets where ${pkgMediaWhere} order by created_at limit 12`,
        canReadAllStaffMedia?[tracker.package_id]:[tracker.package_id,actor.id])).rows.map(r=>r.id)
      :canReadAllStaffMedia && Array.isArray(tracker.shipment_media_ids)
        ?tracker.shipment_media_ids.slice(0,12)
        :[];
    const {shipment_media_ids:_unused,...trackerClean}=tracker;
    return {kind:"tracking",tracker:{...trackerClean,media_ids:mediaIds}};
  }
  if(kind==="package") {
    role(actor,"receiver","warehouse_admin","support","super_admin");
    const isUuid=/^[0-9a-f-]{36}$/i.test(clean);
    const parcel=(await db.query(
      `select p.id,p.code,p.state,p.revision,p.received_quantity,p.received_at,p.weight_g,p.condition_note,
              sl.code location_code,
              (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=p.org_id limit 1) receiving_code,
              t.tracking_norm,t.carrier_code,t.transport_state,t.sync_state,
              (select coalesce(array_agg(distinct o.public_no order by o.public_no),array[]::text[])
               from advice_orders ao join orders o on o.id=ao.order_id where ao.advice_id=p.advice_id) order_numbers
       from packages p
       left join storage_locations sl on sl.id=p.location_id
       left join tracking_records t on t.package_id=p.id and t.direction='inbound' and t.closed_at is null
       where ${isUuid?"p.id=$1":"replace(upper(p.code),'-','')=replace(upper($1),'-','')"} limit 1`,
      [clean]
    )).rows[0];
    guard(parcel,"NOT_FOUND","Parcel not found.",404);
    const pkgItems=(await db.query(
      `select w.id,w.code,w.identity_state,w.condition_state,w.custody_state,sl.code location,o.public_no order_no
       from warehouse_items w
       left join storage_locations sl on sl.id=w.location_id
       left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
       left join order_lines l on l.id=a.order_line_id
       left join orders o on o.id=l.order_id
       where w.package_id=$1 order by w.received_at,w.code limit 100`,
      [parcel.id]
    )).rows;
    const mediaIds=(canReadAllStaffMedia||isReceiver||isSupport)
      ?(await db.query<{id:string}>(`select id from media_assets where ${pkgMediaWhere} order by created_at limit 12`,
        canReadAllStaffMedia?[parcel.id]:[parcel.id,actor.id])).rows.map(r=>r.id)
      :[];
    return {kind:"package",parcel:{...parcel,media_ids:mediaIds},items:pkgItems};
  }
  if(kind==="item") {
    role(actor,"receiver","warehouse_admin","support","super_admin","reviewer");
    const isUuid=/^[0-9a-f-]{36}$/i.test(clean);
    const item=(await db.query(
      `select w.id,w.code,w.revision,w.identity_state,w.condition_state,w.custody_state,w.received_at,w.storage_until,
              p.code package_code,sl.code location,
              (select t.tracking_norm from tracking_records t where t.package_id=p.id and t.direction='inbound' and t.closed_at is null limit 1) inbound_tracking_norm,
              (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=w.org_id limit 1) receiving_code,
              o.public_no order_no,o.state order_state,e.position expected_position,e.declared_fields,
              (select jsonb_build_object('id',d.id,'action',d.action,'state',d.state,'destination',d.destination)
               from disposition_requests d where d.item_id=w.id and d.state not in ('completed','cancelled') order by d.revision desc limit 1) active_disposition,
              (select bi.batch_id from dispatch_batch_items bi where bi.item_id=w.id and bi.released_at is null limit 1) active_batch_id
       from warehouse_items w
       join packages p on p.id=w.package_id
       left join storage_locations sl on sl.id=w.location_id
       left join order_line_item_links a on a.item_id=w.id and a.unlinked_at is null
       left join expected_items e on e.id=a.expected_item_id
       left join order_lines l on l.id=a.order_line_id
       left join orders o on o.id=l.order_id
       where ${isUuid?"w.id=$1":"replace(upper(w.code),'-','')=replace(upper($1),'-','')"} limit 1`,
      [clean]
    )).rows[0];
    guard(item,"NOT_FOUND","Warehouse item not found.",404);
    const events=(await db.query(
      `select se.id,se.action,se.created_at,fl.code from_location,tl.code to_location
       from storage_events se
       left join storage_locations fl on fl.id=se.from_location_id
       left join storage_locations tl on tl.id=se.to_location_id
       where se.item_id=$1 order by se.created_at desc,se.id desc limit 15`,
      [item.id]
    )).rows;
    const mediaIds=(canReadAllStaffMedia||isReceiver||isSupport)
      ?(await db.query<{id:string}>(`select id from media_assets where ${itemMediaWhere} order by created_at limit 12`,
        canReadAllStaffMedia?[item.id]:[item.id,actor.id])).rows.map(r=>r.id)
      :[];
    return {kind:"item",item:{...item,media_ids:mediaIds},events};
  }
  role(actor,"warehouse_admin","support","finance","super_admin");
  const batchId=z.string().uuid().parse(clean);
  const canSeeFinance=actor.roles.some(r=>["finance","super_admin"].includes(r));
  const batch=(await db.query(
    `select b.id,b.revision,b.state,b.action,b.destination_snapshot,
            (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=b.org_id limit 1) receiving_code,
            q.id quote_id,q.revision quote_revision,q.amount_cents,q.expires_at,q.accepted_at,q.snapshot quote_snapshot,
            coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'code',w.code,'custody_state',w.custody_state) order by w.code)
              from dispatch_batch_items bi join warehouse_items w on w.id=bi.item_id
              where bi.batch_id=b.id and bi.released_at is null),'[]'::jsonb) items
     from dispatch_batches b
     left join lateral(select * from dispatch_quote_versions where batch_id=b.id order by revision desc limit 1) q on true
     where b.id=$1`,
    [batchId]
  )).rows[0];
  guard(batch,"NOT_FOUND","Dispatch batch not found.",404);
  const shipments=(await db.query(
    `select s.id,s.state,s.weight_g,s.carrier_code,s.tracking_norm,s.shipped_at,s.returned_at,
            t.transport_state,t.sync_state
     from shipments s
     left join tracking_records t on t.shipment_id=s.id and t.closed_at is null
     where s.batch_id=$1 order by s.shipped_at nulls first,s.id`,
    [batchId]
  )).rows;
  return {
    kind:"batch",
    batch:canSeeFinance
      ?{...batch,financial_restricted:false}
      :{...batch,amount_cents:null,quote_snapshot:null,financial_restricted:true},
    shipments,
  };
}
