import { z } from "zod";
import type { DB } from "../db";
import { audit, guard, lock, one, role, uuid, type Actor } from "./common";
import { requireStaffMfa } from "./auth";
import { ACTION_CATALOG, resolvePermissionsForRoles, STAFF_ROLES, type AuthzAction } from "./authz-contract";
import { staffTabs } from "./portal-routes";

export const rbacRoleDraftSchema = z.object({
  role_code: z.string().trim().min(2).max(50).regex(/^[a-z][a-z0-9_]+$/),
  display_name_zh: z.string().trim().min(1).max(80),
  display_name_en: z.string().trim().min(1).max(80),
  permissions: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
});

export const rbacAssignmentSchema = z.object({
  user_id: z.uuid(),
  role_id: z.uuid(),
  warehouse_scope: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});

const MOBILE_CAPABILITIES_BY_ACTION: Partial<Record<AuthzAction, string>> = {
  "warehouse.intake": "mobile_intake_scan",
  "warehouse.move": "mobile_storage_move",
  "warehouse.stocktake_entry": "mobile_stocktake",
  "qc.execute": "mobile_qc_capture",
  "qc.upload_evidence": "mobile_photo_upload",
  "logistics.pick_pack": "mobile_pack_handover",
  "logistics.handover": "mobile_pack_handover",
  "notifications.read_own": "mobile_inbox",
};

function validateControlledPermissions(permissions: readonly string[]): AuthzAction[] {
  const unique = [...new Set(permissions)];
  for (const p of unique) {
    guard(
      Object.prototype.hasOwnProperty.call(ACTION_CATALOG, p),
      "UNKNOWN_PERMISSION_ACTION",
      `Permission '${p}' is not registered in server ACTION_CATALOG.`,
      422,
    );
  }
  return unique as AuthzAction[];
}

export async function listRbacRoles(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin");
  const { rows } = await db.query(
    `select r.id, r.role_code, r.display_name_zh, r.display_name_en, r.is_system_preset,
            r.status, r.version, r.permissions, r.created_by, r.approved_by, r.updated_at,
            (select count(*)::int from staff_custom_role_assignments a where a.role_id = r.id) as assigned_custom_count
     from rbac_roles r
     order by r.is_system_preset desc, r.role_code`,
  );
  return { roles: rows, catalog_actions: Object.keys(ACTION_CATALOG) };
}

export async function createCustomRbacRoleDraft(
  db: DB,
  actor: Actor,
  input: z.infer<typeof rbacRoleDraftSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  guard(
    !STAFF_ROLES.includes(input.role_code as (typeof STAFF_ROLES)[number]),
    "ROLE_CODE_RESERVED",
    `Preset role code '${input.role_code}' is reserved.`,
    409,
  );
  const validatedPerms = validateControlledPermissions(input.permissions);
  const id = uuid();
  const created = await one(
    db,
    `insert into rbac_roles(id, role_code, display_name_zh, display_name_en, is_system_preset, status, version, permissions, created_by)
     values($1, $2, $3, $4, false, 'draft', 1, $5::text[], $6)
     returning id, role_code, display_name_zh, display_name_en, is_system_preset, status, version, permissions, created_by`,
    [id, input.role_code, input.display_name_zh, input.display_name_en, validatedPerms, actor.id],
  );
  await audit(db, actor, "create_rbac_role_draft", "rbac_roles", id, {
    role_code: input.role_code,
    permissions_count: validatedPerms.length,
  });
  return created;
}

export async function previewRbacRoleImpact(db: Pick<DB, "query">, actor: Actor, roleId: string) {
  role(actor, "super_admin");
  const target = await one<{
    id: string;
    role_code: string;
    status: string;
    version: number;
    permissions: string[];
  }>(db, "select id, role_code, status, version, permissions from rbac_roles where id = $1", [roleId]);
  const assigned = (
    await db.query<{ user_id: string }>(
      "select user_id from staff_custom_role_assignments where role_id = $1",
      [roleId],
    )
  ).rows;
  return {
    role_id: target.id,
    role_code: target.role_code,
    status: target.status,
    version: target.version,
    affected_staff_count: assigned.length,
    permissions_count: target.permissions.length,
    high_risk_permissions: target.permissions.filter((p) =>
      ["staff.grant_roles", "finance.refund_approve", "system.secrets_rotate", "qc.qa_approve"].includes(p),
    ),
  };
}

