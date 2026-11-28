# PKG-4 Wave 23（TASK-196 · 动态测量知识库及编辑器）实施与独立验收记录

- **任务编号**: `TASK-196` / `PKG-4 · E379–E384`
- **对应页面与规格**: `PAGE-M23`（`/admin/measurement-templates`）、`POMTemplate.publish`、`§14`（17+ 动态服装 SVG 模板族、非几何重量/GSM 隔离）、`§41.3–41.4`、`§53.9`、`T28`、`T127`、`R09`、`G07`
- **当前状态**: `待验收`（所有 67 项 `L04` 生产门禁保持 `PRODUCTION_NOT_READY`）

## 1. 交付产物

1. **增量数据库迁移**：[`packages/db/migrations/030_dynamic_measurement_templates.sql`](../../../packages/db/migrations/030_dynamic_measurement_templates.sql)
   - `measurement_camera_presets`、`measurement_templates`（含 `measurement_templates_no_self_parent`、`measurement_templates_sod_check`）、`measurement_template_versions`（含 `measurement_template_versions_sod_check` 及 PL/pgSQL 不可变触发器 `freeze_measurement_template_version`）、`measurement_template_seed_runs`、`inspection_tasks.measurement_template_version_id` 可空外键。
2. **双端同源 SVG 安全清洗器**：
   - [`packages/core/svg-sanitizer-pure.ts`](../../../packages/core/svg-sanitizer-pure.ts)（无 Node 依赖的浏览器/服务端唯一清洗权威：200 KB UTF-8 上限、单 `<svg viewBox="0 0 W H">`、严格矢量标签白名单、拒绝 `<!DOCTYPE`/`<!ENTITY`/`<![CDATA[`、`<script>`、`<foreignObject>`、`style=`/`<style>`、`<image>`、`<use>`、`<animate*>`、`on*=`、`javascript:`/`vbscript:`/`data:`、外部 `href`/`xlink:href`/`src`/`url()` 及 HTML 实体/CSS 十六进制转义绕过）
   - [`packages/core/svg-sanitizer.ts`](../../../packages/core/svg-sanitizer.ts)（服务端 `422 UNSAFE_SVG_CONTENT` 包装）
3. **领域服务与 23 类全量幂等初始化**：
   - [`packages/core/measurement-templates.ts`](../../../packages/core/measurement-templates.ts)：草稿校验、父子继承循环与深度检查、差异点位覆盖合并（`disabled_point_ids`/`overridden_points`/`added_points`）、唯一点位/标号/视图校验（`T28`）、非几何重量/GSM 强制隔离（`NON_GEOMETRIC_POINT_FORBIDDEN`）、独立 `reviewer`/`super_admin` SoD 发布不可变快照、批发布原子回滚、退役与退役重编辑/回滚不越权复燃隔离、按版本 `source_hash` 保护的 `i18n_dynamic_translations` 仅文字叠加（不改几何坐标）。
   - [`packages/core/measurement-seed.ts`](../../../packages/core/measurement-seed.ts)：`MEASUREMENT_SEED_VERSION = "2026-11-pom-23-v1"`，幂等初始化 6 组标准化摄影机位预设 + 23 类独立前后视图服装矢量模板（覆盖 `§04` 全部 54 个服装品类，含 `briefs_underwear` 独立内裤点位、`two_piece_tracksuit_set` 运动套装双联图、`kids_toddler_apparel` 童婴及 `special_craft_material_apparel` 重工特材）。
4. **消费端与 `PAGE-M23` 可视化编辑器**：
   - [`packages/core/knowledge-base.ts`](../../../packages/core/knowledge-base.ts)（`getCatalogFormSchema`、`compileKnowledgeTaskBlueprint` 暴露最新已发布 `measurement_template`）
   - [`packages/core/inspection.ts`](../../../packages/core/inspection.ts)（`startTask` 原子冻结 `inspection_tasks.measurement_template_version_id`；`taskDetail` 按冻结版本返回 `measurement_diagram`，实现 `T127`）
   - [`packages/core/http.ts`](../../../packages/core/http.ts)、[`packages/core/portal-routes.ts`](../../../packages/core/portal-routes.ts)、[`packages/core/authz-contract.ts`](../../../packages/core/authz-contract.ts)、[`app/admin-measurement-templates.tsx`](../../../app/admin-measurement-templates.tsx)（图面起点/终点/标签拾取、可视化新增/编辑/禁用点位与绑定、子模板 `point_overrides` 继承保留、`.svg` 清洗预览上传、`§41.4` 颜色+图标+文字状态预览、双语翻译面板、机位预设管理及不可变版本回滚）。

## 2. 验证证据

- **迁移前隔离备份恢复演练**（基于 29 个迁移）：`ok=true`，`git_sha=3b1ea334a063b5ca6260ad46c8504f7b2628be3e`，`dump_bytes=784699`，`dump_sha256=bbe5ae1ef0a34df20c1ac28399a73a0a77233d3dd10ae35aa3ac6dc5277b8124`，`manifest_sha256=d5e5534c3e0d0e7d8fd5e333664ebe305630065056c8ae5eb65cbcec1b4bcfce`，`rpo_seconds=0`，`rto_ms=619`，`corrupt_backup_rejected=true`。
- **空库关系校验**：临时空库 `qcw_t196_empty` 顺跑 `001`–`030` 全部迁移及 `docs/contracts/verify.sql`，退出码 `0`。
- **Wave 23 专项测试** [`tests/pkg4-wave23-measurement-templates.test.mts`](../../../tests/pkg4-wave23-measurement-templates.test.mts)：`4/4` 通过（含 23 家族与 54/54 服装品类全覆盖、13 种 SVG XSS 实体/CSS/`<!DOCTYPE`/`style=`/`<use>`/`<animate>`/`data:` 绕过拒绝、`T28` 唯一性、`pom_garment_weight` 拒绝、继承覆盖与循环检查、SoD 批发布、不可变 DB 触发器、`T127` 开检锁版本、退役重编辑/回滚隔离、冻结任务 `source_hash` 防漂移与 `PAGE-M23` RBAC）。
- **全库验证门禁（最终代码改动后重跑全绿）**：
  - `npm run check:i18n`：104 固定键、`16` SEO 路由通过
  - `npx tsc --noEmit`：0 错误
  - `python3 docs/contracts/check.py`：264 任务（90 活跃）、67 门禁通过
  - `python3 tests/contract-check.test.py`：16/16 通过
  - `npm run test:integration`（`qcw_test`）：**206/206 通过**（0 失败，0 跳过）
  - `QCW_DEMO=0 next build`：Next.js 16.4.5 生产构建退出码 `0`

## 3. 独立只读 Reviewer 审计闭环

- 初审 Reviewer `237b80f1-0748-4b2f-9aa0-c78965c6cb41`：`VERDICT: FAIL`（发现 1 P0、3 P1、5 P2、4 Nits）→ 已全量整改。
- 复审 Reviewer `417062f6-fa0b-4025-aa8d-fe69ca6cc48f`：`VERDICT: FAIL`（确认 P0 #1、P1 #2/#3 及 4 项 P2 通过，补充发现退役模板草稿覆盖未清 `latest_published_version_id` 与逗号输入框吞字符 2 项）→ 已修复并补测试重跑全量门禁。
- 终审 Reviewer `f0666045-3b9f-4e5f-ae5d-1fdfe88276d4`：**`VERDICT: PASS`**。
