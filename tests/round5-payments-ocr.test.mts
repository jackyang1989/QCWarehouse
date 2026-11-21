import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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
const { workOnce, trackingTick } = await import("../packages/core/worker");
const { unseal } = await import("../packages/core/crypto");
const { assertSafeExternalUrl } = await import("../packages/core/integrations-admin");
const { paypalAutoAdapter } = await import("../packages/core/payment-providers");
const { parseOcrDocument } = await import("../packages/core/ocr-parser");
const { addEmailOtpIdentity } = await import("../packages/core/auth");

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
    ["receiving", "inspector", "reviewer", "finance", "admin", "customer"].map((n) => n + "@qcw.test"),
  ]);
});

after(() => pool.end());

class Client {
  private jar = new Map<string, string>();
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
              ...(!multipart && !rawBinary ? { "content-type": "application/json" } : rawBinary ? { "content-type": "application/octet-stream" } : {}),
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
    assert.equal(response.status, expected, `${method} ${path} -> expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`);
    return data;
  }
  async login(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
  async uploadAttachment(bytes: Buffer, mime: string, filename: string) {
    const fd = new FormData();
    fd.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    return (await this.fetch("/me/media", fd, "POST", 201)).id as string;
  }
}

async function loginAs(email: string) {
  const c = new Client();
  await c.login(email);
  return c;
}

async function createIsolatedCustomer(email: string) {
  const userId = randomUUID();
  const orgId = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id, display_name, locale) values($1, $2, 'en')", [userId, email]);
    await db.query("insert into organizations(id, name) values($1, $2)", [orgId, "Org " + email]);
    await db.query("insert into memberships(user_id, org_id) values($1, $2)", [userId, orgId]);
    await db.query("insert into customer_receiving_profiles(user_id, org_id, receiving_code) values($1, $2, $3)", [
      userId,
      orgId,
      "QCW-" + randomUUID().slice(0, 5).toUpperCase(),
    ]);
    const em = (
      await db.query<{ id: string }>(
        `insert into user_emails(user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
         values($1, $2::text, ($2::text)::citext, now(), true, true) returning id`,
        [userId, email],
      )
    ).rows[0];
    await addEmailOtpIdentity(db, userId, em.id);
  });
  return loginAs(email);
}

async function render1688OrderPng(lines: string[]): Promise<Buffer> {
  const tspans = lines
    .map((line, i) => `<text x="36" y="${54 + i * 54}" font-family="Arial, PingFang SC, sans-serif" font-size="24" fill="#111111">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`)
    .join("");
  const height = Math.max(240, 70 + lines.length * 56);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>${tspans}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function buildNativePdf(lines: string[], pageCount = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([612, 792]);
    let y = 730;
    for (const ln of lines) {
      page.drawText(`${p > 0 ? `[Page ${p + 1}] ` : ""}${ln}`, { x: 40, y, size: 12, font, color: rgb(0, 0, 0) });
      y -= 24;
    }
  }
  return Buffer.from(await doc.save());
}

async function buildScannedPdfFromPng(pngBytes: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(pngBytes);
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return Buffer.from(await doc.save());
}

async function createSubmittedOpenOrder(cust: Client, tag: string) {
  const cat = await cust.fetch("/catalog");
  const offer = cat.offers.find(
    (o: any) => o.sku_code === "apparel-inspection-1" || (o.service === "inspection" && o.rules?.unit_cents != null && (o.rules.maximum ?? 1) >= 2),
  );
  assert(offer, "Expected apparel inspection offer");
  const draft = await cust.fetch(
    "/orders",
    {
      lines: [
        {
          category_id: offer.category_id,
          offer_id: offer.offer_id,
          quantity: 2,
        },
      ],
    },
    "POST",
    201,
  );
  const quote = await cust.fetch(`/orders/${draft.id}/quotes`, { revision: draft.revision }, "POST", 201);
  const { terms } = await cust.fetch("/public/terms");
  const sub = await cust.fetch(`/orders/${draft.id}/submit`, {
    revision: draft.revision,
    quote_id: quote.id,
    terms_version_ids: terms.map((t: any) => t.id),
    acknowledgements: {
      scope_notice: true,
      samples_not_batch: true,
      seller_refund_is_mine: true,
      no_certification: true,
      restricted_items: true,
    },
  });
  return { orderId: draft.id, publicNo: draft.public_no, chargeId: sub.charge.charge_item_id, quoteRevision: quote.revision };
}

