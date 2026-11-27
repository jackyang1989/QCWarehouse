import assert from "node:assert/strict";
import test from "node:test";
import { Problem, type Actor } from "../packages/core/common";
import {
  AI_PURPOSE_CODES,
  assertAiInvocationAuthorized,
  assertLanguageOnlyCapability,
  assertSafeOutboundAiPayload,
  createManualTranslationFallback,
  reserveAiBudget,
  validateAiTranslationOutput,
  type AiModelContract,
  type AiProviderInstanceContract,
  type AiPurposeRouteContract,
} from "../packages/core/ai-contract";
import {
  appendTicketOriginalPreserved,
  assertNotificationSendAuthorized,
  buildNotificationDedupeKey,
  markRecipientNotificationRead,
  projectTicketMessagesForActor,
  renderLockedTemplateSnapshot,
} from "../packages/core/messaging-contract";
import {
  assertOriginalMerchantRefund,
  assertOutboundFinancialReleaseAuthorized,
  assertPaymentSettlementInvariant,
  validateConsolidatedCheckout,
  type ReceivableObligationContract,
} from "../packages/core/receivables-contract";
import {
  activatePaidBenchmarkContract,
  approveCandidateBenchmark,
  assertBenchmarkCallableForMatching,
  assertCustomerAccountDeletionBlockedByActiveCustody,
  assertHistoricalBenchmarkImmutable,
  createSupersededBenchmarkVersion,
  sealApprovedBenchmark,
  type GoldenBenchmarkContract,
} from "../packages/core/golden-sample-contract";
import {
  acquireQueueLease,
  assertValidFencedLease,
  markExternalUnknownOutcome,
  recordQueueFailure,
  resolveUnknownOutcomeJob,
  selectNextEligiblePoolJob,
  type ReliableQueueJob,
} from "../packages/core/queue-contract";

// ---------- TASK-191A: AI Service Contracts ----------

