# TASK-175｜全系统配置、环境变量与集成登记册 (`config-inventory`)

- **冻结基准 Commit**：`e386eaeb87c8737c586ee0f4d368887808434a07`
- **核查口径**：覆盖代码内全部 **32** 个运行时环境变量（23 个 `process.env.*` 直接引用 + 9 个 `integrations.ts` `get(name)` 动态读取，另含测试/构建辅助变量）、`app_config` 键值、15 个 `integration_providers`、数据库可配置主数据表，逐项区分 `EXISTS_VERIFIED` 与 `UNVERIFIED` / `MISSING`，严禁不经后台而靠直接改库维护日常运营参数（`LIF-007`）。

---

## 一、环境变量清单（共 32 项运行时环境变量，来源：`e386eae` 源码全量扫描）

| 变量名 | 用途说明 | 敏感度 | 代码读取位置 | 备注 |
|---|---|---|---|---|
| `DATABASE_URL` | 应用主 PostgreSQL 连接串 | 高 | `scripts/migrate.mjs:5-6`, `scripts/backup-restore-check.mjs:4`, `packages/db/index.ts` | 生产在 `/etc/qcwarehouse/application.env` (`0600`) |
| `AUTH_OTP_PEPPER` | 密码学主密钥（OTP HMAC / CSRF / AES-GCM 派生 / 报告下载签名） | 极高 | [crypto.ts:5](../../../packages/core/crypto.ts#L5), [media.ts:56](../../../packages/core/media.ts#L56) | 迁移服务器必须保持原值以解密历史密钥密文 |
| `APP_URL` | 对外主域名源站（OAuth 回调、CSRF Origin、链接生成） | 中 | [auth.ts:13](../../../packages/core/auth.ts#L13), [integrations.ts:30, 112, 144](../../../packages/core/integrations.ts#L30), [public-seo.ts:8](../../../app/public-seo.ts#L8) | 生产：`https://qcwarehouse.com` |
| `NODE_ENV` | 运行模式开关 | 低 | `auth.ts:216`, `common.ts:70`, `integrations.ts:30`, `demo.ts:8` | — |
| `QCW_DEMO` | 本地演示开关（生产强制为 `0`） | 高 | `common.ts:70`, `demo.ts:8` | 开启时解锁 `/checkout/demo/*` 与 `/auth/demo/switch` |
| `REPORT_SHARING_ENABLED` | 公开报告分享功能开关 | 低 | [report-shares.ts:7](../../../packages/core/report-shares.ts#L7) | — |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth2/OIDC 客户登录客户端凭证 | 高/极高 | [integrations.ts:7, 28-32](../../../packages/core/integrations.ts#L7-L32) | 经 `get()` 动态读取；已配置并完成正式上线 |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Microsoft Entra 个人账号 OIDC 客户端凭证 | 高/极高 | [integrations.ts:8, 28-32](../../../packages/core/integrations.ts#L8-L32) | 经 `get()` 动态读取；已配置并完成正式上线 |
| `STRIPE_SECRET_KEY` | Stripe 环境兜底私钥（DB Vault 优先） | 极高 | [integrations.ts:35](../../../packages/core/integrations.ts#L35), `integrations-admin.ts:612, 619` | 仅 env 回退；VPS 已启用 Live Stripe |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 验签密钥 | 极高 | [integrations.ts:35](../../../packages/core/integrations.ts#L35), `integrations-admin.ts:620` | — |
| `STRIPE_LIVE_ENABLED` | Stripe Live 结账环境变量开关（需 `=1` 且 HTTPS `APP_URL` 且非 demo） | 高 | [integrations.ts:39](../../../packages/core/integrations.ts#L39) | 与 `integration_providers` DB 状态配合生效 |
| `PAYPAL_LIVE_CLIENT_ID` / `SECRET` / `WEBHOOK_ID` | PayPal Auto Live 凭证 | 高/极高 | `integrations-admin.ts:627-629` | 当前合规 `requires_review`，未开放 |
| `PAYPAL_SANDBOX_CLIENT_ID` / `SECRET` / `WEBHOOK_ID` | PayPal Auto Sandbox 凭证 | 中/高 | `integrations-admin.ts:631-633` | 同上 |
| `GOOGLE_CLOUD_VISION_API_KEY` / `GOOGLE_VISION_SERVICE_ACCOUNT_JSON` | Google Cloud Vision OCR 凭证 | 高 | `integrations-admin.ts:637-638` | 另有加密密钥库优先级覆盖 |
| `GOOGLE_DOCAI_SERVICE_ACCOUNT_JSON` / `ACCESS_TOKEN` | Google Document AI OCR 凭证 | 高 | `integrations-admin.ts:641-642` | 可选引擎，默认禁用 |
| `KUAIDI100_KEY` / `CUSTOMER` / `SECRET` | 快递100 查询/订阅凭证 | 高 | [integrations.ts:143](../../../packages/core/integrations.ts#L143), `integrations-admin.ts:645-647` | 正式账户实时查询仍待实证（`UNVERIFIED`） |
| `TRACKING_CALLBACK_BASE_URL` | 快递100 订阅推送 HTTPS 回调根地址覆盖（未设则回退 `APP_URL`） | 中 | [integrations.ts:144](../../../packages/core/integrations.ts#L144) | 经 `get()` 动态读取 |
| `EMAIL_PROVIDER` | 邮件发送服务选择（默认 `resend`，可手动切 `postmark`） | 中 | [integrations.ts:131](../../../packages/core/integrations.ts#L131) | 经 `get()` 动态读取 |
| `EMAIL_FROM` | Postmark 模式发件地址 | 低 | [integrations.ts:124](../../../packages/core/integrations.ts#L124) | 经 `get()` 动态读取（Resend 发件地址存于后台配置） |
| `POSTMARK_MESSAGE_STREAM` | Postmark 消息流名称（默认 `outbound`） | 低 | [integrations.ts:125](../../../packages/core/integrations.ts#L125) | 经 `get()` 动态读取 |
| `POSTMARK_SERVER_TOKEN` / `POSTMARK_WEBHOOK_TOKEN` | Postmark 备用发信凭证 | 高 | [integrations.ts:124, 126](../../../packages/core/integrations.ts#L124-L126), `integrations-admin.ts:650-651` | 现业务方切为 Resend 主用，Postmark 保留手动备用 |

*(另注：测试入口使用 `TEST_DATABASE_URL`，生产构建禁用遥测使用 `NEXT_TELEMETRY_DISABLED`。)*

---

## 二、`app_config` 运行时业务配置键全览（`LIF-007` 实证）

| `app_config.key` | 写入者（路径与行号） | 读取者（路径与行号） | 后台 UI 入口 | 实证缺口 |
|---|---|---|---|---|
| `storage.free_days` | **无系统/UI 写入者！** | [inspection.ts:1638](../../../packages/core/inspection.ts#L1638) | **无后台编辑页** | 仅靠默认值或 SQL 修改；旧默认值未统一迁至 `§64` 15 个完整自然日 |
| `storage.daily_cents` | [scripts/demo.ts:111](../../../scripts/demo.ts#L111)（仅 seed） | [dispatch.ts:446](../../../packages/core/dispatch.ts#L446) | **无后台编辑页** | 生产空库无 UI 配置入口，运营无法修改超期仓储单价（`LIF-007`） |
| `calendar.holidays` / `business_holidays` / `calendar.extra_workdays` | [operations.ts:341-352](../../../packages/core/operations.ts#L341-L352) | [orders.ts:474](../../../packages/core/orders.ts#L474), [reads.ts:1165](../../../packages/core/reads.ts#L1165) | `/admin/config` (`staff.tsx:2251`) | 查询同时读取 `calendar.holidays` 与历史 `business_holidays` 键名存在漂移，需统一键规范 |
| `quote.*` (quote policy) | [quote-policy.ts:29](../../../packages/core/quote-policy.ts#L29) | [quote-policy.ts:12](../../../packages/core/quote-policy.ts#L12) | `/admin/config` (`staff.tsx:2250`) | 已有 MFA 保护，需与统一应收/AI/物流策略整合 |
| `legal.entity` | [operations.ts:1625](../../../packages/core/operations.ts#L1625) | [operations.ts:1685](../../../packages/core/operations.ts#L1685) | `/admin/operations` 面板 | `FINAL-04`：强制 `br_number` 不兼容个人经营主体；缺少版本化主体历史 |
| `launch.rehearsal_runs` | [operations.ts:1591](../../../packages/core/operations.ts#L1591) | [operations.ts:1685](../../../packages/core/operations.ts#L1685) | `/admin/operations` 面板 | 仅记录手填演练条目，未与 67 项真实门禁关联 |
| `launch.signoff` | [operations.ts:1799](../../../packages/core/operations.ts#L1799) | [operations.ts:1643, 1685](../../../packages/core/operations.ts#L1643-L1685) | `/admin/operations` 面板 | `tests/workflow.test.mts:6604-6609` 测试直接读写；未接入 `L04`/`K03` 67 门禁 |
| `disposal.production_execution_enabled` | [operations.ts:1382](../../../packages/core/operations.ts#L1382) | `admin-reads.ts:1460`, `storage.ts:933, 1132` | `/admin/dispositions` / `operations` | 已存在，后续纳入 `TASK-235` 统一配置治理 |
| `demo.seeded` | [scripts/demo.ts:111](../../../scripts/demo.ts#L111) | [scripts/demo.ts:11](../../../scripts/demo.ts#L11) | 仅本地 seed | — |

---

## 三、`integration_providers` 15 项第三方通道注册清单（`integrations-admin.ts` L66–484）

| 域 | `provider_key` | 合规状态 (`compliance_status`) | 默认启用 (`default_enabled`) | 密钥管理与当前实证状态 |
|---|---|---|---|---|
| `payment` | `stripe` | `approved` | `true` | AES-256-GCM Vault (`integration_secrets`) + env 回退；VPS 已启用香港 Live Stripe（实收小额交易在本地/隔离待实仓签署） |
| `payment` | `paypal_manual` | `manual_only` | `false` | 由迁移 `011` 默认关闭；隔离测试 `P15–P17` 通过（`EXISTS_VERIFIED` 隔离）；待 `TASK-207A` 保留 |
| `payment` | `paypal_auto` | `requires_review` | `false` | 个人主体拦截测试 `P07` 通过；`TASK-207A` 仅预留适配，不强制启用 |
| `payment` | `creem` | `prohibited_aup` | `false` | 实物检查禁入，测试 `P08` 验证拦截 |
| `payment` | `dodo_payments` | `prohibited_aup` | `false` | 实物检查禁入，测试 `P08` 验证拦截 |
| `payment` | `airwallex` | `disabled_future` | `false` | 无企业主体拦截（`P09`），未来预留 |
| `payment` | `oceanpayment` | `disabled_future` | `false` | 无企业主体拦截（`P09`），未来预留 |
| `ocr` | `paddle_ocr` | `approved` | `true` | 本地 `rapidocr_onnxruntime`（`PP-OCRv4`），本轮在本机环境验证健康检查 `{"ok": true}` |
| `ocr` | `google_vision_ocr` | `approved` | `false` | 可配选引擎，`TASK-206A` 增量接后台与人工候选审核 |
| `ocr` | `google_docai` | `approved` | `false` | 可选引擎，默认禁用 |
| `logistics` | `kuaidi100` | `approved` | `true` | 查询/订阅/频控/电话校验隔离测试通过；真实企业生产额度/回调 `UNVERIFIED` |
| `email` | `resend` | `approved` | `false` (代码默认；迁移 `013` + 线上运行配置已启用为主发信) | `resend-settings.ts`；线上验证发送 `support@qcwarehouse.com`；Gmail/Outlook 实收 `UNVERIFIED` |
| `email` | `postmark` | `approved` | `true` (代码默认；线上留作手动备用) | 保留手动切换备用（`TASK-194B`） |
| `storage` | `local_storage` | `approved` | `true` | **需替换方向**：生产严禁长期使用本地盘/`BYTEA`；`TASK-185/186` 新建 R2/S3/B2/通用 S3 多实例私有对象存储适配器 |
| `webhook` | `outbound_webhooks` | `approved` | `false` | 通用对外 Webhook 预留（已实现 SSRF 严格防御 `P10`） |

**本期尚未接入的新增外部域（`MISSING`）**：
1. **统一 AI 服务供应商与 9 用途路由（`TASK-191A/191/192/193`）**：当前源码中无任何 OpenAI 官方或 OpenAI-Compatible 实例注册、模型探测、9 用途绑定与预算账本表/模块。
2. **WhatsApp 官方适配（`TASK-231`）**：当前源码中无 WhatsApp webhook、模板映射与外发记录表。
3. **中国行政区划外部权威数据快照（`TASK-181`）**：当前库内无行政区划主数据表，亦无导入/预检/审批/发布流程。

---

## 四、业务配置表与缺失的后台运营控制台（对应 `TASK-195..197, 235`）

- 现有有部分后台界面的配置表：`warehouse_addresses`（`/admin/config`）、`storage_locations`（`/admin/storage/locations`）、`terms_versions`（`/admin/legal`）、`categories` / `capabilities` / `service_types` / `service_offers` / `template_versions`（`/admin/catalog`, `/admin/templates`）、`sku_prices`（缺审批工作流，`LIF-009`）、`shipping_rate_versions`（`/admin/shipping-rates`，仅 USD 简化费率，`LIF-010`）。
- 完全无后台可配置能力的新增/缺失域：
  - 工时基准与真实成本/保本核算参数（当前仅 `demo.ts`/静态默认值）
  - 官网 CMS 区块 / FAQ / 样例报告元数据动态配置（当前全为 `public-site.tsx` / `faq.tsx` / `report-guide.tsx` JSX 硬编码，`WEB-12`）
  - 15 天普通免费保管、豁免/超期费率、包装耗材定价、确认样年/季/月付费合同模板
  - 设备类型/拍照机位规范、17+ 服装动态测量 SVG 编辑器、L1–L5 复杂度规则与 M01–M11 模块矩阵。
