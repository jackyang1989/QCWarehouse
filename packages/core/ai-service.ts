import { z } from "zod";
import { pool, transaction, type DB } from "../db";
import {
  assertAiAdapterRegistered,
  assertAiInvocationAuthorized,
  assertLanguageOnlyCapability,
  type AiAdapterType,
  type AiPurposeCode,
  AI_PURPOSE_CODES,
} from "./ai-contract";
import {
  assertSafeAiBaseUrl,
  executeStructuredTranslationCall,
  listAiProviderModels,
  probeAiConnection,
  type AiAdapterRequestConfig,
  type AiProtocolType,
} from "./ai-adapter";
import { requireStaffMfa } from "./auth";
import { audit, guard, hash, one, Problem, role, uuid, type Actor } from "./common";
import { seal, unseal } from "./crypto";
import { maskSecret } from "./integrations-admin";
import { assertEnabledLocale } from "./locale-contract";

export const AI_CONFIG_ROLES = ["super_admin"] as const;
export const AI_VIEW_ROLES = ["super_admin", "finance", "reviewer", "template_admin"] as const;
export const AI_FINANCE_ROLES = ["super_admin", "finance"] as const;

export const createAiInstanceSchema = z.object({
  instance_key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,62}$/),
  display_name: z.string().trim().min(2).max(120),
  adapter_type: z.enum(["openai_official", "openai_compatible"]),
  api_protocol: z.enum(["openai_responses", "openai_chat_completions"]).optional(),
  protocol_version: z.string().trim().min(1).max(32).default("v1"),
  environment: z.enum(["test", "production"]),
  base_url: z.string().trim().min(8).max(512),
  account_or_project_id: z.string().trim().max(128).nullable().optional(),
  data_region_policy: z.string().trim().min(2).max(128),
  retention_policy: z.string().trim().min(2).max(128).default("standard_api_terms"),
  training_opt_out_verified: z.boolean().default(false),
  allowed_purposes: z.array(z.enum(AI_PURPOSE_CODES)).min(1).max(AI_PURPOSE_CODES.length),
  requested_capabilities: z.array(z.string().trim().min(1)).default(["language_translation_only"]),
  timeout_ms: z.number().int().min(1000).max(120000).default(15000),
  max_retries: z.number().int().min(0).max(5).default(1),
  rate_limit_rpm: z.number().int().min(1).max(10000).default(60),
  max_concurrency: z.number().int().min(1).max(100).default(4),
  daily_budget_cents: z.number().int().min(0).max(100000000).default(1000),
  monthly_budget_cents: z.number().int().min(0).max(1000000000).default(10000),
  warn_threshold_pct: z.number().int().min(1).max(100).default(80),
});

