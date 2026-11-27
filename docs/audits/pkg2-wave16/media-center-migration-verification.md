# PKG-2 Wave 16 Verification Report — TASK-188 Media Evidence Center & Legacy Migration

- **Task**: `TASK-188` (`PKG-2 · E357–E361`, `PAGE-M41 /admin/media & /admin/media/[id]`, `AT-55`, `T120`, `ST-04`, `G08`, `CAP20/22/25/26/27/28`)
- **Date**: `2026-11-27`
- **Owner**: `codex-antigravity`
- **External Live Account Validation**: `PENDING_EXTERNAL_VALIDATION` (verified against local PostgreSQL 16 + isolated SigV4 S3 backend + real Wave 14 storage hub instances; live production R2/S3/B2 accounts & physical camera devices remain unverified in production and all 67 `L04` formal gates remain `PRODUCTION_NOT_READY`)

## 1. Pre-Migration Backup & Restore Drill (`TASK-177` + `ST-04` Gate)

Executed against isolated database `qcw_t188_pre` -> `qcw_t188_restore` before applying `023`:

- `migrations_verified = 22` (`001`–`022`)
- `dump_bytes = 561520`
- `dump_sha256 = 8160eee596e9a13e4dcb3aab12444c084c8635519c0f1e97fd4c8391b8fc8745`
- `pre_tables = 152`
- `all_assertions_passed = true`

## 2. Implemented Scope & Invariants

1. **Additive Migration (`packages/db/migrations/023_media_evidence_center_and_migration.sql`)**:
   - Added `media_assets.storage_object_id` & `thumb_storage_object_id`, plus `legacy_file_storage_pointers` (preserving `freeze_report` immutability on `report_versions`).
   - Added media center query indexes, `media_export_jobs`, `media_retention_requests`, `media_reconciliation_runs`, `media_reconciliation_anomalies`, `recovery_revocation_tombstones`, and `storage_cost_rate_cards`.
2. **Global Media Center, RBAC, Cost Accounting & Legacy Migration (`packages/core/media-center.ts`, `packages/core/media.ts`, `packages/core/workstations-devices.ts`, `packages/core/http.ts`, `app/admin-media.tsx`)**:
   - Global search/table/gallery listing (`page_size <= 100`, `actual_captured_at IS NOT NULL` enforced on `captured_at` range filters, no preloaded originals/videos), device & employee photography histories surviving device revocation and staff offboarding.
   - Strict RBAC & scope enforcement (`customer` `403`, `support`/`finance` restricted to `thumbnail`/`video_poster`/`annotated` previews only, `inspector` warehouse/capture scoped across read, stream, and retention requests via `assertStaffScopeForEvidence`).
   - Deduplicated physical byte accounting per unique `storage_objects.id` (`device_test` excluded from business captures; unknown cost reported honestly as `cost_basis = "unknown", estimated_monthly_cost_cents = null` rather than `0`, transitioning to `"estimated_rate_card"` with active rate card version).
   - SoD (`requested_by !== actor.id`) + MFA controlled deletion blocked on `legal_hold`, published report citation (`qa_approved`/`published`), active retention, or open incidents/disputes with same-transaction `delete_blocked` audit & remote-failure `status = 'failed'` persistence (deadlock-free).
   - `§40` dual-read localization switching (`switchVerifiedLegacyMigrationPointers` / `rollbackLegacyMigrationPointers` / `readLegacyCompatibleBinary`) keeping `report_versions.pdf_sha256` immutable and preserving honest `legacy_unknown` provenance (`capture_responsible_user_id = null`, `device_id = null`) without inferring photographer from `uploaded_by`.
   - Conservation reconciliation & `recovery_revocation_tombstones` replay preventing zombie device/lease/deleted-media revival after backup restore (`CAP28`).
   - `PAGE-M41` (`/admin/media` and `/admin/media/[id]`) wired across `portal-routes.ts`, `authz-contract.ts`, `chrome.tsx`, `public-seo.ts`, `portal.tsx`, and `app/admin-media.tsx`.

## 3. Automated Verification Results

- **Empty DB Clean Migration + Relations (`001`–`023` + `docs/contracts/verify.sql`)**: PASS
- **TypeScript (`npx tsc --noEmit`)**: PASS
- **Contract Checker (`python3 docs/contracts/check.py`)**: PASS (`264 tasks (174 historical + 90 active)`, `E1–E654`, `121 pages`, `147 implementation cases`, `82 AT groups`, `67 production gates`, `51 transaction operations`)
- **Contract Regression (`python3 tests/contract-check.test.py`)**: `16/16 OK`
- **Production Build (`QCW_DEMO=0 npm run build`)**: PASS (`Next.js 16.4.5`)
- **Full Integration Suite (`npm run test:integration`)**: `tests 168, pass 168, fail 0, cancelled 0, skipped 0`, including `tests/pkg2-wave16-media-center-migration.test.mts` (`M01`–`M06`)

## 4. Independent Read-Only Audit

- **Initial Audit (`1d66f3b6-d870-4be5-b19a-d1efaec372f7`)**: `VERDICT: FAIL` — identified 3 findings: cross-warehouse & `device_test` scope check missing in `createMediaRetentionRequest`, `normalized`/`video_playback` stream bypass for `support`/`finance`, and gallery `<img>` missing `!item.deleted` gate in `app/admin-media.tsx`.
- **Remediations Applied**: extracted & enforced `assertStaffScopeForEvidence` in `createMediaRetentionRequest`, restricted `original`/`normalized`/`video_playback` streaming to `canDownloadOriginal`, gated gallery `<img>` on `!item.deleted`, and added negative security assertions in `tests/pkg2-wave16-media-center-migration.test.mts`.
- **Re-Audit (`cc7fa706-732c-4981-8fcf-5ce65ae7cd87`)**: **`VERDICT: PASS`** (`001`–`022` confirmed untouched, `npm run check` PASS, all 3 findings verified closed).
