import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import * as oidc from "openid-client";
import { pepper, seal, unseal } from "./crypto";
import { oidcSettings, postmarkSettings, type OidcProvider } from "./integrations";
import { pool, transaction, type DB } from "../db";
import { Problem, audit, code, event, findReceivingProfiles, guard, hash, isDemo, lock, one, organization, receivingCode, role, uuid, type Actor } from "./common";
import { demoTermsVersion, demoWarehouseAddressZh, usableWarehouseAddressSql } from "./demo-fixtures";

const token = () => randomBytes(32).toString("base64url");
export function appOrigin() {
  return new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
}
export function reportDownloadSignature(actorId:string,reportId:string,expires:number) {
  return createHmac("sha256",pepper()).update(`report-download:${actorId}:${reportId}:${expires}`).digest("base64url");
}
export function reportShareToken(actorId:string,orderId:string,version:number,key:string) {
  return createHmac("sha256",pepper()).update(`report-share:${actorId}:${orderId}:${version}:${key}`).digest("base64url");
}
export function verifyReportDownload(actorId:string,reportId:string,expiry:string,signature:string) {
  const expires=Number(expiry);
  guard(Number.isSafeInteger(expires) && expires>Date.now() && /^[A-Za-z0-9_-]{43}$/.test(signature)
    && timingSafeEqual(Buffer.from(signature),Buffer.from(reportDownloadSignature(actorId,reportId,expires))),
    "DOWNLOAD_EXPIRED","Request a new report download link.",403);
}
export function cookie(name: string, value: string, age: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${appOrigin().startsWith("https:") ? "; Secure" : ""}`;
}
export function csrfCookie(value: string, age: number) {
  return `qcw_csrf=${value}; Path=/; SameSite=Lax; Max-Age=${age}${appOrigin().startsWith("https:") ? "; Secure" : ""}`;
}
export function csrfTokenFor(secret: string) {
  return createHmac("sha256", pepper()).update("csrf:" + hash(secret)).digest("base64url");
}
export function verifyCsrfToken(secret: string, candidate: string) {
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(csrfTokenFor(secret)));
}
export function getCookie(request: Request, key: string) {
  return request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(key + "="))?.slice(key.length + 1) ?? "";
}
export function actorFrom(request:Request) {
  return actorForSession(getCookie(request,"session"));
}
export async function actorForSession(sid:string|undefined):Promise<Actor|null> {
  if (!sid) return null;
  const actor = (await pool.query<Actor>(`
    select u.id,s.kind,case when s.kind='customer' then p.org_id end as org,
    array(select role from staff_roles where user_id=u.id and s.kind='staff') as roles
    from sessions s join users u on u.id=s.user_id left join customer_receiving_profiles p on p.user_id=u.id
    where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() and s.auth_version=u.auth_version
      and ((s.kind='staff' and u.status='active') or (s.kind='customer' and u.status in ('active','restricted')))
  `, [hash(sid)])).rows[0];
  return actor ?? null;
}
export async function requireCustomerActive(db:DB,actor:Actor) {
  if(actor.kind!=="customer") return;
  const u=await one<{status:string}>(db,"select status from users where id=$1",[actor.id]);
  guard(u.status==="active","ACCOUNT_RESTRICTED","Your account is currently restricted from new payments or outbound shipping.",403);
}
export async function requireCustomerReauth(db:DB,actor:Actor,sessionHash:string,maxAgeMinutes=10) {
  organization(actor);
  const verified=(await db.query(`select s.id from sessions s join users u on u.id=s.user_id where s.token_hash=$1
    and s.user_id=$2 and s.kind='customer' and s.revoked_at is null and s.expires_at>now()
    and s.auth_version=u.auth_version and u.status in ('active','restricted')
    and s.reauth_at>now()-make_interval(mins=>$3)`,[sessionHash,actor.id,maxAgeMinutes])).rowCount;
  guard(verified,"AUTH_REAUTH_REQUIRED","Confirm your identity again before performing this sensitive account action.",403);
}
export async function requireStaffMfa(db:DB,actor:Actor,sessionHash:string,maxAgeMinutes=10) {
  const verified=(await db.query(`select s.id from sessions s join users u on u.id=s.user_id where s.token_hash=$1
    and s.user_id=$2 and s.kind='staff' and s.revoked_at is null and s.expires_at>now()
    and s.auth_version=u.auth_version and u.status='active'
    and s.mfa_at>now()-make_interval(mins=>$3)`,[sessionHash,actor.id,maxAgeMinutes])).rowCount;
  guard(verified,"STAFF_REAUTH_REQUIRED","Sign in with your staff second factor again before continuing.",403);
}
async function session(db: DB, userId: string, kind: Actor["kind"], mfa = false) {
  const secret = token();
  const interval = kind === "customer" ? "30 days" : "12 hours";
  await db.query(`insert into sessions(id,user_id,kind,token_hash,auth_version,expires_at,mfa_at)
    select $1,id,$2,$3,auth_version,now()+($4::interval),case when $5 then now() end from users where id=$6`,
    [uuid(),kind,hash(secret),interval,mfa,userId]);
  return secret;
}
type Identity = { provider: string; issuer: string; subject: string; email: string; providerEmail?: string };
type IdentityAccount = { id:string; identity_id:string; status:string; staff:boolean; identity_status:string };
async function findIdentityAccount(db: DB, {provider,issuer,subject,email}: Identity) {
  return (await db.query<IdentityAccount>(`select u.id,i.id identity_id,u.status,i.status identity_status,
    exists(select 1 from staff_roles where user_id=u.id) staff
    from auth_identities i join users u on u.id=i.user_id left join user_emails e on e.id=i.email_id
    where i.provider=$1 and i.issuer=$2 and (
      ($1='email_otp' and e.normalized_email=$4 and e.login_enabled and e.verified_at is not null)
      or ($1<>'email_otp' and i.subject=$3))`,[provider,issuer,subject,email])).rows[0];
}
function lockIdentity(db:DB, {provider,issuer,subject,email}:Identity) {
  // OTP resolves to a stable verified email record after registration. Serialize first use by address.
  return lock(db,provider==="email_otp"?"email:"+email:"identity:"+JSON.stringify([provider,issuer,subject]));
}
function requireActiveIdentity(account:IdentityAccount) {
  const allowedStatuses=account.staff?["active"]:["active","restricted"];
  guard(allowedStatuses.includes(account.status) && account.identity_status==="active","ACCOUNT_UNAVAILABLE","This account is unavailable.",403);
}
export async function addEmailOtpIdentity(db:DB,userId:string,emailId:string) {
  await db.query(`insert into auth_identities(user_id,provider,issuer,subject,status,linked_at,email_id)
    values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)
    on conflict(provider,issuer,subject) do update set status='active',email_id=excluded.email_id,linked_at=now()
    where auth_identities.user_id=excluded.user_id`,[userId,emailId]);
}
async function signInIdentity(db: DB, identity: Identity, browser: string, allowDemoStaff = false) {
  const {provider,issuer,subject,email} = identity;
  await lockIdentity(db,identity);
  const account=await findIdentityAccount(db,identity);
  if (account) {
    await one(db,"select id from users where id=$1 for update",[account.id]);
    const current=await findIdentityAccount(db,identity);
    guard(current?.id===account.id,"ACCOUNT_UNAVAILABLE","This account is unavailable.",403);
    requireActiveIdentity(current);
    guard(!current.staff || (allowDemoStaff && isDemo() && email.endsWith("@qcw.test")), "STAFF_LOGIN_REQUIRED", "Use the staff sign-in page.",403);
    await db.query(`update auth_identities set last_authenticated_at=now(),provider_email=coalesce($2,provider_email)
      where id=$1`,[current.identity_id,identity.providerEmail??null]);
    return { state: "signed_in" as const, secret: await session(db,account.id,account.staff ? "staff" : "customer", !!account.staff), kind: account.staff ? "staff" : "customer" };
  }
  // Provider email is never used to attach a new identity to an existing account.
  const existing = (await db.query("select 1 from user_emails where normalized_email=$1 and login_enabled",[email])).rowCount;
  guard(!existing,"IDENTITY_LINK_REQUIRED","Sign in using your existing method to link a new identity.");
  const secret = token();
  await db.query(`insert into pending_registrations(token_hash,email,provider,issuer,subject,browser_hash,expires_at,provider_email)
    values($1,$2,$3,$4,$5,$6,now()+interval '20 minutes',$7)`,[hash(secret),email,provider,issuer,subject,hash(browser),identity.providerEmail??null]);
  return {state:"onboarding" as const,secret,kind:"customer"};
}
export type OtpPurpose = "signin" | "register" | "link" | "change_email" | "change_email_new" | "backup_email" | "recovery" | "recovery_status" | "reauth";

export async function startOtp(email: string, browser: string, verifiedIdentity?: Identity, purpose: OtpPurpose = "signin", initiatorUserId?: string) {
  const normalized = email.trim().toLowerCase();
  const browserHash = hash(browser);
  const otp = randomInt(0,1000000).toString().padStart(6,"0");
  const challengeId = uuid();
  const demo = isDemo() && normalized.endsWith("@qcw.test");
  const mail = postmarkSettings();
  guard(demo || mail.enabled,"EMAIL_UNAVAILABLE","Email verification is unavailable.",503);
  await transaction(async (db) => {
    await lock(db,"otp:" + normalized);
    const budget = await one<{email_count:number;browser_count:number;failed_attempts:number;next_gen:number}>(db,`
      select
        count(*) filter (where target_email=$1)::int as email_count,
        count(*) filter (where browser_binding_hash=$2)::int as browser_count,
        coalesce(sum(attempts) filter (where target_email=$1 and purpose=$3),0)::int as failed_attempts,
        coalesce(max(generation) filter (where target_email=$1 and purpose=$3),0)::int + 1 as next_gen
      from verification_challenges
      where (target_email=$1 or browser_binding_hash=$2) and expires_at>now()-interval '1 hour'`,
      [normalized,browserHash,purpose]);
    guard(budget.email_count < 5 && budget.browser_count < 20 && budget.failed_attempts < 5,
      "RATE_LIMITED","Please wait before requesting another code.",429);
    await db.query(`update verification_challenges set consumed_at=now()
      where browser_binding_hash=$1 and target_email=$2 and purpose=$3 and consumed_at is null`,[browserHash,normalized,purpose]);
    const digest = createHmac("sha256",pepper()).update(`${challengeId}:${purpose}:${otp}`).digest("hex");
    await db.query(`insert into verification_challenges(id,target_email,purpose,initiator_user_id,browser_binding_hash,code_hmac,expires_at,generation,verified_identity)
      values($1,$2,$3,$4,$5,$6,now()+interval '10 minutes',$7,$8)`,[challengeId,normalized,purpose,initiatorUserId??null,browserHash,digest,budget.next_gen,verifiedIdentity ?? null]);
  });
  if (!demo) {
    const submitted = await fetch("https://api.postmarkapp.com/email", {
      method:"POST",
      headers:{"accept":"application/json","content-type":"application/json","X-Postmark-Server-Token":mail.token!},
      body:JSON.stringify({From:mail.from,To:normalized,Subject:"Your QC Warehouse verification code",
        TextBody:`Your code is ${otp}. It expires in 10 minutes.`,MessageStream:mail.stream}),
      signal:AbortSignal.timeout(10000),
    }).then(async response=>{
      if(!response.ok) return false;
      const result=await response.json();
      return result?.ErrorCode===0 && typeof result.MessageID==="string" && result.MessageID.length>0;
    }).catch(()=>false);
    if(!submitted) {
      await pool.query("update verification_challenges set consumed_at=now() where id=$1 and consumed_at is null",[challengeId]);
      guard(false,"EMAIL_UNAVAILABLE","The verification email could not be submitted. Request a new code.",503);
    }
  }
  return {challenge_id:challengeId,resend_after:60,...(demo ? {demo_code:otp} : {})};
}
export async function verifyOtp(challengeId: string, otp: string, browser: string, purpose: OtpPurpose = "signin") {
  const browserHash = hash(browser);
  const result = await transaction(async db => {
    const target = (await db.query<{target_email:string}>("select target_email::text from verification_challenges where id=$1",[challengeId])).rows[0];
    if (!target) return null;
    await lock(db,"otp:" + target.target_email.toLowerCase());
    const c = (await db.query(`select *, expires_at>now() valid from verification_challenges where id=$1 and purpose=$2
      and browser_binding_hash=$3 and consumed_at is null for update`,[challengeId,purpose,browserHash])).rows[0];
    if (!c?.valid || c.attempts >= 5) return null;
    const total = await one<{failed:number}>(db,`select coalesce(sum(attempts),0)::int as failed from verification_challenges
      where target_email=$1 and purpose=$2 and expires_at>now()-interval '1 hour'`,[c.target_email,purpose]);
    if (total.failed >= 5) {
      await db.query("update verification_challenges set consumed_at=now() where id=$1",[challengeId]);
      return null;
    }
    const digest = createHmac("sha256",pepper()).update(`${challengeId}:${purpose}:${otp}`).digest();
    if (!timingSafeEqual(digest,Buffer.from(c.code_hmac,"hex"))) {
      const nextAttempts = Number(c.attempts) + 1;
      const exhausted = nextAttempts >= 5 || total.failed + 1 >= 5;
      await db.query("update verification_challenges set attempts=$2,consumed_at=case when $3 then now() else consumed_at end where id=$1",
        [challengeId,nextAttempts,exhausted]);
      return null;
    }
    await db.query("update verification_challenges set consumed_at=now() where id=$1",[challengeId]);
    try {
      return await signInIdentity(db,c.verified_identity ?? {provider:"email_otp",issuer:"qcwarehouse",subject:"",email:c.target_email},browser,!c.verified_identity);
    } catch (error) {
      // A verified code remains consumed when the account or identity is denied.
      if(error instanceof Problem) return error;
      throw error;
    }
  });
  guard(result,"OTP_INVALID","That code is incorrect, expired, or has already been used.",400);
  if(result instanceof Problem) throw result;
  return result;
}
export async function demoSwitchAccount(email: string) {
  const normalized = email.trim().toLowerCase();
  guard(isDemo() && process.env.NODE_ENV !== "production" && normalized.endsWith("@qcw.test"),
    "DEMO_UNAVAILABLE", "Demo account switching is only available in local demo mode.", 403);
  return transaction(async db => {
    const account = (await db.query<{id: string; staff: boolean}>(`
      select u.id, exists(select 1 from staff_roles where user_id=u.id) as staff
      from users u join user_emails e on e.user_id=u.id
      where e.normalized_email=$1 and u.status='active'
    `, [normalized])).rows[0];
    guard(account, "ACCOUNT_NOT_FOUND", "Demo account not found.", 404);
    const kind = account.staff ? "staff" as const : "customer" as const;
    const secret = await session(db, account.id, kind, account.staff);
    return { state: "signed_in" as const, secret, kind };
  });
}
export async function currentTerms(db: DB, kinds: string[]) {
  return (await db.query<{id:string;kind:string;version:string;content_md:string;effective_at:Date}>(`select distinct on(kind) id,kind,version,content_md,effective_at
    from terms_versions where kind=any($1) and effective_at<=now() and ($2::boolean or version<>$3)
    order by kind,effective_at desc,id`,[kinds,isDemo(),demoTermsVersion])).rows;
}
export async function publicPolicy(db:DB,kind:string,version:string|null) {
  if(version===null) {
    const [current]=await currentTerms(db,[kind]);
    guard(current,"NOT_FOUND","No current version of this policy is available.",404);
    return current;
  }
  return one(db,`select id,kind,version,content_md,effective_at from terms_versions
    where kind=$1 and version=$2 and effective_at<=now() and ($3::boolean or version<>$4)`,[kind,version,isDemo(),demoTermsVersion]);
}
export function requireTerms(actual: {id:string}[], submitted: string[], count: number) {
  guard(actual.length===count && submitted.length===count && actual.every(t=>submitted.includes(t.id)),"TERMS_CHANGED","Review the current terms before continuing.");
}
export async function receiving(db: DB, userId: string) {
  const profile = await one<{org_id:string;receiving_code:string}>(db,"select org_id,receiving_code from customer_receiving_profiles where user_id=$1",[userId]);
  const address = (await db.query(`select id,contact_name as recipient,contact_phone as phone,address_zh,address_en
    from warehouse_addresses where is_default and active and ${usableWarehouseAddressSql("$1","$2")}`,
    [isDemo(),demoWarehouseAddressZh])).rows[0] ?? null;
  return {user_id:userId,...profile,warehouse_address_status:address ? "available" : "pending",warehouse_address:address};
}
type CustomerPreferences={display_name:string|null;timezone:string|null};
export async function customerPreferences(db:Pick<DB,"query">,actor:Actor) {
  organization(actor);
  return one<CustomerPreferences>(db,"select display_name,timezone from users where id=$1",[actor.id]);
}
export async function customerWorkspaceProfile(db:Pick<DB,"query">,actor:Actor) {
  organization(actor);
  return one<CustomerPreferences & { primary_email:string|null }>(db,`select u.display_name,u.timezone,e.original_email as primary_email
    from users u left join user_emails e on e.user_id=u.id and e.is_primary where u.id=$1`,[actor.id]);
}
export async function updateCustomerPreferences(db:DB,actor:Actor,input:Partial<CustomerPreferences>) {
  organization(actor);
  const name=input.display_name?.trim();
  guard(input.display_name===null||input.display_name===undefined||Boolean(name),"INVALID_REQUEST","Enter a display name or leave it blank.",422);
  const timezone=input.timezone;
  if(timezone) {
    guard(timezone==="UTC"||/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(timezone),"INVALID_TIMEZONE","Choose a valid time zone.",422);
    try {
      new Intl.DateTimeFormat("en",{timeZone:timezone});
    } catch {
      throw new Problem("INVALID_TIMEZONE","Choose a valid time zone such as Europe/London.",422);
    }
  }
  const profile=await one<CustomerPreferences>(db,`update users set
    display_name=case when $2 then $3 else display_name end,
    timezone=case when $4 then $5 else timezone end, updated_at=now()
    where id=$1 returning display_name,timezone`,[actor.id,input.display_name!==undefined,name??null,timezone!==undefined,timezone??null]);
  await audit(db,actor,"update_customer_preferences","users",actor.id,{fields:Object.keys(input)});
  return profile;
}
export async function completeRegistration(secret:string,browser:string,termsIds:string[]) {
  return transaction(async db=>{
    const tokenHash=hash(secret);
    const pending = await one<Identity & {completed_user_id:string|null}>(db,`select *,provider_email as "providerEmail" from pending_registrations
      where token_hash=$1 and browser_hash=$2 and expires_at>now() for update`,[tokenHash,hash(browser)]);
    await lockIdentity(db,pending);
    if(pending.provider!=="email_otp") await lock(db,"email:"+pending.email);
    if(!pending.completed_user_id) requireTerms(await currentTerms(db,["terms","privacy"]),termsIds,2);
    const account=await findIdentityAccount(db,pending);
    if(account) {
      requireActiveIdentity(account);
      guard(!account.staff && (!pending.completed_user_id || pending.completed_user_id===account.id),
        "ACCOUNT_UNAVAILABLE","This registration cannot be resumed.",403);
      await db.query("update pending_registrations set completed_user_id=$2 where token_hash=$1",[tokenHash,account.id]);
      return {profile:await receiving(db,account.id),secret:await session(db,account.id,"customer")};
    }
    guard(!pending.completed_user_id,"ACCOUNT_UNAVAILABLE","This registration cannot be resumed.",403);
    guard(!(await db.query("select 1 from user_emails where normalized_email=$1 and login_enabled",[pending.email])).rowCount,
      "IDENTITY_LINK_REQUIRED","This email is already registered.");
    const userId=uuid(),orgId=uuid();
    await db.query("insert into users(id,display_name) values($1,$2)",[userId,pending.email.split("@")[0]]);
    await db.query("insert into organizations(id,name) values($1,$2)",[orgId,"Personal workspace"]);
    await db.query("insert into memberships(user_id,org_id) values($1,$2)",[userId,orgId]);
    let assignedCode = "";
    await lock(db,"receiving-code-allocation");
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = receivingCode();
      if((await findReceivingProfiles(db,candidate)).length)continue;
      const inserted = await db.query(
        "insert into customer_receiving_profiles(user_id,org_id,receiving_code) values($1,$2,$3) on conflict (receiving_code) do nothing returning receiving_code",
        [userId, orgId, candidate],
      );
      if (inserted.rowCount) {
        assignedCode = candidate;
        break;
      }
    }
    guard(assignedCode, "RECEIVING_CODE_EXHAUSTED", "Could not allocate a unique receiving code. Try again.", 503);
    const email=await one<{id:string}>(db,`insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
      values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,[userId,pending.email]);
    await addEmailOtpIdentity(db,userId,email.id);
    if (pending.provider!=="email_otp") {
      await db.query(`insert into auth_identities(user_id,provider,issuer,subject,status,linked_at,provider_email)
        values($1,$2,$3,$4,'active',now(),$5)`,[userId,pending.provider,pending.issuer,pending.subject,pending.providerEmail??null]);
    }
    await db.query("insert into account_consents(user_id,terms_version_id,accepted_at,source) select $1,unnest($2::uuid[]),now(),'registration'",[userId,termsIds]);
    await db.query("update pending_registrations set completed_user_id=$2 where token_hash=$1",[tokenHash,userId]);
    await audit(db,{id:userId,org:orgId,kind:"customer",roles:[]},"register","users",userId);
    const profile=await receiving(db,userId);
    await event(db,"account.registered",{org_id:orgId,warehouse_address_status:profile.warehouse_address_status});
    return {profile,secret:await session(db,userId,"customer")};
  });
}