export const updateAiInstanceSchema = createAiInstanceSchema
  .omit({ instance_key: true, adapter_type: true, environment: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one updatable field is required." });

export const saveAiSecretSchema = z.object({
  secret_name: z.enum(["api_key", "organization_header", "project_header"]).default("api_key"),
  secret_value: z.string().trim().min(6).max(512),
});

export const revokeAiSecretSchema = z.object({
  secret_name: z.enum(["api_key", "organization_header", "project_header"]).default("api_key"),
  reason: z.string().trim().min(2).max(240).optional(),
});

export const manualAiModelSchema = z.object({
  requested_model_id: z.string().trim().min(1).max(160),
  supports_text: z.boolean().default(true),
  supports_structured_output: z.boolean().default(false),
  supports_json_object: z.boolean().default(true),
  supported_locales: z.array(z.string().trim().min(2)).min(1).default(["en-US", "zh-CN"]),
  max_input_tokens: z.number().int().min(128).max(1000000).default(8192),
  max_output_tokens: z.number().int().min(64).max(128000).default(2048),
  allowed_params: z.record(z.string(), z.unknown()).default({}),
});

export const appendAiRateSchema = z.object({
  currency: z.string().trim().length(3).default("USD"),
  input_micros_per_1k_tokens: z.number().int().min(0).nullable(),
  output_micros_per_1k_tokens: z.number().int().min(0).nullable(),
  cached_input_micros_per_1k_tokens: z.number().int().min(0).nullable().optional(),
  unknown_rate_fallback_cap_cents: z.number().int().min(0).nullable().optional(),
  rate_source: z.enum(["official_schedule", "contract_rate", "manual_unverified", "unknown"]),
  effective_from: z.string().datetime().optional(),
});

export const upsertBudgetPolicySchema = z.object({
  scope_type: z.enum(["global", "instance", "purpose"]),
  scope_key: z.string().trim().min(1).max(120),
  period_type: z.enum(["daily", "monthly"]),
  hard_limit_cents: z.number().int().min(0).max(1000000000),
  warn_threshold_pct: z.number().int().min(1).max(100).default(80),
  max_single_call_cents: z.number().int().min(0).max(10000000).nullable().optional(),
  approved: z.boolean().default(true),
});

export const syntheticTestSchema = z.object({
  target_locale: z.string().trim().min(2).max(24).default("zh-CN"),
  purpose_code: z.enum(AI_PURPOSE_CODES).default("KNOWLEDGE_TRANSLATION_DRAFT"),
  max_output_tokens: z.number().int().min(64).max(4096).optional(),
  source_text: z.string().trim().min(4).max(800).optional(),
});

export const reconciliationSchema = z.object({
  invocation_id: z.uuid().nullable().optional(),
  instance_id: z.uuid(),
  billing_period: z.string().trim().min(4).max(32),
  provider_invoice_ref: z.string().trim().min(2).max(128).nullable().optional(),
  billed_cents: z.number().int().min(0),
  currency: z.string().trim().length(3).default("USD"),
  fx_rate_to_usd: z.number().positive().max(1000).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type AiInstanceRow = {
  id: string;
  instance_key: string;
  display_name: string;
  adapter_type: AiAdapterType;
  api_protocol: AiProtocolType;
  protocol_version: string;
  environment: "test" | "production";
  base_url: string;
  account_or_project_id: string | null;
  data_region_policy: string;
  retention_policy: string;
  training_opt_out_verified: boolean;
  allowed_purposes: string[];
  requested_capabilities: string[];
  status: "draft" | "tested" | "approved" | "disabled" | "archived";
  timeout_ms: number;
  max_retries: number;
  rate_limit_rpm: number;
  max_concurrency: number;
  daily_budget_cents: number;
  monthly_budget_cents: number;
  warn_threshold_pct: number;
  last_health_status: string;
  last_probe_at: string | null;
  last_probe_summary: string | null;
  last_probe_error_code: string | null;
  last_probe_detail: Record<string, unknown>;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type AiRateRow = {
  id: string;
  model_id: string;
  version: number;
  currency: string;
  input_micros_per_1k_tokens: string | null;
  output_micros_per_1k_tokens: string | null;
  cached_input_micros_per_1k_tokens: string | null;
  unknown_rate_fallback_cap_cents: number | null;
  rate_source: "official_schedule" | "contract_rate" | "manual_unverified" | "unknown";
  approved_by: string | null;
};

function sanitizeForSecretStrings(val: unknown): string {
  const s = typeof val === "string" ? val : JSON.stringify(val ?? {});
  return s.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "***REDACTED***");
}

function resolveProtocol(adapterType: AiAdapterType, requested?: AiProtocolType): AiProtocolType {
  const proto: AiProtocolType = requested ?? (adapterType === "openai_official" ? "openai_responses" : "openai_chat_completions");
  if (adapterType === "openai_compatible" && proto === "openai_responses") {
    throw new Problem(
      "AI_PROTOCOL_UNSUPPORTED",
      "OpenAI Compatible adapters must use 'openai_chat_completions' rather than assuming OpenAI Responses API.",
      422,
    );
  }
  return proto;
}

export function estimateCallMaxCents(params: {
  rate: AiRateRow | null | undefined;
  maxInputTokens: number;
  maxOutputTokens: number;
  environment: "test" | "production";
}): number {
  const { rate, maxInputTokens, maxOutputTokens, environment } = params;
  if (
    rate &&
    rate.rate_source !== "unknown" &&
    rate.input_micros_per_1k_tokens !== null &&
    rate.output_micros_per_1k_tokens !== null
  ) {
    const inMicros = (maxInputTokens * Number(rate.input_micros_per_1k_tokens)) / 1000;
    const outMicros = (maxOutputTokens * Number(rate.output_micros_per_1k_tokens)) / 1000;
    return Math.max(1, Math.ceil((inMicros + outMicros) / 10000));
  }
  if (environment === "production") {
    if (rate?.unknown_rate_fallback_cap_cents !== null && rate?.unknown_rate_fallback_cap_cents !== undefined && rate.approved_by) {
      return rate.unknown_rate_fallback_cap_cents;
    }
    throw new Problem(
      "AI_RATE_UNCONFIGURED_FOR_PRODUCTION",
      "Production AI calls require an approved model rate version (or approved safe fallback cap).",
      409,
    );
  }
  return rate?.unknown_rate_fallback_cap_cents ?? 5;
}

export function computeActualCostFromUsage(params: {
  rate: AiRateRow | null | undefined;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  usageSource: "provider_reported" | "local_estimate" | "cache_zero" | "unknown";
}): { costCents: number | null; costStatus: "estimated" | "cache_zero" | "unknown_pending"; currency: string } {
  const currency = params.rate?.currency ?? "USD";
  if (params.usageSource === "cache_zero") {
    return { costCents: 0, costStatus: "cache_zero", currency };
  }
  if (
    params.usageSource === "unknown" ||
    params.inputTokens === null ||
    params.outputTokens === null ||
    !params.rate ||
    params.rate.rate_source === "unknown" ||
    params.rate.input_micros_per_1k_tokens === null ||
    params.rate.output_micros_per_1k_tokens === null
  ) {
    return { costCents: null, costStatus: "unknown_pending", currency };
  }
  const cached = Math.min(params.inputTokens, Math.max(0, params.cachedInputTokens ?? 0));
  const uncachedInput = Math.max(0, params.inputTokens - cached);
  const cachedRate = Number(params.rate.cached_input_micros_per_1k_tokens ?? params.rate.input_micros_per_1k_tokens);
  const totalMicros =
    (uncachedInput * Number(params.rate.input_micros_per_1k_tokens)) / 1000 +
    (cached * cachedRate) / 1000 +
    (params.outputTokens * Number(params.rate.output_micros_per_1k_tokens)) / 1000;
  return {
    costCents: Math.max(0, Math.ceil(totalMicros / 10000)),
    costStatus: "estimated",
    currency,
  };
}

async function loadActiveSecretsForInstance(
  db: Pick<DB, "query">,
  instanceId: string,
): Promise<{ apiKey: string | null; organizationHeader: string | null; projectHeader: string | null }> {
  const rows = (
    await db.query<{ secret_name: string; encrypted_value: Buffer }>(
      "select secret_name, encrypted_value from ai_provider_secrets where instance_id = $1 and status = 'active'",
      [instanceId],
    )
  ).rows;
  let apiKey: string | null = null;
  let organizationHeader: string | null = null;
  let projectHeader: string | null = null;
  for (const r of rows) {
    const plain = unseal(r.encrypted_value);
    if (r.secret_name === "api_key") apiKey = plain;
    else if (r.secret_name === "organization_header") organizationHeader = plain;
    else if (r.secret_name === "project_header") projectHeader = plain;
  }
  return { apiKey, organizationHeader, projectHeader };
}

export async function createAiProviderInstance(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  const input = createAiInstanceSchema.parse(rawBody);
  const adapterType = assertAiAdapterRegistered(input.adapter_type);
  assertLanguageOnlyCapability(input.requested_capabilities);
  const protocol = resolveProtocol(adapterType, input.api_protocol);
  const parsedUrl = assertSafeAiBaseUrl(input.base_url, adapterType);

  const dup = await db.query("select 1 from ai_provider_instances where instance_key = $1", [input.instance_key]);
  guard(dup.rowCount === 0, "RECORD_CONFLICT", `AI instance '${input.instance_key}' already exists.`, 409);

  const row = await one<AiInstanceRow>(
    db,
    `insert into ai_provider_instances (
       id, instance_key, display_name, adapter_type, api_protocol, protocol_version,
       environment, base_url, account_or_project_id, data_region_policy, retention_policy,
       training_opt_out_verified, allowed_purposes, requested_capabilities, status,
       timeout_ms, max_retries, rate_limit_rpm, max_concurrency,
       daily_budget_cents, monthly_budget_cents, warn_threshold_pct,
       last_health_status, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16,$17,$18,$19,$20,$21,'unconfigured',$22)
     returning *`,
    [
      uuid(),
      input.instance_key,
      input.display_name,
      adapterType,
      protocol,
      input.protocol_version,
      input.environment,
      parsedUrl.toString().replace(/\/+$/, ""),
      input.account_or_project_id ?? null,
      input.data_region_policy,
      input.retention_policy,
      input.training_opt_out_verified,
      input.allowed_purposes,
      ["language_translation_only"],
      input.timeout_ms,
      input.max_retries,
      input.rate_limit_rpm,
      input.max_concurrency,
      input.daily_budget_cents,
      input.monthly_budget_cents,
      input.warn_threshold_pct,
      actor.id,
    ],
  );

  await audit(db, actor, "ai_instance_created", "ai_provider_instances", row.id, {
    instance_key: row.instance_key,
    adapter_type: row.adapter_type,
    environment: row.environment,
  });
  return { instance: row };
}

export async function updateAiProviderInstance(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = updateAiInstanceSchema.parse(rawBody);
  const existing = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1 for update",
    [instanceId],
  );
  guard(existing.status !== "archived", "RECORD_CONFLICT", "Archived AI instance cannot be modified.", 409);

  if (input.requested_capabilities) {
    assertLanguageOnlyCapability(input.requested_capabilities);
  }
  const nextProto = input.api_protocol ? resolveProtocol(existing.adapter_type, input.api_protocol) : existing.api_protocol;
  const nextBaseUrl = input.base_url
    ? assertSafeAiBaseUrl(input.base_url, existing.adapter_type).toString().replace(/\/+$/, "")
    : existing.base_url;

  // §53.7: Changing endpoint or protocol requires re-verification and re-approval.
  const connectionSensitiveChanged =
    (input.base_url && nextBaseUrl !== existing.base_url) ||
    (input.api_protocol && nextProto !== existing.api_protocol);

  const updated = await one<AiInstanceRow>(
    db,
    `update ai_provider_instances
     set display_name = coalesce($2, display_name),
         api_protocol = $3,
         protocol_version = coalesce($4, protocol_version),
         base_url = $5,
         account_or_project_id = case when $6 then $7 else account_or_project_id end,
         data_region_policy = coalesce($8, data_region_policy),
         retention_policy = coalesce($9, retention_policy),
         training_opt_out_verified = coalesce($10, training_opt_out_verified),
         allowed_purposes = coalesce($11, allowed_purposes),
         timeout_ms = coalesce($12, timeout_ms),
         max_retries = coalesce($13, max_retries),
         rate_limit_rpm = coalesce($14, rate_limit_rpm),
         max_concurrency = coalesce($15, max_concurrency),
         daily_budget_cents = coalesce($16, daily_budget_cents),
         monthly_budget_cents = coalesce($17, monthly_budget_cents),
         warn_threshold_pct = coalesce($18, warn_threshold_pct),
         status = case when $19 and status in ('tested', 'approved') then 'draft' else status end,
         last_health_status = case when $19 then 'unknown' else last_health_status end,
         updated_at = now()
     where id = $1
     returning *`,
    [
      existing.id,
      input.display_name ?? null,
      nextProto,
      input.protocol_version ?? null,
      nextBaseUrl,
      input.account_or_project_id !== undefined,
      input.account_or_project_id ?? null,
      input.data_region_policy ?? null,
      input.retention_policy ?? null,
      input.training_opt_out_verified ?? null,
      input.allowed_purposes ?? null,
      input.timeout_ms ?? null,
      input.max_retries ?? null,
      input.rate_limit_rpm ?? null,
      input.max_concurrency ?? null,
      input.daily_budget_cents ?? null,
      input.monthly_budget_cents ?? null,
      input.warn_threshold_pct ?? null,
      Boolean(connectionSensitiveChanged),
    ],
  );

  await audit(db, actor, "ai_instance_updated", "ai_provider_instances", updated.id, {
    connection_reverification_required: Boolean(connectionSensitiveChanged),
  });
  return { instance: updated };
}

export async function saveAiInstanceSecret(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = saveAiSecretSchema.parse(rawBody);
  const inst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1 for update",
    [instanceId],
  );
  guard(inst.status !== "archived", "RECORD_CONFLICT", "Cannot store secrets on an archived AI instance.", 409);

  const maxVerRow = (
    await db.query<{ max_ver: number }>(
      "select coalesce(max(version), 0)::int as max_ver from ai_provider_secrets where instance_id = $1 and secret_name = $2",
      [inst.id, input.secret_name],
    )
  ).rows[0];
  const nextVer = (maxVerRow?.max_ver ?? 0) + 1;

  await db.query(
    "update ai_provider_secrets set status = 'superseded' where instance_id = $1 and secret_name = $2 and status = 'active'",
    [inst.id, input.secret_name],
  );

  const sealed = seal(input.secret_value);
  const preview = maskSecret(input.secret_value);
  const fp = hash(input.secret_value);

  const inserted = await one<{
    id: string;
    instance_id: string;
    secret_name: string;
    version: number;
    masked_preview: string;
    fingerprint_sha256: string;
    status: string;
    created_at: string;
  }>(
    db,
    `insert into ai_provider_secrets (
       id, instance_id, secret_name, version, encrypted_value, masked_preview, fingerprint_sha256, status, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,'active',$8)
     returning id, instance_id, secret_name, version, masked_preview, fingerprint_sha256, status, created_at`,
    [uuid(), inst.id, input.secret_name, nextVer, sealed, preview, fp, actor.id],
  );

  if (input.secret_name === "api_key") {
    await db.query(
      `update ai_provider_instances
       set last_health_status = 'unknown',
           status = case when status in ('tested', 'approved') then 'draft' else status end,
           updated_at = now()
       where id = $1`,
      [inst.id],
    );
  }

  await audit(db, actor, "ai_instance_secret_saved", "ai_provider_secrets", inserted.id, {
    instance_id: inst.id,
    secret_name: input.secret_name,
    version: nextVer,
    masked_preview: preview,
  });
  return { secret: inserted };
}

export async function revokeAiInstanceSecret(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = revokeAiSecretSchema.parse(rawBody);
  const inst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1 for update",
    [instanceId],
  );

  const res = await db.query(
    `update ai_provider_secrets
     set status = 'revoked', revoked_by = $3, revoked_at = now()
     where instance_id = $1 and secret_name = $2 and status = 'active'`,
    [inst.id, input.secret_name, actor.id],
  );

  if (input.secret_name === "api_key") {
    await db.query(
      `update ai_provider_instances
       set last_health_status = 'unconfigured',
           status = case when status in ('tested', 'approved') then 'draft' else status end,
           updated_at = now()
       where id = $1`,
      [inst.id],
    );
  }

  await audit(db, actor, "ai_instance_secret_revoked", "ai_provider_instances", inst.id, {
    secret_name: input.secret_name,
    revoked_count: res.rowCount ?? 0,
    reason: input.reason ?? null,
  });
  return { revoked_count: res.rowCount ?? 0 };
}

export async function probeAiProviderInstance(
  actor: Actor,
  instanceId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  const { instance, reqCfg } = await transaction(async (db) => {
    const inst = await one<AiInstanceRow>(
      db,
      "select * from ai_provider_instances where id = $1",
      [instanceId],
    );
    guard(inst.status !== "archived", "RECORD_CONFLICT", "Archived AI instance cannot be probed.", 409);
    const secrets = await loadActiveSecretsForInstance(db, inst.id);
    guard(
      Boolean(secrets.apiKey),
      "AI_SECRET_MISSING",
      "Configure an active API key secret before probing connection.",
      409,
    );
    const cfg: AiAdapterRequestConfig = {
      adapterType: inst.adapter_type,
      protocol: inst.api_protocol,
      baseUrl: inst.base_url,
      apiKey: secrets.apiKey!,
      organizationHeader: secrets.organizationHeader,
      projectHeader: secrets.projectHeader,
      timeoutMs: inst.timeout_ms,
    };
    return { instance: inst, reqCfg: cfg };
  });

  let probeResult: Awaited<ReturnType<typeof probeAiConnection>>;
  try {
    probeResult = await probeAiConnection(reqCfg);
  } catch (err) {
    const code = err instanceof Problem ? err.code : "AI_PROBE_FAILED";
    const msg = err instanceof Error ? err.message : "Probe rejected.";
    await transaction(async (db) => {
      await db.query(
        `update ai_provider_instances
         set last_health_status = 'error', last_probe_at = now(),
             last_probe_summary = $2, last_probe_error_code = $3,
             last_probe_detail = $4::jsonb, updated_at = now()
         where id = $1`,
        [instance.id, sanitizeForSecretStrings(msg), code, JSON.stringify({ rejected: true, error_code: code })],
      );
      await db.query(
        `insert into ai_invocations (
           id, attempt_key, instance_id, purpose_code, invocation_kind, environment,
           actor_user_id, cost_center, status, error_code, error_summary,
           usage_source, cost_cents, cost_status
         ) values ($1,$2,$3,'KNOWLEDGE_TRANSLATION_DRAFT','connection_probe',$4,$5,'operating_expense','failed',$6,$7,'unknown',null,'unknown_pending')`,
        [uuid(), `probe:${uuid()}`, instance.id, instance.environment, actor.id, code, sanitizeForSecretStrings(msg)],
      );
    });
    throw err;
  }

  const updated = await transaction(async (db) => {
    const nextStatusRow = await one<AiInstanceRow>(
      db,
      `update ai_provider_instances
       set last_health_status = $2,
           last_probe_at = now(),
           last_probe_summary = $3,
           last_probe_error_code = $4,
           last_probe_detail = $5::jsonb,
           status = case
             when $6 and status = 'draft' then 'tested'
             when not $6 and status in ('tested', 'approved') then 'draft'
             else status
           end,
           updated_at = now()
       where id = $1
       returning *`,
      [
        instance.id,
        probeResult.healthStatus,
        probeResult.summary,
        probeResult.errorCode,
        JSON.stringify({
          model_count: probeResult.modelCount,
          model_list_supported: probeResult.modelListSupported,
          latency_ms: probeResult.latencyMs,
        }),
        probeResult.ok,
      ],
    );

    await db.query(
      `insert into ai_invocations (
         id, attempt_key, instance_id, purpose_code, invocation_kind, environment,
         actor_user_id, cost_center, provider_request_id, status, error_code, error_summary,
         usage_source, cost_cents, cost_status, duration_ms
       ) values ($1,$2,$3,'KNOWLEDGE_TRANSLATION_DRAFT','connection_probe',$4,$5,'operating_expense',$6,$7,$8,$9,'unknown',0,'cache_zero',$10)`,
      [
        uuid(),
        `probe:${uuid()}`,
        instance.id,
        instance.environment,
        actor.id,
        probeResult.providerRequestId,
        probeResult.ok ? "succeeded" : "failed",
        probeResult.errorCode,
        probeResult.summary,
        probeResult.latencyMs,
      ],
    );

    await audit(db, actor, "ai_instance_probed", "ai_provider_instances", instance.id, {
      ok: probeResult.ok,
      health_status: probeResult.healthStatus,
      error_code: probeResult.errorCode,
    });
    return nextStatusRow;
  });

  return { instance: updated, probe: probeResult };
}

export async function syncAiProviderModels(actor: Actor, instanceId: string) {
  role(actor, ...AI_CONFIG_ROLES);
  const { inst, reqCfg } = await transaction(async (db) => {
    const i = await one<AiInstanceRow>(
      db,
      "select * from ai_provider_instances where id = $1",
      [instanceId],
    );
    const secrets = await loadActiveSecretsForInstance(db, i.id);
    guard(Boolean(secrets.apiKey), "AI_SECRET_MISSING", "Configure an active API key secret first.", 409);
    return {
      inst: i,
      reqCfg: {
        adapterType: i.adapter_type,
        protocol: i.api_protocol,
        baseUrl: i.base_url,
        apiKey: secrets.apiKey!,
        organizationHeader: secrets.organizationHeader,
        projectHeader: secrets.projectHeader,
        timeoutMs: i.timeout_ms,
      } satisfies AiAdapterRequestConfig,
    };
  });

  const listed = await listAiProviderModels(reqCfg);
  if (!listed.supported) {
    return {
      supported: false,
      error_code: listed.errorCode,
      inserted_count: 0,
      models: [],
    };
  }

  return transaction(async (db) => {
    let insertedCount = 0;
    const syncedModels: Record<string, unknown>[] = [];
    for (const m of listed.models) {
      const up = await one<Record<string, unknown>>(
        db,
        `insert into ai_models (
           id, instance_id, requested_model_id, observed_model_snapshot, source_discovery,
           supports_text, supports_structured_output, supports_json_object, created_by
         ) values ($1,$2,$3,$4,'provider_list',true,$5,true,$6)
         on conflict (instance_id, requested_model_id) do update
           set observed_model_snapshot = coalesce(excluded.observed_model_snapshot, ai_models.observed_model_snapshot),
               updated_at = now()
         returning *, (xmax = 0) as newly_inserted`,
        [
          uuid(),
          inst.id,
          m.id,
          m.id,
          inst.adapter_type === "openai_official",
          actor.id,
        ],
      );
      if (up.newly_inserted) insertedCount += 1;
      syncedModels.push(up);
    }
    await db.query(
      `insert into ai_invocations (
         id, attempt_key, instance_id, purpose_code, invocation_kind, environment,
         actor_user_id, cost_center, provider_request_id, status,
         usage_source, cost_cents, cost_status
       ) values ($1,$2,$3,'KNOWLEDGE_TRANSLATION_DRAFT','model_list',$4,$5,'operating_expense',$6,'succeeded','unknown',0,'cache_zero')`,
      [uuid(), `models:${uuid()}`, inst.id, inst.environment, actor.id, listed.providerRequestId],
    );
    await audit(db, actor, "ai_models_synced", "ai_provider_instances", inst.id, {
      total_returned: listed.models.length,
      inserted_count: insertedCount,
    });
    return {
      supported: true,
      error_code: null,
      inserted_count: insertedCount,
      models: syncedModels,
    };
  });
}

export async function registerAiModelManual(
  db: DB,
  actor: Actor,
  instanceId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  const input = manualAiModelSchema.parse(rawBody);
  const inst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1",
    [instanceId],
  );
  guard(inst.status !== "archived", "RECORD_CONFLICT", "Cannot register model on archived instance.", 409);

  for (const loc of input.supported_locales) {
    assertEnabledLocale(loc);
  }

  const dup = await db.query(
    "select 1 from ai_models where instance_id = $1 and requested_model_id = $2",
    [inst.id, input.requested_model_id],
  );
  guard(dup.rowCount === 0, "RECORD_CONFLICT", `Model '${input.requested_model_id}' already exists on this instance.`, 409);

  const model = await one(
    db,
    `insert into ai_models (
       id, instance_id, requested_model_id, source_discovery,
       supports_text, supports_structured_output, supports_json_object,
       supported_locales, max_input_tokens, max_output_tokens, allowed_params, created_by
     ) values ($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     returning *`,
    [
      uuid(),
      inst.id,
      input.requested_model_id,
      input.supports_text,
      input.supports_structured_output,
      input.supports_json_object,
      input.supported_locales,
      input.max_input_tokens,
      input.max_output_tokens,
      JSON.stringify(input.allowed_params),
      actor.id,
    ],
  );

  await audit(db, actor, "ai_model_registered_manual", "ai_models", model.id, {
    instance_id: inst.id,
    requested_model_id: input.requested_model_id,
  });
  return { model };
}

