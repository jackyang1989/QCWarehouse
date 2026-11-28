# PKG-5 Wave 27（TASK-200 · E395–E399）双语公开官网主体工程与审计验证报告

- **任务编号**：`TASK-200`（`PKG-5 · E395–E399`）
- **当前状态**：`待验收`（工程与独立只读复审已闭环；涉及真实 WhatsApp 商业号核验、生产域名上线切换及 `L04` 67 项正式门禁维持 `PRODUCTION_NOT_READY`，须分别留证批准）
- **基线提交**：`3879f684915cf6f9132a5f242327aa31f22c08ec`（PKG-4 Wave 26 `TASK-199`）

---

## 1. 交付范围清单

| 层级 | 文件 | 核心变更说明 |
|---|---|---|
| 数据库增量迁移 | `packages/db/migrations/034_public_website_foundation.sql` | 新增 `public_contact_settings`（含 `public_contact_whatsapp_verified_check`：严禁未经核验或非 HTTPS 启用 WhatsApp）与 `public_retired_routes`（含 `/services/aql` `410` 与 `/legacy-pricing` `301` 初始种子、`not like '//%'` 防开放重定向及 `replacement_path` CHECK 约束） |
| 领域核心逻辑 | `packages/core/public-website.ts` | `E164_PHONE_RE` 严格 E.164 号码校验、`/public/contact-config` 安全投影（未核验或非严格 E.164 时强制置 `null`）、`/public/route-status` 与后台 `301/410` 路由管理（拦截 `//`、`\` 与跨站跳转）、MFA 15 分钟复核与系统保留路径前缀防误伤保护 |
| API 路由挂载 | `packages/core/http.ts` | 新增 7 个端点：`GET /public/contact-config`、`GET /public/route-status`、`GET/PUT /staff/admin/public-contact-config`、`GET/POST/DELETE /staff/admin/public-retired-routes` |
| 路由代理 / 404 / 410 / SEO | `proxy.ts`、`app/gone/route.ts`、`app/not-found.tsx`、`app/robots.ts` | `proxy.ts` 查表执行 301/410 重定向（含 `startsWith('/') && !startsWith('//') && !includes('\\')` 防开放重定向）；`/gone` Route Handler 输出真实 HTTP `410`、`X-Robots-Tag: noindex, nofollow`、正式 Wordmark（`/brand/qc-warehouse-wordmark.png`）与 HTML 转义 XSS 防护；`not-found.tsx` 提供真实 404 引导；`robots.ts` 严格屏蔽 `/admin`、`/wh`、`/account`、`/orders`、`/login`、`/api/` 与 `/gone` |
| 公开站点界面与悬浮部件 | `app/public-contact-widget.tsx`、`app/chrome.tsx`、`app/page.tsx`、`app/portal.tsx`、`app/marketing.css` | 顶部与页脚双语切换器（`PublicLanguageSwitcher`）、桌面导航增加联系入口；全局公开页挂载默认折叠的轻量非实时联系浮窗（支持 `Escape` 关闭与焦点恢复、显式标明非实时客服、严格按服务端 `whatsapp_verified && whatsapp_enabled` 条件渲染） |
| 全站公开内容双语对齐 | `app/public-site.tsx`、`app/report-guide.tsx`、`app/faq.tsx`、`app/public-inquiry.tsx` | 全量公开路径使用 `localizePublicPath` / `hrefFor` 维持 `/zh` 内部导航闭环；完整覆盖 `PackageCard`、`PublicServicesOverview`、`PublicServiceDetail`、`PublicCategories`、`PublicHowItWorks`、`PublicPricing`（保持 `L1–L5` 内部成本隔离与沙盒标牌）、`PublicLegal`/`PolicyText`、`SampleReportPreview` 与 `ReportGuide`（第 01–09 节与灯箱弹窗）全量中英双语 |
| 集成测试 | `tests/pkg5-wave27-public-website.test.mts`、`package.json` | 校验 RBAC 越权（403）、MFA、非 E.164 / 未验证 WhatsApp 拒绝（422 与 DB CHECK 约束）、开启/隐藏投影、`301/410` 双语解析、开放重定向拦截（`//evil.com`、`/foo\bar` API 422 与 PostgreSQL `23514`）、`/gone` 真实 `410` + `noindex` + Wordmark + XSS 防护、`robots.txt`/`sitemap.xml` 边界与 `/catalog` 零 `L1–L5` 成本泄漏 |

