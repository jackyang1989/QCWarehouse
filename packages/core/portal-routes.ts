import { ADMIN_DIRECT_ROUTE_ROLES } from "./authz-contract";
import { hasStaffAccess, staffAccess } from "./staff-access";

const sampleCodeBody="(?:S[A-Z0-9]{5,8}|S-[A-Z0-9-]{1,64}|DSP-?[A-Z0-9-]{1,64})";
export const sampleCodePattern=new RegExp("^"+sampleCodeBody+"$","i");
export const customerTabs:[string,string][]=[
  ["/account","Account"],["/orders","Orders"],["/orders/new","New Inspection"],["/parcels","Parcels"],["/items","Items"],
  ["/reports","Reports"],["/account/billing","Billing"],["/support","Support"],
  ["/actions","Action Required"],["/account/notifications","Notifications"],
];
const warehouseOverview=["receiver","warehouse_admin","inspector","reviewer","super_admin"] as const;
const warehouseInspectionQueue=["inspector","reviewer","warehouse_admin","super_admin"] as const;
const warehouseSyncQueue=["inspector","warehouse_admin","super_admin"] as const;
const warehouseTabs=[
  ["/wh","仓库总览",warehouseOverview],
  ["/wh/scan","扫码查询",warehouseOverview],
  ["/wh/intake","收货入库",staffAccess.intake],
  ["/wh/packages","包裹详情",staffAccess.intake],
  ["/wh/samples","样品建档",staffAccess.intake],
  ["/wh/storage","库位移转",staffAccess.intake],
  ["/wh/inspection","检查队列",warehouseInspectionQueue],
  ["/wh/execute","执行检查",warehouseInspectionQueue],
  ["/wh/sync","同步队列",warehouseSyncQueue],
  ["/wh/review","报告复核",staffAccess.reportEditing],
  ["/wh/dispatch","出库待办",staffAccess.dispatch],
  ["/wh/stocktakes","库存盘点",staffAccess.intake],
  ["/wh/logistics","物流监控",staffAccess.tracking],
  ["/wh/notifications","个人收件箱",warehouseOverview],
] as const;
const adminTabs=[
  ["/admin","运营总览",staffAccess.administration],
  ["/admin/orders","全部订单",staffAccess.orders],
  ["/admin/customers","客户档案",["super_admin"]],
  ["/admin/tickets","客户工单",staffAccess.orders],
  ["/admin/notifications","消息与收件箱",["super_admin"]],
  ["/admin/inspections","质检与报告",["super_admin"]],
  ["/admin/media","媒体与证据",["super_admin","warehouse_admin","reviewer"]],
  ["/admin/dispositions","处置与报价",["super_admin"]],
  ["/admin/refunds","退款审批",["super_admin"]],
  ["/admin/payments","支付流水",["super_admin"]],
  ["/admin/finance","财务分析",staffAccess.finance],
  ["/admin/logistics","物流监控",staffAccess.tracking],
  ["/admin/incidents","库存事故",["super_admin"]],
  ["/admin/catalog","品类与服务",["super_admin"]],
  ["/admin/knowledge","专业知识库",["super_admin","reviewer"]],
  ["/admin/templates","检查模板",["super_admin"]],
  ["/admin/settings","仓址及模板",staffAccess.templates],
  ["/admin/storage/locations","库位管理",staffAccess.locations],
  ["/admin/shipping-rates","运费费率",["super_admin"]],
  ["/admin/config","业务配置",["super_admin"]],
  ["/admin/legal","条款管理",["super_admin"]],
  ["/admin/users","员工权限",["super_admin"]],
  ["/admin/audit","审计日志",["super_admin"]],
  ["/admin/operations","后台任务",["super_admin"]],
  ["/admin/integrations","第三方集成",["super_admin"]],
  ["/admin/integrations/payments","支付渠道配置",["super_admin"]],
  ["/admin/integrations/email","邮件服务配置",["super_admin"]],
  ["/admin/integrations/storage","对象存储配置",["super_admin"]],
  ["/admin/integrations/ocr","OCR 文档识别",["super_admin"]],
  ["/admin/integrations/ai","AI 与翻译服务",["super_admin"]],
  ["/admin/translations","动态翻译与审核",["super_admin","template_admin","reviewer"]],
  ["/admin/integrations/logistics","物流接入",staffAccess.trackingConfiguration],
] as const;

export function staffTabs(area:"admin"|"warehouse",roles:readonly string[]):[string,string][] {
  return (area==="admin"?adminTabs:warehouseTabs)
    .filter(([, , allowed])=>hasStaffAccess(roles,allowed)).map(([path,label])=>[path,label]);
}

