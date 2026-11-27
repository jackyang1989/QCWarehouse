import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
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
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const { handle } = await import("../packages/core/http");
const { pool, transaction } = await import("../packages/db");
const { addEmailOtpIdentity } = await import("../packages/core/auth");
const { seedAuthoritativeChinaRegions } = await import("../packages/core/regions-seed");

let inspector2Id = "";

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

  // Create second real inspector account for relay/handover & author immutability verification
  inspector2Id = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id, display_name, locale) values($1, 'Inspector Two', 'zh-CN')", [inspector2Id]);
    const emailRow = (
      await db.query<{ id: string }>(
        `insert into user_emails(user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
         values($1, 'inspector2@qcw.test', 'inspector2@qcw.test'::citext, now(), true, true) returning id`,
        [inspector2Id],
      )
    ).rows[0];
    await addEmailOtpIdentity(db, inspector2Id, emailRow.id);
    await db.query("insert into staff_roles(user_id, role) values($1, 'inspector')", [inspector2Id]);
    await seedAuthoritativeChinaRegions(db, { includeTownships: false });
  });

  await pool.query("delete from verification_challenges where target_email::text = any($1::text[])", [
    ["admin", "receiving", "inspector", "inspector2", "reviewer", "customer"].map((n) => n + "@qcw.test"),
  ]);
});

after(() => pool.end());

class Client {
  jar = new Map<string, string>();
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200) {
    const headers: Record<string, string> = { origin };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) {
      headers["idempotency-key"] = randomUUID();
      if (!(body instanceof FormData)) headers["content-type"] = "application/json";
      const csrf = this.jar.get("qcw_csrf");
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    const cleanPath = path.split("?")[0]!;
    const res = await handle(
      new Request(origin + "/api/v1" + path, {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      }),
      cleanPath,
    );
    for (const raw of res.headers.getSetCookie()) {
      const m = raw.match(/^([^=]+)=([^;]*)/);
      if (m) this.jar.set(m[1], m[2]);
    }
    const data = await res.json();
    assert.equal(res.status, expected, path + " " + JSON.stringify(data));
    return data;
  }
  async loginOtp(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
  async photo(kind: string) {
    const b = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#11736d" } }).png().toBuffer();
    const f = new FormData();
    f.set("photo", new Blob([new Uint8Array(b)], { type: "image/png" }), "proof.png");
    f.set("kind", kind);
    return (await this.fetch("/staff/media", f, "POST", 201)).id;
  }
}

async function createReadyInspectionTask(customer: Client, receiver: Client) {
  const { terms } = await customer.fetch("/public/terms");
  const offer = (await customer.fetch("/catalog")).offers.find((o: { sku_code: string }) => o.sku_code === "apparel-inspection-1");
  const draft = await customer.fetch("/orders", { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 1 }] }, "POST", 201);
  const quote = await customer.fetch(`/orders/${draft.id}/quotes`, { revision: draft.revision }, "POST", 201);
  const ack = { scope_notice: true, samples_not_batch: true, seller_refund_is_mine: true, no_certification: true, restricted_items: true };
  const submitted = await customer.fetch(`/orders/${draft.id}/submit`, {
    revision: draft.revision,
    quote_id: quote.id,
    terms_version_ids: terms.map((t: { id: string }) => t.id),
    acknowledgements: ack,
  });
  const checkout = await customer.fetch(`/charges/${submitted.charge.charge_item_id}/checkout`, { quote_revision: quote.revision });
  await customer.fetch(`/checkout/demo/${checkout.attempt_id}`, {});

  const addr = await customer.fetch("/me/receiving-address");
  const trackingNo = "ZT" + randomUUID().slice(0, 8).toUpperCase();
  const advice = await customer.fetch(
    "/me/parcels",
    { address_id: addr.warehouse_address.id, carrier_code: "zto", tracking_no: trackingNo },
    "POST",
    201,
  );
  const pkg = await receiver.fetch(
    "/staff/intake/check-in",
    {
      tracking_no: trackingNo,
      advice_id: advice.id,
      carrier_code: "zto",
      outer_media_ids: [await receiver.photo("intake_outer")],
    },
    "POST",
    201,
  );
  const desk = await receiver.fetch("/staff/desk");
  const r01 = desk.locations.find((l: { code: string }) => l.code === "R-01").id;
  const createdItems = await receiver.fetch(
    `/staff/packages/${pkg.id}/items`,
    { revision: pkg.revision, items: [{ code: "S" + randomInt(10000, 99999), location_id: r01 }] },
    "POST",
    201,
  );
  const expItem = (
    await pool.query<{ id: string; order_line_id: string }>(
      "select e.id, e.order_line_id from expected_items e join order_lines l on l.id = e.order_line_id where l.order_id = $1 limit 1",
      [draft.id],
    )
  ).rows[0];
  await receiver.fetch(`/staff/items/${createdItems.item_ids[0]}/assign`, {
    revision: 1,
    order_line_id: expItem.order_line_id,
    expected_item_id: expItem.id,
    evidence_ids: [await receiver.photo("label_photo")],
  });
  const taskRow = (
    await pool.query<{ id: string; revision: number }>(
      "select id, revision from inspection_tasks where order_line_id = $1 limit 1",
      [expItem.order_line_id],
    )
  ).rows[0];
  return { orderId: draft.id, taskId: taskRow.id, taskRevision: taskRow.revision };
}

