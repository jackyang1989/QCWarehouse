"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Action,
  ErrorBlock,
  Form,
  Panel,
  request,
  RequestError,
  stamp,
  Table,
  Tag,
  text,
  useLoad,
  type Row,
} from "./ui";
import { StatusBanner } from "./admin-labels";
import type { Actor } from "../packages/core/common";

const DOMAIN_ZH: Record<string, string> = {
  all: "全部接入",
  payment: "支付渠道",
  ocr: "OCR / 文档识别",
  logistics: "物流查询",
  email: "邮件服务",
  storage: "对象存储",
  webhook: "Webhook",
};

const STATE_TONE: Record<string, { label: string; tone: "green" | "blue" | "yellow" | "red" | "gray" }> = {
  enabled: { label: "已启用", tone: "green" },
  verified: { label: "已验证", tone: "blue" },
  configured: { label: "已配置", tone: "blue" },
  degraded: { label: "降级告警", tone: "yellow" },
  requires_approval: { label: "待合规批准", tone: "yellow" },
  disabled: { label: "已停用", tone: "gray" },
};

const HEALTH_TONE: Record<string, { label: string; tone: "green" | "yellow" | "red" | "gray" }> = {
  healthy: { label: "正常", tone: "green" },
  degraded: { label: "降级", tone: "yellow" },
  unconfigured: { label: "缺密钥/配置", tone: "yellow" },
  blocked: { label: "合规阻断", tone: "red" },
  error: { label: "异常", tone: "red" },
  unknown: { label: "未测试", tone: "gray" },
};

const COMPLIANCE_ZH: Record<string, string> = {
  approved: "可用",
  manual_only: "人工开票/人工核验可用",
  requires_review: "需升级商户或补充审核",
  prohibited_aup: "暂未启用",
  disabled_future: "暂未启用",
  pending: "待评估",
};

const HIDDEN_UNINTEGRATED_PROVIDERS = new Set(["creem", "dodo_payments", "airwallex", "oceanpayment"]);

