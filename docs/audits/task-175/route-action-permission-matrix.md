# TASK-175｜全系统路由、写操作与权限矩阵 (`route-action-permission-matrix`)

- **冻结基准 Commit**：`e386eaeb87c8737c586ee0f4d368887808434a07`
- **核查文件**：[packages/core/http.ts](../../../packages/core/http.ts)（1637 行）、[docs/contracts/core.openapi.yaml](../../../docs/contracts/core.openapi.yaml)（51 项核心写/读操作）、[packages/core/portal-routes.ts](../../../packages/core/portal-routes.ts)（234 行）、[packages/core/staff-access.ts](../../../packages/core/staff-access.ts)（17 行）、[app/staff.tsx](../../../app/staff.tsx)（3603 行）。

---

## 一、核心权限定义源与 `LIF-004` 权限漂移核实

### 1.1 `staff-access.ts`（L1–17）硬编码角色组
| 集合名 | 允许角色（`staff_roles` CHECK 固定 8 角色之一） |
|---|---|
| `administration` | `super_admin`, `support`, `finance`, `template_admin` |
| `orders` | `super_admin`, `support` |
| `finance` | `super_admin`, `finance` |
| `templates` | `super_admin`, `template_admin` |
| `intake` | `receiver`, `warehouse_admin`, `super_admin` |
| `locations` | `super_admin` |
| `inspection` | `inspector`, `reviewer`, `super_admin` |
| `reportEditing` | `reviewer`, `warehouse_admin`, `super_admin` |
| `dispatch` | `warehouse_admin`, `super_admin` |
| `tracking` | `warehouse_admin`, `receiver`, `support`, `super_admin` |
| `trackingConfiguration` | `super_admin` |

### 1.2 `portal-routes.ts` 菜单隐藏 vs 直链放行漂移（`LIF-004` 实证）
在 [portal-routes.ts](../../../packages/core/portal-routes.ts) 中，`adminTabs`（决定侧栏展示，L28–55）与 `canOpenStaffPage`（决定页面访问准入，L62–80）多处不一致：

| 页面路径 | `adminTabs` 侧栏可见角色（L29–54） | `canOpenStaffPage` 直链放行角色（L68–79） | 实证缺陷与风险 |
|---|---|---|---|
| `/admin/users` | `["super_admin"]` | `staffAccess.templates` (`["super_admin","template_admin"]`, L74) | **高危越权入口**：`template_admin` 虽看不到菜单但可直链打开 `/admin/users` 页面（服务端修改角色 API 另有 `role(actor,"super_admin")` 兜底） |
| `/admin/catalog`, `/admin/templates`, `/admin/shipping-rates`, `/admin/config`, `/admin/legal` | `["super_admin"]` | `staffAccess.templates` (`["super_admin","template_admin"]`, L74) | 页面策略与侧栏菜单冲突（`/admin/shipping-rates`、`config`、`legal` 允许 `template_admin` 直链打开） |
| `/admin/categories` | *(未出现在 `adminTabs` 菜单中)* | `staffAccess.templates` (`["super_admin","template_admin"]`, L74) | 路由未挂入侧栏但保留直链放行 |
| `/admin/dispositions`, `/admin/incidents` | `["super_admin"]` | `staffAccess.orders` (`["super_admin","support"]`, L75) | `support` 侧栏不可见但直链可达 |
| `/admin/refunds`, `/admin/payments` | `["super_admin"]` | `staffAccess.finance` (`["super_admin","finance"]`, L76) | `finance` 侧栏不可见但直链可达 |
| `/admin/integrations`, `/admin/integrations/payments` | `["super_admin"]` | `["super_admin","finance"]` (L77) | `finance` 侧栏不可见但直链可达 |
| `/admin/integrations/ocr` | `["super_admin"]` | `["super_admin","finance","warehouse_admin"]` (L78) | `finance`/`warehouse_admin` 侧栏不可见 |

