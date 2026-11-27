import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "../db";
import { audit, guard, one, organization, Problem, role, uuid, type Actor } from "./common";
import { resolveConfiguredWriteProvider } from "./storage-hub";
import {
  abortStorageUpload,
  ALLOWED_STORAGE_MIMES,
  authorizeStorageUpload,
  completeStorageUpload,
  completeStorageUploadSchema,
  getRuntimeObjectStorageProvider,
  reissueStorageUploadSession,
  resolveObjectStorageProviderForRead,
} from "./storage-service";

const STAFF_CAPTURE_ROLES = [
  "receiver",
  "inspector",
  "reviewer",
  "warehouse_admin",
  "support",
  "super_admin",
  "template_admin",
] as const;

const QA_RESOLVE_ROLES = ["reviewer", "warehouse_admin", "super_admin"] as const;
const CLOCK_SKEW_THRESHOLD_MS = 120_000;

export const EVIDENCE_SOURCE_TYPES = [
  "pc_remote_mobile",
  "mobile_local_capture",
  "pc_camera_capture",
  "gallery_file_import",
  "customer_attachment",
  "legacy_migration",
  "system_derived",
  "device_test",
] as const;

export const EVIDENCE_PURPOSES = [
  "receiving_outer",
  "receiving_open",
  "unmatched_package",
  "inspection_shot",
  "inspection_measurement",
  "inspection_defect",
  "comparison_group",
  "golden_sample_baseline",
  "stocktake",
  "storage_move",
  "incident",
  "packing_dispatch",
  "after_sales",
  "customer_reference",
  "device_test",
] as const;

export const TIME_SOURCES = [
  "device_monotonic_calibrated",
  "device_wall_clock",
  "exif_metadata",
  "user_declared",
  "legacy_migrated",
  "unknown",
] as const;

export const LINK_ENTITY_TYPES = [
  "org",
  "order",
  "package",
  "warehouse_item",
  "comparison_group",
  "golden_sample",
  "work_item",
  "inspection_task",
  "measurement_attempt",
  "defect",
  "stocktake",
  "incident",
  "shipment",
  "ticket",
  "report_version",
  "device_test",
] as const;

export const LINK_ROLES = [
  "primary_capture",
  "post_bind_owner",
  "comparison_member",
  "qa_selected",
  "report_citation",
  "reshoot_replacement",
  "audit_reference",
] as const;

export const issueCaptureCommandSchema = z.object({
  command_key: z.string().trim().min(3).max(120),
  source_type: z.enum(EVIDENCE_SOURCE_TYPES),
  capture_mode: z.enum(["photo", "burst", "video", "import", "device_test"]),
  evidence_purpose: z.enum(EVIDENCE_PURPOSES),
  org_id: z.uuid().nullable().optional(),
  order_id: z.uuid().nullable().optional(),
  package_id: z.uuid().nullable().optional(),
  warehouse_item_id: z.uuid().nullable().optional(),
  comparison_member_ids: z.array(z.uuid()).max(20).optional(),
  work_item_id: z.uuid().nullable().optional(),
  inspection_task_id: z.uuid().nullable().optional(),
  checkpoint_code: z.string().trim().max(80).nullable().optional(),
  measurement_attempt_id: z.uuid().nullable().optional(),
  defect_id: z.uuid().nullable().optional(),
  warehouse_id: z.uuid().nullable().optional(),
  workstation_id: z.uuid().nullable().optional(),
  device_id: z.uuid().nullable().optional(),
  camera_role: z.string().trim().max(40).nullable().optional(),
  control_lease_id: z.uuid().nullable().optional(),
  preset_version: z.string().trim().max(40).nullable().optional(),
  capture_params: z.record(z.string(), z.unknown()).optional(),
  expires_in_seconds: z.number().int().min(30).max(3600).default(900),
});

export const cancelCaptureCommandSchema = z.object({
  reason: z.string().trim().min(2).max(400),
});

export const authorizeEvidenceUploadSchema = z.object({
  capture_key: z.string().trim().min(3).max(120),
  command_id: z.uuid().nullable().optional(),
  burst_sequence: z.number().int().min(1).max(200).nullable().optional(),
  source_type: z.enum(EVIDENCE_SOURCE_TYPES),
  evidence_purpose: z.enum(EVIDENCE_PURPOSES),
  media_kind: z.enum(["photo", "video", "document"]),
  declared_mime: z.enum(ALLOWED_STORAGE_MIMES),
  size_bytes: z.number().int().min(1).max(2_000_000_000),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform((v) => v.toLowerCase()),
  upload_mode: z.enum(["presigned_put", "multipart"]).default("presigned_put"),
  expected_parts: z.number().int().min(1).max(1000).optional(),
  part_size_bytes: z.number().int().min(1).max(100_000_000).optional(),
  original_filename: z.string().trim().max(200).nullable().optional(),
  device_id: z.uuid().nullable().optional(),
  actual_captured_at: z.iso.datetime({ offset: true }).nullable().optional(),
  video_started_at: z.iso.datetime({ offset: true }).nullable().optional(),
  video_ended_at: z.iso.datetime({ offset: true }).nullable().optional(),
  actual_duration_ms: z.number().int().min(0).max(86_400_000).nullable().optional(),
  time_source: z.enum(TIME_SOURCES),
  time_unknown_reason: z.string().trim().min(2).max(200).nullable().optional(),
  device_timezone: z.string().trim().max(64).nullable().optional(),
  device_clock_offset_ms: z.number().int().min(-315_360_000_000).max(315_360_000_000).nullable().optional(),
  offline_captured: z.boolean().default(false),
  retention_days: z.number().int().min(1).max(3650).nullable().optional(),
  legal_hold: z.boolean().default(false),
  order_id: z.uuid().nullable().optional(),
  package_id: z.uuid().nullable().optional(),
  warehouse_item_id: z.uuid().nullable().optional(),
  comparison_member_ids: z.array(z.uuid()).max(20).optional(),
  work_item_id: z.uuid().nullable().optional(),
  inspection_task_id: z.uuid().nullable().optional(),
});

export const linkEvidenceSchema = z.object({
  entity_type: z.enum(LINK_ENTITY_TYPES),
  entity_id: z.uuid(),
  link_role: z.enum(LINK_ROLES),
  org_id: z.uuid().nullable().optional(),
  execution_generation: z.number().int().min(1).nullable().optional(),
  reason: z.string().trim().min(2).max(400).optional(),
});

export const resolveQuarantineEvidenceSchema = z.object({
  decision: z.enum(["accept_preserving_author", "reject_reshoot"]),
  note: z.string().trim().min(2).max(400),
});

interface BusinessContextResult {
  orgId: string | null;
  orderId: string | null;
  packageId: string | null;
  warehouseItemId: string | null;
  comparisonMemberIds: string[];
  workItemId: string | null;
  inspectionTaskId: string | null;
  executionGeneration: number | null;
  warehouseId: string | null;
  workstationId: string | null;
  snapshot: Record<string, unknown>;
}

