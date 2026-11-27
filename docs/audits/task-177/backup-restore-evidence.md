# TASK-177｜迁移前真实备份、隔离恢复与消除假健康探针证据 (`backup-restore-evidence`)

- **执行边界**：严格在本地隔离临时数据库（`qcw_t177_source` -> `qcw_restore_*` -> 用完删除）验证真实 `pg_dump` / `pg_restore`、媒体与账务清单核对、坏备份拒绝与分层健康检查；**严禁改动或读取生产 VPS 数据库及 `.env` 密钥**。

---

## 一、消除 `healthy: triggers.length >= 5` 假健康探针（`LIF-012`, `§68.1`, `§69.1`, `§92.1`）

| 修改文件 | 原先缺陷 | 现行真实实现 |
|---|---|---|
| [packages/core/operations.ts](../../../packages/core/operations.ts) (`systemHealthAndBackupCheck`) | 仅检查 5 个不可变触发器即返回 `healthy: true` | 拆为 6 个独立健康层 `checks`: `database`（实时连通延迟）、`migrations`（`qc_migrations >= 13`）、`immutable_triggers`（5 个触发器）、`outbox_queue`（区分 pending/retrying/exhausted `attempts >= 5`）、`media_storage`（诚实暴露 `postgres_private_files_legacy` 过渡 `degraded` 状态与字节数）、`backup_restore`（未有真实带 `manifest_sha256` + `dump_sha256` 隔离恢复前为 `unknown`）。`exhausted_count > 0` 或缺失迁移/触发器时 `healthy` 为 `false`。 |
| [packages/core/operations.ts](../../../packages/core/operations.ts) (`recordRecoveryDrill`) | 手工点击即无条件置 `verified: true` 并可能在非测试环境修改表记录 | 非测试/非演示环境下，无 `manifest_sha256` + `dump_sha256` + 异库 `environment_fingerprint` 时**阻断所有会话/用户修改副作用**（`production_side_effect_blocked: true`），记为 `manual_registration_unverified` (`verified: false`, `production_verified: false`)；同库指纹返回 `409 RECOVERY_NOT_ISOLATED`；仅核验清单且 `payment_handover_reconciliation.reconciled` 与健康检查全部通过后，才标记 `production_verified: true`。 |
| [scripts/backup-restore-check.mjs](../../../scripts/backup-restore-check.mjs) | 同样使用 `triggers.length >= 5` 假健康逻辑 | 同步升级为与服务端完全一致的 6 层真实诊断、分层退出码及 `backup_restore: "unknown"` 真实披露。 |
| [app/operations-desk.tsx](../../../app/operations-desk.tsx) (`SystemHealthAndRecoveryPanel`) | 仅展示单一正常/告警数字与普通表单 | **直接平铺展开（不折叠）** 6 项分维度实时健康表（含 `Unknown` / `Degraded` / `Operational` 状态标签）、`manifest_sha256` / `dump_sha256` / 异库指纹录入栏，并按 `real_verified` / `test_drill` / `unverified` 诚实区分演练历史记录。 |

---

## 二、真实 `pg_dump` + `pg_restore` 隔离演练实测结果（`scripts/pre-migration-backup-restore.mjs` / `npm run ops:backup-verify`）

- **执行命令**：`SOURCE_DATABASE_URL="postgres:///qcw_t177_source?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`
- **外发隔离标志**：`outbound_side_effects_disabled: true`；源库仅执行只读导出，恢复在全新独立临时库 `/tmp/qcw_restore_1795773246694` 完成并自动销毁。
- **核心哈希与耗时实测值**：
  - 基线 Commit：`d12a593423729b0f8d2ae5f1479c8399d12e705f`（含工作区 `TASK-177` 脚本）
  - 逻辑全库导出（`pg_dump --format=custom`）：`dump_bytes = 335,001`，`dump_sha256 = f76b938beda31326a72a28e8a56cc10635ef7867be8477f8fa4a26e17a4c564d`
  - 账务/迁移/媒体/凭据元数据清单：`manifest_sha256 = 652cb26abda27144d62599b556441e86e2583ed3b539c39b4b7fefd92e16c260`
  - **100% 恢复对账一致**：`migrations_verified = 13`（`001`–`013`）、`immutable_triggers_verified = 5`、`invalid_constraints = 0`、`table_counts`（`users: 6, organizations: 1, integration_providers: 15` 等）、`financial_totals`、`media_manifest`、`published_report_hashes` 与 `credential_recovery_inventory`（仅元数据、零密钥密文或明文）逐项一致；`schema_only_empty_clone` 下 `docs/contracts/verify.sql` 通过。
  - **负向坏包拒绝实测**：翻转备份二进制字节后触发 SHA-256 不匹配且 `pg_restore --list` 拒绝加载（`corrupt_backup_rejected: true`）。
  - **实测 RPO / RTO（本地演练库规模）**：`rpo_seconds = 0`、`rto_ms = 803`（`1s`；真实生产全量库 RTO 待实生产预发布环境另测）。

---

## 三、凭证恢复策略与当前明确留白（`UNVERIFIED` / 待授权前哨）

1. **凭证与密钥恢复边界**：
   - `AUTH_OTP_PEPPER`（解密 `integration_secrets` AES-256-GCM 密文的核心根密钥）与 `/etc/qcwarehouse/application.env` 严禁随数据库 dump 导出；必须在离线/独立密钥保管空间保存，迁移或重建服务器时先核对 `credential_recovery_inventory` 中的 `key_version` 与通道清单，再注入等价根密钥。
   - **不可逆与外部清点边界（保持 `UNVERIFIED` / 需独立授权后在目标环境执行）**：
     - 实际 VPS 生产库（`89.117.172.74`）`pg_dump` 与异机恢复演练（须另获授权在预发布/新环境执行）；
     - 独立私有对象存储备份桶（待 `TASK-185/186` 落地后补齐对象清单跨桶副本校验）；
     - 正式商业价格/条款审批、真实外部账务小额扣退核对与实仓实物盘点。
2. **高风险迁移前复用规范**：从 `PKG-1` 起每逢结构性或数据迁移前（`TASK-178`、`180`、`181`、`185`、`188`、`195`、`229` 等），均须先对目标前态执行 `npm run ops:backup-verify` 并留存当次 `dump_sha256` 与 `manifest_sha256`。
