"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CustomerActions, CustomerDesk, DemoCheckout, NewOrder, OrderFulfillment, OrderView, ReportView, TrackView } from "./customer";
import { AdminDesk, LogisticsConfiguration, LogisticsDesk, TaskView, WarehouseDesk, WarehouseDispatchBatch, WarehouseItemView, WarehousePackageView, WarehouseScan } from "./staff";
import { AdminCustomerDetail, AdminCustomersDirectory } from "./admin-customers";
import { AdminPaymentDetail, AdminRefundDetail } from "./admin-finance";
import { AdminIntegrationsDesk } from "./admin-integrations";
import { ROLE_ZH } from "./admin-labels";
import { AdminDisposalDetail, AdminIncidentDetail, AdminInspectionsWorkbench, AdminInspectionTaskDetail } from "./admin-operations";
import { AdminOrderDetailWorkbench } from "./admin-orders";
import { Action, request, Tag, WorkspaceTimeZone } from "./ui";
import { Brand, InternalWorkspaceFooter, PublicFooter, PublicHeader, QuickSwitch, SiteFooter, switchDemoPortal, WorkspaceNavigation } from "./chrome";
import { FAQ } from "./faq";
import { PublicInquiry } from "./public-inquiry";
import { PublicCatalogRouter, PublicHowItWorks, PublicLegal } from "./public-site";
import { ReportGuide } from "./report-guide";
import { StorageLocations, StorageMove } from "./storage-desk";
import { CustomerCase, StaffTicket, StaffTicketQueue } from "./ticket-desk";
import { ReportDesk, StaffReport } from "./report-desk";
import { OperationsDesk } from "./operations-desk";
import { PublishedReports } from "./report-sharing";
import { clearCustomerDraftRecovery } from "./draft-recovery";
import { AuditDesk } from "./audit-desk";
import { NotificationInbox } from "./notifications";

import { canOpenStaffPage, customerDestination, customerTabs, staffHome, staffTabs, withDestination, type PortalRoute } from "../packages/core/portal-routes";

import type { Actor } from "../packages/core/common";

