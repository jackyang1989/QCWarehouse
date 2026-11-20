# QCWarehouse｜Warehouse 仓库作业中心 + Customer 客户中心第三轮生产级全面审查与跨角色闭环验收报告

- **报告日期**：2026-11-20
- **工程基线**：`origin/main`（起始提交 `98b31ae`）
- **审查对象**：Warehouse 仓库作业中心（`/wh/*`）、Customer 客户中心（`/account`、`/orders/*`、`/parcels/*`、`/items`、`/reports`、`/actions`、`/support`、`/account/billing`、`/account/notifications`）、以及与 Admin 管理后台共享的领域模型、状态机、权限边界及读写接口。
- **验收结论**：三波代码重构、独立 7 维度只读复核、3 项 P1 问题闭环修复、全量静态与契约校验、隔离数据库 69 项集成测试及 138 次跨视口真实浏览器跨角色 E2E 均已通过（本地沙盒与演示环境 `QCW_DEMO=1`）。

---

## 一、本轮改动范围与架构收敛总览

本轮未将既有交接陈述作为验收依据，而是从数据库 Schema、领域服务、HTTP 路由契约、前端交互与权限守卫逐层核查并落地整改，总计修改 28 个核心源文件，保持 [core.openapi.yaml](contracts/core.openapi.yaml) 契约及既有自动化守卫完整性，无任何降级或绕过断言行为。

| 层级 | 修改文件 | 核心整改内容 |
|---|---|---|
| **领域与接口层（16 个）** | `packages/core/portal-routes.ts`、`packages/core/http.ts`、`packages/core/reads.ts`、`packages/core/orders.ts`、`packages/core/intake.ts`、`packages/core/inspection.ts`、`packages/core/operations.ts`、`packages/core/tickets.ts`、`packages/core/labels.ts`、`packages/core/media.ts`、`packages/core/storage.ts`、`packages/core/dispatch.ts`、`packages/core/logistics.ts`、`packages/core/report-shares.ts`、`packages/core/admin-reads.ts`、`packages/core/worker.ts` | 统一 6 类数量口径与跨端汇总；补齐客户包裹上下文 `/me/parcels/:id/context`、一键全部已读 `/me/notifications/read-all`、报告进度 `/me/reports?include_progress=1`、默认在库筛选 `/me/inventory?filter=in_warehouse`、工单多图上传 `supportPhotosForm`（1–4 张、单张 ≤ 8MB、总计 ≤ 25MB）；落实 `DSP-*` 样品编码校验、客户端包裹内部备注 `condition_note` 脱敏、全物流接口 `carrier_code` 小写规范化；保障扫码入口、标签打印、QA 复核权限隔离、参考样封存与批次发运闭环。 |
| **前端工作台与样式（12 个）** | `app/customer.tsx`、`app/staff.tsx`、`app/report-desk.tsx`、`app/storage-desk.tsx`、`app/admin-operations.tsx`、`app/portal.tsx`、`app/notifications.tsx`、`app/report-sharing.tsx`、`app/ticket-desk.tsx`、`app/chrome.tsx`、`app/ui.tsx`、`app/styles.css` | 升级客户 6 步下单向导与三层 `/account` 总览；完善订单列表快捷筛选、报告页目标/公差/实测偏差与重试记录（`Attempts`）、包裹开箱照片灯箱与异常提示、账单与待处理退款/拒退信息、带主题预填与多图上传的支持工单；重构仓库扫码工作台、收货拆包归属核验、质检员公差实时判断与角色隔离草稿、QA 独立复核台与库位发运台；修复 `/orders/:no/report` 导航归属 `Reports`、`.workspace-sidebar` `z-index: 25` 及多断点横向布局溢出问题。 |

---

## 二、业务模型闭环与跨端一致性整改

### 2.1 六类数量口径统一（Customer / Warehouse / Admin）

1. 在 `packages/core/orders.ts` 中调整 `saveOrder`，当上游仅传入 `attributes.expected_lines` 而未展开 `line.items` 时自动同步写入 `draft_items`，保留 `expected_line_id`、`sku_code`、`name`、`color_declared`、`size_label`、`supplier_alias` 与 `declared_tracking_no`。
2. 在 `summarizeExpectedLines` 中补充 Pass-2 未指定明细行的确定性回落归集（基于 `order_line_item_links`），保证“委托件数 / 预报包裹 / 实收件数 / 已核身件数 / 待核身件数 / 确认短少”在订单详情、包裹对账表、仓库核身队列与 Admin 订单详情中完全同源。
3. **跨三端实测对账（Scenario B）**：订单 `QW-CDBD7E3B3ED4` / 包裹 `P-7F224ACDB1B7` 在客户中心、仓库工作台与 Admin 管理后台均一致展示 **预计 50 件、仓库实收并核身 48 件、确认短少 2 件**。

### 2.2 Warehouse 仓库作业中心（`/wh/*`）