function sealNote() {
  // Secret sealing primitives live in ./crypto and are re-exported at the bottom of auth.ts.
}
async function providerConfig(provider:OidcProvider) {
  const {clientId,clientSecret,issuer,callback}=oidcSettings(provider);
  guard(clientId && clientSecret && callback,"PROVIDER_UNAVAILABLE","This sign-in method is not configured.",503);
  const config=await oidc.discovery(new URL(issuer),clientId,clientSecret);
  return {config,callback};
}
type ProviderAction = { userId:string; sessionHash:string; confirmFor?:OidcProvider; confirmedBy?:string; refreshIdentityId?:string };
const securityReturnPath="/account/security";

export async function startProvider(provider:OidcProvider,browser:string,returnPath:string|null,action?:ProviderAction) {
  const {config,callback}=await providerConfig(provider);
  const verifier=oidc.randomPKCECodeVerifier(),state=oidc.randomState(),nonce=oidc.randomNonce();
  const intent=action?.refreshIdentityId?"account_email":action?.confirmFor?"link_confirmation":action?"link":"signin";
  await pool.query(`insert into auth_transactions(state_digest,provider,intent,initiator_user_id,browser_binding_hash,nonce_digest,verifier_ciphertext,return_path,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')`,
    [hash(state),provider,intent,action?.userId??null,hash(browser),hash(nonce),
      seal(JSON.stringify({verifier,nonce,...action})),returnPath]);
  return oidc.buildAuthorizationUrl(config,{
    redirect_uri:callback,scope:"openid email profile",
    state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:"S256",
    ...(action?{prompt:"select_account"}:{}),
  }).href;
}

