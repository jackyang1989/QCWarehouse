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
const { pool, transaction } = await import("../packages/db");
const { workOnce } = await import("../packages/core/worker");
const { canonicalizeQuery, S3CompatibleStorageProvider } = await import("../packages/core/object-storage");
const { registerRuntimeObjectStorageProvider } = await import("../packages/core/storage-service");
const { registerTestAllowedStorageEndpointOrigin } = await import("../packages/core/storage-hub");

const ACCESS_KEY = "QCWW15CAPTUREKEY";
const SECRET_KEY = "qcw-w15-capture-secret-0123456789abcdef";
const REGION = "auto";
const BUCKET = "qcw-w15-evidence";

let failDerivativePutOnce = false;

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

const s3Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const payload = Buffer.concat(chunks);
  const fullUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const fullKey = fullUrl.pathname.replace(/^\/+/, "");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": String(req.headers.origin ?? appOrigin),
      "access-control-allow-methods": "PUT, GET, HEAD",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  if (!verifySigV4(req, fullUrl, payload)) {
    res.writeHead(403);
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
    if (fullKey.includes("normalized_v1") && failDerivativePutOnce) {
      failDerivativePutOnce = false;
      res.writeHead(500);
      res.end("Transient S3 derivative upload failure");
      return;
    }
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
    res.writeHead(200, {
      "content-type": obj.contentType,
      "content-length": String(obj.body.length),
      etag: obj.etag,
      "x-amz-version-id": obj.versionId,
    });
    res.end(obj.body);
    return;
  }

  if (req.method === "DELETE") {
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
  async login(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
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
      providerKey: "w15-test-s3",
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

test("PKG-2 Wave 15 (TASK-187): Capture Commands, Truthful Time/Author, Async Derivatives & Quarantine Contracts", async (t) => {
  const admin = new Client();
  await admin.login("admin@qcw.test");
  const inspector = new Client();
  await inspector.login("inspector@qcw.test");
  const receiver = new Client();
  await receiver.login("receiving@qcw.test");
  const reviewer = new Client();
  await reviewer.login("reviewer@qcw.test");
  const customer = new Client();
  await customer.login("customer@qcw.test");

  // Create a real paid order, intake check-in, item assignment & inspection task via API
  const inspUser = (await pool.query<{ id: string }>("select user_id as id from user_emails where normalized_email='inspector@qcw.test'")).rows[0];
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
  const trackingNo = `ZT${randomUUID().slice(0, 8).toUpperCase()}`;
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
    items: [{ code: "S51501", location_id: r01 }],
  }, "POST", 201);
  const expItem = (await pool.query<{ id: string; order_line_id: string }>(
    "select e.id, e.order_line_id from expected_items e join order_lines l on l.id = e.order_line_id where l.order_id = $1 limit 1",
    [draft.id],
  )).rows[0];
  await receiver.fetch(`/staff/items/${createdItems.item_ids[0]}/assign`, {
    revision: 1,
    order_line_id: expItem.order_line_id,
    expected_item_id: expItem.id,
    evidence_ids: [await receiver.photo("label_photo")],
  });
  const custOrg = (await pool.query<{ org_id: string; id: string }>("select id, org_id from orders where id = $1", [draft.id])).rows[0];
  const taskRow = (await pool.query<{ id: string }>("select id from inspection_tasks where order_line_id = $1 limit 1", [expItem.order_line_id])).rows[0];

  const warehouseId = randomUUID();
  const workstationId = randomUUID();
  const deviceId = randomUUID();
  const leaseId = randomUUID();
  const workItemId = randomUUID();
  const samplePkgId = randomUUID();
  const itemAId = randomUUID();
  const itemBId = randomUUID();
  const unmatchedPkgId = randomUUID();
  const orgBPkgId = randomUUID();
  const orgBId = randomUUID();

  await transaction(async (db) => {
    await db.query(
      `insert into warehouses(id, warehouse_code, name_zh, name_en, status, timezone)
       values($1, 'WH-W15', '深圳测试仓', 'Shenzhen W15', 'active', 'Asia/Shanghai')`,
      [warehouseId],
    );
    await db.query(
      `insert into workstations(id, warehouse_id, station_code, station_type, name_zh, name_en, status)
       values($1, $2, 'WS-W15-B', 'B_inspection_shoot', '摄影工位B', 'Shoot Station B', 'active')`,
      [workstationId, warehouseId],
    );
    await db.query(
      `insert into warehouse_devices(
         id, device_code, warehouse_id, workstation_id, device_role, ownership_type,
         hardware_fingerprint_hash, approval_status, auth_generation
       ) values($1, 'CAM-W15-A', $2, $3, 'camera', 'warehouse_owned', 'hw-hash-w15-cam-a', 'approved', 1)`,
      [deviceId, warehouseId, workstationId],
    );
    await db.query(
      `insert into device_control_leases(
         id, device_id, workstation_id, holder_user_id, auth_generation, lease_token_hash, status, expires_at
       ) values($1, $2, $3, $4, 1, 'lease-token-hash-w15', 'active', now() + interval '4 hours')`,
      [leaseId, deviceId, workstationId, inspUser.id],
    );
    await db.query(
      `insert into dispatch_work_items(
         id, warehouse_id, task_domain, source_entity_id, inspection_task_id, required_role,
         dispatch_status, current_assignee_id, workstation_id, execution_generation
       ) values($1, $2, 'inspection', $3, $4, 'inspector', 'in_progress', $5, $6, 1)`,
      [workItemId, warehouseId, randomUUID(), taskRow.id, inspUser.id, workstationId],
    );
    await db.query(
      `insert into packages(id, code, org_id, received_by, received_at, state)
       values ($1, 'PKG-W15-CUST', $2, $3, now(), 'received')`,
      [samplePkgId, custOrg.org_id, inspUser.id],
    );
    const batchId = randomUUID();
    await db.query(
      `insert into warehouse_items(id, code, org_id, package_id, intake_batch_id, identity_state, condition_state, custody_state, received_at)
       values ($1, 'ITM-W15-A', $2, $3, $4, 'identified', 'intact', 'stored', now()),
              ($5, 'ITM-W15-B', $2, $3, $4, 'identified', 'intact', 'stored', now())`,
      [itemAId, custOrg.org_id, samplePkgId, batchId, itemBId],
    );
    await db.query(
      `insert into packages(id, code, org_id, received_by, received_at, state)
       values ($1, 'PKG-UNMATCHED-W15', null, $2, now(), 'unmatched')`,
      [unmatchedPkgId, inspUser.id],
    );
    await db.query("insert into organizations(id, name) values($1, 'Isolated Org B W15')", [orgBId]);
    await db.query(
      `insert into packages(id, code, org_id, received_by, received_at, state)
       values ($1, 'PKG-ORGB-W15', $2, $3, now(), 'received')`,
      [orgBPkgId, orgBId, inspUser.id],
    );
  });

  const photoBytes = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 100, b: 180 } },
  }).jpeg().toBuffer();
  const photoSha = createHash("sha256").update(photoBytes).digest("hex");

  let frozenCmdId = "";
  let mainEvidenceId = "";
  let lateEvidenceId = "";
  let unmatchedEvidenceId = "";
  let deviceTestEvidenceId = "";
  let staleEvidenceId = "";

  await t.test("E01: Frozen Capture Command, Lease Check & Upload Session Re-Issuance (ST-02 / CAP07)", async () => {
    // Wrong staff cannot use inspector's device control lease
    await receiver.fetch("/staff/capture/commands", {
      command_key: "cmd-bad-lease",
      source_type: "pc_remote_mobile",
      capture_mode: "photo",
      evidence_purpose: "inspection_shot",
      work_item_id: workItemId,
      warehouse_item_id: itemAId,
      device_id: deviceId,
      control_lease_id: leaseId,
    }, "POST", 403);

    const cmdRes = await inspector.fetch("/staff/capture/commands", {
      command_key: "cmd-w15-shot-001",
      source_type: "pc_remote_mobile",
      capture_mode: "photo",
      evidence_purpose: "inspection_shot",
      work_item_id: workItemId,
      warehouse_item_id: itemAId,
      device_id: deviceId,
      camera_role: "overhead",
      control_lease_id: leaseId,
    }, "POST", 201);
    frozenCmdId = cmdRes.command.id;
    assert.equal(cmdRes.command.command_issuer_user_id, inspUser.id);
    assert.equal(cmdRes.command.capture_responsible_user_id, inspUser.id);
    assert.equal(cmdRes.command.execution_generation, 1);

    // Same command_key replays cleanly (CAP07 no duplicate shutter)
    const replay = await inspector.fetch("/staff/capture/commands", {
      command_key: "cmd-w15-shot-001",
      source_type: "pc_remote_mobile",
      capture_mode: "photo",
      evidence_purpose: "inspection_shot",
      work_item_id: workItemId,
      warehouse_item_id: itemAId,
      device_id: deviceId,
      control_lease_id: leaseId,
    }, "POST", 200);
    assert.equal(replay.replayed, true);
    assert.equal(replay.command.id, frozenCmdId);

    // Authorize upload and expire its upload session -> re-authorize same capture_key reuses evidence without mutating original_object_id
    const auth1 = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-001",
      command_id: frozenCmdId,
      source_type: "pc_remote_mobile",
      evidence_purpose: "inspection_shot",
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_monotonic_calibrated",
      device_clock_offset_ms: 120,
    }, "POST", 201);
    mainEvidenceId = auth1.evidence.id;
    const origObjId = auth1.evidence.original_object_id;

    await pool.query(
      "update storage_upload_sessions set expires_at = now() - interval '1 minute' where object_id = $1",
      [origObjId],
    );
    const reAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-001",
      command_id: frozenCmdId,
      source_type: "pc_remote_mobile",
      evidence_purpose: "inspection_shot",
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_monotonic_calibrated",
      device_clock_offset_ms: 120,
    }, "POST", 200);
    assert.equal(reAuth.replayed, true);
    assert.equal(reAuth.evidence.id, mainEvidenceId);
    assert.equal(reAuth.evidence.original_object_id, origObjId);
    assert.ok(reAuth.storage.upload.url);
  });

  await t.test("E02: Integrity Quarantine (T36) & Async Worker Derivatives Preserve Original SHA-256 (CAP12 / G08)", async () => {
    // Upload corrupted bytes against separate capture -> 422 quarantined
    const badAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-bad-sha",
      command_id: frozenCmdId,
      source_type: "pc_remote_mobile",
      evidence_purpose: "inspection_shot",
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_wall_clock",
    }, "POST", 201);
    const corrupted = Buffer.from(photoBytes);
    corrupted[corrupted.length - 10] ^= 0xff;
    await fetch(badAuth.storage.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(corrupted) });
    const badComp = await inspector.fetch(`/evidence/${badAuth.evidence.id}/complete`, {}, "POST", 422);
    assert.equal(badComp.quarantined, true);
    assert.equal(badComp.evidence.processing_state, "quarantined");
    await inspector.fetch(`/staff/evidence/${badAuth.evidence.id}/links`, {
      entity_type: "report_version",
      entity_id: randomUUID(),
      link_role: "report_citation",
    }, "POST", 409);

    // Now upload authentic JPEG for mainEvidenceId via fresh session and process in worker
    const reAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-001",
      command_id: frozenCmdId,
      source_type: "pc_remote_mobile",
      evidence_purpose: "inspection_shot",
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_monotonic_calibrated",
      device_clock_offset_ms: 120,
    }, "POST", 200);
    const putOk = await fetch(reAuth.storage.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(photoBytes) });
    assert.equal(putOk.status, 200);
    const compOk = await inspector.fetch(`/evidence/${mainEvidenceId}/complete`, {});
    assert.equal(compOk.quarantined, false);
    assert.equal(compOk.evidence.original_ready, true);
    assert.equal(compOk.evidence.processing_state, "processing");

    // Process async outbox jobs -> generates normalized + thumbnail child objects while keeping original SHA-256 unchanged
    while (await workOnce()) {}

    const detail = await inspector.fetch(`/evidence/${mainEvidenceId}`);
    assert.equal(detail.evidence.processing_state, "ready");
    assert.equal(detail.evidence.derivatives_ready, true);
    assert.equal(detail.evidence.original_sha256, photoSha);
    assert.equal(detail.variants.length, 2);
    assert.deepEqual(detail.variants.map((v: { variant_kind: string }) => v.variant_kind), ["normalized", "thumbnail"]);

    // Verify S3 original bytes hash still strictly equals photoSha (G08)
    const origRow = await pool.query<{ object_key: string }>("select object_key from storage_objects where id=$1", [detail.evidence.original_object_id]);
    const storedOrig = s3Map.get(`${BUCKET}/${origRow.rows[0].object_key}`);
    assert(storedOrig);
    assert.equal(createHash("sha256").update(storedOrig.body).digest("hex"), photoSha);
  });

  await t.test("E03: Truthful Time, Clock Skew Flagging, Video Duration & Import Provenance Restrictions (CAP21)", async () => {
    const futureSkewed = new Date(Date.now() + 600_000).toISOString();
    const skewedAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-skewed",
      source_type: "mobile_local_capture",
      evidence_purpose: "receiving_outer",
      package_id: samplePkgId,
      device_id: deviceId,
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: futureSkewed,
      time_source: "device_wall_clock",
      device_timezone: "Asia/Shanghai",
      device_clock_offset_ms: 600_000,
    }, "POST", 201);
    assert.equal(skewedAuth.evidence.clock_skew_flagged, true);
    assert.equal(skewedAuth.evidence.source_trust_level, "device_clock_skewed");

    // Online capture with unknown capture time must NOT receive system_captured trust level
    const noTimeLive = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-notime-live",
      source_type: "mobile_local_capture",
      evidence_purpose: "receiving_outer",
      package_id: samplePkgId,
      device_id: deviceId,
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: null,
      time_source: "unknown",
      time_unknown_reason: "Camera clock battery depleted",
    }, "POST", 201);
    assert.equal(noTimeLive.evidence.source_trust_level, "legacy_unknown");

    // Gallery import cannot spoof device_wall_clock
    await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-bad-import",
      source_type: "gallery_file_import",
      evidence_purpose: "inspection_shot",
      inspection_task_id: taskRow.id,
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_wall_clock",
    }, "POST", 422);

    // Unknown time import allowed with explicit reason, clears device_id
    const impAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-import-unknown",
      source_type: "gallery_file_import",
      evidence_purpose: "inspection_shot",
      inspection_task_id: taskRow.id,
      device_id: deviceId,
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: null,
      time_source: "unknown",
      time_unknown_reason: "EXIF stripped by sender chat app",
    }, "POST", 201);
    assert.equal(impAuth.evidence.device_id, null);
    assert.equal(impAuth.evidence.source_trust_level, "legacy_unknown");
    assert.equal(impAuth.evidence.actual_captured_at, null);

    // Video capture records start/end/duration separately
    const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), Buffer.alloc(64, 0x22)]);
    const mp4Sha = createHash("sha256").update(fakeMp4).digest("hex");
    const vidAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-video-001",
      command_id: frozenCmdId,
      source_type: "pc_remote_mobile",
      evidence_purpose: "inspection_shot",
      media_kind: "video",
      declared_mime: "video/mp4",
      size_bytes: fakeMp4.length,
      expected_sha256: mp4Sha,
      actual_captured_at: new Date().toISOString(),
      video_started_at: new Date(Date.now() - 14_250).toISOString(),
      video_ended_at: new Date().toISOString(),
      actual_duration_ms: 14_250,
      time_source: "device_monotonic_calibrated",
    }, "POST", 201);
    await fetch(vidAuth.storage.upload.url, { method: "PUT", headers: { "content-type": "video/mp4" }, body: new Uint8Array(fakeMp4) });
    await inspector.fetch(`/evidence/${vidAuth.evidence.id}/complete`, {});
    while (await workOnce()) {}
    const vidDetail = await inspector.fetch(`/evidence/${vidAuth.evidence.id}`);
    assert.equal(vidDetail.evidence.processing_state, "ready");
    assert.equal(vidDetail.evidence.actual_duration_ms, 14_250);
  });

  await t.test("E04: Late Post-Handover Upload Quarantine & DB Immutability Triggers (CAP07 / §115.7)", async () => {
    const lateCmd = await inspector.fetch("/staff/capture/commands", {
      command_key: "cmd-w15-late-001",
      source_type: "pc_remote_mobile",
      capture_mode: "photo",
      evidence_purpose: "inspection_shot",
      work_item_id: workItemId,
      warehouse_item_id: itemAId,
      device_id: deviceId,
      control_lease_id: leaseId,
    }, "POST", 201);
    const lateUpload = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-late-001",
      command_id: lateCmd.command.id,
      source_type: "pc_remote_mobile",
      evidence_purpose: "inspection_shot",
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_monotonic_calibrated",
    }, "POST", 201);
    lateEvidenceId = lateUpload.evidence.id;

    // Task execution generation advances (handover / reassign occurred) BEFORE upload finishes
    await pool.query("update dispatch_work_items set execution_generation = execution_generation + 1 where id = $1", [workItemId]);
    await fetch(lateUpload.storage.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(photoBytes) });

    const lateComp = await inspector.fetch(`/evidence/${lateEvidenceId}/complete`, {}, "POST", 202);
    assert.equal(lateComp.quarantined, true);
    assert.equal(lateComp.late_quarantined, true);
    assert.equal(lateComp.evidence.original_ready, true);
    assert.equal(lateComp.evidence.processing_state, "quarantined");
    assert.equal(lateComp.evidence.capture_responsible_user_id, inspUser.id);

    // Direct SQL overwrite of original author or digest rejected by DB trigger
    await assert.rejects(
      () => pool.query("update media_evidence_records set capture_responsible_user_id = null where id = $1", [lateEvidenceId]),
      (e: unknown) => e instanceof Error && e.message.includes("EVIDENCE_ORIGIN_IMMUTABLE"),
    );
    await assert.rejects(
      () => pool.query("delete from media_evidence_records where id = $1", [lateEvidenceId]),
      (e: unknown) => e instanceof Error && e.message.includes("EVIDENCE_IMMUTABLE_NO_DELETE"),
    );

    // Reviewer accepts quarantined late file preserving original author
    const resolved = await reviewer.fetch(`/staff/evidence/${lateEvidenceId}/resolve-quarantine`, {
      decision: "accept_preserving_author",
      note: "Verified photo belongs to inspected item prior to handover",
    });
    assert.equal(resolved.evidence.capture_responsible_user_id, inspUser.id);
    while (await workOnce()) {}
    const afterDetail = await reviewer.fetch(`/evidence/${lateEvidenceId}`);
    assert.equal(afterDetail.evidence.processing_state, "ready");
    assert.equal(afterDetail.evidence.capture_responsible_user_id, inspUser.id);
  });

  await t.test("E05: Purpose-Scoped Bindings, Cross-Tenant Guard & Customer Redaction (CAP23 / §115.9)", async () => {
    // 1. Unmatched package upload succeeds without order/task and supports post_bind_owner
    const umAuth = await receiver.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-unmatched",
      source_type: "mobile_local_capture",
      evidence_purpose: "unmatched_package",
      package_id: unmatchedPkgId,
      device_id: deviceId,
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_wall_clock",
    }, "POST", 201);
    unmatchedEvidenceId = umAuth.evidence.id;
    await fetch(umAuth.storage.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(photoBytes) });
    await receiver.fetch(`/evidence/${unmatchedEvidenceId}/complete`, {});
    while (await workOnce()) {}

    await receiver.fetch(`/staff/evidence/${unmatchedEvidenceId}/links`, {
      entity_type: "order",
      entity_id: custOrg.id,
      link_role: "post_bind_owner",
      reason: "Customer verified waybill receipt",
    }, "POST", 201);

    // Cross-tenant link to Org B rejected with 403
    await receiver.fetch(`/staff/evidence/${unmatchedEvidenceId}/links`, {
      entity_type: "package",
      entity_id: orgBPkgId,
      link_role: "post_bind_owner",
    }, "POST", 403);

    // Device test photo stays non-business and cannot be cited or linked to any customer entity
    const dtAuth = await admin.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-device-test",
      source_type: "device_test",
      evidence_purpose: "device_test",
      device_id: deviceId,
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_monotonic_calibrated",
    }, "POST", 201);
    deviceTestEvidenceId = dtAuth.evidence.id;
    assert.equal(dtAuth.evidence.is_business_evidence, false);
    await fetch(dtAuth.storage.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(photoBytes) });
    await admin.fetch(`/evidence/${deviceTestEvidenceId}/complete`, {});
    while (await workOnce()) {}
    await admin.fetch(`/staff/evidence/${deviceTestEvidenceId}/links`, {
      entity_type: "report_version",
      entity_id: randomUUID(),
      link_role: "report_citation",
    }, "POST", 409);
    await admin.fetch(`/staff/evidence/${deviceTestEvidenceId}/links`, {
      entity_type: "order",
      entity_id: custOrg.id,
      link_role: "primary_capture",
    }, "POST", 409);

    // Security regression: Customer IDOR via inspection_task_id/command_id/device_id blocked with 403
    await customer.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-cust-idor",
      source_type: "customer_attachment",
      evidence_purpose: "customer_reference",
      inspection_task_id: taskRow.id,
      media_kind: "document",
      declared_mime: "application/pdf",
      size_bytes: 128,
      expected_sha256: photoSha,
      actual_captured_at: null,
      time_source: "user_declared",
      time_unknown_reason: "test",
    }, "POST", 403);

    // Customer & non-admin inspector cannot invoke cleanup-expired
    await customer.fetch("/staff/evidence/cleanup-expired", { min_age_minutes: 1 }, "POST", 403);
    await inspector.fetch("/staff/evidence/cleanup-expired", { min_age_minutes: 1 }, "POST", 403);

    // 3. Comparison group multi-member single upload & customer redacted view
    const cmpCmd = await inspector.fetch("/staff/capture/commands", {
      command_key: "cmd-w15-cmp-001",
      source_type: "pc_remote_mobile",
      capture_mode: "photo",
      evidence_purpose: "comparison_group",
      order_id: custOrg.id,
      comparison_member_ids: [itemAId, itemBId],
      device_id: deviceId,
      control_lease_id: leaseId,
    }, "POST", 201);
    const cmpAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-cmp-001",
      command_id: cmpCmd.command.id,
      source_type: "pc_remote_mobile",
      evidence_purpose: "comparison_group",
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_monotonic_calibrated",
    }, "POST", 201);
    await fetch(cmpAuth.storage.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(photoBytes) });
    await inspector.fetch(`/evidence/${cmpAuth.evidence.id}/complete`, {});
    while (await workOnce()) {}

    const custView = await customer.fetch(`/evidence/${mainEvidenceId}`);
    assert.equal(custView.evidence.capture_responsible_user_id, undefined);
    assert.equal(custView.evidence.device_id, undefined);
    assert.equal(custView.evidence.workstation_id, undefined);
    assert.equal(custView.evidence.original_sha256, photoSha);
    assert.equal(custView.variants.length, 2);

    // Customer cannot view device_test evidence
    await customer.fetch(`/evidence/${deviceTestEvidenceId}`, undefined, "GET", 404);
  });

  await t.test("E06: Worker Derivative Failure Retry (CAP09) & Safe Expired Cleanup (T37)", async () => {
    const retryCmd = await inspector.fetch("/staff/capture/commands", {
      command_key: "cmd-w15-retry-gen2",
      source_type: "pc_remote_mobile",
      capture_mode: "photo",
      evidence_purpose: "inspection_shot",
      work_item_id: workItemId,
      warehouse_item_id: itemAId,
      device_id: deviceId,
      control_lease_id: leaseId,
    }, "POST", 201);
    const retryAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-retry-job",
      command_id: retryCmd.command.id,
      source_type: "pc_remote_mobile",
      evidence_purpose: "inspection_shot",
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_monotonic_calibrated",
    }, "POST", 201);
    await fetch(retryAuth.storage.upload.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(photoBytes) });
    await inspector.fetch(`/evidence/${retryAuth.evidence.id}/complete`, {});

    failDerivativePutOnce = true;
    while (await workOnce()) {}

    const failedDetail = await inspector.fetch(`/evidence/${retryAuth.evidence.id}`);
    assert.equal(failedDetail.evidence.original_ready, true);
    assert.equal(failedDetail.evidence.processing_state, "failed");

    await inspector.fetch(`/evidence/${retryAuth.evidence.id}/retry-processing`, {});
    while (await workOnce()) {}
    const recoveredDetail = await inspector.fetch(`/evidence/${retryAuth.evidence.id}`);
    assert.equal(recoveredDetail.evidence.processing_state, "ready");
    assert.equal(recoveredDetail.evidence.derivatives_ready, true);

    // Create an abandoned expired upload >2 hours old -> safely cancelled without harming ready originals
    const staleAuth = await inspector.fetch("/evidence/uploads/authorize", {
      capture_key: "cap-w15-stale-orphan",
      source_type: "mobile_local_capture",
      evidence_purpose: "receiving_open",
      package_id: samplePkgId,
      device_id: deviceId,
      media_kind: "photo",
      declared_mime: "image/jpeg",
      size_bytes: photoBytes.length,
      expected_sha256: photoSha,
      actual_captured_at: new Date().toISOString(),
      time_source: "device_wall_clock",
    }, "POST", 201);
    staleEvidenceId = staleAuth.evidence.id;
    await pool.query("update media_evidence_records set created_at = now() - interval '3 hours' where id = $1", [staleEvidenceId]);
    await pool.query("update storage_upload_sessions set expires_at = now() - interval '2 hours' where object_id = $1", [
      staleAuth.evidence.original_object_id,
    ]);

    const cleanRes = await admin.fetch("/staff/evidence/cleanup-expired", { min_age_minutes: 60 });
    assert.ok(cleanRes.evidence_ids.includes(staleEvidenceId));

    const queue = await inspector.fetch("/staff/sync/queue?state=ready");
    assert.ok(queue.items.some((r: { id: string }) => r.id === mainEvidenceId));
    assert.equal((await inspector.fetch(`/evidence/${mainEvidenceId}`)).evidence.original_ready, true);
  });
});