test("TASK-191A: AI adapter contracts forbid tools, unapproved models/roles, broken output, budget overrun & preserve manual fallback", () => {
  assert.equal(AI_PURPOSE_CODES.length, 9);

  assert.throws(
    () => assertLanguageOnlyCapability([]),
    (e: unknown) => e instanceof Problem && e.code === "AI_BUSINESS_TOOL_FORBIDDEN" && e.status === 403,
  );
  assert.throws(
    () => assertLanguageOnlyCapability(["language_translation_only", "payment_execute"]),
    (e: unknown) => e instanceof Problem && e.code === "AI_BUSINESS_TOOL_FORBIDDEN" && e.status === 403,
  );

  const authorizedActor: Actor = { id: "u-tpl", org: null, kind: "staff", roles: ["template_admin"] };
  const unauthorizedActor: Actor = { id: "u-rec", org: null, kind: "staff", roles: ["receiver"] };
  const scope = { accountStatus: "active" as const, mfaFresh: true };
  const instance: AiProviderInstanceContract = {
    id: "inst-1",
    adapterType: "openai_official",
    environment: "production",
    baseUrl: "https://api.openai.com/v1",
    status: "approved",
    dataRegionPolicy: "us-standard",
    requestedCapabilities: ["language_translation_only"],
  };
  const model: AiModelContract = {
    id: "m-1",
    instanceId: "inst-1",
    modelId: "gpt-4o-mini",
    supportsStructuredOutput: true,
    approved: true,
    deprecated: false,
  };
  const route: AiPurposeRouteContract = {
    purpose: "KNOWLEDGE_TRANSLATION_DRAFT",
    autoEnabled: true,
    primaryInstanceId: "inst-1",
    primaryModelId: "gpt-4o-mini",
    promptVersion: 1,
    maxInputChars: 500,
    requiresHumanConfirmation: false,
    approved: true,
  };

  assert.doesNotThrow(() =>
    assertAiInvocationAuthorized({
      actor: authorizedActor,
      action: "ai.translate_batch",
      scope,
      instance,
      model,
      route,
      environment: "production",
    }),
  );

  assert.throws(
    () =>
      assertAiInvocationAuthorized({
        actor: unauthorizedActor,
        action: "ai.translate_field",
        scope,
        instance,
        model,
        route,
        environment: "production",
      }),
    (e: unknown) => e instanceof Problem && e.status === 403,
  );

  assert.throws(
    () =>
      assertAiInvocationAuthorized({
        actor: authorizedActor,
        action: "ai.translate_batch",
        scope,
        instance,
        model: { ...model, approved: false },
        route,
        environment: "production",
      }),
    (e: unknown) => e instanceof Problem && e.code === "UNKNOWN_AI_MODEL" && e.status === 422,
  );

  assert.throws(
    () => assertSafeOutboundAiPayload("Customer card 4242 4242 4242 4242 or sk_live_abcdefghijklmnop", 500),
    (e: unknown) => e instanceof Problem && e.code === "UNSAFE_OUTBOUND_AI_PAYLOAD",
  );

  assert.throws(
    () =>
      validateAiTranslationOutput(
        [{ field_id: "title", source_text: "Order {orderNo}", placeholders: ["orderNo"] }],
        "zh-CN",
        [{ field_id: "title", target_locale: "zh-CN", translated_text: "订单缺变量", status: "translated", warnings: [] }],
      ),
    (e: unknown) => e instanceof Problem && e.code === "AI_OUTPUT_PLACEHOLDER_BROKEN",
  );
  assert.throws(
    () =>
      validateAiTranslationOutput(
        [{ field_id: "title", source_text: "Order {orderNo}", placeholders: ["orderNo"] }],
        "zh-CN",
        [{ field_id: "title", target_locale: "zh-CN", translated_text: "订单 {orderNo} {hallucinatedVar}", status: "translated", warnings: [] }],
      ),
    (e: unknown) => e instanceof Problem && e.code === "AI_OUTPUT_PLACEHOLDER_BROKEN",
  );

  const ledger = reserveAiBudget({ instanceId: "inst-1", limitCents: 100, reservedCents: 80, spentCents: 10 }, 10);
  assert.equal(ledger.reservedCents, 90);
  assert.throws(
    () => reserveAiBudget(ledger, 20),
    (e: unknown) => e instanceof Problem && e.code === "AI_BUDGET_EXCEEDED",
  );

  const fallback = createManualTranslationFallback({
    fieldId: "title",
    targetLocale: "zh-CN",
    manualText: "人工兜底专业译文",
    authorId: "u-tpl",
  });
  assert.equal(fallback.cost_cents, 0);
  assert.equal(fallback.model_used, null);
});

// ---------- TASK-194A: Messaging, Ticket & Inbox Isolation Contracts ----------

