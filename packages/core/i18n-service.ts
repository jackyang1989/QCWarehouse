import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, guard, hash, one, Problem, role, uuid, type Actor } from "./common";
import { FIXED_I18N_RESOURCES } from "./i18n/messages";
import {
  assertEnabledLocale,
  normalizeLocaleTag,
  resolveAccountLocalePreferences,
  toLegacyDbLocale,
  validateFixedResourceBundle,
  type EnabledLocale,
} from "./locale-contract";

export const I18N_ADMIN_ROLES = ["super_admin", "template_admin", "reviewer"] as const;
export const I18N_TRANSLATOR_ROLES = ["super_admin", "template_admin", "reviewer", "support"] as const;

export const updateLocalePreferencesSchema = z
  .object({
    ui_locale: z.string().trim().min(2).max(24).optional(),
    notification_locale: z.string().trim().min(2).max(24).optional(),
    report_locale: z.string().trim().min(2).max(24).optional(),
  })
  .refine(
    (v) =>
      v.ui_locale !== undefined ||
      v.notification_locale !== undefined ||
      v.report_locale !== undefined,
    { message: "At least one locale preference field is required." },
  );

export const publicLocaleSelectionSchema = z.object({
  locale: z.string().trim().min(2).max(24),
});

export const toggleLocaleStatusSchema = z.object({
  enabled: z.boolean(),
  selectable: z.boolean().optional(),
});

export const upsertDynamicTranslationSchema = z.object({
  entity_type: z.string().trim().min(2).max(64),
  entity_id: z.uuid(),
  field_key: z.string().trim().min(1).max(80),
  locale: z.string().trim().min(2).max(24),
  source_locale: z.string().trim().min(2).max(24).default("zh-CN"),
  source_revision: z.number().int().min(1).default(1),
  source_text: z.string().trim().min(1).max(10000),
  translated_text: z.string().trim().min(1).max(10000).nullable().optional(),
  translator_kind: z.enum(["human", "ai"]).default("human"),
  submit_for_review: z.boolean().default(false),
});

export const decideDynamicTranslationSchema = z.object({
  decision: z.enum(["approve", "publish", "reject", "lock_human"]),
});

export const markTranslationsStaleSchema = z.object({
  entity_type: z.string().trim().min(2).max(64),
  entity_id: z.uuid(),
  field_key: z.string().trim().min(1).max(80).optional(),
  new_source_text: z.string().trim().min(1).max(10000),
});

export const createLocaleSnapshotSchema = z.object({
  entity_type: z.string().trim().min(2).max(64),
  entity_id: z.uuid(),
  entity_version: z.number().int().min(1),
  locale: z.string().trim().min(2).max(24),
  field_keys: z.array(z.string().trim().min(1).max(80)).min(1).max(40),
  source_texts: z.record(z.string(), z.string()),
});

