import { pool, transaction } from "../db";
import { publishReport } from "./inspection";
import { executeRefund, expireCheckout, scheduleCheckoutExpirations } from "./payments";
import { cleanupExpiredOcrJobs, runOcrJob } from "./ocr";
import { consumeTrackingCallback, subscribeTrackingOnce, syncTrackingOnce } from "./logistics";
import { consumeEmailWebhook, deliverEmailOnce } from "./email";
import { emitCommunicationEvent, emitActiveSuperAdminEvent } from "./communications";
import { cleanupStaleMediaUploads } from "./media";
import { cleanupExpiredUnfinishedUploads, processMediaJob } from "./capture-evidence";
import { processTranslationJob } from "./ai-translation-service";
import { audit, guard, isDemo, one, role, type Actor } from "./common";
import { requireStaffMfa } from "./auth";
import { eligibleManualQuoteOrderSql } from "./orders";
import { pendingDispatchQuote, pendingStorageQuote } from "./dispatch";
import { importStripeSettlement, scheduleStripeSettlements, stripeSettlementJob } from "./stripe-settlements";
import type { DB } from "../db";

const businessEvents=["payment.checkout_expire",stripeSettlementJob,"account.registered","report.render","media.process","refund.approved","refund.succeeded","refund.failed","ocr.extract","package.received","order.ready","order.identity_mismatch","order.cancelled","order.held","order.resumed","dispatch.quoted","storage.quoted","quote.offered","shipment.handed_over","shipment.return_received","payment.confirmed","report.published","report.amended","ticket.reply","tracking.exception_opened","reference.sealed","incident.resolved"];
const maxJobAttempts=10;

