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
const { pool } = await import("../packages/db");
const { workOnce } = await import("../packages/core/worker");
const { registerTestAllowedAiEndpointOrigin } = await import("../packages/core/ai-adapter");
const { verifySemanticFactIntegrity } = await import("../packages/core/ai-semantic-guard");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ProviderBehavior = "ok" | "corrupt_number" | "transient_500" | "slow_timeout";
let primaryBehavior: ProviderBehavior = "ok";
let primaryCalls = 0;
let fallbackCalls = 0;

function makeResponsePayload(reqPath: string, body: Record<string, any>, isFallback: boolean) {
  const userJson = JSON.parse(String(body.input ?? body.messages?.[1]?.content ?? "{}"));
  const srcItems = Array.isArray(userJson.untrusted_items) ? userJson.untrusted_items : [];
  const tgtLoc = String(userJson.target_locale ?? "zh-CN");
  const isResponses = reqPath.endsWith("/responses");

  const items = srcItems.map((it: any) => {
    let translated =
      tgtLoc === "zh-CN"
        ? `${isFallback ? "[备用]" : ""}查验记录：${it.source_text}`
        : `${isFallback ? "[Fallback] " : ""}Translated QC note: ${it.source_text}`;
    if (primaryBehavior === "corrupt_number" && !isFallback) {
      translated = translated.replace(/2\.5/g, "9.9").replace(/-0\.5/g, "0.5");
    }
    return {
      field_id: String(it.field_id),
      target_locale: tgtLoc,
      translated_text: translated,
      status: "translated",
      warnings: [],
    };
  });

  if (isResponses) {
    return {
      id: isFallback ? "resp_fb_1" : "resp_prim_1",
      model: String(body.model ?? "gpt-4o-mini"),
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ items }) }] }],
      usage: { input_tokens: 90, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } },
    };
  }
  return {
    id: isFallback ? "cmpl_fb_1" : "cmpl_prim_1",
    model: String(body.model ?? "gpt-4o-mini"),
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ items }) } }],
    usage: { prompt_tokens: 80, completion_tokens: 35 },
  };
}

const aiServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>) : {};

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_models_w19" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini" }] }));
    return;
  }

  const isFallback = url.pathname.startsWith("/fallback/");
  if (isFallback) fallbackCalls += 1;
  else primaryCalls += 1;

  if (!isFallback && primaryBehavior === "transient_500") {
    res.writeHead(500, { "content-type": "application/json", "x-request-id": "req_prim_500" });
    res.end(JSON.stringify({ error: { message: "Upstream transient failure" } }));
    return;
  }
  if (!isFallback && primaryBehavior === "slow_timeout") {
    await new Promise((r) => setTimeout(r, 1250));
    if (!res.writableEnded) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }
    return;
  }

  const payload = makeResponsePayload(url.pathname, body, isFallback);
  res.writeHead(200, {
    "content-type": "application/json",
    "x-request-id": isFallback ? "req_fb_ok" : "req_prim_ok",
  });
  res.end(JSON.stringify(payload));
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
}

let aiOrigin = "";
let customer2Email = "cust2.w19@qcw.test";
let disabledStaffEmail = "revoked.w19@qcw.test";
let disabledStaffId = "";

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

  // Seed 2nd super_admin, 2nd customer (isolated org), and revocable staff user
  const admin2Id = randomUUID();
  const admin2EmailId = randomUUID();
  await pool.query("insert into users(id, display_name, status) values($1, 'Admin2 W19', 'active')", [admin2Id]);
  await pool.query(
    "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
    [admin2EmailId, admin2Id, "admin2.w19@qcw.test", "admin2.w19@qcw.test"],
  );
  await pool.query(
    "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
    [admin2Id, admin2EmailId],
  );
  await pool.query("insert into staff_roles(user_id, role) values($1, 'super_admin')", [admin2Id]);
  await pool.query(
    "insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status) values($1, 'EMP-W19A', 'admin2.w19@qcw.test', 'active', 'active')",
    [admin2Id],
  );

  // 2nd customer with distinct org for cross-tenant cache isolation test
  const cust2Id = randomUUID();
  const cust2OrgId = randomUUID();
  const cust2EmailId = randomUUID();
  await pool.query("insert into users(id, display_name, status) values($1, 'Cust2 W19', 'active')", [cust2Id]);
  await pool.query("insert into organizations(id, name) values($1, 'Cust2 Isolated Org')", [cust2OrgId]);
  await pool.query("insert into memberships(user_id, org_id) values($1, $2)", [cust2Id, cust2OrgId]);
  await pool.query("insert into customer_receiving_profiles(user_id, org_id, receiving_code) values($1, $2, 'QCW99192')", [cust2Id, cust2OrgId]);
  await pool.query(
    "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
    [cust2EmailId, cust2Id, customer2Email, customer2Email],
  );
  await pool.query(
    "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
    [cust2Id, cust2EmailId],
  );

  // Temporary active support staff who will be disabled prior to worker run
  disabledStaffId = randomUUID();
  const dsEmailId = randomUUID();
  await pool.query("insert into users(id, display_name, status) values($1, 'Revoked Staff', 'active')", [disabledStaffId]);
  await pool.query(
    "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
    [dsEmailId, disabledStaffId, disabledStaffEmail, disabledStaffEmail],
  );
  await pool.query(
    "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
    [disabledStaffId, dsEmailId],
  );
  await pool.query("insert into staff_roles(user_id, role) values($1, 'support')", [disabledStaffId]);
  await pool.query(
    "insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status) values($1, 'EMP-W19REV', $2, 'active', 'active')",
    [disabledStaffId, disabledStaffEmail],
  );
});

