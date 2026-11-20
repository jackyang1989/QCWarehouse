# QCWarehouse｜第四轮 Warehouse + Customer 生产级业务体验、页面布局与跨角色闭环验收报告

**日期：** 2026-11-20  
**基准提交：** `d04bf52`（第四轮变更待提交并推送）  
**整改范围：** Warehouse 仓库作业中心（`app/staff.tsx`、`app/storage-desk.tsx`、`app/report-desk.tsx`、`app/ui.tsx`）、Customer 客户工作台（`app/customer.tsx`、`app/notifications.tsx`、`app/report-sharing.tsx`、`app/ticket-desk.tsx`、`app/scope-review.tsx`）、Admin 管理后台协同对齐（`app/admin-orders.tsx`、`app/admin-operations.tsx`、`app/portal.tsx`）、样式系统（`app/styles.css`）及核心服务/权限与对账口径（`packages/core/{http,intake,orders,inspection,operations,storage,reads,labels,media,admin-reads,report-shares,tickets}.ts`）

---

## 一、核心整改成果总览

本轮围绕**作业流连续性、信息密度与布局降噪、三端实收/核身/短缺对账口径一致、岗位最小权限与越权收口**四个维度完成端到端生产级重构：

1. **三端数量对账口径统一（消除未核身误报“确认实少”）**
   - 在 [packages/core/orders.ts](../packages/core/orders.ts) 的 `summarizeExpectedLines` 中区分 `logged_units_total`（物理已清点贴码）、`identified_units_total`（已核身绑 SKU）、`unidentified_units_total`（已实收待核身）、`unarrived_units_total`（预报在途未到）、`unverified_short_units_total`（存在待核身/在途前提下的未核实差额）与 `confirmed_short_units_total`（全部预报包裹已实收且无待核身件后的确认实少），并在行级 `ExpectedLineBreakdown` 同步输出 `unidentified_pending_qty`、`missing_qty`、`unverified_short_qty` 与 `confirmed_short_qty`。
   - 同步更新客户订单页 `OrderView`（[app/customer.tsx](../app/customer.tsx)）、仓库入库台 `WarehouseDesk`（[app/staff.tsx](../app/staff.tsx)）、包裹详情 `WarehousePackageView`（[app/staff.tsx](../app/staff.tsx)）与管理后台 `AdminOrdersWorkbench` / `AdminOrderDetailWorkbench`（[app/admin-orders.tsx](../app/admin-orders.tsx) + [packages/core/reads.ts](../packages/core/reads.ts) `searchStaffOrders` 严格过滤 `pkg.received_at is not null and pkg.state <> 'quarantined'`），杜绝“已清点 47 件待扫码核身却显示 50 确认短少”或尚未签收即误标“确认实少”。

2. **Warehouse 仓库作业中心效率与岗位安全重构**
   - **质检工作台 `/wh/task/:id` (`TaskView`)**：重构为“顶部任务上下文栏（语义化 `<h1>` + SLA + 公差模式 + 并发锁/只读横幅）→ 紧凑客户申报/参考附图/公差依据区（消除半屏空白，无公差时明确标注客观记录模式）→ 集中检测录入、必拍机位进度、草稿保护与缺失定位区”。
   - **扫码工作台 `/wh/scan` (`WarehouseScan`) & 连续作业**：扫码回车定位直接展示内联工作台摘要与岗位可执行动作；对 `QW-` / `QCW-` 扫码按角色裁剪跳转路径，非客管岗位隐藏客户昵称降低 PII 暴露（[packages/core/labels.ts](../packages/core/labels.ts)）；标签回读校验 `verifySingleReadback` 补齐 `DSP-` 前缀支持。
   - **收货入库与包裹详情 (`/wh/intake`, `/wh/packages/*`)**：新增 `POST /staff/packages/:id/open-photos`（[packages/core/http.ts](../packages/core/http.ts)、[packages/core/intake.ts](../packages/core/intake.ts)）支持补充开箱照片留证且提交后重置文件选择框；展示按 `order_line` 分组 SKU 汇总表；移除批次条码校验框预填值，防止假扫；接入承运商已签收未实收队列快速填入条与 `?tracking=` 自动检索；保留 `P-`/`S-`/`DSP-` 分页与筛选。
   - **实物建档、移位与盘点 (`/wh/samples/*`, `/wh/storage`, `/wh/stocktakes`)**：禁止移走已装箱待发运实物或将生效中确认样移出 `reference` 区（[packages/core/operations.ts](../packages/core/operations.ts)）；`StorageMove` 补齐实物/库位/操作员/动作/天数多维筛选；`approveStocktake` 确认盘亏时写入 `storage_events(action='stocktake_adjustment')` 并为归属件开立 `damage_or_loss` 工单与异常单（[packages/core/storage.ts](../packages/core/storage.ts)），同时 `itemHandlingHoldSql` 通过关联 `stocktake_items` + `inventory_adjustments` 确保无主实物的确认盘亏仍保持 `stocktake` 冻结。