export async function appendAiModelRateVersion(
  db: DB,
  actor: Actor,
  sessionHash: string,
  modelId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = appendAiRateSchema.parse(rawBody);
  const model = await one<{ id: string; instance_id: string }>(
    db,
    "select id, instance_id from ai_models where id = $1 for update",
    [modelId],
  );

  const maxVer = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from ai_model_rate_versions where model_id = $1",
      [model.id],
    )
  ).rows[0]?.v ?? 0;

  const rate = await one(
    db,
    `insert into ai_model_rate_versions (
       id, model_id, version, currency, input_micros_per_1k_tokens,
       output_micros_per_1k_tokens, cached_input_micros_per_1k_tokens,
       unknown_rate_fallback_cap_cents, rate_source, effective_from,
       approved_by, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11,$12)
     returning *`,
    [
      uuid(),
      model.id,
      maxVer + 1,
      input.currency.toUpperCase(),
      input.input_micros_per_1k_tokens,
      input.output_micros_per_1k_tokens,
      input.cached_input_micros_per_1k_tokens ?? null,
      input.unknown_rate_fallback_cap_cents ?? null,
      input.rate_source,
      input.effective_from ?? null,
      actor.id,
      actor.id,
    ],
  );

  await audit(db, actor, "ai_model_rate_version_appended", "ai_model_rate_versions", rate.id, {
    model_id: model.id,
    version: maxVer + 1,
    rate_source: input.rate_source,
  });
  return { rate };
}

