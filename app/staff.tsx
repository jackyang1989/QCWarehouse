"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
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

const SAMPLE_CODE_ALPHABET="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRandomSampleCode():string {
  const bytes=new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out="S-";
  for(let i=0;i<6;i++) out+=SAMPLE_CODE_ALPHABET[bytes[i]!%SAMPLE_CODE_ALPHABET.length];
  return out;
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
  return_to_seller:"退商家",to_forwarder:"寄集运仓",identified:"已识别",
  in_inspection:"检中",inspected:"已检",
  intact:"外箱完好",crushed:"外箱压扁变形",torn:"外箱破损开裂",wet:"外箱水渍受潮",
} as Record<string,string>)[s]??s;
const options=(rows:Row[],name="code")=>rows.map(r=>({id:r.id,label:String(r[name])}));
export function WarehouseDesk({path,actor,demo=false}:{path:string;actor:Row;demo?:boolean}) {
  const {data,error,reload}=useLoad("/staff/desk"),carriers=useLoad("/carriers");
  const [lookup,setLookup]=useState<{tracking:string;carrier:string;result:Row;context?:Row}>();
  const [receiving,setReceiving]=useState(false);
  const [packageId,setPackageId]=useState("");
  const [intakeTracking,setIntakeTracking]=useState("");
  const [batchPrintResult,setBatchPrintResult]=useState<{print_id:string;pdf_url:string;preview_png_url:string;codes:string[]}>();
  const [batchVerifyResult,setBatchVerifyResult]=useState<{verified:boolean;verified_count:number}>();
  const [discrepancyResult,setDiscrepancyResult]=useState<Row>();
  const packageDetail=useLoad(packageId?"/staff/packages/"+packageId:null);
  const selectedPackage=packageDetail.data?.parcel.id===packageId?packageDetail.data:undefined;
  const [itemCode,setItemCode]=useState("");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const itemDetail=useLoad(itemCode?"/staff/items/by-code?"+new URLSearchParams({code:itemCode}):null);
  useEffect(()=>{
    if(path!=="/wh/intake")return;
    const params=new URLSearchParams(location.search);
    setPackageId(params.get("package")??"");
    setItemCode(params.get("item")??"");
    setIntakeTracking(params.get("tracking")??"");
  },[path]);
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载工作台…</p>;
  const availableLinks=staffTabs("warehouse",actor.roles);
  const canReceive=actor.roles.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r));
  const canInspect=actor.roles.some((r:string)=>["inspector","super_admin"].includes(r)),canReview=actor.roles.some((r:string)=>["reviewer","super_admin"].includes(r)),canShip=actor.roles.some((r:string)=>["warehouse_admin","super_admin"].includes(r));
  const item=itemDetail.data?.item;
  const selectItem=(code:string)=>{setItemCode(code);itemDetail.reload();};
  const locations=options(data.locations);
  const carrierOptions=(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}));
  const current=path.split("/")[2]??"overview";
  const groups=Object.values(data.tasks.reduce((g:Record<string,Row[]>,t:Row)=>{(g[t.order_id]??=[]).push(t);return g;},{})) as Row[][];
  const heading={
    overview:["仓库总览","实物、证据、费用与物流是不同的业务事实。"],
    intake:["收货入库","快递公司签收不等于 QCWarehouse 仓库实收。记录外箱与实物后才能确认。"],
    packages:["包裹详情","实物包裹与原始运单、入库事务分别保存。"],
    samples:["样品识别与建档","客户物件标识与委托明细独立管理。"],
    inspection:["检查任务队列","按委托任务而非按订单数量派工，逐件检查与样品比较独立。"],
    execute:["检查执行工作台","按受控模板录入观察事实、测量值与必拍证据。"],
    sync:["本地同步与冲突处理","仓库移动设备断网后不能覆盖已发布服务端数据。"],
    dispatch:["出库与退商家待办","只有授权、报价、付款和样品可用状态全部满足，才能进入可交接队列。"],
  }[current]??["仓库总览","实物、证据、费用与物流是不同的业务事实。"];
  const pad2=(n:number)=>String(n).padStart(2,"0");
  const overviewMetrics:[string,string,string,string][]=[
    ["/wh/intake","待收实物",pad2(data.packages.length),"需扫码实收"],
    ["/wh/inspection","待检任务",pad2(data.tasks.length),"按 SLA 排序"],
    ["/wh/review","待复核报告",pad2(data.reports.length),"不同人员复核"],
    ["/wh/dispatch","待出库指令",pad2(data.batches.length),"付款及授权分别核验"],
  ];
  const activeRoleKey=actor.roles.includes("super_admin")?"admin":actor.roles.includes("reviewer")?"reviewer":actor.roles.includes("inspector")?"inspector":actor.roles.includes("warehouse_admin")?"warehouse":"receiving";
  const todayRows:[ReactNode,ReactNode,ReactNode][]=[
    ...data.packages.slice(0,3).map((parcel:Row):[ReactNode,ReactNode,ReactNode]=>[
      <Link className="code" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{parcel.code}</Link>,
      <Tag tone="green">{label(parcel.state)}</Tag>,
      <Link className="button sm" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>核对样品</Link>,
    ]),
    ...data.tasks.slice(0,3).map((task:Row):[ReactNode,ReactNode,ReactNode]=>[
      <Link className="code" href={"/wh/task/"+task.id}>{task.public_no}</Link>,
      <Tag tone="yellow">{label(task.state)}</Tag>,
      <Link className="button sm" href={"/wh/task/"+task.id}>进入检查</Link>,
    ]),
    ...data.reports.slice(0,2).map((rep:Row):[ReactNode,ReactNode,ReactNode]=>[
      <Link className="code" href={"/wh/review/"+rep.id}>{rep.public_no}</Link>,
      <Tag tone="yellow">{label(rep.state)}</Tag>,
      <Link className="button sm" href={"/wh/review/"+rep.id}>查看证据</Link>,
    ]),
  ];
  return <><div className="page-head row"><div><p className="eyebrow">WAREHOUSE OPERATIONS</p><h1>{heading[0]}</h1><p className="muted">{heading[1]}</p></div>
    {current==="overview"&&<div className="head-actions"><Link className="button primary" href="/wh/scan">扫码查件</Link><Link className="button" href="/wh/intake">待收登记</Link></div>}
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
        <Panel title="今日作业队列" subtitle="生产需按角色裁剪数据。">
          <Table headers={["对象","进度","下一步"]} rows={todayRows} empty="暂无待处理作业，可通过收货入库或客户下单创建。"/>
        </Panel>
        <Panel title="操作捷径">
          <div className="grid cols2">
            {[
              ["/wh/scan","扫码查询"],
              ["/wh/intake","收货入库"],
              ["/wh/inspection","检查队列"],
              ["/wh/review","报告复核"],
              ["/wh/dispatch","出库待办"],
              ["/wh/stocktakes","库存盘点"],
            ].map(([href,name])=><Link className="button sm" key={href} href={href}>{name}</Link>)}
          </div>
          <hr className="sep"/>
          <div className="line-note">员工端正式部署禁止依赖外部字体、CDN 或需要翻墙的资源。</div>
        </Panel>
      </div>
    </>}
    {current==="intake"&&canReceive&&<>
      <ol className="intake-stages" aria-label="收货步骤">
        <li><a href="#intake-waybill"><span>01</span>核对运单与外箱</a></li>
        <li><a href="#intake-unpack"><span>02</span>逐件建档与上架</a></li>
        <li><a href="#item-intake"><span>03</span>核对身份与委托</a></li>
      </ol>
      <section className="panel scan-panel" id="intake-waybill"><div className="section-heading"><span className="eyebrow">01 / 运单定位</span><h2>搜索卖家运单</h2><p className="muted">承运商签收后，仍需仓库核对外箱状况（完好/压扁/破损/水渍）并确认实收。</p></div>
        <fieldset disabled={receiving} style={{display:"contents"}} onChange={()=>{setLookup(undefined);setPackageId("");}}>
          <Form inline label="搜索" run={async f=>{
            const tracking=text(f,"tracking"),carrier=text(f,"carrier");
            setLookup(undefined);setPackageId("");
            const result=await request("/staff/intake/lookup","POST",{tracking_no:tracking,...(carrier?{carrier_code:carrier}:{})});
            let context:Row|undefined;
            try {
              context=await request("/staff/intake/context?"+new URLSearchParams({tracking_no:tracking,...(carrier?{carrier_code:carrier}:{})}));
            } catch {}
            setLookup({tracking,carrier,result,context});
            if(result.package_id)setPackageId(result.package_id);
          }}><Field key={intakeTracking} name="tracking" label="扫描条码或手动输入运单号" value={intakeTracking}/><Select name="carrier" label="快递公司" choices={carrierOptions} required={false}/></Form>
        </fieldset>
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
          {lookup.result.package_id&&<p>此运单已有实收记录，已定位到拆包登记。</p>}
        </div>}
        {lookup&&lookup.result.match_state!=="ambiguous"&&!lookup.result.package_id&&<Form key={lookup.tracking+"-"+lookup.carrier} label="确认实物到仓" run={async f=>{
          setReceiving(true);
          try {
            const photo=await upload(f.get("photo"),"intake_outer");
            const weight=text(f,"weight");
            const outerCondition=text(f,"outer_condition")||"intact";
            const conditionNote=text(f,"condition_note");
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
            <Field name="condition_note" label="外箱破损/异常备注（外箱异常时必填）" required={false}/>
          </div>
          <Photo label="包裹外箱照片（含快递面单与外箱全貌）"/>
        </Form>}
      </section>
      <Panel title="02 / 拆包登记、同屏核对与批量标签打印" id="intake-unpack">
        <label>入仓包裹<select value={packageId} onChange={e=>{setPackageId(e.target.value);setBatchPrintResult(undefined);setBatchVerifyResult(undefined);setDiscrepancyResult(undefined);}}>
          <option value="">选择包裹</option>
          {packageId&&!data.packages.some((p:Row)=>p.id===packageId)&&<option value={packageId}>{selectedPackage?.parcel.code??"正在定位包裹"}</option>}
          {data.packages.map((p:Row)=><option key={p.id} value={p.id}>{p.code} · {p.tracking_norm??"—"}</option>)}
        </select></label>
        {packageId&&packageDetail.error&&<><ErrorBlock error={packageDetail.error}/><button type="button" onClick={packageDetail.reload}>重新读取包裹</button></>}
        {packageId&&!selectedPackage&&!packageDetail.error&&<p role="status">正在读取包裹…</p>}
        {selectedPackage&&<><p><Link className="code" href={"/wh/packages/"+selectedPackage.parcel.code}>{selectedPackage.parcel.code}</Link> · 本包已建档 <strong>{selectedPackage.parcel.received_quantity}</strong> 件 · 外箱 <Tag>{label(selectedPackage.parcel.outer_condition??"intact")}</Tag> · 状态 <Tag>{label(selectedPackage.parcel.state)}</Tag></p>
          {selectedPackage.parcel.order_numbers.length>0&&<p>关联订单 {selectedPackage.parcel.order_numbers.join("、")}</p>}
          {selectedPackage.intake_context&&selectedPackage.intake_context.orders?.length>0&&<div className="card" style={{marginBottom:12}}>
            <div className="row">
              <strong>客户申报 vs 仓库累计实收同屏核对（支持多包裹分批到仓）</strong>
              <span className="small muted">
                订单总申报 <strong>{selectedPackage.intake_context.total_declared_qty}</strong> 件 · 累计已收 <strong>{selectedPackage.intake_context.cumulative_received_qty}</strong> 件 · 仍差 <strong>{selectedPackage.intake_context.remaining_unreceived_qty}</strong> 件 · 在途未到运单 <strong>{selectedPackage.intake_context.in_transit_advices_count}</strong> 单
              </span>
            </div>
            <Table
              headers={["订单号 / 位置","款号 (Sample Code)","颜色","尺码","供应商","服装子类","申报运单","已绑实物码"]}
              rows={(selectedPackage.intake_context.declared_items??[]).map((di:Row)=>[
                <span className="code">{di.order_public_no} #{di.position}</span>,
                <span className="code">{di.sample_code??"—"}</span>,
                di.color??"—",
                di.size??"—",
                di.supplier_alias??"—",
                di.garment_type??"—",
                <span className="code">{di.declared_tracking_no??"—"}</span>,
                di.bound_item_code?<CodeButton code={di.bound_item_code} onClick={()=>selectItem(di.bound_item_code)}/>:<Tag tone="yellow">待绑定</Tag>,
              ])}
              empty="该包裹关联订单暂无逐件申报明细。"
            />
          </div>}
          <Table headers={["实物码","类型","库存状态","质检阶段","当前库位","同屏快捷操作"]} rows={selectedPackage.items.map((i:Row)=>[
            <span className="code">{i.code}</span>,
            i.parent_item_id?"套装组件":"主件",
            label(i.custody_state),
            <Tag tone={i.inspection_stage==="in_inspection"?"yellow":i.inspection_stage==="inspected"?"green":"gray"}>{label(i.inspection_stage??"pending")}</Tag>,
            <span className="code">{i.location??"—"}</span>,
            <div className="actions">
              <a className="button sm primary" href="#item-intake" onClick={()=>selectItem(i.code)}>同屏核对/绑单</a>
              {["received","stored"].includes(i.custody_state)&&<Form inline key={`mv-${i.id}-${i.revision}`} label="移位" run={async f=>{
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
          ])}/>
          {selectedPackage.parcel.state!=="quarantined"&&<Form key={packageId} label="逐件建档（自动生成无歧义 6 位 Base32 样品码）" run={async f=>{
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
          {selectedPackage.items.length>0&&<div className="card" style={{marginTop:12}}>
            <h3 style={{marginTop:0}}>同屏批量打印本包样品标签与连续扫码回读 ({selectedPackage.items.length} 件)</h3>
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
              const scanned=text(f,"scanned_codes").split(/[\s,，;；]+/).map(s=>s.trim()).filter(Boolean);
              const expected=selectedPackage.items.map((i:Row)=>i.code);
              const res=await request("/staff/labels/verify","POST",{expected_codes:expected,scanned_codes:scanned});
              setBatchVerifyResult(res);
            }}>
              <Field name="scanned_codes" label="依次扫描贴好后的样品码（空格或逗号分隔）" value={selectedPackage.items.map((i:Row)=>i.code).join(" ")}/>
            </Form>
            {batchVerifyResult&&<p className="notice" role="status">批量回读核验通过：共 {batchVerifyResult.verified_count} 件样品条码与数据库 100% 一致。</p>}
          </div>}
          <details className="card" style={{marginTop:12}}>
            <summary>实收件数与申报不符 / 多包裹分批在途登记</summary>
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
                  label:`${o.public_no}（申报 ${o.total_declared_qty} 件 · 已收 ${o.cumulative_received_qty} 件）`,
                }))}
              />}
              <div className="fields three">
                <Field name="expected_qty" label="订单申报总件数" type="number" min={1} value={selectedPackage.intake_context?.total_declared_qty||selectedPackage.parcel.received_quantity||1}/>
                <Field name="actual_qty" label="本包实收件数" type="number" min={0} value={selectedPackage.parcel.received_quantity||0}/>
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
          </details>
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
        {item&&!itemDetail.error&&<ItemIdentity data={itemDetail.data!} onSave={()=>{itemDetail.reload();packageDetail.reload();reload();}}/>}
      </Panel>
    </>}
    {current==="packages"&&<>
      <Panel title="外箱及实收包裹列表" subtitle="点击包裹编号进入单包明细，或点击原始运单号直接弹窗查看物流轨迹。">
        <Table headers={["包裹编号","原始运单","实收件数","入库状态","操作"]} rows={data.packages.map((parcel:Row)=>[
          <Link className="code" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>{parcel.code}</Link>,
          parcel.tracking_norm?<CodeButton code={parcel.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:parcel.tracking_norm})}/>:<span className="muted">—</span>,
          `${parcel.received_quantity} 件`,
          <Tag tone="green">{label(parcel.state)}</Tag>,
          <Link className="button sm" href={"/wh/packages/"+encodeURIComponent(parcel.code)}>包裹详情</Link>,
        ])} empty="暂无实收包裹记录，请前往收货入库登记。"/>
      </Panel>
    </>}
    {current==="samples"&&<>
      <Panel title="在库样品与实物清单" subtitle="逐件独立编号，绑定客户委托位置前须完成身份核对；检中与已检商品及确认样专区状态实时标识。">
        <Table headers={["样品码","当前库位","库存状态","质检进度","作业入口"]} rows={data.items.slice(0,30).map((it:Row)=>[
          <Link className="code" href={"/wh/samples/"+encodeURIComponent(it.code)}>{it.code}</Link>,
          <span className="code">{it.location??"待上架"}</span>,
          <Tag tone="green">{label(it.custody_state)}</Tag>,
          <Tag tone={it.inspection_stage==="in_inspection"?"yellow":it.inspection_stage==="inspected"?"green":"gray"}>{label(it.inspection_stage??"pending")}</Tag>,
          <div className="actions">
            <Link className="button sm" href={"/wh/samples/"+encodeURIComponent(it.code)}>样品详情</Link>
            <Link className="button sm" href={"/wh/storage?"+new URLSearchParams({item:it.code})}>移到库位</Link>
          </div>,
        ])} empty="暂无在库样品记录。"/>
      </Panel>
      <Panel title="按编号快速核对样品" id="sample-quick-lookup">
        <Form inline label="定位实物" run={async f=>selectItem(text(f,"item_code"))}>
          <Field name="item_code" label="扫描或输入样品码 S-..."/>
        </Form>
        {itemCode&&itemDetail.error&&<ErrorBlock error={itemDetail.error}/>}
        {item&&!itemDetail.error&&<ItemIdentity data={itemDetail.data!} onSave={()=>{itemDetail.reload();reload();}}/>}
      </Panel>
    </>}
    {current==="inspection"&&<>
      <Panel title="待处理任务" subtitle="同一任务的并发领取在服务端只产生一个有效作业会话。">
        <Form inline label="扫码定位任务" run={async f=>{
          const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"scan_code")}));
          location.assign("/wh/task/"+hit.task_id);
        }}><Field name="scan_code" label="扫描或输入样品码 S-... / 订单号 QW-..."/></Form>
        {!groups.length&&<Empty>暂无可领取任务。付款并核对到齐后自动进入队列。</Empty>}
        {groups.map(ts=><div key={ts[0].order_id} className="card">
          <div className="row">
            <h3>{ts[0].public_no} · {ts[0].category_labels?.["zh-CN"]??"商品"} · {ts.length} 项任务</h3>
            <span>{ts[0].sla_overdue?<Tag tone="red">SLA 已超时</Tag>:<span className="muted small">SLA 截止：{stamp(ts[0].sla_due_at)}</span>}</span>
          </div>
          <Table headers={["物件或组","服务","状态","操作"]} rows={ts.map(t=>[
            <span className="code">{t.item_code??"比较组"}</span>,t.title["zh-CN"],<Tag>{label(t.state)}</Tag>,
            <Link className="button sm" href={"/wh/task/"+t.id}>进入工作台</Link>
          ])}/>
          {canInspect&&ts.every(t=>t.state==="SUBMITTED")&&ts.some(t=>t.assignee_id===actor.id)&&<Action primary run={async()=>{
            const res=await request("/staff/inspection-tasks/"+ts[0].id);
            await request("/staff/orders/"+ts[0].order_id+"/report/submit","POST",{revision:res.order_revision,task_ids:ts.map(t=>t.id)});reload();
          }}>汇总并提交报告</Action>}
        </div>)}
      </Panel>
    </>}
    {current==="execute"&&<>
      <Panel title="选择或扫描检查任务" subtitle="扫描样品标签或从下方待执行任务直接进入检查录入工作台。">
        <Form inline label="打开检查工作台" run={async f=>{
          const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"scan_code")}));
          location.assign("/wh/task/"+hit.task_id);
        }}><Field name="scan_code" label="样品码 S-... / 订单号 QW-..."/></Form>
        <Table headers={["关联订单","样品码","服务类型","当前状态","操作"]} rows={data.tasks.map((t:Row)=>[
          <span className="code">{t.public_no}</span>,
          <span className="code">{t.item_code??"对比组"}</span>,
          t.title?.["zh-CN"]??t.service,
          <Tag>{label(t.state)}</Tag>,
          <Link className="button sm primary" href={"/wh/task/"+t.id}>进入执行检查</Link>,
        ])} empty="当前没有待执行的检查任务。"/>
      </Panel>
    </>}
    {current==="sync"&&<OfflineSyncQueue tasks={data.tasks}/>}
    {current==="dispatch"&&<>
      {canShip?<><DispatchQueue onOpenDrawer={setDrawer}/>
      {!!data.retain.length&&<Panel title="续存报价">
        {data.retain.map((i:Row)=><p key={i.id}><CodeButton code={i.code} onClick={()=>setDrawer({kind:"item",ref:i.code})}/> {typeof i.days==="number"?`客户申请 ${i.days} 天 · `:""}<Action run={async()=>{await request("/staff/dispositions/"+i.id+"/storage-quote","POST",{});reload();}}>{i.renewal?"重新报价":"生成续存报价"}</Action></p>)}
      </Panel>}</>:<Panel title="出库待办"><p className="muted">当前演示角色无出库交接权限，请切换为“仓管”或“超级管理员”查看并操作发运批次。</p></Panel>}
    </>}
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </>;
}