export function buildLocaleCookieHeader(locale: EnabledLocale): string {
  return `qcw_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export async function listRegisteredLocales(db: Pick<DB, "query">) {
  const rows = (
    await db.query<{
      code: string;
      bcp47: string;
      native_label: string;
      english_label: string;
      enabled: boolean;
      selectable: boolean;
      public_path_prefix: string;
      is_core: boolean;
    }>(
      `select code, bcp47, native_label, english_label, enabled, selectable, public_path_prefix, is_core
       from i18n_locales
       order by is_core desc, enabled desc, code asc`,
    )
  ).rows;
  return { locales: rows };
}

export async function getLocalePreferencesForActor(
  db: Pick<DB, "query">,
  actor: Actor | null,
  opts: {
    cookieLocale?: string | null;
    acceptLanguage?: string | null;
    explicitRouteLocale?: string | null;
  } = {},
) {
  let accountUiLocale: string | null = null;
  let accountNotifLocale: string | null = null;
  let accountReportLocale: string | null = null;

  if (actor) {
    const userRow = (
      await db.query<{
        ui_locale: string | null;
        notification_locale: string | null;
        report_locale: string | null;
        locale: string | null;
        staff_pref: string | null;
      }>(
        `select u.ui_locale, u.notification_locale, u.report_locale, u.locale, sp.preferred_locale as staff_pref
         from users u
         left join staff_profiles sp on sp.user_id = u.id
         where u.id = $1`,
        [actor.id],
      )
    ).rows[0];
    if (userRow) {
      accountUiLocale =
        userRow.ui_locale ??
        (actor.kind === "staff" ? userRow.staff_pref : null) ??
        null;
      accountNotifLocale = userRow.notification_locale ?? null;
      accountReportLocale = userRow.report_locale ?? null;
    }
  }

  const surface = actor?.kind === "staff" ? "staff" : actor?.kind === "customer" ? "customer" : "public";
  const resolved = resolveAccountLocalePreferences({
    surface,
    explicitRouteLocale: opts.explicitRouteLocale,
    manualPreference: opts.cookieLocale,
    accountUiLocale,
    accountNotificationLocale: accountNotifLocale,
    accountReportLocale: accountReportLocale === "both" ? "en-US" : accountReportLocale,
    acceptLanguageHeader: opts.acceptLanguage,
  });

  return {
    ui_locale: resolved.uiLocale,
    notification_locale: resolved.notificationLocale,
    report_locale:
      accountReportLocale === "both" ? ("both" as const) : resolved.reportLocale,
    account_saved: {
      ui_locale: accountUiLocale,
      notification_locale: accountNotifLocale,
      report_locale: accountReportLocale,
    },
  };
}

export async function updateActorLocalePreferences(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  const input = updateLocalePreferencesSchema.parse(rawBody);
  const current = await one<{
    ui_locale: string | null;
    notification_locale: string | null;
    report_locale: string | null;
    locale: string;
  }>(
    db,
    "select ui_locale, notification_locale, report_locale, locale from users where id = $1 for update",
    [actor.id],
  );

  let nextUi: EnabledLocale | undefined;
  let nextNotif: EnabledLocale | undefined;
  let nextReport: EnabledLocale | "both" | undefined;

  if (input.ui_locale !== undefined) {
    nextUi = assertEnabledLocale(input.ui_locale);
  }
  if (input.notification_locale !== undefined) {
    nextNotif = assertEnabledLocale(input.notification_locale);
  }
  if (input.report_locale !== undefined) {
    if (input.report_locale.toLowerCase() === "both") {
      nextReport = "both";
    } else {
      nextReport = assertEnabledLocale(input.report_locale);
    }
  }

  const updated = await one<{
    ui_locale: string | null;
    notification_locale: string | null;
    report_locale: string | null;
  }>(
    db,
    `update users
     set ui_locale = coalesce($2, ui_locale),
         notification_locale = coalesce($3, notification_locale),
         report_locale = coalesce($4, report_locale),
         locale = case when $2 is not null then $5 else locale end,
         updated_at = now()
     where id = $1
     returning ui_locale, notification_locale, report_locale`,
    [
      actor.id,
      nextUi ?? null,
      nextNotif ?? null,
      nextReport ?? null,
      nextUi ? toLegacyDbLocale(nextUi) : current.locale,
    ],
  );

  if (nextUi && actor.kind === "staff") {
    await db.query(
      "update staff_profiles set preferred_locale = $2, updated_at = now() where user_id = $1",
      [actor.id, nextUi],
    );
  }

  await audit(db, actor, "locale_preferences_updated", "users", actor.id, {
    ui_locale: updated.ui_locale,
    notification_locale: updated.notification_locale,
    report_locale: updated.report_locale,
  });

  const effective = await getLocalePreferencesForActor(db, actor);
  return {
    ...effective,
    cookie_header: nextUi ? buildLocaleCookieHeader(nextUi) : null,
  };
}

export async function setPublicLocalePreference(
  db: DB,
  actor: Actor | null,
  rawBody: Record<string, unknown>,
) {
  const input = publicLocaleSelectionSchema.parse(rawBody);
  const locale = assertEnabledLocale(input.locale);
  if (actor) {
    await db.query(
      `update users set ui_locale = $2, locale = $3, updated_at = now() where id = $1`,
      [actor.id, locale, toLegacyDbLocale(locale)],
    );
    if (actor.kind === "staff") {
      await db.query(
        "update staff_profiles set preferred_locale = $2, updated_at = now() where user_id = $1",
        [actor.id, locale],
      );
    }
    await audit(db, actor, "public_locale_selected", "users", actor.id, { ui_locale: locale });
  }
  return {
    locale,
    cookie_header: buildLocaleCookieHeader(locale),
  };
}

export async function getAdminI18nOverview(db: DB, actor: Actor) {
  role(actor, ...I18N_TRANSLATOR_ROLES);
  const { locales } = await listRegisteredLocales(db);
  const bundleCheck = validateFixedResourceBundle(FIXED_I18N_RESOURCES);
  const stats = (
    await db.query<{
      entity_type: string;
      locale: string;
      status: string;
      count: number;
    }>(
      `with latest as (
         select distinct on (entity_type, entity_id, field_key, locale)
                entity_type, locale, status
         from i18n_dynamic_translations
         order by entity_type, entity_id, field_key, locale, revision desc
       )
       select entity_type, locale, status, count(*)::int as count
       from latest
       group by entity_type, locale, status
       order by entity_type, locale, status`,
    )
  ).rows;

  const totals = (
    await db.query<{
      total_latest: number;
      published_count: number;
      approved_count: number;
      pending_or_draft_count: number;
      stale_or_failed_count: number;
    }>(
      `with latest as (
         select distinct on (entity_type, entity_id, field_key, locale) status
         from i18n_dynamic_translations
         order by entity_type, entity_id, field_key, locale, revision desc
       )
       select count(*)::int as total_latest,
              count(*) filter (where status = 'published')::int as published_count,
              count(*) filter (where status = 'approved')::int as approved_count,
              count(*) filter (where status in ('untranslated','queued','machine_draft','human_draft','pending_review'))::int as pending_or_draft_count,
              count(*) filter (where status in ('stale','failed'))::int as stale_or_failed_count
       from latest`,
    )
  ).rows[0];

  return {
    locales,
    fixed_resources: {
      total_keys: FIXED_I18N_RESOURCES.length,
      ci_valid: bundleCheck.ok,
      missing_keys_count: bundleCheck.missingKeys.length,
      placeholder_mismatches_count: bundleCheck.placeholderMismatches.length,
    },
    dynamic_completeness: {
      ...totals,
      breakdown: stats,
    },
  };
}

export async function toggleRegisteredLocale(
  db: DB,
  actor: Actor,
  sessionHash: string,
  rawCode: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = toggleLocaleStatusSchema.parse(rawBody);
  const norm = normalizeLocaleTag(rawCode);
  guard(norm, "LOCALE_UNSUPPORTED", `Locale '${rawCode}' is not registered.`, 422);

  const row = await one<{
    code: string;
    is_core: boolean;
    enabled: boolean;
    selectable: boolean;
  }>(db, "select code, is_core, enabled, selectable from i18n_locales where code = $1 for update", [norm]);

  if (row.is_core && (!input.enabled || input.selectable === false)) {
    throw new Problem(
      "CORE_LOCALE_LOCKED",
      `Core locale '${row.code}' cannot be disabled or hidden.`,
      422,
    );
  }

  if (!row.is_core && input.enabled) {
    // Future locales (e.g. fr-FR, es-ES) remain isolated unless every fixed UI resource key has been provided & validated.
    const hasCompleteFixedBundle = FIXED_I18N_RESOURCES.every((entry) => {
      const val = (entry.values as Record<string, string | undefined>)[row.code];
      return Boolean(val && val.trim());
    });
    guard(
      hasCompleteFixedBundle,
      "LOCALE_BUNDLE_INCOMPLETE",
      `Future locale '${row.code}' does not have a complete approved fixed resource bundle yet.`,
      422,
    );
  }

  const nextSelectable = input.enabled ? (input.selectable ?? input.enabled) : false;
  const updated = await one(
    db,
    `update i18n_locales
     set enabled = $2, selectable = $3, updated_by = $4, updated_at = now()
     where code = $1
     returning *`,
    [row.code, input.enabled, nextSelectable, actor.id],
  );
  await audit(db, actor, "i18n_locale_toggled", "i18n_locales", uuid(), {
    code: row.code,
    enabled: input.enabled,
    selectable: nextSelectable,
  });
  return { locale: updated };
}

export async function listDynamicTranslations(
  db: DB,
  actor: Actor,
  filters: { entity_type?: string; entity_id?: string; locale?: string; status?: string },
) {
  role(actor, ...I18N_TRANSLATOR_ROLES);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.entity_type) {
    params.push(filters.entity_type);
    clauses.push(`entity_type = $${params.length}`);
  }
  if (filters.entity_id) {
    params.push(filters.entity_id);
    clauses.push(`entity_id = $${params.length}`);
  }
  if (filters.locale) {
    params.push(assertEnabledLocale(filters.locale));
    clauses.push(`locale = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  const whereSql = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const translations = (
    await db.query(
      `select * from i18n_dynamic_translations ${whereSql} order by updated_at desc, revision desc limit 200`,
      params,
    )
  ).rows;
  return { translations };
}

