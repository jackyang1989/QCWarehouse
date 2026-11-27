import { z } from "zod";
import type { DB } from "../db";
import { AI_PURPOSE_CODES, type AiPurposeCode } from "./ai-contract";
import { estimateCallMaxCents, type AiInstanceRow, type AiRateRow } from "./ai-service";
import { enqueueTranslationJob } from "./ai-translation-service";
import { requireStaffMfa } from "./auth";
import { audit, guard, hash, one, Problem, role, uuid, type Actor } from "./common";
import { assertEnabledLocale, type EnabledLocale } from "./locale-contract";
import { recomputeBatchRunStatus } from "./translation-workflow-sync";

export const WORKFLOW_TRANSLATOR_ROLES = ["super_admin", "template_admin", "reviewer", "support"] as const;
export const WORKFLOW_REVIEW_ROLES = ["super_admin", "template_admin", "reviewer", "support"] as const;
export const WORKFLOW_BATCH_ROLES = ["super_admin", "template_admin"] as const;

const NON_TRANSLATABLE_FIELD_KEYS = new Set([
  "id",
  "entity_id",
  "sku_code",
  "price_cents",
  "unit_cents",
  "package_cents",
  "cost_cents",
  "region_code",
  "warehouse_code",
  "receiving_code",
  "tracking_no",
  "api_key",
  "currency",
  "code",
]);

const NON_TRANSLATABLE_PATTERN = /^(?:sku|price_cents|unit_cents|cost_cents|tracking_no|region_code|warehouse_code|receiving_code|api_key)/i;

function isTranslatableFieldKey(fieldKey: string): boolean {
  const norm = fieldKey.trim();
  return Boolean(norm) && !NON_TRANSLATABLE_FIELD_KEYS.has(norm) && !NON_TRANSLATABLE_PATTERN.test(norm);
}

export function assertTranslatableFieldKey(fieldKey: string) {
  guard(
    isTranslatableFieldKey(fieldKey),
    "NON_TRANSLATABLE_FIELD",
    `Field '${fieldKey}' holds non-translatable business IDs, pricing, or codes and cannot be translated.`,
    422,
  );
}

export const requestTranslationSchema = z.object({
  mode: z.enum(["auto_blur", "single_field", "whole_form", "force_retranslate"]).default("single_field"),
  purpose_code: z.enum(AI_PURPOSE_CODES).default("KNOWLEDGE_TRANSLATION_DRAFT"),
  entity_type: z.string().trim().min(2).max(64),
  entity_id: z.uuid(),
  source_locale: z.string().trim().min(2).max(24).default("zh-CN"),
  target_locale: z.string().trim().min(2).max(24).default("en-US"),
  cost_center: z.enum(["order", "report", "ticket", "notification", "operating_expense"]).default("operating_expense"),
  fields: z
    .array(
      z.object({
        field_key: z.string().trim().min(1).max(80),
        source_revision: z.number().int().min(1).default(1),
        source_text: z.string().trim().min(1).max(10000),
        placeholders: z.array(z.string().trim().min(1).max(64)).default([]),
      }),
    )
    .min(1)
    .max(40),
});

export const applyCandidateSchema = z.object({
  expected_revision: z.number().int().min(1).optional(),
  edited_text: z.string().trim().min(1).max(10000).optional(),
  confirm_overwrite_human_lock: z.boolean().default(false),
  lock_human: z.boolean().optional(),
  submit_for_review: z.boolean().default(true),
});

export const publishCheckSchema = z.object({
  entity_type: z.string().trim().min(2).max(64),
  entity_id: z.uuid(),
  required_fields: z.array(z.string().trim().min(1).max(80)).min(1),
  required_locales: z.array(z.string().trim().min(2).max(24)).min(1),
});

export const publishEntityTranslationsSchema = publishCheckSchema.extend({
  source_locale: z.string().trim().min(2).max(24).optional(),
});

export const previewBatchSchema = z.object({
  purpose_code: z.enum(AI_PURPOSE_CODES).default("KNOWLEDGE_TRANSLATION_DRAFT"),
  source_locale: z.string().trim().min(2).max(24).default("zh-CN"),
  target_locale: z.string().trim().min(2).max(24).default("en-US"),
  entity_types: z.array(z.string().trim().min(2).max(64)).default([]),
  only_missing_or_stale: z.boolean().default(true),
  protect_human_locked: z.boolean().default(true),
  items: z
    .array(
      z.object({
        entity_type: z.string().trim().min(2).max(64),
        entity_id: z.uuid(),
        field_key: z.string().trim().min(1).max(80),
        source_revision: z.number().int().min(1).default(1),
        source_text: z.string().trim().min(1).max(10000),
      }),
    )
    .optional(),
});

export const createBatchSchema = previewBatchSchema.extend({
  idempotency_key: z.string().trim().min(6).max(200),
});

type GlossaryRow = {
  id: string;
  term_key: string;
  source_term: string;
  target_term: string;
  approved_by: string | null;
};

async function matchApprovedGlossaryForText(
  db: DB,
  domain: string,
  srcLoc: EnabledLocale,
  tgtLoc: EnabledLocale,
  sourceText: string,
): Promise<{ exact: GlossaryRow | null; matched: Array<{ term_key: string; source_term: string; target_term: string }> }> {
  const rows = (
    await db.query<GlossaryRow>(
      `select distinct on (term_key) id, term_key, source_term, target_term, approved_by
       from ai_glossary_terms
       where domain = $1 and source_locale = $2 and target_locale = $3 and status = 'approved'
       order by term_key, version desc`,
      [domain, srcLoc, tgtLoc],
    )
  ).rows;

  const lowerSrc = sourceText.trim().toLowerCase();
  const exact = rows.find((r) => r.source_term.trim().toLowerCase() === lowerSrc) ?? null;
  const matched = rows
    .filter((r) => lowerSrc.includes(r.source_term.trim().toLowerCase()))
    .map((r) => ({ term_key: r.term_key, source_term: r.source_term, target_term: r.target_term }));
  return { exact, matched };
}

