"use client";

import Link from "next/link";
import { ScopeReview } from "./scope-review";
import { ReportShares } from "./report-sharing";
import { RecentUpdates } from "./notifications";
import { PlatformIcon } from "./chrome";
import { ApparelIllustration } from "./report-guide";
import { CategoryTiles } from "./category-coverage";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { conditionMatches } from "../packages/core/template-conditions";
import { customerDestination, legalPages, orderSections, type OrderSection, servicePages } from "../packages/core/portal-routes";
import { Action, checked, CodeButton, Empty, ErrorBlock, Field, Form, MediaLightbox, ModalDrawer, Panel, Photo, request, RequestError, Select, stamp, Table, Tabs, Tag, text, useLoad, usd, type Row } from "./ui";

const acknowledged={scope_notice:"I understand which checks are included.",samples_not_batch:"These samples do not represent an entire production batch.",seller_refund_is_mine:"I handle any refund request directly with my seller.",no_certification:"The report is an inspection record and does not provide certification.",restricted_items:"My items comply with the restricted items policy."};
const states:Record<string,string>={checked_in:"Received at warehouse",awaiting_warehouse:"Awaiting warehouse check-in",samples_ready:"Samples ready",pending_safe_storage:"Pending safe storage",draft:"Draft",awaiting_payment:"Awaiting payment",awaiting_samples:"Awaiting items",queued:"Ready for inspection",inspecting:"Inspection underway",qa_review:"Under review",report_ready:"Report ready",action_pending:"Awaiting disposition",cancelled:"Cancelled",closed:"Closed",on_hold:"On hold"};
const label=(state:string|null|undefined)=>state?states[state]??state.replaceAll("_"," "):"—";
const parcelLinkStates=["draft","awaiting_payment","awaiting_samples","on_hold"];
const orderNext:Record<string,string>={
  draft:"Review the inspection scope and calculate a quote.",
  awaiting_payment:"Review or resume the inspection payment.",
  awaiting_samples:"Add the seller’s tracking number. Inspection starts after all commissioned items are received and identified.",
  queued:"The items are ready and the order is waiting for an inspector.",
  inspecting:"The warehouse is checking the commissioned items.",
  qa_review:"The report is undergoing independent review.",
  report_ready:"Review the published report, then choose what happens to each item.",
  action_pending:"Review your warehouse items and outstanding handling instructions.",
  on_hold:"Review any open support cases for this order.",
  cancelled:"Inspection has ended. Any items still held by the warehouse remain available for handling instructions.",
};

const serviceDetails={
  inspection:{
    title:"Product Inspection",
    description:"Visual quality, dimensional checks and observable workmanship, item by item.",
    fourthPoint:"Individual findings and exceptions",
  },
  compare:{
    title:"Sample Comparison",
    description:"Compare equivalent samples under the same inspection conditions.",
    fourthPoint:"Side-by-side matrix and observable differences",
  },
  reference_match:{
    title:"Reference Sample Matching",
    description:"Evaluate new samples against a reference you approve and authorize us to retain.",
    fourthPoint:"Reference sample discrepancies and declared tolerance",
  },
};

const prototypeCategories=[
  {id:"apparel",name:"Apparel",state:"ACTIVE",desc:"T-shirts, leggings, sportswear and dresses",icon:"♧"},
  {id:"footwear",name:"Footwear",state:"PLANNED",desc:"Shoes, sneakers and footwear",icon:"◈"},
  {id:"bags",name:"Bags & Accessories",state:"PLANNED",desc:"Handbags, backpacks and accessories",icon:"▢"},
  {id:"home",name:"Home & Lifestyle",state:"PLANNED",desc:"Home textiles, decor and everyday goods",icon:"⌂"},
  {id:"electronics",name:"Electronics",state:"RESTRICTED",desc:"Limited visual checks only; no electrical certification",icon:"▤"},
  {id:"toys",name:"Toys & Children’s Products",state:"RESTRICTED",desc:"Safety-critical checks require separate capability review",icon:"◇"},
] as const;

export function Catalog({path}:{path:string}) {
  const {data,error,reload}=useLoad("/catalog");
  const [category,setCategory]=useState<string>();
  const [estService,setEstService]=useState<"inspection"|"compare"|"reference_match">("compare");
  const [estQty,setEstQty]=useState<number>(3);
  const requestedCategory=useSearchParams().get("category")??"";
  const service=servicePages[path as keyof typeof servicePages];
  const info=service?serviceDetails[service]:null;
  const allOffers:Row[]=data?.offers??[];
  const offers:Row[]=allOffers.filter((offer:Row)=>!service||offer.service===service);
  const categories=new Map<string,string>(offers.map(o=>[o.category_id,o.category.en]));
  const firstCatId=categories.keys().next().value??"";
  const activeCategory=category??(requestedCategory||firstCatId);
  const selected=categories.has(activeCategory)?activeCategory:"";
  const isCategories=path==="/categories",isPricing=path==="/pricing";

  const matchProtoOffer=(id:string)=>allOffers.find((o:Row)=>{
    const en=String(o.category?.en??"").toLowerCase();
    return id==="apparel"?en.includes("apparel"):
      id==="footwear"?en.includes("footwear"):
      id==="bags"?en.includes("bag"):
      id==="home"?en.includes("home"):
      id==="electronics"?en.includes("electronic"):
      id==="toys"?en.includes("toy"):false;
  });
  const matchedCatIds=new Set<string>();
  const baseCategoryCards=prototypeCategories.map(c=>{
    const liveOffer=matchProtoOffer(c.id);
    if(liveOffer?.category_id) matchedCatIds.add(liveOffer.category_id);
    return {...c,state:liveOffer?"ACTIVE":c.state,liveOffer};
  });
  const extraCategoryCards:[string,Row][]=[];
  for(const o of allOffers) {
    if(o.category_id&&!matchedCatIds.has(o.category_id)&&!extraCategoryCards.some(([cid])=>cid===o.category_id)) {
      extraCategoryCards.push([o.category_id,o]);
    }
  }
  const categoryCards=[
    ...baseCategoryCards,
    ...extraCategoryCards.map(([cid,o])=>({
      id:cid,
      name:o.category?.en??"Approved Category",
      state:"ACTIVE" as const,
      desc:"Approved inspection templates, capabilities and versioned pricing active.",
      icon:"◈",
      liveOffer:o,
    })),
  ];

  const inspOffers=allOffers.filter(o=>o.service==="inspection");
  const compOffers=allOffers.filter(o=>o.service==="compare");
  const refOffers=allOffers.filter(o=>o.service==="reference_match");
  const formatRange=(pool:Row[],prefix="")=>{
    if(!pool.length) return data?"Quote on request":"Loading…";
    const vals=pool.map(o=>Number(o.rules.unit_cents??o.rules.package_cents??0)).filter(n=>n>0);
    if(!vals.length) return "Quote on request";
    const lo=Math.min(...vals),hi=Math.max(...vals);
    return lo===hi?`${prefix}${usd(lo)}`:`${usd(lo)}–${usd(hi)}`;
  };
  const estPool=allOffers.filter(o=>o.service===estService);
  const estOffer=estPool.find(o=>estQty>=o.rules.minimum&&estQty<=o.rules.maximum)??estPool[0];
  const estCents:number|null=estOffer
    ?(estOffer.rules.unit_cents!=null?estOffer.rules.unit_cents*Math.max(1,estQty):(estOffer.rules.package_cents??null))
    :null;

  const pageTitle = info?.title ?? (isCategories ? "Product Categories" : isPricing ? "Service Pricing" : "Inspection Services");
  const pageSub = info?.description ?? (
    isCategories ? "One platform. Inspection methods and service availability are controlled per category." :
    isPricing ? "Approved pricing and processing capacity govern real orders. Product inspection fee is separate from shipping, handling and storage." :
    "Select a product category and inspection service to see approved templates and quantity ranges."
  );

  return <>
    <div className="breadcrumb"><Link href="/">QCWarehouse</Link> &nbsp; › &nbsp; <b>{pageTitle}</b></div>
    <section className="page-head">
      <div>
        <p className="eyebrow">QCWAREHOUSE / INSPECTION</p>
        <h1>{pageTitle}</h1>
        <p className="muted">{pageSub}</p>
      </div>
      <div className="head-actions">
        {info&&<Link className="button sm" href="/report-guide">View sample report</Link>}
        <Link className="button primary" href="/orders/new">{info?"Start This Service":isPricing?"Get Started":"Start Inspection"}</Link>
      </div>
    </section>

    {info&&<>
      <div className="small-hero">
        <div className="row between flexwrap">
          <div>
            <div className="label">SERVICE FRAMEWORK / APPAREL LIVE</div>
            <h2 style={{margin:"9px 0"}}>{info.title}</h2>
            <p style={{maxWidth:560}}>{info.description}</p>
            <div className="row flexwrap">
              <span className="tag blue">Versioned checklist</span>
              <span className="tag green">Sample-level evidence</span>
              <span className="tag blue">Report available</span>
            </div>
          </div>
          <div className="product-illustration" style={{width:190,maxWidth:"100%"}}>
            <ApparelIllustration kind="shirt"/>
          </div>
        </div>
      </div>
      <div className="grid cols2">
        <section className="card">
          <div className="card-head"><div><h3>What we inspect</h3><p>Select only checks approved for the product category.</p></div></div>
          <ul className="list">
            <li><span className="idx">1</span>Sample identity, quantity and packaging</li>
            <li><span className="idx">2</span>Visual condition, workmanship and visible damage</li>
            <li><span className="idx">3</span>Applicable measurements and photo evidence</li>
            <li><span className="idx">4</span>{info.fourthPoint}</li>
          </ul>
        </section>
        <section className="card">
          <div className="card-head"><div><h3>Scope and availability</h3><p>Exact contents depend on the chosen category and template.</p></div></div>
          <div className="metric-list">
            {["Apparel ACTIVE","Laboratory tests not included","Other categories gated","Domestic forwarding optional"].map(t=>
              <div className="metric-box" key={t}><div className="cap">SERVICE CONDITION</div><strong>{t}</strong></div>
            )}
          </div>
          <div className="sep"/>
          <div className="row flexwrap">
            <Link className="button sm" href="/report-guide">View sample report</Link>
            <Link className="button sm" href="/pricing">Pricing</Link>
          </div>
        </section>
      </div>
    </>}

    {isCategories&&<>
      <div className="grid cols3" style={{marginBottom:18}}>
        {categoryCards.map(c=>{
          const liveOffer=c.liveOffer;
          return <div className="card flat" key={c.id}>
            <div className="category-card">
              <div className="glyph">{c.icon}</div>
              <div style={{flex:1}}>
                <div className="row between">
                  <strong>{c.name}</strong>
                  <span className={`tag ${c.state==="ACTIVE"?"green":c.state==="PLANNED"?"yellow":"red"}`}>
                    {c.state==="ACTIVE"?"Available":c.state==="PLANNED"?"Planned":"Restricted"}
                  </span>
                </div>
                <p style={{margin:"8px 0 12px"}}>{c.desc}</p>
                <div className="row flexwrap">
                  {c.state==="ACTIVE"?(
                    <Link className="button primary sm" href={liveOffer?"/orders/new?offer="+liveOffer.offer_id:"/orders/new"}>Select category →</Link>
                  ):(
                    <Link className="button sm" href="/contact">Ask about this category</Link>
                  )}
                </div>
              </div>
            </div>
          </div>;
        })}
      </div>
      <div style={{display:"none"}}><CategoryTiles offers={offers.map(offer=>({category_id:offer.category_id,category:offer.category}))}/></div>
      <section className="card">
        <div className="card-head"><div><h3>Category activation is governed</h3><p>A future category is not automatically eligible for checkout.</p></div></div>
        <div className="grid cols3">
          {([
            ["1","Versioned template and evidence rules"],
            ["2","Equipment, staff and SOP approved"],
            ["3","Price, service terms and test report validated"],
          ] as const).map(([num,text])=><div className="data-sample" key={num}>
            <span className="number-tile">{num}</span>
            <div style={{marginTop:10}}><strong>{text}</strong></div>
          </div>)}
        </div>
      </section>
    </>}

    {isPricing&&<>
      <div className="line-note warning" style={{marginBottom:18}}>
        Product inspection fee is separate from shipping, additional handling, storage and any tax. Server-confirmed price snapshots govern real orders.
      </div>
      <div className="grid cols3" style={{marginBottom:18}}>
        {([
          ["Individual Inspection",formatRange(inspOffers,"From "),"per physical item","Single or multiple physical samples, each checked separately.","/services/inspection"],
          ["Sample Comparison",formatRange(compOffers),"2–3 sample comparison set","Side-by-side comparison of compatible samples under approved templates.","/services/compare"],
          ["Reference Matching",formatRange(refOffers),"per new comparison","Compare a new sample against an eligible reference sample stored in your account.","/services/reference"],
        ] as const).map(([label,price,unit,desc,href])=><div className="card" key={label}>
          <div className="label">{label}</div>
          <h2 style={{margin:"14px 0 2px"}}>{price}</h2>
          <div className="small muted">{unit}</div>
          <p style={{minHeight:65,margin:"20px 0"}}>{desc}</p>
          <div className="row flexwrap">
            <Link className="button primary full" href="/orders/new">Configure inspection</Link>
          </div>
          <div style={{marginTop:8,textAlign:"center"}}><Link className="small" href={href}>Service details →</Link></div>
        </div>)}
      </div>
      <section className="card">
        <div className="card-head"><div><h3>Estimate the inspection fee</h3><p>Select a service and sample quantity to preview the active server catalog rate.</p></div></div>
        <div className="fields">
          <div className="field">
            <label htmlFor="pricing-service">Service</label>
            <select id="pricing-service" value={estService} onChange={e=>setEstService(e.target.value as "inspection"|"compare"|"reference_match")}>
              <option value="inspection">Individual Inspection</option>
              <option value="compare">Sample Comparison</option>
              <option value="reference_match">Reference Matching</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="pricing-qty">Quantity</label>
            <select id="pricing-qty" value={estQty} onChange={e=>setEstQty(Number(e.target.value))}>
              {(estService==="compare"?[2,3]:estService==="reference_match"?[1,2,3,5]:[1,2,3,4,5,10,30]).map(n=><option key={n} value={n}>{n} {n===1?"item":"items"}</option>)}
            </select>
          </div>
        </div>
        <div className="display-quote" style={{marginTop:16}}>
          <div className="label">Estimate, excl. shipping</div>
          <div className="big">{estCents!=null?usd(estCents):(data?"Manual quote required":"Loading…")}</div>
          <div className="small muted">Exact eligibility, scope, capacity and item count are checked before order payment.</div>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><div><h3>Fee structure &amp; billing timing</h3></div></div>
        <div className="tablewrap">
          <table className="tbl">
            <thead><tr><th>Charge type</th><th>When charged</th><th>Remarks</th></tr></thead>
            <tbody>
              <tr><td>Inspection fee</td><td>After scope approval</td><td>Before inspection work begins</td></tr>
              <tr><td>Domestic forwarding</td><td>After item selection and weighing</td><td>Quoted per package, not part of inspection fee</td></tr>
              <tr><td>Storage extension</td><td>After free storage ends</td><td>Per-item, configurable by policy</td></tr>
              <tr><td>Refund / adjustment</td><td>Only after review</td><td>Approval is not a completed refund</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </>}

    {!isCategories&&!isPricing&&<>
      {path==="/catalog"&&<div className="land-services catalog-coverage" style={{marginBottom:18}}>
        {Object.entries(servicePages).map(([href,code])=><Link className="land-svc" href={href} key={href}><span className="symbol"><PlatformIcon name={code==="compare"?"compare":code==="inspection"?"inspection":"packages"}/></span>
          <h3>{serviceDetails[code].title}</h3><p>{serviceDetails[code].description}</p><span className="go">View service →</span></Link>)}
      </div>}

      <Tabs path={path} links={[["/catalog","All services"],...Object.entries(servicePages).map(([href,code]):[string,string]=>[href,serviceDetails[code].title])]}/>
      {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Try again</button></>}
      {!data&&!error&&<p role="status">Loading services…</p>}
      {categories.size>0&&<div className="catalog-filter"><h2>Available service packages</h2><div className="actions" aria-label="Product categories">{[...categories].map(([id,name])=>
        <button type="button" className={selected===id?"primary":""} aria-pressed={selected===id} key={id} onClick={()=>setCategory(id)}>{name}</button>)}</div></div>}
      {categories.size>0&&!selected&&<p className="muted">Select a category to see available checks and pricing.</p>}
      {selected&&<section className="catalog-offers" aria-label={categories.get(selected)+" offers"}>
        {offers.filter(o=>o.category_id===selected).map((o:Row)=><article className="catalog-offer" key={o.offer_id}>
          <div><p className="eyebrow">{o.sku_code}</p><h2>{o.title.en}</h2>
            <p>{o.rules.minimum===o.rules.maximum?o.rules.minimum:o.rules.minimum+"–"+o.rules.maximum} items · {o.rules.business_days} business days after all items are received and identified</p>
            {o.rules.demo&&<p className="muted small">Development catalogue and prices</p>}
          </div>
          <div className="catalog-price"><div><strong>{usd(o.rules.unit_cents??o.rules.package_cents)}</strong><small>{o.rules.unit_cents!=null?"per item":"per group"}</small></div>
            <Link className="button primary" href={"/orders/new?offer="+o.offer_id}>Choose service</Link>
          </div>
        </article>)}
      </section>}
      {data&&offers.length===0&&<Empty>No matching services are available for purchase yet.</Empty>}
      <div className="catalog-support"><div><h2>Need a different scope?</h2><p className="muted">Tell us the category, quantity and checks you need.</p></div><Link className="button" href="/contact">Request a custom inspection →</Link></div>
    </>}
  </>;
}
const legalTitles:Record<string,string>={terms:"Terms of Service",privacy:"Privacy Policy",restricted_items:"Restricted Items",report_notice:"Report Limitations"};
function PolicyLinks({policies}:{policies:Row[]}) {
  return <ul>{policies.map(t=>{
    const page=Object.entries(legalPages).find(([,kind])=>kind===t.kind)?.[0];
    return page&&<li key={t.kind}><Link href={page+"?"+new URLSearchParams({version:t.version})}
      target="_blank" rel="noreferrer">{legalTitles[t.kind]} · {t.version} <span className="muted">(new tab)</span></Link></li>;
  })}</ul>;
}
export function Legal({path}:{path:string}) {
  const kind=legalPages[path as keyof typeof legalPages];
  const query=useSearchParams();
  const versions=query.getAll("version");
  const suffix=versions.length?"?"+new URLSearchParams(versions.map(v=>["version",v])):"";
  const {data,error,reload}=useLoad("/public/terms"+(kind?"/"+kind+suffix:""));
  const terms:Row[]=data?.terms??[];
  const title=kind?legalTitles[kind]:"Terms & Privacy";
  return <>
    <div className="breadcrumb"><Link href="/">QCWarehouse</Link> &nbsp; › &nbsp; <b>{title}</b></div>
    <div className="page-head">
      <div>
        <p className="eyebrow">QCWAREHOUSE / POLICIES</p>
        <h1>{title}</h1>
        <p className="muted">Historical customer consents and the exact policy version at the point of order remain retrievable.</p>
      </div>
      <div className="head-actions">
        <Link className="button sm" href="/orders/new">Return to order</Link>
      </div>
    </div>
    <Tabs path={path} links={Object.entries(legalPages).map(([href,key]):[string,string]=>[href,legalTitles[key]])}/>
    {kind&&versions.length>0&&<p><Link href={path}>View the current version</Link></p>}
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Try again</button></>}
    {!data&&!error&&<p role="status">Loading policies…</p>}
    {data&&terms.length===0&&<Empty>No current version is available.</Empty>}
    {terms.map(t=><Panel key={t.id} title={legalTitles[t.kind]} badge={<span className="tag yellow">Version {t.version}</span>}>
      <p className="muted">Version {t.version} · Effective <time dateTime={t.effective_at}>{t.effective_at.slice(0,10)} UTC</time></p>
      <div className="policy-content">{t.content_md}</div>
    </Panel>)}
  </>;
}
const customerSteps=[
  ["Register & get your receiving code","Every account receives a permanent personal parcel code and the current common receiving address."],
  ["Buy from your supplier","Purchase yourself; share the receiving details with a domestic Chinese seller or factory."],
  ["Track and identify parcels","Record the seller’s actual carrier tracking number. Warehouse receipt is confirmed independently from carrier delivery."],
  ["Inspection & quality review","Inspect by approved category template; attach evidence to exact samples and run independent review."],
  ["Review report & direct handling","Receive a versioned report; tell us exactly which items to store, consolidate, forward or return."],
];
export function HowItWorks() {
  return <>
    <div className="breadcrumb"><Link href="/">QCWarehouse</Link> &nbsp; › &nbsp; <b>How It Works</b></div>
    <div className="page-head">
      <div>
        <p className="eyebrow">QCWAREHOUSE / INSPECTION</p>
        <h1>How It Works</h1>
        <p className="muted">A clear chain of custody from a seller’s parcel to a documented inspection report.</p>
      </div>
      <div className="head-actions">
        <Link className="button primary" href="/orders/new">Create Inspection</Link>
      </div>
    </div>
    <section className="card">
      <div className="grid cols5">
        {customerSteps.map(([title,body],index)=><div key={title}>
          <span className="number-tile">{String(index+1).padStart(2,"0")}</span>
          <h3 style={{margin:"13px 0 8px"}}>{title}</h3>
          <p className="small">{body}</p>
        </div>)}
      </div>
    </section>
    <section className="card">
      <div className="card-head"><div><h3>Who is responsible?</h3></div></div>
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th>Action</th><th>Customer</th><th>QCWarehouse</th></tr></thead>
          <tbody>
            <tr><td>Purchase &amp; supplier payment</td><td><span className="tag blue">Responsible</span></td><td>Not provided</td></tr>
            <tr><td>Initial domestic shipment</td><td><span className="tag blue">Provide tracking</span></td><td>Track / receive</td></tr>
            <tr><td>Physical inspection</td><td>Specify requested scope</td><td><span className="tag green">Executes approved checks</span></td></tr>
            <tr><td>Return authorization</td><td>Obtain address / request return</td><td><span className="tag green">Ship upon instruction</span></td></tr>
            <tr><td>International shipping</td><td>Arrange with your forwarder</td><td>Domestic handoff only when authorized</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <div className="line-note" style={{marginBottom:18}}>
      The inspection start date is calculated only after the agreed samples are physically received, identified, and the service scope and payment are confirmed.
    </div>
    <div className="actions"><Link className="button primary" href="/catalog">Find an inspection service</Link><Link className="button" href="/faq">Read frequently asked questions</Link></div>
  </>;
}
const wizardCategoryCatalog=[
  {key:"apparel",name:"Apparel",icon:"♧",fallbackState:"ACTIVE"},
  {key:"footwear",name:"Footwear",icon:"◈",fallbackState:"PLANNED"},
  {key:"bags",name:"Bags & Accessories",icon:"▢",fallbackState:"PLANNED"},
  {key:"home",name:"Home & Lifestyle",icon:"⌂",fallbackState:"PLANNED"},
  {key:"electronics",name:"Electronics",icon:"▤",fallbackState:"RESTRICTED"},
] as const;

const wizardServiceCards=[
  {
    service:"inspection",
    title:"Product Inspection",
    desc:"Check individual items for measurements, workmanship, labels, and visible defects.",
    unitLabel:"Per item",
    icon:"⌕",
  },
  {
    service:"compare",
    title:"Sample Comparison",
    desc:"Compare 2 or 3 supplier samples side-by-side under the exact same checklist and camera angles.",
    unitLabel:"2 or 3 sample package",
    icon:"≍",
  },
  {
    service:"reference_match",
    title:"Golden Sample Matching",
    desc:"Check new restock or pre-shipment items against your sealed, approved reference sample in our vault.",
    unitLabel:"Per candidate item",
    icon:"▧",
  },
] as const;

const apparelTemplateOptions=[
  {
    variant:"tops",
    garmentType:"tops",
    label:"Tops & Knitwear",
  },
  {
    variant:"leggings",
    garmentType:"bottoms",
    label:"Bottoms & Leggings",
  },
  {
    variant:"sports",
    garmentType:"sports_bra",
    label:"Sports Bras",
  },
  {
    variant:"basic",
    garmentType:undefined,
    label:"General Apparel",
  },
] as const;

function templateVariantFor(offer:Row) {
  return apparelTemplateOptions.find(option=>option.garmentType===offer.content?.subcategory)?.variant??"basic";
}

function offerFor(offers:Row[],variant:string,quantity:number) {
  return offers.find(offer=>templateVariantFor(offer)===variant&&quantity>=offer.rules.minimum&&quantity<=offer.rules.maximum);
}

const maximumDraftItems=300;
const wizardPolicyKinds=["terms","privacy","restricted_items","report_notice"];
const quoteTimeoutMs=15000;

