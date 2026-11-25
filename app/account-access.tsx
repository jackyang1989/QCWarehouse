"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { BRAND_NAME } from "../packages/core/brand";
import type { SignInMethods } from "../packages/core/integrations";
import { staffDestination, staffHome, withDestination } from "../packages/core/portal-routes";
import { Brand } from "./chrome";
import { ErrorBlock, Form, RequestError, request, text, useLoad } from "./ui";

const oauthMessages:Record<string,string>={
  cancelled:"Sign-in was cancelled. Choose a sign-in method to continue.",
  failed:"We could not complete provider sign-in. Try again or use email.",
  link_required:"This email already has an account. Sign in using your existing method to access it.",
};

export function AccessShell({staff,children}:{staff:boolean;children:ReactNode}) {
  return <div className="access-page" lang={staff?"zh-CN":"en"}>
    <header className="access-header"><Brand/><Link href="/">{staff?"返回官网":"Back to website"}</Link></header>
    <main className="access-main" id="main-content">{children}</main>
    <footer className="access-footer"><Link href="/legal/privacy">{staff?"隐私政策":"Privacy"}</Link>
      <Link href="/contact">{staff?"联系支持":"Contact support"}</Link></footer>
  </div>;
}

type Challenge={challenge_id:string;demo_code?:string};
type SignInResult={kind:"staff"|"customer";state:"onboarding"|"signed_in"};

export function Login({staff,methods,next,verify,oauth}:{
  staff:boolean;methods:SignInMethods;next:string|null;verify:boolean;oauth?:string;
}) {
  const [challenge,setChallenge]=useState<Challenge>();
  const [email,setEmail]=useState("");
  const [demoBusy,setDemoBusy]=useState(false);
  const [demoError,setDemoError]=useState("");
  const emailAvailable=methods.email||methods.demo;

  async function after(result:SignInResult) {
    if(result.kind==="staff") {
      const {actor}=await request("/me");
      const preferred=next?.startsWith("/wh")?"warehouse":"admin";
      location.assign(staffDestination(next,actor.roles)??staffHome(actor.roles,preferred)??"/staff/login");
      return;
    }
    location.assign(result.state==="onboarding"?withDestination("/onboarding",staff?null:next):staff?"/account":next??"/account");
  }

  async function sendCode(address:string) {
    setChallenge(await request("/auth/otp/request","POST",{email:address}));
    setEmail(address);
  }

  async function quickDemoSignIn(address:string) {
    setDemoError("");
    setDemoBusy(true);
    try {
      try {
        const switched:SignInResult=await request("/auth/demo/switch","POST",{email:address});
        await after(switched);
        return;
      } catch(error) {
        if(!(error instanceof RequestError) || !["DEMO_UNAVAILABLE","ACCOUNT_NOT_FOUND"].includes(error.code??"")) {
          throw error;
        }
      }
      const c:Challenge=await request("/auth/otp/request","POST",{email:address});
      if(c.demo_code) {
        const res:SignInResult=await request("/auth/otp/verify","POST",{challenge_id:c.challenge_id,code:c.demo_code});
        await after(res);
      } else {
        setChallenge(c);
        setEmail(address);
      }
    } catch(error) {
      setDemoError(error instanceof Error?error.message:"Sign-in failed. Try again.");
    } finally {
      setDemoBusy(false);
    }
  }

  return <section className="panel access-card" aria-labelledby="access-title">
    <p className="eyebrow">{staff?`${BRAND_NAME} 员工工作区`:`${BRAND_NAME} customer account`}</p>
    <h1 id="access-title">{staff?"员工登录":"Sign in or create an account"}</h1>
    <p className="muted">{staff?"登录后进入已获授权的仓库或运营页面。":"Sign in to open your workspace. New customers get a personal warehouse receiving code after registration."}</p>
    {!staff&&next&&<p className="notice">You’ll return to your requested page after signing in.</p>}
    {!staff&&oauth&&Object.hasOwn(oauthMessages,oauth)&&<ErrorBlock error={oauthMessages[oauth]}/>}
    {!staff&&!challenge&&<div className="sign-in-methods">
      {(["google","microsoft"] as const).map(provider=>{
        const label=provider==="google"?"Google":"Microsoft";
        return methods[provider]?<a className="button" key={provider} href={withDestination("/api/v1/auth/"+provider+"/start",next)}>Continue with {label}</a>:
          <div className="sign-in-unavailable" key={provider}><span>{label}</span><small>Currently unavailable</small></div>;
      })}
    </div>}
    {methods.demo&&<div className="notice">
      <strong>{staff?"本地测试环境 · 一键切换岗位账号":"Local Demo Environment · One-Click Test Sign-In"}</strong>
      <div className="actions" style={{marginTop:8,marginBottom:4}}>
        {staff?(
          [
            ["admin@qcw.test","超级管理员 / 财务 / 客服 (admin)"],
            ["receiving@qcw.test","收货与仓管 (receiving)"],
            ["inspector@qcw.test","质检员 / 模板管理 (inspector)"],
            ["reviewer@qcw.test","报告复核员 (reviewer)"],
          ].map(([addr,label])=><button key={addr} type="button" className="button sm primary" disabled={demoBusy} onClick={()=>void quickDemoSignIn(addr)}>{label}</button>)
        ):(
          <button type="button" className="button sm primary" disabled={demoBusy} onClick={()=>void quickDemoSignIn("customer@qcw.test")}>
            {demoBusy?"Signing in…":"One-click sign in: Demo Customer (customer@qcw.test) →"}
          </button>
        )}
      </div>
      {demoError&&<ErrorBlock error={demoError}/>}
    </div>}
    {staff&&<Form label="密码与验证器登录" run={async f=>after(await request("/staff/auth/login","POST",{
      email:text(f,"email"),password:String(f.get("password")??""),otp:text(f,"otp"),
    }))}>
      <label>员工邮箱<input name="email" type="email" autoComplete="username" required/></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required/></label>
      <label>验证器动态码<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required/></label>
    </Form>}
    {(!staff||methods.demo)&&<div className={staff?undefined:"email-sign-in"}>
      {!staff&&<h2>{verify?"Verify your email":"Sign in with email"}</h2>}
      {!staff&&verify&&!challenge&&<p className="muted small">Verify your contact email to finish signing in with your provider.</p>}
      {!staff&&!verify&&!challenge&&<p className="muted small">Use your primary or verified backup email to sign in. New customers can use any email they can access.</p>}
      {challenge?
      <div className="code-step">
        <p>{staff?"测试账号":challenge.demo_code?"Test code for":"Code sent to"} <strong>{email}</strong></p>
        {challenge.demo_code&&<p className="code">{challenge.demo_code}</p>}
        <Form key={challenge.challenge_id} label={staff?"验证并登录":"Verify code"} run={async f=>after(await request("/auth/otp/verify","POST",{
          challenge_id:challenge.challenge_id,code:text(f,"code"),
        }))}>
          <label>{staff?"验证码":"Verification code"}<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required/></label>
        </Form>
        <button type="button" onClick={()=>setChallenge(undefined)}>{staff?"更换邮箱或重新获取验证码":"Change email or request another code"}</button>
      </div>:<Form submitDisabled={!emailAvailable} label={methods.demo?(staff?"获取测试验证码":"Get test code"):"Send verification code"} run={f=>sendCode(text(f,"email"))}>
        <label>{staff?"测试员工邮箱 (@qcw.test)":"Email address"}<input name="email" type="email" autoComplete="email" defaultValue={email} required aria-describedby={emailAvailable?undefined:"email-sign-in-status"}/></label>
      </Form>}
      {!staff&&!emailAvailable&&<p className="muted small" id="email-sign-in-status">Email verification codes are currently unavailable.</p>}
    </div>}
    {!staff&&<p className="small sign-in-recovery"><Link href="/account/recovery">Request account recovery</Link></p>}
  </section>;
}

