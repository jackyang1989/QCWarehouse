# PKG-2 Wave 14 Verification Report — TASK-186 Configurable Object Storage Hub

- **Task**: `TASK-186` (`PKG-2 · E322–E324`, `PAGE-M21 /admin/integrations/storage`, `AT-54`, `T119`, `§34–§36`, `§40`)
- **Date**: `2026-11-27`
- **Owner**: `codex-antigravity`
- **External Live Account Validation**: `PENDING_EXTERNAL_VALIDATION` (verified against local isolated SigV4 multi-bucket S3 server with AES-GCM encrypted DB secrets and real OPTIONS CORS preflight; real Cloudflare R2 / Amazon S3 / Backblaze B2 production credentials await operator input)

## 1. Pre-Migration Backup & Restore Drill (`TASK-177` Gate)

Executed against isolated database `qcw_t186_pre` -> `qcw_t186_restore` before applying `021`:

- `migrations_verified = 20` (`001`–`020`)
- `dump_bytes = 349143`
- `dump_sha256 = 65c10b1d66dd28f833f35e927479bf2d431a0f674fd64a18fd60233cb08a7c0b`
- `pre_tables = 141`
- `restore_tables = 141`
- `all_assertions_passed = true`

## 2. Implemented Scope & Invariants

1. **Additive Migration (`packages/db/migrations/021_configurable_storage_hub.sql`)**:
   - Added `storage_instances` (multi-provider `cloudflare_r2`/`amazon_s3`/`backblaze_b2`/`generic_s3`, roles `primary`/`secondary_failover`/`independent_backup`/`archive`/`public_assets`/`test_sandbox`, strict `visibility_scope` isolation, `public_cdn_base_url` forbidden on private instances, wildcard `'*'` CORS forbidden, single active primary per environment partial unique indexes, `requires_icp = false`), `storage_instance_secrets`, `storage_probe_runs`, `storage_objects.storage_instance_id`, `storage_instances_protect_delete` trigger, and non-destructive `storage_migration_jobs` + `storage_migration_items` (`retain_source_copy = true`).
2. **Configurable Hub (`packages/core/storage-hub.ts`) & Downstream Consumers (`packages/core/storage-service.ts`, `packages/core/media.ts`, `packages/core/http.ts`)**:
   - Provider presets (`STORAGE_PROVIDER_PRESETS`), encrypted credential vault (AES-256-GCM via `seal`/`unseal`) with masked responses, secret rotation & rollback, zero plaintext leakage in DB/API/audit/logs.
   - SSRF-safe endpoint & DNS checks (`url.origin` checked before every SigV4/presign/HTTP request including `virtual_hosted`), explicit site-origin `OPTIONS` CORS preflight verification, and real RW + Range 206 + Presigned GET SHA-256 + Multipart probes without fake health.
   - Atomic `switchPrimaryStorageInstance` demoting old active primary to `read_only_legacy` (`allow_reads = true`, `allow_new_writes = false`) while preserving historical reads; strict fail-closed live guard blocking PostgreSQL `private_files` / disk fallback (`503`).
   - Strict public/private bucket conflict prevention (`409 PUBLIC_PRIVATE_BUCKET_CONFLICT`), `POST /staff/admin/storage/public-assets/authorize`, and unauthenticated `GET /public/assets/:id/stream` (strictly `404` on any private object).
   - Non-destructive `expand -> migrate -> verify` pipeline for legacy `private_files` with `SAVEPOINT` isolation per item, SHA-256 verification, reference counting, pause/resume/retry/rollback.
3. **Admin UI (`PAGE-M21`)**:
   - Registered `/admin/integrations/storage` across `portal-routes.ts`, `authz-contract.ts`, `app/chrome.tsx`, `app/public-seo.ts`, `app/admin-integrations.tsx`, and implemented `app/admin-storage.tsx`.

## 3. Automated Verification Results

- **Empty DB Clean Migration + Relations (`001`–`021` + `docs/contracts/verify.sql`)**: PASS
- **TypeScript (`npx tsc --noEmit`)**: PASS
- **Contract Checker (`python3 docs/contracts/check.py`)**: PASS (`264 tasks`, `E1–E654`, `121 pages`, `147 implementation cases`, `82 AT groups`, `67 production gates`, `51 transaction operations`)
- **Contract Regression (`python3 tests/contract-check.test.py`)**: `16/16 OK`
- **Production Build (`QCW_DEMO=0 npm run build`)**: PASS (`Next.js 16.4.5`)
- **Full Integration Suite (`npm run test:integration`)**: `154/154 pass` (`0 fail`, `0 skip`), including `tests/pkg2-wave14-storage-hub.test.mts` (`S01`–`S07`, `8/8`)

## 4. Independent Read-Only Audit

- **Initial Audit (`28eee85c-945e-4216-897f-162b8609044d`)**: `VERDICT: FAIL` — identified 1 Medium finding (sticky `Idempotency-Key` on repeatable `<Action idempotent>` buttons in `app/admin-storage.tsx`) plus 3 Low / 1 Info hardening items.
- **Remediations Applied**: removed sticky `idempotent` from repeatable `app/admin-storage.tsx` buttons, blocked wildcard subdomains in `normalizeAndValidateCorsOrigins`, restricted fallback write roles in `resolveConfiguredWriteProvider`, enforced `url.origin` DNS checks + 15s probe fetch timeouts in `packages/core/object-storage.ts`, and added per-item PostgreSQL `SAVEPOINT` isolation + retry state guards in `packages/core/storage-hub.ts`.
- **Re-Audit (`87f99033-e897-4c77-9b42-000535db154f`)**: **`VERDICT: PASS`** (`001`–`020` confirmed untouched, `tsc --noEmit` PASS, all 5 findings verified closed).