3. **Customer 客户工作台体验与自服务闭环重构**
   - **订单详情 `/orders/:no` (`OrderView`)**：改为 6 层结构（`1. 进度与时间线` → `2. 到货核身状态与异常决策` → `3. SKU/颜色/尺码对账汇总（置于包裹前）` → `4. 包裹到仓清点汇总` → `5. 质检任务摘要` → `6. 逐件实物明细（>5 件默认折叠，支持搜索、筛选与 15 件/页分页）`）；无范围变更与样品差异时折叠 `ScopeReview`（[app/scope-review.tsx](../app/scope-review.tsx)）。
   - **创建订单向导 `/orders/new` (`NewOrder`)**：Step 1 显示 `reference_match` 单价说明与报价过期提示；Step 2 增加 `#step2-qty-mismatch-banner` 一键同步数量；Step 3（`>= 4` 行启用 `.wizard-dense-table`，常驻批量工具栏与行复选，移除原始 `"OPEN"` OCR 术语）；Step 4 修复布尔型 `evidence` 空括号并区分可选实测；Step 5 展示 `X / 6`（1 份平台条款 + 5 项服务告知）进度并在配置指纹未变重报价时保留已勾选状态；Step 6 与 `/account/billing` 明确标注沙盒演示模式；右侧 Order Summary 修复 `.summary-list-compact > li` 布局间距。
   - **列表、抽屉与通知/工单/分享对齐**：`/parcels` 默认展示 `"all"` 全部 tab 与实时分 tab 计数；嵌入式轨迹抽屉 `CustomerTrackingDrawer` 仅展示最近 5 条节点、已实收件数与 `Open full parcel & logged items (47) ->` 完整页入口；`CustomerBatchDrawer` 升级 `wide` 抽屉并支持 10 件/页分页；`/actions` 正向紧急度与非负差额文案；`/support` 支持 URL 查询参数预填；[app/notifications.tsx](../app/notifications.tsx)、[app/report-sharing.tsx](../app/report-sharing.tsx)、[app/ticket-desk.tsx](../app/ticket-desk.tsx) 均补齐链接、阶段标签与可读状态映射。

---

## 二、真实业务对象 `QW-15D9CCAB2E07` 三端实测对账一致性矩阵

基于本地演示库 `qcw_test-workspace-final` 中真实存在的多 SKU 样本单 `QW-15D9CCAB2E07` 实测核验（客户端、仓库端、管理后台共享同一事实来源）：

| 口径维度 | 实测真实值 | Customer `/orders/QW-15D9CCAB2E07` | Warehouse `/wh` & 包裹/对账汇总 | Admin `/admin/orders/QW-15D9CCAB2E07` |
|---|---:|---|---|---|
| 客户委托总数 / SKU 组 | **50 件 / 6 组** | `Expected 50 (6 SKU groups)` | 委托 `50` 件 | `50 件 (6 组 SKU)` |
| 仓库物理清点实收件 | **47 件** (`P-1D3BD9D2FC86`) | `Physically Logged 47 (1 parcel checked in)` | `累计实收 47 件` | `实收 47` |
| 已完成 SKU 核身绑码 | **0 件** | `SKU-Identified 0` · `9/8 pending SKU scan` | `待核身绑定 / pending SKU scan` | `核身 0 · 待 SKU 核身 47 件` |
| 在单未绑待核身件 | **47 件** | `Pending SKU Scan 47` | 待核身 47 件 | `待 SKU 核身 47 件` |
| 未核实包裹差额 | **3 件** | `Unverified Delta 3 (Parcel vs declared delta)` | 未核实短缺/在途差 3 | `包差/在途 3 件` |
| 已确认实少件数 | **0 件** | `confirmed_short_units_total = 0`（不显示 50 确认短少） | 已确认缺少 `0` | 列表与详情均不误报 `确认实少` |
| 对账状态 (`reconciliation_status`) | `discrepancy_under_review` | 展示 3 种客户处理决策按钮（按 47 件继续 / 等待到齐 / 开工单） | 等待核身与客户决策 | 下一步责任指向 `receiver` 完成核身 |