export async function requestFieldOrFormTranslation(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...WORKFLOW_TRANSLATOR_ROLES);
  const input = requestTranslationSchema.parse(rawBody);
  const srcLoc = assertEnabledLocale(input.source_locale);
  const tgtLoc = assertEnabledLocale(input.target_locale);
  guard(srcLoc !== tgtLoc, "INVALID_REQUEST", "Source and target locales must differ.", 422);

  const seenFields = new Set<string>();
  for (const f of input.fields) {
    assertTranslatableFieldKey(f.field_key);
    guard(!seenFields.has(f.field_key), "INVALID_REQUEST", `Duplicate field_key '${f.field_key}' in request.`, 422);
    seenFields.add(f.field_key);
  }

  const route = (
    await db.query<Record<string, any>>(
      "select * from ai_purpose_routes where purpose_code = $1 and status = 'published' limit 1",
      [input.purpose_code],
    )
  ).rows[0];
  const glossaryDomain = String(route?.glossary_domain ?? "apparel_qc");

  const glossaryApplied: Array<Record<string, unknown>> = [];
  const skippedProtected: Array<Record<string, unknown>> = [];
  const deduplicated: Array<Record<string, unknown>> = [];
  const pendingAiFields: Array<{
    field_key: string;
    source_revision: number;
    source_text: string;
    source_hash: string;
    placeholders: string[];
    expected_target_revision: number | null;
    matched_glossary: Array<{ term_key: string; source_term: string; target_term: string }>;
    latest: Record<string, any> | undefined;
  }> = [];

  for (const f of input.fields) {
    const srcHash = hash(f.source_text);
    const latest = (
      await db.query<Record<string, any>>(
        `select * from i18n_dynamic_translations
         where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
         order by revision desc
         limit 1
         for update`,
        [input.entity_type, input.entity_id, f.field_key, tgtLoc],
      )
    ).rows[0];

    if (
      latest &&
      latest.source_hash !== srcHash &&
      ["machine_draft", "human_draft", "pending_review", "approved", "published"].includes(String(latest.status))
    ) {
      await db.query(
        "update i18n_dynamic_translations set status = 'stale', published_at = null, updated_at = now() where id = $1",
        [latest.id],
      );
      latest.status = "stale";
    }

    const { exact, matched } = await matchApprovedGlossaryForText(db, glossaryDomain, srcLoc, tgtLoc, f.source_text);

    // Protect BOTH human_locked (regardless of source_hash) and same-source human/reviewed rows
    const isHumanLocked = Boolean(latest?.human_locked);
    const sameSourceHumanProtected =
      Boolean(latest) &&
      latest!.source_hash === srcHash &&
      ["human_draft", "pending_review", "approved", "published"].includes(String(latest!.status));
    const isProtectedForAutoOverwrite = isHumanLocked || sameSourceHumanProtected;

    if (input.mode === "auto_blur" && latest) {
      if (
        isProtectedForAutoOverwrite ||
        (latest.source_hash === srcHash && ["machine_draft", "queued"].includes(String(latest.status)))
      ) {
        skippedProtected.push({ field_key: f.field_key, reason: "already_exists_or_protected", status: latest.status });
        continue;
      }
    }

    if (input.mode === "whole_form" && isProtectedForAutoOverwrite) {
      skippedProtected.push({ field_key: f.field_key, reason: "human_or_approved_protected", status: latest!.status });
      continue;
    }

    // Exact glossary hit short-circuits AI spending; stage as candidate instead of overwriting if protected
    if (exact) {
      if (!isProtectedForAutoOverwrite) {
        const nextRev = Number(latest?.revision ?? 0) + 1;
        const inserted = await one(
          db,
          `insert into i18n_dynamic_translations (
             id, entity_type, entity_id, field_key, locale, revision,
             source_locale, source_revision, source_hash, source_text, translated_text,
             status, translator_kind, human_locked, purpose_code, glossary_matched,
             created_by, approved_by, approved_at, updated_by
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved','human',false,$12,$13::jsonb,$14,$15,now(),$14)
           returning *`,
          [
            uuid(),
            input.entity_type,
            input.entity_id,
            f.field_key,
            tgtLoc,
            nextRev,
            srcLoc,
            f.source_revision,
            srcHash,
            f.source_text,
            exact.target_term,
            input.purpose_code,
            JSON.stringify(matched),
            actor.id,
            exact.approved_by ?? actor.id,
          ],
        );
        glossaryApplied.push({ field_key: f.field_key, translation_id: inserted.id, term_key: exact.term_key });
        continue;
      }

      if (latest && (input.mode === "single_field" || input.mode === "force_retranslate")) {
        await db.query(
          `update i18n_dynamic_translations
           set candidate_text = $2,
               candidate_source_hash = $3,
               candidate_source_revision = $4,
               candidate_status = 'pending_apply',
               glossary_matched = $5::jsonb,
               updated_by = $6,
               updated_at = now()
           where id = $1`,
          [latest.id, exact.target_term, srcHash, f.source_revision, JSON.stringify(matched), actor.id],
        );
        glossaryApplied.push({
          field_key: f.field_key,
          translation_id: latest.id,
          term_key: exact.term_key,
          staged_candidate: true,
        });
        continue;
      }
    }

    // Dedupe active queued/running AI item on same source_hash unless force_retranslate
    if (input.mode !== "force_retranslate") {
      const inflight = (
        await db.query<{ job_id: string; item_id: string }>(
          `select ji.job_id, ji.id as item_id
           from ai_translation_job_items ji
           join ai_translation_jobs j on j.id = ji.job_id
           where j.entity_type = $1
             and j.entity_id = $2
             and ji.field_id = $3
             and j.source_locale = $4
             and j.target_locale = $5
             and ji.source_hash = $6
             and j.purpose_code = $7
             and j.status in ('queued', 'running', 'retry_wait')
             and ji.status = 'queued'
           limit 1`,
          [input.entity_type, input.entity_id, f.field_key, srcLoc, tgtLoc, srcHash, input.purpose_code],
        )
      ).rows[0];
      if (inflight) {
        deduplicated.push({ field_key: f.field_key, job_id: inflight.job_id, item_id: inflight.item_id });
        continue;
      }
    }

    pendingAiFields.push({
      field_key: f.field_key,
      source_revision: f.source_revision,
      source_text: f.source_text,
      source_hash: srcHash,
      placeholders: f.placeholders,
      expected_target_revision: latest ? Number(latest.revision) : null,
      matched_glossary: matched,
      latest,
    });
  }

  if (pendingAiFields.length === 0) {
    return {
      queued: false,
      manual_fallback: false,
      glossary_applied: glossaryApplied,
      skipped_protected: skippedProtected,
      deduplicated,
      job: null,
    };
  }

  if (!route || !route.auto_enabled) {
    if (input.mode === "auto_blur") {
      return {
        queued: false,
        manual_fallback: true,
        reason: "AI_ROUTE_NOT_CONFIGURED",
        glossary_applied: glossaryApplied,
        skipped_protected: skippedProtected,
        deduplicated,
        job: null,
      };
    }
    throw new Problem(
      "AI_ROUTE_NOT_CONFIGURED",
      `No active automated route for '${input.purpose_code}'; enter manual translations directly.`,
      409,
    );
  }

  const jobKeySeed =
    input.mode === "force_retranslate"
      ? `${actor.id}:${uuid()}`
      : hash(
          JSON.stringify({
            entity_type: input.entity_type,
            entity_id: input.entity_id,
            purpose_code: input.purpose_code,
            srcLoc,
            tgtLoc,
            fields: pendingAiFields.map((f) => ({
              k: f.field_key,
              h: f.source_hash,
              r: f.source_revision,
              tr: f.expected_target_revision,
            })),
          }),
        );

  const enq = await enqueueTranslationJob(db, actor, {
    idempotency_key: `wf:${input.entity_id}:${jobKeySeed}`,
    purpose_code: input.purpose_code,
    tenant_scope_key: "internal:staff",
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    source_locale: srcLoc,
    target_locale: tgtLoc,
    cost_center: input.cost_center,
    items: pendingAiFields.map((f) => ({
      field_id: f.field_key,
      source_revision: f.source_revision,
      source_text: f.source_text,
      placeholders: f.placeholders,
      expected_target_revision: f.expected_target_revision,
    })),
  });

  const jobItemByField = new Map(enq.items.map((it) => [String(it.field_id), String(it.id)]));

  for (const f of pendingAiFields) {
    const jiId = jobItemByField.get(f.field_key) ?? null;
    if (!f.latest) {
      await db.query(
        `insert into i18n_dynamic_translations (
           id, entity_type, entity_id, field_key, locale, revision,
           source_locale, source_revision, source_hash, source_text, translated_text,
           status, translator_kind, human_locked, purpose_code, ai_job_id, ai_job_item_id,
           glossary_matched, created_by, updated_by
         ) values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,null,'queued','ai',false,$10,$11,$12,$13::jsonb,$14,$14)`,
        [
          uuid(),
          input.entity_type,
          input.entity_id,
          f.field_key,
          tgtLoc,
          srcLoc,
          f.source_revision,
          f.source_hash,
          f.source_text,
          input.purpose_code,
          enq.job.id,
          jiId,
          JSON.stringify(f.matched_glossary),
          actor.id,
        ],
      );
    } else if (
      f.latest.human_locked ||
      ["human_draft", "pending_review", "approved", "published"].includes(String(f.latest.status))
    ) {
      // Never mutate existing historical/protected/human rows in-place; attach candidate linkage only
      await db.query(
        `update i18n_dynamic_translations
         set candidate_job_item_id = $2, glossary_matched = $3::jsonb, updated_at = now()
         where id = $1`,
        [f.latest.id, jiId, JSON.stringify(f.matched_glossary)],
      );
    } else if (f.latest.status === "queued" && f.latest.source_hash === f.source_hash) {
      await db.query(
        `update i18n_dynamic_translations
         set purpose_code = $2, ai_job_id = $3, ai_job_item_id = $4,
             glossary_matched = $5::jsonb, updated_by = $6, updated_at = now()
         where id = $1`,
        [f.latest.id, input.purpose_code, enq.job.id, jiId, JSON.stringify(f.matched_glossary), actor.id],
      );
    } else {
      // Historical stale/failed/untranslated/machine_draft revision stays immutable; append clean new queued revision!
      await db.query(
        `insert into i18n_dynamic_translations (
           id, entity_type, entity_id, field_key, locale, revision,
           source_locale, source_revision, source_hash, source_text, translated_text,
           status, translator_kind, human_locked, purpose_code, ai_job_id, ai_job_item_id,
           glossary_matched, created_by, updated_by
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,'queued','ai',false,$11,$12,$13,$14::jsonb,$15,$15)`,
        [
          uuid(),
          input.entity_type,
          input.entity_id,
          f.field_key,
          tgtLoc,
          Number(f.latest.revision) + 1,
          srcLoc,
          f.source_revision,
          f.source_hash,
          f.source_text,
          input.purpose_code,
          enq.job.id,
          jiId,
          JSON.stringify(f.matched_glossary),
          actor.id,
        ],
      );
    }
  }

  return {
    queued: true,
    manual_fallback: false,
    glossary_applied: glossaryApplied,
    skipped_protected: skippedProtected,
    deduplicated,
    job: enq.job,
    items: enq.items,
  };
}

