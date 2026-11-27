"use client";

import { useState } from "react";
import { Action, ErrorBlock, Form, Panel, request, stamp, Table, Tag, text, useLoad, type Row } from "./ui";
import { AI_PURPOSE_CODES } from "../packages/core/ai-contract";
import type { Actor } from "../packages/core/common";

const STATUS_TONE: Record<string, "green" | "blue" | "yellow" | "red" | "gray"> = {
  approved: "green",
  tested: "blue",
  draft: "yellow",
  disabled: "gray",
  archived: "gray",
};

const HEALTH_TONE: Record<string, "green" | "yellow" | "red" | "gray"> = {
  verified: "green",
  degraded: "yellow",
  unconfigured: "yellow",
  unknown: "gray",
  error: "red",
};

export function AdminAiDesk({ actor }: { actor: Actor }) {
  const overview = useLoad("/staff/admin/ai/overview");
  const invocations = useLoad("/staff/admin/ai/invocations");
  const costLedger = useLoad("/staff/admin/ai/costs");

  const [tab, setTab] = useState<"overview" | "instances" | "models" | "budgets" | "invocations" | "costs">("overview");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [banner, setBanner] = useState<string | null>(null);

  const d = overview.data as Record<string, any> | undefined;
  const instances = (d?.instances ?? []) as Row[];
  const models = (d?.models ?? []) as Row[];
  const secrets = (d?.secrets ?? []) as Row[];
  const policies = (d?.budget_policies ?? []) as Row[];
  const activeInstanceId = selectedInstanceId || String(instances[0]?.id ?? "");
  const activeModelId = selectedModelId || String(models[0]?.id ?? "");
  const isSuperAdmin = actor.kind === "staff" && actor.roles.includes("super_admin");

  function reloadAll() {
    overview.reload();
    invocations.reload();
    costLedger.reload();
  }

  return (
    <div className="stack">
      <Panel
        title="PAGE-M42 · AI 与专业翻译服务管理中心"
        subtitle="OpenAI 官方与 Compatible 文本适配器 · 密文凭证 · 不可变费率版本 · 并发原子预算锁 · 仅语言处理沙箱"
      >
        <div className="row flexwrap" style={{ gap: 8 }}>
          {([
            ["overview", "总览"],
            ["instances", `供应商实例 (${instances.length})`],
            ["models", `模型与费率 (${models.length})`],
            ["budgets", "预算与成本策略"],
            ["invocations", "调用审计日志"],
            ["costs", "费用归集与对账"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`button sm${tab === key ? " primary" : ""}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {banner && <div className="line-note" style={{ marginTop: 10 }}>{banner}</div>}
      </Panel>

      {overview.error && <ErrorBlock error={overview.error} />}

      {tab === "overview" && d && (
        <Panel title="AI 运行与资金健康总览">
          <div className="row flexwrap" style={{ gap: 10 }}>
            <Tag tone={d.configured_ready_production ? "green" : "yellow"}>
              生产实例：{d.configured_ready_production ? "已批准就绪" : "未就绪（维持人工兜底）"}
            </Tag>
            <Tag tone="blue">沙箱约束：{String(d.sandbox_rule)}</Tag>
            <Tag tone="green">人工翻译兜底：{d.manual_fallback_available ? "始终可用" : "停用"}</Tag>
            <Tag tone="gray">客户侧AI附加费：{d.no_customer_surcharge ? "禁止加收" : "异常"}</Tag>
          </div>
          {d.metrics && (
            <div className="row flexwrap" style={{ gap: 16, marginTop: 12 }}>
              <div><strong>总调用：</strong>{d.metrics.total_calls}</div>
              <div><strong>成功：</strong>{d.metrics.succeeded_calls}</div>
              <div><strong>失败/拦截：</strong>{d.metrics.failed_calls}</div>
              <div><strong>超时未知待核：</strong>{d.metrics.unknown_timeout_calls}</div>
              <div><strong>累计估算成本(分)：</strong>{d.metrics.estimated_cost_cents}</div>
              <div><strong>待核冻结预算(分)：</strong>{d.metrics.unknown_reserved_cents}</div>
            </div>
          )}
        </Panel>
      )}

      {tab === "instances" && (
        <>
          <Panel title="已注册 AI 供应商实例">
            <Table
              headers={["标识", "显示名称", "适配器", "协议", "环境", "生命周期", "探测健康", "治理操作"]}
              empty="暂未配置任何 AI 供应商实例；无密钥时全站可保持纯人工翻译与固定双语运行。"
              rows={instances.map((r) => [
                <code key="k">{String(r.instance_key)}</code>,
                String(r.display_name ?? ""),
                <code key="a">{String(r.adapter_type)}</code>,
                <code key="p">{String(r.api_protocol)}</code>,
                <Tag key="e" tone={r.environment === "production" ? "blue" : "gray"}>{String(r.environment)}</Tag>,
                <Tag key="s" tone={STATUS_TONE[String(r.status)] ?? "gray"}>{String(r.status)}</Tag>,
                <Tag key="h" tone={HEALTH_TONE[String(r.last_health_status)] ?? "gray"}>{String(r.last_health_status)}</Tag>,
                <div key="act" className="row flexwrap" style={{ gap: 6 }}>
                  <button type="button" className="button sm" onClick={() => setSelectedInstanceId(String(r.id))}>选中</button>
                  {isSuperAdmin && (
                    <>
                      <Action sm run={async () => { const res = await request(`/staff/admin/ai/instances/${r.id}/probe`, "POST", {}) as { probe: { summary: string } }; setBanner(res.probe.summary); reloadAll(); }}>探测</Action>
                      <Action sm run={async () => { await request(`/staff/admin/ai/instances/${r.id}/approve`, "POST", {}); setBanner("实例已通过 SoD 审批"); reloadAll(); }}>审批上线</Action>
                      <Action sm run={async () => { await request(`/staff/admin/ai/instances/${r.id}/models/sync`, "POST", {}); setBanner("已完成模型列表同步尝试"); reloadAll(); }}>同步模型</Action>
                    </>
                  )}
                </div>,
              ])}
            />
          </Panel>

          {isSuperAdmin && (
            <div className="row flexwrap" style={{ gap: 16, alignItems: "flex-start" }}>
              <Panel title="新增 AI 供应商实例">
                <Form
                  label="创建实例草稿"
                  run={async (fd) => {
                    const res = await request("/staff/admin/ai/instances", "POST", {
                      instance_key: text(fd, "instance_key"),
                      display_name: text(fd, "display_name"),
                      adapter_type: text(fd, "adapter_type") || "openai_official",
                      api_protocol: text(fd, "api_protocol") || "openai_chat_completions",
                      environment: text(fd, "environment") || "test",
                      base_url: text(fd, "base_url") || "https://api.openai.com/v1",
                      data_region_policy: text(fd, "data_region_policy") || "US/Commercial API No-Training",
                      allowed_purposes: [...AI_PURPOSE_CODES],
                      requested_capabilities: ["language_translation_only"],
                      daily_budget_cents: Number(text(fd, "daily_budget_cents") || 500),
                      monthly_budget_cents: Number(text(fd, "monthly_budget_cents") || 5000),
                    }) as { instance: { id: string } };
                    setSelectedInstanceId(res.instance.id);
                    setBanner("已创建实例草稿（需独立配置密钥、探测并由另一管理员 SoD 审批）");
                    reloadAll();
                  }}
                >
                  <label>实例 Key <input name="instance_key" required placeholder="openai-test-1" /></label>
                  <label>名称 <input name="display_name" required placeholder="OpenAI Test Studio" /></label>
                  <label>适配器
                    <select name="adapter_type" defaultValue="openai_official">
                      <option value="openai_official">openai_official (OpenAI 官方)</option>
                      <option value="openai_compatible">openai_compatible (兼容 API)</option>
                    </select>
                  </label>
                  <label>协议
                    <select name="api_protocol" defaultValue="openai_chat_completions">
                      <option value="openai_chat_completions">openai_chat_completions</option>
                      <option value="openai_responses">openai_responses (仅官方)</option>
                    </select>
                  </label>
                  <label>环境
                    <select name="environment" defaultValue="test">
                      <option value="test">test (测试)</option>
                      <option value="production">production (生产)</option>
                    </select>
                  </label>
                  <label>HTTPS Base URL <input name="base_url" required defaultValue="https://api.openai.com/v1" /></label>
                  <label>数据合规政策 <input name="data_region_policy" required defaultValue="US/Commercial API No-Training" /></label>
                  <label>日预算上限(分) <input name="daily_budget_cents" type="number" defaultValue={500} /></label>
                  <label>月预算上限(分) <input name="monthly_budget_cents" type="number" defaultValue={5000} /></label>
                </Form>
              </Panel>

              <Panel title="实例凭证加密写入（永不回显明文）">
                <Form
                  label="加密写入/轮换密钥"
                  run={async (fd) => {
                    const id = text(fd, "instance_id") || activeInstanceId;
                    await request(`/staff/admin/ai/instances/${id}/secrets`, "POST", {
                      secret_name: text(fd, "secret_name") || "api_key",
                      secret_value: text(fd, "secret_value"),
                    });
                    setBanner("密钥已加密存储（实例健康状态重置为待重新探测）");
                    reloadAll();
                  }}
                >
                  <label>目标实例 ID <input key={`secret-inst-${activeInstanceId}`} name="instance_id" required defaultValue={activeInstanceId} /></label>
                  <label>凭证类型
                    <select name="secret_name" defaultValue="api_key">
                      <option value="api_key">api_key</option>
                      <option value="organization_header">organization_header</option>
                      <option value="project_header">project_header</option>
                    </select>
                  </label>
                  <label>Secret 值 <input name="secret_value" type="password" required autoComplete="off" /></label>
                </Form>
                <Table
                  headers={["凭证", "版本", "掩码", "状态"]}
                  empty="暂无已配置凭证"
                  rows={secrets.map((r) => [
                    String(r.secret_name ?? ""),
                    `v${r.version}`,
                    <code key="m">{String(r.masked_preview ?? "")}</code>,
                    <Tag key="st" tone={r.status === "active" ? "green" : "gray"}>{String(r.status)}</Tag>,
                  ])}
                />
              </Panel>
            </div>
          )}
        </>
      )}

      {tab === "models" && (
        <>
          <Panel title="模型目录与合成句结构化实测">
            <Table
              headers={["请求模型 ID", "实际快照", "来源", "测试", "审批", "操作"]}
              empty="暂无已注册模型"
              rows={models.map((r) => [
                <code key="rm">{String(r.requested_model_id)}</code>,
                <code key="om">{String(r.observed_model_snapshot ?? "未知")}</code>,
                String(r.source_discovery ?? ""),
                <Tag key="ts" tone={r.last_test_status === "passed" ? "green" : r.last_test_status === "failed" ? "red" : "gray"}>{String(r.last_test_status)}</Tag>,
                <Tag key="ap" tone={r.approved ? "green" : "yellow"}>{r.approved ? "已批准" : "未批准"}</Tag>,
                <div key="act" className="row flexwrap" style={{ gap: 6 }}>
                  <button type="button" className="button sm" onClick={() => setSelectedModelId(String(r.id))}>选中</button>
                  {isSuperAdmin && (
                    <>
                      <Action sm run={async () => { const res = await request(`/staff/admin/ai/models/${r.id}/test`, "POST", { target_locale: "zh-CN" }) as { ok: boolean }; setBanner(res.ok ? "合成句结构化翻译测试通过" : "合成测试未通过，请查调用日志"); reloadAll(); }}>合成测试</Action>
                      <Action sm run={async () => { await request(`/staff/admin/ai/models/${r.id}/approve`, "POST", {}); setBanner("模型已通过 SoD 审批"); reloadAll(); }}>审批模型</Action>
                    </>
                  )}
                </div>,
              ])}
            />
          </Panel>
          {isSuperAdmin && (
            <div className="row flexwrap" style={{ gap: 16 }}>
              <Panel title="手工登记精确模型 ID">
                <Form
                  label="登记模型"
                  run={async (fd) => {
                    const id = text(fd, "instance_id") || activeInstanceId;
                    const res = await request(`/staff/admin/ai/instances/${id}/models`, "POST", {
                      requested_model_id: text(fd, "requested_model_id"),
                      supports_structured_output: text(fd, "supports_structured_output") === "1",
                    }) as { model: { id: string } };
                    setSelectedModelId(res.model.id);
                    setBanner("已手动登记模型");
                    reloadAll();
                  }}
                >
                  <label>实例 ID <input key={`model-inst-${activeInstanceId}`} name="instance_id" required defaultValue={activeInstanceId} /></label>
                  <label>Model ID <input name="requested_model_id" required placeholder="gpt-4o-mini" /></label>
                  <label>结构化输出
                    <select name="supports_structured_output" defaultValue="1">
                      <option value="1">支持 strict json_schema</option>
                      <option value="0">仅 json_object / 文本</option>
                    </select>
                  </label>
                </Form>
              </Panel>
              <Panel title="追加不可变费率版本 (micros/1k tokens)">
                <Form
                  label="追加费率版本"
                  run={async (fd) => {
                    const mid = text(fd, "model_id") || activeModelId;
                    await request(`/staff/admin/ai/models/${mid}/rates`, "POST", {
                      currency: "USD",
                      input_micros_per_1k_tokens: Number(text(fd, "input_micros") || 150),
                      output_micros_per_1k_tokens: Number(text(fd, "output_micros") || 600),
                      rate_source: text(fd, "rate_source") || "official_schedule",
                    });
                    setBanner("已追加不可变费率新版本");
                    reloadAll();
                  }}
                >
                  <label>模型 ID <input key={`rate-model-${activeModelId}`} name="model_id" required defaultValue={activeModelId} /></label>
                  <label>输入单价(micros/1k) <input name="input_micros" type="number" defaultValue={150} /></label>
                  <label>输出单价(micros/1k) <input name="output_micros" type="number" defaultValue={600} /></label>
                  <label>费率来源
                    <select name="rate_source" defaultValue="official_schedule">
                      <option value="official_schedule">official_schedule</option>
                      <option value="contract_rate">contract_rate</option>
                      <option value="unknown">unknown</option>
                    </select>
                  </label>
                </Form>
              </Panel>
            </div>
          )}
        </>
      )}

      {tab === "budgets" && (
        <Panel title="全局 / 实例 / 用途硬预算策略">
          <Table
            headers={["作用域", "范围键", "周期", "硬限额(分)", "单次上限(分)"]}
            empty="暂无自定义全局/用途预算策略（仅受各实例自身日/月预算上限约束）"
            rows={policies.map((r) => [
              String(r.scope_type ?? ""),
              <code key="sk">{String(r.scope_key)}</code>,
              String(r.period_type ?? ""),
              String(r.hard_limit_cents ?? 0),
              String(r.max_single_call_cents ?? "-"),
            ])}
          />
          {isSuperAdmin && (
            <Form
              label="保存预算策略"
              run={async (fd) => {
                await request("/staff/admin/ai/budget-policies", "POST", {
                  scope_type: text(fd, "scope_type") || "global",
                  scope_key: text(fd, "scope_key") || "global",
                  period_type: text(fd, "period_type") || "daily",
                  hard_limit_cents: Number(text(fd, "hard_limit_cents") || 1000),
                  approved: true,
                });
                setBanner("预算策略已生效");
                reloadAll();
              }}
            >
              <label>作用域
                <select name="scope_type" defaultValue="global">
                  <option value="global">global</option>
                  <option value="instance">instance</option>
                  <option value="purpose">purpose</option>
                </select>
              </label>
              <label>Scope Key <input name="scope_key" required defaultValue="global" /></label>
              <label>周期
                <select name="period_type" defaultValue="daily">
                  <option value="daily">daily</option>
                  <option value="monthly">monthly</option>
                </select>
              </label>
              <label>硬上限(分) <input name="hard_limit_cents" type="number" defaultValue={1000} /></label>
            </Form>
          )}
        </Panel>
      )}

      {tab === "invocations" && (
        <Panel title="调用审计流水（脱敏元数据，不存原文/密钥）">
          <Table
            headers={["时间", "动作", "用途", "状态", "错误码", "费用状态", "估算(分)"]}
            empty="暂无 AI 调用记录"
            rows={(((invocations.data as { invocations?: Row[] } | undefined)?.invocations) ?? []).map((r) => [
              stamp(String(r.created_at ?? "")),
              <code key="ik">{String(r.invocation_kind)}</code>,
              <code key="pc">{String(r.purpose_code)}</code>,
              <Tag key="st" tone={r.status === "succeeded" ? "green" : r.status === "timeout_unknown" ? "yellow" : "red"}>{String(r.status)}</Tag>,
              <code key="ec">{String(r.error_code ?? "-")}</code>,
              String(r.cost_status ?? ""),
              r.cost_cents === null ? "待核(NULL)" : String(r.cost_cents),
            ])}
          />
        </Panel>
      )}

      {tab === "costs" && (
        <Panel title="费用归集台账与账单对账">
          <Table
            headers={["归属对象", "调用次数", "已知估算总额(分)", "未知待核笔数"]}
            empty="暂无成本归集数据"
            rows={(((costLedger.data as { by_cost_center?: Row[] } | undefined)?.by_cost_center) ?? []).map((r) => [
              <code key="cc">{String(r.cost_center)}</code>,
              String(r.call_count),
              String(r.known_estimated_cents),
              String(r.unknown_pending_count),
            ])}
          />
        </Panel>
      )}
    </div>
  );
}
