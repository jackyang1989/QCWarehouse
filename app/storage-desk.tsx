"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Action, checked, CodeButton, Empty, ErrorBlock, Field, Form, MediaButton, ModalDrawer, Panel, Photo, request, Select, StaffObjectDrawer, type StaffObjectTarget, stamp, Table, Tag, text, upload, useLoad, usd, type Row } from "./ui";
import { StatusBanner, WarehouseItemLifecycleTags } from "./admin-labels";

const zones:Record<string,string>={
  receiving:"收货区",queue:"待检区",inspecting:"检查区",post_inspection:"检后存放区",
  reference:"确认样区",unmatched:"未认领区",quarantine:"隔离区",
};
const zoneChoices=Object.entries(zones).map(([id,label])=>({id,label}));

export function StorageLocations({warehouseLinks}:{warehouseLinks:[string,string][]}) {
  const api="/staff/admin/storage/locations";
  const {data,error,reload}=useLoad(api);
  const [query,setQuery]=useState("");
  const [status,setStatus]=useState("");
  const [result,setResult]=useState<{added:Row[];skipped:string[]}>();
  const [printedLoc,setPrintedLoc]=useState<{print_id:string;code:string}>();
  const [detailLocId,setDetailLocId]=useState<string>("");
  const locDetail=useLoad(detailLocId?`/staff/admin/storage/locations/${detailLocId}`:null);
  const locations:Row[]=data?.rows??[];
  const active=locations.filter(location=>location.active).length;
  const unconfiguredCapLocs=locations.filter(l=>l.active && (l.capacity===null || l.capacity===undefined));
  const congestedLocs=locations.filter(l=>l.active && ((l.capacity && l.occupied>=l.capacity) || (l.zone==="receiving" && l.occupied>=20)));
  const visible=locations.filter(location=>location.code.toUpperCase().includes(query.trim().toUpperCase())&&
    (!status||location.active===(status==="active")));
  return <>
    <div className="page-head row"><div><h1>库位管理与容量负载监控</h1>
      <p className="muted">维护仓库物理分区、启用状态、容量上限与积压告警；点击任意库位可在下方全宽展开在位实物清单与移库流转记录。</p></div>
      <div className="head-actions">{warehouseLinks.filter(([href])=>href==="/wh/intake"||href==="/wh/storage").map(([href,name])=>
        <Link className="button sm" href={href} key={href}>{name}</Link>)}
        <button type="button" className="button sm" onClick={reload}>刷新库位</button>
      </div></div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!data&&!error&&<p role="status">正在读取库位…</p>}
    {data&&<>
      {(congestedLocs.length>0 || unconfiguredCapLocs.length>0)&&<StatusBanner tone="warning" title="库位容量与收货暂存区积压巡检提示">
        {congestedLocs.length>0&&<span>检测到 <strong>{congestedLocs.map(l=>`${l.code}(${l.occupied}件)`).join("、")}</strong> 处于满载或收货暂存高积压状态，请及时安排拆包核身并移入待检货架；</span>}
        {unconfiguredCapLocs.length>0&&<span>当前有 <strong>{unconfiguredCapLocs.length} 个功能区库位（{unconfiguredCapLocs.map(l=>l.code).join("、")}）</strong>未设固定容量上限（开放式暂存区）。</span>}
      </StatusBanner>}
      <div className="metric-strip" aria-label="库位概览">
        <div className="metric"><span>库位档案总数</span><strong>{locations.length}</strong><small>已启用 {active} 个 · 停用 {locations.length-active} 个</small></div>
        <div className="metric"><span>全仓在位实物总数</span><strong>{locations.reduce((sum,row)=>sum+row.occupied,0)}</strong><small>当前绑定库位的在库件数</small></div>
        <div className="metric"><span>满载 / 暂存积压预警</span><strong>{congestedLocs.length}</strong><small>{congestedLocs.map(l=>l.code).join(", ")||"无积压库位"}</small></div>
        <div className="metric"><span>开放式无上限暂存区</span><strong>{unconfiguredCapLocs.length}</strong><small>{unconfiguredCapLocs.map(l=>l.code).join(", ")||"已全部设限"}</small></div>
      </div>

      {detailLocId&&<Panel
        id="location-detail-workbench"
        title={locDetail.data?.location?`库位全宽明细工作台 · ${locDetail.data.location.code}（${zones[locDetail.data.location.zone]??locDetail.data.location.zone}）`:"正在加载库位详情…"}
        subtitle={locDetail.data?.location?`当前占用 ${locDetail.data.items?.length??0} 件 · 容量上限：${locDetail.data.location.capacity?`${locDetail.data.location.capacity} 件`:"开放式功能暂存区（无硬上限）"}`:""}
        badge={<button type="button" className="button sm" onClick={()=>setDetailLocId("")}>收起库位明细 ✕</button>}
      >
        {locDetail.error&&<ErrorBlock error={locDetail.error}/>}
        {!locDetail.data&&!locDetail.error&&<p role="status">正在读取当前在位实物及历史移库事件…</p>}
        {locDetail.data&&<div className="ops-columns">
          <div>
            <h3 style={{marginTop:0}}>当前存放实物 ({(locDetail.data.items??[]).length})</h3>
            <Table
              headers={["实物编码","专属客户","关联订单","来源包裹","保管与核身状态","保管到期"]}
              rows={(locDetail.data.items??[]).slice(0,50).map((it:Row)=>[
                <Link key="c" className="code nowrap" href={`/wh/samples/${encodeURIComponent(it.code)}`}>{it.code}</Link>,
                <span key="rc" className="code">{it.receiving_code??"未认领"}</span>,
                it.order_no?<Link key="o" className="code nowrap" href={`/admin/orders/${it.order_no}`}>{it.order_no}</Link>:"未绑单",
                it.package_code?<Link key="p" className="code nowrap" href={`/wh/packages/${it.package_code}`}>{it.package_code}</Link>:"—",
                <WarehouseItemLifecycleTags key="st" item={it} compact/>,
                stamp(it.storage_until,true),
              ])}
              empty="该库位当前为空置状态。"
            />
            {(locDetail.data.items?.length??0)>50&&<p className="muted small" style={{marginTop:8}}>当前库位共存放 {locDetail.data.items.length} 件实物，上方展示最新入库的 50 件。</p>}
          </div>
          <div>
            <h3 style={{marginTop:0}}>近期移库流转记录 ({(locDetail.data.moves??[]).length})</h3>
            <Table
              headers={["时间","动作","实物码","原库位 → 目标库位","操作人"]}
              rows={(locDetail.data.moves??[]).map((mv:Row)=>[
                stamp(mv.created_at,true),
                mv.action,
                <Link key="i" className="code" href={`/wh/samples/${encodeURIComponent(mv.item_code)}`}>{mv.item_code}</Link>,
                `${mv.from_location??"收货入口"} → ${mv.to_location??"—"}`,
                mv.operator_name??"—",
              ])}
              empty="暂无历史移库记录。"
            />
          </div>
        </div>}
      </Panel>}

      <Panel title="库位档案目录" subtitle="点击库位编码或「展开库位明细」可在上方全宽工作区查看该库位的全部实物与移库审计。">
        <div className="form inline-form">
          <label>按库位码筛选<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="如 A-04 / R-01"/></label>
          <label>启用状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部</option><option value="active">启用</option><option value="inactive">停用</option></select></label>
        </div>
        {printedLoc&&<div className="notice" role="status" style={{marginBottom:10}}>
          <p>已生成库位标签 <strong className="code">{printedLoc.code}</strong> · <a href={"/api/v1/staff/labels/"+printedLoc.print_id+"/file"} target="_blank" rel="noreferrer">打开库位标签 PDF</a> · <a href={"/api/v1/staff/labels/"+printedLoc.print_id+"/preview.png"} target="_blank" rel="noreferrer">查看条码 PNG</a></p>
          <img src={"/api/v1/staff/labels/"+printedLoc.print_id+"/preview.png"} alt={`库位条码 ${printedLoc.code}`} style={{maxWidth:320,border:"1px solid #cbd5e1",borderRadius:6,marginTop:6}}/>
        </div>}
        <Table headers={["库位编码","分区用途","占用件数","容量上限与负载状态","启用状态","备注","操作"]} rows={visible.map(location=>{
          const isFull = Boolean(location.capacity && location.occupied >= location.capacity);
          const isStagingCongested = location.zone === "receiving" && location.occupied >= 20;
          const isSelected = detailLocId === location.id;
          return [
            <button key="code" type="button" className="code-btn" onClick={()=>setDetailLocId(isSelected?"":location.id)}><strong>{location.code}</strong></button>,
            zones[location.zone]??location.zone,
            <strong key="occ">{location.occupied} 件</strong>,
            <div key="cap" className="actions">
              <span>{location.capacity?`${location.occupied} / ${location.capacity} 件`:"开放式暂存区"}</span>
              {isFull&&<Tag tone="red">已满载</Tag>}
              {isStagingCongested&&<Tag tone="yellow">暂存积压待移库</Tag>}
              {!location.capacity&&!isStagingCongested&&<Tag tone="outline">无硬上限</Tag>}
            </div>,
            <Tag key="act" tone={location.active?"green":"gray"}>{location.active?"已启用":"已停用"}</Tag>,
            location.notes||"—",
            <div key="op" className="actions">
              <button type="button" className={`button sm nowrap${isSelected?"":" primary"}`} onClick={()=>setDetailLocId(isSelected?"":location.id)}>
                {isSelected?"收起明细":`展开库位明细 (${location.occupied})`}
              </button>
              <Action sm run={async()=>{
                const res=await request("/staff/labels/print","POST",{location_ids:[location.id],label_size:"shelf_100x60"});
                setPrintedLoc({print_id:res.print_id,code:location.code});
              }}>打印货架签</Action>
              <Action sm disabled={location.active&&location.occupied>0} run={async()=>{
                if(location.active&&!window.confirm("停用库位 "+location.code+"？"))return;
                await request(api+"/"+location.id+"/state","POST",{active:!location.active});reload();
              }}>{location.active?(location.occupied?"占用中":"停用"):"启用"}</Action>
            </div>,
          ];
        })} empty="没有符合条件的库位。"/>
      </Panel>

      <div className="ops-columns">
        <Panel title="批量生成标准货架库位">
          <p className="muted">按仓区、货架、层号和格位范围生成。已有编码将自动跳过。</p>
          <Form label="生成并添加库位" run={async f=>{
            const created=await request(api,"POST",{prefix:text(f,"prefix").toUpperCase(),zone:text(f,"zone"),rack:Number(text(f,"rack")),
              level:Number(text(f,"level")),start:Number(text(f,"start")),end:Number(text(f,"end")),capacity:Number(text(f,"capacity")),notes:text(f,"notes")});
            setResult(created);reload();
          }}>
            <div className="location-fields">
              <Field label="仓区编码（单个英文字母）" name="prefix"/>
              <Select label="仓区用途" name="zone" choices={zoneChoices}/>
              <Field label="货架号" name="rack" type="number" min={1} max={99}/>
              <Field label="层号" name="level" type="number" min={1} max={99}/>
              <Field label="起始格位" name="start" type="number" min={1} max={99}/>
              <Field label="结束格位" name="end" type="number" min={1} max={99}/>
              <Field label="每格容量（件）" name="capacity" type="number" min={1} max={999}/>
              <Field label="备注" name="notes" required={false}/>
            </div>
          </Form>
          {result&&<p className="notice" role="status">新增 {result.added.length} 个库位，跳过 {result.skipped.length} 个已有编码。</p>}
        </Panel>
        <Panel title="编码与库位管控规则">
          <div className="location-example"><strong className="code">A-04-02-03</strong><small>A 区 · 04 架 · 02 层 · 03 格</small></div>
          <ul className="location-rules"><li>已存在的编号保留原档案。</li><li>已占用的库位须先清空，才能停用。</li><li>收货、移位与退回入库均检查启用状态、分区用途与容量。</li><li>每个库位均可打印 100×60mm 标准 QR + Code-128 货架标签并支持扫码盘点。</li></ul>
        </Panel>
      </div>
    </>}
  </>;
}

