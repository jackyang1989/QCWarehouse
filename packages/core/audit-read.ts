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
  const orderIds=page.filter(r=>r.entity_type==="orders"&&r.entity_id).map(r=>r.entity_id as string);
  const ticketIds=page.filter(r=>r.entity_type==="tickets"&&r.entity_id).map(r=>r.entity_id as string);
  const userIds=page.filter(r=>r.entity_type==="users"&&r.entity_id).map(r=>r.entity_id as string);
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

  return {rows:page.map(({before,after,actor_name,actor_roles,actor_receiving_code,...event})=>{
    const ord=event.entity_type==="orders"&&event.entity_id?orderMap.get(event.entity_id):undefined;
    const tkt=event.entity_type==="tickets"&&event.entity_id?ticketMap.get(event.entity_id):undefined;
    const usr=event.entity_type==="users"&&event.entity_id?userMap.get(event.entity_id):undefined;
    const entityLabel=ord?ord.public_no:tkt?tkt.public_no:usr?(usr.receiving_code??usr.display_name??null):
      event.entity_type==="payments"&&event.entity_id?`PAY-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}`:
      event.entity_type==="refunds"&&event.entity_id?`RFD-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}`:
      event.entity_type==="disposal_cases"&&event.entity_id?`DSP-${String(event.entity_id).replace(/-/g,"").slice(0,8).toUpperCase()}`:null;
    return {
      ...event,
      actor_name:actor_name??(actor_receiving_code?`客户 ${actor_receiving_code}`:null),
      actor_roles:actor_roles??[],
      actor_receiving_code:actor_receiving_code??null,
      entity_label:entityLabel,
      order_public_no:ord?.public_no??tkt?.order_no??null,
      receiving_code:ord?.receiving_code??usr?.receiving_code??null,
      before:auditDetails(before),
      after:auditDetails(after),
    };
  }),
    next_before_id:rows.length>auditPageSize?page.at(-1)?.id:null};
}
