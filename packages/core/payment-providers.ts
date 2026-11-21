import Stripe from "stripe";
import { audit, event, guard, idempotent, lock, one, organization, role, uuid, type Actor, isDemo } from "./common";
import { requireCustomerActive, requireStaffMfa } from "./auth";
import { stripeSettingsFromDb } from "./integrations";
import {
  assertSafeExternalUrl,
  ensureIntegrationProvidersSeeded,
  recordIntegrationEvent,
  resolveProviderSecret,
  type EnvMode,
  type ProviderRow,
} from "./integrations-admin";
import { applyPayment, syncPaymentRefundState } from "./payments";
import type { DB } from "../db";

export interface CustomerPaymentChannelDTO {
  provider_key: string;
  label: string;
  channel_type: "auto_checkout" | "manual_invoice";
  environment: EnvMode;
  available: boolean;
  recommended: boolean;
  badge: string;
  unavailable_reason: string | null;
  instructions: string | null;
}

export async function listCustomerPaymentChannels(db: DB): Promise<CustomerPaymentChannelDTO[]> {
  await ensureIntegrationProvidersSeeded(db);
  const providers = (
    await db.query<ProviderRow>(
      `select id, provider_key, domain, display_name, lifecycle_state, environment, enabled, priority,
              is_primary, is_fallback, requires_icp, compliance_status, config, health_status,
              last_checked_at, last_check_summary, last_error, updated_at
       from integration_providers
       where domain = 'payment'
       order by priority, provider_key`,
    )
  ).rows;

  const stripeCfg = await stripeSettingsFromDb(db);
  const out: CustomerPaymentChannelDTO[] = [];

  for (const p of providers) {
    if (p.provider_key === "stripe") {
      const liveBlocked = p.environment === "live" && !stripeCfg.liveEnabled && !isDemo();
      const sandboxHasKey = Boolean(stripeCfg.key) || isDemo();
      const available = p.enabled && !liveBlocked && (p.environment === "live" ? stripeCfg.liveEnabled : sandboxHasKey);
      out.push({
        provider_key: "stripe",
        label: "Card / Apple Pay / Google Pay (Stripe)",
        channel_type: "auto_checkout",
        environment: p.environment,
        available,
        recommended: p.is_primary,
        badge: p.environment === "live" ? (available ? "Instant Checkout" : "Live Verification Pending") : "Sandbox / Instant",
        unavailable_reason: !p.enabled
          ? "Temporarily disabled by platform finance."
          : liveBlocked
            ? "HK Stripe KYC verified & ZA Bank linked; awaiting final Live Checkout & Webhook smoke check."
            : !sandboxHasKey
              ? "Stripe credentials not configured."
              : null,
        instructions: null,
      });
      continue;
    }

    if (p.provider_key === "paypal_manual") {
      out.push({
        provider_key: "paypal_manual",
        label: "PayPal Invoice (Manual Finance Verification)",
        channel_type: "manual_invoice",
        environment: p.environment,
        available: p.enabled && p.lifecycle_state !== "disabled",
        recommended: false,
        badge: "Manual Invoice · Verified by Finance",
        unavailable_reason: p.enabled ? null : "Temporarily disabled by platform finance.",
        instructions: String(
          p.config?.instructions_en ??
            "Request a PayPal Invoice; our finance team issues an INV2 invoice to your PayPal email and activates your order after independent two-person payment verification.",
        ),
      });
      continue;
    }

    if (p.provider_key === "paypal_auto") {
      const bizOk = p.config?.business_account_verified === true;
      const clientId = await resolveProviderSecret(db, "paypal_auto", p.environment, "client_id");
      const clientSecret = await resolveProviderSecret(db, "paypal_auto", p.environment, "client_secret");
      const available = p.enabled && bizOk && Boolean(clientId && clientSecret);
      out.push({
        provider_key: "paypal_auto",
        label: "PayPal Orders v2 (Instant Checkout)",
        channel_type: "auto_checkout",
        environment: p.environment,
        available,
        recommended: false,
        badge: available ? "Instant PayPal" : "Business Upgrade Required",
        unavailable_reason: available
          ? null
          : String(p.config?.block_reason ?? "PayPal Auto Checkout is reserved until upgraded to a Business account."),
        instructions: null,
      });
    }
  }

  return out;
}

export async function assertStripeCheckoutAllowed(db: DB) {
  await ensureIntegrationProvidersSeeded(db);
  const s = await stripeSettingsFromDb(db);
  guard(s.enabled, "CHANNEL_DISABLED", "Stripe Checkout is currently disabled by administrator.", 409);
  if (s.environment === "live" && !isDemo()) {
    guard(
      s.liveEnabled,
      "STRIPE_LIVE_NOT_VERIFIED",
      "HK Stripe account KYC & ZA Bank are linked, but Live Checkout/Webhook verification must complete before taking live payments.",
      409,
    );
  }
  return s;
}

