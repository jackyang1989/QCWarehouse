# PKG-1 Wave 5–6｜邮件模板/Outbox（TASK-194B）与经营主体/商户实例（TASK-178）验证证据 (`email-entities-verification`)

- **签收边界**：本阶段签署隔离环境契约、增量 SQL 迁移 `014`、软件能力与回归测试；**真实生产邮件域名/送达、双 OIDC 生产登录回调及 Stripe 真实账号核验保持待外部实际联调，所有 67 项 `L04` 生产门禁保持 `PRODUCTION_NOT_READY`**。

---

## 一、`014` 迁移前全库备份恢复演练（`TASK-177` 规程）

- **来源隔离库**：`qcw_t178_pre`（完整应用 `001`–`013` 后于 `61a5bc6` 执行 `SOURCE_DATABASE_URL="postgres:///qcw_t178_pre?host=/tmp" QCW_DEMO=0 npm run ops:backup-verify`）：
  - `dump_bytes = 322,552`
  - `dump_sha256 = 9d184f45138e5d9754a50643c0fe92f6b5c352e87af3256639144119b62b3fa0`
  - `manifest_sha256 = 5b313d0c47b83a1deeaa934c7cf4ef012e4ccffd3fee6a4ba1b7c488d9e7e3bf`
  - `migrations_verified = 13`、`immutable_triggers_verified = 5`、`corrupt_backup_rejected = true`、`rpo_seconds = 0`、`rto_ms = 224`、`all_assertions_passed = true`

---

## 二、增量迁移 `014` 与核心实现清单

| 任务 | 修改/新增资产 | 核心实现与保护不变量 |
|---|---|---|
| `014` 迁移 | [014_owner_legal_entities_merchants_and_email_templates.sql](../../../packages/db/migrations/014_owner_legal_entities_merchants_and_email_templates.sql) | 仅追加、零改动 `001`–`013`：新建 `notification_templates`（预置 8 类业务 `en-US`/`zh-CN` v1 已发布模板 + 唯一已发布局部索引）、`email_deliveries` 扩展列（`locale`, `template_version`, `delivery_evidence_note`）、`outbox_events` 扩展列（`pool`, `lease_owner`, `lease_token`, `lease_expires_at`, `outcome_state`）、`legal_entities`（不虚构 BR）、`merchant_instances`（`accepting_new`/`legacy_only`/`paused`/`revoked`/`retired`）、`owner_bootstrap_audit`。 |
| `TASK-194B` (`E280–E282`) | [packages/core/email.ts](../../../packages/core/email.ts) + [packages/core/http.ts](../../../packages/core/http.ts) | 完整保留既有 Resend/Postmark、`resend-settings.ts` 与 `012`/`013`；新增双语模板草稿、变量/XSS 检查（`renderLockedTemplateSnapshot`）、独立职责分离+MFA 发布（禁止自审 `403 SELF_REVIEW_FORBIDDEN`）、`deliverEmailOnce` 模板版本号/locale 落盘及 `emailChannelReadiness`（明确区分配置/连接测试与真实送达）。 |
| `TASK-178` (`E283–E286`) | [packages/core/legal-merchants.ts](../../../packages/core/legal-merchants.ts) + [packages/core/http.ts](../../../packages/core/http.ts) | 保留双 OIDC/OTP/`auth_version` 与既有 Stripe；支持个人经营（免虚构 BR）与公司主体版本化切换/退役保护；支持多商户实例 `accepting_new` / `legacy_only` 切换不损历史；提供 `§108.4` `evaluateOpeningReadinessMatrix` 必需/条件/可选矩阵。 |

- **集成回归套件**：[tests/pkg1-wave56-email-entities.test.mts](../../../tests/pkg1-wave56-email-entities.test.mts)（已纳入 `package.json` `test:integration`）。