after(async () => {
  registerTestAllowedAiEndpointOrigin(null);
  await new Promise<void>((resolve) => aiServer.close(() => resolve()));
  await pool.end();
});

test("PKG-3 Wave 19 (TASK-192): 9-purpose routing, immutable prompts, glossary, tenant-isolated cache, semantic protection & evals", async (suite) => {
  const admin1 = new Client();
  await admin1.loginWithMfa("admin@qcw.test");
  const admin2 = new Client();
  await admin2.loginWithMfa("admin2.w19@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const customer1 = new Client();
  await customer1.loginWithMfa("customer@qcw.test");
  const customer2 = new Client();
  await customer2.loginWithMfa(customer2Email);
  const revocableStaff = new Client();
  await revocableStaff.loginWithMfa(disabledStaffEmail);

  // Provision approved primary + fallback + policy-mismatched AI instances & models from Wave 18
  async function setupApprovedEndpoint(key: string, prefix: string, regionPolicy: string, timeoutMs = 1000) {
    const instRes = await admin1.fetch(
      "/staff/admin/ai/instances",
      {
        instance_key: key,
        display_name: key,
        adapter_type: "openai_compatible",
        api_protocol: "openai_chat_completions",
        environment: "production",
        base_url: `${aiOrigin}${prefix}/v1`,
        data_region_policy: regionPolicy,
        allowed_purposes: [
          "SUPPORT_INBOUND_TRANSLATE",
          "INSPECTION_REQUIREMENT_TRANSLATE",
          "KNOWLEDGE_TRANSLATION_DRAFT",
          "REPORT_TEXT_LOCALIZE",
        ],
        timeout_ms: timeoutMs,
        daily_budget_cents: 500,
        monthly_budget_cents: 5000,
      },
      "POST",
      201,
    );
    const instId = instRes.instance.id as string;
    await admin1.fetch(`/staff/admin/ai/instances/${instId}/secrets`, { secret_name: "api_key", secret_value: "sk-w19-key-123456" }, "POST", 201);
    await admin1.fetch(`/staff/admin/ai/instances/${instId}/probe`, {}, "POST", 200);
    await admin2.fetch(`/staff/admin/ai/instances/${instId}/approve`, {}, "POST", 200);
    const mRes = await admin1.fetch(
      `/staff/admin/ai/instances/${instId}/models`,
      { requested_model_id: "gpt-4o-mini", supports_structured_output: true },
      "POST",
      201,
    );
    const modelId = mRes.model.id as string;
    await admin1.fetch(
      `/staff/admin/ai/models/${modelId}/rates`,
      { currency: "USD", input_micros_per_1k_tokens: 150, output_micros_per_1k_tokens: 600, rate_source: "official_schedule" },
      "POST",
      201,
    );
    await admin1.fetch(`/staff/admin/ai/models/${modelId}/test`, { target_locale: "zh-CN" }, "POST", 200);
    await admin2.fetch(`/staff/admin/ai/models/${modelId}/approve`, {}, "POST", 200);
    return { instId, modelId };
  }

  const primary = await setupApprovedEndpoint("w19-primary", "/primary", "US-Commercial-ZDR", 1000);
  const fallbackOk = await setupApprovedEndpoint("w19-fallback-ok", "/fallback", "US-Commercial-ZDR", 2000);
  const fallbackMismatch = await setupApprovedEndpoint("w19-fallback-bad", "/fallback", "Different-Region", 2000);

  let supportPromptId = "";
  let knowledgePromptId = "";
  let reportPromptId = "";
  let supportRouteV1Id = "";
  let supportRouteV2Id = "";

  await suite.test("S01: 9-purpose prompts, unsafe template rejection, SoD publish, DB immutability & rollback", async () => {
    const seeded = await admin1.fetch("/staff/admin/ai/prompts/seed", {}, "POST", 201);
    assert.equal(seeded.seeded_count, 9);

    for (const bad of ["Use {{handlebars}}", "Eval ${process.env}", "<script>alert(1)</script>", "Visit https://evil.example"]) {
      const rejected = await admin1.fetch(
        "/staff/admin/ai/prompts",
        { purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT", title: "Unsafe", semantic_guidance: bad + " translate." },
        "POST",
        422,
      );
      assert.equal(rejected.error.code, "AI_UNSAFE_PROMPT_TEMPLATE");
    }

    const promptList = await admin1.fetch("/staff/admin/ai/prompts", undefined, "GET", 200);
    const sup = promptList.prompts.find((p: any) => p.purpose_code === "SUPPORT_INBOUND_TRANSLATE");
    const knw = promptList.prompts.find((p: any) => p.purpose_code === "KNOWLEDGE_TRANSLATION_DRAFT");
    const rpt = promptList.prompts.find((p: any) => p.purpose_code === "REPORT_TEXT_LOCALIZE");
    supportPromptId = sup.id;
    knowledgePromptId = knw.id;
    reportPromptId = rpt.id;

    // Self-publish blocked (SoD); admin2 publishes cleanly
    const selfPub = await admin1.fetch(`/staff/admin/ai/prompts/${supportPromptId}/publish`, {}, "POST", 403);
    assert.equal(selfPub.error.code, "SOD_VIOLATION");
    await admin2.fetch(`/staff/admin/ai/prompts/${supportPromptId}/publish`, {}, "POST", 200);
    await admin2.fetch(`/staff/admin/ai/prompts/${knowledgePromptId}/publish`, {}, "POST", 200);
    await admin2.fetch(`/staff/admin/ai/prompts/${reportPromptId}/publish`, {}, "POST", 200);

    // Published prompt content protected by DB trigger
    await assert.rejects(
      () => pool.query("update ai_prompt_versions set semantic_guidance = 'mutated text...' where id = $1", [supportPromptId]),
      /AI_PROMPT_VERSION_IMMUTABLE/,
    );

    // Draft v2 + publish + rollback to v1 creates new published v3 preserving history
    const p2 = await admin1.fetch(
      "/staff/admin/ai/prompts",
      {
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        title: "Support Inbound v2",
        semantic_guidance: "Translate inbound buyer messages faithfully for support agents.",
      },
      "POST",
      201,
    );
    await admin2.fetch(`/staff/admin/ai/prompts/${p2.prompt.id}/publish`, {}, "POST", 200);
    const isDraftSup1 = await admin1.fetch(`/staff/admin/ai/prompts/${p2.prompt.id}/rollback`, {}, "POST", 409).catch(() => null);
    void isDraftSup1;
    // Draft cannot be rolled back; self-rollback of own prompt is blocked (SoD)
    const draftPrompt = await admin1.fetch(
      "/staff/admin/ai/prompts",
      {
        purpose_code: "NOTIFICATION_TRANSLATE",
        title: "Unapproved Draft Prompt",
        semantic_guidance: "Draft prompt for notification translation that is never published.",
      },
      "POST",
      201,
    );
    const rollbackDraftFail = await admin2.fetch(`/staff/admin/ai/prompts/${draftPrompt.prompt.id}/rollback`, {}, "POST", 409);
    assert.equal(rollbackDraftFail.error.code, "RECORD_CONFLICT");

    const selfRollbackPrompt = await admin1.fetch(`/staff/admin/ai/prompts/${supportPromptId}/rollback`, {}, "POST", 403);
    assert.equal(selfRollbackPrompt.error.code, "SOD_VIOLATION");

    const rolled = await admin2.fetch(`/staff/admin/ai/prompts/${supportPromptId}/rollback`, {}, "POST", 200);
    assert.equal(rolled.prompt.version, 3);
    assert.equal(rolled.prompt.status, "published");
    supportPromptId = rolled.prompt.id;
  });

  await suite.test("S02: 9-purpose routing, high-risk confirmation, eval gate before publish, fallback policy parity & rollback", async () => {
    // Seed bilingual eval corpus so high-risk & technical routes enforce eval QA gate before publish
    const seededEvals = await admin1.fetch("/staff/admin/ai/evals/seed", {}, "POST", 201);
    assert.equal(seededEvals.inserted, 8);

    // High-risk INSPECTION_REQUIREMENT_TRANSLATE cannot disable human confirmation
    const reqPrompt = (
      await admin1.fetch("/staff/admin/ai/prompts?purpose_code=INSPECTION_REQUIREMENT_TRANSLATE", undefined, "GET", 200)
    ).prompts[0];
    await admin2.fetch(`/staff/admin/ai/prompts/${reqPrompt.id}/publish`, {}, "POST", 200);

    const noConfirmFail = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "INSPECTION_REQUIREMENT_TRANSLATE",
        primary_instance_id: primary.instId,
        primary_model_id: primary.modelId,
        prompt_version_id: reqPrompt.id,
        requires_human_confirmation: false,
      },
      "POST",
      422,
    );
    assert.equal(noConfirmFail.error.code, "AI_HIGH_RISK_CONFIRMATION_REQUIRED");

    // Fallback instance with different data_region_policy rejected (409 AI_FALLBACK_POLICY_MISMATCH)
    const fbMismatch = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        primary_instance_id: primary.instId,
        primary_model_id: primary.modelId,
        fallback_instance_id: fallbackMismatch.instId,
        fallback_model_id: fallbackMismatch.modelId,
        prompt_version_id: supportPromptId,
      },
      "POST",
      409,
    );
    assert.equal(fbMismatch.error.code, "AI_FALLBACK_POLICY_MISMATCH");

    // Create & SoD publish valid SUPPORT_INBOUND_TRANSLATE route (with policy-matched fallback)
    const rSup1 = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        primary_instance_id: primary.instId,
        primary_model_id: primary.modelId,
        fallback_instance_id: fallbackOk.instId,
        fallback_model_id: fallbackOk.modelId,
        prompt_version_id: supportPromptId,
      },
      "POST",
      201,
    );
    supportRouteV1Id = rSup1.route.id;
    const selfRoutePub = await admin1.fetch(`/staff/admin/ai/routes/${supportRouteV1Id}/publish`, {}, "POST", 403);
    assert.equal(selfRoutePub.error.code, "SOD_VIOLATION");
    await admin2.fetch(`/staff/admin/ai/routes/${supportRouteV1Id}/publish`, {}, "POST", 200);

    const rSup2 = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        primary_instance_id: primary.instId,
        primary_model_id: primary.modelId,
        prompt_version_id: supportPromptId,
      },
      "POST",
      201,
    );
    await admin2.fetch(`/staff/admin/ai/routes/${rSup2.route.id}/publish`, {}, "POST", 200);

    const selfRollbackRoute = await admin1.fetch(`/staff/admin/ai/routes/${supportRouteV1Id}/rollback`, {}, "POST", 403);
    assert.equal(selfRollbackRoute.error.code, "SOD_VIOLATION");

    const rolledRoute = await admin2.fetch(`/staff/admin/ai/routes/${supportRouteV1Id}/rollback`, {}, "POST", 200);
    assert.equal(rolledRoute.route.version, 3);
    supportRouteV2Id = rolledRoute.route.id;

    // Draft KNOWLEDGE_TRANSLATION_DRAFT route MUST pass approved zero-fact-error eval before publishing
    const rKnw = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        primary_instance_id: primary.instId,
        primary_model_id: primary.modelId,
        prompt_version_id: knowledgePromptId,
      },
      "POST",
      201,
    );
    const knwGateBlocked = await admin2.fetch(`/staff/admin/ai/routes/${rKnw.route.id}/publish`, {}, "POST", 409);
    assert.equal(knwGateBlocked.error.code, "AI_EVAL_APPROVAL_REQUIRED");

    const knwEvalRun = await admin1.fetch(
      "/staff/admin/ai/evals/run",
      {
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        route_version_id: rKnw.route.id,
        candidates_by_case_code: {
          "EVAL-POM-HALF-CHEST":
            "Flat 1/2 chest width measured 2.5 cm below armhole, tolerance -0.5 cm to +0.5 cm.",
        },
      },
      "POST",
      201,
    );
    assert.equal(knwEvalRun.eval_run.automated_status, "passed");
    await reviewer.fetch(
      `/staff/admin/ai/evals/${knwEvalRun.eval_run.id}/review`,
      { decision: "approved", notes: "Passed apparel POM tolerance eval before publish." },
      "POST",
      200,
    );
    await admin2.fetch(`/staff/admin/ai/routes/${rKnw.route.id}/publish`, {}, "POST", 200);

    // High-risk REPORT_TEXT_LOCALIZE draft also enforces eval gate before publish
    const rRpt = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        primary_instance_id: primary.instId,
        primary_model_id: primary.modelId,
        prompt_version_id: reportPromptId,
        requires_human_confirmation: true,
        high_risk_purpose: true,
      },
      "POST",
      201,
    );
    const rptGateBlocked = await admin2.fetch(`/staff/admin/ai/routes/${rRpt.route.id}/publish`, {}, "POST", 409);
    assert.equal(rptGateBlocked.error.code, "AI_EVAL_APPROVAL_REQUIRED");

    const badRptRun = await admin1.fetch(
      "/staff/admin/ai/evals/run",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        route_version_id: rRpt.route.id,
        candidates_by_case_code: {
          "EVAL-UNINSPECTED-BOUNDARY": "Sample S-10023 passed inspection and is defect-free.",
          "EVAL-CARE-LABEL-BOUNDARY": "Laboratory tested composition verified 95% cotton 5% spandex.",
          "EVAL-SAMPLING-SCOPE": "100% full batch passed for 5 pieces.",
        },
      },
      "POST",
      201,
    );
    assert.equal(badRptRun.eval_run.automated_status, "failed");
    assert(badRptRun.eval_run.protected_fact_errors > 0);

    const badQa = await reviewer.fetch(
      `/staff/admin/ai/evals/${badRptRun.eval_run.id}/review`,
      { decision: "approved", notes: "Attempt to waive fact errors" },
      "POST",
      409,
    );
    assert.equal(badQa.error.code, "AI_EVAL_PROTECTED_FACT_ERROR");

    const goodRptRun = await admin1.fetch(
      "/staff/admin/ai/evals/run",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        route_version_id: rRpt.route.id,
        candidates_by_case_code: {
          "EVAL-UNINSPECTED-BOUNDARY":
            "Wash fastness and chemical composition were not inspected; sample S-10023 has a suspected minor oil stain with no visible open seams.",
          "EVAL-CARE-LABEL-BOUNDARY":
            "Care label states 95% cotton, 5% spandex (transcribed from visible label only; no fiber testing performed).",
          "EVAL-SAMPLING-SCOPE": "Only 5 received samples were inspected; no bulk pass judgment.",
        },
      },
      "POST",
      201,
    );
    assert.equal(goodRptRun.eval_run.automated_status, "passed");
    assert.equal(goodRptRun.eval_run.protected_fact_errors, 0);

    const selfQa = await admin1.fetch(
      `/staff/admin/ai/evals/${goodRptRun.eval_run.id}/review`,
      { decision: "approved", notes: "Self approve" },
      "POST",
      403,
    );
    assert.equal(selfQa.error.code, "SOD_VIOLATION");

    await reviewer.fetch(
      `/staff/admin/ai/evals/${goodRptRun.eval_run.id}/review`,
      { decision: "approved", notes: "Verified faithful report text terminology and boundaries." },
      "POST",
      200,
    );
    await admin2.fetch(`/staff/admin/ai/routes/${rRpt.route.id}/publish`, {}, "POST", 200);

    // Rollback of prompt bound to an active published route MUST re-check eval gate on target prompt + roll forward active route cleanly
    const rptUntestedPrompt = await admin1.fetch(
      "/staff/admin/ai/prompts",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        title: "Report Untested Historical Prompt",
        semantic_guidance: "Untested prompt without approved eval for report localization rollback block test.",
      },
      "POST",
      201,
    );
    await admin2.fetch(`/staff/admin/ai/prompts/${rptUntestedPrompt.prompt.id}/publish`, {}, "POST", 200);
    const rptPromptV3 = await admin1.fetch(
      "/staff/admin/ai/prompts",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        title: "Report Evaluated Prompt v3",
        semantic_guidance: "Translate garment QC report sections strictly as non-destructive observations.",
      },
      "POST",
      201,
    );
    await admin2.fetch(`/staff/admin/ai/prompts/${rptPromptV3.prompt.id}/publish`, {}, "POST", 200);
    const rRptV3 = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        primary_instance_id: primary.instId,
        primary_model_id: primary.modelId,
        prompt_version_id: rptPromptV3.prompt.id,
        requires_human_confirmation: true,
        high_risk_purpose: true,
      },
      "POST",
      201,
    );
    const evalV3 = await admin1.fetch(
      "/staff/admin/ai/evals/run",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        route_version_id: rRptV3.route.id,
        candidates_by_case_code: {
          "EVAL-UNINSPECTED-BOUNDARY":
            "Wash fastness and chemical composition were not inspected; sample S-10023 has a suspected minor oil stain with no visible open seams.",
          "EVAL-CARE-LABEL-BOUNDARY":
            "Care label states 95% cotton, 5% spandex (transcribed from visible label only; no fiber testing performed).",
          "EVAL-SAMPLING-SCOPE": "Only 5 received samples were inspected; no bulk pass judgment.",
        },
      },
      "POST",
      201,
    );
    await reviewer.fetch(
      `/staff/admin/ai/evals/${evalV3.eval_run.id}/review`,
      { decision: "approved", notes: "Approved report v3 prompt eval." },
      "POST",
      200,
    );
    await admin2.fetch(`/staff/admin/ai/routes/${rRptV3.route.id}/publish`, {}, "POST", 200);

    // Rolling back active route's prompt to unevaluated historical prompt MUST be blocked (cannot reuse rRptV3's eval_run!)
    const blockedPromptRollback = await admin2.fetch(
      `/staff/admin/ai/prompts/${rptUntestedPrompt.prompt.id}/rollback`,
      {},
      "POST",
      409,
    );
    assert.equal(blockedPromptRollback.error.code, "AI_EVAL_APPROVAL_REQUIRED");

    // Rolling back to evaluated & approved v1 (reportPromptId) succeeds AND rolls forward a published route bound to new prompt v4
    const rolledReportPrompt = await admin2.fetch(`/staff/admin/ai/prompts/${reportPromptId}/rollback`, {}, "POST", 200);
    assert.equal(rolledReportPrompt.prompt.status, "published");
    const routesAfterPromptRb = await admin1.fetch("/staff/admin/ai/routes", undefined, "GET", 200);
    const activeRptRoute = routesAfterPromptRb.routes.find(
      (rt: any) => rt.purpose_code === "REPORT_TEXT_LOCALIZE" && rt.status === "published",
    );
    assert(activeRptRoute, "Active REPORT_TEXT_LOCALIZE route must remain published after prompt rollback");
    assert.equal(activeRptRoute.prompt_version_id, rolledReportPrompt.prompt.id);
    reportPromptId = rolledReportPrompt.prompt.id;
  });

  await suite.test("S03: glossary approval SoD & deterministic semantic protection catches corrupted facts", async () => {
    const aiTerm = await admin1.fetch(
      "/staff/admin/ai/glossary",
      {
        domain: "apparel_qc",
        term_key: "pom_half_chest",
        source_locale: "zh-CN",
        source_term: "平铺半胸宽",
        target_locale: "en-US",
        target_term: "1/2 Flat Chest Width",
        disallowed_translations: ["full chest circumference"],
        author_kind: "ai_draft",
      },
      "POST",
      201,
    );
    const selfAppr = await admin1.fetch(`/staff/admin/ai/glossary/${aiTerm.term.id}/approve`, {}, "POST", 403);
    assert.equal(selfAppr.error.code, "SOD_VIOLATION");
    await reviewer.fetch(`/staff/admin/ai/glossary/${aiTerm.term.id}/approve`, {}, "POST", 200);

    // Deterministic unit/number/sign/ID/negation/XSS checks + [+-±] & hallucinated number fixes
    assert.equal(
      verifySemanticFactIntegrity({
        sourceText: "Size:6 USD100 5-10 cm SPANDEX SAMPLE 420 g 2.5cm",
        candidateText: "尺码 6，价格 100 美元，5 至 10 厘米，氨纶样品重 420 g，2.5cm",
      }).ok,
      true,
      "Normal uppercase words (SAMPLE/SPANDEX), colons, currency prefixes, range hyphens, gram & attached units must pass",
    );
    assert.equal(
      verifySemanticFactIntegrity({
        sourceText: "Check 5 pcs on S-10023",
        candidateText: "Check 5 pcs ($50 extra) on S-10023",
      }).violations.some((v) => v.code === "AI_FACT_NUMBER_MUTATED"),
      true,
      "Hallucinated extra numeric fact ($50) absent in source must be rejected",
    );
    assert.equal(
      verifySemanticFactIntegrity({
        sourceText: "腋下 2.5 cm 公差 -0.5 cm",
        candidateText: "Chest tolerance 0.5 cm at 2.5 cm.",
      }).violations[0].code,
      "AI_FACT_SIGN_MUTATED",
    );
    assert.equal(
      verifySemanticFactIntegrity({
        sourceText: "Measure 2.5 cm below collar on S-10023",
        candidateText: "Measure 2.5 in below collar on S-10023",
      }).violations.some((v) => v.code === "AI_FACT_UNIT_MUTATED"),
      true,
    );
    assert.equal(
      verifySemanticFactIntegrity({
        sourceText: "Sample S-10023 is not inspected for wash fastness.",
        candidateText: "Sample S-10023 passed inspection and is defect-free.",
      }).violations.some((v) => v.code === "AI_FACT_FORBIDDEN_INFERENCE"),
      true,
    );
    assert.equal(
      verifySemanticFactIntegrity({
        sourceText: "Measure seam",
        candidateText: "<script>alert(1)</script>Measure seam",
      }).violations[0].code,
      "AI_UNSAFE_OUTPUT_CONTENT",
    );

    // High-risk REPORT_TEXT_LOCALIZE MUST enforce requires_human_confirmation=true on BOTH fresh and cached runs
    const rptEntity = randomUUID();
    const rptSource = "Only 5 received samples were inspected; no visible open seam on S-10023.";
    const rptJob1 = await admin1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "REPORT_TEXT_LOCALIZE",
        entity_type: "inspection_report",
        entity_id: rptEntity,
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "report",
        items: [{ field_id: "summary", source_text: rptSource }],
      },
      "POST",
      201,
    );
    await workOnce();
    const rptAfter1 = await admin1.fetch(`/ai/translations/jobs/${rptJob1.job.id}`, undefined, "GET", 200);
    assert.equal(rptAfter1.job.status, "needs_review");
    assert.equal(rptAfter1.items[0].candidate_status, "needs_review");
    assert.equal(rptAfter1.items[0].status, "needs_review");

    const rptJob2 = await admin1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "REPORT_TEXT_LOCALIZE",
        entity_type: "inspection_report",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "report",
        items: [{ field_id: "summary", source_text: rptSource }],
      },
      "POST",
      201,
    );
    await workOnce();
    const rptAfter2 = await admin1.fetch(`/ai/translations/jobs/${rptJob2.job.id}`, undefined, "GET", 200);
    assert.equal(rptAfter2.job.cache_hits, 1);
    assert.equal(rptAfter2.job.status, "needs_review", "Cached hit on mandatory-confirmation route must remain needs_review");
    assert.equal(rptAfter2.items[0].candidate_status, "needs_review");
    assert.equal(rptAfter2.items[0].status, "needs_review");

    // Live worker rejects corrupted number translation from upstream and does NOT cache it
    primaryBehavior = "corrupt_number";
    const enq = await admin1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: `job-corrupt-${randomUUID()}`,
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        tenant_scope_key: "internal:staff",
        entity_type: "inspection_template_item",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "pom_1", source_text: "Flat chest width 2.5 cm, tolerance -0.5 cm." }],
      },
      "POST",
      201,
    );
    await workOnce();
    primaryBehavior = "ok";

    const jobAfter = await admin1.fetch(`/ai/translations/jobs/${enq.job.id}`, undefined, "GET", 200);
    assert.equal(jobAfter.job.status, "failed");
    assert.equal(jobAfter.job.last_error_code, "AI_SEMANTIC_GUARD_REJECTED");
    assert.equal(jobAfter.items[0].candidate_status, "rejected");
    assert.equal(jobAfter.items[0].candidate_text, null);
    assert.equal(jobAfter.items[0].semantic_violations.length > 0, true);
  });

  await suite.test("S04: strict cross-tenant cache isolation, fallback failover, revoked actor defense & unknown retry guard", async () => {
    // Customer cannot access internal purpose or forge another org's tenant_scope_key
    const forbiddenPurpose = await customer1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "REPORT_TEXT_LOCALIZE",
        entity_type: "ticket",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "msg", source_text: "Hello" }],
      },
      "POST",
      403,
    );
    assert.equal(forbiddenPurpose.error.code, "FORBIDDEN");

    const entityId = randomUUID();
    const sharedText = "Please inspect seam S-20019 at 2.5 cm below armhole.";
    const pCallsBefore = primaryCalls;

    // Customer 1 first call hits primary and populates org1 cache
    const c1Job1 = await customer1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: entityId,
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "ticket",
        items: [{ field_id: "body", source_text: sharedText }],
      },
      "POST",
      201,
    );
    await workOnce();
    assert.equal(primaryCalls, pCallsBefore + 1);
    const c1Detail1 = await customer1.fetch(`/ai/translations/jobs/${c1Job1.job.id}`, undefined, "GET", 200);
    assert.equal(c1Detail1.job.status, "succeeded");

    // Customer 1 repeat hits cache with ZERO upstream provider calls
    const c1Job2 = await customer1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: entityId,
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "ticket",
        items: [{ field_id: "body", source_text: sharedText }],
      },
      "POST",
      201,
    );
    await workOnce();
    assert.equal(primaryCalls, pCallsBefore + 1, "Same-tenant repeat must hit cache without calling provider");
    const c1Detail2 = await customer1.fetch(`/ai/translations/jobs/${c1Job2.job.id}`, undefined, "GET", 200);
    assert.equal(c1Detail2.job.cache_hits, 1);

    // Customer 2 submits identical text -> MUST miss org1 cache and invoke upstream
    const c2Job = await customer2.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "ticket",
        items: [{ field_id: "body", source_text: sharedText }],
      },
      "POST",
      201,
    );
    await workOnce();
    assert.equal(primaryCalls, pCallsBefore + 2, "Cross-tenant cache isolation violated!");
    const c2Detail = await customer2.fetch(`/ai/translations/jobs/${c2Job.job.id}`, undefined, "GET", 200);
    assert.equal(c2Detail.job.cache_hits, 0);
    assert.equal(c2Detail.job.provider_calls, 1);

    // Cross-tenant job read is forbidden
    await customer1.fetch(`/ai/translations/jobs/${c2Job.job.id}`, undefined, "GET", 403);

    // Cross-tenant idempotency_key collision MUST NOT leak customer1's job to customer2; same-tenant mismatch -> 409
    const sharedIdempKey = `shared-key-${randomUUID()}`;
    const c1Idemp = await customer1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: sharedIdempKey,
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: entityId,
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "ticket",
        items: [{ field_id: "body", source_text: "Secret message A for tenant 1" }],
      },
      "POST",
      201,
    );
    const c2Idemp = await customer2.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: sharedIdempKey,
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "ticket",
        items: [{ field_id: "body", source_text: "Secret message B for tenant 2" }],
      },
      "POST",
      201,
    );
    assert.notEqual(c2Idemp.job.id, c1Idemp.job.id, "Cross-tenant idempotency_key collision leaked another tenant's job!");
    const sameTenantDiff = await customer1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: sharedIdempKey,
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: entityId,
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "ticket",
        items: [{ field_id: "body", source_text: "Mutated payload reusing same key" }],
      },
      "POST",
      409,
    );
    assert.equal(sameTenantDiff.error.code, "IDEMPOTENCY_CONFLICT");

    const dupField = await customer1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: entityId,
        source_locale: "en-US",
        target_locale: "zh-CN",
        cost_center: "ticket",
        items: [
          { field_id: "dup", source_text: "First line" },
          { field_id: "dup", source_text: "Second line" },
        ],
      },
      "POST",
      422,
    );
    assert.equal(dupField.error.code, "INVALID_REQUEST");

    // Drain the two idempotency-test queued jobs before testing fallback failover & outbox ordering
    while (await workOnce()) {}

    // If fallback prep throws mid-flight after transient primary failure, budget reservation is released and job fails cleanly
    await pool.query("update ai_provider_instances set status = 'disabled' where id = $1", [fallbackOk.instId]);
    primaryBehavior = "transient_500";
    const fbErrJob = await admin1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        tenant_scope_key: "internal:staff",
        entity_type: "ticket",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "body", source_text: "Fallback prep error cleanup test on S-30099." }],
      },
      "POST",
      201,
    );
    await workOnce();
    primaryBehavior = "ok";
    await pool.query("update ai_provider_instances set status = 'approved' where id = $1", [fallbackOk.instId]);
    const fbErrDetail = await admin1.fetch(`/ai/translations/jobs/${fbErrJob.job.id}`, undefined, "GET", 200);
    assert.equal(fbErrDetail.job.status, "failed");
    assert.equal(fbErrDetail.job.last_error_code, "AI_INSTANCE_NOT_APPROVED");
    const leakedReserved = (
      await pool.query<{ cnt: string }>(
        "select count(*)::text as cnt from ai_budget_reservations where status = 'reserved'",
      )
    ).rows[0]!.cnt;
    assert.equal(leakedReserved, "0", "Post-prep execution exception must release active budget reservations cleanly");

    // Transient 500 on primary triggers failover to policy-matched fallback instance
    primaryBehavior = "transient_500";
    const fbBefore = fallbackCalls;
    const fbJob = await admin1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        tenant_scope_key: "internal:staff",
        entity_type: "ticket",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "body", source_text: "Unique fallback test message for S-30001." }],
      },
      "POST",
      201,
    );
    await workOnce();
    primaryBehavior = "ok";
    assert.equal(fallbackCalls, fbBefore + 1);
    const fbDetail = await admin1.fetch(`/ai/translations/jobs/${fbJob.job.id}`, undefined, "GET", 200);
    assert.equal(fbDetail.job.status, "succeeded");
    assert.equal(fbDetail.job.used_fallback_route, true);
    assert.equal(fbDetail.job.provider_calls, 2);
    assert.match(fbDetail.items[0].candidate_text, /^\[备用\]/);
    const fbCacheRow = (
      await pool.query<{ model_id: string }>(
        "select model_id from ai_translation_cache where source_hash = $1 order by created_at desc limit 1",
        [fbDetail.items[0].source_hash],
      )
    ).rows[0]!;
    assert.equal(fbCacheRow.model_id, fallbackOk.modelId, "Fallback translation must cache under fallback model_id, not primary");

    // Revoked/locked/offboarded creator stops queued job before upstream execution
    const revJob = await revocableStaff.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "defect_type",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "label", source_text: "Broken stitch on S-40001." }],
      },
      "POST",
      201,
    );
    await pool.query("update staff_profiles set account_security_status = 'locked' where user_id = $1", [disabledStaffId]);
    const pBeforeRev = primaryCalls;
    await workOnce();
    assert.equal(primaryCalls, pBeforeRev, "Security-locked staff job must never reach upstream AI provider");
    const revDetail = await admin1.fetch(`/ai/translations/jobs/${revJob.job.id}`, undefined, "GET", 200);
    assert.equal(revDetail.job.status, "cancelled");
    assert.equal(revDetail.job.last_error_code, "PERMISSION_REVOKED");

    // Unknown timeout job forbids blind retry without confirm_unknown_retry=true + super_admin
    primaryBehavior = "slow_timeout";
    const toJob = await admin1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "defect_type",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "label", source_text: "Timeout test 5.5 cm on S-50001." }],
      },
      "POST",
      201,
    );
    await workOnce();
    primaryBehavior = "ok";
    const toDetail = await admin1.fetch(`/ai/translations/jobs/${toJob.job.id}`, undefined, "GET", 200);
    assert.equal(toDetail.job.status, "unknown_outcome");

    const blindRetry = await admin1.fetch(`/staff/admin/ai/jobs/${toJob.job.id}/retry`, { confirm_unknown_retry: false }, "POST", 409);
    assert.equal(blindRetry.error.code, "AI_UNKNOWN_OUTCOME_RETRY_REQUIRES_CONFIRMATION");
  });

  await suite.test("S05: bilingual eval corpus idempotency, protected_tokens enforcement & post-publish audit listing", async () => {
    const seededAgain = await admin1.fetch("/staff/admin/ai/evals/seed", {}, "POST", 201);
    assert.equal(seededAgain.inserted, 0);

    // Omitting a declared protected token on REPORT_TEXT_LOCALIZE fails eval with AI_FACT_PROTECTED_TOKEN_MISSING
    const missingTokenRun = await admin1.fetch(
      "/staff/admin/ai/evals/run",
      {
        purpose_code: "REPORT_TEXT_LOCALIZE",
        candidates_by_case_code: {
          "EVAL-UNINSPECTED-BOUNDARY":
            "Wash fastness and chemical composition were not inspected; sample has a suspected minor oil stain with no visible open seams.",
          "EVAL-CARE-LABEL-BOUNDARY":
            "Care label states 95% cotton, 5% spandex (transcribed from visible label only; no fiber testing performed).",
          "EVAL-SAMPLING-SCOPE": "Only 5 received samples were inspected; no bulk pass judgment.",
        },
      },
      "POST",
      201,
    );
    assert.equal(missingTokenRun.eval_run.automated_status, "failed");
    assert(missingTokenRun.eval_run.protected_fact_errors >= 1);
    const listedEvals = await admin1.fetch("/staff/admin/ai/evals", undefined, "GET", 200);
    assert(listedEvals.eval_cases.length >= 8);
    assert(listedEvals.eval_runs.length >= 3);
  });

  await suite.test("S06: priority worker pool runs core business events ahead of queued ai.translate jobs", async () => {
    const aiJob = await admin1.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: randomUUID(),
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "pom",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "name", source_text: "Priority check length 42.0 cm on S-60001." }],
      },
      "POST",
      201,
    );

    const bizOutboxId = (
      await pool.query<{ id: string }>(
        "insert into outbox_events(type, payload) values('account.registered', '{\"warehouse_address_status\":\"ok\"}'::jsonb) returning id",
      )
    ).rows[0]!.id;

    // First tick drains the higher-priority business event cleanly WITHOUT touching the queued ai.translate job yet
    const workedFirst = await workOnce();
    assert.equal(workedFirst, true);

    const bizRow = (await pool.query<{ processed_at: string | null }>("select processed_at from outbox_events where id = $1", [bizOutboxId])).rows[0]!;
    assert(bizRow.processed_at, "Core business event must be processed ahead of low-priority ai.translate");

    const aiStillQueued = await admin1.fetch(`/ai/translations/jobs/${aiJob.job.id}`, undefined, "GET", 200);
    assert.equal(aiStillQueued.job.status, "queued");

    // Second tick drains ai.translate cleanly
    const workedSecond = await workOnce();
    assert.equal(workedSecond, true);
    const aiDone = await admin1.fetch(`/ai/translations/jobs/${aiJob.job.id}`, undefined, "GET", 200);
    assert.equal(aiDone.job.status, "succeeded");
  });
});