async function requireActiveProviderSession(db:DB,actor:Actor,sessionHash:string) {
  const active=(await db.query(`select s.id from sessions s join users u on u.id=s.user_id
    where s.token_hash=$1 and s.user_id=$2 and s.kind='customer' and s.revoked_at is null
      and s.expires_at>now() and s.auth_version=u.auth_version and u.status in ('active','restricted')
    for share of s`,[sessionHash,actor.id])).rowCount;
  guard(active,"LINK_SESSION_EXPIRED","Your session changed. Start again from account settings.",403);
}

export async function startProviderAccountRefresh(db:DB,actor:Actor,sessionHash:string,browser:string,identityId:string) {
  organization(actor);
  const {provider}=await one<{provider:OidcProvider}>(db,`select provider from auth_identities
    where id=$1 and user_id=$2 and status='active' and provider in ('google','microsoft')`,[identityId,actor.id]);
  return {authorization_url:await startProvider(provider,browser,securityReturnPath,{userId:actor.id,sessionHash,refreshIdentityId:identityId})};
}

export async function finishProvider(provider:OidcProvider,url:URL,browser:string,actor:Actor|null,sessionHash:string) {
  const state=url.searchParams.get("state") ?? "";
  const tx=await one<{verifier_ciphertext:Buffer;return_path:string|null;intent:string;initiator_user_id:string|null}>(pool as unknown as DB,`update auth_transactions set consumed_at=now()
    where state_digest=$1 and provider=$2 and intent in ('signin','link','link_confirmation','account_email')
      and browser_binding_hash=$3 and consumed_at is null and expires_at>now()
    returning verifier_ciphertext,return_path,intent,initiator_user_id`,[hash(state),provider,hash(browser)]);
  const next=tx.return_path;
  const link=tx.intent==="link"||tx.intent==="link_confirmation";
  const refresh=tx.intent==="account_email";
  if(refresh&&url.searchParams.has("error"))return {state:"account_refresh_cancelled" as const,next};
  if(url.searchParams.has("error")) return {state:link?"link_cancelled" as const:"cancelled" as const,next};
  try {
    if(link||refresh) {
      const binding=JSON.parse(unseal(tx.verifier_ciphertext)) as Partial<ProviderAction>;
      guard(actor?.kind==="customer"&&actor.id===tx.initiator_user_id&&binding.sessionHash===sessionHash,
        "AUTH_TRANSACTION_INVALID","Restart linking from account settings.",403);
      const verified=await verifyOidcClaims(provider,url,state,tx.verifier_ciphertext,true);
      if(refresh) {
        await transaction(async db=>{
          await one(db,"select id from users where id=$1 for update",[actor.id]);
          await requireActiveProviderSession(db,actor,sessionHash);
          const identity=await findIdentityAccount(db,verified);
          guard(identity?.id===actor.id&&identity.identity_id===binding.refreshIdentityId&&identity.identity_status==="active",
            "LINK_WRONG_ACCOUNT","Choose the account shown in your sign-in methods.",403);
          if(verified.providerEmail) {
            await db.query("update auth_identities set provider_email=$2 where id=$1",[identity.identity_id,verified.providerEmail]);
            await audit(db,actor,"refresh_provider_account","auth_identities",identity.identity_id,{provider});
          }
        });
        return {state:verified.providerEmail?"account_refreshed" as const:"account_email_unavailable" as const,next};
      }
      if(tx.intent==="link_confirmation") {
        const target=binding.confirmFor;
        guard(target&&target!==provider,"AUTH_TRANSACTION_INVALID","Start linking again from account settings.",403);
        const confirmed=await transaction(async db=>{
          await one(db,"select id from users where id=$1 for update",[actor.id]);
          await requireActiveProviderSession(db,actor,sessionHash);
          const identity=await findIdentityAccount(db,verified);
          guard(identity?.id===actor.id&&identity.identity_status==="active",
            "LINK_WRONG_ACCOUNT","Choose the sign-in account already linked to this workspace.",403);
          if(verified.providerEmail)await db.query("update auth_identities set provider_email=$2 where id=$1",[identity.identity_id,verified.providerEmail]);
          await audit(db,actor,"confirm_provider_link","auth_identities",identity.identity_id,{target});
          return identity.identity_id;
        });
        const authorization_url=await startProvider(target,browser,securityReturnPath,
          {userId:actor.id,sessionHash,confirmedBy:confirmed});
        return {state:"link_continue" as const,authorization_url,next};
      }
      await transaction(async db=>{
        const linked=await attachExternalIdentity(db,actor.id,verified);
        if(binding.confirmedBy) {
          await requireActiveProviderSession(db,actor,sessionHash);
          const source=(await db.query(`select id from auth_identities where id=$1 and user_id=$2
            and provider<>$3 and provider in ('google','microsoft') and status='active'`,
          [binding.confirmedBy,actor.id,provider])).rowCount;
          guard(source,"LINK_WRONG_ACCOUNT","The sign-in method used to confirm this change is no longer linked.",403);
        } else {
          await requireCustomerReauth(db,actor,sessionHash);
        }
        await audit(db,actor,"link_identity","auth_identities",linked.id,{provider});
      });
      return {state:"linked" as const,provider,next:next??securityReturnPath};
    }
    const result=await verifyProviderIdentity(provider,url,browser,state,tx.verifier_ciphertext);
    return {...result,next};
  } catch(error) {
    if(refresh) return {state:error instanceof Problem&&error.code==="LINK_WRONG_ACCOUNT"?"link_wrong_account" as const:"account_refresh_failed" as const,next};
    if(link) {
      if(error instanceof Problem&&error.code==="IDENTITY_ALREADY_LINKED") return {state:"link_conflict" as const,next};
      if(error instanceof Problem&&error.code==="LINK_WRONG_ACCOUNT") return {state:"link_wrong_account" as const,next};
      return {state:"link_failed" as const,next};
    }
    return {state:error instanceof Problem&&error.code==="IDENTITY_LINK_REQUIRED"?"link_required" as const:"failed" as const,next};
  }
}

