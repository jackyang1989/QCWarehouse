"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Action, checked, CodeButton, DateInput, DefectAnnotator, type DefectAnnotation, Empty, ErrorBlock, Field, FileInput, Form, MediaButton, ModalDrawer, Panel, Photo, request, RequestError, Select, StaffObjectDrawer, type StaffObjectTarget, stamp, Table, Tag, text, upload, useLoad, usd, type Row } from "./ui";
import { switchDemoPortal } from "./chrome";
import { staffTabs } from "../packages/core/portal-routes";
import {
  AdminTabs,
  BizTag,
  CopyId,
  EmptyState,
  Money,
  ROLE_ZH,
  StatusBanner,
  SYNC_STATE_ZH,
  TRACKING_ALERT_KIND_ZH,
  TRANSPORT_STATE_ZH,
} from "./admin-labels";
import { AdminFinanceAnalytics, AdminPaymentsWorkbench, AdminRefundsWorkbench } from "./admin-finance";
import { AdminOrdersWorkbench } from "./admin-orders";
import { AdminDispositionsWorkbench, AdminIncidentsWorkbench, AdminOverviewDashboard } from "./admin-operations";
import { BilingualEntityPanel } from "./bilingual-editor";
import { OperationNoteList, OperationNotes } from "./operation-notes";
import { operationNoteLimit } from "../packages/core/order-note-limits";

function generateRandomSampleCode():string {
  const buf=new Uint32Array(1);
  crypto.getRandomValues(buf);
  return `S${10000+(buf[0]!%90000)}`;
}

