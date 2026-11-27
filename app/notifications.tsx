"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import type { Actor } from "../packages/core/common";
import { t } from "../packages/core/i18n/messages";
import type { EnabledLocale } from "../packages/core/locale-contract";
import { billingChargePath, billingQuotePath } from "../packages/core/portal-routes";
import { Action, Empty, ErrorBlock, Panel, request, Tag, Table, useLoad, useWorkspaceStamp, type Row } from "./ui";

const noticeTitles: Record<string, string> = {
  "account.registered": "Your workspace is ready",
  "reference.sealed": "Your Golden Sample is active",
  "ticket.reply": "Support has replied to your case",
  "ticket.created": "New support case created",
  "ticket.customer_replied": "Customer replied on support case",
  "report.published": "Your inspection report is ready",
  "report.amended": "An updated report has been published",
  "payment.confirmed": "Payment confirmed",
  "refund.succeeded": "Your refund was processed",
  "refund.failed": "Your refund requires follow-up",
  "package.received": "The warehouse received your parcel",
  "order.ready": "Your items are ready for inspection",
  "order.held": "Order placed on hold for confirmation",
  "order.resumed": "Inspection order resumed",
  "incident.resolved": "Warehouse incident resolved",
  "order.identity_mismatch": "Action required: Sample identity mismatch detected",
  "order.cancelled": "Inspection cancelled",
  "dispatch.quoted": "Your shipping quote is ready",
  "storage.quoted": "Your storage extension quote is ready",
  "quote.offered": "A manual inspection quote is ready",
  "shipment.handed_over": "Your parcel has been handed to the carrier",
  "shipment.return_received": "Returned items have been received at the warehouse",
  "tracking.exception_opened": "Carrier reported a delivery exception",
  "email.delivery_failed": "We couldn't deliver email to this address",
  "email.channel_degraded": "Transactional email channel alert",
  "owner.legal_entity_activated": "Default legal entity activated",
  "owner.legal_entity_retired": "Legal entity retired",
  "owner.merchant_instance_changed": "Merchant instance configuration updated",
  "staff.invited": "Staff activation invitation sent",
  "staff.activated": "Staff account activated",
  "staff.sessions_revoked": "Staff active sessions revoked",
  "staff.offboarded": "Staff offboarding completed",
  "staff.handover_assigned": "Work handover assigned",
  "staff.role_changed": "Staff role permissions updated",
};

function customerHrefForNotice(notice: Row): string | null {
  if (typeof notice.cta_path === "string" && notice.cta_path.startsWith("/") && !notice.cta_path.startsWith("/admin")) {
    return notice.cta_path;
  }
  return notice.case_id
    ? "/support/cases/" + notice.case_id
    : notice.report_version && notice.order_number
      ? "/orders/" + notice.order_number + "/report/versions/" + notice.report_version
      : notice.quote_id
        ? billingQuotePath(notice.quote_id)
        : notice.template === "storage.quoted"
          ? "/account/billing"
          : notice.item_code
            ? "/items?item=" + encodeURIComponent(notice.item_code)
            : notice.shipment_id
              ? "/shipments/" + notice.shipment_id
              : notice.advice_id
                ? "/parcels/" + notice.advice_id
                : notice.charge_id
                  ? billingChargePath(notice.charge_id)
                  : notice.order_number
                    ? "/orders/" + notice.order_number + (notice.template === "quote.offered" ? "#manual-quote-request" : "")
                    : notice.template === "account.registered" || notice.template === "email.delivery_failed"
                      ? "/account"
                      : notice.template === "payment.confirmed" || notice.template === "dispatch.quoted"
                        ? "/account/billing"
                        : null;
}

function channelTone(state: string): "green" | "yellow" | "red" | "blue" | "outline" {
  if (state === "read" || state === "delivered") return "green";
  if (state === "bounced" || state === "complained" || state === "failed") return "red";
  if (state === "unknown" || state === "deferred" || state === "suppressed") return "yellow";
  return "blue";
}

