import type { DB } from "../db";
import { unseal } from "./crypto";

export const RESEND_TEST_RECIPIENT = "delivered@resend.dev";
export const RESEND_WEBHOOK_PATH = "/api/v1/webhooks/email/resend";

export function resendSender(value: unknown) {
  if (typeof value !== "string" || /[\r\n]/.test(value) || value.length > 254) return undefined;
  const sender = value.trim();
  const address = sender.match(/^[^<>]+ <([^<>]+)>$/)?.[1] ?? sender;
  return /^[^\s@<>]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(address) ? sender : undefined;
}

export function resendApiKey(value: string) {
  return /^re_[A-Za-z0-9_-]+$/.test(value);
}

export function resendWebhookKey(value: string) {
  const encoded = value.match(/^whsec_([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encoded) return undefined;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 && key.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "") ? key : undefined;
}

export async function resendSettings(db: Pick<DB, "query">) {
  const { rows: [row] } = await db.query<{
    enabled: boolean;
    from_email: string | null;
    api_key: Buffer | null;
    webhook_secret: Buffer | null;
  }>(
    `select p.enabled and p.lifecycle_state <> 'disabled' as enabled, p.config->>'from_email' as from_email,
            api.ciphertext as api_key, webhook.ciphertext as webhook_secret
     from integration_providers p
     left join integration_secrets api
       on api.provider_key = p.provider_key and api.environment = 'live' and api.secret_name = 'api_key' and api.status = 'active'
     left join integration_secrets webhook
       on webhook.provider_key = p.provider_key and webhook.environment = 'live'
       and webhook.secret_name = 'webhook_secret' and webhook.status = 'active'
     where p.provider_key = 'resend' and p.environment = 'live'`,
  );
  const key = row?.api_key ? unseal(row.api_key) : "";
  const token = resendApiKey(key) ? key : undefined;
  const from = resendSender(row?.from_email);
  const webhookKey = row?.webhook_secret ? resendWebhookKey(unseal(row.webhook_secret)) : undefined;
  return { provider: "resend" as const, token, from, webhookKey, enabled: !!(row?.enabled && token && from && webhookKey) };
}
