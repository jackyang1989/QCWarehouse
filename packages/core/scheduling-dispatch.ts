import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db";
import { audit, event, guard, hash, lock, one, role, uuid, type Actor } from "./common";
import { assertItemsOutsideQuarantine } from "./storage";

export const TASK_DOMAINS = ["inspection", "receiving", "packing", "qa_review", "stocktake", "ticket"] as const;
export const HANDOVER_TYPES = ["assign", "relay", "reassign", "emergency_takeover", "qa_return_reassign"] as const;

const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const staffShiftUpsertSchema = z.object({
  warehouse_id: z.uuid(),
  user_id: z.uuid(),
  workstation_id: z.uuid().nullable().optional(),
  shift_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shift_code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/),
  start_time: z.string().regex(HH_MM_REGEX, "Invalid HH:MM start time."),
  end_time: z.string().regex(HH_MM_REGEX, "Invalid HH:MM end time."),
  available_minutes: z.number().int().min(1).max(960),
  role_scope: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  status: z.enum(["scheduled", "on_leave", "completed", "cancelled"]).default("scheduled"),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const staffShiftStatusSchema = z.object({
  status: z.enum(["scheduled", "on_leave", "completed", "cancelled"]),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const workItemRegisterSchema = z.object({
  warehouse_id: z.uuid(),
  task_domain: z.enum(TASK_DOMAINS),
  source_entity_id: z.string().trim().min(1).max(120),
  inspection_task_id: z.uuid().nullable().optional(),
  required_role: z.string().trim().min(2).max(60),
  required_skill_code: z.string().trim().min(2).max(80).nullable().optional(),
  priority: z.number().int().min(1).max(1000).default(100),
  sla_due_at: z.string().datetime().nullable().optional(),
});

export const workItemAssignSchema = z.object({
  assignee_id: z.uuid(),
  workstation_id: z.uuid().nullable().optional(),
  reason: z.string().trim().min(2).max(500).default("Supervisor assignment"),
});

export const taskLeaseClaimSchema = z.object({
  workstation_id: z.uuid().nullable().optional(),
  duration_minutes: z.number().int().min(1).max(480).default(120),
});

export const workItemPauseSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

export const handoverInitiateSchema = z.object({
  to_user_id: z.uuid(),
  to_workstation_id: z.uuid().nullable().optional(),
  handover_type: z.enum(["relay", "reassign", "emergency_takeover", "qa_return_reassign"]).default("relay"),
  reason: z.string().trim().min(2).max(500),
});

export const handoverAcceptSchema = z.object({
  notes: z.string().trim().max(500).nullable().optional(),
});

export const handoverCancelSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

export const evidenceSubmitWithLeaseSchema = z.object({
  work_item_id: z.uuid(),
  lease_token: z.string().trim().min(12).max(200),
  execution_generation: z.number().int().min(1),
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  item_key: z.string().trim().max(120).nullable().optional(),
  component: z.string().trim().max(120).nullable().optional(),
  device_id: z.uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const quarantineResolveSchema = z.object({
  resolution: z.enum(["accepted_preserving_author", "rejected_reshoot"]),
  note: z.string().trim().min(2).max(500),
});

const READ_ROLES = ["receiver", "inspector", "reviewer", "warehouse_admin", "super_admin"] as const;
const ADMIN_ROLES = ["warehouse_admin", "super_admin"] as const;

function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function resolveAdminUserIds(db: Pick<DB, "query">): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select distinct u.id
     from users u
     join staff_roles sr on sr.user_id = u.id
     left join staff_profiles sp on sp.user_id = u.id
     where u.status = 'active'
       and sr.role in ('warehouse_admin', 'super_admin')
       and (sp.user_id is null or (sp.employment_status = 'active' and sp.account_security_status = 'active'))
     order by u.id`,
  );
  return rows.map((r) => r.id);
}

async function emitDispatchInboxNotification(
  db: DB,
  params: {
    template: string;
    recipientUserIds: string[];
    dedupePrefix: string;
    payload: Record<string, unknown>;
  },
) {
  const uniqueIds = [...new Set(params.recipientUserIds.filter(Boolean))];
  for (const userId of uniqueIds) {
    await db.query(
      `insert into notifications(id, user_id, template, locale, payload, dedupe_key)
       values($1, $2, $3, 'zh-CN', $4::jsonb, $5)
       on conflict (dedupe_key) do nothing`,
      [
        uuid(),
        userId,
        params.template,
        JSON.stringify(params.payload),
        `${params.dedupePrefix}:${userId}`,
      ],
    );
  }
  await event(db, params.template, {
    ...params.payload,
    recipient_user_ids: uniqueIds,
  });
}

const ALLOWED_STATION_TYPES_BY_DOMAIN: Record<(typeof TASK_DOMAINS)[number], readonly string[] | null> = {
  receiving: ["A_receiving"],
  inspection: ["B_inspection_shoot"],
  qa_review: ["B_inspection_shoot"],
  packing: ["C_pack_handover"],
  stocktake: null,
  ticket: null,
};

async function assertWorkstationActiveInWarehouse(
  db: Pick<DB, "query">,
  workstationId: string | null | undefined,
  warehouseId: string,
  taskDomain?: (typeof TASK_DOMAINS)[number],
) {
  if (!workstationId) return;
  const ws = await one<{ id: string; warehouse_id: string; status: string; station_type: string }>(
    db,
    "select id, warehouse_id, status, station_type from workstations where id = $1 for share",
    [workstationId],
  );
  guard(ws.warehouse_id === warehouseId, "WORKSTATION_WAREHOUSE_MISMATCH", "Workstation does not belong to warehouse.", 422);
  guard(ws.status === "active", "WORKSTATION_UNAVAILABLE", "Workstation must be active.", 409);
  if (taskDomain) {
    const allowed = ALLOWED_STATION_TYPES_BY_DOMAIN[taskDomain];
    guard(
      !allowed || allowed.includes(ws.station_type),
      "WORKSTATION_DOMAIN_MISMATCH",
      `Workstation type '${ws.station_type}' is not valid for domain '${taskDomain}'.`,
      422,
    );
  }
}

async function assertAssigneeEligible(
  db: Pick<DB, "query">,
  params: {
    userId: string;
    warehouseId: string;
    requiredRole: string;
    requiredSkillCode: string | null;
  },
) {
  const wh = await one<{ timezone: string | null }>(
    db,
    "select timezone from warehouses where id = $1",
    [params.warehouseId],
  );
  const tz = wh.timezone || "Asia/Shanghai";

  const user = await one<{
    id: string;
    status: string;
    employment_status: string | null;
    account_security_status: string | null;
    allowed_warehouse_ids: string[] | null;
  }>(
    db,
    `select u.id, u.status, sp.employment_status, sp.account_security_status, sp.allowed_warehouse_ids
     from users u
     left join staff_profiles sp on sp.user_id = u.id
     where u.id = $1`,
    [params.userId],
  );
  guard(user.status === "active", "STAFF_INACTIVE", "Assignee account is not active.", 409);
  if (user.employment_status !== null) {
    guard(
      user.employment_status === "active" && user.account_security_status === "active",
      "STAFF_UNAVAILABLE",
      "Assignee employment or security status is not active.",
      409,
    );
  }
  if (user.allowed_warehouse_ids && user.allowed_warehouse_ids.length > 0) {
    guard(
      user.allowed_warehouse_ids.includes(params.warehouseId),
      "WAREHOUSE_SCOPE_FORBIDDEN",
      "Assignee is not scoped to this warehouse.",
      403,
    );
  }

  const hasRole = await db.query(
    "select 1 from staff_roles where user_id = $1 and role = $2 limit 1",
    [params.userId, params.requiredRole],
  );
  guard(hasRole.rowCount === 1, "ROLE_MISMATCH", `Assignee lacks required role '${params.requiredRole}'.`, 403);

  const shiftsToday = (
    await db.query<{ status: string; role_scope: string[] }>(
      `select status, role_scope from staff_work_shifts
       where warehouse_id = $1 and user_id = $2 and shift_date = (now() AT TIME ZONE $3)::date`,
      [params.warehouseId, params.userId, tz],
    )
  ).rows;
  guard(
    !shiftsToday.some((s) => s.status === "on_leave"),
    "STAFF_ON_LEAVE",
    "Assignee is marked on leave for today's warehouse shift.",
    409,
  );
  if (shiftsToday.length > 0) {
    const activeShifts = shiftsToday.filter((s) => s.status === "scheduled");
    guard(activeShifts.length > 0, "NO_AVAILABLE_SHIFT", "Assignee has no active scheduled shift for today.", 409);
    guard(
      activeShifts.some((s) => s.role_scope.length === 0 || s.role_scope.includes(params.requiredRole)),
      "SHIFT_ROLE_SCOPE_MISMATCH",
      `Assignee's scheduled shift excludes role '${params.requiredRole}'.`,
      403,
    );
  }

  if (params.requiredSkillCode) {
    const skill = await db.query(
      `select 1 from inspector_skill_grants
       where user_id = $1
         and skill_code = $2
         and status = 'active'
         and (valid_until is null or valid_until > now())
       limit 1`,
      [params.userId, params.requiredSkillCode],
    );
    guard(
      skill.rowCount === 1,
      "MISSING_REQUIRED_SKILL",
      `Assignee lacks active certified skill '${params.requiredSkillCode}'.`,
      409,
    );
  }
}

export async function listStaffShifts(
  db: Pick<DB, "query">,
  actor: Actor,
  filters: { warehouse_id?: string; shift_date?: string; user_id?: string },
) {
  role(actor, ...READ_ROLES);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.warehouse_id) {
    params.push(z.uuid().parse(filters.warehouse_id));
    conds.push(`warehouse_id = $${params.length}`);
  }
  if (filters.shift_date) {
    params.push(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(filters.shift_date));
    conds.push(`shift_date = $${params.length}::date`);
  }
  if (filters.user_id) {
    params.push(z.uuid().parse(filters.user_id));
    conds.push(`user_id = $${params.length}`);
  }
  const where = conds.length ? `where ${conds.join(" and ")}` : "";
  const { rows } = await db.query(
    `select id, warehouse_id, user_id, workstation_id, shift_date::text as shift_date,
            shift_code, start_time, end_time, available_minutes, role_scope, status, notes, updated_at
     from staff_work_shifts
     ${where}
     order by shift_date desc, start_time, shift_code`,
    params,
  );
  return { shifts: rows };
}

export async function upsertStaffShift(
  db: DB,
  actor: Actor,
  input: z.infer<typeof staffShiftUpsertSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  const wh = await one<{ id: string; status: string }>(
    db,
    "select id, status from warehouses where id = $1 for share",
    [input.warehouse_id],
  );
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot schedule shifts in an archived warehouse.", 409);
  await assertWorkstationActiveInWarehouse(db, input.workstation_id, input.warehouse_id);

  const staff = await one<{
    id: string;
    status: string;
    employment_status: string | null;
    account_security_status: string | null;
    allowed_warehouse_ids: string[] | null;
  }>(
    db,
    `select u.id, u.status, sp.employment_status, sp.account_security_status, sp.allowed_warehouse_ids
     from users u
     join staff_roles sr on sr.user_id = u.id
     left join staff_profiles sp on sp.user_id = u.id
     where u.id = $1 limit 1`,
    [input.user_id],
  );
  guard(staff.status === "active", "STAFF_INACTIVE", "Cannot schedule shift for an inactive staff user.", 409);
  if (staff.employment_status !== null) {
    guard(
      staff.employment_status === "active" && staff.account_security_status === "active",
      "STAFF_UNAVAILABLE",
      "Staff employment or security status is not active.",
      409,
    );
  }
  if (staff.allowed_warehouse_ids && staff.allowed_warehouse_ids.length > 0) {
    guard(
      staff.allowed_warehouse_ids.includes(input.warehouse_id),
      "WAREHOUSE_SCOPE_FORBIDDEN",
      "Staff is not scoped to this warehouse.",
      403,
    );
  }

  const row = await one(
    db,
    `insert into staff_work_shifts(
       id, warehouse_id, user_id, workstation_id, shift_date, shift_code,
       start_time, end_time, available_minutes, role_scope, status, notes, created_by, updated_at
     ) values($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10::text[], $11, $12, $13, now())
     on conflict (warehouse_id, user_id, shift_date, shift_code) do update
       set workstation_id = excluded.workstation_id,
           start_time = excluded.start_time,
           end_time = excluded.end_time,
           available_minutes = excluded.available_minutes,
           role_scope = excluded.role_scope,
           status = excluded.status,
           notes = excluded.notes,
           updated_at = now()
     returning id, warehouse_id, user_id, workstation_id, shift_date::text as shift_date,
               shift_code, start_time, end_time, available_minutes, role_scope, status, notes`,
    [
      uuid(),
      input.warehouse_id,
      input.user_id,
      input.workstation_id ?? null,
      input.shift_date,
      input.shift_code.toUpperCase(),
      input.start_time,
      input.end_time,
      input.available_minutes,
      [...new Set(input.role_scope)],
      input.status,
      input.notes ?? null,
      actor.id,
    ],
  );
  await audit(db, actor, "staff_shift_upserted", "staff_work_shifts", row.id as string, {
    user_id: input.user_id,
    shift_date: input.shift_date,
    status: input.status,
  });
  return { shift: row };
}

export async function updateStaffShiftStatus(
  db: DB,
  actor: Actor,
  shiftId: string,
  input: z.infer<typeof staffShiftStatusSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  const existing = await one<{ id: string; status: string }>(
    db,
    "select id, status from staff_work_shifts where id = $1 for update",
    [shiftId],
  );
  const updated = await one(
    db,
    `update staff_work_shifts set status = $2, notes = coalesce($3, notes), updated_at = now()
     where id = $1
     returning id, warehouse_id, user_id, shift_date::text as shift_date, shift_code, status, notes`,
    [shiftId, input.status, input.notes ?? null],
  );
  await audit(db, actor, "staff_shift_status_updated", "staff_work_shifts", shiftId, {
    from: existing.status,
    to: input.status,
  });
  return { shift: updated };
}

async function assertInspectionTaskGatesOpen(db: DB, inspectionTaskId: string) {
  const task = await one<{
    id: string;
    state: string;
    assignment_id: string | null;
    group_id: string | null;
    order_id: string;
    order_state: string;
  }>(
    db,
    `select t.id, t.state, t.assignment_id, t.group_id, l.order_id, o.state as order_state
     from inspection_tasks t
     join order_lines l on l.id = t.order_line_id
     join orders o on o.id = l.order_id
     where t.id = $1 for update of t`,
    [inspectionTaskId],
  );
  guard(
    ["READY", "IN_PROGRESS"].includes(task.state),
    "INSPECTION_TASK_UNAVAILABLE",
    `Inspection task in state '${task.state}' cannot be dispatched.`,
    409,
  );
  guard(
    ["queued", "inspecting"].includes(task.order_state),
    "ORDER_GATE_UNSATISFIED",
    "Order must be paid and queued/inspecting before task dispatch (manual dispatch cannot bypass payment gates).",
    409,
  );
  const blocked = await db.query(
    "select 1 from order_blocks where order_id = $1 and resolved_at is null limit 1",
    [task.order_id],
  );
  guard(blocked.rowCount === 0, "ORDER_BLOCKED", "Order has unresolved blocks and cannot be dispatched.", 409);

  const itemIds = task.group_id
    ? (
        await db.query<{ item_id: string }>(
          `select l.item_id
           from group_members gm
           join order_line_item_links l on l.id = gm.assignment_id
           where gm.group_id = $1 and l.unlinked_at is null`,
          [task.group_id],
        )
      ).rows.map((r) => r.item_id)
    : task.assignment_id
      ? (
          await db.query<{ item_id: string }>(
            "select item_id from order_line_item_links where id = $1 and unlinked_at is null",
            [task.assignment_id],
          )
        ).rows.map((r) => r.item_id)
      : [];
  await assertItemsOutsideQuarantine(db, itemIds, "ITEM_QUARANTINED");
  return task;
}

async function assertDispatchGatesOpen(db: DB, warehouseId: string, inspectionTaskId: string | null) {
  const wh = await one<{ id: string; status: string; allow_fulfillment: boolean }>(
    db,
    "select id, status, allow_fulfillment from warehouses where id = $1 for share",
    [warehouseId],
  );
  guard(wh.status === "active" && wh.allow_fulfillment, "WAREHOUSE_UNAVAILABLE", "Warehouse is not active for fulfillment dispatch.", 409);
  if (inspectionTaskId) {
    await assertInspectionTaskGatesOpen(db, inspectionTaskId);
  }
}

export async function registerDispatchWorkItem(
  db: DB,
  actor: Actor,
  input: z.infer<typeof workItemRegisterSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  let resolvedTaskId: string | null = input.inspection_task_id ?? null;
  if (input.task_domain === "inspection") {
    const parsedSource = z.uuid().parse(input.source_entity_id);
    if (resolvedTaskId && resolvedTaskId !== parsedSource) {
      guard(false, "SOURCE_TASK_MISMATCH", "source_entity_id must match inspection_task_id for inspection domain.", 422);
    }
    resolvedTaskId = resolvedTaskId ?? parsedSource;
  }

  await assertDispatchGatesOpen(db, input.warehouse_id, resolvedTaskId);

  if (resolvedTaskId) {
    await db.query(
      `update inspection_tasks
       set warehouse_id = $2,
           priority = $3,
           required_skill_code = coalesce($4, required_skill_code)
       where id = $1`,
      [resolvedTaskId, input.warehouse_id, input.priority, input.required_skill_code ?? null],
    );
  }

  const existing = await db.query(
    "select 1 from dispatch_work_items where task_domain = $1 and source_entity_id = $2",
    [input.task_domain, input.source_entity_id],
  );
  guard(existing.rowCount === 0, "WORK_ITEM_ALREADY_EXISTS", "Dispatch work item already registered.", 409);

  const item = await one(
    db,
    `insert into dispatch_work_items(
       id, warehouse_id, task_domain, source_entity_id, inspection_task_id,
       required_role, required_skill_code, priority, sla_due_at, created_by
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id, warehouse_id, task_domain, source_entity_id, inspection_task_id,
               required_role, required_skill_code, priority, dispatch_status, execution_generation`,
    [
      uuid(),
      input.warehouse_id,
      input.task_domain,
      input.source_entity_id,
      resolvedTaskId,
      input.required_role,
      input.required_skill_code ?? null,
      input.priority,
      input.sla_due_at ?? null,
      actor.id,
    ],
  );
  await audit(db, actor, "dispatch_work_item_registered", "dispatch_work_items", item.id as string, {
    task_domain: input.task_domain,
    source_entity_id: input.source_entity_id,
  });
  return { work_item: item };
}

export async function listDispatchWorkItems(
  db: Pick<DB, "query">,
  actor: Actor,
  filters: { warehouse_id?: string; task_domain?: string; dispatch_status?: string; assignee_id?: string },
) {
  role(actor, ...READ_ROLES);
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.warehouse_id) {
    params.push(z.uuid().parse(filters.warehouse_id));
    conds.push(`warehouse_id = $${params.length}`);
  }
  if (filters.task_domain) {
    params.push(z.enum(TASK_DOMAINS).parse(filters.task_domain));
    conds.push(`task_domain = $${params.length}`);
  }
  if (filters.dispatch_status) {
    params.push(filters.dispatch_status);
    conds.push(`dispatch_status = $${params.length}`);
  }
  if (filters.assignee_id) {
    params.push(z.uuid().parse(filters.assignee_id));
    conds.push(`current_assignee_id = $${params.length}`);
  }
  const where = conds.length ? `where ${conds.join(" and ")}` : "";
  const { rows } = await db.query(
    `select id, warehouse_id, task_domain, source_entity_id, inspection_task_id,
            required_role, required_skill_code, priority, dispatch_status,
            planned_assignee_id, current_assignee_id, workstation_id, execution_generation,
            paused_at, pause_reason, sla_due_at, updated_at
     from dispatch_work_items
     ${where}
     order by priority asc, created_at asc`,
    params,
  );
  return { work_items: rows };
}