function UpdatesTable({
  notices,
  onRead,
  onSelect,
}: {
  notices: Row[];
  onRead: () => void;
  onSelect?: (id: string) => void;
}) {
  const stamp = useWorkspaceStamp();
  return (
    <>
      {notices.length ? (
        <Table
          headers={["Update", "Channels", "Received", "Status", ""]}
          rows={notices.map((notice) => {
            const href = customerHrefForNotice(notice);
            const title = (notice.title_snapshot as string | null) ?? noticeTitles[notice.template] ?? "Account update";
            const channels = Array.isArray(notice.channel_deliveries) ? (notice.channel_deliveries as Row[]) : [];
            return [
              <span className="cell-stack" key={notice.id}>
                <span style={{ fontWeight: notice.read_at ? 500 : 750 }}>
                  {notice.is_test ? <Tag tone="yellow">[TEST]</Tag> : null} {title}
                </span>
                {notice.body_snapshot && <small className="muted">{String(notice.body_snapshot)}</small>}
                {notice.item_code && <small className="code">{notice.item_code}</small>}
                {notice.parcel_tracking_number && (
                  <small>
                    Tracking <span className="code">{notice.parcel_tracking_number}</span>
                  </small>
                )}
                {notice.case_number && (
                  <small>
                    Case <span className="code">{notice.case_number}</span>
                  </small>
                )}
                {notice.order_number && (
                  <small>
                    Order <span className="code">{notice.order_number}</span>
                    {notice.report_version ? ` · Report v${notice.report_version}` : ""}
                  </small>
                )}
              </span>,
              <div className="actions" style={{ flexWrap: "wrap", gap: 4 }}>
                {channels.length > 0 ? (
                  channels.map((ch) => (
                    <Tag key={`${notice.id}-${ch.channel}`} tone={channelTone(String(ch.state))}>
                      {String(ch.channel)}: {String(ch.state)}
                    </Tag>
                  ))
                ) : (
                  <Tag tone="outline">in_app: {notice.read_at ? "read" : "delivered"}</Tag>
                )}
              </div>,
              stamp(notice.created_at),
              notice.read_at ? "Read" : "Unread",
              <div className="actions">
                {onSelect && (
                  <button type="button" className="button sm" onClick={() => onSelect(String(notice.id))}>
                    Details
                  </button>
                )}
                {href && (
                  <Link
                    href={href}
                    onClick={() => {
                      if (!notice.read_at) {
                        void request("/me/notifications/" + notice.id + "/read", "POST", {}).then(onRead).catch(() => {});
                      }
                    }}
                  >
                    Open
                  </Link>
                )}
                {!notice.read_at && (
                  <Action
                    run={async () => {
                      await request("/me/notifications/" + notice.id + "/read", "POST", {});
                      onRead();
                    }}
                  >
                    Mark as read
                  </Action>
                )}
              </div>,
            ];
          })}
        />
      ) : (
        <Empty>No updates yet.</Empty>
      )}
    </>
  );
}

export function RecentUpdates({ notices, onRead }: { notices: Row[]; onRead: () => void }) {
  return (
    <Panel title="Recent activity">
      <UpdatesTable notices={notices.slice(0, 5)} onRead={onRead} />
      <Link href="/account/notifications">View all notifications →</Link>
    </Panel>
  );
}

