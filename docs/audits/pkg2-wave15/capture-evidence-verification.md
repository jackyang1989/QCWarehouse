# PKG-2 Wave 15 Verification Report — TASK-187 Capture Evidence & Media Contract

- **Task**: `TASK-187` (`PKG-2 · E347–E351`, `§115.7`, `§115.9`, `§37–§39`, `ST-02`, `CAP07/09/12/21/23`, `T36/37`, `G08`)
- **Date**: `2026-11-27`
- **Owner**: `codex-antigravity`
- **External Live Account Validation**: `PENDING_EXTERNAL_VALIDATION` (verified against local isolated PostgreSQL 16 + object storage foundation/worker `media.process` + `sharp` pipeline; real R2/S3/B2 production accounts & physical camera hardware remain unverified in production and all `L04` formal gates stay `PRODUCTION_NOT_READY`)

## 1. Pre-Migration Backup & Restore Drill (`TASK-177` Gate)

Executed against isolated database `qcw_t187_pre` -> `qcw_t187_restore` before applying `022`:

- `migrations_verified = 21` (`001`–`021`)
- `dump_bytes = 369136`
- `dump_sha256 = 3e2ee593e7185a2ee7dba23ee139bfe277beb91ad116fdf09a7ee9df642ee8cd`
- `pre_tables = 146`
- `restore_tables = 146`
- `all_assertions_passed = true`

## 2. Implemented Scope & Invariants

1. **Additive Migration (`packages/db/migrations/022_capture_evidence_media_contract.sql`)**:
   - Added `capture_commands` + `capture_commands_frozen_context_guard` (freezing business context & command origin once issued), `media_evidence_records` + `media_evidence_device_test_non_business_check` + `media_evidence_import_not_system_captured_check` + `media_evidence_immutable_origin_guard` + `media_evidence_no_delete`, `media_evidence_variants`, `media_evidence_links` + `media_evidence_links_tenant_guard` (`BEFORE INSERT OR UPDATE` blocking org reassignment and simultaneous active links across tenants), and `media_processing_jobs`.
2. **Capture Evidence Engine (`packages/core/capture-evidence.ts`) & Service/Worker/HTTP Wiring (`packages/core/storage-service.ts`, `packages/core/worker.ts`, `packages/core/http.ts`)**:
   - Command issuance, idempotent upload authorization & session re-issue (`reissueStorageUploadSession`), SHA-256 & file magic quarantine on mismatch/spoofing, truthful clock-skew/import/video timestamp preservation (`system_captured` strictly gated on live capture sources and trusted monotonic/wall clocks), and bounded streaming video SHA-256 container inspection.
   - Late handover / revoked or drifted device detection on both authorization (without `command_id`) and completion (`FOR SHARE` on `warehouse_devices`), routing late items into `late_quarantined` while preserving original author/device/capture time immutably.
   - Asynchronous `media.process` derivative generation via `sharp` preserving immutable original SHA-256, customer redacted read projection (`customer_attachment` / `customer_reference` isolation + customer IDOR/command/task/device blocking), multi-entity linking with `FOR UPDATE` + cross-tenant trigger + `device_test` isolation, and per-row `SAVEPOINT`-isolated `cleanupExpiredUnfinishedUploads` with admin RBAC (`warehouse_admin`, `super_admin`).

## 3. Automated Verification Results

- **Empty DB Clean Migration + Relations (`001`–`022` + `docs/contracts/verify.sql`)**: PASS
- **TypeScript (`npx tsc --noEmit`)**: PASS
- **Contract Checker (`python3 docs/contracts/check.py`)**: PASS (`264 tasks (174 historical + 90 active)`, `E1–E654`, `121 pages`, `147 implementation cases`, `82 AT groups`, `67 production gates`, `51 transaction operations`)
- **Contract Regression (`python3 tests/contract-check.test.py`)**: `16/16 OK`
- **Production Build (`QCW_DEMO=0 npm run build`)**: PASS (`Next.js 16.4.5`)
- **Full Integration Suite (`npm run test:integration`)**: `tests 161, pass 161, fail 0, cancelled 0, skipped 0`, including `tests/pkg2-wave15-capture-evidence.test.mts`

## 4. Independent Read-Only Audit

- **Initial Audit (`644b885c-5919-4fff-a26e-b792d2a17426`)**: `VERDICT: FAIL` — identified 4 blocking findings (RBAC & `SAVEPOINT` protection on `cleanup-expired`, customer IDOR/task/command injection prevention, `linkEvidenceToEntity` cross-tenant race/DB trigger/`device_test` isolation, and device approval without `command_id` + `system_captured` gating) plus 3 secondary hardening items (including bounded streaming video SHA-256 inspection).
- **Remediations Applied**: closed all 4 blocking findings and all 3 secondary hardening items across `022_capture_evidence_media_contract.sql`, `packages/core/capture-evidence.ts`, `packages/core/http.ts`, `packages/core/worker.ts`, and `tests/pkg2-wave15-capture-evidence.test.mts`, followed by full empty DB + `verify.sql` + `tsc` + `check.py` + `contract-check.test.py` + `QCW_DEMO=0 next build` + `161/161` integration re-verification.
- **Re-Audit (`473f88c6-500f-4f69-a846-a24e4b79e4ae`)**: **`VERDICT: PASS`** (`001`–`021` confirmed untouched, `npm run check` PASS, all 4 blocking findings & secondary video streaming hardening verified closed).
