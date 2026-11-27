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
const { addEmailOtpIdentity } = await import("../packages/core/auth");
const { renderTransactionalEmailFromTemplate } = await import("../packages/core/email");

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
    ["receiving", "inspector", "reviewer", "admin"].map((n) => n + "@qcw.test"),
  ]);
});

after(() => pool.end());

class Client {
  private jar = new Map<string, string>();
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200, key = randomUUID()) {
    const csrf = this.jar.get("qcw_csrf");
    const req = new Request(origin + "/api/v1" + path, {
      method,
      headers: {
        cookie: [...this.jar].map(([k, v]) => k + "=" + v).join("; "),
        ...(method !== "GET"
          ? {
              origin,
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
    assert.equal(res.status, expected, path + " " + JSON.stringify(data));
    return data;
  }
  async login(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
}

async function createStaffAdmin(emailPrefix: string) {
  const email = `${emailPrefix}-${randomUUID().slice(0, 6)}@qcw.test`;
  const userId = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id,display_name,locale) values($1,$2,'zh-CN')", [userId, "Backup Owner"]);
    const ver = await db.query<{ id: string }>(
      `insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
       values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,
      [userId, email],
    );
    await addEmailOtpIdentity(db, userId, ver.rows[0].id);
    await db.query("insert into staff_roles(user_id,role) values($1,'super_admin')", [userId]);
  });
  const c = new Client();
  await c.login(email);
  return { client: c, userId, email };
}

test("TASK-194B: bilingual notification templates enforce SoD publish, XSS guard & honest email readiness", async () => {
  const admin = new Client();
  await admin.login("admin@qcw.test");
  const { client: admin2, userId: admin2Id } = await createStaffAdmin("owner2");
  const receiver = new Client();
  await receiver.login("receiving@qcw.test");

  // 1) Ordinary receiver is blocked from reading/editing templates & email readiness
  await receiver.fetch("/staff/admin/notification-templates", undefined, "GET", 403);
  await receiver.fetch("/staff/admin/email-readiness", undefined, "GET", 403);

  // 2) Seeded bilingual published templates exist (payment.confirmed en-US + zh-CN)
  const list = await admin.fetch("/staff/admin/notification-templates");
  assert(list.templates.some((t: { template_code: string; locale: string; status: string }) => t.template_code === "payment.confirmed" && t.locale === "zh-CN" && t.status === "published"));
  assert(list.templates.some((t: { template_code: string; locale: string; status: string }) => t.template_code === "payment.confirmed" && t.locale === "en-US" && t.status === "published"));

  // 3) Reject unsafe HTML/script tags and unsupported runtime placeholders in template body
  await admin.fetch(
    "/staff/admin/notification-templates",
    {
      template_code: "payment.confirmed",
      locale: "zh-CN",
      subject_template: "Bad <script>alert(1)</script> {ref}",
      body_template: "Open {link}",
      allowed_variables: ["ref", "link"],
    },
    "POST",
    422,
  );
  await admin.fetch(
    "/staff/admin/notification-templates",
    {
      template_code: "payment.confirmed",
      locale: "zh-CN",
      subject_template: "Bad {secretToken}",
      body_template: "Open {link}",
      allowed_variables: ["ref", "link"],
    },
    "POST",
    422,
  );

  // 4) Create v2 zh-CN draft, reject author self-publish (SoD), expire admin2 MFA -> 403, refresh MFA -> publish v2
  const draft = await admin.fetch(
    "/staff/admin/notification-templates",
    {
      template_code: "payment.confirmed",
      locale: "zh-CN",
      subject_template: "V2 付款已核收{ref}",
      body_template: "V2 专属对账链接：{link}",
      allowed_variables: ["ref", "link"],
    },
    "POST",
    201,
  );
  assert.equal(draft.version, 2);
  await admin.fetch(`/staff/admin/notification-templates/${draft.id}/publish`, {}, "POST", 403);

  await pool.query("update sessions set mfa_at = now() - interval '30 minutes' where user_id = $1", [admin2Id]);
  await admin2.fetch(`/staff/admin/notification-templates/${draft.id}/publish`, {}, "POST", 403);
  await pool.query("update sessions set mfa_at = now() where user_id = $1", [admin2Id]);

  const pub = await admin2.fetch(`/staff/admin/notification-templates/${draft.id}/publish`, {}, "POST", 200);
  assert.equal(pub.status, "published");

  const rendered = await renderTransactionalEmailFromTemplate(pool, {
    templateCode: "payment.confirmed",
    locale: "zh",
    orderPublicNo: "QW261127001",
    isTest: false,
  });
  assert.equal(rendered.locale, "zh-CN");
  assert.equal(rendered.templateVersion, 2);
  assert.match(rendered.subject, /^V2 付款已核收/);

  // 5) Readiness strictly never conflates connection test with live delivery
  const readiness = await admin.fetch("/staff/admin/email-readiness");
  assert.equal(readiness.connection_test_equals_live_delivery, false);
});

test("TASK-178: legal entities, merchant instances (accepting_new vs legacy_only) & opening readiness matrix", async () => {
  const admin = new Client();
  await admin.login("admin@qcw.test");
  const receiver = new Client();
  await receiver.login("receiving@qcw.test");

  await receiver.fetch("/staff/admin/legal-entities", undefined, "GET", 403);
  await receiver.fetch("/staff/admin/merchant-instances", undefined, "GET", 403);
  await receiver.fetch("/staff/admin/opening-readiness", undefined, "GET", 403);
  const inspector = new Client();
  await inspector.login("inspector@qcw.test");
  await inspector.fetch("/staff/admin/opening-readiness", undefined, "GET", 403);
  await inspector.fetch("/staff/admin/merchant-instances", undefined, "GET", 403);

  // 1) Company without registration_no is rejected, whereas individual_operator needs no fake BR
  await admin.fetch(
    "/staff/admin/legal-entities",
    {
      entity_code: "CO_MISSING_BR",
      entity_type: "company",
      public_trade_name: "Test Co",
      legal_name: "Test Co Limited",
      jurisdiction: "HK",
      contact_email: "ops@example.com",
      service_address: "Room 101, HK",
    },
    "POST",
    422,
  );

  const ind = await admin.fetch(
    "/staff/admin/legal-entities",
    {
      entity_code: "IND_HK_01",
      entity_type: "individual_operator",
      public_trade_name: "QC Studio Operator",
      legal_name: "Individual Operator HK",
      jurisdiction: "HK",
      contact_email: "owner@example.com",
      service_address: "Workshop 2, Kowloon, HK",
    },
    "POST",
    201,
  );
  const co = await admin.fetch(
    "/staff/admin/legal-entities",
    {
      entity_code: "HK_CORP_02",
      entity_type: "company",
      public_trade_name: "QC Warehouse HK",
      legal_name: "QC Warehouse Testing Limited",
      jurisdiction: "HK",
      registration_no: "BR-99887766",
      contact_email: "corp@example.com",
      service_address: "Unit 5, New Territories, HK",
    },
    "POST",
    201,
  );

  await admin.fetch(`/staff/admin/legal-entities/${ind.id}/activate`, {});
  await admin.fetch(`/staff/admin/legal-entities/${ind.id}/retire`, {}, "POST", 409); // active default cannot retire
  await admin.fetch(`/staff/admin/legal-entities/${co.id}/activate`, {}); // switches default cleanly
  await admin.fetch(`/staff/admin/legal-entities/${ind.id}/retire`, {}); // now allowed; historical data preserved

  const entities = await admin.fetch("/staff/admin/legal-entities");
  const coRow = entities.entities.find((e: { id: string }) => e.id === co.id);
  const indRow = entities.entities.find((e: { id: string }) => e.id === ind.id);
  assert.equal(coRow.is_default_for_new_orders, true);
  assert.equal(indRow.status, "retired");
  assert.equal(indRow.legal_name, "Individual Operator HK");

  // 2) Dual Stripe merchant instances: switch primary and retire legacy to legacy_only without losing account record
  const m1 = await admin.fetch(
    "/staff/admin/merchant-instances",
    {
      instance_code: "stripe-hk-legacy",
      provider: "stripe",
      environment: "live",
      legal_entity_id: co.id,
      external_account_id: "acct_legacy_001",
      supported_currencies: ["USD"],
      settlement_account_masked: "ZA ****1111",
      status: "accepting_new",
      is_primary_for_new_orders: true,
    },
    "POST",
    201,
  );
  const m2 = await admin.fetch(
    "/staff/admin/merchant-instances",
    {
      instance_code: "stripe-hk-new",
      provider: "stripe",
      environment: "live",
      legal_entity_id: co.id,
      external_account_id: "acct_new_002",
      supported_currencies: ["USD", "CNY"],
      settlement_account_masked: "HSBC ****2222",
      status: "accepting_new",
      is_primary_for_new_orders: true,
    },
    "POST",
    201,
  );
  await admin.fetch(`/staff/admin/merchant-instances/${m1.id}/status`, {
    status: "legacy_only",
    reason: "Cut over new orders to stripe-hk-new while preserving legacy refunds/disputes",
  });

  const instances = await admin.fetch("/staff/admin/merchant-instances");
  const m1After = instances.instances.find((m: { id: string }) => m.id === m1.id);
  const m2After = instances.instances.find((m: { id: string }) => m.id === m2.id);
  assert.equal(m1After.status, "legacy_only");
  assert.equal(m1After.is_primary_for_new_orders, false);
  assert.equal(m2After.status, "accepting_new");
  assert.equal(m2After.is_primary_for_new_orders, true);

  // 3) Opening readiness capability matrix separates required/conditional/optional cleanly
  const readiness = await admin.fetch("/staff/admin/opening-readiness");
  assert.equal(readiness.capabilities.google_oidc.tier, "required");
  assert.equal(readiness.capabilities.microsoft_oidc.tier, "required");
  assert.equal(readiness.capabilities.legal_entity.configured, true);
  assert.equal(readiness.capabilities.paypal_manual.default_off, true);
  assert.equal(readiness.capabilities.ocr_paddle.blocks_manual_workflow, false);
  assert.equal(readiness.opening_approved, false);
});