export function NotificationInbox() {
  const search = useSearchParams();
  const params = new URLSearchParams();
  const cat = search.get("category") ?? "all";
  const unread = search.get("unread") === "1";
  const before = search.get("before");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);

  if (unread) params.set("unread", "1");
  if (cat !== "all") params.set("category", cat);
  if (before) params.set("before", before);
  const { data, error, reload } = useLoad("/me/notifications" + (params.size ? "?" + params : ""));

  function firstPage(category: string, onlyUnread: boolean) {
    const first = new URLSearchParams();
    if (category !== "all") first.set("category", category);
    if (onlyUnread) first.set("unread", "1");
    return "/account/notifications" + (first.size ? "?" + first : "");
  }

  async function openDetail(id: string) {
    setSelectedId(id);
    const res = await request("/me/notifications/" + id);
    setDetail(res as Row);
  }

  const next = new URLSearchParams(params);
  if (data?.next_before) next.set("before", data.next_before);

  return (
    <>
      <div className="page-head">
        <Link href="/account">← Account</Link>
        <h1>Notifications</h1>
        <p className="muted">
          Find updates about reports, payments, parcels, security notices, and support cases. Marking a message as read does not close{" "}
          <Link href="/actions">Action Required</Link>.
        </p>
      </div>
      <Panel title={unread ? "Unread updates" : "All updates"}>
        <div className="actions" style={{ flexWrap: "wrap" }}>
          <Link className="button sm" href={firstPage(cat, false)} aria-current={!unread ? "page" : undefined}>
            All
          </Link>
          <Link className="button sm" href={firstPage(cat, true)} aria-current={unread ? "page" : undefined}>
            Unread{data ? ` (${data.unread_count})` : ""}
          </Link>
          {(data?.unread_count ?? 0) > 0 && (
            <Action
              sm
              primary
              run={async () => {
                await request("/me/notifications/read-all", "POST", {});
                reload();
              }}
            >
              Mark all read
            </Action>
          )}
          <button className="button sm" type="button" onClick={reload}>
            Refresh
          </button>
        </div>
        <div className="actions" style={{ marginTop: 8, flexWrap: "wrap" }}>
          {(
            [
              ["all", "All Categories"],
              ["orders", "Orders"],
              ["reports", "Reports"],
              ["parcels", "Parcels & Tracking"],
              ["billing", "Billing & Quotes"],
              ["support", "Support & Account"],
              ["security", "Security"],
              ["announcements", "Announcements"],
            ] as const
          ).map(([cid, clabel]) => (
            <Link
              key={cid}
              href={firstPage(cid, unread)}
              aria-current={cat === cid ? "page" : undefined}
              className={"button sm" + (cat === cid ? " primary" : "")}
            >
              {clabel}
            </Link>
          ))}
        </div>
        {error && <ErrorBlock error={error} />}
        {!data && !error && <p role="status">Loading updates…</p>}
        {data && !error && <UpdatesTable notices={data.rows} onRead={reload} onSelect={(id) => void openDetail(id)} />}
        <div className="actions">
          {before && <Link href={firstPage(cat, unread)}>Back to first page</Link>}
          {!error && data?.next_before && <Link href={"/account/notifications?" + next}>Older updates →</Link>}
        </div>
      </Panel>

      {selectedId && detail && (
        <Panel title={`Notification Detail: ${String(detail.title ?? detail.template)}`}>
          <p>{String(detail.body_snapshot ?? "")}</p>
          <p className="muted small">
            Template: <code className="code">{String(detail.template)}</code> · Locale:{" "}
            <code className="code">{String(detail.locale)}</code> · Action Required stays open until resolved in workflow.
          </p>
          <div className="actions">
            {detail.action_path && (
              <Link className="button primary sm" href={String(detail.action_path)}>
                Open target record
              </Link>
            )}
            <button type="button" className="button sm" onClick={() => setSelectedId(null)}>
              Close
            </button>
          </div>
        </Panel>
      )}
    </>
  );
}

/**
 * Top-bar personal notification bell rendered across customer, warehouse, and admin workspaces (§65.5).
 * Opening the preview popover NEVER auto-marks notifications as read.
 */
