# PKG-4 Wave 25（TASK-198 · 工时与成本采集底座）实施与独立验收记录

- **任务编号**: `TASK-198` / `PKG-4 · E390–E394`
- **对应页面与规格**: `PAGE-M22`（`/admin/pricing` 成本模型与毛利沙盘子视图）、`PAGE-M08`（`/admin/finance` 跳转入口）、`PAGE-H03`（`/wh/task/[id]` 真实时钟计时）、`§10`、`§31`、`§43.3`、`§71.2`、`§82`、`§89`、`§112.2`、`R06`、`G07`、`G16`
- **当前状态**: `待验收`（所有已发布成本模型版本均标记 `publication_scope='sandbox_acceptance'` 且 `business_approved=false`；真实工时样本校准与商业签收须通过 `TASK-199B` 与 `TASK-197B` 独立完成，严禁以此阶段暂估数据给出正式商业/SLA 承诺；`L04` 67 项生产门禁保持 `PRODUCTION_NOT_READY`）

## 1. 交付产物

1. **增量数据库迁移**：[`packages/db/migrations/032_labor_and_cost_foundation.sql`](../../../packages/db/migrations/032_labor_and_cost_foundation.sql)
   - `labor_time_events`（23 项 `activity_code`、4 类时间桶 `active_labor` / `non_parallel_wait` / `background_system` / `interruption`、跨订单/任务/调度项/包裹/实物/点位/证据多维度关联与停表净耗时计算）。
   - `labor_time_corrections`（含只追加不可变 PL/pgSQL 触发器 `freeze_labor_time_correction`，完整留存原始记录、修改原因、操作者及修正值）。
   - `labor_baseline_assumptions`（`§43.3` 暂估分钟区间与 `data_source`/`sample_size` 标注）。
   - `cost_models` 与 `cost_model_versions`（含防管理费双计数据库约束 `cost_models_no_double_mgmt_overhead`、非作者/非提审者三权分立 `cost_model_versions_sod_check` 及不可变触发器 `freeze_cost_model_version`）。
   - `order_cost_ledger_entries`（逐笔区分直接变动成本与固定分摊、实测/暂估/分摊口径及原始币种/汇率来源）与 `labor_cost_seed_runs`。
2. **领域种子与真实时钟/成本/毛利引擎**：
   - [`packages/core/labor-cost-seed.ts`](../../../packages/core/labor-cost-seed.ts)：`LABOR_COST_SEED_VERSION = "2026-11-labor-cost-v1"`，幂等初始化 `19` 项 `§43.3` 暂估工时基准（含 `visual_inspect` `ALL`/`L1`–`L4`）与 `standard_apparel_cost_v1` 成本模型草稿（`business_approved=false`）。
   - [`packages/core/labor-cost-engine.ts`](../../../packages/core/labor-cost-engine.ts)：
     - 真实时钟生命周期与防双计：`startLaborEvent`（同操作员多 `active_labor` 互斥自动暂停）、`pauseLaborEvent` / `resumeLaborEvent`、`completeLaborEvent`（含结束时间与开始时间倒置 422 拦截）、`recordBackgroundSystemMetric`（`background_system` 与 `active_labor` 完全隔离不暂停人工计时）、`markStaleOpenLaborEventsPendingCalibration`（`COST_EDIT_ROLES + warehouse_admin` + MFA 标记超时离线为 `pending_calibration`）、`correctLaborEvent`（区间校验与不可变修订留痕）。
     - 统计与基线对照：`getLaborStatistics`（完成/已校正有效人工分位数 `P50/P75/P90/Max`、四桶耗时分离、零分母返回 `null` 的复测/重拍/失败/QA退回率、`<10` 样本自动标 `insufficient_samples`、超 ±20% 偏差仅发 `pricing_advisory_alerts` 绝不自动改价）。
     - 成本模型审批、毛利沙盘与订单核算：三权分立草拟/提审/独立发布/退役/回滚；`simulateUnitEconomicsAndMargin` 实现 `§43.3` `P = Math.ceil(C / (1 - f - m))`、不可行模型 `1 - f - m <= 0` 识别、单件 `$5 L1` 亏损警告及 4 组缺陷/返工敏感度；`generateStandardCostMatrix` 基于已发布价格快照生成 `1/3/10/30/50/100 × L1–L4 × base/pom_5pt/full` 72 行矩阵；`getOrderCostProfitBreakdown` 对接实付/退款、`labor_time_events`、`order_cost_ledger_entries`（防止 `labor_direct`/`labor_qa` 与衍生工时重复计费，缺项明确列出 `missing_actual_data`）。