/**
 * Future PayPal Orders v2 Adapter (strictly gated off until PayPal Business upgrade + Live credentials).
 */
export const paypalAutoAdapter = {
  providerKey: "paypal_auto" as const,
  async assertEligible(db: DB, environment: EnvMode) {
    await ensureIntegrationProvidersSeeded(db);
    const p = await one<ProviderRow>(db, "select * from integration_providers where provider_key='paypal_auto'");
    guard(
      p.enabled && p.config?.business_account_verified === true,
      "PAYPAL_BUSINESS_UPGRADE_REQUIRED",
      "PayPal Auto Checkout (Orders v2) cannot be used with a personal mainland account; upgrade to a verified Business account first.",
      409,
    );
    const clientId = await resolveProviderSecret(db, "paypal_auto", environment, "client_id");
    const clientSecret = await resolveProviderSecret(db, "paypal_auto", environment, "client_secret");
    guard(Boolean(clientId && clientSecret), "PAYPAL_CREDENTIALS_MISSING", "PayPal Business client_id/client_secret missing.", 503);
    const apiBase = String(
      environment === "live" ? (p.config?.api_base_live ?? "https://api-m.paypal.com") : (p.config?.api_base_sandbox ?? "https://api-m.sandbox.paypal.com"),
    );
    assertSafeExternalUrl(apiBase, ["api-m.paypal.com", "api-m.sandbox.paypal.com"]);
    return { apiBase, clientId: clientId!, clientSecret: clientSecret! };
  },
  async createOrder(db: DB, amountCents: number, currency: string, referenceId: string, environment: EnvMode) {
    const { apiBase, clientId, clientSecret } = await this.assertEligible(db, environment);
    const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000),
    });
    guard(tokenRes.ok, "PAYPAL_AUTH_FAILED", `PayPal OAuth failed (${tokenRes.status}).`, 502);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const orderRes = await fetch(`${apiBase}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: referenceId,
            amount: { currency_code: currency.toUpperCase(), value: (amountCents / 100).toFixed(2) },
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    guard(orderRes.ok, "PAYPAL_ORDER_FAILED", `PayPal createOrder failed (${orderRes.status}).`, 502);
    return orderRes.json();
  },
};

export async function requestPaypalManualInvoice(
  db: DB,
  actor: Actor,
  chargeItemId: string,
  idempotencyKey: string,
  payerEmail?: string,
) {
  await requireCustomerActive(db, actor);
  const org = organization(actor);
  await ensureIntegrationProvidersSeeded(db);

  const provider = await one<ProviderRow>(db, "select * from integration_providers where provider_key='paypal_manual'");
  guard(provider.enabled && provider.lifecycle_state !== "disabled", "CHANNEL_DISABLED", "PayPal Manual Invoice is disabled.", 409);

  await lock(db, "charge_paypal:" + chargeItemId);

  const charge = await one<{
    id: string;
    org_id: string;
    purpose: string;
    amount_cents: number;
    currency: string;
    voided_at: string | null;
    applied_payment_id: string | null;
    inspection_quote_id: string | null;
    dispatch_quote_id: string | null;
    storage_quote_id: string | null;
    iq_expires_at: string | null;
    dq_expires_at: string | null;
    sq_expires_at: string | null;
    order_id: string | null;
    batch_id: string | null;
    disposition_id: string | null;
  }>(
    db,
    `select c.id, c.org_id, c.purpose, c.amount_cents, c.currency, c.voided_at, c.applied_payment_id,
            c.inspection_quote_id, c.dispatch_quote_id, c.storage_quote_id,
            iq.expires_at iq_expires_at, iq.order_id,
            dq.expires_at dq_expires_at, dq.batch_id,
            sq.expires_at sq_expires_at, sq.disposition_id
     from charge_items c
     left join inspection_quotes iq on iq.id = c.inspection_quote_id
     left join dispatch_quote_versions dq on dq.id = c.dispatch_quote_id
     left join storage_quotes sq on sq.id = c.storage_quote_id
     where c.id = $1
     for update of c`,
    [chargeItemId],
  );

  guard(charge.org_id === org, "FORBIDDEN", "This charge item belongs to another workspace.", 403);
  guard(charge.voided_at === null, "CHARGE_VOIDED", "This charge has been voided.", 409);
  guard(charge.applied_payment_id === null, "ALREADY_PAID", "This charge has already been settled.", 409);

  const expiresAt = charge.iq_expires_at ?? charge.dq_expires_at ?? charge.sq_expires_at;
  guard(!expiresAt || new Date(expiresAt).getTime() > Date.now(), "QUOTE_EXPIRED", "This quote has expired. Generate a fresh quote first.", 409);

  const existingStripeProcessing = (
    await db.query("select 1 from payments where charge_item_id=$1 and provider<>'paypal_manual' and state='processing' limit 1", [
      chargeItemId,
    ])
  ).rowCount;
  guard(!existingStripeProcessing, "PAYMENT_PROCESSING", "A Stripe payment attempt is already processing for this charge.", 409);

  await db.query(
    `update payments
     set state = 'canceled',
         manual_notes = coalesce(manual_notes || ' | ', '') || 'Superseded by PayPal manual invoice request',
         updated_at = now()
     where charge_item_id = $1 and provider <> 'paypal_manual' and state = 'requires_payment'`,
    [chargeItemId],
  );

  const existingOpen = (
    await db.query<{
      id: string;
      state: string;
      manual_state: string;
      external_invoice_no: string | null;
      invoice_url: string | null;
      payer_email: string | null;
      amount_cents: number;
      currency: string;
    }>(
      `select id, state, manual_state, external_invoice_no, invoice_url, payer_email, amount_cents, currency
       from payments
       where charge_item_id = $1 and provider = 'paypal_manual'
         and state not in ('canceled','failed')
       order by created_at desc
       limit 1`,
      [chargeItemId],
    )
  ).rows[0];

  if (existingOpen) {
    return {
      payment_id: existingOpen.id,
      charge_item_id: chargeItemId,
      provider: "paypal_manual",
      channel: "paypal_manual_invoice",
      state: existingOpen.state,
      manual_state: existingOpen.manual_state,
      external_invoice_no: existingOpen.external_invoice_no,
      invoice_url: existingOpen.invoice_url,
      payer_email: existingOpen.payer_email,
      amount_cents: existingOpen.amount_cents,
      currency: existingOpen.currency,
      reused: true,
    };
  }

  let resolvedEmail = payerEmail?.trim() || null;
  if (!resolvedEmail) {
    resolvedEmail =
      (
        await db.query<{ original_email: string }>(
          "select original_email from user_emails where user_id=$1 and is_primary limit 1",
          [actor.id],
        )
      ).rows[0]?.original_email ?? null;
  }

  const paymentId = uuid();
  await db.query(
    `insert into payments (
       id, charge_item_id, provider, channel, environment, amount_cents, expected_amount_cents,
       currency, state, manual_state, payer_email, idempotency_key, provider_data
     ) values ($1,$2,'paypal_manual','paypal_manual_invoice',$3,$4,$4,$5,'requires_payment','requested',$6,$7,$8::jsonb)`,
    [
      paymentId,
      chargeItemId,
      provider.environment,
      charge.amount_cents,
      charge.currency,
      resolvedEmail,
      "ppman:" + chargeItemId + ":" + idempotencyKey,
      JSON.stringify({
        customer_requested_at: new Date().toISOString(),
        customer_user_id: actor.id,
        purpose: charge.purpose,
        order_id: charge.order_id,
        batch_id: charge.batch_id,
      }),
    ],
  );

  await audit(db, actor, "paypal_manual_invoice_requested", "payments", paymentId, {
    charge_item_id: chargeItemId,
    amount_cents: charge.amount_cents,
    payer_email: resolvedEmail,
  });
  await recordIntegrationEvent(db, {
    provider_key: "paypal_manual",
    environment: provider.environment,
    event_kind: "payment_sync",
    status: "ok",
    summary: `Customer requested manual PayPal invoice for charge ${chargeItemId} ($${(charge.amount_cents / 100).toFixed(2)}).`,
    actor_id: actor.id,
  });

  return {
    payment_id: paymentId,
    charge_item_id: chargeItemId,
    provider: "paypal_manual",
    channel: "paypal_manual_invoice",
    state: "requires_payment",
    manual_state: "requested",
    external_invoice_no: null,
    invoice_url: null,
    payer_email: resolvedEmail,
    amount_cents: charge.amount_cents,
    currency: charge.currency,
    reused: false,
  };
}

export async function customerReportPaypalPaid(
  db: DB,
  actor: Actor,
  paymentId: string,
  input: {
    transaction_ref?: string;
    payer_email?: string;
    evidence_media_id?: string;
    note?: string;
  },
) {
  await requireCustomerActive(db, actor);
  const org = organization(actor);
  const p = await one<{
    id: string;
    org_id: string;
    provider: string;
    state: string;
    manual_state: string | null;
    payer_email: string | null;
    evidence_media_id: string | null;
    provider_data: Record<string, unknown>;
  }>(
    db,
    `select p.*, c.org_id
     from payments p join charge_items c on c.id=p.charge_item_id
     where p.id=$1 for update of p`,
    [paymentId],
  );
  guard(p.org_id === org, "FORBIDDEN", "This payment belongs to another workspace.", 403);
  guard(p.provider === "paypal_manual", "INVALID_PROVIDER", "Self-reported transfer applies only to PayPal Manual Invoice.", 400);
  guard(p.state !== "succeeded" && p.state !== "canceled", "PAYMENT_FINALIZED", "This payment can no longer be modified.", 409);

  if (input.evidence_media_id) {
    const asset = await one<{ org_id: string | null; kind: string; status: string }>(
      db,
      "select org_id, kind, status from media_assets where id=$1",
      [input.evidence_media_id],
    );
    guard(asset.org_id === org, "FORBIDDEN", "Evidence file does not belong to your workspace.", 403);
    guard(asset.kind === "attachment" && asset.status === "ready", "INVALID_EVIDENCE", "Evidence attachment is not ready.", 422);
  }

  const nextData = {
    ...(p.provider_data ?? {}),
    customer_reported_paid_at: new Date().toISOString(),
    customer_reported_tx_ref: input.transaction_ref?.trim() || null,
    customer_reported_note: input.note?.trim() || null,
    customer_evidence_media_id: input.evidence_media_id ?? null,
  };

  await db.query(
    `update payments
     set payer_email = coalesce($2, payer_email),
         evidence_media_id = coalesce(evidence_media_id, $3),
         provider_data = $4::jsonb,
         updated_at = now()
     where id = $1`,
    [paymentId, input.payer_email?.trim() || null, input.evidence_media_id ?? null, JSON.stringify(nextData)],
  );

  await audit(db, actor, "paypal_manual_customer_reported", "payments", paymentId, {
    transaction_ref: input.transaction_ref?.trim() || null,
    has_evidence: Boolean(input.evidence_media_id),
  });

  return { payment_id: paymentId, reported: true, manual_state: p.manual_state, state: p.state };
}

export async function issuePaypalManualInvoice(
  db: DB,
  actor: Actor,
  sessionHash: string,
  paymentId: string,
  input: {
    external_invoice_no: string;
    invoice_url?: string;
    payer_email?: string;
    notes?: string;
  },
) {
  role(actor, "finance", "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  if (input.invoice_url?.trim()) {
    assertSafeExternalUrl(input.invoice_url.trim(), ["paypal.com", "www.paypal.com", "sandbox.paypal.com"]);
  }

  const p = await one<{
    id: string;
    provider: string;
    state: string;
    manual_state: string | null;
    environment: EnvMode;
  }>(db, "select id, provider, state, manual_state, environment from payments where id=$1 for update", [paymentId]);
  guard(p.provider === "paypal_manual", "INVALID_PROVIDER", "Only paypal_manual payments support manual invoice issuance.", 400);
  guard(!["succeeded", "partially_refunded", "refunded", "canceled"].includes(p.state), "INVALID_PAYMENT_STATE", "Cannot issue invoice on settled or canceled payment.", 409);

  await db.query(
    `update payments
     set external_invoice_no = $2,
         invoice_url = coalesce($3, invoice_url),
         payer_email = coalesce($4, payer_email),
         issued_by = $5,
         issued_at = now(),
         manual_state = case when manual_state in ('receipt_recorded','underpaid','overpaid','verified') then manual_state else 'invoice_sent' end,
         manual_notes = coalesce($6, manual_notes),
         updated_at = now()
     where id = $1`,
    [
      paymentId,
      input.external_invoice_no.trim(),
      input.invoice_url?.trim() || null,
      input.payer_email?.trim() || null,
      actor.id,
      input.notes?.trim() || null,
    ],
  );

  await audit(db, actor, "paypal_manual_invoice_issued", "payments", paymentId, {
    external_invoice_no: input.external_invoice_no.trim(),
  });
  await recordIntegrationEvent(db, {
    provider_key: "paypal_manual",
    environment: p.environment,
    event_kind: "payment_sync",
    status: "ok",
    summary: `Issued PayPal Invoice ${input.external_invoice_no.trim()} for payment ${paymentId}.`,
    actor_id: actor.id,
  });

  return { payment_id: paymentId, external_invoice_no: input.external_invoice_no.trim(), manual_state: "invoice_sent" };
}

export async function recordPaypalManualReceipt(
  db: DB,
  actor: Actor,
  sessionHash: string,
  paymentId: string,
  input: {
    external_transaction_id: string;
    received_amount_cents: number;
    fee_amount_cents?: number;
    payer_email?: string;
    evidence_media_id?: string;
    notes?: string;
  },
) {
  role(actor, "finance", "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);

  const txId = input.external_transaction_id.trim().toUpperCase();
  guard(txId.length >= 4 && txId.length <= 128, "INVALID_TRANSACTION_ID", "Provide a valid PayPal Transaction ID.", 422);
  guard(Number.isInteger(input.received_amount_cents) && input.received_amount_cents > 0, "INVALID_AMOUNT", "Received amount must be positive.", 422);
  const feeCents = input.fee_amount_cents ?? 0;
  guard(Number.isInteger(feeCents) && feeCents >= 0 && feeCents <= input.received_amount_cents, "INVALID_FEE", "Fee must be non-negative and at most received amount.", 422);

  const p = await one<{
    id: string;
    provider: string;
    state: string;
    amount_cents: number;
    expected_amount_cents: number | null;
    environment: EnvMode;
  }>(db, "select id, provider, state, amount_cents, expected_amount_cents, environment from payments where id=$1 for update", [paymentId]);
  guard(p.provider === "paypal_manual", "INVALID_PROVIDER", "Receipt recording applies only to paypal_manual.", 400);
  guard(!["succeeded", "partially_refunded", "refunded", "canceled"].includes(p.state), "PAYMENT_ALREADY_FINAL", "Payment is already settled or canceled.", 409);

  const dup = (
    await db.query<{ id: string }>(
      "select id from payments where provider='paypal_manual' and external_transaction_id=$1 and id<>$2 limit 1",
      [txId, paymentId],
    )
  ).rows[0];
  guard(!dup, "DUPLICATE_EXTERNAL_TRANSACTION", `PayPal Transaction ID '${txId}' is already linked to another payment.`, 409);

  if (input.evidence_media_id) {
    const asset = await one<{ kind: string; status: string }>(db, "select kind, status from media_assets where id=$1", [input.evidence_media_id]);
    guard(asset.kind === "attachment" && asset.status === "ready", "INVALID_EVIDENCE", "Proof file must be a ready attachment.", 422);
  }

  const expected = p.expected_amount_cents ?? p.amount_cents;
  const netCents = input.received_amount_cents - feeCents;
  const manualState =
    input.received_amount_cents < expected
      ? "underpaid"
      : input.received_amount_cents > expected
        ? "overpaid"
        : "receipt_recorded";

  await db.query(
    `update payments
     set external_transaction_id = $2,
         received_amount_cents = $3,
         fee_amount_cents = $4,
         net_amount_cents = $5,
         payer_email = coalesce($6, payer_email),
         evidence_media_id = coalesce($7, evidence_media_id),
         recorded_by = $8,
         recorded_at = now(),
         verified_by = null,
         verified_at = null,
         state = 'processing',
         manual_state = $9,
         manual_notes = coalesce($10, manual_notes),
         updated_at = now()
     where id = $1`,
    [
      paymentId,
      txId,
      input.received_amount_cents,
      feeCents,
      netCents,
      input.payer_email?.trim() || null,
      input.evidence_media_id ?? null,
      actor.id,
      manualState,
      input.notes?.trim() || null,
    ],
  );

  await audit(db, actor, "paypal_manual_receipt_recorded", "payments", paymentId, {
    external_transaction_id: txId,
    expected_amount_cents: expected,
    received_amount_cents: input.received_amount_cents,
    fee_amount_cents: feeCents,
    net_amount_cents: netCents,
    manual_state: manualState,
  });

  await recordIntegrationEvent(db, {
    provider_key: "paypal_manual",
    environment: p.environment,
    event_kind: "payment_sync",
    status: manualState === "receipt_recorded" ? "ok" : "warn",
    summary: `Recorded PayPal receipt ${txId}: received $${(input.received_amount_cents / 100).toFixed(2)} vs expected $${(expected / 100).toFixed(2)} (${manualState}).`,
    actor_id: actor.id,
  });

  return {
    payment_id: paymentId,
    external_transaction_id: txId,
    expected_amount_cents: expected,
    received_amount_cents: input.received_amount_cents,
    fee_amount_cents: feeCents,
    net_amount_cents: netCents,
    manual_state: manualState,
    state: "processing",
  };
}

export async function verifyPaypalManualPayment(
  db: DB,
  actor: Actor,
  sessionHash: string,
  paymentId: string,
  input: {
    decision: "approve" | "reject";
    note?: string;
    accept_overpayment?: boolean;
  },
) {
  role(actor, "finance", "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);

  const p = await one<{
    id: string;
    charge_item_id: string;
    provider: string;
    state: string;
    manual_state: string | null;
    environment: EnvMode;
    amount_cents: number;
    expected_amount_cents: number | null;
    received_amount_cents: number | null;
    fee_amount_cents: number | null;
    net_amount_cents: number | null;
    currency: string;
    external_invoice_no: string | null;
    external_transaction_id: string | null;
    payer_email: string | null;
    recorded_by: string | null;
    provider_data: Record<string, unknown>;
  }>(db, "select * from payments where id=$1 for update", [paymentId]);

  guard(p.provider === "paypal_manual", "INVALID_PROVIDER", "Verification applies only to paypal_manual payments.", 400);
  guard(p.state !== "canceled", "PAYMENT_CANCELED", "Canceled invoice attempt cannot be verified.", 409);

  if (p.state === "succeeded" && p.manual_state === "verified") {
    return { payment_id: paymentId, state: "succeeded", manual_state: "verified", idempotent: true };
  }

  guard(Boolean(p.recorded_by && p.external_transaction_id), "RECEIPT_NOT_RECORDED", "Record PayPal transaction ID and received amount before verification.", 409);
  guard(
    p.recorded_by !== actor.id,
    "SOD_VERIFICATION_FORBIDDEN",
    "Separation of duties violation: the verifier must be a different finance/super_admin staff member than who recorded receipt.",
    403,
  );

  if (input.decision === "reject") {
    const history = Array.isArray(p.provider_data?.rejected_history) ? (p.provider_data.rejected_history as unknown[]) : [];
    const nextData = {
      ...(p.provider_data ?? {}),
      rejected_history: [
        ...history,
        {
          rejected_at: new Date().toISOString(),
          rejected_by: actor.id,
          external_transaction_id: p.external_transaction_id,
          received_amount_cents: p.received_amount_cents,
          note: input.note?.trim() || "Rejected by finance verifier",
        },
      ],
    };
    await db.query(
      `update payments
       set external_transaction_id = null,
           received_amount_cents = null,
           recorded_by = null,
           recorded_at = null,
           verified_by = null,
           verified_at = null,
           state = 'requires_payment',
           manual_state = 'rejected',
           manual_notes = coalesce($2, manual_notes),
           provider_data = $3::jsonb,
           updated_at = now()
       where id = $1`,
      [paymentId, input.note?.trim() || null, JSON.stringify(nextData)],
    );
    await audit(db, actor, "paypal_manual_rejected", "payments", paymentId, { note: input.note?.trim() || null });
    return { payment_id: paymentId, state: "requires_payment", manual_state: "rejected" };
  }

  const expected = p.expected_amount_cents ?? p.amount_cents;
  const received = p.received_amount_cents ?? 0;
  guard(
    received >= expected,
    "UNDERPAYMENT_CANNOT_ACTIVATE",
    `Received amount ($${(received / 100).toFixed(2)}) is below invoice total ($${(expected / 100).toFixed(2)}). Collect remaining balance before verification.`,
    409,
  );
  if (received > expected) {
    guard(
      input.accept_overpayment === true,
      "OVERPAYMENT_CONFIRMATION_REQUIRED",
      `Received amount ($${(received / 100).toFixed(2)}) exceeds expected ($${(expected / 100).toFixed(2)}). Explicitly confirm overpayment acceptance.`,
      409,
    );
  }

  await db.query(
    `update payments
     set verified_by = $2,
         verified_at = now(),
         manual_state = 'verified',
         manual_notes = coalesce($3, manual_notes),
         updated_at = now()
     where id = $1`,
    [paymentId, actor.id, input.note?.trim() || null],
  );

  await db.query(
    `insert into payment_events (id, provider, event_id, type, payload, processed_at)
     values ($1, 'paypal_manual', $2, 'manual_invoice.verified', $3::jsonb, now())
     on conflict (provider, event_id) do nothing`,
    [
      uuid(),
      "verify:" + paymentId,
      JSON.stringify({
        payment_id: paymentId,
        external_invoice_no: p.external_invoice_no,
        external_transaction_id: p.external_transaction_id,
        received_amount_cents: received,
        verified_by: actor.id,
      }),
    ],
  );

  await db.query(
    `insert into payment_settlements (
       provider_transaction_id, payment_id, gross_minor, fee_minor, net_minor, currency, settled_at
     ) values ($1, $2, $3, $4, $5, $6, now())
     on conflict (provider_transaction_id) do nothing`,
    [
      p.external_transaction_id!,
      paymentId,
      received,
      p.fee_amount_cents ?? 0,
      p.net_amount_cents ?? received,
      p.currency,
    ],
  );

  await applyPayment(
    db,
    paymentId,
    p.external_transaction_id!,
    {
      channel: "paypal_manual_invoice",
      external_invoice_no: p.external_invoice_no,
      payer_email: p.payer_email,
      received_amount_cents: received,
      verified_by: actor.id,
    },
    Math.floor(Date.now() / 1000),
  );

  await audit(db, actor, "paypal_manual_verified", "payments", paymentId, {
    external_transaction_id: p.external_transaction_id,
    received_amount_cents: received,
    recorded_by: p.recorded_by,
    verified_by: actor.id,
  });

  await recordIntegrationEvent(db, {
    provider_key: "paypal_manual",
    environment: p.environment,
    event_kind: "payment_sync",
    status: "ok",
    summary: `Verified & applied PayPal receipt ${p.external_transaction_id} ($${(received / 100).toFixed(2)}).`,
    actor_id: actor.id,
  });

  return { payment_id: paymentId, state: "succeeded", manual_state: "verified", external_transaction_id: p.external_transaction_id };
}

export async function cancelPaypalManualInvoice(
  db: DB,
  actor: Actor,
  sessionHash: string,
  paymentId: string,
  reason: string,
) {
  role(actor, "finance", "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const p = await one<{ id: string; provider: string; state: string; external_transaction_id: string | null; provider_data: Record<string, unknown> }>(
    db,
    "select id, provider, state, external_transaction_id, provider_data from payments where id=$1 for update",
    [paymentId],
  );
  guard(p.provider === "paypal_manual", "INVALID_PROVIDER", "Cancel applies only to paypal_manual payments.", 400);
  guard(!["succeeded", "partially_refunded", "refunded"].includes(p.state), "CANNOT_CANCEL_SETTLED", "Cannot cancel an already verified/settled payment.", 409);

  const nextData = {
    ...(p.provider_data ?? {}),
    canceled_snapshot: {
      at: new Date().toISOString(),
      by: actor.id,
      reason: reason.trim(),
      previous_tx_id: p.external_transaction_id,
    },
  };

  await db.query(
    `update payments
     set state = 'canceled',
         manual_state = 'canceled',
         external_transaction_id = null,
         manual_notes = $2,
         provider_data = $3::jsonb,
         updated_at = now()
     where id = $1`,
    [paymentId, reason.trim(), JSON.stringify(nextData)],
  );

  await audit(db, actor, "paypal_manual_canceled", "payments", paymentId, { reason: reason.trim() });
  return { payment_id: paymentId, state: "canceled", manual_state: "canceled" };
}

export async function listPaypalManualQueue(db: DB, actor: Actor) {
  role(actor, "finance", "super_admin", "support");
  return (
    await db.query(
      `select p.id, p.charge_item_id, p.provider, p.channel, p.environment, p.state, p.manual_state,
              p.amount_cents, p.expected_amount_cents, p.received_amount_cents, p.fee_amount_cents, p.net_amount_cents,
              p.currency, p.external_invoice_no, p.external_transaction_id, p.payer_email, p.invoice_url,
              p.evidence_media_id, p.issued_by, p.issued_at, p.recorded_by, p.recorded_at, p.verified_by, p.verified_at,
              p.manual_notes, p.provider_data, p.created_at, p.updated_at,
              c.purpose, c.org_id, crp.receiving_code, cust.display_name customer_name, ue.original_email customer_email,
              ib.display_name issued_by_name, rb.display_name recorded_by_name, vb.display_name verified_by_name,
              coalesce(iq_ord.public_no, (
                select string_agg(distinct o2.public_no, ', ')
                from dispatch_batch_items bi2
                join warehouse_items wi2 on wi2.id = bi2.item_id
                left join order_line_item_links li2 on li2.item_id = wi2.id and li2.unlinked_at is null
                left join order_lines ol2 on ol2.id = li2.order_line_id
                left join orders o2 on o2.id = ol2.order_id
                where bi2.batch_id = dq.batch_id
              )) order_public_no
       from payments p
       join charge_items c on c.id = p.charge_item_id
       left join inspection_quotes iq on iq.id = c.inspection_quote_id
       left join orders iq_ord on iq_ord.id = iq.order_id
       left join dispatch_quote_versions dq on dq.id = c.dispatch_quote_id
       left join customer_receiving_profiles crp on crp.org_id = c.org_id
       left join users cust on cust.id = crp.user_id
       left join user_emails ue on ue.user_id = cust.id and ue.is_primary
       left join users ib on ib.id = p.issued_by
       left join users rb on rb.id = p.recorded_by
       left join users vb on vb.id = p.verified_by
       where p.provider = 'paypal_manual'
       order by
         case when p.manual_state in ('receipt_recorded','underpaid','overpaid') then 0
              when p.manual_state in ('requested','invoice_sent') then 1
              else 2 end,
         p.updated_at desc
       limit 200`,
    )
  ).rows;
}

export async function executeManualRefund(
  db: DB,
  actor: Actor,
  sessionHash: string,
  refundId: string,
  input: {
    manual_refund_ref: string;
    evidence_media_id?: string;
    notes?: string;
  },
) {
  role(actor, "finance", "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const ref = input.manual_refund_ref.trim().toUpperCase();
  guard(ref.length >= 4 && ref.length <= 128, "INVALID_REFUND_REF", "Provide a valid external refund transaction reference.", 422);

  const row = await one<{
    id: string;
    payment_id: string;
    amount_cents: number;
    state: string;
    revision: number;
    provider: string;
    payment_amount_cents: number;
    environment: EnvMode;
  }>(
    db,
    `select r.id, r.payment_id, r.amount_cents, r.state, r.revision, p.provider, p.amount_cents payment_amount_cents, p.environment
     from refunds r join payments p on p.id = r.payment_id
     where r.id = $1 for update of r, p`,
    [refundId],
  );
  guard(row.provider !== "stripe", "USE_STRIPE_REFUND", "Stripe refunds execute automatically through Stripe API.", 400);
  guard(row.state === "approved", "REFUND_NOT_APPROVED", "Only Finance-approved refunds can be marked manually executed.", 409);

  if (input.evidence_media_id) {
    const asset = await one<{ kind: string; status: string }>(db, "select kind, status from media_assets where id=$1", [input.evidence_media_id]);
    guard(asset.kind === "attachment" && asset.status === "ready", "INVALID_EVIDENCE", "Proof file must be a ready attachment.", 422);
  }

  await db.query(
    `update refunds
     set state = 'succeeded',
         channel = $2,
         provider_ref = $3,
         manual_refund_ref = $3,
         evidence_media_id = coalesce($4, evidence_media_id),
         executed_by = $5,
         executed_at = now(),
         notes = coalesce($6, notes),
         revision = revision + 1
     where id = $1`,
    [refundId, row.provider, ref, input.evidence_media_id ?? null, actor.id, input.notes?.trim() || null],
  );

  await syncPaymentRefundState(db, row.payment_id);
  const updatedPay = await one<{ state: string }>(db, "select state from payments where id=$1", [row.payment_id]);
  const nextPayState = updatedPay.state;

  await audit(db, actor, "manual_refund_executed", "refunds", refundId, {
    payment_id: row.payment_id,
    channel: row.provider,
    manual_refund_ref: ref,
    amount_cents: row.amount_cents,
  });
  await event(db, "refund.succeeded", { refund_id: refundId, payment_id: row.payment_id, channel: row.provider });
  await recordIntegrationEvent(db, {
    provider_key: row.provider === "paypal_manual" ? "paypal_manual" : "stripe",
    environment: row.environment,
    event_kind: "payment_sync",
    status: "ok",
    summary: `Executed manual refund ${ref} ($${(row.amount_cents / 100).toFixed(2)}) for payment ${row.payment_id}.`,
    actor_id: actor.id,
  });

  return { refund_id: refundId, payment_id: row.payment_id, state: "succeeded", payment_state: nextPayState, manual_refund_ref: ref };
}

export async function reconcileStripeStatus(db: DB, actor: Actor, sessionHash: string) {
  role(actor, "finance", "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const settings = await stripeSettingsFromDb(db);
  const modePrefix = settings.mode ? `cs_${settings.mode}_%` : "cs_%";
  const pending = (
    await db.query<{
      id: string;
      provider_ref: string;
      state: string;
      amount_cents: number;
      currency: string;
      charge_item_id: string;
      org_id: string;
    }>(
      `select p.id, p.provider_ref, p.state, p.amount_cents, p.currency, p.charge_item_id, c.org_id
       from payments p join charge_items c on c.id = p.charge_item_id
       where p.provider = 'stripe' and p.state in ('requires_payment','processing') and p.provider_ref like $1
       order by p.updated_at desc
       limit 25`,
      [modePrefix.replace(/([_])/g, "\\$1").replace(/\\\\%$/, "%") === modePrefix ? modePrefix : modePrefix],
    )
  ).rows;

  if (!settings.key || !settings.mode || !settings.enabled) {
    await recordIntegrationEvent(db, {
      provider_key: "stripe",
      environment: settings.environment,
      event_kind: "payment_sync",
      status: "warn",
      summary: `Reconciliation skipped live Stripe lookup (${pending.length} pending sessions): Stripe key/mode unavailable or channel disabled.`,
      actor_id: actor.id,
    });
    return {
      ok: false,
      configured: false,
      environment: settings.environment,
      checked: pending.length,
      reconciled: 0,
      still_pending: pending.length,
      errors: ["Stripe secret_key/mode is not active in Vault or environment."],
    };
  }

  const client = new Stripe(settings.key, { timeout: 15000, maxNetworkRetries: 1 });
  let reconciled = 0;
  const errors: string[] = [];

  for (const row of pending) {
    try {
      const session = await client.checkout.sessions.retrieve(row.provider_ref);
      if (session.payment_status === "paid") {
        const expectedLive = settings.mode === "live";
        if (
          session.id !== row.provider_ref ||
          session.livemode !== expectedLive ||
          session.amount_total !== row.amount_cents ||
          session.currency?.toLowerCase() !== row.currency.toLowerCase() ||
          session.metadata?.payment_id !== row.id ||
          session.metadata?.charge_item_id !== row.charge_item_id ||
          session.metadata?.org_id !== row.org_id
        ) {
          errors.push(`${row.id}: Stripe session metadata, livemode, currency, or amount mismatch`);
          continue;
        }
        await applyPayment(
          db,
          row.id,
          session.id,
          { payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : null, reconciled: true },
          session.created || Math.floor(Date.now() / 1000),
        );
        reconciled++;
      }
    } catch (err) {
      errors.push(`${row.id}: ${err instanceof Error ? err.message.slice(0, 120) : "lookup error"}`);
    }
  }

  await recordIntegrationEvent(db, {
    provider_key: "stripe",
    environment: settings.environment,
    event_kind: "payment_sync",
    status: errors.length > 0 ? "warn" : "ok",
    summary: `Stripe active reconcile (${settings.environment}): checked ${pending.length}, reconciled ${reconciled}, errors ${errors.length}.`,
    actor_id: actor.id,
  });

  await audit(db, actor, "stripe_active_reconcile", "integration_providers", null, {
    environment: settings.environment,
    checked: pending.length,
    reconciled,
    error_count: errors.length,
  });

  return {
    ok: errors.length === 0,
    configured: true,
    environment: settings.environment,
    checked: pending.length,
    reconciled,
    still_pending: Math.max(0, pending.length - reconciled),
    errors,
  };
}
