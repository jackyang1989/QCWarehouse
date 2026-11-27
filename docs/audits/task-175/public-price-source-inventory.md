# TASK-175｜公开端价格来源、算价公式与规则盘点 (`public-price-source-inventory`)

- **冻结基准 Commit**：`e386eaeb87c8737c586ee0f4d368887808434a07`
- **核查目的**：依据 `01-116` 第 95.1 节（`WEB-01`–`WEB-11`）及 `AGENTS.md` §3.2（“一个规则只有一个权威实现”），全面清查公开端展示的价格数字、计算逻辑、件数阈值、SLA 天数及故障降级文本的真实来源与冲突点。

---

## 一、公开端与服务端定价/规则来源对照表

| 项 | 公开端位置 (`file:line`) | 公开端当前做法 | 真实服务端权威源 (`file:line`) | 存在矛盾 / 违背规范点 (`WEB-*` / `01-116`) | 目标修复任务 |
|---|---|---|---|---|---|
| 1. 首页三大服务单价展示 & 异常处理 | [app/page.tsx](../../../app/page.tsx) L144–163 (`catalog().catch(() => [])`, `summarizeRate`) | 服务端渲染查 `catalog` 计算最低/区间价格；**异常时 `.catch(() => [])` 静默返回空列表** | [orders.ts](../../../packages/core/orders.ts) L139–143 (`catalog`) | **`WEB-09`**：把数据库/目录查询异常吞成空数组，无法区分服务不可用、未发布与暂停接单 | TASK-200, TASK-203 |
| 2. Pricing 页面浏览端报价引擎 | [app/public-site.tsx](../../../app/public-site.tsx) L1681–1734 (`PublicPricing`) | **在浏览器 JSX 内硬编码重复实现服务端规则**：<br>- `inspection`：`usd(unit * safeQty)`，且写死 `safeQty > 300` 为 Custom、`> activeOffer.rules.maximum` 为 Manual Quote；<br>- `compare`：固定按 `activeOffer.rules.minimum` 取整包价 `package_cents`；<br>- `reference_match`：写死 `safeQty > 20` 拦截并乘以 `pkg * safeQty` | [orders.ts](../../../packages/core/orders.ts) L144–152 (`eligible`), L158–161 (`saveOrder` 上限 20 行/300 件), L249–265 (`pricedLines`) | **`WEB-01, 02, 05, 06, 08`**：前后端两份实现易漂移；无模块化依赖/互斥/最低费计算；仍依赖旧 `unit_cents`/`package_cents` 与固定 `compare=[2,3]` | TASK-197, TASK-201 |
| 3. 公开选型输入维度 | [app/public-site.tsx](../../../app/public-site.tsx) L1888–1981 | 仅能选：`service`（三选一） + 单 `offerId` + 单一总 `qty`；不支持模块勾选、不同模块各自覆盖件数、多品类混合购物车 | [orders.ts](../../../packages/core/orders.ts) L158 (`lines: LineInput[]` 多行草案已存在后端，但官网未使用) | **`WEB-02, 03`**：官网强制单品单价思维，与新版三步模块化下单脱节 | TASK-201, TASK-204 |
| 4. 缺目录时的保底文案 | [app/public-site.tsx](../../../app/public-site.tsx) L1731–1734 | `else if (data)` 直接输出 `Quote on request` | `/catalog` 启停与发布状态 | **`WEB-09`**：以 `Quote on request` 掩盖未发布/未批准目录或错误状态 | TASK-200, TASK-201 |
| 5. SLA 预计工作日前提 | [app/public-site.tsx](../../../app/public-site.tsx) L1703, L1710, L1727 | 写死 `"after all ${safeQty} items are received & identified"`；展示固定 `business_days` | [orders.ts](../../../packages/core/orders.ts) L444–486 (`readyOrder` 同样等待整单全齐) | **`WEB-07` & `FINAL-06`**：未支持按批次/模块分批执行与新版工时计算前提，仍宣传全单到齐才能开检 | TASK-197, TASK-210, TASK-211 |
| 6. 官网到下单向导的上下文衔接 | [app/public-site.tsx](../../../app/public-site.tsx) L2015–2018 (`/orders/new?offer=...`) | CTA 链接仅携带 `offer_id`，**未携带客户刚估算的数量、服务组或未登录草稿** | [app/customer.tsx](../../../app/customer.tsx) L748–767 | **`WEB-04`**：`customer.tsx` L766 将 `qty` 初始化为 `matched.rules.minimum`，访客在 Pricing 选择的数量 `15`/`50` 等全部丢失 | TASK-201B, TASK-204 |
| 7. 公开数量按钮与比较组限制 | [app/public-site.tsx](../../../app/public-site.tsx) L1932 (`[1,5,15,30,50,100,150]`), L1968 (`[1,2,3,5]`), L1154 (`1–100+ items`) | 静态展示预设按钮及 `1–100+`、`2–3 items` 固定描述 | `sku_prices.rules` (`minimum`/`maximum`) + `orders.ts:149` (`[2,3]`) | **`WEB-05, 08`**：开放数量与超限规则未能随后台可配置服务能力自动调整 | TASK-197, TASK-200 |
| 8. 公开运费计算器缺失 | [app/public-site.tsx](../../../app/public-site.tsx) L2002–2004 | 仅写静态一行 `Outbound Shipping / Storage: Quoted later by actual parcel` | [dispatch.ts](../../../packages/core/dispatch.ts) L317–336 (`calculateShippingPreview` 仅 `/staff/admin/shipping-rates/calculate` 可用) | **`WEB-10`**：公开端与客户端完全缺失运费试算器；现有试算也缺失体积重/中国区划树/销售价投影 | TASK-181, TASK-200, TASK-222, TASK-223 |
| 9. 保管期与样例报告规则来源 | [app/public-site.tsx](../../../app/public-site.tsx) / [app/report-guide.tsx](../../../app/report-guide.tsx) L89–581 | 静态文字引用及单一样例预览图片（已标注 `Demonstration report`） | [inspection.ts](../../../packages/core/inspection.ts) L1638 (`storage.free_days`), `terms_versions` | **旧 30 天与新版 15 天规则冲突风险（`L06`）**；缺三种服务独立可读报告样例（`WEB-11`） | TASK-203, TASK-217, TASK-227 |

---

## 二、后续重构强约束（`PKG-4` & `PKG-5`）

1. **单一权威报价接口**：官网定价页（`TASK-201`）与客户端下单向导（`TASK-204`）及人工询价（`TASK-202B`）**必须调用同一个服务端模块化报价 API**，严禁保留前端乘法器代码（彻底移除 `public-site.tsx` L1688–1734 逻辑）。
2. **禁止演示价混淆**：沿用现有 `allowOfferRow()` (`orders.ts` L136–138) 对 `demo` 价格的隔离能力；商业价格未通过 `TASK-197B` 真实人工工时保本审核与批准前，严禁将草稿价当正式承诺售价上线。