async function syncInspectionTaskDispatch(
  db: DB,
  params: {
    inspectionTaskId: string | null;
    warehouseId?: string;
    plannedAssigneeId?: string | null;
    assigneeId?: string | null;
    workstationId?: string | null;
    executionGeneration?: number;
    pausedAt?: Date | null;
    pauseReason?: string | null;
    bumpRevision?: boolean;
  },
) {
  if (!params.inspectionTaskId) return;
  await db.query(
    `update inspection_tasks
     set warehouse_id = coalesce($2, warehouse_id),
         planned_assignee_id = case when $3::boolean then $4 else planned_assignee_id end,
         assignee_id = case when $5::boolean then $6 else assignee_id end,
         workstation_id = case when $7::boolean then $8 else workstation_id end,
         execution_generation = coalesce($9, execution_generation),
         paused_at = case when $10::boolean then $11 else paused_at end,
         pause_reason = case when $10::boolean then $12 else pause_reason end,
         revision = case when $13::boolean then revision + 1 else revision end
     where id = $1`,
    [
      params.inspectionTaskId,
      params.warehouseId ?? null,
      params.plannedAssigneeId !== undefined,
      params.plannedAssigneeId ?? null,
      params.assigneeId !== undefined,
      params.assigneeId ?? null,
      params.workstationId !== undefined,
      params.workstationId ?? null,
      params.executionGeneration ?? null,
      params.pausedAt !== undefined,
      params.pausedAt ?? null,
      params.pauseReason ?? null,
      Boolean(params.bumpRevision),
    ],
  );
}

