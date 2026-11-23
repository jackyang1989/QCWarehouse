import Stripe from "stripe";
import { pool, transaction, type DB } from "../db";
import { audit, guard, isDemo, lock, one } from "./common";
import { stripeCheckoutMode, stripeSettlementCredentials } from "./integrations";
import { verifiedStripeCharge } from "./payments";

export const stripeSettlementJob="payment.stripe_settlement";
const scheduledBatch=50;
const pollIntervalMs=15*60_000;
const pendingWindowMs=30*24*60*60_000;
const chargeTransactionTypes=new Set(["charge","payment"]);

export async function scheduleStripeSettlements() {
  if(isDemo())return false;
  const modes=await Promise.all((["test","live"] as const).map(async mode=>
    (await stripeSettlementCredentials(pool,mode)).key?mode:null));
  const prefixes=modes.filter(Boolean).map(mode=>`cs_${mode}_`);
  if(!prefixes.length)return false;
  return transaction(async db=>{
    await lock(db,stripeSettlementJob);
    const queued=await db.query(`insert into outbox_events(type,payload)
      select $1,jsonb_build_object('payment_id',p.id) from payments p
      where p.provider='stripe' and p.state in ('succeeded','partially_refunded','refunded')
        and left(p.provider_ref,8)=any($2::text[]) and left(p.provider_data->>'payment_intent',3)='pi_'
        and coalesce(p.provider_data->>'demo','false')<>'true'
        and not exists(select 1 from payment_settlements s where s.payment_id=p.id and s.settled_at is not null)
        and not exists(select 1 from outbox_events j where j.type=$1 and j.payload->>'payment_id'=p.id::text)
      order by p.created_at,p.id limit $3`,[stripeSettlementJob,prefixes,scheduledBatch]);
    return Boolean(queued.rowCount);
  });
}

function nextPoll(jobCreated:Date,availableOn?:number) {
  const until=jobCreated.valueOf()+pendingWindowMs;
  guard(Date.now()<until,"STRIPE_SETTLEMENT_STILL_PENDING","The provider has not made the charge balance available in the polling window.",503);
  return new Date(Math.min(until,Math.max(Date.now()+pollIntervalMs,(availableOn??0)*1000)));
}

export async function importStripeSettlement(db:DB,paymentId:string,jobCreated:Date) {
  const payment=await one<{id:string;charge_id:string;org_id:string;provider_ref:string|null;intent_id:string|null;
    amount_cents:number;currency:string;is_demo:boolean}>(db,`select p.id,c.id charge_id,c.org_id,p.provider_ref,
      p.provider_data->>'payment_intent' intent_id,p.amount_cents,p.currency,
      coalesce(p.provider_data->>'demo','false')='true' is_demo
    from payments p join charge_items c on c.id=p.charge_item_id
    where p.id=$1 and p.provider='stripe' and p.state in ('succeeded','partially_refunded','refunded')`,[paymentId]);
  const mode=stripeCheckoutMode(payment.provider_ref);
  const intentId=payment.intent_id;
  guard(!isDemo()&&!payment.is_demo&&mode&&intentId&&intentId.startsWith("pi_"),
    "STRIPE_SETTLEMENT_MODE","The original Stripe payment environment could not be verified.",409);
  const {key}=await stripeSettlementCredentials(db,mode);
  guard(key,"STRIPE_UNAVAILABLE","The Stripe key for the original environment is unavailable.",503);
  const api=new Stripe(key,{timeout:10_000,maxNetworkRetries:1});
  const intent=await api.paymentIntents.retrieve(intentId,{expand:["latest_charge.balance_transaction"]});
  const charge=verifiedStripeCharge(intent,{
    intentId,paymentId:payment.id,chargeId:payment.charge_id,
    orgId:payment.org_id,amountCents:payment.amount_cents,currency:payment.currency,mode,
  });
  guard(charge,"STRIPE_SETTLEMENT_MISMATCH","The Stripe charge does not match the verified payment.",409);
  if(!charge.balance_transaction)return nextPoll(jobCreated);
  const tx=typeof charge.balance_transaction==="string"
    ?await api.balanceTransactions.retrieve(charge.balance_transaction)
    :charge.balance_transaction;
  const source=typeof tx.source==="string"?tx.source:tx.source?.id;
  const currency=tx.currency.toUpperCase();
  const sameCurrency=currency===payment.currency.toUpperCase();
  const validRate=tx.exchange_rate!=null&&Number.isFinite(tx.exchange_rate)&&tx.exchange_rate>0;
  guard(tx.id.startsWith("txn_")&&source===charge.id&&chargeTransactionTypes.has(tx.type)&&
    ["available","pending"].includes(tx.status)&&Number.isSafeInteger(tx.available_on)&&tx.available_on>0&&
    Number.isSafeInteger(tx.amount)&&Number.isSafeInteger(tx.fee)&&Number.isSafeInteger(tx.net)&&
    tx.amount>0&&tx.amount-tx.fee===tx.net&&/^[A-Z]{3}$/.test(currency)&&
    (tx.exchange_rate==null||validRate)&&(sameCurrency?tx.amount===payment.amount_cents:validRate),
    "STRIPE_SETTLEMENT_MISMATCH","The Stripe balance transaction does not match the charge or its settlement currency.",409);
  if(typeof charge.balance_transaction==="string")
    guard(tx.id===charge.balance_transaction,"STRIPE_SETTLEMENT_MISMATCH","The balance transaction reference has changed.",409);
  await lock(db,`${stripeSettlementJob}:${paymentId}`);
  const prior=(await db.query<{provider_transaction_id:string;settled_at:Date|null}>(
    "select provider_transaction_id,settled_at from payment_settlements where payment_id=$1 limit 1",[paymentId])).rows[0];
  guard(!prior||prior.provider_transaction_id===tx.id,
    "STRIPE_SETTLEMENT_CONFLICT","The payment already has a different balance transaction.",409);
  const settledAt=tx.status==="available"?new Date(tx.available_on*1000):null;
  const stored=await db.query(`insert into payment_settlements(provider_transaction_id,payment_id,gross_minor,fee_minor,net_minor,currency,exchange_rate,settled_at)
    values($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict(provider_transaction_id) do update set settled_at=coalesce(payment_settlements.settled_at,excluded.settled_at)
    where payment_settlements.payment_id=excluded.payment_id and payment_settlements.gross_minor=excluded.gross_minor
      and payment_settlements.fee_minor=excluded.fee_minor and payment_settlements.net_minor=excluded.net_minor
      and payment_settlements.currency=excluded.currency and payment_settlements.exchange_rate is not distinct from excluded.exchange_rate
    returning settled_at`,[tx.id,payment.id,tx.amount,tx.fee,tx.net,currency,tx.exchange_rate??null,settledAt]);
  guard(stored.rowCount,"STRIPE_SETTLEMENT_CONFLICT","The existing balance transaction differs from the provider record.",409);
  if(!stored.rows[0].settled_at)return nextPoll(jobCreated,tx.available_on);
  if(!prior?.settled_at)
    await audit(db,null,"stripe_balance_available","payments",paymentId,{balance_transaction_id:tx.id,available_at:stored.rows[0].settled_at});
  return null;
}
