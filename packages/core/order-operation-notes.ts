import type { DB } from "../db";
import { audit, guard, one, role, type Actor } from "./common";
import { staffAccess } from "./staff-access";

export async function orderOperationNotes(db:DB,orderId:string,taskId?:string) {
  const {rows}=await db.query(`with notes as (select a.id,a.at,a.action,u.display_name,
    coalesce(a.after->>'body',a.after->>'reason') body,
    a.after->>'task_id' task_id
    from audit_events a left join users u on u.id=a.actor_id
    where a.entity_type='orders' and a.entity_id=$1 and a.actor_type='staff'
      and a.action in ('order_handoff_note','task_handoff_note','customer_instruction_confirmed','hold_order','resume_order','extend_order_arrival')
      and coalesce(a.after->>'body',a.after->>'reason') is not null
      and ($2::text is null or a.after->>'task_id' is null or a.after->>'task_id'=$2)
    ) select * from (
      select * from notes where action='customer_instruction_confirmed'
      union all
      (select * from notes where action<>'customer_instruction_confirmed' order by at desc,id desc limit 50)
    ) visible order by (action='customer_instruction_confirmed') desc,at desc,id desc`,[orderId,taskId??null]);
  return rows;
}

export async function appendOrderOperationNote(db:DB,actor:Actor,id:string,body:string) {
  role(actor,...staffAccess.orders);
  await one(db,"select id from orders where id=$1",[id]);
  await audit(db,actor,"order_handoff_note","orders",id,{body});
  return {saved:true};
}

export async function appendTaskOperationNote(db:DB,actor:Actor,id:string,body:string) {
  role(actor,"inspector","reviewer","warehouse_admin","super_admin");
  const task=await one<{order_id:string;assignee_id:string|null;state:string}>(db,`
    select l.order_id,t.assignee_id,t.state from inspection_tasks t
    join order_lines l on l.id=t.order_line_id where t.id=$1 for update of t`,[id]);
  const supervisor=actor.roles.some(r=>["reviewer","warehouse_admin","super_admin"].includes(r));
  guard(task.state!=="VOID"&&(supervisor||task.assignee_id===actor.id),
    "TASK_NOTE_FORBIDDEN","Only the assigned inspector or an authorized supervisor can record this handoff.",403);
  await audit(db,actor,"task_handoff_note","orders",task.order_id,{body,task_id:id});
  return {saved:true};
}
