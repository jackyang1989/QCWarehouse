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
const { resolvePortalRoute, canOpenStaffPage, staffTabs } = await import("../packages/core/portal-routes");

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

let pricingBookId = "";

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

test("1. Idempotent pricing seed, T26 RBAC, SoD publish & immutable version freeze trigger", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const receiving = new Client();
  await receiving.loginWithMfa("receiving@qcw.test");
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test"); // template_admin + inspector

  // Initialize knowledge catalog first
  await tplAdmin.fetch("/staff/admin/knowledge/seed-init", {}, "POST", 200);

  // T26: receiver & template_admin cannot initialize or modify pricing!
  await receiving.fetch("/staff/admin/pricing/seed-init", {}, "POST", 403);
  await tplAdmin.fetch("/staff/admin/pricing/seed-init", {}, "POST", 403);

  const seed1 = await finance.fetch("/staff/admin/pricing/seed-init", {}, "POST", 200);
  assert.equal(seed1.inserted_counts.pricing_books, 1);

  const booksRes = await finance.fetch("/staff/admin/pricing/books");
  assert.equal(booksRes.books.length, 1);
  const seeded = booksRes.books[0];
  pricingBookId = seeded.id;
  assert.equal(seeded.status, "draft");
  assert.equal(seeded.auto_volume_discount_enabled, false);
  assert.equal(seeded.publication_scope, "sandbox_acceptance");

  // Finance edits description -> second seed-init preserves edit
  await finance.fetch("/staff/admin/pricing/books", {
    ...seeded,
    description_zh: "财务已校验的 §43.2 初始定价草稿",
  });
  const seed2 = await finance.fetch("/staff/admin/pricing/seed-init", {}, "POST", 200);
  assert.equal(seed2.inserted_counts.pricing_books, 0);
  const detailAfterSeed = await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}`);
  assert.equal(detailAfterSeed.book.description_zh, "财务已校验的 §43.2 初始定价草稿");

  // Auto volume discount toggle requires explicit justification
  const volErr = await finance.fetch(
    "/staff/admin/pricing/books",
    { ...detailAfterSeed.book, auto_volume_discount_enabled: true, volume_discount_justification: "" },
    "POST",
    422,
  );
  assert.equal(volErr.error.code, "VOLUME_DISCOUNT_JUSTIFICATION_REQUIRED");

  // Finance submits -> finance cannot self-publish (403); admin self-authored cannot self-publish -> reviewer publishes v1
  await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/submit`, { note: "Submit v1 sandbox pricing" });
  await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/publish`, {}, "POST", 403);

  const pubV1 = await reviewer.fetch(`/staff/admin/pricing/books/${pricingBookId}/publish`, {
    note: "Approve §43.2 sandbox pricing v1",
  });
  assert.equal(pubV1.version.version, 1);
  assert.equal(pubV1.version.business_approved, false);

  // Also test self-authored book SoD rejection by super_admin
  const cloned = await admin.fetch(
    `/staff/admin/pricing/books/${pricingBookId}/clone`,
    { code: "sod_test_book", name_zh: "SoD 测试", name_en: "SoD Test" },
    "POST",
    201,
  );
  await admin.fetch(`/staff/admin/pricing/books/${cloned.id}/submit`, {});
  const sodErr = await admin.fetch(`/staff/admin/pricing/books/${cloned.id}/publish`, {}, "POST", 403);
  assert.equal(sodErr.error.code, "SELF_REVIEW_FORBIDDEN");

  // Immutable DB trigger check on pricing_book_versions
  await assert.rejects(
    async () => {
      await pool.query(
        "update pricing_book_versions set effective_snapshot = '{}'::jsonb where id = $1::uuid",
        [pubV1.version.id],
      );
    },
    /immutable/i,
  );
});

test("2. Exact §43.2 four worked examples, compiled tasks, rounding, exclusions & G01 category gates", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test");

  // Publish apparel product types & modules so formal quoting is active for apparel while bags_general remains closed!
  const unpubPts = (await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type")).items
    .filter((p: Record<string, any>) => p.category_slug === "apparel" && p.status !== "published")
    .map((p: Record<string, any>) => p.id);
  if (unpubPts.length > 0) {
    await reviewer.fetch("/staff/admin/knowledge/entities/product_type/batch-publish", {
      ids: unpubPts,
      public_sellable: true,
      note: "Publish apparel product types for pricing consumer tests",
    });
  }

  // Verify §43.2 worked examples via /staff/admin/pricing/books/:id/simulate
  const simRes = await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/simulate`, { run_worked_examples: true });
  assert.equal(simRes.worked_examples.length, 4);
  for (const ex of simRes.worked_examples) {
    assert.equal(ex.matched, true, `Worked example ${ex.key} must match ${ex.expected_cents}`);
  }

  // Run all 4 §43.2 worked examples directly through live public/customer POST /pricing/quote!
  const cust = new Client();
  await cust.loginWithMfa("customer@qcw.test");

  // Example 1: 1pc L1 T-Shirt + Base(M01=$5) + 5-pt POM(M02=$12) = $17 (1700 cents)
  const q1 = await cust.fetch(
    "/pricing/quote",
    {
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 1,
      modules: [
        { module_code: "M01" }, // passed M01 must deduplicate cleanly without charging twice!
        { module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 1 },
      ],
      quote_kind: "formal",
    },
    "POST",
    201,
  );
  assert.equal(q1.total_cents, 1700);
  assert.equal(q1.line_items.length, 2);
  assert.equal(q1.compiled_task_plan.base_task_count, 1);

  // Example 2: 50pc L1 Base ($5×50) + 10pc 5-pt POM ($12×10) + 5pc Fabric ($7×5) = $405 (40500 cents)
  const q2 = await cust.fetch(
    "/pricing/quote",
    {
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 50,
      modules: [
        { module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 10 },
        { module_code: "M04", option_code: "standard", coverage_mode: "exact_count", coverage_qty: 5 },
      ],
      quote_kind: "formal",
    },
    "POST",
    201,
  );
  assert.equal(q2.total_cents, 40500);
  assert.deepEqual(
    q2.compiled_task_plan.module_coverages.map((c: Record<string, any>) => [c.module_code, c.task_count]),
    [
      ["M01", 50],
      ["M02", 10],
      ["M04", 5],
    ],
  );

  // Example 3: 3pc L1 Compare (3×(5+12+7+5) + $35 = $122 -> 12200 cents)
  const q3 = await cust.fetch(
    "/pricing/quote",
    {
      service_type: "compare",
      product_type_code: "t_shirt",
      base_qty: 3,
      modules: [
        { module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 3 },
        { module_code: "M04", option_code: "standard", coverage_mode: "exact_count", coverage_qty: 3 },
        { module_code: "M03", option_code: "standard", coverage_mode: "exact_count", coverage_qty: 3 },
      ],
      quote_kind: "formal",
    },
    "POST",
    201,
  );
  assert.equal(q3.total_cents, 12200);
  assert.equal(q3.compiled_task_plan.comparison_group_size, 3);

  // Example 4: Same Golden Sample matching 5pc L1 (Base+5pt): $10 batch call ONCE + 5×($8+$5+$12) = $135 (13500 cents)
  const q4 = await cust.fetch(
    "/pricing/quote",
    {
      service_type: "reference_match",
      product_type_code: "t_shirt",
      base_qty: 5,
      golden_sample_ids: ["GS-RED-JACKET-01", "GS-RED-JACKET-01"], // duplicate IDs deduplicate -> 1 unique call batch!
      modules: [{ module_code: "M02", option_code: "points_5", coverage_mode: "exact_count", coverage_qty: 5 }],
      quote_kind: "formal",
    },
    "POST",
    201,
  );
  assert.equal(q4.total_cents, 13500);
  assert.equal(q4.compiled_task_plan.golden_sample_call_batches, 1);
  assert.equal(q4.compiled_task_plan.golden_sample_match_count, 5);

  // Percentage rounding (7 * 20% = 1.4 -> ceil = 2 with explicit disclosure)
  const pctQuote = await cust.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "t_shirt",
    base_qty: 7,
    modules: [{ module_code: "M02", option_code: "points_5", coverage_mode: "percentage", coverage_pct: 20 }],
    quote_kind: "simulation",
  });
  assert.equal(pctQuote.total_cents, 7 * 500 + 2 * 1200);
  assert(pctQuote.disclosures.some((d: string) => d.includes("ceil") && d.includes("2")));

  // Tracksuit set billed per_set without double charging components (L3 = $12/set)
  const setQuote = await cust.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "tracksuit_set",
    base_qty: 2,
    modules: [],
    quote_kind: "simulation",
  });
  assert.equal(setQuote.total_cents, 2400);
  assert.equal(setQuote.compiled_task_plan.billing_unit, "set");
  assert.deepEqual(setQuote.compiled_task_plan.included_components, ["top", "pants"]);

  // L5 / M11 manual quote requirement & M05 destructive authorization guard
  const l5Quote = await cust.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "wedding_dress",
    base_qty: 1,
    modules: [{ module_code: "M11" }],
    quote_kind: "simulation",
  });
  assert.equal(l5Quote.manual_quote_required, true);

  await cust.fetch(
    "/pricing/quote",
    {
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 1,
      modules: [{ module_code: "M05", option_code: "fabric_gsm_destructive" }],
      customer_authorized_destructive: false,
      quote_kind: "simulation",
    },
    "POST",
    422,
  );

  // Conflicting M02 options (points_5 + points_8) -> 422 MODULE_CONFLICT
  const conflictErr = await cust.fetch(
    "/pricing/quote",
    {
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 1,
      modules: [
        { module_code: "M02", option_code: "points_5", coverage_qty: 1 },
        { module_code: "M02", option_code: "points_8", coverage_qty: 1 },
      ],
      quote_kind: "simulation",
    },
    "POST",
    422,
  );
  assert.equal(conflictErr.error.code, "MODULE_CONFLICT");

  // Volume discount attempt rejected while disabled by default
  const volDisabled = await cust.fetch(
    "/pricing/quote",
    {
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 100,
      modules: [],
      apply_volume_discount: true,
      quote_kind: "simulation",
    },
    "POST",
    422,
  );
  assert.equal(volDisabled.error.code, "VOLUME_DISCOUNT_DISABLED");

  // AT-15 / G01: Closed non-apparel bags_general rejected with 422 CATEGORY_NOT_ACTIVE
  const bagsErr = await cust.fetch(
    "/pricing/quote",
    {
      service_type: "inspection",
      product_type_code: "bags_general",
      base_qty: 1,
      modules: [],
      quote_kind: "simulation",
    },
    "POST",
    422,
  );
  assert.equal(bagsErr.error.code, "CATEGORY_NOT_ACTIVE");
});

