# TASK-175｜测试夹具与直接 SQL 绕过登记册 (`fixture-bypass-register`)

- **冻结基准 Commit**：`e386eaeb87c8737c586ee0f4d368887808434a07`
- **核查目的**（依据 `01-116` 第 84.2 节方向 4 与 `LIF-005`）：清查测试套件与脚本中所有直接执行 SQL 写入（`INSERT` / `UPDATE` / `DELETE`）的操作，严格区分 **合法安全初始化 (`SAFE_BOOTSTRAP`)**、**测试时态/异常状态模拟 (`TEST_FIXTURE_ONLY`)** 与 **因正常运营入口缺失而绕过产品的缺陷 (`PRODUCT_ENTRY_MISSING`)**，防止开发者用夹具掩盖运营不可用的问题。

---

## 一、脚本与 SQL 文件级直接写入汇总

| 文件 | 总行数 | 涉及直接写表数 | 定位说明 |
|---|---|---|---|
| [scripts/migrate.mjs](../../../scripts/migrate.mjs) | 34 | 1 (`qc_migrations`) | 合法迁移登记 |
| [scripts/demo.ts](../../../scripts/demo.ts) | 115 | 20 张表 | 仅本地 `QCW_DEMO=1` 演示例子；**严禁作为生产开户/目录初始化依赖** |
| [tests/shadow-categories.sql](../../../tests/shadow-categories.sql) | 39 | 6 张表 | 隔离库验证 `bags`/`home` 影子配置；验证通用引擎零代码改动 |
| [tests/admin-workbench.test.mts](../../../tests/admin-workbench.test.mts) | 453 | 6 张表 | **含 `LIF-005` 实证**：直接插库建员工与角色 |
| [tests/round5-payments-ocr.test.mts](../../../tests/round5-payments-ocr.test.mts) | 1093 | 11 张表 | 直接写客户组织、员工角色、报价、支付及 OCR 任务等 |
| [tests/workflow.test.mts](../../../tests/workflow.test.mts) | 8867 | 42 张表 | 覆盖全流程测试及大量直接插表 setup（`categories`, `service_offers`, `sku_prices`, `terms_versions`, `staff_roles`, `warehouse_addresses`, `shipping_rate_versions` 等） |
| [tests/workspace.browser.mjs](../../../tests/workspace.browser.mjs) | 2676 | 11 张表 | Playwright 浏览器用例内直改引用/报价/区块等用于时间窗口和边界状态准备 |

---

## 二、绕过路径逐项分级审查（核心运营入口 vs 测试夹具）

