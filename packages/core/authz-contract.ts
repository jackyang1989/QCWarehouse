import { timingSafeEqual } from "node:crypto";
import type { DB } from "../db";
import { guard, hash, Problem, revision as assertRevision, uuid, type Actor } from "./common";
import { staffAccess } from "./staff-access";

export const STAFF_ROLES = [
  "receiver",
  "inspector",
  "reviewer",
  "warehouse_admin",
  "support",
  "super_admin",
  "template_admin",
  "finance",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export type PermissionDomain =
  | "staff"
  | "orders"
  | "notifications"
  | "warehouse"
  | "qc"
  | "logistics"
  | "finance"
  | "catalog"
  | "device"
  | "media"
  | "ai"
  | "system";

export type SensitiveFieldClass =
  | "customer_contact"
  | "purchase_cost_secrets"
  | "selling_price"
  | "actual_cost"
  | "profit_margin"
  | "payment_reference"
  | "staff_security"
  | "export_payload";

export type ActionPolicy = {
  domain: PermissionDomain;
  roles: readonly StaffRole[];
  requiresMfa?: boolean;
  requiresWarehouseScope?: boolean;
  sodDistinctFromActorFields?: readonly string[];
  sensitiveFields?: readonly SensitiveFieldClass[];
};

export const ACTION_CATALOG = {
  "staff.read": { domain: "staff", roles: ["super_admin"], sensitiveFields: ["staff_security"] },
  "staff.invite": { domain: "staff", roles: ["super_admin"], requiresMfa: true },
  "staff.edit": { domain: "staff", roles: ["super_admin"], requiresMfa: true },
  "staff.grant_roles": { domain: "staff", roles: ["super_admin"], requiresMfa: true },
  "staff.assign_warehouse": { domain: "staff", roles: ["super_admin"], requiresMfa: true },
  "staff.disable": { domain: "staff", roles: ["super_admin"], requiresMfa: true },
  "staff.revoke_session": { domain: "staff", roles: ["super_admin"], requiresMfa: true },
  "staff.recover": { domain: "staff", roles: ["super_admin"], requiresMfa: true },
  "audit.read": { domain: "staff", roles: ["super_admin"] },

  "orders.read": { domain: "orders", roles: ["super_admin", "support", "finance", "warehouse_admin", "inspector", "reviewer"] },
  "orders.manual_quote": { domain: "orders", roles: ["super_admin", "support"] },
  "orders.scope_change": { domain: "orders", roles: ["super_admin", "support"] },
  "orders.cancel": { domain: "orders", roles: ["super_admin", "support"] },
  "tickets.manage": { domain: "orders", roles: ["super_admin", "support"] },
  "customers.read_pii": { domain: "orders", roles: ["super_admin"], sensitiveFields: ["customer_contact"] },
  "customers.export": { domain: "orders", roles: ["super_admin"], requiresMfa: true, sensitiveFields: ["customer_contact", "export_payload"] },

  "notifications.read_own": { domain: "notifications", roles: STAFF_ROLES },
  "notifications.read_scoped": { domain: "notifications", roles: ["super_admin", "support"] },
  "notifications.send": { domain: "notifications", roles: ["super_admin", "support"] },
  "notifications.broadcast": { domain: "notifications", roles: ["super_admin"], requiresMfa: true },
  "notifications.templates": { domain: "notifications", roles: ["super_admin"] },

  "warehouse.intake": { domain: "warehouse", roles: staffAccess.intake, requiresWarehouseScope: true },
  "warehouse.claim_decide": { domain: "warehouse", roles: ["receiver", "warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "warehouse.print": { domain: "warehouse", roles: staffAccess.intake, requiresWarehouseScope: true },
  "warehouse.move": { domain: "warehouse", roles: staffAccess.intake, requiresWarehouseScope: true },
  "warehouse.stocktake_entry": { domain: "warehouse", roles: staffAccess.intake, requiresWarehouseScope: true },
  "warehouse.stocktake_approve": {
    domain: "warehouse",
    roles: ["warehouse_admin", "super_admin"],
    requiresWarehouseScope: true,
    sodDistinctFromActorFields: ["submitted_by", "initiator_id"],
  },
  "warehouse.freeze": { domain: "warehouse", roles: ["warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "warehouse.incident": { domain: "warehouse", roles: ["receiver", "warehouse_admin", "support", "super_admin"], requiresWarehouseScope: true },

  "qc.claim_task": { domain: "qc", roles: ["inspector", "super_admin"], requiresWarehouseScope: true },
  "qc.execute": { domain: "qc", roles: ["inspector", "super_admin"], requiresWarehouseScope: true },
  "qc.upload_evidence": { domain: "qc", roles: ["inspector", "receiver", "warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "qc.retest": { domain: "qc", roles: ["inspector", "reviewer", "super_admin"], requiresWarehouseScope: true },
  "qc.submit": { domain: "qc", roles: ["inspector", "super_admin"], requiresWarehouseScope: true },
  "qc.qa_reject": { domain: "qc", roles: ["reviewer", "super_admin"], sodDistinctFromActorFields: ["inspector_id", "author_id"] },
  "qc.qa_approve": { domain: "qc", roles: ["reviewer", "super_admin"], sodDistinctFromActorFields: ["inspector_id", "author_id"] },
  "qc.report_publish": { domain: "qc", roles: ["reviewer", "super_admin"], sodDistinctFromActorFields: ["inspector_id", "author_id"] },

  "logistics.pick_pack": { domain: "logistics", roles: ["warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "logistics.quote": { domain: "logistics", roles: ["warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "logistics.address_edit": { domain: "logistics", roles: ["super_admin", "support", "warehouse_admin"] },
  "logistics.dispatch": { domain: "logistics", roles: ["warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "logistics.handover": { domain: "logistics", roles: ["warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "logistics.tracking_correct": { domain: "logistics", roles: ["super_admin", "support", "warehouse_admin"] },
  "logistics.cost_read": { domain: "logistics", roles: ["super_admin", "finance"], sensitiveFields: ["actual_cost", "profit_margin"] },

  "finance.read_receivables": { domain: "finance", roles: staffAccess.finance, sensitiveFields: ["selling_price", "payment_reference"] },
  "finance.read_cost_profit": { domain: "finance", roles: staffAccess.finance, sensitiveFields: ["actual_cost", "profit_margin"] },
  "finance.manual_receipt_record": { domain: "finance", roles: staffAccess.finance, sensitiveFields: ["payment_reference"] },
  "finance.manual_receipt_verify": {
    domain: "finance",
    roles: ["finance", "super_admin"],
    requiresMfa: true,
    sodDistinctFromActorFields: ["recorded_by", "issued_by"],
  },
  "finance.refund_request": { domain: "finance", roles: ["super_admin", "support", "finance"] },
  "finance.refund_approve": {
    domain: "finance",
    roles: ["super_admin"],
    requiresMfa: true,
    sodDistinctFromActorFields: ["requested_by", "recorded_by"],
  },
  "finance.dispute": { domain: "finance", roles: staffAccess.finance },
  "finance.reconcile": { domain: "finance", roles: staffAccess.finance },
  "finance.export": { domain: "finance", roles: staffAccess.finance, requiresMfa: true, sensitiveFields: ["payment_reference", "export_payload"] },

  "catalog.edit_draft": { domain: "catalog", roles: staffAccess.templates },
  "catalog.review": { domain: "catalog", roles: ["reviewer", "super_admin"], sodDistinctFromActorFields: ["author_id", "created_by"] },
  "catalog.publish_rollback": { domain: "catalog", roles: ["reviewer", "super_admin"], sodDistinctFromActorFields: ["author_id", "created_by"] },
  "shipping_rates.configure": { domain: "catalog", roles: ["super_admin"], requiresMfa: true },
  "legal.configure": { domain: "catalog", roles: ["super_admin"], requiresMfa: true },
  "config.configure": { domain: "catalog", roles: ["super_admin"], requiresMfa: true },

  "device.apply": { domain: "device", roles: ["inspector", "receiver", "warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "device.approve": { domain: "device", roles: ["warehouse_admin", "super_admin"], sodDistinctFromActorFields: ["requested_by", "applicant_id"] },
  "device.control_lease": { domain: "device", roles: ["inspector", "warehouse_admin", "super_admin"], requiresWarehouseScope: true },
  "device.revoke": { domain: "device", roles: ["warehouse_admin", "super_admin"] },

  "media.read": { domain: "media", roles: ["receiver", "inspector", "reviewer", "warehouse_admin", "support", "finance", "super_admin"] },
  "media.upload": { domain: "media", roles: ["receiver", "inspector", "warehouse_admin", "support", "super_admin"] },
  "media.annotate": { domain: "media", roles: ["inspector", "reviewer", "super_admin"] },
  "media.export": { domain: "media", roles: ["super_admin", "support", "reviewer"], sensitiveFields: ["export_payload"] },
  "media.delete_approve": { domain: "media", roles: ["super_admin"], requiresMfa: true, sodDistinctFromActorFields: ["requested_by"] },

  "ai.read": { domain: "ai", roles: ["super_admin", "template_admin", "support", "reviewer"] },
  "ai.configure": { domain: "ai", roles: ["super_admin"], requiresMfa: true },
  "ai.translate_field": { domain: "ai", roles: ["super_admin", "template_admin", "support", "reviewer", "inspector"] },
  "ai.translate_batch": { domain: "ai", roles: ["super_admin", "template_admin"] },
  "ai.review_publish": { domain: "ai", roles: ["super_admin", "reviewer", "template_admin"], sodDistinctFromActorFields: ["author_id"] },
  "ai.export": { domain: "ai", roles: ["super_admin"], requiresMfa: true, sensitiveFields: ["export_payload"] },

  "system.integrations": { domain: "system", roles: ["super_admin"], requiresMfa: true },
  "system.secrets_rotate": { domain: "system", roles: ["super_admin"], requiresMfa: true },
  "system.outbox_retry": { domain: "system", roles: ["super_admin"] },
  "system.backup_run": { domain: "system", roles: ["super_admin"] },
  "system.recovery_approve": { domain: "system", roles: ["super_admin"], requiresMfa: true, sodDistinctFromActorFields: ["initiator_id"] },
  "system.health": { domain: "system", roles: ["super_admin"] },
} as const satisfies Record<string, ActionPolicy>;

export type AuthzAction = keyof typeof ACTION_CATALOG;

/**
 * Single authoritative registry aligning portal direct routes with strict RBAC roles (fixes LIF-004 drift).
 */
export const ADMIN_DIRECT_ROUTE_ROLES: Record<string, readonly StaffRole[]> = {
  "/admin/customers": ["super_admin", "support", "finance"],
  "/admin/inspections": ["super_admin", "support", "inspector", "reviewer", "warehouse_admin"],
  "/admin/dispositions": staffAccess.orders,
  "/admin/incidents": staffAccess.orders,
  "/admin/refunds": staffAccess.finance,
  "/admin/payments": staffAccess.finance,
  "/admin/catalog": ["super_admin"],
  "/admin/categories": ["super_admin"],
  "/admin/templates": ["super_admin"],
  "/admin/shipping-rates": ["super_admin"],
  "/admin/config": ["super_admin"],
  "/admin/legal": ["super_admin"],
  "/admin/users": ["super_admin"],
  "/admin/audit": ["super_admin"],
  "/admin/operations": ["super_admin"],
  "/admin/settings": staffAccess.templates,
  "/admin/storage/locations": staffAccess.locations,
  "/admin/logistics": staffAccess.tracking,
  "/admin/integrations": ["super_admin"],
  "/admin/integrations/payments": ["super_admin"],
  "/admin/integrations/email": ["super_admin"],
  "/admin/integrations/ocr": ["super_admin"],
  "/admin/integrations/logistics": staffAccess.trackingConfiguration,
};

export type StaffScopeContext = {
  accountStatus: "active" | "restricted" | "disabled" | "closed";
  sessionRevokedAt?: Date | string | null;
  sessionAuthVersion?: number;
  userAuthVersion?: number;
  mfaFresh?: boolean;
  allowedWarehouseIds?: readonly string[] | "ALL";
  assignedTaskIds?: readonly string[] | "ALL";
  allowedOrgIds?: readonly string[] | "ALL";
  explicitDenies?: readonly AuthzAction[];
};

export type AuthorizationTarget = {
  orgId?: string;
  warehouseId?: string;
  taskId?: string;
  actorLinks?: Record<string, string | null | undefined>;
  requiredCapabilityReady?: boolean;
};

export function resolvePermissionsForRoles(roles: readonly string[]): AuthzAction[] {
  const granted = new Set<AuthzAction>();
  for (const [action, policy] of Object.entries(ACTION_CATALOG) as [AuthzAction, ActionPolicy][]) {
    if (policy.roles.some((r) => roles.includes(r))) {
      granted.add(action);
    }
  }
  return [...granted];
}

/**
 * Compute effective authorization strictly in §87.2 order:
 * 1) Active account & unrevoked/current-version session
 * 2) Controlled action catalog membership
 * 3) Warehouse / task / tenant scope intersection (multi-role merging never widens scope)
 * 4) Capability / state readiness
 * 5) Explicit denies & Separation of Duties (SoD) priority
 */
export function evaluateAuthorization(
  actor: Actor | null,
  action: AuthzAction,
  scope: StaffScopeContext,
  target: AuthorizationTarget = {},
): { allowed: true; action: AuthzAction } {
  guard(actor && actor.kind === "staff", "FORBIDDEN", "Staff authentication is required.", 403);
  guard(scope.accountStatus === "active", "ACCOUNT_INACTIVE", "Staff account is inactive or disabled.", 403);
  guard(!scope.sessionRevokedAt, "SESSION_REVOKED", "This session has been revoked.", 401);
  if (scope.sessionAuthVersion !== undefined && scope.userAuthVersion !== undefined) {
    guard(
      scope.sessionAuthVersion === scope.userAuthVersion,
      "SESSION_VERSION_STALE",
      "Permissions or account state changed; sign in again.",
      401,
    );
  }

  const policy = ACTION_CATALOG[action] as ActionPolicy | undefined;
  guard(policy, "UNKNOWN_PERMISSION_ACTION", "Unknown controlled action.", 403);

  guard(
    policy.roles.some((r) => actor.roles.includes(r)),
    "FORBIDDEN",
    `Action ${action} is outside the granted role permissions.`,
    403,
  );

  if (policy.requiresMfa) {
    guard(scope.mfaFresh === true, "STAFF_REAUTH_REQUIRED", "Fresh staff MFA verification is required.", 403);
  }

  // Scope intersection (never widened by multiple roles; fail closed unless explicitly "ALL").
  if (target.warehouseId && scope.allowedWarehouseIds !== "ALL") {
    const allowed = scope.allowedWarehouseIds ?? [];
    guard(
      allowed.includes(target.warehouseId),
      "WAREHOUSE_SCOPE_DENIED",
      "Actor is not authorized for the target warehouse scope.",
      403,
    );
  } else if (policy.requiresWarehouseScope && !target.warehouseId && scope.allowedWarehouseIds !== "ALL" && (scope.allowedWarehouseIds?.length ?? 0) === 0) {
    guard(false, "WAREHOUSE_SCOPE_MISSING", "Warehouse scope assignment is required for this action.", 403);
  }

  if (target.taskId && scope.assignedTaskIds !== "ALL") {
    const allowedTasks = scope.assignedTaskIds ?? [];
    guard(
      allowedTasks.includes(target.taskId),
      "TASK_SCOPE_DENIED",
      "Actor is not assigned to the target inspection/warehouse task.",
      403,
    );
  }

  if (target.orgId && scope.allowedOrgIds !== "ALL") {
    const allowedOrgs = scope.allowedOrgIds ?? [];
    guard(
      allowedOrgs.includes(target.orgId),
      "TENANT_SCOPE_DENIED",
      "Target customer tenant is outside authorized scope.",
      403,
    );
  }

  if (target.requiredCapabilityReady === false) {
    guard(false, "CAPABILITY_NOT_GRANTED", "Required skill or device capability qualification is missing.", 403);
  }

  // Stage 5: Explicit deny & Separation of Duties always take precedence over role grants (§87.2).
  guard(!scope.explicitDenies?.includes(action), "ACTION_EXPLICITLY_DENIED", "This action is explicitly denied.", 403);

  if (policy.sodDistinctFromActorFields?.length && target.actorLinks) {
    for (const field of policy.sodDistinctFromActorFields) {
      const priorUserId = target.actorLinks[field];
      if (priorUserId && priorUserId === actor.id) {
        throw new Problem(
          "SELF_REVIEW_FORBIDDEN",
          `Separation of duties prevents ${actor.id} from independently approving or deciding their own ${field} record.`,
          403,
        );
      }
    }
  }

  return { allowed: true, action };
}

/**
 * Authoritative tenant boundary check for customer actors.
 */
export function assertCustomerTenantOwnership(actor: Actor | null, recordOrgId: string | null | undefined): string {
  guard(actor && actor.kind === "customer" && actor.org, "FORBIDDEN", "Customer authentication required.", 403);
  guard(recordOrgId && actor.org === recordOrgId, "NOT_FOUND", "Record not found.", 404);
  return actor.org;
}

const FIELD_VISIBILITY: Record<SensitiveFieldClass, readonly StaffRole[]> = {
  customer_contact: ["super_admin", "support"],
  purchase_cost_secrets: ["super_admin", "finance"],
  selling_price: ["super_admin", "finance", "support", "template_admin"],
  actual_cost: ["super_admin", "finance"],
  profit_margin: ["super_admin", "finance"],
  payment_reference: ["super_admin", "finance"],
  staff_security: ["super_admin"],
  export_payload: ["super_admin", "finance"],
};

export function redactFieldsForActor<T extends Record<string, unknown>>(
  actor: Actor,
  record: T,
  fieldClassification: Partial<Record<keyof T, SensitiveFieldClass>>,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(record) as [keyof T, T[keyof T]][]) {
    const cls = fieldClassification[key];
    if (!cls) {
      out[key] = value;
      continue;
    }
    const allowedRoles = FIELD_VISIBILITY[cls];
    if (actor.kind === "staff" && allowedRoles.some((r) => actor.roles.includes(r))) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Owner bootstrap exception (§29/87 / TASK-180A):
 * Permitted ONLY while zero active super_admin accounts exist and valid bootstrap credential matches.
 * Permanently closed once an Owner exists so ordinary roles or replay requests cannot invoke it.
 */
const OWNER_LIFECYCLE_LOCK_KEY = "owner:super_admin:lifecycle";

export async function authorizeOwnerBootstrap(
  db: Pick<DB, "query">,
  presentedToken: string | null | undefined,
  expectedBootstrapToken: string | null | undefined,
): Promise<{ permitted: true }> {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [OWNER_LIFECYCLE_LOCK_KEY]);
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count
     from staff_roles sr
     join users u on u.id = sr.user_id
     where sr.role = 'super_admin' and u.status = 'active'`,
  );
  guard(
    (rows[0]?.count ?? 0) === 0,
    "OWNER_BOOTSTRAP_CLOSED",
    "Owner bootstrap exception is permanently closed after the initial active super_admin is provisioned.",
    403,
  );
  const presented = Buffer.from(presentedToken ?? "", "utf8");
  const expected = Buffer.from(expectedBootstrapToken ?? "", "utf8");
  const tokenMatch =
    expected.length >= 24 &&
    presented.length === expected.length &&
    timingSafeEqual(presented, expected);
  guard(
    tokenMatch,
    "BOOTSTRAP_CREDENTIAL_INVALID",
    "Valid server-provisioned bootstrap token is required.",
    403,
  );
  return { permitted: true };
}

/**
 * Protect against removing/disabling the last active Owner (super_admin).
 */
export async function assertLastOwnerPreserved(db: Pick<DB, "query">, excludingUserId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [OWNER_LIFECYCLE_LOCK_KEY]);
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count
     from staff_roles sr
     join users u on u.id = sr.user_id
     where sr.role = 'super_admin' and u.status = 'active' and u.id <> $1`,
    [excludingUserId],
  );
  guard(
    (rows[0]?.count ?? 0) > 0,
    "LAST_OWNER_PROTECTED",
    "Cannot remove or disable the last remaining active super_admin (Owner) account.",
    409,
  );
}

/**
 * Transaction idempotency contract (T42): identical key + payload returns cached response;
 * identical key + different payload rejects cleanly with IDEMPOTENCY_CONFLICT.
 */
export async function assertIdempotencyContract<T>(
  db: DB,
  actorId: string,
  method: string,
  routePath: string,
  idempotencyKey: string,
  payload: unknown,
  exec: () => Promise<T>,
): Promise<T> {
  guard(/^[0-9a-f-]{36}$/i.test(idempotencyKey), "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a valid UUID.", 422);
  const scope = `${actorId}:${method.toUpperCase()}:${routePath}`;
  const digest = hash(JSON.stringify(payload ?? null));
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${scope}:${idempotencyKey}`]);
  const existing = (
    await db.query<{ request_hash: string; response: T }>(
      "select request_hash, response from idempotency_keys where scope = $1 and key = $2",
      [scope, idempotencyKey],
    )
  ).rows[0];
  if (existing) {
    guard(
      existing.request_hash === digest,
      "IDEMPOTENCY_CONFLICT",
      "This Idempotency-Key was already used with a different request payload.",
      409,
    );
    return existing.response;
  }
  const result = await exec();
  await db.query(
    "insert into idempotency_keys(scope, key, request_hash, response) values($1, $2, $3, $4)",
    [scope, idempotencyKey, digest, JSON.stringify(result)],
  );
  return result;
}

/**
 * Declarative object lifecycle + optimistic version lock helper.
 */
export function assertLifecycleTransition<State extends string>(
  currentState: State,
  nextState: State,
  allowedTransitions: Record<State, readonly State[]>,
  expectedVersion?: { actual: number; expected: number },
) {
  if (expectedVersion) {
    assertRevision(expectedVersion.actual, expectedVersion.expected);
  }
  const allowedNext = allowedTransitions[currentState] ?? [];
  guard(
    allowedNext.includes(nextState),
    "INVALID_STATE_TRANSITION",
    `Transition from '${currentState}' to '${nextState}' is not permitted.`,
    409,
  );
}

export type DomainEventEnvelope<P extends Record<string, unknown> = Record<string, unknown>> = {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  actor_id: string | null;
  actor_kind: Actor["kind"] | "system";
  entity_type: string;
  entity_id: string;
  entity_version: number;
  idempotency_key: string | null;
  payload: P;
};

export function buildDomainEventEnvelope<P extends Record<string, unknown>>(params: {
  eventType: string;
  schemaVersion?: number;
  actor: Actor | null;
  entityType: string;
  entityId: string;
  entityVersion: number;
  idempotencyKey?: string | null;
  payload: P;
}): DomainEventEnvelope<P> {
  return {
    event_id: uuid(),
    event_type: params.eventType,
    schema_version: params.schemaVersion ?? 1,
    occurred_at: new Date().toISOString(),
    actor_id: params.actor?.id ?? null,
    actor_kind: params.actor?.kind ?? "system",
    entity_type: params.entityType,
    entity_id: params.entityId,
    entity_version: params.entityVersion,
    idempotency_key: params.idempotencyKey ?? null,
    payload: params.payload,
  };
}