const label=(s:string)=>({
  READY:"待领取",IN_PROGRESS:"检查中",SUBMITTED:"已提交",submitted:"待复核",qa_approved:"生成 PDF",pending:"待查询",
  checked_in:"已实收",received:"待识别",stored:"已在库",unmatched:"待认领",confirmed:"待报价",quoted:"待付款",paid:"已付款",packed:"已装箱",shipped:"已交接",
  delivered:"快递已签收",outbound:"已出库",returned:"已退回仓库",unknown:"未知",active:"跟踪中",in_transit:"在途",exception:"异常",
  delayed:"同步延迟",needs_carrier:"待补承运商",needs_verification:"待验证",not_supported:"不支持自动跟踪",picked_up:"已揽件",
  out_for_delivery:"派送中",returning:"退回途中",forwarded:"已转寄",
  approved:"已审批，待渠道确认",succeeded:"渠道已确认",failed:"渠道失败",processing:"处理中",partially_refunded:"部分退款",
  draft:"草稿",awaiting_payment:"待支付",awaiting_samples:"待收货",samples_ready:"样品已齐备",queued:"待质检",inspecting:"质检中",
  qa_review:"复核中",report_ready:"报告已发布",action_pending:"待处置",cancelled:"已取消",closed:"已关闭",on_hold:"暂停",
  return_to_seller:"退商家",to_forwarder:"寄集运仓",to_domestic_address:"国内转寄",identified:"已识别",
  in_inspection:"检中",inspected:"已检",quarantined:"已隔离",disposed:"已销毁/处理",handed_over:"已交接承运商",
  intact:"外箱完好",crushed:"外箱压扁变形",torn:"外箱破损开裂",wet:"外箱水渍受潮",
} as Record<string,string>)[s]??s;
const LOGISTICS_ERROR_ZH:Record<string,string>={
  KUAIDI100_RATE_LIMITED:"快递100接口限频（稍后自动重试）",
  RATE_LIMITED:"承运商查询限频（稍后重试）",
  PHONE_REQUIRED:"需补充寄/收件人手机号后4位验证",
  TRACKING_VERIFICATION_REQUIRED:"需手机号后4位验证运单",
  INVALID_TRACKING:"运单号格式或承运商不匹配",
  UNSUPPORTED_CARRIER:"暂不支持该承运商自动轨迹",
  PROVIDER_TIMEOUT:"承运商接口请求超时",
  NETWORK_ERROR:"网络通信中断",
};
function formatLogisticsErrorZh(code?:string|null) {
  if(!code) return "—";
  return LOGISTICS_ERROR_ZH[code]??code;
}
const options=(rows:Row[],name="code")=>rows.map(r=>({id:r.id,label:String(r[name])}));
export function WarehouseDesk({path,actor,demo=false}:{path:string;actor:Row;demo?:boolean}) {
  const {data,error,reload}=useLoad("/staff/desk"),carriers=useLoad("/carriers");
  const [lookup,setLookup]=useState<{tracking:string;carrier:string;result:Row;context?:Row}>();
  const [receiving,setReceiving]=useState(false);
  const [packageId,setPackageId]=useState("");
  const [intakeTracking,setIntakeTracking]=useState("");
  const [pkgItemSearch,setPkgItemSearch]=useState("");
  const [pkgItemPage,setPkgItemPage]=useState(1);
  const [declSearch,setDeclSearch]=useState("");
  const [declPage,setDeclPage]=useState(1);
  const [pkgSearch,setPkgSearch]=useState("");
  const [pkgTab,setPkgTab]=useState<"all"|"unpacked"|"unmatched"|"quarantined"|"checked_in">("all");
  const [pkgPage,setPkgPage]=useState(1);
  const [sampleSearch,setSampleSearch]=useState("");
  const [sampleTab,setSampleTab]=useState<"all"|"pending"|"identified"|"mismatch">("all");
  const [samplePage,setSamplePage]=useState(1);
  const [queueSearch,setQueueSearch]=useState("");
  const [queueFilter,setQueueFilter]=useState<"all"|"mine"|"unclaimed"|"others"|"returned"|"overdue"|"SUBMITTED">("all");
  const [batchPrintResult,setBatchPrintResult]=useState<{print_id:string;pdf_url:string;preview_png_url:string;codes:string[]}>();
  const [batchVerifyResult,setBatchVerifyResult]=useState<{verified:boolean;verified_count:number}>();
  const [discrepancyResult,setDiscrepancyResult]=useState<Row>();
  const [openPhotoMessage,setOpenPhotoMessage]=useState<string>("");
  const [lookupError,setLookupError]=useState<string>("");
  const packageDetail=useLoad(packageId?"/staff/packages/"+packageId:null);
  const selectedPackage=packageDetail.data?.parcel.id===packageId?packageDetail.data:undefined;
  const [itemCode,setItemCode]=useState("");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const itemDetail=useLoad(itemCode?"/staff/items/by-code?"+new URLSearchParams({code:itemCode}):null);
  const autoLookupRef=useRef<string>("");

  async function runTrackingLookup(rawTracking:string,rawCarrier="") {
    const tracking=rawTracking.trim();
    const carrier=rawCarrier.trim();
    if(!tracking) return;
    if(!actor.roles.some((r:string)=>["receiver","warehouse_admin"].includes(r))) {
      setLookupError("当前账号为只读监督角色：运单查询与实物到仓登记仅限收货员（receiver）与仓库主管（warehouse_admin）。");
      return;
    }
    setLookupError("");setLookup(undefined);setPackageId("");setPkgItemPage(1);setDeclPage(1);
    try {
      const result=await request("/staff/intake/lookup","POST",{tracking_no:tracking,...(carrier?{carrier_code:carrier}:{})});
      let context:Row|undefined;
      try {
        context=await request("/staff/intake/context?"+new URLSearchParams({tracking_no:tracking,...(carrier?{carrier_code:carrier}:{})}));
      } catch {}
      setLookup({tracking,carrier,result,context});
      if(result.package_id) setPackageId(result.package_id);
    } catch(err) {
      setLookupError(err instanceof Error?err.message:"运单查询失败，请核对权限或运单号后重试。");
    }
  }

  useEffect(()=>{
    if(path!=="/wh/intake")return;
    const params=new URLSearchParams(location.search);
    const qpPkg=params.get("package")??"";
    const qpItem=params.get("item")??"";
    const qpTracking=(params.get("tracking")??"").trim();
    setPackageId(qpPkg);
    setItemCode(qpItem);
    setIntakeTracking(qpTracking);
    if(qpTracking && autoLookupRef.current!==qpTracking) {
      autoLookupRef.current=qpTracking;
      void runTrackingLookup(qpTracking,"");
    }
  },[path]);

  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载工作台…</p>;
  const availableLinks=staffTabs("warehouse",actor.roles);
  const canReceive=actor.roles.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r));
  const canIntakeWrite=actor.roles.some((r:string)=>["receiver","warehouse_admin"].includes(r));
  const canPrintLabels=actor.roles.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r));
  const canInspect=actor.roles.includes("inspector");
  const canViewTasks=actor.roles.some((r:string)=>["inspector","reviewer","warehouse_admin","super_admin"].includes(r));
  const canReview=actor.roles.some((r:string)=>["reviewer","warehouse_admin","super_admin"].includes(r));
  const canReviewWrite=actor.roles.includes("reviewer");
  const canShip=actor.roles.some((r:string)=>["warehouse_admin","super_admin"].includes(r));
  const canShipWrite=actor.roles.includes("warehouse_admin");
  const item=itemDetail.data?.item;
  const selectItem=(code:string)=>{setItemCode(code);itemDetail.reload();};
  const locations=options(data.locations);
  const carrierOptions=(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}));
  const current=path.split("/")[2]??"overview";
  const qLower=queueSearch.trim().toLowerCase();
  const filteredTasks=(data.tasks??[]).filter((t:Row)=>{
    if(queueFilter==="mine"&&t.assignee_id!==actor.id) return false;
    if(queueFilter==="unclaimed"&&(t.assignee_id||t.state!=="READY")) return false;
    if(queueFilter==="others"&&(!t.assignee_id||t.assignee_id===actor.id)) return false;
    if(queueFilter==="returned"&&!t.returned_reason) return false;
    if(queueFilter==="overdue"&&!t.sla_overdue) return false;
    if(queueFilter==="SUBMITTED"&&t.state!=="SUBMITTED") return false;
    if(!qLower) return true;
    const df=t.declared_fields??{};
    return [t.public_no,t.item_code,t.receiving_code,t.assignee_name,df.name,df.sku_code,df.sample_code,t.location_code].some(v=>String(v??"").toLowerCase().includes(qLower));
  });
  const groups=Object.values(filteredTasks.reduce((g:Record<string,Row[]>,t:Row)=>{(g[t.order_id]??=[]).push(t);return g;},{})) as Row[][];
  const heading={
    overview:["仓库总览","按登录员工岗位角色展示实时精确作业待办、签收催查、质检与出库队列。"],
    intake:["收货入库","快递公司签收不等于 QC Warehouse 仓库实收。记录外箱、开箱照片与逐件实物后才能确认。"],
    packages:["包裹详情","实物包裹与原始运单、入库事务分别保存。"],
    samples:["样品识别与建档","客户物件标识与委托明细独立管理，支持快速筛选与核身。"],
    inspection:["检查任务队列","按本人负责、未领取、QA退回与SLA超时分层派工，逐件检查与样品比较独立。"],
    execute:["检查执行工作台","按受控模板录入观察事实、测量值与必拍证据。"],
    sync:["本地同步与冲突处理","仓库移动设备断网后不能覆盖已发布服务端数据。"],
    dispatch:["出库与退商家待办","只有授权、报价、付款和样品可用状态全部满足，才能进入可交接队列。"],
  }[current]??["仓库总览","实物、证据、费用与物流是不同的业务事实。"];
  const m=data.metrics??{};
  const intakeMetrics:[string,string,number,string][]=[
    ["/wh/logistics","签收未实收",Number(m.delivered_unreceived_count??0),"承运商妥投待扫码入库"],
    ["/wh/intake#intake-unpack","待拆包包裹",Number(m.unpacked_pending_count??0),"已核收待逐件建档"],
    ["/wh/packages","无主待认领",Number(m.unmatched_parcel_count??0),"缺专属收件码或未绑定"],
    ["/wh/samples","待核身绑定",Number(m.pending_id_count??0),"在库待绑定订单/SKU"],
    ["/wh/storage","待封存留样",Number(m.pending_reference_count??0),"待移入专柜/盘点 ("+Number(m.active_stocktakes_count??0)+"进行中)"],
    ["/wh/packages","已隔离异常包",Number(m.quarantined_packages_count??0),"待主管或客服介入"],
  ];
  const qcMetrics:[string,string,number,string][]=[
    ...(canViewTasks?[
      ["/wh/inspection","待领取任务",Number(m.ready_task_count??0),`在检 ${m.in_progress_task_count??0} / 活跃总计 ${m.total_active_task_count??0}`] as [string,string,number,string],
      ["/wh/inspection","QA 退回 / SLA超时",Number(m.returned_task_count??0)+Number(m.overdue_task_count??0),`退回 ${m.returned_task_count??0} / 超时 ${m.overdue_task_count??0}`] as [string,string,number,string],
    ]:[]),
    ...(canReview?[
      ["/wh/review","待 QA 复核",Number(m.pending_qa_count??0),"独立审核后生成客户报告"] as [string,string,number,string],
    ]:[]),
    ...(canShip?[
      ["/wh/dispatch","待处理出库",Number(m.actionable_dispatch_count??0),"待报价 / 待付款 / 待打包交接"] as [string,string,number,string],
    ]:[]),
  ];
  const overviewMetrics=[...(canReceive?intakeMetrics:[]),...qcMetrics];
  const activeRoleKey=actor.roles.includes("super_admin")?"admin":actor.roles.includes("reviewer")?"reviewer":actor.roles.includes("inspector")?"inspector":actor.roles.includes("warehouse_admin")?"warehouse":"receiving";
  const todayRows:[ReactNode,ReactNode,ReactNode,ReactNode,ReactNode][]=[
    ...(canReceive?data.packages.slice(0,4).map((parcel:Row):[ReactNode,ReactNode,ReactNode,ReactNode,ReactNode]=>[
      <div className="cell-stack">
        <Link className="code" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{parcel.code}</Link>
        {parcel.order_numbers?.length>0&&<small className="code">{parcel.order_numbers.join(" / ")}</small>}
      </div>,
      <div className="cell-stack">
        <span className="code">{parcel.receiving_code??"无主包裹"}</span>
        <small className="muted">建档 {parcel.logged_item_count??parcel.received_quantity??0} 件 · {parcel.received_by_name??"收货员"}</small>
      </div>,
      <div className="cell-stack">
        <span className="code">{parcel.tracking_norm??"—"}</span>
        {parcel.sla_due_at&&<small className="muted">订单SLA {stamp(parcel.sla_due_at)}</small>}
      </div>,
      <div className="cell-stack">
        <Tag tone={parcel.state==="unmatched"||parcel.state==="quarantined"?"yellow":"green"}>{label(parcel.state)}</Tag>
        {parcel.outer_condition&&parcel.outer_condition!=="intact"&&<small className="bad">{label(parcel.outer_condition)}</small>}
      </div>,
      <Link className="button sm" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{canIntakeWrite?"核对与拆包":"只读查看"}</Link>,
    ]):[]),
    ...(canViewTasks?data.tasks.slice(0,5).map((task:Row):[ReactNode,ReactNode,ReactNode,ReactNode,ReactNode]=>[
      <div className="cell-stack">
        <Link className="code" href={"/wh/task/"+task.id}>{task.public_no}</Link>
        <small className="code">{task.item_code??"对比组"}</small>
      </div>,
      <div className="cell-stack">
        <span className="code">{task.receiving_code??"—"} · {task.assignee_name??"未指派"}</span>
        <small>{task.declared_fields?.name||task.declared_fields?.sku_code||task.title?.["zh-CN"]||"—"}</small>
      </div>,
      <div className="cell-stack">
        <span className="code">{task.location_code??"—"}</span>
        {task.sla_overdue?<Tag tone="red">SLA 超时</Tag>:<small className="muted">SLA {stamp(task.sla_due_at)}</small>}
      </div>,
      <div className="cell-stack">
        <Tag tone={task.returned_reason||(task.order_blocks?.length>0)?"red":task.state==="IN_PROGRESS"?"blue":"yellow"}>{label(task.state)}</Tag>
        {task.returned_reason&&<small className="bad">已退回补正</small>}
        {(task.order_blocks?.length??0)>0&&<small className="bad">阻塞：{task.order_blocks.join("；")}</small>}
      </div>,
      <Link className={"button sm"+(canInspect?" primary":"")} href={"/wh/task/"+task.id}>{canInspect?(task.state==="READY"?"领取并检查":"进入检查"):"只读查看"}</Link>,
    ]):[]),
    ...(canReview?data.reports.slice(0,3).map((rep:Row):[ReactNode,ReactNode,ReactNode,ReactNode,ReactNode]=>[
      <div className="cell-stack">
        <Link className="code" href={"/wh/review/"+rep.id}>{rep.public_no}</Link>
        <small className="code">v{rep.version}{rep.item_codes?.length?` · ${rep.item_codes.slice(0,2).join(",")}`:""}</small>
      </div>,
      <div className="cell-stack">
        <span className="code">{rep.receiving_code??"—"}</span>
        <small>{rep.service_title?.["zh-CN"]??rep.service_title?.en??"—"}</small>
      </div>,
      <div className="cell-stack">
        <span className="small">{rep.created_by_name??"—"} · {stamp(rep.submitted_at)}</span>
        {rep.sla_due_at&&<small className="muted">SLA {stamp(rep.sla_due_at)}</small>}
      </div>,
      <Tag tone="yellow">{label(rep.state)}</Tag>,
      <Link className={"button sm"+(canReviewWrite?" primary":"")} href={"/wh/review/"+rep.id}>{canReviewWrite?"独立复核":"只读监督"}</Link>,
    ]):[]),
  ];

  const groupedSkuRows=(selectedPackage?.intake_context?.orders??[]).flatMap((ord:Row)=>
    (ord.expected_lines_summary?.lines_breakdown??[]).map((line:Row)=>({
      order_public_no:ord.public_no,
      reconciliation_status:ord.expected_lines_summary?.reconciliation_status,
      ...line,
    }))
  );
  const declaredItems:Row[]=selectedPackage?.intake_context?.declared_items??[];
  const declLower=declSearch.trim().toLowerCase();
  const filteredDeclared=declaredItems.filter((di:Row)=>!declLower||[di.order_public_no,di.sample_code,di.color,di.size,di.supplier_alias,di.bound_item_code,di.declared_tracking_no].some(v=>String(v??"").toLowerCase().includes(declLower)));
  const DECL_PER_PAGE=15;
  const declTotalPages=Math.max(1,Math.ceil(filteredDeclared.length/DECL_PER_PAGE));
  const safeDeclPage=Math.min(declPage,declTotalPages);
  const declSlice=filteredDeclared.slice((safeDeclPage-1)*DECL_PER_PAGE,safeDeclPage*DECL_PER_PAGE);

  const selPkgItems:Row[]=selectedPackage?.items??[];
  const pkgItemLower=pkgItemSearch.trim().toLowerCase();
  const filteredPkgItems=selPkgItems.filter((i:Row)=>!pkgItemLower||[i.code,i.location,i.custody_state,i.inspection_stage].some(v=>String(v??"").toLowerCase().includes(pkgItemLower)));
  const PKG_ITEM_PER_PAGE=15;
  const pkgItemTotalPages=Math.max(1,Math.ceil(filteredPkgItems.length/PKG_ITEM_PER_PAGE));
  const safePkgItemPage=Math.min(pkgItemPage,pkgItemTotalPages);
  const pkgItemSlice=filteredPkgItems.slice((safePkgItemPage-1)*PKG_ITEM_PER_PAGE,safePkgItemPage*PKG_ITEM_PER_PAGE);

  const pkgQuery=pkgSearch.trim().toLowerCase();
  const filteredPackages=(data.packages??[]).filter((p:Row)=>{
    if(pkgTab==="unpacked" && Number(p.logged_item_count??p.received_quantity??0)>0) return false;
    if(pkgTab==="unmatched" && p.state!=="unmatched") return false;
    if(pkgTab==="quarantined" && p.state!=="quarantined") return false;
    if(pkgTab==="checked_in" && p.state!=="checked_in") return false;
    if(!pkgQuery) return true;
    return [p.code,p.tracking_norm,p.receiving_code,...(p.order_numbers??[])].some(v=>String(v??"").toLowerCase().includes(pkgQuery));
  });
  const PKG_PER_PAGE=15;
  const pkgTotalPages=Math.max(1,Math.ceil(filteredPackages.length/PKG_PER_PAGE));
  const safePkgPage=Math.min(pkgPage,pkgTotalPages);
  const pkgSlice=filteredPackages.slice((safePkgPage-1)*PKG_PER_PAGE,safePkgPage*PKG_PER_PAGE);

  const smpQuery=sampleSearch.trim().toLowerCase();
  const filteredSamples=(data.items??[]).filter((it:Row)=>{
    if(sampleTab==="pending" && it.identity_state!=="pending") return false;
    if(sampleTab==="identified" && it.identity_state!=="identified") return false;
    if(sampleTab==="mismatch" && it.identity_state!=="mismatch") return false;
    if(!smpQuery) return true;
    const df=it.declared_fields??{};
    return [it.code,it.package_code,it.receiving_code,it.order_no,it.location,df.name,df.sku_code,df.sample_code].some(v=>String(v??"").toLowerCase().includes(smpQuery));
  });
  const SMP_PER_PAGE=20;
  const smpTotalPages=Math.max(1,Math.ceil(filteredSamples.length/SMP_PER_PAGE));
  const safeSmpPage=Math.min(samplePage,smpTotalPages);
  const smpSlice=filteredSamples.slice((safeSmpPage-1)*SMP_PER_PAGE,safeSmpPage*SMP_PER_PAGE);

  return <><div className="page-head row"><div><p className="eyebrow">WAREHOUSE OPERATIONS</p><h1>{heading[0]}</h1><p className="muted">{heading[1]}</p></div>
    {current==="overview"&&<div className="head-actions">
      <Link className="button primary" href="/wh/scan">扫码工作台</Link>
      {canIntakeWrite?<Link className="button" href="/wh/intake">收货入库</Link>:canReceive&&<Link className="button" href="/wh/packages">包裹台账</Link>}
      {canViewTasks&&<Link className="button" href="/wh/inspection">{canInspect?"检查队列":"质检监督"}</Link>}
      {canReview&&<Link className="button" href="/wh/review">{canReviewWrite?"QA 复核":"复核监督"}</Link>}
      {canShip&&<Link className="button" href="/wh/dispatch">{canShipWrite?"出库交接":"出库监督"}</Link>}
    </div>}
  </div>
    {demo&&<div className="row flexwrap" role="region" aria-label="演示员工角色切换" style={{marginBottom:16,justifyContent:"flex-start",gap:10}}>
      <span className="label-inline">演示员工角色</span>
      <select
        className="input"
        style={{width:170}}
        aria-label="演示员工角色"
        value={activeRoleKey}
        onChange={e=>{
          const map:Record<string,[string,string]>={
            receiving:["receiving@qcw.test","/wh"],
            inspector:["inspector@qcw.test","/wh"],
            reviewer:["reviewer@qcw.test","/wh"],
            warehouse:["receiving@qcw.test","/wh"],
            admin:["admin@qcw.test","/wh"],
          };
          const [email,dest]=map[e.target.value]??["admin@qcw.test","/wh"];
          void switchDemoPortal(dest,email);
        }}
      >
        <option value="receiving">收货员</option>
        <option value="inspector">检查员</option>
        <option value="reviewer">复核员</option>
        <option value="warehouse">仓管</option>
        <option value="admin">超级管理员</option>
      </select>
      <Tag tone="yellow">本地演示切换服务端员工会话</Tag>
    </div>}
    {current==="overview"&&<>
      <div className="stats" aria-label="仓库作业摘要">{overviewMetrics.map(([href,title,value,detail])=>
        <Link className="stat" href={href} key={title}><span className="label">{title}</span><strong className="value">{value}</strong><small className="detail">{detail}</small></Link>)}</div>
      <div className="grid cols2">
        <Panel title="本岗位今日作业队列" subtitle="严格按当前岗位权限裁剪可见队列与可执行动作，避免越权或盲目跳转。">
          <Table headers={["对象 / 订单","客户 / 责任人","运单 / 库位 / SLA","状态 / 阻塞","下一步"]} rows={todayRows} empty="本岗位当前暂无待处理作业。"/>
        </Panel>
        <Panel title="本岗位开放工作台入口">
          <div className="grid cols2">
            {availableLinks.filter(([href])=>href!=="/wh").map(([href,name])=><Link className="button sm" key={href} href={href}>{name}</Link>)}
          </div>
          <hr className="sep"/>
          <div className="line-note">员工端所有页面与写入权限严格与服务端 RBAC / OpenAPI 契约对齐；只读角色禁止执行写操作。</div>
        </Panel>
      </div>
    </>}
    {current==="intake"&&canReceive&&<>
      <ol className="intake-stages" aria-label="收货步骤">
        <li><a href="#intake-waybill"><span>01</span>核对运单与外箱</a></li>
        <li><a href="#intake-unpack"><span>02</span>开箱照 · 建档与标签</a></li>
        <li><a href="#item-intake"><span>03</span>核对身份与委托</a></li>
      </ol>
      {(data.delivered_unreceived?.length??0)>0&&<div className="notice" style={{marginBottom:12}}>
        <strong>承运商已签收、仓库尚未实收登记 ({data.delivered_unreceived.length})：</strong>
        <div className="actions" style={{marginTop:6,flexWrap:"wrap"}}>
          {data.delivered_unreceived.map((du:Row)=><button key={du.id} type="button" className="button sm" onClick={()=>{setIntakeTracking(du.tracking_norm);void runTrackingLookup(du.tracking_norm,du.carrier_code??"");}}>
            填入并查单：<span className="code">{du.tracking_norm}</span>{du.receiving_code?` · ${du.receiving_code}`:""}
          </button>)}
        </div>
      </div>}
      <section className="panel scan-panel" id="intake-waybill"><div className="section-heading"><span className="eyebrow">01 / 运单定位</span><h2>搜索卖家运单</h2><p className="muted">承运商签收不等于 QC Warehouse 实收。须核对外箱状况（完好/压扁/破损/水渍）并拍照留证。</p></div>
        <fieldset disabled={receiving} style={{display:"contents"}} onChange={()=>{setLookup(undefined);setLookupError("");setPackageId("");}}>
          <Form inline label="搜索" run={async f=>{
            await runTrackingLookup(text(f,"tracking"),text(f,"carrier"));
          }}><Field key={intakeTracking} name="tracking" label="扫描条码或手动输入运单号" value={intakeTracking}/><Select name="carrier" label="快递公司" choices={carrierOptions} required={false}/></Form>
        </fieldset>
        {lookupError?<ErrorBlock error={lookupError}/>:null}
        {lookup&&<div className="notice"><p>运单 <strong className="code">{lookup.tracking}</strong></p>
          <p>匹配结果 <strong>{({matched:"已关联订单",user_only:"已找到客户，待关联订单",unmatched:"待认领（入仓后须停放未认领区 U-01）",ambiguous:"多个候选，请核对快递公司"} as Row)[lookup.result.match_state]}</strong></p>
          {lookup.result.receiving_code&&<p className="code">专属收件码：{lookup.result.receiving_code}</p>}
          {lookup.result.order_ids.length>0&&<p>关联订单数 {lookup.result.order_ids.length}</p>}
          {lookup.context&&lookup.context.orders?.length>0&&<div className="small" style={{marginTop:6}}>
            <p style={{margin:"2px 0"}}>
              订单申报总件数：<strong>{lookup.context.total_declared_qty}</strong> 件 · 仓库累计已实收：<strong>{lookup.context.cumulative_received_qty}</strong> 件 · 待到仓/未收件数：<strong>{lookup.context.remaining_unreceived_qty??Math.max(0,(lookup.context.total_declared_qty??0)-(lookup.context.cumulative_received_qty??0))}</strong> 件 · 在途未到仓预报运单：<strong>{lookup.context.in_transit_advices_count}</strong> 单
            </p>
            <p className="muted" style={{margin:"2px 0"}}>
              关联委托订单：{lookup.context.orders.map((o:Row)=>`${o.public_no}（申报 ${o.total_declared_qty} / 已收 ${o.cumulative_received_qty} / 待绑 ${o.remaining_unlinked_qty}）`).join(" · ")}
            </p>
          </div>}
          {lookup.result.package_id&&<p>此运单已有实收记录，请按下方包裹状态继续处理。</p>}
        </div>}
        {lookup&&lookup.result.match_state!=="ambiguous"&&!lookup.result.package_id&&(canIntakeWrite?<Form key={lookup.tracking+"-"+lookup.carrier} label="确认实物到仓" run={async f=>{
          const outerCondition=text(f,"outer_condition")||"intact";
          const conditionNote=text(f,"condition_note").trim();
          if((lookup.result.match_state==="unmatched"||outerCondition!=="intact")&&conditionNote.length<4) {
            throw new Error("包裹未匹配或外箱异常时，请填写不少于 4 个字的收货说明。");
          }
          setReceiving(true);
          try {
            const photo=await upload(f.get("photo"),"intake_outer");
            const weight=text(f,"weight");
            const parcel=await request("/staff/intake/check-in","POST",{
              tracking_no:lookup.tracking,
              ...(lookup.carrier?{carrier_code:lookup.carrier}:{}),
              ...(lookup.result.advice_id?{advice_id:lookup.result.advice_id}:{}),
              ...(weight?{weight_g:Number(weight)}:{}),
              outer_condition:outerCondition,
              ...(conditionNote?{condition_note:conditionNote}:{}),
              outer_media_ids:[photo],
            });
            setLookup({...lookup,result:{...lookup.result,package_id:parcel.id}});setPackageId(parcel.id);reload();
          } finally {
            setReceiving(false);
          }
        }}>
          <div className="fields three">
            <Field name="weight" label="包裹实重（克）" type="number" min={1} required={false}/>
            <Select name="outer_condition" label="外箱状况（必选）" value="intact" choices={[
              {id:"intact",label:"完好 (intact)"},
              {id:"crushed",label:"压扁变形 (crushed)"},
              {id:"torn",label:"破损开裂 (torn)"},
              {id:"wet",label:"水渍受潮 (wet)"},
            ]}/>
            <Field name="condition_note" label={lookup.result.match_state==="unmatched"?"未匹配说明（必填，至少 4 字）":"外箱异常备注（外箱异常时必填，至少 4 字）"} required={lookup.result.match_state==="unmatched"}/>
          </div>
          <Photo label="包裹外箱照片（含快递面单与外箱全貌）"/>
        </Form>:<p className="notice">当前为只读监督模式：收货实收写操作仅限收货员（receiver）与仓库主管（warehouse_admin）。</p>)}
      </section>
      <Panel title="02 / 拆包开箱留证、分组 SKU 核对与逐件建档" id="intake-unpack">
        <label>入仓包裹<select value={packageId} onChange={e=>{setPackageId(e.target.value);setBatchPrintResult(undefined);setBatchVerifyResult(undefined);setDiscrepancyResult(undefined);setPkgItemPage(1);setDeclPage(1);setOpenPhotoMessage("");}}>
          <option value="">选择包裹</option>
          {packageId&&!data.packages.some((p:Row)=>p.id===packageId)&&<option value={packageId}>{selectedPackage?.parcel.code??"正在定位包裹"}</option>}
          {data.packages.map((p:Row)=><option key={p.id} value={p.id}>{p.code} · {p.tracking_norm??"—"}</option>)}
        </select></label>
        {packageId&&packageDetail.error&&<><ErrorBlock error={packageDetail.error}/><button type="button" onClick={packageDetail.reload}>重新读取包裹</button></>}
        {packageId&&!selectedPackage&&!packageDetail.error&&<p role="status">正在读取包裹…</p>}
        {selectedPackage&&<><div className="row flexwrap" style={{marginBottom:8}}>
            <p style={{margin:0}}><Link className="code" href={"/wh/packages/"+encodeURIComponent(selectedPackage.parcel.code)}>{selectedPackage.parcel.code}</Link> · 本包已建档 <strong>{selectedPackage.parcel.received_quantity}</strong> 件 · 外箱 <Tag>{label(selectedPackage.parcel.outer_condition??"intact")}</Tag> · 状态 <Tag>{label(selectedPackage.parcel.state)}</Tag></p>
            <div className="actions">
              {(selectedPackage.parcel.open_media_ids?.length??0)>0
                ?<MediaButton ids={selectedPackage.parcel.open_media_ids} label={`查看开箱照 (${selectedPackage.parcel.open_media_ids.length})`}/>
                :<Tag tone="yellow">尚未补充开箱照</Tag>}
              <Link className="button sm" href={"/wh/packages/"+encodeURIComponent(selectedPackage.parcel.code)}>打开包裹详情页</Link>
            </div>
          </div>
          {canIntakeWrite&&selectedPackage.parcel.state!=="quarantined"&&<div className="card" style={{marginBottom:12}}>
            <Form key={`open-photo-${selectedPackage.parcel.id}-${selectedPackage.parcel.revision}`} inline label="上传并登记开箱照" run={async f=>{
              const file=f.get("open_photo");
              const mid=await upload(file,"intake_open");
              await request("/staff/packages/"+selectedPackage.parcel.id+"/open-photos","POST",{
                revision:selectedPackage.parcel.revision,
                open_media_ids:[mid],
              });
              setOpenPhotoMessage("已补充登记开箱照片，客户与质检工作台可同步查阅。");
              packageDetail.reload();reload();
            }}>
              <Photo name="open_photo" label="开箱照（拆箱全貌 / 吊牌内衬）"/>
            </Form>
            {openPhotoMessage&&<p className="notice" role="status">{openPhotoMessage}</p>}
          </div>}
          {selectedPackage.parcel.order_numbers.length>0&&<p>关联订单 {selectedPackage.parcel.order_numbers.join("、")}</p>}
          {groupedSkuRows.length>0&&<div className="card" style={{marginBottom:12}}>
            <div className="row flexwrap">
              <strong>SKU / 颜色 / 尺码分组对账汇总（区分已建档待核身与实短）</strong>
              {selectedPackage.intake_context&&<span className="small muted">
                订单总申报 <strong>{selectedPackage.intake_context.total_declared_qty}</strong> 件 · 仓库累计实收 <strong>{selectedPackage.intake_context.cumulative_received_qty}</strong> 件 · 在途未到运单 <strong>{selectedPackage.intake_context.in_transit_advices_count}</strong> 单
              </span>}
            </div>
            <Table
              headers={["订单号","品名 / SKU","颜色 / 尺码","委托件数","已绑实收","待核身 / 待到","已确认缺少"]}
              rows={groupedSkuRows.map((g:Row)=>{
                const unvShort=Number(g.unverified_short_qty??0);
                const confShort=Number(g.confirmed_short_qty??g.missing_qty??0);
                return [
                  <span className="code">{g.order_public_no}</span>,
                  <div className="cell-stack"><span>{g.product_name||"—"}</span><small className="code">{g.sku_code||"—"}</small></div>,
                  `${g.color_declared||"—"} / ${g.size_label||"—"}`,
                  g.expected_qty,
                  g.identified_qty,
                  g.unidentified_pending_qty>0?<Tag tone="yellow">待核身 {g.unidentified_pending_qty}</Tag>:(unvShort>0?`待到/核 ${unvShort}`:0),
                  confShort>0?<Tag tone="red">{confShort}</Tag>:0,
                ];
              })}
            />
          </div>}
          {declaredItems.length>0&&<details className="card" style={{marginBottom:12}} open={declaredItems.length<=10}>
            <summary>逐件委托明细（共 {declaredItems.length} 项，按需展开核对）</summary>
            <div className="admin-toolbar" style={{marginTop:8}}>
              <label>筛选委托明细<input type="search" value={declSearch} onChange={e=>{setDeclSearch(e.target.value);setDeclPage(1);}} placeholder="款号 / 颜色 / 尺码 / 运单 / 实物码"/></label>
            </div>
            <Table
              headers={["订单号 / 位置","款号 (Sample Code)","颜色 / 尺码","供应商","申报运单","已绑实物码"]}
              rows={declSlice.map((di:Row)=>[
                <span className="code">{di.order_public_no} #{di.position}</span>,
                <span className="code">{di.sample_code??"—"}</span>,
                `${di.color??"—"} / ${di.size??"—"}`,
                di.supplier_alias??"—",
                <span className="code">{di.declared_tracking_no??"—"}</span>,
                di.bound_item_code?<CodeButton code={di.bound_item_code} onClick={()=>selectItem(di.bound_item_code)}/>:<Tag tone="yellow">待绑定</Tag>,
              ])}
              empty="无匹配委托明细。"
            />
            {declTotalPages>1&&<div className="actions" style={{marginTop:8}}>
              <button type="button" className="button sm" disabled={safeDeclPage<=1} onClick={()=>setDeclPage(p=>Math.max(1,p-1))}>上一页</button>
              <span className="small muted">第 {safeDeclPage} / {declTotalPages} 页</span>
              <button type="button" className="button sm" disabled={safeDeclPage>=declTotalPages} onClick={()=>setDeclPage(p=>Math.min(declTotalPages,p+1))}>下一页</button>
            </div>}
          </details>}
          <div className="admin-toolbar" style={{marginTop:8}}>
            <label>筛查本包已建档实物 ({selPkgItems.length} 件)<input type="search" value={pkgItemSearch} onChange={e=>{setPkgItemSearch(e.target.value);setPkgItemPage(1);}} placeholder="实物码 S-... / 库位 / 状态"/></label>
          </div>
          <Table headers={["实物码","类型","库存状态","质检阶段","当前库位","同屏快捷操作"]} rows={pkgItemSlice.map((i:Row)=>[
            <span className="code">{i.code}</span>,
            i.parent_item_id?"套装组件":"主件",
            label(i.custody_state),
            <Tag tone={i.inspection_stage==="in_inspection"?"yellow":i.inspection_stage==="inspected"?"green":"gray"}>{label(i.inspection_stage??"pending")}</Tag>,
            <span className="code">{i.location??"—"}</span>,
            <div className="actions">
              <a className="button sm primary" href="#item-intake" onClick={()=>selectItem(i.code)}>同屏核对/绑单</a>
              {canIntakeWrite&&["received","stored"].includes(i.custody_state)&&<Form inline key={`mv-${i.id}-${i.revision}`} label="移位" run={async f=>{
                const locId=text(f,"to_loc");
                const locObj=data.locations.find((l:Row)=>l.id===locId);
                if(!locObj) throw new Error("请选择目标库位。");
                await request("/staff/storage/move","POST",{
                  item_id:i.id,
                  revision:i.revision,
                  location_id:locObj.id,
                  scanned_item_code:i.code,
                  scanned_location_code:locObj.code,
                });
                packageDetail.reload();reload();
              }}>
                <Select name="to_loc" label="" choices={locations.filter((l:{id:string;label:string})=>l.label!==i.location)}/>
              </Form>}
            </div>,
          ])} empty="该包裹尚未建档任何实物。"/>
          {pkgItemTotalPages>1&&<div className="actions" style={{marginTop:8}}>
            <button type="button" className="button sm" disabled={safePkgItemPage<=1} onClick={()=>setPkgItemPage(p=>Math.max(1,p-1))}>上一页</button>
            <span className="small muted">第 {safePkgItemPage} / {pkgItemTotalPages} 页</span>
            <button type="button" className="button sm" disabled={safePkgItemPage>=pkgItemTotalPages} onClick={()=>setPkgItemPage(p=>Math.min(pkgItemTotalPages,p+1))}>下一页</button>
          </div>}
          {canIntakeWrite&&selectedPackage.parcel.state!=="quarantined"&&<Form key={packageId} label="逐件建档（自动生成无歧义 6 位 Base32 样品码）" run={async f=>{
            const n=Number(text(f,"quantity"));
            const parentId=text(f,"component_of");
            if(!Number.isInteger(n) || n<1 || n>100)throw new Error("请填写实际件数。");
            const items=Array.from({length:n},()=>({
              code:generateRandomSampleCode(),
              location_id:text(f,"location"),
              ...(parentId?{component_of:parentId}:{}),
            }));
            await request("/staff/packages/"+selectedPackage.parcel.id+"/items","POST",{revision:selectedPackage.parcel.revision,items});
            packageDetail.reload();reload();
          }}>
            <div className="fields three">
              <Field name="quantity" label="本次新增实物件数" type="number" min={1} max={100} value={1}/>
              <Select name="location" label="目标库位（系统自动校验分区用途）" choices={locations}/>
              <Select name="component_of" label="套装主件（登记子组件时选择，主件留空）" required={false}
                choices={selectedPackage.items.filter((i:Row)=>!i.parent_item_id).map((i:Row)=>({id:i.id,label:i.code}))}/>
            </div>
          </Form>}
          {canPrintLabels&&selectedPackage.items.length>0&&<div className="card" style={{marginTop:12}}>
            <h3 style={{marginTop:0}}>同屏批量打印本包样品标签与独立扫码回读 ({selectedPackage.items.length} 件)</h3>
            <Form inline label="批量生成本包样品条码标签" run={async f=>{
              const res=await request("/staff/labels/print","POST",{
                item_ids:selectedPackage.items.map((i:Row)=>i.id),
                label_size:text(f,"label_size")||"standard_80x50",
                ...(text(f,"reprint_reason")?{reprint_reason:text(f,"reprint_reason")}:{}),
              });
              setBatchPrintResult({
                print_id:res.print_id,
                pdf_url:res.pdf_url,
                preview_png_url:res.preview_png_url,
                codes:selectedPackage.items.map((i:Row)=>i.code),
              });
              setBatchVerifyResult(undefined);
            }}>
              <Select name="label_size" label="标签规格" value="standard_80x50" choices={[
                {id:"standard_80x50",label:"80×50mm 标准热敏签"},
                {id:"compact_50x30",label:"50×30mm 服装吊牌小签"},
                {id:"shelf_100x60",label:"100×60mm 宽幅签"},
              ]}/>
              <Field name="reprint_reason" label="重打原因（首次打印留空）" required={false}/>
            </Form>
            {batchPrintResult&&<div className="notice" role="status" style={{marginTop:8}}>
              <p>已生成 {batchPrintResult.codes.length} 张真实可解码 QR + Code-128 标签 · <a href={"/api/v1/staff/labels/"+batchPrintResult.print_id+"/file"} target="_blank" rel="noreferrer">下载标签 PDF</a> · <a href={"/api/v1/staff/labels/"+batchPrintResult.print_id+"/preview.png"} target="_blank" rel="noreferrer">查看 PNG 预览</a></p>
              <img src={"/api/v1/staff/labels/"+batchPrintResult.print_id+"/preview.png"} alt="真实条码预览" style={{maxWidth:320,border:"1px solid #cbd5e1",borderRadius:6,marginTop:6}}/>
            </div>}
            <Form inline label="连续扫码批量回读核验" run={async f=>{
              const scanned=text(f,"scanned_codes").split(/[\s,，;；]+/).map(s=>s.trim().toUpperCase()).filter(Boolean);
              if(!scanned.length) throw new Error("请实际使用扫码枪扫入或输入贴好后的样品码。");
              const expected=selectedPackage.items.map((i:Row)=>i.code);
              const res=await request("/staff/labels/verify","POST",{expected_codes:expected,scanned_codes:scanned});
              setBatchVerifyResult(res);
            }}>
              <Field name="scanned_codes" label="扫码录入已贴标签 S-... 条码（空格/逗号分隔，严禁预填）"/>
            </Form>
            {batchVerifyResult&&<p className="notice" role="status">批量回读核验通过：共 {batchVerifyResult.verified_count} 件样品条码与数据库 100% 一致。</p>}
          </div>}
          {canIntakeWrite&&<details className="card" style={{marginTop:12}}>
            <summary>实收件数与申报不符 / 多包裹分批在途登记</summary>
            <p className="small muted" style={{marginTop:6}}>仅当本包裹确有实少/多发/错货或确认为分批在途时提交；若仅是已实收建档尚未完成 SKU 核身，请先完成第 03 步绑定。</p>
            <Form label="提交包裹数量核对结论" run={async f=>{
              const chosenOrderId=text(f,"order_id")||(selectedPackage.intake_context?.orders?.[0]?.order_id??selectedPackage.intake_context?.orders?.[0]?.id??"");
              const res=await request("/staff/packages/"+selectedPackage.parcel.id+"/discrepancy","POST",{
                revision:selectedPackage.parcel.revision,
                ...(chosenOrderId?{order_id:chosenOrderId}:{}),
                expected_qty:Number(text(f,"expected_qty")),
                actual_qty:Number(text(f,"actual_qty")),
                discrepancy_type:text(f,"discrepancy_type"),
                note:text(f,"note"),
              });
              setDiscrepancyResult(res);
              packageDetail.reload();reload();
            }}>
              {(selectedPackage.intake_context?.orders?.length??0)>0&&<Select
                name="order_id"
                label="关联委托订单"
                value={selectedPackage.intake_context.orders[0].order_id??selectedPackage.intake_context.orders[0].id}
                choices={selectedPackage.intake_context.orders.map((o:Row)=>({
                  id:o.order_id??o.id,
                  label:`${o.public_no}（订单共声明 ${o.total_declared_qty} 件 · 累计实收 ${o.cumulative_received_qty} 件）`,
                }))}
              />}
              <div className="fields three">
                <Field name="expected_qty" label="对应应收件数（本包或该单口径）" type="number" min={1} value={selectedPackage.intake_context?.total_declared_qty||selectedPackage.parcel.received_quantity||1}/>
                <Field name="actual_qty" label="本包清点实收件数" type="number" min={0} value={selectedPackage.parcel.received_quantity||0}/>
                <Select name="discrepancy_type" label="差异类型" choices={[
                  {id:"partial_shipment_in_transit",label:"多包裹分批到货（其余运单在途，保持待收齐）"},
                  {id:"shortage",label:"卖家少发/短装（挂起订单并通知客户）"},
                  {id:"overage",label:"卖家多发/超装（挂起订单并通知客户）"},
                  {id:"wrong_item",label:"错发完全不同商品（挂起订单并通知客户）"},
                ]}/>
              </div>
              <Field name="note" label="核对差异说明（客户与客服可见）" value="已核对外箱与内物清点数量"/>
            </Form>
            {discrepancyResult&&<p className="notice" role="status">
              已记录数量核对结果：{discrepancyResult.discrepancy_type}
              {discrepancyResult.ticket_no?` · 已生成异常工单 ${discrepancyResult.ticket_no}`:""}
              {discrepancyResult.order_held?" · 关联订单已自动冻结为暂停状态 (on_hold)":""}
            </p>}
          </details>}
        </>}
      </Panel>
      <Panel title="03 / 实物识别与委托" id="item-intake">
        <div onChange={()=>setItemCode("")}>
          <Form inline label="定位实物" run={async f=>selectItem(text(f,"item_code"))}>
            <Field name="item_code" label="扫描或输入实物码"/>
          </Form>
        </div>
        {!itemCode&&<Empty>扫描实物标签，或从上方包裹清单点击“同屏核对/绑单”直接加载。</Empty>}
        {itemCode&&itemDetail.error&&<><ErrorBlock error={itemDetail.error}/><button type="button" onClick={itemDetail.reload}>重新读取实物</button></>}
        {itemCode&&!item&&!itemDetail.error&&<p role="status">正在读取实物…</p>}
        {item&&!itemDetail.error&&<ItemIdentity data={itemDetail.data!} actor={actor} onSave={()=>{itemDetail.reload();packageDetail.reload();reload();}}/>}
      </Panel>
    </>}
    {current==="packages"&&<>
      <Panel title={`外箱及实收包裹列表 (${filteredPackages.length})`} subtitle="支持按包裹号/运单号/专属收件码/订单号搜索，按拆包与认领状态筛选。">
        <div className="admin-toolbar">
          <label>检索包裹 / 运单 / 客户码 / 订单号
            <input type="search" value={pkgSearch} onChange={e=>{setPkgSearch(e.target.value);setPkgPage(1);}} placeholder="P86425 / SF... / QCW56084 / QW261121835"/>
          </label>
          <div className="actions" aria-label="包裹状态筛选">
            {([
              ["all","全部"],
              ["unpacked","待拆包建档"],
              ["unmatched","无主待认领"],
              ["quarantined","已隔离"],
              ["checked_in","已实收"],
            ] as const).map(([tid,tlbl])=><button key={tid} type="button" className={"button sm"+(pkgTab===tid?" primary":"")} onClick={()=>{setPkgTab(tid);setPkgPage(1);}}>{tlbl}</button>)}
          </div>
        </div>
        <Table headers={["包裹 / 实收时间","客户码 / 关联订单","原始运单","实收 / 实重","入库状态","操作"]} rows={pkgSlice.map((parcel:Row)=>[
          <div key="pc" className="cell-stack">
            <Link className="code" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{parcel.code}</Link>
            <small className="muted">{stamp(parcel.received_at)}</small>
          </div>,
          <div key="cu" className="cell-stack">
            <span className="code">{parcel.receiving_code??"无主待认领"}</span>
            {parcel.order_numbers?.length>0&&<small className="code">{parcel.order_numbers.join("、")}</small>}
          </div>,
          parcel.tracking_norm?<CodeButton code={parcel.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:parcel.tracking_norm})}/>:<span className="muted">—</span>,
          <div key="qty" className="cell-stack">
            <span>实收 {parcel.logged_item_count??parcel.received_quantity} 件</span>
            <small className="muted">{parcel.weight_g?`${parcel.weight_g} g`:"未称重"}</small>
          </div>,
          <div key="st" className="cell-stack">
            <Tag tone={parcel.state==="unmatched"||parcel.state==="quarantined"?"yellow":"green"}>{label(parcel.state)}</Tag>
            {parcel.outer_condition&&parcel.outer_condition!=="intact"&&<small className="bad">{label(parcel.outer_condition)}</small>}
          </div>,
          <Link className="button sm" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>包裹详情</Link>,
        ])} empty="暂无符合筛选条件的包裹记录。"/>
        {pkgTotalPages>1&&<div className="actions" style={{marginTop:10}}>
          <button type="button" className="button sm" disabled={safePkgPage<=1} onClick={()=>setPkgPage(p=>Math.max(1,p-1))}>上一页</button>
          <span className="small muted">第 {safePkgPage} / {pkgTotalPages} 页（共 {filteredPackages.length} 个包裹）</span>
          <button type="button" className="button sm" disabled={safePkgPage>=pkgTotalPages} onClick={()=>setPkgPage(p=>Math.min(pkgTotalPages,p+1))}>下一页</button>
        </div>}
      </Panel>
    </>}
    {current==="samples"&&<>
      <Panel title={`在库样品与实物清单 (${filteredSamples.length})`} subtitle="支持按样品码/客户码/订单/品名/SKU检索与核身状态筛选，并支持下方扫码快速核身。">
        <div className="admin-toolbar">
          <label>检索样品码 / 包裹 / 订单 / 品名 / SKU
            <input type="search" value={sampleSearch} onChange={e=>{setSampleSearch(e.target.value);setSamplePage(1);}} placeholder="S39204 / P86425 / QW261121835 / 款号"/>
          </label>
          <div className="actions" aria-label="样品核身筛选">
            {([
              ["all","全部"],
              ["pending","待核身"],
              ["identified","已识别"],
              ["mismatch","身份异常"],
            ] as const).map(([sid,slbl])=><button key={sid} type="button" className={"button sm"+(sampleTab===sid?" primary":"")} onClick={()=>{setSampleTab(sid);setSamplePage(1);}}>{slbl}</button>)}
          </div>
        </div>
        <Table headers={["样品码 / 包裹","客户码 / 订单","品名 / 款号","当前库位","身份 / 库存","质检进度","作业入口"]} rows={smpSlice.map((it:Row)=>[
          <div key="sc" className="cell-stack">
            <Link className="code" href={"/wh/samples/"+encodeURIComponent(it.code)}>{it.code}</Link>
            <small className="code muted">{it.package_code??"—"}</small>
          </div>,
          <div key="co" className="cell-stack">
            <span className="code">{it.receiving_code??"无主"}</span>
            {it.order_no&&<small className="code">{it.order_no}</small>}
          </div>,
          <div key="pd" className="cell-stack">
            <span>{it.declared_fields?.name||"—"}</span>
            {(it.declared_fields?.sku_code||it.declared_fields?.sample_code)&&<small className="code">{it.declared_fields?.sku_code||it.declared_fields?.sample_code}</small>}
          </div>,
          <span className="code">{it.location??"待上架"}</span>,
          <div key="st" className="cell-stack">
            <Tag tone={it.identity_state==="identified"?"green":"yellow"}>{label(it.identity_state)}</Tag>
            <small>{label(it.custody_state)}</small>
          </div>,
          <Tag tone={it.inspection_stage==="in_inspection"?"yellow":it.inspection_stage==="inspected"?"green":"gray"}>{label(it.inspection_stage??"pending")}</Tag>,
          <div className="actions">
            <Link className="button sm" href={"/wh/samples/"+encodeURIComponent(it.code)}>样品详情</Link>
            {canIntakeWrite&&<Link className="button sm" href={"/wh/storage?"+new URLSearchParams({item:it.code})}>移到库位</Link>}
          </div>,
        ])} empty="暂无符合条件的在库样品。"/>
        {smpTotalPages>1&&<div className="actions" style={{marginTop:10}}>
          <button type="button" className="button sm" disabled={safeSmpPage<=1} onClick={()=>setSamplePage(p=>Math.max(1,p-1))}>上一页</button>
          <span className="small muted">第 {safeSmpPage} / {smpTotalPages} 页（共 {filteredSamples.length} 件）</span>
          <button type="button" className="button sm" disabled={safeSmpPage>=smpTotalPages} onClick={()=>setSamplePage(p=>Math.min(smpTotalPages,p+1))}>下一页</button>
        </div>}
      </Panel>
      <Panel title="按编号快速核对样品" id="sample-quick-lookup">
        <Form inline label="定位实物" run={async f=>selectItem(text(f,"item_code"))}>
          <Field name="item_code" label="扫描或输入样品码 S-..."/>
        </Form>
        {itemCode&&itemDetail.error&&<ErrorBlock error={itemDetail.error}/>}
        {item&&!itemDetail.error&&<ItemIdentity data={itemDetail.data!} actor={actor} onSave={()=>{itemDetail.reload();reload();}}/>}
      </Panel>
    </>}
    {current==="inspection"&&<>
      <Panel title="待处理任务队列" subtitle="按本人负责/待认领/QA退回/超时筛选，按订单汇总派工。">
        <Form inline label="扫码定位任务" run={async f=>{
          const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"scan_code")}));
          location.assign("/wh/task/"+hit.task_id);
        }}><Field name="scan_code" label="扫描或输入样品码 S39204 / 订单号 QW261121835"/></Form>
        <div className="admin-toolbar" style={{marginTop:10}}>
          <label>检索订单 / 样品码 / 客户码 / 执行人 / 品名
            <input type="search" value={queueSearch} onChange={e=>setQueueSearch(e.target.value)} placeholder="QW261121835 / S39204 / QCW56084 / 款号"/>
          </label>
          <div className="actions" aria-label="任务状态快速筛选">
            {([
              ["all","全部"] as const,
              ...(canInspect?([["mine","我负责的"],["unclaimed","待领取"]] as const):([["unclaimed","待领取"]] as const)),
              ["others","他人负责"] as const,
              ["returned",`QA退回 (${m.returned_task_count??0})`] as const,
              ["overdue",`SLA超时 (${m.overdue_task_count??0})`] as const,
              ["SUBMITTED","待汇总/复核"] as const,
            ]).map(([fid,lbl])=><button key={fid} type="button" className={"button sm"+(queueFilter===fid?" primary":"")} onClick={()=>setQueueFilter(fid)}>{lbl}</button>)}
          </div>
        </div>
        {!canInspect&&<p className="notice">当前岗位无检查执行写入权限（仅检查员 inspector 可领取/录入/提交报告），点击任务仅支持只读监督。</p>}
        {!groups.length&&<Empty>当前筛选条件下暂无任务。</Empty>}
        {groups.map(ts=><div key={ts[0].order_id} className="card">
          <div className="row flexwrap">
            <div>
              <h3 style={{margin:0}}>{ts[0].public_no} · {ts[0].receiving_code??"—"} · {ts[0].category_labels?.["zh-CN"]??"商品"} · {ts.length} 项任务</h3>
              {ts[0].customer_notes&&<p className="small muted" style={{margin:"4px 0 0"}}>客户备注：{ts[0].customer_notes}</p>}
              {(ts[0].order_blocks?.length??0)>0&&<p className="small bad" style={{margin:"4px 0 0"}}>订单阻塞：{ts[0].order_blocks.join("；")}</p>}
            </div>
            <div className="actions">
              {ts[0].has_tolerances&&<Tag tone="blue">含客户公差设定</Tag>}
              <Tag>{label(ts[0].order_state)}</Tag>
              <span>{ts[0].sla_overdue?<Tag tone="red">SLA 已超时</Tag>:<span className="muted small">SLA 截止：{stamp(ts[0].sla_due_at)}</span>}</span>
            </div>
          </div>
          <Table headers={["物件 / 库位","品名 / 规格","服务","执行人 / 状态","退回意见 / 阻塞","操作"]} rows={ts.map(t=>[
            <div key="o" className="cell-stack">
              <span className="code">{t.item_code??"比较组"}</span>
              {t.location_code&&<small className="code muted">{t.location_code}</small>}
            </div>,
            <div key="p" className="cell-stack">
              <span>{t.declared_fields?.name||t.declared_fields?.sku_code||t.declared_fields?.sample_code||"—"}</span>
              {(t.declared_fields?.color_declared||t.declared_fields?.size_label)&&<small className="muted">{[t.declared_fields?.color_declared,t.declared_fields?.size_label].filter(Boolean).join(" / ")}</small>}
            </div>,
            t.title["zh-CN"],
            <div key="s" className="cell-stack">
              <Tag tone={t.returned_reason?"red":t.state==="IN_PROGRESS"?"blue":"yellow"}>{label(t.state)}</Tag>
              <small className="muted">执行人：{t.assignee_name??"未指派"}</small>
            </div>,
            t.returned_reason?<small className="bad">{t.returned_reason}</small>:(t.order_blocks?.length?<small className="bad">{t.order_blocks.join("；")}</small>:<span className="muted">—</span>),
            <Link className={"button sm"+(canInspect?" primary":"")} href={"/wh/task/"+t.id}>{canInspect?(t.state==="READY"?"领取并检查":"进入工作台"):"只读查看"}</Link>
          ])}/>
          {canInspect&&ts[0].order_state!=="qa_review"&&ts.every(t=>t.state==="SUBMITTED")&&ts.some(t=>t.assignee_id===actor.id)&&<Action primary run={async()=>{
            const res=await request("/staff/inspection-tasks/"+ts[0].id);
            await request("/staff/orders/"+ts[0].order_id+"/report/submit","POST",{revision:res.order_revision,task_ids:ts.map(t=>t.id)});reload();
          }}>汇总并提交报告</Action>}
        </div>)}
      </Panel>
    </>}
    {current==="execute"&&<>
      {!canInspect&&<p className="notice" style={{marginBottom:12}}><strong>只读监督模式：</strong>当前角色（{actor.roles.join(", ")}）无检查录入写入权限；扫码进入后仅可浏览检查单与证据，不可保存或提交。</p>}
      <Panel title="选择或扫描检查任务" subtitle="扫描样品标签或从下方待执行任务直接进入检查录入工作台。">
        <Form inline label="打开检查工作台" run={async f=>{
          const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"scan_code")}));
          location.assign("/wh/task/"+hit.task_id);
        }}><Field name="scan_code" label="扫描或输入样品码 S39204 / 订单号 QW261121835"/></Form>
        <div className="admin-toolbar" style={{marginTop:10}}>
          <label>检索订单 / 样品码 / 客户码 / 执行人 / 品名
            <input type="search" value={queueSearch} onChange={e=>setQueueSearch(e.target.value)} placeholder="QW261121835 / S39204 / QCW56084"/>
          </label>
        </div>
        <Table headers={["关联订单 / 客户","样品码 / 库位","品名 / 规格","服务类型","执行人 / 状态","操作"]} rows={filteredTasks.map((t:Row)=>[
          <div key="o" className="cell-stack">
            <span className="code">{t.public_no}</span>
            <small className="code muted">{t.receiving_code??"—"}</small>
          </div>,
          <div key="s" className="cell-stack">
            <span className="code">{t.item_code??"对比组"}</span>
            {t.location_code&&<small className="code muted">{t.location_code}</small>}
          </div>,
          <div key="pd" className="cell-stack">
            <span>{t.declared_fields?.name||t.declared_fields?.sku_code||"—"}</span>
            {(t.declared_fields?.color_declared||t.declared_fields?.size_label)&&<small className="muted">{[t.declared_fields?.color_declared,t.declared_fields?.size_label].filter(Boolean).join(" / ")}</small>}
          </div>,
          t.title?.["zh-CN"]??t.service,
          <div key="st" className="cell-stack">
            <Tag tone={t.returned_reason?"red":t.state==="IN_PROGRESS"?"blue":"yellow"}>{label(t.state)}</Tag>
            <small className="muted">{t.assignee_name??"未指派"}{t.returned_reason?" · 退回补正":""}</small>
          </div>,
          <Link className={"button sm"+(canInspect?" primary":"")} href={"/wh/task/"+t.id}>{canInspect?"进入执行检查":"只读查看"}</Link>,
        ])} empty="当前没有待执行的检查任务。"/>
      </Panel>
    </>}
    {current==="sync"&&<OfflineSyncQueue tasks={data.tasks} actor={actor}/>}
    {current==="dispatch"&&<>
      {canShip?<><DispatchQueue onOpenDrawer={setDrawer} canShipWrite={canShipWrite}/>
      {!!data.retain.length&&<Panel title="续存报价">
        {data.retain.map((i:Row)=><p key={i.id}><CodeButton code={i.code} onClick={()=>setDrawer({kind:"item",ref:i.code})}/> {i.order_no?<span className="code muted">{i.order_no} </span>:null}{typeof i.days==="number"?`客户申请 ${i.days} 天 · `:""}
          {canShipWrite
            ?<Action run={async()=>{await request("/staff/dispositions/"+i.id+"/storage-quote","POST",{});reload();}}>{i.renewal?"重新报价":"生成续存报价"}</Action>
            :<Tag>仅查看（仓管可执行报价）</Tag>}</p>)}
      </Panel>}</>:<Panel title="出库待办"><p className="muted">当前演示角色无出库交接权限，请切换为“仓管”或“超级管理员”查看发运批次。</p></Panel>}
    </>}
    <StaffObjectDrawer target={drawer} actor={actor} onClose={()=>setDrawer(null)}/>
  </>;
}