async function resolveAndValidateBusinessContext(
  db: DB,
  actor: Actor,
  input: {
    source_type?: (typeof EVIDENCE_SOURCE_TYPES)[number];
    evidence_purpose: (typeof EVIDENCE_PURPOSES)[number];
    org_id?: string | null;
    order_id?: string | null;
    package_id?: string | null;
    warehouse_item_id?: string | null;
    comparison_member_ids?: string[];
    work_item_id?: string | null;
    inspection_task_id?: string | null;
    warehouse_id?: string | null;
    workstation_id?: string | null;
  },
): Promise<BusinessContextResult> {
  const isDeviceTest = input.evidence_purpose === "device_test" || input.source_type === "device_test";
  if (isDeviceTest) {
    guard(
      input.evidence_purpose === "device_test" && (!input.source_type || input.source_type === "device_test"),
      "DEVICE_TEST_CONTEXT_FORBIDDEN",
      "device_test source_type and evidence_purpose must match cleanly.",
      422,
    );
    guard(
      !input.order_id &&
        !input.package_id &&
        !input.warehouse_item_id &&
        !(input.comparison_member_ids?.length) &&
        !input.work_item_id &&
        !input.inspection_task_id &&
        !input.org_id,
      "DEVICE_TEST_CONTEXT_FORBIDDEN",
      "Device test captures must not attach to customer orders, packages, items, or inspection tasks.",
      422,
    );
    return {
      orgId: null,
      orderId: null,
      packageId: null,
      warehouseItemId: null,
      comparisonMemberIds: [],
      workItemId: null,
      inspectionTaskId: null,
      executionGeneration: null,
      warehouseId: input.warehouse_id ?? null,
      workstationId: input.workstation_id ?? null,
      snapshot: { purpose: "device_test", non_business: true },
    };
  }

  let orgId = input.org_id ?? null;
  if (actor.kind === "customer") {
    const custOrg = organization(actor);
    guard(orgId === null || orgId === custOrg, "NOT_FOUND", "Organization not found.", 404);
    guard(
      !input.work_item_id && !input.inspection_task_id && !(input.comparison_member_ids?.length) && !input.warehouse_id && !input.workstation_id,
      "FORBIDDEN",
      "Customers cannot bind uploads to warehouse tasks, work items, or workstations.",
      403,
    );
    orgId = custOrg;
  }
  let orderId = input.order_id ?? null;
  const packageId = input.package_id ?? null;
  const warehouseItemId = input.warehouse_item_id ?? null;
  const comparisonMemberIds = input.comparison_member_ids ?? [];
  const workItemId = input.work_item_id ?? null;
  let inspectionTaskId = input.inspection_task_id ?? null;
  let executionGeneration: number | null = null;
  let warehouseId = input.warehouse_id ?? null;
  let workstationId = input.workstation_id ?? null;

  if (orderId) {
    const ord = await one<{ id: string; org_id: string; state: string; public_no: string }>(
      db,
      "select id, org_id, state, public_no from orders where id = $1",
      [orderId],
    );
    if (actor.kind === "customer") {
      guard(ord.org_id === organization(actor), "NOT_FOUND", "Order not found.", 404);
    }
    guard(orgId === null || orgId === ord.org_id, "EVIDENCE_ORG_MISMATCH", "Order organization mismatch.", 422);
    orgId = ord.org_id;
  }

  if (packageId) {
    const pkg = await one<{ id: string; org_id: string | null; code: string; state: string }>(
      db,
      "select id, org_id, code, state from packages where id = $1",
      [packageId],
    );
    if (actor.kind === "customer") {
      guard(pkg.org_id === organization(actor), "NOT_FOUND", "Package not found.", 404);
    }
    if (pkg.org_id) {
      guard(orgId === null || orgId === pkg.org_id, "EVIDENCE_ORG_MISMATCH", "Package organization mismatch.", 422);
      orgId = pkg.org_id;
    }
  }

  if (warehouseItemId) {
    const item = await one<{ id: string; org_id: string | null; code: string; identity_state: string; custody_state: string }>(
      db,
      "select id, org_id, code, identity_state, custody_state from warehouse_items where id = $1",
      [warehouseItemId],
    );
    if (actor.kind === "customer") {
      guard(item.org_id === organization(actor), "NOT_FOUND", "Item not found.", 404);
    }
    if (item.org_id) {
      guard(orgId === null || orgId === item.org_id, "EVIDENCE_ORG_MISMATCH", "Warehouse item organization mismatch.", 422);
      orgId = item.org_id;
    }
  }

  for (const memberId of comparisonMemberIds) {
    const m = await one<{ id: string; org_id: string | null }>(
      db,
      "select id, org_id from warehouse_items where id = $1",
      [memberId],
    );
    if (actor.kind === "customer") {
      guard(m.org_id === organization(actor), "NOT_FOUND", "Item not found.", 404);
    }
    if (m.org_id) {
      guard(orgId === null || orgId === m.org_id, "EVIDENCE_ORG_MISMATCH", "Comparison member belongs to a different organization.", 422);
      orgId = m.org_id;
    }
  }

  if (workItemId) {
    const wi = await one<{
      id: string;
      warehouse_id: string;
      workstation_id: string | null;
      inspection_task_id: string | null;
      execution_generation: number;
      dispatch_status: string;
    }>(
      db,
      `select id, warehouse_id, workstation_id, inspection_task_id, execution_generation, dispatch_status
       from dispatch_work_items where id = $1 for share`,
      [workItemId],
    );
    executionGeneration = wi.execution_generation;
    warehouseId = warehouseId ?? wi.warehouse_id;
    workstationId = workstationId ?? wi.workstation_id;
    if (wi.inspection_task_id) {
      guard(
        inspectionTaskId === null || inspectionTaskId === wi.inspection_task_id,
        "WORK_ITEM_TASK_MISMATCH",
        "Work item points to a different inspection task.",
        422,
      );
      inspectionTaskId = wi.inspection_task_id;
    }
  }

  if (inspectionTaskId) {
    const task = await one<{ id: string; order_id: string; org_id: string; execution_generation: number; state: string }>(
      db,
      `select t.id, l.order_id, l.org_id, t.execution_generation, t.state
       from inspection_tasks t join order_lines l on l.id = t.order_line_id
       where t.id = $1 for share`,
      [inspectionTaskId],
    );
    if (actor.kind === "customer") {
      guard(task.org_id === organization(actor), "NOT_FOUND", "Inspection task not found.", 404);
    }
    guard(orgId === null || orgId === task.org_id, "EVIDENCE_ORG_MISMATCH", "Task organization mismatch.", 422);
    guard(orderId === null || orderId === task.order_id, "EVIDENCE_ORDER_MISMATCH", "Task order mismatch.", 422);
    orgId = task.org_id;
    orderId = task.order_id;
    executionGeneration = executionGeneration ?? task.execution_generation;
  }

  if (["inspection_shot", "inspection_measurement", "inspection_defect"].includes(input.evidence_purpose)) {
    guard(Boolean(inspectionTaskId || workItemId), "EVIDENCE_TASK_REQUIRED", "Inspection evidence requires an inspection_task_id or work_item_id.", 422);
  }
  if (input.evidence_purpose === "comparison_group") {
    guard(
      comparisonMemberIds.length >= 2 && Boolean(inspectionTaskId || orderId),
      "COMPARISON_MEMBERS_REQUIRED",
      "Comparison group evidence requires at least 2 valid comparison_member_ids and a task or order.",
      422,
    );
  }
  if (["receiving_outer", "receiving_open", "unmatched_package"].includes(input.evidence_purpose)) {
    guard(Boolean(packageId), "PACKAGE_REQUIRED", "Receiving or unmatched package evidence requires package_id.", 422);
  }

  return {
    orgId,
    orderId,
    packageId,
    warehouseItemId,
    comparisonMemberIds,
    workItemId,
    inspectionTaskId,
    executionGeneration,
    warehouseId,
    workstationId,
    snapshot: {
      purpose: input.evidence_purpose,
      org_id: orgId,
      order_id: orderId,
      package_id: packageId,
      warehouse_item_id: warehouseItemId,
      comparison_member_ids: comparisonMemberIds,
      work_item_id: workItemId,
      inspection_task_id: inspectionTaskId,
      execution_generation: executionGeneration,
    },
  };
}

