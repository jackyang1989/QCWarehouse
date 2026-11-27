# PKG-3 Wave 17 (`TASK-190`) Full-Site i18n Platform Verification Record

- **Task**: `TASK-190 / PKG-3 · E308–E312` (`§53.1–53.5`, `I18N01`, `I18N02`, `I18N05`, `I18N18`, `AT-57`, `T122`)
- **Dependencies Satisfied**: `TASK-180` (`待验收`), `TASK-190A` (`待验收`), `TASK-177` (`待验收`)
- **Status Transition**: `进行中（codex-antigravity）` -> `待验收` (all 67 `L04` formal production gates remain untouched at `PRODUCTION_NOT_READY`)

## 1. Pre-Migration Backup & Restore Drill (pre-`024`)

Executed isolated backup and restore verification against temporary databases `qcw_t190_pre` -> `qcw_t190_restore` prior to applying migration `024`:

- `migrations_verified`: `23` (`001`–`023` untouched)
- `pre_tables`: `159`
- `dump_bytes`: `591540`
- `dump_sha256`: `102593ef058f5c93ab3989784a6bdc25ac838488ef855a51edc7e935739e2992`
- `manifest_sha256`: `b7f878287d5607b2651b8ddc6afccf6c63ec3ccd46289220ed742efdc6828144`
- `all_assertions_passed`: `true` (both temporary databases dropped cleanly)

## 2. Implemented Scope & Architecture Summary

1. **Database Migration (`packages/db/migrations/024_i18n_locales_preferences_and_translations.sql`)**:
   - `i18n_locales`: seeds `en-US` and `zh-CN` (`is_core=true, enabled=true, selectable=true`) and isolates `fr-FR` / `es-ES` (`is_core=false, enabled=false, selectable=false`) with `CHECK` constraints preventing core disablement or non-enabled selection.
   - `users`: adds three independent preference columns (`ui_locale` FK -> `i18n_locales`, `notification_locale` FK -> `i18n_locales`, `report_locale` `'en-US' | 'zh-CN' | 'both'`).
   - `i18n_dynamic_translations`: revisioned entity-field translation workflow (`untranslated`, `queued`, `machine_draft`, `human_draft`, `pending_review`, `approved`, `published`, `stale`, `failed`), `human_locked` protection, `source_hash`, creator/approver tracking.
   - `i18n_historical_snapshots`: immutable historical snapshots protected by `BEFORE UPDATE OR DELETE` trigger `i18n_historical_snapshots_immutable_guard` raising `I18N_SNAPSHOT_IMMUTABLE` (`ERRCODE = '23514'`).
2. **Core Domain, Service & HTTP Endpoints**:
   - `packages/core/i18n/messages.ts`: `FIXED_I18N_RESOURCES` (95 EN/ZH fixed keys), `t`, `localizeErrorCode`, currency-preserving `formatCurrencyFact`, `formatDateTimeLocalized`.
   - `packages/core/i18n-service.ts`: `listRegisteredLocales`, `getLocalePreferencesForActor` (without falling back to legacy `users.locale` `DEFAULT 'en'`), `updateActorLocalePreferences`, `setPublicLocalePreference`, `getAdminI18nOverview`, `toggleRegisteredLocale` (MFA + core lock + incomplete future bundle guard), `listDynamicTranslations`, `upsertDynamicTranslation` (human lock vs AI `409`), `decideDynamicTranslation` (`SoD 403` + `stale`/`failed` conflict guard `409`), `markEntityTranslationsStale`, `createImmutableLocaleSnapshot`.
   - `packages/core/http.ts`: wired `/public/locales`, `POST /public/locale` (`csrf origin_only`), `/me/locale-preferences`, and `/staff/admin/i18n/*` (`csrf` + UUID `Idempotency-Key`).
3. **SSR `/zh` Routing, SEO, Sitemap & UI Language Switchers**:
   - `packages/core/portal-routes.ts`: `/zh` (`public-home`) and `/zh/*` strictly restricted to public marketing routes (excluding `login`, `staff-login`, `onboarding`, `account-recovery`; `/zh/admin`, `/zh/orders`, `/zh/wh`, `/zh/login`, `/zh/staff/login` return `undefined`).
   - `app/public-seo.ts` & `app/sitemap.ts`: bidirectional `hreflang` (`en-US`, `zh-CN`, `x-default`), self-referencing `canonical`, `openGraph.locale`, `noindex` on private routes, and paired EN/ZH sitemap excluding private/auth routes.
   - `app/i18n-client.tsx`, `app/chrome.tsx`, `app/portal.tsx`, `app/page.tsx`, `app/[...page]/page.tsx`: `LocaleProvider`, `PublicLanguageSwitcher`, `WorkspaceLanguageSwitcher` (persists DB/cookie while preserving unsaved client state), SSR `PublicHomePage({ locale })`, and `Accept-Language` / cookie / DB preference resolution (`staff` defaults to `zh-CN` ignoring English `Accept-Language`).
4. **CI Parity Guard**:
   - `scripts/check-i18n.mjs` & `npm run check:i18n` verifying EN/ZH completeness, placeholder parity, stub absence, and 16/16 public SEO route parity.

## 3. Verification Matrix (Post-Final-Edit)

| Check | Command / Scope | Result |
|---|---|---|
| Empty DB `001`–`024` + `verify.sql` | `qcw_t190_empty` clean migrate + relation verification | Exit `0` (PASS) |
| i18n CI Check | `npm run check:i18n` | Exit `0` (`95 fixed keys`, `0 placeholder mismatches`, `16 SEO routes paired`) |
| TypeScript Check | `npx tsc --noEmit` | Exit `0` (PASS) |
| Ledger & OpenAPI DAG Check | `python3 docs/contracts/check.py` | Exit `0` (`264 tasks`, `67 production gates`, `51 transaction operations`) |
| Contract Checker Regression | `python3 tests/contract-check.test.py` | `16/16 OK` |
| Full Integration Suite | `TEST_DATABASE_URL="postgres://127.0.0.1:5432/qcw_test" DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run test:integration` | `174/174` PASS (`0 fail`, `0 skip`, `0 cancelled`) — includes `pkg3-wave17-i18n-platform.test.mts` `I01`–`I05` |
| Production Next.js Build | `QCW_DEMO=0 DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run build` | PASS (Next.js 16.4.5, `/`, `/[...page]`, `/api/v1/[...path]`, `/sitemap.xml`) |

## 4. Independent Audit Record

- **Initial Audit (`research`)**: `be82f1ae-34d3-4607-8ad0-ec382aef3a56` -> `VERDICT: PASS` (`P0: None`, `P1: None`, 3 `P2` items noted).
- **P2 Remediations Applied**:
  1. Removed legacy `users.locale` (`DEFAULT 'en'`) fallback in `getLocalePreferencesForActor` and wired `acctPrefs?.account_saved` into `app/[...page]/page.tsx` so unconfigured customers honor `Accept-Language`.
  2. Guarded `decideDynamicTranslation` against approving/publishing `stale` or `failed` translations (`409 RECORD_CONFLICT`).
  3. Caught malformed percent encoding (`URIError`) on `POST /staff/admin/i18n/locales/:code/status` (`422 INVALID_REQUEST`).
- **Re-Audit (`research`)**: `7cc07f70-5752-4e96-9e48-14ffb1c2e7c3` -> `P0: None`, `P1: None`, `P2: None`, **`VERDICT: PASS`**.
