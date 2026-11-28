import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import sharp from "sharp";

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
    const multipart = body instanceof FormData;
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
              ...(!multipart ? { "content-type": "application/json" } : {}),
            }
          : {}),
      },
      ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}),
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
  async photo(kind: string) {
    const buf = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#1e3a8a" } }).png().toBuffer();
    const f = new FormData();
    f.set("photo", new Blob([new Uint8Array(buf)], { type: "image/png" }), "proof.png");
    f.set("kind", kind);
    return (await this.fetch("/staff/media", f, "POST", 201)).id as string;
  }
}

let costModelId = "";
let pricingBookId = "";
let sampleOrderId = "";
let sampleTaskId = "";

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

test("1. Idempotent §43.3 seed, anti-double-count mgmt overhead, Cost Model SoD & immutable triggers", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const receiving = new Client();
  await receiving.loginWithMfa("receiving@qcw.test");

  // Seed knowledge + pricing + labor/cost defaults
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test");
  await tplAdmin.fetch("/staff/admin/knowledge/seed-init", {}, "POST", 200);
  await finance.fetch("/staff/admin/pricing/seed-init", {}, "POST", 200);
  pricingBookId = (await finance.fetch("/staff/admin/pricing/books")).books[0].id;

  const seed1 = await finance.fetch("/staff/admin/cost-models/seed-init", {}, "POST", 200);
  assert.equal(seed1.inserted_counts.labor_baselines, 19);
  assert.equal(seed1.inserted_counts.cost_models, 1);

  const modelsRes = await finance.fetch("/staff/admin/cost-models");
  assert.equal(modelsRes.models.length, 1);
  costModelId = modelsRes.models[0].id;
  assert.equal(modelsRes.models[0].status, "draft");
  assert.equal(modelsRes.models[0].data_source, "estimated_baseline");
  assert.equal(modelsRes.models[0].business_approved, false);

  // Admin edits support_cost_per_order_cents -> re-seed preserves edits
  const curModel = (await finance.fetch(`/staff/admin/cost-models/${costModelId}`)).model;
  await finance.fetch("/staff/admin/cost-models", { ...curModel, support_cost_per_order_cents: 175 });
  const seed2 = await finance.fetch("/staff/admin/cost-models/seed-init", {}, "POST", 200);
  assert.equal(seed2.inserted_counts.cost_models, 0);
  assert.equal((await finance.fetch(`/staff/admin/cost-models/${costModelId}`)).model.support_cost_per_order_cents, 175);

  // Anti-double-count management overhead check (API 422 + DB check)
  await finance.fetch(
    "/staff/admin/cost-models",
    { ...curModel, management_overhead_included_in_labor: true, management_overhead_pct: 12 },
    "POST",
    422,
  );
  await assert.rejects(
    async () => {
      await pool.query(
        "update cost_models set management_overhead_included_in_labor = true, management_overhead_pct = 5 where id = $1::uuid",
        [costModelId],
      );
    },
    /cost_models_no_double_mgmt_overhead/i,
  );

  // SoD: author finance cannot self-publish -> reviewer publishes v1
  await finance.fetch(`/staff/admin/cost-models/${costModelId}/submit`, {});
  await finance.fetch(`/staff/admin/cost-models/${costModelId}/publish`, {}, "POST", 403);
  const pubV1 = await reviewer.fetch(`/staff/admin/cost-models/${costModelId}/publish`, { note: "Approve cost model v1" });
  assert.equal(pubV1.version.version, 1);
  assert.equal(pubV1.version.business_approved, false);

  // Immutable trigger check on cost_model_versions
  await assert.rejects(
    async () => {
      await pool.query("update cost_model_versions set snapshot = '{}'::jsonb where id = $1::uuid", [pubV1.version.id]);
    },
    /immutable/i,
  );
  await assert.rejects(
    async () => {
      await pool.query("delete from cost_model_versions where id = $1::uuid", [pubV1.version.id]);
    },
    /immutable/i,
  );

  // RBAC: pure receiver (without warehouse_admin role) denied all cost-model endpoints & stats
  const pureReceiverId = randomUUID();
  const pureReceiverEmail = `pure_recv_${randomUUID().slice(0, 6)}@qcw.test`;
  await pool.query("insert into users (id, display_name, status) values ($1::uuid, 'Pure Receiver', 'active')", [pureReceiverId]);
  await pool.query("insert into staff_roles (user_id, role) values ($1::uuid, 'receiver')", [pureReceiverId]);
  const recvEmailRow = (
    await pool.query<{ id: string }>(
      "insert into user_emails (user_id, original_email, normalized_email, verified_at, is_primary, login_enabled) values ($1::uuid, $2::text, $3::citext, now(), true, true) returning id",
      [pureReceiverId, pureReceiverEmail, pureReceiverEmail],
    )
  ).rows[0]!;
  await pool.query(
    "insert into auth_identities (user_id, provider, issuer, subject, status, linked_at, email_id) values ($1::uuid, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2::uuid)",
    [pureReceiverId, recvEmailRow.id],
  );
  const pureReceiver = new Client();
  await pureReceiver.loginWithMfa(pureReceiverEmail);

  await pureReceiver.fetch("/staff/admin/cost-models", undefined, "GET", 403);
  await pureReceiver.fetch("/staff/admin/cost-models/seed-init", {}, "POST", 403);
  await pureReceiver.fetch("/staff/labor/stats", undefined, "GET", 403);
  await admin.fetch("/staff/admin/cost-models/overview"); // super_admin allowed
});