export async function assignWorkItem(
  db: DB,
  actor: Actor,
  workItemId: string,
  input: z.infer<typeof workItemAssignSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  await lock(db, `work-item:${workItemId}`);
  const wi = await one<{
    id: string;
    warehouse_id: string;
    task_domain: (typeof TASK_DOMAINS)[number];
    inspection_task_id: string | null;
    required_role: string;
    required_skill_code: string | null;
    dispatch_status: string;
    planned_assignee_id: string | null;
    current_assignee_id: string | null;
    workstation_id: string | null;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, task_domain, inspection_task_id, required_role, required_skill_code,
            dispatch_status, planned_assignee_id, current_assignee_id, workstation_id, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [workItemId],
  );
  guard(
    !["completed", "cancelled", "handover_pending"].includes(wi.dispatch_status),
    "WORK_ITEM_NOT_ASSIGNABLE",
    `Work item in status '${wi.dispatch_status}' cannot be directly assigned.`,
    409,
  );
  await assertDispatchGatesOpen(db, wi.warehouse_id, wi.inspection_task_id);
  const resolvedWorkstation = input.workstation_id ?? wi.workstation_id;
  await assertWorkstationActiveInWarehouse(db, resolvedWorkstation, wi.warehouse_id, wi.task_domain);
  await assertAssigneeEligible(db, {
    userId: input.assignee_id,
    warehouseId: wi.warehouse_id,
    requiredRole: wi.required_role,
    requiredSkillCode: wi.required_skill_code,
  });

  const plannedAssignee = wi.planned_assignee_id ?? input.assignee_id;
  const nextGeneration = wi.current_assignee_id && wi.current_assignee_id !== input.assignee_id
    ? wi.execution_generation + 1
    : wi.execution_generation;

  await db.query(
    `update task_execution_leases
     set status = 'revoked', ended_at = now(), end_reason = 'reassigned_by_admin'
     where work_item_id = $1 and status = 'active'`,
    [wi.id],
  );

  const updated = await one(
    db,
    `update dispatch_work_items
     set planned_assignee_id = $2,
         current_assignee_id = $3,
         workstation_id = $4,
         dispatch_status = 'assigned',
         paused_at = null,
         pause_reason = null,
         execution_generation = $5,
         updated_at = now()
     where id = $1
     returning id, warehouse_id, dispatch_status, planned_assignee_id, current_assignee_id, workstation_id, execution_generation`,
    [wi.id, plannedAssignee, input.assignee_id, resolvedWorkstation, nextGeneration],
  );

  await syncInspectionTaskDispatch(db, {
    inspectionTaskId: wi.inspection_task_id,
    warehouseId: wi.warehouse_id,
    plannedAssigneeId: plannedAssignee,
    assigneeId: input.assignee_id,
    workstationId: resolvedWorkstation,
    executionGeneration: nextGeneration,
    pausedAt: null,
    pauseReason: null,
    bumpRevision: true,
  });

  await db.query(
    `insert into task_handovers(
       id, work_item_id, from_user_id, to_user_id, from_workstation_id, to_workstation_id,
       from_generation, to_generation, handover_type, reason, initiated_by, accepted_by, accepted_at, status
     ) values($1, $2, $3, $4, $5, $6, $7, $8, 'assign', $9, $10, $10, now(), 'accepted')`,
    [
      uuid(),
      wi.id,
      wi.current_assignee_id,
      input.assignee_id,
      wi.workstation_id,
      input.workstation_id ?? wi.workstation_id,
      wi.execution_generation,
      nextGeneration,
      input.reason,
      actor.id,
    ],
  );

  await emitDispatchInboxNotification(db, {
    template: "task.assigned",
    recipientUserIds: [input.assignee_id],
    dedupePrefix: `task.assigned:${wi.id}:${nextGeneration}:${uuid()}`,
    payload: {
      work_item_id: wi.id,
      warehouse_id: wi.warehouse_id,
      assignee_id: input.assignee_id,
      execution_generation: nextGeneration,
      reason: input.reason,
    },
  });
  await audit(db, actor, "dispatch_work_item_assigned", "dispatch_work_items", wi.id, {
    assignee_id: input.assignee_id,
    execution_generation: nextGeneration,
  });

  return { work_item: updated };
}

