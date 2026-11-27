import type { DB } from "../db";
import { uuid } from "./common";

/**
 * Synchronizes terminal/item outcomes of an executed `ai_translation_jobs` run back into:
 * 1) `i18n_dynamic_translations` (staging candidates without overwriting human-locked or concurrently modified rows), and
 * 2) `translation_batch_run_items` + `translation_batch_runs`.
 *
 * Strictly restricted to `tenant_scope_key = 'internal:staff'` jobs explicitly linked to dynamic
 * workflow placeholders, `candidate_job_item_id`, or `translation_batch_run_items` (never customer/ticket jobs).
 */
export async function syncCompletedTranslationJobToDynamicFields(db: DB, jobId: string): Promise<void> {
  const job = (
    await db.query<{
      id: string;
      tenant_scope_key: string;
      purpose_code: string;
      source_locale: string;
      target_locale: string;
      entity_type: string;
      entity_id: string;
      status: string;
      created_by: string;
      created_at: string;
      last_error_code: string | null;
      last_error_summary: string | null;
      requires_human_confirmation: boolean;
    }>(
      `select j.id, j.tenant_scope_key, j.purpose_code, j.source_locale, j.target_locale,
              j.entity_type, j.entity_id, j.status, j.created_by, j.created_at,
              j.last_error_code, j.last_error_summary, r.requires_human_confirmation
       from ai_translation_jobs j
       join ai_purpose_routes r on r.id = j.route_version_id
       where j.id = $1`,
      [jobId],
    )
  ).rows[0];
  if (!job) return;

  // Hard tenant/surface isolation: customer jobs or org-scoped scopes can NEVER write into global i18n_dynamic_translations
  if (job.tenant_scope_key !== "internal:staff") return;
  if (job.purpose_code === "SUPPORT_INBOUND_TRANSLATE" || job.purpose_code === "SUPPORT_OUTBOUND_TRANSLATE") return;

  const batchItemsExist =
    (
      await db.query<{ yes: boolean }>(
        "select exists(select 1 from translation_batch_run_items where ai_job_id = $1) as yes",
        [job.id],
      )
    ).rows[0]?.yes ?? false;

  const dynamicRowsExist =
    (
      await db.query<{ yes: boolean }>(
        `select exists(
           select 1 from i18n_dynamic_translations dt
           where dt.ai_job_id = $1
              or dt.candidate_job_item_id in (select id from ai_translation_job_items where job_id = $1)
         ) as yes`,
        [job.id],
      )
    ).rows[0]?.yes ?? false;

  if (!batchItemsExist && !dynamicRowsExist) return;

  const jobItems = (
    await db.query<{
      id: string;
      field_id: string;
      source_revision: number;
      source_hash: string;
      source_text: string;
      expected_target_revision: number | null;
      candidate_text: string | null;
      candidate_status: string | null;
      warnings: unknown;
      status: string;
    }>(
      "select id, field_id, source_revision, source_hash, source_text, expected_target_revision, candidate_text, candidate_status, warnings, status from ai_translation_job_items where job_id = $1 order by field_id",
      [job.id],
    )
  ).rows;

  const impactedBatchIds = new Set<string>();

  for (const ji of jobItems) {
    const batchItem = (
      await db.query<{ id: string; batch_id: string; batch_status: string }>(
        `select bi.id, bi.batch_id, b.status as batch_status
         from translation_batch_run_items bi
         join translation_batch_runs b on b.id = bi.batch_id
         where bi.ai_job_id = $1 and bi.ai_job_item_id = $2
         for update of bi`,
        [job.id, ji.id],
      )
    ).rows[0];
    if (batchItem) impactedBatchIds.add(batchItem.batch_id);

    const latestDyn = (
      await db.query<{
        id: string;
        revision: number;
        source_revision: number;
        source_hash: string;
        translated_text: string | null;
        status: string;
        human_locked: boolean;
        ai_job_id: string | null;
        created_at: string;
      }>(
        `select id, revision, source_revision, source_hash, translated_text, status, human_locked, ai_job_id, created_at
         from i18n_dynamic_translations
         where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
         order by revision desc
         limit 1
         for update`,
        [job.entity_type, job.entity_id, ji.field_id, job.target_locale],
      )
    ).rows[0];

    // If parent batch was cancelled before/during run, NEVER auto-apply late outputs (§53.10)
    if (batchItem?.batch_status === "cancelled" || ji.status === "cancelled" || job.status === "cancelled") {
      if (latestDyn && latestDyn.status === "queued" && latestDyn.ai_job_id === job.id) {
        await db.query(
          "update i18n_dynamic_translations set status = 'untranslated', updated_at = now() where id = $1",
          [latestDyn.id],
        );
      }
      if (batchItem) {
        await db.query(
          "update translation_batch_run_items set status = 'cancelled', updated_at = now() where id = $1 and status in ('queued','running','paused','failed')",
          [batchItem.id],
        );
      }
      continue;
    }

    if (ji.status === "failed" || !ji.candidate_text) {
      if (latestDyn && latestDyn.status === "queued" && latestDyn.ai_job_id === job.id) {
        await db.query(
          "update i18n_dynamic_translations set status = 'failed', updated_at = now() where id = $1",
          [latestDyn.id],
        );
      }
      if (batchItem) {
        await db.query(
          `update translation_batch_run_items
           set status = 'failed', error_code = $2, error_summary = $3, updated_at = now()
           where id = $1`,
          [batchItem.id, job.last_error_code ?? "AI_ITEM_FAILED", job.last_error_summary ?? "AI item failed."],
        );
      }
      continue;
    }

    const nextMachineStatus =
      job.requires_human_confirmation || ji.candidate_status === "needs_review" || ji.candidate_status === "ambiguous"
        ? "pending_review"
        : "machine_draft";

    const isOwnPlaceholder = Boolean(latestDyn && latestDyn.status === "queued" && latestDyn.ai_job_id === job.id);

    if (latestDyn && !isOwnPlaceholder) {
      const sourceDrifted =
        latestDyn.source_revision > ji.source_revision ||
        latestDyn.source_hash !== ji.source_hash;

      if (sourceDrifted) {
        // Late candidate arrival AFTER source text moved on: stage as stale_candidate, NEVER overwrite!
        await db.query(
          `update i18n_dynamic_translations
           set candidate_text = $2,
               candidate_source_hash = $3,
               candidate_source_revision = $4,
               candidate_status = 'stale_candidate',
               candidate_warnings = $5::jsonb,
               candidate_job_item_id = $6,
               updated_at = now()
           where id = $1`,
          [
            latestDyn.id,
            ji.candidate_text,
            ji.source_hash,
            ji.source_revision,
            JSON.stringify(ji.warnings ?? []),
            ji.id,
          ],
        );
        if (batchItem) {
          await db.query(
            "update translation_batch_run_items set status = 'stale_candidate', applied_translation_id = $2, updated_at = now() where id = $1",
            [batchItem.id, latestDyn.id],
          );
        }
        continue;
      }

      const concurrentRevisionMoved =
        ji.expected_target_revision !== null && latestDyn.revision !== ji.expected_target_revision;
      const isProtectedExisting =
        latestDyn.human_locked ||
        ["human_draft", "pending_review", "approved", "published"].includes(latestDyn.status);

      if (concurrentRevisionMoved || isProtectedExisting) {
        // Protect human/approved/concurrent translation: stage as pending_apply candidate only!
        await db.query(
          `update i18n_dynamic_translations
           set candidate_text = $2,
               candidate_source_hash = $3,
               candidate_source_revision = $4,
               candidate_status = 'pending_apply',
               candidate_warnings = $5::jsonb,
               candidate_job_item_id = $6,
               updated_at = now()
           where id = $1`,
          [
            latestDyn.id,
            ji.candidate_text,
            ji.source_hash,
            ji.source_revision,
            JSON.stringify(ji.warnings ?? []),
            ji.id,
          ],
        );
        if (batchItem) {
          await db.query(
            "update translation_batch_run_items set status = 'candidate_ready', applied_translation_id = $2, updated_at = now() where id = $1",
            [batchItem.id, latestDyn.id],
          );
        }
        continue;
      }

      // Safe to advance a non-human-locked stale/untranslated/failed/machine_draft field cleanly as revision + 1
      const newDynId = uuid();
      await db.query(
        `insert into i18n_dynamic_translations (
           id, entity_type, entity_id, field_key, locale, revision,
           source_locale, source_revision, source_hash, source_text, translated_text,
           status, translator_kind, human_locked, purpose_code, ai_job_id, ai_job_item_id,
           candidate_text, candidate_source_hash, candidate_source_revision, candidate_status,
           candidate_warnings, candidate_job_item_id, created_by, updated_by
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ai',false,$13,$14,$15,$11,$9,$8,'applied',$16::jsonb,$15,$17,$17)`,
        [
          newDynId,
          job.entity_type,
          job.entity_id,
          ji.field_id,
          job.target_locale,
          latestDyn.revision + 1,
          job.source_locale,
          ji.source_revision,
          ji.source_hash,
          ji.source_text,
          ji.candidate_text,
          nextMachineStatus,
          job.purpose_code,
          job.id,
          ji.id,
          JSON.stringify(ji.warnings ?? []),
          job.created_by,
        ],
      );
      if (batchItem) {
        await db.query(
          "update translation_batch_run_items set status = 'applied', applied_translation_id = $2, updated_at = now() where id = $1",
          [batchItem.id, newDynId],
        );
      }
      continue;
    }

    if (isOwnPlaceholder && latestDyn) {
      if (
        latestDyn.source_revision > ji.source_revision ||
        latestDyn.source_hash !== ji.source_hash ||
        latestDyn.human_locked
      ) {
        await db.query(
          `update i18n_dynamic_translations
           set candidate_text = $2,
               candidate_source_hash = $3,
               candidate_source_revision = $4,
               candidate_status = $5,
               candidate_warnings = $6::jsonb,
               candidate_job_item_id = $7,
               status = case when status = 'queued' then 'stale' else status end,
               updated_at = now()
           where id = $1`,
          [
            latestDyn.id,
            ji.candidate_text,
            ji.source_hash,
            ji.source_revision,
            latestDyn.human_locked ? "pending_apply" : "stale_candidate",
            JSON.stringify(ji.warnings ?? []),
            ji.id,
          ],
        );
        if (batchItem) {
          await db.query(
            "update translation_batch_run_items set status = $2, applied_translation_id = $3, updated_at = now() where id = $1",
            [batchItem.id, latestDyn.human_locked ? "candidate_ready" : "stale_candidate", latestDyn.id],
          );
        }
        continue;
      }

      await db.query(
        `update i18n_dynamic_translations
         set translated_text = $2,
             status = $3,
             candidate_text = $2,
             candidate_source_hash = $4,
             candidate_source_revision = $5,
             candidate_status = 'applied',
             candidate_warnings = $6::jsonb,
             candidate_job_item_id = $7,
             ai_job_item_id = $7,
             updated_at = now()
         where id = $1`,
        [
          latestDyn.id,
          ji.candidate_text,
          nextMachineStatus,
          ji.source_hash,
          ji.source_revision,
          JSON.stringify(ji.warnings ?? []),
          ji.id,
        ],
      );
      if (batchItem) {
        await db.query(
          "update translation_batch_run_items set status = 'applied', applied_translation_id = $2, updated_at = now() where id = $1",
          [batchItem.id, latestDyn.id],
        );
      }
      continue;
    }

    // No prior row existed (fresh batch item)
    const freshId = uuid();
    await db.query(
      `insert into i18n_dynamic_translations (
         id, entity_type, entity_id, field_key, locale, revision,
         source_locale, source_revision, source_hash, source_text, translated_text,
         status, translator_kind, human_locked, purpose_code, ai_job_id, ai_job_item_id,
         candidate_text, candidate_source_hash, candidate_source_revision, candidate_status,
         candidate_warnings, candidate_job_item_id, created_by, updated_by
       ) values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,'ai',false,$12,$13,$14,$10,$8,$7,'applied',$15::jsonb,$14,$16,$16)`,
      [
        freshId,
        job.entity_type,
        job.entity_id,
        ji.field_id,
        job.target_locale,
        job.source_locale,
        ji.source_revision,
        ji.source_hash,
        ji.source_text,
        ji.candidate_text,
        nextMachineStatus,
        job.purpose_code,
        job.id,
        ji.id,
        JSON.stringify(ji.warnings ?? []),
        job.created_by,
      ],
    );
    if (batchItem) {
      await db.query(
        "update translation_batch_run_items set status = 'applied', applied_translation_id = $2, updated_at = now() where id = $1",
        [batchItem.id, freshId],
      );
    }
  }

  for (const batchId of impactedBatchIds) {
    await recomputeBatchRunStatus(db, batchId);
  }
}

