import { z } from "zod";
import type { DB } from "../db";
import { appOrigin, encryptSecret } from "./auth";
import { evaluateAuthorization, type StaffScopeContext } from "./authz-contract";
import { audit, guard, isDemo, organization, role, uuid, type Actor } from "./common";
import { maskEmail, queueNotificationEmail, renderTransactionalEmailFromTemplate } from "./email";
import { normalizeLocaleTag, type EnabledLocale } from "./locale-contract";
import type { NotificationChannel } from "./messaging-contract";
import { staffAccess } from "./staff-access";

export type NotificationCategory =
  | "orders"
  | "reports"
  | "parcels"
  | "billing"
  | "support"
  | "security"
  | "system"
  | "announcements";

export type CommunicationSourceKind = "auto_event" | "manual_targeted" | "announcement" | "security_alert";
export type CommunicationPriority = "low" | "normal" | "high" | "urgent";

export type CommunicationRecipientTarget = {
  userId: string;
  kind: "customer" | "staff";
  orgId?: string | null;
  locale?: string | null;
  emailOverride?: string | null;
  associatedTodoKind?: string | null;
  associatedTodoId?: string | null;
};

export type EmitCommunicationEventInput = {
  sourceKind?: CommunicationSourceKind;
  eventType: string;
  eventId?: string | null;
  entityType: string;
  entityId?: string | null;
  entityVersion?: number;
  orderId?: string | null;
  orderPublicNo?: string | null;
  templateCode?: string;
  priority?: CommunicationPriority;
  dedupeKey: string;
  isTest?: boolean;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
  channels?: readonly NotificationChannel[];
  recipients: readonly CommunicationRecipientTarget[];
  resetReadOnConflict?: boolean;
};

const NON_RECURSIVE_EMAIL_BLOCKLIST = new Set(["email.delivery_failed", "email.channel_degraded"]);
const READ_STAFF_ROLES = [
  "receiver",
  "inspector",
  "reviewer",
  "warehouse_admin",
  "support",
  "super_admin",
  "template_admin",
  "finance",
] as const;

export const staffNotificationQuerySchema = z.object({
  unread: z.enum(["1", "0"]).nullable().optional(),
  category: z.enum(["all", "orders", "reports", "parcels", "billing", "support", "security", "system", "announcements"]).default("all"),
  before: z.uuid().nullable().optional(),
});