export async function getTranslationDiff(db: DB, actor: Actor, translationId: string) {
  role(actor, ...WORKFLOW_TRANSLATOR_ROLES);
  const row = await one<Record<string, any>>(db, "select * from i18n_dynamic_translations where id = $1", [
    translationId,
  ]);
  const history = (
    await db.query(
      `select id, revision, status, translator_kind, human_locked, source_revision, source_hash,
              translated_text, candidate_status, created_by, approved_by, created_at, updated_at
       from i18n_dynamic_translations
       where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
       order by revision desc
       limit 20`,
      [row.entity_type, row.entity_id, row.field_key, row.locale],
    )
  ).rows;
  return {
    translation: row,
    source_text: row.source_text ?? null,
    current_text: row.translated_text ?? null,
    candidate_text: row.candidate_text ?? null,
    candidate_status: row.candidate_status ?? null,
    source_changed_since_candidate: Boolean(
      row.candidate_source_hash && row.source_hash && row.candidate_source_hash !== row.source_hash,
    ),
    history,
  };
}

export async function applyTranslationCandidate(
  db: DB,
  actor: Actor,
  translationId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...WORKFLOW_REVIEW_ROLES);
  const input = applyCandidateSchema.parse(rawBody);
  const target = await one<Record<string, any>>(
    db,
    "select * from i18n_dynamic_translations where id = $1 for update",
    [translationId],
  );
  const latest = await one<Record<string, any>>(
    db,
    `select * from i18n_dynamic_translations
     where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
     order by revision desc
     limit 1
     for update`,
    [target.entity_type, target.entity_id, target.field_key, target.locale],
  );

  if (input.expected_revision !== undefined) {
    guard(
      Number(latest.revision) === input.expected_revision,
      "REVISION_CONFLICT",
      `Concurrent update detected: expected revision ${input.expected_revision}, actual ${latest.revision}.`,
      409,
    );
  }

  const nextText = input.edited_text ?? target.candidate_text;
  guard(Boolean(nextText && String(nextText).trim()), "INVALID_REQUEST", "No candidate or edited text available to apply.", 422);

  if (!input.edited_text) {
    guard(
      target.candidate_status !== "stale_candidate" &&
        (!target.candidate_source_hash || target.candidate_source_hash === latest.source_hash),
      "STALE_TRANSLATION_CANDIDATE",
      "Source text changed after this candidate was generated; trigger a fresh translation before applying.",
      409,
    );
    guard(
      target.candidate_status === "pending_apply",
      "RECORD_CONFLICT",
      `Candidate in status '${String(target.candidate_status ?? "none")}' cannot be applied (already applied, rejected, or missing).`,
      409,
    );
  }

  if (latest.human_locked) {
    guard(
      input.confirm_overwrite_human_lock,
      "HUMAN_TRANSLATION_LOCKED",
      "Existing translation is human-locked; explicit confirm_overwrite_human_lock=true is required.",
      409,
    );
  }

  const isHumanEdit = Boolean(input.edited_text);
  const nextStatus = input.submit_for_review
    ? "pending_review"
    : isHumanEdit
      ? "human_draft"
      : "machine_draft";
  const nextHumanLocked = input.lock_human ?? (isHumanEdit ? true : Boolean(latest.human_locked));

  const newRow = await one(
    db,
    `insert into i18n_dynamic_translations (
       id, entity_type, entity_id, field_key, locale, revision,
       source_locale, source_revision, source_hash, source_text, translated_text,
       status, translator_kind, human_locked, purpose_code, ai_job_id, ai_job_item_id,
       glossary_matched, created_by, updated_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$19)
     returning *`,
    [
      uuid(),
      latest.entity_type,
      latest.entity_id,
      latest.field_key,
      latest.locale,
      Number(latest.revision) + 1,
      latest.source_locale,
      latest.source_revision,
      latest.source_hash,
      latest.source_text ?? null,
      String(nextText),
      nextStatus,
      isHumanEdit ? "human" : "ai",
      nextHumanLocked,
      latest.purpose_code ?? null,
      target.ai_job_id ?? null,
      target.ai_job_item_id ?? null,
      JSON.stringify(latest.glossary_matched ?? []),
      actor.id,
    ],
  );

  await db.query(
    "update i18n_dynamic_translations set candidate_status = 'applied', updated_at = now() where id = $1",
    [target.id],
  );

  await audit(db, actor, "translation_candidate_applied", "i18n_dynamic_translations", newRow.id, {
    entity_type: latest.entity_type,
    entity_id: latest.entity_id,
    field_key: latest.field_key,
    locale: latest.locale,
    revision: Number(latest.revision) + 1,
    human_edited: isHumanEdit,
  });

  return { translation: newRow };
}

