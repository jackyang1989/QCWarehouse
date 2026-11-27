# PKG-3 Wave 18 (`TASK-191`) AI Providers, Models & Atomic Budget Ledger Verification Record

- **Task**: `TASK-191 / PKG-3 · E325–E329` (`§53.7`, `§53.8`, `§53.12`, `§53.13`, `AI01–AI05`, `AI16–AI20`, `PAGE-M42`)
- **Dependencies Satisfied**: `TASK-191A` (`待验收`), `TASK-180` (`待验收`), `TASK-190` (`待验收`), `TASK-238A` (`待验收`), `TASK-177` (`待验收`)
- **Status Transition**: `进行中（codex-antigravity）` -> `待验收` (all 67 `L04` formal production gates remain untouched at `PRODUCTION_NOT_READY`)

## 1. Pre-Migration Backup & Restore Drill (pre-`025`)

Executed isolated backup and restore verification against temporary databases `qcw_t191_pre` -> `qcw_t191_restore` prior to applying migration `025`:

- `migrations_verified`: `24` (`001`–`024` untouched)
- `dump_bytes`: `604809`
- `dump_sha256`: `9d55cd5894e2335d3078d8660badc3340c0e2d61d40b4c45c855de5742789306`
- `manifest_sha256`: `9018a0b7b6d30217932685bb66c8466109d15be9a866cabc03bae557a874d58e`
- `all_assertions_passed`: `true` (`corrupt_backup_rejected=true`, both temporary databases dropped cleanly)

## 2. Implemented Scope & Security / Ledger Controls

1. **Database Migration (`packages/db/migrations/025_ai_providers_models_and_budgets.sql`)**:
   - `ai_provider_instances`: OpenAI Official (`openai_responses` / `openai_chat_completions`) & OpenAI Compatible (`openai_chat_completions`), `CHECK (requested_capabilities = ARRAY['language_translation_only']::text[])`, `test` vs `production` isolation, budget/timeout/concurrency controls, and `unconfigured | unknown | verified | degraded | error` probe state.
   - `ai_provider_secrets`: AES-256-GCM encrypted `api_key` / `organization_header` / `project_header` with masked preview, SHA-256 fingerprint, single active secret index per `(instance_id, secret_name)`.
   - `ai_models` & `ai_model_rate_versions`: discovery (`provider_list` vs `manual`), `BEFORE UPDATE OR DELETE` trigger raising `AI_RATE_VERSION_IMMUTABLE` (`ERRCODE = '23514'`) to protect historical rate versions.
   - `ai_budget_policies`, `ai_budget_reservations`, `ai_invocations`, `ai_cost_reconciliation_adjustments`: concurrent advisory-lock budget reservation ledger, sanitized metadata-only invocation log (`cost_cents = NULL` + `cost_status = 'unknown_pending'` on timeout/unknown usage), and finance reconciliation table.
2. **Core Adapter & Governance (`packages/core/ai-adapter.ts`, `packages/core/ai-service.ts`, `packages/core/http.ts`)**:
   - Strict SSRF & DNS rebinding protection (`assertSafeAiBaseUrl` / `assertSafeAiBaseUrlDns`), `api.openai.com` pinning for official instances outside test loopback, `redirect: "manual"` rejecting 3xx redirects (`AI_REDIRECT_FORBIDDEN`), zero non-language tool fields (`AI_BUSINESS_TOOL_FORBIDDEN`), outbound credential/PAN blocking (`UNSAFE_OUTBOUND_AI_PAYLOAD`), and `/models` 404/405/501 fallback (`AI_MODEL_LIST_UNSUPPORTED`).
   - MFA (`requireStaffMfa`), SoD (`SOD_VIOLATION` on instance & model approvals), probe/synthetic-test & parent-lifecycle prerequisites, key-rotation reset to `unknown`/`draft`, two-phase `runIdempotentExternal` deduplication on `probe`/`models/sync`/`models/:id/test`, preserved token usage on HTTP 200 `invalid_output`, and atomic budget reservation (`pg_advisory_xact_lock` fixed global -> instance order).
3. **Admin Page (`PAGE-M42` `/admin/integrations/ai`)**:
   - Registered under `super_admin` in `authz-contract.ts`, `portal-routes.ts`, and `public-seo.ts`; implemented `AdminAiDesk` (`app/admin-ai.tsx`) + mounted in `app/admin-integrations.tsx` without exposing plaintext secrets or placing `idempotent` props on repeatable buttons.

## 3. Verification Matrix (Post-Final-Edit)

| Check | Command / Scope | Result |
|---|---|---|
| Empty DB `001`–`025` + `verify.sql` | `qcw_t191_empty` clean migrate + relation verification | Exit `0` (PASS) |
| i18n CI Check | `npm run check:i18n` | Exit `0` (`95 fixed keys`, `0 placeholder mismatches`, `16 SEO routes paired`) |
| TypeScript Check | `npx tsc --noEmit` | Exit `0` (PASS) |
| Ledger & OpenAPI DAG Check | `python3 docs/contracts/check.py` | Exit `0` (`264 tasks`, `67 production gates`, `51 transaction operations`) |
| Contract Checker Regression | `python3 tests/contract-check.test.py` | `16/16 OK` |
| Full Integration Suite | `TEST_DATABASE_URL="postgres://127.0.0.1:5432/qcw_test" DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run test:integration` | `180/180` PASS (`0 fail`, `0 skip`, `0 cancelled`) — includes `pkg3-wave18-ai-providers-budgets.test.mts` `A01`–`A05` |
| Production Next.js Build | `QCW_DEMO=0 DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run build` | PASS (Next.js 16.4.5, `/`, `/[...page]`, `/api/v1/[...path]`, `/sitemap.xml`) |

## 4. Independent Audit Record

- **Initial Audit (`research`)**: `a26049ce-495d-4015-aa2e-acd8dcb645b8` (`1 P1`, `4 P2`).
- **Remediations Applied**:
  1. (`P1 #1`) Added two-phase `runIdempotentExternal` in `packages/core/http.ts` for `POST /staff/admin/ai/instances/:id/probe`, `/models/sync`, and `/models/:id/test` (`IDEMPOTENCY_CONFLICT` + zero duplicate external calls on retry without holding DB locks across `fetch()`).
  2. (`P2 #1`) Wrapped `validateAiTranslationOutput` in local `try/catch` in `packages/core/ai-adapter.ts` so HTTP 200 request ID, model snapshot, and billable token counts are preserved on `invalid_output`.
  3. (`P2 #2`) Guarded `approveAiModel` against inactive/disabled/archived parent instances (`409 AI_INSTANCE_NOT_ACTIVE`).
  4. (`P2 #3`) Verified `invocation.instance_id === input.instance_id` (`404 NOT_FOUND` on mismatch) and settled linked `unknown_pending` budget reservations in `recordAiCostReconciliation`.
  5. (`P2 #4`) Added React keys on `AdminAiDesk` selection-driven inputs (`app/admin-ai.tsx`).
- **Re-Audit (`research`)**: `402b3f28-20b2-47dd-88d2-02974dcfffa7` -> `P0: None`, `P1: None`, `P2: None`, **`VERDICT: PASS`**.
- **External Provider Validation Note**: Real OpenAI / compatible production API keys remain intentionally unconfigured (`PENDING_EXTERNAL_VALIDATION`); manual translation fallback remains continuously available (`manual_fallback_available: true`).
