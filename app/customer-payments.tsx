"use client";

import { useState } from "react";
import { Action, ErrorBlock, Form, request, Tag, text, upload, usd, useLoad, type Row } from "./ui";

export function CustomerMultiChannelPaymentPanel({
  chargeId,
  quoteRevision,
  amountCents,
  demo = false,
  latestAttempt,
  onStripePay,
  onUpdated,
}: {
  chargeId: string;
  quoteRevision: number;
  amountCents: number;
  demo?: boolean;
  latestAttempt?: Row | null;
  onStripePay: (chargeId: string, quoteRevision: number) => Promise<void>;
  onUpdated?: () => void;
}) {
  const channelsLoad = useLoad(`/me/payment-channels?charge_id=${encodeURIComponent(chargeId)}`);
  const channels: Row[] = channelsLoad.data?.channels ?? [];
  const stripeChannel = channels.find((c) => c.provider_key === "stripe");
  const paypalChannel = channels.find((c) => c.provider_key === "paypal_manual");
  const resolvedAttempt = latestAttempt ?? channelsLoad.data?.active_attempt ?? null;

  const [payerEmail, setPayerEmail] = useState(String(resolvedAttempt?.payer_email ?? ""));
  const [localInvoice, setLocalInvoice] = useState<Row | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const activeManual =
    localInvoice ??
    (resolvedAttempt && resolvedAttempt.provider === "paypal_manual" && resolvedAttempt.state !== "canceled"
      ? resolvedAttempt
      : null);
  const showPaypalCard = Boolean(paypalChannel?.available || activeManual);

  async function requestPaypal() {
    setErr("");
    setNotice("");
    try {
      const res = await request(`/charges/${chargeId}/paypal-invoice`, "POST", {
        ...(payerEmail.trim() ? { payer_email: payerEmail.trim() } : {}),
      });
      setLocalInvoice(res);
      setNotice(
        res.external_invoice_no
          ? `PayPal Invoice ${res.external_invoice_no} is active.`
          : "PayPal Invoice request submitted. Our finance team will issue your PayPal Invoice shortly.",
      );
      onUpdated?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not request PayPal Invoice.");
    }
  }

  return (
    <div className="payment-channel-box" style={{ marginTop: 12 }}>
      <div className="row between flexwrap" style={{ marginBottom: 8 }}>
        <strong>Payment Methods ({usd(amountCents)})</strong>
        <span className="small muted">
          {showPaypalCard
            ? "Server-verified settlement only · HK Stripe primary · PayPal Manual Invoice backup"
            : "Server-verified settlement only · Card / Apple Pay / Google Pay via Stripe"}
        </span>
      </div>

      {err && <ErrorBlock error={err} />}
      {notice && <p role="status" className="notice">{notice}</p>}

      <div className="payment-channel-grid">
        <div className="card" style={{ padding: 14 }}>
          <div className="row between flexwrap" style={{ marginBottom: 6, gap: 6 }}>
            <strong>{stripeChannel?.label ?? "Card / Apple Pay / Google Pay (Stripe)"}</strong>
            <Tag tone={stripeChannel?.available === false ? "yellow" : "green"}>
              {stripeChannel?.badge ?? (demo ? "Sandbox / Demo" : "Recommended")}
            </Tag>
          </div>
          <p className="small muted" style={{ marginBottom: 10 }}>
            {stripeChannel?.available === false
              ? stripeChannel.unavailable_reason
              : demo
                ? "Local sandbox checkout confirms immediately for workflow testing."
                : "Instant hosted Stripe Checkout session."}
          </p>
          <Action
            primary
            disabled={stripeChannel ? !stripeChannel.available && !demo : false}
            run={async () => {
              setErr("");
              await onStripePay(chargeId, quoteRevision);
            }}
          >
            {demo ? `Demo / Stripe Pay (${usd(amountCents)})` : `Pay with Stripe (${usd(amountCents)})`}
          </Action>
        </div>

        {showPaypalCard && <div className="card" style={{ padding: 14 }}>
          <div className="row between flexwrap" style={{ marginBottom: 6, gap: 6 }}>
            <strong>{paypalChannel?.label ?? "PayPal Manual Invoice"}</strong>
            <Tag tone={paypalChannel?.available === false ? "gray" : "blue"}>
              {paypalChannel?.badge ?? "Manual Finance Verification"}
            </Tag>
          </div>
          <p className="small muted" style={{ marginBottom: 10 }}>
            {paypalChannel?.unavailable_reason ??
              paypalChannel?.instructions ??
              "Receive a PayPal Invoice (INV2-...) by email and upload your PayPal Transaction ID; Finance completes independent two-person verification to activate."}
          </p>

          {!activeManual && (
            <div className="stack-tight">
              <label className="small">
                PayPal Billing Email (optional — defaults to your primary email)
                <input
                  type="email"
                  value={payerEmail}
                  onChange={(e) => setPayerEmail(e.target.value)}
                  placeholder="billing@yourcompany.com"
                />
              </label>
              <Action
                disabled={paypalChannel ? !paypalChannel.available : false}
                run={requestPaypal}
              >
                Pay with PayPal Invoice
              </Action>
            </div>
          )}

          {activeManual && (
            <div className="stack-tight" style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <div className="row between flexwrap">
                <span className="small">
                  <strong>Invoice Status:</strong>{" "}
                  <Tag tone={activeManual.manual_state === "verified" ? "green" : activeManual.manual_state === "underpaid" ? "red" : "blue"}>
                    {String(activeManual.manual_state ?? activeManual.state)}
                  </Tag>
                </span>
                {activeManual.external_invoice_no && (
                  <code className="code mono-wrap">Invoice #{activeManual.external_invoice_no}</code>
                )}
              </div>
              {activeManual.invoice_url && (
                <p className="small">
                  PayPal Invoice Link:{" "}
                  <a href={activeManual.invoice_url} target="_blank" rel="noreferrer noopener" className="mono-wrap">
                    {activeManual.invoice_url}
                  </a>
                </p>
              )}
              {activeManual.payer_email && (
                <p className="small muted">Sent to PayPal email: <span className="mono">{activeManual.payer_email}</span></p>
              )}
              {activeManual.customer_reported_at && (
                <p className="small">
                  Transfer note submitted ({activeManual.customer_reported_tx_ref ?? "pending TX ref"}) — awaiting independent Finance verification.
                </p>
              )}
              {activeManual.state !== "succeeded" && (
                <Form
                  label="Report PayPal Invoice Paid (awaiting Finance verify)"
                  run={async (f) => {
                    setErr("");
                    const pid = activeManual.payment_id ?? activeManual.id;
                    const proof = f.get("proof");
                    let evidenceMediaId: string | undefined;
                    if (proof instanceof File && proof.size > 0) {
                      evidenceMediaId = await upload(proof, "attachment");
                    }
                    await request(`/me/payments/${pid}/report-paypal-paid`, "POST", {
                      ...(text(f, "tx_ref") ? { transaction_ref: text(f, "tx_ref") } : {}),
                      ...(text(f, "note") ? { note: text(f, "note") } : {}),
                      ...(evidenceMediaId ? { evidence_media_id: evidenceMediaId } : {}),
                    });
                    setNotice("Submitted payment notification. Order activation occurs only after two-person Finance verification.");
                    onUpdated?.();
                  }}
                >
                  <div className="filters-grid">
                    <label>
                      PayPal Transaction ID
                      <input name="tx_ref" placeholder="e.g. 9AB12345CD678901E" />
                    </label>
                    <label>
                      Receipt Screenshot / PDF (optional)
                      <input type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" />
                    </label>
                  </div>
                  <label>
                    Note for Finance
                    <input name="note" placeholder="Paid from PayPal personal account" />
                  </label>
                </Form>
              )}
            </div>
          )}
        </div>}
      </div>
    </div>
  );
}
