import { z } from "zod";
import type { DB } from "../db";
import { role, type Actor } from "./common";

const auditKey=z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const auditPageSize=50;
export const auditFilters=z.object({
  actor_id:z.uuid().optional(),actor_type:z.enum(["customer","staff","system"]).optional(),
  action:auditKey.optional(),entity_type:auditKey.optional(),entity_id:z.uuid().optional(),
  from:z.iso.date().optional(),to:z.iso.date().optional(),
  before_id:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(id=>BigInt(id)<=9223372036854775807n).optional(),
}).refine(filters=>!filters.from||!filters.to||filters.from<=filters.to,"The end date must be on or after the start date.");

const visibleFields=["reason","decision","count","task_count","base_version","version","days",
  "job_id","type","previous_attempts","previous_error","code","zone","capacity","active","location_id",
  "event_id","assignment_id","quote_id","tracking_id","carrier","status","previous_status","kind","is_default"] as const;
function auditDetails(value:Record<string,unknown>|null) {
  return Object.fromEntries(visibleFields.flatMap(key=>{
    const field=value?.[key];
    return typeof field==="string"||typeof field==="number"||typeof field==="boolean"?[[key,field]]:[];
  }));
}
export async function readAudit(db:DB,actor:Actor,filters:z.infer<typeof auditFilters>) {
  role(actor,"super_admin");
  const {actor_id,actor_type,action,entity_type,entity_id,from,to,before_id}=filters;
  const {rows}=await db.query(`select a.id,a.at,a.actor_type,a.actor_id,a.action,a.entity_type,a.entity_id,a.before,a.after,
      u.display_name actor_name,
      coalesce(array(select sr.role from staff_roles sr where sr.user_id=a.actor_id order by sr.role), array[]::text[]) actor_roles,
      crp.receiving_code actor_receiving_code
    from audit_events a
    left join users u on u.id=a.actor_id
    left join customer_receiving_profiles crp on crp.user_id=a.actor_id
    where ($1::uuid is null or a.actor_id=$1) and ($2::text is null or a.actor_type=$2)
    and ($3::text is null or a.action=$3) and ($4::text is null or a.entity_type=$4)
    and ($5::uuid is null or a.entity_id=$5)
    and ($6::date is null or a.at>=($6::date)::timestamp at time zone 'UTC')
    and ($7::date is null or a.at<($7::date+1)::timestamp at time zone 'UTC')
    and ($8::bigint is null or a.id<$8) order by a.id desc limit $9`,
    [actor_id??null,actor_type??null,action??null,entity_type??null,entity_id??null,from??null,to??null,before_id??null,auditPageSize+1]);
  const page=rows.slice(0,auditPageSize);

  // Batch resolve human-readable labels for linked entities without altering before/after projections
  const idsByType = (entityType: string) =>
    [...new Set(page.filter(r => r.entity_type === entityType && r.entity_id).map(r => r.entity_id as string))];
  const orderIds = idsByType("orders");
  const ticketIds = idsByType("tickets");
  const userIds = idsByType("users");
  const locationIds = idsByType("storage_locations");
  const itemIds = idsByType("warehouse_items");
  const packageIds = idsByType("packages");
  const chargeItemIds = idsByType("charge_items");
  const paymentIds = idsByType("payments");
  const refundIds = idsByType("refunds");
  const incidentIds = idsByType("incident_cases");
  const taskIds = idsByType("inspection_tasks");

  const orderMap=new Map<string,{public_no:string;receiving_code:string|null}>();
  if(orderIds.length) {
    const res=await db.query<{id:string;public_no:string;receiving_code:string|null}>(
      `select o.id,o.public_no,crp.receiving_code from orders o left join customer_receiving_profiles crp on crp.org_id=o.org_id where o.id=any($1::uuid[])`,
      [orderIds]
    );
    for(const r of res.rows) orderMap.set(r.id,r);
  }
  const ticketMap=new Map<string,{public_no:string;order_no:string|null}>();
  if(ticketIds.length) {
    const res=await db.query<{id:string;public_no:string;order_no:string|null}>(
      `select t.id,t.public_no,o.public_no order_no from tickets t left join orders o on o.id=t.order_id where t.id=any($1::uuid[])`,
      [ticketIds]
    );
    for(const r of res.rows) ticketMap.set(r.id,r);
  }
  const userMap=new Map<string,{display_name:string|null;receiving_code:string|null}>();
  if(userIds.length) {
    const res=await db.query<{id:string;display_name:string|null;receiving_code:string|null}>(
      `select u.id,u.display_name,crp.receiving_code from users u left join customer_receiving_profiles crp on crp.user_id=u.id where u.id=any($1::uuid[])`,
      [userIds]
    );
    for(const r of res.rows) userMap.set(r.id,r);
  }
  const locationMap=new Map<string,{code:string;zone:string}>();
  if(locationIds.length) {
    const res=await db.query<{id:string;code:string;zone:string}>(
      `select id,code,zone from storage_locations where id=any($1::uuid[])`,
      [locationIds]
    );
    for(const r of res.rows) locationMap.set(r.id,r);
  }
  const itemMap=new Map<string,{code:string;receiving_code:string|null;order_public_no:string|null}>();
  if(itemIds.length) {
    const res=await db.query<{id:string;code:string;receiving_code:string|null;order_public_no:string|null}>(
      `select wi.id,wi.code,
        (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=wi.org_id limit 1) receiving_code,
        (select o.public_no from order_line_item_links l join order_lines ol on ol.id=l.order_line_id join orders o on o.id=ol.order_id where l.item_id=wi.id order by (l.unlinked_at is null) desc, l.id desc limit 1) order_public_no
       from warehouse_items wi where wi.id=any($1::uuid[])`,
      [itemIds]
    );
    for(const r of res.rows) itemMap.set(r.id,r);
  }
  const packageMap=new Map<string,{code:string;receiving_code:string|null}>();
  if(packageIds.length) {
    const res=await db.query<{id:string;code:string;receiving_code:string|null}>(
      `select p.id,p.code,
        (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=p.org_id limit 1) receiving_code
       from packages p where p.id=any($1::uuid[])`,
      [packageIds]
    );
    for(const r of res.rows) packageMap.set(r.id,r);
  }
  const chargeMap=new Map<string,{purpose:string;amount_cents:number;applied_payment_id:string|null;order_no:string|null;receiving_code:string|null}>();
  if(chargeItemIds.length) {
    const res=await db.query<{id:string;purpose:string;amount_cents:number;applied_payment_id:string|null;order_no:string|null;receiving_code:string|null}>(
      `select ci.id,ci.purpose,ci.amount_cents,ci.applied_payment_id,o.public_no order_no,
        (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=ci.org_id limit 1) receiving_code
       from charge_items ci
       left join inspection_quotes iq on iq.id=ci.inspection_quote_id
       left join orders o on o.id=iq.order_id
       where ci.id=any($1::uuid[])`,
      [chargeItemIds]
    );
    for(const r of res.rows) chargeMap.set(r.id,r);
  }
  const paymentMap=new Map<string,{order_no:string|null;receiving_code:string|null}>();
  if(paymentIds.length) {
    const res=await db.query<{id:string;order_no:string|null;receiving_code:string|null}>(
      `select p.id,o.public_no order_no,
        (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=ci.org_id limit 1) receiving_code
       from payments p
       join charge_items ci on ci.id=p.charge_item_id
       left join inspection_quotes iq on iq.id=ci.inspection_quote_id
       left join orders o on o.id=iq.order_id
       where p.id=any($1::uuid[])`,
      [paymentIds]
    );
    for(const r of res.rows) paymentMap.set(r.id,r);
  }
  const refundMap=new Map<string,{order_no:string|null;receiving_code:string|null}>();
  if(refundIds.length) {
    const res=await db.query<{id:string;order_no:string|null;receiving_code:string|null}>(
      `select r.id,o.public_no order_no,
        (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=ci.org_id limit 1) receiving_code
       from refunds r
       join payments p on p.id=r.payment_id
       join charge_items ci on ci.id=p.charge_item_id
       left join inspection_quotes iq on iq.id=ci.inspection_quote_id
       left join orders o on o.id=iq.order_id
       where r.id=any($1::uuid[])`,
      [refundIds]
    );
    for(const r of res.rows) refundMap.set(r.id,r);
  }
  const incidentMap=new Map<string,{item_code:string|null;receiving_code:string|null}>();
  if(incidentIds.length) {
    const res=await db.query<{id:string;item_code:string|null;receiving_code:string|null}>(
      `select ic.id,wi.code item_code,
        (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=wi.org_id limit 1) receiving_code
       from incident_cases ic
       join warehouse_items wi on wi.id=ic.item_id
       where ic.id=any($1::uuid[])`,
      [incidentIds]
    );
    for(const r of res.rows) incidentMap.set(r.id,r);
  }
  const taskMap=new Map<string,{order_no:string|null;receiving_code:string|null}>();
  if(taskIds.length) {
    const res=await db.query<{id:string;order_no:string|null;receiving_code:string|null}>(
      `select it.id,o.public_no order_no,
        (select crp.receiving_code from customer_receiving_profiles crp where crp.org_id=o.org_id limit 1) receiving_code
       from inspection_tasks it
       join order_lines ol on ol.id=it.order_line_id
       join orders o on o.id=ol.order_id
       where it.id=any($1::uuid[])`,
      [taskIds]
    );
    for(const r of res.rows) taskMap.set(r.id,r);
  }

  const chargePurposeZh:Record<string,string>={
    inspection:"质检服务费",
    dispatch:"出库运费",
    storage:"延期仓储费",
  };

  return {rows:page.map(({before,after,actor_name,actor_roles,actor_receiving_code,...event})=>{
    const ord=event.entity_type==="orders"&&event.entity_id?orderMap.get(event.entity_id):undefined;
    const tkt=event.entity_type==="tickets"&&event.entity_id?ticketMap.get(event.entity_id):undefined;
    const usr=event.entity_type==="users"&&event.entity_id?userMap.get(event.entity_id):undefined;
    const loc=event.entity_type==="storage_locations"&&event.entity_id?locationMap.get(event.entity_id):undefined;
    const itm=event.entity_type==="warehouse_items"&&event.entity_id?itemMap.get(event.entity_id):undefined;
    const pkg=event.entity_type==="packages"&&event.entity_id?packageMap.get(event.entity_id):undefined;
    const chg=event.entity_type==="charge_items"&&event.entity_id?chargeMap.get(event.entity_id):undefined;
    const pay=event.entity_type==="payments"&&event.entity_id?paymentMap.get(event.entity_id):undefined;
    const rfd=event.entity_type==="refunds"&&event.entity_id?refundMap.get(event.entity_id):undefined;
    const inc=event.entity_type==="incident_cases"&&event.entity_id?incidentMap.get(event.entity_id):undefined;
    const tsk=event.entity_type==="inspection_tasks"&&event.entity_id?taskMap.get(event.entity_id):undefined;

    const entityLabel=ord?ord.public_no:tkt?tkt.public_no:usr?(usr.receiving_code??usr.display_name??null):
      loc?loc.code:
      itm?itm.code:
      pkg?pkg.code:
      chg?`${chargePurposeZh[chg.purpose]??chg.purpose} $${(Number(chg.amount_cents)/100).toFixed(2)}`:
      inc&&event.entity_id?`INC-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}${inc.item_code?` · ${inc.item_code}`:""}`:
      tsk&&event.entity_id?`TSK-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}`:
      event.entity_type==="payments"&&event.entity_id?`PAY-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}`:
      event.entity_type==="refunds"&&event.entity_id?`RFD-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}`:
      event.entity_type==="disposal_cases"&&event.entity_id?`DSP-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}`:null;
    return {
      ...event,
      actor_name:actor_name??(actor_receiving_code?`客户 ${actor_receiving_code}`:null),
      actor_roles:actor_roles??[],
      actor_receiving_code:actor_receiving_code??null,
      entity_label:entityLabel,
      related_payment_id:chg?.applied_payment_id??null,
      order_public_no:ord?.public_no??tkt?.order_no??itm?.order_public_no??chg?.order_no??pay?.order_no??rfd?.order_no??tsk?.order_no??null,
      receiving_code:ord?.receiving_code??usr?.receiving_code??itm?.receiving_code??pkg?.receiving_code??chg?.receiving_code??pay?.receiving_code??rfd?.receiving_code??inc?.receiving_code??tsk?.receiving_code??null,
      before:auditDetails(before),
      after:auditDetails(after),
    };
  }),
    next_before_id:rows.length>auditPageSize?page.at(-1)?.id:null};
}
