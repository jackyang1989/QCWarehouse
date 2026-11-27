import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const { handle } = await import("../packages/core/http");
const { pool, transaction } = await import("../packages/db");
const { seedAuthoritativeChinaRegions } = await import("../packages/core/regions-seed");

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
    ["admin", "receiving", "inspector", "reviewer", "customer"].map((n) => n + "@qcw.test"),
  ]);
  await transaction((db) => seedAuthoritativeChinaRegions(db, { includeTownships: false }));
});

after(() => pool.end());

class Client {
  jar = new Map<string, string>();
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200) {
    const headers: Record<string, string> = { origin };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = randomUUID();
      const csrf = this.jar.get("qcw_csrf");
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    const cleanPath = path.split("?")[0]!;
    const res = await handle(
      new Request(origin + "/api/v1" + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
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
}

test("TASK-183: workstations A/B/C, device auth policy & approval, anti-self-approval, separate device identity, calibration, skills & sellability guard", async () => {
  const admin = new Client();
  const adminLogin = await admin.loginOtp("admin@qcw.test");
  const receiver = new Client();
  await receiver.loginOtp("receiving@qcw.test");
  const inspector = new Client();
  const inspectorLogin = await inspector.loginOtp("inspector@qcw.test");
  const reviewer = new Client();
  await reviewer.loginOtp("reviewer@qcw.test");
  const customer = new Client();
  await customer.loginOtp("customer@qcw.test");

  // Setup an active warehouse with fulfillment enabled
  const nanshan = (await admin.fetch("/regions/search?q=440305")).items[0];
  const snap = await admin.fetch(
    "/addresses/snapshots",
    {
      purpose: "warehouse_receiving",
      recipient_name: "南山工位仓收货组",
      contact_phone_raw: "13800138888",
      county_region_id: nanshan.id,
      detail_address: "科兴科学园B4栋",
    },
    "POST",
    201,
  );
  const wh = await admin.fetch(
    "/staff/warehouses",
    {
      warehouse_code: "SZ-WS-01",
      name_zh: "南山工位测试仓",
      name_en: "Nanshan Workstation Warehouse",
      receiving_address_snapshot_id: snap.id,
      supported_categories: ["apparel"],
    },
    "POST",
    201,
  );
  const recvZone = await admin.fetch(
    `/staff/warehouses/${wh.id}/zones`,
    { zone_code: "RCV", name_zh: "收货区", name_en: "Receiving", zone_type: "receiving" },
    "POST",
    201,
  );
  const qcZone = await admin.fetch(
    `/staff/warehouses/${wh.id}/zones`,
    { zone_code: "INP", name_zh: "质检区", name_en: "Inspection", zone_type: "in_progress" },
    "POST",
    201,
  );
  await admin.fetch(
    `/staff/warehouses/${wh.id}/controls`,
    {
      status: "active",
      accept_new_orders: true,
      accept_inbound_transit: true,
      allow_fulfillment: true,
      allow_dispatch: true,
    },
    "PATCH",
  );

  // Create Type A, B, C workstations; unauthorized customer must get 403
  await customer.fetch(
    "/staff/workstations",
    {
      warehouse_id: wh.id,
      station_code: "WS-BAD",
      station_type: "A_receiving",
      name_zh: "越权工位",
      name_en: "Unauthorized",
    },
    "POST",
    403,
  );

  const wsA = (
    await admin.fetch(
      "/staff/workstations",
      {
        warehouse_id: wh.id,
        station_code: "SZ-WS-A01",
        station_type: "A_receiving",
        name_zh: "A类收货台1",
        name_en: "Station A1",
        zone_id: recvZone.id,
        required_device_roles: ["scanner", "scale", "printer"],
      },
      "POST",
      201,
    )
  ).workstation;
  const wsB = (
    await admin.fetch(
      "/staff/workstations",
      {
        warehouse_id: wh.id,
        station_code: "SZ-WS-B01",
        station_type: "B_inspection_shoot",
        name_zh: "B类质检拍摄台1",
        name_en: "Station B1",
        zone_id: qcZone.id,
        required_device_roles: ["camera", "scale"],
      },
      "POST",
      201,
    )
  ).workstation;
  const wsC = (
    await admin.fetch(
      "/staff/workstations",
      {
        warehouse_id: wh.id,
        station_code: "SZ-WS-C01",
        station_type: "C_pack_handover",
        name_zh: "C类打包出库台1",
        name_en: "Station C1",
        required_device_roles: ["scanner", "scale", "printer"],
      },
      "POST",
      201,
    )
  ).workstation;
  assert.equal(wsC.station_type, "C_pack_handover");

  // Default global policy must be manual_first_approval
  const policyRes = await inspector.fetch(`/staff/device-access-policies?warehouse_id=${wh.id}`);
  assert.equal(policyRes.policy.mode, "manual_first_approval");

  // Inspector requests camera authorization; admin inbox receives device.auth_requested notification
  const reqCam = await inspector.fetch(
    "/staff/device-requests",
    {
      warehouse_id: wh.id,
      workstation_id: wsB.id,
      device_code: "CAM-SZ-01",
      device_role: "camera",
      ownership_type: "warehouse_owned",
      hardware_fingerprint: "hw-fp-cam-sony-a7r5-0001",
      manufacturer: "Sony",
      model: "A7RV",
      capability_tags: ["macro_shoot", "video_capture"],
    },
    "POST",
    201,
  );
  assert.equal(reqCam.approval_status, "pending_approval");
  assert.equal(reqCam.online_status, "offline");

  // Unapproved device heartbeat must fail (device cannot appear connected/online)
  await customer.fetch(
    "/devices/heartbeat",
    {
      device_code: "CAM-SZ-01",
      hardware_fingerprint: "hw-fp-cam-sony-a7r5-0001",
      device_secret: "forged-secret-value-1234",
    },
    "POST",
    403,
  );

  // Admin inbox has device.auth_requested
  const adminInboxBefore = await admin.fetch("/staff/me/notifications");
  assert(adminInboxBefore.notifications.some((n: { template: string }) => n.template === "device.auth_requested"));

  // Non-admin (inspector) cannot self-approve own request (403)
  await inspector.fetch(
    `/staff/device-requests/${reqCam.request.id}/decide`,
    { decision: "approve" },
    "POST",
    403,
  );

  // Even admin cannot approve a self-requested warehouse device when self-approval is disallowed
  const adminSelfReq = await admin.fetch(
    "/staff/device-requests",
    {
      warehouse_id: wh.id,
      workstation_id: wsA.id,
      device_code: "SCAN-SZ-SELF",
      device_role: "scanner",
      ownership_type: "warehouse_owned",
      hardware_fingerprint: "hw-fp-scanner-zebra-self-01",
    },
    "POST",
    201,
  );
  await admin.fetch(
    `/staff/device-requests/${adminSelfReq.request.id}/decide`,
    { decision: "approve", confirm_owner_owned: true },
    "POST",
    403,
  );
  // Another reviewer/admin policy? Wait: let's reject admin's request via another or switch policy temporarily for owner-owned confirmation test
  await admin.fetch(
    "/staff/device-access-policies",
    { warehouse_id: wh.id, mode: "manual_first_approval", allow_owner_self_confirm: true, max_lease_minutes: 240 },
    "PUT",
  );
  const selfRejected = await admin.fetch(
    `/staff/device-requests/${adminSelfReq.request.id}/decide`,
    { decision: "reject", note: "Rejected in favor of pre-registered pool", confirm_owner_owned: true },
    "POST",
  );
  assert.equal(selfRejected.approval_status, "rejected");

  // Admin approves inspector's camera request -> approved !== online until real device heartbeat with issued device_secret
  const approvedCam = await admin.fetch(
    `/staff/device-requests/${reqCam.request.id}/decide`,
    { decision: "approve", note: "Approved for Station B1" },
    "POST",
  );
  assert.equal(approvedCam.approval_status, "approved");
  assert.equal(approvedCam.online_status, "offline");
  assert(approvedCam.device_secret);

  // Inspector inbox receives device.auth_approved AND marks one read
  const inspInbox = await inspector.fetch("/staff/me/notifications");
  const camApprovedNotif = inspInbox.notifications.find((n: { template: string }) => n.template === "device.auth_approved");
  assert(camApprovedNotif);
  await inspector.fetch(`/staff/me/notifications/${camApprovedNotif.id}/read`, {});

  // Outbox events genuinely recorded for requested / rejected / approved
  const outboxCount = await pool.query<{ count: string }>(
    "select count(*)::text count from outbox_events where type = any($1::text[])",
    [["device.auth_requested", "device.auth_rejected", "device.auth_approved"]],
  );
  assert.equal(Number(outboxCount.rows[0].count) >= 3, true);

  // Employee cookie/identity cannot fake device heartbeat without device_secret; pure device identity succeeds without staff cookie
  await inspector.fetch(
    "/devices/heartbeat",
    {
      device_code: "CAM-SZ-01",
      hardware_fingerprint: "hw-fp-cam-sony-a7r5-0001",
      device_secret: "wrong-secret-000000",
    },
    "POST",
    401,
  );
  const standaloneDevice = new Client(); // No staff session cookie at all
  const hb = await standaloneDevice.fetch(
    "/devices/heartbeat",
    {
      device_code: "CAM-SZ-01",
      hardware_fingerprint: "hw-fp-cam-sony-a7r5-0001",
      device_secret: approvedCam.device_secret,
    },
    "POST",
  );
  assert.equal(hb.online_status, "online");

  // Before scale + skill exist, macro service sellability check must BLOCK sales
  const sellCheck1 = await reviewer.fetch(
    `/staff/workstations/sellability-check?warehouse_id=${wh.id}&required_device_roles=camera,scale&required_skill_code=apparel_macro`,
  );
  assert.equal(sellCheck1.sellable, false);
  assert(sellCheck1.blocking_reasons.some((r: string) => r.startsWith("MISSING_ONLINE_AUTHORIZED_DEVICE")));
  assert(sellCheck1.blocking_reasons.some((r: string) => r === "NO_CERTIFIED_ACTIVE_INSPECTOR:apparel_macro"));

  // Preregistered-only policy blocks un-preregistered device requests; pre-register scale then approve & calibrate
  await admin.fetch(
    "/staff/device-access-policies",
    { warehouse_id: wh.id, mode: "preregistered_only", allow_owner_self_confirm: false, max_lease_minutes: 240 },
    "PUT",
  );
  await receiver.fetch(
    "/staff/device-requests",
    {
      warehouse_id: wh.id,
      workstation_id: wsB.id,
      device_code: "SCALE-UNREG",
      device_role: "scale",
      hardware_fingerprint: "hw-fp-unknown-scale-999",
    },
    "POST",
    403,
  );

  const preScale = (
    await admin.fetch(
      "/staff/devices/preregister",
      {
        warehouse_id: wh.id,
        workstation_id: wsB.id,
        device_code: "SCALE-SZ-01",
        device_role: "scale",
        ownership_type: "warehouse_owned",
        hardware_fingerprint: "hw-fp-scale-mettler-0001",
        capability_tags: ["weight_tare"],
        spec_meta: { tare_supported: true, max_weight_g: 30000 },
      },
      "POST",
      201,
    )
  ).device;
  assert.equal(preScale.approval_status, "preregistered");

  const reqScale = await receiver.fetch(
    "/staff/device-requests",
    {
      warehouse_id: wh.id,
      workstation_id: wsB.id,
      device_code: "SCALE-SZ-01",
      device_role: "scale",
      ownership_type: "warehouse_owned",
      hardware_fingerprint: "hw-fp-scale-mettler-0001",
    },
    "POST",
    201,
  );
  const approvedScale = await admin.fetch(`/staff/device-requests/${reqScale.request.id}/decide`, { decision: "approve" }, "POST");

  // Scale tare/net/gross consistency guard
  await inspector.fetch(
    `/staff/devices/${preScale.id}/calibration`,
    {
      log_type: "calibration",
      outcome: "passed",
      measured_params: { tare_g: 100, gross_g: 500, net_g: 350, tolerance_g: 1 },
    },
    "POST",
    422,
  );
  await inspector.fetch(
    `/staff/devices/${preScale.id}/calibration`,
    {
      log_type: "calibration",
      outcome: "passed",
      measured_params: { tare_g: 100, gross_g: 500, net_g: 400, tolerance_g: 1 },
      next_due_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    },
    "POST",
    201,
  );
  await standaloneDevice.fetch(
    "/devices/heartbeat",
    {
      device_code: "SCALE-SZ-01",
      hardware_fingerprint: "hw-fp-scale-mettler-0001",
      device_secret: approvedScale.device_secret,
    },
    "POST",
  );

  // Skill anti-self-certification check: reviewer cannot certify self; reviewer certifies inspector
  const reviewerUserId = (await pool.query<{ user_id: string }>("select user_id from staff_roles where role='reviewer' limit 1")).rows[0].user_id;
  const inspectorUserId = (await pool.query<{ user_id: string }>("select user_id from staff_roles where role='inspector' limit 1")).rows[0].user_id;
  const adminUserId = (await pool.query<{ user_id: string }>("select user_id from staff_roles where role='super_admin' limit 1")).rows[0].user_id;
  assert.notEqual(adminUserId, inspectorUserId);
  assert.equal(Boolean(adminLogin) && Boolean(inspectorLogin), true);
  await reviewer.fetch(
    "/staff/inspector-skills",
    { user_id: reviewerUserId, skill_code: "apparel_macro" },
    "PUT",
    403,
  );
  await reviewer.fetch(
    "/staff/inspector-skills",
    {
      user_id: inspectorUserId,
      skill_code: "apparel_macro",
      category_code: "apparel",
      service_code: "macro_inspection",
      status: "active",
      valid_until: new Date(Date.now() + 90 * 86400_000).toISOString(),
      evidence_note: "Passed macro & fabric defect exam",
    },
    "PUT",
  );

  // Now sellability guard MUST pass!
  const sellCheck2 = await reviewer.fetch(
    `/staff/workstations/sellability-check?warehouse_id=${wh.id}&required_device_roles=camera,scale&required_skill_code=apparel_macro`,
  );
  assert.equal(sellCheck2.sellable, true, JSON.stringify(sellCheck2));

  // Lease exclusivity: inspector claims lease on camera; receiver is blocked until released or revoked
  const lease1 = await inspector.fetch(`/staff/devices/${reqCam.device_id}/leases`, { duration_minutes: 60 }, "POST", 201);
  await receiver.fetch(`/staff/devices/${reqCam.device_id}/leases`, { duration_minutes: 60 }, "POST", 409);

  // Urgent device revocation kills active lease, bumps auth_generation, revokes device secret, preserves all history & sends notification
  const rev = await admin.fetch(`/staff/devices/${reqCam.device_id}/revoke`, { reason: "Suspected physical tamper" }, "POST");
  assert.equal(rev.approval_status, "revoked");
  assert.equal(rev.auth_generation, 2);
  assert.equal(rev.revoked_leases_count, 1);

  // Revoked device secret immediately fails heartbeat; lease row preserved as 'revoked'; inspector received device.revoked inbox notice
  await standaloneDevice.fetch(
    "/devices/heartbeat",
    {
      device_code: "CAM-SZ-01",
      hardware_fingerprint: "hw-fp-cam-sony-a7r5-0001",
      device_secret: approvedCam.device_secret,
    },
    "POST",
    403,
  );
  const leaseHist = await pool.query<{ status: string; end_reason: string }>(
    "select status, end_reason from device_control_leases where id = $1",
    [lease1.lease.id],
  );
  assert.equal(leaseHist.rows[0].status, "revoked");
  assert.equal(leaseHist.rows[0].end_reason, "device_revoked");

  const inspInboxAfterRevoke = await inspector.fetch("/staff/me/notifications");
  assert(inspInboxAfterRevoke.notifications.some((n: { template: string }) => n.template === "device.revoked"));

  // Sellability guard turns FALSE immediately once required camera is revoked!
  const sellCheck3 = await reviewer.fetch(
    `/staff/workstations/sellability-check?warehouse_id=${wh.id}&required_device_roles=camera,scale&required_skill_code=apparel_macro`,
  );
  assert.equal(sellCheck3.sellable, false);
  assert(sellCheck3.blocking_reasons.some((r: string) => r.includes("camera")));

  // Finding 1 regression: revoking a pending device cancels open request & blocks subsequent approval (never resurrects)
  await admin.fetch(
    "/staff/device-access-policies",
    { warehouse_id: wh.id, mode: "manual_first_approval", allow_owner_self_confirm: false, max_lease_minutes: 240 },
    "PUT",
  );
  const pendingCam2 = await inspector.fetch(
    "/staff/device-requests",
    {
      warehouse_id: wh.id,
      workstation_id: wsB.id,
      device_code: "CAM-SZ-02",
      device_role: "camera",
      ownership_type: "warehouse_owned",
      hardware_fingerprint: "hw-fp-cam-sony-a7r5-0002",
    },
    "POST",
    201,
  );
  await admin.fetch(`/staff/devices/${pendingCam2.device_id}/revoke`, { reason: "Revoked before decision" }, "POST");
  await admin.fetch(`/staff/device-requests/${pendingCam2.request.id}/decide`, { decision: "approve" }, "POST", 409);

  // Finding 2 regression: preregistered_only blocks mismatched fingerprint, revoked fingerprint & spoofed ownership_type
  await admin.fetch(
    "/staff/device-access-policies",
    { warehouse_id: wh.id, mode: "preregistered_only", allow_owner_self_confirm: false, max_lease_minutes: 240 },
    "PUT",
  );
  await admin.fetch(
    "/staff/devices/preregister",
    {
      warehouse_id: wh.id,
      workstation_id: wsB.id,
      device_code: "CAM-SZ-PRE3",
      device_role: "camera",
      ownership_type: "shared_terminal",
      hardware_fingerprint: "hw-fp-cam-pre3-0003",
    },
    "POST",
    201,
  );
  // Spoofed ownership_type (shared_terminal -> warehouse_owned) rejected (422)
  await receiver.fetch(
    "/staff/device-requests",
    {
      warehouse_id: wh.id,
      workstation_id: wsB.id,
      device_code: "CAM-SZ-PRE3",
      device_role: "camera",
      ownership_type: "warehouse_owned",
      hardware_fingerprint: "hw-fp-cam-pre3-0003",
    },
    "POST",
    422,
  );
  // Revoked fingerprint mixed with valid preregistered device_code rejected (409)
  await receiver.fetch(
    "/staff/device-requests",
    {
      warehouse_id: wh.id,
      workstation_id: wsB.id,
      device_code: "CAM-SZ-PRE3",
      device_role: "camera",
      ownership_type: "shared_terminal",
      hardware_fingerprint: "hw-fp-cam-sony-a7r5-0001",
    },
    "POST",
    409,
  );

  // Finding 3 & 4 regressions: invalid log_type/outcome rejected (422) and workstation maintenance removes bound scale from sellability
  await inspector.fetch(
    `/staff/devices/${preScale.id}/calibration`,
    { log_type: "fault_resolved", outcome: "failed" },
    "POST",
    422,
  );
  const sellScaleOk = await reviewer.fetch(
    `/staff/workstations/sellability-check?warehouse_id=${wh.id}&required_device_roles=scale&required_skill_code=apparel_macro`,
  );
  assert.equal(sellScaleOk.sellable, true);
  await admin.fetch(`/staff/workstations/${wsB.id}/status`, { status: "maintenance" }, "PATCH");
  const sellScaleAfterMaint = await reviewer.fetch(
    `/staff/workstations/sellability-check?warehouse_id=${wh.id}&required_device_roles=scale&required_skill_code=apparel_macro`,
  );
  assert.equal(sellScaleAfterMaint.sellable, false);
});
