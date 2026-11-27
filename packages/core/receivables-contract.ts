import { guard, Problem } from "./common";

export const RECEIVABLE_PURPOSES = [
  "inspection",
  "scope_addition",
  "domestic_freight",
  "seller_return",
  "packing_handling",
  "overdue_storage",
  "reference_sealing",
  "reference_renewal",
  "customer_reinspection",
] as const;
export type ReceivablePurpose = (typeof RECEIVABLE_PURPOSES)[number];

export const RECEIVABLE_STATES = [
  "estimated",
  "pending_confirmation",
  "open",
  "processing",
  "partially_paid",
  "paid",
  "failed",
  "cancelled",
  "expired",
  "superseded",
  "refunding",
  "partially_refunded",
  "refunded",
  "disputed",
] as const;
export type ReceivableState = (typeof RECEIVABLE_STATES)[number];

export type ReceivableObligationContract = {
  id: string;
  orgId: string;
  purpose: ReceivablePurpose;
  amountCents: number;
  currency: "USD" | "CNY";
  state: ReceivableState;
  merchantInstanceId: string;
  legalEntityId: string;
  quoteVersionId: string | null;
  quoteExpiresAt: string | null;
  appliedPaymentId: string | null;
  freeAuthorizationRef: string | null;
  voidedAt: string | null;
  reworkZeroFee: boolean;
};

export type PaymentIntentContract = {
  id: string;
  orgId: string;
  merchantInstanceId: string;
  currency: "USD" | "CNY";
  provider: "stripe" | "paypal_manual" | "paypal_auto";
  amountCents: number;
  state: "requires_payment" | "processing" | "succeeded" | "failed" | "canceled";
  confirmedByServerWebhookOrFinance: boolean;
};

export type PaymentAllocationContract = {
  allocationId: string;
  paymentId: string;
  obligationId: string;
  allocatedCents: number;
  currency: "USD" | "CNY";
  merchantInstanceId: string;
};

/**
 * §63.1 Platform rework MUST NEVER create a positive customer receivable charge.
 */
export function assertReworkChargeZero(obligation: ReceivableObligationContract) {
  if (obligation.reworkZeroFee) {
    guard(obligation.amountCents === 0, "REWORK_CHARGE_FORBIDDEN", "Platform rework obligations cannot bill the customer.", 422);
  }
}

/**
 * §63.1 Consolidated multi-obligation checkout is allowed ONLY for the same customer org,
 * same currency, same merchant instance, active payable obligations, and unexpired quotes.
 */
export function validateConsolidatedCheckout(obligations: readonly ReceivableObligationContract[], now = new Date()) {
  guard(obligations.length > 0, "EMPTY_CHECKOUT_OBLIGATIONS", "At least one receivable obligation is required.", 422);
  const first = obligations[0]!;
  const seenIds = new Set<string>();
  for (const ob of obligations) {
    guard(!seenIds.has(ob.id), "DUPLICATE_CHECKOUT_OBLIGATION", `Duplicate obligation '${ob.id}' in consolidated checkout.`, 422);
    seenIds.add(ob.id);
    assertReworkChargeZero(ob);
    guard(Number.isInteger(ob.amountCents) && (ob.reworkZeroFee ? ob.amountCents === 0 : ob.amountCents > 0), "INVALID_OBLIGATION_AMOUNT", `Obligation ${ob.id} amount must be positive integer cents.`, 422);
    guard(ob.orgId === first.orgId, "CROSS_TENANT_CHECKOUT_FORBIDDEN", "Cannot combine obligations across customer accounts.", 403);
    guard(ob.currency === first.currency, "CURRENCY_MISMATCH", "Cannot mix USD and CNY in one payment intent.", 409);
    guard(ob.merchantInstanceId === first.merchantInstanceId, "MERCHANT_INSTANCE_MISMATCH", "All consolidated obligations must route to the same merchant instance.", 409);
    guard(!ob.voidedAt && ob.state === "open", "CHARGE_NOT_PAYABLE", `Obligation ${ob.id} in state '${ob.state}' is not open for payment.`, 409);
    guard(!ob.appliedPaymentId && !ob.freeAuthorizationRef, "ALREADY_SETTLED", `Obligation ${ob.id} is already settled.`, 409);
    if (ob.quoteExpiresAt) {
      guard(new Date(ob.quoteExpiresAt).getTime() > now.getTime(), "QUOTE_EXPIRED", `Quote for obligation ${ob.id} has expired.`, 409);
    }
  }
  const totalCents = obligations.reduce((sum, ob) => sum + ob.amountCents, 0);
  guard(totalCents > 0, "ZERO_CHECKOUT_AMOUNT", "Consolidated checkout total must be positive.", 422);
  return {
    orgId: first.orgId,
    currency: first.currency,
    merchantInstanceId: first.merchantInstanceId,
    totalCents,
    obligationIds: obligations.map((ob) => ob.id),
  };
}