export function OverdueDisposalDesk() {
  const disposals=useLoad("/staff/disposals");
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
  const [switchOpen,setSwitchOpen]=useState(false);
  const [execCase,setExecCase]=useState<Row|null>(null);
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const d=disposals.data;
  const prodEnabled=Boolean(d?.production_execution_switch?.enabled);
  const candidates:Row[]=d?.candidate_items??[];
  const activeCaseItemIds=new Set<string>(
    (d?.cases??[]).filter((c:Row)=>c.state!=="cancelled").flatMap((c:Row)=>c.item_ids??[])
  );
  const firstSelected=candidates.find(c=>selectedIds.includes(c.id));
  const lockedOrgKey=firstSelected?(firstSelected.org_id??"__unassigned__"):null;
  const toggleCandidate=(item:Row)=>{
    setSelectedIds(prev=>prev.includes(item.id)?prev.filter(x=>x!==item.id):[...prev,item.id]);
  };
  return <Panel title="逾期与违禁件双人审批处置台">
    <p className="muted">保管期届满或违禁隔离实物须立项生成快照哈希（list_hash），经独立审批人复核（禁止自审），并在正式法律/协议生产开关开启后方可执行处置。</p>
    {disposals.error&&<ErrorBlock error={disposals.error}/>}
    {d&&<>
      <div className="row" style={{justifyContent:"space-between",marginBottom:12}}>
        <div>
          <strong>生产处置执行门禁：</strong> <Tag>{prodEnabled?"已开启":"默认关闭（仅预演与审批）"}</Tag>
          <span className="muted"> · 逾期在库 {d.overdue_items.length} 件 · 违禁/隔离 {d.restricted_items.length} 件</span>
        </div>
        <button type="button" className="button sm" onClick={()=>setSwitchOpen(true)}>
          {prodEnabled?"关闭生产处置执行开关":"开启生产处置执行开关"}
        </button>
      </div>
      <div className="ops-columns">
        <div>
          <h3 style={{marginTop:0}}>01 / 勾选逾期或隔离实物立项 ({selectedIds.length} 件已选)</h3>
          <Table
            headers={["选择","实物编码","来源包裹 / 客户","原因与保管截止","库位"]}
            rows={candidates.map((it:Row)=>{
              const inCase=activeCaseItemIds.has(it.id);
              const itemOrgKey=it.org_id??"__unassigned__";
              const orgMismatch=Boolean(lockedOrgKey && lockedOrgKey!==itemOrgKey && !selectedIds.includes(it.id));
              return [
                <input
                  key={it.id}
                  type="checkbox"
                  checked={selectedIds.includes(it.id)}
                  disabled={inCase||orgMismatch}
                  title={inCase?"已在处置单中":orgMismatch?"同一处置单仅限同一客户组织实物":"选择此实物"}
                  onChange={()=>toggleCandidate(it)}
                />,
                <CodeButton key="code" code={it.code} onClick={()=>setDrawer({kind:"item",ref:it.code})}/>,
                <div key="pkg" className="cell-stack">
                  <span>{it.package_code?<CodeButton code={it.package_code} onClick={()=>setDrawer({kind:"package",ref:it.package_code})}/>:"—"}</span>
                  <small>{it.receiving_code??"未绑定客户"}</small>
                </div>,
                <div key="due" className="cell-stack">
                  <div className="actions">
                    {it.quarantined&&<Tag tone="red">隔离件</Tag>}
                    {it.overdue&&<Tag tone="yellow">保管逾期</Tag>}
                    {inCase&&<Tag tone="outline">已立项</Tag>}
                  </div>
                  <small>截止：{stamp(it.storage_until,true)}</small>
                </div>,
                it.location_code??"—",
              ];
            })}
            empty="当前没有逾期或违禁隔离的在库实物。"
          />
          {selectedIds.length>0&&<div style={{marginTop:12}}>
            <Form label={`为已选 ${selectedIds.length} 件实物创建处置审批单`} run={async f=>{
              await request("/staff/disposals","POST",{
                ...(firstSelected?.org_id?{org_id:firstSelected.org_id}:{}),
                item_ids:selectedIds,
                reason:text(f,"reason"),
                legal_basis_version:text(f,"legal_basis_version")||"TOS-2026-V2",
                customer_authorized:checked(f,"customer_authorized"),
              });
              setSelectedIds([]);
              disposals.reload();
            }}>
              <div className="fields">
                <Field label="适用协议/政策版本" name="legal_basis_version" value="TOS-2026-V2" required={false}/>
                <Field label="立项说明与通知取证摘要" name="reason"/>
              </div>
              <label className="check"><input type="checkbox" name="customer_authorized"/> 已确认客户书面弃货授权或届满催告留证完备</label>
            </Form>
          </div>}
        </div>
        <div>
          <h3 style={{marginTop:0}}>02 / 处置审批单与双人复核 ({(d.cases??[]).length})</h3>
          <Table headers={["处置单 / 客户","状态","实物清单 / 哈希","政策版本","双人复核与执行"]} rows={(d.cases??[]).map((c:Row)=>{
            const auth=c.authorization_snapshot??{};
            const pol=c.policy_snapshot??{};
            const codes:string[]=c.item_codes??[];
            const count=codes.length||(c.item_ids??[]).length;
            const execMediaIds:string[]=c.execution_evidence?.media_ids??[];
            return [
              <div key={c.id} className="cell-stack">
                <strong className="code">#{c.id.slice(0,8)}</strong>
                <small>{c.receiving_code??"未归属组织"}</small>
              </div>,
              <Tag key="st">{c.state}</Tag>,
              <div key="items" className="cell-stack">
                <div className="actions">
                  <span>{count} 件</span>
                  {codes.slice(0,3).map(cd=><CodeButton key={cd} code={cd} onClick={()=>setDrawer({kind:"item",ref:cd})}/>)}
                  {codes.length>3&&<small className="muted">+{codes.length-3}</small>}
                </div>
                <small className="code">Hash: {(auth.list_hash??pol.list_hash??"").slice(0,12)}</small>
              </div>,
              <span key="pol">{pol.legal_basis_version??pol.legal_basis??"TOS-2026-V2"}</span>,
              <div key="act" className="actions">
                {c.state==="pending_approval"&&<Action sm run={async()=>{
                  await request(`/staff/disposals/${c.id}/approve`,"POST",{
                    revision:c.revision,
                    list_hash:auth.list_hash??pol.list_hash,
                    reason:"Independent dual-control approval verified",
                  });
                  disposals.reload();
                }}>独立审批通过</Action>}
                {c.state==="approved"&&<button type="button" className="button sm primary" onClick={()=>setExecCase(c)}>登记执行归档</button>}
                {execMediaIds.length>0&&<MediaButton ids={execMediaIds} label={`执行照片 (${execMediaIds.length})`}/>}
              </div>,
            ];
          })} empty="暂无处置审批单。"/>
        </div>
      </div>
    </>}
    <ModalDrawer
      open={switchOpen}
      onClose={()=>setSwitchOpen(false)}
      centered
      title={prodEnabled?"关闭生产处置执行门禁":"开启生产处置执行门禁"}
      subtitle="物理销毁/变卖属于不可逆高危操作，须核验正式协议条款版本与留痕原因。"
    >
      <Form label={prodEnabled?"确认关闭执行开关":"确认开启执行开关"} run={async f=>{
        await request("/staff/admin/disposal-execution-switch","POST",{
          enabled:!prodEnabled,
          legal_basis_version:text(f,"legal_basis_version")||"TOS-2026-V2",
          reason:text(f,"reason"),
        });
        setSwitchOpen(false);
        disposals.reload();
      }}>
        <Field label="正式法律与客户协议条款版本号" name="legal_basis_version" value="TOS-2026-V2"/>
        <Field label="门禁变更审计原因" name="reason" value={prodEnabled?"临时关闭生产物理处置执行开关":"法务条款与通知留证已就绪，开启生产物理处置执行"}/>
      </Form>
    </ModalDrawer>
    <ModalDrawer
      open={Boolean(execCase)}
      onClose={()=>setExecCase(null)}
      centered
      title={execCase?`执行物理处置归档 · #${String(execCase.id).slice(0,8)}`:""}
      subtitle="请核对实物清单无误后选择处置方式，可同步上传现场销毁/交接照片。"
    >
      {execCase&&<Form label="确认完成物理处置并归档" run={async f=>{
        const file=f.get("photo");
        const mediaIds:string[]=[];
        if(file instanceof File && file.size>0) mediaIds.push(await upload(file,"attachment"));
        await request(`/staff/disposals/${execCase.id}/execute`,"POST",{
          revision:execCase.revision,
          method:text(f,"method")||"destroy",
          witness_note:text(f,"witness_note"),
          execution_note:text(f,"witness_note"),
          ...(mediaIds.length?{media_ids:mediaIds}:{}),
        });
        setExecCase(null);
        disposals.reload();
      }}>
        <Select label="物理处置方式" name="method" value="destroy" choices={[
          {id:"destroy",label:"集中销毁 (destroy)"},
          {id:"liquidate",label:"合规变卖折抵 (liquidate)"},
          {id:"donate",label:"公益捐赠 (donate)"},
        ]}/>
        <Field label="双人现场见证与执行记录" name="witness_note" value="仓库主管与复核人双人现场核对清单并完成处置"/>
        <Field label="现场处置证据照片（可选）" name="photo" type="file" required={false}/>
      </Form>}
    </ModalDrawer>
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </Panel>;
}