export function AdminIntegrationsDesk({ path, actor, demo = false }: { path: string; actor: Actor; demo?: boolean }) {
  const isPaymentsView = path === "/admin/integrations/payments";
  const isOcrView = path === "/admin/integrations/ocr";
  const initialDomain = isPaymentsView ? "payment" : isOcrView ? "ocr" : "all";
  const [domain, setDomain] = useState<string>(initialDomain);
  useEffect(() => {
    setDomain(isPaymentsView ? "payment" : isOcrView ? "ocr" : "all");
  }, [isPaymentsView, isOcrView]);

  const query = domain === "all" ? "" : `?domain=${encodeURIComponent(domain)}`;
  const { data, error, reload } = useLoad(`/staff/admin/integrations${query}`);
  const ocrJobsLoad = useLoad(isOcrView ? "/staff/admin/ocr/jobs" : null);
  const [selectedKey, setSelectedKey] = useState<string>(isOcrView ? "paddle_ocr" : "stripe");
  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "error" | "success"; text: string }>();
  const [actionError, setActionError] = useState<string>();
  const [reauthNeeded, setReauthNeeded] = useState(false);

  // Interactive real OCR test extractor state
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrEnginePick, setOcrEnginePick] = useState<string>("");
  const [ocrPreviewUrl, setOcrPreviewUrl] = useState<string | null>(null);
  const [ocrTestBusy, setOcrTestBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState<Row | null>(null);

  useEffect(() => {
    if (isOcrView) setSelectedKey("paddle_ocr");
    else if (isPaymentsView) setSelectedKey("stripe");
  }, [isOcrView, isPaymentsView]);

  useEffect(() => {
    if (!ocrFile) {
      setOcrPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(ocrFile);
    setOcrPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [ocrFile]);

  const isSuperAdmin = actor.roles.includes("super_admin");
  const providers: Row[] = data?.providers ?? [];
  const visibleProviders = providers.filter((p) => !HIDDEN_UNINTEGRATED_PROVIDERS.has(p.provider_key));
  const events: Row[] = data?.events ?? [];
  const selected: Row | undefined = visibleProviders.find((p) => p.provider_key === selectedKey) ?? visibleProviders[0];
  const paypalManualRow = providers.find((p) => p.provider_key === "paypal_manual");
  const paypalManualEnabled = Boolean(paypalManualRow?.enabled && paypalManualRow?.lifecycle_state !== "disabled");

  function handleActionError(e: unknown) {
    if (e instanceof RequestError && e.code === "STAFF_REAUTH_REQUIRED") setReauthNeeded(true);
    setActionError(e instanceof Error ? e.message : "操作失败");
  }

  async function runValidate(key: string, env: string) {
    setActionError(undefined);
    try {
      const res = await request(`/staff/admin/integrations/${key}/validate`, "POST", { environment: env });
      setNotice({
        tone: res.ok ? "success" : "warning",
        text: res.ok
          ? `[配置校验通过] ${key} (${env}) 参数完整、URL 合规，已就绪可执行真实连接测试。`
          : `[配置校验提示] ${key} (${env}) 缺项: ${(res.missing_fields ?? []).join(", ") || "无"}；合规/警告: ${[...(res.compliance_blockers ?? []), ...(res.warnings ?? [])].join("；")}`,
      });
      reload();
    } catch (e) {
      handleActionError(e);
    }
  }

  async function runConnectionTest(key: string, env: string) {
    setActionError(undefined);
    try {
      const res = await request(`/staff/admin/integrations/${key}/test`, "POST", { environment: env });
      setNotice({
        tone: res.ok ? "success" : res.health_status === "blocked" ? "error" : "warning",
        text: `[真实连接探测 · ${res.latency_ms ?? 0}ms] ${res.summary}${res.error ? `（详情：${res.error}）` : ""}`,
      });
      reload();
    } catch (e) {
      handleActionError(e);
    }
  }

  async function runTestOcrExtract() {
    if (!ocrFile) return;
    setActionError(undefined);
    setOcrTestBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", ocrFile);
      if (ocrEnginePick) fd.append("provider_key", ocrEnginePick);
      const res = await request("/staff/admin/ocr/test-extract", "POST", fd);
      setOcrResult(res);
      setNotice({
        tone: res.ok ? "success" : "error",
        text: res.ok
          ? `真实 OCR 执行完成（引擎：${res.provider_key}，耗时：${res.latency_ms}ms，提取 ${res.candidates?.length ?? 0} 条候选明细）`
          : `OCR 失败 [${res.error_code ?? "ERROR"}]: ${res.error_message ?? "请检查文件或引擎状态"}`,
      });
      ocrJobsLoad.reload();
      reload();
    } catch (e) {
      handleActionError(e);
    } finally {
      setOcrTestBusy(false);
    }
  }

  return (
    <div className="stack">
      <section className="page-head">
        <div>
          <p className="eyebrow">INTEGRATIONS</p>
          <h1>
            {isPaymentsView ? "支付渠道配置" : isOcrView ? "OCR 文档识别" : "第三方集成"}
          </h1>
          <p className="subhead">
            统一管理 Stripe HK、PayPal 人工开票/自动预留、自托管 PaddleOCR ONNX、Google Cloud Vision 与运维接口；密钥经服务端 AES-256-GCM 密文库保管，永不向前端透出明文。
          </p>
        </div>
        <div className="actions">
          <button type="button" className="button sm" onClick={reload}>刷新集成状态</button>
          <Link className="button sm" href="/admin/payments">前往支付流水与人工核对 →</Link>
        </div>
      </section>

      {reauthNeeded && (
        <StatusBanner tone="warning" title="需要员工二次身份认证（MFA）">
          修改集成开关、存取/轮换加密密钥及发起真实连接探针需 15 分钟内有效 MFA。{" "}
          <Link href={`/staff/login?next=${encodeURIComponent(path)}`}>立即重新验证身份 →</Link>
        </StatusBanner>
      )}
      {error && <ErrorBlock error={error} />}
      {actionError && <ErrorBlock error={actionError} />}
      {notice && <StatusBanner tone={notice.tone} title="操作结果">{notice.text}</StatusBanner>}

      {!isSuperAdmin && (
        <StatusBanner tone="info" title="当前为只读/受限查看权限">
          当前岗位可查看服务状态、日志与人工通道状态；仅超级管理员（super_admin）可执行密钥写入/轮换与通道切换。
        </StatusBanner>
      )}

      {isPaymentsView && (
        <div className="split-grid">
          <Panel title="主渠道 · Stripe (HK 个人商户)" subtitle="身份与收款账户状态真实核验">
            <ul className="plain-list">
              <li>✅ <strong>香港商户 KYC</strong>：已收到 Stripe 可开始收款通知，已验证通过（勿回退为未完成）。</li>
              <li>✅ <strong>结算银行</strong>：已绑定香港 <strong>ZA Bank（众安银行）</strong>。</li>
              <li>⏳ <strong>Live 生产放行门禁</strong>：需分别完成 Live Secret/Webhook Vault 入库并实测 Checkout + Webhook + 首笔入账。</li>
            </ul>
            <div className="actions" style={{ marginTop: 10 }}>
              <Action
                run={async () => {
                  const res = await request("/staff/finance/stripe/reconcile", "POST", {});
                  setNotice({
                    tone: res.ok ? "success" : "warning",
                    text: res.configured
                      ? `Stripe 主动对账完成：核查 ${res.checked} 笔，补单 ${res.reconciled} 笔。`
                      : `Stripe 主动对账：当前未配置 Live/Test Secret Key（待核查会话 ${res.checked} 笔），未伪造对账结果。`,
                  });
                  reload();
                }}
              >
                触发 Stripe 主动对账
              </Action>
            </div>
          </Panel>

          {paypalManualEnabled ? (
            <Panel title="人工备用 · PayPal Manual Invoice" subtitle="2026-06-30 前注册中国大陆个人账户可用">
              <ul className="plain-list">
                <li>✅ <strong>业务可用状态</strong>：客户选择 PayPal Invoice 申请付款 → 财务线下开票记录 INV2 编号。</li>
                <li>✅ <strong>双人职责分离 (SoD)</strong>：财务录入交易号/实收净额与凭证，需另一位财务/超管 MFA 独立核销后方可激活订单。</li>
                <li>✅ <strong>安全不强迫升级</strong>：未升级企业前不开启 PayPal 自动 Orders v2 Checkout。</li>
              </ul>
              <div className="actions" style={{ marginTop: 10 }}>
                <Link className="button sm primary" href="/admin/payments">打开 PayPal 人工开票/核销工作台 →</Link>
              </div>
            </Panel>
          ) : (
            <Panel title="备用渠道 · PayPal（当前已停用）" subtitle="个人账户暂不支持 Live 自动 API，人工开票默认关闭">
              <ul className="plain-list">
                <li>⏸️ <strong>PayPal 人工开票（`paypal_manual`）默认已停用</strong>：客户结账页当前仅展示 Stripe，不再显示人工发票选项；若日后确需应急人工收款，可在下方列表重新启用。</li>
                <li>🔒 <strong>PayPal Orders v2 自动结账（`paypal_auto`）</strong>：因个人账户无法在 Live 模式获取 REST API 凭证，保持门禁锁定，待升级 PayPal Business 企业账户后解锁启用。</li>
              </ul>
            </Panel>
          )}
        </div>
      )}

      {!isPaymentsView && !isOcrView && (
        <div className="actions" style={{ flexWrap: "wrap" }}>
          {Object.entries(DOMAIN_ZH).map(([k, label]) => (
            <button key={k} type="button" className={`button sm${domain === k ? " primary" : ""}`} onClick={() => setDomain(k)}>
              {label}
            </button>
          ))}
        </div>
      )}

      <Panel title="服务提供商注册表与生命周期状态" subtitle="点击任意服务商查看安全配置、AES-256-GCM 密钥库与实时连接测试">
        {visibleProviders.length === 0 ? (
          <p className="muted">正在加载第三方服务商列表…</p>
        ) : (
          <Table
            headers={["服务商", "领域 / 环境", "状态", "健康度", "24h 指标", "操作"]}
            rows={visibleProviders.map((p) => {
              const st = STATE_TONE[p.lifecycle_state] ?? { label: p.lifecycle_state, tone: "gray" as const };
              const hl = HEALTH_TONE[p.health_status] ?? { label: p.health_status, tone: "gray" as const };
              const m = p.metrics ?? {};
              return [
                <div key="n" className="cell-stack" style={{ minWidth: 165 }}>
                  <strong>{p.display_name}</strong>
                  <small className="code">{p.provider_key} · {COMPLIANCE_ZH[p.compliance_status] ?? p.compliance_status}</small>
                </div>,
                <div key="de" className="cell-stack">
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <Tag tone="gray">{DOMAIN_ZH[p.domain] ?? p.domain}</Tag>
                    <Tag tone={p.environment === "live" ? "blue" : "outline"}>{p.environment.toUpperCase()}</Tag>
                  </div>
                  <small className="muted">
                    {p.is_primary ? "主用 " : p.is_fallback ? "备选 " : "备用 "}#{p.priority}
                  </small>
                </div>,
                <div key="s" className="cell-stack">
                  <Tag tone={st.tone}>{st.label}</Tag>
                  {!p.enabled && <small className="muted">未激活</small>}
                </div>,
                <div key="h" className="cell-stack">
                  <Tag tone={hl.tone}>{hl.label}</Tag>
                  {p.last_checked_at && <small>{stamp(p.last_checked_at, true)}</small>}
                </div>,
                <div key="m" className="cell-stack small">
                  <span>{m.calls_24h ?? 0} 次 / {m.errors_24h ?? 0} 错</span>
                  <small className="muted">{m.avg_latency_ms ?? "—"}ms · ${Number(m.cost_30d_usd ?? 0).toFixed(4)}</small>
                </div>,
                <div key="act" className="actions" style={{ flexWrap: "wrap", gap: 6 }}>
                  <button
                    type="button"
                    className={`button sm nowrap${selected?.provider_key === p.provider_key ? " primary" : ""}`}
                    onClick={() => setSelectedKey(p.provider_key)}
                  >
                    {selected?.provider_key === p.provider_key ? "编辑中" : "管理 / 测试"}
                  </button>
                  <button type="button" className="button sm nowrap" onClick={() => void runValidate(p.provider_key, p.environment)}>
                    校验配置
                  </button>
                  <button type="button" className="button sm nowrap" onClick={() => void runConnectionTest(p.provider_key, p.environment)}>
                    连接测试
                  </button>
                </div>,
              ];
            })}
          />
        )}
      </Panel>

      {selected && (
        <div className="split-grid">
          <Panel
            title={`配置管理 · ${selected.display_name}`}
            subtitle={`key: ${selected.provider_key} · 合规策略: ${COMPLIANCE_ZH[selected.compliance_status] ?? selected.compliance_status}`}
          >
            {selected.last_check_summary && (
              <p className="small" style={{ marginBottom: 10 }}>
                <strong>最近检测摘要：</strong> {selected.last_check_summary}
                {selected.last_error ? <span className="muted">（{selected.last_error}）</span> : null}
              </p>
            )}
            <dl className="admin-kv-grid" style={{ marginBottom: 14 }}>
              {Object.entries(selected.config ?? {})
                .filter(([k]) => k !== "no_icp_required")
                .map(([k, v]) => (
                  <div key={k} className="admin-kv-item">
                    <dt className="code">{k}</dt>
                    <dd className="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
            </dl>
            {isSuperAdmin && (
              <Form
                label="更新环境、启用开关与优先级"
                run={async (f) => {
                  try {
                    const nextEnv = text(f, "environment") as "sandbox" | "live";
                    const nextState = text(f, "lifecycle_state");
                    const nextEnabled = f.get("enabled") === "on";
                    const nextPriority = Number(text(f, "priority") || selected.priority);
                    const nextConfig: Record<string, unknown> = {};
                    if (selected.provider_key === "stripe") {
                      nextConfig.live_checkout_verified = f.get("live_checkout_verified") === "on";
                      nextConfig.live_webhook_verified = f.get("live_webhook_verified") === "on";
                      nextConfig.live_payout_verified = f.get("live_payout_verified") === "on";
                    }
                    if (selected.provider_key === "paypal_auto") {
                      nextConfig.business_account_verified = f.get("business_account_verified") === "on";
                    }
                    if (selected.provider_key === "outbound_webhooks") {
                      const u = text(f, "target_url");
                      if (u) nextConfig.target_url = u;
                    }
                    await request(`/staff/admin/integrations/${selected.provider_key}`, "POST", {
                      environment: nextEnv,
                      lifecycle_state: nextState,
                      enabled: nextEnabled,
                      priority: nextPriority,
                      config: nextConfig,
                    });
                    setActionError(undefined);
                    setNotice({ tone: "success", text: `已保存 ${selected.display_name} 运行参数。` });
                    reload();
                  } catch (e) {
                    handleActionError(e);
                    throw e;
                  }
                }}
              >
                <div className="filters-grid">
                  <label>
                    当前环境
                    <select name="environment" defaultValue={selected.environment}>
                      <option value="sandbox">Sandbox 沙盒测试</option>
                      <option value="live">Live 生产环境</option>
                    </select>
                  </label>
                  <label>
                    生命周期状态
                    <select name="lifecycle_state" defaultValue={selected.lifecycle_state}>
                      <option value="configured">Configured 已配置</option>
                      <option value="verified">Verified 已验证</option>
                      <option value="enabled">Enabled 已启用</option>
                      <option value="degraded">Degraded 降级</option>
                      <option value="requires_approval">Requires Approval 待合规批准</option>
                      <option value="disabled">Disabled 已停用</option>
                    </select>
                  </label>
                  <label>
                    路由优先级 (越小越优先)
                    <input type="number" name="priority" min={1} max={999} defaultValue={selected.priority} />
                  </label>
                </div>
                <label className="check-row">
                  <input type="checkbox" name="enabled" defaultChecked={Boolean(selected.enabled)} />
                  <span>启用该服务渠道（受合规与 Live 验证门禁校验）</span>
                </label>
                {selected.provider_key === "stripe" && (
                  <div className="stack-tight" style={{ marginTop: 8 }}>
                    <label className="check-row">
                      <input type="checkbox" name="live_checkout_verified" defaultChecked={Boolean(selected.config?.live_checkout_verified)} />
                      <span>已实测验证 Stripe Live Checkout 支付会话创建与回跳</span>
                    </label>
                    <label className="check-row">
                      <input type="checkbox" name="live_webhook_verified" defaultChecked={Boolean(selected.config?.live_webhook_verified)} />
                      <span>已实测验证 Stripe Live Webhook 签名回调入账</span>
                    </label>
                    <label className="check-row">
                      <input type="checkbox" name="live_payout_verified" defaultChecked={Boolean(selected.config?.live_payout_verified)} />
                      <span>已核实首笔款项结算至香港 ZA Bank</span>
                    </label>
                  </div>
                )}
                {selected.provider_key === "paypal_auto" && (
                  <label className="check-row" style={{ marginTop: 8 }}>
                    <input type="checkbox" name="business_account_verified" defaultChecked={Boolean(selected.config?.business_account_verified)} />
                    <span>已完成 PayPal 商业/企业账户升级并核准 Orders v2 权限</span>
                  </label>
                )}
                {selected.provider_key === "outbound_webhooks" && (
                  <label>
                    HTTPS Webhook 目标地址（受 SSRF 防护校验）
                    <input name="target_url" type="url" defaultValue={String(selected.config?.target_url ?? "")} placeholder="https://example.com/webhooks/qcw" />
                  </label>
                )}
              </Form>
            )}
          </Panel>

          <Panel
            title={`加密密钥库 (AES-256-GCM Vault) · ${selected.display_name}`}
            subtitle="密钥加密写入 integration_secrets；页面仅展示脱敏后缀与版本号。"
          >
            {(selected.secrets ?? []).length === 0 ? (
              <p className="muted">
                当前 Vault 无记录密钥。
                {(selected.env_fallback_secrets ?? []).length > 0
                  ? ` 检测到环境变量已提供 [${(selected.env_fallback_secrets as string[]).join(", ")}]。`
                  : " 若该服务需要 API 密钥，请在下方录入。"}
              </p>
            ) : (
              <Table
                headers={["环境", "密钥键名", "脱敏摘要", "版本", "状态", "更新时间", "操作"]}
                rows={(selected.secrets as Row[]).map((s) => [
                  <Tag key="e" tone={s.environment === "live" ? "blue" : "gray"}>{s.environment}</Tag>,
                  <code key="n" className="code">{s.secret_name}</code>,
                  <code key="m" className="code">{s.masked_hint}</code>,
                  `v${s.key_version}`,
                  <Tag key="st" tone={s.status === "active" ? "green" : s.status === "rotated" ? "yellow" : "red"}>{s.status}</Tag>,
                  <span key="t" className="small">{stamp(s.revoked_at ?? s.rotated_at ?? s.created_at, true)}</span>,
                  s.status === "active" && isSuperAdmin ? (
                    <Action
                      key="rev"
                      run={async () => {
                        await request(`/staff/admin/integrations/${selected.provider_key}/secrets/revoke`, "POST", {
                          environment: s.environment,
                          secret_name: s.secret_name,
                        });
                        setNotice({ tone: "warning", text: `已吊销 ${selected.provider_key} ${s.environment}.${s.secret_name}` });
                        reload();
                      }}
                    >
                      吊销
                    </Action>
                  ) : (
                    "—"
                  ),
                ])}
              />
            )}

            {isSuperAdmin && (selected.supported_secrets ?? []).length > 0 && (
              <div style={{ marginTop: 14 }}>
                <Form
                  label="写入或轮换加密密钥"
                  run={async (f) => {
                    try {
                      const env = text(f, "environment") as "sandbox" | "live";
                      const secretName = text(f, "secret_name");
                      const secretValue = text(f, "secret_value");
                      const res = await request(`/staff/admin/integrations/${selected.provider_key}/secrets`, "POST", {
                        environment: env,
                        secret_name: secretName,
                        secret_value: secretValue,
                      });
                      setActionError(undefined);
                      setNotice({
                        tone: "success",
                        text: `已安全加密保存 ${selected.provider_key} ${env}.${secretName}（v${res.key_version}，脱敏：${res.masked_hint}）`,
                      });
                      reload();
                    } catch (e) {
                      handleActionError(e);
                      throw e;
                    }
                  }}
                >
                  <div className="filters-grid">
                    <label>
                      目标环境
                      <select name="environment" defaultValue={selected.environment}>
                        <option value="sandbox">sandbox</option>
                        <option value="live">live</option>
                      </select>
                    </label>
                    <label>
                      密钥字段
                      <select name="secret_name">
                        {(selected.supported_secrets as string[]).map((sn) => (
                          <option key={sn} value={sn}>{sn}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      新密钥明文（加密入库后立即清空）
                      <input name="secret_value" type="password" required autoComplete="off" placeholder="sk_test_... / whsec_... / API Key" />
                    </label>
                  </div>
                </Form>
              </div>
            )}
          </Panel>
        </div>
      )}

      {isOcrView && (
        <Panel
          title="OCR 真实文件提取测试台 (Real PaddleOCR / Vision Testbench)"
          subtitle="上传真实采购截图（PNG/JPG/WebP）或 PDF（商业发票/箱单/1688 订单导出），验证实时识别与结构化解析"
        >
          <div className="filters-grid" style={{ alignItems: "end" }}>
            <label>
              选择本地图片或 PDF 文件（最大 15MB / 10 页）
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => setOcrFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              指定测试引擎（默认按优先级自动编排与降级备选）
              <select value={ocrEnginePick} onChange={(e) => setOcrEnginePick(e.target.value)}>
                <option value="">自动策略（主用 PaddleOCR PP-OCRv4）</option>
                <option value="paddle_ocr">仅自托管 PaddleOCR (PP-OCRv4 ONNX)</option>
                <option value="google_vision_ocr">Google Cloud Vision (DOCUMENT_TEXT_DETECTION)</option>
              </select>
            </label>
            <div className="actions">
              <button
                type="button"
                className="button primary"
                disabled={!ocrFile || ocrTestBusy}
                onClick={() => void runTestOcrExtract()}
              >
                {ocrTestBusy ? "正在执行真实 OCR 识别…" : "执行真实 OCR 识别测试"}
              </button>
            </div>
          </div>

          {ocrResult && (
            <div className="split-grid" style={{ marginTop: 16 }}>
              <div className="panel" style={{ padding: 14 }}>
                <h3>原图 / 文本块预览与耗时：{ocrResult.latency_ms} ms</h3>
                <p className="small muted">
                  引擎：{ocrResult.provider_key} · 页数：{ocrResult.page_count} · 平均置信度：
                  {ocrResult.confidence ? `${(Number(ocrResult.confidence) * 100).toFixed(1)}%` : "0%"}
                </p>
                {ocrPreviewUrl && ocrFile && !ocrFile.name.toLowerCase().endsWith(".pdf") && (
                  <div style={{ position: "relative", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                    <img src={ocrPreviewUrl} alt="OCR 测试输入文件" style={{ width: "100%", height: "auto", display: "block" }} />
                  </div>
                )}
                <label>
                  Stage 1 原始识别文本
                  <textarea readOnly rows={8} value={String(ocrResult.raw_text ?? "")} className="mono" style={{ width: "100%", fontSize: 12 }} />
                </label>
              </div>
              <div className="panel" style={{ padding: 14 }}>
                <h3>Stage 2 结构化订单解析结果 ({(ocrResult.candidates ?? []).length} 条候选明细)</h3>
                {(ocrResult.warnings ?? []).length > 0 && (
                  <StatusBanner tone="warning" title="解析提示">
                    {(ocrResult.warnings as string[]).join("；")}
                  </StatusBanner>
                )}
                {(ocrResult.candidates ?? []).length > 0 ? (
                  <Table
                    headers={["平台/单号/运单", "商品名称", "SKU", "颜色/尺码", "数量", "置信度"]}
                    rows={(ocrResult.candidates as Row[]).map((c, idx) => [
                      <div key={idx} className="cell-stack">
                        <span className="small">{c.platform ?? "—"}</span>
                        <small className="code">{c.platform_order_no ?? "—"}</small>
                        <small className="code">{c.tracking_no ?? "—"}</small>
                      </div>,
                      <strong key="n">{c.item_name}</strong>,
                      <code key="sku" className="code">{c.sku_code ?? "—"}</code>,
                      <span key="v">{[c.color, c.size].filter(Boolean).join(" / ") || "—"}</span>,
                      <strong key="q">{c.quantity}</strong>,
                      <Tag key="cf" tone={Number(c.confidence) >= 0.8 ? "green" : Number(c.confidence) >= 0.72 ? "blue" : "yellow"}>
                        {(Number(c.confidence) * 100).toFixed(0)}%
                      </Tag>,
                    ])}
                  />
                ) : (
                  <p className="muted">未能自动提取出明确商品行，可检查左侧原始文本。</p>
                )}
              </div>
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <h3>最近 OCR 作业队列（客户与测试作业监控）</h3>
            <Table
              headers={["作业 ID", "类型", "引擎", "状态", "候选数", "置信度", "耗时", "错误", "创建时间"]}
              rows={((ocrJobsLoad.data?.jobs as Row[]) ?? []).slice(0, 20).map((j) => [
                <code key="id" className="code">{String(j.id).slice(0, 8)}</code>,
                <Tag key="t" tone={j.is_test ? "gray" : "blue"}>{j.is_test ? "管理测试" : "客户委托"}</Tag>,
                <span key="e" className="code">{j.provider_key}{j.fallback_provider_key ? ` -> ${j.fallback_provider_key}` : ""}</span>,
                <Tag key="s" tone={j.state === "completed" ? "green" : j.state === "needs_review" ? "yellow" : j.state === "failed" ? "red" : "gray"}>{j.state}</Tag>,
                String(j.candidate_count ?? 0),
                j.confidence ? `${(Number(j.confidence) * 100).toFixed(0)}%` : "—",
                j.latency_ms ? `${j.latency_ms}ms` : "—",
                <span key="err" className="small">{j.error_code ?? "—"}</span>,
                <span key="tm" className="small">{stamp(j.created_at, true)}</span>,
              ])}
            />
          </div>
        </Panel>
      )}

      <Panel title="近期集成调用与配置审计事件 (Top 50)" subtitle="脱敏展示实时调用延迟、密钥生命周期变化与异常摘要">
        <Table
          headers={["时间", "服务商", "环境", "事件", "结果", "耗时", "成本", "摘要"]}
          rows={events.map((ev) => [
            <span key="t" className="small nowrap">{stamp(ev.created_at, true)}</span>,
            <code key="p" className="code">{ev.provider_key}</code>,
            <Tag key="e" tone="gray">{ev.environment}</Tag>,
            <span key="k" className="small">{ev.event_kind}</span>,
            <Tag key="s" tone={ev.status === "ok" ? "green" : ev.status === "warn" ? "yellow" : "red"}>{ev.status}</Tag>,
            ev.latency_ms != null ? `${ev.latency_ms}ms` : "—",
            `$${Number(ev.cost_estimate_usd ?? 0).toFixed(4)}`,
            <span key="sum" className="small">{ev.summary}</span>,
          ])}
        />
      </Panel>
    </div>
  );
}
