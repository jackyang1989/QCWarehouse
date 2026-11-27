import type { Actor } from "./common";
import { guard, uuid } from "./common";
import { evaluateAuthorization, type AuthzAction, type StaffScopeContext } from "./authz-contract";
import { assertEnabledLocale, type EnabledLocale } from "./locale-contract";

export const AI_ADAPTER_TYPES = ["openai_official", "openai_compatible"] as const;
export type AiAdapterType = (typeof AI_ADAPTER_TYPES)[number];

export const AI_PURPOSE_CODES = [
  "SUPPORT_INBOUND_TRANSLATE",
  "SUPPORT_OUTBOUND_TRANSLATE",
  "INSPECTION_REQUIREMENT_TRANSLATE",
  "INSPECTION_FINDING_TRANSLATE",
  "REPORT_TEXT_LOCALIZE",
  "NOTIFICATION_TRANSLATE",
  "KNOWLEDGE_TRANSLATION_DRAFT",
  "CMS_TEMPLATE_TRANSLATION_DRAFT",
  "TRANSLATION_CONSISTENCY_REVIEW",
] as const;
export type AiPurposeCode = (typeof AI_PURPOSE_CODES)[number];

export const AI_OUTPUT_STATUSES = ["translated", "ambiguous", "needs_review"] as const;
export type AiOutputStatus = (typeof AI_OUTPUT_STATUSES)[number];

export const FORBIDDEN_AI_CAPABILITIES = [
  "business_db_write",
  "business_db_read",
  "payment_execute",
  "email_send",
  "file_write",
  "device_control",
  "arbitrary_network_fetch",
] as const;

export type AiProviderInstanceContract = {
  id: string;
  adapterType: AiAdapterType;
  environment: "test" | "production";
  baseUrl: string;
  status: "draft" | "tested" | "approved" | "disabled" | "archived";
  dataRegionPolicy: string;
  requestedCapabilities: readonly string[];
};

export type AiModelContract = {
  id: string;
  instanceId: string;
  modelId: string;
  supportsStructuredOutput: boolean;
  approved: boolean;
  deprecated: boolean;
};

export type AiPurposeRouteContract = {
  purpose: AiPurposeCode;
  autoEnabled: boolean;
  primaryInstanceId: string | null;
  primaryModelId: string | null;
  promptVersion: number;
  maxInputChars: number;
  requiresHumanConfirmation: boolean;
  approved: boolean;
};

export type AiTranslationItemInput = {
  field_id: string;
  source_text: string;
  placeholders: readonly string[];
};

export type AiTranslationItemOutput = {
  field_id: string;
  target_locale: string;
  translated_text: string;
  status: AiOutputStatus;
  warnings: readonly string[];
};

export type AiBudgetLedger = {
  instanceId: string;
  limitCents: number;
  reservedCents: number;
  spentCents: number;
};

/**
 * §53.7 strict sandbox: AI providers are language-only processors and NEVER hold business tool,
 * DB, payment, email, file, or device control permissions.
 */
export function assertLanguageOnlyCapability(requestedCapabilities: readonly string[]) {
  guard(
    requestedCapabilities.length > 0 && requestedCapabilities.includes("language_translation_only"),
    "AI_BUSINESS_TOOL_FORBIDDEN",
    "AI adapter must explicitly declare 'language_translation_only'.",
    403,
  );
  for (const cap of requestedCapabilities) {
    guard(
      !FORBIDDEN_AI_CAPABILITIES.includes(cap as (typeof FORBIDDEN_AI_CAPABILITIES)[number]) && cap === "language_translation_only",
      "AI_BUSINESS_TOOL_FORBIDDEN",
      `AI adapter requested forbidden non-language capability '${cap}'.`,
      403,
    );
  }
}

export function assertAiAdapterRegistered(adapterType: string): AiAdapterType {
  guard(
    AI_ADAPTER_TYPES.includes(adapterType as AiAdapterType),
    "UNKNOWN_AI_ADAPTER",
    `AI adapter type '${adapterType}' is not supported.`,
    422,
  );
  return adapterType as AiAdapterType;
}

export function assertAiInvocationAuthorized(params: {
  actor: Actor | null;
  action: Extract<AuthzAction, "ai.translate_field" | "ai.translate_batch" | "ai.configure" | "ai.review_publish">;
  scope: StaffScopeContext;
  instance: AiProviderInstanceContract;
  model: AiModelContract;
  route: AiPurposeRouteContract;
  environment: "test" | "production";
}) {
  evaluateAuthorization(params.actor, params.action, params.scope);
  assertAiAdapterRegistered(params.instance.adapterType);
  assertLanguageOnlyCapability(params.instance.requestedCapabilities);

  guard(
    params.instance.environment === params.environment && params.instance.status === "approved",
    "AI_INSTANCE_NOT_APPROVED",
    "Target AI provider instance is missing approval or environment match.",
    409,
  );
  guard(
    params.model.instanceId === params.instance.id && params.model.approved && !params.model.deprecated,
    "UNKNOWN_AI_MODEL",
    `Model '${params.model.modelId}' is unknown, unapproved, or deprecated for this instance.`,
    422,
  );
  guard(
    params.route.approved && params.route.primaryInstanceId === params.instance.id && params.route.primaryModelId === params.model.modelId,
    "AI_ROUTE_NOT_CONFIGURED",
    `Purpose route '${params.route.purpose}' is not approved for the selected instance/model.`,
    409,
  );
}

