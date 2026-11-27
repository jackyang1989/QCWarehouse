# PKG-1 Wave 12｜排班及任务调度基础（`TASK-184`）验证证据

- **签收边界**：本阶段签署 `019` 增量 SQL 迁移、员工班次（`staff_work_shifts`）、统一任务调度队列（`dispatch_work_items`）、排他任务执行租约（`task_execution_leases`）、交接与接力预检快照（`task_handovers`）、迟到证据隔离区（`late_evidence_quarantine`）以及 DB + 领域层历史作者不可篡改守卫（`inspection_results_author_immutable` / `quarantine_author_immutable`）；动态真实负荷预测留待 `TASK-199B`，`001`–`018` 与 `67` 项 `L04` 生产门禁保持完整未触碰。

---

## 一、`019` 迁移前全库备份恢复演练（`TASK-177` 规程）

- **来源隔离库**：`qcw_t184_pre`（完整应用 `001`–`018` 后执行 `SOURCE_DATABASE_URL="postgres:///qcw_t184_pre?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`）：
  - `dump_bytes = 444,359`
  - `dump_sha256 = f0f537cf531e6b7217e086914c7efd4e6de2558ea2a195d7656c35a151e62f58`
  - `manifest_sha256 = 5e2ce7949436606feab5de76ce0bb79e8b79ba775c8f2014582b3fc76e7d35d0`
  - `migrations_verified = 18`、`immutable_triggers_verified = 5`、`corrupt_backup_rejected = true`、`rpo_seconds = 0`、`rto_ms = 254`、`all_assertions_passed = true`

---

## 二、增量 `019` 迁移与核心实现清单

- **SQL 迁移**：[019_scheduling_and_task_dispatch.sql](../../../packages/db/migrations/019_scheduling_and_task_dispatch.sql)
  - 增量扩展 `inspection_tasks`（`warehouse_id`、`workstation_id`、`planned_assignee_id`、`execution_generation`、`paused_at`、`pause_reason`、`priority`、`required_skill_code`）；新建 `staff_work_shifts`、`dispatch_work_items`、`task_execution_leases`（`one_active_task_lease` 部分唯一索引）、`task_handovers` 与 `late_evidence_quarantine`，并配置 PostgreSQL `BEFORE UPDATE` 触发器强制保护 `inspection_results.recorded_by` 与 `late_evidence_quarantine.captured_by` 不可被任何更新覆盖。
- **核心领域服务**：[packages/core/scheduling-dispatch.ts](../../../packages/core/scheduling-dispatch.ts) + [packages/core/inspection.ts](../../../packages/core/inspection.ts) + [packages/core/http.ts](../../../packages/core/http.ts)
  - 班次与请假拦截（`on_leave` 禁派单）、技能与角色准入检验、未付/阻塞订单禁通过调度绕过门禁（`ORDER_GATE_UNSATISFIED` / `ORDER_BLOCKED`）、排他执行租约与代数递增、停工暂停阻断旧租约写结果（`TASK_PAUSED`）、跨员交接/接力严禁改写历史测次作者（`HISTORICAL_AUTHOR_IMMUTABLE`）、迟到/撤销后证据进入 `late_evidence_quarantine` 并向管理员与原采集员发出站内收件箱通知。

---

## 三、全量验证与独立 Reviewer 结果

- **空库与静态契约验证**：
  - 隔离空库 `qcw_t184_empty` 顺序执行 `001`–`019` 迁移 + `docs/contracts/verify.sql` -> `PASS`
  - `npm run check` (`tsc --noEmit`)、`python3 docs/contracts/check.py`、`python3 tests/contract-check.test.py`（16/16 OK）与 `QCW_DEMO=0 NEXT_TELEMETRY_DISABLED=1 npm run build` -> 全部 `PASS`。
- **全量集成测试（`npm run test:integration` on isolated `qcw_test-pkg1-w12`）**：`145` pass、`0` fail、`0` skipped（含新增 [tests/pkg1-wave12-scheduling-dispatch.test.mts](../../../tests/pkg1-wave12-scheduling-dispatch.test.mts) `TASK-184` 全流程、DB 触发器不可变校验、交接取消恢复与迟到证据隔离负向回归用例）。
- **独立只读 Reviewer**：
  - 首轮审计（`5f1e5fe9-5171-4081-bd8e-f994b5111374`）提出 6 项发现（3 HIGH：`startTask` 拦截已分派/暂停任务防抢占、`registerDispatchWorkItem` 全域门禁与下游放行复验、新增 `cancelTaskHandover` 恢复交接死锁及 `revokeStaffActiveLeases` 并发核验；2 MEDIUM：保留初始 `planned_assignee_id` 与递增修订号、仓库时区日期/工位类型与严格时间校验；1 LOW：使用 DB 时钟校准过期租约并校验 `device_id`）；
  - 全数整改并补充负向回归测试，整改后全量验证全部通过，经二次独立只读复核（`6bd702f9-398b-41df-b1ba-d8ffc1662089`）签发 **`VERDICT: PASS`**。
