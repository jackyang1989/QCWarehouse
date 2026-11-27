"use client";

import { useState } from "react";
import { Action, Form, Panel, RequestError, Table, Tag, request, stamp, text, useLoad, type Row } from "./ui";
import { CopyId, StatusBanner } from "./admin-labels";
import type { Actor } from "../packages/core/common";

const LIFECYCLE_TONE: Record<string, { label: string; tone: "green" | "blue" | "yellow" | "gray" }> = {
  active: { label: "已启用写入", tone: "green" },
  verified: { label: "探针已通过", tone: "blue" },
  draft: { label: "草稿待验证", tone: "yellow" },
  read_only_legacy: { label: "历史只读停写", tone: "yellow" },
  disabled: { label: "已停用", tone: "gray" },
};

const HEALTH_TONE: Record<string, { label: string; tone: "green" | "yellow" | "red" | "gray" }> = {
  verified: { label: "真实读写与CORS通过", tone: "green" },
  unconfigured: { label: "缺加密密钥", tone: "yellow" },
  degraded: { label: "降级", tone: "yellow" },
  error: { label: "探针失败", tone: "red" },
  unknown: { label: "未验证", tone: "gray" },
};

function formatBytes(raw: unknown): string {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function AdminStorageDesk({ actor }: { actor: Actor }) {
  const isSuperAdmin = actor.roles.includes("super_admin");
  const { data, error, reload } = useLoad("/staff/admin/storage/instances");
  const migrationsLoad = useLoad("/staff/admin/storage/migrations");
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "error" | "success"; text: string }>();
  const [actionError, setActionError] = useState<string>();
  const [reauthNeeded, setReauthNeeded] = useState(false);

  const jobDetailLoad = useLoad(selectedJobId ? `/staff/admin/storage/migrations/${selectedJobId}` : null);
  const instances: Row[] = data?.instances ?? [];
  const presets: Row[] = data?.presets ?? [];
  const usage: Row | undefined = data?.usage;
  const migrationJobs: Row[] = migrationsLoad.data?.jobs ?? [];
  const selected: Row | undefined = instances.find((i) => i.id === selectedId) ?? instances[0];

  function handleError(e: unknown) {
    if (e instanceof RequestError && e.code === "STAFF_REAUTH_REQUIRED") setReauthNeeded(true);
    setActionError(e instanceof Error ? e.message : "操作失败");
  }

  return (
    <div className="stack">
      {reauthNeeded && (
        <StatusBanner tone="warning" title="需要重新验证身份">
          修改对象存储实例、保存加密密钥、运行探针或切换主存储需要近期 MFA 重认证。
        </StatusBanner>
      )}
      {notice && (
        <StatusBanner tone={notice.tone} title="对象存储控制中心">
          {notice.text}
        </StatusBanner>
      )}
      {actionError && <StatusBanner tone="error" title="操作受阻">{actionError}</StatusBanner>}
      {error && <StatusBanner tone="error" title="加载失败">{error}</StatusBanner>}

      <Panel
        title="对象存储多实例中心 (PAGE-M21)"
        subtitle="支持 R2 / S3 / B2 / 通用 S3 多实例分角色管理、AES-GCM 密文凭证、真实 RW+Range+Multipart+CORS 探针与无停机切换"
      >
        <div className="split-grid" style={{ marginBottom: 14 }}>
          <div className="panel" style={{ padding: 12 }}>
            <strong>24h 请求与隔离统计</strong>
            <p className="small muted">
              预签名上传 {usage?.requests_24h?.presign_puts ?? 0} · 预签名下载 {usage?.requests_24h?.presign_gets ?? 0} ·
              流式读取 {usage?.requests_24h?.stream_reads ?? 0} · Range 206 {usage?.requests_24h?.range_reads ?? 0} ·
              安全隔离 {usage?.requests_24h?.quarantines ?? 0}
            </p>
          </div>
          <div className="panel" style={{ padding: 12 }}>
            <strong>历史 private_files 迁移盘点</strong>
            <p className="small muted">
              存量对象 {usage?.legacy_private_files?.legacy_files ?? 0} 条 ·
              容量 {formatBytes(usage?.legacy_private_files?.legacy_bytes)} ·
              关联媒体 {usage?.legacy_private_files?.media_asset_refs ?? 0} / PDF 报告 {usage?.legacy_private_files?.report_pdf_refs ?? 0}
            </p>
          </div>
        </div>

        <Table
          headers={["实例标识", "类型 / 角色", "域隔离", "环境", "状态", "健康度", "Bucket", "操作"]}
          rows={instances.map((inst) => {
            const lf = LIFECYCLE_TONE[inst.lifecycle_state] ?? { label: inst.lifecycle_state, tone: "gray" as const };
            const hl = HEALTH_TONE[inst.health_status] ?? { label: inst.health_status, tone: "gray" as const };
            return [
              <div key="k" className="cell-stack">
                <strong>{inst.display_name}</strong>
                <code className="code">{inst.instance_key}</code>
              </div>,
              <div key="r" className="cell-stack">
                <span>{inst.provider_type}</span>
                <small className="code">{inst.storage_role}</small>
              </div>,
              <Tag key="v" tone={inst.visibility_scope === "public_assets" ? "blue" : "green"}>
                {inst.visibility_scope === "public_assets" ? "公开素材桶" : "私有证据桶"}
              </Tag>,
              <Tag key="e" tone={inst.environment === "live" ? "red" : "gray"}>{inst.environment}</Tag>,
              <Tag key="l" tone={lf.tone}>{lf.label}</Tag>,
              <Tag key="h" tone={hl.tone}>{hl.label}</Tag>,
              <code key="b" className="code">{inst.bucket}</code>,
              <Action key="sel" sm run={async () => setSelectedId(inst.id)}>
                {selected?.id === inst.id ? "当前选中" : "管理"}
              </Action>,
            ];
          })}
        />
      </Panel>

      {selected && (
        <Panel
          title={`实例控制台：${selected.display_name} (${selected.instance_key})`}
          subtitle={`Bucket: ${selected.bucket} · Endpoint: ${selected.endpoint_url} · 允许写入=${String(selected.allow_new_writes)} · 允许读取=${String(selected.allow_reads)}`}
        >
          {selected.last_probe_summary && (
            <p className="small" style={{ marginBottom: 10 }}>
              <strong>最近真实探针结论：</strong> {selected.last_probe_summary}
              {selected.last_error_class ? <Tag tone="red">{selected.last_error_class}</Tag> : null}
            </p>
          )}

          {isSuperAdmin && (
            <div className="button-row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
              <Action
                run={async () => {
                  setActionError(undefined);
                  try {
                    const res = await request(`/staff/admin/storage/instances/${selected.id}/probe`, "POST", {});
                    setNotice({
                      tone: res.ok ? "success" : "error",
                      text: `[真实探针 · ${res.latency_ms ?? 0}ms] ${res.summary}`,
                    });
                    reload();
                  } catch (e) {
                    handleError(e);
                  }
                }}
              >
                运行真实读写 + 分片 + Range206 + CORS 探针
              </Action>
              {selected.storage_role === "primary" || selected.storage_role === "public_assets" ? (
                <Action
                  run={async () => {
                    setActionError(undefined);
                    try {
                      const res = await request("/staff/admin/storage/switch-primary", "POST", {
                        target_instance_id: selected.id,
                        reason: "Operator primary storage switch via PAGE-M21",
                      });
                      setNotice({
                        tone: "success",
                        text: `主存储切换完成：${res.active_instance?.instance_key} 已激活，旧实例已降为 read_only_legacy（历史可读）。`,
                      });
                      reload();
                    } catch (e) {
                      handleError(e);
                    }
                  }}
                >
                  切换为当前环境主写入实例（原主保留只读）
                </Action>
              ) : null}
              <Action
                run={async () => {
                  setActionError(undefined);
                  try {
                    await request(`/staff/admin/storage/instances/${selected.id}/state`, "POST", {
                      lifecycle_state: "read_only_legacy",
                      allow_new_writes: false,
                      allow_reads: true,
                      reason: "Operator paused new writes while retaining historical reads",
                    });
                    setNotice({ tone: "info", text: `${selected.instance_key} 已停写，历史文件读取不受影响。` });
                    reload();
                  } catch (e) {
                    handleError(e);
                  }
                }}
              >
                停写保留历史读取 (read_only_legacy)
              </Action>
            </div>
          )}

          <h3>加密凭证管理（只写不读，仅展示掩码与版本）</h3>
          <Table
            headers={["凭证字段", "当前掩码", "版本", "状态", "时间", "操作"]}
            rows={(selected.secrets ?? []).map((s: Row) => [
              <code key="n" className="code">{s.secret_name}</code>,
              <code key="m" className="code">{s.masked_hint}</code>,
              `v${s.key_version}`,
              <Tag key="st" tone={s.status === "active" ? "green" : s.status === "rotated" ? "blue" : "red"}>{s.status}</Tag>,
              <span key="t" className="small">{stamp(s.created_at, true)}</span>,
              isSuperAdmin ? (
                s.status === "active" ? (
                  <Action
                    key="rv"
                    sm
                    run={async () => {
                      setActionError(undefined);
                      try {
                        await request(`/staff/admin/storage/instances/${selected.id}/secrets/revoke`, "POST", {
                          secret_name: s.secret_name,
                        });
                        setNotice({ tone: "warning", text: `已吊销 ${s.secret_name}，关联实例写权限已安全阻断。` });
                        reload();
                      } catch (e) {
                        handleError(e);
                      }
                    }}
                  >
                    吊销
                  </Action>
                ) : s.status === "rotated" ? (
                  <Action
                    key="rb"
                    sm
                    run={async () => {
                      setActionError(undefined);
                      try {
                        await request(`/staff/admin/storage/instances/${selected.id}/secrets/rollback`, "POST", {
                          secret_name: s.secret_name,
                          target_version: s.key_version,
                        });
                        setNotice({ tone: "success", text: `已回滚 ${s.secret_name} 至版本 v${s.key_version}。` });
                        reload();
                      } catch (e) {
                        handleError(e);
                      }
                    }}
                  >
                    回滚到此版本
                  </Action>
                ) : (
                  "—"
                )
              ) : (
                "—"
              ),
            ])}
          />

          {isSuperAdmin && (
            <Form
              label="录入或轮换实例密钥（Access Key ID / Secret Access Key）"
              run={async (f) => {
                try {
                  const res = await request(`/staff/admin/storage/instances/${selected.id}/secrets`, "POST", {
                    secret_name: text(f, "secret_name"),
                    secret_value: text(f, "secret_value"),
                  });
                  setActionError(undefined);
                  setNotice({ tone: "success", text: `已加密保存 ${res.secret_name} (${res.masked_hint}, v${res.key_version})。` });
                  reload();
                } catch (e) {
                  handleError(e);
                  throw e;
                }
              }}
            >
              <div className="filters-grid">
                <label>
                  凭证字段
                  <select name="secret_name" defaultValue="access_key_id">
                    <option value="access_key_id">access_key_id</option>
                    <option value="secret_access_key">secret_access_key</option>
                    <option value="session_token">session_token（可选临时凭证）</option>
                  </select>
                </label>
                <label>
                  密钥明文（加密后永不回显）
                  <input type="password" name="secret_value" required placeholder="输入凭证" />
                </label>
              </div>
            </Form>
          )}
        </Panel>
      )}

      {isSuperAdmin && (
        <Panel title="新增对象存储实例" subtitle="业务 Bucket 默认私有；公开官网素材须单独配置 public_assets 实例">
          <p className="small muted">
            可用预设：{presets.map((p) => `${p.display_name} (${p.default_addressing_style}, region=${p.default_region})`).join(" · ")}
          </p>
          <Form
            label="创建存储实例草稿"
            run={async (f) => {
              try {
                const cors = text(f, "allowed_cors_origins")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                const res = await request("/staff/admin/storage/instances", "POST", {
                  instance_key: text(f, "instance_key"),
                  display_name: text(f, "display_name"),
                  provider_type: text(f, "provider_type"),
                  storage_role: text(f, "storage_role"),
                  environment: text(f, "environment"),
                  endpoint_url: text(f, "endpoint_url"),
                  region: text(f, "region") || "auto",
                  bucket: text(f, "bucket"),
                  addressing_style: text(f, "addressing_style"),
                  allowed_cors_origins: cors,
                });
                setSelectedId(res.instance.id);
                setActionError(undefined);
                setNotice({ tone: "success", text: `已创建存储实例 ${res.instance.instance_key}（请保存密钥后运行真实探针）。` });
                reload();
              } catch (e) {
                handleError(e);
                throw e;
              }
            }}
          >
            <div className="filters-grid">
              <label>
                实例标识 (Key)
                <input name="instance_key" placeholder="r2-live-primary" required />
              </label>
              <label>
                显示名称
                <input name="display_name" placeholder="Cloudflare R2 主证据存储" required />
              </label>
              <label>
                服务商类型
                <select name="provider_type" defaultValue="cloudflare_r2">
                  <option value="cloudflare_r2">Cloudflare R2</option>
                  <option value="amazon_s3">Amazon S3</option>
                  <option value="backblaze_b2">Backblaze B2</option>
                  <option value="generic_s3">Generic S3</option>
                </select>
              </label>
              <label>
                存储角色
                <select name="storage_role" defaultValue="primary">
                  <option value="primary">primary（正式主写入）</option>
                  <option value="secondary_failover">secondary_failover（备用实例）</option>
                  <option value="independent_backup">independent_backup（独立异地备份）</option>
                  <option value="archive">archive（归档只读）</option>
                  <option value="public_assets">public_assets（公开官网素材库）</option>
                  <option value="test_sandbox">test_sandbox（测试沙盒）</option>
                </select>
              </label>
              <label>
                环境隔离
                <select name="environment" defaultValue="sandbox">
                  <option value="sandbox">sandbox（沙盒）</option>
                  <option value="live">live（生产）</option>
                </select>
              </label>
              <label>
                寻址风格
                <select name="addressing_style" defaultValue="path">
                  <option value="path">path-style</option>
                  <option value="virtual_hosted">virtual-hosted-style</option>
                </select>
              </label>
              <label>
                HTTPS Endpoint
                <input name="endpoint_url" placeholder="https://<account>.r2.cloudflarestorage.com" required />
              </label>
              <label>
                Region
                <input name="region" defaultValue="auto" required />
              </label>
              <label>
                Bucket 名称
                <input name="bucket" placeholder="qcw-evidence-private" required />
              </label>
              <label>
                明确 CORS 站点来源（逗号分隔，禁止 *）
                <input name="allowed_cors_origins" placeholder="https://app.qcwarehouse.com" />
              </label>
            </div>
          </Form>
        </Panel>
      )}

      <Panel
        title="历史 private_files 迁移准备与可控执行 (§40)"
        subtitle="采用 expand -> migrate -> verify 非破坏模式，保留原始 private_files 副本，支持逐条 SHA-256 校验、暂停/恢复、失败重试与回滚"
      >
        {isSuperAdmin && selected && selected.visibility_scope === "private_evidence" && selected.allow_new_writes && (
          <div style={{ marginBottom: 12 }}>
            <Action
              run={async () => {
                setActionError(undefined);
                try {
                  const res = await request("/staff/admin/storage/migrations", "POST", {
                    target_instance_id: selected.id,
                    batch_size: 20,
                  });
                  setSelectedJobId(res.job.id);
                  setNotice({
                    tone: "success",
                    text: `已生成迁移作业 ${res.job.job_key}（共 ${res.job.total_objects} 个对象 / 引用 ${res.job.source_reference_count} 次）。`,
                  });
                  migrationsLoad.reload();
                } catch (e) {
                  handleError(e);
                }
              }}
            >
              为当前选中实例 ({selected.instance_key}) 建立历史迁移清单
            </Action>
          </div>
        )}
        <Table
          headers={["作业编号", "目标实例", "阶段/状态", "对象进度", "引用核验", "创建时间", "控制"]}
          rows={migrationJobs.map((j) => [
            <CopyId key="k" value={j.job_key} />,
            <code key="t" className="code">{j.target_instance_key} ({j.target_bucket})</code>,
            <Tag key="s" tone={j.status === "completed" ? "green" : j.status === "failed" || j.status === "completed_with_errors" ? "red" : "blue"}>
              {j.phase} · {j.status}
            </Tag>,
            `${j.verified_objects}/${j.total_objects} (失败 ${j.failed_objects})`,
            `${j.verified_reference_count}/${j.source_reference_count}`,
            <span key="c" className="small">{stamp(j.created_at, true)}</span>,
            <div key="act" className="button-row">
              <Action sm run={async () => setSelectedJobId(j.id)}>
                详情
              </Action>
              {isSuperAdmin && (
                <Action
                  sm
                  run={async () => {
                    await request(`/staff/admin/storage/migrations/${j.id}/run`, "POST", {});
                    setSelectedJobId(j.id);
                    migrationsLoad.reload();
                    jobDetailLoad.reload();
                  }}
                >
                  执行批次
                </Action>
              )}
            </div>,
          ])}
        />
        {jobDetailLoad.data?.job && (
          <p className="small muted" style={{ marginTop: 10 }}>
            当前迁移作业 {jobDetailLoad.data.job.job_key}：保留源副本={String(jobDetailLoad.data.job.retain_source_copy)} · 明细条数 {(jobDetailLoad.data.items ?? []).length}
          </p>
        )}
      </Panel>
    </div>
  );
}
