import type { Metadata } from "next";
import { BRAND_ASSETS, BRAND_NAME } from "../packages/core/brand";
import { orderSections, type PortalRoute } from "../packages/core/portal-routes";
import { staffLoginCopy } from "./staff-login-copy";

export function publicSiteOrigin(): string {
  try {
    return new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
  } catch {
    return "http://localhost:3000";
  }
}

type RouteSeoConfig = {
  title: string;
  description: string;
  ogImage?: string;
};

const PUBLIC_ROUTE_SEO: Record<string, RouteSeoConfig> = {
  "/": {
    title: `Independent Product Inspection in China | ${BRAND_NAME}`,
    description:
      "Know what arrived, what was checked, and what to do next — before paying for international shipping. Individual sample & small-batch inspection, 2–3 supplier sample comparison, and Golden Sample matching in China.",
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/catalog": {
    title: "Inspection Services in China — Individual Sample, Small-Batch & Comparison",
    description:
      `Compare ${BRAND_NAME} services in China: individual sample & small-batch Product Inspection (1–100+ items), side-by-side Sample Comparison (2–3 items), and Golden Sample Matching with measurements, photos & documented findings.`,
    ogImage: "/brand/inspection-hero.webp",
  },
  "/services/inspection": {
    title: "Product Inspection in China — Individual Sample & Small-Batch Inspection",
    description:
      "Individual physical product inspection at our China receiving center. Every item gets a unique traceable ID, flat-lay measurements with tape photos, workmanship checks, and per-item routing.",
    ogImage: "/marketing/service-item-inspection.webp",
  },
  "/services/compare": {
    title: "Supplier Sample Comparison Service in China (2–3 Samples)",
    description:
      "Compare 2 or 3 candidate supplier samples side by side under identical lighting and measurement methods in China before committing to inventory.",
    ogImage: "/marketing/service-three-samples.webp",
  },
  "/services/reference": {
    title: "Golden Sample & Reference Matching Service in China",
    description:
      "Retain your approved Golden Sample in secure reference sample storage in China and inspect new supplier samples or restock units directly against your physical benchmark.",
    ogImage: "/marketing/service-golden-matching.webp",
  },
  "/categories": {
    title: "Supported Product Categories — Apparel Inspection Live Today",
    description:
      `See what products ${BRAND_NAME} inspects today in China: approved templates for Tops & Knitwear, Leggings & Bottoms, Sports Bras & Activewear, plus planned and restricted category policies.`,
    ogImage: "/brand/inspection-hero.webp",
  },
  "/how-it-works": {
    title: "How It Works — China Receiving, Item Inspection & Post-QC Routing",
    description:
      "Step-by-step chain of custody from your Chinese supplier shipment to parcel check-in, piece-by-piece inspection, reviewed inspection report, and return, storage, or freight-forwarder dispatch.",
    ogImage: "/marketing/workflow-create-order-ui.webp",
  },
  "/report-guide": {
    title: "Sample Inspection Report — Measurements, Photos & Documented Findings",
    description:
      `Explore an interactive demonstration ${BRAND_NAME} reviewed inspection report featuring metric tape photos, re-measurement logs, UI defect bounding boxes, side-by-side sample comparison, and scope boundaries.`,
    ogImage: "/marketing/report-sample-a-chest-measure.webp",
  },
  "/pricing": {
    title: "Transparent Product Inspection Pricing & Fee Estimator",
    description:
      "View live per-item inspection, sample comparison, and Golden Sample matching rates in USD. Estimate your exact inspection fee and understand post-inspection domestic shipping and storage charges.",
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/faq": {
    title: "FAQ & Buyer Help Center — China Product Inspection Questions",
    description:
      "Answers for international buyers: multi-supplier parcels, 30–50 item piece-by-piece checks, inspection vs comparison, seller returns, forwarder handoff, turnaround times, and inspection scope boundaries.",
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/contact": {
    title: "Contact Inspection Support & Request Custom Scope",
    description:
      `Ask ${BRAND_NAME} about apparel inspection scope, custom small-batch quantities (100+ items), category availability, or pre-order feasibility in China.`,
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/legal": {
    title: "Terms, Privacy & Inspection Policies",
    description:
      `Review ${BRAND_NAME} Terms of Service, Privacy Policy, Restricted Items Policy, and Inspection Report Limitations.`,
  },
  "/legal/terms": {
    title: "Terms of Service",
    description:
      `Versioned Terms of Service governing ${BRAND_NAME} physical receiving, product inspection, custody, domestic dispatch, and billing.`,
  },
  "/legal/privacy": {
    title: "Privacy Policy",
    description:
      `How ${BRAND_NAME} collects, protects, and retains customer account data, supplier shipping records, and private inspection evidence.`,
  },
  "/legal/restricted-items": {
    title: "Restricted & Prohibited Items Policy",
    description:
      `Items prohibited or restricted from delivery to the ${BRAND_NAME} China receiving center, including hazardous, regulated, and unapproved categories.`,
  },
  "/legal/report-notice": {
    title: "Inspection Report Scope & Limitations Notice",
    description:
      `Important boundaries of ${BRAND_NAME} physical inspection reports: commissioned visual and dimensional observations vs laboratory testing, certification, and bulk factory audits.`,
  },
};

