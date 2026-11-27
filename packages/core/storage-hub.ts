import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, transaction, type DB } from "../db";
import { appOrigin, requireStaffMfa } from "./auth";
import { audit, guard, one, Problem, role, uuid, type Actor } from "./common";
import { seal, unseal } from "./crypto";
import { maskSecret } from "./integrations-admin";
import {
  assertProductionStorageAllowed,
  assertSafeStorageEndpoint,
  assertSafeStorageEndpointDns,
  runStorageCapabilityProbe,
  S3CompatibleStorageProvider,
  STORAGE_PROVIDER_CAPABILITIES,
  type AddressingStyle,
  type ObjectStorageProvider,
  type ObjectStorageProviderType,
} from "./object-storage";

export type StorageRole =
  | "primary"
  | "secondary_failover"
  | "independent_backup"
  | "archive"
  | "public_assets"
  | "test_sandbox";

export type StorageVisibilityScope = "private_evidence" | "public_assets";
export type StorageEnvironment = "sandbox" | "live";
export type StorageLifecycleState = "draft" | "verified" | "active" | "read_only_legacy" | "disabled";
export type StorageEncryptionPolicy = "sse_s3" | "sse_kms" | "provider_managed";
export type StorageSecretName = "access_key_id" | "secret_access_key" | "session_token";

export interface StorageInstanceRow {
  id: string;
  instance_key: string;
  display_name: string;
  provider_type: ObjectStorageProviderType;
  storage_role: StorageRole;
  visibility_scope: StorageVisibilityScope;
  environment: StorageEnvironment;
  lifecycle_state: StorageLifecycleState;
  allow_new_writes: boolean;
  allow_reads: boolean;
  endpoint_url: string;
  region: string;
  bucket: string;
  account_identifier: string | null;
  key_prefix: string;
  addressing_style: AddressingStyle;
  public_cdn_base_url: string | null;
  encryption_policy: StorageEncryptionPolicy;
  connect_timeout_ms: number;
  upload_timeout_ms: number;
  max_retries: number;
  presign_put_ttl_sec: number;
  presign_get_ttl_sec: number;
  max_file_size_bytes: string;
  multipart_threshold_bytes: string;
  multipart_part_size_bytes: string;
  max_concurrent_uploads: number;
  allowed_mimes: string[];
  routing_purposes: string[];
  allowed_cors_origins: string[];
  health_status: "unknown" | "verified" | "degraded" | "error" | "unconfigured";
  last_probe_at: string | null;
  last_probe_summary: string | null;
  last_probe_detail: Record<string, unknown>;
  last_error_class: string | null;
  last_error_message: string | null;
  requires_icp: boolean;
  created_at: string;
  updated_at: string;
}

export interface StorageProviderPreset {
  provider_type: ObjectStorageProviderType;
  display_name: string;
  default_region: string;
  default_addressing_style: AddressingStyle;
  endpoint_example: string;
  default_encryption_policy: StorageEncryptionPolicy;
  defaults: {
    connect_timeout_ms: number;
    upload_timeout_ms: number;
    max_retries: number;
    presign_put_ttl_sec: number;
    presign_get_ttl_sec: number;
    max_file_size_bytes: number;
    multipart_threshold_bytes: number;
    multipart_part_size_bytes: number;
    max_concurrent_uploads: number;
  };
  setup_steps_zh: string[];
}

export const STORAGE_PROVIDER_PRESETS: Record<ObjectStorageProviderType, StorageProviderPreset> = {
  cloudflare_r2: {
    provider_type: "cloudflare_r2",
    display_name: "Cloudflare R2",
    default_region: "auto",
    default_addressing_style: "path",
    endpoint_example: "https://<account_id>.r2.cloudflarestorage.com",
    default_encryption_policy: "provider_managed",
    defaults: {
      connect_timeout_ms: 5000,
      upload_timeout_ms: 45000,
      max_retries: 2,
      presign_put_ttl_sec: 600,
      presign_get_ttl_sec: 180,
      max_file_size_bytes: 2_000_000_000,
      multipart_threshold_bytes: 20 * 1024 * 1024,
      multipart_part_size_bytes: 10 * 1024 * 1024,
      max_concurrent_uploads: 4,
    },
    setup_steps_zh: [
      "在 Cloudflare R2 创建私有 Bucket（质检证据严禁开启 Public Access）。",
      "在 Bucket CORS Policy 中仅放行本站站点来源，AllowedMethods 仅含 PUT/GET/HEAD，AllowedHeaders 含 content-type。",
      "生成 R2 API Token 并通过下方加密凭证库写入 Access Key ID 与 Secret Access Key，随后运行真实读写与 CORS 探测。",
    ],
  },
  amazon_s3: {
    provider_type: "amazon_s3",
    display_name: "Amazon S3",
    default_region: "ap-southeast-1",
    default_addressing_style: "virtual_hosted",
    endpoint_example: "https://s3.ap-southeast-1.amazonaws.com",
    default_encryption_policy: "sse_s3",
    defaults: {
      connect_timeout_ms: 5000,
      upload_timeout_ms: 45000,
      max_retries: 2,
      presign_put_ttl_sec: 600,
      presign_get_ttl_sec: 180,
      max_file_size_bytes: 2_000_000_000,
      multipart_threshold_bytes: 20 * 1024 * 1024,
      multipart_part_size_bytes: 10 * 1024 * 1024,
      max_concurrent_uploads: 4,
    },
    setup_steps_zh: [
      "在 AWS S3 创建启用 Block All Public Access 与 Bucket Versioning 的私有 Bucket。",
      "配置独立 IAM 最小权限策略（s3:PutObject / GetObject / HeadObject / DeleteObject / ListBucket / AbortMultipartUpload）。",
      "配置 S3 CORS 允许站点来源执行 PUT，随后保存加密密钥并运行连接验证。",
    ],
  },
  backblaze_b2: {
    provider_type: "backblaze_b2",
    display_name: "Backblaze B2 (S3 Compatible)",
    default_region: "us-west-004",
    default_addressing_style: "path",
    endpoint_example: "https://s3.us-west-004.backblazeb2.com",
    default_encryption_policy: "sse_s3",
    defaults: {
      connect_timeout_ms: 6000,
      upload_timeout_ms: 60000,
      max_retries: 2,
      presign_put_ttl_sec: 600,
      presign_get_ttl_sec: 180,
      max_file_size_bytes: 2_000_000_000,
      multipart_threshold_bytes: 20 * 1024 * 1024,
      multipart_part_size_bytes: 10 * 1024 * 1024,
      max_concurrent_uploads: 4,
    },
    setup_steps_zh: [
      "在 Backblaze B2 创建 Private Bucket，建议仅绑定单个 Bucket 的 Application Key。",
      "在 B2 Bucket Settings 配置 S3 Compatible API CORS 规则，禁止公开列表。",
      "录入 S3 Endpoint、Region、Bucket 与加密 Key，运行真实读写/Range/分片/CORS 探测。",
    ],
  },
  generic_s3: {
    provider_type: "generic_s3",
    display_name: "Generic S3 Compatible Storage",
    default_region: "us-east-1",
    default_addressing_style: "path",
    endpoint_example: "https://s3.example-storage.com",
    default_encryption_policy: "provider_managed",
    defaults: {
      connect_timeout_ms: 5000,
      upload_timeout_ms: 45000,
      max_retries: 2,
      presign_put_ttl_sec: 600,
      presign_get_ttl_sec: 180,
      max_file_size_bytes: 2_000_000_000,
      multipart_threshold_bytes: 20 * 1024 * 1024,
      multipart_part_size_bytes: 10 * 1024 * 1024,
      max_concurrent_uploads: 4,
    },
    setup_steps_zh: [
      "确保兼容服务支持 AWS SigV4、预签名 PUT/GET、HTTP Range 206 及分段上传。",
      "Endpoint 必须为公网可解析 HTTPS 地址，站点 CORS 禁止使用通配符 *。",
      "建议首先作为 test_sandbox 或 independent_backup 实测通过后再切换为正式主存储。",
    ],
  },
};

const STORAGE_READ_ROLES = ["super_admin", "warehouse_admin", "finance"] as const;
const FORBIDDEN_CREDENTIAL_BODY_KEYS = [
  "access_key_id",
  "secret_access_key",
  "session_token",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "secret_key",
  "api_key",
];

let testAllowedEndpointOrigin: string | null = null;

/**
 * Registers a single loopback HTTP origin allowed strictly inside NODE_ENV=test.
 * Never exposed to HTTP request payloads so production SSRF rules remain unbypassable.
 */
export function registerTestAllowedStorageEndpointOrigin(origin: string | null): void {
  if (process.env.NODE_ENV !== "test" || !origin) {
    testAllowedEndpointOrigin = null;
    return;
  }
  testAllowedEndpointOrigin = new URL(origin).origin;
}

function endpointSafetyOptions(endpointUrl: string): { allowInsecureLoopbackForTest: boolean } {
  if (process.env.NODE_ENV !== "test" || !testAllowedEndpointOrigin) {
    return { allowInsecureLoopbackForTest: false };
  }
  try {
    return { allowInsecureLoopbackForTest: new URL(endpointUrl).origin === testAllowedEndpointOrigin };
  } catch {
    return { allowInsecureLoopbackForTest: false };
  }
}