export function canOpenStaffPage(path:string,route:PortalRoute,roles:readonly string[]) {
  if(route.area!=="admin"&&route.area!=="warehouse") return false;
  if(route.view==="staff-notifications") return hasStaffAccess(roles,["receiver","inspector","reviewer","warehouse_admin","support","super_admin","template_admin","finance"]);
  if(route.view==="task") return hasStaffAccess(roles,["inspector","reviewer","warehouse_admin","super_admin"]);
  if(route.view==="dispatch-batch") return hasStaffAccess(roles,staffAccess.dispatch);
  if(route.view==="staff-report") return hasStaffAccess(roles,[...staffAccess.reportEditing,"support","inspector"]);
  if(route.view==="staff-ticket"||route.view==="staff-order") return hasStaffAccess(roles,staffAccess.orders);
  if(route.view==="admin-payment"||route.view==="admin-refund") return hasStaffAccess(roles,staffAccess.finance);
  if(route.view==="admin-customer"||route.view==="admin-customers") return hasStaffAccess(roles,["super_admin","support","finance"]);
  if(route.view==="admin-inspections"||route.view==="admin-inspection-task") return hasStaffAccess(roles,["super_admin","support","inspector","reviewer","warehouse_admin"]);
  if(route.view==="admin-media"||route.view==="admin-media-detail") return hasStaffAccess(roles,["super_admin","warehouse_admin","reviewer","inspector","support","finance"]);
  if(route.view==="admin-incident") return hasStaffAccess(roles,["receiver","warehouse_admin","support","finance","super_admin"]);
  if(route.view==="admin-disposal") return hasStaffAccess(roles,["receiver","warehouse_admin","support","super_admin"]);
  if(route.view==="warehouse-package"||route.view==="warehouse-item") return hasStaffAccess(roles,staffAccess.intake);
  const directRoles=ADMIN_DIRECT_ROUTE_ROLES[path];
  if(directRoles) return hasStaffAccess(roles,directRoles);
  return staffTabs(route.area,roles).some(([link])=>link===path);
}

export const servicePages = {
  "/services/inspection":"inspection",
  "/services/compare":"compare",
  "/services/reference":"reference_match",
} as const;
export const legalPages = {
  "/legal/terms":"terms",
  "/legal/privacy":"privacy",
  "/legal/restricted-items":"restricted_items",
  "/legal/report-notice":"report_notice",
} as const;

type Area = "public" | "customer" | "warehouse" | "admin";
type StaticView = "public-home" | "catalog" | "how-it-works" | "faq" | "report-guide" | "public-inquiry" | "legal" | "login" | "onboarding" | "account-recovery" | "staff-login" | "customer" | "customer-actions" | "warehouse" | "admin" | "admin-customers" | "admin-inspections" | "admin-media" | "admin-integrations" | "admin-translations" | "admin-knowledge" | "staff-notifications" | "staff-tickets" | "logistics" | "logistics-configuration" | "storage-move" | "storage-locations" | "warehouse-scan" | "report-desk" | "operations";
type DetailView = "order" | "report" | "parcel" | "shipment" | "task" | "demo" | "warehouse-package" | "warehouse-item" | "customer-case" | "staff-ticket" | "staff-order" | "admin-customer" | "admin-payment" | "admin-refund" | "admin-incident" | "admin-disposal" | "admin-inspection-task" | "admin-media-detail" | "order-quote" | "order-shipment" | "dispatch-batch" | "staff-report";
export const orderSections={
  payment:"Payment",parcels:"Parcels",dispositions:"Item instructions",storage:"Storage",
} as const;
export type OrderSection=keyof typeof orderSections;
export type PortalRoute =
  | {area:Area;view:StaticView}
  | {area:Area;view:DetailView;id:string;version?:number;section?:OrderSection;recordId?:string}
  | {area:"customer";view:"new-order"};