---

## 三、岗位权限矩阵（RBAC 与审计收口）

| 能力 / 路由 | `customer` | `inspector` | `receiver` | `reviewer` | `support` | `finance` | `warehouse_admin` | `super_admin` |
|---|---|---|---|---|---|---|---|---|
| `/wh` 仓库总览主 CTA | 403 / 重定向 | 仅质检队列 | 收货入库 + 扫码 | 报告复核 | 只读查看 | 只读/受限 | 仓库作业全集 | 仅只读监督 CTA（隐藏入库/复核按钮） |
| `POST /staff/packages/:id/open-photos` | 403 | **403**（实测确认） | 允许 | 403 | 403 | 403 | 允许 | 允许 |
| `POST /staff/media` (`label_photo`) & `bind-owner` | 403 | 仅上传凭证 | 允许 | 403 | **允许上传**（本轮已补齐） | 403 | 允许 | 允许 |
| `/wh/task/:id` 实测录入 | 403 | 仅本人领取锁定可写；他人在检只读 | 只读监督 | 只读监督 | 只读监督 | 403 | 只读监督 | 只读监督 |
| `/admin/disposals/:id` SoD 审批 (`can_approve_sod`) | 403 | 403 | 403 | **允许且非发起人** | **仅查看（UI 已隐藏）** | 403 | 允许且非发起人 | 允许且非发起人 |
| `readStaffObjectSummary` 批次报价金额 | 仅 `/me` | 403 | 403 | 403 | **已脱敏 (`financial_restricted`)** | 完整金额 | **已脱敏 (`financial_restricted`)** | 完整金额 |
| 订单工作台 `/wh/packages`·`/wh/samples`·`/wh/dispatch` 入口 | 403 | 403 | 收货/建档入口 | 403 | 改用安全对象抽屉 | 403 | 全入口 | 全入口 |

---

## 四、独立只读审计发现与闭环整改

由独立只读 `research` 子代理对全部 `packages/core/*`、`app/*` 及契约文件进行深度核查：
- **P0 阻塞问题：0 项**（SQL 参数化、Schema 对齐、`attachPackageOpenPhotos` / `moveItem` / `report-shares` 租户与版本锁、链接/媒体安全与错误兜底均验证通过）。
- **P1 高优先级问题：5 项（已全部修复并通过回归验证）**
  1. `support` 在 `bindUnmatchedPackageOwner` 被授权但被 `savePhoto` / `createUploadUrl` / `readMedia` 拦住 `label_photo` → 已在 [packages/core/intake.ts](../packages/core/intake.ts)、[packages/core/media.ts](../packages/core/media.ts)、[packages/core/reads.ts](../packages/core/reads.ts) 为 `support` 开放 `label_photo` 上传及无主待认领包裹（`org_id is null`）核验证照读取。
  2. 3 端行级对账字段 `confirmed_short_qty` / `unverified_short_qty` 未从 `summarizeExpectedLines` 输出且 `searchStaffOrders` 未排除未实收/隔离包裹 → 已在 [packages/core/orders.ts](../packages/core/orders.ts)、[packages/core/reads.ts](../packages/core/reads.ts)、[app/customer.tsx](../app/customer.tsx)、[app/staff.tsx](../app/staff.tsx)、[app/admin-orders.tsx](../app/admin-orders.tsx) 全面对齐并消除过早“确认实少”。
  3. 无主物品（`org_id is null`）确认盘亏审批后缺乏未结案 `incident_cases` 导致 `stocktake` 冻结解除 → 已在 [packages/core/storage.ts](../packages/core/storage.ts) 的 `itemHandlingHoldSql` 增加 `stocktake_items` + `inventory_adjustments`（`actual_location is null and approved_by is not null and si.state='adjusted'`）持久冻结条件。
  4. 报废双人审批 `can_approve_sod` UI/后端角色不一致、订单工作台向 `support` 渲染 `/wh/*` 403 链接、`scanWarehouseCode` 向 `inspector`/`reviewer` 返回 `/wh/packages` 及 `readStaffObjectSummary` 向非财务岗位暴露批次报价金额 → 已在 [packages/core/admin-reads.ts](../packages/core/admin-reads.ts)、[packages/core/reads.ts](../packages/core/reads.ts)、[packages/core/labels.ts](../packages/core/labels.ts)、[app/ui.tsx](../app/ui.tsx)、[app/portal.tsx](../app/portal.tsx)、[app/admin-orders.tsx](../app/admin-orders.tsx)、[app/admin-operations.tsx](../app/admin-operations.tsx) 全部收口。
  5. `StaffTicket`（[app/ticket-desk.tsx](../app/ticket-desk.tsx)）渲染后端未返回的 `c.email` 与无判空 `data.account_recovery.evidence_summary` → 已改为安全可选条件渲染。
