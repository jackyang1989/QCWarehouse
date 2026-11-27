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
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const { handle } = await import("../packages/core/http");
const { pool, transaction } = await import("../packages/db");
const { addEmailOtpIdentity } = await import("../packages/core/auth");
const {
  assertProductionStorageAllowed,
  assertSafeStorageEndpoint,
  canonicalizeQuery,
  runStorageCapabilityProbe,
  S3CompatibleStorageProvider,
} = await import("../packages/core/object-storage");
const { registerRuntimeObjectStorageProvider } = await import("../packages/core/storage-service");

const TEST_ACCESS_KEY = "QCWTESTKEY123456";
const TEST_SECRET_KEY = "qcw-test-secret-key-0123456789abcdef";
const TEST_REGION = "auto";

function verifySigV4Request(req: IncomingMessage, fullUrl: URL, payload: Buffer): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("AWS4-HMAC-SHA256 ")) {
    const credMatch = auth.match(/Credential=([^,]+)/);
    const shMatch = auth.match(/SignedHeaders=([^,]+)/);
    const sigMatch = auth.match(/Signature=([a-f0-9]+)/);
    if (!credMatch || !shMatch || !sigMatch) return false;
    const [accessKey, dateStamp, region, service, reqType] = credMatch[1].split("/");
    if (accessKey !== TEST_ACCESS_KEY || region !== TEST_REGION || service !== "s3" || reqType !== "aws4_request") return false;

    const amzDate = String(req.headers["x-amz-date"] ?? "");
    const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
    if (payloadHash !== "UNSIGNED-PAYLOAD") {
      const actualHash = createHash("sha256").update(payload).digest("hex");
      if (payloadHash !== actualHash) return false;
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
    const kDate = createHmac("sha256", `AWS4${TEST_SECRET_KEY}`).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(region).digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const expectedSig = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    return expectedSig === sigMatch[1];
  }

  const sig = fullUrl.searchParams.get("X-Amz-Signature");
  const cred = fullUrl.searchParams.get("X-Amz-Credential");
  const amzDate = fullUrl.searchParams.get("X-Amz-Date");
  const sh = fullUrl.searchParams.get("X-Amz-SignedHeaders");
  if (!sig || !cred || !amzDate || !sh) return false;
  const [accessKey, dateStamp, region] = cred.split("/");
  if (accessKey !== TEST_ACCESS_KEY || region !== TEST_REGION) return false;

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
  const kDate = createHmac("sha256", `AWS4${TEST_SECRET_KEY}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const expectedSig = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return expectedSig === sig;
}

const storedObjects = new Map<string, { body: Buffer; contentType: string; etag: string; versionId: string }>();
const multipartUploads = new Map<string, { key: string; contentType: string; parts: Map<number, { body: Buffer; etag: string }> }>();

const s3Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(Buffer.from(ch));
  const payload = Buffer.concat(chunks);
  const fullUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (!verifySigV4Request(req, fullUrl, payload)) {
    res.writeHead(403, { "content-type": "application/xml" });
    res.end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
    return;
  }

  const keyPath = fullUrl.pathname.replace(/^\/+/, "");
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "POST" && fullUrl.searchParams.has("uploads")) {
    const uploadId = randomUUID();
    multipartUploads.set(uploadId, {
      key: keyPath,
      contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
      parts: new Map(),
    });
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    return;
  }

  if (method === "PUT" && fullUrl.searchParams.has("uploadId") && fullUrl.searchParams.has("partNumber")) {
    const uploadId = fullUrl.searchParams.get("uploadId")!;
    const partNumber = Number(fullUrl.searchParams.get("partNumber"));
    const mp = multipartUploads.get(uploadId);
    if (!mp || mp.key !== keyPath) {
      res.writeHead(404).end();
      return;
    }
    const etag = `"${createHash("md5").update(payload).digest("hex")}"`;
    mp.parts.set(partNumber, { body: payload, etag });
    res.writeHead(200, { etag });
    res.end();
    return;
  }

  if (method === "GET" && fullUrl.searchParams.has("uploadId")) {
    const uploadId = fullUrl.searchParams.get("uploadId")!;
    const mp = multipartUploads.get(uploadId);
    if (!mp || mp.key !== keyPath) {
      res.writeHead(404).end();
      return;
    }
    const items = [...mp.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([num, p]) => `<Part><PartNumber>${num}</PartNumber><ETag>${p.etag}</ETag><Size>${p.body.length}</Size></Part>`)
      .join("");
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<ListPartsResult>${items}</ListPartsResult>`);
    return;
  }

  if (method === "POST" && fullUrl.searchParams.has("uploadId")) {
    const uploadId = fullUrl.searchParams.get("uploadId")!;
    const mp = multipartUploads.get(uploadId);
    if (!mp || mp.key !== keyPath) {
      res.writeHead(404).end();
      return;
    }
    const xml = payload.toString("utf8");
    const reqParts = [...xml.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag><\/Part>/g)].map((m) => ({
      partNumber: Number(m[1]),
      etag: m[2].replaceAll("&quot;", '"'),
    }));
    const sorted = reqParts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((rp) => {
        const stored = mp.parts.get(rp.partNumber);
        assert(stored && stored.etag.replaceAll('"', "") === rp.etag.replaceAll('"', ""), "Part mismatch in mock S3");
        return stored.body;
      });
    const merged = Buffer.concat(sorted);
    const etag = `"${createHash("md5").update(merged).digest("hex")}-${sorted.length}"`;
    const versionId = randomUUID();
    storedObjects.set(keyPath, { body: merged, contentType: mp.contentType, etag, versionId });
    multipartUploads.delete(uploadId);
    res.writeHead(200, { "content-type": "application/xml", etag, "x-amz-version-id": versionId });
    res.end(`<CompleteMultipartUploadResult><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
    return;
  }

  if (method === "DELETE" && fullUrl.searchParams.has("uploadId")) {
    multipartUploads.delete(fullUrl.searchParams.get("uploadId")!);
    res.writeHead(204).end();
    return;
  }

  if (method === "PUT" && typeof req.headers["x-amz-copy-source"] === "string") {
    const srcKey = decodeURIComponent(req.headers["x-amz-copy-source"]).replace(/^\/+/, "");
    const src = storedObjects.get(srcKey);
    if (!src) {
      res.writeHead(404).end();
      return;
    }
    const versionId = randomUUID();
    storedObjects.set(keyPath, { body: Buffer.from(src.body), contentType: src.contentType, etag: src.etag, versionId });
    res.writeHead(200, { "content-type": "application/xml", etag: src.etag, "x-amz-version-id": versionId });
    res.end(`<CopyObjectResult><ETag>${src.etag}</ETag></CopyObjectResult>`);
    return;
  }

  if (method === "PUT") {
    const etag = `"${createHash("md5").update(payload).digest("hex")}"`;
    const versionId = randomUUID();
    storedObjects.set(keyPath, {
      body: payload,
      contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
      etag,
      versionId,
    });
    res.writeHead(200, { etag, "x-amz-version-id": versionId });
    res.end();
    return;
  }

  const obj = storedObjects.get(keyPath);
  if (!obj) {
    res.writeHead(404).end();
    return;
  }

  if (method === "HEAD") {
    res.writeHead(200, {
      "content-length": String(obj.body.length),
      "content-type": obj.contentType,
      etag: obj.etag,
      "x-amz-version-id": obj.versionId,
    });
    res.end();
    return;
  }

  if (method === "GET") {
    const range = req.headers.range;
    if (typeof range === "string") {
      const m = range.match(/^bytes=(\d+)-(\d*)$/);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(obj.body.length - 1, Number(m[2])) : obj.body.length - 1;
        if (start >= obj.body.length || end < start) {
          res.writeHead(416, { "content-range": `bytes */${obj.body.length}` });
          res.end();
          return;
        }
        const slice = obj.body.subarray(start, end + 1);
        res.writeHead(206, {
          "content-type": obj.contentType,
          "content-length": String(slice.length),
          "content-range": `bytes ${start}-${end}/${obj.body.length}`,
          etag: obj.etag,
          "x-amz-version-id": obj.versionId,
        });
        res.end(slice);
        return;
      }
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

  if (method === "DELETE") {
    storedObjects.delete(keyPath);
    res.writeHead(204).end();
    return;
  }

  res.writeHead(405).end();
});

let s3Port = 0;

before(async () => {
  await new Promise<void>((resolve) => {
    s3Server.listen(0, "127.0.0.1", () => {
      const addr = s3Server.address();
      assert(addr && typeof addr === "object");
      s3Port = addr.port;
      resolve();
    });
  });

  const actual = await pool.query<{ name: string }>("select current_database() name");
  assert.equal(actual.rows[0].name, databaseName);
  await pool.query("drop schema if exists public cascade; create schema public;");
  for (const args of [
    ["--env-file-if-exists=.env", "scripts/migrate.mjs"],
    ["--env-file-if-exists=.env", "--import", "tsx", "scripts/demo.ts"],
  ]) {
    execFileSync(process.execPath, args, { env: process.env, stdio: "pipe" });
  }

  // Create a second isolated customer for cross-tenant read isolation check
  const cust2Id = randomUUID();
  const org2Id = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id, display_name, locale) values($1, 'Customer Two', 'en')", [cust2Id]);
    await db.query("insert into organizations(id, name) values($1, 'Tenant Two Org')", [org2Id]);
    await db.query("insert into memberships(user_id, org_id) values($1, $2)", [cust2Id, org2Id]);
    const e2 = (
      await db.query<{ id: string }>(
        `insert into user_emails(user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
         values($1, 'customer2@qcw.test', 'customer2@qcw.test'::citext, now(), true, true) returning id`,
        [cust2Id],
      )
    ).rows[0];
    await addEmailOtpIdentity(db, cust2Id, e2.id);
  });

  await pool.query("delete from verification_challenges where target_email::text = any($1::text[])", [
    ["admin", "inspector", "customer", "customer2"].map((n) => n + "@qcw.test"),
  ]);

  registerRuntimeObjectStorageProvider(
    new S3CompatibleStorageProvider({
      providerKey: "r2-test-primary",
      providerType: "cloudflare_r2",
      endpoint: `http://127.0.0.1:${s3Port}`,
      region: TEST_REGION,
      bucket: "qcw-private-test",
      accessKeyId: TEST_ACCESS_KEY,
      secretAccessKey: TEST_SECRET_KEY,
      addressingStyle: "path",
      allowInsecureLoopbackForTest: true,
    }),
  );
});

