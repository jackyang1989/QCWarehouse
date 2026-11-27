import { createHmac, timingSafeEqual } from "node:crypto";
import { pool, transaction, type DB } from "../db";
import { appOrigin, decryptSecret, encryptSecret, requireStaffMfa } from "./auth";
import { audit, guard, hash, isDemo, lock, one, organization, role, uuid, type Actor } from "./common";
import { emitCommunicationEvent, syncEmailDeliveryState } from "./communications";
import { EMAIL_SUBMISSION_TIMEOUT_MS, submitEmail } from "./email-transport";
import { emailSettings, postmarkSettings } from "./integrations";
import { assertEnabledLocale, normalizeLocaleTag, type EnabledLocale } from "./locale-contract";
import { renderLockedTemplateSnapshot } from "./messaging-contract";
import { resendSettings, RESEND_TEST_RECIPIENT } from "./resend-settings";

const SUBMISSION_IN_PROGRESS = "SUBMISSION_IN_PROGRESS";
const RESEND_DELIVERY_DELAYED = "RESEND_DELIVERY_DELAYED";
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

function canRetryDelivery(row: { state: string; error_code: string | null; updated_at: Date }) {
  return (row.state === "unknown" || row.state === "deferred") &&
    row.error_code !== RESEND_DELIVERY_DELAYED &&
    (row.error_code !== SUBMISSION_IN_PROGRESS || Date.now() - row.updated_at.getTime() > EMAIL_SUBMISSION_TIMEOUT_MS);
}

export function maskEmail(email: string) {
  const [local = "", domain = ""] = email.trim().split("@");
  const prefix = local.length <= 2 ? (local[0] ?? "*") + "*" : local.slice(0, 2) + "***";
  return domain ? `${prefix}@${domain}` : prefix;
}

export function renderEmailContent(template: string, orderPublicNo: string | null, isTest = false) {
  const ref = orderPublicNo ? ` (${orderPublicNo})` : "";
  const prefix = isTest ? "[TEST] " : "";
  const origin = appOrigin();
  switch (template) {
    case "payment.confirmed": {
      const link = orderPublicNo ? `${origin}/orders/${orderPublicNo}/parcels` : `${origin}/account/billing`;
      return {
        subject: `${prefix}Payment confirmed${ref}`,
        text: `Your payment${ref} has been confirmed. Open ${link} to register seller tracking numbers or review your billing receipt.`,
      };
    }
    case "intake.checked_in":
    case "package.received":
      return {
        subject: `${prefix}Parcel received at QC Warehouse${ref}`,
        text: `Your parcel${ref} has been checked in at the warehouse. Open ${orderPublicNo ? `${origin}/orders/${orderPublicNo}/parcels` : `${origin}/parcels`} to review its status.`,
      };
    case "refund.succeeded":
      return {
        subject:`${prefix}Refund processed${ref}`,
        text:`Your payment provider has processed a refund${ref}. Check your original payment method and review the refund in ${origin}/account/billing.`,
      };
    case "refund.failed":
      return {
        subject:`${prefix}Refund requires follow-up${ref}`,
        text:`Your payment provider could not complete a refund${ref}. QC Warehouse will review the result. You can view its status at ${origin}/account/billing.`,
      };
    case "order.ready":
    case "samples_ready":
      return {
        subject: `${prefix}All samples received and queued for inspection${ref}`,
        text: `All commissioned samples${ref} have been received and identified. Your order is now queued for inspection at ${orderPublicNo ? `${origin}/orders/${orderPublicNo}` : `${origin}/orders`}.`,
      };
    case "order.identity_mismatch":
    case "sample_identity_issue":
      return {
        subject: `${prefix}Action needed: sample label or attribute mismatch${ref}`,
        text: `A sample received for your order${ref} does not match your declared details. Your order is on hold until you confirm how to proceed at ${orderPublicNo ? `${origin}/orders/${orderPublicNo}/exceptions` : `${origin}/orders`}.`,
      };
    case "report.published":
    case "report.amended":
      return {
        subject: `${prefix}Inspection report ready${ref}`,
        text: `Your inspection report${ref} has been published. Open ${orderPublicNo ? `${origin}/orders/${orderPublicNo}/report` : `${origin}/reports`} to review findings and choose item dispositions.`,
      };
    case "shipment.handed_over":
      return {
        subject: `${prefix}Shipment handed over to carrier${ref}`,
        text: `Your outbound parcel${ref} has been handed over to the carrier. Open ${orderPublicNo ? `${origin}/orders/${orderPublicNo}` : `${origin}/account`} to view tracking updates.`,
      };
    case "tracking.exception_opened":
      return {
        subject: `${prefix}Carrier reported a delivery exception${ref}`,
        text: `A carrier exception or return update was reported for your parcel${ref}. Open ${origin}/parcels to review the tracking status.`,
      };
    case "ticket.reply":
      return {
        subject: `${prefix}New support reply${ref}`,
        text: `Our support team has replied to your case${ref}. Open ${origin}/support to view the message and respond.`,
      };
    default:
      return {
        subject: `${prefix}QC Warehouse account update${ref}`,
        text: `You have a new update${ref} in your QC Warehouse account. Open ${origin}/account for details.`,
      };
  }
}

