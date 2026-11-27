import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import sharp from "sharp";

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
const appOrigin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;

const { handle } = await import("../packages/core/http");
const { pool } = await import("../packages/db");
const { unseal } = await import("../packages/core/crypto");
const { canonicalizeQuery } = await import("../packages/core/object-storage");
const { registerRuntimeObjectStorageProvider } = await import("../packages/core/storage-service");
const {
  assertNoUnsafeLiveFallback,
  registerTestAllowedStorageEndpointOrigin,
} = await import("../packages/core/storage-hub");

const KEY_A_ID = "QCWHUBKEYA111111";
const KEY_A_SECRET_1 = "qcw-hub-secret-alpha-0123456789abcdef";
const KEY_A_SECRET_2 = "qcw-hub-secret-beta-fedcba9876543210";
const KEY_B_ID = "QCWHUBKEYB222222";
const KEY_B_SECRET = "qcw-hub-secret-bravo-0011223344556677";

const ACTIVE_KEY_MAP = new Map<string, string>([
  [KEY_A_ID, KEY_A_SECRET_1],
  [KEY_B_ID, KEY_B_SECRET],
]);

let failMigrationPutOnce = false;

function verifySigV4WithKeyMap(req: IncomingMessage, fullUrl: URL, payload: Buffer): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("AWS4-HMAC-SHA256 ")) {
    const credMatch = auth.match(/Credential=([^,]+)/);
    const shMatch = auth.match(/SignedHeaders=([^,]+)/);
    const sigMatch = auth.match(/Signature=([a-f0-9]+)/);
    if (!credMatch || !shMatch || !sigMatch) return false;
    const [accessKey, dateStamp, region, service, reqType] = credMatch[1].split("/");
    const secret = ACTIVE_KEY_MAP.get(accessKey);
    if (!secret || service !== "s3" || reqType !== "aws4_request") return false;
    const amzDate = String(req.headers["x-amz-date"] ?? "");
    const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
    if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== createHash("sha256").update(payload).digest("hex")) {
      return false;
    }
    const signedKeys = shMatch[1].split(";");
    const canonicalHeaders = signedKeys.map((k) => `${k}:${String(req.headers[k] ?? "").trim()}\n`).join("");
    const canonicalRequest = [
      (req.method ?? "GET").toUpperCase(),
      fullUrl.pathname,
      canonicalizeQuery(fullUrl.searchParams),
      canonicalHeaders,
      shMatch[1],
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
    const kDate = createHmac("sha256", `AWS4${secret}`).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(region).digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    return createHmac("sha256", kSigning).update(stringToSign).digest("hex") === sigMatch[1];
  }

  const sig = fullUrl.searchParams.get("X-Amz-Signature");
  const cred = fullUrl.searchParams.get("X-Amz-Credential");
  const amzDate = fullUrl.searchParams.get("X-Amz-Date");
  const sh = fullUrl.searchParams.get("X-Amz-SignedHeaders");
  if (!sig || !cred || !amzDate || !sh) return false;
  const [accessKey, dateStamp, region] = cred.split("/");
  const secret = ACTIVE_KEY_MAP.get(accessKey);
  if (!secret) return false;

  const clone = new URLSearchParams(fullUrl.searchParams);
  clone.delete("X-Amz-Signature");
  const signedKeys = sh.split(";");
  const canonicalHeaders = signedKeys.map((k) => `${k}:${String(req.headers[k] ?? "").trim()}\n`).join("");
  const canonicalRequest = [
    (req.method ?? "GET").toUpperCase(),
    fullUrl.pathname,
    canonicalizeQuery(clone),
    canonicalHeaders,
    sh,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const kDate = createHmac("sha256", `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  return createHmac("sha256", kSigning).update(stringToSign).digest("hex") === sig;
}

const storedObjects = new Map<string, { body: Buffer; contentType: string; etag: string; versionId: string }>();
const multipartUploads = new Map<string, { key: string; contentType: string; parts: Map<number, { body: Buffer; etag: string }> }>();

const s3Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const payload = Buffer.concat(chunks);
  const fullUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const segs = fullUrl.pathname.replace(/^\/+/, "").split("/");
  const bucket = segs[0] ?? "";
  const fullKey = `${bucket}/${segs.slice(1).join("/")}`;

  if (req.method === "OPTIONS") {
    const reqOrigin = String(req.headers.origin ?? appOrigin);
    if (bucket.includes("badcors")) {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "PUT, GET",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    res.writeHead(204, {
      "access-control-allow-origin": reqOrigin,
      "access-control-allow-methods": "PUT, GET, HEAD",
      "access-control-allow-headers": "content-type, authorization",
    });
    res.end();
    return;
  }

  if (!verifySigV4WithKeyMap(req, fullUrl, payload)) {
    res.writeHead(403, { "content-type": "application/xml" });
    res.end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
    return;
  }

  if (req.method === "PUT" && fullKey.includes("/migrated/legacy/") && failMigrationPutOnce) {
    failMigrationPutOnce = false;
    res.writeHead(500, { "content-type": "application/xml" });
    res.end("<Error><Code>InternalError</Code></Error>");
    return;
  }

  if (req.method === "POST" && fullUrl.searchParams.has("uploads")) {
    const uploadId = randomUUID();
    multipartUploads.set(uploadId, {
      key: fullKey,
      contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
      parts: new Map(),
    });
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    return;
  }

  if (req.method === "PUT" && fullUrl.searchParams.has("partNumber") && fullUrl.searchParams.has("uploadId")) {
    const mp = multipartUploads.get(fullUrl.searchParams.get("uploadId")!);
    if (!mp) {
      res.writeHead(404);
      res.end();
      return;
    }
    const partNum = Number(fullUrl.searchParams.get("partNumber"));
    const etag = `"${createHash("md5").update(payload).digest("hex")}"`;
    mp.parts.set(partNum, { body: payload, etag });
    res.writeHead(200, { etag });
    res.end();
    return;
  }

  if (req.method === "GET" && fullUrl.searchParams.has("uploadId")) {
    const mp = multipartUploads.get(fullUrl.searchParams.get("uploadId")!);
    if (!mp) {
      res.writeHead(404);
      res.end();
      return;
    }
    const partsXml = [...mp.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${p.etag}</ETag><Size>${p.body.length}</Size></Part>`)
      .join("");
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<ListPartsResult>${partsXml}</ListPartsResult>`);
    return;
  }

  if (req.method === "POST" && fullUrl.searchParams.has("uploadId")) {
    const mp = multipartUploads.get(fullUrl.searchParams.get("uploadId")!);
    if (!mp) {
      res.writeHead(404);
      res.end();
      return;
    }
    const combined = Buffer.concat([...mp.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p.body));
    const etag = `"${createHash("md5").update(combined).digest("hex")}-${mp.parts.size}"`;
    const versionId = `v-${randomUUID().slice(0, 8)}`;
    storedObjects.set(mp.key, { body: combined, contentType: mp.contentType, etag, versionId });
    multipartUploads.delete(fullUrl.searchParams.get("uploadId")!);
    res.writeHead(200, { etag, "x-amz-version-id": versionId, "content-type": "application/xml" });
    res.end(`<CompleteMultipartUploadResult><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
    return;
  }

  if (req.method === "DELETE" && fullUrl.searchParams.has("uploadId")) {
    multipartUploads.delete(fullUrl.searchParams.get("uploadId")!);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
    const rawSource = decodeURIComponent(String(req.headers["x-amz-copy-source"])).replace(/^\/+/, "");
    const src = storedObjects.get(rawSource);
    if (!src) {
      res.writeHead(404);
      res.end();
      return;
    }
    const versionId = `v-${randomUUID().slice(0, 8)}`;
    storedObjects.set(fullKey, { ...src, versionId });
    res.writeHead(200, { etag: src.etag, "x-amz-version-id": versionId, "content-type": "application/xml" });
    res.end(`<CopyObjectResult><ETag>${src.etag}</ETag></CopyObjectResult>`);
    return;
  }

  if (req.method === "PUT") {
    const etag = `"${createHash("md5").update(payload).digest("hex")}"`;
    const versionId = `v-${randomUUID().slice(0, 8)}`;
    storedObjects.set(fullKey, {
      body: payload,
      contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
      etag,
      versionId,
    });
    res.writeHead(200, { etag, "x-amz-version-id": versionId });
    res.end();
    return;
  }

  if (req.method === "HEAD") {
    const obj = storedObjects.get(fullKey);
    if (!obj) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-length": String(obj.body.length),
      "content-type": obj.contentType,
      etag: obj.etag,
      "x-amz-version-id": obj.versionId,
    });
    res.end();
    return;
  }

  if (req.method === "GET") {
    const obj = storedObjects.get(fullKey);
    if (!obj) {
      res.writeHead(404);
      res.end();
      return;
    }
    const range = req.headers.range;
    if (range) {
      const m = range.match(/^bytes=(\d+)-(\d*)$/);
      if (!m) {
        res.writeHead(416);
        res.end();
        return;
      }
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), obj.body.length - 1) : obj.body.length - 1;
      if (start >= obj.body.length || start > end) {
        res.writeHead(416, { "content-range": `bytes */${obj.body.length}` });
        res.end();
        return;
      }
      const slice = obj.body.subarray(start, end + 1);
      res.writeHead(206, {
        "content-type": obj.contentType,
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${end}/${obj.body.length}`,
        "accept-ranges": "bytes",
        etag: obj.etag,
        "x-amz-version-id": obj.versionId,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, {
      "content-type": obj.contentType,
      "content-length": String(obj.body.length),
      "accept-ranges": "bytes",
      etag: obj.etag,
      "x-amz-version-id": obj.versionId,
    });
    res.end(obj.body);
    return;
  }

  if (req.method === "DELETE") {
    storedObjects.delete(fullKey);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(405);
  res.end();
});

class Client {
  private jar = new Map<string, string>();
  async raw(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", extraHeaders: Record<string, string> = {}, key = randomUUID()) {
    const csrf = this.jar.get("qcw_csrf");
    const req = new Request(`${appOrigin}/api/v1${path}`, {
      method,
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(method !== "GET"
          ? {
              origin: appOrigin,
              "Idempotency-Key": key,
              ...(csrf ? { "x-csrf-token": csrf } : {}),
              ...(body !== undefined ? { "content-type": "application/json" } : {}),
            }
          : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const res = await handle(req, path.split("?")[0]);
    for (const c of res.headers.getSetCookie()) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) this.jar.set(m[1], m[2]);
    }
    return res;
  }
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200, key = randomUUID()) {
    const res = await this.raw(path, body, method, {}, key);
    const data = await res.json();
    assert.equal(res.status, expected, `${method} ${path} -> expected ${expected}, got ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }
  async login(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
}

let mockEndpoint = "";

before(async () => {
  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  const addr = s3Server.address();
  assert(addr && typeof addr === "object");
  mockEndpoint = `http://127.0.0.1:${addr.port}`;
  registerTestAllowedStorageEndpointOrigin(mockEndpoint);
  registerRuntimeObjectStorageProvider(null);

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
    ["receiving", "inspector", "reviewer", "finance", "admin", "customer"].map((n) => `${n}@qcw.test`),
  ]);
});