export function Portal({path,target,route,actor:a,demo=false,timeZone,customerAccount}:{path:string;target:string;route:PortalRoute;actor:Actor|null;demo?:boolean;timeZone?:string;customerAccount?:string}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const menuToggle=useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("qcw_sidebar_collapsed") === "1") {
        setSidebarCollapsed(true);
      }
    } catch {
      // ignore storage failure
    }
  }, []);
  function toggleSidebarCollapsed() {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try {
        window.localStorage.setItem("qcw_sidebar_collapsed", next ? "1" : "0");
      } catch {
        // ignore storage failure
      }
      return next;
    });
  }
  function closeMobileNavigation() {
    setMobileNavOpen(false);
    menuToggle.current?.focus();
  }
  useEffect(() => { setMobileNavOpen(false); }, [path]);
  useEffect(()=>{
    if(!mobileNavOpen) return;
    const onKeyDown=(event:KeyboardEvent)=>{
      if(event.key==="Escape") closeMobileNavigation();
    };
    document.getElementById("workspace-sidebar-nav")?.querySelector<HTMLButtonElement>("button")?.focus();
    document.addEventListener("keydown",onKeyDown);
    return ()=>document.removeEventListener("keydown",onKeyDown);
  },[mobileNavOpen]);
  const isStaff=route.area==="warehouse"||route.area==="admin";
  const publicPage=route.area==="public";
  const warehouseLinks=a?.kind==="staff"?staffTabs("warehouse",a.roles):[];
  const adminLinks=a?.kind==="staff"?staffTabs("admin",a.roles):[];
  const links=route.area==="warehouse"?warehouseLinks:route.area==="admin"?adminLinks:a?.kind==="customer"?customerTabs:[];
  let content;
  if(route.view==="catalog") content=<PublicCatalogRouter path={path}/>;
  else if(route.view==="how-it-works") content=<PublicHowItWorks/>;
  else if(route.view==="faq") content=<FAQ/>;
  else if(route.view==="public-inquiry") content=<PublicInquiry/>;
  else if(route.view==="report-guide") content=<ReportGuide/>;
  else if(route.view==="legal") content=<PublicLegal path={path}/>;
  else if(!a) content=null;
  else if(isStaff && a.kind!=="staff") content=<section className="panel narrow"><h1>需要员工权限</h1>
    <p>当前登录的是客户账号，无权访问{route.area==="warehouse"?"仓库":"管理后台"}工作台，请使用已分配权限的员工账号登录。</p>
    <div className="actions">
      <Link className="button primary" href={withDestination("/staff/login",target)}>前往员工登录</Link>
      <Link className="button" href="/orders">返回客户工作台</Link>
    </div></section>;
  else if(isStaff&&!canOpenStaffPage(path,route,a.roles)) content=<section className="panel"><h1>当前账号角色无权访问该页面</h1>
    <p>您当前登录的员工账号已分配角色：<strong>{a.roles.map(r=>ROLE_ZH[r]??r).join("、")||"未分配角色"}</strong>。按职责分离（SoD）与最小权限原则，该岗位未开放当前路径（<code className="code">{path}</code>）的访问权限。</p>
    <p className="muted">{demo?"如需在本地演示环境体验其他岗位流程，可点击下方切换为全权限演示管理员，或返回当前岗位工作区。":"如需开通该模块权限，请联系超级管理员在「员工权限」中提交岗位授权变更。"}</p>
    <div className="actions">
      {staffHome(a.roles)&&<Link className="button primary" href={staffHome(a.roles)!}>返回当前岗位工作区</Link>}
      {demo&&<button type="button" className="button" onClick={()=>void switchDemoPortal(target,"admin@qcw.test")}>
        切换为全权限演示员工账号
      </button>}
    </div></section>;
  else if(route.view==="logistics") content=<LogisticsDesk actor={a}/>;
  else if(route.view==="logistics-configuration") content=<LogisticsConfiguration/>;
  else if(route.view==="admin-integrations") content=<AdminIntegrationsDesk path={path} actor={a} demo={demo}/>;
  else if(route.view==="warehouse-scan") content=<WarehouseScan actor={a}/>;
  else if(route.view==="warehouse-item") content=<WarehouseItemView code={route.id} actor={a}/>;
  else if(route.view==="warehouse-package") content=<WarehousePackageView code={route.id} actor={a}/>;
  else if(route.view==="dispatch-batch") content=<WarehouseDispatchBatch key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="report-desk") content=<ReportDesk actor={a}/>;
  else if(route.view==="staff-report") content=<StaffReport key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="operations") content=<OperationsDesk/>;
  else if(path==="/admin/audit") content=<AuditDesk/>;
  else if(route.view==="storage-move") content=<StorageMove path={path} actor={a}/>;
  else if(route.view==="storage-locations") content=<StorageLocations warehouseLinks={warehouseLinks}/>;
  else if(route.view==="admin") content=<AdminDesk path={path} actor={a} demo={demo}/>;
  else if(route.view==="admin-customers") content=<AdminCustomersDirectory/>;
  else if(route.view==="admin-customer") content=<AdminCustomerDetail key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="admin-payment") content=<AdminPaymentDetail key={route.id} id={route.id} demo={demo}/>;
  else if(route.view==="admin-refund") content=<AdminRefundDetail key={route.id} id={route.id} demo={demo} actor={a}/>;
  else if(route.view==="admin-inspections") content=<AdminInspectionsWorkbench actor={a}/>;
  else if(route.view==="admin-inspection-task") content=<AdminInspectionTaskDetail key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="admin-incident") content=<AdminIncidentDetail key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="admin-disposal") content=<AdminDisposalDetail key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="staff-tickets") content=<StaffTicketQueue/>;
  else if(route.view==="staff-ticket") content=<StaffTicket key={route.id} id={route.id} actor={a}/>;
  else if(route.view==="staff-order") content=<AdminOrderDetailWorkbench key={route.id} number={route.id} actor={a}/>;
  else if(route.view==="task") content=<TaskView id={route.id} actor={a}/>;
  else if(route.view==="warehouse") content=<WarehouseDesk path={path} actor={a} demo={demo}/>;
  else if(a.kind!=="customer") content=<section className="panel narrow"><h1>Customer account required</h1>
    <p>Use your customer account to open the customer workspace.</p>
    <div className="actions">
      {demo&&<button type="button" className="button primary" onClick={()=>void switchDemoPortal(customerDestination(target)??"/orders","customer@qcw.test")}>
        One-click switch to Demo Customer
      </button>}
      <Link className={demo?"button":"button primary"} href={withDestination("/login",customerDestination(target))}>Sign in as a customer</Link>
    </div></section>;
  else if(route.view==="new-order") content=<NewOrder key={a.id+target} customerId={a.id} demo={demo}/>;
  else if(route.view==="customer-actions") content=<CustomerActions/>;
  else if(route.view==="customer-case") content=<CustomerCase key={route.recordId??route.id} id={route.recordId??route.id} order={route.recordId?route.id:undefined}/>;
  else if((route.view==="order-quote"||route.view==="order-shipment")&&route.recordId) content=<OrderFulfillment key={route.recordId} order={route.id} id={route.recordId} kind={route.view==="order-quote"?"quotes":"shipments"}/>;
  else if(route.view==="report") content=<ReportView key={route.id} number={route.id} version={route.version}/>;
  else if(path==="/reports") content=<PublishedReports/>;
  else if(path==="/account/notifications"||path==="/notifications") content=<NotificationInbox/>;
  else if(route.view==="order") content=<OrderView key={route.id} number={route.id} section={route.section} demo={demo}/>;
  else if(route.view==="demo") content=<DemoCheckout id={route.id}/>;
  else if(route.view==="parcel") content=<TrackView kind="parcels" id={route.id}/>;
  else if(route.view==="shipment") content=<OrderFulfillment key={route.id} id={route.id} kind="shipments"/>;
  else content=<CustomerDesk path={path==="/billing"?"/account/billing":path} demo={demo}/>;
  const locale=isStaff?"zh-CN":"en";
  const signOut=a?<Action run={async()=>{await request("/auth/logout","POST",{});if(a.kind==="customer") clearCustomerDraftRecovery(a.id);else{try{for(const k of Object.keys(window.localStorage)){if(k.startsWith("qcw_task_draft_"))window.localStorage.removeItem(k);}}catch{}}location.assign(a.kind==="staff"?"/staff/login":"/login");}}>{a.kind==="staff"?"退出登录":"Sign out"}</Action>:undefined;
  const homeLink=a?.kind==="customer"?"/account":undefined;
  if(publicPage||!a||links.length===0) return <>
    <PublicHeader path={path} accountHref={homeLink} staff={a?.kind==="staff"} accountAction={a?.kind==="customer"?signOut:undefined} actor={a} demo={demo}/>
    <main className={`public-shell view-${route.view}`} id="main-content" lang={locale}>{content}</main>
    {publicPage ? <PublicFooter/> : <SiteFooter/>}
  </>;

  const normPath = path==="/billing"?"/account/billing":path==="/notifications"?"/account/notifications":path;
  const section=route.area==="admin"?"运营总览":route.area==="warehouse"?"仓库总览":"My Workspace";
  const currentLink=links.find(([href])=>href===normPath);
  const parentLink =
    links.filter(([href])=>href!=="/wh"&&href!=="/admin"&&normPath.startsWith(href+"/")).sort(([left],[right])=>right.length-left.length)[0]
    ?? (normPath.startsWith("/admin/disposals/") ? links.find(([href])=>href==="/admin/dispositions") : normPath.startsWith("/admin/inspections/") ? links.find(([href])=>href==="/admin/inspections") : undefined);
  const staffRoleSummary = a?.kind==="staff"
    ? a.roles.slice(0,2).map(r=>ROLE_ZH[r]??r).join(" / ") + (a.roles.length>2?` +${a.roles.length-2}`:"")
    : "";

  return <div className={`workspace workspace-${route.area}`} lang={locale}>
    <a className="skip-link" href="#main-content">{isStaff?"跳至主要内容":"Skip to main content"}</a>
    <header className="workspace-top">
      <div className="workspace-brand">
        <button
          type="button"
          ref={menuToggle}
          className="workspace-menu-toggle"
          aria-expanded={mobileNavOpen}
          aria-controls="workspace-sidebar-nav"
          aria-label={isStaff?(mobileNavOpen?"关闭侧栏导航":"展开侧栏导航"):(mobileNavOpen?"Close workspace menu":"Open workspace menu")}
          onClick={()=>setMobileNavOpen(v=>!v)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {mobileNavOpen ? <path d="M6 6l12 12M18 6L6 18"/> : <path d="M4 7h16M4 12h16M4 17h16"/>}
          </svg>
        </button>
        <Brand/>
        <span className="workspace-context">{route.area==="admin"?"运营管理后台":route.area==="warehouse"?"仓库作业中心":"CLIENT WORKSPACE"}</span>
      </div>
      <span className="topspacer"/>
      <div className="header-right">
        {!isStaff&&a.kind==="customer"&&<Link className="workspace-account" href="/account/security" aria-current={path==="/account/security"?"page":undefined}>
          <strong title={customerAccount}>{customerAccount??"Account"}</strong>
          <span>Sign-in methods &amp; security</span>
        </Link>}
        {isStaff && staffRoleSummary && <Tag tone="blue">岗位：{staffRoleSummary}</Tag>}
        {isStaff && <QuickSwitch active={route.area as "customer"|"warehouse"|"admin"} actor={a} demo={demo}/>}
        {demo&&isStaff&&<Tag tone="outline">演示模式</Tag>}
        {signOut}
      </div>
    </header>
    {mobileNavOpen && <div className="workspace-drawer-backdrop" onClick={closeMobileNavigation} aria-hidden="true"/>}
    <div className={`workspace-layout${sidebarCollapsed?" sidebar-collapsed":""}`}>
      <WorkspaceNavigation
        area={route.area as "admin"|"warehouse"|"customer"}
        title={section}
        links={links}
        path={normPath}
        demo={demo}
        mobileOpen={mobileNavOpen}
        onCloseMobile={closeMobileNavigation}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
      />
      <div className="workspace-column">
        <main className={`workspace-main view-${route.view}`} id="main-content" tabIndex={-1}>
          {(!isStaff || (!currentLink && parentLink)) && (
            <nav className="breadcrumb" aria-label={isStaff?"上级模块导航":"Breadcrumb"}>
              {isStaff ? (
                <>
                  <Link href={links[0][0]}>{section}</Link>
                  {parentLink && <><span aria-hidden="true">›</span><Link href={parentLink[0]}>{parentLink[1]}</Link></>}
                  <span aria-hidden="true">›</span><strong>详情工作台</strong>
                </>
              ) : (
                <>
                  <Link href="/">QC Warehouse</Link><span aria-hidden="true">›</span>
                  {links[0][0]===normPath?<strong>{section}</strong>:<><Link href={links[0][0]}>{section}</Link>
                    {(currentLink||parentLink)&&<><span aria-hidden="true">›</span>{currentLink?<strong>{currentLink[1]}</strong>:<Link href={parentLink[0]}>{parentLink[1]}</Link>}</>}
                  </>}
                </>
              )}
            </nav>
          )}
          <WorkspaceTimeZone value={timeZone}>{content}</WorkspaceTimeZone>
        </main>
        {isStaff ? <InternalWorkspaceFooter area={route.area as "admin"|"warehouse"} demo={demo} timeZone={timeZone}/> : <SiteFooter/>}
      </div>
    </div>
  </div>;
}
