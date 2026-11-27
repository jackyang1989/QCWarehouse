import { z } from "zod";
import { pool, transaction, type DB } from "../db";
import {
  AI_PURPOSE_CODES,
  assertSafeOutboundAiPayload,
  type AiPurposeCode,
} from "./ai-contract";
import { executeStructuredTranslationCall, type AiAdapterRequestConfig } from "./ai-adapter";
import {
  assertSafePromptTemplate,
  buildImmutableSystemPrompt,
  DEFAULT_APPAREL_EVAL_CASES,
  DEFAULT_PURPOSE_PROMPTS,
  requireZeroProtectedFactErrors,
  verifySemanticFactIntegrity,
} from "./ai-semantic-guard";
import {
  AI_CONFIG_ROLES,
  AI_VIEW_ROLES,
  computeActualCostFromUsage,
  estimateCallMaxCents,
  loadActiveSecretsForInstance,
  reserveAiBudgetAtomic,
  type AiInstanceRow,
  type AiRateRow,
} from "./ai-service";
import { requireStaffMfa } from "./auth";
import { audit, guard, hash, one, Problem, role, uuid, type Actor } from "./common";
import { assertEnabledLocale } from "./locale-contract";

export const createPromptDraftSchema = z.object({
  purpose_code: z.enum(AI_PURPOSE_CODES),
  title: z.string().trim().min(2).max(160),
  semantic_guidance: z.string().trim().min(10).max(6000),
  output_schema_version: z.string().trim().min(1).max(32).default("v1"),
  allowed_variables: z.array(z.string().trim().min(1).max(64)).default([]),
});

export const createGlossaryTermSchema = z.object({
  domain: z.string().trim().min(2).max(64).default("apparel_qc"),
  term_key: z.string().trim().min(1).max(120),
  category_slug: z.string().trim().max(64).nullable().optional(),
  context_note: z.string().trim().max(300).nullable().optional(),
  source_locale: z.string().trim().min(2).max(24),
  source_term: z.string().trim().min(1).max(400),
  target_locale: z.string().trim().min(2).max(24),
  target_term: z.string().trim().min(1).max(400),
  disallowed_translations: z.array(z.string().trim().min(1).max(200)).default([]),
  author_kind: z.enum(["human", "ai_draft"]).default("human"),
});

export const createPurposeRouteSchema = z.object({
  purpose_code: z.enum(AI_PURPOSE_CODES),
  auto_enabled: z.boolean().default(true),
  allowed_source_locales: z.array(z.string().trim().min(2)).min(1).default(["en-US", "zh-CN"]),
  allowed_target_locales: z.array(z.string().trim().min(2)).min(1).default(["en-US", "zh-CN"]),
  primary_instance_id: z.uuid(),
  primary_model_id: z.uuid(),
  fallback_instance_id: z.uuid().nullable().optional(),
  fallback_model_id: z.uuid().nullable().optional(),
  prompt_version_id: z.uuid(),
  glossary_domain: z.string().trim().min(2).max(64).default("apparel_qc"),
  max_input_chars: z.number().int().min(64).max(50000).default(4000),
  max_output_tokens: z.number().int().min(64).max(32000).default(1500),
  timeout_ms: z.number().int().min(1000).max(120000).default(15000),
  max_retries: z.number().int().min(0).max(5).default(1),
  requires_human_confirmation: z.boolean().default(false),
  high_risk_purpose: z.boolean().default(false),
});

export const enqueueTranslationJobSchema = z.object({
  idempotency_key: z.string().trim().min(6).max(200),
  purpose_code: z.enum(AI_PURPOSE_CODES),
  tenant_scope_key: z.string().trim().min(3).max(160).optional(),
  entity_type: z.string().trim().min(2).max(64),
  entity_id: z.uuid(),
  source_locale: z.string().trim().min(2).max(24),
  target_locale: z.string().trim().min(2).max(24),
  cost_center: z.enum(["order", "report", "ticket", "notification", "operating_expense"]).default("operating_expense"),
  cost_attribution_id: z.uuid().nullable().optional(),
  items: z
    .array(
      z.object({
        field_id: z.string().trim().min(1).max(120),
        source_revision: z.number().int().min(1).default(1),
        source_text: z.string().trim().min(1).max(15000),
        placeholders: z.array(z.string().trim().min(1).max(64)).default([]),
        expected_target_revision: z.number().int().min(1).nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const runEvalSuiteSchema = z.object({
  purpose_code: z.enum(AI_PURPOSE_CODES),
  route_version_id: z.uuid().optional(),
  candidates_by_case_code: z.record(z.string(), z.string()),
});

export const reviewEvalHumanQaSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().trim().min(2).max(1000),
});

export const retryTranslationJobSchema = z.object({
  confirm_unknown_retry: z.boolean().default(false),
});

const MANDATORY_CONFIRMATION_PURPOSES = new Set<AiPurposeCode>([
  "INSPECTION_REQUIREMENT_TRANSLATE",
  "REPORT_TEXT_LOCALIZE",
]);

function computePromptContentHash(params: {
  purpose_code: string;
  semantic_guidance: string;
  output_schema_version: string;
  allowed_variables: readonly string[];
}): string {
  return hash(
    JSON.stringify({
      purpose_code: params.purpose_code,
      semantic_guidance: params.semantic_guidance,
      output_schema_version: params.output_schema_version,
      allowed_variables: [...params.allowed_variables],
    }),
  );
}

export async function seedDefaultAiPrompts(db: DB, actor: Actor) {
  role(actor, ...AI_CONFIG_ROLES);
  let created = 0;
  for (const p of DEFAULT_PURPOSE_PROMPTS) {
    assertSafePromptTemplate(p.semantic_guidance);
    const contentHash = computePromptContentHash({
      purpose_code: p.purpose_code,
      semantic_guidance: p.semantic_guidance,
      output_schema_version: "v1",
      allowed_variables: p.allowed_variables,
    });
    const res = await db.query(
      `insert into ai_prompt_versions (
         id, purpose_code, version, title, semantic_guidance, output_schema_version,
         allowed_variables, status, content_hash, created_by
       ) values ($1,$2,1,$3,$4,'v1',$5,'draft',$6,$7)
       on conflict (purpose_code, version) do nothing`,
      [uuid(), p.purpose_code, p.title, p.semantic_guidance, p.allowed_variables, contentHash, actor.id],
    );
    created += res.rowCount ?? 0;
  }
  await audit(db, actor, "ai_prompts_seeded", "ai_prompt_versions", null, { created_count: created });
  return { seeded_count: created };
}

export async function createPromptDraft(db: DB, actor: Actor, rawBody: Record<string, unknown>) {
  role(actor, ...AI_CONFIG_ROLES);
  const input = createPromptDraftSchema.parse(rawBody);
  assertSafePromptTemplate(input.semantic_guidance);

  const maxVer = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from ai_prompt_versions where purpose_code = $1",
      [input.purpose_code],
    )
  ).rows[0]?.v ?? 0;

  const contentHash = computePromptContentHash({
    purpose_code: input.purpose_code,
    semantic_guidance: input.semantic_guidance,
    output_schema_version: input.output_schema_version,
    allowed_variables: input.allowed_variables,
  });

  const prompt = await one(
    db,
    `insert into ai_prompt_versions (
       id, purpose_code, version, title, semantic_guidance, output_schema_version,
       allowed_variables, status, content_hash, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9)
     returning *`,
    [
      uuid(),
      input.purpose_code,
      maxVer + 1,
      input.title,
      input.semantic_guidance,
      input.output_schema_version,
      input.allowed_variables,
      contentHash,
      actor.id,
    ],
  );
  await audit(db, actor, "ai_prompt_draft_created", "ai_prompt_versions", prompt.id, {
    purpose_code: input.purpose_code,
    version: maxVer + 1,
  });
  return { prompt };
}

export async function publishPromptVersion(
  db: DB,
  actor: Actor,
  sessionHash: string,
  promptId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const target = await one<{
    id: string;
    purpose_code: string;
    version: number;
    semantic_guidance: string;
    status: string;
    created_by: string;
  }>(db, "select * from ai_prompt_versions where id = $1 for update", [promptId]);
  guard(target.status === "draft", "RECORD_CONFLICT", "Only draft prompt versions can be published.", 409);
  guard(
    target.created_by !== actor.id,
    "SOD_VIOLATION",
    "Separation of duties forbids publishing a prompt draft you created.",
    403,
  );
  assertSafePromptTemplate(target.semantic_guidance);

  await db.query(
    "update ai_prompt_versions set status = 'deprecated' where purpose_code = $1 and status = 'published'",
    [target.purpose_code],
  );
  const published = await one(
    db,
    `update ai_prompt_versions
     set status = 'published', approved_by = $2, published_at = now()
     where id = $1
     returning *`,
    [target.id, actor.id],
  );
  await audit(db, actor, "ai_prompt_published", "ai_prompt_versions", target.id, {
    purpose_code: target.purpose_code,
    version: target.version,
  });
  return { prompt: published };
}

export async function rollbackPromptVersion(
  db: DB,
  actor: Actor,
  sessionHash: string,
  targetPromptId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const historical = await one<{
    id: string;
    purpose_code: AiPurposeCode;
    version: number;
    title: string;
    semantic_guidance: string;
    output_schema_version: string;
    allowed_variables: string[];
    content_hash: string;
    status: string;
    created_by: string;
    approved_by: string | null;
    published_at: string | null;
  }>(db, "select * from ai_prompt_versions where id = $1 for update", [targetPromptId]);

  guard(
    Boolean(historical.published_at) && ["deprecated", "rolled_back"].includes(historical.status),
    "RECORD_CONFLICT",
    "Only previously published/historical prompt versions can be rolled back to.",
    409,
  );
  guard(
    Boolean(historical.approved_by) && historical.created_by !== actor.id,
    "SOD_VIOLATION",
    "Separation of duties forbids authoring and rolling back your own prompt version.",
    403,
  );
  assertSafePromptTemplate(historical.semantic_guidance);

  const currentPublished = (
    await db.query<{ id: string }>(
      "select id from ai_prompt_versions where purpose_code = $1 and status = 'published' for update",
      [historical.purpose_code],
    )
  ).rows[0];

  const activeRoute = currentPublished
    ? (
        await db.query<{
          id: string;
          purpose_code: AiPurposeCode;
          auto_enabled: boolean;
          allowed_source_locales: string[];
          allowed_target_locales: string[];
          primary_instance_id: string;
          primary_model_id: string;
          fallback_instance_id: string | null;
          fallback_model_id: string | null;
          prompt_version_id: string;
          glossary_domain: string;
          max_input_chars: number;
          max_output_tokens: number;
          timeout_ms: number;
          max_retries: number;
          requires_human_confirmation: boolean;
          high_risk_purpose: boolean;
          created_by: string;
        }>(
          "select * from ai_purpose_routes where purpose_code = $1 and status = 'published' and prompt_version_id = $2 for update",
          [historical.purpose_code, currentPublished.id],
        )
      ).rows[0]
    : undefined;

  if (activeRoute) {
    guard(
      activeRoute.created_by !== actor.id,
      "SOD_VIOLATION",
      "Separation of duties forbids updating the active purpose route you authored.",
      403,
    );
    await validatePurposeRouteReadiness(db, activeRoute, { checkPromptPublished: false });
    await enforcePurposeEvalGate(db, { ...activeRoute, prompt_version_id: historical.id });
  }

  await db.query(
    "update ai_prompt_versions set status = 'rolled_back' where purpose_code = $1 and status = 'published'",
    [historical.purpose_code],
  );
  const maxVer = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from ai_prompt_versions where purpose_code = $1",
      [historical.purpose_code],
    )
  ).rows[0]?.v ?? 0;

  const newPublished = await one<{ id: string }>(
    db,
    `insert into ai_prompt_versions (
       id, purpose_code, version, title, semantic_guidance, output_schema_version,
       allowed_variables, status, content_hash, created_by, approved_by, published_at
     ) values ($1,$2,$3,$4,$5,$6,$7,'published',$8,$9,$10,now())
     returning *`,
    [
      uuid(),
      historical.purpose_code,
      maxVer + 1,
      historical.title,
      historical.semantic_guidance,
      historical.output_schema_version,
      historical.allowed_variables,
      historical.content_hash,
      historical.created_by,
      actor.id,
    ],
  );

  // If an active route pointed at the superseded prompt, roll forward a new immutable route version bound to the restored prompt.
  if (activeRoute) {
    await db.query("update ai_purpose_routes set status = 'rolled_back' where id = $1", [activeRoute.id]);
    const routeMaxVer = (
      await db.query<{ v: number }>(
        "select coalesce(max(version), 0)::int as v from ai_purpose_routes where purpose_code = $1",
        [activeRoute.purpose_code],
      )
    ).rows[0]?.v ?? 0;
    await db.query(
      `insert into ai_purpose_routes (
         id, purpose_code, version, auto_enabled, allowed_source_locales, allowed_target_locales,
         primary_instance_id, primary_model_id, fallback_instance_id, fallback_model_id,
         prompt_version_id, glossary_domain, max_input_chars, max_output_tokens,
         timeout_ms, max_retries, requires_human_confirmation, high_risk_purpose,
         status, created_by, approved_by, published_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'published',$19,$20,now())`,
      [
        uuid(),
        activeRoute.purpose_code,
        routeMaxVer + 1,
        activeRoute.auto_enabled,
        activeRoute.allowed_source_locales,
        activeRoute.allowed_target_locales,
        activeRoute.primary_instance_id,
        activeRoute.primary_model_id,
        activeRoute.fallback_instance_id,
        activeRoute.fallback_model_id,
        newPublished.id,
        activeRoute.glossary_domain,
        activeRoute.max_input_chars,
        activeRoute.max_output_tokens,
        activeRoute.timeout_ms,
        activeRoute.max_retries,
        activeRoute.requires_human_confirmation,
        activeRoute.high_risk_purpose,
        activeRoute.created_by,
        actor.id,
      ],
    );
  }

  await audit(db, actor, "ai_prompt_rolled_back", "ai_prompt_versions", newPublished.id, {
    purpose_code: historical.purpose_code,
    rolled_back_to_version: historical.version,
    new_version: maxVer + 1,
    active_route_rebound: Boolean(activeRoute),
  });
  return { prompt: newPublished };
}