export async function queueNotificationEmail(
  db: DB,
  notificationId: string,
  userId: string,
  recipientEmailOverride?: string,
) {
  const recipient = recipientEmailOverride
    ? { email: recipientEmailOverride.trim().toLowerCase(), delivery_state: "active" }
    : (
        await db.query<{ email: string; delivery_state: string }>(
          `select normalized_email::text as email, delivery_state
           from user_emails
           where user_id = $1 and is_primary and verified_at is not null
           limit 1`,
          [userId],
        )
      ).rows[0];
  if (!recipient) return;
  const snapshot = encryptSecret(recipient.email);
  const masked = maskEmail(recipient.email);
  let insertedId: string | undefined;
  if (recipient.delivery_state === "bounced" || recipient.delivery_state === "complained") {
    insertedId = (
      await db.query<{ id: string }>(
        `insert into email_deliveries(id, notification_id, address_snapshot, attempt, state, updated_at, error_code)
         values($1, $2, $3, 1, $4, now(), 'ADDRESS_SUPPRESSED')
         on conflict(notification_id, attempt) do nothing
         returning id`,
        [uuid(), notificationId, snapshot, recipient.delivery_state],
      )
    ).rows[0]?.id;
  } else if (isDemo()) {
    insertedId = (
      await db.query<{ id: string }>(
        `insert into email_deliveries(id, notification_id, address_snapshot, provider_message_id, attempt, state, updated_at)
         values($1, $2, $3, $4, 1, 'submitted', now())
         on conflict(notification_id, attempt) do nothing
         returning id`,
        [uuid(), notificationId, snapshot, `demo-${notificationId}`],
      )
    ).rows[0]?.id;
  } else {
    insertedId = (
      await db.query<{ id: string }>(
        `insert into email_deliveries(id, notification_id, address_snapshot, attempt, state, updated_at)
         values($1, $2, $3, 1, 'queued', now())
         on conflict(notification_id, attempt) do nothing
         returning id`,
        [uuid(), notificationId, snapshot],
      )
    ).rows[0]?.id;
  }
  if (insertedId) {
    await syncEmailDeliveryState(db, insertedId, { maskedContact: masked });
  }
}

async function notifyCustomerDeliveryFailed(db: DB, userId: string, normalizedEmail: string, state: "bounced" | "complained") {
  const emailRef = hash(normalizedEmail).slice(0, 16);
  await emitCommunicationEvent(db, {
    sourceKind: "security_alert",
    eventType: "email.delivery_failed",
    entityType: "user_emails",
    entityId: `${userId}:${emailRef}`,
    priority: "high",
    dedupeKey: `email.delivery_failed:${userId}:${emailRef}`,
    metadata: { delivery_state: state, masked_email: maskEmail(normalizedEmail) },
    channels: ["in_app"],
    resetReadOnConflict: true,
    recipients: [{ userId, kind: "customer" }],
  });
}

async function notifyEmailChannelAlert(db: DB, deliveryId: string, errorCode: string) {
  const admins = (
    await db.query<{ user_id: string }>(
      `select distinct sr.user_id
       from staff_roles sr
       join users u on u.id = sr.user_id
       where sr.role = 'super_admin' and u.status = 'active'`,
    )
  ).rows;
  if (admins.length === 0) return;
  await emitCommunicationEvent(db, {
    sourceKind: "security_alert",
    eventType: "email.channel_degraded",
    entityType: "email_deliveries",
    entityId: deliveryId,
    priority: "high",
    dedupeKey: `email.channel_degraded:${deliveryId}`,
    metadata: { delivery_id: deliveryId, error_code: errorCode },
    channels: ["in_app"],
    recipients: admins.map((a) => ({ userId: a.user_id, kind: "staff" as const })),
  });
}

