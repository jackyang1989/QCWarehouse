# PKG-1 Wave 2–3｜五项核心领域契约证明 (`domain-contracts-verification`)

- **覆盖任务**：`TASK-191A`（AI 服务契约）、`TASK-194A`（消息工单与 Outbox 契约）、`TASK-229A`（统一应收事实契约）、`TASK-228A`（确认样基准与保管合同契约）、`TASK-238A`（可靠队列与隔离契约）。
- **签收边界**：均属于契约与负向防线先行，不提前签收任何 `L04` 生产门禁（67 项维持 `PRODUCTION_NOT_READY`）；`TASK-189A` 因需真机维持 `待认领 / 待核验/实施`。

---

## 五项先行契约与负向回归矩阵

| 任务 / 窗口 | 交付契约模块 | 核心不变量与负向验证覆盖 |
|---|---|---|
| `TASK-191A` (`E265–E267`) | [ai-contract.ts](../../../packages/core/ai-contract.ts) | 仅 `openai_official` + `openai_compatible`、9 个用途枚举、严格禁止 `payment_execute`/`business_db_write`/`file_write`/`device_control` 等非语言权限（`403 AI_BUSINESS_TOOL_FORBIDDEN`）、结构化 1:1 字段与占位符校验、原子预算预留、卡号/密钥外发过滤及 `cost_cents: 0` 人工兜底。 |
| `TASK-194A` (`E268–E270`) | [messaging-contract.ts](../../../packages/core/messaging-contract.ts) | 通知主记录 / 个人收件 / 分渠道投递分离；共享组织已读互不覆盖且不自动关闭待办；模板变量禁止 HTML 注入；WhatsApp 默认未核验/未授权拦截（`409 WHATSAPP_CHANNEL_UNVERIFIED`）；客服工单向客户严格剥离 `internal_note` 且原文不变。 |
| `TASK-229A` (`E271–E273`) | [receivables-contract.ts](../../../packages/core/receivables-contract.ts) | 独立应收义务禁止平台返工收费；合并支付严格要求同客户/同币种/同商户实例/有效未过期报价；到账须服务端验证且阻止并发双付；退款仅允许回流原商户实例且禁超付；出库放行核验实际应收与合法豁免，不信单订单状态。 |
| `TASK-228A` (`E274–E276`) | [golden-sample-contract.ts](../../../packages/core/golden-sample-contract.ts) | `candidate -> qa_approved -> sealed` 与 `active` 付费合同分离；建档/封存不等于已付可调用；QA 强制独立职责分离；新版本递增归档旧版而不改写历史基准哈希；原订单结案后存在有效保管合同时阻止关户。 |
| `TASK-238A` (`E277–E279`) | [queue-contract.ts](../../../packages/core/queue-contract.ts) | 复用既有 `outbox_events`/`worker.ts` 语义，5 级分池优先级防批翻阻塞支付通知；`leaseToken` 围栏防过期 Worker 并发写冲突；永久错误直接进 `exhausted` 死信；外部 `unknown_outcome` 禁止盲目重放直至对账或人工授权。 |

- **负向与边界测试入口**：[tests/pkg1-wave23-contracts.test.mts](../../../tests/pkg1-wave23-contracts.test.mts)（已纳入 `package.json` `test:pkg1-wave23` 及全量 `test:integration`）。