after(async () => {
  registerTestAllowedStorageEndpointOrigin(null);
  registerRuntimeObjectStorageProvider(null);
  await new Promise<void>((resolve) => s3Server.close(() => resolve()));
  await pool.end();
});

test("PKG-2 Wave 14 (TASK-186): Configurable Storage Hub, Secrets, Real RW+CORS Probes, Atomic Switch & Migration Prep", async (t) => {
  const admin = new Client();
  await admin.login("admin@qcw.test");
  const inspector = new Client();
  await inspector.login("inspector@qcw.test");
  const receiver = new Client();
  await receiver.login("receiving@qcw.test");
  const customer = new Client();
  await customer.login("customer@qcw.test");

  const imgBytes = await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 30, g: 120, b: 200 } },
  }).jpeg().toBuffer();
  const imgSha = createHash("sha256").update(imgBytes).digest("hex");

  let instanceAId = "";
  let instanceBId = "";
  let badCorsId = "";
  let publicId = "";
  let objAId = "";
  let objBId = "";
  let publicObjId = "";

  await t.test("S01: RBAC, SSRF, Wildcard CORS, ICP & Inline Secret Guards", async () => {
    await new Client().fetch("/staff/admin/storage/instances", undefined, "GET", 401);
    await customer.fetch("/staff/admin/storage/instances", undefined, "GET", 403);
    await inspector.fetch("/staff/admin/storage/instances", undefined, "GET", 403);
    // warehouse_admin can inspect instances read-only, but cannot create/mutate instances (super_admin only)
    await receiver.fetch("/staff/admin/storage/instances", undefined, "GET", 200);
    await receiver.fetch("/staff/admin/storage/instances", {
      instance_key: "rbac-denied",
      display_name: "Denied",
      provider_type: "cloudflare_r2",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-rbac-denied",
    }, "POST", 403);
    const initialHub = await admin.fetch("/staff/admin/storage/instances");
    assert.equal(initialHub.presets.length, 4);

    // Inline secret forbidden
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "bad-inline-sec",
      display_name: "Bad Inline",
      provider_type: "cloudflare_r2",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-bad-inline",
      secret_access_key: "plaintext-secret",
    }, "POST", 400);

    // SSRF cloud metadata IP blocked
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "bad-ssrf-meta",
      display_name: "Bad SSRF",
      provider_type: "generic_s3",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: "https://169.254.169.254/latest",
      region: "us-east-1",
      bucket: "qcw-ssrf",
    }, "POST", 422);

    // Non-allowlisted loopback blocked
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "bad-ssrf-loop",
      display_name: "Bad Loopback",
      provider_type: "generic_s3",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: "http://127.0.0.1:9999",
      region: "us-east-1",
      bucket: "qcw-ssrf-loop",
    }, "POST", 422);

    // Wildcard CORS forbidden (both "*" and "*.example.com")
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "bad-wildcard-cors",
      display_name: "Bad CORS",
      provider_type: "cloudflare_r2",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-bad-cors",
      allowed_cors_origins: ["*"],
    }, "POST", 422);
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "bad-wildcard-sub",
      display_name: "Bad CORS Subdomain",
      provider_type: "cloudflare_r2",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-bad-cors-sub",
      allowed_cors_origins: ["https://*.qcwarehouse.com"],
    }, "POST", 422);

    // Public CDN URL forbidden on private evidence bucket
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "bad-priv-cdn",
      display_name: "Bad Private CDN",
      provider_type: "cloudflare_r2",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-bad-cdn",
      public_cdn_base_url: "https://cdn.example.com",
    }, "POST", 422);

    // Mainland ICP forbidden
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "bad-icp",
      display_name: "Bad ICP",
      provider_type: "generic_s3",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-bad-icp",
      requires_icp: true,
    }, "POST", 400);
  });

  await t.test("S02: Encrypted Vault Storage, Zero Secret Echo & Rotation / Rollback", async () => {
    const created = await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "r2-primary-a",
      display_name: "Cloudflare R2 Primary A",
      provider_type: "cloudflare_r2",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-evidence-a",
      allowed_cors_origins: [appOrigin],
      routing_purposes: ["inspection_photo"],
    }, "POST", 201);
    instanceAId = created.instance.id;
    assert.equal(created.instance.health_status, "unconfigured");

    // Draft / unprobed cannot be activated (no fake health!)
    await admin.fetch(`/staff/admin/storage/instances/${instanceAId}/state`, {
      lifecycle_state: "active",
      allow_new_writes: true,
    }, "POST", 409);

    await admin.fetch(`/staff/admin/storage/instances/${instanceAId}/secrets`, {
      secret_name: "access_key_id",
      secret_value: KEY_A_ID,
    });
    const sec1 = await admin.fetch(`/staff/admin/storage/instances/${instanceAId}/secrets`, {
      secret_name: "secret_access_key",
      secret_value: KEY_A_SECRET_1,
    });
    assert.equal(sec1.key_version, 1);
    assert(!JSON.stringify(sec1).includes(KEY_A_SECRET_1));

    // Rotate to secret 2 and rollback to secret 1
    const sec2 = await admin.fetch(`/staff/admin/storage/instances/${instanceAId}/secrets`, {
      secret_name: "secret_access_key",
      secret_value: KEY_A_SECRET_2,
    });
    assert.equal(sec2.rotated, true);
    assert.equal(sec2.key_version, 2);
    const rb = await admin.fetch(`/staff/admin/storage/instances/${instanceAId}/secrets/rollback`, {
      secret_name: "secret_access_key",
      target_version: 1,
    });
    assert.equal(rb.restored_version, 1);

    const dbCipher = await pool.query<{ ciphertext: Buffer }>(
      "select ciphertext from storage_instance_secrets where instance_id=$1 and secret_name='secret_access_key' and status='active'",
      [instanceAId],
    );
    assert.equal(unseal(dbCipher.rows[0].ciphertext), KEY_A_SECRET_1);

    const hub = await admin.fetch("/staff/admin/storage/instances");
    assert(!JSON.stringify(hub).includes(KEY_A_SECRET_1));
    assert(!JSON.stringify(hub).includes(KEY_A_SECRET_2));
    const audits = await pool.query<{ meta: string | null }>("select meta::text as meta from audit_events order by at desc limit 10");
    for (const r of audits.rows) {
      const m = r.meta ?? "";
      assert(!m.includes(KEY_A_SECRET_1));
      assert(!m.includes(KEY_A_SECRET_2));
    }
  });

  await t.test("S03: Real Probes Classify Wildcard CORS & Bad Auth Failures and Pass Real RW+CORS", async () => {
    const badCorsCreated = await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "r2-badcors",
      display_name: "Wildcard CORS Bucket",
      provider_type: "cloudflare_r2",
      storage_role: "secondary_failover",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-badcors-bucket",
      allowed_cors_origins: [appOrigin],
    }, "POST", 201);
    badCorsId = badCorsCreated.instance.id;

    // Missing credentials probe fails cleanly as config_incomplete
    const unconf = await admin.fetch(`/staff/admin/storage/instances/${badCorsId}/probe`, {});
    assert.equal(unconf.ok, false);
    assert.equal(unconf.error_class, "config_incomplete");
    assert.equal(unconf.health_status, "unconfigured");

    // Wrong credentials -> auth_or_permission
    await admin.fetch(`/staff/admin/storage/instances/${badCorsId}/secrets`, { secret_name: "access_key_id", secret_value: KEY_A_ID });
    await admin.fetch(`/staff/admin/storage/instances/${badCorsId}/secrets`, { secret_name: "secret_access_key", secret_value: "wrong-secret-0000" });
    const badAuth = await admin.fetch(`/staff/admin/storage/instances/${badCorsId}/probe`, {});
    assert.equal(badAuth.ok, false);
    assert.equal(badAuth.error_class, "auth_or_permission");

    // Valid creds but wildcard '*' CORS returned by bucket -> cors_misconfigured
    await admin.fetch(`/staff/admin/storage/instances/${badCorsId}/secrets`, { secret_name: "secret_access_key", secret_value: KEY_A_SECRET_1 });
    const badCorsProbe = await admin.fetch(`/staff/admin/storage/instances/${badCorsId}/probe`, {});
    assert.equal(badCorsProbe.ok, false);
    assert.equal(badCorsProbe.error_class, "cors_misconfigured");

    // Passing probe on Primary A
    const passProbe = await admin.fetch(`/staff/admin/storage/instances/${instanceAId}/probe`, {});
    assert.equal(passProbe.ok, true);
    assert.equal(passProbe.not_simulated, true);
    assert.equal(passProbe.health_status, "verified");
    assert.equal(passProbe.steps.range_read.status, "passed");
    assert.equal(passProbe.steps.multipart.status, "passed");
    assert.equal(passProbe.steps.cors_preflight.status, "passed");

    // Activate Primary A
    const activated = await admin.fetch(`/staff/admin/storage/instances/${instanceAId}/state`, {
      lifecycle_state: "active",
      allow_new_writes: true,
    });
    assert.equal(activated.instance.lifecycle_state, "active");
    assert.equal(activated.instance.allow_new_writes, true);
  });

  await t.test("S04: Downstream Consumer (storage-service) Resolves Primary A Without In-Memory Provider", async () => {
    registerRuntimeObjectStorageProvider(null);
    const auth = await admin.fetch("/storage/objects/authorize", {
      purpose: "inspection_photo",
      declared_mime: "image/jpeg",
      size_bytes: imgBytes.length,
      expected_sha256: imgSha,
      upload_mode: "presigned_put",
      original_filename: "sample-a.jpg",
    }, "POST", 201);
    objAId = auth.object.id;
    assert.equal(auth.object.storage_instance_id, instanceAId);
    assert.equal(auth.object.storage_provider_key, "r2-primary-a");

    const putRes = await fetch(auth.upload.url, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array(imgBytes),
    });
    assert.equal(putRes.status, 200);

    const comp = await admin.fetch(`/storage/objects/${objAId}/complete`, {});
    assert.equal(comp.object.status, "ready");

    const rangeRes = await admin.raw(`/storage/objects/${objAId}/stream`, undefined, "GET", { range: "bytes=0-31" });
    assert.equal(rangeRes.status, 206);
    const chunk = Buffer.from(await rangeRes.arrayBuffer());
    assert.ok(chunk.equals(imgBytes.subarray(0, 32)));
  });

  await t.test("S05: Atomic Primary Switch Preserves Legacy Historical Reads & Blocks Unsafe Deletion", async () => {
    const createdB = await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "s3-primary-b",
      display_name: "Amazon S3 Primary B",
      provider_type: "amazon_s3",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-evidence-b",
      allowed_cors_origins: [appOrigin],
      routing_purposes: ["inspection_photo"],
    }, "POST", 201);
    instanceBId = createdB.instance.id;
    await admin.fetch(`/staff/admin/storage/instances/${instanceBId}/secrets`, { secret_name: "access_key_id", secret_value: KEY_B_ID });
    await admin.fetch(`/staff/admin/storage/instances/${instanceBId}/secrets`, { secret_name: "secret_access_key", secret_value: KEY_B_SECRET });
    const probeB = await admin.fetch(`/staff/admin/storage/instances/${instanceBId}/probe`, {});
    assert.equal(probeB.ok, true);

    const switched = await admin.fetch("/staff/admin/storage/switch-primary", {
      target_instance_id: instanceBId,
      reason: "Cutover writes from R2 A to S3 B while retaining reads on A",
    });
    assert.equal(switched.switched, true);
    assert.equal(switched.active_instance.instance_key, "s3-primary-b");
    assert.deepEqual(switched.previous_legacy_instances, ["r2-primary-a"]);

    // New upload goes to Primary B
    const authB = await admin.fetch("/storage/objects/authorize", {
      purpose: "inspection_photo",
      declared_mime: "image/jpeg",
      size_bytes: imgBytes.length,
      expected_sha256: imgSha,
    }, "POST", 201);
    objBId = authB.object.id;
    assert.equal(authB.object.storage_instance_id, instanceBId);
    assert.equal(authB.object.storage_provider_key, "s3-primary-b");
    await fetch(authB.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(imgBytes) });
    await admin.fetch(`/storage/objects/${objBId}/complete`, {});

    // Historical object on r2-primary-a (now read_only_legacy) remains readable & Range-streamable
    const oldAccess = await admin.fetch(`/storage/objects/${objAId}/access`);
    assert.equal(oldAccess.sha256, imgSha);
    const oldStream = await admin.raw(`/storage/objects/${objAId}/stream`);
    assert.equal(oldStream.status, 200);
    assert.ok(Buffer.from(await oldStream.arrayBuffer()).equals(imgBytes));

    // Instance A with historical objects cannot be deleted or repointed
    await admin.fetch(`/staff/admin/storage/instances/${instanceAId}`, {}, "DELETE", 409);
    await admin.fetch(`/staff/admin/storage/instances/${instanceAId}`, { bucket: "qcw-tampered" }, "PATCH", 409);
  });

  await t.test("S06: Public Assets Bucket Separation & Private-Object Isolation", async () => {
    // Same bucket + endpoint as private instance B rejected
    await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "public-collision",
      display_name: "Colliding Public Bucket",
      provider_type: "amazon_s3",
      storage_role: "public_assets",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-evidence-b",
    }, "POST", 409);

    const createdPub = await admin.fetch("/staff/admin/storage/instances", {
      instance_key: "r2-public-site",
      display_name: "Public Website Assets",
      provider_type: "cloudflare_r2",
      storage_role: "public_assets",
      environment: "sandbox",
      endpoint_url: mockEndpoint,
      region: "auto",
      bucket: "qcw-public-site",
      allowed_cors_origins: [appOrigin],
    }, "POST", 201);
    publicId = createdPub.instance.id;
    await admin.fetch(`/staff/admin/storage/instances/${publicId}/secrets`, { secret_name: "access_key_id", secret_value: KEY_B_ID });
    await admin.fetch(`/staff/admin/storage/instances/${publicId}/secrets`, { secret_name: "secret_access_key", secret_value: KEY_B_SECRET });
    const pubProbe = await admin.fetch(`/staff/admin/storage/instances/${publicId}/probe`, {});
    assert.equal(pubProbe.ok, true);
    await admin.fetch(`/staff/admin/storage/instances/${publicId}/state`, {
      lifecycle_state: "active",
      allow_new_writes: true,
    });

    // Customer cannot upload public assets
    await customer.fetch("/staff/admin/storage/public-assets/authorize", {
      purpose: "cms_banner",
      declared_mime: "image/jpeg",
      size_bytes: imgBytes.length,
      expected_sha256: imgSha,
    }, "POST", 403);

    const pubAuth = await admin.fetch("/staff/admin/storage/public-assets/authorize", {
      purpose: "cms_banner",
      declared_mime: "image/jpeg",
      size_bytes: imgBytes.length,
      expected_sha256: imgSha,
    }, "POST", 201);
    publicObjId = pubAuth.object.id;
    assert.equal(pubAuth.object.visibility, "public_asset");
    assert.equal(pubAuth.object.storage_instance_id, publicId);
    await fetch(pubAuth.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(imgBytes) });
    await admin.fetch(`/storage/objects/${publicObjId}/complete`, {});

    // Unauthenticated GET succeeds for public asset, returns 404 for private object
    const anon = new Client();
    const okRes = await anon.raw(`/public/assets/${publicObjId}/stream`);
    assert.equal(okRes.status, 200);
    assert.ok(Buffer.from(await okRes.arrayBuffer()).equals(imgBytes));

    const blockedPriv = await anon.raw(`/public/assets/${objBId}/stream`);
    assert.equal(blockedPriv.status, 404);
  });

  await t.test("S07: Fail-Closed on Broken Live Storage & Non-Destructive private_files Migration Prep", async () => {
    // Seed a legacy private_files entry
    await pool.query(
      `insert into private_files(key, data, mime) values($1, $2, 'image/jpeg')
       on conflict(key) do update set data = excluded.data, mime = excluded.mime`,
      ["legacy/w14/sample-proof.jpg", imgBytes],
    );

    const migCreated = await admin.fetch("/staff/admin/storage/migrations", {
      target_instance_id: instanceBId,
      batch_size: 20,
    }, "POST", 201);
    const jobId = migCreated.job.id as string;
    assert.equal(migCreated.job.retain_source_copy, true);
    assert.ok(migCreated.job.total_objects >= 1);

    // Induce one transient PUT error -> item recorded failed without aborting job
    failMigrationPutOnce = true;
    const partial = await admin.fetch(`/staff/admin/storage/migrations/${jobId}/run`, {});
    assert.equal(partial.job.status, "completed_with_errors");
    assert.ok(partial.job.failed_objects >= 1);

    // Retry failed items and finish cleanly while keeping original private_files
    await admin.fetch(`/staff/admin/storage/migrations/${jobId}/retry`, {});
    const finished = await admin.fetch(`/staff/admin/storage/migrations/${jobId}/run`, {});
    assert.equal(finished.job.status, "completed");
    assert.equal(finished.job.failed_objects, 0);
    assert.equal(finished.job.verified_objects, finished.job.total_objects);

    const stillInLegacy = await pool.query("select 1 from private_files where key = 'legacy/w14/sample-proof.jpg'");
    assert.equal(stillInLegacy.rowCount, 1);

    // Pause / Resume / Rollback smoke check on a second job
    const mig2 = await admin.fetch("/staff/admin/storage/migrations", {
      target_instance_id: instanceBId,
      batch_size: 20,
    }, "POST", 201);
    const paused = await admin.fetch(`/staff/admin/storage/migrations/${mig2.job.id}/pause`, {});
    assert.equal(paused.job.status, "paused");
    const resumed = await admin.fetch(`/staff/admin/storage/migrations/${mig2.job.id}/resume`, {});
    assert.equal(resumed.job.status, "running");
    const rolled = await admin.fetch(`/staff/admin/storage/migrations/${mig2.job.id}/rollback`, {});
    assert.equal(rolled.job.status, "rolled_back");

    // Revoking Primary B secret blocks new uploads with 503 (never falls back to private_files)
    await admin.fetch(`/staff/admin/storage/instances/${instanceBId}/secrets/revoke`, {
      secret_name: "secret_access_key",
    });
    await admin.fetch("/storage/objects/authorize", {
      purpose: "inspection_photo",
      declared_mime: "image/jpeg",
      size_bytes: imgBytes.length,
      expected_sha256: imgSha,
    }, "POST", 503);

    // Assert live fallback guard fails closed when no live instance exists
    await assert.rejects(
      () => assertNoUnsafeLiveFallback(pool, { enforceLive: true }),
      (err: unknown) => err instanceof Error && err.message.includes("object storage"),
    );

    // Deleting an empty unused instance (badCorsId) succeeds
    const delEmpty = await admin.fetch(`/staff/admin/storage/instances/${badCorsId}`, {}, "DELETE", 200);
    assert.equal(delEmpty.deleted, true);

    const usage = await admin.fetch("/staff/admin/storage/usage");
    assert.ok(Array.isArray(usage.by_instance));
  });
});