export async function issueCaptureCommand(
  db: DB,
  actor: Actor,
  rawInput: z.infer<typeof issueCaptureCommandSchema>,
) {
  role(actor, ...STAFF_CAPTURE_ROLES);
  const input = issueCaptureCommandSchema.parse(rawInput);

  const existing = (
    await db.query(
      "select * from capture_commands where command_key = $1",
      [input.command_key],
    )
  ).rows[0];
  if (existing) {
    guard(
      existing.source_type === input.source_type && existing.evidence_purpose === input.evidence_purpose,
      "COMMAND_KEY_CONFLICT",
      "Command key already exists with a different source_type or evidence_purpose.",
      409,
    );
    return { replayed: true, command: existing };
  }

  const biz = await resolveAndValidateBusinessContext(db, actor, input);

  let deviceAuthGeneration: number | null = null;
  let warehouseId = biz.warehouseId;
  let workstationId = biz.workstationId;
  let controlLeaseId = input.control_lease_id ?? null;

  if (["pc_remote_mobile", "mobile_local_capture", "pc_camera_capture"].includes(input.source_type)) {
    guard(Boolean(input.device_id), "DEVICE_REQUIRED", `Source type '${input.source_type}' requires a registered device_id.`, 422);
    const dev = await one<{
      id: string;
      warehouse_id: string;
      workstation_id: string | null;
      approval_status: string;
      auth_generation: number;
    }>(
      db,
      `select id, warehouse_id, workstation_id, approval_status, auth_generation
       from warehouse_devices where id = $1 for share`,
      [input.device_id],
    );
    guard(dev.approval_status === "approved", "DEVICE_NOT_APPROVED", `Device '${dev.id}' is not approved (${dev.approval_status}).`, 409);
    deviceAuthGeneration = dev.auth_generation;
    warehouseId = warehouseId ?? dev.warehouse_id;
    workstationId = workstationId ?? dev.workstation_id;

    if (controlLeaseId) {
      const lease = await one<{
        id: string;
        device_id: string;
        holder_user_id: string;
        auth_generation: number;
        status: string;
        expired: boolean;
      }>(
        db,
        `select id, device_id, holder_user_id, auth_generation, status, (expires_at <= now()) as expired
         from device_control_leases where id = $1`,
        [controlLeaseId],
      );
      guard(
        lease.device_id === dev.id &&
          lease.holder_user_id === actor.id &&
          lease.status === "active" &&
          !lease.expired &&
          lease.auth_generation === dev.auth_generation,
        "DEVICE_LEASE_INVALID",
        "Device control lease is invalid, expired, or does not belong to the issuing staff member.",
        403,
      );
    }
  } else {
    controlLeaseId = null;
  }

  const commandId = uuid();
  const cmd = await one(
    db,
    `insert into capture_commands (
       id, command_key, source_type, capture_mode, command_status, evidence_purpose,
       org_id, order_id, package_id, warehouse_item_id, comparison_member_ids,
       work_item_id, inspection_task_id, execution_generation, checkpoint_code,
       measurement_attempt_id, defect_id, frozen_business_snapshot,
       warehouse_id, workstation_id, device_id, camera_role, device_auth_generation,
       control_lease_id, command_issuer_user_id, capture_responsible_user_id,
       preset_version, capture_params, expires_at
     ) values (
       $1,$2,$3,$4,'issued',$5,
       $6,$7,$8,$9,$10::jsonb,
       $11,$12,$13,$14,
       $15,$16,$17::jsonb,
       $18,$19,$20,$21,$22,
       $23,$24,$24,
       $25,$26::jsonb, now() + make_interval(secs => $27)
     ) returning *`,
    [
      commandId,
      input.command_key,
      input.source_type,
      input.capture_mode,
      input.evidence_purpose,
      biz.orgId,
      biz.orderId,
      biz.packageId,
      biz.warehouseItemId,
      JSON.stringify(biz.comparisonMemberIds),
      biz.workItemId,
      biz.inspectionTaskId,
      biz.executionGeneration,
      input.checkpoint_code ?? null,
      input.measurement_attempt_id ?? null,
      input.defect_id ?? null,
      JSON.stringify(biz.snapshot),
      warehouseId,
      workstationId,
      input.device_id ?? null,
      input.camera_role ?? null,
      deviceAuthGeneration,
      controlLeaseId,
      actor.id,
      input.preset_version ?? null,
      JSON.stringify(input.capture_params ?? {}),
      input.expires_in_seconds,
    ],
  );

  await audit(db, actor, "capture_command_issued", "capture_commands", commandId, {
    command_key: input.command_key,
    source_type: input.source_type,
    evidence_purpose: input.evidence_purpose,
    execution_generation: biz.executionGeneration,
    device_id: input.device_id ?? null,
  });

  return { replayed: false, command: cmd };
}

export async function cancelCaptureCommand(
  db: DB,
  actor: Actor,
  commandId: string,
  input: z.infer<typeof cancelCaptureCommandSchema>,
) {
  role(actor, ...STAFF_CAPTURE_ROLES);
  const cmd = await one<{ id: string; command_status: string; command_issuer_user_id: string }>(
    db,
    "select id, command_status, command_issuer_user_id from capture_commands where id = $1 for update",
    [commandId],
  );
  guard(
    cmd.command_issuer_user_id === actor.id || actor.roles.includes("warehouse_admin") || actor.roles.includes("super_admin"),
    "FORBIDDEN",
    "Only the command issuer or warehouse/super admin may cancel a capture command.",
    403,
  );
  guard(cmd.command_status === "issued" || cmd.command_status === "acknowledged", "COMMAND_NOT_CANCELLABLE", `Cannot cancel command in status '${cmd.command_status}'.`, 409);

  const updated = await one(
    db,
    `update capture_commands
     set command_status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
     where id = $1
     returning *`,
    [cmd.id, actor.id, input.reason],
  );
  await audit(db, actor, "capture_command_cancelled", "capture_commands", cmd.id, { reason: input.reason });
  return { command: updated };
}

async function detectLateCondition(
  db: DB,
  cmd: {
    id: string;
    command_status: string;
    expired: boolean;
    device_id: string | null;
    device_auth_generation: number | null;
    work_item_id: string | null;
    execution_generation: number | null;
  } | null,
  fallbackDeviceId?: string | null,
  fallbackDeviceGeneration?: number | null,
): Promise<{ isLate: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  if (cmd) {
    if (cmd.command_status === "cancelled") reasons.push("COMMAND_CANCELLED");
    if (cmd.command_status === "expired" || cmd.expired) reasons.push("COMMAND_EXPIRED");
  }

  const checkDeviceId = cmd?.device_id ?? fallbackDeviceId ?? null;
  const expectedDevGen = cmd?.device_auth_generation ?? fallbackDeviceGeneration ?? null;
  if (checkDeviceId) {
    const dev = (
      await db.query<{ approval_status: string; auth_generation: number }>(
        "select approval_status, auth_generation from warehouse_devices where id = $1",
        [checkDeviceId],
      )
    ).rows[0];
    if (!dev || dev.approval_status !== "approved") reasons.push("DEVICE_REVOKED_OR_UNAPPROVED");
    else if (expectedDevGen !== null && dev.auth_generation !== expectedDevGen) {
      reasons.push(`DEVICE_GENERATION_MISMATCH(cmd=${expectedDevGen},current=${dev.auth_generation})`);
    }
  }

  if (cmd?.work_item_id) {
    const wi = (
      await db.query<{ execution_generation: number; dispatch_status: string }>(
        "select execution_generation, dispatch_status from dispatch_work_items where id = $1",
        [cmd.work_item_id],
      )
    ).rows[0];
    if (!wi) reasons.push("WORK_ITEM_MISSING");
    else if (cmd.execution_generation !== null && wi.execution_generation !== cmd.execution_generation) {
      reasons.push(`EXECUTION_GENERATION_DRIFT(cmd=${cmd.execution_generation},current=${wi.execution_generation})`);
    }
  }
  return { isLate: reasons.length > 0, reasons };
}