test("3. T01 PRICE_CHANGED, T30 historical lock protection, batch-adjust preview, promo conflict, public catalog sync & RBAC", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const cust = new Client();
  await cust.loginWithMfa("customer@qcw.test");
  const anon = new Client();

  // Verify public GET /catalog exposes pricing_catalog WITHOUT internal L1-L5 rates
  const cat1 = await anon.fetch("/catalog");
  assert(cat1.pricing_catalog);
  assert.equal(cat1.pricing_catalog.book_version, 1);
  assert.equal(cat1.pricing_catalog.complexity_rates, undefined, "Public pricing catalog must hide internal L1-L5 rates");
  assert.equal(cat1.pricing_catalog.customer_overrides, undefined);

  // Anonymous visitor simulation works; anonymous formal quote is blocked (401)
  const anonSim = await anon.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "t_shirt",
    base_qty: 2,
    modules: [],
    quote_kind: "simulation",
  });
  assert.equal(anonSim.total_cents, 1000);
  await anon.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "t_shirt", base_qty: 2, modules: [], quote_kind: "formal" },
    "POST",
    401,
  );

  // Customer creates TWO formal quotes on v1: locks Q1, leaves Q2 open
  const q1 = await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, modules: [{ module_code: "M02", option_code: "points_5" }], quote_kind: "formal" },
    "POST",
    201,
  );
  const q2 = await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, modules: [{ module_code: "M02", option_code: "points_5" }], quote_kind: "formal" },
    "POST",
    201,
  );
  const lockedQ1 = await cust.fetch(`/pricing/quotes/${q1.quote_id}/verify-lock`, {});
  assert.equal(lockedQ1.status, "locked");
  assert.equal(lockedQ1.total_cents, 1700);

  // Finance runs dry_run batch-adjust (+100 cents on complexity_rates -> L1 becomes $6) & applies it + sets minimum_order_cents + promos
  const dry = await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/batch-adjust`, {
    scope: "complexity_rates",
    operation: "fixed_cents",
    delta_value: 100,
    dry_run: true,
  });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.diffs.find((d: Record<string, any>) => d.target === "complexity:L1").after_cents, 600);

  await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/batch-adjust`, {
    scope: "complexity_rates",
    operation: "fixed_cents",
    delta_value: 100,
    dry_run: false,
  });

  // Reviewer approves v2 (L1 is now $6, M02 is $12)
  const bookV2Detail = await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}`);
  await finance.fetch("/staff/admin/pricing/books", {
    ...bookV2Detail.book,
    minimum_order_cents: 2500, // Test itemized minimum_order_topup
    discount_rules: [
      { code: "PROMO_A", label_zh: "首单立减", label_en: "First Order $5 Off", kind: "fixed_cents", value: 500, stackable: false, min_subtotal_cents: 1000, active: true },
      { code: "PROMO_B", label_zh: "九折券", label_en: "10% Off", kind: "percent_off", value: 10, stackable: false, min_subtotal_cents: 1000, active: true },
    ],
  });
  await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/submit`, { note: "Submit v2" });
  await reviewer.fetch(`/staff/admin/pricing/books/${pricingBookId}/publish`, { note: "Publish v2 L1=$6" });

  // T30 / 32-T: Already locked Q1 MUST remain 1700 cents!
  const q1After = await cust.fetch(`/pricing/quotes/${q1.quote_id}`);
  assert.equal(q1After.total_cents, 1700);
  assert.equal(q1After.status, "locked");

  // T01: Open Q2 from stale v1 fails verify-lock with 409 PRICE_CHANGED!
  const staleErr = await cust.fetch(`/pricing/quotes/${q2.quote_id}/verify-lock`, {}, "POST", 409);
  assert.equal(staleErr.error.code, "PRICE_CHANGED");

  // Verify non-stackable PROMO_CONFLICT + transparent minimum_order_topup line item on v2
  const promoConflict = await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "t_shirt", base_qty: 4, modules: [], promo_codes: ["PROMO_A", "PROMO_B"], quote_kind: "simulation" },
    "POST",
    422,
  );
  assert.equal(promoConflict.error.code, "PROMO_CONFLICT");

  const minTopupQuote = await cust.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "t_shirt",
    base_qty: 2, // 2 × $6 = $12 < $25 minimum_order_cents
    modules: [],
    quote_kind: "simulation",
  });
  assert.equal(minTopupQuote.subtotal_cents, 1200);
  assert.equal(minTopupQuote.minimum_topup_cents, 1300);
  assert.equal(minTopupQuote.total_cents, 2500);
  assert(minTopupQuote.line_items.some((li: Record<string, any>) => li.code === "MINIMUM_ORDER_TOPUP"));

  // Bilingual dynamic overlay on pricing_book updates public GET /catalog text
  const adminClient = new Client();
  await adminClient.loginWithMfa("admin@qcw.test");
  const bookCur = await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}`);
  const dynTrans = await adminClient.fetch(
    "/staff/admin/i18n/translations",
    {
      entity_type: "pricing_book",
      entity_id: pricingBookId,
      field_key: "name",
      locale: "en-US",
      source_locale: "zh-CN",
      source_revision: 1,
      source_text: String(bookCur.book.name_zh),
      translated_text: "Apparel Modular Pricing Schedule (Live Overlay)",
      submit_for_review: true,
    },
    "POST",
    201,
  );
  await reviewer.fetch(`/staff/admin/i18n/translations/${dynTrans.translation.id}/decide`, { decision: "publish" });
  const cat2 = await anon.fetch("/catalog");
  assert.equal(cat2.pricing_catalog.book_version, 2);
  assert.equal(cat2.pricing_catalog.name_en, "Apparel Modular Pricing Schedule (Live Overlay)");

  // Rollback -> retire -> editing draft over retired keeps public catalog safe (does NOT reactivate)
  await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/retire`, {});
  const catRetired = await anon.fetch("/catalog");
  assert.equal(catRetired.pricing_catalog, null);
  const rolledDraft = await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/rollback`, { target_version: 1 });
  assert.equal(rolledDraft.status, "draft");
  const catAfterRetiredRollback = await anon.fetch("/catalog");
  assert.equal(catAfterRetiredRollback.pricing_catalog, null);

  // PAGE-M22 RBAC & staffTabs("admin", ["finance"]) parity check
  const route = resolvePortalRoute("/admin/pricing");
  assert(route);
  assert.equal(canOpenStaffPage("/admin/pricing", route, ["super_admin"]), true);
  assert.equal(canOpenStaffPage("/admin/pricing", route, ["finance"]), true);
  assert.equal(canOpenStaffPage("/admin/pricing", route, ["reviewer"]), true);
  assert.equal(canOpenStaffPage("/admin/pricing", route, ["receiver"]), false);
  assert.equal(canOpenStaffPage("/admin/pricing", route, ["inspector"]), false);
  assert(staffTabs("admin", ["reviewer"]).some(([p]) => p === "/admin/pricing"));
  assert.deepEqual(
    staffTabs("admin", ["finance"]).map(([p]) => p),
    ["/admin", "/admin/finance"],
  );
});

test("4. Finding #15 security, L1-L5 customer hiding, extra_points/per_photo/trim_item/golden-archive & rate precedence", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const receiving = new Client();
  await receiving.loginWithMfa("receiving@qcw.test");
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test");
  const cust = new Client();
  await cust.loginWithMfa("customer@qcw.test");
  const anon = new Client();

  // T26 RBAC: receiving denied on all pricing write endpoints & POST /pricing/quote
  await receiving.fetch("/staff/admin/pricing/books", { code: "nope", name_zh: "x", name_en: "x" }, "POST", 403);
  await receiving.fetch(`/staff/admin/pricing/books/${pricingBookId}/batch-adjust`, { operation: "fixed_cents", delta_value: 10 }, "POST", 403);
  await receiving.fetch(`/staff/admin/pricing/books/${pricingBookId}/submit`, {}, "POST", 403);
  await receiving.fetch(`/staff/admin/pricing/books/${pricingBookId}/publish`, {}, "POST", 403);
  await receiving.fetch(`/staff/admin/pricing/books/${pricingBookId}/retire`, {}, "POST", 403);
  await receiving.fetch(`/staff/admin/pricing/books/${pricingBookId}/rollback`, { target_version: 1 }, "POST", 403);
  await receiving.fetch("/pricing/quote", { service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, quote_kind: "simulation" }, "POST", 403);
  await tplAdmin.fetch("/pricing/quote", { service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, quote_kind: "formal" }, "POST", 403);

  // Retire pricingBookId -> retired book batch-adjust rejected (422), then clone fresh active book for live policy tests
  await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}/retire`, {});
  await finance.fetch(
    `/staff/admin/pricing/books/${pricingBookId}/batch-adjust`,
    { scope: "complexity_rates", operation: "fixed_cents", delta_value: 10, dry_run: true },
    "POST",
    422,
  );

  // Clone from existing book, reset rates cleanly from rollback v1 first on source? Clone copies current row, so restore clean §43.2 rates & test precedence
  const cloned = await finance.fetch(
    `/staff/admin/pricing/books/${pricingBookId}/clone`,
    { code: "apparel_v2_policy", name_zh: "服装统一策略测试簿", name_en: "Apparel Unified Policy Book" },
    "POST",
    201,
  );
  const policyBookId = cloned.id as string;
  const custOrgRow = (
    await pool.query<{ org_id: string }>(
      "select m.org_id from memberships m join user_emails ue on ue.user_id = m.user_id where ue.normalized_email = 'customer@qcw.test' limit 1",
    )
  ).rows[0]!;
  const detail = await finance.fetch(`/staff/admin/pricing/books/${policyBookId}`);
  const cleanComplexity = structuredClone(detail.book.complexity_rates);
  cleanComplexity.L1.unit_cents = 500;
  cleanComplexity.L2.unit_cents = 800;

  // Save book with order_fixed_fee_cents, product_type_overrides, customer_overrides, volume_discount_tiers & justification
  await finance.fetch("/staff/admin/pricing/books", {
    ...detail.book,
    minimum_order_cents: 0,
    order_fixed_fee_cents: 250,
    auto_volume_discount_enabled: true,
    volume_discount_justification: "Continuous same-style batch inspection saves 15% setup labor.",
    complexity_rates: cleanComplexity,
    product_type_overrides: {
      shirt_blouse: { unit_cents: 950 },
      t_shirt: { unit_cents: 650 },
    },
    customer_overrides: {
      [custOrgRow.org_id]: {
        product_type_unit_cents: { t_shirt: 520 },
      },
    },
    volume_discount_tiers: [{ min_qty: 10, percent_off: 10 }],
    discount_rules: [],
  });
  await finance.fetch(`/staff/admin/pricing/books/${policyBookId}/submit`, { note: "Submit policy v1" });
  const pubPolicyV1 = await reviewer.fetch(`/staff/admin/pricing/books/${policyBookId}/publish`, { note: "Publish policy v1" });
  assert.equal(pubPolicyV1.version.version, 1);

  // Zero-diff batch-adjust dry_run=false MUST NOT demote published -> draft!
  const zeroAdj = await finance.fetch(`/staff/admin/pricing/books/${policyBookId}/batch-adjust`, {
    scope: "complexity_rates",
    operation: "fixed_cents",
    delta_value: 0,
    dry_run: false,
  });
  assert.equal(zeroAdj.diffs.length, 0);
  const afterZero = await finance.fetch(`/staff/admin/pricing/books/${policyBookId}`);
  assert.equal(afterZero.book.status, "published");

  // P0 Security: Anonymous / Customer spoofing guards
  await anon.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, quote_kind: "simulation", org_id: custOrgRow.org_id },
    "POST",
    403,
  );
  await anon.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "bags_general", base_qty: 1, quote_kind: "simulation", allow_unpublished_catalog_in_sim: true },
    "POST",
    403,
  );
  await anon.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, quote_kind: "simulation", draft_book_id: policyBookId },
    "POST",
    403,
  );
  await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "bags_general", base_qty: 1, quote_kind: "simulation", allow_unpublished_catalog_in_sim: true },
    "POST",
    403,
  );
  await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, quote_kind: "simulation", org_id: randomUUID() },
    "POST",
    403,
  );

  // L1-L5 hiding for customer vs staff visibility + M02 points_3 / extra_points / per_photo > base_qty / archive_new_golden_samples on inspection!
  const custSpecial = await cust.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "t_shirt",
    base_qty: 1,
    archive_new_golden_samples: 2,
    modules: [
      { module_code: "M02", option_code: "points_3", coverage_qty: 1, extra_points: 2 }, // $8 + 2*$3 = $14
      { module_code: "M09", option_code: "detail_photo", coverage_qty: 4 }, // 4 photos > base_qty 1! (4 * $3 = $12)
    ],
    quote_kind: "simulation",
  });
  // Customer org override sets t_shirt = 520 + archive 2*1500 (3000) + M02:points_3 (800) + 2*300 (600) + M09 (1200) + fixed_fee (250) = 6370
  assert.equal(custSpecial.total_cents, 520 + 3000 + 800 + 600 + 1200 + 250);
  const baseLineCust = custSpecial.line_items.find((li: Record<string, any>) => li.module_code === "M01");
  assert.equal(baseLineCust.code, "BASE_INSPECTION", "Customer must never see internal L1-L5 code");
  assert(!JSON.stringify(custSpecial.line_items).includes("L1"));

  // M06:trim_item option ($5) on trim-capable product type (polo_shirt, L2=800)
  const trimQuote = await cust.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "polo_shirt",
    base_qty: 1,
    modules: [{ module_code: "M06", option_code: "trim_item", coverage_qty: 1 }],
    quote_kind: "simulation",
  });
  assert.equal(trimQuote.total_cents, 800 + 500 + 250);

  // Stacking M02 base tier + explicit M02:extra_point module selection
  const stackedExtra = await anon.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "shirt_blouse", // uses product_type_override = 950 cents!
    base_qty: 2,
    modules: [
      { module_code: "M02", option_code: "points_5", coverage_qty: 2 }, // 2400
      { module_code: "M02", option_code: "extra_point", coverage_qty: 3 }, // 900
    ],
    quote_kind: "simulation",
  });
  // 2*950 (1900) + 2*1200 (2400) + 3*300 (900) + fixed_fee (250) = 5450
  assert.equal(stackedExtra.total_cents, 5450);

  // Compare 4 items ($35 + $12 = $47 compare fee) + volume discount on 10 items (10% off subtotal)
  const compare4 = await anon.fetch("/pricing/quote", {
    service_type: "compare",
    product_type_code: "polo_shirt", // L2 = 800
    base_qty: 4,
    modules: [],
    quote_kind: "simulation",
  });
  // 4*800 (3200) + compare_4 (3500+1200=4700) + fixed_fee (250) = 8150
  assert.equal(compare4.total_cents, 8150);

  const volApplied = await anon.fetch("/pricing/quote", {
    service_type: "inspection",
    product_type_code: "polo_shirt",
    base_qty: 10, // 10*800 + 250 = 8250; 10% volume discount = 825 -> 7425
    apply_volume_discount: true,
    quote_kind: "simulation",
  });
  assert.equal(volApplied.discount_cents, 825);
  assert.equal(volApplied.total_cents, 7425);
});

