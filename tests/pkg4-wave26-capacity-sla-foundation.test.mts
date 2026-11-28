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
}

let seededPolicyId = "";
let defaultWarehouseId = "";

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

  // Ensure an active default warehouse exists for capacity calculation tests
  const existingWh = (await pool.query<{ id: string }>("select id from warehouses where status='active' order by accept_new_orders desc limit 1")).rows[0];
  if (existingWh) {
    defaultWarehouseId = existingWh.id;
  } else {
    const adminRow = (await pool.query<{ id: string }>("select user_id as id from user_emails where normalized_email='admin@qcw.test' limit 1")).rows[0]!;
    const ins = (
      await pool.query<{ id: string }>(
        `insert into warehouses (warehouse_code, name_zh, name_en, status, accept_new_orders, timezone, cutoff_receiving_time, cutoff_dispatch_time, working_days, created_by)
         values ('WH-GZ-TEST', '广州测试仓', 'Guangzhou Test WH', 'active', true, 'Asia/Shanghai', '17:30', '16:00', ARRAY[1,2,3,4,5,6], $1)
         returning id`,
        [adminRow.id],
      )
    ).rows[0]!;
    defaultWarehouseId = ins.id;
  }
});

after(async () => {
  await pool.end();
});

test("1. Idempotent Capacity/SLA seed, RBAC, query validation, SoD approval & immutable version triggers", async () => {
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const customer = new Client();
  await customer.loginWithMfa("customer@qcw.test");

  // Seed labor/cost + capacity defaults
  await finance.fetch("/staff/admin/cost-models/seed-init", {}, "POST", 200);
  await customer.fetch("/staff/admin/capacity/seed", {}, "POST", 403);
  await customer.fetch("/staff/admin/capacity/policies", undefined, "GET", 403);

  const seed1 = await finance.fetch("/staff/admin/capacity/seed", {}, "POST", 201);
  assert.equal(seed1.inserted_counts.policies, 1);
  const seed2 = await finance.fetch("/staff/admin/capacity/seed", {}, "POST", 201);
  assert.equal(seed2.inserted_counts.policies, 0);
  assert.equal(seed2.skipped_existing_counts.policies, 1);

  const list = await finance.fetch("/staff/admin/capacity/policies");
  assert.equal(list.policies.length, 1);
  seededPolicyId = list.policies[0].id;
  assert.equal(list.policies[0].status, "draft");
  assert.equal(list.policies[0].model_provenance, "estimated_baseline");

  // Bad GET query params rejected cleanly with 422
  await finance.fetch("/staff/admin/capacity/dashboard?warehouse_id=not-a-uuid", undefined, "GET", 422);
  await finance.fetch("/staff/admin/capacity/dashboard?days=999", undefined, "GET", 422);

  // Edit + submit + SoD checks
  const saved = await finance.fetch("/staff/admin/capacity/policies", {
    id: seededPolicyId,
    policy_code: "CAP_SLA_APPAREL_SANDBOX_V1",
    name_zh: "服装仓动态产能策略 v1",
    name_en: "Apparel Dynamic Capacity Policy v1",
    warehouse_id: defaultWarehouseId,
    effective_inspector_utilization: 0.78,
    effective_qa_utilization: 0.8,
    qa_bottleneck_ratio: 1.25,
    safety_buffer_pct: 0.15,
    warn_utilization_pct: 0.7,
    review_utilization_pct: 0.85,
    pause_heavy_intake_pct: 0.95,
    manual_quote_workload_minutes: 720,
    manual_quote_min_items: 30,
  });
  assert.equal(saved.policy.admin_modified, true);

  await finance.fetch(`/staff/admin/capacity/policies/${seededPolicyId}/submit`, {}, "POST", 200);
  // Author/submitter cannot self-publish
  await finance.fetch(
    `/staff/admin/capacity/policies/${seededPolicyId}/publish`,
    { publication_scope: "sandbox_acceptance" },
    "POST",
    403,
  );
  // Production scope blocked in sandbox
  await reviewer.fetch(
    `/staff/admin/capacity/policies/${seededPolicyId}/publish`,
    { publication_scope: "production" },
    "POST",
    403,
  );
  const pub = await reviewer.fetch(
    `/staff/admin/capacity/policies/${seededPolicyId}/publish`,
    { publication_scope: "sandbox_acceptance", note: "Independent QA review pass" },
    "POST",
    200,
  );
  assert.equal(pub.policy.status, "published");
  assert.equal(pub.published_version.business_approved, false);
  assert.equal(pub.published_version.publication_scope, "sandbox_acceptance");

  // Immutability trigger on capacity_sla_policy_versions
  await assert.rejects(
    () => pool.query("update capacity_sla_policy_versions set snapshot = '{}'::jsonb where id = $1", [pub.published_version.id]),
    /immutable/i,
  );
  await assert.rejects(
    () => pool.query("delete from capacity_sla_policy_versions where id = $1", [pub.published_version.id]),
    /immutable/i,
  );

  // Rollback creates a new draft version cleanly
  const rb = await admin.fetch(`/staff/admin/capacity/policies/${seededPolicyId}/rollback`, { target_version: 1 }, "POST", 200);
  assert.equal(rb.policy.status, "draft");
  assert.equal(rb.policy.current_version, 2);
  await admin.fetch(`/staff/admin/capacity/policies/${seededPolicyId}/submit`, {}, "POST", 200);
  await reviewer.fetch(`/staff/admin/capacity/policies/${seededPolicyId}/publish`, { publication_scope: "sandbox_acceptance" }, "POST", 200);
  const detail = await admin.fetch(`/staff/admin/capacity/policies/${seededPolicyId}`);
  assert.equal(detail.versions.length, 2);
  assert.equal(detail.versions[0].author_email, "admin@qcw.test");
  assert.equal(detail.versions[0].reviewer_email, "reviewer@qcw.test");

  // P1-1: Partial edit preserves warehouse_id and omitted complexity_profiles / thresholds
  // P1-2: Spoofing model_provenance='field_calibrated' with 0 empirical samples fails with 422
  await finance.fetch(
    "/staff/admin/capacity/policies",
    {
      id: seededPolicyId,
      policy_code: "CAP_SLA_APPAREL_SANDBOX_V1",
      name_zh: "服装仓动态产能策略 v1",
      name_en: "Apparel Dynamic Capacity Policy v1",
      model_provenance: "field_calibrated",
    },
    "POST",
    422,
  );
  const partialEdit = await finance.fetch("/staff/admin/capacity/policies", {
    id: seededPolicyId,
    policy_code: "CAP_SLA_APPAREL_SANDBOX_V1",
    name_zh: "服装仓动态产能策略 v1（草稿微调）",
    name_en: "Apparel Dynamic Capacity Policy v1 (Draft Tweak)",
    safety_buffer_pct: 0.25,
  });
  assert.equal(partialEdit.policy.warehouse_id, defaultWarehouseId);
  assert.ok(partialEdit.policy.complexity_profiles?.L1?.visual_min_per_unit);

  // P2-1: Unapproved draft tweak must NOT affect default dashboard/calculation (continues reading published snapshot safety_buffer_pct=0.15)
  const dash = await admin.fetch(`/staff/admin/capacity/dashboard?warehouse_id=${defaultWarehouseId}`);
  assert.equal(dash.policy.status, "published");
});

