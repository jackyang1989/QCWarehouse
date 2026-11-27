import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

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
const {
  FIXED_I18N_RESOURCES,
  formatCurrencyFact,
  localizeErrorCode,
  t,
} = await import("../packages/core/i18n/messages");
const {
  assertBusinessFactsPreserved,
  buildLocaleSafeOAuthReturnPath,
  resolveAccountLocalePreferences,
  validateFixedResourceBundle,
} = await import("../packages/core/locale-contract");
const { resolvePortalRoute } = await import("../packages/core/portal-routes");
const {
  PUBLIC_ROUTE_SEO_KEYS,
  PUBLIC_ROUTE_SEO_ZH_KEYS,
  metadataForPath,
} = await import("../app/public-seo");
const { default: sitemap } = await import("../app/sitemap");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class Client {
  private jar = new Map<string, string>();
  getCookie(name: string) {
    return this.jar.get(name);
  }
  async fetch(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    expected = 200,
    extraHeaders: Record<string, string> = {},
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
        ...extraHeaders,
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
  async login(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
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

test("PKG-3 Wave 17 (TASK-190): Full-site i18n platform, preferences, /zh SSR & SEO, dynamic translation workflow & admin governance", async (suite) => {
  await suite.test("I01: fixed i18n resource parity, placeholders, SEO route pairing, CI script & currency preservation", () => {
    const bundleCheck = validateFixedResourceBundle(FIXED_I18N_RESOURCES);
    assert.equal(bundleCheck.ok, true, JSON.stringify(bundleCheck));
    assert.equal(bundleCheck.missingKeys.length, 0);
    assert.equal(bundleCheck.placeholderMismatches.length, 0);

    assert.deepEqual(PUBLIC_ROUTE_SEO_ZH_KEYS, PUBLIC_ROUTE_SEO_KEYS);

    const ciOut = execFileSync(process.execPath, ["--import", "tsx", "scripts/check-i18n.mjs"], {
      env: process.env,
      encoding: "utf8",
    });
    assert.match(ciOut, /i18n CI check OK:/);

    assert.equal(t("en-US", "nav.public.services"), "Services");
    assert.equal(t("zh-CN", "nav.public.services"), "服务项目");
    assert.equal(localizeErrorCode("SOD_VIOLATION", "zh-CN"), "职责分离规则禁止由本人审批自己提交的内容。");
    assert.equal(localizeErrorCode("LOCALE_NOT_ENABLED", "en-US"), "This language is not enabled yet.");

    const formatted = formatCurrencyFact(1290, "USD", "zh-CN");
    assert.match(formatted, /12\.90/);
    assert.doesNotMatch(formatted, /CN¥|RMB|￥/);
  });

  await suite.test("I02: three independent preferences, staff default zh-CN ignoring English Accept-Language & future locale isolation", async () => {
    const customer = new Client();
    await customer.login("customer@qcw.test");
    const admin = new Client();
    await admin.login("admin@qcw.test");
    const inspector = new Client();
    await inspector.login("inspector@qcw.test");
    const reviewer = new Client();
    await reviewer.login("reviewer@qcw.test");

    // Public locales endpoint exposes registered status honestly
    const pubLocales = await customer.fetch("/public/locales", undefined, "GET", 200);
    assert.equal(pubLocales.locales.length, 4);
    const fr = pubLocales.locales.find((l: any) => l.code === "fr-FR");
    assert.equal(fr.enabled, false);
    assert.equal(fr.selectable, false);

    // Staff defaults to zh-CN even when Accept-Language is en-US
    const staffPrefsDefault = await admin.fetch("/me/locale-preferences", undefined, "GET", 200, {
      "accept-language": "en-US,en;q=0.9",
    });
    assert.equal(staffPrefsDefault.ui_locale, "zh-CN");
    assert.equal(staffPrefsDefault.notification_locale, "zh-CN");
    assert.equal(staffPrefsDefault.report_locale, "en-US");

    // Customer defaults to en-US when unset, and honors Accept-Language when ui_locale is not saved yet
    const custPrefsDefault = await customer.fetch("/me/locale-preferences", undefined, "GET", 200);
    assert.equal(custPrefsDefault.ui_locale, "en-US");
    assert.equal(custPrefsDefault.notification_locale, "en-US");
    assert.equal(custPrefsDefault.report_locale, "en-US");

    const custAcceptZh = await customer.fetch("/me/locale-preferences", undefined, "GET", 200, {
      "accept-language": "zh-CN,zh;q=0.9",
    });
    assert.equal(custAcceptZh.ui_locale, "zh-CN");

    // Switching ui_locale via PATCH /me/locale-preferences leaves notification_locale & report_locale untouched
    const custSwitched = await customer.fetch(
      "/me/locale-preferences",
      { ui_locale: "zh-CN" },
      "PATCH",
      200,
    );
    assert.equal(custSwitched.ui_locale, "zh-CN");
    assert.equal(custSwitched.notification_locale, "en-US");
    assert.equal(custSwitched.report_locale, "en-US");
    assert.equal(customer.getCookie("qcw_locale"), "zh-CN");

    // Update notification_locale & report_locale independently
    const custNotifReport = await customer.fetch(
      "/me/locale-preferences",
      { notification_locale: "zh-CN", report_locale: "both" },
      "PATCH",
      200,
    );
    assert.equal(custNotifReport.ui_locale, "zh-CN");
    assert.equal(custNotifReport.notification_locale, "zh-CN");
    assert.equal(custNotifReport.report_locale, "both");

    // Public anonymous / signed-in switcher updates cookie & ui_locale without altering notification/report prefs
    const anon = new Client();
    const anonSet = await anon.fetch("/public/locale", { locale: "zh-CN" }, "POST", 200);
    assert.equal(anonSet.locale, "zh-CN");
    assert.equal(anon.getCookie("qcw_locale"), "zh-CN");

    // Disabled future locales must be rejected everywhere (422 LOCALE_NOT_ENABLED)
    for (const badCode of ["fr-FR", "es-ES"]) {
      const pubFail = await anon.fetch("/public/locale", { locale: badCode }, "POST", 422);
      assert.equal(pubFail.error.code, "LOCALE_NOT_ENABLED");
      const prefFail = await customer.fetch("/me/locale-preferences", { ui_locale: badCode }, "PATCH", 422);
      assert.equal(prefFail.error.code, "LOCALE_NOT_ENABLED");
    }

    // Verify staff vs customer surface resolution contract directly
    assert.equal(
      resolveAccountLocalePreferences({
        surface: "staff",
        acceptLanguageHeader: "en-US,en;q=0.9",
      }).uiLocale,
      "zh-CN",
    );
    assert.equal(
      resolveAccountLocalePreferences({
        surface: "public",
        explicitRouteLocale: "zh-CN",
        manualPreference: "en-US",
      }).uiLocale,
      "zh-CN",
    );

    // Silence unused var lint while verifying non-translator baseline logins work
    assert(inspector && reviewer);
  });

  await suite.test("I03: /zh public SSR routing, private /zh/* rejection, canonical + hreflang SEO, sitemap & safe OAuth return", () => {
    assert.deepEqual(resolvePortalRoute("/zh"), { area: "public", view: "public-home" });
    assert.deepEqual(resolvePortalRoute("/zh/catalog"), { area: "public", view: "catalog" });
    assert.deepEqual(resolvePortalRoute("/zh/services/compare"), { area: "public", view: "catalog" });
    assert.deepEqual(resolvePortalRoute("/zh/legal/terms"), { area: "public", view: "legal" });

    // Private workspaces and login/onboarding auth pages must NOT mount under /zh
    for (const badPath of ["/zh/admin", "/zh/orders", "/zh/wh", "/zh/login", "/zh/staff/login"]) {
      assert.equal(resolvePortalRoute(badPath), undefined, `${badPath} must stay unroutable`);
    }

    const enMeta = metadataForPath("/catalog", true, resolvePortalRoute("/catalog"));
    const zhMeta = metadataForPath("/zh/catalog", true, resolvePortalRoute("/zh/catalog"));
    assert.match(String(enMeta.alternates?.canonical), /\/catalog$/);
    assert.match(String(zhMeta.alternates?.canonical), /\/zh\/catalog$/);
    assert.equal(enMeta.openGraph?.locale, "en_US");
    assert.equal(zhMeta.openGraph?.locale, "zh_CN");
    assert.match(String(zhMeta.alternates?.languages?.["en-US"]), /\/catalog$/);
    assert.match(String(zhMeta.alternates?.languages?.["zh-CN"]), /\/zh\/catalog$/);
    assert.match(String(zhMeta.alternates?.languages?.["x-default"]), /\/catalog$/);

    const adminMeta = metadataForPath("/admin", false, resolvePortalRoute("/admin"));
    assert.deepEqual(adminMeta.robots, { index: false, follow: false });

    const sm = sitemap();
    assert.equal(sm.length, PUBLIC_ROUTE_SEO_KEYS.length * 2);
    assert(sm.some((e) => e.url.endsWith("/zh/pricing") && e.alternates?.languages?.["en-US"]?.endsWith("/pricing")));
    for (const priv of ["/admin", "/orders", "/wh", "/login", "/staff/login"]) {
      assert.equal(
        sm.some((e) => e.url.includes(priv)),
        false,
        `sitemap must never include private route ${priv}`,
      );
    }

    assert.equal(
      buildLocaleSafeOAuthReturnPath("/orders?tab=active", "customer", [], "zh-CN"),
      "/orders?tab=active&locale=zh-CN",
    );
    assert.equal(
      buildLocaleSafeOAuthReturnPath("https://evil.example/phish", "customer", [], "zh-CN"),
      null,
    );
  });

  await suite.test("I04: dynamic translation workflow, SoD, human lock vs AI, stale invalidation & immutable snapshot trigger", async () => {
    const admin = new Client();
    await admin.login("admin@qcw.test");
    const reviewer = new Client();
    await reviewer.login("reviewer@qcw.test");
    const inspector = new Client();
    await inspector.login("inspector@qcw.test");
    const receiving = new Client();
    await receiving.login("receiving@qcw.test");
    const finance = new Client();
    await finance.login("finance@qcw.test");

    const entityId = randomUUID();
    const templateTextV1 = "Measure garment chest width 2.5 cm below armhole seam.";

    // Warehouse receiving & finance staff lack i18n translator/admin privilege -> 403
    for (const deniedClient of [receiving, finance]) {
      const denied = await deniedClient.fetch(
        "/staff/admin/i18n/translations",
        {
          entity_type: "inspection_template_item",
          entity_id: entityId,
          field_key: "instruction",
          locale: "zh-CN",
          source_locale: "en-US",
          source_revision: 1,
          source_text: templateTextV1,
          translated_text: "从腋下缝线下移 2.5 cm 平铺量测胸宽。",
          translator_kind: "human",
          submit_for_review: true,
        },
        "POST",
        403,
      );
      assert.equal(denied.error.code, "FORBIDDEN");
    }

    // Reviewer creates human draft submitted for review
    const created = await reviewer.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "inspection_template_item",
        entity_id: entityId,
        field_key: "instruction",
        locale: "zh-CN",
        source_locale: "en-US",
        source_revision: 1,
        source_text: templateTextV1,
        translated_text: "从腋下缝线下移 2.5 cm 平铺量测胸宽。",
        translator_kind: "human",
        submit_for_review: true,
      },
      "POST",
      201,
    );
    const transId = created.translation.id as string;
    assert.equal(created.translation.status, "pending_review");

    // Author cannot approve their own translation (SoD)
    const sodFail = await reviewer.fetch(
      `/staff/admin/i18n/translations/${transId}/decide`,
      { decision: "approve" },
      "POST",
      403,
    );
    assert.equal(sodFail.error.code, "SOD_VIOLATION");

    // Template admin (inspector@qcw.test) can draft/author translations, but lacks reviewer/super_admin privilege to decide or freeze snapshots -> 403
    const decideDenied = await inspector.fetch(
      `/staff/admin/i18n/translations/${transId}/decide`,
      { decision: "approve" },
      "POST",
      403,
    );
    assert.equal(decideDenied.error.code, "FORBIDDEN");

    const snapDenied = await inspector.fetch(
      "/staff/admin/i18n/snapshots",
      {
        entity_type: "inspection_template_item",
        entity_id: entityId,
        entity_version: 1,
        locale: "zh-CN",
        field_keys: ["instruction"],
        source_texts: { instruction: templateTextV1 },
      },
      "POST",
      403,
    );
    assert.equal(snapDenied.error.code, "FORBIDDEN");

    // Super admin approves & publishes + locks human translation
    const published = await admin.fetch(
      `/staff/admin/i18n/translations/${transId}/decide`,
      { decision: "publish" },
      "POST",
      200,
    );
    assert.equal(published.translation.status, "published");

    const locked = await admin.fetch(
      `/staff/admin/i18n/translations/${transId}/decide`,
      { decision: "lock_human" },
      "POST",
      200,
    );
    assert.equal(locked.translation.human_locked, true);

    // AI translation candidate cannot overwrite human-locked field -> 409 HUMAN_TRANSLATION_LOCKED
    const aiBlocked = await admin.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "inspection_template_item",
        entity_id: entityId,
        field_key: "instruction",
        locale: "zh-CN",
        source_locale: "en-US",
        source_revision: 1,
        source_text: templateTextV1,
        translated_text: "AI 覆盖尝试",
        translator_kind: "ai",
        submit_for_review: false,
      },
      "POST",
      409,
    );
    assert.equal(aiBlocked.error.code, "HUMAN_TRANSLATION_LOCKED");

    // Source text change marks published translation as stale; snapshotting while stale fails 409
    const staleRes = await admin.fetch(
      "/staff/admin/i18n/translations/mark-stale",
      {
        entity_type: "inspection_template_item",
        entity_id: entityId,
        field_key: "instruction",
        new_source_text: "Measure garment chest width 3.0 cm below armhole seam.",
      },
      "POST",
      200,
    );
    assert.equal(staleRes.marked_stale, 1);

    const staleSnapFail = await reviewer.fetch(
      "/staff/admin/i18n/snapshots",
      {
        entity_type: "inspection_template_item",
        entity_id: entityId,
        entity_version: 2,
        locale: "zh-CN",
        field_keys: ["instruction"],
        source_texts: { instruction: "Measure garment chest width 3.0 cm below armhole seam." },
      },
      "POST",
      409,
    );
    assert.equal(staleSnapFail.error.code, "LOCALE_TRANSLATION_UNAPPROVED");

    // Stale record cannot be approved directly without submitting a revised draft
    const staleApproveFail = await admin.fetch(
      `/staff/admin/i18n/translations/${transId}/decide`,
      { decision: "approve" },
      "POST",
      409,
    );
    assert.equal(staleApproveFail.error.code, "RECORD_CONFLICT");

    // Human updates translation for v2, admin approves, reviewer freezes immutable snapshot
    const v2 = await reviewer.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "inspection_template_item",
        entity_id: entityId,
        field_key: "instruction",
        locale: "zh-CN",
        source_locale: "en-US",
        source_revision: 2,
        source_text: "Measure garment chest width 3.0 cm below armhole seam.",
        translated_text: "从腋下缝线下移 3.0 cm 平铺量测胸宽。",
        translator_kind: "human",
        submit_for_review: true,
      },
      "POST",
      201,
    );
    await admin.fetch(
      `/staff/admin/i18n/translations/${v2.translation.id}/decide`,
      { decision: "publish" },
      "POST",
      200,
    );

    const snapCreated = await reviewer.fetch(
      "/staff/admin/i18n/snapshots",
      {
        entity_type: "inspection_template_item",
        entity_id: entityId,
        entity_version: 2,
        locale: "zh-CN",
        field_keys: ["instruction"],
        source_texts: { instruction: "Measure garment chest width 3.0 cm below armhole seam." },
      },
      "POST",
      201,
    );
    const snapshotId = snapCreated.snapshot.id as string;
    assert.equal(snapCreated.snapshot.frozen_fields.instruction, "从腋下缝线下移 3.0 cm 平铺量测胸宽。");

    // DB trigger enforces immutability on i18n_historical_snapshots (UPDATE and DELETE rejected)
    await assert.rejects(
      () =>
        pool.query("update i18n_historical_snapshots set frozen_fields = '{}'::jsonb where id = $1", [
          snapshotId,
        ]),
      /I18N_SNAPSHOT_IMMUTABLE/,
    );
    await assert.rejects(
      () => pool.query("delete from i18n_historical_snapshots where id = $1", [snapshotId]),
      /I18N_SNAPSHOT_IMMUTABLE/,
    );
  });

  await suite.test("I05: admin i18n overview, RBAC, core lock, incomplete future enable block & business fact guard", async () => {
    const admin = new Client();
    await admin.login("admin@qcw.test");
    const customer = new Client();
    await customer.login("customer@qcw.test");
    const receiving = new Client();
    await receiving.login("receiving@qcw.test");

    // RBAC: customer and receiving staff cannot access admin i18n overview
    for (const actorClient of [customer, receiving]) {
      const denied = await actorClient.fetch("/staff/admin/i18n/overview", undefined, "GET", 403);
      assert.equal(denied.error.code, "FORBIDDEN");
    }

    const overview = await admin.fetch("/staff/admin/i18n/overview", undefined, "GET", 200);
    assert.equal(overview.fixed_resources.total_keys, FIXED_I18N_RESOURCES.length);
    assert.equal(overview.fixed_resources.ci_valid, true);
    const dc = overview.dynamic_completeness;
    assert.equal(
      dc.published_count + dc.approved_count + dc.pending_or_draft_count + dc.stale_or_failed_count,
      dc.total_latest,
    );

    // Without recent MFA, toggle fails 403 STAFF_REAUTH_REQUIRED
    const sessionCookie = admin.getCookie("session");
    assert(sessionCookie);
    const sessionHash = sha256(sessionCookie);
    await pool.query("update sessions set mfa_at = null where token_hash = $1", [sessionHash]);
    const mfaMissing = await admin.fetch(
      "/staff/admin/i18n/locales/fr-FR/status",
      { enabled: true },
      "POST",
      403,
    );
    assert.equal(mfaMissing.error.code, "STAFF_REAUTH_REQUIRED");

    // With fresh MFA verified: core lock & incomplete future bundle guard trigger 422
    await pool.query("update sessions set mfa_at = now() where token_hash = $1", [sessionHash]);
    const coreLock = await admin.fetch(
      "/staff/admin/i18n/locales/zh-CN/status",
      { enabled: false },
      "POST",
      422,
    );
    assert.equal(coreLock.error.code, "CORE_LOCALE_LOCKED");

    const incompleteFuture = await admin.fetch(
      "/staff/admin/i18n/locales/fr-FR/status",
      { enabled: true },
      "POST",
      422,
    );
    assert.equal(incompleteFuture.error.code, "LOCALE_BUNDLE_INCOMPLETE");

    const malformedPercent = await admin.fetch(
      "/staff/admin/i18n/locales/%E0%A4%A/status",
      { enabled: true },
      "POST",
      422,
    );
    assert.equal(malformedPercent.error.code, "INVALID_REQUEST");

    // Business fact preservation guard blocks tampering of SKU/waybill/currency/raw address
    const validFacts = {
      sku_code: "APPAREL-TOP-001",
      waybill_no: "SF1400998877",
      address_raw: "广东省东莞市虎门镇XX路88号B栋",
      currency_code: "USD",
      amount_cents: 1800,
    };
    assertBusinessFactsPreserved(validFacts, { ...validFacts });
    assert.throws(
      () =>
        assertBusinessFactsPreserved(validFacts, {
          ...validFacts,
          address_raw: "No.88 XX Road, Dongguan",
        }),
      (err: any) => err?.code === "NON_TRANSLATABLE_FACT_MUTATION" && err?.status === 409,
    );
  });
});
