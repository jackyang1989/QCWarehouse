# PKG-4 Wave 26 Verification & Audit Report (`TASK-199` · `E405–E407`)

- **Task**: `TASK-199 / PKG-4 · E405–E407` — 产能及 SLA 计算底座（班次、技能/设备、工作负荷、独立任务依赖、准备/QA瓶颈、安全缓冲及人工交期；未实测为草稿）
- **Status Promoted To**: `待验收` (pending formal `TASK-199B` real-warehouse calibration & business sign-off; `L04` gates remain untouched & `PRODUCTION_NOT_READY`)
- **Authoritative References**:
  - `docs/QC_Warehouse_生产级统一重构执行指令_最终完整01-116_AI服务与专业翻译全业务闭环版.md` (`§11 L606–620`, `§58.1`, `§58.4`, `§58.5`, `§89.2`)
  - `docs/开发规格.md` (`T32`, `G07`, `G16`, `PAGE-M22 /admin/pricing`, `PAGE-M36`)

---

## 1. Deliverables Summary

1. **Database Migration (`packages/db/migrations/033_capacity_and_sla_foundation.sql`)**:
   - `capacity_sla_policies` & `capacity_sla_policy_versions` (SoD `reviewer_id <> author_id` and `submitted_by is null or reviewer_id <> submitted_by`, `publication_scope = 'sandbox_acceptance'`, `business_approved = false`, immutable trigger `freeze_capacity_sla_policy_version`).
   - `order_sla_commitments` with `protect_order_sla_start` trigger enforcing strict immutability of non-null `sla_started_at` and `original_due_at`, and blocking `DELETE`.
   - `sla_clock_events` append-only table with `freeze_sla_clock_event` immutability trigger (`simulated`, `started`, `paused`, `resumed`, `extended`, `manual_override`, `completed`, `breached`, `recalculated`, `cancelled`).
   - `capacity_seed_runs` seed run audit ledger.
2. **Core Seed & Engine (`packages/core/capacity-sla-seed.ts`, `packages/core/capacity-sla-engine.ts`)**:
   - Idempotent draft baseline seed `CAP_SLA_APPAREL_SANDBOX_V1` (`2026-11-capacity-sla-v1`).
   - SoD policy draft/submit/publish/retire/rollback lifecycle (preserving omitted fields on partial updates and preventing spoofed `field_calibrated`/`hybrid` provenance without empirical samples).
   - Dynamic workload & SLA calculation combining complexity (`L1–L5`), modules (`M01–M11`), measurement coverage/points, photo/video density, rework allowance, compare/golden dependency locks, shift deductions (`daily_break_minutes_per_shift`, `daily_prep_minutes_per_shift`, `task_switch_overhead_minutes`), active `workstations` (`B_inspection_shoot`), `warehouse_devices` (`camera`), `inspector_skill_grants`, open backlog, QA/workstation/photo_rig/skill bottlenecks, safety buffer, cutoff (`Asia/Shanghai` / warehouse TZ, `hourCycle: "h23"`), and business calendar (`app_config` holidays/extra_workdays + warehouse `working_days`).
   - Threshold alerts (`70%` `warn_70`, `85%` `review_85`, `95%` `pause_heavy_95`) and automatic `manual_sla_required` escalation.
   - Empirical calibration provenance strictly computed from `labor_time_events` (`>= 10` measured samples per stage).
   - Order SLA start gates (`SLA_GATE_ORDER_STATE`, `SLA_GATE_UNPAID`, `SLA_GATE_BLOCKED`, `SLA_GATE_DEPENDENCY_LOCKED`, `SLA_GATE_SAMPLES_NOT_READY`, `MANUAL_SLA_REVIEW_REQUIRED`), `T32` pause/resume shifting `current_due_at`, extend (`SLA_PAUSED_RESUME_FIRST`), and customer `notifications` emission (`sla.started`, `sla.paused`, `sla.resumed`, `sla.extended`).
