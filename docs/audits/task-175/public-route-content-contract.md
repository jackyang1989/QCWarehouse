# TASK-175｜公开官方网站（第四端）逐页内容与契约盘点 (`public-route-content-contract`)

- **冻结基准 Commit**：`e386eaeb87c8737c586ee0f4d368887808434a07`
- **核查依据**：`01-116` 第 95.1、96 节（`WEB-12`, `WEB-14`）及源码 [app/page.tsx](../../../app/page.tsx)、[app/[...page]/page.tsx](../../../app/[...page]/page.tsx)、[app/public-seo.ts](../../../app/public-seo.ts)、[app/public-site.tsx](../../../app/public-site.tsx)、[app/public-inquiry.tsx](../../../app/public-inquiry.tsx)、[app/report-guide.tsx](../../../app/report-guide.tsx)、[app/faq.tsx](../../../app/faq.tsx)、[app/report-sharing.tsx](../../../app/report-sharing.tsx)、[app/r/[token]/page.tsx](../../../app/r/%5Btoken%5D/page.tsx)、[app/account-access.tsx](../../../app/account-access.tsx)、[app/chrome.tsx](../../../app/chrome.tsx)。

---

## 一、现存公开与认证路由盘点（共 22 条实存路由 + 规划新增）

| 路由 | 对应组件与行号 | 元数据 (`public-seo.ts`) | 当前内容数据源 | 关键 CTA 去向与身份行为 | 当前缺陷 | 重构处置 | 目标任务 |
|---|---|---|---|---|---|---|---|
| `/` | `Home` ([page.tsx](../../../app/page.tsx) L141) | `PUBLIC_ROUTE_SEO["/"]` (L21) | 服务端读 `catalog` + **大量硬编码 JSX 文案**（`PROCESS_STAGES` L108–139 等） | `/orders/new?offer=`, `/services/*`, `/report-guide`, `/account` | `.catch(() => [])` 隐藏后端故障（`WEB-09`）；英文单语；无动态 CMS/配置联动 | **重构**（接入权威配置+双语 `/zh`+去假回退） | TASK-190, TASK-200, TASK-203 |
| `/catalog` | `PublicServicesOverview` ([public-site.tsx](../../../app/public-site.tsx) L156) | `PUBLIC_ROUTE_SEO["/catalog"]` (L27) | `/catalog` API + 静态 JSX 描述 | `/orders/new?offer=`, `/services/*`, `/pricing` | 价格卡片单价汇总简略；缺失服务开放边界/启停透明展示 | **重构**（接目录/模块与服务启停真实状态） | TASK-200, TASK-202 |
| `/services/inspection` | `PublicServiceDetail` (`inspection`, [public-site.tsx](../../../app/public-site.tsx) L762) | `PUBLIC_ROUTE_SEO["/services/inspection"]` (L33) | `/catalog` + 硬编码能力描述 | `/orders/new?offer=`, `/report-guide`, `/pricing` | 缺动态公开模块说明、工时前提及 L1–L5 示例 | **重构** | TASK-200, TASK-202 |
| `/services/compare` | `PublicServiceDetail` (`compare`, L762) | `PUBLIC_ROUTE_SEO["/services/compare"]` (L39) | `/catalog` + 硬编码固定 2/3 件描述（L429） | `/orders/new?offer=`, `/report-guide`, `/pricing` | 固定 2–3 件包价约束，未对接新对比组可配置能力 | **重构** | TASK-200, TASK-202 |
| `/services/reference` | `PublicServiceDetail` (`reference_match`, L762) | `PUBLIC_ROUTE_SEO["/services/reference"]` (L45) | `/catalog` + 硬编码规则说明 | `/orders/new?offer=`, `/report-guide`, `/pricing` | 未明确区分别名匹配、封存建档、付费合同与基准校验前置（`WEB-06`） | **重构** | TASK-200, TASK-202, TASK-228 |
| `/categories` | `PublicCategories` ([public-site.tsx](../../../app/public-site.tsx) L1026) | `PUBLIC_ROUTE_SEO["/categories"]` (L51) | `/catalog` + 静态分类表 | `/orders/new?offer=`, `/legal/restricted-items`, `/contact?topic=category` | 子类扩展与测量点展示偏静态，未联动 `categories` 发布中心 | **重构** | TASK-195, TASK-200 |
| `/how-it-works` | `PublicHowItWorks` ([public-site.tsx](../../../app/public-site.tsx) L1425) | `PUBLIC_ROUTE_SEO["/how-it-works"]` (L57) | 纯静态 JSX | `/orders/new`, `/report-guide`, `/faq` | 未链接公开运费试算与 15 天免费保管规则页（`§96.1`）；仍沿用“全到齐”流程叙述 | **重构** | TASK-200, TASK-203 |
| `/pricing` | `PublicPricing` ([public-site.tsx](../../../app/public-site.tsx) L1636) | `PUBLIC_ROUTE_SEO["/pricing"]` (L69) | `/catalog` + 前端重复计算器（L1688–1734） | `/orders/new?offer=`, `/contact?topic=quote&qty=` | **`WEB-01..04, 09` 重灾区**：前端重复计费、无模块/混合购物车、无匿名草稿保存、无数据回退 `"Quote on request"` | **重构**（改由服务端权威估价+匿名购物车/草稿） | TASK-197, TASK-201, TASK-201B |
| `/report-guide` | `ReportGuide` ([report-guide.tsx](../../../app/report-guide.tsx) L308) | `PUBLIC_ROUTE_SEO["/report-guide"]` (L63) | 静态示例图 (`/marketing/*.webp`) + 硬编码对比报告演示 | `/orders/new`, `/catalog` | 仅有一份三件对比静态样例，缺三大服务完整双语样例及真实可读 PDF（`WEB-11`） | **重构** | TASK-203, TASK-217 |
| `/faq` | `FaqPage` ([app/faq.tsx](../../../app/faq.tsx)) | `PUBLIC_ROUTE_SEO["/faq"]` (L75) | 纯静态 JSX 问答 | `/pricing`, `/contact`, `/orders/new` | 无后台 CMS 动态维护，无中文版本 | **重构**（轻 CMS 发布 + 双语） | TASK-190, TASK-200 |
| `/contact` | `PublicInquiry` ([app/public-inquiry.tsx](../../../app/public-inquiry.tsx) L18) | `PUBLIC_ROUTE_SEO["/contact"]` (L81) | `/public/inquiry-categories` API + `POST /public/inquiries` | 匿名提交生成工单；无结构化报价认领 | `WEB-13`：缺少结构化询价报价单认领转正式委托（`TASK-202B`） | **重构** | TASK-202B, TASK-232 |
| `/legal`, `/legal/terms`, `/legal/privacy`, `/legal/restricted-items`, `/legal/report-notice` (共 5 路由) | `LegalDocs` (in `portal.tsx` / `app/[...page]/page.tsx`) | `PUBLIC_ROUTE_SEO["/legal*"]` (L87–111) | DB `terms_versions` (`/public/terms`) | 纯公开阅读，无 CTA | 当前仅英文单一版本，`demo` 文本需上线前替换并补审定中文展示 | **保留+扩展** | TASK-178, TASK-190, TASK-233 |
| `/r/[token]` | `SharedReport` ([app/r/[token]/page.tsx](../../../app/r/%5Btoken%5D/page.tsx) L11, [report-sharing.tsx](../../../app/report-sharing.tsx) L126) | 独立 `Shared inspection report` + `noindex` | `GET /public/report-shares/{token}` | 下载分享报告及受签名照片 | 需对齐新版多语种发布与撤销实时生效 | **保留+扩展** | TASK-220 |
| `/login`, `/signup` | `Login` ([account-access.tsx](../../../app/account-access.tsx) L30) | `PORTAL_ROUTE_TITLES` (L115–116) | `GET /auth/providers`, OIDC, OTP | 登录后跳转 `next` 或 `/orders`；关联 `/account/recovery` | 需支持保留双语路由 `/zh` 与 `draft` 上下文跨注册不丢失 | **保留+扩展** | TASK-178, TASK-190, TASK-201B |
| `/onboarding` | `Onboarding` ([account-access.tsx](../../../app/account-access.tsx) L238) | `PORTAL_ROUTE_TITLES` (L117) | `/public/terms` (`terms` + `privacy`) | 提交 `POST /auth/registration/complete` | 保留两份协议强制勾选与唯一收件码颁发 | **保留** | TASK-178, TASK-190 |
| `/account/recovery` | `AccountRecovery` ([account-access.tsx](../../../app/account-access.tsx) L159) | `PORTAL_ROUTE_TITLES` (L118) | `/auth/recovery/*` | 恢复申请与状态查询 | 保留 | **保留** | TASK-178, TASK-190 |
| `/staff/login` | `Login (staff)` ([account-access.tsx](../../../app/account-access.tsx) L30, [staff-login-copy.ts](../../../app/staff-login-copy.ts)) | 动态区分管理/仓库/通用登录（L216） | `POST /staff/auth/login` | 成功后按权限跳 `/admin` 或 `/wh` | 补齐员工忘记密码/MFA 恢复与首次激活引导（`LIF-002`） | **保留+扩展** | TASK-179, TASK-190 |
| *缺失规划*：`/shipping-calculator`（独立公开运费计算器） | **MISSING** | **MISSING** | 无公开接口（仅 `/staff/admin/shipping-rates/calculate`） | `WEB-10` 强制从 `/pricing`, `/how-it-works`, `/faq`, 页脚直接链接 | 未建公开销售费率试算器及区划/体积重联动 | **新增** | TASK-200, TASK-222, TASK-223 |
| *缺失规划*：`/storage` / Storage & Handling 说明路由 | **MISSING** | **MISSING** | 部分散见 `/pricing` 与 `/faq` | `§96.1` 强制页脚/Pricing 可直达 15 天规则与确认样说明 | 需统一改为 15 个完整自然日及确认样付费规则 | **新增/合并** | TASK-200, TASK-227, TASK-228 |
| *缺失规划*：`/zh` / `/zh/*` 中文公开镜像路由 | **MISSING** | **MISSING** | 无中文公开页面或 SEO hreflang | 英语默认无前缀，中文固定 `/zh/*`，自动记手选语言并回跳保持 | 当前全官网为纯英文 | **新增** | TASK-190, TASK-190A, TASK-200 |
| *缺失规划*：员工首次邀请激活 `/staff/activate` | **MISSING** | **MISSING** | 无 | 一次性邀请链接与设密码/绑定 TOTP（`GET` 不消费令牌） | 当前无员工开户入口 | **新增** | TASK-179 |

---

## 二、官网共用导航与页脚核查（[app/chrome.tsx](../../../app/chrome.tsx)）

1. **已核实正确保留点**：
   - `PublicHeader`（L93）与 `PublicFooter`（L203）已区分访客/已登录客户/员工身份链接（L22–88），不存在将员工误作客户混用。
   - 页脚使用官方品牌字标 [brand.ts](../../../packages/core/brand.ts)，未虚构企业资质认证或虚假地址。
2. **明确缺口**：
   - 缺少顶部与页脚**语言切换器（English / 中文）**及右下角轻量客服/联系浮窗入口（`§53.2`, `§53.6`, `§96` 强制要求）。
   - 主导航尚未直接暴露 `Shipping Calculator` 与 `Storage & Handling` 的标准链接入口。
