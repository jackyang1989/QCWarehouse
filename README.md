# QC Warehouse

通用第三方实物检查平台。英文客户门户、中文仓库台与管理后台使用同一 PostgreSQL 数据库、同一交易接口和同一工作进程。服装是默认演示目录，品类字段由模板配置。

唯一冻结需求权威见 [01–116 生产级统一重构执行指令](docs/QC_Warehouse_生产级统一重构执行指令_最终完整01-116_AI服务与专业翻译全业务闭环版.md)。产品边界和上线门禁见 [PRD（v5.1）](docs/QCWarehouse_PRD_v3_MultiCategory.md)，实施细节与技术协议见 [开发规格（v5.1）](docs/开发规格.md)，12 包 90 项任务 DAG 与 67 项门禁闭包见 [分包排期与需求追踪矩阵（v5.1）](docs/生产级统一重构分包排期与需求追踪矩阵.md)，唯一执行状态与实测证据见 [开发排期与任务台账（v5.1）](docs/开发排期与任务台账.md)。

## 本地启动

需要 Node.js 22 或更新版本，以及 PostgreSQL 16。可以使用本地已有数据库，也可以启动 Compose 中的开发数据库。

```bash
npm ci
docker compose up -d db
cp .env.example .env
openssl rand -hex 32
```

在 `.env` 中将随机值填入 `AUTH_OTP_PEPPER`，设 `QCW_DEMO=1`。如使用已有数据库，将 `DATABASE_URL` 改为本地开发库的连接字符串。

```bash
npm run db:migrate
npm run db:demo
npm run dev
```

在另一个终端运行 `npm run worker` 处理 PDF、物流回调和站内通知。浏览器打开 `http://localhost:3000`。客户从 `/login` 注册，员工从 `/staff/login` 登录。仓库 `/wh` 和后台 `/admin` 直链也会转入员工登录，登录后按角色恢复原页面。本地演示客户使用新的 `@qcw.test` 邮箱。员工用 `receiving@qcw.test`、`inspector@qcw.test`、`reviewer@qcw.test`、`admin@qcw.test` 登录。验证码在本地页面显示。演示仓址与运价是测试数据，付款通过本地模拟确认。

## 重跑验证

```bash
npm run check
npm run build
python3 docs/contracts/check.py
docker compose exec -T db createdb -U qcwarehouse qcw_test
```

在 `.env` 设置 `TEST_DATABASE_URL=postgres://qcwarehouse:qcwarehouse@localhost:5432/qcw_test`，运行 `npm run test:integration`。测试用独立数据库，自动迁移并写入演示数据。箱包和家居模板仅在测试数据库激活。数据库关系用例须在已迁移、未写入演示数据的空库执行 `psql -v ON_ERROR_STOP=1 -f docs/contracts/verify.sql`。