test("TASK-194A: notification isolation, template guard, WhatsApp default-off & ticket internal_note secrecy", () => {
  const dedupe1 = buildNotificationDedupeKey({
    eventType: "report.published",
    entityId: "ord-1",
    entityVersion: 2,
    recipientUserId: "cust-1",
    channel: "email",
  });
  assert.equal(dedupe1, "report.published:ord-1:v2:cust-1:email:initial");

  const snap = renderLockedTemplateSnapshot({
    templateCode: "report.published",
    locale: "zh-CN",
    titleTemplate: "订单 {orderNo} 报告已发布",
    bodyTemplate: "请登录 {portalName} 查看。",
    variables: { orderNo: "QW26112701", portalName: "QC Warehouse" },
  });
  assert.equal(snap.locale, "zh-CN");
  assert.throws(
    () =>
      renderLockedTemplateSnapshot({
        templateCode: "report.published",
        locale: "en-US",
        titleTemplate: "Order {orderNo}",
        bodyTemplate: "Hi",
        variables: { orderNo: "<script>alert(1)</script>" },
      }),
    (e: unknown) => e instanceof Problem && e.code === "UNSAFE_TEMPLATE_VARIABLE",
  );

  // Shared org members' read status never mutates another member or auto-closes todos.
  const inbox = [
    { id: "i1", notificationId: "n1", recipientUserId: "cust-1", orgId: "org-1", readAt: null, archivedAt: null, associatedTodoId: "todo-1" },
    { id: "i2", notificationId: "n1", recipientUserId: "cust-2", orgId: "org-1", readAt: null, archivedAt: null, associatedTodoId: "todo-1" },
  ];
  const { updated, businessTodoAutoClosed } = markRecipientNotificationRead(inbox, "n1", "cust-1");
  assert.equal(businessTodoAutoClosed, false);
  assert.ok(updated[0]!.readAt);
  assert.equal(updated[1]!.readAt, null);

  const support: Actor = { id: "u-sup", org: null, kind: "staff", roles: ["support"] };
  assert.throws(
    () =>
      assertNotificationSendAuthorized({
        actor: support,
        scope: { accountStatus: "active" },
        sourceKind: "manual_targeted",
        channel: "whatsapp",
        channelConfig: { whatsappVerifiedAndConsented: false },
        recipientUserId: "cust-1",
        authorizedRecipientPool: ["cust-1"],
      }),
    (e: unknown) => e instanceof Problem && e.code === "WHATSAPP_CHANNEL_UNVERIFIED",
  );

  const customer: Actor = { id: "u-cust", org: "org-1", kind: "customer", roles: [] };
  assert.throws(
    () => appendTicketOriginalPreserved({ ticketId: "t1", actor: customer, kind: "staff_reply", body: "Spoofed staff", locale: "en-US" }),
    (e: unknown) => e instanceof Problem && e.status === 403,
  );
  const custMsg = appendTicketOriginalPreserved({ ticketId: "t1", actor: customer, kind: "customer_message", body: "Please check collar.", locale: "en-US" });
  const internalNote = appendTicketOriginalPreserved({ ticketId: "t1", actor: support, kind: "internal_note", body: "Factory delay suspected.", locale: "zh-CN" });
  const visibleToCustomer = projectTicketMessagesForActor(customer, [custMsg, internalNote], "org-1");
  assert.equal(visibleToCustomer.length, 1);
  assert.equal(visibleToCustomer[0]!.kind, "customer_message");
});

// ---------- TASK-229A: Transaction & Receivables Contracts ----------

test("TASK-229A: receivable obligations prevent rework fees, double pay, wrong-merchant refund & unpaid dispatch", () => {
  const baseOb: ReceivableObligationContract = {
    id: "ob-1",
    orgId: "org-1",
    purpose: "inspection",
    amountCents: 2500,
    currency: "USD",
    state: "open",
    merchantInstanceId: "merch-hk-live-1",
    legalEntityId: "le-hk",
    quoteVersionId: "q-1",
    quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    appliedPaymentId: null,
    freeAuthorizationRef: null,
    voidedAt: null,
    reworkZeroFee: false,
  };

  assert.throws(
    () => validateConsolidatedCheckout([{ ...baseOb, reworkZeroFee: true, amountCents: 500 }]),
    (e: unknown) => e instanceof Problem && e.code === "REWORK_CHARGE_FORBIDDEN",
  );

  assert.throws(
    () =>
      validateConsolidatedCheckout([
        baseOb,
        { ...baseOb, id: "ob-2", merchantInstanceId: "merch-hk-legacy-0" },
      ]),
    (e: unknown) => e instanceof Problem && e.code === "MERCHANT_INSTANCE_MISMATCH",
  );

  assert.throws(
    () => validateConsolidatedCheckout([baseOb, baseOb]),
    (e: unknown) => e instanceof Problem && e.code === "DUPLICATE_CHECKOUT_OBLIGATION",
  );

  assert.throws(
    () =>
      assertPaymentSettlementInvariant(
        { ...baseOb, state: "cancelled", voidedAt: new Date().toISOString() },
        {
          id: "pi-cancelled",
          orgId: "org-1",
          merchantInstanceId: "merch-hk-live-1",
          currency: "USD",
          provider: "stripe",
          amountCents: 2500,
          state: "succeeded",
          confirmedByServerWebhookOrFinance: true,
        },
        [],
      ),
    (e: unknown) => e instanceof Problem && e.code === "CHARGE_NOT_PAYABLE",
  );

  assert.throws(
    () =>
      assertPaymentSettlementInvariant(
        baseOb,
        {
          id: "pi-1",
          orgId: "org-1",
          merchantInstanceId: "merch-hk-live-1",
          currency: "USD",
          provider: "stripe",
          amountCents: 2500,
          state: "requires_payment",
          confirmedByServerWebhookOrFinance: false,
        },
        [],
      ),
    (e: unknown) => e instanceof Problem && e.code === "PAYMENT_NOT_SERVER_CONFIRMED",
  );

  assert.throws(
    () =>
      assertOriginalMerchantRefund({
        payment: { id: "pay-1", merchantInstanceId: "merch-hk-legacy-0", paidCents: 2500, refundedCents: 0, pendingRefundCents: 0 },
        targetMerchantInstanceId: "merch-hk-live-1",
        requestedRefundCents: 1000,
        physicalCustodyAlreadyHandedOver: false,
      }),
    (e: unknown) => e instanceof Problem && e.code === "ORIGINAL_MERCHANT_REQUIRED",
  );

  assert.throws(
    () => assertOutboundFinancialReleaseAuthorized("report_ready", [baseOb]),
    (e: unknown) => e instanceof Problem && e.code === "UNSETTLED_RECEIVABLE_BLOCKS_DISPATCH",
  );
  assert.equal(
    assertOutboundFinancialReleaseAuthorized("closed", [{ ...baseOb, state: "paid", appliedPaymentId: "pay-1" }]).authorized,
    true,
  );
});

