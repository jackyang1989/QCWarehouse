import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db";
import { audit, event, guard, hash, isDemo, lock, numericCode, one, role, shanghaiYYMMDD, uuid, type Actor } from "./common";
import { passwordHash, requireStaffMfa } from "./auth";
import { assertLastOwnerPreserved, STAFF_ROLES, type StaffRole } from "./authz-contract";
import { seal, unseal } from "./crypto";
import { emitActiveSuperAdminEvent, emitCommunicationEvent } from "./communications";

export const staffInviteSchema = z.object({
  display_name: z.string().trim().min(2).max(120),
  work_email: z.email().max(254).transform((v) => v.toLowerCase()),
  roles: z.array(z.enum(STAFF_ROLES)).min(1).max(8),
  allowed_warehouse_ids: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  default_warehouse_id: z.string().trim().min(1).max(80).nullable().optional(),
  locale: z.enum(["en-US", "zh-CN"]).default("zh-CN"),
  expiry_hours: z.number().int().min(1).max(168).default(72),
});

export const staffAcceptInviteSchema = z.object({
  token: z.string().trim().min(16).max(256),
  password: z.string().min(12).max(128).refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: "Password must be at least 12 characters with uppercase, lowercase, and numeric characters.",
  }),
  totp_code: z.string().regex(/^\d{6}$/),
});

export const staffOffboardSchema = z.object({
  reason: z.string().trim().min(4).max(500),
  handover_to_user_id: z.uuid().optional(),
  handover_items: z
    .array(
      z.object({
        entity_type: z.string().trim().min(1).max(60),
        entity_id: z.string().trim().min(1).max(120),
      }),
    )
    .max(100)
    .default([]),
});

const canReturnActivationTokenInTest = () => process.env.NODE_ENV === "test" || isDemo();

async function issueInviteRecord(
  db: DB,
  params: {
    userId: string;
    workEmail: string;
    roles: readonly StaffRole[];
    allowedWarehouses: readonly string[];
    locale: "en-US" | "zh-CN";
    expiryHours: number;
    actorId: string;
  },
) {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hash(rawToken);
  const inviteId = uuid();
  await db.query(
    `insert into staff_invitations(
       id, user_id, target_email, token_hash, auth_version_snapshot, preassigned_roles,
       allowed_warehouse_ids, locale, status, expires_at, created_by
     )
     select $1, $2, $3, $4, u.auth_version, $5::text[], $6::text[], $7, 'pending', now() + make_interval(hours => $8), $9
     from users u where u.id = $2`,
    [
      inviteId,
      params.userId,
      params.workEmail,
      tokenHash,
      [...new Set(params.roles)],
      params.allowedWarehouses,
      params.locale,
      params.expiryHours,
      params.actorId,
    ],
  );
  await emitCommunicationEvent(db, {
    sourceKind: "security_alert",
    eventType: "staff.invited",
    entityType: "staff_invitations",
    entityId: inviteId,
    dedupeKey: `staff.invited:${inviteId}`,
    metadata: { invitation_id: inviteId },
    createdBy: params.actorId,
    channels: ["in_app", "email"],
    recipients: [
      {
        userId: params.userId,
        kind: "staff",
        locale: params.locale,
        emailOverride: params.workEmail,
      },
    ],
  });
  await event(db, "staff.invited", { user_id: params.userId, invitation_id: inviteId, locale: params.locale });
  return { inviteId, rawToken };
}

