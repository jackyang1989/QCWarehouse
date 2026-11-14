import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, guard, lock, one, role, type Actor } from "./common";

const key="quotes.validity";
const minutes=z.number().int().min(30).max(43_200);
const values=z.object({inspection_minutes:minutes,dispatch_minutes:minutes,storage_minutes:minutes}).strict();
const defaults={inspection_minutes:30,dispatch_minutes:4320,storage_minutes:4320};
export const quotePolicyInput=values.extend({expected_updated_at:z.iso.datetime().nullable()});
export async function quotePolicy(db:DB) {
  const row=(await db.query<{value:unknown;updated_at:Date}>("select value,updated_at from app_config where key=$1",[key])).rows[0];
  const parsed=values.safeParse(row?.value??defaults);
  guard(parsed.success,"QUOTE_POLICY_INVALID","Quote validity configuration needs administrator review.",503);
  return {...parsed.data,updated_at:row?.updated_at.toISOString()??null};
}
export async function newQuoteValidity(db:DB,kind:"inspection"|"dispatch"|"storage") {
  const current=await quotePolicy(db),duration=current[`${kind}_minutes`];
  return {expires_at:new Date((Math.floor(Date.now()/1000)+duration*60)*1000),
    snapshot:{kind,minutes:duration,policy_updated_at:current.updated_at}};
}
export async function saveQuotePolicy(db:DB,actor:Actor,input:z.infer<typeof quotePolicyInput>,sessionHash:string) {
  role(actor,"super_admin");await requireStaffMfa(db,actor,sessionHash);
  const parsed=quotePolicyInput.parse(input);
  await lock(db,"quote-policy");
  const previous=await quotePolicy(db);
  guard(previous.updated_at===parsed.expected_updated_at,"VERSION_CONFLICT","Reload quote validity settings before saving.");
  const {expected_updated_at,...next}=parsed;
  await one(db,`insert into app_config(key,value,updated_by,updated_at) values($1,$2,$3,clock_timestamp())
    on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,
      updated_at=greatest(excluded.updated_at,app_config.updated_at+interval '1 millisecond') returning key`,[key,next,actor.id]);
  await audit(db,actor,"update_quote_policy","app_config",null,{previous,next});
  return quotePolicy(db);
}
