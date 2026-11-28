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
  buildSafeEstimatorNextPath,
  resetPublicEstimateRateLimiter,
} = await import("../packages/core/public-estimator");

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
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        ...(method === "GET"
          ? {}
          : {
              origin: appOrigin,
              ...(csrf ? { "x-csrf-token": csrf } : {}),
              "idempotency-key": key,
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handle(req, path.split("?")[0]);
    for (const c of res.headers.getSetCookie()) {
      const [nv] = c.split(";");
      const idx = nv.indexOf("=");
      if (idx > 0) this.jar.set(nv.slice(0, idx), nv.slice(idx + 1));
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    assert.equal(res.status, expected, `${method} ${path} expected ${expected} got ${res.status}: ${text}`);
    return { body: parsed, headers: res.headers };
  }
  async loginWithMfa(email: string) {
    const { body: otp } = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    const { body: out } = await this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code }, "POST", 200);
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
    ["admin@qcw.test", "inspector@qcw.test", "reviewer@qcw.test"],
  ]);

  // Seed & publish unified knowledge + pricing book via official admin flows (non-author SoD)
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  await admin.fetch("/staff/admin/knowledge/seed-init", {}, "POST", 200);
  await admin.fetch("/staff/admin/pricing/seed-init", {}, "POST", 200);

  // Distinct reviewer MFA: batch-publish apparel product types + pricing book (non-author SoD)
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const { body: ptList } = await admin.fetch("/staff/admin/knowledge/entities/product_type");
  const unpubPts = ptList.items
    .filter((p: { category_slug: string; status: string }) => p.category_slug === "apparel" && p.status !== "published")
    .map((p: { id: string }) => p.id);
  if (unpubPts.length > 0) {
    await reviewer.fetch("/staff/admin/knowledge/entities/product_type/batch-publish", {
      ids: unpubPts,
      public_sellable: true,
      note: "Publish apparel catalog for Wave 28 estimator tests",
    }, "POST", 200);
  }

  const { body: booksRes } = await admin.fetch("/staff/admin/pricing/books");
  const book = booksRes.books.find((b: { code: string }) => b.code === "apparel_modular_usd");
  assert(book, "Expected seeded apparel_modular_usd pricing book.");
  await admin.fetch(`/staff/admin/pricing/books/${book.id}/submit`, { note: "wave28 seed" }, "POST", 200);
  await reviewer.fetch(`/staff/admin/pricing/books/${book.id}/publish`, { note: "Approve v1 sandbox pricing" }, "POST", 200);
});

after(async () => {
  resetPublicEstimateRateLimiter();
  await pool.end();
});