此外，全系统无统一自定义角色/权限表（`001_initial.sql` L50–54 写死 8 枚举）、无仓库与任务范围隔离、无字段级裁剪与按权移动端（`TASK-180` / `TASK-180A` 接手整改）。

---

## 二、`core.openapi.yaml` 51 项核心契约操作（`http.ts` L1508–1620 统一 Ajv 校验 + `x-roles` 守卫）

| 领域 | `operationId` | Method & Path | `x-roles` | 领域处理器 (`http.ts` dispatch) | 备注 / 现状问题 |
|---|---|---|---|---|---|
| 注册 | `completeRegistration` | `POST /auth/registration/complete` | `onboarding` | `auth.completeRegistration` (L1598) | 校验 2 份条款同意，生成唯一收件码 |
| 客户下单 | `createDraft` | `POST /orders` | `customer` | `orders.saveOrder` | 上限 20 行/300 件；缺目录直接三步无 SKU 路径 |
| 客户下单 | `editDraft` | `PATCH /orders/{id}` | `customer` | `orders.saveOrder` | 同上 |
| 客户下单 | `orderPayment` | `GET /orders/{id}/payment` | `customer` | `payments.orderPayment` | 返回报价/应付状态 |
| 客户下单 | `quoteOrder` | `POST /orders/{id}/quotes` | `customer` | `orders.quoteOrder` | 旧 `unit_cents`/`package_cents` 乘法 |
| 客户下单 | `submitOrder` | `POST /orders/{id}/submit` | `customer` | `orders.submitOrder` | — |
| 客户账号 | `updateCustomerPreferences` | `PATCH /me` | `customer` | `auth.updateCustomerPreferences` | 仅限客户；无全站中英 URL 状态同步 |
| 客户支付 | `chargeReceipt` | `GET /charges/{id}/receipt` | `customer` | `payments.chargeReceipt` | — |
| 客户支付 | `checkout` | `POST /charges/{id}/checkout` | `customer` | `payments.checkout` | `assertStripeCheckoutAllowed`; 仅绑定 `mode` 未多商户隔离 |
| 入库预报 | `adviseParcel` | `POST /me/parcels` | `customer` | `intake.advise` | — |
| 仓库收货 | `lookupParcel` | `POST /staff/intake/lookup` | `receiver, warehouse_admin` | `intake.lookup` | — |
| 仓库收货 | `checkIn` | `POST /staff/intake/check-in` | `receiver, warehouse_admin` | `intake.checkIn` | — |
| 仓库收货 | `intakeItems` | `POST /staff/packages/{id}/items` | `receiver, warehouse_admin` | `intake.intakeItems` | — |
| 仓库收货 | `assignItem` | `POST /staff/items/{id}/assign` | `receiver, warehouse_admin` | `intake.assign` | — |
| 质检执行 | `startTask` | `POST /staff/inspection-tasks/{id}/start` | `inspector` | `inspection.startTask` | 缺独立设备授权与无线相机命令绑定 |
| 质检执行 | `recordResults` | `PUT /staff/inspection-tasks/{id}/results` | `inspector` | `inspection.recordResults` | — |
| 质检执行 | `submitTask` | `POST /staff/inspection-tasks/{id}/submit` | `inspector` | `inspection.submitTask` | 仅检查完整性，缺实测计时校准 |
| 报告QA | `submitReport` | `POST /staff/orders/{id}/report/submit` | `inspector` | `inspection.submitReport` | 先 QA 后渲染 PDF（与 `§46/48` 冲突） |
| 报告QA | `returnReport` | `POST /staff/reports/{id}/reject` | `reviewer` | `inspection.returnReport` | — |
| 报告QA | `approveReport` | `POST /staff/reports/{id}/approve` | `reviewer, super_admin` | `inspection.approveReport` | 缺多语种分别独立 QA 同事实哈希 |
| 报告QA | `amendReport` | `POST /staff/reports/{id}/amend` | `reviewer, warehouse_admin, super_admin` | `inspection.amendReport` | — |
| 报告QA | `editReportRevision` | `PATCH /staff/reports/{id}` | `reviewer, warehouse_admin, super_admin` | `inspection.editReportRevision` | — |
| 报告QA | `submitReportRevision` | `POST /staff/reports/{id}/submit-revision` | `reviewer, warehouse_admin, super_admin` | `inspection.submitReportRevision` | — |
| 报告读取 | `reportPDF` | `GET /orders/{id}/report/versions/{n}/pdf` | `customer` | `inspection.readReport` + HMAC 签名 | PDF 存 DB `private_files` |
| 检后处置 | `instruct` | `POST /orders/{id}/dispositions` | `customer` | `dispatch.instruct` | 需区划主数据/未检退回分离 |
| 检后处置 | `instructWithoutOrder` | `POST /me/items/{id}/dispositions` | `customer` | `dispatch.instruct` | — |
| 出库发运 | `planBatch` | `POST /dispatch-batches` | `customer` | `dispatch.planBatch` | — |
| 出库发运 | `confirmBatch` | `POST /dispatch-batches/{id}/confirm` | `customer` | `dispatch.confirmBatch` | — |
| 出库发运 | `quoteBatch` | `POST /staff/dispatch-batches/{id}/quote` | `warehouse_admin` | `dispatch.quoteBatch` | **已知缺陷**：忽略 `r.zones`（L344–391） |
| 出库发运 | `acceptShippingQuote` | `POST /quotes/{id}/accept` | `customer` | `dispatch.acceptQuote` | — |
| 出库发运 | `packShipment` | `POST /staff/dispatch-batches/{id}/parcels` | `warehouse_admin` | `dispatch.packShipment` | — |
| 出库发运 | `handover` | `POST /staff/shipments/{id}/handover` | `warehouse_admin` | `dispatch.handover` | 含部分交接限制检查 |
| 出库发运 | `receiveShipmentReturn` | `POST /staff/shipments/{id}/receive-return` | `warehouse_admin` | `dispatch.receiveReturn` | — |
| 物流跟踪 | `trackInbound` | `GET /me/parcels/{id}/tracking` | `customer` | `logistics.tracking` | 须接入统一行政区划与译文视图 |
| 物流跟踪 | `trackOutbound` | `GET /shipments/{id}/tracking` | `customer` | `logistics.tracking` | 同上 |
| 客户查询 | `listIntakeClaims` | `GET /me/intake-claims` | `customer` | `intake.customerIntakeClaims` | — |
| 客户查询 | `requestIntakeClaim` | `POST /me/intake-claims` | `customer` | `http.submitIntakeClaim` -> `intake.requestIntakeClaim` | multipart 图片限 8MB |
| 客户查询 | `ownedItems` | `GET /me/items` | `customer` | `reads.items` | — |
| 客户查询 | `billing` | `GET /me/billing` | `customer` | `reads.bills` | — |
| 客户查询 | `references` | `GET /me/reference-samples` | `customer` | `reads.referenceSamples` | — |
| 范围变更 | `proposeScope` | `POST /orders/{id}/scope-revisions` | `customer, support, super_admin` | `operations.scopeProposal` | 仅范围变更；与工单追加指令未统一关联 |
| 范围变更 | `acceptScope` | `POST /scope-revisions/{id}/accept` | `customer` | `operations.acceptScope` | — |
| 范围变更 | `renewScopeSupplement` | `POST /scope-revisions/{id}/renew-payment` | `customer` | `operations.renewScopeSupplement` | — |
| 退款/人工报价 | `requestRefund` | `POST /staff/orders/{id}/refunds` | `support, super_admin` | `payments.refundRequest` | — |
| 退款/人工报价 | `requestPaymentRefund` | `POST /staff/payments/{id}/refunds` | `support, super_admin` | `payments.refundRequest` | — |
| 退款/人工报价 | `approveRefund` | `POST /staff/refunds/{id}/approve` | `super_admin` | `payments.refundApprove` | — |
| 退款/人工报价 | `issueManualQuote` | `POST /staff/orders/{id}/quotes` | `support, super_admin` | `orders.issueManualQuote` | — |
| 运营策略 | `getQuotePolicy` | `GET /staff/admin/quote-policy` | `super_admin` | `quote-policy.quotePolicy` | — |
| 运营策略 | `saveQuotePolicy` | `POST /staff/admin/quote-policy` | `super_admin` | `quote-policy.saveQuotePolicy` | — |
| OCR | `confirmOcrCandidates` | `POST /me/ocr/jobs/{id}/confirm` | `customer` | `ocr.confirmOcrCandidates` | — |
| Stripe对账 | `reconcileStripeStatus` | `POST /staff/finance/stripe/reconcile` | `finance, super_admin` | `payment-providers.reconcileStripeStatus` | 按 `test/live` 模式对账，缺多商户实例路由 |

