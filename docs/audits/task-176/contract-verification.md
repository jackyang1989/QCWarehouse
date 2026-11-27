# TASK-176｜五文档、保留技术协议与工程契约最终核对证明 (`contract-verification`)

- **基准基线**：在 `d12a593`（代码等价于 `e386eae`）上执行非破坏性文档与工程契约最终校验，并纳管自动化 CI 负向回归套件 [tests/contract-check.test.py](../../../tests/contract-check.test.py) 及 [core-contract.yml](../../../.github/workflows/core-contract.yml)。
- **签收范围说明**：本文件及 `TASK-176` 仅签署**文档结构、保留技术协议完整性与自动化契约/CI 校验**；**不签署 `L04` 任何一项业务/现场/外部生产门禁**（67 项门禁保持 `PRODUCTION_NOT_READY`）。

---

## 一、五份权威文档与保留 R1 技术协议核对结论

| 核对项 | 位置与实查依据 | 核对结果 |
|---|---|---|
| 1. 唯一冻结原始需求 | [01–116 权威指令](../../QC_Warehouse_生产级统一重构执行指令_最终完整01-116_AI服务与专业翻译全业务闭环版.md) SHA-256 `5733d75114f34867d16e77ffa37aff5669837fa108f82af76e5ce265462d02b3` | 字节未改，117 主章（00–116）完整归属无重复 |
| 2. 产品功能与验收门禁 | [QCWarehouse_PRD_v3_MultiCategory.md](../../QCWarehouse_PRD_v3_MultiCategory.md) | 82 项 `AT-01..AT-82` 完整保留，AT 末列主责已全部精确对齐第 3 列 `实施责任`（含字母子任务 `TASK-*A/B`） |
| 3. 履约实施规格与 R1 技术协议 | [开发规格.md](../../开发规格.md) | 原保留技术协议未删：`§19` 物流查询（L1580）、`§21` 双 OIDC/OTP（L1755）、`附录 B` 功能目录（L2004）、`附录 C` Stripe（L2214）、`附录 D` 仓库 SOP（L2361）、`S01` 架构契约（L2476）、`S13` `R01–R13`（L3063）、`S14` `T01–T147`（L3438）及 **121** 张 `PAGE` 契约 |
| 4. 分包排期与门禁闭包 | [生产级统一重构分包排期与需求追踪矩阵.md](../../生产级统一重构分包排期与需求追踪矩阵.md) | `K01` 90 项（69 父 + 21 子）无环且全部入 `TASK-243` 传递闭包；`K03` 67 项门禁闭包全部成立（含 `BUSINESS_APPROVED` -> `TASK-197B`，`INSTRUCTION_EXECUTION_TRACE_VERIFIED` 与 `F01` -> `TASK-243`） |
| 5. 任务台账及历史保护 | [开发排期与任务台账.md](../../开发排期与任务台账.md) | `L02` 历史 `TASK-001..174`（174 项）与 `L08` 归档完整保留；`L03` 90 项（`E237–E654`）与 `K01` 依赖/窗口逐项一致；`L04` 67 项门禁归口与 `K03`/`K04` 完全一致 |

---

## 二、数据库契约对照：`docs/contracts/schema.sql` vs 运行迁移 `001`–`013`

在本地独立临时库 `qcw_t176_schema` 与 `qcw_t176_migrated` 上实测：
- **`qcw_t176_schema`**：直接执行 `psql -X -v ON_ERROR_STOP=1 -f docs/contracts/schema.sql` 建出 **100** 张表，运行 `docs/contracts/verify.sql` 通过（`BEGIN / DO / ROLLBACK`）。
- **`qcw_t176_migrated`**：执行 `node scripts/migrate.mjs` 顺序应用 `001_initial.sql`–`013_email_delivery_provider.sql`，建出 **103** 张域表（另有 `qc_migrations` 元表），运行 `docs/contracts/verify.sql` 通过。
- **表与列差异定位（零缺失 `schema.sql` 定义，`only_schema = []`）**：
  - `schema.sql` 已包含 `010`/`013` 的集成/OCR 表结构，未丢失任何基础定义。
  - 运行迁移 `002`–`007` 增量额外建了 3 张运行时表（`pending_registrations`、`private_files`、`shipment_return_items`）及 8 张表的运行时增强列（`auth_identities.email_id`、`media_assets.shipment_id`、`outbox_events.{attempts,last_error,next_attempt_at}`、`packages.tracking_owner_key`、`storage_locations.{capacity,notes}`、`tickets.revision`、`tracking_records.{batch_id,tracking_owner_key}`、`verification_challenges.verified_identity`）。结论：`packages/db/migrations/001`–`013` 是运行时唯一真实演进权威，`schema.sql` 与 `verify.sql` 均通过校验，后续新增结构一律通过 `014+` 迁移追加（`AGENTS.md` §3.6）。

---

## 三、`L07.1` 自动化校验与 CI 负向回归覆盖

- 校验器：[docs/contracts/check.py](../../contracts/check.py)（完整匹配 `TASK-[0-9]{3}[A-Z]?`，无父编号投影，验证 `K01/L03/K03/K04/L04`、`AT` 实施责任、`PAGE` 映射、相对链接、OpenAPI Schema 及 `Result` / `return_to_seller` 不变量）。
- 永久回归测试套件：[tests/contract-check.test.py](../../../tests/contract-check.test.py)（共 **16** 项：1 项正向基线 + `L07.1` 强制要求构造拒绝的 **13** 项负向回归 + **2** 项既有链接/OpenAPI 不变量防弱化测试），已接入 GitHub Actions [core-contract.yml](../../../.github/workflows/core-contract.yml)。