export async function publishRbacRole(db: DB, actor: Actor, roleId: string, reason: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `rbac_role:${roleId}`);
  const target = await one<{
    id: string;
    role_code: string;
    is_system_preset: boolean;
    status: string;
    version: number;
    permissions: string[];
    created_by: string | null;
  }>(
    db,
    "select id, role_code, is_system_preset, status, version, permissions, created_by from rbac_roles where id = $1 for update",
    [roleId],
  );
  guard(!target.is_system_preset, "PRESET_ROLE_LOCKED", "System preset roles cannot be rewritten via custom publish.", 409);
  guard(target.status !== "archived", "ROLE_ARCHIVED", "Archived roles cannot be published.", 409);
  guard(!target.created_by || target.created_by !== actor.id, "SELF_REVIEW_FORBIDDEN", "Role author cannot independently publish their own custom role draft.", 403);

  const nextVersion = target.status === "draft" ? target.version : target.version + 1;
  const published = await one(
    db,
    `update rbac_roles
     set status = 'active', version = $2, approved_by = $3, updated_at = now()
     where id = $1
     returning id, role_code, status, version, permissions, approved_by`,
    [roleId, nextVersion, actor.id],
  );
  await db.query(
    `insert into rbac_role_versions(id, role_id, version, permissions, change_reason, changed_by, approved_by)
     values($1, $2, $3, $4::text[], $5, $6, $7)
     on conflict (role_id, version) do nothing`,
    [uuid(), roleId, nextVersion, target.permissions, reason, target.created_by ?? actor.id, actor.id],
  );

  // Revoke active PC & mobile sessions cleanly for every assigned staff member upon publish (§87.2/87.5).
  const affectedUsers = (
    await db.query<{ user_id: string }>(
      "select user_id from staff_custom_role_assignments where role_id = $1",
      [roleId],
    )
  ).rows.map((r) => r.user_id);
  if (affectedUsers.length) {
    await db.query("update users set auth_version = auth_version + 1, updated_at = now() where id = any($1::uuid[])", [affectedUsers]);
    await db.query("update sessions set revoked_at = now() where user_id = any($1::uuid[]) and revoked_at is null", [affectedUsers]);
  }
  await audit(db, actor, "publish_rbac_role", "rbac_roles", roleId, {
    role_code: target.role_code,
    version: nextVersion,
    affected_users: affectedUsers.length,
  });
  return published;
}

export async function archiveRbacRole(db: DB, actor: Actor, roleId: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `rbac_role:${roleId}`);
  const target = await one<{ id: string; role_code: string; is_system_preset: boolean }>(
    db,
    "select id, role_code, is_system_preset from rbac_roles where id = $1 for update",
    [roleId],
  );
  guard(!target.is_system_preset, "PRESET_ROLE_LOCKED", "Cannot archive preset system roles.", 409);
  const assignedCount = (
    await db.query("select 1 from staff_custom_role_assignments where role_id = $1 limit 1", [roleId])
  ).rowCount;
  guard(!assignedCount, "ROLE_IN_USE", "Remove active staff assignments before archiving this role.", 409);

  const archived = await one(
    db,
    "update rbac_roles set status = 'archived', updated_at = now() where id = $1 returning id, role_code, status",
    [roleId],
  );
  await audit(db, actor, "archive_rbac_role", "rbac_roles", roleId, { role_code: target.role_code });
  return archived;
}