export async function upsertDynamicTranslation(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...I18N_TRANSLATOR_ROLES);
  const input = upsertDynamicTranslationSchema.parse(rawBody);
  const targetLocale = assertEnabledLocale(input.locale);
  const sourceLocale = assertEnabledLocale(input.source_locale);
  const sourceHash = hash(input.source_text);

  const latest = (
    await db.query<{
      id: string;
      revision: number;
      human_locked: boolean;
      status: string;
    }>(
      `select id, revision, human_locked, status
       from i18n_dynamic_translations
       where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
       order by revision desc
       limit 1
       for update`,
      [input.entity_type, input.entity_id, input.field_key, targetLocale],
    )
  ).rows[0];

  if (latest?.human_locked && input.translator_kind === "ai") {
    throw new Problem(
      "HUMAN_TRANSLATION_LOCKED",
      "Human-locked translation cannot be overwritten by an AI candidate.",
      409,
    );
  }

  const nextRevision = (latest?.revision ?? 0) + 1;
  const nextStatus = !input.translated_text?.trim()
    ? "untranslated"
    : input.submit_for_review
      ? "pending_review"
      : input.translator_kind === "ai"
        ? "machine_draft"
        : "human_draft";

  if (latest && ["approved", "published"].includes(latest.status)) {
    await db.query(
      "update i18n_dynamic_translations set status = 'stale', updated_at = now() where id = $1 and source_hash <> $2",
      [latest.id, sourceHash],
    );
  }

  const row = await one(
    db,
    `insert into i18n_dynamic_translations (
       id, entity_type, entity_id, field_key, locale, revision,
       source_locale, source_revision, source_hash, source_text, translated_text,
       status, translator_kind, human_locked, created_by, updated_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
     returning *`,
    [
      uuid(),
      input.entity_type,
      input.entity_id,
      input.field_key,
      targetLocale,
      nextRevision,
      sourceLocale,
      input.source_revision,
      sourceHash,
      input.source_text,
      input.translated_text ?? null,
      nextStatus,
      input.translator_kind,
      latest?.human_locked ?? false,
      actor.id,
    ],
  );

  await audit(db, actor, "i18n_translation_upserted", "i18n_dynamic_translations", row.id, {
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    field_key: input.field_key,
    locale: targetLocale,
    revision: nextRevision,
    status: nextStatus,
  });

  return { translation: row };
}

