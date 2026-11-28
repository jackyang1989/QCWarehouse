# PKG-4 Wave 24（TASK-197 · 统一定价与审批）实施与独立验收记录

- **任务编号**: `TASK-197` / `PKG-4 · E385–E389`
- **对应页面与规格**: `PAGE-M22`（`/admin/pricing`）、`§05–§09`（21 种合法计费单位、内部复杂度基价 `L1–L5`、模块化项 `M01–M11` 依赖/互斥、`Compare` / `Golden` 专项计价、默认关闭自动批量折扣）、`§43.1–§43.2`（四组强制算例：`$17` / `$405` / `$122` / `$135`）、`T01`（`PRICE_CHANGED`）、`T02`、`T26`（RBAC）、`T30`（历史锁价隔离）、`T126`、`PR-01`、`PR-02`、`AT-61`、`G01`、`G07`
- **当前状态**: `待验收`（所有已发布测试版本均标记 `publication_scope='sandbox_acceptance'` 且 `business_approved=false`，真实生产售卖须完成 `TASK-197B` 商业签收及全部 `L04` 门禁；`L04` 67 项生产门禁保持 `PRODUCTION_NOT_READY`）

## 1. 交付产物

1. **增量数据库迁移**：[`packages/db/migrations/031_unified_pricing_and_approval.sql`](../../../packages/db/migrations/031_unified_pricing_and_approval.sql)
   - `pricing_books`、`pricing_book_versions`（含非作者/非提审者 DB 级三权分立 `pricing_book_versions_sod_check` 约束与不可变触发器 `freeze_pricing_book_version` 锁定 `effective_snapshot`/`content_hash`/`effective_from`/`published_at`/审阅人信息及禁止 `DELETE` 或 `RETIRED -> PUBLISHED`）、`pricing_quotes`（服务端正式/补充/模拟报价存档与 `locked` 锁价）、`pricing_seed_runs`。
2. **领域计价引擎与 §43.2 幂等初始化**：
   - [`packages/core/pricing-seed.ts`](../../../packages/core/pricing-seed.ts)：`PRICING_SEED_VERSION = "2026-11-pricing-v1"`，幂等初始化 `apparel_modular_usd`（`L1–L5` `$5/$8/$12/$18`/manual、`M01–M11` 含 `M02:points_3` `$8` / `points_5` `$12` / `points_8` `$18` / `extra_point` `$3`、`M06:trim_item` `$5/pc`、`compare` `$25/$35/+$12`、`golden` `$15/$10/$8`、`auto_volume_discount_enabled=false`、`sandbox_acceptance`），公共文案无内部代码泄漏。
   - [`packages/core/pricing-engine.ts`](../../../packages/core/pricing-engine.ts)：
     - 纯函数同源计算 `calculateUnifiedQuote`（按 `customer_overrides` > `product_type_overrides` > `complexity_rates` 单源定基价不重计费、`per_set` 套装不重计、百分比按 `ceil`/`round`/`floor` 取整并透明披露、`M02` 基础档与 `M02:extra_point` 可叠加但同级冲突报错、`per_photo`/`per_measurement_point`/`per_carton` 等非逐件单位不受 `base_qty` 限制、`archive_new_golden_samples` 全服务支持、`ORDER_FIXED_FEE` 与透明 `MINIMUM_ORDER_TOPUP`、显式优惠券互斥及工时依据批量折扣开关、内部 `L1–L5` 对客户端/匿名隐藏为 `BASE_INSPECTION`/`complexity_tier`）。
     - 严格安全守卫：`POST /pricing/quote` 拒绝匿名/客户伪造 `org_id`、`allow_unpublished_catalog_in_sim` 或 `draft_book_id`（`403 FORBIDDEN`），员工模拟受限于 `PRICING_READ_ROLES`、正式报价受限于 `PRICING_EDIT_ROLES + support`（拒绝 `receiver`/`inspector`/`warehouse_admin`）。
     - 治理、三权分立与并发状态机：`savePricingBookDraft`（含 DFS 模块依赖成环检测 `MODULE_DEPENDENCY_CYCLE` 与传递排他冲突检测）、`clonePricingBook`、`batchAdjustPricingBook`（预演差异、拒绝 `retired` 与非法负价、零差异不降级已发布状态、支持 `service_rules`/`product_type_overrides`）、`submitPricingBook`、`publishPricingBook`、`revokeScheduledPricingBookVersion`（未到 `effective_from` 排期可撤销且不误伤在役版本 `v1`）、`retirePricingBook`（同步置 `pricing_book_versions.state='RETIRED'`）、`rollbackPricingBook`、`exportPricingBookSnapshot`、`verifyAndLockUnifiedQuote`（通过 `VerifyLockResult` 在提交 `expired`/`superseded` 状态后于路由层返回 `409 QUOTE_EXPIRED`/`409 PRICE_CHANGED`，满足 `T01`/`T30`）。