| 绕过点与源码位置 | 直接写入的表与字段 | 分类判断 | 原因分析与缺口 | 目标修复任务 |
|---|---|---|---|---|
| [tests/admin-workbench.test.mts](../../../tests/admin-workbench.test.mts) L104–116<br>[tests/round5-payments-ocr.test.mts](../../../tests/round5-payments-ocr.test.mts) L666–675<br>[tests/workflow.test.mts](../../../tests/workflow.test.mts) L465, L711, L2028, L2699–2703<br>[scripts/demo.ts](../../../scripts/demo.ts) L19–23 | `users`, `user_emails`, `staff_roles`（直接插入员工账号、密码哈希/MFA 跳过及角色绑定） | **`PRODUCT_ENTRY_MISSING`** | **对应 `LIF-001`, `LIF-002`, `LIF-005`**：当前产品不存在「后台新增/邀请员工 -> 员工一次性激活自设密码及 TOTP」的 HTTP/UI 正式入口；若不靠 SQL 或 `demo.ts`，新系统无法建第二位有不同岗位的员工 | TASK-178, TASK-179 |
| [scripts/demo.ts](../../../scripts/demo.ts) L27–29 | `warehouse_addresses`, `storage_locations` | `PARTIAL` / 需升级 | `/admin/config` 与 `/admin/storage/locations` 已存在新增能力，但新系统缺少真实独立仓库（Warehouse 实体）、工位与机位初始化向导（`LIF-008`），且 `demo` 仓址需严禁流入生产 | TASK-182, TASK-183 |
| [scripts/demo.ts](../../../scripts/demo.ts) L55–103<br>[tests/workflow.test.mts](../../../tests/workflow.test.mts) L322, L2740–2829, L6511–6515<br>[tests/shadow-categories.sql](../../../tests/shadow-categories.sql) | `categories`, `capabilities`, `service_types`, `template_versions`, `template_capabilities`, `service_offers`, `offer_templates`, `sku_prices` | **`PRODUCT_ENTRY_MISSING`** | 当前仅在 `demo.ts` 塞了少量服装演示模板；新系统从零部署时**缺少正式目录、完整服装 L1–L5/M01–11 知识库与可审核初始定价的合法初始化包（`TASK-195`）**；测试也直接绕过定价审批插入 `sku_prices` | TASK-195, TASK-196, TASK-197 |
| [scripts/demo.ts](../../../scripts/demo.ts) L110–111 | `shipping_rate_versions`, `app_config` (`storage.daily_cents`) | **`PRODUCT_ENTRY_MISSING`** | **`LIF-007` / `LIF-010`**：`storage.daily_cents` 与 `storage.free_days` 无管理后台编辑页面，测试/演示例靠 `demo.ts` 直接插入 | TASK-222, TASK-227, TASK-235 |
| [tests/workflow.test.mts](../../../tests/workflow.test.mts) L6604, L6609 | `app_config` (`launch.signoff`) | `TEST_FIXTURE_ONLY` + 门禁待升级 | 测试临时切换开业状态，但在真实系统中需对接 `K03` 67 项门禁与独立验收链（`TASK-242/243`） | TASK-242, TASK-243 |
| [scripts/demo.ts](../../../scripts/demo.ts) L40–44<br>[tests/round5-payments-ocr.test.mts](../../../tests/round5-payments-ocr.test.mts) L110–120 | `users`, `organizations`, `memberships`, `customer_receiving_profiles`, `user_emails` | `TEST_FIXTURE_ONLY`（对应正式注册流程已存在） | 客户通过 `/login` -> OIDC/OTP -> `/onboarding` 可完成正常注册；但需在“从零开业”测试 `PKG-11` 中去除直接插表依赖，用真实页面/接口走通注册 | TASK-178, TASK-243 |
| [tests/workflow.test.mts](../../../tests/workflow.test.mts) L278, L294, L905, L983, L1371, L2087, L3847<br>[tests/workspace.browser.mjs](../../../tests/workspace.browser.mjs) L354, L411, L1388–1398 | `inspection_quotes`, `payments`, `refunds`, `dispatch_quote_versions`, `storage_quotes`, `charge_items`, `order_blocks`, `scope_revisions`, `recovery_requests` | `TEST_FIXTURE_ONLY`（含 `PARTIAL` 边界） | 主要用于模拟报价过期时间（`expires_at` 回拨）、并发支付失败或恢复冷却窗口；其中 `reference_samples`、`terms_versions` 临时状态变更已具基本后台/业务接口，需在 `TASK-228/243` 中复核无绕过可完成整套演练 | TASK-228, TASK-243 |
| [tests/workflow.test.mts](../../../tests/workflow.test.mts) L563, L3002<br>[tests/workspace.browser.mjs](../../../tests/workspace.browser.mjs) L583–606 | `warehouse_items`, `reference_samples`（直写已封存确认样与到期时间） | `PARTIAL`（测试快捷建样） | Golden Sample 在正式运营中应经过“收货核身 -> 独立 QA 批准 -> 付费激活合同”完整链路（`TASK-228A/228`），不可由后台直接跳过付款标记可用 | TASK-228A, TASK-228, TASK-228B |
| [scripts/migrate.mjs](../../../scripts/migrate.mjs) L24 | `qc_migrations` | `SAFE_BOOTSTRAP` | 合法、幂等（带 SHA-256 校验）数据库版本迁移追踪，应保留 | TASK-177 |

---

## 三、整改约束（供 `TASK-177` 与 `TASK-243` 执行）

1. **A 线“从零开业”与 `Z01` 验收**（`§85.1`, `LIF-005`）：严禁运行 `scripts/demo.ts`；只允许受控迁移 + 合法安全一次性 `Owner` 初始化（`TASK-178`）+ 正规后台录入（仓库、员工邀请与激活、地区数据、目录与价格、条款、集成凭证）完成开业，所有 `TEST_FIXTURE_ONLY` 直写语句禁止进入开业/生产运行路径。
2. **既有 125 项隔离集成测试保护**：改造各领域时必须继续保持现有隔离回归通过（`test:integration`），严禁为图方便删改测试断言或新增“仅测测试夹具、不走产品接口”的伪测试。