const PORTAL_ROUTE_TITLES: Record<string, string> = {
  "/login": "Customer Sign In",
  "/signup": "Customer Sign In",
  "/onboarding": "Complete Account Setup",
  "/account/recovery": "Account Recovery",
  "/staff/login": staffLoginCopy(null).title,
  "/account": "Overview · My Workspace",
  "/orders": "Inspection Orders · My Workspace",
  "/orders/new": "Create an Inspection · My Workspace",
  "/parcels": "Parcels · My Workspace",
  "/items": "Warehouse Items · My Workspace",
  "/reports": "Inspection Reports · My Workspace",
  "/actions": "Action Required · My Workspace",
  "/account/billing": "Billing · My Workspace",
  "/billing": "Billing · My Workspace",
  "/account/notifications": "Notifications · My Workspace",
  "/notifications": "Notifications · My Workspace",
  "/account/security": "Sign-in Methods & Security · My Workspace",
  "/support": "Support · My Workspace",
  "/wh": "仓库总览 · 仓库作业中心",
  "/wh/scan": "扫码查询 · 仓库作业中心",
  "/wh/intake": "收货入库 · 仓库作业中心",
  "/wh/packages": "包裹台账 · 仓库作业中心",
  "/wh/samples": "样品建档 · 仓库作业中心",
  "/wh/storage": "库位移转 · 仓库作业中心",
  "/wh/stocktakes": "库存盘点 · 仓库作业中心",
  "/wh/inspection": "检查队列 · 仓库作业中心",
  "/wh/execute": "执行检查 · 仓库作业中心",
  "/wh/sync": "同步队列 · 仓库作业中心",
  "/wh/review": "报告复核 · 仓库作业中心",
  "/wh/dispatch": "出库待办 · 仓库作业中心",
  "/wh/logistics": "物流监控 · 仓库作业中心",
  "/admin": "运营总览 · 运营管理后台",
  "/admin/orders": "全部订单 · 运营管理后台",
  "/admin/customers": "客户档案 · 运营管理后台",
  "/admin/tickets": "客户工单 · 运营管理后台",
  "/admin/inspections": "质检与报告 · 运营管理后台",
  "/admin/dispositions": "处置与报价 · 运营管理后台",
  "/admin/refunds": "退款审批 · 运营管理后台",
  "/admin/payments": "支付流水 · 运营管理后台",
  "/admin/finance": "财务分析 · 运营管理后台",
  "/admin/logistics": "物流监控 · 运营管理后台",
  "/admin/incidents": "库存事故 · 运营管理后台",
  "/admin/catalog": "品类与服务 · 运营管理后台",
  "/admin/categories": "品类与服务 · 运营管理后台",
  "/admin/templates": "检查模板 · 运营管理后台",
  "/admin/settings": "仓址与模板 · 运营管理后台",
  "/admin/storage/locations": "库位管理 · 运营管理后台",
  "/admin/shipping-rates": "运费费率 · 运营管理后台",
  "/admin/config": "业务配置 · 运营管理后台",
  "/admin/legal": "条款管理 · 运营管理后台",
  "/admin/users": "员工权限 · 运营管理后台",
  "/admin/audit": "审计日志 · 运营管理后台",
  "/admin/operations": "后台任务 · 运营管理后台",
  "/admin/integrations": "第三方集成中心 · 运营管理后台",
  "/admin/integrations/payments": "支付渠道管理 · 运营管理后台",
  "/admin/integrations/ocr": "OCR 文档识别配置 · 运营管理后台",
  "/admin/integrations/logistics": "物流接入 · 运营管理后台",
  "/admin/integrations/email": "邮件服务配置 · 运营管理后台",
};