export async function deliverEmailOnce() {
  const claimed = await transaction(async (db) => {
      const row = (
      await db.query<{
        id: string;
        notification_id: string;
        address_snapshot: Buffer;
        attempt: number;
        user_id: string;
        template: string;
        notification_locale: string | null;
        order_public_no: string | null;
        order_is_test: boolean;
      }>(
        `select d.id, d.notification_id, d.address_snapshot, d.attempt, n.user_id, n.template,
                n.locale as notification_locale, o.public_no as order_public_no, coalesce(o.is_test, false) as order_is_test
         from email_deliveries d
         join notifications n on n.id = d.notification_id
         left join orders o on o.id = n.order_id
         where d.state = 'queued'
         order by d.updated_at, d.id
         limit 1
         for update of d skip locked`,
      )
    ).rows[0];
    if (!row) return null;
    const rawRecipient = decryptSecret(row.address_snapshot).trim().toLowerCase();
    const testInbox = row.order_is_test ? process.env.QCW_TEST_EMAIL_INBOX?.trim().toLowerCase() ?? "" : "";
    const effectiveRecipient = testInbox || rawRecipient;
    const evidenceNote = testInbox
      ? `routed_to_test_inbox:${maskEmail(testInbox)}`
      : row.order_is_test
        ? "test_order_prefix_applied"
        : null;

    const emailRow = (
      await db.query<{ delivery_state: string }>(
        `select delivery_state from user_emails where user_id = $1 and normalized_email = $2 limit 1`,
        [row.user_id, rawRecipient],
      )
    ).rows[0];
    if (emailRow && (emailRow.delivery_state === "bounced" || emailRow.delivery_state === "complained")) {
      await db.query(
        `update email_deliveries set state = $2, error_code = 'ADDRESS_SUPPRESSED', updated_at = now() where id = $1`,
        [row.id, emailRow.delivery_state],
      );
      await syncEmailDeliveryState(db, row.id, { maskedContact: maskEmail(effectiveRecipient), isTest: row.order_is_test });
      return { handled: true as const };
    }
    const mail = isDemo() ? { enabled: false as const } : await emailSettings(db);
    if (isDemo() && !mail.enabled) {
      await db.query(
        `update email_deliveries
         set state = 'submitted', provider_message_id = $2, error_code = null, delivery_evidence_note = coalesce($3, delivery_evidence_note), updated_at = now()
         where id = $1`,
        [row.id, `demo-${row.notification_id}-${row.attempt}`, evidenceNote],
      );
      await syncEmailDeliveryState(db, row.id, { maskedContact: maskEmail(effectiveRecipient), isTest: row.order_is_test });
      return { handled: true as const };
    }
    if (!mail.enabled) {
      await db.query(
        `update email_deliveries set state = 'deferred', error_code = 'PROVIDER_UNCONFIGURED', updated_at = now() where id = $1`,
        [row.id],
      );
      await syncEmailDeliveryState(db, row.id, { maskedContact: maskEmail(effectiveRecipient), isTest: row.order_is_test });
      await notifyEmailChannelAlert(db, row.id, "PROVIDER_UNCONFIGURED");
      return { handled: true as const };
    }
    const rendered = await renderTransactionalEmailFromTemplate(db, {
      templateCode: row.template,
      locale: row.notification_locale,
      orderPublicNo: row.order_public_no,
      isTest: row.order_is_test,
    });
    await db.query(
      `update email_deliveries
       set provider = $2, state = 'unknown', error_code = $3, locale = $4, template_version = $5,
           delivery_evidence_note = coalesce($6, delivery_evidence_note), updated_at = now()
       where id = $1`,
      [row.id, mail.provider, SUBMISSION_IN_PROGRESS, rendered.locale, rendered.templateVersion, evidenceNote],
    );
    await syncEmailDeliveryState(db, row.id, {
      maskedContact: maskEmail(effectiveRecipient),
      renderedSubject: rendered.subject,
      renderedBody: rendered.text,
      renderedLocale: rendered.locale,
      templateVersion: rendered.templateVersion,
      isTest: row.order_is_test,
    });
    return {
      handled: false as const,
      id: row.id,
      notificationId: row.notification_id,
      attempt: row.attempt,
      userId: row.user_id,
      rawRecipient,
      recipient: effectiveRecipient,
      template: row.template,
      orderPublicNo: row.order_public_no,
      orderIsTest: row.order_is_test,
      rendered,
      mail,
    };
  });
  if (!claimed) return false;
  if (claimed.handled) return true;

  const content = { subject: claimed.rendered.subject, text: claimed.rendered.text };
  const outcome = await submitEmail(claimed.mail, {
    ...content,
    recipient: claimed.recipient,
    idempotencyKey: `notification-${claimed.id}`,
    metadata: {
      delivery_id: claimed.id,
      notification_id: claimed.notificationId,
      attempt: String(claimed.attempt),
    },
  });

  await transaction(async (db) => {
    const messageId = outcome.kind === "submitted" ? outcome.messageId : null;
    const errorCode = outcome.kind === "submitted" ? null : outcome.errorCode;
    const updated = await db.query(
      `update email_deliveries
       set state = $2, provider_message_id = $3, error_code = $4, updated_at = now()
       where id = $1 and state = 'unknown' and error_code = $5`,
      [claimed.id, outcome.kind, messageId, errorCode, SUBMISSION_IN_PROGRESS],
    );
    if (!updated.rowCount) return;
    await syncEmailDeliveryState(db, claimed.id, {
      maskedContact: maskEmail(claimed.recipient),
      renderedSubject: claimed.rendered.subject,
      renderedBody: claimed.rendered.text,
      renderedLocale: claimed.rendered.locale,
      templateVersion: claimed.rendered.templateVersion,
      isTest: claimed.orderIsTest,
    });
    if (outcome.kind === "submitted") return;
    if (outcome.kind === "bounced") {
      if (claimed.orderIsTest) return;
      await db.query(
        `update user_emails set delivery_state = 'bounced' where user_id = $1 and normalized_email = $2
         and delivery_state is distinct from 'complained'`,
        [claimed.userId, claimed.rawRecipient],
      );
      await notifyCustomerDeliveryFailed(db, claimed.userId, claimed.rawRecipient, "bounced");
      return;
    }
    await notifyEmailChannelAlert(db, claimed.id, outcome.errorCode);
  });
  return true;
}

function extractPostmarkWebhookSecret(req: Request) {
  const direct = req.headers.get("x-postmark-webhook-secret")?.trim();
  if (direct) return direct;
  const auth = req.headers.get("authorization")?.trim() ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  if (auth.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon === -1) return decoded;
      const user = decoded.slice(0, colon);
      const pass = decoded.slice(colon + 1);
      return pass || user;
    } catch {
      return "";
    }
  }
  return "";
}

export async function receivePostmarkWebhook(db: DB, req: Request, raw: string) {
  const expected = postmarkSettings().webhookToken;
  guard(expected, "WEBHOOK_UNAVAILABLE", "Postmark webhook is not configured.", 503);
  const candidate = extractPostmarkWebhookSecret(req);
  const valid =
    candidate.length > 0 &&
    timingSafeEqual(Buffer.from(hash(candidate), "hex"), Buffer.from(hash(expected), "hex"));
  guard(valid, "WEBHOOK_UNAUTHORIZED", "Invalid Postmark webhook credentials.", 401);

  const payload = parseWebhook(raw) as Record<string, unknown>;
  const recordType = typeof payload.RecordType === "string" ? payload.RecordType.trim() : "";
  const messageId = typeof payload.MessageID === "string" ? payload.MessageID.trim() : "";
  guard(recordType && messageId, "VALIDATION_FAILED", "Postmark RecordType and MessageID are required.", 400);

  const discriminator =
    payload.ID !== undefined && payload.ID !== null
      ? String(payload.ID)
      : String(payload.DeliveredAt ?? payload.BouncedAt ?? payload.Tag ?? "0");
  const eventKey = `${recordType}:${messageId}:${discriminator}`;
  return storeEmailWebhook(db, "postmark", eventKey, raw);
}

