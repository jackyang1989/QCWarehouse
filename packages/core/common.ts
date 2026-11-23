import { createHash, randomInt, randomUUID } from "node:crypto";
import type { DB } from "../db";
import type { QueryResultRow } from "pg";

export class Problem extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function guard(condition: unknown, code: string, message: string, status?: number): asserts condition {
  if (!condition) throw new Problem(code, message, status);
}
export const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 31 unambiguous chars (no 0/O/1/I/L)
export function shortCode(prefix: string, length: number) {
  let out = prefix;
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return out;
}
export function numericCode(prefix: string, digits: number) {
  const min = 10 ** (digits - 1);
  const max = 10 ** digits;
  return `${prefix}${randomInt(min, max)}`;
}
export function shanghaiYYMMDD(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "26";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}${m}${d}`;
}
export function extractReceivingCode(raw: string): string {
  const trimmed = raw.trim();
  const tagged = trimmed.match(/@(QCW-?[A-Z0-9]{4,12}|\d{5,8})@/i);
  if (tagged) {
    const val = tagged[1]!.toUpperCase().replace(/-/g, "");
    return /^\d+$/.test(val) ? `QCW${val}` : val;
  }
  return trimmed.toUpperCase();
}
export const receivingCodeKey = (raw:string) => extractReceivingCode(raw).replace(/-/g, "");
export async function findReceivingProfiles(db:Pick<DB,"query">, raw:string) {
  return (await db.query<{user_id:string;org_id:string;receiving_code:string}>(
    "select user_id,org_id,receiving_code from customer_receiving_profiles where replace(upper(receiving_code),'-','')=$1 limit 2",
    [receivingCodeKey(raw)],
  )).rows;
}
export async function resolveReceivingProfile(db:Pick<DB,"query">, raw:string) {
  const matches=await findReceivingProfiles(db,raw);
  guard(matches.length>0,"NOT_FOUND","Customer receiving code not found.",404);
  guard(matches.length===1,"AMBIGUOUS_RECEIVING_CODE","This receiving code matches more than one customer. Verify parcel ownership before binding.",409);
  return matches[0];
}
export const receivingCode = (digits = 5) => numericCode("QCW", digits);
export const orderCode = (extraDigits = 0) =>
  `QW${shanghaiYYMMDD()}${randomInt(10 ** (2 + extraDigits), 10 ** (3 + extraDigits))}`;
export const packageCode = (digits = 5) => numericCode("P", digits);
export const sampleCode = (digits = 5) => numericCode("S", digits);
export const reportCode = (orderPublicNo?: string, extraDigits = 0) => {
  if (orderPublicNo && extraDigits === 0) {
    const suffix = orderPublicNo.trim().toUpperCase().replace(/^QW-?/, "");
    if (suffix.length >= 4) return `RP${suffix}`;
  }
  return `RP${shanghaiYYMMDD()}${randomInt(10 ** (2 + extraDigits), 10 ** (3 + extraDigits))}`;
};
export const code = (prefix: string, digits = 5) => numericCode(prefix, digits);
export const isDemo = () => process.env.QCW_DEMO === "1" && process.env.NODE_ENV !== "production";
export async function one<T extends QueryResultRow>(db: Pick<DB, "query">, sql: string, values: unknown[] = []): Promise<T> {
  const row = (await db.query<T>(sql, values)).rows[0];
  guard(row, "NOT_FOUND", "Record not found.", 404);
  return row;
}
export type Actor = { id: string; org: string | null; kind: "customer" | "staff"; roles: string[] };
export function organization(actor: Actor) {
  guard(actor.kind === "customer" && actor.org, "FORBIDDEN", "Customer access required.", 403);
  return actor.org;
}
export function role(actor: Actor, ...roles: string[]) {
  guard(actor.kind === "staff" && roles.some((r) => actor.roles.includes(r)), "FORBIDDEN", "This action requires staff permission.", 403);
}
export function revision(actual: number, expected: number) {
  guard(actual === expected, "VERSION_CONFLICT", "Reload the record and review the latest version.");
}
export async function lock(db: DB, key: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
}
export async function audit(db: Pick<DB, "query">, actor: Actor | null, action: string, entity: string, id: string|null, after: object = {}) {
  await db.query("insert into audit_events(actor_type,actor_id,action,entity_type,entity_id,after) values($1,$2,$3,$4,$5,$6)", [actor?.kind ?? "system", actor?.id ?? null, action, entity, id, after]);
}
export async function event(db: DB, type: string, payload: object) {
  await db.query("insert into outbox_events(type,payload) values($1,$2)", [type, payload]);
}
export async function idempotent<T>(db: DB, scope: string, key: string, payload: unknown, fn: () => Promise<T>): Promise<T> {
  await lock(db, scope + ":" + key);
  const digest = hash(JSON.stringify(payload));
  const prev = (await db.query("select request_hash,response from idempotency_keys where scope=$1 and key=$2", [scope,key])).rows[0];
  if (prev) {
    guard(prev.request_hash === digest,"IDEMPOTENCY_CONFLICT","This key was used for a different request.");
    return prev.response;
  }
  const result = await fn();
  await db.query("insert into idempotency_keys(scope,key,request_hash,response) values($1,$2,$3,$4)", [scope,key,digest,JSON.stringify(result)]);
  return result;
}
export { randomUUID as uuid };
export const paypalCanceledReceiptAwaitingReview=`(p.provider='paypal_manual' and p.state='canceled' and p.recorded_by is not null
  and p.external_transaction_id is not null and p.evidence_media_id is not null)`;
export const paymentAwaitingResolution=`(p.state in ('processing','succeeded','partially_refunded') or ${paypalCanceledReceiptAwaitingReview}
  or (p.provider='paypal_manual' and p.state='requires_payment' and p.provider_data ? 'customer_reported_paid_at'))`;

export const unresolvedQuotePayment=`exists(select 1 from payments p where p.charge_item_id=c.id and (
  ${paymentAwaitingResolution} or (p.provider='stripe' and p.state='requires_payment'
    and (p.provider_ref is not null or p.provider_data ? 'checkout_params'))))`;

export const paymentGrossCents=`case when p.provider='paypal_manual' and p.manual_state='verified'
  then coalesce(p.received_amount_cents,p.amount_cents) else p.amount_cents end`;

export async function resolveSampleCode(db:DB,code:string) {
  const {rows}=await db.query<{id:string;code:string}>(`select id,code from warehouse_items
    where replace(upper(code),'-','')=replace(upper($1),'-','') limit 2`,[code]);
  guard(rows.length<2,"AMBIGUOUS_SAMPLE_CODE","This sample code matches more than one item. Ask a warehouse supervisor to review the labels.",409);
  return rows[0];
}