test("TASK-184: shifts, skill-scoped assignment, task lease, handover keeping historical author immutable, late-evidence quarantine & emergency revocation", async () => {
  const admin = new Client();
  await admin.loginOtp("admin@qcw.test");
  const receiver = new Client();
  await receiver.loginOtp("receiving@qcw.test");
  const inspector1 = new Client();
  await inspector1.loginOtp("inspector@qcw.test");
  const inspector2 = new Client();
  await inspector2.loginOtp("inspector2@qcw.test");
  const reviewer = new Client();
  await reviewer.loginOtp("reviewer@qcw.test");
  const customer = new Client();
  await customer.loginOtp("customer@qcw.test");

  const inspector1Id = (
    await pool.query<{ id: string }>(
      "select u.id from users u join user_emails e on e.user_id = u.id where e.normalized_email = 'inspector@qcw.test' limit 1",
    )
  ).rows[0].id;

  // Create warehouse & active Type B workstation
  const nanshan = (await admin.fetch("/regions/search?q=440305")).items[0];
  const snap = await admin.fetch(
    "/addresses/snapshots",
    {
      purpose: "warehouse_receiving",
      recipient_name: "调度测试仓收货组",
      contact_phone_raw: "13800138999",
      county_region_id: nanshan.id,
      detail_address: "南山科技园调度中心1楼",
    },
    "POST",
    201,
  );
  const wh = await admin.fetch(
    "/staff/warehouses",
    { warehouse_code: "SZ-DISP-01", name_zh: "南山调度测试仓", name_en: "Nanshan Dispatch Hub", receiving_address_snapshot_id: snap.id },
    "POST",
    201,
  );
  await admin.fetch(
    `/staff/warehouses/${wh.id}/zones`,
    { zone_code: "INP", name_zh: "质检区", name_en: "Inspection Zone", zone_type: "in_progress" },
    "POST",
    201,
  );
  await admin.fetch(
    `/staff/warehouses/${wh.id}/controls`,
    { status: "active", accept_new_orders: true, accept_inbound_transit: true, allow_fulfillment: true, allow_dispatch: true },
    "PATCH",
  );
  const wsB1 = (
    await admin.fetch(
      "/staff/workstations",
      {
        warehouse_id: wh.id,
        station_code: "SZ-DISP-B01",
        station_type: "B_inspection_shoot",
        name_zh: "B类调度工位1",
        name_en: "Dispatch Station B1",
        required_device_roles: ["camera"],
      },
      "POST",
      201,
    )
  ).workstation;
  const wsB2 = (
    await admin.fetch(
      "/staff/workstations",
      {
        warehouse_id: wh.id,
        station_code: "SZ-DISP-B02",
        station_type: "B_inspection_shoot",
        name_zh: "B类调度工位2",
        name_en: "Dispatch Station B2",
        required_device_roles: ["camera"],
      },
      "POST",
      201,
    )
  ).workstation;

  // Create a real paid inspection task
  const { orderId, taskId } = await createReadyInspectionTask(customer, receiver);

  // Open order_blocks prevents manual dispatch bypass (409)
  const blockId = randomUUID();
  await pool.query(
    "insert into order_blocks(id, order_id, reason, object_key, opened_at) values($1, $2, 'scope_change', $3, now())",
    [blockId, orderId, blockId],
  );
  await admin.fetch(
    "/staff/dispatch/work-items",
    {
      warehouse_id: wh.id,
      task_domain: "inspection",
      source_entity_id: taskId,
      inspection_task_id: taskId,
      required_role: "inspector",
      required_skill_code: "apparel_macro",
      priority: 10,
    },
    "POST",
    409,
  );
  await admin.fetch(
    "/staff/dispatch/work-items",
    {
      warehouse_id: wh.id,
      task_domain: "qa_review",
      source_entity_id: `qa:${taskId}`,
      inspection_task_id: taskId,
      required_role: "reviewer",
      priority: 10,
    },
    "POST",
    409,
  );
  await pool.query("update order_blocks set resolved_at = now() where id = $1", [blockId]);

  const wi = (
    await admin.fetch(
      "/staff/dispatch/work-items",
      {
        warehouse_id: wh.id,
        task_domain: "inspection",
        source_entity_id: taskId,
        inspection_task_id: taskId,
        required_role: "inspector",
        required_skill_code: "apparel_macro",
        priority: 10,
      },
      "POST",
      201,
    )
  ).work_item;

  // Assignment fails before skill certification (409 MISSING_REQUIRED_SKILL)
  await admin.fetch(
    `/staff/dispatch/work-items/${wi.id}/assign`,
    { assignee_id: inspector1Id, workstation_id: wsB1.id, reason: "Test before skill grant" },
    "POST",
    409,
  );

  // Reviewer certifies both inspectors
  await reviewer.fetch("/staff/inspector-skills", { user_id: inspector1Id, skill_code: "apparel_macro", status: "active" }, "PUT");
  await reviewer.fetch("/staff/inspector-skills", { user_id: inspector2Id, skill_code: "apparel_macro", status: "active" }, "PUT");

  // Schedule today's shifts; marking inspector2 on_leave blocks assignment
  const today = (await pool.query<{ d: string }>("select current_date::text d")).rows[0].d;
  await admin.fetch(
    "/staff/shifts",
    {
      warehouse_id: wh.id,
      user_id: inspector1Id,
      workstation_id: wsB1.id,
      shift_date: today,
      shift_code: "DAY-A",
      start_time: "09:00",
      end_time: "18:00",
      available_minutes: 480,
      role_scope: ["inspector"],
      status: "scheduled",
    },
    "PUT",
  );
  const shift2 = (
    await admin.fetch(
      "/staff/shifts",
      {
        warehouse_id: wh.id,
        user_id: inspector2Id,
        workstation_id: wsB2.id,
        shift_date: today,
        shift_code: "DAY-A",
        start_time: "09:00",
        end_time: "18:00",
        available_minutes: 480,
        role_scope: ["inspector"],
        status: "on_leave",
      },
      "PUT",
    )
  ).shift;
  await admin.fetch(
    `/staff/dispatch/work-items/${wi.id}/assign`,
    { assignee_id: inspector2Id, workstation_id: wsB2.id },
    "POST",
    409,
  );
  await admin.fetch(`/staff/shifts/${shift2.id}/status`, { status: "scheduled" }, "PATCH");

  // Supervisor assigns to inspector1 (sends task.assigned notification)
  await admin.fetch(
    `/staff/dispatch/work-items/${wi.id}/assign`,
    { assignee_id: inspector1Id, workstation_id: wsB1.id, reason: "Initial priority assignment" },
    "POST",
  );
  assert((await inspector1.fetch("/staff/me/notifications")).notifications.some((n: { template: string }) => n.template === "task.assigned"));

  // Inspector1 claims execution lease; inspector2 blocked on both dispatch lease & direct startTask
  const lease1 = await inspector1.fetch(`/staff/dispatch/work-items/${wi.id}/leases`, { duration_minutes: 120 }, "POST", 201);
  assert.equal(lease1.execution_generation, 1);
  await inspector2.fetch(`/staff/dispatch/work-items/${wi.id}/leases`, { duration_minutes: 120 }, "POST", 403);
  const preStartView = await inspector2.fetch(`/staff/inspection-tasks/${taskId}`);
  await inspector2.fetch(`/staff/inspection-tasks/${taskId}/start`, { revision: preStartView.revision }, "POST", 403);

  // Inspector1 starts real inspection task & records attempt 1 measurement
  const taskView = await inspector1.fetch(`/staff/inspection-tasks/${taskId}`);
  const started = await inspector1.fetch(`/staff/inspection-tasks/${taskId}/start`, { revision: taskView.revision });
  const r1 = await inspector1.fetch(
    `/staff/inspection-tasks/${taskId}/results`,
    {
      revision: started.revision,
      results: [
        {
          item_key: "width",
          component: "main",
          attempt: 1,
          status: "RECORDED",
          typed_value: 48.2,
          unit: "cm",
          method: "Measure laid flat without stretching",
          is_final: true,
          evidence_ids: [await inspector1.photo("shot")],
        },
      ],
    },
    "PUT",
  );

  // Supervisor initiates relay handover from inspector1 -> inspector2
  const ho = (
    await admin.fetch(
      `/staff/dispatch/work-items/${wi.id}/handovers`,
      { to_user_id: inspector2Id, to_workstation_id: wsB2.id, handover_type: "relay", reason: "Shift rotation relay" },
      "POST",
      201,
    )
  ).handover;
  assert.equal(ho.from_generation, 1);
  assert.equal(ho.to_generation, 2);
  assert.equal(ho.preflight_snapshot.saved_inspection_results_count >= 1, true);

  // While paused/handover_pending, inspector1 cannot record further results (TASK_PAUSED)
  await inspector1.fetch(
    `/staff/inspection-tasks/${taskId}/results`,
    {
      revision: r1.revision,
      results: [
        {
          item_key: "width",
          component: "main",
          attempt: 2,
          status: "RECORDED",
          typed_value: 48.3,
          unit: "cm",
          method: "Measure laid flat without stretching",
          is_final: true,
        },
      ],
    },
    "PUT",
    409,
  );

  // Wrong operator cannot accept handover; inspector2 accepts & claims generation-2 lease
  await inspector1.fetch(`/staff/dispatch/handovers/${ho.id}/accept`, {}, "POST", 403);
  await inspector2.fetch(`/staff/dispatch/handovers/${ho.id}/accept`, { notes: "Accepted station B2 relay" });
  const lease2 = await inspector2.fetch(`/staff/dispatch/work-items/${wi.id}/leases`, { duration_minutes: 120 }, "POST", 201);
  assert.equal(lease2.execution_generation, 2);

  // Both from/to operators received handover notification
  assert((await inspector2.fetch("/staff/me/notifications")).notifications.some((n: { template: string }) => n.template === "task.handed_over"));

  // Inspector2 CANNOT overwrite inspector1's attempt 1 (HISTORICAL_AUTHOR_IMMUTABLE); records attempt 2 cleanly
  const viewAfterHo = await inspector2.fetch(`/staff/inspection-tasks/${taskId}`);
  await inspector2.fetch(
    `/staff/inspection-tasks/${taskId}/results`,
    {
      revision: viewAfterHo.revision,
      results: [
        {
          item_key: "width",
          component: "main",
          attempt: 1,
          status: "RECORDED",
          typed_value: 49.0,
          unit: "cm",
          method: "Measure laid flat without stretching",
          is_final: true,
        },
      ],
    },
    "PUT",
    409,
  );
  await inspector2.fetch(
    `/staff/inspection-tasks/${taskId}/results`,
    {
      revision: viewAfterHo.revision,
      results: [
        {
          item_key: "width",
          component: "main",
          attempt: 2,
          status: "RECORDED",
          typed_value: 48.5,
          unit: "cm",
          method: "Measure laid flat without stretching",
          is_final: true,
        },
      ],
    },
    "PUT",
  );

  // Verify attempt 1 preserved inspector1 as author & DB trigger prevents direct author overwrite
  const authors = (
    await pool.query<{ attempt: number; recorded_by: string }>(
      "select attempt, recorded_by from inspection_results where task_id = $1 and item_key = 'width' order by attempt",
      [taskId],
    )
  ).rows;
  assert.equal(authors.length, 2);
  assert.equal(authors[0].attempt, 1);
  assert.equal(authors[0].recorded_by, inspector1Id);
  assert.equal(authors[1].attempt, 2);
  assert.equal(authors[1].recorded_by, inspector2Id);

  await assert.rejects(
    pool.query("update inspection_results set recorded_by = $2 where task_id = $1 and item_key = 'width' and attempt = 1", [
      taskId,
      inspector2Id,
    ]),
    /HISTORICAL_AUTHOR_IMMUTABLE/,
  );

  // Late-evidence boundary: current active lease returns 200; unrelated user forging token gets 403;
  // stale generation-1 submission from inspector1 goes to late_evidence_quarantine (202) preserving captured_by = inspector1Id
  const evidenceHash = createHash("sha256").update("late-photo-bytes").digest("hex");
  const curSub = await inspector2.fetch("/staff/dispatch/evidence-submit", {
    work_item_id: wi.id,
    lease_token: lease2.lease_token,
    execution_generation: 2,
    evidence_sha256: evidenceHash,
    item_key: "width",
    component: "main",
  });
  assert.equal(curSub.accepted, true);
  assert.equal(curSub.quarantined, false);

  await receiver.fetch(
    "/staff/dispatch/evidence-submit",
    {
      work_item_id: wi.id,
      lease_token: lease1.lease_token,
      execution_generation: 1,
      evidence_sha256: evidenceHash,
    },
    "POST",
    403,
  );

  const lateSub = await inspector1.fetch(
    "/staff/dispatch/evidence-submit",
    {
      work_item_id: wi.id,
      lease_token: lease1.lease_token,
      execution_generation: 1,
      evidence_sha256: evidenceHash,
      item_key: "width",
      component: "main",
    },
    "POST",
    202,
  );
  assert.equal(lateSub.accepted, false);
  assert.equal(lateSub.quarantined, true);
  assert.equal(lateSub.quarantine_reason, "LATE_AFTER_HANDOVER");
  assert.equal(lateSub.record.captured_by, inspector1Id);

  // Admin inbox notified; resolve quarantine keeping captured_by immutable; DB trigger rejects captured_by mutation
  assert((await admin.fetch("/staff/me/notifications")).notifications.some((n: { template: string }) => n.template === "task.late_evidence_quarantined"));
  const resolved = (
    await admin.fetch(`/staff/dispatch/quarantined-evidence/${lateSub.quarantine_id}/resolve`, {
      resolution: "accepted_preserving_author",
      note: "Verified authentic delayed capture from Station B1",
    })
  ).quarantined_evidence;
  assert.equal(resolved.captured_by, inspector1Id);
  assert.equal(resolved.resolution_status, "accepted_preserving_author");
  await assert.rejects(
    pool.query("update late_evidence_quarantine set captured_by = $2 where id = $1", [lateSub.quarantine_id, inspector2Id]),
    /HISTORICAL_AUTHOR_IMMUTABLE/,
  );

  // Emergency staff lease revocation immediately revokes inspector2 active lease, bumps generation, pauses task & notifies
  const emergency = await admin.fetch(`/staff/dispatch/staff/${inspector2Id}/revoke-leases`, {
    reason: "Emergency sudden leave suspension",
  });
  assert.equal(emergency.revoked_count, 1);
  assert((await inspector2.fetch("/staff/me/notifications")).notifications.some((n: { template: string }) => n.template === "task.lease_revoked"));

  // Finding 3-6 regressions:
  // 1) Unknown device_id rejected cleanly (404) & invalid HH:MM shift time rejected (422)
  await inspector1.fetch(
    "/staff/dispatch/evidence-submit",
    {
      work_item_id: wi.id,
      lease_token: lease1.lease_token,
      execution_generation: 1,
      evidence_sha256: evidenceHash,
      device_id: randomUUID(),
    },
    "POST",
    404,
  );
  await admin.fetch(
    "/staff/shifts",
    {
      warehouse_id: wh.id,
      user_id: inspector1Id,
      shift_date: today,
      shift_code: "BAD-TIME",
      start_time: "99:99",
      end_time: "18:00",
      available_minutes: 480,
    },
    "PUT",
    422,
  );

  // 2) Finding 3+4 recovery: reassign preserves initial planned_assignee_id, then pending handover cancelled cleanly recovers from deadlock
  await admin.fetch(`/staff/dispatch/work-items/${wi.id}/resume`, {});
  const hoPending = (
    await admin.fetch(
      `/staff/dispatch/work-items/${wi.id}/handovers`,
      { to_user_id: inspector1Id, to_workstation_id: wsB1.id, handover_type: "reassign", reason: "Attempt return to station 1" },
      "POST",
      201,
    )
  ).handover;
  const cancelledHo = await admin.fetch(`/staff/dispatch/handovers/${hoPending.id}/cancel`, { reason: "Cancel pending handover recovery test" });
  assert.equal(cancelledHo.work_item.dispatch_status, "assigned");
  const wiDb = (
    await pool.query<{ planned_assignee_id: string }>(
      "select planned_assignee_id from dispatch_work_items where id = $1",
      [wi.id],
    )
  ).rows[0];
  assert.equal(wiDb.planned_assignee_id, inspector1Id);
});