test("5. Scheduled future effective_from, revoke version, persistent 409 QUOTE_EXPIRED/PRICE_CHANGED & triggers", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const cust = new Client();
  await cust.loginWithMfa("customer@qcw.test");
  const anon = new Client();

  const booksRes = await finance.fetch("/staff/admin/pricing/books");
  const policyBook = booksRes.books.find((b: Record<string, any>) => b.code === "apparel_v2_policy");
  assert(policyBook);
  const policyBookId = policyBook.id as string;

  // Create quote while v1 is active
  const quoteOnV1 = await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "polo_shirt", base_qty: 1, modules: [], quote_kind: "formal" },
    "POST",
    201,
  );

  // Schedule v2 for tomorrow (effective_from = now + 24h) with L2 doubled to $16
  const detailV1 = await finance.fetch(`/staff/admin/pricing/books/${policyBookId}`);
  const futureComplexity = structuredClone(detailV1.book.complexity_rates);
  futureComplexity.L2.unit_cents = 1600;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  await finance.fetch("/staff/admin/pricing/books", {
    ...detailV1.book,
    complexity_rates: futureComplexity,
    effective_from: tomorrow,
  });
  await finance.fetch(`/staff/admin/pricing/books/${policyBookId}/submit`, { note: "Schedule future L2 price increase" });
  const schedV2 = await reviewer.fetch(`/staff/admin/pricing/books/${policyBookId}/publish`, { note: "Approve scheduled v2" });
  assert.equal(schedV2.version.version, 2);

  // Assert v1 remains active for /catalog, new /pricing/quote, AND verify-lock on quoteOnV1!
  const catWhileSched = await anon.fetch("/catalog");
  assert.equal(catWhileSched.pricing_catalog.book_version, 1);
  const lockedV1Quote = await cust.fetch(`/pricing/quotes/${quoteOnV1.quote_id}/verify-lock`, {});
  assert.equal(lockedV1Quote.status, "locked");

  // Trigger protects effective_from from direct SQL tampering
  await assert.rejects(
    async () => {
      await pool.query("update pricing_book_versions set effective_from = now() - interval '1 day' where id = $1::uuid", [schedV2.version.id]);
    },
    /immutable/i,
  );

  // Revoke scheduled v2 before it takes effect
  const revoked = await finance.fetch(`/staff/admin/pricing/books/${policyBookId}/versions/2/revoke`, { note: "Cancelled price hike" });
  assert.equal(revoked.state, "RETIRED");

  // DB triggers reject DELETE and RETIRED -> PUBLISHED reactivation
  await assert.rejects(
    async () => {
      await pool.query("delete from pricing_book_versions where id = $1::uuid", [schedV2.version.id]);
    },
    /immutable/i,
  );
  await assert.rejects(
    async () => {
      await pool.query("update pricing_book_versions set state = 'PUBLISHED' where id = $1::uuid", [schedV2.version.id]);
    },
    /Retired/i,
  );

  // Test persistent DB status update on 409 QUOTE_EXPIRED and 409 PRICE_CHANGED
  const expQuote = await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "polo_shirt", base_qty: 1, modules: [], quote_kind: "formal" },
    "POST",
    201,
  );
  await pool.query("update pricing_quotes set expires_at = now() - interval '1 hour' where id = $1::uuid", [expQuote.quote_id]);
  const expErr = await cust.fetch(`/pricing/quotes/${expQuote.quote_id}/verify-lock`, {}, "POST", 409);
  assert.equal(expErr.error.code, "QUOTE_EXPIRED");
  const expDbRow = (await pool.query<{ status: string }>("select status from pricing_quotes where id = $1::uuid", [expQuote.quote_id])).rows[0]!;
  assert.equal(expDbRow.status, "expired", "Expired status update must commit in PG instead of rolling back on 409");

  const staleQuote = await cust.fetch(
    "/pricing/quote",
    { service_type: "inspection", product_type_code: "polo_shirt", base_qty: 1, modules: [], quote_kind: "formal" },
    "POST",
    201,
  );
  // Publish an immediate v3 price change -> staleQuote verify-lock returns 409 PRICE_CHANGED AND persists status='superseded'
  await finance.fetch("/staff/admin/pricing/books", {
    ...detailV1.book,
    complexity_rates: futureComplexity,
    effective_from: null,
  });
  await finance.fetch(`/staff/admin/pricing/books/${policyBookId}/submit`, { note: "Immediate L2 price update" });
  await reviewer.fetch(`/staff/admin/pricing/books/${policyBookId}/publish`, { note: "Publish immediate v3" });
  const supErr = await cust.fetch(`/pricing/quotes/${staleQuote.quote_id}/verify-lock`, {}, "POST", 409);
  assert.equal(supErr.error.code, "PRICE_CHANGED");
  const supDbRow = (await pool.query<{ status: string }>("select status from pricing_quotes where id = $1::uuid", [staleQuote.quote_id])).rows[0]!;
  assert.equal(supDbRow.status, "superseded", "Superseded status update must commit in PG instead of rolling back on 409");

  // Cross-tenant customer quote access returns 404
  const secondOrgId = randomUUID();
  const secondUserId = randomUUID();
  const secondEmail = `tenant_b_${randomUUID().slice(0, 8)}@qcw.test`;
  await pool.query("insert into organizations (id, name, kind, country) values ($1::uuid, 'Tenant B', 'personal', 'US')", [secondOrgId]);
  await pool.query("insert into users (id, display_name, status) values ($1::uuid, 'Tenant B User', 'active')", [secondUserId]);
  await pool.query("insert into memberships (user_id, org_id, role) values ($1::uuid, $2::uuid, 'owner')", [secondUserId, secondOrgId]);
  const secondEmailRow = (
    await pool.query<{ id: string }>(
      `insert into user_emails (user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
       values ($1::uuid, $2::text, $3::citext, now(), true, true) returning id`,
      [secondUserId, secondEmail, secondEmail],
    )
  ).rows[0]!;
  await pool.query(
    `insert into auth_identities (user_id, provider, issuer, subject, status, linked_at, email_id)
     values ($1::uuid, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2::uuid)`,
    [secondUserId, secondEmailRow.id],
  );
  const custB = new Client();
  await custB.loginWithMfa(secondEmail);
  await custB.fetch(`/pricing/quotes/${staleQuote.quote_id}`, undefined, "GET", 404);
  await custB.fetch(`/pricing/quotes/${staleQuote.quote_id}/verify-lock`, {}, "POST", 404);

  // Validation hardening checks: percent_off > 100 (422), MODULE_DEPENDENCY_CYCLE (422), batchAdjust L1 <= 0 (422), stale i18n source_hash fallback
  const badPctErr = await finance.fetch(
    "/staff/admin/pricing/books",
    {
      ...detailV1.book,
      discount_rules: [{ code: "BAD101", label_zh: "错", label_en: "Bad", kind: "percent_off", value: 101 }],
    },
    "POST",
    422,
  );
  assert(badPctErr.error);

  const cyclicMods = structuredClone(detailV1.book.module_rates);
  cyclicMods.M02.requires = ["M03"];
  cyclicMods.M03.requires = ["M02"];
  const cycleErr = await finance.fetch(
    "/staff/admin/pricing/books",
    { ...detailV1.book, module_rates: cyclicMods },
    "POST",
    422,
  );
  assert.equal(cycleErr.error.code, "MODULE_DEPENDENCY_CYCLE");

  await finance.fetch(
    `/staff/admin/pricing/books/${policyBookId}/batch-adjust`,
    { scope: "complexity_rates", operation: "fixed_cents", delta_value: -1000, dry_run: false },
    "POST",
    422,
  );

  // Stale i18n source_hash fallback check on GET /catalog
  const adminClient = new Client();
  await adminClient.loginWithMfa("admin@qcw.test");
  const staleTrans = await adminClient.fetch(
    "/staff/admin/i18n/translations",
    {
      entity_type: "pricing_book",
      entity_id: policyBookId,
      field_key: "name",
      locale: "en-US",
      source_locale: "zh-CN",
      source_revision: 1,
      source_text: "Outdated source text that no longer matches book name_zh",
      translated_text: "SHOULD NOT APPEAR WHEN SOURCE HASH STALE",
      submit_for_review: true,
    },
    "POST",
    201,
  );
  await reviewer.fetch(`/staff/admin/i18n/translations/${staleTrans.translation.id}/decide`, { decision: "publish" });
  const catFallback = await anon.fetch("/catalog");
  assert.equal(catFallback.pricing_catalog.name_en, "Apparel Unified Policy Book");
});