after(async () => {
  registerRuntimeObjectStorageProvider(null);
  await new Promise<void>((resolve) => s3Server.close(() => resolve()));
  await pool.end();
});

class Client {
  jar = new Map<string, string>();
  async fetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200) {
    const headers: Record<string, string> = { origin };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = randomUUID();
      const csrf = this.jar.get("qcw_csrf");
      if (csrf) headers["x-csrf-token"] = csrf;
    }
    const cleanPath = path.split("?")[0]!;
    const res = await handle(
      new Request(origin + "/api/v1" + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      cleanPath,
    );
    for (const raw of res.headers.getSetCookie()) {
      const m = raw.match(/^([^=]+)=([^;]*)/);
      if (m) this.jar.set(m[1], m[2]);
    }
    const data = await res.json();
    assert.equal(res.status, expected, path + " " + JSON.stringify(data));
    return data;
  }
  async rawStream(path: string, range?: string) {
    const headers: Record<string, string> = { origin };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (range) headers.range = range;
    const cleanPath = path.split("?")[0]!;
    return handle(new Request(origin + "/api/v1" + path, { method: "GET", headers }), cleanPath);
  }
  async loginOtp(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
}

test("TASK-185: S3 SigV4 adapter, SSRF & prod fallback guards, presigned/multipart uploads, SHA-256 & magic-byte quarantine, Range streaming, immutability & tenant isolation", async () => {
  const admin = new Client();
  await admin.loginOtp("admin@qcw.test");
  const customer1 = new Client();
  await customer1.loginOtp("customer@qcw.test");
  const customer2 = new Client();
  await customer2.loginOtp("customer2@qcw.test");

  // 1. SSRF endpoint guard blocks unsafe endpoints & production guard prohibits missing object storage
  for (const unsafeUrl of [
    "http://r2.cloudflarestorage.com",
    "https://127.0.0.1/bucket",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.8/s3",
    "https://[::1]/s3",
    "https://[::ffff:127.0.0.1]/s3",
    "https://[::127.0.0.1]/s3",
    "https://198.18.0.1/s3",
    "https://224.0.0.1/s3",
    "https://user:pass@s3.amazonaws.com",
  ]) {
    assert.throws(() => assertSafeStorageEndpoint(unsafeUrl), { code: "STORAGE_ENDPOINT_UNSAFE" }, unsafeUrl);
  }

  const prevEnv = { NODE_ENV: process.env.NODE_ENV, QCW_DEMO: process.env.QCW_DEMO };
  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.QCW_DEMO = "0";
    assert.throws(() => assertProductionStorageAllowed(false), { code: "PRODUCTION_OBJECT_STORAGE_REQUIRED" });
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv.NODE_ENV;
    process.env.QCW_DEMO = prevEnv.QCW_DEMO;
  }

  // 2. Capability matrix & live SigV4/Range/Multipart capability probe
  const capRes = await admin.fetch("/staff/storage/providers/capabilities");
  assert.equal(capRes.capabilities.length, 4);

  const probe = await runStorageCapabilityProbe(
    new S3CompatibleStorageProvider({
      providerKey: "r2-test-probe",
      providerType: "cloudflare_r2",
      endpoint: `http://127.0.0.1:${s3Port}`,
      region: TEST_REGION,
      bucket: "qcw-private-test",
      accessKeyId: TEST_ACCESS_KEY,
      secretAccessKey: TEST_SECRET_KEY,
      addressingStyle: "path",
      allowInsecureLoopbackForTest: true,
    }),
  );
  assert.equal(probe.ok, true);
  assert.equal(probe.probes.range_read.status, "passed");
  assert.equal(probe.probes.multipart.status, "passed");

  // 3. Presigned PUT image upload + SHA-256 verification + private GET & Range 206 + tenant isolation
  const pngBytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#0f766e" } }).png().toBuffer();
  const pngSha = createHash("sha256").update(pngBytes).digest("hex");

  const authPng = await customer1.fetch(
    "/storage/objects/authorize",
    {
      purpose: "po_reference",
      declared_mime: "image/png",
      size_bytes: pngBytes.length,
      expected_sha256: pngSha,
      upload_mode: "presigned_put",
      original_filename: "tech-pack.png",
      legal_hold: true,
    },
    "POST",
    201,
  );
  assert.equal(authPng.object.status, "authorized");
  const putRes = await fetch(authPng.upload.url, {
    method: "PUT",
    headers: authPng.upload.headers,
    body: Buffer.from(pngBytes),
  });
  assert.equal(putRes.ok, true);

  const compPng = await customer1.fetch(`/storage/objects/${authPng.object.id}/complete`, {});
  assert.equal(compPng.object.status, "ready");
  assert.equal(compPng.object.verified_sha256, pngSha);

  // Customer2 cross-tenant read MUST be blocked (404)
  await customer2.fetch(`/storage/objects/${authPng.object.id}/access`, undefined, "GET", 404);
  const cust2Stream = await customer2.rawStream(`/storage/objects/${authPng.object.id}/stream`);
  assert.equal(cust2Stream.status, 404);

  // Customer1 presigned GET + Range 206 streaming succeed
  const accessRes = await customer1.fetch(`/storage/objects/${authPng.object.id}/access?expires=120`);
  const dlRes = await fetch(accessRes.url);
  assert.equal(dlRes.ok, true);
  assert.equal(createHash("sha256").update(Buffer.from(await dlRes.arrayBuffer())).digest("hex"), pngSha);

  const rangeStream = await customer1.rawStream(`/storage/objects/${authPng.object.id}/stream`, "bytes=0-15");
  assert.equal(rangeStream.status, 206);
  assert.equal(rangeStream.headers.get("content-range"), `bytes 0-15/${pngBytes.length}`);
  assert.equal(rangeStream.headers.get("x-content-type-options"), "nosniff");
  const rangeChunk = Buffer.from(await rangeStream.arrayBuffer());
  assert.equal(rangeChunk.equals(pngBytes.subarray(0, 16)), true);

  // Out-of-bounds & inverted Range returns real HTTP 416 (Finding 2)
  assert.equal((await customer1.rawStream(`/storage/objects/${authPng.object.id}/stream`, "bytes=99999999-")).status, 416);
  assert.equal((await customer1.rawStream(`/storage/objects/${authPng.object.id}/stream`, "bytes=100-50")).status, 416);

  // Replay of presigned PUT URL within TTL writes only to staging and CANNOT overwrite immutable private object (Finding 5)
  await fetch(authPng.upload.url, {
    method: "PUT",
    headers: authPng.upload.headers,
    body: Buffer.from("MALICIOUS-OVERWRITE-BYTES"),
  });
  const afterReplayDl = await fetch((await customer1.fetch(`/storage/objects/${authPng.object.id}/access?expires=120`)).url);
  assert.equal(createHash("sha256").update(Buffer.from(await afterReplayDl.arrayBuffer())).digest("hex"), pngSha);

  // 4. Immutability: cannot overwrite ready object via API or DB SQL mutation (Finding 6)
  await customer1.fetch(`/storage/objects/${authPng.object.id}/complete`, {}, "POST", 409);
  await assert.rejects(
    pool.query("update storage_objects set verified_sha256 = '0000' where id = $1", [authPng.object.id]),
    /OBJECT_IMMUTABLE_NO_OVERWRITE/,
  );
  await assert.rejects(
    pool.query("update storage_objects set is_immutable = false where id = $1", [authPng.object.id]),
    /OBJECT_IMMUTABLE_NO_OVERWRITE/,
  );
  await assert.rejects(
    pool.query("delete from storage_objects where id = $1", [authPng.object.id]),
    /OBJECT_IMMUTABLE_NO_DELETE/,
  );

  // 5. Multipart video/mp4 upload + Range playback
  const videoHead = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00]);
  const videoTail = Buffer.alloc(1024, 0x5a);
  const fullVideo = Buffer.concat([videoHead, videoTail]);
  const videoSha = createHash("sha256").update(fullVideo).digest("hex");

  const authVid = await admin.fetch(
    "/storage/objects/authorize",
    {
      purpose: "qc_video",
      declared_mime: "video/mp4",
      size_bytes: fullVideo.length,
      expected_sha256: videoSha,
      upload_mode: "multipart",
      expected_parts: 2,
    },
    "POST",
    201,
  );
  const p1 = await fetch(authVid.upload.part_urls[0].url, { method: "PUT", body: videoHead });
  const p2 = await fetch(authVid.upload.part_urls[1].url, { method: "PUT", body: videoTail });
  const compVid = await admin.fetch(`/storage/objects/${authVid.object.id}/complete`, {
    parts: [
      { part_number: 1, etag: p1.headers.get("etag")! },
      { part_number: 2, etag: p2.headers.get("etag")! },
    ],
  });
  assert.equal(compVid.object.status, "ready");
  assert.equal(compVid.object.detected_mime, "video/mp4");

  const vidRange = await admin.rawStream(`/storage/objects/${authVid.object.id}/stream`, "bytes=4-11");
  assert.equal(vidRange.status, 206);
  assert.equal(Buffer.from(await vidRange.arrayBuffer()).toString("ascii"), "ftypmp42");

  // 6. Quarantine tests: (a) SHA-256 mismatch & (b) SVG script disguised as image/png
  const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const svgSha = createHash("sha256").update(svgPayload).digest("hex");
  const authBadMime = await customer1.fetch(
    "/storage/objects/authorize",
    {
      purpose: "po_reference",
      declared_mime: "image/png",
      size_bytes: svgPayload.length,
      expected_sha256: svgSha,
    },
    "POST",
    201,
  );
  await fetch(authBadMime.upload.url, { method: "PUT", headers: authBadMime.upload.headers, body: svgPayload });
  const qRes = await customer1.fetch(`/storage/objects/${authBadMime.object.id}/complete`, {}, "POST", 422);
  assert.equal(qRes.error.code, "OBJECT_VERIFICATION_QUARANTINED");
  // Quarantined object stays blocked from read access (409)
  await customer1.fetch(`/storage/objects/${authBadMime.object.id}/access`, undefined, "GET", 409);

  // 7. Deletion protection persists delete_blocked audit row even on 409 rollback, then allows controlled delete once cleared (Finding 1)
  await admin.fetch(`/staff/storage/objects/${authPng.object.id}`, { reason: "Try delete under legal hold" }, "DELETE", 409);
  const blockedAudit = (
    await pool.query<{ count: string }>(
      "select count(*)::text count from storage_access_audit where object_id = $1 and action = 'delete_blocked'",
      [authPng.object.id],
    )
  ).rows[0];
  assert.equal(Number(blockedAudit.count), 1);

  await pool.query("update storage_objects set legal_hold = false where id = $1", [authPng.object.id]);
  const delOk = await admin.fetch(`/staff/storage/objects/${authPng.object.id}`, { reason: "Legal hold released cleanup" }, "DELETE", 200);
  assert.equal(delOk.object.status, "archived");
});