export async function recomputeBatchRunStatus(db: DB, batchId: string): Promise<void> {
  const batch = (
    await db.query<{ status: string }>("select status from translation_batch_runs where id = $1 for update", [batchId])
  ).rows[0];
  if (!batch || batch.status === "cancelled" || batch.status === "paused") return;

  const counts = (
    await db.query<{
      total: number;
      active: number;
      failed: number;
      done_ok: number;
    }>(
      `select count(*)::int as total,
              count(*) filter (where status in ('queued','running','paused'))::int as active,
              count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status in ('applied','candidate_ready','skipped_protected','stale_candidate'))::int as done_ok
       from translation_batch_run_items
       where batch_id = $1`,
      [batchId],
    )
  ).rows[0];

  if (!counts) return;

  let nextStatus = batch.status;
  let completed = false;
  if (counts.active > 0) {
    nextStatus = "running";
  } else if (counts.total === 0) {
    nextStatus = "completed";
    completed = true;
  } else if (counts.failed > 0 && counts.done_ok > 0) {
    nextStatus = "partial_failed";
    completed = true;
  } else if (counts.failed > 0 && counts.done_ok === 0) {
    nextStatus = "failed";
    completed = true;
  } else {
    nextStatus = "completed";
    completed = true;
  }

  await db.query(
    `update translation_batch_runs
     set status = $2,
         completed_at = case when $3 then now() else null end,
         updated_at = now()
     where id = $1`,
    [batchId, nextStatus, completed],
  );
}
