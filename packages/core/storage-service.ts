import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, transaction, type DB } from "../db";
import { audit, guard, one, role, uuid, type Actor } from "./common";
import {
  assertProductionStorageAllowed,
  STORAGE_PROVIDER_CAPABILITIES,
  type ObjectStorageProvider,
} from "./object-storage";
import {
  assertNoUnsafeLiveFallback,
  resolveConfiguredReadProvider,
  resolveConfiguredWriteProvider,
  type StorageInstanceRow,
} from "./storage-hub";

export const ALLOWED_STORAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "video/mp4",
  "video/quicktime",
  "application/pdf",
] as const;

export const VARIANT_KINDS = [
  "original",
  "normalized",
  "thumbnail",
  "annotated",
  "video_playback",
  "video_poster",
  "report_pdf",
  "export",
] as const;

const MIME_EXTENSIONS: Record<(typeof ALLOWED_STORAGE_MIMES)[number], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};

const STAFF_OBJECT_ROLES = [
  "receiver",
  "inspector",
  "reviewer",
  "warehouse_admin",
  "support",
  "super_admin",
  "finance",
  "template_admin",
] as const;

export const authorizeStorageUploadSchema = z.object({
  purpose: z.string().trim().min(2).max(60).regex(/^[a-z0-9._-]+$/),
  declared_mime: z.enum(ALLOWED_STORAGE_MIMES),
  size_bytes: z.number().int().min(1).max(2_000_000_000),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform((v) => v.toLowerCase()),
  upload_mode: z.enum(["presigned_put", "multipart"]).default("presigned_put"),
  expected_parts: z.number().int().min(1).max(1000).optional(),
  part_size_bytes: z.number().int().min(1).max(100_000_000).optional(),
  original_filename: z.string().trim().max(200).nullable().optional(),
  variant_kind: z.enum(VARIANT_KINDS).default("original"),
  parent_object_id: z.uuid().nullable().optional(),
  legal_hold: z.boolean().default(false),
  retention_days: z.number().int().min(1).max(3650).nullable().optional(),
  environment: z.enum(["sandbox", "live"]).optional(),
});

const STAGING_PREFIX = "staging/";
function stagingKeyFor(objectKey: string): string {
  return `${STAGING_PREFIX}${objectKey.replace(/^\/+/, "")}`;
}
function quarantineKeyFor(objectKey: string): string {
  return `quarantine/${objectKey.replace(/^\/+/, "")}`;
}

export const multipartPartUrlSchema = z.object({
  part_number: z.number().int().min(1).max(10000),
});

export const completeStorageUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        part_number: z.number().int().min(1).max(10000),
        etag: z.string().trim().regex(/^"?[A-Za-z0-9._-]{1,128}"?$/, "Invalid ETag format."),
      }),
    )
    .optional(),
});

export const deleteStorageObjectSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

let activeRuntimeProvider: ObjectStorageProvider | null = null;

export function registerRuntimeObjectStorageProvider(provider: ObjectStorageProvider | null): void {
  activeRuntimeProvider = provider;
}

export function getRuntimeObjectStorageProvider(): ObjectStorageProvider | null {
  return activeRuntimeProvider;
}

function requireRuntimeProvider(): ObjectStorageProvider {
  assertProductionStorageAllowed(Boolean(activeRuntimeProvider));
  guard(
    activeRuntimeProvider,
    "OBJECT_STORAGE_UNCONFIGURED",
    "No verified object storage provider is currently configured.",
    503,
  );
  return activeRuntimeProvider;
}

async function resolveWriteProviderAndInstance(
  db: DB,
  visibilityScope: "private_evidence" | "public_assets",
  purpose?: string,
  preferredEnvironment?: "sandbox" | "live",
): Promise<{ provider: ObjectStorageProvider; instance: StorageInstanceRow | null }> {
  const configured = await resolveConfiguredWriteProvider(db, {
    visibilityScope,
    purpose,
    preferredEnvironment,
  });
  if (configured) {
    return { provider: configured.provider, instance: configured.instance };
  }
  if (visibilityScope === "public_assets") {
    guard(false, "PUBLIC_STORAGE_UNCONFIGURED", "No active public_assets object storage instance is configured.", 503);
  }
  return { provider: requireRuntimeProvider(), instance: null };
}

async function resolveReadProviderAndInstance(
  db: Pick<DB, "query">,
  obj: { storage_instance_id?: string | null; storage_provider_key: string; visibility?: string },
): Promise<{ provider: ObjectStorageProvider; instance: StorageInstanceRow | null }> {
  const configured = await resolveConfiguredReadProvider(db, obj);
  if (configured) {
    return { provider: configured.provider, instance: configured.instance };
  }
  if (obj.storage_instance_id) {
    guard(false, "OBJECT_STORAGE_UNAVAILABLE", "Configured storage instance for object cannot be resolved.", 503);
  }
  return { provider: requireRuntimeProvider(), instance: null };
}

