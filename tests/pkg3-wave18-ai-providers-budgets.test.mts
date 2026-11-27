import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
const appOrigin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;

const { handle } = await import("../packages/core/http");
const { pool, transaction } = await import("../packages/db");
const {
  assertNoBusinessToolsInPayload,
  registerTestAllowedAiEndpointOrigin,
} = await import("../packages/core/ai-adapter");
const { reserveAiBudgetAtomic } = await import("../packages/core/ai-service");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type MockMode =
  | "ok"
  | "compatible_no_models"
  | "redirect_302"
  | "auth_401"
  | "rate_429"
  | "refused"
  | "truncated"
  | "malformed_json"
  | "dropped_placeholder"
  | "slow_timeout";

let mockMode: MockMode = "ok";
let mockUpstreamCalls = 0;

const aiServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  mockUpstreamCalls += 1;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const body = rawBody ? (JSON.parse(rawBody) as Record<string, any>) : {};

  if (mockMode === "redirect_302") {
    res.writeHead(302, { location: "https://evil.example/steal-key" });
    res.end();
    return;
  }
  if (mockMode === "auth_401") {
    res.writeHead(401, { "content-type": "application/json", "x-request-id": "req_auth_fail" });
    res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    return;
  }
  if (mockMode === "rate_429") {
    res.writeHead(429, { "content-type": "application/json", "x-request-id": "req_429" });
    res.end(JSON.stringify({ error: { message: "Rate limit reached" } }));
    return;
  }
  if (mockMode === "slow_timeout") {
    await new Promise((r) => setTimeout(r, 1300));
    if (!res.writableEnded) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }
    return;
  }

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    if (mockMode === "compatible_no_models") {
      res.writeHead(404, { "content-type": "application/json", "x-request-id": "req_nomodels" });
      res.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_models_ok" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "gpt-4o-mini", owned_by: "openai" },
          { id: "gpt-4.1-mini", owned_by: "openai" },
        ],
      }),
    );
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/responses")) {
    const outPayload = {
      items: [
        {
          field_id: "synthetic_1",
          target_locale: "zh-CN",
          translated_text:
            mockMode === "dropped_placeholder"
              ? "腋下缝线下移 2.5 cm 平铺量测胸宽，缝线未断裂。"
              : "量测样品 {sample_code} 腋下缝线下移 2.5 cm 平铺胸宽，缝线未断裂。",
          status: "translated",
          warnings: [],
        },
      ],
    };

    if (mockMode === "refused") {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_refuse" });
      res.end(
        JSON.stringify({
          id: "resp_refuse",
          model: "gpt-4o-mini-2024-07-18",
          output: [{ content: [{ type: "refusal", refusal: "Refused by safety policy." }] }],
          usage: { input_tokens: 40, output_tokens: 12 },
        }),
      );
      return;
    }
    if (mockMode === "truncated") {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_trunc" });
      res.end(
        JSON.stringify({
          id: "resp_trunc",
          model: "gpt-4o-mini-2024-07-18",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ content: [{ type: "output_text", text: "{\"items\":" }] }],
          usage: { input_tokens: 40, output_tokens: 100 },
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_resp_ok" });
    res.end(
      JSON.stringify({
        id: "resp_123",
        model: `${String(body.model ?? "gpt-4o-mini")}-2025-04-14`,
        status: "completed",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: mockMode === "malformed_json" ? "{bad json" : JSON.stringify(outPayload),
              },
            ],
          },
        ],
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          input_tokens_details: { cached_tokens: 20 },
        },
      }),
    );
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    const outPayload = {
      items: [
        {
          field_id: "synthetic_1",
          target_locale: "zh-CN",
          translated_text: "兼容模型译文：量测样品 {sample_code} 平铺胸宽。",
          status: "translated",
          warnings: [],
        },
      ],
    };
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_chat_ok" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_123",
        model: String(body.model ?? "qwen2.5-72b-instruct"),
        choices: [
          {
            index: 0,
            finish_reason: mockMode === "refused" ? "content_filter" : mockMode === "truncated" ? "length" : "stop",
            message: {
              role: "assistant",
              content: mockMode === "malformed_json" ? "not json" : JSON.stringify(outPayload),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 35 },
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end();
});

