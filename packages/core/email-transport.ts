import type { emailSettings } from "./integrations";

export const EMAIL_SUBMISSION_TIMEOUT_MS = 10_000;

type Submission =
  | { kind: "submitted"; messageId: string }
  | { kind: "unknown" | "deferred" | "bounced"; errorCode: string };

type Email = {
  recipient: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
};

export async function submitEmail(mail: Awaited<ReturnType<typeof emailSettings>>, email: Email): Promise<Submission> {
  if (!mail.provider || !mail.token || !mail.from) {
    return { kind: "deferred", errorCode: "PROVIDER_UNCONFIGURED" };
  }

  try {
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    const signal = AbortSignal.timeout(EMAIL_SUBMISSION_TIMEOUT_MS);
    if (mail.provider === "resend") {
      headers.authorization = `Bearer ${mail.token}`;
      headers["idempotency-key"] = email.idempotencyKey;
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST", headers, signal,
        body: JSON.stringify({
          from: mail.from,
          to: [email.recipient],
          subject: email.subject,
          text: email.text,
          html: email.html,
          tags: email.metadata && Object.entries(email.metadata).map(([name, value]) => ({ name, value })),
        }),
      });
      if (!response.ok) {
        return {
          kind: response.status >= 500 ? "unknown" : "deferred",
          errorCode: `RESEND_HTTP_${response.status}`,
        };
      }
      const body = await response.json().catch(() => null);
      return typeof body?.id === "string" && body.id.trim()
        ? { kind: "submitted", messageId: body.id }
        : { kind: "unknown", errorCode: "RESEND_INVALID_RESPONSE" };
    }

    headers["X-Postmark-Server-Token"] = mail.token;
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST", headers, signal,
      body: JSON.stringify({
        From: mail.from,
        To: email.recipient,
        Subject: email.subject,
        TextBody: email.text,
        HtmlBody: email.html,
        MessageStream: mail.stream,
        Metadata: email.metadata,
      }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.ErrorCode === 0 && typeof body.MessageID === "string" && body.MessageID.length > 0) {
      return { kind: "submitted", messageId: body.MessageID };
    }
    if (body?.ErrorCode === 406) return { kind: "bounced", errorCode: "INACTIVE_RECIPIENT" };
    return { kind: "deferred", errorCode: `POSTMARK_${body?.ErrorCode ?? response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "unknown", errorCode: "REQUEST_TIMEOUT" };
    }
    return { kind: mail.provider === "resend" ? "unknown" : "deferred", errorCode: "NETWORK_ERROR" };
  }
}