export async function approveAiProviderInstance(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const inst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1 for update",
    [instanceId],
  );
  guard(inst.status === "tested", "AI_INSTANCE_NOT_TESTED", "Instance must pass connection probe ('tested') before approval.", 409);
  guard(inst.created_by !== actor.id, "SOD_VIOLATION", "Separation of duties forbids approving an AI instance you created.", 403);
  const secrets = await loadActiveSecretsForInstance(db, inst.id);
  guard(Boolean(secrets.apiKey), "AI_SECRET_MISSING", "Active API key secret is required before approval.", 409);

  const updated = await one<AiInstanceRow>(
    db,
    `update ai_provider_instances
     set status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
     where id = $1
     returning *`,
    [inst.id, actor.id],
  );
  await audit(db, actor, "ai_instance_approved", "ai_provider_instances", inst.id, {
    instance_key: inst.instance_key,
    environment: inst.environment,
  });
  return { instance: updated };
}

export async function transitionAiInstanceLifecycle(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  targetStatus: "disabled" | "archived",
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const inst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1 for update",
    [instanceId],
  );
  guard(inst.status !== "archived", "RECORD_CONFLICT", "AI instance is already archived.", 409);

  const updated = await one<AiInstanceRow>(
    db,
    `update ai_provider_instances
     set status = $2,
         archived_at = case when $2 = 'archived' then coalesce(archived_at, now()) else archived_at end,
         updated_at = now()
     where id = $1
     returning *`,
    [inst.id, targetStatus],
  );
  await audit(db, actor, `ai_instance_${targetStatus}`, "ai_provider_instances", inst.id, {
    previous_status: inst.status,
  });
  return { instance: updated };
}