class Client {
  private jar = new Map<string, string>();
  async fetch(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    expected = 200,
    key = randomUUID(),
  ) {
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
    assert.equal(
      res.status,
      expected,
      `${method} ${path} -> expected ${expected}, got ${res.status}: ${JSON.stringify(data)}`,
    );
    return data;
  }
  async loginWithMfa(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    const out = await this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
    const cookie = this.jar.get("session");
    if (cookie) {
      await pool.query("update sessions set mfa_at = now() where token_hash = $1", [sha256(cookie)]);
    }
    return out;
  }
  getCookie(name: string) {
    return this.jar.get(name);
  }
}

let aiOrigin = "";

before(async () => {
  await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", resolve));
  const addr = aiServer.address();
  assert(addr && typeof addr === "object");
  aiOrigin = `http://127.0.0.1:${addr.port}`;
  registerTestAllowedAiEndpointOrigin(aiOrigin);

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

  // Create second super_admin for SoD approval tests
  const admin2Id = randomUUID();
  const admin2EmailId = randomUUID();
  await pool.query("insert into users(id, display_name, status) values($1, 'Second Super Admin', 'active')", [
    admin2Id,
  ]);
  await pool.query(
    "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
    [admin2EmailId, admin2Id, "admin2.ai@qcw.test", "admin2.ai@qcw.test"],
  );
  await pool.query(
    "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
    [admin2Id, admin2EmailId],
  );
  await pool.query("insert into staff_roles(user_id, role) values($1, 'super_admin')", [admin2Id]);
  await pool.query(
    "insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status) values($1, 'EMP-AI2', 'admin2.ai@qcw.test', 'active', 'active')",
    [admin2Id],
  );
});

after(async () => {
  registerTestAllowedAiEndpointOrigin(null);
  await new Promise<void>((resolve) => aiServer.close(() => resolve()));
  await pool.end();
});