3. **Operations Sync & HTTP Routes (`packages/core/operations.ts`, `packages/core/http.ts`)**:
   - Integrated `syncOrderSlaOnHold`, `syncOrderSlaOnResume`, and `syncOrderSlaOnCancel` into `holdOrder`, `resumeOrder`, and `cancelOrder`.
   - Mounted 11 authenticated endpoints under `/staff/admin/capacity/*`, `/staff/admin/orders/:id/sla*`, and `/staff/admin/sla/:id/*` with Zod validation, RBAC, CSRF, `Idempotency-Key`, and staff MFA.
4. **Admin UI (`app/admin-capacity-sla.tsx`, `app/admin-pricing.tsx`)**:
   - Added 3rd tab `产能与 SLA 计算底座（TASK-199）` inside `PAGE-M22` (`AdminPricingDesk`) with warehouse capacity metrics, 50pc L1 vs L4 comparison, SoD policy governance editor (`key` includes version/updated_at + full field preservation), interactive dynamic SLA simulator, and SLA clock event/control panel.
5. **Integration Tests (`tests/pkg4-wave26-capacity-sla-foundation.test.mts`, `package.json`)**:
   - Verified seed idempotency, RBAC, query validation, SoD approval, immutability triggers, partial-edit preservation, anti-spoof provenance, published-snapshot isolation, `50pc L1` vs `50pc L4` divergence, `skill_scarcity`, cutoff shifting, empirical calibration, start gates, `T32` pause/resume, `holdOrder`/`resumeOrder`/`cancelOrder` sync, and customer notifications.

---

## 2. Verification & Drill Evidence

| Check / Drill | Result | Notes |
|---|---|---|
| Pre-`033` Isolated Backup/Restore (`scripts/pre-migration-backup-restore.mjs`) | **PASS** | `32` migrations, `dump_bytes = 864962`, `dump_sha256 = 2dfac380c285280d27b2cc3f37c60c6bca4a77ee4c5cf0e76ba15ec82f432230`, `manifest_sha256 = fd1bf179fea54fcd60fa0b0596c345a2b3baf270bad3af655e6302072dc48235`, `rpo_seconds = 0`, `rto_ms = 677`, `corrupt_backup_rejected = true` |
| Empty DB Migration + Relation Integrity (`qcw_t199_empty`) | **PASS** | `001`–`033` applied + `docs/contracts/verify.sql` exited `0` (re-verified post-remediation) |
| TypeScript (`npm run check`) | **PASS** | `tsc --noEmit` exit `0` |
| i18n Check (`npm run check:i18n`) | **PASS** | `104` fixed keys (`en-US`/`zh-CN` complete, `0` mismatches, `16` SEO pairs) |
| Contracts & Regression (`docs/contracts/check.py`, `tests/contract-check.test.py`) | **PASS** | `264 tasks (174 historical + 90 active)`, `E1–E654`, `121 pages`, `16/16` tests `OK` |
| Full Integration Suite (`npm run test:integration`) | **PASS** | `219/219` pass (`0` fail, `0` skip) including `tests/pkg4-wave26-capacity-sla-foundation.test.mts` |
| Production Build (`QCW_DEMO=0 npx next build`) | **PASS** | Next.js `16.4.5` compiled cleanly in `2.2s` |

---

## 3. Independent Read-Only Audit Record

- **Initial Audit (`46737cf6-7f2a-44c2-a23c-1968e8112914`)**: `VERDICT: FAIL` (3 P1, 4 P2, 5 Nits identified: partial policy update wiping omitted fields, spoofable `field_calibrated` fallback, compare/golden `independent_batch` & terminal order state bypass in `startOrderSlaCommitment`, unapproved draft resolution vs `latest_published_version_id`, paused SLA `/extend` & `cancelOrder` backlog sync, unused `workstations` bottleneck & default `skillMaxLevel=5`, uncontrolled `Form` stale key, and 5 Nits).
- **Re-Audit (`417ded9f-79d5-491c-8b68-bc666bdce440`)**: **`VERDICT: PASS`** — all 3 P1, 4 P2, and 5 Nits verified resolved in code with zero regressions after full integration & build verification.