function OfflineSyncQueue({tasks}:{tasks:Row[]}) {
  const [entries,setEntries]=useState<{key:string;taskId:string;count:number}[]>([]);
  useEffect(()=>{
    const found:{key:string;taskId:string;count:number}[]=[];
    try {
      for(let i=0;i<localStorage.length;i++) {
        const key=localStorage.key(i);
        if(key?.startsWith("qcw_task_draft_")) {
          const parsed=JSON.parse(localStorage.getItem(key)??"[]");
          if(Array.isArray(parsed)&&parsed.length>0) found.push({key,taskId:key.slice("qcw_task_draft_".length),count:parsed.length});
        }
      }
    } catch {}
    setEntries(found);
  },[]);
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
function DispatchQueue({onOpenDrawer}:{onOpenDrawer?:(t:StaffObjectTarget)=>void}) {
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
      <label>批次 ID 或实际运单<input name="reference" defaultValue={reference} maxLength={64}/></label>
      <button type="submit" className="button primary">查批次</button>
      {reference&&<Link className="button" href={"/wh/dispatch?"+new URLSearchParams({state})}>清除编号</Link>}
      <button type="button" className="button" onClick={reload}>刷新</button>
    </form>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在查询批次…</p>}
    {data&&!error&&<Table headers={["批次编号","去向与状态","实物进度","关联运单","退货 / 报价截止","操作"]} rows={data.rows.map((batch:Row)=>[
      <div className="cell-stack">
        <Link className="code" href={"/wh/dispatch/"+batch.id} title={batch.id}>#{String(batch.id).slice(0,8)}</Link>
        {onOpenDrawer&&<small><button type="button" className="code-btn" onClick={()=>onOpenDrawer({kind:"batch",ref:batch.id})}>速览清单</button></small>}
      </div>,
      <div className="cell-stack">
        <strong>{dispatchAction(batch.action)}</strong>
        <div><Tag>{label(batch.state)}</Tag></div>
      </div>,
      <div className="cell-stack">
        <span>待发 <strong>{batch.remaining}</strong> · 已装箱 <strong>{batch.packed}</strong></span>
        <small>已交接 {batch.shipped}{batch.returns?` · 退回 ${batch.returns}`:""}</small>
      </div>,
      (batch.waybills?.length)?<div className="actions">
        {(batch.waybills as string[]).map(wb=>onOpenDrawer
          ?<CodeButton key={wb} code={wb} onClick={()=>onOpenDrawer({kind:"tracking",ref:wb})}/>
          :<span key={wb} className="code">{wb}</span>)}
      </div>:<span className="muted">—</span>,
      <div className="cell-stack">
        <span>退货：{stamp(batch.return_deadline)}</span>
        <small>报价：{stamp(batch.expires_at)}</small>
      </div>,
      <Link className="button sm primary" href={"/wh/dispatch/"+batch.id}>进入作业 →</Link>,
    ])} empty="这个状态下暂无符合条件的批次。"/>}
  </Panel>;
}
function PackParcel({batch,parcel,reload}:{batch:Row;parcel:Row;reload:()=>void}) {
  const expected=parcel.item_ids.map((id:string)=>batch.items.find((item:Row)=>item.id===id));
  if(expected.some((item:Row|undefined)=>!item))return <ErrorBlock error="报价内实物已变更，请刷新核对批次。"/>;
  return <div className="card">
    <h3>待装箱 · {parcel.item_ids.length} 件 · {parcel.weight_g} 克</h3>
    <ScanAndSubmit items={expected} label="确认装箱" run={async fields=>{
      const photo=await upload(fields.get("photo"),"dispatch");
      await request("/staff/dispatch-batches/"+batch.id+"/parcels","POST",{
        revision:batch.revision,quote_id:batch.quote_id,item_ids:parcel.item_ids,
        weight_g:parcel.weight_g,packed_media_ids:[photo],
      });reload();
    }}/>
  </div>;
}
function ScanAndSubmit({items,label,run,children}:{items:Row[];label:string;run:(fields:FormData)=>Promise<void>;children?:ReactNode}) {
  const [scanned,setScanned]=useState<string[]>([]);
  return <>
    <div className="card">
      <p><strong>逐件核对</strong> · {scanned.length} / {items.length}</p>
      <Form inline label="核对实物" run={async fields=>{
        const item=items.find(i=>i.code.toUpperCase()===text(fields,"scan").toUpperCase());
        if(!item)throw new Error("该实物不在本包裹清单，请核对包裹。");
        if(scanned.includes(item.id))throw new Error("该实物已核对。");
        setScanned(previous=>[...previous,item.id]);
      }}><Field name="scan" label="扫描或输入实物码"/></Form>
      <ul>{items.map(item=><li key={item.id}><span className="code">{item.code}</span> · {scanned.includes(item.id)?"已核对":"待核对"}</li>)}</ul>
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
export function WarehouseDispatchBatch({id}:{id:string}) {
  const {data,error,reload}=useLoad("/staff/dispatch-batches/"+id);
  const carriers=useLoad("/carriers");
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const b=data?.batch;
  return <>
    <div className="page-head row"><div><Link href="/wh/dispatch">← 出库队列</Link>
      <p className="eyebrow report-eyebrow">WAREHOUSE / DISPATCH BATCH</p><h1>发运批次</h1>
      <p className="code">{id}</p>{b&&<p><Tag>{label(b.state)}</Tag> · {dispatchAction(b.action)}</p>}</div>
      <div className="head-actions"><button type="button" className="button sm" onClick={reload}>刷新批次状态</button></div></div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">正在读取批次…</p>}
    {data&&!error&&<>
      <Panel title="客户授权去向">
        <p>{b.destination_snapshot.recipient} · {b.destination_snapshot.phone}</p>
        <p>{b.destination_snapshot.address}</p>
        {b.destination_snapshot.member_code&&<p>集运会员码 <span className="code">{b.destination_snapshot.member_code}</span></p>}
        {b.quote_id&&<p>报价版本 {b.quote_revision} · {usd(b.amount_cents)} · 到期 {stamp(b.expires_at)}</p>}
      </Panel>
      {(b.state==="confirmed"||b.renewable_quote)&&<Panel title="称重与逐包报价">
        {b.renewable_quote&&<p className="notice">旧报价已过期，且无待核对的付款。请按实际包裹重新报价。</p>}
        <DispatchQuoteForm key={b.revision} batch={b} rates={data.rates} reload={reload}/>
      </Panel>}
      {b.state==="quoted"&&!b.renewable_quote&&<p className="notice">等待客户接受报价或渠道确认付款。</p>}
      {b.state==="paid"&&<Panel title="待装箱包裹">
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
          {s.state==="packed"&&<ScanAndSubmit key={s.revision} items={s.items} label="确认已交给快递" run={async fields=>{
            const photo=await upload(fields.get("photo"),"dispatch");
            await request("/staff/shipments/"+s.id+"/handover","POST",{
              revision:s.revision,item_ids:s.items.map((i:Row)=>i.id),carrier_code:text(fields,"carrier"),
              tracking_no:text(fields,"tracking"),evidence_ids:[photo],handed_at:new Date().toISOString(),
            });reload();
          }}>
            {carriers.error&&<ErrorBlock error={carriers.error}/>}
            <Select name="carrier" label="实际承运商" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}))}/>
            <Field name="tracking" label="实际寄出运单号"/>
          </ScanAndSubmit>}
          {s.shipped_at&&<p>实际交接 {stamp(s.shipped_at)} · {s.carrier_code} {s.tracking_norm?<CodeButton code={s.tracking_norm} onClick={()=>setDrawer({kind:"tracking",ref:s.tracking_norm})}/>:"—"}</p>}
          {s.shipped_at&&<details><summary>查看中文物流轨迹 · {label(s.transport_state??"unknown")}</summary>
            <p>同步状态 {label(s.sync_state??"unknown")} · 更新 {stamp(s.tracking_updated_at)}</p>
            <ol className="timeline">{(s.tracking_events??[]).map((event:Row)=><li key={event.id}>{stamp(event.occurred_at)} · {event.text}</li>)}</ol>
            {!s.tracking_events?.length&&<Empty>尚无中文轨迹。</Empty>}
          </details>}
          {["shipped","delivered"].includes(s.state)&&s.items.some((i:Row)=>!i.received_at)&&<details>
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
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
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
        item_ids:items.filter(item=>Number(fields.get("parcel-"+item.id)??1)===number).map(item=>item.id),
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
    {count>1&&<div className="dispatch-assignment" key={count}>{items.map(item=><Select key={item.id} name={"parcel-"+item.id}
      label={"实物 "+item.code+" 所在包裹"} choices={parcelNumbers.map(number=>({id:String(number),label:"包裹 "+number}))}/>)}</div>}
    <div className="dispatch-assignment">{parcelNumbers.map(number=><div key={number} className="fields">
      <Field label={"包裹 "+number+" 实重（克）"} name={"weight-"+number} type="number" min={1}/>
      {manualMode&&<Field label={"包裹 "+number+" 核定运费 (USD)"} name={"manual-usd-"+number} type="number" min={0} step="0.01"/>}
    </div>)}</div>
    {manualMode&&<Field label="人工核价原因说明（客户与审计可见）" name="manual_reason" value="超体积抛重或偏远派送附加费人工核定"/>}
  </Form>;
}
export function TaskView({id,actor}:{id:string;actor:Row}) {
  const {data,error,reload}=useLoad("/staff/inspection-tasks/"+id);
  const draftKey="qcw_task_draft_"+id;
  const [drafts,setDrafts]=useState<Row[]>([]);
  const [conflict,setConflict]=useState<{localRevision:number;serverRevision:number;message:string}|null>(null);
  const [online,setOnline]=useState(true);
  const [checkFilter,setCheckFilter]=useState<"all"|"pending"|"issue"|"done">("all");
  const [expandedKeys,setExpandedKeys]=useState<Record<string,boolean>>({});
  const [annotationsByKey,setAnnotationsByKey]=useState<Record<string,DefectAnnotation[]>>({});
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
  function saveLocalDrafts(next:Row[]) {
    setDrafts(next);
    try {
      if(next.length) localStorage.setItem(draftKey,JSON.stringify(next));
      else localStorage.removeItem(draftKey);
    } catch {}
  }
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>正在加载检查项…</p>;
  const writable=data.state==="IN_PROGRESS"&&data.assignee_id===actor.id;
  const completeness=data.completeness??{ok:true,missing:[]};
  const allChecks=data.components.flatMap((m:Row)=>
    data.content.checks.filter((c:Row)=>Boolean(data.group_id)||!c.component||c.component===m.id).map((c:Row)=>{
      const attempts=data.results.filter((r:Row)=>r.item_key===c.key&&r.component===m.id);
      const prev=attempts.find((r:Row)=>r.is_final)??attempts.at(-1);
      const retryNeeded=attempts.some((r:Row)=>r.details?.retry_required) && attempts.length<3;
      const isIssue=Boolean(retryNeeded || prev?.details?.uncertain || (prev && ["OBSERVED_ISSUE","BLOCKED"].includes(prev.status)));
      const isDone=Boolean(prev && !retryNeeded && !prev?.details?.uncertain);
      return {m,c,attempts,prev,retryNeeded,isIssue,isDone};
    })
  );
  const doneCount=allChecks.filter((x:Row)=>x.isDone).length;
  const issueCount=allChecks.filter((x:Row)=>x.isIssue).length;
  const pendingCount=allChecks.length-doneCount;
  const syncAllDrafts=async()=>{
    try {
      await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:drafts});
      saveLocalDrafts([]);reload();
    } catch(e) {
      if(e instanceof RequestError && e.code==="VERSION_CONFLICT") {
        const fresh=await request("/staff/inspection-tasks/"+id);
        setConflict({localRevision:data.revision,serverRevision:fresh.revision,message:e.message});
        return;
      }
      throw e;
    }
  };
  return <><div className="page-head row"><div><p className="eyebrow">WAREHOUSE / INSPECTION WORKBENCH</p><h1 className="code">{data.public_no}</h1>
      <p className="muted">{data.item_code??"对比组"} · {label(data.state)} · 模板版本 <span className="code">{String(data.template_version_id).slice(0,8)}</span> · SLA {stamp(data.sla_due_at)}</p></div>
      <div className="actions"><Tag>{online?"网络在线":"离线草稿模式"}</Tag>{drafts.length>0&&<Tag>待同步草稿 {drafts.length} 项</Tag>}<Link className="button" href="/wh/inspection">返回检查队列</Link></div></div>
    {data.review_feedback&&<div className="notice"><strong>复核退回</strong><p>{data.review_feedback}</p></div>}
    {conflict&&<Panel title="断网重连与版本冲突处理">
      <p className="notice">检测到服务端版本已更新（本机基线 v{conflict.localRevision} vs 服务端 v{conflict.serverRevision}）：{conflict.message}</p>
      <div className="actions">
        <Action primary run={async()=>{
          const fresh=await request("/staff/inspection-tasks/"+id);
          await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:fresh.revision,results:drafts});
          saveLocalDrafts([]);setConflict(null);reload();
        }}>拉取最新基线并合并重放本机草稿（{drafts.length} 项）</Action>
        <Action run={async()=>{saveLocalDrafts([]);setConflict(null);reload();}}>放弃本机草稿并采用服务端版本</Action>
      </div>
    </Panel>}
    {drafts.length>0&&!conflict&&writable&&<Panel title="本机离线草稿与待同步队列">
      <p className="muted small">已暂存 {drafts.length} 条检查项结果在本机浏览器，断网不丢失，恢复在线后可一键幂等批量同步。</p>
      <div className="actions">
        <Action primary run={syncAllDrafts}>立即同步全部本机草稿</Action>
        <Action run={async()=>saveLocalDrafts([])}>清空本机草稿</Action>
      </div>
    </Panel>}
    {(data.sibling_tasks?.length??0)>1&&<Panel title="同单逐件任务切换与扫码跳转">
      <Form inline label="扫码切换样品" run={async f=>{
        const hit=await request("/staff/inspection-tasks/lookup?"+new URLSearchParams({code:text(f,"item_scan"),order_id:data.order_id}));
        location.assign("/wh/task/"+hit.task_id);
      }}><Field name="item_scan" label="扫描同单样品码 S-..."/></Form>
      <div className="actions">
        {data.sibling_tasks.map((st:Row)=><Link key={st.id} className={st.id===id?"button primary":"button"} href={"/wh/task/"+st.id}>
          {st.item_code??("位置 #"+(st.position??"")) } · {label(st.state)}
        </Link>)}
      </div>
    </Panel>}
    {data.state==="READY"&&actor.roles.some((r:string)=>["inspector","super_admin"].includes(r))&&<Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/start","POST",{revision:data.revision});reload();}}>领取并开始</Action>}
    <Panel title="检查进度与视图筛选">
      <div className="row">
        <div>
          <strong>已完成 {doneCount} / {allChecks.length} 项检查</strong>
          <span className="muted"> · 必拍机位 {(data.shots??[]).length} 张 · 剩余待补齐 {completeness.missing.length} 项</span>
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
    {data.content.diagram&&<Panel title="标准测量部位与机位示意图">
      <div className="row" style={{alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <img src={data.content.diagram} alt="标准测量部位示意图" style={{maxWidth:360,border:"1px solid #cbd5e1",borderRadius:8,background:"#fff"}}/>
        <div className="small muted">
          <p><strong>示意图操作规范：</strong></p>
          <ul>
            <li>严格按红色标注线所示起止点自然平铺无拉伸测量。</li>
            <li>每个数值尺寸项需连续测量 2 次（差值 ≤0.5cm 取均值，超差触发第 3 次复核）。</li>
            <li>发现瑕疵部位请选择对应部位编码，并在照片上进行非破坏性框选标注（保留原图不覆写）。</li>
          </ul>
        </div>
      </div>
    </Panel>}
    {data.components.map((m:Row)=><Panel key={m.id} title={m.id==="main"?(data.item_code??"实物"):m.code}>
      {data.content.checks.filter((c:Row)=>Boolean(data.group_id)||!c.component||c.component===m.id).map((c:Row)=>{
        const rowKey=`${m.id}:${c.key}`;
        const attempts=data.results.filter((r:Row)=>r.item_key===c.key&&r.component===m.id);
        const prev=attempts.find((r:Row)=>r.is_final)??attempts.at(-1);
        const retryNeeded=attempts.some((r:Row)=>r.details?.retry_required) && attempts.length<3;
        const isIssue=Boolean(retryNeeded || prev?.details?.uncertain || (prev && ["OBSERVED_ISSUE","BLOCKED"].includes(prev.status)));
        const isDone=Boolean(prev && !retryNeeded && !prev?.details?.uncertain);
        const currentAnnotations:DefectAnnotation[]=annotationsByKey[rowKey]??(Array.isArray(prev?.details?.annotations)?prev.details.annotations:[]);
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
        const availParts:string[]=c.parts?.length?c.parts:(data.content.parts??[]);
        return <div className="card" key={c.key} id={`comp-${m.id}-${c.key}`}>
          <div className="row">
            <div>
              <h3 style={{margin:0}}>{c.zh} · {c.label}</h3>
              <p className="muted small" style={{margin:"4px 0 0"}}>{c.method}{c.unit?" · 单位 "+c.unit:""}{c.diagram?" · 示意图 "+c.diagram:""}</p>
            </div>
            <div className="actions">
              {writable && c.type!=="number" && !c.evidence && !prev && <Action sm run={async()=>{
                const payload={item_key:c.key,component:m.id,attempt:1,status:"NOT_OBSERVED",is_final:true,method:c.method};
                if(!online) { saveLocalDrafts([...drafts,payload]); return; }
                await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:[payload]});
                reload();
              }}>快速记为未见异常</Action>}
              {isDone&&<button type="button" className="button sm" onClick={()=>setExpandedKeys(s=>({...s,[rowKey]:false}))}>收起</button>}
            </div>
          </div>
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
          {writable&&<Form label="保存该项" run={async f=>{
            const status=text(f,"status"),value=text(f,"value"),reason=text(f,"reason"),photo=f.get("photo");
            const severity=text(f,"severity"),partCode=text(f,"part_code"),offlineSave=checked(f,"save_offline");
            const uploaded=photo instanceof File&&photo.size?[await upload(photo,"shot")]:[];
            const evidence=uploaded.length?uploaded:(prev?.evidence_ids??[]);
            if(status==="RECORDED"&&!value)throw new Error("录入实际值，或明确选择无法检查。");
            const typed=c.type==="number"?Number(value):c.type==="boolean"?value==="true":value;
            const details:Record<string,unknown>={
              ...(severity?{severity}:{}),
              ...(partCode?{part_code:partCode}:{}),
              ...(reason?{note:reason}:{}),
              ...(currentAnnotations.length?{annotations:currentAnnotations}:{}),
            };
            const payload={
              item_key:c.key,component:m.id,attempt:(attempts.at(-1)?.attempt??0)+1,status,is_final:true,method:c.method,
              ...(status==="RECORDED"?{typed_value:typed,...(c.unit?{unit:c.unit}:{})}:{}),
              ...(reason?{reason}:{}),
              ...(Object.keys(details).length?{details}:{}),
              ...(evidence.length?{evidence_ids:evidence}:{}),
            };
            if(offlineSave || !online) {
              saveLocalDrafts([...drafts.filter(d=>!(d.item_key===payload.item_key&&d.component===payload.component&&d.attempt===payload.attempt)),payload]);
              return;
            }
            try {
              await request("/staff/inspection-tasks/"+id+"/results","PUT",{revision:data.revision,results:[payload]});
              setExpandedKeys(s=>({...s,[rowKey]:false}));
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
            {c.type==="boolean"?<Select name="value" label="观察值" required={false} choices={[{id:"true",label:"是"},{id:"false",label:"否"}]}/>:
              <Field name="value" label="实际值" required={false} value={prev?.typed_value??""} type={c.type==="number"?"number":"text"} step="any"/>}
            <Select name="severity" label="严重度（发现问题时必填）" required={false} choices={[
              {id:"attention",label:"Attention（需留意）"},{id:"material_issue",label:"Material issue（明显缺陷）"},{id:"uncertain",label:"Uncertain（不确定）"}
            ]}/>
            {availParts.length>0&&<Select name="part_code" label="缺陷部位" required={false} choices={availParts.map((p:string)=>({id:p,label:p}))}/>}
            <Field name="reason" label="观察说明或缺测原因（支持中文录入，复核时译为英文）" value={prev?.reason??""} required={false}/>
            <label>证据照片{c.evidence?"（提交前必填）":""}<FileInput name="photo" accept="image/*"/></label>
            <label className="check"><input type="checkbox" name="save_offline"/>暂存到本机离线队列（稍后批量同步）</label>
          </Form>}
        </div>;
      })}
      {(data.content.shots??[]).filter((s:Row)=>Boolean(data.group_id)||!s.component||s.component===m.id).map((s:Row)=>{
        const existing=(data.shots??[]).find((x:Row)=>x.shot_code===s.code&&(x.component??"main")===m.id);
        return <div className="card" key={s.code} id={`comp-${m.id}-${s.code}`}>
          <div className="row">
            <h3 style={{margin:0}}>必拍机位：{s.zh??s.name} · <span className="code">{s.code}</span></h3>
            {existing?<div className="actions"><Tag>已上传</Tag><MediaButton ids={[existing.id]} labels={[`${s.zh??s.name} (${s.code})`]} label="查看机位照片"/></div>:<span className="muted small">尚未上传本组件该机位照片</span>}
          </div>
          {writable&&<Form label="上传组件必拍照" run={async f=>{
            const mediaId=await upload(f.get("photo"),"shot");
            await request("/staff/inspection-tasks/"+id+"/shots","POST",{revision:data.revision,component:m.id,shot_code:s.code,media_id:mediaId});
            reload();
          }}><Photo label="选择或拍摄机位照"/></Form>}
        </div>;
      })}
    </Panel>)}
    {data.group_id&&(data.content.order_shots?.length??0)>0&&<Panel title="对比组同框必拍照">
      {data.content.order_shots.map((code:string)=>{
        const existing=(data.shots??[]).find((x:Row)=>x.shot_code===code&&["group","order","main",null].includes(x.component));
        return <div className="card" key={code} id={`comp-group-${code}`}>
          <div className="row">
            <h3 style={{margin:0}}>对比组机位：<span className="code">{code}</span></h3>
            {existing?<div className="actions"><Tag>已上传</Tag><MediaButton ids={[existing.id]} labels={[`对比组 (${code})`]} label="查看对比组照"/></div>:<span className="muted small">尚未上传该对比组照</span>}
          </div>
          {writable&&<Form label="上传对比组照" run={async f=>{
            const mediaId=await upload(f.get("photo"),"shot");
            await request("/staff/inspection-tasks/"+id+"/shots","POST",{revision:data.revision,component:"group",shot_code:code,media_id:mediaId});
            reload();
          }}><Photo label="拍摄并排对比照"/></Form>}
        </div>;
      })}
    </Panel>}
    <Panel title="提交前完整性检查">
      {completeness.ok?<p><Tag>完整性通过</Tag> 所有必测项、复测、证据照与组件必拍照均已齐全。</p>:<>
        <p className="notice">当前仍有 {completeness.missing.length} 项缺漏，补齐前不可提交任务：</p>
        <ul>{completeness.missing.map((item:Row,idx:number)=><li key={idx}>
          <a href={`#comp-${item.component}-${item.code}`}><strong>{item.sample_id} · {item.label}</strong></a>：{item.hint}
        </li>)}</ul>
      </>}
      {writable&&<Action primary run={async()=>{await request("/staff/inspection-tasks/"+id+"/submit","POST",{revision:data.revision});location.assign("/wh/inspection");}}>提交此任务</Action>}
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

  const renderTrackCustomerAndOrders=(r:Row)=><div className="cell-stack">
    {r.receiving_code&&r.customer_user_id
      ?<Link className="code nowrap" href={`/admin/customers/${r.customer_user_id}`}>{r.receiving_code}</Link>
      :<span className="muted">待归属客户</span>}
    {(r.order_numbers?.length??0)>0&&<div className="actions">
      {(r.order_numbers as string[]).map(no=><Link key={no} className="code nowrap" href={`/admin/orders/${no}`}>{no}</Link>)}
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
            d.receiving_code&&d.customer_user_id?<Link className="code nowrap" href={`/admin/customers/${d.customer_user_id}`}>{d.receiving_code}</Link>:"未归属",
            d.order_no?<Link className="code nowrap" href={`/admin/orders/${d.order_no}`}>{d.order_no}</Link>:"—",
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
            <span key="err" className="small">{e.last_error_code??"—"}</span>,
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
                  <Tag tone="blue">{r.shipment_state==="handed_over"?"已交接承运商":"已打包待交接"}</Tag>
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
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
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
  if(page==="orders") return <>{alertBanner}<AdminOrdersWorkbench deskData={data} reloadDesk={reload}/></>;
  if(page==="dispositions") return <>{alertBanner}<AdminDispositionsWorkbench deskData={data} reloadDesk={reload} actor={actor} terms={terms.data?.terms??[]}/></>;
  if(page==="incidents") return <>{alertBanner}<AdminIncidentsWorkbench/></>;
  if(page==="refunds") return <>{alertBanner}<AdminRefundsWorkbench/></>;
  if(page==="payments") return <>{alertBanner}<AdminPaymentsWorkbench demo={demo}/></>;
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
                superAdmin&&c.status!=="ACTIVE"?(
                  <button key="act" type="button" className="button sm primary nowrap" onClick={()=>setAdmittingCategory(c)}>
                    填写准入并激活 →
                  </button>
                ):superAdmin&&c.status==="ACTIVE"?(
                  <Action key="pa" sm run={async()=>{
                    if(!window.confirm(`确认暂停「${c.labels["zh-CN"]}」对外新建订单？已创建的在途订单仍正常履约。`)) return;
                    await request("/staff/admin/categories/"+c.id+"/status","POST",{status:"PAUSED"});reload();
                  }}>暂停可售</Action>
                ):null,
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

    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
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

export function WarehouseScan() {
  const [match,setMatch]=useState<{title:string;detail:string;link?:string|null;action?:string;allowed?:string[];raw?:Row}>();
  const [cameraNotice,setCameraNotice]=useState<string>();
  const carriers=useLoad("/carriers");
  async function lookupScan(code:string,carrier?:string) {
    setMatch(undefined);
    const query=carrier?"?"+new URLSearchParams({carrier_code:carrier}):"";
    const result=await request("/staff/scan/"+encodeURIComponent(code)+query);
    const actionLabel=result.kind==="package"?"打开包裹详情":result.kind==="item"?
      (result.link?.startsWith("/wh/task/")?"打开质检任务":"打开实物识别"):
      result.kind==="location"?"前往库位移转":
      result.package_id?"打开拆包登记":"前往收货核对";
    setMatch({
      title:result.code,
      detail:result.summary,
      link:result.link,
      action:actionLabel,
      allowed:result.allowed_actions,
      raw:result,
    });
  }
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / SCAN</p><h1>扫码查询</h1>
      <p className="muted">扫描或手输卖家运单、包裹码 (P-)、实物码 (S-) 或库位码 (A-04-02-01 / R-01)。</p></div><Link className="button" href="/wh/intake">收货入库</Link></div>
    <Panel title="查询仓库对象">
      <div className="actions">
        <button type="button" onClick={async()=>{
          setCameraNotice(undefined);
          if(typeof navigator==="undefined" || !navigator.mediaDevices?.getUserMedia) {
            setCameraNotice("当前设备或浏览器未开放相机扫码权限，请使用扫码枪、上传条码图片或下方手动输入。");
            return;
          }
          try {
            const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}});
            stream.getTracks().forEach(t=>t.stop());
            setCameraNotice("相机权限已就绪，请将条码对准取景框、上传条码照片或使用扫码枪直接输入。");
          } catch {
            setCameraNotice("未能获取相机权限，已切换为扫码枪/图片解码/手动输入模式。");
          }
        }}>启用相机扫码</button>
      </div>
      {cameraNotice&&<p className="muted small" role="status">{cameraNotice}</p>}
      <div onChange={()=>setMatch(undefined)}><Form inline label="查询" run={async f=>{
        await lookupScan(text(f,"scan_code"),text(f,"carrier")||undefined);
      }}>
        <Field name="scan_code" label="条码或原始运单号（支持包裹码 / 样品码 / 库位码）"/>
        <Select name="carrier" label="承运商（运单查询）" required={false}
          choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels["zh-CN"]??c.labels.en}))}/>
      </Form></div>
      <Form inline label="从条码图片解码并查询" run={async f=>{
        const file=f.get("barcode_image");
        if(!(file instanceof File)||!file.size) throw new Error("请选择包含 QR 或 Code-128 条码的 PNG 图片。");
        const buf=await file.arrayBuffer();
        const bytes=new Uint8Array(buf);
        let binary="";
        for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]!);
        const res=await request("/staff/scan/decode-image","POST",{image_base64:btoa(binary)});
        await lookupScan(res.decoded_code);
      }}>
        <label>上传条码图像识别 (QR / Code-128)<FileInput name="barcode_image" accept="image/png"/></label>
      </Form>
      {match&&<div className="notice" role="status"><strong className="code">{match.title}</strong><p>{match.detail}</p>
        {match.allowed?.length?<p className="small muted">可执行操作：{match.allowed.join(" · ")}</p>:null}
        {match.raw?.kind==="location"&&match.raw?.location&&<div className="card" style={{marginTop:8}}>
          <strong>库位详情：{match.raw.location.code}（仓区：{match.raw.location.zone} · 占用 {match.raw.location.occupied}/{match.raw.location.capacity??"∞"}）</strong>
          <Table
            headers={["实物码","库存状态","质检阶段","关联订单","操作"]}
            rows={(match.raw.items??[]).map((it:Row)=>[
              <span className="code">{it.code}</span>,
              label(it.custody_state),
              <Tag tone={it.inspection_stage==="in_inspection"?"yellow":it.inspection_stage==="inspected"?"green":"gray"}>{label(it.inspection_stage??"pending")}</Tag>,
              <span className="code">{it.order_number??"—"}</span>,
              <Link className="button sm" href={"/wh/samples/"+encodeURIComponent(it.code)}>查看实物</Link>,
            ])}
            empty="当前库位内无登记样品。"
          />
        </div>}
        {match.link&&<Link className="button" href={match.link}>{match.action}</Link>}</div>}
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
      <Field name="scanned_code" label="扫描贴好后的标签条码以确认一致" value={code}/>
    </Form>
    {verified&&<p className="notice" role="status">标签回读核验通过：<span className="code">{code}</span></p>}
  </Panel>;
}