export async function claimTaskLease(
  db: DB,
  actor: Actor,
  workItemId: string,
  input: z.infer<typeof taskLeaseClaimSchema>,
) {
  role(actor, ...READ_ROLES);
  await lock(db, `work-item:${workItemId}`);
  const wi = await one<{
    id: string;
    warehouse_id: string;
    task_domain: (typeof TASK_DOMAINS)[number];
    inspection_task_id: string | null;
    required_role: string;
    required_skill_code: string | null;
    dispatch_status: string;
    current_assignee_id: string | null;
    workstation_id: string | null;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, task_domain, inspection_task_id, required_role, required_skill_code,
            dispatch_status, current_assignee_id, workstation_id, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [workItemId],
  );
  guard(
    !["paused", "handover_pending", "completed", "cancelled"].includes(wi.dispatch_status),
    "WORK_ITEM_NOT_CLAIMABLE",
    `Work item in status '${wi.dispatch_status}' cannot issue an execution lease.`,
    409,
  );
  if (wi.current_assignee_id && wi.current_assignee_id !== actor.id) {
    guard(false, "ASSIGNED_TO_OTHER_STAFF", "Work item is assigned to a different operator.", 403);
  }
  await assertDispatchGatesOpen(db, wi.warehouse_id, wi.inspection_task_id);
  await assertWorkstationActiveInWarehouse(db, input.workstation_id ?? wi.workstation_id, wi.warehouse_id, wi.task_domain);
  await assertAssigneeEligible(db, {
    userId: actor.id,
    warehouseId: wi.warehouse_id,
    requiredRole: wi.required_role,
    requiredSkillCode: wi.required_skill_code,
  });

  await db.query(
    `update task_execution_leases
     set status = 'expired', ended_at = now(), end_reason = 'ttl_expired'
     where work_item_id = $1 and status = 'active' and expires_at <= now()`,
    [wi.id],
  );

  const activeLease = await db.query(
    "select id from task_execution_leases where work_item_id = $1 and status = 'active'",
    [wi.id],
  );
  guard(activeLease.rowCount === 0, "TASK_LEASE_BUSY", "Work item already has an active execution lease.", 409);

  const rawLeaseToken = randomBytes(24).toString("base64url");
  const lease = await one(
    db,
    `insert into task_execution_leases(
       id, work_item_id, holder_user_id, workstation_id, execution_generation,
       lease_token_hash, status, expires_at, last_heartbeat_at
     ) values($1, $2, $3, $4, $5, $6, 'active', now() + make_interval(mins => $7), now())
     returning id, work_item_id, holder_user_id, workstation_id, execution_generation, status, granted_at, expires_at`,
    [
      uuid(),
      wi.id,
      actor.id,
      input.workstation_id ?? wi.workstation_id,
      wi.execution_generation,
      hash(rawLeaseToken),
      input.duration_minutes,
    ],
  );

  await db.query(
    `update dispatch_work_items
     set current_assignee_id = $2,
         workstation_id = coalesce($3, workstation_id),
         dispatch_status = 'in_progress',
         updated_at = now()
     where id = $1`,
    [wi.id, actor.id, input.workstation_id ?? null],
  );
  await syncInspectionTaskDispatch(db, {
    inspectionTaskId: wi.inspection_task_id,
    warehouseId: wi.warehouse_id,
    assigneeId: actor.id,
    workstationId: input.workstation_id ?? wi.workstation_id,
    executionGeneration: wi.execution_generation,
  });

  await audit(db, actor, "task_lease_claimed", "task_execution_leases", lease.id as string, {
    work_item_id: wi.id,
    execution_generation: wi.execution_generation,
  });
  return { lease, lease_token: rawLeaseToken, execution_generation: wi.execution_generation };
}

