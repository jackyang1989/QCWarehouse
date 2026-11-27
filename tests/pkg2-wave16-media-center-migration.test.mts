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
const { workOnce } = await import("../packages/core/worker");
const { canonicalizeQuery, S3CompatibleStorageProvider } = await import("../packages/core/object-storage");
const { registerRuntimeObjectStorageProvider } = await import("../packages/core/storage-service");
const { registerTestAllowedStorageEndpointOrigin } = await import("../packages/core/storage-hub");

const ACCESS_KEY = "QCWW16MEDIAKEY";
const SECRET_KEY = "qcw-w16-media-secret-0123456789abcdef";
const REGION = "auto";
const BUCKET = "qcw-w16-evidence";

let failNextDeleteOnce = false;

function verifySigV4(req: IncomingMessage, fullUrl: URL, payload: Buffer): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("AWS4-HMAC-SHA256 ")) {
    const credMatch = auth.match(/Credential=([^,]+)/);
    const shMatch = auth.match(/SignedHeaders=([^,]+)/);
    const sigMatch = auth.match(/Signature=([a-f0-9]+)/);
    if (!credMatch || !shMatch || !sigMatch) return false;
    const [accessKey, dateStamp, region, service, reqType] = credMatch[1].split("/");
    if (accessKey !== ACCESS_KEY || region !== REGION || service !== "s3" || reqType !== "aws4_request") return false;
    const amzDate = String(req.headers["x-amz-date"] ?? "");
    const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
    if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== createHash("sha256").update(payload).digest("hex")) return false;
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
    const kDate = createHmac("sha256", `AWS4${SECRET_KEY}`).update(dateStamp).digest();
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
  if (accessKey !== ACCESS_KEY || region !== REGION) return false;
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
  const kDate = createHmac("sha256", `AWS4${SECRET_KEY}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  return createHmac("sha256", kSigning).update(stringToSign).digest("hex") === sig;
}

const s3Map = new Map<string, { body: Buffer; contentType: string; etag: string; versionId: string }>();
const multipartUploads = new Map<string, { key: string; contentType: string; parts: Map<number, { body: Buffer; etag: string }> }>();
const s3Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const payload = Buffer.concat(chunks);
  const fullUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const fullKey = fullUrl.pathname.replace(/^\/+/, "");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": String(req.headers.origin ?? appOrigin),
      "access-control-allow-methods": "PUT, GET, HEAD, DELETE",
      "access-control-allow-headers": "content-type, authorization",
    });
    res.end();
    return;
  }

  if (!verifySigV4(req, fullUrl, payload)) {
    res.writeHead(403);
    res.end();
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
    s3Map.set(mp.key, { body: combined, contentType: mp.contentType, etag, versionId });
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
    const srcKey = decodeURIComponent(String(req.headers["x-amz-copy-source"])).replace(/^\/+/, "");
    const src = s3Map.get(srcKey);
    if (!src) {
      res.writeHead(404);
      res.end();
      return;
    }
    const versionId = `v-${randomUUID().slice(0, 8)}`;
    s3Map.set(fullKey, { ...src, versionId });
    res.writeHead(200, { etag: src.etag, "x-amz-version-id": versionId, "content-type": "application/xml" });
    res.end(`<CopyObjectResult><ETag>${src.etag}</ETag></CopyObjectResult>`);
    return;
  }

  if (req.method === "PUT") {
    const etag = `"${createHash("md5").update(payload).digest("hex")}"`;
    const versionId = `v-${randomUUID().slice(0, 8)}`;
    s3Map.set(fullKey, {
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
    const obj = s3Map.get(fullKey);
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
    const obj = s3Map.get(fullKey);
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
    if (failNextDeleteOnce) {
      failNextDeleteOnce = false;
      res.writeHead(500);
      res.end("Simulated S3 delete failure");
      return;
    }
    s3Map.delete(fullKey);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(405);
  res.end();
});

class Client {
  private jar = new Map<string, string>();
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200, key = randomUUID()) {
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
    assert.equal(res.status, expected, `${method} ${path} -> expected ${expected}, got ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }
  async fetchRaw(path: string, extraHeaders: Record<string, string> = {}) {
    const req = new Request(`${appOrigin}/api/v1${path}`, {
      method: "GET",
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...extraHeaders,
      },
    });
    return handle(req, path.split("?")[0]);
  }
  async login(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
  async photo(kind: string) {
    const b = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#11736d" } }).png().toBuffer();
    const f = new FormData();
    f.set("photo", new Blob([new Uint8Array(b)], { type: "image/png" }), "proof.png");
    f.set("kind", kind);
    const csrf = this.jar.get("qcw_csrf");
    const req = new Request(`${appOrigin}/api/v1/staff/media`, {
      method: "POST",
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        origin: appOrigin,
        "Idempotency-Key": randomUUID(),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: f,
    });
    const res = await handle(req, "/staff/media");
    const data = await res.json();
    assert.equal(res.status, 201, `POST /staff/media -> ${res.status}: ${JSON.stringify(data)}`);
    return data.id as string;
  }
}