3. **路由、权限、`PAGE-M22` 后台与公开报价视图**：
   - [`packages/core/http.ts`](../../../packages/core/http.ts)（公开/客户 `/pricing/quote`、`/pricing/quotes/:id`、`/pricing/quotes/:id/verify-lock` 及后台 `/staff/admin/pricing/*` 与 `/versions/:ver/revoke`）、[`packages/core/portal-routes.ts`](../../../packages/core/portal-routes.ts)、[`packages/core/authz-contract.ts`](../../../packages/core/authz-contract.ts)（注册 `PAGE-M22 /admin/pricing` 并严格保持 `staffTabs("admin", ["finance"]) === ["/admin", "/admin/finance"]` 既有契约）。
   - [`app/admin-pricing.tsx`](../../../app/admin-pricing.tsx)（按翻译权限角色精准门控 `BilingualEntityPanel` 以保护 Wave 17 `finance` 权限边界；提供 `+ 新建定价簿`、快照导出、币种与取整、定时 `effective_from`、基础信息、`L1–L5`、`M01–M11` `requires`/`mutually_exclusive_with` 矩阵、Compare/Golden/风险限额、品类覆盖/优惠券/阶梯折扣可视化编辑、批量调价预演、§43.2 四组算例核算、沙盒模拟、历史撤销排期与版本差异对比）。
   - [`app/public-site.tsx`](../../../app/public-site.tsx)（`PublicPricing` 币种感知格式化、未商业审批沙盒提醒、`disclosures[]` 透明披露、清除硬编码回退价格）。

## 2. 验证证据

- **迁移前隔离备份恢复演练**（基于 30 个迁移）：`ok=true`，`git_sha=0a98e3810274374cd377883b2925a41259782271`，`dump_bytes=803482`，`dump_sha256=76d83313812e54be54baf458d2b3fa9436cffc239a1a0fed519d2ae7bbb78fc1`，`manifest_sha256=db563f80d0a5f5d94e6f9867cf47dd4ff967b7bafb60060eb55952f295b8b9ca`，`rpo_seconds=0`，`rto_ms=667`，`corrupt_backup_rejected=true`。
- **空库关系校验**：临时空库 `qcw_t197_empty` 顺跑 `001`–`031` 全部迁移及 [`docs/contracts/verify.sql`](../../contracts/verify.sql)，退出码 `0`。
- **Wave 24 专项测试** [`tests/pkg4-wave24-unified-pricing.test.mts`](../../../tests/pkg4-wave24-unified-pricing.test.mts)：`5/5` 通过（含幂等 Seed、SoD 审批与不可变触发器、`§43.2` 四组算例精确 `$17/$405/$122/$135` 逐项验证、`T01 PRICE_CHANGED`、`T30` 历史锁价保护、P0 跨租户/未开放类目绕过/员工角色隔离拦截、非员工隐藏 `L1–L5`、`M02:points_3`/`extra_points`/`per_photo > base_qty`/`M06:trim_item`/全服务 `archive_new_golden_samples`、定基价优先级、定时排期不覆盖在役版本与撤销排期、`409 QUOTE_EXPIRED`/`PRICE_CHANGED` DB 持久化、`MODULE_DEPENDENCY_CYCLE`、`percent_off <= 100`、跨客户 404、`T26` 与 `staffTabs` 兼容）。
- **全库验证门禁（最终代码改动后重跑全绿）**：
  - `npm run check:i18n`：104 固定键、16 SEO 路由通过
  - `npx tsc --noEmit`：0 错误
  - `python3 docs/contracts/check.py`：264 任务（90 活跃）、67 门禁通过
  - `python3 tests/contract-check.test.py`：16/16 通过
  - `npm run test:integration`（`qcw_test`）：**211/211 通过**（0 失败，0 跳过）
  - `QCW_DEMO=0 next build`：Next.js 16.4.5 生产构建退出码 `0`

## 3. 独立只读 Reviewer 审计闭环

- 初审 Reviewer `2107fe3d-89e4-4843-bd06-a7299ac305ec`：`VERDICT: FAIL`（2 P0、6 P1、7 P2、4 Nits）→ 已全量整改闭环。
- 复审 Reviewer `08664439-bb83-46e3-88b4-19bddedd8586`：**`VERDICT: PASS`**（确认全部 15 项修复且 `workflow.test.mts` `77/77`、`pkg3-wave17` `6/6`、`pkg4-wave22/23` `8/8` 及 `pkg4-wave24` `5/5` 全数通过）。