function OfflineSyncQueue({tasks,actor}:{tasks:Row[];actor:Row}) {
  const [entries,setEntries]=useState<{key:string;taskId:string;count:number}[]>([]);
  const prefix="qcw_task_draft_"+actor.id+"_";
  useEffect(()=>{
    const found:{key:string;taskId:string;count:number}[]=[];
    try {
      for(let i=0;i<localStorage.length;i++) {
        const key=localStorage.key(i);
        if(key?.startsWith(prefix)) {
          const parsed=JSON.parse(localStorage.getItem(key)??"[]");
          if(Array.isArray(parsed)&&parsed.length>0) found.push({key,taskId:key.slice(prefix.length),count:parsed.length});
        }
      }
    } catch {}
    setEntries(found);
  },[prefix]);
  return <>
    <Panel title="待同步数据与照片" subtitle="本机离线暂存的检查草稿恢复网络后可幂等批量重放至服务端。">
      <Table
        headers={["项目","本机状态","服务端事实","操作"]}
        rows={entries.map(e=>{
          const matched=tasks.find(t=>t.id===e.taskId);
          return [
            <span className="code">{matched?`${matched.public_no} (${matched.item_code??"对比组"})`:e.taskId.slice(0,8)}</span>,
            <Tag tone="yellow">待同步 {e.count} 项</Tag>,
            matched?`服务端状态：${label(matched.state)}`:"可进入工作台核对版本",
            <Link className="button sm primary" href={"/wh/task/"+e.taskId}>打开并同步</Link>,
          ];
        })}
        empty="当前浏览器没有待同步的离线检查草稿。"
      />
    </Panel>
    <Panel title="冲突恢复原则">
      <ul className="list">
        <li>作业切换账号后，旧账号未提交数据不得暴露给新账号。</li>
        <li>服务端报告发布后，旧版草稿不允许覆盖发布版本。</li>
        <li>同步重试必须去重，失败时保留原始错误与可恢复路径。</li>
      </ul>
    </Panel>
  </>;
}
function dispatchAction(action:string) {
  return action==="return_to_seller"?"寄回商家":action==="to_forwarder"?"寄集运仓":"国内转寄";
}
const dispatchQueueLabels:Record<string,string>={
  weighing:"待称重报价",payment:"待客户确认或付款",packing:"待装箱",
  handover:"待交接",shipped:"已交接",returned:"有退回记录",blocked:"付款需核对",
};
function DispatchQueue({onOpenDrawer,canShipWrite=true}:{onOpenDrawer?:(t:StaffObjectTarget)=>void;canShipWrite?:boolean}) {
  const search=useSearchParams();
  const state=search.get("state")??"weighing",reference=search.get("reference")?.trim()??"";
  const params=new URLSearchParams({state,...(reference?{reference}:{})});
  const {data,error,reload}=useLoad("/staff/dispatch-batches?"+params);
  return <Panel title={dispatchQueueLabels[state]??"发运队列"}>
    <div className="actions" aria-label="发运状态">
      {Object.entries(dispatchQueueLabels).map(([key,title])=><Link key={key} className="button"
        aria-current={state===key?"page":undefined} href={"/wh/dispatch?"+new URLSearchParams({state:key,...(reference?{reference}:{})})}>{title}</Link>)}
    </div>
    <form action="/wh/dispatch" method="get" className="form inline-form" key={state+reference}>
      <input type="hidden" name="state" value={state}/>
      <label>批次 ID / 实际运单 / 客户码 / 订单号<input name="reference" defaultValue={reference} maxLength={64}/></label>
      <button type="submit" className="button primary">查批次</button>
      {reference&&<Link className="button" href={"/wh/dispatch?"+new URLSearchParams({state})}>清除编号</Link>}
      <button type="button" className="button" onClick={reload}>刷新</button>
    </form>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在查询批次…</p>}
    {data&&!error&&<Table headers={["批次 / 客户与订单","去向与状态","实物进度","关联运单","退货 / 报价截止","操作"]} rows={data.rows.map((batch:Row)=>[
      <div key="b" className="cell-stack">
        <div className="actions">
          <Link className="code" href={"/wh/dispatch/"+batch.id} title={batch.id}>#{String(batch.id).slice(0,8)}</Link>
          {batch.receiving_code&&<small className="code">{batch.receiving_code}</small>}
        </div>
        {(batch.order_numbers?.length??0)>0&&<small className="code">{batch.order_numbers.join(", ")}</small>}
        {onOpenDrawer&&<small><button type="button" className="code-btn" onClick={()=>onOpenDrawer({kind:"batch",ref:batch.id})}>速览清单</button></small>}
      </div>,
      <div key="s" className="cell-stack">
        <strong>{dispatchAction(batch.action)}</strong>
        <div><Tag>{label(batch.state)}</Tag>{batch.has_quarantine&&<Tag tone="red">有隔离实物</Tag>}</div>
      </div>,
      <div key="p" className="cell-stack">
        <span>待发 <strong>{batch.remaining}</strong> · 已装箱 <strong>{batch.packed}</strong></span>
        <small>已交接 {batch.shipped}{batch.returns?` · 退回 ${batch.returns}`:""}</small>
      </div>,
      (batch.waybills?.length)?<div key="w" className="actions">
        {(batch.waybills as string[]).map(wb=>onOpenDrawer
          ?<CodeButton key={wb} code={wb} onClick={()=>onOpenDrawer({kind:"tracking",ref:wb})}/>
          :<span key={wb} className="code">{wb}</span>)}
      </div>:<span key="w" className="muted">—</span>,
      <div key="t" className="cell-stack">
        <span>退货：{stamp(batch.return_deadline)}</span>
        <small>报价：{stamp(batch.expires_at)}</small>
      </div>,
      <Link key="go" className={"button sm"+(canShipWrite?" primary":"")} href={"/wh/dispatch/"+batch.id}>{canShipWrite?"进入作业 →":"只读查看"}</Link>,
    ])} empty="这个状态下暂无符合条件的批次。"/>}
  </Panel>;
}
function PackParcel({batch,parcel,reload}:{batch:Row;parcel:Row;reload:()=>void}) {
  const expected=parcel.item_ids.map((id:string)=>batch.items.find((item:Row)=>item.id===id));
  if(expected.some((item:Row|undefined)=>!item))return <ErrorBlock error="报价内实物已变更，请刷新核对批次。"/>;
  if(expected.some((item:Row)=>item.quarantined))return <p className="notice">本包裹包含待解除隔离的实物，暂不能装箱。</p>;
  return <div className="card">
    <h3>待装箱 · {parcel.item_ids.length} 件 · {parcel.weight_g} 克</h3>
    <ScanAndSubmit items={expected} label="确认装箱" run={async fields=>{
      const photo=await upload(fields.get("photo"),"dispatch");
      await request("/staff/dispatch-batches/"+batch.id+"/parcels","POST",{
        revision:batch.revision,quote_id:batch.quote_id,item_ids:parcel.item_ids,
        weight_g:parcel.weight_g,packed_media_ids:[photo],operation_note:text(fields,"operation_note").trim()||undefined,
      });reload();
    }}><label>装箱备注（选填，仅员工可见）<textarea name="operation_note" maxLength={operationNoteLimit}/></label></ScanAndSubmit>
  </div>;
}
function ScanAndSubmit({items,label,run,children}:{items:Row[];label:string;run:(fields:FormData)=>Promise<void>;children?:ReactNode}) {
  const [scanned,setScanned]=useState<string[]>([]);
  const [scanInput,setScanInput]=useState("");
  const [scanErr,setScanErr]=useState("");
  const scanRef=useRef<HTMLInputElement>(null);
  return <>
    <div className="card">
      <p><strong>逐件核对</strong> · {scanned.length} / {items.length}</p>
      <form className="form inline-form" onSubmit={e=>{
        e.preventDefault();
        setScanErr("");
        const val=scanInput.trim().toUpperCase();
        const item=items.find(i=>i.code.toUpperCase()===val);
        if(!item) { setScanErr("该实物不在本包裹清单，请核对包裹。"); scanRef.current?.select(); return; }
        if(scanned.includes(item.id)) { setScanErr("该实物已核对。"); setScanInput(""); scanRef.current?.focus(); return; }
        setScanned(previous=>[...previous,item.id]);
        setScanInput("");
        scanRef.current?.focus();
      }}>
        <label>扫描或输入实物码<input ref={scanRef} value={scanInput} onChange={e=>setScanInput(e.target.value)} placeholder="扫入实物条码回车确认" required/></label>
        <button type="submit" className="button primary">核对实物</button>
      </form>
      {scanErr&&<p className="bad small" role="alert">{scanErr}</p>}
      <ul>{items.map(item=><li key={item.id}><span className="code">{item.code}</span> · {scanned.includes(item.id)?<Tag tone="green">已核对</Tag>:<Tag tone="gray">待核对</Tag>}</li>)}</ul>
    </div>
    <Form label={label} run={async fields=>{
      if(!items.length||scanned.length!==items.length||!items.every(item=>scanned.includes(item.id)))
        throw new Error("请先逐件扫描核对本包裹实物。");
      await run(fields);
    }}>
      {children}<Photo label={label==="确认装箱"?"装箱照片":"交接照片"}/>
      <label className="check"><input type="checkbox" required/>已完成逐件核对和对应实物操作</label>
    </Form>
  </>;
}
export function WarehouseDispatchBatch({id,actor}:{id:string;actor?:Row}) {
  const {data,error,reload}=useLoad("/staff/dispatch-batches/"+id);
  const carriers=useLoad("/carriers");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const b=data?.batch;
  const canShipWrite=Boolean(!actor?.roles || actor.roles.includes("warehouse_admin"));
  return <>
    <div className="page-head row"><div><Link href="/wh/dispatch">← 出库队列</Link>
      <p className="eyebrow report-eyebrow">WAREHOUSE / DISPATCH BATCH</p><h1>发运批次</h1>
      <p className="code">{id}</p>{b&&<p><Tag>{label(b.state)}</Tag> · {dispatchAction(b.action)}{b.receiving_code?<> · 客户 <span className="code">{b.receiving_code}</span></>:""}{b.order_numbers?.length?<> · 关联订单 <span className="code">{b.order_numbers.join("、")}</span></>:""}</p>}</div>
      <div className="head-actions"><button type="button" className="button sm" onClick={reload}>刷新批次状态</button></div></div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在读取批次…</p>}
    {data&&!error&&<>
      {!canShipWrite&&<div className="notice" style={{marginBottom:12}}><strong>只读监督模式：</strong>称重报价、确认装箱、交接发运与退件入库按 OpenAPI 契约仅限仓库主管（warehouse_admin）执行。</div>}
      <Panel title="客户授权去向与批次清单">
        <p>{b.destination_snapshot.recipient} · {b.destination_snapshot.phone}</p>
        <p>{b.destination_snapshot.address}</p>
        {b.destination_snapshot.member_code&&<p>集运会员码 <span className="code">{b.destination_snapshot.member_code}</span></p>}
        {b.quote_id&&<p>报价版本 {b.quote_revision} · {usd(b.amount_cents)} · 到期 {stamp(b.expires_at)}</p>}
        {(b.items?.length??0)>0&&<Table
          headers={["实物码","品名 / 款号","关联订单","当前库位","装箱状态"]}
          rows={(b.items??[]).map((it:Row)=>[
            <CodeButton key="c" code={it.code} onClick={()=>setDrawer({kind:"item",ref:it.code})}/>,
            [it.product_name,it.sku_code].filter(Boolean).join(" / ")||"—",
            <span key="o" className="code">{it.order_no??"—"}</span>,
            <span key="l" className="code">{it.location_code??"—"}</span>,
            (b.packed_item_ids??[]).includes(it.id)?<Tag key="p" tone="green">已装箱</Tag>:<Tag key="p" tone="yellow">待装箱</Tag>,
          ])}
        />}
      </Panel>
      {canShipWrite&&(b.state==="confirmed"||b.renewable_quote)&&<Panel title="称重与逐包报价">
        {b.renewable_quote&&<p className="notice">旧报价已过期，且无待核对的付款。请按实际包裹重新报价。</p>}
        <DispatchQuoteForm key={b.revision} batch={b} rates={data.rates} reload={reload}/>
      </Panel>}
      {b.state==="quoted"&&!b.renewable_quote&&<p className="notice">等待客户接受报价或渠道确认付款。</p>}
      {canShipWrite&&b.state==="paid"&&<Panel title="待装箱包裹">
        {b.snapshot.parcels.filter((p:Row)=>p.item_ids.every((itemId:string)=>!b.packed_item_ids.includes(itemId))).map((p:Row)=>
          <PackParcel key={b.quote_id+"-"+p.item_ids.join("-")} batch={b} parcel={p} reload={reload}/>)}
      </Panel>}
      <Panel title="包裹交接与退回">
        {!data.shipments.length&&<Empty>尚未生成已装箱包裹。</Empty>}
        {data.shipments.map((s:Row)=><div className="card" key={s.id}>
          <h3>{label(s.state)} · {s.weight_g} 克 · {s.items.length} 件</h3><p className="code">包裹单 #{String(s.id).slice(0,8)}</p>
          <Table headers={["实物码","退回实收"]} rows={s.items.map((i:Row)=>[
            <CodeButton code={i.code} onClick={()=>setDrawer({kind:"item",ref:i.code})}/>,
            i.received_at?stamp(i.received_at):"—",
          ])}/>
          {s.state==="packed"&&s.items.some((item:Row)=>item.quarantined)&&<p className="notice">本包裹包含待解除隔离的实物，暂不能交给快递。</p>}
          {canShipWrite&&s.state==="packed"&&!s.items.some((item:Row)=>item.quarantined)&&<ScanAndSubmit key={s.revision} items={s.items} label="确认已交给快递" run={async fields=>{
            const photo=await upload(fields.get("photo"),"dispatch");
            await request("/staff/shipments/"+s.id+"/handover","POST",{
              revision:s.revision,item_ids:s.items.map((i:Row)=>i.id),carrier_code:text(fields,"carrier"),
              tracking_no:text(fields,"tracking"),evidence_ids:[photo],handed_at:new Date().toISOString(),
              operation_note:text(fields,"operation_note").trim()||undefined,
            });reload();
          }}>
            {carriers.error&&<ErrorBlock error={carriers.error}/>}
            <Select name="carrier" label="实际承运商" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}))}/>
            <Field name="tracking" label="实际寄出运单号"/>
            <label>出库交接备注（选填，仅员工可见）<textarea name="operation_note" maxLength={operationNoteLimit}/></label>
          </ScanAndSubmit>}
          {s.operation_notes?.length>0&&<OperationNoteList notes={s.operation_notes}/>}
          {s.shipped_at&&<p>实际交接 {stamp(s.shipped_at)} · {s.carrier_code} {s.tracking_norm?<CodeButton code={s.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:s.tracking_norm})}/>:"—"}</p>}
          {s.shipped_at&&<details><summary>查看中文物流轨迹 · {label(s.transport_state??"unknown")}</summary>
            <p>同步状态 {label(s.sync_state??"unknown")} · 更新 {stamp(s.tracking_updated_at)}</p>
            <ol className="timeline">{(s.tracking_events??[]).map((event:Row)=><li key={event.id}>{stamp(event.occurred_at)} · {event.text}</li>)}</ol>
            {!s.tracking_events?.length&&<Empty>尚无中文轨迹。</Empty>}
          </details>}
          {canShipWrite&&["shipped","delivered"].includes(s.state)&&s.items.some((i:Row)=>!i.received_at)&&<details>
            <summary>登记实际退回</summary><Form label="确认退回入库" run={async fields=>{
              const itemIds=fields.getAll("returned").map(String);
              if(!itemIds.length)throw new Error("选择本次实际收到的物件。");
              const photo=await upload(fields.get("photo"),"dispatch");
              await request("/staff/shipments/"+s.id+"/receive-return","POST",{
                revision:s.revision,item_ids:itemIds,location_id:text(fields,"location"),evidence_ids:[photo],received_at:new Date().toISOString(),
              });reload();
            }}>
              {s.items.filter((i:Row)=>!i.received_at).map((i:Row)=><label className="check code" key={i.id}>
                <input type="checkbox" name="returned" value={i.id}/>{i.code}
              </label>)}
              <Select name="location" label="库位" choices={options(data.locations)}/><Photo label="退回实物照片"/>
            </Form>
          </details>}
          {s.evidence_ids?.length>0&&<div className="actions" style={{marginTop:8}}>
            <MediaButton ids={s.evidence_ids} label={`查看装箱/交接照片 (${s.evidence_ids.length})`}/>
          </div>}
        </div>)}
      </Panel>
    </>}
    <StaffObjectDrawer target={drawer} actor={actor} onClose={()=>setDrawer(null)}/>
  </>;
}
function DispatchQuoteForm({batch,rates,reload}:{batch:Row;rates:Row[];reload:()=>void}) {
  const [count,setCount]=useState(1);
  const [manualMode,setManualMode]=useState(false);
  const items:Row[]=batch.items??[];
  const maxParcels=Math.min(50,items.length);
  const parcelNumbers=Array.from({length:count},(_,i)=>i+1);
  if(!rates.length) return <Empty>没有生效的运价版本，暂不可报价。</Empty>;
  if(!items.length) return <Empty>该批次没有待发运实物。</Empty>;
  return <Form label={manualMode?"提交人工核定运费报价":"提交称重并自动生成报价"} run={async fields=>{
    const reason=text(fields,"manual_reason");
    const parcels=parcelNumbers.map(number=>{
      const manualUsd=text(fields,"manual-usd-"+number);
      return {
        item_ids:items.filter(item=>Number(fields.get("parcel-"+item.id)||1)===number).map(item=>item.id),
        weight_g:Number(fields.get("weight-"+number)),
        ...(manualMode && manualUsd!==""?{manual_amount_cents:Math.round(Number(manualUsd)*100),...(reason?{manual_reason:reason}:{})}:{}),
      };
    });
    if(parcels.some(p=>!p.item_ids.length||!Number.isInteger(p.weight_g)||p.weight_g<1))
      throw new Error("每个包裹至少包含一件指定实物，并填写实际克数。");
    if(manualMode) {
      await request("/staff/dispatch-batches/"+batch.id+"/manual-quote","POST",{
        revision:batch.revision,rate_version_id:text(fields,"rate"),manual_reason:reason||undefined,parcels,
      });
    } else {
      await request("/staff/dispatch-batches/"+batch.id+"/quote","POST",{revision:batch.revision,rate_version_id:text(fields,"rate"),parcels});
    }
    reload();
  }}>
    <div className="fields">
      <Select label="运价版本" name="rate" value={rates[0]?.id} choices={rates.map(rate=>({id:rate.id,label:"版本 "+rate.version}))}/>
      <label>计费模式
        <select value={manualMode?"manual":"standard"} onChange={e=>setManualMode(e.target.value==="manual")}>
          <option value="standard">按运价表自动计重计费</option>
          <option value="manual">超规体积 / 偏远地区人工核定运费</option>
        </select>
      </label>
    </div>
    {maxParcels>1&&<label>实际包裹数<select value={count} onChange={e=>setCount(Number(e.target.value))}>
      {Array.from({length:maxParcels},(_,i)=><option key={i+1}>{i+1}</option>)}
    </select></label>}
    {count>1&&<div className="dispatch-assignment" key={count}>{items.map(item=><Select key={item.id} name={"parcel-"+item.id} value="1"
      label={"实物 "+item.code+" 所在包裹"} choices={parcelNumbers.map(number=>({id:String(number),label:"包裹 "+number}))}/>)}</div>}
    <div className="dispatch-assignment">{parcelNumbers.map(number=><div key={number} className="fields">
      <Field label={"包裹 "+number+" 实重（克）"} name={"weight-"+number} type="number" min={1}/>
      {manualMode&&<Field label={"包裹 "+number+" 核定运费 (USD)"} name={"manual-usd-"+number} type="number" min={0} step="0.01"/>}
    </div>)}</div>
    {manualMode&&<Field label="人工核价原因（必填，客户与审计可见）" name="manual_reason"/>}
  </Form>;
}
function readFileAsDataUrl(file:File):Promise<string> {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result??""));
    reader.onerror=()=>reject(new Error("读取离线照片失败。"));
    reader.readAsDataURL(file);
  });
}
function dataUrlToFile(dataUrl:string,name:string,type:string):File {
  const parts=dataUrl.split(",");
  const bstr=atob(parts[1]??"");
  const bytes=new Uint8Array(bstr.length);
  for(let i=0;i<bstr.length;i++) bytes[i]=bstr.charCodeAt(i);
  return new File([bytes],name||"offline-shot.jpg",{type:type||"image/jpeg"});
}
export function TaskView({id,actor}:{id:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/inspection-tasks/"+id);
  const draftKey="qcw_task_draft_"+actor.id+"_"+id;
  const [drafts,setDrafts]=useState<Row[]>([]);
  const [conflict,setConflict]=useState<{localRevision:number;serverRevision:number;message:string}|null>(null);
  const [online,setOnline]=useState(true);
  const [checkFilter,setCheckFilter]=useState<"all"|"pending"|"issue"|"done">("all");
  const [expandedKeys,setExpandedKeys]=useState<Record<string,boolean>>({});
  const [dirtyRows,setDirtyRows]=useState<Record<string,boolean>>({});
  const [annotationsByKey,setAnnotationsByKey]=useState<Record<string,DefectAnnotation[]>>({});
  const [liveNumeric,setLiveNumeric]=useState<Record<string,string>>({});
  const attemptKeysRef=useRef<Record<string,string>>({});
  const syncKeyRef=useRef<string>("");
  const inputRefs=useRef<Record<string,HTMLInputElement|HTMLSelectElement|null>>({});
  const focusNextKeyRef=useRef<string|null>(null);
  useEffect(()=>{
    try {
      const saved=localStorage.getItem(draftKey);
      if(saved) setDrafts(JSON.parse(saved));
    } catch {}
    setOnline(navigator.onLine);
    const onOnline=()=>setOnline(true),onOffline=()=>setOnline(false);
    window.addEventListener("online",onOnline);
    window.addEventListener("offline",onOffline);
    return ()=>{window.removeEventListener("online",onOnline);window.removeEventListener("offline",onOffline);};
  },[draftKey]);
  const hasDirty=Object.values(dirtyRows).some(Boolean)||drafts.length>0;
  useEffect(()=>{
    if(!hasDirty) return;
    const onBeforeUnload=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};
    window.addEventListener("beforeunload",onBeforeUnload);
    return ()=>window.removeEventListener("beforeunload",onBeforeUnload);
  },[hasDirty]);
  useEffect(()=>{
    if(focusNextKeyRef.current) {
      const target=inputRefs.current[focusNextKeyRef.current];
      focusNextKeyRef.current=null;
      target?.focus();
    }
  });
  function saveLocalDrafts(next:Row[]) {
    setDrafts(next);
    syncKeyRef.current=crypto.randomUUID();
    try {
      if(next.length) localStorage.setItem(draftKey,JSON.stringify(next));
      else localStorage.removeItem(draftKey);
    } catch {}
  }
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载检查项…</p>;
  const canExecute=actor.roles.includes("inspector");
  const canAdminOrder=actor.roles.some((r:string)=>["support","super_admin"].includes(r));
  const claimedByOther=Boolean(data.state==="IN_PROGRESS"&&data.assignee_id&&data.assignee_id!==actor.id);
  const writable=canExecute&&data.state==="IN_PROGRESS"&&data.assignee_id===actor.id;
  const completeness=data.completeness??{ok:true,missing:[]};
  const tolerances:Row[]=Array.isArray(data.tolerances)?data.tolerances:[];
  const minRequiredAttempts=(c:Row)=>c.type==="number"&&Number(data.content.measurement_policy?.attempts??0)>=2?2:1;
  const allChecks=data.components.flatMap((m:Row)=>
    data.content.checks.filter((c:Row)=>Boolean(data.group_id)||!c.component||c.component===m.id).map((c:Row)=>{
      const rowKey=`${m.id}:${c.key}`;
      const attempts=data.results.filter((r:Row)=>r.item_key===c.key&&r.component===m.id);
      const prev=attempts.find((r:Row)=>r.is_final)??attempts.at(-1);
      const retryNeeded=attempts.some((r:Row)=>r.details?.retry_required) && attempts.length<3;
      const recordedNumAttempts=attempts.filter((r:Row)=>r.status==="RECORDED"&&typeof r.typed_value==="number").length;
      const needsMoreAttempts=Boolean(c.type==="number"&&minRequiredAttempts(c)>=2&&prev?.status==="RECORDED"&&recordedNumAttempts<2);
      const needsEvidence=Boolean(c.evidence&&prev&&["RECORDED","OBSERVED_ISSUE"].includes(prev.status)&&!attempts.some((a:Row)=>(a.evidence_ids?.length??0)>0));
      const isIssue=Boolean(retryNeeded || prev?.details?.uncertain || (prev && ["OBSERVED_ISSUE","BLOCKED"].includes(prev.status)));
      const isDone=Boolean(prev && !retryNeeded && !needsMoreAttempts && !needsEvidence && !prev?.details?.uncertain);
      return {m,c,rowKey,attempts,prev,retryNeeded,needsMoreAttempts,needsEvidence,isIssue,isDone};
    })
  );
  const doneCount=allChecks.filter((x:Row)=>x.isDone).length;
  const issueCount=allChecks.filter((x:Row)=>x.isIssue).length;
  const pendingCount=allChecks.length-doneCount;
  const uploadDrafts=async()=>{
    const resolvedDrafts:Row[]=[];
    for(const d of drafts) {
      const copy={...d};
      if(copy.offline_photo?.dataUrl && (!copy.evidence_ids||!copy.evidence_ids.length)) {
        const f=dataUrlToFile(copy.offline_photo.dataUrl,copy.offline_photo.name,copy.offline_photo.mime);
        const mediaId=await upload(f,"shot");
        copy.evidence_ids=[mediaId];
      }
      delete copy.offline_photo;
      resolvedDrafts.push(copy);
    }
    return resolvedDrafts;
  };
  const syncAllDrafts=async()=>{
    if(!syncKeyRef.current) syncKeyRef.current=crypto.randomUUID();
    const resolvedDrafts=await uploadDrafts();
    try {
      await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:resolvedDrafts},syncKeyRef.current);
      saveLocalDrafts([]);setDirtyRows({});reload();
    } catch(e) {
      if(e instanceof RequestError && e.code==="VERSION_CONFLICT") {
        const fresh=await request("/staff/inspection-tasks/"+id);
        setConflict({localRevision:data.revision,serverRevision:fresh.revision,message:e.message});
        return;
      }
      throw e;
    }
  };
  const df:Row=data.declared_fields??{};
  const refComponents=(data.components??[]).filter((m:Row)=>m.is_reference);
  const safeProductUrl=typeof data.product_url==="string"&&/^https?:\/\//i.test(data.product_url)?data.product_url:(typeof df.product_url==="string"&&/^https?:\/\//i.test(df.product_url)?df.product_url:null);
  const purchaseEvidences:Row[]=Array.isArray(data.purchase_evidences)?data.purchase_evidences:[];
  const refAttachments:Row[]=Array.isArray(data.reference_attachments)?data.reference_attachments:(Array.isArray(data.attachment_ids)?data.attachment_ids.map((mid:string)=>({id:mid,purpose:"reference_photo",name:null})):[]);
  const numericChecks=(data.content.checks??[]).filter((c:Row)=>c.type==="number");
  const requiredShots:Row[]=data.content.shots??[];
  const uploadedAngleSet=new Set((data.shots??[]).map((s:Row)=>`${s.component??"main"}:${s.shot_code}`));
  return <>
    {/* Layer 1: Top Task Context Bar */}
    <div className="page-head row">
      <div>
        <div className="actions" style={{marginBottom:4}}>
          <h1 className="code" style={{fontSize:"1.35rem",margin:0}}>{data.public_no}</h1>
          <Tag tone={data.state==="IN_PROGRESS"?"blue":data.state==="SUBMITTED"?"yellow":data.state==="QA_APPROVED"?"green":"outline"}>{label(data.state)}</Tag>
          {tolerances.length>0?<Tag tone="blue">客户公差模式 ({tolerances.length} 项)</Tag>:<Tag tone="gray">仅客观记录实测值</Tag>}
        </div>
        <p className="muted small" style={{margin:0}}>
          实物 <span className="code">{data.item_code??"对比组"}</span>
          {data.package_code&&<> · 包裹 <span className="code">{data.package_code}</span></>}
          {data.location_code&&<> · 库位 <span className="code">{data.location_code}</span></>}
          {data.receiving_code&&<> · 客户 <span className="code">{data.receiving_code}</span></>}
          {" · "}{data.service_title?.["zh-CN"]??data.service_title?.en??"标准检查"}
          {data.template_key&&<> · 模板 <span className="code">{data.template_key} v{data.template_version??1}</span></>}
          {" · 执行人："}<strong>{data.assignee_name??"待领取"}</strong>
          {" · SLA "}{stamp(data.sla_due_at)}
        </p>
      </div>
      <div className="head-actions">
        <Tag>{online?"网络在线":"离线草稿模式"}</Tag>
        {drafts.length>0&&<Tag tone="yellow">本地草稿 {drafts.length} 项</Tag>}
        {canAdminOrder&&<Link className="button sm" href={"/admin/orders/"+encodeURIComponent(data.public_no)}>查看订单工作台</Link>}
        <Link className="button sm" href="/wh/inspection">返回检查队列</Link>
      </div>
    </div>
    {!canExecute&&<div className="notice" style={{marginBottom:12}}><strong>只读监督视图：</strong>按 OpenAPI 职责边界，检验领取、实测录入、机位拍照与提交仅限现场质检员（inspector）执行。</div>}
    {canExecute&&claimedByOther&&<div className="notice" style={{marginBottom:12}}><strong>并发领取锁生效（只读）：</strong>本任务已由质检员 <strong>{data.assignee_name??data.assignee_id?.slice(0,8)}</strong> 领取执行中，当前账号不可覆盖录入。</div>}
    {canExecute&&data.state==="SUBMITTED"&&<div className="notice" style={{marginBottom:12}}><strong>已提交等待 QA 复核：</strong>检验任务已锁定不可编辑，可查看全部录入记录与证据。</div>}
    {data.review_feedback&&<div className="notice" style={{marginBottom:12,borderLeft:"4px solid #dc2626"}}><strong>QA 复核退回补正意见：</strong>{data.review_feedback}</div>}

    {/* Layer 2: Unified Compact Requirements, Customer Notes, Reference Attachments & Tolerances */}
    <Panel title="委托要求、申报资料与参考依据" subtitle="紧凑展示商品申报、客户备注、参考附图/尺寸表与公差基准，无空白占位。">
      <div className="task-ctx-grid">
        <div className="task-ctx-cell"><small>品名 / 款号 SKU</small><strong>{df.name||"—"} {df.sku_code||df.sample_code?<span className="code">({df.sku_code??df.sample_code})</span>:null}</strong></div>
        <div className="task-ctx-cell"><small>申报颜色 / 尺码</small><strong>{[df.color_declared||df.color,df.size_label||df.size].filter(Boolean).join(" / ")||"—"}</strong></div>
        <div className="task-ctx-cell"><small>供应商 / 商品来源</small><strong>{df.supplier_alias||"—"}{safeProductUrl&&<> · <a href={safeProductUrl} target="_blank" rel="noreferrer noopener">参考链接 ↗</a></>}</strong></div>
        <div className="task-ctx-cell"><small>品类与检查要求</small><strong>{data.category_labels?.["zh-CN"]??"—"} · {data.service_title?.["zh-CN"]??"标准检查"}</strong></div>
      </div>
      {(data.customer_notes||df.notes)&&<div className="task-notes-banner">
        {data.customer_notes&&<div><strong>客户整单特别要求：</strong>{data.customer_notes}</div>}
        {df.notes&&<div style={{marginTop:data.customer_notes?4:0}}><strong>本品申报备注：</strong>{df.notes}</div>}
      </div>}
      {data.group_id&&data.components.filter((item:Row)=>!item.is_reference&&item.declared_fields?.notes).map((item:Row)=><p className="line-note" key={item.id}>
        <strong>{item.code} 样品备注：</strong>{item.declared_fields.notes}
      </p>)}
      {(refAttachments.length>0||purchaseEvidences.length>0)&&<div className="task-ref-strip">
        {refAttachments.map((att:Row,idx:number)=><div className="task-ref-card" key={att.id??idx}>
          <div className="row"><Tag tone={att.purpose==="size_chart"?"blue":"outline"}>{att.purpose==="size_chart"?"尺寸表":"参考照片"}</Tag><small className="muted">#{idx+1}</small></div>
          <img src={`/api/v1/media/${att.id}/thumb`} alt={att.name||"客户参考附图"} style={{width:"100%",height:92,objectFit:"cover",borderRadius:6,background:"#f1f5f9"}}/>
          <MediaButton ids={[att.id]} labels={[`${att.purpose==="size_chart"?"尺寸表":"参考照片"}${att.name?` · ${att.name}`:""}`]} label={att.name||"点击放大查看"}/>
        </div>)}
        {purchaseEvidences.filter(pe=>pe.media_id).map((pe:Row,idx:number)=><div className="task-ref-card" key={`pe-${idx}`}>
          <div className="row"><Tag tone="outline">采购凭证图</Tag><small className="muted">#{idx+1}</small></div>
          <img src={`/api/v1/media/${pe.media_id}/thumb`} alt={`采购凭证 #${idx+1}`} style={{width:"100%",height:92,objectFit:"cover",borderRadius:6,background:"#f1f5f9"}}/>
          <MediaButton ids={[pe.media_id]} label={`放大采购图 #${idx+1}`}/>
        </div>)}
        {purchaseEvidences.filter(pe=>typeof pe.url==="string"&&/^https?:\/\//i.test(pe.url)).map((pe,idx)=><div className="task-ref-card" key={`pel-${idx}`}>
          <Tag tone="outline">采购商品链接</Tag>
          <a className="button sm" href={pe.url} target="_blank" rel="noreferrer noopener">打开外部链接 #{idx+1} ↗</a>
        </div>)}
      </div>}
      <div style={{marginTop:12}}>
        {tolerances.length>0?<>
          <strong className="small">客户设定目标尺寸与公差范围 ({tolerances.length} 项 — 系统按此范围实时提示公差内/超公差)</strong>
          <Table
            headers={["测量项","目标值","允许上下限","单位"]}
            rows={tolerances.map((t:Row)=>{
              const matchedCheck=(data.content.checks??[]).find((ck:Row)=>ck.key===t.point_code);
              return [
                matchedCheck?(matchedCheck.zh??matchedCheck.label):<span className="code">{t.point_code}</span>,
                <strong key="tg" className="code">{t.target??"—"}</strong>,
                <span key="rg" className="code">{t.min??"—"} ~ {t.max??"—"}</span>,
                t.unit??matchedCheck?.unit??"—",
              ];
            })}
          />
        </>:<div className="notice" style={{margin:0}}>
          <strong>客观记录模式（Record actual measurements only）：</strong>客户未设置公差上下限，仅需忠实记录实测值，系统不产生合格/不合格误判（双次测量差值 &gt; 0.5 cm 仍触发第 3 次复测）。
        </div>}
      </div>
    </Panel>

    <OperationNotes notes={data.operation_notes??[]} reload={reload} writePath={data.state!=="VOID"&&
      (data.assignee_id===actor.id||actor.roles.some((r:string)=>["reviewer","warehouse_admin","super_admin"].includes(r)))
      ?`/staff/inspection-tasks/${id}/operation-notes`:undefined}/>

    {refComponents.length>0&&<Panel title="确认样对比基准 (Golden Sample Baseline)" subtitle="将待检样品与以下封存确认样进行实测尺寸与外观横向对照。">
      <div className="actions" style={{flexWrap:"wrap"}}>
        {refComponents.map((rc:Row)=><div className="card" key={rc.id}>
          <strong className="code">{rc.code}</strong> · 确认样专柜 <span className="code">{rc.location_code??"—"}</span> · 铅封 <span className="code">{rc.seal_code??"—"}</span>
          {rc.declared_fields?.name&&<div className="small muted">{rc.declared_fields.name} {rc.declared_fields.color_declared??""} {rc.declared_fields.size_label??""}</div>}
        </div>)}
      </div>
    </Panel>}
    {data.group_id&&data.components.length>=2&&numericChecks.length>0&&<Panel title="多件 / 确认样横向对比实测矩阵" subtitle="实时汇总各对照件最终数值并计算最大极差（Max - Min）。">
      <Table
        headers={["测量检查项","客户目标/公差",...data.components.map((m:Row)=>m.is_reference?`${m.code} (确认样)`:m.code),"实测极差"]}
        rows={numericChecks.map((nc:Row)=>{
          const tol=tolerances.find(t=>t.point_code===nc.key);
          const vals=data.components.map((m:Row)=>{
            const atts=data.results.filter((r:Row)=>r.component===m.id&&r.item_key===nc.key);
            const fin=atts.find((r:Row)=>r.is_final)??atts.at(-1);
            return fin?.status==="RECORDED"&&typeof fin?.typed_value==="number"?Number(fin.typed_value):null;
          });
          const validNums=vals.filter((v:number|null):v is number=>v!==null);
          const diff=validNums.length>=2?Math.round((Math.max(...validNums)-Math.min(...validNums))*1000)/1000:null;
          return [
            <span key="l">{nc.zh??nc.label}</span>,
            tol?<span key="t" className="code">{tol.target??"—"} [{tol.min??"—"}~{tol.max??"—"}]</span>:<span key="t" className="muted">—</span>,
            ...vals.map((v:number|null,idx:number)=><span key={idx} className="code">{v!==null?`${v}${nc.unit?" "+nc.unit:""}`:"待测"}</span>),
            <strong key="d" className="code">{diff!==null?`${diff}${nc.unit?" "+nc.unit:""}`:"—"}</strong>,
          ];
        })}
      />
    </Panel>}
    {conflict&&<Panel title="断网重连与版本冲突处理">
      <p className="notice">检测到服务端版本已更新（本机基线 v{conflict.localRevision} vs 服务端 v{conflict.serverRevision}）：{conflict.message}</p>
      <div className="actions">
        <Action primary run={async()=>{
          const fresh=await request("/staff/inspection-tasks/"+id);
          const resolved=await uploadDrafts();
          await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:fresh.revision,results:resolved});
          saveLocalDrafts([]);setDirtyRows({});setConflict(null);reload();
        }}>拉取最新基线并上传照片合并草稿（{drafts.length} 项）</Action>
        <Action run={async()=>{saveLocalDrafts([]);setConflict(null);reload();}}>放弃本机草稿并采用服务端版本</Action>
      </div>
    </Panel>}
    {drafts.length>0&&!conflict&&writable&&<Panel title="本机离线草稿与待同步队列">
      <p className="muted small">已暂存 {drafts.length} 条检查项结果在本机浏览器（归属当前账号 {actor.id.slice(0,8)}），恢复在线后可幂等批量上传照片并写入服务端。</p>
      <div className="actions">
        <Action primary run={syncAllDrafts}>立即同步全部本机草稿</Action>
        <Action run={async()=>saveLocalDrafts([])}>清空本机草稿</Action>
      </div>
    </Panel>}
    {(data.sibling_tasks?.length??0)>1&&<Panel title="同单逐件任务切换与扫码跳转">
      <Form inline label="扫码切换样品" run={async f=>{
        const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"item_scan"),order_id:data.order_id}));
        location.assign("/wh/task/"+hit.task_id);
      }}><Field name="item_scan" label="扫描同单样品码 S39204"/></Form>
      <div className="actions" style={{flexWrap:"wrap",marginTop:8}}>
        {data.sibling_tasks.map((st:Row)=><Link key={st.id} className={st.id===id?"button primary sm":"button sm"} href={"/wh/task/"+st.id}>
          {st.item_code??("位置 #"+(st.position??""))}{st.declared_fields?.size_label?` (${st.declared_fields.size_label})`:""} · {label(st.state)}
        </Link>)}
      </div>
    </Panel>}
    {data.state==="READY"&&canExecute&&<div className="actions" style={{marginBottom:12}}>
      <Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/start","POST",{revision:data.revision});reload();}}>领取并开始执行质检</Action>
    </div>}

    {/* Layer 3: Primary Inspection Execution Area */}
    <Panel title="检查进度、必拍机位与快速筛选">
      <div className="row">
        <div>
          <strong>已完成 {doneCount} / {allChecks.length} 项检查</strong>
          <span className="muted"> · 必拍机位 {uploadedAngleSet.size} / {requiredShots.length} 张 · 剩余待补齐 {completeness.missing.length} 项 · 回车可快速保存数值并跳下一项</span>
        </div>
        <div className="actions">
          {([
            ["all",`全部 (${allChecks.length})`],
            ["pending",`待录入 (${pendingCount})`],
            ["issue",`异常/复测 (${issueCount})`],
            ["done",`已完成 (${doneCount})`],
          ] as const).map(([key,txt])=><button
            key={key}
            type="button"
            className={"button sm"+(checkFilter===key?" primary":"")}
            onClick={()=>setCheckFilter(key)}
          >{txt}</button>)}
        </div>
      </div>
    </Panel>
    {writable&&<Panel title="分步作业计时">
      <div className="actions">
        {([["prep","准备"],["measure","测量"],["visual","外观检查"],["compare","对比核对"]] as const).map(([code,name])=><Action key={code} run={async()=>{
          await request("/staff/inspection-tasks/"+id+"/steps","POST",{step_code:code,action:"record",seconds:60});reload();
        }}>记录 {name} 工时</Action>)}
      </div>
      {(data.step_timings?.length??0)>0&&<p className="muted small">已记录步骤：{data.step_timings.map((s:Row)=>`${s.step_code}(${s.seconds??0}s)`).join("、")}</p>}
    </Panel>}
    {data.content.measure_conditions&&<div className="notice"><strong>测量与拍摄条件</strong><p>{data.content.measure_conditions}</p></div>}
    {data.content.diagram&&<details className="panel" id="task-diagram">
      <summary style={{cursor:"pointer",fontWeight:700}}>查看标准测量部位与机位示意图</summary>
      <div className="row" style={{alignItems:"center",gap:16,flexWrap:"wrap",marginTop:10}}>
        <img src={data.content.diagram} alt="标准测量部位示意图" style={{maxWidth:360,border:"1px solid #cbd5e1",borderRadius:8,background:"#fff"}}/>
        <div className="small muted">
          <p><strong>示意图操作规范：</strong></p>
          <ul>
            <li>严格按红色标注线所示起止点自然平铺无拉伸测量。</li>
            <li>每个数值尺寸项需连续测量 2 次（差值 ≤0.5cm 默认采用第 1 次实测值；超差触发第 3 次复测，系统按最接近两值的较早值，等距取中位数作为最终值）。</li>
            <li>发现瑕疵部位请选择对应部位编码，并在照片上进行非破坏性框选标注（保留原图不覆写）。</li>
          </ul>
        </div>
      </div>
    </details>}
    {data.components.map((m:Row)=><Panel key={m.id} title={`检验项与实测录入 · ${m.id==="main"?(data.item_code??"实物"):m.code}`}>
      {data.content.checks.filter((c:Row)=>Boolean(data.group_id)||!c.component||c.component===m.id).map((c:Row,idxInComp:number,compChecks:Row[])=>{
        const rowKey=`${m.id}:${c.key}`;
        const nextPending=compChecks.slice(idxInComp+1).find((nc:Row)=>{
          const atts=data.results.filter((r:Row)=>r.item_key===nc.key&&r.component===m.id);
          return !atts.length;
        });
        const nextFocusKey=nextPending?`${m.id}:${nextPending.key}`:null;
        const attempts=data.results.filter((r:Row)=>r.item_key===c.key&&r.component===m.id);
        const prev=attempts.find((r:Row)=>r.is_final)??attempts.at(-1);
        const retryNeeded=attempts.some((r:Row)=>r.details?.retry_required) && attempts.length<3;
        const recordedNumAttempts=attempts.filter((r:Row)=>r.status==="RECORDED"&&typeof r.typed_value==="number").length;
        const needsMoreAttempts=Boolean(c.type==="number"&&minRequiredAttempts(c)>=2&&prev?.status==="RECORDED"&&recordedNumAttempts<2);
        const needsEvidence=Boolean(c.evidence&&prev&&["RECORDED","OBSERVED_ISSUE"].includes(prev.status)&&!attempts.some((a:Row)=>(a.evidence_ids?.length??0)>0));
        const isIssue=Boolean(retryNeeded || prev?.details?.uncertain || (prev && ["OBSERVED_ISSUE","BLOCKED"].includes(prev.status)));
        const isDone=Boolean(prev && !retryNeeded && !needsMoreAttempts && !needsEvidence && !prev?.details?.uncertain);
        const currentAnnotations:DefectAnnotation[]=annotationsByKey[rowKey]??(Array.isArray(prev?.details?.annotations)?prev.details.annotations:[]);
        const tol=tolerances.find((t:Row)=>t.point_code===c.key);
        if(checkFilter==="pending" && isDone) return null;
        if(checkFilter==="done" && !isDone) return null;
        if(checkFilter==="issue" && !isIssue) return null;
        const collapsed=isDone && !expandedKeys[rowKey];
        if(collapsed) {
          return <div className="check-compact-row" key={c.key} id={`comp-${m.id}-${c.key}`}>
            <div>
              <strong>{c.zh} · {c.label}</strong>{" "}
              <Tag tone={isIssue?"yellow":"green"}>{prev.status}</Tag>{" "}
              <span className="code">{prev.typed_value!=null?`${prev.typed_value}${prev.unit?" "+prev.unit:""}`:(prev.reason??"已记录")}</span>
              {currentAnnotations.length>0&&<> <Tag tone="red">标注 {currentAnnotations.length} 处</Tag></>}
            </div>
            <div className="actions">
              {prev.evidence_ids?.length>0&&<MediaButton ids={prev.evidence_ids} annotations={currentAnnotations} label={`证据照 (${prev.evidence_ids.length})`}/>}
              {writable&&<button type="button" className="button sm" onClick={()=>setExpandedKeys(s=>({...s,[rowKey]:true}))}>展开修改 / 复测</button>}
            </div>
          </div>;
        }
        const templateParts:Array<string|{code?:string;label?:string}>=Array.isArray(data.content.parts)?data.content.parts:[];
        const partLabelMap=new Map<string,string>(templateParts.map(p=>typeof p==="string"?[p,p]:[String(p.code??p.label??""),String(p.label??p.code??"")]));
        const rawParts:Array<string|{code?:string;label?:string}>=c.parts?.length?c.parts:templateParts;
        const availParts:string[]=rawParts.map(p=>typeof p==="string"?p:String(p.code??p.label??"")).filter(Boolean);
        const availPartChoices=availParts.map(p=>({id:p,label:partLabelMap.get(p)??p}));
        const nextAttemptNum=(attempts.at(-1)?.attempt??0)+1;
        const typedNumStr=liveNumeric[rowKey]??"";
        const parsedLiveNum=typedNumStr!==""&&Number.isFinite(Number(typedNumStr))?Number(typedNumStr):null;
        const liveOutOfRange=tol&&parsedLiveNum!==null&&((typeof tol.min==="number"&&parsedLiveNum<tol.min)||(typeof tol.max==="number"&&parsedLiveNum>tol.max));
        const liveDev=tol&&typeof tol.target==="number"&&parsedLiveNum!==null?Math.round((parsedLiveNum-tol.target)*1000)/1000:null;
        const attempt1Val=attempts[0]?.status==="RECORDED"&&typeof attempts[0]?.typed_value==="number"?Number(attempts[0].typed_value):null;
        const liveAttemptDelta=attempt1Val!==null&&nextAttemptNum>=2&&parsedLiveNum!==null?Math.round(Math.abs(parsedLiveNum-attempt1Val)*1000)/1000:null;
        const numDefaultVal=c.type==="number"&&attempts.length>0?"":(prev?.typed_value??"");
        return <div className="card" key={c.key} id={`comp-${m.id}-${c.key}`}>
          <div className="row">
            <div>
              <h3 style={{margin:0}}>{c.zh} · {c.label}</h3>
              <p className="muted small" style={{margin:"4px 0 0"}}>
                {c.method}{c.unit?" · 单位 "+c.unit:""}
                {c.diagram&&!c.diagram.startsWith("/")&&<> · <a href="#task-diagram">参考示意图</a></>}
              </p>
            </div>
            <div className="actions">
              {writable && c.type!=="number" && !c.evidence && !prev && <Action sm run={async()=>{
                const payload={item_key:c.key,component:m.id,attempt:1,status:"NOT_OBSERVED",is_final:true,method:c.method};
                if(!online) { saveLocalDrafts([...drafts,payload]); return; }
                const key=attemptKeysRef.current[rowKey+":quick"]??=crypto.randomUUID();
                await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:[payload]},key);
                delete attemptKeysRef.current[rowKey+":quick"];
                if(nextFocusKey) focusNextKeyRef.current=nextFocusKey;
                reload();
              }}>快速记为未见异常</Action>}
              {isDone&&<button type="button" className="button sm" onClick={()=>setExpandedKeys(s=>({...s,[rowKey]:false}))}>收起</button>}
            </div>
          </div>
          {c.diagram&&c.diagram.startsWith("/")&&<div style={{margin:"8px 0"}}><img src={c.diagram} alt={`${c.zh??c.label} 示意图`} style={{maxWidth:240,border:"1px solid #cbd5e1",borderRadius:6,background:"#fff"}}/></div>}
          {(tol||liveAttemptDelta!==null)&&<div className="actions" style={{margin:"6px 0",flexWrap:"wrap"}}>
            {tol?<Tag tone="blue">客户目标 {tol.target??"—"} {tol.unit??c.unit??""} · 公差 [{tol.min??"—"} ~ {tol.max??"—"}]</Tag>:<Tag tone="gray">仅记录实测值</Tag>}
            {liveDev!==null&&<Tag tone={liveOutOfRange?"red":"green"}>{liveOutOfRange?"超公差":"公差内"} ({liveDev>0?`+${liveDev}`:liveDev} {tol?.unit??c.unit??""})</Tag>}
            {liveAttemptDelta!==null&&<Tag tone={liveAttemptDelta>0.5?"yellow":"green"}>与第1次差值 {liveAttemptDelta} {c.unit??""}{liveAttemptDelta>0.5?" (超 0.5cm 将触发第3次复测)":""}</Tag>}
          </div>}
          {needsMoreAttempts&&<p className="notice">该数值检查项需连续测量 2 次（已完成第 1 次，请继续录入第 2 次实测值）。</p>}
          {needsEvidence&&<p className="notice">该检查项要求必拍证据照片，请上传照片后再提交任务。</p>}
          {attempts.length>0&&<p className="small">
            历史记录：{attempts.map((a:Row)=>`#${a.attempt}: ${a.status}${a.typed_value!=null?" "+a.typed_value+(a.unit??""):""}${a.details?.derived_circumference?" (推算周长 "+a.details.derived_circumference+"cm)":""}${a.is_final?" [最终值]":""}`).join(" | ")}
          </p>}
          {retryNeeded&&<p className="notice">两次测量差值超过阈值，请录入第 3 次复测值。</p>}
          {prev?.details?.uncertain&&<p className="notice">三次测量均超阈值，已取中位数并标记为不确定值（需填写原因说明）。</p>}
          {prev?.evidence_ids?.[0]&&writable&&<div style={{marginBottom:10}}>
            <DefectAnnotator
              mediaId={prev.evidence_ids[0]}
              annotations={currentAnnotations}
              onChange={next=>setAnnotationsByKey(s=>({...s,[rowKey]:next}))}
            />
          </div>}
          {writable&&<Form key={`${rowKey}-${attempts.length}-${prev?.id??"new"}`} label={`保存第 ${nextAttemptNum} 次录入`} run={async f=>{
            const status=text(f,"status"),value=text(f,"value"),reason=text(f,"reason"),photo=f.get("photo");
            const severity=text(f,"severity"),partCode=text(f,"part_code"),offlineSave=checked(f,"save_offline");
            const isOffline=offlineSave||!online;
            if(status==="RECORDED"&&!value)throw new Error("录入实际值，或明确选择无法检查。");
            let evidence:string[]=prev?.evidence_ids??[];
            let offlinePhoto:{name:string;mime:string;dataUrl:string}|undefined;
            if(photo instanceof File && photo.size>0) {
              if(isOffline) {
                if(photo.size>3.5*1024*1024) throw new Error("离线缓存照片不能超过 3.5MB，请先暂存数值/说明，联网后补传照片。");
                offlinePhoto={name:photo.name,mime:photo.type||"image/jpeg",dataUrl:await readFileAsDataUrl(photo)};
              } else {
                const uploadedId=await upload(photo,"shot");
                evidence=[uploadedId];
              }
            }
            const typed=c.type==="number"?Number(value):c.type==="boolean"?value==="true":value;
            const details:Record<string,unknown>={
              ...(severity?{severity}:{}),
              ...(partCode?{part_code:partCode}:{}),
              ...(reason?{note:reason}:{}),
              ...(currentAnnotations.length?{annotations:currentAnnotations}:{}),
            };
            const payload:Row={
              item_key:c.key,component:m.id,attempt:nextAttemptNum,status,is_final:true,method:c.method,
              ...(status==="RECORDED"?{typed_value:typed,...(c.unit?{unit:c.unit}:{})}:{}),
              ...(reason?{reason}:{}),
              ...(Object.keys(details).length?{details}:{}),
              ...(evidence.length?{evidence_ids:evidence}:{}),
              ...(offlinePhoto?{offline_photo:offlinePhoto}:{}),
            };
            if(isOffline) {
              saveLocalDrafts([...drafts.filter(d=>!(d.item_key===payload.item_key&&d.component===payload.component&&d.attempt===payload.attempt)),payload]);
              setDirtyRows(s=>({...s,[rowKey]:false}));
              return;
            }
            const attemptKey=attemptKeysRef.current[`${rowKey}:${nextAttemptNum}`]??=crypto.randomUUID();
            try {
              await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:[payload]},attemptKey);
              delete attemptKeysRef.current[`${rowKey}:${nextAttemptNum}`];
              setLiveNumeric(s=>{const n={...s};delete n[rowKey];return n;});
              setDirtyRows(s=>({...s,[rowKey]:false}));
              setExpandedKeys(s=>({...s,[rowKey]:false}));
              if(nextFocusKey) focusNextKeyRef.current=nextFocusKey;
              reload();
            } catch(e) {
              if(e instanceof RequestError && e.code==="VERSION_CONFLICT") {
                saveLocalDrafts([...drafts,payload]);
                const fresh=await request("/staff/inspection-tasks/"+id);
                setConflict({localRevision:data.revision,serverRevision:fresh.revision,message:e.message});
                return;
              }
              throw e;
            }
          }}>
            <Select name="status" label="结果" value={prev?.status??"RECORDED"} choices={[
              {id:"RECORDED",label:"已测量或观察"},{id:"OBSERVED_ISSUE",label:"发现问题"},{id:"NOT_OBSERVED",label:"未观察到问题"},
              {id:"NOT_TESTED",label:"未检查"},{id:"NOT_APPLICABLE",label:"不适用"},{id:"BLOCKED",label:"无法继续"}]}/>
            {c.type==="boolean"?<Select name="value" label="观察值" required={false} value={prev?.typed_value!=null?String(prev.typed_value):""} choices={[{id:"true",label:"是"},{id:"false",label:"否"}]}/>:
              <label>实际值{c.unit?` (${c.unit})`:""}<input
                ref={el=>{inputRefs.current[rowKey]=el;}}
                name="value"
                type={c.type==="number"?"number":"text"}
                step="any"
                defaultValue={numDefaultVal}
                onChange={e=>{setLiveNumeric(s=>({...s,[rowKey]:e.target.value}));setDirtyRows(s=>({...s,[rowKey]:Boolean(e.target.value.trim())}));}}
                onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}
              /></label>}
            <Select name="severity" label="严重度（发现问题时必填）" required={false} choices={[
              {id:"attention",label:"Attention（需留意）"},{id:"material_issue",label:"Material issue（明显缺陷）"},{id:"uncertain",label:"Uncertain（不确定）"}
            ]}/>
            {availPartChoices.length>0&&<Select name="part_code" label="缺陷部位" required={false} choices={availPartChoices}/>}
            <Field name="reason" label="观察说明或缺测原因（支持中文录入，复核时译为英文）" value={prev?.reason??""} required={false}/>
            <label>证据照片{c.evidence?"（提交前必填）":""}<FileInput name="photo" accept="image/*"/></label>
            <label className="check"><input type="checkbox" name="save_offline"/>暂存到本机离线队列（稍后批量同步）</label>
          </Form>}
        </div>;
      })}
      {(data.content.shots??[]).filter((s:Row)=>Boolean(data.group_id)||!s.component||s.component===m.id).length>0&&<div style={{marginTop:14}}>
        <h3>必拍机位拍照清单（组件：{m.id==="main"?(data.item_code??"主件"):m.code}）</h3>
        <div className="task-shots-grid">
          {(data.content.shots??[]).filter((s:Row)=>Boolean(data.group_id)||!s.component||s.component===m.id).map((s:Row)=>{
            const matchingShots=(data.shots??[]).filter((x:Row)=>x.shot_code===s.code&&(x.component??"main")===m.id);
            return <div className="card" key={s.code} id={`comp-${m.id}-${s.code}`}>
              <div className="row" style={{marginBottom:6}}>
                <strong>{s.zh??s.name} · <span className="code">{s.code}</span></strong>
                {matchingShots.length>0?<Tag tone="green">已传 {matchingShots.length} 张</Tag>:<Tag tone="yellow">必拍待传</Tag>}
              </div>
              {matchingShots.length>0&&<div className="actions" style={{marginBottom:8,flexWrap:"wrap"}}>
                {matchingShots.map((sh:Row,i:number)=><img key={sh.id} src={`/api/v1/media/${sh.id}/thumb`} alt={`${s.zh??s.name} #${i+1}`} style={{width:72,height:54,objectFit:"cover",borderRadius:5,border:"1px solid var(--border)"}}/>)}
                <MediaButton ids={matchingShots.map((sh:Row)=>sh.id)} labels={matchingShots.map((_:Row,i:number)=>`${s.zh??s.name} (${s.code}) #${i+1}`)} label={`查看机位照 (${matchingShots.length})`}/>
              </div>}
              {writable&&<Form label={matchingShots.length>0?"补拍并追加该机位照":"上传必拍机位照"} run={async f=>{
                const mediaId=await upload(f.get("photo"),"shot");
                await request("/staff/inspection-tasks/"+id+"/shots","POST",{revision:data.revision,component:m.id,shot_code:s.code,media_id:mediaId});
                reload();
              }}><Photo label="选择或拍摄机位照"/></Form>}
            </div>;
          })}
        </div>
      </div>}
    </Panel>)}
    {data.group_id&&(data.content.order_shots?.length??0)>0&&<Panel title="对比组同框必拍照">
      <div className="task-shots-grid">
        {data.content.order_shots.map((code:string)=>{
          const matchingGroup=(data.shots??[]).filter((x:Row)=>x.shot_code===code&&["group","order","main",null].includes(x.component));
          return <div className="card" key={code} id={`comp-group-${code}`}>
            <div className="row" style={{marginBottom:6}}>
              <strong>对比组机位：<span className="code">{code}</span></strong>
              {matchingGroup.length>0?<Tag tone="green">已传 {matchingGroup.length} 张</Tag>:<Tag tone="yellow">待传</Tag>}
            </div>
            {matchingGroup.length>0&&<div className="actions" style={{marginBottom:8}}>
              <MediaButton ids={matchingGroup.map((x:Row)=>x.id)} labels={matchingGroup.map((_:Row,i:number)=>`对比组 (${code}) #${i+1}`)} label={`查看对比组照 (${matchingGroup.length})`}/>
            </div>}
            {writable&&<Form label="上传对比组照" run={async f=>{
              const mediaId=await upload(f.get("photo"),"shot");
              await request("/staff/inspection-tasks/"+id+"/shots","POST",{revision:data.revision,component:"group",shot_code:code,media_id:mediaId});
              reload();
            }}><Photo label="拍摄并排对比照"/></Form>}
          </div>;
        })}
      </div>
    </Panel>}
    <Panel title="提交前完整性检查">
      {completeness.ok&&drafts.length===0?<p><Tag tone="green">完整性通过</Tag> 所有必测项、复测、证据照与组件必拍照均已齐全。</p>:<>
        {drafts.length>0&&<p className="notice">当前仍有 <strong>{drafts.length}</strong> 条未同步的本机离线草稿，请先同步后再提交任务。</p>}
        {!completeness.ok&&<>
          <p className="notice">当前仍有 {completeness.missing.length} 项缺漏，补齐前不可提交任务：</p>
          <ul>{completeness.missing.map((item:Row,idx:number)=><li key={idx}>
            <a href={`#comp-${item.component}-${item.code}`} onClick={()=>{
              setCheckFilter("all");
              const rk=`${item.component}:${item.code}`;
              setExpandedKeys(s=>({...s,[rk]:true}));
              focusNextKeyRef.current=rk;
            }}><strong>{item.sample_id} · {item.label}</strong></a>：{item.hint}
          </li>)}</ul>
        </>}
      </>}
      {writable&&(completeness.ok&&drafts.length===0
        ?<Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/submit","POST",{revision:data.revision});location.assign("/wh/inspection");}}>提交此任务</Action>
        :<button type="button" className="button primary" disabled title="请先补齐缺失检查项/机位照并同步本地草稿">提交此任务（请先补齐 {completeness.missing.length + drafts.length} 项待完成内容）</button>)}
    </Panel>
    {drafts.length>0&&!conflict&&writable&&<div className="sticky-batch-bar">
      <div><strong>本机已暂存 {drafts.length} 条结果草稿</strong> <span className="muted">确认网络畅通后可一键批量写入服务端</span></div>
      <div className="actions">
        <Action primary sm run={syncAllDrafts}>批量同步 {drafts.length} 项草稿</Action>
      </div>
    </div>}
  </>;
}
const DIRECTION_ZH: Record<string, { label: string; tone: "blue" | "yellow" | "green" | "gray" }> = {
  inbound: { label: "入仓运输", tone: "blue" },
  return_to_seller: { label: "退回商家", tone: "yellow" },
  to_forwarder: { label: "寄集运仓", tone: "green" },
  to_domestic_address: { label: "国内转寄", tone: "blue" },
};