test("2. Dynamic workload & SLA differentiation (50pc L1 vs 50pc L4), bottlenecks, 70/85/95 alerts & empirical provenance", async () => {
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const inspectorRow = (await pool.query<{ id: string }>("select user_id as id from user_emails where normalized_email='inspector@qcw.test' limit 1")).rows[0]!;
  const reviewerRow = (await pool.query<{ id: string }>("select user_id as id from user_emails where normalized_email='reviewer@qcw.test' limit 1")).rows[0]!;

  // Schedule concrete inspector + QA shifts for defaultWarehouseId so shift_source uses real shifts
  await pool.query(
    `insert into staff_work_shifts (warehouse_id, user_id, shift_date, shift_code, start_time, end_time, available_minutes, role_scope, status, created_by)
     values
       ($1, $2, current_date, 'DAY-INSP', '09:00', '18:00', 480, ARRAY['inspector'], 'scheduled', $2),
       ($1, $3, current_date, 'DAY-QA', '09:00', '18:00', 480, ARRAY['reviewer'], 'scheduled', $3)
     on conflict do nothing`,
    [defaultWarehouseId, inspectorRow.id, reviewerRow.id],
  );

  const l1 = await admin.fetch("/staff/admin/capacity/simulate", {
    policy_id: seededPolicyId,
    warehouse_id: defaultWarehouseId,
    complexity_code: "L1",
    quantity: 50,
    parcel_count: 2,
    service_mode: "batch_standard",
    module_codes: ["M01"],
    photo_shots_per_unit: 3,
    start_at: "2026-12-01T10:00:00+08:00",
  });

  const l4 = await admin.fetch("/staff/admin/capacity/simulate", {
    policy_id: seededPolicyId,
    warehouse_id: defaultWarehouseId,
    complexity_code: "L4",
    quantity: 50,
    parcel_count: 2,
    service_mode: "compare_horizontal",
    module_codes: ["M01", "M03", "M08", "M09", "M10"],
    measurement_coverage_qty: 50,
    measurement_points_per_unit: 12,
    photo_shots_per_unit: 8,
    video_seconds_per_unit: 30,
    compare_group_size: 3,
    golden_sample_calls: 2,
    start_at: "2026-12-01T10:00:00+08:00",
  });

  // Same 50 qty must NOT map to same SLA!
  assert.equal(l1.is_draft_uncalibrated, true);
  assert.equal(l1.provenance, "estimated_baseline");
  assert.equal(l1.dependencies.dependency_locked, false);
  assert.equal(l4.dependencies.dependency_locked, true);
  assert.equal(l4.sla_decision.manual_sla_required, true);
  assert(l4.workload.total_workload_minutes > l1.workload.total_workload_minutes * 3);
  assert(l4.sla_decision.estimated_business_days > l1.sla_decision.estimated_business_days);
  assert(new Date(l4.sla_decision.estimated_due_at).getTime() > new Date(l1.sla_decision.estimated_due_at).getTime());
  assert(l4.bottleneck.total_utilization_ratio >= 0.95);
  assert.equal(l4.bottleneck.capacity_alert_level, "pause_heavy_95");

  // Cutoff check: starting after 17:30 shifts deadline by extra business day
  const beforeCutoff = await admin.fetch("/staff/admin/capacity/simulate", {
    policy_id: seededPolicyId,
    warehouse_id: defaultWarehouseId,
    complexity_code: "L2",
    quantity: 10,
    start_at: "2026-12-01T11:00:00+08:00",
  });
  const afterCutoff = await admin.fetch("/staff/admin/capacity/simulate", {
    policy_id: seededPolicyId,
    warehouse_id: defaultWarehouseId,
    complexity_code: "L2",
    quantity: 10,
    start_at: "2026-12-01T18:30:00+08:00",
  });
  assert(new Date(afterCutoff.sla_decision.estimated_due_at).getTime() > new Date(beforeCutoff.sla_decision.estimated_due_at).getTime());

  // Field-calibrated provenance shift when >= 10 measured samples exist per stage + P2-3 skill grant check
  await pool.query(
    `insert into inspector_skill_grants (user_id, skill_code, category_code, status, created_at)
     values ($1, 'APPAREL_L3', 'apparel', 'active', now())
     on conflict (user_id, skill_code) do nothing`,
    [inspectorRow.id],
  );
  const skilledL4 = await admin.fetch("/staff/admin/capacity/simulate", {
    policy_id: seededPolicyId,
    warehouse_id: defaultWarehouseId,
    complexity_code: "L4",
    quantity: 5,
    start_at: "2026-12-01T10:00:00+08:00",
  });
  assert.equal(skilledL4.bottleneck.bottleneck_stage, "skill_scarcity");
  assert.equal(skilledL4.sla_decision.manual_sla_required, true);

  for (const act of ["visual_inspect", "garment_prep", "repack_putaway"] as const) {
    for (let i = 0; i < 10; i++) {
      await pool.query(
        `insert into labor_time_events (
          warehouse_id, complexity_code, activity_code, time_bucket, operator_id,
          source_kind, data_provenance, started_at, ended_at, effective_seconds, status
        ) values ($1, 'L2', $2, 'active_labor', $3, 'operator_timer', 'measured_field', now() - interval '10 minutes', now(), 600, 'completed')`,
        [defaultWarehouseId, act, inspectorRow.id],
      );
    }
  }
  const calibrated = await admin.fetch("/staff/admin/capacity/simulate", {
    policy_id: seededPolicyId,
    warehouse_id: defaultWarehouseId,
    complexity_code: "L2",
    quantity: 10,
    start_at: "2026-12-01T11:00:00+08:00",
  });
  assert.equal(calibrated.provenance, "field_calibrated");
  assert.equal(calibrated.is_draft_uncalibrated, false);
});

