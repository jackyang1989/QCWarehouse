# PKG-4 Wave 22（TASK-195）完整商品目录与专业知识库独立核验报告

## 1. 任务与权威基线
- **任务编号**：`TASK-195`（`PKG-4 · E370–E375`）
- **关联页面与契约**：`PAGE-M09`（`/admin/catalog`）、`PAGE-M18`（`/admin/templates`）、`PAGE-M47`（`/admin/knowledge`）、`GET /catalog`、`GET /catalog/form-schema`、`PUT/POST /staff/admin/categories/{pack}/status`、`/staff/admin/knowledge/*`
- **权威依据**：
  - 冻结 `01–116` 权威执行指令：`§04`（6 大分组 54 类标准服装分类、复杂度与调整因素）、`§04.1`（标准商品目录：对客不泄露内部复杂度码）、`§05` & `§43.2`（`M01–M11` 完整检测模块、分层草稿建议价与明确边界声明）、`§19`（19 类标准缺陷 + 9 类返工，含平台责免费返工）、`§46.7`（中英专业术语及禁止误译保护）、`§51`（全量幂等初始化不覆盖人工修改）
  - `docs/开发规格.md` & `docs/开发排期与任务台账.md`（`L03 TASK-195`）

## 2. 交付清单
- **增量 SQL 迁移（仅追加，零修改 `001`–`028`）**：
  - `packages/db/migrations/029_product_catalog_and_knowledge_base.sql`：新增 `complexity_levels`、`inspection_modules`（含 `pricing_tiers`）、`catalog_product_types`、`knowledge_check_items`、`knowledge_garment_parts`、`knowledge_defect_types`、`knowledge_rework_types`、`knowledge_terminology_entries`、`knowledge_sops`、`knowledge_seed_runs`、`knowledge_revision_history`（支持 `seed_v1` 不可变基线快照）；全部 9 张治理表强制 DB 级非作者/非提审者独立审批 `CHECK` 约束及非开放类目禁止公开可售约束。
- **领域层与种子数据**：
  - `packages/core/knowledge-seed.ts`：`initializeKnowledgeBase`（`KNOWLEDGE_SEED_VERSION = "2026-11-apparel-v2"`）以严格幂等 `ON CONFLICT DO NOTHING` 初始化 `L1–L5`（`draft_unverified`）、`M01–M11`（含 `§05`/`§43.2` 分层草稿价与边界声明）、`§04` 全部 6 组 54 类服装 + 2 个默认关闭非服装占位（`bags_general`、`home_general`，`not_admitted` / `public_sellable=false`）、23 项检查项、24 个解剖部位、19 类非 AQL 缺陷、9 类返工（含 2 类平台责任免费返工）、16 对双语专业术语（32 条 `zh-CN`/`en-US`）与 6 份 SOP，并写入不可变 `seed_v1` 基线历史快照。
  - `packages/core/knowledge-base.ts`：完整保存草稿（每次编辑自动递增版本号不覆盖 `seed_v1`）、产品类型复制继承、提审、严格 `super_admin`/`reviewer` 非作者发布审批、退役停用（保留历史）、全字段 + `draft_unverified` 复位回滚、审计历史、快照导出、对客 `/catalog` & `/catalog/form-schema` 消费者（剔除内部 `L1–L5` 码、叠加已发布 `i18n_dynamic_translations`）、`compileKnowledgeTaskBlueprint` 任务编译消费者（强制类目 `ACTIVE`/能力准入校验、`M01` 防重复加收去重、`M05` 非破坏性称重与破坏性 GSM 授权/能力双守卫）。
- **HTTP、RBAC 与四端 UI 消费者接入**：
  - `packages/core/http.ts`、`packages/core/inspection.ts`（`taskDetail` 装配 `knowledge_blueprint`）、`packages/core/portal-routes.ts`、`packages/core/authz-contract.ts`、`app/chrome.tsx`、`app/portal.tsx`、`app/public-seo.ts`、`app/public-site.tsx`（`PublicCategories` 展示已发布 `knowledge_catalog`）、`app/staff.tsx`（`PAGE-M09` 与 `PAGE-M18` 入口衔接）、`app/admin-knowledge.tsx`（`PAGE-M47`：概览指标、幂等初始化、全类型新建/编辑、复制继承、批量提审/独立发布、公开可售开关、修订历史与回滚、`BilingualEntityPanel` 双语译文编辑、任务编译预览）。
