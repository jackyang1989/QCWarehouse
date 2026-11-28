"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { localizePublicPath } from "../packages/core/locale-contract";
import { legalPages, servicePages } from "../packages/core/portal-routes";
import { useLocale } from "./i18n-client";
import { Empty, ErrorBlock, Panel, Tabs, usd, useLoad } from "./ui";

export type CatalogCheck = {
  key: string;
  label: string;
  zh?: string;
  type: "boolean" | "number" | "text";
  unit?: string;
  method: string;
  required?: boolean;
  evidence?: boolean;
};

export type CatalogOffer = {
  offer_id: string;
  sku_code: string;
  service: "inspection" | "compare" | "reference_match";
  title: { en: string; "zh-CN"?: string };
  category_id: string;
  category: { en: string; "zh-CN"?: string };
  template_version_id: string;
  content: {
    subcategory?: string;
    checks: CatalogCheck[];
    parts?: Array<string | { code: string; label: string }>;
  };
  rules: {
    minimum: number;
    maximum: number;
    unit_cents?: number;
    package_cents?: number;
    business_days: number;
    demo?: boolean;
  };
};

const SUBCATEGORY_LABELS: Record<string, { en: string; zh: string }> = {
  general: { en: "General Apparel Template", zh: "通用服装检验模板" },
  tops: { en: "Tops, T-Shirts & Knitwear Template", zh: "上衣 / T 恤 / 针织模板" },
  bottoms: { en: "Bottoms, Pants & Leggings Template", zh: "下装 / 裤装 / 瑜伽裤模板" },
  sports_bra: { en: "Sports Bra & Activewear Template", zh: "运动内衣 / 贴身运动服模板" },
};

function subcategoryLabel(sub: string | undefined, isZh: boolean): string {
  const entry = SUBCATEGORY_LABELS[sub ?? "general"];
  if (!entry) return sub ?? (isZh ? SUBCATEGORY_LABELS.general.zh : SUBCATEGORY_LABELS.general.en);
  return isZh ? entry.zh : entry.en;
}

function summarizeRate(pool: CatalogOffer[], suffix: string, fallback = "Quote on request"): string {
  const vals = pool
    .map((o) => Number(o.rules.unit_cents ?? o.rules.package_cents ?? 0))
    .filter((n) => n > 0);
  if (!vals.length) return fallback;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return lo === hi ? `${usd(lo)} ${suffix}` : `${usd(lo)}–${usd(hi)} ${suffix}`;
}

function packageSummary(offer: CatalogOffer, isZh: boolean): { coreScope: string; capacityBadge: string } {
  const sub = offer.content?.subcategory ?? "general";
  const checkCount = offer.content?.checks?.length ?? 0;
  if (offer.service === "compare") {
    const n = offer.rules.minimum;
    return isZh
      ? {
          coreScope: `同框组图、${checkCount} 项尺寸差值对照表与工艺做工横向对比`,
          capacityBadge: `${n} 件对比组 · ${offer.rules.business_days} 个工作日`,
        }
      : {
          coreScope: `Synchronized group photo, ${checkCount}-point measurement delta table & workmanship comparison`,
          capacityBadge: `${n}-item comparison set · ${offer.rules.business_days} business days`,
        };
  }
  if (offer.service === "reference_match") {
    return isZh
      ? {
          coreScope: `封存确认样 vs 来料双件对照实拍、${checkCount} 项尺寸偏差与色差/工艺核验`,
          capacityBadge: `1 件来料比对 · ${offer.rules.business_days} 个工作日`,
        }
      : {
          coreScope: `Paired Reference-vs-Incoming photos, ${checkCount}-point dimensional & shade drift check`,
          capacityBadge: `1 incoming match · ${offer.rules.business_days} business days`,
        };
  }
  const scopeBySub: Record<string, { en: string; zh: string }> = {
    general: {
      en: `${checkCount} checkpoints · Flat width, garment weight, label check, zone workmanship & mandatory angle photos`,
      zh: `${checkCount} 项检查点 · 平铺尺宽、整件称重、洗水标核对、分区工艺检查及必拍角度实图`,
    },
    tops: {
      en: `${checkCount} checkpoints · HPS length, 1/2 chest, shoulder, sleeve, collar rib, weight & seam scan`,
      zh: `${checkCount} 项检查点 · HPS 衣长、1/2 胸围、肩宽、袖长、领口罗纹、整件克重及车线核查`,
    },
    bottoms: {
      en: `${checkCount} checkpoints · Waist, hip, front/back rise, inseam, outseam, leg opening & gusset scan`,
      zh: `${checkCount} 项检查点 · 腰围、臀围、前后浪、内长、外长、脚口及裆部三角片核查`,
    },
    sports_bra: {
      en: `${checkCount} checkpoints · Underband, bust width, strap symmetry, lining/pad & stretch seam scan`,
      zh: `${checkCount} 项检查点 · 下胸围织带、胸宽、肩带对称度、胸垫/里布及弹性车缝核查`,
    },
  };
  const entry = scopeBySub[sub];
  return {
    coreScope: entry
      ? (isZh ? entry.zh : entry.en)
      : (isZh ? `${checkCount} 项模板检查点 + 必拍工位实图` : `${checkCount} template checkpoints + mandatory studio photos`),
    capacityBadge: isZh
      ? `线上支持 1–${offer.rules.maximum} 件 · ${offer.rules.business_days} 个工作日`
      : `1–${offer.rules.maximum} items online · ${offer.rules.business_days} business days`,
  };
}

function PackageCard({ offer }: { offer: CatalogOffer }) {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const isUnit = offer.rules.unit_cents != null;
  const cents = offer.rules.unit_cents ?? offer.rules.package_cents ?? 0;
  const checks = offer.content?.checks ?? [];
  const { coreScope, capacityBadge } = packageSummary(offer, isZh);

  return (
    <article className="pub-package-card">
      <div>
        <div className="row flexwrap" style={{ gap: 8, marginBottom: 6 }}>
          <span className="tag blue">{subcategoryLabel(offer.content?.subcategory, isZh)}</span>
          <span className="tag">{capacityBadge}</span>
          <span className="pub-sku-ref" title={isZh ? "目录 SKU 编码" : "Catalog SKU code"}>SKU: {offer.sku_code}</span>
          {offer.rules.demo && (
            <span
              className="tag yellow"
              title={isZh ? "当前启用预发布 / 演示参考价目表" : "Active pre-launch / demo catalog schedule"}
            >
              {isZh ? "预发布 / 演示参考价" : "Pre-launch / Demo Rate"}
            </span>
          )}
        </div>
        <h3>{isZh ? (offer.title["zh-CN"] || offer.title.en) : offer.title.en}</h3>
        <p className="pub-package-scope">{coreScope}</p>
        {checks.length > 0 && (
          <details className="pub-package-checks">
            <summary>{isZh ? `查看全部 ${checks.length} 项模板检查点` : `Inspect ${checks.length} template checkpoints`}</summary>
            <div className="pub-chip-row">
              {checks.map((c) => (
                <span className="pub-chip" key={c.key}>
                  {isZh ? (c.zh || c.label) : c.label}{c.unit ? ` (${c.unit})` : ""}
                </span>
              ))}
            </div>
          </details>
        )}
      </div>
      <div className="pub-package-right">
        <div className="pub-package-price">
          <strong>{usd(cents)}</strong>
          <small>
            {isUnit
              ? (isZh ? "每件实物" : "per physical item")
              : offer.service === "reference_match"
                ? (isZh ? "每次来料比对" : "per incoming item match")
                : (isZh ? "每对比组" : "per comparison set")}
          </small>
        </div>
        <Link className="button primary" href={`/orders/new?offer=${offer.offer_id}`}>
          {isZh ? "选择此套餐 →" : "Select Package →"}
        </Link>
      </div>
    </article>
  );
}

/* ==========================================================================
   ROUTER FOR /catalog, /services/*, /categories, /pricing
   ========================================================================== */
export function PublicCatalogRouter({ path }: { path: string }) {
  if (path === "/categories") return <PublicCategories />;
  if (path === "/pricing") return <PublicPricing />;
  if (path in servicePages) {
    const code = servicePages[path as keyof typeof servicePages];
    return <PublicServiceDetail path={path} serviceCode={code} />;
  }
  return <PublicServicesOverview />;
}

/* ==========================================================================
   PAGE 02 — SERVICES OVERVIEW (/catalog)
   ========================================================================== */