export function detectMimeFromMagicBytes(head: Uint8Array): string | null {
  if (head.length < 4) return null;

  const textPrefix = Buffer.from(head.subarray(0, Math.min(head.length, 512)))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (
    textPrefix.startsWith("<svg") ||
    textPrefix.startsWith("<?xml") && textPrefix.includes("<svg") ||
    textPrefix.startsWith("<!doctype html") ||
    textPrefix.startsWith("<html") ||
    textPrefix.startsWith("<script")
  ) {
    return "text/html+active";
  }

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    head.length >= 12 &&
    Buffer.from(head.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(head.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (head.length >= 5 && Buffer.from(head.subarray(0, 5)).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (head.length >= 12 && Buffer.from(head.subarray(4, 8)).toString("ascii") === "ftyp") {
    const brand = Buffer.from(head.subarray(8, 12)).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
    if (brand === "qt  ") {
      return "video/quicktime";
    }
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "f4v "].includes(brand)) {
      return "video/mp4";
    }
  }
  return null;
}

function assertActorCanAccessObject(
  actor: Actor,
  obj: { org_id: string | null; owner_user_id: string | null; created_by: string | null },
) {
  if (actor.kind === "staff") {
    role(actor, ...STAFF_OBJECT_ROLES);
    return;
  }
  guard(
    Boolean(actor.org && obj.org_id && actor.org === obj.org_id),
    "NOT_FOUND",
    "Storage object not found.",
    404,
  );
}

export function listProviderCapabilities(actor: Actor) {
  role(actor, ...STAFF_OBJECT_ROLES);
  return { capabilities: Object.values(STORAGE_PROVIDER_CAPABILITIES) };
}

export async function authorizeStorageUpload(
  db: DB,
  actor: Actor,
  input: z.infer<typeof authorizeStorageUploadSchema>,
) {
  if (actor.kind === "staff") {
    role(actor, ...STAFF_OBJECT_ROLES);
  } else {
    guard(actor.kind === "customer" && actor.org, "FORBIDDEN", "Customer organization required.", 403);
  }
  return authorizeScopedStorageUpload(db, actor, input, "private_evidence");
}

export async function authorizePublicAssetUpload(
  db: DB,
  actor: Actor,
  input: z.infer<typeof authorizeStorageUploadSchema>,
) {
  role(actor, "super_admin", "template_admin");
  return authorizeScopedStorageUpload(db, actor, input, "public_assets");
}

async function authorizeScopedStorageUpload(
  db: DB,
  actor: Actor,
  input: z.infer<typeof authorizeStorageUploadSchema>,
  visibilityScope: "private_evidence" | "public_assets",
) {
  const { provider, instance } = await resolveWriteProviderAndInstance(
    db,
    visibilityScope,
    input.purpose,
    input.environment,
  );
  if (instance) {
    guard(
      BigInt(input.size_bytes) <= BigInt(instance.max_file_size_bytes),
      "FILE_TOO_LARGE",
      `File exceeds maximum allowed size (${instance.max_file_size_bytes} bytes) for instance '${instance.instance_key}'.`,
      422,
    );
    guard(
      Array.isArray(instance.allowed_mimes) && instance.allowed_mimes.includes(input.declared_mime),
      "UNSUPPORTED_MEDIA_TYPE",
      `MIME type '${input.declared_mime}' is not permitted on storage instance '${instance.instance_key}'.`,
      422,
    );
  }

  if (input.parent_object_id) {
    const parent = await one<{ id: string; org_id: string | null; status: string }>(
      db,
      "select id, org_id, status from storage_objects where id = $1 for share",
      [input.parent_object_id],
    );
    if (actor.kind === "customer") {
      guard(parent.org_id === actor.org, "NOT_FOUND", "Parent object not found.", 404);
    }
    guard(parent.status !== "archived", "PARENT_OBJECT_ARCHIVED", "Cannot derive from an archived storage object.", 409);
  }

  const objectId = uuid();
  const orgSegment = visibilityScope === "public_assets" ? "public" : actor.org ?? "staff";
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const ext = MIME_EXTENSIONS[input.declared_mime];
  const prefix = instance?.key_prefix ? `${instance.key_prefix}/` : "";
  const rootFolder = visibilityScope === "public_assets" ? "public" : `private/${orgSegment}`;
  const dbVisibility = visibilityScope === "public_assets" ? "public_asset" : "private";
  const objectKey = `${prefix}${rootFolder}/${input.purpose}/${yyyy}/${mm}/${objectId}/${input.variant_kind}.${ext}`;
  const stagingKey = stagingKeyFor(objectKey);
  const presignPutTtl = instance?.presign_put_ttl_sec ?? 600;
  const retentionUntil = input.retention_days ? new Date(Date.now() + input.retention_days * 86400_000).toISOString() : null;

  const obj = await one(
    db,
    `insert into storage_objects(
       id, storage_instance_id, storage_provider_key, bucket, object_key, org_id, owner_user_id, purpose,
       visibility, original_filename, declared_mime, size_bytes, expected_sha256,
       status, is_immutable, parent_object_id, variant_kind, retention_until, legal_hold, created_by
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'authorized', true, $14, $15, $16, $17, $18)
     returning id, storage_instance_id, storage_provider_key, bucket, object_key, visibility, declared_mime, size_bytes, expected_sha256, status, variant_kind, is_immutable`,
    [
      objectId,
      instance?.id ?? null,
      provider.providerKey,
      provider.bucket,
      objectKey,
      visibilityScope === "public_assets" ? null : actor.org ?? null,
      actor.id,
      input.purpose,
      dbVisibility,
      input.original_filename ?? null,
      input.declared_mime,
      input.size_bytes,
      input.expected_sha256,
      input.parent_object_id ?? null,
      input.variant_kind,
      retentionUntil,
      input.legal_hold,
      actor.id,
    ],
  );

  let providerUploadId: string | null = null;
  let uploadTarget: Record<string, unknown>;
  if (input.upload_mode === "multipart") {
    const mp = await provider.createMultipartUpload(stagingKey, input.declared_mime);
    providerUploadId = mp.uploadId;
    const partsCount = input.expected_parts ?? 1;
    const partUrls = Array.from({ length: partsCount }, (_, idx) => ({
      part_number: idx + 1,
      ...provider.presignUploadPart(stagingKey, mp.uploadId, idx + 1, presignPutTtl),
    }));
    uploadTarget = {
      upload_mode: "multipart",
      upload_id: mp.uploadId,
      part_urls: partUrls,
    };
  } else {
    const put = provider.presignPutObject(stagingKey, input.declared_mime, presignPutTtl);
    uploadTarget = {
      upload_mode: "presigned_put",
      ...put,
    };
  }

  const session = await one(
    db,
    `insert into storage_upload_sessions(
       id, object_id, upload_mode, provider_upload_id, part_size_bytes, expected_parts,
       status, expires_at, created_by
     ) values($1, $2, $3, $4, $5, $6, 'open', now() + interval '15 minutes', $7)
     returning id, upload_mode, status, expires_at`,
    [
      uuid(),
      objectId,
      input.upload_mode,
      providerUploadId,
      input.part_size_bytes ?? null,
      input.expected_parts ?? null,
      actor.id,
    ],
  );

  await db.query(
    `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
     values($1, $2, $3, 'presign_put', 'authorized')`,
    [objectId, actor.id, actor.kind],
  );
  await audit(db, actor, "storage_upload_authorized", "storage_objects", objectId, {
    purpose: input.purpose,
    visibility_scope: visibilityScope,
    declared_mime: input.declared_mime,
    size_bytes: input.size_bytes,
    upload_mode: input.upload_mode,
    instance_id: instance?.id ?? null,
  });

  return {
    object: obj,
    session,
    upload: uploadTarget,
  };
}

export async function reissueStorageUploadSession(
  db: DB,
  actor: Actor,
  objectId: string,
  uploadMode?: "presigned_put" | "multipart",
  expectedParts?: number,
) {
  const obj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    bucket: string;
    object_key: string;
    visibility: string;
    org_id: string | null;
    owner_user_id: string | null;
    created_by: string | null;
    declared_mime: string;
    size_bytes: string;
    expected_sha256: string;
    status: string;
    variant_kind: string;
    is_immutable: boolean;
  }>(
    db,
    `select id, storage_instance_id, storage_provider_key, bucket, object_key, visibility,
            org_id, owner_user_id, created_by, declared_mime, size_bytes::text as size_bytes,
            expected_sha256, status, variant_kind, is_immutable
     from storage_objects where id = $1 for update`,
    [objectId],
  );
  assertActorCanAccessObject(actor, obj);
  guard(
    ["authorized", "uploading", "uploaded_unverified"].includes(obj.status),
    "OBJECT_STATE_INVALID",
    `Cannot reissue upload session for object in status '${obj.status}'.`,
    409,
  );
  const { provider, instance } = await resolveReadProviderAndInstance(db, obj);
  const stagingKey = stagingKeyFor(obj.object_key);
  const presignPutTtl = instance?.presign_put_ttl_sec ?? 600;

  const existingOpen = (
    await db.query<{ id: string; upload_mode: string; provider_upload_id: string | null; expected_parts: number | null; is_expired: boolean }>(
      `select id, upload_mode, provider_upload_id, expected_parts, (expires_at <= now()) as is_expired
       from storage_upload_sessions
       where object_id = $1 and status = 'open'
       order by created_at desc limit 1 for update`,
      [obj.id],
    )
  ).rows[0];

  const resolvedMode = uploadMode ?? (existingOpen?.upload_mode === "multipart" ? "multipart" : "presigned_put");
  const resolvedParts = expectedParts ?? existingOpen?.expected_parts ?? 1;

  if (existingOpen && existingOpen.is_expired) {
    await db.query(
      "update storage_upload_sessions set status = 'expired', updated_at = now() where id = $1",
      [existingOpen.id],
    );
  }

  let providerUploadId: string | null = existingOpen && !existingOpen.is_expired ? existingOpen.provider_upload_id : null;
  let sessionId: string;
  let expiresAt: string;
  let uploadTarget: Record<string, unknown>;

  if (resolvedMode === "multipart") {
    if (!providerUploadId) {
      const mp = await provider.createMultipartUpload(stagingKey, obj.declared_mime);
      providerUploadId = mp.uploadId;
    }
    const partUrls = Array.from({ length: resolvedParts }, (_, idx) => ({
      part_number: idx + 1,
      ...provider.presignUploadPart(stagingKey, providerUploadId!, idx + 1, presignPutTtl),
    }));
    uploadTarget = {
      upload_mode: "multipart",
      upload_id: providerUploadId,
      part_urls: partUrls,
    };
  } else {
    const put = provider.presignPutObject(stagingKey, obj.declared_mime, presignPutTtl);
    uploadTarget = {
      upload_mode: "presigned_put",
      ...put,
    };
  }

  if (existingOpen && !existingOpen.is_expired && existingOpen.upload_mode === resolvedMode) {
    const row = await one<{ id: string; expires_at: string }>(
      db,
      "update storage_upload_sessions set expires_at = now() + interval '15 minutes', updated_at = now() where id = $1 returning id, expires_at",
      [existingOpen.id],
    );
    sessionId = row.id;
    expiresAt = row.expires_at;
  } else {
    if (existingOpen && !existingOpen.is_expired) {
      await db.query("update storage_upload_sessions set status = 'aborted', updated_at = now() where id = $1", [existingOpen.id]);
    }
    const inserted = await one<{ id: string; expires_at: string }>(
      db,
      `insert into storage_upload_sessions(
         id, object_id, upload_mode, provider_upload_id, expected_parts, status, expires_at, created_by
       ) values($1, $2, $3, $4, $5, 'open', now() + interval '15 minutes', $6)
       returning id, expires_at`,
      [uuid(), obj.id, resolvedMode, providerUploadId, resolvedMode === "multipart" ? resolvedParts : null, actor.id],
    );
    sessionId = inserted.id;
    expiresAt = inserted.expires_at;
  }

  return {
    object: obj,
    session: { id: sessionId, upload_mode: resolvedMode, status: "open", expires_at: expiresAt },
    upload: uploadTarget,
  };
}

