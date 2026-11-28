"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BRAND_ASSETS, BRAND_NAME, BRAND_TAGLINE } from "../packages/core/brand";
import { t } from "../packages/core/i18n/messages";
import { localizePublicPath, type EnabledLocale } from "../packages/core/locale-contract";
import { PublicLanguageSwitcher, useLocale } from "./i18n-client";
import { request } from "./ui";
import type { Actor } from "../packages/core/common";

export function Brand({
  variant = "default",
  mode = "wordmark",
  className,
  locale: explicitLocale,
}: {
  variant?: "default" | "white";
  mode?: "wordmark" | "mark";
  className?: string;
  locale?: EnabledLocale;
} = {}) {
  const { locale: ctxLocale } = useLocale();
  const locale = explicitLocale ?? ctxLocale;
  const isMark = mode === "mark";
  const src = isMark
    ? (variant === "white" ? BRAND_ASSETS.openQcWhite : BRAND_ASSETS.openQc)
    : (variant === "white" ? BRAND_ASSETS.wordmarkWhite : BRAND_ASSETS.wordmark);
  const width = isMark ? BRAND_ASSETS.iconSize : BRAND_ASSETS.width;
  const height = isMark ? BRAND_ASSETS.iconSize : BRAND_ASSETS.height;
  return <Link
    className={`wordmark${isMark ? " wordmark-compact" : ""}${className ? ` ${className}` : ""}`}
    href={localizePublicPath("/", locale)}
    aria-label={`${BRAND_NAME} home`}
  >
    <img
      className={isMark ? "brand-open-qc-img" : "brand-wordmark-img"}
      src={src}
      alt=""
      width={width}
      height={height}
      decoding="sync"
      loading="eager"
    />
  </Link>;
}

export async function switchDemoPortal(targetHref:string, demoEmail:string) {
  try {
    await request("/auth/demo/switch","POST",{email:demoEmail});
  } catch {
    // Fall back to normal navigation when not in local demo mode
  }
  location.assign(targetHref);
}

export function QuickSwitch({active,actor,demo=false,locale:explicitLocale}:{active:"public"|"customer"|"warehouse"|"admin";actor?:Actor|null;demo?:boolean;locale?:EnabledLocale}) {
  const { locale: ctxLocale } = useLocale();
  const locale = explicitLocale ?? ctxLocale;
  const canCustomer = actor?.kind==="customer";
  const canWarehouse = actor?.kind==="staff" && actor.roles.some(r=>["receiver","warehouse_admin","inspector","reviewer","super_admin"].includes(r));
  const canAdmin = actor?.kind==="staff" && actor.roles.some(r=>["super_admin","finance","support","template_admin"].includes(r));

  return <div className="quick-switch" role="navigation" aria-label="工作区切换">
    <Link href={localizePublicPath("/", locale)} className={active==="public"?"on":""}>{t(locale, "workspace.switchHome")}</Link>
    {(canCustomer || demo) && (
      <Link
        href="/orders"
        className={active==="customer"?"on":""}
        title={canCustomer?t(locale, "workspace.customerTitle"):"切换至演示客户账号"}
        onClick={canCustomer?undefined:(e=>{e.preventDefault();void switchDemoPortal("/orders","customer@qcw.test");})}
      >{t(locale, "workspace.switchCustomer")}</Link>
    )}
    {(canWarehouse || demo) && (
      <Link
        href="/wh"
        className={active==="warehouse"?"on":""}
        title={canWarehouse?t(locale, "workspace.warehouseTitle"):"切换至演示仓库账号"}
        onClick={canWarehouse?undefined:(e=>{e.preventDefault();void switchDemoPortal("/wh","admin@qcw.test");})}
      >{t(locale, "workspace.switchWarehouse")}</Link>
    )}
    {(canAdmin || demo) && (
      <Link
        href="/admin"
        className={active==="admin"?"on":""}
        title={canAdmin?t(locale, "workspace.adminTitle"):"切换至演示管理账号"}
        onClick={canAdmin?undefined:(e=>{e.preventDefault();void switchDemoPortal("/admin","admin@qcw.test");})}
      >{t(locale, "workspace.switchAdmin")}</Link>
    )}
  </div>;
}