export async function rejectTranslationCandidate(db: DB, actor: Actor, translationId: string) {
  role(actor, ...WORKFLOW_REVIEW_ROLES);
  const row = await one(
    db,
    `update i18n_dynamic_translations
     set candidate_status = 'rejected', updated_by = $2, updated_at = now()
     where id = $1
     returning *`,
    [translationId, actor.id],
  );
  await audit(db, actor, "translation_candidate_rejected", "i18n_dynamic_translations", row.id, {
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    field_key: row.field_key,
    locale: row.locale,
  });
  return { translation: row };
}

export async function assertRequiredLocalesReadyForPublish(
  db: DB,
  actor: Actor,
  entityType: string,
  entityId: string,
  requiredFields: readonly string[],
  requiredLocales: readonly string[],
) {
  role(actor, ...WORKFLOW_REVIEW_ROLES);
  const normalizedLocales = requiredLocales.map((l) => assertEnabledLocale(l));
  const blockers: Array<{ field_key: string; locale: string; status: string; reason: string }> = [];
  const latestRows: Record<string, any>[] = [];

  for (const fieldKey of requiredFields) {
    assertTranslatableFieldKey(fieldKey);
    for (const locale of normalizedLocales) {
      const latest = (
        await db.query<Record<string, any>>(
          `select * from i18n_dynamic_translations
           where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
           order by revision desc
           limit 1`,
          [entityType, entityId, fieldKey, locale],
        )
      ).rows[0];
      if (!latest) {
        blockers.push({ field_key: fieldKey, locale, status: "missing", reason: "No translation record exists." });
        continue;
      }
      if (!latest.translated_text || !String(latest.translated_text).trim()) {
        blockers.push({ field_key: fieldKey, locale, status: latest.status, reason: "Translated text is empty." });
        continue;
      }
      if (!["approved", "published"].includes(latest.status)) {
        blockers.push({
          field_key: fieldKey,
          locale,
          status: latest.status,
          reason: `Status '${latest.status}' is not approved/published.`,
        });
        continue;
      }
      latestRows.push(latest);
    }
  }

  return { ready: blockers.length === 0, blockers, latestRows };
}

