// An order line can have many independent tasks; group tasks apply only to their recorded members.
export const itemInspectionStageSql=`(select case
  when t.state='IN_PROGRESS' then 'in_inspection'
  when t.state in ('SUBMITTED','QA_APPROVED') then 'inspected'
  else 'pending' end
  from order_line_item_links a2 join inspection_tasks t on t.order_line_id=a2.order_line_id
    and (t.assignment_id=a2.id or exists(select 1 from group_members gm
      where gm.group_id=t.group_id and gm.assignment_id=a2.id and gm.order_line_id=a2.order_line_id))
  where a2.item_id=w.id and a2.unlinked_at is null and t.state<>'VOID'
  order by case when t.state='IN_PROGRESS' then 0 when t.state in ('SUBMITTED','QA_APPROVED') then 1 else 2 end limit 1)`;
