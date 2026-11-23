import type { DB } from "../db";
import { guard, one, organization, paymentAwaitingResolution, unresolvedQuotePayment, type Actor } from "./common";
import { latestDispatchQuote, latestStorageQuote } from "./dispatch";

const relatedItems=`select a.item_id,a.linked_at,a.unlinked_at
  from order_line_item_links a join order_lines l on l.id=a.order_line_id
  where l.order_id=$1 and a.org_id=$2`;

export const declaredItemTracking=`upper(regexp_replace(coalesce(e.declared_fields->>'declared_tracking_no',
  e.declared_fields->>'tracking_no',e.declared_fields->>'waybill',e.declared_fields->>'source_tracking_no',''),'[[:space:]]+','','g'))`;

export const inboundParcelOrders=`(select count(*) from advice_orders linked where linked.advice_id=ao.advice_id and linked.org_id=ao.org_id)`;
export const inboundShortageConfirmed=`exists(select 1 from tickets k where k.order_id=ao.order_id and k.org_id=ao.org_id
  and k.category='receipt_mismatch' and k.details->>'package_id'=p.id::text
  and k.details->>'discrepancy_type'='shortage' and k.state not in ('resolved','closed'))`;
export const orderAttributedParcelItems=`left join lateral (
  select count(*)::int logged, count(*) filter(where l.order_id=ao.order_id)::int identified,
    count(*) filter(where wi.condition_state not in ('good','unchecked'))::int damaged,
    coalesce(array_agg(wi.code order by wi.code),array[]::text[]) item_codes
  from warehouse_items wi left join order_line_item_links a on a.item_id=wi.id and a.unlinked_at is null
  left join order_lines l on l.id=a.order_line_id
  where wi.package_id=p.id and wi.org_id=ao.org_id and wi.parent_item_id is null
    and (l.order_id=ao.order_id or (a.id is null and ${inboundParcelOrders}=1))
) attributed on p.id is not null`;

export const orderInboundRegistration=`left join lateral (
  with registered as (
    select t.tracking_norm from advice_orders ao join tracking_records active
      on active.advice_id=ao.advice_id and active.org_id=ao.org_id and active.direction='inbound' and active.closed_at is null
    join tracking_records t on t.advice_id=active.advice_id and t.org_id=active.org_id and t.direction='inbound'
      and (t.id=active.id or t.sync_state='superseded')
    where o.state='awaiting_samples' and ao.order_id=o.id and ao.org_id=o.org_id
    union
    select t.tracking_norm from order_lines l join order_line_item_links a
      on a.order_line_id=l.id and a.org_id=l.org_id and a.unlinked_at is null
    join expected_items assigned on assigned.id=a.expected_item_id and assigned.in_scope
    join warehouse_items w on w.id=a.item_id and w.org_id=a.org_id
    join tracking_records t on t.package_id=w.package_id and t.org_id=w.org_id
      and t.direction='inbound' and t.closed_at is null
    where o.state='awaiting_samples' and l.order_id=o.id and l.org_id=o.org_id
  ), item_pending as (
    select declared.tracking_no,count(*)::int item_count
    from order_lines l join expected_items e on e.order_line_id=l.id and e.in_scope
    cross join lateral (values (${declaredItemTracking})) declared(tracking_no)
    where o.state='awaiting_samples' and l.order_id=o.id and l.org_id=o.org_id
      and declared.tracking_no ~ '^[A-Z0-9-]{5,64}$'
      and not exists(select 1 from order_line_item_links a where a.expected_item_id=e.id and a.org_id=l.org_id and a.unlinked_at is null)
      and not exists(select 1 from registered r where r.tracking_norm=declared.tracking_no)
    group by declared.tracking_no
  ), parcel_pending as (
    select pp_track.tracking_no,0::int item_count
    from order_lines l,
    jsonb_array_elements(coalesce(l.attributes->'planned_parcels','[]'::jsonb)) pp
    cross join lateral (values (upper(regexp_replace(coalesce(pp->>'tracking_no',''),'[[:space:]]+','','g')))) pp_track(tracking_no)
    where o.state='awaiting_samples' and l.order_id=o.id and l.org_id=o.org_id
      and pp_track.tracking_no ~ '^[A-Z0-9-]{5,64}$'
      and not exists(select 1 from registered r where r.tracking_norm=pp_track.tracking_no)
      and not exists(select 1 from item_pending ip where ip.tracking_no=pp_track.tracking_no)
    group by pp_track.tracking_no
  ), pending as (
    select * from item_pending
    union all
    select * from parcel_pending
  )
  select o.state='awaiting_samples' and (count(*)>0 or not exists(select 1 from registered)) parcel_registration_due,
    coalesce(jsonb_agg(to_jsonb(pending) order by tracking_no),'[]'::jsonb) unregistered_waybills
  from pending
) inbound_registration on true`;