export async function approveAiModel(
  db: DB,
  actor: Actor,
  sessionHash: string,
  modelId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const model = await one<{
    id: string;
    instance_id: string;
    requested_model_id: string;
    last_test_status: string;
    created_by: string;
    deprecated: boolean;
  }>(db, "select * from ai_models where id = $1 for update", [modelId]);
  guard(!model.deprecated, "RECORD_CONFLICT", "Deprecated AI model cannot be approved.", 409);
  const parentInst = await one<{ status: string }>(
    db,
    "select status from ai_provider_instances where id = $1",
    [model.instance_id],
  );
  guard(
    parentInst.status === "tested" || parentInst.status === "approved",
    "AI_INSTANCE_NOT_ACTIVE",
    "Parent AI provider instance must be tested or approved before approving its model.",
    409,
  );
  guard(
    model.last_test_status === "passed",
    "AI_MODEL_NOT_VERIFIED",
    "Model must pass a real synthetic structured translation test before approval.",
    409,
  );
  guard(model.created_by !== actor.id, "SOD_VIOLATION", "Separation of duties forbids approving a model you registered.", 403);

  const updated = await one(
    db,
    `update ai_models
     set approved = true, enabled = true, approved_by = $2, approved_at = now(), updated_at = now()
     where id = $1
     returning *`,
    [model.id, actor.id],
  );
  await audit(db, actor, "ai_model_approved", "ai_models", model.id, {
    instance_id: model.instance_id,
    requested_model_id: model.requested_model_id,
  });
  return { model: updated };
}

export async function deprecateAiModel(
  db: DB,
  actor: Actor,
  sessionHash: string,
  modelId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const updated = await one(
    db,
    `update ai_models
     set deprecated = true, enabled = false, approved = false, updated_at = now()
     where id = $1
     returning *`,
    [modelId],
  );
  await audit(db, actor, "ai_model_deprecated", "ai_models", modelId, {});
  return { model: updated };
}

export async function upsertAiBudgetPolicy(
  db: DB,
  actor: Actor,
  sessionHash: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = upsertBudgetPolicySchema.parse(rawBody);
  const policy = await one(
    db,
    `insert into ai_budget_policies (
       id, scope_type, scope_key, period_type, hard_limit_cents,
       warn_threshold_pct, max_single_call_cents, approved, approved_by, updated_by, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     on conflict (scope_type, scope_key, period_type) do update
       set hard_limit_cents = excluded.hard_limit_cents,
           warn_threshold_pct = excluded.warn_threshold_pct,
           max_single_call_cents = excluded.max_single_call_cents,
           approved = excluded.approved,
           approved_by = excluded.approved_by,
           updated_by = excluded.updated_by,
           updated_at = now()
     returning *`,
    [
      uuid(),
      input.scope_type,
      input.scope_key,
      input.period_type,
      input.hard_limit_cents,
      input.warn_threshold_pct,
      input.max_single_call_cents ?? null,
      input.approved,
      input.approved ? actor.id : null,
      actor.id,
    ],
  );
  await audit(db, actor, "ai_budget_policy_upserted", "ai_budget_policies", policy.id, {
    scope_type: input.scope_type,
    scope_key: input.scope_key,
    period_type: input.period_type,
    hard_limit_cents: input.hard_limit_cents,
  });
  return { policy };
}