function eventDedupeKey(j:{id:string;type:string;payload:Record<string,unknown>}):string {
  if(typeof j.payload?.dedupe_key==="string" && j.payload.dedupe_key.trim()) return j.payload.dedupe_key.trim();
  switch(j.type) {
    case "package.received":
      return j.payload?.package_id?`package.received:${j.payload.package_id}`:`outbox:${j.id}`;
    case "order.ready":
      return j.payload?.order_id?`order.ready:${j.payload.order_id}`:`outbox:${j.id}`;
    case "order.identity_mismatch":
      return j.payload?.order_id&&j.payload?.expected_item_id
        ?`order.identity_mismatch:${j.payload.order_id}:${j.payload.expected_item_id}`
        :`outbox:${j.id}`;
    case "order.cancelled":
      return j.payload?.order_id?`order.cancelled:${j.payload.order_id}`:`outbox:${j.id}`;
    case "payment.confirmed":
      return j.payload?.charge_id?`payment.confirmed:${j.payload.charge_id}`:`outbox:${j.id}`;
    case "refund.succeeded":
    case "refund.failed":
      return j.payload?.refund_id?`${j.type}:${j.payload.refund_id}`:`outbox:${j.id}`;
    case "quote.offered":
    case "dispatch.quoted":
    case "storage.quoted":
      return j.payload?.quote_id?`${j.type}:${j.payload.quote_id}`:`outbox:${j.id}`;
    case "report.published":
      return j.payload?.order_id?`report.published:${j.payload.order_id}:${j.payload.version??1}`:`outbox:${j.id}`;
    case "report.amended":
      return j.payload?.order_id&&j.payload?.version?`report.amended:${j.payload.order_id}:${j.payload.version}`:`outbox:${j.id}`;
    case "shipment.handed_over":
      return j.payload?.shipment_id?`shipment.handed_over:${j.payload.shipment_id}`:`outbox:${j.id}`;
    case "tracking.exception_opened":
      return j.payload?.tracker_id
        ?`tracking.exception_opened:${j.payload.tracker_id}:${j.payload.kind??"exception"}:${j.payload.episode??1}`
        :`outbox:${j.id}`;
    default:
      return `outbox:${j.id}`;
  }
}
export async function failedJobs(db:DB,actor:Actor) {
  role(actor,"super_admin");
  const {rows}=await db.query(`select j.id,j.type,j.attempts,j.last_error,j.next_attempt_at,j.created_at,
    (select o.public_no from report_versions v join reports r on r.id=v.report_id join orders o on o.id=r.order_id
      where v.id::text=j.payload->>'version_id' and j.type='report.render') order_number
    from outbox_events j where j.processed_at is null and j.attempts>0 and j.type=any($1::text[])
    order by j.attempts>=$2 desc,j.next_attempt_at,j.id limit 100`,[businessEvents,maxJobAttempts]);
  return {rows,max_attempts:maxJobAttempts};
}
export async function retryFailedJob(db:DB,actor:Actor,id:string,attempts:number,reason:string,sessionHash:string) {
  role(actor,"super_admin");
  await requireStaffMfa(db,actor,sessionHash);
  const job=await one(db,"select * from outbox_events where id=$1 for update",[id]);
  guard(!job.processed_at&&job.attempts>0&&businessEvents.includes(job.type),"JOB_NOT_RETRYABLE","This job is already processed, pending, or requires a separate recovery procedure.");
  guard(job.attempts===attempts,"VERSION_CONFLICT","Reload the job queue and review the current failure.");
  await db.query("update outbox_events set attempts=0,last_error=null,next_attempt_at=now() where id=$1",[id]);
  await audit(db,actor,"retry_outbox","outbox_events",null,{job_id:id,type:job.type,previous_attempts:attempts,
    previous_error:job.last_error,reason});
  return {id,state:"pending"};
}
export async function workOnce() {
  let jobId:string|undefined;
  try {
    const worked=await transaction(async db=>{
      const j=(await db.query(`select * from outbox_events where processed_at is null and next_attempt_at<=now() and attempts<$2
        and type=any($1::text[]) and (not $3::boolean or (type<>$4 and (type<>'payment.checkout_expire' or exists(
          select 1 from payments p where p.id::text=outbox_events.payload->>'payment_id' and p.state<>'requires_payment'))))
        order by (type='payment.checkout_expire') desc,(type=$4),id limit 1 for update skip locked`,
        [businessEvents,maxJobAttempts,isDemo(),stripeSettlementJob])).rows[0];
      if(!j) return false;
      jobId=j.id;
      if(j.type==="report.render") await publishReport(db,j.payload.version_id);
      else if(j.type==="media.process") await processMediaJob(db,j.payload.job_id);
      else if(j.type==="refund.approved") await executeRefund(db,j.payload.refund_id);
      else if(j.type==="ocr.extract") await runOcrJob(db,j.payload.job_id);
      else if(j.type==="payment.checkout_expire") await expireCheckout(db,j.payload.payment_id);
      else if(j.type===stripeSettlementJob) {
        const retryAt=await importStripeSettlement(db,j.payload.payment_id,j.created_at);
        if(retryAt) {
          await db.query("update outbox_events set next_attempt_at=$2,attempts=0,last_error=null where id=$1",[j.id,retryAt]);
          return true;
        }
      }
      else {
        if(j.type==="account.registered" && j.payload.warehouse_address_status==="pending") {
          const admins=(await db.query<{user_id:string}>(
            `select u.id as user_id from users u join staff_roles s on s.user_id=u.id and s.role='super_admin'
             where u.status='active' and not exists(select 1 from warehouse_addresses where is_default and active)`
          )).rows;
          for(const adm of admins) {
            await emitCommunicationEvent(db,{
              sourceKind:"security_alert",
              eventType:"warehouse.address_required",
              entityType:"warehouse_addresses",
              dedupeKey:`missing-warehouse-address:${adm.user_id}`,
              resetReadOnConflict:true,
              channels:["in_app"],
              recipients:[{userId:adm.user_id,kind:"staff"}],
            });
          }
        }
        if(j.type==="quote.offered") {
          const current=(await db.query<{id:string}>(`select q.id from orders o
            join manual_quote_requests m on m.order_id=o.id and m.revision=o.revision
            join inspection_quotes q on q.id=m.accepted_quote_id and q.order_id=o.id
            where o.id=$1 and ($2::uuid is null or q.id=$2) and ${eligibleManualQuoteOrderSql}
              and m.state='offered' and q.accepted_at is null and q.expires_at>now()`,
          [j.payload.order_id,j.payload.quote_id??null])).rows[0];
          j.payload={...j.payload,quote_id:current?.id};
        }
        let deliver=j.type!=="reference.sealed"&&(j.type!=="quote.offered"||Boolean(j.payload.quote_id));
        if(j.type==="refund.succeeded"||j.type==="refund.failed") {
          const result=(await db.query(`select c.id charge_id,q.order_id from refunds r
            join payments p on p.id=r.payment_id join charge_items c on c.id=p.charge_item_id
            left join inspection_quotes q on q.id=c.inspection_quote_id
            where r.id=$1 and r.state=$2 for update of r`,[j.payload.refund_id,j.type.slice(7)])).rows[0];
          deliver=Boolean(result);
          if(result)j.payload={refund_id:j.payload.refund_id,...result};
        }
        if(j.payload.quote_id&&(j.type==="dispatch.quoted"||j.type==="storage.quoted")) {
          const source=j.type==="dispatch.quoted"?`dispatch_quote_versions q join dispatch_batches b on b.id=q.batch_id where ${pendingDispatchQuote}`:
            `storage_quotes q join disposition_requests d on d.id=q.disposition_id where ${pendingStorageQuote}`;
          deliver=Boolean((await db.query(`select 1 from ${source} and q.id=$1`,[j.payload.quote_id])).rowCount);
        }
        const recipient=!deliver?null:(await db.query<{user_id:string;org_id:string}>(`select p.user_id,p.org_id from customer_receiving_profiles p where org_id=coalesce(
          (select org_id from orders where id=$1),(select org_id from packages where id=$2),
          (select org_id from dispatch_batches where id=$3),(select b.org_id from shipments s join dispatch_batches b on b.id=s.batch_id where s.id=$4),
          (select org_id from charge_items where id=$5),(select org_id from tracking_records where id=$6),
          (select org_id from tickets where id=$8),$7::uuid)`,[j.payload.order_id??null,j.payload.package_id??null,
          j.payload.batch_id??null,j.payload.shipment_id??null,j.payload.charge_id??null,j.payload.tracker_id??null,j.payload.org_id??null,j.payload.ticket_id??null])).rows[0];
        if(recipient) {
          const dedupeKey=eventDedupeKey(j);
          const orderMeta=j.payload.order_id?(await db.query<{public_no:string;is_test:boolean}>(
            "select public_no,coalesce(is_test,false) is_test from orders where id=$1",[j.payload.order_id]
          )).rows[0]:undefined;
          await emitCommunicationEvent(db,{
            sourceKind:j.type==="order.identity_mismatch"?"security_alert":"auto_event",
            eventType:j.type,
            eventId:String(j.id),
            entityType:j.payload.order_id?"orders":j.payload.ticket_id?"tickets":j.payload.shipment_id?"shipments":j.payload.package_id?"packages":"notifications",
            entityId:String(j.payload.order_id??j.payload.ticket_id??j.payload.shipment_id??j.payload.package_id??j.payload.charge_id??j.id),
            orderId:j.payload.order_id??null,
            orderPublicNo:orderMeta?.public_no??null,
            isTest:Boolean(orderMeta?.is_test),
            dedupeKey,
            metadata:j.payload,
            channels:["in_app","email"],
            recipients:[{userId:recipient.user_id,kind:"customer",orgId:recipient.org_id}],
          });
        }
      }
      await db.query("update outbox_events set processed_at=now(),last_error=null where id=$1",[j.id]);
      return true;
    });
    if(worked) return true;
    if(await transaction(consumeEmailWebhook)) return true;
    if(await deliverEmailOnce()) return true;
    if(await transaction(consumeTrackingCallback)) return true;
    return await workOneAiTranslation();
  } catch (error) {
    if(jobId) await pool.query(`update outbox_events set attempts=attempts+1,last_error=$2,
      next_attempt_at=now()+make_interval(secs=>least(900,10*(attempts+1))) where id=$1 and processed_at is null`,
      [jobId,error instanceof Error && "code" in error?String(error.code):"JOB_FAILED"]);
    throw error;
  }
}