function parseWebhook(raw: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    guard(false, "VALIDATION_FAILED", "Webhook payload must be valid JSON.", 400);
  }
  guard(payload && typeof payload === "object" && !Array.isArray(payload), "VALIDATION_FAILED", "Expected an event object.", 400);
  return payload;
}

type ResendWebhook = {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[];
    tags?: { delivery_id?: string; connection_test?: string };
    bounce?: { type?: string };
  };
};

async function storeEmailWebhook(db: DB, provider: "postmark" | "resend", eventKey: string, raw: string) {
  await db.query(
    `insert into email_webhook_inbox(provider, event_key, payload_ciphertext, received_at)
     values($1, $2, $3, now())
     on conflict(provider, event_key) do nothing`,
    [provider, eventKey, encryptSecret(raw)],
  );
  return { received: true };
}

export async function receiveResendWebhook(db: DB, req: Request, raw: string) {
  const { webhookKey } = await resendSettings(db);
  guard(webhookKey?.length, "WEBHOOK_UNAVAILABLE", "Resend webhook is not configured.", 503);
  const id = req.headers.get("svix-id") ?? "";
  const timestamp = req.headers.get("svix-timestamp") ?? "";
  const signature = req.headers.get("svix-signature") ?? "";
  const fresh = /^\d{1,12}$/.test(timestamp) &&
    Math.abs(Date.now() / 1000 - Number(timestamp)) <= WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  guard(id.length > 0 && id.length <= 200 && fresh, "WEBHOOK_UNAUTHORIZED", "Invalid Resend webhook signature.", 401);
  const expected = createHmac("sha256", webhookKey).update(`${id}.${timestamp}.${raw}`).digest();
  const valid = signature.split(/\s+/).some((value) => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(value)) return false;
    const digest = Buffer.from(value.slice(3), "base64");
    return timingSafeEqual(expected, digest);
  });
  guard(valid, "WEBHOOK_UNAUTHORIZED", "Invalid Resend webhook signature.", 401);
  const event = parseWebhook(raw) as ResendWebhook;
  guard(typeof event.type === "string", "VALIDATION_FAILED", "Resend event type is required.", 400);
  if (!resendEventTypes.has(event.type)) return { received: true };
  guard(typeof event.data?.email_id === "string" && event.data.email_id.trim() && Array.isArray(event.data.to),
    "VALIDATION_FAILED", "Resend email ID and recipients are required.", 400);
  return storeEmailWebhook(db, "resend", id, raw);
}

const resendEventTypes = new Set([
  "email.sent", "email.delivered", "email.complained", "email.bounced",
  "email.suppressed", "email.delivery_delayed", "email.failed",
]);

function deliveryEvent(provider: "postmark" | "resend", raw: string) {
  if (provider === "resend") {
    const { type, data } = JSON.parse(raw) as ResendWebhook;
    const recipients = data?.to?.filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase()) ?? [];
    const correlation = { messageId: data?.email_id?.trim(), deliveryId: data?.tags?.delivery_id, recipients };
    switch (type) {
      case "email.sent": return { ...correlation, state: "submitted" as const, errorCode: null };
      case "email.delivered": return { ...correlation, state: "delivered" as const, errorCode: null };
      case "email.complained": return { ...correlation, state: "complained" as const, errorCode: "SPAM_COMPLAINT" };
      case "email.suppressed": return { ...correlation, state: "bounced" as const, errorCode: "RESEND_SUPPRESSED" };
      case "email.bounced": return data?.bounce?.type === "Permanent"
        ? { ...correlation, state: "bounced" as const, errorCode: "HARD_BOUNCE" }
        : { ...correlation, state: "deferred" as const, errorCode: "SOFT_BOUNCE" };
      case "email.delivery_delayed": return { ...correlation, state: "deferred" as const, errorCode: RESEND_DELIVERY_DELAYED };
      case "email.failed": return { ...correlation, state: "deferred" as const, errorCode: "RESEND_FAILED" };
      default: return null;
    }
  }

  const payload = JSON.parse(raw) as {
    RecordType?: string;
    MessageID?: string;
    Type?: string;
    TypeCode?: number | string;
    Inactive?: boolean;
    Metadata?: { delivery_id?: string };
    Recipient?: string;
    Email?: string;
  };
  const address = payload.Recipient ?? payload.Email;
  const correlation = {
    messageId: payload.MessageID?.trim(),
    deliveryId: payload.Metadata?.delivery_id,
    recipients: typeof address === "string" ? [address.trim().toLowerCase()] : null,
  };
  switch (payload.RecordType) {
    case "Delivery": return { ...correlation, state: "delivered" as const, errorCode: null };
    case "SpamComplaint": return { ...correlation, state: "complained" as const, errorCode: "SPAM_COMPLAINT" };
    case "Bounce": {
      const bounceType = String(payload.Type ?? "");
      const softBounce = !payload.Inactive && ["Transient", "SoftBounce", "AutoResponder", "DnsError"].includes(bounceType);
      const errorCode = String(payload.TypeCode ?? (bounceType || (softBounce ? "SOFT_BOUNCE" : "HARD_BOUNCE")));
      return { ...correlation, state: softBounce ? "deferred" as const : "bounced" as const, errorCode };
    }
    default: return null;
  }
}