test("Round 5 Integrations, Vault Secrets & Multi-Channel Payments (20 Scenarios)", async (t) => {
  const admin = await loginAs("admin@qcw.test");
  const finance = await loginAs("finance@qcw.test");
  const inspector = await loginAs("inspector@qcw.test");
  const customer = await loginAs("customer@qcw.test");

  await t.test("P01: Integration registry seed preserves HK Stripe KYC + ZA Bank and Zero China ICP", async () => {
    const hub = await admin.fetch("/staff/admin/integrations");
    assert.ok(hub.providers.length >= 14);
    for (const p of hub.providers) {
      assert.equal(p.requires_icp, false, `${p.provider_key} must never require ICP`);
      assert.equal(p.config.no_icp_required, true);
    }
    const stripe = hub.providers.find((p: any) => p.provider_key === "stripe");
    assert.equal(stripe.config.kyc_status, "verified");
    assert.equal(stripe.config.payout_bank, "ZA Bank (HK)");
    assert.equal(stripe.config.live_checkout_verified, false);
    assert.equal(stripe.config.live_webhook_verified, false);

    const ppManual = hub.providers.find((p: any) => p.provider_key === "paypal_manual");
    assert.equal(ppManual.enabled, false);
    assert.equal(ppManual.lifecycle_state, "disabled");
  });

  await t.test("P02: Vault stores AES-256-GCM encrypted secrets, masks API responses, and never leaks plaintext", async () => {
    const rawSecret = "sk_test_51R5RoundFiveVaultExample9999";
    const saved = await admin.fetch("/staff/admin/integrations/stripe/secrets", {
      environment: "sandbox",
      secret_name: "secret_key",
      secret_value: rawSecret,
    });
    assert.equal(saved.key_version, 1);
    assert.equal(saved.masked_hint, "sk_test_****9999");

    const hub = await admin.fetch("/staff/admin/integrations?domain=payment");
    const serialized = JSON.stringify(hub);
    assert.equal(serialized.includes(rawSecret), false, "Plaintext secret must NEVER appear in API JSON");

    const dbRow = (await pool.query("select ciphertext from integration_secrets where id=$1", [saved.id])).rows[0];
    assert.notEqual(dbRow.ciphertext.toString("utf8"), rawSecret);
    assert.equal(unseal(dbRow.ciphertext), rawSecret);
  });

  await t.test("P03: Secret rotation increments version and revocation marks unconfigured", async () => {
    const rotated = await admin.fetch("/staff/admin/integrations/stripe/secrets", {
      environment: "sandbox",
      secret_name: "secret_key",
      secret_value: "sk_test_51R5RotatedSecret8888",
    });
    assert.equal(rotated.key_version, 2);
    assert.equal(rotated.rotated, true);

    const revoked = await admin.fetch("/staff/admin/integrations/stripe/secrets/revoke", {
      environment: "sandbox",
      secret_name: "secret_key",
    });
    assert.equal(revoked.revoked, true);

    const hub = await admin.fetch("/staff/admin/integrations?domain=payment");
    const stripe = hub.providers.find((p: any) => p.provider_key === "stripe");
    assert.equal(stripe.health_status, "unconfigured");
  });

  await t.test("P04: Sandbox vs Live secret mismatch & config JSON plaintext injection rejected", async () => {
    await admin.fetch("/staff/admin/integrations/stripe/secrets", {
      environment: "live",
      secret_name: "secret_key",
      secret_value: "sk_test_wrong_env_key_1234",
    }, "POST", 400);

    await admin.fetch("/staff/admin/integrations/stripe/secrets", {
      environment: "sandbox",
      secret_name: "secret_key",
      secret_value: "sk_live_wrong_env_key_1234",
    }, "POST", 400);

    await admin.fetch("/staff/admin/integrations/stripe", {
      config: { secret_key: "sk_test_leak_attempt" },
    }, "POST", 400);
  });

  await t.test("P05: Stripe Live activation blocked until Live secret, webhook & verification flags exist", async () => {
    await admin.fetch("/staff/admin/integrations/stripe", {
      environment: "live",
      lifecycle_state: "enabled",
      enabled: true,
    }, "POST", 409);
  });

  await t.test("P06: Disabling Stripe blocks checkout; PayPal manual stays disabled by default until admin enables it", async () => {
    const ord = await createSubmittedOpenOrder(customer, "P06");
    await admin.fetch("/staff/admin/integrations/stripe", {
      lifecycle_state: "disabled",
      enabled: false,
    });
    await customer.fetch(`/charges/${ord.chargeId}/checkout`, { quote_revision: ord.quoteRevision }, "POST", 409);

    const channelsDefault = await customer.fetch("/me/payment-channels");
    assert.equal(channelsDefault.channels.find((c: any) => c.provider_key === "stripe").available, false);
    assert.equal(channelsDefault.channels.find((c: any) => c.provider_key === "paypal_manual").available, false);
    await customer.fetch(`/charges/${ord.chargeId}/paypal-invoice`, {}, "POST", 409);

    await admin.fetch("/staff/admin/integrations/paypal_manual", {
      lifecycle_state: "enabled",
      enabled: true,
    });
    const channelsOptIn = await customer.fetch("/me/payment-channels");
    assert.equal(channelsOptIn.channels.find((c: any) => c.provider_key === "paypal_manual").available, true);

    await admin.fetch("/staff/admin/integrations/paypal_manual", {
      lifecycle_state: "disabled",
      enabled: false,
    });
    await admin.fetch("/staff/admin/integrations/stripe", {
      lifecycle_state: "enabled",
      enabled: true,
    });
  });

  await t.test("P07: PayPal Auto (Orders v2) stays blocked under personal mainland account", async () => {
    await admin.fetch("/staff/admin/integrations/paypal_auto", {
      lifecycle_state: "enabled",
      enabled: true,
    }, "POST", 409);
    await assert.rejects(() => transaction((db) => paypalAutoAdapter.assertEligible(db, "sandbox")), { code: "PAYPAL_BUSINESS_UPGRADE_REQUIRED" });
  });

  await t.test("P08: Creem and Dodo Payments blocked by AUP for physical inspection services", async () => {
    for (const key of ["creem", "dodo_payments"]) {
      await admin.fetch(`/staff/admin/integrations/${key}`, { lifecycle_state: "enabled", enabled: true }, "POST", 409);
      const res = await admin.fetch(`/staff/admin/integrations/${key}/test`, { environment: "sandbox" });
      assert.equal(res.ok, false);
      assert.equal(res.health_status, "blocked");
      assert.equal(res.not_simulated, true);
    }
  });

  await t.test("P09: Airwallex and Oceanpayment blocked without corporate entity verification", async () => {
    for (const key of ["airwallex", "oceanpayment"]) {
      await admin.fetch(`/staff/admin/integrations/${key}`, { lifecycle_state: "enabled", enabled: true }, "POST", 409);
    }
  });

  await t.test("P10: Strict SSRF URL protection blocks trailing dot, IPv6 embedded IPv4, non-strings & allows fcm host", async () => {
    for (const bad of [
      "http://example.com/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest",
      "https://localhost:3000/api",
      "https://localhost./api",
      "https://metadata.google.internal./",
      "https://[::127.0.0.1]/hook",
      "https://[fe81::1]/hook",
      "https://vault.internal/cb",
    ]) {
      assert.throws(() => assertSafeExternalUrl(bad));
      await admin.fetch("/staff/admin/integrations/outbound_webhooks", {
        config: { target_url: bad },
      }, "POST", 400);
    }
    await admin.fetch("/staff/admin/integrations/outbound_webhooks", {
      config: { target_url: ["https://127.0.0.1/bypass"] },
    }, "POST", 400);
    assert.ok(assertSafeExternalUrl("https://fcm.googleapis.com/fcm/send"));
    const ok = await admin.fetch("/staff/admin/integrations/outbound_webhooks", {
      config: { target_url: "https://webhooks.partner.example/qcw" },
    });
    assert.equal(ok.config.target_url, "https://webhooks.partner.example/qcw");
  });

  await t.test("P11: Config validation is distinct from real connection testing, and unauthorized roles receive 403", async () => {
    await customer.fetch("/staff/admin/integrations", undefined, "GET", 403);
    await inspector.fetch("/staff/admin/integrations", undefined, "GET", 403);
    await finance.fetch("/staff/admin/integrations/stripe", { enabled: false }, "POST", 403);

    const v = await admin.fetch("/staff/admin/integrations/google_vision_ocr/validate", { environment: "live" });
    assert.equal(v.mode, "config_validation");
    assert.equal(v.ok, false);
    assert.ok(v.missing_fields.length >= 1);
  });

  await t.test("P12: Customer GET /me/payment-channels returns accurate live availability flags (PayPal manual disabled by default)", async () => {
    const ch = await customer.fetch("/me/payment-channels");
    const stripeCh = ch.channels.find((c: any) => c.provider_key === "stripe");
    const ppManualCh = ch.channels.find((c: any) => c.provider_key === "paypal_manual");
    const ppAutoCh = ch.channels.find((c: any) => c.provider_key === "paypal_auto");
    assert.equal(stripeCh.available, true);
    assert.equal(ppManualCh.available, false);
    assert.equal(ppAutoCh.available, false);
    assert.equal(ch.channels.some((c: any) => c.provider_key === "creem"), false);
  });

  const ordPayPal = await createSubmittedOpenOrder(customer, "P13");
  let ppPaymentId = "";

  await t.test("P13: When opt-in enabled, customer requests PayPal Manual Invoice idempotently without auto-activating order", async () => {
    await admin.fetch("/staff/admin/integrations/paypal_manual", {
      lifecycle_state: "enabled",
      enabled: true,
    });
    const k = randomUUID();
    const first = await customer.fetch(`/charges/${ordPayPal.chargeId}/paypal-invoice`, { payer_email: "buyer@example.com" }, "POST", 200, k);
    const second = await customer.fetch(`/charges/${ordPayPal.chargeId}/paypal-invoice`, { payer_email: "buyer@example.com" }, "POST", 200, k);
    assert.equal(first.payment_id, second.payment_id);
    assert.equal(first.provider, "paypal_manual");
    assert.equal(first.manual_state, "requested");
    ppPaymentId = first.payment_id;

    const ordState = await customer.fetch(`/orders/${ordPayPal.orderId}`);
    assert.equal(ordState.state, "awaiting_payment");
  });

  await t.test("P14: Customer reporting paid records claim only and NEVER activates order", async () => {
    const proofPng = await render1688OrderPng(["PayPal Payment Receipt $58.00", "TX: 9PP000111222"]);
    const mediaId = await customer.uploadAttachment(proofPng, "image/png", "pp_receipt.png");
    const rep = await customer.fetch(`/me/payments/${ppPaymentId}/report-paypal-paid`, {
      transaction_ref: "9PP000111222",
      evidence_media_id: mediaId,
      note: "Paid from personal PayPal",
    });
    assert.equal(rep.reported, true);
    // Finance must be able to read customer-uploaded PayPal receipt attachment (P2-1 fix)
    const mediaUrlRes = await finance.fetch(`/media/${mediaId}/url`);
    assert.ok(mediaUrlRes.url);
    const ordState = await customer.fetch(`/orders/${ordPayPal.orderId}`);
    assert.equal(ordState.state, "awaiting_payment");
  });

  await t.test("P15: Finance issues INV2 invoice, reads queue safely, records receipt & blocks case-insensitive duplicate TX", async () => {
    const queue = await finance.fetch("/staff/finance/paypal-invoices");
    assert.ok(Array.isArray(queue.rows) && queue.rows.length >= 1, "PayPal queue endpoint must return HTTP 200 (P0-2 fix)");

    const issued = await finance.fetch(`/staff/finance/paypal-invoices/${ppPaymentId}/issue`, {
      external_invoice_no: "INV2-2026-R5-01",
      invoice_url: "https://www.paypal.com/invoice/p/#INV22026R501",
    });
    assert.equal(issued.manual_state, "invoice_sent");

    const ord2 = await createSubmittedOpenOrder(customer, "P15DUP");
    const pp2 = await customer.fetch(`/charges/${ord2.chargeId}/paypal-invoice`, {});

    const rec = await finance.fetch(`/staff/finance/paypal-invoices/${ppPaymentId}/record-receipt`, {
      external_transaction_id: "9pp000111222",
      received_amount_cents: 5800,
      fee_amount_cents: 290,
    });
    assert.equal(rec.manual_state, "receipt_recorded");
    assert.equal(rec.external_transaction_id, "9PP000111222");
    assert.equal(rec.net_amount_cents, 5510);

    // Case-insensitive duplicate external TX ID rejected on second invoice (P2-5)
    await finance.fetch(`/staff/finance/paypal-invoices/${pp2.payment_id}/record-receipt`, {
      external_transaction_id: "9PP000111222",
      received_amount_cents: 5800,
    }, "POST", 409);

    // Requesting Stripe checkout on ord2 must create a separate 'stripe' attempt and NOT mutate pp2 (P1-1 fix)
    const stAttempt = await customer.fetch(`/charges/${ord2.chargeId}/checkout`, { quote_revision: ord2.quoteRevision });
    assert.notEqual(stAttempt.attempt_id, pp2.payment_id);

    await finance.fetch(`/staff/finance/paypal-invoices/${pp2.payment_id}/cancel`, { reason: "Cleanup dup test" });
  });

  await t.test("P16: Underpayment is tagged & blocked from activation; overpayment requires explicit confirm", async () => {
    const ordUnder = await createSubmittedOpenOrder(customer, "P16");
    const ppUnder = await customer.fetch(`/charges/${ordUnder.chargeId}/paypal-invoice`, {});

    const uRec = await finance.fetch(`/staff/finance/paypal-invoices/${ppUnder.payment_id}/record-receipt`, {
      external_transaction_id: "9UNDERPAY001",
      received_amount_cents: 5000,
    });
    assert.equal(uRec.manual_state, "underpaid");

    await admin.fetch(`/staff/finance/paypal-invoices/${ppUnder.payment_id}/verify`, { decision: "approve" }, "POST", 409);

    const oRec = await finance.fetch(`/staff/finance/paypal-invoices/${ppUnder.payment_id}/record-receipt`, {
      external_transaction_id: "9OVERPAY001",
      received_amount_cents: 6000,
    });
    assert.equal(oRec.manual_state, "overpaid");
    await admin.fetch(`/staff/finance/paypal-invoices/${ppUnder.payment_id}/verify`, { decision: "approve" }, "POST", 409);
    const verifiedOver = await admin.fetch(`/staff/finance/paypal-invoices/${ppUnder.payment_id}/verify`, {
      decision: "approve",
      accept_overpayment: true,
    });
    assert.equal(verifiedOver.state, "succeeded");
  });

  await t.test("P17: Separation of Duties blocks self-verification; independent super_admin verify activates order via applyPayment", async () => {
    await finance.fetch(`/staff/finance/paypal-invoices/${ppPaymentId}/verify`, { decision: "approve" }, "POST", 403);

    const verified = await admin.fetch(`/staff/finance/paypal-invoices/${ppPaymentId}/verify`, {
      decision: "approve",
      note: "Independent SoD verification passed",
    });
    assert.equal(verified.state, "succeeded");
    assert.equal(verified.manual_state, "verified");

    const ordState = await customer.fetch(`/orders/${ordPayPal.orderId}`);
    assert.equal(ordState.state, "awaiting_samples");

    const payDetail = await admin.fetch(`/staff/admin/payments/${ppPaymentId}`);
    assert.equal(payDetail.charge.applied_payment_id, ppPaymentId);
    assert.equal(payDetail.charge.is_applied_payment, true);
    const dbPay = (await pool.query<{ recorded_by: string; verified_by: string }>("select recorded_by, verified_by from payments where id=$1", [ppPaymentId])).rows[0];
    assert.ok(dbPay.recorded_by && dbPay.verified_by && dbPay.recorded_by !== dbPay.verified_by);
  });

  await t.test("P18: Reject resets recorder for re-entry; cancel marks canceled and blocks verify", async () => {
    const ordRej = await createSubmittedOpenOrder(customer, "P18");
    const ppRej = await customer.fetch(`/charges/${ordRej.chargeId}/paypal-invoice`, {});

    await finance.fetch(`/staff/finance/paypal-invoices/${ppRej.payment_id}/record-receipt`, {
      external_transaction_id: "9REJECT001",
      received_amount_cents: 5800,
    });
    const rej = await admin.fetch(`/staff/finance/paypal-invoices/${ppRej.payment_id}/verify`, {
      decision: "reject",
      note: "Mismatch payer",
    });
    assert.equal(rej.manual_state, "rejected");

    const canceled = await finance.fetch(`/staff/finance/paypal-invoices/${ppRej.payment_id}/cancel`, {
      reason: "Customer abandoned",
    });
    assert.equal(canceled.manual_state, "canceled");
    await admin.fetch(`/staff/finance/paypal-invoices/${ppRej.payment_id}/verify`, { decision: "approve" }, "POST", 409);
  });

  await t.test("P19: PayPal manual refund skips Stripe worker call cleanly and completes via manual finance execute", async () => {
    const supportOrAdmin = admin;
    const reqRef = await finance.fetch(`/staff/orders/${ordPayPal.orderId}/refunds`, {
      payment_id: ppPaymentId,
      amount_cents: 5800,
      reason: "Unauthorized finance request",
    }, "POST", 403);
    assert.equal(reqRef.error.code, "FORBIDDEN");

    const rfReq = await supportOrAdmin.fetch(`/staff/orders/${ordPayPal.orderId}/refunds`, {
      payment_id: ppPaymentId,
      amount_cents: 5800,
      reason: "Order cancelled pre-inspection",
    }, "POST", 201);

    // Approve using distinct super_admin -> wait: create second super_admin or use support requester vs admin approver!
    // Create a temporary support user in DB or check existing reviewer? Actually let's promote finance temporarily? No, use clean SQL helper for 2nd super_admin so SoD is real!
    const approverId = randomUUID();
    const approverEmail = "approver-r5@qcw.test";
    await transaction(async (db) => {
      await db.query("insert into users(id, display_name, locale) values($1, 'R5 Approver', 'zh-CN')", [approverId]);
      const em = (
        await db.query<{ id: string }>(
          `insert into user_emails(user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
           values($1, $2::text, ($2::text)::citext, now(), true, true) returning id`,
          [approverId, approverEmail],
        )
      ).rows[0];
      await addEmailOtpIdentity(db, approverId, em.id);
      await db.query("insert into staff_roles(user_id, role) values($1, 'super_admin'), ($1, 'finance')", [approverId]);
    });
    const approver = await loginAs(approverEmail);

    const rfRow = (await pool.query<{ revision: number }>("select revision from refunds where id=$1", [rfReq.refund_id])).rows[0];
    await approver.fetch(`/staff/admin/refunds/${rfReq.refund_id}/approve`, { revision: rfRow.revision, reason: "Approved manual refund" }, "POST", 202);

    // Worker processes refund.approved WITHOUT throwing Stripe payment_intent error
    while (await workOnce()) { /* drain outbox */ }
    const midState = (await pool.query<{ state: string; provider_ref: string | null }>("select state, provider_ref from refunds where id=$1", [rfReq.refund_id])).rows[0];
    assert.equal(midState.state, "approved");
    assert.equal(midState.provider_ref, null);

    // Finance executes manual PayPal refund
    const execRes = await finance.fetch(`/staff/finance/refunds/${rfReq.refund_id}/execute-manual`, {
      manual_refund_ref: "RF-PP-MANUAL-777",
      notes: "Refunded via PayPal activity console",
    });
    assert.equal(execRes.state, "succeeded");
    assert.equal(execRes.payment_state, "refunded");

    // Restore paypal_manual default disabled state
    await admin.fetch("/staff/admin/integrations/paypal_manual", {
      lifecycle_state: "disabled",
      enabled: false,
    });
  });

  await t.test("P20: Stripe active reconcile gracefully reports unconfigured without faking success", async () => {
    const rec = await finance.fetch("/staff/finance/stripe/reconcile", {});
    assert.equal(rec.ok, false);
    assert.equal(rec.configured, false);
  });
});