export async function createAndInviteStaff(
  db: DB,
  actor: Actor,
  input: z.infer<typeof staffInviteSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `staff-invite:${input.work_email}`);

  const emailTaken = (
    await db.query(
      `select 1 from user_emails where normalized_email = ($1::text)::citext
       union all
       select 1 from staff_profiles where lower(work_email) = $1
       limit 1`,
      [input.work_email],
    )
  ).rowCount;
  guard(!emailTaken, "EMAIL_CONFLICT", "An employee or customer account already uses this email address.", 409);

  const userId = uuid();
  const employeeNo = numericCode(`EMP-${shanghaiYYMMDD()}-`, 4);
  const uniqueRoles = [...new Set(input.roles)];

  await db.query(
    `insert into users(id, display_name, status, locale) values($1, $2, 'disabled', $3)`,
    [userId, input.display_name, input.locale === "zh-CN" ? "zh-CN" : "en"],
  );
  await db.query(
    `insert into staff_profiles(
       user_id, employee_no, work_email, employment_status, account_security_status,
       preferred_locale, default_warehouse_id, allowed_warehouse_ids, created_by
     ) values($1, $2, $3, 'pending_onboarding', 'pending_activation', $4, $5, $6::text[], $7)`,
    [
      userId,
      employeeNo,
      input.work_email,
      input.locale,
      input.default_warehouse_id ?? null,
      input.allowed_warehouse_ids,
      actor.id,
    ],
  );
  const { inviteId, rawToken } = await issueInviteRecord(db, {
    userId,
    workEmail: input.work_email,
    roles: uniqueRoles,
    allowedWarehouses: input.allowed_warehouse_ids,
    locale: input.locale,
    expiryHours: input.expiry_hours,
    actorId: actor.id,
  });

  await audit(db, actor, "invite_staff", "staff_profiles", userId, {
    employee_no: employeeNo,
    roles: uniqueRoles,
    invitation_id: inviteId,
  });

  return {
    user_id: userId,
    employee_no: employeeNo,
    invitation_id: inviteId,
    employment_status: "pending_onboarding" as const,
    account_security_status: "pending_activation" as const,
    ...(canReturnActivationTokenInTest() ? { activation_token: rawToken } : {}),
  };
}

export async function resendStaffInvitation(db: DB, actor: Actor, targetUserId: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const prof = await one<{
    user_id: string;
    work_email: string;
    employment_status: string;
    account_security_status: string;
    preferred_locale: "en-US" | "zh-CN";
    allowed_warehouse_ids: string[];
  }>(
    db,
    `select user_id, work_email, employment_status, account_security_status, preferred_locale, allowed_warehouse_ids
     from staff_profiles where user_id = $1 for update`,
    [targetUserId],
  );
  guard(prof.account_security_status === "pending_activation", "ALREADY_ACTIVATED", "Staff account is already activated.", 409);

  const lastInvite = (
    await db.query<{ preassigned_roles: StaffRole[] }>(
      "select preassigned_roles from staff_invitations where user_id = $1 order by created_at desc limit 1",
      [targetUserId],
    )
  ).rows[0];
  await db.query(
    "update staff_invitations set status = 'superseded', revoked_at = now() where user_id = $1 and status = 'pending'",
    [targetUserId],
  );
  const { inviteId, rawToken } = await issueInviteRecord(db, {
    userId: targetUserId,
    workEmail: prof.work_email,
    roles: (lastInvite?.preassigned_roles ?? ["receiver"]) as StaffRole[],
    allowedWarehouses: prof.allowed_warehouse_ids,
    locale: prof.preferred_locale,
    expiryHours: 72,
    actorId: actor.id,
  });
  await audit(db, actor, "resend_staff_invitation", "staff_invitations", inviteId, { user_id: targetUserId });
  return {
    invitation_id: inviteId,
    user_id: targetUserId,
    ...(canReturnActivationTokenInTest() ? { activation_token: rawToken } : {}),
  };
}

export async function revokeStaffInvitation(db: DB, actor: Actor, targetUserId: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const res = await db.query(
    `update staff_invitations set status = 'revoked', revoked_at = now()
     where user_id = $1 and status = 'pending' returning id`,
    [targetUserId],
  );
  guard(res.rowCount && res.rowCount > 0, "INVITATION_NOT_PENDING", "No active pending invitation to revoke.", 409);
  await audit(db, actor, "revoke_staff_invitation", "staff_profiles", targetUserId, { revoked_count: res.rowCount });
  return { revoked: true };
}

/**
 * Strictly read-only GET preview: email link scanners fetching this URL NEVER consume or mutate state (§86.2).
 */
