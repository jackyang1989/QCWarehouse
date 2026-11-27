import { guard, hash, Problem } from "./common";
import { customerDestination, staffDestination } from "./portal-routes";

export const ENABLED_LOCALES = ["en-US", "zh-CN"] as const;
export type EnabledLocale = (typeof ENABLED_LOCALES)[number];

export const FUTURE_EXTENSIBLE_LOCALES = ["fr-FR", "es-ES"] as const;
export type FutureLocale = (typeof FUTURE_EXTENSIBLE_LOCALES)[number];
export type RegisteredLocale = EnabledLocale | FutureLocale;

export type LocaleDescriptor = {
  code: RegisteredLocale;
  bcp47: RegisteredLocale;
  nativeLabel: string;
  englishLabel: string;
  enabled: boolean;
  selectable: boolean;
  publicPathPrefix: string;
  legacyDbCode: string;
};

/**
 * BCP47 locale registry: active delivery is strictly en-US and zh-CN; future locales
 * are registered behind enabled=false, selectable=false for isolated zero-rewrite extension.
 */
export const LOCALE_REGISTRY: Record<RegisteredLocale, LocaleDescriptor> = {
  "en-US": {
    code: "en-US",
    bcp47: "en-US",
    nativeLabel: "English",
    englishLabel: "English",
    enabled: true,
    selectable: true,
    publicPathPrefix: "",
    legacyDbCode: "en",
  },
  "zh-CN": {
    code: "zh-CN",
    bcp47: "zh-CN",
    nativeLabel: "简体中文",
    englishLabel: "Simplified Chinese",
    enabled: true,
    selectable: true,
    publicPathPrefix: "/zh",
    legacyDbCode: "zh-CN",
  },
  "fr-FR": {
    code: "fr-FR",
    bcp47: "fr-FR",
    nativeLabel: "Français",
    englishLabel: "French",
    enabled: false,
    selectable: false,
    publicPathPrefix: "/fr",
    legacyDbCode: "fr-FR",
  },
  "es-ES": {
    code: "es-ES",
    bcp47: "es-ES",
    nativeLabel: "Español",
    englishLabel: "Spanish",
    enabled: false,
    selectable: false,
    publicPathPrefix: "/es",
    legacyDbCode: "es-ES",
  },
};

export function normalizeLocaleTag(raw: string | null | undefined): RegisteredLocale | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim().replaceAll("_", "-").toLowerCase();
  if (!cleaned) return null;
  if (cleaned === "en" || cleaned === "en-us") return "en-US";
  if (cleaned === "zh" || cleaned === "zh-cn" || cleaned === "zh-hans" || cleaned === "zh-hans-cn") return "zh-CN";
  if (cleaned === "fr" || cleaned === "fr-fr") return "fr-FR";
  if (cleaned === "es" || cleaned === "es-es") return "es-ES";
  return null;
}

export function assertEnabledLocale(raw: string | null | undefined): EnabledLocale {
  const normalized = normalizeLocaleTag(raw);
  if (!normalized) {
    throw new Problem("LOCALE_UNSUPPORTED", `Locale '${raw ?? ""}' is not registered.`, 422);
  }
  const entry = LOCALE_REGISTRY[normalized];
  guard(
    entry.enabled && entry.selectable,
    "LOCALE_NOT_ENABLED",
    `Locale '${entry.bcp47}' is reserved for isolated future extension and is not enabled.`,
    422,
  );
  return entry.code as EnabledLocale;
}