export async function reserveAiBudgetAtomic(
  db: DB,
  params: {
    reservationKey: string;
    instanceId: string;
    modelId: string;
    rateVersionId: string | null;
    purposeCode: AiPurposeCode;
    estimatedCents: number;
    actorUserId: string;
  },
) {
  guard(
    Number.isInteger(params.estimatedCents) && params.estimatedCents >= 0,
    "INVALID_BUDGET_AMOUNT",
    "Reservation must be a non-negative integer cent amount.",
    422,
  );

  // Strict fixed advisory lock ordering (global first, then instance) prevents concurrent races and deadlocks.
  await db.query("select pg_advisory_xact_lock(hashtext('ai_budget_global'))");
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`ai_budget_inst:${params.instanceId}`]);

  const inst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1 for share",
    [params.instanceId],
  );
  const nowRows = (
    await db.query<{ today_str: string; month_str: string }>(
      "select CURRENT_DATE::text as today_str, to_char(CURRENT_DATE, 'YYYY-MM') as month_str",
    )
  ).rows[0]!;

  const instUsage = (
    await db.query<{ day_used: number; month_used: number }>(
      `select
         coalesce(sum(case when period_day = CURRENT_DATE then case when status = 'settled' then coalesce(settled_cents, 0) when status in ('reserved', 'unknown_pending') then reserved_cents else 0 end else 0 end), 0)::int as day_used,
         coalesce(sum(case when status = 'settled' then coalesce(settled_cents, 0) when status in ('reserved', 'unknown_pending') then reserved_cents else 0 end), 0)::int as month_used
       from ai_budget_reservations
       where instance_id = $1 and period_month = $2`,
      [inst.id, nowRows.month_str],
    )
  ).rows[0]!;

  guard(
    instUsage.day_used + params.estimatedCents <= inst.daily_budget_cents,
    "AI_BUDGET_EXCEEDED",
    `Instance daily budget cap (${inst.daily_budget_cents}c) reached; use manual translation fallback.`,
    409,
  );
  guard(
    instUsage.month_used + params.estimatedCents <= inst.monthly_budget_cents,
    "AI_BUDGET_EXCEEDED",
    `Instance monthly budget cap (${inst.monthly_budget_cents}c) reached; use manual translation fallback.`,
    409,
  );

  const policies = (
    await db.query<{
      scope_type: "global" | "instance" | "purpose";
      scope_key: string;
      period_type: "daily" | "monthly";
      hard_limit_cents: number;
      max_single_call_cents: number | null;
    }>(
      `select scope_type, scope_key, period_type, hard_limit_cents, max_single_call_cents
       from ai_budget_policies
       where approved = true
         and (
           (scope_type = 'global' and scope_key = 'global')
           or (scope_type = 'instance' and scope_key = $1)
           or (scope_type = 'purpose' and scope_key = $2)
         )`,
      [inst.id, params.purposeCode],
    )
  ).rows;

  for (const pol of policies) {
    if (pol.max_single_call_cents !== null && params.estimatedCents > pol.max_single_call_cents) {
      throw new Problem(
        "AI_BUDGET_EXCEEDED",
        `Estimated call cost (${params.estimatedCents}c) exceeds max_single_call_cents (${pol.max_single_call_cents}c).`,
        409,
      );
    }
    const scopeUsageRow = (
      await db.query<{ used: number }>(
        `select coalesce(sum(case when status = 'settled' then coalesce(settled_cents, 0) when status in ('reserved', 'unknown_pending') then reserved_cents else 0 end), 0)::int as used
         from ai_budget_reservations
         where ($1 = 'global' or ($1 = 'instance' and instance_id = $2::uuid) or ($1 = 'purpose' and purpose_code = $3))
           and (($4 = 'daily' and period_day = CURRENT_DATE) or ($4 = 'monthly' and period_month = $5))`,
        [pol.scope_type, inst.id, params.purposeCode, pol.period_type, nowRows.month_str],
      )
    ).rows[0]!;
    guard(
      scopeUsageRow.used + params.estimatedCents <= pol.hard_limit_cents,
      "AI_BUDGET_EXCEEDED",
      `${pol.scope_type}/${pol.period_type} AI budget hard limit (${pol.hard_limit_cents}c) exceeded.`,
      409,
    );
  }

  const reservation = await one<{
    id: string;
    reserved_cents: number;
    status: string;
    period_day: string;
    period_month: string;
  }>(
    db,
    `insert into ai_budget_reservations (
       id, reservation_key, instance_id, model_id, rate_version_id,
       purpose_code, period_day, period_month, reserved_cents, status, created_by
     ) values ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,'reserved',$9)
     returning id, reserved_cents, status, period_day::text, period_month`,
    [
      uuid(),
      params.reservationKey,
      inst.id,
      params.modelId,
      params.rateVersionId,
      params.purposeCode,
      nowRows.month_str,
      params.estimatedCents,
      params.actorUserId,
    ],
  );
  return reservation;
}