- **P2 体验与合规打磨：3 项（已全部修复）**
  1. `verifySingleReadback`（[packages/core/labels.ts](../packages/core/labels.ts)）支持 `DSP-` 实物编码回读。
  2. `WarehouseDesk` 开箱照上传表单（[app/staff.tsx](../app/staff.tsx)）补充动态 `key`，提交后自动清空文件选择控件。
  3. `QCW-` 仓库扫码摘要仅对有客户管理权限角色附带 `display_name`，最小化仓库前端 PII 暴露（[packages/core/labels.ts](../packages/core/labels.ts)）。

---

## 五、全量自动化验证与构建证据（均在最终代码定稿后实测通过）

| 检查项 | 执行命令 / 范围 | 实测结果 |
|---|---|---|
| TypeScript 类型检查 | `npm run check` (`tsc --noEmit`) | **Exit 0**（0 错误） |
| 数据库迁移（全新临时库） | `qcw_test-r4` 执行 `001`–`009` 全量 SQL 迁移 | **Exit 0**（9 个迁移全部成功） |
| 后端与管理后台全量集成测试 | `tests/admin-workbench.test.mts` + `tests/workflow.test.mts` | **69 / 69 PASS，0 FAIL，0 SKIP**（`duration_ms 31274.426167`） |
| 第四轮专项 API / 守卫检查 | 临时库 `qcw_test-r4` + 实时库 `qcw_test-workspace-final` | `PASS 1`（开箱照）、`PASS 2b`（确认样禁出 `reference` 区）、`PASS 3`（盘亏调账+工单+异常单）、`PASS 4`（`QW-15D9CCAB2E07` 三方对账）；注：`PASS 2a` 因 `qcw_test-r4` 当时无 `packed` 发运记录条件跳过（`moveItem` 守卫经代码审计验证） |
| P1/P2 修复专项脚本检查 | `savePhoto("label_photo")` (`support`)、批次金额脱敏、`QCW-` 扫码裁剪、`DSP-` 回读 | **`PASS P1+P2 TARGETED CHECKS { up: true, batchMasked: true, dspChecked: true }`** |
| 生产构建与生产模式守卫 | `npm run build` (`Next.js 16.4.5 (Turbopack)`) + `next start` | **Exit 0**（`Compiled successfully in 2.4s`，6 个路由）；`next start` 下 `/api/v1/auth/demo/switch` 实测返回 `403 DEMO_UNAVAILABLE` |
| 契约与格式校验 | `python3 docs/contracts/check.py` + `git diff --check` | **Exit 0**（`174 tasks, E1–E236, 69 pages, 111 implementation cases, 46 product gates, 49 transaction operations`） |
| Playwright 跨角色全流程浏览器回归 | 场景 A–G（`/wh`、`/wh/task/:id`、`/wh/scan`、`/wh/storage`、`/wh/intake`、`/wh/samples/*`、`/orders/QW-15D9CCAB2E07` vs `/admin/orders/QW-15D9CCAB2E07`、`/orders/new` 1–6 步含密集表与 6/6 确认、`/parcels` + 抽屉、`/actions`、`/items`、`/account/billing`、`/support`、`/reports`、`/account/notifications` + 6 种视口 `1920/1440/1280/1024/768/390px` + RBAC 403） | **Exit 0**（`ALL ROUND 4 E2E BROWSER SCENARIOS PASSED!`，0 未预期控制台报错、0 页面异常、0 个 5xx、全视口 0 横向溢出，完成 18 张截图人工逐张目视确认） |

