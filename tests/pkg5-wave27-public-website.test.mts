import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

const target = process.env.TEST_DATABASE_URL;
assert(target, "Set TEST_DATABASE_URL to an isolated qcw_test database.");
const targetUrl = URL.parse(target);
assert(targetUrl && ["postgres:", "postgresql:"].includes(targetUrl.protocol), "Expected a PostgreSQL test URL.");
const databaseName = decodeURIComponent(targetUrl.pathname.slice(1));
assert(/^qcw_test(?:-[a-z0-9-]+)?$/.test(databaseName), "Use a dedicated qcw_test database.");
const appDatabase = process.env.DATABASE_URL ? URL.parse(process.env.DATABASE_URL) : null;
assert.notEqual(
  databaseName,
  appDatabase && decodeURIComponent(appDatabase.pathname.slice(1)),
  "The test database must be separate from the application database.",
);

process.env.DATABASE_URL = target;
process.env.QCW_DEMO = "1";
process.env.NODE_ENV = "test";
const appOrigin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;

const { handle } = await import("../packages/core/http");
const { pool } = await import("../packages/db");
const { GET: goneGet } = await import("../app/gone/route");
const robots = (await import("../app/robots")).default;
const sitemap = (await import("../app/sitemap")).default;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class Client {
  private jar = new Map<string, string>();
  async fetch(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    expected = 200,
    key = randomUUID(),
  ) {
    const csrf = this.jar.get("qcw_csrf");
    const req = new Request(`${appOrigin}/api/v1${path}`, {
      method,
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(method !== "GET"
          ? {
              origin: appOrigin,
              "Idempotency-Key": key,
              ...(csrf ? { "x-csrf-token": csrf } : {}),
              "content-type": "application/json",
            }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const res = await handle(req, path.split("?")[0]);
    for (const c of res.headers.getSetCookie()) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) this.jar.set(m[1], m[2]);
    }
    const data = await res.json();
    assert.equal(
      res.status,
      expected,
      `${method} ${path} -> expected ${expected}, got ${res.status}: ${JSON.stringify(data)}`,
    );
    return data;
  }
  async loginWithMfa(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    const out = await this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
    const cookie = this.jar.get("session");
    if (cookie) {
      await pool.query("update sessions set mfa_at = now() where token_hash = $1", [sha256(cookie)]);
    }
    return out;
  }
}

before(async () => {
  const actual = await pool.query<{ name: string }>("select current_database() name");
  assert.equal(actual.rows[0].name, databaseName);
  await pool.query("drop schema if exists public cascade; create schema public;");
  for (const args of [
    ["--env-file-if-exists=.env", "scripts/migrate.mjs"],
    ["--env-file-if-exists=.env", "--import", "tsx", "scripts/demo.ts"],
  ]) {
    execFileSync(process.execPath, args, { env: process.env, stdio: "pipe" });
  }
  await pool.query("delete from verification_challenges where target_email::text = any($1::text[])", [
    ["receiving", "inspector", "reviewer", "finance", "admin", "customer"].map((n) => `${n}@qcw.test`),
  ]);
});

after(async () => {
  await pool.end();
});

test("1. Non-realtime public contact config hides disabled/unverified WhatsApp and enforces admin MFA/constraints", async () => {
  const visitor = new Client();
  const customer = new Client();
  await customer.loginWithMfa("customer@qcw.test");
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");

  // Default public config has WhatsApp disabled & omitted
  const pub0 = await visitor.fetch("/public/contact-config");
  assert.equal(pub0.whatsapp_enabled, false);
  assert.equal(pub0.whatsapp_number, null);
  assert.equal(pub0.whatsapp_url, null);
  assert.equal(pub0.widget_enabled, true);

  // DB CHECK constraint rejects whatsapp_enabled=true when unverified
  await assert.rejects(
    () =>
      pool.query(
        "update public_contact_settings set whatsapp_enabled=true, whatsapp_verified=false where id='default'",
      ),
    /public_contact_whatsapp_verified_check/i,
  );

  // RBAC: customer cannot access admin contact endpoints
  await customer.fetch("/staff/admin/public-contact-config", undefined, "GET", 403);
  await customer.fetch(
    "/staff/admin/public-contact-config",
    {
      support_email: "hijack@evil.example",
      whatsapp_enabled: false,
      whatsapp_verified: false,
      business_hours_zh: "24/7",
      business_hours_en: "24/7",
      response_sla_zh: "now",
      response_sla_en: "now",
      widget_enabled: true,
      widget_notice_zh: "x",
      widget_notice_en: "x",
    },
    "PUT",
    403,
  );

  // API Zod guard rejects non-E.164 WhatsApp number (whitespace) & unverified WhatsApp
  await admin.fetch(
    "/staff/admin/public-contact-config",
    {
      support_email: "support@qcwarehouse.com",
      whatsapp_enabled: true,
      whatsapp_verified: true,
      whatsapp_number: "+86 13800138000",
      whatsapp_url: "https://wa.me/8613800138000",
      business_hours_zh: "周一至周六 09:00–18:00",
      business_hours_en: "Mon–Sat 09:00–18:00",
      response_sla_zh: "1 个工作日内回复",
      response_sla_en: "Within 1 business day",
      widget_enabled: true,
      widget_notice_zh: "非实时客服通道",
      widget_notice_en: "Async support channel",
    },
    "PUT",
    422,
  );

  // API Zod guard rejects enabling unverified/non-HTTPS WhatsApp
  await admin.fetch(
    "/staff/admin/public-contact-config",
    {
      support_email: "support@qcwarehouse.com",
      whatsapp_enabled: true,
      whatsapp_verified: false,
      whatsapp_number: "+8613800000000",
      whatsapp_url: "https://wa.me/8613800000000",
      business_hours_zh: "周一至周六 09:00–18:00",
      business_hours_en: "Mon–Sat 09:00–18:00",
      response_sla_zh: "1 个工作日内回复",
      response_sla_en: "Within 1 business day",
      widget_enabled: true,
      widget_notice_zh: "非实时客服通道",
      widget_notice_en: "Async support channel",
    },
    "PUT",
    422,
  );

  // Enabling verified WhatsApp exposes it cleanly, then disabling hides it again
  await admin.fetch(
    "/staff/admin/public-contact-config",
    {
      support_email: "desk@qcwarehouse.com",
      whatsapp_enabled: true,
      whatsapp_verified: true,
      whatsapp_number: "+8613800138000",
      whatsapp_url: "https://wa.me/8613800138000",
      business_hours_zh: "周一至周六 09:00–18:00（北京时间）",
      business_hours_en: "Mon–Sat 09:00–18:00 (Asia/Shanghai)",
      response_sla_zh: "1 个工作日内人工处理",
      response_sla_en: "Within 1 business day",
      widget_enabled: true,
      widget_notice_zh: "非实时客服通道",
      widget_notice_en: "Async support channel",
    },
    "PUT",
    200,
  );
  const pub1 = await visitor.fetch("/public/contact-config");
  assert.equal(pub1.support_email, "desk@qcwarehouse.com");
  assert.equal(pub1.whatsapp_enabled, true);
  assert.equal(pub1.whatsapp_url, "https://wa.me/8613800138000");

  await admin.fetch(
    "/staff/admin/public-contact-config",
    {
      support_email: "support@qcwarehouse.com",
      whatsapp_enabled: false,
      whatsapp_verified: true,
      whatsapp_number: "+8613800138000",
      whatsapp_url: "https://wa.me/8613800138000",
      business_hours_zh: "周一至周六 09:00–18:00",
      business_hours_en: "Mon–Sat 09:00–18:00",
      response_sla_zh: "1 个工作日内人工处理",
      response_sla_en: "Within 1 business day",
      widget_enabled: true,
      widget_notice_zh: "非实时客服通道",
      widget_notice_en: "Async support channel",
    },
    "PUT",
    200,
  );
  const pub2 = await visitor.fetch("/public/contact-config");
  assert.equal(pub2.whatsapp_enabled, false);
  assert.equal(pub2.whatsapp_number, null);
  assert.equal(pub2.whatsapp_url, null);
});

test("2. Retired 301/410 route registry, /gone HTTP 410 response, XSS safety, robots & sitemap boundaries", async () => {
  const visitor = new Client();
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");

  // Seeded retired routes resolve cleanly for both EN & /zh prefixes
  const en410 = await visitor.fetch("/public/route-status?path=/services/aql");
  assert.equal(en410.found, true);
  assert.equal(en410.http_status, 410);
  assert.equal(en410.replacement_path, "/catalog");

  const zh410 = await visitor.fetch("/public/route-status?path=/zh/services/aql");
  assert.equal(zh410.found, true);
  assert.equal(zh410.http_status, 410);
  assert.equal(zh410.locale, "zh-CN");
  assert.equal(zh410.replacement_path, "/zh/catalog");

  const zh301 = await visitor.fetch("/public/route-status?path=/zh/legacy-pricing");
  assert.equal(zh301.found, true);
  assert.equal(zh301.http_status, 301);
  assert.equal(zh301.redirect_to, "/zh/pricing");

  // Invalid open-redirect query rejected
  await visitor.fetch("/public/route-status?path=//evil.com", undefined, "GET", 422);
  await visitor.fetch("/public/route-status?path=/foo%5Cbar", undefined, "GET", 422);

  // Admin write endpoint & DB CHECK constraint reject external/protocol-relative redirect_to (P2-1)
  await admin.fetch(
    "/staff/admin/public-retired-routes",
    {
      path: "/evil-redirect-test",
      http_status: 301,
      redirect_to: "//evil.com",
      title_zh: "非法跳转拦截测试",
      title_en: "Invalid Redirect Guard Test",
      reason_zh: "应被网关阻止",
      reason_en: "Should be rejected",
      replacement_path: "/catalog",
    },
    "POST",
    422,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO public_retired_routes (path, http_status, redirect_to, title_zh, title_en, reason_zh, reason_en, replacement_path)
       VALUES ('/db-evil-test', 301, '//evil.com', 'test', 'test', 'test', 'test', '/catalog')`,
    ),
    (err: unknown) => (err as { code?: string }).code === "23514",
  );

  // Admin upsert & delete
  await admin.fetch(
    "/staff/admin/public-retired-routes",
    {
      path: "/old-faq",
      http_status: 301,
      redirect_to: "/faq",
      title_zh: "旧 FAQ 已迁移",
      title_en: "Legacy FAQ Moved",
      reason_zh: "FAQ 入口已统一迁至 /faq",
      reason_en: "FAQ moved to /faq",
      replacement_path: "/faq",
    },
    "POST",
    200,
  );
  const oldFaq = await visitor.fetch("/public/route-status?path=/zh/old-faq");
  assert.equal(oldFaq.http_status, 301);
  assert.equal(oldFaq.redirect_to, "/zh/faq");
  await admin.fetch("/staff/admin/public-retired-routes", { path: "/old-faq" }, "DELETE", 200);

  // Real Next.js /gone Route Handler returns HTTP 410 + noindex + official wordmark + XSS-safe escaped query
  const goneResEn = await goneGet(new NextRequest(`${appOrigin}/gone?from=/services/aql`));
  assert.equal(goneResEn.status, 410);
  assert.equal(goneResEn.headers.get("x-robots-tag"), "noindex, nofollow");
  const htmlEn = await goneResEn.text();
  assert(htmlEn.includes("/brand/qc-warehouse-wordmark.png"));
  assert(htmlEn.includes("Permanently Discontinued"));

  const goneResZh = await goneGet(new NextRequest(`${appOrigin}/gone?from=/zh/services/aql`));
  assert.equal(goneResZh.status, 410);
  const htmlZh = await goneResZh.text();
  assert(htmlZh.includes("整厂驻场 AQL 验厂入口已永久下线"));
  assert(htmlZh.includes('href="/zh/catalog"'));

  const goneXss = await goneGet(new NextRequest(`${appOrigin}/gone?from=%2F%3Cscript%3Ealert(1)%3C%2Fscript%3E`));
  assert.equal(goneXss.status, 410);
  const htmlXss = await goneXss.text();
  assert(!htmlXss.includes("<script>alert(1)</script>"));
  assert(htmlXss.includes("&lt;script&gt;"));

  // Robots & Sitemap boundary validation
  const r = robots();
  const rRule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  const disallowList = rRule.disallow ?? [];
  for (const priv of ["/admin", "/wh", "/account", "/orders", "/login", "/api/", "/gone"]) {
    assert(disallowList.includes(priv), `robots.txt must disallow ${priv}`);
  }
  const s = sitemap();
  const urls = s.map((e) => e.url);
  assert(urls.includes(appOrigin));
  assert(urls.includes(`${appOrigin}/zh`));
  assert(urls.includes(`${appOrigin}/zh/pricing`));
  assert(urls.includes(`${appOrigin}/zh/contact`));
  assert(!urls.some((u) => u.includes("/admin") || u.includes("/login") || u.includes("/gone")));

  // Public /catalog never leaks L1-L5 internal cost/complexity tables
  const cat = await visitor.fetch("/catalog");
  assert(Array.isArray(cat.offers));
  const serialized = JSON.stringify(cat.pricing_catalog ?? {});
  assert(!serialized.includes("complexity_rates"));
  assert(!serialized.includes("labor_hourly_rate_cents"));
});
