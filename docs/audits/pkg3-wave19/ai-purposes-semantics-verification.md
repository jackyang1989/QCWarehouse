# PKG-3 Wave 19 (`TASK-192`) 9-Purpose Routing, Prompts, Glossary & Semantic Protection Verification Record

- **Task**: `TASK-192 / PKG-3 · E336–E340` (`§53.8`, `§53.10`, `§53.11`, `AI04`, `AI05`, `AI11`, `AI16`, `AI18`, `AI21`, `AI22`, `PAGE-M42`)
- **Dependencies Satisfied**: `TASK-191` (`待验收`), `TASK-177` (`待验收`)
- **Status Transition**: `进行中（codex-antigravity）` -> `待验收` (all 67 `L04` formal production gates remain untouched at `PRODUCTION_NOT_READY`)

## 1. Pre-Migration Backup & Restore Drill (pre-`026`)

Executed isolated backup and restore verification against temporary databases `qcw_t192_pre` -> `qcw_t192_restore` using `scripts/pre-migration-backup-restore.mjs` prior to applying migration `026`:

- `migrations_verified`: `25` (`001`–`025` untouched)
- `dump_bytes`: `645744`
- `dump_sha256`: `ae64d1b88465dfb3f19f95223dcf497a9530d3141cea0ce82f3ec03d6fbc982d`
- `manifest_sha256`: `0e0ed28c227d51c6fc20274c365165d96a3286b287d9a39f862fc9de8f9106aa`
- `rpo_seconds`: `0`
- `rto_ms`: `565`
- `all_assertions_passed`: `true` (`corrupt_backup_rejected=true`, both temporary databases dropped cleanly)

## 2. Implemented Scope & Semantic / Isolation Controls

1. **Database Migration (`packages/db/migrations/026_ai_purposes_prompts_glossary_and_evals.sql`)**:
   - `ai_prompt_versions`: Versioned prompt templates across the 9 permitted `purpose_code` values with `BEFORE UPDATE OR DELETE` trigger (`AI_PROMPT_VERSION_IMMUTABLE`) preventing mutation or deletion of published prompt versions.
   - `ai_purpose_routes`: Per-purpose primary + optional fallback instance/model/prompt routing versions with single active published partial index (`ai_purpose_routes_one_published_idx`) and `BEFORE UPDATE OR DELETE` immutability trigger (`AI_ROUTE_VERSION_IMMUTABLE`).
   - `ai_glossary_terms`: Bilingual domain glossary (`human` / `ai_draft`, `disallowed_translations`, SoD human approval).
   - `ai_translation_cache`: Strictly tenant-scoped cache keyed by `tenant_scope_key`, `purpose_code`, `source_locale`, `target_locale`, `source_hash`, `prompt_version_id`, `route_version_id`, `model_id`, and `glossary_hash`.
   - `ai_translation_jobs` & `ai_translation_job_items`: Tenant-scoped idempotency (`UNIQUE (tenant_scope_key, idempotency_key)` + `request_hash`), `UNIQUE (job_id, field_id)`, lease columns, attempt bounds (`attempts`, `max_attempts`), and per-item semantic violation records.
   - `ai_translation_eval_cases` & `ai_translation_eval_runs`: Versioned bilingual evaluation corpus (`protected_tokens`, `must_preserve_semantics`, `forbidden_inferences`, `reference_translations`) and audit-tracked automated + independent human QA runs.
2. **Deterministic Semantic Protection & System Prompt (`packages/core/ai-semantic-guard.ts`)**:
   - Rejects dynamic template expressions (`{{...}}`, `${...}`), `<script>`, event handlers, and embedded URLs (`AI_UNSAFE_PROMPT_TEMPLATE`).
   - Wraps purpose guidance with untrusted-input isolation, strict language-only structured JSON enforcement, and zero optimistic fabrication instructions (`buildImmutableSystemPrompt`).
   - Enforces HTML/script rejection (`AI_UNSAFE_OUTPUT_CONTENT`), placeholders (`AI_OUTPUT_PLACEHOLDER_BROKEN`), declared `protected_tokens` (`AI_FACT_PROTECTED_TOKEN_MISSING`), business IDs (`QW`/`QCW`/`P`/`S` identifiers), bidirectional signed number/tolerance parity (`AI_FACT_SIGN_MUTATED`, `AI_FACT_NUMBER_MUTATED`), measurement unit parity including `gsm`/`kg`/`cm`/`mm`/`g`/`in` (`AI_FACT_UNIT_MUTATED`), uninspected/uncertainty/care-label boundary enforcement, and disallowed terminology (`AI_GLOSSARY_TERM_FORBIDDEN`).