export const adminCommunicationHistoryQuerySchema = z.object({
  channel: z.enum(["all", "in_app", "email", "whatsapp"]).default("all"),
  state: z.string().trim().max(40).optional(),
  event_type: z.string().trim().max(80).optional(),
  recipient_user_id: z.uuid().optional(),
  entity_type: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  include_test: z.enum(["1", "0"]).default("1"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export function classifyNotificationCategory(
  template: string,
  sourceKind: CommunicationSourceKind = "auto_event",
): NotificationCategory {
  if (sourceKind === "announcement") return "announcements";
  if (template.startsWith("order.")) return "orders";
  if (template.startsWith("report.")) return "reports";
  if (
    template.startsWith("package.") ||
    template.startsWith("tracking.") ||
    template.startsWith("shipment.") ||
    template === "reference.sealed"
  ) {
    return "parcels";
  }
  if (
    template.startsWith("payment.") ||
    template.startsWith("refund.") ||
    template.endsWith(".quoted") ||
    template === "quote.offered" ||
    template.startsWith("owner.merchant")
  ) {
    return "billing";
  }
  if (
    template.startsWith("ticket.") ||
    template.startsWith("incident.") ||
    template === "email.delivery_failed" ||
    template === "account.registered"
  ) {
    return "support";
  }
  if (
    sourceKind === "security_alert" ||
    template === "email.channel_degraded" ||
    template === "account.security_alert" ||
    template.startsWith("staff.")
  ) {
    return "security";
  }
  return "system";
}

function maskInlineEmails(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (match) => maskEmail(match));
}

export function sanitizeCommunicationMetadata(raw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (/(token|secret|password|auth_code|session)/i.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (/(^|_)(email|previous_email|new_email|contact_email)$/i.test(k) && typeof v === "string") {
      out[k] = maskEmail(v);
      continue;
    }
    if (typeof v === "string") {
      out[k] = maskInlineEmails(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeCommunicationMetadata(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function notificationActionPath(
  template: string,
  payload: Record<string, unknown> = {},
  orderPublicNo?: string | null,
  recipientKind: "customer" | "staff" = "customer",
): string {
  const ticketId = typeof payload.ticket_id === "string" ? payload.ticket_id : null;
  if (recipientKind === "staff") {
    if (ticketId) return `/admin/tickets/${ticketId}`;
    if (template.startsWith("owner.")) return "/admin/legal";
    if (template === "staff.offboarded") return "/admin/users";
    if (template === "staff.handover_assigned") return "/admin/tickets";
    if (template.startsWith("staff.")) return "/wh/notifications";
    if (template === "email.channel_degraded") return "/admin/integrations/email";
    if (template.startsWith("device.")) return "/wh";
    if (template.startsWith("task.")) return "/wh/execute";
    if (orderPublicNo) return `/admin/orders/${orderPublicNo}`;
    return "/wh/notifications";
  }
  if (ticketId) return `/support/cases/${ticketId}`;
  if (orderPublicNo && typeof payload.version !== "undefined" && template.startsWith("report.")) {
    return `/orders/${orderPublicNo}/report/versions/${String(payload.version)}`;
  }
  if (template === "payment.confirmed" || template === "dispatch.quoted") {
    return orderPublicNo && template === "payment.confirmed" ? `/orders/${orderPublicNo}/parcels` : "/account/billing";
  }
  if (template === "storage.quoted") return "/account/billing";
  if (template === "account.registered" || template === "email.delivery_failed") return "/account";
  if (typeof payload.shipment_id === "string") return `/shipments/${payload.shipment_id}`;
  if (typeof payload.advice_id === "string") return `/parcels/${payload.advice_id}`;
  if (orderPublicNo) return `/orders/${orderPublicNo}${template === "quote.offered" ? "#manual-quote-request" : ""}`;
  return "/account/notifications";
}

export function buildInAppTitle(template: string, locale: EnabledLocale, orderPublicNo?: string | null): string {
  const ref = orderPublicNo ? ` (${orderPublicNo})` : "";
  const zh: Record<string, string> = {
    "account.registered": "工作台已就绪",
    "payment.confirmed": `付款已确认${ref}`,
    "package.received": `仓库已签收包裹${ref}`,
    "order.ready": `样品已到齐待质检${ref}`,
    "order.held": `订单已暂停待确认${ref}`,
    "order.resumed": `订单已恢复质检${ref}`,
    "order.identity_mismatch": `待确认：样品核身存在差异${ref}`,
    "order.cancelled": `质检订单已取消${ref}`,
    "report.published": `质检报告已发布${ref}`,
    "report.amended": `质检报告已发布修订版${ref}`,
    "shipment.handed_over": `出库包裹已交寄承运商${ref}`,
    "shipment.return_received": `退回包裹已回仓签收${ref}`,
    "tracking.exception_opened": `物流承运商上报异常${ref}`,
    "dispatch.quoted": `正式运费报价已生成${ref}`,
    "storage.quoted": `仓储续存报价已生成${ref}`,
    "quote.offered": `人工质检报价已发布${ref}`,
    "refund.succeeded": `退款已处理完成${ref}`,
    "refund.failed": `退款需人工跟进${ref}`,
    "incident.resolved": `仓库异常已处理${ref}`,
    "email.delivery_failed": "主邮箱投递失败提醒",
    "email.channel_degraded": "事务邮件通道异常告警",
    "owner.legal_entity_activated": "默认经营主体已启用",
    "owner.legal_entity_retired": "经营主体已退役归档",
    "owner.merchant_instance_changed": "收款商户实例已变更",
    "staff.invited": "员工激活邀请已发出",
    "staff.activated": "员工账号已完成 MFA 激活",
    "staff.sessions_revoked": "员工在线会话已吊销",
    "staff.offboarded": "员工离职与交接已生效",
    "staff.handover_assigned": "收到新的离职工作交接",
    "staff.role_changed": "员工岗位权限已变更",
    "ticket.created": "有新的客服工单待处理",
    "ticket.customer_replied": "客户已在工单中回复",
    "ticket.reply": "客服工单有新回复",
  };
  const en: Record<string, string> = {
    "account.registered": "Your workspace is ready",
    "payment.confirmed": `Payment confirmed${ref}`,
    "package.received": `The warehouse received your parcel${ref}`,
    "order.ready": `Your items are ready for inspection${ref}`,
    "order.held": `Order placed on hold for confirmation${ref}`,
    "order.resumed": `Inspection order resumed${ref}`,
    "order.identity_mismatch": `Action required: Sample identity mismatch detected${ref}`,
    "order.cancelled": `Inspection cancelled${ref}`,
    "report.published": `Your inspection report is ready${ref}`,
    "report.amended": `An updated report has been published${ref}`,
    "shipment.handed_over": `Your parcel has been handed to the carrier${ref}`,
    "shipment.return_received": `Returned items have been received at the warehouse${ref}`,
    "tracking.exception_opened": `Carrier reported a delivery exception${ref}`,
    "dispatch.quoted": `Your shipping quote is ready${ref}`,
    "storage.quoted": `Your storage extension quote is ready${ref}`,
    "quote.offered": `A manual inspection quote is ready${ref}`,
    "refund.succeeded": `Your refund was processed${ref}`,
    "refund.failed": `Your refund requires follow-up${ref}`,
    "incident.resolved": `Warehouse incident resolved${ref}`,
    "email.delivery_failed": "We couldn't deliver email to this address",
    "email.channel_degraded": "Transactional email channel degraded",
    "owner.legal_entity_activated": "Default legal entity activated",
    "owner.legal_entity_retired": "Legal entity retired",
    "owner.merchant_instance_changed": "Merchant instance configuration updated",
    "staff.invited": "Staff activation invitation sent",
    "staff.activated": "Staff account activated with MFA",
    "staff.sessions_revoked": "All active staff sessions revoked",
    "staff.offboarded": "Staff offboarding completed",
    "staff.handover_assigned": "Offboarding handover assigned",
    "staff.role_changed": "Staff role permissions updated",
    "ticket.created": "New support case created",
    "ticket.customer_replied": "Customer replied on support case",
    "ticket.reply": "Support has replied to your case",
  };
  return (locale === "zh-CN" ? zh[template] : en[template]) ?? en[template] ?? template;
}

function toEnabledLocale(tag: string | null | undefined, fallback: EnabledLocale = "en-US"): EnabledLocale {
  const norm = normalizeLocaleTag(tag);
  if (norm === "zh-CN") return "zh-CN";
  if (norm === "en-US") return "en-US";
  return fallback;
}

export async function resolveRecipientLocale(
  db: Pick<DB, "query">,
  userId: string,
  kind: "customer" | "staff",
  override?: string | null,
): Promise<EnabledLocale> {
  if (override) {
    const norm = normalizeLocaleTag(override);
    if (norm === "zh-CN" || norm === "en-US") return norm;
  }
  const pref = (
    await db.query<{ locale: string | null }>(
      `select coalesce(
         u.notification_locale,
         (select sp.preferred_locale from staff_profiles sp where sp.user_id = u.id limit 1),
         u.ui_locale,
         u.locale
       ) as locale
       from users u where u.id = $1 limit 1`,
      [userId],
    )
  ).rows[0]?.locale;
  const fallback: EnabledLocale = kind === "staff" ? "zh-CN" : "en-US";
  return toEnabledLocale(pref, fallback);
}

function mapEmailStateToChannelState(state: string, errorCode: string | null): string {
  if (errorCode === "ADDRESS_SUPPRESSED") return "suppressed";
  if (["queued", "submitted", "delivered", "deferred", "bounced", "complained", "unknown"].includes(state)) {
    return state;
  }
  return "failed";
}

export async function recomputeNotificationMasterStatus(db: Pick<DB, "query">, notificationId: string) {
  const agg = (
    await db.query<{
      total: number;
      active_queued: number;
      failed_like: number;
      suppressed: number;
      succeeded: number;
    }>(
      `select
         count(*)::int as total,
         count(*) filter (where state in ('queued', 'submitted', 'deferred', 'unknown'))::int as active_queued,
         count(*) filter (where state in ('bounced', 'complained', 'failed'))::int as failed_like,
         count(*) filter (where state = 'suppressed')::int as suppressed,
         count(*) filter (where state in ('delivered', 'read'))::int as succeeded
       from notification_channel_deliveries
       where notification_id = $1`,
      [notificationId],
    )
  ).rows[0];
  if (!agg || agg.total === 0) return;

  let nextStatus = "published";
  if (agg.failed_like > 0 && agg.succeeded > 0) nextStatus = "partial_failure";
  else if (agg.failed_like > 0 && agg.succeeded === 0 && agg.active_queued === 0) nextStatus = "failed";
  else if (agg.suppressed === agg.total) nextStatus = "suppressed";
  else if (agg.active_queued > 0) nextStatus = "delivering";
  else nextStatus = "completed";

  await db.query(
    `update notification_masters
     set status = $2, updated_at = now()
     where id = $1 and status <> 'cancelled'`,
    [notificationId, nextStatus],
  );
}

/**
 * Emits a deduplicated multi-recipient, multi-channel communication event atomically inside the caller's
 * DB handle without rolling back business state on delivery failures (§65.4, T38/T39/T125).
 */
export async function emitCommunicationEvent(db: DB, input: EmitCommunicationEventInput) {
  const uniqueRecipients = new Map<string, CommunicationRecipientTarget>();
  for (const r of input.recipients) {
    if (!uniqueRecipients.has(r.userId)) uniqueRecipients.set(r.userId, r);
  }
  if (uniqueRecipients.size === 0) return { notification_id: null, created: false, recipient_count: 0 };

  const sourceKind = input.sourceKind ?? "auto_event";
  const templateCode = input.templateCode ?? input.eventType;
  const masterLocale = toEnabledLocale(uniqueRecipients.values().next().value?.locale, "en-US");
  const requestedChannels = [...new Set(input.channels ?? ["in_app"])];
  const safeEntityId = maskInlineEmails(input.entityId ?? null);
  const safeDedupeKey = maskInlineEmails(input.dedupeKey) ?? input.dedupeKey;
  const metadataPayload = sanitizeCommunicationMetadata({
    ...(input.metadata ?? {}),
    event_id: input.eventId ?? null,
    entity_type: input.entityType,
    entity_id: safeEntityId,
  });
  const masterCta = notificationActionPath(
    templateCode,
    metadataPayload,
    input.orderPublicNo,
    uniqueRecipients.size === 1 ? uniqueRecipients.values().next().value?.kind ?? "customer" : "staff",
  );
  const masterRendered = await renderTransactionalEmailFromTemplate(db, {
    templateCode,
    locale: masterLocale,
    orderPublicNo: input.orderPublicNo ?? null,
    isTest: Boolean(input.isTest),
  });

  const insertedMaster = (
    await db.query<{ id: string }>(
      `insert into notification_masters (
         source_kind, event_type, event_id, entity_type, entity_id, entity_version,
         template_code, template_version, locale, priority, title_snapshot, body_snapshot, cta_path,
         content_origin, metadata, dedupe_key, status, created_by, published_at, is_test
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12, $13,
         $14, $15::jsonb, $16, 'published', $17, now(), $18
       )
       on conflict (dedupe_key) do nothing
       returning id`,
      [
        sourceKind,
        input.eventType,
        input.eventId ?? null,
        input.entityType,
        safeEntityId,
        input.entityVersion ?? 1,
        templateCode,
        masterRendered.templateVersion,
        masterRendered.locale,
        input.priority ?? "normal",
        masterRendered.subject,
        masterRendered.text,
        masterCta,
        masterRendered.templateVersion !== null ? "template_snapshot" : "explicit_snapshot",
        JSON.stringify(metadataPayload),
        safeDedupeKey,
        input.createdBy ?? null,
        Boolean(input.isTest),
      ],
    )
  ).rows[0];

  let masterId = insertedMaster?.id ?? null;
  if (!masterId && input.resetReadOnConflict) {
    const existingMaster = (
      await db.query<{ id: string }>(
        `update notification_masters
         set metadata = $2::jsonb, updated_at = now()
         where dedupe_key = $1
         returning id`,
        [safeDedupeKey, JSON.stringify(metadataPayload)],
      )
    ).rows[0];
    masterId = existingMaster?.id ?? null;
    if (masterId) {
      await db.query(
        `update notification_recipients set read_at = null where notification_id = $1`,
        [masterId],
      );
      await db.query(
        `update notification_channel_deliveries
         set state = 'delivered', read_at = null, updated_at = now()
         where notification_id = $1 and channel = 'in_app'`,
        [masterId],
      );
      await db.query(
        `update notifications
         set read_at = null, payload = $2::jsonb
         where id in (select legacy_notification_id from notification_recipients where notification_id = $1 and legacy_notification_id is not null)`,
        [masterId, JSON.stringify(metadataPayload)],
      );
    }
  }
  if (!masterId) return { notification_id: null, created: false, recipient_count: 0 };

  let createdRecipients = 0;
  for (const target of uniqueRecipients.values()) {
    const recLocale = await resolveRecipientLocale(db, target.userId, target.kind, target.locale);
    const recRendered = await renderTransactionalEmailFromTemplate(db, {
      templateCode,
      locale: recLocale,
      orderPublicNo: input.orderPublicNo ?? null,
      isTest: Boolean(input.isTest),
    });
    const recTitle = recRendered.templateVersion !== null
      ? recRendered.subject
      : buildInAppTitle(templateCode, recLocale, input.orderPublicNo);
    const recCta = notificationActionPath(templateCode, metadataPayload, input.orderPublicNo, target.kind);
    const category = classifyNotificationCategory(templateCode, sourceKind);

    const legacyDedupe =
      uniqueRecipients.size === 1 ? safeDedupeKey : `${safeDedupeKey}:${target.userId}`;
    let legacyRow = (
      await db.query<{ id: string }>(
        `insert into notifications(user_id, order_id, template, locale, payload, dedupe_key)
         values($1, $2, $3, $4, $5::jsonb, $6)
         on conflict (dedupe_key) do nothing
         returning id`,
        [
          target.userId,
          input.orderId ?? null,
          templateCode,
          recLocale,
          JSON.stringify(metadataPayload),
          legacyDedupe,
        ],
      )
    ).rows[0];
    if (!legacyRow) {
      legacyRow = (
        await db.query<{ id: string }>(
          "select id from notifications where dedupe_key = $1 and user_id = $2 limit 1",
          [legacyDedupe, target.userId],
        )
      ).rows[0];
    }

    const recipientRow = (
      await db.query<{ id: string }>(
        `insert into notification_recipients (
           notification_id, legacy_notification_id, recipient_user_id, recipient_kind, org_id,
           category, locale, title_snapshot, body_snapshot, cta_path,
           associated_todo_kind, associated_todo_id
         ) values (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12
         )
         on conflict (notification_id, recipient_user_id) do nothing
         returning id`,
        [
          masterId,
          legacyRow?.id ?? null,
          target.userId,
          target.kind,
          target.orgId ?? null,
          category,
          recLocale,
          recTitle,
          recRendered.text,
          recCta,
          target.associatedTodoKind ?? null,
          target.associatedTodoId ?? null,
        ],
      )
    ).rows[0];
    if (!recipientRow) continue;
    createdRecipients += 1;

    if (requestedChannels.includes("in_app")) {
      await db.query(
        `insert into notification_channel_deliveries (
           notification_id, recipient_id, recipient_user_id, channel, template_code, template_version,
           rendered_locale, rendered_subject, rendered_body, content_origin, state, is_test, delivered_at
         ) values (
           $1, $2, $3, 'in_app', $4, $5,
           $6, $7, $8, $9, 'delivered', $10, now()
         )
         on conflict (recipient_id, channel) do nothing`,
        [
          masterId,
          recipientRow.id,
          target.userId,
          templateCode,
          recRendered.templateVersion,
          recLocale,
          recTitle,
          recRendered.text,
          recRendered.templateVersion !== null ? "template_snapshot" : "explicit_snapshot",
          Boolean(input.isTest),
        ],
      );
    }

    if (
      requestedChannels.includes("email") &&
      !NON_RECURSIVE_EMAIL_BLOCKLIST.has(templateCode) &&
      legacyRow?.id
    ) {
      await queueNotificationEmail(db, legacyRow.id, target.userId, target.emailOverride ?? undefined);
      await syncEmailDeliveriesForLegacyNotification(db, legacyRow.id, masterId, recipientRow.id, recRendered, Boolean(input.isTest));
    }
  }

  await recomputeNotificationMasterStatus(db, masterId);
  return { notification_id: masterId, created: true, recipient_count: createdRecipients };
}

async function syncEmailDeliveriesForLegacyNotification(
  db: DB,
  legacyNotificationId: string,
  masterId: string,
  recipientId: string,
  rendered?: { subject: string; text: string; locale: EnabledLocale; templateVersion: number | null },
  isTest = false,
) {
  const { rows: deliveries } = await db.query<{
    id: string;
    attempt: number;
    state: string;
    provider: string | null;
    provider_message_id: string | null;
    error_code: string | null;
    delivery_evidence_note: string | null;
    updated_at: Date;
    recipient_user_id: string;
    template: string;
    locale: string | null;
    template_version: number | null;
  }>(
    `select d.id, d.attempt, d.state, d.provider, d.provider_message_id, d.error_code,
            d.delivery_evidence_note, d.updated_at, n.user_id as recipient_user_id, n.template,
            d.locale, d.template_version
     from email_deliveries d
     join notifications n on n.id = d.notification_id
     where d.notification_id = $1
     order by d.attempt asc`,
    [legacyNotificationId],
  );
  if (deliveries.length === 0) return;

  const latest = deliveries[deliveries.length - 1]!;
  const latestState = mapEmailStateToChannelState(latest.state, latest.error_code);
  const channelRow = (
    await db.query<{ id: string }>(
      `insert into notification_channel_deliveries (
         notification_id, recipient_id, recipient_user_id, channel, template_code, template_version,
         rendered_locale, rendered_subject, rendered_body, content_origin,
         state, provider, provider_message_id, legacy_email_delivery_id, error_code, error_detail, is_test,
         queued_at, submitted_at, delivered_at, failed_at, updated_at
       ) values (
         $1, $2, $3, 'email', $4, $5,
         $6, $7, $8, $9,
         $10::text, $11, $12, $13, $14, $15, $16,
         case when $10::text = 'queued' then now() else null::timestamptz end,
         case when $10::text = 'submitted' then now() else null::timestamptz end,
         case when $10::text = 'delivered' then now() else null::timestamptz end,
         case when $10::text in ('bounced', 'complained', 'failed') then now() else null::timestamptz end,
         $17::timestamptz
       )
       on conflict (recipient_id, channel) do update set
         state = excluded.state,
         provider = coalesce(excluded.provider, notification_channel_deliveries.provider),
         provider_message_id = coalesce(excluded.provider_message_id, notification_channel_deliveries.provider_message_id),
         template_version = coalesce(excluded.template_version, notification_channel_deliveries.template_version),
         rendered_locale = coalesce(excluded.rendered_locale, notification_channel_deliveries.rendered_locale),
         rendered_subject = coalesce(excluded.rendered_subject, notification_channel_deliveries.rendered_subject),
         rendered_body = coalesce(excluded.rendered_body, notification_channel_deliveries.rendered_body),
         legacy_email_delivery_id = excluded.legacy_email_delivery_id,
         error_code = excluded.error_code,
         error_detail = coalesce(excluded.error_detail, notification_channel_deliveries.error_detail),
         submitted_at = coalesce(notification_channel_deliveries.submitted_at, excluded.submitted_at),
         delivered_at = coalesce(notification_channel_deliveries.delivered_at, excluded.delivered_at),
         failed_at = coalesce(notification_channel_deliveries.failed_at, excluded.failed_at),
         updated_at = excluded.updated_at
       returning id`,
      [
        masterId,
        recipientId,
        latest.recipient_user_id,
        latest.template,
        latest.template_version ?? rendered?.templateVersion ?? null,
        normalizeLocaleTag(latest.locale) ?? rendered?.locale ?? "en-US",
        rendered?.subject ?? null,
        rendered?.text ?? null,
        rendered ? (rendered.templateVersion !== null ? "template_snapshot" : "explicit_snapshot") : "legacy_unknown",
        latestState,
        latest.provider,
        latest.provider_message_id,
        latest.id,
        latest.error_code,
        latest.delivery_evidence_note,
        isTest,
        latest.updated_at,
      ],
    )
  ).rows[0];

  if (!channelRow) return;
  for (const d of deliveries) {
    const attemptState = mapEmailStateToChannelState(d.state, d.error_code);
    await db.query(
      `insert into notification_delivery_attempts (
         channel_delivery_id, attempt_no, idempotency_key, provider, state,
         provider_message_id, error_code, response_summary, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (channel_delivery_id, attempt_no) do update set
         state = excluded.state,
         provider = coalesce(excluded.provider, notification_delivery_attempts.provider),
         provider_message_id = coalesce(excluded.provider_message_id, notification_delivery_attempts.provider_message_id),
         error_code = excluded.error_code,
         response_summary = coalesce(excluded.response_summary, notification_delivery_attempts.response_summary)`,
      [
        channelRow.id,
        d.attempt,
        `notification-${d.id}`,
        d.provider,
        attemptState,
        d.provider_message_id,
        d.error_code,
        d.delivery_evidence_note,
        d.updated_at,
      ],
    );
  }
}

/**
 * Ensures any legacy or direct `notifications` + `email_deliveries` row has matching unified
 * `notification_masters`, `notification_recipients`, `notification_channel_deliveries`, and attempt rows.
 */
export async function syncEmailDeliveryState(
  db: DB,
  emailDeliveryId: string,
  extra?: {
    maskedContact?: string | null;
    renderedSubject?: string | null;
    renderedBody?: string | null;
    renderedLocale?: EnabledLocale | null;
    templateVersion?: number | null;
    isTest?: boolean;
    providerEventId?: string | null;
    retryBy?: string | null;
    retryReason?: string | null;
  },
) {
  const row = (
    await db.query<{
      id: string;
      notification_id: string;
      user_id: string;
      template: string;
      order_id: string | null;
      order_is_test: boolean;
      notif_locale: string;
      dedupe_key: string;
      payload: Record<string, unknown>;
      attempt: number;
      state: string;
      provider: string | null;
      provider_message_id: string | null;
      error_code: string | null;
      delivery_evidence_note: string | null;
      email_locale: string | null;
      template_version: number | null;
      updated_at: Date;
    }>(
      `select d.id, d.notification_id, n.user_id, n.template, n.order_id,
              coalesce(o.is_test, false) as order_is_test, n.locale as notif_locale,
              n.dedupe_key, n.payload, d.attempt, d.state, d.provider,
              d.provider_message_id, d.error_code, d.delivery_evidence_note,
              d.locale as email_locale, d.template_version, d.updated_at
       from email_deliveries d
       join notifications n on n.id = d.notification_id
       left join orders o on o.id = n.order_id
       where d.id = $1`,
      [emailDeliveryId],
    )
  ).rows[0];
  if (!row) return;

  const isStaff = Boolean(
    (await db.query("select 1 from staff_roles where user_id = $1 limit 1", [row.user_id])).rowCount,
  );
  const recipientKind = isStaff ? "staff" : "customer";
  const orgId = isStaff
    ? null
    : (
        await db.query<{ org_id: string }>(
          "select org_id from customer_receiving_profiles where user_id = $1 limit 1",
          [row.user_id],
        )
      ).rows[0]?.org_id ?? null;

  const normLocale =
    extra?.renderedLocale ??
    toEnabledLocale(row.email_locale, toEnabledLocale(row.notif_locale, isStaff ? "zh-CN" : "en-US"));
  const isTest = extra?.isTest ?? row.order_is_test;

  const existingRec = (
    await db.query<{ id: string; notification_id: string }>(
      "select id, notification_id from notification_recipients where legacy_notification_id = $1 limit 1",
      [row.notification_id],
    )
  ).rows[0];

  let masterId = existingRec?.notification_id ?? null;
  let recipientId = existingRec?.id ?? null;

  if (!masterId || !recipientId) {
    const master = (
      await db.query<{ id: string }>(
        `insert into notification_masters (
           source_kind, event_type, entity_type, entity_id, template_code, template_version,
           locale, content_origin, metadata, dedupe_key, status, is_test, migrated_from_legacy_id, published_at
         ) values (
           'auto_event', $1, $2, $3, $1, $4,
           $5, $6, $7::jsonb, $8, 'delivering', $9, $10, now()
         )
         on conflict (dedupe_key) do update set
           template_version = coalesce(excluded.template_version, notification_masters.template_version),
           is_test = notification_masters.is_test or excluded.is_test,
           updated_at = now()
         returning id`,
        [
          row.template,
          row.order_id ? "orders" : "notifications",
          row.order_id ?? row.notification_id,
          extra?.templateVersion ?? row.template_version,
          normLocale,
          extra?.renderedSubject ? "template_snapshot" : "legacy_unknown",
          JSON.stringify(sanitizeCommunicationMetadata(row.payload ?? {})),
          maskInlineEmails(row.dedupe_key) ?? row.dedupe_key,
          isTest,
          row.notification_id,
        ],
      )
    ).rows[0];
    if (!master) return;
    masterId = master.id;

    const recipient = (
      await db.query<{ id: string }>(
        `insert into notification_recipients (
           notification_id, legacy_notification_id, recipient_user_id, recipient_kind, org_id, category, locale
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (legacy_notification_id) do update set
           locale = coalesce(notification_recipients.locale, excluded.locale)
         returning id`,
        [
          masterId,
          row.notification_id,
          row.user_id,
          recipientKind,
          orgId,
          classifyNotificationCategory(row.template),
          normLocale,
        ],
      )
    ).rows[0];
    if (!recipient) return;
    recipientId = recipient.id;
  }

  const master = { id: masterId };
  const recipient = { id: recipientId };

  await db.query(
    `insert into notification_channel_deliveries (
       notification_id, recipient_id, recipient_user_id, channel, template_code, rendered_locale, content_origin, state, delivered_at
     ) values ($1, $2, $3, 'in_app', $4, $5, 'legacy_unknown', 'delivered', now())
     on conflict (recipient_id, channel) do nothing`,
    [master.id, recipient.id, row.user_id, row.template, normLocale],
  );

  const mappedState = mapEmailStateToChannelState(row.state, row.error_code);
  const channelRow = (
    await db.query<{ id: string }>(
      `insert into notification_channel_deliveries (
         notification_id, recipient_id, recipient_user_id, channel, template_code, template_version,
         rendered_locale, rendered_subject, rendered_body, content_origin,
         masked_contact, state, provider, provider_message_id, legacy_email_delivery_id,
         error_code, error_detail, is_test, queued_at, submitted_at, delivered_at, failed_at, updated_at
       ) values (
         $1, $2, $3, 'email', $4, $5,
         $6, $7, $8, $9,
         $10, $11::text, $12, $13, $14,
         $15, $16, $17,
         case when $11::text = 'queued' then $18::timestamptz else null::timestamptz end,
         case when $11::text = 'submitted' then $18::timestamptz else null::timestamptz end,
         case when $11::text = 'delivered' then $18::timestamptz else null::timestamptz end,
         case when $11::text in ('bounced', 'complained', 'failed') then $18::timestamptz else null::timestamptz end,
         $18::timestamptz
       )
       on conflict (recipient_id, channel) do update set
         state = excluded.state,
         provider = coalesce(excluded.provider, notification_channel_deliveries.provider),
         provider_message_id = coalesce(excluded.provider_message_id, notification_channel_deliveries.provider_message_id),
         masked_contact = coalesce(excluded.masked_contact, notification_channel_deliveries.masked_contact),
         template_version = coalesce(excluded.template_version, notification_channel_deliveries.template_version),
         rendered_locale = coalesce(excluded.rendered_locale, notification_channel_deliveries.rendered_locale),
         rendered_subject = coalesce(excluded.rendered_subject, notification_channel_deliveries.rendered_subject),
         rendered_body = coalesce(excluded.rendered_body, notification_channel_deliveries.rendered_body),
         legacy_email_delivery_id = excluded.legacy_email_delivery_id,
         error_code = excluded.error_code,
         error_detail = coalesce(excluded.error_detail, notification_channel_deliveries.error_detail),
         is_test = notification_channel_deliveries.is_test or excluded.is_test,
         submitted_at = coalesce(notification_channel_deliveries.submitted_at, excluded.submitted_at),
         delivered_at = coalesce(notification_channel_deliveries.delivered_at, excluded.delivered_at),
         failed_at = coalesce(notification_channel_deliveries.failed_at, excluded.failed_at),
         updated_at = excluded.updated_at
       returning id`,
      [
        master.id,
        recipient.id,
        row.user_id,
        row.template,
        extra?.templateVersion ?? row.template_version,
        normLocale,
        extra?.renderedSubject ?? null,
        extra?.renderedBody ?? null,
        extra?.renderedSubject ? "template_snapshot" : "legacy_unknown",
        extra?.maskedContact ?? null,
        mappedState,
        row.provider,
        row.provider_message_id,
        row.id,
        row.error_code,
        row.delivery_evidence_note,
        isTest,
        row.updated_at,
      ],
    )
  ).rows[0];

  if (channelRow) {
    await db.query(
      `insert into notification_delivery_attempts (
         channel_delivery_id, attempt_no, idempotency_key, provider, state,
         provider_message_id, provider_event_id, error_code, response_summary, retry_by, retry_reason, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (channel_delivery_id, attempt_no) do update set
         state = excluded.state,
         provider = coalesce(excluded.provider, notification_delivery_attempts.provider),
         provider_message_id = coalesce(excluded.provider_message_id, notification_delivery_attempts.provider_message_id),
         provider_event_id = coalesce(excluded.provider_event_id, notification_delivery_attempts.provider_event_id),
         error_code = excluded.error_code,
         response_summary = coalesce(excluded.response_summary, notification_delivery_attempts.response_summary),
         retry_by = coalesce(excluded.retry_by, notification_delivery_attempts.retry_by),
         retry_reason = coalesce(excluded.retry_reason, notification_delivery_attempts.retry_reason)`,
      [
        channelRow.id,
        row.attempt,
        `notification-${row.id}`,
        row.provider,
        mappedState,
        row.provider_message_id,
        extra?.providerEventId ?? null,
        row.error_code,
        row.delivery_evidence_note,
        extra?.retryBy ?? null,
        extra?.retryReason ?? null,
        row.updated_at,
      ],
    );
  }
  await recomputeNotificationMasterStatus(db, master.id);
}

/**
 * Idempotent reconciliation of legacy `notifications` & `email_deliveries` rows without replaying any historical send (T125 / COM22).
 */
export async function backfillLegacyNotifications(db: DB) {
  const masters = await db.query<{ id: string }>(
    `insert into notification_masters (
       source_kind, event_type, entity_type, entity_id, template_code, locale,
       content_origin, metadata, dedupe_key, status, published_at, migrated_from_legacy_id, created_at, updated_at
     )
     select
       case
         when n.template in ('email.delivery_failed', 'email.channel_degraded', 'account.security_alert', 'staff.sessions_revoked') then 'security_alert'
         else 'auto_event'
       end,
       n.template,
       case
         when n.order_id is not null then 'orders'
         when n.payload ? 'ticket_id' then 'tickets'
         else 'notifications'
       end,
       coalesce(n.order_id::text, n.payload->>'ticket_id', n.payload->>'device_id', n.id::text),
       n.template,
       case when n.locale in ('zh-CN', 'zh') then 'zh-CN' else 'en-US' end,
       'legacy_unknown',
       coalesce(n.payload, '{}'::jsonb) - 'previous_email' - 'new_email' - 'contact_email' - 'email' - 'activation_token' - 'raw_token' - 'secret' - 'token',
       case
         when n.template = 'email.delivery_failed' then 'email.delivery_failed:' || coalesce(n.user_id::text, '') || ':' || left(encode(sha256(n.dedupe_key::bytea), 'hex'), 16)
         else n.dedupe_key
       end,
       case
         when exists (select 1 from email_deliveries d where d.notification_id = n.id and d.state in ('bounced', 'complained')) then 'partial_failure'
         when exists (select 1 from email_deliveries d where d.notification_id = n.id and d.state in ('unknown', 'deferred', 'queued')) then 'delivering'
         else 'completed'
       end,
       coalesce(n.created_at, now()),
       n.id,
       coalesce(n.created_at, now()),
       coalesce(n.created_at, now())
     from notifications n
     where n.user_id is not null
       and not exists (select 1 from notification_recipients nr where nr.legacy_notification_id = n.id)
     on conflict do nothing
     returning id`,
  );

  const recipients = await db.query<{ id: string }>(
    `insert into notification_recipients (
       notification_id, legacy_notification_id, recipient_user_id, recipient_kind, org_id,
       category, locale, read_at, created_at
     )
     select
       nm.id,
       n.id,
       n.user_id,
       case when crp.org_id is not null then 'customer' else 'staff' end,
       crp.org_id,
       case
         when n.template like 'order.%' then 'orders'
         when n.template like 'report.%' then 'reports'
         when n.template like 'package.%' or n.template like 'tracking.%' or n.template like 'shipment.%' or n.template = 'reference.sealed' then 'parcels'
         when n.template like 'payment.%' or n.template like 'refund.%' or n.template like '%.quoted' or n.template = 'quote.offered' then 'billing'
         when n.template like 'ticket.%' or n.template like 'incident.%' or n.template in ('email.delivery_failed', 'account.registered') then 'support'
         when n.template in ('email.channel_degraded', 'staff.sessions_revoked', 'account.security_alert', 'staff.invited', 'staff.activated', 'staff.offboarded', 'staff.role_changed') then 'security'
         else 'system'
       end,
       case when n.locale in ('zh-CN', 'zh') then 'zh-CN' else 'en-US' end,
       n.read_at,
       coalesce(n.created_at, now())
     from notifications n
     join notification_masters nm on nm.migrated_from_legacy_id = n.id or nm.dedupe_key = n.dedupe_key
     left join lateral (
       select p.org_id from customer_receiving_profiles p where p.user_id = n.user_id limit 1
     ) crp on true
     where n.user_id is not null
     on conflict do nothing
     returning id`,
  );

  await db.query(
    `insert into notification_channel_deliveries (
       notification_id, recipient_id, recipient_user_id, channel, template_code,
       rendered_locale, content_origin, state, delivered_at, read_at, created_at, updated_at
     )
     select
       nr.notification_id, nr.id, nr.recipient_user_id, 'in_app', nm.template_code,
       nr.locale, 'legacy_unknown',
       case when nr.read_at is not null then 'read' else 'delivered' end,
       nr.created_at, nr.read_at, nr.created_at, coalesce(nr.read_at, nr.created_at)
     from notification_recipients nr
     join notification_masters nm on nm.id = nr.notification_id
     on conflict do nothing`,
  );

  const emails = await db.query<{ id: string }>(
    `insert into notification_channel_deliveries (
       notification_id, recipient_id, recipient_user_id, channel, template_code, template_version,
       rendered_locale, content_origin, state, provider, provider_message_id, legacy_email_delivery_id,
       error_code, delivered_at, created_at, updated_at
     )
     select
       nr.notification_id, nr.id, nr.recipient_user_id, 'email', nm.template_code, d.template_version,
       case when d.locale in ('zh-CN', 'zh') then 'zh-CN' when d.locale in ('en-US', 'en') then 'en-US' else nr.locale end,
       'legacy_unknown',
       case when d.error_code = 'ADDRESS_SUPPRESSED' then 'suppressed'
            when d.state in ('queued', 'submitted', 'delivered', 'deferred', 'bounced', 'complained', 'unknown') then d.state
            else 'failed' end,
       d.provider, d.provider_message_id, d.id, d.error_code,
       case when d.state = 'delivered' then d.updated_at else null end,
       nr.created_at, d.updated_at
     from (
       select distinct on (notification_id) *
       from email_deliveries
       order by notification_id, attempt desc, updated_at desc
     ) d
     join notification_recipients nr on nr.legacy_notification_id = d.notification_id
     join notification_masters nm on nm.id = nr.notification_id
     on conflict do nothing
     returning id`,
  );

  await db.query(
    `insert into notification_delivery_attempts (
       channel_delivery_id, attempt_no, idempotency_key, provider, state,
       provider_message_id, error_code, response_summary, created_at
     )
     select
       ncd.id, d.attempt, 'legacy-email:' || d.id::text || ':a' || d.attempt::text,
       d.provider,
       case when d.error_code = 'ADDRESS_SUPPRESSED' then 'suppressed'
            when d.state in ('queued', 'submitted', 'delivered', 'deferred', 'bounced', 'complained', 'unknown') then d.state
            else 'failed' end,
       d.provider_message_id, d.error_code, d.delivery_evidence_note, d.updated_at
     from email_deliveries d
     join notification_recipients nr on nr.legacy_notification_id = d.notification_id
     join notification_channel_deliveries ncd on ncd.recipient_id = nr.id and ncd.channel = 'email'
     on conflict do nothing`,
  );

  return {
    migrated_masters: masters.rowCount ?? 0,
    migrated_recipients: recipients.rowCount ?? 0,
    migrated_email_deliveries: emails.rowCount ?? 0,
    historical_replayed: 0 as const,
  };
}

export async function getCustomerNotificationDetail(
  db: Pick<DB, "query">,
  actor: Actor,
  notificationId: string,
) {
  const org = organization(actor);
  const row = (
    await db.query<{
      id: string;
      template: string;
      locale: string;
      read_at: Date | null;
      created_at: Date;
      order_id: string | null;
      order_number: string | null;
      payload: Record<string, unknown>;
      title_snapshot: string | null;
      body_snapshot: string | null;
      cta_path: string | null;
      associated_todo_kind: string | null;
      associated_todo_id: string | null;
      channel_deliveries: unknown[];
    }>(
      `with unified as (
         select
           n.id, n.template, coalesce(nr.locale, n.locale) as locale,
           coalesce(nr.read_at, n.read_at) as read_at, n.created_at,
           n.order_id, o.public_no as order_number, n.payload,
           coalesce(nr.title_snapshot, nm.title_snapshot) as title_snapshot,
           coalesce(nr.body_snapshot, nm.body_snapshot) as body_snapshot,
           coalesce(nr.cta_path, nm.cta_path) as cta_path,
           nr.associated_todo_kind, nr.associated_todo_id,
           nr.id as recipient_id, nm.id as master_id
         from notifications n
         left join notification_recipients nr on nr.legacy_notification_id = n.id
         left join notification_masters nm on nm.id = nr.notification_id
         left join orders o on o.id = n.order_id and o.org_id = $2
         where n.user_id = $3 and nr.retracted_at is null
         union all
         select
           nr.id, nm.template_code as template, nr.locale,
           nr.read_at, nr.created_at,
           case when nm.entity_type = 'orders' and nm.entity_id ~ '^[0-9a-f-]{36}$' then nm.entity_id::uuid else null::uuid end as order_id,
           o.public_no as order_number, nm.metadata as payload,
           coalesce(nr.title_snapshot, nm.title_snapshot) as title_snapshot,
           coalesce(nr.body_snapshot, nm.body_snapshot) as body_snapshot,
           coalesce(nr.cta_path, nm.cta_path) as cta_path,
           nr.associated_todo_kind, nr.associated_todo_id,
           nr.id as recipient_id, nm.id as master_id
         from notification_recipients nr
         join notification_masters nm on nm.id = nr.notification_id
         left join orders o on o.id::text = nm.entity_id and nm.entity_type = 'orders' and o.org_id = $2
         where nr.recipient_user_id = $3 and nr.legacy_notification_id is null and nr.retracted_at is null
       )
       select
         u.id, u.template, u.locale, u.read_at, u.created_at,
         u.order_id, u.order_number, u.payload,
         u.title_snapshot, u.body_snapshot, u.cta_path,
         u.associated_todo_kind, u.associated_todo_id,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'channel', ncd.channel,
             'state', ncd.state,
             'masked_contact', ncd.masked_contact,
             'rendered_locale', ncd.rendered_locale,
             'is_test', ncd.is_test,
             'error_code', ncd.error_code,
             'delivered_at', ncd.delivered_at,
             'read_at', ncd.read_at
           ) order by ncd.channel)
           from notification_channel_deliveries ncd
           where ncd.recipient_id = u.recipient_id
         ), '[]'::jsonb) as channel_deliveries
       from unified u
       where u.id = $1 or u.recipient_id = $1 or u.master_id = $1
       limit 1`,
      [notificationId, org, actor.id],
    )
  ).rows[0];
  guard(Boolean(row), "NOT_FOUND", "Notification not found.", 404);
  const safePayload = sanitizeCommunicationMetadata(row.payload ?? {});
  return {
    ...row,
    payload: safePayload,
    title: row.title_snapshot ?? buildInAppTitle(row.template, toEnabledLocale(row.locale, "en-US"), row.order_number),
    action_path: row.cta_path ?? notificationActionPath(row.template, safePayload, row.order_number, "customer"),
    marking_read_closes_todo: false as const,
  };
}

export async function listStaffInbox(
  db: Pick<DB, "query">,
  actor: Actor,
  query: z.infer<typeof staffNotificationQuerySchema> = { category: "all" },
  pageSize = 50,
) {
  role(actor, ...READ_STAFF_ROLES);
  const onlyUnread = query.unread === "1";
  const category = query.category ?? "all";
  const before = query.before ?? null;

  const { rows } = await db.query<{
    id: string;
    legacy_id: string | null;
    master_id: string | null;
    template: string;
    locale: string;
    category: string;
    payload: Record<string, unknown>;
    title_snapshot: string | null;
    body_snapshot: string | null;
    cta_path: string | null;
    source_kind: string;
    is_test: boolean;
    associated_todo_kind: string | null;
    associated_todo_id: string | null;
    read_at: Date | null;
    created_at: Date;
    channel_deliveries: unknown[];
  }>(
    `with combined as (
       select
         n.id as id,
         n.id as legacy_id,
         nr.notification_id as master_id,
         n.template,
         coalesce(nr.locale, n.locale) as locale,
         coalesce(nr.category,
           case
             when n.template in ('email.channel_degraded', 'staff.sessions_revoked', 'account.security_alert', 'staff.invited', 'staff.activated', 'staff.offboarded', 'staff.role_changed') then 'security'
             when n.template like 'ticket.%' or n.template like 'incident.%' then 'support'
             when n.template like 'order.%' then 'orders'
             when n.template like 'report.%' then 'reports'
             else 'system'
           end) as category,
         n.payload,
         coalesce(nr.title_snapshot, nm.title_snapshot) as title_snapshot,
         coalesce(nr.body_snapshot, nm.body_snapshot) as body_snapshot,
         coalesce(nr.cta_path, nm.cta_path) as cta_path,
         coalesce(nm.source_kind, 'auto_event') as source_kind,
         coalesce(nm.is_test, false) as is_test,
         nr.associated_todo_kind,
         nr.associated_todo_id,
         coalesce(nr.read_at, n.read_at) as read_at,
         n.created_at,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'channel', ncd.channel,
             'state', ncd.state,
             'delivered_at', ncd.delivered_at,
             'read_at', ncd.read_at
           ) order by ncd.channel)
           from notification_channel_deliveries ncd
           where ncd.recipient_id = nr.id
         ), '[]'::jsonb) as channel_deliveries
       from notifications n
       left join notification_recipients nr on nr.legacy_notification_id = n.id
       left join notification_masters nm on nm.id = nr.notification_id
       where n.user_id = $1
         and (nr.retracted_at is null)
       union all
       select
         nr.id as id,
         null::uuid as legacy_id,
         nr.notification_id as master_id,
         nm.template_code as template,
         nr.locale,
         nr.category,
         nm.metadata as payload,
         coalesce(nr.title_snapshot, nm.title_snapshot) as title_snapshot,
         coalesce(nr.body_snapshot, nm.body_snapshot) as body_snapshot,
         coalesce(nr.cta_path, nm.cta_path) as cta_path,
         nm.source_kind,
         nm.is_test,
         nr.associated_todo_kind,
         nr.associated_todo_id,
         nr.read_at,
         nr.created_at,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'channel', ncd.channel,
             'state', ncd.state,
             'delivered_at', ncd.delivered_at,
             'read_at', ncd.read_at
           ) order by ncd.channel)
           from notification_channel_deliveries ncd
           where ncd.recipient_id = nr.id
         ), '[]'::jsonb) as channel_deliveries
       from notification_recipients nr
       join notification_masters nm on nm.id = nr.notification_id
       where nr.recipient_user_id = $1
         and nr.legacy_notification_id is null
         and nr.retracted_at is null
     )
     select * from combined c
     where (not $2::boolean or c.read_at is null)
       and ($3::text = 'all' or c.category = $3)
       and ($4::uuid is null or (coalesce(c.created_at, '-infinity'), c.id) < (
         select coalesce(prev.created_at, '-infinity'), prev.id
         from combined prev where prev.id = $4 limit 1
       ))
     order by c.created_at desc nulls last, c.id desc
     limit $5`,
    [actor.id, onlyUnread, category, before, pageSize + 1],
  );

  const page = rows.slice(0, pageSize).map((r) => ({
    ...r,
    title: r.title_snapshot ?? buildInAppTitle(r.template, toEnabledLocale(r.locale, "zh-CN")),
    action_path: r.cta_path ?? notificationActionPath(r.template, r.payload ?? {}, null, "staff"),
  }));
  const unreadRow = (
    await db.query<{ c: number }>(
      `select (
         (select count(*)::int from notifications where user_id = $1 and read_at is null) +
         (select count(*)::int from notification_recipients
          where recipient_user_id = $1 and legacy_notification_id is null and retracted_at is null and read_at is null)
       )::int as c`,
      [actor.id],
    )
  ).rows[0];

  return {
    notifications: page,
    rows: page,
    unread_count: unreadRow?.c ?? 0,
    next_before: rows.length > pageSize ? page.at(-1)?.id ?? null : null,
  };
}

export async function getStaffNotificationDetail(
  db: Pick<DB, "query">,
  actor: Actor,
  notificationId: string,
) {
  role(actor, ...READ_STAFF_ROLES);
  const found = (
    await db.query<{
      id: string;
      legacy_id: string | null;
      master_id: string | null;
      template: string;
      locale: string;
      category: string;
      payload: Record<string, unknown>;
      title_snapshot: string | null;
      body_snapshot: string | null;
      cta_path: string | null;
      source_kind: string;
      is_test: boolean;
      associated_todo_kind: string | null;
      associated_todo_id: string | null;
      read_at: Date | null;
      created_at: Date;
      channel_deliveries: unknown[];
    }>(
      `with combined as (
         select
           n.id as id, n.id as legacy_id, nr.notification_id as master_id,
           n.template, coalesce(nr.locale, n.locale) as locale,
           coalesce(nr.category, 'system') as category,
           n.payload,
           coalesce(nr.title_snapshot, nm.title_snapshot) as title_snapshot,
           coalesce(nr.body_snapshot, nm.body_snapshot) as body_snapshot,
           coalesce(nr.cta_path, nm.cta_path) as cta_path,
           coalesce(nm.source_kind, 'auto_event') as source_kind,
           coalesce(nm.is_test, false) as is_test,
           nr.associated_todo_kind, nr.associated_todo_id,
           coalesce(nr.read_at, n.read_at) as read_at, n.created_at,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'channel', ncd.channel, 'state', ncd.state,
               'delivered_at', ncd.delivered_at, 'read_at', ncd.read_at
             ) order by ncd.channel)
             from notification_channel_deliveries ncd
             where ncd.recipient_id = nr.id
           ), '[]'::jsonb) as channel_deliveries
         from notifications n
         left join notification_recipients nr on nr.legacy_notification_id = n.id
         left join notification_masters nm on nm.id = nr.notification_id
         where n.user_id = $2 and nr.retracted_at is null
         union all
         select
           nr.id as id, null::uuid as legacy_id, nr.notification_id as master_id,
           nm.template_code as template, nr.locale, nr.category,
           nm.metadata as payload,
           coalesce(nr.title_snapshot, nm.title_snapshot) as title_snapshot,
           coalesce(nr.body_snapshot, nm.body_snapshot) as body_snapshot,
           coalesce(nr.cta_path, nm.cta_path) as cta_path,
           nm.source_kind, nm.is_test,
           nr.associated_todo_kind, nr.associated_todo_id,
           nr.read_at, nr.created_at,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'channel', ncd.channel, 'state', ncd.state,
               'delivered_at', ncd.delivered_at, 'read_at', ncd.read_at
             ) order by ncd.channel)
             from notification_channel_deliveries ncd
             where ncd.recipient_id = nr.id
           ), '[]'::jsonb) as channel_deliveries
         from notification_recipients nr
         join notification_masters nm on nm.id = nr.notification_id
         where nr.recipient_user_id = $2 and nr.legacy_notification_id is null and nr.retracted_at is null
       )
       select * from combined
       where id = $1 or legacy_id = $1 or master_id = $1
       limit 1`,
      [notificationId, actor.id],
    )
  ).rows[0];
  guard(Boolean(found), "NOT_FOUND", "Staff notification not found.", 404);
  const safePayload = sanitizeCommunicationMetadata(found.payload ?? {});
  return {
    ...found,
    payload: safePayload,
    title: found.title_snapshot ?? buildInAppTitle(found.template, toEnabledLocale(found.locale, "zh-CN")),
    action_path: found.cta_path ?? notificationActionPath(found.template, safePayload, null, "staff"),
    marking_read_closes_todo: false as const,
  };
}

export async function markStaffInboxRead(db: DB, actor: Actor, notificationId: string) {
  role(actor, ...READ_STAFF_ROLES);
  const legacyUpd = (
    await db.query<{ id: string; template: string; read_at: Date }>(
      `update notifications
       set read_at = coalesce(read_at, now())
       where id = $1 and user_id = $2
       returning id, template, read_at`,
      [notificationId, actor.id],
    )
  ).rows[0];

  const recUpd = (
    await db.query<{ id: string; legacy_notification_id: string | null; read_at: Date }>(
      `update notification_recipients
       set read_at = coalesce(read_at, now())
       where recipient_user_id = $2
         and (id = $1 or legacy_notification_id = $1)
       returning id, legacy_notification_id, read_at`,
      [notificationId, actor.id],
    )
  ).rows[0];

  guard(Boolean(legacyUpd || recUpd), "NOT_FOUND", "Staff notification not found.", 404);
  if (recUpd) {
    await db.query(
      `update notification_channel_deliveries
       set state = 'read', read_at = coalesce(read_at, $2), updated_at = now()
       where recipient_id = $1 and channel = 'in_app'`,
      [recUpd.id, recUpd.read_at],
    );
  }
  return {
    notification: {
      id: legacyUpd?.id ?? recUpd!.id,
      template: legacyUpd?.template ?? "",
      read_at: legacyUpd?.read_at ?? recUpd!.read_at,
    },
    business_todo_closed: false as const,
  };
}

export async function markAllStaffInboxRead(db: DB, actor: Actor) {
  role(actor, ...READ_STAFF_ROLES);
  const res1 = await db.query(
    `update notifications set read_at = coalesce(read_at, now()) where user_id = $1 and read_at is null`,
    [actor.id],
  );
  const res2 = await db.query(
    `update notification_recipients set read_at = coalesce(read_at, now())
     where recipient_user_id = $1 and read_at is null and retracted_at is null`,
    [actor.id],
  );
  await db.query(
    `update notification_channel_deliveries
     set state = 'read', read_at = coalesce(read_at, now()), updated_at = now()
     where recipient_user_id = $1 and channel = 'in_app' and read_at is null`,
    [actor.id],
  );
  return { updated: Math.max(res1.rowCount ?? 0, res2.rowCount ?? 0), business_todo_closed: false as const };
}

async function loadLiveStaffScope(db: Pick<DB, "query">, actor: Actor, scope?: StaffScopeContext): Promise<StaffScopeContext> {
  if (scope) return scope;
  const userRow = (
    await db.query<{ status: "active" | "restricted" | "disabled" | "closed" }>(
      "select status from users where id = $1 limit 1",
      [actor.id],
    )
  ).rows[0];
  return { accountStatus: userRow?.status ?? "disabled" };
}

const SCOPED_SUPPORT_FILTER_SQL = `
  nm.source_kind <> 'security_alert'
  and nm.event_type not like 'owner.%'
  and nm.event_type not like 'staff.%'
  and nm.event_type <> 'email.channel_degraded'
  and nm.entity_type <> 'staff_profiles'
`;

export async function listAdminCommunicationHistory(
  db: Pick<DB, "query">,
  actor: Actor,
  rawQuery: z.infer<typeof adminCommunicationHistoryQuerySchema>,
  scope?: StaffScopeContext,
) {
  evaluateAuthorization(actor, "notifications.read_scoped", await loadLiveStaffScope(db, actor, scope));
  const isSuperAdmin = actor.roles.includes("super_admin");
  const visibilitySql = isSuperAdmin ? "true" : SCOPED_SUPPORT_FILTER_SQL;
  const pageSize = 25;
  const q = adminCommunicationHistoryQuerySchema.parse(rawQuery);
  const offset = (q.page - 1) * pageSize;

  const { rows } = await db.query<{
    id: string;
    source_kind: string;
    event_type: string;
    entity_type: string;
    entity_id: string | null;
    entity_version: number;
    template_code: string;
    template_version: number | null;
    locale: string;
    priority: string;
    title_snapshot: string | null;
    content_origin: string;
    dedupe_key: string;
    status: string;
    is_test: boolean;
    created_at: Date;
    recipient_count: number;
    channel_delivery_count: number;
    attempt_count: number;
    channel_states: unknown[];
  }>(
    `select
       nm.id, nm.source_kind, nm.event_type, nm.entity_type, nm.entity_id, nm.entity_version,
       nm.template_code, nm.template_version, nm.locale, nm.priority, nm.title_snapshot,
       nm.content_origin, nm.dedupe_key, nm.status, nm.is_test, nm.created_at,
       (select count(*)::int from notification_recipients nr where nr.notification_id = nm.id) as recipient_count,
       (select count(*)::int from notification_channel_deliveries ncd where ncd.notification_id = nm.id) as channel_delivery_count,
       (select count(*)::int from notification_delivery_attempts nda
        join notification_channel_deliveries ncd on ncd.id = nda.channel_delivery_id
        where ncd.notification_id = nm.id) as attempt_count,
       coalesce((
         select jsonb_agg(jsonb_build_object(
           'channel', ncd.channel,
           'state', ncd.state,
           'masked_contact', ncd.masked_contact,
           'provider', ncd.provider,
           'error_code', ncd.error_code
         ) order by ncd.created_at)
         from notification_channel_deliveries ncd
         where ncd.notification_id = nm.id
       ), '[]'::jsonb) as channel_states
     from notification_masters nm
     where (${visibilitySql})
       and ($1::text = '1' or nm.is_test = false)
       and ($2::text is null or nm.event_type = $2)
       and ($3::text is null or nm.entity_type = $3)
       and ($4::uuid is null or exists(
         select 1 from notification_recipients nr
         where nr.notification_id = nm.id and nr.recipient_user_id = $4
       ))
       and ($5::text = 'all' or exists(
         select 1 from notification_channel_deliveries ncd
         where ncd.notification_id = nm.id and ncd.channel = $5
       ))
       and ($6::text is null or exists(
         select 1 from notification_channel_deliveries ncd
         where ncd.notification_id = nm.id and ncd.state = $6
       ))
       and ($7::text is null or nm.event_type ilike '%' || $7 || '%' or coalesce(nm.title_snapshot, '') ilike '%' || $7 || '%')
     order by nm.created_at desc, nm.id desc
     limit $8 offset $9`,
    [
      q.include_test,
      q.event_type || null,
      q.entity_type || null,
      q.recipient_user_id ?? null,
      q.channel,
      q.state || null,
      q.q || null,
      pageSize + 1,
      offset,
    ],
  );

  const safeRows = rows.slice(0, pageSize).map((r) => ({
    ...r,
    entity_id: maskInlineEmails(r.entity_id),
    dedupe_key: maskInlineEmails(r.dedupe_key) ?? r.dedupe_key,
  }));

  const stats = (
    await db.query<{
      master_count: number;
      recipient_count: number;
      channel_delivery_count: number;
      attempt_count: number;
      failed_channel_count: number;
      unknown_channel_count: number;
      suppressed_channel_count: number;
    }>(
      `select
         (select count(*)::int from notification_masters nm where ${visibilitySql}) as master_count,
         (select count(*)::int from notification_recipients nr join notification_masters nm on nm.id = nr.notification_id where ${visibilitySql}) as recipient_count,
         (select count(*)::int from notification_channel_deliveries ncd join notification_masters nm on nm.id = ncd.notification_id where ${visibilitySql}) as channel_delivery_count,
         (select count(*)::int from notification_delivery_attempts nda join notification_channel_deliveries ncd on ncd.id = nda.channel_delivery_id join notification_masters nm on nm.id = ncd.notification_id where ${visibilitySql}) as attempt_count,
         (select count(*)::int from notification_channel_deliveries ncd join notification_masters nm on nm.id = ncd.notification_id where (${visibilitySql}) and ncd.state in ('bounced', 'complained', 'failed')) as failed_channel_count,
         (select count(*)::int from notification_channel_deliveries ncd join notification_masters nm on nm.id = ncd.notification_id where (${visibilitySql}) and ncd.state in ('unknown', 'deferred')) as unknown_channel_count,
         (select count(*)::int from notification_channel_deliveries ncd join notification_masters nm on nm.id = ncd.notification_id where (${visibilitySql}) and ncd.state = 'suppressed') as suppressed_channel_count`,
    )
  ).rows[0];

  return {
    rows: safeRows,
    page: q.page,
    has_more: rows.length > pageSize,
    summary: stats ?? {
      master_count: 0,
      recipient_count: 0,
      channel_delivery_count: 0,
      attempt_count: 0,
      failed_channel_count: 0,
      unknown_channel_count: 0,
      suppressed_channel_count: 0,
    },
  };
}

export async function getAdminCommunicationDetail(
  db: Pick<DB, "query">,
  actor: Actor,
  masterId: string,
  scope?: StaffScopeContext,
) {
  evaluateAuthorization(actor, "notifications.read_scoped", await loadLiveStaffScope(db, actor, scope));
  const isSuperAdmin = actor.roles.includes("super_admin");
  const visibilitySql = isSuperAdmin ? "true" : SCOPED_SUPPORT_FILTER_SQL;
  const master = (
    await db.query<{
      id: string;
      source_kind: string;
      event_type: string;
      event_id: string | null;
      entity_type: string;
      entity_id: string | null;
      entity_version: number;
      template_code: string;
      template_version: number | null;
      locale: string;
      priority: string;
      title_snapshot: string | null;
      body_snapshot: string | null;
      cta_path: string | null;
      content_origin: string;
      metadata: Record<string, unknown>;
      dedupe_key: string;
      status: string;
      is_test: boolean;
      migrated_from_legacy_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select id, source_kind, event_type, event_id, entity_type, entity_id, entity_version,
              template_code, template_version, locale, priority, title_snapshot, body_snapshot,
              cta_path, content_origin, metadata, dedupe_key, status, is_test,
              migrated_from_legacy_id, created_at, updated_at
       from notification_masters nm where id = $1 and (${visibilitySql})`,
      [masterId],
    )
  ).rows[0];
  guard(Boolean(master), "NOT_FOUND", "Communication record not found.", 404);

  const safeMaster = {
    ...master,
    entity_id: maskInlineEmails(master.entity_id),
    dedupe_key: maskInlineEmails(master.dedupe_key) ?? master.dedupe_key,
    metadata: sanitizeCommunicationMetadata(master.metadata),
  };

  const recipients = (
    await db.query(
      `select nr.id, nr.recipient_user_id, u.display_name as recipient_name, nr.recipient_kind,
              nr.org_id, nr.category, nr.locale, nr.read_at, nr.archived_at, nr.retracted_at,
              nr.associated_todo_kind, nr.associated_todo_id, nr.created_at
       from notification_recipients nr
       left join users u on u.id = nr.recipient_user_id
       where nr.notification_id = $1
       order by nr.created_at, nr.id`,
      [masterId],
    )
  ).rows;

  const deliveries = (
    await db.query(
      `select ncd.id, ncd.recipient_id, ncd.recipient_user_id, ncd.channel, ncd.template_code,
              ncd.template_version, ncd.rendered_locale, ncd.rendered_subject, ncd.rendered_body,
              ncd.content_origin, ncd.masked_contact, ncd.state, ncd.provider, ncd.provider_message_id,
              ncd.error_code, ${isSuperAdmin ? "ncd.error_detail" : "null::text as error_detail"}, ncd.is_test, ncd.queued_at, ncd.submitted_at,
              ncd.delivered_at, ncd.read_at, ncd.failed_at, ncd.created_at, ncd.updated_at,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', nda.id,
                  'attempt_no', nda.attempt_no,
                  'idempotency_key', nda.idempotency_key,
                  'provider', nda.provider,
                  'state', nda.state,
                  'provider_message_id', nda.provider_message_id,
                  'provider_event_id', nda.provider_event_id,
                  'error_code', nda.error_code,
                  'response_summary', nda.response_summary,
                  'retry_by', nda.retry_by,
                  'retry_reason', nda.retry_reason,
                  'created_at', nda.created_at
                ) order by nda.attempt_no asc)
                from notification_delivery_attempts nda
                where nda.channel_delivery_id = ncd.id
              ), '[]'::jsonb) as attempts
       from notification_channel_deliveries ncd
       where ncd.notification_id = $1
       order by ncd.created_at, ncd.channel`,
      [masterId],
    )
  ).rows;

  return { master: safeMaster, recipients, deliveries };
}

export async function emitActiveSuperAdminEvent(
  db: DB,
  params: {
    sourceKind?: CommunicationSourceKind;
    eventType: string;
    entityType: string;
    entityId?: string | null;
    entityVersion?: number;
    dedupeKey: string;
    metadata?: Record<string, unknown>;
    createdBy?: string | null;
    channels?: readonly NotificationChannel[];
  },
) {
  const admins = (
    await db.query<{ user_id: string }>(
      `select distinct sr.user_id
       from staff_roles sr
       join users u on u.id = sr.user_id
       where sr.role = 'super_admin' and u.status = 'active'`,
    )
  ).rows;
  if (admins.length === 0) return null;
  return emitCommunicationEvent(db, {
    sourceKind: params.sourceKind ?? "auto_event",
    eventType: params.eventType,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    entityVersion: params.entityVersion ?? 1,
    dedupeKey: params.dedupeKey,
    metadata: params.metadata,
    createdBy: params.createdBy ?? null,
    channels: params.channels ?? ["in_app"],
    recipients: admins.map((a) => ({ userId: a.user_id, kind: "staff" as const })),
  });
}

export async function runLegacyReconciliation(db: DB, actor: Actor, scope?: StaffScopeContext) {
  evaluateAuthorization(actor, "notifications.templates", await loadLiveStaffScope(db, actor, scope));
  const res = await backfillLegacyNotifications(db);
  await audit(db, actor, "reconcile_legacy_communications", "notification_masters", null, res);
  return res;
}