- **集成测试**：
  - `tests/pkg4-wave22-catalog-knowledge-base.test.mts`（4 组端到端 DB 集成用例），已接入 `package.json` `test:integration`。

## 3. 隔离备份恢复演练与空库校验
- **Pre-029 隔离备份/恢复演练（`scripts/pre-migration-backup-restore.mjs`）**：
  - 源库：`127.0.0.1/qcw_t195_pre` -> 恢复目标：`127.0.0.1/qcw_t195_restore`（演练后均已 `DROP DATABASE` 清理）
  - 已验证迁移：`28` 个（`001`–`028`），不可变触发器 `5` 个
  - `dump_bytes = 732805`
  - `dump_sha256 = d5d932586108cf3df7eaef0a34ebb4722aa8e3b28fe164f861d5f623363c4c95`
  - `manifest_sha256 = 2b80c55d3ae556ef3107f2ba22dff57957d6448a56973f547d8f729416a952a8`
  - `rpo_seconds = 0`、`rto_ms = 584`、`corrupt_backup_rejected = true`、`all_assertions_passed = true`
- **001–029 空库与关系校验**：
  - 在空库 `qcw_t195_empty` 顺序执行 `001`–`029` 与 `docs/contracts/verify.sql`，退出码 `0`（验证后已删除临时库）。

## 4. 独立 Reviewer 初审、整改闭环与复审结论
- **独立只读 Reviewer 初审**：`25141848-cb77-40be-b0a4-3c94496c6321`（`VERDICT: FAIL` — 1 P0：`§04` 54 类名称与 `§05`/`§43.2` `M01–M11` 价格层级对齐；5 P1：`KNOWLEDGE_REVIEW_ROLES` 排除 `template_admin`、`seed_v1` 历史快照、全字段及 `draft_unverified` 回滚、`PAGE-M47` 完整交互与动态译文叠加、`compileKnowledgeTaskBlueprint` 准入与 `M05` GSM 分离；4 P2：`inspection.ts`/`public-site.tsx` 消费接入、`PUT /categories/{pack}/status` slug 解析、`reviewer` 侧栏可见性及测试覆盖扩展）。
- **整改后全量验证门禁结果（全部于末次代码修改后重跑）**：
  - `npm run check:i18n`：PASS（`104` 固定键，`16` SEO 路由对）
  - `npx tsc --noEmit`：PASS（`0` 错误）
  - `python3 docs/contracts/check.py`：PASS（`264` 任务 / `E1–E654` / `121` PAGE / `67` 门禁）
  - `python3 tests/contract-check.test.py`：PASS（`16/16`）
  - `TEST_DATABASE_URL="postgres://127.0.0.1:5432/qcw_test" DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run test:integration`：PASS（`202/202`，`0` 失败，`0` 跳过）
  - `QCW_DEMO=0 DATABASE_URL="postgres://127.0.0.1:5432/postgres" npm run build`：PASS（`Next.js 16.4.5`）
- **独立只读 Re-Audit Reviewer 复审**：`9331c43f-3192-4a07-aacb-8c716e96b1b6` 逐项复核 10 项整改全部关闭，签发 **`VERDICT: PASS`**。

## 5. 范围边界声明
- 已有已推迁移 `001`–`028` 与 `docs/contracts/` 契约文件未做任何修改。
- 全部初始价格与 `L1–L5`/`M01–M11` 费率严格保持 `draft_unverified` 草稿态；统一定价与营业批准由后续 `TASK-197` / `TASK-197B` 承接。
- 台账 `L04` 全部 67 项正式生产签收门禁严格保持 `PRODUCTION_NOT_READY`。