export function StocktakeReviewAndIncidentPanel() {
  const stocktakes=useLoad("/staff/stocktakes");
  const incidents=useLoad("/staff/incidents");
  const [reviewSt,setReviewSt]=useState<Row|null>(null);
  const [proposeInc,setProposeInc]=useState<Row|null>(null);
  const [srvUsd,setSrvUsd]=useState("0.00");
  const [compUsd,setCompUsd]=useState("20.00");
  const [payoutInc,setPayoutInc]=useState<Row|null>(null);
  const [drawer,setDrawer]=useState<StaffObjectTarget|null>(null);
  const eligibleItems:Row[]=incidents.data?.eligible_items??[];
  return <div className="ops-columns">
    <Panel title="盘点差异复核">
      <p className="muted">盘点提交的缺失/错位差异须由独立主管或管理员复核，禁止盘点创建人自审。</p>
      {stocktakes.error&&<ErrorBlock error={stocktakes.error}/>}
      <Table headers={["盘点单","范围","状态","总数/匹配/差异","快照时间","独立复核"]} rows={(stocktakes.data?.rows??[]).map((st:Row)=>{
        const items:Row[]=st.items??[];
        const matched=items.filter(i=>i.state==="matched"||i.state==="adjusted").length;
        const disc=items.filter(i=>i.state==="investigating").length;
        return [
          <strong key={st.id} className="code">#{st.id.slice(0,8)}</strong>,
          st.scope?.zone?`仓区: ${zones[st.scope.zone]??st.scope.zone}`:"全仓",
          <Tag key="st">{st.state}</Tag>,
          `${items.length} / ${matched} / ${disc}`,
          stamp(st.snapshot_at,true),
          st.state==="submitted"
            ?<button type="button" className="button sm primary" onClick={()=>setReviewSt(st)}>复核差异 ({disc})</button>
            :"—",
        ];
      })} empty="暂无盘点记录。"/>
    </Panel>
    <Panel title="库内丢损与事故赔偿">
      <p className="muted">服务费退回受原支付单可退余额约束，货值赔付独立立项审批并登记打款凭证。非财务/超管角色隐藏具体赔付金额。</p>
      {incidents.error&&<ErrorBlock error={incidents.error}/>}
      <Form label="登记库内异常事故" run={async f=>{
        const file=f.get("evidence_photo");
        const evidenceIds:string[]=[];
        if(file instanceof File && file.size>0) evidenceIds.push(await upload(file,"attachment"));
        await request("/staff/incidents","POST",{
          item_code:text(f,"item_code").toUpperCase(),
          kind:text(f,"kind"),
          summary_en:text(f,"summary_en"),
          ...(text(f,"internal_note")?{internal_note:text(f,"internal_note")}:{}),
          ...(evidenceIds.length?{evidence_ids:evidenceIds}:{}),
        });
        incidents.reload();
      }}>
        <div className="fields">
          <label>关联实物编码（支持扫码或搜索）
            <input name="item_code" list="incident-eligible-items" placeholder="例如 S-1001" required/>
          </label>
          <datalist id="incident-eligible-items">
            {eligibleItems.map(it=><option key={it.id} value={it.code}>{`${it.receiving_code??"—"} · ${it.order_no??"未委托"} · ${it.custody_state}`}</option>)}
          </datalist>
          <Select label="事故类型" name="kind" choices={[
            {id:"loss",label:"库内缺失 (loss)"},
            {id:"damage",label:"库内破损 (damage)"},
            {id:"wrong_inspection",label:"质检重大差错 (wrong_inspection)"},
          ]}/>
        </div>
        <div className="fields">
          <Field label="对客英文说明与取证摘要 (English)" name="summary_en"/>
          <Field label="内部交接备注（仅员工可见，可选）" name="internal_note" required={false}/>
        </div>
        <Field label="现场破损/异常证据照片（可选）" name="evidence_photo" type="file" required={false}/>
      </Form>
      <Table headers={["事故工单","实物 / 订单","类型","状态","服务费退回 / 货值赔付","凭证与结案操作"]} rows={(incidents.data?.rows??[]).map((inc:Row)=>{
        const evIds:string[]=inc.evidence?.media_ids??[];
        const proofIds:string[]=inc.payment_proof?.proof_media_ids??[];
        return [
          <strong key={inc.id} className="code">{inc.ticket_no}</strong>,
          <div key="item" className="cell-stack">
            <span>{inc.item_code?<CodeButton code={inc.item_code} onClick={()=>setDrawer({kind:"item",ref:inc.item_code})}/>:"—"}</span>
            <small>{inc.order_no?<Link href={`/admin/orders/${inc.order_no}`}>{inc.order_no}</Link>:"未关联质检单"}</small>
          </div>,
          inc.resolution?.kind??"—",
          <Tag key="st">{inc.state}</Tag>,
          inc.resolution?.financial_restricted
            ?<span key="fin" className="muted">仅财务/超管可见</span>
            :<div key="fin" className="cell-stack">
              <strong>退服务费 {usd(inc.resolution?.service_refund_cents??0)} · 赔货值 {usd(inc.resolution?.compensation_cents??0)}</strong>
              <small>{inc.payment_proof?`已打款 (${inc.payment_proof.payout_reference??"已核销"})`:"待确认/待打款"}</small>
            </div>,
          <div key="act" className="actions">
            {evIds.length>0&&<MediaButton ids={evIds} label={`事故照 (${evIds.length})`}/>}
            {proofIds.length>0&&<MediaButton ids={proofIds} label={`打款水单 (${proofIds.length})`}/>}
            {(inc.state==="open"||inc.state==="customer_rejected")&&<button type="button" className="button sm primary" onClick={()=>{
              setSrvUsd(((Number(inc.resolution?.service_refund_cents??0))/100).toFixed(2));
              setCompUsd(((Number(inc.resolution?.compensation_cents??2000))/100).toFixed(2));
              setProposeInc(inc);
            }}>拟定赔偿方案</button>}
            {inc.state==="proposed"&&<Action sm primary run={async()=>{
              await request(`/staff/incidents/${inc.id}/approve`,"POST",{reason:"Approved by independent reviewer"});
              incidents.reload();
            }}>独立审批</Action>}
            {inc.state==="awaiting_payout"&&<button type="button" className="button sm primary" onClick={()=>setPayoutInc(inc)}>登记打款结案</button>}
          </div>,
        ];
      })} empty="暂无库内事故单。"/>
    </Panel>
    <ModalDrawer
      open={Boolean(reviewSt)}
      onClose={()=>setReviewSt(null)}
      centered
      title={reviewSt?`复核盘点差异 · #${String(reviewSt.id).slice(0,8)}`:""}
      subtitle="可批准差异生成库存调整记录，或退回仓库要求现场二次复盘。"
    >
      {reviewSt&&<Form label="提交复核决定" run={async f=>{
        await request(`/staff/stocktakes/${reviewSt.id}/approve`,"POST",{
          decision:text(f,"decision"),
          reason:text(f,"reason"),
        });
        setReviewSt(null);
        stocktakes.reload();
      }}>
        <Select label="复核决定" name="decision" value="approve" choices={[
          {id:"approve",label:"批准差异调账并结案 (approve)"},
          {id:"recount",label:"退回要求现场重新复盘 (recount)"},
        ]}/>
        <Field label="复核意见与依据" name="reason" value="主管核对监控与库位记录后确认盘点结果"/>
      </Form>}
    </ModalDrawer>
    <ModalDrawer
      open={Boolean(proposeInc)}
      onClose={()=>setProposeInc(null)}
      centered
      title={proposeInc?`拟定事故赔偿方案 · ${proposeInc.ticket_no}`:""}
      subtitle="直接输入美元（USD）金额，系统自动换算为美分并校验原单可退服务费上限。"
    >
      {proposeInc&&<Form label="提交赔偿方案待独立审批" run={async f=>{
        const srvCents=Math.round(Number(srvUsd||"0")*100);
        const compCents=Math.round(Number(compUsd||"0")*100);
        await request(`/staff/incidents/${proposeInc.id}/propose`,"POST",{
          service_refund_cents:srvCents,
          compensation_cents:compCents,
          currency:"USD",
          summary_en:text(f,"summary_en"),
          ...(text(f,"internal_note")?{internal_note:text(f,"internal_note")}:{}),
        });
        setProposeInc(null);
        incidents.reload();
      }}>
        <div className="fields">
          <label>服务费退回金额 (USD)
            <input type="number" min={0} step="0.01" value={srvUsd} onChange={e=>setSrvUsd(e.target.value)} required/>
          </label>
          <label>货值协商赔付金额 (USD)
            <input type="number" min={0} step="0.01" value={compUsd} onChange={e=>setCompUsd(e.target.value)} required/>
          </label>
        </div>
        <p className="notice" style={{margin:0}}>
          折算预览：退还平台服务费 <strong>{usd(Math.round(Number(srvUsd||"0")*100))}</strong> + 独立货值赔付 <strong>{usd(Math.round(Number(compUsd||"0")*100))}</strong>
        </p>
        <Field label="对客赔偿方案说明 (English)" name="summary_en" value={proposeInc.resolution?.proposal_summary_en||"We sincerely apologize for the warehouse incident and propose the above resolution."}/>
        <Field label="内部审批备注（可选）" name="internal_note" required={false}/>
      </Form>}
    </ModalDrawer>
    <ModalDrawer
      open={Boolean(payoutInc)}
      onClose={()=>setPayoutInc(null)}
      centered
      title={payoutInc?`登记赔付打款凭证 · ${payoutInc.ticket_no}`:""}
      subtitle={payoutInc?`客户已同意方案，核定应赔付货值：${usd(Number(payoutInc.resolution?.compensation_cents??0))}`:""}
    >
      {payoutInc&&<Form label="确认打款入账并结案" run={async f=>{
        const file=f.get("proof_photo");
        const proofIds:string[]=[];
        if(file instanceof File && file.size>0) proofIds.push(await upload(file,"attachment"));
        await request(`/staff/incidents/${payoutInc.id}/resolve`,"POST",{
          payout_reference:text(f,"payout_reference"),
          payout_method:text(f,"payout_method")||"bank_transfer",
          paid_amount_cents:Number(payoutInc.resolution?.compensation_cents??0),
          currency:"USD",
          ...(proofIds.length?{proof_media_ids:proofIds}:{}),
          ...(text(f,"note")?{note:text(f,"note")}:{}),
        });
        setPayoutInc(null);
        incidents.reload();
      }}>
        <div className="fields">
          <Field label="外部打款流水号 / 凭证编号" name="payout_reference"/>
          <Select label="打款渠道" name="payout_method" value="bank_transfer" choices={[
            {id:"bank_transfer",label:"银行转账 (Bank Transfer)"},
            {id:"wire",label:"跨境电汇 (Wire)"},
            {id:"paypal",label:"PayPal 企业付款"},
            {id:"other",label:"其他约定渠道"},
          ]}/>
        </div>
        <Field label="打款水单截图（可选）" name="proof_photo" type="file" required={false}/>
        <Field label="财务核销备注（可选）" name="note" value="已按客户确认金额完成打款核销" required={false}/>
      </Form>}
    </ModalDrawer>
    <StaffObjectDrawer target={drawer} onClose={()=>setDrawer(null)}/>
  </div>;
}

