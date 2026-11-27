# PKG-1 Wave 11｜工位、设备授权及技能（`TASK-183`）验证证据

- **签收边界**：本阶段签署 `018` 增量 SQL 迁移、A/B/C 三类工位模型、设备准入策略（默认 `manual_first_approval`，支持 `preregistered_only` 与 `controlled_self_register`）、设备审批/拒绝/紧急撤销/租约排他/校准去皮净重校验/故障隔离、员工与设备独立身份心跳、员工技能能力（含防自审 DB+服务双约束）及营业禁售守卫，并完整实现 `device.*` 与 `staff.skill_*` 真实写库站内收件箱通知；`001`–`017` 与 `67` 项 `L04` 生产门禁保持完整未触碰。

---

## 一、`018` 迁移前全库备份恢复演练（`TASK-177` 规程）

- **来源隔离库**：`qcw_t183_pre`（完整应用 `001`–`017` 后执行 `SOURCE_DATABASE_URL="postgres:///qcw_t183_pre?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`）：
  - `dump_bytes = 416,199`
  - `dump_sha256 = 32616e156cdd265b167352a0ae45d9ad2e3e5b984ba02ca9ae9e4f46e6f3c0e0`
  - `manifest_sha256 = 5c742198d3dcc787b5b02a11e64c296d1352b737abd53bc37868269e3c0d7f07`
  - `migrations_verified = 17`、`immutable_triggers_verified = 5`、`corrupt_backup_rejected = true`、`rpo_seconds = 0`、`rto_ms = 242`、`all_assertions_passed = true`

---

## 二、增量 `018` 迁移与核心实现清单

- **SQL 迁移**：[018_workstations_devices_and_skills.sql](../../../packages/db/migrations/018_workstations_devices_and_skills.sql)
  - 新建 `workstations`（`A_receiving` / `B_inspection_shoot` / `C_pack_handover`）、`device_access_policies`（预置全局默认 `manual_first_approval`）、`warehouse_devices`（`approval_status` 与 `online_status` 分离、`auth_generation` 凭据代次、`hardware_fingerprint_hash` + `device_secret_hash`）、`device_authorization_requests`（完整申请/审批/拒绝历史保留）、`device_control_leases`（`one_active_lease_per_device` 排他租约部分唯一索引）、`device_calibration_logs`（校准与故障台账）及 `inspector_skill_grants`（DB 层 `CHECK (certified_by IS NULL OR certified_by <> user_id)` 防自审）。
- **核心领域服务**：[packages/core/workstations-devices.ts](../../../packages/core/workstations-devices.ts) + [packages/core/http.ts](../../../packages/core/http.ts)
  - 实现工位建档、三类准入策略、审批/拒绝与仅 Owner 自有硬件显式二次确认例外、纯设备独立凭据心跳（`POST /devices/heartbeat`，未审批禁连、员工身份与设备身份严格分离）、紧急撤销立即递增 `auth_generation` 并回收活跃租约且保留全历史、称重皮重/毛重/净重容差校验、员工技能授权及营业禁售守卫（`GET /staff/workstations/sellability-check`），以及 `device.auth_requested` / `device.auth_approved` / `device.auth_rejected` / `device.revoked` / `device.fault_reported` / `device.calibration_failed` / `staff.skill_updated` / `staff.skill_revoked` 站内通知写入与员工收件箱投递（`GET /staff/me/notifications` + `POST /staff/me/notifications/:id/read`）。

---

## 三、全量验证与独立 Reviewer 结果

- **空库与静态契约验证**：
  - 隔离空库 `qcw_t183_empty` 顺序执行 `001`–`018` 迁移 + `docs/contracts/verify.sql` -> `PASS`
  - `npm run check` (`tsc --noEmit`)、`python3 docs/contracts/check.py`、`python3 tests/contract-check.test.py`（16/16 OK）与 `QCW_DEMO=0 NEXT_TELEMETRY_DISABLED=1 npm run build` -> 全部 `PASS`。
- **全量集成测试（`npm run test:integration` on isolated `qcw_test-pkg1-w11`）**：`144` pass、`0` fail、`0` skipped（含新增 [tests/pkg1-wave11-workstations-devices.test.mts](../../../tests/pkg1-wave11-workstations-devices.test.mts) `TASK-183` 全流程及负向边界回归用例）。
- **独立只读 Reviewer**：
  - 首轮审计（`42df1ca1-cc7c-4e76-be04-c7d48871767c`）提出 4 项发现（2 HIGH：待审批撤销同步作废请求与状态机/锁序校验、`preregistered_only` 严格绑定指纹/编码/角色/归属防撤销冲突；2 MEDIUM：清理无效回滚前写入并收紧校准/故障结果配对、售卖守卫联动绑定工位状态及角色存在性 + 技能通知去重后缀）；
  - 全数整改并补充负向回归测试，整改后全量验证全部通过，经二次独立只读复核（`ba3db569-784b-4b6b-8aa9-14bf56090745`）签发 **`VERDICT: PASS`**。