---

## 2. 隔离迁移与工程门禁验证

1. **Pre-`034` 隔离备份恢复演练**（`qcw_t200_pre` → `qcw_t200_restore`，33 个既有迁移）：
   - `ok: true`
   - `dump_bytes: 898725`
   - `dump_sha256: 3e917e758ebfbd0edeb0510500dfd4f643973f9a1b03224aad9824b13b327de1`
   - `manifest_sha256: 7cf9805acdfb2036e6e71ee0528165f592a5bf79cf62e60e0892ddb3b659a7fb`
   - `rpo_seconds: 0`, `rto_ms: 650`, `corrupt_backup_rejected: true`
2. **空库全量迁移与关系用例复验**（`qcw_t200_empty`）：
   - 执行 `001_initial.sql` – `034_public_website_foundation.sql` 全部成功。
   - 执行 `psql -v ON_ERROR_STOP=1 -f docs/contracts/verify.sql` 通过（`BEGIN / DO / ROLLBACK`）。
   - 实测非法 `redirect_to = '//evil.com'` 触发 PostgreSQL `public_retired_routes_redirect_check` 拦截（SQLSTATE `23514`）。
3. **整改终版全量验证门禁**：
   - `npm run check` (`tsc --noEmit`)：0 errors
   - `npm run check:i18n`：`104 fixed keys (en-US/zh-CN complete, 0 placeholder mismatches, 16 SEO routes paired)`
   - `python3 docs/contracts/check.py`：`264 tasks (174 historical + 90 active), E1–E654, 121 pages, 147 implementation cases, 82 AT groups, 67 production gates, 51 transaction operations`（0 错）
   - `python3 tests/contract-check.test.py`：`Ran 16 tests OK`
   - `npm run test:integration`（`TEST_DATABASE_URL=postgres://jianouyang@127.0.0.1:5432/qcw_test`）：**`tests 221, pass 221, fail 0, skipped 0`**
   - `QCW_DEMO=0 npx next build`：Next.js `16.4.5` (Turbopack) 构建成功（含 `ƒ Proxy (Middleware)`、`ƒ /gone`、`○ /_not-found`、`○ /robots.txt`、`○ /sitemap.xml`）
4. **受保护契约检查**：
   - `001`–`033` 已应用迁移、`docs/contracts/*` 与 `67` 项 `L04` 正式门禁零改动。

---

## 3. 独立只读审计记录

| 轮次 | Reviewer Conversation ID | 结论 | 核验摘要 |
|---|---|---|---|
| 初审 | `e417e335-9934-4efd-8014-aed0e690bb91` | `FAIL` | 0 P0 / 0 P1 / 3 P2 / 2 Nits（`redirect_to` 开放重定向约束、`hrefFor` 缺失、`report-guide`/`public-site` 中文补全、`app/page.tsx` 页脚路径、入参校验） |
| 复审 | `8cf9a46c-62dd-4de9-9e3c-e24b00fc975b` | `FAIL` | P2-1、P2-2、Nit-1 及 `app/public-site.tsx` 主体均已确认通过；指出 `app/report-guide.tsx`（含 `SampleReportPreview`、Banner 与第 03–09 节）及 WhatsApp 严格 E.164 正则仍有 2 P2 + 2 Nits |
| **终审** | **`2726b9f8-f097-4bfc-a30b-578c03138712`** | **`VERDICT: PASS`** | **0 P0 / 0 P1 / 0 P2 / 0 Nits** — 全量确认 `app/report-guide.tsx`、`E164_PHONE_RE`、反斜杠路由校验、`app/public-site.tsx` 尾项、品牌与无虚假承诺门禁、`/gone` 410 + `noindex` + XSS 防护及零 `L1–L5` 泄漏全部闭环 |

---

## 4. 待正式发布与外部联调确认项

- 本阶段保留沙盒/演示定价标记与非实时咨询默认配置；`public_contact_settings.whatsapp_verified` 默认 `false`。
- 真实 WhatsApp Business 商业账号验证、生产域名 `HTTPS` / DNS 切换、正式商业定价批准（`TASK-197B`）及 67 项 `L04` 门禁签署仍由后续对应上线包及业务验收人分别留证批准（`PRODUCTION_NOT_READY`）。