export const createStorageInstanceSchema = z.object({
  instance_key: z.string().trim().min(2).max(63).regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
  display_name: z.string().trim().min(2).max(120),
  provider_type: z.enum(["cloudflare_r2", "amazon_s3", "backblaze_b2", "generic_s3"]),
  storage_role: z.enum(["primary", "secondary_failover", "independent_backup", "archive", "public_assets", "test_sandbox"]),
  visibility_scope: z.enum(["private_evidence", "public_assets"]).optional(),
  environment: z.enum(["sandbox", "live"]).default("sandbox"),
  endpoint_url: z.string().trim().min(8).max(400),
  region: z.string().trim().min(1).max(64).default("auto"),
  bucket: z.string().trim().min(2).max(128).regex(/^[a-z0-9][a-z0-9._-]{1,126}$/),
  account_identifier: z.string().trim().max(128).nullable().optional(),
  key_prefix: z.string().trim().max(128).default(""),
  addressing_style: z.enum(["path", "virtual_hosted"]).default("path"),
  public_cdn_base_url: z.string().trim().max(400).nullable().optional(),
  encryption_policy: z.enum(["sse_s3", "sse_kms", "provider_managed"]).default("provider_managed"),
  connect_timeout_ms: z.number().int().min(500).max(60000).default(5000),
  upload_timeout_ms: z.number().int().min(1000).max(300000).default(30000),
  max_retries: z.number().int().min(0).max(5).default(2),
  presign_put_ttl_sec: z.number().int().min(60).max(900).default(600),
  presign_get_ttl_sec: z.number().int().min(30).max(300).default(180),
  max_file_size_bytes: z.number().int().min(1024).max(5_000_000_000).default(2_000_000_000),
  multipart_threshold_bytes: z.number().int().min(5 * 1024 * 1024).max(1_000_000_000).default(20 * 1024 * 1024),
  multipart_part_size_bytes: z.number().int().min(5 * 1024 * 1024).max(500_000_000).default(10 * 1024 * 1024),
  max_concurrent_uploads: z.number().int().min(1).max(16).default(4),
  allowed_mimes: z.array(z.string().trim().min(3).max(80)).min(1).optional(),
  routing_purposes: z.array(z.string().trim().min(1).max(64)).optional(),
  allowed_cors_origins: z.array(z.string().trim().min(1).max(255)).optional(),
  requires_icp: z.boolean().optional(),
});

export const updateStorageInstanceSchema = createStorageInstanceSchema.omit({ instance_key: true }).partial().extend({
  requires_icp: z.boolean().optional(),
});

export const saveStorageSecretSchema = z.object({
  secret_name: z.enum(["access_key_id", "secret_access_key", "session_token"]),
  secret_value: z.string().trim().min(4).max(4096),
});

export const rollbackStorageSecretSchema = z.object({
  secret_name: z.enum(["access_key_id", "secret_access_key", "session_token"]),
  target_version: z.number().int().min(1).optional(),
});

export const revokeStorageSecretSchema = z.object({
  secret_name: z.enum(["access_key_id", "secret_access_key", "session_token"]),
});

export const transitionStorageStateSchema = z.object({
  lifecycle_state: z.enum(["draft", "verified", "active", "read_only_legacy", "disabled"]),
  allow_new_writes: z.boolean().optional(),
  allow_reads: z.boolean().optional(),
  reason: z.string().trim().min(2).max(400).optional(),
});

export const switchPrimaryStorageSchema = z.object({
  target_instance_id: z.uuid(),
  reason: z.string().trim().min(2).max(400),
});

export const createMigrationJobSchema = z.object({
  target_instance_id: z.uuid(),
  batch_size: z.number().int().min(1).max(200).default(20),
});

export const runMigrationBatchSchema = z.object({
  max_items: z.number().int().min(1).max(200).optional(),
});

function assertNoInlineSecrets(raw: Record<string, unknown>) {
  for (const key of FORBIDDEN_CREDENTIAL_BODY_KEYS) {
    guard(!(key in raw), "SECRET_VIA_VAULT_ONLY", `Credential '${key}' must be saved via the encrypted secrets endpoint.`, 400);
  }
}

function normalizeAndValidateCorsOrigins(rawOrigins: string[] | undefined): string[] {
  const cleaned: string[] = [];
  for (const entry of rawOrigins ?? []) {
    const trimmed = entry.trim();
    guard(!trimmed.includes("*"), "WILDCARD_CORS_FORBIDDEN", "Wildcard '*' CORS origin is forbidden; specify explicit site origins.", 422);
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      guard(false, "INVALID_CORS_ORIGIN", `CORS origin '${trimmed}' is invalid.`, 422);
      throw new Error("unreachable");
    }
    guard(!parsed.hostname.includes("*"), "WILDCARD_CORS_FORBIDDEN", "Wildcard '*' CORS origin host is forbidden; specify explicit site origins.", 422);
    guard(
      parsed.protocol === "https:" || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:"),
      "INVALID_CORS_ORIGIN",
      `CORS origin '${trimmed}' must use HTTPS in production.`,
      422,
    );
    cleaned.push(parsed.origin);
  }
  return Array.from(new Set(cleaned));
}

function normalizeKeyPrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function resolveScopeForRole(roleName: StorageRole, explicitScope?: StorageVisibilityScope): StorageVisibilityScope {
  const expected: StorageVisibilityScope = roleName === "public_assets" ? "public_assets" : "private_evidence";
  if (explicitScope && explicitScope !== expected) {
    guard(false, "STORAGE_ROLE_VISIBILITY_MISMATCH", `Role '${roleName}' requires visibility_scope '${expected}'.`, 422);
  }
  return expected;
}

function redactErrorText(msg: string, secrets: string[]): string {
  let out = msg;
  for (const sec of secrets) {
    if (sec && sec.length >= 4) {
      out = out.split(sec).join("[REDACTED]");
    }
  }
  return out.slice(0, 300);
}

async function listInstanceSecretsMeta(db: DB, instanceIds?: string[]) {
  const where = instanceIds && instanceIds.length > 0 ? "where instance_id = any($1::uuid[])" : "";
  const params = instanceIds && instanceIds.length > 0 ? [instanceIds] : [];
  return (
    await db.query<{
      id: string;
      instance_id: string;
      secret_name: StorageSecretName;
      masked_hint: string;
      key_version: number;
      status: "active" | "rotated" | "revoked";
      created_at: string;
      rotated_at: string | null;
      revoked_at: string | null;
    }>(
      `select id, instance_id, secret_name, masked_hint, key_version, status, created_at, rotated_at, revoked_at
       from storage_instance_secrets
       ${where}
       order by key_version desc, created_at desc`,
      params,
    )
  ).rows;
}

async function getActiveInstanceSecretNames(db: DB, instanceId: string): Promise<Set<StorageSecretName>> {
  const rows = (
    await db.query<{ secret_name: StorageSecretName }>(
      "select secret_name from storage_instance_secrets where instance_id = $1 and status = 'active'",
      [instanceId],
    )
  ).rows;
  return new Set(rows.map((r) => r.secret_name));
}

async function resolveInstanceCredentials(db: Pick<DB, "query">, instanceId: string) {
  const rows = (
    await db.query<{ secret_name: StorageSecretName; ciphertext: Buffer }>(
      `select secret_name, ciphertext
       from storage_instance_secrets
       where instance_id = $1 and status = 'active'`,
      [instanceId],
    )
  ).rows;
  const creds: Partial<Record<StorageSecretName, string>> = {};
  for (const row of rows) {
    creds[row.secret_name] = unseal(row.ciphertext);
  }
  if (!creds.access_key_id || !creds.secret_access_key) {
    return null;
  }
  return {
    accessKeyId: creds.access_key_id,
    secretAccessKey: creds.secret_access_key,
    sessionToken: creds.session_token,
  };
}

function providerFromRowAndCreds(
  row: Pick<StorageInstanceRow, "instance_key" | "provider_type" | "endpoint_url" | "region" | "bucket" | "addressing_style" | "upload_timeout_ms">,
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): ObjectStorageProvider {
  const opts = endpointSafetyOptions(row.endpoint_url);
  return new S3CompatibleStorageProvider({
    providerKey: row.instance_key,
    providerType: row.provider_type,
    endpoint: row.endpoint_url,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    addressingStyle: row.addressing_style,
    timeoutMs: row.upload_timeout_ms,
    allowInsecureLoopbackForTest: opts.allowInsecureLoopbackForTest,
  });
}

export async function listStorageInstances(db: DB, actor: Actor) {
  role(actor, ...STORAGE_READ_ROLES);
  const instances = (
    await db.query<StorageInstanceRow>(
      `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
              environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
              bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
              encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
              presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
              multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
              allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
              last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
              last_error_message, requires_icp, created_at, updated_at
       from storage_instances
       order by environment desc,
                case storage_role when 'primary' then 1 when 'secondary_failover' then 2 when 'independent_backup' then 3 when 'public_assets' then 4 when 'archive' then 5 else 6 end,
                created_at desc`,
    )
  ).rows;
  const secrets = await listInstanceSecretsMeta(db);
  const probes = (
    await db.query<{
      id: string;
      instance_id: string;
      probe_kind: string;
      ok: boolean;
      error_class: string | null;
      latency_ms: number | null;
      summary: string;
      created_at: string;
    }>(
      `select id, instance_id, probe_kind, ok, error_class, latency_ms, summary, created_at
       from storage_probe_runs
       order by created_at desc
       limit 50`,
    )
  ).rows;

  const byInstance = new Map<string, typeof secrets>();
  for (const s of secrets) {
    const list = byInstance.get(s.instance_id) ?? [];
    list.push(s);
    byInstance.set(s.instance_id, list);
  }
  const usage = await getStorageUsageMetrics(db, actor);

  return {
    presets: Object.values(STORAGE_PROVIDER_PRESETS),
    capabilities: Object.values(STORAGE_PROVIDER_CAPABILITIES),
    instances: instances.map((inst) => ({
      ...inst,
      secrets: byInstance.get(inst.id) ?? [],
    })),
    recent_probes: probes,
    usage,
  };
}