export async function previewStaffInvitation(db: Pick<DB, "query">, token: string) {
  guard(token && token.trim().length >= 16, "INVITATION_INVALID", "Invitation token is missing or invalid.", 400);
  const row = (
    await db.query<{
      id: string;
      employee_no: string;
      target_email: string;
      status: string;
      expires_at: Date;
      preassigned_roles: string[];
      locale: "en-US" | "zh-CN";
      auth_version_snapshot: number;
      current_auth_version: number;
      employment_status: string;
      account_security_status: string;
    }>(
      `select i.id, p.employee_no, i.target_email, i.status, i.expires_at, i.preassigned_roles, i.locale,
              i.auth_version_snapshot, u.auth_version as current_auth_version, p.employment_status, p.account_security_status
       from staff_invitations i
       join staff_profiles p on p.user_id = i.user_id
       join users u on u.id = i.user_id
       where i.token_hash = $1`,
      [hash(token.trim())],
    )
  ).rows[0];
  guard(row, "INVITATION_NOT_FOUND", "Invitation link not found.", 404);
  let effectiveStatus = row.status;
  if (row.status === "pending") {
    if (
      row.auth_version_snapshot !== row.current_auth_version ||
      row.employment_status === "offboarded" ||
      row.account_security_status !== "pending_activation"
    ) {
      effectiveStatus = "revoked";
    } else if (row.expires_at.getTime() <= Date.now()) {
      effectiveStatus = "expired";
    }
  }
  return {
    invitation_id: row.id,
    employee_no: row.employee_no,
    masked_email: row.target_email.replace(/(^.).*(@.*$)/, "$1***$2"),
    preassigned_roles: row.preassigned_roles,
    locale: row.locale,
    status: effectiveStatus,
  };
}

export async function startStaffInvitationMfa(db: DB, token: string) {
  guard(token && token.trim().length >= 16, "INVITATION_INVALID", "Invitation token is invalid.", 400);
  const inv = await one<{
    id: string;
    user_id: string;
    target_email: string;
    status: string;
    expires_at: Date;
    employee_no: string;
    auth_version_snapshot: number;
    current_auth_version: number;
    employment_status: string;
    account_security_status: string;
  }>(
    db,
    `select i.id, i.user_id, i.target_email, i.status, i.expires_at, p.employee_no,
            i.auth_version_snapshot, u.auth_version as current_auth_version,
            p.employment_status, p.account_security_status
     from staff_invitations i
     join staff_profiles p on p.user_id = i.user_id
     join users u on u.id = i.user_id
     where i.token_hash = $1 for update of i, p, u`,
    [hash(token.trim())],
  );
  guard(inv.status === "pending", "INVITATION_UNAVAILABLE", `Invitation is '${inv.status}'.`, 409);
  guard(inv.auth_version_snapshot === inv.current_auth_version, "INVITATION_REVOKED", "Invitation was invalidated by a session or security reset.", 409);
  guard(
    inv.employment_status !== "offboarded" && inv.account_security_status === "pending_activation",
    "INVITATION_UNAVAILABLE",
    "Staff account is not eligible for invitation activation.",
    409,
  );
  guard(inv.expires_at.getTime() > Date.now(), "INVITATION_EXPIRED", "This invitation has expired.", 409);

  const secretHex = randomBytes(20).toString("hex");
  const sealed = seal(secretHex);
  await db.query(
    `update staff_profiles set mfa_secret_ciphertext = $2, updated_at = now() where user_id = $1`,
    [inv.user_id, sealed],
  );
  return {
    invitation_id: inv.id,
    employee_no: inv.employee_no,
    totp_secret_hex: secretHex,
  };
}

function verifyTotpHex(secretHex: string, otp: string): number | null {
  const counter = Math.floor(Date.now() / 30000);
  for (const offset of [-1, 0, 1]) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(counter + offset));
    const h = createHmac("sha1", Buffer.from(secretHex, "hex")).update(bytes).digest();
    const num = (h.readUInt32BE(h[19]! & 15) & 0x7fffffff) % 1000000;
    if (String(num).padStart(6, "0") === otp) {
      return counter + offset;
    }
  }
  return null;
}