部署 OCR Worker 或运行完整集成套件前，使用 Python 3.11 或 3.12 创建虚拟环境。Web 进程与 Worker 都须在其 `PATH` 中找到该环境的 `python3`。三个集成套件串行运行，每套都会重建指定的独立测试库。

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r scripts/ocr-requirements.txt
python3 scripts/ocr_engine.py --health
npm run test:integration
```

集成测试对核心 OpenAPI 逐操作校验成功响应和覆盖到的错误响应。新增核心操作时须有可执行的成功用例。仓库的 [Core contract 检查](.github/workflows/core-contract.yml) 在 main 更新或 PR 时使用临时 PostgreSQL 实例执行同一套校验。

## 外部服务联调

运行 `npm run integrations:check` 查看配置状态，或由超管通过 `GET /api/v1/staff/admin/tracking/health` 查看快递100配置。两者均只做本地检查，输出不含密钥、不调用外部服务，也不验证账号权限、实际额度和投递结果。接入时使用独立测试环境，关闭 `QCW_DEMO`。

| 服务 | 配置与联调入口 |
|---|---|
| Google / Microsoft | 分别填入客户端 ID 与密钥，登记预检输出的完整回调地址。Microsoft 按个人账号授权。首次 Microsoft 登录另需验证通知邮箱。 |
| Stripe | 测试密钥与同环境签名密钥成对配置。回调 `POST /api/v1/webhooks/stripe`。使用测试密钥运行端到端付款和退款后再留证。正式收款默认关闭。 |
| Resend | 客户验证码和交易邮件的主用渠道。在后台「邮件服务配置」保存已验证域名的发件地址及加密密钥，完成模拟投递测试并启用。 |
| Postmark | 手动备用。使用 `EMAIL_PROVIDER=postmark` 切换前，先确认账号可发信并设置服务端令牌、发件地址和交易消息流。 |
| 快递100 | 配置企业 key/customer 及 HTTPS 回调根地址，服务端生成订阅回调地址。Worker 负责查询、订阅、回调消费。分别留证中文推送、英文查询、电话校验与入仓、集运、退商家链路。 |

开发联调可使用 `npm run test:integration`。供应商夹具覆盖 OAuth 发起与回调防重放、Resend 与 Postmark 发信和回调、Stripe 签名和支付去重、快递100查询及回调。测试不会使用真实账号。

供应商设置依据：[Stripe Checkout 与回调](https://docs.stripe.com/checkout/fulfillment?ui=full-page)、[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)、[Microsoft 个人账号 OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)、[Resend 发送 API](https://resend.com/docs/api-reference/emails/send-email)、[Postmark 发送 API](https://postmarkapp.com/developer/api/email-api)、[快递100实时查询](https://api.kuaidi100.com/document/5f0ffb5ebc8da837cbd8aefc)。

超管打开 `/admin/integrations/email`。在 Resend 验证发件域名，例如独立子域 `auth.qcwarehouse.com`，填入相应发件地址。在 Resend 创建指向页面所示地址的 Webhook，订阅 Sent、Delivered、Delivery Delayed、Bounced、Complained、Failed 和 Suppressed。将发信 API 密钥和签名密钥分别保存到加密密钥库。「发送模拟测试」仅发送到 Resend 的模拟地址，刷新可查看签名回调结果。保存「启用 Resend 发信」后，Web 和 Worker 读取同一份后台配置。


## 临时 VPS 部署与正式服务器迁移

### 当前部署

| 项目 | 配置 |
| --- | --- |
| 公网主域名 | `https://qcwarehouse.com`。Cloudflare 将 HTTP 跳转至 HTTPS，`www` 以 308 跳转至主域并保留路径和查询参数 |
| 临时源站 | `89.117.172.74`，Debian 12，Node.js 22.23.3。Next.js 生产构建运行于 `127.0.0.1:13034`，Cloudflare Tunnel 将网站域名映射到该端口 |
| 发布与服务 | `/opt/qcwarehouse/current` 指向当前发布目录。systemd 单元为 `qcwarehouse-web` 和 `qcwarehouse-worker`，以专用账号运行 |
| 数据库 | PostgreSQL 16，库名及应用角色均为 `qcwarehouse`，使用本机 Unix socket 和 peer 认证。在本部署中，私有图片、PDF 等文件存于 PostgreSQL 的 `private_files` 表 |
| 运行配置 | `/etc/qcwarehouse/application.env`，root 持有且权限为 `0600`。其中 `APP_URL=https://qcwarehouse.com`，配置值及密钥由管理员保管 |
| 已验备份 | 临时 VPS 的 `/root/qcwarehouse-predeploy-20261124T015845Z` 保存旧服务配置与 DNS 基线。`/var/backups/qcwarehouse/initial-schema-20261124.dump` 是新建数据库的初始备份，已验证恢复 |

临时源站的 Xray 使用 TCP 443，Hysteria2 使用 UDP 443。网站复用该 VPS 已有的 Cloudflare 连接器中的独立网站路由。操作应用时请以站点域名和 QC Warehouse 单元为范围。

### 登录与回调

供应商用 HTTPS 主域名识别回调。换 VPS 时，只要 `APP_URL` 和回调地址照旧，供应商的应用注册可以沿用。

| 服务 | 应用与服务端配置 | 公网回调 |
| --- | --- | --- |
| Google | Google Cloud 项目 `qcwarehouse-auth`，Web 客户端 `QC Warehouse Web`。运行配置使用 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET` | `https://qcwarehouse.com/api/v1/auth/google/callback` |
| Microsoft | `infunet` Entra 租户已注册 `QC Warehouse` Web 应用，受众为个人 Microsoft 账号。运行配置使用 `MICROSOFT_CLIENT_ID` 和 `MICROSOFT_CLIENT_SECRET` | `https://qcwarehouse.com/api/v1/auth/microsoft/callback` |