export async function getStorageInstanceDetail(db: DB, actor: Actor, instanceId: string) {
  role(actor, ...STORAGE_READ_ROLES);
  const inst = await one<StorageInstanceRow>(
    db,
    `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
            environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
            bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
            encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
            presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
            multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
            allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
            last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
            last_error_message, requires_icp, created_at, updated_at
     from storage_instances where id = $1`,
    [instanceId],
  );
  const secrets = await listInstanceSecretsMeta(db, [inst.id]);
  const probes = (
    await db.query(
      `select id, probe_kind, ok, error_class, latency_ms, step_results, summary, created_at
       from storage_probe_runs
       where instance_id = $1
       order by created_at desc
       limit 20`,
      [inst.id],
    )
  ).rows;
  const objStats = await one<{ total_objects: number; ready_objects: number; total_bytes: string }>(
    db,
    `select count(*)::int as total_objects,
            count(*) filter (where status = 'ready')::int as ready_objects,
            coalesce(sum(size_bytes) filter (where status <> 'archived'), 0)::text as total_bytes
     from storage_objects
     where storage_instance_id = $1 or storage_provider_key = $2`,
    [inst.id, inst.instance_key],
  );
  return { instance: { ...inst, secrets }, probes, stats: objStats };
}

async function assertNoPublicPrivateBucketConflict(
  db: DB,
  endpointUrl: string,
  bucket: string,
  visibilityScope: StorageVisibilityScope,
  excludeInstanceId?: string,
) {
  const existing = (
    await db.query<{ id: string; instance_key: string; visibility_scope: string; environment: string }>(
      `select id, instance_key, visibility_scope, environment
       from storage_instances
       where endpoint_url = $1 and bucket = $2 and ($3::uuid is null or id <> $3::uuid)`,
      [endpointUrl, bucket, excludeInstanceId ?? null],
    )
  ).rows;
  for (const row of existing) {
    guard(
      row.visibility_scope === visibilityScope,
      "PUBLIC_PRIVATE_BUCKET_CONFLICT",
      `Bucket '${bucket}' at '${endpointUrl}' is already bound to '${row.visibility_scope}' (${row.instance_key}); public assets and private evidence must never share a bucket.`,
      409,
    );
  }
}

export async function createStorageInstance(
  db: DB,
  actor: Actor,
  sessionHash: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  assertNoInlineSecrets(rawBody);
  const input = createStorageInstanceSchema.parse(rawBody);
  guard(input.requires_icp !== true, "ICP_POLICY_FORBIDDEN", "QC Warehouse does not support storage providers requiring China mainland ICP filing.", 400);

  const scope = resolveScopeForRole(input.storage_role, input.visibility_scope);
  if (scope !== "public_assets") {
    guard(!input.public_cdn_base_url, "PRIVATE_BUCKET_NO_PUBLIC_CDN", "Private evidence storage must not configure a public CDN domain.", 422);
  } else if (input.public_cdn_base_url) {
    assertSafeStorageEndpoint(input.public_cdn_base_url, endpointSafetyOptions(input.public_cdn_base_url));
  }

  const safety = endpointSafetyOptions(input.endpoint_url);
  assertSafeStorageEndpoint(input.endpoint_url, safety);
  await assertSafeStorageEndpointDns(input.endpoint_url, safety);

  const corsOrigins = normalizeAndValidateCorsOrigins(input.allowed_cors_origins);
  const preset = STORAGE_PROVIDER_PRESETS[input.provider_type];
  const endpointClean = input.endpoint_url.replace(/\/+$/, "");

  const keyClash = await db.query("select 1 from storage_instances where instance_key = $1", [input.instance_key]);
  guard((keyClash.rowCount ?? 0) === 0, "STORAGE_INSTANCE_KEY_EXISTS", `Storage instance key '${input.instance_key}' already exists.`, 409);

  await assertNoPublicPrivateBucketConflict(db, endpointClean, input.bucket, scope);
  const sameTuple = await db.query(
    "select 1 from storage_instances where endpoint_url = $1 and bucket = $2 and environment = $3",
    [endpointClean, input.bucket, input.environment],
  );
  guard((sameTuple.rowCount ?? 0) === 0, "STORAGE_INSTANCE_DUPLICATE", `A '${input.environment}' instance already exists for bucket '${input.bucket}'.`, 409);

  const id = uuid();
  const row = await one<StorageInstanceRow>(
    db,
    `insert into storage_instances (
       id, instance_key, display_name, provider_type, storage_role, visibility_scope,
       environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
       bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
       encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
       presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes,
       multipart_threshold_bytes, multipart_part_size_bytes, max_concurrent_uploads,
       allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
       requires_icp, created_by, updated_by
     ) values (
       $1,$2,$3,$4,$5,$6,
       $7,'draft',false,true,$8,$9,
       $10,$11,$12,$13,$14,
       $15,$16,$17,$18,
       $19,$20,$21,
       $22,$23,$24,
       $25::jsonb,$26::jsonb,$27::jsonb,'unconfigured',
       false,$28,$28
     )
     returning id, instance_key, display_name, provider_type, storage_role, visibility_scope,
               environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
               bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
               encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
               presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
               multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
               allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
               last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
               last_error_message, requires_icp, created_at, updated_at`,
    [
      id,
      input.instance_key,
      input.display_name,
      input.provider_type,
      input.storage_role,
      scope,
      input.environment,
      endpointClean,
      input.region || preset.default_region,
      input.bucket,
      input.account_identifier ?? null,
      normalizeKeyPrefix(input.key_prefix),
      input.addressing_style ?? preset.default_addressing_style,
      scope === "public_assets" ? (input.public_cdn_base_url ?? null) : null,
      input.encryption_policy ?? preset.default_encryption_policy,
      input.connect_timeout_ms ?? preset.defaults.connect_timeout_ms,
      input.upload_timeout_ms ?? preset.defaults.upload_timeout_ms,
      input.max_retries ?? preset.defaults.max_retries,
      input.presign_put_ttl_sec ?? preset.defaults.presign_put_ttl_sec,
      input.presign_get_ttl_sec ?? preset.defaults.presign_get_ttl_sec,
      input.max_file_size_bytes ?? preset.defaults.max_file_size_bytes,
      input.multipart_threshold_bytes ?? preset.defaults.multipart_threshold_bytes,
      input.multipart_part_size_bytes ?? preset.defaults.multipart_part_size_bytes,
      input.max_concurrent_uploads ?? preset.defaults.max_concurrent_uploads,
      JSON.stringify(input.allowed_mimes ?? ["image/jpeg", "image/png", "image/webp", "image/heic", "video/mp4", "video/quicktime", "application/pdf"]),
      JSON.stringify(input.routing_purposes ?? []),
      JSON.stringify(corsOrigins),
      actor.id,
    ],
  );

  await audit(db, actor, "storage_instance_created", "storage_instances", id, {
    instance_key: row.instance_key,
    provider_type: row.provider_type,
    storage_role: row.storage_role,
    visibility_scope: row.visibility_scope,
    environment: row.environment,
    bucket: row.bucket,
  });

  return { instance: { ...row, secrets: [] } };
}