export function PublicServicesOverview() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const { data, error, reload } = useLoad("/catalog");
  const offers: CatalogOffer[] = data?.offers ?? [];
  const inspOffers = offers.filter((o) => o.service === "inspection");
  const compOffers = offers.filter((o) => o.service === "compare");
  const refOffers = offers.filter((o) => o.service === "reference_match");
  const hasDemoRates = offers.some((o) => o.rules?.demo === true);
  const primaryInspOffer = inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0];
  const primaryCompOffer = compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0];
  const primaryRefOffer = refOffers[0];
  const inspHref = primaryInspOffer ? `/orders/new?offer=${primaryInspOffer.offer_id}` : "/orders/new";
  const compHref = primaryCompOffer ? `/orders/new?offer=${primaryCompOffer.offer_id}` : "/orders/new";
  const refHref = primaryRefOffer ? `/orders/new?offer=${primaryRefOffer.offer_id}` : "/orders/new";

  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? "质检服务目录" : "Inspection Services"}</strong>
      </div>

      {/* 1. Services Overview */}
      <section className="pub-page-hero">
        <div className="pub-page-hero-grid">
          <div>
            <p className="pub-eyebrow">
              {isZh ? "01 · 服务总览 · 中国独立收货查验中心" : "01 · SERVICES OVERVIEW · CHINA RECEIVING CENTER"}
            </p>
            <h1>{isZh ? "中国独立实物商品质检与供应商样品横向对比服务" : "Independent Product Inspection & Sample Comparison Services"}</h1>
            <p>
              {isZh
                ? "直接由国内任意卖家寄送样品或中小批量货品至 QC Warehouse。按需选择单件/中小批量逐件查验、2–3 家供应商同组横向对比，或封存标杆确认样比对——审阅完整实测报告后再逐件下达退货、存仓或发往集运指令。"
                : "Ship supplier samples or small-batch inventory from any Chinese seller to QC Warehouse. Choose piece-by-piece inspection, 2–3 supplier sample comparison, or Golden Sample matching—then decide how each physical item should be routed."}
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                {isZh ? "创建质检委托 →" : "Start an Inspection →"}
              </Link>
              <a className="button" href="#packages">
                {isZh ? "查看开放服务套餐" : "Browse Active Packages"}
              </a>
              <Link className="button" href={hrefFor("/report-guide")}>
                {isZh ? "查看样板报告" : "View Sample Report"}
              </Link>
            </div>
          </div>
          <figure className="pub-page-hero-media ratio-wide" style={{ margin: 0 }}>
            <img
              src="/brand/inspection-hero.webp"
              alt="QC Warehouse inspector wearing a navy uniform and white cotton gloves measuring a gray cotton top with a metric tape on an inspection table"
              width={1460}
              height={696}
              loading="eager"
            />
          </figure>
        </div>
      </section>

      <Tabs
        path={hrefFor("/catalog")}
        links={[
          [hrefFor("/catalog"), isZh ? "全部服务总览" : "All Services"],
          [hrefFor("/services/inspection"), isZh ? "实物商品质检" : "Product Inspection"],
          [hrefFor("/services/compare"), isZh ? "样品横向对比" : "Sample Comparison"],
          [hrefFor("/services/reference"), isZh ? "标杆确认样比对" : "Golden Sample Matching"],
        ]}
      />

      {/* Side-by-Side Service Comparison Matrix */}
      <section className="card pub-block" aria-labelledby="service-matrix-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{isZh ? "哪一种服务最匹配您当前的采购阶段？" : "WHICH SERVICE FITS YOUR ORDER?"}</p>
            <h2 id="service-matrix-heading">{isZh ? "三大核心服务能力对照矩阵" : "Compare Our Three Core Services"}</h2>
            <p>{isZh ? "根据选厂打样、中小批量全检还是复购稳品阶段按需选择对应方案。" : "Pick the workflow that matches your stage—shortlisting suppliers, checking small-batch inventory, or verifying a reorder."}</p>
          </div>
        </div>
        <div className="tablewrap pub-compare-desktop">
          <table className="tbl">
            <thead>
              <tr>
                <th>{isZh ? "对比维度" : "Dimension"}</th>
                <th>{isZh ? "实物商品质检" : "Product Inspection"}</th>
                <th>{isZh ? "供应商样品对比" : "Sample Comparison"}</th>
                <th>{isZh ? "标杆确认样比对" : "Golden Sample Matching"}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>{isZh ? "核心适用场景" : "Primary Use Case"}</strong></td>
                <td>{isZh ? "逐件核验 1 件首样或 10–100+ 件出货前小批库存" : "Check 1 prototype or 10–100+ small-batch units individually before export"}</td>
                <td>{isZh ? "同台横向对比 2 或 3 家候选工厂的同等品样品" : "Evaluate 2 or 3 candidate samples from different suppliers side by side"}</td>
                <td>{isZh ? "用已封存标杆确认样核验大货产前样或复购新货" : "Verify a new pre-production or restock piece against your retained Golden Sample"}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "支持件数范围" : "Eligible Quantity"}</strong></td>
                <td>{isZh ? <><strong>线上 1–100 件</strong>（101–300 件转人工核价）</> : <><strong>1–100 items</strong> online (101–300 via staff quote)</>}</td>
                <td>{isZh ? <>每对比组 <strong>2 或 3 件同品类样品</strong></> : <><strong>2 or 3 comparable items</strong> per group</>}</td>
                <td>{isZh ? <>每条明细 <strong>1 件来料</strong> 对照 1 件封存标杆样</> : <><strong>1 incoming item</strong> per retained Golden Sample line</>}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "计费方式" : "Billing Basis"}</strong></td>
                <td>{isZh ? `按件计费 (${summarizeRate(inspOffers, "/ 件", "按选定方案报价")})` : `Per physical item (${summarizeRate(inspOffers, "/ item")})`}</td>
                <td>{isZh ? `按 2–3 件组计费 (${summarizeRate(compOffers, "/ 组", "按选定方案报价")})` : `Per 2- or 3-item group (${summarizeRate(compOffers, "/ group")})`}</td>
                <td>{isZh ? `按来料比对次计费 (${summarizeRate(refOffers, "/ 次", "按选定方案报价")})` : `Per incoming match (${summarizeRate(refOffers, "/ match")})`}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "核心交付证据" : "Core Evidence"}</strong></td>
                <td>{isZh ? "单件唯一条码、0.1 cm 量尺实拍及缺陷坐标框注" : <>Unique item ID, 0.1 cm tape photos &amp; defect coordinate boxes</>}</td>
                <td>{isZh ? "统一尺寸差值对照表 + 同框对比总览实图" : "Unified measurement delta table + single-frame group photo"}</td>
                <td>{isZh ? "封存样 vs 来料双机对比照片与偏差记录" : <>Paired Reference-vs-Incoming photos &amp; variance log</>}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="pub-compare-mobile">
          <article className="pub-compare-mcard">
            <div className="pub-compare-mcard-head">
              <h3>{isZh ? "实物商品质检" : "Product Inspection"}</h3>
              <span className="pub-price-chip">{summarizeRate(inspOffers, isZh ? "/ 件" : "/ item", isZh ? "按需报价" : "Quote on request")}</span>
            </div>
            <dl>
              <div>
                <dt>{isZh ? "核心适用场景" : "Primary Use Case"}</dt>
                <dd>{isZh ? "逐件核验 1 件首样或 10–100+ 件出货前小批库存" : "Check 1 prototype or 10–100+ small-batch units individually before export"}</dd>
              </div>
              <div>
                <dt>{isZh ? "支持件数范围" : "Eligible Quantity"}</dt>
                <dd>{isZh ? <><strong>线上 1–100 件</strong>（101–300 件转人工核价）</> : <><strong>1–100 items</strong> online (101–300 via staff quote)</>}</dd>
              </div>
              <div>
                <dt>{isZh ? "核心交付证据" : "Core Evidence"}</dt>
                <dd>{isZh ? "单件唯一条码、0.1 cm 量尺实拍及缺陷坐标框注" : <>Unique item ID, 0.1 cm tape photos &amp; defect coordinate boxes</>}</dd>
              </div>
            </dl>
            <div className="row flexwrap" style={{ gap: 8 }}>
              <Link className="button primary sm" href={inspHref}>{isZh ? "配置逐件质检 →" : "Configure Product Inspection →"}</Link>
              <Link className="button sm" href={hrefFor("/services/inspection")}>{isZh ? "查看详情" : "Details"}</Link>
            </div>
          </article>

          <article className="pub-compare-mcard">
            <div className="pub-compare-mcard-head">
              <h3>{isZh ? "供应商样品对比" : "Sample Comparison"}</h3>
              <span className="pub-price-chip">{summarizeRate(compOffers, isZh ? "/ 组" : "/ group", isZh ? "按需报价" : "Quote on request")}</span>
            </div>
            <dl>
              <div>
                <dt>{isZh ? "核心适用场景" : "Primary Use Case"}</dt>
                <dd>{isZh ? "同台横向对比 2 或 3 家候选工厂的同等品样品" : "Evaluate 2 or 3 candidate samples from different suppliers side by side"}</dd>
              </div>
              <div>
                <dt>{isZh ? "支持件数范围" : "Eligible Quantity"}</dt>
                <dd>{isZh ? <>每对比组 <strong>2 或 3 件同品类样品</strong></> : <><strong>2 or 3 comparable items</strong> per group</>}</dd>
              </div>
              <div>
                <dt>{isZh ? "核心交付证据" : "Core Evidence"}</dt>
                <dd>{isZh ? "统一尺寸差值对照表 + 同框对比总览实图" : "Unified measurement delta table + single-frame group photo"}</dd>
              </div>
            </dl>
            <div className="row flexwrap" style={{ gap: 8 }}>
              <Link className="button primary sm" href={compHref}>{isZh ? "配置样品对比 →" : "Configure Sample Comparison →"}</Link>
              <Link className="button sm" href={hrefFor("/services/compare")}>{isZh ? "查看详情" : "Details"}</Link>
            </div>
          </article>

          <article className="pub-compare-mcard">
            <div className="pub-compare-mcard-head">
              <h3>{isZh ? "标杆确认样比对" : "Golden Sample Matching"}</h3>
              <span className="pub-price-chip">{summarizeRate(refOffers, isZh ? "/ 次" : "/ match", isZh ? "按需报价" : "Quote on request")}</span>
            </div>
            <dl>
              <div>
                <dt>{isZh ? "核心适用场景" : "Primary Use Case"}</dt>
                <dd>{isZh ? "用已封存标杆确认样核验大货产前样或复购新货" : "Verify a new pre-production or restock piece against your retained Golden Sample"}</dd>
              </div>
              <div>
                <dt>{isZh ? "支持件数范围" : "Eligible Quantity"}</dt>
                <dd>{isZh ? <>每条明细 <strong>1 件来料</strong> 对照 1 件封存标杆样</> : <><strong>1 incoming item</strong> per retained Golden Sample line</>}</dd>
              </div>
              <div>
                <dt>{isZh ? "核心交付证据" : "Core Evidence"}</dt>
                <dd>{isZh ? "封存样 vs 来料双机对比照片与偏差记录" : <>Paired Reference-vs-Incoming photos &amp; variance log</>}</dd>
              </div>
            </dl>
            <div className="row flexwrap" style={{ gap: 8 }}>
              <Link className="button primary sm" href={refHref}>{isZh ? "配置确认样比对 →" : "Configure Golden Sample Matching →"}</Link>
              <Link className="button sm" href={hrefFor("/services/reference")}>{isZh ? "查看详情" : "Details"}</Link>
            </div>
          </article>
        </div>
        <details className="pub-details-drawer">
          <summary>{isZh ? "补充服务规则：检后逐件处置、标杆样前置条件与超差复测机制" : <>Additional service rules: post-report routing, prerequisites &amp; tolerance handling</>}</summary>
          <div className="pub-details-grid">
            <div>
              <strong>{isZh ? "检后逐件自由处置" : "Post-Report Item Routing"}</strong>
              <p>{isZh ? "所有服务项下的每件已检货品均可在报告发布后独立下达处置指令：瑕疵件单独国内退回卖家、合格品申请转为密封标杆确认样留存、暂存或合并发往指定国内集运仓。" : "Every inspected unit across all three services can be instructed individually after report publication: return specific items domestically to your seller, retain an approved unit as a sealed Golden Sample, store temporarily, or consolidate eligible stock to your freight forwarder."}</p>
            </div>
            <div>
              <strong>{isZh ? "标杆确认样前置要求" : "Golden Sample Prerequisite"}</strong>
              <p>{isZh ? "预约标杆确认样比对前，账户下需已存有一件由往期已检合格品转化封存的有效标杆样；实物逐件质检与样品横向对比均无前置库存要求。" : "Golden Sample Matching requires an already-inspected unit converted and sealed in our protected reference storage before placing a matching line. Product Inspection and Sample Comparison have no prior inventory prerequisite."}</p>
            </div>
            <div>
              <strong>{isZh ? "尺寸公差与超差两遍复测" : "Target Tolerance Rules"}</strong>
              <p>{isZh ? "下单时可预设目标尺寸与公差标准；任一实测值超出阈值，系统即强制触发第二遍独立工位人工复测并在定版报告中完整留档。" : "You may submit target dimensions and seller references when ordering. Any measurement reading deviating beyond stated thresholds automatically triggers an independent two-pass bench re-check recorded in your report snapshot."}</p>
            </div>
          </div>
        </details>
      </section>

      {/* 2. Product Inspection */}
      <section className="pub-service-detail" id="product-inspection" aria-labelledby="svc-inspection-title">
        <div>
          <p className="pub-eyebrow">{isZh ? "02 · 核心服务 01 — 单件首样与中小批量全检" : <>02 · SERVICE 01 — INDIVIDUAL SAMPLE &amp; SMALL-BATCH VERIFICATION</>}</p>
          <h2 id="svc-inspection-title" className="pub-h2">{isZh ? "实物商品质检（1 至 100+ 件逐件查验）" : "Product Inspection (1 to 100+ Items)"}</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            {isZh ? (
              <>兼顾<strong>1–3 件打样深度核验</strong>与<strong>10、30、50 或 100 件中小批量全数逐件排查</strong>，杜绝工厂传统抽检（AQL）遗漏单件瑕疵并随大货发往海外。</>
            ) : (
              <>Built for both <strong>detailed sample inspection (1–3 prototype units)</strong> and <strong>small-batch piece-by-piece screening (10, 30, 50, or 100 stock units)</strong> where random factory AQL sampling leaves defects undetected.</>
            )}
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>{isZh ? "适用场景" : "Ideal Scenarios"}</span>
              <strong>{isZh ? "1–3 件开发首样核查及 10–100+ 件跨境独立站小批库存全检" : <>1–3 sample prototype checks &amp; 10–100+ unit Shopify / TikTok small batches</>}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "支持件数" : "Item Quantity"}</span>
              <strong>{isZh ? "线上自助 1–100 件 · 101–300 件转人工工位排期报价" : "1–100 items online · 101–300 via manual bench capacity quote"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "仓内作业方式" : "Bench Method"}</span>
              <strong>{isZh ? "单件赋码、0.1 cm 平铺米尺实测及超差强制两遍复测" : "Individual barcode ID, flat metric tape measurements + two-pass re-checks"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "与其他服务区别" : "How It Differs"}</span>
              <strong>{isZh ? "面向单批商品逐件核对标准清单，而非 2–3 家供应商对比组" : "Checks every physical unit against its checklist rather than grouping suppliers"}</strong>
            </div>
          </div>
          <p className="small muted" style={{ marginBottom: 14 }}>
            <strong>{isZh ? "能力边界声明：" : "Scope boundary:"}</strong>{" "}
            {isZh ? "仅覆盖已到仓实物的非破坏性外观、尺码、克重与工艺查验——不包含破坏性成分化验、水洗缩水测试或监管合规认证。" : "Covers non-destructive visual and dimensional checks on physical arrivals—not destructive lab fiber testing, wash shrinkage, or compliance certification."}
          </p>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href={inspHref}>
              {isZh ? "配置实物逐件质检 →" : "Configure Product Inspection →"}
            </Link>
            <Link className="button sm" href={hrefFor("/services/inspection")}>
              {isZh ? "查看逐件质检详情" : "Product Inspection Details"}
            </Link>
          </div>
        </div>
        <div className="pub-service-photo-stack">
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/service-item-inspection.webp"
              alt="QC Warehouse inspector wearing white cotton gloves measuring a slate-blue cotton sweatshirt with a yellow metric tape beside a blank sample card"
              width={1350}
              height={900}
              loading="eager"
            />
          </figure>
        </div>
      </section>

      {/* 3. Sample Comparison */}
      <section className="pub-service-detail reverse" id="sample-comparison" aria-labelledby="svc-compare-title">
        <div className="pub-service-photo-stack">
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/service-three-samples.webp"
              alt="Overhead studio comparison showing three unbranded cotton T-shirts from separate factories inspected side by side with caliper and metric tape on a neutral table"
              width={1350}
              height={900}
              loading="eager"
            />
          </figure>
        </div>
        <div>
          <p className="pub-eyebrow">{isZh ? "03 · 核心服务 02 — 多供应商选厂对比" : <>03 · SERVICE 02 — SUPPLIER &amp; BATCH SELECTION</>}</p>
          <h2 id="svc-compare-title" className="pub-h2">{isZh ? "供应商样品横向对比（2 或 3 件同品类）" : "Sample Comparison (2 or 3 Comparable Items)"}</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            {isZh ? "网图很难看出真实克重、领口罗纹回弹或版型偏差。将 2 至 3 家备选工厂的同类样品寄至我们摄影工位，在同一标准灯光下同框对比实测。" : "Marketplace photos rarely reveal true weight, rib recovery, or sizing drift. Send samples from 2 or 3 shortlisted sellers and evaluate them together on the same bench under identical lighting."}
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>{isZh ? "适用场景" : "Ideal Scenarios"}</span>
              <strong>{isZh ? "1688 / 阿里国际站等多工厂打样筛选，确定大货合作对象" : "Shortlisting 2–3 factories on 1688 or Alibaba before placing bulk orders"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "支持件数" : "Item Quantity"}</span>
              <strong>{isZh ? "每对比组固定 2 件或 3 件同品类样品" : "2 or 3 items of the same product category per comparison set"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "仓内作业方式" : "Bench Method"}</span>
              <strong>{isZh ? "标准光源俯拍同框组图、统一点位量尺与电子天平克重对比" : <>Synchronized group overhead photo, matching landmarks &amp; digital gram mass</>}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "与其他服务区别" : "How It Differs"}</span>
              <strong>{isZh ? "输出统一差值对照矩阵；我们只呈现客观物理事实，由您独立拍板选厂" : "Produces a single delta comparison matrix; we document facts while you choose"}</strong>
            </div>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href={compHref}>
              {isZh ? "配置样品横向对比 →" : "Configure Sample Comparison →"}
            </Link>
            <Link className="button sm" href={hrefFor("/services/compare")}>
              {isZh ? "查看对比服务详情" : "Sample Comparison Details"}
            </Link>
          </div>
        </div>
      </section>

      {/* 4. Golden Sample Matching */}
      <section className="pub-service-detail" id="golden-sample-matching" aria-labelledby="svc-reference-title">
        <div>
          <p className="pub-eyebrow">{isZh ? "04 · 核心服务 03 — 复购来料一致性控品" : <>04 · SERVICE 03 — REORDER &amp; PRE-PRODUCTION CONTROL</>}</p>
          <h2 id="svc-reference-title" className="pub-h2">{isZh ? "标杆确认样（Golden Sample）留存与比对" : "Golden Sample / Reference Matching"}</h2>
          <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 14 }}>
            {isZh ? "防止工厂在二次翻单中悄悄减重换料或版型走样。将首版签核确认样封存于专用防篡改档案库，后续每批产前样或补货来料直接同台并排对比。" : "Catch silent fabric swaps or sizing changes on repeat shipments. Keep your approved Golden Sample sealed in our dedicated reference storage and benchmark incoming units directly against it."}
          </p>
          <div className="pub-meta-grid">
            <div className="pub-meta-cell">
              <span>{isZh ? "启用方式" : "How Setup Works"}</span>
              <strong>{isZh ? "线上将任意已检合格品转为封存确认样 → 录入专属库位保管" : "Convert an inspected sample online → sealed in protected reference storage"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "支持件数" : "Item Quantity"}</span>
              <strong>{isZh ? "每条订单明细 1 件来料比对 1 件有效封存确认样" : "1 incoming sample matched to 1 active retained Golden Sample per line"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "仓内作业方式" : "Bench Method"}</span>
              <strong>{isZh ? "取出封存样与新来料同框比色差、对版型尺寸偏差及工艺细节" : <>Direct side-by-side placement, flat dimensional variance &amp; visual shade check</>}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "与其他服务区别" : "How It Differs"}</span>
              <strong>{isZh ? "必须先在您名下拥有一件处于有效封存状态的标杆确认样" : "Requires an active sealed Golden Sample already stored under your account"}</strong>
            </div>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary sm" href={refHref}>
              {isZh ? "配置确认样比对 →" : "Configure Golden Sample Matching →"}
            </Link>
            <Link className="button sm" href={hrefFor("/services/reference")}>
              {isZh ? "查看比对服务详情" : "Golden Sample Details"}
            </Link>
          </div>
        </div>
        <figure className="pub-photo-box ratio-3-2">
          <img
            src="/marketing/service-golden-matching.webp"
            alt="QC Warehouse inspector in white cotton gloves comparing two identical dark navy sweatshirts side by side next to a clear protective storage zip bag"
            width={1350}
            height={900}
            loading="eager"
          />
        </figure>

        <div className="pub-service-subrow">
          <div>
            <p className="pub-eyebrow">{isZh ? "受控标杆样留样封存与库房保管" : <>SECURE REFERENCE SAMPLE STORAGE &amp; CUSTODY</>}</p>
            <h3 style={{ fontSize: "1.22rem", color: "#0f213a", margin: "0 0 10px" }}>
              {isZh ? "翻单周期内物理确认样的安全封存保管" : "Secure Reference Sample Storage Between Reorders"}
            </h3>
            <p className="pub-lead" style={{ fontSize: 14, marginBottom: 14 }}>
              {isZh ? "任意质检或样品对比完成后，均可一键把满意样衣转为永久参考样。我们采用独立条码防拆密封袋收存于专用样品档案室，确保未来半年后的复购依然锚定您亲手认可的那一件实体标准。" : "After any inspection or comparison order, convert an approved unit into your retained Golden Sample. We seal it inside an individually barcoded, tamper-evident protective garment bag in our dedicated reference sample archive room so future restock shipments are checked against the exact physical garment you signed off."}
            </p>
            <div className="pub-meta-grid" style={{ margin: 0 }}>
              <div className="pub-meta-cell">
                <span>{isZh ? "初始留存周期" : "Golden Sample Retention"}</span>
                <strong>{isZh ? "转入封存即享 90 天活跃参照留样期" : "90-day active sealed reference window upon conversion"}</strong>
              </div>
              <div className="pub-meta-cell">
                <span>{isZh ? "超期续存费率" : "Extended Storage Rate"}</span>
                <strong>{isZh ? "到期前按公开价目表逐件展示续费标准（当前演示价：$0.25/件/天）" : "Quoted per item before renewal (active demo schedule: $0.25 / item / day)"}</strong>
              </div>
              <div className="pub-meta-cell">
                <span>{isZh ? "保管链路审计" : "Chain of Custody"}</span>
                <strong>{isZh ? "防篡改封签编号 + 专属样品档案架位追溯记录" : <>Tamper-evident seal + dedicated archive rack &amp; bin tracking</>}</strong>
              </div>
              <div className="pub-meta-cell">
                <span>{isZh ? "比对后回库" : "Post-Match Handling"}</span>
                <strong>{isZh ? "每次同台核验结束后立即重新封袋归位留档" : <>Automatically resealed &amp; returned to archive after each check</>}</strong>
              </div>
            </div>
          </div>
          <figure className="pub-photo-box ratio-3-2">
            <img
              src="/marketing/service-reference-storage.webp"
              alt="QC Warehouse sample archivist in white cotton gloves logging a tamper-sealed Golden Sample inside the dedicated multi-tier garment reference sample archive room"
              width={1200}
              height={900}
              loading="eager"
            />
          </figure>
        </div>
      </section>

      {/* 5. Inspection Evidence, Deliverables & Explicit Boundaries */}
      <section className="pub-block" aria-labelledby="deliverables-boundaries-title">
        <div className="pub-section-head" style={{ marginBottom: 16 }}>
          <div>
            <p className="pub-eyebrow">{isZh ? "05 · 报告交付物与服务边界" : <>05 · DELIVERABLES &amp; SERVICE BOUNDARIES</>}</p>
            <h2 id="deliverables-boundaries-title">{isZh ? "您将收到哪些交付物——以及我们明确不做哪些承诺" : "What You Receive—and What We Never Claim"}</h2>
            <p className="pub-lead" style={{ fontSize: 14.5 }}>
              {isZh ? "每一份经 QA 审核发布的质检报告均清晰区隔仓内客观实测证据与实验室检测或驻厂验厂，为您跨境发货前提供干净可核查的决策凭据。" : "Every reviewed inspection report separates verified bench observations from laboratory testing or on-site factory audits—giving commercial buyers clean evidence before shipping from China."}
            </p>
          </div>
          <Link className="button primary sm" href={hrefFor("/report-guide")}>
            {isZh ? "查看完整样板报告 →" : "Explore Full Sample Report →"}
          </Link>
        </div>

        <div className="pub-deliverables-preview">
          <div className="pub-deliverables-cards">
            <div className="pub-deliverable-mini">
              <span className="code">{isZh ? "01 · 签收与条码" : "01 · TRACEABLE LOG"}</span>
              <strong>{isZh ? "到货外箱照与单件条码 ID" : <>Arrival &amp; Individual Item IDs</>}</strong>
              <p>{isZh ? "外包装查验备注加单件唯一流水条码，保证每张图片精准归属到具体哪一件实物。" : "Outer parcel condition notes plus unique barcodes tying every photo back to one piece."}</p>
            </div>
            <div className="pub-deliverable-mini">
              <span className="code">{isZh ? "02 · 实测与标注" : <>02 · MEASUREMENTS &amp; PHOTOS</>}</span>
              <strong>{isZh ? "0.1 cm 量尺数据与红色框注" : <>0.1 cm Readings &amp; Red-Box Overlays</>}</strong>
              <p>{isZh ? "超差指标自动两次独立复测，红色瑕疵坐标仅叠层渲染，原片始终未曾涂改。" : "Two-pass re-checks on variances plus coordinate overlays over untouched raw captures."}</p>
            </div>
            <div className="pub-deliverable-mini">
              <span className="code">{isZh ? "03 · 定版质检报告" : "03 · REVIEWED INSPECTION REPORT"}</span>
              <strong>{isZh ? "专业英文复核报告、PDF 及逐件处置" : <>English QA Review, PDF &amp; Routing</>}</strong>
              <p>{isZh ? "锁定版本的在线中文/英文报告与同步排版 PDF，直接衔接逐件退货、留样或发集运。" : "Reviewed online inspection report (locked version) and matching PDF synced with item-by-item routing choices."}</p>
            </div>
          </div>
          <Link className="button sm" href={hrefFor("/report-guide")} style={{ flexShrink: 0 }}>
            {isZh ? "浏览实机报告示例 →" : "View Live Walkthrough →"}
          </Link>
        </div>
        <div className="pub-boundary-grid">
          <div className="pub-boundary-box included">
            <h3 style={{ color: "#0b816b" }}>{isZh ? "QC Warehouse 报告明确涵盖范围" : "Included in QC Warehouse Reports"}</h3>
            <ul className="pub-check-list">
              <li><b className="mark-ok">✓</b><span>{isZh ? "到仓面单核销、外箱受损记录及单件唯一流水条码赋码" : "Parcel arrival verification, carton condition notes, and unique barcode ID per garment"}</span></li>
              <li><b className="mark-ok">✓</b><span>{isZh ? "必拍服装全貌图、成分/洗水标细节图及带清晰米尺读数的实测照片" : "Mandatory garment overview, care-label, and metric tape-in-frame measurement photos"}</span></li>
              <li><b className="mark-ok">✓</b><span>{isZh ? "精度达 0.1 cm 的平铺尺寸数值与异常超差两遍复测完整记录" : "Recorded flat dimensions (0.1 cm precision) with automatic two-pass re-measurement logs"}</span></li>
              <li><b className="mark-ok">✓</b><span>{isZh ? "非破坏性前端红色标注框及审核员复核的专业英文瑕疵说明" : "Non-destructive UI red bounding boxes and English reviewer translations on observed defects"}</span></li>
              <li><b className="mark-ok">✓</b><span>{isZh ? "锁定历史版本的在线审核报告 + 一致化 PDF 下载 + 逐件售后处置指令台" : "Reviewed online inspection report (locked version history) + matching PDF + post-report routing controls"}</span></li>
            </ul>
          </div>
          <div className="pub-boundary-box excluded">
            <h3 style={{ color: "#b24046" }}>{isZh ? "明确不属于服务范围的事项" : "Outside QC Warehouse Service Scope"}</h3>
            <ul className="pub-check-list">
              <li><b className="mark-no">✕</b><span><strong>{isZh ? "不含实验室理化检测：" : "No Laboratory or Chemical Testing:"}</strong>{" "}{isZh ? "不提供纤维成分百分比、偶氮染料、重金属或剪布取样克重等破坏性实验。" : "No fiber composition %, azo dyes, heavy metals, or destructive GSM cutting."}</span></li>
              <li><b className="mark-no">✕</b><span><strong>{isZh ? "不含法规与安全资质认证" : "No Full Product Safety or Regulatory Certification"}</strong>{" "}(CPSIA, REACH, CE, {isZh ? "阻燃性等" : "flammability"}).</span></li>
              <li><b className="mark-no">✕</b><span><strong>{isZh ? "不提供驻厂整批 AQL 验厂：" : "No Factory-Wide On-Site AQL Audits:"}</strong>{" "}{isZh ? "所有检验结论严格仅对实际寄达中国仓的实物有效。" : "Findings apply only to the physical units received at our China facility."}</span></li>
              <li><b className="mark-no">✕</b><span><strong>{isZh ? "不做商标真伪鉴定" : "No Brand Authenticity Verification"}</strong>{isZh ? "，且" : " and "}<strong>{isZh ? "不对整批大货做零瑕疵商业担保" : "no guarantee of defect-free merchandise"}</strong>.</span></li>
              <li><b className="mark-no">✕</b><span><strong>{isZh ? "不代办清关或包赔卖家货款：" : "No Customs Clearance or Seller Refund Guarantee:"}</strong>{" "}{isZh ? "我司仅执行中国境内快递发运；海外清关与卖家售后退款仍由贵方货代及供应商处理。" : "We execute domestic China dispatch; customs and seller refunds stay with your forwarder and supplier."}</span></li>
            </ul>
          </div>
        </div>
      </section>

      {/* 6. Available Service Packages (Live Catalog) */}
      <section className="pub-block" id="packages" aria-labelledby="packages-heading">
        <div className="pub-section-head" style={{ marginBottom: 16 }}>
          <div>
            <p className="pub-eyebrow">{isZh ? "06 · 实时服装检验服务套餐" : "06 · ACTIVE APPAREL PACKAGES"}</p>
            <h2 id="packages-heading">{isZh ? "当前开放预约的服务方案与模板目录" : <>Available Service Packages &amp; Templates</>}</h2>
            <p className="pub-lead" style={{ fontSize: 14.5 }}>
              {isZh ? "实时读取服务端已核准发布的服务目录。按需选用通用服装全检套餐或专项精细量尺模板。" : "Pulled live from QC Warehouse’s published service catalog. Choose a general apparel package or a dedicated subcategory template with tailored measurement landmarks."}
            </p>
          </div>
          <Link className="button" href={hrefFor("/pricing")}>
            {isZh ? "打开实时费用估算器 →" : "Open Interactive Fee Calculator →"}
          </Link>
        </div>

        {hasDemoRates && (
          <div className="line-note warning" style={{ marginBottom: 18 }}>
            <strong>{isZh ? "服务价目提示：" : "Active catalog notice:"}</strong>{" "}
            {isZh ? "当前公开套餐仍带有预发布/演示参考价标记；您提交委托并确认报价后，价格将在 Stripe 支付前完成锁定。" : "Current packages carry pre-launch / demo pricing metadata from the active server schedule. Confirmed order quotes lock your exact rate before payment."}
          </div>
        )}

        {error && (
          <div className="card">
            <ErrorBlock error={error} />
            <button type="button" className="button sm" onClick={reload}>{isZh ? "重试加载目录" : "Retry loading catalog"}</button>
          </div>
        )}
        {!data && !error && <p role="status" className="muted">{isZh ? "正在加载开放服务套餐…" : "Loading published service packages…"}</p>}
        {data && offers.length === 0 && <Empty>{isZh ? "当前暂无可线上直购套餐，请联系客服咨询定制。" : "No published packages are currently open for checkout. Contact support for custom scope."}</Empty>}

        {inspOffers.length > 0 && (
          <div className="pub-package-group">
            <div className="pub-package-group-head">
              <h3>{isZh ? "逐件实物商品质检套餐" : "Piece-by-Piece Product Inspection Packages"}</h3>
              <span className="small muted">{isZh ? "按件计费 · 线上支持 1–100 件自助委托" : "Priced per physical item · 1–100 items self-serve"}</span>
            </div>
            <div className="pub-package-list">
              {inspOffers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
            </div>
          </div>
        )}

        {compOffers.length > 0 && (
          <div className="pub-package-group">
            <div className="pub-package-group-head">
              <h3>{isZh ? "同台供应商样品横向对比套餐" : "Side-by-Side Sample Comparison Packages"}</h3>
              <span className="small muted">{isZh ? "按组固定计费 · 2 或 3 件同等品类样品" : "Priced per comparison group · 2 or 3 comparable items"}</span>
            </div>
            <div className="pub-package-list">
              {compOffers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
            </div>
          </div>
        )}

        {refOffers.length > 0 && (
          <div className="pub-package-group">
            <div className="pub-package-group-head">
              <h3>{isZh ? "标杆确认样来料对比套餐" : "Golden Sample Reference Matching Packages"}</h3>
              <span className="small muted">{isZh ? "需先在账户下存有活跃密封标杆样" : "Requires an active sealed reference sample in your account"}</span>
            </div>
            <div className="pub-package-list">
              {refOffers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
            </div>
          </div>
        )}
      </section>

      {/* 7. Service FAQ & Final CTA */}
      <section className="card pub-block" aria-labelledby="services-faq-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{isZh ? "07 · 服务选型常见问题" : "07 · COMMON SERVICE QUESTIONS"}</p>
            <h2 id="services-faq-heading">{isZh ? "如何挑选最合适的检验服务模式" : "Choosing the Right Inspection Setup"}</h2>
          </div>
          <Link className="button sm" href={hrefFor("/faq")}>{isZh ? "查看全部 FAQ →" : "All FAQs →"}</Link>
        </div>
        <div className="faq-group">
          <details className="faq-item" open>
            <summary>{isZh ? "应该选通用服装质检还是细分品类模板（上衣 / 下装 / 运动内衣）？" : "Should I choose General Apparel Inspection or a Subcategory Template (Tops / Bottoms / Sports Bra)?"}</summary>
            <p>
              {isZh ? (
                <>如您的货物属于 T 恤、卫衣、针织衫、瑜伽裤/长裤或运动内衣，请直接选用<strong>细分品类模板</strong>——内置专属人体工学量尺点（如 HPS 衣长、前后浪、内长或下胸围带宽）与标准示意图指导。若是连衣裙、外套混批或基础款查验，可选<strong>通用服装模板</strong>。</>
              ) : (
                <>Choose a <strong>Subcategory Template</strong> whenever your items are T-shirts, hoodies, knitwear, leggings, pants, or sports bras—those templates include dedicated anatomical measurement points (such as HPS length, front/back rise, inseam, or underband width) and diagram guidance. Use <strong>General Apparel</strong> for mixed outerwear, dresses, or simpler visual + flat-width checks.</>
              )}
            </p>
          </details>
          <details className="faq-item">
            <summary>{isZh ? "同一张质检订单内，可以既有不合格品退回卖家、又有合格品发去集运仓吗？" : "Can I combine defect returns and freight-forwarder shipping on the same inspection order?"}</summary>
            <p>
              {isZh
                ? "完全可以。检后处置按“单件实物”颗粒度独立下达。例如 40 件里检出 38 件合格、2 件存在污渍或严重尺寸超差，您可指令仓库仅把这 2 件残次品国内退回卖家，同时将另外 38 件合格库存打包发往您的指定国内集运仓。"
                : "Yes. Post-inspection handling is instructed item by item. If 38 units look right and 2 units have documented stains or sizing errors, you can instruct us to return the 2 defective units to your seller’s China return address and consolidate the 38 approved units to your freight forwarder."}
            </p>
          </details>
          <details className="faq-item">
            <summary>{isZh ? "超过 100 件货品或非列表服装款式该如何委托？" : "What if I need to inspect more than 100 items or an unlisted garment type?"}</summary>
            <p>
              {isZh
                ? "101–300 件区间草稿单将自动转入人工工位排期核价，在确认工期与价格前不会扣款。更大批量或特殊自定义检查项，欢迎在寄件前通过在线联系页向运营团队确认可行性。"
                : "Draft orders between 101 and 300 items automatically route to a manual staff quote so our receiving center can confirm bench turnaround before you pay. For larger volumes or custom checkpoints, contact our team before shipping parcels."}
            </p>
          </details>
        </div>
      </section>

      <div className="pub-cta-banner">
        <div>
          <h2>{isZh ? "准备好对中国采购样品或小批货品执行独立收货质检了吗？" : "Ready to Inspect Samples or Small-Batch Stock in China?"}</h2>
          <p>{isZh ? "几分钟内配置检验清单并获取永久中国收件码；如有特殊批量或客制核查需求，也可以先与我们的服务团队确认。" : "Configure your scope in minutes, get your permanent China receiving code, or ask our team to confirm checkpoint feasibility before you order from your supplier."}</p>
        </div>
        <div className="pub-cta-actions">
          <Link className="button primary" href="/orders/new">{isZh ? "发起质检委托 →" : "Start an Inspection →"}</Link>
          <Link className="button pub-btn-ghost" href={hrefFor("/contact?topic=scope")}>{isZh ? "咨询定制检验范围" : "Ask About Custom Scope"}</Link>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   DEDICATED SERVICE DETAIL PAGES (/services/inspection | compare | reference)
   ========================================================================== */
const SERVICE_HERO_CONFIG = {
  inspection: {
    eyebrow: "SERVICE DETAIL · INDIVIDUAL SAMPLE & SMALL-BATCH INSPECTION",
    title: "Product Inspection in China (1 to 100+ Items)",
    lead: "Send 1–3 prototype samples for detailed evaluation or 10–100+ small-batch stock garments for piece-by-piece screening at our China receiving center. Every physical unit gets its own barcode ID, approved template measurements, workmanship check, and documented photo proof.",
    image: "/marketing/service-item-inspection.webp",
    imageAlt: "QC Warehouse inspector wearing white cotton gloves measuring a slate-blue cotton sweatshirt with a yellow metric tape and sample card",
    ratioClass: "",
    idealFor: "Detailed sample checks (1–3 prototypes) and small-batch inventory screening (10–100+ pcs) before international shipping.",
    quantities: "1–100 items self-serve online · 101–300 items via manual staff capacity quote.",
    method: "Individual item check-in, unstrained flat-lay metric tape measurements (0.1 cm precision + two-pass re-checks), digital garment weight, and zone-by-zone visual workmanship scan.",
    distinction: "Unlike Sample Comparison, each item is evaluated individually rather than grouped into a 2–3 supplier comparison matrix.",
  },
  compare: {
    eyebrow: "SERVICE DETAIL · SIDE-BY-SIDE EVALUATION",
    title: "Supplier Sample Comparison Service (2–3 Items)",
    lead: "Evaluating multiple 1688, Alibaba, or direct factories? Ship 2 or 3 comparable apparel samples to our studio so we can measure, weigh, and photograph them together under identical conditions.",
    image: "/marketing/service-three-samples.webp",
    imageAlt: "Overhead studio photo comparing three candidate factory T-shirt samples laid flat under neutral studio lighting beside a caliper and metric tape",
    ratioClass: "",
    idealFor: "Founders and buyers choosing between 2–3 candidate manufacturers before placing bulk deposits or custom label runs.",
    quantities: "2 or 3 comparable items from the same product category per comparison package.",
    method: "Synchronized overhead group photography, identical flat-lay tape placement across every sample, digital gram weight comparison, and collar/seam macro documentation.",
    distinction: "Priced per 2- or 3-item comparison group with a unified delta table. We record objective physical differences; you make the commercial supplier selection.",
  },
  reference_match: {
    eyebrow: "SERVICE DETAIL · BENCHMARK CONSISTENCY",
    title: "Golden Sample & Reference Matching in China",
    lead: "Keep your approved Golden Sample sealed in QC Warehouse’s secure reference sample storage and benchmark new pre-production or reorder samples directly against your physical standard.",
    image: "/marketing/service-golden-matching.webp",
    imageAlt: "Side-by-side comparison showing an approved navy Golden Sample beside a sealed clear storage sleeve and an incoming production sample",
    ratioClass: "",
    idealFor: "Repeat SKU reorders, new factory transitions, and pre-production approval against a signed-off prototype.",
    quantities: "1 incoming sample compared against 1 active retained Golden Sample per order line.",
    method: "Controlled retrieval of your sealed Golden Sample, side-by-side flat measurement delta check, visual shade/rib/stitching comparison, and resealing into storage.",
    distinction: "Requires an active Golden Sample already stored in your QC Warehouse account (converted from a prior inspected item).",
  },
} as const;

export function PublicServiceDetail({
  path,
  serviceCode,
}: {
  path: string;
  serviceCode: "inspection" | "compare" | "reference_match";
}) {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const { data, error, reload } = useLoad("/catalog");
  const allOffers: CatalogOffer[] = data?.offers ?? [];
  const offers = allOffers.filter((o) => o.service === serviceCode);
  const cfg = SERVICE_HERO_CONFIG[serviceCode];
  const zhConfigSpec = {
    inspection: {
      eyebrow: "服务详情 · 单件首样与中小批量全检",
      idealFor: "1–3 件开发打样深度核验，以及 10–100+ 件海外发货前小批成衣全检。",
      quantities: "线上支持 1–100 件自助下单 · 101–300 件转人工确认仓内产能与工期报价。",
      method: "单件贴码建档、无拉伸平铺米尺实测（精度 0.1 cm + 异常自动两遍复测）、整件称重及分区工艺检查。",
      distinction: "与多厂对比不同，按您的质检模板逐件核查到仓每一件实物，而非合并为 2–3 家比较表。",
    },
    compare: {
      eyebrow: "服务详情 · 同台横向对比选厂",
      idealFor: "在大货打款或定制主唛前，在 2–3 家 1688/阿里候选工厂间选型。",
      quantities: "每组固定 2 件或 3 件同等品类可比样品。",
      method: "统一光源俯拍同框组图、完全一致的量尺基准点、电子天平整件克重与领口/车缝特写对比。",
      distinction: "按 2 或 3 件对比组固定收费并输出一张差值矩阵；我们仅提供物理数据，由您作商业选厂决策。",
    },
    reference_match: {
      eyebrow: "服务详情 · 复购一致性标杆对标",
      idealFor: "热销 SKU 复购翻单、换厂转产及照签核首版样验收大货产前样。",
      quantities: "每条明细 1 件新来料比对 1 件已封存有效标杆确认样。",
      method: "严格领出并比对您名下的密封确认样，记录同框尺寸差值、色差与工艺偏差后重新封签归档。",
      distinction: "需您账户内已留有一件由历史已检样品转正封存的标杆确认样。",
    },
  }[serviceCode];
  const fallbackBreadcrumbTitle = {
    inspection: "中国仓实物逐件质检（1–100+ 件）",
    compare: "供应商样品同台横向对比（2–3 件组）",
    reference_match: "标杆确认样封存与复购来料比对",
  }[serviceCode];
  const zhMetaTitle = (code: typeof serviceCode) =>
    ({
      inspection: "中国仓实物逐件质检（1–100+ 件）",
      compare: "供应商样品同台横向对比（2–3 件组）",
      reference_match: "标杆确认样封存与复购来料比对",
    })[code];
  const zhMetaLead = (code: typeof serviceCode) =>
    ({
      inspection: "按实际到仓件数逐件建档赋码、平铺量尺实拍并记录瑕疵，适用于首样核对与中小批量全检。",
      compare: "在统一光源、同等量尺规则下将 2–3 家候选工厂样品同框比较，输出差值对照表。",
      reference_match: "使用您此前封存于专用库的确认样作为物理基准，核验后续新打样与复购批次一致性。",
    })[code];
  const [selectedOfferId, setSelectedOfferId] = useState<string>("");

  useEffect(() => {
    if (offers.length && !offers.some((o) => o.offer_id === selectedOfferId)) {
      setSelectedOfferId(offers[0].offer_id);
    }
  }, [offers, selectedOfferId]);

  const previewOffer = offers.find((o) => o.offer_id === selectedOfferId) ?? offers[0];

  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <Link href={hrefFor("/catalog")}>{isZh ? "质检服务" : "Services"}</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? fallbackBreadcrumbTitle : cfg.title}</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-grid">
          <div>
            <p className="pub-eyebrow">{isZh ? zhConfigSpec.eyebrow : cfg.eyebrow}</p>
            <h1>{isZh ? zhMetaTitle(serviceCode) : cfg.title}</h1>
            <p>{isZh ? zhMetaLead(serviceCode) : cfg.lead}</p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link
                className="button primary"
                href={previewOffer ? `/orders/new?offer=${previewOffer.offer_id}` : "/orders/new"}
              >
                {isZh ? "创建该类服务订单 →" : "Start This Service →"}
              </Link>
              <Link className="button" href={hrefFor("/report-guide")}>
                {isZh ? "查看样板报告" : "View Sample Report"}
              </Link>
              <Link className="button" href={hrefFor("/pricing")}>
                {isZh ? "费用试算" : "Estimate Fee"}
              </Link>
            </div>
          </div>
          <figure className={`pub-page-hero-media${cfg.ratioClass ? ` ${cfg.ratioClass}` : ""}`} style={{ margin: 0 }}>
            <img src={cfg.image} alt={cfg.imageAlt} width={1350} height={900} loading="eager" />
          </figure>
        </div>
      </section>

      <Tabs
        path={hrefFor(path)}
        links={[
          [hrefFor("/catalog"), isZh ? "全部服务总览" : "All Services"],
          [hrefFor("/services/inspection"), isZh ? "实物商品质检" : "Product Inspection"],
          [hrefFor("/services/compare"), isZh ? "样品横向对比" : "Sample Comparison"],
          [hrefFor("/services/reference"), isZh ? "标杆确认样比对" : "Golden Sample Matching"],
        ]}
      />

      <div className="pub-split-2 pub-block">
        <section className="pub-surface-box">
          <p className="pub-eyebrow" style={{ marginBottom: 0 }}>{isZh ? "仓内作业执行规范" : "OPERATING SPECIFICATION"}</p>
          <h2 className="pub-h2" style={{ fontSize: "1.35rem" }}>{isZh ? "该项服务的标准履约流程" : "How This Service Operates"}</h2>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>{isZh ? "适用客户与场景" : "Who It Is For"}</span>
              <strong>{isZh ? zhConfigSpec.idealFor : cfg.idealFor}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "支持件数" : "Supported Quantity"}</span>
              <strong>{isZh ? zhConfigSpec.quantities : cfg.quantities}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "工位检查方式" : "Bench Method"}</span>
              <strong>{isZh ? zhConfigSpec.method : cfg.method}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "服务差异边界" : "How It Differs"}</span>
              <strong>{isZh ? zhConfigSpec.distinction : cfg.distinction}</strong>
            </div>
          </div>

          <div style={{ borderTop: "1px solid #e6edf6", paddingTop: 16, marginTop: 4, display: "grid", gap: 12 }}>
            <p className="pub-eyebrow" style={{ marginBottom: 0 }}>
              {serviceCode === "reference_match"
                ? (isZh ? "标杆确认样封存与再次封签归档" : "SECURE REFERENCE SAMPLE STORAGE & RESEALING")
                : (isZh ? "报告交付物与检后逐件处置" : "DELIVERABLES & POST-REPORT ROUTING")}
            </p>
            {serviceCode === "reference_match" ? (
              <>
                <figure className="pub-photo-box ratio-3-2">
                  <img
                    src="/marketing/service-reference-storage.webp"
                    alt="QC Warehouse sample archivist in white cotton gloves logging a tamper-sealed Golden Sample inside the dedicated multi-tier garment reference sample archive room"
                    width={1200}
                    height={900}
                    loading="eager"
                  />
                </figure>
                <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
                  {isZh
                    ? "批准封存的标杆确认样将装入带防拆封签与独立条码的保护袋，统一归档于专属恒温样品档案库（转入后默认含 90 天活跃留样期，到期前按公开价目表按件展示续期方案）。每次比对核验后均重新加封归位。"
                    : "Approved Golden Samples stay sealed inside tamper-evident protective garment bags in our dedicated reference sample archive room (90-day active Golden Sample retention window upon conversion; extensions are quoted per item from the active storage schedule before renewal). After each comparison, the reference unit is resealed and logged back into the archive."}
                </p>
              </>
            ) : (
              <ul className="pub-check-list" style={{ marginTop: 0 }}>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>{isZh ? "单件可追溯条码：" : "Traceable Item Barcodes:"}</strong>{" "}{isZh ? "每件到仓实物均贴附唯一编号，贯穿签收核验、尺码数据及实拍照片。" : "Every arriving unit receives a unique sample ID linking its intake scan, flat tape readings, and photos."}</span>
                </li>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>{isZh ? "两遍复测核验机制：" : "Two-Pass Measurement Verification:"}</strong>{" "}{isZh ? "任何超差数值均自动触发第二遍独立工位人工重测，且原始两遍数据同档保存。" : "Out-of-tolerance readings trigger an automatic second independent tape pass with both raw values logged."}</span>
                </li>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>{isZh ? "非破坏性缺陷标注：" : "Non-Destructive Defect Overlays:"}</strong>{" "}{isZh ? "由 QA 复核确认的红框坐标在前端交互标注展示，原图始终保持完整无篡改。" : "Reviewer-verified red coordinate boxes highlight defects in the web UI without altering original camera files."}</span>
                </li>
                <li>
                  <b className="mark-ok">✓</b>
                  <span><strong>{isZh ? "检后单件颗粒度处置：" : "Per-Item Post-Report Disposition:"}</strong>{" "}{isZh ? "可按单件决定：瑕疵退回卖家、转为封存标杆样，或发往贵方中国境内集运仓。" : "Choose per unit whether to return to the seller in China, retain as a Golden Sample, or forward to your freight forwarder."}</span>
                </li>
              </ul>
            )}
          </div>
        </section>

        <section className="pub-surface-box">
          <p className="pub-eyebrow" style={{ marginBottom: 0 }}>{isZh ? "当前服务启用模板检查点" : "LIVE TEMPLATE CHECKPOINTS"}</p>
          <h2 className="pub-h2" style={{ fontSize: "1.35rem" }}>{isZh ? "已公布套餐内实际执行检验项" : "Inspectable Checkpoints in Active Catalog"}</h2>
          {offers.length > 1 && (
            <div className="pub-filter-pills" style={{ marginBottom: 4 }}>
              {offers.map((o) => (
                <button
                  key={o.offer_id}
                  type="button"
                  className={`pub-filter-pill${previewOffer?.offer_id === o.offer_id ? " active" : ""}`}
                  onClick={() => setSelectedOfferId(o.offer_id)}
                >
                  {isZh ? (o.title["zh-CN"] || o.title.en) : o.title.en}
                </button>
              ))}
            </div>
          )}
          {previewOffer ? (
            <div className="checklist">
              {previewOffer.content.checks.map((chk) => (
                <div className="checkrow" key={chk.key}>
                  <span className="tag blue">{chk.type === "number" ? chk.unit ?? (isZh ? "量测" : "measure") : (isZh ? "目视" : "visual")}</span>
                  <div>
                    <strong>{isZh ? (chk.zh || chk.label) : chk.label}</strong>
                    <div className="small muted">{chk.method}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{isZh ? "正在加载检验模板项…" : "Loading template checkpoints…"}</p>
          )}
        </section>
      </div>

      {/* Filtered Live Packages */}
      <section className="pub-block" aria-labelledby="detail-packages-title">
        <div className="pub-package-group-head">
          <h2 id="detail-packages-title">{isZh ? "该服务当前开放预约的套餐" : "Available Packages for This Service"}</h2>
          <span className="small muted">{isZh ? "服务端实时定价与承诺时效" : "Server-verified pricing & turnaround"}</span>
        </div>
        {error && (
          <div className="card">
            <ErrorBlock error={error} />
            <button type="button" className="button sm" onClick={reload}>{isZh ? "重试" : "Retry"}</button>
          </div>
        )}
        <div className="pub-package-list">
          {offers.map((o) => <PackageCard key={o.offer_id} offer={o} />)}
        </div>
      </section>

      <div className="line-note" style={{ marginBottom: 24 }}>
        <strong>{isZh ? "服务范围声明：" : "Scope reminder:"}</strong>{" "}
        {isZh
          ? "QC Warehouse 仅对实际到仓实物执行约定的外观检查与平面尺码实测；实验室理化/成分测试、耐水洗牢度、品牌真伪及整厂驻场 AQL 认证均不包含在内。"
          : "QC Warehouse checks commissioned visual and dimensional items on the received samples only. Laboratory chemical/fiber testing, wash durability, brand authenticity, and factory-wide AQL certification are not included."}
      </div>
    </>
  );
}

/* ==========================================================================
   PAGE 03 — PRODUCT CATEGORIES (/categories)
   ========================================================================== */
const PLANNED_AND_RESTRICTED = [
  {
    name: "Footwear",
    nameZh: "鞋靴",
    status: "Planned",
    tone: "yellow",
    note: "Awaiting outsole flexing, pair-symmetry gauge, and sizing-stick template sign-off. Not open for checkout yet.",
    noteZh: "正在定稿鞋底弯折测试、左右脚对称度及鞋楦尺码标尺模板，暂未开放正式下单。",
  },
  {
    name: "Bags & Soft Accessories",
    nameZh: "箱包与软质配饰",
    status: "Planned",
    tone: "yellow",
    note: "Hardware zipper-cycle, strap stitching, and structured gusset measurement templates are in preparation.",
    noteZh: "拉链五金拉合检测、肩带车缝受力及立体箱体包深模板正在测试完善中。",
  },
  {
    name: "Home & Textile Lifestyle",
    nameZh: "家居纺织与软装",
    status: "Planned",
    tone: "yellow",
    note: "Flat soft-home goods will open after oversized bench surface and folding-return packaging SOPs are finalized.",
    noteZh: "将在大尺寸平铺检测台面及叠放回包标准规范签署后开放。",
  },
  {
    name: "Electronics & Battery Devices",
    nameZh: "电子电器与带电产品",
    status: "Restricted",
    tone: "red",
    note: "Electrical safety, firmware, battery transport regulations, and functional load testing are outside QC Warehouse scope.",
    noteZh: "电气安全、固件通电、电池航空运输合规与负载寿命测试不属于 QC Warehouse 服务能力。",
  },
  {
    name: "Toys & Children’s Regulated Goods",
    nameZh: "儿童玩具及强监管婴童用品",
    status: "Restricted",
    tone: "red",
    note: "Requires accredited CPSIA / EN71 small-parts and chemical safety laboratories rather than visual receiving inspection.",
    noteZh: "须送往获授权 CPSIA / EN71 专业实验室完成小零件吞咽及化学安全认证。",
  },
  {
    name: "Hazardous, Pressurized & Perishable Goods",
    nameZh: "危险品、压力容器、生鲜液体及侵权产品",
    status: "Prohibited",
    tone: "red",
    note: "Liquids, cosmetics, food, aerosols, and counterfeit/infringing branded goods must not be shipped to our facility.",
    noteZh: "严禁寄送液体、化妆品、食品、气雾罐及涉嫌侵权仿牌商品至我司仓库。",
  },
] as const;

type DiagramTrack = {
  id: "tops" | "bottoms" | "sports_bra";
  title: string;
  titleZh: string;
  src: string;
  note: string;
  noteZh: string;
};

const MEASUREMENT_DIAGRAMS: DiagramTrack[] = [
  {
    id: "tops",
    title: "Tops, T-Shirts, Hoodies & Knitwear",
    titleZh: "上衣、T 恤、连帽卫衣与针织衫",
    src: "/diagrams/tops.svg",
    note: "Landmark definitions for HPS front length, flat 1/2 chest width (2.5 cm below armhole), across shoulder, sleeve length, and hem.",
    noteZh: "高肩点前衣长（HPS）、夹下 2.5 cm 平铺半胸围、总肩宽、袖长及下摆等核心基准量尺位置说明。",
  },
  {
    id: "bottoms",
    title: "Leggings, Pants, Joggers & Shorts",
    titleZh: "瑜伽裤、运动裤、牛仔及短裤",
    src: "/diagrams/leggings.svg",
    note: "Landmark definitions for unstrained flat waistband (1/2), hip width, front rise, inseam, outseam, and leg opening.",
    noteZh: "自然平铺半腰围、臀围、前浪、内长、外侧裤长及脚口宽标准量测起止点示意。",
  },
  {
    id: "sports_bra",
    title: "Sports Bras & Intimate Activewear",
    titleZh: "运动内衣与贴身健身服",
    src: "/diagrams/sports_bra.svg",
    note: "Landmark definitions for strap-to-hem vertical length, flat bust width, underband width, and side-seam height.",
    noteZh: "肩带至下摆全长、平铺胸宽、下围织带宽及侧缝高度等量测基准。",
  },
];

export function PublicCategories() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const { data, error, reload } = useLoad("/catalog");
  const offers: CatalogOffer[] = data?.offers ?? [];
  const inspOffers = offers.filter((o) => o.service === "inspection");
  const [activeDiagram, setActiveDiagram] = useState<DiagramTrack | null>(null);

  useEffect(() => {
    if (!activeDiagram) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveDiagram(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeDiagram]);

  const findSubOffer = (sub?: string) =>
    inspOffers.find((o) => (o.content?.subcategory ?? "general") === (sub ?? "general")) ?? inspOffers[0];

  const topsOffer = findSubOffer("tops");
  const bottomsOffer = findSubOffer("bottoms");
  const braOffer = findSubOffer("sports_bra");
  const generalOffer = findSubOffer("general");

  const apparelSubtracks = [
    {
      title: isZh ? "上衣、T 恤、连帽卫衣与针织衫" : "Tops, T-Shirts, Hoodies & Knitwear",
      examples: isZh ? "圆领 T 恤、重磅连帽卫衣、Polo 衫、毛衣、拉链开衫" : "Crewneck tees, oversized hoodies, polo shirts, sweaters, zip jackets",
      checks: isZh ? "HPS 前衣长、半胸围（1/2）、肩宽、袖长、下摆宽、领口罗纹及车缝" : "HPS length, chest width (1/2), shoulder, sleeve, hem sweep, collar rib & seams",
      image: "/marketing/category-tops-knitwear.webp",
      imageAlt: "Flat-lay inspection of a heather-gray crewneck T-shirt on a white studio bench",
      diagramId: "tops" as const,
      offer: topsOffer,
    },
    {
      title: isZh ? "瑜伽裤、运动裤、卫裤与短裤" : "Leggings, Pants, Joggers & Shorts",
      examples: isZh ? "健身瑜伽裤、骑行短裤、梭织长裤、牛仔裤、束脚卫裤" : "Activewear leggings, yoga biker shorts, woven trousers, denim, sweatpants",
      checks: isZh ? "平铺腰围、臀围、前后浪、内长、外侧裤长、脚口宽及裆部三角片" : "Relaxed waistband, hip width, front/back rise, inseam, outseam, leg opening & gusset",
      image: "/marketing/category-bottoms-leggings.webp",
      imageAlt: "Overhead flat-lay inspection of charcoal high-waisted yoga leggings and sage-green yoga biker shorts beside a coiled yellow metric measuring tape",
      diagramId: "bottoms" as const,
      offer: bottomsOffer,
    },
    {
      title: isZh ? "运动内衣与贴身健身服" : "Sports Bras & Intimate Activewear",
      examples: isZh ? "中高强度运动文胸、露腰背心、模杯一体款运动内衣" : "Medium/high-support sports bras, crop tanks, moulded-cup bralettes",
      checks: isZh ? "下胸围织带宽、平铺胸宽、肩带对称度、可拆胸垫与里布及弹性车缝" : "Underband width, bust width, strap symmetry, removable pad/lining check & seams",
      image: "/marketing/category-sports-bra.webp",
      imageAlt: "Flat-lay inspection of an athletic sports bra with underband, strap, and cup symmetry checks",
      diagramId: "sports_bra" as const,
      offer: braOffer,
    },
    {
      title: isZh ? "通用服装及综合混合成衣" : "General Apparel & Mixed Garments",
      examples: isZh ? "连衣裙、半身裙、轻薄外套、围巾或标准外观加平铺尺宽核对" : "Dresses, skirts, light outerwear, scarves, or standard visual + flat-width checks",
      checks: isZh ? "分区工艺质量、基础平铺围度、成分/洗水标核查与全角度必拍实图" : "Key workmanship zones, flat width, size/care label check & mandatory overview photos",
      image: "/marketing/category-general-apparel.webp",
      imageAlt:
        "Overhead flat-lay of general apparel including a sage-green woven dress, oatmeal midi skirt, and slate-navy lightweight jacket beside a yellow metric tape and L-square ruler",
      diagramId: null,
      offer: generalOffer,
    },
  ];

  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? "支持检验品类与准入边界" : "Product Categories"}</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-split">
          <div>
            <p className="pub-eyebrow">{isZh ? "支持品类目录 · 当前正式开放服装类目" : "SUPPORTED MERCHANDISE · WHAT CAN YOU INSPECT TODAY?"}</p>
            <h1>{isZh ? "目前正式开放哪些品类的独立检验？" : "What Products Can You Inspect Today?"}</h1>
            <p style={{ marginBottom: 18 }}>
              {isZh ? (
                <>
                  <strong>服装（Apparel）为当前正式开放下单品类。</strong> 我们坚持只有专用检验模板、拍摄光源与平铺量尺基准经过验证并获批后才允许公开下单；尚未开放的类目严禁擅自寄仓且不可线上结账。
                </>
              ) : (
                <>
                  <strong>Apparel is open for orders today.</strong> Rather than claiming generic checks on every category, QC Warehouse launches a category only after dedicated templates, lighting, and flat-lay measurement benchmarks are active on our bench.
                </>
              )}
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                {isZh ? "发起服装质检委托 →" : "Start Apparel Inspection →"}
              </Link>
              <Link className="button" href={hrefFor("/report-guide")}>
                {isZh ? "查看服装样板报告" : "View Sample Apparel Report"}
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>{isZh ? "已开放主力品类" : "Live Category"}</span>
              <strong>{isZh ? "服装全系 · 4 大模板线" : "Apparel · 4 Template Tracks"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "实测计量标准" : "Measurement Standard"}</span>
              <strong>{isZh ? "校准平铺米尺 (0.1 cm)" : "Flat-Lay Metric Tape (0.1 cm)"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "支持服务数量" : "Inspection Scope"}</span>
              <strong>{isZh ? "1–100+ 逐件 · 2–3 件对比" : "1–100+ Units · 2–3 Sample Compare"}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "规划中待开放类目" : "Roadmap Categories"}</span>
              <strong>{isZh ? "鞋靴 / 箱包 / 家居（不可下单）" : "Footwear, Bags & Home Goods"}</strong>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="card">
          <ErrorBlock error={error} />
          <button type="button" className="button sm" onClick={reload}>{isZh ? "重试" : "Retry"}</button>
        </div>
      )}

      {/* Primary Live Category: Apparel */}
      <section className="pub-apparel-spotlight" aria-labelledby="apparel-live-heading">
        <div className="pub-apparel-spotlight-head">
          <div>
            <div className="row flexwrap" style={{ gap: 8, marginBottom: 10 }}>
              <span className="tag green">{isZh ? "当前正式开放下单" : "OPEN FOR ORDERS TODAY"}</span>
              <span className="tag blue">{isZh ? `${offers.length || 9} 套活跃服装方案` : `${offers.length || 9} Active Apparel Packages`}</span>
            </div>
            <h2 id="apparel-live-heading" className="pub-h2">
              {isZh ? "成衣、针织与运动健身服" : <>Apparel, Knitwear &amp; Activewear</>}
            </h2>
            <p className="pub-lead" style={{ fontSize: 14.5, marginBottom: 16 }}>
              {isZh
                ? "全面覆盖逐件实物查验（1–100+ 件）、供应商样品同组对比（2–3 件）与标杆确认样比对。点击下方对应成衣分类即可预选专属量尺检查模板。"
                : "Available across Product Inspection (1–100+ items), Sample Comparison (2–3 items), and Golden Sample Matching. Select your garment type below to pre-select the matching checklist template."}
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link
                className="button primary"
                href={generalOffer ? `/orders/new?offer=${generalOffer.offer_id}` : "/orders/new"}
              >
                {isZh ? "开始服装委托 →" : "Start Apparel Inspection →"}
              </Link>
              <Link className="button" href={hrefFor("/catalog#packages")}>
                {isZh ? "对比服装服务套餐" : "Compare Apparel Packages"}
              </Link>
              <button
                type="button"
                className="button"
                onClick={() => setActiveDiagram(MEASUREMENT_DIAGRAMS[0])}
              >
                {isZh ? "查看量尺基准示意图" : "View Measurement Diagrams"}
              </button>
            </div>
          </div>
        </div>

        <div className="pub-subcat-grid">
          {apparelSubtracks.map((track) => {
            const cents = track.offer?.rules.unit_cents;
            const diagramObj = track.diagramId
              ? MEASUREMENT_DIAGRAMS.find((d) => d.id === track.diagramId) ?? null
              : null;
            return (
              <article className="pub-subcat-card" key={track.title}>
                <div className="pub-subcat-media">
                  <img
                    src={track.image}
                    alt={track.imageAlt}
                    width={1200}
                    height={900}
                    loading="eager"
                  />
                </div>
                <div className="row between flexwrap" style={{ gap: 8 }}>
                  <h3>{track.title}</h3>
                  {cents != null && (
                    <span className="pub-price-chip">{usd(cents)} {isZh ? "/ 件" : "/ item"}</span>
                  )}
                </div>
                <p className="small" style={{ margin: 0, color: "#263b54" }}>
                  <strong>{isZh ? "常见款式：" : "Typical items:"}</strong> {track.examples}
                </p>
                <p className="small muted" style={{ margin: 0 }}>
                  <strong>{isZh ? "重点查验：" : "Key checks:"}</strong> {track.checks}
                </p>
                <div className="row flexwrap" style={{ gap: 8, marginTop: "auto", paddingTop: 6 }}>
                  <Link
                    className="button primary sm"
                    href={track.offer ? `/orders/new?offer=${track.offer.offer_id}` : "/orders/new"}
                  >
                    {isZh ? "预约此成衣模板 →" : "Inspect This Garment Type →"}
                  </Link>
                  {diagramObj && (
                    <button
                      type="button"
                      className="button sm"
                      onClick={() => setActiveDiagram(diagramObj)}
                    >
                      {isZh ? "量尺示意图" : "Measurement Diagram"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {(data?.knowledge_catalog?.groups?.length ?? 0) > 0 && (
          <div className="card-soft" style={{ marginTop: 18 }}>
            <div className="row between flexwrap" style={{ gap: 8, marginBottom: 10 }}>
              <strong>
                {isZh
                  ? `已获批服装标准知识库目录（${data?.knowledge_catalog?.product_types?.length ?? 0} 个标准成衣子类 / ${data?.knowledge_catalog?.groups?.length ?? 0} 大服装分组）`
                  : `Standard Apparel Catalog Coverage (${data?.knowledge_catalog?.product_types?.length ?? 0} garment types across ${data?.knowledge_catalog?.groups?.length ?? 0} groups)`}
              </strong>
              <span className="small muted">
                {isZh ? "仅展示正式批准公开的商品类目；内部复杂度与成本核算系数严格保密不外泄。" : "Only approved apparel types are published; internal pricing/complexity codes remain internal."}
              </span>
            </div>
            <div className="pub-future-grid">
              {((data?.knowledge_catalog?.groups ?? []) as { group_code: string; group_name_en: string; group_name_zh?: string; count: number }[]).map((grp) => (
                <div className="pub-future-card" key={grp.group_code}>
                  <div className="row between" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{isZh ? (grp.group_name_zh || grp.group_name_en) : grp.group_name_en}</strong>
                    <span className="tag blue">{grp.count} {isZh ? "个子类" : "types"}</span>
                  </div>
                  <p className="small muted" style={{ margin: 0, fontSize: 12 }}>
                    {((data?.knowledge_catalog?.product_types ?? []) as { group_code: string; name_en: string; name_zh?: string }[])
                      .filter((pt) => pt.group_code === grp.group_code)
                      .slice(0, 6)
                      .map((pt) => (isZh ? (pt.name_zh || pt.name_en) : pt.name_en))
                      .join(isZh ? "、" : ", ")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Secondary Downgraded Section: Planned & Restricted Categories */}
      <section className="pub-block pub-future-section" aria-labelledby="future-categories-heading">
        <div className="pub-section-head" style={{ marginBottom: 14 }}>
          <div>
            <p className="pub-eyebrow" style={{ color: "#64748b" }}>{isZh ? "规划中与禁限寄品类（不可线上结账）" : "PLANNED & RESTRICTED CATEGORIES"}</p>
            <h2 id="future-categories-heading" style={{ fontSize: "1.22rem", color: "#334155" }}>
              {isZh ? "尚未开放正式下单的品类边界说明" : "Categories Not Open for Checkout"}
            </h2>
            <p className="small muted" style={{ margin: 0, maxWidth: "70ch" }}>
              {isZh
                ? "未经官方书面确认，请勿向 QC Warehouse 寄送非服装品类货物。鞋靴、箱包与家居用品仍在模板与操作规范筹备中，仅开放上线通知预咨询，不予生成订单与收费。"
                : "Do not ship non-apparel goods to QC Warehouse without written operational confirmation. Footwear, bags, and home goods remain offline while gauges and handling SOPs are finalized."}
            </p>
          </div>
          <Link className="button sm" href={hrefFor("/legal/restricted-items")}>
            {isZh ? "查看禁限寄规则 →" : "Restricted Items Policy →"}
          </Link>
        </div>

        <div className="pub-future-grid">
          {PLANNED_AND_RESTRICTED.map((item) => (
            <div className="pub-future-card downgraded" key={item.name}>
              <div className="row between" style={{ gap: 8 }}>
                <strong style={{ color: "#334155", fontSize: 13 }}>{isZh ? item.nameZh : item.name}</strong>
                <span className={`tag ${item.tone}`}>
                  {isZh ? (item.status === "Planned" ? "规划中 · 不可购买" : "禁止寄仓") : item.status}
                </span>
              </div>
              <p className="small muted" style={{ margin: 0, lineHeight: 1.5, fontSize: 12 }}>{isZh ? item.noteZh : item.note}</p>
              {item.status === "Planned" && (
                <div style={{ marginTop: "auto", paddingTop: 4 }}>
                  <Link className="small" style={{ color: "#1d4ed8", fontWeight: 650 }} href={hrefFor(`/contact?topic=category&item=${encodeURIComponent(item.name)}`)}>
                    {isZh ? "登记上线开仓预咨询 →" : "Request waitlist notification →"}
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Interactive Measurement Diagram Reference Modal */}
      {activeDiagram && (
        <div
          className="lightbox-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`Measurement guide for ${isZh ? activeDiagram.titleZh : activeDiagram.title}`}
          onClick={() => setActiveDiagram(null)}
        >
          <div className="pub-diagram-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pub-diagram-modal-head">
              <div>
                <p className="pub-eyebrow" style={{ marginBottom: 2 }}>{isZh ? "标准平铺量尺点位基准" : "MEASUREMENT LANDMARK REFERENCE"}</p>
                <strong style={{ fontSize: "1.05rem", color: "#102038" }}>{isZh ? activeDiagram.titleZh : activeDiagram.title}</strong>
              </div>
              <button type="button" className="button sm" onClick={() => setActiveDiagram(null)}>
                {isZh ? "关闭示意图 ✕" : "Close Diagram ✕"}
              </button>
            </div>
            <div className="pub-filter-pills" style={{ marginBottom: 12 }}>
              {MEASUREMENT_DIAGRAMS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`pub-filter-pill${activeDiagram.id === d.id ? " active" : ""}`}
                  onClick={() => setActiveDiagram(d)}
                >
                  {isZh ? d.titleZh : d.title}
                </button>
              ))}
            </div>
            <div className="pub-diagram-stage">
              <img src={activeDiagram.src} alt={`${isZh ? activeDiagram.titleZh : activeDiagram.title} measurement landmark diagram`} width={520} height={360} />
            </div>
            <p className="small muted" style={{ margin: "12px 0 0" }}>{isZh ? activeDiagram.noteZh : activeDiagram.note}</p>
          </div>
        </div>
      )}
    </>
  );
}

/* ==========================================================================
   PAGE 04 — HOW IT WORKS (/how-it-works)
   ========================================================================== */
type JourneyStep = {
  num: string;
  owner: string;
  title: string;
  youDo: string;
  weDo: string;
  outcome: string;
  photo: string;
  photoAlt: string;
  uiCropTop?: boolean;
};

const JOURNEY_STEPS: JourneyStep[] = [
  {
    num: "01",
    owner: "Buyer Order & Setup",
    title: "Create Your Inspection Order & Get Your Receiving Code",
    youDo: "Choose Apparel Inspection, Sample Comparison, or Golden Sample Matching and set item quantity.",
    weDo: "Generate your permanent China parcel code alongside our receiving hub address and lock your service quote.",
    outcome: "Ready-to-paste shipping recipient details and a structured checklist awaiting supplier parcels.",
    photo: "/marketing/workflow-create-order-ui.webp",
    photoAlt: "Sanitized screenshot of the QC Warehouse Create an Inspection order interface showing service choices and estimated USD pricing",
    uiCropTop: true,
  },
  {
    num: "02",
    owner: "Direct Supplier Dispatch",
    title: "Buy Directly from Suppliers & Ship Domestic Parcels",
    youDo: "Order from 1688, Alibaba, or direct factories and paste your personal code into the recipient block, then enter tracking numbers.",
    weDo: "Accept separate domestic parcels from one or multiple Chinese sellers—we don't source or sell products.",
    outcome: "Every incoming parcel tracking number pre-linked cleanly to your open order.",
    photo: "/marketing/scenes/hiw-02-supplier-dispatch.svg",
    photoAlt: "Clean schematic showing three domestic supplier parcels routed with personal buyer receiving code to the QC Warehouse intake facility",
  },
  {
    num: "03",
    owner: "Inbound Verification",
    title: "Verify Physical Arrival & Inspect Outer Carton",
    youDo: "Wait for our physical check-in notice rather than relying solely on automated courier ‘Delivered’ alerts.",
    weDo: "Scan the domestic waybill at the dock, weigh incoming cartons, and photograph any exterior crushing or dampness.",
    outcome: "Timestamped arrival record confirming physical parcel custody inside the studio.",
    photo: "/marketing/workflow-parcel-receiving.webp",
    photoAlt: "Warehouse intake operator scanning a domestic courier parcel waybill with a handheld barcode scanner at the QC Warehouse receiving bench",
  },
  {
    num: "04",
    owner: "Item Tagging & Staging",
    title: "Unbox, Count & Assign Individual Sample IDs",
    youDo: "Confirm resolution only if an arriving parcel differs from expected count or arrived without a receiving code.",
    weDo: "Open parcels, match unit counts, attach a unique sample tag to every piece, and stage units in numbered bins.",
    outcome: "Full 1-to-1 physical traceability before measurements or photography begin.",
    photo: "/marketing/workflow-sample-registration.webp",
    photoAlt: "Unbagging and registering individual apparel samples on the intake bench with serialized barcode labels and grey sorting totes",
  },
  {
    num: "05",
    owner: "Bench Execution",
    title: "Measure Dimensions, Photograph & Inspect Workmanship",
    youDo: "Supply optional size tolerances or special focus zones up front so the bench enforces your criteria.",
    weDo: "Lay items flat under neutral lighting, shoot mandatory angles & metric tape photos, weigh units, and re-measure outliers.",
    outcome: "Unedited original bench photos and double-checked millimeter-grade data linked per barcode.",
    photo: "/marketing/workflow-inspection-station.webp",
    photoAlt: "Inspector in white cotton gloves measuring a dark navy sweatshirt on a daylight-calibrated studio table beneath softbox lighting and an overhead camera",
  },
  {
    num: "06",
    owner: "Independent QA Review",
    title: "QA Verification & Reviewed Inspection Report",
    youDo: "Receive instant workspace and email notification once the reviewed report version goes live.",
    weDo: "An independent QA reviewer verifies readings, checks defect coordinate boxes, translates bench notes into English, and locks the PDF.",
    outcome: "Reviewed English inspection report (locked version) and downloadable PDF ready for your buying decision.",
    photo: "/marketing/workflow-qa-review-ui.webp",
    photoAlt: "Sanitized screenshot of the QC Warehouse QA review workbench verifying measurements, Chinese field notes, and English translations",
    uiCropTop: true,
  },
  {
    num: "07",
    owner: "Post-Inspection Routing",
    title: "Choose Per Item: Return, Retain, or Forward Outbound",
    youDo: "Decide item by item: authorize domestic returns to sellers, convert an approved unit into a Golden Sample, or ship good stock to your forwarder.",
    weDo: "Pack approved items per your authorization, quote exact domestic courier postage, dispatch cartons, and upload return or outbound tracking numbers.",
    outcome: "Only approved merchandise leaves China while defects stay behind for domestic resolution.",
    photo: "/marketing/workflow-outbound-routing.webp",
    photoAlt: "Outbound sorting and packing bench with neatly folded garments in clear polybags, export carton, digital scale, and numbered disposition bins",
  },
];

const JOURNEY_STEPS_ZH: Array<{
  owner: string;
  title: string;
  youDo: string;
  weDo: string;
  outcome: string;
}> = [
  {
    owner: "买家下单建档",
    title: "创建质检委托并获取永久专属收件码",
    youDo: "选择实物逐件质检、供应商样品对比或标杆确认样比对，并填报预计件数。",
    weDo: "即时生成您的永久中国仓收件识别码、标准仓库收货地址并锁定对应检验服务报价。",
    outcome: "获得可直接复制给国内卖家的收货识别信息及待收货检验清单。",
  },
  {
    owner: "国内卖家直寄",
    title: "由供应商直接采购并寄送国内快递包裹",
    youDo: "在 1688、阿里或合作工厂下单时将您的专属码填入收件人备注，随后在系统登记物流单号。",
    weDo: "支持接收来自单家或多家中国供应商的分批/合批国内快递——我们严守中立，不代采也不卖货。",
    outcome: "所有在途快递运单号提前准确绑定至当前开放委单。",
  },
  {
    owner: "到仓验核入库",
    title: "实扫描码点收与外包装状态查验",
    youDo: "以仓内实物签收提示为准，而非仅依赖国内快递端自动“已签收”通知。",
    weDo: "快递抵达作业台面后扫描条码、整箱复磅称重，并对任何外箱破损、受潮压痕即时拍照留档。",
    outcome: "生成精确到秒的仓内实物入库托管凭证。",
  },
  {
    owner: "拆包赋码定位",
    title: "拆箱复点件数并为每件实物贴附唯一条码",
    youDo: "仅当实到件数与委单不符或包裹无专属收件码时，根据待确认工单补充说明。",
    weDo: "逐箱拆包、核对件数、为每一件服装加贴专属流水条码并分别归入对应作业周转筐。",
    outcome: "在开始量尺与拍照前完成全链路 1 对 1 实物条码追溯。",
  },
  {
    owner: "工位实测执行",
    title: "标准平铺量尺、多角度实拍与工艺查验",
    youDo: "下单时可选填目标尺寸公差或重点排查位置，便于工位精准照单核验。",
    weDo: "中性色温工位台面平铺服装，拍摄必拍视角及带刻度米尺照片、整件克重称量，超差项自动二次复测。",
    outcome: "产出未修图原始实拍照片与双人复核毫米级精度量测数据。",
  },
  {
    owner: "独立 QA 复核",
    title: "QA 审核校对并发布锁定版本报告",
    youDo: "定版报告上线后即刻收到平台站内及邮件通知，可在线调阅全部大图与明细。",
    weDo: "独立 QA 审校员复核量测读数与红框坐标标注、完成专业英文译校并同步锁定不可篡改 PDF 版本。",
    outcome: "交付定版英文质检报告与同版 PDF 下载链接，供跨境决策或发给工厂交涉。",
  },
  {
    owner: "检后按件分流",
    title: "按每件衣物自由选择退货、封存留样或发往集运仓",
    youDo: "逐件下达处置指令：次品国内退回卖家、选定合格样封存作标杆样，或将良品质检品发往货代集运。",
    weDo: "按授权打包拣货、核算国内快递实重运费、发运移交承运商并回填最新国内退回/发货运单号。",
    outcome: "仅有确认合格的商品流出中国发往海外，问题货品留在国内高效处理退换。",
  },
];

const OPERATIONAL_RULES = [
  {
    title: "1. Independent from your suppliers",
    titleZh: "1. 严格独立于所有供应商与货源",
    body: "We don't source or sell products, place orders on marketplaces, or pay factories. Staying independent from your suppliers ensures every report is objective.",
    bodyZh: "我们不代采、不卖货、不经手任何货款，也不向工厂返佣。纯粹的第三方立场是每份报告客观公允的根本保障。",
  },
  {
    title: "2. Multi-supplier & split shipments are welcome",
    titleZh: "2. 支持多工厂混发及同一订单分批寄达",
    body: "Comparing three factories or waiting on split parcels? Register each domestic tracking number; inspection turnaround begins once all commissioned items for the order are physically checked in.",
    bodyZh: "若您同时对比三家工厂或卖家拆单发货，只需依次登记对应国内快递单号；工期自该订单全部约定件数实际到仓扫码齐全起算。",
  },
  {
    title: "3. Courier ‘Delivered’ ≠ Verified Warehouse Check-In",
    titleZh: "3. 快递“已签收”不等同于“仓内点收完成”",
    body: "Domestic couriers often mark gate drop-offs as delivered. Official custody and turnaround timing start only after our staff scans, unboxes, and verifies item counts.",
    bodyZh: "国内快递常将驿站或门卫代收直接标为已签收。唯有我司作业员实际扫码拆包并核对件数入框后，正式托管与承诺时效才算开启。",
  },
  {
    title: "4. Every finding is backed by item-linked proof",
    titleZh: "4. 每项结论均附带精准到单件的实景证据",
    body: "Measurements include stated methods and tape photos; visible defects include close-up images and coordinate overlays tied to the exact sample ID.",
    bodyZh: "尺寸读数必附带米尺同框照片；任何目视瑕疵均有局部特写与对应唯一条码 ID 上的红框坐标标注。",
  },
  {
    title: "5. Autonomous item-by-item post-QC routing",
    titleZh: "5. 检后逐件自由分流，拒收次品不出国",
    body: "You never have to ship bad stock overseas just because it arrived in the same box. Split defective pieces for domestic seller return and forward the remaining items.",
    bodyZh: "即使同一箱货内混有不合格品，也无需一起发往海外承担高昂国际运费。不合格件可在国内直接退还卖家，仅将合格品转交集运。",
  },
  {
    title: "6. Return dispatch does not guarantee seller refunds",
    titleZh: "6. 仓内代寄退回不替代卖家退货款审核",
    body: "You arrange return approval and obtain the return address from your seller; QC Warehouse ships the parcel domestically and records the return waybill, while merchandise refunds remain between you and the seller.",
    bodyZh: "退货需由您先与卖家协商确认并获取中国境内退回地址；我司负责按指派打包代寄与上传国内退货运单号，货款退回由您与卖家或平台解决。",
  },
] as const;

export function PublicHowItWorks() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? "仓内收货与质检流程" : "How It Works"}</strong>
      </div>

      <section className="pub-page-hero">
        <div className="row between flexwrap" style={{ gap: 18 }}>
          <div>
            <p className="pub-eyebrow">{isZh ? "实物托管与全流程交接规范" : "PHYSICAL FULFILLMENT & CUSTODY WORKFLOW"}</p>
            <h1>{isZh ? "QC Warehouse 7 阶段全链路作业说明" : "How QC Warehouse Works—Step by Step"}</h1>
            <p style={{ marginBottom: 0 }}>
              {isZh
                ? "清晰拆解从创建委单获取永久收件码，到国内快递到仓点收、仓内实测实拍、QA 锁定报告以及检后逐件退货/留样/发往集运的全过程。"
                : "Follow all seven physical stages from creating an inspection commission and receiving your permanent parcel code to intake scanning, studio measurement, QA report lock, and item-by-item outbound dispatch."}
            </p>
          </div>
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Link className="button primary" href="/orders/new">
              {isZh ? "立即创建委托 →" : "Create an Inspection →"}
            </Link>
            <Link className="button" href={hrefFor("/report-guide")}>
              {isZh ? "查看样板报告" : "See Sample Report"}
            </Link>
          </div>
        </div>
      </section>

      {/* 7-Step Visual Physical Flow */}
      <ol className="pub-journey" aria-label={isZh ? "7 阶段全流程质检说明" : "Seven-stage inspection workflow"}>
        {JOURNEY_STEPS.map((st, idx) => {
          const reverseRow = idx % 2 === 1;
          const zhStep = JOURNEY_STEPS_ZH[idx];
          const mediaEl = (
            <figure className={`pub-photo-box ratio-3-2${st.uiCropTop ? " ui-shot" : ""}`}>
              <img src={st.photo} alt={st.photoAlt} width={1350} height={900} loading="eager" />
            </figure>
          );

          const textEl = (
            <div className="pub-journey-content">
              <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{isZh && zhStep ? zhStep.owner : st.owner}</p>
              <h2 style={{ fontSize: "1.18rem", margin: "0 0 10px" }}>{isZh && zhStep ? zhStep.title : st.title}</h2>
              <dl className="pub-step-triple">
                <div>
                  <dt>{isZh ? "客户操作" : "What you do"}</dt>
                  <dd>{isZh && zhStep ? zhStep.youDo : st.youDo}</dd>
                </div>
                <div>
                  <dt>{isZh ? "QC Warehouse 执行" : "QC Warehouse does"}</dt>
                  <dd>{isZh && zhStep ? zhStep.weDo : st.weDo}</dd>
                </div>
                <div>
                  <dt>{isZh ? "本步产出" : "Outcome"}</dt>
                  <dd>{isZh && zhStep ? zhStep.outcome : st.outcome}</dd>
                </div>
              </dl>
            </div>
          );

          return (
            <li key={st.num} className={`pub-journey-step${reverseRow ? " reverse" : ""}`}>
              <span className="pub-journey-badge">{st.num}</span>
              {reverseRow ? (
                <>
                  {mediaEl}
                  {textEl}
                </>
              ) : (
                <>
                  {textEl}
                  {mediaEl}
                </>
              )}
            </li>
          );
        })}
      </ol>

      {/* 6 Essential Operational Truths */}
      <section className="pub-block" aria-labelledby="ops-rules-heading">
        <div className="pub-section-head" style={{ marginBottom: 16 }}>
          <div>
            <p className="pub-eyebrow">{isZh ? "运营权责边界与重要提示" : <>OPERATING BOUNDARIES &amp; EXPECTATIONS</>}</p>
            <h2 id="ops-rules-heading">{isZh ? "寄送包裹至中国仓前务必了解的 6 条作业准则" : "Six Practical Rules Before You Ship Parcels"}</h2>
          </div>
        </div>
        <div className="pub-rules-grid">
          {OPERATIONAL_RULES.map((rule) => (
            <article className="pub-rule-card" key={rule.title}>
              <h3>{isZh ? rule.titleZh : rule.title}</h3>
              <p>{isZh ? rule.bodyZh : rule.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Simplified Secondary Responsibility Matrix */}
      <section className="card pub-block" aria-labelledby="resp-matrix-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{isZh ? "三方职责速查表" : "QUICK REFERENCE"}</p>
            <h2 id="resp-matrix-heading" style={{ fontSize: "1.2rem" }}>{isZh ? "买家、国内卖家与 QC Warehouse 权责分工总览" : <>Role &amp; Responsibility Summary</>}</h2>
          </div>
        </div>
        <div className="tablewrap pub-resp-desktop">
          <table className="tbl">
            <thead>
              <tr>
                <th>{isZh ? "环节阶段" : "Stage"}</th>
                <th>{isZh ? "贵方（买家）" : "You (Buyer)"}</th>
                <th>{isZh ? "中国供应商 / 卖家" : "Chinese Seller"}</th>
                <th>QC Warehouse</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>{isZh ? "商品采购下单" : "Merchandise Purchase"}</strong></td>
                <td>{isZh ? "自行选厂、支付货款并在收货地址中附带专属收件码" : <>Select supplier, pay for goods &amp; share receiving code</>}</td>
                <td>{isZh ? "通过中国境内快递发往我司仓库" : "Ship parcel domestically in China"}</td>
                <td>{isZh ? "不介入交易（绝对中立第三方）" : "Not involved (independent third party)"}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "到仓签收核验" : "Inbound Arrival"}</strong></td>
                <td>{isZh ? "在后台预报登记卖家国内物流单号" : "Register seller’s courier tracking number"}</td>
                <td>{isZh ? "提供准确运单号与实际装箱数量" : <>Provide accurate waybill &amp; packing count</>}</td>
                <td>{isZh ? "扫码验证到仓、核对箱态并逐件贴标" : <>Verify physical receipt, carton state &amp; item IDs</>}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "实物检验执行" : "Physical Inspection"}</strong></td>
                <td>{isZh ? "选用适用检验模板并可选填公差标准" : <>Select template &amp; optional target specs</>}</td>
                <td>—</td>
                <td>{isZh ? "完成清单检查、实拍、超差复测与 QA 译校" : <>Execute checklist, photos, re-measurements &amp; QA review</>}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "不合格品退回卖家" : "Seller Returns"}</strong></td>
                <td>{isZh ? "向卖家协商退货、填写退回地址并结算国内快递费" : <>Agree return with seller, supply return address &amp; pay return postage</>}</td>
                <td>{isZh ? "签收退回包裹并依据平台规则退还货款" : <>Receive return &amp; process merchandise refund</>}</td>
                <td>{isZh ? "打包获授权退货件、交寄快递并录入退货运单" : <>Pack authorized items, hand over to courier &amp; log waybill</>}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "合格品转交集运" : "Forwarding Abroad"}</strong></td>
                <td>{isZh ? "指定中国境内集运仓并确认国内出库报价" : <>Appoint freight forwarder &amp; approve domestic shipping quote</>}</td>
                <td>—</td>
                <td>{isZh ? "按指令合箱或打包发往您指定的国内集运点" : <>Consolidate eligible items &amp; ship to your China forwarder</>}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="pub-resp-mobile">
          {(isZh
            ? [
                [
                  "商品采购下单",
                  "自行选厂、支付货款并在收货地址中附带专属收件码",
                  "通过中国境内快递发往我司仓库",
                  "不介入交易（绝对中立第三方）",
                ],
                [
                  "到仓签收核验",
                  "在后台预报登记卖家国内物流单号",
                  "提供准确运单号与实际装箱数量",
                  "扫码验证到仓、核对箱态并逐件贴标",
                ],
                [
                  "实物检验执行",
                  "选用适用检验模板并可选填公差标准",
                  "—",
                  "完成清单检查、实拍、超差复测与 QA 译校",
                ],
                [
                  "不合格品退回卖家",
                  "向卖家协商退货、填写退回地址并结算国内快递费",
                  "签收退回包裹并依据平台规则退还货款",
                  "打包获授权退货件、交寄快递并录入退货运单",
                ],
                [
                  "合格品转交集运",
                  "指定中国境内集运仓并确认国内出库报价",
                  "—",
                  "按指令合箱或打包发往您指定的国内集运点",
                ],
              ]
            : [
                [
                  "Merchandise Purchase",
                  "Select supplier, pay for goods & share receiving code",
                  "Ship parcel domestically in China",
                  "Not involved (independent third party)",
                ],
                [
                  "Inbound Arrival",
                  "Register seller’s courier tracking number",
                  "Provide accurate waybill & packing count",
                  "Verify physical receipt, carton state & item IDs",
                ],
                [
                  "Physical Inspection",
                  "Select template & optional target specs",
                  "—",
                  "Execute checklist, photos, re-measurements & QA review",
                ],
                [
                  "Seller Returns",
                  "Agree return with seller, supply return address & pay return postage",
                  "Receive return & process merchandise refund",
                  "Pack authorized items, hand over to courier & log waybill",
                ],
                [
                  "Forwarding Abroad",
                  "Appoint freight forwarder & approve domestic shipping quote",
                  "—",
                  "Consolidate eligible items & ship to your China forwarder",
                ],
              ]
          ).map(([stage, buyer, seller, qcw]) => (
            <article className="pub-resp-mcard" key={stage}>
              <h3>{stage}</h3>
              <dl>
                <div><dt>{isZh ? "贵方（买家）" : "You (Buyer)"}</dt><dd>{buyer}</dd></div>
                <div><dt>{isZh ? "中国供应商 / 卖家" : "Chinese Seller"}</dt><dd>{seller}</dd></div>
                <div><dt>QC Warehouse</dt><dd>{qcw}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <div className="pub-cta-banner">
        <div>
          <h2>{isZh ? "免费注册领取中国仓址与永久专属收件码" : "Get Your China Receiving Address & Permanent Code Free"}</h2>
          <p>{isZh ? "两分钟内完成账号注册，立即获取仓址与专属码，仅在正式确认质检委托范围后才产生服务费用。" : "Sign up in under two minutes, view your dedicated warehouse address, and pay inspection fees only when you confirm an order scope."}</p>
        </div>
        <div className="pub-cta-actions">
          <Link className="button primary" href="/orders/new">{isZh ? "立即开始 →" : "Create Account & Start →"}</Link>
          <Link className="button pub-btn-ghost" href={hrefFor("/faq")}>{isZh ? "阅读常见问题" : "Read Buyer FAQ"}</Link>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   PAGE 06 — PRICING & SERVER-CONSISTENT FEE CALCULATOR (/pricing)
   ========================================================================== */
export function PublicPricing() {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const { data, error, reload } = useLoad("/catalog");
  const offers: CatalogOffer[] = data?.offers ?? [];
  const inspOffers = offers.filter((o) => o.service === "inspection");
  const compOffers = offers.filter((o) => o.service === "compare");
  const refOffers = offers.filter((o) => o.service === "reference_match");
  const hasDemoRates = offers.some((o) => o.rules?.demo === true);

  const [service, setService] = useState<"inspection" | "compare" | "reference_match">("inspection");
  const [offerId, setOfferId] = useState<string>("");
  const [qty, setQty] = useState<number>(10);

  const servicePool = offers.filter((o) => o.service === service);

  useEffect(() => {
    if (!servicePool.length) return;
    const currentValid = servicePool.some((o) => o.offer_id === offerId);
    if (!currentValid) {
      const preferred =
        service === "inspection"
          ? servicePool.find((o) => !o.content?.subcategory) ?? servicePool[0]
          : servicePool[0];
      setOfferId(preferred.offer_id);
      if (service === "compare") {
        setQty(preferred.rules.minimum);
      } else if (service === "reference_match") {
        setQty(1);
      } else if (qty < 1 || qty > 350) {
        setQty(10);
      }
    }
  }, [service, servicePool, offerId, qty]);

  const activeOffer = servicePool.find((o) => o.offer_id === offerId) ?? servicePool[0];

  function handleOfferChange(nextId: string) {
    setOfferId(nextId);
    const picked = servicePool.find((o) => o.offer_id === nextId);
    if (picked && picked.service === "compare") {
      setQty(picked.rules.minimum);
    } else if (picked && picked.service === "reference_match" && qty > 20) {
      setQty(1);
    }
  }

  // Exact server-equivalent calculation (mirrors packages/core/orders.ts)
  let calcHeadline = isZh ? "正在计算…" : "Loading…";
  let calcSubnote = "";
  let calcUnitText = "";
  let isManualQuote = false;
  let isCustomInquiry = false;

  if (activeOffer) {
    const safeQty = Math.max(1, Math.floor(Number.isFinite(qty) ? qty : 1));
    if (service === "inspection") {
      const unit = activeOffer.rules.unit_cents ?? 0;
      calcUnitText = isZh
        ? `${usd(unit)} × ${safeQty} 件实物`
        : `${usd(unit)} × ${safeQty} ${safeQty === 1 ? "item" : "items"}`;
      if (safeQty > 300) {
        isCustomInquiry = true;
        calcHeadline = isZh ? "专项人工批检报价" : "Custom Quotation";
        calcSubnote = isZh
          ? "单笔委托超过 300 件上限时须转为专项批检排期，由运营团队单独核定报价。"
          : "Orders above 300 physical items exceed single-order online limits and are quoted as a scheduled batch.";
      } else if (safeQty > activeOffer.rules.maximum) {
        isManualQuote = true;
        calcHeadline = isZh ? "人工工位核价草稿" : "Manual Staff Quote";
        calcSubnote = isZh
          ? `${activeOffer.rules.maximum + 1}–300 件区间的订单会先保存为草稿，待仓内复核排期与工位产能后出价再支付。`
          : `Quantities of ${activeOffer.rules.maximum + 1}–300 items are saved as a draft order and reviewed by staff to confirm turnaround & bench capacity before payment.`;
      } else {
        calcHeadline = usd(unit * safeQty);
        calcSubnote = isZh
          ? `支持直接线上结账 · 全部 ${safeQty} 件点收齐备后约 ${activeOffer.rules.business_days} 个工作日交付报告。`
          : `Standard online checkout · Est. ${activeOffer.rules.business_days} business days after all ${safeQty} items are received & identified.`;
      }
    } else if (service === "compare") {
      const pkg = activeOffer.rules.package_cents ?? 0;
      const validSetSize = activeOffer.rules.minimum;
      calcUnitText = isZh
        ? `固定 ${validSetSize} 件同台对比组套餐`
        : `Fixed ${validSetSize}-item comparison package`;
      calcHeadline = usd(pkg);
      calcSubnote = isZh
        ? `包含 ${validSetSize} 件同类样品同框评估并合出一份对比报告（${activeOffer.rules.business_days} 个工作日）。如需对 4 件及以上大货单独建档，请切换回“实物商品质检”。`
        : `Covers ${validSetSize} comparable items evaluated side by side in one report (${activeOffer.rules.business_days} business days). Need 4+ items checked individually? Switch to Product Inspection.`;
    } else {
      // reference_match: server rules minimum=1, maximum=1 per order line, up to 20 order lines per order
      const pkg = activeOffer.rules.package_cents ?? 0;
      if (safeQty > 20) {
        isCustomInquiry = true;
        calcUnitText = isZh ? `${safeQty} 件待比对来料` : `${safeQty} incoming samples`;
        calcHeadline = isZh ? "专项人工核价" : "Custom Quotation";
        calcSubnote = isZh
          ? "每条确认样比对明细对应 1 件新来料比对 1 件封存标杆样（单笔在线最多 20 条）；更大批比对请联系我们。"
          : "Each Reference Match line compares 1 incoming item against 1 retained Golden Sample (up to 20 lines per online order). Contact us for larger batch matching.";
      } else {
        calcUnitText = isZh
          ? safeQty === 1
            ? `${usd(pkg)} × 1 条单件比对明细`
            : `${usd(pkg)} × ${safeQty} 条独立 1 对 1 比对明细`
          : safeQty === 1
            ? `${usd(pkg)} × 1 incoming item line`
            : `${usd(pkg)} × ${safeQty} separate 1-item reference lines`;
        calcHeadline = usd(pkg * safeQty);
        calcSubnote = isZh
          ? safeQty === 1
            ? `以账户内已封存的 1 件有效标杆确认样为基准，比对 1 件新来料（${activeOffer.rules.business_days} 个工作日）。`
            : `按“1 件新来料对 1 份标杆样”共计 ${safeQty} 条明细合算（${usd(pkg * safeQty)}）。若需查验 20+ 件无逐件对标要求的中小批补货，建议改选“实物商品质检”。`
          : safeQty === 1
            ? `Matches 1 incoming item against 1 active Golden Sample held in protected reference storage (${activeOffer.rules.business_days} business days).`
            : `Quotes Reference Matching at 1 incoming item per order line (${safeQty} lines = ${usd(pkg * safeQty)}). For 20+ restock units without individual reference pairs, consider Product Inspection.`;
      }
    }
  } else if (data) {
    calcHeadline = isZh ? "请联系获取报价" : "Quote on request";
    calcSubnote = isZh ? "当前所选条件下暂无已上线服务方案。" : "No active catalog offer found for this selection.";
  }

  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{isZh ? "收费标准与实时费用估算" : "Pricing & Fee Estimator"}</strong>
      </div>

      <section className="pub-page-hero">
        <div className="pub-page-hero-split">
          <div>
            <p className="pub-eyebrow">{isZh ? "透明商业计费规则 · 美元 (USD)" : "TRANSPARENT COMMERCIAL PRICING · USD"}</p>
            <h1>{isZh ? "质检服务如何计费、包含哪些工作以及哪些费用另计？" : "How Much Will I Pay, What Is Included, and What Costs Extra?"}</h1>
            <p style={{ marginBottom: 18 }}>
              {isZh
                ? "QC Warehouse 按次透明收取质检/样品对比服务费，无任何会员月费或代采加价。检后国内退商家/发往集运仓快递运费与超期仓储费仅在您实际下达对应指令后单独核价结算。"
                : "QC Warehouse charges a clear, upfront fee for physical inspection or sample comparison—with zero subscription fees. Because we don't source or sell products, our findings stay independent from your suppliers. Post-inspection domestic courier shipping and extended storage are billed separately only when you request them."}
            </p>
            <div className="row flexwrap" style={{ gap: 10 }}>
              <Link className="button primary" href="/orders/new">
                {isZh ? "开始下单委托 →" : "Start an Inspection →"}
              </Link>
              <a className="button" href="#pricing-calculator">
                {isZh ? "在线费用试算" : "Estimate Order Cost"}
              </a>
              <Link className="button" href={hrefFor("/report-guide")}>
                {isZh ? "查看样板报告" : "View Sample Report"}
              </Link>
            </div>
          </div>
          <div className="pub-meta-grid" style={{ margin: 0 }}>
            <div className="pub-meta-cell">
              <span>{isZh ? "实物商品质检" : "Product Inspection"}</span>
              <strong>{summarizeRate(inspOffers, isZh ? "/ 件" : "/ item", isZh ? "按需报价" : "Quote on request")}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "供应商样品对比" : "Sample Comparison"}</span>
              <strong>{summarizeRate(compOffers, isZh ? "/ 组" : "/ group", isZh ? "按需报价" : "Quote on request")}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "标杆确认样比对" : "Golden Sample Match"}</span>
              <strong>{summarizeRate(refOffers, isZh ? "/ 次" : "/ match", isZh ? "按需报价" : "Quote on request")}</strong>
            </div>
            <div className="pub-meta-cell">
              <span>{isZh ? "线上自助下单支持" : "Online Self-Service"}</span>
              <strong>{isZh ? "1–100 件实时核价" : "1–100 Units Instant Quote"}</strong>
            </div>
          </div>
        </div>
      </section>

      {hasDemoRates && (
        <div className="line-note warning" style={{ marginBottom: 22 }} role="status">
          <strong>{isZh ? "预发布 / 演示参考价说明：" : "Pre-launch / demo rate notice:"}</strong>{" "}
          {isZh
            ? "当前展示价格来自活跃演示价目表，并非最终正式商业收费标准；下单提交后将在 Stripe 结账前按系统确认报价锁定。"
            : "Displayed fees come from the active demonstration schedule rather than finalized production billing rates. At checkout, your exact confirmed quote locks before Stripe payment."}
        </div>
      )}

      {error && (
        <div className="card">
          <ErrorBlock error={error} />
          <button type="button" className="button sm" onClick={reload}>{isZh ? "重试" : "Retry"}</button>
        </div>
      )}

      {/* 3 Billing Models Overview */}
      <div className="pub-service-pillars pub-block">
        <section className="pub-pillar">
          <div className="pub-pillar-body">
            <span className="pub-eyebrow" style={{ marginBottom: 0 }}>{isZh ? "按每件实物计费" : "BILLED PER PHYSICAL ITEM"}</span>
            <div className="pub-pillar-top">
              <h3>{isZh ? "实物商品质检" : "Product Inspection"}</h3>
              <span className="pub-price-chip">{summarizeRate(inspOffers, isZh ? "/ 件" : "/ item", isZh ? "按需报价" : "Quote on request")}</span>
            </div>
            <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
              {isZh ? (
                <>按实际寄达件数委单：线上支持 1 至 100 件（101–300 件转人工核价）。通用服装为 {inspOffers.find((o) => !o.content?.subcategory) ? usd(inspOffers.find((o) => !o.content?.subcategory)!.rules.unit_cents!) : "按模板报价"}/件；上衣、下装与运动内衣专项模板为 {inspOffers.find((o) => o.content?.subcategory === "tops") ? usd(inspOffers.find((o) => o.content?.subcategory === "tops")!.rules.unit_cents!) : "按模板报价"}/件。</>
              ) : (
                <>Commission the exact number of items you want checked—from 1 sample to 100 units online (101–300 via manual quote). General Apparel is {inspOffers.find((o) => !o.content?.subcategory) ? usd(inspOffers.find((o) => !o.content?.subcategory)!.rules.unit_cents!) : "quoted"}/item; dedicated Tops, Bottoms &amp; Sports Bra templates are {inspOffers.find((o) => o.content?.subcategory === "tops") ? usd(inspOffers.find((o) => o.content?.subcategory === "tops")!.rules.unit_cents!) : "quoted"}/item.</>
              )}
            </p>
            <div className="pub-pillar-foot">
              <Link className="button sm" href={hrefFor("/services/inspection")}>{isZh ? "服务范围 →" : "Service scope →"}</Link>
              <Link
                className="button primary sm"
                href={
                  (inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0])
                    ? `/orders/new?offer=${(inspOffers.find((o) => !o.content?.subcategory) ?? inspOffers[0]).offer_id}`
                    : "/orders/new"
                }
              >
                {isZh ? "立即配置" : "Configure"}
              </Link>
            </div>
          </div>
        </section>

        <section className="pub-pillar">
          <div className="pub-pillar-body">
            <span className="pub-eyebrow" style={{ marginBottom: 0 }}>{isZh ? "按对比组固定计费" : "BILLED PER COMPARISON SET"}</span>
            <div className="pub-pillar-top">
              <h3>{isZh ? "供应商样品对比" : "Sample Comparison"}</h3>
              <span className="pub-price-chip">{summarizeRate(compOffers, isZh ? "/ 组" : "/ group", isZh ? "按需报价" : "Quote on request")}</span>
            </div>
            <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
              {isZh
                ? "固定整组费用覆盖 2 件或 3 件同台样品。涵盖统一工位俯拍组图、平铺尺寸差值矩阵表及各样品单项做工细查。"
                : "Fixed group fee covering 2 or 3 comparable items evaluated together on the same bench. Includes synchronized group photography, flat measurement delta table, and individual defect checks."}
            </p>
            <div className="pub-pillar-foot">
              <Link className="button sm" href={hrefFor("/services/compare")}>{isZh ? "服务范围 →" : "Service scope →"}</Link>
              <Link
                className="button primary sm"
                href={
                  (compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0])
                    ? `/orders/new?offer=${(compOffers.find((o) => !o.content?.subcategory) ?? compOffers[0]).offer_id}`
                    : "/orders/new"
                }
              >
                {isZh ? "立即配置" : "Configure"}
              </Link>
            </div>
          </div>
        </section>

        <section className="pub-pillar">
          <div className="pub-pillar-body">
            <span className="pub-eyebrow" style={{ marginBottom: 0 }}>{isZh ? "按每次来料比对计费" : "BILLED PER INCOMING MATCH"}</span>
            <div className="pub-pillar-top">
              <h3>{isZh ? "标杆确认样比对" : "Golden Sample Matching"}</h3>
              <span className="pub-price-chip">{summarizeRate(refOffers, isZh ? "/ 次" : "/ match", isZh ? "按需报价" : "Quote on request")}</span>
            </div>
            <p className="small" style={{ margin: 0, color: "#42566e", lineHeight: 1.55 }}>
              {isZh
                ? "按单件新来料对照账户内已密封的标杆确认样计费。包含标杆样领出、双件对比实拍及核验后重新封袋入库。"
                : "Priced per single incoming sample matched against an active Golden Sample already sealed in protected reference storage under your account. Includes Reference-vs-Incoming side-by-side photos and resealing."}
            </p>
            <div className="pub-pillar-foot">
              <Link className="button sm" href={hrefFor("/services/reference")}>{isZh ? "服务范围 →" : "Service scope →"}</Link>
              <Link
                className="button primary sm"
                href={refOffers[0] ? `/orders/new?offer=${refOffers[0].offer_id}` : "/orders/new"}
              >
                {isZh ? "立即配置" : "Configure"}
              </Link>
            </div>
          </div>
        </section>
      </div>

      {/* Interactive Server-Consistent Fee Calculator */}
      <section className="pub-surface-box pub-block" id="pricing-calculator" aria-labelledby="calc-heading">
        <div>
          <p className="pub-eyebrow">{isZh ? "服务端同源计费规则试算" : "SERVER-CONSISTENT FEE ESTIMATOR"}</p>
          <h2 id="calc-heading" className="pub-h2">{isZh ? "实时测算当次质检服务费用" : "Estimate Your Exact Inspection Fee"}</h2>
          <p className="pub-lead" style={{ fontSize: 14 }}>
            {isZh
              ? "采用与订单结算页完全一致的服务准入、单件/按组计费口径及人工排期阈值，无虚假折扣。"
              : "Uses the same offer eligibility, unit/package billing rules, and manual-quote thresholds as QC Warehouse’s order checkout engine."}
          </p>
        </div>

        <div className="pub-calc-grid">
          <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
            <div className="field">
              <label htmlFor="calc-service">{isZh ? "1. 选择质检服务模式" : "1. Choose Service Type"}</label>
              <select
                id="calc-service"
                value={service}
                onChange={(e) => setService(e.target.value as "inspection" | "compare" | "reference_match")}
              >
                <option value="inspection">{isZh ? "实物商品质检（逐件查验 · 按件计费）" : "Product Inspection (Piece-by-Piece · per item)"}</option>
                <option value="compare">{isZh ? "供应商样品对比（2 或 3 件同框 · 按组计费）" : "Sample Comparison (2 or 3 items · per group)"}</option>
                <option value="reference_match">{isZh ? "标杆确认样比对（1 件来料 vs 封存基准样）" : "Golden Sample Matching (1 incoming item vs retained reference)"}</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="calc-offer">{isZh ? "2. 选择已获批服装模板 / 方案" : "2. Select Approved Apparel Template / Package"}</label>
              <select
                id="calc-offer"
                value={activeOffer?.offer_id ?? ""}
                onChange={(e) => handleOfferChange(e.target.value)}
              >
                {servicePool.map((o) => {
                  const rate = usd(o.rules.unit_cents ?? o.rules.package_cents ?? 0);
                  const unit = o.rules.unit_cents != null
                    ? (isZh ? "/ 件" : "/ item")
                    : o.service === "reference_match"
                      ? (isZh ? "/ 次" : "/ match")
                      : (isZh ? "/ 组" : "/ set");
                  return (
                    <option key={o.offer_id} value={o.offer_id}>
                      {isZh ? (o.title["zh-CN"] || o.title.en) : o.title.en} — {rate} {unit}
                    </option>
                  );
                })}
              </select>
            </div>

            {service === "inspection" && (
              <div className="field">
                <label htmlFor="calc-qty">{isZh ? "3. 拟逐件查验的实物商品总件数" : "3. Number of Physical Items to Inspect Individually"}</label>
                <input
                  id="calc-qty"
                  type="number"
                  min={1}
                  max={500}
                  step={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                />
                <div className="pub-qty-pills" role="group" aria-label={isZh ? "常用件数快捷选择" : "Quick quantity presets"}>
                  {[1, 5, 15, 30, 50, 100, 150].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`pub-qty-pill${qty === preset ? " active" : ""}`}
                      onClick={() => setQty(preset)}
                    >
                      {isZh ? `${preset} 件` : `${preset} ${preset === 1 ? "item" : "items"}`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {service === "compare" && activeOffer && (
              <div className="field">
                <label>{isZh ? "3. 同组对比样品数量" : "3. Comparison Group Size"}</label>
                <div className="line-note" style={{ margin: 0 }}>
                  {isZh ? (
                    <>当前套餐固定于同一份对比报告内并排核验 <strong>{activeOffer.rules.minimum} 件同品类样品</strong>。如需切换 2 件组或 3 件组，请在上方第 2 步重选。</>
                  ) : (
                    <>This package compares exactly <strong>{activeOffer.rules.minimum} comparable items</strong> in a single side-by-side report. Choose a 2-item or 3-item package in Step 2 above.</>
                  )}
                </div>
              </div>
            )}

            {service === "reference_match" && (
              <div className="field">
                <label htmlFor="calc-ref-qty">{isZh ? "3. 需对照封存标杆样的来料样品数量" : "3. Incoming Samples to Benchmark Against Retained Reference(s)"}</label>
                <input
                  id="calc-ref-qty"
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                />
                <div className="pub-qty-pills" role="group" aria-label={isZh ? "来料比对件数快捷选档" : "Reference match sample count"}>
                  {[1, 2, 3, 5].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`pub-qty-pill${qty === preset ? " active" : ""}`}
                      onClick={() => setQty(preset)}
                    >
                      {isZh ? `${preset} 件来料` : `${preset} ${preset === 1 ? "incoming sample" : "incoming samples"}`}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="pub-calc-result" aria-live="polite">
            <div>
              <div className="pub-eyebrow" style={{ color: "#93b8ff", marginBottom: 2 }}>
                {isZh ? "预估质检服务费（不含国内运费）" : "ESTIMATED INSPECTION FEE (EXCL. SHIPPING)"}
              </div>
              <div className="pub-calc-amount">{calcHeadline}</div>
              <div style={{ fontSize: 13, color: "#bfd4ef", fontWeight: 650 }}>{calcUnitText}</div>
            </div>

            <div className="pub-calc-breakdown">
              <div>
                <span>{isZh ? "已选检验模板" : "Selected Template"}</span>
                <strong>{activeOffer ? (isZh ? (activeOffer.title["zh-CN"] || activeOffer.title.en) : activeOffer.title.en) : "—"}</strong>
              </div>
              <div>
                <span>{isZh ? "包含检查点数量" : "Included Checkpoints"}</span>
                <strong>
                  {activeOffer
                    ? isZh
                      ? `${activeOffer.content.checks.length} 项 + 必拍工位原片`
                      : `${activeOffer.content.checks.length} checks + mandatory photos`
                    : "—"}
                </strong>
              </div>
              <div>
                <span>{isZh ? "检后寄递 / 超期仓储" : "Outbound Shipping / Storage"}</span>
                <strong>{isZh ? "发运前按实际重量与指令核价" : "Quoted later by actual parcel"}</strong>
              </div>
            </div>

            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#d5e4f7" }}>{calcSubnote}</p>

            <div>
              {isCustomInquiry ? (
                <Link className="button primary full" href={hrefFor(`/contact?topic=quote&qty=${qty}`)}>
                  {isZh ? "提交大批量专属人工报价申请 →" : "Request Custom Batch Quotation →"}
                </Link>
              ) : (
                <Link
                  className="button primary full"
                  href={activeOffer ? `/orders/new?offer=${activeOffer.offer_id}` : "/orders/new"}
                >
                  {isManualQuote
                    ? (isZh ? "创建草稿并申请人工核价 →" : "Create Draft & Request Staff Quote →")
                    : (isZh ? "使用此套餐创建订单 →" : "Continue With This Package →")}
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Complete Included vs Extra Cost Breakdown */}
      <section className="card pub-block" aria-labelledby="fee-separation-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{isZh ? "分阶段账目透明、无隐藏加价" : "NO HIDDEN SURPRISES"}</p>
            <h2 id="fee-separation-heading">{isZh ? "质检服务费 vs 检后运费与扩展仓储费用对照" : <>Inspection Fee vs. Shipping, Handling &amp; Storage</>}</h2>
            <p>{isZh ? "清晰了解订单全生命周期中各项费用在何时发生、如何计算。" : "Understand exactly when each charge applies across your order lifecycle."}</p>
          </div>
        </div>
        <div className="tablewrap pub-resp-desktop">
          <table className="tbl">
            <thead>
              <tr>
                <th>{isZh ? "费用类别" : "Fee Category"}</th>
                <th>{isZh ? "何时产生计费" : "When It Is Charged"}</th>
                <th>{isZh ? "计费依据" : "How It Is Calculated"}</th>
                <th>{isZh ? "包含交付内容" : "What Is Covered"}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>{isZh ? "1. 质检 / 对比基础服务费" : "1. Inspection / Comparison Fee"}</strong></td>
                <td>{isZh ? "确认委单时（仓内动工查验前）" : "At order confirmation (before bench work starts)"}</td>
                <td>{isZh ? "按公开目录中的单件、对比组或来料比对次核收" : "Per item, per 2–3 item set, or per reference match from active catalog"}</td>
                <td>{isZh ? "到仓点收、单件贴标、模板实测、量尺与瑕疵实图、QA 复核、在线定版报告及 PDF 与基础看护期" : <>Parcel check-in, barcode tagging, approved template checks, measurement &amp; defect photos, QA review, online report + PDF, and initial post-report custody window</>}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "2. 国内退回卖家快递费" : "2. Domestic Return to Seller"}</strong></td>
                <td>{isZh ? "仅当您查阅报告并正式指派“退回卖家”时" : "Only if you instruct a seller return after report review"}</td>
                <td>{isZh ? "按发往中国国内目的省份的包裹实重核价" : <>Quoted per outbound parcel by weight &amp; destination province in China</>}</td>
                <td>{isZh ? "授权退货件重新包装、中国国内快递面单、揽收核销与运单回传（不含卖家退货款担保）" : "Packing authorized return items, domestic courier label, handover scan, and waybill tracking (excludes seller merchandise refund)"}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "3. 发往指定国内集运仓快递费" : "3. Forwarding to Your Freight Forwarder"}</strong></td>
                <td>{isZh ? "仅当您提交发往国内集运仓出库指示时" : "Only when you request outbound dispatch in China"}</td>
                <td>{isZh ? "按出库外箱实重核收；支持选定合格品合箱发运" : "Quoted per outbound carton; eligible items can be consolidated per parcel"}</td>
                <td>{isZh ? "多件合格品归并合箱、外箱复磅并国内寄达您指定的中国国际货代集运点" : "Consolidation of your selected items, outer carton weighing, and domestic delivery to your designated Chinese forwarder warehouse"}</td>
              </tr>
              <tr>
                <td><strong>{isZh ? "4. 超期保管 / 标杆确认样档案保管" : "4. Extended Storage / Golden Sample Custody"}</strong></td>
                <td>{isZh ? "仅在随单赠送的免费决策/留存周期到期之后" : "Only after the included free decision window expires"}</td>
                <td>{isZh ? "续期前按每件实物对应保管费率清晰明示" : "Per-item policy schedule shown on each sample record before renewal"}</td>
                <td>{isZh ? "温控库位续存或专用防拆档案室中的标杆确认样长期密封保管" : "Continued climate-organized bin custody or sealed reference vault Golden Sample retention"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="pub-resp-mobile">
          {(isZh
            ? [
                [
                  "1. 质检 / 对比基础服务费",
                  "确认委单时（仓内动工查验前）",
                  "按公开目录中的单件、对比组或来料比对次核收",
                  "到仓点收、单件贴标、模板实测、量尺与瑕疵实图、QA 复核、在线定版报告及 PDF 与基础看护期",
                ],
                [
                  "2. 国内退回卖家快递费",
                  "仅当您查阅报告并正式指派“退回卖家”时",
                  "按发往中国国内目的省份的包裹实重核价",
                  "授权退货件重新包装、中国国内快递面单、揽收核销与运单回传（不含卖家退货款担保）",
                ],
                [
                  "3. 发往指定国内集运仓快递费",
                  "仅当您提交发往国内集运仓出库指示时",
                  "按出库外箱实重核收；支持选定合格品合箱发运",
                  "多件合格品归并合箱、外箱复磅并国内寄达您指定的中国国际货代集运点",
                ],
                [
                  "4. 超期保管 / 标杆确认样档案保管",
                  "仅在随单赠送的免费决策/留存周期到期之后",
                  "续期前按每件实物对应保管费率清晰明示",
                  "温控库位续存或专用防拆档案室中的标杆确认样长期密封保管",
                ],
              ]
            : [
                [
                  "1. Inspection / Comparison Fee",
                  "At order confirmation (before bench work starts)",
                  "Per item, per 2–3 item set, or per reference match from active catalog",
                  "Parcel check-in, barcode tagging, approved template checks, measurement & defect photos, QA review, online report + PDF, and initial post-report custody window",
                ],
                [
                  "2. Domestic Return to Seller",
                  "Only if you instruct a seller return after report review",
                  "Quoted per outbound parcel by weight & destination province in China",
                  "Packing authorized return items, domestic courier label, handover scan, and waybill tracking (excludes seller merchandise refund)",
                ],
                [
                  "3. Forwarding to Your Freight Forwarder",
                  "Only when you request outbound dispatch in China",
                  "Quoted per outbound carton; eligible items can be consolidated per parcel",
                  "Consolidation of your selected items, outer carton weighing, and domestic delivery to your designated Chinese forwarder warehouse",
                ],
                [
                  "4. Extended Storage / Golden Sample Custody",
                  "Only after the included free decision window expires",
                  "Per-item policy schedule shown on each sample record before renewal",
                  "Continued climate-organized bin custody or sealed reference vault Golden Sample retention",
                ],
              ]
          ).map(([cat, when, calc, cover]) => (
            <article className="pub-resp-mcard" key={cat}>
              <h3>{cat}</h3>
              <dl>
                <div><dt>{isZh ? "何时产生计费" : "When It Is Charged"}</dt><dd>{when}</dd></div>
                <div><dt>{isZh ? "计费依据" : "How It Is Calculated"}</dt><dd>{calc}</dd></div>
                <div><dt>{isZh ? "包含交付内容" : "What Is Covered"}</dt><dd>{cover}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      {/* 4B. Live Modular Inspection Schedule (Published Unified Pricing Projection) */}
      {data?.pricing_catalog && (() => {
        const pc = data.pricing_catalog as Record<string, any>;
        const curCode = String(pc.currency ?? "USD");
        const fmtMoney = (cents: number) =>
          new Intl.NumberFormat("en-US", { style: "currency", currency: curCode }).format(cents / 100);
        const sr = (pc.service_rules ?? {}) as Record<string, any>;
        return (
          <section className="card pub-block" aria-labelledby="modular-pricing-heading">
            <div className="card-head">
              <div>
                <p className="pub-eyebrow" style={{ marginBottom: 4 }}>
                  {isZh
                    ? `模块化加项与透明服务费率表 · v${String(pc.book_version)} · ${curCode}`
                    : `MODULAR INSPECTION ADD-ONS & SERVICE RATES · v${String(pc.book_version)} · ${curCode}`}
                </p>
                <h2 id="modular-pricing-heading">{isZh ? String(pc.name_zh || pc.name_en) : String(pc.name_en)}</h2>
                <p>{isZh ? String(pc.description_zh || pc.description_en || "") : String(pc.description_en || "")}</p>
              </div>
              {pc.business_approved === false && (
                <span className="tag yellow">
                  {isZh
                    ? "沙盒验收费率表 · 待正式营业批准（尚未对客开放正式售卖）"
                    : "Sandbox Verification Schedule · Commercial Approval Pending (Not for Production Sales)"}
                </span>
              )}
            </div>
            <div className="tablewrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{isZh ? "收费模块" : "Module"}</th>
                    <th>{isZh ? "覆盖选项" : "Options"}</th>
                    <th>{isZh ? "计费单位" : "Billing Unit"}</th>
                    <th>{pc.business_approved ? (isZh ? `已发布费率 (${curCode})` : `Published Rate (${curCode})`) : (isZh ? `沙盘参考费率 (${curCode})` : `Sandbox Reference Rate (${curCode})`)}</th>
                  </tr>
                </thead>
                <tbody>
                  {((pc.modules as Record<string, any>[]) ?? []).flatMap((m) =>
                    Object.entries((m.options as Record<string, any>) ?? {}).map(([optKey, opt]: [string, any]) => (
                      <tr key={`${String(m.code)}:${optKey}`}>
                        <td>
                          <strong>{String(m.code)} · {isZh ? String(m.name_zh || m.name_en) : String(m.name_en)}</strong>
                        </td>
                        <td>{isZh ? String(opt.label_zh || opt.label_en) : String(opt.label_en)}</td>
                        <td><code>{String(opt.billing_unit ?? m.billing_unit)}</code></td>
                        <td>
                          <strong>
                            {opt.manual_quote
                              ? (isZh ? "人工报价" : "Manual Quote")
                              : m.included_in_base
                                ? (isZh ? "包含于基础费" : "Included in Base")
                                : fmtMoney(Number(opt.unit_cents ?? 0))}
                          </strong>
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              {isZh ? (
                <>
                  样品对比：{sr.compare_2_items_cents != null ? fmtMoney(Number(sr.compare_2_items_cents)) : "—"}（2 件）/{" "}
                  {sr.compare_3_items_cents != null ? fmtMoney(Number(sr.compare_3_items_cents)) : "—"}（3 件）/{" "}
                  {sr.compare_extra_item_cents != null ? `+${fmtMoney(Number(sr.compare_extra_item_cents))}` : "—"} 每增一件 ·{" "}
                  标杆样封存 {sr.golden_archive_seal_cents != null ? fmtMoney(Number(sr.golden_archive_seal_cents)) : "—"}、{" "}
                  批量调出 {sr.golden_call_batch_cents != null ? fmtMoney(Number(sr.golden_call_batch_cents)) : "—"}、{" "}
                  来料比对 {sr.golden_match_item_cents != null ? fmtMoney(Number(sr.golden_match_item_cents)) : "—"}/件。
                </>
              ) : (
                <>
                  Sample Comparison: {sr.compare_2_items_cents != null ? fmtMoney(Number(sr.compare_2_items_cents)) : "—"} (2 items) /{" "}
                  {sr.compare_3_items_cents != null ? fmtMoney(Number(sr.compare_3_items_cents)) : "—"} (3 items) /{" "}
                  {sr.compare_extra_item_cents != null ? `+${fmtMoney(Number(sr.compare_extra_item_cents))}` : "—"} each additional item ·{" "}
                  Golden Sample Archival {sr.golden_archive_seal_cents != null ? fmtMoney(Number(sr.golden_archive_seal_cents)) : "—"},{" "}
                  Batch Retrieval {sr.golden_call_batch_cents != null ? fmtMoney(Number(sr.golden_call_batch_cents)) : "—"},{" "}
                  Matching {sr.golden_match_item_cents != null ? fmtMoney(Number(sr.golden_match_item_cents)) : "—"}/unit.
                </>
              )}
            </p>
            {Array.isArray(pc.disclosures) && pc.disclosures.length > 0 && (
              <ul className="small muted" style={{ marginTop: 6, paddingLeft: 18 }}>
                {(pc.disclosures as string[]).map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </section>
        );
      })()}

      {/* 5. Detailed Active Packages (Complete Template Schedule) */}
      <details className="card pub-block pub-schedule-drawer" id="full-schedule">
        <summary className="pub-schedule-summary">
          <div>
            <span className="pub-eyebrow" style={{ marginBottom: 2 }}>{isZh ? "完整模板收费明细表" : "COMPLETE TEMPLATE SCHEDULE"}</span>
            <strong>{isZh ? `已发布套餐与模板价格总览（当前活跃 ${offers.length} 项）` : <>Published Package &amp; Template Rate Directory ({offers.length} active offers)</>}</strong>
          </div>
          <span className="button sm">{isZh ? "展开 / 收起费率表" : "Toggle Rate Schedule"}</span>
        </summary>
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{isZh ? "套餐名称" : "Package Name"}</th>
                <th>{isZh ? "服务类别" : "Service Type"}</th>
                <th>{isZh ? "适用模板" : "Template Track"}</th>
                <th>{isZh ? "在线件数上限" : "Online Quantity"}</th>
                <th>{isZh ? "交付工期" : "Turnaround"}</th>
                <th>{isZh ? "活跃报价 (USD)" : "Active Rate (USD)"}</th>
                <th>{isZh ? "操作" : "Action"}</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => {
                const cents = o.rules.unit_cents ?? o.rules.package_cents ?? 0;
                const unit = o.rules.unit_cents != null
                  ? (isZh ? "/ 件" : "/ item")
                  : o.service === "reference_match"
                    ? (isZh ? "/ 次" : "/ match")
                    : (isZh ? "/ 组" : "/ set");
                const qtyRange =
                  o.rules.minimum === o.rules.maximum
                    ? `${o.rules.minimum}`
                    : `${o.rules.minimum}–${o.rules.maximum}`;
                return (
                  <tr key={o.offer_id}>
                    <td>
                      <strong>{isZh ? (o.title["zh-CN"] || o.title.en) : o.title.en}</strong>
                      <div className="small muted mono">{o.sku_code}</div>
                    </td>
                    <td>
                      {o.service === "inspection"
                        ? (isZh ? "实物商品质检" : "Product Inspection")
                        : o.service === "compare"
                        ? (isZh ? "供应商样品对比" : "Sample Comparison")
                        : (isZh ? "标杆确认样比对" : "Golden Sample Match")}
                    </td>
                    <td>{subcategoryLabel(o.content?.subcategory, isZh)}</td>
                    <td className="mono">{qtyRange}</td>
                    <td>{o.rules.business_days} {isZh ? "个工作日" : "bus. days"}</td>
                    <td className="mono">
                      <strong>{usd(cents)}</strong> <span className="small muted">{unit}</span>
                    </td>
                    <td>
                      <Link className="button sm primary" href={`/orders/new?offer=${o.offer_id}`}>
                        {isZh ? "下单" : "Order"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      {/* 6. Pricing & Billing FAQ */}
      <section className="card pub-block" aria-labelledby="pricing-faq-heading">
        <div className="card-head">
          <div>
            <p className="pub-eyebrow" style={{ marginBottom: 4 }}>{isZh ? "计费与报价常见问题" : "PRICING & BILLING FAQ"}</p>
            <h2 id="pricing-faq-heading">{isZh ? "常见收费与报价说明" : "Common Cost & Quotation Questions"}</h2>
          </div>
          <Link className="button sm" href={hrefFor("/faq")}>{isZh ? "全部 FAQ →" : "Full Buyer FAQ →"}</Link>
        </div>
        <div className="faq-group">
          <details className="faq-item" open>
            <summary>{isZh ? "为什么检验服务费与国内快递运费、超期仓储费拆分开收？" : "Why are inspection fees charged separately from domestic shipping and extended storage?"}</summary>
            <p>
              {isZh
                ? "在实物到仓复磅且您决定将不合格件退回卖家还是将合格品发往集运仓前，实际装箱重量与目的省份并不确定。拆开按实结算可以避免打包溢价。"
                : "Until physical items arrive, are weighed, and you decide whether to return defects to a supplier or forward stock to a freight forwarder, final carton weight and destination do not exist. Keeping fees separate avoids inflated flat shipping markups."}
            </p>
          </details>
          <details className="faq-item">
            <summary>{isZh ? "1–3 件首样查验与 10–100 件小批量库存全检如何计价？" : "How does pricing work for 1–3 prototype samples vs. 10–100 small-batch stock items?"}</summary>
            <p>
              {isZh ? (
                <>当前活跃服务目录中，<strong>实物商品质检</strong>在线 1 至 100 件均采用同一标准清单模板按实物单件计费（{summarizeRate(inspOffers, "/ 件", "按选定方案报价")}）。若需将 2 或 3 家不同工厂样品放入同框对照矩阵，请选<strong>供应商样品对比</strong>（{summarizeRate(compOffers, "/ 组", "按选定方案报价")}）。30–100+ 件小批如需要特别自定义检验项，可联系团队定制报价。</>
              ) : (
                <>Under the current active catalog, <strong>Product Inspection</strong> bills per physical item from 1 to 100 units online ({summarizeRate(inspOffers, "/ item")}) using the same approved template checklist. If you are comparing 2 or 3 candidate supplier prototypes side by side in one unified matrix, choose <strong>Sample Comparison</strong> ({summarizeRate(compOffers, "/ group")}). For 30–100+ unit stock batches requiring customized screening checkpoints, contact our team for a tailored batch scope.</>
              )}
            </p>
          </details>
          <details className="faq-item">
            <summary>{isZh ? "“预发布 / 演示参考价”标识代表什么含义？" : "What does the “Pre-launch / Demo Rate” catalog notice mean?"}</summary>
            <p>
              {isZh
                ? "页面展示价格实时同步自当前带预发布/演示参考标记的价目目录；任何在线下单在跳转到 Stripe 付款页前均由服务端按确切报价单锁定金额，绝不中途加价。"
                : "Displayed prices read live from the current catalog schedule carrying pre-launch / demo pricing flags. Whenever you place an order, QC Warehouse locks your verified service quote before Stripe checkout so fees never surprise you."}
            </p>
          </details>
          <details className="faq-item">
            <summary>{isZh ? "101–300 件范围订单怎样计费？" : "How are orders of 101–300 items billed?"}</summary>
            <p>
              {isZh
                ? "101–300 件订单会先以草稿单提交并暂不扣款，由仓库运营核实当前工位空闲与工期排班后给出正式人工确认报价。"
                : "Draft orders between 101 and 300 units save without payment first so our operations desk can confirm bench capacity and issue a manual quote before you pay."}
            </p>
          </details>
        </div>
      </section>

      {/* 7. Final CTA Banner */}
      <div className="pub-cta-banner">
        <div>
          <h2>{isZh ? "准备好锁定本次质检报价或咨询批量排期了吗？" : "Ready to Lock Your Inspection Quote or Estimate a Custom Batch?"}</h2>
          <p>{isZh ? "在上方挑选适用方案立即在线配置委托，或针对多箱中小批量货物联系运营团队核定人工工期与报价。" : "Select any active package above to configure your order online, or message our operations team if you are planning a multi-carton small-batch shipment."}</p>
        </div>
        <div className="pub-cta-actions">
          <Link className="button primary" href="/orders/new">{isZh ? "开始质检委托 →" : "Start an Inspection →"}</Link>
          <Link className="button pub-btn-ghost" href={hrefFor("/contact?topic=quote")}>{isZh ? "申请人工大单报价" : "Request Custom Batch Quote"}</Link>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   LEGAL & POLICIES (/legal, /legal/terms, /legal/privacy, etc.)
   ========================================================================== */
const LEGAL_TITLES: Record<string, { en: string; zh: string }> = {
  terms: { en: "Terms of Service", zh: "服务条款 (Terms of Service)" },
  privacy: { en: "Privacy Policy", zh: "隐私政策 (Privacy Policy)" },
  restricted_items: { en: "Restricted Items Policy", zh: "禁限寄规则与准入政策" },
  report_notice: { en: "Inspection Report Limitations", zh: "质检报告范围与免责声明" },
};

function PolicyText({ id, content, showContents }: { id: string; content: string; showContents: boolean }) {
  const introduction: string[] = [];
  const sections: Array<{ title: string; paragraphs: string[] }> = [];
  let paragraphs = introduction;

  for (const block of content.replace(/\r\n/g, "\n").trim().split(/\n[\t ]*\n+/)) {
    const heading = block.match(/^#{2,6}[\t ]+([^\n]+)(?:\n|$)/) ?? block.match(/^(\d+\.[\t ]+[^\n]+)$/);
    if (heading) {
      paragraphs = [];
      sections.push({ title: heading[1].trim(), paragraphs });
      const remainder = block.slice(heading[0].length);
      if (remainder) paragraphs.push(remainder);
    } else if (block) {
      paragraphs.push(block);
    }
  }

  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hasContents = showContents && sections.length > 1;
  const sectionId = (index: number) => `policy-${id}-section-${index + 1}`;
  const links = sections.map(({ title }, index) => (
    <li key={sectionId(index)}><a href={`#${sectionId(index)}`}>{title}</a></li>
  ));

  return (
    <div className={`policy-reading${hasContents ? " policy-reading-with-contents" : ""}`}>
      {hasContents && (
        <details className="policy-contents-mobile">
          <summary>{isZh ? "本页目录" : "On this page"}</summary>
          <nav aria-label={isZh ? "条款章节导航" : "Policy sections"}><ul>{links}</ul></nav>
        </details>
      )}
      <div className="policy-article">
        {introduction.map((paragraph, index) => <p className="policy-content" key={index}>{paragraph}</p>)}
        {sections.map(({ title, paragraphs }, index) => (
          <section className="policy-section" key={sectionId(index)} aria-labelledby={sectionId(index)}>
            <h3 id={sectionId(index)} tabIndex={-1}>{title}</h3>
            {paragraphs.map((paragraph, paragraphIndex) => <p className="policy-content" key={paragraphIndex}>{paragraph}</p>)}
          </section>
        ))}
      </div>
      {hasContents && (
        <nav className="policy-contents-desktop" aria-label={isZh ? "条款章节导航" : "Policy sections"}>
          <p>{isZh ? "本页目录" : "On this page"}</p>
          <ul>{links}</ul>
        </nav>
      )}
    </div>
  );
}

export function PublicLegal({ path }: { path: string }) {
  const { locale } = useLocale();
  const isZh = locale === "zh-CN";
  const hrefFor = (base: string) => localizePublicPath(base, locale);
  const kind = legalPages[path as keyof typeof legalPages];
  const query = useSearchParams();
  const versions = query.getAll("version");
  const suffix = versions.length ? "?" + new URLSearchParams(versions.map((v) => ["version", v])) : "";
  const { data, error, reload } = useLoad("/public/terms" + (kind ? "/" + kind + suffix : ""));
  const terms: Array<{ id: string; kind: string; version: string; effective_at: string; content_md: string }> =
    data?.terms ?? [];
  const titleObj = kind ? LEGAL_TITLES[kind] : undefined;
  const title = titleObj ? (isZh ? titleObj.zh : titleObj.en) : (isZh ? "服务条款、隐私与合规声明总览" : "Terms, Privacy & Inspection Policies");

  return (
    <>
      <div className="breadcrumb">
        <Link href={hrefFor("/")}>QC Warehouse</Link>
        <span aria-hidden="true">›</span>
        <strong>{title}</strong>
      </div>

      <section className="pub-page-hero" style={{ marginBottom: 20 }}>
        <div className="row between flexwrap" style={{ gap: 16 }}>
          <div>
            <p className="pub-eyebrow">
              {isZh ? "QC WAREHOUSE · 版本化法律条款与操作边界公示" : "QC WAREHOUSE · VERSIONED LEGAL & OPERATING POLICIES"}
            </p>
            <h1 style={{ marginBottom: 8 }}>{title}</h1>
            <p style={{ marginBottom: 0 }}>
              {isZh
                ? "每笔客户委单都会锁定下单当刻生效的精确政策版本号，确保历史条款、保管规则及报告范围边界全程可审计、不静默篡改。"
                : "Every customer order records the exact policy version accepted at checkout so historical terms and report scope notices remain auditable."}
            </p>
          </div>
          <Link className="button sm" href="/orders/new">
            {isZh ? "开始下单质检 →" : "Start an Inspection →"}
          </Link>
        </div>
      </section>

      <Tabs
        path={hrefFor(path)}
        links={[
          [hrefFor("/legal"), isZh ? "全部条款" : "All Policies"],
          ...Object.entries(legalPages).map(([href, key]): [string, string] => [
            hrefFor(href),
            isZh ? LEGAL_TITLES[key].zh : LEGAL_TITLES[key].en,
          ]),
        ]}
      />

      {kind && versions.length > 0 && (
        <p style={{ marginBottom: 14 }}>
          <Link href={hrefFor(path)}>{isZh ? "← 返回当前生效最新版本" : "← View current active version"}</Link>
        </p>
      )}
      {error && (
        <div className="card">
          <ErrorBlock error={error} />
          <button type="button" className="button sm" onClick={reload}>{isZh ? "重试加载" : "Try again"}</button>
        </div>
      )}
      {!data && !error && <p role="status" className="muted">{isZh ? "正在加载已发布条款文本…" : "Loading published policies…"}</p>}
      {data && terms.length === 0 && <Empty>{isZh ? "暂无已发布生效的条款版本。" : "No published policy version is available."}</Empty>}
      {terms.map((t) => (
        <Panel
          key={t.id}
          title={LEGAL_TITLES[t.kind] ? (isZh ? LEGAL_TITLES[t.kind].zh : LEGAL_TITLES[t.kind].en) : t.kind}
          badge={<span className="tag blue">{isZh ? `版本 ${t.version}` : `Version ${t.version}`}</span>}
        >
          <p className="muted small">
            {isZh ? (
              <>版本 {t.version} · 生效时间 <time dateTime={t.effective_at}>{t.effective_at.slice(0, 10)} UTC</time></>
            ) : (
              <>Version {t.version} · Effective <time dateTime={t.effective_at}>{t.effective_at.slice(0, 10)} UTC</time></>
            )}
          </p>
          <PolicyText id={t.id} content={t.content_md} showContents={Boolean(kind)} />
        </Panel>
      ))}
    </>
  );
}