async function verifyOidcClaims(provider:OidcProvider,url:URL,state:string,encrypted:Buffer,verifySignature=false):Promise<Identity & {emailVerified:boolean}> {
  const {verifier,nonce}=JSON.parse(unseal(encrypted));
  const {config,callback}=await providerConfig(provider);
  if(verifySignature) oidc.enableNonRepudiationChecks(config);
  const redirect=new URL(callback+url.search);
  const result=await oidc.authorizationCodeGrant(config,redirect,{pkceCodeVerifier:verifier,expectedState:state,expectedNonce:nonce,idTokenExpected:true});
  const claims=result.claims();
  guard(claims?.sub && claims.iss,"PROVIDER_IDENTITY_INVALID","Verified provider identity missing.",400);
  if(provider==="microsoft") {
    const personalTenant="9188040d-6c67-4c5b-b112-36a304b66dad";
    guard(claims.tid===personalTenant && claims.iss===`https://login.microsoftonline.com/${personalTenant}/v2.0`,
      "PROVIDER_IDENTITY_INVALID","Use a personal Microsoft account.",400);
  }
  const email=typeof claims.email==="string" ? claims.email.trim().toLowerCase() : "";
  const providerEmail=[email,claims.preferred_username].find((value):value is string=>
    typeof value==="string"&&value.length<=320&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value));
  return {provider,issuer:claims.iss,subject:claims.sub,email,providerEmail,emailVerified:claims.email_verified===true};
}

async function verifyProviderIdentity(provider:OidcProvider,url:URL,browser:string,state:string,encrypted:Buffer) {
  const {emailVerified,...identity}=await verifyOidcClaims(provider,url,state,encrypted);
  if (provider==="google" && emailVerified && identity.email) {
    return transaction(db=>signInIdentity(db,identity,browser));
  }
  const linked=(await pool.query("select 1 from auth_identities where provider=$1 and issuer=$2 and subject=$3 and status='active'",[provider,identity.issuer,identity.subject])).rowCount;
  if (linked) return transaction(db=>signInIdentity(db,identity,browser));
  const pending=seal(JSON.stringify({identity,browserHash:hash(browser),expires:Date.now()+900000})).toString("base64url");
  return {state:"verify_email" as const,secret:pending,kind:"customer"};
}
export function pendingProvider(value:string,email:string,browser:string): Identity | undefined {
  if (!value) return undefined;
  try {
    const pending=JSON.parse(unseal(Buffer.from(value,"base64url"))) as {identity:Identity;browserHash:string;expires:number};
    if(pending.expires>Date.now() && pending.browserHash===hash(browser)) {
      return {...pending.identity,email:email.trim().toLowerCase()};
    }
  } catch {
    // Treat unreadable or old-format cookies like expired verification state.
  }
  guard(false,"PROVIDER_VERIFICATION_EXPIRED","Restart provider sign-in or continue with email.",400);
}
export function passwordHash(password:string) {
  const salt=token();
  return salt+":"+scryptSync(password,salt,64).toString("hex");
}
export async function staffSignIn(email:string,password:string,otp:string) {
  return transaction(async db=>{
    const key="staff:"+email.toLowerCase();
    await lock(db,key);
    const recent=await one<{n:number}>(db,"select count(*)::int n from account_security_events where kind=$1 and occurred_at>now()-interval '15 minutes'",[hash(key)]);
    guard(recent.n<8,"RATE_LIMITED","Too many sign-in attempts.",429);
    const user=(await db.query(`select u.* from users u join user_emails e on e.user_id=u.id
      where e.normalized_email=$1 and u.status='active' and exists(select 1 from staff_roles where user_id=u.id)`,[email])).rows[0];
    const [salt,digest]=(user?.password_hash ?? "invalid:"+"0".repeat(128)).split(":");
    const verified=timingSafeEqual(scryptSync(password,salt,64),Buffer.from(digest,"hex"));
    let otpOK=false;
    if (verified && user?.mfa_secret_enc && /^\d{6}$/.test(otp)) {
      const secret=unseal(Buffer.from(user.mfa_secret_enc,"base64url"));
      const counter=Math.floor(Date.now()/30000);
      for (const offset of [-1,0,1]) {
        const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(counter+offset));
        const h=createHmac("sha1",Buffer.from(secret,"hex")).update(bytes).digest();
        const number=(h.readUInt32BE(h[19]&15)&0x7fffffff)%1000000;
        if (String(number).padStart(6,"0")===otp) {
          const used=await db.query("insert into idempotency_keys(scope,key,request_hash) values($1,$2,'totp') on conflict do nothing",["mfa:"+user.id,String(counter+offset)]);
          otpOK=!!used.rowCount;
          break;
        }
      }
    }
    if (!verified || !otpOK || !user) {
      await db.query("insert into account_security_events(user_id,kind,outcome,request_id) values($1,$2,'denied',$3)",[user?.id??null,hash(key),uuid()]);
      return null;
    }
    return session(db,user.id,"staff",true);
  });
}