export async function acceptStaffInvitation(db: DB, input: z.infer<typeof staffAcceptInviteSchema>) {
  const inv = await one<{
    id: string;
    user_id: string;
    target_email: string;
    status: string;
    expires_at: Date;
    auth_version_snapshot: number;
    current_auth_version: number;
    preassigned_roles: string[];
    allowed_warehouse_ids: string[];
    mfa_secret_ciphertext: Buffer | null;
    employee_no: string;
    employment_status: string;
    account_security_status: string;
  }>(
    db,
    `select i.id, i.user_id, i.target_email, i.status, i.expires_at, i.auth_version_snapshot,
            u.auth_version as current_auth_version, i.preassigned_roles, i.allowed_warehouse_ids,
            p.mfa_secret_ciphertext, p.employee_no, p.employment_status, p.account_security_status
     from staff_invitations i
     join staff_profiles p on p.user_id = i.user_id
     join users u on u.id = i.user_id
     where i.token_hash = $1 for update of i, p, u`,
    [hash(input.token.trim())],
  );
  guard(inv.status === "pending", "INVITATION_UNAVAILABLE", `Invitation is '${inv.status}'.`, 409);
  guard(inv.auth_version_snapshot === inv.current_auth_version, "INVITATION_REVOKED", "Invitation was invalidated by a session or security reset.", 409);
  guard(
    inv.employment_status !== "offboarded" && inv.account_security_status === "pending_activation",
    "INVITATION_UNAVAILABLE",
    "Staff account is not eligible for invitation activation.",
    409,
  );
  guard(inv.expires_at.getTime() > Date.now(), "INVITATION_EXPIRED", "This invitation has expired.", 409);
  guard(inv.mfa_secret_ciphertext, "MFA_SETUP_REQUIRED", "Complete TOTP enrollment setup before activating.", 409);
  const secretHex = unseal(inv.mfa_secret_ciphertext);
  const matchedCounter = verifyTotpHex(secretHex, input.totp_code);
  guard(matchedCounter !== null, "INVALID_TOTP_CODE", "Verification code is invalid.", 422);

  const replayCheck = await db.query(
    "insert into idempotency_keys(scope, key, request_hash) values($1, $2, 'totp') on conflict do nothing",
    [`mfa:${inv.user_id}`, String(matchedCounter)],
  );
  guard(replayCheck.rowCount && replayCheck.rowCount > 0, "INVALID_TOTP_CODE", "Verification code was already consumed.", 409);

  await lock(db, `staff-invite:${inv.target_email.toLowerCase()}`);
  await lock(db, `email:${inv.target_email.toLowerCase()}`);

  const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(6).toString("hex").toUpperCase());
  const recoveryHashes = recoveryCodes.map((c) => hash(c));

  const mfaEnc = Buffer.from(seal(secretHex)).toString("base64url");
  await db.query(
    `update users
     set status = 'active', password_hash = $2, mfa_secret_enc = $3, auth_version = auth_version + 1, updated_at = now()
     where id = $1`,
    [inv.user_id, passwordHash(input.password), mfaEnc],
  );
  const existingPrimaryEmail = await db.query(
    "select id from user_emails where user_id = $1 and is_primary = true limit 1",
    [inv.user_id],
  );
  if (!existingPrimaryEmail.rowCount) {
    const insertedEmail = await db.query(
      `insert into user_emails(user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
       values($1, $2::text, ($2::text)::citext, now(), true, true)
       on conflict (normalized_email) where login_enabled do nothing`,
      [inv.user_id, inv.target_email],
    );
    guard(
      Boolean(insertedEmail.rowCount && insertedEmail.rowCount > 0),
      "EMAIL_CONFLICT",
      "This work email is already registered to another active account.",
      409,
    );
  }
  await db.query("delete from staff_roles where user_id = $1", [inv.user_id]);
  for (const r of inv.preassigned_roles) {
    if (STAFF_ROLES.includes(r as StaffRole)) {
      await db.query("insert into staff_roles(user_id, role) values($1, $2) on conflict do nothing", [inv.user_id, r]);
    }
  }
  await db.query(
    `update staff_profiles
     set employment_status = 'active', account_security_status = 'active',
         mfa_enrolled_at = now(), recovery_code_hashes = $2::text[], updated_at = now()
     where user_id = $1`,
    [inv.user_id, recoveryHashes],
  );
  await db.query("update staff_invitations set status = 'accepted', accepted_at = now() where id = $1", [inv.id]);
  await db.query(
    "insert into account_security_events(user_id, actor_id, kind, outcome, request_id) values($1, $1, 'staff_activated', 'succeeded', $2)",
    [inv.user_id, uuid()],
  );
  await audit(db, { id: inv.user_id, org: null, kind: "staff", roles: inv.preassigned_roles }, "accept_staff_invitation", "staff_profiles", inv.user_id, {
    employee_no: inv.employee_no,
    roles: inv.preassigned_roles,
  });
  await emitCommunicationEvent(db, {
    sourceKind: "security_alert",
    eventType: "staff.activated",
    entityType: "staff_profiles",
    entityId: inv.user_id,
    dedupeKey: `staff.activated:${inv.id}`,
    metadata: { employee_no: inv.employee_no, invitation_id: inv.id },
    createdBy: inv.user_id,
    channels: ["in_app"],
    recipients: [{ userId: inv.user_id, kind: "staff" }],
  });
  await emitActiveSuperAdminEvent(db, {
    sourceKind: "security_alert",
    eventType: "staff.activated",
    entityType: "staff_profiles",
    entityId: inv.user_id,
    dedupeKey: `staff.activated:admin:${inv.id}`,
    metadata: { employee_no: inv.employee_no, invitation_id: inv.id },
    createdBy: inv.user_id,
    channels: ["in_app"],
  });

  return {
    activated: true as const,
    user_id: inv.user_id,
    employee_no: inv.employee_no,
    recovery_codes_once: recoveryCodes,
  };
}