async function workOneAiTranslation(): Promise<boolean> {
  const claimed = await transaction(async db => {
    const row = (await db.query<{ id: string; payload: { job_id?: string }; attempts: number }>(
      `select id, payload, attempts from outbox_events
       where type = 'ai.translate' and processed_at is null and next_attempt_at <= now() and attempts < $1
       order by created_at, id limit 1 for update skip locked`,
      [maxJobAttempts],
    )).rows[0];
    if (!row) return null;
    await db.query("update outbox_events set next_attempt_at = now() + interval '150 seconds' where id = $1", [row.id]);
    return row;
  });
  if (!claimed) return false;
  try {
    if (claimed.payload?.job_id) {
      await processTranslationJob(claimed.payload.job_id);
    }
    await pool.query("update outbox_events set processed_at = now(), last_error = null where id = $1", [claimed.id]);
    return true;
  } catch (error) {
    await pool.query(
      `update outbox_events set attempts = attempts + 1, last_error = $2,
         next_attempt_at = now() + make_interval(secs => least(900, 10 * (attempts + 1)))
       where id = $1 and processed_at is null`,
      [claimed.id, error instanceof Error && "code" in error ? String(error.code) : "AI_JOB_FAILED"],
    );
    throw error;
  }
}
export async function trackingTick() {
  const scheduled=await scheduleCheckoutExpirations();
  const settlement=await scheduleStripeSettlements();
  const subscribed=await subscribeTrackingOnce();
  const synced=await syncTrackingOnce();
  const cleaned=(await transaction(cleanupStaleMediaUploads)).cleaned>0;
  const evCleaned=(await transaction(cleanupExpiredUnfinishedUploads)).cleaned>0;
  const ocrCleaned=(await transaction(cleanupExpiredOcrJobs)).cleaned>0;
  return scheduled||settlement||subscribed||synced||cleaned||evCleaned||ocrCleaned;
}
