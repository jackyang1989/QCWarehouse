import { NextRequest, NextResponse } from "next/server";
import { BRAND_ASSETS, BRAND_NAME } from "../../packages/core/brand";
import { resolvePublicRetiredRoute } from "../../packages/core/public-website";
import { pool } from "../../packages/db";

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function GET(req: NextRequest) {
  const fromParam = req.nextUrl.searchParams.get("from") || "/gone";
  const safeFrom = fromParam.startsWith("/") && !fromParam.startsWith("//") ? fromParam : "/gone";
  const isZh = safeFrom === "/zh" || safeFrom.startsWith("/zh/");

  const retired = await resolvePublicRetiredRoute(pool, safeFrom).catch(() => null);
  const replacementPath = retired?.replacement_path ?? (isZh ? "/zh/catalog" : "/catalog");
  const title = isZh
    ? (retired?.title_zh ?? "该公开页面或服务入口已永久下线（HTTP 410）")
    : (retired?.title_en ?? "This Page Has Been Permanently Removed (HTTP 410)");
  const reason = isZh
    ? (retired?.reason_zh ?? "该历史页面或产品形态已从 QC Warehouse 正式公开目录中移除；现有中国独立收货质检、样品横向对比与确认样比对服务均继续正常运行。")
    : (retired?.reason_en ?? "This historical page or service listing has been permanently removed from QC Warehouse's public catalog. All core China receiving, inspection, comparison, and Golden Sample workflows remain active.");

  const homeHref = isZh ? "/zh" : "/";
  const pricingHref = isZh ? "/zh/pricing" : "/pricing";
  const contactHref = isZh ? "/zh/contact" : "/contact";

  const html = `<!doctype html>
<html lang="${isZh ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(title)} | ${escapeHtml(BRAND_NAME)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:32px 16px;}
    .card{max-width:740px;margin:24px auto;background:#fff;border:1px solid #dbe3ee;border-radius:14px;padding:32px;box-shadow:0 12px 30px rgba(15,23,42,.06);}
    .eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;color:#b91c1c;margin:16px 0 8px;}
    h1{margin:0 0 12px;font-size:26px;line-height:1.25;}
    p{line-height:1.6;color:#334155;margin:0 0 14px;}
    .meta{font-size:13px;color:#64748b;background:#f1f5f9;padding:10px 14px;border-radius:8px;margin-bottom:20px;}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px;}
    .btn{display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid #cbd5e1;text-decoration:none;font-weight:600;font-size:14px;color:#0f172a;background:#fff;}
    .btn.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff;}
  </style>
</head>
<body>
  <main class="card">
    <a href="${escapeHtml(homeHref)}" aria-label="${escapeHtml(BRAND_NAME)}">
      <img src="${escapeHtml(BRAND_ASSETS.wordmark)}" alt="${escapeHtml(BRAND_NAME)}" width="160" height="36" />
    </a>
    <p class="eyebrow">HTTP 410 GONE · PERMANENTLY RETIRED ROUTE</p>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(reason)}</p>
    <div class="meta">
      ${isZh ? "已请求路径" : "Requested URL"}: <code>${escapeHtml(safeFrom)}</code>
    </div>
    <div class="actions">
      <a class="btn primary" href="${escapeHtml(replacementPath)}">${isZh ? "查看推荐替代服务目录" : "Browse Current Services"}</a>
      <a class="btn" href="${escapeHtml(pricingHref)}">${isZh ? "收费标准" : "Pricing"}</a>
      <a class="btn" href="${escapeHtml(contactHref)}">${isZh ? "联系客服" : "Contact Support"}</a>
      <a class="btn" href="${escapeHtml(homeHref)}">${isZh ? "返回官网首页" : "Return Home"}</a>
      <a class="btn" href="/orders">${isZh ? "客户工作台" : "Customer Workspace"}</a>
    </div>
  </main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 410,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    },
  });
}