- **总览与扫码入口（`/wh`、`/wh/scan`）**：强化扫码解析（运单号、包裹码 `P-*`、样品码 `S-*` / `DSP-*`、订单号、库位码）及未入库/无主件引导反馈。
- **收货入库与归属核验（`/wh/intake`）**：记录外箱完好/破损状态（`intact` / `crushed` / `torn` / `wet`）、开箱留证照片与数量核对；规范化承运商编码后入库。
- **质检作业工作台（`/wh/task/:id`）**：展示客户原始备注、目标值及公差上下限，输入测量值实时提示 `公差内` / 偏离状态；前端草稿缓存使用含操作员维度的 `qcw_task_draft_*` 键并在员工退出登录时自动清除；严格阻止 `receiver` 越权启动质检（HTTP `403`）。
- **QA 独立复核与报告发布（`/wh/review/:id`）**：阻止原质检员自审通过自身任务（HTTP `403`），独立 `reviewer` 审核批准（HTTP `202`）后由 Worker 异步渲染并发布报告版本。
- **仓储库位与发运交接（`/wh/storage`、`/wh/dispatch`）**：支撑参考样封存回退、处置指令入批、报价、支付确认、打包称重及交接出库状态闭环。

### 2.3 Customer 客户中心自助服务系统

- **6 步质检下单向导**：Step 2 类目切换显式提示公差重置；Step 3B 升级双层 `.sku-line-card` 结构并保留原有输入语义与校验定位；Step 4 `Sent to Warehouse Inspector` 展示标准检验清单与公差设定；Step 5 使用确定性条款元素 `step5-consent-*`，缺失同意项时精准定位并高亮提示；衔接 Demo Checkout 幂等支付激活订单。
- **总览、订单与报告**：`/account` 采用三层结构化信息架构；`/orders` 增加快捷筛选预设及 `samples_ready` 阶段识别；`/orders/:no` 根据订单阶段收敛可用操作（草稿阶段保留 `Cancel inspection`）；`/orders/:no/report` 清晰呈现目标值、公差、实测偏差及测量重试记录（如 `Attempts (#1: 68.4 cm, #2: 68.6 cm)`），侧栏高亮正确归属 `Reports`。
- **包裹、在库样品、账单与支持工单**：
  - `/parcels` 与 `/parcels/:id` 对接 `/me/parcels/:id/context`，展示 `Crushed` / `Torn` / `Wet` 外箱告警与 `#open-box-photos` 开箱图片灯箱，隔离内部备注与外箱 `intake_outer` 内部取证图（客户端直接访问内部图返回 `404`）。
  - `/items` 默认激活 `in_warehouse` 筛选并展示保管摘要与在仓/已出库统计。
  - `/account/billing` 补充 `pending_refund_cents`、退款原因、退款渠道与拒退红标提示。
  - `/support` 支持 `?subject=` 自动预填及 1–4 张图片多图上传创建/回复工单。

---

## 三、独立 7 维度复核与 P1 缺陷闭环

独立只读审计（覆盖契约与类型、状态机、跨角色权限与隐私边界、仓库作业流、客户自助流、前后端布局、异常与边界条件 7 个维度）确认 **0 个 P0 阻塞问题**，并提出 **3 项 P1 修复建议**，本轮已全部定位、修复并实测闭环：

| 编号 | 问题描述 | 根因修改位置 | 修复后实测验证结果 |
|---|---|---|---|
| **P1-1** | `DSP-*` 拆包/退回衍生样品编码未纳入 `/wh/samples/:code` 与 `/me/inventory?code=` 参数正则校验 | `packages/core/portal-routes.ts`（`/^\/wh\/samples\/((?:S|DSP)-[A-Za-z0-9-]{1,64})$/`）；`packages/core/http.ts`（`/me/inventory` `code` 正则 `/^(?:S|DSP)-[a-zA-Z0-9-]{1,64}$/`） | `resolvePortalRoute("/wh/samples/DSP-0001")` 解析为 `{ area: "warehouse", view: "warehouse-item", id: "DSP-0001" }`；登录 `GET /wh/samples/DSP-0001` 返回 HTTP `200`（无 404）；`customerInventory(..., "DSP-0001")` 穿过校验正确返回业务 `NOT_FOUND (404)` 而非正则拒绝。 |
| **P1-2** | 客户侧 `GET /me/parcels` 与 `GET /me/orders/:id` 查询仍投影了包裹原始 `p.condition_note`，存在暴露仓库内部处理备注风险 | `packages/core/reads.ts`（`customerAdviceFields`）；`packages/core/orders.ts`（`ParcelReconciliationRow`、`summarizeExpectedLines`、`orderDetail` `parcels` 投影）；`app/customer.tsx`（`/parcels` 列表改读 `a.outer_condition`） | `listCustomerParcels` 与 `orderDetail` 返回对象中均已完全移除 `condition_note` 字段，结构化 `outer_condition`（如 `"crushed"`）正常保留；员工及管理端内部备注权限保持不变。 |
| **P1-3** | 部分物流与入库认领入口未对 `carrier_code` 执行去空格小写规范化，传入大写编码（如 `"SF"`）会误判失败 | `packages/core/intake.ts`（`lookup`、`requestIntakeClaim`）；`packages/core/logistics.ts`（`verifyTracking`、`correctCustomerParcelTracking`、`correctStaffTracking`） | `POST /api/v1/staff/intake/lookup` 携带大写 `carrier_code: "SF"` 对实单运单检索返回 HTTP `200` 且 `match_state: "matched"`；所有修改均使用 `validCarrier` 规范化返回值。 |