test("PKG-3 Wave 18 (TASK-191): AI providers, encrypted secrets, capability probes, SoD, SSRF & atomic budget ledger", async (suite) => {
  const admin1 = new Client();
  await admin1.loginWithMfa("admin@qcw.test");
  const admin2 = new Client();
  await admin2.loginWithMfa("admin2.ai@qcw.test");
  const finance = new Client();
  await finance.loginWithMfa("finance@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const inspector = new Client();
  await inspector.loginWithMfa("inspector@qcw.test");
  const receiving = new Client();
  await receiving.loginWithMfa("receiving@qcw.test");
  const customer = new Client();
  await customer.loginWithMfa("customer@qcw.test");

  await suite.test("A01: SSRF, non-HTTPS, official host pin, capability sandbox, 302 redirect & secret rotation hygiene", async () => {
    // Reject bad URLs, non-official openai host, incompatible responses proto, and forbidden business tool capability
    const badPayloads = [
      {
        instance_key: "bad-http",
        display_name: "Bad HTTP",
        adapter_type: "openai_compatible",
        base_url: "http://evil.example.com/v1",
        expectedCode: "AI_ENDPOINT_UNSAFE",
        expectedStatus: 422,
      },
      {
        instance_key: "bad-metadata",
        display_name: "Bad Metadata",
        adapter_type: "openai_compatible",
        base_url: "https://169.254.169.254/latest/meta-data",
        expectedCode: "AI_ENDPOINT_UNSAFE",
        expectedStatus: 422,
      },
      {
        instance_key: "bad-official-host",
        display_name: "Spoofed Official",
        adapter_type: "openai_official",
        base_url: "https://fake-openai.example.com/v1",
        expectedCode: "AI_ENDPOINT_UNSAFE",
        expectedStatus: 422,
      },
      {
        instance_key: "bad-compat-proto",
        display_name: "Bad Compat Proto",
        adapter_type: "openai_compatible",
        api_protocol: "openai_responses",
        base_url: `${aiOrigin}/v1`,
        expectedCode: "AI_PROTOCOL_UNSUPPORTED",
        expectedStatus: 422,
      },
      {
        instance_key: "bad-tool-cap",
        display_name: "Tool Grant Attempt",
        adapter_type: "openai_compatible",
        base_url: `${aiOrigin}/v1`,
        requested_capabilities: ["language_translation_only", "business_db_write"],
        expectedCode: "AI_BUSINESS_TOOL_FORBIDDEN",
        expectedStatus: 403,
      },
    ];

    for (const p of badPayloads) {
      const res = await admin1.fetch(
        "/staff/admin/ai/instances",
        {
          instance_key: p.instance_key,
          display_name: p.display_name,
          adapter_type: p.adapter_type,
          api_protocol: p.api_protocol,
          environment: "test",
          base_url: p.base_url,
          data_region_policy: "US No-Training",
          allowed_purposes: ["KNOWLEDGE_TRANSLATION_DRAFT"],
          requested_capabilities: p.requested_capabilities ?? ["language_translation_only"],
        },
        "POST",
        p.expectedStatus,
      );
      assert.equal(res.error.code, p.expectedCode);
    }

    assert.throws(
      () => assertNoBusinessToolsInPayload({ model: "gpt-4o-mini", tools: [{ type: "function" }] }),
      (err: any) => err?.code === "AI_BUSINESS_TOOL_FORBIDDEN" && err?.status === 403,
    );

    // Probing without secret fails honestly (409 AI_SECRET_MISSING), then 302 redirect is rejected
    const created = await admin1.fetch(
      "/staff/admin/ai/instances",
      {
        instance_key: "redirect-probe-inst",
        display_name: "Redirect Test",
        adapter_type: "openai_compatible",
        api_protocol: "openai_chat_completions",
        environment: "test",
        base_url: `${aiOrigin}/v1`,
        data_region_policy: "CN Controlled",
        allowed_purposes: ["KNOWLEDGE_TRANSLATION_DRAFT"],
      },
      "POST",
      201,
    );
    const redirId = created.instance.id as string;
    assert.equal(created.instance.last_health_status, "unconfigured");

    const noKeyProbe = await admin1.fetch(`/staff/admin/ai/instances/${redirId}/probe`, {}, "POST", 409);
    assert.equal(noKeyProbe.error.code, "AI_SECRET_MISSING");

    const secretRaw = "sk-test-super-secret-value-99887766";
    const secSaved = await admin1.fetch(
      `/staff/admin/ai/instances/${redirId}/secrets`,
      { secret_name: "api_key", secret_value: secretRaw },
      "POST",
      201,
    );
    assert.doesNotMatch(JSON.stringify(secSaved), /super-secret-value/);

    const ov = await admin1.fetch("/staff/admin/ai/overview", undefined, "GET", 200);
    assert.doesNotMatch(JSON.stringify(ov), /super-secret-value/);

    mockMode = "redirect_302";
    const redirRes = await admin1.fetch(`/staff/admin/ai/instances/${redirId}/probe`, {}, "POST", 422);
    assert.equal(redirRes.error.code, "AI_REDIRECT_FORBIDDEN");
    mockMode = "ok";
  });

  let officialModelId = "";
  let compatInstId = "";
  let compatModelId = "";

  await suite.test("A02: OpenAI Official + Compatible lifecycle, manual model fallback, immutable rate versions, MFA & SoD", async () => {
    // MFA required on secret save
    const admin1SessionHash = sha256(admin1.getCookie("session")!);
    await pool.query("update sessions set mfa_at = null where token_hash = $1", [admin1SessionHash]);

    const official = await admin1.fetch(
      "/staff/admin/ai/instances",
      {
        instance_key: "openai-official-prod-1",
        display_name: "OpenAI Commercial Prod",
        adapter_type: "openai_official",
        api_protocol: "openai_responses",
        environment: "production",
        base_url: `${aiOrigin}/v1`,
        data_region_policy: "US Commercial ZDR Eligible",
        allowed_purposes: ["KNOWLEDGE_TRANSLATION_DRAFT", "REPORT_TEXT_LOCALIZE"],
        daily_budget_cents: 500,
        monthly_budget_cents: 5000,
      },
      "POST",
      201,
    );
    const officialId = official.instance.id as string;

    const mfaRequired = await admin1.fetch(
      `/staff/admin/ai/instances/${officialId}/secrets`,
      { secret_name: "api_key", secret_value: "sk-live-test-key-abcdef123456" },
      "POST",
      403,
    );
    assert.equal(mfaRequired.error.code, "STAFF_REAUTH_REQUIRED");
    await pool.query("update sessions set mfa_at = now() where token_hash = $1", [admin1SessionHash]);

    await admin1.fetch(
      `/staff/admin/ai/instances/${officialId}/secrets`,
      { secret_name: "api_key", secret_value: "sk-live-test-key-abcdef123456" },
      "POST",
      201,
    );

    const probed = await admin1.fetch(`/staff/admin/ai/instances/${officialId}/probe`, {}, "POST", 200);
    assert.equal(probed.instance.status, "tested");
    assert.equal(probed.instance.last_health_status, "verified");

    // Self-approval blocked (SoD); admin2 approves cleanly
    const selfApprove = await admin1.fetch(`/staff/admin/ai/instances/${officialId}/approve`, {}, "POST", 403);
    assert.equal(selfApprove.error.code, "SOD_VIOLATION");
    const approvedInst = await admin2.fetch(`/staff/admin/ai/instances/${officialId}/approve`, {}, "POST", 200);
    assert.equal(approvedInst.instance.status, "approved");

    // Sync /models from official mock
    const synced = await admin1.fetch(`/staff/admin/ai/instances/${officialId}/models/sync`, {}, "POST", 200);
    assert.equal(synced.supported, true);
    assert.equal(synced.inserted_count, 2);
    officialModelId = synced.models.find((m: any) => m.requested_model_id === "gpt-4o-mini").id;

    // Production instance requires approved rate before test/execution
    const noRateFail = await admin1.fetch(`/staff/admin/ai/models/${officialModelId}/test`, {}, "POST", 409);
    assert.equal(noRateFail.error.code, "AI_RATE_UNCONFIGURED_FOR_PRODUCTION");

    const rateRes = await admin1.fetch(
      `/staff/admin/ai/models/${officialModelId}/rates`,
      {
        currency: "USD",
        input_micros_per_1k_tokens: 150,
        output_micros_per_1k_tokens: 600,
        cached_input_micros_per_1k_tokens: 75,
        rate_source: "official_schedule",
      },
      "POST",
      201,
    );
    const rateId = rateRes.rate.id as string;

    // Rate version immutability enforced at DB trigger level
    await assert.rejects(
      () => pool.query("update ai_model_rate_versions set input_micros_per_1k_tokens = 1 where id = $1", [rateId]),
      /AI_RATE_VERSION_IMMUTABLE/,
    );
    await assert.rejects(
      () => pool.query("delete from ai_model_rate_versions where id = $1", [rateId]),
      /AI_RATE_VERSION_IMMUTABLE/,
    );

    // Model cannot be approved until synthetic structured test passes
    const untestedApprove = await admin2.fetch(`/staff/admin/ai/models/${officialModelId}/approve`, {}, "POST", 409);
    assert.equal(untestedApprove.error.code, "AI_MODEL_NOT_VERIFIED");

    const syntheticKey = randomUUID();
    const callsBeforeSynth = mockUpstreamCalls;
    const tested = await admin1.fetch(
      `/staff/admin/ai/models/${officialModelId}/test`,
      { target_locale: "zh-CN" },
      "POST",
      200,
      syntheticKey,
    );
    assert.equal(tested.ok, true);
    assert.match(tested.model.observed_model_snapshot, /gpt-4o-mini-2025-04-14/);
    assert.match(tested.synthetic_output[0].translated_text, /\{sample_code\}/);
    assert.equal(tested.invocation.provider_request_id, "req_resp_ok");
    assert.equal(mockUpstreamCalls, callsBeforeSynth + 1);

    // P1 #1 regression: Idempotency-Key replay avoids duplicate upstream call & cost, while payload change rejects 409
    const replayedTest = await admin1.fetch(
      `/staff/admin/ai/models/${officialModelId}/test`,
      { target_locale: "zh-CN" },
      "POST",
      200,
      syntheticKey,
    );
    assert.equal(replayedTest.invocation.id, tested.invocation.id);
    assert.equal(mockUpstreamCalls, callsBeforeSynth + 1);

    const idemConflict = await admin1.fetch(
      `/staff/admin/ai/models/${officialModelId}/test`,
      { target_locale: "en-US" },
      "POST",
      409,
      syntheticKey,
    );
    assert.equal(idemConflict.error.code, "IDEMPOTENCY_CONFLICT");

    const approvedModel = await admin2.fetch(`/staff/admin/ai/models/${officialModelId}/approve`, {}, "POST", 200);
    assert.equal(approvedModel.model.approved, true);

    // OpenAI Compatible without /models support -> honest probe & manual exact model registration
    mockMode = "compatible_no_models";
    const compat = await admin1.fetch(
      "/staff/admin/ai/instances",
      {
        instance_key: "compat-chat-test",
        display_name: "Compatible Studio",
        adapter_type: "openai_compatible",
        api_protocol: "openai_chat_completions",
        environment: "test",
        base_url: `${aiOrigin}/v1`,
        data_region_policy: "SG Isolated",
        allowed_purposes: ["KNOWLEDGE_TRANSLATION_DRAFT"],
        timeout_ms: 1000,
        daily_budget_cents: 25,
        monthly_budget_cents: 100,
      },
      "POST",
      201,
    );
    compatInstId = compat.instance.id as string;
    await admin1.fetch(
      `/staff/admin/ai/instances/${compatInstId}/secrets`,
      { secret_name: "api_key", secret_value: "sk-compat-test-key-001122" },
      "POST",
      201,
    );

    const compatProbe = await admin1.fetch(`/staff/admin/ai/instances/${compatInstId}/probe`, {}, "POST", 200);
    assert.equal(compatProbe.probe.modelListSupported, false);
    assert.equal(compatProbe.probe.errorCode, "AI_MODEL_LIST_UNSUPPORTED");

    const compatSync = await admin1.fetch(`/staff/admin/ai/instances/${compatInstId}/models/sync`, {}, "POST", 200);
    assert.equal(compatSync.supported, false);
    assert.equal(compatSync.models.length, 0);

    const manual = await admin1.fetch(
      `/staff/admin/ai/instances/${compatInstId}/models`,
      { requested_model_id: "qwen2.5-72b-instruct", supports_structured_output: false, supports_json_object: true },
      "POST",
      201,
    );
    compatModelId = manual.model.id as string;
    const compatTest = await admin1.fetch(`/staff/admin/ai/models/${compatModelId}/test`, {}, "POST", 200);
    assert.equal(compatTest.ok, true);
    assert.match(compatTest.synthetic_output[0].translated_text, /\{sample_code\}/);
    mockMode = "ok";

    // Rotating API key resets instance health back to unknown/draft requiring re-probe
    await admin1.fetch(
      `/staff/admin/ai/instances/${officialId}/secrets`,
      { secret_name: "api_key", secret_value: "sk-live-rotated-key-999999" },
      "POST",
      201,
    );
    const afterRotate = await admin1.fetch("/staff/admin/ai/overview", undefined, "GET", 200);
    const rotatedRow = afterRotate.instances.find((x: any) => x.id === officialId);
    assert.equal(rotatedRow.last_health_status, "unknown");
    assert.equal(rotatedRow.status, "draft");

    // P2 #2 regression: cannot approve model when parent instance is inactive (draft/disabled/archived)
    const inactiveParentApprove = await admin2.fetch(`/staff/admin/ai/models/${officialModelId}/approve`, {}, "POST", 409);
    assert.equal(inactiveParentApprove.error.code, "AI_INSTANCE_NOT_ACTIVE");
  });

  await suite.test("A03: PII outbound block, upstream failure classification & timeout_unknown null cost", async () => {
    const callsBeforePii = mockUpstreamCalls;
    const piiBlocked = await admin1.fetch(
      `/staff/admin/ai/models/${officialModelId}/test`,
      { source_text: "Customer paid with sk_live_secret1234567890abcd on card." },
      "POST",
      422,
    );
    assert.equal(piiBlocked.error.code, "UNSAFE_OUTBOUND_AI_PAYLOAD");
    assert.equal(mockUpstreamCalls, callsBeforePii, "PII rejection must occur before upstream fetch");

    for (const [mode, expectedInvStatus, expectedCode] of [
      ["auth_401", "failed", "AI_AUTH_FAILED"],
      ["rate_429", "failed", "AI_RATE_OR_QUOTA_LIMITED"],
      ["refused", "refused", "AI_CONTENT_REFUSED"],
      ["truncated", "truncated", "AI_OUTPUT_TRUNCATED"],
      ["malformed_json", "invalid_output", "AI_OUTPUT_MALFORMED"],
      ["dropped_placeholder", "invalid_output", "AI_OUTPUT_PLACEHOLDER_BROKEN"],
    ] as const) {
      mockMode = mode;
      const out = await admin1.fetch(`/staff/admin/ai/models/${officialModelId}/test`, {}, "POST", 200);
      assert.equal(out.ok, false);
      assert.equal(out.invocation.status, expectedInvStatus);
      assert.equal(out.invocation.error_code, expectedCode);
      if (mode === "dropped_placeholder") {
        // P2 #1 regression: invalid output preserves HTTP 200 reqId & billable tokens instead of resetting to cache_zero
        assert.equal(out.invocation.provider_request_id, "req_resp_ok");
        assert.equal(out.invocation.input_tokens, 120);
        assert.equal(out.invocation.cost_status, "estimated");
      }
    }

    // Timeout produces unknown_pending with cost_cents === null (NEVER fake 0)
    mockMode = "slow_timeout";
    const timedOut = await admin1.fetch(`/staff/admin/ai/models/${compatModelId}/test`, {}, "POST", 200);
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.invocation.status, "timeout_unknown");
    assert.equal(timedOut.invocation.cost_status, "unknown_pending");
    assert.equal(timedOut.invocation.cost_cents, null);
    mockMode = "ok";
  });

  await suite.test("A04: concurrent atomic budget reservation prevents overspend under parallel contention", async () => {
    // Keep prior unknown_pending reservations intact and set daily_budget_cents = existing + 25c (fits 2x10c, blocks 4x10c)
    await pool.query(
      "update ai_budget_reservations set status = 'released', settled_cents = 0 where instance_id = $1 and status = 'reserved'",
      [compatInstId],
    );
    const existingUsed = (
      await pool.query<{ s: number }>(
        "select coalesce(sum(reserved_cents), 0)::int as s from ai_budget_reservations where instance_id = $1 and status in ('reserved', 'unknown_pending')",
        [compatInstId],
      )
    ).rows[0]!.s;
    await pool.query("update ai_provider_instances set daily_budget_cents = $2, monthly_budget_cents = $3 where id = $1", [
      compatInstId,
      existingUsed + 25,
      existingUsed + 100,
    ]);

    const adminUser = (
      await pool.query<{ user_id: string }>(
        "select user_id from user_emails where normalized_email = 'admin@qcw.test'",
      )
    ).rows[0]!;

    const concurrent = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        transaction((db) =>
          reserveAiBudgetAtomic(db, {
            reservationKey: `conc-real-${idx}-${randomUUID()}`,
            instanceId: compatInstId,
            modelId: compatModelId,
            rateVersionId: null,
            purposeCode: "KNOWLEDGE_TRANSLATION_DRAFT",
            estimatedCents: 10,
            actorUserId: adminUser.user_id,
          }),
        ).catch((err) => ({ rejectedCode: err?.code as string })),
      ),
    );

    const successes = concurrent.filter((r): r is { id: string; reserved_cents: number } => "id" in r);
    const rejections = concurrent.filter((r): r is { rejectedCode: string } => "rejectedCode" in r);
    assert.equal(successes.length, 2, `Expected 2/6 reservations within 25c headroom, got ${JSON.stringify(concurrent)}`);
    assert.equal(rejections.length, 4);
    for (const rej of rejections) {
      assert.equal(rej.rejectedCode, "AI_BUDGET_EXCEEDED");
    }

    const totalReserved = (
      await pool.query<{ s: number }>(
        "select coalesce(sum(reserved_cents), 0)::int as s from ai_budget_reservations where instance_id = $1 and status in ('reserved', 'unknown_pending')",
        [compatInstId],
      )
    ).rows[0]!.s;
    assert.equal(totalReserved, existingUsed + 20);
  });

  await suite.test("A05: RBAC matrix, read-only finance/reviewer separation, reconciliation & cost integrity", async () => {
    // Customer & warehouse receiver forbidden even from read-only overview
    for (const deniedClient of [customer, receiving]) {
      const d = await deniedClient.fetch("/staff/admin/ai/overview", undefined, "GET", 403);
      assert.equal(d.error.code, "FORBIDDEN");
    }

    // Finance, reviewer, and template_admin can view overview, invocations & costs, but cannot configure instances/secrets
    for (const roClient of [finance, reviewer, inspector]) {
      const ov = await roClient.fetch("/staff/admin/ai/overview", undefined, "GET", 200);
      assert.equal(ov.no_customer_surcharge, true);
      assert.equal(ov.manual_fallback_available, true);
      await roClient.fetch("/staff/admin/ai/costs", undefined, "GET", 200);
      const mut = await roClient.fetch(
        "/staff/admin/ai/instances",
        {
          instance_key: "unauthorized-ro",
          display_name: "RO Fail",
          adapter_type: "openai_compatible",
          environment: "test",
          base_url: `${aiOrigin}/v1`,
          data_region_policy: "None",
          allowed_purposes: ["KNOWLEDGE_TRANSLATION_DRAFT"],
        },
        "POST",
        403,
      );
      assert.equal(mut.error.code, "FORBIDDEN");
    }

    // Reviewer cannot post finance reconciliation -> 403
    const revRecon = await reviewer.fetch(
      "/staff/admin/ai/costs/reconcile",
      {
        instance_id: compatInstId,
        billing_period: "2026-11",
        billed_cents: 1,
        currency: "USD",
      },
      "POST",
      403,
    );
    assert.equal(revRecon.error.code, "FORBIDDEN");

    // Finance reconciles an unknown_pending invocation (mismatched instance rejected 404; match settles reservation)
    const invList = await finance.fetch("/staff/admin/ai/invocations?status=timeout_unknown", undefined, "GET", 200);
    assert(invList.invocations.length >= 1);
    const pendingInv = invList.invocations[0];

    const wrongInstId = (await admin1.fetch("/staff/admin/ai/overview", undefined, "GET", 200)).instances.find(
      (i: any) => i.id !== compatInstId,
    ).id;
    const mismatchRecon = await finance.fetch(
      "/staff/admin/ai/costs/reconcile",
      {
        invocation_id: pendingInv.id,
        instance_id: wrongInstId,
        billing_period: "2026-11",
        billed_cents: 4,
        currency: "USD",
      },
      "POST",
      404,
    );
    assert.equal(mismatchRecon.error.code, "NOT_FOUND");

    const recon = await finance.fetch(
      "/staff/admin/ai/costs/reconcile",
      {
        invocation_id: pendingInv.id,
        instance_id: compatInstId,
        billing_period: "2026-11",
        provider_invoice_ref: "INV-AI-2026-11-001",
        billed_cents: 4,
        currency: "USD",
        notes: "Confirmed timed-out attempt appeared on supplier statement.",
      },
      "POST",
      201,
    );
    assert.equal(recon.adjustment.billed_cents, 4);

    const afterInv = await finance.fetch("/staff/admin/ai/invocations", undefined, "GET", 200);
    const updatedRow = afterInv.invocations.find((r: any) => r.id === pendingInv.id);
    assert.equal(updatedRow.cost_status, "reconciled");
    assert.equal(updatedRow.cost_cents, 4);

    const resRow = (
      await pool.query<{ status: string; settled_cents: number }>(
        "select status, settled_cents from ai_budget_reservations where id = $1",
        [pendingInv.reservation_id],
      )
    ).rows[0]!;
    assert.equal(resRow.status, "settled");
    assert.equal(resRow.settled_cents, 4);
  });
});