const ALERT_STATE_ZH: Record<string, { label: string; tone: "red" | "yellow" | "green" | "gray" }> = {
  open: { label: "待认领", tone: "red" },
  acknowledged: { label: "跟进中", tone: "yellow" },
  resolved: { label: "已解除", tone: "green" },
};

export function LogisticsDesk({actor}:{actor?:Row}) {
  const {data,error,reload}=useLoad("/staff/tracking");
  const monitor=useLoad("/staff/tracking/monitor");
  const carriers=useLoad("/carriers");
  const [tab,setTab]=useState<"all"|"inbound"|"outbound"|"delivered_unreceived"|"alerts">("all");
  const [searchQ,setSearchQ]=useState("");
  const [transportFilter,setTransportFilter]=useState("");
  const [selectedId,setSelectedId]=useState<string>("");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const rows:Row[]=data?.rows??[];
  const selectedTrack=rows.find(r=>r.id===selectedId);
  const canTranslate=Boolean(actor?.roles?.some((r:string)=>["receiver","support","reviewer","warehouse_admin","super_admin"].includes(r)));
  const canCorrectWaybill=Boolean(actor?.roles?.some((r:string)=>["warehouse_admin","super_admin"].includes(r)));
  const isSuperAdmin=Boolean(actor?.roles?.includes("super_admin"));
  const carrierChoices=(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}));

  const q=searchQ.trim().toLowerCase();
  const filteredRows=rows.filter((r:Row)=>{
    if(tab==="inbound"&&r.direction!=="inbound") return false;
    if(tab==="outbound"&&r.direction==="inbound") return false;
    if(transportFilter&&r.transport_state!==transportFilter) return false;
    if(!q) return true;
    return [
      r.tracking_norm,
      r.receiving_code,
      r.package_code,
      r.carrier_name_zh,
      ...(r.order_numbers??[]),
    ].some(v=>String(v??"").toLowerCase().includes(q));
  });

  const openAlerts:Row[]=monitor.data?.alerts??[];
  const pendingAlertsCount=openAlerts.filter((a:Row)=>a.state!=="resolved").length;
  const unreceivedList:Row[]=monitor.data?.delivered_unreceived??[];
  const errorQueue:Row[]=monitor.data?.error_queue??[];

  const canAdminOrders=Boolean(actor?.roles?.some((r:string)=>["support","super_admin"].includes(r)));
  const canIntakeView=Boolean(actor?.roles?.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r)));
  const renderTrackCustomerAndOrders=(r:Row)=><div className="cell-stack">
    {r.receiving_code&&(canAdminOrders&&r.customer_user_id
      ?<Link className="code nowrap" href={`/admin/customers/${r.customer_user_id}`}>{r.receiving_code}</Link>
      :<span className="code nowrap">{r.receiving_code}</span>)}
    {!r.receiving_code&&<span className="muted">待归属客户</span>}
    {(r.order_numbers?.length??0)>0&&<div className="actions">
      {(r.order_numbers as string[]).map(no=>canAdminOrders?<Link key={no} className="code nowrap" href={`/admin/orders/${no}`}>{no}</Link>:<span key={no} className="code nowrap">{no}</span>)}
    </div>}
    {r.package_code&&<CodeButton code={r.package_code} onClick={()=>setDrawer({kind:"package",ref:r.package_code})}/>}
  </div>;

  return <>
    <div className="page-head row">
      <div>
        <h1>物流监控与轨迹翻译台</h1>
        <p className="muted">统一监控入仓包裹、退回商家与寄出集运仓运单；严格区分「承运商物流签收」与「仓库扫码实收/称重/SKU 核身」，支持全宽双语轨迹翻译与独立复核。</p>
      </div>
      <div className="head-actions">
        <button type="button" className="button sm" onClick={()=>{reload();monitor.reload();}}>刷新监控</button>
        {isSuperAdmin&&<Link className="button sm" href="/admin/integrations/logistics">物流接口配置</Link>}
      </div>
    </div>

    {error&&<ErrorBlock error={error}/>}
    {monitor.error&&<ErrorBlock error={monitor.error}/>}

    {monitor.data&&<div className="stats" aria-label="物流监控指标">
      <div className="stat"><span className="label">24h 查询请求</span><strong className="value">{monitor.data.quota_summary.queries_24h}</strong><small className="detail">活跃订阅 {monitor.data.quota_summary.active_subscriptions} 条</small></div>
      <div className="stat"><span className="label">限频 / 额度异常</span><strong className="value">{monitor.data.quota_summary.rate_limited_24h + monitor.data.quota_summary.quota_exhausted_24h}</strong><small className="detail">鉴权报错 {monitor.data.quota_summary.auth_errors_24h} 次</small></div>
      <div className="stat"><span className="label">异常运输告警</span><strong className="value">{pendingAlertsCount}</strong><small className="detail">超 SLA 未处置 {openAlerts.filter((a:Row)=>a.overdue).length} 起</small></div>
      <div className="stat"><span className="label">已签收待实收</span><strong className="value">{unreceivedList.length}</strong><small className="detail">承运商签收但未扫入仓库</small></div>
    </div>}

    <AdminTabs
      active={tab}
      onChange={next=>setTab(next as typeof tab)}
      tabs={[
        {id:"all",label:"全部运单台账",count:rows.length},
        {id:"inbound",label:"入仓运输 (卖家→仓)",count:rows.filter(r=>r.direction==="inbound").length},
        {id:"outbound",label:"出库运输 (退商/集运)",count:rows.filter(r=>r.direction!=="inbound").length},
        {id:"delivered_unreceived",label:"签收未实收催办",count:unreceivedList.length},
        {id:"alerts",label:"异常告警与错误队列",count:pendingAlertsCount+errorQueue.length},
      ]}
    />

    {tab==="delivered_unreceived"&&(
      <Panel title="承运商已签收但仓库尚未登记实收" subtitle="此类包裹快递已显示妥投但仓库尚未扫码入库，须核查快递柜/门卫或发起异常处理。">
        <Table
          headers={["运单号","承运商","所属客户","关联订单","签收时间","最新轨迹摘要"]}
          rows={unreceivedList.map((d:Row)=>[
            <div key="t" className="cell-stack">
              <CodeButton code={d.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:d.tracking_norm})}/>
              <CopyId value={d.tracking_norm}/>
            </div>,
            d.carrier_name_zh??d.carrier_code??"—",
            d.receiving_code&&(canAdminOrders&&d.customer_user_id?<Link className="code nowrap" href={`/admin/customers/${d.customer_user_id}`}>{d.receiving_code}</Link>:<span className="code nowrap">{d.receiving_code}</span>),
            d.order_no?(canAdminOrders?<Link className="code nowrap" href={`/admin/orders/${d.order_no}`}>{d.order_no}</Link>:<span className="code nowrap">{d.order_no}</span>):"—",
            stamp(d.delivered_at),
            d.latest_cn??"—",
          ])}
          empty="所有承运商签收包裹均已在仓库完成扫码实收。"
        />
      </Panel>
    )}

    {tab==="alerts"&&<>
      <Panel title="异常运输告警队列" subtitle="涵盖退件、超时停滞、拒收、电话验证等承运商告警，支持认领跟进与解除闭环。">
        <Table
          headers={["运单号","方向与承运商","所属客户与订单","异常类型","状态 / 超期","截止时间","跟进操作"]}
          rows={openAlerts.map((a:Row)=>[
            <CodeButton key="tr" code={a.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:a.tracking_norm})}/>,
            <div key="dir" className="cell-stack">
              <BizTag dict={DIRECTION_ZH} value={a.direction}/>
              <small className="muted">{a.carrier_name_zh??a.carrier_code??"—"}</small>
            </div>,
            renderTrackCustomerAndOrders(a),
            <div key="kind" className="cell-stack">
              <Tag tone="yellow">{TRACKING_ALERT_KIND_ZH[a.kind]??a.kind}</Tag>
              <small className="muted">第 {a.episode} 次异常</small>
            </div>,
            <div key="st" className="cell-stack">
              <BizTag dict={ALERT_STATE_ZH} value={a.state}/>
              {a.overdue&&<Tag tone="red">SLA 已超期</Tag>}
            </div>,
            stamp(a.due_at),
            a.state!=="resolved"?<div key="op" className="actions">
              {a.state==="open"&&<Action sm run={async()=>{
                await request(`/staff/tracking-alerts/${a.id}`,"POST",{action:"acknowledge",note:"运营认领并跟进承运商"});
                monitor.reload();
              }}>认领跟进</Action>}
              <Action sm primary run={async()=>{
                await request(`/staff/tracking-alerts/${a.id}`,"POST",{action:"resolve",note:"已核对物流与包裹处置完毕"});
                monitor.reload();
              }}>标记解除</Action>
            </div>:<Tag tone="green">已处理完结</Tag>,
          ])}
          empty="当前无物流异常告警。"
        />
      </Panel>
      <Panel title="同步错误与需验证运单队列" subtitle="接口报错、限频、缺少手机号后4位或承运商暂不支持的记录集中展示于此。">
        <Table
          headers={["运单号","承运商","客户与订单","同步状态","最近错误原因","最近成功同步"]}
          rows={errorQueue.map((e:Row)=>[
            <CodeButton key="t" code={e.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:e.tracking_norm})}/>,
            e.carrier_name_zh??e.carrier_code??"—",
            renderTrackCustomerAndOrders(e),
            <BizTag key="sy" dict={SYNC_STATE_ZH} value={e.sync_state}/>,
            <span key="err" className="small">{formatLogisticsErrorZh(e.last_error_code)}</span>,
            stamp(e.last_success_at),
          ])}
          empty="当前所有运单同步状态健康，无报错队列。"
        />
      </Panel>
    </>}

    {selectedTrack&&(
      <Panel
        id="waybill-detail-workbench"
        title={`运单全宽详情与双语轨迹复核台 · ${selectedTrack.tracking_norm}`}
        subtitle={`${selectedTrack.carrier_name_zh??selectedTrack.carrier_code??""} · ${DIRECTION_ZH[selectedTrack.direction]?.label??selectedTrack.direction}`}
        badge={<button type="button" className="button sm" onClick={()=>setSelectedId("")}>收起运单工作台 ✕</button>}
      >
        <div className="metric-strip" style={{marginBottom:14}} aria-label="运单四阶段状态对照">
          <div className="metric">
            <span>① 承运商运输与签收</span>
            <strong>{TRANSPORT_STATE_ZH[selectedTrack.transport_state]?.label??selectedTrack.transport_state}</strong>
            <small>同步状态：{SYNC_STATE_ZH[selectedTrack.sync_state]?.label??selectedTrack.sync_state}</small>
          </div>
          <div className="metric">
            <span>② 仓库物理扫码实收</span>
            <strong>{selectedTrack.direction==="inbound"?(selectedTrack.package_code?`已实收 (${selectedTrack.package_code})`:selectedTrack.transport_state==="delivered"?"签收未实收 (需催查)":"待到仓实收"):"出库发运件"}</strong>
            <small>{selectedTrack.package_received_at?`实收时间 ${stamp(selectedTrack.package_received_at,true)}`:"以仓库现场扫码为准"}</small>
          </div>
          <div className="metric">
            <span>③ 包裹实测称重</span>
            <strong>{selectedTrack.package_weight_g?`${selectedTrack.package_weight_g} g`:selectedTrack.shipment_weight_g?`${selectedTrack.shipment_weight_g} g`:"待称重"}</strong>
            <small>仓库电子秤实测克重</small>
          </div>
          <div className="metric">
            <span>④ 拆包建档与 SKU 核身</span>
            <strong>{selectedTrack.direction==="inbound"?`拆包 ${selectedTrack.logged_item_count??0} 件 / 核身 ${selectedTrack.identified_item_count??0} 件`:"已核身出库"}</strong>
            <small>关联：{selectedTrack.receiving_code??"未归属"} {(selectedTrack.order_numbers??[]).join(", ")}</small>
          </div>
        </div>

        <div className="ops-columns">
          <div>
            <h3 style={{marginTop:0}}>承运商中文原始轨迹快照</h3>
            {selectedTrack.events?.length
              ?<ol className="timeline">{selectedTrack.events.map((e:Row,idx:number)=><li key={e.id??idx}><small className="muted">{stamp(e.occurred_at??e.time)}</small><div>{e.text??e.context??e.description}</div></li>)}</ol>
              :<Empty>暂无承运商中文轨迹（本地演示未接外部回调或尚无路由回传时保留真实空状态）。</Empty>}
          </div>
          <div>
            <h3 style={{marginTop:0}}>受控运单号与承运商纠偏</h3>
            {canCorrectWaybill&&carrierChoices.length>0?(
              <div className="card" style={{margin:0}}>
                <p className="small muted">原运单记录将归档为历史快照并保留关联；已交接出库运单修正必须上传面单照片凭证。</p>
                <Form key={`corr-${selectedTrack.id}-${selectedTrack.revision}`} label="确认修正运单" run={async f=>{
                  const file=f.get("photo");
                  const evidenceIds:string[]=[];
                  if(file instanceof File && file.size>0) {
                    evidenceIds.push(await upload(file,"label_photo"));
                  } else if(selectedTrack.shipment_id) {
                    throw new Error("已出库运单修正必须上传面单照片凭证。");
                  }
                  await request(`/staff/tracking/${selectedTrack.id}/correct`,"POST",{
                    revision:selectedTrack.revision??1,
                    carrier_code:text(f,"carrier_code"),
                    tracking_no:text(f,"tracking_no"),
                    reason:text(f,"reason"),
                    ...(evidenceIds.length?{evidence_ids:evidenceIds}:{}),
                  });
                  setSelectedId("");
                  reload();
                  monitor.reload();
                }}>
                  <div className="fields">
                    <Select name="carrier_code" label="更正后承运商" value={selectedTrack.carrier_code??carrierChoices[0]?.id} choices={carrierChoices}/>
                    <Field name="tracking_no" label="更正后运单号" value={selectedTrack.tracking_norm}/>
                  </div>
                  <Field name="reason" label="更正原因（审计必填）"/>
                  <label>面单照片凭证{selectedTrack.shipment_id?"（出库运单必填）":"（可选）"}<FileInput name="photo" accept="image/*" required={Boolean(selectedTrack.shipment_id)}/></label>
                </Form>
              </div>
            ):<Empty>仅仓库主管与超级管理员可执行运单号纠偏。</Empty>}
          </div>
        </div>

        {(selectedTrack.zh_events?.length??0)>0&&<div style={{marginTop:16}}>
          <h3 style={{marginBottom:8}}>对客英文轨迹翻译与独立双人复核（禁止起草人自审）</h3>
          <Table headers={["发生时间","中文原始节点","当前对客英文译文","复核状态","人工翻译 / 独立复核操作"]} rows={selectedTrack.zh_events.map((ev:Row)=>[
            <span key="tm" className="nowrap">{stamp(ev.occurred_at??ev.source_time)}</span>,
            ev.text_zh??"—",
            ev.text_en??<span className="muted">尚未录入英文译稿</span>,
            <Tag key="st" tone={ev.reviewed_at?"green":ev.translation_id?"yellow":"gray"}>{ev.reviewed_at?"已独立复核发布":ev.translation_id?"译稿待第二人复核":"待翻译"}</Tag>,
            canTranslate?<div key="act" className="stack" style={{gap:6}}>
              <Form inline key={`tr-${ev.id}-${ev.translation_id??"new"}`} label="保存译稿" run={async f=>{
                await request(`/staff/tracking/${selectedTrack.id}/translations`,"POST",{
                  tracking_event_id:ev.id,
                  source_hash:ev.source_hash,
                  text_en:text(f,"text_en"),
                });
                reload();
              }}>
                <Field name="text_en" label="英文轨迹译文" value={ev.text_en??""}/>
              </Form>
              {ev.translation_id&&!ev.reviewed_at&&(
                ev.translation_source==="draft:"+actor?.id
                  ?<small className="muted">本人起草，须由另一名员工独立复核</small>
                  :<Action sm primary run={async()=>{
                    await request(`/staff/tracking-translations/${ev.translation_id}/approve`,"POST",{});
                    reload();
                  }}>独立复核通过</Action>
              )}
            </div>:"—",
          ])}/>
        </div>}
      </Panel>
    )}

    {(tab==="all"||tab==="inbound"||tab==="outbound")&&<>
      <div className="admin-toolbar">
        <label>
          检索运单 / 客户码 / 订单号 / 包裹码
          <input type="search" value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="输入单号、QCW-... 或 QW-..."/>
        </label>
        <label>
          承运商状态筛选
          <select value={transportFilter} onChange={e=>setTransportFilter(e.target.value)}>
            <option value="">全部运输状态</option>
            {Object.entries(TRANSPORT_STATE_ZH).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <div className="actions">
          <button type="button" className="button sm" onClick={()=>{setSearchQ("");setTransportFilter("");}}>清空筛选</button>
        </div>
      </div>

      <Panel
        title={tab==="inbound"?"入仓运单监控":tab==="outbound"?"出库发运监控":"全部入仓与出库运单"}
        subtitle={`共匹配 ${filteredRows.length} 条记录；点击右侧「展开轨迹与复核」可在上方全宽工作区核对四阶段入库状态、审核英文译文或更正运单。`}
      >
        {filteredRows.length===0?(
          <EmptyState
            kind={q||transportFilter?"filtered":"empty"}
            title="没有符合筛选条件的运单记录"
            description="请检查单号/客户码关键词，或清空筛选查看全量运输监控记录。"
            actionLabel="重置筛选"
            onAction={()=>{setSearchQ("");setTransportFilter("");}}
          />
        ):(
          <Table
            headers={["运单号 / 方向","承运商","客户码与关联订单","承运商运输状态","仓库实收 / 称重 / 核身状态","同步状态","轨迹数","最近同步","全宽工作区"]}
            rows={filteredRows.map((r:Row)=>[
              <div key="tr" className="cell-stack">
                <CodeButton code={r.tracking_norm} onClick={()=>setSelectedId(prev=>prev===r.id?"":r.id)}/>
                <BizTag dict={DIRECTION_ZH} value={r.direction}/>
              </div>,
              <div key="ca" className="cell-stack">
                <strong>{r.carrier_name_zh??r.carrier_code??"—"}</strong>
                <small className="code">{r.carrier_code??"—"}</small>
              </div>,
              renderTrackCustomerAndOrders(r),
              <BizTag key="ts" dict={TRANSPORT_STATE_ZH} value={r.transport_state}/>,
              r.direction==="inbound"?(
                r.package_code?(
                  <div key="wh" className="cell-stack">
                    <div className="actions">
                      <Tag tone="green">已实收 {r.package_code}</Tag>
                      {r.package_weight_g&&<small className="code">{r.package_weight_g}g</small>}
                    </div>
                    <small>拆包 {r.logged_item_count??r.package_received_quantity??0} 件 · 已核身 {r.identified_item_count??0} 件</small>
                  </div>
                ):r.transport_state==="delivered"?(
                  <Tag key="wh" tone="red">承运商已签收·待仓库扫码实收</Tag>
                ):(
                  <span key="wh" className="muted">在途待到仓</span>
                )
              ):(
                <div key="wh" className="cell-stack">
                  <Tag tone={r.shipment_state==="delivered"?"green":r.shipment_state==="returned"||r.shipment_state==="exception"?"red":"blue"}>{label(r.shipment_state)}</Tag>
                  <small>{r.shipment_weight_g?`称重 ${r.shipment_weight_g}g`:"出库批次发运"}</small>
                </div>
              ),
              <BizTag key="ss" dict={SYNC_STATE_ZH} value={r.sync_state}/>,
              <span key="cnt" className="nowrap">{(r.zh_events?.length||r.events?.length)||0} 条</span>,
              stamp(r.last_success_at),
              <button
                key="btn"
                type="button"
                className={"button sm nowrap"+(selectedId===r.id?"":" primary")}
                onClick={()=>setSelectedId(prev=>prev===r.id?"":r.id)}
              >{selectedId===r.id?"收起工作区":"展开轨迹与复核"}</button>,
            ])}
          />
        )}
      </Panel>
    </>}
    <StaffObjectDrawer target={drawer} actor={actor} onClose={()=>setDrawer(null)}/>
  </>;
}
export function LogisticsConfiguration() {
  const {data,error,reload}=useLoad("/staff/admin/tracking/health");
  const monitor=useLoad("/staff/tracking/monitor");
  return <>
    <div className="page-head row">
      <div>
        <h1>物流供应商接入与承运商字典</h1>
        <p className="muted">检查服务端快递100（Express100）密钥接入状态、回调安全开关与首发承运商校验规则。</p>
      </div>
      <div className="head-actions">
        <button type="button" className="button sm" onClick={()=>{reload();monitor.reload();}}>重新读取配置</button>
        <Link className="button sm" href="/admin/logistics">返回物流监控台</Link>
      </div>
    </div>
    <StatusBanner
      tone={data?.queryConfigured&&data?.subscribeConfigured?"info":"warning"}
      title={data?.queryConfigured&&data?.subscribeConfigured?"快递100服务端配置已就绪":"当前环境未配置快递100实时密钥"}
    >
      {data?.queryConfigured&&data?.subscribeConfigured
        ?"服务端已检测到快递100 API 配置：仍需使用生产实寄单完成联调验证并核对订阅额度。"
        :"当前环境边界：承运商字典与人工纠偏已就绪，但快递100实时查询/订阅密钥尚未配置（密钥只允许配置在服务端环境变量，不可在前端硬编码）。"}
    </StatusBanner>
    <Panel title="快递100服务端配置预检" subtitle="所有敏感密钥仅由环境变量加载，后台页面仅做只读健康检查。">
      {error?<ErrorBlock error={error}/>:data?<Table headers={["接入检查项","状态","运维说明"]} rows={[
        ["运单实时查询接口",<Tag tone={data.queryConfigured?"green":"yellow"}>{data.queryConfigured?"已配置":"未配置"}</Tag>,"用于主动拉取中通/圆通/顺丰等国内轨迹"],
        ["HTTPS 签名回调地址",<Tag tone={data.httpsCallbackConfigured?"green":"yellow"}>{data.httpsCallbackConfigured?"已配置":"未配置"}</Tag>,"接收承运商推送并执行签名与状态机校验"],
        ["主动订阅推送开关",<Tag tone={data.subscribeConfigured?"green":"yellow"}>{data.subscribeConfigured?"已配置":"未配置"}</Tag>,"新运单建档后向快递100发起订阅"],
        ["后台轮询补采 Worker",<Tag tone={data.workerEnabled?"green":"yellow"}>{data.workerEnabled?"已启用":"未启用"}</Tag>,"对沉默运单与重试队列按频控周期补采"],
      ]}/>:<p role="status">正在读取服务端配置…</p>}
    </Panel>
    {monitor.data&&<Panel title="首发承运商字典与手机号验证规则">
      <Table headers={["承运商编码","中文名称","英文名称","手机号尾号校验要求","启用状态"]} rows={monitor.data.carriers.map((c:Row)=>[
        <strong className="code">{c.code}</strong>,
        c.name_zh,
        c.name_en,
        c.requires_phone?<Tag tone="yellow">顺丰等须收/寄件人手机尾号后4位</Tag>:"免手机号校验",
        <Tag tone={c.active?"green":"gray"}>{c.active?"已启用":"已停用"}</Tag>,
      ])} empty="暂无承运商配置。"/>
    </Panel>}
  </>;
}
const LEGAL_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "gray" }> = {
  published: { label: "生效发布中", tone: "green" },
  draft: { label: "草稿待发布", tone: "yellow" },
  archived: { label: "历史已归档", tone: "gray" },
};