export async function updateStorageInstance(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  assertNoInlineSecrets(rawBody);
  const input = updateStorageInstanceSchema.parse(rawBody);
  guard(input.requires_icp !== true, "ICP_POLICY_FORBIDDEN", "QC Warehouse does not support storage providers requiring China mainland ICP filing.", 400);

  const current = await one<StorageInstanceRow>(
    db,
    `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
            environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
            bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
            encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
            presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
            multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
            allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
            last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
            last_error_message, requires_icp, created_at, updated_at
     from storage_instances where id = $1 for update`,
    [instanceId],
  );

  const hasObjects =
    (
      await db.query(
        "select 1 from storage_objects where storage_instance_id = $1 or storage_provider_key = $2 limit 1",
        [current.id, current.instance_key],
      )
    ).rowCount ?? 0;

  const nextRole = input.storage_role ?? current.storage_role;
  const nextScope = resolveScopeForRole(nextRole, input.visibility_scope ?? (input.storage_role ? undefined : current.visibility_scope));
  const nextEnv = input.environment ?? current.environment;
  const nextEndpoint = (input.endpoint_url ?? current.endpoint_url).replace(/\/+$/, "");
  const nextRegion = input.region ?? current.region;
  const nextBucket = input.bucket ?? current.bucket;
  const nextPrefix = input.key_prefix !== undefined ? normalizeKeyPrefix(input.key_prefix) : current.key_prefix;
  const nextAddressing = input.addressing_style ?? current.addressing_style;
  const nextCdnUrl = input.public_cdn_base_url !== undefined ? input.public_cdn_base_url : current.public_cdn_base_url;

  if (nextScope !== "public_assets") {
    guard(!nextCdnUrl, "PRIVATE_BUCKET_NO_PUBLIC_CDN", "Private evidence storage must not configure a public CDN domain.", 422);
  } else if (nextCdnUrl) {
    assertSafeStorageEndpoint(nextCdnUrl, endpointSafetyOptions(nextCdnUrl));
  }

  if (hasObjects > 0) {
    const locationChanged =
      nextEndpoint !== current.endpoint_url ||
      nextBucket !== current.bucket ||
      nextRegion !== current.region ||
      nextPrefix !== current.key_prefix ||
      nextRole !== current.storage_role ||
      nextScope !== current.visibility_scope ||
      nextEnv !== current.environment;
    guard(
      !locationChanged,
      "STORAGE_INSTANCE_HAS_OBJECTS",
      "Cannot alter bucket, endpoint, prefix, role, or environment of a storage instance with existing objects.",
      409,
    );
  }

  const safety = endpointSafetyOptions(nextEndpoint);
  assertSafeStorageEndpoint(nextEndpoint, safety);
  await assertSafeStorageEndpointDns(nextEndpoint, safety);

  await assertNoPublicPrivateBucketConflict(db, nextEndpoint, nextBucket, nextScope, current.id);
  const dupTuple = await db.query(
    "select 1 from storage_instances where endpoint_url = $1 and bucket = $2 and environment = $3 and id <> $4",
    [nextEndpoint, nextBucket, nextEnv, current.id],
  );
  guard((dupTuple.rowCount ?? 0) === 0, "STORAGE_INSTANCE_DUPLICATE", `A '${nextEnv}' instance already exists for bucket '${nextBucket}'.`, 409);

  const nextCors = input.allowed_cors_origins !== undefined
    ? normalizeAndValidateCorsOrigins(input.allowed_cors_origins)
    : current.allowed_cors_origins;

  const verificationInvalidated =
    nextEndpoint !== current.endpoint_url ||
    nextRegion !== current.region ||
    nextBucket !== current.bucket ||
    nextAddressing !== current.addressing_style ||
    JSON.stringify(nextCors) !== JSON.stringify(current.allowed_cors_origins) ||
    (input.encryption_policy !== undefined && input.encryption_policy !== current.encryption_policy);

  const secretNames = await getActiveInstanceSecretNames(db, current.id);
  const hasCreds = secretNames.has("access_key_id") && secretNames.has("secret_access_key");
  const nextHealth = !hasCreds ? "unconfigured" : verificationInvalidated ? "unknown" : current.health_status;
  const nextLifecycle =
    verificationInvalidated && (current.lifecycle_state === "verified" || current.lifecycle_state === "active")
      ? "draft"
      : current.lifecycle_state;
  const nextAllowWrites = verificationInvalidated ? false : current.allow_new_writes;

  const updated = await one<StorageInstanceRow>(
    db,
    `update storage_instances
     set display_name = $2,
         provider_type = $3,
         storage_role = $4,
         visibility_scope = $5,
         environment = $6,
         lifecycle_state = $7,
         allow_new_writes = $8,
         endpoint_url = $9,
         region = $10,
         bucket = $11,
         account_identifier = $12,
         key_prefix = $13,
         addressing_style = $14,
         public_cdn_base_url = $15,
         encryption_policy = $16,
         connect_timeout_ms = $17,
         upload_timeout_ms = $18,
         max_retries = $19,
         presign_put_ttl_sec = $20,
         presign_get_ttl_sec = $21,
         max_file_size_bytes = $22,
         multipart_threshold_bytes = $23,
         multipart_part_size_bytes = $24,
         max_concurrent_uploads = $25,
         allowed_mimes = $26::jsonb,
         routing_purposes = $27::jsonb,
         allowed_cors_origins = $28::jsonb,
         health_status = $29,
         last_probe_at = case when $30 then null else last_probe_at end,
         updated_by = $31,
         updated_at = now()
     where id = $1
     returning id, instance_key, display_name, provider_type, storage_role, visibility_scope,
               environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
               bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
               encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
               presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
               multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
               allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
               last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
               last_error_message, requires_icp, created_at, updated_at`,
    [
      current.id,
      input.display_name ?? current.display_name,
      input.provider_type ?? current.provider_type,
      nextRole,
      nextScope,
      nextEnv,
      nextLifecycle,
      nextAllowWrites,
      nextEndpoint,
      nextRegion,
      nextBucket,
      input.account_identifier !== undefined ? input.account_identifier : current.account_identifier,
      nextPrefix,
      nextAddressing,
      nextScope === "public_assets" ? nextCdnUrl : null,
      input.encryption_policy ?? current.encryption_policy,
      input.connect_timeout_ms ?? current.connect_timeout_ms,
      input.upload_timeout_ms ?? current.upload_timeout_ms,
      input.max_retries ?? current.max_retries,
      input.presign_put_ttl_sec ?? current.presign_put_ttl_sec,
      input.presign_get_ttl_sec ?? current.presign_get_ttl_sec,
      input.max_file_size_bytes ?? Number(current.max_file_size_bytes),
      input.multipart_threshold_bytes ?? Number(current.multipart_threshold_bytes),
      input.multipart_part_size_bytes ?? Number(current.multipart_part_size_bytes),
      input.max_concurrent_uploads ?? current.max_concurrent_uploads,
      JSON.stringify(input.allowed_mimes ?? current.allowed_mimes),
      JSON.stringify(input.routing_purposes ?? current.routing_purposes),
      JSON.stringify(nextCors),
      nextHealth,
      verificationInvalidated,
      actor.id,
    ],
  );

  await audit(db, actor, "storage_instance_updated", "storage_instances", current.id, {
    instance_key: current.instance_key,
    verification_invalidated: verificationInvalidated,
  });

  return { instance: { ...updated, secrets: await listInstanceSecretsMeta(db, [updated.id]) } };
}

export async function deleteStorageInstance(db: DB, actor: Actor, sessionHash: string, instanceId: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const inst = await one<{ id: string; instance_key: string; lifecycle_state: string; allow_new_writes: boolean }>(
    db,
    "select id, instance_key, lifecycle_state, allow_new_writes from storage_instances where id = $1 for update",
    [instanceId],
  );
  guard(
    inst.lifecycle_state !== "active" && !inst.allow_new_writes,
    "STORAGE_INSTANCE_ACTIVE",
    "Active or write-enabled storage instance must be stopped before deletion.",
    409,
  );
  const objExists = await db.query(
    "select 1 from storage_objects where storage_instance_id = $1 or storage_provider_key = $2 limit 1",
    [inst.id, inst.instance_key],
  );
  guard(
    (objExists.rowCount ?? 0) === 0,
    "STORAGE_INSTANCE_HAS_OBJECTS",
    "Storage instance has existing object records and cannot be deleted.",
    409,
  );
  const migExists = await db.query("select 1 from storage_migration_jobs where target_instance_id = $1 limit 1", [inst.id]);
  guard(
    (migExists.rowCount ?? 0) === 0,
    "STORAGE_INSTANCE_HAS_MIGRATION_JOBS",
    "Storage instance is referenced by historical migration jobs and cannot be deleted.",
    409,
  );

  await db.query("delete from storage_instances where id = $1", [inst.id]);
  await audit(db, actor, "storage_instance_deleted", "storage_instances", inst.id, { instance_key: inst.instance_key });
  return { deleted: true, instance_key: inst.instance_key };
}

export async function saveStorageInstanceSecret(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  input: z.infer<typeof saveStorageSecretSchema>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const inst = await one<{ id: string; instance_key: string; lifecycle_state: string }>(
    db,
    "select id, instance_key, lifecycle_state from storage_instances where id = $1 for update",
    [instanceId],
  );

  const trimmed = input.secret_value.trim();
  const masked = maskSecret(trimmed);
  const ciphertext = seal(trimmed);

  const existing = (
    await db.query<{ id: string; key_version: number }>(
      `select id, key_version from storage_instance_secrets
       where instance_id = $1 and secret_name = $2 and status = 'active'
       for update`,
      [inst.id, input.secret_name],
    )
  ).rows[0];

  const maxVer =
    (
      await db.query<{ mv: number }>(
        "select coalesce(max(key_version), 0)::int as mv from storage_instance_secrets where instance_id = $1 and secret_name = $2",
        [inst.id, input.secret_name],
      )
    ).rows[0]?.mv ?? 0;

  if (existing) {
    await db.query(
      "update storage_instance_secrets set status = 'rotated', rotated_by = $2, rotated_at = now() where id = $1",
      [existing.id, actor.id],
    );
  }
  const nextVersion = maxVer + 1;
  const secretId = uuid();
  await db.query(
    `insert into storage_instance_secrets (
       id, instance_id, secret_name, ciphertext, masked_hint, key_version, status, created_by
     ) values ($1, $2, $3, $4, $5, $6, 'active', $7)`,
    [secretId, inst.id, input.secret_name, ciphertext, masked, nextVersion, actor.id],
  );

  const activeNames = await getActiveInstanceSecretNames(db, inst.id);
  const readyForProbe = activeNames.has("access_key_id") && activeNames.has("secret_access_key");
  await db.query(
    `update storage_instances
     set health_status = $2,
         lifecycle_state = case when lifecycle_state = 'verified' then 'draft' else lifecycle_state end,
         last_probe_at = case when lifecycle_state = 'active' then last_probe_at else null end,
         updated_by = $3,
         updated_at = now()
     where id = $1`,
    [inst.id, readyForProbe ? "unknown" : "unconfigured", actor.id],
  );

  await audit(db, actor, existing ? "storage_secret_rotated" : "storage_secret_saved", "storage_instances", inst.id, {
    instance_key: inst.instance_key,
    secret_name: input.secret_name,
    key_version: nextVersion,
    masked_hint: masked,
  });

  return {
    id: secretId,
    instance_id: inst.id,
    secret_name: input.secret_name,
    masked_hint: masked,
    key_version: nextVersion,
    rotated: Boolean(existing),
  };
}