export async function assignCustomRoleToStaff(
  db: DB,
  actor: Actor,
  input: z.infer<typeof rbacAssignmentSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `rbac_role:${input.role_id}`);
  const roleRow = await one<{ id: string; role_code: string; status: string; is_system_preset: boolean }>(
    db,
    "select id, role_code, status, is_system_preset from rbac_roles where id = $1 for update",
    [input.role_id],
  );
  guard(
    !roleRow.is_system_preset,
    "PRESET_ROLE_LOCKED",
    "System preset roles cannot be assigned via custom role assignments.",
    409,
  );
  guard(roleRow.status === "active", "ROLE_NOT_ACTIVE", "Only active RBAC roles can be assigned.", 409);
  const staffMeta = await one<{
    id: string;
    user_status: string;
    is_staff: boolean;
    employment_status: string | null;
  }>(
    db,
    `select u.id, u.status as user_status,
            (exists(select 1 from staff_profiles where user_id = u.id) or exists(select 1 from staff_roles where user_id = u.id)) as is_staff,
            (select sp.employment_status from staff_profiles sp where sp.user_id = u.id) as employment_status
     from users u where u.id = $1 for update`,
    [input.user_id],
  );
  guard(staffMeta.is_staff, "NOT_STAFF_ACCOUNT", "Custom RBAC roles can only be assigned to staff accounts.", 422);
  guard(
    staffMeta.employment_status !== "offboarded" &&
      staffMeta.user_status !== "closed" &&
      (staffMeta.employment_status !== null || staffMeta.user_status === "active"),
    "STAFF_OFFBOARDED",
    "Cannot assign custom RBAC roles to an offboarded or disabled staff account.",
    409,
  );

  await db.query(
    `insert into staff_custom_role_assignments(user_id, role_id, warehouse_scope, assigned_by)
     values($1, $2, $3::text[], $4)
     on conflict (user_id, role_id) do update set warehouse_scope = excluded.warehouse_scope, assigned_by = excluded.assigned_by, assigned_at = now()`,
    [input.user_id, input.role_id, input.warehouse_scope, actor.id],
  );
  await db.query("update users set auth_version = auth_version + 1, updated_at = now() where id = $1", [input.user_id]);
  await db.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [input.user_id]);

  await audit(db, actor, "assign_custom_rbac_role", "users", input.user_id, {
    role_id: input.role_id,
    role_code: roleRow.role_code,
    warehouse_scope: input.warehouse_scope,
  });
  return { user_id: input.user_id, role_id: input.role_id, role_code: roleRow.role_code, session_revoked: true };
}

export async function removeCustomRoleFromStaff(
  db: DB,
  actor: Actor,
  userId: string,
  roleId: string,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await db.query("delete from staff_custom_role_assignments where user_id = $1 and role_id = $2", [userId, roleId]);
  await db.query("update users set auth_version = auth_version + 1, updated_at = now() where id = $1", [userId]);
  await db.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
  await audit(db, actor, "remove_custom_rbac_role", "users", userId, { role_id: roleId });
  return { removed: true, session_revoked: true };
}

/**
 * Single authoritative effective permission source for PC navigation + mobile portal + API guards (§87.2/87.5):
 * combines preset roles + active custom roles and intersects explicit warehouse scopes without expanding across roles.
 */
export async function computeEffectiveStaffPermissions(db: Pick<DB, "query">, actor: Actor) {
  guard(actor.kind === "staff", "FORBIDDEN", "Staff session required.", 403);
  const presetPerms = resolvePermissionsForRoles(actor.roles);
  const customRows = (
    await db.query<{ permissions: string[]; warehouse_scope: string[] }>(
      `select r.permissions, a.warehouse_scope
       from staff_custom_role_assignments a
       join rbac_roles r on r.id = a.role_id
       where a.user_id = $1 and r.status = 'active'`,
      [actor.id],
    )
  ).rows;
  const profileRow = (
    await db.query<{ allowed_warehouse_ids: string[] }>(
      "select allowed_warehouse_ids from staff_profiles where user_id = $1",
      [actor.id],
    )
  ).rows[0];

  const effectivePerms = new Set<string>(presetPerms);
  for (const row of customRows) {
    for (const p of row.permissions) {
      if (Object.prototype.hasOwnProperty.call(ACTION_CATALOG, p)) {
        effectivePerms.add(p);
      }
    }
  }

  // Strict warehouse intersection across profile and non-empty custom role scopes (without expanding back if intersection becomes empty).
  let allowedWarehouses = [...new Set(profileRow?.allowed_warehouse_ids ?? [])];
  let hasWarehouseConstraint = allowedWarehouses.length > 0;
  for (const row of customRows) {
    if (row.warehouse_scope.length > 0) {
      if (!hasWarehouseConstraint) {
        allowedWarehouses = [...new Set(row.warehouse_scope)];
        hasWarehouseConstraint = true;
      } else {
        allowedWarehouses = allowedWarehouses.filter((w) => row.warehouse_scope.includes(w));
      }
    }
  }

  const mobileModules = new Set<string>();
  for (const perm of effectivePerms) {
    const m = MOBILE_CAPABILITIES_BY_ACTION[perm as AuthzAction];
    if (m) mobileModules.add(m);
  }

  return {
    user_id: actor.id,
    preset_roles: actor.roles,
    permissions: [...effectivePerms].sort(),
    allowed_warehouse_ids: allowedWarehouses,
    pc_navigation: {
      admin_tabs: staffTabs("admin", actor.roles).map(([path]) => path),
      warehouse_tabs: staffTabs("warehouse", actor.roles).map(([path]) => path),
    },
    mobile_modules: [...mobileModules].sort(),
  };
}
