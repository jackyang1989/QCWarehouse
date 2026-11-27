# PKG-1 Wave 7–8｜员工安全生命周期（TASK-179）与动态 RBAC（TASK-180）验证证据 (`staff-rbac-verification`)

- **签收边界**：本阶段签署 `015` 增量 SQL 迁移、员工邀请激活（设密/TOTP/恢复码/预览不消耗/重发/撤销/会话吊销/离职交接）、动态 RBAC（8 预设与自定义角色/受控目录/职责分离发布/PC 与手机统一计算与实时撤权）及隔离回归测试；`TASK-189A` 维持 `待认领 / 待核验/实施`，67 项 `L04` 生产门禁维持 `PRODUCTION_NOT_READY`。

---

## 一、`015` 迁移前全库备份恢复演练（`TASK-177` 规程）

- **来源隔离库**：`qcw_t179_pre`（完整应用 `001`–`014` 后于 `5d9f239` 执行 `SOURCE_DATABASE_URL="postgres:///qcw_t179_pre?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`）：
  - `dump_bytes = 338,626`
  - `dump_sha256 = fa9b7ca800583fa19a317889891193f09102b67e7350cea30cbdba9041d82856`
  - `manifest_sha256 = c61cd4d6b51e5a70b24c35567f922b5a7e2988e84726a5efc928529a9ecb13fc`
  - `migrations_verified = 14`、`immutable_triggers_verified = 5`、`corrupt_backup_rejected = true`、`rpo_seconds = 0`、`rto_ms = 202`、`all_assertions_passed = true`

---

## 二、增量 `015` 迁移与核心实现清单

| 任务 | 资产路径 | 核心安全与治理能力 |
|---|---|---|
| `015` 迁移 | [015_staff_lifecycle_and_dynamic_rbac.sql](../../../packages/db/migrations/015_staff_lifecycle_and_dynamic_rbac.sql) | 仅追加、零改动 `001`–`014`：新建 `staff_profiles`、`staff_invitations`、`staff_handovers`、`rbac_roles`（预置 8 岗位与 `ACTION_CATALOG` 权限映射）、`staff_custom_role_assignments` 与 `rbac_role_versions`。 |
| `TASK-179` (`E287–E291`) | [packages/core/staff-lifecycle.ts](../../../packages/core/staff-lifecycle.ts) + [packages/core/email.ts](../../../packages/core/email.ts) + [packages/core/http.ts](../../../packages/core/http.ts) | `super_admin` + MFA 建档邀请（禁重邮箱、随机令牌只存 SHA-256 哈希、`queueNotificationEmail` 显式目标邮箱入队 `staff.invited` 投递）、`GET` 只读预览不消耗、重发取代旧单/即时撤销、`auth_version_snapshot` 与状态一致性校验、强密码+TOTP 真实验证激活与一次性恢复码、邮箱冲突告警、全量会话撤销、老员工/在岗员工离职交接合法性校验、保留历史 `users.id`/`audit_events` 及最后 Owner / 自离职保护；激活后直接打通 `POST /staff/auth/login`。 |
| `TASK-180` (`E292–E296`) | [packages/core/rbac-admin.ts](../../../packages/core/rbac-admin.ts) + [packages/core/http.ts](../../../packages/core/http.ts) | 严禁未知权限字符串（`422 UNKNOWN_PERMISSION_ACTION`）、伪造或重复分配预置角色；职责分离发布（禁 `SELF_REVIEW_FORBIDDEN`）并写入版本审计；发布/授权/撤权即时升 `auth_version` 并吊销受影响员工活跃会话；拒绝非员工及离职员工分配；统一 `computeEffectiveStaffPermissions` 输出权限集、独立约束标记下的多自定义角色严格仓库交集（不随空交集回弹扩域）以及 PC/手机导航与工作模块。 |

- **集成测试套件**：[tests/pkg1-wave78-staff-rbac.test.mts](../../../tests/pkg1-wave78-staff-rbac.test.mts)（已纳入 `package.json` `test:integration`）。

---

## 三、终审验证与独立 Reviewer 结果

- **独立只读 Reviewer（`75f4f21c-4e3b-4562-aa35-fd9903965ef5`）**：首轮审出 3 项阻断缺陷（多角色仓库交集回弹、`staff.invited` 邮件入队/激活冲突吞错、老员工/客户/交接对象边界）及 3 项防线与回归覆盖缺口；全部整改复核后签发 **`VERDICT: PASS`**。
- **空库与静态契约验证**：
  - 隔离空库 `qcw_t179_empty` 顺序执行 `001`–`015` 迁移 + `docs/contracts/verify.sql` -> `PASS`
  - `npm run check` (`tsc --noEmit`) -> `PASS`
  - `python3 docs/contracts/check.py`（264 tasks / 67 production gates / 51 transaction operations）-> `PASS`
  - `python3 tests/contract-check.test.py` -> `16/16 OK`
  - `QCW_DEMO=0 NEXT_TELEMETRY_DISABLED=1 npm run build` -> `PASS`
- **全量集成测试（`npm run test:integration` on isolated `qcw_test-pkg1-w78`）**：`141` pass、`0` fail、`0` skipped、`0` cancelled。