---

## 三、`http.ts` `extras()` 路由全枚举（L139–1500，共 142 组分支）

> 以下覆盖 `http.ts` 中不在 OpenAPI `operations` 数组内、由 `extras()` 直接分发的全部路由及守卫机制（写操作除公开入口与 Webhook 外均经 `csrf(req)` + `extraWrite()` 或显式 `csrf` + `idempotent`）。

### 3.1 公开接口、OAuth / OTP 鉴权与 Webhook（L142–458）
| 行号 | Method & Path | 鉴权 / 防护机制 | 处理器 | 关键说明 / 缺口 |
|---|---|---|---|---|
| L143 | `GET /public/report-shares/{token}(/photos/s/r/p)?` | `no-store, no-referrer, noindex`；share token 校验 | `report-shares.readSharedReport` / `readSharedPhoto` | 正常 |
| L196 | `GET /health` | 公开匿名 | 返回 `{status:"ok"}` | 基础探针（注：后台健康页逻辑 `LIF-012` 在 L615） |
| L200 | `GET /catalog` | 公开匿名 | `orders.catalog` | 默认生产过滤 `demo` 条目 |
| L201 | `GET /carriers` | 公开匿名 | 直查 `carriers where enabled` | 正常 |
| L208–214 | `GET /public/terms`, `GET /public/terms/{kind}` | 公开匿名 | `auth.currentTerms` / `publicPolicy` | 4 类英文条款；缺多语言审定版本接口 |
| L215–228 | `GET /public/inquiry-categories`, `POST /public/inquiries` | Origin 校验 (`origin_only`) + `browserKey` | `tickets.inquiryCategories` / `createPublicInquiry` | `POST` 限游客询价建工单；缺人工结构化报价认领链路（`WEB-13`） |
| L229 | `GET /auth/providers` | 公开匿名 | `integrations.signInMethods` | 返回 `{google, microsoft, email}` 状态 |
| L234–259 | `GET /auth/(google\|microsoft)/(start\|callback)` | OIDC PKCE + state + nonce + HMAC 签名 Cookie | `auth.startProvider` / `finishProvider` | 已生产就绪；需在 `TASK-178` 回归 |
| L260–287 | `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/demo/switch` | `csrf(origin_only)`；`/demo/switch` 仅 `isDemo()` | `auth.startOtp` / `verifyOtp` / `demoSwitchAccount` | 生产关闭 `QCW_DEMO` 时 `/demo/switch` 不可达 |
| L288–321 | `POST /auth/reauth/(start\|verify)`, `POST/GET /auth/recovery/(request\|status)` | OTP 绑定目的 + `csrf` + 冷却期 | `auth.*Recovery*` / `CustomerReauth` | — |
| L427–439 | `POST /staff/auth/login`, `POST /auth/logout` | `staff/auth/login` 密码 scrypt + 6位 TOTP + 防重放；`logout` 需 `csrf` | `auth.staffSignIn` | 员工无个人首次激活/自设 MFA 页面（`LIF-002`） |
| L440–458 | `POST /webhooks/stripe`, `POST /webhooks/email/(postmark\|resend)`, `POST /webhooks/tracking/kuaidi100/{hex64}` | 各自验签（Stripe `constructEvent` / Resend Svix HMAC / Postmark Token / Kuaidi100 MD5） | `payments.stripeEvent` / `email.receive*` / `logistics.providerCallback` | 均先落库/验签再处理 |