export async function pauseWorkItem(
  db: DB,
  actor: Actor,
  workItemId: string,
  input: z.infer<typeof workItemPauseSchema>,
) {
  role(actor, ...READ_ROLES);
  await lock(db, `work-item:${workItemId}`);
  const wi = await one<{
    id: string;
    warehouse_id: string;
    inspection_task_id: string | null;
    dispatch_status: string;
    current_assignee_id: string | null;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, inspection_task_id, dispatch_status, current_assignee_id, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [workItemId],
  );
  const isAdmin = ADMIN_ROLES.some((r) => actor.roles.includes(r));
  guard(isAdmin || wi.current_assignee_id === actor.id, "FORBIDDEN", "Only supervisor or assignee can pause this work item.", 403);
  guard(!["paused", "completed", "cancelled"].includes(wi.dispatch_status), "WORK_ITEM_NOT_PAUSABLE", "Work item is already paused or terminal.", 409);

  const nextGeneration = wi.execution_generation + 1;
  await db.query(
    `update task_execution_leases
     set status = 'paused', ended_at = now(), end_reason = $2
     where work_item_id = $1 and status = 'active'`,
    [wi.id, input.reason],
  );
  const updated = await one(
    db,
    `update dispatch_work_items
     set dispatch_status = 'paused',
         paused_at = now(),
         pause_reason = $2,
         execution_generation = $3,
         updated_at = now()
     where id = $1
     returning id, dispatch_status, paused_at, pause_reason, execution_generation`,
    [wi.id, input.reason, nextGeneration],
  );
  await syncInspectionTaskDispatch(db, {
    inspectionTaskId: wi.inspection_task_id,
    executionGeneration: nextGeneration,
    pausedAt: new Date(),
    pauseReason: input.reason,
  });
  await audit(db, actor, "dispatch_work_item_paused", "dispatch_work_items", wi.id, {
    reason: input.reason,
    execution_generation: nextGeneration,
  });
  return { work_item: updated };
}

export async function resumeWorkItem(db: DB, actor: Actor, workItemId: string) {
  role(actor, ...READ_ROLES);
  await lock(db, `work-item:${workItemId}`);
  const wi = await one<{
    id: string;
    warehouse_id: string;
    inspection_task_id: string | null;
    required_role: string;
    required_skill_code: string | null;
    dispatch_status: string;
    current_assignee_id: string | null;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, inspection_task_id, required_role, required_skill_code,
            dispatch_status, current_assignee_id, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [workItemId],
  );
  const isAdmin = ADMIN_ROLES.some((r) => actor.roles.includes(r));
  guard(isAdmin || wi.current_assignee_id === actor.id, "FORBIDDEN", "Only supervisor or assignee can resume this work item.", 403);
  guard(wi.dispatch_status === "paused", "WORK_ITEM_NOT_PAUSED", "Work item is not paused.", 409);
  await assertDispatchGatesOpen(db, wi.warehouse_id, wi.inspection_task_id);

  if (wi.current_assignee_id) {
    await assertAssigneeEligible(db, {
      userId: wi.current_assignee_id,
      warehouseId: wi.warehouse_id,
      requiredRole: wi.required_role,
      requiredSkillCode: wi.required_skill_code,
    });
  }
  const nextStatus = wi.current_assignee_id ? "assigned" : "queued";
  const updated = await one(
    db,
    `update dispatch_work_items
     set dispatch_status = $2, paused_at = null, pause_reason = null, updated_at = now()
     where id = $1
     returning id, dispatch_status, current_assignee_id, execution_generation`,
    [wi.id, nextStatus],
  );
  await syncInspectionTaskDispatch(db, {
    inspectionTaskId: wi.inspection_task_id,
    pausedAt: null,
    pauseReason: null,
  });
  await audit(db, actor, "dispatch_work_item_resumed", "dispatch_work_items", wi.id, { next_status: nextStatus });
  return { work_item: updated };
}

