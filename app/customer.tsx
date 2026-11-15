"use client";

import Link from "next/link";
import { ScopeReview } from "./scope-review";
import { ReportShares } from "./report-sharing";
import { RecentUpdates } from "./notifications";
import { ParcelOwnershipReviews } from "./ticket-desk";
import { categoryIconName, PlatformIcon } from "./chrome";
import { ApparelIllustration } from "./report-guide";
import { CategoryTiles, matchShowcaseCategoryOffer, SHOWCASE_CATEGORIES } from "./category-coverage";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  deriveExpectedLinesFromServerLine, draftRecoveryKey, expandExpectedLinesToDraftItems, missingLineFields,
  normalizeTrackingCode, parseStructuredPurchaseText, readDraftRecovery, removeDraftRecovery, sha256FileHex,
  sumExpectedLineQuantity, writeDraftRecovery,
  type DraftEditor, type DraftRecovery, type ExpectedProductLine, type ExtractedCandidateLine,
  type ParcelMode, type PlannedParcelEntry, type PurchaseEvidenceItem,
} from "./draft-recovery";
import { conditionMatches } from "../packages/core/template-conditions";
import { sumMeasurements } from "../packages/core/measurement-decimals";
import { billingChargePath, billingQuotePath, customerDestination, inspectionScopePath, legalPages, orderSections, type OrderSection, servicePages } from "../packages/core/portal-routes";
import { Action, checked, CodeButton, Empty, ErrorBlock, Field, Form, MediaLightbox, ModalDrawer, Panel, Photo, QuoteCountdown, request, RequestError, Select, useWorkspaceStamp, Table, Tabs, Tag, text, useLoad, usd, type Row } from "./ui";

const acknowledged={scope_notice:"I understand which checks are included.",samples_not_batch:"These samples do not represent an entire production batch.",seller_refund_is_mine:"I handle any refund request directly with my seller.",no_certification:"The report is an inspection record and does not provide certification.",restricted_items:"My items comply with the restricted items policy."};
const states:Record<string,string>={
  checked_in:"Received at warehouse",awaiting_warehouse:"Awaiting warehouse check-in",samples_ready:"Samples ready",
  pending_safe_storage:"Pending safe storage",draft:"Draft",awaiting_payment:"Awaiting payment",awaiting_samples:"Awaiting items",
  queued:"Ready for inspection",inspecting:"Inspection underway",qa_review:"Under review",report_ready:"Report ready",
  action_pending:"Awaiting disposition",cancelled:"Cancelled",closed:"Closed",on_hold:"On hold",stored:"In storage",
  waiting_customer:"Awaiting your reply",waiting_internal:"With support",identity_unclear:"Parcel ownership review",
  non_standard_quote:"General inquiry",not_due:"Not due",needs_verification:"Verification needed",needs_carrier:"Carrier needed",
  reconciliation:"Payment status to verify",
};
const label=(state:string|null|undefined)=>state?states[state]??(state.charAt(0).toUpperCase()+state.slice(1).replaceAll("_"," ")):"—";
const itemInspectionLabel=(item:Row)=>item.inspection_stage==="inspected"?"Inspection complete":item.inspection_stage==="in_inspection"?"Inspection underway":
  item.inspection_stage==="pending"||["awaiting_samples","samples_ready","queued","inspecting","qa_review"].includes(item.order_state)?"Awaiting inspection":
  item.order_no?"No active inspection":"Not commissioned";