const publicNavLinks: [string, string][] = [
  ["/catalog", "nav.public.services"],
  ["/categories", "nav.public.categories"],
  ["/how-it-works", "nav.public.howItWorks"],
  ["/report-guide", "nav.public.sampleReports"],
  ["/pricing", "nav.public.pricing"],
  ["/faq", "nav.public.faq"],
  ["/contact", "nav.public.contact"],
];

export function PublicHeader({accountHref,staff,path="/",actor,locale:explicitLocale}:{
  accountHref?:string;accountAction?:ReactNode;staff?:boolean;path?:string;actor?:Actor|null;demo?:boolean;locale?:EnabledLocale;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { locale: ctxLocale } = useLocale();
  const locale: EnabledLocale = explicitLocale ?? (path === "/zh" || path.startsWith("/zh/") ? "zh-CN" : ctxLocale);
  const canonicalPath = path === "/zh" ? "/" : path.startsWith("/zh/") ? (path.slice(3) || "/") : path;
  const hrefFor = (base: string) => localizePublicPath(base, locale);

  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const isActive = (href: string) =>
    canonicalPath === href || (href === "/catalog" && canonicalPath.startsWith("/services/"));

  const isCustomer = actor ? actor.kind === "customer" : (!staff && Boolean(accountHref));
  const customerHref = isCustomer ? (accountHref ?? "/account") : "/login";
  const customerLabel = isCustomer ? t(locale, "public.myWorkspace") : t(locale, "public.signIn");

  async function handleSignOut() {
    try {
      await request("/auth/logout", "POST");
    } finally {
      location.assign("/login");
    }
  }

  return <>
    <a className="skip-link" href="#main-content">{t(locale, "a11y.skipToContent")}</a>
    <header className="top public-top">
      <div className="public-top-inner">
        <div className="workspace-brand">
          <Brand locale={locale}/>
          <span className="workspace-context">{t(locale, "public.taglineHeader")}</span>
        </div>
        <nav className="public-nav" aria-label={t(locale, "a11y.primaryNav")}>
          {publicNavLinks.map(([href,key])=>(
            <Link key={href} href={hrefFor(href)} aria-current={isActive(href)?"page":undefined}>{t(locale, key)}</Link>
          ))}
        </nav>
        <div className="public-header-actions">
          <PublicLanguageSwitcher path={canonicalPath} authenticated={actor?.kind === "customer" || actor?.kind === "staff"} locale={locale}/>
          <Link className="button sm public-signin-btn" href={customerHref}>
            {customerLabel}
          </Link>
          {isCustomer && (
            <button type="button" className="button sm public-signout-btn" onClick={() => void handleSignOut()}>
              {t(locale, "public.signOut")}
            </button>
          )}
          <Link className="button primary sm public-cta-btn" href="/orders/new">
            {t(locale, "public.startInspection")}
          </Link>
          <button
            type="button"
            className="public-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="public-mobile-drawer"
            aria-label={menuOpen ? t(locale, "a11y.closeMenu") : t(locale, "a11y.openMenu")}
            onClick={() => setMenuOpen(v => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18"/> : <path d="M4 7h16M4 12h16M4 17h16"/>}
            </svg>
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="public-mobile-drawer" id="public-mobile-drawer">
          <nav aria-label={t(locale, "a11y.mobileNav")}>
            {publicNavLinks.map(([href,key])=>(
              <Link
                key={href}
                href={hrefFor(href)}
                aria-current={isActive(href)?"page":undefined}
                onClick={() => setMenuOpen(false)}
              >
                {t(locale, key)}
              </Link>
            ))}
          </nav>
          <div className="public-mobile-actions">
            <PublicLanguageSwitcher path={canonicalPath} authenticated={actor?.kind === "customer" || actor?.kind === "staff"} locale={locale}/>
            <Link className="button full" href={customerHref} onClick={() => setMenuOpen(false)}>
              {customerLabel}
            </Link>
            <Link className="button primary full" href="/orders/new" onClick={() => setMenuOpen(false)}>
              {t(locale, "public.startInspection")}
            </Link>
            {isCustomer && (
              <button
                type="button"
                className="button full public-mobile-signout"
                onClick={() => { setMenuOpen(false); void handleSignOut(); }}
              >
                {t(locale, "public.signOut")}
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  </>;
}

export function PublicFooter({
  locale:explicitLocale,
  path="/",
  authenticated=false,
}:{
  locale?:EnabledLocale;
  path?:string;
  authenticated?:boolean;
} = {}) {
  const { locale: ctxLocale } = useLocale();
  const locale = explicitLocale ?? ctxLocale;
  const canonicalPath = path === "/zh" ? "/" : path.startsWith("/zh/") ? (path.slice(3) || "/") : path;
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  return <footer className="public-footer">
    <div className="public-footer-inner">
      <div className="public-footer-grid">
        <div className="public-footer-brand">
          <Brand variant="white" locale={locale}/>
          <p className="public-footer-lead">
            {t(locale, "public.footerLead")}
          </p>
          <p className="public-footer-boundary">
            {t(locale, "public.footerBoundary", { brand: BRAND_NAME })}
          </p>
        </div>
        <div className="public-footer-col">
          <h4>{t(locale, "public.colServices")}</h4>
          <ul>
            <li><Link href={hrefFor("/catalog")}>{locale === "zh-CN" ? "服务项目总览" : "Services Overview"}</Link></li>
            <li><Link href={hrefFor("/services/inspection")}>{locale === "zh-CN" ? "实物商品质检" : "Product Inspection"}</Link></li>
            <li><Link href={hrefFor("/services/compare")}>{locale === "zh-CN" ? "供应商样品对比" : "Sample Comparison"}</Link></li>
            <li><Link href={hrefFor("/services/reference")}>{locale === "zh-CN" ? "确认样留存比对" : "Golden Sample Matching"}</Link></li>
            <li><Link href={hrefFor("/categories")}>{locale === "zh-CN" ? "支持检验类目" : "Product Categories"}</Link></li>
            <li><Link href={hrefFor("/pricing")}>{locale === "zh-CN" ? "收费标准与试算" : "Pricing & Estimator"}</Link></li>
          </ul>
        </div>
        <div className="public-footer-col">
          <h4>{t(locale, "public.colProcess")}</h4>
          <ul>
            <li><Link href={hrefFor("/how-it-works")}>{locale === "zh-CN" ? "仓内质检流程" : "How It Works"}</Link></li>
            <li><Link href={hrefFor("/report-guide")}>{locale === "zh-CN" ? "样板质检报告" : "Sample Inspection Report"}</Link></li>
            <li><Link href={hrefFor("/faq")}>{locale === "zh-CN" ? "常见问题帮助" : "FAQ & Help Center"}</Link></li>
            <li><Link href={hrefFor("/contact")}>{locale === "zh-CN" ? "联系定制范围" : "Contact & Custom Scope"}</Link></li>
          </ul>
        </div>
        <div className="public-footer-col">
          <h4>{t(locale, "public.colAccount")}</h4>
          <ul>
            <li><Link href="/login">{locale === "zh-CN" ? "客户登录" : "Customer Sign In"}</Link></li>
            <li><Link href="/orders/new">{t(locale, "public.startInspection")}</Link></li>
            <li><Link href={hrefFor("/legal/terms")}>{t(locale, "public.linkTerms")}</Link></li>
            <li><Link href={hrefFor("/legal/privacy")}>{t(locale, "public.linkPrivacy")}</Link></li>
            <li><Link href={hrefFor("/legal/restricted-items")}>{t(locale, "public.linkRestricted")}</Link></li>
            <li><Link href={hrefFor("/legal/report-notice")}>{t(locale, "public.linkReportNotice")}</Link></li>
          </ul>
        </div>
      </div>
      <div className="public-footer-bottom">
        <span>© {new Date().getFullYear()} {BRAND_NAME} · {BRAND_TAGLINE}</span>
        <div className="public-footer-meta">
          <PublicLanguageSwitcher path={canonicalPath} authenticated={authenticated} locale={locale} />
          <span aria-hidden="true">·</span>
          <Link href={hrefFor("/legal")}>{t(locale, "public.linkAllPolicies")}</Link>
          <span aria-hidden="true">·</span>
          <Link href={hrefFor("/contact")}>{t(locale, "nav.public.contact")}</Link>
          <span aria-hidden="true">·</span>
          <Link href="/staff/login" prefetch={false}>{t(locale, "public.linkStaffSignIn")}</Link>
        </div>
      </div>
    </div>
  </footer>;
}

export function SiteFooter({locale:explicitLocale}:{locale?:EnabledLocale} = {}) {
  const { locale: ctxLocale } = useLocale();
  const locale = explicitLocale ?? ctxLocale;
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  return <footer className="site-footer">
    <div><strong>{BRAND_NAME}</strong> · {BRAND_TAGLINE}</div>
    <nav aria-label={t(locale, "a11y.footerNav")}>
      <Link href={hrefFor("/faq")}>{t(locale, "nav.public.faq")}</Link>
      <Link href={hrefFor("/contact")}>{t(locale, "nav.public.contact")}</Link>
      <Link href={hrefFor("/legal/terms")}>{t(locale, "public.linkTerms")}</Link>
      <Link href={hrefFor("/legal/privacy")}>{t(locale, "public.linkPrivacy")}</Link>
      <Link href="/staff/login" prefetch={false}>{t(locale, "public.linkStaffSignIn")}</Link>
    </nav>
  </footer>;
}

export function InternalWorkspaceFooter({area,demo=false,timeZone="Asia/Shanghai",locale:explicitLocale}:{area:"admin"|"warehouse";demo?:boolean;timeZone?:string;locale?:EnabledLocale}) {
  const { locale: ctxLocale } = useLocale();
  const locale = explicitLocale ?? ctxLocale;
  const areaLabel = area === "admin" ? t(locale, "workspace.adminTitle") : t(locale, "workspace.warehouseTitle");
  return <footer className="site-footer internal-footer">
    <div>
      {t(locale, "workspace.internalFooter", { brand: BRAND_NAME, area: areaLabel, timeZone })}
    </div>
    <div className="muted small">
      {demo ? "当前为本地演示隔离环境 (QCW_DEMO=1)" : "受控生产/预发布环境"}
    </div>
  </footer>;
}

const iconPaths:Record<string,string>={
  add:"M4 4h16v16H4z M8 12h8 M12 8v8",
  overview:"M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  orders:"M6 3h9l4 4v14H5V3h1 M14 3v5h5 M8 12h8 M8 16h8",
  actions:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 8v4.5 M12 16h.01",
  packages:"M12 3 3 8v8l9 5 9-5V8l-9-5Z M3 8l9 5 9-5 M12 13v8 M7.5 5.5l9 5",
  items:"M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V4h9l8.6 7.6a2 2 0 0 1 0 2.8Z M7.5 7.5h.01",
  inspection:"M3 9V4h5 M16 4h5v5 M21 15v5h-5 M8 20H3v-5 M3 12h18",
  execute:"M9 3h6l1 2h4v16H4V5h4l1-2Z M9 13l2 2 4-4",
  sync:"M4 12a8 8 0 0 1 13.6-5.6L20 9 M20 4v5h-5 M20 12a8 8 0 0 1-13.6 5.6L4 15 M4 20v-5h5",
  review:"M12 3 5 6v5.5c0 4.6 3 8.7 7 9.5 4-.8 7-4.9 7-9.5V6l-7-3Z M9.2 11.8l2 2 3.8-3.8",
  dispatch:"M3 6h11v11H3z M14 10h4l3 3v4h-7 M7 17v2 M18 17v2",
  logistics:"M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10Z M12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  intake:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  storage:"M4 4h16v16H4z M4 10h16 M4 16h16 M10 4v16",
  stocktakes:"M9 5H5v15h14V5h-4 M9 3h6v4H9z M8 11h8 M8 15h5",
  finance:"M3 5h18v14H3z M3 9h18 M6 14h5 M15 14h3",
  payments:"M3 5h18v14H3z M3 9h18 M6 14h5 M15 14h3",
  refunds:"M3 10h11a5 5 0 0 1 0 10H9 M7 6 3 10l4 4",
  analytics:"M4 19h16 M7 16v-5 M12 16V7 M17 16v-8",
  settings:"M4 6h16 M4 12h16 M4 18h16 M9 4v4 M15 10v4 M8 16v4",
  reports:"M5 3h14v18H5z M8 16l3-4 2 2 3-5",
  compare:"M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4",
  scan:"M4 4h5M4 4v5M20 4h-5m5 0v5M4 20v-5m0 5h5m11 0h-5m5 0v-5M8 12h8",
  notifications:"M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0",
  support:"M4 5h16v11H9l-5 4V5Z M8 9h8 M8 12h5",
  incidents:"M12 4 3 19h18L12 4Z M12 10v4 M12 16.8h.01",
  catalog:"M12 3 3 7.5 12 12l9-4.5L12 3Z M3 12l9 4.5 9-4.5 M3 16.5 12 21l9-4.5",
  templates:"M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4",
  locations:"M3 5h18v14H3z M9 5v14 M15 5v14 M3 12h18",
  shipping_rates:"M4 5h16v14H4z M8 9h8 M8 13h4 M15 12l2 2 3-3",
  legal:"M12 3v18 M5 7h14 M7 7 4 13h6L7 7Z M17 7l-3 6h6l-3-6Z",
  users:"M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19 M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19 19v-1.5a3.5 3.5 0 0 0-2.5-3.35 M15.5 4.15a3.5 3.5 0 0 1 0 6.7",
  audit:"M12 4a8 8 0 1 0 8 8 M12 8v4l3 2 M20 4v4h-4",
  operations:"M3 12h4l2.5-6 5 12 2.5-6H21",
  integrations:"M8 9l-3 3 3 3 M16 9l3 3-3 3 M13.5 7l-3 10",
  warehouse_address:"M3 10.5 12 3l9 7.5 M5.5 8.8V20h13V8.8 M10 20v-5.5h4V20",
  category_apparel:"M8.5 4 12 6.2 15.5 4l4.5 3.2-2.1 3.6-2.4-1.3V20H8.5V9.5L6.1 10.8 4 7.2 8.5 4Z",
  category_bags:"M6 8h12l1 12H5L6 8Z M9 8V6a3 3 0 0 1 6 0v2 M5.5 13h13",
  category_home:"M3 10.5 12 3l9 7.5 M5.5 8.8V20h13V8.8 M10 20v-5.5h4V20",
  category_electronics:"M7 7h10v10H7z M10 10h4v4h-4z M9 4v3 M15 4v3 M9 17v3 M15 17v3 M4 9h3 M4 15h3 M17 9h3 M17 15h3",
  category_footwear:"M3 16.5V14c0-1.1.9-2 2-2h2.2l2.6-4.5 2.4.8c1.5 2.3 3.9 3.7 6.6 3.9 1.2.1 2.2 1.1 2.2 2.3v2c0 .8-.7 1.5-1.5 1.5H4.5c-.8 0-1.5-.7-1.5-1.5Z M3 15.2h18 M10.5 10.5l1.8.8 M12.2 12.2l1.8.7",
  category_toys:"M12 3.5 4.5 7.8v8.4L12 20.5l7.5-4.3V7.8L12 3.5Z M4.5 7.8 12 12.1l7.5-4.3 M12 12.1v8.4",
  service_inspection:"M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z M15.2 15.2 20 20 M8.2 10.5l1.6 1.6 3.2-3.2",
  service_compare:"M4 4h6.5v16H4z M13.5 4H20v16h-6.5z M6.2 8.5h2.1 M6.2 12h2.1 M15.7 8.5h2.1 M15.7 12h2.1",
  service_reference:"M12 3 5 6v5.5c0 4.6 3 8.7 7 9.5 4-.8 7-4.9 7-9.5V6l-7-3Z M9.2 11.8l2 2 3.8-3.8",
};

export function categoryIconName(value:string):string {
  const key=value.toLowerCase();
  if(key.includes("apparel")||key.includes("garment")) return "category_apparel";
  if(key.includes("bag")||key.includes("accessor")) return "category_bags";
  if(key.includes("home")) return "category_home";
  if(key.includes("electronic")) return "category_electronics";
  if(key.includes("footwear")||key.includes("shoe")) return "category_footwear";
  if(key.includes("toy")||key.includes("child")) return "category_toys";
  return "packages";
}
const navIcons:Record<string,string>={
  "/account":"overview","/orders":"orders","/orders/new":"add","/actions":"actions","/reports":"reports",
  "/parcels":"packages","/items":"items","/account/billing":"payments","/billing":"payments",
  "/account/notifications":"notifications","/notifications":"notifications","/support":"support",
  "/wh":"overview","/wh/scan":"scan","/wh/intake":"intake","/wh/packages":"packages","/wh/samples":"items",
  "/wh/storage":"storage","/wh/inspection":"inspection","/wh/execute":"execute","/wh/sync":"sync",
  "/wh/review":"review","/wh/dispatch":"dispatch","/wh/logistics":"logistics","/wh/stocktakes":"stocktakes","/wh/notifications":"notifications",
  "/admin":"overview","/admin/orders":"orders","/admin/customers":"users","/admin/tickets":"support","/admin/notifications":"notifications",
  "/admin/inspections":"inspection","/admin/media":"reports","/admin/dispositions":"compare",
  "/admin/refunds":"refunds","/admin/payments":"payments","/admin/finance":"analytics","/admin/logistics":"logistics",
  "/admin/incidents":"incidents","/admin/catalog":"catalog","/admin/pricing":"payments","/admin/knowledge":"catalog","/admin/measurement-templates":"templates","/admin/templates":"templates",
  "/admin/settings":"warehouse_address","/admin/storage/locations":"locations",
  "/admin/shipping-rates":"shipping_rates","/admin/config":"settings","/admin/legal":"legal",
  "/admin/users":"users","/admin/audit":"audit","/admin/operations":"operations",
  "/admin/integrations":"integrations","/admin/integrations/payments":"payments","/admin/integrations/ocr":"templates","/admin/integrations/logistics":"integrations","/admin/integrations/email":"integrations","/admin/integrations/storage":"integrations",
};

export function PlatformIcon({name}:{name:string}) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[name]??iconPaths.orders}/></svg>;
}

const navigationSections = {
  customer: [
    ["Orders & Inspections",["/orders/new","/orders","/actions","/reports"]],
    ["Samples & Logistics",["/parcels","/items"]],
    ["Account",["/account","/account/billing","/account/notifications","/support"]],
  ],
  warehouse: [
    ["运营作业",["/wh","/wh/scan","/wh/intake","/wh/packages","/wh/samples","/wh/storage","/wh/inspection","/wh/execute","/wh/sync","/wh/review","/wh/dispatch","/wh/logistics","/wh/stocktakes","/wh/notifications"]],
  ],
  admin: [
    ["运营管理",["/admin","/admin/orders","/admin/customers","/admin/tickets","/admin/notifications","/admin/inspections","/admin/media","/admin/dispositions","/admin/refunds","/admin/payments","/admin/finance","/admin/logistics","/admin/incidents"]],
    ["平台配置",["/admin/catalog","/admin/pricing","/admin/knowledge","/admin/measurement-templates","/admin/templates","/admin/storage/locations","/admin/shipping-rates","/admin/config","/admin/legal","/admin/users","/admin/audit","/admin/operations","/admin/integrations","/admin/integrations/payments","/admin/integrations/ocr","/admin/integrations/logistics","/admin/integrations/email","/admin/integrations/storage"]],
  ],
} satisfies Record<string,[string,string[]][]>;

export function WorkspaceNavigation({
  area,title,links,path,demo=false,mobileOpen=false,onCloseMobile,collapsed=false,onToggleCollapse,
}:{
  area:keyof typeof navigationSections;title:string;links:[string,string][];path:string;demo?:boolean;mobileOpen?:boolean;onCloseMobile?:()=>void;collapsed?:boolean;onToggleCollapse?:()=>void;
}) {
  const normPath = path==="/billing"?"/account/billing":path==="/notifications"?"/account/notifications":path;
  const current=(/^\/orders\/[^/]+\/report(\/|$)/.test(normPath)?"/reports":undefined)
    ?? links.find(([href])=>href===normPath)?.[0]
    ?? links.filter(([href])=>href!=="/wh"&&href!=="/admin"&&normPath.startsWith(href+"/")).sort(([left],[right])=>right.length-left.length)[0]?.[0]
    ?? (normPath.startsWith("/wh/task/")?"/wh/execute":normPath.startsWith("/shipments/")?"/parcels":normPath.startsWith("/support/cases/")?"/support":normPath.startsWith("/admin/disposals/")?"/admin/dispositions":normPath.startsWith("/admin/inspections/")?"/admin/inspections":undefined);
  const grouped = navigationSections[area].map(([name,paths])=>[name,paths.flatMap(href=>links.filter(([url])=>url===href))] as const);
  const hasAdminCatalog = links.some(([url])=>url==="/admin/catalog");
  const otherLinks = area==="warehouse"
    ? []
    : links.filter(([href])=>!(area==="admin"&&hasAdminCatalog&&href==="/admin/settings") && !grouped.some(([,group])=>group.some(([url])=>url===href)));
  const sections = area==="admin"
    ? grouped.map(([name, group])=>[name,name==="平台配置"?[...group,...otherLinks]:group] as const)
    : [...grouped,["More",otherLinks] as const];
  const isStaff = area==="warehouse" || area==="admin";
  const toggleLabel = isStaff ? (collapsed ? "展开侧栏菜单" : "收起侧栏菜单") : (collapsed ? "Expand sidebar" : "Collapse sidebar");
  const asideRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const activeEl = aside.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!activeEl) return;
    const top = activeEl.offsetTop;
    const bottom = top + activeEl.offsetHeight;
    const viewTop = aside.scrollTop;
    const viewBottom = viewTop + aside.clientHeight;
    if (top < viewTop + 16) {
      aside.scrollTop = Math.max(0, top - 64);
    } else if (bottom > viewBottom - 16) {
      aside.scrollTop = Math.max(0, bottom - aside.clientHeight + 24);
    }
  }, [current]);

  return <aside
    className={`workspace-sidebar${mobileOpen?" mobile-open":""}${collapsed?" collapsed":""}`}
    id="workspace-sidebar-nav"
    data-collapsed={collapsed?"true":"false"}
    ref={asideRef}
  >
    <div className="workspace-sidebar-title">
      <div className="row" style={{justifyContent:"space-between",alignItems:"center",gap:8}}>
        <strong>{area==="customer"?"My Workspace":area==="warehouse"?"仓库作业中心":"运营管理后台"}</strong>
        {onToggleCollapse && (
          <button
            type="button"
            className="workspace-sidebar-collapse-btn"
            aria-expanded={!collapsed}
            aria-controls="workspace-sidebar-nav"
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={onToggleCollapse}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {collapsed ? (
                <>
                  <path d="M13 17l5-5-5-5"/>
                  <path d="M6 17l5-5-5-5"/>
                </>
              ) : (
                <>
                  <path d="M11 17l-5-5 5-5"/>
                  <path d="M18 17l-5-5 5-5"/>
                </>
              )}
            </svg>
          </button>
        )}
        {onCloseMobile && (
          <button
            type="button"
            className="workspace-drawer-close"
            aria-label="Close workspace navigation"
            onClick={onCloseMobile}
          >
            ✕
          </button>
        )}
      </div>
    </div>
    <nav className="workspace-nav" aria-label={title}>
      {sections.filter(([,group])=>group.length>0).map(([name,group])=><div className="workspace-nav-group" key={name}>
        <p>{name}</p>
        {group.map(([href,label])=><Link key={href} href={href} aria-current={href===current?"page":undefined} title={collapsed?label:undefined} onClick={onCloseMobile}>
          <PlatformIcon name={navIcons[href]??"orders"}/><span>{label}</span>
        </Link>)}
      </div>)}
    </nav>
    {isStaff&&demo&&<div className="sidebar-note">
      <b>演示模式说明</b>
      本机模拟数据与正式外部资金/物流/发信通道隔离。
    </div>}
  </aside>;
}