export async function publishEntityTranslations(db: DB, actor: Actor, rawBody: Record<string, unknown>) {
  role(actor, "reviewer", "super_admin");
  const input = publishEntityTranslationsSchema.parse(rawBody);
  const normalizedLocales = input.required_locales.map((l) => assertEnabledLocale(l));
  const blockers: Array<{ field_key: string; locale: string; status: string; reason: string }> = [];
  const toPublishIds: string[] = [];

  for (const fieldKey of input.required_fields) {
    assertTranslatableFieldKey(fieldKey);
    for (const locale of normalizedLocales) {
      const latest = (
        await db.query<Record<string, any>>(
          `select * from i18n_dynamic_translations
           where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
           order by revision desc
           limit 1
           for update`,
          [input.entity_type, input.entity_id, fieldKey, locale],
        )
      ).rows[0];
      if (!latest || !latest.translated_text?.trim()) {
        blockers.push({ field_key: fieldKey, locale, status: latest?.status ?? "missing", reason: "Missing or empty translation." });
        continue;
      }
      if (["untranslated", "queued", "stale", "failed", "machine_draft"].includes(latest.status)) {
        blockers.push({
          field_key: fieldKey,
          locale,
          status: latest.status,
          reason: `Cannot publish field in '${latest.status}' state; review/approve first.`,
        });
        continue;
      }
      if (latest.status !== "published") {
        guard(
          latest.created_by !== actor.id,
          "SOD_VIOLATION",
          `Separation of duties forbids publishing field '${fieldKey}' (${locale}) that you authored.`,
          403,
        );
        toPublishIds.push(latest.id);
      }
    }
  }

  guard(
    blockers.length === 0,
    "LOCALE_PUBLICATION_BLOCKED",
    `Cannot publish '${input.entity_type}' until required locale fields are complete and reviewed.`,
    409,
  );

  for (const id of toPublishIds) {
    await db.query(
      `update i18n_dynamic_translations
       set status = 'published',
           approved_by = coalesce(approved_by, $2),
           approved_at = coalesce(approved_at, now()),
           published_at = now(),
           updated_by = $2,
           updated_at = now()
       where id = $1`,
      [id, actor.id],
    );
  }

  await audit(db, actor, "entity_translations_published", input.entity_type, input.entity_id, {
    published_count: toPublishIds.length,
    locales: normalizedLocales,
  });

  return { published_count: toPublishIds.length, blockers: [] };
}

type BatchCandidateItem = {
  entity_type: string;
  entity_id: string;
  field_key: string;
  source_revision: number;
  source_hash: string;
  source_text: string;
  expected_target_revision: number | null;
  glossary_match: GlossaryRow | null;
};

async function collectBatchCandidates(
  db: DB,
  input: z.output<typeof previewBatchSchema>,
  srcLoc: EnabledLocale,
  tgtLoc: EnabledLocale,
) {
  const route = (
    await db.query<Record<string, any>>(
      "select * from ai_purpose_routes where purpose_code = $1 and status = 'published' limit 1",
      [input.purpose_code],
    )
  ).rows[0];
  const glossaryDomain = String(route?.glossary_domain ?? "apparel_qc");

  const rawItems: Array<{
    entity_type: string;
    entity_id: string;
    field_key: string;
    source_revision: number;
    source_text: string;
  }> = [];

  if (input.items && input.items.length > 0) {
    for (const it of input.items) {
      assertTranslatableFieldKey(it.field_key);
      rawItems.push(it);
    }
  } else {
    const typeFilter = input.entity_types.length > 0;
    const rows = (
      await db.query<{
        entity_type: string;
        entity_id: string;
        field_key: string;
        source_revision: number;
        source_text: string | null;
      }>(
        `with latest as (
           select distinct on (entity_type, entity_id, field_key)
                  entity_type, entity_id, field_key, source_revision, source_text, status
           from i18n_dynamic_translations
           where locale = $1 and source_locale = $2 and source_text is not null
             ${typeFilter ? "and entity_type = any($3::text[])" : ""}
           order by entity_type, entity_id, field_key, revision desc
         )
         select entity_type, entity_id, field_key, source_revision, source_text from latest`,
        typeFilter ? [tgtLoc, srcLoc, input.entity_types] : [tgtLoc, srcLoc],
      )
    ).rows;
    for (const r of rows) {
      if (r.source_text && isTranslatableFieldKey(r.field_key)) {
        rawItems.push({
          entity_type: r.entity_type,
          entity_id: r.entity_id,
          field_key: r.field_key,
          source_revision: r.source_revision,
          source_text: r.source_text,
        });
      }
    }
  }

  const queuedItems: BatchCandidateItem[] = [];
  let skippedProtected = 0;
  let glossaryHits = 0;
  let estimatedInputChars = 0;

  for (const it of rawItems) {
    const srcHash = hash(it.source_text);
    const latest = (
      await db.query<{
        revision: number;
        source_hash: string;
        status: string;
        human_locked: boolean;
      }>(
        `select revision, source_hash, status, human_locked
         from i18n_dynamic_translations
         where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
         order by revision desc
         limit 1`,
        [it.entity_type, it.entity_id, it.field_key, tgtLoc],
      )
    ).rows[0];

    const isProtected = Boolean(
      latest &&
        (latest.human_locked ||
          (input.only_missing_or_stale &&
            latest.source_hash === srcHash &&
            ["approved", "published", "human_draft", "pending_review"].includes(latest.status))),
    );

    if (input.protect_human_locked && isProtected) {
      skippedProtected += 1;
      continue;
    }

    const { exact } = await matchApprovedGlossaryForText(db, glossaryDomain, srcLoc, tgtLoc, it.source_text);
    if (exact) {
      glossaryHits += 1;
    } else {
      estimatedInputChars += it.source_text.length;
    }
    queuedItems.push({
      ...it,
      source_hash: srcHash,
      expected_target_revision: latest ? latest.revision : null,
      glossary_match: exact,
    });
  }

  let estimatedCostCents: number | null = null;
  let estimateCurrency = "USD";
  let estimateDisclaimer =
    "No active published purpose route found; configure a published route first or fill manually.";
  const aiItemCount = Math.max(0, queuedItems.length - glossaryHits);

  if (aiItemCount === 0 && queuedItems.length > 0) {
    estimatedCostCents = 0;
    estimateDisclaimer = "All pending items matched approved glossary definitions with 0 external AI spend.";
  } else if (route) {
    const rate = (
      await db.query<AiRateRow>(
        "select * from ai_model_rate_versions where model_id = $1 order by version desc limit 1",
        [route.primary_model_id],
      )
    ).rows[0];
    const pInst = (
      await db.query<AiInstanceRow>("select * from ai_provider_instances where id = $1", [route.primary_instance_id])
    ).rows[0];

    if (!rate || rate.rate_source === "unknown") {
      estimatedCostCents = null;
      estimateCurrency = rate?.currency ?? "USD";
      estimateDisclaimer =
        "Primary model rate is unknown/unconfigured; real cost cannot be estimated in advance.";
    } else {
      const estInputTokens = Math.ceil(estimatedInputChars / 3) + aiItemCount * 40;
      const estOutputTokens = Math.ceil(estimatedInputChars / 2) + aiItemCount * 40;
      estimatedCostCents = estimateCallMaxCents({
        rate,
        maxInputTokens: estInputTokens,
        maxOutputTokens: estOutputTokens,
        environment: pInst?.environment ?? "production",
      });
      estimateCurrency = rate.currency;
      estimateDisclaimer =
        "Estimated ceiling only from current model rate version; actual settlement depends on provider token usage and may vary.";
    }
  }

  return {
    route,
    queuedItems,
    skippedProtected,
    glossaryHits,
    estimatedInputChars,
    estimatedCostCents,
    estimateCurrency,
    estimateDisclaimer,
  };
}