3. **Governance, Routing, Worker Pool & Admin UI (`packages/core/ai-translation-service.ts`, `ai-service.ts`, `worker.ts`, `http.ts`, `app/admin-ai.tsx`)**:
   - MFA + SoD across prompt publish/rollback, glossary approval, purpose route publish/rollback, and eval human QA approval.
   - Pre-publish eval gate (`enforcePurposeEvalGate`) blocking high-risk and eval-covered purposes until an independently QA-approved zero-fact-error eval run exists for the exact `(purpose_code, prompt_version_id, model_id)`.
   - Policy/purpose change on approved/tested provider instances resets lifecycle status to `draft` requiring re-approval (`updateAiProviderInstance`).
   - `workOneAiTranslation()` runs strictly after core `businessEvents`, email webhooks/delivery, and tracking callbacks, never holds DB TXs across upstream `fetch()`, releases active budget reservations on post-prep exceptions (`failTranslationExecutionOnException`), enforces full staff/customer revocation before calling providers, preserves `requires_human_confirmation` on uncached and cache-hit completions, caches fallback responses strictly under the fallback model key, and tracks accurate `provider_calls`.

## 3. Verification Matrix (Post-Final-Edit)

| Check | Command / Scope | Result |
|---|---|---|
| Empty DB `001`–`026` + `verify.sql` | `qcw_t192_empty` clean migrate + relation verification | Exit `0` (PASS) |
| i18n CI Check | `npm run check:i18n` | Exit `0` (`95 fixed keys`, `0 placeholder mismatches`, `16 SEO routes paired`) |
| TypeScript Check | `npx tsc --noEmit` | Exit `0` (PASS) |
| Ledger & OpenAPI DAG Check | `python3 docs/contracts/check.py` | Exit `0` (`264 tasks`, `67 production gates`, `51 transaction operations`) |
| Contract Checker Regression | `python3 tests/contract-check.test.py` | `16/16 OK` |
| Full Integration Suite | `TEST_DATABASE_URL="postgres://127.0.0.1:5432/qcw_test" DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run test:integration` | `187/187` PASS (`0 fail`, `0 skip`, `0 cancelled`) — includes `pkg3-wave19-ai-purposes-semantics.test.mts` (`S01`–`S06`) |
| Production Next.js Build | `QCW_DEMO=0 DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run build` | PASS (Next.js 16.4.5, `/`, `/[...page]`, `/api/v1/[...path]`, `/sitemap.xml`) |

## 4. Independent Audit Record

- **Initial Audit (`research`)**: `abfa677d-f34e-4855-a677-48a1414712f7` (`VERDICT: FAIL` — `3 P0`, `5 P1`, `1 P2`).
- **Intermediate Re-Audit (`research`)**: `a2eb289d-96af-41ff-a1ea-f378d8c7d85a` (closed 8.5/9 findings; flagged remaining `1 P1` on `enforcePurposeEvalGate` stale `route_version_id` OR-branch during active-route prompt rollback).
- **Remediations Completed**:
  1. (`P0 #1`) Scoped `ai_translation_jobs` uniqueness to `(tenant_scope_key, idempotency_key)` with `request_hash` payload parity and pre-insert duplicate `field_id` `422` validation.
  2. (`P0 #2` + `Re-Audit P1`) Enforced `published_at IS NOT NULL`, historical status (`deprecated`/`rolled_back`), `approved_by`, and SoD on prompt/route rollbacks; bound prompt rollback route roll-forward to strict `(purpose_code, prompt_version_id, model_id)` eval verification (`enforcePurposeEvalGate`); reset approved/tested instances to `draft` on `data_region_policy` or `allowed_purposes` updates.
  3. (`P0 #3`) Persisted `finalCandStatus` (`needs_review` when `requires_human_confirmation`) to items, cache rows, and cache-hit/cached-only job completions.
  4. (`P1 #4`) Fixed `[+-±]` character-range bug, added digit requirement to business IDs, added hallucinated extra-number rejection, fixed gram/attached unit handling, and verified `protected_tokens`.
  5. (`P1 #5`–`#8`) Added post-`prep` exception budget cleanup and `max_attempts` enforcement; full actor security/role/org revocation checks; fallback-model-keyed cache writes and accurate `provider_calls`; draft-route eval support + `enforcePurposeEvalGate` before high-risk/eval-covered route publishing.
  6. (`P2 #9`) Marked missing `field_id` items as rejected/failed, deduplicated `computePromptContentHash`, and added `routes`/`prompts`/`glossary`/`evals` creation, execution, QA, and cache-invalidation controls + error alerts in `app/admin-ai.tsx`.
- **Final Re-Audit (`research`)**: `751f8533-98cc-4c9f-9529-42be36993148` -> `P0: None`, `P1: None`, `P2: None`, **`VERDICT: PASS`**.
- **External Quality Validation Note**: Isolated deterministic semantic/corpus regression gates passed; real live commercial/custom model linguistic QA evaluation with live external provider keys remains cleanly gated under `PENDING_EXTERNAL_VALIDATION`.