export async function listPromptVersions(db: DB, actor: Actor, purposeCode?: string) {
  role(actor, ...AI_VIEW_ROLES);
  const prompts = purposeCode
    ? (
        await db.query(
          "select * from ai_prompt_versions where purpose_code = $1 order by version desc",
          [purposeCode],
        )
      ).rows
    : (await db.query("select * from ai_prompt_versions order by purpose_code, version desc")).rows;
  return { prompts };
}

export async function createGlossaryTerm(db: DB, actor: Actor, rawBody: Record<string, unknown>) {
  role(actor, "super_admin", "template_admin", "reviewer");
  const input = createGlossaryTermSchema.parse(rawBody);
  const srcLoc = assertEnabledLocale(input.source_locale);
  const tgtLoc = assertEnabledLocale(input.target_locale);
  guard(srcLoc !== tgtLoc, "INVALID_REQUEST", "Glossary source and target locales must differ.", 422);

  const maxVer = (
    await db.query<{ v: number }>(
      `select coalesce(max(version), 0)::int as v from ai_glossary_terms
       where domain = $1 and term_key = $2 and source_locale = $3 and target_locale = $4`,
      [input.domain, input.term_key, srcLoc, tgtLoc],
    )
  ).rows[0]?.v ?? 0;

  const term = await one(
    db,
    `insert into ai_glossary_terms (
       id, domain, term_key, category_slug, context_note,
       source_locale, source_term, target_locale, target_term,
       disallowed_translations, version, status, author_kind, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$13)
     returning *`,
    [
      uuid(),
      input.domain,
      input.term_key,
      input.category_slug ?? null,
      input.context_note ?? null,
      srcLoc,
      input.source_term,
      tgtLoc,
      input.target_term,
      input.disallowed_translations,
      maxVer + 1,
      input.author_kind,
      actor.id,
    ],
  );
  await audit(db, actor, "ai_glossary_term_created", "ai_glossary_terms", term.id, {
    domain: input.domain,
    term_key: input.term_key,
    author_kind: input.author_kind,
  });
  return { term };
}

export async function approveGlossaryTerm(db: DB, actor: Actor, termId: string) {
  role(actor, "reviewer", "super_admin");
  const term = await one<{
    id: string;
    domain: string;
    term_key: string;
    status: string;
    created_by: string;
  }>(db, "select * from ai_glossary_terms where id = $1 for update", [termId]);
  guard(term.status === "draft", "RECORD_CONFLICT", "Only draft glossary terms can be approved.", 409);
  guard(term.created_by !== actor.id, "SOD_VIOLATION", "Author cannot approve their own glossary term.", 403);

  const updated = await one(
    db,
    `update ai_glossary_terms
     set status = 'approved', approved_by = $2, approved_at = now()
     where id = $1
     returning *`,
    [term.id, actor.id],
  );
  await audit(db, actor, "ai_glossary_term_approved", "ai_glossary_terms", term.id, {
    domain: term.domain,
    term_key: term.term_key,
  });
  return { term: updated };
}

export async function listGlossaryTerms(db: DB, actor: Actor, domain?: string) {
  role(actor, ...AI_VIEW_ROLES);
  const terms = domain
    ? (await db.query("select * from ai_glossary_terms where domain = $1 order by term_key, version desc", [domain])).rows
    : (await db.query("select * from ai_glossary_terms order by domain, term_key, version desc")).rows;
  return { terms };
}