const CATEGORY_STATUS_ZH: Record<string, { label: string; tone: "green" | "yellow" | "gray" }> = {
  ACTIVE: { label: "正式可售 (Active)", tone: "green" },
  PAUSED: { label: "已暂停售卖 (Paused)", tone: "yellow" },
  DRAFT: { label: "规划筹备中 (Draft)", tone: "gray" },
};

const TEMPLATE_STATE_ZH: Record<string, { label: string; tone: "green" | "yellow" | "gray" | "blue" }> = {
  PUBLISHED: { label: "已审核发布", tone: "green" },
  IN_REVIEW: { label: "待独立审核", tone: "yellow" },
  DRAFT: { label: "草稿", tone: "gray" },
  ARCHIVED: { label: "已归档", tone: "gray" },
};

const LEGAL_KIND_ZH: Record<string, string> = {
  terms: "客户服务条款 (Terms of Service)",
  privacy: "隐私与数据保护政策 (Privacy Policy)",
  restricted_items: "禁限寄与高风险品说明 (Restricted Items)",
  report_notice: "质检报告使用与责任限制 (Report Notice)",
};

export function AdminDesk({actor,path,demo=false}:{actor:Row;path:string;demo?:boolean}) {
  const {data,error,reload}=useLoad("/staff/admin/desk"),terms=useLoad("/public/terms");
  const [configTab,setConfigTab]=useState<"addresses"|"quote_policy"|"calendar">("addresses");
  const [catalogTab,setCatalogTab]=useState<"categories"|"offers">("categories");
  const [previewLegal,setPreviewLegal]=useState<Row|null>(null);
  const [previewTemplate,setPreviewTemplate]=useState<Row|null>(null);
  const [compareTemplateId,setCompareTemplateId]=useState<string>("");
  const [admittingCategory,setAdmittingCategory]=useState<Row|null>(null);
  const [translatingCategory,setTranslatingCategory]=useState<Row|null>(null);
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);

  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p role="status">正在加载 Admin 工作台…</p>;
  const rawPage=path.split("/")[2]??"overview";
  const page=rawPage==="categories"?"catalog":rawPage;
  const superAdmin=actor.roles.includes("super_admin");
  const canReviewTemplate=actor.roles.some((r:string)=>["reviewer","super_admin"].includes(r));
  const canAuthorTemplate=actor.roles.some((r:string)=>["template_admin","super_admin"].includes(r));

  const alertBanner = superAdmin&&data.warehouseAddressAlert ? (
    <StatusBanner tone="warning" title="待发布默认公共收件仓址">
      客户注册已开始领码，请尽快核对并启用默认收件仓址。<Link className="button sm" href="/admin/config">前往仓库地址配置 →</Link>
    </StatusBanner>
  ) : null;

  if(page==="overview") return <>{alertBanner}<AdminOverviewDashboard deskData={data} error={error} reload={reload} actor={actor}/></>;
  if(page==="orders") return <>{alertBanner}<AdminOrdersWorkbench deskData={data} reloadDesk={reload} actor={actor}/></>;
  if(page==="dispositions") return <>{alertBanner}<AdminDispositionsWorkbench deskData={data} reloadDesk={reload} actor={actor} terms={terms.data?.terms??[]}/></>;
  if(page==="incidents") return <>{alertBanner}<AdminIncidentsWorkbench actor={actor}/></>;
  if(page==="refunds") return <>{alertBanner}<AdminRefundsWorkbench/></>;
  if(page==="payments") return <>{alertBanner}<AdminPaymentsWorkbench demo={demo} actor={actor}/></>;
  if(page==="finance") return <>{alertBanner}<AdminFinanceAnalytics demo={demo}/></>;

  const heading:Record<string,[string,string]>={
    catalog:["品类与可售套餐目录","分类准入、服务类型与可售报价 SKU 版本价格分离管控；生产目录只发布完成 SOP 与能力审批的品类。"],
    templates:["品类检验能力与检查模板","所有检验能力与模板版本须经作者提交 + 独立审核人双人发布；已绑定历史订单保留原模板版本快照。"],
    "shipping-rates":["国内运费阶梯费率与试算","严格分离「运费费率版本发布管理」与「独立多包裹运费试算器」，所有已确认发运报价沿用签发时费率版本。"],
    config:["业务参数、收货公仓与工作日历","配置多版本公仓地址、报价有效期及 SLA 节假日/调休规则，禁止在前端写死业务参数。"],
    legal:["合规条款、隐私政策与声明版本","支持先保存草稿并全宽审阅 Markdown 正文与 SHA-256 哈希，自动拦截/告警开发夹具文本，客户历史签约版本全量可追溯。"],
    users:["员工账号角色与 RBAC 权限管控","按职责分离 (SoD) 配置岗位权限；客户 360 档案已独立迁往「客户档案」工作台。"],
    settings:[superAdmin?"系统参数与模板准入":"检查能力与模板准入","集中维护当前业务参数、类目准入与品类检查模板版本。"],
  };
  const currentHeading=heading[page]??["平台配置","维护受控业务规则与版本记录。"];
  const defaultAddr=(data.addresses??[]).find((a:Row)=>a.is_default&&a.active);
  const looksLikeDemoAddr=Boolean(defaultAddr && /演示|test|demo/i.test(`${defaultAddr.address_zh??""} ${defaultAddr.address_en??""}`));
  const activeDemoTerms=(data.termsVersions??[]).filter((t:Row)=>t.is_current_active && (t.is_demo_fixture || /Development fixture/i.test(t.content_md??"")));
  const sameKeyTemplates=previewTemplate?(data.templates??[]).filter((t:Row)=>t.template_key===previewTemplate.template_key && t.id!==previewTemplate.id):[];
  const compareTarget=sameKeyTemplates.find((t:Row)=>t.id===compareTemplateId)??sameKeyTemplates[0]??null;

  return <>
    <div className="page-head row">
      <div>
        <h1>{currentHeading[0]}</h1>
        <p className="muted">{currentHeading[1]}</p>
      </div>
      <div className="head-actions">
        {page==="users"&&<Link className="button sm primary" href="/admin/customers">打开客户 360 档案目录 →</Link>}
        {page==="templates"&&<Link className="button sm" href="/admin/inspections">前往质检任务与报告监督 →</Link>}
        {page==="catalog"&&superAdmin&&<Link className="button sm" href="/admin/templates">管理品类检查模板 →</Link>}
        <button type="button" className="button sm" onClick={reload}>刷新配置</button>
      </div>
    </div>
    {alertBanner}

    {(page==="config"||page==="settings")&&superAdmin&&<>
      <AdminTabs
        active={configTab}
        onChange={next=>setConfigTab(next as typeof configTab)}
        tabs={[
          {id:"addresses",label:"收货公仓地址版本",count:(data.addresses??[]).length},
          {id:"quote_policy",label:"报价有效期规则"},
          {id:"calendar",label:"工作日历与 SLA 节假日"},
        ]}
      />
      {configTab==="addresses"&&<>
        {looksLikeDemoAddr&&<StatusBanner tone="warning" title="当前默认仓址带有演示/测试字样">
          当前生效公仓：{defaultAddr.address_zh}。正式对外开放接单前，请新增并切换为真实运营仓址（历史在途单仍可正常扫入旧仓址）。
        </StatusBanner>}
        <Panel title="仓库收货地址版本列表" subtitle="切换唯一默认公仓地址不会影响发往历史仓址的在途包裹正常入库。">
          <Table
            headers={["中文收货地址","英文参考地址","收件人 / 电话","关联预报运单数","启用状态","版本操作"]}
            rows={(data.addresses??[]).map((a:Row)=>[
              <div key="zh" className="cell-stack">
                <span>{a.address_zh}</span>
                <CopyId value={a.id}/>
              </div>,
              a.address_en,
              <div key="c" className="cell-stack">
                <strong>{a.contact_name}</strong>
                <small className="code nowrap">{a.contact_phone}</small>
              </div>,
              <span key="cnt" className="nowrap">{a.advice_count??0} 单</span>,
              <Tag key="st" tone={a.is_default?"green":a.active?"blue":"gray"}>{a.is_default?"唯一默认公仓":a.active?"候选启用":"已停用(历史保留)"}</Tag>,
              <div key="op" className="actions">
                {!a.is_default&&<Action sm primary run={async()=>{
                  if(!window.confirm(`确认将「${a.address_zh}」切换为唯一默认公共收货仓址？新注册与新建单客户将看到此地址，历史在途预报包裹仍保留原地址快照。`)) return;
                  await request("/staff/admin/warehouse-addresses/"+a.id,"POST",{is_default:true});
                  reload();
                }}>设为唯一默认</Action>}
                {!a.is_default&&<Action sm run={async()=>{
                  await request("/staff/admin/warehouse-addresses/"+a.id,"POST",{active:!a.active});
                  reload();
                }}>{a.active?"停用":"恢复启用"}</Action>}
              </div>,
            ])}
            empty="暂无仓库收货地址版本。"
          />
          <hr className="divider"/>
          <Form label="新增公共收件仓址版本" run={async f=>{
            await request("/staff/admin/warehouse-addresses","POST",{
              address_zh:text(f,"address_zh"),
              address_en:text(f,"address_en"),
              contact_name:text(f,"contact_name"),
              contact_phone:text(f,"contact_phone"),
              is_default:text(f,"is_default")==="true",
            });
            reload();
          }}>
            <Field name="address_zh" label="中文地址（含专属码占位提示）"/><Field name="address_en" label="英文参考地址"/>
            <Field name="contact_name" label="仓库收件人"/><Field name="contact_phone" label="仓库电话"/>
            <Select name="is_default" label="生效策略" choices={[{id:"true",label:"立即设为唯一默认公仓"},{id:"false",label:"先作为候选地址保存"}]}/>
          </Form>
        </Panel>
      </>}
      {configTab==="quote_policy"&&<QuotePolicyEditor policy={data.quote_policy} onSave={reload}/>}
      {configTab==="calendar"&&<BusinessCalendarEditor calendar={data.calendar} onSave={reload}/>}
    </>}

    {page==="legal"&&superAdmin&&<>
      {activeDemoTerms.length>0&&(
        <StatusBanner tone="warning" title={`合规阻断提醒：检测到 ${activeDemoTerms.length} 类当前生效协议仍为开发夹具文本 (demo fixture)`}>
          当前生效的 <strong>{activeDemoTerms.map((t:Row)=>`${t.kind} (${t.version})`).join("、")}</strong> 包含 <code>Development fixture. Use test parcels and simulated payments only.</code> 占位文案。正式对外开放生产接单前，必须在下方起草并发布经法务审核的正式英文协议版本！
        </StatusBanner>
      )}

      {previewLegal&&(
        <Panel
          id="legal-preview-workbench"
          title={`条款全文审阅与发布工作区 · ${LEGAL_KIND_ZH[previewLegal.kind]??previewLegal.kind} (${previewLegal.version})`}
          subtitle={`SHA-256 内容哈希：${previewLegal.content_hash??"—"} · 已关联客户同意记录：${previewLegal.consent_count??0} 份`}
          badge={<button type="button" className="button sm" onClick={()=>setPreviewLegal(null)}>收起全文审阅 ✕</button>}
        >
          <div className="actions" style={{marginBottom:12}}>
            <BizTag dict={LEGAL_STATE_ZH} value={previewLegal.state}/>
            {previewLegal.is_current_active&&<Tag tone="blue">当前对外生效版本</Tag>}
            {(previewLegal.is_demo_fixture||/Development fixture/i.test(previewLegal.content_md??""))&&(
              <Tag tone="red">警告：包含开发夹具占位文本（禁用于正式生产）</Tag>
            )}
            <CopyId value={previewLegal.content_hash??"—"} short={false}/>
            {previewLegal.state==="draft"&&<Action sm primary run={async()=>{
              await request("/staff/admin/terms/"+previewLegal.id+"/publish","POST",{});
              setPreviewLegal(null);
              reload();
            }}>确认正文无误并正式发布生效</Action>}
          </div>
          <pre className="card-soft" style={{whiteSpace:"pre-wrap",fontFamily:"var(--font-mono)",fontSize:13,lineHeight:1.65,maxHeight:"56vh",overflow:"auto",padding:16}}>
            {previewLegal.content_md??"（该记录仅返回元数据，未附带 Markdown 正文）"}
          </pre>
        </Panel>
      )}

      <Panel title="合规文档与条款发布版本列表" subtitle="点击「展开全文审阅」在上方全宽区域核对完整 Markdown 条款与内容 SHA-256 摘要；自动标记开发夹具文本。">
        <Table
          headers={["文档类型","版本号","发布与合规状态","生效时间","客户签约同意数","SHA-256 内容摘要","审阅与发布"]}
          rows={(data.termsVersions??[]).map((t:Row)=>{
            const isFixture = Boolean(t.is_demo_fixture || /Development fixture/i.test(t.content_md ?? ""));
            const isSelected = previewLegal?.id === t.id;
            return [
              <div key="k" className="cell-stack">
                <strong>{LEGAL_KIND_ZH[t.kind]??t.kind}</strong>
                <small className="code">{t.kind}</small>
              </div>,
              <strong key="v" className="code">{t.version}</strong>,
              <div key="st" className="cell-stack">
                <div className="actions">
                  <BizTag dict={LEGAL_STATE_ZH} value={t.state}/>
                  {t.is_current_active&&<Tag tone="blue">当前生效</Tag>}
                </div>
                {isFixture&&<Tag tone="red">开发夹具文本 (Demo Fixture)</Tag>}
              </div>,
              t.effective_at?stamp(t.effective_at):"草稿待发布",
              <span key="cc" className="nowrap"><strong>{t.consent_count??0}</strong> 户/次</span>,
              <CopyId key="h" value={t.content_hash??"—"}/>,
              <div key="op" className="actions">
                <button type="button" className={`button sm${isSelected?"":" primary"}`} onClick={()=>setPreviewLegal(isSelected?null:t)}>
                  {isSelected?"收起审阅":"展开全文审阅"}
                </button>
                {t.state==="draft"&&<Action sm primary run={async()=>{
                  await request("/staff/admin/terms/"+t.id+"/publish","POST",{});
                  reload();
                }}>正式发布生效</Action>}
              </div>,
            ];
          })}
          empty="暂无合规条款版本。"
        />
      </Panel>
      <Panel title="起草或发布新条款版本" subtitle="建议先保存草稿并全文审阅无误后再切换发布。">
        <Form label="提交条款版本" run={async f=>{
          await request("/staff/admin/terms","POST",{
            kind:text(f,"kind"),
            version:text(f,"version"),
            content_md:text(f,"content_md"),
            publish_now:text(f,"publish_now")==="true",
          });
          reload();
        }}>
          <div className="fields three">
            <Select name="kind" label="条款类型" choices={[
              {id:"terms",label:"服务条款 (terms)"},
              {id:"privacy",label:"隐私政策 (privacy)"},
              {id:"restricted_items",label:"禁限寄说明 (restricted_items)"},
              {id:"report_notice",label:"报告使用声明 (report_notice)"},
            ]}/>
            <Field name="version" label="版本号 (如 2026.2)"/>
            <Select name="publish_now" label="发布方式" choices={[
              {id:"false",label:"先保存草稿预览"},
              {id:"true",label:"立即发布生效"},
            ]}/>
          </div>
          <label>Markdown 正文<textarea name="content_md" rows={8} required minLength={10}/></label>
        </Form>
      </Panel>
    </>}

    {page==="users"&&superAdmin&&<StaffAndCustomerUsersDesk
      staffUsers={data.staffUsers??[]}
      customerCount={Number(data.overviewMetrics?.active_customers??0)}
      actor={actor}
      onSave={reload}
    />}

    {(page==="catalog"||page==="settings")&&<>
      <AdminTabs
        active={catalogTab}
        onChange={next=>setCatalogTab(next as typeof catalogTab)}
        tabs={[
          {id:"categories",label:"类目运营准入",count:(data.categories??[]).length},
          ...(superAdmin?[{id:"offers",label:"可售套餐 SKU 与版本定价",count:(data.offers??[]).length}]:[]),
        ]}
      />
      {catalogTab==="categories"&&<>
        {admittingCategory&&superAdmin&&(
          <Panel
            id="category-admission-workbench"
            title={`品类准入审核与激活工作台 · ${admittingCategory.labels["zh-CN"]} (${admittingCategory.slug})`}
            subtitle="激活类目上线前，须登记已通过验证的仓库作业 SOP 编号、影子模板试运行证据，并确认质检台设备与人员培训到位。"
            badge={<button type="button" className="button sm" onClick={()=>setAdmittingCategory(null)}>取消审核 ✕</button>}
          >
            <Form label={`核准激活「${admittingCategory.labels["zh-CN"]}」为正式可售品类`} run={async f=>{
              await request("/staff/admin/categories/"+admittingCategory.id+"/status","POST",{
                status:"ACTIVE",
                admission_snapshot:{
                  sop_ref:text(f,"sop_ref"),
                  pilot_evidence:text(f,"pilot_evidence"),
                  training_completed:true,
                  equipment_verified:true,
                },
              });
              setAdmittingCategory(null);
              reload();
            }}>
              <div className="fields">
                <Field name="sop_ref" label="仓库标准作业 SOP 编号（必填，如 SOP-BAGS-2026-V1）" value={admittingCategory.admission_snapshot?.sop_ref??`SOP-${String(admittingCategory.slug).toUpperCase()}-2026-V1`}/>
                <Field name="pilot_evidence" label="影子模板与实样试运行验证记录（必填）" value={admittingCategory.admission_snapshot?.pilot_evidence??"已完成影子模板全流程检验、拍照机位与报告渲染验证"}/>
              </div>
            </Form>
          </Panel>
        )}

        <Panel title="品类准入管控" subtitle="仅已完成 SOP 与质检设备验证的品类可设为正式可售（服装 Apparel 为首发运营品类）；暂停类目不会影响已建在途订单。">
          <Table
            headers={["类目编码","中文名称","英文名称","准入状态","SOP 与试运行准入材料","关联已发布模板数","准入操作"]}
            rows={(data.categories??[]).map((c:Row)=>{
              const publishedTplCount = (data.templates??[]).filter((t:Row)=>t.category_id===c.id && t.state==="PUBLISHED").length;
              return [
                <span key="sl" className="code"><strong>{c.slug}</strong></span>,
                c.labels["zh-CN"],
                c.labels.en,
                <BizTag key="st" dict={CATEGORY_STATUS_ZH} value={c.status}/>,
                c.admission_snapshot
                  ? <div key="adm" className="cell-stack">
                      <span>SOP: <code className="code">{c.admission_snapshot.sop_ref??(c.admission_snapshot.demo?"演示夹具":"已登记")}</code></span>
                      {c.admission_snapshot.pilot_evidence&&<small className="muted">{c.admission_snapshot.pilot_evidence}</small>}
                    </div>
                  : <span key="adm" className="muted">尚未登记准入材料</span>,
                <span key="tc" className="nowrap">{publishedTplCount} 个已发布模板</span>,
                <div key="ops" className="row flexwrap" style={{gap:6}}>
                  <button type="button" className="button sm" onClick={()=>setTranslatingCategory(translatingCategory?.id===c.id?null:c)}>
                    {translatingCategory?.id===c.id?"收起双语":"双语译文"}
                  </button>
                  {superAdmin&&c.status!=="ACTIVE"?(
                    <button key="act" type="button" className="button sm primary nowrap" onClick={()=>setAdmittingCategory(c)}>
                      填写准入并激活 →
                    </button>
                  ):superAdmin&&c.status==="ACTIVE"?(
                    <Action key="pa" sm run={async()=>{
                      if(!window.confirm(`确认暂停「${c.labels["zh-CN"]}」对外新建订单？已创建的在途订单仍正常履约。`)) return;
                      await request("/staff/admin/categories/"+c.id+"/status","POST",{status:"PAUSED"});reload();
                    }}>暂停可售</Action>
                  ):null}
                </div>,
              ];
            })}
            empty="暂无类目记录。"
          />
          {canAuthorTemplate&&<>
            <hr className="divider"/>
            <Form inline label="新建规划类目（初始草稿状态，不直接开放售卖）" run={async f=>{
              await request("/staff/admin/categories","POST",{slug:text(f,"slug"),labels:{en:text(f,"en"),"zh-CN":text(f,"zh")}});reload();
            }}><Field name="slug" label="类目编码"/><Field name="zh" label="中文名称"/><Field name="en" label="英文名称"/></Form>
          </>}
        </Panel>
        {(translatingCategory??(data.categories??[])[0])&&(
          <BilingualEntityPanel
            key={String((translatingCategory??(data.categories??[])[0]).id)}
            entityType="category"
            entityId={String((translatingCategory??(data.categories??[])[0]).id)}
            entityLabel={`类目：${String((translatingCategory??(data.categories??[])[0]).labels?.["zh-CN"]??(translatingCategory??(data.categories??[])[0]).slug)}`}
            actor={actor}
            fields={[
              {
                field_key: "display_name",
                label: "类目名称 (Display Name)",
                source_text: String((translatingCategory??(data.categories??[])[0]).labels?.["zh-CN"]??""),
                source_revision: 1,
              },
              {
                field_key: "scope_note",
                label: "准入与适用范围说明",
                source_text: String((translatingCategory??(data.categories??[])[0]).admission_snapshot?.pilot_evidence??"仅在 SOP 与质检模板审核后开放接单"),
                source_revision: 1,
              },
            ]}
          />
        )}
      </>}

      {catalogTab==="offers"&&superAdmin&&<Panel title="可售套餐 SKU 与版本价格" subtitle="调价将签发新价格版本；客户已创建/已确认订单永久保留下单当时的价格快照。">
        <Table
          headers={["SKU 编码","套餐名称","价格版本","当前单价 / 整包价","数量区间与交期","生效时间","状态","操作"]}
          rows={(data.offers??[]).map((o:Row)=>[
            <strong key="s" className="code">{o.sku_code}</strong>,
            <div key="t" className="cell-stack">
              <strong>{o.title?.["zh-CN"]??o.sku_code}</strong>
              <small className="muted">{o.title?.en??""}</small>
            </div>,
            <span key="pv" className="code nowrap">{o.price_version?`v${o.price_version}`:"—"}</span>,
            o.rules?<div key="pr" className="cell-stack"><Money cents={o.rules.package_cents??o.rules.unit_cents} align="left"/><small className="muted">{o.rules.package_cents!=null?"整包一口价":"按件单价"}</small></div>:"—",
            o.rules?<span key="rg" className="nowrap">{o.rules.minimum}–{o.rules.maximum} 件 · {o.rules.business_days} 工作日</span>:"—",
            o.effective_from?stamp(o.effective_from,true):"—",
            <Tag key="en" tone={o.enabled?"green":"gray"}>{o.enabled?"可售":"已停用"}</Tag>,
            <Action key="op" sm run={async()=>{
              await request("/staff/admin/skus/"+o.sku_code+"/status","POST",{enabled:!o.enabled});
              reload();
            }}>{o.enabled?"停用可售":"恢复可售"}</Action>,
          ])}
          empty="暂无可售套餐。"
        />
        {!!(data.offers??[]).length&&<>
          <hr className="divider"/>
          <Form inline label="签发新价格版本" run={async f=>{
            const sku=text(f,"sku"),offer=(data.offers??[]).find((o:Row)=>o.sku_code===sku);
            const cents=Math.round(Number(text(f,"price"))*100),days=Number(text(f,"days"));
            const isPackage=offer?.rules?.package_cents!=null;
            await request("/staff/admin/skus/"+sku+"/prices","POST",{rules:{
              minimum:offer?.rules?.minimum??1,maximum:offer?.rules?.maximum??100,
              ...(isPackage?{package_cents:cents}:{unit_cents:cents}),business_days:days,
            }});reload();
          }}>
            <Select name="sku" label="套餐 SKU" choices={(data.offers??[]).map((o:Row)=>({id:o.sku_code,label:o.sku_code}))}/>
            <Field name="price" label="新价格（USD）" type="number" min={.01} step=".01"/>
            <Field name="days" label="承诺工作日" type="number" min={1} max={180} value={3}/>
          </Form>
        </>}
        {(data.templates??[]).some((t:Row)=>t.state==="PUBLISHED")&&<details className="card" style={{marginTop:14}}>
          <summary>新建或绑定可售套餐 SKU（关联已发布模板）</summary>
          <p className="small muted">新准入品类完成能力审批与模板发布后，可在此直接创建可售套餐并生效上架，无需改动通用业务代码。</p>
          <Form label="创建并发布套餐 SKU" run={async f=>{
            const tplId=text(f,"template_version_id");
            const tpl=(data.templates??[]).find((t:Row)=>t.id===tplId);
            if(!tpl) throw new Error("请选择已发布的检验模板版本。");
            const cents=Math.round(Number(text(f,"price"))*100);
            const isPkg=text(f,"pricing_mode")==="package";
            await request("/staff/admin/offers","POST",{
              sku_code:text(f,"sku_code").toLowerCase(),
              category_id:tpl.category_id,
              service_type_id:tpl.service_type_id,
              template_version_id:tpl.id,
              title:{en:text(f,"title_en"),"zh-CN":text(f,"title_zh")},
              enabled:true,
              rules:{
                minimum:Number(text(f,"minimum")),
                maximum:Number(text(f,"maximum")),
                ...(isPkg?{package_cents:cents}:{unit_cents:cents}),
                business_days:Number(text(f,"days")),
              },
            });
            reload();
          }}>
            <Select name="template_version_id" label="绑定已发布检验模板" choices={(data.templates??[]).filter((t:Row)=>t.state==="PUBLISHED").map((t:Row)=>{
              const cat=(data.categories??[]).find((c:Row)=>c.id===t.category_id);
              const svc=(data.services??[]).find((s:Row)=>s.id===t.service_type_id);
              return {id:t.id,label:`${cat?.labels?.["zh-CN"]??cat?.slug??"类目"} · ${svc?.labels?.["zh-CN"]??svc?.code??"服务"} · ${t.template_key} v${t.version}`};
            })}/>
            <div className="inline-form">
              <Field name="sku_code" label="SKU 编码（小写字母/数字/连字符）"/>
              <Field name="title_zh" label="套餐中文名称"/>
              <Field name="title_en" label="套餐英文名称"/>
            </div>
            <div className="inline-form">
              <Select name="pricing_mode" label="计价方式" choices={[{id:"unit",label:"按件计价 (unit_cents)"},{id:"package",label:"整包一口价 (package_cents)"}]}/>
              <Field name="minimum" label="最少件数" type="number" min={1} max={100} value={1}/>
              <Field name="maximum" label="最多件数" type="number" min={1} max={100} value={50}/>
              <Field name="price" label="单价 / 包价（USD）" type="number" min={.01} step=".01" value={15}/>
              <Field name="days" label="承诺工作日" type="number" min={1} max={180} value={3}/>
            </div>
          </Form>
        </details>}
      </Panel>}
    </>}

    {(page==="templates"||page==="settings")&&<>
      {previewTemplate&&(
        <Panel
          id="template-detail-workbench"
          title={`检查模板全宽审阅与版本对比工作台 · ${previewTemplate.template_key} v${previewTemplate.version}`}
          subtitle={`适用类目：${previewTemplate.category_label??"—"} · 服务类型：${previewTemplate.service_label??"—"} · 绑定检验能力：${(previewTemplate.capability_codes??[]).join("、")||"无"} · 已关联订单：${previewTemplate.order_count??0} 单`}
          badge={<button type="button" className="button sm" onClick={()=>setPreviewTemplate(null)}>收起模板审阅 ✕</button>}
        >
          <div className="row between flexwrap" style={{marginBottom:12,gap:10}}>
            <div className="actions">
              <BizTag dict={TEMPLATE_STATE_ZH} value={previewTemplate.state}/>
              <span className="small muted">作者：{previewTemplate.author_name??"系统预置"} · 审核人：{previewTemplate.reviewer_name??(previewTemplate.state==="PUBLISHED"?"已审核":"待独立复核")}</span>
              <CopyId value={previewTemplate.id}/>
              {previewTemplate.state==="IN_REVIEW"&&canReviewTemplate&&previewTemplate.author_id!==actor.id&&<Action sm primary run={async()=>{
                await request("/staff/admin/templates/"+previewTemplate.id+"/publish","POST",{});
                setPreviewTemplate(null);
                reload();
              }}>确认全部字段无误并独立发布</Action>}
            </div>
            {sameKeyTemplates.length>0&&(
              <label className="row" style={{gap:6,fontSize:12.5}}>
                <span>对比同模板其他版本：</span>
                <select value={compareTarget?.id??""} onChange={e=>setCompareTemplateId(e.target.value)}>
                  {sameKeyTemplates.map((st:Row)=><option key={st.id} value={st.id}>v{st.version} ({TEMPLATE_STATE_ZH[st.state]?.label??st.state})</option>)}
                </select>
              </label>
            )}
          </div>

          {previewTemplate.content?.measure_conditions&&(
            <div className="notice" style={{marginBottom:14}}>
              <strong>锁定测量环境与工器具条件：</strong> {previewTemplate.content.measure_conditions}
            </div>
          )}

          {compareTarget&&(
            <div className="card-soft" style={{marginBottom:14}}>
              <strong>版本差异摘要（当前 v{previewTemplate.version} vs 对照 v{compareTarget.version}）：</strong>
              <p className="small muted" style={{margin:"4px 0 0"}}>
                检查项数量：v{previewTemplate.version} 共 {(previewTemplate.content?.checks??[]).length} 项 vs v{compareTarget.version} 共 {(compareTarget.content?.checks??[]).length} 项；
                必拍机位：v{previewTemplate.version} 共 {(previewTemplate.content?.shots??[]).length} 个 vs v{compareTarget.version} 共 {(compareTarget.content?.shots??[]).length} 个。
              </p>
            </div>
          )}

          <div className="ops-columns">
            <div style={{gridColumn:"1 / -1"}}>
              <h3 style={{marginTop:0}}>受控检查字段明细 ({(previewTemplate.content?.checks??[]).length} 项)</h3>
              <Table
                headers={["字段键 (Key)","中文检查项名称","英文报告标签 (Report Label)","值类型 / 单位","标准测量与检验方法","必检属性","强制拍照","版本变更"]}
                rows={(previewTemplate.content?.checks??[]).map((c:Row)=>{
                  const prevCheck=(compareTarget?.content?.checks??[]).find((x:Row)=>x.key===c.key);
                  const diffStatus=!compareTarget
                    ?"基准版本"
                    :!prevCheck
                      ?"新增字段"
                      :(prevCheck.method!==c.method||prevCheck.type!==c.type||prevCheck.required!==c.required||prevCheck.evidence!==c.evidence)
                        ?"规则已调整"
                        :"与对照版一致";
                  return [
                    <span key="k" className="code nowrap">{c.key}</span>,
                    <strong key="zh">{c.zh??c.label??"—"}</strong>,
                    c.label??"—",
                    <span key="t" className="nowrap">{c.type}{c.unit?` (${c.unit})`:""}</span>,
                    c.method??"—",
                    c.required?<Tag key="r" tone="blue">必检</Tag>:<Tag key="r" tone="gray">选检</Tag>,
                    c.evidence?<Tag key="e" tone="yellow">必拍证据图</Tag>:"按需拍照",
                    <Tag key="d" tone={diffStatus==="新增字段"?"green":diffStatus==="规则已调整"?"yellow":"gray"}>{diffStatus}</Tag>,
                  ];
                })}
                empty="未配置检查项。"
              />
            </div>
          </div>

          <div style={{marginTop:14}}>
            <h3>必拍标准证据机位 ({(previewTemplate.content?.shots??[]).length} 个)</h3>
            <Table
              headers={["机位编码","中文拍摄说明","英文报告标签","适用组件"]}
              rows={(previewTemplate.content?.shots??[]).map((s:Row)=>[
                <span key="k" className="code">{s.code}</span>,
                s.zh??"—",
                s.name??"—",
                s.component??"整件默认 (main)",
              ])}
              empty="未配置必拍机位。"
            />
          </div>

          <div style={{marginTop:14}}>
            <BilingualEntityPanel
              key={String(previewTemplate.id)}
              entityType="inspection_template"
              entityId={String(previewTemplate.id)}
              entityLabel={`检查模板：${String(previewTemplate.template_key)} v${previewTemplate.version}`}
              actor={actor}
              fields={[
                {
                  field_key: "measure_conditions",
                  label: "测量环境与工器具条件",
                  source_text: String(previewTemplate.content?.measure_conditions??""),
                  source_revision: Number(previewTemplate.version??1),
                },
                ...(previewTemplate.content?.checks??[]).slice(0,5).map((c:Row)=>({
                  field_key: `check_${String(c.key)}`,
                  label: `检查项：${String(c.zh??c.label??c.key)}`,
                  source_text: String(c.method??c.zh??""),
                  source_revision: Number(previewTemplate.version??1),
                })),
              ]}
            />
          </div>
        </Panel>
      )}

      <Panel title="检验能力准入与独立审批" subtitle="检查模板必须绑定已获独立批准的检验能力；能力创建人与审批人不得为同一人。">
        <Table headers={["能力编码","标准检验方法与工器具","审批状态","操作"]} rows={(data.allCapabilities??data.capabilities).map((cap:Row)=>[
          <span key="c" className="code">{cap.code}</span>,
          cap.method,
          <Tag key="st" tone={cap.revoked_at?"red":cap.approved_by?"green":"yellow"}>{cap.revoked_at?"已撤销":cap.approved_by?"已独立批准":"待独立审批"}</Tag>,
          !cap.revoked_at&&!cap.approved_by&&canReviewTemplate&&cap.approval?.author_id!==actor.id?
            <Action key="a" sm primary run={async()=>{await request("/staff/admin/capabilities/"+cap.id+"/approve","POST",{});reload();}}>独立批准能力</Action>:
          !cap.revoked_at&&cap.approved_by&&superAdmin?
            <Action key="r" sm run={async()=>{await request("/staff/admin/capabilities/"+cap.id+"/revoke","POST",{reason:"后台调整能力准入"});reload();}}>撤销能力</Action>:null,
        ])} empty="暂无检验能力记录。"/>
        {canAuthorTemplate&&<>
          <hr className="divider"/>
          <Form inline label="提交新增检验能力" run={async f=>{
            await request("/staff/admin/capabilities","POST",{code:text(f,"code"),method:text(f,"method")});reload();
          }}><Field name="code" label="能力编码"/><Field name="method" label="标准方法与工具说明"/></Form>
        </>}
      </Panel>
      <Panel title="模板版本仓库与独立审核发布" subtitle="点击「全宽审阅与对比」在上方展开完整检查项、测量条件及版本差异对比；已绑定订单锁定下单时的模板版本。">
        <Table headers={["模板键","版本","适用类目 / 服务","发布状态","关联能力","检查项 / 机位","作者 / 审核人","关联订单","操作"]} rows={(data.templates??[]).map((t:Row)=>{
          const isSelected = previewTemplate?.id === t.id;
          return [
            <strong key="k" className="code">{t.template_key}</strong>,
            <span key="v" className="code nowrap">v{t.version}</span>,
            <span key="cs">{t.category_label??"—"} · {t.service_label??"—"}</span>,
            <BizTag key="st" dict={TEMPLATE_STATE_ZH} value={t.state}/>,
            (t.capability_codes??[]).join(", ")||"—",
            t.content?.checks?`${t.content.checks.length} 项 / ${(t.content.shots??[]).length} 机位`:"—",
            <span key="au" className="small">{t.author_name??"系统"} / {t.reviewer_name??(t.state==="PUBLISHED"?"已审":"待审")}</span>,
            <span key="oc" className="nowrap"><strong>{t.order_count??0}</strong> 单</span>,
            <div key="op" className="actions">
              <button type="button" className={`button sm nowrap${isSelected?"":" primary"}`} onClick={()=>setPreviewTemplate(isSelected?null:t)}>
                {isSelected?"收起审阅":"全宽审阅与对比"}
              </button>
              {t.state==="IN_REVIEW"&&canReviewTemplate&&t.author_id!==actor.id&&
                <Action sm primary run={async()=>{await request("/staff/admin/templates/"+t.id+"/publish","POST",{});reload();}}>独立审核发布</Action>}
              {t.state==="IN_REVIEW"&&t.author_id===actor.id&&<small className="muted">须非作者独立复核</small>}
            </div>,
          ];
        })} empty="暂无模板版本。"/>
        {!!data.categories.length&&canAuthorTemplate&&<TemplateAuthorForm
          categories={data.categories}
          services={data.services}
          capabilities={data.capabilities}
          onSave={reload}
        />}
      </Panel>
    </>}

    {page==="shipping-rates"&&superAdmin&&<ShippingRateConfigPanel rates={data.shippingRates??[]} onSave={reload}/>}

    <StaffObjectDrawer target={drawer} actor={actor} onClose={()=>setDrawer(null)}/>
  </>;
}