export function portalTitleForRoute(path: string, route?: PortalRoute): string {
  const exact = PORTAL_ROUTE_TITLES[path];
  if (exact) return exact;
  if (route) {
    if (route.view === "order") {
      return `${route.id}${route.section ? ` · ${orderSections[route.section]}` : ""} · My Workspace`;
    }
    if (route.view === "report") {
      return `Inspection Report ${route.id}${route.version ? ` v${route.version}` : ""} · My Workspace`;
    }
    if (route.view === "customer-case") return "Support Case · My Workspace";
    if (route.view === "order-quote") return `Fulfillment Quote ${route.id} · My Workspace`;
    if (route.view === "order-shipment") return `Shipment Details ${route.id} · My Workspace`;
    if (route.view === "parcel") return "Parcel & Tracking Details · My Workspace";
    if (route.view === "shipment") return "Shipment Tracking · My Workspace";
    if (route.view === "demo") return "Demo Checkout · My Workspace";
    if (route.view === "task") return "质检工作台 · 仓库作业中心";
    if (route.view === "warehouse-package") return `包裹 ${route.id} · 仓库作业中心`;
    if (route.view === "warehouse-item") return `实物 ${route.id} · 仓库作业中心`;
    if (route.view === "dispatch-batch") return "发运批次 · 仓库作业中心";
    if (route.view === "staff-report") return "报告版本复核 · 仓库作业中心";
    if (route.view === "staff-order") return `订单 ${route.id} · 运营管理后台`;
    if (route.view === "admin-customer") return "客户详情 · 运营管理后台";
    if (route.view === "staff-ticket") return "工单详情 · 运营管理后台";
    if (route.view === "admin-payment") return "支付流水详情 · 运营管理后台";
    if (route.view === "admin-refund") return "退款审批详情 · 运营管理后台";
    if (route.view === "admin-incident") return "库存事故详情 · 运营管理后台";
    if (route.view === "admin-disposal") return "特殊处置单 · 运营管理后台";
    if (route.view === "admin-inspection-task") return "质检任务监督 · 运营管理后台";
    if (route.area === "customer") return "My Workspace";
    if (route.area === "warehouse") return "仓库作业中心";
    if (route.area === "admin") return "运营管理后台";
  }
  return BRAND_NAME;
}

export function metadataForPath(path: string, isPublicMarketing: boolean, route?: PortalRoute, next?: string): Metadata {
  const origin = publicSiteOrigin();
  const seo = PUBLIC_ROUTE_SEO[path];

  if (!isPublicMarketing || !seo) {
    return {
      title: route?.view === "staff-login" ? staffLoginCopy(next).title : portalTitleForRoute(path, route),
      robots: { index: false, follow: false },
    };
  }

  const canonicalUrl = path === "/" ? origin : `${origin}${path}`;
  const ogImage = seo.ogImage ?? "/marketing/home-inspection-studio.webp";

  return {
    title: path === "/" ? { absolute: seo.title } : seo.title,
    description: seo.description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      type: "website",
      siteName: BRAND_NAME,
      locale: "en_US",
      url: canonicalUrl,
      title: path === "/" ? seo.title : `${seo.title} | ${BRAND_NAME}`,
      description: seo.description,
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 675,
          alt: seo.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: path === "/" ? seo.title : `${seo.title} | ${BRAND_NAME}`,
      description: seo.description,
      images: [ogImage],
    },
  };
}

export function homeJsonLd() {
  const origin = publicSiteOrigin();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: BRAND_NAME,
        url: origin,
        logo: `${origin}${BRAND_ASSETS.appIcon512}`,
        description:
          "China-based independent product inspection, supplier sample comparison, and post-inspection item handling service for international commercial buyers.",
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          url: `${origin}/contact`,
          availableLanguage: ["English", "Chinese"],
        },
      },
      {
        "@type": "Service",
        "@id": `${origin}/#service`,
        name: "Independent Product Inspection & Sample Comparison in China",
        provider: { "@id": `${origin}/#organization` },
        serviceType: [
          "Piece-by-Piece Product Inspection",
          "Supplier Sample Comparison",
          "Golden Sample Reference Matching",
        ],
        areaServed: "Worldwide",
        url: `${origin}/catalog`,
      },
    ],
  };
}