export async function createPurposeRouteDraft(db: DB, actor: Actor, rawBody: Record<string, unknown>) {
  role(actor, ...AI_CONFIG_ROLES);
  const input = createPurposeRouteSchema.parse(rawBody);
  for (const loc of [...input.allowed_source_locales, ...input.allowed_target_locales]) {
    assertEnabledLocale(loc);
  }
  guard(
    Boolean(input.fallback_instance_id) === Boolean(input.fallback_model_id),
    "INVALID_REQUEST",
    "Fallback instance and fallback model must both be set or both omitted.",
    422,
  );
  if (MANDATORY_CONFIRMATION_PURPOSES.has(input.purpose_code) || input.high_risk_purpose) {
    guard(
      input.requires_human_confirmation,
      "AI_HIGH_RISK_CONFIRMATION_REQUIRED",
      `Purpose '${input.purpose_code}' handles specs or report prose and must enforce requires_human_confirmation=true.`,
      422,
    );
  }

  const prompt = await one<{ id: string; purpose_code: string; status: string }>(
    db,
    "select id, purpose_code, status from ai_prompt_versions where id = $1",
    [input.prompt_version_id],
  );
  guard(prompt.purpose_code === input.purpose_code, "INVALID_REQUEST", "Prompt version does not match purpose_code.", 422);

  const primaryInst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1",
    [input.primary_instance_id],
  );
  guard(
    primaryInst.allowed_purposes.includes(input.purpose_code),
    "AI_PURPOSE_NOT_ALLOWED",
    `Primary instance '${primaryInst.instance_key}' does not allow purpose '${input.purpose_code}'.`,
    422,
  );
  const primaryModel = await one<{ id: string; instance_id: string; deprecated: boolean }>(
    db,
    "select id, instance_id, deprecated from ai_models where id = $1",
    [input.primary_model_id],
  );
  guard(primaryModel.instance_id === primaryInst.id && !primaryModel.deprecated, "UNKNOWN_AI_MODEL", "Primary model invalid.", 422);

  if (input.fallback_instance_id && input.fallback_model_id) {
    const fbInst = await one<AiInstanceRow>(db, "select * from ai_provider_instances where id = $1", [
      input.fallback_instance_id,
    ]);
    guard(
      fbInst.environment === primaryInst.environment &&
        fbInst.data_region_policy === primaryInst.data_region_policy &&
        fbInst.allowed_purposes.includes(input.purpose_code),
      "AI_FALLBACK_POLICY_MISMATCH",
      "Fallback instance must match primary environment, data_region_policy, and allowed purposes (§53.8).",
      409,
    );
    const fbModel = await one<{ id: string; instance_id: string; deprecated: boolean }>(
      db,
      "select id, instance_id, deprecated from ai_models where id = $1",
      [input.fallback_model_id],
    );
    guard(fbModel.instance_id === fbInst.id && !fbModel.deprecated, "UNKNOWN_AI_MODEL", "Fallback model invalid.", 422);
  }

  const maxVer = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from ai_purpose_routes where purpose_code = $1",
      [input.purpose_code],
    )
  ).rows[0]?.v ?? 0;

  const route = await one(
    db,
    `insert into ai_purpose_routes (
       id, purpose_code, version, auto_enabled, allowed_source_locales, allowed_target_locales,
       primary_instance_id, primary_model_id, fallback_instance_id, fallback_model_id,
       prompt_version_id, glossary_domain, max_input_chars, max_output_tokens,
       timeout_ms, max_retries, requires_human_confirmation, high_risk_purpose, status, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft',$19)
     returning *`,
    [
      uuid(),
      input.purpose_code,
      maxVer + 1,
      input.auto_enabled,
      input.allowed_source_locales,
      input.allowed_target_locales,
      input.primary_instance_id,
      input.primary_model_id,
      input.fallback_instance_id ?? null,
      input.fallback_model_id ?? null,
      input.prompt_version_id,
      input.glossary_domain,
      input.max_input_chars,
      input.max_output_tokens,
      input.timeout_ms,
      input.max_retries,
      input.requires_human_confirmation,
      input.high_risk_purpose || MANDATORY_CONFIRMATION_PURPOSES.has(input.purpose_code),
      actor.id,
    ],
  );

  await audit(db, actor, "ai_purpose_route_draft_created", "ai_purpose_routes", route.id, {
    purpose_code: input.purpose_code,
    version: maxVer + 1,
  });
  return { route };
}

async function validatePurposeRouteReadiness(
  db: DB,
  route: {
    id: string;
    purpose_code: AiPurposeCode;
    primary_instance_id: string;
    primary_model_id: string;
    fallback_instance_id: string | null;
    fallback_model_id: string | null;
    prompt_version_id: string;
    requires_human_confirmation: boolean;
    high_risk_purpose: boolean;
  },
  opts: { checkPromptPublished?: boolean } = {},
) {
  if (MANDATORY_CONFIRMATION_PURPOSES.has(route.purpose_code) || route.high_risk_purpose) {
    guard(
      route.requires_human_confirmation,
      "AI_HIGH_RISK_CONFIRMATION_REQUIRED",
      `Purpose '${route.purpose_code}' requires requires_human_confirmation=true.`,
      422,
    );
  }

  const pInst = await one<AiInstanceRow>(db, "select * from ai_provider_instances where id = $1", [
    route.primary_instance_id,
  ]);
  guard(pInst.status === "approved", "AI_INSTANCE_NOT_APPROVED", "Primary AI instance must be approved.", 409);
  guard(
    pInst.allowed_purposes.includes(route.purpose_code),
    "AI_PURPOSE_NOT_ALLOWED",
    `Primary instance '${pInst.instance_key}' no longer allows purpose '${route.purpose_code}'.`,
    409,
  );
  const pModel = await one<{ instance_id: string; approved: boolean; enabled: boolean; deprecated: boolean }>(
    db,
    "select instance_id, approved, enabled, deprecated from ai_models where id = $1",
    [route.primary_model_id],
  );
  guard(
    pModel.instance_id === pInst.id && pModel.approved && pModel.enabled && !pModel.deprecated,
    "UNKNOWN_AI_MODEL",
    "Primary AI model must be approved and enabled.",
    409,
  );

  if (opts.checkPromptPublished !== false) {
    const prompt = await one<{ purpose_code: string; status: string }>(
      db,
      "select purpose_code, status from ai_prompt_versions where id = $1",
      [route.prompt_version_id],
    );
    guard(
      prompt.purpose_code === route.purpose_code && prompt.status === "published",
      "AI_PROMPT_NOT_PUBLISHED",
      "Linked prompt version must be published first.",
      409,
    );
  }

  if (route.fallback_instance_id && route.fallback_model_id) {
    const fbInst = await one<AiInstanceRow>(db, "select * from ai_provider_instances where id = $1", [
      route.fallback_instance_id,
    ]);
    guard(fbInst.status === "approved", "AI_INSTANCE_NOT_APPROVED", "Fallback AI instance must be approved.", 409);
    guard(
      fbInst.environment === pInst.environment &&
        fbInst.data_region_policy === pInst.data_region_policy &&
        fbInst.allowed_purposes.includes(route.purpose_code),
      "AI_FALLBACK_POLICY_MISMATCH",
      "Fallback instance no longer matches primary data/environment/purpose policy.",
      409,
    );
    const fbModel = await one<{ instance_id: string; approved: boolean; enabled: boolean; deprecated: boolean }>(
      db,
      "select instance_id, approved, enabled, deprecated from ai_models where id = $1",
      [route.fallback_model_id],
    );
    guard(
      fbModel.instance_id === fbInst.id && fbModel.approved && fbModel.enabled && !fbModel.deprecated,
      "UNKNOWN_AI_MODEL",
      "Fallback AI model must be approved and enabled.",
      409,
    );
  }
}

async function enforcePurposeEvalGate(
  db: DB,
  route: {
    id: string;
    purpose_code: AiPurposeCode;
    prompt_version_id: string;
    primary_model_id: string;
    high_risk_purpose: boolean;
  },
) {
  const isHighRisk = Boolean(route.high_risk_purpose) || MANDATORY_CONFIRMATION_PURPOSES.has(route.purpose_code);
  const hasCases =
    (
      await db.query<{ has_cases: boolean }>(
        "select exists(select 1 from ai_translation_eval_cases where purpose_code = $1) as has_cases",
        [route.purpose_code],
      )
    ).rows[0]?.has_cases ?? false;

  if (!isHighRisk && !hasCases) return;

  const approvedEval = (
    await db.query<{ id: string }>(
      `select id
       from ai_translation_eval_runs
       where purpose_code = $1
         and prompt_version_id = $2
         and model_id = $3
         and automated_status = 'passed'
         and protected_fact_errors = 0
         and human_qa_status = 'approved'
       order by (route_version_id = $4) desc, created_at desc
       limit 1`,
      [route.purpose_code, route.prompt_version_id, route.primary_model_id, route.id],
    )
  ).rows[0];

  guard(
    Boolean(approvedEval),
    "AI_EVAL_APPROVAL_REQUIRED",
    `Purpose '${route.purpose_code}' requires a passing zero-fact-error bilingual evaluation run with independent human QA approval before publishing.`,
    409,
  );
}

export async function publishPurposeRoute(
  db: DB,
  actor: Actor,
  sessionHash: string,
  routeId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const route = await one<{
    id: string;
    purpose_code: AiPurposeCode;
    version: number;
    primary_instance_id: string;
    primary_model_id: string;
    fallback_instance_id: string | null;
    fallback_model_id: string | null;
    prompt_version_id: string;
    requires_human_confirmation: boolean;
    high_risk_purpose: boolean;
    status: string;
    created_by: string;
  }>(db, "select * from ai_purpose_routes where id = $1 for update", [routeId]);

  guard(route.status === "draft", "RECORD_CONFLICT", "Only draft purpose routes can be published.", 409);
  guard(route.created_by !== actor.id, "SOD_VIOLATION", "Author cannot publish their own purpose route.", 403);

  await validatePurposeRouteReadiness(db, route);
  await enforcePurposeEvalGate(db, route);

  await db.query(
    "update ai_purpose_routes set status = 'deprecated' where purpose_code = $1 and status = 'published'",
    [route.purpose_code],
  );
  const published = await one(
    db,
    `update ai_purpose_routes
     set status = 'published', approved_by = $2, published_at = now()
     where id = $1
     returning *`,
    [route.id, actor.id],
  );
  await audit(db, actor, "ai_purpose_route_published", "ai_purpose_routes", route.id, {
    purpose_code: route.purpose_code,
    version: route.version,
  });
  return { route: published };
}