async function consumeChallengeCode(db:DB,challengeId:string,otp:string,browser:string,purpose:OtpPurpose,expectedUserId?:string,deferConsumption=false) {
  const browserHash=hash(browser);
  const target=(await db.query<{target_email:string}>("select target_email::text from verification_challenges where id=$1",[challengeId])).rows[0];
  guard(target,"OTP_INVALID","That code is incorrect, expired, or has already been used.",400);
  await lock(db,"otp:"+target.target_email.toLowerCase());
  const c=(await db.query(`select *, expires_at>now() valid from verification_challenges where id=$1 and purpose=$2
    and browser_binding_hash=$3 and consumed_at is null for update`,[challengeId,purpose,browserHash])).rows[0];
  guard(c?.valid && c.attempts<5 && (!expectedUserId || c.initiator_user_id===expectedUserId),
    "OTP_INVALID","That code is incorrect, expired, or has already been used.",400);
  const total=await one<{failed:number}>(db,`select coalesce(sum(attempts),0)::int as failed from verification_challenges
    where target_email=$1 and purpose=$2 and expires_at>now()-interval '1 hour'`,[c.target_email,purpose]);
  if(total.failed>=5) {
    await db.query("update verification_challenges set consumed_at=now() where id=$1",[challengeId]);
    guard(false,"OTP_INVALID","That code is incorrect, expired, or has already been used.",400);
  }
  const digest=createHmac("sha256",pepper()).update(`${challengeId}:${purpose}:${otp}`).digest();
  if(!timingSafeEqual(digest,Buffer.from(c.code_hmac,"hex"))) {
    const nextAttempts=Number(c.attempts)+1;
    const exhausted=nextAttempts>=5 || total.failed+1>=5;
    await db.query("update verification_challenges set attempts=$2,consumed_at=case when $3 then now() else consumed_at end where id=$1",
      [challengeId,nextAttempts,exhausted]);
    guard(false,"OTP_INVALID","That code is incorrect, expired, or has already been used.",400);
  }
  if(!deferConsumption) await db.query("update verification_challenges set consumed_at=now() where id=$1",[challengeId]);
  return c as {id:string;target_email:string;verified_identity:Identity|null};
}

async function trustedSecurityEmail(db:Pick<DB,"query">,actor:Actor,id?:string,email?:string) {
  organization(actor);
  const match=(await db.query<{email:string}>(`select normalized_email::text as email from user_emails
    where user_id=$1 and verified_at is not null and (is_primary or login_enabled)
    and ($2::uuid is null or id=$2) and ($3::citext is null or normalized_email=$3)
    order by is_primary desc limit 1`,[actor.id,id??null,email??null])).rows[0];
  guard(match,"VERIFICATION_EMAIL_UNAVAILABLE","Choose a verified email on your account and try again.",409);
  return match.email;
}

export async function startCustomerReauth(actor:Actor,browser:string,emailId?:string) {
  const email=await trustedSecurityEmail(pool,actor,emailId);
  return startOtp(email,browser,undefined,"reauth",actor.id);
}

export async function verifyCustomerReauth(actor:Actor,sessionHash:string,challengeId:string,otp:string,browser:string) {
  organization(actor);
  return runOtpVerification(async db=>{
    const proof=await consumeChallengeCode(db,challengeId,otp,browser,"reauth",actor.id);
    await one(db,"select id from users where id=$1 for update",[actor.id]);
    await trustedSecurityEmail(db,actor,undefined,proof.target_email);
    const updated=await db.query(`update sessions set reauth_at=now()
      where token_hash=$1 and user_id=$2 and kind='customer' and revoked_at is null and expires_at>now() returning reauth_at`,
      [sessionHash,actor.id]);
    guard(updated.rowCount,"SIGN_IN_REQUIRED","Sign in to continue.",401);
    await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$1,'reauth','succeeded',$2)",[actor.id,uuid()]);
    await audit(db,actor,"customer_reauth","sessions",null);
    return {reauthenticated:true,reauthenticated_until:new Date(Date.now()+10*60_000).toISOString()};
  });
}

export async function listIdentities(db:DB,actor:Actor,sessionHash:string) {
  organization(actor);
  const user=await one<{status:string;display_name:string|null}>(db,"select status,display_name from users where id=$1",[actor.id]);
  const sess=(await db.query<{reauth_ok:boolean}>(`select coalesce(reauth_at>now()-interval '10 minutes',false) reauth_ok
    from sessions where token_hash=$1 and user_id=$2 and revoked_at is null`,[sessionHash,actor.id])).rows[0];
  const identities=(await db.query(`select i.id,i.provider,i.issuer,i.status,i.linked_at,i.last_authenticated_at,i.provider_email,e.original_email as email
    from auth_identities i left join user_emails e on e.id=i.email_id
    where i.user_id=$1 and i.status='active' order by i.linked_at asc`,[actor.id])).rows;
  const emails=(await db.query(`select id,original_email,normalized_email::text as normalized_email,verified_at,is_primary,login_enabled,delivery_state
    from user_emails where user_id=$1 order by is_primary desc,verified_at desc nulls last`,[actor.id])).rows;
  return {status:user.status,display_name:user.display_name,reauthenticated:Boolean(sess?.reauth_ok),identities,emails};
}

export async function attachExternalIdentity(db:DB,userId:string,identity:Identity) {
  guard(identity.provider==="google" || identity.provider==="microsoft","INVALID_REQUEST","Unsupported identity provider.",422);
  await lockIdentity(db,identity);
  await one(db,"select id from users where id=$1 and status in ('active','restricted') for update",[userId]);
  const existing=(await db.query<{id:string;user_id:string;status:string}>(
    "select id,user_id,status from auth_identities where provider=$1 and issuer=$2 and subject=$3 for update",
    [identity.provider,identity.issuer,identity.subject]
  )).rows[0];
  if(existing) {
    guard(existing.user_id===userId,"IDENTITY_ALREADY_LINKED","This sign-in method cannot be linked to this account.",409);
    await db.query(`update auth_identities set status='active',linked_at=now(),last_authenticated_at=now(),
      provider_email=coalesce($2,provider_email) where id=$1`,[existing.id,identity.providerEmail??null]);
    await db.query("insert into account_security_events(user_id,actor_id,identity_id,kind,outcome,request_id) values($1,$1,$2,'identity_linked','succeeded',$3)",
      [userId,existing.id,uuid()]);
    return {id:existing.id,provider:identity.provider,status:"active"};
  }
  const inserted=await one<{id:string}>(db,
    `insert into auth_identities(user_id,provider,issuer,subject,status,linked_at,last_authenticated_at,provider_email)
     values($1,$2,$3,$4,'active',now(),now(),$5) returning id`,
    [userId,identity.provider,identity.issuer,identity.subject,identity.providerEmail??null]
  );
  await db.query("insert into account_security_events(user_id,actor_id,identity_id,kind,outcome,request_id) values($1,$1,$2,'identity_linked','succeeded',$3)",
    [userId,inserted.id,uuid()]);
  return {id:inserted.id,provider:identity.provider,status:"active"};
}