export async function issueMultipartPartUrl(
  db: DB,
  actor: Actor,
  objectId: string,
  partNumber: number,
) {
  const obj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    object_key: string;
    org_id: string | null;
    owner_user_id: string | null;
    created_by: string | null;
    status: string;
  }>(
    db,
    "select id, storage_instance_id, storage_provider_key, object_key, org_id, owner_user_id, created_by, status from storage_objects where id = $1 for share",
    [objectId],
  );
  assertActorCanAccessObject(actor, obj);
  guard(obj.status === "authorized" || obj.status === "uploading", "OBJECT_NOT_UPLOADING", "Object is no longer accepting parts.", 409);
  const { provider, instance } = await resolveReadProviderAndInstance(db, obj);

  const sess = await one<{ id: string; upload_mode: string; provider_upload_id: string | null; status: string; is_expired: boolean }>(
    db,
    `select id, upload_mode, provider_upload_id, status, (expires_at <= now()) as is_expired
     from storage_upload_sessions
     where object_id = $1 and status = 'open'
     order by created_at desc limit 1 for update`,
    [objectId],
  );
  guard(sess.upload_mode === "multipart" && sess.provider_upload_id && !sess.is_expired, "UPLOAD_SESSION_EXPIRED", "Multipart session is invalid or expired.", 409);

  return {
    object_id: obj.id,
    part_number: partNumber,
    ...provider.presignUploadPart(stagingKeyFor(obj.object_key), sess.provider_upload_id, partNumber, instance?.presign_put_ttl_sec ?? 600),
  };
}