// ---------- TASK-228A: Golden Sample & Custody Contracts ----------

test("TASK-228A: Golden Sample enforces SoD QA, payment activation separation, version immutability & ongoing custody", () => {
  const proposer: Actor = { id: "u-insp", org: null, kind: "staff", roles: ["inspector", "reviewer"] };
  const reviewer: Actor = { id: "u-rev", org: null, kind: "staff", roles: ["reviewer"] };
  const candidate: GoldenBenchmarkContract = {
    benchmarkId: "gs-1",
    version: 1,
    orgId: "org-1",
    itemId: "item-1",
    categorySlug: "apparel",
    proposedBy: proposer.id,
    qaApprovedBy: null,
    state: "candidate",
    custodyContractId: null,
    custodyReceivableSettled: false,
    expiresAt: null,
    frozenReason: null,
    reservedCallsCount: 0,
    archivedMeasurementSpecHash: "sha256-v1",
    parentOrderClosed: true,
  };

  // Same natural person cannot self-approve candidate benchmark.
  assert.throws(
    () => approveCandidateBenchmark(proposer, { accountStatus: "active" }, candidate),
    (e: unknown) => e instanceof Problem && e.code === "SELF_REVIEW_FORBIDDEN",
  );

  const qaDone = approveCandidateBenchmark(reviewer, { accountStatus: "active" }, candidate);
  const sealed = sealApprovedBenchmark(qaDone);

  // Sealing alone NEVER grants paid callable matching eligibility!
  assert.throws(
    () => assertBenchmarkCallableForMatching(sealed, "org-1", "apparel"),
    (e: unknown) => e instanceof Problem && e.code === "BENCHMARK_NOT_ACTIVE",
  );

  const futureExpiry = new Date(Date.now() + 30 * 86400_000).toISOString();
  const active = activatePaidBenchmarkContract(sealed, 30, "cc-1", true, futureExpiry);
  assert.equal(assertBenchmarkCallableForMatching(active, "org-1", "apparel").callable, true);
  assert.throws(
    () => assertBenchmarkCallableForMatching({ ...active, expiresAt: null }, "org-1", "apparel"),
    (e: unknown) => e instanceof Problem && e.code === "BENCHMARK_EXPIRED",
  );

  assert.throws(
    () => assertBenchmarkCallableForMatching(active, "org-other", "apparel"),
    (e: unknown) => e instanceof Problem && e.status === 403,
  );
  assert.throws(
    () => assertHistoricalBenchmarkImmutable(active, "sha256-tampered"),
    (e: unknown) => e instanceof Problem && e.code === "HISTORICAL_BENCHMARK_IMMUTABLE",
  );

  const { archivedPrior, nextCandidate } = createSupersededBenchmarkVersion(active, "gs-2", "item-2", "sha256-v2", proposer.id);
  assert.equal(archivedPrior.state, "retired");
  assert.equal(archivedPrior.archivedMeasurementSpecHash, "sha256-v1");
  assert.equal(nextCandidate.version, 2);

  assert.throws(
    () => assertCustomerAccountDeletionBlockedByActiveCustody([active]),
    (e: unknown) => e instanceof Problem && e.code === "ONGOING_CUSTODY_OBLIGATION_ACTIVE",
  );
  assert.throws(
    () => assertCustomerAccountDeletionBlockedByActiveCustody([{ ...active, state: "expired" }]),
    (e: unknown) => e instanceof Problem && e.code === "ONGOING_CUSTODY_OBLIGATION_ACTIVE",
  );
});