export async function linkProviderIdentity(
  db:DB,actor:Actor,sessionHash:string,browser:string,provider:OidcProvider,input:{challenge_id?:string;code?:string}
) {
  if(input.challenge_id && input.code) {
    await requireCustomerReauth(db,actor,sessionHash);
    const c=await consumeChallengeCode(db,input.challenge_id,input.code,browser,"link",actor.id);
    guard(c.verified_identity && c.verified_identity.provider===provider,"AUTH_TRANSACTION_INVALID","Verified provider identity missing for link.",422);
    const linked=await attachExternalIdentity(db,actor.id,c.verified_identity);
    await audit(db,actor,"link_identity","auth_identities",linked.id,{provider});
    return linked;
  }
  organization(actor);
  const link={userId:actor.id,sessionHash};
  try {
    await requireCustomerReauth(db,actor,sessionHash);
  } catch(error) {
    if(!(error instanceof Problem)||error.code!=="AUTH_REAUTH_REQUIRED") throw error;
    const source:OidcProvider=provider==="microsoft"?"google":"microsoft";
    const bound=(await db.query("select 1 from auth_identities where user_id=$1 and provider=$2 and status='active'",[actor.id,source])).rowCount;
    if(!bound||!oidcSettings(source).configured) throw error;
    return {provider,authorization_url:await startProvider(source,browser,securityReturnPath,{...link,confirmFor:provider})};
  }
  return {provider,authorization_url:await startProvider(provider,browser,securityReturnPath,link)};
}

export async function unlinkIdentity(db:DB,actor:Actor,identityId:string,sessionHash:string) {
  await requireCustomerReauth(db,actor,sessionHash);
  await one(db,"select id from users where id=$1 for update",[actor.id]);
  const identity=await one<{id:string;provider:string;email_id:string|null}>(db,
    "select id,provider,email_id from auth_identities where id=$1 and user_id=$2 and status='active' for update",
    [identityId,actor.id]);
  const remaining=await one<{n:number}>(db,
    "select count(*)::int n from auth_identities where user_id=$1 and status='active' and id<>$2",
    [actor.id,identityId]);
  guard(remaining.n>=1,"LAST_LOGIN_METHOD","At least one verified sign-in method must remain active on your account.",409);
  await db.query("update auth_identities set status='revoked',email_id=null where id=$1",[identityId]);
  if(identity.provider==="email_otp" && identity.email_id) {
    const email=await one<{is_primary:boolean}>(db,"update user_emails set login_enabled=false where id=$1 and user_id=$2 returning is_primary",[identity.email_id,actor.id]);
    if(!email.is_primary) await revokeOtherSessions(db,actor,sessionHash);
  }
  await db.query("update auth_transactions set consumed_at=now() where initiator_user_id=$1 and provider=$2 and consumed_at is null",[actor.id,identity.provider]);
  await db.query("insert into account_security_events(user_id,actor_id,identity_id,kind,outcome,request_id) values($1,$1,$2,'identity_unlinked','succeeded',$3)",
    [actor.id,identityId,uuid()]);
  await audit(db,actor,"unlink_identity","auth_identities",identityId,{provider:identity.provider});
  return {id:identityId,status:"revoked"};
}

async function requireAvailableBackupEmail(db:Pick<DB,"query">,actor:Actor,email:string) {
  const occupied=(await db.query(`select 1 from user_emails where normalized_email=$1
    and (login_enabled or (user_id=$2 and is_primary))`,[email,actor.id])).rowCount;
  guard(!occupied,"BACKUP_EMAIL_UNAVAILABLE","Choose an email address that is different from your current sign-in addresses.",409);
}

export async function requestBackupEmail(actor:Actor,sessionHash:string,email:string,browser:string) {
  await requireCustomerReauth(pool as unknown as DB,actor,sessionHash);
  const target=email.trim().toLowerCase();
  await requireAvailableBackupEmail(pool,actor,target);
  return startOtp(target,browser,undefined,"backup_email",actor.id);
}

export async function confirmBackupEmail(db:DB,actor:Actor,sessionHash:string,browser:string,input:{challenge_id:string;code:string}) {
  await requireCustomerReauth(db,actor,sessionHash);
  const proof=await consumeChallengeCode(db,input.challenge_id,input.code,browser,"backup_email",actor.id);
  const email=proof.target_email.toLowerCase();
  await lock(db,"email:"+email);
  await one(db,"select id from users where id=$1 for update",[actor.id]);
  await requireCustomerReauth(db,actor,sessionHash);
  await requireAvailableBackupEmail(db,actor,email);
  const previous=(await db.query<{id:string}>(`update user_emails set login_enabled=false
    where user_id=$1 and not is_primary and login_enabled returning id`,[actor.id])).rows;
  if(previous.length) {
    await db.query("update auth_identities set status='revoked',email_id=null where user_id=$1 and provider='email_otp' and email_id=any($2::uuid[])",
      [actor.id,previous.map(row=>row.id)]);
    await revokeOtherSessions(db,actor,sessionHash);
  }
  const existing=(await db.query<{id:string}>(`select id from user_emails
    where user_id=$1 and normalized_email=$2 order by verified_at desc nulls last,id limit 1`,[actor.id,email])).rows[0];
  const saved=existing
    ?await one<{id:string}>(db,`update user_emails set verified_at=now(),login_enabled=true,delivery_state=null where id=$1 returning id`,[existing.id])
    :await one<{id:string}>(db,`insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
      values($1,$2::text,($2::text)::citext,now(),false,true) returning id`,[actor.id,email]);
  await addEmailOtpIdentity(db,actor.id,saved.id);
  await audit(db,actor,"verify_backup_email","user_emails",saved.id,{replaced_email_ids:previous.map(row=>row.id)});
  return {backup_email:email};
}

export async function requestEmailChange(actor:Actor,sessionHash:string,newEmail:string,browser:string,verificationEmailId?:string) {
  await requireCustomerReauth(pool as unknown as DB,actor,sessionHash);
  const target=newEmail.trim().toLowerCase();
  const conflict=(await pool.query("select 1 from user_emails where normalized_email=$1 and login_enabled",[target])).rowCount;
  guard(!conflict,"EMAIL_CHANGE_CONFLICT","That email address cannot be used for this change.",409);
  const current=await one<{email:string}>(pool as unknown as DB,
    "select normalized_email::text as email from user_emails where user_id=$1 and is_primary",[actor.id]);
  guard(current.email!==target,"EMAIL_CHANGE_CONFLICT","Enter a different email address than your current primary email.",409);
  const verificationEmail=await trustedSecurityEmail(pool,actor,verificationEmailId);
  const curOtp=await startOtp(verificationEmail,browser,undefined,"change_email",actor.id);
  const newOtp=await startOtp(target,browser,undefined,"change_email_new",actor.id);
  return {
    current_challenge_id:curOtp.challenge_id,
    new_challenge_id:newOtp.challenge_id,
    verification_email:verificationEmail,
    resend_after:60,
    ...(curOtp.demo_code?{current_demo_code:curOtp.demo_code}:{}),
    ...(newOtp.demo_code?{new_demo_code:newOtp.demo_code}:{}),
  };
}

