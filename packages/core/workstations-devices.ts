import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db";
import { audit, event, guard, hash, lock, one, role, uuid, type Actor } from "./common";
import { listStaffInbox, markStaffInboxRead } from "./communications";
import { recordRevocationTombstone } from "./media-center";

export const STATION_TYPES = ["A_receiving", "B_inspection_shoot", "C_pack_handover"] as const;
export const DEVICE_ROLES = ["camera", "scanner", "scale", "printer", "workstation_terminal"] as const;
export const OWNERSHIP_TYPES = ["warehouse_owned", "shared_terminal", "temp_mobile"] as const;
export const ACCESS_MODES = ["manual_first_approval", "preregistered_only", "controlled_self_register"] as const;

export const workstationCreateSchema = z.object({
  warehouse_id: z.uuid(),
  station_code: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9._-]+$/),
  station_type: z.enum(STATION_TYPES),
  name_zh: z.string().trim().min(1).max(120),
  name_en: z.string().trim().min(1).max(120),
  zone_id: z.uuid().nullable().optional(),
  required_device_roles: z.array(z.enum(DEVICE_ROLES)).max(10).default([]),
});

export const workstationStatusSchema = z.object({
  status: z.enum(["active", "maintenance", "disabled"]),
});

export const deviceAccessPolicySchema = z.object({
  warehouse_id: z.union([z.literal("*"), z.uuid()]).default("*"),
  mode: z.enum(ACCESS_MODES),
  allow_owner_self_confirm: z.boolean().default(false),
  max_lease_minutes: z.number().int().min(1).max(1440).default(480),
});

export const devicePreregisterSchema = z.object({
  warehouse_id: z.uuid(),
  workstation_id: z.uuid().nullable().optional(),
  device_code: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9._-]+$/),
  device_role: z.enum(DEVICE_ROLES),
  ownership_type: z.enum(OWNERSHIP_TYPES).default("warehouse_owned"),
  manufacturer: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(80).nullable().optional(),
  serial_number: z.string().trim().max(80).nullable().optional(),
  hardware_fingerprint: z.string().trim().min(8).max(200),
  capability_tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  spec_meta: z.record(z.string(), z.unknown()).default({}),
  calibration_due_at: z.string().datetime().nullable().optional(),
});

export const deviceRequestSchema = z.object({
  warehouse_id: z.uuid(),
  workstation_id: z.uuid().nullable().optional(),
  device_code: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9._-]+$/),
  device_role: z.enum(DEVICE_ROLES),
  ownership_type: z.enum(OWNERSHIP_TYPES).default("warehouse_owned"),
  hardware_fingerprint: z.string().trim().min(8).max(200),
  manufacturer: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(80).nullable().optional(),
  capability_tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  spec_meta: z.record(z.string(), z.unknown()).default({}),
});

export const deviceDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).nullable().optional(),
  confirm_owner_owned: z.boolean().default(false),
  calibration_due_at: z.string().datetime().nullable().optional(),
});

export const deviceRevokeSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

export const deviceHeartbeatSchema = z.object({
  device_code: z.string().trim().min(3).max(60),
  hardware_fingerprint: z.string().trim().min(8).max(200),
  device_secret: z.string().trim().min(12).max(200),
});

export const deviceLeaseClaimSchema = z.object({
  workstation_id: z.uuid().nullable().optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
});

