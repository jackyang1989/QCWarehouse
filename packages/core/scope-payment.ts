import { paymentAwaitingResolution, unresolvedQuotePayment } from "./common";

const currentScopeSupplement=`o.state='awaiting_samples' and s.accepted_at is not null
  and s.previous_snapshot->>'order_revision'=o.revision::text
  and exists(select 1 from order_blocks b where b.order_id=o.id and b.reason='scope_payment_pending'
    and b.object_key=s.id::text and b.resolved_at is null)`;

export const scopeSupplementState=`case
  when c.applied_payment_id is not null or c.free_authorization is not null then 'paid'
  when c.voided_at is not null or not coalesce((${currentScopeSupplement}),false) then 'inactive'
  when exists(select 1 from payments p where p.charge_item_id=c.id and ${paymentAwaitingResolution})
    or (q.expires_at<=now() and ${unresolvedQuotePayment}) then 'processing'
  when q.expires_at<=now() then 'expired'
  else 'open' end`;

export const scopeSupplementForOrder=`(select jsonb_build_object('id',s.id,'state',${scopeSupplementState},'amount_cents',c.amount_cents)
  from scope_revisions s join charge_items c on c.scope_revision_id=s.id and c.org_id=o.org_id
  join inspection_quotes q on q.id=c.inspection_quote_id and q.order_id=o.id
  where s.order_id=o.id and (${currentScopeSupplement})
    and c.voided_at is null and c.applied_payment_id is null and c.free_authorization is null
  order by s.revision desc limit 1)`;