export async function decideDynamicTranslation(
  db: DB,
  actor: Actor,
  translationId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "reviewer", "super_admin");
  const input = decideDynamicTranslationSchema.parse(rawBody);
  const existing = await one<{
    id: string;
    created_by: string | null;
    translated_text: string | null;
    status: string;
    entity_type: string;
    entity_id: string;
    field_key: string;
    locale: string;
  }>(db, "select * from i18n_dynamic_translations where id = $1 for update", [translationId]);

  if (input.decision === "approve" || input.decision === "publish") {
    guard(
      !["stale", "failed"].includes(existing.status),
      "RECORD_CONFLICT",
      `Cannot ${input.decision} a translation in status '${existing.status}'; submit a revised draft first.`,
      409,
    );
    guard(
      Boolean(existing.translated_text && existing.translated_text.trim()),
      "LOCALE_TRANSLATION_EMPTY",
      "Cannot approve or publish an empty translation.",
      422,
    );
    guard(
      existing.created_by !== actor.id,
      "SOD_VIOLATION",
      "Separation of duties forbids author from approving or publishing their own translation.",
      403,
    );
  }

  const nextStatus =
    input.decision === "approve"
      ? "approved"
      : input.decision === "publish"
        ? "published"
        : input.decision === "reject"
          ? "failed"
          : existing.status;

  const updated = await one(
    db,
    `update i18n_dynamic_translations
     set status = $2,
         human_locked = case when $3 then true else human_locked end,
         approved_by = case when $4 then $5 else approved_by end,
         approved_at = case when $4 then coalesce(approved_at, now()) else approved_at end,
         published_at = case when $2 = 'published' then now() else published_at end,
         updated_at = now()
     where id = $1
     returning *`,
    [
      existing.id,
      nextStatus,
      input.decision === "lock_human",
      input.decision === "approve" || input.decision === "publish",
      actor.id,
    ],
  );

  await audit(db, actor, `i18n_translation_${input.decision}`, "i18n_dynamic_translations", existing.id, {
    entity_type: existing.entity_type,
    entity_id: existing.entity_id,
    field_key: existing.field_key,
    locale: existing.locale,
  });

  return { translation: updated };
}