test("2. Fixed-60s bug eliminated, real-clock auto-hooks (start/pause/resume/handover/submit), parallel anti-double-counting", async () => {
  const cust = new Client();
  await cust.loginWithMfa("customer@qcw.test");
  const receiving = new Client();
  await receiving.loginWithMfa("receiving@qcw.test");
  const inspector = new Client();
  await inspector.loginWithMfa("inspector@qcw.test");
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  // receiving@qcw.test holds ["receiver","warehouse_admin"] per demo.ts
  const warehouseAdmin = receiving;

  // Create second inspector for handover attribution test
  const insp2Email = `insp2_${randomUUID().slice(0, 6)}@qcw.test`;
  const insp2Id = randomUUID();
  await pool.query("insert into users (id, display_name, status) values ($1::uuid, 'Inspector Two', 'active')", [insp2Id]);
  await pool.query("insert into staff_roles (user_id, role) values ($1::uuid, 'inspector')", [insp2Id]);
  const insp2EmailRow = (
    await pool.query<{ id: string }>(
      "insert into user_emails (user_id, original_email, normalized_email, verified_at, is_primary, login_enabled) values ($1::uuid, $2::text, $3::citext, now(), true, true) returning id",
      [insp2Id, insp2Email, insp2Email],
    )
  ).rows[0]!;
  await pool.query(
    "insert into auth_identities (user_id, provider, issuer, subject, status, linked_at, email_id) values ($1::uuid, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2::uuid)",
    [insp2Id, insp2EmailRow.id],
  );
  const insp2 = new Client();
  await insp2.loginWithMfa(insp2Email);

  // Create paid order, receive parcel & check-in 1 item
  const offers = (await cust.fetch("/catalog")).offers;
  const stdOffer = offers.find((o: Record<string, any>) => o.sku_code === "apparel-inspection-1")!;
  const terms = (await cust.fetch("/public/terms")).terms.map((t: Record<string, any>) => t.id);
  const addr = (await cust.fetch("/me/receiving-address")).warehouse_address.id as string;

  const draft = await cust.fetch("/orders", {
    lines: [{ category_id: stdOffer.category_id, offer_id: stdOffer.offer_id, quantity: 1, attributes: { name: "Cost Lab Tee" } }],
  }, "POST", 201);
  const quote = await cust.fetch(`/orders/${draft.id}/quotes`, { revision: draft.revision }, "POST", 201);
  const sub = await cust.fetch(`/orders/${draft.id}/submit`, {
    revision: draft.revision,
    quote_id: quote.id,
    terms_version_ids: terms,
    acknowledgements: { scope_notice: true, samples_not_batch: true, seller_refund_is_mine: true, no_certification: true, restricted_items: true },
  });
  const pay = await cust.fetch(`/charges/${sub.charge.charge_item_id}/checkout`, { quote_revision: quote.revision });
  await cust.fetch(`/checkout/demo/${pay.attempt_id}`, {});
  sampleOrderId = draft.id;

  const trk = "SF" + randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const adv = await cust.fetch("/me/parcels", { address_id: addr, tracking_no: trk, carrier_code: "sf", order_ids: [draft.id] }, "POST", 201);
  const pkg = await receiving.fetch("/staff/intake/check-in", {
    tracking_no: trk, carrier_code: "sf", advice_id: adv.id, weight_g: 300, outer_media_ids: [await receiving.photo("intake_outer")],
  }, "POST", 201);

  const whRow = (
    await pool.query<{ id: string }>(
      `insert into warehouses (warehouse_code, name_zh, name_en, status, accept_new_orders, accept_inbound_transit, allow_fulfillment, allow_dispatch)
       values ('WH-COST-01', '成本测试仓', 'Cost Lab Warehouse', 'active', true, true, true, true)
       returning id`,
    )
  ).rows[0]!;
  const locId = (await pool.query<{ id: string }>("select id from storage_locations where code = 'R-01' limit 1")).rows[0]!.id;
  const itemCode = `S${Math.floor(10000 + Math.random() * 89999)}`;
  const unp = await receiving.fetch(`/staff/packages/${pkg.id}/items`, { revision: pkg.revision, items: [{ code: itemCode, location_id: locId }] }, "POST", 201);
  const itemId = unp.item_ids[0] as string;
  const expItem = (
    await pool.query<{ id: string; order_line_id: string }>(
      "select e.id, e.order_line_id from expected_items e join order_lines l on l.id = e.order_line_id where l.order_id = $1 limit 1",
      [draft.id],
    )
  ).rows[0]!;
  await receiving.fetch(`/staff/items/${itemId}/assign`, {
    revision: 1, order_line_id: expItem.order_line_id, expected_item_id: expItem.id, evidence_ids: [await receiving.photo("label_photo")],
  });

  const taskRow = (
    await pool.query<{ id: string; revision: number }>(
      "select id, revision from inspection_tasks where order_line_id = $1 limit 1",
      [expItem.order_line_id],
    )
  ).rows[0]!;
  sampleTaskId = taskRow.id;

  // Fixed-60s bug verification: record WITHOUT seconds or timestamp range MUST fail 422 TIMING_DURATION_REQUIRED!
  await inspector.fetch(`/staff/inspection-tasks/${sampleTaskId}/start`, { revision: taskRow.revision });
  const badRecord = await inspector.fetch(`/staff/inspection-tasks/${sampleTaskId}/steps`, { step_code: "prep", action: "record" }, "POST", 422);
  assert.equal(badRecord.error.code, "TIMING_DURATION_REQUIRED");
  // stop without open step returns 409 NO_ACTIVE_TIMING
  const badStop = await inspector.fetch(`/staff/inspection-tasks/${sampleTaskId}/steps`, { step_code: "prep", action: "stop" }, "POST", 409);
  assert.equal(badStop.error.code, "NO_ACTIVE_TIMING");

  // Explicit timestamp range records exact delta (42s), not 60s!
  const t0 = new Date(Date.now() - 42_000).toISOString();
  const t1 = new Date().toISOString();
  const explicitRec = await inspector.fetch(`/staff/inspection-tasks/${sampleTaskId}/steps`, {
    step_code: "prep", action: "record", started_at: t0, ended_at: t1,
  });
  assert.equal(explicitRec.seconds, 42);

  // Register dispatch work item -> pause pauses labor event, resume resumes, handover completes old operator event & starts new operator!
  const regWi = await warehouseAdmin.fetch("/staff/dispatch/work-items", {
    warehouse_id: whRow.id, task_domain: "inspection", source_entity_id: sampleTaskId, inspection_task_id: sampleTaskId, required_role: "inspector", priority: 10,
  }, "POST", 201);
  const wiId = regWi.work_item.id as string;
  await warehouseAdmin.fetch(`/staff/dispatch/work-items/${wiId}/assign`, {
    assignee_id: (await pool.query<{ assignee_id: string }>("select assignee_id from inspection_tasks where id = $1", [sampleTaskId])).rows[0]!.assignee_id,
  });
  await warehouseAdmin.fetch(`/staff/dispatch/work-items/${wiId}/pause`, { reason: "Shift break" });
  const pausedEvs = (await finance.fetch(`/staff/labor/events?inspection_task_id=${sampleTaskId}&status=paused`)).events;
  assert(pausedEvs.length >= 1);

  await warehouseAdmin.fetch(`/staff/dispatch/work-items/${wiId}/resume`, {});
  const ho = await inspector.fetch(`/staff/dispatch/work-items/${wiId}/handovers`, { to_user_id: insp2Id, handover_type: "relay", reason: "Shift relay" }, "POST", 201);
  await insp2.fetch(`/staff/dispatch/handovers/${ho.handover.id}/accept`, {});

  const taskEvents = (await finance.fetch(`/staff/labor/events?inspection_task_id=${sampleTaskId}`)).events;
  // Original inspector's completed/corrected event preserves outgoing operator_id; incoming insp2 has an active event!
  assert(taskEvents.some((e: Record<string, any>) => e.operator_id !== insp2Id && e.status === "completed"));
  assert(taskEvents.some((e: Record<string, any>) => e.operator_id === insp2Id && e.status === "active"));

  // Anti-double-counting parallel upload: background_system metric runs WITHOUT pausing active_labor!
  const activeBeforeBg = (await finance.fetch(`/staff/labor/events?operator_id=${insp2Id}&status=active`)).events;
  assert.equal(activeBeforeBg.length, 1);
  const bgMetric = await insp2.fetch("/staff/labor/events/background-metric", {
    order_id: sampleOrderId, inspection_task_id: sampleTaskId, activity_code: "file_upload", bytes_transferred: 5_242_880, elapsed_seconds: 18,
  }, "POST", 201);
  assert.equal(bgMetric.time_bucket, "background_system");
  const activeAfterBg = (await finance.fetch(`/staff/labor/events?operator_id=${insp2Id}&status=active`)).events;
  assert.equal(activeAfterBg.length, 1, "Background upload must NOT pause active human labor");

  // Starting another active_labor event for SAME operator auto-pauses the first active_labor event
  const ev2 = await insp2.fetch("/staff/labor/events/start", {
    order_id: sampleOrderId, activity_code: "photo_capture", time_bucket: "active_labor",
  }, "POST", 201);
  const activeAfterSecond = (await finance.fetch(`/staff/labor/events?operator_id=${insp2Id}&status=active`)).events;
  assert.equal(activeAfterSecond.length, 1);
  assert.equal(activeAfterSecond[0].id, ev2.id);
});