type RecoveryStatus={
  reference:string;
  submitted_at:string;
  state:string;
  execute_after:string|null;
};

const recoveryStatusMessages:Record<string,string>={
  pending_review:"Request received. Our support team will review the information you provided.",
  awaiting_approval:"Your request has been reviewed and is waiting for a second review.",
  approved:"Your request was approved. We still need to finish updating your account.",
  executed:"Your account is ready. Sign in with the new email address you verified.",
  rejected:"We couldn't approve your request. Contact support if you can provide more information.",
};

export function AccountRecovery({emailAvailable}:{emailAvailable:boolean}) {
  const [checking,setChecking]=useState(false);
  const [challenge,setChallenge]=useState<Challenge>();
  const [targetEmail,setTargetEmail]=useState("");
  const [submittedEmail,setSubmittedEmail]=useState<string>();
  const [results,setResults]=useState<RecoveryStatus[]>();

  function changeMode(checkProgress:boolean) {
    setChecking(checkProgress);
    setChallenge(undefined);
    setResults(undefined);
    if(checkProgress&&submittedEmail) setTargetEmail(submittedEmail);
  }

  const title=checking?"Check recovery progress":submittedEmail?"Recovery request received":"Recover your account";

  return <section className="panel access-card" aria-labelledby="access-title">
    <h1 id="access-title">{title}</h1>
    {checking&&results?<div aria-live="polite">
      {results.length===0?<p className="notice">We couldn't find a recovery request submitted with this email. Check the address you used or <Link href="/contact">contact support</Link>.</p>:
        <ul className="recovery-results">{results.map(result=><li className="notice" key={result.reference}>
          <p className="small muted">Request {result.reference} · {new Date(result.submitted_at).toLocaleDateString(undefined,{dateStyle:"medium"})}</p>
          <p>{recoveryStatusMessages[result.state]??"We couldn't display the current status. Contact support for help."}</p>
          {result.state==="approved"&&result.execute_after&&Date.parse(result.execute_after)>Date.now()&&
            <p>For your security, the account can be updated after {new Date(result.execute_after).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"})} (your local time).</p>}
          {result.state==="executed"&&<Link href="/login">Sign in with your new email</Link>}
          {result.state==="rejected"&&<Link href="/contact">Contact support</Link>}
        </li>)}</ul>}
      <button className="button" type="button" onClick={()=>changeMode(true)}>Check again or use a different email</button>
    </div>:!checking&&submittedEmail?<div role="status">
      <p>Our support team will review your request. Use <strong>{submittedEmail}</strong> to check progress whenever you need to, even from another device.</p>
      <p>If your request is approved and the update is complete, sign in with that email to access your original account.</p>
    </div>:challenge?<div className="code-step">
      <p>{challenge.demo_code?"Test code for":"We sent a verification code to"} <strong>{targetEmail}</strong>.</p>
      {challenge.demo_code&&<p className="code">{challenge.demo_code}</p>}
      <Form key={challenge.challenge_id} label={checking?"Show my requests":"Submit recovery request"} idempotent={!checking} run={async (f,key)=>{
        const verification={challenge_id:challenge.challenge_id,code:text(f,"code")};
        if(checking) {
          const response=await request("/auth/recovery/status","POST",verification);
          setResults(response.requests);
        } else {
          await request("/auth/recovery/request","POST",{
            ...verification,previous_email:text(f,"previous_email"),details:text(f,"details"),
          },key);
          setSubmittedEmail(targetEmail);
        }
        setChallenge(undefined);
      }}>
        <label>6-digit verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required/></label>
        {!checking&&<>
          <label>Email address on your old account<input name="previous_email" type="email" required aria-describedby="old-email-help"/></label>
          <p className="muted small" id="old-email-help">Enter the email you used to sign in. You can do this even if the inbox is closed or blocked.</p>
          <label>Details to help us verify your account<textarea name="details" required minLength={4} maxLength={2000} aria-describedby="recovery-evidence-help"/></label>
          <p className="muted small" id="recovery-evidence-help">Include details you know, such as an order number and payment date or your warehouse receiving code. Leave out passwords and card numbers.</p>
        </>}
      </Form>
      <button className="button top-gap" type="button" onClick={()=>setChallenge(undefined)}>Change email or request a new code</button>
    </div>:<>
      <p className="muted">{checking?
        "Enter the email you used when you requested recovery. We'll send a verification code to that inbox so you can check your progress without signing in.":
        `If you lost access to your Google, Microsoft, or email sign-in, use an email address you can open today. You can use an address you’ve never added to ${BRAND_NAME}. The verification code goes to this new inbox.`}</p>
      {emailAvailable?<Form label="Send verification code" run={async f=>{
        const address=text(f,"target_email");
        setChallenge(await request("/auth/otp/request","POST",{email:address,purpose:checking?"recovery_status":"recovery"}));
        setTargetEmail(address);
      }}>
        <label>{checking?"Email used for recovery":"New email address"}<input name="target_email" type="email" autoComplete="email" defaultValue={targetEmail} required/></label>
      </Form>:<div className="notice">Recovery verification emails are currently unavailable. <Link href="/contact">Contact support</Link> for help.</div>}
    </>}
    <div className="recovery-navigation">
      {checking?<button className="button" type="button" onClick={()=>changeMode(false)}>Back to account recovery</button>:
        !challenge&&<button className="button" type="button" onClick={()=>changeMode(true)}>
          {submittedEmail?"Check my progress":"Already submitted a request?"}
        </button>}
      <Link href="/login">Return to sign in</Link>
    </div>
  </section>;
}

export function Onboarding({next}:{next:string|null}) {
  const {data,error,reload}=useLoad("/public/terms");
  const terms=(data?.terms??[]).filter((t:{kind:string})=>t.kind==="terms"||t.kind==="privacy");
  return <section className="panel access-card" aria-labelledby="access-title">
    <p className="eyebrow">{BRAND_NAME} customer account</p>
    <h1 id="access-title">Activate your receiving address</h1><p className="muted">Review the account terms to get your permanent receiving code.</p>
    {!data&&!error&&<p role="status">Loading account terms…</p>}
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry</button></>}
    {data&&terms.length!==2&&<p role="alert">Account terms are unavailable. <Link href="/contact">Contact support</Link> to continue.</p>}
    {terms.length===2&&<Form label="Create my account" run={async f=>{
      if(f.get("accept")!=="on") throw new Error("Accept both policies to continue.");
      await request("/auth/registration/complete","POST",{terms_version_ids:terms.map((t:{id:string})=>t.id)});
      location.assign(withDestination("/account",next));
    }}>
      {terms.map((t:{id:string;kind:string;version:string;content_md:string})=><details key={t.id}>
        <summary>{t.kind==="terms"?"Terms of service":"Privacy notice"} · {t.version}</summary><p className="policy-content">{t.content_md}</p></details>)}
      <label className="check"><input type="checkbox" name="accept" required/> I accept the terms of service and privacy notice.</label>
    </Form>}
    <p className="small"><Link href={withDestination("/login",next)}>Return to sign in</Link></p>
  </section>;
}