const fixed = new Map<string,PortalRoute>();
for(const [paths,route] of [
  [customerTabs.map(([path])=>path),{area:"customer",view:"customer"}],
  [warehouseTabs.map(([path])=>path),{area:"warehouse",view:"warehouse"}],
  [adminTabs.map(([path])=>path),{area:"admin",view:"admin"}],
  [["/catalog","/categories","/pricing",...Object.keys(servicePages)],{area:"public",view:"catalog"}],
  [["/legal",...Object.keys(legalPages)],{area:"public",view:"legal"}],
  [["/how-it-works"],{area:"public",view:"how-it-works"}],
  [["/faq"],{area:"public",view:"faq"}],
  [["/contact"],{area:"public",view:"public-inquiry"}],
  [["/report-guide"],{area:"public",view:"report-guide"}],
  [["/login","/signup"],{area:"public",view:"login"}],
  [["/onboarding"],{area:"public",view:"onboarding"}],
  [["/account/recovery"],{area:"public",view:"account-recovery"}],
  [["/staff/login"],{area:"public",view:"staff-login"}],
  [["/orders/new"],{area:"customer",view:"new-order"}],
  [["/account/notifications","/account/security","/billing","/notifications"],{area:"customer",view:"customer"}],
  [["/actions"],{area:"customer",view:"customer-actions"}],
  [["/admin/customers"],{area:"admin",view:"admin-customers"}],
  [["/admin/inspections"],{area:"admin",view:"admin-inspections"}],
  [["/admin/media"],{area:"admin",view:"admin-media"}],
  [["/admin/tickets"],{area:"admin",view:"staff-tickets"}],
  [["/admin/operations"],{area:"admin",view:"operations"}],
  [["/admin/catalog","/admin/categories","/admin/templates","/admin/dispositions","/admin/refunds","/admin/payments","/admin/incidents","/admin/shipping-rates","/admin/config","/admin/legal","/admin/users"],{area:"admin",view:"admin"}],
  [["/wh/logistics"],{area:"warehouse",view:"logistics"}],
  [["/wh/notifications"],{area:"warehouse",view:"staff-notifications"}],
  [["/wh/storage","/wh/stocktakes"],{area:"warehouse",view:"storage-move"}],
  [["/wh/review"],{area:"warehouse",view:"report-desk"}],
  [["/wh/scan"],{area:"warehouse",view:"warehouse-scan"}],
  [["/admin/storage/locations"],{area:"admin",view:"storage-locations"}],
  [["/admin/logistics"],{area:"admin",view:"logistics"}],
  [["/admin/notifications"],{area:"admin",view:"staff-notifications"}],
  [["/admin/integrations","/admin/integrations/payments","/admin/integrations/ocr","/admin/integrations/email","/admin/integrations/storage","/admin/integrations/ai"],{area:"admin",view:"admin-integrations"}],
  [["/admin/translations"],{area:"admin",view:"admin-translations"}],
  [["/admin/knowledge"],{area:"admin",view:"admin-knowledge"}],
  [["/admin/integrations/logistics"],{area:"admin",view:"logistics-configuration"}],
] satisfies [string[],PortalRoute][]) {
  for(const path of paths) fixed.set(path,route);
}

const publicNo = "(QW-?[A-Z0-9]{4,16})";
const uuid = "([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})";
const details:{pattern:RegExp;area:Area;view:DetailView}[]=[
  {pattern:new RegExp("^/orders/"+publicNo+"(?:/("+Object.keys(orderSections).join("|")+"))?$"),area:"customer",view:"order"},
  {pattern:new RegExp("^/orders/"+publicNo+"/report(?:/versions/([1-9][0-9]{0,9}))?$"),area:"customer",view:"report"},
  {pattern:new RegExp("^/orders/"+publicNo+"/cases/"+uuid+"$"),area:"customer",view:"customer-case"},
  {pattern:new RegExp("^/orders/"+publicNo+"/quotes/"+uuid+"$"),area:"customer",view:"order-quote"},
  {pattern:new RegExp("^/orders/"+publicNo+"/shipments/"+uuid+"$"),area:"customer",view:"order-shipment"},
  {pattern:new RegExp("^/support/cases/"+uuid+"$"),area:"customer",view:"customer-case"},
  {pattern:new RegExp("^/admin/tickets/"+uuid+"$"),area:"admin",view:"staff-ticket"},
  {pattern:new RegExp("^/admin/orders/"+publicNo+"$"),area:"admin",view:"staff-order"},
  {pattern:new RegExp("^/admin/customers/"+uuid+"$"),area:"admin",view:"admin-customer"},
  {pattern:new RegExp("^/admin/payments/"+uuid+"$"),area:"admin",view:"admin-payment"},
  {pattern:new RegExp("^/admin/refunds/"+uuid+"$"),area:"admin",view:"admin-refund"},
  {pattern:new RegExp("^/admin/incidents/"+uuid+"$"),area:"admin",view:"admin-incident"},
  {pattern:new RegExp("^/admin/disposals/"+uuid+"$"),area:"admin",view:"admin-disposal"},
  {pattern:new RegExp("^/admin/inspections/tasks/"+uuid+"$"),area:"admin",view:"admin-inspection-task"},
  {pattern:new RegExp("^/admin/media/"+uuid+"$"),area:"admin",view:"admin-media-detail"},
  {pattern:new RegExp("^/parcels/"+uuid+"$"),area:"customer",view:"parcel"},
  {pattern:new RegExp("^/shipments/"+uuid+"$"),area:"customer",view:"shipment"},
  {pattern:new RegExp("^/wh/task/"+uuid+"$"),area:"warehouse",view:"task"},
  {pattern:new RegExp("^/wh/dispatch/"+uuid+"$"),area:"warehouse",view:"dispatch-batch"},
  {pattern:new RegExp("^/wh/review/"+uuid+"$"),area:"warehouse",view:"staff-report"},
  {pattern:/^\/wh\/packages\/(P(?:\d{5,8}|-[A-Z0-9-]{1,64}))$/,area:"warehouse",view:"warehouse-package"},
  {pattern:new RegExp("^/wh/samples/("+sampleCodeBody+")$","i"),area:"warehouse",view:"warehouse-item"},
  {pattern:new RegExp("^/checkout/demo/"+uuid+"$"),area:"customer",view:"demo"},
];