export async function rollbackStorageInstanceSecret(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  input: z.infer<typeof rollbackStorageSecretSchema>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const inst = await one<{ id: string; instance_key: string }>(
    db,
    "select id, instance_key from storage_instances where id = $1 for update",
    [instanceId],
  );

  const currentActive = (
    await db.query<{ id: string; key_version: number }>(
      "select id, key_version from storage_instance_secrets where instance_id = $1 and secret_name = $2 and status = 'active' for update",
      [inst.id, input.secret_name],
    )
  ).rows[0];

  const prior = (
    await db.query<{ id: string; key_version: number; masked_hint: string }>(
      `select id, key_version, masked_hint from storage_instance_secrets
       where instance_id = $1 and secret_name = $2 and status = 'rotated'
         and ($3::int is null or key_version = $3)
       order by key_version desc limit 1 for update`,
      [inst.id, input.secret_name, input.target_version ?? null],
    )
  ).rows[0];
  guard(prior, "SECRET_ROLLBACK_UNAVAILABLE", `No rotated version available to roll back '${input.secret_name}'.`, 404);

  if (currentActive) {
    await db.query(
      "update storage_instance_secrets set status = 'rotated', rotated_by = $2, rotated_at = now() where id = $1",
      [currentActive.id, actor.id],
    );
  }
  await db.query(
    "update storage_instance_secrets set status = 'active', rotated_by = null, rotated_at = null where id = $1",
    [prior.id],
  );

  await audit(db, actor, "storage_secret_rolled_back", "storage_instances", inst.id, {
    instance_key: inst.instance_key,
    secret_name: input.secret_name,
    restored_version: prior.key_version,
    masked_hint: prior.masked_hint,
  });

  return {
    rolled_back: true,
    instance_id: inst.id,
    secret_name: input.secret_name,
    restored_version: prior.key_version,
    masked_hint: prior.masked_hint,
  };
}

export async function revokeStorageInstanceSecret(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  input: z.infer<typeof revokeStorageSecretSchema>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const inst = await one<{ id: string; instance_key: string; lifecycle_state: string }>(
    db,
    "select id, instance_key, lifecycle_state from storage_instances where id = $1 for update",
    [instanceId],
  );
  const active = (
    await db.query<{ id: string; key_version: number; masked_hint: string }>(
      "select id, key_version, masked_hint from storage_instance_secrets where instance_id = $1 and secret_name = $2 and status = 'active' for update",
      [inst.id, input.secret_name],
    )
  ).rows[0];
  guard(active, "SECRET_NOT_FOUND", `No active '${input.secret_name}' configured for instance.`, 404);

  await db.query(
    "update storage_instance_secrets set status = 'revoked', revoked_by = $2, revoked_at = now() where id = $1",
    [active.id, actor.id],
  );

  if (input.secret_name !== "session_token") {
    await db.query(
      `update storage_instances
       set health_status = 'unconfigured',
           allow_new_writes = false,
           lifecycle_state = case when lifecycle_state in ('verified', 'active') then 'disabled' else lifecycle_state end,
           last_error_class = 'config_incomplete',
           last_error_message = $2,
           updated_by = $3,
           updated_at = now()
       where id = $1`,
      [inst.id, `Active credential '${input.secret_name}' was revoked.`, actor.id],
    );
  }

  await audit(db, actor, "storage_secret_revoked", "storage_instances", inst.id, {
    instance_key: inst.instance_key,
    secret_name: input.secret_name,
    key_version: active.key_version,
  });

  return { revoked: true, instance_id: inst.id, secret_name: input.secret_name };
}

function classifyProbeError(err: unknown): { errorClass: string; message: string } {
  if (err instanceof Problem) {
    if (err.code === "STORAGE_ENDPOINT_UNSAFE") return { errorClass: "ssrf_blocked", message: err.message };
    if (err.code.includes("CORS")) return { errorClass: "cors_misconfigured", message: err.message };
    if (err.code.includes("SHA256") || err.code.includes("MISMATCH")) return { errorClass: "checksum_mismatch", message: err.message };
    if (/\((401|403)\)/.test(err.message)) return { errorClass: "auth_or_permission", message: err.message };
    if (/\((429|507)\)/.test(err.message)) return { errorClass: "quota_exceeded", message: err.message };
    if (err.code.includes("PROBE") || err.code.includes("STORAGE_")) return { errorClass: "provider_incompatible", message: err.message };
    return { errorClass: "provider_incompatible", message: err.message };
  }
  const msg = err instanceof Error ? err.message : "Storage connection probe failed.";
  if (/401|403|AccessDenied|SignatureDoesNotMatch/i.test(msg)) return { errorClass: "auth_or_permission", message: msg };
  if (/429|507|Quota|InsufficientStorage/i.test(msg)) return { errorClass: "quota_exceeded", message: msg };
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|TimeoutError|fetch failed|network/i.test(msg)) return { errorClass: "network_error", message: msg };
  return { errorClass: "provider_incompatible", message: msg };
}