export async function revokeAllStaffSessions(db: DB, actor: Actor, targetUserId: string, reason: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await one(db, "select id from users where id = $1 for update", [targetUserId]);
  const revoked = await db.query(
    "update sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning id",
    [targetUserId],
  );
  const updatedAuth = await one<{ auth_version: number }>(
    db,
    "update users set auth_version = auth_version + 1, updated_at = now() where id = $1 returning auth_version",
    [targetUserId],
  );
  await audit(db, actor, "revoke_staff_sessions", "users", targetUserId, {
    revoked_sessions_count: revoked.rowCount ?? 0,
    reason,
  });
  await emitCommunicationEvent(db, {
    sourceKind: "security_alert",
    eventType: "staff.sessions_revoked",
    entityType: "users",
    entityId: targetUserId,
    entityVersion: updatedAuth.auth_version,
    dedupeKey: `staff.sessions_revoked:${targetUserId}:v${updatedAuth.auth_version}`,
    metadata: { revoked_sessions_count: revoked.rowCount ?? 0, auth_version: updatedAuth.auth_version },
    createdBy: actor.id,
    channels: ["in_app"],
    recipients: [{ userId: targetUserId, kind: "staff" }],
  });
  return { revoked_sessions_count: revoked.rowCount ?? 0 };
}

