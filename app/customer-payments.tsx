"use client";

import { useState } from "react";
import { Action, ErrorBlock, Form, request, Tag, text, upload, usd, useLoad, type Row } from "./ui";

export function CustomerMultiChannelPaymentPanel({
  chargeId,
  quoteRevision,
  amountCents,
  demo = false,
  latestAttempt,
  paymentLocked=false,
  onStripePay,
  onUpdated,
}: {
  chargeId: string;
  quoteRevision: number;
  amountCents: number;
  demo?: boolean;
  latestAttempt?: Row | null;
  paymentLocked?:boolean;
  onStripePay: (chargeId: string, quoteRevision: number) => Promise<void>;
  onUpdated?: () => void;
}) {
  const channelsLoad = useLoad(`/me/payment-channels?charge_id=${encodeURIComponent(chargeId)}`);
  const channels: Row[] = channelsLoad.data?.channels ?? [];
  const stripeChannel = channels.find((c) => c.provider_key === "stripe");
  const paypalChannel = channels.find((c) => c.provider_key === "paypal_manual");
  const resolvedAttempt = channelsLoad.data ? channelsLoad.data.active_attempt : latestAttempt ?? null;

  const [payerEmail, setPayerEmail] = useState(String(resolvedAttempt?.payer_email ?? ""));
  const [notice, setNotice] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const activeManual=resolvedAttempt?.provider==="paypal_manual"&&resolvedAttempt.state!=="canceled"?resolvedAttempt:null;
  const manualFinal=Boolean(activeManual&&["succeeded","partially_refunded","refunded"].includes(activeManual.state));
  const locked=paymentLocked||Boolean(activeManual?.reconciliation_required||activeManual?.customer_reported_at||activeManual?.state==="processing");
  const showPaypalCard = Boolean(paypalChannel?.available || activeManual);

  async function requestPaypal() {
    setErr("");
    setNotice("");
    try {
      const res = await request(`/charges/${chargeId}/paypal-invoice`, "POST", {
        ...(payerEmail.trim() ? { payer_email: payerEmail.trim() } : {}),
      });
      channelsLoad.reload();
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
      {channelsLoad.error&&<><ErrorBlock error={channelsLoad.error}/><button type="button" className="button sm" onClick={channelsLoad.reload}>Retry payment methods</button></>}
      {notice && <p role="status" className="notice">{notice}</p>}

      <div className="payment-channel-grid">
        <div className="card" style={{ padding: 14 }}>
          <div className="row between flexwrap" style={{ marginBottom: 6, gap: 6 }}>
            <strong>{stripeChannel?.label ?? "Card / Apple Pay / Google Pay (Stripe)"}</strong>
            <Tag tone={stripeChannel?.available ? "green" : "yellow"}>
              {stripeChannel?.badge ?? (channelsLoad.error ? "Unavailable" : "Checking availability")}
            </Tag>
          </div>
          <p className="small muted" style={{ marginBottom: 10 }}>
            {!stripeChannel ? null : stripeChannel.available === false
              ? stripeChannel.unavailable_reason
              : demo
                ? "Local sandbox checkout confirms immediately for workflow testing."
                : "Instant hosted Stripe Checkout session."}
          </p>
          <Action
            primary
            disabled={locked||!!channelsLoad.error||!stripeChannel?.available}
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
              Finance review required
            </Tag>
          </div>
          {!activeManual&&<p className="small muted" style={{ marginBottom: 10 }}>
            {paypalChannel?.unavailable_reason??"Request an invoice to pay this charge. Finance verifies the transfer before applying it."}
          </p>}

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
                disabled={locked||!!channelsLoad.error||!paypalChannel?.available}
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
                  <Tag tone={activeManual.reconciliation_required?"yellow":activeManual.manual_state === "verified" ? "green" : activeManual.manual_state === "underpaid" ? "red" : "blue"}>
                    {activeManual.reconciliation_required?"Payment received · under review":
                      activeManual.customer_reported_at&&!manualFinal?"Transfer submitted · under review":
                      paypalInvoiceStatus(activeManual.manual_state??activeManual.state)}
                  </Tag>
                </span>
                {activeManual.external_invoice_no && (
                  <code className="code mono-wrap">Invoice #{activeManual.external_invoice_no}</code>
                )}
              </div>
              {activeManual.invoice_url&&activeManual.quote_payable!==false&&!manualFinal&&!locked&&(
                <p className="small">
                  <a href={activeManual.invoice_url} target="_blank" rel="noreferrer noopener" className="mono-wrap">
                    Open PayPal invoice
                  </a>
                </p>
              )}
              {activeManual.payer_email&&activeManual.external_invoice_no&&(
                <p className="small muted">Sent to PayPal email: <span className="mono">{activeManual.payer_email}</span></p>
              )}
              {activeManual.customer_reported_at && !manualFinal && (
                <p className="small">
                  {activeManual.customer_reported_tx_ref&&<>Transaction {activeManual.customer_reported_tx_ref}. </>}
                  Awaiting independent Finance verification.
                </p>
              )}
              {!manualFinal&&!activeManual.customer_reported_at&&(activeManual.external_invoice_no||activeManual.invoice_url)&&(
                <Form
                  label="Report PayPal Invoice Paid (awaiting Finance verify)"
                  run={async (f) => {
                    setErr("");
                    const pid = activeManual.payment_id ?? activeManual.id;
                    const proof = f.get("proof");
                    const transactionId=text(f,"tx_ref").trim();
                    let evidenceMediaId: string | undefined;
                    if (proof instanceof File && proof.size > 0) {
                      evidenceMediaId = await upload(proof, "attachment");
                    }
                    if(!transactionId&&!evidenceMediaId)throw new Error("Enter the PayPal transaction ID or attach your transfer receipt.");
                    await request(`/me/payments/${pid}/report-paypal-paid`, "POST", {
                      ...(transactionId?{transaction_ref:transactionId}:{}),
                      ...(text(f, "note") ? { note: text(f, "note") } : {}),
                      ...(evidenceMediaId ? { evidence_media_id: evidenceMediaId } : {}),
                    });
                    setNotice("Sent your payment details to Finance for independent review.");
                    channelsLoad.reload();
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
export function paypalInvoiceStatus(state:string|undefined) {
  const labels:Record<string,string>={
    requested:"Invoice requested",invoice_sent:"Invoice issued",receipt_recorded:"Receipt recorded",
    underpaid:"Amount below invoice",overpaid:"Amount above invoice",verified:"Receipt verified",
    rejected:"Receipt needs correction",canceled:"Invoice cancelled",processing:"Under review",
  };
  return (state&&labels[state])||"Invoice pending";
}