export async function initiateTaskHandover(
  db: DB,
  actor: Actor,
  workItemId: string,
  input: z.infer<typeof handoverInitiateSchema>,
) {
  role(actor, ...READ_ROLES);
  await lock(db, `work-item:${workItemId}`);
  const wi = await one<{
    id: string;
    warehouse_id: string;
    inspection_task_id: string | null;
    required_role: string;
    required_skill_code: string | null;
    dispatch_status: string;
    current_assignee_id: string | null;
    workstation_id: string | null;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, inspection_task_id, required_role, required_skill_code,
            dispatch_status, current_assignee_id, workstation_id, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [workItemId],
  );
  const isAdmin = ADMIN_ROLES.some((r) => actor.roles.includes(r));
  guard(
    isAdmin || (input.handover_type === "relay" && wi.current_assignee_id === actor.id),
    "FORBIDDEN",
    "Only supervisor or current assignee (relay) can initiate handover.",
    403,
  );
  guard(
    !["completed", "cancelled", "handover_pending"].includes(wi.dispatch_status),
    "HANDOVER_NOT_ALLOWED",
    `Cannot initiate handover from status '${wi.dispatch_status}'.`,
    409,
  );
  guard(input.to_user_id !== wi.current_assignee_id, "HANDOVER_SAME_USER", "Handover target must differ from current assignee.", 422);

  await assertWorkstationActiveInWarehouse(db, input.to_workstation_id, wi.warehouse_id);
  await assertAssigneeEligible(db, {
    userId: input.to_user_id,
    warehouseId: wi.warehouse_id,
    requiredRole: wi.required_role,
    requiredSkillCode: wi.required_skill_code,
  });

  const savedResultsCount = wi.inspection_task_id
    ? (
        await db.query<{ count: string }>(
          "select count(*)::text count from inspection_results where task_id = $1",
          [wi.inspection_task_id],
        )
      ).rows[0]?.count ?? "0"
    : "0";

  const nextGeneration = wi.execution_generation + 1;
  const endedLeases = (
    await db.query<{ id: string; holder_user_id: string }>(
      `update task_execution_leases
       set status = 'handed_over', ended_at = now(), end_reason = $2
       where work_item_id = $1 and status = 'active'
       returning id, holder_user_id`,
      [wi.id, `handover:${input.handover_type}`],
    )
  ).rows;

  const preflightSnapshot = {
    previous_assignee_id: wi.current_assignee_id,
    previous_workstation_id: wi.workstation_id,
    previous_generation: wi.execution_generation,
    saved_inspection_results_count: Number(savedResultsCount),
    ended_active_lease_ids: endedLeases.map((l) => l.id),
  };

  const handover = await one(
    db,
    `insert into task_handovers(
       id, work_item_id, from_user_id, to_user_id, from_workstation_id, to_workstation_id,
       from_generation, to_generation, handover_type, reason, preflight_snapshot, initiated_by, status
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'pending_acceptance')
     returning id, work_item_id, from_user_id, to_user_id, from_generation, to_generation, handover_type, status, preflight_snapshot`,
    [
      uuid(),
      wi.id,
      wi.current_assignee_id,
      input.to_user_id,
      wi.workstation_id,
      input.to_workstation_id ?? wi.workstation_id,
      wi.execution_generation,
      nextGeneration,
      input.handover_type,
      input.reason,
      JSON.stringify(preflightSnapshot),
      actor.id,
    ],
  );

  await db.query(
    `update dispatch_work_items
     set dispatch_status = 'handover_pending',
         paused_at = now(),
         pause_reason = $2,
         execution_generation = $3,
         updated_at = now()
     where id = $1`,
    [wi.id, `Handover pending: ${input.reason}`, nextGeneration],
  );
  await syncInspectionTaskDispatch(db, {
    inspectionTaskId: wi.inspection_task_id,
    executionGeneration: nextGeneration,
    pausedAt: new Date(),
    pauseReason: `Handover pending: ${input.reason}`,
  });

  await emitDispatchInboxNotification(db, {
    template: "task.handover_requested",
    recipientUserIds: [input.to_user_id, ...(wi.current_assignee_id ? [wi.current_assignee_id] : [])],
    dedupePrefix: `task.handover_requested:${handover.id}`,
    payload: {
      handover_id: handover.id,
      work_item_id: wi.id,
      from_user_id: wi.current_assignee_id,
      to_user_id: input.to_user_id,
      to_generation: nextGeneration,
      reason: input.reason,
    },
  });
  await audit(db, actor, "task_handover_initiated", "task_handovers", handover.id as string, {
    work_item_id: wi.id,
    to_user_id: input.to_user_id,
    to_generation: nextGeneration,
  });

  return { handover };
}

export async function acceptTaskHandover(
  db: DB,
  actor: Actor,
  handoverId: string,
  input: z.infer<typeof handoverAcceptSchema>,
) {
  role(actor, ...READ_ROLES);
  const snap = await one<{ id: string; work_item_id: string }>(
    db,
    "select id, work_item_id from task_handovers where id = $1",
    [handoverId],
  );
  await lock(db, `work-item:${snap.work_item_id}`);

  const wi = await one<{
    id: string;
    warehouse_id: string;
    inspection_task_id: string | null;
    required_role: string;
    required_skill_code: string | null;
    dispatch_status: string;
    workstation_id: string | null;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, inspection_task_id, required_role, required_skill_code,
            dispatch_status, workstation_id, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [snap.work_item_id],
  );
  const ho = await one<{
    id: string;
    from_user_id: string | null;
    to_user_id: string;
    to_workstation_id: string | null;
    handover_type: string;
    status: string;
  }>(
    db,
    "select id, from_user_id, to_user_id, to_workstation_id, handover_type, status from task_handovers where id = $1 for update",
    [handoverId],
  );
  guard(ho.status === "pending_acceptance" && wi.dispatch_status === "handover_pending", "HANDOVER_NOT_PENDING", "Handover is not awaiting acceptance.", 409);

  const isAdmin = ADMIN_ROLES.some((r) => actor.roles.includes(r));
  guard(
    ho.to_user_id === actor.id || (ho.handover_type === "emergency_takeover" && isAdmin),
    "FORBIDDEN",
    "Only the designated target operator can accept this handover.",
    403,
  );

  await assertDispatchGatesOpen(db, wi.warehouse_id, wi.inspection_task_id);
  await assertWorkstationActiveInWarehouse(db, ho.to_workstation_id, wi.warehouse_id);
  await assertAssigneeEligible(db, {
    userId: ho.to_user_id,
    warehouseId: wi.warehouse_id,
    requiredRole: wi.required_role,
    requiredSkillCode: wi.required_skill_code,
  });

  await db.query(
    `update task_handovers
     set status = 'accepted', accepted_by = $2, accepted_at = now()
     where id = $1`,
    [ho.id, actor.id],
  );

  const updatedWi = await one(
    db,
    `update dispatch_work_items
     set current_assignee_id = $2,
         workstation_id = coalesce($3, workstation_id),
         dispatch_status = 'assigned',
         paused_at = null,
         pause_reason = null,
         updated_at = now()
     where id = $1
     returning id, dispatch_status, current_assignee_id, workstation_id, execution_generation`,
    [wi.id, ho.to_user_id, ho.to_workstation_id],
  );

  // NOTE: Intentionally NEVER touches historical inspection_results.recorded_by
  await syncInspectionTaskDispatch(db, {
    inspectionTaskId: wi.inspection_task_id,
    assigneeId: ho.to_user_id,
    workstationId: ho.to_workstation_id ?? wi.workstation_id,
    pausedAt: null,
    pauseReason: null,
  });
  if (wi.inspection_task_id) {
    await db.query("update inspection_tasks set revision = revision + 1 where id = $1", [wi.inspection_task_id]);
  }

  await emitDispatchInboxNotification(db, {
    template: "task.handed_over",
    recipientUserIds: [ho.to_user_id, ...(ho.from_user_id ? [ho.from_user_id] : [])],
    dedupePrefix: `task.handed_over:${ho.id}`,
    payload: {
      handover_id: ho.id,
      work_item_id: wi.id,
      from_user_id: ho.from_user_id,
      to_user_id: ho.to_user_id,
      execution_generation: wi.execution_generation,
      notes: input.notes ?? null,
    },
  });
  await audit(db, actor, "task_handover_accepted", "task_handovers", ho.id, {
    work_item_id: wi.id,
    to_user_id: ho.to_user_id,
    execution_generation: wi.execution_generation,
  });

  return { work_item: updatedWi, handover_id: ho.id };
}

