import { z } from "zod";
import type { DB } from "../db";
import { extractReceivingCode, guard, one, paymentGrossCents, role, type Actor } from "./common";
import { taskDetail } from "./inspection";
import { computeOrderRefundStage } from "./operations";
import { hasStaffAccess, staffAccess } from "./staff-access";
import { incidentAwaitingCustomer } from "./storage";
import { stripeSettlementJob } from "./stripe-settlements";

function maskEmailForStaff(actor: Actor, originalEmail: string | null, normalizedEmail: string | null) {
  const email = originalEmail ?? normalizedEmail;
  if (!email) return null;
  if (actor.roles.includes("super_admin")) {
    return email;
  }
  return email.replace(/(^.).*(@.*$)/, "$1***$2");
}

function canSeeFinanceAmounts(actor: Actor) {
  return actor.roles.some(r => r === "finance" || r === "super_admin");
}

function paymentDisplayRef(id: string) {
  return `PAY-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function refundDisplayRef(id: string) {
  return `RFD-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

const paymentTabSchema = z.enum(["all", "pending", "succeeded", "failed", "refund_related", "reconciliation_issues"]).default("all");

export const adminPaymentListFilters = z.object({
  tab: paymentTabSchema,
  q: z.string().trim().max(120).default(""),
  purpose: z.enum(["all", "inspection", "dispatch", "storage"]).default("all"),
  test: z.enum(["all", "production", "test"]).default("production"),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).refine(v => !v.from || !v.to || v.from <= v.to, "结束日期不能早于开始日期。");

const paymentOrderOriginsLateral = `left join lateral (
  select coalesce(jsonb_agg(distinct jsonb_build_object(
      'id', ord.id, 'public_no', ord.public_no, 'state', ord.state, 'is_test', ord.is_test
    )), '[]'::jsonb) linked_orders,
    bool_or(ord.is_test) any_test_order
  from (
    select o.id, o.public_no, o.state, coalesce(o.is_test,false) is_test
    from orders o where o.id = iq.order_id
    union
    select o.id, o.public_no, o.state, coalesce(o.is_test,false) is_test
    from charge_allocations ca join orders o on o.id = ca.order_id where ca.charge_id = c.id
    union
    select o.id, o.public_no, o.state, coalesce(o.is_test,false) is_test
    from dispatch_quote_versions dqv
    join dispatch_batch_items dbi on dbi.batch_id = dqv.batch_id and dbi.released_at is null
    join order_line_item_links l on l.item_id = dbi.item_id and l.unlinked_at is null
    join order_lines ol on ol.id = l.order_line_id
    join orders o on o.id = ol.order_id
    where dqv.id = c.dispatch_quote_id
    union
    select o.id, o.public_no, o.state, coalesce(o.is_test,false) is_test
    from storage_quotes sqv
    join disposition_requests dr on dr.id = sqv.disposition_id
    join order_line_item_links l on l.item_id = dr.item_id and l.unlinked_at is null
    join order_lines ol on ol.id = l.order_line_id
    join orders o on o.id = ol.order_id
    where sqv.id = c.storage_quote_id
  ) ord
) order_links on true`;

export async function adminPaymentsList(db: DB, actor: Actor, filters: z.infer<typeof adminPaymentListFilters>) {
  role(actor, ...staffAccess.finance);
  const { tab, q, purpose, test, from, to, page, limit } = filters;
  const search = q.trim().toLowerCase();
  const rawUpper = q.trim().toUpperCase();

  const { rows } = await db.query(
    `with enriched as (
      select p.id, p.charge_item_id, p.provider, p.provider_ref, ${paymentGrossCents} amount_cents, p.currency, p.state,
             p.channel, p.environment, p.manual_state, p.external_invoice_no, p.external_transaction_id,
             p.payer_email, p.invoice_url, p.expected_amount_cents, p.received_amount_cents,
             p.fee_amount_cents, p.net_amount_cents, p.evidence_media_id, p.issued_by, p.issued_at,
             p.recorded_by, p.recorded_at, p.verified_by, p.verified_at, p.manual_notes,
             p.provider_data, p.created_at, p.updated_at,
             c.org_id, c.purpose, c.amount_cents charge_amount_cents, c.voided_at, c.applied_payment_id,
             c.inspection_quote_id, c.dispatch_quote_id, c.storage_quote_id, c.scope_revision_id,
             crp.user_id customer_user_id, crp.receiving_code, u.display_name customer_name,
             ue.original_email customer_email,
             order_links.linked_orders,
             coalesce(order_links.any_test_order, false) is_test,
             coalesce(rf.refunded_succeeded_cents, 0)::int refunded_cents,
             coalesce(rf.refund_requested_cents, 0)::int refund_requested_cents,
             coalesce(rf.refund_approved_pending_cents, 0)::int refund_approved_pending_cents,
             coalesce(rf.refund_count, 0)::int refund_count,
             coalesce(rf.open_refund_count, 0)::int open_refund_count,
             (select d.state from payment_disputes d where d.payment_id = p.id order by d.updated_at desc limit 1) dispute_state,
             (select k.public_no from tickets k where k.org_id = c.org_id and k.category = 'payment_refund'
                and k.state in ('open','waiting_customer','waiting_internal')
                and (k.details->>'payment_id' = p.id::text or (p.provider_ref is not null and k.details->>'provider_ref' = p.provider_ref))
              order by k.created_at desc limit 1) recon_ticket_no,
             (select k.id from tickets k where k.org_id = c.org_id and k.category = 'payment_refund'
                and k.state in ('open','waiting_customer','waiting_internal')
                and (k.details->>'payment_id' = p.id::text or (p.provider_ref is not null and k.details->>'provider_ref' = p.provider_ref))
              order by k.created_at desc limit 1) recon_ticket_id,
             (select ps.net_minor from payment_settlements ps where ps.payment_id = p.id limit 1) settlement_net_minor,
             (select ps.fee_minor from payment_settlements ps where ps.payment_id = p.id limit 1) settlement_fee_minor,
             dq.batch_id dispatch_batch_id
      from payments p
      join charge_items c on c.id = p.charge_item_id
      left join inspection_quotes iq on iq.id = c.inspection_quote_id
      left join dispatch_quote_versions dq on dq.id = c.dispatch_quote_id
      left join customer_receiving_profiles crp on crp.org_id = c.org_id
      left join users u on u.id = crp.user_id
      left join user_emails ue on ue.user_id = u.id and ue.is_primary
      left join lateral (
        select coalesce(sum(r.amount_cents) filter (where r.state = 'succeeded'), 0)::int refunded_succeeded_cents,
               coalesce(sum(r.amount_cents) filter (where r.state = 'requested'), 0)::int refund_requested_cents,
               coalesce(sum(r.amount_cents) filter (where r.state = 'approved'), 0)::int refund_approved_pending_cents,
               count(*)::int refund_count,
               count(*) filter (where r.state in ('requested','approved'))::int open_refund_count
        from refunds r where r.payment_id = p.id
      ) rf on true
      ${paymentOrderOriginsLateral}
      where ($1 = 'all' or c.purpose = $1)
        and ($2 = 'all' or coalesce(order_links.any_test_order, false) = ($2 = 'test'))
        and ($3::date is null or p.created_at >= ($3::date)::timestamp at time zone 'UTC')
        and ($4::date is null or p.created_at < ($4::date + 1)::timestamp at time zone 'UTC')
        and ($5 = '' or
          strpos(lower(p.id::text), $5) > 0 or
          strpos(upper('PAY-' || left(replace(p.id::text, '-', ''), 8)), $6) > 0 or
          strpos(lower(coalesce(p.provider_ref, '')), $5) > 0 or
          strpos(lower(coalesce(p.external_invoice_no, '')), $5) > 0 or
          strpos(lower(coalesce(p.external_transaction_id, '')), $5) > 0 or
          strpos(lower(coalesce(p.payer_email, '')), $5) > 0 or
          strpos(lower(coalesce(p.provider_data->>'payment_intent', '')), $5) > 0 or
          strpos(upper(coalesce(crp.receiving_code, '')), $6) > 0 or
          strpos(lower(coalesce(ue.original_email, '')), $5) > 0 or
          strpos(lower(coalesce(u.display_name, '')), $5) > 0 or
          exists(select 1 from jsonb_array_elements(order_links.linked_orders) elem
            where strpos(upper(elem->>'public_no'), $6) > 0)
        )
    )
    select *,
      case
        when dispute_state is not null and dispute_state <> 'resolved_by_staff' then 'disputed'
        when recon_ticket_no is not null then 'issue'
        when state in ('succeeded','partially_refunded','refunded') and (voided_at is not null or applied_payment_id is distinct from id) then 'issue'
        when state = 'processing' or (state = 'requires_payment' and provider_ref is not null) then 'pending_webhook'
        when state in ('succeeded','partially_refunded','refunded') then 'reconciled'
        else 'not_applicable'
      end reconciliation_status
    from enriched
    order by created_at desc, id desc`,
    [purpose, test, from ?? null, to ?? null, search, rawUpper]
  );

  const normalized = rows.map(r => {
    const refundedCents = Number(r.refunded_cents ?? 0);
    const refundRequestedCents = Number(r.refund_requested_cents ?? 0);
    const refundApprovedPendingCents = Number(r.refund_approved_pending_cents ?? 0);
    const refundPendingCents = refundRequestedCents + refundApprovedPendingCents;
    const amountCents = Number(r.amount_cents ?? 0);
    const refundableCents = ["succeeded", "partially_refunded", "refunded"].includes(r.state)
      ? Math.max(0, amountCents - refundedCents - refundApprovedPendingCents)
      : 0;
    const refundStatus = refundedCents >= amountCents && amountCents > 0
      ? "full_refund"
      : refundedCents > 0
        ? "partial_refund"
        : refundPendingCents > 0
          ? "refund_pending"
          : r.refund_count > 0
            ? "refund_closed"
            : "none";
    const confirmedEpoch = Number(r.provider_data?.confirmed_at ?? 0);
    const paidAt = Number.isFinite(confirmedEpoch) && confirmedEpoch > 0
      ? new Date(confirmedEpoch * 1000).toISOString()
      : ["succeeded", "partially_refunded", "refunded"].includes(r.state)
        ? r.updated_at
        : null;
    const isDemoTx = Boolean(r.provider_data?.demo) || String(r.provider_ref ?? "").startsWith("demo_");
    return {
      id: r.id,
      display_ref: paymentDisplayRef(r.id),
      charge_item_id: r.charge_item_id,
      purpose: r.purpose,
      scope_revision_id: r.scope_revision_id ?? null,
      dispatch_batch_id: r.dispatch_batch_id ?? null,
      amount_cents: amountCents,
      currency: r.currency,
      state: r.state,
      provider: r.provider,
      channel: r.channel ?? null,
      environment: r.environment ?? null,
      manual_state: r.manual_state ?? null,
      external_invoice_no: r.external_invoice_no ?? null,
      external_transaction_id: r.external_transaction_id ?? null,
      payer_email: maskEmailForStaff(actor, r.payer_email, r.payer_email),
      recorded_by: r.recorded_by ?? null,
      verified_by: r.verified_by ?? null,
      provider_ref: r.provider_ref,
      payment_intent: r.provider_data?.payment_intent ?? null,
      is_demo_tx: isDemoTx,
      is_test: r.is_test,
      customer_user_id: r.customer_user_id ?? null,
      receiving_code: r.receiving_code ?? null,
      customer_name: r.customer_name ?? null,
      customer_email: maskEmailForStaff(actor, r.customer_email, r.customer_email),
      linked_orders: Array.isArray(r.linked_orders) ? r.linked_orders : [],
      refunded_cents: refundedCents,
      refund_pending_cents: refundPendingCents,
      refundable_cents: refundableCents,
      refund_count: Number(r.refund_count ?? 0),
      open_refund_count: Number(r.open_refund_count ?? 0),
      refund_status: refundStatus,
      dispute_state: r.dispute_state ?? null,
      recon_ticket_no: r.recon_ticket_no ?? null,
      recon_ticket_id: r.recon_ticket_id ?? null,
      reconciliation_status: r.reconciliation_status,
      settlement_recorded: r.settlement_net_minor !== null && r.settlement_net_minor !== undefined,
      settlement_fee_cents: r.settlement_fee_minor !== null && r.settlement_fee_minor !== undefined ? Number(r.settlement_fee_minor) : null,
      settlement_net_cents: r.settlement_net_minor !== null && r.settlement_net_minor !== undefined ? Number(r.settlement_net_minor) : null,
      paid_at: paidAt,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  const counts = {
    all: normalized.length,
    pending: normalized.filter(r => ["requires_payment", "processing"].includes(r.state)).length,
    succeeded: normalized.filter(r => ["succeeded", "partially_refunded", "refunded"].includes(r.state)).length,
    failed: normalized.filter(r => ["failed", "canceled"].includes(r.state)).length,
    refund_related: normalized.filter(r => r.refund_count > 0 || ["partially_refunded", "refunded"].includes(r.state)).length,
    reconciliation_issues: normalized.filter(r => ["issue", "disputed", "pending_webhook"].includes(r.reconciliation_status)).length,
  };

  const filtered = normalized.filter(r => {
    if (tab === "pending") return ["requires_payment", "processing"].includes(r.state);
    if (tab === "succeeded") return ["succeeded", "partially_refunded", "refunded"].includes(r.state);
    if (tab === "failed") return ["failed", "canceled"].includes(r.state);
    if (tab === "refund_related") return r.refund_count > 0 || ["partially_refunded", "refunded"].includes(r.state);
    if (tab === "reconciliation_issues") return ["issue", "disputed", "pending_webhook"].includes(r.reconciliation_status);
    return true;
  });

  const summary = {
    total_count: filtered.length,
    succeeded_cents: normalized.filter(r => ["succeeded", "partially_refunded", "refunded"].includes(r.state)).reduce((s, r) => s + r.amount_cents, 0),
    refunded_cents: normalized.reduce((s, r) => s + r.refunded_cents, 0),
    pending_cents: normalized.filter(r => ["requires_payment", "processing"].includes(r.state)).reduce((s, r) => s + r.amount_cents, 0),
    reconciliation_issue_count: counts.reconciliation_issues,
  };

  const total = filtered.length;
  const offset = (page - 1) * limit;
  return {
    summary,
    counts,
    page,
    limit,
    total,
    has_more: offset + limit < total,
    rows: filtered.slice(offset, offset + limit),
  };
}

export async function adminPaymentDetail(db: DB, actor: Actor, id: string) {
  role(actor, ...staffAccess.finance);
  const p = await one(
    db,
    `select p.*, ${paymentGrossCents} gross_paid_cents,
            c.org_id, c.purpose, c.amount_cents charge_amount_cents, c.currency charge_currency,
            c.snapshot charge_snapshot, c.voided_at, c.applied_payment_id,
            c.inspection_quote_id, c.dispatch_quote_id, c.storage_quote_id, c.scope_revision_id,
            c.free_authorization,
            iq.revision iq_revision, iq.amount_cents iq_amount_cents, iq.expires_at iq_expires_at, iq.accepted_at iq_accepted_at, iq.line_snapshot iq_line_snapshot,
            dq.batch_id dq_batch_id, dq.revision dq_revision, dq.amount_cents dq_amount_cents, dq.expires_at dq_expires_at, dq.accepted_at dq_accepted_at, dq.snapshot dq_snapshot,
            sq.disposition_id sq_disposition_id, sq.revision sq_revision, sq.amount_cents sq_amount_cents, sq.expires_at sq_expires_at, sq.accepted_at sq_accepted_at, sq.snapshot sq_snapshot,
            crp.user_id customer_user_id, crp.receiving_code, u.display_name customer_name, u.status customer_status,
            ue.original_email customer_email,
            order_links.linked_orders,
            coalesce(order_links.any_test_order, false) is_test
     from payments p
     join charge_items c on c.id = p.charge_item_id
     left join inspection_quotes iq on iq.id = c.inspection_quote_id
     left join dispatch_quote_versions dq on dq.id = c.dispatch_quote_id
     left join storage_quotes sq on sq.id = c.storage_quote_id
     left join customer_receiving_profiles crp on crp.org_id = c.org_id
     left join users u on u.id = crp.user_id
     left join user_emails ue on ue.user_id = u.id and ue.is_primary
     ${paymentOrderOriginsLateral}
     where p.id = $1`,
    [id]
  );

  const refunds = (await db.query(
    `select r.id, r.amount_cents, r.reason, r.state, r.source, r.provider_ref, r.revision, r.created_at,
            r.channel, r.manual_refund_ref, r.evidence_media_id, r.executed_by, r.executed_at, r.notes,
            r.requested_by, ru.display_name requested_by_name,
            r.approved_by, au.display_name approved_by_name,
            eu.display_name executed_by_name
     from refunds r
     left join users ru on ru.id = r.requested_by
     left join users au on au.id = r.approved_by
     left join users eu on eu.id = r.executed_by
     where r.payment_id = $1
     order by r.created_at desc, r.id desc`,
    [id]
  )).rows.map(r => ({ ...r, display_ref: refundDisplayRef(r.id) }));

  const paymentIntent = p.provider_data?.payment_intent ?? null;
  const providerEvents = (await db.query(
    `select id, event_id, type, received_at, processed_at,
            coalesce(payload->'data'->'object'->>'status', '') object_status,
            coalesce(payload->'data'->'object'->>'payment_status', '') payment_status
     from payment_events
     where payload->'data'->'object'->'metadata'->>'payment_id' = $1
        or ($2::text is not null and payload->'data'->'object'->>'id' = $2)
        or ($3::text is not null and payload->'data'->'object'->>'payment_intent' = $3)
     order by received_at desc limit 30`,
    [id, p.provider_ref ?? null, paymentIntent]
  )).rows;

  const disputes = (await db.query(
    `select d.provider_id, d.state, d.evidence_due_at, d.updated_at,
            ae.after->>'decision' staff_decision, ae.after->>'reason' staff_note, ae.at staff_resolved_at
     from payment_disputes d
     left join lateral (
       select after, at from audit_events
       where action = 'resolve_payment_dispute' and entity_type = 'payments'
         and entity_id = d.payment_id and after->>'provider_id' = d.provider_id
       order by id desc limit 1
     ) ae on true
     where d.payment_id = $1 order by d.updated_at desc`,
    [id]
  )).rows;

  const settlement = (await db.query(
    `select provider_transaction_id, gross_minor, fee_minor, net_minor, currency, exchange_rate, settled_at
     from payment_settlements where payment_id = $1 order by settled_at desc nulls last limit 5`,
    [id]
  )).rows[0] ?? null;

  const settlementJob=p.provider==="stripe"&&String(p.provider_ref??"").startsWith("cs_")?(await db.query(
    `select attempts,last_error,next_attempt_at,processed_at from outbox_events
     where type=$2 and payload->>'payment_id'=$1 order by id desc limit 1`,[id,stripeSettlementJob]
  )).rows[0]??null:null;

  const allocations = (await db.query(
    `select a.order_id, o.public_no, o.state order_state, a.amount_cents
     from charge_allocations a join orders o on o.id = a.order_id
     where a.charge_id = $1 order by o.public_no`,
    [p.charge_item_id]
  )).rows;

  const relatedTickets = (await db.query(
    `select k.id, k.public_no, k.category, k.state, k.subject, k.created_at, o.public_no order_no
     from tickets k left join orders o on o.id = k.order_id
     where k.org_id = $1 and (
       k.details->>'payment_id' = $2
       or ($3::text is not null and k.details->>'provider_ref' = $3)
       or k.details->>'charge_item_id' = $4
     )
     order by k.created_at desc limit 20`,
    [p.org_id, id, p.provider_ref ?? null, p.charge_item_id]
  )).rows;

  const auditRows = (await db.query(
    `select a.id, a.at, a.actor_type, u.display_name actor_name, a.action, a.entity_type, a.entity_id, a.after
     from audit_events a left join users u on u.id = a.actor_id
     where (a.entity_type = 'payments' and a.entity_id = $1)
        or (a.entity_type = 'charge_items' and a.entity_id = $2)
        or (a.entity_type = 'refunds' and a.entity_id = any($3::uuid[]))
     order by a.at asc, a.id asc limit 50`,
    [id, p.charge_item_id, refunds.map(r => r.id)]
  )).rows;

  const succeededRefunds = refunds.filter(r => r.state === "succeeded").reduce((s, r) => s + Number(r.amount_cents), 0);
  const pendingRefunds = refunds.filter(r => r.state === "requested" || r.state === "approved").reduce((s, r) => s + Number(r.amount_cents), 0);
  const refundableBalance = ["succeeded", "partially_refunded", "refunded"].includes(p.state)
    ? Math.max(0, Number(p.gross_paid_cents) - succeededRefunds - pendingRefunds)
    : 0;

  const linkedOrders = Array.isArray(p.linked_orders) ? p.linked_orders : [];
  const primaryOrderNo = linkedOrders[0]?.public_no ?? null;
  const orderDetailsExtra = linkedOrders.length
    ? (await db.query(
      `select o.id, o.public_no, o.state, o.price_cents, o.paid_at,
              coalesce((select sum(ol.quantity)::int from order_lines ol where ol.order_id = o.id), 0) sample_count,
              (select st.code from order_lines ol join service_offers so on so.id = ol.offer_id
               join service_types st on st.id = so.service_type_id where ol.order_id = o.id limit 1) service_code,
              (select so.title->>'zh-CN' from order_lines ol join service_offers so on so.id = ol.offer_id where ol.order_id = o.id limit 1) service_title
       from orders o where o.id = any($1::uuid[]) order by o.public_no`,
      [linkedOrders.map((x: { id: string }) => x.id)]
    )).rows
    : [];

  const paidOrdersBalance = (await db.query<{ paid: number; open: number }>(
    `select coalesce(sum(amount_cents) filter (where applied_payment_id is not null or free_authorization is not null), 0)::int paid,
            coalesce(sum(amount_cents) filter (where applied_payment_id is null and free_authorization is null and voided_at is null), 0)::int open
     from charge_items where id = $1`,
    [p.charge_item_id]
  )).rows[0];

  const reconNotes: string[] = [];
  if (disputes.some(d => d.state !== "resolved_by_staff")) reconNotes.push("存在未结案渠道争议 / 拒付冻结");
  if (relatedTickets.some(k => ["open", "waiting_customer", "waiting_internal"].includes(k.state))) reconNotes.push("存在待处理财务对账异常工单");
  if (p.voided_at && ["succeeded", "partially_refunded", "refunded"].includes(p.state)) reconNotes.push("原收费项已作废但支付已成功，需人工核实退款或改派");
  if (["succeeded", "partially_refunded", "refunded"].includes(p.state) && p.applied_payment_id !== id) reconNotes.push("已收款但尚未绑定为该收费项的生效入账付款（可能重复支付或超时后迟到付款）");
  if (p.state === "processing") reconNotes.push("已收到完成信号或正处理中，等待最终入账或对账核销");

  const reconciliationStatus = disputes.some(d => d.state !== "resolved_by_staff")
    ? "disputed"
    : reconNotes.some(n => !n.includes("处理中"))
      ? "issue"
      : p.state === "processing" || (p.state === "requires_payment" && p.provider_ref)
        ? "pending_webhook"
        : ["succeeded", "partially_refunded", "refunded"].includes(p.state)
          ? "reconciled"
          : "not_applicable";

  const confirmedEpoch = Number(p.provider_data?.confirmed_at ?? 0);
  const paidAt = Number.isFinite(confirmedEpoch) && confirmedEpoch > 0
    ? new Date(confirmedEpoch * 1000).toISOString()
    : ["succeeded", "partially_refunded", "refunded"].includes(p.state)
      ? p.updated_at
      : null;

  // Build chronological factual timeline
  const timeline: { at: string; source: string; title: string; detail: string; kind: string }[] = [];
  const quoteRevision = p.iq_revision ?? p.dq_revision ?? p.sq_revision ?? null;
  const quoteAcceptedAt = p.iq_accepted_at ?? p.dq_accepted_at ?? p.sq_accepted_at ?? null;
  const quoteExpiresAt = p.iq_expires_at ?? p.dq_expires_at ?? p.sq_expires_at ?? null;
  if (quoteAcceptedAt) {
    timeline.push({ at: new Date(quoteAcceptedAt).toISOString(), source: "quote", title: "报价确认并生成收费单", detail: `收费金额 $${(Number(p.charge_amount_cents) / 100).toFixed(2)} USD${quoteRevision ? ` · 报价版本 v${quoteRevision}` : ""}`, kind: "quote" });
  }
  timeline.push({ at: new Date(p.created_at).toISOString(), source: "payment", title: "发起支付尝试", detail: `渠道 ${p.provider}${p.provider_data?.demo ? " (本机模拟)" : ""} · 创建付款单 ${paymentDisplayRef(id)}`, kind: "payment" });
  for (const ev of providerEvents) {
    timeline.push({
      at: new Date(ev.received_at).toISOString(),
      source: "webhook",
      title: `渠道回调事件 · ${ev.type}`,
      detail: `事件 ${ev.event_id}${ev.payment_status ? ` · payment_status=${ev.payment_status}` : ""}`,
      kind: "webhook",
    });
  }
  if (paidAt) {
    timeline.push({ at: new Date(paidAt).toISOString(), source: "ledger", title: "支付确认成功", detail: `实付 $${(Number(p.amount_cents) / 100).toFixed(2)} ${p.currency}`, kind: "paid" });
  }
  const auditActionLabels: Record<string, string> = {
    payment_confirmed: "确认收款并绑定收费单",
    request_refund: "发起原路退款申请",
    approve_refund: "独立复核批准退款",
    reject_refund: "独立审批驳回退款",
    refund_executed: "渠道执行退款完成",
    resolve_payment_dispute: "裁决支付渠道争议",
  };
  for (const a of auditRows) {
    const afterObj = (a.after ?? {}) as Record<string, unknown>;
    const summaryParts: string[] = [];
    if (typeof afterObj.reason === "string" && afterObj.reason.trim()) summaryParts.push(afterObj.reason.trim());
    if (typeof afterObj.amount_cents === "number") summaryParts.push(`金额 $${(afterObj.amount_cents / 100).toFixed(2)}`);
    if (typeof afterObj.provider_ref === "string" && afterObj.provider_ref) summaryParts.push(`渠道凭据 ${afterObj.provider_ref}`);
    if (typeof afterObj.decision === "string" && afterObj.decision) summaryParts.push(`结论 ${afterObj.decision}`);
    timeline.push({
      at: new Date(a.at).toISOString(),
      source: a.actor_type === "staff" ? `员工 · ${a.actor_name ?? "系统成员"}` : "系统账本",
      title: auditActionLabels[a.action] ?? a.action,
      detail: summaryParts.join(" · ") || "已完成账本记录与状态流转",
      kind: "audit",
    });
  }
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const quoteId = p.inspection_quote_id ?? p.dispatch_quote_id ?? p.storage_quote_id ?? null;

  return {
    payment: {
      id: p.id,
      display_ref: paymentDisplayRef(p.id),
      state: p.state,
      amount_cents: Number(p.amount_cents),
      currency: p.currency,
      provider: p.provider,
      provider_ref: p.provider_ref,
      payment_intent: paymentIntent,
      is_demo_tx: Boolean(p.provider_data?.demo) || String(p.provider_ref ?? "").startsWith("demo_"),
      is_test: p.is_test,
      paid_at: paidAt,
      created_at: p.created_at,
      updated_at: p.updated_at,
      idempotency_key: p.idempotency_key,
      checkout_mode: p.provider_data?.checkout_mode ?? (p.provider_data?.demo ? "demo" : null),
    },
    customer: {
      user_id: p.customer_user_id ?? null,
      org_id: p.org_id,
      receiving_code: p.receiving_code ?? null,
      display_name: p.customer_name ?? null,
      email: maskEmailForStaff(actor, p.customer_email, p.customer_email),
      status: p.customer_status ?? null,
    },
    charge: {
      id: p.charge_item_id,
      purpose: p.purpose,
      amount_cents: Number(p.charge_amount_cents),
      currency: p.charge_currency,
      voided_at: p.voided_at,
      applied_payment_id: p.applied_payment_id,
      is_applied_payment: p.applied_payment_id === p.id,
      scope_revision_id: p.scope_revision_id ?? null,
      free_authorization: p.free_authorization ?? null,
      paid_cents: paidOrdersBalance?.paid ?? 0,
      unpaid_cents: paidOrdersBalance?.open ?? 0,
    },
    quote: quoteId
      ? {
        id: quoteId,
        purpose: p.purpose,
        revision: quoteRevision,
        amount_cents: Number(p.iq_amount_cents ?? p.dq_amount_cents ?? p.sq_amount_cents ?? p.charge_amount_cents),
        expires_at: quoteExpiresAt,
        accepted_at: quoteAcceptedAt,
        dispatch_batch_id: p.dq_batch_id ?? null,
        disposition_id: p.sq_disposition_id ?? null,
      }
      : null,
    orders: orderDetailsExtra,
    primary_order_no: primaryOrderNo,
    refund_summary: {
      original_charge_cents: Number(p.charge_amount_cents),
      paid_cents: Number(p.gross_paid_cents),
      refunded_succeeded_cents: succeededRefunds,
      refund_pending_cents: pendingRefunds,
      remaining_refundable_cents: refundableBalance,
      currency: p.currency,
    },
    refunds,
    reconciliation: {
      status: reconciliationStatus,
      notes: reconNotes,
      settlement,
      settlement_job:settlementJob,
      allocations,
      disputes,
      related_tickets: relatedTickets,
    },
    provider_events: providerEvents,
    timeline,
  };
}

export const adminRefundListFilters = z.object({
  state: z.enum(["all", "requested", "approved", "succeeded", "rejected", "failed"]).default("all"),
  q: z.string().trim().max(120).default(""),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function adminRefundsList(db: DB, actor: Actor, filters: z.infer<typeof adminRefundListFilters>) {
  role(actor, ...staffAccess.finance);
  const { state, q, page, limit } = filters;
  const search = q.trim().toLowerCase();
  const rawUpper = q.trim().toUpperCase();

  const { rows } = await db.query(
    `select r.id, r.payment_id, r.source, r.amount_cents, r.reason, r.state, r.requested_by,
            r.approved_by, r.provider_ref, r.created_at, r.revision,
            ru.display_name requested_by_name,
            au.display_name approved_by_name,
            ${paymentGrossCents} payment_amount_cents, p.currency, p.state payment_state, p.provider_ref payment_provider_ref,
            c.id charge_item_id, c.purpose, c.amount_cents charge_amount_cents,
            crp.user_id customer_user_id, crp.receiving_code, cu.display_name customer_name, ce.original_email customer_email,
            order_links.linked_orders,
            coalesce(order_links.any_test_order, false) is_test,
            greatest(0, (${paymentGrossCents}) - coalesce((select sum(r2.amount_cents)::int from refunds r2
              where r2.payment_id = p.id and r2.state in ('approved','succeeded')), 0)) remaining_refundable_cents,
            ae.at decision_at, ae.after->>'reason' decision_note
     from refunds r
     join payments p on p.id = r.payment_id
     join charge_items c on c.id = p.charge_item_id
     left join inspection_quotes iq on iq.id = c.inspection_quote_id
     left join users ru on ru.id = r.requested_by
     left join users au on au.id = r.approved_by
     left join customer_receiving_profiles crp on crp.org_id = c.org_id
     left join users cu on cu.id = crp.user_id
     left join user_emails ce on ce.user_id = cu.id and ce.is_primary
     left join lateral (
       select at, after from audit_events
       where entity_type = 'refunds' and entity_id = r.id and action in ('approve_refund','reject_refund')
       order by id desc limit 1
     ) ae on true
     ${paymentOrderOriginsLateral}
     where ($1 = '' or
       strpos(lower(r.id::text), $1) > 0 or
       strpos(upper('RFD-' || left(replace(r.id::text, '-', ''), 8)), $2) > 0 or
       strpos(lower(r.payment_id::text), $1) > 0 or
       strpos(lower(r.reason), $1) > 0 or
       strpos(upper(coalesce(crp.receiving_code, '')), $2) > 0 or
       strpos(lower(coalesce(ce.original_email, '')), $1) > 0 or
       exists(select 1 from jsonb_array_elements(order_links.linked_orders) elem
         where strpos(upper(elem->>'public_no'), $2) > 0)
     )
     order by r.state = 'requested' desc, r.created_at desc, r.id desc`,
    [search, rawUpper]
  );

  const mapped = rows.map(r => ({
    id: r.id,
    display_ref: refundDisplayRef(r.id),
    payment_id: r.payment_id,
    payment_display_ref: paymentDisplayRef(r.payment_id),
    charge_item_id: r.charge_item_id,
    purpose: r.purpose,
    source: r.source,
    amount_cents: Number(r.amount_cents),
    payment_amount_cents: Number(r.payment_amount_cents),
    charge_amount_cents: Number(r.charge_amount_cents),
    remaining_refundable_cents: Number(r.remaining_refundable_cents),
    currency: r.currency,
    reason: r.reason,
    state: r.state,
    channel_status: r.state === "succeeded" ? "settled" : r.state === "approved" ? "queued" : r.state === "failed" ? "failed" : r.state === "rejected" ? "cancelled" : "awaiting_approval",
    requested_by: r.requested_by,
    requested_by_name: r.requested_by_name ?? (r.source === "provider_dashboard" ? "渠道后台发起" : "员工"),
    approved_by: r.approved_by,
    approved_by_name: r.approved_by_name ?? null,
    decision_at: r.decision_at ?? null,
    decision_note: r.decision_note ?? null,
    provider_ref: r.provider_ref ?? null,
    revision: Number(r.revision ?? 1),
    created_at: r.created_at,
    customer_user_id: r.customer_user_id ?? null,
    receiving_code: r.receiving_code ?? null,
    customer_name: r.customer_name ?? null,
    customer_email: maskEmailForStaff(actor, r.customer_email, r.customer_email),
    linked_orders: Array.isArray(r.linked_orders) ? r.linked_orders : [],
    is_test: r.is_test,
    can_approve_sod: r.state === "requested" && actor.roles.includes("super_admin") && r.requested_by !== actor.id,
  }));

  const counts = {
    all: mapped.length,
    requested: mapped.filter(r => r.state === "requested").length,
    approved: mapped.filter(r => r.state === "approved").length,
    succeeded: mapped.filter(r => r.state === "succeeded").length,
    rejected: mapped.filter(r => r.state === "rejected").length,
    failed: mapped.filter(r => r.state === "failed").length,
  };

  const filtered = state === "all" ? mapped : mapped.filter(r => r.state === state);
  const offset = (page - 1) * limit;
  return {
    counts,
    summary: {
      requested_cents: mapped.filter(r => r.state === "requested").reduce((s, r) => s + r.amount_cents, 0),
      succeeded_cents: mapped.filter(r => r.state === "succeeded").reduce((s, r) => s + r.amount_cents, 0),
      pending_count: counts.requested,
    },
    page,
    limit,
    total: filtered.length,
    has_more: offset + limit < filtered.length,
    rows: filtered.slice(offset, offset + limit),
  };
}

export async function adminRefundDetail(db: DB, actor: Actor, id: string) {
  role(actor, ...staffAccess.finance);
  const r = await one(
    db,
    `select r.*, ru.display_name requested_by_name, au.display_name approved_by_name,
            ${paymentGrossCents} payment_amount_cents, p.currency, p.state payment_state, p.provider,
            p.provider_ref payment_provider_ref, p.provider_data, p.created_at payment_created_at, p.updated_at payment_updated_at,
            c.id charge_item_id, c.org_id, c.purpose, c.amount_cents charge_amount_cents, c.voided_at, c.applied_payment_id,
            c.inspection_quote_id, c.dispatch_quote_id, c.storage_quote_id, c.scope_revision_id,
            crp.user_id customer_user_id, crp.receiving_code, cu.display_name customer_name, cu.status customer_status,
            ce.original_email customer_email,
            order_links.linked_orders
     from refunds r
     join payments p on p.id = r.payment_id
     join charge_items c on c.id = p.charge_item_id
     left join inspection_quotes iq on iq.id = c.inspection_quote_id
     left join users ru on ru.id = r.requested_by
     left join users au on au.id = r.approved_by
     left join customer_receiving_profiles crp on crp.org_id = c.org_id
     left join users cu on cu.id = crp.user_id
     left join user_emails ce on ce.user_id = cu.id and ce.is_primary
     ${paymentOrderOriginsLateral}
     where r.id = $1`,
    [id]
  );

  const history = (await db.query(
    `select r2.id, r2.amount_cents, r2.reason, r2.state, r2.source, r2.provider_ref, r2.created_at,
            ru.display_name requested_by_name, au.display_name approved_by_name
     from refunds r2
     left join users ru on ru.id = r2.requested_by
     left join users au on au.id = r2.approved_by
     where r2.payment_id = $1
     order by r2.created_at desc, r2.id desc`,
    [r.payment_id]
  )).rows.map(x => ({ ...x, display_ref: refundDisplayRef(x.id) }));

  const succeededOtherCents = history.filter(x => x.state === "succeeded").reduce((s, x) => s + Number(x.amount_cents), 0);
  const approvedPendingCents = history.filter(x => x.state === "approved").reduce((s, x) => s + Number(x.amount_cents), 0);
  const committedCents = succeededOtherCents + approvedPendingCents;
  const remainingRefundableBeforeThis = Math.max(0, Number(r.payment_amount_cents) - committedCents);
  const afterApprovalRemaining = r.state === "requested"
    ? remainingRefundableBeforeThis - Number(r.amount_cents)
    : remainingRefundableBeforeThis;

  const linkedOrders = Array.isArray(r.linked_orders) ? r.linked_orders : [];
  const primaryOrderId = linkedOrders[0]?.id ?? null;

  const orderContext = primaryOrderId
    ? await (async () => {
      const ord = await one(
        db,
        `select o.id, o.public_no, o.state, o.price_cents, o.paid_at, o.samples_ready_at, o.report_published_at, o.closed_at,
                (select st.code from order_lines ol join service_offers so on so.id = ol.offer_id
                 join service_types st on st.id = so.service_type_id where ol.order_id = o.id limit 1) service_code,
                (select so.title->>'zh-CN' from order_lines ol join service_offers so on so.id = ol.offer_id where ol.order_id = o.id limit 1) service_title,
                (select coalesce(sum(ol.quantity), 0)::int from order_lines ol where ol.order_id = o.id) expected_units,
                (select rp.published_version from reports rp where rp.order_id = o.id limit 1) report_version
         from orders o where o.id = $1`,
        [primaryOrderId]
      );
      const refundStage = await computeOrderRefundStage(db, primaryOrderId);
      const tickets = (await db.query(
        `select id, public_no, category, state, subject, created_at
         from tickets where order_id = $1 or (org_id = $2 and details->>'payment_id' = $3)
         order by created_at desc limit 20`,
        [primaryOrderId, r.org_id, r.payment_id]
      )).rows;
      return { ...ord, refund_stage: refundStage, related_tickets: tickets };
    })()
    : null;

  const auditRows = (await db.query(
    `select a.id, a.at, a.actor_type, u.display_name actor_name, a.action, a.after
     from audit_events a left join users u on u.id = a.actor_id
     where a.entity_type = 'refunds' and a.entity_id = $1
     order by a.at asc, a.id asc limit 30`,
    [id]
  )).rows;

  const isSuperAdmin = actor.roles.includes("super_admin");
  const isSelfRequested = r.requested_by === actor.id;
  const amountWithinBalance = Number(r.amount_cents) <= remainingRefundableBeforeThis && ["succeeded", "partially_refunded", "refunded"].includes(r.payment_state);

  const blockReasons: string[] = [];
  if (r.state !== "requested") blockReasons.push(`当前退款单处于「${r.state}」状态，不可再次审批或驳回。`);
  if (!isSuperAdmin) blockReasons.push("仅 super_admin 角色可执行高风险退款最终审批或驳回。");
  if (isSelfRequested) blockReasons.push("违反职责分离原则（SoD）：申请发起人与审批/驳回人不得为同一员工账号。");
  if (r.state === "requested" && !amountWithinBalance) blockReasons.push("本次申请退款金额已超过当前剩余可退余额。");

  return {
    refund: {
      id: r.id,
      display_ref: refundDisplayRef(r.id),
      state: r.state,
      source: r.source,
      amount_cents: Number(r.amount_cents),
      currency: r.currency,
      reason: r.reason,
      revision: Number(r.revision),
      provider_ref: r.provider_ref,
      created_at: r.created_at,
      requested_by: r.requested_by,
      requested_by_name: r.requested_by_name ?? (r.source === "provider_dashboard" ? "渠道后台直接发起" : "员工"),
      approved_by: r.approved_by,
      approved_by_name: r.approved_by_name ?? null,
    },
    customer: {
      user_id: r.customer_user_id ?? null,
      org_id: r.org_id,
      receiving_code: r.receiving_code ?? null,
      display_name: r.customer_name ?? null,
      email: maskEmailForStaff(actor, r.customer_email, r.customer_email),
      status: r.customer_status ?? null,
    },
    payment: {
      id: r.payment_id,
      display_ref: paymentDisplayRef(r.payment_id),
      state: r.payment_state,
      amount_cents: Number(r.payment_amount_cents),
      currency: r.currency,
      provider: r.provider,
      provider_ref: r.payment_provider_ref,
      payment_intent: r.provider_data?.payment_intent ?? null,
      is_demo_tx: Boolean(r.provider_data?.demo) || String(r.payment_provider_ref ?? "").startsWith("demo_"),
      created_at: r.payment_created_at,
      updated_at: r.payment_updated_at,
    },
    charge: {
      id: r.charge_item_id,
      purpose: r.purpose,
      amount_cents: Number(r.charge_amount_cents),
      voided_at: r.voided_at,
    },
    funds_check: {
      original_charge_cents: Number(r.charge_amount_cents),
      paid_cents: Number(r.payment_amount_cents),
      succeeded_refunds_cents: succeededOtherCents,
      approved_pending_cents: approvedPendingCents,
      remaining_refundable_cents: remainingRefundableBeforeThis,
      requested_cents: Number(r.amount_cents),
      post_approval_remaining_cents: afterApprovalRemaining,
      amount_within_balance: amountWithinBalance,
    },
    linked_orders: linkedOrders,
    order_context: orderContext,
    history,
    decision_controls: {
      can_decide: blockReasons.length === 0,
      is_super_admin: isSuperAdmin,
      is_self_requested: isSelfRequested,
      requires_recent_mfa: true,
      block_reasons: blockReasons,
    },
    audit_events: auditRows,
  };
}

export const adminCustomerFilters = z.object({
  q: z.string().trim().max(120).default(""),
  status: z.enum(["all", "active", "restricted", "disabled", "closed"]).default("all"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function adminCustomersList(db: DB, actor: Actor, filters: z.infer<typeof adminCustomerFilters>) {
  role(actor, "support", "finance", "super_admin");
  const { q, status, page, limit } = filters;
  const search = q.trim().toLowerCase();
  const rawUpper = extractReceivingCode(q);
  const financeVisible = canSeeFinanceAmounts(actor);

  const { rows } = await db.query(
    `select u.id, u.display_name, u.status, u.locale, u.timezone, u.created_at, u.updated_at,
            crp.org_id, crp.receiving_code,
            ue.original_email, ue.normalized_email::text normalized_email, ue.delivery_state email_delivery_state,
            (select count(*)::int from orders o where o.org_id = crp.org_id) order_count,
            (select count(*)::int from orders o where o.org_id = crp.org_id and o.state not in ('draft','closed','cancelled')) active_order_count,
            (select count(*)::int from warehouse_items w where w.org_id = crp.org_id and w.custody_state in ('received','stored') and w.parent_item_id is null) stored_item_count,
            (select count(*)::int from reference_samples rs where rs.org_id = crp.org_id and rs.state = 'active' and rs.expires_at > now()) reference_count,
            (select count(*)::int from tickets k where k.org_id = crp.org_id and k.state in ('open','waiting_customer','waiting_internal')) open_ticket_count,
            (select max(o.created_at) from orders o where o.org_id = crp.org_id) last_order_at,
            coalesce((select sum(p.amount_cents)::int from charge_items c join payments p on p.id = c.applied_payment_id
              where c.org_id = crp.org_id and p.state in ('succeeded','partially_refunded','refunded')), 0) total_paid_cents,
            coalesce((select sum(r.amount_cents)::int from refunds r join payments p on p.id = r.payment_id join charge_items c on c.id = p.charge_item_id
              where c.org_id = crp.org_id and r.state = 'succeeded'), 0) total_refunded_cents
     from customer_receiving_profiles crp
     join users u on u.id = crp.user_id
     left join user_emails ue on ue.user_id = u.id and ue.is_primary
     where ($1 = 'all' or u.status = $1)
       and ($2 = '' or
         strpos(replace(upper(crp.receiving_code),'-',''), replace($3,'-','')) > 0 or
         strpos(lower(coalesce(ue.original_email, ue.normalized_email::text, '')), $2) > 0 or
         strpos(lower(coalesce(u.display_name, '')), $2) > 0 or
         strpos(lower(u.id::text), $2) > 0 or
         exists(select 1 from orders o where o.org_id = crp.org_id and strpos(replace(upper(o.public_no),'-',''), replace($3,'-','')) > 0)
       )
     order by last_order_at desc nulls last, u.created_at desc`,
    [status, search, rawUpper]
  );

  const total = rows.length;
  const offset = (page - 1) * limit;
  return {
    total,
    page,
    limit,
    has_more: offset + limit < total,
    financial_restricted: !financeVisible,
    rows: rows.slice(offset, offset + limit).map(r => ({
      id: r.id,
      org_id: r.org_id,
      receiving_code: r.receiving_code,
      display_name: r.display_name ?? null,
      email: maskEmailForStaff(actor, r.original_email, r.normalized_email),
      email_delivery_state: r.email_delivery_state ?? null,
      status: r.status,
      order_count: Number(r.order_count ?? 0),
      active_order_count: Number(r.active_order_count ?? 0),
      stored_item_count: Number(r.stored_item_count ?? 0),
      reference_count: Number(r.reference_count ?? 0),
      open_ticket_count: Number(r.open_ticket_count ?? 0),
      last_order_at: r.last_order_at ?? null,
      total_paid_cents: financeVisible ? Number(r.total_paid_cents ?? 0) : null,
      total_refunded_cents: financeVisible ? Number(r.total_refunded_cents ?? 0) : null,
      created_at: r.created_at,
    })),
  };
}

export async function adminCustomerDetail(db: DB, actor: Actor, userId: string) {
  role(actor, "support", "finance", "super_admin");
  const financeVisible = canSeeFinanceAmounts(actor);

  const profile = await one(
    db,
    `select u.id, u.display_name, u.status, u.locale, u.timezone, u.created_at, u.updated_at,
            crp.org_id, crp.receiving_code, crp.created_at receiving_assigned_at,
            org.name org_name, org.kind org_kind, org.country org_country,
            ue.original_email, ue.normalized_email::text normalized_email, ue.verified_at email_verified_at, ue.delivery_state email_delivery_state
     from customer_receiving_profiles crp
     join users u on u.id = crp.user_id
     join organizations org on org.id = crp.org_id
     left join user_emails ue on ue.user_id = u.id and ue.is_primary
     where u.id = $1`,
    [userId]
  );

  const orgId = profile.org_id as string;

  const authIdentities = (await db.query(
    `select id, provider, status, linked_at, last_authenticated_at
     from auth_identities where user_id = $1 order by linked_at asc`,
    [userId]
  )).rows;

  const orders = (await db.query(
    `select o.id, o.public_no, o.state, o.price_cents, o.is_test, o.created_at, o.paid_at, o.sla_due_at, o.report_published_at,
            (select so.title->>'zh-CN' from order_lines ol join service_offers so on so.id = ol.offer_id where ol.order_id = o.id limit 1) service_title,
            coalesce((select sum(ol.quantity)::int from order_lines ol where ol.order_id = o.id), 0) expected_units,
            (select rp.published_version from reports rp where rp.order_id = o.id limit 1) report_version
     from orders o where o.org_id = $1 order by o.created_at desc limit 100`,
    [orgId]
  )).rows;

  const parcels = (await db.query(
    `select pa.id advice_id, t.tracking_norm, t.carrier_code, t.transport_state, t.sync_state,
            p.id package_id, p.code package_code, p.state package_state, p.received_quantity, p.weight_g, p.received_at,
            array(select o.public_no from advice_orders ao join orders o on o.id = ao.order_id where ao.advice_id = pa.id order by o.public_no) order_numbers
     from package_advices pa
     left join tracking_records t on t.advice_id = pa.id and t.direction = 'inbound' and t.closed_at is null
     left join packages p on p.advice_id = pa.id
     where pa.org_id = $1 order by pa.created_at desc nulls last limit 100`,
    [orgId]
  )).rows;

  const items = (await db.query(
    `select w.id, w.code, w.identity_state, w.condition_state, w.custody_state, w.received_at, w.storage_until,
            sl.code location_code, p.code package_code, o.public_no order_no,
            (select d.action || ':' || d.state from disposition_requests d
             where d.item_id = w.id and d.state not in ('completed','cancelled') order by d.revision desc limit 1) active_disposition
     from warehouse_items w
     join packages p on p.id = w.package_id
     left join storage_locations sl on sl.id = w.location_id
     left join order_line_item_links a on a.item_id = w.id and a.unlinked_at is null
     left join order_lines ol on ol.id = a.order_line_id
     left join orders o on o.id = ol.order_id
     where w.org_id = $1 and w.parent_item_id is null
     order by w.received_at desc limit 150`,
    [orgId]
  )).rows;

  const referenceSamples = (await db.query(
    `select rs.id, rs.state, rs.revision, rs.expires_at, rs.condition_note,
            rs.authorization_snapshot->>'seal_code' seal_code,
            rs.authorization_snapshot->>'safe_location_code' safe_location_code,
            w.code item_code, w.custody_state
     from reference_samples rs join warehouse_items w on w.id = rs.item_id
     where rs.org_id = $1 order by rs.expires_at desc limit 50`,
    [orgId]
  )).rows;

  const reports = (await db.query(
    `select rp.id report_id, rp.public_no, rp.published_version, o.public_no order_no,
            rv.id version_id, rv.published_at, rv.state
     from reports rp
     join orders o on o.id = rp.order_id
     join report_versions rv on rv.report_id = rp.id and rv.version = rp.published_version
     where o.org_id = $1 and rp.published_version is not null
     order by rv.published_at desc nulls last limit 50`,
    [orgId]
  )).rows;

  const payments = financeVisible ? (await db.query(
    `select p.id, p.amount_cents, p.currency, p.state, p.provider, p.provider_ref, p.created_at, p.updated_at,
            c.id charge_item_id, c.purpose,
            coalesce((select sum(r.amount_cents)::int from refunds r where r.payment_id = p.id and r.state = 'succeeded'), 0) refunded_cents,
            (select o.public_no from inspection_quotes iq join orders o on o.id = iq.order_id where iq.id = c.inspection_quote_id limit 1) order_no
     from charge_items c join payments p on p.charge_item_id = c.id
     where c.org_id = $1 order by p.created_at desc limit 100`,
    [orgId]
  )).rows.map(p => ({ ...p, display_ref: paymentDisplayRef(p.id) })) : [];

  const refunds = financeVisible ? (await db.query(
    `select r.id, r.payment_id, r.amount_cents, r.reason, r.state, r.created_at, c.purpose,
            (select o.public_no from inspection_quotes iq join orders o on o.id = iq.order_id where iq.id = c.inspection_quote_id limit 1) order_no
     from refunds r join payments p on p.id = r.payment_id join charge_items c on c.id = p.charge_item_id
     where c.org_id = $1 order by r.created_at desc limit 100`,
    [orgId]
  )).rows.map(rf => ({ ...rf, display_ref: refundDisplayRef(rf.id) })) : [];

  const tickets = (await db.query(
    `select k.id, k.public_no, k.category, k.state, k.subject, k.created_at, k.next_action_at, o.public_no order_no
     from tickets k left join orders o on o.id = k.order_id
     where k.org_id = $1 order by k.created_at desc limit 100`,
    [orgId]
  )).rows;

  const incidents = (await db.query(
    `select ic.id, ic.state, ic.resolution->>'kind' kind, w.code item_code, t.public_no ticket_no, o.public_no order_no, t.created_at
     from incident_cases ic
     join warehouse_items w on w.id = ic.item_id
     join tickets t on t.id = ic.ticket_id
     left join orders o on o.id = t.order_id
     where w.org_id = $1 order by t.created_at desc limit 50`,
    [orgId]
  )).rows;

  const notifications = (await db.query(
    `select n.id, n.template, n.read_at, n.created_at, o.public_no order_no
     from notifications n left join orders o on o.id = n.order_id
     where n.user_id = $1 order by n.created_at desc limit 30`,
    [userId]
  )).rows;

  const summary = {
    order_count: orders.length,
    active_inspection_count: orders.filter(o => !["draft", "closed", "cancelled"].includes(o.state)).length,
    stored_item_count: items.filter(i => ["received", "stored"].includes(i.custody_state)).length,
    reference_count: referenceSamples.filter(r => r.state === "active").length,
    published_report_count: reports.length,
    open_ticket_count: tickets.filter(k => !["resolved", "closed"].includes(k.state)).length,
    paid_cents: financeVisible ? payments.filter(p => ["succeeded", "partially_refunded", "refunded"].includes(p.state)).reduce((s, p) => s + Number(p.amount_cents), 0) : null,
    refunded_cents: financeVisible ? refunds.filter(r => r.state === "succeeded").reduce((s, r) => s + Number(r.amount_cents), 0) : null,
  };

  return {
    profile: {
      id: profile.id,
      org_id: profile.org_id,
      receiving_code: profile.receiving_code,
      receiving_assigned_at: profile.receiving_assigned_at,
      display_name: profile.display_name,
      email: maskEmailForStaff(actor, profile.original_email, profile.normalized_email),
      email_verified_at: profile.email_verified_at,
      email_delivery_state: profile.email_delivery_state,
      status: profile.status,
      locale: profile.locale,
      timezone: profile.timezone,
      org_name: profile.org_name,
      org_kind: profile.org_kind,
      org_country: profile.org_country,
      created_at: profile.created_at,
      auth_identities: authIdentities,
    },
    financial_restricted: !financeVisible,
    summary,
    orders,
    parcels,
    items,
    reference_samples: referenceSamples,
    reports,
    payments,
    refunds,
    tickets,
    incidents,
    notifications,
  };
}

export async function adminInspectionsOverview(db: DB, actor: Actor, opts?: { q?: string; state?: string }) {
  role(actor, "inspector", "reviewer", "warehouse_admin", "support", "super_admin");
  const search = (opts?.q ?? "").trim().toUpperCase();
  const stateFilter = (opts?.state ?? "").trim();

  const tasks = (await db.query(
    `select t.id, t.state, t.revision, t.assignee_id, u.display_name assignee_name,
            o.id order_id, o.public_no order_no, o.state order_state, o.sla_due_at,
            crp.receiving_code,
            st.code service_code, st.labels->>'zh-CN' service_label,
            cat.labels->>'zh-CN' category_label,
            tv.template_key, tv.version template_version,
            coalesce(w.code, (select string_agg(gw.code, ', ' order by gw.code)
              from group_members gm join order_line_item_links ga on ga.id = gm.assignment_id join warehouse_items gw on gw.id = ga.item_id
              where gm.group_id = t.group_id)) item_codes,
            t.group_id is not null is_group_task,
            (select count(*)::int from inspection_results ir where ir.task_id = t.id) result_count,
            (select count(*)::int from task_evidence te where te.task_id = t.id) evidence_count
     from inspection_tasks t
     join order_lines l on l.id = t.order_line_id
     join orders o on o.id = l.order_id
     join service_offers so on so.id = l.offer_id
     join service_types st on st.id = so.service_type_id
     join categories cat on cat.id = l.category_id
     join template_versions tv on tv.id = t.template_version_id
     left join customer_receiving_profiles crp on crp.org_id = o.org_id
     left join users u on u.id = t.assignee_id
     left join order_line_item_links a on a.id = t.assignment_id
     left join warehouse_items w on w.id = a.item_id
     where t.state <> 'VOID'
       and ($1 = '' or t.state = $1)
       and ($2 = '' or strpos(upper(o.public_no), $2) > 0 or strpos(upper(coalesce(crp.receiving_code, '')), $2) > 0 or strpos(upper(coalesce(w.code, '')), $2) > 0)
     order by t.state = 'SUBMITTED' desc, t.state = 'IN_PROGRESS' desc, o.sla_due_at asc nulls last, o.created_at desc
     limit 150`,
    [stateFilter, search]
  )).rows;

  const qaReviews = (await db.query(
    `select v.id, v.version, v.state, v.revision, v.created_at, v.reviewed_at, v.published_at, v.amend_reason,
            r.id report_id, r.public_no report_no, r.published_version,
            o.id order_id, o.public_no order_no, o.state order_state,
            crp.receiving_code,
            cu.display_name created_by_name, ru.display_name reviewed_by_name,
            v.created_by, v.reviewed_by,
            jsonb_array_length(coalesce(v.snapshot->'sections', '[]'::jsonb)) section_count
     from report_versions v
     join reports r on r.id = v.report_id
     join orders o on o.id = r.order_id
     left join customer_receiving_profiles crp on crp.org_id = o.org_id
     left join users cu on cu.id = v.created_by
     left join users ru on ru.id = v.reviewed_by
     where ($1 = '' or strpos(upper(o.public_no), $1) > 0 or strpos(upper(r.public_no), $1) > 0 or strpos(upper(coalesce(crp.receiving_code, '')), $1) > 0)
     order by v.state = 'submitted' desc, v.state = 'qa_approved' desc, v.state = 'draft' desc, v.created_at desc
     limit 150`,
    [search]
  )).rows;

  const summary = {
    pending_tasks: tasks.filter(t => ["PENDING", "READY", "ASSIGNED", "IN_PROGRESS"].includes(t.state)).length,
    submitted_for_qa: tasks.filter(t => t.state === "SUBMITTED").length,
    awaiting_report_review: qaReviews.filter(r => r.state === "submitted").length,
    awaiting_pdf: qaReviews.filter(r => r.state === "qa_approved").length,
    published_reports: qaReviews.filter(r => r.state === "published").length,
  };

  return {
    summary,
    tasks,
    qa_reviews: qaReviews.filter(r => ["draft", "submitted", "qa_approved"].includes(r.state)),
    reports: qaReviews.filter(r => ["published", "superseded"].includes(r.state)),
  };
}

export async function adminInspectionTaskDetail(db: DB, actor: Actor, id: string) {
  role(actor, "inspector", "reviewer", "warehouse_admin", "support", "super_admin");
  const base = await taskDetail(db, actor, id);
  const meta = await one(
    db,
    `select t.id, t.assignee_id, u.display_name assignee_name,
            o.id order_id, o.public_no order_no, o.customer_notes,
            tv.template_key, tv.version template_version, tv.state template_state, tv.published_at template_published_at,
            array(select c.code from template_capabilities tc join capabilities c on c.id = tc.capability_id
              where tc.template_version_id = tv.id order by c.code) capability_codes,
            st.code service_code, st.labels->>'zh-CN' service_label,
            cat.slug category_slug, cat.labels->>'zh-CN' category_label,
            so.sku_code offer_sku_code, so.title->>'zh-CN' offer_title,
            crp.user_id customer_user_id, crp.receiving_code, cu.display_name customer_name, ce.original_email customer_email,
            w.code item_code, w.identity_state, w.condition_state, w.custody_state, sl.code location_code, p.code package_code,
            e.declared_fields
     from inspection_tasks t
     join order_lines l on l.id = t.order_line_id
     join orders o on o.id = l.order_id
     join service_offers so on so.id = l.offer_id
     join service_types st on st.id = so.service_type_id
     join categories cat on cat.id = l.category_id
     join template_versions tv on tv.id = t.template_version_id
     left join users u on u.id = t.assignee_id
     left join customer_receiving_profiles crp on crp.org_id = o.org_id
     left join users cu on cu.id = crp.user_id
     left join user_emails ce on ce.user_id = cu.id and ce.is_primary
     left join order_line_item_links a on a.id = t.assignment_id
     left join expected_items e on e.id = a.expected_item_id
     left join warehouse_items w on w.id = a.item_id
     left join packages p on p.id = w.package_id
     left join storage_locations sl on sl.id = w.location_id
     where t.id = $1`,
    [id]
  );

  const reports = (await db.query(
    `select r.id report_id, r.public_no report_no, r.published_version,
            v.id version_id, v.version, v.state, v.amend_reason, v.created_at, v.reviewed_at, v.published_at,
            cu.display_name created_by_name, ru.display_name reviewed_by_name
     from reports r
     join report_versions v on v.report_id = r.id
     left join users cu on cu.id = v.created_by
     left join users ru on ru.id = v.reviewed_by
     where r.order_id = $1
     order by v.version desc`,
    [meta.order_id]
  )).rows;

  return {
    ...base,
    meta: {
      ...meta,
      customer_email: maskEmailForStaff(actor, meta.customer_email, meta.customer_email),
    },
    reports,
    permissions: {
      can_execute_in_warehouse: actor.roles.includes("inspector"),
      can_qa_review: actor.roles.some(r => ["reviewer", "warehouse_admin", "super_admin"].includes(r)),
    },
  };
}

export async function adminDispositionsOverview(db: DB, actor: Actor) {
  role(actor, "support", "warehouse_admin", "finance", "super_admin");
  const canSeeMoney = canSeeFinanceAmounts(actor);

  const batches = (await db.query(
    `select b.id, b.org_id, b.action, b.state, b.revision, b.destination_snapshot,
            crp.receiving_code, crp.user_id customer_user_id,
            q.id quote_id, q.revision quote_revision, q.amount_cents, q.expires_at, q.accepted_at,
            c.id charge_id, c.applied_payment_id is not null or c.free_authorization is not null paid,
            coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'code', w.code, 'order_no', o.public_no) order by w.code)
              from dispatch_batch_items bi
              join warehouse_items w on w.id = bi.item_id
              left join order_line_item_links l on l.item_id = w.id and l.unlinked_at is null
              left join order_lines ol on ol.id = l.order_line_id
              left join orders o on o.id = ol.order_id
              where bi.batch_id = b.id and bi.released_at is null), '[]'::jsonb) items,
            coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'tracking_norm', s.tracking_norm, 'carrier_code', s.carrier_code,
              'state', s.state, 'weight_g', s.weight_g, 'shipped_at', s.shipped_at) order by s.shipped_at nulls first, s.id)
              from shipments s where s.batch_id = b.id), '[]'::jsonb) shipments
     from dispatch_batches b
     left join customer_receiving_profiles crp on crp.org_id = b.org_id
     left join lateral (
       select * from dispatch_quote_versions dqv where dqv.batch_id = b.id order by dqv.revision desc limit 1
     ) q on true
     left join charge_items c on c.dispatch_quote_id = q.id
     order by b.state in ('confirmed','quoted','paid') desc, b.id desc limit 100`
  )).rows.map(b => ({
    ...b,
    amount_cents: canSeeMoney && b.amount_cents !== null ? Number(b.amount_cents) : null,
    financial_restricted: !canSeeMoney,
  }));

  const storageRequests = (await db.query(
    `select d.id, d.org_id, d.state, d.action, d.return_info, w.code item_code, w.storage_until,
            crp.receiving_code, crp.user_id customer_user_id,
            sq.id quote_id, sq.amount_cents, sq.expires_at, sq.accepted_at,
            (c.applied_payment_id is not null or c.free_authorization is not null) paid
     from disposition_requests d
     join warehouse_items w on w.id = d.item_id
     left join customer_receiving_profiles crp on crp.org_id = d.org_id
     left join lateral (select * from storage_quotes q where q.disposition_id = d.id order by q.revision desc limit 1) sq on true
     left join charge_items c on c.storage_quote_id = sq.id
     where d.action = 'retain'
     order by d.state = 'requested' desc, d.id desc limit 80`
  )).rows;

  const manualQuotes = (await db.query(
    `select r.id, r.order_id, r.revision, r.state, r.assignee_id, u.display_name assignee_name, r.due_at, r.reason,
            o.public_no, o.state order_state, o.created_at order_created_at,
            crp.user_id customer_user_id, crp.receiving_code, ue.original_email customer_email,
            iq.id offered_quote_id, iq.amount_cents offered_amount_cents, iq.expires_at offered_expires_at,
            (select jsonb_agg(jsonb_build_object(
              'id', l.id, 'quantity', l.quantity, 'title', s.title->>'zh-CN',
              'sku_count', case when jsonb_typeof(l.attributes->'expected_lines')='array' then jsonb_array_length(l.attributes->'expected_lines') else 1 end
            ) order by l.id)
             from order_lines l join service_offers s on s.id = l.offer_id where l.order_id = r.order_id) lines
     from manual_quote_requests r
     join orders o on o.id = r.order_id and o.revision = r.revision
     left join users u on u.id = r.assignee_id
     left join customer_receiving_profiles crp on crp.org_id = o.org_id
     left join users cu on cu.id = crp.user_id
     left join user_emails ue on ue.user_id = cu.id and ue.is_primary
     left join inspection_quotes iq on iq.id = r.accepted_quote_id
     where r.state in ('requested','offered')
     order by r.state = 'requested' desc, r.due_at asc limit 100`
  )).rows.map(m => ({
    ...m,
    customer_email: maskEmailForStaff(actor, m.customer_email, m.customer_email),
  }));

  return {
    batches,
    storage_requests: storageRequests,
    manual_quotes: manualQuotes,
  };
}

export async function adminIncidentDetail(db: DB, actor: Actor, id: string) {
  role(actor, "receiver", "warehouse_admin", "support", "finance", "super_admin");
  const financeVisible = canSeeFinanceAmounts(actor);

  const ic = await one(
    db,
    `select ic.*,
            w.code item_code, w.org_id, w.identity_state, w.condition_state, w.custody_state, w.received_at item_received_at, w.storage_until,
            sl.code location_code, p.code package_code,
            (select tr.tracking_norm from tracking_records tr where tr.package_id = p.id and tr.direction = 'inbound' and tr.closed_at is null limit 1) inbound_tracking_norm,
            t.public_no ticket_no, t.state ticket_state, t.subject ticket_subject, t.order_id, t.created_at, t.resolved_at,
            o.public_no order_no, o.state order_state,
            crp.user_id customer_user_id, crp.receiving_code, cu.display_name customer_name, ce.original_email customer_email
     from incident_cases ic
     join warehouse_items w on w.id = ic.item_id
     join packages p on p.id = w.package_id
     left join storage_locations sl on sl.id = w.location_id
     join tickets t on t.id = ic.ticket_id
     left join order_lines ol on ol.id = ic.order_line_id
     left join orders o on o.id = coalesce(ol.order_id, t.order_id)
     left join customer_receiving_profiles crp on crp.org_id = w.org_id
     left join users cu on cu.id = crp.user_id
     left join user_emails ce on ce.user_id = cu.id and ce.is_primary
     where ic.id = $1`,
    [id]
  );

  const storageEvents = (await db.query(
    `select se.id, se.action, se.created_at, fl.code from_location, tl.code to_location, u.display_name operator_name
     from storage_events se
     left join storage_locations fl on fl.id = se.from_location_id
     left join storage_locations tl on tl.id = se.to_location_id
     left join users u on u.id = se.operator_id
     where se.item_id = $1 order by se.created_at desc limit 20`,
    [ic.item_id]
  )).rows;

  const ticketEvents = (await db.query(
    `select te.id, te.actor_type, te.kind, te.body, te.media_ids, te.created_at, u.display_name actor_name
     from ticket_events te left join users u on u.id = te.actor_id
     where te.ticket_id = $1 order by te.created_at asc, te.id asc`,
    [ic.ticket_id]
  )).rows;

  const auditRows = (await db.query(
    `select a.id, a.at, a.actor_type, u.display_name actor_name, a.action, a.after
     from audit_events a left join users u on u.id = a.actor_id
     where a.entity_type = 'incident_cases' and a.entity_id = $1
     order by a.at asc, a.id asc limit 40`,
    [id]
  )).rows;

  const maxRefundableRow = (financeVisible && ic.order_id) ? (await db.query<{ refundable: number; paid: number }>(
    `select coalesce(sum(p.amount_cents - coalesce((select sum(r.amount_cents) from refunds r where r.payment_id=p.id and r.state in ('approved','succeeded')),0)),0)::int refundable,
            coalesce(sum(p.amount_cents),0)::int paid
     from inspection_quotes q join charge_items c on c.inspection_quote_id=q.id join payments p on p.charge_item_id=c.id
     where q.order_id=$1 and p.state in ('succeeded','partially_refunded')`,
    [ic.order_id]
  )).rows[0] : null;

  const res = (ic.resolution ?? {}) as Record<string, unknown>;
  const safeResolution = financeVisible
    ? res
    : (() => {
      const { service_refund_cents, compensation_cents, currency, ...rest } = res;
      return { ...rest, financial_restricted: true };
    })();

  const createdByUser = typeof res.created_by === "string"
    ? (await db.query<{ display_name: string }>("select display_name from users where id=$1", [res.created_by])).rows[0]?.display_name ?? null
    : null;
  const proposedByUser = typeof res.proposed_by === "string"
    ? (await db.query<{ display_name: string }>("select display_name from users where id=$1", [res.proposed_by])).rows[0]?.display_name ?? null
    : null;
  const approvedByUser = typeof res.approved_by === "string"
    ? (await db.query<{ display_name: string }>("select display_name from users where id=$1", [res.approved_by])).rows[0]?.display_name ?? null
    : null;

  return {
    incident: {
      id: ic.id,
      state: ic.state,
      ticket_id: ic.ticket_id,
      ticket_no: ic.ticket_no,
      ticket_state: ic.ticket_state,
      ticket_subject: ic.ticket_subject,
      created_at: ic.created_at,
      resolved_at: ic.resolved_at,
      evidence_ids: (ic.evidence?.media_ids ?? []) as string[],
      resolution: safeResolution,
      payment_proof: financeVisible ? (ic.payment_proof ?? null) : (ic.payment_proof ? { settled: true, financial_restricted: true } : null),
      financial_restricted: !financeVisible,
      created_by_name: createdByUser,
      proposed_by_name: proposedByUser,
      approved_by_name: approvedByUser,
      can_approve_sod: ic.state === "proposed" && financeVisible && res.proposed_by !== actor.id,
      awaiting_customer: ic.state === incidentAwaitingCustomer,
    },
    customer: {
      user_id: ic.customer_user_id ?? null,
      org_id: ic.org_id,
      receiving_code: ic.receiving_code ?? null,
      display_name: ic.customer_name ?? null,
      email: maskEmailForStaff(actor, ic.customer_email, ic.customer_email),
    },
    item: {
      id: ic.item_id,
      code: ic.item_code,
      package_code: ic.package_code,
      inbound_tracking_norm: ic.inbound_tracking_norm,
      location_code: ic.location_code,
      identity_state: ic.identity_state,
      condition_state: ic.condition_state,
      custody_state: ic.custody_state,
      received_at: ic.item_received_at,
      storage_until: ic.storage_until,
      order_id: ic.order_id,
      order_no: ic.order_no,
      order_state: ic.order_state,
    },
    order_refund_capacity: maxRefundableRow,
    storage_events: storageEvents,
    ticket_events: ticketEvents,
    audit_events: auditRows,
  };
}

export async function adminDisposalDetail(db: DB, actor: Actor, id: string) {
  role(actor, "receiver", "warehouse_admin", "support", "super_admin");
  const dc = await one(
    db,
    `select dc.*,
            ru.display_name requested_by_name,
            au.display_name approved_by_name,
            crp.user_id customer_user_id, crp.receiving_code, cu.display_name customer_name, ce.original_email customer_email
     from disposal_cases dc
     left join users ru on ru.id = dc.requested_by
     left join users au on au.id = dc.approved_by
     left join customer_receiving_profiles crp on crp.org_id = dc.org_id
     left join users cu on cu.id = crp.user_id
     left join user_emails ce on ce.user_id = cu.id and ce.is_primary
     where dc.id = $1`,
    [id]
  );

  const items = (await db.query(
    `select w.id, w.code, w.identity_state, w.condition_state, w.custody_state, w.received_at, w.storage_until,
            sl.code location_code, p.code package_code, o.public_no order_no,
            (select tr.tracking_norm from tracking_records tr where tr.package_id = p.id and tr.direction = 'inbound' and tr.closed_at is null limit 1) tracking_norm
     from disposal_items di
     join warehouse_items w on w.id = di.item_id
     join packages p on p.id = w.package_id
     left join storage_locations sl on sl.id = w.location_id
     left join order_line_item_links a on a.item_id = w.id and a.unlinked_at is null
     left join order_lines ol on ol.id = a.order_line_id
     left join orders o on o.id = ol.order_id
     where di.case_id = $1 order by w.code`,
    [id]
  )).rows;

  const approvals = (await db.query(
    `select dca.*, u.display_name actor_name
     from disposal_case_approvals dca left join users u on u.id = dca.actor_id
     where dca.case_id = $1 order by dca.revision desc`,
    [id]
  )).rows;

  const auditRows = (await db.query(
    `select a.id, a.at, a.actor_type, u.display_name actor_name, a.action, a.after
     from audit_events a left join users u on u.id = a.actor_id
     where a.entity_type = 'disposal_cases' and a.entity_id = $1
     order by a.at asc, a.id asc limit 30`,
    [id]
  )).rows;

  const execFlag = (await db.query<{ value: unknown }>("select value from app_config where key='disposal.production_execution_enabled'")).rows[0];
  const prodEnabled = execFlag?.value === true || (typeof execFlag?.value === "object" && execFlag?.value !== null && (execFlag.value as { enabled?: boolean }).enabled === true);

  return {
    case: {
      id: dc.id,
      display_ref: `DSP-${String(dc.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      org_id: dc.org_id,
      state: dc.state,
      revision: dc.revision,
      policy_snapshot: dc.policy_snapshot,
      authorization_snapshot: dc.authorization_snapshot,
      execution_evidence: dc.execution_evidence,
      requested_by: dc.requested_by,
      requested_by_name: dc.requested_by_name,
      approved_by: dc.approved_by,
      approved_by_name: dc.approved_by_name,
      can_approve_sod: dc.state === "pending_approval" && dc.requested_by !== actor.id && hasStaffAccess(actor.roles, ["reviewer", "warehouse_admin", "super_admin"]),
      production_execution_enabled: prodEnabled,
    },
    customer: dc.org_id ? {
      user_id: dc.customer_user_id ?? null,
      org_id: dc.org_id,
      receiving_code: dc.receiving_code ?? null,
      display_name: dc.customer_name ?? null,
      email: maskEmailForStaff(actor, dc.customer_email, dc.customer_email),
    } : null,
    items,
    approvals,
    audit_events: auditRows,
  };
}

export async function adminStorageLocationDetail(db: DB, actor: Actor, id: string) {
  role(actor, "receiver", "warehouse_admin", "super_admin");
  const location = await one(
    db,
    `select id, code, zone, active, capacity, notes from storage_locations where id = $1`,
    [id]
  );
  const items = (await db.query(
    `select w.id, w.code, w.identity_state, w.condition_state, w.custody_state, w.received_at, w.storage_until,
            p.code package_code, crp.receiving_code, o.public_no order_no
     from warehouse_items w
     join packages p on p.id = w.package_id
     left join customer_receiving_profiles crp on crp.org_id = w.org_id
     left join order_line_item_links a on a.item_id = w.id and a.unlinked_at is null
     left join order_lines ol on ol.id = a.order_line_id
     left join orders o on o.id = ol.order_id
     where w.location_id = $1 and w.custody_state in ('received','stored') and w.parent_item_id is null
     order by w.received_at desc`,
    [id]
  )).rows;
  const moves = (await db.query(
    `select se.id, se.action, se.created_at, w.code item_code, fl.code from_location, tl.code to_location, u.display_name operator_name
     from storage_events se
     join warehouse_items w on w.id = se.item_id
     left join storage_locations fl on fl.id = se.from_location_id
     left join storage_locations tl on tl.id = se.to_location_id
     left join users u on u.id = se.operator_id
     where se.from_location_id = $1 or se.to_location_id = $1
     order by se.created_at desc limit 30`,
    [id]
  )).rows;
  return { location, items, moves };
}
