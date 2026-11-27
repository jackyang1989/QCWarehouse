import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const target = process.env.TEST_DATABASE_URL;
assert(target, "Set TEST_DATABASE_URL to an isolated qcw_test database.");
const targetUrl = URL.parse(target);
assert(targetUrl && ["postgres:", "postgresql:"].includes(targetUrl.protocol), "Expected a PostgreSQL test URL.");
const databaseName = decodeURIComponent(targetUrl.pathname.slice(1));
assert(/^qcw_test(?:-[a-z0-9-]+)?$/.test(databaseName), "Use a dedicated qcw_test database.");
const appDatabase = process.env.DATABASE_URL ? URL.parse(process.env.DATABASE_URL) : null;
assert.notEqual(
  databaseName,
  appDatabase && decodeURIComponent(appDatabase.pathname.slice(1)),
  "The test database must be separate from the application database.",
);

process.env.DATABASE_URL = target;
process.env.QCW_DEMO = "1";
process.env.NODE_ENV = "test";
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const { handle } = await import("../packages/core/http");
const { pool, transaction } = await import("../packages/db");
const { addEmailOtpIdentity } = await import("../packages/core/auth");

before(async () => {
  const actual = await pool.query<{ name: string }>("select current_database() name");
  assert.equal(actual.rows[0].name, databaseName);
  await pool.query("drop schema if exists public cascade; create schema public;");
  for (const args of [
    ["--env-file-if-exists=.env", "scripts/migrate.mjs"],
    ["--env-file-if-exists=.env", "--import", "tsx", "scripts/demo.ts"],
  ]) {
    execFileSync(process.execPath, args, { env: process.env, stdio: "pipe" });
  }
  await pool.query("delete from verification_challenges where target_email::text = any($1::text[])", [
    ["receiving", "inspector", "reviewer", "admin"].map((n) => n + "@qcw.test"),
  ]);
});

after(() => pool.end());

function generateTotp(secretHex: string, offsetSeconds = 0) {
  const counter = Math.floor((Date.now() + offsetSeconds * 1000) / 30000);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", Buffer.from(secretHex, "hex")).update(bytes).digest();
  const num = (h.readUInt32BE(h[19]! & 15) & 0x7fffffff) % 1000000;
  return String(num).padStart(6, "0");
}

class Client {
  private jar = new Map<string, string>();
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200, key = randomUUID()) {
    const csrf = this.jar.get("qcw_csrf");
    const req = new Request(origin + "/api/v1" + path, {
      method,
      headers: {
        cookie: [...this.jar].map(([k, v]) => k + "=" + v).join("; "),
        ...(method !== "GET"
          ? {
              origin,
              "Idempotency-Key": key,
              ...(csrf ? { "x-csrf-token": csrf } : {}),
              "content-type": "application/json",
            }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const res = await handle(req, path.split("?")[0]);
    for (const c of res.headers.getSetCookie()) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) this.jar.set(m[1], m[2]);
    }
    const data = await res.json();
    assert.equal(res.status, expected, path + " " + JSON.stringify(data));
    return data;
  }
  async loginOtp(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
}

async function createSuperAdmin(prefix: string) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@qcw.test`;
  const userId = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id,display_name,locale) values($1,$2,'zh-CN')", [userId, "Second Admin"]);
    const ver = await db.query<{ id: string }>(
      `insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
       values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,
      [userId, email],
    );
    await addEmailOtpIdentity(db, userId, ver.rows[0].id);
    await db.query("insert into staff_roles(user_id,role) values($1,'super_admin')", [userId]);
  });
  const c = new Client();
  await c.loginOtp(email);
  return { client: c, userId, email };
}