test("Round 5 Self-Hosted PaddleOCR, PDF Evidence & Multi-Tenant Worker (20 Scenarios)", async (t) => {
  const admin = await loginAs("admin@qcw.test");
  const customer = await loginAs("customer@qcw.test");
  const otherCustomer = await createIsolatedCustomer("other-r5@qcw.test");

  const sample1688Png = await render1688OrderPng([
    "1688 Wholesale Order No: 2026112188887777",
    "Store: Shenzhen Apparel Factory",
    "Tracking: SF1456789012345",
    "1. Heavy Fleece Hoodie Black L SKU:HD-440-BLK Qty: 2 $29.00",
    "2. Yoga TankTop White M SKU:YT-201-WHT Qty: 3 $15.00",
  ]);
  const sampleNativePdf = await buildNativePdf([
    "1688 Packing List Order No: 2026112199990001",
    "Supplier: Guangzhou Knitwear Co",
    "Tracking: ZT7588812345678",
    "Heavyweight Tee Black XL SKU:TEE-101-BLK Qty: 4 $12.50",
  ]);
  const sampleScannedPdf = await buildScannedPdfFromPng(sample1688Png);

  await t.test("O01: PaddleOCR --health real probe passes without network/ICP", async () => {
    const res = await admin.fetch("/staff/admin/integrations/paddle_ocr/test", { environment: "live" });
    assert.equal(res.ok, true);
    assert.equal(res.health_status, "healthy");
    assert.equal(res.not_simulated, true);
  });

  await t.test("O02: Admin real test-extract on Chinese+English 1688 PNG screenshot", async () => {
    const fd = new FormData();
    fd.set("file", new Blob([new Uint8Array(sample1688Png)], { type: "image/png" }), "1688_order.png");
    const res = await admin.fetch("/staff/admin/ocr/test-extract", fd);
    assert.equal(res.ok, true);
    assert.equal(res.provider_key, "paddle_ocr");
    assert.ok(res.candidates.length >= 2, `Expected >=2 candidates, got ${JSON.stringify(res.candidates)}`);
    assert.ok(res.raw_text.includes("SF1456789012345"));
    assert.ok(res.confidence >= 0.7);
  });

  await t.test("O03: Signed-URL upload supports valid application/pdf for attachment", async () => {
    const sha = createHash("sha256").update(sampleNativePdf).digest("hex");
    const ticket = await customer.fetch("/media/upload-url", {
      kind: "attachment",
      mime: "application/pdf",
      size_bytes: sampleNativePdf.length,
      sha256: sha,
    }, "POST", 201);
    const putUrl = new URL(ticket.upload_url);
    const putRes = await customer.fetch(putUrl.pathname.replace("/api/v1", "") + putUrl.search, sampleNativePdf, "PUT", 200);
    assert.equal(putRes.staged_bytes, sampleNativePdf.length);
    const completed = await customer.fetch(`/media/${ticket.media_id}/complete`, {});
    assert.equal(completed.mime, "application/pdf");
    assert.equal(completed.status, "ready");
  });

  await t.test("O04: Scanned image PDF upload via /me/media + real pypdfium2 + PP-OCRv4 extraction", async () => {
    const mediaId = await customer.uploadAttachment(sampleScannedPdf, "application/pdf", "scanned.pdf");
    const jobRes = await customer.fetch("/me/ocr/jobs", { media_id: mediaId, execute_now: true }, "POST", 201);
    assert.equal(jobRes.job.state === "completed" || jobRes.job.state === "needs_review", true);
    assert.ok(jobRes.candidates.length >= 2);
  });

  await t.test("O05: PDF rejected for intake_outer, encrypted PDF, corrupt PDF & >10 page PDF", async () => {
    const sha = createHash("sha256").update(sampleNativePdf).digest("hex");
    await customer.fetch("/media/upload-url", {
      kind: "intake_outer",
      mime: "application/pdf",
      size_bytes: sampleNativePdf.length,
      sha256: sha,
    }, "POST", 422);

    const encFd = new FormData();
    encFd.set("file", new Blob(["%PDF-1.4\n/Encrypt\n%%EOF"], { type: "application/pdf" }), "enc.pdf");
    await customer.fetch("/me/media", encFd, "POST", 422);

    const badFd = new FormData();
    badFd.set("file", new Blob(["NOT_A_PDF_HEADER_AT_ALL"], { type: "application/pdf" }), "bad.pdf");
    await customer.fetch("/me/media", badFd, "POST", 422);

    const bigPdf = await buildNativePdf(["Item A SKU:AAA-1 Qty: 1"], 12);
    const bigMediaId = await customer.uploadAttachment(bigPdf, "application/pdf", "12pages.pdf");
    const bigJob = await customer.fetch("/me/ocr/jobs", { media_id: bigMediaId, execute_now: true }, "POST", 201);
    assert.equal(bigJob.job.state, "failed");
    assert.equal(bigJob.job.error_code, "PDF_PAGE_LIMIT");
  });

  await t.test("O06: Stage 2 parser handles multi-platform detection, glued tokens & low-confidence warnings", async () => {
    const parsed = parseOcrDocument(
      "淘宝订单 202611210001\n1.HeavyFleece HoodieCharcoal LSKU:HD-440-GRYQty:2￥128.00",
      [{ page: 1, text: "1.HeavyFleece HoodieCharcoal LSKU:HD-440-GRYQty:2￥128.00", confidence: 0.65, bbox: [0.05, 0.2, 0.9, 0.3] }],
      0.65,
    );
    assert.equal(parsed.platform, "Taobao");
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.candidates[0].sku_code, "HD-440-GRY");
    assert.equal(parsed.candidates[0].size, "L");
    assert.equal(parsed.candidates[0].quantity, 2);
    assert.equal(parsed.needs_review, true);
    assert.ok(parsed.warnings.length >= 1);
  });

  const sharedPngId = await customer.uploadAttachment(sample1688Png, "image/png", "1688_customer.png");
  let jobId = "";
  let candIds: string[] = [];

  await t.test("O07: Customer enqueues PNG OCR extraction & receives structured editable candidates", async () => {
    const jobRes = await customer.fetch("/me/ocr/jobs", { media_id: sharedPngId, execute_now: true }, "POST", 201);
    assert.equal(jobRes.job.state, "completed");
    assert.ok(jobRes.candidates.length >= 2);
    jobId = jobRes.job.id;
    candIds = jobRes.candidates.map((c: any) => c.id);
  });

  await t.test("O08: Multi-tenant isolation blocks other customers from reading/editing/confirming OCR jobs & media", async () => {
    await otherCustomer.fetch("/me/ocr/jobs", { media_id: sharedPngId, execute_now: true }, "POST", 403);
    await otherCustomer.fetch(`/me/ocr/jobs/${jobId}`, undefined, "GET", 403);
    await otherCustomer.fetch(`/me/ocr/candidates/${candIds[0]}`, { item_name: "Hack" }, "POST", 403);
    await otherCustomer.fetch(`/me/ocr/jobs/${jobId}/confirm`, { candidate_ids: [candIds[0]] }, "POST", 403);
  });

  await t.test("O09: Candidate field editing and validation guards", async () => {
    const updated = await customer.fetch(`/me/ocr/candidates/${candIds[0]}`, {
      item_name: "Edited Fleece Hoodie",
      color: "Charcoal",
      size: "XL",
      quantity: 5,
    });
    assert.equal(updated.candidate.item_name, "Edited Fleece Hoodie");
    assert.equal(updated.candidate.quantity, 5);
    await customer.fetch(`/me/ocr/candidates/${candIds[0]}`, { quantity: 0 }, "POST", 422);
  });

  await t.test("O10: Split candidate splits 5 units into [2, 3] rows cleanly", async () => {
    const splitRes = await customer.fetch(`/me/ocr/candidates/${candIds[0]}/split`, { quantities: [2, 3] });
    assert.equal(splitRes.created_candidate_ids.length, 2);
    const active = splitRes.candidates.filter((c: any) => c.status === "pending");
    assert.ok(active.length >= 3);
    candIds = active.map((c: any) => c.id);
  });

  await t.test("O11: Merge candidates combines 2 split rows back into summed quantity", async () => {
    const mergeRes = await customer.fetch(`/me/ocr/jobs/${jobId}/merge`, {
      candidate_ids: [candIds[0], candIds[1]],
    });
    assert.equal(mergeRes.merged_candidate.quantity, 5);
  });

  await t.test("O12: Rejecting candidate blocks confirm; explicit confirm marks confirmed without auto-creating orders", async () => {
    const preOrders = (await pool.query<{ n: number }>("select count(*)::int n from orders")).rows[0].n;
    const job = await customer.fetch(`/me/ocr/jobs/${jobId}`);
    const pending = job.candidates.filter((c: any) => c.status === "pending");
    await customer.fetch(`/me/ocr/candidates/${pending[1].id}`, { status: "rejected" });
    await customer.fetch(`/me/ocr/jobs/${jobId}/confirm`, { candidate_ids: [pending[1].id] }, "POST", 409);

    const conf = await customer.fetch(`/me/ocr/jobs/${jobId}/confirm`, { candidate_ids: [pending[0].id] });
    assert.equal(conf.confirmed_candidates[0].status, "confirmed");
    // Retrying a job with confirmed candidates is blocked (P1-4 fix)
    await customer.fetch(`/me/ocr/jobs/${jobId}/retry`, {}, "POST", 409);
    const postOrders = (await pool.query<{ n: number }>("select count(*)::int n from orders")).rows[0].n;
    assert.equal(postOrders, preOrders, "OCR must never auto-create orders without explicit submission");
  });

  await t.test("O13: SHA-256 deduplication reuses completed OCR output without re-running Python", async () => {
    const dupMediaId = await customer.uploadAttachment(sample1688Png, "image/png", "1688_duplicate.png");
    const dupJob = await customer.fetch("/me/ocr/jobs", { media_id: dupMediaId, execute_now: true }, "POST", 201);
    assert.equal(dupJob.deduplicated, true);
    assert.ok(dupJob.candidates.length >= 2);
  });

  await t.test("O14: Org daily OCR quota limit enforced cleanly (429 OCR_QUOTA_EXCEEDED)", async () => {
    await admin.fetch("/staff/admin/integrations/paddle_ocr", { config: { daily_quota_per_org: 2 } });
    const uniquePng = await render1688OrderPng(["Quota Test Hoodie Blue S Qty: 1 SKU:QT-1", randomUUID()]);
    const mId = await customer.uploadAttachment(uniquePng, "image/png", "quota.png");
    await customer.fetch("/me/ocr/jobs", { media_id: mId, execute_now: true }, "POST", 429);
    await admin.fetch("/staff/admin/integrations/paddle_ocr", { config: { daily_quota_per_org: 50 } });
  });

  await t.test("O15: Unconfigured Google Vision fails truthfully without mocking AND explicit test-extract never falls back to PaddleOCR", async () => {
    const res = await admin.fetch("/staff/admin/integrations/google_vision_ocr/test", { environment: "live" });
    assert.equal(res.ok, false);
    assert.equal(res.health_status, "unconfigured");

    const fd = new FormData();
    fd.set("file", new Blob([new Uint8Array(sample1688Png)], { type: "image/png" }), "vision_explicit.png");
    fd.set("provider_key", "google_vision_ocr");
    const singleEngine = await admin.fetch("/staff/admin/ocr/test-extract", fd);
    assert.equal(singleEngine.ok, false);
    assert.equal(singleEngine.error_code, "OCR_UNCONFIGURED");
  });

  await t.test("O16: Async outbox worker processes queued ocr.extract job cleanly", async () => {
    const uniquePng = await render1688OrderPng(["Weidian Track Pants Navy M Qty: 2 $19.00", "Tracking: YT7588991122334"]);
    const mId = await customer.uploadAttachment(uniquePng, "image/png", "async_ocr.png");
    const queued = await customer.fetch("/me/ocr/jobs", { media_id: mId, execute_now: false }, "POST", 201);
    assert.equal(queued.job.state, "queued");

    while (await workOnce()) { /* drain outbox */ }
    const afterWork = await customer.fetch(`/me/ocr/jobs/${queued.job.id}`);
    assert.equal(afterWork.job.state === "completed" || afterWork.job.state === "needs_review", true);
    assert.ok(afterWork.candidates.length >= 1);
  });

  await t.test("O17: Native PDF upload triggers PDF native-text extraction seamlessly", async () => {
    const pdfId = await customer.uploadAttachment(sampleNativePdf, "application/pdf", "packing_list.pdf");
    const pdfJob = await customer.fetch("/me/ocr/jobs", { media_id: pdfId, execute_now: true }, "POST", 201);
    assert.equal(pdfJob.job.state === "completed" || pdfJob.job.state === "needs_review", true);
    assert.ok(String(pdfJob.job.raw_text).includes("TEE-101-BLK"));
  });

  await t.test("O18: Admin OCR job list endpoint requires staff privileges and returns job metrics", async () => {
    await customer.fetch("/staff/admin/ocr/jobs", undefined, "GET", 403);
    const list = await admin.fetch("/staff/admin/ocr/jobs");
    assert.ok(list.jobs.length >= 5);
    assert.ok("candidate_count" in list.jobs[0]);
  });

  await t.test("O19: Worker retention cleanup deletes expired test jobs and redacts expired customer raw text", async () => {
    await pool.query("update ocr_jobs set expires_at = now() - interval '1 hour'");
    await trackingTick();
    const expiredTest = (await pool.query("select count(*)::int n from ocr_jobs where is_test=true and expires_at < now()")).rows[0];
    assert.equal(expiredTest.n, 0);
    const unredactedCust = (await pool.query("select count(*)::int n from ocr_jobs where is_test=false and expires_at < now() and raw_text is not null")).rows[0];
    assert.equal(unredactedCust.n, 0);
  });

  await t.test("O20: Google Vision API key vault storage -> validate readiness -> revoke lifecycle", async () => {
    const saved = await admin.fetch("/staff/admin/integrations/google_vision_ocr/secrets", {
      environment: "live",
      secret_name: "api_key",
      secret_value: "AIzaSyFakeFormatOnlyCheckForVaultTest999",
    });
    assert.equal(saved.masked_hint, "AIza****t999");

    const v = await admin.fetch("/staff/admin/integrations/google_vision_ocr/validate", { environment: "live" });
    assert.equal(v.ok, true);
    assert.equal(v.ready_for_connection_test, true);

    await admin.fetch("/staff/admin/integrations/google_vision_ocr/secrets/revoke", {
      environment: "live",
      secret_name: "api_key",
    });
  });
});