async function computeStreamSha256AndHead(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{
  totalBytes: number;
  exceededLimit: boolean;
  sha256: string;
  headBytes: Uint8Array;
}> {
  const hasher = createHash("sha256");
  const reader = stream.getReader();
  const headChunks: Uint8Array[] = [];
  let headLength = 0;
  let totalBytes = 0;
  let exceededLimit = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      exceededLimit = true;
      await reader.cancel().catch(() => {});
      break;
    }
    hasher.update(value);
    if (headLength < 512) {
      const take = Math.min(512 - headLength, value.byteLength);
      headChunks.push(value.subarray(0, take));
      headLength += take;
    }
  }
  const headBytes = Buffer.concat(headChunks.map((c) => Buffer.from(c)));
  return { totalBytes, exceededLimit, sha256: hasher.digest("hex"), headBytes };
}

export async function completeStorageUpload(
  db: DB,
  actor: Actor,
  objectId: string,
  input: z.infer<typeof completeStorageUploadSchema>,
) {
  const obj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    bucket: string;
    object_key: string;
    org_id: string | null;
    owner_user_id: string | null;
    created_by: string | null;
    declared_mime: string;
    size_bytes: string;
    expected_sha256: string;
    status: string;
  }>(
    db,
    `select id, storage_instance_id, storage_provider_key, bucket, object_key, org_id, owner_user_id, created_by,
            declared_mime, size_bytes::text as size_bytes, expected_sha256, status
     from storage_objects where id = $1 for update`,
    [objectId],
  );
  assertActorCanAccessObject(actor, obj);
  guard(
    obj.status !== "ready",
    "OBJECT_IMMUTABLE_NO_OVERWRITE",
    "Verified ready object is immutable and cannot be overwritten.",
    409,
  );
  guard(
    ["authorized", "uploading", "uploaded_unverified"].includes(obj.status),
    "OBJECT_STATE_INVALID",
    `Cannot complete upload from status '${obj.status}'.`,
    409,
  );
  const { provider } = await resolveReadProviderAndInstance(db, obj);

  const sess = await one<{
    id: string;
    upload_mode: string;
    provider_upload_id: string | null;
    expected_parts: number | null;
    status: string;
    is_expired: boolean;
  }>(
    db,
    `select id, upload_mode, provider_upload_id, expected_parts, status, (expires_at <= now()) as is_expired
     from storage_upload_sessions
     where object_id = $1 and status = 'open'
     order by created_at desc limit 1 for update`,
    [objectId],
  );
  guard(!sess.is_expired, "UPLOAD_SESSION_EXPIRED", "Upload session expired before completion.", 409);

  const stagingKey = stagingKeyFor(obj.object_key);
  let head = await provider.headObject(stagingKey);
  let versionId: string | null = head.versionId;

  if (sess.upload_mode === "multipart" && !head.exists) {
    guard(sess.provider_upload_id, "UPLOAD_SESSION_INVALID", "Missing provider multipart upload ID.", 409);
    const parts = (input.parts ?? []).map((p) => ({ partNumber: p.part_number, etag: p.etag }));
    guard(parts.length > 0, "MULTIPART_PARTS_REQUIRED", "Multipart completion requires uploaded part ETags.", 422);
    const seenParts = new Set(parts.map((p) => p.partNumber));
    guard(seenParts.size === parts.length, "INVALID_PART_NUMBERS", "Duplicate multipart part numbers are not allowed.", 422);
    if (sess.expected_parts !== null) {
      guard(
        parts.length === sess.expected_parts,
        "MULTIPART_PART_COUNT_MISMATCH",
        `Expected ${sess.expected_parts} multipart parts, got ${parts.length}.`,
        422,
      );
    }
    const remoteParts = await provider.listUploadedParts(stagingKey, sess.provider_upload_id);
    for (const p of parts) {
      const match = remoteParts.find((rp) => rp.partNumber === p.partNumber);
      guard(
        match && match.etag.replaceAll('"', "") === p.etag.replaceAll('"', ""),
        "MULTIPART_PART_MISMATCH",
        `Uploaded part ${p.partNumber} does not match provider record.`,
        422,
      );
    }
    const completed = await provider.completeMultipartUpload(stagingKey, sess.provider_upload_id, parts);
    versionId = completed.versionId;
    head = await provider.headObject(stagingKey);
  }

  guard(head.exists, "OBJECT_NOT_UPLOADED", "Uploaded object does not exist in staging storage.", 409);
  const expectedSize = Number(obj.size_bytes);

  const quarantineReasons: string[] = [];
  let detectedMime: string | null = null;
  let computedSha: string | null = null;

  if (head.sizeBytes !== expectedSize) {
    quarantineReasons.push(`SIZE_MISMATCH(expected=${expectedSize},head=${head.sizeBytes})`);
  } else {
    const streamRes = await provider.getObjectStream(stagingKey);
    const { totalBytes, exceededLimit, sha256, headBytes } = await computeStreamSha256AndHead(streamRes.body, expectedSize);
    computedSha = sha256;
    detectedMime = detectMimeFromMagicBytes(headBytes);
    if (exceededLimit || totalBytes !== expectedSize) {
      quarantineReasons.push(`SIZE_MISMATCH(expected=${expectedSize},actual=${totalBytes})`);
    }
    if (!exceededLimit && sha256 !== obj.expected_sha256) {
      quarantineReasons.push("SHA256_MISMATCH");
    }
    if (!detectedMime || detectedMime !== obj.declared_mime) {
      quarantineReasons.push(`MIME_MAGIC_MISMATCH(declared=${obj.declared_mime},detected=${detectedMime ?? "unknown"})`);
    }
  }

  if (quarantineReasons.length > 0) {
    const qKey = quarantineKeyFor(obj.object_key);
    await provider.copyObject(stagingKey, qKey).catch(() => {});
    await provider.deleteObject(stagingKey).catch(() => {});

    const quarantinedObj = await one(
      db,
      `update storage_objects
       set status = 'quarantined',
           detected_mime = $2,
           verified_sha256 = $3,
           object_version_id = coalesce($4, object_version_id),
           updated_at = now()
       where id = $1
       returning id, status, declared_mime, detected_mime, expected_sha256, verified_sha256`,
      [obj.id, detectedMime, computedSha, versionId ?? head.versionId],
    );
    await db.query(
      "update storage_upload_sessions set status = 'completed', updated_at = now() where id = $1",
      [sess.id],
    );
    await db.query(
      `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
       values($1, $2, $3, 'quarantine', $4)`,
      [obj.id, actor.id, actor.kind, quarantineReasons.join(";")],
    );
    await audit(db, actor, "storage_object_quarantined", "storage_objects", obj.id, {
      reasons: quarantineReasons,
    });
    return {
      quarantined: true,
      error: {
        code: "OBJECT_VERIFICATION_QUARANTINED",
        message: `Uploaded object failed integrity verification and was quarantined: ${quarantineReasons.join(", ")}`,
      },
      quarantine_reasons: quarantineReasons,
      object: quarantinedObj,
    };
  }

  // Promote verified staging object into immutable private final path, then delete staging copy
  const promoted = await provider.copyObject(stagingKey, obj.object_key);
  await provider.deleteObject(stagingKey).catch(() => {});

  const readyObj = await one(
    db,
    `update storage_objects
     set status = 'ready',
         detected_mime = $2,
         verified_sha256 = $3,
         object_version_id = coalesce($4, object_version_id),
         verified_at = now(),
         updated_at = now()
     where id = $1
     returning id, storage_provider_key, bucket, object_key, object_version_id, declared_mime, detected_mime, size_bytes, verified_sha256, status, is_immutable, verified_at`,
    [obj.id, detectedMime, computedSha, promoted.versionId ?? versionId ?? head.versionId],
  );
  await db.query(
    "update storage_upload_sessions set status = 'completed', updated_at = now() where id = $1",
    [sess.id],
  );
  await audit(db, actor, "storage_object_ready", "storage_objects", obj.id, {
    sha256: computedSha,
    detected_mime: detectedMime,
  });

  return { quarantined: false, object: readyObj };
}