export function toLegacyDbLocale(locale: EnabledLocale): "en" | "zh-CN" {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

// ---------- Fixed vs Dynamic Resources & Placeholder Integrity ----------

export type ResourceKind = "fixed" | "dynamic";

export type FixedResourceEntry = {
  kind: "fixed";
  key: string;
  placeholders: readonly string[];
  values: Partial<Record<EnabledLocale, string>>;
};

export function validateFixedResourceBundle(entries: readonly FixedResourceEntry[]): {
  ok: boolean;
  missingKeys: Array<{ key: string; locale: EnabledLocale }>;
  placeholderMismatches: Array<{ key: string; locale: EnabledLocale; missing: string[]; extra: string[] }>;
} {
  const missingKeys: Array<{ key: string; locale: EnabledLocale }> = [];
  const placeholderMismatches: Array<{ key: string; locale: EnabledLocale; missing: string[]; extra: string[] }> = [];

  for (const entry of entries) {
    const expected = new Set(entry.placeholders);
    for (const locale of ENABLED_LOCALES) {
      const text = entry.values[locale];
      if (!text || !text.trim()) {
        missingKeys.push({ key: entry.key, locale });
        continue;
      }
      const found = new Set<string>();
      for (const match of text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
        found.add(match[1]!);
      }
      const missing = [...expected].filter((p) => !found.has(p));
      const extra = [...found].filter((p) => !expected.has(p));
      if (missing.length || extra.length) {
        placeholderMismatches.push({ key: entry.key, locale, missing, extra });
      }
    }
  }

  return {
    ok: missingKeys.length === 0 && placeholderMismatches.length === 0,
    missingKeys,
    placeholderMismatches,
  };
}

export type DynamicTranslationStatus =
  | "untranslated"
  | "queued"
  | "machine_draft"
  | "human_draft"
  | "pending_review"
  | "approved"
  | "published"
  | "stale"
  | "failed";

export type DynamicTranslationRecord = {
  kind: "dynamic";
  entityType: string;
  entityId: string;
  fieldKey: string;
  locale: EnabledLocale;
  revision: number;
  sourceLocale: EnabledLocale;
  sourceRevision: number;
  sourceHash: string;
  translatedText: string | null;
  status: DynamicTranslationStatus;
  translatorKind: "human" | "ai";
  approvedBy: string | null;
  publishedAt: string | null;
};

export type HistoricalLocaleSnapshot = {
  snapshotId: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  locale: EnabledLocale;
  sourceHash: string;
  frozenFields: Record<string, string>;
  frozenAt: string;
};

export function createDynamicTranslationDraft(params: {
  entityType: string;
  entityId: string;
  fieldKey: string;
  locale: string;
  sourceLocale: EnabledLocale;
  sourceRevision: number;
  sourceText: string;
  translatedText: string | null;
  translatorKind: "human" | "ai";
  revision?: number;
}): DynamicTranslationRecord {
  const targetLocale = assertEnabledLocale(params.locale);
  const status: DynamicTranslationStatus = !params.translatedText?.trim()
    ? "untranslated"
    : params.translatorKind === "ai"
      ? "machine_draft"
      : "human_draft";
  return {
    kind: "dynamic",
    entityType: params.entityType,
    entityId: params.entityId,
    fieldKey: params.fieldKey,
    locale: targetLocale,
    revision: params.revision ?? 1,
    sourceLocale: params.sourceLocale,
    sourceRevision: params.sourceRevision,
    sourceHash: hash(params.sourceText),
    translatedText: params.translatedText,
    status,
    translatorKind: params.translatorKind,
    approvedBy: null,
    publishedAt: null,
  };
}

/**
 * When the authoritative source text updates, older dynamic translations derived from a prior
 * source hash are flagged 'stale' (never masquerading as current published copy), while existing
 * immutable historical snapshots remain completely untouched.
 */
export function markTranslationStaleIfSourceChanged(
  record: DynamicTranslationRecord,
  currentSourceText: string,
  currentSourceRevision: number,
): DynamicTranslationRecord {
  const nextHash = hash(currentSourceText);
  if (record.sourceHash === nextHash && record.sourceRevision === currentSourceRevision) {
    return record;
  }
  return {
    ...record,
    status: "stale",
    publishedAt: null,
  };
}

export function freezeHistoricalLocaleSnapshot(params: {
  snapshotId: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  locale: string;
  records: readonly DynamicTranslationRecord[];
  sourceTexts: Record<string, string>;
}): HistoricalLocaleSnapshot {
  const locale = assertEnabledLocale(params.locale);
  const frozenFields: Record<string, string> = {};
  for (const r of params.records) {
    if (r.locale !== locale) continue;
    guard(
      r.status === "approved" || r.status === "published",
      "LOCALE_TRANSLATION_UNAPPROVED",
      `Field '${r.fieldKey}' for ${locale} must be reviewed/approved before snapshotting.`,
      409,
    );
    frozenFields[r.fieldKey] = r.translatedText ?? "";
  }
  return {
    snapshotId: params.snapshotId,
    entityType: params.entityType,
    entityId: params.entityId,
    entityVersion: params.entityVersion,
    locale,
    sourceHash: hash(JSON.stringify(params.sourceTexts)),
    frozenFields,
    frozenAt: new Date().toISOString(),
  };
}

/**
 * Business facts that MUST NEVER be rewritten or auto-translated by UI locale changes (§53.3).
 */
export const NON_TRANSLATABLE_FACT_KEYS = new Set([
  "address_raw",
  "sku_code",
  "waybill_no",
  "tracking_norm",
  "receiving_code",
  "sample_code",
  "order_public_no",
  "currency_code",
  "amount_cents",
  "unit_system",
]);

export function assertBusinessFactsPreserved(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  for (const key of NON_TRANSLATABLE_FACT_KEYS) {
    if (key in before && before[key] !== after[key]) {
      throw new Problem(
        "NON_TRANSLATABLE_FACT_MUTATION",
        `Locale switch or translation cannot alter business fact '${key}'.`,
        409,
      );
    }
  }
}

// ---------- 3 Independent Preferences, SSR Routing & OAuth Compatibility ----------

export type PortalSurface = "public" | "customer" | "staff";

export type AccountLocalePreferences = {
  uiLocale: EnabledLocale;
  notificationLocale: EnabledLocale;
  reportLocale: EnabledLocale;
};

export function resolveAccountLocalePreferences(params: {
  surface: PortalSurface;
  explicitRouteLocale?: string | null;
  manualPreference?: string | null;
  accountUiLocale?: string | null;
  accountNotificationLocale?: string | null;
  accountReportLocale?: string | null;
  acceptLanguageHeader?: string | null;
}): AccountLocalePreferences {
  const fromAccept = parseAcceptLanguage(params.acceptLanguageHeader);
  const routeLoc = params.explicitRouteLocale ? normalizeLocaleTag(params.explicitRouteLocale) : null;
  const manualLoc = params.manualPreference ? normalizeLocaleTag(params.manualPreference) : null;
  const acctUiLoc = params.accountUiLocale ? normalizeLocaleTag(params.accountUiLocale) : null;

  let uiLocale: EnabledLocale = "en-US";
  if (params.surface === "public") {
    const candidate = routeLoc ?? manualLoc ?? acctUiLoc ?? fromAccept ?? "en-US";
    uiLocale = isEnabled(candidate) ? candidate : "en-US";
  } else if (params.surface === "customer") {
    const candidate = manualLoc ?? acctUiLoc ?? fromAccept ?? "en-US";
    uiLocale = isEnabled(candidate) ? candidate : "en-US";
  } else {
    // §53.2: Internal staff workspace defaults to zh-CN and ignores English Accept-Language when unset.
    const candidate = manualLoc ?? acctUiLoc ?? "zh-CN";
    uiLocale = isEnabled(candidate) ? candidate : "zh-CN";
  }

  const rawNotif = params.accountNotificationLocale ? normalizeLocaleTag(params.accountNotificationLocale) : null;
  const rawReport = params.accountReportLocale ? normalizeLocaleTag(params.accountReportLocale) : null;

  return {
    uiLocale,
    notificationLocale: isEnabled(rawNotif) ? rawNotif : params.surface === "staff" ? "zh-CN" : "en-US",
    reportLocale: isEnabled(rawReport) ? rawReport : "en-US",
  };
}

function isEnabled(locale: RegisteredLocale | null | undefined): locale is EnabledLocale {
  return Boolean(locale && LOCALE_REGISTRY[locale].enabled && LOCALE_REGISTRY[locale].selectable);
}

function parseAcceptLanguage(header: string | null | undefined): EnabledLocale | null {
  if (!header) return null;
  const tags = header
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean);
  for (const tag of tags) {
    const normalized = normalizeLocaleTag(tag);
    if (isEnabled(normalized)) return normalized;
  }
  return null;
}