async function runCorsPreflightCheck(
  provider: ObjectStorageProvider,
  probeKey: string,
  expectedOrigin: string,
  visibilityScope: StorageVisibilityScope,
  timeoutMs: number,
): Promise<{ status: "passed" | "failed"; origin: string; detail: string }> {
  const putTarget = provider.presignPutObject(probeKey, "application/octet-stream", 120);
  const res = await fetch(putTarget.url, {
    method: "OPTIONS",
    headers: {
      origin: expectedOrigin,
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type",
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  guard(res.ok, "PROBE_CORS_FAILED", `CORS preflight returned HTTP ${res.status}.`, 502);
  const allowOrigin = res.headers.get("access-control-allow-origin") ?? "";
  const allowMethods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
  const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();

  if (visibilityScope === "private_evidence") {
    guard(
      allowOrigin !== "*",
      "PROBE_CORS_WILDCARD_REJECTED",
      "Private evidence bucket returned wildcard Access-Control-Allow-Origin '*'.",
      502,
    );
  }
  guard(
    allowOrigin === expectedOrigin,
    "PROBE_CORS_ORIGIN_MISMATCH",
    `CORS Access-Control-Allow-Origin '${allowOrigin || "(missing)"}' did not match expected site origin '${expectedOrigin}'.`,
    502,
  );
  guard(
    allowMethods.split(",").map((s) => s.trim()).includes("PUT"),
    "PROBE_CORS_METHOD_MISSING",
    `CORS Access-Control-Allow-Methods '${allowMethods}' must include PUT.`,
    502,
  );
  guard(
    allowHeaders.split(",").map((s) => s.trim()).some((h) => h === "content-type" || h === "*"),
    "PROBE_CORS_HEADERS_MISSING",
    `CORS Access-Control-Allow-Headers '${allowHeaders}' must permit content-type.`,
    502,
  );
  return {
    status: "passed",
    origin: expectedOrigin,
    detail: `Verified explicit CORS preflight for ${expectedOrigin} (PUT, content-type).`,
  };
}

export async function probeStorageInstance(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const inst = await one<StorageInstanceRow>(
    db,
    `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
            environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
            bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
            encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
            presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
            multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
            allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
            last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
            last_error_message, requires_icp, created_at, updated_at
     from storage_instances where id = $1 for update`,
    [instanceId],
  );

  const startedAt = Date.now();
  const creds = await resolveInstanceCredentials(db, inst.id);
  const redactTargets = creds ? [creds.accessKeyId, creds.secretAccessKey, creds.sessionToken ?? ""] : [];

  if (!creds) {
    const summary = "Active access_key_id and secret_access_key are required before running storage probes.";
    const latency = Date.now() - startedAt;
    await db.query(
      `insert into storage_probe_runs (instance_id, probe_kind, ok, error_class, latency_ms, step_results, summary, actor_id)
       values ($1, 'full_rw', false, 'config_incomplete', $2, '{}'::jsonb, $3, $4)`,
      [inst.id, latency, summary, actor.id],
    );
    await db.query(
      `update storage_instances
       set health_status = 'unconfigured', last_probe_at = now(), last_probe_summary = $2,
           last_error_class = 'config_incomplete', last_error_message = $2, updated_by = $3, updated_at = now()
       where id = $1`,
      [inst.id, summary, actor.id],
    );
    return {
      ok: false,
      not_simulated: true,
      instance_id: inst.id,
      instance_key: inst.instance_key,
      health_status: "unconfigured",
      error_class: "config_incomplete",
      latency_ms: latency,
      summary,
      steps: {},
    };
  }

  let ok = false;
  let errorClass: string | null = null;
  let summary = "";
  let stepResults: Record<string, unknown> = {};

  try {
    const safety = endpointSafetyOptions(inst.endpoint_url);
    await assertSafeStorageEndpointDns(inst.endpoint_url, safety);
    const provider = providerFromRowAndCreds(inst, creds);
    const prefixBase = inst.key_prefix ? `${inst.key_prefix}/probes/probe-${Date.now()}` : `probes/probe-${Date.now()}`;
    const rwProbe = await runStorageCapabilityProbe(provider, prefixBase);
    const expectedOrigin = (inst.allowed_cors_origins as string[])[0] ?? appOrigin();
    const corsStep = await runCorsPreflightCheck(
      provider,
      `${prefixBase}/cors-preflight.bin`,
      expectedOrigin,
      inst.visibility_scope,
      inst.connect_timeout_ms,
    );
    stepResults = { ...rwProbe.probes, cors_preflight: corsStep };
    ok = rwProbe.ok && corsStep.status === "passed";
    summary = `Verified real PutObject/HeadObject/Range206/PresignedGET/Multipart/Abort/Delete + CORS (${expectedOrigin}) in ${Date.now() - startedAt}ms.`;
  } catch (err) {
    const classified = classifyProbeError(err);
    errorClass = classified.errorClass;
    summary = redactErrorText(classified.message, redactTargets);
  }

  const latency = Date.now() - startedAt;
  const nextHealth = ok ? "verified" : "error";
  const nextLifecycle = ok && inst.lifecycle_state === "draft" ? "verified" : inst.lifecycle_state;

  await db.query(
    `insert into storage_probe_runs (instance_id, probe_kind, ok, error_class, latency_ms, step_results, summary, actor_id)
     values ($1, 'full_rw', $2, $3, $4, $5::jsonb, $6, $7)`,
    [inst.id, ok, errorClass, latency, JSON.stringify(stepResults), summary, actor.id],
  );
  await db.query(
    `update storage_instances
     set health_status = $2,
         lifecycle_state = $3,
         last_probe_at = now(),
         last_probe_summary = $4,
         last_probe_detail = $5::jsonb,
         last_error_class = $6,
         last_error_message = $7,
         updated_by = $8,
         updated_at = now()
     where id = $1`,
    [inst.id, nextHealth, nextLifecycle, summary, JSON.stringify(stepResults), errorClass, ok ? null : summary, actor.id],
  );

  await audit(db, actor, "storage_instance_probed", "storage_instances", inst.id, {
    instance_key: inst.instance_key,
    ok,
    health_status: nextHealth,
    error_class: errorClass,
    latency_ms: latency,
  });

  return {
    ok,
    not_simulated: true,
    instance_id: inst.id,
    instance_key: inst.instance_key,
    health_status: nextHealth,
    lifecycle_state: nextLifecycle,
    error_class: errorClass,
    latency_ms: latency,
    summary,
    steps: stepResults,
  };
}

async function assertVerifiedForActivation(db: DB, inst: StorageInstanceRow) {
  const creds = await resolveInstanceCredentials(db, inst.id);
  guard(
    Boolean(creds && inst.health_status === "verified" && inst.last_probe_at),
    "STORAGE_INSTANCE_NOT_VERIFIED",
    `Storage instance '${inst.instance_key}' must have active encrypted credentials and a passing live RW+CORS probe before activation.`,
    409,
  );
}

export async function transitionStorageInstanceState(
  db: DB,
  actor: Actor,
  sessionHash: string,
  instanceId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = transitionStorageStateSchema.parse(rawBody);

  const inst = await one<StorageInstanceRow>(
    db,
    `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
            environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
            bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
            encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
            presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
            multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
            allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
            last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
            last_error_message, requires_icp, created_at, updated_at
     from storage_instances where id = $1 for update`,
    [instanceId],
  );

  const targetWrites =
    input.lifecycle_state === "active"
      ? (input.allow_new_writes ?? true)
      : input.lifecycle_state === "read_only_legacy" || input.lifecycle_state === "disabled"
        ? false
        : (input.allow_new_writes ?? false);
  const targetReads = input.allow_reads ?? (input.lifecycle_state !== "disabled");

  if (input.lifecycle_state === "active" || targetWrites) {
    await assertVerifiedForActivation(db, inst);
    if ((inst.storage_role === "primary" || inst.storage_role === "public_assets") && targetWrites) {
      const clash = await db.query<{ instance_key: string }>(
        `select instance_key from storage_instances
         where environment = $1 and storage_role = $2 and lifecycle_state = 'active' and allow_new_writes = true and id <> $3`,
        [inst.environment, inst.storage_role, inst.id],
      );
      guard(
        (clash.rowCount ?? 0) === 0,
        "PRIMARY_ALREADY_ACTIVE",
        `Another ${inst.storage_role} instance (${clash.rows[0]?.instance_key}) is active in '${inst.environment}'. Use atomic primary switch instead.`,
        409,
      );
    }
  }

  const updated = await one<StorageInstanceRow>(
    db,
    `update storage_instances
     set lifecycle_state = $2,
         allow_new_writes = $3,
         allow_reads = $4,
         updated_by = $5,
         updated_at = now()
     where id = $1
     returning id, instance_key, display_name, provider_type, storage_role, visibility_scope,
               environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
               bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
               encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
               presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
               multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
               allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
               last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
               last_error_message, requires_icp, created_at, updated_at`,
    [inst.id, input.lifecycle_state, targetWrites, targetReads, actor.id],
  );

  await audit(db, actor, "storage_instance_state_changed", "storage_instances", inst.id, {
    instance_key: inst.instance_key,
    from: { lifecycle_state: inst.lifecycle_state, allow_new_writes: inst.allow_new_writes, allow_reads: inst.allow_reads },
    to: { lifecycle_state: updated.lifecycle_state, allow_new_writes: updated.allow_new_writes, allow_reads: updated.allow_reads },
    reason: input.reason ?? null,
  });

  return { instance: { ...updated, secrets: await listInstanceSecretsMeta(db, [updated.id]) } };
}

export async function switchPrimaryStorageInstance(
  db: DB,
  actor: Actor,
  sessionHash: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = switchPrimaryStorageSchema.parse(rawBody);

  const target = await one<StorageInstanceRow>(
    db,
    `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
            environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
            bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
            encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
            presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
            multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
            allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
            last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
            last_error_message, requires_icp, created_at, updated_at
     from storage_instances where id = $1 for update`,
    [input.target_instance_id],
  );
  guard(
    target.storage_role === "primary" || target.storage_role === "public_assets",
    "INVALID_SWITCH_ROLE",
    "Only 'primary' or 'public_assets' storage instances can become the active primary target.",
    422,
  );
  await assertVerifiedForActivation(db, target);

  const prevRows = (
    await db.query<{ id: string; instance_key: string }>(
      `select id, instance_key from storage_instances
       where environment = $1 and storage_role = $2 and lifecycle_state = 'active' and id <> $3
       for update`,
      [target.environment, target.storage_role, target.id],
    )
  ).rows;

  for (const prev of prevRows) {
    await db.query(
      `update storage_instances
       set lifecycle_state = 'read_only_legacy',
           allow_new_writes = false,
           allow_reads = true,
           updated_by = $2,
           updated_at = now()
       where id = $1`,
      [prev.id, actor.id],
    );
  }

  const promoted = await one<StorageInstanceRow>(
    db,
    `update storage_instances
     set lifecycle_state = 'active',
         allow_new_writes = true,
         allow_reads = true,
         updated_by = $2,
         updated_at = now()
     where id = $1
     returning id, instance_key, display_name, provider_type, storage_role, visibility_scope,
               environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
               bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
               encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
               presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
               multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
               allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
               last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
               last_error_message, requires_icp, created_at, updated_at`,
    [target.id, actor.id],
  );

  await audit(db, actor, "storage_primary_switched", "storage_instances", promoted.id, {
    storage_role: promoted.storage_role,
    environment: promoted.environment,
    previous_instances: prevRows.map((r) => r.instance_key),
    new_instance: promoted.instance_key,
    reason: input.reason,
  });

  return {
    switched: true,
    previous_legacy_instances: prevRows.map((r) => r.instance_key),
    active_instance: { ...promoted, secrets: await listInstanceSecretsMeta(db, [promoted.id]) },
  };
}

export interface ResolvedStorageTarget {
  provider: ObjectStorageProvider;
  instance: StorageInstanceRow;
}

function isLiveStrictMode(): boolean {
  return process.env.NODE_ENV === "production" && process.env.QCW_DEMO !== "1";
}

export async function hasConfiguredStorageInstances(
  db: Pick<DB, "query">,
  visibilityScope: StorageVisibilityScope,
): Promise<boolean> {
  const res = await db.query(
    "select 1 from storage_instances where visibility_scope = $1 limit 1",
    [visibilityScope],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function resolveConfiguredWriteProvider(
  db: Pick<DB, "query">,
  options: {
    visibilityScope: StorageVisibilityScope;
    purpose?: string;
    preferredEnvironment?: StorageEnvironment;
  },
): Promise<ResolvedStorageTarget | null> {
  const strictLive = isLiveStrictMode();
  const envFilter = strictLive ? "live" : options.preferredEnvironment ?? null;

  const rows = (
    await db.query<StorageInstanceRow>(
      `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
              environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
              bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
              encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
              presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
              multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
              allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
              last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
              last_error_message, requires_icp, created_at, updated_at
       from storage_instances
       where visibility_scope = $1
         and ($2::text is null or environment = $2)
       order by
         case when lifecycle_state = 'active' and allow_new_writes then 0 else 1 end,
         case storage_role when 'primary' then 1 when 'public_assets' then 1 when 'secondary_failover' then 2 else 3 end,
         updated_at desc`,
      [options.visibilityScope, envFilter],
    )
  ).rows;

  const writableRoles = new Set<StorageRole>(
    options.visibilityScope === "public_assets"
      ? ["public_assets"]
      : strictLive
        ? ["primary", "secondary_failover"]
        : ["primary", "secondary_failover", "test_sandbox"],
  );
  const activeCandidates = rows.filter(
    (r) =>
      r.lifecycle_state === "active" &&
      r.allow_new_writes &&
      (writableRoles.has(r.storage_role) ||
        (r.storage_role !== "archive" &&
          r.storage_role !== "independent_backup" &&
          Boolean(options.purpose && Array.isArray(r.routing_purposes) && r.routing_purposes.includes(options.purpose)))),
  );
  const purposeMatched = options.purpose
    ? activeCandidates.filter((r) => Array.isArray(r.routing_purposes) && r.routing_purposes.includes(options.purpose!))
    : [];
  const ordered = [...purposeMatched, ...activeCandidates.filter((r) => !purposeMatched.includes(r))];

  if (ordered.length === 0) {
    if (strictLive) {
      assertProductionStorageAllowed(false);
    }
    const anyForScope = await hasConfiguredStorageInstances(db, options.visibilityScope);
    if (anyForScope) {
      guard(
        false,
        "OBJECT_STORAGE_UNAVAILABLE",
        `No active writable '${options.visibilityScope}' object storage instance is enabled.`,
        503,
      );
    }
    return null;
  }

  for (const candidate of ordered) {
    if (candidate.health_status === "error" || candidate.health_status === "unconfigured") {
      continue;
    }
    const creds = await resolveInstanceCredentials(db, candidate.id);
    if (!creds) continue;
    return { provider: providerFromRowAndCreds(candidate, creds), instance: candidate };
  }

  guard(
    false,
    "OBJECT_STORAGE_UNAVAILABLE",
    "Configured active storage instances have missing/revoked credentials or failed health checks; fallback to local storage is prohibited.",
    503,
  );
  throw new Error("unreachable");
}

export async function resolveConfiguredReadProvider(
  db: Pick<DB, "query">,
  obj: {
    storage_instance_id?: string | null;
    storage_provider_key: string;
  },
): Promise<ResolvedStorageTarget | null> {
  const row = obj.storage_instance_id
    ? (
        await db.query<StorageInstanceRow>(
          `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
                  environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
                  bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
                  encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
                  presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
                  multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
                  allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
                  last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
                  last_error_message, requires_icp, created_at, updated_at
           from storage_instances where id = $1`,
          [obj.storage_instance_id],
        )
      ).rows[0]
    : (
        await db.query<StorageInstanceRow>(
          `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
                  environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
                  bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
                  encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
                  presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
                  multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
                  allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
                  last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
                  last_error_message, requires_icp, created_at, updated_at
           from storage_instances where instance_key = $1`,
          [obj.storage_provider_key],
        )
      ).rows[0];

  if (!row) return null;
  guard(row.allow_reads, "STORAGE_INSTANCE_READ_DISABLED", `Storage instance '${row.instance_key}' has reads disabled.`, 503);
  const creds = await resolveInstanceCredentials(db, row.id);
  guard(creds, "OBJECT_STORAGE_UNAVAILABLE", `Credentials for storage instance '${row.instance_key}' are unavailable.`, 503);
  return { provider: providerFromRowAndCreds(row, creds), instance: row };
}

export async function assertNoUnsafeLiveFallback(
  db: Pick<DB, "query">,
  options?: { enforceLive?: boolean },
): Promise<void> {
  const enforce = Boolean(options?.enforceLive) || isLiveStrictMode();
  if (!enforce) return;
  const resolved = await resolveConfiguredWriteProvider(db, {
    visibilityScope: "private_evidence",
    preferredEnvironment: "live",
  });
  if (!resolved) {
    assertProductionStorageAllowed(false);
  }
}

export async function getStorageUsageMetrics(db: DB, actor: Actor) {
  role(actor, ...STORAGE_READ_ROLES);
  const byInstance = (
    await db.query<{
      instance_key: string;
      ready_count: number;
      quarantined_count: number;
      archived_count: number;
      ready_bytes: string;
    }>(
      `select storage_provider_key as instance_key,
              count(*) filter (where status = 'ready')::int as ready_count,
              count(*) filter (where status = 'quarantined')::int as quarantined_count,
              count(*) filter (where status = 'archived')::int as archived_count,
              coalesce(sum(size_bytes) filter (where status = 'ready'), 0)::text as ready_bytes
       from storage_objects
       group by storage_provider_key`,
    )
  ).rows;
  const requests24h = await one<{
    presign_puts: number;
    presign_gets: number;
    stream_reads: number;
    range_reads: number;
    quarantines: number;
  }>(
    db,
    `select count(*) filter (where action = 'presign_put')::int as presign_puts,
            count(*) filter (where action = 'presign_get')::int as presign_gets,
            count(*) filter (where action = 'stream_read')::int as stream_reads,
            count(*) filter (where action = 'range_read')::int as range_reads,
            count(*) filter (where action = 'quarantine')::int as quarantines
     from storage_access_audit
     where created_at > now() - interval '24 hours'`,
  );
  const legacyInventory = await one<{
    legacy_files: number;
    legacy_bytes: string;
    media_asset_refs: number;
    report_pdf_refs: number;
  }>(
    db,
    `select (select count(*)::int from private_files where key not like 'staging/%') as legacy_files,
            (select coalesce(sum(octet_length(data)), 0)::text from private_files where key not like 'staging/%') as legacy_bytes,
            (select count(*)::int from media_assets where status = 'ready') as media_asset_refs,
            (select count(*)::int from report_versions where pdf_key is not null) as report_pdf_refs`,
  );
  return { by_instance: byInstance, requests_24h: requests24h, legacy_private_files: legacyInventory };
}

export async function listStorageMigrationJobs(db: DB, actor: Actor) {
  role(actor, ...STORAGE_READ_ROLES);
  const jobs = (
    await db.query(
      `select j.*, s.instance_key as target_instance_key, s.bucket as target_bucket
       from storage_migration_jobs j
       join storage_instances s on s.id = j.target_instance_id
       order by j.created_at desc
       limit 30`,
    )
  ).rows;
  return { jobs };
}

export async function getStorageMigrationJob(db: DB, actor: Actor, jobId: string) {
  role(actor, ...STORAGE_READ_ROLES);
  const job = await one(
    db,
    `select j.*, s.instance_key as target_instance_key, s.bucket as target_bucket
     from storage_migration_jobs j
     join storage_instances s on s.id = j.target_instance_id
     where j.id = $1`,
    [jobId],
  );
  const items = (
    await db.query(
      `select id, source_table, source_key, source_sha256, source_size_bytes::text, source_mime,
              reference_count, target_object_id, target_object_key, target_version_id,
              verified_sha256, status, attempts, last_error, updated_at
       from storage_migration_items
       where job_id = $1
       order by source_key asc
       limit 500`,
      [jobId],
    )
  ).rows;
  return { job, items };
}

export async function createStorageMigrationJob(
  db: DB,
  actor: Actor,
  sessionHash: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = createMigrationJobSchema.parse(rawBody);
  const target = await one<StorageInstanceRow>(
    db,
    `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
            environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
            bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
            encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
            presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
            multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
            allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
            last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
            last_error_message, requires_icp, created_at, updated_at
     from storage_instances where id = $1 for share`,
    [input.target_instance_id],
  );
  guard(
    target.visibility_scope === "private_evidence" && target.lifecycle_state === "active" && target.allow_new_writes,
    "INVALID_MIGRATION_TARGET",
    "Migration target must be an active, writable private_evidence storage instance.",
    409,
  );
  await assertVerifiedForActivation(db, target);

  const legacyRows = (
    await db.query<{
      key: string;
      mime: string;
      data: Buffer;
      ref_count: number;
    }>(
      `select pf.key,
              pf.mime,
              pf.data,
              (
                (select count(*)::int from media_assets ma where ma.object_key = pf.key or ma.thumb_key = pf.key)
                + (select count(*)::int from report_versions rv where rv.pdf_key = pf.key)
              )::int as ref_count
       from private_files pf
       where pf.key not like 'staging/%'
       order by pf.key asc`,
    )
  ).rows.map((r) => ({
    key: r.key,
    mime: r.mime,
    size_bytes: r.data.length,
    sha256_hex: createHash("sha256").update(r.data).digest("hex"),
    ref_count: r.ref_count,
  }));

  const jobId = uuid();
  const jobKey = `mig-${Date.now()}-${jobId.slice(0, 8)}`;
  const totalBytes = legacyRows.reduce((acc, r) => acc + r.size_bytes, 0);
  const totalRefs = legacyRows.reduce((acc, r) => acc + r.ref_count, 0);

  await db.query(
    `insert into storage_migration_jobs (
       id, job_key, target_instance_id, phase, status, batch_size,
       total_objects, total_bytes, source_reference_count, retain_source_copy, created_by
     ) values ($1, $2, $3, 'expand', 'planned', $4, $5, $6, $7, true, $8)`,
    [jobId, jobKey, target.id, input.batch_size, legacyRows.length, totalBytes, totalRefs, actor.id],
  );

  for (const row of legacyRows) {
    await db.query(
      `insert into storage_migration_items (
         id, job_id, source_table, source_key, source_sha256, source_size_bytes, source_mime, reference_count, status
       ) values ($1, $2, 'private_files', $3, $4, $5, $6, $7, 'pending')`,
      [uuid(), jobId, row.key, row.sha256_hex, row.size_bytes, row.mime, row.ref_count],
    );
  }

  await audit(db, actor, "storage_migration_job_created", "storage_migration_jobs", jobId, {
    job_key: jobKey,
    target_instance_key: target.instance_key,
    total_objects: legacyRows.length,
    total_bytes: totalBytes,
    source_reference_count: totalRefs,
  });

  return getStorageMigrationJob(db, actor, jobId);
}

async function refreshMigrationJobCounters(db: DB, jobId: string) {
  const counts = await one<{
    total_objects: number;
    migrated_objects: number;
    verified_objects: number;
    failed_objects: number;
    pending_objects: number;
    verified_refs: number;
  }>(
    db,
    `select count(*)::int as total_objects,
            count(*) filter (where status in ('migrated', 'verified'))::int as migrated_objects,
            count(*) filter (where status = 'verified')::int as verified_objects,
            count(*) filter (where status = 'failed')::int as failed_objects,
            count(*) filter (where status = 'pending')::int as pending_objects,
            coalesce(sum(reference_count) filter (where status = 'verified'), 0)::int as verified_refs
     from storage_migration_items
     where job_id = $1`,
    [jobId],
  );
  return counts;
}

export async function runStorageMigrationBatch(
  db: DB,
  actor: Actor,
  sessionHash: string,
  jobId: string,
  rawBody: Record<string, unknown>,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const input = runMigrationBatchSchema.parse(rawBody);

  const job = await one<{
    id: string;
    job_key: string;
    target_instance_id: string;
    status: string;
    batch_size: number;
  }>(
    db,
    "select id, job_key, target_instance_id, status, batch_size from storage_migration_jobs where id = $1 for update",
    [jobId],
  );
  guard(
    ["planned", "running", "completed_with_errors"].includes(job.status),
    "MIGRATION_JOB_NOT_RUNNABLE",
    `Migration job in status '${job.status}' must be resumed or planned before running.`,
    409,
  );

  const target = await one<StorageInstanceRow>(
    db,
    `select id, instance_key, display_name, provider_type, storage_role, visibility_scope,
            environment, lifecycle_state, allow_new_writes, allow_reads, endpoint_url, region,
            bucket, account_identifier, key_prefix, addressing_style, public_cdn_base_url,
            encryption_policy, connect_timeout_ms, upload_timeout_ms, max_retries,
            presign_put_ttl_sec, presign_get_ttl_sec, max_file_size_bytes::text,
            multipart_threshold_bytes::text, multipart_part_size_bytes::text, max_concurrent_uploads,
            allowed_mimes, routing_purposes, allowed_cors_origins, health_status,
            last_probe_at, last_probe_summary, last_probe_detail, last_error_class,
            last_error_message, requires_icp, created_at, updated_at
     from storage_instances where id = $1 for share`,
    [job.target_instance_id],
  );
  const creds = await resolveInstanceCredentials(db, target.id);
  guard(creds && target.allow_new_writes, "INVALID_MIGRATION_TARGET", "Target storage instance must be writable with active credentials.", 409);
  const provider = providerFromRowAndCreds(target, creds);

  const limit = input.max_items ?? job.batch_size;
  const pendingItems = (
    await db.query<{
      id: string;
      source_key: string;
      source_sha256: string;
      source_size_bytes: string;
      source_mime: string;
    }>(
      `select id, source_key, source_sha256, source_size_bytes::text, source_mime
       from storage_migration_items
       where job_id = $1 and status = 'pending'
       order by source_key asc
       limit $2
       for update`,
      [job.id, limit],
    )
  ).rows;

  let lastCursor: string | null = null;
  for (const item of pendingItems) {
    lastCursor = item.source_key;
    await db.query("savepoint mig_item");
    try {
      const pf = await one<{ data: Buffer; mime: string }>(
        db,
        "select data, mime from private_files where key = $1",
        [item.source_key],
      );
      const actualSha = createHash("sha256").update(pf.data).digest("hex");
      guard(actualSha === item.source_sha256, "MIGRATION_SOURCE_DRIFT", "Source private_files digest drifted from snapshot.", 409);

      const prefix = target.key_prefix ? `${target.key_prefix}/` : "";
      const targetKey = `${prefix}migrated/legacy/${job.job_key}/${item.source_key.replace(/^\/+/, "")}`;
      const putRes = await provider.putObject(targetKey, pf.data, pf.mime);
      const head = await provider.headObject(targetKey);
      guard(head.exists && head.sizeBytes === pf.data.length, "MIGRATION_VERIFY_SIZE_MISMATCH", "Migrated object HEAD size mismatch.", 502);
      const streamRes = await provider.getObjectStream(targetKey);
      const downloaded = Buffer.from(await new Response(streamRes.body).arrayBuffer());
      const remoteSha = createHash("sha256").update(downloaded).digest("hex");
      guard(remoteSha === actualSha, "MIGRATION_VERIFY_SHA_MISMATCH", "Migrated object SHA-256 verification failed.", 502);

      const objId = uuid();
      await db.query(
        `insert into storage_objects (
           id, storage_instance_id, storage_provider_key, bucket, object_key, object_version_id,
           purpose, visibility, original_filename, declared_mime, detected_mime, size_bytes,
           expected_sha256, verified_sha256, status, is_immutable, variant_kind, created_by, verified_at
         ) values (
           $1, $2, $3, $4, $5, $6,
           'legacy_migration', 'private', $7, $8, $8, $9,
           $10, $10, 'ready', true, 'original', $11, now()
         )`,
        [
          objId,
          target.id,
          target.instance_key,
          target.bucket,
          targetKey,
          putRes.versionId ?? head.versionId,
          item.source_key,
          pf.mime,
          pf.data.length,
          actualSha,
          actor.id,
        ],
      );

      await db.query(
        `update storage_migration_items
         set status = 'verified',
             target_object_id = $2,
             target_object_key = $3,
             target_version_id = $4,
             verified_sha256 = $5,
             attempts = attempts + 1,
             last_error = null,
             updated_at = now()
         where id = $1`,
        [item.id, objId, targetKey, putRes.versionId ?? head.versionId, remoteSha],
      );
      await db.query("release savepoint mig_item");
    } catch (err) {
      await db.query("rollback to savepoint mig_item");
      await db.query("release savepoint mig_item");
      const msg = redactErrorText(err instanceof Error ? err.message : "Migration item failed.", [
        creds.accessKeyId,
        creds.secretAccessKey,
        creds.sessionToken ?? "",
      ]);
      await db.query(
        `update storage_migration_items
         set status = 'failed',
             attempts = attempts + 1,
             last_error = $2,
             updated_at = now()
         where id = $1`,
        [item.id, msg],
      );
    }
  }

  const c = await refreshMigrationJobCounters(db, job.id);
  const nextStatus =
    c.pending_objects > 0
      ? "running"
      : c.failed_objects > 0
        ? "completed_with_errors"
        : "completed";
  const nextPhase = nextStatus === "completed" ? "verify" : "migrate";

  await db.query(
    `update storage_migration_jobs
     set status = $2,
         phase = $3,
         migrated_objects = $4,
         verified_objects = $5,
         failed_objects = $6,
         verified_reference_count = $7,
         last_cursor = coalesce($8, last_cursor),
         started_at = coalesce(started_at, now()),
         completed_at = case when $2 in ('completed', 'completed_with_errors') then now() else null end,
         updated_at = now()
     where id = $1`,
    [job.id, nextStatus, nextPhase, c.migrated_objects, c.verified_objects, c.failed_objects, c.verified_refs, lastCursor],
  );

  await audit(db, actor, "storage_migration_batch_executed", "storage_migration_jobs", job.id, {
    processed: pendingItems.length,
    status: nextStatus,
    verified: c.verified_objects,
    failed: c.failed_objects,
  });

  return getStorageMigrationJob(db, actor, job.id);
}

export async function pauseStorageMigrationJob(db: DB, actor: Actor, sessionHash: string, jobId: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const job = await one<{ id: string; status: string }>(
    db,
    "select id, status from storage_migration_jobs where id = $1 for update",
    [jobId],
  );
  guard(
    job.status === "planned" || job.status === "running",
    "INVALID_MIGRATION_STATE",
    `Cannot pause job from status '${job.status}'.`,
    409,
  );
  await db.query("update storage_migration_jobs set status = 'paused', updated_at = now() where id = $1", [job.id]);
  return getStorageMigrationJob(db, actor, job.id);
}

export async function resumeStorageMigrationJob(db: DB, actor: Actor, sessionHash: string, jobId: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const job = await one<{ id: string; status: string }>(
    db,
    "select id, status from storage_migration_jobs where id = $1 for update",
    [jobId],
  );
  guard(job.status === "paused", "INVALID_MIGRATION_STATE", "Only paused migration jobs can be resumed.", 409);
  await db.query("update storage_migration_jobs set status = 'running', updated_at = now() where id = $1", [job.id]);
  return getStorageMigrationJob(db, actor, job.id);
}

export async function retryFailedMigrationItems(db: DB, actor: Actor, sessionHash: string, jobId: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const job = await one<{ id: string; status: string }>(
    db,
    "select id, status from storage_migration_jobs where id = $1 for update",
    [jobId],
  );
  guard(job.status !== "rolled_back", "INVALID_MIGRATION_STATE", "Rolled-back migration jobs cannot retry items; create a new migration job instead.", 409);
  const res = await db.query(
    `update storage_migration_items
     set status = 'pending', updated_at = now()
     where job_id = $1 and status = 'failed'`,
    [job.id],
  );
  guard((res.rowCount ?? 0) > 0, "NO_FAILED_MIGRATION_ITEMS", "No failed migration items to retry.", 409);
  const c = await refreshMigrationJobCounters(db, job.id);
  await db.query(
    `update storage_migration_jobs
     set status = 'running',
         phase = 'migrate',
         failed_objects = $2,
         completed_at = null,
         updated_at = now()
     where id = $1`,
    [job.id, c.failed_objects],
  );
  return getStorageMigrationJob(db, actor, job.id);
}

export async function rollbackStorageMigrationJob(db: DB, actor: Actor, sessionHash: string, jobId: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const job = await one<{ id: string; job_key: string }>(
    db,
    "select id, job_key from storage_migration_jobs where id = $1 for update",
    [jobId],
  );
  await db.query(
    "update storage_migration_items set status = 'rolled_back', updated_at = now() where job_id = $1 and status <> 'rolled_back'",
    [job.id],
  );
  await db.query(
    "update storage_migration_jobs set status = 'rolled_back', phase = 'expand', updated_at = now() where id = $1",
    [job.id],
  );
  await audit(db, actor, "storage_migration_job_rolled_back", "storage_migration_jobs", job.id, {
    job_key: job.job_key,
    retain_source_copy: true,
  });
  return getStorageMigrationJob(db, actor, job.id);
}