const EXCLUDED_ZH_PUBLIC_VIEWS = new Set<string>([
  "login",
  "staff-login",
  "onboarding",
  "account-recovery",
]);

export function resolvePortalRoute(path:string):PortalRoute|undefined {
  const entry=fixed.get(path);
  if(entry) return entry;
  if(path==="/zh"||path==="/zh/") return {area:"public",view:"public-home"};
  if(path.startsWith("/zh/")) {
    const base=path.slice(3)||"/";
    if(base==="/") return {area:"public",view:"public-home"};
    const zhEntry=fixed.get(base);
    if(zhEntry&&zhEntry.area==="public"&&!EXCLUDED_ZH_PUBLIC_VIEWS.has(zhEntry.view)) {
      return zhEntry;
    }
    return undefined;
  }
  for(const {pattern,area,view} of details) {
    const match=pattern.exec(path);
    if(match) {
      if(!match[2]) return {area,view,id:match[1]};
      if(view==="customer-case"||view==="order-quote"||view==="order-shipment")return {area,view,id:match[1],recordId:match[2]};
      if(view==="order")return {area,view,id:match[1],section:match[2] as OrderSection};
      const version=Number(match[2]);
      if(version<=2147483647) return {area,view,id:match[1],version};
    }
  }
  return undefined;
}


const portalOrigin = "https://qcwarehouse.invalid";

function localPortalUrl(path:string|null|undefined) {
  if(!path?.startsWith("/")||path.startsWith("//")||path.includes("\\")||/[\u0000-\u001f\u007f]/.test(path)||path.length>2048) return null;
  const url=new URL(path,portalOrigin);
  return url.origin===portalOrigin?url:null;
}

export function customerDestination(path:string|null|undefined) {
  const url=localPortalUrl(path);
  const route=url&&resolvePortalRoute(url.pathname);
  if(!url||route?.area!=="customer"||route.view==="demo") return null;
  return url.pathname+url.search+url.hash;
}

export function billingChargePath(id:string) {
  const charge=encodeURIComponent(id);
  return "/account/billing?charge="+charge+"#charge-"+charge;
}

export function billingQuotePath(id:string) {
  const quote=encodeURIComponent(id);
  return "/account/billing?quote="+quote+"#quote-"+quote;
}

export function inspectionScopePath(orderNumber:string,scopeId:string) {
  return "/orders/"+encodeURIComponent(orderNumber)+"#scope-"+encodeURIComponent(scopeId);
}

export function staffDestinationArea(path:string|null|undefined) {
  const url=localPortalUrl(path);
  const area=url&&resolvePortalRoute(url.pathname)?.area;
  return area==="admin"||area==="warehouse"?area:null;
}

export function staffDestination(path:string|null|undefined,roles:readonly string[]) {
  const url=localPortalUrl(path);
  const route=url&&resolvePortalRoute(url.pathname);
  return url&&route&&canOpenStaffPage(url.pathname,route,roles)?url.pathname+url.search+url.hash:null;
}

export function staffHome(roles:readonly string[],area:"warehouse"|"admin"="admin") {
  const links=staffTabs(area,roles);
  return links[0]?.[0]??staffTabs(area==="warehouse"?"admin":"warehouse",roles)[0]?.[0];
}

export function withDestination(path:string,next:string|null|undefined) {
  if(!next) return path;
  return path+(path.includes("?")?"&":"?")+new URLSearchParams({next});
}