export function resolveLocalizedPublicPath(rawPath: string): {
  locale: EnabledLocale;
  canonicalBasePath: string;
} {
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (path === "/zh" || path === "/zh/") {
    return { locale: "zh-CN", canonicalBasePath: "/" };
  }
  if (path.startsWith("/zh/")) {
    return { locale: "zh-CN", canonicalBasePath: path.slice(3) || "/" };
  }
  return { locale: "en-US", canonicalBasePath: path };
}

export function localizePublicPath(basePath: string, locale: string): string {
  const enabled = assertEnabledLocale(locale);
  const { canonicalBasePath } = resolveLocalizedPublicPath(basePath);
  if (enabled === "zh-CN") {
    return canonicalBasePath === "/" ? "/zh" : `/zh${canonicalBasePath}`;
  }
  return canonicalBasePath;
}

export function buildSsrLocaleMetadata(siteOrigin: string, basePath: string, activeLocale: EnabledLocale) {
  const { canonicalBasePath } = resolveLocalizedPublicPath(basePath);
  const enUrl = `${siteOrigin}${canonicalBasePath}`;
  const zhUrl = `${siteOrigin}${canonicalBasePath === "/" ? "/zh" : `/zh${canonicalBasePath}`}`;
  return {
    htmlLang: activeLocale,
    canonical: activeLocale === "zh-CN" ? zhUrl : enUrl,
    hreflangAlternates: {
      "en-US": enUrl,
      "zh-CN": zhUrl,
      "x-default": enUrl,
    },
  };
}

/**
 * Compatible OAuth / login / onboarding return path wrapper preserving explicit UI locale
 * without weakening open-redirect validation in portal-routes.ts.
 */
export function buildLocaleSafeOAuthReturnPath(
  candidatePath: string | null | undefined,
  actorKind: "customer" | "staff",
  roles: readonly string[],
  uiLocale: EnabledLocale,
): string | null {
  const validated =
    actorKind === "customer"
      ? customerDestination(candidatePath)
      : staffDestination(candidatePath, roles);
  if (!validated) return null;
  const parsed = new URL(validated, "https://qcwarehouse.invalid");
  const existing = normalizeLocaleTag(parsed.searchParams.get("locale"));
  if (isEnabled(existing)) {
    parsed.searchParams.set("locale", existing);
  } else {
    parsed.searchParams.set("locale", uiLocale);
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
