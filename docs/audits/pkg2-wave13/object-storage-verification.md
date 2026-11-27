# PKG-2 Wave 13｜对象存储适配及私有访问（`TASK-185`）验证证据

- **签收边界**：本阶段在隔离验证环境签署 `020` 增量 SQL 迁移、通用 `ObjectStorageProvider` 抽象与纯 Node Crypto AWS SigV4 适配层（覆盖 Cloudflare R2 / Amazon S3 / Backblaze B2 / 通用 S3 能力矩阵）、Endpoint 防 SSRF 守卫、禁止生产环境无外部存储时静默回退本地盘/PG `BYTEA` 守卫、预签名直传与分片上传编排、服务端流式真实 SHA-256 + 文件头魔数隔离守卫、短期私有 GET 与 `Range: bytes` 206 流式访问、租户隔离、不可变触发器与受控保留/法定保全删除阻断；真实 R2/S3/B2 线上账号与跨境测速保持 `PENDING_EXTERNAL_VALIDATION`，`001`–`019` 与 `67` 项 `L04` 生产门禁保持完整未触碰。

---

## 一、`020` 迁移前全库备份恢复演练（`TASK-177` 规程）

- **来源隔离库**：`qcw_t185_pre`（完整应用 `001`–`019` 后执行 `SOURCE_DATABASE_URL="postgres:///qcw_t185_pre?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`）：
  - `dump_bytes = 474,667`
  - `dump_sha256 = ca3e55988834dad5bf03b45c2b3f82ab15a09087bec9cb0d3b0859a48b4146b2`
  - `manifest_sha256 = a78b336705caa656cfa39ddcbf43fe10435d0569a8a84d43d7b1bb0636d50c20`
  - `migrations_verified = 19`、`immutable_triggers_verified = 5`、`corrupt_backup_rejected = true`、`rpo_seconds = 0`、`rto_ms = 377`、`all_assertions_passed = true`

---

## 二、增量 `020` 迁移与核心实现清单

- **SQL 迁移**：[020_object_storage_foundation.sql](../../../packages/db/migrations/020_object_storage_foundation.sql)
  - 新建 `storage_objects`、`storage_upload_sessions`、`storage_access_audit`，并配置 PostgreSQL `BEFORE UPDATE` 触发器 `storage_objects_immutable_guard` 严禁覆盖/回滚已核验就绪（`ready` + `is_immutable`）对象的摘要、桶位与键路径。
- **对象存储适配与私有服务**：[packages/core/object-storage.ts](../../../packages/core/object-storage.ts) + [packages/core/storage-service.ts](../../../packages/core/storage-service.ts) + [packages/core/http.ts](../../../packages/core/http.ts)
  - 四类 S3 兼容能力矩阵与实测探针（`runStorageCapabilityProbe`）、Endpoint SSRF 过滤、生产禁退回守卫、单文件/分片预签名授权、服务端独立流式 SHA-256 与魔数校验（拦截伪装 `<svg>` 等主动内容并持久化写入 `quarantined`）、`Range` 206 私有流式读取、跨租户 404 隔离及 `legal_hold`/保留期受控删除拦截。

---

## 三、全量验证与独立 Reviewer 结果

- **空库与静态契约验证**：
  - 隔离空库 `qcw_t185_empty` 顺序执行 `001`–`020` 迁移 + `docs/contracts/verify.sql` -> `PASS`
  - `npm run check` (`tsc --noEmit`)、`python3 docs/contracts/check.py`、`python3 tests/contract-check.test.py`（16/16 OK）、`npm run test:brand`（3/3 OK）与 `QCW_DEMO=0 NEXT_TELEMETRY_DISABLED=1 npm run build` -> 全部 `PASS`。
- **全量集成测试（`npm run test:integration` on isolated `qcw_test-pkg2-w13`）**：`146` pass、`0` fail、`0` skipped（含新增 [tests/pkg2-wave13-object-storage.test.mts](../../../tests/pkg2-wave13-object-storage.test.mts) `TASK-185` 全流程及负向安全/隔离用例；真实 R2/S3/B2 账户连通仍标记 `PENDING_EXTERNAL_VALIDATION`）。
- **独立只读 Reviewer**：
  - 首轮审计（`d5c62344-7a25-4117-9fcf-41b6782095cf`）提出 8 项发现（含 `delete_blocked` 独立审计持久化防回滚及防死锁、`Range` 越界/反转实返 `416` 与 `nosniff`、DNS + 防重定向 + IPv4 兼容 IPv6 SSRF 过滤、`CompleteMultipartUpload` ETag 严格校验与分片一致性、暂存区预签名上传→不可变正式路径拷贝升格防重放覆盖、物理删与 `is_immutable` 触发器加固、大文件 `head.sizeBytes` 预检与有界流）；
  - 全数整改并补充负向回归测试，整改后全量验证全部通过，经二次独立只读复核（`2da7a645-cb01-4df9-8f28-005d7f2bbbe1`）签发 **`VERDICT: PASS`**。