export async function rollbackPurposeRoute(
  db: DB,
  actor: Actor,
  sessionHash: string,
  targetRouteId: string,
) {
  role(actor, ...AI_CONFIG_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const old = await one<{
    id: string;
    purpose_code: AiPurposeCode;
    version: number;
    auto_enabled: boolean;
    allowed_source_locales: string[];
    allowed_target_locales: string[];
    primary_instance_id: string;
    primary_model_id: string;
    fallback_instance_id: string | null;
    fallback_model_id: string | null;
    prompt_version_id: string;
    glossary_domain: string;
    max_input_chars: number;
    max_output_tokens: number;
    timeout_ms: number;
    max_retries: number;
    requires_human_confirmation: boolean;
    high_risk_purpose: boolean;
    status: string;
    created_by: string;
    approved_by: string | null;
    published_at: string | null;
  }>(db, "select * from ai_purpose_routes where id = $1 for update", [targetRouteId]);

  guard(
    Boolean(old.published_at) && ["deprecated", "rolled_back"].includes(old.status),
    "RECORD_CONFLICT",
    "Only previously published/historical purpose routes can be rolled back to.",
    409,
  );
  guard(
    Boolean(old.approved_by) && old.created_by !== actor.id,
    "SOD_VIOLATION",
    "Separation of duties forbids authoring and rolling back your own purpose route.",
    403,
  );

  await validatePurposeRouteReadiness(db, old);
  await enforcePurposeEvalGate(db, old);

  await db.query(
    "update ai_purpose_routes set status = 'rolled_back' where purpose_code = $1 and status = 'published'",
    [old.purpose_code],
  );
  const maxVer = (
    await db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int as v from ai_purpose_routes where purpose_code = $1",
      [old.purpose_code],
    )
  ).rows[0]?.v ?? 0;

  const rolled = await one(
    db,
    `insert into ai_purpose_routes (
       id, purpose_code, version, auto_enabled, allowed_source_locales, allowed_target_locales,
       primary_instance_id, primary_model_id, fallback_instance_id, fallback_model_id,
       prompt_version_id, glossary_domain, max_input_chars, max_output_tokens,
       timeout_ms, max_retries, requires_human_confirmation, high_risk_purpose,
       status, created_by, approved_by, published_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'published',$19,$20,now())
     returning *`,
    [
      uuid(),
      old.purpose_code,
      maxVer + 1,
      old.auto_enabled,
      old.allowed_source_locales,
      old.allowed_target_locales,
      old.primary_instance_id,
      old.primary_model_id,
      old.fallback_instance_id,
      old.fallback_model_id,
      old.prompt_version_id,
      old.glossary_domain,
      old.max_input_chars,
      old.max_output_tokens,
      old.timeout_ms,
      old.max_retries,
      old.requires_human_confirmation,
      old.high_risk_purpose,
      old.created_by,
      actor.id,
    ],
  );
  await audit(db, actor, "ai_purpose_route_rolled_back", "ai_purpose_routes", rolled.id, {
    purpose_code: old.purpose_code,
    rolled_back_to_version: old.version,
    new_version: maxVer + 1,
  });
  return { route: rolled };
}

export async function listPurposeRoutes(db: DB, actor: Actor) {
  role(actor, ...AI_VIEW_ROLES);
  const routes = (
    await db.query(
      `select r.*, p.version as prompt_version_num, p.title as prompt_title,
              pi.instance_key as primary_instance_key, pm.requested_model_id as primary_model_key,
              fi.instance_key as fallback_instance_key, fm.requested_model_id as fallback_model_key
       from ai_purpose_routes r
       join ai_prompt_versions p on p.id = r.prompt_version_id
       join ai_provider_instances pi on pi.id = r.primary_instance_id
       join ai_models pm on pm.id = r.primary_model_id
       left join ai_provider_instances fi on fi.id = r.fallback_instance_id
       left join ai_models fm on fm.id = r.fallback_model_id
       order by r.purpose_code, r.version desc`,
    )
  ).rows;
  return { routes };
}

async function computeGlossaryDigest(
  db: Pick<DB, "query">,
  domain: string,
  sourceLocale: string,
  targetLocale: string,
) {
  const rows = (
    await db.query<{
      source_term: string;
      target_term: string;
      context_note: string | null;
      disallowed_translations: string[];
      version: number;
    }>(
      `select distinct on (term_key) source_term, target_term, context_note, disallowed_translations, version
       from ai_glossary_terms
       where domain = $1 and source_locale = $2 and target_locale = $3 and status = 'approved'
       order by term_key, version desc`,
      [domain, sourceLocale, targetLocale],
    )
  ).rows;
  const glossaryHash = hash(JSON.stringify(rows));
  return { terms: rows, glossaryHash };
}

export async function enqueueTranslationJob(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  const input = enqueueTranslationJobSchema.parse(rawBody);
  const srcLoc = assertEnabledLocale(input.source_locale);
  const tgtLoc = assertEnabledLocale(input.target_locale);
  guard(srcLoc !== tgtLoc, "INVALID_REQUEST", "Source and target locales must differ.", 422);

  let tenantScopeKey: string;
  if (actor.kind === "customer") {
    guard(Boolean(actor.org), "FORBIDDEN", "Customer org context missing.", 403);
    guard(
      input.purpose_code === "SUPPORT_INBOUND_TRANSLATE" ||
        input.purpose_code === "INSPECTION_REQUIREMENT_TRANSLATE",
      "FORBIDDEN",
      "Customers cannot invoke internal or admin translation purposes.",
      403,
    );
    const expectedScope = `org:${actor.org}`;
    guard(
      !input.tenant_scope_key || input.tenant_scope_key === expectedScope,
      "FORBIDDEN",
      "Cross-tenant translation scope is forbidden.",
      403,
    );
    tenantScopeKey = expectedScope;
  } else {
    role(actor, "super_admin", "template_admin", "reviewer", "support", "inspector");
    tenantScopeKey = input.tenant_scope_key ?? "internal:staff";
  }

  const existingJob = (
    await db.query("select * from ai_translation_jobs where tenant_scope_key = $1 and idempotency_key = $2", [
      tenantScopeKey,
      input.idempotency_key,
    ])
  ).rows[0];
  const requestHash = hash(
    JSON.stringify({
      purpose_code: input.purpose_code,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      source_locale: srcLoc,
      target_locale: tgtLoc,
      cost_center: input.cost_center,
      cost_attribution_id: input.cost_attribution_id ?? null,
      items: input.items,
    }),
  );
  if (existingJob) {
    guard(
      existingJob.request_hash === requestHash,
      "IDEMPOTENCY_CONFLICT",
      "This translation job idempotency_key was already used with a different payload.",
      409,
    );
    const items = (
      await db.query("select * from ai_translation_job_items where job_id = $1 order by field_id", [existingJob.id])
    ).rows;
    return { job: existingJob, items, deduplicated: true };
  }

  const route = (
    await db.query<Record<string, any>>(
      "select * from ai_purpose_routes where purpose_code = $1 and status = 'published' limit 1",
      [input.purpose_code],
    )
  ).rows[0];
  guard(
    route && route.auto_enabled,
    "AI_ROUTE_NOT_CONFIGURED",
    `No active automated route for '${input.purpose_code}'; fall back to manual translation.`,
    409,
  );
  guard(
    route.allowed_source_locales.includes(srcLoc) && route.allowed_target_locales.includes(tgtLoc),
    "LOCALE_NOT_ENABLED",
    `Locale pair ${srcLoc} -> ${tgtLoc} is not permitted on this purpose route.`,
    422,
  );

  const seenFields = new Set<string>();
  for (const item of input.items) {
    guard(!seenFields.has(item.field_id), "INVALID_REQUEST", `Duplicate field_id '${item.field_id}' in batch.`, 422);
    seenFields.add(item.field_id);
    assertSafeOutboundAiPayload(item.source_text, route.max_input_chars);
  }

  const { glossaryHash } = await computeGlossaryDigest(db, route.glossary_domain, srcLoc, tgtLoc);
  const jobId = uuid();

  const job = await one(
    db,
    `insert into ai_translation_jobs (
       id, idempotency_key, request_hash, purpose_code, tenant_scope_key, entity_type, entity_id,
       source_locale, target_locale, route_version_id, prompt_version_id, glossary_hash,
       cost_center, cost_attribution_id, status, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',$15)
     returning *`,
    [
      jobId,
      input.idempotency_key,
      requestHash,
      input.purpose_code,
      tenantScopeKey,
      input.entity_type,
      input.entity_id,
      srcLoc,
      tgtLoc,
      route.id,
      route.prompt_version_id,
      glossaryHash,
      input.cost_center,
      input.cost_attribution_id ?? null,
      actor.id,
    ],
  );

  const insertedItems: Record<string, unknown>[] = [];
  for (const item of input.items) {
    const row = await one(
      db,
      `insert into ai_translation_job_items (
         id, job_id, field_id, source_revision, source_hash, source_text,
         placeholders, expected_target_revision, status
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'queued')
       returning *`,
      [
        uuid(),
        jobId,
        item.field_id,
        item.source_revision,
        hash(item.source_text),
        item.source_text,
        item.placeholders,
        item.expected_target_revision ?? null,
      ],
    );
    insertedItems.push(row);
  }

  await db.query("insert into outbox_events(type, payload) values('ai.translate', $1::jsonb)", [
    JSON.stringify({ job_id: jobId, purpose_code: input.purpose_code }),
  ]);
  await audit(db, actor, "ai_translation_job_enqueued", "ai_translation_jobs", jobId, {
    purpose_code: input.purpose_code,
    item_count: insertedItems.length,
    tenant_scope_key: tenantScopeKey,
  });

  return { job, items: insertedItems, deduplicated: false };
}

function buildTranslationCacheKey(params: {
  tenantScopeKey: string;
  purposeCode: string;
  sourceLocale: string;
  targetLocale: string;
  sourceHash: string;
  promptVersionId: string;
  routeVersionId: string;
  modelId: string;
  glossaryHash: string;
}): string {
  return hash(
    JSON.stringify({
      tenant: params.tenantScopeKey,
      purpose: params.purposeCode,
      srcLoc: params.sourceLocale,
      tgtLoc: params.targetLocale,
      srcHash: params.sourceHash,
      promptId: params.promptVersionId,
      routeId: params.routeVersionId,
      modelId: params.modelId,
      glossaryHash: params.glossaryHash,
    }),
  );
}