async function applyDeliveryEvent(
  db: DB,
  provider: "postmark" | "resend",
  event: NonNullable<ReturnType<typeof deliveryEvent>>,
  providerEventId?: string | null,
) {
  const { messageId, deliveryId, recipients, state, errorCode } = event;
  const metadataId = typeof deliveryId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId) ? deliveryId : null;

  const delivery = (
    await db.query<{ id: string; address_snapshot: Buffer; state: string; error_code: string | null; user_id: string; order_is_test: boolean }>(
      `select d.id, d.address_snapshot, d.state, d.error_code, n.user_id, coalesce(o.is_test, false) as order_is_test
       from email_deliveries d
       join notifications n on n.id = d.notification_id
       left join orders o on o.id = n.order_id
       where d.provider = $1 and (d.provider_message_id = $2 or (d.id = $3::uuid and d.provider_message_id is null))
       order by (d.provider_message_id is not null) desc, d.attempt desc
       limit 1
       for update of d`,
      [provider, messageId, metadataId],
    )
  ).rows[0];
  if (!delivery) return;
  const recipient = decryptSecret(delivery.address_snapshot).trim().toLowerCase();
  const testInbox = delivery.order_is_test ? process.env.QCW_TEST_EMAIL_INBOX?.trim().toLowerCase() ?? "" : "";
  const matchedRecipient =
    !recipients || recipients.includes(recipient) || (Boolean(testInbox) && recipients.includes(testInbox));
  if (!matchedRecipient) return;
  if (delivery.state === "complained") return;
  if (delivery.state === "bounced" && state !== "complained") return;
  if (delivery.state === "delivered" && (state === "deferred" || state === "submitted")) return;
  if (errorCode === RESEND_DELIVERY_DELAYED && delivery.state === "deferred" && delivery.error_code !== RESEND_DELIVERY_DELAYED) return;
  if (state === "submitted" && delivery.state !== "unknown") return;

  await db.query(
    `update email_deliveries
     set state = $2, provider_message_id = coalesce(provider_message_id, $3), error_code = $4, updated_at = now()
     where id = $1`,
    [delivery.id, state, messageId, errorCode],
  );
  await syncEmailDeliveryState(db, delivery.id, {
    maskedContact: maskEmail(testInbox || recipient),
    providerEventId: providerEventId ?? messageId ?? null,
    isTest: delivery.order_is_test,
  });

  if (delivery.order_is_test) return;

  const owner = [delivery.user_id, recipient];
  if (state === "bounced" || state === "complained") {
    await db.query(
      `update user_emails set delivery_state = $3
       where user_id = $1 and normalized_email = $2 and delivery_state is distinct from 'complained'`,
      [...owner, state],
    );
    await notifyCustomerDeliveryFailed(db, delivery.user_id, recipient, state);
  } else if (state === "delivered") {
    await db.query(
      `update user_emails set delivery_state = 'deliverable'
       where user_id = $1 and normalized_email = $2 and delivery_state = 'degraded'`, owner,
    );
  } else if (errorCode === "RESEND_FAILED") {
    await notifyEmailChannelAlert(db, delivery.id, errorCode);
  } else if (state === "deferred") {
    await db.query(
      `update user_emails set delivery_state = 'degraded'
       where user_id = $1 and normalized_email = $2 and coalesce(delivery_state, 'deliverable') = 'deliverable'`, owner,
    );
  }
}

export async function consumeEmailWebhook(db: DB) {
  const inbox = (
    await db.query<{ id: string; provider: "postmark" | "resend"; event_key: string; payload_ciphertext: Buffer }>(
      `select id, provider, event_key, payload_ciphertext
       from email_webhook_inbox
       where provider in ('postmark', 'resend') and processed_at is null
       order by received_at, id
       limit 1
       for update skip locked`,
    )
  ).rows[0];
  if (!inbox) return false;
  const raw = decryptSecret(inbox.payload_ciphertext);
  const event = deliveryEvent(inbox.provider, raw);
  if (inbox.provider === "resend") {
    const probe = (JSON.parse(raw) as ResendWebhook).data?.tags?.connection_test;
    if (typeof probe === "string" && event?.state === "delivered" && event.recipients?.includes(RESEND_TEST_RECIPIENT)) {
      await db.query("select 1 from integration_providers where provider_key = 'resend' for update");
      await db.query(
        `update integration_providers
         set config = config || jsonb_build_object('webhook_verified_at', now())
         where provider_key = 'resend' and config->>'connection_test_id' = $1
           and config->>'connection_test_message_id' = $2 and config->>'webhook_verified_at' is null`,
        [probe, event.messageId],
      );
    }
  }
  if (event?.messageId) await applyDeliveryEvent(db, inbox.provider, event, inbox.event_key);

  await db.query(`update email_webhook_inbox set processed_at = now() where id = $1`, [inbox.id]);
  return true;
}

export async function customerEmailDeliveryStatus(db: DB, actor: Actor) {
  organization(actor);
  const primary = (
    await db.query<{ email: string; delivery_state: string; verified_at: Date | null }>(
      `select normalized_email::text as email, delivery_state, verified_at
       from user_emails
       where user_id = $1 and is_primary
       limit 1`,
      [actor.id],
    )
  ).rows[0];
  const latest = (
    await db.query<{ state: string; attempt: number; updated_at: Date; error_code: string | null }>(
      `select d.state, d.attempt, d.updated_at, d.error_code
       from email_deliveries d
       join notifications n on n.id = d.notification_id
       where n.user_id = $1
       order by d.updated_at desc, d.attempt desc
       limit 1`,
      [actor.id],
    )
  ).rows[0] ?? null;
  const deliveryState = primary?.delivery_state ?? "deliverable";
  const suppressed = deliveryState === "bounced" || deliveryState === "complained";
  return {
    masked_email: primary ? maskEmail(primary.email) : null,
    delivery_state: deliveryState,
    suppressed,
    banner_message: suppressed ? "We couldn't deliver email to this address" : null,
    latest_delivery: latest,
  };
}