// ---------- TASK-238A: Queue Pools, Leases, Backoff & Unknown Outcome ----------

test("TASK-238A: queue pool isolation prevents batch starvation, fences stale leases & blocks blind unknown_outcome replay", () => {
  const now = new Date("2026-11-27T10:00:00.000Z");
  const jobs: ReliableQueueJob[] = [
    {
      id: "j-trans",
      pool: "translation_batch",
      type: "ai.batch",
      idempotencyKey: "k-t",
      attempts: 0,
      maxAttempts: 5,
      state: "pending",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: "2026-11-27T09:50:00.000Z",
      lastErrorCode: null,
    },
    {
      id: "j-pay",
      pool: "payment_settlement",
      type: "payment.checkout_expire",
      idempotencyKey: "k-p",
      attempts: 0,
      maxAttempts: 10,
      state: "pending",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: "2026-11-27T09:59:00.000Z",
      lastErrorCode: null,
    },
  ];

  const picked = selectNextEligiblePoolJob(
    jobs,
    { payment_settlement: 0, delivery_notification: 0, report_render: 0, media_processing: 0, translation_batch: 0 },
    now,
  );
  assert.equal(picked?.id, "j-pay", "payment_settlement pool must preempt translation_batch");

  const leased = acquireQueueLease(picked!, "worker-a", now);
  assert.equal(leased.state, "leased");
  assert.doesNotThrow(() => assertValidFencedLease(leased, leased.leaseToken!, new Date(now.getTime() + 5000)));
  assert.throws(
    () => assertValidFencedLease(leased, "wrong-lease-token", now),
    (e: unknown) => e instanceof Problem && e.code === "STALE_QUEUE_LEASE",
  );

  assert.throws(
    () => recordQueueFailure(leased, "stale-token", "TIMEOUT", 0.5, now),
    (e: unknown) => e instanceof Problem && e.code === "STALE_QUEUE_LEASE",
  );
  // Permanent error immediately exhausts job into dead-letter rather than looping forever.
  const dead = recordQueueFailure(leased, leased.leaseToken!, "UNSUPPORTED_PAYLOAD", 0.5, now);
  assert.equal(dead.state, "exhausted");

  // External unknown_outcome cannot be blindly replayed until reconciled or explicitly approved.
  const unknown = markExternalUnknownOutcome(leased, leased.leaseToken!, "STRIPE_TIMEOUT_UNKNOWN", new Date(now.getTime() + 5000));
  assert.throws(
    () => resolveUnknownOutcomeJob(unknown, "still_unknown", false),
    (e: unknown) => e instanceof Problem && e.code === "UNKNOWN_OUTCOME_REQUIRES_RECONCILE",
  );
  assert.equal(resolveUnknownOutcomeJob(unknown, "confirmed_applied").state, "completed");
});