async function prepareExecutionEndpoint(
  db: DB,
  instanceId: string,
  modelId: string,
  timeoutOverrideMs: number,
  purposeCode: AiPurposeCode,
) {
  const inst = await one<AiInstanceRow>(
    db,
    "select * from ai_provider_instances where id = $1",
    [instanceId],
  );
  guard(inst.status === "approved", "AI_INSTANCE_NOT_APPROVED", "AI provider instance is not approved.", 409);
  guard(
    inst.allowed_purposes.includes(purposeCode),
    "AI_PURPOSE_NOT_ALLOWED",
    `AI provider instance '${inst.instance_key}' no longer permits purpose '${purposeCode}'.`,
    409,
  );

  const model = await one<{
    id: string;
    instance_id: string;
    requested_model_id: string;
    supports_structured_output: boolean;
    supports_json_object: boolean;
    max_input_tokens: number;
    max_output_tokens: number;
    approved: boolean;
    enabled: boolean;
    deprecated: boolean;
  }>(db, "select * from ai_models where id = $1", [modelId]);
  guard(
    model.instance_id === inst.id && model.approved && model.enabled && !model.deprecated,
    "UNKNOWN_AI_MODEL",
    "Target AI model is no longer approved or enabled.",
    409,
  );

  const secrets = await loadActiveSecretsForInstance(db, inst.id);
  guard(Boolean(secrets.apiKey), "AI_SECRET_MISSING", "AI instance active API key missing.", 409);

  const rate = (
    await db.query<AiRateRow>(
      "select * from ai_model_rate_versions where model_id = $1 order by version desc limit 1",
      [model.id],
    )
  ).rows[0] ?? null;

  return {
    inst,
    model,
    rate,
    cfg: {
      adapterType: inst.adapter_type,
      protocol: inst.api_protocol,
      baseUrl: inst.base_url,
      apiKey: secrets.apiKey!,
      organizationHeader: secrets.organizationHeader,
      projectHeader: secrets.projectHeader,
      timeoutMs: Math.min(inst.timeout_ms, timeoutOverrideMs),
    } satisfies AiAdapterRequestConfig,
  };
}

async function failTranslationExecutionOnException(params: {
  err: unknown;
  job: Record<string, any>;
  attemptNum: number;
  stage: "primary" | "fallback";
  usedFallback: boolean;
  providerCalls: number;
  cacheHits: number;
  uncachedItems: Array<Record<string, any>>;
  reservationId: string | null;
  instanceId: string;
  modelId: string;
  rateId: string | null;
  environment: string;
}) {
  const errCode = params.err instanceof Problem ? params.err.code : "AI_EXECUTION_ERROR";
  const errSummary = (params.err instanceof Error ? params.err.message : String(params.err)).slice(0, 400);

  return transaction(async (db) => {
    if (params.reservationId) {
      await db.query(
        "update ai_budget_reservations set status = 'released', settled_cents = 0, settled_at = now() where id = $1 and status = 'reserved'",
        [params.reservationId],
      );
    }

    const inv = await one<{ id: string }>(
      db,
      `insert into ai_invocations (
         id, attempt_key, logical_task_id, reservation_id, instance_id, model_id, rate_version_id,
         purpose_code, invocation_kind, environment, actor_user_id, entity_type, entity_id,
         cost_center, cost_attribution_id, source_locale, target_locale,
         status, error_code, error_summary, used_fallback_route, usage_source, cost_cents, cost_status
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'production_translation',$9,$10,$11,$12,$13,$14,$15,$16,'failed',$17,$18,$19,'unknown',0,'cache_zero')
       returning id`,
      [
        uuid(),
        `job:${params.job.id}:a${params.attemptNum}:${params.stage}:exc`,
        params.job.id,
        params.reservationId,
        params.instanceId,
        params.modelId,
        params.rateId,
        params.job.purpose_code,
        params.environment,
        params.job.created_by,
        params.job.entity_type,
        params.job.entity_id,
        params.job.cost_center,
        params.job.cost_attribution_id ?? null,
        params.job.source_locale,
        params.job.target_locale,
        errCode,
        errSummary,
        params.usedFallback,
      ],
    );

    for (const it of params.uncachedItems) {
      await db.query(
        `update ai_translation_job_items
         set candidate_status = 'rejected', invocation_id = $2,
             semantic_violations = $3::jsonb, status = 'failed', updated_at = now()
         where id = $1`,
        [it.id, inv.id, JSON.stringify([{ code: errCode, message: errSummary }])],
      );
    }

    await db.query(
      `update ai_translation_jobs
       set status = 'failed', used_fallback_route = $2, cache_hits = cache_hits + $3,
           provider_calls = provider_calls + $4, last_error_code = $5, last_error_summary = $6,
           lease_token = null, lease_owner = null, completed_at = now(), updated_at = now()
       where id = $1`,
      [
        params.job.id,
        params.usedFallback,
        params.cacheHits,
        params.providerCalls,
        errCode,
        errSummary,
      ],
    );

    return {
      skip: false as const,
      status: "failed",
      used_fallback_route: params.usedFallback,
      error_code: errCode,
      invocation_id: inv.id,
    };
  });
}