export async function previewTranslationBatch(db: DB, actor: Actor, rawBody: Record<string, unknown>) {
  role(actor, ...WORKFLOW_BATCH_ROLES);
  const input = previewBatchSchema.parse(rawBody);
  const srcLoc = assertEnabledLocale(input.source_locale);
  const tgtLoc = assertEnabledLocale(input.target_locale);
  guard(srcLoc !== tgtLoc, "INVALID_REQUEST", "Source and target locales must differ.", 422);

  const summary = await collectBatchCandidates(db, input, srcLoc, tgtLoc);
  return {
    total_to_process: summary.queuedItems.length,
    skipped_protected_items: summary.skippedProtected,
    glossary_hits: summary.glossaryHits,
    estimated_input_chars: summary.estimatedInputChars,
    estimated_cost_cents: summary.estimatedCostCents,
    estimate_currency: summary.estimateCurrency,
    estimate_disclaimer: summary.estimateDisclaimer,
    route_configured: Boolean(summary.route && summary.route.auto_enabled),
  };
}

async function enqueueBatchItemChunks(params: {
  db: DB;
  actor: Actor;
  batchId: string;
  purposeCode: AiPurposeCode;
  srcLoc: EnabledLocale;
  tgtLoc: EnabledLocale;
  keyPrefix: string;
  mode: "insert" | "retry_update";
  items: Array<{
    batch_item_id?: string;
    entity_type: string;
    entity_id: string;
    field_key: string;
    source_revision: number;
    source_hash: string;
    source_text: string;
    expected_target_revision: number | null;
  }>;
}) {
  const byEntity = new Map<string, typeof params.items>();
  for (const it of params.items) {
    const key = `${it.entity_type}:${it.entity_id}`;
    const list = byEntity.get(key) ?? [];
    list.push(it);
    byEntity.set(key, list);
  }

  const jobs: Record<string, any>[] = [];
  let chunkIndex = 0;

  for (const list of byEntity.values()) {
    for (let i = 0; i < list.length; i += 10) {
      chunkIndex += 1;
      const chunk = list.slice(i, i + 10);
      const first = chunk[0]!;
      const enq = await enqueueTranslationJob(params.db, params.actor, {
        idempotency_key: `${params.keyPrefix}:chunk-${chunkIndex}`,
        purpose_code: params.purposeCode,
        tenant_scope_key: "internal:staff",
        entity_type: first.entity_type,
        entity_id: first.entity_id,
        source_locale: params.srcLoc,
        target_locale: params.tgtLoc,
        cost_center: "operating_expense",
        items: chunk.map((c) => ({
          field_id: c.field_key,
          source_revision: c.source_revision,
          source_text: c.source_text,
          placeholders: [],
          expected_target_revision: c.expected_target_revision,
        })),
      });
      jobs.push(enq.job);
      const jiByField = new Map(enq.items.map((x) => [String(x.field_id), String(x.id)]));

      for (const c of chunk) {
        if (params.mode === "insert") {
          await params.db.query(
            `insert into translation_batch_run_items (
               id, batch_id, entity_type, entity_id, field_key, source_revision, source_hash,
               source_text, expected_target_revision, ai_job_id, ai_job_item_id, status
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued')`,
            [
              uuid(),
              params.batchId,
              c.entity_type,
              c.entity_id,
              c.field_key,
              c.source_revision,
              c.source_hash,
              c.source_text,
              c.expected_target_revision,
              enq.job.id,
              jiByField.get(c.field_key) ?? null,
            ],
          );
        } else {
          await params.db.query(
            `update translation_batch_run_items
             set ai_job_id = $2, ai_job_item_id = $3, status = 'queued',
                 error_code = null, error_summary = null, updated_at = now()
             where id = $1`,
            [c.batch_item_id, enq.job.id, jiByField.get(c.field_key) ?? null],
          );
        }
      }
    }
  }

  return jobs;
}