### 3.2 客户自助端路由 `/me/*`, `/actions`, `/cases/*`, `/orders/*`, `/dispatch-batches/*`, `/charges/*`（L148–1482）
| 行号 | Method & Path | 权限与校验 | 处理器 | 现状 / 缺口 |
|---|---|---|---|---|
| L148–166 | `GET/POST /orders/{id}/report/versions/{n}/shares`, `DELETE /me/report-shares/{id}` | `actorRequired` + `organization` + `csrf` + `idempotent` | `report-shares.*` | 仅客户本人组织 |
| L167–195 | `GET /me/orders`, `/me/inventory`, `/me/parcels`, `/me/parcels/{id}/context`, `/me/reports` | `actorRequired` + `organization` | `reads.*`, `logistics.*`, `report-shares.*` | 有分页支持；缺地址簿/确认样合同 CRUD 路由 |
| L322–408 | `GET /me/identities`, `POST /me/identities/{p}/link`, `POST refresh-account`, `POST removal-code`, `DELETE identity`, `POST /me/backup-email/*`, `POST /me/email-change/*`, `GET /me/sessions`, `DELETE session`, `POST revoke-others`, `POST /me/account/close` | `actorRequired` + `csrf` + `requireCustomerReauth`（敏感动作） | `auth.*` | 最后登录方式受保护；`account/close` 有义务校验 |
| L459–489 | `GET /me`, `/me/desk`, `/me/email-delivery-status`, `/me/privacy/export`, `POST /me/privacy/requests`, `GET /me/notifications`, `POST read`, `POST read-all`, `GET /actions`, `GET /me/receiving-address` (L521) | `actorRequired` + 各自 `organization` 隔离 | `auth.*`, `reads.*`, `email.*`, `operations.*` | `FINAL-03`: `/me/privacy/export` 与 `/me/privacy/requests` 计算 `unpaidCharges` 不一致；通知仅客户 |
| L490–506 | `GET /cases/{id}`, `POST /cases/{id}/messages` (multipart/json), `GET/POST /me/cases` (L995–1016) | `actorRequired` + `organization` + `csrf` | `tickets.*`, `operations.reportIssue` | — |
| L650–662, L693–716 | `GET /orders/by-number/{no}`, `GET /orders/{id}`, `/scope-revisions`, `/orders/{id}/(quotes\|shipments)/{rid}`, `GET /quotes/{id}`, `GET /shipments/{id}`, `GET /orders/{id}/report(/versions/n(/file)?)?`, `POST /orders/{id}/report/disputes` | `actorRequired`（报告文件需 HMAC `sig` & `expires`） | `reads.*`, `fulfillment-reads.*`, `inspection.*` | — |
| L730–767, L844 | `GET /media/{id}/url`, `PUT /media/{id}/put`, `POST /media/{id}/complete`, `POST /media/upload-url`, `GET /media/{id}`, `POST /me/media` | 签名直传 URL + SHA-256 校验 + 客户/员工归属检查 | `media.*`, `intake.savePhoto` | bytea 存 DB `private_files`；无对象存储与视频 |
| L887–919, L989–994, L1052–1075, L1211–1266 | `POST mismatch-response`, `convert-to-two`, `extend`, `scope-additions`, `manual-quote-request`, `inspection-instructions`, `me/reference-samples/{id}/release`, `me/dispositions/{id}/cancel`, `me/parcels/{id}/link-order`, `GET/POST dispatch-batches/{id}/amend`, `GET/POST /me/incidents/{id}(/response)?`, `GET refund-preview`, `POST after-sales`, `POST /orders/{id}/cancel` | `extraWrite` (`csrf` + `idempotency-key`) + `organization` | `operations.*`, `dispatch.*`, `tickets.*`, `storage.*` | `requestOrderInstruction` 仅建工单；无无报告合法退回专用闭环 |
| L920–935 | `GET/POST /me/parcels/{id}/tracking-verification`, `POST tracking/refresh`, `POST correct` | `actorRequired` + `organization` | `logistics.*` | — |
| L1279–1326 | `POST /checkout/demo/{id}` (`isDemo()`), `GET /me/payment-channels`, `POST /charges/{id}/paypal-invoice`, `POST /me/payments/{id}/report-paypal-paid` | `actorRequired` + `organization` | `payments.demoPay`, `payment-providers.*` | PayPal 手动默认关闭 (`011`) |
| L1434–1482 | `GET/POST /me/ocr/jobs`, `GET /me/ocr/jobs/{id}`, `POST retry`, `POST/MERGE/SPLIT candidates` | `actorRequired` + `organization` + 文件大小/数量限制 | `ocr.*` | — |