export async function abortStorageUpload(db: DB, actor: Actor, objectId: string) {
  const obj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    object_key: string;
    org_id: string | null;
    owner_user_id: string | null;
    created_by: string | null;
    status: string;
  }>(
    db,
    "select id, storage_instance_id, storage_provider_key, object_key, org_id, owner_user_id, created_by, status from storage_objects where id = $1 for update",
    [objectId],
  );
  assertActorCanAccessObject(actor, obj);
  guard(obj.status !== "ready", "OBJECT_IMMUTABLE_NO_OVERWRITE", "Cannot abort a verified ready object.", 409);
  const { provider } = await resolveReadProviderAndInstance(db, obj);

  const stagingKey = stagingKeyFor(obj.object_key);
  const sess = (
    await db.query<{ id: string; upload_mode: string; provider_upload_id: string | null }>(
      "select id, upload_mode, provider_upload_id from storage_upload_sessions where object_id = $1 and status = 'open' for update",
      [objectId],
    )
  ).rows[0];

  if (sess) {
    if (sess.upload_mode === "multipart" && sess.provider_upload_id) {
      await provider.abortMultipartUpload(stagingKey, sess.provider_upload_id);
    }
    await db.query("update storage_upload_sessions set status = 'aborted', updated_at = now() where id = $1", [sess.id]);
  }
  await provider.deleteObject(stagingKey).catch(() => {});
  const updated = await one(
    db,
    "update storage_objects set status = 'cancelled', updated_at = now() where id = $1 returning id, status",
    [obj.id],
  );
  return { object: updated };
}

