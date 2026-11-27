import { guard, uuid, type Actor } from "./common";
import { evaluateAuthorization, type StaffScopeContext } from "./authz-contract";
import { assertEnabledLocale, type EnabledLocale } from "./locale-contract";

export const NOTIFICATION_CHANNELS = ["in_app", "email", "whatsapp"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type NotificationMasterRecord = {
  id: string;
  sourceKind: "auto_event" | "manual_targeted" | "announcement" | "security_alert";
  eventType: string;
  entityType: string;
  entityId: string | null;
  entityVersion: number;
  templateCode: string;
  templateVersion: number;
  locale: EnabledLocale;
  dedupeKey: string;
  titleSnapshot: string;
  bodySnapshot: string;
  createdBy: string | null;
};

export type RecipientInboxRecord = {
  id: string;
  notificationId: string;
  recipientUserId: string;
  orgId: string | null;
  readAt: string | null;
  archivedAt: string | null;
  associatedTodoId: string | null;
};

export type ChannelDeliveryAttempt = {
  attemptId: string;
  notificationId: string;
  recipientUserId: string;
  channel: NotificationChannel;
  attemptNo: number;
  idempotencyKey: string;
  maskedContact: string | null;
  renderedLocale: EnabledLocale;
  state: "queued" | "submitted" | "delivered" | "bounced" | "complained" | "suppressed" | "failed" | "unknown";
  providerMessageId: string | null;
  isTest: boolean;
};

export type TicketMessageRecord = {
  id: string;
  ticketId: string;
  kind: "customer_message" | "staff_reply" | "internal_note";
  authorId: string | null;
  authorKind: "customer" | "staff" | "system";
  originalBody: string;
  originalLocale: EnabledLocale;
  translatedBody: string | null;
  translatedLocale: EnabledLocale | null;
  createdAt: string;
};

export function buildNotificationDedupeKey(params: {
  eventType: string;
  entityId: string | null;
  entityVersion: number;
  recipientUserId: string;
  channel: NotificationChannel;
  reminderStage?: string;
}): string {
  return [
    params.eventType,
    params.entityId ?? "global",
    `v${params.entityVersion}`,
    params.recipientUserId,
    params.channel,
    params.reminderStage ?? "initial",
  ].join(":");
}

export function renderLockedTemplateSnapshot(params: {
  templateCode: string;
  locale: string;
  titleTemplate: string;
  bodyTemplate: string;
  variables: Record<string, string | number>;
}): { locale: EnabledLocale; title: string; body: string } {
  const locale = assertEnabledLocale(params.locale);
  const interpolate = (tpl: string) =>
    tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
      guard(key in params.variables, "NOTIFICATION_VARIABLE_MISSING", `Missing required variable '${key}' for '${params.templateCode}'.`, 422);
      const val = String(params.variables[key]);
      // Prevent HTML/script injection in interpolated notification text.
      guard(!/[<>]/.test(val), "UNSAFE_TEMPLATE_VARIABLE", `Variable '${key}' contains forbidden markup characters.`, 422);
      return val;
    });
  return {
    locale,
    title: interpolate(params.titleTemplate),
    body: interpolate(params.bodyTemplate),
  };
}

/**
 * Reading an in-app notification updates only THAT recipient's inbox record and NEVER auto-closes
 * an underlying Action Required business todo or mutates other recipients in the same organization (§65.4).
 */
export function markRecipientNotificationRead(
  inboxRows: readonly RecipientInboxRecord[],
  targetNotificationId: string,
  actingUserId: string,
): { updated: RecipientInboxRecord[]; businessTodoAutoClosed: false } {
  let matched = false;
  const updated = inboxRows.map((row) => {
    if (row.notificationId === targetNotificationId && row.recipientUserId === actingUserId) {
      matched = true;
      return { ...row, readAt: row.readAt ?? new Date().toISOString() };
    }
    return row;
  });
  guard(matched, "NOT_FOUND", "Notification record not found for recipient.", 404);
  return { updated, businessTodoAutoClosed: false };
}

export function assertNotificationSendAuthorized(params: {
  actor: Actor | null;
  scope: StaffScopeContext;
  sourceKind: NotificationMasterRecord["sourceKind"];
  channel: NotificationChannel;
  channelConfig: { emailConfigured?: boolean; whatsappVerifiedAndConsented?: boolean };
  recipientUserId: string;
  authorizedRecipientPool: readonly string[];
}): { allowed: true } {
  const action = params.sourceKind === "announcement" ? "notifications.broadcast" : "notifications.send";
  evaluateAuthorization(params.actor, action, params.scope);

  guard(
    params.authorizedRecipientPool.includes(params.recipientUserId),
    "RECIPIENT_OUT_OF_SCOPE",
    "Target recipient is outside the authorized audience scope.",
    403,
  );
  if (params.channel === "whatsapp") {
    guard(
      params.channelConfig.whatsappVerifiedAndConsented === true,
      "WHATSAPP_CHANNEL_UNVERIFIED",
      "WhatsApp delivery requires verified official channel configuration and explicit recipient opt-in.",
      409,
    );
  }
  return { allowed: true };
}

/**
 * Strict support ticket message projection: customers NEVER receive internal_note records;
 * original customer text remains intact while bilingual translations are additive fields (§65.8).
 */
export function projectTicketMessagesForActor(
  actor: Actor,
  messages: readonly TicketMessageRecord[],
  customerOrgId: string | null,
): TicketMessageRecord[] {
  if (actor.kind === "customer") {
    guard(actor.org && customerOrgId && actor.org === customerOrgId, "NOT_FOUND", "Ticket not found.", 404);
    return messages.filter((m) => m.kind !== "internal_note");
  }
  return [...messages];
}

export function appendTicketOriginalPreserved(params: {
  ticketId: string;
  actor: Actor;
  kind: TicketMessageRecord["kind"];
  body: string;
  locale: string;
}): TicketMessageRecord {
  const locale = assertEnabledLocale(params.locale);
  if (params.kind === "customer_message") {
    guard(params.actor.kind === "customer", "FORBIDDEN", "Only customer accounts can submit customer_message entries.", 403);
  } else {
    guard(params.actor.kind === "staff", "FORBIDDEN", `Only staff accounts can author '${params.kind}' entries.`, 403);
  }
  guard(params.body.trim().length >= 2, "INVALID_REQUEST", "Message body is too short.", 422);
  return {
    id: uuid(),
    ticketId: params.ticketId,
    kind: params.kind,
    authorId: params.actor.id,
    authorKind: params.actor.kind,
    originalBody: params.body,
    originalLocale: locale,
    translatedBody: null,
    translatedLocale: null,
    createdAt: new Date().toISOString(),
  };
}