### 3.3 员工/仓库/运营后台路由 `/staff/*`（L230, L409–1498）
| 领域 | 路径范围（`http.ts` 行号） | 服务端角色守卫 | 处理器模块 | 缺口与审查结论 |
|---|---|---|---|---|
| 账户与员工 | `/staff/account-recoveries/{id}/(approve\|reject\|execute)` (L409), `/staff/users/{id}/status` (L420), `/staff/users/{id}/roles` (L1029) | `role(actor,"super_admin")` + 关键动作 `requireStaffMfa` | `auth.ts` | 无 `/staff/users` `POST` 新建/邀请路由（`LIF-001`）；无最后超管跨人保护（`LIF-003`） |
| 客服工单 | `GET /staff/tickets`, `GET/POST /staff/tickets/{id}(/events)?` (L507–520) | `support`, `super_admin` | `tickets.ts` | 缺员工通用个人收件箱、主动工单创建及三栏上下文聚合 |
| 仓库收货与标签 | `/staff/desk` (L526), `/staff/items/by-code` (L606), `/staff/packages/{id\|by-code}` (L610), `/staff/scan/{code}` (L768), `/staff/labels/*` (L774–789), `/staff/scan/decode-image` (L790), `/staff/intake/context` (L811), `/staff/packages/*` (L816–867), `/staff/items/*` (L868–886), `/staff/media` (L835) | 领域函数内 `role(...)` (`receiver`, `warehouse_admin`, `super_admin` 等) | `reads.ts`, `labels.ts`, `intake.ts` | 缺自营仓库物理实体与工位/设备/摄影机位注册/审批/配对路由（`LIF-008`, `§114`） |
| 质检与报告 | `/staff/reports` (L527), `GET /staff/reports/{id}` (L531–535；其 `amend`/`submit-revision` 写操作在 `dispatch()` L1563/L1565), `PATCH /staff/reports/{id}/candidate` (L717), `/staff/inspection-tasks/lookup` (L663), `/staff/inspection-tasks/{id}` (L668), `/operation-notes` (L670), `/completeness` (L676), `/shots` (L678), `/steps` (L685) | `inspector`, `reviewer`, `warehouse_admin`, `super_admin` 等 | `reads.ts`, `inspection.ts`, `order-operation-notes.ts` | 缺任务改派与停用员工交接路由（`LIF-006`）；缺摄影控制与 WS/WebRTC 通道（`TASK-189`）；`steps` 前端传 `seconds:60` |
| 库位/盘点/事故/处置 | `/staff/storage` (L544), `/staff/admin/storage/locations/*` (L552–560), `POST /staff/admin/storage/check-reminders` (L1112–1114), `/staff/disposals*` (L649, L952–978), `/staff/stocktakes*` (L1135–1168), `/staff/incidents*` (L1169–1210), `/staff/storage/move` (L1267) | `warehouse_admin`, `receiver`, `super_admin`, `support`, `finance`（依动作） | `storage.ts`, `dispatch.ts`, `operations.ts` | 库位以字符串编码主，无仓库级隔离；缺无报告合法退回授权专用流程；超期提醒扫描需统一后台调度而非仅手动触发 |
| 物流/运费/发运 | `/staff/admin/tracking/health` (L230), `/staff/dispatch-batches*` (L536–543, L1098), `/staff/tracking*` (L647–648, L936–951), `/staff/admin/shipping-rates` (L1076), `/staff/admin/shipping-rates/calculate` (L1091) | `super_admin`, `warehouse_admin`, `finance`（依路由） | `logistics.ts`, `dispatch.ts`, `reads.ts` | 缺中国行政区划导入/预览/发布接口；`shipping-rates/calculate` 与 `quoteBatch` 区域口径不同 |
| 运营总览/配置/目录/条款 | `/staff/admin/desk` (L614), `/staff/object-summary` (L1060), `/staff/orders*` (L639–646, L1249, L1264), `/staff/admin/launch-readiness\|rehearsal-runs\|legal-entity\|launch-signoff\|disposal-execution-switch` (L979–988), `/staff/admin/warehouse-addresses*` (L1017), `/calendar` (L1022), `/terms*` (L1024), `/templates*` (L1032), `/capabilities*` (L1036), `/categories*` (L1042), `/offers` (L1046), `/skus/*` (L1048–1051) | 主为 `super_admin` / `template_admin` / 领域角色 + 部分 MFA | `operations.ts`, `admin-reads.ts`, `reads.ts` | `app_config` 缺统一后台政策面板；价格发布缺草稿→独立审批工作流（`LIF-009`）；缺 AI/i18n/知识库管理端点 |
| 财务/支付/第三方集成/OCR | `/staff/admin/payments*` (L561), `/staff/admin/refunds*` (L567, L573), `/staff/admin/customers*` (L586), `/staff/admin/inspections*` (L592), `/staff/admin/dispositions-overview` (L599), `/staff/admin/incidents\|disposals` (L602–605), `/staff/admin/reconciliation` (L1115), `/staff/admin/finance/ledger(.csv)?` (L1122–1127), `/staff/dispositions/{id}/storage-quote` (L1133), `/staff/disputes/{id}/resolve` (L1255), `/staff/admin/integrations*` (L1327–1386), `/staff/finance/paypal-invoices*` (L1387–1424), `/staff/finance/refunds/{id}/execute-manual` (L1425), `/staff/admin/ocr/*` (L1483–1498) | `super_admin`, `finance`, `support`（依端点） + 高风险操作 `requireStaffMfa` | `admin-reads.ts`, `integrations-admin.ts`, `payment-providers.ts`, `payments.ts`, `ocr.ts` | `adminReads` 查询完备；缺统一应收账单/多商户账户 CRUD；`approveRefund` 需对齐独立权限策略 |
| 系统运维与邮件监控 | `/staff/admin/system-health` (L615), `/staff/admin/recovery-runs` (L616), `/staff/audit` (L618), `/staff/admin/jobs*` (L622–628), `/staff/admin/email-deliveries*` (L629–638) | `super_admin` / 审计角色 | `operations.ts`, `audit-read.ts`, `worker.ts`, `email.ts` | `system-health` 含 `triggers.length >= 5` 假健康阈值（`LIF-012`）；缺真实六维对账中心与备份/恢复执行器 |