export async function runSyntheticTranslationTest(
  actor: Actor,
  modelId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_CONFIG_ROLES);
  const input = syntheticTestSchema.parse(rawBody);
  const targetLocale = assertEnabledLocale(input.target_locale);
  const sampleText =
    input.source_text ??
    "Measure garment chest width 2.5 cm below armhole seam for sample {sample_code}; seam is not broken.";

  const attemptKey = `synthetic:${uuid()}`;
  const reservationKey = `res:${attemptKey}`;

  const prep = await transaction(async (db) => {
    const model = await one<{
      id: string;
      instance_id: string;
      requested_model_id: string;
      supports_structured_output: boolean;
      supports_json_object: boolean;
      max_output_tokens: number;
      deprecated: boolean;
    }>(db, "select * from ai_models where id = $1", [modelId]);
    guard(!model.deprecated, "RECORD_CONFLICT", "Deprecated model cannot be tested.", 409);

    const inst = await one<AiInstanceRow>(
      db,
      "select * from ai_provider_instances where id = $1",
      [model.instance_id],
    );
    guard(inst.status !== "archived" && inst.status !== "disabled", "AI_INSTANCE_NOT_ACTIVE", "Enable instance before running translation test.", 409);
    const secrets = await loadActiveSecretsForInstance(db, inst.id);
    guard(Boolean(secrets.apiKey), "AI_SECRET_MISSING", "Configure an active API key secret first.", 409);

    const rate = (
      await db.query<AiRateRow>(
        "select * from ai_model_rate_versions where model_id = $1 order by version desc limit 1",
        [model.id],
      )
    ).rows[0] ?? null;

    const maxOut = Math.min(model.max_output_tokens, input.max_output_tokens ?? 512);
    const estimatedCents = estimateCallMaxCents({
      rate,
      maxInputTokens: 600,
      maxOutputTokens: maxOut,
      environment: inst.environment,
    });

    const reservation = await reserveAiBudgetAtomic(db, {
      reservationKey,
      instanceId: inst.id,
      modelId: model.id,
      rateVersionId: rate?.id ?? null,
      purposeCode: input.purpose_code,
      estimatedCents,
      actorUserId: actor.id,
    });

    return {
      inst,
      model,
      rate,
      reservationId: reservation.id,
      maxOut,
      reqCfg: {
        adapterType: inst.adapter_type,
        protocol: inst.api_protocol,
        baseUrl: inst.base_url,
        apiKey: secrets.apiKey!,
        organizationHeader: secrets.organizationHeader,
        projectHeader: secrets.projectHeader,
        timeoutMs: inst.timeout_ms,
      } satisfies AiAdapterRequestConfig,
    };
  });

  let callResult: Awaited<ReturnType<typeof executeStructuredTranslationCall>>;
  try {
    callResult = await executeStructuredTranslationCall(prep.reqCfg, {
      requestedModelId: prep.model.requested_model_id,
      sourceLocale: "en-US",
      targetLocale,
      items: [{ field_id: "synthetic_1", source_text: sampleText, placeholders: ["sample_code"] }],
      maxInputChars: 1000,
      maxOutputTokens: prep.maxOut,
      supportsStructuredOutput: prep.model.supports_structured_output,
      supportsJsonObject: prep.model.supports_json_object,
    });
  } catch (err) {
    const code = err instanceof Problem ? err.code : "AI_TEST_ERROR";
    const msg = err instanceof Error ? err.message : "Test call failed.";
    await transaction(async (db) => {
      await db.query(
        "update ai_budget_reservations set status = 'released', settled_cents = 0, settled_at = now() where id = $1",
        [prep.reservationId],
      );
      await db.query(
        `insert into ai_invocations (
           id, attempt_key, reservation_id, instance_id, model_id, rate_version_id,
           purpose_code, invocation_kind, environment, actor_user_id, cost_center,
           source_locale, target_locale, status, error_code, error_summary,
           usage_source, cost_cents, cost_status
         ) values ($1,$2,$3,$4,$5,$6,$7,'synthetic_translation_test',$8,$9,'operating_expense','en-US',$10,'failed',$11,$12,'unknown',0,'cache_zero')`,
        [
          uuid(),
          attemptKey,
          prep.reservationId,
          prep.inst.id,
          prep.model.id,
          prep.rate?.id ?? null,
          input.purpose_code,
          prep.inst.environment,
          actor.id,
          targetLocale,
          code,
          sanitizeForSecretStrings(msg),
        ],
      );
    });
    throw err;
  }

  return transaction(async (db) => {
    const isUnknownTimeout = callResult.status === "timeout_unknown";
    const costInfo = isUnknownTimeout
      ? { costCents: null, costStatus: "unknown_pending" as const, currency: prep.rate?.currency ?? "USD" }
      : callResult.ok || callResult.inputTokens !== null
        ? computeActualCostFromUsage({
            rate: prep.rate,
            inputTokens: callResult.inputTokens,
            outputTokens: callResult.outputTokens,
            cachedInputTokens: callResult.cachedInputTokens,
            usageSource: callResult.usageSource,
          })
        : { costCents: 0, costStatus: "cache_zero" as const, currency: prep.rate?.currency ?? "USD" };

    if (isUnknownTimeout || (callResult.ok && costInfo.costStatus === "unknown_pending")) {
      await db.query(
        "update ai_budget_reservations set status = 'unknown_pending', settled_at = now() where id = $1",
        [prep.reservationId],
      );
    } else if (costInfo.costCents !== null && costInfo.costCents > 0) {
      await db.query(
        "update ai_budget_reservations set status = 'settled', settled_cents = $2, settled_at = now() where id = $1",
        [prep.reservationId, costInfo.costCents],
      );
    } else {
      await db.query(
        "update ai_budget_reservations set status = 'released', settled_cents = 0, settled_at = now() where id = $1",
        [prep.reservationId],
      );
    }

    const updatedModel = await one(
      db,
      `update ai_models
       set last_test_status = $2,
           last_verified_at = case when $3 then now() else last_verified_at end,
           observed_model_snapshot = coalesce($4, observed_model_snapshot),
           last_test_error_code = $5,
           last_test_detail = $6::jsonb,
           updated_at = now()
       where id = $1
       returning *`,
      [
        prep.model.id,
        callResult.ok ? "passed" : "failed",
        callResult.ok,
        callResult.observedModelSnapshot,
        callResult.errorCode,
        JSON.stringify({
          status: callResult.status,
          usage_source: callResult.usageSource,
          duration_ms: callResult.durationMs,
        }),
      ],
    );

    const inv = await one(
      db,
      `insert into ai_invocations (
         id, attempt_key, reservation_id, instance_id, model_id, rate_version_id,
         purpose_code, invocation_kind, environment, actor_user_id, cost_center,
         source_locale, target_locale, provider_request_id, observed_model_snapshot,
         status, error_code, error_summary, input_tokens, output_tokens, cached_input_tokens,
         usage_source, cost_cents, cost_status, currency, duration_ms
       ) values ($1,$2,$3,$4,$5,$6,$7,'synthetic_translation_test',$8,$9,'operating_expense','en-US',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       returning *`,
      [
        uuid(),
        attemptKey,
        prep.reservationId,
        prep.inst.id,
        prep.model.id,
        prep.rate?.id ?? null,
        input.purpose_code,
        prep.inst.environment,
        actor.id,
        targetLocale,
        callResult.providerRequestId,
        callResult.observedModelSnapshot,
        callResult.status,
        callResult.errorCode,
        callResult.errorSummary ? sanitizeForSecretStrings(callResult.errorSummary) : null,
        callResult.inputTokens,
        callResult.outputTokens,
        callResult.cachedInputTokens,
        callResult.usageSource,
        costInfo.costCents,
        costInfo.costStatus,
        costInfo.currency,
        callResult.durationMs,
      ],
    );

    await audit(db, actor, "ai_model_synthetic_tested", "ai_models", prep.model.id, {
      ok: callResult.ok,
      status: callResult.status,
      invocation_id: inv.id,
      cost_status: costInfo.costStatus,
    });

    return {
      ok: callResult.ok,
      model: updatedModel,
      invocation: inv,
      synthetic_output: callResult.items,
    };
  });
}