let s3Endpoint = "";

before(async () => {
  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  const addr = s3Server.address();
  assert(addr && typeof addr === "object");
  s3Endpoint = `http://127.0.0.1:${addr.port}`;
  registerTestAllowedStorageEndpointOrigin(s3Endpoint);

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

  registerRuntimeObjectStorageProvider(
    new S3CompatibleStorageProvider({
      providerKey: "w16-test-s3",
      providerType: "cloudflare_r2",
      endpoint: s3Endpoint,
      region: REGION,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      addressingStyle: "path",
      allowInsecureLoopbackForTest: true,
    }),
  );
});

after(async () => {
  registerTestAllowedStorageEndpointOrigin(null);
  registerRuntimeObjectStorageProvider(null);
  await new Promise<void>((resolve) => s3Server.close(() => resolve()));
  await pool.end();
});

test("PKG-2 Wave 16 (TASK-188): Global Media Center, RBAC/Export, Deduplicated Bytes, SoD Delete, Legacy Migration & Tombstone Replay", async (t) => {
  const admin1 = new Client();
  await admin1.login("admin@qcw.test");
  const inspector = new Client();
  await inspector.login("inspector@qcw.test");
  const receiver = new Client();
  await receiver.login("receiving@qcw.test");
  const reviewer = new Client();
  await reviewer.login("reviewer@qcw.test");
  const finance = new Client();
  await finance.login("finance@qcw.test");
  const customer = new Client();
  await customer.login("customer@qcw.test");

  // Create second super_admin + support account for SoD & RBAC matrix tests
  const admin2Id = randomUUID();
  const supportId = randomUUID();
  for (const [uid, email, roleName, name] of [
    [admin2Id, "admin2@qcw.test", "super_admin", "Second Super Admin"],
    [supportId, "support.media@qcw.test", "support", "Support Viewer"],
  ] as const) {
    await pool.query("insert into users(id, display_name, status) values($1, $2, 'active')", [uid, name]);
    const emailId = randomUUID();
    await pool.query(
      "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
      [emailId, uid, email, email],
    );
    await pool.query(
      "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
      [uid, emailId],
    );
    await pool.query("insert into staff_roles(user_id, role) values($1, $2)", [uid, roleName]);
    await pool.query(
      `insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status)
       values($1, $2, $3, 'active', 'active')`,
      [uid, `EMP-${uid.slice(0, 6).toUpperCase()}`, email],
    );
  }
  const admin2 = new Client();
  await admin2.login("admin2@qcw.test");
  const support = new Client();
  await support.login("support.media@qcw.test");

  // Configure active verified storage_instance via real Wave 14 storage hub APIs
  const createdStorage = await admin1.fetch(
    "/staff/admin/storage/instances",
    {
      instance_key: "w16-primary-r2",
      display_name: "W16 Primary R2",
      provider_type: "cloudflare_r2",
      storage_role: "primary",
      environment: "sandbox",
      endpoint_url: s3Endpoint,
      region: REGION,
      bucket: BUCKET,
      allowed_cors_origins: [appOrigin],
      routing_purposes: ["inspection_photo", "legacy_migration"],
    },
    "POST",
    201,
  );
  const storageInstanceId = createdStorage.instance.id as string;
  await admin1.fetch(`/staff/admin/storage/instances/${storageInstanceId}/secrets`, {
    secret_name: "access_key_id",
    secret_value: ACCESS_KEY,
  });
  await admin1.fetch(`/staff/admin/storage/instances/${storageInstanceId}/secrets`, {
    secret_name: "secret_access_key",
    secret_value: SECRET_KEY,
  });
  await admin1.fetch(`/staff/admin/storage/instances/${storageInstanceId}/probe`, {});
  await admin1.fetch(`/staff/admin/storage/instances/${storageInstanceId}/state`, {
    lifecycle_state: "active",
    allow_new_writes: true,
    allow_reads: true,
  });

  // Create order + parcel + item + published report (for citation protection & legacy PDF migration)
  const { terms } = await customer.fetch("/public/terms");
  const offer = (await customer.fetch("/catalog")).offers.find((o: { sku_code: string }) => o.sku_code === "apparel-inspection-1");
  const draft = await customer.fetch("/orders", { lines: [{ category_id: offer.category_id, offer_id: offer.offer_id, quantity: 1 }] }, "POST", 201);
  const quote = await customer.fetch(`/orders/${draft.id}/quotes`, { revision: draft.revision }, "POST", 201);
  const submitted = await customer.fetch(`/orders/${draft.id}/submit`, {
    revision: draft.revision,
    quote_id: quote.id,
    terms_version_ids: terms.map((tm: { id: string }) => tm.id),
    acknowledgements: { scope_notice: true, samples_not_batch: true, seller_refund_is_mine: true, no_certification: true, restricted_items: true },
  });
  const checkout = await customer.fetch(`/charges/${submitted.charge.charge_item_id}/checkout`, { quote_revision: quote.revision });
  await customer.fetch(`/checkout/demo/${checkout.attempt_id}`, {});
  const addr = await customer.fetch("/me/receiving-address");
  const trackingNo = `W16TRK${randomUUID().slice(0, 6).toUpperCase()}`;
  const advice = await customer.fetch("/me/parcels", { address_id: addr.warehouse_address.id, carrier_code: "zto", tracking_no: trackingNo }, "POST", 201);
  const pkg = await receiver.fetch("/staff/intake/check-in", {
    tracking_no: trackingNo,
    advice_id: advice.id,
    carrier_code: "zto",
    outer_media_ids: [await receiver.photo("intake_outer")],
  }, "POST", 201);
  const desk = await receiver.fetch("/staff/desk");
  const r01 = desk.locations.find((l: { code: string }) => l.code === "R-01").id;
  const createdItems = await receiver.fetch(`/staff/packages/${pkg.id}/items`, {
    revision: pkg.revision,
    items: [{ code: "S51601", location_id: r01 }],
  }, "POST", 201);
  const expItem = (await pool.query<{ id: string; order_line_id: string }>(
    "select e.id, e.order_line_id from expected_items e join order_lines l on l.id = e.order_line_id where l.order_id = $1 limit 1",
    [draft.id],
  )).rows[0];
  const labelPhotoId = await receiver.photo("label_photo");
  await receiver.fetch(`/staff/items/${createdItems.item_ids[0]}/assign`, {
    revision: 1,
    order_line_id: expItem.order_line_id,
    expected_item_id: expItem.id,
    evidence_ids: [labelPhotoId],
  });
  const custOrg = (await pool.query<{ org_id: string }>("select org_id from orders where id = $1", [draft.id])).rows[0].org_id;
  const taskRow = (await pool.query<{ id: string }>("select id from inspection_tasks where order_line_id = $1 limit 1", [expItem.order_line_id])).rows[0];

  // Seed warehouse, anotherWarehouse (for inspector scope boundary), workstation, and approved camera device
  const wh1Id = randomUUID();
  const wh2Id = randomUUID();
  const wsId = randomUUID();
  const devId = randomUUID();
  const inspUserId = (await pool.query<{ user_id: string }>("select user_id from user_emails where normalized_email = 'inspector@qcw.test'")).rows[0].user_id;
  const admin1UserId = (await pool.query<{ user_id: string }>("select user_id from user_emails where normalized_email = 'admin@qcw.test'")).rows[0].user_id;

  await pool.query(
    `insert into warehouses (id, warehouse_code, name_zh, name_en, status, created_by)
     values ($1, 'WH-W16A', '东莞主仓A', 'Dongguan Main A', 'active', $2),
            ($3, 'WH-W16B', '深圳副仓B', 'Shenzhen Sub B', 'active', $2)`,
    [wh1Id, admin1UserId, wh2Id],
  );
  await pool.query(
    `insert into staff_profiles (user_id, employee_no, work_email, employment_status, account_security_status, default_warehouse_id, allowed_warehouse_ids)
     values ($1, 'EMP-INSP-W16', 'inspector@qcw.test', 'active', 'active', $2, array[$2]::text[])
     on conflict (user_id) do update set default_warehouse_id = excluded.default_warehouse_id, allowed_warehouse_ids = excluded.allowed_warehouse_ids`,
    [inspUserId, wh1Id],
  );
  await pool.query(
    `insert into workstations (id, warehouse_id, station_code, station_type, name_zh, name_en, status, created_by)
     values ($1, $2, 'WS-W16-B1', 'B_inspection_shoot', 'B工位1号', 'Station B1', 'active', $3)`,
    [wsId, wh1Id, admin1UserId],
  );
  const dev2Id = randomUUID();
  await pool.query(
    `insert into warehouse_devices (id, device_code, warehouse_id, workstation_id, device_role, ownership_type, hardware_fingerprint_hash, approval_status, online_status, auth_generation, registered_by, approved_by, approved_at)
     values ($1, 'CAM-W16-A1', $2, $3, 'camera', 'warehouse_owned', 'fp-hash-w16-a1', 'approved', 'online', 1, $4, $5, now()),
            ($6, 'CAM-W16-B2', $7, null, 'camera', 'warehouse_owned', 'fp-hash-w16-b2', 'approved', 'online', 1, $5, $4, now())`,
    [devId, wh1Id, wsId, inspUserId, admin1UserId, dev2Id, wh2Id],
  );

  // Upload real evidence items via Wave 15 pipeline:
  // (1) inspector photo on wh1 + devId linked to multiple entities (order + item)
  // (2) admin2 photo in wh2 (via dev2Id, outside inspector scope) for deletion tests
  async function capturePhoto(
    client: Client,
    opts: {
      captureKey: string;
      deviceId?: string;
      orderId?: string;
      itemId?: string;
      inspectionTaskId?: string;
      purpose?: string;
      sourceType?: string;
      capturedAt?: string;
    },
  ) {
    const buf = await sharp({ create: { width: 120, height: 90, channels: 3, background: "#0e7c7b" } }).png().toBuffer();
    const sha = createHash("sha256").update(buf).digest("hex");
    const authz = await client.fetch(
      "/evidence/uploads/authorize",
      {
        capture_key: opts.captureKey,
        source_type: opts.sourceType ?? (opts.deviceId ? "mobile_local_capture" : "gallery_file_import"),
        evidence_purpose: opts.purpose ?? "inspection_shot",
        media_kind: "photo",
        device_id: opts.deviceId,
        order_id: opts.orderId,
        warehouse_item_id: opts.itemId,
        inspection_task_id: opts.inspectionTaskId,
        actual_captured_at: opts.capturedAt ?? new Date().toISOString(),
        time_source: opts.deviceId ? "device_monotonic_calibrated" : "user_declared",
        declared_mime: "image/png",
        size_bytes: buf.length,
        expected_sha256: sha,
        original_filename: `${opts.captureKey}.png`,
      },
      "POST",
      201,
    );
    const putReq = await fetch(authz.storage.upload.url, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(buf),
    });
    assert.equal(putReq.status, 200);
    const comp = await client.fetch(
      `/evidence/${authz.evidence.id}/complete`,
      { parts: [] },
      "POST",
      200,
    );
    return {
      evidenceId: authz.evidence.id as string,
      objectId: (comp.evidence?.original_object_id ?? authz.evidence?.original_object_id) as string,
      buf,
      sha,
    };
  }

  const ev1 = await capturePhoto(inspector, {
    captureKey: `cap-w16-multi-${randomUUID().slice(0, 6)}`,
    deviceId: devId,
    orderId: draft.id,
    itemId: createdItems.item_ids[0],
    inspectionTaskId: taskRow.id,
    capturedAt: "2026-11-27T02:00:00.000Z", // 10:00 Asia/Shanghai
  });
  // Drain queued media.process & outbox worker jobs cleanly
  for (let i = 0; i < 20; i += 1) {
    await workOnce();
    const pendingJobs = (await pool.query("select 1 from media_processing_jobs where status in ('queued','processing') limit 1")).rowCount ?? 0;
    if (pendingJobs === 0) break;
  }

  // Also link ev1 to a published report version + create an additional device_test photo & unblocked photo in wh2
  const evTest = await capturePhoto(admin1, {
    captureKey: `cap-w16-devtest-${randomUUID().slice(0, 6)}`,
    deviceId: devId,
    sourceType: "device_test",
    purpose: "device_test",
  });
  const evWh2Deletable = await capturePhoto(admin2, {
    captureKey: `cap-w16-wh2-${randomUUID().slice(0, 6)}`,
    deviceId: dev2Id,
    purpose: "stocktake",
  });

  // Produce a real published report with pdf_key + pdf_sha256 + link ev1 as report_citation
  const repId = randomUUID();
  const repVerId = randomUUID();
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
  const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");
  const pdfKey = `reports/${repVerId}.pdf`;
  await pool.query("insert into private_files(key, data, mime) values($1, $2, 'application/pdf')", [pdfKey, pdfBytes]);
  await pool.query("insert into reports(id, order_id, public_no, current_version, published_version) values($1,$2,$3,1,1)", [
    repId,
    draft.id,
    `RP-W16-${randomUUID().slice(0, 6).toUpperCase()}`,
  ]);
  await pool.query(
    `insert into report_versions(id, report_id, version, state, snapshot, created_by, reviewed_by, reviewed_at, published_at, pdf_key, pdf_sha256, renderer_version)
     values($1,$2,1,'published',$3::jsonb,$4,$5,now(),now(),$6,$7,'pdf-lib-v2')`,
    [repVerId, repId, JSON.stringify({ report_no: "RP-W16-001", sections: [] }), inspUserId, admin1UserId, pdfKey, pdfSha],
  );
  await admin1.fetch(`/staff/evidence/${ev1.evidenceId}/links`, {
    entity_type: "report_version",
    entity_id: repVerId,
    link_role: "report_citation",
  }, "POST", 201);

  await t.test("M01: Global Media Center Search, Timezone Filter & Device/Employee Handover History (CAP20, CAP22)", async () => {
    // Multi-role employee filter + timezone window (2026-11-27 Asia/Shanghai includes 02:00Z, excludes 2026-11-26)
    const hitList = await admin1.fetch(
      "/staff/admin/media?date_basis=captured_at&date_from=2026-11-27&date_to=2026-11-27&tz=Asia/Shanghai&has_report_citation=true",
    );
    assert(hitList.items.some((i: { id: string }) => i.id === ev1.evidenceId));
    // Test captures excluded by default
    assert(!hitList.items.some((i: { id: string }) => i.id === evTest.evidenceId));

    // Device history preserves snapshots & survives device revocation
    const devBefore = await admin1.fetch(`/staff/admin/media/devices/${devId}/history`);
    assert.equal(devBefore.device.device_code, "CAM-W16-A1");
    assert(devBefore.media.items.some((i: { id: string }) => i.id === ev1.evidenceId));

    // Employee history includes disclaimer & survives offboarding
    const empBefore = await admin1.fetch(`/staff/admin/media/employees/${inspUserId}/history`);
    assert(empBefore.disclaimer.includes("must not be used"));
    assert(empBefore.breakdown.direct_capture_count >= 1);

    // Detail returns provenance, variants & deep links
    const detail = await admin1.fetch(`/staff/admin/media/${ev1.evidenceId}`);
    assert.equal(detail.record.original_sha256, ev1.sha);
    assert(detail.variants.some((v: { variant_kind: string }) => v.variant_kind === "thumbnail"));
    assert(detail.links.some((l: { entity_type: string; deep_link: string | null }) => l.entity_type === "order" && l.deep_link?.startsWith("/admin/orders/")));
  });

  await t.test("M02: RBAC, Customer 403, Support Metadata-Only Projection, Inspector Scope & Private Export Manifest (CAP25, CAP27)", async () => {
    // Customer strictly 403
    await customer.fetch("/staff/admin/media", undefined, "GET", 403);
    await customer.fetch("/staff/admin/media/stats", undefined, "GET", 403);
    await customer.fetch(`/staff/admin/media/${ev1.evidenceId}`, undefined, "GET", 403);

    // Support: metadata list OK, original & normalized/video_playback stream FORBIDDEN 403, thumbnail stream OK 200, include_originals export 403
    const supList = await support.fetch("/staff/admin/media");
    assert.equal(supList.view_capabilities.can_download_original, false);
    const supOrigStream = await support.fetchRaw(`/staff/admin/media/${ev1.evidenceId}/stream?variant=original`);
    assert.equal(supOrigStream.status, 403);
    const supNormStream = await support.fetchRaw(`/staff/admin/media/${ev1.evidenceId}/stream?variant=normalized`);
    assert.equal(supNormStream.status, 403);
    const supVideoStream = await support.fetchRaw(`/staff/admin/media/${ev1.evidenceId}/stream?variant=video_playback`);
    assert.equal(supVideoStream.status, 403);
    const supThumbStream = await support.fetchRaw(`/staff/admin/media/${ev1.evidenceId}/stream?variant=thumbnail`);
    assert.equal(supThumbStream.status, 200);
    await support.fetch(
      "/staff/admin/media/exports",
      { purpose_reason: "Unauthorized original export attempt", include_originals: true },
      "POST",
      403,
    );

    // Inspector scoped to wh1: cannot see wh2 evidence or create retention requests across warehouses or on device_test
    const inspList = await inspector.fetch("/staff/admin/media");
    assert(inspList.items.some((i: { id: string }) => i.id === ev1.evidenceId));
    assert(!inspList.items.some((i: { id: string }) => i.id === evWh2Deletable.evidenceId));
    await inspector.fetch(`/staff/admin/media/${evWh2Deletable.evidenceId}`, undefined, "GET", 404);
    await inspector.fetch(
      `/staff/admin/media/${evWh2Deletable.evidenceId}/retention-requests`,
      { action_type: "quarantine", reason: "Cross-warehouse scope violation test" },
      "POST",
      404,
    );
    await inspector.fetch(
      `/staff/admin/media/${evTest.evidenceId}/retention-requests`,
      { action_type: "quarantine", reason: "Device test retention scope violation" },
      "POST",
      403,
    );

    // Finance cannot export
    await finance.fetch("/staff/admin/media/exports", { purpose_reason: "Finance audit", include_originals: false }, "POST", 403);

    // Super admin creates controlled export manifest without leaking credentials or presigned URLs
    const exp = await admin1.fetch(
      "/staff/admin/media/exports",
      { purpose_reason: "QA compliance archive manifest", include_originals: false, filters: { order_id: draft.id } },
      "POST",
      201,
    );
    assert(exp.job.manifest_sha256.length === 64);
    const manifestStr = JSON.stringify(exp.manifest);
    assert(!manifestStr.includes(SECRET_KEY));
    assert(!manifestStr.includes("X-Amz-Signature"));
    const cancelled = await admin1.fetch(`/staff/admin/media/exports/${exp.job.id}/cancel`, {}, "POST", 200);
    assert.equal(cancelled.job.status, "cancelled");
  });

  await t.test("M03: Deduplicated Physical Bytes vs Citations & Honest Unknown->RateCard Cost Accounting (CAP26)", async () => {
    const statsBefore = await admin1.fetch("/staff/admin/media/stats");
    // ev1 is linked to order + warehouse_item + report_version (3 links) yet original object counted ONCE
    assert(statsBefore.counts.logical_entity_links_count >= 3);
    assert.equal(statsBefore.cost_accounting.cost_basis, "unknown");
    assert.equal(statsBefore.cost_accounting.estimated_monthly_cost_cents, null);
    assert(statsBefore.counts.device_test_count >= 1);

    // Total physical bytes must equal sum of distinct objects (no duplicate multi-citation counting)
    const distinctSum = (
      await pool.query<{ total: string }>(
        `select coalesce(sum(size_bytes), 0)::text as total
         from storage_objects where status <> 'cancelled' and id in (
           select original_object_id from media_evidence_records
           union
           select storage_object_id from media_evidence_variants
         )`,
      )
    ).rows[0].total;
    assert.equal(statsBefore.physical_bytes.total_physical_bytes, distinctSum);

    // Configure rate card and verify cost basis flips honestly to estimated_rate_card
    await admin1.fetch(
      "/staff/admin/media/rate-cards",
      {
        storage_instance_id: storageInstanceId,
        currency: "USD",
        rate_version: "r2-2026-v1",
        storage_gb_month_cents: 1500,
      },
      "POST",
      201,
    );
    const statsAfter = await admin1.fetch("/staff/admin/media/stats");
    assert.equal(statsAfter.cost_accounting.cost_basis, "estimated_rate_card");
    assert.deepEqual(statsAfter.cost_accounting.rate_versions, ["r2-2026-v1"]);
    assert.equal(statsAfter.cost_accounting.shared_object_allocation_rule, "deduplicated_by_storage_object_id");
  });

  await t.test("M04: Published Report Citation Protection, SoD Controlled Delete & Failed Delete Honesty (CAP24, CAP27)", async () => {
    // Published report citation blocks controlled_delete even when approved by distinct super_admin
    const blockedReq = await admin1.fetch(
      `/staff/admin/media/${ev1.evidenceId}/retention-requests`,
      { action_type: "controlled_delete", reason: "Attempt delete cited report evidence" },
      "POST",
      201,
    );
    await admin2.fetch(
      `/staff/admin/media/retention-requests/${blockedReq.request.id}/decide`,
      { decision: "approve" },
      "POST",
      409,
    );
    const blockedAudit = (
      await pool.query(
        "select 1 from storage_access_audit where object_id = $1 and action = 'delete_blocked' limit 1",
        [ev1.objectId],
      )
    ).rowCount;
    assert.equal(blockedAudit, 1);

    // Unblocked object in wh2: self-approval forbidden (403 SOD_VIOLATION)
    const delReq = await admin1.fetch(
      `/staff/admin/media/${evWh2Deletable.evidenceId}/retention-requests`,
      { action_type: "controlled_delete", reason: "Approved privacy removal test" },
      "POST",
      201,
    );
    await admin1.fetch(
      `/staff/admin/media/retention-requests/${delReq.request.id}/decide`,
      { decision: "approve" },
      "POST",
      403,
    );

    // Remote S3 DELETE failure must persist request status='failed' (never fake executed!)
    failNextDeleteOnce = true;
    await admin2.fetch(
      `/staff/admin/media/retention-requests/${delReq.request.id}/decide`,
      { decision: "approve" },
      "POST",
      502,
    );
    const failedRow = (
      await pool.query<{ status: string; execution_error: string | null }>(
        "select status, execution_error from media_retention_requests where id = $1",
        [delReq.request.id],
      )
    ).rows[0];
    assert.equal(failedRow.status, "failed");
    assert(failedRow.execution_error);

    // Fresh request approved by distinct super_admin executes controlled delete cleanly & marks 410 non-playable
    const delReq2 = await admin1.fetch(
      `/staff/admin/media/${evWh2Deletable.evidenceId}/retention-requests`,
      { action_type: "controlled_delete", reason: "Second attempt after storage recovery" },
      "POST",
      201,
    );
    const execRes = await admin2.fetch(
      `/staff/admin/media/retention-requests/${delReq2.request.id}/decide`,
      { decision: "approve" },
      "POST",
      200,
    );
    assert.equal(execRes.request.status, "executed");
    const detAfterDel = await admin1.fetch(`/staff/admin/media/${evWh2Deletable.evidenceId}`);
    assert.equal(detAfterDel.record.deleted, true);
    assert.equal(detAfterDel.record.playable, false);
    const streamDel = await admin1.fetchRaw(`/staff/admin/media/${evWh2Deletable.evidenceId}/stream?variant=original`);
    assert.equal(streamDel.status, 410);
  });

  await t.test("M05: Non-Destructive Legacy private_files + media_assets + Published PDF Migration & Rollback (§40, T120)", async () => {
    // Ensure existing media_asset (labelPhotoId) has NULL captured_at to test honest legacy_unknown backfill
    await pool.query("update media_assets set captured_at = null where id = $1", [labelPhotoId]);
    const labelBefore = (
      await pool.query<{ object_key: string; sha256: string; uploaded_by: string | null }>(
        "select object_key, sha256, uploaded_by from media_assets where id = $1",
        [labelPhotoId],
      )
    ).rows[0];

    const createdJob = await admin1.fetch(
      "/staff/admin/storage/migrations",
      { target_instance_id: storageInstanceId, batch_size: 50 },
      "POST",
      201,
    );
    const jobId = createdJob.job.id as string;
    const runRes = await admin1.fetch(`/staff/admin/storage/migrations/${jobId}/run`, {}, "POST", 200);
    assert.equal(runRes.job.status, "completed");
    assert.equal(runRes.job.failed_objects, 0);

    // Switch pointers to migrated S3 objects while retaining private_files & preserving published pdf_sha256
    const swRes = await admin1.fetch(`/staff/admin/media/migrations/${jobId}/switch`, {}, "POST", 200);
    assert.equal(swRes.phase, "switch");
    assert(swRes.switched_reports >= 1);
    assert(swRes.switched_media_assets >= 1);
    assert(swRes.backfilled_evidence >= 1);

    // Verify published report PDF SHA-256 unchanged (immutable report_versions row untouched) & dual-read pointer resolves object storage
    const rvCheck = (
      await pool.query<{ pdf_sha256: string }>(
        "select pdf_sha256 from report_versions where id = $1",
        [repVerId],
      )
    ).rows[0];
    assert.equal(rvCheck.pdf_sha256, pdfSha);
    const ptrCheck = (
      await pool.query<{ storage_object_id: string; verified_sha256: string }>(
        "select storage_object_id, verified_sha256 from legacy_file_storage_pointers where legacy_key = $1",
        [pdfKey],
      )
    ).rows[0];
    assert(ptrCheck?.storage_object_id);
    assert.equal(ptrCheck.verified_sha256, pdfSha);

    const { reportDownloadSignature } = await import("../packages/core/auth");
    const custId = (await pool.query<{ user_id: string }>("select user_id from user_emails where normalized_email = 'customer@qcw.test'")).rows[0].user_id;
    const expTs = Date.now() + 60_000;
    const sig = reportDownloadSignature(custId, repVerId, expTs);
    const pdfHttp = await customer.fetchRaw(`/orders/${draft.id}/report/versions/1/file?expires=${expTs}&sig=${sig}`);
    assert.equal(pdfHttp.status, 200);
    const downloadedPdf = Buffer.from(await pdfHttp.arrayBuffer());
    assert.equal(createHash("sha256").update(downloadedPdf).digest("hex"), pdfSha);

    // Verify backfilled legacy media_evidence_records NEVER fabricated author/device/timestamp!
    const backfilled = (
      await pool.query<{
        source_type: string;
        source_trust_level: string;
        capture_responsible_user_id: string | null;
        device_id: string | null;
        uploader_user_id: string;
        time_source: string;
        time_unknown_reason: string | null;
        original_sha256: string;
      }>(
        `select source_type, source_trust_level, capture_responsible_user_id, device_id,
                uploader_user_id, time_source, time_unknown_reason, original_sha256
         from media_evidence_records where legacy_media_asset_id = $1`,
        [labelPhotoId],
      )
    ).rows[0];
    assert.equal(backfilled.source_type, "legacy_migration");
    assert.equal(backfilled.source_trust_level, "legacy_unknown");
    assert.equal(backfilled.capture_responsible_user_id, null);
    assert.equal(backfilled.device_id, null);
    assert.equal(backfilled.uploader_user_id, labelBefore.uploaded_by);
    assert.equal(backfilled.time_source, "unknown");
    assert.equal(backfilled.time_unknown_reason, "legacy_asset_missing_captured_at");
    assert.equal(backfilled.original_sha256, labelBefore.sha256);

    // Rollback pointers cleanly preserves dual-read fallback via retained private_files
    const rbRes = await admin1.fetch(`/staff/admin/media/migrations/${jobId}/rollback-switch`, {}, "POST", 200);
    assert.equal(rbRes.phase, "verify");
    const pdfHttpAfterRb = await customer.fetchRaw(`/orders/${draft.id}/report/versions/1/file?expires=${expTs}&sig=${sig}`);
    assert.equal(pdfHttpAfterRb.status, 200);
    assert.equal(createHash("sha256").update(Buffer.from(await pdfHttpAfterRb.arrayBuffer())).digest("hex"), pdfSha);
  });

  await t.test("M06: Conservation Reconciliation & Backup-Restore Revocation Tombstone Replay (CAP28, ST-04)", async () => {
    // Revoke device via standard CAP18 endpoint -> verify device_revocation tombstone persisted automatically
    await admin1.fetch(`/staff/devices/${devId}/revoke`, { reason: "Hardware retired after shift" }, "POST", 200);
    const tombstones = await admin1.fetch("/staff/admin/media/recovery/tombstones");
    assert(tombstones.tombstones.some((tb: { entity_type: string; entity_id: string }) => tb.entity_type === "device_revocation" && tb.entity_id === devId));
    assert(tombstones.tombstones.some((tb: { entity_type: string; entity_id: string }) => tb.entity_type === "media_controlled_delete" && tb.entity_id === evWh2Deletable.evidenceId));

    // Simulate restoring an older backup snapshot where revoked device regressed to approved+active lease and deleted media re-appeared
    await pool.query(
      "update warehouse_devices set approval_status = 'approved', auth_generation = 1, revoked_at = null where id = $1",
      [devId],
    );
    await pool.query(
      `insert into device_control_leases (id, device_id, workstation_id, holder_user_id, auth_generation, lease_token_hash, status, expires_at)
       values ($1, $2, $3, $4, 1, 'zombie-lease-hash', 'active', now() + interval '4 hours')`,
      [randomUUID(), devId, wsId, inspUserId],
    );

    // Run conservation reconciliation first -> must detect revoked/anomalies without silently forging or clearing data
    const recon = await admin1.fetch("/staff/admin/media/reconcile", {}, "POST", 201);
    assert(recon.anomalies_detected >= 1);
    const anomList = await admin1.fetch("/staff/admin/media/reconcile");
    assert(anomList.anomalies.length >= 1);
    const firstAnom = anomList.anomalies[0];
    const resolvedAnom = await admin1.fetch(
      `/staff/admin/media/reconcile/anomalies/${firstAnom.id}/resolve`,
      { note: "Reviewed during Wave 16 verification" },
      "POST",
      200,
    );
    assert.equal(resolvedAnom.anomaly.status, "resolved");

    // Replay revocation tombstones -> must kill zombie device & lease immediately (CAP28)
    const replayRes = await admin1.fetch("/staff/admin/media/recovery/replay-tombstones", {}, "POST", 200);
    assert(replayRes.replayed_tombstones >= 2);
    assert(replayRes.devices_enforced >= 1);

    const devAfter = (
      await pool.query<{ approval_status: string; auth_generation: number }>(
        "select approval_status, auth_generation from warehouse_devices where id = $1",
        [devId],
      )
    ).rows[0];
    assert.equal(devAfter.approval_status, "revoked");
    assert(devAfter.auth_generation >= 2);

    const activeLeasesAfter = (
      await pool.query("select 1 from device_control_leases where device_id = $1 and status = 'active'", [devId])
    ).rowCount;
    assert.equal(activeLeasesAfter, 0);

    // Device & employee historical records remain auditable even after device revocation
    const devHistAfter = await admin1.fetch(`/staff/admin/media/devices/${devId}/history`);
    assert.equal(devHistAfter.device.approval_status, "revoked");
    assert(devHistAfter.media.items.some((i: { id: string }) => i.id === ev1.evidenceId));
  });
});
