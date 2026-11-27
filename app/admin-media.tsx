"use client";

import Link from "next/link";
import { useState } from "react";
import { Action, Form, Panel, RequestError, Table, Tag, request, stamp, text, useLoad, type Row } from "./ui";
import { StatusBanner } from "./admin-labels";
import type { Actor } from "../packages/core/common";

const TRUST_TONE: Record<string, { label: string; tone: "green" | "blue" | "yellow" | "red" | "gray" }> = {
  system_captured: { label: "系统直采可信", tone: "green" },
  offline_synced: { label: "离线回传可信", tone: "blue" },
  device_clock_skewed: { label: "设备时钟偏差", tone: "yellow" },
  exif_only: { label: "EXIF元数据推断", tone: "yellow" },
  user_declared: { label: "用户/员工自报", tone: "yellow" },
  legacy_unknown: { label: "历史未知来源", tone: "gray" },
  device_test: { label: "设备测试样张", tone: "gray" },
};

const STATE_TONE: Record<string, { label: string; tone: "green" | "blue" | "yellow" | "red" | "gray" }> = {
  ready: { label: "可用就绪", tone: "green" },
  awaiting_upload: { label: "待上传", tone: "yellow" },
  uploaded_unverified: { label: "待校验", tone: "blue" },
  scanning: { label: "扫描中", tone: "blue" },
  processing: { label: "派生处理中", tone: "blue" },
  quarantined: { label: "已隔离待复核", tone: "red" },
  failed: { label: "处理失败", tone: "red" },
  cancelled: { label: "已受控删除/作废", tone: "gray" },
};