export function NewOrder() {
  const {data,error}=useLoad("/catalog");
  const refs=useLoad("/me/reference-samples");
  const receiving=useLoad("/me/receiving-address");
  const terms=useLoad("/public/terms");

  const [step,setStep]=useState(0);
  const stepPanel=useRef<HTMLDivElement>(null);
  const previousStep=useRef(step);
  useEffect(()=>{
    if(previousStep.current!==step) stepPanel.current?.scrollIntoView({block:"start"});
    previousStep.current=step;
  },[step]);
  const [summaryOpen,setSummaryOpen]=useState(false);
  const [categoryKey,setCategoryKey]=useState<string>("apparel");
  const [serviceKind,setServiceKind]=useState<"inspection"|"compare"|"reference_match">("inspection");
  const [selectedOfferId,setSelectedOfferId]=useState("");
  const [templateVariant,setTemplateVariant]=useState("tops");
  const [qty,setQty]=useState(3);
  const [manualQuoteMode,setManualQuoteMode]=useState(false);
  const [manualBatchQty,setManualBatchQty]=useState(150);
  const [manualQuoteReason,setManualQuoteReason]=useState("");
  const [manualQuoteSubmitted,setManualQuoteSubmitted]=useState<{orderNo:string;requestState:string;qty:number}|null>(null);

  const [itemName,setItemName]=useState("");
  const [supplierRef,setSupplierRef]=useState("");
  const [baseSku,setBaseSku]=useState("ITEM");
  const [baseColor,setBaseColor]=useState("");
  const [baseSize,setBaseSize]=useState("");
  const [baseTrackingNo,setBaseTrackingNo]=useState("");
  const [productLink,setProductLink]=useState("");
  const [toleranceMode,setToleranceMode]=useState<"record_only"|"custom">("record_only");
  const [pointTolerances,setPointTolerances]=useState<Record<string,{target:string;plusMinus:string}>>({});
  const [referenceId,setReferenceId]=useState("");
  const [sizeMismatchConfirmed,setSizeMismatchConfirmed]=useState(false);
  const [itemRows,setItemRows]=useState<Partial<Record<"sku"|"size"|"color"|"supplier"|"tracking_no",string>>[]>([]);
  const [itemPage,setItemPage]=useState(0);
  const [showFullChecklist,setShowFullChecklist]=useState(false);
  const [notes,setNotes]=useState("");
  const [attachmentId,setAttachmentId]=useState<string>();
  const [attachmentName,setAttachmentName]=useState<string>();
  const [extraLines,setExtraLines]=useState<Row[]>([]);
  const [consents,setConsents]=useState<Record<string,boolean>>({});
  const [policyAccepted,setPolicyAccepted]=useState(false);
  const [quotedFingerprint,setQuotedFingerprint]=useState("");
  const [quoteExpired,setQuoteExpired]=useState(false);
  const draftWrite=useRef<{fingerprint:string;key:string}>(null);
  const savedFingerprint=useRef("");
  const quoteWrite=useRef<{revision:number;key:string}>(null);
  const submitKey=useRef("");
  const inFlight=useRef(false);
  const [draftOrder,setDraftOrder]=useState<Row>();
  const [serverQuote,setServerQuote]=useState<Row>();
  const [submittedCharge,setSubmittedCharge]=useState<Row>();
  const [busyMessage,setBusyMessage]=useState("");
  const [savedNotice,setSavedNotice]=useState("");
  const [wizardError,setWizardError]=useState("");

  const offers:Row[]=data?.offers??[];

  // Match prototype category key or dynamic category_id to real backend category_id
  function resolveCategoryId(key:string):string|undefined {
    return offers.find(offer=>offer.category_id===key||offer.category_slug===key)?.category_id;
  }

  const catalogCategories=[...new Map(offers.map(offer=>[offer.category_id,offer])).values()];
  const wizardCategories:{key:string;name:string;icon:string;fallbackState:string}[]=wizardCategoryCatalog.filter(category=>
    resolveCategoryId(category.key)||!catalogCategories.some(offer=>offer.category?.en?.toLowerCase()===category.name.toLowerCase())
  ).map(category=>({...category,name:catalogCategories.find(offer=>offer.category_slug===category.key)?.category?.en??category.name}));
  for(const offer of catalogCategories) {
    if(!wizardCategories.some(category=>category.key===offer.category_slug)) {
      wizardCategories.push({key:offer.category_slug??offer.category_id,name:offer.category?.en??"Available category",icon:"◈",fallbackState:"ACTIVE"});
    }
  }

  const [draftLoadedNo,setDraftLoadedNo]=useState("");

  useEffect(()=>{
    const params=new URLSearchParams(location.search);
    const requestedOffer=params.get("offer")??"";
    if(data&&!requestedOffer&&!params.has("draft")) {
      const first=offers.find(o=>o.category_slug==="apparel"&&o.service==="inspection"&&templateVariantFor(o)==="tops")
        ??offers.find(o=>o.category_slug==="apparel"&&o.service==="inspection")??offers[0];
      if(first) {
        setCategoryKey(first.category_slug??first.category_id);
        setSelectedOfferId(first.offer_id);
        setServiceKind(first.service);
        setTemplateVariant(templateVariantFor(first));
        setQty(Math.max(first.rules.minimum,Math.min(first.rules.maximum,3)));
      }
    }
    if(requestedOffer && offers.length>0) {
      const matched=offers.find(x=>x.offer_id===requestedOffer);
      if(matched) {
        const matchedCat=wizardCategories.find(c=>resolveCategoryId(c.key)===matched.category_id);
        if(matchedCat) setCategoryKey(matchedCat.key);
        setSelectedOfferId(matched.offer_id);
        setServiceKind(matched.service);
        setTemplateVariant(templateVariantFor(matched));
        setQty(matched.service==="compare"?matched.rules.minimum:Math.max(1,matched.rules.minimum));
      }
    }
    const requestedDraft=params.get("draft")?.trim()??"";
    if(requestedDraft && data && draftLoadedNo!==requestedDraft) {
      setDraftLoadedNo(requestedDraft);
      (async()=>{
        try {
          setBusyMessage(`Loading draft ${requestedDraft}…`);
          const found=await request("/orders/by-number/"+encodeURIComponent(requestedDraft));
          const ord=await request("/orders/"+found.id);
          if(ord.state!=="draft") {
            location.assign("/orders/"+ord.public_no);
            return;
          }
          setDraftOrder(ord);
          if(ord.customer_notes) setNotes(String(ord.customer_notes));
          const lines:Row[]=Array.isArray(ord.lines)?ord.lines:[];
          if(lines.length>0) {
            const primary=lines[lines.length-1];
            const prevLines=lines.slice(0,-1).map((l:Row)=>({
              category_id:l.category_id,
              offer_id:l.offer_id,
              template_version_id:l.template_version_id,
              quantity:l.quantity,
              title:l.title?.en??l.sku_code??"Service line",
              options:l.options??{},
              attributes:l.attributes??{},
              items:Array.isArray(l.draft_items)?l.draft_items:[],
            }));
            setExtraLines(prevLines);
            const matchedOffer=offers.find(x=>x.offer_id===primary.offer_id);
            if(matchedOffer) {
              const matchedCat=wizardCategories.find(c=>resolveCategoryId(c.key)===matchedOffer.category_id);
              if(matchedCat) setCategoryKey(matchedCat.key);
              setSelectedOfferId(matchedOffer.offer_id);
              setServiceKind(matchedOffer.service);
              setTemplateVariant(templateVariantFor(matchedOffer));
            }
            if(primary.quantity) setQty(Number(primary.quantity));
            if(!matchedOffer) {
              setWizardError("This saved service is no longer available. Select a current service before editing this draft.");
              setCategoryKey(primary.category_id);
              setSelectedOfferId(primary.offer_id);
            }
            if(ord.manual_quote) {
              setManualQuoteMode(true);
              setManualBatchQty(Number(primary.quantity));
              setManualQuoteSubmitted({orderNo:ord.public_no,requestState:ord.manual_quote.state,qty:Number(primary.quantity)});
            }
            const attrs=primary.attributes??{};
            setBaseSku(String(attrs.sample_code_prefix??"ITEM"));
            setBaseTrackingNo(String(attrs.tracking_no??""));
            if(attrs.attachment_ids?.[0]) {
              setAttachmentId(String(attrs.attachment_ids[0]));
              setAttachmentName("Saved reference photo");
            }
            setSizeMismatchConfirmed(primary.options?.size_mismatch_confirmed===true);
            const savedStep=Number(params.get("step"));
            setStep(!matchedOffer?0:ord.manual_quote?1:savedStep>=1&&savedStep<=4?savedStep:2);
            if(attrs.name) setItemName(String(attrs.name));
            if(attrs.supplier_ref) setSupplierRef(String(attrs.supplier_ref));
            if(attrs.product_url) setProductLink(String(attrs.product_url));
            if(attrs.size_label) setBaseSize(String(attrs.size_label));
            if(attrs.color_declared) setBaseColor(String(attrs.color_declared));
            if(Array.isArray(attrs.tolerances)&&attrs.tolerances.length>0) {
              setToleranceMode("custom");
              const restored:Record<string,{target:string;plusMinus:string}>={};
              for(const t of attrs.tolerances as Row[]) {
                const code=String(t.point_code??"");
                const min=Number(t.min);
                const max=Number(t.max);
                if(code&&Number.isFinite(min)&&Number.isFinite(max)) {
                  const mid=((min+max)/2).toFixed(1).replace(/\.0$/,"");
                  const pm=((max-min)/2).toFixed(1).replace(/\.0$/,"");
                  restored[code]={target:mid,plusMinus:pm};
                }
              }
              setPointTolerances(restored);
            }
            if(primary.options?.reference_id) setReferenceId(String(primary.options.reference_id));
            if(Array.isArray(primary.draft_items)&&primary.draft_items.length>0) {
              setItemRows(primary.draft_items.map((it:Row,idx:number)=>({
                sku:it.sample_code===`${attrs.sample_code_prefix??"ITEM"}-${String(idx+1).padStart(2,"0")}`?undefined:it.sample_code,
                size:it.size_label===attrs.size_label?undefined:it.size_label,
                color:it.color_declared===attrs.color_declared?undefined:it.color_declared,
                supplier:it.supplier_alias===attrs.supplier_ref?undefined:it.supplier_alias,
                tracking_no:it.tracking_no===attrs.tracking_no?undefined:it.tracking_no,
              })));
            }
          }
        } catch(err) {
          setWizardError(err instanceof Error?err.message:"Could not load draft order.");
        } finally {
          setBusyMessage("");
        }
      })();
    }
  },[data,draftLoadedNo]);

  const activeCategoryId=resolveCategoryId(categoryKey)??"";
  const categoryOffers=offers.filter(o=>o.category_id===activeCategoryId);
  const serviceOffers=categoryOffers.filter(o=>o.service===serviceKind);
  const templateOffers=serviceOffers.filter(o=>templateVariantFor(o)===templateVariant);
  const matchingPackages=templateOffers.filter(offer=>qty>=offer.rules.minimum&&qty<=offer.rules.maximum);
  const selectedOffer=templateOffers.find(o=>o.offer_id===selectedOfferId);
  const activeOffer=selectedOffer&&qty>=selectedOffer.rules.minimum&&qty<=selectedOffer.rules.maximum
    ?selectedOffer:offerFor(templateOffers,templateVariant,qty);
  const configuredOffer=activeOffer??selectedOffer??templateOffers[0];
  const selectedCategoryName=categoryOffers[0]?.category?.en??"Select a category";
  const isApparelCategory=categoryOffers.some(offer=>offer.category_slug==="apparel");
  const effectiveVariant=templateVariant;
  const activeTemplateOption=apparelTemplateOptions.find(opt=>opt.variant===effectiveVariant);
  const templateLabel=isApparelCategory?activeTemplateOption?.label??"Select a template":configuredOffer?.title.en??"Select a template";
  const activeGarmentType=isApparelCategory?activeTemplateOption?.garmentType:undefined;
  const minQty=Math.min(...templateOffers.map(o=>o.rules.minimum));
  const maxOnlineQty=Math.max(0,...templateOffers.map(o=>o.rules.maximum));
  const clampedQty=Number.isInteger(qty)&&qty>0&&qty<=maximumDraftItems?qty:0;
  const validQuantity=Boolean(activeOffer&&clampedQty);
  const availableTemplates=apparelTemplateOptions.filter(opt=>serviceOffers.some(o=>templateVariantFor(o)===opt.variant));
  const scopeAttributes={garment_type:activeGarmentType,name:itemName,size_label:baseSize,color_declared:baseColor,
    supplier_ref:supplierRef,supplier_alias:supplierRef,product_url:productLink,tracking_no:baseTrackingNo,
    ...(attachmentId?{attachment_ids:[attachmentId]}:{})};
  const allOfferChecks:Row[]=Array.isArray(configuredOffer?.content?.checks)?configuredOffer.content.checks:[];
  const filteredChecks=allOfferChecks.filter(c=>conditionMatches(c.applies_if,scopeAttributes)&&conditionMatches(c.required_if,scopeAttributes));
  const measurementChecks=filteredChecks.filter(c=>c.type==="number"&&c.unit);
  const visualChecks=filteredChecks.filter(c=>!measurementChecks.includes(c));
  const allOfferShots:Row[]=Array.isArray(configuredOffer?.content?.shots)?configuredOffer.content.shots:[];
  const filteredShots=allOfferShots.filter(shot=>shot.required&&conditionMatches(shot.required_if,scopeAttributes));

  function chooseOffer(offer:Row,quantity=qty) {
    setServiceKind(offer.service);
    setTemplateVariant(templateVariantFor(offer));
    setSelectedOfferId(offer.offer_id);
    setQty(Math.max(offer.rules.minimum,Math.min(offer.rules.maximum,quantity||offer.rules.minimum)));
    setManualQuoteMode(false);
    setReferenceId("");
    setSizeMismatchConfirmed(false);
    setPointTolerances({});
    setToleranceMode("record_only");
    setServerQuote(undefined);
    setSavedNotice("");
  }

  function selectTemplateVariant(variant:string) {
    const match=offerFor(serviceOffers,variant,qty)??serviceOffers.find(o=>templateVariantFor(o)===variant);
    if(match) chooseOffer(match);
  }

  function updateItemRow(index:number,changes:Partial<(typeof itemRows)[number]>) {
    setItemRows(prev=>{
      const next=[...prev];
      next[index]={...next[index],...changes};
      return next;
    });
    setServerQuote(undefined);
    setSavedNotice("");
  }

  function buildToleranceRules():{point_code:string;min:number;max:number;unit:string}[] {
    if(toleranceMode!=="custom") return [];
    const rules:{point_code:string;min:number;max:number;unit:string}[]=[];
    for(const chk of measurementChecks) {
      const code=String(chk.key??"");
      const entry=pointTolerances[code];
      if(!code||!entry) continue;
      const target=Number(entry.target);
      const pm=Number(entry.plusMinus);
      if(entry.target.trim()&&entry.plusMinus.trim()&&Number.isFinite(target)&&target>0&&Number.isFinite(pm)&&pm>=0&&pm<=target) {
        rules.push({
          point_code:code,
          min:Number(Math.max(0,target-pm).toFixed(2)),
          max:Number((target+pm).toFixed(2)),
          unit:String(chk.unit??"cm"),
        });
      }
    }
    return rules;
  }

  function buildCurrentLine(overrideQty?:number):Row|null {
    const offer=overrideQty===undefined?activeOffer:configuredOffer;
    if(!offer||(!validQuantity&&overrideQty===undefined)) return null;
    const effectiveQty=overrideQty??clampedQty;
    const tolRules=buildToleranceRules();
    const items=Array.from({length:effectiveQty},(_,idx)=>{
      const custom=itemRows[idx];
      const rowSku=custom?.sku?.trim()||`${baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
      const rowSize=custom?.size?.trim()||baseSize.trim();
      const rowColor=custom?.color?.trim()||baseColor.trim();
      const rowSupplier=custom?.supplier?.trim()||supplierRef.trim();
      const rowTracking=custom?.tracking_no?.trim()||baseTrackingNo.trim();
      return {
        position:idx+1,
        sample_code:rowSku.slice(0,40),
        ...(itemName.trim()?{name:itemName.trim().slice(0,120)}:{}),
        ...(rowSize?{size_label:rowSize}:{}),
        ...(rowColor?{color_declared:rowColor}:{}),
        ...(rowSupplier?{supplier_alias:rowSupplier}:{}),
        ...(rowTracking?{tracking_no:rowTracking}:{}),
        ...(activeGarmentType?{garment_type:activeGarmentType}:{}),
        ...(attachmentId?{attachment_ids:[attachmentId]}:{}),
      };
    });
    return {
      category_id:offer.category_id,
      offer_id:offer.offer_id,
      template_version_id:offer.template_version_id,
      quantity:effectiveQty,
      title:offer.title.en,
      options:{
        ...(offer.service==="reference_match"&&referenceId?{reference_id:referenceId}:{}),
        ...(sizeMismatchConfirmed?{size_mismatch_confirmed:true}:{}),
      },
      attributes:{
        sample_code_prefix:baseSku||"ITEM",
        ...(baseTrackingNo.trim()?{tracking_no:baseTrackingNo.trim()}:{}),
        ...(itemName.trim()?{name:itemName.trim().slice(0,120)}:{}),
        ...(supplierRef.trim()?{supplier_ref:supplierRef.trim(),supplier_alias:supplierRef.trim()}:{}),
        ...(activeGarmentType?{garment_type:activeGarmentType}:{}),
        ...(productLink.trim()?{product_url:productLink.trim()}:{}),
        ...(baseSize.trim()?{size_label:baseSize.trim()}:{}),
        ...(baseColor.trim()?{color_declared:baseColor.trim()}:{}),
        ...(tolRules.length>0?{tolerances:tolRules}:{}),
        ...(attachmentId?{attachment_ids:[attachmentId]}:{}),
      },
      items,
    };
  }

  const currentLine=buildCurrentLine();
  const allLines=extraLines.length>0?(currentLine?[...extraLines,currentLine]:extraLines):(currentLine?[currentLine]:[]);
  const totalItems=allLines.reduce((sum,l)=>sum+(Number(l.quantity)||0),0);

  const draftPayload={lines:allLines.map(({title,...line})=>line),customer_notes:notes.trim()};
  const fingerprint=JSON.stringify(draftPayload);
  const quoteForCurrentDraft=serverQuote&&quotedFingerprint===fingerprint;
  const isQuoteExpired=Boolean(quoteForCurrentDraft&&(quoteExpired||Date.parse(serverQuote!.expires_at)<=Date.now()));
  const hasValidQuote=Boolean(quoteForCurrentDraft&&!isQuoteExpired&&serverQuote!.order_id===draftOrder?.id);
  const estimates=allLines.map(line=>{
    const offer=offers.find(o=>o.offer_id===line.offer_id);
    return offer?(offer.rules.package_cents??offer.rules.unit_cents*line.quantity):null;
  });
  const estimatedCents=currentLine&&estimates.every(cents=>Number.isFinite(cents))?estimates.reduce((sum,cents)=>sum+cents,0):null;
  const displayCents=hasValidQuote?serverQuote!.amount_cents:estimatedCents;

  useEffect(()=>{
    setQuoteExpired(false);
    if(!serverQuote) return;
    const timer=setTimeout(()=>setQuoteExpired(true),Math.max(0,Date.parse(serverQuote.expires_at)-Date.now()));
    return ()=>clearTimeout(timer);
  },[serverQuote]);

  function syncDraftUrl(publicNo:string,currentStep:number) {
    const url=new URL(location.href);
    url.searchParams.delete("offer");
    url.searchParams.set("draft",publicNo);
    url.searchParams.set("step",String(Math.min(currentStep,4)));
    window.history.replaceState(window.history.state,"",url);
  }

  function checkDraftInputs(lines:Row[]) {
    if(!lines.length) throw new Error("Choose an available service and quantity.");
    if(lines.length>20||lines.reduce((sum,line)=>sum+line.quantity,0)>maximumDraftItems) {
      throw new Error("Orders can include up to 20 service lines and 300 items. Contact Support for a larger request.");
    }
    if(notes.trim().length>500) throw new Error("Keep special instructions within 500 characters.");
    if(productLink.trim()&&!/^https?:\/\//i.test(productLink.trim())) throw new Error("Enter a product link beginning with https:// or http://.");
    if(serviceKind==="compare"&&!sizeMismatchConfirmed&&new Set(currentLine?.items.map((item:Row)=>item.size_label).filter(Boolean)).size>1) {
      throw new Error("Confirm the size difference before comparing samples with different declared sizes.");
    }
    if(toleranceMode==="custom") {
      const configured=measurementChecks.filter(check=>pointTolerances[check.key]?.target||pointTolerances[check.key]?.plusMinus);
      if(!configured.length||configured.length!==buildToleranceRules().length) throw new Error("Enter a target and a valid tolerance for each measurement you started, or choose to record measurements only.");
    }
  }

  async function persistDraft(payload=draftPayload):Promise<Row> {
    checkDraftInputs(payload.lines);
    const input=JSON.stringify(payload);
    if(draftOrder&&savedFingerprint.current===input) return draftOrder;
    if(draftWrite.current?.fingerprint!==input) draftWrite.current={fingerprint:input,key:crypto.randomUUID()};
    const updated=await request(draftOrder?"/orders/"+draftOrder.id:"/orders",draftOrder?"PATCH":"POST",
      draftOrder?{...payload,revision:draftOrder.revision}:{
        lines:payload.lines,...(payload.customer_notes?{customer_notes:payload.customer_notes}:{}),
      },draftWrite.current.key);
    if(!updated.id||!updated.public_no||!updated.revision||updated.state!=="draft") {
      throw new Error("The draft could not be confirmed. Retry before proceeding.");
    }
    savedFingerprint.current=input;
    draftWrite.current=null;
    quoteWrite.current=null;
    setDraftOrder(updated);
    setDraftLoadedNo(updated.public_no);
    syncDraftUrl(updated.public_no,step);
    return updated;
  }

  async function runWizard<T>(message:string,action:()=>Promise<T>) {
    if(inFlight.current) return;
    inFlight.current=true;
    setWizardError("");
    setSavedNotice("");
    setBusyMessage(message);
    try { return await action(); }
    catch(error) {
      setWizardError(error instanceof Error&&error.name==="TimeoutError"?"The quote request timed out. Retry to continue.":
        error instanceof TypeError?"Connection interrupted. Check your connection and try again.":
        error instanceof Error?error.message:"Try again or contact Support.");
    }
    finally {inFlight.current=false;setBusyMessage("");}
  }

  function saveDraftOnly() {
    return runWizard("Saving draft…",async()=>{
      if(!currentLine) throw new Error("Choose an available service and quantity.");
      const record=await persistDraft();
      setSavedNotice(`Draft ${record.public_no} saved.`);
    });
  }

  function syncDraftAndQuote() {
    return runWizard("Calculating quote…",async()=>{
      setServerQuote(undefined);
      setConsents({});
      setPolicyAccepted(false);
      if(!currentLine||!itemName.trim()) throw new Error("Review the service, quantity and product name before requesting a quote.");
      const order=await persistDraft();
      if(!quoteWrite.current||quoteWrite.current.revision!==order.revision) quoteWrite.current={revision:order.revision,key:crypto.randomUUID()};
      const quote=await request("/orders/"+order.id+"/quotes","POST",{revision:order.revision},
        quoteWrite.current.key,AbortSignal.timeout(quoteTimeoutMs));
      if(!quote.id||quote.order_id!==order.id||!Number.isFinite(quote.amount_cents)||quote.currency!=="USD"||
        !Number.isFinite(Date.parse(quote.expires_at))||Date.parse(quote.expires_at)<=Date.now()||!quote.line_snapshot?.length) {
        quoteWrite.current=null;
        throw new Error("The server did not return a current quote. Retry to request a new one.");
      }
      quoteWrite.current=null;
      submitKey.current=crypto.randomUUID();
      setQuotedFingerprint(fingerprint);
      setServerQuote(quote);
      syncDraftUrl(order.public_no,4);
      return quote;
    });
  }

  function submitManualBatchQuoteRequest() {
    return runWizard("Submitting quote request…",async()=>{
      if(!Number.isInteger(manualBatchQty)||manualBatchQty<=maxOnlineQty||manualBatchQty>maximumDraftItems||
        !itemName.trim()||serviceKind!=="inspection"||!configuredOffer) {
        throw new Error("Enter the product name and a quantity above the online limit, up to 300 items.");
      }
      const line=buildCurrentLine(manualBatchQty);
      if(!line) throw new Error("Select an available inspection service.");
      const lines=[...extraLines,line].map(({title,...payloadLine})=>payloadLine);
      const order=await persistDraft({lines,customer_notes:notes.trim()});
      const reason=`${manualBatchQty} items · ${itemName.trim()}${manualQuoteReason.trim()?` · ${manualQuoteReason.trim()}`:""}`;
      const result=await request("/orders/"+order.id+"/manual-quote-request","POST",{revision:order.revision,reason});
      setManualQuoteSubmitted({orderNo:order.public_no,requestState:result.state,qty:manualBatchQty});
      syncDraftUrl(order.public_no,1);
    });
  }

  async function goToStep(targetStep:number) {
    if(inFlight.current||targetStep<0||targetStep>5||targetStep>step+1) return;
    setWizardError("");
    if(targetStep<step) {
      if(step>=2&&step<=3&&itemName.trim()&&currentLine&&fingerprint!==savedFingerprint.current) {
        await runWizard("Saving draft…",async()=>{
          const saved=await persistDraft();
          syncDraftUrl(saved.public_no,targetStep);
          setStep(targetStep);
        });
      } else {
        setStep(targetStep);
        if(draftOrder) syncDraftUrl(draftOrder.public_no,targetStep);
      }
      return;
    }
    if(targetStep===step) return;
    if(!categoryOffers.length||!serviceOffers.length) {
      setWizardError("Choose an available product category and service.");
      return;
    }
    if(targetStep>=2&&(!validQuantity||manualQuoteMode)) {
      setWizardError("Choose an available template and online quantity, or submit a manual quote request.");
      return;
    }
    if(targetStep>=2&&serviceKind==="reference_match"&&!activeRefs.some((ref:Row)=>ref.reference_id===referenceId)) {
      setWizardError("Select an active Golden Sample before continuing.");
      return;
    }
    if(targetStep>=3&&!itemName.trim()) {
      setWizardError("Enter a product name before continuing.");
      return;
    }
    if(targetStep===3||(targetStep===2&&draftOrder)) {
      await runWizard("Saving draft…",async()=>{
        const saved=await persistDraft();
        syncDraftUrl(saved.public_no,targetStep);
        setStep(targetStep);
      });
      return;
    }
    if(targetStep===4) {
      setStep(4);
      if(!hasValidQuote) await syncDraftAndQuote();
      return;
    }
    if(targetStep===5&&(!hasValidQuote||Date.parse(serverQuote!.expires_at)<=Date.now()||!allConsentsChecked)) {
      setWizardError("Review the current quote and accept the terms before continuing.");
      return;
    }
    setStep(targetStep);
  }

  function startPayment() {
    return runWizard("Opening checkout…",async()=>{
      if(!hasValidQuote||!draftOrder||!serverQuote||Date.parse(serverQuote.expires_at)<=Date.now()||!allConsentsChecked) {
        setStep(4);
        throw new Error("Review and confirm a current quote before paying.");
      }
      if(submittedCharge) {
        location.assign("/orders/"+draftOrder.public_no);
        return;
      }
      let accepted;
      try {
        accepted=await request("/orders/"+draftOrder.id+"/submit","POST",{
          revision:draftOrder.revision,
          quote_id:serverQuote.id,
          terms_version_ids:policyIds,
          acknowledgements:consents,
        },submitKey.current);
      } catch(error) {
        if(error instanceof RequestError&&["QUOTE_STALE","TERMS_CHANGED","VERSION_CONFLICT","TEMPLATE_CHANGED"].includes(error.code??"")) {
          setServerQuote(undefined);
          setStep(4);
          terms.reload();
        }
        throw error;
      }
      setSubmittedCharge(accepted.charge);
      if(accepted.order.state==="awaiting_payment") {
        try {
          await goCheckout(accepted.charge.charge_item_id,serverQuote.revision,"/orders/"+accepted.order.public_no);
          return;
        } catch(error) {
          throw new Error(`Order ${accepted.order.public_no} was submitted. Resume payment from your order. ${error instanceof Error?error.message:""}`);
        }
      }
      location.assign("/orders/"+accepted.order.public_no);
    });
  }

  const latestAutoSave=useRef<()=>void>(undefined);
  latestAutoSave.current=()=>{
    if(inFlight.current||busyMessage||manualQuoteMode||!currentLine||!itemName.trim()||
      fingerprint===savedFingerprint.current||hasValidQuote) return;
    try {checkDraftInputs(allLines);} catch {return;}
    void saveDraftOnly();
  };
  useEffect(()=>{
    if(step!==2&&step!==3) return;
    const timer=setTimeout(()=>latestAutoSave.current?.(),1000);
    return ()=>clearTimeout(timer);
  },[fingerprint,step]);

  const stepLabels=[
    "Select Inspection",
    "Configure Service",
    "Sample Details",
    "Inspection Scope",
    "Review & Terms",
    "Payment Preview",
  ];
  const serviceLabel=serviceKind==="inspection"?"Product Inspection":serviceKind==="compare"?"Sample Comparison":"Golden Sample Matching";
  const rowsPerPage=6;
  const lastItemPage=Math.max(0,Math.ceil(clampedQty/rowsPerPage)-1);
  const firstItemIndex=Math.min(itemPage,lastItemPage)*rowsPerPage;
  const visibleRowLimit=Math.min(rowsPerPage,clampedQty-firstItemIndex);
  const activeRefs=(refs.data?.items??[]).filter((r:Row)=>r.state==="active"&&new Date(r.expires_at)>new Date()
    &&(!r.category_id||r.category_id===activeCategoryId));
  const policies:Row[]=terms.data?.terms??[];
  const policyIds=wizardPolicyKinds.map(kind=>policies.find(policy=>policy.kind===kind)?.id).filter(Boolean);
  const allConsentsChecked=policyAccepted&&policyIds.length===wizardPolicyKinds.length&&Object.keys(acknowledged).every(k=>consents[k]);
  const customizedRowCount=itemRows.slice(0,clampedQty).filter((r,idx)=>{
    if(!r) return false;
    const defSku=`${baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
    return (r.sku&&r.sku!==defSku)||(r.size&&r.size!==baseSize)||(r.color&&r.color!==baseColor)||(r.supplier&&r.supplier!==supplierRef)||Boolean(r.tracking_no);
  }).length;

  return <>
    <div className="page-head">
      <div>
        <h1>Create an Inspection</h1>
        <p>Choose a service, describe your items and review the quote before paying.</p>
      </div>
      <div className="head-actions">
        {draftOrder&&<Link className="button sm" href={"/orders/"+draftOrder.public_no}>View order {draftOrder.public_no}</Link>}
        <Link className="button sm" href="/orders">All Orders</Link>
      </div>
    </div>

    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">Loading available inspection services…</p>}
    {data&&!offers.length&&<Empty>No inspection services are available for online booking. <Link href="/support">Contact support</Link>.</Empty>}
    {wizardError&&<ErrorBlock error={wizardError}/>}
    {savedNotice&&!wizardError&&<div className="notice ok" role="status">{savedNotice}</div>}
    {busyMessage&&<div className="notice" role="status">{busyMessage}</div>}

    <div className="wizard-shell">
      <div className="wizard-content" ref={stepPanel} aria-busy={Boolean(busyMessage)}>
        <div className="steps" role="navigation" aria-label="Inspection setup steps">
          {stepLabels.map((name,idx)=><button
            key={name}
            type="button"
            className={`step ${idx===step?"on":idx<step?"done":""}`}
            aria-current={idx===step?"step":undefined}
            aria-label={"Step "+(idx+1)+": "+name}
            disabled={Boolean(busyMessage)||idx>step||Boolean(submittedCharge)||Boolean(manualQuoteSubmitted)}
            onClick={()=>void goToStep(idx)}
          >
            <span className="n">{idx<step?"✓":idx+1}</span>
            <span>{name}</span>
          </button>)}
        </div>

        {step===0&&<Panel
          title="Step 1 · Select Inspection — Product Category & Service"
          subtitle="Choose an approved product category and the inspection workflow that matches your shipment."
          badge={<Tag tone="green">{selectedCategoryName} · Open</Tag>}
        >
          <div className="label" style={{marginBottom:8}}>1A · PRODUCT CATEGORY</div>
          <div className="wizard-categories" role="radiogroup" aria-label="Product Category">
            {wizardCategories.map(cat=>{
              const catId=resolveCategoryId(cat.key);
              const isAvailable=Boolean(catId);
              const isSelected=categoryKey===cat.key;
              return <button
                key={cat.key}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={!isAvailable}
                className={`option-card ${isSelected?"selected":""} ${!isAvailable?"disabled":""}`}
                onClick={()=>{
                  if(!isAvailable||isSelected) return;
                  setCategoryKey(cat.key);
                  const nextCatOffers=offers.filter(o=>o.category_id===catId);
                  const match=nextCatOffers.find(o=>o.service===serviceKind)??nextCatOffers[0];
                  if(match) chooseOffer(match);
                  setItemRows([]);
                  setManualQuoteMode(false);
                  setServerQuote(undefined);
                  setSavedNotice("");
                }}
              >
                <span className="icon" aria-hidden="true">{cat.icon}</span>
                <strong>{cat.name}</strong>
                <p>{isAvailable?"Available now":cat.fallbackState==="PLANNED"?"Planned · Not open":"Restricted"}</p>
              </button>;
            })}
          </div>
          <p className="small muted" style={{marginTop:8,marginBottom:18}}>
            Only categories with approved capabilities, published checklists, and active server pricing can be booked online. Planned and restricted categories are disabled.
          </p>

          <div className="sep"/>
          <div className="label" style={{marginBottom:8}}>1B · INSPECTION SERVICE</div>
          <div className="wizard-services" role="radiogroup" aria-label="Inspection Service">
            {wizardServiceCards.map(card=>{
              const matchingOffers=categoryOffers.filter(o=>o.service===card.service);
              const isServiceAvailable=matchingOffers.length>0;
              const unitPrices=matchingOffers.map(o=>o.rules.unit_cents).filter((x):x is number=>x!=null);
              const pkgPrices=matchingOffers.map(o=>o.rules.package_cents).filter((x):x is number=>x!=null);
              const priceText=unitPrices.length>0
                ?`${usd(Math.min(...unitPrices))} / item`
                :pkgPrices.length>1
                  ?`${usd(Math.min(...pkgPrices))}–${usd(Math.max(...pkgPrices))} / set`
                  :pkgPrices.length===1
                    ?`${usd(pkgPrices[0])} / set`
                    :"Available";
              const isSelected=serviceKind===card.service;
              return <button
                key={card.service}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={!isServiceAvailable}
                className={`option-card ${isSelected?"selected":""} ${!isServiceAvailable?"disabled":""}`}
                onClick={()=>{
                  if(!isServiceAvailable) return;
                  if(isSelected) return;
                  const match=offerFor(matchingOffers,templateVariant,qty)??matchingOffers.find(o=>templateVariantFor(o)===templateVariant)??matchingOffers[0];
                  if(match) chooseOffer(match);
                }}
              >
                <div className="row between" style={{width:"100%"}}>
                  <span className="icon" aria-hidden="true">{card.icon}</span>
                  <Tag tone={isSelected?"blue":"gray"}>{priceText}</Tag>
                </div>
                <strong>{card.title}</strong>
                <p>{card.desc}</p>
                <span className="price-pill">{card.unitLabel}</span>
              </button>;
            })}
          </div>
          <div className="wizard-note">
            Every inspection records physical measurements and high-resolution camera evidence at our China facility. Laboratory fiber testing, wash shrinkage, and factory AQL audits are outside scope.
          </div>
        </Panel>}

        {step===1&&<>
          <Panel
            title="Step 2 · Configure Service — Garment Template & Quantity"
            subtitle="Select the garment subcategory checklist and the number of physical items to inspect."
            badge={<Tag tone="green">{selectedCategoryName} · {serviceLabel}</Tag>}
          >
            <div className="fields">
              <div className="field">
                <label>Garment subcategory &amp; inspection template
                  <select
                    aria-label="Inspection template"
                    disabled={Boolean(busyMessage)||Boolean(manualQuoteSubmitted)}
                    value={effectiveVariant}
                    onChange={e=>selectTemplateVariant(e.target.value)}
                  >
                    {isApparelCategory?availableTemplates.map(opt=><option key={opt.variant} value={opt.variant}>{opt.label}</option>)
                    :<option value="basic">{configuredOffer?.title.en??selectedCategoryName}</option>}
                  </select>
                </label>
                <small className="muted">
                  {filteredChecks.filter(check=>check.required).length} required checks per item · {filteredShots.length} required photo angles
                </small>
              </div>

              {!manualQuoteMode && (
                <div className="field">
                  <label>{serviceKind==="compare"?"Samples to compare":serviceKind==="reference_match"?"Candidate items to match":"Number of items to inspect"}
                    <input
                      type="number"
                      min={minQty}
                      max={maxOnlineQty}
                      disabled={Boolean(busyMessage)||minQty===maxOnlineQty}
                      value={qty||""}
                      onChange={e=>{
                        setQty(Number(e.target.value));
                        setServerQuote(undefined);
                        setSavedNotice("");
                      }}
                    />
                  </label>
                  <small className="muted">
                    {serviceKind==="inspection"
                      ?`Online checkout supports ${minQty}–${maxOnlineQty} items${activeOffer?.rules.unit_cents!=null?` (${usd(activeOffer.rules.unit_cents)} / item)`:""}.`
                      :serviceKind==="compare"
                        ?templateOffers.filter(o=>o.rules.package_cents!=null).map(o=>`${o.rules.minimum===o.rules.maximum?o.rules.minimum:`${o.rules.minimum}–${o.rules.maximum}`}-sample set ${usd(o.rules.package_cents)}`).filter((v,i,a)=>a.indexOf(v)===i).join(" · ")||"Comparison pricing is shown in Step 5."
                        :`Each Golden Sample Matching order compares candidate items${activeOffer?.rules.unit_cents!=null?` (${usd(activeOffer.rules.unit_cents)} / item)`:""} against your sealed reference sample.`}
                  </small>
                </div>
              )}
            </div>

            {matchingPackages.length>1&&<label>Service package
              <select value={activeOffer?.offer_id??""} onChange={event=>{
                const match=matchingPackages.find(offer=>offer.offer_id===event.target.value);
                if(match) chooseOffer(match);
              }}>{matchingPackages.map(offer=><option key={offer.offer_id} value={offer.offer_id}>{offer.title.en}</option>)}</select>
            </label>}
            {serviceKind==="reference_match"&&<div className="field" style={{marginTop:12}}>
              <label>Active Golden Sample in warehouse vault
                <select value={referenceId} onChange={e=>{setReferenceId(e.target.value);setServerQuote(undefined);}}>
                  <option value="">— Select an active Golden Sample —</option>
                  {activeRefs.map((r:Row)=><option key={r.reference_id} value={r.reference_id}>
                    {(r.code??r.item_id)} · Sealed until {stamp(r.expires_at)}
                  </option>)}
                </select>
              </label>
              {activeRefs.length===0&&<div className="line-note warning" style={{marginTop:8}}>
                No active Golden Samples are currently sealed in your workspace. After completing a Product Inspection or Sample Comparison, you can convert any approved item into a Golden Sample from the <strong>Items</strong> page.
              </div>}
            </div>}

            <div className="actions" style={{marginTop:14}}>
              <span className="small muted">Quick quantity presets:</span>
              {(serviceKind==="compare"?[2,3]:[1,3,10,30,50,100]).filter(n=>offerFor(templateOffers,effectiveVariant,n)).map(n=><button
                key={n}
                type="button"
                className={`button sm ${!manualQuoteMode&&clampedQty===n?"primary":""}`}
                disabled={Boolean(manualQuoteSubmitted)}
                onClick={()=>{
                  setManualQuoteMode(false);
                  setQty(n);
                  if(serviceKind==="compare") {
                    const match=offerFor(serviceOffers,effectiveVariant,n);
                    if(match) setSelectedOfferId(match.offer_id);
                  }
                  setServerQuote(undefined);
                  setSavedNotice("");
                }}
              >{n} {n===1?"item":serviceKind==="compare"?"samples":"items"}</button>)}
              {serviceKind==="inspection"&&maxOnlineQty>0&&maxOnlineQty<maximumDraftItems&&<button
                type="button"
                className={`button sm ${manualQuoteMode?"primary":""}`}
                disabled={Boolean(manualQuoteSubmitted)}
                onClick={()=>{
                  setManualQuoteMode(v=>!v);
                  setManualBatchQty(value=>Math.max(maxOnlineQty+1,value));
                  setServerQuote(undefined);
                }}
              >Request a manual quote</button>}
            </div>

            {manualQuoteMode && serviceKind==="inspection" && (
              <div className="card flat" style={{marginTop:16,borderColor:"#98b4ee",background:"#f4f8ff"}}>
                <div className="row between flexwrap">
                  <div>
                    <div className="label">MANUAL QUOTE</div>
                    <h3 style={{margin:"4px 0"}}>Request Custom Capacity &amp; Turnaround Quote</h3>
                    <p className="small muted" style={{margin:0}}>
                      The team will review the quantity, scope and turnaround and notify you when a quote is ready.
                    </p>
                  </div>
                  <Tag tone="blue">{maxOnlineQty+1}–{maximumDraftItems} items</Tag>
                </div>
                <div className="fields" style={{marginTop:12}}>
                  <div className="field">
                    <label>Requested quantity
                      <input
                        type="number"
                        min={maxOnlineQty+1}
                        max={maximumDraftItems}
                        value={manualBatchQty}
                        onChange={e=>setManualBatchQty(Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <div className="field">
                    <label>Product style / description
                      <input
                        value={itemName}
                        onChange={e=>setItemName(e.target.value)}
                        placeholder="e.g. Autumn Fleece Hoodie Batch"
                      />
                    </label>
                  </div>
                  <div className="field">
                    <label>Supplier / expected arrival window
                      <input
                        value={manualQuoteReason}
                        onChange={e=>setManualQuoteReason(e.target.value)}
                        placeholder="e.g. 2 suppliers, arriving in 3 cartons next Tuesday"
                      />
                    </label>
                  </div>
                </div>
                <div className="actions" style={{marginTop:12}}>
                  <button
                    type="button"
                    className="button primary sm"
                    disabled={Boolean(busyMessage)||Boolean(manualQuoteSubmitted)}
                    onClick={()=>void submitManualBatchQuoteRequest()}
                  >
                    Submit Manual Quote Request ({manualBatchQty} items) →
                  </button>
                  <button
                    type="button"
                    className="button sm"
                    disabled={Boolean(manualQuoteSubmitted)}
                    onClick={()=>setManualQuoteMode(false)}
                  >
                    Return to online checkout
                  </button>
                </div>
                {manualQuoteSubmitted && (
                  <div className="notice ok" style={{marginTop:12}}>
                    <strong>Manual quote requested ({label(manualQuoteSubmitted.requestState)}):</strong> Draft order <span className="mono">{manualQuoteSubmitted.orderNo}</span> ({manualQuoteSubmitted.qty} items) is queued for operations pricing and turnaround review. You&apos;ll be notified when the quote is offered.{" "}
                    <Link href={`/orders/${manualQuoteSubmitted.orderNo}`}>
                      Track quote status in order →
                    </Link>
                  </div>
                )}
              </div>
            )}

            <div className="sep"/>
            <div className="row between flexwrap">
              <div>
                <div className="label">SELECTED TEMPLATE &amp; TURNAROUND SLA</div>
                <strong>{serviceLabel} · {templateLabel}</strong>
                {manualQuoteMode?<p className="small muted">The team will confirm turnaround with your quote.</p>:activeOffer&&
                  <p className="small muted">Catalog turnaround for this offer is {activeOffer.rules.business_days} business days after all items are received and identified.</p>}
              </div>
              {activeOffer&&<Tag tone="green">{usd(activeOffer.rules.unit_cents??activeOffer.rules.package_cents)} {activeOffer.rules.unit_cents!=null?"/ item":"/ set"}</Tag>}
            </div>
          </Panel>
          <div className="line-note warning">
            Final payable pricing is locked by the server-side price snapshot calculated in Step 5.
          </div>
        </>}

        {step===2&&<Panel
          title="Step 3 · Sample Details — Product & Item-Level Mapping"
          subtitle="Define product-level defaults once, then override individual item sizes, colors, suppliers, or domestic tracking numbers only where they differ."
          badge={<Tag tone="blue">{clampedQty} {clampedQty===1?"Physical Sample":"Physical Samples"}</Tag>}
        >
          <div className="row between flexwrap" style={{marginBottom:10}}>
            <div className="label">3A · PRODUCT-LEVEL DEFAULTS (AUTO-APPLIED TO ALL {clampedQty} ITEMS)</div>
          </div>

          <div className="fields">
            <div className="field">
              <label>Product name / style *
                <input
                  value={itemName}
                  maxLength={120}
                  onChange={e=>{setItemName(e.target.value);setServerQuote(undefined);}}
                  placeholder="e.g. Heavyweight Cotton Hoodie"
                  required
                />
              </label>
            </div>
            <div className="field">
              <label>Default supplier / shop name
                <input
                  value={supplierRef}
                  onChange={e=>{setSupplierRef(e.target.value);setServerQuote(undefined);}}
                  placeholder="e.g. Hangzhou Knitwear Factory"
                />
              </label>
            </div>
            <div className="field">
              <label>Base SKU prefix
                <input
                  value={baseSku}
                  maxLength={32}
                  onChange={e=>{setBaseSku(e.target.value);setServerQuote(undefined);}}
                  placeholder="SKU-101"
                />
              </label>
            </div>
            <div className="field">
              <label>Default color / variant
                <input
                  value={baseColor}
                  onChange={e=>{setBaseColor(e.target.value);setServerQuote(undefined);}}
                  placeholder="e.g. Charcoal Gray"
                />
              </label>
            </div>
            <div className="field">
              <label>{isApparelCategory?"Default size":"Default specification"}
                <input
                  value={baseSize}
                  onChange={e=>{setBaseSize(e.target.value);setServerQuote(undefined);}}
                  placeholder={isApparelCategory?"M":"Standard"}
                />
              </label>
            </div>
            <div className="field">
              <label>Default domestic waybill (optional)
                <input
                  value={baseTrackingNo}
                  onChange={e=>{setBaseTrackingNo(e.target.value);setServerQuote(undefined);}}
                  placeholder="e.g. SF1234567890 (can also add later)"
                />
              </label>
            </div>
          </div>

          <div className="fields" style={{marginTop:14}}>
            <div className="field">
              <label>Product listing or spec URL (optional)
                <input
                  type="url"
                  value={productLink}
                  onChange={e=>setProductLink(e.target.value)}
                  placeholder="https://item.taobao.com/... or tech pack link"
                />
              </label>
            </div>
            <div className="field">
              <label>Size chart or reference photo (optional)
                <span className="file-picker">
                  <span className="file-picker-btn">Choose file</span>
                  <span className="file-picker-name">{attachmentName||"No file chosen"}</span>
                  <input type="file" accept="image/*" onChange={async e=>{
                    const file=e.target.files?.[0];
                    if(!file) return;
                    try {
                      setBusyMessage("Uploading reference image…");
                      const uploadForm=new FormData();
                      uploadForm.set("photo",file);
                      const uploaded=await request("/me/media","POST",uploadForm);
                      setAttachmentId(uploaded.id);
                      setAttachmentName(file.name);
                      setServerQuote(undefined);
                    } catch(err) {
                      setWizardError(err instanceof Error?err.message:"Photo upload failed.");
                    } finally {
                      setBusyMessage("");
                    }
                  }}/>
                </span>
              </label>
              {attachmentName&&<small className="ok">Attached: {attachmentName}</small>}
            </div>
          </div>

          <div className="sep"/>

          <div className="row between flexwrap">
            <div>
              <h3 style={{margin:0}}>3B · Individual Sample Mapping ({clampedQty} physical {clampedQty===1?"unit":"units"})</h3>
              <p className="small muted" style={{margin:"4px 0 0"}}>
                Each row generates a unique warehouse Sample ID barcode upon check-in ({customizedRowCount>0?`${customizedRowCount} row(s) customized`:"all rows currently inherit product defaults above"}). Supports multiple suppliers and multiple domestic tracking numbers in a single order.
              </p>
            </div>
            <div className="actions" style={{margin:0}}>
              {(serviceKind==="compare"?[2,3]:[1,5,30]).filter(n=>offerFor(templateOffers,effectiveVariant,n)).map(n=><button
                key={n}
                type="button"
                className={`button sm ${clampedQty===n?"primary":""}`}
                onClick={()=>{
                  setQty(n);
                  if(serviceKind==="compare") {
                    const match=offerFor(serviceOffers,effectiveVariant,n);
                    if(match) setSelectedOfferId(match.offer_id);
                  }
                  setServerQuote(undefined);
                }}
              >{n} {n===1?"item":"items"}</button>)}
            </div>
          </div>

          <div className="table-wrap wizard-items" style={{marginTop:10}}>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="col-idx" style={{width:52,minWidth:52,whiteSpace:"nowrap",textAlign:"center"}}>#</th>
                  <th>Sample SKU / Label</th>
                  <th>{isApparelCategory?"Size":"Size / Spec"}</th>
                  <th>Color / Variant</th>
                  <th>Supplier / Shop</th>
                  <th>Domestic Waybill (optional)</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({length:visibleRowLimit},(_,rowIndex)=>{
                  const idx=firstItemIndex+rowIndex;
                  const row=itemRows[idx];
                  const defaultRowSku=`${baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
                  return <tr key={idx}>
                    <td className="mono col-idx" style={{width:52,minWidth:52,whiteSpace:"nowrap",textAlign:"center",wordBreak:"keep-all",overflowWrap:"normal"}}>
                      {String(idx+1).padStart(2,"0")}
                    </td>
                    <td data-label="Sample label">
                      <input
                        className="input"
                        style={{minWidth:118}}
                        aria-label={`Item ${idx+1} SKU`}
                        value={row?.sku??defaultRowSku}
                        onChange={e=>updateItemRow(idx,{sku:e.target.value})}
                      />
                    </td>
                    <td data-label="Size / specification">
                      <input
                        className="input"
                        style={{minWidth:72}}
                        aria-label={`Item ${idx+1} size`}
                        value={row?.size??baseSize}
                        onChange={e=>updateItemRow(idx,{size:e.target.value})}
                      />
                    </td>
                    <td data-label="Color / variant">
                      <input
                        className="input"
                        style={{minWidth:92}}
                        aria-label={`Item ${idx+1} color`}
                        value={row?.color??baseColor}
                        onChange={e=>updateItemRow(idx,{color:e.target.value})}
                      />
                    </td>
                    <td data-label="Supplier">
                      <input
                        className="input"
                        style={{minWidth:120}}
                        aria-label={`Item ${idx+1} supplier`}
                        placeholder={supplierRef||"Shop / seller"}
                        value={row?.supplier??supplierRef}
                        onChange={e=>updateItemRow(idx,{supplier:e.target.value})}
                      />
                    </td>
                    <td data-label="Domestic waybill">
                      <div className="row" style={{gap:4,flexWrap:"nowrap"}}>
                        <input
                          className="input"
                          style={{minWidth:128}}
                          aria-label={`Item ${idx+1} waybill`}
                          placeholder={baseTrackingNo||"e.g. SF1234567890"}
                          value={row?.tracking_no??baseTrackingNo}
                          onChange={e=>updateItemRow(idx,{tracking_no:e.target.value})}
                        />
                        {idx>0 && (
                          <button
                            type="button"
                            className="button sm"
                            title="Copy supplier & waybill from row above"
                            onClick={()=>{
                              const prev=itemRows[idx-1];
                              updateItemRow(idx,{supplier:prev?.supplier,tracking_no:prev?.tracking_no});
                            }}
                          >
                            ↓
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          {clampedQty>rowsPerPage&&<div className="actions" aria-label="Sample rows">
            <button type="button" className="button" disabled={firstItemIndex===0}
              onClick={()=>setItemPage(firstItemIndex/rowsPerPage-1)}>Previous items</button>
            <span className="small">Items {firstItemIndex+1}–{firstItemIndex+visibleRowLimit} of {clampedQty}</span>
            <button type="button" className="button" disabled={firstItemIndex/rowsPerPage===lastItemPage}
              onClick={()=>setItemPage(firstItemIndex/rowsPerPage+1)}>Next items</button>
          </div>}

          <div className="line-note" style={{marginTop:12}}>
            <strong>Parcel pre-advice vs. physical receipt:</strong> Entering a domestic waybill here helps our intake desk match your seller&apos;s parcel upon arrival, or you can register tracking numbers later after payment. A parcel is marked <em>Received at Warehouse</em> only after physical barcode scan at our facility.
          </div>

          {serviceKind==="compare"&&<label className="checkrow" style={{marginTop:12}}>
            <input type="checkbox" checked={sizeMismatchConfirmed} onChange={e=>setSizeMismatchConfirmed(e.target.checked)}/>
            <span>I understand comparing samples of different declared sizes affects side-by-side measurement difference interpretation.</span>
          </label>}

          <div className="sep"/>
          <div className="row between flexwrap">
            <span className="small muted">Inspecting multiple garment types in one order? Queue this service line and configure another.</span>
            <button type="button" className="button sm" onClick={()=>{
              const built=buildCurrentLine();
              if(!built) return;
              if(!itemName.trim()) {setWizardError("Enter a product name for this service line.");return;}
              setExtraLines(prev=>[...prev,built]);
              setItemName("");
              setItemRows([]);
              setSupplierRef("");
              setBaseSku("ITEM");
              setBaseSize("");
              setBaseColor("");
              setBaseTrackingNo("");
              setProductLink("");
              setAttachmentId(undefined);
              setAttachmentName(undefined);
              setSizeMismatchConfirmed(false);
              setPointTolerances({});
              setToleranceMode("record_only");
              setServerQuote(undefined);
              setStep(0);
            }}>+ Add service line to order ({allLines.length} configured)</button>
          </div>
          {extraLines.length>0&&<ul className="draft-lines">
            {extraLines.map((line,idx)=><li key={idx}>
              <div>
                <strong>{line.title}</strong>
                <small>{line.attributes.name} · {line.quantity} {line.quantity===1?"item":"items"}{line.attributes.size_label?` · Size ${line.attributes.size_label}`:""}</small>
              </div>
              <button type="button" className="button sm" onClick={()=>{setExtraLines(xs=>xs.filter((_,i)=>i!==idx));setServerQuote(undefined);}}>Remove</button>
            </li>)}
          </ul>}
        </Panel>}

        {step===3&&<Panel
          title="Step 4 · Inspection Scope — Checkpoints, Tolerances & Notes"
          subtitle="Review the mandatory checkpoints for your garment subcategory and optionally specify target measurements or special focus points."
          badge={<Tag tone="green">{templateLabel}</Tag>}
        >
          <div className="card flat" style={{marginBottom:16}}>
            <div className="row between flexwrap">
              <div>
                <div className="label">CHECKLIST</div>
                <strong style={{fontSize:14}}>{templateLabel} ({filteredChecks.filter(check=>check.required).length} required checkpoints · {filteredShots.length} Required Photo Angles)</strong>
              </div>
              <button type="button" className="button sm" onClick={()=>setShowFullChecklist(v=>!v)}>
                {showFullChecklist?"Hide Method Details":"View Full Checklist & Methods"}
              </button>
            </div>

            <div className="grid cols2" style={{marginTop:12}}>
              <div>
                <div className="label" style={{marginBottom:6}}>VISUAL &amp; WORKMANSHIP CHECKS ({visualChecks.length})</div>
                <ul className="small" style={{margin:0,paddingLeft:18}}>
                  {visualChecks.map((c:Row)=><li key={c.key} style={{marginBottom:6}}>
                    <strong>{c.label}</strong> <Tag tone="gray">{c.required?"Required":"Template option"}</Tag>
                    {showFullChecklist&&<div className="muted">{c.method} (Evidence: {c.evidence})</div>}
                  </li>)}
                </ul>
              </div>
              <div>
                <div className="label" style={{marginBottom:6}}>MEASUREMENTS ({measurementChecks.length})</div>
                <ul className="small" style={{margin:0,paddingLeft:18}}>
                  {measurementChecks.map((c:Row)=><li key={c.key} style={{marginBottom:6}}>
                    <strong>{c.label}</strong> ({c.unit}) <Tag tone="blue">{c.required?"Required":"Template option"}</Tag>
                    {showFullChecklist&&<div className="muted">{c.method}</div>}
                  </li>)}
                </ul>
              </div>
            </div>

            {filteredShots.length>0&&<div style={{marginTop:12,paddingTop:10,borderTop:"1px solid var(--line)"}}>
              <strong className="small">Required Camera Angles ({filteredShots.length}): </strong>
              <span className="small muted">{filteredShots.map((s:Row)=>s.name||s.code).join(" · ")}</span>
            </div>}
          </div>

          <div className="card flat" style={{marginBottom:16}}>
            <div className="row between flexwrap">
              <div>
                <div className="label">4B · OPTIONAL MEASUREMENT TARGETS &amp; TOLERANCES</div>
                <strong>How should inspectors grade dimensional measurements?</strong>
              </div>
              <Tag tone={toleranceMode==="custom"?"blue":"gray"}>
                {toleranceMode==="custom"?"Custom targets & tolerances":"Record Actual Measurements Only"}
              </Tag>
            </div>
            <div className="actions" style={{marginTop:10}}>
              <button
                type="button"
                className={`button sm ${toleranceMode==="record_only"?"primary":""}`}
                onClick={()=>{setToleranceMode("record_only");setServerQuote(undefined);}}
              >
                Record measured values
              </button>
              <button
                type="button"
                className={`button sm ${toleranceMode==="custom"?"primary":""}`}
                onClick={()=>{setToleranceMode("custom");setServerQuote(undefined);}}
              >
                Set targets and tolerances
              </button>
            </div>
            {toleranceMode==="record_only"?(
              <p className="small muted" style={{margin:"8px 0 0"}}>
                The report shows the recorded measurements. Measurements without a supplied tolerance are not graded against a range.
              </p>
            ):(
              <div className="table-wrap" style={{marginTop:10}}>
                <p className="small">Targets apply to every item on this service line. Use separate service lines if sizes need different targets.</p>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Measurement Checkpoint</th>
                      <th>Unit</th>
                      <th>Target value</th>
                      <th>Allowed ± tolerance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {measurementChecks.map((chk:Row)=>{
                      const code=String(chk.key);
                      const cur=pointTolerances[code]??{target:"",plusMinus:""};
                      return <tr key={code}>
                        <td><strong>{chk.label}</strong><div className="small muted">{chk.method}</div></td>
                        <td className="mono">{chk.unit??"cm"}</td>
                        <td>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            className="input"
                            placeholder="e.g. 56.0"
                            aria-label={`${chk.label} target`}
                            value={cur.target}
                            onChange={e=>{
                              const val=e.target.value;
                              setPointTolerances(prev=>({...prev,[code]:{...cur,target:val}}));
                              setServerQuote(undefined);
                            }}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            step="0.1"
                            min="0.1"
                            max="20"
                            className="input"
                            placeholder="Enter tolerance"
                            aria-label={`${chk.label} tolerance`}
                            value={cur.plusMinus}
                            onChange={e=>{
                              const val=e.target.value;
                              setPointTolerances(prev=>({...prev,[code]:{...cur,plusMinus:val}}));
                              setServerQuote(undefined);
                            }}
                          />
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="field" style={{marginTop:14}}>
            <label>4C · Special focus points &amp; inspector notes (optional)
              <textarea
                value={notes}
                maxLength={500}
                onChange={e=>{setNotes(e.target.value);setServerQuote(undefined);}}
                placeholder="Highlight any specific seams, logo embroidery placement, care label language, or hardware details for extra close-up photos…"
              />
            </label>
          </div>

          <div className="sep"/>
          <div className="line-note">
            Scope boundary: Covers non-destructive visual inspection and flat metric tape measurements on physical samples received at our warehouse. Laboratory fiber composition testing, colorfastness/shrinkage washing, and factory AQL audits are excluded.
          </div>
        </Panel>}

        {step===4&&<Panel
          title="Step 5 · Review & Terms — Official Server Quote & Policies"
          subtitle="Verify your order configuration, confirm the authoritative server-calculated quote, and accept the required service disclosures."
          badge={hasValidQuote?<Tag tone="green">Official quote</Tag>:busyMessage?<Tag tone="yellow">Calculating…</Tag>:<Tag tone="red">Quote Required</Tag>}
        >
          <div className="grid cols2">
            <dl className="def"><dt>Product category</dt><dd>{selectedCategoryName}</dd></dl>
            <dl className="def"><dt>Inspection service</dt><dd>{serviceLabel}</dd></dl>
            <dl className="def"><dt>Garment template</dt><dd>{templateLabel}</dd></dl>
            <dl className="def"><dt>Physical quantity</dt><dd>{totalItems} {totalItems===1?"item":"items"} ({filteredChecks.length} checks / item)</dd></dl>
          </div>

          <div className="sep"/>
          {hasValidQuote?<div className="card flat">
            <div className="row between flexwrap">
              <strong>Official quote · {draftOrder?.public_no}</strong>
              <strong>{usd(serverQuote!.amount_cents)} {serverQuote!.currency}</strong>
            </div>
            <p className="small muted">Valid until {stamp(serverQuote!.expires_at)}</p>
            <ul className="draft-lines">
              {serverQuote!.line_snapshot.map((line:Row)=><li key={line.order_line_id}>
                <span>{offers.find(offer=>offer.offer_id===line.offer_id)?.title.en??"Inspection service"} × {line.quantity}<br/>
                  <small>{line.business_days} business days after receipt and identification</small></span>
                <strong>{usd(line.amount_cents)}</strong>
              </li>)}
            </ul>
          </div>:<div className="card flat">
            <p role="status">{isQuoteExpired?"The quote expired. Request a new quote to continue.":busyMessage?"Calculating your quote…":"A current quote is required before payment."}</p>
            <button type="button" className="button primary" disabled={Boolean(busyMessage)}
              onClick={()=>void syncDraftAndQuote()}>{wizardError||isQuoteExpired?"Retry quote":"Get quote"}</button>
          </div>}

          <div className="sep"/>
          <div style={{marginBottom:12}}>
            <div className="label" style={{marginBottom:6}}>APPLICABLE PLATFORM POLICIES &amp; SERVICE BOUNDARIES</div>
            <div className="actions" style={{margin:0}}>
              <Link className="button sm" href="/legal/terms" target="_blank" rel="noreferrer">Terms of Service ↗</Link>
              <Link className="button sm" href="/legal/privacy" target="_blank" rel="noreferrer">Privacy Policy ↗</Link>
              <Link className="button sm" href="/legal/restricted-items" target="_blank" rel="noreferrer">Restricted Items ↗</Link>
              <Link className="button sm" href="/legal/report-notice" target="_blank" rel="noreferrer">Report Limitations ↗</Link>
            </div>
          </div>

          <div className="checklist">
            {policies.some(policy=>String(policy.version).startsWith("demo"))&&<p className="small">These policies are for the test environment.</p>}
            {terms.error&&<><ErrorBlock error={terms.error}/><button type="button" className="button" onClick={terms.reload}>Retry loading policies</button></>}
            <label className="checkrow">
              <input type="checkbox" checked={policyAccepted} disabled={!hasValidQuote||policyIds.length!==wizardPolicyKinds.length}
                onChange={event=>setPolicyAccepted(event.target.checked)}/>
              <span>I accept the applicable policies linked above.</span>
            </label>
            {Object.entries(acknowledged).map(([k,textLabel])=><label key={k} className="checkrow">
              <input
                type="checkbox"
                checked={Boolean(consents[k])}
                onChange={e=>setConsents(prev=>({...prev,[k]:e.target.checked}))}
              />
              <span>{textLabel}</span>
            </label>)}
          </div>

          <div className="line-note warning" style={{marginTop:14}}>
            Once submitted, your order locks the approved template version and price snapshot above. You cannot advance to payment until an active server quote is confirmed and all disclosures are accepted.
          </div>
        </Panel>}

        {step===5&&<Panel
          title="Step 6 · Payment Preview — Confirm Payment & Receiving Address"
          subtitle="Complete payment to activate your inspection order and unlock warehouse parcel receiving."
          badge={<Tag tone="blue">{draftOrder?.public_no??"Ready"}</Tag>}
        >
          {!hasValidQuote || !draftOrder ? (
            <div className="card flat" style={{borderColor:"#f3c68f",background:"#fffaf2"}}>
              <strong>Official quote verification required</strong>
              <p className="small muted" style={{margin:"6px 0 12px"}}>
                Your quote is missing or expired. Please return to Step 5 to calculate a fresh server quote before submitting payment.
              </p>
              <button type="button" className="button primary sm" onClick={()=>setStep(4)}>← Return to Step 5 (Review &amp; Terms)</button>
            </div>
          ) : (
            <>
              <div className="grid cols2">
                <dl className="def"><dt>Order number</dt><dd className="mono">{draftOrder.public_no}</dd></dl>
                <dl className="def"><dt>Confirmed service fee</dt><dd className="mono">{usd(serverQuote!.amount_cents)} {serverQuote!.currency}</dd></dl>
                <dl className="def"><dt>Service &amp; template</dt><dd>{serviceLabel} · {templateLabel} ({totalItems} {totalItems===1?"item":"items"})</dd></dl>
                <dl className="def"><dt>Permanent receiving code</dt><dd><span className="mono">{receiving.data?.receiving_code??"Assigned in account"}</span></dd></dl>
              </div>

              <div className="sep"/>
              <div className="card flat" style={{marginBottom:14}}>
                <div className="label">WHAT HAPPENS IMMEDIATELY AFTER PAYMENT</div>
                <ol className="small" style={{margin:"8px 0 0",paddingLeft:18,lineHeight:1.6}}>
                  <li>After payment is confirmed, your order will show <strong>Awaiting items</strong>.</li>
                  <li><strong>Ship samples to our China warehouse:</strong> Provide your permanent receiving code (<span className="mono">{receiving.data?.receiving_code??"QCW-..."}</span>) and our warehouse address to your supplier.</li>
                  <li>Add each seller’s tracking number in <strong>Parcels</strong>.</li>
                </ol>
              </div>

              <div className="actions">
                <button type="button" className="button primary" disabled={Boolean(busyMessage)} onClick={startPayment}>
                  {busyMessage?"Opening checkout…":submittedCharge?"Open order to resume payment":"Confirm quote and pay "+usd(serverQuote!.amount_cents)}
                </button>
              </div>
            </>
          )}
        </Panel>}

        <div className="wizard-controls">
          <button
            type="button"
            className="button"
            disabled={step===0||Boolean(busyMessage)||Boolean(submittedCharge)||Boolean(manualQuoteSubmitted)}
            onClick={()=>void goToStep(step-1)}
          >← Previous</button>
          {step<5?(
            <button
              type="button"
              className="button primary"
              disabled={
                Boolean(busyMessage) ||
                !serviceOffers.length ||
                (step===1 && (manualQuoteMode||!validQuantity)) ||
                (step===4 && (!allConsentsChecked || !hasValidQuote))
              }
              onClick={()=>void goToStep(step+1)}
            >{step===3?"Save & Review Official Quote →":step===4?"Continue to Payment Preview →":"Continue →"}</button>
          ):(
            <Link className="button sm" href={draftOrder?"/orders/"+draftOrder.public_no:"/orders"}>View Order Detail</Link>
          )}
        </div>
      </div>

      <aside className="wizard-side">
        <section className="card">
          <button className="wizard-summary-toggle button" type="button" aria-expanded={summaryOpen} aria-controls="wizard-summary"
            onClick={()=>setSummaryOpen(open=>!open)}>Order Summary <span aria-hidden="true">{summaryOpen?"−":"+"}</span></button>
          <div id="wizard-summary" className={summaryOpen?"wizard-summary-body open":"wizard-summary-body"}>
          <div className="card-head">
            <div>
              <h3>Order Summary</h3>
              <p>Live configuration &amp; pricing status.</p>
            </div>
            <Tag tone={hasValidQuote?"green":"yellow"}>{draftOrder?draftOrder.public_no:"DRAFT"}</Tag>
          </div>
          <div className="sep"/>
          <div className="mini-kv">
            <div><div className="k">Category</div><div className="v">{selectedCategoryName}</div></div>
            <div><div className="k">Service</div><div className="v">{serviceLabel}</div></div>
            <div><div className="k">Template</div><div className="v">{isApparelCategory?templateLabel.split(" (")[0]:"Standard"}</div></div>
            <div><div className="k">Quantity</div><div className="v">{manualQuoteMode?`${manualBatchQty} (Manual)`:`${totalItems} ${totalItems===1?"item":"items"}`}</div></div>
          </div>
          <div className="sep"/>
          <div className="display-quote">
            <div className="label">{hasValidQuote?"OFFICIAL QUOTE":step>=4?"QUOTE STATUS":"CATALOG ESTIMATE"}</div>
            <div className="big">{manualQuoteMode?"Manual quote":step>=4&&!hasValidQuote?"Awaiting quote":displayCents!=null?usd(displayCents):"Unavailable"}</div>
            <div className="small muted">
              {hasValidQuote && serverQuote?.expires_at
                ?`Official quote valid until ${stamp(serverQuote.expires_at)}.`
                :step<4?"Get your quote in Step 5.":""}
            </div>
            <div className="small muted" style={{marginTop:4}}>
              Excludes outbound shipping, storage beyond the free storage window, and seller return freight.
            </div>
          </div>
          <div className="sep"/>
          <div className="row between" style={{gap:8}}>
            <button
              type="button"
              className="button sm"
              disabled={Boolean(busyMessage)||manualQuoteMode||!validQuantity||Boolean(submittedCharge)}
              onClick={()=>{saveDraftOnly().catch(()=>{});}}
            >
              {draftOrder?"Update Saved Draft":"Save Draft"}
            </button>
            <button
              type="button"
              className="button sm"
              disabled={Boolean(busyMessage)}
              onClick={()=>{
                if(window.confirm("Start a new inspection? Any saved draft will remain in Orders.")) location.assign("/orders/new");
              }}
            >Reset Draft</button>
          </div>
          </div>
        </section>

      </aside>
    </div>
  </>;
}
type CustomerTrackingTarget={kind:"parcels"|"shipments";id:string;code?:string};

function CustomerTrackingDrawer({target,onClose}:{target:CustomerTrackingTarget|null;onClose:()=>void}) {
  if(!target) return null;
  const fullHref=`/${target.kind}/${target.id}`;
  return <ModalDrawer
    open={Boolean(target)}
    onClose={onClose}
    title={`Tracking Details${target.code?` · ${target.code}`:""}`}
    subtitle={target.kind==="parcels"?"Inbound seller delivery & warehouse check-in status":"Outbound carrier handover & delivery tracking"}
    footer={<div className="actions"><Link className="button sm" href={fullHref} onClick={onClose}>Open full tracking page →</Link></div>}
  >
    <TrackView kind={target.kind} id={target.id} embedded/>
  </ModalDrawer>;
}

function CustomerItemDrawer({
  item,onClose,onOpenTracking,onOpenBatch,
}:{
  item:Row|null;onClose:()=>void;onOpenTracking?:(t:CustomerTrackingTarget)=>void;onOpenBatch?:(batchId:string)=>void;
}) {
  if(!item) return null;
  const disp=item.active_disposition??item.instruction;
  const declared=item.declared_fields&&typeof item.declared_fields==="object"?Object.entries(item.declared_fields as Record<string,unknown>).filter(([,v])=>v!=null&&v!==""):[];
  return <ModalDrawer
    open={Boolean(item)}
    onClose={onClose}
    title={`Warehouse Item · ${item.code??"Pending"}`}
    subtitle="Custody status, linked parcels, storage window and active handling instructions"
    footer={<div className="actions">
      <Link className="button sm" href="/items" onClick={onClose}>Open Warehouse Items →</Link>
      {item.order_no&&<Link className="button sm" href={`/orders/${item.order_no}/dispositions`} onClick={onClose}>Order item instructions →</Link>}
    </div>}
  >
    <div className="panel" style={{margin:0}}>
      <div className="row">
        <div><strong className="code">{item.code??"Awaiting assignment"}</strong></div>
        <div className="actions">
          {item.custody_state&&<Tag>{label(item.custody_state)}</Tag>}
          {item.identity_state&&<Tag tone={item.identity_state==="quarantined"?"red":"outline"}>{label(item.identity_state)}</Tag>}
        </div>
      </div>
      <div className="grid cols2" style={{marginTop:12}}>
        <dl className="def"><dt>Warehouse package</dt><dd className="mono">{item.package_code??"—"}</dd></dl>
        <dl className="def"><dt>Inbound tracking</dt><dd>
          {item.inbound_advice_id&&item.inbound_tracking_norm&&onOpenTracking
            ?<CodeButton code={item.inbound_tracking_norm} onClick={()=>{onClose();onOpenTracking({kind:"parcels",id:item.inbound_advice_id,code:item.inbound_tracking_norm});}}/>
            :(item.inbound_tracking_norm?<span className="code">{item.inbound_tracking_norm}</span>:"—")}
        </dd></dl>
        <dl className="def"><dt>Inspection order</dt><dd>{item.order_no?<Link className="code-btn" href={`/orders/${item.order_no}`} onClick={onClose}>{item.order_no}</Link>:"Uncommissioned"}</dd></dl>
        <dl className="def"><dt>Reference sample</dt><dd>{item.reference_sample?`${item.reference_sample.state==="active"?(item.reference_sample.expired?"Expired":"Active"):label(item.reference_sample.state)}${item.reference_sample.in_use?" · In comparison":""}`:"—"}</dd></dl>
        <dl className="def"><dt>Free storage through</dt><dd>{stamp(item.storage_until)}</dd></dl>
        <dl className="def"><dt>Paid storage through</dt><dd>{stamp(item.paid_storage_until)}</dd></dl>
        <dl className="def"><dt>Active instruction</dt><dd>{disp?`${label(disp.action)} (${label(disp.state)})`:"None"}</dd></dl>
        <dl className="def"><dt>Dispatch / Outbound</dt><dd className="actions">
          {item.active_batch_id&&onOpenBatch&&<CodeButton code={`Batch #${String(item.active_batch_id).slice(0,8)}`} onClick={()=>{onClose();onOpenBatch(item.active_batch_id);}}/>}
          {item.outbound_shipment?.id&&onOpenTracking&&<CodeButton code={item.outbound_shipment.tracking_norm} onClick={()=>{onClose();onOpenTracking({kind:"shipments",id:item.outbound_shipment.id,code:item.outbound_shipment.tracking_norm});}}/>}
          {!item.active_batch_id&&!item.outbound_shipment?.id&&"—"}
        </dd></dl>
      </div>
      {Array.isArray(item.components)&&item.components.length>0&&<p className="small muted" style={{marginTop:10}}>
        <strong>Sub-components:</strong> {item.components.map((c:Row)=>`${c.code}${c.label?` (${c.label})`:""}`).join(", ")}
      </p>}
      {declared.length>0&&<div style={{marginTop:10}}>
        <small className="muted">Declared attributes</small>
        <div className="actions" style={{marginTop:4}}>
          {declared.map(([k,v])=><Tag key={k} tone="outline">{k}: {typeof v==="object"?JSON.stringify(v):String(v)}</Tag>)}
        </div>
      </div>}
    </div>
  </ModalDrawer>;
}

function CustomerBatchDrawer({
  batchId,onClose,onOpenTracking,onSaved,
}:{
  batchId:string|null;onClose:()=>void;onOpenTracking?:(t:CustomerTrackingTarget)=>void;onSaved?:()=>void;
}) {
  const view=useLoad(batchId?`/dispatch-batches/${batchId}`:null);
  const [removeIds,setRemoveIds]=useState<string[]>([]);
  const [amendNotice,setAmendNotice]=useState<string>();
  useEffect(()=>{setRemoveIds([]);setAmendNotice(undefined);},[batchId]);
  if(!batchId) return null;
  const d=view.data;
  const activeItems:Row[]=(d?.items??[]).filter((i:Row)=>!i.released_at);
  const unshippedItems=activeItems.filter((i:Row)=>!i.shipped);
  const hasShipped=activeItems.some((i:Row)=>Boolean(i.shipped));
  const canAmend=Boolean(d&&["draft","confirmed","quoted","paid"].includes(d.state)&&unshippedItems.length>0);
  const dest=d?.destination_snapshot??{};
  return <ModalDrawer
    open={Boolean(batchId)}
    onClose={onClose}
    title={`Dispatch Batch · #${batchId.slice(0,8)}`}
    subtitle="Inspect batch items, shipping quotes, carrier handovers, or amend unshipped details"
    footer={<div className="actions">
      <Link className="button sm" href="/account/billing" onClick={onClose}>Open Billing &amp; Quotes →</Link>
      <Link className="button sm" href="/items" onClick={onClose}>Open Warehouse Items →</Link>
    </div>}
  >
    {view.error&&<ErrorBlock error={view.error}/>}
    {!d&&!view.error&&<Empty>Loading dispatch batch details…</Empty>}
    {d&&<>
      <div className="panel" style={{margin:0}}>
        <div className="row">
          <div><strong>{label(d.action)}</strong> <span className="code">#{d.id.slice(0,8)}</span></div>
          <Tag>{label(d.state)}</Tag>
        </div>
        <p className="small muted" style={{marginTop:8}}>
          <strong>Destination:</strong> {dest.recipient??"—"} · {dest.phone??"—"} · {dest.address??"—"}{dest.member_code?` · Member ${dest.member_code}`:""}
        </p>
        {d.state==="draft"&&<Action primary run={async()=>{
          await request(`/dispatch-batches/${d.id}/confirm`,"POST",{revision:d.revision});
          view.reload();onSaved?.();
        }}>Confirm batch for warehouse quoting</Action>}
      </div>
      <div className="panel" style={{margin:0}}>
        <h3>Items in this batch</h3>
        <Table headers={["Item","Order","Status"]} rows={(d.items??[]).map((i:Row)=>[
          <span className="code">{i.code}</span>,
          i.order_no?<Link className="code-btn" href={`/orders/${i.order_no}`} onClick={onClose}>{i.order_no}</Link>:"Uncommissioned",
          i.released_at?<Tag tone="outline">Removed</Tag>:i.shipped?<Tag tone="green">Handed over</Tag>:<Tag tone="blue">{label(i.custody_state)}</Tag>,
        ])} empty="No items in this batch."/>
      </div>
      {(d.quotes??[]).length>0&&<div className="panel" style={{margin:0}}>
        <h3>Shipping quotes</h3>
        <Table headers={["Version","Amount","Expires","Status"]} rows={(d.quotes??[]).map((q:Row)=>[
          `v${q.revision}`,usd(q.amount_cents),stamp(q.expires_at),
          q.applied_payment_id?<Tag tone="green">Paid</Tag>:q.voided_at?<Tag tone="outline">Superseded</Tag>:q.accepted_at?<Tag tone="blue">Accepted</Tag>:<Tag>Open</Tag>,
        ])}/>
      </div>}
      {(d.shipments??[]).length>0&&<div className="panel" style={{margin:0}}>
        <h3>Outbound parcels</h3>
        <Table headers={["Tracking","Carrier","Weight","Handed over"]} rows={(d.shipments??[]).map((s:Row)=>[
          s.shipped_at&&s.tracking_norm&&onOpenTracking
            ?<CodeButton code={s.tracking_norm} onClick={()=>{onClose();onOpenTracking({kind:"shipments",id:s.id,code:s.tracking_norm});}}/>
            :<span className="code">{s.tracking_norm??"Packing"}</span>,
          s.carrier_code??"—",
          s.weight_g?`${s.weight_g} g`:"—",
          stamp(s.shipped_at),
        ])}/>
      </div>}
      {canAmend&&<details className="card">
        <summary>Amend destination or remove unshipped items before carrier handover</summary>
        <p className="small muted">Changes expire unaccepted quotes so the warehouse can re-weigh and re-quote. If already paid, a finance reconciliation case is opened automatically.</p>
        <Form label="Save batch amendment" run={async f=>{
          const nextDest=!hasShipped?{
            recipient:text(f,"recipient"),
            phone:text(f,"phone"),
            address:text(f,"address"),
            ...(d.action==="to_forwarder"?{member_code:text(f,"member_code")}:{}),
          }:undefined;
          const res=await request(`/dispatch-batches/${d.id}/amend`,"POST",{
            revision:d.revision,
            ...(nextDest?{destination:nextDest}:{}),
            ...(removeIds.length?{remove_item_ids:removeIds}:{}),
            reason:text(f,"reason")||"Customer updated dispatch batch before shipment",
          });
          setRemoveIds([]);
          setAmendNotice(res.refund_ticket_no?`Batch updated. Reconciliation case ${res.refund_ticket_no} opened.`:`Batch updated (${label(res.state)}).`);
          view.reload();onSaved?.();
        }}>
          {!hasShipped&&<>
            <Field name="recipient" label="Recipient" value={dest.recipient??""}/>
            <Field name="phone" label="Destination phone" value={dest.phone??""}/>
            <label>Shipping address<textarea name="address" defaultValue={dest.address??""} required/></label>
            {d.action==="to_forwarder"&&<Field name="member_code" label="Forwarder member code" value={dest.member_code??""}/>}
          </>}
          {unshippedItems.length>0&&<div>
            <small className="muted">Optional: select unshipped items to remove from this batch</small>
            <div className="role-grid" style={{marginTop:6}}>
              {unshippedItems.map((i:Row)=><label key={i.item_id} className={"role-chip"+(removeIds.includes(i.item_id)?" on":"")}>
                <input type="checkbox" checked={removeIds.includes(i.item_id)} onChange={e=>setRemoveIds(xs=>e.target.checked?[...xs,i.item_id]:xs.filter(x=>x!==i.item_id))}/>
                <span><strong className="code">{i.code}</strong> <small>Remove from batch</small></span>
              </label>)}
            </div>
          </div>}
          <Field name="reason" label="Reason for change" value="Updated shipping details before dispatch"/>
        </Form>
        {amendNotice&&<p className="notice" role="status">{amendNotice}</p>}
      </details>}
    </>}
  </ModalDrawer>;
}

export function OrderView({number,section}:{number:string;section?:OrderSection}) {
  const returnedFromCheckout=useSearchParams().get("checkout")==="returned";
  const lookup=useLoad("/orders/by-number/"+number);
  const id=lookup.data?.id;
  const detail=useLoad(id?"/orders/"+id:null),terms=useLoad("/public/terms");
  const payment=useLoad(id&&(!section||section==="payment")?"/orders/"+id+"/payment":null);
  const receiving=useLoad(section==="parcels"?"/me/receiving-address":null);
  const carriers=useLoad(section==="parcels"?"/carriers":null);
  const desk=useLoad(section==="parcels"?"/me/desk":null);
  const base="/orders/"+number;
  const sectionLinks:[string,string][]=[[base,"Overview"],...Object.entries(orderSections).map(([key,title]):[string,string]=>[base+"/"+key,title])];
  const [calculatedQuote,setQuote]=useState<Row>();
  const [checkoutNotice,setCheckoutNotice]=useState<{text:string;error?:boolean;expired?:boolean}>();
  const [openedCase,setOpenedCase]=useState<string>();
  const [trackTarget,setTrackTarget]=useState<CustomerTrackingTarget|null>(null);
  const [itemTarget,setItemTarget]=useState<Row|null>(null);
  const [batchTarget,setBatchTarget]=useState<string|null>(null);
  const o=detail.data;
  const quote=o?.manual_quote?.id?o.manual_quote:calculatedQuote;
  const paymentState=payment.data?.state;
  const refreshPayment=()=>{detail.reload();payment.reload();};
  useEffect(()=>{
    if(paymentState!=="processing"&&!((returnedFromCheckout||checkoutNotice&&!checkoutNotice.error)&&o?.state==="awaiting_payment"))return;
    const timer=setInterval(()=>{detail.reload();payment.reload();},15000);
    return ()=>clearInterval(timer);
  },[paymentState,returnedFromCheckout,checkoutNotice,o?.state,detail.reload,payment.reload]);
  async function continuePayment(chargeId:string,quoteRevision:number) {
    setCheckoutNotice(undefined);
    try {
      const result=await request("/charges/"+chargeId+"/checkout","POST",{quote_revision:quoteRevision});
      if(result.checkout_url) location.assign(result.checkout_url);
      else if(result.state==="processing") setCheckoutNotice({text:"Payment is processing. Refresh this order for the confirmed status."});
    } catch(error) {
      setCheckoutNotice({text:error instanceof Error?error.message:"Checkout could not start.",error:true,
        expired:error instanceof RequestError&&error.code==="QUOTE_EXPIRED"});
    } finally {
      refreshPayment();
    }
  }
  const unlinkedAdvices:Row[]=(desk.data?.advices??[]).filter((a:Row)=>!(a.order_numbers??[]).includes(number));
  return <><div className="page-head row"><div><Link href="/orders">← Inspection orders</Link><h1 className="order-number">{number}</h1></div>
    <div className="actions">
      {o?.state==="draft"&&<Link className="button sm" href={"/orders/new?draft="+encodeURIComponent(number)}>Continue in wizard →</Link>}
      {o&&<Tag>{label(o.state)}</Tag>}
    </div>
  </div>
    {(lookup.error||detail.error)&&<ErrorBlock error={lookup.error||detail.error}/>}
    {!o&&!lookup.error&&!detail.error&&<p role="status">Loading inspection order…</p>}
    {o&&<>
      <Tabs path={section?base+"/"+section:base} links={sectionLinks}/>
      {o.state==="on_hold"&&<div className="notice" role="status"><strong>This order is currently on hold</strong>{o.hold_reason?`: ${o.hold_reason}`:""}.{paymentState==="paid"?" Your payment is recorded and will be applied when the hold is lifted.":""}</div>}
      {section==="parcels"&&parcelLinkStates.includes(o.state)&&<>
        {unlinkedAdvices.length>0&&<Panel title="Link an already-registered parcel" subtitle="Registered a tracking number earlier? Link it to this order in one click.">
          <Form label="Link selected parcel to order" run={async f=>{
            await request(`/me/parcels/${text(f,"advice_id")}/link-order`,"POST",{order_id:o.id});
            detail.reload();desk.reload();
          }}>
            <Select name="advice_id" label="Registered inbound tracking" choices={unlinkedAdvices.map((a:Row)=>({
              id:a.id,
              label:`${a.tracking_norm} (${label(a.warehouse_state??a.transport_state??"registered")})`,
            }))}/>
          </Form>
        </Panel>}
        <Panel title="Register new seller tracking for this order">
          {receiving.error||carriers.error?<ErrorBlock error={receiving.error||carriers.error}/>:!receiving.data?<p role="status">Loading the receiving address…</p>:
            <InboundParcelForm address={receiving.data.warehouse_address} carriers={carriers.data?.carriers??[]} orderId={o.id} onSave={()=>{detail.reload();desk.reload();}}/>}
        </Panel>
      </>}
      {(section==="dispositions"||section==="storage")&&<OrderHandling
        order={o}
        storage={section==="storage"}
        onSave={detail.reload}
        onOpenTracking={setTrackTarget}
        onOpenItem={setItemTarget}
        onOpenBatch={setBatchTarget}
      />}
      {!section&&orderNext[o.state]&&<div className="order-next"><div><span className="eyebrow">NEXT STEP</span><p>{orderNext[o.state]}</p></div>
        <div className="actions">
          {o.state==="awaiting_payment"&&<Link className="button primary sm" href={base+"/payment"}>Review payment</Link>}
          {o.state==="draft"&&<Link className="button primary sm" href={"/orders/new?draft="+encodeURIComponent(number)}>Edit in step-by-step wizard</Link>}
          {o.state==="awaiting_samples"&&<Link className="button primary sm" href={base+"/parcels"}>Register seller tracking</Link>}
          {["report_ready","action_pending","cancelled"].includes(o.state)&&<Link className="button primary sm" href={base+"/dispositions"}>Open item instructions</Link>}
        </div>
      </div>}
      {!section&&<div className="metric-strip" aria-label="Order progress summary">
        <Link className="metric" href={base+"/payment"}><span>Payment</span><strong>{paymentState?label(paymentState):label(o.state)}</strong><small>{payment.data?.charge?usd(payment.data.charge.amount_cents):"Inspection fee"}</small></Link>
        <Link className="metric" href={base+"/parcels"}><span>Inbound Parcels</span><strong>{o.parcels.length}</strong><small>{o.parcels.filter((p:Row)=>p.warehouse_state).length} checked in at warehouse</small></Link>
        <Link className="metric" href={base+"/dispositions"}><span>Warehouse Items</span><strong>{o.items.filter((i:Row)=>i.item_id).length} / {o.items.length}</strong><small>Identified physical items</small></Link>
        <Link className="metric" href={o.report_version?base+"/report":base}><span>Inspection Report</span><strong>{o.report_version?`v${o.report_version}`:"Pending"}</strong><small>{o.report_version?"Published & ready":"Awaiting completion"}</small></Link>
      </div>}
      {!section&&<Panel title="Inspection milestones">
        <ol className="timeline">
          <li>Order created <small>{stamp(o.created_at)}</small></li>
          {o.paid_at&&<li>Payment confirmed <small>{stamp(o.paid_at)}</small></li>}
          {o.samples_ready_at&&<li>Items received and identified <small>{stamp(o.samples_ready_at)}</small></li>}
          {o.report_published_at&&<li><Link href={base+"/report"}>Report published</Link> <small>{stamp(o.report_published_at)}</small></li>}
          {o.closed_at&&<li>Order closed <small>{stamp(o.closed_at)}</small></li>}
        </ol>
        {o.sla_due_at&&["queued","inspecting","qa_review"].includes(o.state)&&<p>Estimated report by {stamp(o.sla_due_at)}.</p>}
      </Panel>}
      {(section==="payment"||!section&&o.state==="awaiting_payment")&&<Panel title="Inspection payment">
        {payment.error?<ErrorBlock error={payment.error}/>:!payment.data?<p role="status">Loading the current charge…</p>:<>
          {payment.data.charge&&<p><strong>{usd(payment.data.charge.amount_cents)}</strong> · Quote {payment.data.charge.quote_revision}</p>}
          {paymentState==="open"&&!checkoutNotice?.expired&&<Action primary run={()=>continuePayment(payment.data!.charge.id,payment.data!.charge.quote_revision)}>Resume payment</Action>}
          {paymentState==="processing"&&<p role="status">Payment is processing. We will update the order after confirmation.</p>}
          {(paymentState==="expired"||checkoutNotice?.expired)&&<p>The quote has expired. Review a new quote for this order.</p>}
          {returnedFromCheckout&&paymentState==="open"&&<p role="status">Waiting for payment confirmation.</p>}
          {paymentState==="paid"&&<div className="actions"><Tag>Payment confirmed</Tag>
            {o.state==="awaiting_samples"&&<Link className="button primary" href={base+"/parcels"}>Register seller tracking</Link>}
          </div>}
          {paymentState==="not_due"&&<p>{o.state==="draft"?"Calculate and accept a quote to create the inspection charge.":"There is no payable inspection charge for this order."}</p>}
        </>}
        {checkoutNotice&&(checkoutNotice.error?<ErrorBlock error={checkoutNotice.text}/>:<p role="status">{checkoutNotice.text}</p>)}
        <div className="actions"><button type="button" onClick={refreshPayment}>Refresh payment status</button>
          <Link href={payment.data?.charge?"/account/billing#charge-"+payment.data.charge.id:"/account/billing"}>Open billing</Link></div>
      </Panel>}
      {(!section||section==="payment")&&<Panel title="Inspection scope">
      {o.customer_notes&&<p className="muted">Notes: {o.customer_notes}</p>}
      {o.sla_due_at&&<p className="muted small">Inspection SLA target · {stamp(o.sla_due_at)}</p>}
      {!section&&o.parcels.length>0&&<div className="actions" style={{marginBottom:10}}>
        <small className="muted">Linked seller waybills:</small>
        {o.parcels.map((p:Row)=><CodeButton key={p.id} code={p.tracking_norm} title="Preview carrier & warehouse tracking" onClick={()=>setTrackTarget({kind:"parcels",id:p.id,code:p.tracking_norm})}/>)}
      </div>}
      <Table headers={["Service","Position","Warehouse item","Package","Custody"]} rows={o.items.map((i:Row)=>[
        i.title.en,
        i.position??i.quantity,
        i.code?<CodeButton code={i.code} onClick={()=>setItemTarget({...i,order_no:number})}/>:"Awaiting assignment",
        i.package_code?<span className="code">{i.package_code}</span>:"—",
        i.custody_state?label(i.custody_state):"—",
      ])}/>
      {o.state==="draft"&&Array.isArray(o.lines)&&o.lines.length>0&&<details className="card">
        <summary>Draft item declarations ({o.lines.reduce((n:number,l:Row)=>n+(l.quantity??0),0)} items)</summary>
        {o.lines.map((l:Row)=><div key={l.id}>
          <p><strong>{l.title?.en??l.sku_code}</strong> · {l.quantity} {l.quantity===1?"item":"items"}</p>
          <Table headers={["Sample code","Size","Color","Tolerance"]} rows={(Array.isArray(l.draft_items)?l.draft_items:[]).map((item:Row,idx:number)=>[
            <span className="code">{item.sample_code??`P-${idx+1}`}</span>,
            item.size_label??l.attributes?.size_label??"—",
            item.color_declared??l.attributes?.color_declared??"—",
            Array.isArray(l.attributes?.tolerances)?`${l.attributes.tolerances.length} point-specific ranges`:"Measured values",
          ])}/>
        </div>)}
      </details>}
      {o.report_version&&<Link className="button primary" href={"/orders/"+number+"/report"}>Open inspection report</Link>}
      {(o.state==="draft"||o.state==="awaiting_payment"&&(paymentState==="expired"||checkoutNotice?.expired))&&
        <div className="actions"><Action primary run={async()=>setQuote(await request("/orders/"+id+"/quotes","POST",{revision:o.revision}))}>{o.state==="draft"?"Calculate quote":"Review a new quote"}</Action>
          {o.state==="draft"&&<Link className="button" href={"/orders/new?draft="+encodeURIComponent(number)}>Modify items or service in wizard</Link>}
        </div>}
      {o.state==="draft"&&<details className="card"><summary>Need a manual quote?</summary>
        {o.manual_quote?<p>Quote request · {o.manual_quote.state}</p>:<Form label="Request manual quote" run={async f=>{
          await request("/orders/"+id+"/manual-quote-request","POST",{revision:o.revision,reason:text(f,"reason")});detail.reload();
        }}><Field label="Describe your requirements" name="reason"/></Form>}
      </details>}
      {quote&&["draft","awaiting_payment"].includes(o.state)&&<><hr className="divider"/><h3 id="inspection-quote">{usd(quote.amount_cents)} · expires {stamp(quote.expires_at)}</h3>
        <Table headers={["Quantity","Line amount","Business days"]} rows={quote.line_snapshot.map((l:Row)=>[l.quantity,usd(l.amount_cents),l.business_days])}/>
        {terms.error?<><ErrorBlock error={terms.error}/><button type="button" onClick={terms.reload}>Retry loading policies</button></>:
          !terms.data?<p role="status">Loading policies…</p>:terms.data.terms.length!==4?<Empty>Current policies are unavailable. Please try again later.</Empty>:
          <Form label={quote.amount_cents===0?"Accept no-charge quote":"Accept quote and pay"} run={async f=>{
          const acknowledgements=Object.fromEntries(Object.keys(acknowledged).map(k=>[k,checked(f,k)]));
          const accepted=await request("/orders/"+id+"/submit","POST",{revision:o.revision,quote_id:quote.id,
            terms_version_ids:terms.data?.terms.map((t:Row)=>t.id)??[],acknowledgements});
          setQuote(undefined);
          await continuePayment(accepted.charge.charge_item_id,quote.revision);
        }}>
          <PolicyLinks policies={terms.data.terms}/>
          {Object.entries(acknowledged).map(([k,v])=><label key={k} className="check"><input required type="checkbox" name={k}/>{v}</label>)}
        </Form>}</>}
    </Panel>}
    {section==="payment"&&o.consents.length>0&&<Panel title="Policies accepted for this order">
      {o.consents.map((consent:Row)=><details key={consent.id} className="card">
        <summary>Accepted {stamp(consent.created_at)}</summary><PolicyLinks policies={consent.policies}/>
      </details>)}
    </Panel>}
    {section==="parcels"&&<Panel title="Inbound parcels linked to this order">
      <Table headers={["Seller tracking number","Carrier","Sync status","Carrier status","Warehouse intake",""]} rows={o.parcels.map((p:Row)=>[
        <CodeButton code={p.tracking_norm} onClick={()=>setTrackTarget({kind:"parcels",id:p.id,code:p.tracking_norm})}/>,
        p.carrier_code??"—",
        p.sync_state?label(p.sync_state):"—",
        label(p.transport_state),
        p.warehouse_state?`${label(p.warehouse_state)}${p.package_code?` (${p.package_code})`:""}`:"Awaiting physical receipt",
        <Link className="small" href={"/parcels/"+p.id}>Full page →</Link>,
      ])} empty="No seller waybills are linked to this order."/>
      <div className="actions"><Link href="/account">View your warehouse address</Link><Link href="/parcels">Open all parcels</Link></div>
    </Panel>}
    {!section&&<ScopeReview key={o.revision} orderId={id} onSave={detail.reload}/>}
    {!section&&<Panel title="Support, after-sales &amp; order actions">
      <Table headers={["Case","Subject","Status"]} rows={o.cases.map((c:Row)=>[<Link className="code" href={base+"/cases/"+c.id}>{c.public_no}</Link>,c.subject,label(c.state)])} empty="No support cases are linked to this order."/>
      <details className="card"><summary>Open a support case for this order</summary>
        <Form key={openedCase} label="Submit support case" run={async f=>{
          const result=await request("/me/cases","POST",{order_id:id,category:text(f,"category"),subject:text(f,"subject"),message:text(f,"message")});
          setOpenedCase(result.public_no);
          detail.reload();
        }}>
          <Select name="category" label="Issue" choices={[
            {id:"receipt_mismatch",label:"Received items do not match"},
            {id:"measurement_dispute",label:"Question about inspection results"},
            {id:"return_info_incomplete",label:"Return or forwarding information"},
            {id:"damage_or_loss",label:"Item damage or loss"},
            {id:"payment_refund",label:"Payment or refund"},
          ]}/>
          <Field name="subject" label="Subject"/>
          <label>Describe the issue<textarea name="message" required maxLength={2000}/></label>
        </Form>
        {openedCase&&<p role="status">Case <strong className="code">{openedCase}</strong> is open.</p>}
      </details>
      {id&&<OrderAfterSalesAndRefundPanel orderId={id} orderState={o.state} onSaved={detail.reload}/>}
      {!["closed","cancelled","report_ready","action_pending"].includes(o.state)&&<div className="actions" style={{marginTop:10}}>
        <Action run={async()=>{
          if(!window.confirm("Cancel this inspection? Warehouse items remain available for disposition."))return;
          await request("/orders/"+id+"/cancel","POST",{revision:o.revision});detail.reload();
        }}>Cancel inspection</Action>
      </div>}
    </Panel>}
    </>}
    <CustomerTrackingDrawer target={trackTarget} onClose={()=>setTrackTarget(null)}/>
    <CustomerItemDrawer item={itemTarget} onClose={()=>setItemTarget(null)} onOpenTracking={setTrackTarget} onOpenBatch={setBatchTarget}/>
    <CustomerBatchDrawer batchId={batchTarget} onClose={()=>setBatchTarget(null)} onOpenTracking={setTrackTarget} onSaved={detail.reload}/>
  </>;
}
function OrderAfterSalesAndRefundPanel({orderId,orderState,onSaved}:{orderId:string;orderState:string;onSaved:()=>void}) {
  const preview=useLoad(!["draft","awaiting_payment"].includes(orderState)?`/orders/${orderId}/refund-preview`:null);
  const [ticketNo,setTicketNo]=useState<string>();
  const stage=preview.data?.stage;
  return <details className="card"><summary>After-sales, re-inspection &amp; stage refund policy</summary>
    {stage&&<p className="muted small">
      Current stage: <strong>{label(stage.stage)}</strong> · Standard refund rate: <strong>{stage.refund_rate_pct}%</strong> · Paid: {usd(stage.paid_cents)} · Refunded: {usd(stage.already_refunded_cents)} · Standard refundable: <strong>{usd(stage.recommended_refund_cents)}</strong> ({stage.policy_summary})
    </p>}
    <Form key={ticketNo} label="Submit after-sales request" run={async f=>{
      const res=await request(`/orders/${orderId}/after-sales`,"POST",{
        resolution_type:text(f,"resolution_type"),
        reason:text(f,"reason"),
      });
      setTicketNo(res.ticket_no);
      preview.reload();
      onSaved();
    }}>
      <Select name="resolution_type" label="Requested resolution" choices={[
        {id:"re_inspect",label:"Request re-inspection of physical samples"},
        {id:"service_refund",label:"Request inspection service fee refund"},
      ]}/>
      <Field name="reason" label="Reason and details"/>
    </Form>
    {ticketNo&&<p className="notice" role="status">After-sales case <strong className="code">{ticketNo}</strong> submitted.</p>}
  </details>;
}
async function goCheckout(id:string,revision:number,fallback="/account/billing") {
  const c=await request("/charges/"+id+"/checkout","POST",{quote_revision:revision});
  if(c.checkout_url)location.assign(c.checkout_url);
  else location.assign(fallback);
}
export function DemoCheckout({id}:{id:string}) {
  const {data,error}=useLoad("/auth/providers");
  return <div className="narrow panel"><h1>Test checkout</h1>
    {data?.demo?<><p>Confirm this test payment.</p>
      <Action primary run={async()=>{
        const result=await request("/checkout/demo/"+id,"POST",{});
        location.assign(result.order_number?"/orders/"+result.order_number:"/account/billing");
      }}>Confirm test payment</Action></>:error?<ErrorBlock error={error}/>:data?<Empty>Checkout is unavailable.</Empty>:<p role="status">Loading checkout…</p>}
  </div>;
}
export function ReportView({number,version}:{number:string;version?:number}) {
  const l=useLoad("/orders/by-number/"+number),id=l.data?.id;
  const base=id?"/orders/"+id+"/report":null;
  const r=useLoad(base&&version?base+"/versions/"+version:base);
  const [lightbox,setLightbox]=useState<{ids:string[];labels:string[];annotations?:Row[];index:number}|null>(null);
  const [disputeTicket,setDisputeTicket]=useState<string>();
  const reportPath="/orders/"+number+"/report";
  const report=r.data;
  function showPhoto(ids:string[],labels:string[],index:number,annotations?:Row[]) {
    setLightbox({ids,labels,annotations,index});
  }
  const allCheckpoints:Row[]=report?.snapshot?.sections?.flatMap((s:Row)=>s.results??[])??[];
  return <>
    <div className="page-head"><Link href={"/orders/"+number}>← Order {number}</Link>
      <p className="eyebrow report-eyebrow">INSPECTION / EVIDENCE RECORD</p><h1 className="order-number">{report?.snapshot.report_no??"Inspection report"}</h1>
      {report&&<p className="muted">Version {report.version} · Published {stamp(report.published_at)}</p>}
    </div>
    {(l.error||r.error)&&<ErrorBlock error={l.error||r.error}/>}
    {!report&&!l.error&&!r.error&&<p role="status">Loading report evidence…</p>}
    {report&&<>
      {report.state==="superseded"&&<div className="notice">This is a historical report. <Link href={reportPath}>View the latest published version</Link>.</div>}
      <div className="actions">
        <Action primary run={async()=>{
          const {url}=await request(base+"/versions/"+report.version+"/pdf");
          location.assign(url);
        }}>Download version {report.version} PDF</Action>
        <Link className="button" href={"/orders/"+number+"/dispositions"}>Choose item handling →</Link>
      </div>
      <Panel title="Published versions">
        <Table headers={["Version","Status","Published","Revision reason"]} rows={report.versions.map((v:Row)=>[
          <Link aria-current={v.version===report.version?"page":undefined} href={reportPath+"/versions/"+v.version}>Version {v.version}</Link>,
          v.state==="superseded"?"Historical":"Current",stamp(v.published_at),v.amend_reason??"—",
        ])}/>
      </Panel>
      {id&&<ReportShares key={report.version} orderId={id} version={report.version}/>}
      {report.snapshot.sections.map((s:Row)=><Panel key={s.task_id} title={s.title}>
        <div className="actions">{[...new Set<string>((s.results??[]).map((result:Row)=>result.item).filter((code:string)=>code?.startsWith("S-")))]
          .map(code=><Link className="code-btn" key={code} href={"/items#item-"+code}>{code}</Link>)}</div>
        {s.summary&&<p className="muted small">Expected items: {s.summary.expected_count} · Inspected: {s.summary.checked_count} · Observed issues: {s.summary.issue_count}</p>}
        <ReportSection section={s} results={s.results} grouped={["compare","reference_match"].includes(s.service)} showPhoto={showPhoto}/>
      </Panel>)}
      <Panel title="Scope &amp; what we do not inspect">
        <p className="muted">{report.snapshot.scope_notice??"Findings apply only to the physical samples received and the checks listed in this report."}</p>
        {Array.isArray(report.snapshot.not_inspected)&&report.snapshot.not_inspected.length>0&&<ul>
          {report.snapshot.not_inspected.map((line:string,idx:number)=><li key={idx}>{line}</li>)}
        </ul>}
      </Panel>
      {id&&allCheckpoints.length>0&&<Panel title="Question or dispute a checkpoint in this report">
        <Form key={disputeTicket} label="Submit report dispute" run={async f=>{
          const target=text(f,"checkpoint");
          const [item_code,item_key]=target.split("::");
          const res=await request("/orders/"+id+"/report/disputes","POST",{
            version:report.version,
            item_code,
            item_key,
            subject:text(f,"subject")||undefined,
            message:text(f,"message"),
          });
          setDisputeTicket(res.public_no);
        }}>
          <Select name="checkpoint" label="Checkpoint" choices={allCheckpoints.map((c:Row)=>({
            id:`${c.item}::${c.item_key}`,
            label:`${c.item} · ${c.label} (${c.status})`,
          }))}/>
          <Field name="subject" label="Summary (optional)" required={false}/>
          <label>Details of your question or dispute<textarea name="message" required maxLength={2000}/></label>
        </Form>
        {disputeTicket&&<p className="notice" role="status">Report dispute case <strong className="code">{disputeTicket}</strong> is open and linked to version {report.version}.</p>}
      </Panel>}
    </>}
    {lightbox&&<MediaLightbox ids={lightbox.ids} labels={lightbox.labels} annotations={lightbox.annotations as any} initialIndex={lightbox.index} onClose={()=>setLightbox(null)}/>}
  </>;
}
function ReportSection({section,results,grouped,showPhoto}:{section:Row;results:Row[];grouped:boolean;showPhoto:(ids:string[],labels:string[],index:number,annotations?:Row[])=>void}) {
  const result=(x:Row)=>{
    const base=[x.typed_value!=null?String(x.typed_value):label(x.status.toLowerCase()),x.unit,x.reason].filter(Boolean).join(" · ");
    const circ=typeof x.derived_circumference==="number"?` (Circumference: ${x.derived_circumference} cm)`:"";
    const tol=typeof x.within_tolerance==="boolean"?` · ${x.within_tolerance?"Within stated tolerance":"Outside stated tolerance"}`:"";
    const ann=Array.isArray(x.annotations)&&x.annotations.length>0?` · [Annotated regions: ${x.annotations.map((a:Row)=>a.label||"Defect").join(", ")}]`:"";
    return base+circ+tol+ann;
  };
  const evidence=(x:Row)=>{
    const ids:string[]=x.evidence_ids??[];
    const labels=ids.map((_,idx)=>`${x.label} · ${x.item} (${idx+1}/${ids.length})`);
    const anns=Array.isArray(x.annotations)?x.annotations:[];
    return ids.map((m:string,idx:number)=><button className="evidence-open" type="button" key={m}
      aria-label={`View ${x.label} evidence for ${x.item}`} onClick={()=>showPhoto(ids,labels,idx,anns)}>
      <img className="thumb" src={"/api/v1/media/"+m} alt="" loading="lazy"/></button>);
  };
  const shotsBlock=(section.shots?.length??0)>0&&<div className="card" style={{marginTop:12}}>
    <strong>Standard Camera Angle Photos ({section.shots.length})</strong>
    <div className="actions" style={{marginTop:8,flexWrap:"wrap"}}>
      {section.shots.map((sh:Row,idx:number)=>{
        const allIds=section.shots.map((s:Row)=>s.media_id);
        const allLabels=section.shots.map((s:Row)=>`${s.item??""} · ${s.label??s.shot_code??s.code}`);
        return <button key={sh.media_id+"-"+idx} type="button" className="evidence-open" onClick={()=>showPhoto(allIds,allLabels,idx)}>
          <img className="thumb" src={"/api/v1/media/"+sh.media_id} alt={sh.label??sh.shot_code??sh.code} loading="lazy"/>
          <small className="code" style={{display:"block"}}>{sh.item?`${sh.item} · `:""}{sh.label??sh.shot_code??sh.code}</small>
        </button>;
      })}
    </div>
  </div>;
  const orderShotsBlock=(section.comparison?.order_shots?.length??0)>0&&<div className="card" style={{marginTop:12}}>
    <strong>Side-by-Side Comparison Photos ({section.comparison.order_shots.length})</strong>
    <div className="actions" style={{marginTop:8,flexWrap:"wrap"}}>
      {section.comparison.order_shots.map((sh:Row,idx:number)=>{
        const allIds=section.comparison.order_shots.map((s:Row)=>s.media_id);
        const allLabels=section.comparison.order_shots.map((s:Row)=>`Side-by-Side · ${s.shot_code??s.code}`);
        return <button key={sh.media_id+"-"+idx} type="button" className="evidence-open" onClick={()=>showPhoto(allIds,allLabels,idx)}>
          <img className="thumb" src={"/api/v1/media/"+sh.media_id} alt={sh.shot_code??sh.code} loading="lazy"/>
          <small className="code" style={{display:"block"}}>{sh.shot_code??sh.code}</small>
        </button>;
      })}
    </div>
  </div>;
  if(!grouped) return <>
    <Table headers={["Item","Check","Result","Method","Evidence"]}
      rows={results.map(x=>[x.item,x.label,result(x),x.method,evidence(x)])}/>
    {shotsBlock}
    {orderShotsBlock}
  </>;
  const items=[...new Set(results.map(x=>String(x.item)))];
  const checks=new Map<string,Row>();
  for(const x of results) checks.set(x.item_key,x);
  const diffMap=new Map<string,Row>((section.comparison?.diffs??[]).map((d:Row)=>[d.point_code,d]));
  return <div className="report-comparison">
    <Table headers={["Check",...items,"Diff (max - min)"]} rows={[...checks.values()].map(check=>{
      const d=diffMap.get(check.item_key);
      const diffLabel=d?`${d.display_diff}${d.max_minus_min!=null&&d.unit?" "+d.unit:""}`:"—";
      return [
        <div>{check.label}<small className="muted"><br/>{check.method}</small></div>,
        ...items.map(item=>{
          const x=results.find(r=>r.item===item&&r.item_key===check.item_key);
          return x?<div>{result(x)}<div>{evidence(x)}</div></div>:"—";
        }),
        <span className="code">{diffLabel}</span>,
      ];
    })}/>
    {shotsBlock}
    {orderShotsBlock}
  </div>;
}
export function TrackView({kind,id,embedded=false}:{kind:"parcels"|"shipments";id:string;embedded?:boolean}) {
  const path=kind==="parcels"?"/me/parcels/":"/shipments/";
  const {data,error,reload}=useLoad(path+id+"/tracking?locale=en");
  const canVerify=kind==="parcels"&&data?.allowed_actions.includes("verify_tracking");
  const canCorrect=kind==="parcels"&&Boolean(data&&!data.warehouse_state);
  const verificationPath=path+id+"/tracking-verification";
  const verification=useLoad(canVerify||canCorrect?verificationPath:null),carriers=useLoad(canVerify||canCorrect?"/carriers":null);
  const [refreshError,setRefreshError]=useState<string|null>(null);
  useEffect(()=>{const timer=setInterval(reload,60000);return ()=>clearInterval(timer);},[reload]);
  return <>{!embedded&&<div className="page-head"><p className="eyebrow">Warehouse / Tracking</p><h1>Tracking details</h1><p className="muted">Follow carrier events and the warehouse’s own handling status.</p></div>}{error&&<ErrorBlock error={error}/>}{refreshError&&<ErrorBlock error={refreshError}/>}
    {!data&&!error&&<p role="status">Loading carrier tracking…</p>}
    {data&&<Panel title={data.carrier??"Carrier pending"}><p className="code">{data.tracking_no}</p>
      <div className="actions"><Tag>{label(data.transport_state)}</Tag><Tag>{label(data.sync_state)}</Tag>
      {data.warehouse_state&&<Tag>Warehouse · {label(data.warehouse_state)}</Tag>}
      <button onClick={async()=>{
        setRefreshError(null);
        if(data.allowed_actions.includes("refresh_tracking")) {
          try { await request(path+id+"/tracking/refresh","POST",{}); }
          catch(e){ setRefreshError(e instanceof Error?e.message:String(e)); }
        }
        reload();
      }}>Refresh status</button></div>
      {data.direction==="inbound"&&data.transport_state==="delivered"&&!data.warehouse_state&&<p className="notice" role="status"><strong>Delivered by carrier · Warehouse check-in pending.</strong> Physical receipt is confirmed only after warehouse check-in.</p>}
      {data.direction==="outbound_forward"&&data.transport_state==="delivered"&&<p className="notice" role="status"><strong>Delivered to domestic freight forwarder.</strong> International forwarding is managed by your forwarder.</p>}
      {data.direction==="outbound_return"&&data.transport_state==="delivered"&&<p className="notice" role="status"><strong>Delivered to seller.</strong> Seller refund depends on your seller platform confirmation.</p>}
      {(data.translation_status==="updating"||data.translation_status==="pending")&&<p className="muted small" role="status">English details are being updated{data.latest_event_at?` · Latest carrier event ${stamp(data.latest_event_at)}`:""}.</p>}
      {(data.sync_state==="needs_verification"||data.sync_state==="needs_carrier")&&<p className="notice" role="status">Verification needed — confirm the carrier or shipping label phone number to continue tracking.</p>}
      {data.sync_state==="no_record"&&<p className="muted small" role="status">No carrier events reported yet — the carrier may not have scanned the parcel yet.</p>}
      {(data.sync_state==="delayed"||data.sync_state==="provider_error")&&<p className="muted small" role="status">Carrier updates are temporarily delayed — showing the last known snapshot from {stamp(data.last_success_at)}.</p>}
      {data.sync_state==="unsupported"&&<p className="muted small" role="status">Automatic tracking is not supported for this carrier; warehouse check-in and handover updates will still appear here.</p>}
      {data.next_allowed_at&&!data.allowed_actions.includes("refresh_tracking")&&<p className="muted small">Next manual refresh available at {stamp(data.next_allowed_at)}.</p>}
      {canVerify&&verification.data&&<Form label="Verify carrier tracking" run={async f=>{
        const phone=text(f,"phone");
        await request(verificationPath,"POST",{revision:verification.data?.revision,carrier_code:verification.data?.carrier_code??text(f,"carrier_code"),...(phone?{phone}:{})});
        verification.reload();reload();
      }}>
        {!verification.data.carrier_code&&<Select name="carrier_code" label="Carrier" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>}
        <Field name="phone" label="Phone used on this shipping label, if required by the carrier" required={false} type="tel"/>
      </Form>}
      {canCorrect&&verification.data&&<details className="top-gap"><summary>Correct tracking number or carrier before check-in</summary>
        <Form label="Save corrected tracking" run={async f=>{
          await request(path+id+"/correct","POST",{
            revision:verification.data?.revision,
            carrier_code:text(f,"carrier_code")||verification.data?.carrier_code,
            tracking_no:text(f,"tracking_no"),
            reason:text(f,"reason"),
          });
          verification.reload();reload();
        }}>
          <Select name="carrier_code" label="Carrier" value={verification.data.carrier_code??""} choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>
          <Field name="tracking_no" label="Corrected tracking number" value={data.tracking_no}/>
          <Field name="reason" label="Reason for correction"/>
        </Form>
      </details>}
      <p className="muted small">Carrier data updated {stamp(data.last_success_at)}</p>
      {data.events.length?<ol className="timeline">{data.events.map((e:Row)=><li key={e.id}><small>{stamp(e.occurred_at)}</small><br/>{e.text}</li>)}</ol>:<Empty>English carrier events will appear when verified tracking data is available.</Empty>}
    </Panel>}
  </>;
}
function orderNextAction(o:Row):{label:string;href:string} {
  const base="/orders/"+o.public_no;
  switch(o.state) {
    case "draft": return {label:"Resume wizard",href:"/orders/new?draft="+encodeURIComponent(o.public_no)};
    case "awaiting_payment": return {label:"Complete payment",href:base+"/payment"};
    case "awaiting_samples": return {label:"Register seller tracking",href:base+"/parcels"};
    case "report_ready":
    case "action_pending": return {label:"Choose item handling",href:base+"/dispositions"};
    case "on_hold": return {label:"Review hold reason",href:base};
    default: return {label:"View progress",href:base};
  }
}
export function CustomerDesk({path,demo=false}:{path:string;demo?:boolean}) {
  const search=useSearchParams();
  const router=useRouter();
  const orderParams=new URLSearchParams();
  for(const key of ["q","state","page"]) {
    const value=search.get(key);
    if(value) orderParams.set(key,value);
  }
  const orderList=useLoad(path==="/orders"?"/me/orders?"+orderParams:null);
  const [parcelTab,setParcelTab]=useState("incoming");
  const [itemFilter,setItemFilter]=useState("");
  const [addressCopied,setAddressCopied]=useState(false);
  const [createdCase,setCreatedCase]=useState<Row>();
  const {data,error,reload}=useLoad("/me/desk"),carriers=useLoad("/carriers");
  const homeActions=useLoad(path==="/account"?"/actions":null);
  const [next,setNext]=useState<string|null>(null);
  const [parcelOrder,setParcelOrder]=useState<string|null>(null);
  const [trackTarget,setTrackTarget]=useState<CustomerTrackingTarget|null>(null);
  const [itemTarget,setItemTarget]=useState<Row|null>(null);
  const [batchTarget,setBatchTarget]=useState<string|null>(null);
  useEffect(()=>{
    const params=new URLSearchParams(location.search);
    setNext(customerDestination(params.get("next")));
    setParcelOrder(params.get("order"));
  },[path]);
  const [batchIds,setBatchIds]=useState<string[]>([]);
  useEffect(()=>{
    if(!data)return;
    const id=location.hash.slice(1);
    if(/^(case|quote|charge|item)-[a-zA-Z0-9-]{1,64}$/.test(id)) document.getElementById(id)?.scrollIntoView({block:"start"});
  },[data,path]);
  if(error)return <ErrorBlock error={error}/>;
  if(!data)return <p>Loading your account…</p>;
  const addr=data.profile.warehouse_address;
  const isHome=path==="/account",isSecurity=path==="/account/security",isItems=path==="/items",isParcels=path==="/parcels",isBills=path==="/account/billing",isOrders=path==="/orders",isHelp=path==="/support";
  const orders:Row[]=data.orders;
  const linkableOrders=orders.filter(order=>parcelLinkStates.includes(order.state));
  const visibleOrders:Row[]=isHome?orders.slice(0,5):orderList.data?.rows??[];
  const page=Number(orderParams.get("page")??1);
  function ordersHref(target:number) {
    const params=new URLSearchParams(orderParams);
    if(target<=1) params.delete("page");
    else params.set("page",String(target));
    return "/orders"+(params.size?"?"+params:"");
  }
  const pendingItems=data.items.filter((item:Row)=>needsHandling(item));
  const visibleItems=data.items.filter((item:Row)=>!itemFilter||
    itemFilter==="handling"&&needsHandling(item)||
    itemFilter==="inspection"&&item.order_state&&!handlingStates.includes(item.order_state)||
    itemFilter==="reference"&&item.reference_sample?.state==="active"&&!item.reference_sample.expired);
  const parcelRows=data.advices.filter((parcel:Row)=>parcelTab==="attention"
    ?["needs_carrier","needs_verification"].includes(parcel.sync_state)||parcel.warehouse_state==="quarantined"
    :parcelTab==="received"?Boolean(parcel.warehouse_state):!parcel.warehouse_state);
  return <>
    {data.email_delivery?.banner_message&&<div className="notice" role="alert"><strong>{data.email_delivery.banner_message}</strong>{data.email_delivery.masked_email?` (${data.email_delivery.masked_email})`:""}. Important updates remain available in your account notifications and action centre. <Link href="/account/security">Update email in account security →</Link></div>}
    {isHome&&<>
      <div className="page-head row">
        <div><p className="eyebrow">MY WORKSPACE</p><h1>Workspace Overview</h1><p className="muted">Your active inspections, parcels, items awaiting instructions and permanent China warehouse receiving address.</p></div>
        <div className="head-actions"><Link className="button sm" href="/account/security">Sign-in &amp; security</Link><Link className="button primary sm" href="/orders/new">+ Create Inspection</Link></div>
      </div>
      <div className="metric-strip" aria-label="Account summary">
        <Link className="metric" href="/orders"><span>Active Inspections</span><strong>{data.summary.active_inspections}</strong><small>Submitted inspections still open</small></Link>
        <Link className="metric" href="/parcels"><span>Parcels</span><strong>{data.summary.awaiting_check_in}</strong><small>awaiting check-in · {data.summary.checked_in} checked in at warehouse</small></Link>
        <Link className="metric" href="/items"><span>Items Awaiting Instructions</span><strong>{data.summary.awaiting_instructions}</strong><small>{data.summary.in_custody} items in warehouse custody</small></Link>
        <Link className="metric" href="/account/billing"><span>Quotes Awaiting Approval</span><strong>{data.summary.pending_quotes}</strong><small>Inspection, shipping and storage quotes</small></Link>
      </div>
      {(homeActions.data?.rows?.length??0)>0&&<div className="order-next" role="status">
        <div><h2>Action Required</h2><ul className="workspace-actions-list">{homeActions.data!.rows.slice(0,3).map((action:Row)=>
          <li key={action.kind+action.id}><Link href={customerActionHref(action)}>{actionTitles[action.state]??"Review action"}</Link>
            {action.reference&&<span className="code"> · {action.reference}</span>}</li>)}</ul></div>
        <div className="actions"><Link className="button primary sm" href="/actions">Review actions →</Link></div>
      </div>}
        <Panel title="China Warehouse Receiving Address" subtitle="Include your permanent receiving code on the seller’s shipping label."
          badge={demo?<Tag tone="yellow">Test address</Tag>:addr?<Tag tone="green">Current address</Tag>:undefined}>
          <div className="receiving-code"><span className="eyebrow">PERMANENT PERSONAL RECEIVING CODE</span><strong className="code">{data.profile.receiving_code}</strong></div>
          {addr?<>
            <div className="grid cols2" style={{marginBottom:12}}>
              <dl className="def"><dt>Recipient &amp; Phone</dt><dd>{addr.recipient} · {addr.phone}</dd></dl>
              <dl className="def"><dt>Chinese Shipping Address (For Domestic Sellers)</dt><dd>{addr.address_zh}（收件码：{data.profile.receiving_code}）</dd></dl>
              <dl className="def"><dt>English Reference Address</dt><dd>{addr.address_en}</dd></dl>
            </div>
            <div className="actions">
              <Action primary run={async()=>{
                await navigator.clipboard.writeText([addr.recipient,addr.phone,`${addr.address_zh}（收件码：${data.profile.receiving_code}）`].join("\n"));
                setAddressCopied(true);
              }}>Copy Chinese shipping address</Action>
              {addressCopied&&<span role="status">Address copied.</span>}
              <Link className="button sm" href="/parcels">Register seller tracking →</Link>
            </div>
          </>:<Empty>The warehouse address is awaiting configuration.</Empty>}
          {next&&<Link className="button primary" href={next}>Continue to your selected page</Link>}
        </Panel>

    </>}
    {isSecurity&&<AccountSecurity receivingCode={data.profile.receiving_code}/>}
    {isOrders&&<div className="page-head row"><div><p className="eyebrow">CLIENT WORKSPACE</p><h1>Inspection orders</h1><p className="muted">Review your orders or continue an existing draft.</p></div>
      <Link className="button primary" href="/orders/new">New inspection <span aria-hidden="true">→</span></Link></div>}
    {(isHome||isOrders)&&<Panel title={isHome?"Recent orders":"Your orders"}>
      {isOrders&&<form className="form inline-form" key={orderParams.toString()} onSubmit={event=>{
        event.preventDefault();
        const fields=new FormData(event.currentTarget);
        const params=new URLSearchParams();
        for(const key of ["q","state"]) {
          const value=text(fields,key);
          if(value) params.set(key,value);
        }
        router.push("/orders"+(params.size?"?"+params:""));
      }}>
        <label>Order number<input name="q" type="search" maxLength={68} defaultValue={orderParams.get("q")??""} placeholder="Find an order…"/></label>
        <label>Status<select name="state" defaultValue={orderParams.get("state")??""}><option value="">All statuses</option>
          {Object.keys(orderNext).map(state=><option key={state} value={state}>{label(state)}</option>)}
          <option value="closed">Closed</option>
        </select></label>
        <button type="submit" className="button">Apply filters</button>
        {orderParams.size>0&&<Link href="/orders">Clear filters</Link>}
      </form>}
      {isOrders&&orderList.error&&<ErrorBlock error={orderList.error}/>}
      {isOrders&&!orderList.data&&!orderList.error&&<p role="status">Loading orders…</p>}
      {visibleOrders.length?<Table headers={isHome?["Order","Service","Inspection status","Next action"]:["Order","Service & items","Inspection status","Payment","Report","Updated","Next action"]} rows={visibleOrders.map(o=>{
        const nextAction=orderNextAction(o);
        const service=<div className="cell-stack"><span>{o.service_title??"—"}</span>{o.item_count!=null&&<small>{o.item_count} {o.item_count===1?"item":"items"}</small>}</div>;
        const statusCell=<Tag tone={o.state==="on_hold"?"red":["report_ready","action_pending"].includes(o.state)?"green":o.state==="draft"?"gray":"blue"}>{label(o.state)}</Tag>;
        const next=<Link className="small" href={nextAction.href}>{nextAction.label} →</Link>;
        const orderLink=<Link className="code" href={"/orders/"+o.public_no}>{o.public_no}</Link>;
        return isHome?[orderLink,service,statusCell,next]:[
          orderLink,service,statusCell,
          o.payment_state?<Tag tone={o.payment_state==="paid"?"green":o.payment_state==="processing"?"yellow":"outline"}>{label(o.payment_state)}</Tag>:o.state==="draft"?<span className="muted small">Not submitted</span>:"—",
          o.report_version?<Link className="code-btn" href={`/orders/${o.public_no}/report`}>v{o.report_version}</Link>:<span className="muted small">Pending</span>,
          stamp(o.updated_at??o.created_at),
          next,
        ];
      })}/>:(isHome||orderList.data)&&<Empty>{orderParams.size?"No orders match your filters.":"You haven't created an inspection yet. Start one from New Inspection."}</Empty>}
      {isHome&&orders.length>0&&<Link href="/orders">View all orders →</Link>}
      {isOrders&&orderList.data&&(page>1||orderList.data.has_more)&&<nav className="actions" aria-label="Order pages">
        {page>1&&<Link className="button" href={ordersHref(page-1)}>Previous page</Link>}
        <span>Page {page}</span>
        {orderList.data.has_more&&<Link className="button" href={ordersHref(page+1)}>Next page</Link>}
      </nav>}
    </Panel>}
    {isHome&&<RecentUpdates notices={data.notices} onRead={reload}/>}
    {isParcels&&<><div className="page-head"><p className="eyebrow">Warehouse deliveries</p><h1>Parcels</h1><p className="muted">Register the seller’s tracking number, link parcels to orders, and click any tracking number to inspect live events.</p></div>
    <details className="card" open={Boolean(parcelOrder)||undefined}>
      <summary>Register incoming parcel</summary>
      <InboundParcelForm address={addr} carriers={carriers.data?.carriers??[]} orders={linkableOrders} preferredOrder={parcelOrder}
        onSave={()=>{setParcelTab("incoming");reload();}}/>
    </details>
    <div className="actions workspace-filters" aria-label="Parcel filters">
      {[["incoming","Incoming"],["received","Received"],["attention","Needs Attention"],["outgoing","Outgoing"]].map(([key,title])=>
        <button type="button" key={key} aria-pressed={parcelTab===key} className={parcelTab===key?"button primary":"button"}
          onClick={()=>setParcelTab(key)}>{title}</button>)}
    </div>
    {parcelTab!=="outgoing"&&<Panel title={parcelTab==="received"?"Warehouse receipts":parcelTab==="attention"?"Parcels needing attention":"Incoming parcels"}>
      <Table headers={["Inbound tracking","Linked orders","Warehouse status","Carrier status"]} rows={parcelRows.map((a:Row)=>{
        const linkedNos:string[]=a.order_numbers??[];
        const candidates=linkableOrders.filter(o=>!linkedNos.includes(o.public_no));
        return [
          <div className="actions">
            <CodeButton code={a.tracking_norm} title="Preview tracking timeline" onClick={()=>setTrackTarget({kind:"parcels",id:a.id,code:a.tracking_norm})}/>
            <Link className="small muted" href={"/parcels/"+a.id}>Page →</Link>
          </div>,
          <div className="cell-stack">
            <div className="actions">{linkedNos.length?linkedNos.map((no:string)=><Link key={no} className="code-btn" href={"/orders/"+no}>{no}</Link>):<span className="muted">Unlinked</span>}</div>
            {candidates.length>0&&<details className="small">
              <summary style={{cursor:"pointer"}}>+ Link to order</summary>
              <Form label="Link" run={async f=>{
                await request(`/me/parcels/${a.id}/link-order`,"POST",{order_id:text(f,"order_id")});
                reload();
              }}>
                <Select name="order_id" label="Order" choices={candidates.map(o=>({id:o.id,label:`${o.public_no} (${label(o.state)})`}))}/>
              </Form>
            </details>}
          </div>,
          label(a.warehouse_state??"awaiting_warehouse"),
          label(a.transport_state),
        ];
      })} empty="No parcels match this view."/>
    </Panel>}
    {parcelTab==="attention"&&<Panel title="Request a parcel ownership review">
      <p className="muted">If a specific parcel is missing from your account, use its seller tracking number and upload the seller’s shipment proof. Parcel details become visible after the warehouse verifies ownership.</p>
      <Form label="Request ownership review" run={async f=>{await request("/me/intake-claims","POST",f);reload();}}>
        <Field name="tracking_no" label="Seller’s tracking number"/>
        <Select name="carrier_code" label="Carrier" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>
        <Photo label="Seller shipment proof"/>
      </Form>
      <Table headers={["Claim","Review status"]} rows={data.tickets.filter((t:Row)=>t.public_no.startsWith("CLAIM-")).map((t:Row)=>[t.public_no,t.decision??t.state])}/>
    </Panel>}
    {parcelTab==="outgoing"&&<Panel title="Outbound parcels">
      <Table headers={["Tracking number","Batch","Destination type","Warehouse handover",""]} rows={data.shipments.map((s:Row)=>[
        <div className="actions">
          <CodeButton code={s.tracking_norm} title="Preview outbound tracking" onClick={()=>setTrackTarget({kind:"shipments",id:s.id,code:s.tracking_norm})}/>
          <Link className="small muted" href={"/shipments/"+s.id}>Page →</Link>
        </div>,
        s.batch_id?<CodeButton code={`#${String(s.batch_id).slice(0,8)}`} onClick={()=>setBatchTarget(s.batch_id)}/>:"—",
        label(s.action),
        stamp(s.shipped_at),
        <CodeButton code="Track" onClick={()=>setTrackTarget({kind:"shipments",id:s.id,code:s.tracking_norm})}/>,
      ])} empty="No outbound shipments yet."/>
    </Panel>}</>}
    {isItems&&<><div className="page-head"><p className="eyebrow">Inventory &amp; handling</p><h1>Warehouse items</h1><p className="muted">Click any item code, tracking number or dispatch batch to inspect details, or submit batch handling instructions below.</p></div>
    <div className="metric-strip" aria-label="Items summary">
      {[
        ["Warehouse items",data.items.length],
        ["In inspection",data.items.filter((item:Row)=>item.order_state&&!handlingStates.includes(item.order_state)).length],
        ["Awaiting instructions",pendingItems.length],
        ["Active reference samples",(data.references??[]).filter((r:Row)=>r.state==="active"&&!r.expired).length],
      ].map(([name,value])=><div className="metric" key={name}><span>{name}</span><strong>{value}</strong></div>)}
    </div>
    <Panel title="Your items">
      <label>Show items <select value={itemFilter} onChange={event=>setItemFilter(event.target.value)}>
        <option value="">All items</option><option value="inspection">In inspection</option>
        <option value="handling">Awaiting instructions</option><option value="reference">Active Golden Samples</option>
      </select></label>
      <Table headers={["Item","Inbound / Package","Order & inspection","Custody","Storage through","Reference / Dispatch","Shipping batch"]} rows={visibleItems.map((w:Row)=>[
        <div className="cell-stack">
          <div id={"item-"+w.code}><CodeButton code={w.code} onClick={()=>setItemTarget(w)}/></div>
          {w.declared_fields?.name&&<small>{w.declared_fields.name} {[w.declared_fields.color_declared,w.declared_fields.size_label].filter(Boolean).join(" · ")}</small>}
          {w.components?.length>0&&<small className="muted">Components: {w.components.map((c:Row)=>c.code).join(", ")}</small>}
        </div>,
        <div className="cell-stack">
          <span className="code">{w.package_code??"—"}</span>
          {w.inbound_advice_id&&w.inbound_tracking_norm&&<small><CodeButton code={w.inbound_tracking_norm} onClick={()=>setTrackTarget({kind:"parcels",id:w.inbound_advice_id,code:w.inbound_tracking_norm})}/></small>}
        </div>,
        w.order_no?<div className="cell-stack"><Link className="code-btn" href={"/orders/"+w.order_no}>{w.order_no}</Link><small>{label(w.order_state)}</small></div>:"Uncommissioned",
        w.identity_state==="quarantined"?"Quarantined":label(w.custody_state),
        stamp(w.storage_until),
        <div className="cell-stack">
          {w.reference_sample&&<span>{
            w.reference_sample.state==="pending_safe_storage"
              ?`Pending safe storage${w.reference_sample.seal_code?` · Seal ${w.reference_sample.seal_code}`:""}`
              :`${w.reference_sample.state==="active"?(w.reference_sample.expired?"Expired":"Active"):"Released"}${w.reference_sample.seal_code?` · Seal ${w.reference_sample.seal_code}`:""}${w.reference_sample.in_use?" · In comparison":""}`
          }</span>}
          {w.active_batch_id&&<small><CodeButton code={`Batch #${String(w.active_batch_id).slice(0,8)}`} onClick={()=>setBatchTarget(w.active_batch_id)}/></small>}
          {w.outbound_shipment?.id&&<small><CodeButton code={w.outbound_shipment.tracking_norm} onClick={()=>setTrackTarget({kind:"shipments",id:w.outbound_shipment.id,code:w.outbound_shipment.tracking_norm})}/></small>}
          {!w.reference_sample&&!w.active_batch_id&&!w.outbound_shipment?.id&&"—"}
        </div>,
        w.instructions.length>0?w.instructions.map((i:string)=><label key={i} className="small"><input type="checkbox" checked={batchIds.includes(i)} onChange={e=>setBatchIds(xs=>e.target.checked?[...xs,i]:xs.filter(x=>x!==i))}/> Select for shipping</label>):(w.active_disposition?<Tag tone="outline">{label(w.active_disposition.action)}</Tag>:"—"),
      ])}/>
      {!data.items.length&&<Empty>Items will appear after physical warehouse intake and ownership verification.</Empty>}
      {!!batchIds.length&&<Action primary run={async()=>{const b=await request("/dispatch-batches","POST",{disposition_ids:batchIds});await request("/dispatch-batches/"+b.batch_id+"/confirm","POST",{revision:b.revision});setBatchIds([]);reload();}}>Confirm selected items for quoting ({batchIds.length})</Action>}
      {data.batches.map((b:Row)=><div key={b.id} className="notice row"><span>Draft shipping batch <strong className="code">#{b.id.slice(0,8)}</strong></span><div className="actions"><CodeButton code="Inspect / Amend" onClick={()=>setBatchTarget(b.id)}/><Action run={async()=>{await request("/dispatch-batches/"+b.id+"/confirm","POST",{revision:b.revision});reload();}}>Confirm draft batch</Action></div></div>)}
    </Panel>
    {(data.active_batches??[]).length>0&&<Panel title="Dispatch batches" subtitle="Click any batch to view items, quotes, outbound tracking, or amend destination before carrier handover.">
      <Table headers={["Batch","Handling","Status","Items","Destination","Latest quote","Outbound waybills"]} rows={(data.active_batches??[]).map((b:Row)=>[
        <CodeButton code={`#${String(b.id).slice(0,8)}`} onClick={()=>setBatchTarget(b.id)}/>,
        label(b.action),
        <Tag>{label(b.state)}</Tag>,
        <span className="code">{(b.item_codes??[]).join(", ")||"—"}</span>,
        <small>{b.destination_snapshot?.recipient??"—"} · {b.destination_snapshot?.address??"—"}</small>,
        b.quote_id?usd(b.quote_amount_cents):"Awaiting quote",
        b.outbound_shipments.length>0?<div className="actions">{b.outbound_shipments.map((shipment:Row)=>
          <CodeButton key={shipment.id} code={shipment.tracking_norm} onClick={()=>setTrackTarget({kind:"shipments",id:shipment.id,code:shipment.tracking_norm})}/>
        )}</div>:"—",
      ])}/>
    </Panel>}
    <Panel title="Reference samples">
      <Table headers={["Item","Revision","Status","Valid through",""]} rows={(data.references??[]).map((r:Row)=>[
        <CodeButton code={r.code??r.item_id} onClick={()=>{
          const found=data.items.find((w:Row)=>w.item_id===r.item_id||w.code===r.code);
          if(found) setItemTarget(found);
        }}/>,`v${r.revision??1}`,
        <Tag>{r.in_use?"Locked in comparison":r.state==="active"&&r.expired?"Expired":label(r.state)}</Tag>,
        stamp(r.expires_at),
        r.state==="active"&&!r.in_use?<Action run={async()=>{
          const t=await request("/public/terms");
          const termsId=t.terms?.find((x:Row)=>x.kind==="terms")?.id;
          if(!termsId) throw new Error("Service terms are unavailable.");
          await request("/me/reference-samples/"+r.reference_id+"/release","POST",{terms_version_id:termsId,reason:"Customer released reference sample"});
          reload();
        }}>Release reference</Action>:r.in_use?<small>In active comparison</small>:null,
      ])} empty="No reference samples reserved yet. Use the instruction form below to reserve a stored item as a reference sample."/>
    </Panel>
    <Panel title="Request handling for items">
      <p className="muted">Select one or multiple warehouse items to return to the seller, forward to your shipping agent, extend storage, or reserve as a reference sample.</p>
      <ItemInstructionForm
        items={data.items.filter((w:Row)=>w.allowed_actions.includes("request_disposition")&&
          (!w.order_state||handlingStates.includes(w.order_state))&&!w.active_disposition&&!w.reference_sample?.in_use)}
        recentDestinations={data.recent_destinations??[]}
        onSave={reload}
      />
    </Panel></>}
    {isBills&&<><div className="page-head"><p className="eyebrow">Account services</p><h1>Billing</h1><p className="muted">Review shipping quotes, charges and refunds for your inspections.</p></div><Panel title="Quotes awaiting your approval">
      {data.quotes.map((quote:Row)=><FulfillmentQuote key={quote.id} quote={quote} onUpdate={reload} onOpenBatch={setBatchTarget}/>)}
      {data.inspectionQuotes.map((quote:Row)=><div className="card row" key={quote.id}>
        <div><strong>Inspection · {quote.order_number}</strong><p>{usd(quote.amount_cents)} · Valid until {stamp(quote.expires_at)}</p></div>
        <Link className="button" href={"/orders/"+quote.order_number+"#inspection-quote"}>Review inspection quote</Link>
      </div>)}
      {!data.quotes.length&&!data.inspectionQuotes.length&&<Empty>No new quotes.</Empty>}
    </Panel><Panel title="Payments & charges" subtitle="Inspection, shipping and storage charges. Payment is confirmed only after server-side verification.">
      <Table headers={["Purpose","Order / Batch","Amount","Refunded","Status","Paid on","Details",""]} rows={data.bills.map((b:Row)=>[
        <span id={"charge-"+b.charge_item_id}>{label(b.purpose)}</span>,
        (b.order_numbers??[]).length?b.order_numbers.map((no:string)=><Link key={no} className="code-btn" href={"/orders/"+no}>{no}</Link>):b.batch_id?<CodeButton code={`Batch #${b.batch_id.slice(0,8)}`} onClick={()=>setBatchTarget(b.batch_id)}/>:"—",
        usd(b.amount_cents),
        b.refunded_cents?usd(b.refunded_cents):"—",
        <Tag tone={b.state==="paid"?"green":b.state==="open"?"yellow":b.state==="void"?"gray":"blue"}>{
          b.refunded_cents>0?(b.refunded_cents>=b.amount_cents?"Refunded":"Partially refunded"):
            b.paid_ref?.startsWith("demo_")?"Test payment confirmed":label(b.state)
        }</Tag>,
        stamp(b.paid_at),
        b.paid_ref?.startsWith("demo_")?<small>Test payment</small>:b.paid_ref?<details className="small"><summary className="code" title={b.paid_ref}>…{String(b.paid_ref).slice(-8)}</summary><span className="code" style={{overflowWrap:"anywhere"}}>{b.paid_ref}</span></details>:b.latest_attempt_state?label(b.latest_attempt_state):"—",
        b.state==="open"&&b.expires_at&&Date.parse(b.expires_at)<=Date.now()
          ?(b.order_numbers?.[0]?<Link href={"/orders/"+b.order_numbers[0]+"/payment"}>Review expired quote</Link>:<span>Quote expired</span>)
          :b.state==="open"?<Action run={()=>goCheckout(b.charge_item_id,b.quote_revision)}>Pay</Action>:null
      ])} empty="No charges yet."/>
    </Panel><Panel title="Refunds" subtitle="Platform fee refunds issued by QCWarehouse. Seller refunds are handled on your seller's platform and are not shown here.">
      <Table headers={["Requested","Purpose","Order","Amount","Status"]} rows={(data.refunds??[]).map((r:Row)=>[
        stamp(r.created_at),
        label(r.purpose),
        r.order_no?<Link className="code-btn" href={"/orders/"+r.order_no}>{r.order_no}</Link>:"—",
        usd(r.amount_cents),
        <Tag tone={r.state==="succeeded"?"green":r.state==="failed"?"red":"yellow"}>{label(r.state)}</Tag>,
      ])} empty="No refunds have been issued."/>
    </Panel></>}
    {isHelp&&<><div className="page-head"><p className="eyebrow">MY WORKSPACE · ACCOUNT</p><h1>Support</h1><p className="muted">Open a case about an order, parcel, report or payment, and follow the warehouse team&apos;s replies.</p></div>
      <Panel title="Open a support case">
        <Form key={createdCase?.id} label="Submit case" run={async f=>{
          const orderId=text(f,"order_id"),category=text(f,"category");
          if(category&&!orderId) throw new Error("Select the related order for this issue type.");
          const result=await request("/me/cases","POST",{subject:text(f,"subject"),message:text(f,"message"),...(orderId?{order_id:orderId}:{}),...(category?{category}:{})});
          setCreatedCase(result);
          reload();
        }}>
          <Select name="category" label="Issue type" required={false} choices={[
            {id:"receipt_mismatch",label:"Received items do not match"},
            {id:"measurement_dispute",label:"Question about inspection results"},
            {id:"return_info_incomplete",label:"Return or forwarding information"},
            {id:"damage_or_loss",label:"Item damage or loss"},
            {id:"payment_refund",label:"Payment or refund"},
          ]}/>
          <Select name="order_id" label="Related order (optional)" required={false} choices={orders.map(o=>({id:o.id,label:`${o.public_no} · ${label(o.state)}`}))}/>
          <Field name="subject" label="Subject"/><label>Message<textarea name="message" required maxLength={2000}/></label>
        </Form>
        {createdCase&&<p role="status">Case <Link href={"/support/cases/"+createdCase.id}>{createdCase.public_no}</Link> opened.</p>}
      </Panel>
      <Panel title="My support cases">
        <Table headers={["Case","Subject","Issue type","Order","Status","Last update"]} rows={data.tickets.map((t:Row)=>[
          <Link className="code" id={"case-"+t.id} href={"/support/cases/"+t.id}>{t.public_no}</Link>,
          t.subject,
          t.category?label(t.category):"General",
          t.order_no?<Link className="code-btn" href={"/orders/"+t.order_no}>{t.order_no}</Link>:"—",
          <Tag tone={t.state==="waiting_customer"?"yellow":t.state==="closed"||t.state==="resolved"?"gray":"blue"}>{t.state==="waiting_customer"?"Awaiting your reply":label(t.state)}</Tag>,
          stamp(t.updated_at??t.created_at),
        ])} empty="No support cases yet."/>
      </Panel></>}
    <CustomerTrackingDrawer target={trackTarget} onClose={()=>setTrackTarget(null)}/>
    <CustomerItemDrawer item={itemTarget} onClose={()=>setItemTarget(null)} onOpenTracking={setTrackTarget} onOpenBatch={setBatchTarget}/>
    <CustomerBatchDrawer batchId={batchTarget} onClose={()=>setBatchTarget(null)} onOpenTracking={setTrackTarget} onSaved={reload}/>
  </>;
}

function AccountSecurity({receivingCode}:{receivingCode:string}) {
  const identities=useLoad("/me/identities");
  const sessions=useLoad("/me/sessions");
  const [reauthChallenge,setReauthChallenge]=useState<{challenge_id:string;demo_code?:string}>();
  const [emailChange,setEmailChange]=useState<{
    new_email:string;current_challenge_id:string;current_demo_code?:string;new_challenge_id:string;new_demo_code?:string;
  }>();
  const refreshAll=()=>{identities.reload();sessions.reload();};
  const info=identities.data;
  const activeIdentities:Row[]=info?.identities??[];
  const emails:Row[]=info?.emails??[];
  const primaryEmail=emails.find(e=>e.is_primary)?.original_email??"—";
  return <>
    <div className="page-head row">
      <div><Link href="/account">← Account overview</Link><p className="eyebrow">CLIENT WORKSPACE / SECURITY</p>
        <h1>Sign-in methods &amp; security</h1>
        <p className="muted">Manage linked sign-in methods, primary contact email, active device sessions, and account status. Your permanent receiving code <span className="code">{receivingCode}</span> never changes.</p>
      </div>
      {info?.reauthenticated?<Tag>Reauthenticated</Tag>:<Tag>Standard session</Tag>}
    </div>
    {(identities.error||sessions.error)&&<ErrorBlock error={identities.error||sessions.error}/>}
    {info?.status==="restricted"&&<div className="notice" role="alert"><strong>Account restricted:</strong> New orders, payments, and outbound instructions are temporarily paused while your existing orders and support cases remain accessible.</div>}
    <Panel title="Recent verification for sensitive changes">
      <p className="muted">Linking or removing sign-in methods, changing your primary email, revoking other sessions, or closing your account requires verification within the last 10 minutes.</p>
      {info?.reauthenticated?<p className="notice" role="status">Your session is verified for sensitive security actions.</p>:
        reauthChallenge?<div className="code-step">
          {reauthChallenge.demo_code&&<p>Test code: <strong className="code">{reauthChallenge.demo_code}</strong></p>}
          <Form key={reauthChallenge.challenge_id} label="Confirm verification code" run={async f=>{
            await request("/auth/reauth/verify","POST",{challenge_id:reauthChallenge.challenge_id,code:text(f,"code")});
            setReauthChallenge(undefined);refreshAll();
          }}>
            <Field name="code" label="6-digit verification code"/>
          </Form>
        </div>:
        <Action primary run={async()=>{
          setReauthChallenge(await request("/auth/reauth/start","POST",{}));
        }}>Send verification code</Action>}
    </Panel>
    <Panel title="Linked sign-in methods">
      <Table headers={["Provider","Identifier","Linked","Last used",""]} rows={activeIdentities.map(i=>[
        i.provider==="email_otp"?"Email verification code":i.provider==="google"?"Google":"Microsoft",
        <span className="code">{i.email??i.issuer}</span>,
        stamp(i.linked_at),
        stamp(i.last_authenticated_at),
        activeIdentities.length>1?<Action run={async()=>{
          await request("/me/identities/"+i.id,"DELETE",{});refreshAll();
        }}>Remove</Action>:<small className="muted">Last sign-in method</small>
      ])} empty="No active sign-in methods found."/>
      <div className="actions">
        {(["google","microsoft"] as const).filter(p=>!activeIdentities.some(i=>i.provider===p)).map(provider=>
          <Action key={provider} run={async()=>{
            const res=await request("/me/identities/"+provider+"/link","POST",{});
            if(res.redirect_url) location.assign(res.redirect_url);
            else refreshAll();
          }}>Link {provider==="google"?"Google":"Microsoft"}</Action>)}
      </div>
    </Panel>
    <Panel title="Primary contact &amp; sign-in email">
      <p>Current primary email: <strong>{primaryEmail}</strong></p>
      {emailChange?<div className="code-step">
        <p>Verify both your current email (<strong>{primaryEmail}</strong>) and new email (<strong>{emailChange.new_email}</strong>).</p>
        {(emailChange.current_demo_code||emailChange.new_demo_code)&&<p className="small">
          Current code: <span className="code">{emailChange.current_demo_code}</span> · New code: <span className="code">{emailChange.new_demo_code}</span>
        </p>}
        <Form key={emailChange.new_challenge_id} label="Confirm email change" run={async f=>{
          await request("/me/email-change/confirm","POST",{
            current_challenge_id:emailChange.current_challenge_id,
            current_code:text(f,"current_code"),
            new_challenge_id:emailChange.new_challenge_id,
            new_code:text(f,"new_code"),
          });
          setEmailChange(undefined);refreshAll();
        }}>
          <Field name="current_code" label="Code sent to current email"/>
          <Field name="new_code" label="Code sent to new email"/>
        </Form>
        <button type="button" onClick={()=>setEmailChange(undefined)}>Cancel email change</button>
      </div>:<Form label="Send verification codes" run={async f=>{
        const newEmail=text(f,"new_email");
        const res=await request("/me/email-change/request","POST",{new_email:newEmail});
        setEmailChange({new_email:newEmail,...res});
      }}>
        <Field name="new_email" label="New primary email address" type="email"/>
      </Form>}
    </Panel>
    <Panel title="Active device sessions">
      <Table headers={["Session","Created","Last active","Expires",""]} rows={(sessions.data?.sessions??[]).map((s:Row)=>[
        s.current?<strong>Current device</strong>:"Signed-in device",
        stamp(s.created_at),stamp(s.last_seen_at),stamp(s.expires_at),
        !s.current?<Action run={async()=>{await request("/me/sessions/"+s.id,"DELETE",{});sessions.reload();}}>Revoke</Action>:null
      ])} empty="No active sessions."/>
      {(sessions.data?.sessions??[]).some((s:Row)=>!s.current)&&<Action run={async()=>{
        await request("/me/sessions/revoke-others","POST",{});sessions.reload();
      }}>Sign out all other devices</Action>}
    </Panel>
    <Panel title="Privacy, data export &amp; retention policy">
      <p className="muted">Download a machine-readable archive of your account, orders, items, charges, and consent records, or submit a formal privacy request.</p>
      <div className="actions">
        <a className="button" href="/api/v1/me/privacy/export" target="_blank" rel="noreferrer">Download personal data JSON</a>
        <Action run={async()=>{
          await request("/me/privacy/requests","POST",{kind:"export",note:"Customer requested personal data archive"});
          refreshAll();
        }}>Request formal data export</Action>
        <Action run={async()=>{
          await request("/me/privacy/requests","POST",{kind:"deletion",note:"Customer requested account deletion review"});
          refreshAll();
        }}>Request data deletion review</Action>
      </div>
    </Panel>
    <Panel title="Close account">
      <p className="muted">You can close your account when there are no active orders, stored warehouse items, or unpaid charges. Historical audit and financial records are retained per policy.</p>
      <Action run={async()=>{
        await request("/me/account/close","POST",{});
        location.assign("/login");
      }}>Close my account</Action>
    </Panel>
  </>;
}

function FulfillmentQuote({quote,onUpdate,onOpenBatch}:{quote:Row;onUpdate?:()=>void;onOpenBatch?:(batchId:string)=>void}) {
  const shipping=quote.purpose==="dispatch";
  const {snapshot}=quote;
  const purpose=shipping?({return_to_seller:"Return to seller",to_forwarder:"Send to freight forwarder",to_domestic_address:"Domestic delivery"} as Record<string,string>)[quote.action]:"Extend storage";
  return <article id={"quote-"+quote.id} className="card fulfillment-quote">
    <div className="row"><div><h3>{purpose}</h3><small>Quote {quote.revision} · expires {stamp(quote.expires_at)}</small></div>
      <div className="actions">
        {shipping&&quote.batch_id&&onOpenBatch&&<CodeButton code={`Batch #${String(quote.batch_id).slice(0,8)} · Inspect / Amend`} onClick={()=>onOpenBatch(quote.batch_id)}/>}
        <strong>{usd(quote.amount_cents)}</strong>
      </div>
    </div>
    {shipping?<>
      <p><strong>Destination</strong> · {snapshot.destination.recipient} · {snapshot.destination.address}
        {snapshot.destination.member_code&&<> · Member {snapshot.destination.member_code}</>}</p>
      <Table headers={["Parcel","Warehouse item codes","Weight","Shipping"]} rows={snapshot.parcels.map((parcel:Row,i:number)=>[
        i+1,<span className="code">{parcel.item_ids.map((id:string)=>quote.item_codes?.[id]??id).join(", ")}</span>,
        parcel.weight_g+" g",usd(parcel.amount_cents),
      ])}/>
      <p>Handling · {usd(snapshot.handling_cents)}</p>
    </>:<p>{snapshot.days} additional days · <span className="code">{Object.values(quote.item_codes).join(", ")}</span></p>}
    {(quote.state===undefined||quote.state==="open")&&<Action primary run={async()=>{
      const charge=await request("/quotes/"+quote.id+"/accept","POST",{revision:quote.revision});
      try {await goCheckout(charge.charge_item_id,quote.revision);} finally {onUpdate?.();}
    }}>Accept and pay</Action>}
    {quote.state==="accepted"&&quote.charge_id&&<Action primary run={()=>goCheckout(quote.charge_id,quote.revision)}>Resume payment</Action>}
    {quote.state==="processing"&&<p role="status">Payment is processing.</p>}
    {quote.state==="paid"&&<Tag>Payment confirmed</Tag>}
    {quote.state==="expired"&&<p className="notice">This quote has expired. Review the latest quote from your order when the warehouse issues it.</p>}
    {quote.state==="inactive"&&<Empty>This quote is closed.</Empty>}
  </article>;
}

const handlingStates=["report_ready","action_pending","cancelled","closed"];
function needsHandling(item:Row) {
  return ["report_ready","action_pending"].includes(item.order_state)&&item.allowed_actions.includes("request_disposition")
    &&!item.active_disposition&&!(item.reference_sample?.state==="pending_safe_storage"||
      item.reference_sample?.state==="active"&&!item.reference_sample.expired);
}

const actionTitles:Record<string,string>={
  manual_quote_ready:"Review your inspection quote",report_ready:"Choose how to handle inspected items",action_pending:"Choose how to handle inspected items",
  draft:"Continue inspection draft",awaiting_payment:"Review inspection payment",awaiting_samples:"Register seller tracking",
  return_to_seller:"Review seller return quote",to_forwarder:"Review forwarding quote",to_domestic_address:"Review domestic shipping quote",
  retain:"Review storage extension",needs_carrier:"Confirm parcel carrier",needs_verification:"Verify parcel tracking",waiting_customer:"Review support case",
  dispatch:"Review shipping payment",storage:"Review storage payment",
  bounced:"We couldn't deliver email to this address",complained:"We couldn't deliver email to this address",
  reference_expired:"Update expired reference sample",reference_conflict:"Resolve reference sample in use before shipping",
  storage_expiring:"Storage expiring soon — choose handling or extend",storage_expired:"Storage expired — choose handling or extend",
};
function customerActionHref(row:Row) {
  const base="/orders/"+row.reference;
  if(row.kind==="inspection_quote") return base+"#inspection-quote";
  if(row.kind==="order") {
    if(row.state==="draft") return "/orders/new?draft="+encodeURIComponent(row.reference);
    if(row.state==="awaiting_payment") return base+"/payment";
    if(row.state==="awaiting_samples") return base+"/parcels";
    return base+"/dispositions";
  }
  if(row.kind==="parcel") return "/parcels/"+row.id;
  if(row.kind==="quote"||row.kind==="charge") return "/account/billing#"+row.kind+"-"+row.id;
  if(row.kind==="scope") return base+"#scope-"+row.id;
  if(row.kind==="reference"||row.kind==="storage") return "/items#item-"+row.reference;
  if(row.kind==="email") return "/account/security";
  return "/support/cases/"+row.id;
}

export function CustomerActions() {
  const {data,error,reload}=useLoad("/actions");
  return <>
    <div className="page-head row"><div><p className="eyebrow">CLIENT WORKSPACE / ACTIONS</p><h1>Action required</h1>
      <p className="muted">Continue work that needs your input. Quotes with deadlines are shown first.</p></div>
      <button type="button" onClick={reload}>Refresh actions</button></div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">Loading actions…</p>}
    {data&&!error&&<Panel title="Your next actions"><Table headers={["Action","Reference","Due",""]} rows={data.rows.map((row:Row)=>{
      const href=customerActionHref(row);
      return [row.kind==="scope"?"Review inspection scope":actionTitles[row.state]??"Review action",row.reference?<span className="code">{row.reference}</span>:"—",stamp(row.due_at),<Link href={href}>Open</Link>];
    })} empty="You’re all caught up. New actions will appear here when an order, parcel, quote or case needs your input."/></Panel>}
  </>;
}

function InboundParcelForm({address,carriers,orderId,orders=[],preferredOrder,onSave}:{
  address:Row|null;carriers:Row[];orderId?:string;orders?:Row[];preferredOrder?:string|null;onSave:()=>void;
}) {
  const [saved,setSaved]=useState<string>();
  if(!address)return <Empty>The warehouse address is awaiting configuration.</Empty>;
  return <>
    <Form key={saved} label="Add inbound parcel" run={async f=>{
      const carrier=text(f,"carrier"),order=orderId??text(f,"order");
      const tracking=text(f,"tracking");
      await request("/me/parcels","POST",{address_id:address.id,tracking_no:tracking,
        ...(carrier?{carrier_code:carrier}:{}),order_ids:order?[order]:[]});
      setSaved(tracking);onSave();
    }}><Field name="tracking" label="Seller’s tracking number"/>
      <Select name="carrier" label="Carrier" required={false} choices={carriers.map(c=>({id:c.code,label:c.labels.en}))}/>
      {!orderId&&<Select key={preferredOrder} name="order" label="Associate an order (optional)" required={false}
        value={orders.some(o=>o.id===preferredOrder)?preferredOrder??undefined:undefined}
        choices={orders.map(o=>({id:o.id,label:o.public_no}))}/>}
    </Form>
    {saved&&<p className="notice" role="status">Registered seller tracking <strong className="code">{saved}</strong>.</p>}
  </>;
}

function ItemInstructionForm({items,orderId,storage=false,recentDestinations=[],onSave}:{
  items:Row[];orderId?:string;storage?:boolean;recentDestinations?:Row[];onSave:()=>void;
}) {
  const terms=useLoad("/public/terms");
  const [action,setAction]=useState(storage?"retain":"return_to_seller");
  const [selectedIds,setSelectedIds]=useState<string[]>(()=>items[0]?.item_id?[items[0].item_id]:[]);
  const [recipient,setRecipient]=useState("");
  const [phone,setPhone]=useState("");
  const [address,setAddress]=useState("");
  const [memberCode,setMemberCode]=useState("");
  const [savedNotice,setSavedNotice]=useState<string>();
  const [formKey,setFormKey]=useState(0);
  useEffect(()=>{
    setSelectedIds(prev=>{
      const valid=prev.filter(id=>items.some(row=>row.item_id===id));
      if(valid.length>0) return valid;
      return items[0]?.item_id?[items[0].item_id]:[];
    });
  },[items.map(i=>i.item_id).join(",")]);
  const currentAction=storage?"retain":action;
  const needsDestination=!["retain","reserve_reference"].includes(currentAction);
  const termsId=terms.data?.terms.find((t:Row)=>t.kind==="terms")?.id;
  if(!items.length)return <Empty>No items are available for a new instruction.</Empty>;
  if(terms.error)return <ErrorBlock error={terms.error}/>;
  if(!termsId)return <p role="status">Waiting for the current service terms.</p>;
  return <>
    <Form key={formKey} label={storage?`Request storage extension${selectedIds.length>1?` (${selectedIds.length} items)`:""}`:`Save handling instruction${selectedIds.length>1?` (${selectedIds.length} items)`:""}`} run={async f=>{
      const chosen=items.filter(row=>selectedIds.includes(row.item_id));
      if(!chosen.length||!checked(f,"agree"))throw new Error("Select at least one item and confirm the instruction.");
      const destination=needsDestination?{
        recipient:recipient.trim()||text(f,"recipient"),
        phone:phone.trim()||text(f,"phone"),
        address:address.trim()||text(f,"address"),
        ...(currentAction==="to_forwarder"?{member_code:memberCode.trim()||text(f,"member_code")}:{}),
      }:undefined;
      const deadline=text(f,"deadline");
      const retainDays=currentAction==="retain"?Number(text(f,"days")||30):undefined;
      const recorded:string[]=[];
      try {
        for(const item of chosen) {
          await request(orderId?"/orders/"+orderId+"/dispositions":"/me/items/"+item.item_id+"/dispositions","POST",{
          ...(orderId?{item_id:item.item_id}:{}),action:currentAction,terms_version_id:termsId,...(destination?{destination}:{}),
          ...(retainDays?{days:retainDays}:{}),
          ...(currentAction==="return_to_seller"?{return_info:{requested_from_seller:true,customer_pays_shipping:true,
            ...(deadline?{deadline:new Date(deadline).toISOString()}:{})}}:{}),
          });
          recorded.push(item.code);
        }
      } catch(error) {
        if(recorded.length) {
          setSavedNotice("Instructions recorded for "+recorded.join(", ")+".");
          onSave();
        }
        throw error;
      }
      setSavedNotice(`Recorded instruction for ${chosen.length} ${chosen.length===1?"item":"items"} (${chosen.map(c=>c.code).join(", ")}).`);
      setFormKey(k=>k+1);
      onSave();
    }}>
      {items.length===1?(
        <div><small className="muted">Selected item</small><div><strong className="code">{items[0].code}</strong></div></div>
      ):(
        <div>
          <div className="row">
            <span className="small"><strong>Items ({selectedIds.length} of {items.length} selected)</strong></span>
            <div className="actions">
              <button type="button" className="button sm" onClick={()=>setSelectedIds(items.map(i=>i.item_id))}>Select all ({items.length})</button>
              <button type="button" className="button sm" onClick={()=>setSelectedIds(items[0]?.item_id?[items[0].item_id]:[])}>Select first only</button>
            </div>
          </div>
          <div className="role-grid" style={{marginTop:6}}>
            {items.map(item=><label key={item.item_id} className={"role-chip"+(selectedIds.includes(item.item_id)?" on":"")}>
              <input
                type="checkbox"
                checked={selectedIds.includes(item.item_id)}
                onChange={e=>setSelectedIds(cur=>e.target.checked?[...cur,item.item_id]:cur.filter(x=>x!==item.item_id))}
              />
              <span><strong className="code">{item.code}</strong><small>{item.order_no?`Order ${item.order_no}`:"Uncommissioned"}</small></span>
            </label>)}
          </div>
        </div>
      )}
      {!storage&&<label>Requested action<select value={action} onChange={e=>setAction(e.target.value)}>
        <option value="return_to_seller">Return to seller</option><option value="to_forwarder">Send to freight forwarder</option>
        <option value="to_domestic_address">Send to a domestic address</option><option value="retain">Extend storage</option>
        <option value="reserve_reference">Reserve as reference sample (90 days)</option></select></label>}
      {currentAction==="retain"&&<Field name="days" label="Additional storage days" type="number" value={30}/>}
      {needsDestination&&<>
        {recentDestinations.length>0&&<label>Quick-fill from saved / recent addresses (optional)
          <select defaultValue="" onChange={e=>{
            const idx=Number(e.target.value);
            const picked=Number.isInteger(idx)&&idx>=0?recentDestinations[idx]:null;
            if(!picked) return;
            setRecipient(String(picked.recipient??""));
            setPhone(String(picked.phone??""));
            setAddress(String(picked.address??""));
            setMemberCode(String(picked.member_code??""));
          }}>
            <option value="">— Choose a recent recipient &amp; address —</option>
            {recentDestinations.map((d:Row,idx:number)=><option key={idx} value={String(idx)}>
              {d.recipient} · {d.phone} · {String(d.address??"").slice(0,48)}{d.member_code?` (Member ${d.member_code})`:""}
            </option>)}
          </select>
        </label>}
        <label>Recipient<input name="recipient" required value={recipient} onChange={e=>setRecipient(e.target.value)}/></label>
        <label>Destination phone<input name="phone" required value={phone} onChange={e=>setPhone(e.target.value)}/></label>
        <label>{currentAction==="return_to_seller"?"Return address supplied by your seller":"Destination address"}<textarea name="address" required value={address} onChange={e=>setAddress(e.target.value)}/></label>
      </>}
      {currentAction==="to_forwarder"&&<label>Forwarder member code<input name="member_code" required value={memberCode} onChange={e=>setMemberCode(e.target.value)}/></label>}
      {currentAction==="return_to_seller"&&<Field name="deadline" label="Seller’s return deadline (your local time)" type="datetime-local" required={false}/>}
      <label className="check"><input name="agree" required type="checkbox"/>{currentAction==="return_to_seller"?
        "I have arranged the return with my seller and will pay the return shipping fee.":"I authorize this request subject to the current terms and quote."}</label>
    </Form>
    {savedNotice&&<p className="notice" role="status">{savedNotice}</p>}
  </>;
}

function OrderHandling({
  order,storage,onSave,onOpenTracking,onOpenItem,onOpenBatch,
}:{
  order:Row;storage:boolean;onSave:()=>void;
  onOpenTracking?:(t:CustomerTrackingTarget)=>void;
  onOpenItem?:(item:Row)=>void;
  onOpenBatch?:(batchId:string)=>void;
}) {
  const desk=useLoad("/me/desk");
  const [selected,setSelected]=useState<string[]>([]);
  const items:Row[]=order.items.filter((item:Row)=>item.item_id);
  const allowed=["report_ready","action_pending","cancelled","closed"].includes(order.state);
  const eligible=allowed?items.filter(item=>!item.instruction&&["stored","received"].includes(item.custody_state)):[];
  const awaiting=items.filter(item=>item.instruction?.awaiting_batch);
  const selection=selected.filter(id=>awaiting.some(item=>item.instruction.id===id));
  return <>
    <Panel title={storage?"Storage by item":"Instructions by item"}>
      <Table headers={["Item","Warehouse status","Storage through","Paid through","Active instruction"]} rows={items.map(item=>[
        onOpenItem?<CodeButton code={item.code} onClick={()=>onOpenItem({...item,order_no:order.public_no})}/>:<span className="code">{item.code}</span>,
        label(item.custody_state),stamp(item.storage_until),stamp(item.paid_storage_until),
        item.instruction?<div className="actions"><Tag>{label(item.instruction.action)}</Tag>{!storage&&item.instruction.awaiting_batch&&
          <label className="small"><input type="checkbox" checked={selection.includes(item.instruction.id)} onChange={e=>
            setSelected(current=>e.target.checked?[...current,item.instruction.id]:current.filter(id=>id!==item.instruction.id))}/> Select for shipping</label>}
          {item.instruction.state==="requested"&&<Action run={async()=>{
            await request("/me/dispositions/"+item.instruction.id+"/cancel","POST",{});onSave();
          }}>Cancel</Action>}</div>:"—",
      ])} empty="No warehouse items are linked to this inspection."/>
      {!storage&&selection.length>0&&<Action primary run={async()=>{
        const batch=await request("/dispatch-batches","POST",{disposition_ids:selection});
        setSelected([]);onSave();
        await request("/dispatch-batches/"+batch.batch_id+"/confirm","POST",{revision:batch.revision});
        onSave();
      }}>Confirm selected items for quoting ({selection.length})</Action>}
      <p><Link href={storage?"/orders/"+order.public_no+"/dispositions":"/account/billing"}>{storage?"Review other handling options":"Open shipping and storage quotes"}</Link></p>
      {!storage&&<p className="muted">Use the account’s warehouse items page to combine eligible items across your orders or amend an unshipped batch.</p>}
    </Panel>
    <Panel title={storage?"Storage quotes":"Shipping and storage quotes"}>
      <Table headers={["Action","Batch","Quote version","Amount","Status","Expires"]} rows={order.quotes.filter((q:Row)=>!storage||q.purpose==="storage").map((q:Row)=>[
        label(q.action),
        q.batch_id&&onOpenBatch?<CodeButton code={`#${String(q.batch_id).slice(0,8)}`} onClick={()=>onOpenBatch(q.batch_id)}/>:"—",
        <Link href={"/orders/"+order.public_no+"/quotes/"+q.id}>Version {q.revision}</Link>,
        usd(q.amount_cents),
        <Tag>{label(q.state)}</Tag>,
        stamp(q.expires_at),
      ])} empty="No fulfillment quotes are linked to this inspection."/>
    </Panel>
    <Panel title={storage?"Request more storage time":"Give the warehouse an instruction"}>
      {!allowed?<Empty>Item handling becomes available after the inspection is complete or cancelled.</Empty>:
        <ItemInstructionForm
          key={String(storage)}
          items={eligible.map(i=>({...i,order_no:order.public_no}))}
          orderId={order.id}
          storage={storage}
          recentDestinations={desk.data?.recent_destinations??[]}
          onSave={onSave}
        />}
    </Panel>
    {!storage&&<Panel title="Parcels handed over to a carrier">
      <Table headers={["Handling","Actual tracking number","Batch","Warehouse handover",""]} rows={order.shipments.map((shipment:Row)=>[
        label(shipment.action),
        onOpenTracking?<CodeButton code={shipment.tracking_norm} onClick={()=>onOpenTracking({kind:"shipments",id:shipment.id,code:shipment.tracking_norm})}/>:<Link className="code" href={"/orders/"+order.public_no+"/shipments/"+shipment.id}>{shipment.tracking_norm}</Link>,
        shipment.batch_id&&onOpenBatch?<CodeButton code={`#${String(shipment.batch_id).slice(0,8)}`} onClick={()=>onOpenBatch(shipment.batch_id)}/>:"—",
        stamp(shipment.shipped_at),
        <Link className="small" href={"/orders/"+order.public_no+"/shipments/"+shipment.id}>Details →</Link>,
      ])} empty="The warehouse has not handed over any parcels linked to this order."/>
    </Panel>}
  </>;
}

export function OrderFulfillment({order,id,kind}:{order:string;id:string;kind:"quotes"|"shipments"}) {
  const lookup=useLoad("/orders/by-number/"+order);
  const record=useLoad(lookup.data?"/orders/"+lookup.data.id+"/"+kind+"/"+id:null);
  const data=record.data;
  const error=lookup.error||record.error;
  const destination=data?.destination_snapshot;
  return <>
    <div className="page-head"><Link href={"/orders/"+order+"/dispositions"}>← Order item instructions</Link>
      <p className="eyebrow report-eyebrow">CLIENT WORKSPACE / FULFILLMENT</p>
      <h1>{kind==="quotes"?"Fulfillment quote":"Shipment details"}</h1><p className="code">{order}</p></div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">Loading the order record…</p>}
    {data&&kind==="quotes"&&<FulfillmentQuote quote={data} onUpdate={record.reload}/>}
    {data&&kind==="shipments"&&<>
      <Panel title="Warehouse handover">
        <dl className="location-facts">
          <div><dt>Handling</dt><dd>{label(data.action)}</dd></div>
          <div><dt>Tracking number</dt><dd className="code">{data.tracking_norm}</dd></div>
          <div><dt>Handed to carrier</dt><dd>{stamp(data.shipped_at)}</dd></div>
          <div><dt>Recorded weight</dt><dd>{data.weight_g} g</dd></div>
          <div><dt>Destination</dt><dd>{destination.recipient} · {destination.address}{destination.member_code?" · "+destination.member_code:""}</dd></div>
        </dl>
        <Table headers={["Item code","Returned to warehouse"]} rows={(data.items??[]).map((item:Row)=>[
          <span className="code">{item.code}</span>,stamp(item.returned_at),
        ])}/>
      </Panel>
      <TrackView kind="shipments" id={id} embedded/>
    </>}
  </>;
}
