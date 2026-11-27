import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { actorForSession, customerWorkspaceProfile } from "../../packages/core/auth";
import { pool } from "../../packages/db";
import { isDemo } from "../../packages/core/common";
import { getLocalePreferencesForActor } from "../../packages/core/i18n-service";
import { signInMethods } from "../../packages/core/integrations";
import { resolveAccountLocalePreferences, resolveLocalizedPublicPath } from "../../packages/core/locale-contract";
import { customerDestination, resolvePortalRoute, withDestination } from "../../packages/core/portal-routes";
import { AccessShell, AccountRecovery, Login, Onboarding } from "../account-access";
import { PublicHomePage } from "../page";
import { Portal } from "../portal";
import { metadataForPath } from "../public-seo";

type Search = Record<string,string|string[]|undefined>;

const PUBLIC_MARKETING_VIEWS = new Set([
  "public-home",
  "catalog",
  "how-it-works",
  "faq",
  "report-guide",
  "public-inquiry",
  "legal",
]);

export async function generateMetadata({params,searchParams}:{params:Promise<{page:string[]}>;searchParams:Promise<Search>}): Promise<Metadata> {
  const {page} = await params;
  if (page.some(segment => segment.includes("/"))) return {};
  const path = "/" + page.join("/");
  const route = resolvePortalRoute(path);
  if (!route) return {};
  const isMarketing = route.area === "public" && PUBLIC_MARKETING_VIEWS.has(route.view);
  const next = route.view === "staff-login" ? (await searchParams).next : undefined;
  return metadataForPath(path, isMarketing, route, typeof next === "string" ? next : undefined);
}

export default async function Page({params,searchParams}:{params:Promise<{page:string[]}>;searchParams:Promise<Search>}) {
  const {page}=await params;
  if(page.some(segment=>segment.includes("/"))) notFound();
  const path="/"+page.join("/");
  const route=resolvePortalRoute(path);
  const demo=isDemo();
  if(!route || route.view==="demo" && !demo) notFound();

  const jar=await cookies();
  const hdrs=await headers();
  const actor=await actorForSession(jar.get("session")?.value);
  let target=path;
  if(route.area!=="public") {
    const search=new URLSearchParams();
    for(const [key,values] of Object.entries(await searchParams)) {
      if(typeof values==="string") search.append(key,values);
      else values?.forEach(value=>search.append(key,value));
    }
    if(search.size) target+="?"+search;
  }
  if(!actor && route.area!=="public") {
    if(route.area==="customer") {
      const entry=jar.has("qcw_onboarding")?"/onboarding":"/login";
      redirect(withDestination(entry,customerDestination(target)));
    }
    redirect(withDestination("/staff/login",target));
  }
  if(route.view==="public-home") {
    return <PublicHomePage locale="zh-CN"/>;
  }
  if(route.view==="account-recovery") {
    const methods=await signInMethods(pool);
    return <AccessShell staff={false}><AccountRecovery emailAvailable={methods.email||methods.demo}/></AccessShell>;
  }
  if(route.view==="login"||route.view==="staff-login"||route.view==="onboarding") {
    const search=await searchParams;
    const next=typeof search.next==="string"?search.next:null;
    const customerNext=customerDestination(next);
    const staff=route.view==="staff-login";
    if(!staff&&actor?.kind==="customer") redirect(customerNext??"/account");
    if(route.view==="onboarding"&&!jar.has("qcw_onboarding")) redirect(withDestination("/login",customerNext));
    return <AccessShell staff={staff}>{route.view==="onboarding"?<Onboarding next={customerNext}/>:
      <Login staff={staff} methods={await signInMethods(pool)} next={staff?next:customerNext}
        verify={search.verify==="1"} oauth={typeof search.oauth==="string"?search.oauth:undefined}/>}</AccessShell>;
  }

  const profile=route.area==="customer"&&actor?.kind==="customer"?await customerWorkspaceProfile(pool,actor):null;
  const acctPrefs=actor?await getLocalePreferencesForActor(pool,actor).catch(()=>null):null;
  const surface=route.area==="public"?"public":route.area==="customer"?"customer":"staff";
  const initialLocale=resolveAccountLocalePreferences({
    surface,
    explicitRouteLocale:route.area==="public"?resolveLocalizedPublicPath(path).locale:null,
    manualPreference:jar.get("qcw_locale")?.value??null,
    accountUiLocale:acctPrefs?.account_saved.ui_locale??null,
    accountNotificationLocale:acctPrefs?.account_saved.notification_locale??null,
    accountReportLocale:acctPrefs?.account_saved.report_locale==="both"?"en-US":(acctPrefs?.account_saved.report_locale??null),
    acceptLanguageHeader:hdrs.get("accept-language"),
  }).uiLocale;

  return <Portal path={path} target={target} route={route} actor={actor} demo={demo}
    timeZone={profile?.timezone??undefined} customerAccount={profile?.primary_email??profile?.display_name??undefined}
    initialLocale={initialLocale}/>;
}