export async function cancelTaskHandover(
  db: DB,
  actor: Actor,
  handoverId: string,
  input: z.infer<typeof handoverCancelSchema>,
) {
  role(actor, ...READ_ROLES);
  const snap = await one<{ id: string; work_item_id: string }>(
    db,
    "select id, work_item_id from task_handovers where id = $1",
    [handoverId],
  );
  await lock(db, `work-item:${snap.work_item_id}`);

  const wi = await one<{
    id: string;
    warehouse_id: string;
    inspection_task_id: string | null;
    required_role: string;
    required_skill_code: string | null;
    dispatch_status: string;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, inspection_task_id, required_role, required_skill_code,
            dispatch_status, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [snap.work_item_id],
  );
  const ho = await one<{
    id: string;
    from_user_id: string | null;
    to_user_id: string;
    from_workstation_id: string | null;
    initiated_by: string;
    status: string;
  }>(
    db,
    "select id, from_user_id, to_user_id, from_workstation_id, initiated_by, status from task_handovers where id = $1 for update",
    [handoverId],
  );
  guard(ho.status === "pending_acceptance" && wi.dispatch_status === "handover_pending", "HANDOVER_NOT_PENDING", "Handover is not pending.", 409);

  const isAdmin = ADMIN_ROLES.some((r) => actor.roles.includes(r));
  guard(
    isAdmin || ho.initiated_by === actor.id || ho.from_user_id === actor.id || ho.to_user_id === actor.id,
    "FORBIDDEN",
    "Only supervisor or handover participant can cancel this pending handover.",
    403,
  );

  await db.query(
    "update task_handovers set status = 'cancelled', accepted_by = $2, accepted_at = now() where id = $1",
    [ho.id, actor.id],
  );

  let restoreAssigneeId: string | null = null;
  if (ho.from_user_id) {
    try {
      await assertAssigneeEligible(db, {
        userId: ho.from_user_id,
        warehouseId: wi.warehouse_id,
        requiredRole: wi.required_role,
        requiredSkillCode: wi.required_skill_code,
      });
      restoreAssigneeId = ho.from_user_id;
    } catch {
      restoreAssigneeId = null;
    }
  }

  const nextStatus = restoreAssigneeId ? "assigned" : "queued";
  const nextGen = wi.execution_generation + 1;
  const updatedWi = await one(
    db,
    `update dispatch_work_items
     set current_assignee_id = $2,
         workstation_id = coalesce($3, workstation_id),
         dispatch_status = $4,
         paused_at = null,
         pause_reason = null,
         execution_generation = $5,
         updated_at = now()
     where id = $1
     returning id, dispatch_status, current_assignee_id, workstation_id, execution_generation`,
    [wi.id, restoreAssigneeId, ho.from_workstation_id, nextStatus, nextGen],
  );
  await syncInspectionTaskDispatch(db, {
    inspectionTaskId: wi.inspection_task_id,
    assigneeId: restoreAssigneeId,
    workstationId: ho.from_workstation_id,
    executionGeneration: nextGen,
    pausedAt: null,
    pauseReason: null,
    bumpRevision: true,
  });

  await emitDispatchInboxNotification(db, {
    template: "task.handover_cancelled",
    recipientUserIds: [ho.to_user_id, ...(ho.from_user_id ? [ho.from_user_id] : [])],
    dedupePrefix: `task.handover_cancelled:${ho.id}`,
    payload: {
      handover_id: ho.id,
      work_item_id: wi.id,
      cancelled_by: actor.id,
      reason: input.reason,
      restored_status: nextStatus,
    },
  });
  await audit(db, actor, "task_handover_cancelled", "task_handovers", ho.id, {
    reason: input.reason,
    restored_status: nextStatus,
  });

  return { work_item: updatedWi, handover_id: ho.id };
}

export async function revokeStaffActiveLeases(
  db: DB,
  actor: Actor,
  targetUserId: string,
  reason: string,
) {
  role(actor, ...ADMIN_ROLES);
  const active = (
    await db.query<{ id: string; work_item_id: string }>(
      `select id, work_item_id from task_execution_leases
       where holder_user_id = $1 and status = 'active'
       order by work_item_id`,
      [targetUserId],
    )
  ).rows;

  const revokedWorkItemIds: string[] = [];
  for (const row of active) {
    await lock(db, `work-item:${row.work_item_id}`);
    const wi = await one<{
      id: string;
      inspection_task_id: string | null;
      dispatch_status: string;
      execution_generation: number;
    }>(
      db,
      "select id, inspection_task_id, dispatch_status, execution_generation from dispatch_work_items where id = $1 for update",
      [row.work_item_id],
    );
    if (["completed", "cancelled"].includes(wi.dispatch_status)) continue;

    const leaseUpd = await db.query(
      `update task_execution_leases
       set status = 'revoked', ended_at = now(), end_reason = $2
       where id = $1 and status = 'active'
       returning id`,
      [row.id, reason],
    );
    if (leaseUpd.rowCount === 0) continue;

    const nextGen = wi.execution_generation + 1;
    await db.query(
      `update dispatch_work_items
       set dispatch_status = 'paused', paused_at = now(), pause_reason = $2, execution_generation = $3, updated_at = now()
       where id = $1`,
      [wi.id, reason, nextGen],
    );
    await syncInspectionTaskDispatch(db, {
      inspectionTaskId: wi.inspection_task_id,
      executionGeneration: nextGen,
      pausedAt: new Date(),
      pauseReason: reason,
    });
    revokedWorkItemIds.push(wi.id);
  }

  const adminIds = await resolveAdminUserIds(db);
  await emitDispatchInboxNotification(db, {
    template: "task.lease_revoked",
    recipientUserIds: [targetUserId, ...adminIds],
    dedupePrefix: `task.lease_revoked:${targetUserId}:${uuid()}`,
    payload: {
      target_user_id: targetUserId,
      revoked_work_item_ids: revokedWorkItemIds,
      reason,
      revoked_by: actor.id,
    },
  });
  await audit(db, actor, "staff_task_leases_revoked", "users", targetUserId, {
    revoked_count: revokedWorkItemIds.length,
    reason,
  });

  return { revoked_count: revokedWorkItemIds.length, revoked_work_item_ids: revokedWorkItemIds };
}