const STAFF_ROLE_OPTIONS:[string,string,string][]=[
  ["receiver","收货员 (receiver)","扫描运单、包裹实收建档、拆包上架与实物识别"],
  ["inspector","检查员 (inspector)","领取质检任务、录入实测数据与上传机位证据照"],
  ["reviewer","独立复核员 (reviewer)","非本人报告复核批准、检查能力与模板独立审核"],
  ["warehouse_admin","仓管主管 (warehouse_admin)","库位管理、出库称重报价、打包交接与盘点复核"],
  ["support","客服专员 (support)","订单查询、工单回复、未匹配包裹认领与异常跟进"],
  ["finance","财务专员 (finance)","联合对账账本、退款核验与事故赔付打款核销"],
  ["template_admin","模板管理员 (template_admin)","规划品类、提交检验能力与编写品类检查模板"],
  ["super_admin","超级管理员 (super_admin)","全局配置、条款发布、价格上架、权限管控与双人终审"],
];

function QuotePolicyEditor({policy,onSave}:{policy?:Row;onSave:()=>void}) {
  const [saved,setSaved]=useState(false);
  if(!policy)return <p role="status">正在读取报价有效期…</p>;
  return <Panel title="报价有效期" subtitle="仅影响保存后新生成的报价；历史报价和已提交订单保留原截止时间。人工报价仍可单独指定截止时间。">
    <p className="muted">单位为分钟：60分钟=1小时，1440分钟=1天。保存需要最近10分钟内完成员工MFA。报价到期后原价失效，已打开的收银台同样需要关闭。</p>
    <Form key={policy.updated_at??"default"} label="保存报价有效期" run={async fields=>{
      setSaved(false);
      await request("/staff/admin/quote-policy","POST",{
        inspection_minutes:Number(text(fields,"inspection_minutes")),dispatch_minutes:Number(text(fields,"dispatch_minutes")),
        storage_minutes:Number(text(fields,"storage_minutes")),expected_updated_at:policy.updated_at,
      });setSaved(true);onSave();
    }}>
      <Field name="inspection_minutes" label="自动质检及范围补款报价（分钟）" type="number" min={30} max={43200} step={1} value={policy.inspection_minutes}/>
      <Field name="dispatch_minutes" label="发运报价（分钟）" type="number" min={30} max={43200} step={1} value={policy.dispatch_minutes}/>
      <Field name="storage_minutes" label="续存报价（分钟）" type="number" min={30} max={43200} step={1} value={policy.storage_minutes}/>
    </Form>
    {saved&&<p role="status">报价有效期已保存。已有报价未作修改。</p>}
  </Panel>;
}

