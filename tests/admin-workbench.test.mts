import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  "The test database must be separate from the application database."
);

process.env.DATABASE_URL = target;
process.env.QCW_DEMO = "1";
process.env.NODE_ENV = "test";
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const { handle } = await import("../packages/core/http");
const { pool, transaction } = await import("../packages/db");
const { workOnce } = await import("../packages/core/worker");
const { addEmailOtpIdentity } = await import("../packages/core/auth");

before(async () => {
  const actual = await pool.query<{ name: string }>("select current_database() name");
  assert.equal(actual.rows[0].name, databaseName, "Connected to a different database than expected.");
  await pool.query("drop schema if exists public cascade; create schema public;");
  for (const args of [
    ["--env-file-if-exists=.env", "scripts/migrate.mjs"],
    ["--env-file-if-exists=.env", "--import", "tsx", "scripts/demo.ts"],
  ]) {
    execFileSync(process.execPath, args, { env: process.env, stdio: "pipe" });
  }
  await pool.query(readFileSync(new URL("./shadow-categories.sql", import.meta.url), "utf8"));
  await pool.query("delete from verification_challenges where target_email::text = any($1::text[])", [
    ["receiving", "inspector", "reviewer", "admin"].map(name => name + "@qcw.test"),
  ]);
});

after(() => pool.end());

