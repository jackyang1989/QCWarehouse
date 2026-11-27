# TASK-175｜访客获客与匿名转化全链路追踪矩阵 (`visitor-conversion-matrix`)

- **冻结基准 Commit**：`e386eaeb87c8737c586ee0f4d368887808434a07`
- **核查目的**：依据 `01-116` 第 95.1 节（`WEB-04`, `WEB-13`）及 `RUX01`，从真实源码追踪访客从官网浏览、匿名估价、OAuth/OTP 注册登录、草稿认领、人工询价转化到订单付款的每一步状态流转与断链风险。

---

## 一、主转化漏斗与当前源码断链点

| 转化链路 | 步骤与入口路由 | 当前实际源码实现 (`file:line`) | 上下文保持能力 | 实证断链与缺陷 | 目标修复任务 |
|---|---|---|---|---|---|
| **漏斗 A**：官网浏览 -> 报价器 -> 注册/登录 -> `/orders/new` | 1. `/` 或 `/pricing` -> 点击 `Continue With This Package`<br>2. 跳 `/orders/new?offer={id}`<br>3. 未登录重定向 `/login?next=/orders/new?...`<br>4. OIDC/OTP 登录后跳 `/onboarding` 或回跳 `next` | - 跳转生成：[public-site.tsx:2015-2018](../../../app/public-site.tsx#L2015-L2018)<br>- 登录保护与回跳：[app/[...page]/page.tsx:55-75](../../../app/%5B...page%5D/page.tsx#L55-L75), [portal-routes.ts:193-198, 231-234](../../../packages/core/portal-routes.ts#L193-L234)<br>- 进入下单页初始化：[customer.tsx:732-777](../../../app/customer.tsx#L732-L777)<br>- 本地暂存恢复：[draft-recovery.ts:132-163](../../../app/draft-recovery.ts#L132-L163) | - `next` 白名单检查（`customerDestination` 防开放重定向）**已有效实现**；<br>- 登录后 tab 内编辑草稿存于 `sessionStorage`（`qcw.inspection-draft.{customerId}.new:{offer}`） | 1. **`WEB-04` 匿名配置全丢失**：`/pricing` 仅传 `?offer=`，未保存数量、模块选择、多品类服务组或对比参数；`customer.tsx:766` 直接强制重置数量为 `rules.minimum`。<br>2. **无服务端匿名高熵令牌认领机制**：跨设备、清 Cookie 或第三方 OAuth 重定向后无法从服务端恢复匿名估价购物车（`Draft.claim` 缺失）。<br>3. **中英切换后丢失语言前缀风险**（`TASK-190` 待补）。 | TASK-201, TASK-201B, TASK-204 |
| **漏斗 B**：超限/定制询价 -> 人工报价 -> 认领并下单付款 | 1. `/pricing` qty>300 -> `/contact?topic=quote&qty={n}`<br>2. `POST /public/inquiries` 建工单<br>3. 客服在 `/admin/tickets` 查看处理 | - CTA：[public-site.tsx:2011](../../../app/public-site.tsx#L2011)<br>- 询价表单：[public-inquiry.tsx:18-177](../../../app/public-inquiry.tsx#L18-L177)<br>- 工单建立：[tickets.ts](../../../packages/core/tickets.ts) (`createPublicInquiry`)<br>- `resolve` 限制：L284 提示客服离线联系邮箱并记录内部备注 | `topic`, `qty`, `sample_count` 可通过 URL 传到 `/contact` 并写入工单详情 | 1. **`WEB-13` 缺少在线结构化人工报价认领转化**：客服仅能在工单回复或写 `internal_note`，**不存在从公开询价单生成结构化带价报价单 -> 访客登录后凭验证码/认领链一键接受（`Inquiry.accept / quote.claim`）并直接转正支付的在线闭环**。 | TASK-202B, TASK-232 |
| **漏斗 C**：样例报告 / 分类目录 -> 直接下单或定制咨询 | 1. `/report-guide` 或 `/categories`<br>2. 点击模板体验下单或 Restricted Items 咨询 | - `/categories`: [public-site.tsx:1209, 1256](../../../app/public-site.tsx#L1209)<br>- `/report-guide`: [report-guide.tsx](../../../app/report-guide.tsx)<br>- `/orders/new` 解析 `offer`: [customer.tsx:758-776](../../../app/customer.tsx#L758-L776) | 若目标 `offer` 已停用或未开放在线购买，L775 显示友好错误不崩溃 | 当 `/categories` 展示未接入在线能力的品类或未来扩展类目时，点击只能人工咨询；缺统一按“服务×品类×能力发布状态”动态路由控制。 | TASK-195, TASK-200, TASK-202 |
| **漏斗 D**：访客注册同意 -> 自动发码 -> 下单支付 | 1. `/login` (Google/Microsoft/Email OTP)<br>2. `/onboarding` 勾选 `terms` & `privacy`<br>3. `POST /auth/registration/complete`<br>4. 颁发永久收件码与默认仓址 | - 注册与并发领码锁：[auth.ts:290-335](../../../packages/core/auth.ts#L290-L335)<br>- 同意与会话签名：[http.ts:1598-1601](../../../packages/core/http.ts#L1598-L1601)<br>- 测试覆盖：125 项测试包含并行领码、重复邮箱隔离、PKCE 状态校验 | 并发安全发码、条款同意持久化与双 OIDC 防同邮箱静默合并已实现且通过测试 | 1. 注册若由无默认公仓或草稿期政策变化引发，需同步通知客户端与报价重确认。<br>2. 无匿名估价单价格过期或调价时重确认阻断流程。 | TASK-178, TASK-201B, TASK-207 |
| **漏斗 E**：公开分享报告查看 | `/r/[token]` -> `GET /public/report-shares/{token}` | [app/r/[token]/page.tsx](../../../app/r/%5Btoken%5D/page.tsx), [report-shares.ts](../../../packages/core/report-shares.ts) | `no-store, no-referrer, noindex` 已强制生效；撤销可即时拦截 | 仅支持单语，缺多语切换与新报告格式适配 | TASK-220 |

---

## 二、安全与隐私转化边界验证结论（保留项）

- **保留项（`EXISTS_VERIFIED` 隔离测试通过）**：
  1. `customerDestination()`（`portal-routes.ts` L193–198）严格校验同源相对路径，阻断开放重定向与 `/checkout/demo/*` 回跳。
  2. OIDC 登录采用 PKCE + state + nonce，且严禁按同邮箱静默合并旧账号（`auth.ts` L127–129）。
  3. 未配置或关闭 `QCW_DEMO` 时 `/auth/demo/switch` 与 `/checkout/demo/*` 均失效。
- **待新建核心能力（`MISSING`）**：
  - `TASK-201B`：服务端匿名草稿实体与高熵认领令牌、`Draft.claim / merge / replace`（价格变化强制重确认、过期/重放拒绝）。
  - `TASK-202B`：公开询价结构化报价单、客户身份绑定与一键认领转正式订单付款。
