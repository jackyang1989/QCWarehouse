# PKG-3 Wave 21 Verification Record (`TASK-194`)

- **Task**: `TASK-194 / PKG-3 · E330–E332` — 通信基础和收件箱（消息主记录/接收者/渠道投递/尝试明细、站内及 Email、真实双语模板、基础工单、存量事件幂等迁移与去重、业务待办与已读分离；Owner、员工、设备、地区、工单各自实现真实事件）
- **Scope Delivered**: `packages/db/migrations/028_communication_foundation_and_inbox.sql`, `packages/core/communications.ts`, unified producers/consumers (`email.ts`, `reads.ts`, `worker.ts`, `legal-merchants.ts`, `staff-lifecycle.ts`, `rbac-admin.ts`, `tickets.ts`, `workstations-devices.ts`), HTTP & portal routes (`http.ts`, `portal-routes.ts`), three-portal UI (`app/notifications.tsx` — `WorkspaceNotificationBell`, `NotificationInbox`, `StaffNotificationInbox`, `app/portal.tsx`, `app/chrome.tsx`, `packages/core/i18n/messages.ts`), and integration tests (`tests/pkg3-wave21-communications-inbox.test.mts`, `package.json`).

## 1. Pre-`028` Backup & Restore Drill (Isolated)

Executed via `scripts/pre-migration-backup-restore.mjs` (`qcw_t194_pre` -> `qcw_t194_restore`, temporary databases dropped afterward):

- `migrations_verified`: `27`
- `dump_bytes`: `707098`
- `dump_sha256`: `853d40893dfb501d4ea6c263618a79d8c14cc31d4083b5ff27f27b3ae02663a5`
- `manifest_sha256`: `0d771535b3222871fabf4090257b569dd6c23d1384813e6953aa7790646d64d5`
- `rpo_seconds`: `0`
- `rto_ms`: `487`
- `corrupt_backup_rejected`: `true`
- `all_assertions_passed`: `true`

## 2. Empty Database Schema & Contract Verification

- Clean empty database `qcw_t194_empty`: applied migrations `001`–`028` + `docs/contracts/verify.sql` -> exit `0` (temporary database dropped).

## 3. Verification Matrix (Post-Remediation)

| Check | Scope / Details | Result |
|---|---|---|
| `npm run check:i18n` | `104` fixed keys (`en-US`/`zh-CN` complete, `0` placeholder mismatches, `16` SEO routes paired) | PASS (exit `0`) |
| `npx tsc --noEmit` | Full TypeScript typecheck | PASS (exit `0`) |
| `python3 docs/contracts/check.py` | `264` tasks (`174` historical + `90` active), `E1–E654`, `121` pages, `147` implementation cases, `82` AT groups, `67` production gates, `51` transaction operations | PASS (exit `0`) |
| `python3 tests/contract-check.test.py` | Contract checker suite (`Ran 16 tests ... OK`) | PASS (exit `0`) |
| `TEST_DATABASE_URL="postgres://127.0.0.1:5432/qcw_test" DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run test:integration` | Full DB-backed integration suite (`tests 198`, `pass 198`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`) | PASS (exit `0`) |
| `QCW_DEMO=0 DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run build` | Production build (`Next.js 16.4.5`) | PASS (exit `0`) |

## 4. Independent Read-Only Reviewer Audit Trail

1. **Initial Audit (`a1bd022c-27fd-47d9-9deb-8bd770c4faf1`)**: `VERDICT: FAIL` (`1 P0`, `2 P1`, `3 P2` — 6 findings total).
2. **Remediation**:
   - Hashed customer email identifiers in `email.delivery_failed` (`entityId`/`dedupeKey`) and added `sanitizeCommunicationMetadata` + `maskInlineEmails` + migration/backfill PII stripping so `previous_email`/`new_email` and secret tokens never appear in `notification_masters` or API payloads (`P0`).
   - Added `if (claimed.orderIsTest) return;` before `user_emails.delivery_state = 'bounced'` mutation and failure alert on synchronous bounce in `deliverEmailOnce` (`P1`).
   - Applied `SCOPED_SUPPORT_FILTER_SQL` to `listAdminCommunicationHistory` rows/summary counts and `getAdminCommunicationDetail`, nulled `error_detail` for non-`super_admin`, and gated `"对账同步存量通知"` button on `super_admin` (`P1`).
   - Updated `resetReadOnConflict` to also reset `notification_channel_deliveries` (`channel = 'in_app'`) read state (`P2`).
   - Unified customer inbox/detail (`reads.ts` & `communications.ts`) via `UNION ALL` with `notification_recipients WHERE legacy_notification_id IS NULL` + fallback `legacyRow` lookup (`P2`).
   - Replaced 200-row scan in `getStaffNotificationDetail` with single-row query, mapped staff `action_path`/`templateActionLink` to permitted routes, and replaced `Date.now()` dedupe keys with deterministic `auth_version` suffixes in `staff-lifecycle.ts` and `rbac-admin.ts` (`P2`).
3. **Final Re-Audit (`a553a09e-5c7c-467c-87fa-b467aa893381`)**: Verified all 6 findings closed, historical migrations `001`–`027` and `docs/contracts/` untouched, all `67` `L04` formal gates kept `PRODUCTION_NOT_READY`, and signed **`VERDICT: PASS`**.