export async function offboardStaffAccount(
  db: DB,
  actor: Actor,
  targetUserId: string,
  input: z.infer<typeof staffOffboardSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const targetUser = await one<{ id: string; status: string }>(
    db,
    "select id, status from users where id = $1 for update",
    [targetUserId],
  );
  const existingProfile = (
    await db.query<{ employment_status: string }>(
      "select employment_status from staff_profiles where user_id = $1 for update",
      [targetUserId],
    )
  ).rows[0];
  const targetRoles = (
    await db.query<{ role: string }>("select role from staff_roles where user_id = $1", [targetUserId])
  ).rows.map((r) => r.role);
  guard(Boolean(existingProfile) || targetRoles.length > 0, "NOT_STAFF_ACCOUNT", "Only staff accounts can be offboarded.", 422);
  guard(
    (!existingProfile || existingProfile.employment_status !== "offboarded") &&
      !(!existingProfile && targetUser.status === "disabled") &&
      targetUser.status !== "closed",
    "ALREADY_OFFBOARDED",
    "Staff account has already been offboarded.",
    409,
  );
  if (targetRoles.includes("super_admin")) {
    await assertLastOwnerPreserved(db, targetUserId);
  }
  guard(targetUserId !== actor.id, "SELF_OFFBOARD_FORBIDDEN", "An administrator cannot offboard their own account.", 409);

  let handoversCreated = 0;
  if (input.handover_items.length > 0) {
    guard(
      Boolean(input.handover_to_user_id),
      "HANDOVER_DELEGATE_REQUIRED",
      "A handover delegate is required when handover items are provided.",
      422,
    );
  }
  if (input.handover_to_user_id) {
    guard(
      input.handover_to_user_id !== targetUserId,
      "INVALID_HANDOVER_DELEGATE",
      "Cannot hand over items to the departing employee.",
      422,
    );
    const delegate = await one<{ status: string; is_active_staff: boolean }>(
      db,
      `select u.status,
              (exists(select 1 from staff_roles where user_id = u.id)
               or exists(select 1 from staff_profiles where user_id = u.id and employment_status = 'active')) as is_active_staff
       from users u where u.id = $1`,
      [input.handover_to_user_id],
    );
    guard(
      delegate.status === "active" && delegate.is_active_staff,
      "INVALID_HANDOVER_DELEGATE",
      "Handover delegate must be an active staff account.",
      409,
    );
    for (const item of input.handover_items) {
      await db.query(
        `insert into staff_handovers(id, from_user_id, to_user_id, entity_type, entity_id, status, reason, created_by)
         values($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [uuid(), targetUserId, input.handover_to_user_id, item.entity_type, item.entity_id, input.reason, actor.id],
      );
      handoversCreated += 1;
    }
  }

  // Archive staff employment & revoke sessions; NEVER delete historical user/order/audit authorship (§86.4).
  await db.query(
    "update users set status = 'disabled', auth_version = auth_version + 1, updated_at = now() where id = $1",
    [targetUserId],
  );
  await db.query(
    `update staff_profiles
     set employment_status = 'offboarded', account_security_status = 'disabled', offboarded_at = now(), updated_at = now()
     where user_id = $1`,
    [targetUserId],
  );
  await db.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [targetUserId]);
  await db.query(
    "update staff_invitations set status = 'revoked', revoked_at = now() where user_id = $1 and status = 'pending'",
    [targetUserId],
  );
  await db.query(
    "insert into account_security_events(user_id, actor_id, kind, outcome, request_id) values($1, $2, 'staff_offboarded', 'succeeded', $3)",
    [targetUserId, actor.id, uuid()],
  );
  await audit(db, actor, "offboard_staff", "staff_profiles", targetUserId, {
    reason: input.reason,
    handover_count: handoversCreated,
  });
  await emitActiveSuperAdminEvent(db, {
    sourceKind: "security_alert",
    eventType: "staff.offboarded",
    entityType: "staff_profiles",
    entityId: targetUserId,
    dedupeKey: `staff.offboarded:${targetUserId}`,
    metadata: { handover_count: handoversCreated },
    createdBy: actor.id,
    channels: ["in_app"],
  });
  if (input.handover_to_user_id && handoversCreated > 0) {
    await emitCommunicationEvent(db, {
      sourceKind: "auto_event",
      eventType: "staff.handover_assigned",
      entityType: "staff_handovers",
      entityId: targetUserId,
      dedupeKey: `staff.handover_assigned:${targetUserId}:${input.handover_to_user_id}`,
      metadata: { from_user_id: targetUserId, handover_count: handoversCreated },
      createdBy: actor.id,
      channels: ["in_app"],
      recipients: [{ userId: input.handover_to_user_id, kind: "staff" }],
    });
  }
  return { user_id: targetUserId, employment_status: "offboarded" as const, handovers_created: handoversCreated };
}

export async function listStaffDirectory(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin");
  const { rows } = await db.query(
    `select sp.user_id, sp.employee_no, u.display_name, sp.work_email, sp.employment_status,
            sp.account_security_status, sp.preferred_locale, sp.default_warehouse_id,
            sp.allowed_warehouse_ids, sp.mfa_enrolled_at, sp.last_login_at, sp.offboarded_at,
            array(select sr.role from staff_roles sr where sr.user_id = sp.user_id order by sr.role) as roles
     from staff_profiles sp
     join users u on u.id = sp.user_id
     order by sp.created_at desc`,
  );
  return { employees: rows };
}

export async function getStaffDetail(db: Pick<DB, "query">, actor: Actor, userId: string) {
  role(actor, "super_admin");
  const profile = await one(
    db,
    `select sp.user_id, sp.employee_no, u.display_name, sp.work_email, sp.employment_status,
            sp.account_security_status, sp.preferred_locale, sp.default_warehouse_id,
            sp.allowed_warehouse_ids, sp.mfa_enrolled_at, sp.last_login_at, sp.offboarded_at,
            array(select sr.role from staff_roles sr where sr.user_id = sp.user_id order by sr.role) as roles
     from staff_profiles sp join users u on u.id = sp.user_id
     where sp.user_id = $1`,
    [userId],
  );
  const invitations = (
    await db.query(
      `select id, target_email, status, preassigned_roles, expires_at, accepted_at, revoked_at, created_at
       from staff_invitations where user_id = $1 order by created_at desc limit 10`,
      [userId],
    )
  ).rows;
  const handovers = (
    await db.query(
      `select id, from_user_id, to_user_id, entity_type, entity_id, status, reason, created_at
       from staff_handovers where from_user_id = $1 or to_user_id = $1 order by created_at desc limit 20`,
      [userId],
    )
  ).rows;
  return { profile, invitations, handovers };
}