function BusinessCalendarEditor({calendar,onSave}:{calendar?:Row;onSave:()=>void}) {
  const [holidays,setHolidays]=useState<string[]>(()=>[...(calendar?.holidays??[])].sort());
  const [workdays,setWorkdays]=useState<string[]>(()=>[...(calendar?.extra_workdays??[])].sort());
  const [pickHoliday,setPickHoliday]=useState("");
  const [pickWorkday,setPickWorkday]=useState("");
  useEffect(()=>{
    setHolidays([...(calendar?.holidays??[])].sort());
    setWorkdays([...(calendar?.extra_workdays??[])].sort());
  },[calendar]);
  const addDate=(list:string[],setter:(v:string[])=>void,ymd:string)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || list.includes(ymd)) return;
    setter([...list,ymd].sort());
  };
  return <Panel title="工作日历与节假日配置" subtitle="通过日历点选添加或移除日期，SLA 承诺工作日自动跳过法定节假日并计入调休补班日。">
    <div className="ops-columns">
      <div className="card" style={{margin:0}}>
        <h3 style={{marginTop:0}}>法定节假日 ({holidays.length})</h3>
        <div className="inline-form">
          <div style={{flex:"1 1 200px"}}>
            <DateInput name="pick_holiday" onValueChange={setPickHoliday}/>
          </div>
          <button type="button" className="button sm" disabled={!pickHoliday} onClick={()=>addDate(holidays,setHolidays,pickHoliday)}>+ 添加节假日</button>
        </div>
        <div className="date-chips">
          {holidays.length?holidays.map(d=><span key={d} className="date-chip">{d}<button type="button" aria-label={`移除 ${d}`} onClick={()=>setHolidays(holidays.filter(x=>x!==d))}>×</button></span>):<span className="muted small">暂未配置节假日</span>}
        </div>
      </div>
      <div className="card" style={{margin:0}}>
        <h3 style={{marginTop:0}}>调休补班工作日 ({workdays.length})</h3>
        <div className="inline-form">
          <div style={{flex:"1 1 200px"}}>
            <DateInput name="pick_workday" onValueChange={setPickWorkday}/>
          </div>
          <button type="button" className="button sm" disabled={!pickWorkday} onClick={()=>addDate(workdays,setWorkdays,pickWorkday)}>+ 添加补班日</button>
        </div>
        <div className="date-chips">
          {workdays.length?workdays.map(d=><span key={d} className="date-chip">{d}<button type="button" aria-label={`移除 ${d}`} onClick={()=>setWorkdays(workdays.filter(x=>x!==d))}>×</button></span>):<span className="muted small">暂未配置调休补班日</span>}
        </div>
      </div>
    </div>
    <div className="actions" style={{marginTop:12}}>
      <Action primary run={async()=>{
        await request("/staff/admin/calendar","POST",{holidays,extra_workdays:workdays});
        onSave();
      }}>保存工作日历配置</Action>
    </div>
  </Panel>;
}

function StaffAndCustomerUsersDesk({
  staffUsers,customerCount,actor,onSave,
}:{
  staffUsers:Row[];customerCount:number;actor:Row;onSave:()=>void;
}) {
  const [editingStaff,setEditingStaff]=useState<Row|null>(null);
  const [selectedRoles,setSelectedRoles]=useState<string[]>([]);
  const openStaffEditor=(u:Row)=>{
    setSelectedRoles([...(u.roles??[])]);
    setEditingStaff(u);
  };
  return <>
    <StatusBanner tone="info" title={`客户 360 档案目录与账号管控（累计注册客户 ${customerCount} 户）`}>
      按永久收件码 <span className="code">QCW-...</span> 检索客户、排查归属与收支往来、或管控账号风控状态，请进入专用客户工作台。<Link className="button sm primary" href="/admin/customers">前往客户档案目录 →</Link>
    </StatusBanner>
    <Panel title="内部员工账号与 RBAC 角色列表" subtitle="点击「配置角色权限」通过多选卡片调整岗位权限；变更角色或停用账号均记录审计原因并即时生效。">
      <Table headers={["员工账号","账号状态","已分配岗位角色","权限与账号管控"]} rows={staffUsers.map((u:Row)=>[
        <div key={u.id} className="cell-stack">
          <strong>{u.display_name??u.id.slice(0,8)}</strong>
          <small className="code">{u.email??"—"}</small>
        </div>,
        <Tag key="st" tone={u.status==="disabled"?"red":"green"}>{u.status==="disabled"?"已停用":"正常在岗"}</Tag>,
        <div key="roles" className="actions">
          {(u.roles??[]).length?(u.roles as string[]).map(r=><Tag key={r} tone="blue">{ROLE_ZH[r]??r}</Tag>):<span className="muted">未分配角色</span>}
        </div>,
        <div key="ops" className="actions">
          <button type="button" className="button sm primary" onClick={()=>openStaffEditor(u)}>配置角色权限</button>
          {u.id!==actor.id&&<Action sm run={async()=>{
            const nextStatus=u.status==="disabled"?"active":"disabled";
            await request("/staff/users/"+u.id+"/status","POST",{status:nextStatus,reason:nextStatus==="disabled"?"后台停用员工账号":"后台恢复员工账号"});
            onSave();
          }}>{u.status==="disabled"?"恢复账号":"停用账号"}</Action>}
        </div>,
      ])} empty="暂无员工账号。"/>
    </Panel>
    <Panel title="各岗位业务模块访问与隐私隔离边界矩阵" subtitle="所有权限以服务端角色校验为准；非超管角色访问客户邮箱自动脱敏，非财务角色隐藏实付与赔付金额。">
      <Table headers={["岗位名称","可进入工作台","核心可执行业务能力","禁止越权与脱敏边界"]} rows={[
        ["收货与库管员 (receiver)","仓库台 + 物流监控","扫码实收包裹、拆包生成实物条码、绑定订单预期行、SKU 核身、库位移转、盘点录入","不可进入财务/退款/模板发布；客户完整邮箱不可见"],
        ["现场质检员 (inspector)","仓库检查执行台","领取待检任务、录入多次实测数据与异常取证照、上传必拍机位照、提交检查任务","严禁批准本人或他人报告 (QA 复核)；不可修改订单状态或财务数据"],
        ["独立 QA 复核员 (reviewer)","仓库报告复核台","校对报告英文表述与瑕疵标注、独立批准或退回非本人报告、独立审批检验能力与模板","严禁批准本人提交的报告或本人编写的模板；不可执行退款或收货"],
        ["仓库主管 (warehouse_admin)","仓库全模块 + 物流","出库批次称重与运费报价、打包与承运商交接、盘点差异独立复核、运单号纠偏","不可执行退款终审或修改系统级条款与员工角色"],
        ["客服与运营专员 (support)","管理后台 (订单/客户/工单/物流)","订单全链路追踪、人工报价核定、无主包裹认领核验、工单回复与转派、质检只读监督","客户邮箱脱敏显示 (如 c***@...)；财务实付/赔付金额隐藏；不可现场录入质检数据"],
        ["财务专员 (finance)","管理后台 (财务/支付/退款/客户)","支付流水与渠道对账、争议冻结解冻、事故赔付方案审批与打款水单核销、导出账本 CSV","客户邮箱脱敏显示；不可操作仓库收货、质检录入或修改系统配置"],
        ["模板管理员 (template_admin)","管理后台 (仓址及模板)","新建规划类目、提交新增检验能力、编写品类检查模板版本提交审核","严禁自行批准本人提交的检验能力或模板版本 (须独立 reviewer/super_admin 审核)"],
        ["超级管理员 (super_admin)","管理后台 + 仓库台全模块","全局配置、法务条款发布、可售套餐定价、员工角色授权、非本人退款/处置/事故终审","同样受双人职责分离 (SoD) 约束：本人发起的退款、事故方案、处置单或模板不可自审"],
      ]}/>
    </Panel>
    <Panel title="平台核心职责分离 (SoD) 守卫矩阵">
      <Table headers={["敏感业务操作","授权角色","强制服务端守卫"]} rows={[
        ["报告录入与独立复核","检查员 / 独立复核员","检查员不得批准本人生成的检查报告，且须逐项覆盖图片/测量字段"],
        ["退款独立审批与驳回","超级管理员（第二人）","申请人不得审批本人发起的退款，须 15 分钟内员工 MFA 确认"],
        ["价格与检查模板发布","模板管理员 + 独立审核人","非作者独立审阅全部字段后方可发布；已确认订单永久保留快照"],
        ["逾期/违禁件双人处置","仓管提交 + 另一管理员复核","执行须受控开关开启且保留通知与毁弃见证记录"],
        ["物流密钥与接口管理","超级管理员","供应商密钥仅在服务端环境变量加密加载"],
      ]}/>
    </Panel>
    <ModalDrawer
      open={Boolean(editingStaff)}
      onClose={()=>setEditingStaff(null)}
      title={editingStaff?`配置员工角色权限 · ${editingStaff.display_name??editingStaff.email}`:""}
      subtitle="勾选该员工需承担的岗位角色（至少保留 1 项或停用账号），保存后立即更新服务端权限。"
    >
      {editingStaff&&<Form label="保存角色权限变更" run={async f=>{
        if(!selectedRoles.length) throw new Error("请至少勾选一个员工角色，或直接停用该账号。");
        await request("/staff/users/"+editingStaff.id+"/roles","POST",{
          roles:selectedRoles,
          reason:text(f,"reason"),
        });
        setEditingStaff(null);
        onSave();
      }}>
        <div className="role-grid">
          {STAFF_ROLE_OPTIONS.map(([code,title,desc])=><label key={code} className="role-chip">
            <input
              type="checkbox"
              checked={selectedRoles.includes(code)}
              onChange={e=>setSelectedRoles(prev=>e.target.checked?[...prev,code]:prev.filter(x=>x!==code))}
            />
            <div>
              <div>{title}</div>
              <small>{desc}</small>
            </div>
          </label>)}
        </div>
        <Field name="reason" label="权限变更原因（审计必填）" value="岗位职责调整"/>
      </Form>}
    </ModalDrawer>
  </>;
}

function TemplateAuthorForm({
  categories,services,capabilities,onSave,
}:{
  categories:Row[];services:Row[];capabilities:Row[];onSave:()=>void;
}) {
  const [editorMode,setEditorMode]=useState<"visual"|"json">("visual");
  const [selectedCaps,setSelectedCaps]=useState<string[]>(()=>capabilities[0]?.id?[capabilities[0].id]:[]);
  const [checks,setChecks]=useState<Row[]>([
    {key:"overall_appearance",label:"Overall appearance",zh:"整体外观",type:"string",unit:"",method:"Visual inspection",required:true,evidence:false},
    {key:"length_cm",label:"Length",zh:"长度",type:"number",unit:"cm",method:"Calibrated tape",required:true,evidence:true},
  ]);
  const [shots,setShots]=useState<Row[]>([
    {code:"front",name:"Front overview",zh:"正面全貌"},
    {code:"label",name:"Brand / care label",zh:"品牌与洗水标"},
  ]);
  const [measureCond,setMeasureCond]=useState("自然平铺无拉伸，使用校准卷尺测量。");
  const [rawJson,setRawJson]=useState("");
  const buildJsonObj=()=>({
    measure_conditions:measureCond,
    checks:checks.map(c=>({
      key:c.key,label:c.label,zh:c.zh,type:c.type,
      ...(c.unit?{unit:c.unit}:{}),
      method:c.method,required:Boolean(c.required),evidence:Boolean(c.evidence),
    })),
    shots:shots.filter(s=>s.code.trim()).map(s=>({code:s.code.trim(),name:s.name.trim()||s.code.trim(),zh:s.zh.trim()||s.code.trim()})),
  });
  const switchMode=(next:"visual"|"json")=>{
    if(next==="json") {
      setRawJson(JSON.stringify(buildJsonObj(),null,2));
    } else if(rawJson.trim()) {
      try {
        const parsed=JSON.parse(rawJson);
        if(Array.isArray(parsed.checks)) setChecks(parsed.checks);
        if(Array.isArray(parsed.shots)) setShots(parsed.shots);
        if(typeof parsed.measure_conditions==="string") setMeasureCond(parsed.measure_conditions);
      } catch {}
    }
    setEditorMode(next);
  };
  return <div className="card" style={{marginTop:14}}>
    <div className="row" style={{marginBottom:10}}>
      <h3 style={{margin:0}}>编写并提交新模板版本</h3>
      <div className="actions">
        <button type="button" className={"button sm"+(editorMode==="visual"?" primary":"")} onClick={()=>switchMode("visual")}>可视化构建器</button>
        <button type="button" className={"button sm"+(editorMode==="json"?" primary":"")} onClick={()=>switchMode("json")}>高级 JSON 模式</button>
      </div>
    </div>
    <Form label="提交模板至独立审核" run={async f=>{
      if(!selectedCaps.length) throw new Error("请至少勾选一项已批准的检验能力。");
      const content=editorMode==="json"?JSON.parse(text(f,"content")):buildJsonObj();
      await request("/staff/admin/templates","POST",{
        template_key:text(f,"key"),
        category_id:text(f,"category"),
        service_type_id:text(f,"service"),
        capability_ids:selectedCaps,
        content,
      });
      onSave();
    }}>
      <div className="fields three">
        <Field name="key" label="模板键 (如 bags-std)"/>
        <Select name="category" label="适用类目" choices={categories.map((c:Row)=>({id:c.id,label:c.labels["zh-CN"]}))}/>
        <Select name="service" label="服务类型" choices={services.map((x:Row)=>({id:x.id,label:x.labels["zh-CN"]}))}/>
      </div>
      <div>
        <span style={{fontWeight:650,fontSize:12.5,display:"block",marginBottom:6}}>绑定获批检验能力（支持多选）</span>
        <div className="role-grid">
          {capabilities.map((cap:Row)=><label key={cap.id} className="role-chip">
            <input
              type="checkbox"
              checked={selectedCaps.includes(cap.id)}
              onChange={e=>setSelectedCaps(prev=>e.target.checked?[...prev,cap.id]:prev.filter(x=>x!==cap.id))}
            />
            <div>
              <div className="code">{cap.code}</div>
              <small>{cap.method}</small>
            </div>
          </label>)}
        </div>
      </div>
      {editorMode==="visual"?<>
        <label>测量与拍摄环境说明
          <input value={measureCond} onChange={e=>setMeasureCond(e.target.value)}/>
        </label>
        <div>
          <div className="row" style={{marginBottom:6}}>
            <strong>检查项列表 ({checks.length})</strong>
            <button type="button" className="button sm" onClick={()=>setChecks([...checks,{key:`check_${checks.length+1}`,label:"New check",zh:"新增检查项",type:"string",unit:"",method:"Visual",required:true,evidence:false}])}>+ 新增检查项</button>
          </div>
          {checks.map((ck,idx)=><div key={idx} className="card" style={{padding:10,marginBottom:8}}>
            <div className="fields three">
              <label>字段键 (key)<input value={ck.key} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,key:e.target.value}:x))} required/></label>
              <label>中文名称<input value={ck.zh??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,zh:e.target.value}:x))} required/></label>
              <label>英文标签 (Report Label)<input value={ck.label??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,label:e.target.value}:x))} required/></label>
            </div>
            <div className="fields three" style={{marginTop:8}}>
              <label>值类型
                <select value={ck.type??"string"} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,type:e.target.value}:x))}>
                  <option value="string">文本观察 (string)</option>
                  <option value="number">数值测量 (number)</option>
                  <option value="boolean">布尔判断 (boolean)</option>
                </select>
              </label>
              <label>单位（数值选填，如 cm / g）<input value={ck.unit??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,unit:e.target.value}:x))}/></label>
              <label>检验方法/工具<input value={ck.method??""} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,method:e.target.value}:x))} required/></label>
            </div>
            <div className="row" style={{marginTop:8}}>
              <div className="actions">
                <label className="check"><input type="checkbox" checked={Boolean(ck.required)} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,required:e.target.checked}:x))}/> 必检项</label>
                <label className="check"><input type="checkbox" checked={Boolean(ck.evidence)} onChange={e=>setChecks(checks.map((x,i)=>i===idx?{...x,evidence:e.target.checked}:x))}/> 强制拍照取证</label>
              </div>
              {checks.length>1&&<button type="button" className="button sm" onClick={()=>setChecks(checks.filter((_,i)=>i!==idx))}>移除此项</button>}
            </div>
          </div>)}
        </div>
        <div>
          <div className="row" style={{marginBottom:6}}>
            <strong>组件必拍机位 ({shots.length})</strong>
            <button type="button" className="button sm" onClick={()=>setShots([...shots,{code:`shot_${shots.length+1}`,name:"Detail view",zh:"细节机位"}])}>+ 新增必拍机位</button>
          </div>
          {shots.map((sh,idx)=><div key={idx} className="inline-form" style={{marginBottom:6}}>
            <label>机位编码<input value={sh.code} onChange={e=>setShots(shots.map((x,i)=>i===idx?{...x,code:e.target.value}:x))} required/></label>
            <label>中文名称<input value={sh.zh??""} onChange={e=>setShots(shots.map((x,i)=>i===idx?{...x,zh:e.target.value}:x))} required/></label>
            <label>英文名称<input value={sh.name??""} onChange={e=>setShots(shots.map((x,i)=>i===idx?{...x,name:e.target.value}:x))} required/></label>
            {shots.length>1&&<button type="button" className="button sm" onClick={()=>setShots(shots.filter((_,i)=>i!==idx))}>移除</button>}
          </div>)}
        </div>
      </>:<label>模板结构 JSON<textarea name="content" rows={10} value={rawJson} onChange={e=>setRawJson(e.target.value)} required/></label>}
    </Form>
  </div>;
}

function ShippingRateConfigPanel({rates,onSave}:{rates:Row[];onSave:()=>void}) {
  const [preview,setPreview]=useState<Row>();
  const latestRate=rates[0];
  return <>
    <Panel title="01 / 国内运费费率版本管理" subtitle="所有已签发的出库运费报价永久锁定签发时的费率版本；发布新版本仅对后续新称重报价生效。">
      {latestRate&&(
        <div className="metric-strip" style={{marginBottom:14}} aria-label="当前生效运费版本摘要">
          <div className="metric"><span>当前生效版本</span><strong>v{latestRate.version}</strong><small>生效于 {stamp(latestRate.effective_at??latestRate.published_at,true)}</small></div>
          <div className="metric"><span>首重标准 ({latestRate.rules?.first_weight_g??1000} g)</span><strong><Money cents={latestRate.rules?.first_cents??0} align="left"/></strong><small>单个包裹基础首重费</small></div>
          <div className="metric"><span>续重阶梯 (每 {latestRate.rules?.extra_step_g??500} g)</span><strong><Money cents={latestRate.rules?.extra_cents??0} align="left"/></strong><small>超出首重后向上取整计费</small></div>
          <div className="metric"><span>每批次打包操作费</span><strong><Money cents={latestRate.rules?.handling_cents??0} align="left"/></strong><small>按出库批次固定收取一次</small></div>
        </div>
      )}
      <Table headers={["费率版本","状态","首重上限 (g)","首重费 (USD)","续重步长 (g)","续重单价 (USD)","每批操作费 (USD)","发布生效时间"]} rows={rates.map((r:Row,idx:number)=>[
        <strong key="v" className="code">v{r.version}</strong>,
        idx===0?<Tag key="st" tone="green">当前生效版本</Tag>:<Tag key="st" tone="gray">历史锁定版本</Tag>,
        <span key="fw" className="nowrap">{r.rules?.first_weight_g??1000} g</span>,
        <Money key="fc" cents={r.rules?.first_cents??0}/>,
        <span key="es" className="nowrap">{r.rules?.extra_step_g??500} g</span>,
        <Money key="ec" cents={r.rules?.extra_cents??0}/>,
        <Money key="hc" cents={r.rules?.handling_cents??0}/>,
        stamp(r.effective_at??r.published_at),
      ])} empty="暂无运价版本。"/>
      <hr className="divider"/>
      <h3 style={{marginTop:0}}>发布新国内运费阶梯版本</h3>
      <Form label="正式发布新运价版本" run={async f=>{
        await request("/staff/admin/shipping-rates","POST",{
          first_weight_g:Number(text(f,"first_weight_g")),
          first_cents:Math.round(Number(text(f,"first_usd"))*100),
          extra_step_g:Number(text(f,"step_g")),
          extra_cents:Math.round(Number(text(f,"step_usd"))*100),
          handling_cents:Math.round(Number(text(f,"handling_usd"))*100),
        });
        onSave();
      }}>
        <div className="inline-form">
          <Field name="first_weight_g" label="首重克重 (g)" type="number" min={1} value={1000}/>
          <Field name="first_usd" label="首重费用 (USD)" type="number" min={0} step=".01" value={8}/>
          <Field name="step_g" label="续重步长 (g)" type="number" min={1} value={500}/>
          <Field name="step_usd" label="续重单价 (USD)" type="number" min={0} step=".01" value={2}/>
          <Field name="handling_usd" label="每批操作费 (USD)" type="number" min={0} step=".01" value={1}/>
        </div>
      </Form>
    </Panel>

    <Panel title="02 / 独立多包裹运费试算器" subtitle="仅用于运营或客服试算单票/多包裹合批出库运费，不会修改或发布任何线上费率版本。">
      <Form inline label="执行运费试算" run={async f=>{
        const weights=text(f,"weights").split(",").map(s=>Number(s.trim())).filter(n=>n>0);
        if(!weights.length) throw new Error("请输入至少一个大于 0 的包裹克重。");
        const res=await request("/staff/admin/shipping-rates/calculate","POST",{
          ...(text(f,"rate_version_id")?{rate_version_id:text(f,"rate_version_id")}:{}),
          parcels:weights.map(weight_g=>({weight_g})),
        });
        setPreview(res);
      }}>
        <Select name="rate_version_id" label="选用试算费率版本（默认最新生效版本）" required={false}
          choices={rates.map(r=>({id:r.id,label:`v${r.version}（首重 $${((r.rules?.first_cents??0)/100).toFixed(2)} / ${r.rules?.first_weight_g??1000}g）`}))}/>
        <Field name="weights" label="包裹重量列表（单位：克，多包裹用逗号分隔，如 800, 1350）" value="1200"/>
      </Form>
      {preview&&<div className="card-soft" style={{marginTop:14}} role="status">
        <div className="row between" style={{marginBottom:8}}>
          <strong>试算结果明细 · 适用费率版本 v{preview.version}</strong>
          <span className="actions"><strong>应收运费总计：</strong><Money cents={preview.total_cents}/></span>
        </div>
        <Table
          headers={["计费项","实测克重","费用金额 (USD)"]}
          rows={[
            ...(preview.parcels??[]).map((p:Row,idx:number)=>[
              `出库包裹 #${idx+1}`,`${p.weight_g} g`,<Money key={`p-${idx}`} cents={p.amount_cents}/>,
            ]),
            ["批次打包与面单操作费","按批次固定计收",<Money key="h" cents={preview.handling_cents??0}/>],
          ]}
        />
      </div>}
    </Panel>
  </>;
}

const ZONE_ZH:Record<string,string>={receiving:"收货区",queue:"待检区",inspecting:"检查区",post_inspection:"检后区",storage:"在库保管区",quarantine:"隔离区",unmatched:"未认领区",reference:"确认样专柜 (REF_SAFE)"};
const SCAN_ACTION_ZH:Record<string,string>={
  open_package:"打开包裹工作台",unpack_items:"拆包建档",print_label:"打印标签",
  open_item:"打开样品详情",move_storage:"移转库位",assign_order_position:"绑定委托位置",
  open_inspection_task:"打开质检任务",open_order:"打开订单详情",open_customer:"打开客户档案",
  open_storage:"前往库位移转",start_stocktake:"发起库区盘点",view_location:"仅查看库位明细",
  open_dispatch_batch:"打开出库批次",open_logistics:"查看物流监控",select_carrier:"选择承运商重查",
  check_in:"前往收货实收",
};
export function WarehouseScan({actor}:{actor?:Row}={}) {
  const [match,setMatch]=useState<{title:string;detail:string;link?:string|null;action?:string;allowed?:string[];raw?:Row}>();
  const [scanText,setScanText]=useState("");
  const [scanCarrier,setScanCarrier]=useState("");
  const [scanErr,setScanErr]=useState("");
  const [cameraNotice,setCameraNotice]=useState<string>();
  const scanInputRef=useRef<HTMLInputElement>(null);
  const carriers=useLoad("/carriers");
  const roles:string[]=actor?.roles??[];
  const canIntakeWrite=roles.some(r=>["receiver","warehouse_admin"].includes(r));
  const canIntakeRead=roles.some(r=>["receiver","warehouse_admin","super_admin"].includes(r));
  const canMove=roles.some(r=>["receiver","warehouse_admin"].includes(r));
  function applyScanResult(result:Row) {
    const actionLabel=result.kind==="package"?"打开包裹详情"
      :result.kind==="item"?(result.link?.startsWith("/wh/task/")?"打开质检任务":"打开实物详情")
      :result.kind==="location"?"前往库位移转"
      :result.kind==="order"?(result.link?.startsWith("/wh/task/")?"打开质检任务":result.link?.startsWith("/admin/orders/")?"打开管理订单":"打开收货工作台")
      :result.kind==="customer"?(result.link?.startsWith("/admin/customers/")?"查看客户档案":"查看关联包裹")
      :result.kind==="reference_seal"?"查看确认样详情"
      :result.kind==="outbound_waybill"?(result.link?.startsWith("/wh/dispatch/")?"打开发运批次":"查看物流监控")
      :result.package_id?"打开包裹详情":"前往收货核对";
    setMatch({
      title:result.code,
      detail:result.summary,
      link:result.link,
      action:actionLabel,
      allowed:result.allowed_actions,
      raw:result,
    });
  }
  async function lookupScan(code:string,carrier?:string) {
    setScanErr("");
    try {
      const query=carrier?"?"+new URLSearchParams({carrier_code:carrier}):"";
      const result=await request("/staff/scan/"+encodeURIComponent(code.trim())+query);
      applyScanResult(result);
    } catch(e) {
      setScanErr(e instanceof Error?e.message:"未找到匹配对象，请核对条码并确认类型或承运商。");
    }
  }
  return <>
    <div className="page-head row">
      <div><h1>扫码查询与对象工作台</h1>
        <p className="muted">支持扫码枪连续回车扫描（卖家运单、出库运单、订单 QW、客户码 QCW/@QCW...@、包裹 P、实物 S/DSP、铅封 GS-、库位码），扫后直达对应作业上下文。</p></div>
      <div className="head-actions">
        {canIntakeWrite&&<Link className="button primary sm" href="/wh/intake">收货入库台</Link>}
      </div>
    </div>
    <Panel title="连续扫码 / 条码图像识别">
      <div className="actions" style={{marginBottom:10}}>
        <button type="button" className="button sm" onClick={async()=>{
          setCameraNotice(undefined);
          if(typeof navigator==="undefined" || !navigator.mediaDevices?.getUserMedia) {
            setCameraNotice("当前设备或浏览器未开放相机扫码权限，请使用扫码枪、上传条码图片或下方手动输入。");
            return;
          }
          try {
            const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
            stream.getTracks().forEach(t=>t.stop());
            setCameraNotice("相机权限已就绪，推荐使用蓝牙/USB 扫码枪直扫或上传条码照片自动识别。");
          } catch {
            setCameraNotice("未能获取相机权限，已切换为扫码枪/图片解码/手动输入模式。");
          }
        }}>测试相机扫码</button>
      </div>
      {cameraNotice&&<p className="muted small" role="status">{cameraNotice}</p>}
      <form className="form inline-form" onSubmit={async e=>{
        e.preventDefault();
        const code=scanText.trim();
        if(!code) return;
        await lookupScan(code,scanCarrier||undefined);
        setScanText("");
        scanInputRef.current?.focus();
      }}>
        <label>扫描或输入编码（自动清空以便连扫）
          <input ref={scanInputRef} autoFocus name="scan_code" value={scanText} onChange={e=>setScanText(e.target.value)} placeholder="QW261121835 / QCW56084 / P86425 / S39204 / DSP / GS- / 库位 / 运单" required/>
        </label>
        <label>承运商（运单歧义时选填）
          <select value={scanCarrier} onChange={e=>setScanCarrier(e.target.value)}>
            <option value="">自动识别</option>
            {(carriers.data?.carriers??[]).map((c:Row)=><option key={c.code} value={c.code}>{c.labels["zh-CN"]??c.labels.en}</option>)}
          </select>
        </label>
        <button type="submit" className="button primary">扫码定位</button>
      </form>
      <Form inline label="上传条码照片自动解码" run={async f=>{
        const file=f.get("barcode_image");
        if(!(file instanceof File)||!file.size) throw new Error("请选择包含 QR 或 Code-128 条码的图片。");
        const buf=await file.arrayBuffer();
        const bytes=new Uint8Array(buf);
        let binary="";
        for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]!);
        const res=await request("/staff/scan/decode-image","POST",{image_base64:btoa(binary)});
        if(res.scan_result) applyScanResult(res.scan_result);
        else if(res.decoded_code) await lookupScan(res.decoded_code);
        else throw new Error("未能从该图像中识别出有效条码，请确认条码清晰度后手动补录编号。");
      }}>
        <label>条码照片 (QR / Code-128)<FileInput name="barcode_image" accept="image/*"/></label>
      </Form>
      {scanErr&&<div className="notice" role="alert" style={{borderLeft:"4px solid #dc2626"}}>
        <p style={{margin:"0 0 6px"}}>{scanErr}</p>
        {canIntakeWrite&&<Link className="button sm" href={"/wh/intake?"+new URLSearchParams(scanText?{tracking:scanText.trim()}:{})}>前往收货入库手动补录 / 登记隔离 →</Link>}
      </div>}
      {match&&match.raw&&(()=>{
        const r=match.raw;
        return <div className="panel" role="status" style={{marginTop:12,background:"#f8fafd"}}>
          <div className="row" style={{marginBottom:8}}>
            <div>
              <Tag tone="blue">{r.kind}</Tag> <strong className="code" style={{fontSize:"1.1rem"}}>{match.title}</strong>
              <p style={{margin:"4px 0 0"}}>{match.detail}</p>
            </div>
            <div className="actions">
              {match.link&&match.action&&<Link className="button primary" href={match.link}>{match.action} →</Link>}
            </div>
          </div>
          {r.custody_state&&["disposed","outbound"].includes(r.custody_state)&&<p className="notice small"><Tag tone="gray">{label(r.custody_state)}</Tag> 该实物已出库或已处置完成，不得再次上架或补打内部标签。</p>}
          <div className="inline-workbench-grid">
            {r.receiving_code&&<div className="task-ctx-cell"><small>客户专属码</small><strong className="code">{r.receiving_code}</strong></div>}
            {r.order_number&&<div className="task-ctx-cell"><small>关联订单</small><strong className="code">{r.order_number}</strong></div>}
            {r.package_code&&<div className="task-ctx-cell"><small>来源包裹</small><strong className="code">{r.package_code}</strong></div>}
            {r.location&&<div className="task-ctx-cell"><small>当前库位</small><strong className="code">{r.location}</strong></div>}
            {r.tracking_norm&&<div className="task-ctx-cell"><small>关联运单</small><strong className="code">{r.tracking_norm}</strong></div>}
            {r.product_name&&<div className="task-ctx-cell"><small>商品 / 款号</small><strong>{r.product_name} {r.sku_code?`(${r.sku_code})`:""}</strong></div>}
            {r.kind==="order"&&<div className="task-ctx-cell"><small>订单状态 / 数量口径</small><strong>{label(r.state)} · 预计 {r.expected_qty??0} / 实收 {r.logged_qty??0} / 核身 {r.identified_qty??0}</strong></div>}
            {r.kind==="waybill"&&<div className="task-ctx-cell"><small>承运商 / 物流状态</small><strong>{r.carrier_code??"待识别"} · {r.transport_state?label(r.transport_state):"未查询"}</strong></div>}
            {r.kind==="location"&&<div className="task-ctx-cell"><small>库位容量占用</small><strong>{ZONE_ZH[r.zone]??r.zone} · {r.occupied}/{r.capacity??"∞"} 件</strong></div>}
            {r.kind==="reference_seal"&&<div className="task-ctx-cell"><small>铅封状态</small><strong>{label(r.state)} · 实物 {r.item_code}</strong></div>}
          </div>
          {r.kind==="package"&&Array.isArray(r.items_preview)&&r.items_preview.length>0&&<Table
            headers={["包内实物预览（前 10 件）","身份状态","库位","操作"]}
            rows={r.items_preview.map((it:Row)=>[
              <span key="c" className="code">{it.code}</span>,
              <Tag key="id" tone={it.identity_state==="identified"?"green":"yellow"}>{label(it.identity_state)}</Tag>,
              <span key="lc" className="code">{it.location??"—"}</span>,
              canIntakeRead?<Link key="go" className="button sm" href={"/wh/samples/"+encodeURIComponent(it.code)}>详情</Link>:"—",
            ])}
          />}
          {r.kind==="location"&&<Table
            headers={["库位内实物编码","库存与身份","关联订单","包裹","操作"]}
            rows={(r.items??[]).map((it:Row)=>[
              <span key="c" className="code">{it.code}</span>,
              <span key="s">{label(it.custody_state)} · {label(it.identity_state)}</span>,
              <span key="o" className="code">{it.order_number??"—"}</span>,
              <span key="p" className="code">{it.package_code??"—"}</span>,
              <div key="op" className="actions">
                {canIntakeRead&&<Link className="button sm" href={"/wh/samples/"+encodeURIComponent(it.code)}>查看实物</Link>}
                {canMove&&<Link className="button sm" href={"/wh/storage?"+new URLSearchParams({item:it.code})}>移位</Link>}
              </div>,
            ])}
            empty="当前库位内无在库登记实物。"
          />}
          {(r.allowed_actions?.length??0)>0&&<p className="small muted" style={{margin:"8px 0 0"}}>当前岗位可执行动作：{r.allowed_actions.map((a:string)=>SCAN_ACTION_ZH[a]??a).join(" · ")}</p>}
        </div>;
      })()}
    </Panel>
  </>;
}