function formatBytes(raw: unknown): string {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function AdminMediaCenterDesk({ actor }: { actor: Actor }) {
  const isSuperAdmin = actor.roles.includes("super_admin");
  const isWarehouseAdmin = actor.roles.includes("warehouse_admin") || isSuperAdmin;
  const [viewMode, setViewMode] = useState<"table" | "gallery">("table");
  const [tab, setTab] = useState<"media" | "exports" | "retention" | "reconcile">("media");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    date_basis: "uploaded_at",
    date_from: "",
    date_to: "",
    media_kind: "",
    source_trust_level: "",
    processing_state: "",
    has_report_citation: "",
    include_device_test: "false",
    q: "",
  });

  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("page_size", "24");
  for (const [k, v] of Object.entries(filters)) {
    if (v) qs.set(k, v);
  }

  const mediaLoad = useLoad(`/staff/admin/media?${qs.toString()}`);
  const statsLoad = useLoad("/staff/admin/media/stats");
  const exportsLoad = useLoad("/staff/admin/media/exports");
  const retentionLoad = useLoad("/staff/admin/media/retention-requests");
  const reconcileLoad = useLoad("/staff/admin/media/reconcile");
  const tombstonesLoad = useLoad(isWarehouseAdmin ? "/staff/admin/media/recovery/tombstones" : null);

  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "error" | "success"; text: string }>();
  const [actionError, setActionError] = useState<string>();

  const items: Row[] = mediaLoad.data?.items ?? [];
  const total: number = mediaLoad.data?.total ?? 0;
  const caps = mediaLoad.data?.view_capabilities ?? {};
  const stats = statsLoad.data;

  function onErr(e: unknown) {
    setActionError(e instanceof RequestError || e instanceof Error ? e.message : "操作失败");
  }

  function reloadAll() {
    mediaLoad.reload();
    statsLoad.reload();
    exportsLoad.reload();
    retentionLoad.reload();
    reconcileLoad.reload();
    if (isWarehouseAdmin) tombstonesLoad.reload();
  }

  return (
    <div className="stack">
      {notice && <StatusBanner tone={notice.tone} title="媒体与证据中心">{notice.text}</StatusBanner>}
      {actionError && <StatusBanner tone="error" title="操作受阻">{actionError}</StatusBanner>}
      {mediaLoad.error && <StatusBanner tone="error" title="列表加载失败">{mediaLoad.error}</StatusBanner>}

      <Panel
        title="全局媒体与证据中心 (PAGE-M41)"
        subtitle="原件不可覆盖、时间与责任人真实可信、物理存储字节去重核算与历史兼容迁移对账"
      >
        {stats && (
          <div className="split-grid" style={{ marginBottom: 14 }}>
            <div className="panel" style={{ padding: 12 }}>
              <strong>真实采集与逻辑引用统计</strong>
              <p className="small muted">
                业务直采 {stats.counts?.business_captures_count ?? 0} ·
                导入 {stats.counts?.imported_count ?? 0} ·
                客户附件 {stats.counts?.customer_attachment_count ?? 0} ·
                历史未知 {stats.counts?.legacy_unknown_count ?? 0} ·
                报告引用/选用 {stats.counts?.qa_selected_or_cited_count ?? 0} ·
                逻辑引用总数 {stats.counts?.logical_entity_links_count ?? 0}
              </p>
              <p className="small muted">
                去重物理对象：原件 {stats.counts?.unique_original_objects_count ?? 0} / 派生 {stats.counts?.unique_variant_objects_count ?? 0}（同一原图多报告引用不重复计费）
              </p>
            </div>
            <div className="panel" style={{ padding: 12 }}>
              <strong>物理字节与真实成本口径</strong>
              <p className="small muted">
                原件 {formatBytes(stats.physical_bytes?.originals_bytes)} ·
                派生 {formatBytes(stats.physical_bytes?.variants_bytes)} ·
                隔离 {formatBytes(stats.physical_bytes?.quarantined_bytes)} ·
                归档 {formatBytes(stats.physical_bytes?.archived_bytes)} ·
                存量未清库 {formatBytes(stats.physical_bytes?.legacy_private_files_bytes)}
              </p>
              <p className="small muted">
                成本口径：<strong>{stats.cost_accounting?.cost_basis === "estimated_rate_card" ? `费率估算 (${stats.cost_accounting.currency} ${(Number(stats.cost_accounting.estimated_monthly_cost_cents ?? 0) / 100).toFixed(2)}/月)` : "未知（未配置批准费率/真实账单，不以 0 冒充）"}</strong>
              </p>
            </div>
          </div>
        )}

        <div className="actions" style={{ marginBottom: 12 }}>
          <Action sm run={async () => setTab("media")}>{tab === "media" ? "● 媒体列表" : "媒体列表"}</Action>
          <Action sm run={async () => setTab("exports")}>{tab === "exports" ? "● 私有导出任务" : "私有导出任务"}</Action>
          <Action sm run={async () => setTab("retention")}>{tab === "retention" ? "● 保留与删除审批" : "保留与删除审批"}</Action>
          <Action sm run={async () => setTab("reconcile")}>{tab === "reconcile" ? "● 守恒对账与恢复" : "守恒对账与恢复"}</Action>
        </div>

        {tab === "media" && (
          <>
            <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
              <div className="actions" style={{ flexWrap: "wrap", gap: 8 }}>
                <label className="small">
                  时间维度{" "}
                  <select
                    value={filters.date_basis}
                    onChange={(e) => {
                      setFilters({ ...filters, date_basis: e.target.value });
                      setPage(1);
                    }}
                  >
                    <option value="uploaded_at">按服务端上传时间</option>
                    <option value="captured_at">按实际拍摄时间（未知时间不塞入）</option>
                  </select>
                </label>
                <label className="small">
                  开始日期{" "}
                  <input
                    type="date"
                    value={filters.date_from}
                    onChange={(e) => {
                      setFilters({ ...filters, date_from: e.target.value });
                      setPage(1);
                    }}
                  />
                </label>
                <label className="small">
                  结束日期{" "}
                  <input
                    type="date"
                    value={filters.date_to}
                    onChange={(e) => {
                      setFilters({ ...filters, date_to: e.target.value });
                      setPage(1);
                    }}
                  />
                </label>
                <label className="small">
                  类型{" "}
                  <select
                    value={filters.media_kind}
                    onChange={(e) => {
                      setFilters({ ...filters, media_kind: e.target.value });
                      setPage(1);
                    }}
                  >
                    <option value="">全部</option>
                    <option value="photo">照片</option>
                    <option value="video">视频</option>
                    <option value="document">文档</option>
                  </select>
                </label>
                <label className="small">
                  可信度{" "}
                  <select
                    value={filters.source_trust_level}
                    onChange={(e) => {
                      setFilters({ ...filters, source_trust_level: e.target.value });
                      setPage(1);
                    }}
                  >
                    <option value="">全部</option>
                    <option value="system_captured">系统直采</option>
                    <option value="offline_synced">离线同步</option>
                    <option value="device_clock_skewed">时钟偏差</option>
                    <option value="exif_only">EXIF推断</option>
                    <option value="user_declared">用户声明</option>
                    <option value="legacy_unknown">历史未知</option>
                  </select>
                </label>
                <label className="small">
                  状态{" "}
                  <select
                    value={filters.processing_state}
                    onChange={(e) => {
                      setFilters({ ...filters, processing_state: e.target.value });
                      setPage(1);
                    }}
                  >
                    <option value="">全部</option>
                    <option value="ready">就绪</option>
                    <option value="quarantined">隔离</option>
                    <option value="awaiting_upload">待传</option>
                    <option value="failed">失败</option>
                    <option value="cancelled">已删除/作废</option>
                  </select>
                </label>
                <label className="small">
                  关键词{" "}
                  <input
                    placeholder="订单号 / 实物码 / SHA256"
                    value={filters.q}
                    onChange={(e) => {
                      setFilters({ ...filters, q: e.target.value });
                      setPage(1);
                    }}
                  />
                </label>
                <Action sm run={async () => setViewMode(viewMode === "table" ? "gallery" : "table")}>
                  {viewMode === "table" ? "切换图库视图" : "切换表格视图"}
                </Action>
              </div>
              <p className="small muted" style={{ marginTop: 6 }}>
                共 {total} 条证据（第 {page} 页，严格按 RBAC 作用域分页，列表不预载高清原件与视频流；{mediaLoad.data?.disclaimers?.employee_count ?? ""}）
              </p>
            </div>

            {viewMode === "table" ? (
              <Table
                headers={["媒体与来源", "时间真实性", "设备与责任人员", "业务关联", "状态 / 规格", "详情"]}
                rows={items.map((item) => {
                  const tr = TRUST_TONE[item.source_trust_level] ?? { label: item.source_trust_level, tone: "gray" as const };
                  const st = STATE_TONE[item.processing_state] ?? { label: item.processing_state, tone: "gray" as const };
                  return [
                    <div key="id" className="cell-stack">
                      <code className="code">{item.capture_key}</code>
                      <Tag tone={tr.tone}>{tr.label}</Tag>
                      <small className="muted">{item.source_type} · {item.evidence_purpose}</small>
                    </div>,
                    <div key="t" className="cell-stack">
                      <span>拍摄：{item.actual_captured_at ? stamp(item.actual_captured_at) : `未知 (${item.time_unknown_reason ?? "legacy"})`}</span>
                      <small className="muted">上传：{stamp(item.server_received_at)} · 来源：{item.time_source}</small>
                    </div>,
                    <div key="who" className="cell-stack">
                      <span>设备：{item.device_code ?? "未知/非直采"}</span>
                      <small className="muted">
                        拍摄责任：{item.capture_author_name ?? "未知"} · 上传：{item.uploader_name ?? item.uploader_user_id}
                      </small>
                    </div>,
                    <div key="links" className="cell-stack">
                      {(item.links ?? []).length === 0 ? (
                        <small className="muted">未关联业务对象</small>
                      ) : (
                        (item.links ?? []).slice(0, 3).map((l: Row, idx: number) => (
                          <small key={idx} className="code">
                            {l.entity_type}: {l.order_no ?? l.item_code ?? l.package_code ?? l.entity_id.slice(0, 8)}
                          </small>
                        ))
                      )}
                    </div>,
                    <div key="st" className="cell-stack">
                      <Tag tone={st.tone}>{st.label}</Tag>
                      {item.legal_hold && <Tag tone="red">争议冻结</Tag>}
                      <small className="muted">{item.original_mime} · {formatBytes(item.original_size_bytes)}</small>
                    </div>,
                    <Link key="go" className="button small" href={item.detail_path}>查看详情</Link>,
                  ];
                })}
              />
            ) : (
              <div className="split-grid">
                {items.map((item) => {
                  const st = STATE_TONE[item.processing_state] ?? { label: item.processing_state, tone: "gray" as const };
                  return (
                    <div key={item.id} className="panel" style={{ padding: 12 }}>
                      <div className="actions" style={{ justifyContent: "space-between" }}>
                        <strong>{item.media_kind.toUpperCase()}</strong>
                        <Tag tone={st.tone}>{st.label}</Tag>
                      </div>
                      <code className="code">{item.capture_key}</code>
                      {!item.deleted && (item.thumbnail_variant_id || item.poster_variant_id) ? (
                        <div style={{ margin: "8px 0" }}>
                          {/* Gallery view only renders small thumbnails, never HD originals */}
                          <img
                            src={`/api/v1/staff/admin/media/${item.id}/stream?variant=${item.thumbnail_variant_id ? "thumbnail" : "video_poster"}`}
                            alt={item.capture_key}
                            style={{ maxWidth: "100%", maxHeight: 160, borderRadius: 6 }}
                          />
                        </div>
                      ) : (
                        <p className="small muted">{item.deleted ? "已受控删除不可播放" : "无缩略图 / 仅查看详情"}</p>
                      )}
                      <p className="small muted">
                        拍摄：{item.actual_captured_at ? stamp(item.actual_captured_at) : "未知"} · {formatBytes(item.original_size_bytes)}
                      </p>
                      <Link className="button small" href={item.detail_path}>进入证据详情</Link>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="actions" style={{ marginTop: 12 }}>
              <Action sm disabled={page <= 1} run={async () => setPage(Math.max(1, page - 1))}>上一页</Action>
              <span className="small muted">第 {page} 页 / 共 {Math.max(1, Math.ceil(total / 24))} 页</span>
              <Action sm disabled={page * 24 >= total} run={async () => setPage(page + 1)}>下一页</Action>
            </div>
          </>
        )}

        {tab === "exports" && (
          <div className="stack">
            {caps.can_export && (
              <Form
                label="创建私有受控导出清单"
                run={async (f) => {
                  setActionError(undefined);
                  try {
                    const res = await request("/staff/admin/media/exports", "POST", {
                      purpose_reason: text(f, "purpose_reason"),
                      max_items: Number(text(f, "max_items") || 100),
                      include_originals: false,
                    });
                    setNotice({ tone: "success", text: `导出任务已生成：${res.job?.job_key}（SHA256 ${res.job?.manifest_sha256?.slice(0, 12)}…）` });
                    reloadAll();
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                <div className="filters-grid">
                  <label>
                    导出原因与合规用途（必填）
                    <input type="text" name="purpose_reason" required minLength={4} placeholder="例如：QA合规模板归档审计" />
                  </label>
                  <label>
                    最大条数（1–500）
                    <input type="number" name="max_items" defaultValue="100" min={1} max={500} required />
                  </label>
                </div>
              </Form>
            )}
            <Table
              headers={["任务号", "申请原因", "包含原件", "条数/字节", "清单哈希", "状态", "操作"]}
              rows={(exportsLoad.data?.exports ?? []).map((ex: Row) => [
                <code key="k" className="code">{ex.job_key}</code>,
                <span key="r">{ex.purpose_reason}</span>,
                <Tag key="o" tone={ex.include_originals ? "red" : "green"}>{ex.include_originals ? "含原件引用" : "仅清单摘要"}</Tag>,
                <span key="c">{ex.exported_count} 条 · {formatBytes(ex.total_bytes)}</span>,
                <code key="h" className="code">{ex.manifest_sha256 ? `${ex.manifest_sha256.slice(0, 14)}…` : "-"}</code>,
                <Tag key="s" tone={ex.status === "completed" ? "green" : ex.status === "cancelled" ? "gray" : "yellow"}>{ex.status}</Tag>,
                ex.status === "completed" ? (
                  <Action
                    key="cancel"
                    sm
                    run={async () => {
                      try {
                        await request(`/staff/admin/media/exports/${ex.id}/cancel`, "POST", {});
                        reloadAll();
                      } catch (e) {
                        onErr(e);
                      }
                    }}
                  >
                    撤销导出
                  </Action>
                ) : (
                  <span key="n" className="small muted">-</span>
                ),
              ])}
            />
          </div>
        )}

        {tab === "retention" && (
          <Table
            headers={["证据", "动作", "申请人 / 原因", "影响范围快照", "状态", "审批 (SoD)"]}
            rows={(retentionLoad.data?.requests ?? []).map((rr: Row) => [
              <div key="ev" className="cell-stack">
                <code className="code">{rr.capture_key}</code>
                <Link className="small" href={`/admin/media/${rr.evidence_id}`}>查看证据</Link>
              </div>,
              <Tag key="act" tone={rr.action_type === "controlled_delete" ? "red" : "blue"}>{rr.action_type}</Tag>,
              <div key="why" className="cell-stack">
                <span>{rr.requested_by_name ?? rr.requested_by}</span>
                <small className="muted">{rr.reason}</small>
              </div>,
              <small key="imp" className="code">{JSON.stringify(rr.impact_snapshot)}</small>,
              <Tag key="st" tone={rr.status === "executed" ? "green" : rr.status === "failed" || rr.status === "rejected" ? "red" : "yellow"}>{rr.status}</Tag>,
              rr.status === "pending" && isWarehouseAdmin ? (
                <div key="ops" className="actions">
                  <Action
                    sm
                    run={async () => {
                      try {
                        await request(`/staff/admin/media/retention-requests/${rr.id}/decide`, "POST", { decision: "approve" });
                        reloadAll();
                      } catch (e) {
                        onErr(e);
                      }
                    }}
                  >
                    批准执行
                  </Action>
                  <Action
                    sm
                    run={async () => {
                      try {
                        await request(`/staff/admin/media/retention-requests/${rr.id}/decide`, "POST", { decision: "reject", note: "管理员驳回" });
                        reloadAll();
                      } catch (e) {
                        onErr(e);
                      }
                    }}
                  >
                    驳回
                  </Action>
                </div>
              ) : (
                <span key="done" className="small muted">{rr.execution_error ?? rr.decision_note ?? "-"}</span>
              ),
            ])}
          />
        )}

        {tab === "reconcile" && (
          <div className="stack">
            <div className="actions">
              {isWarehouseAdmin && (
                <Action
                  run={async () => {
                    try {
                      const res = await request("/staff/admin/media/reconcile", "POST", {});
                      setNotice({ tone: "info", text: `守恒对账完成：发现 ${res.anomalies_detected} 项异常。` });
                      reloadAll();
                    } catch (e) {
                      onErr(e);
                    }
                  }}
                >
                  运行证据守恒对账
                </Action>
              )}
              {isSuperAdmin && (
                <Action
                  run={async () => {
                    try {
                      const res = await request("/staff/admin/media/recovery/replay-tombstones", "POST", {});
                      setNotice({
                        tone: "success",
                        text: `已重放 ${res.replayed_tombstones} 条撤销墓碑（阻断旧设备 ${res.devices_enforced} 台）。`,
                      });
                      reloadAll();
                    } catch (e) {
                      onErr(e);
                    }
                  }}
                >
                  恢复后重放撤销墓碑 (MFA)
                </Action>
              )}
            </div>

            <Table
              headers={["异常类型", "严重度", "详情", "状态", "操作"]}
              rows={(reconcileLoad.data?.anomalies ?? []).map((a: Row) => [
                <code key="t" className="code">{a.anomaly_type}</code>,
                <Tag key="sev" tone={a.severity === "critical" || a.severity === "high" ? "red" : "yellow"}>{a.severity}</Tag>,
                <small key="d" className="code">{JSON.stringify(a.details)}</small>,
                <Tag key="st" tone={a.status === "resolved" ? "green" : "yellow"}>{a.status}</Tag>,
                a.status !== "resolved" && isWarehouseAdmin ? (
                  <Action
                    key="res"
                    sm
                    run={async () => {
                      try {
                        await request(`/staff/admin/media/reconcile/anomalies/${a.id}/resolve`, "POST", { note: "管理员核查确认已解决" });
                        reloadAll();
                      } catch (e) {
                        onErr(e);
                      }
                    }}
                  >
                    标记已核销
                  </Action>
                ) : (
                  <span key="done" className="small muted">{a.resolution_note ?? "-"}</span>
                ),
              ])}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

export function AdminMediaDetailDesk({ id, actor }: { id: string; actor: Actor }) {
  const detailLoad = useLoad(`/staff/admin/media/${id}`);
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "error" | "success"; text: string }>();

  const data = detailLoad.data;
  const record = data?.record;
  const variants: Row[] = data?.variants ?? [];
  const annotatedVariant = variants.find((v) => v.variant_kind === "annotated");

  if (detailLoad.error) {
    return <StatusBanner tone="error" title="无法读取媒体详情">{detailLoad.error}</StatusBanner>;
  }
  if (!record) {
    return <Panel title="媒体证据详情">正在加载证据档案…</Panel>;
  }

  return (
    <div className="stack">
      {notice && <StatusBanner tone={notice.tone} title="媒体详情操作">{notice.text}</StatusBanner>}
      {actionError && <StatusBanner tone="error" title="操作受阻">{actionError}</StatusBanner>}

      <Panel
        title={`媒体证据详情 · ${record.capture_key}`}
        subtitle={`原件 SHA-256: ${record.original_sha256}`}
      >
        <div className="actions" style={{ marginBottom: 12 }}>
          <Link className="button small" href="/admin/media">返回媒体中心</Link>
          <Tag tone={record.deleted ? "red" : record.playable ? "green" : "yellow"}>
            {record.deleted ? "已受控删除/作废" : record.playable ? "原件可安全访问" : record.processing_state}
          </Tag>
          {record.legal_hold && <Tag tone="red">争议法律保全锁定</Tag>}
        </div>

        <div className="split-grid" style={{ marginBottom: 14 }}>
          <div className="panel" style={{ padding: 12 }}>
            <strong>不可变原始证据对照</strong>
            {record.deleted ? (
              <StatusBanner tone="warning" title="原件已受控删除">
                该媒体已执行受控删除/作废（{record.quarantine_reason ?? "archived"}），系统严禁伪造可播放状态。
              </StatusBanner>
            ) : record.media_kind === "video" ? (
              <video controls style={{ width: "100%", maxHeight: 320 }} src={`/api/v1/staff/admin/media/${record.id}/stream?variant=original`} />
            ) : record.media_kind === "photo" ? (
              <div className="split-grid">
                <div>
                  <p className="small muted">原始件（未裁切/未标注）</p>
                  <img
                    src={`/api/v1/staff/admin/media/${record.id}/stream?variant=original`}
                    alt="Original evidence"
                    style={{ maxWidth: "100%", borderRadius: 6 }}
                  />
                </div>
                {annotatedVariant && (
                  <div>
                    <p className="small muted">派生标注图 v{annotatedVariant.variant_version}</p>
                    <img
                      src={`/api/v1/staff/admin/media/${record.id}/stream?variant=annotated`}
                      alt="Annotated derivative"
                      style={{ maxWidth: "100%", borderRadius: 6 }}
                    />
                  </div>
                )}
              </div>
            ) : (
              <p className="small muted">文档原件 · {record.original_mime} · {formatBytes(record.original_size_bytes)}</p>
            )}
          </div>

          <div className="panel" style={{ padding: 12 }}>
            <strong>溯源、时间真实性与责任快照</strong>
            <p className="small">来源类型：{record.source_type}（可信度：{record.source_trust_level}）</p>
            <p className="small">实际采集时间：{record.actual_captured_at ? stamp(record.actual_captured_at) : `未知 (${record.time_unknown_reason ?? "-"})`}</p>
            <p className="small">时间来源：{record.time_source} · 时钟偏差告警：{record.clock_skew_flagged ? "是" : "否"}</p>
            <p className="small">服务端接收：{stamp(record.server_received_at)} · 校验完成：{record.server_verified_at ? stamp(record.server_verified_at) : "-"}</p>
            <p className="small">设备：{record.device_code ?? "未知"}（当前状态 {record.device_approval_status ?? "-"} / 授权世代 {record.device_auth_generation ?? "-"}）</p>
            <p className="small">采集责任员工：{record.capture_author_name ?? "未知"} · 上传员：{record.uploader_name ?? record.uploader_user_id}</p>
            <p className="small">存储实例：{record.storage_instance_key ?? record.storage_provider_key} · 对象状态：{record.storage_object_status}</p>
          </div>
        </div>

        <Panel title="业务关联与深链接">
          <Table
            headers={["对象类型", "业务编号/ID", "角色", "组织", "深链接"]}
            rows={(data.links ?? []).map((l: Row) => [
              <Tag key="t" tone="blue">{l.entity_type}</Tag>,
              <code key="c" className="code">{l.order_no ?? l.item_code ?? l.package_code ?? l.entity_id}</code>,
              <span key="r">{l.link_role} ({l.status})</span>,
              <span key="o">{l.org_name ?? l.org_id ?? "-"}</span>,
              l.deep_link ? <Link key="go" className="button small" href={l.deep_link}>跳转</Link> : <span key="n">-</span>,
            ])}
          />
        </Panel>

        {actor.roles.some((r) => ["inspector", "reviewer", "warehouse_admin", "super_admin"].includes(r)) && (
          <Panel title="保留策略、冻结、隔离与受控删除申请">
            <Form
              label="提交媒体生命周期处置申请"
              run={async (f) => {
                setActionError(undefined);
                try {
                  await request(`/staff/admin/media/${record.id}/retention-requests`, "POST", {
                    action_type: text(f, "action_type"),
                    reason: text(f, "reason"),
                  });
                  setNotice({ tone: "success", text: "已创建生命周期审批请求，高风险删除与解冻需另一名超管复核。" });
                  detailLoad.reload();
                } catch (e) {
                  setActionError(e instanceof RequestError || e instanceof Error ? e.message : "提交失败");
                }
              }}
            >
              <div className="filters-grid">
                <label>
                  动作类型
                  <select name="action_type" defaultValue="set_legal_hold">
                    <option value="quarantine">quarantine（隔离）</option>
                    <option value="release_quarantine">release_quarantine（解除隔离）</option>
                    <option value="set_legal_hold">set_legal_hold（争议冻结）</option>
                    <option value="release_legal_hold">release_legal_hold（解冻 - SoD）</option>
                    <option value="archive">archive（归档）</option>
                    <option value="restore_archived">restore_archived（从归档恢复）</option>
                    <option value="controlled_delete">controlled_delete（受控删除 - SoD）</option>
                  </select>
                </label>
                <label>
                  依据与审批理由（必填）
                  <input type="text" name="reason" required minLength={4} placeholder="说明合法原因或工单号" />
                </label>
              </div>
            </Form>
          </Panel>
        )}
      </Panel>
    </div>
  );
}