export async function markEntityTranslationsStale(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  role(actor, ...I18N_ADMIN_ROLES);
  const input = markTranslationsStaleSchema.parse(rawBody);
  const newHash = hash(input.new_source_text);
  const params: unknown[] = [input.entity_type, input.entity_id, newHash];
  let fieldClause = "";
  if (input.field_key) {
    params.push(input.field_key);
    fieldClause = `and field_key = $${params.length}`;
  }
  const res = await db.query(
    `update i18n_dynamic_translations
     set status = 'stale', published_at = null, updated_at = now()
     where entity_type = $1 and entity_id = $2 ${fieldClause}
       and status in ('machine_draft', 'human_draft', 'pending_review', 'approved', 'published')
       and source_hash <> $3`,
    params,
  );
  await audit(db, actor, "i18n_translations_marked_stale", input.entity_type, input.entity_id, {
    field_key: input.field_key ?? null,
    stale_count: res.rowCount ?? 0,
  });
  return { marked_stale: res.rowCount ?? 0 };
}

export async function createImmutableLocaleSnapshot(
  db: DB,
  actor: Actor,
  rawBody: Record<string, unknown>,
) {
  role(actor, "reviewer", "super_admin");
  const input = createLocaleSnapshotSchema.parse(rawBody);
  const targetLocale = assertEnabledLocale(input.locale);

  const frozenFields: Record<string, string> = {};
  for (const fieldKey of input.field_keys) {
    const latestApproved = (
      await db.query<{ translated_text: string | null; status: string }>(
        `select translated_text, status
         from i18n_dynamic_translations
         where entity_type = $1 and entity_id = $2 and field_key = $3 and locale = $4
         order by revision desc
         limit 1`,
        [input.entity_type, input.entity_id, fieldKey, targetLocale],
      )
    ).rows[0];
    guard(
      latestApproved &&
        ["approved", "published"].includes(latestApproved.status) &&
        latestApproved.translated_text?.trim(),
      "LOCALE_TRANSLATION_UNAPPROVED",
      `Field '${fieldKey}' for ${targetLocale} must be approved or published before snapshotting.`,
      409,
    );
    frozenFields[fieldKey] = latestApproved.translated_text!;
  }

  const snapshot = await one(
    db,
    `insert into i18n_historical_snapshots (
       id, entity_type, entity_id, entity_version, locale, source_hash, frozen_fields, frozen_by
     ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     returning *`,
    [
      uuid(),
      input.entity_type,
      input.entity_id,
      input.entity_version,
      targetLocale,
      hash(JSON.stringify(input.source_texts)),
      JSON.stringify(frozenFields),
      actor.id,
    ],
  );

  await audit(db, actor, "i18n_snapshot_frozen", input.entity_type, input.entity_id, {
    snapshot_id: snapshot.id,
    entity_version: input.entity_version,
    locale: targetLocale,
  });

  return { snapshot };
}