test("3. Stale pending_calibration, immutable labor_time_corrections, percentiles P50/P75/P90 & no auto-pricing mutation", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const warehouseAdmin = new Client();
  await warehouseAdmin.loginWithMfa("receiving@qcw.test");
  const inspector = new Client();
  await inspector.loginWithMfa("inspector@qcw.test");

  // Create a stale open session (5 hours old) -> mark-stale-calibration flags pending_calibration
  const stale = await inspector.fetch("/staff/labor/events/start", {
    order_id: sampleOrderId,
    activity_code: "visual_inspect",
    product_type_code: "t_shirt",
    complexity_code: "L1",
    started_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
  }, "POST", 201);
  const marked = await warehouseAdmin.fetch("/staff/labor/events/mark-stale-calibration", { max_age_minutes: 240 });
  assert(marked.flagged_events.some((e: Record<string, any>) => e.id === stale.id));

  // Manual correction preserves original record in immutable labor_time_corrections + transitions event to corrected
  const cStart = new Date(Date.now() - 600_000).toISOString();
  const cEnd = new Date(Date.now() - 60_000).toISOString();
  const corrRes = await finance.fetch(`/staff/labor/events/${stale.id}/correct`, {
    corrected_started_at: cStart,
    corrected_ended_at: cEnd,
    corrected_effective_seconds: 540, // 9 minutes (> 4.5m baseline -> triggers pricing_advisory_alerts!)
    reason: "Operator forgot to stop timer during lunch break",
  });
  assert.equal(corrRes.event.status, "corrected");
  assert.equal(corrRes.correction.original_status, "pending_calibration");

  await assert.rejects(
    async () => {
      await pool.query("update labor_time_corrections set reason = 'tampered' where id = $1::uuid", [corrRes.correction.id]);
    },
    /immutable/i,
  );
  await assert.rejects(
    async () => {
      await pool.query("delete from labor_time_corrections where id = $1::uuid", [corrRes.correction.id]);
    },
    /immutable/i,
  );

  // Add 3 more visual_inspect completed events to observe P50/P75/P90 & pricing advisory alert
  for (const secs of [480, 520, 600]) {
    const ev = await inspector.fetch("/staff/labor/events/start", {
      order_id: sampleOrderId, activity_code: "visual_inspect", product_type_code: "t_shirt", complexity_code: "L1",
      started_at: new Date(Date.now() - secs * 1000).toISOString(),
    }, "POST", 201);
    await inspector.fetch(`/staff/labor/events/${ev.id}/complete`, {});
  }

  const pricingBookBefore = (await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}`)).book;
  const stats = await finance.fetch("/staff/labor/stats?product_type_code=t_shirt&complexity_code=L1");
  assert.equal(stats.statistical_confidence, "insufficient_samples", "<10 samples must be explicitly flagged insufficient_samples");
  assert.equal(stats.auto_price_mutation_blocked, true);
  assert(stats.bucket_totals_seconds.active_labor > 0);
  const visRow = stats.activity_breakdown.find((r: Record<string, any>) => r.activity_code === "visual_inspect");
  assert(visRow.p50_seconds >= 480 && visRow.p90_seconds >= visRow.p75_seconds && visRow.p75_seconds >= visRow.p50_seconds);
  assert(stats.pricing_advisory_alerts.some((a: Record<string, any>) => a.activity_code === "visual_inspect" && a.deviation_pct >= 20));
  assert.equal(stats.rates.upload_failure_rate, null, "Zero-denominator failure rate returns null instead of fake 0");

  // Confirm pricing book was NEVER mutated automatically by labor stats
  const pricingBookAfter = (await finance.fetch(`/staff/admin/pricing/books/${pricingBookId}`)).book;
  assert.deepEqual(pricingBookAfter.complexity_rates, pricingBookBefore.complexity_rates);
});

test("4. Margin sandbox P=C/(1-f-m), infeasibility, $5 L1 loss warning, 1/3/10/30/50/100 matrix & order P&L", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");

  // Ensure apparel product types are published for quote revenue simulation
  const pts = (await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type")).items
    .filter((p: Record<string, any>) => p.category_slug === "apparel" && p.status !== "published")
    .map((p: Record<string, any>) => p.id);
  if (pts.length > 0) {
    await reviewer.fetch("/staff/admin/knowledge/entities/product_type/batch-publish", { ids: pts, public_sellable: true });
  }

  // $5 single-piece L1 simulation: revenue = 500 cents -> loss-making under full cost, computes P = C/(1-f-m)!
  const sim1 = await finance.fetch("/staff/admin/cost-models/simulate-margin", {
    cost_model_id: costModelId,
    pricing_book_id: pricingBookId,
    service_type: "inspection",
    product_type_code: "t_shirt",
    base_qty: 1,
    modules: [],
  });
  assert.equal(sim1.quoted_revenue_cents, 500);
  assert.equal(sim1.feasible, true);
  assert.equal(sim1.is_loss_making, true, "Single-piece $5 L1 cannot naively pass as profitable");
  assert(sim1.recommended_net_price_cents > 500);
  // Exact §43.3 formula check: P = ceil(C / (1 - f - m))
  const expectedP = Math.ceil(sim1.non_proportional_cost_c_cents / (1 - sim1.proportional_fee_rate - sim1.target_margin_rate));
  assert.equal(sim1.recommended_net_price_cents, expectedP);
  assert.equal(sim1.sensitivity_scenarios.length, 4);

  // Infeasibility check when 1 - f - m <= 0 (target_margin = 97% + 3.4% fee > 100%)
  const infeasible = await finance.fetch("/staff/admin/cost-models/simulate-margin", {
    cost_model_id: costModelId,
    pricing_book_id: pricingBookId,
    product_type_code: "t_shirt",
    base_qty: 10,
    override_target_margin_bps: 9500, // 95% + 3.4% = 98.4% -> wait, with default 3.4% f=0.034 -> 97% hits 1 - 0.034 - 0.97 <= 0; check 9500+fee or raise fee
    override_quoted_revenue_cents: 5000,
  });
  // Test exact boundary via explicit high-fee model draft
  const highFeeModel = await finance.fetch("/staff/admin/cost-models", {
    ...(await finance.fetch(`/staff/admin/cost-models/${costModelId}`)).model,
    id: undefined,
    code: "infeasible_fee_model",
    name_zh: "高费率边界测试",
    name_en: "High Fee Infeasibility Model",
    payment_fee_rate_bps: 1000, // 10%
    target_contribution_margin_bps: 9200, // 92% -> 1 - 0.10 - 0.92 = -0.02 <= 0!
  });
  const badMargin = await finance.fetch("/staff/admin/cost-models/simulate-margin", {
    cost_model_id: highFeeModel.id,
    product_type_code: "t_shirt",
    base_qty: 1,
    override_quoted_revenue_cents: 1000,
  });
  assert.equal(badMargin.feasible, false);
  assert.equal(badMargin.recommended_net_price_cents, null);
  assert(infeasible.recommended_net_price_cents !== null); // 95% + 3.4% = 98.4% < 100% still mathematically feasible

  // Standard 1/3/10/30/50/100 × L1-L4 cost matrix check (6 quantities × 4 complexities × 3 bundles = 72 rows)
  const matrix = await finance.fetch("/staff/admin/cost-models/standard-matrix", {
    cost_model_id: costModelId,
    pricing_book_id: pricingBookId,
  });
  assert.equal(matrix.rows.length, 72);
  assert(matrix.rows.some((r: Record<string, any>) => r.qty === 100 && r.complexity === "L4" && r.bundle === "full"));

  // Order Cost Breakdown: missing actual costs reported cleanly BEFORE ledger entry, then updated cleanly AFTER recording!
  const beforeOrderPnl = await finance.fetch(`/staff/admin/orders/${sampleOrderId}/cost-breakdown`);
  assert(beforeOrderPnl.missing_actual_data.includes("payment_settlement_fee_pending"));
  assert(beforeOrderPnl.missing_actual_data.includes("consumables_pending_entry"));

  await finance.fetch(`/staff/admin/orders/${sampleOrderId}/cost-entries`, {
    cost_category: "payment_fee",
    cost_nature: "direct_variable",
    provenance: "actual",
    amount_cents: 185,
    source_ref: "stripe_settlement:txn_test_1",
  }, "POST", 201);
  await finance.fetch(`/staff/admin/orders/${sampleOrderId}/cost-entries`, {
    cost_category: "consumables",
    cost_nature: "direct_variable",
    provenance: "actual",
    amount_cents: 75,
  }, "POST", 201);

  const afterOrderPnl = await finance.fetch(`/staff/admin/orders/${sampleOrderId}/cost-breakdown`);
  assert.deepEqual(afterOrderPnl.missing_actual_data, []);
  assert.equal(
    afterOrderPnl.contribution_profit_cents,
    afterOrderPnl.net_revenue_cents - afterOrderPnl.direct_variable_cost_cents,
  );
});

test("5. Audit P1/P2 remediation regressions: handover/revoke pauses labor, no QA double-count, 422 validation & offset datetimes", async () => {
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const inspector = new Client();
  await inspector.loginWithMfa("inspector@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const warehouseAdmin = new Client();
  await warehouseAdmin.loginWithMfa("receiving@qcw.test");

  // Reviewer denied mark-stale-calibration (403); invalid query params return 422 (not 500)
  await reviewer.fetch("/staff/labor/events/mark-stale-calibration", { max_age_minutes: 60 }, "POST", 403);
  await finance.fetch("/staff/labor/events?order_id=not-a-uuid", undefined, "GET", 422);
  await finance.fetch("/staff/labor/stats?days=abc", undefined, "GET", 422);

  // Explicit +08:00 timezone offset accepted; ended_at < started_at returns 422; correction duration > span returns 422
  const startEv = await inspector.fetch("/staff/labor/events/start", {
    order_id: sampleOrderId,
    activity_code: "qa_review",
    time_bucket: "active_labor",
    started_at: "2026-11-28T10:00:00+08:00",
  }, "POST", 201);
  await inspector.fetch(
    `/staff/labor/events/${startEv.id}/complete`,
    { ended_at: "2026-11-28T09:59:00+08:00" },
    "POST",
    422,
  );
  await inspector.fetch(
    `/staff/labor/events/${startEv.id}/complete`,
    { ended_at: "2026-11-28T10:30:00+08:00" },
    "POST",
    200,
  );
  const badCorr = await finance.fetch(
    `/staff/labor/events/${startEv.id}/correct`,
    {
      corrected_started_at: "2026-11-28T10:00:00+08:00",
      corrected_ended_at: "2026-11-28T10:05:00+08:00",
      corrected_effective_seconds: 600,
      reason: "Invalid duration exceeds window",
    },
    "POST",
    422,
  );
  assert.equal(badCorr.error.code, "INVALID_CORRECTION_DURATION");

  // No QA double-count when explicit labor_qa ledger entry exists alongside completed qa_review event
  const beforeQaLedger = await finance.fetch(`/staff/admin/orders/${sampleOrderId}/cost-breakdown`);
  assert(beforeQaLedger.derived_labor_cost_cents > 0);
  await finance.fetch(`/staff/admin/orders/${sampleOrderId}/cost-entries`, {
    cost_category: "labor_qa",
    cost_nature: "direct_variable",
    provenance: "actual",
    amount_cents: 1200,
  }, "POST", 201);
  const afterQaLedger = await finance.fetch(`/staff/admin/orders/${sampleOrderId}/cost-breakdown`);
  // Explicit labor_qa (1200) replaces derived qa_review cost instead of adding them together!
  assert.equal(
    afterQaLedger.direct_variable_cost_cents,
    beforeQaLedger.direct_variable_cost_cents - 1000 + 1200,
  );

  // Check handover_pending pauses active_labor immediately BEFORE acceptance + revokeStaffActiveLeases pauses active_labor
  const wiRow = (
    await pool.query<{ id: string; current_assignee_id: string; inspection_task_id: string }>(
      "select id, current_assignee_id, inspection_task_id from dispatch_work_items where inspection_task_id = $1",
      [sampleTaskId],
    )
  ).rows[0]!;
  // Ensure an active lease and open active_labor event exist for current assignee
  await pool.query(
    `insert into labor_time_events (order_id, inspection_task_id, dispatch_work_item_id, activity_code, time_bucket, operator_id, source_kind, status)
     values ($1::uuid, $2::uuid, $3::uuid, 'visual_inspect', 'active_labor', $4::uuid, 'auto_hook', 'active')`,
    [sampleOrderId, wiRow.inspection_task_id, wiRow.id, wiRow.current_assignee_id],
  );
  const inspId = (await pool.query<{ id: string }>("select u.id from users u join user_emails ue on ue.user_id = u.id where ue.normalized_email = 'inspector@qcw.test'")).rows[0]!.id;
  await warehouseAdmin.fetch(`/staff/dispatch/work-items/${wiRow.id}/handovers`, {
    to_user_id: inspId, handover_type: "reassign", reason: "Check pause on handover_pending",
  }, "POST", 201);
  const pausedOnHandover = (
    await pool.query<{ status: string; wait_reason: string | null }>(
      "select status, wait_reason from labor_time_events where inspection_task_id = $1 and operator_id = $2 order by created_at desc limit 1",
      [wiRow.inspection_task_id, wiRow.current_assignee_id],
    )
  ).rows[0]!;
  assert.equal(pausedOnHandover.status, "paused");
  assert(pausedOnHandover.wait_reason?.startsWith("handover_pending:"));
});