export async function orderShipments(db:DB,orderId:string|null,org:string,shipmentId:string|null=null) {
  return (await db.query(`with related as (${relatedItems})
    select s.id,s.batch_id,s.carrier_code,s.state,s.tracking_norm,s.shipped_at,s.weight_g,b.action,b.destination_snapshot,
    (select jsonb_agg(jsonb_build_object('code',w.code,'returned_at',sr.received_at) order by w.code)
      from shipment_items si join warehouse_items w on w.id=si.item_id and w.org_id=b.org_id
      left join shipment_return_items sr on sr.shipment_id=s.id and sr.item_id=w.id
      where si.shipment_id=s.id) items
    from shipments s join dispatch_batches b on b.id=s.batch_id
    where b.org_id=$2 and s.shipped_at is not null and ($3::uuid is null or s.id=$3) and ($1::uuid is null or exists(
      select 1 from shipment_items si join related a on a.item_id=si.item_id
      where si.shipment_id=s.id and a.linked_at<=s.shipped_at and (a.unlinked_at is null or a.unlinked_at>s.shipped_at)))
    order by s.shipped_at desc,s.id`,[orderId,org,shipmentId])).rows;
}

export async function customerShipment(db:DB,actor:Actor,id:string) {
  const [shipment]=await orderShipments(db,null,organization(actor),id);
  guard(shipment,"NOT_FOUND","Shipment not found.",404);
  return shipment;
}

async function fulfillmentQuotes(db:DB,orderId:string|null,org:string,quoteId:string|null) {
  return (await db.query(`with related as (${relatedItems}), quotes as (
    select q.id,q.revision,q.amount_cents,q.expires_at,q.accepted_at,'dispatch' purpose,b.action,b.id batch_id,q.snapshot,b.state parent_state,
      (select jsonb_object_agg(w.id::text,w.code) from dispatch_batch_items bi join warehouse_items w
        on w.id=bi.item_id and w.org_id=bi.org_id where bi.batch_id=b.id and bi.org_id=$2) item_codes,
      c.id charge_id,c.applied_payment_id,c.free_authorization,c.voided_at,${latestDispatchQuote} current_quote,${unresolvedQuotePayment} unresolved_payment
    from dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id
      left join charge_items c on c.dispatch_quote_id=q.id and c.org_id=b.org_id
    where b.org_id=$2 and ($3::uuid is null or q.id=$3) and ($1::uuid is null or exists(
      select 1 from dispatch_batch_items bi join related a on a.item_id=bi.item_id
      join disposition_requests d on d.id=bi.disposition_id
      where bi.batch_id=b.id and a.linked_at<=(d.authorization_snapshot->>'authorized_at')::timestamptz
      and (a.unlinked_at is null or a.unlinked_at>(d.authorization_snapshot->>'authorized_at')::timestamptz)))
    union all select q.id,q.revision,q.amount_cents,q.expires_at,q.accepted_at,'storage',d.action,null::uuid batch_id,q.snapshot,d.state,
      jsonb_build_object(w.id::text,w.code),c.id,c.applied_payment_id,c.free_authorization,c.voided_at,${latestStorageQuote},${unresolvedQuotePayment}
    from storage_quotes q join disposition_requests d on d.id=q.disposition_id
      join warehouse_items w on w.id=d.item_id and w.org_id=d.org_id
      left join charge_items c on c.storage_quote_id=q.id and c.org_id=d.org_id
    where d.org_id=$2 and ($3::uuid is null or q.id=$3) and ($1::uuid is null or exists(select 1 from related a where a.item_id=d.item_id
      and a.linked_at<=(d.authorization_snapshot->>'authorized_at')::timestamptz
      and (a.unlinked_at is null or a.unlinked_at>(d.authorization_snapshot->>'authorized_at')::timestamptz)))
  ) select id,revision,amount_cents,expires_at,accepted_at,purpose,action,batch_id,snapshot,item_codes,charge_id,
    case when applied_payment_id is not null or free_authorization is not null then 'paid'
      when voided_at is not null or not current_quote then 'inactive'
      when exists(select 1 from payments p where p.charge_item_id=charge_id and ${paymentAwaitingResolution})
        or (expires_at<=now() and unresolved_payment) then 'processing'
      when expires_at<=now() then 'expired'
      when accepted_at is not null then 'accepted'
      when purpose='dispatch' and parent_state='quoted' or purpose='storage' and parent_state='requested' then 'open'
      else 'inactive' end state
    from quotes order by expires_at desc,id`,[orderId,org,quoteId])).rows;
}

export async function orderQuotes(db:DB,orderId:string,org:string,quoteId:string|null=null) {
  return fulfillmentQuotes(db,orderId,org,quoteId);
}

export async function customerFulfillmentQuote(db:DB,actor:Actor,id:string) {
  const [quote]=await fulfillmentQuotes(db,null,organization(actor),id);
  guard(quote,"NOT_FOUND","Quote not found.",404);
  return quote;
}

export async function orderFulfillmentRecord(db:DB,actor:Actor,orderId:string,kind:"quotes"|"shipments",recordId:string) {
  const org=organization(actor);
  await one(db,"select id from orders where id=$1 and org_id=$2",[orderId,org]);
  const rows=await (kind==="quotes"?orderQuotes:orderShipments)(db,orderId,org,recordId);
  guard(rows[0],"NOT_FOUND","Record not found.",404);
  return rows[0];
}
