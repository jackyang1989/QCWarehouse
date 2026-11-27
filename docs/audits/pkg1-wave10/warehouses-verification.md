# PKG-1 Wave 10｜自营仓与库存主数据（`TASK-182`）验证证据

- **签收边界**：本阶段签署 `017` 增量 SQL 迁移、自营仓库主数据、库区/批量库位/容量与预约并发控制、容器防环与跨仓调拨、包装耗材库存台账及停用/归档依赖守卫；`001`–`016`、`warehouse_addresses`、`storage_locations` 既有调用链与 `67` 项 `L04` 生产门禁保持完整未触碰。

---

## 一、`017` 迁移前全库备份恢复演练（`TASK-177` 规程）

- **来源隔离库**：`qcw_t182_pre`（完整应用 `001`–`016` 后于 `96aef5e` 执行 `SOURCE_DATABASE_URL="postgres:///qcw_t182_pre?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`）：
  - `dump_bytes = 386,652`
  - `dump_sha256 = 633cd63ca5c67ab55b248af812e352f31c630b145f33b77cf9b920db6c0d2cb7`
  - `manifest_sha256 = 2949c088254da5b86efb4d641da56bcae325402615f5e943f28c6ad4056b7a78`
  - `migrations_verified = 16`、`immutable_triggers_verified = 5`、`corrupt_backup_rejected = true`、`rpo_seconds = 0`、`rto_ms = 217`、`all_assertions_passed = true`

---

## 二、增量 `017` 迁移与核心实现清单

- **SQL 迁移**：[017_warehouse_master_and_inventory_governance.sql](../../../packages/db/migrations/017_warehouse_master_and_inventory_governance.sql)
  - 新建 `warehouses`（初始草稿态、`accept_new_orders/accept_inbound_transit/allow_fulfillment/allow_dispatch` 四权分立）、`warehouse_zones`（10 类功能库区与地面区标记）、`warehouse_containers`（防自环检查）、`location_reservations`、`packaging_consumables`、`consumable_stock_ledger`、`warehouse_transfer_orders`（禁同仓调拨）并安全扩展 `storage_locations` 增量列。
- **核心领域服务**：[packages/core/warehouses.ts](../../../packages/core/warehouses.ts) + [packages/core/http.ts](../../../packages/core/http.ts)
  - 仓库建档（禁预置虚假收货仓）、激活前置地址快照与库区校验、地址快照轮转不改历史快照、停用前依赖影响预览与阻断（占用件/预约/容器/在途调拨）、库位行级锁预约防超卖/缩容/误停用、容器跨仓隔离与递归 CTE 防环形嵌套、包装耗材流水账防负库存。

---

## 三、全量验证与独立 Reviewer 结果

- **空库与静态契约验证**：
  - 隔离空库 `qcw_t182_empty` 顺序执行 `001`–`017` 迁移 + `docs/contracts/verify.sql` -> `PASS`
  - `npm run check` (`tsc --noEmit`)、`python3 docs/contracts/check.py`、`python3 tests/contract-check.test.py`（16/16 OK）与 `QCW_DEMO=0 NEXT_TELEMETRY_DISABLED=1 npm run build` -> 全部 `PASS`。
- **全量集成测试（`npm run test:integration` on isolated `qcw_test-pkg1-w10`）**：`143` pass、`0` fail、`0` skipped（含新增 [tests/pkg1-wave10-warehouses.test.mts](../../../tests/pkg1-wave10-warehouses.test.mts) `TASK-182` 全流程及负向边界用例）。
- **独立只读 Reviewer**：首轮审计（`e1bdcd2f-9a0f-426d-8aa6-fbfcc25740f1`）指出 4 项边界发现（有子容器嵌套时禁调拨父容器、新建容器与调拨收货补齐冻结库位阻断、预约/耗材建档加 `FOR SHARE` 消除与归档竞态、推荐接口先鉴权后验参）；全数整改并在二次独立只读复核（`856d29b3-7bcc-4b30-8029-251fe51f31ae`）签发 **`VERDICT: PASS`**。