export function StorageMove({path="/wh/storage",actor}:{path?:string;actor?:Row}) {
  const [filterItem,setFilterItem]=useState("");
  const [filterLoc,setFilterLoc]=useState("");
  const [filterStaff,setFilterStaff]=useState("");
  const [filterAction,setFilterAction]=useState("");
  const [filterDays,setFilterDays]=useState("");
  const storageUrl=(()=>{
    if(path==="/wh/stocktakes") return null;
    const p=new URLSearchParams();
    if(filterItem.trim()) p.set("item",filterItem.trim());
    if(filterLoc.trim()) p.set("location",filterLoc.trim());
    if(filterStaff.trim()) p.set("staff",filterStaff.trim());
    if(filterAction.trim()) p.set("action",filterAction.trim());
    if(filterDays.trim()) p.set("days",filterDays.trim());
    const qs=p.toString();
    return "/staff/storage"+(qs?"?"+qs:"");
  })();
  const {data,error,reload}=useLoad(storageUrl);
  const [code,setCode]=useState("");
  const [prefilledLoc,setPrefilledLoc]=useState("");
  const [lockedTarget,setLockedTarget]=useState("");
  const [batchMoveCount,setBatchMoveCount]=useState(0);
  const [receipt,setReceipt]=useState("");
  useEffect(()=>{
    const qs=new URLSearchParams(location.search);
    const it=qs.get("item")??"";
    const loc=qs.get("location")??"";
    if(it) setCode(it);
    if(loc) { setPrefilledLoc(loc); setLockedTarget(loc); }
  },[]);
  const found=useLoad(code?"/staff/items/by-code?"+new URLSearchParams({code}):null);
  const item=found.data?.item;
  const canMove=Boolean(!actor?.roles || actor.roles.some((r:string)=>["receiver","warehouse_admin"].includes(r)));
  const canManageLocations=Boolean(actor?.roles?.includes("super_admin"));
  if(path==="/wh/stocktakes") {
    return <>
      <div className="page-head row">
        <div><h1>库存盘点与差异核销</h1>
          <p className="muted">按仓区或全仓创建盘点快照，支持扫码实盘与主管独立复核；历史原始差异、批准调整及事故冻结永久留痕。</p></div>
        <div className="head-actions"><Link className="button" href="/wh/storage">库位移转</Link></div>
      </div>
      <StocktakeWorkspace actor={actor}/>
    </>;
  }
  const refLocations=(data?.locations??[]).filter((row:Row)=>row.zone==="reference");
  const pendingRefTasks:Row[]=data?.pending_reference_tasks??[];
  const ACTION_ZH:Record<string,string>={move:"常规移位",intake:"收货上架",quarantine:"异常隔离",stocktake_adjustment:"盘点调账",stocktake_recovery:"盘点寻回",receive_return:"退回返仓",handover:"出库交接"};
  return <>
    <div className="page-head row"><div><h1>样品库位移转与批量上架</h1>
      <p className="muted">逐件或连续扫码核对实物与目标货架，记录原库位、目标库位与操作员；确认样在此完成铅封并存入参考样专柜（REF_SAFE）。</p></div>
      <div className="head-actions">
        <Link className="button sm" href="/wh/samples">样品建档</Link>
        {canManageLocations&&<Link className="button sm" href="/admin/storage/locations">管理库位</Link>}
      </div></div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>重试</button></>}
    {!canMove&&<div className="notice" style={{marginBottom:12}}><strong>只读查看模式：</strong>库位移动与确认样铅封激活仅限收货员（receiver）或仓库主管（warehouse_admin）执行，当前账号仅可查阅库存位置与历史记录。</div>}
    {pendingRefTasks.length>0&&<Panel
      title={`确认样（Golden Sample）待铅封入专柜任务 (${pendingRefTasks.length})`}
      subtitle="客户已发起设为确认样申请。请现场核对样品、加施防拆铅封并扫码存入确认样专区（reference），完成后系统自动激活确认样并通知客户。"
    >
      {pendingRefTasks.map((task:Row)=><div className="card" key={task.reference_id} style={{marginBottom:10}}>
        <div className="row between flexwrap" style={{marginBottom:8}}>
          <div>
            <Link className="code" href={`/wh/samples/${encodeURIComponent(task.item_code)}`}><strong>{task.item_code}</strong></Link> · 当前位置 <span className="code">{task.current_location_code??"未上架"}</span>（{zones[task.current_zone]??task.current_zone??"—"}） · 预分配铅封号 <span className="code">{task.seal_code??"待录入"}</span>
            {task.condition_note&&<div className="small muted">封存说明：{task.condition_note}</div>}
          </div>
          <Tag tone="yellow">待铅封存入确认样专区</Tag>
        </div>
        {canMove?(refLocations.length>0?<Form key={`ref-${task.reference_id}-${task.item_revision}`} idempotent={true} label="扫码铅封并存入确认样专区" run={async f=>{
          const locId=text(f,"target_location_id");
          const targetLoc=refLocations.find((l:Row)=>l.id===locId);
          if(!targetLoc) throw new Error("请选择已启用的确认样专区库位。");
          const scannedItem=text(f,"scanned_item_code").trim();
          const scannedLocation=text(f,"scanned_location_code").trim();
          const sealCode=text(f,"seal_code").trim();
          const result=await request("/staff/storage/move","POST",{
            item_id:task.item_id,
            revision:task.item_revision,
            location_id:targetLoc.id,
            scanned_item_code:scannedItem,
            scanned_location_code:scannedLocation,
            seal_code:sealCode,
          });
          if(result.reference_activated)
            setReceipt(`确认样 ${task.item_code} 已在 ${targetLoc.code} 封存，确认样已生效。`);
          reload();
          if(code===task.item_code) found.reload();
        }}>
          <div className="fields two">
            <Field label="扫描样品条码确认" name="scanned_item_code"/>
            <Field label="扫描已施加的防拆铅封" name="seal_code"/>
            <Select label="目标确认样专柜库位 (REF_SAFE)" name="target_location_id" value={refLocations[0]?.id} choices={refLocations.map((l:Row)=>({id:l.id,label:`${l.code} · ${zones[l.zone]??l.zone} (${l.occupied}/${l.capacity??"∞"})`}))}/>
            <Field label="扫描目标货架标签" name="scanned_location_code"/>
          </div>
        </Form>:<p className="bad small">当前尚未启用用途为“确认样区 (reference)”的库位，请先由超级管理员在库位管理中启用确认样专柜。</p>):<p className="small muted">当前角色仅查看确认样封存任务状态。</p>}
      </div>)}
    </Panel>}
    <div className="ops-columns">
      <Panel title="01 / 扫描或锁定目标库位">
        {canMove&&<div style={{marginBottom:12,padding:10,border:"1px solid var(--line)",borderRadius:8,background:"#f8fafd"}}>
          <label className="small" style={{display:"grid",gap:6}}>
            <strong>连续上架锁定目标库位（可选 · 适合同批多件快速扫描移位）</strong>
            <input
              value={lockedTarget}
              list="all-location-codes"
              placeholder="输入或扫描目标货架码，例如 A-01-01-01"
              onChange={e=>{setLockedTarget(e.target.value.toUpperCase());}}
            />
          </label>
          {lockedTarget&&<small className="muted">已锁定目标库位 <strong className="code">{lockedTarget}</strong>{batchMoveCount>0?` · 本次已连续上架 ${batchMoveCount} 件`:""}</small>}
        </div>}
        <Form label="查询实物" run={async f=>{setCode(text(f,"item").trim().toUpperCase());setReceipt("");found.reload();}}>
          <label>扫描或输入实物编号<input name="item" defaultValue={code} placeholder="例如 S-XXXXXX 或 DSP-..." required/></label>
        </Form>
        {code&&!item&&!found.error&&<p role="status">正在读取实物…</p>}
        {found.error&&<ErrorBlock error={found.error}/>}
        {item&&!found.error&&<dl className="location-facts">
          <div><dt>实物编号</dt><dd><Link className="code" href={`/wh/samples/${encodeURIComponent(item.code)}`}>{item.code}</Link></dd></div>
          <div><dt>核身 / 异常状态</dt><dd><Tag tone={item.identity_state==="quarantined"?"red":item.identity_state==="identified"?"green":"yellow"}>{item.identity_state}</Tag>{item.handling_hold&&<> <Tag tone="red">冻结：{item.handling_hold}</Tag></>}</dd></div>
          <div><dt>原位置（系统记录）</dt><dd className="code">{item.location??"尚未登记"}{item.location_zone?` (${zones[item.location_zone]??item.location_zone})`:""}</dd></div>
          <div><dt>实收包裹</dt><dd><Link className="code" href={`/wh/packages/${encodeURIComponent(item.package_code)}`}>{item.package_code}</Link></dd></div>
          {item.reference_sample_state&&<div><dt>确认样状态</dt><dd><Tag tone="yellow">{item.reference_sample_state}{item.reference_seal_code?` · ${item.reference_seal_code}`:""}</Tag></dd></div>}
        </dl>}
      </Panel>
      <Panel title="02 / 目标库位校验与移位确认">
        {!item&&!found.error&&<Empty>请先扫描或查询实物编号。</Empty>}
        {item&&!item.movable&&<Empty>此实物当前不处于可移位的在库状态（{item.custody_state}）。</Empty>}
        {item&&item.handling_hold&&<Empty>该实物当前处于「{item.handling_hold}」冻结管控中，须先完成盘点复核或事故结案后方可移位。</Empty>}
        {item?.movable&&!item.handling_hold&&data&&!found.error&&canMove&&<Form key={item.id+"-"+item.revision+"-"+(lockedTarget||prefilledLoc)} idempotent={true}
          label={item.reference_sample_state==="pending_safe_storage"?"核对实物与封存":"确认移位"} run={async f=>{
          const targetCode=text(f,"target").trim().toUpperCase();
          const target=data.locations.find((row:Row)=>row.code.toUpperCase()===targetCode&&
            (row.code!==item.location||row.zone==="reference"&&item.reference_sample_state==="pending_safe_storage"));
          if(!target)throw new Error("请选择可用的目标库位。");
          if(!checked(f,"confirmed"))throw new Error("请勾选已现场扫描核对实物与货架标签。");
          const scannedItem=text(f,"scanned_item_code").trim();
          const scannedLoc=text(f,"scanned_location_code").trim();
          const sealCode=text(f,"seal_code").trim();
          const result=await request("/staff/storage/move","POST",{
            item_id:item.id,
            revision:item.revision,
            location_id:target.id,
            ...(scannedItem?{scanned_item_code:scannedItem}:{}),
            ...(scannedLoc?{scanned_location_code:scannedLoc}:{}),
            ...(sealCode?{seal_code:sealCode}:{}),
          });
          setReceipt(result.reference_activated?`${item.code} 已在 ${target.code} 封存，确认样已生效。`:
            `${item.code} 已移至 ${target.code}（已完成实物与货架校验）。`);
          if(target.code!==item.location)setBatchMoveCount(c=>c+1);
          setCode("");
          found.reload();reload();
        }}>
          <Field label="扫描实物条码复核（须与左侧待移位件一致）" name="scanned_item_code" value={item.reference_sample_state==="pending_safe_storage"?"":item.code}/>
          {item.reference_sample_state==="pending_safe_storage"&&<><p className="small">分配的铅封编号 <span className="code">{item.reference_seal_code}</span></p>
            <Field label="扫描已施加的防拆铅封（在确认样区封存时必填）" name="seal_code" required={false}/></>}
          <label>目标库位码（系统校验分区用途及容量）<input name="target" list="active-location-codes" defaultValue={lockedTarget||prefilledLoc} required/></label>
          <Field label="目标货架标签复核扫入码（与目标库位一致）" name="scanned_location_code"
            value={item.reference_sample_state==="pending_safe_storage"?"":lockedTarget||prefilledLoc} required={false}/>
          <datalist id="active-location-codes">{data.locations.filter((row:Row)=>row.code!==item.location||
            row.zone==="reference"&&item.reference_sample_state==="pending_safe_storage").map((row:Row)=>
            <option key={row.id} value={row.code}>{`${zones[row.zone]??row.zone} · 占用 ${row.occupied}/${row.capacity??"∞"}`}</option>)}</datalist>
          <datalist id="all-location-codes">{data.locations.map((row:Row)=>
            <option key={row.id} value={row.code}>{`${zones[row.zone]??row.zone} · 占用 ${row.occupied}/${row.capacity??"∞"}`}</option>)}</datalist>
          <label className="check"><input name="confirmed" type="checkbox" required/>已现场扫描核对实物标签及目标货架标签</label>
        </Form>}
        {!canMove&&item&&<Empty>当前角色无权提交库位变更操作。</Empty>}
        {receipt&&<p className="notice" role="status">{receipt}</p>}
      </Panel>
    </div>
    <Panel title="库内作业与移位历史">
      <div className="fields four" style={{marginBottom:10}}>
        <label style={{display:"grid",gap:4}}>按实物编码筛选<input value={filterItem} onChange={e=>setFilterItem(e.target.value)} placeholder="S- / DSP-"/></label>
        <label style={{display:"grid",gap:4}}>按库位筛选<input value={filterLoc} onChange={e=>setFilterLoc(e.target.value)} placeholder="A-01-..."/></label>
        <label style={{display:"grid",gap:4}}>按操作人筛选<input value={filterStaff} onChange={e=>setFilterStaff(e.target.value)} placeholder="姓名"/></label>
        <label style={{display:"grid",gap:4}}>动作与时间范围
          <div className="actions">
            <select value={filterAction} onChange={e=>setFilterAction(e.target.value)}>
              <option value="">全部动作</option>
              {Object.entries(ACTION_ZH).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
            <select value={filterDays} onChange={e=>setFilterDays(e.target.value)}>
              <option value="">全部时间</option>
              <option value="1">近 24 小时</option>
              <option value="7">近 7 天</option>
              <option value="30">近 30 天</option>
            </select>
          </div>
        </label>
      </div>
      {!data&&!error&&<p role="status">正在读取移位记录…</p>}
      {data&&<Table headers={["实物码","动作类型","原位置","目标位置","操作员","时间"]} rows={data.moves.map((row:Row)=>[
        <Link key="c" className="code" href={`/wh/samples/${encodeURIComponent(row.code)}`}>{row.code}</Link>,
        ACTION_ZH[row.action]??row.action??"move",
        row.origin??"—",row.destination??"—",row.operator,stamp(row.created_at),
      ])} empty="暂无符合筛选条件的移位历史。"/>}
    </Panel>
  </>;
}