export async function recordAiCostReconciliation(
  db: DB,
  actor: Actor,
  sessionHash: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...AI_FINANCE_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = reconciliationSchema.parse(rawBody);
  await one(db, "select id from ai_provider_instances where id = $1", [input.instance_id]);
  let linkedReservationId: string | null = null;
  if (input.invocation_id) {
    const invRow = await one<{ id: string; reservation_id: string | null }>(
      db,
      "select id, reservation_id from ai_invocations where id = $1 and instance_id = $2 for update",
      [input.invocation_id, input.instance_id],
    );
    linkedReservationId = invRow.reservation_id;
  }

  const adj = await one(
    db,
    `insert into ai_cost_reconciliation_adjustments (
       id, invocation_id, instance_id, billing_period, provider_invoice_ref,
       billed_cents, currency, fx_rate_to_usd, notes, recorded_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning *`,
    [
      uuid(),
      input.invocation_id ?? null,
      input.instance_id,
      input.billing_period,
      input.provider_invoice_ref ?? null,
      input.billed_cents,
      input.currency.toUpperCase(),
      input.fx_rate_to_usd ?? null,
      input.notes ?? null,
      actor.id,
    ],
  );

  if (input.invocation_id) {
    await db.query(
      "update ai_invocations set cost_status = 'reconciled', cost_cents = coalesce(cost_cents, $2) where id = $1",
      [input.invocation_id, input.billed_cents],
    );
    if (linkedReservationId) {
      await db.query(
        "update ai_budget_reservations set status = 'settled', settled_cents = $2, settled_at = coalesce(settled_at, now()) where id = $1 and status = 'unknown_pending'",
        [linkedReservationId, input.billed_cents],
      );
    }
  }
  await audit(db, actor, "ai_cost_reconciled", "ai_cost_reconciliation_adjustments", adj.id, {
    instance_id: input.instance_id,
    billing_period: input.billing_period,
    billed_cents: input.billed_cents,
  });
  return { adjustment: adj };
}

export async function getAdminAiOverview(db: DB, actor: Actor) {
  role(actor, ...AI_VIEW_ROLES);

  const instances = (
    await db.query<AiInstanceRow & { active_secret_names: string[] }>(
      `select i.*,
              coalesce(
                (select array_agg(s.secret_name order by s.secret_name)
                 from ai_provider_secrets s
                 where s.instance_id = i.id and s.status = 'active'),
                ARRAY[]::text[]
              ) as active_secret_names
       from ai_provider_instances i
       order by i.environment desc, i.created_at desc`,
    )
  ).rows;

  const secretsSummary = (
    await db.query(
      `select id, instance_id, secret_name, version, masked_preview, fingerprint_sha256, status, created_at, revoked_at
       from ai_provider_secrets
       order by created_at desc`,
    )
  ).rows;

  const models = (
    await db.query(
      `select m.*,
              (select row_to_json(r) from (
                select id, version, currency, input_micros_per_1k_tokens, output_micros_per_1k_tokens,
                       cached_input_micros_per_1k_tokens, unknown_rate_fallback_cap_cents, rate_source, effective_from
                from ai_model_rate_versions
                where model_id = m.id
                order by version desc limit 1
              ) r) as latest_rate
       from ai_models m
       order by m.created_at desc`,
    )
  ).rows;

  const policies = (
    await db.query("select * from ai_budget_policies order by scope_type, scope_key, period_type")
  ).rows;

  const metrics = (
    await db.query<{
      total_calls: number;
      succeeded_calls: number;
      failed_calls: number;
      unknown_timeout_calls: number;
      cache_hits: number;
      estimated_cost_cents: number;
      reconciled_billed_cents: number;
      unknown_pending_count: number;
      unknown_reserved_cents: number;
    }>(
      `select
         (select count(*)::int from ai_invocations) as total_calls,
         (select count(*)::int from ai_invocations where status = 'succeeded') as succeeded_calls,
         (select count(*)::int from ai_invocations where status in ('failed','refused','truncated','invalid_output','budget_blocked')) as failed_calls,
         (select count(*)::int from ai_invocations where status = 'timeout_unknown') as unknown_timeout_calls,
         (select count(*)::int from ai_invocations where cache_hit = true) as cache_hits,
         coalesce((select sum(cost_cents) from ai_invocations where cost_cents is not null), 0)::int as estimated_cost_cents,
         coalesce((select sum(billed_cents) from ai_cost_reconciliation_adjustments), 0)::int as reconciled_billed_cents,
         (select count(*)::int from ai_invocations where cost_status = 'unknown_pending') as unknown_pending_count,
         coalesce((select sum(reserved_cents) from ai_budget_reservations where status in ('reserved', 'unknown_pending')), 0)::int as unknown_reserved_cents`,
    )
  ).rows[0]!;

  return {
    configured_ready_production: instances.some((i) => i.environment === "production" && i.status === "approved"),
    manual_fallback_available: true,
    no_customer_surcharge: true,
    sandbox_rule: "language_translation_only",
    instances,
    secrets: secretsSummary,
    models,
    budget_policies: policies,
    metrics,
  };
}

export async function listAiInvocations(
  db: DB,
  actor: Actor,
  filters: { instance_id?: string; purpose_code?: string; status?: string },
) {
  role(actor, ...AI_VIEW_ROLES);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.instance_id) {
    params.push(filters.instance_id);
    clauses.push(`instance_id = $${params.length}`);
  }
  if (filters.purpose_code) {
    params.push(filters.purpose_code);
    clauses.push(`purpose_code = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const invocations = (
    await db.query(
      `select id, attempt_key, logical_task_id, reservation_id, instance_id, model_id,
              rate_version_id, purpose_code, invocation_kind, environment, actor_user_id,
              entity_type, entity_id, cost_center, cost_attribution_id,
              source_locale, target_locale, provider_request_id, observed_model_snapshot,
              status, error_code, error_summary, cache_hit, used_fallback_route,
              input_tokens, output_tokens, cached_input_tokens, usage_source,
              cost_cents, cost_status, currency, duration_ms, created_at
       from ai_invocations
       ${where}
       order by created_at desc
       limit 200`,
      params,
    )
  ).rows;
  return { invocations };
}

export async function getAdminAiCostLedger(db: DB, actor: Actor) {
  role(actor, ...AI_VIEW_ROLES);
  const byCostCenter = (
    await db.query(
      `select cost_center,
              count(*)::int as call_count,
              coalesce(sum(cost_cents), 0)::int as known_estimated_cents,
              count(*) filter (where cost_status = 'unknown_pending')::int as unknown_pending_count
       from ai_invocations
       group by cost_center
       order by cost_center`,
    )
  ).rows;

  const byInstance = (
    await db.query(
      `select r.instance_id,
              i.instance_key,
              i.daily_budget_cents,
              i.monthly_budget_cents,
              coalesce(sum(case when r.period_day = CURRENT_DATE then case when r.status = 'settled' then coalesce(r.settled_cents,0) when r.status in ('reserved','unknown_pending') then r.reserved_cents else 0 end else 0 end), 0)::int as today_used_or_reserved_cents,
              coalesce(sum(case when r.period_month = to_char(CURRENT_DATE, 'YYYY-MM') then case when r.status = 'settled' then coalesce(r.settled_cents,0) when r.status in ('reserved','unknown_pending') then r.reserved_cents else 0 end else 0 end), 0)::int as month_used_or_reserved_cents
       from ai_provider_instances i
       left join ai_budget_reservations r on r.instance_id = i.id
       group by r.instance_id, i.id
       order by i.created_at desc`,
    )
  ).rows;

  const adjustments = (
    await db.query("select * from ai_cost_reconciliation_adjustments order by created_at desc limit 100")
  ).rows;

  return {
    no_customer_surcharge: true,
    by_cost_center: byCostCenter,
    by_instance: byInstance,
    adjustments,
    guard_export_reference: assertAiInvocationAuthorized.name,
  };
}