test("1. Unified pricing kernel parity (1-group & §97.2 multi-group, presets, rounding, M01 dedup, module constraints)", async () => {
  const visitor = new Client();

  // Single-group quote parity with formal POST /pricing/quote simulation
  const singlePayload = {
    mode: "quick",
    locale: "en-US",
    service_groups: [
      {
        group_id: "g1",
        service_type: "inspection",
        product_type_code: "t_shirt",
        base_qty: 10,
        preset: "custom",
        modules: [{ module_code: "M02", option_code: "points_3", coverage_mode: "percentage", coverage_pct: 25 }],
      },
    ],
  };
  const { body: pubEst } = await visitor.fetch("/public/estimate", singlePayload, "POST", 200);
  const { body: kernelSim } = await visitor.fetch(
    "/pricing/quote",
    {
      service_type: "inspection",
      product_type_code: "t_shirt",
      base_qty: 10,
      modules: [{ module_code: "M02", option_code: "points_3", coverage_mode: "percentage", coverage_pct: 25 }],
      quote_kind: "simulation",
    },
    "POST",
    200,
  );
  assert.equal(pubEst.status, "sandbox_priced");
  assert.equal(pubEst.can_checkout_online, false, "Sandbox pricing cannot enable production checkout");
  assert.equal(pubEst.total_cents, kernelSim.total_cents);
  assert.equal(pubEst.subtotal_cents, kernelSim.subtotal_cents);
  assert.equal(pubEst.groups[0].line_items.length, kernelSim.line_items.length);
  // 25% of 10 with ceil rounding = 3 items
  const m02Line = pubEst.groups[0].line_items.find((l: { module_code: string | null }) => l.module_code === "M02");
  assert.equal(m02Line.quantity, 3);

  // Compare & Reference Match parity
  const { body: cmpEst } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "quick",
      locale: "zh-CN",
      service_groups: [{ group_id: "c1", service_type: "compare", product_type_code: "t_shirt", base_qty: 3, preset: "basic" }],
    },
    "POST",
    200,
  );
  const { body: cmpSim } = await visitor.fetch(
    "/pricing/quote",
    { service_type: "compare", product_type_code: "t_shirt", base_qty: 3, modules: [], quote_kind: "simulation" },
    "POST",
    200,
  );
  assert.equal(cmpEst.total_cents, cmpSim.total_cents);

  const { body: refEst } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "quick",
      locale: "en-US",
      service_groups: [
        {
          group_id: "r1",
          service_type: "reference_match",
          product_type_code: "t_shirt",
          base_qty: 2,
          preset: "basic",
          has_existing_golden_sample: false,
          golden_reference_count: 1,
        },
      ],
    },
    "POST",
    200,
  );
  const { body: refSim } = await visitor.fetch(
    "/pricing/quote",
    {
      service_type: "reference_match",
      product_type_code: "t_shirt",
      base_qty: 2,
      golden_sample_ids: ["00000000-0000-0000-0000-000000000001"],
      modules: [],
      quote_kind: "simulation",
    },
    "POST",
    200,
  );
  assert.equal(refEst.total_cents, refSim.total_cents);
  assert(refEst.groups[0].conditional_disclosures.some((d: string) => d.includes("Prerequisite")));

  // §97.2 mixed scenario: 3 × L1 t_shirt ($5/pc = $15) + 1 × M02 points_3 ($8/pc = $8) + 1 extra_point ($3) + 2 × L2 shirt_blouse ($8/pc = $16) = $42 (4200 cents)
  const { body: mixed } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "advanced",
      locale: "en-US",
      service_groups: [
        {
          group_id: "tee",
          service_type: "inspection",
          product_type_code: "t_shirt",
          base_qty: 3,
          preset: "custom",
          modules: [
            { module_code: "M01" }, // deduplicated at no extra cost
            { module_code: "M02", option_code: "points_3", coverage_mode: "exact_count", coverage_qty: 1, extra_points: 1 },
          ],
        },
        {
          group_id: "sh",
          service_type: "inspection",
          product_type_code: "shirt_blouse",
          base_qty: 2,
          preset: "basic",
        },
      ],
    },
    "POST",
    200,
  );
  assert.equal(mixed.base_subtotal_cents, 3100, "3x500 + 2x800 = 3100 cents");
  assert.equal(mixed.addons_subtotal_cents, 1100, "1x800 (M02 points_3) + 1x300 (extra_point) = 1100 cents");
  assert.equal(mixed.total_cents, 4200);
  // M01 must NOT be billed twice
  const teeM01Lines = mixed.groups[0].line_items.filter((l: { module_code: string | null }) => l.module_code === "M01");
  assert.equal(teeM01Lines.length, 1);

  // No automatic volume discount: 1pc = $5, 10pc = $50, 50pc = $250
  const { body: q50 } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "quick",
      locale: "en-US",
      service_groups: [{ group_id: "g50", service_type: "inspection", product_type_code: "t_shirt", base_qty: 50, preset: "basic" }],
    },
    "POST",
    200,
  );
  assert.equal(q50.total_cents, 25000);
  assert.equal(q50.discount_cents, 0);

  // P2 fix check: preset="standard" must override stale custom modules and enforce M02:points_3 ($5 + $8 = $13/pc * 3 = 3900)
  const { body: stdOverride } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "quick",
      locale: "en-US",
      service_groups: [
        {
          group_id: "std1",
          service_type: "inspection",
          product_type_code: "t_shirt",
          base_qty: 3,
          preset: "standard",
          modules: [{ module_code: "M03", option_code: "standard", coverage_mode: "exact_count", coverage_qty: 3 }],
        },
      ],
    },
    "POST",
    200,
  );
  assert.equal(stdOverride.total_cents, 3900);
  assert.equal(stdOverride.groups[0].line_items.some((l: { module_code: string | null }) => l.module_code === "M02"), true);
  assert.equal(stdOverride.groups[0].line_items.some((l: { module_code: string | null }) => l.module_code === "M03"), false);

  // Module validation failures return 422 cleanly (destructive requires authorization, unknown module)
  await visitor.fetch(
    "/public/estimate",
    {
      mode: "advanced",
      locale: "en-US",
      service_groups: [
        {
          group_id: "d1",
          service_type: "inspection",
          product_type_code: "t_shirt",
          base_qty: 1,
          preset: "custom",
          modules: [{ module_code: "M05", option_code: "gsm_cut_swatch", coverage_mode: "exact_count", coverage_qty: 1 }],
          customer_authorized_destructive: false,
        },
      ],
    },
    "POST",
    422,
  );
  await visitor.fetch(
    "/public/estimate",
    {
      mode: "advanced",
      locale: "en-US",
      service_groups: [
        { group_id: "u1", service_type: "inspection", product_type_code: "t_shirt", base_qty: 1, modules: [{ module_code: "M99" }] },
      ],
    },
    "POST",
    422,
  );
});