export function WorkspaceNotificationBell({
  area,
  actor,
  locale,
}: {
  area: "customer" | "warehouse" | "admin";
  actor: Actor;
  locale: EnabledLocale;
}) {
  const [open, setOpen] = useState(false);
  const endpoint = area === "customer" ? "/me/notifications" : "/staff/me/notifications";
  const inboxHref = area === "customer" ? "/account/notifications" : area === "warehouse" ? "/wh/notifications" : "/admin/notifications";
  const { data, reload } = useLoad(endpoint);
  const unreadCount = Number(data?.unread_count ?? 0);
  const rows = ((data?.rows ?? data?.notifications ?? []) as Row[]).slice(0, 5);

  if (!actor) return null;

  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        className="button sm"
        aria-expanded={open}
        aria-label={t(locale, "bell.unreadCount", { count: unreadCount })}
        onClick={() => {
          setOpen((v) => !v);
          reload();
        }}
      >
        <span>{t(locale, "bell.label")}</span>
        {unreadCount > 0 && <Tag tone="yellow">{unreadCount}</Tag>}
      </button>
      {open && (
        <div
          className="panel"
          role="dialog"
          aria-label={t(locale, "bell.label")}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 340,
            maxWidth: "90vw",
            zIndex: 40,
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.16)",
          }}
        >
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>{t(locale, "bell.label")} ({unreadCount})</strong>
            <button type="button" className="button sm" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="muted small">{t(locale, "bell.empty")}</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {rows.map((r) => (
                <li key={String(r.id)} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 6 }}>
                  <div style={{ fontWeight: r.read_at ? 500 : 700, fontSize: "0.9rem" }}>
                    {String(r.title ?? r.title_snapshot ?? noticeTitles[r.template] ?? r.template)}
                  </div>
                  <div className="actions" style={{ marginTop: 4 }}>
                    <Link
                      href={String(r.action_path ?? (area === "customer" ? customerHrefForNotice(r) ?? inboxHref : inboxHref))}
                      onClick={() => setOpen(false)}
                    >
                      {t(locale, "bell.openInbox")}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="actions" style={{ marginTop: 8 }}>
            <Link className="button primary sm" href={inboxHref} onClick={() => setOpen(false)}>
              {t(locale, "bell.openInbox")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export function StaffNotificationInbox({
  actor,
  area,
}: {
  actor: Actor;
  area: "warehouse" | "admin";
}) {
  const stamp = useWorkspaceStamp();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState<Row | null>(null);
  const [historyFilterChannel, setHistoryFilterChannel] = useState("all");
  const [commDetail, setCommDetail] = useState<Row | null>(null);

  const isSuperAdmin = actor.roles.includes("super_admin");
  const canReadScopedHistory = isSuperAdmin || actor.roles.includes("support");

  const params = new URLSearchParams();
  if (unreadOnly) params.set("unread", "1");
  if (category !== "all") params.set("category", category);
  const { data, error, reload } = useLoad("/staff/me/notifications" + (params.size ? "?" + params : ""));
  const historyUrl = canReadScopedHistory ? `/staff/admin/communications/history?channel=${historyFilterChannel}` : null;
  const historyLoad = useLoad(historyUrl);

  const rows = (data?.notifications ?? []) as Row[];
  const homeHref = area === "warehouse" ? "/wh" : "/admin";

  return (
    <>
      <div className="page-head">
        <Link href={homeHref}>← {area === "warehouse" ? "仓库总览" : "运营总览"}</Link>
        <h1>{area === "warehouse" ? "仓库个人收件箱" : "员工收件箱与通信中心"}</h1>
        <p className="muted">
          按实际员工账号、角色、工单/任务与管理员安全事件精准投递；已读状态仅记录当前本人读取，不关闭未完成业务待办。
        </p>
      </div>

      <Panel title={`个人收件箱 (${Number(data?.unread_count ?? 0)} 条未读)`}>
        <div className="actions" style={{ flexWrap: "wrap" }}>
          <button type="button" className={"button sm" + (!unreadOnly ? " primary" : "")} onClick={() => setUnreadOnly(false)}>
            全部
          </button>
          <button type="button" className={"button sm" + (unreadOnly ? " primary" : "")} onClick={() => setUnreadOnly(true)}>
            仅未读
          </button>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="消息类别">
            <option value="all">全部类别</option>
            <option value="security">安全与权限</option>
            <option value="support">客服工单</option>
            <option value="orders">订单与质检</option>
            <option value="system">系统与主体治理</option>
            <option value="announcements">公告</option>
          </select>
          {(data?.unread_count ?? 0) > 0 && (
            <Action
              sm
              primary
              run={async () => {
                await request("/staff/me/notifications/read-all", "POST", {});
                reload();
              }}
            >
              全部标为已读
            </Action>
          )}
          <button type="button" className="button sm" onClick={reload}>
            刷新
          </button>
        </div>

        {error && <ErrorBlock error={error} />}
        {!data && !error && <p role="status">加载个人通知…</p>}
        {data && rows.length === 0 && <Empty>暂无通知消息。</Empty>}
        {data && rows.length > 0 && (
          <Table
            headers={["标题 / 事件", "类别", "时间", "已读", "操作"]}
            rows={rows.map((n) => [
              <span className="cell-stack" key={String(n.id)}>
                <strong style={{ fontWeight: n.read_at ? 500 : 750 }}>
                  {n.is_test ? <Tag tone="yellow">[TEST]</Tag> : null}{" "}
                  {String(n.title ?? n.title_snapshot ?? noticeTitles[n.template] ?? n.template)}
                </strong>
                {n.body_snapshot && <small className="muted">{String(n.body_snapshot)}</small>}
              </span>,
              <Tag tone="blue">{String(n.category ?? "system")}</Tag>,
              stamp(n.created_at),
              n.read_at ? "已读" : "未读",
              <div className="actions">
                <button
                  type="button"
                  className="button sm"
                  onClick={async () => {
                    const res = await request(`/staff/me/notifications/${n.id}`);
                    setSelected(res as Row);
                  }}
                >
                  详情
                </button>
                {n.action_path && <Link href={String(n.action_path)}>跳转对象</Link>}
                {!n.read_at && (
                  <Action
                    sm
                    run={async () => {
                      await request(`/staff/me/notifications/${n.id}/read`, "POST", {});
                      reload();
                    }}
                  >
                    已读
                  </Action>
                )}
              </div>,
            ])}
          />
        )}
      </Panel>

      {selected && (
        <Panel title={`消息详情 · ${String(selected.template)}`}>
          <p>{String(selected.body_snapshot ?? "")}</p>
          <pre style={{ fontSize: "0.8rem" }}>{JSON.stringify(selected.payload ?? {}, null, 2)}</pre>
          <button type="button" className="button sm" onClick={() => setSelected(null)}>
            关闭
          </button>
        </Panel>
      )}

      {canReadScopedHistory && area === "admin" && (
        <Panel title="运营通信主记录与多渠道投递台账（范围受控）">
          <div className="actions" style={{ marginBottom: 8 }}>
            <select value={historyFilterChannel} onChange={(e) => setHistoryFilterChannel(e.target.value)} aria-label="渠道筛选">
              <option value="all">全部渠道</option>
              <option value="in_app">站内 (in_app)</option>
              <option value="email">邮件 (email)</option>
              <option value="whatsapp">WhatsApp (whatsapp)</option>
            </select>
            {isSuperAdmin && (
              <Action
                sm
                run={async () => {
                  await request("/staff/admin/communications/reconcile-legacy", "POST", {});
                  historyLoad.reload();
                }}
              >
                对账同步存量通知
              </Action>
            )}
          </div>
          {historyLoad.data && (
            <>
              <p className="muted small">
                主记录：{String(historyLoad.data.summary?.master_count ?? 0)} · 接收人次：
                {String(historyLoad.data.summary?.recipient_count ?? 0)} · 渠道投递：
                {String(historyLoad.data.summary?.channel_delivery_count ?? 0)} · 尝试数：
                {String(historyLoad.data.summary?.attempt_count ?? 0)}（失败{" "}
                {String(historyLoad.data.summary?.failed_channel_count ?? 0)}，未知/延后{" "}
                {String(historyLoad.data.summary?.unknown_channel_count ?? 0)}）
              </p>
              <Table
                headers={["事件 / 来源", "对象", "语言", "状态", "渠道明细", ""]}
                rows={((historyLoad.data.rows ?? []) as Row[]).map((m) => [
                  <span className="cell-stack" key={String(m.id)}>
                    <strong>{String(m.event_type)}</strong>
                    <small className="muted">
                      {String(m.source_kind)} · {String(m.content_origin)}
                    </small>
                  </span>,
                  <span className="code">{`${String(m.entity_type)}:${String(m.entity_id ?? "-")}`}</span>,
                  String(m.locale),
                  <Tag tone={channelTone(String(m.status))}>{String(m.status)}</Tag>,
                  <small>
                    接收 {String(m.recipient_count)} · 投递 {String(m.channel_delivery_count)} · 尝试 {String(m.attempt_count)}
                  </small>,
                  <button
                    type="button"
                    className="button sm"
                    onClick={async () => {
                      const d = await request(`/staff/admin/communications/${m.id}`);
                      setCommDetail(d as Row);
                    }}
                  >
                    追溯详情
                  </button>,
                ])}
              />
            </>
          )}
        </Panel>
      )}

      {commDetail && (
        <Panel title={`通信追溯详情 · ${String(commDetail.master?.event_type ?? "")}`}>
          <p className="muted small">
            Dedupe: <code className="code">{String(commDetail.master?.dedupe_key ?? "")}</code> · Status:{" "}
            <strong>{String(commDetail.master?.status ?? "")}</strong>
          </p>
          <pre style={{ fontSize: "0.8rem" }}>{JSON.stringify(commDetail.deliveries ?? [], null, 2)}</pre>
          <button type="button" className="button sm" onClick={() => setCommDetail(null)}>
            关闭追溯
          </button>
        </Panel>
      )}
    </>
  );
}
