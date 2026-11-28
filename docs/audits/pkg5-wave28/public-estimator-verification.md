# PKG-5 Wave 28（TASK-201 · E408–E412）免登录估价及匿名草稿工程与审计验证报告

- **任务编号**：`TASK-201`（`PKG-5 · E408–E412`）
- **当前状态**：`待验收`（工程与独立只读复审已闭环；登录后草稿合并认领按依赖划分在 `TASK-201B` 签收；`L04` 67 项正式门禁保持 `PRODUCTION_NOT_READY`）
- **基线提交**：`0e2b6c7f464fc706bfcbcbb33c4c94609cddc035`（PKG-5 Wave 27 `TASK-200`）

---

## 1. 交付范围清单

| 层级 | 文件 | 核心变更说明 |
|---|---|---|
| 数据库增量迁移 | `packages/db/migrations/035_public_estimator_and_anonymous_drafts.sql` | 新增 `anonymous_estimate_drafts`（仅存 SHA-256 `token_hash` 与 `session_binding_hash`、严禁明文令牌与 PII 列、限定相对 `source_route`、强制 `status` 与 `claimed` 约束及过期/会话索引） |
| 统一价格内核复用 | `packages/core/pricing-engine.ts` | 仅导出既有的 `loadCatalogPricingContext`、`applyPricingBookTranslations`、`resolveCurrentEffectiveVersion`（零公式篡改与零语义偏移） |
| 免登录估价与匿名草稿领域核心 | `packages/core/public-estimator.ts` | 严格 `.strict()` Zod 入参校验（拒收篡改 `total_cents` / `unit_cents` / `org_id` / `golden_sample_ids` / 负数 / 浮点）、有界内存频控（`429 RATE_LIMITED`）、`calculatePublicMultiGroupEstimate` 多服务组单核汇总（单组与 `/pricing/quote` 逐分一致、§97.2 混合组、按配置 `basic`/`standard`/`custom`、百分比向上取整、M01 去重、M02 加测点、无自动满减、零 `L1–L5`/内部成本泄漏、零写正式订单/账单/付款、检后运费 `estimated_later`、不可售/无价格表/人工报价/沙盒诚实状态）、`create/get/update/deleteAnonymousEstimateDraft`（`qcw_browser` 会话绑定隔离 `404`、版本漂移重算标注、过期保留 `recoverable_input` 且禁止 `PUT` `409`、撤销 `410`）及 `buildSafeEstimatorNextPath` 开放重定向白名单保护 |
| API 路由挂载 | `packages/core/http.ts` | 新增 5 个端点：`POST /public/estimate`（只读零写库）、`POST /public/estimate-drafts`、`GET/PUT/DELETE /public/estimate-drafts/:token`（带 `private, no-store`、`referrer-policy: no-referrer`、`x-robots-tag: noindex, nofollow` 与认证用户/同源 CSRF 双模式校验） |
| 官网模块化估价前端 | `app/public-estimator.tsx`、`app/public-site.tsx`、`app/marketing.css` | 新增双语 `<PublicModularEstimator />` 并替换 `/pricing`（`PublicPricing`）旧前端手写算价器；支持 Quick / Advanced 共享状态切换、标准目录品类分组选配（不暴露 `L1–L5`）、逐组增删复制与误删撤销、兼容模块批量应用、百分比/件数抽检覆盖、防并发乱序覆盖（`AbortController` + 单调 `requestSeqRef`）、`qcw_csrf` 携带、`localStorage` 仅存非敏指针 + 匿名草稿保存/更新/清除/过期恢复/改价提醒及安全跳转入口 |
| 集成测试与脚本注册 | `tests/pkg5-wave28-public-estimator.test.mts`、`package.json` | 覆盖单核同源对齐（含 §97.2 混合多组、预设与覆盖率）、安全反篡改/认证 CSRF 校验/零正式写库/零 `L1–L5` 泄漏、匿名草稿会绑隔离/版本漂移/过期恢复/撤销及 `429` 限流 |

---

## 2. 隔离迁移与工程门禁验证

1. **Pre-`035` 隔离备份恢复演练**（`qcw_t201_pre` → `qcw_t201_restore`，34 个既有迁移）：
   - `ok: true`、`git_sha: 0e2b6c7f464fc706bfcbcbb33c4c94609cddc035`
   - `dump_bytes: 905643`
   - `dump_sha256: 475db3a127db6a0d095dde6382f49cb39d3ede18ca6f14238f9fc0cbda88145c`
   - `manifest_sha256: 9d753b43cb8e538ed2e0ed14e11f7f2dd9a37a7ff565e53ce13983c1fbb06aed`
   - `rpo_seconds: 0`, `rto_ms: 806`, `corrupt_backup_rejected: true`
2. **空库全量迁移与关系用例复验**（`qcw_t201_empty`）：
   - 执行 `001_initial.sql` – `035_public_estimator_and_anonymous_drafts.sql` 全部成功。
   - 执行 `psql -v ON_ERROR_STOP=1 -f docs/contracts/verify.sql` 通过（`BEGIN / DO / ROLLBACK`）。
3. **整改终版全量验证门禁**：
   - `npm run check` (`tsc --noEmit`)：0 errors
   - `npm run check:i18n`：`104 fixed keys (en-US/zh-CN complete, 0 placeholder mismatches, 16 SEO routes paired)`
   - `python3 docs/contracts/check.py`：`264 tasks (174 historical + 90 active), E1–E654, 121 pages, 147 implementation cases, 82 AT groups, 67 production gates, 51 transaction operations`（0 错）
   - `python3 tests/contract-check.test.py`：`Ran 16 tests OK`
   - `npm run test:integration`（`TEST_DATABASE_URL=postgres://jianouyang@127.0.0.1:5432/qcw_test`）：**`tests 224, pass 224, fail 0, skipped 0`**
   - `QCW_DEMO=0 npx next build`：Next.js `16.4.5` (Turbopack) 构建成功
4. **受保护契约检查**：
   - `001`–`034` 已应用迁移、`docs/contracts/*` 与 `67` 项 `L04` 正式门禁零改动。

---

## 3. 独立只读审计记录

| 轮次 | Reviewer Conversation ID | 结论 | 核验摘要 |
|---|---|---|---|
| 初审 | `bf9bbd5a-30a5-4531-aaa1-e87df025a23c` | `FAIL` | 0 P0 / 1 P1 / 1 P2 / 2 Nits（已登录用户缺失 `x-csrf-token`、`custom` 切回 `standard` 预设未清空旧模块及空适配列表判断、分项币种格式化、`PUT` 错误回退边界） |
| **复审** | **`d93ec710-b8f6-47d7-a1f9-a6d6869dab8b`** | **`VERDICT: PASS`** | **0 P0 / 0 P1 / 0 P2 / 0 Nits** — 全量确认 `csrfHeaders()` 与认证测试、`resolvePresetModules` + 客户端重置、`fmtCurrency`、`PUT` 严格状态码边界及全套隔离/安全不变量闭环 |

---

## 4. 后续衔接边界

- 已登录账号认领、购物车合并/替换冲突确认及多标签幂等签收由 `TASK-201B` 承接。
- 当前全部公开估价基于沙盒/隔离排期（`business_approved = false`），`L04` 67 项正式门禁维持 `PRODUCTION_NOT_READY`。