class Client {
  private jar = new Map<string, string>();
  sessionHash() {
    const secret = this.jar.get("session");
    assert(secret, "Sign in before referencing the session.");
    return createHash("sha256").update(secret).digest("hex");
  }
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200, key = randomUUID()) {
    const multipart = body instanceof FormData;
    const rawBinary = body instanceof Uint8Array;
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
              ...(!multipart && !rawBinary ? { "content-type": "application/json" } : rawBinary ? { "content-type": "image/png" } : {}),
            }
          : {}),
      },
      ...(body !== undefined ? { body: multipart ? body : rawBinary ? new Uint8Array(body) : JSON.stringify(body) } : {}),
    });
    const response = await handle(req, path.split("?")[0]);
    for (const c of response.headers.getSetCookie()) {
      const match = c.match(/^([^=]+)=([^;]*)/);
      if (match) this.jar.set(match[1], match[2]);
    }
    const data = await response.json();
    assert.equal(response.status, expected, path + " " + JSON.stringify(data));
    return data;
  }
  async login(email: string) {
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

async function staffLogin(email: string) {
  const client = new Client();
  const res = await client.login(email);
  assert.equal(res.kind, "staff");
  return client;
}

async function createStaffWithRoles(roles: string[]) {
  const email = `staff-${randomUUID().slice(0, 8)}@qcw.test`;
  const userId = randomUUID();
  await transaction(async db => {
    await db.query("insert into users(id,display_name,locale) values($1,$2,'zh-CN')", [userId, `Test ${roles.join(",")}`]);
    const verified = await db.query<{ id: string }>(
      `insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
       values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,
      [userId, email]
    );
    await addEmailOtpIdentity(db, userId, verified.rows[0].id);
    for (const role of roles) {
      await db.query("insert into staff_roles(user_id,role) values($1,$2)", [userId, role]);
    }
  });
  const client = await staffLogin(email);
  return { client, userId, email };
}

async function signCustomer() {
  const c = new Client();
  const email = `cust-${randomUUID().slice(0, 8)}@qcw.test`;
  const result = await c.login(email);
  assert.equal(result.state, "onboarding");
  const { terms } = await c.fetch("/public/terms");
  const registration = await c.fetch("/auth/registration/complete", {
    terms_version_ids: terms.filter((t: { kind: string }) => ["terms", "privacy"].includes(t.kind)).map((t: { id: string }) => t.id),
  });
  return { c, registration, terms, email };
}

test("admin workbench: payment refund state sync (partially_refunded -> refunded), refund reject, audit & detail reads", async () => {
  const admin = await staffLogin("admin@qcw.test");
  const receiver = await staffLogin("receiving@qcw.test");
  const { client: support } = await createStaffWithRoles(["support"]);
  const { client: finance } = await createStaffWithRoles(["finance"]);
  const { c, registration, terms, email } = await signCustomer();
  const customerId = (await c.fetch("/me")).actor.id as string;

  const catalog = await c.fetch("/catalog");
  const offer = catalog.offers.find(
    (o: { sku_code?: string; service?: string; category_id: string; offer_id: string; rules?: { unit_cents?: number; maximum?: number } }) =>
      o.sku_code === "apparel-inspection-1" || (o.service === "inspection" && o.rules?.unit_cents != null && (o.rules.maximum ?? 1) >= 2)
  );
  assert(offer, "Expected unit-priced apparel inspection offer");

  // Create & pay a 2-unit order ($58 total for 2 * unit_cents)
  const draft = await c.fetch("/orders", { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 2 }] }, "POST", 201);
  const quote = await c.fetch(`/orders/${draft.id}/quotes`, { revision: draft.revision }, "POST", 201);
  const ack = { scope_notice: true, samples_not_batch: true, seller_refund_is_mine: true, no_certification: true, restricted_items: true };
  const sub = await c.fetch(
    `/orders/${draft.id}/submit`,
    { revision: draft.revision, quote_id: quote.id, terms_version_ids: terms.map((t: { id: string }) => t.id), acknowledgements: ack },
    "POST",
    200
  );
  const pay = await c.fetch(`/charges/${sub.charge.charge_item_id}/checkout`, { quote_revision: quote.revision });
  await c.fetch(`/checkout/demo/${pay.attempt_id}`, {});

  // 1. Check Admin orders search hides raw email while enriching receiving_code, payment_state & detail sections
  const orderList = await admin.fetch(`/staff/orders?query=${encodeURIComponent(draft.public_no)}&test=all`);
  assert.equal(orderList.rows.length, 1);
  assert(!JSON.stringify(orderList.rows).includes(email), "Must never leak customer email into /staff/orders rows");
  assert.equal(orderList.rows[0].receiving_code, registration.receiving_code);
  assert.equal(orderList.rows[0].payment_state, "paid");
  assert.equal(orderList.rows[0].expected_units, 2);

  const orderDetail = await admin.fetch(`/staff/orders/by-number/${draft.public_no}`);
  assert.equal(orderDetail.customer.receiving_code, registration.receiving_code);
  assert(Array.isArray(orderDetail.payments) && orderDetail.payments.length === 1);
  assert(orderDetail.expected_lines_summary && orderDetail.expected_lines_summary.expected_units_total === 2);
  assert(Array.isArray(orderDetail.charges) && orderDetail.charges.length === 1);

  // 2. Request partial refund (1 unit) as support, then verify MFA, SoD, approve w/ note, and execute via worker
  const unitCents = offer.rules.unit_cents as number;
  const r1 = await support.fetch(
    `/staff/orders/${draft.id}/refunds`,
    { payment_id: pay.attempt_id, amount_cents: unitCents, reason: "Customer reduced 1 garment prior to inspection" },
    "POST",
    201
  );
  // Check Admin refund detail reads
  const r1Detail = await admin.fetch(`/staff/admin/refunds/${r1.refund_id}`);
  assert.equal(r1Detail.refund.state, "requested");
  assert.equal(r1Detail.linked_orders[0].public_no, draft.public_no);
  assert.equal(r1Detail.funds_check.remaining_refundable_cents, unitCents * 2);

  // Verify expired MFA fails 403 STAFF_REAUTH_REQUIRED on /staff/admin/refunds/:id/approve
  await pool.query("update sessions set mfa_at = now() - interval '20 minutes' where token_hash = $1", [admin.sessionHash()]);
  const staleApprove = await admin.fetch(`/staff/admin/refunds/${r1.refund_id}/approve`, { revision: 1, note: "Audit note" }, "POST", 403);
  assert.equal(staleApprove.error.code, "STAFF_REAUTH_REQUIRED");
  await admin.login("admin@qcw.test");

  // Approve w/ audit note
  await admin.fetch(`/staff/admin/refunds/${r1.refund_id}/approve`, { revision: 1, note: "Verified partial cancellation prior to intake" }, "POST", 202);
  for (let i = 0; i < 50; i++) {
    if (!(await workOnce())) break;
  }

  // Verify payments.state transitioned to partially_refunded and detail/list reflect it!
  const pDetailAfterPartial = await admin.fetch(`/staff/admin/payments/${pay.attempt_id}`);
  assert.equal(pDetailAfterPartial.payment.state, "partially_refunded");
  assert.equal(pDetailAfterPartial.refund_summary.remaining_refundable_cents, unitCents);
  assert.equal(pDetailAfterPartial.refund_summary.refunded_succeeded_cents, unitCents);
  const pListPartial = await admin.fetch(`/staff/admin/payments?state=partially_refunded&test=all`);
  assert(pListPartial.rows.some((r: { id: string }) => r.id === pay.attempt_id));

  // 3. Test refund rejection + SoD + MFA + balance release
  const rRejectByAdmin = await admin.fetch(
    `/staff/orders/${draft.id}/refunds`,
    { payment_id: pay.attempt_id, amount_cents: 100, reason: "Test self-rejection SoD guard" },
    "POST",
    201
  );
  // Self-reject by same requester must fail SoD 409
  await admin.fetch(`/staff/admin/refunds/${rRejectByAdmin.refund_id}/reject`, { revision: 1, reason: "Self reject attempt" }, "POST", 409);

  // Create second super_admin to reject rRejectByAdmin
  const { client: admin2, email: admin2Email } = await createStaffWithRoles(["super_admin"]);
  // Stale MFA fails 403
  await pool.query("update sessions set mfa_at = now() - interval '20 minutes' where token_hash = $1", [admin2.sessionHash()]);
  const staleReject = await admin2.fetch(`/staff/admin/refunds/${rRejectByAdmin.refund_id}/reject`, { revision: 1, reason: "Rejected without cause" }, "POST", 403);
  assert.equal(staleReject.error.code, "STAFF_REAUTH_REQUIRED");
  // Refresh admin2 MFA directly via re-login
  await admin2.login(admin2Email);

  const rejectedRes = await admin2.fetch(
    `/staff/admin/refunds/${rRejectByAdmin.refund_id}/reject`,
    { revision: 1, reason: "Unsupported claim: item already entered active QC" },
    "POST",
    200
  );
  assert.equal(rejectedRes.state, "rejected");

  const rRejectedDetail = await admin.fetch(`/staff/admin/refunds/${rRejectByAdmin.refund_id}`);
  assert.equal(rRejectedDetail.refund.state, "rejected");
  assert.equal(rRejectedDetail.funds_check.remaining_refundable_cents, unitCents, "Rejected refund must release reserved refundable balance");
  const rList = await admin.fetch(`/staff/admin/refunds?tab=all&test=all`);
  assert(rList.rows.some((x: { id: string; state: string }) => x.id === rRejectByAdmin.refund_id && x.state === "rejected"));

  // 4. Approve remaining full balance refund and confirm payments.state -> refunded
  const r2 = await support.fetch(
    `/staff/orders/${draft.id}/refunds`,
    { payment_id: pay.attempt_id, amount_cents: unitCents, reason: "Customer withdrew remaining unit" },
    "POST",
    201
  );
  await admin.fetch(`/staff/admin/refunds/${r2.refund_id}/approve`, { revision: 1, note: "Final balance refund approved" }, "POST", 202);
  for (let i = 0; i < 50; i++) {
    if (!(await workOnce())) break;
  }
  const pDetailAfterFull = await admin.fetch(`/staff/admin/payments/${pay.attempt_id}`);
  assert.equal(pDetailAfterFull.payment.state, "refunded");
  assert.equal(pDetailAfterFull.refund_summary.remaining_refundable_cents, 0);

  // 5. Verify Customer 360, Inspections, Dispositions, Storage Location Detail, Unmatched Packages & RBAC
  await c.fetch("/staff/admin/customers", undefined, "GET", 403);
  await c.fetch(`/staff/admin/payments/${pay.attempt_id}`, undefined, "GET", 403);
  await receiver.fetch("/staff/admin/customers", undefined, "GET", 403);
  await receiver.fetch("/staff/admin/payments", undefined, "GET", 403);

  const custList = await admin.fetch(`/staff/admin/customers?q=${encodeURIComponent(registration.receiving_code)}`);
  assert.equal(custList.rows.length, 1);
  const cust360Admin = await admin.fetch(`/staff/admin/customers/${customerId}`);
  assert.equal(cust360Admin.profile.email, email);
  assert.equal(cust360Admin.orders.length, 1);
  assert.equal(cust360Admin.payments.length, 1);
  assert.equal(cust360Admin.refunds.length, 3);

  const cust360Finance = await finance.fetch(`/staff/admin/customers/${customerId}`);
  assert.notEqual(cust360Finance.profile.email, email, "Finance role should see masked email on customer 360");

  // Storage location detail & inspections overview
  const locs = await admin.fetch("/staff/admin/storage/locations");
  assert(locs.rows.length > 0);
  const locDetail = await admin.fetch(`/staff/admin/storage/locations/${locs.rows[0].id}`);
  assert.equal(locDetail.location.id, locs.rows[0].id);
  assert(Array.isArray(locDetail.items) && Array.isArray(locDetail.moves));

  const insp = await admin.fetch("/staff/admin/inspections");
  assert(insp.summary && Array.isArray(insp.tasks) && Array.isArray(insp.reports));

  const dispSupport = await support.fetch("/staff/admin/dispositions-overview");
  assert(Array.isArray(dispSupport.batches) && Array.isArray(dispSupport.manual_quotes));

  // Unmatched parcel shows up in /staff/admin/desk.unmatchedPackages with revision & photo,
  // and bind-owner requires photo + revision and removes it from unmatched queue!
  const outerPhoto = await receiver.photo("intake_outer");
  const uLoc = locs.rows.find((l: { zone: string }) => l.zone === "unmatched");
  assert(uLoc, "Expected unmatched storage location U-01");
  const checkedIn = await receiver.fetch(
    "/staff/intake/check-in",
    {
      tracking_no: "ZTO" + randomUUID().slice(0, 10).toUpperCase(),
      carrier_code: "zto",
      outer_condition: "intact",
      weight_g: 500,
      location_id: uLoc.id,
      outer_media_ids: [outerPhoto],
    },
    "POST",
    201
  );
  const pkgId = checkedIn.id ?? checkedIn.package_id;
  const deskAfterIntake = await admin.fetch("/staff/admin/desk");
  assert(Array.isArray(deskAfterIntake.unmatchedPackages) && deskAfterIntake.unmatchedPackages.length >= 1);
  const targetUnmatched = deskAfterIntake.unmatchedPackages.find((p: { id: string }) => p.id === pkgId);
  assert(targetUnmatched, "Unmatched package must appear in /staff/admin/desk.unmatchedPackages");
  assert(targetUnmatched.outer_photo_ids.includes(outerPhoto));
  assert.equal(typeof targetUnmatched.revision, "number");

  // Bind owner via real bind-owner API using targetUnmatched.revision & fresh label_photo, then intake 1 item
  const labelPhoto = await receiver.photo("label_photo");
  const boundRes = await receiver.fetch(
    `/staff/packages/${pkgId}/bind-owner`,
    {
      revision: targetUnmatched.revision,
      receiving_code: registration.receiving_code,
      evidence_ids: [labelPhoto],
      reason: "Matched shipping label to customer code",
    },
    "POST",
    200
  );
  const deskAfterBind = await admin.fetch("/staff/admin/desk");
  assert(!deskAfterBind.unmatchedPackages.some((p: { id: string }) => p.id === pkgId));

  const postLoc = locs.rows.find((l: { zone: string }) => l.zone === "post_inspection");
  assert(postLoc, "Expected post_inspection storage location");
  const itemCode = "S-ADM" + randomUUID().slice(0, 6).toUpperCase();
  const itemIntake = await receiver.fetch(
    `/staff/packages/${pkgId}/items`,
    { revision: boundRes.revision ?? targetUnmatched.revision + 1, items: [{ code: itemCode, location_id: postLoc.id }] },
    "POST",
    201
  );
  const incItem = { id: itemIntake.item_ids[0] as string, code: itemCode };
  // Mark item storage overdue for disposal case test
  await pool.query("update warehouse_items set received_at=now()-interval '100 days', storage_until=now()-interval '5 days' where id=$1", [incItem.id]);
  const incCreated = await receiver.fetch(
    "/staff/incidents",
    {
      item_code: incItem.code,
      kind: "damage",
      summary_en: "Seam torn during warehouse handling test",
      internal_note: "Internal review note",
    },
    "POST",
    201
  );
  await receiver.fetch(
    `/staff/incidents/${incCreated.incident_id}/propose`,
    {
      service_refund_cents: unitCents,
      compensation_cents: 1200,
      currency: "USD",
      summary_en: "Proposed refund + $12 USD goodwill credit",
    },
    "POST",
    200
  );
  const incForAdmin = await admin.fetch(`/staff/admin/incidents/${incCreated.incident_id}`);
  assert.equal(incForAdmin.incident.resolution.kind, "damage");
  assert.equal(incForAdmin.incident.resolution.compensation_cents, 1200);
  const incForReceiver = await receiver.fetch(`/staff/admin/incidents/${incCreated.incident_id}`);
  assert.equal(incForReceiver.incident.financial_restricted, true);
  assert.equal(incForReceiver.incident.resolution.financial_restricted, true);
  assert.equal(incForReceiver.incident.resolution.compensation_cents, undefined);

  // Disposal detail endpoint
  const dispCreated = await admin.fetch(
    "/staff/disposals",
    {
      org_id: (await pool.query("select org_id from orders where id=$1", [draft.id])).rows[0].org_id,
      item_ids: [incItem.id],
      reason: "Overdue 90+ days fixture for disposal workbench test",
      legal_basis_version: "TOS-2026-V2",
      customer_authorized: false,
    },
    "POST",
    201
  );
  const dispDetail = await admin.fetch(`/staff/admin/disposals/${dispCreated.id}`);
  assert.equal(dispDetail.case.id, dispCreated.id);
  assert.equal(dispDetail.items.length, 1);
  assert.equal(dispDetail.items[0].code, incItem.code);
});