export async function resolveObjectStorageProviderForRead(
  db: Pick<DB, "query">,
  obj: { storage_instance_id?: string | null; storage_provider_key: string; visibility?: string },
): Promise<{ provider: ObjectStorageProvider; instance: StorageInstanceRow | null }> {
  return resolveReadProviderAndInstance(db, obj);
}

export async function authorizePrivateObjectRead(
  db: DB,
  actor: Actor,
  objectId: string,
  expiresSeconds = 180,
) {
  const obj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    object_key: string;
    visibility: string;
    org_id: string | null;
    owner_user_id: string | null;
    created_by: string | null;
    status: string;
    declared_mime: string;
    detected_mime: string | null;
    verified_sha256: string | null;
  }>(
    db,
    `select id, storage_instance_id, storage_provider_key, object_key, visibility, org_id, owner_user_id, created_by, status, declared_mime, detected_mime, verified_sha256
     from storage_objects where id = $1`,
    [objectId],
  );
  assertActorCanAccessObject(actor, obj);
  guard(obj.status === "ready", "OBJECT_NOT_READY", `Object in status '${obj.status}' cannot be accessed.`, 409);
  const { provider, instance } = await resolveReadProviderAndInstance(db, obj);
  const ttl = Math.max(30, Math.min(expiresSeconds, instance?.presign_get_ttl_sec ?? 300));

  const access = provider.presignGetObject(obj.object_key, ttl);
  await db.query(
    `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
     values($1, $2, $3, 'presign_get', 'granted')`,
    [obj.id, actor.id, actor.kind],
  );

  return {
    object_id: obj.id,
    mime: obj.detected_mime ?? obj.declared_mime,
    sha256: obj.verified_sha256,
    ...access,
  };
}