---

## 六、关键截图清单与目视确认要点

全部 18 张实时截图（桌面端 `1440px` 与移动端 `390px`）已生成于当前会话 `browser_evidence/round4_verify/` 目录并完成逐张目视审查：

- `01-wh-overview-admin-1440.png`：`/wh` 管理岗总览 5×2 领域 KPI 卡片与岗位裁剪 CTA（仅监督视图，无收货/独立复核写按钮）。
- `02-wh-task-workbench-1440.png` & `03-wh-task-mobile-390.png`：`/wh/task/:id` 语义化 `<h1>` 顶栏、紧凑申报+客户特别备注+公差表、并发锁只读提示及 390px 零溢出适配。
- `04-wh-scan-workbench.png` & `05-wh-storage.png`：`/wh/scan` 内联包裹工作台直达与 `/wh/storage` 纵向筛选栏+连续上架目标库位锁。
- `06-wh-intake-grouped.png` & `07-wh-sample-detail.png`：`/wh/intake` 签收未实收快捷填入条、未预填校验框与 `/wh/samples/:code`（中文质检状态与工单标签 `待处理`）。
- `08-customer-order-6layers-15D9.png`、`09-customer-order-mobile-390.png` & `10-admin-order-15D9.png`：`QW-15D9CCAB2E07` 客户/管理后台三端一致（50 委托 / 47 实收 / 0 核身 / 47 待核身 / 3 未核实差额），Layer 6 默认折叠。
- `11-wizard-step3-dense.png`、`12-wizard-step4-scope.png` & `13-wizard-step5-terms.png`：`/orders/new` Step 3 密集表（6 SKU 列宽完整可读+批量栏常驻）、Step 4 检查表（无空括号+`.summary-list-compact` 右栏对齐）、Step 5 官方报价+30 分钟倒计时+`0 / 6` 条款进度。
- `14-customer-parcels-all.png`、`15-customer-drawer-preview.png`、`16-customer-actions.png`、`17-customer-items.png` & `18-customer-billing.png`：`/parcels` 默认 `All (2)`、嵌入式抽屉摘要与 `Open full parcel & logged items (47) ->`、`/actions` 正向差额文案、`/items` 待核身准确口径、`/account/billing` 沙盒横幅与无反引号 `FREE-AUTH` 标签。

---

## 七、本地沙盒环境边界与声明（`QCW_DEMO=1`）

本轮所有端到端与浏览器验收均运行在隔离本地演示环境（`qcw_test-workspace-final` / `qcw_test-r4` + `QCW_DEMO=1`）：
1. **外部第三方通道仍为本地隔离态**：Stripe 真实扣款/Webhook 结算、快递 100 实时物流抓取、Postmark 真实邮件外发、以及线下物理扫码枪与相机硬件采集尚未连接生产账号与真实出库。
2. **生产发布切换前置门禁不变**：上线前仍须在正式环境变量中关闭 `QCW_DEMO`、配置独立 Stripe / Kuaidi100 / Postmark 生产凭证及法务条款发布确认（`next start` 下已实测自动拒绝 `demo/switch`）。
3. **本机磁盘空间提示**：执行过程中观测到宿主机 `/System/Volumes/Data` 可用空间处于较低水位（清理 `.next` 后约 `739 MiB`）；后续长期开发运行建议适度保留磁盘余量以免构建或无头浏览器再次触发 `ENOSPC`。