export async function createTranslationBatch(db: DB, actor: Actor, rawBody: Record<string, unknown>) {
  role(actor, ...WORKFLOW_BATCH_ROLES);
  const input = createBatchSchema.parse(rawBody);
  const srcLoc = assertEnabledLocale(input.source_locale);
  const tgtLoc = assertEnabledLocale(input.target_locale);
  guard(srcLoc !== tgtLoc, "INVALID_REQUEST", "Source and target locales must differ.", 422);

  const requestHash = hash(
    JSON.stringify({
      purpose_code: input.purpose_code,
      srcLoc,
      tgtLoc,
      entity_types: input.entity_types,
      only_missing_or_stale: input.only_missing_or_stale,
      protect_human_locked: input.protect_human_locked,
      items: input.items ?? null,
    }),
  );

  const existing = (
    await db.query("select * from translation_batch_runs where idempotency_key = $1", [input.idempotency_key])
  ).rows[0];
  if (existing) {
    guard(
      existing.request_hash === requestHash,
      "IDEMPOTENCY_CONFLICT",
      "Batch idempotency_key already used with different parameters.",
      409,
    );
    const items = (
      await db.query("select * from translation_batch_run_items where batch_id = $1 order by created_at", [existing.id])
    ).rows;
    return { batch: existing, items, deduplicated: true };
  }

  const summary = await collectBatchCandidates(db, input, srcLoc, tgtLoc);
  const aiItems = summary.queuedItems.filter((it) => !it.glossary_match);
  if (aiItems.length > 0) {
    guard(
      Boolean(summary.route && summary.route.auto_enabled),
      "AI_ROUTE_NOT_CONFIGURED",
      `No active automated route for '${input.purpose_code}'; configure route before launching AI batch.`,
      409,
    );
  }

  const batchId = uuid();
  const batch = await one(
    db,
    `insert into translation_batch_runs (
       id, idempotency_key, request_hash, purpose_code, source_locale, target_locale,
       entity_types, filter_statuses, only_missing_or_stale, protect_human_locked,
       total_items, skipped_protected_items, estimated_input_chars, estimated_cost_cents,
       estimate_currency, estimate_disclaimer, status, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     returning *`,
    [
      batchId,
      input.idempotency_key,
      requestHash,
      input.purpose_code,
      srcLoc,
      tgtLoc,
      input.entity_types,
      [],
      input.only_missing_or_stale,
      input.protect_human_locked,
      summary.queuedItems.length,
      summary.skippedProtected,
      summary.estimatedInputChars,
      summary.estimatedCostCents,
      summary.estimateCurrency,
      summary.estimateDisclaimer,
      aiItems.length === 0 ? "completed" : "queued",
      actor.id,
    ],
  );

  for (const gItem of summary.queuedItems.filter((it) => Boolean(it.glossary_match))) {
    const latest = (
      await db.query<{ revision: number }>(
        `select revision from i18n_dynamic_translations
         where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
         order by revision desc limit 1`,
        [gItem.entity_type, gItem.entity_id, gItem.field_key, tgtLoc],
      )
    ).rows[0];
    const appliedId = uuid();
    await db.query(
      `insert into i18n_dynamic_translations (
         id, entity_type, entity_id, field_key, locale, revision,
         source_locale, source_revision, source_hash, source_text, translated_text,
         status, translator_kind, human_locked, purpose_code, created_by, approved_by, approved_at, updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved','human',false,$12,$13,$14,now(),$13)`,
      [
        appliedId,
        gItem.entity_type,
        gItem.entity_id,
        gItem.field_key,
        tgtLoc,
        (latest?.revision ?? 0) + 1,
        srcLoc,
        gItem.source_revision,
        gItem.source_hash,
        gItem.source_text,
        gItem.glossary_match!.target_term,
        input.purpose_code,
        actor.id,
        gItem.glossary_match!.approved_by ?? actor.id,
      ],
    );
    await db.query(
      `insert into translation_batch_run_items (
         id, batch_id, entity_type, entity_id, field_key, source_revision, source_hash,
         source_text, expected_target_revision, applied_translation_id, status
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'applied')`,
      [
        uuid(),
        batchId,
        gItem.entity_type,
        gItem.entity_id,
        gItem.field_key,
        gItem.source_revision,
        gItem.source_hash,
        gItem.source_text,
        gItem.expected_target_revision,
        appliedId,
      ],
    );
  }

  await enqueueBatchItemChunks({
    db,
    actor,
    batchId,
    purposeCode: input.purpose_code,
    srcLoc,
    tgtLoc,
    keyPrefix: `batch:${batchId}`,
    mode: "insert",
    items: aiItems,
  });

  const insertedItems = (
    await db.query("select * from translation_batch_run_items where batch_id = $1 order by created_at", [batchId])
  ).rows;
  await audit(db, actor, "translation_batch_created", "translation_batch_runs", batchId, {
    purpose_code: input.purpose_code,
    total_items: summary.queuedItems.length,
    skipped_protected_items: summary.skippedProtected,
  });

  return { batch, items: insertedItems, deduplicated: false };
}

export async function listTranslationBatches(db: DB, actor: Actor) {
  role(actor, ...WORKFLOW_REVIEW_ROLES);
  const batches = (
    await db.query(
      `select b.*,
              count(i.id) filter (where i.status in ('applied','candidate_ready','skipped_protected','stale_candidate'))::int as done_count,
              count(i.id) filter (where i.status = 'failed')::int as failed_count,
              count(i.id) filter (where i.status in ('queued','running','paused'))::int as remaining_count
       from translation_batch_runs b
       left join translation_batch_run_items i on i.batch_id = b.id
       group by b.id
       order by b.created_at desc
       limit 100`,
    )
  ).rows;
  return { batches };
}

export async function getTranslationBatchDetail(db: DB, actor: Actor, batchId: string) {
  role(actor, ...WORKFLOW_REVIEW_ROLES);
  const batch = await one(db, "select * from translation_batch_runs where id = $1", [batchId]);
  const items = (
    await db.query("select * from translation_batch_run_items where batch_id = $1 order by created_at, field_key", [
      batchId,
    ])
  ).rows;
  return { batch, items };
}

export async function pauseTranslationBatch(db: DB, actor: Actor, batchId: string) {
  role(actor, ...WORKFLOW_BATCH_ROLES);
  const batch = await one<{ id: string; status: string }>(
    db,
    "select id, status from translation_batch_runs where id = $1 for update",
    [batchId],
  );
  guard(
    ["queued", "running"].includes(batch.status),
    "RECORD_CONFLICT",
    `Batch in status '${batch.status}' cannot be paused.`,
    409,
  );
  const updated = await one(
    db,
    "update translation_batch_runs set status = 'paused', paused_by = $2, paused_at = now(), updated_at = now() where id = $1 returning *",
    [batch.id, actor.id],
  );
  await db.query(
    "update translation_batch_run_items set status = 'paused', updated_at = now() where batch_id = $1 and status = 'queued'",
    [batch.id],
  );
  await audit(db, actor, "translation_batch_paused", "translation_batch_runs", batch.id, {});
  return { batch: updated };
}

export async function resumeTranslationBatch(db: DB, actor: Actor, batchId: string) {
  role(actor, ...WORKFLOW_BATCH_ROLES);
  const batch = await one<{ id: string; status: string; purpose_code: string }>(
    db,
    "select id, status, purpose_code from translation_batch_runs where id = $1 for update",
    [batchId],
  );
  guard(batch.status === "paused", "RECORD_CONFLICT", "Only paused batches can be resumed.", 409);

  await db.query(
    "update translation_batch_run_items set status = 'queued', updated_at = now() where batch_id = $1 and status = 'paused'",
    [batch.id],
  );
  const linkedJobs = (
    await db.query<{ ai_job_id: string }>(
      "select distinct ai_job_id from translation_batch_run_items where batch_id = $1 and ai_job_id is not null and status = 'queued'",
      [batch.id],
    )
  ).rows;
  for (const row of linkedJobs) {
    const job = (
      await db.query<{ status: string }>("select status from ai_translation_jobs where id = $1 for update", [
        row.ai_job_id,
      ])
    ).rows[0];
    if (job && ["retry_wait", "queued"].includes(job.status)) {
      await db.query("update ai_translation_jobs set status = 'queued', updated_at = now() where id = $1", [
        row.ai_job_id,
      ]);
      await db.query("insert into outbox_events(type, payload) values('ai.translate', $1::jsonb)", [
        JSON.stringify({ job_id: row.ai_job_id, purpose_code: batch.purpose_code }),
      ]);
    }
  }
  await db.query("update translation_batch_runs set status = 'running', updated_at = now() where id = $1", [batch.id]);
  await recomputeBatchRunStatus(db, batch.id);
  const updated = await one(db, "select * from translation_batch_runs where id = $1", [batch.id]);
  await audit(db, actor, "translation_batch_resumed", "translation_batch_runs", batch.id, {
    resumed_jobs: linkedJobs.length,
    resulting_status: updated.status,
  });
  return { batch: updated };
}