export async function confirmEmailChange(
  db:DB,actor:Actor,sessionHash:string,browser:string,
  input:{current_challenge_id:string;current_code:string;new_challenge_id:string;new_code:string}
) {
  await requireCustomerReauth(db,actor,sessionHash);
  guard(input.current_challenge_id!==input.new_challenge_id,"INVALID_REQUEST","Provide both current and new email verification challenges.",422);
  const curC=await consumeChallengeCode(db,input.current_challenge_id,input.current_code,browser,"change_email",actor.id,true);
  const newC=await consumeChallengeCode(db,input.new_challenge_id,input.new_code,browser,"change_email_new",actor.id);
  const newEmail=newC.target_email.trim().toLowerCase();
  await lock(db,"email:"+newEmail);
  await one(db,"select id from users where id=$1 for update",[actor.id]);
  const primary=await one<{id:string;email:string}>(db,
    "select id,normalized_email::text as email from user_emails where user_id=$1 and is_primary for update",[actor.id]);
  await requireCustomerReauth(db,actor,sessionHash);
  await trustedSecurityEmail(db,actor,undefined,curC.target_email);
  const conflict=(await db.query("select 1 from user_emails where normalized_email=$1 and login_enabled",[newEmail])).rowCount;
  guard(!conflict&&newEmail!==primary.email,"EMAIL_CHANGE_CONFLICT","That email address cannot be used for this change.",409);
  await db.query("update verification_challenges set consumed_at=now() where id=$1",[curC.id]);
  await db.query("update user_emails set is_primary=false,login_enabled=false where id=$1",[primary.id]);
  const existingUserEmail=(await db.query<{id:string}>("select id from user_emails where user_id=$1 and normalized_email=$2 for update",[actor.id,newEmail])).rows[0];
  const nextEmail=existingUserEmail
    ?await one<{id:string;original_email:string}>(db,
        "update user_emails set original_email=$2,verified_at=now(),is_primary=true,login_enabled=true,delivery_state=null where id=$1 returning id,original_email",
        [existingUserEmail.id,newEmail])
    :await one<{id:string;original_email:string}>(db,
        `insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
         values($1,$2::text,($2::text)::citext,now(),true,true) returning id,original_email`,
        [actor.id,newEmail]);
  await db.query("update auth_identities set status='revoked',email_id=null where user_id=$1 and provider='email_otp' and email_id=$2",[actor.id,primary.id]);
  await addEmailOtpIdentity(db,actor.id,nextEmail.id);
  await db.query("update verification_challenges set consumed_at=now() where target_email=$1 and consumed_at is null",[primary.email]);
  await db.query("update sessions set revoked_at=now() where user_id=$1 and token_hash<>$2 and revoked_at is null",[actor.id,sessionHash]);
  await db.query(`insert into notifications(user_id,template,locale,payload,dedupe_key)
    values($1,'account.email_changed','en',$2,$3) on conflict(dedupe_key) do nothing`,
    [actor.id,{previous_email:primary.email,new_email:newEmail},"email-change:"+actor.id+":"+nextEmail.id+":"+Date.now()]);
  await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$1,'email_changed','succeeded',$2)",[actor.id,uuid()]);
  await audit(db,actor,"change_primary_email","user_emails",nextEmail.id,{previous_email_id:primary.id});
  return {primary_email:nextEmail.original_email,revoked_other_sessions:true};
}

export async function listSessions(db:DB,actor:Actor,sessionHash:string) {
  organization(actor);
  const rows=(await db.query(`select id,kind,created_at,expires_at,mfa_at,reauth_at,
    coalesce(user_agent,'Browser session') as device,(token_hash=$2) as current
    from sessions where user_id=$1 and revoked_at is null and expires_at>now()
    order by (token_hash=$2) desc,created_at desc`,[actor.id,sessionHash])).rows;
  return {sessions:rows};
}

export async function revokeSession(db:DB,actor:Actor,sessionId:string) {
  organization(actor);
  const r=await db.query("update sessions set revoked_at=now() where id=$1 and user_id=$2 and revoked_at is null returning id",[sessionId,actor.id]);
  guard(r.rowCount,"NOT_FOUND","Session not found.",404);
  await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$1,'session_revoked','succeeded',$2)",[actor.id,uuid()]);
  await audit(db,actor,"revoke_session","sessions",sessionId);
  return {id:sessionId,revoked:true};
}

export async function revokeOtherSessions(db:DB,actor:Actor,sessionHash:string) {
  await requireCustomerReauth(db,actor,sessionHash);
  const r=await db.query("update sessions set revoked_at=now() where user_id=$1 and token_hash<>$2 and revoked_at is null",[actor.id,sessionHash]);
  await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$1,'revoke_other_sessions','succeeded',$2)",[actor.id,uuid()]);
  await audit(db,actor,"revoke_other_sessions","sessions",null,{revoked_count:r.rowCount??0});
  return {revoked_count:r.rowCount??0};
}

export async function requestAccountRecovery(
  db:DB,browser:string,input:{challenge_id:string;code:string;previous_email:string;details:string}
) {
  const c=await consumeChallengeCode(db,input.challenge_id,input.code,browser,"recovery");
  const contactEmail=c.target_email.trim().toLowerCase();
  const prevEmail=input.previous_email.trim().toLowerCase();
  const matched=(await db.query<{user_id:string;org_id:string|null}>(
    `select u.id as user_id,p.org_id from user_emails e join users u on u.id=e.user_id
     left join customer_receiving_profiles p on p.user_id=u.id
     where e.normalized_email=$1 and u.status<>'closed' order by e.is_primary desc limit 1`,
    [prevEmail]
  )).rows[0];
  const requestId=uuid(),ticketId=uuid(),statusToken=token();
  await db.query(
    `insert into tickets(id,public_no,org_id,category,state,subject,details)
     values($1,$2,$3,'recovery','open','Account recovery request',$4)`,
    [ticketId,code("REC-"),matched?.org_id??null,{request_id:requestId,contact_email:contactEmail,previous_email:prevEmail,note:input.details}]
  );
  const payload=seal(JSON.stringify({contact_email:contactEmail,previous_email:prevEmail,token_hash:hash(statusToken),details:input.details}));
  await db.query(
    `insert into recovery_requests(id,user_id,target_ciphertext,evidence_ticket_id,state,verified_at)
     values($1,$2,$3,$4,'pending_review',now())`,
    [requestId,matched?.user_id??null,payload,ticketId]
  );
  return {request_id:requestId,status_token:statusToken,state:"pending_review"};
}

export async function readAccountRecoveryStatus(db:DB,requestId:string,statusToken:string) {
  const r=await one<{id:string;target_ciphertext:Buffer;state:string;verified_at:Date|null;execute_after:Date|null;executed_at:Date|null}>(
    db,"select id,target_ciphertext,state,verified_at,execute_after,executed_at from recovery_requests where id=$1",[requestId]
  );
  const payload=JSON.parse(unseal(r.target_ciphertext)) as {token_hash:string};
  const candidate=hash(statusToken);
  guard(candidate.length===payload.token_hash.length && timingSafeEqual(Buffer.from(candidate),Buffer.from(payload.token_hash)),
    "NOT_FOUND","Recovery request not found.",404);
  return {request_id:r.id,state:r.state,verified_at:r.verified_at,execute_after:r.execute_after,executed_at:r.executed_at};
}

export async function runOtpVerification<T>(verify:(db:DB)=>Promise<T>) {
  const result=await transaction(async db=>{
    try {
      return await verify(db);
    } catch (error) {
      // Commit the failed OTP attempt before returning the error.
      if(error instanceof Problem&&error.code==="OTP_INVALID") return error;
      throw error;
    }
  });
  if(result instanceof Problem) throw result;
  return result;
}

export async function readRecoveryProgress(db:DB,browser:string,input:{challenge_id:string;code:string}) {
  const challenge=await consumeChallengeCode(db,input.challenge_id,input.code,browser,"recovery_status");
  const {rows}=await db.query<{reference:string;submitted_at:Date;state:string;execute_after:Date|null}>(
    `select t.public_no as reference,t.created_at as submitted_at,r.state,r.execute_after
     from recovery_requests r join tickets t on t.id=r.evidence_ticket_id
     where t.category='recovery' and t.details->>'contact_email'=$1 and r.verified_at is not null
     order by t.created_at desc,r.id desc limit 10`,
    [challenge.target_email]
  );
  return {requests:rows};
}

export async function decideAccountRecovery(
  db:DB,actor:Actor,requestId:string,action:"approve"|"reject",input:{reason:string;emergency?:boolean},sessionHash:string
) {
  role(actor,"support","super_admin");
  const r=await one<{id:string;user_id:string|null;state:string;requested_by:string|null;approved_by:string|null;execute_after:Date|null;evidence_ticket_id:string}>(
    db,"select * from recovery_requests where id=$1 for update",[requestId]
  );
  if(action==="reject") {
    guard(!["executed","rejected"].includes(r.state),"RECOVERY_NOT_MODIFIABLE","This recovery request has already been finalized.");
    await db.query("update recovery_requests set state='rejected',requested_by=coalesce(requested_by,$2) where id=$1",[requestId,actor.id]);
    await db.query("update tickets set state='resolved',resolved_at=now() where id=$1",[r.evidence_ticket_id]);
    await audit(db,actor,"reject_account_recovery","recovery_requests",requestId,{reason:input.reason});
    return {request_id:requestId,state:"rejected"};
  }
  if(r.state==="approved") {
    return {request_id:requestId,state:"approved",execute_after:r.execute_after};
  }
  guard(r.user_id,"RECOVERY_TARGET_MISSING","Cannot approve recovery without a verified target customer account.",422);
  if(!r.requested_by) {
    await db.query("update recovery_requests set state='awaiting_approval',requested_by=$2 where id=$1",[requestId,actor.id]);
    await audit(db,actor,"recommend_account_recovery","recovery_requests",requestId,{reason:input.reason});
    return {request_id:requestId,state:"awaiting_approval"};
  }
  role(actor,"super_admin");
  await requireStaffMfa(db,actor,sessionHash,15);
  guard(r.requested_by!==actor.id,"SELF_REVIEW_FORBIDDEN","Account recovery approval requires an independent administrator.",403);
  const updated=await one<{execute_after:Date}>(db,
    `update recovery_requests set state='approved',approved_by=$2,
       execute_after=case when $3 then now() else now()+interval '24 hours' end
     where id=$1 returning execute_after`,
    [requestId,actor.id,Boolean(input.emergency)]
  );
  await audit(db,actor,"approve_account_recovery","recovery_requests",requestId,{reason:input.reason,emergency:Boolean(input.emergency)});
  return {request_id:requestId,state:"approved",execute_after:updated.execute_after};
}