test("2. Security, anti-tampering, zero PII/order writes, no L1-L5 leaks & honest unavailable states", async () => {
  const visitor = new Client();

  // Record DB row counts before public estimation
  const beforeCounts = await pool.query<{ o: number; c: number; p: number; q: number; d: number }>(
    `select
       (select count(*)::int from orders) o,
       (select count(*)::int from charge_items) c,
       (select count(*)::int from payments) p,
       (select count(*)::int from pricing_quotes) q,
       (select count(*)::int from anonymous_estimate_drafts) d`,
  );

  // P1 check: Signed-in customer succeeds with x-csrf-token and gets 403 CSRF_INVALID without it
  const signedInCust = new Client();
  await signedInCust.loginWithMfa("customer@qcw.test");
  await signedInCust.fetch(
    "/public/estimate",
    {
      mode: "quick",
      locale: "en-US",
      service_groups: [{ group_id: "g1", service_type: "inspection", product_type_code: "t_shirt", base_qty: 5, preset: "basic" }],
    },
    "POST",
    200,
  );
  // Raw request with session cookie but missing x-csrf-token must fail with 403
  const custCookies = (signedInCust as unknown as { jar: Map<string, string> }).jar;
  const noCsrfReq = new Request(`${appOrigin}/api/v1/public/estimate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: appOrigin,
      cookie: `session=${custCookies.get("session") ?? ""}; qcw_csrf=${custCookies.get("qcw_csrf") ?? ""}`,
    },
    body: JSON.stringify({
      mode: "quick",
      locale: "en-US",
      service_groups: [{ group_id: "g1", service_type: "inspection", product_type_code: "t_shirt", base_qty: 5 }],
    }),
  });
  const noCsrfRes = await handle(noCsrfReq, "/public/estimate");
  assert.equal(noCsrfRes.status, 403);

  // Strict Zod rejects client price tampering, org_id, golden_sample_ids, email, negative qty, floats
  for (const badBody of [
    { service_groups: [{ group_id: "g1", product_type_code: "t_shirt", base_qty: 5 }], total_cents: 1 },
    { service_groups: [{ group_id: "g1", product_type_code: "t_shirt", base_qty: 5, unit_cents: 1 }] },
    { service_groups: [{ group_id: "g1", product_type_code: "t_shirt", base_qty: 5 }], org_id: randomUUID() },
    { service_groups: [{ group_id: "g1", product_type_code: "t_shirt", base_qty: 5, golden_sample_ids: ["secret"] }] },
    { service_groups: [{ group_id: "g1", product_type_code: "t_shirt", base_qty: -3 }] },
    { service_groups: [{ group_id: "g1", product_type_code: "t_shirt", base_qty: 1.5 }] },
  ]) {
    await visitor.fetch("/public/estimate", badBody, "POST", 422);
  }

  // Zero L1-L5 / internal cost leaks on valid estimation + explicit post-inspection Estimated later (never $0)
  const { body: okEst } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "quick",
      locale: "en-US",
      service_groups: [{ group_id: "g1", service_type: "inspection", product_type_code: "jacket", base_qty: 10, preset: "standard" }],
    },
    "POST",
    200,
  );
  const jsonText = JSON.stringify(okEst);
  assert(!/\bL[1-5]\b/.test(jsonText), "Must never leak L1-L5 tier codes to public visitor");
  assert(!jsonText.includes("customer_overrides") && !jsonText.includes("labor_hourly_rate"));
  assert.equal(okEst.post_inspection_charges.domestic_shipping.status, "estimated_later");
  assert.equal(okEst.post_inspection_charges.domestic_shipping.amount_cents, null);

  // Manual quote escalation on > 300 qty
  const { body: overEst } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "quick",
      locale: "en-US",
      service_groups: [{ group_id: "g1", service_type: "inspection", product_type_code: "t_shirt", base_qty: 301, preset: "basic" }],
    },
    "POST",
    200,
  );
  assert.equal(overEst.status, "manual_quote_required");
  assert.equal(overEst.manual_quote_required, true);

  // Unavailable category returns honest status + null total_cents
  const { body: unavailEst } = await visitor.fetch(
    "/public/estimate",
    {
      mode: "advanced",
      locale: "zh-CN",
      service_groups: [{ group_id: "g1", service_type: "inspection", product_type_code: "nonexistent_shoe", base_qty: 5 }],
    },
    "POST",
    200,
  );
  assert.equal(unavailEst.status, "unavailable");
  assert.equal(unavailEst.total_cents, null);
  assert.equal(unavailEst.groups[0].status, "unavailable");

  // Confirm ZERO DB writes from any POST /public/estimate
  const afterCounts = await pool.query<{ o: number; c: number; p: number; q: number; d: number }>(
    `select
       (select count(*)::int from orders) o,
       (select count(*)::int from charge_items) c,
       (select count(*)::int from payments) p,
       (select count(*)::int from pricing_quotes) q,
       (select count(*)::int from anonymous_estimate_drafts) d`,
  );
  assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0]);

  // Safe URL builder blocks open redirects & token/price leakage
  assert.equal(buildSafeEstimatorNextPath("/orders/new", { service: "inspection", draft_token: "secret", total_cents: 999 }), "/orders/new?service=inspection");
  assert.throws(() => buildSafeEstimatorNextPath("//evil.com"));
  assert.throws(() => buildSafeEstimatorNextPath("/admin/pricing"));
});

test("3. Anonymous draft lifecycle: HttpOnly session binding, hash storage, v2 price drift, expiry recovery, revocation & rate limit", async () => {
  const visitorA = new Client();
  const visitorB = new Client();

  // Establish visitorB browser cookie via inquiry-categories first
  await visitorB.fetch("/public/inquiry-categories");

  const draftInput = {
    mode: "advanced",
    locale: "zh-CN",
    source_route: "/zh/pricing",
    service_groups: [
      {
        group_id: "g1",
        service_type: "inspection",
        product_type_code: "t_shirt",
        base_qty: 10,
        preset: "standard",
      },
    ],
  };
  const { body: created, headers: createHeaders } = await visitorA.fetch("/public/estimate-drafts", draftInput, "POST", 201);
  assert(created.draft_token && created.draft_token.length >= 32);
  assert.equal(created.status, "active");
  assert.equal(created.locale, "zh-CN");
  assert.equal(created.mode, "advanced");
  assert(createHeaders.get("x-robots-tag")?.includes("noindex"));

  // Raw token must never exist in DB table (only sha256 hash)
  const dbRows = await pool.query<{ token_hash: string; session_binding_hash: string; raw_match: number }>(
    `select token_hash, session_binding_hash,
            (select count(*)::int from anonymous_estimate_drafts where token_hash = $1) raw_match
     from anonymous_estimate_drafts
     where id = $2::uuid`,
    [created.draft_token, created.draft_id],
  );
  assert.equal(dbRows.rows[0].token_hash, sha256(created.draft_token));
  assert.equal(dbRows.rows[0].raw_match, 0);

  // Cross-browser session access rejected (404)
  await visitorB.fetch(`/public/estimate-drafts/${created.draft_token}`, undefined, "GET", 404);

  // Same browser reads live draft cleanly
  const { body: read1 } = await visitorA.fetch(`/public/estimate-drafts/${created.draft_token}`);
  assert.equal(read1.status, "active");
  assert.equal(read1.price_changed, false);
  assert.equal(read1.locale, "zh-CN");
  const initialTotal = read1.estimate.total_cents;

  // Update draft increments revision & preserves updates
  const { body: updated } = await visitorA.fetch(
    `/public/estimate-drafts/${created.draft_token}`,
    {
      ...draftInput,
      service_groups: [{ ...draftInput.service_groups[0], base_qty: 12 }],
    },
    "PUT",
    200,
  );
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.estimate.total_cents, initialTotal);

  // Publish v2 pricing book -> reading existing draft returns price_changed=true & live total
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");

  const { body: booksRes } = await admin.fetch("/staff/admin/pricing/books");
  const book = booksRes.books.find((b: { code: string }) => b.code === "apparel_modular_usd");
  assert(book, "Expected seeded apparel_modular_usd book");
  const nextComplexities = {
    ...book.complexity_rates,
    L1: { ...book.complexity_rates.L1, unit_cents: 650 },
  };
  await admin.fetch("/staff/admin/pricing/books", {
    ...book,
    complexity_rates: nextComplexities,
    note: "v2 L1 price update",
  }, "POST", 200);
  await admin.fetch(`/staff/admin/pricing/books/${book.id}/submit`, { note: "v2" }, "POST", 200);
  await reviewer.fetch(`/staff/admin/pricing/books/${book.id}/publish`, { note: "Approve v2 pricing" }, "POST", 200);

  const { body: readAfterV2 } = await visitorA.fetch(`/public/estimate-drafts/${created.draft_token}`);
  assert.equal(readAfterV2.price_changed, true);
  assert.equal(readAfterV2.saved_total_cents, updated.estimate.total_cents);
  assert.notEqual(readAfterV2.estimate.total_cents, updated.estimate.total_cents);

  // Expiry recovery: expired draft returns recoverable_input & estimate=null, PUT rejected with 409
  await pool.query("update anonymous_estimate_drafts set expires_at = now() - interval '1 hour' where id = $1::uuid", [created.draft_id]);
  const { body: readExp } = await visitorA.fetch(`/public/estimate-drafts/${created.draft_token}`);
  assert.equal(readExp.status, "expired");
  assert.equal(readExp.estimate, null);
  assert.equal(readExp.recoverable_input.service_groups[0].base_qty, 12);
  await visitorA.fetch(`/public/estimate-drafts/${created.draft_token}`, draftInput, "PUT", 409);

  // Revocation: DELETE marks revoked and GET returns 410
  await visitorA.fetch(`/public/estimate-drafts/${created.draft_token}`, undefined, "DELETE", 200);
  await visitorA.fetch(`/public/estimate-drafts/${created.draft_token}`, undefined, "GET", 410);

  // Public rate limiter rejects flood with 429 RATE_LIMITED
  resetPublicEstimateRateLimiter();
  const flood = new Client();
  await flood.fetch("/public/inquiry-categories"); // fix cookie
  for (let i = 0; i < 120; i++) {
    await flood.fetch("/public/estimate", {
      mode: "quick",
      locale: "en-US",
      service_groups: [{ group_id: "g1", service_type: "inspection", product_type_code: "t_shirt", base_qty: 1 }],
    }, "POST", 200);
  }
  await flood.fetch("/public/estimate", {
    mode: "quick",
    locale: "en-US",
    service_groups: [{ group_id: "g1", service_type: "inspection", product_type_code: "t_shirt", base_qty: 1 }],
  }, "POST", 429);
  resetPublicEstimateRateLimiter();
});