export async function staffEmailDeliveries(db: DB, actor: Actor, stateFilter: string | null) {
  role(actor, "super_admin");
  if (stateFilter !== null) {
    guard(
      ["queued", "submitted", "delivered", "deferred", "bounced", "complained", "unknown"].includes(stateFilter),
      "VALIDATION_FAILED",
      "Unsupported email delivery state filter.",
      422,
    );
  }
  const rows = (
    await db.query<{
      id: string;
      notification_id: string;
      user_id: string;
      template: string;
      order_id: string | null;
      order_public_no: string | null;
      address_snapshot: Buffer;
      provider_message_id: string | null;
      attempt: number;
      state: string;
      updated_at: Date;
      error_code: string | null;
      latest_attempt: number;
    }>(
      `select d.id, d.notification_id, n.user_id, n.template, n.order_id, o.public_no as order_public_no,
              d.address_snapshot, d.provider_message_id, d.attempt, d.state, d.updated_at, d.error_code,
              max(d.attempt) over (partition by d.notification_id)::int as latest_attempt
       from email_deliveries d
       join notifications n on n.id = d.notification_id
       left join orders o on o.id = n.order_id
       where ($1::text is null or d.state = $1)
       order by d.updated_at desc, d.id desc
       limit 100`,
      [stateFilter],
    )
  ).rows;

  const mapped = [];
  for (const row of rows) {
    const recipient = decryptSecret(row.address_snapshot).trim().toLowerCase();
    const emailState =
      (
        await db.query<{ delivery_state: string }>(
          `select delivery_state from user_emails where user_id = $1 and normalized_email = $2 limit 1`,
          [row.user_id, recipient],
        )
      ).rows[0]?.delivery_state ?? "deliverable";
    const suppressed = emailState === "bounced" || emailState === "complained";
    mapped.push({
      id: row.id,
      notification_id: row.notification_id,
      user_id: row.user_id,
      template: row.template,
      order_id: row.order_id,
      order_public_no: row.order_public_no,
      masked_email: maskEmail(recipient),
      provider_message_id: row.provider_message_id,
      attempt: row.attempt,
      state: row.state,
      updated_at: row.updated_at,
      error_code: row.error_code,
      delivery_state: emailState,
      suppressed,
      can_retry:
        row.attempt === row.latest_attempt &&
        canRetryDelivery(row) &&
        !suppressed,
    });
  }

  const summary = await one<{
    unknown_count: number;
    deferred_count: number;
    bounced_count: number;
    complained_count: number;
  }>(
    db,
    `select
       count(*) filter (where state = 'unknown')::int as unknown_count,
       count(*) filter (where state = 'deferred')::int as deferred_count,
       count(*) filter (where state = 'bounced')::int as bounced_count,
       count(*) filter (where state = 'complained')::int as complained_count
     from email_deliveries`,
  );

  return {
    rows: mapped,
    channel_alert: {
      degraded: summary.unknown_count > 0 || summary.deferred_count > 0,
      unknown_count: summary.unknown_count,
      deferred_count: summary.deferred_count,
      bounced_count: summary.bounced_count,
      complained_count: summary.complained_count,
      message:
        summary.unknown_count > 0 || summary.deferred_count > 0
          ? `邮件通道存在 ${summary.unknown_count} 条超时未知（unknown）与 ${summary.deferred_count} 条延后（deferred）记录，请核查供应商状态后按需重试。`
          : null,
    },
  };
}

export async function retryEmailDelivery(
  db: DB,
  actor: Actor,
  deliveryId: string,
  expectedAttempt: number,
  reason: string,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash);
  guard(reason.trim().length > 0, "REASON_REQUIRED", "Enter a reason before retrying email delivery.", 422);

  const target = await one<{ notification_id: string }>(
    db,
    `select notification_id from email_deliveries where id = $1 for update`,
    [deliveryId],
  );
  const latest = await one<{
    id: string;
    notification_id: string;
    address_snapshot: Buffer;
    attempt: number;
    state: string;
    error_code: string | null;
    updated_at: Date;
    user_id: string;
    template: string;
    order_id: string | null;
    order_state: string | null;
  }>(
    db,
    `select d.id, d.notification_id, d.address_snapshot, d.attempt, d.state, d.error_code, d.updated_at,
            n.user_id, n.template, n.order_id, o.state::text as order_state
     from email_deliveries d
     join notifications n on n.id = d.notification_id
     left join orders o on o.id = n.order_id
     where d.notification_id = $1
     order by d.attempt desc
     limit 1
     for update of d`,
    [target.notification_id],
  );
  guard(
    latest.id === deliveryId && latest.attempt === expectedAttempt,
    "REVISION_CONFLICT",
    "Email delivery state changed; refresh before retrying.",
    409,
  );
  guard(
    canRetryDelivery(latest),
    "INVALID_STATE",
    "This email delivery is not currently eligible for retry.",
    409,
  );

  const recipient = decryptSecret(latest.address_snapshot).trim().toLowerCase();
  const emailRow = (
    await db.query<{ delivery_state: string; verified_at: Date | null }>(
      `select delivery_state, verified_at from user_emails where user_id = $1 and normalized_email = $2 limit 1`,
      [latest.user_id, recipient],
    )
  ).rows[0];
  guard(
    emailRow && emailRow.verified_at !== null && emailRow.delivery_state !== "bounced" && emailRow.delivery_state !== "complained",
    "EMAIL_SUPPRESSED",
    "This recipient address is suppressed and cannot be retried.",
    409,
  );
  guard(
    !["email.delivery_failed", "email.channel_degraded"].includes(latest.template) &&
      latest.order_state !== "cancelled",
    "TEMPLATE_STALE",
    "This notification is no longer valid for email retry.",
    409,
  );

  const nextId = uuid();
  const nextAttempt = latest.attempt + 1;
  await db.query(
    `insert into email_deliveries(id, notification_id, address_snapshot, attempt, state, updated_at)
     values($1, $2, $3, $4, 'queued', now())`,
    [nextId, latest.notification_id, latest.address_snapshot, nextAttempt],
  );
  await syncEmailDeliveryState(db, nextId, {
    maskedContact: maskEmail(recipient),
    retryBy: actor.id,
    retryReason: reason.trim(),
  });
  await audit(db, actor, "retry_email_delivery", "email_deliveries", nextId, {
    previous_delivery_id: deliveryId,
    previous_attempt: latest.attempt,
    previous_state: latest.state,
    attempt: nextAttempt,
    state: "queued",
    reason: reason.trim(),
  });
  return {
    id: nextId,
    notification_id: latest.notification_id,
    attempt: nextAttempt,
    state: "queued" as const,
  };
}