export async function authorizeEvidenceUpload(
  db: DB,
  actor: Actor,
  rawInput: z.infer<typeof authorizeEvidenceUploadSchema>,
) {
  const input = authorizeEvidenceUploadSchema.parse(rawInput);
  if (actor.kind === "customer") {
    guard(
      input.source_type === "customer_attachment" && input.evidence_purpose === "customer_reference",
      "FORBIDDEN",
      "Customers may only upload customer_attachment references.",
      403,
    );
    guard(
      !input.command_id &&
        !input.work_item_id &&
        !input.inspection_task_id &&
        !(input.comparison_member_ids?.length) &&
        !input.device_id,
      "FORBIDDEN",
      "Customers cannot specify warehouse commands, devices, or internal task scopes.",
      403,
    );
  } else {
    role(actor, ...STAFF_CAPTURE_ROLES);
  }

  const existing = (
    await db.query<{
      id: string;
      capture_key: string;
      original_object_id: string;
      processing_state: string;
      uploader_user_id: string;
      original_sha256: string;
      original_size_bytes: string;
    }>(
      `select id, capture_key, original_object_id, processing_state, uploader_user_id,
              original_sha256, original_size_bytes::text as original_size_bytes
       from media_evidence_records where capture_key = $1 for update`,
      [input.capture_key],
    )
  ).rows[0];

  if (existing) {
    guard(
      existing.uploader_user_id === actor.id || actor.roles.includes("warehouse_admin") || actor.roles.includes("super_admin"),
      "FORBIDDEN",
      "Capture key is already claimed by another user.",
      403,
    );
    guard(
      existing.original_sha256 === input.expected_sha256 && Number(existing.original_size_bytes) === input.size_bytes,
      "CAPTURE_KEY_PAYLOAD_CONFLICT",
      "Cannot reuse capture_key for a different file digest or byte size.",
      409,
    );
    if (existing.processing_state === "awaiting_upload") {
      const reissued = await reissueStorageUploadSession(
        db,
        actor,
        existing.original_object_id,
        input.upload_mode,
        input.expected_parts,
      );
      return {
        replayed: true,
        evidence: existing,
        storage: reissued,
      };
    }
    return {
      replayed: true,
      evidence: existing,
      storage: null,
    };
  }

  const cmd = input.command_id
    ? await one<{
        id: string;
        source_type: (typeof EVIDENCE_SOURCE_TYPES)[number];
        evidence_purpose: (typeof EVIDENCE_PURPOSES)[number];
        command_status: string;
        expired: boolean;
        org_id: string | null;
        order_id: string | null;
        package_id: string | null;
        warehouse_item_id: string | null;
        comparison_member_ids: string[];
        work_item_id: string | null;
        inspection_task_id: string | null;
        execution_generation: number | null;
        warehouse_id: string | null;
        workstation_id: string | null;
        device_id: string | null;
        camera_role: string | null;
        device_auth_generation: number | null;
        command_issuer_user_id: string;
        capture_responsible_user_id: string;
      }>(
        db,
        "select *, (expires_at is not null and expires_at <= now()) as expired from capture_commands where id = $1 for share",
        [input.command_id],
      )
    : null;

  if (cmd) {
    guard(
      cmd.source_type === input.source_type && cmd.evidence_purpose === input.evidence_purpose,
      "COMMAND_CONTEXT_MISMATCH",
      "Evidence upload source_type or evidence_purpose does not match frozen capture command.",
      422,
    );
  }

  const biz = cmd
    ? {
        orgId: cmd.org_id,
        orderId: cmd.order_id,
        packageId: cmd.package_id,
        warehouseItemId: cmd.warehouse_item_id,
        comparisonMemberIds: Array.isArray(cmd.comparison_member_ids) ? cmd.comparison_member_ids : [],
        workItemId: cmd.work_item_id,
        inspectionTaskId: cmd.inspection_task_id,
        executionGeneration: cmd.execution_generation,
        warehouseId: cmd.warehouse_id,
        workstationId: cmd.workstation_id,
      }
    : await resolveAndValidateBusinessContext(db, actor, input);

  // Determine truthful origin, author & time trust level
  const isImportSource = ["gallery_file_import", "customer_attachment", "legacy_migration"].includes(input.source_type);
  if (isImportSource) {
    guard(
      !["device_monotonic_calibrated", "device_wall_clock"].includes(input.time_source),
      "INVALID_IMPORT_TIME_SOURCE",
      "Imported files or customer attachments must use exif_metadata, user_declared, legacy_migrated, or unknown time_source.",
      422,
    );
  }
  if (!input.actual_captured_at) {
    guard(
      Boolean(input.time_unknown_reason),
      "TIME_OR_REASON_REQUIRED",
      "Provide actual_captured_at or an explicit time_unknown_reason.",
      422,
    );
  }

  const effectiveDeviceId = isImportSource ? null : cmd?.device_id ?? input.device_id ?? null;
  let effectiveDevAuthGen: number | null = cmd?.device_auth_generation ?? null;
  if (!cmd && effectiveDeviceId) {
    const dev = await one<{
      id: string;
      warehouse_id: string;
      workstation_id: string | null;
      approval_status: string;
      auth_generation: number;
    }>(
      db,
      "select id, warehouse_id, workstation_id, approval_status, auth_generation from warehouse_devices where id = $1 for share",
      [effectiveDeviceId],
    );
    guard(
      dev.approval_status === "approved",
      "DEVICE_NOT_APPROVED",
      `Device '${dev.id}' is not approved (${dev.approval_status}).`,
      409,
    );
    effectiveDevAuthGen = dev.auth_generation;
    biz.warehouseId = biz.warehouseId ?? dev.warehouse_id;
    biz.workstationId = biz.workstationId ?? dev.workstation_id;
  }

  let computedOffsetMs: number | null = input.device_clock_offset_ms ?? null;
  if (computedOffsetMs === null && input.actual_captured_at && !isImportSource) {
    computedOffsetMs = new Date(input.actual_captured_at).getTime() - Date.now();
  }
  const clockSkewFlagged = !isImportSource && computedOffsetMs !== null && Math.abs(computedOffsetMs) > CLOCK_SKEW_THRESHOLD_MS;
  const isOnlineLiveCapture = ["pc_remote_mobile", "mobile_local_capture", "pc_camera_capture"].includes(input.source_type);

  let sourceTrustLevel: string;
  if (input.source_type === "device_test" || input.evidence_purpose === "device_test") {
    sourceTrustLevel = "device_test";
  } else if (
    isImportSource ||
    !isOnlineLiveCapture ||
    !input.actual_captured_at ||
    !["device_monotonic_calibrated", "device_wall_clock"].includes(input.time_source)
  ) {
    sourceTrustLevel =
      input.time_source === "exif_metadata"
        ? "exif_only"
        : input.time_source === "unknown" || input.time_source === "legacy_migrated" || !input.actual_captured_at
          ? "legacy_unknown"
          : "user_declared";
  } else if (clockSkewFlagged) {
    sourceTrustLevel = "device_clock_skewed";
  } else if (input.offline_captured) {
    sourceTrustLevel = "offline_synced";
  } else {
    sourceTrustLevel = "system_captured";
  }

  const lateCheck = await detectLateCondition(db, cmd, effectiveDeviceId, effectiveDevAuthGen);
  const captureAuthorId = cmd?.capture_responsible_user_id ?? (isImportSource ? null : actor.id);
  const issuerId = cmd?.command_issuer_user_id ?? null;
  const isBusinessEvidence = input.source_type !== "device_test" && input.evidence_purpose !== "device_test";
  const retentionClass =
    input.source_type === "device_test"
      ? "device_test"
      : input.source_type === "customer_attachment"
        ? "customer_attachment"
        : "standard_evidence";

  const storageAuth = await authorizeStorageUpload(db, actor, {
    purpose: input.evidence_purpose,
    declared_mime: input.declared_mime,
    size_bytes: input.size_bytes,
    expected_sha256: input.expected_sha256,
    upload_mode: input.upload_mode,
    expected_parts: input.expected_parts,
    part_size_bytes: input.part_size_bytes,
    original_filename: input.original_filename ?? null,
    variant_kind: "original",
    legal_hold: input.legal_hold,
    retention_days: input.retention_days ?? null,
  });
  const storageObj = storageAuth.object as { id: string };

  const evidenceId = uuid();
  const evidence = await one(
    db,
    `insert into media_evidence_records (
       id, capture_key, command_id, burst_sequence, original_object_id,
       source_type, source_trust_level, evidence_purpose, media_kind,
       warehouse_id, workstation_id, device_id, camera_role, device_auth_generation,
       command_issuer_user_id, capture_responsible_user_id, uploader_user_id,
       actual_captured_at, video_started_at, video_ended_at, actual_duration_ms,
       time_source, time_unknown_reason, device_timezone, device_clock_offset_ms, clock_skew_flagged,
       original_sha256, original_size_bytes, original_mime,
       processing_state, original_ready, derivatives_ready, late_submission_flag,
       is_business_evidence, retention_class, legal_hold
     ) values (
       $1,$2,$3,$4,$5,
       $6,$7,$8,$9,
       $10,$11,$12,$13,$14,
       $15,$16,$17,
       $18,$19,$20,$21,
       $22,$23,$24,$25,$26,
       $27,$28,$29,
       'awaiting_upload',false,false,$30,
       $31,$32,$33
     ) returning *`,
    [
      evidenceId,
      input.capture_key,
      cmd?.id ?? null,
      input.burst_sequence ?? null,
      storageObj.id,
      input.source_type,
      sourceTrustLevel,
      input.evidence_purpose,
      input.media_kind,
      biz.warehouseId,
      biz.workstationId,
      effectiveDeviceId,
      cmd?.camera_role ?? null,
      effectiveDevAuthGen,
      issuerId,
      captureAuthorId,
      actor.id,
      input.actual_captured_at ?? null,
      input.video_started_at ?? null,
      input.video_ended_at ?? null,
      input.actual_duration_ms ?? null,
      input.time_source,
      input.time_unknown_reason ?? null,
      input.device_timezone ?? null,
      computedOffsetMs,
      clockSkewFlagged,
      input.expected_sha256,
      input.size_bytes,
      input.declared_mime,
      lateCheck.isLate,
      isBusinessEvidence,
      retentionClass,
      input.legal_hold,
    ],
  );

  // If no command existed (e.g. direct import), persist initial context link cleanly at completion
  if (!cmd && (biz.orderId || biz.packageId || biz.warehouseItemId || biz.inspectionTaskId)) {
    const entityTargets: Array<[string, string | null]> = [
      ["order", biz.orderId],
      ["package", biz.packageId],
      ["warehouse_item", biz.warehouseItemId],
      ["inspection_task", biz.inspectionTaskId],
    ];
    for (const [et, eid] of entityTargets) {
      if (!eid) continue;
      await db.query(
        `insert into media_evidence_links (evidence_id, entity_type, entity_id, link_role, org_id, linked_by)
         values ($1, $2, $3, 'primary_capture', $4, $5)
         on conflict do nothing`,
        [evidenceId, et, eid, biz.orgId, actor.id],
      );
    }
  }

  await audit(db, actor, "evidence_upload_authorized", "media_evidence_records", evidenceId, {
    capture_key: input.capture_key,
    source_type: input.source_type,
    source_trust_level: sourceTrustLevel,
    clock_skew_flagged: clockSkewFlagged,
    late_submission_flag: lateCheck.isLate,
  });

  return { replayed: false, evidence, storage: storageAuth };
}