function StocktakeWorkspace({actor}:{actor?:Row}) {
  const {data,error,reload}=useLoad("/staff/stocktakes");
  const [selectedId,setSelectedId]=useState("");
  const rows:Row[]=data?.rows??[];
  const active=rows.find(r=>r.id===selectedId)??rows[0];
  const activeItems:Row[]=active?.items??[];
  const canCreateOrScan=Boolean(!actor?.roles || actor.roles.some((r:string)=>["receiver","warehouse_admin","super_admin"].includes(r)));
  const canApproveStocktake=Boolean(actor?.roles?.some((r:string)=>["warehouse_admin","super_admin"].includes(r)));
  const isSelfOperator=Boolean(active&&actor?.id&&(active.operator_id===actor.id||activeItems.some((i:Row)=>i.requested_by===actor.id)));
  return <Panel title="盘点任务列表与扫码作业">
    <p className="muted">按仓区或全仓创建盘点快照；盘点期间并发移库/出库自动提示重盘，缺失/错位实物冻结出库直至寻回或事故结案。</p>
    {error&&<ErrorBlock error={error}/>}
    <div className="ops-columns">
      <div>
        {canCreateOrScan?<Form label="创建盘点任务" run={async f=>{
          const zoneVal=text(f,"zone");
          const res=await request("/staff/stocktakes","POST",{
            ...(zoneVal?{zone:zoneVal}:{}),
            note:text(f,"note"),
          });
          setSelectedId(res.id);
          reload();
        }}>
          <Select label="仓区范围（留空为全仓在库实物）" name="zone" required={false} choices={zoneChoices}/>
          <Field label="盘点备注" name="note" required={false}/>
        </Form>:<Empty>当前角色无盘点创建权限。</Empty>}
      </div>
      <div>
        {active?<div className="stack">
          <div className="row" style={{justifyContent:"space-between"}}>
            <div>
              <strong className="code">盘点 #{active.id.slice(0,8)}</strong> · <Tag>{active.state==="in_progress"?"盘点中":active.state==="submitted"?"待主管复核":active.state==="approved"?"已完成归档":active.state}</Tag> · 发起人 {active.operator_name??"—"}{active.approved_by_name?` · 审批人 ${active.approved_by_name}`:""}
              <p className="muted">
                快照时间：{stamp(active.snapshot_at)} · 总数 {activeItems.length}
                {" / "}当前相符 {activeItems.filter(i=>i.state==="matched").length}
                {" / "}原始发现差异 {active.original_discrepancy_count??activeItems.filter(i=>i.state==="investigating"||i.state==="adjusted"||Boolean(i.adjustment_id)).length}
                {" / "}已批准调账 {active.approved_adjustment_count??activeItems.filter(i=>i.state==="adjusted"||Boolean(i.approved_by)).length}
                {" / "}未决冻结 {activeItems.filter(i=>i.state==="investigating"||i.state==="recount_required").length}
              </p>
            </div>
            {rows.length>1&&<select value={active.id} onChange={e=>setSelectedId(e.target.value)}>
              {rows.map(r=><option key={r.id} value={r.id}>盘点 #{r.id.slice(0,8)} ({r.state})</option>)}
            </select>}
          </div>
          {active.state==="in_progress"&&canCreateOrScan&&<Form label="录入盘点结果" run={async f=>{
            const raw=text(f,"item_code");
            const loc=text(f,"actual_location");
            await request(`/staff/stocktakes/${active.id}/scan`,"POST",{
              ...(raw.length===36?{item_id:raw}:{item_code:raw}),
              status:text(f,"status"),
              ...(loc?{actual_location:loc}:{}),
              note:text(f,"note"),
            });
            reload();
          }}>
            <div className="grid two">
              <Field label="实物编号或 ID" name="item_code"/>
              <Select label="盘点结果" name="status" choices={[
                {id:"matched",label:"账实相符 (matched)"},
                {id:"missing",label:"缺失冻结 (missing)"},
                {id:"relocated",label:"错位 (relocated)"},
                {id:"found",label:"寻回解冻 (found)"},
              ]}/>
            </div>
            <div className="grid two">
              <Field label="实盘库位码（如 A-01-01 或库位 UUID，错位/寻回时填写）" name="actual_location" required={false}/>
              <Field label="差异说明" name="note" required={false}/>
            </div>
          </Form>}
          {active.state==="in_progress"&&canCreateOrScan&&<Action run={async()=>{
            await request(`/staff/stocktakes/${active.id}/submit`,"POST",{reason:"Submitted from stocktake workspace"});
            reload();
          }}>提交盘点结果（有差异自动转主管复核）</Action>}
          {active.state==="submitted"&&(
            canApproveStocktake?(
              isSelfOperator
                ?<div className="notice">该盘点由当前账号发起/提交，按职责分离须由另一名仓库主管（warehouse_admin / super_admin）复核批准。</div>
                :<div className="card">
                  <strong>主管盘点差异独立复核（T102）</strong>
                  <Form label="提交复核结论" run={async f=>{
                    await request(`/staff/stocktakes/${active.id}/approve`,"POST",{
                      decision:text(f,"decision"),
                      reason:text(f,"reason"),
                    });
                    reload();
                  }}>
                    <Select label="复核决定" name="decision" value="approve" choices={[
                      {id:"approve",label:"批准库存位置/盘点调整"},
                      {id:"recount",label:"退回重新复盘 (recount)"},
                    ]}/>
                    <Field label="复核结论与处理说明" name="reason" value="Approved stocktake discrepancy"/>
                  </Form>
                </div>
            ):<div className="notice">盘点已提交，等待仓库主管独立复核批准。</div>
          )}
          <Table headers={["实物编号","客户 / 订单","品名 / 款号","快照库位","实盘 / 调整库位","盘点与调账留痕","依据说明"]} rows={activeItems.map((it:Row)=>[
            <Link key="ic" className="code" href={`/wh/samples/${encodeURIComponent(it.item_code)}`}>{it.item_code}</Link>,
            <div key="co" className="cell-stack">
              <span className="code">{it.receiving_code??"—"}</span>
              {it.order_no&&<small className="code">{it.order_no}</small>}
            </div>,
            <div key="pn" className="cell-stack">
              <span>{it.product_name??"—"}</span>
              {it.sample_code&&<small className="code">{it.sample_code}</small>}
            </div>,
            <span key="ex" className="code">{it.expected_location_code??"—"}</span>,
            <div key="ac" className="cell-stack">
              <span className="code">{it.actual_location_code??(it.state==="adjusted"?"确认缺失（未在库）":"—")}</span>
              {it.live_location_code&&<small className="muted">现库位 {it.live_location_code}</small>}
            </div>,
            <div key="st" className="cell-stack">
              <Tag tone={it.state==="investigating"?"red":it.state==="adjusted"?"yellow":"green"}>
                {it.state==="adjusted"?"已批准差异调账":it.state==="investigating"?"差异冻结调查中":it.state==="recount_required"?"退回重盘":"账实相符"}
              </Tag>
              {it.approved_by_name&&<small className="muted">审批：{it.approved_by_name}</small>}
            </div>,
            it.adjustment_reason||"—",
          ])} empty="该盘点范围下无在库实物。"/>
        </div>:<Empty>尚无盘点任务，请先在左侧创建。</Empty>}
      </div>
    </div>
  </Panel>;
}