test("TASK-179 & TASK-180: staff invite/MFA/offboard lifecycle and dynamic RBAC with instant revocation", async () => {
  const admin = new Client();
  await admin.loginOtp("admin@qcw.test");
  const { client: admin2 } = await createSuperAdmin("owner-rbac");
  const receiver = new Client();
  await receiver.loginOtp("receiving@qcw.test");

  // Non-super_admin cannot invite staff or manage RBAC
  await receiver.fetch("/staff/admin/employees", undefined, "GET", 403);
  await receiver.fetch("/staff/admin/rbac/roles", undefined, "GET", 403);

  // Email collision against existing account rejected 409
  await admin.fetch(
    "/staff/admin/employees",
    {
      display_name: "Duplicate Email Staff",
      work_email: "receiving@qcw.test",
      roles: ["receiver"],
      allowed_warehouse_ids: ["wh-sz-01"],
    },
    "POST",
    409,
  );

  // 1) Admin invites new inspector (with multi-warehouse profile scope)
  const workEmail = `new-insp-${randomUUID().slice(0, 6)}@qcw.test`;
  const invited = await admin.fetch(
    "/staff/admin/employees",
    {
      display_name: "Zhang Wei Inspector",
      work_email: workEmail,
      roles: ["inspector"],
      allowed_warehouse_ids: ["wh-sz-01", "wh-gz-02"],
      default_warehouse_id: "wh-sz-01",
      locale: "zh-CN",
    },
    "POST",
    201,
  );
  assert.equal(invited.employment_status, "pending_onboarding");
  assert.ok(invited.activation_token);

  // Verify email_deliveries queued for staff.invited on invite
  const queuedDeliveries = (
    await pool.query<{ count: string }>(
      `select count(*)::text as count
       from email_deliveries d join notifications n on n.id = d.notification_id
       where n.user_id = $1 and n.template = 'staff.invited'`,
      [invited.user_id],
    )
  ).rows[0];
  assert.equal(Number(queuedDeliveries.count), 1);

  // GET employee detail NEVER echoes activation tokens or hashes
  const detail = await admin.fetch(`/staff/admin/employees/${invited.user_id}`);
  assert.equal(detail.invitations.length, 1);
  assert.equal("token_hash" in detail.invitations[0], false);

  // Read-only GET preview is email-scanner safe (non-consuming)
  const anon = new Client();
  const prev1 = await anon.fetch(`/staff/invitations/preview?token=${encodeURIComponent(invited.activation_token)}`);
  const prev2 = await anon.fetch(`/staff/invitations/preview?token=${encodeURIComponent(invited.activation_token)}`);
  assert.equal(prev1.status, "pending");
  assert.equal(prev2.status, "pending");

  // Resend supersedes old invitation, enqueues a second delivery & issues a new valid token
  const resent = await admin.fetch(`/staff/admin/employees/${invited.user_id}/invitations/resend`, {});
  await anon.fetch("/staff/invitations/start-mfa", { token: invited.activation_token }, "POST", 409);
  const queuedAfterResend = (
    await pool.query<{ count: string }>(
      `select count(*)::text as count
       from email_deliveries d join notifications n on n.id = d.notification_id
       where n.user_id = $1 and n.template = 'staff.invited'`,
      [invited.user_id],
    )
  ).rows[0];
  assert.equal(Number(queuedAfterResend.count), 2);

  // Enroll TOTP & accept activation with strong password + live TOTP; verify hashed recovery codes at rest
  const mfaSetup = await anon.fetch("/staff/invitations/start-mfa", { token: resent.activation_token });
  const totpEnrollCode = generateTotp(mfaSetup.totp_secret_hex, -30); // use offset slot -30s so real login slot (0s) stays unconsumed
  const password = "StrongStaff!Password2026";
  const accepted = await anon.fetch("/staff/invitations/accept", {
    token: resent.activation_token,
    password,
    totp_code: totpEnrollCode,
  });
  assert.equal(accepted.activated, true);
  assert.equal(accepted.recovery_codes_once.length, 8);
  const storedProfile = (
    await pool.query<{ recovery_code_hashes: string[] }>(
      "select recovery_code_hashes from staff_profiles where user_id = $1",
      [invited.user_id],
    )
  ).rows[0];
  assert.equal(storedProfile.recovery_code_hashes.length, 8);
  for (const plain of accepted.recovery_codes_once) {
    assert.equal(storedProfile.recovery_code_hashes.includes(plain), false);
  }

  // Expired, revoked, auth_version-invalidated & email-conflict invitation guards
  const expiredInvite = await admin.fetch(
    "/staff/admin/employees",
    { display_name: "Expired Staff", work_email: `exp-${randomUUID().slice(0, 6)}@qcw.test`, roles: ["receiver"] },
    "POST",
    201,
  );
  await pool.query("update staff_invitations set expires_at = now() - interval '2 hours' where id = $1", [
    expiredInvite.invitation_id,
  ]);
  const expPreview = await anon.fetch(`/staff/invitations/preview?token=${encodeURIComponent(expiredInvite.activation_token)}`);
  assert.equal(expPreview.status, "expired");
  await anon.fetch("/staff/invitations/start-mfa", { token: expiredInvite.activation_token }, "POST", 409);
  await anon.fetch(
    "/staff/invitations/accept",
    { token: expiredInvite.activation_token, password, totp_code: "123456" },
    "POST",
    409,
  );

  const revokableInvite = await admin.fetch(
    "/staff/admin/employees",
    { display_name: "Revoked Staff", work_email: `rev-${randomUUID().slice(0, 6)}@qcw.test`, roles: ["receiver"] },
    "POST",
    201,
  );
  await admin.fetch(`/staff/admin/employees/${revokableInvite.user_id}/invitations/revoke`, {});
  await anon.fetch("/staff/invitations/start-mfa", { token: revokableInvite.activation_token }, "POST", 409);

  // Revoke-sessions bumps auth_version, invalidates any open invitation snapshot
  const versionResetInvite = await admin.fetch(
    "/staff/admin/employees",
    { display_name: "Reset Invite Staff", work_email: `rst-${randomUUID().slice(0, 6)}@qcw.test`, roles: ["receiver"] },
    "POST",
    201,
  );
  await admin.fetch(`/staff/admin/employees/${versionResetInvite.user_id}/revoke-sessions`, { reason: "Security reset" });
  const rstPreview = await anon.fetch(
    `/staff/invitations/preview?token=${encodeURIComponent(versionResetInvite.activation_token)}`,
  );
  assert.equal(rstPreview.status, "revoked");
  await anon.fetch("/staff/invitations/start-mfa", { token: versionResetInvite.activation_token }, "POST", 409);

  // Email race conflict during acceptStaffInvitation fails loudly with 409 EMAIL_CONFLICT
  const conflictEmail = `conflict-${randomUUID().slice(0, 6)}@qcw.test`;
  const conflictInvite = await admin.fetch(
    "/staff/admin/employees",
    { display_name: "Conflict Staff", work_email: conflictEmail, roles: ["receiver"] },
    "POST",
    201,
  );
  const conflictMfa = await anon.fetch("/staff/invitations/start-mfa", { token: conflictInvite.activation_token });
  const squatterId = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id, display_name, locale) values($1, 'Squatter', 'en')", [squatterId]);
    await db.query(
      `insert into user_emails(user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
       values($1, $2::text, ($2::text)::citext, now(), true, true)`,
      [squatterId, conflictEmail],
    );
  });
  const conflictAccept = await anon.fetch(
    "/staff/invitations/accept",
    { token: conflictInvite.activation_token, password, totp_code: generateTotp(conflictMfa.totp_secret_hex) },
    "POST",
    409,
  );
  assert.equal(conflictAccept.error.code, "EMAIL_CONFLICT");

  // Replay accept rejected 409
  await anon.fetch(
    "/staff/invitations/accept",
    { token: resent.activation_token, password, totp_code: generateTotp(mfaSetup.totp_secret_hex) },
    "POST",
    409,
  );

  // Sign in via REAL production /staff/auth/login (password + TOTP)
  const staffSession = new Client();
  const loginRes = await staffSession.fetch("/staff/auth/login", {
    email: workEmail,
    password,
    otp: generateTotp(mfaSetup.totp_secret_hex),
  });
  assert.equal(loginRes.kind, "staff");

  // Revoke invitation on already-active staff is 409
  await admin.fetch(`/staff/admin/employees/${invited.user_id}/invitations/revoke`, {}, "POST", 409);

  // 2) TASK-180: Dynamic RBAC custom role lifecycle + scope intersection + instant session revocation
  const rolesHub = await admin.fetch("/staff/admin/rbac/roles");
  assert.ok(rolesHub.roles.filter((r: { is_system_preset: boolean }) => r.is_system_preset).length >= 8);

  // Reject arbitrary unknown permission string & reserved preset code
  await admin.fetch(
    "/staff/admin/rbac/roles",
    {
      role_code: "bad_custom",
      display_name_zh: "非法角色",
      display_name_en: "Bad Custom",
      permissions: ["hack.everything"],
    },
    "POST",
    422,
  );
  await admin.fetch(
    "/staff/admin/rbac/roles",
    {
      role_code: "super_admin",
      display_name_zh: "伪造超管",
      display_name_en: "Spoof Owner",
      permissions: ["warehouse.intake"],
    },
    "POST",
    409,
  );

  // Admin creates custom role, SoD blocks self-publish, Admin2 publishes cleanly
  const customDraft = await admin.fetch(
    "/staff/admin/rbac/roles",
    {
      role_code: "packer_specialist",
      display_name_zh: "拣货打包专员",
      display_name_en: "Packer Specialist",
      permissions: ["logistics.pick_pack", "warehouse.move"],
    },
    "POST",
    201,
  );
  await admin.fetch(`/staff/admin/rbac/roles/${customDraft.id}/publish`, { reason: "Self publish" }, "POST", 403);

  const impact = await admin2.fetch(`/staff/admin/rbac/roles/${customDraft.id}/impact`);
  assert.equal(impact.role_code, "packer_specialist");
  const publishedRole = await admin2.fetch(`/staff/admin/rbac/roles/${customDraft.id}/publish`, {
    reason: "Approved specialist role for warehouse sorting",
  });
  assert.equal(publishedRole.status, "active");

  // Assign custom role with stricter warehouse scope ["wh-sz-01"] -> revokes existing staffSession instantaneously
  await admin.fetch("/staff/admin/rbac/assignments", {
    user_id: invited.user_id,
    role_id: customDraft.id,
    warehouse_scope: ["wh-sz-01"],
  });
  await staffSession.fetch("/staff/me/effective-permissions", undefined, "GET", 401);

  // Re-login via /staff/auth/login (slot +30s) & verify unified effective permissions + intersected warehouse scope
  const refreshedSession = new Client();
  await refreshedSession.fetch("/staff/auth/login", {
    email: workEmail,
    password,
    otp: generateTotp(mfaSetup.totp_secret_hex, 30),
  });
  const effective = await refreshedSession.fetch("/staff/me/effective-permissions");
  assert.equal(effective.permissions.includes("qc.execute"), true);
  assert.equal(effective.permissions.includes("logistics.pick_pack"), true);
  assert.deepEqual(effective.allowed_warehouse_ids, ["wh-sz-01"]);
  assert.equal(effective.mobile_modules.includes("mobile_pack_handover"), true);

  // Blocking archive & custom assignment on preset role, or archive on active custom role with assignments
  const presetRole = rolesHub.roles.find((r: { role_code: string }) => r.role_code === "receiver");
  const ownerPreset = rolesHub.roles.find((r: { role_code: string }) => r.role_code === "super_admin");
  await admin.fetch(`/staff/admin/rbac/roles/${presetRole.id}/archive`, {}, "POST", 409);
  await admin.fetch(`/staff/admin/rbac/roles/${customDraft.id}/archive`, {}, "POST", 409);
  await admin.fetch("/staff/admin/rbac/assignments", { user_id: invited.user_id, role_id: ownerPreset.id }, "POST", 409);

  // Reject assigning custom RBAC role to customer account (422) & enforce disjoint multi-role warehouse intersection + re-publish revocation
  const customerId = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id, display_name, locale) values($1, 'Non Staff Customer', 'en')", [customerId]);
  });
  await admin.fetch(
    "/staff/admin/rbac/assignments",
    { user_id: customerId, role_id: publishedRole.id, warehouse_scope: ["wh-sz-01"] },
    "POST",
    422,
  );
  const roleB = await admin.fetch(
    "/staff/admin/rbac/roles",
    {
      role_code: "sorting_auditor",
      display_name_zh: "分拣复核专员",
      display_name_en: "Sorting Auditor",
      permissions: ["warehouse.move"],
    },
    "POST",
    201,
  );
  await admin2.fetch(`/staff/admin/rbac/roles/${roleB.id}/publish`, { reason: "Approve disjoint role test" });
  const receiverId = (await receiver.fetch("/me")).actor.id;
  await admin.fetch("/staff/admin/rbac/assignments", {
    user_id: receiverId,
    role_id: publishedRole.id,
    warehouse_scope: ["wh-sz-02"],
  });
  await receiver.fetch("/staff/me/effective-permissions", undefined, "GET", 401);
  const receiverRefreshed = new Client();
  await receiverRefreshed.loginOtp("receiving@qcw.test");
  const receiverEffective = await receiverRefreshed.fetch("/staff/me/effective-permissions");
  assert.deepEqual(receiverEffective.allowed_warehouse_ids, ["wh-sz-02"]);

  // Assigning a disjoint warehouse scope ["wh-bj-03"] narrows intersection to [] (never resurrects warehouses)
  await admin.fetch("/staff/admin/rbac/assignments", {
    user_id: receiverId,
    role_id: roleB.id,
    warehouse_scope: ["wh-bj-03"],
  });
  const receiverDisjoint = new Client();
  await receiverDisjoint.loginOtp("receiving@qcw.test");
  const disjointEffective = await receiverDisjoint.fetch("/staff/me/effective-permissions");
  assert.deepEqual(disjointEffective.allowed_warehouse_ids, []);

  // Re-publishing active custom role (v2) immediately revokes active sessions of assigned staff
  await admin2.fetch(`/staff/admin/rbac/roles/${roleB.id}/publish`, { reason: "v2 publish revokes active staff sessions" });
  await receiverDisjoint.fetch("/staff/me/effective-permissions", undefined, "GET", 401);

  // Explicit revoke-sessions endpoint terminates an active session immediately
  const receiverRevokeTarget = new Client();
  await receiverRevokeTarget.loginOtp("receiving@qcw.test");
  await admin.fetch(`/staff/admin/employees/${receiverId}/revoke-sessions`, { reason: "Manual emergency session cut" });
  await receiverRevokeTarget.fetch("/staff/me/effective-permissions", undefined, "GET", 401);

  await admin.fetch("/staff/admin/rbac/assignments", { user_id: receiverId, role_id: publishedRole.id }, "DELETE", 200);
  await admin.fetch("/staff/admin/rbac/assignments", { user_id: receiverId, role_id: roleB.id }, "DELETE", 200);

  // Removing assignment revokes old session & allows archiving cleanly
  await admin.fetch("/staff/admin/rbac/assignments", { user_id: invited.user_id, role_id: customDraft.id }, "DELETE", 200);
  await refreshedSession.fetch("/staff/me/effective-permissions", undefined, "GET", 401);
  const archivedRole = await admin.fetch(`/staff/admin/rbac/roles/${customDraft.id}/archive`, {});
  assert.equal(archivedRole.status, "archived");

  // 3) Offboarding preserves historical user record, creates handovers, validates delegates & enforces last-Owner protection
  const adminMe = await admin.fetch("/me");
  const selfOffboardAttempt = await admin.fetch(
    `/staff/admin/employees/${adminMe.actor.id}/offboard`,
    { reason: "Self offboard attempt" },
    "POST",
    409,
  );
  assert.equal(selfOffboardAttempt.error.code, "SELF_OFFBOARD_FORBIDDEN");
  await admin.fetch(`/staff/admin/employees/${customerId}/offboard`, { reason: "Not staff" }, "POST", 422);
  await admin.fetch(
    `/staff/admin/employees/${invited.user_id}/offboard`,
    { reason: "Missing delegate", handover_items: [{ entity_type: "inspection_task", entity_id: "t1" }] },
    "POST",
    422,
  );
  await admin.fetch(
    `/staff/admin/employees/${invited.user_id}/offboard`,
    {
      reason: "Self handover",
      handover_to_user_id: invited.user_id,
      handover_items: [{ entity_type: "inspection_task", entity_id: "t1" }],
    },
    "POST",
    422,
  );
  await admin.fetch(
    `/staff/admin/employees/${invited.user_id}/offboard`,
    {
      reason: "Customer delegate",
      handover_to_user_id: customerId,
      handover_items: [{ entity_type: "inspection_task", entity_id: "t1" }],
    },
    "POST",
    409,
  );

  await transaction(async (db) => {
    const emailRow = await db.query<{ id: string }>(
      "select id from user_emails where user_id = $1 and is_primary = true",
      [invited.user_id],
    );
    await addEmailOtpIdentity(db, invited.user_id, emailRow.rows[0].id);
  });
  const newLogin = new Client();
  await newLogin.loginOtp(workEmail);
  const offboarded = await admin.fetch(`/staff/admin/employees/${invited.user_id}/offboard`, {
    reason: "Employee resignation handover complete",
    handover_to_user_id: adminMe.actor.id,
    handover_items: [{ entity_type: "inspection_task", entity_id: "task-001" }],
  });
  assert.equal(offboarded.employment_status, "offboarded");
  assert.equal(offboarded.handovers_created, 1);
  await newLogin.fetch("/staff/me/effective-permissions", undefined, "GET", 401);
  await admin.fetch(`/staff/admin/employees/${invited.user_id}/offboard`, { reason: "Double offboard attempt" }, "POST", 409);
  await admin.fetch("/staff/admin/rbac/assignments", { user_id: invited.user_id, role_id: roleB.id }, "POST", 409);

  // Preserved user row & audit_events after offboard
  const preservedRows = (
    await pool.query<{ ucount: string; acount: string }>(
      `select
         (select count(*)::text from users where id = $1) as ucount,
         (select count(*)::text from audit_events where entity_id = $1 and action = 'offboard_staff') as acount`,
      [invited.user_id],
    )
  ).rows[0];
  assert.equal(Number(preservedRows.ucount), 1);
  assert.equal(Number(preservedRows.acount), 1);

  // Legacy staff (no staff_profiles row) offboards once cleanly, blocks second offboard & blocks custom RBAC assignment
  await admin.fetch(`/staff/admin/employees/${receiverId}/offboard`, { reason: "Legacy offboard" });
  await admin.fetch(`/staff/admin/employees/${receiverId}/offboard`, { reason: "Legacy double offboard" }, "POST", 409);
  await admin.fetch("/staff/admin/rbac/assignments", { user_id: receiverId, role_id: roleB.id }, "POST", 409);

  // Offboarding admin2 leaves admin as sole super_admin, whose removal hits LAST_OWNER_PROTECTED
  const admin2Me = await admin2.fetch("/me");
  await admin.fetch(`/staff/admin/employees/${admin2Me.actor.id}/offboard`, { reason: "Leave single owner" });
  const lastOwnerBlock = await admin.fetch(
    `/staff/admin/employees/${adminMe.actor.id}/offboard`,
    { reason: "Attempt removing sole remaining owner" },
    "POST",
    409,
  );
  assert.equal(lastOwnerBlock.error.code, "LAST_OWNER_PROTECTED");
});