function parseOptionalByteRange(rangeHeader: string | null): { start: number; end: number | null } | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.trim().match(/^bytes=(\d+)-(\d*)$/);
  guard(match, "INVALID_RANGE", "Invalid Range header.", 416);
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  guard(end === null || start <= end, "RANGE_NOT_SATISFIABLE", "Range start exceeds range end.", 416);
  return { start, end };
}

export async function streamPrivateObjectResponse(
  actor: Actor,
  objectId: string,
  rangeHeader: string | null,
): Promise<Response> {
  const parsedRange = parseOptionalByteRange(rangeHeader);

  const { row, provider } = await transaction(async (db) => {
    const r = await one<{
      id: string;
      storage_instance_id: string | null;
      storage_provider_key: string;
      object_key: string;
      org_id: string | null;
      owner_user_id: string | null;
      created_by: string | null;
      status: string;
      size_bytes: string;
      declared_mime: string;
      detected_mime: string | null;
    }>(
      db,
      `select id, storage_instance_id, storage_provider_key, object_key, org_id, owner_user_id, created_by, status, size_bytes::text as size_bytes, declared_mime, detected_mime
       from storage_objects where id = $1`,
      [objectId],
    );
    assertActorCanAccessObject(actor, r);
    guard(r.status === "ready", "OBJECT_NOT_READY", `Object in status '${r.status}' cannot be streamed.`, 409);
    const totalSize = Number(r.size_bytes);
    if (parsedRange && parsedRange.start >= totalSize) {
      guard(false, "RANGE_NOT_SATISFIABLE", `Requested range start ${parsedRange.start} is outside object size ${totalSize}.`, 416);
    }
    const target = await resolveReadProviderAndInstance(db, r);
    return { row: r, provider: target.provider };
  });

  const streamRes = await provider.getObjectStream(row.object_key, rangeHeader ?? undefined);
  await pool.query(
    `insert into storage_access_audit(object_id, actor_id, actor_kind, action, range_header, status)
     values($1, $2, $3, $4, $5, 'granted')`,
    [row.id, actor.id, actor.kind, rangeHeader ? "range_read" : "stream_read", rangeHeader],
  );
  const headers = new Headers({
    "content-type": row.detected_mime ?? row.declared_mime,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  if (streamRes.contentLength !== null) headers.set("content-length", String(streamRes.contentLength));
  if (streamRes.contentRange) headers.set("content-range", streamRes.contentRange);
  if (streamRes.etag) headers.set("etag", streamRes.etag);

  return new Response(streamRes.body, { status: streamRes.status, headers });
}

export async function streamPublicAssetResponse(
  objectId: string,
  rangeHeader: string | null,
): Promise<Response> {
  const parsedRange = parseOptionalByteRange(rangeHeader);
  const { row, provider } = await transaction(async (db) => {
    const r = (
      await db.query<{
        id: string;
        storage_instance_id: string | null;
        storage_provider_key: string;
        object_key: string;
        visibility: string;
        status: string;
        size_bytes: string;
        declared_mime: string;
        detected_mime: string | null;
      }>(
        `select id, storage_instance_id, storage_provider_key, object_key, visibility, status, size_bytes::text as size_bytes, declared_mime, detected_mime
         from storage_objects where id = $1`,
        [objectId],
      )
    ).rows[0];
    guard(
      r && r.visibility === "public_asset" && r.status === "ready",
      "NOT_FOUND",
      "Public asset not found.",
      404,
    );
    const totalSize = Number(r.size_bytes);
    if (parsedRange && parsedRange.start >= totalSize) {
      guard(false, "RANGE_NOT_SATISFIABLE", `Requested range start ${parsedRange.start} is outside object size ${totalSize}.`, 416);
    }
    const target = await resolveReadProviderAndInstance(db, r);
    guard(
      target.instance?.visibility_scope === "public_assets",
      "NOT_FOUND",
      "Public asset storage boundary mismatch.",
      404,
    );
    return { row: r, provider: target.provider };
  });

  const streamRes = await provider.getObjectStream(row.object_key, rangeHeader ?? undefined);
  const headers = new Headers({
    "content-type": row.detected_mime ?? row.declared_mime,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  if (streamRes.contentLength !== null) headers.set("content-length", String(streamRes.contentLength));
  if (streamRes.contentRange) headers.set("content-range", streamRes.contentRange);
  if (streamRes.etag) headers.set("etag", streamRes.etag);

  return new Response(streamRes.body, { status: streamRes.status, headers });
}

export async function recordBlockedDeletionAudit(
  objectId: string,
  actor: Actor,
  statusDetail: string,
) {
  await pool.query(
    `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
     values($1, $2, $3, 'delete_blocked', $4)`,
    [objectId, actor.id, actor.kind, statusDetail.slice(0, 120)],
  );
}

export async function deleteStorageObjectControlled(
  db: DB,
  actor: Actor,
  objectId: string,
  reason: string,
) {
  role(actor, "super_admin");
  const obj = await one<{
    id: string;
    storage_instance_id: string | null;
    storage_provider_key: string;
    object_key: string;
    status: string;
    legal_hold: boolean;
    retention_expired: boolean;
  }>(
    db,
    `select id, storage_instance_id, storage_provider_key, object_key, status, legal_hold,
            (retention_until is null or retention_until <= now()) as retention_expired
     from storage_objects where id = $1 for update`,
    [objectId],
  );
  guard(obj.status !== "archived", "ALREADY_ARCHIVED", "Object is already archived.", 409);
  const activeChildren = await db.query(
    "select 1 from storage_objects where parent_object_id = $1 and status <> 'archived' limit 1",
    [obj.id],
  );
  if (obj.legal_hold || !obj.retention_expired || (activeChildren.rowCount ?? 0) > 0) {
    const blockReason = obj.legal_hold ? "legal_hold" : !obj.retention_expired ? "retention_active" : "active_children";
    guard(
      false,
      "DELETION_PROTECTED",
      `Object deletion blocked (${blockReason}): protected by legal hold, active retention window, or derivative references.`,
      409,
    );
  }
  const { provider } = await resolveReadProviderAndInstance(db, obj);

  await provider.deleteObject(obj.object_key);
  const archived = await one(
    db,
    "update storage_objects set status = 'archived', updated_at = now() where id = $1 returning id, status",
    [obj.id],
  );
  await db.query(
    `insert into storage_access_audit(object_id, actor_id, actor_kind, action, status)
     values($1, $2, $3, 'delete_executed', 'archived')`,
    [obj.id, actor.id, actor.kind],
  );
  await audit(db, actor, "storage_object_deleted", "storage_objects", obj.id, { reason });
  return { object: archived };
}