const SECRET_OR_PII_PATTERNS = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:\d[ -]*?){13,19}\b/,
];

/**
 * §53.4/§53.7 outbound minimization: forbid shipping raw secrets, card numbers, or unapproved PII.
 */
export function assertSafeOutboundAiPayload(text: string, maxChars: number) {
  guard(text.length <= maxChars, "AI_INPUT_TOO_LONG", `Input exceeds maxInputChars (${maxChars}).`, 422);
  for (const pat of SECRET_OR_PII_PATTERNS) {
    guard(
      !pat.test(text),
      "UNSAFE_OUTBOUND_AI_PAYLOAD",
      "Outbound AI payload appears to contain credentials or payment card material.",
      422,
    );
  }
}

/**
 * §53.8 strict structured output contract: 1-to-1 field cardinality, enabled BCP47 locale,
 * valid controlled status, and intact placeholders.
 */
export function validateAiTranslationOutput(
  expectedItems: readonly AiTranslationItemInput[],
  expectedTargetLocale: EnabledLocale,
  candidateOutputs: readonly AiTranslationItemOutput[],
): AiTranslationItemOutput[] {
  const expectedById = new Map(expectedItems.map((item) => [item.field_id, item]));
  guard(
    candidateOutputs.length === expectedItems.length,
    "AI_OUTPUT_CARDINALITY_MISMATCH",
    `Expected ${expectedItems.length} translated items, got ${candidateOutputs.length}.`,
    422,
  );
  const seen = new Set<string>();
  for (const out of candidateOutputs) {
    const src = expectedById.get(out.field_id);
    guard(src, "AI_OUTPUT_UNKNOWN_FIELD", `Unexpected field_id '${out.field_id}' in AI output.`, 422);
    guard(!seen.has(out.field_id), "AI_OUTPUT_DUPLICATE_FIELD", `Duplicate field_id '${out.field_id}' in AI output.`, 422);
    seen.add(out.field_id);

    const locale = assertEnabledLocale(out.target_locale);
    guard(locale === expectedTargetLocale, "AI_OUTPUT_LOCALE_MISMATCH", `Expected target_locale '${expectedTargetLocale}', got '${locale}'.`, 422);
    guard(AI_OUTPUT_STATUSES.includes(out.status), "AI_OUTPUT_INVALID_STATUS", `Invalid AI status '${out.status}'.`, 422);
    guard(typeof out.translated_text === "string" && out.translated_text.trim().length > 0, "AI_OUTPUT_EMPTY", "Translated text cannot be empty.", 422);

    const expectedPlaceholders = new Set(src.placeholders);
    for (const ph of expectedPlaceholders) {
      guard(
        out.translated_text.includes(`{${ph}}`),
        "AI_OUTPUT_PLACEHOLDER_BROKEN",
        `Placeholder '{${ph}}' was dropped or altered for '${out.field_id}'.`,
        422,
      );
    }
    for (const match of out.translated_text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
      const found = match[1]!;
      guard(
        expectedPlaceholders.has(found),
        "AI_OUTPUT_PLACEHOLDER_BROKEN",
        `Unexpected extra placeholder '{${found}}' hallucinated for '${out.field_id}'.`,
        422,
      );
    }
  }
  return [...candidateOutputs];
}

export function reserveAiBudget(ledger: AiBudgetLedger, estimatedCents: number): AiBudgetLedger {
  guard(Number.isInteger(estimatedCents) && estimatedCents >= 0, "INVALID_BUDGET_AMOUNT", "Reservation must be non-negative integer cents.", 422);
  const remaining = ledger.limitCents - (ledger.reservedCents + ledger.spentCents);
  guard(estimatedCents <= remaining, "AI_BUDGET_EXCEEDED", "AI instance budget limit reached; fall back to manual translation.", 409);
  return { ...ledger, reservedCents: ledger.reservedCents + estimatedCents };
}

export function createManualTranslationFallback(params: {
  fieldId: string;
  targetLocale: string;
  manualText: string;
  authorId: string;
}) {
  const locale = assertEnabledLocale(params.targetLocale);
  guard(params.manualText.trim().length > 0, "INVALID_REQUEST", "Manual translation text is required.", 422);
  return {
    fallbackId: uuid(),
    field_id: params.fieldId,
    target_locale: locale,
    translated_text: params.manualText,
    source: "human" as const,
    model_used: null,
    cost_cents: 0,
    author_id: params.authorId,
  };
}