export async function completeEvidenceUpload(
  db: DB,
  actor: Actor,
  evidenceId: string,
  input: z.infer<typeof completeStorageUploadSchema>,
) {
  const ev = await one<{
    id: string;
    capture_key: string;
    command_id: string | null;
    original_object_id: string;
    source_type: string;
    evidence_purpose: string;
    media_kind: string;
    capture_responsible_user_id: string | null;
    uploader_user_id: string;
    device_id: string | null;
    device_auth_generation: number | null;
    original_sha256: string;
    processing_state: string;
    original_ready: boolean;
    late_submission_flag: boolean;
  }>(
    db,
    "select * from media_evidence_records where id = $1 for update",
    [evidenceId],
  );

  guard(
    ev.uploader_user_id === actor.id ||
      ev.capture_responsible_user_id === actor.id ||
      actor.roles.includes("warehouse_admin") ||
      actor.roles.includes("super_admin"),
    "FORBIDDEN",
    "Not authorized to complete this evidence upload.",
    403,
  );
  if (ev.original_ready) {
    return { quarantined: ev.processing_state === "quarantined", evidence: ev, storage: null };
  }
  guard(ev.processing_state === "awaiting_upload" || ev.processing_state === "uploaded_unverified", "EVIDENCE_STATE_INVALID", `Cannot complete evidence in state '${ev.processing_state}'.`, 409);

  const storageRes = await completeStorageUpload(db, actor, ev.original_object_id, input);
  if (storageRes.quarantined) {
    const reasons = (storageRes as { quarantine_reasons?: string[] }).quarantine_reasons ?? ["INTEGRITY_FAILED"];
    const qEv = await one(
      db,
      `update media_evidence_records
       set processing_state = 'quarantined',
           quarantine_reason = $2,
           retention_class = 'quarantined_mistake',
           updated_at = now()
       where id = $1
       returning *`,
      [ev.id, reasons.join("; ")],
    );
    await audit(db, actor, "evidence_integrity_quarantined", "media_evidence_records", ev.id, { reasons });
    return {
      quarantined: true,
      late_quarantined: false,
      error: (storageRes as { error?: unknown }).error,
      quarantine_reasons: reasons,
      evidence: qEv,
    };
  }

  const cmd = ev.command_id
    ? await one<{
        id: string;
        command_status: string;
        expired: boolean;
        org_id: string | null;
        order_id: string | null;
        package_id: string | null;
        warehouse_item_id: string | null;
        comparison_member_ids: string[];
        work_item_id: string | null;
        inspection_task_id: string | null;
        execution_generation: number | null;
        device_id: string | null;
        device_auth_generation: number | null;
        capture_responsible_user_id: string;
      }>(
        db,
        "select *, (expires_at is not null and expires_at <= now()) as expired from capture_commands where id = $1 for share",
        [ev.command_id],
      )
    : null;

  const lateCheck = await detectLateCondition(db, cmd, ev.device_id, ev.device_auth_generation);
  const isLate = ev.late_submission_flag || lateCheck.isLate;

  if (isLate) {
    const qReasons = lateCheck.reasons.length > 0 ? lateCheck.reasons : ["LATE_SUBMISSION_AT_AUTHORIZATION"];
    const lateEv = await one(
      db,
      `update media_evidence_records
       set processing_state = 'quarantined',
           original_ready = true,
           late_submission_flag = true,
           quarantine_reason = $2,
           server_verified_at = now(),
           updated_at = now()
       where id = $1
       returning *`,
      [ev.id, qReasons.join("; ")],
    );
    if (cmd?.work_item_id) {
      const wiCurr = (
        await db.query<{ execution_generation: number }>(
          "select execution_generation from dispatch_work_items where id = $1",
          [cmd.work_item_id],
        )
      ).rows[0];
      await db.query(
        `insert into late_evidence_quarantine (
           id, work_item_id, inspection_task_id, captured_by, device_id,
           submitted_generation, current_generation_at_receipt, evidence_sha256,
           quarantine_reason, payload
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          uuid(),
          cmd.work_item_id,
          cmd.inspection_task_id,
          ev.capture_responsible_user_id ?? ev.uploader_user_id,
          ev.device_id,
          cmd.execution_generation ?? 1,
          wiCurr?.execution_generation ?? cmd.execution_generation ?? 1,
          ev.original_sha256,
          qReasons.join("; "),
          JSON.stringify({ evidence_id: ev.id, capture_key: ev.capture_key }),
        ],
      );
    }
    await audit(db, actor, "evidence_late_quarantined", "media_evidence_records", ev.id, { reasons: qReasons });
    return {
      quarantined: true,
      late_quarantined: true,
      quarantine_reasons: qReasons,
      evidence: lateEv,
      storage: storageRes,
    };
  }

  // Verified active original: promote links from command and schedule async processing
  const nextState = ev.media_kind === "document" ? "ready" : "processing";
  const verified = await one(
    db,
    `update media_evidence_records
     set original_ready = true,
         derivatives_ready = $2,
         processing_state = $3,
         server_verified_at = now(),
         updated_at = now()
     where id = $1
     returning *`,
    [ev.id, ev.media_kind === "document", nextState],
  );

  if (cmd) {
    if (cmd.command_status === "issued" || cmd.command_status === "acknowledged") {
      await db.query("update capture_commands set command_status = 'captured' where id = $1", [cmd.id]);
    }
    const entityTargets: Array<[string, string | null, string]> = [
      ["order", cmd.order_id, "primary_capture"],
      ["package", cmd.package_id, "primary_capture"],
      ["warehouse_item", cmd.warehouse_item_id, "primary_capture"],
      ["work_item", cmd.work_item_id, "primary_capture"],
      ["inspection_task", cmd.inspection_task_id, "primary_capture"],
    ];
    for (const [et, eid, lr] of entityTargets) {
      if (!eid) continue;
      await db.query(
        `insert into media_evidence_links (evidence_id, entity_type, entity_id, link_role, org_id, execution_generation, linked_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict do nothing`,
        [ev.id, et, eid, lr, cmd.org_id, cmd.execution_generation, ev.capture_responsible_user_id ?? actor.id],
      );
    }
    for (const memberId of Array.isArray(cmd.comparison_member_ids) ? cmd.comparison_member_ids : []) {
      await db.query(
        `insert into media_evidence_links (evidence_id, entity_type, entity_id, link_role, org_id, execution_generation, linked_by)
         values ($1, 'warehouse_item', $2, 'comparison_member', $3, $4, $5)
         on conflict do nothing`,
        [ev.id, memberId, cmd.org_id, cmd.execution_generation, ev.capture_responsible_user_id ?? actor.id],
      );
    }
  }

  let processingJob = null;
  if (ev.media_kind === "photo" || ev.media_kind === "video") {
    processingJob = await enqueueMediaProcessingJob(db, ev.id, ev.media_kind === "photo" ? "image_derivatives" : "video_probe_poster");
  }

  await audit(db, actor, "evidence_upload_completed", "media_evidence_records", ev.id, {
    processing_state: nextState,
    processing_job_id: processingJob?.id ?? null,
  });

  return { quarantined: false, late_quarantined: false, evidence: verified, processing_job: processingJob, storage: storageRes };
}

async function enqueueMediaProcessingJob(
  db: DB,
  evidenceId: string,
  jobType: "image_derivatives" | "video_probe_poster",
) {
  const jobId = uuid();
  const key = `media-proc:${evidenceId}:${jobType}`;
  const job = await one<{ id: string }>(
    db,
    `insert into media_processing_jobs (id, evidence_id, job_type, idempotency_key, status)
     values ($1, $2, $3, $4, 'queued')
     on conflict (idempotency_key) do update set updated_at = now()
     returning *`,
    [jobId, evidenceId, jobType, key],
  );
  await db.query(
    `insert into outbox_events (type, payload) values ('media.process', $1::jsonb)`,
    [JSON.stringify({ job_id: job.id, evidence_id: evidenceId, dedupe_key: `media.process:${job.id}` })],
  );
  return job;
}

async function createAndUploadDerivativeVariant(
  db: DB,
  params: {
    evidenceId: string;
    parentObjectId: string;
    orgId: string | null;
    purpose: string;
    variantKind: "normalized" | "thumbnail";
    bytes: Buffer;
    mime: string;
    width: number | null;
    height: number | null;
    transformSpec: Record<string, unknown>;
    createdBy: string;
    storageObj: { storage_instance_id: string | null; storage_provider_key: string; bucket: string; object_key: string };
  },
) {
  const sha = createHash("sha256").update(params.bytes).digest("hex");
  const { provider, instance } = await resolveObjectStorageProviderForRead(db, params.storageObj);
  const childObjectId = uuid();
  const baseFolder = params.storageObj.object_key.replace(/\/[^/]+$/, "");
  const childKey = `${baseFolder}/${params.variantKind}_v1_${childObjectId.slice(0, 8)}.jpg`;
  const putRes = await provider.putObject(childKey, params.bytes, params.mime);

  await db.query(
    `insert into storage_objects (
       id, storage_instance_id, storage_provider_key, bucket, object_key, object_version_id,
       org_id, owner_user_id, purpose, visibility, declared_mime, detected_mime, size_bytes,
       expected_sha256, verified_sha256, status, is_immutable, parent_object_id, variant_kind,
       created_by, verified_at
     ) values (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9,'private',$10,$10,$11,
       $12,$12,'ready',true,$13,$14,
       $8,now()
     )`,
    [
      childObjectId,
      instance?.id ?? params.storageObj.storage_instance_id,
      provider.providerKey,
      provider.bucket,
      childKey,
      putRes.versionId,
      params.orgId,
      params.createdBy,
      params.purpose,
      params.mime,
      params.bytes.length,
      sha,
      params.parentObjectId,
      params.variantKind,
    ],
  );

  await db.query(
    `insert into media_evidence_variants (
       id, evidence_id, variant_kind, variant_version, storage_object_id, sha256,
       size_bytes, mime, width, height, transform_spec, created_by
     ) values ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     on conflict (evidence_id, variant_kind, variant_version) do nothing`,
    [
      uuid(),
      params.evidenceId,
      params.variantKind,
      childObjectId,
      sha,
      params.bytes.length,
      params.mime,
      params.width,
      params.height,
      JSON.stringify(params.transformSpec),
      params.createdBy,
    ],
  );
  return { childObjectId, sha };
}

export async function processMediaJob(db: DB, jobId: string) {
  const job = await one<{
    id: string;
    evidence_id: string;
    job_type: string;
    status: string;
    attempts: number;
    max_attempts: number;
  }>(
    db,
    "select id, evidence_id, job_type, status, attempts, max_attempts from media_processing_jobs where id = $1 for update",
    [jobId],
  );
  if (job.status === "completed" || job.status === "cancelled") {
    return { skipped: true, status: job.status };
  }

  const leaseToken = uuid();
  await db.query(
    `update media_processing_jobs
     set status = 'processing', lease_token = $2, lease_expires_at = now() + interval '5 minutes',
         attempts = attempts + 1, started_at = coalesce(started_at, now()), updated_at = now()
     where id = $1`,
    [job.id, leaseToken],
  );

  const ev = await one<{
    id: string;
    original_object_id: string;
    media_kind: string;
    evidence_purpose: string;
    original_sha256: string;
    uploader_user_id: string;
    processing_state: string;
    original_ready: boolean;
  }>(
    db,
    "select id, original_object_id, media_kind, evidence_purpose, original_sha256, uploader_user_id, processing_state, original_ready from media_evidence_records where id = $1 for update",
    [job.evidence_id],
  );
  guard(ev.original_ready, "EVIDENCE_ORIGINAL_NOT_READY", "Cannot generate derivatives before original upload completes.", 409);

  const origObj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    bucket: string;
    object_key: string;
    org_id: string | null;
    declared_mime: string;
  }>(
    db,
    "select id, storage_instance_id, storage_provider_key, bucket, object_key, org_id, declared_mime from storage_objects where id = $1",
    [ev.original_object_id],
  );

  await db.query("savepoint media_proc_job");
  try {
    const { provider } = await resolveObjectStorageProviderForRead(db, origObj);
    const streamRes = await provider.getObjectStream(origObj.object_key);

    let resultMeta: Record<string, unknown> = {};
    if (job.job_type === "image_derivatives") {
      const origBytes = Buffer.from(await new Response(streamRes.body).arrayBuffer());
      const actualSha = createHash("sha256").update(origBytes).digest("hex");
      guard(actualSha === ev.original_sha256, "ORIGINAL_DIGEST_MISMATCH", "Stored original bytes failed SHA-256 verification.", 500);
      const meta = await sharp(origBytes, { limitInputPixels: 40_000_000 }).metadata();
      const normalized = await sharp(origBytes, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 86 })
        .toBuffer({ resolveWithObject: true });
      const thumb = await sharp(normalized.data, { limitInputPixels: 40_000_000 })
        .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer({ resolveWithObject: true });

      const normVar = await createAndUploadDerivativeVariant(db, {
        evidenceId: ev.id,
        parentObjectId: origObj.id,
        orgId: origObj.org_id,
        purpose: ev.evidence_purpose,
        variantKind: "normalized",
        bytes: normalized.data,
        mime: "image/jpeg",
        width: normalized.info.width ?? null,
        height: normalized.info.height ?? null,
        transformSpec: { auto_orient: true, exif_stripped: true, max_edge: 2400 },
        createdBy: ev.uploader_user_id,
        storageObj: origObj,
      });
      const thumbVar = await createAndUploadDerivativeVariant(db, {
        evidenceId: ev.id,
        parentObjectId: origObj.id,
        orgId: origObj.org_id,
        purpose: ev.evidence_purpose,
        variantKind: "thumbnail",
        bytes: thumb.data,
        mime: "image/jpeg",
        width: thumb.info.width ?? null,
        height: thumb.info.height ?? null,
        transformSpec: { exif_stripped: true, max_edge: 480 },
        createdBy: ev.uploader_user_id,
        storageObj: origObj,
      });

      await db.query(
        `update media_evidence_records
         set pixel_width = coalesce(pixel_width, $2),
             pixel_height = coalesce(pixel_height, $3),
             exif_orientation = coalesce(exif_orientation, $4),
             derivatives_ready = true,
             processing_state = case when processing_state = 'quarantined' then 'quarantined' else 'ready' end,
             updated_at = now()
         where id = $1`,
        [ev.id, meta.width ?? null, meta.height ?? null, meta.orientation ?? null],
      );
      resultMeta = { normalized_sha256: normVar.sha, thumbnail_sha256: thumbVar.sha, original_preserved: true };
    } else {
      // Bounded streaming hash + head inspection for large video files (zero full-file buffer in memory)
      const hasher = createHash("sha256");
      const reader = streamRes.body.getReader();
      const headChunks: Uint8Array[] = [];
      let headLen = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        hasher.update(value);
        if (headLen < 64) {
          const take = Math.min(64 - headLen, value.byteLength);
          headChunks.push(value.subarray(0, take));
          headLen += take;
        }
      }
      const actualSha = hasher.digest("hex");
      guard(actualSha === ev.original_sha256, "ORIGINAL_DIGEST_MISMATCH", "Stored original video failed SHA-256 verification.", 500);
      const headBuf = Buffer.concat(headChunks.map((c) => Buffer.from(c)));
      const ftypBrand = headBuf.length >= 12 ? headBuf.subarray(8, 12).toString("ascii") : "unknown";
      await db.query(
        `update media_evidence_records
         set derivatives_ready = true,
             processing_state = case when processing_state = 'quarantined' then 'quarantined' else 'ready' end,
             updated_at = now()
         where id = $1`,
        [ev.id],
      );
      resultMeta = { video_container_brand: ftypBrand, original_preserved: true };
    }

    await db.query(
      `update media_processing_jobs
       set status = 'completed', last_error = null, result_meta = $2::jsonb, completed_at = now(), updated_at = now()
       where id = $1 and lease_token = $3`,
      [job.id, JSON.stringify(resultMeta), leaseToken],
    );
    await db.query("release savepoint media_proc_job");
    return { skipped: false, status: "completed", result_meta: resultMeta };
  } catch (err) {
    await db.query("rollback to savepoint media_proc_job");
    await db.query("release savepoint media_proc_job");
    const nextAttempts = job.attempts + 1;
    const nextStatus = nextAttempts >= job.max_attempts ? "dead_letter" : "failed";
    const errMsg = (err instanceof Error ? err.message : "Media derivative processing failed.").slice(0, 300);
    await db.query(
      `update media_processing_jobs
       set status = $2, last_error = $3, updated_at = now()
       where id = $1`,
      [job.id, nextStatus, errMsg],
    );
    // Keep original_ready = true intact; mark processing_state = 'failed' unless quarantined
    await db.query(
      `update media_evidence_records
       set processing_state = case when processing_state = 'quarantined' then 'quarantined' else 'failed' end,
           updated_at = now()
       where id = $1`,
      [ev.id],
    );
    return { skipped: false, status: nextStatus, error: errMsg };
  }
}

export async function retryMediaProcessingJob(db: DB, actor: Actor, evidenceId: string) {
  role(actor, ...STAFF_CAPTURE_ROLES);
  const ev = await one<{ id: string; original_ready: boolean; media_kind: string; processing_state: string }>(
    db,
    "select id, original_ready, media_kind, processing_state from media_evidence_records where id = $1 for update",
    [evidenceId],
  );
  guard(ev.original_ready, "EVIDENCE_ORIGINAL_NOT_READY", "Original upload is not verified ready yet.", 409);
  guard(ev.processing_state !== "quarantined", "EVIDENCE_QUARANTINED", "Quarantined evidence must be resolved before retrying processing.", 409);
  const job = await one<{ id: string; status: string }>(
    db,
    "select id, status from media_processing_jobs where evidence_id = $1 order by created_at desc limit 1 for update",
    [ev.id],
  );
  guard(job.status === "failed" || job.status === "dead_letter", "JOB_NOT_FAILED", `Processing job is '${job.status}', not retryable.`, 409);

  await db.query(
    `update media_processing_jobs
     set status = 'queued', lease_token = null, lease_expires_at = null, last_error = null, updated_at = now()
     where id = $1`,
    [job.id],
  );
  await db.query(
    "update media_evidence_records set processing_state = 'processing', updated_at = now() where id = $1",
    [ev.id],
  );
  await db.query(
    "insert into outbox_events (type, payload) values ('media.process', $1::jsonb)",
    [JSON.stringify({ job_id: job.id, evidence_id: ev.id, dedupe_key: `media.process:${job.id}:retry:${Date.now()}` })],
  );
  await audit(db, actor, "media_processing_retried", "media_processing_jobs", job.id, { evidence_id: ev.id });
  return { retried: true, job_id: job.id, evidence_id: ev.id };
}

export async function linkEvidenceToEntity(
  db: DB,
  actor: Actor,
  evidenceId: string,
  rawInput: z.infer<typeof linkEvidenceSchema>,
) {
  role(actor, ...STAFF_CAPTURE_ROLES);
  const input = linkEvidenceSchema.parse(rawInput);

  const ev = await one<{
    id: string;
    processing_state: string;
    original_ready: boolean;
    is_business_evidence: boolean;
  }>(
    db,
    "select id, processing_state, original_ready, is_business_evidence from media_evidence_records where id = $1 for update",
    [evidenceId],
  );

  if (!ev.is_business_evidence) {
    guard(
      input.entity_type === "device_test",
      "DEVICE_TEST_EVIDENCE_ISOLATED",
      "Non-business device test captures cannot be linked to business or customer entities.",
      409,
    );
  }
  if (["qa_selected", "report_citation"].includes(input.link_role)) {
    guard(
      ev.original_ready && ev.processing_state === "ready" && ev.is_business_evidence,
      "EVIDENCE_NOT_ELIGIBLE_FOR_REPORT",
      `Evidence in state '${ev.processing_state}' (is_business=${ev.is_business_evidence}) cannot be cited by QA/reports.`,
      409,
    );
  } else {
    guard(ev.processing_state !== "quarantined" && ev.processing_state !== "cancelled", "EVIDENCE_QUARANTINED", "Quarantined or cancelled evidence cannot be linked.", 409);
  }

  // Enforce non-cross-tenant ownership across active links on this evidence
  const existingOrgs = (
    await db.query<{ org_id: string }>(
      "select distinct org_id from media_evidence_links where evidence_id = $1 and org_id is not null and status = 'active'",
      [ev.id],
    )
  ).rows.map((r) => r.org_id);

  let resolvedOrgId: string | null = null;
  if (input.entity_type === "org") {
    const orgRow = await one<{ id: string }>(db, "select id from organizations where id = $1", [input.entity_id]);
    resolvedOrgId = orgRow.id;
  } else if (input.entity_type === "package") {
    const pkg = await one<{ org_id: string | null }>(db, "select org_id from packages where id = $1", [input.entity_id]);
    resolvedOrgId = pkg.org_id;
  } else if (input.entity_type === "order") {
    const ord = await one<{ org_id: string }>(db, "select org_id from orders where id = $1", [input.entity_id]);
    resolvedOrgId = ord.org_id;
  } else if (input.entity_type === "warehouse_item") {
    const item = await one<{ org_id: string | null }>(db, "select org_id from warehouse_items where id = $1", [input.entity_id]);
    resolvedOrgId = item.org_id;
  } else if (input.entity_type === "inspection_task") {
    const task = await one<{ org_id: string }>(
      db,
      "select l.org_id from inspection_tasks t join order_lines l on l.id = t.order_line_id where t.id = $1",
      [input.entity_id],
    );
    resolvedOrgId = task.org_id;
  } else if (input.entity_type === "work_item") {
    const wi = (
      await db.query<{ org_id: string | null }>(
        `select l.org_id
         from dispatch_work_items w
         left join inspection_tasks t on t.id = w.inspection_task_id
         left join order_lines l on l.id = t.order_line_id
         where w.id = $1`,
        [input.entity_id],
      )
    ).rows[0];
    guard(wi, "NOT_FOUND", "Work item not found.", 404);
    resolvedOrgId = wi.org_id;
  } else if (input.entity_type === "shipment") {
    const shp = await one<{ org_id: string }>(
      db,
      "select b.org_id from shipments s join dispatch_batches b on b.id = s.batch_id where s.id = $1",
      [input.entity_id],
    );
    resolvedOrgId = shp.org_id;
  } else if (input.entity_type === "ticket") {
    const tk = await one<{ org_id: string | null }>(db, "select org_id from tickets where id = $1", [input.entity_id]);
    resolvedOrgId = tk.org_id;
  } else if (input.entity_type === "report_version") {
    const rv = await one<{ org_id: string }>(
      db,
      "select o.org_id from report_versions v join reports r on r.id = v.report_id join orders o on o.id = r.order_id where v.id = $1",
      [input.entity_id],
    );
    resolvedOrgId = rv.org_id;
  } else if (input.entity_type === "incident") {
    const inc = await one<{ org_id: string | null }>(db, "select org_id from incident_cases where id = $1", [input.entity_id]);
    resolvedOrgId = inc.org_id;
  } else if (input.entity_type === "golden_sample") {
    const gs = await one<{ org_id: string }>(db, "select org_id from reference_samples where id = $1", [input.entity_id]);
    resolvedOrgId = gs.org_id;
  }

  if (resolvedOrgId && input.org_id) {
    guard(resolvedOrgId === input.org_id, "EVIDENCE_ORG_MISMATCH", "Supplied org_id conflicts with target entity organization.", 422);
  }
  const targetOrgId = resolvedOrgId ?? input.org_id ?? null;
  if (!["stocktake", "device_test", "package", "warehouse_item"].includes(input.entity_type)) {
    guard(Boolean(targetOrgId), "EVIDENCE_ORG_REQUIRED", `Entity type '${input.entity_type}' requires an explicit organization scope.`, 422);
  }

  if (targetOrgId && existingOrgs.length > 0) {
    guard(
      existingOrgs.every((o) => o === targetOrgId),
      "CROSS_TENANT_EVIDENCE_FORBIDDEN",
      "Cannot link an evidence file owned by one customer organization to another organization.",
      403,
    );
  }

  const link = await one(
    db,
    `insert into media_evidence_links (
       id, evidence_id, entity_type, entity_id, link_role, org_id, execution_generation, linked_by, reason
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (evidence_id, entity_type, entity_id, link_role) where status = 'active'
     do update set updated_at = now()
     returning *`,
    [
      uuid(),
      ev.id,
      input.entity_type,
      input.entity_id,
      input.link_role,
      targetOrgId,
      input.execution_generation ?? null,
      actor.id,
      input.reason ?? null,
    ],
  );
  await audit(db, actor, "evidence_linked", "media_evidence_records", ev.id, {
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    link_role: input.link_role,
    org_id: targetOrgId,
  });
  return { link };
}

export async function resolveQuarantinedEvidenceRecord(
  db: DB,
  actor: Actor,
  evidenceId: string,
  rawInput: z.infer<typeof resolveQuarantineEvidenceSchema>,
) {
  role(actor, ...QA_RESOLVE_ROLES);
  const input = resolveQuarantineEvidenceSchema.parse(rawInput);

  const ev = await one<{
    id: string;
    capture_key: string;
    processing_state: string;
    original_ready: boolean;
    media_kind: string;
    capture_responsible_user_id: string | null;
    quarantine_reason: string | null;
  }>(
    db,
    "select id, capture_key, processing_state, original_ready, media_kind, capture_responsible_user_id, quarantine_reason from media_evidence_records where id = $1 for update",
    [evidenceId],
  );
  guard(ev.processing_state === "quarantined", "NOT_QUARANTINED", "Evidence record is not currently quarantined.", 409);

  if (input.decision === "accept_preserving_author") {
    guard(
      ev.original_ready,
      "INTEGRITY_QUARANTINED_CANNOT_ACCEPT",
      "SHA-256 or magic-byte corrupted files cannot be accepted into production evidence.",
      409,
    );
    const updated = await one(
      db,
      `update media_evidence_records
       set processing_state = $2,
           quarantine_reason = null,
           updated_at = now()
       where id = $1
       returning *`,
      [ev.id, ev.media_kind === "document" ? "ready" : "processing"],
    );
    let job = null;
    if (ev.media_kind === "photo" || ev.media_kind === "video") {
      job = await enqueueMediaProcessingJob(db, ev.id, ev.media_kind === "photo" ? "image_derivatives" : "video_probe_poster");
    }
    await db.query(
      `update late_evidence_quarantine
       set resolution_status = 'accepted_preserving_author', resolved_by = $2, resolved_at = now(), resolution_note = $3
       where payload->>'evidence_id' = $1 and resolution_status = 'quarantined'`,
      [ev.id, actor.id, input.note],
    );
    await audit(db, actor, "evidence_quarantine_accepted", "media_evidence_records", ev.id, {
      preserved_author: ev.capture_responsible_user_id,
      note: input.note,
    });
    return { evidence: updated, processing_job: job };
  }

  const rejected = await one(
    db,
    `update media_evidence_records
     set processing_state = 'cancelled',
         retention_class = 'quarantined_mistake',
         updated_at = now()
     where id = $1
     returning *`,
    [ev.id],
  );
  await db.query(
    `update late_evidence_quarantine
     set resolution_status = 'rejected_reshoot', resolved_by = $2, resolved_at = now(), resolution_note = $3
     where payload->>'evidence_id' = $1 and resolution_status = 'quarantined'`,
    [ev.id, actor.id, input.note],
  );
  await audit(db, actor, "evidence_quarantine_rejected", "media_evidence_records", ev.id, { note: input.note });
  return { evidence: rejected, processing_job: null };
}

export async function cleanupExpiredUnfinishedUploads(db: DB, minAgeMinutes = 60, actor?: Actor) {
  if (actor) {
    role(actor, "warehouse_admin", "super_admin");
  }
  const candidates = (
    await db.query<{ id: string; original_object_id: string; uploader_user_id: string }>(
      `select e.id, e.original_object_id, e.uploader_user_id
       from media_evidence_records e
       join storage_objects so on so.id = e.original_object_id
       where e.processing_state = 'awaiting_upload'
         and e.original_ready = false
         and e.legal_hold = false
         and so.legal_hold = false
         and e.created_at < now() - make_interval(mins => $1)
         and not exists (
           select 1 from media_evidence_links l
           where l.evidence_id = e.id and l.link_role in ('qa_selected', 'report_citation') and l.status = 'active'
         )
         and not exists (
           select 1 from storage_upload_sessions s
           where s.object_id = e.original_object_id and s.status = 'open' and s.expires_at > now()
         )
       for update of e skip locked`,
      [minAgeMinutes],
    )
  ).rows;

  const cleanedIds: string[] = [];
  for (const row of candidates) {
    await db.query("savepoint cleanup_ev_item");
    try {
      const configured = await resolveConfiguredWriteProvider(db, { visibilityScope: "private_evidence" }).catch(() => null);
      if (configured || getRuntimeObjectStorageProvider()) {
        await abortStorageUpload(db, { id: row.uploader_user_id, kind: "staff", roles: ["super_admin"] } as unknown as Actor, row.original_object_id);
      } else {
        await db.query("update storage_objects set status = 'cancelled', updated_at = now() where id = $1 and status <> 'ready'", [row.original_object_id]);
      }
      await db.query("update media_evidence_records set processing_state = 'cancelled', updated_at = now() where id = $1", [row.id]);
      await db.query("release savepoint cleanup_ev_item");
      cleanedIds.push(row.id);
    } catch {
      await db.query("rollback to savepoint cleanup_ev_item");
      await db.query("release savepoint cleanup_ev_item");
    }
  }
  return { cleaned: cleanedIds.length, evidence_ids: cleanedIds };
}

export async function getEvidenceDetail(db: DB, actor: Actor, evidenceId: string) {
  const ev = await one<{
    id: string;
    capture_key: string;
    command_id: string | null;
    burst_sequence: number | null;
    original_object_id: string;
    source_type: string;
    source_trust_level: string;
    evidence_purpose: string;
    media_kind: string;
    warehouse_id: string | null;
    workstation_id: string | null;
    device_id: string | null;
    camera_role: string | null;
    command_issuer_user_id: string | null;
    capture_responsible_user_id: string | null;
    uploader_user_id: string;
    actual_captured_at: string | null;
    video_started_at: string | null;
    video_ended_at: string | null;
    actual_duration_ms: number | null;
    time_source: string;
    time_unknown_reason: string | null;
    device_timezone: string | null;
    device_clock_offset_ms: string | null;
    clock_skew_flagged: boolean;
    server_received_at: string;
    server_verified_at: string | null;
    original_sha256: string;
    original_size_bytes: string;
    original_mime: string;
    pixel_width: number | null;
    pixel_height: number | null;
    processing_state: string;
    original_ready: boolean;
    derivatives_ready: boolean;
    quarantine_reason: string | null;
    late_submission_flag: boolean;
    is_business_evidence: boolean;
    retention_class: string;
    legal_hold: boolean;
    customer_visible: boolean;
  }>(
    db,
    "select * from media_evidence_records where id = $1",
    [evidenceId],
  );

  const variants = (
    await db.query("select id, variant_kind, variant_version, storage_object_id, sha256, size_bytes::text, mime, width, height, duration_ms, transform_spec, created_at from media_evidence_variants where evidence_id = $1 order by variant_kind, variant_version", [ev.id])
  ).rows;
  const links = (
    await db.query("select id, entity_type, entity_id, link_role, org_id, execution_generation, status, created_at from media_evidence_links where evidence_id = $1 and status = 'active'", [ev.id])
  ).rows;
  const jobs = (
    await db.query("select id, job_type, status, attempts, max_attempts, last_error, result_meta, completed_at from media_processing_jobs where evidence_id = $1 order by created_at desc", [ev.id])
  ).rows;

  if (actor.kind === "customer") {
    const custOrg = organization(actor);
    const owns = links.some((l) => l.org_id === custOrg);
    guard(owns && ev.processing_state === "ready" && ev.is_business_evidence, "NOT_FOUND", "Evidence not found.", 404);
    // Customer projection (§115.9): redact internal staff IDs, device IDs, workstations & internal diagnostics
    return {
      evidence: {
        id: ev.id,
        evidence_purpose: ev.evidence_purpose,
        media_kind: ev.media_kind,
        source_trust_level: ev.source_trust_level,
        actual_captured_at: ev.actual_captured_at,
        video_started_at: ev.video_started_at,
        video_ended_at: ev.video_ended_at,
        actual_duration_ms: ev.actual_duration_ms,
        time_source: ev.time_source,
        time_unknown_reason: ev.time_unknown_reason,
        original_sha256: ev.original_sha256,
        original_mime: ev.original_mime,
        pixel_width: ev.pixel_width,
        pixel_height: ev.pixel_height,
      },
      variants: variants.map((v) => ({
        id: v.id,
        variant_kind: v.variant_kind,
        storage_object_id: v.storage_object_id,
        mime: v.mime,
        width: v.width,
        height: v.height,
      })),
    };
  }

  role(actor, ...STAFF_CAPTURE_ROLES, "finance");
  return { evidence: ev, variants, links, jobs };
}

export async function listEvidenceSyncQueue(
  db: DB,
  actor: Actor,
  filters?: { state?: string; device_id?: string },
) {
  role(actor, ...STAFF_CAPTURE_ROLES);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.state) {
    params.push(filters.state);
    clauses.push(`processing_state = $${params.length}`);
  }
  if (filters?.device_id) {
    params.push(filters.device_id);
    clauses.push(`device_id = $${params.length}`);
  }
  if (!actor.roles.includes("warehouse_admin") && !actor.roles.includes("super_admin") && !actor.roles.includes("reviewer")) {
    params.push(actor.id);
    clauses.push(`(uploader_user_id = $${params.length} or capture_responsible_user_id = $${params.length})`);
  }
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const items = (
    await db.query(
      `select id, capture_key, command_id, source_type, source_trust_level, evidence_purpose, media_kind,
              processing_state, original_ready, derivatives_ready, late_submission_flag, quarantine_reason,
              capture_responsible_user_id, uploader_user_id, actual_captured_at, time_source, created_at
       from media_evidence_records
       ${where}
       order by created_at desc
       limit 100`,
      params,
    )
  ).rows;
  return { items };
}
