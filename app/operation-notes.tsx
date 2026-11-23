"use client";

import { useState } from "react";
import { operationNoteLimit } from "../packages/core/order-note-limits";
import { Form, Panel, request, stamp, text, type Row } from "./ui";

const labels:Record<string,string>={
  order_handoff_note:"订单交接",task_handoff_note:"质检任务交接",customer_instruction_confirmed:"客服确认的客户补充说明",
  hold_order:"暂停订单",resume_order:"恢复订单",extend_order_arrival:"延长收货期限",
  pack_shipment:"装箱备注",handover:"出库交接备注",
};

export function OperationNoteList({notes}:{notes:Row[]}) {
  return notes.length?<ol className="timeline" aria-label="最近操作备注">
      {notes.map(note=><li key={note.id}>
        <div className="row between flexwrap"><strong>{labels[note.action]}</strong>
          <small className="muted">{note.display_name??"员工"} · {stamp(note.at,true)}</small></div>
        <p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{note.body}</p>
      </li>)}
    </ol>:<p className="muted">暂无操作备注。</p>;
}

export function OperationNotes({notes,writePath,reload}:{notes:Row[];writePath?:string;reload:()=>void}) {
  const [saved,setSaved]=useState(0);
  return <Panel title="操作备注与交接" subtitle="仅授权员工可见。追加记录会保留记录人和时间。">
    <OperationNoteList notes={notes}/>
    {notes.filter(note=>note.action!=="customer_instruction_confirmed").length===50&&<p className="muted small">显示最近 50 条操作记录及全部已确认的客户补充说明。</p>}
    {writePath&&<Form key={saved} label="追加操作备注" idempotent run={async(fields,key)=>{
      await request(writePath,"POST",{body:text(fields,"body")},key);
      setSaved(count=>count+1);
      reload();
    }}>
      <label>交接内容（追加时必填）
        <textarea name="body" required minLength={2} maxLength={operationNoteLimit}/>
      </label>
    </Form>}
    {saved>0&&<p role="status" className="notice">操作备注已保存。</p>}
  </Panel>;
}