Google 已在公网实测授权回调、同意政策并创建客户账号，Google Cloud 应用已切换至正式版。Search Console 已通过主域所有权验证，品牌审核需等 Google 同步再重试。Microsoft 应用密钥已部署至临时 VPS，公网入口已验证跳转至微软个人账号授权页，Entra 已保存主域、条款和隐私链接。Microsoft 首次登录、自有邮箱验证码、备用邮箱和账号恢复依赖交易邮件发信。Resend 生产配置与收件验证见 TASK-169。

`/login` 直接展示邮箱输入框，未配置发信时禁用发送。客户工作区右上角显示其主要邮箱，可打开 `/account/security` 管理登录方式并验证备用邮箱。主邮箱失效时，提前验证过的备用邮箱可验证码登录原账户，并支持自助更换主邮箱。全部登录方式失效时，从 `/account/recovery` 使用可访问的新邮箱申请恢复和查进度，按既有复核流程保留原账户及业务记录。

临时 VPS 已配置 Stripe 受限 Live 密钥、正式 Webhook 签名密钥并开启 `STRIPE_LIVE_ENABLED`。已验证未付款的 Live Checkout 与实际签名回调。正式目录、价格、仓址和实收实退验收仍在发布台账跟踪。

四份[公开政策](https://qcwarehouse.com/legal)读取数据库的已生效版本。以后由超管在 `/admin/legal` 创建、预览和发布新版本，保留历史版本及客户同意记录。正文可使用以空行分隔的编号章节，公开详情页会生成目录。

### 迁移到正式服务器

1. **准备目标环境。** 部署与临时 VPS 相同的应用版本和迁移基线，安装匹配的 Linux 依赖，配置 PostgreSQL、专用应用角色及 Web 和 Worker 单元。先通过 SSH 在目标机检查本机端口及 `/api/v1/health`。为正式服务器建立独立的 Cloudflare Tunnel，待切换时再接入正式域名。独立 Tunnel 便于继续使用临时服务器上的其他服务。
2. **演练恢复。** 从源站生成最新 `pg_dump -Fc`，计算 SHA-256 并通过 SSH 传输到目标机。将备份恢复到独立验证库，核对迁移版本、账号、订单、包裹、款项、在途作业和样本文件可读性。保留源站版本、Cloudflare 网站路由和记录值。初始空库备份只用于核对部署基线。
3. **安排停写并复制生产数据。** 暂停旧站写入和 Worker，记录待处理作业及供应商回调，导出并校验最终数据库备份。目标机恢复到对应应用库，核对关键计数。通过安全方式同步必要的服务端配置。保留原 `AUTH_OTP_PEPPER`，因为历史密文依赖它解密。按目标库连接方式设置 `DATABASE_URL`，保持 `APP_URL=https://qcwarehouse.com`。同步已启用集成所需的凭证与验签配置，维持正式开关原状态。
4. **切换流量并验证。** 让 `qcwarehouse.com` 和 `www` 的网站代理记录指向新 Tunnel，对应源站为新机 Web 的本机监听端口。保留 HTTPS 跳转、`www` 规则及邮件路由记录。验证主域、登录回调、健康检查和已启用供应商的回调，核对检后处置、付款和待处理作业后再开放业务写入并启动新 Worker。若已配置供应商 IP 白名单，同步更新并实测。
5. **保留回退窗口。** 新站开始写入前，如验收失败，把网站记录和路由恢复到旧 Tunnel，并恢复旧站服务。新站已有写入时，先暂停写入并核对新旧数据库、支付回调和实物状态，再决定回迁最新数据或在新站修复。保留源站和独立备份直至业务验收签收。

## 集成和发布状态

- 001–007 迁移、42 个核心交易操作和本地集成测试已落盘。28 项集成测试覆盖三品类履约、30 件逐件加 3 件对比、入仓认领、物流、报价、范围变更、发运、报告修订与失败恢复、工单、通知、指定版本分享及审计。
- Google、Microsoft、Resend、Stripe 和快递100的配置见 [环境变量示例](.env.example)。当前邮件适配覆盖验证码，物流双语分别使用英、中文快照。真实凭证、完整英文轨迹样本、承运商覆盖及实际回调仍待独立联调。
- 生产门禁仍按 PRD §17 与规格 §23。任务台账保留账号安全与恢复、邮件退信、物流纠错、异常履约和实仓验收的未完工作。开发仓址、收费与政策均需换为正式发布版本。
- 指定版本分享默认关闭。上线验收须验证 CDN、反向代理及监控的分享访问令牌脱敏。应用错误日志已裁剪令牌，Next.js 开发访问日志忽略分享页及证据接口。