export const deviceCalibrationOrFaultSchema = z.object({
  log_type: z.enum(["calibration", "maintenance", "fault_report", "fault_resolved"]),
  outcome: z.enum(["passed", "failed", "open", "resolved"]),
  measured_params: z.object({
    tare_g: z.number().nonnegative().optional(),
    gross_g: z.number().nonnegative().optional(),
    net_g: z.number().nonnegative().optional(),
    tolerance_g: z.number().nonnegative().optional(),
  }).catchall(z.unknown()).default({}),
  next_due_at: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const skillGrantSchema = z.object({
  user_id: z.uuid(),
  skill_code: z.string().trim().min(2).max(80).regex(/^[a-z0-9_.-]+$/),
  category_code: z.string().trim().min(1).max(60).nullable().optional(),
  service_code: z.string().trim().min(1).max(60).nullable().optional(),
  status: z.enum(["pending_exam", "active", "suspended"]).default("active"),
  valid_until: z.string().datetime().nullable().optional(),
  evidence_note: z.string().trim().max(500).nullable().optional(),
});

export const skillRevokeSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

export const sellabilityQuerySchema = z.object({
  warehouse_id: z.uuid(),
  required_device_roles: z.string().trim().optional(),
  required_skill_code: z.string().trim().min(2).max(80).optional(),
});

const READ_ROLES = ["receiver", "inspector", "reviewer", "warehouse_admin", "super_admin"] as const;
const ADMIN_ROLES = ["warehouse_admin", "super_admin"] as const;
const SKILL_ADMIN_ROLES = ["reviewer", "warehouse_admin", "super_admin"] as const;

function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function resolveAdminUserIds(db: Pick<DB, "query">, roles: readonly string[] = ADMIN_ROLES): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select distinct u.id
     from users u
     join staff_roles sr on sr.user_id = u.id
     left join staff_profiles sp on sp.user_id = u.id
     where u.status = 'active'
       and sr.role = any($1::text[])
       and (sp.user_id is null or (sp.employment_status = 'active' and sp.account_security_status = 'active'))
     order by u.id`,
    [roles],
  );
  return rows.map((r) => r.id);
}

async function emitInboxNotification(
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

async function getEffectiveAccessPolicy(db: Pick<DB, "query">, warehouseId: string) {
  const { rows } = await db.query<{
    warehouse_id: string;
    mode: (typeof ACCESS_MODES)[number];
    allow_owner_self_confirm: boolean;
    max_lease_minutes: number;
  }>(
    `select warehouse_id, mode, allow_owner_self_confirm, max_lease_minutes
     from device_access_policies
     where warehouse_id in ($1, '*')
     order by case when warehouse_id = $1 then 0 else 1 end
     limit 1`,
    [warehouseId],
  );
  return rows[0] ?? {
    warehouse_id: "*",
    mode: "manual_first_approval" as const,
    allow_owner_self_confirm: false,
    max_lease_minutes: 480,
  };
}

export async function listWorkstations(db: Pick<DB, "query">, actor: Actor, warehouseId?: string) {
  role(actor, ...READ_ROLES);
  const params: unknown[] = [];
  let where = "";
  if (warehouseId) {
    params.push(z.uuid().parse(warehouseId));
    where = "where w.warehouse_id = $1";
  }
  const { rows } = await db.query(
    `select w.id, w.warehouse_id, w.station_code, w.station_type, w.name_zh, w.name_en,
            w.zone_id, w.status, w.required_device_roles, w.created_at, w.updated_at
     from workstations w
     ${where}
     order by w.warehouse_id, w.station_type, w.station_code`,
    params,
  );
  return { workstations: rows };
}

export async function createWorkstation(
  db: DB,
  actor: Actor,
  input: z.infer<typeof workstationCreateSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  const wh = await one<{ id: string; status: string }>(
    db,
    "select id, status from warehouses where id = $1 for share",
    [input.warehouse_id],
  );
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot add workstation to an archived warehouse.", 409);

  if (input.zone_id) {
    const zone = await one<{ id: string; warehouse_id: string; status: string }>(
      db,
      "select id, warehouse_id, status from warehouse_zones where id = $1 for share",
      [input.zone_id],
    );
    guard(zone.warehouse_id === input.warehouse_id, "ZONE_WAREHOUSE_MISMATCH", "Zone does not belong to warehouse.", 422);
    guard(zone.status !== "disabled", "ZONE_DISABLED", "Cannot assign workstation to a disabled zone.", 409);
  }

  const existing = await db.query("select 1 from workstations where upper(station_code) = upper($1)", [input.station_code]);
  guard(existing.rowCount === 0, "STATION_CODE_EXISTS", "Workstation code already exists.", 409);

  const row = await one(
    db,
    `insert into workstations(
       id, warehouse_id, station_code, station_type, name_zh, name_en, zone_id, required_device_roles, created_by
     ) values($1, $2, $3, $4, $5, $6, $7, $8::text[], $9)
     returning id, warehouse_id, station_code, station_type, name_zh, name_en, zone_id, status, required_device_roles`,
    [
      uuid(),
      input.warehouse_id,
      input.station_code.toUpperCase(),
      input.station_type,
      input.name_zh,
      input.name_en,
      input.zone_id ?? null,
      [...new Set(input.required_device_roles)],
      actor.id,
    ],
  );
  await audit(db, actor, "workstation_created", "workstations", row.id as string, {
    station_code: row.station_code,
    station_type: row.station_type,
  });
  await event(db, "workstation.created", {
    workstation_id: row.id,
    warehouse_id: input.warehouse_id,
    station_type: input.station_type,
  });
  return { workstation: row };
}

export async function updateWorkstationStatus(
  db: DB,
  actor: Actor,
  stationId: string,
  input: z.infer<typeof workstationStatusSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  const existing = await one<{ id: string; status: string; warehouse_id: string }>(
    db,
    "select id, status, warehouse_id from workstations where id = $1 for update",
    [stationId],
  );
  const updated = await one(
    db,
    `update workstations set status = $2, updated_at = now()
     where id = $1
     returning id, warehouse_id, station_code, station_type, status, updated_at`,
    [stationId, input.status],
  );
  await audit(db, actor, "workstation_status_updated", "workstations", stationId, {
    from: existing.status,
    to: input.status,
  });
  return { workstation: updated };
}

export async function getDeviceAccessPolicy(db: Pick<DB, "query">, actor: Actor, warehouseId?: string) {
  role(actor, ...READ_ROLES);
  if (warehouseId && warehouseId !== "*") {
    return { policy: await getEffectiveAccessPolicy(db, z.uuid().parse(warehouseId)) };
  }
  const { rows } = await db.query(
    "select warehouse_id, mode, allow_owner_self_confirm, max_lease_minutes, updated_at from device_access_policies order by warehouse_id",
  );
  return { policies: rows };
}

export async function setDeviceAccessPolicy(
  db: DB,
  actor: Actor,
  input: z.infer<typeof deviceAccessPolicySchema>,
) {
  role(actor, "super_admin");
  if (input.warehouse_id !== "*") {
    await one(db, "select id from warehouses where id = $1 for share", [input.warehouse_id]);
  }
  const row = await one(
    db,
    `insert into device_access_policies(warehouse_id, mode, allow_owner_self_confirm, max_lease_minutes, updated_by, updated_at)
     values($1, $2, $3, $4, $5, now())
     on conflict (warehouse_id) do update
       set mode = excluded.mode,
           allow_owner_self_confirm = excluded.allow_owner_self_confirm,
           max_lease_minutes = excluded.max_lease_minutes,
           updated_by = excluded.updated_by,
           updated_at = now()
     returning warehouse_id, mode, allow_owner_self_confirm, max_lease_minutes, updated_at`,
    [input.warehouse_id, input.mode, input.allow_owner_self_confirm, input.max_lease_minutes, actor.id],
  );
  await audit(db, actor, "device_access_policy_updated", "device_access_policies", null, row);
  return { policy: row };
}

export async function listDevices(db: Pick<DB, "query">, actor: Actor, warehouseId?: string) {
  role(actor, ...READ_ROLES);
  const params: unknown[] = [];
  let where = "";
  if (warehouseId) {
    params.push(z.uuid().parse(warehouseId));
    where = "where d.warehouse_id = $1";
  }
  const { rows } = await db.query(
    `select d.id, d.device_code, d.warehouse_id, d.workstation_id, d.device_role, d.ownership_type,
            d.manufacturer, d.model, d.serial_number, d.approval_status, d.online_status,
            d.auth_generation, d.capability_tags, d.spec_meta, d.calibration_due_at,
            d.last_calibrated_at, d.registered_by, d.approved_by, d.approved_at,
            d.revoked_by, d.revoked_at, d.revocation_reason, d.created_at
     from warehouse_devices d
     ${where}
     order by d.created_at desc`,
    params,
  );
  return { devices: rows };
}

export async function listDeviceAuthRequests(db: Pick<DB, "query">, actor: Actor, warehouseId?: string) {
  role(actor, ...READ_ROLES);
  const params: unknown[] = [];
  let where = "";
  if (warehouseId) {
    params.push(z.uuid().parse(warehouseId));
    where = "where r.warehouse_id = $1";
  }
  const { rows } = await db.query(
    `select r.id, r.warehouse_id, r.workstation_id, r.device_id, r.device_code, r.device_role,
            r.ownership_type, r.requested_by, r.registration_mode, r.request_status,
            r.decision_by, r.decision_at, r.decision_note, r.created_at
     from device_authorization_requests r
     ${where}
     order by r.created_at desc`,
    params,
  );
  return { requests: rows };
}

async function assertWorkstationMatchesWarehouse(db: Pick<DB, "query">, workstationId: string | null | undefined, warehouseId: string) {
  if (!workstationId) return;
  const ws = await one<{ id: string; warehouse_id: string }>(
    db,
    "select id, warehouse_id from workstations where id = $1 for share",
    [workstationId],
  );
  guard(ws.warehouse_id === warehouseId, "WORKSTATION_WAREHOUSE_MISMATCH", "Workstation belongs to a different warehouse.", 422);
}

export async function preregisterDevice(
  db: DB,
  actor: Actor,
  input: z.infer<typeof devicePreregisterSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  const wh = await one<{ id: string; status: string }>(
    db,
    "select id, status from warehouses where id = $1 for share",
    [input.warehouse_id],
  );
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot register devices on an archived warehouse.", 409);
  await assertWorkstationMatchesWarehouse(db, input.workstation_id, input.warehouse_id);

  const fpHash = hash(input.hardware_fingerprint);
  const existing = await db.query(
    "select 1 from warehouse_devices where upper(device_code) = upper($1) or hardware_fingerprint_hash = $2",
    [input.device_code, fpHash],
  );
  guard(existing.rowCount === 0, "DEVICE_OR_FINGERPRINT_EXISTS", "Device code or hardware fingerprint is already registered.", 409);

  const device = await one(
    db,
    `insert into warehouse_devices(
       id, device_code, warehouse_id, workstation_id, device_role, ownership_type,
       manufacturer, model, serial_number, hardware_fingerprint_hash, approval_status,
       online_status, capability_tags, spec_meta, calibration_due_at, registered_by
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'preregistered', 'offline', $11::text[], $12::jsonb, $13, $14)
     returning id, device_code, warehouse_id, workstation_id, device_role, ownership_type, approval_status, online_status, auth_generation`,
    [
      uuid(),
      input.device_code.toUpperCase(),
      input.warehouse_id,
      input.workstation_id ?? null,
      input.device_role,
      input.ownership_type,
      input.manufacturer ?? null,
      input.model ?? null,
      input.serial_number ?? null,
      fpHash,
      [...new Set(input.capability_tags)],
      JSON.stringify(input.spec_meta),
      input.calibration_due_at ?? null,
      actor.id,
    ],
  );
  await audit(db, actor, "device_preregistered", "warehouse_devices", device.id as string, {
    device_code: device.device_code,
    device_role: device.device_role,
  });
  return { device };
}

export async function requestDeviceAuthorization(
  db: DB,
  actor: Actor,
  input: z.infer<typeof deviceRequestSchema>,
) {
  role(actor, ...READ_ROLES);
  const wh = await one<{ id: string; status: string }>(
    db,
    "select id, status from warehouses where id = $1 for share",
    [input.warehouse_id],
  );
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot request device authorization on an archived warehouse.", 409);
  await assertWorkstationMatchesWarehouse(db, input.workstation_id, input.warehouse_id);

  const fpHash = hash(input.hardware_fingerprint);
  const normalizedCode = input.device_code.toUpperCase();
  await lock(db, `device-request:${fpHash}`);

  const policy = await getEffectiveAccessPolicy(db, input.warehouse_id);
  const existing = (
    await db.query<{
      id: string;
      warehouse_id: string;
      device_code: string;
      device_role: string;
      ownership_type: string;
      hardware_fingerprint_hash: string;
      approval_status: string;
    }>(
      `select id, warehouse_id, device_code, device_role, ownership_type, hardware_fingerprint_hash, approval_status
       from warehouse_devices
       where hardware_fingerprint_hash = $1 or upper(device_code) = upper($2)
       for update`,
      [fpHash, normalizedCode],
    )
  ).rows;

  let deviceId: string;
  if (policy.mode === "preregistered_only") {
    const pre = existing.find((d) => d.approval_status === "preregistered" && d.warehouse_id === input.warehouse_id);
    guard(
      pre,
      "PREREGISTRATION_REQUIRED",
      "This warehouse policy permits preregistered devices only.",
      403,
    );
    guard(
      !existing.some((d) => d.id !== pre.id),
      "DEVICE_OR_FINGERPRINT_CONFLICT",
      "Hardware fingerprint or device code conflicts with an existing or revoked device.",
      409,
    );
    guard(
      safeHexEqual(pre.hardware_fingerprint_hash, fpHash),
      "PREREGISTERED_FINGERPRINT_MISMATCH",
      "Hardware fingerprint does not match the preregistered device.",
      409,
    );
    guard(
      pre.device_code.toUpperCase() === normalizedCode,
      "PREREGISTERED_CODE_MISMATCH",
      "Device code does not match the preregistered device.",
      409,
    );
    guard(
      pre.device_role === input.device_role,
      "PREREGISTERED_ROLE_MISMATCH",
      "Device role does not match the preregistered device.",
      422,
    );
    guard(
      pre.ownership_type === input.ownership_type,
      "PREREGISTERED_OWNERSHIP_MISMATCH",
      "Ownership type does not match the preregistered device.",
      422,
    );
    deviceId = pre.id;
    await db.query(
      "update warehouse_devices set approval_status = 'pending_approval', online_status = 'offline', updated_at = now() where id = $1",
      [deviceId],
    );
  } else {
    guard(existing.length === 0, "DEVICE_OR_FINGERPRINT_CONFLICT", "Device code or hardware fingerprint is already registered or revoked.", 409);
    const inserted = await one<{ id: string }>(
      db,
      `insert into warehouse_devices(
         id, device_code, warehouse_id, workstation_id, device_role, ownership_type,
         manufacturer, model, hardware_fingerprint_hash, approval_status, online_status,
         capability_tags, spec_meta, registered_by
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_approval', 'offline', $10::text[], $11::jsonb, $12)
       returning id`,
      [
        uuid(),
        normalizedCode,
        input.warehouse_id,
        input.workstation_id ?? null,
        input.device_role,
        input.ownership_type,
        input.manufacturer ?? null,
        input.model ?? null,
        fpHash,
        [...new Set(input.capability_tags)],
        JSON.stringify(input.spec_meta),
        actor.id,
      ],
    );
    deviceId = inserted.id;
  }

  const request = await one(
    db,
    `insert into device_authorization_requests(
       id, warehouse_id, workstation_id, device_id, device_code, device_role,
       ownership_type, requested_by, registration_mode, hardware_fingerprint_hash, request_status
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     returning id, warehouse_id, workstation_id, device_id, device_code, device_role, ownership_type, registration_mode, request_status, created_at`,
    [
      uuid(),
      input.warehouse_id,
      input.workstation_id ?? null,
      deviceId,
      normalizedCode,
      input.device_role,
      input.ownership_type,
      actor.id,
      policy.mode,
      fpHash,
    ],
  );

  const adminIds = await resolveAdminUserIds(db, ADMIN_ROLES);
  await emitInboxNotification(db, {
    template: "device.auth_requested",
    recipientUserIds: adminIds,
    dedupePrefix: `device.auth_requested:${request.id}`,
    payload: {
      request_id: request.id,
      device_id: deviceId,
      device_code: normalizedCode,
      warehouse_id: input.warehouse_id,
      requested_by: actor.id,
    },
  });
  await audit(db, actor, "device_auth_requested", "device_authorization_requests", request.id as string, {
    device_id: deviceId,
    mode: policy.mode,
  });

  return { request, device_id: deviceId, approval_status: "pending_approval", online_status: "offline" };
}

export async function decideDeviceAuthorization(
  db: DB,
  actor: Actor,
  requestId: string,
  input: z.infer<typeof deviceDecisionSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  const reqSnap = await one<{
    id: string;
    device_id: string;
  }>(
    db,
    "select id, device_id from device_authorization_requests where id = $1",
    [requestId],
  );
  await lock(db, `device:${reqSnap.device_id}`);

  const device = await one<{
    id: string;
    approval_status: string;
    ownership_type: (typeof OWNERSHIP_TYPES)[number];
    auth_generation: number;
  }>(
    db,
    "select id, approval_status, ownership_type, auth_generation from warehouse_devices where id = $1 for update",
    [reqSnap.device_id],
  );
  const reqRow = await one<{
    id: string;
    warehouse_id: string;
    device_id: string;
    device_code: string;
    ownership_type: (typeof OWNERSHIP_TYPES)[number];
    requested_by: string;
    request_status: string;
  }>(
    db,
    `select id, warehouse_id, device_id, device_code, ownership_type, requested_by, request_status
     from device_authorization_requests where id = $1 for update`,
    [requestId],
  );
  guard(reqRow.request_status === "pending", "REQUEST_NOT_PENDING", "Authorization request has already been decided.", 409);
  guard(
    device.approval_status === "pending_approval",
    "DEVICE_NOT_PENDING_APPROVAL",
    "Device is no longer awaiting approval (it may have been revoked or already decided).",
    409,
  );

  const policy = await getEffectiveAccessPolicy(db, reqRow.warehouse_id);
  const isOwnerSelfException =
    actor.roles.includes("super_admin") &&
    reqRow.ownership_type === "warehouse_owned" &&
    device.ownership_type === "warehouse_owned" &&
    policy.allow_owner_self_confirm === true &&
    input.confirm_owner_owned === true;

  if (reqRow.requested_by === actor.id && !isOwnerSelfException) {
    guard(
      false,
      "SELF_APPROVAL_FORBIDDEN",
      "Staff cannot approve or reject their own device request without explicit owner warehouse-owned confirmation policy.",
      403,
    );
  }

  if (input.decision === "approve") {
    const issuedSecret = randomBytes(24).toString("base64url");
    const secretHash = hash(issuedSecret);

    await db.query(
      `update warehouse_devices
       set approval_status = 'approved',
           online_status = 'offline',
           device_secret_hash = $2,
           approved_by = $3,
           approved_at = now(),
           calibration_due_at = coalesce($4, calibration_due_at),
           updated_at = now()
       where id = $1`,
      [device.id, secretHash, actor.id, input.calibration_due_at ?? null],
    );
    await db.query(
      `update device_authorization_requests
       set request_status = 'approved', decision_by = $2, decision_at = now(), decision_note = $3
       where id = $1`,
      [reqRow.id, actor.id, input.note ?? null],
    );
    await emitInboxNotification(db, {
      template: "device.auth_approved",
      recipientUserIds: [reqRow.requested_by],
      dedupePrefix: `device.auth_approved:${reqRow.id}`,
      payload: {
        request_id: reqRow.id,
        device_id: device.id,
        device_code: reqRow.device_code,
        warehouse_id: reqRow.warehouse_id,
        approved_by: actor.id,
      },
    });
    await audit(db, actor, "device_auth_approved", "warehouse_devices", device.id, {
      request_id: reqRow.id,
      auth_generation: device.auth_generation,
    });

    return {
      request_status: "approved",
      approval_status: "approved",
      online_status: "offline",
      device_id: device.id,
      device_code: reqRow.device_code,
      device_secret: issuedSecret,
    };
  }

  await db.query(
    `update warehouse_devices
     set approval_status = 'rejected', online_status = 'offline', device_secret_hash = null, updated_at = now()
     where id = $1`,
    [device.id],
  );
  await db.query(
    `update device_authorization_requests
     set request_status = 'rejected', decision_by = $2, decision_at = now(), decision_note = $3
     where id = $1`,
    [reqRow.id, actor.id, input.note ?? null],
  );
  await emitInboxNotification(db, {
    template: "device.auth_rejected",
    recipientUserIds: [reqRow.requested_by],
    dedupePrefix: `device.auth_rejected:${reqRow.id}`,
    payload: {
      request_id: reqRow.id,
      device_id: device.id,
      device_code: reqRow.device_code,
      warehouse_id: reqRow.warehouse_id,
      rejected_by: actor.id,
      note: input.note ?? null,
    },
  });
  await audit(db, actor, "device_auth_rejected", "warehouse_devices", device.id, {
    request_id: reqRow.id,
    note: input.note ?? null,
  });

  return {
    request_status: "rejected",
    approval_status: "rejected",
    online_status: "offline",
    device_id: device.id,
  };
}

export async function deviceHeartbeat(
  db: DB,
  input: z.infer<typeof deviceHeartbeatSchema>,
) {
  const fpHash = hash(input.hardware_fingerprint);
  const secretHash = hash(input.device_secret);

  const device = await one<{
    id: string;
    device_code: string;
    approval_status: string;
    online_status: string;
    hardware_fingerprint_hash: string;
    device_secret_hash: string | null;
    calibration_due_at: Date | null;
    auth_generation: number;
  }>(
    db,
    `select id, device_code, approval_status, online_status, hardware_fingerprint_hash,
            device_secret_hash, calibration_due_at, auth_generation
     from warehouse_devices where upper(device_code) = upper($1) for update`,
    [input.device_code],
  );

  guard(
    device.approval_status === "approved" && device.device_secret_hash,
    "DEVICE_NOT_AUTHORIZED",
    "Device is not approved or credential was revoked.",
    403,
  );
  guard(
    safeHexEqual(device.hardware_fingerprint_hash, fpHash) && safeHexEqual(device.device_secret_hash, secretHash),
    "INVALID_DEVICE_CREDENTIALS",
    "Device fingerprint or credential mismatch.",
    401,
  );

  let nextOnlineStatus = "online";
  if (device.online_status === "fault") {
    nextOnlineStatus = "fault";
  } else if (device.calibration_due_at && device.calibration_due_at.getTime() <= Date.now()) {
    nextOnlineStatus = "calibration_expired";
  }

  await db.query(
    "update warehouse_devices set online_status = $2, updated_at = now() where id = $1",
    [device.id, nextOnlineStatus],
  );
  await db.query(
    "update device_control_leases set last_heartbeat_at = now() where device_id = $1 and status = 'active' and auth_generation = $2",
    [device.id, device.auth_generation],
  );

  return {
    device_id: device.id,
    device_code: device.device_code,
    approval_status: device.approval_status,
    online_status: nextOnlineStatus,
    auth_generation: device.auth_generation,
  };
}

export async function revokeDevice(
  db: DB,
  actor: Actor,
  deviceId: string,
  input: z.infer<typeof deviceRevokeSchema>,
) {
  role(actor, ...ADMIN_ROLES);
  await lock(db, `device:${deviceId}`);
  const device = await one<{
    id: string;
    warehouse_id: string;
    device_code: string;
    approval_status: string;
    auth_generation: number;
    registered_by: string | null;
  }>(
    db,
    `select id, warehouse_id, device_code, approval_status, auth_generation, registered_by
     from warehouse_devices where id = $1 for update`,
    [deviceId],
  );
  guard(device.approval_status !== "revoked", "ALREADY_REVOKED", "Device is already revoked.", 409);

  const nextGeneration = device.auth_generation + 1;
  await db.query(
    `update warehouse_devices
     set approval_status = 'revoked',
         online_status = 'offline',
         device_secret_hash = null,
         auth_generation = $2,
         revoked_by = $3,
         revoked_at = now(),
         revocation_reason = $4,
         updated_at = now()
     where id = $1`,
    [device.id, nextGeneration, actor.id, input.reason],
  );

  await db.query(
    `update device_authorization_requests
     set request_status = 'cancelled',
         decision_by = $2,
         decision_at = now(),
         decision_note = coalesce(decision_note, $3)
     where device_id = $1 and request_status = 'pending'`,
    [device.id, actor.id, `Cancelled by device revocation: ${input.reason}`],
  );

  const killedLeases = (
    await db.query<{ holder_user_id: string }>(
      `update device_control_leases
       set status = 'revoked', ended_at = now(), end_reason = 'device_revoked'
       where device_id = $1 and status = 'active'
       returning holder_user_id`,
      [device.id],
    )
  ).rows;

  const adminIds = await resolveAdminUserIds(db, ADMIN_ROLES);
  const recipients = [
    ...killedLeases.map((l) => l.holder_user_id),
    ...(device.registered_by ? [device.registered_by] : []),
    ...adminIds,
  ];
  await emitInboxNotification(db, {
    template: "device.revoked",
    recipientUserIds: recipients,
    dedupePrefix: `device.revoked:${device.id}:${nextGeneration}`,
    payload: {
      device_id: device.id,
      device_code: device.device_code,
      warehouse_id: device.warehouse_id,
      auth_generation: nextGeneration,
      revoked_by: actor.id,
      reason: input.reason,
    },
  });
  await audit(db, actor, "device_revoked", "warehouse_devices", device.id, {
    auth_generation: nextGeneration,
    revoked_leases: killedLeases.length,
    reason: input.reason,
  });
  await recordRevocationTombstone(db, {
    entityType: "device_revocation",
    entityId: device.id,
    minAuthGeneration: nextGeneration,
    revokedBy: actor.id,
    reason: input.reason,
    details: { device_code: device.device_code, warehouse_id: device.warehouse_id },
  });

  return {
    device_id: device.id,
    approval_status: "revoked",
    online_status: "offline",
    auth_generation: nextGeneration,
    revoked_leases_count: killedLeases.length,
  };
}

export async function claimDeviceLease(
  db: DB,
  actor: Actor,
  deviceId: string,
  input: z.infer<typeof deviceLeaseClaimSchema>,
) {
  role(actor, ...READ_ROLES);
  const device = await one<{
    id: string;
    warehouse_id: string;
    workstation_id: string | null;
    approval_status: string;
    online_status: string;
    auth_generation: number;
    calibration_due_at: Date | null;
  }>(
    db,
    `select id, warehouse_id, workstation_id, approval_status, online_status, auth_generation, calibration_due_at
     from warehouse_devices where id = $1 for update`,
    [deviceId],
  );
  guard(device.approval_status === "approved", "DEVICE_NOT_APPROVED", "Only approved devices can issue control leases.", 409);
  guard(device.online_status !== "fault", "DEVICE_IN_FAULT", "Faulty device cannot issue control leases.", 409);
  guard(
    !device.calibration_due_at || device.calibration_due_at.getTime() > Date.now(),
    "CALIBRATION_EXPIRED",
    "Device calibration has expired.",
    409,
  );
  guard(device.online_status !== "calibration_expired", "CALIBRATION_EXPIRED", "Device calibration has expired.", 409);

  if (input.workstation_id) {
    await assertWorkstationMatchesWarehouse(db, input.workstation_id, device.warehouse_id);
  }

  await db.query(
    `update device_control_leases
     set status = 'expired', ended_at = now(), end_reason = 'ttl_expired'
     where device_id = $1 and status = 'active' and expires_at <= now()`,
    [device.id],
  );

  const activeLease = await db.query<{ id: string; holder_user_id: string }>(
    "select id, holder_user_id from device_control_leases where device_id = $1 and status = 'active'",
    [device.id],
  );
  guard(activeLease.rowCount === 0, "DEVICE_LEASE_BUSY", "Device already has an active control lease.", 409);

  const policy = await getEffectiveAccessPolicy(db, device.warehouse_id);
  const minutes = Math.min(input.duration_minutes ?? policy.max_lease_minutes, policy.max_lease_minutes);
  const rawLeaseToken = randomBytes(24).toString("base64url");
  const lease = await one(
    db,
    `insert into device_control_leases(
       id, device_id, workstation_id, holder_user_id, auth_generation, lease_token_hash,
       status, expires_at, last_heartbeat_at
     ) values($1, $2, $3, $4, $5, $6, 'active', now() + make_interval(mins => $7), now())
     returning id, device_id, workstation_id, holder_user_id, auth_generation, status, granted_at, expires_at`,
    [
      uuid(),
      device.id,
      input.workstation_id ?? device.workstation_id,
      actor.id,
      device.auth_generation,
      hash(rawLeaseToken),
      minutes,
    ],
  );
  await audit(db, actor, "device_lease_claimed", "device_control_leases", lease.id as string, {
    device_id: device.id,
    auth_generation: device.auth_generation,
  });

  return { lease, lease_token: rawLeaseToken };
}

export async function releaseDeviceLease(db: DB, actor: Actor, leaseId: string) {
  role(actor, ...READ_ROLES);
  const lease = await one<{ id: string; holder_user_id: string; status: string }>(
    db,
    "select id, holder_user_id, status from device_control_leases where id = $1 for update",
    [leaseId],
  );
  guard(lease.status === "active", "LEASE_NOT_ACTIVE", "Control lease is not active.", 409);
  const isAdmin = ADMIN_ROLES.some((r) => actor.roles.includes(r));
  guard(lease.holder_user_id === actor.id || isAdmin, "FORBIDDEN", "Only the lease holder or warehouse admin can release this lease.", 403);

  const updated = await one(
    db,
    `update device_control_leases
     set status = 'released', ended_at = now(), end_reason = 'released_by_operator'
     where id = $1
     returning id, device_id, holder_user_id, status, ended_at`,
    [lease.id],
  );
  return { lease: updated };
}

export async function recordDeviceCalibrationOrFault(
  db: DB,
  actor: Actor,
  deviceId: string,
  input: z.infer<typeof deviceCalibrationOrFaultSchema>,
) {
  role(actor, ...READ_ROLES);
  const device = await one<{ id: string; warehouse_id: string; device_code: string; device_role: string; online_status: string }>(
    db,
    "select id, warehouse_id, device_code, device_role, online_status from warehouse_devices where id = $1 for update",
    [deviceId],
  );

  const validOutcomesByType: Record<z.infer<typeof deviceCalibrationOrFaultSchema>["log_type"], string[]> = {
    calibration: ["passed", "failed"],
    maintenance: ["passed", "open", "resolved"],
    fault_report: ["open"],
    fault_resolved: ["resolved"],
  };
  guard(
    validOutcomesByType[input.log_type].includes(input.outcome),
    "INVALID_LOG_OUTCOME",
    `Outcome '${input.outcome}' is invalid for log_type '${input.log_type}'.`,
    422,
  );
  if (input.log_type === "calibration" && input.outcome === "passed" && input.next_due_at) {
    guard(
      new Date(input.next_due_at).getTime() > Date.now(),
      "INVALID_CALIBRATION_DUE_AT",
      "Next calibration due timestamp must be in the future.",
      422,
    );
  }

  const mp = input.measured_params;
  if (mp.tare_g !== undefined && mp.gross_g !== undefined && mp.net_g !== undefined) {
    const tol = mp.tolerance_g ?? 1;
    guard(
      Math.abs((mp.gross_g - mp.tare_g) - mp.net_g) <= tol,
      "INVALID_SCALE_WEIGHT",
      "Scale net weight must equal gross minus tare within tolerance.",
      422,
    );
  }

  const logRow = await one(
    db,
    `insert into device_calibration_logs(
       id, device_id, log_type, outcome, recorded_by, measured_params, next_due_at, notes
     ) values($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     returning id, device_id, log_type, outcome, recorded_by, measured_params, next_due_at, created_at`,
    [
      uuid(),
      device.id,
      input.log_type,
      input.outcome,
      actor.id,
      JSON.stringify(input.measured_params),
      input.next_due_at ?? null,
      input.notes ?? null,
    ],
  );

  if (input.log_type === "fault_report") {
    await db.query("update warehouse_devices set online_status = 'fault', updated_at = now() where id = $1", [device.id]);
    await db.query(
      "update device_control_leases set status = 'revoked', ended_at = now(), end_reason = 'device_fault' where device_id = $1 and status = 'active'",
      [device.id],
    );
    const adminIds = await resolveAdminUserIds(db, ADMIN_ROLES);
    await emitInboxNotification(db, {
      template: "device.fault_reported",
      recipientUserIds: adminIds,
      dedupePrefix: `device.fault_reported:${logRow.id}`,
      payload: { device_id: device.id, device_code: device.device_code, warehouse_id: device.warehouse_id, log_id: logRow.id },
    });
  } else if (input.log_type === "fault_resolved") {
    await db.query(
      `update warehouse_devices
       set online_status = case
             when calibration_due_at is not null and calibration_due_at <= now() then 'calibration_expired'
             else 'offline'
           end,
           updated_at = now()
       where id = $1`,
      [device.id],
    );
  } else if (input.log_type === "calibration") {
    if (input.outcome === "passed") {
      await db.query(
        `update warehouse_devices
         set last_calibrated_at = now(),
             calibration_due_at = coalesce($2, calibration_due_at),
             online_status = case
               when online_status = 'fault' then 'fault'
               when online_status = 'calibration_expired' and (coalesce($2, calibration_due_at) is null or coalesce($2, calibration_due_at) > now()) then 'offline'
               else online_status
             end,
             updated_at = now()
         where id = $1`,
        [device.id, input.next_due_at ?? null],
      );
    } else if (input.outcome === "failed") {
      await db.query(
        `update warehouse_devices
         set online_status = case when online_status = 'fault' then 'fault' else 'calibration_expired' end,
             updated_at = now()
         where id = $1`,
        [device.id],
      );
      const adminIds = await resolveAdminUserIds(db, ADMIN_ROLES);
      await emitInboxNotification(db, {
        template: "device.calibration_failed",
        recipientUserIds: adminIds,
        dedupePrefix: `device.calibration_failed:${logRow.id}`,
        payload: { device_id: device.id, device_code: device.device_code, warehouse_id: device.warehouse_id, log_id: logRow.id },
      });
    }
  }

  await audit(db, actor, "device_calibration_or_fault_recorded", "device_calibration_logs", logRow.id as string, {
    device_id: device.id,
    log_type: input.log_type,
    outcome: input.outcome,
  });

  return { log: logRow };
}

export async function listInspectorSkills(db: Pick<DB, "query">, actor: Actor, userId?: string) {
  role(actor, ...READ_ROLES);
  const params: unknown[] = [];
  let where = "";
  if (userId) {
    params.push(z.uuid().parse(userId));
    where = "where g.user_id = $1";
  }
  const { rows } = await db.query(
    `select g.id, g.user_id, g.skill_code, g.category_code, g.service_code,
            g.status, g.certified_by, g.valid_until, g.evidence_note, g.created_at, g.updated_at
     from inspector_skill_grants g
     ${where}
     order by g.updated_at desc`,
    params,
  );
  return { skills: rows };
}

export async function grantOrUpdateSkill(
  db: DB,
  actor: Actor,
  input: z.infer<typeof skillGrantSchema>,
) {
  role(actor, ...SKILL_ADMIN_ROLES);
  guard(
    input.user_id !== actor.id,
    "SELF_CERTIFICATION_FORBIDDEN",
    "Staff cannot certify or approve their own inspection skill capabilities.",
    403,
  );

  const staff = await one<{ id: string; status: string; employment_status: string | null }>(
    db,
    `select u.id, u.status, sp.employment_status
     from users u
     join staff_roles sr on sr.user_id = u.id
     left join staff_profiles sp on sp.user_id = u.id
     where u.id = $1
     limit 1`,
    [input.user_id],
  );
  guard(staff.status === "active" && staff.employment_status !== "offboarded", "STAFF_INACTIVE", "Target staff account is not active.", 409);

  const row = await one(
    db,
    `insert into inspector_skill_grants(
       id, user_id, skill_code, category_code, service_code, status, certified_by, valid_until, evidence_note, updated_at
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     on conflict (user_id, skill_code) do update
       set category_code = excluded.category_code,
           service_code = excluded.service_code,
           status = excluded.status,
           certified_by = excluded.certified_by,
           valid_until = excluded.valid_until,
           evidence_note = excluded.evidence_note,
           updated_at = now()
     returning id, user_id, skill_code, category_code, service_code, status, certified_by, valid_until, updated_at`,
    [
      uuid(),
      input.user_id,
      input.skill_code,
      input.category_code ?? null,
      input.service_code ?? null,
      input.status,
      actor.id,
      input.valid_until ?? null,
      input.evidence_note ?? null,
    ],
  );

  await emitInboxNotification(db, {
    template: "staff.skill_updated",
    recipientUserIds: [input.user_id],
    dedupePrefix: `staff.skill_updated:${row.id}:${uuid()}`,
    payload: {
      grant_id: row.id,
      skill_code: input.skill_code,
      status: input.status,
      certified_by: actor.id,
    },
  });
  await audit(db, actor, "inspector_skill_updated", "inspector_skill_grants", row.id as string, {
    user_id: input.user_id,
    skill_code: input.skill_code,
    status: input.status,
  });

  return { skill: row };
}

export async function revokeSkillGrant(
  db: DB,
  actor: Actor,
  grantId: string,
  input: z.infer<typeof skillRevokeSchema>,
) {
  role(actor, ...SKILL_ADMIN_ROLES);
  const existing = await one<{ id: string; user_id: string; skill_code: string }>(
    db,
    "select id, user_id, skill_code from inspector_skill_grants where id = $1 for update",
    [grantId],
  );
  const updated = await one(
    db,
    `update inspector_skill_grants
     set status = 'revoked', evidence_note = $2, updated_at = now()
     where id = $1
     returning id, user_id, skill_code, status, updated_at`,
    [grantId, input.reason],
  );
  await emitInboxNotification(db, {
    template: "staff.skill_revoked",
    recipientUserIds: [existing.user_id],
    dedupePrefix: `staff.skill_revoked:${existing.id}:${uuid()}`,
    payload: {
      grant_id: existing.id,
      skill_code: existing.skill_code,
      revoked_by: actor.id,
      reason: input.reason,
    },
  });
  await audit(db, actor, "inspector_skill_revoked", "inspector_skill_grants", existing.id, {
    reason: input.reason,
  });
  return { skill: updated };
}

export async function evaluateServiceSellability(
  db: Pick<DB, "query">,
  actor: Actor,
  query: z.infer<typeof sellabilityQuerySchema>,
) {
  role(actor, ...READ_ROLES);
  const wh = await one<{ id: string; status: string; allow_fulfillment: boolean }>(
    db,
    "select id, status, allow_fulfillment from warehouses where id = $1",
    [query.warehouse_id],
  );
  const requiredRoles = (query.required_device_roles ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => z.enum(DEVICE_ROLES).parse(s));

  const blockingReasons: string[] = [];
  if (wh.status !== "active" || !wh.allow_fulfillment) {
    blockingReasons.push("WAREHOUSE_FULFILLMENT_DISABLED");
  }

  const activeWorkstations = (
    await db.query<{ id: string; station_code: string; required_device_roles: string[] }>(
      "select id, station_code, required_device_roles from workstations where warehouse_id = $1 and status = 'active'",
      [wh.id],
    )
  ).rows;
  if (activeWorkstations.length === 0) {
    blockingReasons.push("NO_ACTIVE_WORKSTATION");
  }

  const readyDevices = (
    await db.query<{ id: string; device_code: string; device_role: string }>(
      `select d.id, d.device_code, d.device_role
       from warehouse_devices d
       left join workstations ws on ws.id = d.workstation_id
       where d.warehouse_id = $1
         and d.approval_status = 'approved'
         and d.online_status = 'online'
         and (d.calibration_due_at is null or d.calibration_due_at > now())
         and (d.workstation_id is null or ws.status = 'active')`,
      [wh.id],
    )
  ).rows;

  const missingRoles = requiredRoles.filter((r) => !readyDevices.some((d) => d.device_role === r));
  if (missingRoles.length > 0) {
    blockingReasons.push(`MISSING_ONLINE_AUTHORIZED_DEVICE:${missingRoles.join(",")}`);
  }

  let matchedInspectors: Array<{ user_id: string; skill_code: string }> = [];
  if (query.required_skill_code) {
    matchedInspectors = (
      await db.query<{ user_id: string; skill_code: string }>(
        `select g.user_id, g.skill_code
         from inspector_skill_grants g
         join users u on u.id = g.user_id
         left join staff_profiles sp on sp.user_id = g.user_id
         where g.skill_code = $1
           and g.status = 'active'
           and (g.valid_until is null or g.valid_until > now())
           and u.status = 'active'
           and exists (select 1 from staff_roles sr where sr.user_id = g.user_id)
           and (sp.user_id is null or (sp.employment_status = 'active' and sp.account_security_status = 'active'))
           and (sp.user_id is null or cardinality(sp.allowed_warehouse_ids) = 0 or $2 = any(sp.allowed_warehouse_ids))`,
        [query.required_skill_code, wh.id],
      )
    ).rows;
    if (matchedInspectors.length === 0) {
      blockingReasons.push(`NO_CERTIFIED_ACTIVE_INSPECTOR:${query.required_skill_code}`);
    }
  }

  return {
    sellable: blockingReasons.length === 0,
    blocking_reasons: blockingReasons,
    matched_workstations_count: activeWorkstations.length,
    matched_devices: readyDevices,
    matched_inspectors: matchedInspectors,
  };
}

export async function listStaffOwnNotifications(db: Pick<DB, "query">, actor: Actor) {
  role(actor, ...READ_ROLES);
  return listStaffInbox(db, actor);
}

export async function markStaffNotificationRead(db: DB, actor: Actor, notificationId: string) {
  role(actor, ...READ_ROLES);
  return markStaffInboxRead(db, actor, notificationId);
}