// ---------- TASK-194B: Bilingual Notification Templates & Honest Email Channel Readiness ----------

function templateActionLink(templateCode: string, orderPublicNo: string | null, origin: string) {
  switch (templateCode) {
    case "payment.confirmed":
      return orderPublicNo ? `${origin}/orders/${orderPublicNo}/parcels` : `${origin}/account/billing`;
    case "package.received":
      return orderPublicNo ? `${origin}/orders/${orderPublicNo}/parcels` : `${origin}/parcels`;
    case "order.ready":
    case "samples_ready":
      return orderPublicNo ? `${origin}/orders/${orderPublicNo}` : `${origin}/orders`;
    case "report.published":
    case "report.amended":
      return orderPublicNo ? `${origin}/orders/${orderPublicNo}/report` : `${origin}/reports`;
    case "shipment.handed_over":
      return orderPublicNo ? `${origin}/orders/${orderPublicNo}` : `${origin}/account`;
    case "ticket.reply":
      return `${origin}/support`;
    case "ticket.created":
    case "ticket.customer_replied":
      return `${origin}/admin/tickets`;
    case "owner.legal_entity_activated":
    case "owner.legal_entity_retired":
      return `${origin}/admin/legal`;
    case "owner.merchant_instance_changed":
      return `${origin}/admin/payments`;
    case "staff.invited":
    case "staff.activated":
    case "staff.sessions_revoked":
    case "staff.role_changed":
      return `${origin}/staff/login`;
    case "staff.offboarded":
    case "staff.handover_assigned":
      return `${origin}/admin/users`;
    case "email.channel_degraded":
      return `${origin}/admin/integrations/email`;
    case "email.delivery_failed":
      return `${origin}/account`;
    default:
      return `${origin}/account`;
  }
}

export async function renderTransactionalEmailFromTemplate(
  db: Pick<DB, "query">,
  params: { templateCode: string; locale?: string | null; orderPublicNo: string | null; isTest?: boolean },
): Promise<{ subject: string; text: string; locale: EnabledLocale; templateVersion: number | null }> {
  const normalized = normalizeLocaleTag(params.locale);
  const locale: EnabledLocale = normalized === "zh-CN" ? "zh-CN" : "en-US";
  const prefix = params.isTest ? "[TEST] " : "";
  const origin = appOrigin();

  const row = (
    await db.query<{ version: number; subject_template: string; body_template: string }>(
      `select version, subject_template, body_template
       from notification_templates
       where template_code = $1 and locale = $2 and status = 'published'
       order by version desc limit 1`,
      [params.templateCode, locale],
    )
  ).rows[0];

  if (row) {
    const ref = params.orderPublicNo ? ` (${params.orderPublicNo})` : "";
    const link = templateActionLink(params.templateCode, params.orderPublicNo, origin);
    const rendered = renderLockedTemplateSnapshot({
      templateCode: params.templateCode,
      locale,
      titleTemplate: row.subject_template,
      bodyTemplate: row.body_template,
      variables: { ref, link },
    });
    return {
      subject: `${prefix}${rendered.title}`,
      text: rendered.body,
      locale,
      templateVersion: row.version,
    };
  }

  const fallback = renderEmailContent(params.templateCode, params.orderPublicNo, Boolean(params.isTest));
  return { ...fallback, locale, templateVersion: null };
}

export async function listNotificationTemplates(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin");
  const { rows } = await db.query(
    `select id, template_code, locale, version, status, subject_template, body_template,
            allowed_variables, created_by, approved_by, published_at, created_at
     from notification_templates
     order by template_code, locale, version desc`,
  );
  return { templates: rows };
}

const SUPPORTED_TEMPLATE_VARIABLES = new Set(["ref", "link"]);