/**
 * Prevent double-payment / success_url spoofing / unverified settlement unlock (§63.3).
 */
export function assertPaymentSettlementInvariant(
  obligation: ReceivableObligationContract,
  intent: PaymentIntentContract,
  existingActiveIntentStates: readonly PaymentIntentContract["state"][],
) {
  guard(obligation.orgId === intent.orgId, "FORBIDDEN", "Obligation and payment intent belong to different organizations.", 403);
  guard(obligation.currency === intent.currency, "PAYMENT_CURRENCY_MISMATCH", "Payment currency does not match obligation.", 409);
  guard(obligation.merchantInstanceId === intent.merchantInstanceId, "MERCHANT_INSTANCE_MISMATCH", "Settlement merchant instance mismatch.", 409);
  guard(intent.confirmedByServerWebhookOrFinance && intent.state === "succeeded", "PAYMENT_NOT_SERVER_CONFIRMED", "Only server-verified payments can settle obligations; return redirects cannot unlock workflow.", 409);
  guard(!obligation.appliedPaymentId && obligation.state !== "paid", "DOUBLE_PAYMENT_PREVENTED", "Obligation already has an applied payment.", 409);
  guard(
    !obligation.voidedAt && ["open", "processing", "partially_paid", "pending_confirmation"].includes(obligation.state),
    "CHARGE_NOT_PAYABLE",
    `Obligation in state '${obligation.state}'${obligation.voidedAt ? " (voided)" : ""} cannot accept payment settlement.`,
    409,
  );
  const competingSucceeded = existingActiveIntentStates.filter((s) => s === "succeeded").length;
  guard(competingSucceeded === 0, "CONCURRENT_DOUBLE_PAYMENT_DETECTED", "A competing settled payment already exists for this obligation; route to reconciliation.", 409);
}

/**
 * Refunds must route to the exact original merchant instance and never exceed settled paid cents.
 */
export function assertOriginalMerchantRefund(params: {
  payment: { id: string; merchantInstanceId: string; paidCents: number; refundedCents: number; pendingRefundCents: number };
  targetMerchantInstanceId: string;
  requestedRefundCents: number;
  physicalCustodyAlreadyHandedOver: boolean;
}) {
  guard(params.requestedRefundCents > 0, "INVALID_REFUND_AMOUNT", "Refund amount must be positive.", 422);
  guard(
    params.targetMerchantInstanceId === params.payment.merchantInstanceId,
    "ORIGINAL_MERCHANT_REQUIRED",
    "Refunds must route back through the exact original payment merchant instance.",
    409,
  );
  const available = params.payment.paidCents - params.payment.refundedCents - params.payment.pendingRefundCents;
  guard(
    params.requestedRefundCents <= available,
    "REFUND_EXCEEDS_PAID",
    `Requested refund (${params.requestedRefundCents}) exceeds remaining refundable balance (${available}).`,
    409,
  );
  return {
    eligible: true,
    requiresManualRiskReview: params.physicalCustodyAlreadyHandedOver,
  };
}

/**
 * Outbound handover authorization: checks actual receivable obligations directly, NEVER trusting
 * single order state or return URL flags.
 */
export function assertOutboundFinancialReleaseAuthorized(
  orderState: string,
  requiredObligations: readonly ReceivableObligationContract[],
): { authorized: true; staleOrderStateIgnored: true } {
  guard(requiredObligations.length > 0, "MISSING_DISPATCH_OBLIGATIONS", "Dispatch release requires explicit obligation verification.", 409);
  for (const ob of requiredObligations) {
    const settled = ob.state === "paid" && Boolean(ob.appliedPaymentId);
    const waived = Boolean(ob.freeAuthorizationRef);
    if (!settled && !waived) {
      throw new Problem(
        "UNSETTLED_RECEIVABLE_BLOCKS_DISPATCH",
        `Cannot authorize dispatch (${ob.purpose}, state=${ob.state}) from order status '${orderState}' without verified payment or formal waiver.`,
        409,
      );
    }
  }
  return { authorized: true, staleOrderStateIgnored: true };
}