export async function submitEvidenceWithLease(
  db: DB,
  actor: Actor,
  input: z.infer<typeof evidenceSubmitWithLeaseSchema>,
) {
  role(actor, ...READ_ROLES);
  await lock(db, `work-item:${input.work_item_id}`);
  const wi = await one<{
    id: string;
    warehouse_id: string;
    inspection_task_id: string | null;
    dispatch_status: string;
    current_assignee_id: string | null;
    execution_generation: number;
  }>(
    db,
    `select id, warehouse_id, inspection_task_id, dispatch_status, current_assignee_id, execution_generation
     from dispatch_work_items where id = $1 for update`,
    [input.work_item_id],
  );

  if (input.device_id) {
    const dev = await one<{ id: string; warehouse_id: string }>(
      db,
      "select id, warehouse_id from warehouse_devices where id = $1",
      [input.device_id],
    );
    guard(dev.warehouse_id === wi.warehouse_id, "DEVICE_WAREHOUSE_MISMATCH", "Device does not belong to work item's warehouse.", 422);
  }

  const tokenHash = hash(input.lease_token);
  const matchingLease = (
    await db.query<{
      id: string;
      holder_user_id: string;
      execution_generation: number;
      status: string;
      is_expired: boolean;
      lease_token_hash: string;
    }>(
      `select id, holder_user_id, execution_generation, status, (expires_at <= now()) as is_expired, lease_token_hash
       from task_execution_leases
       where work_item_id = $1 and lease_token_hash = $2`,
      [wi.id, tokenHash],
    )
  ).rows[0];

  guard(
    matchingLease && matchingLease.holder_user_id === actor.id && safeHexEqual(matchingLease.lease_token_hash, tokenHash),
    "INVALID_TASK_LEASE_TOKEN",
    "Submitted lease token does not belong to caller for this work item.",
    403,
  );

  const isExpired = matchingLease.is_expired;
  const isCurrentActive =
    matchingLease.status === "active" &&
    !isExpired &&
    wi.dispatch_status === "in_progress" &&
    wi.current_assignee_id === actor.id &&
    matchingLease.execution_generation === wi.execution_generation &&
    input.execution_generation === wi.execution_generation;

  if (isCurrentActive) {
    return {
      accepted: true,
      quarantined: false,
      work_item_id: wi.id,
      execution_generation: wi.execution_generation,
    };
  }

  let reason = "STALE_EXECUTION_GENERATION";
  if (matchingLease.status === "handed_over") reason = "LATE_AFTER_HANDOVER";
  else if (matchingLease.status === "revoked") reason = "LATE_AFTER_REVOCATION";
  else if (matchingLease.status === "paused" || wi.dispatch_status === "paused") reason = "LATE_WHILE_PAUSED";
  else if (isExpired || matchingLease.status === "expired") reason = "LATE_AFTER_LEASE_EXPIRY";

  const quarantined = await one(
    db,
    `insert into late_evidence_quarantine(
       id, work_item_id, inspection_task_id, captured_by, device_id,
       submitted_generation, current_generation_at_receipt, evidence_sha256,
       item_key, component, payload, quarantine_reason
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     returning id, work_item_id, captured_by, submitted_generation, current_generation_at_receipt, quarantine_reason, resolution_status, created_at`,
    [
      uuid(),
      wi.id,
      wi.inspection_task_id,
      actor.id,
      input.device_id ?? null,
      input.execution_generation,
      wi.execution_generation,
      input.evidence_sha256.toLowerCase(),
      input.item_key ?? null,
      input.component ?? null,
      JSON.stringify(input.payload),
      reason,
    ],
  );

  const adminIds = await resolveAdminUserIds(db);
  await emitDispatchInboxNotification(db, {
    template: "task.late_evidence_quarantined",
    recipientUserIds: adminIds,
    dedupePrefix: `task.late_evidence_quarantined:${quarantined.id}`,
    payload: {
      quarantine_id: quarantined.id,
      work_item_id: wi.id,
      captured_by: actor.id,
      quarantine_reason: reason,
    },
  });
  await audit(db, actor, "late_evidence_quarantined", "late_evidence_quarantine", quarantined.id as string, {
    work_item_id: wi.id,
    reason,
  });

  return {
    accepted: false,
    quarantined: true,
    quarantine_id: quarantined.id,
    quarantine_reason: reason,
    record: quarantined,
  };
}

export async function listQuarantinedEvidence(
  db: Pick<DB, "query">,
  actor: Actor,
  workItemId?: string,
) {
  role(actor, "warehouse_admin", "super_admin", "reviewer");
  const params: unknown[] = [];
  let where = "";
  if (workItemId) {
    params.push(z.uuid().parse(workItemId));
    where = "where work_item_id = $1";
  }
  const { rows } = await db.query(
    `select id, work_item_id, inspection_task_id, captured_by, device_id,
            submitted_generation, current_generation_at_receipt, evidence_sha256,
            item_key, component, quarantine_reason, resolution_status, resolved_by, resolved_at, created_at
     from late_evidence_quarantine
     ${where}
     order by created_at desc`,
    params,
  );
  return { quarantined_evidence: rows };
}

export async function resolveQuarantinedEvidence(
  db: DB,
  actor: Actor,
  quarantineId: string,
  input: z.infer<typeof quarantineResolveSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  const existing = await one<{ id: string; captured_by: string; resolution_status: string; work_item_id: string }>(
    db,
    "select id, captured_by, resolution_status, work_item_id from late_evidence_quarantine where id = $1 for update",
    [quarantineId],
  );
  guard(existing.resolution_status === "quarantined", "ALREADY_RESOLVED", "Quarantined evidence was already resolved.", 409);

  // NOTE: captured_by is protected by trigger quarantine_author_immutable
  const updated = await one(
    db,
    `update late_evidence_quarantine
     set resolution_status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4
     where id = $1
     returning id, work_item_id, captured_by, resolution_status, resolved_by, resolved_at, resolution_note`,
    [quarantineId, input.resolution, actor.id, input.note],
  );
  await emitDispatchInboxNotification(db, {
    template: "task.quarantine_resolved",
    recipientUserIds: [existing.captured_by],
    dedupePrefix: `task.quarantine_resolved:${existing.id}`,
    payload: {
      quarantine_id: existing.id,
      work_item_id: existing.work_item_id,
      resolution: input.resolution,
      captured_by: existing.captured_by,
    },
  });
  await audit(db, actor, "late_evidence_resolved", "late_evidence_quarantine", existing.id, {
    resolution: input.resolution,
  });

  return { quarantined_evidence: updated };
}
