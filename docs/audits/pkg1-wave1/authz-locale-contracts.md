# PKG-1 Wave 1｜TASK-180A & TASK-190A 先行契约证明 (`authz-locale-contracts`)

- **签收边界**：本阶段为 `TASK-180A`（统一鉴权及领域契约）与 `TASK-190A`（`en-US`/`zh-CN` Locale 契约先行）的契约与负向回归落地，不提前签收 `L04` 生产门禁（67 项维持 `PRODUCTION_NOT_READY`）；`TASK-189A` 因涉及 iPhone/Android/PC 真机硬件，保持 `待认领 / 待核验/实施`。

---

## 一、`TASK-180A` 统一鉴权、作用域与领域契约（`E259–E261`、`§29/30/87`、`T40/T42`）

| 能力项 | 实现模块与入口 | 核心不变量与防绕过机制 |
|---|---|---|
| 1. 权限与动作目录 | [packages/core/authz-contract.ts](../../../packages/core/authz-contract.ts) (`ACTION_CATALOG`, `STAFF_ROLES`) | 以服务端受控 `AuthzAction` 目录映射 12 个业务域与 8 种预设角色，禁止任意字符串权限输入。 |
| 2. 导航与直链同源（修复 `LIF-004` 漂移） | [packages/core/authz-contract.ts](../../../packages/core/authz-contract.ts) (`ADMIN_DIRECT_ROUTE_ROLES`) + [packages/core/portal-routes.ts](../../../packages/core/portal-routes.ts) (`canOpenStaffPage`) | 修复原先 `template_admin` 可直链打开 `/admin/users`、`/admin/legal`、`/admin/config`、`/admin/shipping-rates`、`/admin/catalog`、`/admin/templates` 等高危入口的权限漂移；保留 `adminTabs` 与 `/admin/settings` 现有契约。 |
| 3. 五段式计算与多角色不扩域 | `evaluateAuthorization` (`authz-contract.ts`) | 严格按 `账号/会话/auth_version -> 动作目录 -> 仓库/任务/客户作用域交集 -> 能力门槛 -> 显式拒绝与职责分离` 评估；多角色合并绝不扩张未授权仓库、任务或客户作用域。 |
| 4. 字段脱敏、租户与事件/生命周期 | `redactFieldsForActor`、`assertCustomerTenantOwnership`、`assertLifecycleTransition`、`buildDomainEventEnvelope`、`assertIdempotencyContract` | 按字段敏感度服务端裁剪成本/利润/联系方式；`T42` 同键异体返回 `409 IDEMPOTENCY_CONFLICT`；状态变迁强制校验乐观 `revision`。 |
| 5. Owner Bootstrap 例外与最后 Owner 保护 | `authorizeOwnerBootstrap`、`assertLastOwnerPreserved` + [packages/core/auth.ts](../../../packages/core/auth.ts) (`staffUpdateUserStatus`, `staffUpdateUserRoles`) | 仅在活跃 `super_admin === 0` 且匹配服务端高强度 bootstrap 凭据时开放一次；存在活跃 `super_admin` 后永久关闭（`OWNER_BOOTSTRAP_CLOSED`）；禁止停用或降级最后一个活跃 `super_admin`（`409 LAST_OWNER_PROTECTED`）。 |

---

## 二、`TASK-190A` Locale 契约先行（`E262–E264`、`§53.1–53.5`）

| 能力项 | 实现模块与入口 | 核心不变量与隔离设计 |
|---|---|---|
| 1. BCP47 注册表与第三 locale 隔离扩展 | [packages/core/locale-contract.ts](../../../packages/core/locale-contract.ts) (`LOCALE_REGISTRY`, `ENABLED_LOCALES`, `FUTURE_EXTENSIBLE_LOCALES`, `assertEnabledLocale`) | 仅启用 `en-US` 与 `zh-CN`；`fr-FR`、`es-ES` 已隔离注册为 `enabled: false, selectable: false`，任何选择/发布未启用第 3 locale 直接拒绝 `422 LOCALE_NOT_ENABLED`。提供 `toLegacyDbLocale` 兼容现有数据库枚举。 |
| 2. 固定与动态资源分类、不可译事实守卫 | `validateFixedResourceBundle`、`createDynamicTranslationDraft`、`markTranslationStaleIfSourceChanged`、`freezeHistoricalLocaleSnapshot`、`assertBusinessFactsPreserved` | 固定资源检查缺失键与占位符集合；动态翻译按 `(entityType, entityId, fieldKey, locale, sourceRevision)` 与 `sourceHash` 追踪状态；源变更标 `stale`，已封存历史快照永不被覆盖；原始地址/SKU/运单/币种/金额禁止随切换语言被改写。 |
| 3. 三档独立偏好、员工中文默认与 SSR/OAuth 兼容 | `resolveAccountLocalePreferences`、`resolveLocalizedPublicPath`、`localizePublicPath`、`buildSsrLocaleMetadata`、`buildLocaleSafeOAuthReturnPath` | `uiLocale`、`notificationLocale`、`reportLocale` 严格分离（切换界面不改报告/通知偏好）；内部端默认 `zh-CN` 且不被 `Accept-Language: en-US` 强制切换；输出 `htmlLang`/`canonical`/`hreflang` 元数据，并与 `portal-routes.ts` 白名单共同保持 OAuth 回跳与开放重定向防护。 |

---

## 三、双测试验证矩阵

- 契约与负向单测：[tests/pkg1-wave1-contracts.test.mts](../../../tests/pkg1-wave1-contracts.test.mts)（`6/6` 通过）。
- 隔离 PostgreSQL 真实事务测试：[tests/workflow.test.mts](../../../tests/workflow.test.mts)（新增实库用例验证 `409 LAST_OWNER_PROTECTED`、`403` 越权、`OWNER_BOOTSTRAP_CLOSED`、SQL 级 `T42` 幂等与 `/admin/users` 漂移关闭，随全量 `npm run test:integration` 运行）。
