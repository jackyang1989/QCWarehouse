# PKG-1 Wave 9｜中国行政区划主数据与统一地址服务（`TASK-181`）验证证据

- **签收边界**：本阶段签署 `016` 增量 SQL 迁移、MIT 许可完整 GB/T 2260 + 乡级行政区划数据源接入（[region-source-manifest.json](./region-source-manifest.json)）、[regions-seed.ts](../../../packages/core/regions-seed.ts)、[regions.ts](../../../packages/core/regions.ts)、[import-china-regions.mjs](../../../scripts/import-china-regions.mjs) 与全端 `REG01–16` / `COM01` 隔离集成回归；`67` 项 `L04` 正式门禁（含 `REGION_MASTER_DATA_VERIFIED`、`ADDRESS_REGION_INTEGRATION_VERIFIED`）继续保持 `PRODUCTION_NOT_READY`。

---

## 一、`016` 迁移前全库备份恢复演练（`TASK-177` 规程）

- **来源隔离库**：`qcw_t181_pre`（完整应用 `001`–`015` 后于 `f00ca28` 执行 `SOURCE_DATABASE_URL="postgres:///qcw_t181_pre?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`）：
  - `dump_bytes = 359,137`
  - `dump_sha256 = 0e372ccfef2766c4b93481394dd4fe5333fe833d1e6996580f0de6065b66c379`
  - `manifest_sha256 = 7ad8c83bc30110a2f8dca6248c7250135fbc455fb8609dd3dfe912782c2b4619`
  - `migrations_verified = 15`、`immutable_triggers_verified = 5`、`corrupt_backup_rejected = true`、`rpo_seconds = 0`、`rto_ms = 249`、`all_assertions_passed = true`

---

## 二、权威来源核验与 `016` 核心资产

- **数据来源摘要**（见 [region-source-manifest.json](./region-source-manifest.json)）：
  - 包：`@province-city-china/data@9.0.0`（`MIT` License，`https://github.com/uiwjs/province-city-china`）
  - 原始文件：`data.json`（`5,744,376 bytes`、`sha256 = afc9663c3150eb4df6e55d61d04a329965906673a3c4441bd39f5ff007d38f13`）
  - 标准化统计：省级 `34`（中国大陆 `31` + 港澳台 `3`）、地级 `333`（跳过 `4` 个直辖县虚拟分组节点 `419000/429000/469000/659000`）、县级 `2,873`（中国大陆 `2,847` + 港澳 `26`）、唯一乡级 `38,930`（合并 `659001100000` 重复别名）。
- **核心代码**：
  - [016_region_master_data_and_address_service.sql](../../../packages/db/migrations/016_region_master_data_and_address_service.sql)：新建 `region_dataset_versions`（单活部分唯一索引）、`regions`、`region_aliases`、`region_change_mappings`、`address_snapshots`（附 `forbid_address_snapshot_mutation()` 只追加触发器）与 `region_import_runs`。
  - [packages/core/regions-seed.ts](../../../packages/core/regions-seed.ts) 与 [scripts/import-china-regions.mjs](../../../scripts/import-china-regions.mjs)：毫秒/秒级幂等导入完整数据集，不覆盖既有运营别名与已激活版本。
  - [packages/core/regions.ts](../../../packages/core/regions.ts) + [packages/core/http.ts](../../../packages/core/http.ts)：中英拼音编码及别名检索、祖先链路径服务端校验（支持直辖市、东莞/中山/儋州/嘉峪关及省直管县，拒绝跨省伪造路径与港澳台误入国内自动计价）、本地中文地址智能解析（遵循 `§59.1` 集运地址简化决断，无独立 `member_code`/`insert_position` 字段、脱敏号禁寄出）、版本差异与防大面积误删预检、SoD 发布/回滚及通知事件。

---

## 三、全量验证与独立 Reviewer 结果

- **空库、CLI 与构建验证**：
  - 隔离空库 `qcw_t181_empty` 顺序执行 `001`–`016` 迁移 + `docs/contracts/verify.sql` -> `PASS`
  - `npm run db:regions`（`@province-city-china/data@9.0.0`）隔离库连续两次实测：首跑导入 `34 / 333 / 2,873 / 38,930`（耗时 <3s），次跑幂等 `skipped: true` 且不覆盖既有别名与版本。
  - `npm run check` (`tsc --noEmit`)、`python3 docs/contracts/check.py`、`python3 tests/contract-check.test.py`（16/16 OK）与 `QCW_DEMO=0 NEXT_TELEMETRY_DISABLED=1 npm run build` -> 全部 `PASS`。
- **全量集成测试（`npm run test:integration` on isolated `qcw_test-pkg1-w9`）**：`142` pass、`0` fail、`0` skipped（含新增 [tests/pkg1-wave9-regions.test.mts](../../../tests/pkg1-wave9-regions.test.mts) `REG01–16` / `COM01` 与负向越权/冲突断言）。
- **独立只读 Reviewer**：首轮审计（`51864e25-e019-45b2-80d7-83e64e2eefe7`）提出 5 项整改（`createAddressSnapshot` 角色与可选区域校验、`GET /regions/children` Zod 参数校验、省市区冲突标记、废止节点路径拦截、导入咨询锁与计数落档）；全数整改并在二次独立只读复审（`65443a19-92a8-4c0c-8693-919d040d8dc3`）签发 **`VERDICT: PASS`**。