export async function processTranslationJob(jobId: string, workerOwner = "worker-main") {
  const prep = await transaction(async (db) => {
    const job = (
      await db.query<Record<string, any>>(
        "select * from ai_translation_jobs where id = $1 for update",
        [jobId],
      )
    ).rows[0];
    if (!job || !["queued", "retry_wait"].includes(job.status)) {
      return { skip: true as const };
    }

    if (Number(job.attempts) >= Number(job.max_attempts)) {
      await db.query(
        `update ai_translation_jobs
         set status = 'failed', last_error_code = 'AI_JOB_MAX_ATTEMPTS_EXCEEDED',
             last_error_summary = 'Translation job exceeded max_attempts limit.',
             lease_token = null, lease_owner = null, completed_at = now(), updated_at = now()
         where id = $1`,
        [job.id],
      );
      await db.query(
        "update ai_translation_job_items set status = 'failed', updated_at = now() where job_id = $1 and status in ('queued','failed')",
        [job.id],
      );
      return { skip: true as const };
    }

    // Re-check actor/staff authorization, security status, role & org membership BEFORE calling upstream (§53.10 revocation defense)
    const creator = (
      await db.query<{
        status: string;
        employment_status: string | null;
        account_security_status: string | null;
        is_staff: boolean;
        has_ai_staff_role: boolean;
        belongs_to_org: boolean;
      }>(
        `select u.status,
                sp.employment_status,
                sp.account_security_status,
                (sp.user_id is not null) as is_staff,
                exists(
                  select 1 from staff_roles sr
                  where sr.user_id = u.id
                    and sr.role in ('super_admin', 'template_admin', 'reviewer', 'support', 'inspector')
                ) as has_ai_staff_role,
                exists(
                  select 1 from memberships m
                  where m.user_id = u.id
                    and ('org:' || m.org_id::text) = $2
                ) as belongs_to_org
         from users u
         left join staff_profiles sp on sp.user_id = u.id
         where u.id = $1`,
        [job.created_by, job.tenant_scope_key],
      )
    ).rows[0];

    const actorRevoked =
      !creator ||
      creator.status !== "active" ||
      (creator.is_staff
        ? creator.employment_status !== "active" ||
          creator.account_security_status !== "active" ||
          !creator.has_ai_staff_role
        : job.tenant_scope_key.startsWith("org:") && !creator.belongs_to_org);

    if (actorRevoked) {
      await db.query(
        `update ai_translation_jobs
         set status = 'cancelled', last_error_code = 'PERMISSION_REVOKED',
             last_error_summary = 'Creator account disabled, locked, offboarded, or role/membership revoked before AI execution.',
             updated_at = now(), completed_at = now()
         where id = $1`,
        [job.id],
      );
      await db.query(
        "update ai_translation_job_items set status = 'cancelled', updated_at = now() where job_id = $1",
        [job.id],
      );
      return { skip: true as const, cancelled: true };
    }

    const route = await one<Record<string, any>>(
      db,
      "select * from ai_purpose_routes where id = $1",
      [job.route_version_id],
    );
    const prompt = await one<{ id: string; semantic_guidance: string; status: string }>(
      db,
      "select id, semantic_guidance, status from ai_prompt_versions where id = $1",
      [job.prompt_version_id],
    );

    if (route.status !== "published" || !route.auto_enabled || prompt.status !== "published") {
      await db.query(
        `update ai_translation_jobs
         set status = 'failed', last_error_code = 'AI_ROUTE_OR_PROMPT_INACTIVE',
             last_error_summary = 'Route or prompt version is no longer published/active.',
             updated_at = now(), completed_at = now()
         where id = $1`,
        [job.id],
      );
      return { skip: true as const };
    }

    const leaseToken = uuid();
    const runningJob = await one<{ attempts: number }>(
      db,
      `update ai_translation_jobs
       set status = 'running', attempts = attempts + 1,
           lease_owner = $2, lease_token = $3,
           lease_expires_at = now() + interval '120 seconds', updated_at = now()
       where id = $1
       returning attempts`,
      [job.id, workerOwner, leaseToken],
    );
    const attemptNum = Number(runningJob.attempts);

    const items = (
      await db.query<Record<string, any>>(
        "select * from ai_translation_job_items where job_id = $1 and status in ('queued','failed') order by field_id",
        [job.id],
      )
    ).rows;

    const glossary = await computeGlossaryDigest(db, route.glossary_domain, job.source_locale, job.target_locale);
    const matchedGlossary = glossary.terms.filter((t) =>
      items.some((it) => String(it.source_text).toLowerCase().includes(t.source_term.toLowerCase())),
    );
    const disallowedTerms = glossary.terms.flatMap((t) => t.disallowed_translations ?? []);

    // Strict tenant-scoped cache lookup (NEVER crosses tenant_scope_key!)
    const uncachedItems: Record<string, any>[] = [];
    let cacheHits = 0;
    let cachedNeedsReviewCount = 0;

    for (const it of items) {
      const cacheKey = buildTranslationCacheKey({
        tenantScopeKey: job.tenant_scope_key,
        purposeCode: job.purpose_code,
        sourceLocale: job.source_locale,
        targetLocale: job.target_locale,
        sourceHash: String(it.source_hash),
        promptVersionId: prompt.id,
        routeVersionId: route.id,
        modelId: route.primary_model_id,
        glossaryHash: glossary.glossaryHash,
      });
      const cached = (
        await db.query<{ translated_text: string; status: string; warnings: unknown }>(
          `select translated_text, status, warnings
           from ai_translation_cache
           where cache_key = $1 and tenant_scope_key = $2
             and invalidated_at is null and (expires_at is null or expires_at > now())
           limit 1`,
          [cacheKey, job.tenant_scope_key],
        )
      ).rows[0];

      if (cached) {
        cacheHits += 1;
        const effectiveCandStatus =
          route.requires_human_confirmation && cached.status === "translated" ? "needs_review" : cached.status;
        if (effectiveCandStatus !== "translated") cachedNeedsReviewCount += 1;
        await db.query(
          `update ai_translation_job_items
           set candidate_text = $2, candidate_status = $3, warnings = $4::jsonb,
               from_cache = true, status = case when $3 = 'translated' then 'succeeded' else 'needs_review' end,
               updated_at = now()
           where id = $1`,
          [it.id, cached.translated_text, effectiveCandStatus, JSON.stringify(cached.warnings ?? [])],
        );
      } else {
        uncachedItems.push(it);
      }
    }

    if (cacheHits > 0) {
      await db.query(
        `insert into ai_invocations (
           id, attempt_key, logical_task_id, instance_id, model_id, purpose_code,
           invocation_kind, environment, actor_user_id, entity_type, entity_id,
           cost_center, cost_attribution_id, source_locale, target_locale,
           status, cache_hit, usage_source, cost_cents, cost_status
         ) values ($1,$2,$3,$4,$5,$6,'production_translation','production',$7,$8,$9,$10,$11,$12,$13,'succeeded',true,'cache_zero',0,'cache_zero')`,
        [
          uuid(),
          `cache:${job.id}:a${attemptNum}`,
          job.id,
          route.primary_instance_id,
          route.primary_model_id,
          job.purpose_code,
          job.created_by,
          job.entity_type,
          job.entity_id,
          job.cost_center,
          job.cost_attribution_id ?? null,
          job.source_locale,
          job.target_locale,
        ],
      );
    }

    if (uncachedItems.length === 0) {
      const cachedJobStatus = route.requires_human_confirmation || cachedNeedsReviewCount > 0 ? "needs_review" : "succeeded";
      await db.query(
        `update ai_translation_jobs
         set status = $3, cache_hits = cache_hits + $2, lease_token = null,
             lease_owner = null, completed_at = now(), updated_at = now()
         where id = $1`,
        [job.id, cacheHits, cachedJobStatus],
      );
      return { skip: true as const, cachedOnly: true };
    }

    const systemPrompt = buildImmutableSystemPrompt({
      purposeCode: job.purpose_code as AiPurposeCode,
      semanticGuidance: prompt.semantic_guidance,
      sourceLocale: job.source_locale,
      targetLocale: job.target_locale,
      glossaryTerms: matchedGlossary,
    });

    const primaryEndpoint = await prepareExecutionEndpoint(
      db,
      route.primary_instance_id,
      route.primary_model_id,
      route.timeout_ms,
      job.purpose_code as AiPurposeCode,
    );
    const primaryReserveCents = estimateCallMaxCents({
      rate: primaryEndpoint.rate,
      maxInputTokens: Math.min(primaryEndpoint.model.max_input_tokens, route.max_input_chars),
      maxOutputTokens: Math.min(primaryEndpoint.model.max_output_tokens, route.max_output_tokens),
      environment: primaryEndpoint.inst.environment,
    });
    const primaryReservation = await reserveAiBudgetAtomic(db, {
      reservationKey: `job:${job.id}:a${attemptNum}:primary`,
      instanceId: primaryEndpoint.inst.id,
      modelId: primaryEndpoint.model.id,
      rateVersionId: primaryEndpoint.rate?.id ?? null,
      purposeCode: job.purpose_code,
      estimatedCents: primaryReserveCents,
      actorUserId: job.created_by,
    });

    return {
      skip: false as const,
      job,
      attemptNum,
      route,
      prompt,
      leaseToken,
      glossaryHash: glossary.glossaryHash,
      disallowedTerms,
      cacheHits,
      cachedNeedsReviewCount,
      uncachedItems,
      systemPrompt,
      primaryEndpoint,
      primaryReservationId: primaryReservation.id,
    };
  });

  if (prep.skip) return prep;

  const {
    job,
    attemptNum,
    route,
    prompt,
    glossaryHash,
    disallowedTerms,
    cacheHits,
    cachedNeedsReviewCount,
    uncachedItems,
    systemPrompt,
    primaryEndpoint,
    primaryReservationId,
  } = prep;

  const callInputItems = uncachedItems.map((it) => ({
    field_id: String(it.field_id),
    source_text: String(it.source_text),
    placeholders: (it.placeholders as string[]) ?? [],
  }));

  let usedEndpoint = primaryEndpoint;
  let usedReservationId = primaryReservationId;
  let usedFallback = false;
  let attemptedProviderCalls = 1;
  let callResult: Awaited<ReturnType<typeof executeStructuredTranslationCall>>;

  try {
    callResult = await executeStructuredTranslationCall(primaryEndpoint.cfg, {
      requestedModelId: primaryEndpoint.model.requested_model_id,
      sourceLocale: job.source_locale,
      targetLocale: job.target_locale,
      items: callInputItems,
      maxInputChars: route.max_input_chars,
      maxOutputTokens: Math.min(primaryEndpoint.model.max_output_tokens, route.max_output_tokens),
      supportsStructuredOutput: primaryEndpoint.model.supports_structured_output,
      supportsJsonObject: primaryEndpoint.model.supports_json_object,
      systemPrompt,
    });
  } catch (err) {
    return failTranslationExecutionOnException({
      err,
      job,
      attemptNum,
      stage: "primary",
      usedFallback: false,
      providerCalls: attemptedProviderCalls,
      cacheHits,
      uncachedItems,
      reservationId: primaryReservationId,
      instanceId: primaryEndpoint.inst.id,
      modelId: primaryEndpoint.model.id,
      rateId: primaryEndpoint.rate?.id ?? null,
      environment: primaryEndpoint.inst.environment,
    });
  }

  const isTransientPrimaryFailure =
    !callResult.ok &&
    callResult.status === "failed" &&
    ["AI_PROVIDER_ERROR", "AI_RATE_OR_QUOTA_LIMITED", "AI_NETWORK_ERROR"].includes(
      callResult.errorCode ?? "",
    );

  if (isTransientPrimaryFailure && route.fallback_instance_id && route.fallback_model_id) {
    // Release primary failed reservation and fail over to policy-identical approved fallback route (§53.8)
    await transaction(async (db) => {
      await db.query(
        "update ai_budget_reservations set status = 'released', settled_cents = 0, settled_at = now() where id = $1",
        [primaryReservationId],
      );
      await db.query(
        `insert into ai_invocations (
           id, attempt_key, logical_task_id, reservation_id, instance_id, model_id, rate_version_id,
           purpose_code, invocation_kind, environment, actor_user_id, entity_type, entity_id,
           cost_center, cost_attribution_id, source_locale, target_locale,
           provider_request_id, status, error_code, error_summary, usage_source, cost_cents, cost_status, duration_ms
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'production_translation',$9,$10,$11,$12,$13,$14,$15,$16,$17,'failed',$18,$19,'unknown',0,'cache_zero',$20)`,
        [
          uuid(),
          `job:${job.id}:a${attemptNum}:primary-fail`,
          job.id,
          primaryReservationId,
          primaryEndpoint.inst.id,
          primaryEndpoint.model.id,
          primaryEndpoint.rate?.id ?? null,
          job.purpose_code,
          primaryEndpoint.inst.environment,
          job.created_by,
          job.entity_type,
          job.entity_id,
          job.cost_center,
          job.cost_attribution_id ?? null,
          job.source_locale,
          job.target_locale,
          callResult.providerRequestId,
          callResult.errorCode,
          callResult.errorSummary,
          callResult.durationMs,
        ],
      );
    });

    let fbReservationId: string | null = null;
    try {
      const fbPrep = await transaction(async (db) => {
        const fbEndpoint = await prepareExecutionEndpoint(
          db,
          route.fallback_instance_id,
          route.fallback_model_id,
          route.timeout_ms,
          job.purpose_code as AiPurposeCode,
        );
        const fbReserveCents = estimateCallMaxCents({
          rate: fbEndpoint.rate,
          maxInputTokens: Math.min(fbEndpoint.model.max_input_tokens, route.max_input_chars),
          maxOutputTokens: Math.min(fbEndpoint.model.max_output_tokens, route.max_output_tokens),
          environment: fbEndpoint.inst.environment,
        });
        const fbReservation = await reserveAiBudgetAtomic(db, {
          reservationKey: `job:${job.id}:a${attemptNum}:fallback`,
          instanceId: fbEndpoint.inst.id,
          modelId: fbEndpoint.model.id,
          rateVersionId: fbEndpoint.rate?.id ?? null,
          purposeCode: job.purpose_code,
          estimatedCents: fbReserveCents,
          actorUserId: job.created_by,
        });
        return { fbEndpoint, fbReservationId: fbReservation.id };
      });

      usedEndpoint = fbPrep.fbEndpoint;
      usedReservationId = fbPrep.fbReservationId;
      fbReservationId = fbPrep.fbReservationId;
      usedFallback = true;
      attemptedProviderCalls = 2;
      callResult = await executeStructuredTranslationCall(usedEndpoint.cfg, {
        requestedModelId: usedEndpoint.model.requested_model_id,
        sourceLocale: job.source_locale,
        targetLocale: job.target_locale,
        items: callInputItems,
        maxInputChars: route.max_input_chars,
        maxOutputTokens: Math.min(usedEndpoint.model.max_output_tokens, route.max_output_tokens),
        supportsStructuredOutput: usedEndpoint.model.supports_structured_output,
        supportsJsonObject: usedEndpoint.model.supports_json_object,
        systemPrompt,
      });
    } catch (err) {
      return failTranslationExecutionOnException({
        err,
        job,
        attemptNum,
        stage: "fallback",
        usedFallback: true,
        providerCalls: attemptedProviderCalls,
        cacheHits,
        uncachedItems,
        reservationId: fbReservationId,
        instanceId: usedFallback ? usedEndpoint.inst.id : route.fallback_instance_id,
        modelId: usedFallback ? usedEndpoint.model.id : route.fallback_model_id,
        rateId: usedFallback ? (usedEndpoint.rate?.id ?? null) : null,
        environment: usedEndpoint.inst.environment,
      });
    }
  }

  return transaction(async (db) => {
    const isTimeoutUnknown = callResult.status === "timeout_unknown";
    const costInfo = isTimeoutUnknown
      ? { costCents: null, costStatus: "unknown_pending" as const, currency: usedEndpoint.rate?.currency ?? "USD" }
      : callResult.ok || callResult.inputTokens !== null
        ? computeActualCostFromUsage({
            rate: usedEndpoint.rate,
            inputTokens: callResult.inputTokens,
            outputTokens: callResult.outputTokens,
            cachedInputTokens: callResult.cachedInputTokens,
            usageSource: callResult.usageSource,
          })
        : { costCents: 0, costStatus: "cache_zero" as const, currency: usedEndpoint.rate?.currency ?? "USD" };

    if (isTimeoutUnknown || (callResult.ok && costInfo.costStatus === "unknown_pending")) {
      await db.query(
        "update ai_budget_reservations set status = 'unknown_pending', settled_at = now() where id = $1",
        [usedReservationId],
      );
    } else if (costInfo.costCents !== null && costInfo.costCents > 0) {
      await db.query(
        "update ai_budget_reservations set status = 'settled', settled_cents = $2, settled_at = now() where id = $1",
        [usedReservationId, costInfo.costCents],
      );
    } else {
      await db.query(
        "update ai_budget_reservations set status = 'released', settled_cents = 0, settled_at = now() where id = $1",
        [usedReservationId],
      );
    }

    const inv = await one<{ id: string }>(
      db,
      `insert into ai_invocations (
         id, attempt_key, logical_task_id, reservation_id, instance_id, model_id, rate_version_id,
         purpose_code, invocation_kind, environment, actor_user_id, entity_type, entity_id,
         cost_center, cost_attribution_id, source_locale, target_locale,
         provider_request_id, observed_model_snapshot, status, error_code, error_summary,
         used_fallback_route, input_tokens, output_tokens, cached_input_tokens,
         usage_source, cost_cents, cost_status, currency, duration_ms
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,'production_translation',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       returning id`,
      [
        uuid(),
        `job:${job.id}:a${attemptNum}:${usedFallback ? "fallback" : "primary"}`,
        job.id,
        usedReservationId,
        usedEndpoint.inst.id,
        usedEndpoint.model.id,
        usedEndpoint.rate?.id ?? null,
        job.purpose_code,
        usedEndpoint.inst.environment,
        job.created_by,
        job.entity_type,
        job.entity_id,
        job.cost_center,
        job.cost_attribution_id ?? null,
        job.source_locale,
        job.target_locale,
        callResult.providerRequestId,
        callResult.observedModelSnapshot,
        callResult.status,
        callResult.errorCode,
        callResult.errorSummary,
        usedFallback,
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

    let rejectedCount = 0;
    let needsReviewCount = cachedNeedsReviewCount;
    let succeededCount = cacheHits - cachedNeedsReviewCount;

    if (!callResult.ok) {
      for (const it of uncachedItems) {
        await db.query(
          `update ai_translation_job_items
           set candidate_status = 'rejected', invocation_id = $2,
               semantic_violations = $3::jsonb, status = 'failed', updated_at = now()
           where id = $1`,
          [it.id, inv.id, JSON.stringify([{ code: callResult.errorCode ?? "AI_CALL_FAILED", message: callResult.errorSummary ?? "Call failed." }])],
        );
      }
      const nextJobStatus = isTimeoutUnknown ? "unknown_outcome" : "failed";
      await db.query(
        `update ai_translation_jobs
         set status = $2, used_fallback_route = $3, cache_hits = cache_hits + $4, provider_calls = provider_calls + $5,
             last_error_code = $6, last_error_summary = $7, lease_token = null, lease_owner = null,
             completed_at = now(), updated_at = now()
         where id = $1`,
        [job.id, nextJobStatus, usedFallback, cacheHits, attemptedProviderCalls, callResult.errorCode, callResult.errorSummary],
      );
      return { skip: false, status: nextJobStatus, invocation_id: inv.id };
    }

    const outByField = new Map(callResult.items.map((o) => [o.field_id, o]));
    for (const it of uncachedItems) {
      const cand = outByField.get(String(it.field_id));
      if (!cand) {
        rejectedCount += 1;
        await db.query(
          `update ai_translation_job_items
           set candidate_text = null, candidate_status = 'rejected', invocation_id = $2,
               semantic_violations = $3::jsonb, status = 'failed', updated_at = now()
           where id = $1`,
          [
            it.id,
            inv.id,
            JSON.stringify([{ code: "AI_OUTPUT_MISSING_FIELD", message: `Model response omitted field_id '${it.field_id}'.` }]),
          ],
        );
        continue;
      }
      const semCheck = verifySemanticFactIntegrity({
        sourceText: String(it.source_text),
        candidateText: cand.translated_text,
        placeholders: (it.placeholders as string[]) ?? [],
        disallowedGlossaryTerms: disallowedTerms,
      });

      if (!semCheck.ok) {
        rejectedCount += 1;
        await db.query(
          `update ai_translation_job_items
           set candidate_text = null, candidate_status = 'rejected', invocation_id = $2,
               semantic_violations = $3::jsonb, status = 'failed', updated_at = now()
           where id = $1`,
          [it.id, inv.id, JSON.stringify(semCheck.violations)],
        );
      } else {
        const finalCandStatus = route.requires_human_confirmation && cand.status === "translated" ? "needs_review" : cand.status;
        if (finalCandStatus === "translated") succeededCount += 1;
        else needsReviewCount += 1;

        await db.query(
          `update ai_translation_job_items
           set candidate_text = $2, candidate_status = $3, warnings = $4::jsonb,
               invocation_id = $5, semantic_violations = '[]'::jsonb,
               status = case when $3 = 'translated' then 'succeeded' else 'needs_review' end,
               updated_at = now()
           where id = $1`,
          [it.id, cand.translated_text, finalCandStatus, JSON.stringify(cand.warnings ?? []), inv.id],
        );

        const actualCacheKey = buildTranslationCacheKey({
          tenantScopeKey: job.tenant_scope_key,
          purposeCode: job.purpose_code,
          sourceLocale: job.source_locale,
          targetLocale: job.target_locale,
          sourceHash: String(it.source_hash),
          promptVersionId: prompt.id,
          routeVersionId: route.id,
          modelId: usedEndpoint.model.id,
          glossaryHash,
        });

        await db.query(
          `insert into ai_translation_cache (
             id, cache_key, tenant_scope_key, purpose_code, source_locale, target_locale,
             source_hash, prompt_version_id, route_version_id, model_id, glossary_hash,
             translated_text, status, warnings, expires_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,now() + interval '30 days')
           on conflict (cache_key) do nothing`,
          [
            uuid(),
            actualCacheKey,
            job.tenant_scope_key,
            job.purpose_code,
            job.source_locale,
            job.target_locale,
            it.source_hash,
            prompt.id,
            route.id,
            usedEndpoint.model.id,
            glossaryHash,
            cand.translated_text,
            finalCandStatus,
            JSON.stringify(cand.warnings ?? []),
          ],
        );
      }
    }

    const finalJobStatus =
      rejectedCount > 0 && succeededCount === 0 && needsReviewCount === 0
        ? "failed"
        : rejectedCount > 0 || needsReviewCount > 0 || route.requires_human_confirmation
          ? "needs_review"
          : "succeeded";

    await db.query(
      `update ai_translation_jobs
       set status = $2, used_fallback_route = $3, cache_hits = cache_hits + $4, provider_calls = provider_calls + $5,
           last_error_code = case when $6 > 0 then 'AI_SEMANTIC_GUARD_REJECTED' else null end,
           lease_token = null, lease_owner = null, completed_at = now(), updated_at = now()
       where id = $1`,
      [job.id, finalJobStatus, usedFallback, cacheHits, attemptedProviderCalls, rejectedCount],
    );

    return {
      skip: false,
      status: finalJobStatus,
      used_fallback_route: usedFallback,
      rejected_count: rejectedCount,
      cache_hits: cacheHits,
      invocation_id: inv.id,
    };
  });
}

export async function getTranslationJobDetail(db: DB, actor: Actor, jobId: string) {
  const job = await one<Record<string, any>>(db, "select * from ai_translation_jobs where id = $1", [jobId]);
  if (actor.kind === "customer") {
    guard(job.tenant_scope_key === `org:${actor.org}`, "FORBIDDEN", "Cannot view another customer's translation job.", 403);
  } else {
    role(actor, ...AI_VIEW_ROLES, "support", "inspector");
  }
  const items = (
    await db.query("select * from ai_translation_job_items where job_id = $1 order by field_id", [jobId])
  ).rows;
  return { job, items };
}

export async function cancelTranslationJob(db: DB, actor: Actor, jobId: string) {
  role(actor, "super_admin", "support", "template_admin", "reviewer");
  const job = await one<{ id: string; status: string }>(
    db,
    "select id, status from ai_translation_jobs where id = $1 for update",
    [jobId],
  );
  guard(
    ["queued", "retry_wait", "failed", "unknown_outcome"].includes(job.status),
    "RECORD_CONFLICT",
    `Job in status '${job.status}' cannot be cancelled.`,
    409,
  );
  const updated = await one(
    db,
    "update ai_translation_jobs set status = 'cancelled', updated_at = now(), completed_at = coalesce(completed_at, now()) where id = $1 returning *",
    [job.id],
  );
  await db.query("update ai_translation_job_items set status = 'cancelled', updated_at = now() where job_id = $1 and status in ('queued','failed')", [job.id]);
  await audit(db, actor, "ai_translation_job_cancelled", "ai_translation_jobs", job.id, { previous_status: job.status });
  return { job: updated };
}

export async function retryTranslationJob(
  db: DB,
  actor: Actor,
  jobId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin", "support", "template_admin", "reviewer");
  const input = retryTranslationJobSchema.parse(rawBody);
  const job = await one<{ id: string; status: string; purpose_code: string; attempts: number; max_attempts: number }>(
    db,
    "select id, status, purpose_code, attempts, max_attempts from ai_translation_jobs where id = $1 for update",
    [jobId],
  );
  guard(
    Number(job.attempts) < Number(job.max_attempts),
    "AI_JOB_MAX_ATTEMPTS_EXCEEDED",
    `Translation job exceeded max_attempts (${job.max_attempts}).`,
    409,
  );
  if (job.status === "unknown_outcome") {
    guard(
      input.confirm_unknown_retry && actor.roles.includes("super_admin"),
      "AI_UNKNOWN_OUTCOME_RETRY_REQUIRES_CONFIRMATION",
      "Unknown-outcome translation job requires super_admin explicit confirmation before retrying.",
      409,
    );
  } else {
    guard(job.status === "failed", "RECORD_CONFLICT", "Only failed or confirmed unknown_outcome jobs can be retried.", 409);
  }

  await db.query("update ai_translation_jobs set status = 'queued', updated_at = now(), completed_at = null where id = $1", [job.id]);
  await db.query("update ai_translation_job_items set status = 'queued', updated_at = now() where job_id = $1 and status = 'failed'", [job.id]);
  await db.query("insert into outbox_events(type, payload) values('ai.translate', $1::jsonb)", [
    JSON.stringify({ job_id: job.id, purpose_code: job.purpose_code }),
  ]);
  await audit(db, actor, "ai_translation_job_retried", "ai_translation_jobs", job.id, {
    previous_status: job.status,
  });
  return { job_id: job.id, status: "queued" };
}

export async function invalidateTenantTranslationCache(db: DB, actor: Actor, tenantScopeKey: string) {
  role(actor, "super_admin", "reviewer");
  const res = await db.query(
    "update ai_translation_cache set invalidated_at = now() where tenant_scope_key = $1 and invalidated_at is null",
    [tenantScopeKey],
  );
  await audit(db, actor, "ai_translation_cache_invalidated", "ai_translation_cache", null, {
    tenant_scope_key: tenantScopeKey,
    invalidated_count: res.rowCount ?? 0,
  });
  return { invalidated_count: res.rowCount ?? 0 };
}

export async function seedDefaultEvalCases(db: DB, actor: Actor) {
  role(actor, "super_admin", "reviewer");
  let inserted = 0;
  for (const c of DEFAULT_APPAREL_EVAL_CASES) {
    const res = await db.query(
      `insert into ai_translation_eval_cases (
         id, case_code, category_slug, purpose_code, risk_level, source_locale, target_locale,
         source_text, protected_tokens, must_preserve_semantics, forbidden_inferences,
         reference_translations, version, approved_by, created_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13)
       on conflict (case_code) do nothing`,
      [
        uuid(),
        c.case_code,
        c.category_slug,
        c.purpose_code,
        c.risk_level,
        c.source_locale,
        c.target_locale,
        c.source_text,
        c.protected_tokens,
        c.must_preserve_semantics,
        c.forbidden_inferences,
        c.reference_translations,
        actor.id,
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  await audit(db, actor, "ai_eval_cases_seeded", "ai_translation_eval_cases", null, { inserted });
  return { inserted };
}

export async function runTranslationEvalSuite(db: DB, actor: Actor, rawBody: Record<string, unknown>) {
  role(actor, "super_admin", "reviewer", "template_admin");
  const input = runEvalSuiteSchema.parse(rawBody);
  const route = input.route_version_id
    ? await one<{
        id: string;
        purpose_code: string;
        prompt_version_id: string;
        primary_model_id: string;
      }>(db, "select id, purpose_code, prompt_version_id, primary_model_id from ai_purpose_routes where id = $1", [
        input.route_version_id,
      ])
    : await one<{
        id: string;
        purpose_code: string;
        prompt_version_id: string;
        primary_model_id: string;
      }>(
        db,
        `select id, purpose_code, prompt_version_id, primary_model_id
         from ai_purpose_routes
         where purpose_code = $1 and status in ('published', 'draft')
         order by case when status = 'published' then 0 else 1 end, version desc
         limit 1`,
        [input.purpose_code],
      );
  guard(route.purpose_code === input.purpose_code, "INVALID_REQUEST", "Eval route_version_id does not match purpose_code.", 422);

  const cases = (
    await db.query<{
      case_code: string;
      source_text: string;
      protected_tokens: string[];
      forbidden_inferences: string[];
    }>(
      "select case_code, source_text, protected_tokens, forbidden_inferences from ai_translation_eval_cases where purpose_code = $1 order by case_code",
      [input.purpose_code],
    )
  ).rows;
  guard(cases.length > 0, "NOT_FOUND", `No eval cases registered for purpose '${input.purpose_code}'.`, 404);

  let passed = 0;
  let failed = 0;
  let factErrors = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const c of cases) {
    const candidate = input.candidates_by_case_code[c.case_code] ?? "";
    const sem = candidate.trim()
      ? verifySemanticFactIntegrity({
          sourceText: c.source_text,
          candidateText: candidate,
          protectedTokens: c.protected_tokens,
          forbiddenInferences: c.forbidden_inferences,
        })
      : { ok: false, violations: [{ code: "AI_OUTPUT_EMPTY", message: "No candidate provided for eval case." }] };

    if (sem.ok) {
      passed += 1;
    } else {
      failed += 1;
      factErrors += sem.violations.length;
    }
    details.push({
      case_code: c.case_code,
      ok: sem.ok,
      violations: sem.violations,
    });
  }

  const run = await one(
    db,
    `insert into ai_translation_eval_runs (
       id, purpose_code, route_version_id, prompt_version_id, model_id,
       total_cases, passed_semantic_guards, failed_semantic_guards, protected_fact_errors,
       details, automated_status, human_qa_status, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'pending_human_qa',$12)
     returning *`,
    [
      uuid(),
      input.purpose_code,
      route.id,
      route.prompt_version_id,
      route.primary_model_id,
      cases.length,
      passed,
      failed,
      factErrors,
      JSON.stringify(details),
      factErrors === 0 ? "passed" : "failed",
      actor.id,
    ],
  );
  await audit(db, actor, "ai_eval_run_executed", "ai_translation_eval_runs", run.id, {
    purpose_code: input.purpose_code,
    total_cases: cases.length,
    protected_fact_errors: factErrors,
  });
  return { eval_run: run };
}

export async function reviewEvalRunHumanQa(
  db: DB,
  actor: Actor,
  runId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "reviewer", "super_admin");
  const input = reviewEvalHumanQaSchema.parse(rawBody);
  const run = await one<{
    id: string;
    protected_fact_errors: number;
    created_by: string;
    human_qa_status: string;
  }>(db, "select * from ai_translation_eval_runs where id = $1 for update", [runId]);

  guard(run.created_by !== actor.id, "SOD_VIOLATION", "Eval runner cannot approve their own evaluation run.", 403);
  if (input.decision === "approved") {
    requireZeroProtectedFactErrors(run);
  }

  const updated = await one(
    db,
    `update ai_translation_eval_runs
     set human_qa_status = $2, human_qa_reviewer_id = $3,
         human_qa_notes = $4, human_qa_reviewed_at = now()
     where id = $1
     returning *`,
    [run.id, input.decision, actor.id, input.notes],
  );
  await audit(db, actor, `ai_eval_run_human_${input.decision}`, "ai_translation_eval_runs", run.id, {
    protected_fact_errors: run.protected_fact_errors,
  });
  return { eval_run: updated };
}

export async function listEvalRuns(db: DB, actor: Actor) {
  role(actor, ...AI_VIEW_ROLES);
  const runs = (await db.query("select * from ai_translation_eval_runs order by created_at desc limit 100")).rows;
  const cases = (await db.query("select * from ai_translation_eval_cases order by case_code")).rows;
  return { eval_runs: runs, eval_cases: cases };
}