3. **废除 60 秒假工时与全链路真实事件联动**：
   - [`packages/core/inspection.ts`](../../../packages/core/inspection.ts)（废除 `recordTaskStep` 默认 `?? 60` 占位符，要求显式 `seconds` 或起止时间；空停报错 `409 NO_ACTIVE_TIMING`；`startTask` 自动开表、`submitTask` 自动闭合 `step_timings` 与 `labor_time_events`）。
   - [`packages/core/scheduling-dispatch.ts`](../../../packages/core/scheduling-dispatch.ts)（`pauseWorkItem`、`initiateTaskHandover`、`revokeStaffActiveLeases` 自动暂停有效人工并将等待原因记入 `wait_reason`；`resumeWorkItem` 恢复计时；`acceptTaskHandover` 结算原操作员真实工时并仅在任务处于 `IN_PROGRESS` 时为接手人开启新计时段）。
   - [`app/staff.tsx`](../../../app/staff.tsx)（改为真实服务端起停计时按钮，按 `operator_id === actor.id` 精准识别当前操作员未闭合步骤，清除 `seconds: 60` 假按键）。
4. **路由与可视化沙盘**：
   - [`packages/core/http.ts`](../../../packages/core/http.ts)（挂载 `/staff/labor/*`、`/staff/admin/cost-models/*` 与 `/staff/admin/orders/:id/cost-*`，含 Zod 查询/时区偏移校验与 MFA）。
   - [`app/admin-cost-margin.tsx`](../../../app/admin-cost-margin.tsx)、[`app/admin-pricing.tsx`](../../../app/admin-pricing.tsx)、[`app/admin-finance.tsx`](../../../app/admin-finance.tsx)（成本模型参数编辑器、SoD 审批流、`P = C/(1-f-m)` 毛利模拟器、全量 72 行 `1/3/10/30/50/100` 矩阵展示与数量筛选、`P50/P75/P90` 与 `§43.3` 暂估对照）。

## 2. 验证证据

- **迁移前隔离备份恢复演练**（基于 31 个迁移）：`ok=true`，`git_sha=16f2422877be4ee32414659f111c2cfe5df8fa3b`，`dump_bytes=824376`，`dump_sha256=8eb7c77cd23aab8ede9c6ac782c2982019598c689d9187d4ec3f1b147e1d6cb1`，`manifest_sha256=4c410e74231c9edf26129b39831e6397d469f773bb59c7f2f00ed4c11ee744d9`，`rpo_seconds=0`，`rto_ms=593`，`corrupt_backup_rejected=true`。
- **空库关系校验**：临时空库 `qcw_t198_empty` 顺跑 `001`–`032` 全部迁移及 [`docs/contracts/verify.sql`](../../contracts/verify.sql)，退出码 `0`。
- **Wave 25 专项测试** [`tests/pkg4-wave25-labor-cost-foundation.test.mts`](../../../tests/pkg4-wave25-labor-cost-foundation.test.mts)：`5/5` 通过（覆盖 `19` 条暂估基线幂等、管理费防双计、SoD 与不可变触发器、废除 60 秒假工时、起停/暂停/恢复/交接/撤销租约/交单全钩子、并行上传防重复计费、超时待校正与不可变修订记录、`P50/P75/P90` 与禁止自动改价、`P=C/(1-f-m)` 不可行/亏损警告与 72 行矩阵、订单 `labor_qa` 防重计及查询/边界 422 守卫）。
- **全库验证门禁（最终代码改动后重跑全绿）**：
  - `npm run check:i18n`：104 固定键、16 SEO 路由通过
  - `npx tsc --noEmit`：0 错误
  - `python3 docs/contracts/check.py`：264 任务（90 活跃）、67 门禁通过
  - `python3 tests/contract-check.test.py`：16/16 通过
  - `npm run test:integration`（`qcw_test`）：**216/216 通过**（0 失败，0 跳过）
  - `QCW_DEMO=0 next build`：Next.js 16.4.5 生产构建退出码 `0`

## 3. 独立只读 Reviewer 审计闭环

- 初审 Reviewer `3892f363-54a9-43f5-93bd-3efd3364901a`：`VERDICT: FAIL`（发现 4 P1、5 P2、3 Nits）→ 已全量整改闭环并补充第 5 组专项回归测试。
- 复审 Reviewer `10e9c8e4-6ac3-4ddb-ba5b-81ca4eea2062`：**`VERDICT: PASS`**（逐项核验全部 P1/P2/Nits 关闭，并实测 `tsc`、`check:i18n`、`check.py`、`pkg4-wave25` `5/5` 与 `pkg1-wave12` `1/1` 全数通过）。
