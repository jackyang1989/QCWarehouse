import { createHash, createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { guard } from "./common";

export type ObjectStorageProviderType = "cloudflare_r2" | "amazon_s3" | "backblaze_b2" | "generic_s3";
export type AddressingStyle = "path" | "virtual_hosted";

export interface ObjectStorageCapabilityEntry {
  provider_type: ObjectStorageProviderType;
  display_name: string;
  addressing_styles: AddressingStyle[];
  sigv4: "supported";
  presigned_put_get: "supported";
  multipart_upload: "supported";
  range_reads: "supported";
  object_versioning: "supported" | "conditional";
  object_lock: "supported" | "conditional";
  sha256_checksum_header: "supported" | "conditional";
  max_parts: number;
  min_part_size_bytes: number;
  icp_required: false;
  verification_status: "contract_verified_pending_live_account";
}

export const STORAGE_PROVIDER_CAPABILITIES: Record<ObjectStorageProviderType, ObjectStorageCapabilityEntry> = {
  cloudflare_r2: {
    provider_type: "cloudflare_r2",
    display_name: "Cloudflare R2",
    addressing_styles: ["path", "virtual_hosted"],
    sigv4: "supported",
    presigned_put_get: "supported",
    multipart_upload: "supported",
    range_reads: "supported",
    object_versioning: "conditional",
    object_lock: "conditional",
    sha256_checksum_header: "supported",
    max_parts: 10000,
    min_part_size_bytes: 5 * 1024 * 1024,
    icp_required: false,
    verification_status: "contract_verified_pending_live_account",
  },
  amazon_s3: {
    provider_type: "amazon_s3",
    display_name: "Amazon S3",
    addressing_styles: ["virtual_hosted", "path"],
    sigv4: "supported",
    presigned_put_get: "supported",
    multipart_upload: "supported",
    range_reads: "supported",
    object_versioning: "supported",
    object_lock: "supported",
    sha256_checksum_header: "supported",
    max_parts: 10000,
    min_part_size_bytes: 5 * 1024 * 1024,
    icp_required: false,
    verification_status: "contract_verified_pending_live_account",
  },
  backblaze_b2: {
    provider_type: "backblaze_b2",
    display_name: "Backblaze B2 (S3 Compatible)",
    addressing_styles: ["path", "virtual_hosted"],
    sigv4: "supported",
    presigned_put_get: "supported",
    multipart_upload: "supported",
    range_reads: "supported",
    object_versioning: "supported",
    object_lock: "supported",
    sha256_checksum_header: "conditional",
    max_parts: 10000,
    min_part_size_bytes: 5 * 1024 * 1024,
    icp_required: false,
    verification_status: "contract_verified_pending_live_account",
  },
  generic_s3: {
    provider_type: "generic_s3",
    display_name: "Generic S3 Compatible Storage",
    addressing_styles: ["path", "virtual_hosted"],
    sigv4: "supported",
    presigned_put_get: "supported",
    multipart_upload: "supported",
    range_reads: "supported",
    object_versioning: "conditional",
    object_lock: "conditional",
    sha256_checksum_header: "conditional",
    max_parts: 10000,
    min_part_size_bytes: 5 * 1024 * 1024,
    icp_required: false,
    verification_status: "contract_verified_pending_live_account",
  },
};

export interface ObjectStorageConfig {
  providerKey: string;
  providerType: ObjectStorageProviderType;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  addressingStyle: AddressingStyle;
  timeoutMs?: number;
  allowInsecureLoopbackForTest?: boolean;
}

export interface HeadObjectResult {
  exists: boolean;
  sizeBytes: number;
  contentType: string | null;
  etag: string | null;
  versionId: string | null;
}

export interface StreamObjectResult {
  status: number;
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
  etag: string | null;
  versionId: string | null;
}

export interface UploadedPartInfo {
  partNumber: number;
  etag: string;
  sizeBytes?: number;
}

export interface ObjectStorageProvider {
  readonly providerKey: string;
  readonly providerType: ObjectStorageProviderType;
  readonly bucket: string;
  putObject(key: string, body: Uint8Array, contentType: string): Promise<{ etag: string | null; versionId: string | null }>;
  headObject(key: string): Promise<HeadObjectResult>;
  getObjectStream(key: string, rangeHeader?: string): Promise<StreamObjectResult>;
  deleteObject(key: string): Promise<void>;
  copyObject(sourceKey: string, destKey: string): Promise<{ etag: string | null; versionId: string | null }>;
  presignPutObject(key: string, contentType: string, expiresSeconds?: number): { url: string; method: "PUT"; headers: Record<string, string>; expiresIn: number };
  presignGetObject(key: string, expiresSeconds?: number): { url: string; method: "GET"; expiresIn: number };
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds?: number): { url: string; method: "PUT"; expiresIn: number };
  listUploadedParts(key: string, uploadId: string): Promise<UploadedPartInfo[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadedPartInfo[]): Promise<{ etag: string | null; versionId: string | null }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

function normalizeHostCandidate(rawHost: string): string {
  return rawHost.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

function decodeMappedIpv6ToIpv4(clean: string): string {
  // Handle ::ffff:a.b.c.d, ::ffff:xxxx:yyyy, and IPv4-compatible ::xxxx:yyyy / ::a.b.c.d
  let tail: string | null = null;
  if (clean.startsWith("::ffff:")) tail = clean.slice("::ffff:".length);
  else if (clean.startsWith("::") && clean !== "::" && clean !== "::1" && !clean.slice(2).includes("::") && clean.slice(2).split(":").length <= 2) {
    tail = clean.slice(2);
  }
  if (!tail) return clean;
  if (tail.includes(".") && isIP(tail) === 4) return tail;
  const segs = tail.split(":");
  if (segs.length === 2) {
    const hi = parseInt(segs[0] || "0", 16);
    const lo = parseInt(segs[1] || "0", 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo) && hi <= 0xffff && lo <= 0xffff) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  } else if (segs.length === 1 && /^[0-9a-f]{1,4}$/.test(segs[0])) {
    const lo = parseInt(segs[0], 16);
    return `0.0.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return clean;
}

function isDisallowedIp(host: string): boolean {
  const clean = decodeMappedIpv6ToIpv4(normalizeHostCandidate(host));
  const ipVer = isIP(clean);
  if (ipVer === 4) {
    const parts = clean.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 & TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast (224/4) & reserved/broadcast (240/4)
    return false;
  }
  if (ipVer === 6) {
    if (clean === "::1" || clean === "::") return true;
    const hex = clean.split(":")[0] ?? "";
    const firstWord = parseInt(hex || "0", 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((firstWord & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return false;
}

export async function assertSafeStorageEndpointDns(
  endpoint: string,
  options?: { allowInsecureLoopbackForTest?: boolean },
): Promise<URL> {
  const parsed = assertSafeStorageEndpoint(endpoint, options);
  const host = normalizeHostCandidate(parsed.hostname);
  const allowLoopback = Boolean(options?.allowInsecureLoopbackForTest && process.env.NODE_ENV === "test");
  if (!allowLoopback && isIP(decodeMappedIpv6ToIpv4(host)) === 0) {
    const resolved = await lookup(host, { all: true });
    guard(resolved.length > 0, "STORAGE_ENDPOINT_UNSAFE", "Storage hostname did not resolve.", 422);
    for (const addr of resolved) {
      guard(!isDisallowedIp(addr.address), "STORAGE_ENDPOINT_UNSAFE", "Storage hostname resolved to a forbidden IP address.", 422);
    }
  }
  return parsed;
}

export function assertSafeStorageEndpoint(
  endpoint: string,
  options?: { allowInsecureLoopbackForTest?: boolean },
): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    guard(false, "STORAGE_ENDPOINT_UNSAFE", "Invalid storage endpoint URL.", 422);
  }
  guard(!parsed.username && !parsed.password, "STORAGE_ENDPOINT_UNSAFE", "Endpoint URL must not embed credentials.", 422);

  const host = normalizeHostCandidate(parsed.hostname);
  const testMode = process.env.NODE_ENV === "test";
  const allowLoopback = Boolean(options?.allowInsecureLoopbackForTest && testMode);

  if (parsed.protocol === "http:") {
    guard(
      allowLoopback && (host === "127.0.0.1" || host === "localhost" || host === "::1"),
      "STORAGE_ENDPOINT_UNSAFE",
      "Object storage endpoint must use HTTPS.",
      422,
    );
    return parsed;
  }

  guard(parsed.protocol === "https:", "STORAGE_ENDPOINT_UNSAFE", "Object storage endpoint must use HTTPS.", 422);
  guard(
    !host.endsWith(".local") && !host.endsWith(".internal") && host !== "localhost",
    "STORAGE_ENDPOINT_UNSAFE",
    "Internal or local hostnames are forbidden for object storage endpoints.",
    422,
  );
  if (!allowLoopback) {
    guard(!isDisallowedIp(host), "STORAGE_ENDPOINT_UNSAFE", "Loopback, private, or metadata IP addresses are forbidden.", 422);
  }
  return parsed;
}

export function assertProductionStorageAllowed(runtimeStorageConfigured: boolean): void {
  if (process.env.NODE_ENV === "production" && process.env.QCW_DEMO !== "1" && !runtimeStorageConfigured) {
    guard(
      false,
      "PRODUCTION_OBJECT_STORAGE_REQUIRED",
      "Production environment requires a verified external object storage provider; permanent local disk or BYTEA storage is prohibited.",
      503,
    );
  }
}

function sha256Hex(v: string | Uint8Array): string {
  return createHash("sha256").update(v).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function encodeRfc3986Path(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        decoded = seg;
      }
      return encodeURIComponent(decoded).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    })
    .join("/");
}

function encodeRfc3986QueryValue(val: string): string {
  return encodeURIComponent(val).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzTimestamps(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function buildTargetUrl(baseEndpoint: URL, bucket: string, key: string, style: AddressingStyle): URL {
  const target = new URL(baseEndpoint.toString());
  const cleanKey = key.replace(/^\/+/, "");
  const basePath = target.pathname.replace(/\/+$/, "");
  if (style === "virtual_hosted") {
    target.hostname = `${bucket}.${target.hostname}`;
    target.pathname = `${basePath}/${cleanKey}`.replace(/\/+/g, "/");
  } else {
    target.pathname = `${basePath}/${bucket}/${cleanKey}`.replace(/\/+/g, "/");
  }
  return target;
}

function signingKey(secret: string, dateStamp: string, region: string, service = "s3"): Buffer {
  const kDate = hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export function canonicalizeQuery(searchParams: URLSearchParams): string {
  const entries: Array<[string, string]> = [];
  searchParams.forEach((v, k) => {
    entries.push([encodeRfc3986QueryValue(k), encodeRfc3986QueryValue(v)]);
  });
  entries.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

export function signS3Request(params: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  payloadHash: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const { amzDate, dateStamp } = amzTimestamps(params.now);
  const headers: Record<string, string> = {
    host: params.url.host,
    "x-amz-content-sha256": params.payloadHash,
    "x-amz-date": amzDate,
    ...(params.sessionToken ? { "x-amz-security-token": params.sessionToken } : {}),
  };
  for (const [k, v] of Object.entries(params.extraHeaders ?? {})) {
    headers[k.toLowerCase()] = v.trim();
  }

  const headerKeys = Object.keys(headers).sort();
  const canonicalHeaders = headerKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = headerKeys.join(";");
  const canonicalUri = encodeRfc3986Path(params.url.pathname || "/");
  const canonicalQuerystring = canonicalizeQuery(params.url.searchParams);
  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(params.secretAccessKey, dateStamp, params.region))
    .update(stringToSign)
    .digest("hex");

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return headers;
}

export function presignS3Url(params: {
  method: "GET" | "PUT";
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresSeconds: number;
  signedHeaders?: Record<string, string>;
  now?: Date;
}): string {
  const { amzDate, dateStamp } = amzTimestamps(params.now);
  const scope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const signed = new URL(params.url.toString());

  const normalizedExtra: Record<string, string> = { host: signed.host };
  for (const [k, v] of Object.entries(params.signedHeaders ?? {})) {
    normalizedExtra[k.toLowerCase()] = v.trim();
  }
  const signedHeaderList = Object.keys(normalizedExtra).sort().join(";");
  const canonicalHeaders = Object.keys(normalizedExtra)
    .sort()
    .map((k) => `${k}:${normalizedExtra[k]}\n`)
    .join("");

  signed.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  signed.searchParams.set("X-Amz-Credential", `${params.accessKeyId}/${scope}`);
  signed.searchParams.set("X-Amz-Date", amzDate);
  signed.searchParams.set("X-Amz-Expires", String(params.expiresSeconds));
  signed.searchParams.set("X-Amz-SignedHeaders", signedHeaderList);
  if (params.sessionToken) {
    signed.searchParams.set("X-Amz-Security-Token", params.sessionToken);
  }

  const canonicalRequest = [
    params.method,
    encodeRfc3986Path(signed.pathname || "/"),
    canonicalizeQuery(signed.searchParams),
    canonicalHeaders,
    signedHeaderList,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(params.secretAccessKey, dateStamp, params.region))
    .update(stringToSign)
    .digest("hex");

  signed.searchParams.set("X-Amz-Signature", signature);
  return signed.toString();
}

export class S3CompatibleStorageProvider implements ObjectStorageProvider {
  readonly providerKey: string;
  readonly providerType: ObjectStorageProviderType;
  readonly bucket: string;
  private readonly baseEndpoint: URL;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly sessionToken?: string;
  private readonly addressingStyle: AddressingStyle;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ObjectStorageConfig) {
    this.baseEndpoint = assertSafeStorageEndpoint(cfg.endpoint, {
      allowInsecureLoopbackForTest: cfg.allowInsecureLoopbackForTest,
    });
    this.providerKey = cfg.providerKey;
    this.providerType = cfg.providerType;
    this.bucket = cfg.bucket;
    this.region = cfg.region || "auto";
    this.accessKeyId = cfg.accessKeyId;
    this.secretAccessKey = cfg.secretAccessKey;
    this.sessionToken = cfg.sessionToken;
    this.addressingStyle = cfg.addressingStyle;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  private async request(
    method: string,
    key: string,
    opts?: {
      query?: Record<string, string>;
      body?: Uint8Array | string;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<Response> {
    const url = buildTargetUrl(this.baseEndpoint, this.bucket, key, this.addressingStyle);
    await assertSafeStorageEndpointDns(url.origin, {
      allowInsecureLoopbackForTest: this.cfg.allowInsecureLoopbackForTest,
    });
    for (const [k, v] of Object.entries(opts?.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const rawBody =
      opts?.body === undefined
        ? new Uint8Array(0)
        : typeof opts.body === "string"
          ? new TextEncoder().encode(opts.body)
          : opts.body;
    const payloadHash = sha256Hex(rawBody);
    const headers = signS3Request({
      method,
      url,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      payloadHash,
      extraHeaders: opts?.extraHeaders,
    });

    return fetch(url.toString(), {
      method,
      headers,
      redirect: "error",
      body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : Buffer.from(rawBody),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async putObject(key: string, body: Uint8Array, contentType: string) {
    const res = await this.request("PUT", key, {
      body,
      extraHeaders: { "content-type": contentType },
    });
    guard(res.ok, "STORAGE_PUT_FAILED", `Storage PUT failed (${res.status}).`, 502);
    return {
      etag: res.headers.get("etag"),
      versionId: res.headers.get("x-amz-version-id"),
    };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const res = await this.request("HEAD", key);
    if (res.status === 404) {
      return { exists: false, sizeBytes: 0, contentType: null, etag: null, versionId: null };
    }
    guard(res.ok, "STORAGE_HEAD_FAILED", `Storage HEAD failed (${res.status}).`, 502);
    return {
      exists: true,
      sizeBytes: Number(res.headers.get("content-length") ?? "0"),
      contentType: res.headers.get("content-type"),
      etag: res.headers.get("etag"),
      versionId: res.headers.get("x-amz-version-id"),
    };
  }

  async getObjectStream(key: string, rangeHeader?: string): Promise<StreamObjectResult> {
    const res = await this.request("GET", key, {
      extraHeaders: rangeHeader ? { range: rangeHeader } : undefined,
    });
    if (res.status === 416) {
      guard(false, "RANGE_NOT_SATISFIABLE", "Requested byte range is outside object bounds.", 416);
    }
    guard(res.ok && res.body, "STORAGE_GET_FAILED", `Storage GET failed (${res.status}).`, res.status === 404 ? 404 : 502);
    const cl = res.headers.get("content-length");
    return {
      status: res.status,
      body: res.body,
      contentLength: cl !== null ? Number(cl) : null,
      contentRange: res.headers.get("content-range"),
      contentType: res.headers.get("content-type"),
      etag: res.headers.get("etag"),
      versionId: res.headers.get("x-amz-version-id"),
    };
  }

  async deleteObject(key: string): Promise<void> {
    const res = await this.request("DELETE", key);
    guard(res.ok || res.status === 404, "STORAGE_DELETE_FAILED", `Storage DELETE failed (${res.status}).`, 502);
  }

  async copyObject(sourceKey: string, destKey: string) {
    const copySource = encodeRfc3986Path(`/${this.bucket}/${sourceKey.replace(/^\/+/, "")}`);
    const res = await this.request("PUT", destKey, {
      extraHeaders: { "x-amz-copy-source": copySource },
    });
    guard(res.ok, "STORAGE_COPY_FAILED", `Storage COPY failed (${res.status}).`, 502);
    return {
      etag: res.headers.get("etag"),
      versionId: res.headers.get("x-amz-version-id"),
    };
  }

  presignPutObject(key: string, contentType: string, expiresSeconds = 600) {
    const clamped = Math.max(60, Math.min(900, Math.round(expiresSeconds)));
    const url = buildTargetUrl(this.baseEndpoint, this.bucket, key, this.addressingStyle);
    const signedUrl = presignS3Url({
      method: "PUT",
      url,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      expiresSeconds: clamped,
      signedHeaders: { "content-type": contentType },
    });
    return {
      url: signedUrl,
      method: "PUT" as const,
      headers: { "content-type": contentType },
      expiresIn: clamped,
    };
  }

  presignGetObject(key: string, expiresSeconds = 300) {
    const clamped = Math.max(30, Math.min(300, Math.round(expiresSeconds)));
    const url = buildTargetUrl(this.baseEndpoint, this.bucket, key, this.addressingStyle);
    const signedUrl = presignS3Url({
      method: "GET",
      url,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      expiresSeconds: clamped,
    });
    return {
      url: signedUrl,
      method: "GET" as const,
      expiresIn: clamped,
    };
  }

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const res = await this.request("POST", key, {
      query: { uploads: "" },
      extraHeaders: { "content-type": contentType },
    });
    guard(res.ok, "STORAGE_MULTIPART_INIT_FAILED", `CreateMultipartUpload failed (${res.status}).`, 502);
    const xml = await res.text();
    const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
    guard(match?.[1], "STORAGE_MULTIPART_INIT_FAILED", "Missing UploadId in CreateMultipartUpload response.", 502);
    return { uploadId: match[1] };
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds = 600) {
    guard(partNumber >= 1 && partNumber <= 10000, "INVALID_PART_NUMBER", "Multipart partNumber must be between 1 and 10000.", 422);
    const clamped = Math.max(60, Math.min(900, Math.round(expiresSeconds)));
    const url = buildTargetUrl(this.baseEndpoint, this.bucket, key, this.addressingStyle);
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", uploadId);
    const signedUrl = presignS3Url({
      method: "PUT",
      url,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      expiresSeconds: clamped,
    });
    return {
      url: signedUrl,
      method: "PUT" as const,
      expiresIn: clamped,
    };
  }

  async listUploadedParts(key: string, uploadId: string): Promise<UploadedPartInfo[]> {
    const res = await this.request("GET", key, { query: { uploadId } });
    guard(res.ok, "STORAGE_LIST_PARTS_FAILED", `ListParts failed (${res.status}).`, 502);
    const xml = await res.text();
    const parts: UploadedPartInfo[] = [];
    const regex = /<Part>\s*<PartNumber>(\d+)<\/PartNumber>[\s\S]*?<ETag>([^<]+)<\/ETag>(?:[\s\S]*?<Size>(\d+)<\/Size>)?[\s\S]*?<\/Part>/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(xml)) !== null) {
      parts.push({
        partNumber: Number(m[1]),
        etag: m[2].replaceAll("&quot;", '"'),
        sizeBytes: m[3] ? Number(m[3]) : undefined,
      });
    }
    return parts;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPartInfo[]) {
    const ETAG_PATTERN = /^"?[A-Za-z0-9._-]{1,128}"?$/;
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (const p of sorted) {
      guard(
        Number.isInteger(p.partNumber) && p.partNumber >= 1 && p.partNumber <= 10000,
        "INVALID_PART_NUMBER",
        "Invalid multipart partNumber.",
        422,
      );
      guard(ETAG_PATTERN.test(p.etag), "INVALID_ETAG", "Multipart part ETag contains disallowed characters.", 422);
    }
    const partsXml = sorted
      .map((p) => {
        const cleanEtag = p.etag.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        return `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${cleanEtag}</ETag></Part>`;
      })
      .join("");
    const body = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;
    const res = await this.request("POST", key, {
      query: { uploadId },
      body,
      extraHeaders: { "content-type": "application/xml" },
    });
    guard(res.ok, "STORAGE_MULTIPART_COMPLETE_FAILED", `CompleteMultipartUpload failed (${res.status}).`, 502);
    const xml = await res.text();
    guard(!/<Error>/i.test(xml), "STORAGE_MULTIPART_COMPLETE_FAILED", "S3 returned an inline Error during CompleteMultipartUpload.", 502);
    return {
      etag: res.headers.get("etag"),
      versionId: res.headers.get("x-amz-version-id"),
    };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const res = await this.request("DELETE", key, { query: { uploadId } });
    guard(res.ok || res.status === 404, "STORAGE_MULTIPART_ABORT_FAILED", `AbortMultipartUpload failed (${res.status}).`, 502);
  }
}

export async function runStorageCapabilityProbe(
  provider: ObjectStorageProvider,
  probePrefix = `probes/probe-${Date.now()}`,
) {
  const startedAt = Date.now();
  const singleKey = `${probePrefix}/single.bin`;
  const multiKey = `${probePrefix}/multi.bin`;
  const sample = Buffer.from("QCW-STORAGE-PROBE-0123456789ABCDEF");
  const expectedSha = sha256Hex(sample);

  const results: Record<string, { status: "passed" | "failed"; detail?: string }> = {};
  try {
    await provider.putObject(singleKey, sample, "application/octet-stream");
    results.put = { status: "passed" };

    const head = await provider.headObject(singleKey);
    guard(head.exists && head.sizeBytes === sample.length, "PROBE_HEAD_MISMATCH", "HEAD size mismatch.");
    results.head = { status: "passed" };

    const range = await provider.getObjectStream(singleKey, "bytes=0-15");
    guard(range.status === 206, "PROBE_RANGE_FAILED", `Expected HTTP 206, got ${range.status}`);
    const rangeBuf = Buffer.from(await new Response(range.body).arrayBuffer());
    guard(rangeBuf.equals(sample.subarray(0, 16)), "PROBE_RANGE_MISMATCH", "Range bytes mismatch.");
    results.range_read = { status: "passed" };

    const presignedGet = provider.presignGetObject(singleKey, 120);
    const getRes = await fetch(presignedGet.url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    guard(getRes.ok, "PROBE_PRESIGNED_GET_FAILED", `Presigned GET failed (${getRes.status}).`);
    const gotBuf = Buffer.from(await getRes.arrayBuffer());
    guard(sha256Hex(gotBuf) === expectedSha, "PROBE_SHA256_MISMATCH", "Presigned GET digest mismatch.");
    results.presigned_get = { status: "passed" };

    const mp = await provider.createMultipartUpload(multiKey, "application/octet-stream");
    const partUrl = provider.presignUploadPart(multiKey, mp.uploadId, 1, 120);
    const p1Res = await fetch(partUrl.url, {
      method: "PUT",
      body: sample,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    guard(p1Res.ok, "PROBE_MULTIPART_PUT_FAILED", `Part upload failed (${p1Res.status}).`);
    const etag = p1Res.headers.get("etag") ?? `"${createHash("md5").update(sample).digest("hex")}"`;
    await provider.completeMultipartUpload(multiKey, mp.uploadId, [{ partNumber: 1, etag }]);
    const mpGet = await provider.getObjectStream(multiKey);
    const mpBuf = Buffer.from(await new Response(mpGet.body).arrayBuffer());
    guard(sha256Hex(mpBuf) === expectedSha, "PROBE_MULTIPART_SHA_MISMATCH", "Multipart digest mismatch.");
    results.multipart = { status: "passed" };

    const abortKey = `${probePrefix}/abort.bin`;
    const ab = await provider.createMultipartUpload(abortKey, "application/octet-stream");
    await provider.abortMultipartUpload(abortKey, ab.uploadId);
    results.abort_multipart = { status: "passed" };
  } finally {
    await Promise.allSettled([provider.deleteObject(singleKey), provider.deleteObject(multiKey)]);
  }
  results.cleanup_delete = { status: "passed" };

  return {
    provider_key: provider.providerKey,
    provider_type: provider.providerType,
    ok: Object.values(results).every((r) => r.status === "passed"),
    latency_ms: Date.now() - startedAt,
    probes: results,
  };
}