export async function cancelTranslationBatch(db: DB, actor: Actor, batchId: string) {
  role(actor, ...WORKFLOW_BATCH_ROLES);
  const batch = await one<{ id: string; status: string }>(
    db,
    "select id, status from translation_batch_runs where id = $1 for update",
    [batchId],
  );
  guard(
    !["completed", "cancelled"].includes(batch.status),
    "RECORD_CONFLICT",
    `Batch in status '${batch.status}' cannot be cancelled.`,
    409,
  );
  const updated = await one(
    db,
    "update translation_batch_runs set status = 'cancelled', cancelled_by = $2, cancelled_at = now(), completed_at = now(), updated_at = now() where id = $1 returning *",
    [batch.id, actor.id],
  );
  await db.query(
    "update translation_batch_run_items set status = 'cancelled', updated_at = now() where batch_id = $1 and status in ('queued','paused','failed')",
    [batch.id],
  );
  const linkedJobs = (
    await db.query<{ ai_job_id: string }>(
      "select distinct ai_job_id from translation_batch_run_items where batch_id = $1 and ai_job_id is not null",
      [batch.id],
    )
  ).rows;
  for (const r of linkedJobs) {
    await db.query(
      "update ai_translation_jobs set status = 'cancelled', last_error_code = 'BATCH_CANCELLED', updated_at = now(), completed_at = now() where id = $1 and status in ('queued','retry_wait')",
      [r.ai_job_id],
    );
    await db.query(
      "update ai_translation_job_items set status = 'cancelled', updated_at = now() where job_id = $1 and status = 'queued'",
      [r.ai_job_id],
    );
  }
  await audit(db, actor, "translation_batch_cancelled", "translation_batch_runs", batch.id, {});
  return { batch: updated };
}

export async function retryFailedBatchItems(db: DB, actor: Actor, batchId: string) {
  role(actor, ...WORKFLOW_BATCH_ROLES);
  const batch = await one<{
    id: string;
    purpose_code: AiPurposeCode;
    source_locale: EnabledLocale;
    target_locale: EnabledLocale;
    status: string;
  }>(db, "select id, purpose_code, source_locale, target_locale, status from translation_batch_runs where id = $1 for update", [
    batchId,
  ]);
  guard(batch.status !== "cancelled", "RECORD_CONFLICT", "Cancelled batch cannot retry failed items.", 409);

  const failedItems = (
    await db.query<{
      id: string;
      entity_type: string;
      entity_id: string;
      field_key: string;
      source_revision: number;
      source_hash: string;
      source_text: string;
      expected_target_revision: number | null;
    }>(
      "select id, entity_type, entity_id, field_key, source_revision, source_hash, source_text, expected_target_revision from translation_batch_run_items where batch_id = $1 and status = 'failed' order by created_at for update",
      [batch.id],
    )
  ).rows;
  guard(failedItems.length > 0, "RECORD_CONFLICT", "No failed items available to retry in this batch.", 409);

  const retryJobs = await enqueueBatchItemChunks({
    db,
    actor,
    batchId: batch.id,
    purposeCode: batch.purpose_code,
    srcLoc: batch.source_locale,
    tgtLoc: batch.target_locale,
    keyPrefix: `batch:${batch.id}:retry:${uuid()}`,
    mode: "retry_update",
    items: failedItems.map((f) => ({
      batch_item_id: f.id,
      entity_type: f.entity_type,
      entity_id: f.entity_id,
      field_key: f.field_key,
      source_revision: f.source_revision,
      source_hash: f.source_hash,
      source_text: f.source_text,
      expected_target_revision: f.expected_target_revision,
    })),
  });

  await recomputeBatchRunStatus(db, batch.id);
  await audit(db, actor, "translation_batch_retried", "translation_batch_runs", batch.id, {
    retried_items: failedItems.length,
    new_job_count: retryJobs.length,
  });
  return { retried_count: failedItems.length, jobs: retryJobs };
}

function escapeCsvFormulaAndQuote(raw: unknown): string {
  let s = raw === null || raw === undefined ? "" : String(raw);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportTranslationBatchCsv(
  db: DB,
  actor: Actor,
  sessionHash: string,
  batchId: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const batch = await one<{ id: string; purpose_code: string; target_locale: string }>(
    db,
    "select id, purpose_code, target_locale from translation_batch_runs where id = $1",
    [batchId],
  );
  const rows = (
    await db.query<{
      entity_type: string;
      entity_id: string;
      field_key: string;
      status: string;
      source_revision: number;
      source_text: string;
      error_code: string | null;
      translated_text: string | null;
    }>(
      `select bi.entity_type, bi.entity_id, bi.field_key, bi.status, bi.source_revision,
              bi.source_text, bi.error_code, dt.translated_text
       from translation_batch_run_items bi
       left join i18n_dynamic_translations dt on dt.id = bi.applied_translation_id
       where bi.batch_id = $1
       order by bi.created_at, bi.field_key`,
      [batch.id],
    )
  ).rows;

  const header = ["batch_id", "purpose_code", "target_locale", "entity_type", "entity_id", "field_key", "status", "source_revision", "source_text", "translated_text", "error_code"].join(",");
  const lines = rows.map((r) =>
    [
      batch.id,
      batch.purpose_code,
      batch.target_locale,
      r.entity_type,
      r.entity_id,
      r.field_key,
      r.status,
      r.source_revision,
      r.source_text,
      r.translated_text ?? "",
      r.error_code ?? "",
    ]
      .map(escapeCsvFormulaAndQuote)
      .join(","),
  );
  await audit(db, actor, "translation_batch_exported_csv", "translation_batch_runs", batch.id, {
    row_count: rows.length,
  });
  return {
    filename: `translation-batch-${batch.id}.csv`,
    csv: [header, ...lines].join("\r\n"),
  };
}