export async function createNotificationTemplateDraft(
  db: DB,
  actor: Actor,
  input: {
    template_code: string;
    locale: string;
    subject_template: string;
    body_template: string;
    allowed_variables: string[];
  },
) {
  role(actor, "super_admin");
  const templateCode = input.template_code.trim();
  const locale = assertEnabledLocale(input.locale);
  guard(
    !/[<>]/.test(input.subject_template) && !/[<>]/.test(input.body_template),
    "UNSAFE_TEMPLATE_MARKUP",
    "Notification templates must be plain text without raw HTML or script markup.",
    422,
  );
  for (const v of input.allowed_variables) {
    guard(
      SUPPORTED_TEMPLATE_VARIABLES.has(v),
      "UNSUPPORTED_TEMPLATE_VARIABLE",
      `Unsupported notification variable '${v}'. Only {ref} and {link} are supported at runtime.`,
      422,
    );
  }
  for (const match of `${input.subject_template} ${input.body_template}`.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    const v = match[1]!;
    guard(
      SUPPORTED_TEMPLATE_VARIABLES.has(v),
      "UNSUPPORTED_TEMPLATE_VARIABLE",
      `Template references unsupported placeholder '{${v}}'. Only {ref} and {link} are supplied at runtime.`,
      422,
    );
  }
  const sampleVars: Record<string, string> = {};
  for (const v of input.allowed_variables) sampleVars[v] = `sample_${v}`;
  // Validate placeholders & reject HTML/script tags at draft save time.
  renderLockedTemplateSnapshot({
    templateCode,
    locale,
    titleTemplate: input.subject_template,
    bodyTemplate: input.body_template,
    variables: sampleVars,
  });

  await lock(db, `notification_template:${templateCode}:${locale}`);
  const nextVerRow = await one<{ next_ver: number }>(
    db,
    `select coalesce(max(version), 0)::int + 1 as next_ver
     from notification_templates where template_code = $1 and locale = $2`,
    [templateCode, locale],
  );
  const id = uuid();
  const created = await one(
    db,
    `insert into notification_templates(
       id, template_code, locale, version, status, subject_template, body_template, allowed_variables, created_by
     ) values($1, $2, $3, $4, 'draft', $5, $6, $7::jsonb, $8)
     returning id, template_code, locale, version, status, created_by, created_at`,
    [
      id,
      templateCode,
      locale,
      nextVerRow.next_ver,
      input.subject_template,
      input.body_template,
      JSON.stringify(input.allowed_variables),
      actor.id,
    ],
  );
  await audit(db, actor, "create_notification_template_draft", "notification_templates", id, {
    template_code: templateCode,
    locale,
    version: nextVerRow.next_ver,
  });
  return created;
}

export async function publishNotificationTemplate(
  db: DB,
  actor: Actor,
  templateId: string,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const target = await one<{
    id: string;
    template_code: string;
    locale: string;
    version: number;
    status: string;
    created_by: string | null;
  }>(
    db,
    `select id, template_code, locale, version, status, created_by
     from notification_templates where id = $1 for update`,
    [templateId],
  );
  guard(target.status === "draft", "INVALID_STATE", "Only draft notification templates can be published.", 409);
  guard(!target.created_by || target.created_by !== actor.id, "SELF_REVIEW_FORBIDDEN", "Template author cannot publish their own draft.", 403);

  await lock(db, `notification_template:${target.template_code}:${target.locale}`);
  await db.query(
    `update notification_templates set status = 'retired'
     where template_code = $1 and locale = $2 and status = 'published'`,
    [target.template_code, target.locale],
  );
  const published = await one(
    db,
    `update notification_templates set status = 'published', approved_by = $2, published_at = now()
     where id = $1
     returning id, template_code, locale, version, status, approved_by, published_at`,
    [templateId, actor.id],
  );
  await audit(db, actor, "publish_notification_template", "notification_templates", templateId, {
    template_code: target.template_code,
    locale: target.locale,
    version: target.version,
  });
  return published;
}

export async function emailChannelReadiness(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin");
  const { rows: providers } = await db.query<{
    provider_key: string;
    enabled: boolean;
    lifecycle_state: string;
    health_status: string;
    is_primary: boolean;
    config: Record<string, unknown>;
  }>(
    `select provider_key, enabled, lifecycle_state, health_status, is_primary, config
     from integration_providers where provider_key in ('resend', 'postmark')`,
  );
  const stats = await one<{
    live_delivered_count: number;
    live_resend_delivered_count: number;
    live_postmark_delivered_count: number;
    live_submitted_count: number;
    live_bounced_count: number;
    live_deferred_count: number;
  }>(
    db,
    `select
       count(*) filter (where state = 'delivered' and coalesce(provider_message_id, '') not like 'demo-%')::int as live_delivered_count,
       count(*) filter (where state = 'delivered' and provider = 'resend' and coalesce(provider_message_id, '') not like 'demo-%')::int as live_resend_delivered_count,
       count(*) filter (where state = 'delivered' and provider = 'postmark' and coalesce(provider_message_id, '') not like 'demo-%')::int as live_postmark_delivered_count,
       count(*) filter (where state = 'submitted' and coalesce(provider_message_id, '') not like 'demo-%')::int as live_submitted_count,
       count(*) filter (where state in ('bounced', 'complained'))::int as live_bounced_count,
       count(*) filter (where state = 'deferred')::int as live_deferred_count
     from email_deliveries`,
  );
  const resend = await resendSettings(db);
  const pm = postmarkSettings();
  const resendRow = providers.find((p) => p.provider_key === "resend");
  const pmRow = providers.find((p) => p.provider_key === "postmark");

  return {
    channels: {
      resend: {
        configured: resend.enabled,
        is_primary: Boolean(resendRow?.is_primary),
        connection_tested: resendRow?.health_status === "healthy",
        verified_live_delivery: stats.live_resend_delivered_count > 0,
      },
      postmark: {
        configured: pm.enabled,
        is_primary: Boolean(pmRow?.is_primary),
        connection_tested: pmRow?.health_status === "healthy",
        verified_live_delivery: stats.live_postmark_delivered_count > 0,
      },
    },
    delivery_stats: stats,
    connection_test_equals_live_delivery: false as const,
  };
}
