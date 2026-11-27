import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
const { pool, transaction } = await import("../packages/db");
const { workOnce } = await import("../packages/core/worker");
const { deliverEmailOnce, consumeEmailWebhook } = await import("../packages/core/email");
const { emitCommunicationEvent } = await import("../packages/core/communications");
const { resolvePortalRoute, canOpenStaffPage } = await import("../packages/core/portal-routes");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function totpForHex(secretHex: string, now = Date.now()): string {
  const key = Buffer.from(secretHex, "hex");
  const counter = BigInt(Math.floor(now / 1000 / 30));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter, 0);
  const mac = createHmac("sha1", key).update(msg).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const code =
    (((mac[off]! & 0x7f) << 24) |
      ((mac[off + 1]! & 0xff) << 16) |
      ((mac[off + 2]! & 0xff) << 8) |
      (mac[off + 3]! & 0xff)) %
    1000000;
  return String(code).padStart(6, "0");
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
    const contentType = res.headers.get("content-type") ?? "";
    const data = contentType.includes("text/csv") ? await res.text() : await res.json();
    assert.equal(
      res.status,
      expected,
      `${method} ${path} -> expected ${expected}, got ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
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

let pureInspectorId = "";
let customer1UserId = "";
let customer1OrgId = "";
let customer2UserId = "";
let customer2OrgId = "";
let admin1UserId = "";
let staffSupportId = "";

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

  admin1UserId = (
    await pool.query<{ id: string }>(
      "select user_id as id from user_emails where normalized_email = 'admin@qcw.test' limit 1",
    )
  ).rows[0]!.id;

  const cust1Row = (
    await pool.query<{ user_id: string; org_id: string }>(
      `select ue.user_id, crp.org_id
       from user_emails ue
       join customer_receiving_profiles crp on crp.user_id = ue.user_id
       where ue.normalized_email = 'customer@qcw.test' limit 1`,
    )
  ).rows[0]!;
  customer1UserId = cust1Row.user_id;
  customer1OrgId = cust1Row.org_id;

  // Create pure inspector user (ONLY 'inspector', unlike demo inspector@qcw.test which has template_admin)
  pureInspectorId = randomUUID();
  const inspEmailId = randomUUID();
  await pool.query(
    `insert into users(id, display_name, status, locale) values($1, 'Pure Inspector W21', 'active', 'zh-CN')`,
    [pureInspectorId],
  );
  await pool.query(
    `insert into user_emails(id, user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
     values($1, $2, 'insp.only.w21@qcw.test', 'insp.only.w21@qcw.test', now(), true, true)`,
    [inspEmailId, pureInspectorId],
  );
  await pool.query(
    `insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id)
     values($1, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2)`,
    [pureInspectorId, inspEmailId],
  );
  await pool.query(`insert into staff_roles(user_id, role) values($1, 'inspector')`, [pureInspectorId]);
  await pool.query(
    `insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status)
     values($1, 'EMP-W21I', 'insp.only.w21@qcw.test', 'active', 'active')`,
    [pureInspectorId],
  );

  // Create dedicated support agent user
  staffSupportId = randomUUID();
  const supEmailId = randomUUID();
  await pool.query(
    `insert into users(id, display_name, status, locale) values($1, 'Support Agent W21', 'active', 'zh-CN')`,
    [staffSupportId],
  );
  await pool.query(
    `insert into user_emails(id, user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
     values($1, $2, 'support.w21@qcw.test', 'support.w21@qcw.test', now(), true, true)`,
    [supEmailId, staffSupportId],
  );
  await pool.query(
    `insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id)
     values($1, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2)`,
    [staffSupportId, supEmailId],
  );
  await pool.query(`insert into staff_roles(user_id, role) values($1, 'support')`, [staffSupportId]);
  await pool.query(
    `insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status)
     values($1, 'EMP-W21S', 'support.w21@qcw.test', 'active', 'active')`,
    [staffSupportId],
  );

  // Create second isolated customer org & user
  customer2UserId = randomUUID();
  const cust2EmailId = randomUUID();
  customer2OrgId = randomUUID();
  await pool.query(
    `insert into organizations(id, name) values($1, 'W21 Customer Two Org')`,
    [customer2OrgId],
  );
  await pool.query(
    `insert into users(id, display_name, status, locale) values($1, 'Customer Two W21', 'active', 'en')`,
    [customer2UserId],
  );
  await pool.query(
    `insert into user_emails(id, user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
     values($1, $2, 'cust2.w21@qcw.test', 'cust2.w21@qcw.test', now(), true, true)`,
    [cust2EmailId, customer2UserId],
  );
  await pool.query(
    `insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id)
     values($1, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2)`,
    [customer2UserId, cust2EmailId],
  );
  await pool.query(
    `insert into memberships(user_id, org_id, role) values($1, $2, 'owner')`,
    [customer2UserId, customer2OrgId],
  );
  await pool.query(
    `insert into customer_receiving_profiles(user_id, org_id, receiving_code)
     values($1, $2, 'QCW21')`,
    [customer2UserId, customer2OrgId],
  );
});

after(async () => {
  await pool.end();
});

test("Route & portal visibility for three-portal personal inbox (/wh/notifications, /admin/notifications) and RBAC isolation", async () => {
  const whRoute = resolvePortalRoute("/wh/notifications");
  const adminRoute = resolvePortalRoute("/admin/notifications");
  assert.equal(whRoute?.area, "warehouse");
  assert.equal(whRoute?.view, "staff-notifications");
  assert.equal(adminRoute?.area, "admin");
  assert.equal(adminRoute?.view, "staff-notifications");
  assert.equal(canOpenStaffPage("/wh/notifications", whRoute!, ["inspector"]), true);
  assert.equal(canOpenStaffPage("/admin/notifications", adminRoute!, ["support"]), true);

  const insp = new Client();
  await insp.loginWithMfa("insp.only.w21@qcw.test");
  // Pure inspector can open their personal staff inbox
  const ownInbox = await insp.fetch("/staff/me/notifications");
  assert(Array.isArray(ownInbox.notifications));
  // Pure inspector CANNOT access admin communication history or legacy reconciliation
  await insp.fetch("/staff/admin/communications/history", undefined, "GET", 403);
  await insp.fetch("/staff/admin/communications/reconcile-legacy", {}, "POST", 403);
});

test("Real Owner & Staff lifecycle events emit deduplicated notifications to scoped staff inboxes", async () => {
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");

  // 1. Owner events: legal entity activation + merchant instance creation & transition
  const entity = await admin.fetch(
    "/staff/admin/legal-entities",
    {
      entity_code: `W21ENT${Date.now().toString().slice(-4)}`,
      entity_type: "company",
      public_trade_name: "QCW W21 Co",
      legal_name: "QCW W21 Inspection Ltd",
      jurisdiction: "HK",
      registration_no: "BR-W21-9001",
      contact_email: "ops@w21.test",
      service_address: "Suite 88, Kowloon, HK",
    },
    "POST",
    201,
  );
  await admin.fetch(`/staff/admin/legal-entities/${entity.id}/activate`, {}, "POST", 200);

  const merchant = await admin.fetch(
    "/staff/admin/merchant-instances",
    {
      instance_code: `w21_stripe_${Date.now().toString().slice(-4)}`,
      provider: "stripe",
      environment: "live",
      legal_entity_id: entity.id,
      external_account_id: "acct_w21_live",
      supported_currencies: ["USD"],
      settlement_account_masked: "****4242",
      status: "paused",
      is_primary_for_new_orders: false,
    },
    "POST",
    201,
  );
  await admin.fetch(
    `/staff/admin/merchant-instances/${merchant.id}/status`,
    { status: "accepting_new", is_primary_for_new_orders: true, reason: "Wave 21 readiness test" },
    "POST",
    200,
  );

  // 2. Staff lifecycle events: invite -> activate -> role_changed -> sessions_revoked -> offboarded + handover_assigned
  const staffEmail = `w21.staff.${Date.now()}@qcw.test`;
  const invited = await admin.fetch(
    "/staff/admin/employees",
    {
      display_name: "Wave21 Staff",
      work_email: staffEmail,
      roles: ["inspector"],
      allowed_warehouse_ids: [],
      locale: "zh-CN",
      expiry_hours: 24,
    },
    "POST",
    201,
  );
  const mfaInit = await new Client().fetch(
    "/staff/invitations/start-mfa",
    { token: invited.activation_token },
    "POST",
    200,
  );
  const totp = totpForHex(mfaInit.totp_secret_hex);
  await new Client().fetch(
    "/staff/invitations/accept",
    {
      token: invited.activation_token,
      password: "W21-Strong-Password!99",
      totp_code: totp,
    },
    "POST",
    200,
  );

  const roleDraft = await admin.fetch(
    "/staff/admin/rbac/roles",
    {
      role_code: `w21_tally_${Date.now().toString().slice(-4)}`,
      display_name_zh: "W21 理货岗",
      display_name_en: "W21 Tally Clerk",
      permissions: ["warehouse.intake", "notifications.read_own"],
    },
    "POST",
    201,
  );
  // Role must be published by a second super_admin (or in this test insert an active custom role or second admin)
  const admin2Id = randomUUID();
  const admin2EmailId = randomUUID();
  await pool.query(`insert into users(id, display_name, status, locale) values($1, 'W21 Admin Two', 'active', 'zh-CN')`, [admin2Id]);
  await pool.query(
    `insert into user_emails(id, user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
     values($1, $2, 'admin2.w21@qcw.test', 'admin2.w21@qcw.test', now(), true, true)`,
    [admin2EmailId, admin2Id],
  );
  await pool.query(
    `insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id)
     values($1, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2)`,
    [admin2Id, admin2EmailId],
  );
  await pool.query(`insert into staff_roles(user_id, role) values($1, 'super_admin')`, [admin2Id]);
  await pool.query(
    `insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status)
     values($1, 'EMP-W21A', 'admin2.w21@qcw.test', 'active', 'active')`,
    [admin2Id],
  );
  const admin2 = new Client();
  await admin2.loginWithMfa("admin2.w21@qcw.test");
  await admin2.fetch(`/staff/admin/rbac/roles/${roleDraft.id}/publish`, { reason: "W21 SoD approval" }, "POST", 200);

  await admin.fetch(
    "/staff/admin/rbac/assignments",
    { user_id: invited.user_id, role_id: roleDraft.id, warehouse_scope: [] },
    "POST",
    200,
  );
  await admin.fetch(
    `/staff/admin/employees/${invited.user_id}/revoke-sessions`,
    { reason: "Wave 21 security rotation" },
    "POST",
    200,
  );
  await admin.fetch(
    `/staff/admin/employees/${invited.user_id}/offboard`,
    {
      reason: "Wave 21 handover test",
      handover_to_user_id: staffSupportId,
      handover_items: [{ entity_type: "tickets", entity_id: randomUUID() }],
    },
    "POST",
    200,
  );

  const adminInbox = await admin.fetch("/staff/me/notifications");
  const adminTemplates = new Set(adminInbox.notifications.map((n: { template: string }) => n.template));
  assert(adminTemplates.has("owner.legal_entity_activated"));
  assert(adminTemplates.has("owner.merchant_instance_changed"));
  assert(adminTemplates.has("staff.activated"));
  assert(adminTemplates.has("staff.offboarded"));

  // Check pure inspector DID NOT receive owner events or super_admin offboarding alerts
  const insp = new Client();
  await insp.loginWithMfa("insp.only.w21@qcw.test");
  const inspInbox = await insp.fetch("/staff/me/notifications");
  const inspTemplates = new Set(inspInbox.notifications.map((n: { template: string }) => n.template));
  assert(!inspTemplates.has("owner.legal_entity_activated"));
  assert(!inspTemplates.has("owner.merchant_instance_changed"));
  assert(!inspTemplates.has("staff.offboarded"));

  // Check invited employee received staff.activated, staff.role_changed, staff.sessions_revoked in DB
  const empEvents = (
    await pool.query<{ event_type: string }>(
      `select nm.event_type from notification_recipients nr
       join notification_masters nm on nm.id = nr.notification_id
       where nr.recipient_user_id = $1`,
      [invited.user_id],
    )
  ).rows.map((r) => r.event_type);
  assert(empEvents.includes("staff.activated"));
  assert(empEvents.includes("staff.role_changed"));
  assert(empEvents.includes("staff.sessions_revoked"));

  // Check handover delegate received staff.handover_assigned
  const sup = new Client();
  await sup.loginWithMfa("support.w21@qcw.test");
  const supInbox = await sup.fetch("/staff/me/notifications");
  assert(supInbox.notifications.some((n: { template: string }) => n.template === "staff.handover_assigned"));

  // Verify admin scoped history shows separate master / recipient / delivery / attempt counts
  const hist = await admin.fetch("/staff/admin/communications/history?event_type=owner.legal_entity_activated");
  assert(hist.rows.length >= 1);
  assert(hist.summary.master_count >= 1);
  const detail = await admin.fetch(`/staff/admin/communications/${hist.rows[0].id}`);
  assert.equal(detail.master.event_type, "owner.legal_entity_activated");
  assert(Array.isArray(detail.recipients) && detail.recipients.length >= 1);
  assert(Array.isArray(detail.deliveries) && detail.deliveries.length >= 1);

  // Scoped support agent CANNOT see internal owner.*/staff.*/security_alert records in history or detail
  const supHistOwner = await sup.fetch("/staff/admin/communications/history?event_type=owner.legal_entity_activated");
  assert.equal(supHistOwner.rows.length, 0);
  const supHistAll = await sup.fetch("/staff/admin/communications/history");
  assert(supHistAll.rows.every((r: { event_type: string; source_kind: string }) =>
    r.source_kind !== "security_alert" && !r.event_type.startsWith("owner.") && !r.event_type.startsWith("staff.") && r.event_type !== "email.channel_degraded"));
  await sup.fetch(`/staff/admin/communications/${hist.rows[0].id}`, undefined, "GET", 404);
});

test("T38 dedupe, multi-recipient read_at isolation, Action Required non-closure, and cross-customer 404", async () => {
  const c1 = new Client();
  await c1.loginWithMfa("customer@qcw.test");
  const c2 = new Client();
  await c2.loginWithMfa("cust2.w21@qcw.test");

  // Create a draft order for customer 1 so /actions has a real open Action Required todo
  const offer = (await c1.fetch("/catalog")).offers.find((o: { sku_code: string }) => o.sku_code === "apparel-inspection-1");
  assert(offer);
  const draft = await c1.fetch(
    "/orders",
    { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 1 }] },
    "POST",
    201,
  );
  const actionsBefore = await c1.fetch("/actions");
  assert(actionsBefore.rows.some((i: { id: string }) => i.id === draft.id));

  // Emit same dedupeKey twice -> T38 strict single master + recipient
  const dedupeKey = `w21-dedupe-${randomUUID()}`;
  const firstEmit = await transaction((db) =>
    emitCommunicationEvent(db, {
      eventType: "order.ready",
      entityType: "orders",
      entityId: draft.id,
      orderId: draft.id,
      orderPublicNo: draft.public_no,
      dedupeKey,
      channels: ["in_app", "email"],
      recipients: [{ userId: customer1UserId, kind: "customer", orgId: customer1OrgId }],
    }),
  );
  const secondEmit = await transaction((db) =>
    emitCommunicationEvent(db, {
      eventType: "order.ready",
      entityType: "orders",
      entityId: draft.id,
      orderId: draft.id,
      orderPublicNo: draft.public_no,
      dedupeKey,
      channels: ["in_app", "email"],
      recipients: [{ userId: customer1UserId, kind: "customer", orgId: customer1OrgId }],
    }),
  );
  assert.equal(firstEmit.created, true);
  assert.equal(secondEmit.created, false);
  const masters = await pool.query("select id from notification_masters where dedupe_key = $1", [dedupeKey]);
  assert.equal(masters.rowCount, 1);

  // Customer 1 opens notification & marks read -> first read_at preserved, c2 gets 404, /actions todo remains open
  const c1List = await c1.fetch("/me/notifications");
  const targetNotice = c1List.rows.find((r: { order_number: string }) => r.order_number === draft.public_no);
  assert(targetNotice);
  await c2.fetch(`/me/notifications/${targetNotice.id}`, undefined, "GET", 404);
  const readRes1 = await c1.fetch(`/me/notifications/${targetNotice.id}/read`, {}, "POST", 200);
  assert.equal(readRes1.business_todo_closed, false);
  const firstReadAt = readRes1.read_at;
  const readRes2 = await c1.fetch(`/me/notifications/${targetNotice.id}/read`, {}, "POST", 200);
  assert.equal(new Date(readRes2.read_at).toISOString(), new Date(firstReadAt).toISOString());

  const actionsAfter = await c1.fetch("/actions");
  assert(
    actionsAfter.rows.some((i: { id: string }) => i.id === draft.id),
    "Marking notification as read must NEVER close Action Required todo (§65.4)",
  );

  // Multi-recipient isolation: reading by customer 1 must not mark customer 2 read
  const multiKey = `w21-multi-${randomUUID()}`;
  const multi = await transaction((db) =>
    emitCommunicationEvent(db, {
      sourceKind: "announcement",
      eventType: "account.registered",
      entityType: "system",
      dedupeKey: multiKey,
      channels: ["in_app"],
      recipients: [
        { userId: customer1UserId, kind: "customer", orgId: customer1OrgId },
        { userId: customer2UserId, kind: "customer", orgId: customer2OrgId },
      ],
    }),
  );
  const c1MultiNotif = (await pool.query<{ legacy_notification_id: string }>(
    `select legacy_notification_id from notification_recipients where notification_id = $1 and recipient_user_id = $2`,
    [multi.notification_id, customer1UserId],
  )).rows[0]!;
  await c1.fetch(`/me/notifications/${c1MultiNotif.legacy_notification_id}/read`, {}, "POST", 200);
  const c2Rec = (await pool.query<{ read_at: Date | null }>(
    `select read_at from notification_recipients where notification_id = $1 and recipient_user_id = $2`,
    [multi.notification_id, customer2UserId],
  )).rows[0]!;
  assert.equal(c2Rec.read_at, null);
});

test("T39 test-order inbox isolation, T99 delivered != read + bounce partial_failure, T100 timeout unknown + ops alert", async (t) => {
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const c1 = new Client();
  await c1.loginWithMfa("customer@qcw.test");

  const prevDemo = process.env.QCW_DEMO;
  const prevEmailProvider = process.env.EMAIL_PROVIDER;
  const prevTestInbox = process.env.QCW_TEST_EMAIL_INBOX;
  const key = randomBytes(32);
  const token = "re_w21_" + randomUUID();
  const webhookSecret = "whsec_" + key.toString("base64");

  const offer = (await c1.fetch("/catalog")).offers.find((o: { sku_code: string }) => o.sku_code === "apparel-inspection-1");
  assert(offer);
  const testOrder = await c1.fetch(
    "/orders",
    { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 1 }] },
    "POST",
    201,
  );
  await pool.query("update orders set is_test = true where id = $1", [testOrder.id]);
  const prodOrderT99 = await c1.fetch(
    "/orders",
    { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 1 }] },
    "POST",
    201,
  );
  await pool.query("update orders set is_test = false where id = $1", [prodOrderT99.id]);
  const prodOrder = await c1.fetch(
    "/orders",
    { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 1 }] },
    "POST",
    201,
  );
  await pool.query("update orders set is_test = false where id = $1", [prodOrder.id]);

  process.env.QCW_DEMO = "0";
  process.env.EMAIL_PROVIDER = "resend";
  process.env.QCW_TEST_EMAIL_INBOX = "isolated-test-sink@qcw.test";

  try {
    // Configure Resend integration cleanly in test DB
    await admin.fetch("/staff/admin/integrations/resend", { config: { from_email: "QC Warehouse <sender@example.test>" } });
    await admin.fetch("/staff/admin/integrations/resend/secrets", {
      environment: "live",
      secret_name: "api_key",
      secret_value: token,
    });
    await admin.fetch("/staff/admin/integrations/resend/secrets", {
      environment: "live",
      secret_name: "webhook_secret",
      secret_value: webhookSecret,
    });
    await admin.fetch("/staff/admin/integrations/resend", { enabled: true, lifecycle_state: "enabled" });

    const sentPayloads: Array<{ to: string[]; subject: string; idempotencyKey: string | null }> = [];
    let nextBehavior: "deliver" | "timeout" = "deliver";
    let nextReturnedMsgId = "msg_w21_t39_" + randomUUID();
    const t99MsgId = "msg_w21_t99_" + randomUUID();

    t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; subject: string };
      sentPayloads.push({ to: body.to, subject: body.subject, idempotencyKey: headers.get("idempotency-key") });
      if (nextBehavior === "timeout") {
        const err = new Error("Simulated socket timeout");
        err.name = "AbortError";
        throw err;
      }
      return Response.json({ id: nextReturnedMsgId });
    });

    // Clear any prior queued email_deliveries before our isolated run
    await pool.query("update email_deliveries set state = 'submitted' where state = 'queued'");

    // 1. T39: Test order routes to QCW_TEST_EMAIL_INBOX with [TEST] prefix and is_test=true
    const testOut = await transaction((db) =>
      emitCommunicationEvent(db, {
        eventType: "payment.confirmed",
        entityType: "orders",
        entityId: testOrder.id,
        orderId: testOrder.id,
        orderPublicNo: testOrder.public_no,
        isTest: true,
        dedupeKey: `w21-t39-${testOrder.id}`,
        channels: ["in_app", "email"],
        recipients: [{ userId: customer1UserId, kind: "customer", orgId: customer1OrgId }],
      }),
    );
    assert.equal(await deliverEmailOnce(), true);
    assert.equal(sentPayloads.length, 1);
    assert.deepEqual(sentPayloads[0]!.to, ["isolated-test-sink@qcw.test"]);
    assert(sentPayloads[0]!.subject.startsWith("[TEST] "));

    const t39Comm = await admin.fetch(`/staff/admin/communications/${testOut.notification_id}`);
    assert.equal(t39Comm.master.is_test, true);
    const t39EmailDelivery = t39Comm.deliveries.find((d: { channel: string }) => d.channel === "email");
    assert.equal(t39EmailDelivery.is_test, true);
    assert.equal(t39EmailDelivery.state, "submitted");

    // 2. T99 on production order: email.delivered != read, hard bounce -> user_emails suppression + partial_failure + non-recursive alert
    const cust1PrimaryEmail = (
      await pool.query<{ email: string }>(
        "select normalized_email::text as email from user_emails where user_id = $1 and is_primary limit 1",
        [customer1UserId],
      )
    ).rows[0]!.email;
    assert(t39Comm);

    // Override mock fetch response ID for prodOrderT99
    sentPayloads.length = 0;
    nextBehavior = "deliver";
    nextReturnedMsgId = t99MsgId;
    const t99Out = await transaction((db) =>
      emitCommunicationEvent(db, {
        eventType: "payment.confirmed",
        entityType: "orders",
        entityId: prodOrderT99.id,
        orderId: prodOrderT99.id,
        orderPublicNo: prodOrderT99.public_no,
        isTest: false,
        dedupeKey: `w21-t99-${prodOrderT99.id}`,
        channels: ["in_app", "email"],
        recipients: [{ userId: customer1UserId, kind: "customer", orgId: customer1OrgId }],
      }),
    );
    assert.equal(await deliverEmailOnce(), true);
    assert.deepEqual(sentPayloads[0]!.to, [cust1PrimaryEmail]);
    assert(!sentPayloads[0]!.subject.startsWith("[TEST] "));

    const hookTs = String(Math.floor(Date.now() / 1000));
    const deliveredEvtId = randomUUID();
    const deliveredRaw = JSON.stringify({
      type: "email.delivered",
      data: { email_id: t99MsgId, to: [cust1PrimaryEmail] },
    });
    const deliveredSig = createHmac("sha256", key).update(`${deliveredEvtId}.${hookTs}.${deliveredRaw}`).digest("base64");
    const hookRes = await handle(
      new Request(`${appOrigin}/api/v1/webhooks/email/resend`, {
        method: "POST",
        headers: { "svix-id": deliveredEvtId, "svix-timestamp": hookTs, "svix-signature": `v1,${deliveredSig}` },
        body: deliveredRaw,
      }),
      "/webhooks/email/resend",
    );
    assert.equal(hookRes.status, 200);
    assert.equal(await transaction(consumeEmailWebhook), true);

    const afterDelivered = await admin.fetch(`/staff/admin/communications/${t99Out.notification_id}`);
    const deliveredEmailChannel = afterDelivered.deliveries.find((d: { channel: string }) => d.channel === "email");
    assert.equal(deliveredEmailChannel.state, "delivered");
    assert.equal(deliveredEmailChannel.read_at, null, "T99: email delivered must NEVER mark read_at");

    // 3. T99 hard bounce -> customer email suppressed + master becomes partial_failure + non-recursive alert + /actions unaffected
    const bounceEvtId = randomUUID();
    const bounceRaw = JSON.stringify({
      type: "email.bounced",
      data: { email_id: t99MsgId, to: [cust1PrimaryEmail], bounce: { type: "Permanent" } },
    });
    const bounceSig = createHmac("sha256", key).update(`${bounceEvtId}.${hookTs}.${bounceRaw}`).digest("base64");
    await handle(
      new Request(`${appOrigin}/api/v1/webhooks/email/resend`, {
        method: "POST",
        headers: { "svix-id": bounceEvtId, "svix-timestamp": hookTs, "svix-signature": `v1,${bounceSig}` },
        body: bounceRaw,
      }),
      "/webhooks/email/resend",
    );
    await transaction(consumeEmailWebhook);
    const afterBounce = await admin.fetch(`/staff/admin/communications/${t99Out.notification_id}`);
    assert.equal(afterBounce.master.status, "partial_failure");
    const c1NotifsAfterBounce = await c1.fetch("/me/notifications");
    const failAlert = c1NotifsAfterBounce.rows.find((r: { template: string }) => r.template === "email.delivery_failed");
    assert(failAlert, "Customer must see in-app email.delivery_failed alert");
    const actionsStillOpen = await c1.fetch("/actions");
    assert(actionsStillOpen.rows.some((i: { id: string }) => i.id === prodOrderT99.id));
    // Ensure non-recursive: email.delivery_failed NEVER queued into email_deliveries
    const recursiveEmails = await pool.query(
      `select 1 from email_deliveries d join notifications n on n.id = d.notification_id
       where n.id = $1`,
      [failAlert.id],
    );
    assert.equal(recursiveEmails.rowCount, 0, "Failure alert must NOT recursively queue another email");

    // Verify no plaintext email leaks in email.delivery_failed master entity_id/dedupe_key/detail
    const failHist = await admin.fetch("/staff/admin/communications/history?event_type=email.delivery_failed");
    assert(failHist.rows.length >= 1);
    const failMasterStr = JSON.stringify(failHist.rows[0]);
    assert(!failMasterStr.includes(cust1PrimaryEmail), "Plaintext email must never appear in communication history");
    const failDetail = await admin.fetch(`/staff/admin/communications/${failHist.rows[0].id}`);
    assert(!JSON.stringify(failDetail.master).includes(cust1PrimaryEmail));

    // 4. T100 timeout -> unknown state (not delivered), ops alert in super_admin inbox, blind retry disabled
    nextBehavior = "timeout";

    const t100Out = await transaction((db) =>
      emitCommunicationEvent(db, {
        eventType: "payment.confirmed",
        entityType: "orders",
        entityId: prodOrder.id,
        orderId: prodOrder.id,
        orderPublicNo: prodOrder.public_no,
        isTest: false,
        dedupeKey: `w21-t100-${prodOrder.id}`,
        channels: ["in_app", "email"],
        recipients: [{ userId: customer2UserId, kind: "customer", orgId: customer2OrgId }],
      }),
    );
    assert.equal(await deliverEmailOnce(), true);
    const t100Detail = await admin.fetch(`/staff/admin/communications/${t100Out.notification_id}`);
    const t100Email = t100Detail.deliveries.find((d: { channel: string }) => d.channel === "email");
    assert.equal(t100Email.state, "unknown", "Timeout must stay unknown, never delivered");
    const opsInbox = await admin.fetch("/staff/me/notifications?category=security");
    assert(opsInbox.notifications.some((n: { template: string }) => n.template === "email.channel_degraded"));
  } finally {
    process.env.QCW_DEMO = prevDemo;
    if (prevEmailProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = prevEmailProvider;
    if (prevTestInbox === undefined) delete process.env.QCW_TEST_EMAIL_INBOX;
    else process.env.QCW_TEST_EMAIL_INBOX = prevTestInbox;
  }
});

test("T125 legacy reconciliation idempotency (zero replay) and basic ticket locale + internal note isolation", async () => {
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test");
  const c1 = new Client();
  await c1.loginWithMfa("customer@qcw.test");
  const sup = new Client();
  await sup.loginWithMfa("support.w21@qcw.test");

  // 1. T125 / COM22 legacy notifications + historical delivered email migration without replay
  const legacyNotifId = randomUUID();
  const legacyEmailId = randomUUID();
  const oldReadAt = new Date("2025-05-01T10:00:00Z");
  await pool.query(
    `insert into notifications(id, user_id, template, locale, payload, dedupe_key, read_at, created_at)
     values($1, $2, 'report.published', 'en', '{"version":1}'::jsonb, $3, $4, $4)`,
    [legacyNotifId, customer1UserId, `legacy-w21-${legacyNotifId}`, oldReadAt],
  );
  await pool.query(
    `insert into email_deliveries(id, notification_id, address_snapshot, provider, provider_message_id, attempt, state, updated_at)
     values($1, $2, decode('6c6567616379', 'hex'), 'resend', 'hist_msg_w21', 1, 'delivered', $3)`,
    [legacyEmailId, legacyNotifId, oldReadAt],
  );

  const rec1 = await admin.fetch("/staff/admin/communications/reconcile-legacy", {}, "POST", 200);
  assert(rec1.migrated_masters >= 1);
  assert.equal(rec1.historical_replayed, 0);
  const rec2 = await admin.fetch("/staff/admin/communications/reconcile-legacy", {}, "POST", 200);
  assert.equal(rec2.migrated_masters, 0);
  assert.equal(rec2.historical_replayed, 0);

  const migratedRow = (
    await pool.query<{ content_origin: string; read_at: Date; provider_message_id: string }>(
      `select nm.content_origin, nr.read_at, ncd.provider_message_id
       from notification_recipients nr
       join notification_masters nm on nm.id = nr.notification_id
       join notification_channel_deliveries ncd on ncd.recipient_id = nr.id and ncd.channel = 'email'
       where nr.legacy_notification_id = $1`,
      [legacyNotifId],
    )
  ).rows[0]!;
  assert.equal(migratedRow.content_origin, "legacy_unknown");
  assert.equal(migratedRow.read_at.toISOString(), oldReadAt.toISOString());
  assert.equal(migratedRow.provider_message_id, "hist_msg_w21");

  // Verify legacy account.email_changed plaintext payload is stripped/redacted on reconciliation and read
  const legacyEmailChangeId = randomUUID();
  await pool.query(
    `insert into notifications(id, user_id, template, locale, payload, dedupe_key, created_at)
     values($1, $2, 'account.security_alert', 'en', '{"previous_email":"secret.old@example.com","new_email":"secret.new@example.com"}'::jsonb, $3, now())`,
    [legacyEmailChangeId, customer1UserId, `legacy-email-change-${legacyEmailChangeId}`],
  );
  await admin.fetch("/staff/admin/communications/reconcile-legacy", {}, "POST", 200);
  const custDetailRedacted = await c1.fetch(`/me/notifications/${legacyEmailChangeId}`);
  assert(!JSON.stringify(custDetailRedacted).includes("secret.old@example.com"));
  assert(!JSON.stringify(custDetailRedacted).includes("secret.new@example.com"));

  // 2. Basic ticket foundation: Chinese message preserves original_locale, emits ticket.created & ticket.customer_replied, isolates internal_note
  const offer = (await c1.fetch("/catalog")).offers.find((o: { sku_code: string }) => o.sku_code === "apparel-inspection-1");
  assert(offer);
  const ord = await c1.fetch(
    "/orders",
    { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 1 }] },
    "POST",
    201,
  );
  await pool.query("update orders set state = 'awaiting_payment' where id = $1", [ord.id]);
  const createdCase = await c1.fetch(
    `/orders/${ord.id}/inspection-instructions`,
    { body: "请重点核查领口缝线是否开线，并保留英文与中文对照说明。" },
    "POST",
    201,
  );
  await sup.fetch(`/staff/tickets/${createdCase.id}/events`, { kind: "claim", revision: 1 });
  await sup.fetch(`/staff/tickets/${createdCase.id}/events`, {
    kind: "internal_note",
    revision: 2,
    body: "INTERNAL ONLY: Assign experienced garment inspector B.",
  });

  // Customer replies -> ticket.customer_replied delivered directly to assignee support agent
  await c1.fetch(`/cases/${createdCase.id}/messages`, {
    revision: 3,
    body: "已补充尺码说明，请确认查收。",
  });

  const customerCase = await c1.fetch(`/cases/${createdCase.id}`);
  assert.equal(customerCase.original_locale, "zh-CN");
  assert(
    !JSON.stringify(customerCase.events).includes("INTERNAL ONLY"),
    "internal_note must NEVER leak to customer case view",
  );
  const supInbox = await sup.fetch("/staff/me/notifications?category=support");
  assert(supInbox.notifications.some((n: { template: string }) => n.template === "ticket.created"));
  assert(supInbox.notifications.some((n: { template: string }) => n.template === "ticket.customer_replied"));

  // Outbox worker still processes ticket.reply via unified emitCommunicationEvent
  await sup.fetch(`/staff/tickets/${createdCase.id}/events`, {
    kind: "reply",
    revision: 4,
    body: "We have noted your collar stitching check request.",
  });
  while (await workOnce()) {}
  const c1AfterReply = await c1.fetch("/me/notifications?category=support");
  assert(c1AfterReply.rows.some((r: { template: string }) => r.template === "ticket.reply"));
});