function LabelPrintPanel({targetType,targetId,code}:{targetType:"package"|"item"|"location";targetId:string;code:string}) {
  const [printed,setPrinted]=useState<{print_id:string;pdf_url:string;preview_png_url?:string;reprint:boolean;print_count:number;label_size?:string}>();
  const [verified,setVerified]=useState(false);
  return <Panel title="内部标签打印与扫码回读">
    <p className="muted">内部标签采用标准 ISO/IEC 18004 QR Code + ISO/IEC 15417 Code-128B 双码生成，仅含 <span className="code">{code}</span>，不含客户姓名、邮箱或外部地址。</p>
    <Form inline label="打印 / 重打标签" run={async f=>{
      const reason=text(f,"reprint_reason");
      const labelSize=text(f,"label_size")||"standard_80x50";
      const res=await request("/staff/labels/print","POST",{
        ...(targetType==="package"?{package_id:targetId}:targetType==="location"?{location_ids:[targetId]}:{item_ids:[targetId]}),
        label_size:labelSize,
        ...(reason?{reprint_reason:reason}:{}),
      });
      const first=res.labels?.[0];
      setPrinted({
        print_id:res.print_id,
        pdf_url:res.pdf_url,
        preview_png_url:res.preview_png_url,
        reprint:Boolean(first?.reprint),
        print_count:first?.print_count??1,
        label_size:res.label_size,
      });
      setVerified(false);
    }}>
      <Select name="label_size" label="标签尺寸" value="standard_80x50" choices={[
        {id:"standard_80x50",label:"80×50mm 标准热敏标签"},
        {id:"compact_50x30",label:"50×30mm 样品吊牌小签"},
        {id:"shelf_100x60",label:"100×60mm 货架/外箱大签"},
      ]}/>
      <Field name="reprint_reason" label="重打原因（首次打印可留空）" required={false}/>
    </Form>
    {printed&&<div className="notice" role="status">
      <p>已生成标签（第 {printed.print_count} 次打印 · 规格 {printed.label_size??"standard_80x50"}） · <a href={"/api/v1/staff/labels/"+printed.print_id+"/file"} target="_blank" rel="noreferrer">打开标签 PDF</a> · <a href={"/api/v1/staff/labels/"+printed.print_id+"/preview.png"} target="_blank" rel="noreferrer">打开条码 PNG</a></p>
      <img src={"/api/v1/staff/labels/"+printed.print_id+"/preview.png"} alt={`条码预览 ${code}`} style={{maxWidth:320,border:"1px solid #cbd5e1",borderRadius:6,marginTop:6}}/>
    </div>}
    <Form inline label="回读核验标签" run={async f=>{
      await request("/staff/labels/verify","POST",{expected_code:code,scanned_code:text(f,"scanned_code")});
      setVerified(true);
    }}>
      <label>请扫码枪扫入贴好后的标签码以核验一致<input name="scanned_code" placeholder={`扫入 ${code}`} required/></label>
    </Form>
    {verified&&<p className="notice" role="status">标签回读核验通过：<span className="code">{code}</span></p>}
  </Panel>;
}

export function WarehousePackageView({code,actor}:{code:string;actor?:Row}) {
  const {data,error,reload}=useLoad("/staff/packages/by-code/"+code);
  const [itemSearch,setItemSearch]=useState("");
  const [itemPage,setItemPage]=useState(1);
  const parcel=data?.parcel;
  const canIntakeWrite=Boolean(!actor?.roles || actor.roles.some((r:string)=>["receiver","warehouse_admin"].includes(r)));
  const canBindOwner=Boolean(!actor?.roles || actor.roles.some((r:string)=>["receiver","warehouse_admin","support","super_admin"].includes(r)));
  const canPrintLabels=Boolean(!actor?.roles || actor.roles.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r)));
  const pkgItems:Row[]=data?.items??[];
  const filteredPkgItems=pkgItems.filter((it:Row)=>{
    const q=itemSearch.trim().toLowerCase();
    if(!q) return true;
    return [it.code,it.location,it.order_number,it.declared_fields?.sku_code,it.declared_fields?.name].some(v=>String(v??"").toLowerCase().includes(q));
  });
  const pkgItemTotalPages=Math.max(1,Math.ceil(filteredPkgItems.length/15));
  const pkgItemCurPage=Math.min(itemPage,pkgItemTotalPages);
  const pkgItemSlice=filteredPkgItems.slice((pkgItemCurPage-1)*15,pkgItemCurPage*15);
  const skuGroups:Row[]=(data?.intake_context?.orders??[]).flatMap((ord:Row)=>
    (ord.expected_lines_summary?.lines_breakdown??[]).map((row:Row)=>({...row,order_public_no:ord.public_no}))
  );
  const inTransitCount=Number(data?.intake_context?.in_transit_advices_count??0);
  const unreceivedGap=data?.intake_context?.remaining_unreceived_qty??Math.max(0,(data?.intake_context?.total_declared_qty??0)-(data?.intake_context?.cumulative_received_qty??0));
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / PACKAGE RECORD</p><h1>包裹详情</h1>
      <p className="code">{code}</p></div>
      <div className="head-actions">
        {parcel&&canIntakeWrite&&parcel.state!=="quarantined"&&<Link className="button primary" href={"/wh/intake?package="+parcel.id+"#intake-unpack"}>打开拆包登记</Link>}
        <Link className="button" href="/wh/packages">返回包裹列表</Link>
      </div></div>
    {!canIntakeWrite&&<div className="notice" style={{marginBottom:12}}><strong>只读监督模式：</strong>收货拆包、包裹隔离与库位操作仅限收货员（receiver）及仓库主管（warehouse_admin）执行。</div>}
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取包裹…</p>}
    {data&&parcel&&<>
      {parcel.late_sample_review&&<Panel title="对比检迟到包裹核验" subtitle={`工单 ${parcel.late_sample_review}。核对外箱证据、收件码和原委托后再放行拆包。`}>
        {canIntakeWrite&&<Form label="核验通过并转拆包" idempotent run={async(fields,key)=>{
          await request(`/staff/packages/${parcel.id}/late-sample-review`,"POST",{revision:parcel.revision,reason:text(fields,"reason")},key);
          reload();
        }}><label>核验依据（必填）<textarea name="reason" required minLength={4} maxLength={1000}/></label></Form>}
      </Panel>}
      <div className="ops-columns">
        <Panel title="仓库实收与外箱证据">
          <dl className="location-facts">
            <div><dt>包裹状态</dt><dd><Tag>{label(parcel.state)}</Tag></dd></div>
            <div><dt>外箱状况</dt><dd><Tag tone={parcel.outer_condition&&parcel.outer_condition!=="intact"?"red":"green"}>{label(parcel.outer_condition??"intact")}</Tag></dd></div>
            <div><dt>实际入仓时间</dt><dd>{stamp(parcel.received_at)}</dd></div>
            <div><dt>实收件数</dt><dd>{parcel.received_quantity} 件</dd></div>
            <div><dt>外箱实重</dt><dd>{parcel.weight_g==null?"未记录":parcel.weight_g+" 克"}</dd></div>
            <div><dt>存放库位</dt><dd className="code">{parcel.location_code??"未设定"}</dd></div>
            <div><dt>客户收件码</dt><dd className="code">{parcel.receiving_code??"待核验"}</dd></div>
            <div><dt>关联委托</dt><dd className="code">{parcel.order_numbers.join("、")||"尚未关联"}</dd></div>
            {parcel.outer_media_ids?.length>0&&<div><dt>入库外箱实拍照</dt><dd><MediaButton ids={parcel.outer_media_ids} label={`查看外箱照 (${parcel.outer_media_ids.length})`}/></dd></div>}
            {parcel.open_media_ids?.length>0&&<div><dt>开箱清点照</dt><dd><MediaButton ids={parcel.open_media_ids} label={`查看开箱照 (${parcel.open_media_ids.length})`}/></dd></div>}
            {parcel.condition_note&&<div><dt>外箱异常与隔离说明</dt><dd>{parcel.condition_note}</dd></div>}
          </dl>
        </Panel>
        <Panel title="承运商运输">
          <p>卖家运单 <strong className="code">{parcel.tracking_norm??"尚无运单"}</strong></p>
          {parcel.tracking_norm&&<p>{label(parcel.transport_state)} · {label(parcel.sync_state)}</p>}
          {parcel.tracking_events?.length?<ol className="timeline">{parcel.tracking_events.map((event:Row)=>
            <li key={event.id}>{stamp(event.occurred_at)} · {event.text}</li>)}</ol>:<Empty>暂无承运商中文轨迹。</Empty>}
        </Panel>
      </div>
      {data.intake_context&&data.intake_context.orders?.length>0&&<Panel title="SKU 数量汇总与到货差额对照">
        <p className="small muted">
          订单申报总件数：<strong>{data.intake_context.total_declared_qty}</strong> 件 · 仓库累计实收：<strong>{data.intake_context.cumulative_received_qty}</strong> 件 · {inTransitCount>0?<>仍差在途件数：<strong>{unreceivedGap}</strong> 件（在途未到仓运单 {inTransitCount} 单）</>:<>全部预报运单已到仓 · 实收差额：<strong>{unreceivedGap}</strong> 件</>}
        </p>
        <Table
          headers={["订单号","品名 / SKU","颜色 / 尺码","供应商","预计","已关联","待核身","确认短少"]}
          rows={skuGroups.map((sg:Row)=>[
            <span key="o" className="code">{sg.order_public_no}</span>,
            <span key="s">{sg.product_name||"—"} {sg.sku_code?<span className="code">({sg.sku_code})</span>:null}</span>,
            [sg.color_declared,sg.size_label].filter(Boolean).join(" / ")||"—",
            sg.supplier_alias||"—",
            sg.expected_qty,sg.arrived_qty,sg.unidentified_pending_qty??0,sg.missing_qty??0,
          ])}
          empty="暂无客户 SKU 汇总。"
        />
        {(data.intake_context.declared_items?.length??0)>0&&<details style={{marginTop:8}}>
          <summary className="small" style={{cursor:"pointer"}}>展开客户逐件申报位置槽位 ({data.intake_context.declared_items.length})</summary>
          <Table
            headers={["订单号 / 位置","款号","颜色 / 尺码","申报运单","当前绑定实物"]}
            rows={data.intake_context.declared_items.slice(0,50).map((di:Row)=>[
              <span key="p" className="code">{di.order_public_no} #{di.position}</span>,
              <span key="s" className="code">{di.sample_code??"—"}</span>,
              [di.color,di.size].filter(Boolean).join(" / ")||"—",
              <span key="t" className="code">{di.declared_tracking_no??"—"}</span>,
              di.bound_item_code?<Link key="b" className="code" href={"/wh/samples/"+encodeURIComponent(di.bound_item_code)}>{di.bound_item_code}</Link>:<Tag key="b" tone="yellow">待绑定</Tag>,
            ])}
          />
        </details>}
      </Panel>}
      {canBindOwner&&parcel.state==="unmatched"&&<Panel title="无预报包裹归属核验">
        <p className="muted">若外箱面单写有客户专属收件码（如 QCW56084 或 @QCW56084@），上传面单标签照并核验绑定归属。</p>
        <Form label="核验面单并绑定客户" run={async f=>{
          const proof=await upload(f.get("photo"),"label_photo");
          await request("/staff/packages/"+parcel.id+"/bind-owner","POST",{
            revision:parcel.revision,
            receiving_code:text(f,"receiving_code"),
            reason:text(f,"reason"),
            evidence_ids:[proof],
          });
          reload();
        }}>
          <Field name="receiving_code" label="面单上的客户专属收件码"/>
          <Field name="reason" label="核验依据说明"/>
          <Photo label="面单收件码核对照"/>
        </Form>
      </Panel>}
      {canIntakeWrite&&(parcel.state!=="quarantined"||parcel.late_sample_review)&&<Panel title="禁限品与异常包裹隔离">
        <details className="card">
          <summary>登记为禁限品或拒收异常并转入隔离区（Quarantine）</summary>
          <Form label="确认转入隔离区" run={async f=>{
            await request("/staff/packages/"+parcel.id+"/quarantine","POST",{
              revision:parcel.revision,
              reason:text(f,"reason"),
            });
            reload();
          }}>
            <Field name="reason" label="禁限品或异常原因"/>
          </Form>
        </details>
      </Panel>}
      {canPrintLabels&&parcel.state!=="quarantined"&&<LabelPrintPanel targetType="package" targetId={parcel.id} code={parcel.code}/>}
      <Panel title={`拆包实物明细 (${pkgItems.length} 件)`}>
        <div className="admin-toolbar" style={{marginBottom:10}}>
          <label>筛选包内实物编号 / 库位 / SKU
            <input type="search" value={itemSearch} onChange={e=>{setItemSearch(e.target.value);setItemPage(1);}} placeholder="S-... / DSP-... / 库位"/>
          </label>
          {pkgItemTotalPages>1&&<div className="actions">
            <button type="button" className="button sm" disabled={pkgItemCurPage<=1} onClick={()=>setItemPage(pkgItemCurPage-1)}>上一页</button>
            <span className="small muted">第 {pkgItemCurPage} / {pkgItemTotalPages} 页</span>
            <button type="button" className="button sm" disabled={pkgItemCurPage>=pkgItemTotalPages} onClick={()=>setItemPage(pkgItemCurPage+1)}>下一页</button>
          </div>}
        </div>
        <Table headers={["实物码","类型","身份/库存状态","质检阶段","当前位置","操作"]} rows={pkgItemSlice.map((item:Row)=>[
          <span key="c" className="code">{item.code}</span>,
          item.parent_item_id?"套装组件":"主件",
          `${label(item.identity_state)} · ${label(item.custody_state)}`,
          <Tag key="qc" tone={item.inspection_stage==="in_inspection"?"yellow":item.inspection_stage==="inspected"?"green":"gray"}>{label(item.inspection_stage??"pending")}</Tag>,
          item.location??"—",
          <Link key="go" href={"/wh/samples/"+encodeURIComponent(item.code)}>核对实物</Link>,
        ])} empty="尚未登记包内实物。"/>
      </Panel>
      <Panel title={`包裹与包内件操作历史 (${(data.history??[]).length})`}>
        <Table
          headers={["时间","操作动作","实物码","原库位 → 目标库位","操作人"]}
          rows={(data.history??[]).map((h:Row)=>[
            stamp(h.created_at),
            h.action,
            h.item_code?<span className="code">{h.item_code}</span>:"包裹级",
            [h.from_location,h.to_location].some(Boolean)?`${h.from_location??"—"} → ${h.to_location??"—"}`:"—",
            h.actor_name??"—",
          ])}
          empty="暂无历史记录。"
        />
      </Panel>
    </>}
  </>;
}

function ItemIdentity({data,actor,onSave}:{data:Row;actor?:Row;onSave:()=>void}) {
  const {item}=data;
  const positions:Row[]=data.positions;
  const canIntakeWrite=Boolean(!actor?.roles || actor.roles.some((r:string)=>["receiver","warehouse_admin"].includes(r)));
  const [selectedPosId,setSelectedPosId]=useState<string>(positions[0]?.id??"");
  useEffect(()=>{
    if(!positions.some(p=>p.id===selectedPosId)) {
      setSelectedPosId(positions[0]?.id??"");
    }
  },[positions,selectedPosId]);
  const selectedPos=positions.find(p=>p.id===selectedPosId)??positions[0];
  const actualTrack=String(item.source_tracking_no??"").trim().toUpperCase();
  const posPerItemTrack=String(selectedPos?.per_item_tracking_no??"").trim().toUpperCase();
  const posAdvisedTracks:string[]=Array.isArray(selectedPos?.advised_tracking_nos)?selectedPos.advised_tracking_nos.map((x:string)=>String(x).trim().toUpperCase()).filter(Boolean):[];
  const hasTrackingMismatch=Boolean(
    actualTrack && (
      (posPerItemTrack && posPerItemTrack!==actualTrack) ||
      (!posPerItemTrack && posAdvisedTracks.length>0 && !posAdvisedTracks.includes(actualTrack))
    )
  );
  const expectedTrackDisplay=posPerItemTrack || posAdvisedTracks.join(", ") || "—";
  const storageEvents:Row[]=data.storage_events??[];
  const inspectionTasks:Row[]=data.inspection_tasks??[];
  const activeTickets:Row[]=data.active_tickets??[];
  return <>
    {!canIntakeWrite&&<div className="notice" style={{marginBottom:12}}><strong>只读监督模式：</strong>实物核身确认、绑定委托、解绑与违禁隔离仅限收货员（receiver）或仓库主管（warehouse_admin）执行；当前账号仅查看关联状态与证据。</div>}
    <div className="task-ctx-grid" style={{marginBottom:12}}>
      <div className="task-ctx-cell"><small>实物编码 / 保管状态</small><strong className="code">{item.code} · {label(item.custody_state)}</strong></div>
      <div className="task-ctx-cell"><small>核身 / 质检状态</small><span><Tag tone={item.identity_state==="identified"?"green":item.identity_state==="quarantined"?"red":"yellow"}>{label(item.identity_state)}</Tag> <Tag tone={item.inspection_stage==="inspected"?"green":"outline"}>{item.inspection_stage==="inspected"?"已质检":item.inspection_stage==="in_progress"?"质检中":"待质检"}</Tag></span></div>
      <div className="task-ctx-cell"><small>来源包裹与运单</small><span><Link className="code" href={"/wh/packages/"+encodeURIComponent(item.package_code)}>{item.package_code}</Link>{item.source_tracking_no?<> · <span className="code">{item.source_tracking_no}</span></>:""}</span></div>
      <div className="task-ctx-cell"><small>客户 / 订单 / 服务</small><span><strong className="code">{item.customer_receiving_code??"无主待核验"}</strong>{item.order_number?<> · <span className="code">{item.order_number}</span></>:" · 未绑单"}{item.service_title?` (${item.service_title["zh-CN"]??item.service_title.en})`:""}</span></div>
      <div className="task-ctx-cell"><small>当前库位 / 免费保管至</small><strong className="code">{item.location??"未上架"}{item.location_zone?` (${item.location_zone})`:""} · {stamp(item.storage_until)}</strong></div>
      <div className="task-ctx-cell"><small>冻结 / 处置去向</small><span>{item.handling_hold?<Tag tone="red">冻结：{item.handling_hold}</Tag>:item.active_disposition?<Tag tone="yellow">{item.active_disposition.action} · {item.active_disposition.state}</Tag>:"正常在库"}</span></div>
    </div>
    {item.components?.length>0&&<p className="small">包含套装组件：{item.components.map((c:Row)=>c.code).join("、")}</p>}
    {(item.is_reference_sample||item.reference_sample_state)&&<div className="notice" style={{marginBottom:10}}>
      <Tag tone="yellow">确认样记录 ({item.reference_sample_state})</Tag> 铅封号 <span className="code">{item.reference_seal_code??"—"}</span> · 到期 {stamp(item.reference_expires_at)} {item.reference_in_use?" · 当前正被批次引用锁定中":""}
      {item.reference_zone_warning&&<p className="bad" style={{margin:"4px 0 0"}}>{item.reference_zone_warning}</p>}
    </div>}
    {!item.ownership_verified&&<p className="notice">待核验客户归属。完成认领后才能关联委托。</p>}
    {item.declared_fields&&<div className="card">
      <strong>客户委托申报与实物标签核对依据（位置 #{item.expected_position}）</strong>
      <p className="small">
        品名：{item.declared_summary?.product_name||"—"} · 款号：<span className="code">{item.declared_summary?.sample_code||item.declared_fields.sample_code||"—"}</span> · 颜色：{item.declared_summary?.color||item.declared_fields.color_declared||"—"} · 尺码：{item.declared_summary?.size||item.declared_fields.size_label||"—"} · 供应商：{item.declared_summary?.supplier_alias||item.declared_fields.supplier_alias||"—"}
      </p>
      {item.actual_label_info&&<p className="small muted">实际吊牌核对：尺码 {item.actual_label_info.size_label??"—"} · 颜色 {item.actual_label_info.color_found??"—"}</p>}
      {(item.label_media_ids?.length??0)>0&&<MediaButton ids={item.label_media_ids} label={`查看标签/实物证据照 (${item.label_media_ids.length})`}/>}
      {item.declared_fields.mismatch_note&&<p className="bad small">当前登记不符：{item.declared_fields.mismatch_note}</p>}
    </div>}
    {inspectionTasks.length>0&&<div className="card">
      <strong>关联质检任务 ({inspectionTasks.length})</strong>
      <div className="actions" style={{marginTop:6,flexWrap:"wrap"}}>
        {inspectionTasks.map((t:Row)=><Link key={t.id} className="button sm" href={`/wh/task/${t.id}`}>任务 #{t.id.slice(0,8)} · {label(t.state)} ({t.assignee_name??"待领取"}) →</Link>)}
      </div>
    </div>}
    {activeTickets.length>0&&<div className="card">
      <strong>关联异常工单 ({activeTickets.length})</strong>
      <ul>{activeTickets.map((tk:Row)=><li key={tk.id}><span className="code">{tk.public_no}</span> · {tk.subject} (<Tag>{({open:"待处理",in_progress:"跟进中",waiting_customer:"待客户回复",resolved:"已解决",closed:"已结案"} as Record<string,string>)[tk.state]??tk.state}</Tag>)</li>)}</ul>
    </div>}
    {storageEvents.length>0&&<details className="card">
      <summary style={{cursor:"pointer"}}>查看实物库位流转历史 ({storageEvents.length})</summary>
      <Table
        headers={["时间","动作","原库位","目标库位","操作员"]}
        rows={storageEvents.map((ev:Row)=>[stamp(ev.created_at),ev.action,ev.from_location??"—",ev.to_location??"—",ev.operator_name??"—"])}
      />
    </details>}
    {canIntakeWrite&&item.can_identify&&<details className="card" open={item.identity_state==="mismatch"}>
      <summary>实物身份核对与收货不符登记</summary>
      <Form label="提交身份核对结论" run={async f=>{
        const matches=text(f,"matches_advice")==="true";
        const file=f.get("photo");
        const mediaIds:string[]=[];
        if(file instanceof File && file.size>0) {
          mediaIds.push(await upload(file,"label_photo"));
        }
        await request("/staff/items/"+item.id+"/identify","POST",{
          revision:item.revision,
          matches_advice:matches,
          actual_label_info:{
            size_label:text(f,"actual_size")||undefined,
            color_found:text(f,"actual_color")||undefined,
          },
          mismatch_note:matches?undefined:text(f,"mismatch_note"),
          media_ids:mediaIds.length?mediaIds:undefined,
        });
        onSave();
      }}>
        <Select name="matches_advice" label="核对结论" choices={[
          {id:"true",label:"实物标签与客户申报一致（确认 identified）"},
          {id:"false",label:"实物与申报不符（暂停订单并通知客户确认）"},
        ]}/>
        <Field name="actual_size" label="实拍吊牌/洗标尺码（选填）" required={false}/>
        <Field name="actual_color" label="实收外观颜色（选填）" required={false}/>
        <Field name="mismatch_note" label="不符说明（客户可见英文，不符时必填）" required={false}/>
        <label>补充标签核对照（选填）<FileInput name="photo" accept="image/jpeg,image/png,image/webp"/></label>
      </Form>
    </details>}
    {canIntakeWrite&&(positions.length>0?<>
      <div className="card" style={{marginBottom:10}}>
        <strong>候选待绑定委托位置明细（请核对款号、颜色、尺码、供应商及运单来源）</strong>
        <Table
          headers={["订单与位置","服务","款号 (Sample Code)","颜色","尺码","供应商","服装子类","申报运单"]}
          rows={positions.map(p=>[
            <span className="code">{p.public_no} #{p.position}</span>,
            p.title["zh-CN"],
            <span className="code">{p.sample_code??"—"}</span>,
            p.color??"—",
            p.size??"—",
            p.supplier_alias??"—",
            p.garment_type??"—",
            <span className="code">{p.declared_tracking_no||p.source_tracking_no||"—"}</span>,
          ])}
        />
      </div>
      <Form key={item.id} label="核对并绑定" run={async f=>{
        const position=positions.find(p=>p.id===text(f,"position"));
        if(!position)throw new Error("请选择同一客户的委托位置。");
        const proof=await upload(f.get("photo"),"label_photo");
        const forceMismatch=checked(f,"force_tracking_mismatch");
        const overrideReason=text(f,"override_reason");
        await request("/staff/items/"+item.id+"/assign","POST",{
          revision:item.revision,
          order_line_id:position.order_line_id,
          expected_item_id:position.id,
          evidence_ids:[proof],
          ...(forceMismatch?{force_tracking_mismatch:true}:{}),
          ...(overrideReason?{override_reason:overrideReason}:{}),
        });
        onSave();
      }}>
        <label>同一客户的待收委托位置（含款号/颜色/尺码/供应商/运单）
          <select name="position" value={selectedPos?.id??""} onChange={e=>setSelectedPosId(e.target.value)} required>
            {positions.map(p=><option key={p.id} value={p.id}>
              {`${p.public_no} · ${p.title["zh-CN"]} · #${p.position}${p.sample_code?` · 款号:${p.sample_code}`:""}${p.color?` · 颜色:${p.color}`:""}${p.size?` · 尺码:${p.size}`:""}${p.supplier_alias?` · 供应商:${p.supplier_alias}`:""}${(p.declared_tracking_no||p.source_tracking_no)?` · 申报运单:${p.declared_tracking_no||p.source_tracking_no}`:""}`}
            </option>)}
          </select>
        </label>
        {hasTrackingMismatch&&<div className="notice" style={{borderLeft:"4px solid #dc2626"}}>
          <p className="bad" style={{margin:"0 0 6px"}}>
            <strong>运单不一致拦截预警：</strong>当前实物实际入库运单为 <span className="code">{actualTrack}</span>，所选委托申报运单为 <span className="code">{expectedTrackDisplay}</span>。禁止静默跨运单绑定！
          </p>
          <p className="small muted" style={{margin:"0 0 8px"}}>
            若经核对卖家发货凭证确认属于换单/拆包到货，请勾选下方受控异常处理确认框、填写不少于 4 字的核实依据并上传标签/面单核对照，系统将写入审计日志。
          </p>
          <label className="check"><input type="checkbox" name="force_tracking_mismatch"/>确认已核实换单/分包依据，执行受控跨运单绑定（写入审计）</label>
          <Field name="override_reason" label="跨运单核实依据说明（受控绑定时必填，≥4字）" required={false}/>
        </div>}
        <Photo label="商品标签核对照"/>
      </Form>
    </>:item.ownership_verified&&!item.order_number&&<Empty>当前实物没有可绑定的委托位置（可保留为无委托实物或由客户直接发起退回/转运）。</Empty>)}
    {canIntakeWrite&&item.can_unassign&&<details className="card">
      <summary>解除当前委托绑定（跨本人订单重新映射）</summary>
      <Form label="确认解除委托位置关联" run={async f=>{
        await request("/staff/items/"+item.id+"/unassign","POST",{revision:item.revision,reason:text(f,"reason")});
        onSave();
      }}>
        <Field name="reason" label="解除并重新映射原因"/>
      </Form>
    </details>}
    {canIntakeWrite&&item.identity_state!=="quarantined"&&["received","stored"].includes(item.custody_state)&&<details className="card">
      <summary>将单件实物隔离为违禁/受损异常件 (Quarantine)</summary>
      <Form label="确认转入隔离区" run={async f=>{
        await request("/staff/items/"+item.id+"/quarantine","POST",{revision:item.revision,reason:text(f,"reason")});
        onSave();
      }}>
        <Field name="reason" label="单件异常/禁限原因（≥4 字）"/>
      </Form>
    </details>}
    {canIntakeWrite&&item.movable&&<Link className="button" href={"/wh/storage?"+new URLSearchParams({item:item.code})}>移转此实物</Link>}
  </>;
}

export function WarehouseItemView({code,actor}:{code:string;actor?:Row}) {
  const {data,error,reload}=useLoad("/staff/items/by-code?"+new URLSearchParams({code}));
  const canPrintLabels=Boolean(!actor?.roles || actor.roles.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r)));
  const itemState=data?.item?.custody_state;
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / ITEM RECORD</p><h1>实物建档与识别</h1>
      <p className="code">{code}</p></div><Link className="button" href="/wh/scan">返回扫码</Link></div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取实物…</p>}
    {data&&!error&&<>
      <Panel title="库存与委托"><ItemIdentity data={data} actor={actor} onSave={reload}/></Panel>
      {canPrintLabels&&!["disposed","outbound"].includes(itemState)&&data.item.identity_state!=="quarantined"&&<LabelPrintPanel targetType="item" targetId={data.item.id} code={data.item.code}/>}
    </>}
  </>;
}