const parcelLinkStates=["draft","awaiting_payment","awaiting_samples","on_hold"];
const orderNext:Record<string,string>={
  draft:"Review the inspection scope and calculate a quote.",
  awaiting_payment:"Review or resume the inspection payment.",
  awaiting_samples:"Inspection starts after all commissioned items are received and identified.",
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
  ...SHOWCASE_CATEGORIES.map(c=>({
    id:c.key,
    name:c.name,
    state:c.fallbackState,
    desc:c.desc,
    slugs:c.slugs,
    labels:c.labels,
    icon:categoryIconName(c.key),
  })),
  {id:"toys",name:"Toys & Children’s Products",state:"RESTRICTED",desc:"Safety-critical checks require separate capability review",slugs:["toys"],labels:["Toys","Toys & Children’s Products"],icon:categoryIconName("toys")},
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

  const matchedCatIds=new Set<string>();
  const baseCategoryCards=prototypeCategories.map(c=>{
    const liveOffer=allOffers.find((o:Row)=>matchShowcaseCategoryOffer({key:c.id as "apparel",slugs:c.slugs,labels:c.labels},o,c.name));
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
      icon:categoryIconName(`${o.category_slug??""} ${o.category?.en??""}`),
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
              <div className="glyph" aria-hidden="true"><PlatformIcon name={c.icon}/></div>
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
        {Object.entries(servicePages).map(([href,code])=><Link className="land-svc" href={href} key={href}><span className="symbol"><PlatformIcon name={code==="compare"?"service_compare":code==="inspection"?"service_inspection":"service_reference"}/></span>
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
const wizardCategoryCatalog=SHOWCASE_CATEGORIES.map(c=>({
  key:c.key,
  name:c.name,
  slugs:c.slugs,
  labels:c.labels,
  icon:categoryIconName(c.key),
  fallbackState:c.fallbackState,
}));

const wizardServiceCards=[
  {
    service:"inspection",
    title:"Product Inspection",
    desc:"Check individual items for measurements, workmanship, labels, and visible defects.",
    unitLabel:"Per item",
    icon:"service_inspection",
  },
  {
    service:"compare",
    title:"Sample Comparison",
    desc:"Compare 2 or 3 supplier samples side-by-side under the exact same checklist and camera angles.",
    unitLabel:"2 or 3 sample package",
    icon:"service_compare",
  },
  {
    service:"reference_match",
    title:"Golden Sample Matching",
    desc:"Check new restock or pre-shipment items against your sealed, approved reference sample in our vault.",
    unitLabel:"Per candidate item",
    icon:"service_reference",
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

export function NewOrder({customerId}:{customerId:string}) {
  const stamp=useWorkspaceStamp();
  const {data,error,reload:reloadCatalog}=useLoad("/catalog");
  const refs=useLoad("/me/reference-samples");
  const desk=useLoad("/me/desk?include_activity=0");
  const receiving=useLoad("/me/receiving-address");
  const terms=useLoad("/public/terms");

  const [step,setStep]=useState(0);
  const stepPanel=useRef<HTMLDivElement>(null);
  const previousStep=useRef(step);
  useEffect(()=>{
    if(previousStep.current!==step) {
      window.scrollTo({top:0,behavior:"smooth"});
    }
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
  const [expectedLines,setExpectedLines]=useState<ExpectedProductLine[]>([]);
  const [expectedUndoStack,setExpectedUndoStack]=useState<ExpectedProductLine[][]>([]);
  const [purchaseEvidences,setPurchaseEvidences]=useState<PurchaseEvidenceItem[]>([]);
  const [plannedParcels,setPlannedParcels]=useState<PlannedParcelEntry[]>([]);
  const [parcelMode,setParcelMode]=useState<ParcelMode>("single");
  const [syncQuantityFromLines,setSyncQuantityFromLines]=useState(true);
  const [showMatrixBuilder,setShowMatrixBuilder]=useState(false);
  const [matrixProductName,setMatrixProductName]=useState("");
  const [matrixSkuPrefix,setMatrixSkuPrefix]=useState("");
  const [matrixColors,setMatrixColors]=useState("Black, Gray");
  const [matrixSizes,setMatrixSizes]=useState("M, L, XL");
  const [matrixDefaultQty,setMatrixDefaultQty]=useState(8);
  const [matrixSupplier,setMatrixSupplier]=useState("");
  const [showPasteImport,setShowPasteImport]=useState(false);
  const [pasteImportText,setPasteImportText]=useState("");
  const [pasteSupplier,setPasteSupplier]=useState("");
  const [pastePoRef,setPastePoRef]=useState("");
  const [pasteTracking,setPasteTracking]=useState("");
  const [evidenceDuplicateWarning,setEvidenceDuplicateWarning]=useState("");
  const [showAdvancedUnits,setShowAdvancedUnits]=useState(false);
  const [bulkSupplierInput,setBulkSupplierInput]=useState("");
  const [bulkTrackingInput,setBulkTrackingInput]=useState("");
  const [itemPage,setItemPage]=useState(0);
  const [showFullChecklist,setShowFullChecklist]=useState(false);
  const [notes,setNotes]=useState("");
  const [attachmentId,setAttachmentId]=useState<string>();
  const [attachmentName,setAttachmentName]=useState<string>();
  const [attachmentPurpose,setAttachmentPurpose]=useState<"reference_photo"|"size_chart">("reference_photo");
  const [attachmentSha256,setAttachmentSha256]=useState<string>();
  const [extraLines,setExtraLines]=useState<Row[]>([]);
  const [addingServiceLine,setAddingServiceLine]=useState(false);
  const [consents,setConsents]=useState<Record<string,boolean>>({});
  const [policyAccepted,setPolicyAccepted]=useState(false);
  const [quotedFingerprint,setQuotedFingerprint]=useState("");
  const [quoteExpired,setQuoteExpired]=useState(false);
  const draftWrite=useRef<{fingerprint:string;key:string}>(null);
  const savedFingerprint=useRef("");
  const quoteWrite=useRef<{revision:number;key:string}>(null);
  const submitKey=useRef("");
  const inFlight=useRef(false);
  const autoSaveTask=useRef<Promise<unknown>|null>(null);
  const [draftOrder,setDraftOrder]=useState<Row>();
  const [serverQuote,setServerQuote]=useState<Row>();
  const [submittedCharge,setSubmittedCharge]=useState<Row>();
  const [busyMessage,setBusyMessage]=useState("");
  const [savedNotice,setSavedNotice]=useState("");
  const [serviceSwitchBanner,setServiceSwitchBanner]=useState("");
  const [wizardError,setWizardError]=useState("");

  const offers:Row[]=data?.offers??[];

  // Match prototype category key or dynamic category_id to real backend category_id
  function matchesCategoryOffer(key:string,offer:Row,name?:string) {
    const spec=SHOWCASE_CATEGORIES.find(c=>c.key===key);
    if(spec) return matchShowcaseCategoryOffer(spec,offer,name);
    const catId=String(offer.category_id??"").toLowerCase();
    const slug=String(offer.category_slug??"").toLowerCase();
    const en=String(offer.category?.en??"").toLowerCase();
    return catId===key.toLowerCase()||slug===key.toLowerCase()||
      (Boolean(en)&&(en===key.toLowerCase()||(name!==undefined&&en===name.toLowerCase())));
  }
  function resolveCategoryId(key:string):string|undefined {
    return offers.find(offer=>matchesCategoryOffer(key,offer))?.category_id;
  }

  const catalogCategories=[...new Map(offers.map(offer=>[offer.category_id,offer])).values()];
  const wizardCategories:{key:string;name:string;icon:string;fallbackState:string}[]=wizardCategoryCatalog.filter(category=>
    resolveCategoryId(category.key)||!catalogCategories.some(offer=>offer.category?.en?.toLowerCase()===category.name.toLowerCase())
  ).map(category=>({...category,name:catalogCategories.find(offer=>matchesCategoryOffer(category.key,offer,category.name))?.category?.en??category.name}));
  for(const offer of catalogCategories) {
    if(!wizardCategories.some(category=>matchesCategoryOffer(category.key,offer,category.name))) {
      wizardCategories.push({key:offer.category_slug??offer.category_id,name:offer.category?.en??"Available category",icon:categoryIconName(`${offer.category_slug??""} ${offer.category?.en??""}`),fallbackState:"ACTIVE"});
    }
  }

  const [recoveryKey,setRecoveryKey]=useState("");
  const [recoveryReady,setRecoveryReady]=useState(false);
  const [draftLoadFailed,setDraftLoadFailed]=useState(false);
  const [conflict,setConflict]=useState<DraftRecovery|null>(null);
  const [reviewingConflict,setReviewingConflict]=useState(false);
  const originalEditor=useRef<string|null|undefined>(undefined);
  const hasRecoveredEditor=useRef(false);
  const serverEditor=useRef(false);

  function restoreEditor(editor:DraftEditor) {
    setStep(Math.min(editor.step,4));
    setCategoryKey(editor.categoryKey);
    setServiceKind(editor.serviceKind);
    setSelectedOfferId(editor.selectedOfferId);
    setTemplateVariant(editor.templateVariant);
    setQty(editor.qty);
    setManualQuoteMode(editor.manualQuoteMode);
    setManualBatchQty(editor.manualBatchQty);
    setManualQuoteReason(editor.manualQuoteReason);
    setItemName(editor.itemName);
    setSupplierRef(editor.supplierRef);
    setBaseSku(editor.baseSku);
    setBaseColor(editor.baseColor);
    setBaseSize(editor.baseSize);
    setBaseTrackingNo(editor.baseTrackingNo);
    setProductLink(editor.productLink);
    setToleranceMode(editor.toleranceMode);
    setPointTolerances(editor.pointTolerances);
    setReferenceId(editor.referenceId);
    setSizeMismatchConfirmed(editor.sizeMismatchConfirmed);
    setItemRows(editor.itemRows);
    setExpectedLines(Array.isArray(editor.expectedLines)?editor.expectedLines:[]);
    setExpectedUndoStack([]);
    setPurchaseEvidences(Array.isArray(editor.purchaseEvidences)?editor.purchaseEvidences:[]);
    setPlannedParcels(Array.isArray(editor.plannedParcels)?editor.plannedParcels:[]);
    setParcelMode(editor.parcelMode??"single");
    setSyncQuantityFromLines(editor.syncQuantityFromLines??true);
    setNotes(editor.notes);
    setAttachmentId(editor.attachmentId);
    setAttachmentName(editor.attachmentName);
    setAttachmentPurpose(editor.attachmentPurpose??"reference_photo");
    setAttachmentSha256(editor.attachmentSha256);
    setExtraLines(editor.extraLines);
    setAddingServiceLine(editor.addingServiceLine??false);
  }

  function restoreServiceLine(line:Row) {
    const offer=offers.find(row=>row.offer_id===line.offer_id);
    setCategoryKey(offer?.category_slug??line.category_id);
    setSelectedOfferId(line.offer_id);
    setServiceKind(offer?.service??line.service??"inspection");
    setTemplateVariant(offer?templateVariantFor(offer):"basic");
    setQty(Number(line.quantity));
    const attrs=line.attributes??{};
    setItemName(String(attrs.name??""));
    setSupplierRef(String(attrs.supplier_ref??attrs.supplier_alias??""));
    setBaseSku(String(attrs.sample_code_prefix??"ITEM"));
    setBaseTrackingNo(String(attrs.tracking_no??""));
    setBaseSize(String(attrs.size_label??""));
    setBaseColor(String(attrs.color_declared??""));
    setProductLink(String(attrs.product_url??""));
    setAttachmentId(attrs.attachment_ids?.[0]);
    setAttachmentName(attrs.attachment_name?String(attrs.attachment_name):(attrs.attachment_ids?.[0]?"Saved reference photo":undefined));
    setAttachmentPurpose(attrs.attachment_purpose==="size_chart"?"size_chart":"reference_photo");
    setAttachmentSha256(attrs.attachment_sha256?String(attrs.attachment_sha256):undefined);
    setSizeMismatchConfirmed(line.options?.size_mismatch_confirmed===true);
    setReferenceId(String(line.options?.reference_id??""));
    const restored:Record<string,{target:string;plusMinus:string}>={};
    for(const t of Array.isArray(attrs.tolerances)?attrs.tolerances:[]) {
      const min=Number(t.min),max=Number(t.max),code=String(t.point_code??"");
      if(code&&Number.isFinite(min)&&Number.isFinite(max)) {
        restored[code]={target:String(sumMeasurements(min,max,2)),plusMinus:String(sumMeasurements(max,-min,2))};
      }
    }
    setPointTolerances(restored);
    setToleranceMode(Object.keys(restored).length?"custom":"record_only");
    const items=line.items??line.draft_items??[];
    setItemRows(items.map((item:Row,index:number)=>({
      sku:item.sample_code===`${attrs.sample_code_prefix??"ITEM"}-${String(index+1).padStart(2,"0")}`?undefined:item.sample_code,
      size:item.size_label===attrs.size_label?undefined:item.size_label,
      color:item.color_declared===attrs.color_declared?undefined:item.color_declared,
      supplier:item.supplier_alias===(attrs.supplier_ref??attrs.supplier_alias)?undefined:item.supplier_alias,
      tracking_no:item.tracking_no===attrs.tracking_no?undefined:item.tracking_no,
    })));
    setExpectedLines(deriveExpectedLinesFromServerLine(line));
    setExpectedUndoStack([]);
    setPurchaseEvidences(Array.isArray(attrs.purchase_evidences)?attrs.purchase_evidences:[]);
    setPlannedParcels(Array.isArray(attrs.planned_parcels)?attrs.planned_parcels:[]);
    setParcelMode((attrs.parcel_mode as ParcelMode)??"single");
    setItemPage(0);
    setShowFullChecklist(false);
    setManualQuoteMode(false);
    setAddingServiceLine(false);
    setServerQuote(undefined);
    return Boolean(offer);
  }

  useEffect(()=>{
    if(!data) return;
    let cancelled=false;
    const params=new URLSearchParams(location.search);
    const requestedDraft=params.get("draft")?.trim()??"";
    const key=draftRecoveryKey(customerId,requestedDraft||"new:"+String(params.get("offer")??""));
    const local=readDraftRecovery(key);
    setRecoveryKey(key);
    if(!requestedDraft&&local) {
      hasRecoveredEditor.current=true;
      draftWrite.current=local.write;
      restoreEditor(local.editor);
      setSavedNotice("Recovered unsaved edits from this tab.");
      setRecoveryReady(true);
      return;
    }
    const requestedOffer=(params.get("offer")??"").trim();
    const firstDefault=offers.find(o=>o.category_slug==="apparel"&&o.service==="inspection"&&templateVariantFor(o)==="tops")
      ??offers.find(o=>o.category_slug==="apparel"&&o.service==="inspection")??offers[0];
    if(data&&!requestedOffer&&!params.has("draft")&&firstDefault) {
      setCategoryKey(firstDefault.category_slug??firstDefault.category_id);
      setSelectedOfferId(firstDefault.offer_id);
      setServiceKind(firstDefault.service);
      setTemplateVariant(templateVariantFor(firstDefault));
      setQty(Math.max(firstDefault.rules.minimum,Math.min(firstDefault.rules.maximum,3)));
    }
    if(requestedOffer && offers.length>0 && !requestedDraft) {
      const matched=offers.find(x=>x.offer_id===requestedOffer||x.sku_code===requestedOffer);
      if(matched) {
        const matchedCat=wizardCategories.find(c=>resolveCategoryId(c.key)===matched.category_id);
        if(matchedCat) setCategoryKey(matchedCat.key);
        setSelectedOfferId(matched.offer_id);
        setServiceKind(matched.service);
        setTemplateVariant(templateVariantFor(matched));
        setQty(matched.service==="compare"?matched.rules.minimum:Math.max(1,matched.rules.minimum));
      } else {
        if(firstDefault) {
          setCategoryKey(firstDefault.category_slug??firstDefault.category_id);
          setSelectedOfferId(firstDefault.offer_id);
          setServiceKind(firstDefault.service);
          setTemplateVariant(templateVariantFor(firstDefault));
          setQty(Math.max(firstDefault.rules.minimum,Math.min(firstDefault.rules.maximum,3)));
        }
        setWizardError("The requested service offer is unavailable or not yet open for online ordering. Please select an open Apparel service below.");
      }
    }
    if(requestedDraft) {
      (async()=>{
        try {
          setBusyMessage(`Loading draft ${requestedDraft}…`);
          const found=await request("/orders/by-number/"+encodeURIComponent(requestedDraft));
          const ord=await request("/orders/"+found.id);
          if(cancelled) return;
          if(ord.state!=="draft") {
            removeDraftRecovery(key);
            location.assign("/orders/"+ord.public_no);
            return;
          }
          setDraftOrder(ord);
          serverEditor.current=true;
          if(local&&!ord.manual_quote&&local.revision===ord.revision) {
            hasRecoveredEditor.current=true;
            draftWrite.current=local.write;
            restoreEditor(local.editor);
            serverEditor.current=false;
            setSavedNotice("Restored this tab’s draft.");
            return;
          }
          if(local&&!ord.manual_quote) setConflict(local);
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
            const available=restoreServiceLine(primary);
            if(!available) {
              setWizardError("This saved service is no longer available. Select a current service before editing this draft.");
            }
            if(ord.manual_quote) {
              setManualQuoteMode(true);
              setManualBatchQty(Number(primary.quantity));
              setManualQuoteSubmitted({orderNo:ord.public_no,requestState:ord.manual_quote.state,qty:Number(primary.quantity)});
            }
            const savedStep=params.get("step");
            setStep(!available?0:ord.manual_quote?1:savedStep&&/^[0-4]$/.test(savedStep)?Number(savedStep):2);
          }
        } catch(err) {
          if(cancelled) return;
          setDraftLoadFailed(true);
          setWizardError(err instanceof Error?err.message:"Could not load draft order.");
        } finally {
          if(!cancelled) {
            setBusyMessage("");
            setRecoveryReady(true);
          }
        }
      })();
    } else {
      setRecoveryReady(true);
    }
    return ()=>{cancelled=true;};
  },[data,customerId]);

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
  const allAttachmentIds=attachmentId?[attachmentId]:[];
  const expectedTotalQty=sumExpectedLineQuantity(expectedLines);
  const confirmedExpectedLines=expectedLines.filter(l=>missingLineFields(l).length===0);
  const incompleteExpectedLines=expectedLines.filter(l=>missingLineFields(l).length>0);
  const unconfirmedEvidences=purchaseEvidences.filter(ev=>
    ev.extraction_status==="pending_reassociation" ||
    (ev.extraction_status==="needs_confirmation"&&ev.candidates.length>0)
  );
  const pendingReassociationEvidences=purchaseEvidences.filter(ev=>ev.extraction_status==="pending_reassociation");
  const pendingCandidateCount=purchaseEvidences
    .filter(ev=>ev.extraction_status==="needs_confirmation")
    .reduce((sum,ev)=>sum+ev.candidates.length,0);
  const effectiveDisplayName=itemName.trim()||expectedLines.find(l=>l.product_name.trim())?.product_name.trim()||expectedLines[0]?.sku_code.trim()||"";
  const singleLineName=effectiveDisplayName;
  const effectiveSupplier=supplierRef.trim()||expectedLines.find(l=>l.supplier_alias.trim())?.supplier_alias.trim()||"";

  const allRefItems:Row[]=Array.isArray(refs.data?.items)?refs.data.items:(Array.isArray(desk.data?.references)?desk.data.references:[]);
  const categoryRefItems=allRefItems.filter((r:Row)=>!r.category_id||r.category_id===activeCategoryId);
  const activeRefs=categoryRefItems.filter((r:Row)=>r.state==="active"&&new Date(r.expires_at)>new Date());
  const pendingCategoryRefs=categoryRefItems.filter((r:Row)=>r.state==="pending_safe_storage");
  const expiredCategoryRefs=categoryRefItems.filter((r:Row)=>r.state==="expired"||(r.state==="active"&&new Date(r.expires_at)<=new Date()));
  const otherCategoryActiveRefs=allRefItems.filter((r:Row)=>Boolean(r.category_id)&&r.category_id!==activeCategoryId&&r.state==="active"&&new Date(r.expires_at)>new Date());
  const deskItems:Row[]=Array.isArray(desk.data?.items)?desk.data.items:[];
  const readyToReserveItems=deskItems.filter((item:Row)=>
    item.inspection_stage==="inspected" && item.custody_state==="stored" && !item.reference_sample
  );
  const deskOrders:Row[]=Array.isArray(desk.data?.orders)?desk.data.orders:[];
  const inFlightInspectionOrders=deskOrders.filter((ord:Row)=>
    ["awaiting_payment","awaiting_samples","samples_ready","queued","inspecting","qa_review","report_ready","action_pending"].includes(ord.state)
  );
  const selectedRef=activeRefs.find((r:Row)=>r.reference_id===referenceId);
  const goldenSampleBlockedInStep1=serviceKind==="reference_match"&&Boolean(refs.data)&&!refs.error&&activeRefs.length===0;

  useEffect(()=>{
    if(serviceKind!=="reference_match"||!refs.data||refs.error||referenceId) return;
    const readyNonBusy=activeRefs.filter((r:Row)=>!r.in_use);
    if(readyNonBusy.length===1) setReferenceId(readyNonBusy[0].reference_id);
  },[serviceKind,refs.data,refs.error,activeCategoryId,referenceId]);

  const compareDeclaredSizes=new Set(expectedLines.map(l=>l.size_label.trim().toUpperCase()).filter(Boolean));
  const compareHasDifferentSizes=serviceKind==="compare"&&compareDeclaredSizes.size>1;
  const compareHasDifferentNames=serviceKind==="compare"&&new Set(expectedLines.map(l=>l.product_name.trim().toLowerCase()).filter(Boolean)).size>1;
  const needsCompareSizeAck=compareHasDifferentSizes&&!sizeMismatchConfirmed;

  const hasConfirmedLines=confirmedExpectedLines.length>0;
  const hasQuantityMismatch=!manualQuoteMode&&expectedLines.length>0&&expectedTotalQty!==clampedQty;
  const hasPendingCandidates=pendingCandidateCount>0;
  const hasPendingReassociation=pendingReassociationEvidences.length>0;
  const isEstimateProvisional=!manualQuoteMode&&(!hasConfirmedLines||incompleteExpectedLines.length>0||hasPendingReassociation);
  const missingReferenceSample=serviceKind==="reference_match"&&Boolean(refs.data)&&!refs.error&&!selectedRef;
  const estimateInvalidReason=hasQuantityMismatch
    ?`Expected product lines (${expectedTotalQty} units) differ from commissioned quantity (${clampedQty}). Sync quantities or update lines in Step 3B.`
    :hasPendingReassociation
      ?`${pendingReassociationEvidences.length} retained evidence file(s) need confirmation or removal in Step 3A.`
      :hasPendingCandidates
        ?`${pendingCandidateCount} extracted candidate row(s) are unconfirmed in Step 3A.`
        :missingReferenceSample
          ?activeRefs.length===0
            ?"No active Golden Sample is available in warehouse vault for this category."
            :"Select an active Golden Sample in Step 2 to price this comparison."
          :"";
  const isEstimateInvalid=Boolean(estimateInvalidReason);

  const scopeAttributes={garment_type:activeGarmentType,name:effectiveDisplayName,
    size_label:baseSize||expectedLines[0]?.size_label||"",
    color_declared:baseColor||expectedLines[0]?.color_declared||"",
    supplier_ref:effectiveSupplier,supplier_alias:effectiveSupplier,product_url:productLink,
    tracking_no:baseTrackingNo||(parcelMode==="single"?plannedParcels[0]?.tracking_no??"":""),
    ...(allAttachmentIds.length?{attachment_ids:allAttachmentIds}:{})};
  const allOfferChecks:Row[]=Array.isArray(configuredOffer?.content?.checks)?configuredOffer.content.checks:[];
  const filteredChecks=allOfferChecks.filter(c=>conditionMatches(c.applies_if,scopeAttributes)&&conditionMatches(c.required_if,scopeAttributes));
  const measurementChecks=filteredChecks.filter(c=>c.type==="number"&&c.unit);
  const visualChecks=filteredChecks.filter(c=>!measurementChecks.includes(c));
  const allOfferShots:Row[]=Array.isArray(configuredOffer?.content?.shots)?configuredOffer.content.shots:[];
  const filteredShots=allOfferShots.filter(shot=>shot.required&&conditionMatches(shot.required_if,scopeAttributes));

  function chooseOffer(offer:Row,quantity=qty,options?:{preserveLines?:boolean}) {
    const switchingServiceOrCategory=offer.service!==serviceKind||(Boolean(activeCategoryId)&&offer.category_id!==activeCategoryId);
    const shouldResetLines=!options?.preserveLines&&switchingServiceOrCategory;
    const hadServiceSpecificState=expectedLines.length>0||itemRows.length>0||
      plannedParcels.some(p=>Boolean(p.tracking_no.trim())||p.allocations.length>0)||
      Boolean(attachmentId)||purchaseEvidences.length>0||
      Boolean(referenceId)||sizeMismatchConfirmed||Boolean(serverQuote)||Boolean(itemName.trim());
    setServiceKind(offer.service);
    setTemplateVariant(templateVariantFor(offer));
    setSelectedOfferId(offer.offer_id);
    const targetQty=switchingServiceOrCategory
      ?(offer.service==="compare"||offer.service==="reference_match"?offer.rules.minimum:Math.max(offer.rules.minimum,Math.min(offer.rules.maximum,3)))
      :Math.max(offer.rules.minimum,Math.min(offer.rules.maximum,quantity||offer.rules.minimum));
    setQty(targetQty);
    setManualQuoteMode(false);
    setQuotedFingerprint("");
    setServerQuote(undefined);
    setConsents({});
    setPolicyAccepted(false);
    if(shouldResetLines) {
      setExpectedLines([]);
      setExpectedUndoStack([]);
      setItemRows([]);
      setPlannedParcels([]);
      setParcelMode("single");
      setItemName("");
      setSupplierRef("");
      setBaseSku("ITEM");
      setBaseColor("");
      setBaseSize("");
      setBaseTrackingNo("");
      setProductLink("");
      setAttachmentId(undefined);
      setAttachmentName(undefined);
      setAttachmentPurpose("reference_photo");
      setAttachmentSha256(undefined);
      setShowMatrixBuilder(false);
      setShowAdvancedUnits(false);
      setShowPasteImport(false);
      const nextServiceName=wizardServiceCards.find(c=>c.service===offer.service)?.title??offer.title.en;
      setPurchaseEvidences(prev=>prev.filter(ev=>Boolean(ev.media_id)).map(ev=>({
        ...ev,
        candidates:[],
        extraction_status:"pending_reassociation",
        extraction_note:`Pending re-association: retained from prior service. Confirm relevance for ${nextServiceName} or remove before quoting.`,
      })));
      setReferenceId("");
      setSizeMismatchConfirmed(false);
      setPointTolerances({});
      setToleranceMode("record_only");
      setWizardError("");
      setSavedNotice("");
      setServiceSwitchBanner(hadServiceSpecificState
        ?`Switched to ${nextServiceName}. Previous service product lines, attachments, parcel mappings, and prior quotes were cleared.${purchaseEvidences.some(ev=>Boolean(ev.media_id))?" Uploaded purchase evidence is marked pending re-association for confirmation in Step 3A.":""}`
        :"");
    } else {
      if(offer.service!=="reference_match") setReferenceId("");
      setSizeMismatchConfirmed(false);
      setPointTolerances({});
      setToleranceMode("record_only");
      setSavedNotice("");
      setServiceSwitchBanner("");
    }
  }

  function buildComparisonSampleLines(targetCount:number,existingLines:ExpectedProductLine[]=[]):ExpectedProductLine[] {
    const safeCount=targetCount===3?3:2;
    return Array.from({length:safeCount},(_,idx)=>{
      const suffix=String.fromCharCode(65+idx);
      const prev=existingLines[idx];
      if(prev) {
        return {
          ...prev,
          quantity:1,
        };
      }
      return {
        id:`EL-CMP-${Date.now().toString(36)}-${idx+1}`,
        sku_code:`${baseSku&&baseSku!=="ITEM"?baseSku:"CMP"}-${suffix}`,
        product_name:itemName.trim()||`Comparison Sample ${suffix}`,
        color_declared:baseColor.trim()||"Standard",
        size_label:baseSize.trim()||"M",
        quantity:1,
        supplier_alias:supplierRef.trim()||`Supplier ${suffix}`,
        tracking_no:parcelMode==="later"?"":normalizeTrackingCode(plannedParcels[0]?.tracking_no||baseTrackingNo),
        source_kind:"manual",
      };
    });
  }

  useEffect(()=>{
    if(step>=2 && serviceKind==="compare" && (clampedQty===2||clampedQty===3) && expectedLines.length===0 && recoveryReady) {
      setExpectedLines(buildComparisonSampleLines(clampedQty,[]));
      if(!itemName.trim()) setItemName("Multi-Supplier Sample Comparison");
    }
  },[step,serviceKind,clampedQty,expectedLines.length,recoveryReady]);

  function switchToServiceKind(targetService:"inspection"|"compare"|"reference_match",preferredCategoryId=activeCategoryId) {
    const pool=offers
      .filter(o=>o.category_id===preferredCategoryId&&o.service===targetService)
      .sort((a,b)=>a.rules.minimum-b.rules.minimum);
    if(!pool.length) return;
    const defaultTargetQty=targetService==="compare"?2:targetService==="reference_match"?1:qty;
    const match=offerFor(pool,templateVariant,defaultTargetQty)
      ??pool.find(o=>templateVariantFor(o)===templateVariant)
      ??pool.find(o=>templateVariantFor(o)==="tops")
      ??pool[0];
    if(match) chooseOffer(match);
  }

  function selectTemplateVariant(variant:string) {
    const match=offerFor(serviceOffers,variant,qty)??serviceOffers.find(o=>templateVariantFor(o)===variant);
    if(match) chooseOffer(match,qty,{preserveLines:true});
  }

  function applyExpectedLinesUpdate(nextLines:ExpectedProductLine[],options?:{recordUndo?:boolean;forceSync?:boolean}) {
    if(options?.recordUndo!==false) {
      setExpectedUndoStack(prev=>[...prev.slice(-9),expectedLines]);
    }
    setExpectedLines(nextLines);
    const firstNamed=nextLines.find(l=>l.product_name.trim())?.product_name.trim();
    if(!itemName.trim()&&firstNamed) setItemName(firstNamed);
    const nextSum=sumExpectedLineQuantity(nextLines);
    if(nextSum>0&&(syncQuantityFromLines||options?.forceSync)) {
      if(serviceKind==="compare") {
        const match=offerFor(serviceOffers,templateVariant,nextSum)??offerFor(serviceOffers,"basic",nextSum);
        if(match) {
          setQty(nextSum);
          setSelectedOfferId(match.offer_id);
          setTemplateVariant(templateVariantFor(match));
        }
      } else if(nextSum<=maxOnlineQty&&nextSum>=minQty) {
        setQty(nextSum);
        const match=offerFor(templateOffers,templateVariant,nextSum);
        if(match) setSelectedOfferId(match.offer_id);
      }
    }
    setServerQuote(undefined);
    setSavedNotice("");
  }

  function undoLastExpectedBatch() {
    if(!expectedUndoStack.length) return;
    const prev=expectedUndoStack[expectedUndoStack.length-1];
    setExpectedUndoStack(stack=>stack.slice(0,-1));
    applyExpectedLinesUpdate(prev,{recordUndo:false});
  }

  function addExpectedLine(defaultQty?:number) {
    const suggestedQty=typeof defaultQty==="number"&&defaultQty>0
      ?defaultQty
      :(expectedLines.length===0&&clampedQty>0?clampedQty:1);
    const newLine:ExpectedProductLine={
      id:`EL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,5)}`,
      sku_code:baseSku&&baseSku!=="ITEM"?`${baseSku}-${expectedLines.length+1}`:"",
      product_name:itemName.trim()||expectedLines[0]?.product_name||"",
      color_declared:baseColor.trim(),
      size_label:baseSize.trim(),
      quantity:suggestedQty,
      supplier_alias:supplierRef.trim()||expectedLines[0]?.supplier_alias||"",
      tracking_no:parcelMode==="later"?"":normalizeTrackingCode(plannedParcels[0]?.tracking_no||baseTrackingNo),
      source_kind:"manual",
    };
    applyExpectedLinesUpdate([...expectedLines,newLine]);
  }

  function updateExpectedLine(id:string,patch:Partial<ExpectedProductLine>) {
    const next=expectedLines.map(line=>line.id===id?{...line,...patch}:line);
    applyExpectedLinesUpdate(next,{recordUndo:false});
  }

  function duplicateExpectedLine(line:ExpectedProductLine) {
    const copy:ExpectedProductLine={
      ...line,
      id:`EL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,5)}`,
    };
    const idx=expectedLines.findIndex(l=>l.id===line.id);
    const next=[...expectedLines];
    next.splice(idx+1,0,copy);
    applyExpectedLinesUpdate(next);
  }

  function removeExpectedLine(id:string) {
    applyExpectedLinesUpdate(expectedLines.filter(l=>l.id!==id));
  }

  function mergeDuplicateExpectedLines() {
    const merged=new Map<string,ExpectedProductLine>();
    for(const line of expectedLines) {
      const key=[
        line.sku_code.trim().toUpperCase(),
        line.product_name.trim().toLowerCase(),
        line.color_declared.trim().toLowerCase(),
        line.size_label.trim().toUpperCase(),
        line.supplier_alias.trim().toLowerCase(),
        normalizeTrackingCode(line.tracking_no),
      ].join("|");
      const existing=merged.get(key);
      if(existing) {
        existing.quantity+=Math.max(1,Math.floor(Number(line.quantity)||0));
        existing.evidence_ids=[...new Set([...(existing.evidence_ids??[]),...(line.evidence_ids??[])])];
      } else {
        merged.set(key,{...line,tracking_no:normalizeTrackingCode(line.tracking_no)});
      }
    }
    applyExpectedLinesUpdate([...merged.values()]);
  }

  function bulkFillExpectedLines(mode:"empty"|"all") {
    const sup=bulkSupplierInput.trim();
    const trk=normalizeTrackingCode(bulkTrackingInput);
    if(!sup&&!trk) return;
    const next=expectedLines.map(line=>({
      ...line,
      supplier_alias:sup?(mode==="all"||!line.supplier_alias.trim()?sup:line.supplier_alias):line.supplier_alias,
      tracking_no:trk?(mode==="all"||!line.tracking_no?.trim()?trk:line.tracking_no):line.tracking_no,
    }));
    applyExpectedLinesUpdate(next);
  }

  function applyMatrixLines() {
    const colors=matrixColors.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
    const sizes=matrixSizes.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
    const finalColors=colors.length?colors:[""];
    const finalSizes=sizes.length?sizes:[""];
    const unitQty=Math.max(1,Math.min(200,Math.floor(Number(matrixDefaultQty)||1)));
    const pName=(matrixProductName||itemName).trim();
    const prefix=(matrixSkuPrefix||(baseSku!=="ITEM"?baseSku:"SKU")).trim();
    const sup=(matrixSupplier||supplierRef).trim();
    const trk=parcelMode==="single"?normalizeTrackingCode(plannedParcels[0]?.tracking_no||baseTrackingNo):"";
    const generated:ExpectedProductLine[]=[];
    for(const col of finalColors) {
      for(const sz of finalSizes) {
        const skuParts=[prefix,col?col.slice(0,3).toUpperCase():"",sz?sz.toUpperCase():""].filter(Boolean);
        generated.push({
          id:`EL-${Date.now().toString(36)}-${generated.length+1}`,
          sku_code:skuParts.join("-"),
          product_name:pName,
          color_declared:col,
          size_label:sz,
          quantity:unitQty,
          supplier_alias:sup,
          tracking_no:trk,
          source_kind:"matrix",
        });
      }
    }
    if(pName&&!itemName.trim()) setItemName(pName);
    if(sup&&!supplierRef.trim()) setSupplierRef(sup);
    applyExpectedLinesUpdate([...expectedLines,...generated]);
    setShowMatrixBuilder(false);
  }

  async function handleEvidenceFiles(files:File[]) {
    if(!files.length) return;
    setEvidenceDuplicateWarning("");
    setWizardError("");
    const seenHashes=new Set(purchaseEvidences.map(ev=>ev.sha256));
    for(const file of files) {
      const sha256=await sha256FileHex(file);
      if(seenHashes.has(sha256)) {
        setEvidenceDuplicateWarning(`Duplicate file skipped: "${file.name}" matches existing evidence (SHA-256 ${sha256.slice(0,12)}…). Review existing files below instead of uploading twice.`);
        continue;
      }
      seenHashes.add(sha256);
      const evId=`EV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      if(file.type.startsWith("image/")) {
        try {
          setBusyMessage(`Uploading purchase screenshot ${file.name}…`);
          const uploadForm=new FormData();
          uploadForm.set("photo",file);
          const uploaded=await request("/me/media","POST",uploadForm);
          const newEv:PurchaseEvidenceItem={
            id:evId,
            media_id:uploaded.id,
            file_name:file.name,
            mime_type:file.type,
            size_bytes:file.size,
            sha256,
            purpose:"purchase_evidence",
            supplier_alias:supplierRef.trim(),
            platform_source:"1688 / Taobao",
            purchase_order_ref:"",
            uploaded_at:new Date().toISOString(),
            extraction_status:"manual_only",
            extraction_note:"Reference only (No Auto-OCR): image archived with SHA-256 verification. Use + Transcribe Row, Paste Order Text, or Step 3B Quick Matrix to confirm product lines.",
            candidates:[],
          };
          setPurchaseEvidences(prev=>[...prev,newEv]);
        } catch(err) {
          setWizardError(err instanceof Error?err.message:`Upload failed for ${file.name}.`);
        } finally {
          setBusyMessage("");
        }
      } else if(/\.(csv|tsv|txt)$/i.test(file.name)||file.type.startsWith("text/")) {
        const rawText=await file.text();
        const candidates=parseStructuredPurchaseText(rawText,{
          evidenceId:evId,
          defaultProductName:itemName.trim()||undefined,
          defaultSupplier:supplierRef.trim()||undefined,
          defaultTracking:normalizeTrackingCode(plannedParcels[0]?.tracking_no||baseTrackingNo)||undefined,
        });
        const newEv:PurchaseEvidenceItem={
          id:evId,
          file_name:file.name,
          mime_type:file.type||"text/plain",
          size_bytes:file.size,
          sha256,
          supplier_alias:supplierRef.trim(),
          platform_source:"CSV / Export",
          purchase_order_ref:"",
          uploaded_at:new Date().toISOString(),
          extraction_status:candidates.length?"needs_confirmation":"manual_only",
          extraction_note:candidates.length
            ?`Parsed ${candidates.length} candidate row(s). Review missing fields and confirm before adding to your order.`
            :"No structured SKU rows detected in this file. Paste structured rows below or add lines directly.",
          candidates,
        };
        setPurchaseEvidences(prev=>[...prev,newEv]);
      } else {
        const newEv:PurchaseEvidenceItem={
          id:evId,
          file_name:file.name,
          mime_type:file.type||"application/pdf",
          size_bytes:file.size,
          sha256,
          supplier_alias:supplierRef.trim(),
          platform_source:"PDF / Order Sheet",
          purchase_order_ref:"",
          uploaded_at:new Date().toISOString(),
          extraction_status:"manual_only",
          extraction_note:"Recorded PDF metadata & SHA-256. Binary PDF upload & automated PDF OCR are OPEN — paste order text below or upload screenshots for visual reference.",
          candidates:[],
        };
        setPurchaseEvidences(prev=>[...prev,newEv]);
      }
    }
    setServerQuote(undefined);
  }

  async function runPasteExtract() {
    if(!pasteImportText.trim()) return;
    setEvidenceDuplicateWarning("");
    const normalized=pasteImportText.trim();
    const textBlob=new File([normalized],"pasted-order.txt",{type:"text/plain"});
    const sha256=await sha256FileHex(textBlob);
    if(purchaseEvidences.some(ev=>ev.sha256===sha256)) {
      setEvidenceDuplicateWarning(`Duplicate text batch detected (SHA-256 ${sha256.slice(0,12)}…). Edit or clear the existing candidate queue below.`);
      return;
    }
    const evId=`EV-${Date.now().toString(36)}`;
    const candidates=parseStructuredPurchaseText(normalized,{
      evidenceId:evId,
      defaultProductName:itemName.trim()||undefined,
      defaultSupplier:pasteSupplier.trim()||supplierRef.trim()||undefined,
      defaultPoRef:pastePoRef.trim()||undefined,
      defaultTracking:normalizeTrackingCode(pasteTracking||plannedParcels[0]?.tracking_no||baseTrackingNo)||undefined,
    });
    if(!candidates.length) {
      setWizardError("No rows could be parsed. Use CSV, tab-separated spreadsheet rows, or one SKU/Color/Size/Qty line per row.");
      return;
    }
    const ev:PurchaseEvidenceItem={
      id:evId,
      file_name:`Pasted Order (${candidates.length} rows)`,
      mime_type:"text/plain",
      size_bytes:normalized.length,
      sha256,
      supplier_alias:pasteSupplier.trim()||supplierRef.trim(),
      platform_source:"Pasted Order Text",
      purchase_order_ref:pastePoRef.trim(),
      uploaded_at:new Date().toISOString(),
      extraction_status:"needs_confirmation",
      extraction_note:`Parsed ${candidates.length} candidate line(s). Unconfirmed lines are blocked from quoting until reviewed and confirmed.`,
      candidates,
    };
    setPurchaseEvidences(prev=>[...prev,ev]);
    setPasteImportText("");
    setShowPasteImport(false);
    setServerQuote(undefined);
  }

  function updateCandidateRow(evidenceId:string,candidateId:string,patch:Partial<ExtractedCandidateLine>) {
    setPurchaseEvidences(prev=>prev.map(ev=>{
      if(ev.id!==evidenceId) return ev;
      return {
        ...ev,
        candidates:ev.candidates.map(c=>{
          if(c.id!==candidateId) return c;
          const next={...c,...patch};
          next.missing_fields=missingLineFields(next);
          next.confidence=next.missing_fields.length===0?"structured":"needs_review";
          return next;
        }),
      };
    }));
    setServerQuote(undefined);
  }

  function addManualCandidateRow(evidenceId:string) {
    setPurchaseEvidences(prev=>prev.map(ev=>{
      if(ev.id!==evidenceId) return ev;
      const newCand:ExtractedCandidateLine={
        id:`EXT-${Date.now().toString(36)}-${ev.candidates.length+1}`,
        evidence_id:ev.id,
        sku_code:"",
        product_name:itemName.trim(),
        color_declared:"",
        size_label:"",
        quantity:1,
        supplier_alias:ev.supplier_alias||supplierRef.trim(),
        purchase_order_ref:ev.purchase_order_ref,
        tracking_no:normalizeTrackingCode(plannedParcels[0]?.tracking_no||baseTrackingNo),
        source_kind:"evidence_extract",
        confidence:"needs_review",
        needs_confirmation:true,
        missing_fields:["color","size"],
        selected:true,
        confirmed:false,
      };
      return {
        ...ev,
        extraction_status:"needs_confirmation",
        candidates:[...ev.candidates,newCand],
      };
    }));
    setServerQuote(undefined);
  }

  function confirmEvidenceCandidates(evidenceId:string) {
    const ev=purchaseEvidences.find(item=>item.id===evidenceId);
    if(!ev) return;
    const chosen=ev.candidates.filter(c=>c.selected);
    if(!chosen.length) {
      setWizardError("Select at least one candidate row to confirm, or discard the candidate queue.");
      return;
    }
    const incomplete=chosen.find(c=>missingLineFields(c).length>0);
    if(incomplete) {
      setWizardError(`Complete missing fields (${missingLineFields(incomplete).join(", ")}) on checked candidate rows before confirming.`);
      return;
    }
    const confirmedLines:ExpectedProductLine[]=chosen.map((c,idx)=>({
      id:`EL-${Date.now().toString(36)}-${idx}-${Math.random().toString(36).slice(2,5)}`,
      sku_code:c.sku_code.trim(),
      product_name:c.product_name.trim(),
      color_declared:c.color_declared.trim(),
      size_label:c.size_label.trim(),
      quantity:Math.max(1,Math.floor(Number(c.quantity)||1)),
      supplier_alias:(c.supplier_alias||ev.supplier_alias||supplierRef).trim(),
      purchase_order_ref:(c.purchase_order_ref||ev.purchase_order_ref||"").trim(),
      unit_price_note:c.unit_price_note,
      tracking_no:normalizeTrackingCode(c.tracking_no),
      carrier_code:c.carrier_code,
      carton_no:c.carton_no,
      inspection_note:c.inspection_note,
      evidence_ids:ev.media_id?[ev.media_id]:[],
      source_kind:ev.media_id?"evidence_extract":"paste",
    }));
    setPurchaseEvidences(prev=>prev.map(item=>item.id===evidenceId?{
      ...item,
      extraction_status:"confirmed",
      extraction_note:`Confirmed ${confirmedLines.length} line(s) (${sumExpectedLineQuantity(confirmedLines)} units) into expected order lines.`,
      candidates:[],
    }:item));
    applyExpectedLinesUpdate([...expectedLines,...confirmedLines]);
    setWizardError("");
  }

  function discardEvidenceQueue(evidenceId:string,removeEntireEvidence:boolean) {
    if(removeEntireEvidence) {
      setPurchaseEvidences(prev=>prev.filter(item=>item.id!==evidenceId));
    } else {
      setPurchaseEvidences(prev=>prev.map(item=>item.id===evidenceId?{
        ...item,
        extraction_status:"manual_only",
        extraction_note:"Candidate rows discarded by user.",
        candidates:[],
      }:item));
    }
    setServerQuote(undefined);
  }

  function confirmRetainedEvidence(evidenceId:string) {
    setPurchaseEvidences(prev=>prev.map(item=>item.id===evidenceId?{
      ...item,
      extraction_status:"manual_only",
      extraction_note:`Confirmed for ${serviceLabel} (Reference only — no Auto-OCR). Transcribe rows or enter confirmed product lines in 3B.`,
    }:item));
    setWizardError("");
    setServerQuote(undefined);
  }

  function autoGroupParcelsFromLines(preserveMulti=false) {
    const groups=new Map<string,{tracking_no:string;supplier_alias:string;allocations:Array<{expected_line_id:string;quantity:number}>}>();
    for(const line of expectedLines) {
      const trk=normalizeTrackingCode(line.tracking_no);
      const sup=line.supplier_alias.trim();
      const key=`${trk}|${sup}`;
      const existing=groups.get(key)??{tracking_no:trk,supplier_alias:sup,allocations:[]};
      existing.allocations.push({expected_line_id:line.id,quantity:line.quantity});
      groups.set(key,existing);
    }
    const next:PlannedParcelEntry[]=[...groups.values()].map((g,idx)=>({
      id:`PKG-${idx+1}-${Date.now().toString(36)}`,
      tracking_no:g.tracking_no,
      carrier_code:"sf",
      supplier_alias:g.supplier_alias,
      carton_count:1,
      contains_all_items:preserveMulti?false:groups.size===1,
      allocations:g.allocations,
      note:`Box ${idx+1}`,
    }));
    setPlannedParcels(next);
    setParcelMode(preserveMulti||next.length>1?"multi":"single");
    setServerQuote(undefined);
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
        const min=sumMeasurements(target,-pm),max=sumMeasurements(target,pm);
        if(!Number.isFinite(min)||!Number.isFinite(max)) continue;
        rules.push({
          point_code:code,
          min,
          max,
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
    const resolvedTracking=parcelMode==="single"
      ?normalizeTrackingCode(plannedParcels[0]?.tracking_no||baseTrackingNo)
      :parcelMode==="multi"
        ?normalizeTrackingCode(plannedParcels.find(p=>p.tracking_no.trim())?.tracking_no||baseTrackingNo)
        :"";
    const items=expandExpectedLinesToDraftItems({
      expectedLines,
      plannedParcels,
      parcelMode,
      itemRows,
      effectiveQty,
      defaults:{
        itemName:singleLineName,
        supplierRef:effectiveSupplier,
        baseSku,
        baseColor,
        baseSize,
        baseTrackingNo:resolvedTracking,
        garmentType:activeGarmentType,
        attachmentIds:allAttachmentIds,
      },
    });
    const compactEvidences=purchaseEvidences.map(ev=>({
      ...ev,
      candidates:ev.extraction_status==="needs_confirmation"?ev.candidates:[],
    }));
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
        ...(resolvedTracking?{tracking_no:resolvedTracking}:{}),
        ...(singleLineName?{name:singleLineName.slice(0,120)}:{}),
        ...(effectiveSupplier?{supplier_ref:effectiveSupplier,supplier_alias:effectiveSupplier}:{}),
        ...(activeGarmentType?{garment_type:activeGarmentType}:{}),
        ...(productLink.trim()?{product_url:productLink.trim()}:{}),
        ...(baseSize.trim()?{size_label:baseSize.trim()}:{}),
        ...(baseColor.trim()?{color_declared:baseColor.trim()}:{}),
        ...(tolRules.length>0?{tolerances:tolRules}:{}),
        ...(allAttachmentIds.length?{attachment_ids:allAttachmentIds}:{}),
        ...(attachmentName?{attachment_name:attachmentName,attachment_purpose:attachmentPurpose}:{}),
        ...(attachmentSha256?{attachment_sha256:attachmentSha256}:{}),
        ...(expectedLines.length?{expected_lines:expectedLines}:{}),
        ...(compactEvidences.length?{purchase_evidences:compactEvidences}:{}),
        ...(plannedParcels.length?{planned_parcels:plannedParcels}:{}),
        parcel_mode:parcelMode,
      },
      items,
    };
  }

  const currentLine=addingServiceLine&&!effectiveDisplayName?null:buildCurrentLine();
  const allLines=extraLines.length>0?(currentLine?[...extraLines,currentLine]:extraLines):(currentLine?[currentLine]:[]);
  const totalItems=allLines.reduce((sum,l)=>sum+(Number(l.quantity)||0),0);

  const draftPayload={lines:allLines.map(({title,...line})=>line),customer_notes:notes.trim()};
  const fingerprint=JSON.stringify(draftPayload);
  const editor:DraftEditor={step,categoryKey,serviceKind,selectedOfferId,templateVariant,qty,manualQuoteMode,manualBatchQty,manualQuoteReason,
    itemName,supplierRef,baseSku,baseColor,baseSize,baseTrackingNo,productLink,toleranceMode,pointTolerances,referenceId,
    sizeMismatchConfirmed,itemRows,expectedLines,purchaseEvidences,plannedParcels,parcelMode,syncQuantityFromLines,
    notes,attachmentId,attachmentName,attachmentPurpose,attachmentSha256,extraLines,addingServiceLine};
  const editorContent=JSON.stringify({...editor,step:0});
  useLayoutEffect(()=>{
    if(!recoveryReady||draftLoadFailed||!recoveryKey) return;
    if(originalEditor.current===undefined) {
      originalEditor.current=hasRecoveredEditor.current?null:editorContent;
      if(serverEditor.current) savedFingerprint.current=fingerprint;
    }
    if(conflict&&!reviewingConflict||submittedCharge||manualQuoteSubmitted) return;
    if(editorContent===originalEditor.current) {
      if(!draftWrite.current) {
        if(draftOrder) writeDraftRecovery(recoveryKey,{revision:draftOrder.revision,editor,write:null});
        else removeDraftRecovery(recoveryKey);
      }
      return;
    }
    writeDraftRecovery(recoveryKey,{
      revision:reviewingConflict?conflict!.revision:draftOrder?.revision??null,editor,write:draftWrite.current,
    });
  },[recoveryReady,recoveryKey,draftLoadFailed,editorContent,step,conflict,reviewingConflict,draftOrder,submittedCharge,manualQuoteSubmitted]);

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
    if(pendingReassociationEvidences.length>0) {
      throw new Error("Confirm or remove retained evidence files from your previous service in Step 3A before saving or requesting a quote.");
    }
    if(unconfirmedEvidences.length>0) {
      throw new Error("Confirm or discard pending extracted candidate rows before saving or requesting a quote.");
    }
    if(expectedLines.length>0&&expectedTotalQty!==clampedQty) {
      throw new Error(`Expected product lines total ${expectedTotalQty} items, which does not match the commissioned quantity (${clampedQty}). Sync commissioned quantity or update your lines.`);
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

  async function persistDraft(payload=draftPayload,confirmConflict=false):Promise<Row> {
    if(!recoveryReady||draftLoadFailed) throw new Error("Reload the draft before saving.");
    if(conflict&&(!reviewingConflict||!confirmConflict)) throw new Error("Review the versions and choose which edits to save.");
    checkDraftInputs(payload.lines);
    const input=JSON.stringify(payload);
    let record=draftOrder;
    let key=recoveryKey;
    if(record&&savedFingerprint.current===input) {
      if(confirmConflict) {
        removeDraftRecovery(key);
        setConflict(null);
        setReviewingConflict(false);
      }
      return record;
    }
    async function createDraft(body:typeof draftPayload,writeKey:string) {
      const created=await request("/orders","POST",{
        lines:body.lines,...(body.customer_notes?{customer_notes:body.customer_notes}:{}),
      },writeKey);
      if(!created.id||!created.public_no||!created.revision||created.state!=="draft") {
        throw new Error("The draft could not be confirmed. Retry before proceeding.");
      }
      return created;
    }
    if(!record&&draftWrite.current&&draftWrite.current.fingerprint!==input) {
      // An earlier create may have reached the server before its response was lost.
      const pending=draftWrite.current;
      try {
        record=await createDraft(JSON.parse(pending.fingerprint),pending.key);
      } catch(error) {
        // A rejected payload cannot have created a draft.
        if(!(error instanceof RequestError&&(error.status===400||error.status===422))) throw error;
      }
      draftWrite.current=null;
      if(record) {
        savedFingerprint.current=pending.fingerprint;
        const numberedKey=draftRecoveryKey(customerId,record.public_no);
        writeDraftRecovery(numberedKey,{revision:record.revision,editor,write:null});
        removeDraftRecovery(key);
        key=numberedKey;
        setDraftOrder(record);
        setRecoveryKey(key);
        syncDraftUrl(record.public_no,step);
      }
    }
    if(draftWrite.current?.fingerprint!==input) draftWrite.current={fingerprint:input,key:crypto.randomUUID()};
    writeDraftRecovery(key,{revision:record?.revision??null,editor,write:draftWrite.current});
    const updated=record
      ?await request("/orders/"+record.id,"PATCH",{...payload,revision:record.revision},draftWrite.current.key)
      :await createDraft(payload,draftWrite.current.key);
    if(!updated.id||!updated.public_no||!updated.revision||updated.state!=="draft") {
      throw new Error("The draft could not be confirmed. Retry before proceeding.");
    }
    savedFingerprint.current=input;
    draftWrite.current=null;
    quoteWrite.current=null;
    setDraftOrder(updated);
    originalEditor.current=editorContent;
    const savedKey=draftRecoveryKey(customerId,updated.public_no);
    writeDraftRecovery(savedKey,{revision:updated.revision,editor,write:null});
    if(key!==savedKey) removeDraftRecovery(key);
    setRecoveryKey(savedKey);
    setConflict(null);
    setReviewingConflict(false);
    syncDraftUrl(updated.public_no,step);
    return updated;
  }

  async function runWizard<T>(message:string,action:()=>Promise<T>) {
    if(inFlight.current) return;
    inFlight.current=true;
    setWizardError("");
    setSavedNotice("");
    setBusyMessage(message);
    try {
      if(autoSaveTask.current) await autoSaveTask.current.catch(()=>{});
      return await action();
    }
    catch(error) {
      setWizardError(error instanceof RequestError&&error.code==="VERSION_CONFLICT"
        ?"This draft changed in another window. Reload to review the saved draft and your edits.":
        error instanceof Error&&error.name==="TimeoutError"?"The quote request timed out. Retry to continue.":
        error instanceof TypeError?"Connection interrupted. Check your connection and try again.":
        error instanceof Error?error.message:"Try again or contact Support.");
    }
    finally {inFlight.current=false;setBusyMessage("");}
  }

  function saveDraftOnly(confirmConflict=false,background=false) {
    if(background) {
      if(inFlight.current||autoSaveTask.current||!currentLine) return Promise.resolve();
      let task:Promise<unknown>|null=null;
      task=(async()=>{
        try {
          const record=await persistDraft(draftPayload,false);
          setSavedNotice(`Draft ${record.public_no} saved.`);
        } catch {}
        finally {
          if(autoSaveTask.current===task) autoSaveTask.current=null;
        }
      })();
      autoSaveTask.current=task;
      return task;
    }
    return runWizard("Saving draft…",async()=>{
      if(!currentLine) throw new Error("Choose an available service and quantity.");
      const record=await persistDraft(draftPayload,confirmConflict);
      setSavedNotice(`Draft ${record.public_no} saved.`);
    });
  }

  function addServiceLine() {
    return runWizard("Saving inspection scope…",async()=>{
      if(!currentLine||!effectiveDisplayName) throw new Error("Review the service, quantity and product lines before adding another service.");
      if(unconfirmedEvidences.length>0) throw new Error("Confirm or discard pending extracted candidate rows first.");
      if(allLines.length>=20||totalItems>=maximumDraftItems) throw new Error("This order has reached its service line or item limit.");
      const saved=await persistDraft();
      setExtraLines(allLines);
      setAddingServiceLine(true);
      setItemName("");
      setItemRows([]);
      setExpectedLines([]);
      setExpectedUndoStack([]);
      setPurchaseEvidences([]);
      setPlannedParcels([]);
      setParcelMode("single");
      setShowMatrixBuilder(false);
      setShowPasteImport(false);
      setShowAdvancedUnits(false);
      setEvidenceDuplicateWarning("");
      setItemPage(0);
      setSupplierRef("");
      setBaseSku("ITEM");
      setBaseSize("");
      setBaseColor("");
      setBaseTrackingNo("");
      setProductLink("");
      setAttachmentId(undefined);
      setAttachmentName(undefined);
      setAttachmentPurpose("reference_photo");
      setAttachmentSha256(undefined);
      setServiceSwitchBanner("");
      setSizeMismatchConfirmed(false);
      setPointTolerances({});
      setToleranceMode("record_only");
      setReferenceId("");
      setShowFullChecklist(false);
      setServerQuote(undefined);
      setStep(0);
      syncDraftUrl(saved.public_no,0);
    });
  }

  function editServiceLine(index:number) {
    return runWizard("Saving draft…",async()=>{
      if(!currentLine) throw new Error("Finish the current service line before editing another.");
      const selected=extraLines[index];
      if(!selected) return;
      const saved=await persistDraft();
      setExtraLines([...extraLines.filter((_,i)=>i!==index),currentLine]);
      const available=restoreServiceLine(selected);
      const targetStep=available?2:0;
      setStep(targetStep);
      syncDraftUrl(saved.public_no,targetStep);
      if(!available) throw new Error("This saved service is unavailable. Select a current service to continue.");
    });
  }

  function syncDraftAndQuote() {
    return runWizard("Calculating quote…",async()=>{
      setServerQuote(undefined);
      setConsents({});
      setPolicyAccepted(false);
      if(unconfirmedEvidences.length>0) throw new Error("Confirm or discard pending extracted candidate rows before requesting a quote.");
      if(!currentLine||!effectiveDisplayName) throw new Error("Review the service, quantity and product lines before requesting a quote.");
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
        !effectiveDisplayName||serviceKind!=="inspection"||!configuredOffer) {
        throw new Error("Enter the product name and a quantity above the online limit, up to 300 items.");
      }
      const line=buildCurrentLine(manualBatchQty);
      if(!line) throw new Error("Select an available inspection service.");
      const lines=[...extraLines,line].map(({title,...payloadLine})=>payloadLine);
      const order=await persistDraft({lines,customer_notes:notes.trim()});
      const reason=`${manualBatchQty} items · ${effectiveDisplayName}${manualQuoteReason.trim()?` · ${manualQuoteReason.trim()}`:""}`;
      const result=await request("/orders/"+order.id+"/manual-quote-request","POST",{revision:order.revision,reason});
      setManualQuoteSubmitted({orderNo:order.public_no,requestState:result.state,qty:manualBatchQty});
      syncDraftUrl(order.public_no,1);
    });
  }

  function focusWizardTarget(targetId?:string) {
    if(!targetId||typeof document==="undefined") return;
    requestAnimationFrame(()=>{
      const el=document.getElementById(targetId);
      if(!el) return;
      el.scrollIntoView({behavior:"smooth",block:"center"});
      if("focus" in el&&typeof (el as HTMLElement).focus==="function") {
        (el as HTMLElement).focus({preventScroll:true});
      }
      const firstInput=el.querySelector("input,select,textarea,button") as HTMLElement|null;
      if(firstInput&&firstInput!==el) firstInput.focus({preventScroll:true});
    });
  }

  async function goToStep(targetStep:number) {
    if(inFlight.current||!recoveryReady||draftLoadFailed||targetStep<0||targetStep>5||targetStep>step+1) return;
    setWizardError("");
    if(targetStep!==step) setServiceSwitchBanner("");
    if(autoSaveTask.current) await autoSaveTask.current.catch(()=>{});
    if(targetStep<step) {
      if(step>=2&&step<=3&&effectiveDisplayName&&currentLine&&fingerprint!==savedFingerprint.current&&unconfirmedEvidences.length===0&&(!expectedLines.length||expectedTotalQty===clampedQty)) {
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
      focusWizardTarget("step1-services-group");
      return;
    }
    if(targetStep>=1&&goldenSampleBlockedInStep1) {
      setWizardError("Golden Sample Matching requires an active sealed reference sample in our vault before continuing.");
      focusWizardTarget("golden-sample-step1-gate");
      return;
    }
    if(targetStep>=2&&(!validQuantity||manualQuoteMode)) {
      setWizardError(manualQuoteMode
        ?"Manual quote mode is active. Submit the manual quote request above or return to online checkout."
        :`Enter a valid quantity (${minQty}–${maxOnlineQty}) for ${templateLabel} before continuing.`);
      focusWizardTarget(manualQuoteMode?"step2-manual-quote-card":"step2-qty-input");
      return;
    }
    if(targetStep>=2&&serviceKind==="reference_match"&&(refs.error||!refs.data)) {
      setWizardError("Reload your Golden Samples before continuing.");
      focusWizardTarget("step2-reference-select");
      return;
    }
    if(targetStep>=2&&serviceKind==="reference_match"&&!activeRefs.some((ref:Row)=>ref.reference_id===referenceId)) {
      setWizardError("Select an active Golden Sample from the warehouse vault before continuing.");
      focusWizardTarget("step2-reference-select");
      return;
    }
    if(targetStep>=3&&pendingReassociationEvidences.length>0) {
      setWizardError(`${pendingReassociationEvidences.length} retained file(s) from your previous service require confirmation or removal in 3A before continuing.`);
      focusWizardTarget("step3a-section");
      return;
    }
    if(targetStep>=3&&unconfirmedEvidences.length>0) {
      setWizardError("Confirm or discard pending extracted candidate rows in 3A before continuing.");
      focusWizardTarget("step3a-section");
      return;
    }
    if(targetStep>=3&&expectedLines.length===0) {
      setWizardError(`Add at least one confirmed product line in 3B before continuing (for ${clampedQty} unit${clampedQty===1?"":"s"} of one style, a single line with Qty = ${clampedQty} is enough).`);
      focusWizardTarget("step3b-add-line-btn");
      return;
    }
    if(targetStep>=3&&expectedLines.some(l=>missingLineFields(l).length>0)) {
      const badIdx=expectedLines.findIndex(l=>missingLineFields(l).length>0);
      const firstMissing=missingLineFields(expectedLines[badIdx])[0]??"product_name";
      setWizardError(`Complete Product Name, Color, Size, and valid Quantity (> 0) on Product Line #${badIdx+1} in 3B before continuing.`);
      focusWizardTarget(`step3b-line-${badIdx}-${firstMissing}`);
      return;
    }
    if(targetStep>=3&&expectedTotalQty!==clampedQty) {
      setWizardError(`Declared product lines total ${expectedTotalQty} unit(s), which differs from your Step 2 commissioned quantity (${clampedQty}). Sync commissioned quantity or adjust lines in 3B before continuing.`);
      focusWizardTarget("step3b-qty-mismatch-sync");
      return;
    }
    if(targetStep>=3&&needsCompareSizeAck) {
      setWizardError("Check the size-difference confirmation box in 3B before comparing samples of different sizes.");
      focusWizardTarget("step3b-size-mismatch-check");
      return;
    }
    if(targetStep>=3&&productLink.trim()&&!/^https?:\/\//i.test(productLink.trim())) {
      setWizardError("Enter a valid product link beginning with https:// or http://.");
      focusWizardTarget("step3b-product-link");
      return;
    }
    if(targetStep>=3&&!effectiveDisplayName) {
      setWizardError("Enter a product name on Product Line #1 or Order primary style name before continuing.");
      focusWizardTarget("step3b-product-name-input");
      return;
    }
    if(targetStep>=4&&toleranceMode==="custom") {
      const configured=measurementChecks.filter(check=>pointTolerances[check.key]?.target||pointTolerances[check.key]?.plusMinus);
      if(!configured.length||configured.length!==buildToleranceRules().length) {
        setWizardError("Enter a valid target and tolerance for each measurement you started, or choose Record measured values.");
        focusWizardTarget("step4b-tolerances");
        return;
      }
    }
    if(targetStep===3||(targetStep===2&&draftOrder)) {
      const deferDraftSaveUntilStep3=targetStep===2&&(
        !currentLine
        ||pendingReassociationEvidences.length>0
        ||unconfirmedEvidences.length>0
        ||(expectedLines.length>0&&expectedTotalQty!==clampedQty)
        ||(addingServiceLine&&!effectiveDisplayName)
      );
      if(deferDraftSaveUntilStep3) {
        if(draftOrder) syncDraftUrl(draftOrder.public_no,targetStep);
        setStep(targetStep);
        return;
      }
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
      setWizardError(!hasValidQuote
        ?"Calculate an active server quote in Step 5 before continuing to Payment Preview."
        :"Accept the applicable policies and check every required disclosure in Step 5 before continuing.");
      focusWizardTarget(!hasValidQuote?"step5-get-quote-btn":"step5-policy-accept-check");
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
      removeDraftRecovery(recoveryKey);
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
    if(inFlight.current||busyMessage||!recoveryReady||draftLoadFailed||conflict||!navigator.onLine||manualQuoteMode||!currentLine||!effectiveDisplayName||
      fingerprint===savedFingerprint.current||hasValidQuote) return;
    try {checkDraftInputs(allLines);} catch {return;}
    void saveDraftOnly(false,true);
  };
  useEffect(()=>{
    if(step!==2&&step!==3) return;
    const timer=setTimeout(()=>latestAutoSave.current?.(),1000);
    return ()=>clearTimeout(timer);
  },[fingerprint,step,recoveryReady]);
  useEffect(()=>{
    function resumeSaving() {latestAutoSave.current?.();}
    window.addEventListener("online",resumeSaving);
    return ()=>window.removeEventListener("online",resumeSaving);
  },[]);

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
  const policies:Row[]=terms.data?.terms??[];
  const policyIds=wizardPolicyKinds.map(kind=>policies.find(policy=>policy.kind===kind)?.id).filter(Boolean);
  const allConsentsChecked=policyAccepted&&policyIds.length===wizardPolicyKinds.length&&Object.keys(acknowledged).every(k=>consents[k]);
  const customizedRowCount=itemRows.slice(0,clampedQty).filter((r,idx)=>{
    if(!r) return false;
    const defSku=`${baseSku||"SKU"}-${String(idx+1).padStart(2,"0")}`;
    return (r.sku&&r.sku!==defSku)||(r.size&&r.size!==baseSize)||(r.color&&r.color!==baseColor)||(r.supplier&&r.supplier!==supplierRef)||Boolean(r.tracking_no);
  }).length;
  const declaredSuppliers=[...new Set([
    ...(effectiveSupplier?[effectiveSupplier]:[]),
    ...expectedLines.map(l=>l.supplier_alias.trim()).filter(Boolean),
    ...plannedParcels.map(p=>p.supplier_alias.trim()).filter(Boolean),
    ...extraLines.flatMap((l:Row)=>Array.isArray(l.attributes?.expected_lines)?l.attributes.expected_lines.map((el:Row)=>String(el.supplier_alias??"").trim()).filter(Boolean):[]),
  ])];
  const declaredWaybills=[...new Set([
    ...(parcelMode==="later"?[]:plannedParcels.map(p=>normalizeTrackingCode(p.tracking_no)).filter(Boolean)),
    ...(parcelMode==="later"?[]:expectedLines.map(l=>normalizeTrackingCode(l.tracking_no)).filter(Boolean)),
    ...(parcelMode==="single"&&baseTrackingNo.trim()?[normalizeTrackingCode(baseTrackingNo)]:[]),
    ...extraLines.flatMap((l:Row)=>Array.isArray(l.attributes?.planned_parcels)?l.attributes.planned_parcels.map((p:Row)=>normalizeTrackingCode(p.tracking_no)).filter(Boolean):[]),
  ])];
  const totalExpectedLineCount=extraLines.reduce((sum,l)=>sum+(Array.isArray(l.attributes?.expected_lines)?l.attributes.expected_lines.length:(l.quantity>0?1:0)),0)+confirmedExpectedLines.length;
  const totalEvidenceCount=extraLines.reduce((sum,l)=>sum+(Array.isArray(l.attributes?.purchase_evidences)?l.attributes.purchase_evidences.length:0),0)+purchaseEvidences.length;
  const allocatedUnitMap=new Map<string,number>();
  if(parcelMode==="multi") {
    for(const parcel of plannedParcels) {
      if(parcel.contains_all_items) {
        for(const line of expectedLines) allocatedUnitMap.set(line.id,line.quantity);
      } else {
        for(const alloc of parcel.allocations) {
          allocatedUnitMap.set(alloc.expected_line_id,(allocatedUnitMap.get(alloc.expected_line_id)??0)+alloc.quantity);
        }
      }
    }
  }
  const hasOverAllocatedParcel=parcelMode==="multi"&&expectedLines.some(l=>(allocatedUnitMap.get(l.id)??0)>l.quantity);

  const stepBlockingInfo:({reason:string;targetId?:string})|null=(()=>{
    if(step===0) {
      if(!categoryOffers.length||!serviceOffers.length) return {reason:"Select an approved product category and available inspection service.",targetId:"step1-services-group"};
      if(goldenSampleBlockedInStep1) return {reason:`Golden Sample Matching is blocked until at least one sealed Golden Sample is active in our vault for ${selectedCategoryName}. Switch to Product Inspection or reserve & seal a sample first.`,targetId:"golden-sample-step1-gate"};
    } else if(step===1) {
      if(manualQuoteMode) return {reason:"Manual quote mode is active for orders above the online cap. Submit the manual quote request above or return to online checkout.",targetId:"step2-manual-quote-card"};
      if(!validQuantity) return {reason:`Enter a valid commissioned quantity (${minQty}–${maxOnlineQty}) for ${templateLabel}.`,targetId:"step2-qty-input"};
      if(serviceKind==="reference_match"&&!selectedRef) return {reason:"Select an active sealed Golden Sample from your warehouse vault.",targetId:"step2-reference-select"};
    } else if(step===2) {
      if(pendingReassociationEvidences.length>0) return {reason:`${pendingReassociationEvidences.length} retained file(s) in 3A require confirmation for ${serviceLabel} (or removal) before continuing.`,targetId:"step3a-section"};
      if(hasPendingCandidates) return {reason:`${pendingCandidateCount} unconfirmed candidate row(s) in 3A must be confirmed or discarded before continuing.`,targetId:"step3a-section"};
      if(expectedLines.length===0) return {reason:`Add at least 1 confirmed product line in 3B (same style with ${clampedQty} unit${clampedQty===1?"":"s"} only needs 1 line with Qty = ${clampedQty}).`,targetId:"step3b-add-line-btn"};
      if(incompleteExpectedLines.length>0) {
        const badIdx=expectedLines.findIndex(l=>missingLineFields(l).length>0);
        const firstMissing=missingLineFields(expectedLines[badIdx])[0]??"product_name";
        return {reason:`Complete ${missingLineFields(expectedLines[badIdx]).join(", ")} on Product Line #${badIdx+1} in 3B.`,targetId:`step3b-line-${badIdx}-${firstMissing}`};
      }
      if(hasQuantityMismatch) return {reason:`Declared product line units (${expectedTotalQty}) must equal Step 2 commissioned quantity (${clampedQty}). Click "Sync Commissioned Qty" or adjust lines in 3B.`,targetId:"step3b-qty-mismatch-sync"};
      if(needsCompareSizeAck) return {reason:"Comparison sample rows declare different sizes. Check the size-mismatch confirmation box in 3B or align sample sizes.",targetId:"step3b-size-mismatch-check"};
      if(hasOverAllocatedParcel) return {reason:"Allocated parcel quantities exceed line quantity in 3C. Adjust parcel allocations.",targetId:"step3c-section"};
      if(productLink.trim()&&!/^https?:\/\//i.test(productLink.trim())) return {reason:"Product link must start with https:// or http://.",targetId:"step3b-product-link"};
    } else if(step===3) {
      if(toleranceMode==="custom") {
        const configured=measurementChecks.filter(check=>pointTolerances[check.key]?.target||pointTolerances[check.key]?.plusMinus);
        if(!configured.length||configured.length!==buildToleranceRules().length) {
          return {reason:"Enter a valid target and tolerance for every started measurement row (or switch to Record measured values).",targetId:"step4b-tolerances"};
        }
      }
    } else if(step===4) {
      if(!hasValidQuote) return {reason:"Calculate an official server quote in Step 5 before continuing to Payment Preview.",targetId:"step5-get-quote-btn"};
      if(!allConsentsChecked) return {reason:"Accept the platform policies and check all 5 disclosures above to continue to Payment Preview.",targetId:"step5-policy-accept-check"};
    }
    return null;
  })();

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

    {error&&<><ErrorBlock error={error}/><button type="button" onClick={reloadCatalog}>Retry services</button></>}
    {!data&&!error&&<p role="status">Loading available inspection services…</p>}
    {data&&!offers.length&&<Empty>No inspection services are available for online booking. <Link href="/support">Contact support</Link>.</Empty>}
    {wizardError&&<ErrorBlock error={wizardError}/>}
    {draftLoadFailed&&<button className="button" type="button" onClick={()=>location.reload()}>Reload saved draft</button>}
    {conflict&&<div className="notice" role="status">
      <strong>This draft changed in another window.</strong>
      <p>{reviewingConflict?"Review your recovered edits, then choose Save Draft to apply them.":"The latest saved draft is open. Your unsaved edits are still in this tab."}</p>
      <div className="actions">
        {!reviewingConflict&&<button type="button" className="button" onClick={()=>{
          draftWrite.current=null;
          restoreEditor(conflict.editor);
          setReviewingConflict(true);
        }}>Review my unsaved edits</button>}
        <button type="button" className="button" onClick={()=>{
          removeDraftRecovery(recoveryKey);
          location.reload();
        }}>Keep latest saved draft</button>
      </div>
    </div>}
    {savedNotice&&!wizardError&&<div className="notice ok" role="status">{savedNotice}</div>}
    {busyMessage&&<div className="notice" role="status">{busyMessage}</div>}

    {data&&!error&&offers.length>0&&<div className="wizard-shell">
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
              const isSelected=Boolean(catId&&activeCategoryId===catId)||categoryKey===cat.key;
              return <button
                key={cat.key}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-disabled={!isAvailable}
                disabled={!isAvailable}
                className={`option-card ${isSelected?"selected":""} ${!isAvailable?"disabled":""}`}
                onClick={()=>{
                  if(!isAvailable||isSelected) return;
                  setCategoryKey(cat.key);
                  const nextCatOffers=offers.filter(o=>o.category_id===catId);
                  const match=nextCatOffers.find(o=>o.service===serviceKind)??nextCatOffers[0];
                  if(match) chooseOffer(match);
                }}
              >
                <span className="icon" aria-hidden="true"><PlatformIcon name={cat.icon}/></span>
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
          {serviceSwitchBanner&&(
            <div className="notice ok" data-testid="step1-service-switch-banner" role="status" style={{marginBottom:12}}>
              {serviceSwitchBanner}
            </div>
          )}
          <div className="wizard-services" id="step1-services-group" role="radiogroup" aria-label="Inspection Service">
            {wizardServiceCards.map(card=>{
              const matchingOffers=categoryOffers.filter(o=>o.service===card.service);
              const isServiceAvailable=matchingOffers.length>0;
              const unitPrices=matchingOffers.map(o=>o.rules.unit_cents).filter((x):x is number=>x!=null);
              const pkgPrices=matchingOffers.map(o=>o.rules.package_cents).filter((x):x is number=>x!=null);
              const lowestUnit=Math.min(...unitPrices),highestUnit=Math.max(...unitPrices);
              const lowestPackage=Math.min(...pkgPrices),highestPackage=Math.max(...pkgPrices);
              const priceText=unitPrices.length>0
                ?`${lowestUnit<highestUnit?"From ":""}${usd(lowestUnit)} / item`
                :pkgPrices.length>0
                  ?`${usd(lowestPackage)}${lowestPackage<highestPackage?"–"+usd(highestPackage):""} / set`
                  :isServiceAvailable?"Quote on request":"Not available";
              const isSelected=serviceKind===card.service;
              const isGoldenService=card.service==="reference_match";
              return <button
                key={card.service}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={!isServiceAvailable}
                className={`option-card ${isSelected?"selected":""} ${!isServiceAvailable?"disabled":""}`}
                onClick={()=>{
                  if(!isServiceAvailable||isSelected) return;
                  switchToServiceKind(card.service);
                }}
              >
                <div className="row between" style={{width:"100%"}}>
                  <span className="icon" aria-hidden="true"><PlatformIcon name={card.icon}/></span>
                  <Tag tone={isSelected?"blue":"gray"}>{priceText}</Tag>
                </div>
                <strong>{card.title}</strong>
                <p>{card.desc}</p>
                {isGoldenService&&refs.data&&!refs.error&&(
                  <div style={{marginTop:4,marginBottom:4}}>
                    <Tag tone={activeRefs.length===0?"yellow":"green"}>
                      {activeRefs.length>0
                        ?`${activeRefs.length} active vault sample${activeRefs.length===1?"":"s"} ready`
                        :pendingCategoryRefs.length>0
                          ?`${pendingCategoryRefs.length} awaiting vault seal (not active yet)`
                          :"Requires an approved reference sample"}
                    </Tag>
                  </div>
                )}
                <span className="price-pill">{card.unitLabel}</span>
              </button>;
            })}
          </div>
          {goldenSampleBlockedInStep1&&(
            <div className="card flat" id="golden-sample-step1-gate" data-testid="golden-sample-step1-gate" role="region" aria-label="Golden Sample Prerequisite" style={{marginTop:14,borderColor:"var(--amber-600,#d97706)",background:"rgba(245,158,11,0.06)"}}>
              <div className="row between flexwrap" style={{gap:8}}>
                <strong>Prerequisite not met: no active Golden Sample sealed in vault for {selectedCategoryName}</strong>
                <Tag tone="yellow">Step 2 Blocked Until Ready</Tag>
              </div>
              <p className="small" style={{margin:"8px 0 6px"}}>
                {pendingCategoryRefs.length>0
                  ?`You have ${pendingCategoryRefs.length} reserved reference sample(s) currently in Pending Vault Sealing (${pendingCategoryRefs.map((r:Row)=>`${r.code??r.item_id}${r.seal_code?` · Seal ${r.seal_code}`:""}`).join(", ")}). It becomes selectable only after warehouse staff apply a tamper-evident GS-* seal and scan it into safe vault storage.`
                  :readyToReserveItems.length>0
                    ?`You have ${readyToReserveItems.length} inspected item(s) stored in warehouse (${readyToReserveItems.map((i:Row)=>i.code).slice(0,3).join(", ")}), awaiting your "Reserve as Reference Sample" instruction in Items.`
                    :inFlightInspectionOrders.length>0
                      ?`Your inspection order (${inFlightInspectionOrders[0].public_no}) is currently "${label(inFlightInspectionOrders[0].state)}". Complete inspection, approve the report, and reserve an item in Vault Storage before booking Golden Sample Matching.`
                      :expiredCategoryRefs.length>0
                        ?`All ${expiredCategoryRefs.length} reference sample(s) previously stored for ${selectedCategoryName} have expired. Reserve a fresh item before booking a new comparison.`
                        :otherCategoryActiveRefs.length>0
                          ?`You have ${otherCategoryActiveRefs.length} active Golden Sample(s), but they belong to another product category rather than ${selectedCategoryName}.`
                          :`Your account currently has 0 active sealed Golden Samples in ${selectedCategoryName}. Golden Sample Matching compares incoming units against an existing approved item stored in our vault.`}
              </p>
              <div className="row flexwrap" style={{gap:6,margin:"6px 0 8px"}}>
                <Tag tone="gray">Active sealed: 0</Tag>
                <Tag tone={pendingCategoryRefs.length>0?"yellow":"gray"}>Pending vault seal: {pendingCategoryRefs.length}</Tag>
                <Tag tone={readyToReserveItems.length>0?"blue":"gray"}>Ready to reserve: {readyToReserveItems.length}</Tag>
                <Tag tone={inFlightInspectionOrders.length>0?"blue":"gray"}>In-flight orders: {inFlightInspectionOrders.length}</Tag>
              </div>
              <ol className="small muted" style={{margin:"4px 0 10px",paddingLeft:18,lineHeight:1.5}}>
                <li>Inspect at least one sample under <strong>Product Inspection</strong> or <strong>Sample Comparison</strong> first.</li>
                <li>Open <strong>Items → Reference samples</strong> after inspection and reserve an approved garment as your reference sample.</li>
                <li>Our warehouse applies a tamper-evident <code>GS-*</code> seal and scans it into vault location storage.</li>
                <li>Return here to select your active vault sample and submit candidate restock units for side-by-side comparison.</li>
              </ol>
              <div className="actions">
                <button type="button" className="button sm primary" onClick={()=>switchToServiceKind("inspection")}>Switch to Product Inspection (Inspect a Sample First)</button>
                <Link className="button sm" href="/items#reference-samples">View My Reference Samples</Link>
                <Link className="button sm" href="/services/reference">Golden Sample Service Guide</Link>
              </div>
            </div>
          )}
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
                  {filteredChecks.filter(check=>check.required).length} required checks per item · {filteredShots.length>0?`${filteredShots.length} required photo angles`:`${allOfferShots.length} standard studio photo angles`}
                </small>
              </div>

              {!manualQuoteMode && (
                <div className="field">
                  <label>{serviceKind==="compare"?"Samples to compare":serviceKind==="reference_match"?"Candidate items to match":"Number of items to inspect"}
                    <input
                      id="step2-qty-input"
                      type="number"
                      min={minQty}
                      max={maxOnlineQty}
                      disabled={Boolean(busyMessage)||minQty===maxOnlineQty}
                      className={!validQuantity?"input-warn":undefined}
                      aria-invalid={!validQuantity||undefined}
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
                <select id="step2-reference-select" value={referenceId} disabled={!refs.data||Boolean(refs.error)||Boolean(busyMessage)}
                  className={!selectedRef?"input-warn":undefined}
                  aria-invalid={!selectedRef||undefined}
                  onChange={e=>{setReferenceId(e.target.value);setServerQuote(undefined);}}>
                  <option value="">— Select an active Golden Sample —</option>
                  {activeRefs.map((r:Row)=><option key={r.reference_id} value={r.reference_id}>
                    {(r.code??r.item_id)}{r.seal_code?` · Seal ${r.seal_code}`:""}{r.safe_location_code?` · Vault ${r.safe_location_code}`:""} · {r.in_use?"In use for another comparison":"Sealed until "+stamp(r.expires_at)}
                  </option>)}
                </select>
              </label>
              {selectedRef&&(
                <div className="line-note" data-testid="selected-golden-sample-meta" style={{marginTop:8}}>
                  <strong>Vault reference {selectedRef.code??selectedRef.item_id}</strong>
                  {selectedRef.seal_code?` · Seal ${selectedRef.seal_code}`:""}
                  {selectedRef.safe_location_code?` · Vault ${selectedRef.safe_location_code}`:""}
                  {` · Expires ${stamp(selectedRef.expires_at)}`}
                  {selectedRef.in_use?" · Currently assigned to another active comparison":""}
                </div>
              )}
              {refs.error&&<><ErrorBlock error={refs.error}/><button type="button" onClick={refs.reload}>Retry Golden Samples</button></>}
              {!refs.data&&!refs.error&&<p role="status">Loading Golden Samples…</p>}
              {refs.data&&!refs.error&&activeRefs.length===0&&<div className="line-note warning" data-testid="step2-golden-empty-note" style={{marginTop:8}}>
                No active Golden Samples are available in {selectedCategoryName}
                {pendingCategoryRefs.length>0?` (${pendingCategoryRefs.length} awaiting warehouse GS-* vault seal)`:
                  readyToReserveItems.length>0?` (${readyToReserveItems.length} inspected item(s) awaiting reservation in Items)`:
                  inFlightInspectionOrders.length>0?` (inspection order ${inFlightInspectionOrders[0].public_no} is currently "${label(inFlightInspectionOrders[0].state)}")`:""}.
                {" "}Open <Link href="/items#reference-samples">Items → Reference samples</Link> to reserve &amp; seal an approved sample, or return to Step 1 to choose Product Inspection.
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
                    setExpectedLines(prev=>buildComparisonSampleLines(n,prev));
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
              <div className="card flat" id="step2-manual-quote-card" style={{marginTop:16,borderColor:"#98b4ee",background:"#f4f8ff"}}>
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
                  <div className="notice" style={{marginTop:12}}>
                    {manualQuoteSubmitted.requestState==="expired"?"The manual quote has expired. Request an updated quote from this order.":
                      manualQuoteSubmitted.requestState==="offered"?"Your manual quote is ready for review.":
                      "Your request is with our team. We’ll notify you when the quote is ready."}{" "}
                    <Link href={`/orders/${manualQuoteSubmitted.orderNo}#${manualQuoteSubmitted.requestState==="offered"?"inspection-quote":"manual-quote-request"}`}>
                      Order {manualQuoteSubmitted.orderNo} ({manualQuoteSubmitted.qty} items) →
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
                  <p className="small muted">Catalog SLA: {activeOffer.rules.business_days} business days starting only after all commissioned items physically arrive, are scanned into warehouse intake, and pass ownership identification.</p>}
              </div>
              {activeOffer&&<Tag tone="green">{usd(activeOffer.rules.unit_cents??activeOffer.rules.package_cents)} {activeOffer.rules.unit_cents!=null?"/ item":"/ set"}</Tag>}
            </div>
          </Panel>
          <div className="line-note warning">
            Final payable pricing is locked by the server-side price snapshot calculated in Step 5.
          </div>
        </>}

        {step===2&&<Panel
          title="Step 3 · Purchase Evidence, Expected Product Lines & Inbound Parcels"
          subtitle="Upload purchase screenshots or paste SKU rows for human confirmation, manage multi-SKU quantities cleanly, and map domestic parcels without editing 50 individual rows."
          badge={<Tag tone={hasQuantityMismatch?"red":!hasConfirmedLines||hasPendingCandidates||pendingReassociationEvidences.length>0?"yellow":"blue"}>
            {hasConfirmedLines
              ?`${confirmedExpectedLines.length} confirmed line${confirmedExpectedLines.length===1?"":"s"} · ${expectedTotalQty}/${clampedQty} units`
              :`0 confirmed lines · ${clampedQty} ${clampedQty===1?"Unit":"Units"} commissioned`}
          </Tag>}
        >
          {serviceKind==="reference_match"&&(
            <div className="line-note" data-testid="golden-sample-step3-context" style={{marginBottom:12}}>
              <strong>Golden Sample Matching Scope:</strong> Declare only the <strong>{clampedQty} incoming candidate unit{clampedQty===1?"":"s"}</strong> below. Your vaulted reference sample {selectedRef?<><strong>{selectedRef.code??selectedRef.item_id}</strong>{selectedRef.seal_code?` (Seal ${selectedRef.seal_code})`:""}</>:"(selected in Step 2)"} stays sealed in warehouse storage and is excluded from incoming shipment counts.
            </div>
          )}
          {serviceKind==="compare"&&(
            <div className="card flat" data-testid="sample-compare-quick-init" style={{marginBottom:12}}>
              <div className="row between flexwrap" style={{gap:8}}>
                <div>
                  <strong>Sample Comparison Setup ({clampedQty}-Sample Package · {usd(activeOffer?.rules.package_cents)})</strong>
                  <p className="small muted" style={{margin:"4px 0 0"}}>
                    List the {clampedQty} supplier samples side by side (1 unit per sample line) so warehouse intake keeps Supplier A / B{clampedQty===3?" / C":""} separated.
                  </p>
                </div>
                <button
                  type="button"
                  className={`button sm ${expectedLines.length!==clampedQty?"primary":""}`}
                  onClick={()=>{
                    const nextLines=buildComparisonSampleLines(clampedQty,[]);
                    if(!itemName.trim()) setItemName("Multi-Supplier Sample Comparison");
                    setSizeMismatchConfirmed(false);
                    applyExpectedLinesUpdate(nextLines);
                  }}
                >{expectedLines.length===0?`+ Initialize ${clampedQty} Comparison Sample Lines`:`Reset to ${clampedQty} Sample Rows`}</button>
              </div>
              {compareHasDifferentSizes||compareHasDifferentNames?(
                <div className="line-note warning" data-testid="compare-condition-warning" style={{marginTop:10}}>
                  <div>
                    <strong>Comparison Check:</strong>{" "}
                    {compareHasDifferentSizes
                      ?`Your candidate rows declare differing sizes (${[...compareDeclaredSizes].join(", ")}). Sample Comparison works best when comparing matching sizes/specs side by side.`
                      :"Your candidate rows declare differing product names. Ensure suppliers are offering the same comparable garment style."}
                  </div>
                  {compareHasDifferentSizes&&(
                    <label className="checkrow" style={{marginTop:6}}>
                      <input
                        id="step3b-size-mismatch-check"
                        type="checkbox"
                        checked={sizeMismatchConfirmed}
                        onChange={e=>setSizeMismatchConfirmed(e.target.checked)}
                      />
                      <span>I confirm the different sizes ({[...compareDeclaredSizes].join(", ")}) are intentional and still want a side-by-side comparison.</span>
                    </label>
                  )}
                </div>
              ):null}
            </div>
          )}
          {/* 3A · PURCHASE ORDER EVIDENCE & CANDIDATE EXTRACTION QUEUE */}
          <div className="wizard-section-head" id="step3a-section">
            <div>
              <div className="label">3A · PURCHASE ORDER EVIDENCE &amp; STRUCTURED EXTRACTION</div>
              <p className="small muted" style={{margin:"4px 0 0"}}>
                Attach 1688/Taobao order screenshots, packing lists, CSV/TSV sheets, or PDF order records for warehouse reference. Unconfirmed candidate rows never become formal items or billing basis until you confirm them.
              </p>
            </div>
            <div className="wizard-batch-actions">
              <label className="button sm primary" style={{cursor:"pointer"}}>
                Upload Screenshots / CSV / PDF
                <input
                  id="step3a-evidence-upload"
                  type="file"
                  multiple
                  accept="image/*,.pdf,.csv,.tsv,.txt"
                  style={{display:"none"}}
                  onChange={e=>{
                    const picked=Array.from(e.target.files??[]);
                    e.currentTarget.value="";
                    void handleEvidenceFiles(picked);
                  }}
                />
              </label>
              <button
                type="button"
                className={`button sm ${showPasteImport?"primary":""}`}
                onClick={()=>setShowPasteImport(open=>!open)}
              >{showPasteImport?"Close Paste Box":"Paste Order / CSV / 1688 Text"}</button>
            </div>
          </div>

          <div className="line-note" data-testid="step3a-no-auto-ocr-note" style={{marginTop:8}}>
            <strong>Reference only (No Auto-OCR):</strong> Automated image/PDF OCR is not active (<strong>OPEN</strong>). Files uploaded here are SHA-256 deduplicated and kept strictly in Step 3A for warehouse intake reference (never copied into Step 3B reference photos and never billed as SKUs). Convert your order into confirmed lines using <strong>+ Transcribe Row</strong>, <strong>Paste Order / CSV / 1688 Text</strong>, or <strong>Quick Matrix (3B)</strong>.
          </div>

          {evidenceDuplicateWarning&&<div className="notice warning" role="alert" style={{marginTop:10}}>
            <strong>Duplicate evidence blocked:</strong> {evidenceDuplicateWarning}
          </div>}

          {showPasteImport&&<div className="card flat" style={{marginTop:10}}>
            <div className="row between flexwrap" style={{marginBottom:8}}>
              <strong>Paste Order Sheet, CSV/TSV, or 1688/Taobao Rows</strong>
              <span className="small muted">Supports columns: SKU, Product Name, Color, Size, Qty, Supplier, Tracking, PO Ref</span>
            </div>
            <div className="fields" style={{marginBottom:8}}>
              <div className="field">
                <label>Default supplier for batch
                  <input value={pasteSupplier} onChange={e=>setPasteSupplier(e.target.value)} placeholder={supplierRef||"e.g. Hangzhou Knitwear"}/>
                </label>
              </div>
              <div className="field">
                <label>Purchase order ref (optional)
                  <input value={pastePoRef} onChange={e=>setPastePoRef(e.target.value)} placeholder="e.g. PO-1688-202611"/>
                </label>
              </div>
              <div className="field">
                <label>Default domestic waybill (optional)
                  <input value={pasteTracking} onChange={e=>setPasteTracking(e.target.value)} placeholder="e.g. SF1234567890"/>
                </label>
              </div>
            </div>
            <textarea
              className="input"
              rows={5}
              aria-label="Paste structured purchase rows"
              value={pasteImportText}
              onChange={e=>setPasteImportText(e.target.value)}
              placeholder={"SKU,Product Name,Color,Size,Qty,Supplier,Tracking\nHD-BLK-S,Heavyweight Cotton Hoodie,Black,S,8,Hangzhou Knitwear,SF1000500001\nHD-BLK-M,Heavyweight Cotton Hoodie,Black,M,8,Hangzhou Knitwear,SF1000500001"}
            />
            <div className="actions" style={{marginTop:8,marginBottom:0}}>
              <button type="button" className="button sm primary" onClick={()=>void runPasteExtract()}>Parse into Candidate Confirmation Queue</button>
              <button type="button" className="button sm" onClick={()=>setShowPasteImport(false)}>Cancel</button>
            </div>
          </div>}

          {purchaseEvidences.length>0&&<div className="evidence-list" style={{marginTop:10}}>
            {purchaseEvidences.map(ev=><div key={ev.id} className={`card flat candidate-card ${ev.extraction_status==="pending_reassociation"||(ev.extraction_status==="needs_confirmation"&&ev.candidates.length>0)?"needs-confirm":""}`}>
              <div className="row between flexwrap" style={{gap:10}}>
                <div className="row" style={{gap:10,alignItems:"flex-start"}}>
                  {ev.media_id&&<img className="thumb" src={`/api/v1/media/${ev.media_id}`} alt={ev.file_name} style={{width:56,height:56,objectFit:"cover",borderRadius:8}}/>}
                  <div>
                    <strong>{ev.file_name}</strong>
                    <div className="small muted">
                      SHA-256 <span className="mono">{ev.sha256.slice(0,12)}</span> · {(ev.size_bytes/1024).toFixed(1)} KB
                      {ev.extraction_note&&<> · {ev.extraction_note}</>}
                    </div>
                  </div>
                </div>
                <div className="row flexwrap" style={{gap:6}}>
                  <Tag tone={ev.extraction_status==="confirmed"?"green":ev.extraction_status==="pending_reassociation"||(ev.extraction_status==="needs_confirmation"&&ev.candidates.length>0)?"yellow":"gray"}>
                    {ev.extraction_status==="pending_reassociation"
                      ?"Pending re-association"
                      :ev.extraction_status==="confirmed"
                        ?"Confirmed into 3B"
                        :ev.extraction_status==="needs_confirmation"&&ev.candidates.length>0
                          ?"Needs confirmation"
                          :"Reference only (No Auto-OCR)"}
                  </Tag>
                  {ev.extraction_status==="pending_reassociation"&&(
                    <button type="button" className="button sm primary" onClick={()=>confirmRetainedEvidence(ev.id)}>Confirm for {serviceLabel}</button>
                  )}
                  {ev.media_id&&<a className="button sm" href={`/api/v1/media/${ev.media_id}`} target="_blank" rel="noreferrer">View</a>}
                  <button type="button" className="button sm" onClick={()=>addManualCandidateRow(ev.id)}>+ Transcribe Row</button>
                  <button type="button" className="button sm" onClick={()=>setShowPasteImport(true)}>Paste Order Text</button>
                  <button type="button" className="button sm" onClick={()=>{
                    setShowMatrixBuilder(true);
                    document.getElementById("step3b-section")?.scrollIntoView({behavior:"smooth",block:"start"});
                  }}>Open Quick Matrix (3B)</button>
                  <button type="button" className="button sm" onClick={()=>discardEvidenceQueue(ev.id,true)}>Remove File</button>
                </div>
              </div>
              {ev.extraction_status==="pending_reassociation"&&(
                <div className="line-note warning" data-testid="evidence-reassociation-notice" style={{marginTop:8}}>
                  Retained across service switch — confirm this file applies to <strong>{serviceLabel}</strong> or remove it before continuing.
                </div>
              )}

              <div className="fields" style={{marginTop:10}}>
                <div className="field">
                  <label>Source supplier
                    <input
                      value={ev.supplier_alias}
                      onChange={e=>setPurchaseEvidences(prev=>prev.map(x=>x.id===ev.id?{...x,supplier_alias:e.target.value}:x))}
                      placeholder="Supplier / shop name"
                    />
                  </label>
                </div>
                <div className="field">
                  <label>Platform / channel
                    <input
                      value={ev.platform_source}
                      onChange={e=>setPurchaseEvidences(prev=>prev.map(x=>x.id===ev.id?{...x,platform_source:e.target.value}:x))}
                      placeholder="1688 / Taobao / Factory"
                    />
                  </label>
                </div>
                <div className="field">
                  <label>Purchase order number
                    <input
                      value={ev.purchase_order_ref}
                      onChange={e=>setPurchaseEvidences(prev=>prev.map(x=>x.id===ev.id?{...x,purchase_order_ref:e.target.value}:x))}
                      placeholder="PO / seller order no."
                    />
                  </label>
                </div>
              </div>

              {ev.candidates.length>0&&<div className="candidate-queue" style={{marginTop:10}}>
                <div className="row between flexwrap" style={{marginBottom:6}}>
                  <strong className="small">Pending Confirmation Queue ({ev.candidates.length} candidate rows — excluded from order &amp; quote until confirmed)</strong>
                  <div className="row" style={{gap:6}}>
                    <button type="button" className="button sm primary" onClick={()=>confirmEvidenceCandidates(ev.id)}>Confirm Selected &amp; Add to Order</button>
                    <button type="button" className="button sm" onClick={()=>discardEvidenceQueue(ev.id,false)}>Discard Queue</button>
                  </div>
                </div>
                <div className="table-wrap wizard-items">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{width:36}}>Use</th>
                        <th>SKU / Style</th>
                        <th>Product Name *</th>
                        <th>Color *</th>
                        <th>Size *</th>
                        <th>Qty *</th>
                        <th>Supplier</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ev.candidates.map(cand=>{
                        const missing=missingLineFields(cand);
                        return <tr key={cand.id}>
                          <td data-label="Use">
                            <input
                              type="checkbox"
                              aria-label={`Select candidate ${cand.sku_code||cand.product_name||cand.id}`}
                              checked={cand.selected}
                              onChange={e=>updateCandidateRow(ev.id,cand.id,{selected:e.target.checked})}
                            />
                          </td>
                          <td data-label="SKU"><input className="input" style={{minWidth:96}} value={cand.sku_code} onChange={e=>updateCandidateRow(ev.id,cand.id,{sku_code:e.target.value})} placeholder="SKU"/></td>
                          <td data-label="Product Name"><input className={`input ${missing.includes("product_name")?"input-warn":""}`} style={{minWidth:130}} value={cand.product_name} onChange={e=>updateCandidateRow(ev.id,cand.id,{product_name:e.target.value})} placeholder="Product name"/></td>
                          <td data-label="Color"><input className={`input ${missing.includes("color")?"input-warn":""}`} style={{minWidth:84}} value={cand.color_declared} onChange={e=>updateCandidateRow(ev.id,cand.id,{color_declared:e.target.value})} placeholder="Color"/></td>
                          <td data-label="Size"><input className={`input ${missing.includes("size")?"input-warn":""}`} style={{minWidth:64}} value={cand.size_label} onChange={e=>updateCandidateRow(ev.id,cand.id,{size_label:e.target.value})} placeholder="Size"/></td>
                          <td data-label="Qty"><input className={`input ${missing.includes("quantity")?"input-warn":""}`} type="number" min={1} max={300} style={{width:72}} value={cand.quantity||""} onChange={e=>updateCandidateRow(ev.id,cand.id,{quantity:Number(e.target.value)||0})}/></td>
                          <td data-label="Supplier"><input className="input" style={{minWidth:110}} value={cand.supplier_alias} onChange={e=>updateCandidateRow(ev.id,cand.id,{supplier_alias:e.target.value})} placeholder="Supplier"/></td>
                          <td data-label="Status">
                            {missing.length>0?<Tag tone="yellow">Missing: {missing.join(", ")}</Tag>:<Tag tone="blue">Ready to confirm</Tag>}
                          </td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              </div>}
            </div>)}
          </div>}

          <div className="sep"/>

          {/* 3B · EXPECTED PRODUCT LINES (SKU × COLOR × SIZE × QTY BATCH MANAGEMENT) */}
          <div className="wizard-section-head" id="step3b-section">
            <div>
              <div className="label">3B · EXPECTED PRODUCT LINES ({confirmedExpectedLines.length>0?`${confirmedExpectedLines.length} confirmed SKU / Variant line${confirmedExpectedLines.length===1?"":"s"} · ${expectedTotalQty} units`:"0 confirmed lines"})</div>
              <p className="small muted" style={{margin:"4px 0 0"}}>
                Group items by SKU, color, size, and supplier instead of editing 50 identical physical rows. Physical Sample IDs are expanded automatically for warehouse intake.
              </p>
            </div>
            <div className="wizard-batch-actions">
              <button type="button" id="step3b-add-line-btn" className="button sm primary" onClick={()=>addExpectedLine()}>+ Add Product Line</button>
              <button type="button" className={`button sm ${showMatrixBuilder?"primary":""}`} onClick={()=>setShowMatrixBuilder(open=>!open)}>Quick Matrix (Color × Size)</button>
              {expectedLines.length>1&&<button type="button" className="button sm" onClick={mergeDuplicateExpectedLines}>Merge Duplicates</button>}
              {expectedUndoStack.length>0&&<button type="button" className="button sm" onClick={undoLastExpectedBatch}>Undo Batch</button>}
            </div>
          </div>

          <div className="fields" style={{marginTop:10}}>
            <div className="field">
              <label>Order primary product / style name *
                <input
                  id="step3b-product-name-input"
                  value={itemName}
                  maxLength={120}
                  onChange={e=>{setItemName(e.target.value);setServerQuote(undefined);}}
                  placeholder="e.g. Heavyweight Cotton Hoodie"
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
              <label>Product listing or tech pack URL (optional)
                <input
                  id="step3b-product-link"
                  type="url"
                  className={productLink.trim()&&!/^https?:\/\//i.test(productLink.trim())?"input-warn":undefined}
                  aria-invalid={(Boolean(productLink.trim())&&!/^https?:\/\//i.test(productLink.trim()))||undefined}
                  value={productLink}
                  onChange={e=>setProductLink(e.target.value)}
                  placeholder="https://detail.1688.com/... or tech pack URL"
                />
              </label>
            </div>
          </div>

          {showMatrixBuilder&&<div className="card flat" style={{marginTop:12}}>
            <div className="row between flexwrap" style={{marginBottom:8}}>
              <strong>Quick Matrix Generator (Colors × Sizes)</strong>
              <span className="small muted">Creates expected product lines in one click without manual repetition</span>
            </div>
            <div className="fields">
              <div className="field">
                <label>Product name
                  <input value={matrixProductName} onChange={e=>setMatrixProductName(e.target.value)} placeholder={itemName||"Heavyweight Hoodie"}/>
                </label>
              </div>
              <div className="field">
                <label>SKU prefix
                  <input value={matrixSkuPrefix} onChange={e=>setMatrixSkuPrefix(e.target.value)} placeholder={baseSku!=="ITEM"?baseSku:"HD-2026"}/>
                </label>
              </div>
              <div className="field">
                <label>Colors (comma-separated)
                  <input value={matrixColors} onChange={e=>setMatrixColors(e.target.value)} placeholder="Black, Heather Gray"/>
                </label>
              </div>
              <div className="field">
                <label>Sizes (comma-separated)
                  <input value={matrixSizes} onChange={e=>setMatrixSizes(e.target.value)} placeholder="S, M, L, XL"/>
                </label>
              </div>
              <div className="field">
                <label>Qty per combination
                  <input type="number" min={1} max={200} value={matrixDefaultQty} onChange={e=>setMatrixDefaultQty(Number(e.target.value)||1)}/>
                </label>
              </div>
              <div className="field">
                <label>Supplier (optional)
                  <input value={matrixSupplier} onChange={e=>setMatrixSupplier(e.target.value)} placeholder={supplierRef||"Supplier name"}/>
                </label>
              </div>
            </div>
            <div className="actions" style={{marginTop:10,marginBottom:0}}>
              <button type="button" className="button sm primary" onClick={applyMatrixLines}>Generate Matrix Lines</button>
              <button type="button" className="button sm" onClick={()=>setShowMatrixBuilder(false)}>Close</button>
            </div>
          </div>}

          {expectedLines.length>0&&(
            <>
              <div className="wizard-batch-toolbar" style={{marginTop:12}}>
                <div className="row flexwrap" style={{gap:8}}>
                  <input
                    className="input"
                    style={{maxWidth:180}}
                    placeholder="Bulk supplier name"
                    value={bulkSupplierInput}
                    onChange={e=>setBulkSupplierInput(e.target.value)}
                  />
                  <input
                    className="input"
                    style={{maxWidth:180}}
                    placeholder="Bulk waybill (optional)"
                    value={bulkTrackingInput}
                    onChange={e=>setBulkTrackingInput(e.target.value)}
                  />
                  <button type="button" className="button sm" onClick={()=>bulkFillExpectedLines("empty")}>Fill Empty Fields</button>
                  <button type="button" className="button sm" onClick={()=>bulkFillExpectedLines("all")}>Overwrite All Lines</button>
                </div>
                <label className="checkrow" style={{margin:0}}>
                  <input
                    type="checkbox"
                    checked={syncQuantityFromLines}
                    onChange={e=>{
                      const next=e.target.checked;
                      setSyncQuantityFromLines(next);
                      if(next) applyExpectedLinesUpdate(expectedLines,{recordUndo:false,forceSync:true});
                    }}
                  />
                  <span className="small">Auto-sync Step 2 commissioned quantity ({clampedQty}) to line total ({expectedTotalQty})</span>
                </label>
              </div>

              <div className="table-wrap wizard-items" style={{marginTop:10}}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="col-idx" style={{width:44}}>#</th>
                      <th>SKU / Style</th>
                      <th>Product Name *</th>
                      <th>Color *</th>
                      <th>{isApparelCategory?"Size *":"Spec *"}</th>
                      <th>Qty *</th>
                      <th>Supplier</th>
                      <th>Waybill</th>
                      <th>Note</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expectedLines.map((line,idx)=>{
                      const missing=missingLineFields(line);
                      return <tr key={line.id}>
                        <td className="mono col-idx">{String(idx+1).padStart(2,"0")}</td>
                        <td data-label="SKU"><input id={`step3b-line-${idx}-sku_code`} className="input" style={{minWidth:68}} aria-label={`Line ${idx+1} SKU`} value={line.sku_code} onChange={e=>updateExpectedLine(line.id,{sku_code:e.target.value})} placeholder="HD-BLK-M"/></td>
                        <td data-label="Product Name"><input id={`step3b-line-${idx}-product_name`} aria-invalid={missing.includes("product_name")||undefined} className={`input ${missing.includes("product_name")?"input-warn":""}`} style={{minWidth:96}} aria-label={`Line ${idx+1} product name`} value={line.product_name} onChange={e=>updateExpectedLine(line.id,{product_name:e.target.value})} placeholder="Product name"/></td>
                        <td data-label="Color"><input id={`step3b-line-${idx}-color`} aria-invalid={missing.includes("color")||undefined} className={`input ${missing.includes("color")?"input-warn":""}`} style={{minWidth:58}} aria-label={`Line ${idx+1} color`} value={line.color_declared} onChange={e=>updateExpectedLine(line.id,{color_declared:e.target.value})} placeholder="Color"/></td>
                        <td data-label="Size"><input id={`step3b-line-${idx}-size`} aria-invalid={missing.includes("size")||undefined} className={`input ${missing.includes("size")?"input-warn":""}`} style={{minWidth:44}} aria-label={`Line ${idx+1} size`} value={line.size_label} onChange={e=>updateExpectedLine(line.id,{size_label:e.target.value})} placeholder="M"/></td>
                        <td data-label="Qty"><input id={`step3b-line-${idx}-quantity`} aria-invalid={missing.includes("quantity")||undefined} className={`input ${missing.includes("quantity")?"input-warn":""}`} type="number" min={1} max={300} style={{width:52}} aria-label={`Line ${idx+1} quantity`} value={line.quantity||""} onChange={e=>updateExpectedLine(line.id,{quantity:Math.max(0,Math.floor(Number(e.target.value)||0))})}/></td>
                        <td data-label="Supplier"><input className="input" style={{minWidth:76}} aria-label={`Line ${idx+1} supplier`} value={line.supplier_alias} onChange={e=>updateExpectedLine(line.id,{supplier_alias:e.target.value})} placeholder={supplierRef||"Supplier"}/></td>
                        <td data-label="Waybill"><input className="input" style={{minWidth:82}} aria-label={`Line ${idx+1} waybill`} value={line.tracking_no??""} onChange={e=>updateExpectedLine(line.id,{tracking_no:e.target.value})} placeholder="Optional"/></td>
                        <td data-label="Note"><input className="input" style={{minWidth:64}} aria-label={`Line ${idx+1} note`} value={line.inspection_note??""} onChange={e=>updateExpectedLine(line.id,{inspection_note:e.target.value})} placeholder="Check note"/></td>
                        <td data-label="Actions">
                          <div className="row" style={{gap:4,flexWrap:"nowrap"}}>
                            <button type="button" className="button sm" title="Duplicate line" onClick={()=>duplicateExpectedLine(line)}>Copy</button>
                            <button type="button" className="button sm" title="Remove line" onClick={()=>removeExpectedLine(line.id)}>Remove</button>
                          </div>
                        </td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>

              {expectedTotalQty!==clampedQty&&(()=>{
                const canSyncCompare=serviceKind==="compare"&&(expectedTotalQty===2||expectedTotalQty===3)&&Boolean(offerFor(serviceOffers,templateVariant,expectedTotalQty));
                const canSyncOnline=serviceKind!=="compare"&&expectedTotalQty>=minQty&&expectedTotalQty<=maxOnlineQty&&Boolean(offerFor(templateOffers,templateVariant,expectedTotalQty));
                return <div className="notice warning" id={canSyncCompare||canSyncOnline?undefined:"step3b-qty-mismatch-sync"} tabIndex={canSyncCompare||canSyncOnline?undefined:-1} data-testid="step3-qty-mismatch-banner" role="status" style={{marginTop:10}}>
                  <div className="row between flexwrap" style={{gap:8}}>
                    <span>
                      <strong>Quantity mismatch:</strong> Expected lines total <strong>{expectedTotalQty}</strong> units, while commissioned inspection quantity is <strong>{clampedQty}</strong>.
                      {serviceKind==="compare"&&expectedTotalQty>0&&expectedTotalQty!==2&&expectedTotalQty!==3&&<> Sample Comparison packages only support <strong>2 or 3</strong> supplier samples.</>}
                      {serviceKind!=="compare"&&expectedTotalQty>maxOnlineQty&&<> ({expectedTotalQty} exceeds the online template cap of {maxOnlineQty} units.)</>}
                    </span>
                    <div className="row flexwrap" style={{gap:8}}>
                      {canSyncCompare&&(
                        <button
                          type="button"
                          id="step3b-qty-mismatch-sync"
                          className="button sm primary"
                          onClick={()=>applyExpectedLinesUpdate(expectedLines,{recordUndo:false,forceSync:true})}
                        >Switch to {expectedTotalQty}-Sample Comparison Package</button>
                      )}
                      {canSyncOnline&&(
                        <button
                          type="button"
                          id="step3b-qty-mismatch-sync"
                          className="button sm primary"
                          onClick={()=>applyExpectedLinesUpdate(expectedLines,{recordUndo:false,forceSync:true})}
                        >Sync Commissioned Qty to {expectedTotalQty}</button>
                      )}
                      {expectedTotalQty>maxOnlineQty&&expectedTotalQty<=maximumDraftItems&&serviceKind==="inspection"&&(
                        <button
                          type="button"
                          className="button sm primary"
                          onClick={()=>{
                            setManualBatchQty(expectedTotalQty);
                            setManualQuoteMode(true);
                            setStep(1);
                          }}
                        >Switch to Manual Batch Quote ({expectedTotalQty} units)</button>
                      )}
                      {serviceKind==="compare"&&expectedTotalQty>0&&expectedTotalQty!==clampedQty&&(
                        <button
                          type="button"
                          className="button sm"
                          onClick={()=>{
                            const next=Array.from({length:clampedQty},(_,i)=>expectedLines[i]??{
                              id:`EL-${Date.now().toString(36)}-${i+1}`,
                              sku_code:`CMP-${String.fromCharCode(65+i)}`,
                              product_name:itemName.trim()||expectedLines[0]?.product_name||"Comparison Sample",
                              color_declared:baseColor.trim()||"Standard",
                              size_label:baseSize.trim()||"M",
                              quantity:1,
                              supplier_alias:supplierRef.trim()||`Supplier ${String.fromCharCode(65+i)}`,
                              source_kind:"manual" as const,
                            }).map(l=>({...l,quantity:1}));
                            applyExpectedLinesUpdate(next);
                          }}
                        >Reset to {clampedQty} Sample Lines</button>
                      )}
                    </div>
                  </div>
                </div>;
              })()}
            </>
          )}

          {expectedLines.length===0&&(
            <>
              <div className="card flat" data-testid="step3b-empty-state" style={{marginTop:10,borderStyle:"dashed"}}>
                <div className="row between flexwrap" style={{gap:8}}>
                  <div>
                    <strong>0 confirmed product lines yet</strong>
                    <p className="small muted" style={{margin:"4px 0 0"}}>
                      Same style with <strong>{clampedQty} unit{clampedQty===1?"":"s"}</strong> only needs 1 line with Qty = {clampedQty} (or use Quick Matrix for mixed sizes/colors). Order Summary stays marked <em>Provisional estimate</em> until at least one line is confirmed.
                    </p>
                  </div>
                  <div className="row flexwrap" style={{gap:6}}>
                    <button type="button" className="button sm primary" onClick={()=>addExpectedLine(clampedQty)}>+ Add 1 Product Line (Qty = {clampedQty})</button>
                    <button type="button" className="button sm" onClick={()=>setShowMatrixBuilder(true)}>Open Quick Matrix</button>
                  </div>
                </div>
              </div>
              <div className="fields" style={{marginTop:10}}>
                <div className="field">
                  <label>Default color / variant
                    <input value={baseColor} onChange={e=>{setBaseColor(e.target.value);setServerQuote(undefined);}} placeholder="e.g. Charcoal Gray"/>
                  </label>
                </div>
                <div className="field">
                  <label>{isApparelCategory?"Default size":"Default specification"}
                    <input value={baseSize} onChange={e=>{setBaseSize(e.target.value);setServerQuote(undefined);}} placeholder={isApparelCategory?"M":"Standard"}/>
                  </label>
                </div>
              </div>
            </>
          )}

          <div className="fields" data-testid="step3b-reference-attachment" style={{marginTop:10}}>
            <div className="field">
              <label>3B Reference attachment type
                <select
                  id="step3b-attachment-purpose"
                  value={attachmentPurpose}
                  onChange={e=>{
                    setAttachmentPurpose(e.target.value==="size_chart"?"size_chart":"reference_photo");
                    setServerQuote(undefined);
                  }}
                >
                  <option value="reference_photo">Product reference photo</option>
                  <option value="size_chart">Measurement size chart</option>
                </select>
              </label>
            </div>
            <div className="field">
              <label>Reference photo / size chart (optional)
                <span className="file-picker">
                  <span className="file-picker-btn">Choose file</span>
                  <span className="file-picker-name">{attachmentName||"No file chosen"}</span>
                  <input id="step3b-reference-upload" type="file" accept="image/*" onChange={async e=>{
                    const file=e.target.files?.[0];
                    e.currentTarget.value="";
                    if(!file) return;
                    try {
                      setBusyMessage("Uploading reference image…");
                      const sha256=await sha256FileHex(file);
                      const uploadForm=new FormData();
                      uploadForm.set("photo",file);
                      const uploaded=await request("/me/media","POST",uploadForm);
                      setAttachmentId(uploaded.id);
                      setAttachmentName(file.name);
                      setAttachmentSha256(sha256);
                      setServerQuote(undefined);
                    } catch(err) {
                      setWizardError(err instanceof Error?err.message:"Photo upload failed.");
                    } finally {
                      setBusyMessage("");
                    }
                  }}/>
                </span>
              </label>
              {attachmentName?(
                <div className="row flexwrap" style={{gap:8,marginTop:4}}>
                  <small className="ok">Attached ({attachmentPurpose==="size_chart"?"Size chart":"Reference photo"}): {attachmentName} · Stored only in Step 3B</small>
                  <button
                    type="button"
                    className="button sm"
                    onClick={()=>{
                      setAttachmentId("");
                      setAttachmentName("");
                      setAttachmentSha256(undefined);
                      setServerQuote(undefined);
                    }}
                  >Remove Reference</button>
                </div>
              ):(
                <small className="muted">Stored strictly as Step 3B visual/size reference — separate from Step 3A purchase evidence.</small>
              )}
            </div>
          </div>

          <div className="sep"/>

          {/* 3C · INBOUND PARCELS & CARTON ALLOCATION */}
          <div className="wizard-section-head" id="step3c-section">
            <div>
              <div className="label">3C · INBOUND PARCELS &amp; CARTON ALLOCATION</div>
              <p className="small muted" style={{margin:"4px 0 0"}}>
                Map one mixed-SKU parcel, multiple supplier parcels, or defer tracking registration until sellers ship.
              </p>
            </div>
          </div>

          <div className="parcel-mode-grid" role="radiogroup" aria-label="Inbound parcel mode" style={{marginTop:10}}>
            <button
              type="button"
              role="radio"
              aria-checked={parcelMode==="single"}
              className={`option-card ${parcelMode==="single"?"selected":""}`}
              onClick={()=>{
                setParcelMode("single");
                if(!plannedParcels.length) {
                  setPlannedParcels([{
                    id:"PKG-SINGLE",
                    tracking_no:normalizeTrackingCode(baseTrackingNo),
                    carrier_code:"SF",
                    supplier_alias:effectiveSupplier,
                    carton_count:1,
                    contains_all_items:true,
                    allocations:[],
                    note:"Mixed SKUs in 1 carton",
                  }]);
                }
                setServerQuote(undefined);
              }}
            >
              <strong>Single Parcel / One Box</strong>
              <p>All {clampedQty} items (even across multiple SKUs) ship together in one domestic parcel.</p>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={parcelMode==="multi"}
              className={`option-card ${parcelMode==="multi"?"selected":""}`}
              onClick={()=>{
                setParcelMode("multi");
                if(!plannedParcels.length) {
                  if(expectedLines.some(l=>l.tracking_no?.trim()||l.supplier_alias.trim())) {
                    autoGroupParcelsFromLines(true);
                  } else {
                    setPlannedParcels([{
                      id:`PKG-1-${Date.now().toString(36)}`,
                      tracking_no:"",
                      carrier_code:"SF",
                      supplier_alias:effectiveSupplier,
                      carton_count:1,
                      contains_all_items:false,
                      allocations:expectedLines.map(l=>({expected_line_id:l.id,quantity:l.quantity})),
                      note:"Box 1",
                    }]);
                  }
                }
                setServerQuote(undefined);
              }}
            >
              <strong>Multiple Parcels / Suppliers</strong>
              <p>Split SKUs and quantities across multiple tracking numbers or seller shops.</p>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={parcelMode==="later"}
              className={`option-card ${parcelMode==="later"?"selected":""}`}
              onClick={()=>{
                setParcelMode("later");
                setServerQuote(undefined);
              }}
            >
              <strong>Add Tracking After Payment</strong>
              <p>Sellers have not shipped yet. Pay &amp; lock scope now, then register waybills in Orders / Parcels.</p>
            </button>
          </div>

          {parcelMode==="single"&&<div className="fields" style={{marginTop:12}}>
            <div className="field">
              <label>Domestic waybill (optional)
                <input
                  value={plannedParcels[0]?.tracking_no??baseTrackingNo}
                  onChange={e=>{
                    const val=e.target.value;
                    setBaseTrackingNo(val);
                    setPlannedParcels([{
                      id:plannedParcels[0]?.id??"PKG-SINGLE",
                      tracking_no:val,
                      carrier_code:plannedParcels[0]?.carrier_code??"SF",
                      supplier_alias:plannedParcels[0]?.supplier_alias??effectiveSupplier,
                      carton_count:plannedParcels[0]?.carton_count??1,
                      contains_all_items:true,
                      allocations:[],
                      note:plannedParcels[0]?.note??"Mixed SKUs in 1 carton",
                    }]);
                    setServerQuote(undefined);
                  }}
                  placeholder="e.g. SF1000500001 (or add later after payment)"
                />
              </label>
            </div>
            <div className="field">
              <label>Carrier (optional)
                <select
                  value={(plannedParcels[0]?.carrier_code??"sf").toLowerCase()}
                  onChange={e=>{
                    const c=e.target.value;
                    setPlannedParcels([{
                      id:plannedParcels[0]?.id??"PKG-SINGLE",
                      tracking_no:plannedParcels[0]?.tracking_no??baseTrackingNo,
                      carrier_code:c,
                      supplier_alias:plannedParcels[0]?.supplier_alias??effectiveSupplier,
                      carton_count:plannedParcels[0]?.carton_count??1,
                      contains_all_items:true,
                      allocations:[],
                      note:plannedParcels[0]?.note??"Mixed SKUs in 1 carton",
                    }]);
                    setServerQuote(undefined);
                  }}
                >
                  <option value="sf">SF Express (顺丰)</option>
                  <option value="yto">YTO (圆通)</option>
                  <option value="zto">ZTO (中通)</option>
                  <option value="yd">Yunda (韵达)</option>
                  <option value="jd">JD Logistics (京东)</option>
                  <option value="other">Other domestic carrier</option>
                </select>
              </label>
            </div>
            <div className="field">
              <label>Carton / packing note
                <input
                  value={plannedParcels[0]?.note??""}
                  onChange={e=>{
                    const n=e.target.value;
                    setPlannedParcels([{
                      id:plannedParcels[0]?.id??"PKG-SINGLE",
                      tracking_no:plannedParcels[0]?.tracking_no??baseTrackingNo,
                      carrier_code:plannedParcels[0]?.carrier_code??"SF",
                      supplier_alias:plannedParcels[0]?.supplier_alias??effectiveSupplier,
                      carton_count:plannedParcels[0]?.carton_count??1,
                      contains_all_items:true,
                      allocations:[],
                      note:n,
                    }]);
                    setServerQuote(undefined);
                  }}
                  placeholder="e.g. 1 master carton · 6 SKUs bagged separately"
                />
              </label>
            </div>
          </div>}

          {parcelMode==="multi"&&<div className="card flat" style={{marginTop:12}}>
            <div className="row between flexwrap" style={{marginBottom:10}}>
              <strong>Planned Multi-Parcel List ({plannedParcels.length})</strong>
              <div className="row" style={{gap:8}}>
                {expectedLines.length>0&&<button type="button" className="button sm" onClick={()=>autoGroupParcelsFromLines(true)}>Auto-group from Line Waybills/Suppliers</button>}
                <button type="button" className="button sm primary" onClick={()=>{
                  setPlannedParcels(prev=>[...prev,{
                    id:`PKG-${prev.length+1}-${Date.now().toString(36)}`,
                    tracking_no:"",
                    carrier_code:"SF",
                    supplier_alias:"",
                    carton_count:1,
                    contains_all_items:false,
                    allocations:[],
                    note:`Box ${prev.length+1}`,
                  }]);
                  setServerQuote(undefined);
                }}>+ Add Parcel</button>
              </div>
            </div>
            <div style={{display:"grid",gap:10}}>
              {plannedParcels.map((parcel,pIdx)=><div key={parcel.id} className="card flat" style={{background:"#fff"}}>
                <div className="row between flexwrap" style={{marginBottom:8}}>
                  <strong>Parcel {pIdx+1}</strong>
                  {plannedParcels.length>1&&<button type="button" className="button sm" onClick={()=>{
                    setPlannedParcels(prev=>prev.filter(p=>p.id!==parcel.id));
                    setServerQuote(undefined);
                  }}>Remove</button>}
                </div>
                <div className="fields">
                  <div className="field">
                    <label>Tracking No.
                      <input value={parcel.tracking_no} onChange={e=>{
                        const v=e.target.value;
                        setPlannedParcels(prev=>prev.map(p=>p.id===parcel.id?{...p,tracking_no:v}:p));
                        setServerQuote(undefined);
                      }} placeholder="e.g. SF1000500001"/>
                    </label>
                  </div>
                  <div className="field">
                    <label>Carrier
                      <select value={(parcel.carrier_code||"sf").toLowerCase()} onChange={e=>{
                        const v=e.target.value;
                        setPlannedParcels(prev=>prev.map(p=>p.id===parcel.id?{...p,carrier_code:v}:p));
                      }}>
                        <option value="sf">SF Express</option>
                        <option value="yto">YTO</option>
                        <option value="zto">ZTO</option>
                        <option value="yd">Yunda</option>
                        <option value="jd">JD</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                  </div>
                  <div className="field">
                    <label>Supplier
                      <input value={parcel.supplier_alias} onChange={e=>{
                        const v=e.target.value;
                        setPlannedParcels(prev=>prev.map(p=>p.id===parcel.id?{...p,supplier_alias:v}:p));
                      }} placeholder="Shop / factory name"/>
                    </label>
                  </div>
                </div>
                {expectedLines.length>0&&<div style={{marginTop:8}}>
                  <div className="small muted" style={{marginBottom:6}}>Qty from each product line inside this parcel:</div>
                  <div className="row flexwrap" style={{gap:10}}>
                    {expectedLines.map(line=>{
                      const currentAlloc=parcel.allocations.find(a=>a.expected_line_id===line.id)?.quantity??0;
                      const totalAssigned=allocatedUnitMap.get(line.id)??0;
                      return <label key={line.id} className="small" style={{display:"flex",alignItems:"center",gap:6}}>
                        <span>{line.sku_code||line.product_name} ({line.color_declared}/{line.size_label}, {totalAssigned}/{line.quantity}):</span>
                        <input
                          type="number"
                          min={0}
                          max={line.quantity}
                          className="input"
                          style={{width:64}}
                          value={currentAlloc||""}
                          onChange={e=>{
                            const nextQ=Math.max(0,Math.min(line.quantity,Math.floor(Number(e.target.value)||0)));
                            setPlannedParcels(prev=>prev.map(p=>{
                              if(p.id!==parcel.id) return p;
                              const rest=p.allocations.filter(a=>a.expected_line_id!==line.id);
                              return {...p,contains_all_items:false,allocations:nextQ>0?[...rest,{expected_line_id:line.id,quantity:nextQ}]:rest};
                            }));
                            setServerQuote(undefined);
                          }}
                        />
                      </label>;
                    })}
                  </div>
                </div>}
              </div>)}
            </div>
          </div>}

          {parcelMode==="later"&&<div className="notice" style={{marginTop:12}}>
            <strong>Deferred parcel tracking active:</strong> This order will submit with empty pre-advised waybills. As soon as each seller ships, register the domestic tracking number in <strong>Order Detail → Register Parcel</strong> or <strong>Parcels</strong>.
          </div>}

          <div className="line-note" style={{marginTop:12}}>
            <strong>Parcel pre-advice vs. physical receipt:</strong> Registering a waybill helps warehouse intake match incoming packages. Parcels move to <em>Received at warehouse</em> only upon physical scan, and counts are reconciled against your expected product lines above.
          </div>

          <div className="sep"/>

          {/* COLLAPSIBLE ADVANCED INDIVIDUAL UNIT OVERRIDES */}
          <div className="row between flexwrap">
            <div>
              <div className="label">ADVANCED · INDIVIDUAL PHYSICAL UNIT OVERRIDES ({clampedQty} UNITS)</div>
              <p className="small muted" style={{margin:"2px 0 0"}}>
                Optional per-unit overrides ({customizedRowCount>0?`${customizedRowCount} custom override(s)`:expectedLines.length>0?"generated automatically from 3B Expected Product Lines":"all rows inherit defaults"}).
              </p>
            </div>
            <button
              type="button"
              className="button sm"
              aria-expanded={showAdvancedUnits}
              onClick={()=>setShowAdvancedUnits(open=>!open)}
            >{showAdvancedUnits?"Hide Individual Units":`Inspect / Override ${clampedQty} Physical Units`}</button>
          </div>

          {showAdvancedUnits&&<>
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
                      <td className="mono col-idx" style={{width:52,minWidth:52,whiteSpace:"nowrap",textAlign:"center"}}>{String(idx+1).padStart(2,"0")}</td>
                      <td data-label="Sample label"><input className="input" style={{minWidth:118}} aria-label={`Item ${idx+1} SKU`} value={row?.sku??defaultRowSku} onChange={e=>updateItemRow(idx,{sku:e.target.value})}/></td>
                      <td data-label="Size / specification"><input className="input" style={{minWidth:72}} aria-label={`Item ${idx+1} size`} value={row?.size??baseSize} onChange={e=>updateItemRow(idx,{size:e.target.value})}/></td>
                      <td data-label="Color / variant"><input className="input" style={{minWidth:92}} aria-label={`Item ${idx+1} color`} value={row?.color??baseColor} onChange={e=>updateItemRow(idx,{color:e.target.value})}/></td>
                      <td data-label="Supplier"><input className="input" style={{minWidth:120}} aria-label={`Item ${idx+1} supplier`} placeholder={supplierRef||"Shop / seller"} value={row?.supplier??supplierRef} onChange={e=>updateItemRow(idx,{supplier:e.target.value})}/></td>
                      <td data-label="Domestic waybill">
                        <input className="input" style={{minWidth:128}} aria-label={`Item ${idx+1} waybill`} placeholder={baseTrackingNo||"Optional"} value={row?.tracking_no??baseTrackingNo} onChange={e=>updateItemRow(idx,{tracking_no:e.target.value})}/>
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
          </>}
        </Panel>}

        {step===3&&<Panel
          title="Step 4 · Inspection Scope — Checkpoints, Tolerances & Notes"
          subtitle="Review the required checks for this service and add measurement targets or special instructions if needed."
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

            {(filteredShots.length>0||allOfferShots.length>0)&&<div style={{marginTop:12,paddingTop:10,borderTop:"1px solid var(--line)"}}>
              <strong className="small">{filteredShots.length>0?`Required Camera Angles (${filteredShots.length})`:`Standard Studio Camera Angles (${allOfferShots.length})`}: </strong>
              <span className="small muted">{(filteredShots.length>0?filteredShots:allOfferShots).map((s:Row)=>s.name||s.code).join(" · ")}</span>
            </div>}
          </div>

          <div className="card flat" id="step4b-tolerances" style={{marginBottom:16}}>
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
                            step="any"
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
                            step="any"
                            min="0"
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
                id="step4c-notes"
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
          {extraLines.length>0&&<ul className="draft-lines" aria-label="Other service lines">
            {extraLines.map((line,idx)=><li key={idx}>
              <div>
                <strong>{line.attributes.name||line.title}</strong>
                <small>{line.title} · {line.quantity} {line.quantity===1?"item":"items"}</small>
              </div>
              <div className="actions"><button type="button" className="button sm" disabled={Boolean(busyMessage)}
                aria-label={`Edit ${line.attributes.name||line.title}`}
                onClick={()=>void editServiceLine(idx)}>Edit</button>
              <button type="button" className="button sm" disabled={Boolean(busyMessage)}
                aria-label={`Remove ${line.attributes.name||line.title}`}
                onClick={()=>{setExtraLines(xs=>xs.filter((_,i)=>i!==idx));setServerQuote(undefined);}}>Remove</button></div>
            </li>)}
          </ul>}
          <div className="actions">
            <button type="button" className="button" disabled={Boolean(busyMessage)||allLines.length>=20||totalItems>=maximumDraftItems}
              onClick={()=>void addServiceLine()}>Save scope and add another service</button>
          </div>
        </Panel>}

        {step===4&&<Panel
          title="Step 5 · Review & Terms — Official Server Quote & Policies"
          subtitle="Verify your expected product lines, confirm the authoritative server-calculated quote, and accept the required service disclosures."
          badge={hasValidQuote?<Tag tone="green">Official quote</Tag>:busyMessage?<Tag tone="yellow">Calculating…</Tag>:<Tag tone="red">Quote Required</Tag>}
        >
          <div className="grid cols2">
            {extraLines.length===0&&<>
              <dl className="def"><dt>Product category</dt><dd>{selectedCategoryName}</dd></dl>
              <dl className="def"><dt>Inspection service</dt><dd>{serviceLabel}</dd></dl>
              <dl className="def"><dt>Inspection template</dt><dd>{templateLabel}</dd></dl>
            </>}
            <dl className="def"><dt>Commissioned quantity</dt><dd>{totalItems} {totalItems===1?"unit":"units"} across {totalExpectedLineCount} line(s)</dd></dl>
          </div>

          {expectedLines.length>0&&<div style={{marginTop:14}}>
            <div className="label" style={{marginBottom:6}}>EXPECTED PRODUCT LINES BREAKDOWN ({expectedLines.length} SKUS · {expectedTotalQty} UNITS)</div>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>SKU</th><th>Product</th><th>Color</th><th>Size</th><th>Qty</th><th>Supplier</th><th>Waybill</th></tr>
                </thead>
                <tbody>
                  {expectedLines.map(line=><tr key={line.id}>
                    <td className="mono">{line.sku_code||"—"}</td>
                    <td>{line.product_name}</td>
                    <td>{line.color_declared}</td>
                    <td>{line.size_label}</td>
                    <td><strong>{line.quantity}</strong></td>
                    <td>{line.supplier_alias||"—"}</td>
                    <td className="mono">{line.tracking_no||(parcelMode==="later"?"Add later":"—")}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </div>}

          {totalEvidenceCount>0&&<div style={{marginTop:12}} data-testid="step5-purchase-evidence-list">
            <div className="label" style={{marginBottom:6}}>ATTACHED PURCHASE EVIDENCE (3A · {totalEvidenceCount} FILE{totalEvidenceCount===1?"":"S"})</div>
            <ul className="draft-lines">
              {purchaseEvidences.map(ev=><li key={ev.id}>
                <span>
                  <strong>{ev.file_name}</strong>
                  <small className="muted"> · {ev.platform_source||"File"}{ev.purchase_order_ref?` · PO ${ev.purchase_order_ref}`:""}</small>
                </span>
                {ev.media_id?<a className="button sm" href={`/api/v1/media/${ev.media_id}`} target="_blank" rel="noreferrer">View</a>:<span className="small muted">{(ev.size_bytes/1024).toFixed(1)} KB</span>}
              </li>)}
            </ul>
          </div>}

          {attachmentId&&<div style={{marginTop:12}} data-testid="step5-reference-attachment-card">
            <div className="label" style={{marginBottom:6}}>3B REFERENCE PHOTO / SIZE CHART</div>
            <ul className="draft-lines">
              <li>
                <span>
                  <strong>{attachmentName||"Reference image"}</strong>
                  <small className="muted"> · {attachmentPurpose==="size_chart"?"Measurement size chart":"Product reference photo"}</small>
                </span>
                <a className="button sm" href={`/api/v1/media/${attachmentId}`} target="_blank" rel="noreferrer">View</a>
              </li>
            </ul>
          </div>}

          {extraLines.length>0&&<ul className="draft-lines" aria-label="Inspection scopes">
            {allLines.map((line,idx)=>{
              const rangeCount=line.attributes.tolerances?.length??0;
              return <li key={idx}>
                <div>
                  <strong>{line.attributes.name||line.title}</strong>
                  <small>{line.title} · {line.quantity} {line.quantity===1?"item":"items"}</small>
                </div>
                <div className="cell-stack"><span className="small">{rangeCount?`${rangeCount} measurement ${rangeCount===1?"range":"ranges"}`:"Record measured values"}</span>
                  {idx<extraLines.length&&<button type="button" className="button sm" disabled={Boolean(busyMessage)}
                    aria-label={`Edit ${line.attributes.name||line.title}`} onClick={()=>void editServiceLine(idx)}>Edit</button>}
                </div>
              </li>;
            })}
          </ul>}

          <div className="sep"/>
          {hasValidQuote?<div className="card flat">
            <div className="row between flexwrap">
              <strong>Official quote · {draftOrder?.public_no}</strong>
              <strong>{usd(serverQuote!.amount_cents)} {serverQuote!.currency}</strong>
            </div>
            <p className="small muted">Valid until {stamp(serverQuote!.expires_at)}</p>
            <QuoteCountdown expiresAt={serverQuote?.expires_at}/>
            <ul className="draft-lines">
              {serverQuote!.line_snapshot.map((line:Row)=><li key={line.order_line_id}>
                <span>{offers.find(offer=>offer.offer_id===line.offer_id)?.title.en??"Inspection service"} × {line.quantity}<br/>
                  <small>{line.business_days} business days after all items arrive and pass identification</small></span>
                <strong>{usd(line.amount_cents)}</strong>
              </li>)}
            </ul>
          </div>:<div className="card flat">
            <p role="status">{isQuoteExpired?"The quote expired. Request a new quote to continue.":busyMessage?"Calculating your quote…":"A current quote is required before payment."}</p>
            <button id="step5-get-quote-btn" type="button" className="button primary" disabled={Boolean(busyMessage)}
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
              <input id="step5-policy-accept-check" type="checkbox" checked={policyAccepted} disabled={!hasValidQuote||policyIds.length!==wizardPolicyKinds.length}
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
          subtitle="Confirm the valid quote and pay to activate this inspection."
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
              <p><QuoteCountdown expiresAt={serverQuote?.expires_at}/></p>
              <div className="grid cols2">
                <dl className="def"><dt>Order number</dt><dd className="mono">{draftOrder.public_no}</dd></dl>
                <dl className="def"><dt>Confirmed service fee</dt><dd className="mono">{usd(serverQuote!.amount_cents)} {serverQuote!.currency}</dd></dl>
                <dl className="def"><dt>Inspection scope</dt><dd>{extraLines.length>0?`${allLines.length} service lines`:`${serviceLabel} · ${templateLabel}`} · {totalItems} {totalItems===1?"item":"items"}</dd></dl>
                <dl className="def"><dt>Permanent receiving code</dt><dd><span className="mono">{receiving.data?.receiving_code??(receiving.error?"Unavailable":"Loading…")}</span></dd></dl>
              </div>
              {receiving.error&&<><ErrorBlock error={receiving.error}/><button type="button" onClick={receiving.reload}>Retry receiving details</button></>}
              {!receiving.data&&!receiving.error&&<p role="status">Loading receiving details…</p>}

              <div className="sep"/>
              <div className="card flat" style={{marginBottom:14}}>
                <div className="label">WHAT HAPPENS IMMEDIATELY AFTER PAYMENT</div>
                <ol className="small" style={{margin:"8px 0 0",paddingLeft:18,lineHeight:1.6}}>
                  <li>After payment is confirmed, your order moves to <strong>Awaiting items</strong>.</li>
                  <li><strong>Ship to China facility:</strong> Give your seller your permanent code <span className="mono">{receiving.data?.receiving_code??"—"}</span> and warehouse address in <Link href="/account">Account</Link>.</li>
                  <li>
                    {declaredWaybills.length>0
                      ?<>Pre-declared waybills (<span className="mono">{declaredWaybills.join(", ")}</span>) can be 1-click registered on <Link href={"/orders/"+draftOrder.public_no}>Order {draftOrder.public_no}</Link> or in <Link href="/parcels">Parcels</Link>.</>
                      :<>Register each seller&apos;s domestic waybill in <Link href={"/orders/"+draftOrder.public_no}>Order Detail</Link> or <Link href="/parcels">Parcels</Link> once shipped.</>}
                  </li>
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

        {step<5&&stepBlockingInfo&&(
          <div className="notice warning" data-testid="wizard-continue-block-reason" role="status" style={{marginBottom:10}}>
            <div className="row between flexwrap" style={{gap:8}}>
              <span><strong>Why Continue is blocked:</strong> {stepBlockingInfo.reason}</span>
              {stepBlockingInfo.targetId&&(
                <button type="button" className="button sm" onClick={()=>focusWizardTarget(stepBlockingInfo.targetId)}>
                  Highlight required field ↑
                </button>
              )}
            </div>
          </div>
        )}

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
              disabled={Boolean(busyMessage)||!serviceOffers.length||Boolean(stepBlockingInfo)}
              onClick={()=>void goToStep(step+1)}
            >{step===3?"Save & Review Official Quote →":step===4?"Continue to Payment Preview →":"Continue →"}</button>
          ):(
            <Link className="button sm" href={draftOrder?"/orders/"+draftOrder.public_no:"/orders"}>View Order Detail</Link>
          )}
        </div>
      </div>

      <aside className="wizard-side">
        <section className="card" data-testid="order-summary-card">
          <button className="wizard-summary-toggle button" type="button" aria-expanded={summaryOpen} aria-controls="wizard-summary"
            onClick={()=>setSummaryOpen(open=>!open)}>Order Summary <span aria-hidden="true">{summaryOpen?"−":"+"}</span></button>
          <div id="wizard-summary" className={summaryOpen?"wizard-summary-body open":"wizard-summary-body"}>
          <div className="card-head">
            <div>
              <h3>Order Summary</h3>
              <p>Live configuration &amp; readiness.</p>
            </div>
            <Tag tone={hasValidQuote?"green":"yellow"}>{draftOrder?draftOrder.public_no:"DRAFT"}</Tag>
          </div>
          <div className="sep"/>
          <div className="mini-kv">
            {extraLines.length===0?<><div><div className="k">Category</div><div className="v">{selectedCategoryName}</div></div>
              <div><div className="k">Service</div><div className="v">{serviceLabel}</div></div>
              <div><div className="k">Template</div><div className="v">{isApparelCategory?templateLabel.split(" (")[0]:"Standard"}</div></div></>:
              <div><div className="k">Services</div><div className="v">{allLines.length} service lines</div></div>}
            <div><div className="k">Confirmed lines</div><div className="v" data-testid="summary-confirmed-lines">{totalExpectedLineCount} line(s)</div></div>
            <div><div className="k">Commissioned qty</div><div className="v">{manualQuoteMode?`${manualBatchQty} (Manual)`:`${totalItems} unit(s)`}</div></div>
            <div><div className="k">Declared line units</div><div className="v">{expectedTotalQty} unit(s)</div></div>
            <div><div className="k">Billable units</div><div className="v">{manualQuoteMode?`${manualBatchQty} (Manual)`:`${totalItems} unit(s)`}</div></div>
            <div><div className="k">Suppliers</div><div className="v">{declaredSuppliers.length||"—"}</div></div>
            <div><div className="k">Parcels / Waybills</div><div className="v">{parcelMode==="later"?"Add after pay":declaredWaybills.length?`${declaredWaybills.length} waybill(s)`:"Pending"}</div></div>
            <div><div className="k">Purchase evidence (3A)</div><div className="v">{totalEvidenceCount} file(s)</div></div>
            <div><div className="k">3B Ref / Size chart</div><div className="v">{attachmentId?(attachmentPurpose==="size_chart"?"Size chart":"Ref photo"):"None"}</div></div>
          </div>
          {(()=>{
            const summaryAlerts=[
              ...(!hasConfirmedLines&&!manualQuoteMode?["0 confirmed product lines in Step 3B — add or confirm at least 1 line."]:[]),
              ...(incompleteExpectedLines.length>0?[`${incompleteExpectedLines.length} product line(s) in Step 3B have missing required fields.`]:[]),
              ...(hasPendingReassociation?[`${pendingReassociationEvidences.length} retained file(s) in Step 3A need confirmation for ${serviceLabel}.`]:[]),
              ...(hasPendingCandidates?[`${pendingCandidateCount} unconfirmed row(s) pending review in Step 3A.`]:[]),
              ...(hasQuantityMismatch?[`Declared line units (${expectedTotalQty}) differ from commissioned qty (${clampedQty}).`]:[]),
              ...(missingReferenceSample&&step>=1?[activeRefs.length===0?"No active Golden Sample in warehouse vault for this category.":"Select an active Golden Sample in Step 2."]:[]),
            ];
            return summaryAlerts.length>0?<div className="notice warning" data-testid="order-summary-alert" style={{marginTop:10,padding:"8px 10px",fontSize:12}}>
              {summaryAlerts.join(" ")}
            </div>:null;
          })()}
          {extraLines.length>0&&<ul className="wizard-summary-lines" aria-label="Service line summaries" tabIndex={0}>
            {allLines.map((line,index)=>{
              const offer=offers.find(row=>row.offer_id===line.offer_id);
              const category=offers.find(row=>row.category_id===line.category_id)?.category?.en??"Saved category";
              const service=wizardServiceCards.find(row=>row.service===offer?.service)?.title??"Inspection service";
              const template=offer?.category_slug==="apparel"
                ?apparelTemplateOptions.find(row=>row.variant===templateVariantFor(offer))?.label
                :offer?.title.en;
              return <li key={index}><strong>{line.attributes.name||line.title}</strong><div className="mini-kv">
                <div><div className="k">Category</div><div className="v">{category}</div></div>
                <div><div className="k">Service</div><div className="v">{service}</div></div>
                <div><div className="k">Template</div><div className="v">{template??"Saved checklist"}</div></div>
                <div><div className="k">Quantity</div><div className="v">{line.quantity} {line.quantity===1?"item":"items"}</div></div>
              </div></li>;
            })}
          </ul>}
          <div className="sep"/>
          <div className="display-quote" data-testid="order-summary-estimate">
            <div className="label">{hasValidQuote?"OFFICIAL QUOTE":step>=4?"QUOTE STATUS":isEstimateInvalid?"ACTION REQUIRED":isEstimateProvisional?"PROVISIONAL ESTIMATE":"CATALOG ESTIMATE"}</div>
            <div className="big">
              {hasValidQuote
                ?usd(serverQuote!.amount_cents)
                :manualQuoteMode
                  ?"Manual quote"
                  :step>=4
                    ?"Awaiting quote"
                    :isEstimateInvalid
                      ?<span data-testid="estimate-invalid-state">{hasQuantityMismatch?"Outdated estimate":"Action required"}</span>
                      :displayCents!=null?usd(displayCents):"Unavailable"}
            </div>
            <div className="small muted">
              {hasValidQuote && serverQuote?.expires_at
                ?`Official quote valid until ${stamp(serverQuote.expires_at)}.`
                :isEstimateInvalid && !manualQuoteMode && step<4
                  ?estimateInvalidReason
                  :isEstimateProvisional && !manualQuoteMode && step<4
                    ?<span className="small" data-testid="provisional-estimate-state">Provisional estimate · Confirm product lines in Step 3B before quoting</span>
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
              disabled={Boolean(busyMessage)||!recoveryReady||draftLoadFailed||Boolean(conflict&&!reviewingConflict)||manualQuoteMode||!currentLine||Boolean(submittedCharge)}
              onClick={()=>void saveDraftOnly(reviewingConflict)}
            >
              {draftOrder?"Update Saved Draft":"Save Draft"}
            </button>
            <button
              type="button"
              className="button sm"
              disabled={Boolean(busyMessage)}
              onClick={()=>{
                if(window.confirm("Start a new inspection? Any saved draft will remain in Orders.")) {
                  removeDraftRecovery(recoveryKey);
                  location.assign("/orders/new");
                }
              }}
            >Reset Draft</button>
          </div>
          </div>
        </section>

      </aside>
    </div>}
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
  const stamp=useWorkspaceStamp();
  if(!item) return null;
  const disp=item.active_disposition??item.instruction;
  const declared=[
    ["Product",item.declared_fields?.name],["Item code",item.declared_fields?.sample_code],
    ["Supplier",item.declared_fields?.supplier_alias??item.declared_fields?.supplier_ref],
    ["Color",item.declared_fields?.color_declared],["Size",item.declared_fields?.size_label],
    ["Seller tracking",item.declared_fields?.tracking_no],
  ].filter(([,value])=>typeof value==="string"&&value);
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
        <dl className="def"><dt>Inspection status</dt><dd>{itemInspectionLabel(item)}</dd></dl>
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
      {item.handling_hold&&<p className="notice">{handlingHoldLabel[item.handling_hold]}</p>}
      {Array.isArray(item.components)&&item.components.length>0&&<p className="small muted" style={{marginTop:10}}>
        <strong>Sub-components:</strong> {item.components.map((c:Row)=>`${c.code}${c.label?` (${c.label})`:""}`).join(", ")}
      </p>}
      {declared.length>0&&<div style={{marginTop:10}}>
        <small className="muted">Declared attributes</small>
        <div className="actions" style={{marginTop:4}}>
          {declared.map(([key,value])=><Tag key={key} tone="outline">{key} · {value}</Tag>)}
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
  const stamp=useWorkspaceStamp();
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
    {view.error&&<><ErrorBlock error={view.error}/><button type="button" onClick={view.reload}>Retry batch details</button></>}
    {!d&&!view.error&&<p role="status">Loading dispatch batch details…</p>}
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
  const stamp=useWorkspaceStamp();
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
  const manualQuote=o?.manual_quote;
  const manualRenewal=o?.manual_quote_renewable;
  const needsManualQuoteRenewal=manualQuote?.state==="expired"||Boolean(manualRenewal&&!manualQuote);
  const quote=manualQuote?.id?manualQuote:manualRenewal?undefined:calculatedQuote;
  const paymentState=payment.data?.previous_checkout_expired?"reconciliation":payment.data?.state;
  const scopePayment=o?.scope_payment;
  const scopePaymentHref=scopePayment?inspectionScopePath(number,scopePayment.id):undefined;
  const refreshPayment=()=>{detail.reload();payment.reload();};
  useEffect(()=>{
    const target=location.hash.slice(1);
    if(calculatedQuote?.id) document.getElementById("inspection-quote")?.scrollIntoView({block:"start"});
    else if(o?.id&&(target==="manual-quote-request"||target==="inspection-quote")) document.getElementById(target)?.scrollIntoView({block:"start"});
  },[o?.id,calculatedQuote?.id]);
  useEffect(()=>{
    if(!quote?.expires_at) return;
    const expiry=Date.parse(quote.expires_at);
    if(!Number.isFinite(expiry)) return;
    const timer=setTimeout(()=>{setQuote(undefined);detail.reload();},Math.min(Math.max(0,expiry-Date.now()),2_147_483_647));
    return ()=>clearTimeout(timer);
  },[quote?.id,quote?.expires_at,detail.reload]);
  useEffect(()=>{
    if(paymentState!=="open"||!payment.data?.charge?.expires_at) return;
    const remaining=Date.parse(payment.data.charge.expires_at)-Date.now();
    if(!Number.isFinite(remaining)||remaining<=0) return;
    const timer=setTimeout(()=>{payment.reload();detail.reload();},Math.min(remaining,2_147_483_647));
    return ()=>clearTimeout(timer);
  },[paymentState,payment.data?.charge?.expires_at,payment.reload,detail.reload]);
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
    {(lookup.error||detail.error)&&<><ErrorBlock error={lookup.error||detail.error}/>
      <button type="button" onClick={()=>{lookup.reload();detail.reload();}}>Retry order</button></>}
    {!o&&!lookup.error&&!detail.error&&<p role="status">Loading inspection order…</p>}
    {o&&<>
      <Tabs path={section?base+"/"+section:base} links={sectionLinks}/>
      {o.state==="on_hold"&&<div className="notice" role="status"><strong>This order is currently on hold</strong>{o.hold_reason?`: ${o.hold_reason}`:""}.{paymentState==="paid"?" Your payment is recorded and will be applied when the hold is lifted.":""}</div>}
      {section==="parcels"&&parcelLinkStates.includes(o.state)&&<>
        {desk.error&&<><ErrorBlock error={desk.error}/><button type="button" onClick={desk.reload}>Retry registered parcels</button></>}
        {!desk.data&&!desk.error&&<p role="status">Loading registered parcels…</p>}
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
          {receiving.error||carriers.error?<><ErrorBlock error={receiving.error||carriers.error}/>
            <button type="button" onClick={()=>{receiving.reload();carriers.reload();}}>Retry parcel registration</button></>:
            !receiving.data||!carriers.data?<p role="status">Loading parcel registration…</p>:<>
              {Array.isArray(o.unregistered_waybills)&&o.unregistered_waybills.length>0&&receiving.data?.warehouse_address?.id&&(
                <div className="notice" style={{marginBottom:12}}>
                  <div className="row between flexwrap" style={{gap:8}}>
                    <span>
                      <strong>{o.unregistered_waybills.length} pre-declared waybill(s) awaiting parcel registration:</strong>{" "}
                      <span className="mono">{o.unregistered_waybills.map((w:Row)=>`${w.tracking_no} (${w.item_count})`).join(", ")}</span>
                    </span>
                    <Action primary run={async()=>{
                      const addrId=receiving.data?.warehouse_address?.id;
                      if(!addrId) throw new Error("Warehouse address unavailable.");
                      const plannedList:Row[]=o.expected_lines_summary?.planned_parcels??[];
                      const breakdownList:Row[]=o.expected_lines_summary?.lines_breakdown??[];
                      for(const wb of o.unregistered_waybills) {
                        const match=plannedList.find((p:Row)=>String(p.tracking_no??"").toUpperCase()===String(wb.tracking_no).toUpperCase())
                          ??breakdownList.find((b:Row)=>String(b.tracking_no??"").toUpperCase()===String(wb.tracking_no).toUpperCase());
                      const rawCarrier=match?.carrier_code?String(match.carrier_code).trim().toLowerCase():undefined;
                      const carrierCode=rawCarrier&&rawCarrier!=="other"?rawCarrier:undefined;
                      await request("/me/parcels","POST",{
                        address_id:addrId,
                        tracking_no:wb.tracking_no,
                        ...(carrierCode?{carrier_code:carrierCode}:{}),
                        order_ids:[o.id],
                      });
                      }
                      detail.reload();desk.reload();
                    }}>Register all declared waybills ({o.unregistered_waybills.length})</Action>
                  </div>
                </div>
              )}
              <InboundParcelForm address={receiving.data.warehouse_address} carriers={carriers.data.carriers} orderId={o.id}
                pendingWaybills={o.unregistered_waybills} onSave={()=>{detail.reload();desk.reload();}}/>
            </>}
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
      {!section&&scopePaymentHref&&<div className="order-next">
        <div><span className="eyebrow">NEXT STEP</span><p>{scopePayment.state==="processing"?"We're waiting for confirmation of your supplemental payment.":
          scopePayment.state==="expired"?"Renew the supplemental quote for your accepted scope change.":"Complete the supplemental payment before the scope change takes effect."}</p></div>
        <div className="actions"><Link className="button primary sm" href={scopePaymentHref}>Review scope charge</Link></div>
      </div>}
      {!section&&!scopePayment&&orderNext[o.state]&&<div className="order-next"><div><span className="eyebrow">NEXT STEP</span><p>
        {o.state==="awaiting_samples"&&o.parcel_registration_due&&"Register the seller’s tracking for this order. "}{orderNext[o.state]}
      </p></div>
        <div className="actions">
          {o.state==="awaiting_payment"&&<Link className="button primary sm" href={base+"/payment"}>Review payment</Link>}
          {o.state==="draft"&&<Link className="button primary sm" href={"/orders/new?draft="+encodeURIComponent(number)}>Edit in step-by-step wizard</Link>}
          {o.state==="awaiting_samples"&&<Link className="button primary sm" href={base+"/parcels"}>{o.parcel_registration_due?"Register seller tracking":"Track inbound parcels"}</Link>}
          {["report_ready","action_pending","cancelled"].includes(o.state)&&<Link className="button primary sm" href={base+"/dispositions"}>Open item instructions</Link>}
        </div>
      </div>}
      {!section&&<div className="metric-strip" aria-label="Order progress summary">
        {scopePaymentHref?<Link className="metric" href={scopePaymentHref}><span>Supplemental payment</span><strong>{scopePaymentLabels[scopePayment.state]}</strong><small>{usd(scopePayment.amount_cents)}</small></Link>:
          <Link className="metric" href={base+"/payment"}><span>Payment</span><strong>{paymentState?label(paymentState):label(o.state)}</strong><small>{payment.data?.charge?usd(payment.data.charge.amount_cents):"Inspection fee"}</small></Link>}
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
        {payment.error?<><ErrorBlock error={payment.error}/><button type="button" onClick={payment.reload}>Retry payment status</button></>:!payment.data?<p role="status">Loading the current charge…</p>:<>
          {payment.data.charge&&<p><strong>{usd(payment.data.charge.amount_cents)}</strong> · Quote {payment.data.charge.quote_revision}</p>}
          {paymentState==="open"&&<p className="small muted">Valid until {stamp(payment.data.charge?.expires_at)}.<br/>
            <QuoteCountdown expiresAt={payment.data.charge?.expires_at}/></p>}
          {(paymentState==="open"||paymentState==="reconciliation")&&!checkoutNotice?.expired&&<Action primary run={()=>continuePayment(payment.data!.charge.id,payment.data!.charge.quote_revision)}>
            {paymentState==="reconciliation"||manualRenewal?"Check previous payment status":"Resume payment"}</Action>}
          {paymentState==="reconciliation"&&!checkoutNotice?.expired&&<p>The quote has expired. Check the previous checkout before requesting a new quote.</p>}
          {paymentState==="processing"&&<p role="status">{payment.data.reconciliation_required?
            <>Payment was received and needs review before your inspection can start. <Link href="/support">View support cases</Link>.</>:
            "Payment is processing. We will update the order after confirmation."}</p>}
          {(paymentState==="expired"||checkoutNotice?.expired)&&<>
            <p>The quote has expired. Review a new quote for this order.</p>
            {!manualRenewal&&<Action primary run={async()=>{
              setQuote(await request("/orders/"+id+"/quotes","POST",{revision:o.revision}));
            }}>Review a new quote</Action>}
          </>}
          {returnedFromCheckout&&paymentState==="open"&&<p role="status">Waiting for payment confirmation.</p>}
          {paymentState==="paid"&&<div className="actions"><Tag>Payment confirmed</Tag>
            {o.state==="awaiting_samples"&&<Link className="button primary" href={base+"/parcels"}>Register seller tracking</Link>}
          </div>}
          {paymentState==="not_due"&&<p>{o.state==="draft"?"Calculate and accept a quote to create the inspection charge.":"There is no payable inspection charge for this order."}</p>}
        </>}
        {checkoutNotice&&(checkoutNotice.error?<ErrorBlock error={checkoutNotice.text}/>:<p role="status">{checkoutNotice.text}</p>)}
        <div className="actions"><button type="button" onClick={refreshPayment}>Refresh payment status</button>
          <Link href={payment.data?.charge?billingChargePath(payment.data.charge.id):"/account/billing"}>Open billing</Link></div>
      </Panel>}
      {(!section||section==="payment")&&<Panel title="Inspection scope">
      {o.customer_notes&&<p className="muted">Notes: {o.customer_notes}</p>}
      {o.sla_due_at&&<p className="muted small">Inspection SLA target · {stamp(o.sla_due_at)}</p>}
      {!section&&o.parcels.length>0&&<div className="actions" style={{marginBottom:10}}>
        <small className="muted">Linked seller waybills:</small>
        {o.parcels.map((p:Row)=><CodeButton key={p.id} code={p.tracking_norm} title="Preview carrier & warehouse tracking" onClick={()=>setTrackTarget({kind:"parcels",id:p.id,code:p.tracking_norm})}/>)}
      </div>}
      {Array.isArray(o.expected_lines_summary?.lines_breakdown)&&o.expected_lines_summary.lines_breakdown.length>0&&(
        <div style={{marginBottom:16}}>
          <div className="row between flexwrap" style={{marginBottom:8}}>
            <strong>Expected Product Lines &amp; Intake Reconciliation</strong>
            <div className="row" style={{gap:6}}>
              <Tag tone="blue">{o.expected_lines_summary.expected_lines_count} SKU line(s)</Tag>
              <Tag tone={o.expected_lines_summary.identified_units_total===o.expected_lines_summary.expected_units_total?"green":"yellow"}>
                {o.expected_lines_summary.identified_units_total}/{o.expected_lines_summary.expected_units_total} identified · {o.expected_lines_summary.inspected_units_total} inspected
              </Tag>
            </div>
          </div>
          <Table
            headers={["SKU / Product","Color / Size","Supplier & Waybill","Expected","Arrived","Identified","Inspected","Outstanding"]}
            rows={o.expected_lines_summary.lines_breakdown.map((b:Row)=>[
              <div className="cell-stack"><strong>{b.product_name||b.sku_code||"—"}</strong>{b.sku_code&&<small className="mono">{b.sku_code}</small>}</div>,
              [b.color_declared,b.size_label].filter(Boolean).join(" / ")||"—",
              <div className="cell-stack"><span>{b.supplier_alias||"—"}</span>{b.tracking_no&&<small className="mono">{b.tracking_no}</small>}</div>,
              <strong>{b.expected_qty}</strong>,
              b.arrived_qty,
              b.identified_qty,
              b.inspected_qty,
              b.outstanding_qty>0?<Tag tone="yellow">{b.outstanding_qty} pending</Tag>:<Tag tone="green">0</Tag>,
            ])}
          />
          {Array.isArray(o.expected_lines_summary.purchase_evidences)&&o.expected_lines_summary.purchase_evidences.length>0&&(
            <div className="row flexwrap" style={{gap:10,marginTop:8}}>
              {o.expected_lines_summary.purchase_evidences.map((ev:Row,idx:number)=>(
                <div key={ev.id??idx} className="evidence-chip">
                  {ev.media_id&&<img src={`/api/v1/media/${ev.media_id}`} alt={ev.file_name??"Evidence"} style={{width:36,height:36,objectFit:"cover",borderRadius:6}}/>}
                  <div className="cell-stack">
                    <span className="small"><strong>{ev.file_name??"Purchase record"}</strong></span>
                    <small className="muted">{[ev.supplier_alias,ev.purchase_order_ref].filter(Boolean).join(" · ")||ev.platform_source||"Attached evidence"}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Table headers={["Service","Position","Warehouse item","Package","Custody"]} rows={o.items.map((i:Row)=>[
        i.title.en,
        i.position??i.quantity,
        i.code?<CodeButton code={i.code} onClick={()=>setItemTarget({...i,order_no:number,order_state:o.state})}/>:"Awaiting assignment",
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
      {o.state==="draft"&&
        <div className="actions"><Action primary run={async()=>setQuote(await request("/orders/"+id+"/quotes","POST",{revision:o.revision}))}>Calculate quote</Action>
          <Link className="button" href={"/orders/new?draft="+encodeURIComponent(number)}>Modify items or service in wizard</Link>
        </div>}
      {(o.state==="draft"||manualRenewal)&&<details className="card" id="manual-quote-request" open={manualQuote||manualRenewal?true:undefined}>
        <summary>Manual inspection quote</summary>
        {needsManualQuoteRenewal&&<p>The previous manual quote expired. Ask our team to update it for this order.</p>}
        {manualQuote?.state==="requested"?<p role="status">Request received. We’ll notify you when the quote is ready.</p>:
          manualQuote?.id?<p><a href="#inspection-quote">Review the current manual quote</a>.</p>:
          <Form label={needsManualQuoteRenewal?"Request updated manual quote":"Request manual quote"} run={async f=>{
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
      <Table headers={["Seller tracking number","Carrier","Sync status","Carrier status","Warehouse intake",""]} rows={o.parcels.map((p:Row)=>{
        const logged=p.logged_item_count??p.received_quantity;
        return [
          <CodeButton code={p.tracking_norm} onClick={()=>setTrackTarget({kind:"parcels",id:p.id,code:p.tracking_norm})}/>,
          p.carrier_name??"—",
          p.sync_state?label(p.sync_state):"—",
          label(p.transport_state),
          p.warehouse_state?<div className="cell-stack"><span>{label(p.warehouse_state)}{p.package_code?` (${p.package_code})`:""}</span>
            {logged!=null&&<small>{logged} item(s) logged</small>}</div>:"Awaiting physical receipt",
          <Link className="small" href={"/parcels/"+p.id}>Full page →</Link>,
        ];
      })} empty="No seller waybills are linked to this order."/>
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
        <Action key={id} idempotent onSettled={detail.reload} run={async key=>{
          if(!window.confirm("Cancel this inspection? Warehouse items remain available for disposition."))return;
          await request("/orders/"+id+"/cancel","POST",{revision:o.revision},key);
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
    {preview.error&&<><ErrorBlock error={preview.error}/><button type="button" onClick={preview.reload}>Retry refund policy</button></>}
    {!["draft","awaiting_payment"].includes(orderState)&&!preview.data&&!preview.error&&<p role="status">Loading refund policy…</p>}
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
  const {data,error,reload}=useLoad("/auth/providers");
  return <div className="narrow panel"><h1>Test checkout</h1>
    {data?.demo?<><p>Confirm this test payment.</p>
      <Action primary run={async()=>{
        const result=await request("/checkout/demo/"+id,"POST",{});
        location.assign(result.order_number&&result.scope_revision_id?inspectionScopePath(result.order_number,result.scope_revision_id):
          result.order_number?"/orders/"+result.order_number:"/account/billing");
      }}>Confirm test payment</Action></>:error?<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry checkout</button></>:data?<Empty>Checkout is unavailable.</Empty>:<p role="status">Loading checkout…</p>}
  </div>;
}
export function ReportView({number,version}:{number:string;version?:number}) {
  const stamp=useWorkspaceStamp();
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
    {(l.error||r.error)&&<><ErrorBlock error={l.error||r.error}/>
      <button type="button" onClick={()=>{l.reload();r.reload();}}>Retry report</button></>}
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
          .map(code=><Link className="code-btn" key={code} href={"/items?item="+encodeURIComponent(code)}>{code}</Link>)}</div>
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
    const labels=ids.map(()=>`${x.label} · ${x.item}`);
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
  const stamp=useWorkspaceStamp();
  const path=kind==="parcels"?"/me/parcels/":"/shipments/";
  const {data,error,reload}=useLoad(path+id+"/tracking?locale=en");
  const canVerify=kind==="parcels"&&data?.allowed_actions.includes("verify_tracking");
  const canCorrect=kind==="parcels"&&Boolean(data&&!data.warehouse_state);
  const verificationPath=path+id+"/tracking-verification";
  const verification=useLoad(canVerify||canCorrect?verificationPath:null),carriers=useLoad(canVerify||canCorrect?"/carriers":null);
  const [nextManualRefresh,setNextManualRefresh]=useState<string>();
  const [correctedTracking,setCorrectedTracking]=useState<string>();
  const [correctionCarrier,setCorrectionCarrier]=useState("");
  const selectedCarrier=correctionCarrier||verification.data?.carrier_code||"";
  const labelPhoneHint=carriers.data?.carriers.find((carrier:Row)=>carrier.code===selectedCarrier)?.format_hint;
  const receipt=data?.warehouse_receipt;
  const nextQueryAt=[data?.next_allowed_at,nextManualRefresh].filter(Boolean).sort().at(-1);
  const manualRefresh=data?.allowed_actions.includes("refresh_tracking");
  const outerCondition=receipt?.outer_condition&&({intact:"Intact",crushed:"Crushed",torn:"Torn",wet:"Wet"} as Record<string,string>)[receipt.outer_condition];
  useEffect(()=>{const timer=setInterval(reload,60000);return ()=>clearInterval(timer);},[reload]);
  return <>{!embedded&&<div className="page-head"><p className="eyebrow">Warehouse / Tracking</p><h1>Tracking details</h1><p className="muted">Follow carrier events and the warehouse’s own handling status.</p></div>}{error&&<><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry tracking</button></>}
    {!data&&!error&&<p role="status">Loading carrier tracking…</p>}
    {data&&<Panel title={data.carrier??"Carrier pending"}><p className="code">{data.tracking_no}</p>
      <div className="actions"><Tag>{label(data.transport_state)}</Tag><Tag>{label(data.sync_state)}</Tag>
      {data.warehouse_state&&<Tag>Warehouse · {label(data.warehouse_state)}</Tag>}
      {kind==="parcels"&&<Link className="button sm" href={"/support?parcel="+encodeURIComponent(id)}>Get help with this parcel</Link>}
      <button type="button" onClick={reload}>Reload tracking status</button>
      {manualRefresh&&<Action disabled={!!nextQueryAt&&Date.parse(nextQueryAt)>Date.now()} run={async()=>{
        const result=await request(path+id+"/tracking/refresh","POST",{});
        setNextManualRefresh(result.next_allowed_at);
        reload();
      }}>Request carrier update</Action>}</div>
      {data.direction==="inbound"&&data.transport_state==="delivered"&&!data.warehouse_state&&<p className="notice" role="status"><strong>Delivered by carrier · Warehouse check-in pending.</strong> Physical receipt is confirmed only after warehouse check-in.</p>}
      {receipt&&<section aria-label="Warehouse receipt" className="top-gap">
        <dl className="location-facts">
          <div><dt>Warehouse check-in</dt><dd>{stamp(receipt.received_at)}</dd></div>
          {receipt.logged_item_count!=null&&<div><dt>Items logged by warehouse</dt><dd>{receipt.logged_item_count}</dd></div>}
          {outerCondition&&<div><dt>Outer carton condition</dt><dd>{outerCondition}</dd></div>}
        </dl>
      </section>}
      {data.direction==="outbound_forward"&&data.transport_state==="delivered"&&<p className="notice" role="status"><strong>Delivered to domestic freight forwarder.</strong> International forwarding is managed by your forwarder.</p>}
      {data.direction==="outbound_return"&&data.transport_state==="delivered"&&<p className="notice" role="status"><strong>Delivered to seller.</strong> Seller refund depends on your seller platform confirmation.</p>}
      {(data.translation_status==="updating"||data.translation_status==="pending")&&<p className="muted small" role="status">English details are being updated{data.latest_event_at?` · Latest carrier event ${stamp(data.latest_event_at)}`:""}.</p>}
      {(data.sync_state==="needs_verification"||data.sync_state==="needs_carrier")&&<p className="notice" role="status">Verification needed — confirm the carrier or shipping label phone number to continue tracking.</p>}
      {data.sync_state==="no_record"&&<p className="muted small" role="status">No carrier events reported yet — the carrier may not have scanned the parcel yet.</p>}
      {(data.sync_state==="delayed"||data.sync_state==="provider_error")&&<p className="muted small" role="status">Carrier updates are temporarily delayed — showing the last known snapshot from {stamp(data.last_success_at)}.</p>}
      {data.sync_state==="unsupported"&&<p className="muted small" role="status">Automatic tracking is not supported for this carrier; warehouse check-in and handover updates will still appear here.</p>}
      {nextManualRefresh&&<p className="muted small" role="status">Carrier update requested. Tracking will refresh when the warehouse system receives a response.</p>}
      {manualRefresh&&nextQueryAt&&Date.parse(nextQueryAt)>Date.now()&&<p className="muted small">Next carrier update request available at {stamp(nextQueryAt)}.</p>}
      {(canVerify||canCorrect)&&<>
        {verification.error&&<><ErrorBlock error={verification.error}/><button type="button" onClick={verification.reload}>Retry tracking verification</button></>}
        {!verification.data&&!verification.error&&<p role="status">Loading tracking verification…</p>}
        {carriers.error&&<><ErrorBlock error={carriers.error}/><button type="button" onClick={carriers.reload}>Retry carriers</button></>}
        {!carriers.data&&!carriers.error&&<p role="status">Loading carriers…</p>}
      </>}
      {canVerify&&verification.data&&!verification.error&&(verification.data.carrier_code||carriers.data&&!carriers.error)&&<Form label="Verify carrier tracking" run={async f=>{
        const phone=text(f,"phone");
        await request(verificationPath,"POST",{revision:verification.data?.revision,carrier_code:verification.data?.carrier_code??text(f,"carrier_code"),...(phone?{phone}:{})});
        verification.reload();reload();
      }}>
        {!verification.data.carrier_code&&<Select name="carrier_code" label="Carrier" choices={(carriers.data?.carriers??[]).map((c:Row)=>({id:c.code,label:c.labels.en}))}/>}
        <Field name="phone" label="Phone used on this shipping label, if required by the carrier" required={false} type="tel"/>
      </Form>}
      {canCorrect&&verification.data&&!verification.error&&carriers.data&&!carriers.error&&<details className="top-gap"><summary>Correct tracking number or carrier before check-in</summary>
        <Form key={data.tracking_id} label="Save corrected tracking" run={async f=>{
          const phone=text(f,"phone");
          const corrected=await request(path+id+"/correct","POST",{
            revision:verification.data?.revision,
            carrier_code:text(f,"carrier_code"),
            tracking_no:text(f,"tracking_no"),
            reason:text(f,"reason"),
            ...(phone?{phone}:{}),
          });
          setCorrectedTracking(corrected.tracking_no);
          setCorrectionCarrier("");
          verification.reload();reload();
        }}>
          <label>Carrier<select name="carrier_code" value={selectedCarrier} required onChange={e=>setCorrectionCarrier(e.target.value)}>
            <option value="">Choose a carrier</option>
            {carriers.data.carriers.map((carrier:Row)=><option key={carrier.code} value={carrier.code}>{carrier.labels.en}</option>)}
          </select></label>
          <Field name="tracking_no" label="Corrected tracking number" value={data.tracking_no}/>
          <Field name="reason" label="Reason for correction"/>
          {labelPhoneHint&&<Field key={selectedCarrier} name="phone" label={labelPhoneHint} type="tel"/>}
        </Form>
        {correctedTracking&&<p className="notice ok" role="status">Tracking updated to <strong className="code">{correctedTracking}</strong>.</p>}
      </details>}
      <p className="muted small">Carrier data updated {stamp(data.last_success_at)}</p>
      {data.events.length?<ol className="timeline">{data.events.map((e:Row)=><li key={e.id}><small>{stamp(e.occurred_at)}</small><br/>{e.text}</li>)}</ol>:<Empty>English carrier events will appear when verified tracking data is available.</Empty>}
    </Panel>}
  </>;
}
const scopePaymentLabels:Record<string,string>={open:"Payment due",expired:"Quote expired",processing:"Processing"};
function orderNextAction(o:Row):{label:string;href:string} {
  const base="/orders/"+o.public_no;
  if(o.scope_payment) return {label:"Review scope charge",href:inspectionScopePath(o.public_no,o.scope_payment.id)};
  switch(o.state) {
    case "draft": return {label:"Resume wizard",href:"/orders/new?draft="+encodeURIComponent(o.public_no)};
    case "awaiting_payment": return {label:o.payment_state==="expired"?"Review expired quote":o.payment_state==="reconciliation"?
      "Check previous payment status":o.payment_state==="processing"?"Track payment confirmation":"Complete payment",href:base+"/payment"};
    case "awaiting_samples": return {label:o.parcel_registration_due?"Register seller tracking":"Track inbound parcels",href:base+"/parcels"};
    case "report_ready":
    case "action_pending": return {label:"Choose item handling",href:base+"/dispositions"};
    case "on_hold": return {label:"Review hold reason",href:base};
    default: return {label:"View progress",href:base};
  }
}
export function CustomerDesk({path,demo=false}:{path:string;demo?:boolean}) {
  const stamp=useWorkspaceStamp();
  const search=useSearchParams();
  const router=useRouter();
  const orderParams=new URLSearchParams();
  for(const key of ["q","state","page"]) {
    const value=search.get(key);
    if(value) orderParams.set(key,value);
  }
  const orderList=useLoad(path==="/orders"?"/me/orders?"+orderParams:null);
  const caseParams=new URLSearchParams();
  for(const key of ["q","state","page"]) {
    const value=search.get(key);
    if(value)caseParams.set(key,value);
  }
  const caseList=useLoad(path==="/support"?"/me/cases?"+caseParams:null);
  function supportPage(page:number) {
    const params=new URLSearchParams(caseParams);
    if(page>1)params.set("page",String(page));
    else params.delete("page");
    const parcel=search.get("parcel");
    if(parcel)params.set("parcel",parcel);
    return "/support"+(params.size?"?"+params:"");
  }
  const isItems=path==="/items",isBills=path==="/account/billing";
  const itemFilter=search.get("filter")??"all";
  const itemPage=Number(search.get("page")??1);
  const inventory=useLoad(isItems?`/me/inventory?${new URLSearchParams({filter:itemFilter,page:String(itemPage)})}`:null);
  const [legacyItem,setLegacyItem]=useState<string|null>(null);
  const [legacyCharge,setLegacyCharge]=useState<string|null>(null);
  const requestedItem=search.get("item")??legacyItem;
  const focusedItem=useLoad(isItems&&requestedItem?"/me/inventory?code="+encodeURIComponent(requestedItem):null);
  const [handlingItems,setHandlingItems]=useState<Row[]>([]);
  const [handlingNotice,setHandlingNotice]=useState("");
  const parcelTabs=[["incoming","Incoming"],["received","Received"],["attention","Needs Attention"],["outgoing","Outgoing"]];
  const parcelTab=parcelTabs.find(([id])=>id===search.get("tab"))?.[0]??"incoming";
  const claimPage=Number(search.get("claim_page")??1);
  const parcelPage=Number(search.get("page")??1);
  const parcelList=useLoad(path==="/parcels"?"/me/parcels?"+new URLSearchParams({tab:parcelTab,page:String(parcelPage)}):null);
  function parcelPageHref(page:number) {
    const params=new URLSearchParams(search);
    if(page>1)params.set("page",String(page));
    else params.delete("page");
    return "/parcels"+(params.size?"?"+params:"");
  }
  function selectParcelTab(tab:string) {
    const params=new URLSearchParams(search);
    params.delete("claim_page");
    params.delete("page");
    if(tab==="incoming")params.delete("tab");
    else params.set("tab",tab);
    router.push("/parcels"+(params.size?"?"+params:""),{scroll:false});
  }
  const [addressCopied,setAddressCopied]=useState(false);
  const [createdCase,setCreatedCase]=useState<Row>();
  const [caseFormVersion,setCaseFormVersion]=useState(0);
  const requestedCharge=isBills?(search.get("charge")??legacyCharge)?.toLowerCase():undefined;
  const requestedQuote=isBills?search.get("quote")?.toLowerCase():undefined;
  const chargePage=Number(search.get("charge_page")??1);
  const refundPage=Number(search.get("refund_page")??1);
  function billingPageHref(section:"charge"|"refund",page:number) {
    const params=new URLSearchParams(search);
    if(requestedCharge)params.set("charge",requestedCharge);
    const key=section+"_page";
    if(page>1)params.set(key,String(page));
    else params.delete(key);
    return "/account/billing"+(params.size?"?"+params:"")+"#"+(section==="charge"?"billing-charges":"billing-refunds");
  }
  const focusedQuote=useLoad(requestedQuote?"/quotes/"+encodeURIComponent(requestedQuote):null);
  const {data,error,reload}=useLoad("/me/desk?include_items=0"+(path==="/account"?"":"&include_activity=0")+
    (isBills?"&"+new URLSearchParams({charge_page:String(chargePage),refund_page:String(refundPage)}):"")+
    (requestedCharge?"&charge="+encodeURIComponent(requestedCharge):"")),carriers=useLoad("/carriers");
  const focusedChargeAvailable=Boolean(requestedCharge&&data?.bills.some((bill:Row)=>bill.charge_item_id===requestedCharge));
  const focusedQuoteAvailable=Boolean(data&&requestedQuote&&focusedQuote.data?.id===requestedQuote);
  const homeActions=useLoad(path==="/account"?"/actions":null);
  const [next,setNext]=useState<string|null>(null);
  const parcelOrder=search.get("order");
  const [orderSearchInput,setOrderSearchInput]=useState("");
  const [orderSearch,setOrderSearch]=useState<{query:string;page:number}|null>(null);
  const parcelOrderLookup=useLoad(path==="/parcels"&&orderSearch?"/me/orders?"+new URLSearchParams({q:orderSearch.query,page:String(orderSearch.page)}):null);
  const preferredParcelOrder=useLoad(path==="/parcels"&&parcelOrder?"/orders/"+encodeURIComponent(parcelOrder):null);
  const [foundOrderOptions,setFoundOrderOptions]=useState<{owner:string;rows:Row[]}>({owner:"",rows:[]});
  useEffect(()=>{
    const owner=data?.profile.receiving_code;
    if(path!=="/parcels"||!owner)return;
    const incoming=[...(parcelOrderLookup.data?.rows??[]),...(preferredParcelOrder.data?[preferredParcelOrder.data]:[])];
    setFoundOrderOptions(previous=>({owner,rows:[...new Map([...(previous.owner===owner?previous.rows:[]),...incoming].map(order=>[order.id,order])).values()]}));
  },[path,data?.profile.receiving_code,parcelOrderLookup.data,preferredParcelOrder.data]);
  const [trackTarget,setTrackTarget]=useState<CustomerTrackingTarget|null>(null);
  const [itemTarget,setItemTarget]=useState<Row|null>(null);
  const [batchTarget,setBatchTarget]=useState<string|null>(null);
  useEffect(()=>{
    const params=new URLSearchParams(location.search);
    setNext(customerDestination(params.get("next")));
  },[path]);
  const [batchIds,setBatchIds]=useState<string[]>([]);
  useEffect(()=>{
    if(!isItems) return;
    function readHash() {setLegacyItem(location.hash.match(/^#item-(S-[a-zA-Z0-9-]+)$/)?.[1]??null);}
    readHash();
    window.addEventListener("hashchange",readHash);
    return ()=>window.removeEventListener("hashchange",readHash);
  },[isItems]);
  useEffect(()=>{
    if(!isBills) return;
    function readHash() {setLegacyCharge(location.hash.match(/^#charge-([a-f0-9-]{36})$/i)?.[1]??null);}
    readHash();
    window.addEventListener("hashchange",readHash);
    return ()=>window.removeEventListener("hashchange",readHash);
  },[isBills]);
  useEffect(()=>{
    if(focusedChargeAvailable&&!["#billing-charges","#billing-refunds"].includes(location.hash))
      document.getElementById("charge-"+requestedCharge)?.focus();
  },[focusedChargeAvailable,requestedCharge]);
  useEffect(()=>{
    if(focusedQuoteAvailable) document.getElementById("quote-"+requestedQuote)?.focus();
  },[focusedQuoteAvailable,requestedQuote]);
  useEffect(()=>{
    if(!isBills||!data) return;
    const now=Date.now();
    const expiry=Math.min(...data.bills.filter((bill:Row)=>bill.state==="open")
      .map((bill:Row)=>Date.parse(bill.expires_at)).filter((time:number)=>time>now));
    if(!Number.isFinite(expiry)) return;
    const timer=setTimeout(reload,Math.min(expiry-now+50,2_147_483_647));
    return ()=>clearTimeout(timer);
  },[data,isBills,reload]);
  useEffect(()=>{
    const item=focusedItem.data?.rows[0];
    if(item) setItemTarget(item);
  },[focusedItem.data]);
  useEffect(()=>{
    if(!data)return;
    const id=location.hash.slice(1);
    if(/^(case|quote|charge|item)-[a-zA-Z0-9-]{1,64}$/.test(id)||id==="billing-charges"||id==="billing-refunds")
      document.getElementById(id)?.scrollIntoView({block:"start"});
  },[data,path]);
  if(error)return <><ErrorBlock error={error}/><button type="button" onClick={reload}>Retry workspace</button></>;
  if(!data)return <p role="status">Loading your account…</p>;
  const addr=data.profile.warehouse_address;
  const isHome=path==="/account",isSecurity=path==="/account/security",isParcels=path==="/parcels",isOrders=path==="/orders",isHelp=path==="/support";
  const orders:Row[]=data.orders;
  const otherQuotes:Row[]=isBills?data.quotes.filter((quote:Row)=>quote.id!==requestedQuote):[];
  const linkableOrders=[...new Map([...(foundOrderOptions.owner===data.profile.receiving_code?foundOrderOptions.rows:[]),...orders].map(order=>[order.id,order])).values()]
    .filter(order=>parcelLinkStates.includes(order.state));
  const visibleOrders:Row[]=isHome?orders.slice(0,5):orderList.data?.rows??[];
  const page=Number(orderParams.get("page")??1);
  function ordersHref(target:number) {
    const params=new URLSearchParams(orderParams);
    if(target<=1) params.delete("page");
    else params.set("page",String(target));
    return "/orders"+(params.size?"?"+params:"");
  }
  function inventoryHref(page:number,filter=itemFilter,item?:string) {
    const params=new URLSearchParams();
    if(page>1) params.set("page",String(page));
    if(filter!=="all") params.set("filter",filter);
    if(item) params.set("item",item);
    return "/items"+(params.size?"?"+params:"");
  }
  function refreshInventory() {inventory.reload();reload();}
  const visibleItems:Row[]=inventory.data?.rows??[];
  const itemCounts=inventory.data?.summary;
  const parcelRows:Row[]=parcelList.data?.rows??[];
  return <>
    {data.email_delivery?.banner_message&&<div className="notice" role="alert"><strong>{data.email_delivery.banner_message}</strong>{data.email_delivery.masked_email?` (${data.email_delivery.masked_email})`:""}. Important updates remain available in your account notifications and action centre. <Link href="/account/security">Update email in account security →</Link></div>}
    {isHome&&<>
      <div className="page-head row">
        <div><p className="eyebrow">MY WORKSPACE</p><h1>Workspace Overview</h1><p className="muted">Your active inspections, parcels, items awaiting instructions and permanent China warehouse receiving address.</p></div>
        <div className="head-actions"><Link className="button sm" href="/account/security">Profile &amp; security</Link><Link className="button primary sm" href="/orders/new">+ Create Inspection</Link></div>
      </div>
      <div className="metric-strip" aria-label="Account summary">
        <Link className="metric" href="/orders"><span>Active Inspections</span><strong>{data.summary.active_inspections}</strong><small>Submitted inspections still open</small></Link>
        <Link className="metric" href="/parcels"><span>Parcels</span><strong>{data.summary.awaiting_check_in}</strong><small>awaiting check-in · {data.summary.checked_in} checked in at warehouse</small></Link>
        <Link className="metric" href="/items"><span>Items Awaiting Instructions</span><strong>{data.summary.awaiting_instructions}</strong><small>{data.summary.in_custody} items in warehouse custody</small></Link>
        <Link className="metric" href="/account/billing"><span>Quotes Awaiting Approval</span><strong>{data.summary.pending_quotes}</strong><small>Inspection, shipping and storage quotes</small></Link>
      </div>
      {homeActions.error&&<><ErrorBlock error={homeActions.error}/><button type="button" onClick={homeActions.reload}>Retry actions</button></>}
      {!homeActions.data&&!homeActions.error&&<p role="status">Loading actions…</p>}
      {(homeActions.data?.rows?.length??0)>0&&<div className="order-next" role="status">
        <div><h2>Action Required</h2><ul className="workspace-actions-list">{homeActions.data!.rows.slice(0,3).map((action:Row)=>
          <li key={action.kind+action.id}><Link href={customerActionHref(action)}>{actionTitles[action.state]??"Review action"}</Link>
            {action.reference&&<span className="code"> · {action.reference}</span>}</li>)}</ul></div>
        <div className="actions"><Link className="button primary sm" href="/actions">Review actions →</Link></div>
      </div>}
        <Panel title="China Warehouse Receiving Address" subtitle="Include your permanent receiving code on the seller’s shipping label."
          badge={demo?<Tag tone="yellow">Test address</Tag>:addr?<Tag tone="green">Current address</Tag>:undefined}>
          {demo&&<div className="demo-address-alert" role="note">
            <strong>Sandbox / Test Warehouse Address — Do Not Ship Real Commercial Cargo</strong>
            <p className="small" style={{margin:"4px 0 0"}}>
              You are viewing a local/test receiving address for <span className="mono">{data.profile.receiving_code}</span>. Only use a verified production receiving address before dispatching physical inventory.
            </p>
          </div>}
          {data.warehouse_address_changed_at&&<p className="notice" role="status">The warehouse address changed on {stamp(data.warehouse_address_changed_at)}. Use the current address below for new shipments.</p>}
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
      {isOrders&&orderList.error&&<><ErrorBlock error={orderList.error}/><button type="button" onClick={orderList.reload}>Retry orders</button></>}
      {isOrders&&!orderList.data&&!orderList.error&&<p role="status">Loading orders…</p>}
      {visibleOrders.length?<Table headers={isHome?["Order","Service","Inspection status","Next action"]:["Order","Service & items","Inspection status","Payment","Report","Updated","Next action"]} rows={visibleOrders.map(o=>{
        const nextAction=orderNextAction(o);
        const lineSummary=[
          o.expected_lines_count>1?`${o.expected_lines_count} lines`:null,
          o.item_count!=null?`${o.item_count} ${o.item_count===1?"unit":"units"}`:null,
          o.supplier_count>1?`${o.supplier_count} suppliers`:null,
          o.parcel_count>0?`${o.parcel_count} ${o.parcel_count===1?"parcel":"parcels"}`:null,
          o.arrived_item_count>0?`${o.arrived_item_count}/${o.item_count} arrived`:null,
        ].filter(Boolean).join(" · ");
        const service=<div className="cell-stack"><span>{o.service_title??"—"}</span>{lineSummary&&<small>{lineSummary}</small>}</div>;
        const statusCell=<Tag tone={o.state==="on_hold"?"red":["report_ready","action_pending"].includes(o.state)?"green":o.state==="draft"?"gray":"blue"}>{label(o.state)}</Tag>;
        const next=<Link className="small" href={nextAction.href}>{nextAction.label} →</Link>;
        const orderLink=<Link className="code" href={"/orders/"+o.public_no}>{o.public_no}</Link>;
        return isHome?[orderLink,service,statusCell,next]:[
          orderLink,service,statusCell,
          o.scope_payment?<Tag tone="yellow">{scopePaymentLabels[o.scope_payment.state]}</Tag>:
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
      {parcelOrder&&preferredParcelOrder.error&&<><ErrorBlock error={preferredParcelOrder.error}/><button type="button" onClick={preferredParcelOrder.reload}>Retry requested order</button></>}
      {parcelOrder&&!preferredParcelOrder.data&&!preferredParcelOrder.error&&<p role="status">Loading the requested order…</p>}
      {preferredParcelOrder.data&&!parcelLinkStates.includes(preferredParcelOrder.data.state)&&<p className="notice">The requested order is no longer accepting parcels.</p>}
      {carriers.error?<><ErrorBlock error={carriers.error}/><button type="button" onClick={carriers.reload}>Retry carriers</button></>:
        !carriers.data?<p role="status">Loading carriers…</p>:
        <InboundParcelForm address={addr} carriers={carriers.data.carriers} orders={linkableOrders} preferredOrder={parcelOrder}
          onSave={()=>{if(parcelTab!=="incoming"||parcelPage>1)selectParcelTab("incoming");parcelList.reload();reload();}}/>}
    </details>
    <details className="card">
      <summary>Find an older order to link</summary>
      <div className="form">
        <label>Order number to find<input type="search" maxLength={68} value={orderSearchInput} onChange={event=>setOrderSearchInput(event.target.value)}
          onKeyDown={event=>{if(event.key==="Enter"&&orderSearchInput.trim()){event.preventDefault();setOrderSearch({query:orderSearchInput.trim(),page:1});}}}/></label>
        <button type="button" className="button" disabled={!orderSearchInput.trim()} onClick={()=>setOrderSearch({query:orderSearchInput.trim(),page:1})}>Find order</button>
        {parcelOrderLookup.error&&<><ErrorBlock error={parcelOrderLookup.error}/><button type="button" onClick={parcelOrderLookup.reload}>Retry order search</button></>}
        {orderSearch&&!parcelOrderLookup.data&&!parcelOrderLookup.error&&<p role="status">Loading matching orders…</p>}
        {parcelOrderLookup.data&&!parcelOrderLookup.error&&<>
          <p role="status">{parcelOrderLookup.data.rows.filter((order:Row)=>parcelLinkStates.includes(order.state)).length} matching orders on this page are available in the order choices below.</p>
          {(orderSearch!.page>1||parcelOrderLookup.data.has_more)&&<nav className="actions" aria-label="Order match pages">
            {orderSearch!.page>1&&<button type="button" onClick={()=>setOrderSearch(current=>current&&({...current,page:current.page-1}))}>Previous order matches</button>}
            <span>Page {orderSearch!.page}</span>
            {parcelOrderLookup.data.has_more&&<button type="button" onClick={()=>setOrderSearch(current=>current&&({...current,page:current.page+1}))}>Next order matches</button>}
          </nav>}
        </>}
      </div>
    </details>
    <div className="actions workspace-filters" aria-label="Parcel filters">
      {parcelTabs.map(([key,title])=>
        <button type="button" key={key} aria-pressed={parcelTab===key} className={parcelTab===key?"button primary":"button"}
          onClick={()=>selectParcelTab(key)}>{title}</button>)}
    </div>
    {parcelList.error&&<><ErrorBlock error={parcelList.error}/><button className="button sm" onClick={parcelList.reload}>Retry parcels</button></>}
    {!parcelList.data&&!parcelList.error&&<p role="status">Loading parcels…</p>}
    {parcelList.data&&parcelTab!=="outgoing"&&<Panel title={parcelTab==="received"?"Warehouse receipts":parcelTab==="attention"?"Parcels needing attention":"Incoming parcels"}>
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
            {a.declared_item_count>0&&<small>{a.declared_item_count} expected {a.declared_item_count===1?"item":"items"}{a.declared_suppliers?.length?` · ${a.declared_suppliers.join(", ")}`:""}</small>}
            {Array.isArray(a.declared_line_breakdown)&&a.declared_line_breakdown.length>0&&<div className="small muted">
              {a.declared_line_breakdown.slice(0,4).map((line:Row)=>[line.sku_code||line.product_name,line.color_declared,line.size_label].filter(Boolean).join("/")+` ×${line.qty}`).join(" · ")}
              {a.declared_line_breakdown.length>4&&` +${a.declared_line_breakdown.length-4} more`}
            </div>}
            {candidates.length>0&&<details className="small">
              <summary style={{cursor:"pointer"}}>+ Link to order</summary>
              <Form label="Link" run={async f=>{
                await request(`/me/parcels/${a.id}/link-order`,"POST",{order_id:text(f,"order_id")});
                parcelList.reload();
                reload();
              }}>
                <Select name="order_id" label="Order" choices={candidates.map(o=>({id:o.id,label:`${o.public_no} (${label(o.state)})`}))}/>
              </Form>
            </details>}
          </div>,
          <div className="cell-stack">
            <span>{label(a.warehouse_state??"awaiting_warehouse")}{a.package_code?` · ${a.package_code}`:""}</span>
            {(a.logged_item_count!=null||a.received_quantity!=null)&&(()=>{
              const logged=a.logged_item_count??a.received_quantity;
              const mismatch=a.declared_item_count>0&&logged!==a.declared_item_count;
              return <>
                <small>{logged} logged at warehouse{a.declared_item_count>0?` vs ${a.declared_item_count} expected`:""}</small>
                {mismatch&&<Tag tone="yellow">Quantity discrepancy ({logged}/{a.declared_item_count})</Tag>}
                {a.condition_note&&<small className="muted">Note: {a.condition_note}</small>}
              </>;
            })()}
          </div>,
          label(a.transport_state),
        ];
      })} empty="No parcels match this view."/>
    </Panel>}
    {parcelList.data&&parcelTab==="outgoing"&&<Panel title="Outbound parcels">
      <Table headers={["Tracking number","Batch","Destination type","Warehouse handover",""]} rows={parcelRows.map(s=>[
        <div className="actions">
          <CodeButton code={s.tracking_norm} title="Preview outbound tracking" onClick={()=>setTrackTarget({kind:"shipments",id:s.id,code:s.tracking_norm})}/>
          <Link className="small muted" href={"/shipments/"+s.id}>Page →</Link>
        </div>,
        s.batch_id?<CodeButton code={`#${String(s.batch_id).slice(0,8)}`} onClick={()=>setBatchTarget(s.batch_id)}/>:"—",
        label(s.action),
        stamp(s.shipped_at),
        <CodeButton code="Track" onClick={()=>setTrackTarget({kind:"shipments",id:s.id,code:s.tracking_norm})}/>,
      ])} empty="No outbound shipments yet."/>
    </Panel>}
    {parcelList.data&&(parcelPage>1||parcelList.data.has_more)&&<nav className="actions" aria-label="Parcel pages">
      {parcelPage>1&&<Link className="button" href={parcelPageHref(parcelPage-1)}>Previous page</Link>}
      <span>Page {parcelPage}</span>
      {parcelList.data.has_more&&<Link className="button" href={parcelPageHref(parcelPage+1)}>Next page</Link>}
    </nav>}
    {parcelTab==="attention"&&<ParcelOwnershipReviews carriers={carriers.data?.carriers} carrierError={carriers.error}
      onReloadCarriers={carriers.reload} page={claimPage}/>}
    </>}
    {isItems&&<><div className="page-head"><p className="eyebrow">Inventory &amp; handling</p><h1>Warehouse items</h1><p className="muted">Click any item code, tracking number or dispatch batch to inspect details, or submit batch handling instructions below.</p></div>
    <div className="metric-strip" aria-label="Items summary">
      {[
        ["Warehouse items",itemCounts?.total??"—"],
        ["Awaiting or in inspection",itemCounts?.inspection??"—"],
        ["Awaiting instructions",itemCounts?.handling??"—"],
        ["Active reference samples",itemCounts?.reference??"—"],
      ].map(([name,value])=><div className="metric" key={name}><span>{name}</span><strong>{value}</strong></div>)}
    </div>
    {handlingItems.length>0&&<div className="customer-selection-tools" role="region" aria-label="Selected item actions">
      <strong>{handlingItems.length} selected</strong><a className="button primary" href="#item-instructions">Review instructions</a>
    </div>}
    {(inventory.data?.awaiting_arrival_orders?.length??0)>0&&<Panel title="Awaiting warehouse arrival" subtitle="Paid orders whose items have not yet passed physical warehouse intake check-in.">
      <Table
        headers={["Order","Status","Expected / Arrived","Action"]}
        rows={(inventory.data?.awaiting_arrival_orders??[]).map((ord:Row)=>[
          <Link className="code" href={"/orders/"+ord.public_no}>{ord.public_no}</Link>,
          <Tag tone={ord.state==="on_hold"?"red":"blue"}>{label(ord.state)}</Tag>,
          `${ord.arrived_units??0} / ${ord.expected_units??0} arrived`,
          ord.parcel_registration_due
            ?<Link className="button sm primary" href={`/orders/${ord.public_no}/parcels`}>Register seller waybill →</Link>
            :<Link className="small" href={`/orders/${ord.public_no}`}>View order →</Link>,
        ])}
      />
    </Panel>}
    <Panel title="Your items">
      <label>Show items <select value={itemFilter} onChange={event=>router.push(inventoryHref(1,event.target.value),{scroll:false})}>
        <option value="all">All items</option><option value="inspection">Awaiting or in inspection</option>
        <option value="inspected">Inspection complete</option>
        <option value="handling">Awaiting instructions</option><option value="reference">Active Golden Samples</option>
      </select></label>
      {itemCounts&&<p className="small muted">{itemCounts.inspected} {itemCounts.inspected===1?"item has":"items have"} completed inspection. Reports and handling instructions follow their own status.</p>}
      {focusedItem.error&&<><ErrorBlock error={focusedItem.error}/><button type="button" onClick={focusedItem.reload}>Retry item details</button></>}
      {requestedItem&&!focusedItem.data&&!focusedItem.error&&<p role="status">Loading selected item…</p>}
      {inventory.error&&<><ErrorBlock error={inventory.error}/><button className="button sm" onClick={inventory.reload}>Retry inventory</button></>}
      {!inventory.data&&!inventory.error&&<p role="status">Loading items…</p>}
      {!!visibleItems.length&&<div className="customer-inventory-table"><Table headers={["Item","Inbound / Package","Order & inspection","Custody","Storage through","Reference / Dispatch","Next action"]} rows={visibleItems.map((w:Row)=>[
        <div className="cell-stack">
          <div id={"item-"+w.code}><CodeButton code={w.code} onClick={()=>setItemTarget(w)}/></div>
          {w.declared_fields?.name&&<small>{w.declared_fields.name} {[w.declared_fields.color_declared,w.declared_fields.size_label].filter(Boolean).join(" · ")}</small>}
          {w.components?.length>0&&<small className="muted">Components: {w.components.map((c:Row)=>c.code).join(", ")}</small>}
        </div>,
        <div className="cell-stack">
          <span className="code">{w.package_code??"—"}</span>
          {w.inbound_advice_id&&w.inbound_tracking_norm&&<small><CodeButton code={w.inbound_tracking_norm} onClick={()=>setTrackTarget({kind:"parcels",id:w.inbound_advice_id,code:w.inbound_tracking_norm})}/></small>}
        </div>,
        <div className="cell-stack">{w.order_no?<Link className="code-btn" href={"/orders/"+w.order_no}>{w.order_no}</Link>:<span>Uncommissioned</span>}
          <Tag tone={w.inspection_stage==="inspected"?"green":w.inspection_stage==="in_inspection"?"blue":"outline"}>{itemInspectionLabel(w)}</Tag>
          {w.order_no&&<small>Order: {label(w.order_state)}</small>}</div>,
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
        w.handling_hold?<Tag tone="yellow">{handlingHoldLabel[w.handling_hold]}</Tag>:
          w.instructions.length>0?w.instructions.map((i:string)=><label key={i} className="small"><input type="checkbox" checked={batchIds.includes(i)} onChange={e=>setBatchIds(xs=>e.target.checked?[...xs,i]:xs.filter(x=>x!==i))}/> Select for shipping</label>):
          w.active_disposition?<Tag tone="outline">{label(w.active_disposition.action)}</Tag>:canChooseHandling(w)?<label className="small">
            <input type="checkbox" aria-label={`Select ${w.code} for handling`} checked={handlingItems.some(row=>row.item_id===w.item_id)}
              onChange={e=>setHandlingItems(rows=>e.target.checked?[...rows,w]:rows.filter(row=>row.item_id!==w.item_id))}/> Select for handling
          </label>:"—",
      ])}/></div>}
      {inventory.data&&!visibleItems.length&&<Empty>{itemCounts?.total?"No items match this view.":"Items will appear after physical warehouse intake and ownership verification."}</Empty>}
      {inventory.data&&(itemPage>1||inventory.data.has_more)&&<nav className="actions" aria-label="Inventory pages">
        {itemPage>1&&<Link className="button sm" href={inventoryHref(itemPage-1)} scroll={false}>Previous</Link>}
        <span>Page {itemPage}</span>
        {inventory.data.has_more&&<Link className="button sm" href={inventoryHref(itemPage+1)} scroll={false}>Next</Link>}
      </nav>}
      {!!batchIds.length&&<Action primary run={async()=>{
        let batch:Row|undefined;
        try {
          const created=await request("/dispatch-batches","POST",{disposition_ids:batchIds});
          batch=created;
          setBatchIds(current=>current.filter(id=>!batchIds.includes(id)));
          await request("/dispatch-batches/"+created.batch_id+"/confirm","POST",{revision:created.revision});
        } catch(error) {
          if(batch) setBatchTarget(batch.batch_id);
          throw error;
        } finally {refreshInventory();}
      }}>Confirm selected items for quoting ({batchIds.length})</Action>}
      {data.batches.map((b:Row)=><div key={b.id} className="notice row"><span>Draft shipping batch <strong className="code">#{b.id.slice(0,8)}</strong></span><div className="actions"><CodeButton code="Inspect / Amend" onClick={()=>setBatchTarget(b.id)}/><Action run={async()=>{await request("/dispatch-batches/"+b.id+"/confirm","POST",{revision:b.revision});refreshInventory();}}>Confirm draft batch</Action></div></div>)}
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
    <Panel id="reference-samples" title="Reference samples">
      <Table headers={["Item","Revision","Status","Valid through",""]} rows={(data.references??[]).map((r:Row)=>[
        <Link className="code-btn" href={inventoryHref(itemPage,itemFilter,r.code)} scroll={false}>{r.code}</Link>,`v${r.revision??1}`,
        <Tag>{r.in_use?"Locked in comparison":r.state==="active"&&r.expired?"Expired":label(r.state)}</Tag>,
        stamp(r.expires_at),
        r.state==="active"&&!r.in_use?<Action key={r.reference_id} idempotent onSettled={refreshInventory} run={async key=>{
          const t=await request("/public/terms");
          const termsId=t.terms?.find((x:Row)=>x.kind==="terms")?.id;
          if(!termsId) throw new Error("Service terms are unavailable.");
          await request("/me/reference-samples/"+r.reference_id+"/release","POST",{terms_version_id:termsId,reason:"Customer released reference sample"},key);
        }}>Release reference</Action>:r.in_use?<small>In active comparison</small>:null,
      ])} empty="No reference samples reserved yet. Use the instruction form below to reserve a stored item as a reference sample."/>
    </Panel>
    <Panel id="item-instructions" title="Request handling for items">
      {handlingNotice&&<div className="notice ok"><p role="status">{handlingNotice}</p>
        {itemFilter==="handling"&&<Link href={inventoryHref(1,"all")} scroll={false}>View items with saved instructions</Link>}
      </div>}
      {handlingItems.length?<>
        <button className="button sm" type="button" onClick={()=>setHandlingItems([])}>Clear selection</button>
        <ItemInstructionForm items={handlingItems} preselected recentDestinations={data.recent_destinations??[]}
          onSave={recorded=>{
            const ids=new Set(recorded.map(item=>item.item_id));
            setHandlingItems(rows=>rows.filter(row=>!ids.has(row.item_id)));
            setHandlingNotice("Instructions recorded for "+recorded.map(item=>item.code).join(", ")+".");
            refreshInventory();
          }}/>
      </>:<Empty>Select eligible items above to request handling.</Empty>}
    </Panel></>}
    {isBills&&<><div className="page-head"><p className="eyebrow">Account services</p><h1>Billing</h1><p className="muted">Review shipping quotes, charges and refunds for your inspections.</p></div>
      {requestedQuote&&<Panel title="Fulfillment quote">
        {focusedQuote.error?<><ErrorBlock error={focusedQuote.error}/><button type="button" onClick={focusedQuote.reload}>Retry</button></>:
          !focusedQuote.data?<p role="status">Loading fulfillment quote…</p>:
          <FulfillmentQuote quote={focusedQuote.data} focused onUpdate={()=>{reload();focusedQuote.reload();}} onOpenBatch={setBatchTarget}/>}
      </Panel>}
    <Panel title="Quotes awaiting your approval">
      {otherQuotes.map(quote=><FulfillmentQuote key={quote.id} quote={quote} onUpdate={reload} onOpenBatch={setBatchTarget}/>)}
      {data.inspectionQuotes.map((quote:Row)=><div className="card row" key={quote.id}>
        <div><strong>Inspection · {quote.order_number}</strong><p>{usd(quote.amount_cents)} · Valid until {stamp(quote.expires_at)}</p></div>
        <Link className="button" href={"/orders/"+quote.order_number+"#inspection-quote"}>Review inspection quote</Link>
      </div>)}
      {!otherQuotes.length&&!data.inspectionQuotes.length&&<Empty>{focusedQuote.data?.state==="open"?"No other quotes to approve.":"No new quotes."}</Empty>}
    </Panel><div id="billing-charges" className="billing-charge-anchor"><Panel title="Payments & charges" subtitle="Inspection, shipping and storage charges. Payment is confirmed only after server-side verification.">
      {requestedCharge&&chargePage===1&&!focusedChargeAvailable&&<p role="status">This charge is unavailable.</p>}
      <Table headers={["Purpose","Order / Batch","Amount","Refunded","Status","Date","Details",""]} rows={data.bills.map((b:Row)=>{
        const quoteExpired=b.state==="open"&&b.expires_at&&Date.parse(b.expires_at)<=Date.now();
        const shownState=b.inspection_payment_state??(quoteExpired?(b.unresolved_payment?"processing":"expired"):b.state);
        const inspectionPaymentLabel=({
          reconciliation:"Check previous payment status",expired:"Review expired quote",processing:"Track payment confirmation",
        } as Record<string,string>)[b.inspection_payment_state];
        const inspectionPaymentHref=b.inspection_order_number?"/orders/"+b.inspection_order_number+"/payment":null;
        return [
          <span id={"charge-"+b.charge_item_id} className="billing-charge-anchor" tabIndex={b.charge_item_id===requestedCharge?-1:undefined}>{b.scope_revision_id?"Supplemental inspection":label(b.purpose)}</span>,
          (b.order_numbers??[]).length?b.order_numbers.map((no:string)=><Link key={no} className="code-btn" href={"/orders/"+no}>{no}</Link>):b.batch_id?<CodeButton code={`Batch #${b.batch_id.slice(0,8)}`} onClick={()=>setBatchTarget(b.batch_id)}/>:"—",
          usd(b.amount_cents),
          b.refunded_cents?usd(b.refunded_cents):"—",
          <Tag tone={shownState==="paid"?"green":shownState==="open"?"yellow":["void","expired"].includes(shownState)?"gray":"blue"}>{
            b.refunded_cents>0?(b.refunded_cents>=b.amount_cents?"Refunded":"Partially refunded"):
              /^(demo_|cs_test_)/.test(b.paid_ref??"")?"Test payment confirmed":
                shownState==="processing"&&["succeeded","partially_refunded","refunded"].includes(b.latest_attempt_state)?"Payment received · under review":label(shownState)
          }</Tag>,
          stamp(b.posted_at),
          b.receipt_available?<Action run={async()=>{
            const {receipt_url}=await request("/charges/"+b.charge_item_id+"/receipt");
            location.assign(receipt_url);
          }}>{b.paid_ref?.startsWith("cs_test_")?"View test receipt":"View Stripe receipt"}</Action>:
            b.paid_ref?.startsWith("demo_")?<small>Test payment</small>:
            b.paid_ref?<details className="small"><summary className="code" title={b.paid_ref}>…{String(b.paid_ref).slice(-8)}</summary><span className="code" style={{overflowWrap:"anywhere"}}>{b.paid_ref}</span></details>:b.latest_attempt_state?label(b.latest_attempt_state):"—",
          b.scope_revision_id&&b.order_numbers?.[0]?<Link href={inspectionScopePath(b.order_numbers[0],b.scope_revision_id)}>Review scope charge</Link>:
          inspectionPaymentHref&&inspectionPaymentLabel?<Link href={inspectionPaymentHref}>{inspectionPaymentLabel}</Link>:
          quoteExpired
            ?(b.unresolved_payment?<span>Payment confirmation pending</span>:
              b.purpose==="dispatch"&&b.batch_id?<CodeButton code="Review dispatch batch" onClick={()=>setBatchTarget(b.batch_id)}/>:
              b.purpose==="storage"&&b.storage_item_code?<Link href={"/items?item="+encodeURIComponent(b.storage_item_code)}>Review stored item</Link>:<span>Quote expired</span>)
            :shownState==="open"?<Action run={()=>goCheckout(b.charge_item_id,b.quote_revision)}>Pay</Action>:null
        ];
      })} empty="No charges yet."/>
      {(chargePage>1||data.has_more_charges)&&<nav className="actions" aria-label="Charge pages">
        {chargePage>1&&<Link className="button" href={billingPageHref("charge",chargePage-1)}>Previous page</Link>}
        <span>Page {chargePage}</span>
        {data.has_more_charges&&<Link className="button" href={billingPageHref("charge",chargePage+1)}>Next page</Link>}
      </nav>}
    </Panel></div><div id="billing-refunds" className="billing-charge-anchor"><Panel title="Refunds" subtitle="Platform fee refunds issued by QCWarehouse. Seller refunds are handled on your seller's platform and are not shown here.">
      <Table headers={["Requested","Purpose","Order","Amount","Status"]} rows={(data.refunds??[]).map((r:Row)=>[
        stamp(r.created_at),
        label(r.purpose),
        r.order_numbers?.length?r.order_numbers.map((number:string)=><Link key={number} className="code-btn" href={"/orders/"+number}>{number}</Link>):"—",
        usd(r.amount_cents),
        <Tag tone={r.state==="succeeded"?"green":r.state==="failed"?"red":"yellow"}>{label(r.state)}</Tag>,
      ])} empty="No refunds have been issued."/>
      {(refundPage>1||data.has_more_refunds)&&<nav className="actions" aria-label="Refund pages">
        {refundPage>1&&<Link className="button" href={billingPageHref("refund",refundPage-1)}>Previous page</Link>}
        <span>Page {refundPage}</span>
        {data.has_more_refunds&&<Link className="button" href={billingPageHref("refund",refundPage+1)}>Next page</Link>}
      </nav>}
    </Panel></div></>}
    {isHelp&&<><div className="page-head"><p className="eyebrow">MY WORKSPACE · ACCOUNT</p><h1>Support</h1><p className="muted">Open a case about an order, parcel, report or payment, and follow the warehouse team&apos;s replies.</p></div>
      <Panel title="Open a support case">
        <Form key={caseFormVersion+":"+(search.get("parcel")??"")} label="Submit case" idempotent run={async (f,key)=>{
          setCreatedCase(undefined);
          const orderId=text(f,"order_id"),category=text(f,"category"),parcelId=text(f,"parcel_id");
          if(category&&!orderId) throw new Error("Select the related order for this issue type.");
          const photo=f.get("photo");
          try {
            const result=await request("/me/cases","POST",photo instanceof File&&photo.size?f:{
              subject:text(f,"subject"),message:text(f,"message"),...(orderId?{order_id:orderId}:{}),
              ...(category?{category}:{}),...(parcelId?{parcel_id:parcelId}:{}),
            },key);
            setCreatedCase(result);
            setCaseFormVersion(version=>version+1);
          } finally {caseList.reload();}
        }}>
          <Select name="category" label="Issue type" required={false} choices={[
            {id:"receipt_mismatch",label:"Received items do not match"},
            {id:"measurement_dispute",label:"Question about inspection results"},
            {id:"return_info_incomplete",label:"Return or forwarding information"},
            {id:"damage_or_loss",label:"Item damage or loss"},
            {id:"payment_refund",label:"Payment or refund"},
          ]}/>
          <Select name="order_id" label="Related order (optional)" required={false} choices={orders.map(o=>({id:o.id,label:`${o.public_no} · ${label(o.state)}`}))}/>
          <Select name="parcel_id" label="Related inbound parcel (optional)" required={false} value={search.get("parcel")??undefined}
            choices={data.advices.map((parcel:Row)=>({id:parcel.id,label:parcel.tracking_norm}))}/>
          <Field name="subject" label="Subject"/><label>Message<textarea name="message" required maxLength={2000}/></label>
          <Field name="photo" label="Evidence photo (optional)" type="file" required={false}/>
        </Form>
        {createdCase&&<p role="status">Case <Link href={"/support/cases/"+createdCase.id}>{createdCase.public_no}</Link> opened.</p>}
      </Panel>
      <Panel title="My support cases">
        <form action="/support" method="get" className="form inline-form" key={caseParams.get("q")+":"+caseParams.get("state")}>
          {search.get("parcel")&&<input type="hidden" name="parcel" value={search.get("parcel")!}/>}
          <Field name="q" label="Case or order number" required={false} value={caseParams.get("q")??""}/>
          <label>Case status<select name="state" defaultValue={caseParams.get("state")??""}>
            <option value="">All statuses</option><option value="open">Open</option>
            <option value="waiting_customer">Awaiting your reply</option><option value="waiting_internal">With support</option>
            <option value="resolved">Resolved</option><option value="closed">Closed</option>
          </select></label>
          <button type="submit" className="button">Find cases</button>
        </form>
        {caseList.error&&<><ErrorBlock error={caseList.error}/><button type="button" onClick={caseList.reload}>Retry</button></>}
        {!caseList.error&&!caseList.data&&<p role="status">Loading support cases…</p>}
        {!caseList.error&&caseList.data&&<Table headers={["Case","Subject","Issue type","Order","Status","Last update"]} rows={caseList.data.rows.map((t:Row)=>[
          <Link className="code" id={"case-"+t.id} href={"/support/cases/"+t.id}>{t.public_no}</Link>,
          t.subject,
          t.category?label(t.category):"General",
          t.order_no?<Link className="code-btn" href={"/orders/"+t.order_no}>{t.order_no}</Link>:"—",
          <Tag tone={t.state==="waiting_customer"?"yellow":t.state==="closed"||t.state==="resolved"?"gray":"blue"}>
            {t.state==="waiting_customer"?"Awaiting your reply":t.state==="waiting_internal"?"With support":label(t.state)}
          </Tag>,
          stamp(t.updated_at??t.created_at),
        ])} empty={caseParams.get("q")||caseParams.get("state")?"No support cases match these filters.":"No support cases yet."}/>}
        {caseList.data&&(caseList.data.page>1||caseList.data.has_more)&&<nav className="actions" aria-label="Support case pages">
          {caseList.data.page>1&&<Link className="button sm" href={supportPage(caseList.data.page-1)}>Previous</Link>}
          <span>Page {caseList.data.page}</span>
          {caseList.data.has_more&&<Link className="button sm" href={supportPage(caseList.data.page+1)}>Next</Link>}
        </nav>}
      </Panel></>}
    <CustomerTrackingDrawer target={trackTarget} onClose={()=>setTrackTarget(null)}/>
    <CustomerItemDrawer item={itemTarget} onClose={()=>{
      setItemTarget(null);
      if(requestedItem&&isItems) {
        setLegacyItem(null);
        router.replace(inventoryHref(itemPage),{scroll:false});
      }
    }} onOpenTracking={setTrackTarget} onOpenBatch={setBatchTarget}/>
    <CustomerBatchDrawer batchId={batchTarget} onClose={()=>setBatchTarget(null)} onOpenTracking={setTrackTarget} onSaved={reload}/>
  </>;
}

function ProfilePreferences() {
  const {data,error,reload}=useLoad("/me");
  const router=useRouter();
  const [saved,setSaved]=useState(false);
  return <Panel title="Display preferences">
    {error&&<><ErrorBlock error={error}/><button className="button sm" onClick={reload}>Retry</button></>}
    {!data&&!error&&<p role="status">Loading profile…</p>}
    {data?.profile&&<Form key={JSON.stringify(data.profile)} label="Save display preferences" run={async fields=>{
      setSaved(false);
      await request("/me","PATCH",{display_name:text(fields,"display_name")||null,timezone:text(fields,"timezone")||null});
      reload();
      router.refresh();
      setSaved(true);
    }}>
      <label>Display name<input name="display_name" defaultValue={data.profile.display_name??""} maxLength={120}/></label>
      <label>Display time zone<input name="timezone" list="workspace-timezones" defaultValue={data.profile.timezone??""}
        placeholder="Browser time zone" maxLength={80} aria-describedby="display-timezone-hint"/></label>
      <datalist id="workspace-timezones"><option value="UTC"/>{Intl.supportedValuesOf("timeZone").map(zone=><option key={zone} value={zone}/>)}</datalist>
      <small id="display-timezone-hint">Choose a time zone for workspace dates. Leave blank to use your browser’s setting.</small>
    </Form>}
    {saved&&<p className="notice ok" role="status">Display preferences saved.</p>}
  </Panel>;
}

function AccountSecurity({receivingCode}:{receivingCode:string}) {
  const stamp=useWorkspaceStamp();
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
  if(identities.error||sessions.error) return <><h1>Sign-in methods &amp; security</h1>
    <ErrorBlock error={identities.error||sessions.error}/><button type="button" onClick={refreshAll}>Retry security</button></>;
  if(!info||!sessions.data) return <><h1>Sign-in methods &amp; security</h1><p role="status">Loading account security…</p></>;
  return <>
    <div className="page-head row">
      <div><Link href="/account">← Account overview</Link><p className="eyebrow">CLIENT WORKSPACE / SECURITY</p>
        <h1>Sign-in methods &amp; security</h1>
        <p className="muted">Manage linked sign-in methods, primary contact email, active device sessions, and account status. Your permanent receiving code <span className="code">{receivingCode}</span> never changes.</p>
      </div>
      {info?.reauthenticated?<Tag>Reauthenticated</Tag>:<Tag>Standard session</Tag>}
    </div>
    {info?.status==="restricted"&&<div className="notice" role="alert"><strong>Account restricted:</strong> New orders, payments, and outbound instructions are temporarily paused while your existing orders and support cases remain accessible.</div>}
    <ProfilePreferences/>
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

function FulfillmentQuote({quote,onUpdate,onOpenBatch,focused=false}:{quote:Row;onUpdate?:()=>void;onOpenBatch?:(batchId:string)=>void;focused?:boolean}) {
  const stamp=useWorkspaceStamp();
  const [expiredId,setExpiredId]=useState<string>();
  useEffect(()=>{
    if(quote.state!==undefined&&quote.state!=="open"&&quote.state!=="accepted") return;
    const remaining=Date.parse(quote.expires_at)-Date.now();
    if(remaining<=0||remaining>2_147_483_647) return;
    const timer=setTimeout(()=>setExpiredId(quote.id),remaining);
    return ()=>clearTimeout(timer);
  },[quote.expires_at,quote.id,quote.state]);
  const initialState=quote.state??"open";
  const state=["open","accepted"].includes(initialState)&&(expiredId===quote.id||Date.parse(quote.expires_at)<=Date.now())?"expired":initialState;
  const shipping=quote.purpose==="dispatch";
  const {snapshot}=quote;
  const purpose=shipping?({return_to_seller:"Return to seller",to_forwarder:"Send to freight forwarder",to_domestic_address:"Domestic delivery"} as Record<string,string>)[quote.action]:"Extend storage";
  return <article id={"quote-"+quote.id} className="card fulfillment-quote" tabIndex={focused?-1:undefined}>
    <div className="row"><div><h3>{purpose}</h3><small>Quote {quote.revision} · expires {stamp(quote.expires_at)}</small></div>
      <div className="actions">
        {shipping&&quote.batch_id&&onOpenBatch&&<CodeButton code={`Batch #${String(quote.batch_id).slice(0,8)} · Inspect / Amend`} onClick={()=>onOpenBatch(quote.batch_id)}/>}
        <strong>{usd(quote.amount_cents)}</strong>
      </div>
    </div>
    {["open","accepted"].includes(state)&&<QuoteCountdown expiresAt={quote.expires_at}/>}
    {shipping?<>
      <p><strong>Destination</strong> · {snapshot.destination.recipient} · {snapshot.destination.address}
        {snapshot.destination.member_code&&<> · Member {snapshot.destination.member_code}</>}</p>
      <Table headers={["Parcel","Warehouse item codes","Weight","Shipping"]} rows={snapshot.parcels.map((parcel:Row,i:number)=>[
        i+1,<span className="code">{parcel.item_ids.map((id:string)=>quote.item_codes?.[id]??id).join(", ")}</span>,
        parcel.weight_g+" g",usd(parcel.amount_cents),
      ])}/>
      <p>Handling · {usd(snapshot.handling_cents)}</p>
    </>:<p>{snapshot.days} additional days · <span className="code">{Object.values(quote.item_codes).join(", ")}</span></p>}
    {state==="open"&&<Action primary run={async()=>{
      const charge=await request("/quotes/"+quote.id+"/accept","POST",{revision:quote.revision});
      try {await goCheckout(charge.charge_item_id,quote.revision);} finally {onUpdate?.();}
    }}>Accept and pay</Action>}
    {state==="accepted"&&quote.charge_id&&<Action primary run={()=>goCheckout(quote.charge_id,quote.revision)}>Resume payment</Action>}
    {state==="processing"&&<p role="status">Awaiting payment confirmation.</p>}
    {state==="paid"&&<Tag>Payment confirmed</Tag>}
    {state==="expired"&&<p className="notice">This quote has expired. Check <Link href="/account/billing">Billing</Link> for a new quote from the warehouse.</p>}
    {state==="inactive"&&<Empty>This quote is closed. Check <Link href="/account/billing">Billing</Link> for current quotes.</Empty>}
  </article>;
}

const handlingStates=["report_ready","action_pending","cancelled","closed"];
const handlingHoldLabel:Record<string,string>={stocktake:"Warehouse inventory check in progress",incident:"Warehouse incident under review"};
function canChooseHandling(item:Row) {
  return !item.handling_hold&&item.allowed_actions.includes("request_disposition")&&(!item.order_state||handlingStates.includes(item.order_state))&&
    !item.active_disposition&&!item.reference_sample?.in_use&&item.reference_sample?.state!=="pending_safe_storage";
}

const actionTitles:Record<string,string>={
  manual_quote_ready:"Review your inspection quote",manual_quote_expired:"Request an updated inspection quote",
  report_ready:"Choose how to handle inspected items",action_pending:"Choose how to handle inspected items",
  draft:"Continue inspection draft",awaiting_payment:"Review inspection payment",awaiting_samples:"Register seller tracking",
  inspection_quote_expired:"Review expired inspection quote",inspection_payment_reconciliation:"Check previous inspection payment",
  return_to_seller:"Review seller return quote",to_forwarder:"Review forwarding quote",to_domestic_address:"Review domestic shipping quote",
  retain:"Review storage extension",needs_carrier:"Confirm parcel carrier",needs_verification:"Verify parcel tracking",waiting_customer:"Review support case",
  incident_decision:"Review warehouse incident proposal",
  dispatch:"Review shipping payment",storage:"Review storage payment",
  bounced:"We couldn't deliver email to this address",complained:"We couldn't deliver email to this address",
  reference_expired:"Update expired reference sample",reference_conflict:"Resolve reference sample in use before shipping",
  storage_expiring:"Storage expiring soon — choose handling or extend",storage_expired:"Storage expired — choose handling or extend",
  scope_review:"Review inspection scope",scope_payment_due:"Review supplemental inspection payment",scope_payment_expired:"Renew supplemental inspection quote",
};
function customerActionHref(row:Row) {
  const base="/orders/"+row.reference;
  if(row.kind==="inspection_quote") return base+(row.state==="manual_quote_expired"?"#manual-quote-request":"#inspection-quote");
  if(row.kind==="order") {
    if(row.state==="draft") return "/orders/new?draft="+encodeURIComponent(row.reference);
    if(["awaiting_payment","inspection_quote_expired","inspection_payment_reconciliation"].includes(row.state)) return base+"/payment";
    if(row.state==="awaiting_samples") return base+"/parcels";
    return base+"/dispositions";
  }
  if(row.kind==="parcel") return "/parcels/"+row.id;
  if(row.kind==="charge") return billingChargePath(row.id);
  if(row.kind==="quote") return billingQuotePath(row.id);
  if(row.kind==="scope") return inspectionScopePath(row.reference,row.id);
  if(row.kind==="reference"||row.kind==="storage") return "/items?item="+encodeURIComponent(row.reference);
  if(row.kind==="email") return "/account/security";
  return "/support/cases/"+row.id+(row.state==="incident_decision"?"#incident-decision":"");
}

export function CustomerActions() {
  const stamp=useWorkspaceStamp();
  const page=Number(useSearchParams().get("page")??1);
  const {data,error,reload}=useLoad("/actions?page="+page);
  return <>
    <div className="page-head row"><div><p className="eyebrow">CLIENT WORKSPACE / ACTIONS</p><h1>Action required</h1>
      <p className="muted">Continue work that needs your input. Quotes with deadlines are shown first.</p></div>
      <button type="button" onClick={reload}>Refresh actions</button></div>
    {error&&<ErrorBlock error={error}/>}
    {!data&&!error&&<p role="status">Loading actions…</p>}
    {data&&!error&&<Panel title="Your next actions"><Table headers={["Action","Reference","Due",""]} rows={data.rows.map((row:Row)=>{
      const href=customerActionHref(row);
      return [actionTitles[row.state]??"Review action",row.reference?<span className="code">{row.reference}</span>:"—",stamp(row.due_at),<Link href={href}>Open</Link>];
    })} empty={page>1?"No more actions on this page.":"You’re all caught up. New actions will appear here when an order, parcel, quote or case needs your input."}/>
      {(page>1||data.has_more)&&<nav className="actions" aria-label="Action pages">
        {page>1&&<Link className="button" href={page===2?"/actions":"/actions?page="+(page-1)}>Previous page</Link>}
        <span>Page {page}</span>
        {data.has_more&&<Link className="button" href={"/actions?page="+(page+1)}>Next page</Link>}
      </nav>}
    </Panel>}
  </>;
}

function InboundParcelForm({address,carriers,orderId,orders=[],preferredOrder,pendingWaybills=[],onSave}:{
  address:Row|null;carriers:Row[];orderId?:string;orders?:Row[];preferredOrder?:string|null;
  pendingWaybills?:{tracking_no:string;item_count:number}[];onSave:()=>void;
}) {
  const [saved,setSaved]=useState<string>();
  const [trackingInput,setTrackingInput]=useState("");
  if(!address)return <Empty>The warehouse address is awaiting configuration.</Empty>;
  return <>
    <Form key={saved} label="Add inbound parcel" run={async f=>{
      const carrier=text(f,"carrier"),order=orderId??text(f,"order");
      const tracking=text(f,"tracking");
      await request("/me/parcels","POST",{address_id:address.id,tracking_no:tracking,
        ...(carrier?{carrier_code:carrier}:{}),order_ids:order?[order]:[]});
      setSaved(tracking);setTrackingInput("");onSave();
    }}>
      {pendingWaybills.length>0&&<label>Use a tracking number declared in this order
        <select value={pendingWaybills.some(entry=>entry.tracking_no===trackingInput)?trackingInput:""} onChange={e=>setTrackingInput(e.target.value)}>
          <option value="">Enter tracking manually</option>
          {pendingWaybills.map(entry=><option key={entry.tracking_no} value={entry.tracking_no}>
            {entry.tracking_no} · {entry.item_count} {entry.item_count===1?"item":"items"}
          </option>)}
        </select>
      </label>}
      <label>Seller’s tracking number<input name="tracking" required value={trackingInput} onChange={e=>setTrackingInput(e.target.value)}/></label>
      <Select name="carrier" label="Carrier (if known)" required={false} choices={carriers.map(c=>({id:c.code,label:c.labels.en}))}/>
      {!orderId&&<Select key={(preferredOrder??"")+":"+orders.some(o=>o.id===preferredOrder)} name="order" label="Associate an order (optional)" required={false}
        value={orders.some(o=>o.id===preferredOrder)?preferredOrder??undefined:undefined}
        choices={orders.map(o=>({id:o.id,label:o.public_no}))}/>}
      <small className="muted">Linked orders show suppliers and expected items when the tracking number matches the item declarations.</small>
    </Form>
    {saved&&<p className="notice" role="status">Registered seller tracking <strong className="code">{saved}</strong>.</p>}
  </>;
}

const instructionRequestTimeoutMs=20_000;
function ItemInstructionForm({items,orderId,storage=false,preselected=false,recentDestinations=[],onSave}:{
  items:Row[];orderId?:string;storage?:boolean;preselected?:boolean;recentDestinations?:Row[];onSave:(recorded:Row[])=>void;
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
  type PlannedInstruction={path:string;body:Row;key:string;item:Row};
  const instructionKeys=useRef(new Map<string,{fingerprint:string;key:string}>());
  const [pendingPlan,setPendingPlan]=useState<PlannedInstruction[]|null>(null);
  const [recoveryError,setRecoveryError]=useState("");
  const [errorVersion,setErrorVersion]=useState(0);
  async function submitInstructions(plan:PlannedInstruction[],recovering=false) {
    const recorded:Row[]=[];
    for(const [index,entry] of plan.entries()) {
      try {await request(entry.path,"POST",entry.body,entry.key,AbortSignal.timeout(instructionRequestTimeoutMs));recorded.push(entry.item);}
      catch(error) {
        const failure=error instanceof DOMException&&["AbortError","TimeoutError"].includes(error.name)
          ?new RequestError("The request timed out. Check the previous instructions before starting a new request.","NETWORK_ERROR"):error;
        const uncertain=failure instanceof RequestError&&(failure.code==="NETWORK_ERROR"||failure.status===undefined||failure.status>=500);
        if(uncertain)setPendingPlan(plan.slice(index));
        else if(recovering){setPendingPlan(null);setRecoveryError(failure instanceof Error?failure.message:"Instruction could not be confirmed.");setErrorVersion(value=>value+1);}
        if(recorded.length){setSavedNotice("Instructions recorded for "+recorded.map(item=>item.code).join(", ")+".");onSave(recorded);}
        throw failure;
      }
    }
    setPendingPlan(null);setRecoveryError("");
    setSavedNotice(`Recorded instruction for ${recorded.length} ${recorded.length===1?"item":"items"} (${recorded.map(item=>item.code).join(", ")}).`);
    instructionKeys.current.clear();setFormKey(value=>value+1);onSave(recorded);
  }
  useEffect(()=>{
    setSelectedIds(prev=>{
      const valid=prev.filter(id=>items.some(row=>row.item_id===id));
      return valid;
    });
  },[items.map(i=>i.item_id).join(",")]);
  const currentAction=storage?"retain":action;
  const needsDestination=!["retain","reserve_reference"].includes(currentAction);
  const termsId=terms.data?.terms.find((t:Row)=>t.kind==="terms")?.id;
  if(!items.length&&!pendingPlan)return <>
    {recoveryError&&<ErrorBlock error={recoveryError}/>}{savedNotice&&<p className="notice" role="status">{savedNotice}</p>}
    <Empty>No items are available for a new instruction.</Empty>
  </>;
  if(terms.error)return <><ErrorBlock error={terms.error}/><button type="button" onClick={terms.reload}>Retry service terms</button></>;
  if(!terms.data)return <p role="status">Loading service terms…</p>;
  if(!termsId)return <Empty>Current service terms are unavailable. Handling instructions cannot be submitted yet.</Empty>;
  const chosen=preselected?items:items.filter(row=>selectedIds.includes(row.item_id));
  return <>
    <Form key={formKey} idempotent disabled={Boolean(pendingPlan)} clearErrorKey={errorVersion} label={(storage?"Request storage extension":"Save handling instruction")+(chosen.length>1?` (${chosen.length} items)`:"")} run={async f=>{
      setSavedNotice(undefined);setRecoveryError("");
      if(!chosen.length||!checked(f,"agree"))throw new Error("Select at least one item and confirm the instruction.");
      const destination=needsDestination?{
        recipient:recipient.trim()||text(f,"recipient"),
        phone:phone.trim()||text(f,"phone"),
        address:address.trim()||text(f,"address"),
        ...(currentAction==="to_forwarder"?{member_code:memberCode.trim()||text(f,"member_code")}:{}),
      }:undefined;
      const deadline=text(f,"deadline");
      const sellerName=text(f,"seller_name"),sellerId=text(f,"seller_id");
      const retainDays=currentAction==="retain"?Number(text(f,"days")):undefined;
      if(retainDays!==undefined&&(!Number.isInteger(retainDays)||retainDays<1||retainDays>365))
        throw new Error("Choose between 1 and 365 additional storage days.");
      const plan=chosen.map(item=>{
        const path=orderId?"/orders/"+orderId+"/dispositions":"/me/items/"+item.item_id+"/dispositions";
        const body={...(orderId?{item_id:item.item_id}:{}),action:currentAction,terms_version_id:termsId,...(destination?{destination}:{}),
          ...(retainDays!==undefined?{days:retainDays}:{}),
          ...(currentAction==="return_to_seller"?{return_info:{requested_from_seller:true,customer_pays_shipping:true,
            ...(sellerName?{seller_name:sellerName}:{}),...(sellerId?{seller_id:sellerId}:{}),
            ...(deadline?{deadline:new Date(deadline).toISOString()}:{})}}:{})};
        const identity=path+":"+item.item_id,fingerprint=JSON.stringify(body);
        if(instructionKeys.current.get(identity)?.fingerprint!==fingerprint)instructionKeys.current.set(identity,{fingerprint,key:crypto.randomUUID()});
        return {path,body,key:instructionKeys.current.get(identity)!.key,item};
      });
      await submitInstructions(plan);
    }}>
      {preselected?<p><strong>{items.length} selected</strong> · <span className="code">{items.map(item=>item.code).join(", ")}</span></p>:items.length===1?(
        <label className="check"><input type="checkbox" checked={selectedIds.includes(items[0].item_id)}
          onChange={event=>setSelectedIds(event.target.checked?[items[0].item_id]:[])}/><span>Select <strong className="code">{items[0].code}</strong></span></label>
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
      {!storage&&<label>Requested action<select name="action" value={action} onChange={e=>setAction(e.target.value)}>
        <option value="return_to_seller">Return to seller</option><option value="to_forwarder">Send to freight forwarder</option>
        <option value="to_domestic_address">Send to a domestic address</option><option value="retain">Extend storage</option>
        <option value="reserve_reference">Reserve as reference sample (90 days)</option></select></label>}
      {currentAction==="retain"&&<Field name="days" label="Additional storage days" type="number" min={1} max={365} step={1} value={30}/>}
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
      {currentAction==="return_to_seller"&&<>
        <Field name="deadline" label="Seller’s return deadline (your local time)" type="datetime-local" required={false}/>
        <details className="card">
          <summary>Seller details for a combined return</summary>
          <p className="small muted">If you plan to combine returns from different orders and inbound parcels, enter the same seller’s shop name or shop ID for each return. The warehouse checks the items’ declared supplier before they can be combined.</p>
          <label>Seller’s shop name (optional)<input name="seller_name" maxLength={120}/></label>
          <label>Seller’s shop ID (optional)<input name="seller_id" maxLength={120}/></label>
        </details>
      </>}
      <label className="check"><input name="agree" required type="checkbox"/>{currentAction==="return_to_seller"?
        "I have arranged the return with my seller and will pay the return shipping fee.":"I authorize this request subject to the current terms and quote."}</label>
    </Form>
    {pendingPlan&&<div className="notice">
      <p role="status">Previous instructions for <span className="code">{pendingPlan.map(entry=>entry.item.code).join(", ")}</span> may already be saved. Check these requests before starting new instructions.</p>
      <Action primary run={()=>submitInstructions(pendingPlan,true)}>Check previous instructions</Action>
    </div>}
    {recoveryError&&<ErrorBlock error={recoveryError}/>}
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
  const stamp=useWorkspaceStamp();
  const desk=useLoad("/me/desk");
  const [selected,setSelected]=useState<string[]>([]);
  const items:Row[]=order.items.filter((item:Row)=>item.item_id);
  const allowed=handlingStates.includes(order.state);
  const eligible=allowed?items.filter(item=>!item.instruction&&!item.handling_hold&&item.identity_state!=="quarantined"&&["stored","received"].includes(item.custody_state)):[];
  const awaiting=items.filter(item=>!item.handling_hold&&item.instruction?.awaiting_batch);
  const selection=selected.filter(id=>awaiting.some(item=>item.instruction.id===id));
  return <>
    {desk.error&&<><ErrorBlock error={desk.error}/><button type="button" onClick={desk.reload}>Retry saved destinations</button></>}
    {!desk.data&&!desk.error&&<p role="status">Loading saved destinations…</p>}
    <Panel title={storage?"Storage by item":"Instructions by item"}>
      <Table headers={["Item","Warehouse status","Storage through","Paid through","Active instruction"]} rows={items.map(item=>[
        onOpenItem?<CodeButton code={item.code} onClick={()=>onOpenItem({...item,order_no:order.public_no})}/>:<span className="code">{item.code}</span>,
        label(item.custody_state),stamp(item.storage_until),stamp(item.paid_storage_until),
        <div className="actions">{item.handling_hold&&<Tag tone="yellow">{handlingHoldLabel[item.handling_hold]}</Tag>}
        {item.instruction?<><Tag>{label(item.instruction.action)}</Tag>{!storage&&!item.handling_hold&&item.instruction.awaiting_batch&&
          <label className="small"><input type="checkbox" checked={selection.includes(item.instruction.id)} onChange={e=>
            setSelected(current=>e.target.checked?[...current,item.instruction.id]:current.filter(id=>id!==item.instruction.id))}/> Select for shipping</label>}
          {item.instruction.state==="requested"&&<Action key={item.instruction.id} idempotent onSettled={onSave} run={async key=>{
            await request("/me/dispositions/"+item.instruction.id+"/cancel","POST",{},key);
          }}>Cancel</Action>}</>:!item.handling_hold?"—":null}</div>,
      ])} empty="No warehouse items are linked to this inspection."/>
      {!storage&&selection.length>0&&<Action primary run={async()=>{
        let batch:Row|undefined;
        try {
          const created=await request("/dispatch-batches","POST",{disposition_ids:selection});
          batch=created;
          setSelected(current=>current.filter(id=>!selection.includes(id)));
          await request("/dispatch-batches/"+created.batch_id+"/confirm","POST",{revision:created.revision});
        } catch(error) {
          if(batch) onOpenBatch?.(batch.batch_id);
          throw error;
        } finally {onSave();desk.reload();}
      }}>Confirm selected items for quoting ({selection.length})</Action>}
      <p><Link href={storage?"/orders/"+order.public_no+"/dispositions":"/account/billing"}>{storage?"Review other handling options":"Open shipping and storage quotes"}</Link></p>
      {!storage&&<p className="muted"><Link href="/items">Review shipping batches and warehouse items</Link> to resume an unconfirmed batch, combine eligible items across orders, or amend unshipped details.</p>}
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

export function OrderFulfillment({order,id,kind}:{order?:string;id:string;kind:"quotes"|"shipments"}) {
  const stamp=useWorkspaceStamp();
  const lookup=useLoad(order?"/orders/by-number/"+order:null);
  const record=useLoad(order?(lookup.data?"/orders/"+lookup.data.id+"/"+kind+"/"+id:null):"/"+kind+"/"+id);
  const data=record.data;
  const error=lookup.error||record.error;
  const destination=data?.destination_snapshot;
  return <>
    <div className="page-head"><Link href={order?"/orders/"+order+"/dispositions":"/parcels?tab=outgoing"}>{order?"← Order item instructions":"← Outgoing parcels"}</Link>
      <p className="eyebrow report-eyebrow">CLIENT WORKSPACE / FULFILLMENT</p>
      <h1>{kind==="quotes"?"Fulfillment quote":"Shipment details"}</h1>{order&&<p className="code">{order}</p>}</div>
    {error&&<><ErrorBlock error={error}/><button type="button" onClick={()=>{lookup.reload();record.reload();}}>Retry details</button></>}
    {!data&&!error&&<p role="status">Loading the order record…</p>}
    {data&&kind==="quotes"&&<FulfillmentQuote quote={data} onUpdate={record.reload}/>}
    {data&&kind==="shipments"&&<>
      <Panel title="Warehouse handover">
        <dl className="location-facts">
          <div><dt>Handling</dt><dd>{label(data.action)}</dd></div>
          <div><dt>Tracking number</dt><dd className="code">{data.tracking_norm}</dd></div>
          <div><dt>Handed to carrier</dt><dd>{stamp(data.shipped_at)}</dd></div>
          <div><dt>Recorded weight</dt><dd>{data.weight_g} g</dd></div>
          {destination&&<div><dt>Destination</dt><dd>{destination.recipient} · {destination.address}{destination.member_code?" · "+destination.member_code:""}</dd></div>}
        </dl>
        <Table headers={["Item code","Returned to warehouse"]} rows={(data.items??[]).map((item:Row)=>[
          <Link className="code" href={"/items?item="+encodeURIComponent(item.code)}>{item.code}</Link>,stamp(item.returned_at),
        ])}/>
      </Panel>
      <TrackView kind="shipments" id={id} embedded/>
    </>}
  </>;
}