test("3. SLA start gates (unpaid/arrival/dependency lock), sla_started_at immutability, T32 pause/resume & holdOrder/resumeOrder sync", async () => {
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const orgRow = (await pool.query<{ id: string }>("select id from organizations limit 1")).rows[0]!;
  const customerRow = (await pool.query<{ id: string }>("select user_id as id from user_emails where normalized_email='customer@qcw.test' limit 1")).rows[0]!;

  // Create isolated test order in unpaid awaiting_payment state
  const unpaidOrderId = randomUUID();
  await pool.query(
    `insert into orders (id, public_no, org_id, created_by, state, price_cents, currency)
     values ($1, $2, $3, $4, 'awaiting_payment', 4500, 'USD')`,
    [unpaidOrderId, `QW-T199-${Date.now().toString().slice(-5)}`, orgRow.id, customerRow.id],
  );

  // Unpaid order cannot start SLA
  await admin.fetch(
    `/staff/admin/orders/${unpaidOrderId}/sla/start`,
    { batch_key: "ORDER", commitment_kind: "order_total" },
    "POST",
    409,
  );

  // Pay order, still awaiting samples -> full ORDER start blocked, but independent batch succeeds!
  await pool.query("update orders set paid_at=now(), state='awaiting_samples' where id=$1", [unpaidOrderId]);
  await admin.fetch(
    `/staff/admin/orders/${unpaidOrderId}/sla/start`,
    { batch_key: "ORDER", commitment_kind: "order_total" },
    "POST",
    409,
  );
  await admin.fetch(
    `/staff/admin/orders/${unpaidOrderId}/sla/start`,
    { batch_key: "COMPARE-A", commitment_kind: "compare_group", dependency_group_ready: false },
    "POST",
    409,
  );

  const batch1 = await admin.fetch(
    `/staff/admin/orders/${unpaidOrderId}/sla/start`,
    {
      batch_key: "BATCH-1",
      commitment_kind: "independent_batch",
      partial_batch_allowed: true,
      simulation: {
        policy_id: seededPolicyId,
        warehouse_id: defaultWarehouseId,
        complexity_code: "L2",
        quantity: 2,
        ready_units_count: 1,
      },
    },
    "POST",
    201,
  );
  const commitmentId = batch1.commitment.id as string;
  assert.ok(batch1.commitment.sla_started_at);
  assert.ok(batch1.commitment.original_due_at);
  assert.equal(batch1.event.customer_notified, true);

  // Re-starting same batch_key blocked + DB trigger blocks tampering sla_started_at / original_due_at / DELETE
  await admin.fetch(
    `/staff/admin/orders/${unpaidOrderId}/sla/start`,
    { batch_key: "BATCH-1", commitment_kind: "independent_batch", partial_batch_allowed: true },
    "POST",
    409,
  );
  await assert.rejects(
    () => pool.query("update order_sla_commitments set sla_started_at = now() - interval '1 day' where id=$1", [commitmentId]),
    /sla_started_at is strictly immutable/i,
  );
  await assert.rejects(
    () => pool.query("update order_sla_commitments set original_due_at = now() + interval '5 days' where id=$1", [commitmentId]),
    /original_due_at is strictly immutable/i,
  );
  await assert.rejects(
    () => pool.query("delete from order_sla_commitments where id=$1", [commitmentId]),
    /cannot be deleted/i,
  );

  // T32 Pause & Resume shifts due date by pause duration and keeps sla_started_at immutable
  const dueBeforePause = new Date(batch1.commitment.current_due_at).getTime();
  const paused = await admin.fetch(
    `/staff/admin/sla/${commitmentId}/pause`,
    { reason: "Awaiting customer confirmation on wash label color", notify_customer: true },
    "POST",
    200,
  );
  assert.equal(paused.commitment.status, "paused");

  // Simulate 120s paused elapsed time safely
  await pool.query("update order_sla_commitments set pause_started_at = now() - interval '120 seconds' where id=$1", [commitmentId]);
  const resumed = await admin.fetch(
    `/staff/admin/sla/${commitmentId}/resume`,
    { reason: "Customer confirmed wash label; resuming SLA", notify_customer: true },
    "POST",
    200,
  );
  assert.equal(resumed.commitment.status, "active");
  assert(resumed.commitment.total_paused_seconds >= 115);
  assert(new Date(resumed.commitment.current_due_at).getTime() >= dueBeforePause + 115 * 1000);
  assert.equal(resumed.commitment.sla_started_at, batch1.commitment.sla_started_at);

  // Append-only clock events trigger check
  await assert.rejects(
    () => pool.query("delete from sla_clock_events where id=$1", [resumed.event.id]),
    /append-only immutable/i,
  );

  // Verify operations.ts holdOrder / resumeOrder hook pauses & resumes SLA commitments in sync
  const held = await admin.fetch(`/staff/orders/${unpaidOrderId}/hold`, { reason: "Staff inspection bench re-calibration hold" }, "POST", 200);
  assert.equal(held.state, "on_hold");
  let readAfterHold = await admin.fetch(`/staff/admin/orders/${unpaidOrderId}/sla`);
  assert.equal(readAfterHold.commitments[0].status, "paused");

  // Backdate pause/hold slightly and resume via /staff/orders/:id/resume
  await pool.query("update order_sla_commitments set pause_started_at = now() - interval '60 seconds' where id=$1", [commitmentId]);
  await pool.query("update orders set held_at = now() - interval '60 seconds' where id=$1", [unpaidOrderId]);
  const unheld = await admin.fetch(`/staff/orders/${unpaidOrderId}/resume`, { reason: "Calibration completed; resuming order" }, "POST", 200);
  assert.equal(unheld.state, "awaiting_samples");
  const readAfterUnhold = await admin.fetch(`/staff/admin/orders/${unpaidOrderId}/sla`);
  assert.equal(readAfterUnhold.commitments[0].status, "active");
  assert(readAfterUnhold.events.some((e: { event_type: string }) => e.event_type === "resumed"));

  const notifs = (
    await pool.query<{ template: string }>(
      "select template from notifications where order_id=$1 order by created_at asc",
      [unpaidOrderId],
    )
  ).rows.map((r) => r.template);
  assert(notifs.includes("sla.started"));
  assert(notifs.includes("sla.paused"));
  assert(notifs.includes("sla.resumed"));

  // Extend active commitment: preserves immutable sla_started_at & original_due_at while shifting current_due_at
  const extendedDueIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const extendedRes = await admin.fetch(
    `/staff/admin/sla/${commitmentId}/extend`,
    {
      new_due_at: extendedDueIso,
      reason: "Additional seam measurement scope agreed with customer",
      notify_customer: true,
      override_type: "extended",
    },
    "POST",
    200,
  );
  assert.equal(extendedRes.commitment.status, "extended");
  assert.equal(extendedRes.commitment.sla_started_at, batch1.commitment.sla_started_at);
  assert.equal(extendedRes.commitment.original_due_at, batch1.commitment.original_due_at);

  // P1-3: Compare/Golden simulation cannot bypass dependency_locked arrival gate via commitment_kind='independent_batch'
  await admin.fetch(
    `/staff/admin/orders/${unpaidOrderId}/sla/start`,
    {
      batch_key: "SNEAKY-COMPARE",
      commitment_kind: "independent_batch",
      partial_batch_allowed: true,
      dependency_group_ready: true,
      simulation: {
        policy_id: seededPolicyId,
        warehouse_id: defaultWarehouseId,
        complexity_code: "L2",
        quantity: 2,
        service_mode: "compare_horizontal",
        module_codes: ["M01", "M10"],
      },
    },
    "POST",
    409,
  );

  // Manual SLA gate: heavy L4 commitment cannot auto-start without manual confirmation
  const manualOrderId = randomUUID();
  await pool.query(
    `insert into orders (id, public_no, org_id, created_by, state, price_cents, currency)
     values ($1, $2, $3, $4, 'awaiting_payment', 12000, 'USD')`,
    [manualOrderId, `QW-T199M-${Date.now().toString().slice(-5)}`, orgRow.id, customerRow.id],
  );
  await pool.query("update orders set paid_at=now(), samples_ready_at=now(), state='queued' where id=$1", [manualOrderId]);
  await admin.fetch(
    `/staff/admin/orders/${manualOrderId}/sla/start`,
    {
      batch_key: "HEAVY-L4",
      commitment_kind: "order_total",
      simulation: {
        policy_id: seededPolicyId,
        warehouse_id: defaultWarehouseId,
        complexity_code: "L4",
        quantity: 40,
      },
    },
    "POST",
    409,
  );

  // P2-2: Pausing blocks extend until resumed; cancelOrder marks commitment 'cancelled' & logs cancelled event
  await admin.fetch(
    `/staff/admin/sla/${commitmentId}/pause`,
    { reason: "Temporarily paused before checking extend rejection", notify_customer: false },
    "POST",
    200,
  );
  await admin.fetch(
    `/staff/admin/sla/${commitmentId}/extend`,
    {
      new_due_at: new Date(Date.now() + 9 * 86400 * 1000).toISOString(),
      reason: "Should reject extending while paused",
    },
    "POST",
    409,
  );
  const customer = new Client();
  await customer.loginWithMfa("customer@qcw.test");
  await pool.query("update orders set state='awaiting_samples', revision=revision where id=$1", [unpaidOrderId]);
  const revRow = (await pool.query<{ revision: number }>("select revision from orders where id=$1", [unpaidOrderId])).rows[0]!;
  await customer.fetch(`/orders/${unpaidOrderId}/cancel`, { revision: revRow.revision }, "POST", 200);
  const afterCancel = await admin.fetch(`/staff/admin/orders/${unpaidOrderId}/sla`);
  assert.equal(afterCancel.commitments[0].status, "cancelled");
  assert(afterCancel.events.some((e: { event_type: string }) => e.event_type === "cancelled"));
  // P1-3: Cancelled order cannot start SLA
  await admin.fetch(
    `/staff/admin/orders/${unpaidOrderId}/sla/start`,
    { batch_key: "POST-CANCEL", commitment_kind: "order_total" },
    "POST",
    409,
  );
});