export async function executeAccountRecovery(db:DB,actor:Actor,requestId:string,sessionHash:string) {
  role(actor,"super_admin","support");
  await requireStaffMfa(db,actor,sessionHash,15);
  const r=await one<{id:string;user_id:string|null;target_ciphertext:Buffer;state:string;requested_by:string|null;approved_by:string|null;execute_after:Date|null;executed_at:Date|null;evidence_ticket_id:string}>(
    db,"select * from recovery_requests where id=$1 for update",[requestId]
  );
  if(r.state==="executed") return {request_id:requestId,state:"executed",executed_at:r.executed_at};
  guard(r.state==="approved" && r.user_id && r.approved_by && r.requested_by && r.approved_by!==r.requested_by,
    "RECOVERY_NOT_APPROVED","Account recovery must be independently approved before execution.");
  guard(r.execute_after && new Date(r.execute_after)<=new Date(),
    "RECOVERY_COOLDOWN_ACTIVE","The recovery cooldown window has not elapsed yet.");
  const payload=JSON.parse(unseal(r.target_ciphertext)) as {contact_email:string};
  const targetEmail=payload.contact_email.trim().toLowerCase();
  await lock(db,"email:"+targetEmail);
  await one(db,"select id from users where id=$1 for update",[r.user_id]);
  const conflict=(await db.query("select 1 from user_emails where normalized_email=$1 and login_enabled and user_id<>$2",[targetEmail,r.user_id])).rowCount;
  guard(!conflict,"EMAIL_CHANGE_CONFLICT","The approved recovery email is already in use by another account.",409);
  await db.query("update auth_identities set status='revoked',email_id=null where user_id=$1",[r.user_id]);
  await db.query("update user_emails set is_primary=false,login_enabled=false where user_id=$1",[r.user_id]);
  await db.query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null",[r.user_id]);
  const existingEmail=(await db.query<{id:string}>("select id from user_emails where user_id=$1 and normalized_email=$2 for update",[r.user_id,targetEmail])).rows[0];
  const emailRow=existingEmail
    ?await one<{id:string}>(db,
        "update user_emails set original_email=$2,verified_at=now(),is_primary=true,login_enabled=true,delivery_state=null where id=$1 returning id",
        [existingEmail.id,targetEmail])
    :await one<{id:string}>(db,
        `insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
         values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,
        [r.user_id,targetEmail]);
  await addEmailOtpIdentity(db,r.user_id,emailRow.id);
  await db.query("update users set status='active',auth_version=auth_version+1,updated_at=now() where id=$1",[r.user_id]);
  const done=await one<{executed_at:Date}>(db,"update recovery_requests set state='executed',executed_at=now() where id=$1 returning executed_at",[requestId]);
  await db.query("update tickets set state='resolved',resolved_at=now() where id=$1",[r.evidence_ticket_id]);
  await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$2,'account_recovered','succeeded',$3)",
    [r.user_id,actor.id,uuid()]);
  await audit(db,actor,"execute_account_recovery","recovery_requests",requestId,{user_id:r.user_id});
  return {request_id:requestId,state:"executed",executed_at:done.executed_at};
}

export async function closeCustomerAccount(db:DB,actor:Actor,sessionHash:string) {
  await requireCustomerReauth(db,actor,sessionHash);
  const org=organization(actor);
  await lock(db,"org:"+org);
  await one(db,"select id from users where id=$1 for update",[actor.id]);
  const activeItems=(await db.query("select 1 from warehouse_items where org_id=$1 and custody_state in ('received','stored') limit 1",[org])).rowCount;
  const activeOrders=(await db.query("select 1 from orders where org_id=$1 and state not in ('closed','cancelled') limit 1",[org])).rowCount;
  const unpaidCharges=(await db.query("select 1 from charge_items where org_id=$1 and voided_at is null and applied_payment_id is null and free_authorization is null limit 1",[org])).rowCount;
  guard(!activeItems && !activeOrders && !unpaidCharges,
    "ACCOUNT_HAS_ACTIVE_OBLIGATIONS","Resolve open orders, unpaid charges, or stored items before closing your account.",409);
  await db.query("update auth_identities set status='revoked',email_id=null where user_id=$1",[actor.id]);
  await db.query("update user_emails set is_primary=false,login_enabled=false where user_id=$1",[actor.id]);
  await db.query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null",[actor.id]);
  await db.query("update users set status='closed',auth_version=auth_version+1,updated_at=now() where id=$1",[actor.id]);
  await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$1,'account_closed','succeeded',$2)",[actor.id,uuid()]);
  await audit(db,actor,"close_customer_account","users",actor.id);
  return {closed:true};
}

export async function staffUpdateUserStatus(
  db:DB,actor:Actor,targetUserId:string,input:{status:"active"|"restricted"|"disabled";reason:string},sessionHash:string
) {
  role(actor,"super_admin");
  await requireStaffMfa(db,actor,sessionHash,15);
  const u=await one<{id:string;status:string}>(db,"select id,status from users where id=$1 for update",[targetUserId]);
  guard(u.status!=="closed","ACCOUNT_CLOSED","Closed accounts cannot be reopened via status toggle.",409);
  await db.query(
    `update users set status=$2,auth_version=case when $2='disabled' then auth_version+1 else auth_version end,updated_at=now() where id=$1`,
    [targetUserId,input.status]
  );
  if(input.status==="disabled") {
    await db.query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null",[targetUserId]);
  }
  await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$2,$3,'succeeded',$4)",
    [targetUserId,actor.id,"staff_status_"+input.status,uuid()]);
  await audit(db,actor,"staff_update_user_status","users",targetUserId,{previous_status:u.status,status:input.status,reason:input.reason});
  return {user_id:targetUserId,status:input.status};
}

export async function staffUpdateUserRoles(
  db:DB,
  actor:Actor,
  targetUserId:string,
  input:{roles:("receiver"|"inspector"|"reviewer"|"warehouse_admin"|"support"|"super_admin"|"template_admin"|"finance")[];reason:string},
  sessionHash:string
) {
  role(actor,"super_admin");
  await requireStaffMfa(db,actor,sessionHash,15);
  await one(db,"select id from users where id=$1 for update",[targetUserId]);
  const nextRoles=[...new Set(input.roles)];
  guard(actor.id!==targetUserId || nextRoles.includes("super_admin"),
    "SELF_LOCKOUT_FORBIDDEN","Super administrators cannot remove their own super_admin role.",409);
  const prev=(await db.query<{role:string}>("select role from staff_roles where user_id=$1 order by role",[targetUserId])).rows.map(r=>r.role);
  await db.query("delete from staff_roles where user_id=$1",[targetUserId]);
  for(const r of nextRoles) {
    await db.query("insert into staff_roles(user_id,role) values($1,$2)",[targetUserId,r]);
  }
  await db.query("update users set auth_version=auth_version+1,updated_at=now() where id=$1",[targetUserId]);
  await db.query("insert into account_security_events(user_id,actor_id,kind,outcome,request_id) values($1,$2,'staff_roles_updated','succeeded',$3)",
    [targetUserId,actor.id,uuid()]);
  await audit(db,actor,"staff_update_user_roles","users",targetUserId,{
    reason:input.reason.trim(),
    count:nextRoles.length,
    before_roles:prev,
    after_roles:nextRoles,
  });
  return {user_id:targetUserId,roles:nextRoles};
}

export { seal as encryptSecret };
export { unseal as decryptSecret };