---

## 四、全链路实测与构建证据清单

### 4.1 Playwright 真实跨角色端到端验证（`http://localhost:3000`）

- **Scenario A（客户下单 → 收货开箱 → 质检 → QA 复核 → 报告发布 → 出库闭环与越权拦截）**：
  - 客户 `customer.r3.mwoj4jtv@qcw.test`（收件码 `QCW-7D89593B3DC6`）创建并支付激活订单 `QW-74AE758614DF`（设置 `68 ± 1.5 cm` 公差，触发 `#step5-consent-restricted_items` 缺失高亮提醒并完成 Demo Checkout）；
  - 仓库入库包裹 `P-046012BC0C2D`（外箱 `crushed`、开箱图、`S-7XT6D4` 与 `S-ZRBR85`）；
  - 权限与隔离校验：`receiver` 启动质检返回 `403`；`inspector` 自审通过返回 `403`；`reviewer` 批准（`202`）并由 Worker 发布报告版本 `d82c31f8-2b0d-467d-8e8b-a5add8c79e09`；
  - 客户侧核验报告公差及 `Attempts (#1: 68.4 cm, #2: 68.6 cm)`、包裹 `Crushed` 告警与开箱照（`200`）、内部 `intake_outer`（`404`）与跨租户访问（`404`）；
  - 完成出库批次 `e08c9415-f08e-4df8-af96-8ea3e891b33c` 报价、支付、打包与交接（`S-7XT6D4`），客户 `/items` 核验 `in_warehouse=1`、`shipped_or_closed=1`。
- **Scenario B（三端数量口径一致）**：`QW-CDBD7E3B3ED4` / `P-7F224ACDB1B7` 预计 50 件 vs 实收核身 48 件 vs 短少 2 件，Customer / Warehouse / Admin 完全一致。
- **Scenario C（多图工单与草稿隔离）**：客户工单 `C-950CBC75B028` 实测上传并保存 2 张附件图；员工登出后 `qcw_task_draft_*` 清除验证通过。
- **Scenario D（视口兼容、无报错及视觉核验）**：23 条页面路由 × 6 种视口（`1920×1080`、`1440×900`、`1280×800`、`1024×768`、`768×1024`、`390×844`）共 **138 次检查**，全部 **0px 横向溢出**、**0 条未捕获页面/控制台报错**，代表性关键页面截图均经逐张审阅。

### 4.2 P1 修复后的代码、契约与集成测试结果

| 检查项 | 执行范围 / 环境 | 最新结果 |
|---|---|---|
| TypeScript 静态类型检查 | `npm run check`（`tsc --noEmit`） | 通过（0 错误） |
| 文档与契约一致性校验 | `python3 docs/contracts/check.py` | 通过（`174 tasks, E1–E236, 69 pages, 111 implementation cases, 46 product gates, 49 transaction operations`） |
| Diff 空白与格式检查 | `git diff --check` | 通过（0 告警） |
| 集成测试全集 | 全新隔离迁移库 `qcw_test-r3-p1`（`001`–`009`，测试后已删除）：`tests/admin-workbench.test.mts` + `tests/workflow.test.mts` | **69 / 69 通过**（0 失败，0 跳过，耗时 `31.19s`） |
| 生产构建校验 | `npm run build`（`next build`） | 通过（Next.js 16.4.5 Turbopack 编译与类型校验 0 错误） |

---

## 五、外部集成与生产准入边界说明

本轮所有端到端与集成验证均运行于受控隔离沙盒/演示配置（`QCW_DEMO=1`）：
- **支付通道**：使用 Stripe Test / Demo Checkout 会话及本地模拟回跳路径完成报价与收费链路验证，生产放行需配置正式 Stripe Live API 密钥与在线 Webhook 端点。
- **物流追踪**：使用 `Express100`（快递100）本地测试夹具及模拟订阅事件，生产启用须完成真实商户号配置、回调域名验签及退回/集运正式运价表核准。
- **邮件与身份认证**：`@qcw.test` 域名 OTP 走本地演示输出通道，OIDC 使用本地测试配置；上线前仍须完成真实 Postmark 发信域名校验、企业级 Google/Microsoft OAuth 凭据配置、法务条款/隐私政策终审，以及按 PRD §17 与实施规格 §23 完成实仓扫码与出库试运行签收。