export function WarehousePackageView({code}:{code:string}) {
  const {data,error,reload}=useLoad("/staff/packages/by-code/"+code);
  const parcel=data?.parcel;
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / PACKAGE RECORD</p><h1>包裹详情</h1>
      <p className="code">{code}</p></div>{parcel&&<Link className="button primary" href={"/wh/intake?package="+parcel.id+"#intake-unpack"}>打开拆包登记</Link>}</div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取包裹…</p>}
    {data&&parcel&&<>
      <div className="ops-columns">
        <Panel title="仓库实收">
          <dl className="location-facts">
            <div><dt>包裹状态</dt><dd><Tag>{label(parcel.state)}</Tag></dd></div>
            <div><dt>外箱状况</dt><dd><Tag>{label(parcel.outer_condition??"intact")}</Tag></dd></div>
            <div><dt>实际入仓时间</dt><dd>{stamp(parcel.received_at)}</dd></div>
            <div><dt>实收件数</dt><dd>{parcel.received_quantity} 件</dd></div>
            <div><dt>外箱实重</dt><dd>{parcel.weight_g==null?"未记录":parcel.weight_g+" 克"}</dd></div>
            <div><dt>存放库位</dt><dd className="code">{parcel.location_code??"未设定"}</dd></div>
            <div><dt>客户收件码</dt><dd className="code">{parcel.receiving_code??"待核验"}</dd></div>
            <div><dt>关联委托</dt><dd className="code">{parcel.order_numbers.join("、")||"尚未关联"}</dd></div>
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
      {data.intake_context&&data.intake_context.orders?.length>0&&<Panel title="客户申报与仓库累计实收对照">
        <p className="small muted">
          订单申报总件数：<strong>{data.intake_context.total_declared_qty}</strong> 件 · 仓库累计已实收：<strong>{data.intake_context.cumulative_received_qty}</strong> 件 · 仍差在途件数：<strong>{data.intake_context.remaining_unreceived_qty??Math.max(0,(data.intake_context.total_declared_qty??0)-(data.intake_context.cumulative_received_qty??0))}</strong> 件 · 在途未到仓预报运单：<strong>{data.intake_context.in_transit_advices_count}</strong> 单
        </p>
        <Table
          headers={["订单号 / 位置","款号","颜色","尺码","供应商","服装子类","申报运单","当前绑定实物"]}
          rows={(data.intake_context.declared_items??[]).map((di:Row)=>[
            <span className="code">{di.order_public_no} #{di.position}</span>,
            <span className="code">{di.sample_code??"—"}</span>,
            di.color??"—",
            di.size??"—",
            di.supplier_alias??"—",
            di.garment_type??"—",
            <span className="code">{di.declared_tracking_no??"—"}</span>,
            di.bound_item_code?<Link className="code" href={"/wh/samples/"+encodeURIComponent(di.bound_item_code)}>{di.bound_item_code}</Link>:<Tag tone="yellow">待绑定</Tag>,
          ])}
          empty="暂无客户逐件申报明细。"
        />
      </Panel>}
      {parcel.state==="unmatched"&&<Panel title="无预报包裹归属核验">
        <p className="muted">若外箱面单写有客户专属收件码（QCW-），上传面单标签照并核验绑定归属。</p>
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
      {parcel.state!=="quarantined"&&<Panel title="禁限品与异常包裹隔离">
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
      <LabelPrintPanel targetType="package" targetId={parcel.id} code={parcel.code}/>
      <Panel title="拆包实物">
        <Table headers={["实物码","类型","库存状态","质检阶段","当前位置",""]} rows={data.items.map((item:Row)=>[
          <span className="code">{item.code}</span>,
          item.parent_item_id?"套装组件":"主件",
          label(item.custody_state),
          <Tag tone={item.inspection_stage==="in_inspection"?"yellow":item.inspection_stage==="inspected"?"green":"gray"}>{label(item.inspection_stage??"pending")}</Tag>,
          item.location??"—",
          <Link href={"/wh/samples/"+encodeURIComponent(item.code)}>核对实物</Link>,
        ])} empty="尚未登记包内实物。"/>
      </Panel>
    </>}
  </>;
}

function ItemIdentity({data,onSave}:{data:Row;onSave:()=>void}) {
  const {item}=data;
  const positions:Row[]=data.positions;
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
  return <>
    <div className="notice">
      <strong className="code">{item.code}</strong> · {label(item.custody_state)} · 身份状态 {label(item.identity_state)} · 质检进度 <Tag tone={item.inspection_stage==="in_inspection"?"yellow":item.inspection_stage==="inspected"?"green":"gray"}>{label(item.inspection_stage??"pending")}</Tag> · 库位 <span className="code">{item.location??"未登记"}</span>
      <p>实收包裹 <Link href={"/wh/packages/"+item.package_code}>{item.package_code}</Link>{item.source_tracking_no?<> · 实际入库运单 <span className="code">{item.source_tracking_no}</span></>:null}{item.order_number?" · 委托 "+item.order_number:" · 无委托实物"}</p>
      {item.components?.length>0&&<p className="small">包含套装组件：{item.components.map((c:Row)=>c.code).join("、")}</p>}
      {item.is_reference_sample&&<p><Tag tone="yellow">确认样核对委托 (Golden Sample · 铅封 {item.reference_seal_code??"—"})</Tag></p>}
      {item.reference_sample_state==="pending_safe_storage"&&<p><Tag tone="yellow">待转入 REF_SAFE 确认样专柜 · 铅封号 {item.reference_seal_code??"待分配"}</Tag></p>}
      {item.reference_zone_warning&&<p className="bad"><strong>确认样库位告警：</strong>{item.reference_zone_warning}</p>}
      {!item.ownership_verified&&<p>待核验客户归属。完成认领后才能关联委托。</p>}
    </div>
    {item.declared_fields&&<div className="card">
      <strong>客户委托申报信息（位置 #{item.expected_position}）</strong>
      <p className="small">
        款号/编号：<span className="code">{item.declared_summary?.sample_code||item.declared_fields.sample_code||"—"}</span> · 颜色：{item.declared_summary?.color||item.declared_fields.color_declared||item.declared_fields.color||"—"} · 尺码：{item.declared_summary?.size||item.declared_fields.size_label||item.declared_fields.size||"—"} · 供应商：{item.declared_summary?.supplier_alias||item.declared_fields.supplier_alias||"—"} · 服装子类：{item.declared_summary?.garment_type||item.declared_fields.garment_type||"—"} · 申报运单：<span className="code">{item.declared_summary?.declared_tracking_no||item.declared_fields.tracking_no||item.declared_fields.source_tracking_no||"—"}</span>
      </p>
      {item.declared_fields.mismatch_note&&<p className="bad small">当前登记不符：{item.declared_fields.mismatch_note}</p>}
    </div>}
    {item.can_identify&&<details className="card" open={item.identity_state==="mismatch"}>
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
    {positions.length>0?<>
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
    </>:item.ownership_verified&&!item.order_number&&<Empty>当前实物没有可绑定的委托位置（可保留为无委托实物或由客户直接发起退回/转运）。</Empty>}
    {item.can_unassign&&<details className="card">
      <summary>解除当前委托绑定（跨本人订单重新映射）</summary>
      <Form label="确认解除委托位置关联" run={async f=>{
        await request("/staff/items/"+item.id+"/unassign","POST",{revision:item.revision,reason:text(f,"reason")});
        onSave();
      }}>
        <Field name="reason" label="解除并重新映射原因"/>
      </Form>
    </details>}
    {item.movable&&<Link className="button" href={"/wh/storage?"+new URLSearchParams({item:item.code})}>移转此实物</Link>}
  </>;
}

export function WarehouseItemView({code}:{code:string}) {
  const {data,error,reload}=useLoad("/staff/items/by-code?"+new URLSearchParams({code}));
  return <>
    <div className="page-head row"><div><p className="eyebrow">WAREHOUSE / ITEM RECORD</p><h1>实物建档与识别</h1>
      <p className="code">{code}</p></div><Link className="button" href="/wh/scan">返回扫码</Link></div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取实物…</p>}
    {data&&!error&&<>
      <Panel title="库存与委托"><ItemIdentity data={data} onSave={reload}/></Panel>
      <LabelPrintPanel targetType="item" targetId={data.item.id} code={data.item.code}/>
    </>}
  </>;
}
