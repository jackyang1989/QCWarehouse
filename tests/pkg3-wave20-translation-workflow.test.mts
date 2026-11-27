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
const { resolvePortalRoute, canOpenStaffPage } = await import("../packages/core/portal-routes");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let aiCallCount = 0;
let failFields = new Set<string>();

const aiServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>) : {};

  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_models_w20" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini" }] }));
    return;
  }

  aiCallCount += 1;
  const userJson = JSON.parse(String(body.input ?? body.messages?.[1]?.content ?? "{}"));
  const srcItems = Array.isArray(userJson.untrusted_items) ? userJson.untrusted_items : [];
  const tgtLoc = String(userJson.target_locale ?? "en-US");

  const shouldFailAll = srcItems.some((it: any) => failFields.has(String(it.field_id)));
  if (shouldFailAll) {
    res.writeHead(500, { "content-type": "application/json", "x-request-id": "req_w20_500" });
    res.end(JSON.stringify({ error: { message: "Simulated provider failure for retry test" } }));
    return;
  }

  const items = srcItems.map((it: any) => ({
    field_id: String(it.field_id),
    target_locale: tgtLoc,
    translated_text:
      tgtLoc === "en-US" ? `Translated ${it.source_text}` : `已翻译：${it.source_text}`,
    status: "translated",
    warnings: [],
  }));

  res.writeHead(200, { "content-type": "application/json", "x-request-id": `req_w20_${aiCallCount}` });
  res.end(
    JSON.stringify({
      id: `cmpl_w20_${aiCallCount}`,
      model: String(body.model ?? "gpt-4o-mini"),
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ items }) } }],
      usage: { prompt_tokens: 70, completion_tokens: 30 },
    }),
  );
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
    const contentType = res.headers.get("content-type") ?? "";
    const data = contentType.includes("text/csv") ? await res.text() : await res.json();
    assert.equal(
      res.status,
      expected,
      `${method} ${path} -> expected ${expected}, got ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
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

  const admin2Id = randomUUID();
  const admin2EmailId = randomUUID();
  await pool.query("insert into users(id, display_name, status) values($1, 'Admin2 W20', 'active')", [admin2Id]);
  await pool.query(
    "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
    [admin2EmailId, admin2Id, "admin2.w20@qcw.test", "admin2.w20@qcw.test"],
  );
  await pool.query(
    "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
    [admin2Id, admin2EmailId],
  );
  await pool.query("insert into staff_roles(user_id, role) values($1, 'super_admin')", [admin2Id]);
  await pool.query(
    "insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status) values($1, 'EMP-W20A', 'admin2.w20@qcw.test', 'active', 'active')",
    [admin2Id],
  );

  // Seed template_admin staff account for RBAC verification
  const tplId = randomUUID();
  const tplEmailId = randomUUID();
  await pool.query("insert into users(id, display_name, status) values($1, 'TplAdmin W20', 'active')", [tplId]);
  await pool.query(
    "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
    [tplEmailId, tplId, "tpl.w20@qcw.test", "tpl.w20@qcw.test"],
  );
  await pool.query(
    "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
    [tplId, tplEmailId],
  );
  await pool.query("insert into staff_roles(user_id, role) values($1, 'template_admin')", [tplId]);
  await pool.query(
    "insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status) values($1, 'EMP-W20T', 'tpl.w20@qcw.test', 'active', 'active')",
    [tplId],
  );

  // Seed pure inspector-only staff account (demo inspector@qcw.test also carries template_admin)
  const inspOnlyId = randomUUID();
  const inspOnlyEmailId = randomUUID();
  await pool.query("insert into users(id, display_name, status) values($1, 'InspOnly W20', 'active')", [inspOnlyId]);
  await pool.query(
    "insert into user_emails(id, user_id, original_email, normalized_email, is_primary, verified_at, login_enabled) values($1,$2,$3,$4,true,now(),true)",
    [inspOnlyEmailId, inspOnlyId, "insp.only.w20@qcw.test", "insp.only.w20@qcw.test"],
  );
  await pool.query(
    "insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id) values($1,'email_otp','qcwarehouse',($2::uuid)::text,'active',now(),$2)",
    [inspOnlyId, inspOnlyEmailId],
  );
  await pool.query("insert into staff_roles(user_id, role) values($1, 'inspector')", [inspOnlyId]);
  await pool.query(
    "insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status) values($1, 'EMP-W20I', 'insp.only.w20@qcw.test', 'active', 'active')",
    [inspOnlyId],
  );
});

after(async () => {
  registerTestAllowedAiEndpointOrigin(null);
  await new Promise<void>((resolve) => aiServer.close(() => resolve()));
  await pool.end();
});

test("PKG-3 Wave 20 (TASK-193): dynamic translation component workflow, diffs, human-lock protection, batches & real consumers", async (suite) => {
  const admin1 = new Client();
  await admin1.loginWithMfa("admin@qcw.test");
  const admin2 = new Client();
  await admin2.loginWithMfa("admin2.w20@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("tpl.w20@qcw.test");
  const inspector = new Client();
  await inspector.loginWithMfa("insp.only.w20@qcw.test");
  const customer = new Client();
  await customer.loginWithMfa("customer@qcw.test");

  const knowledgeEntityId = randomUUID();

  await suite.test("T01: manual fallback when unconfigured, glossary-first hit, non-translatable guard, and auto_blur/whole_form dedupe", async () => {
    // When no AI route is configured yet, auto_blur degrades honestly without blocking drafts, and explicit whole_form returns 409 AI_ROUTE_NOT_CONFIGURED
    const noRouteAuto = await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "auto_blur",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "inspection_template",
        entity_id: knowledgeEntityId,
        source_locale: "zh-CN",
        target_locale: "en-US",
        fields: [{ field_key: "title", source_text: "圆领针织短袖成衣检查规范", source_revision: 1 }],
      },
      "POST",
      200,
    );
    assert.equal(noRouteAuto.queued, false);
    assert.equal(noRouteAuto.manual_fallback, true);
    assert.equal(noRouteAuto.reason, "AI_ROUTE_NOT_CONFIGURED");

    const noRouteExplicit = await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "whole_form",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "inspection_template",
        entity_id: knowledgeEntityId,
        fields: [{ field_key: "title", source_text: "圆领针织短袖成衣检查规范" }],
      },
      "POST",
      409,
    );
    assert.equal(noRouteExplicit.error.code, "AI_ROUTE_NOT_CONFIGURED");

    // Non-translatable fields (sku_code, price_cents, etc.) must be rejected with 422 NON_TRANSLATABLE_FIELD
    const badField = await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "single_field",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "service_offer",
        entity_id: randomUUID(),
        fields: [{ field_key: "sku_code", source_text: "SKU-APP-01" }],
      },
      "POST",
      422,
    );
    assert.equal(badField.error.code, "NON_TRANSLATABLE_FIELD");

    // Configure & approve Wave 18 instance/model + Wave 19 prompts/evals/route for KNOWLEDGE_TRANSLATION_DRAFT
    const inst = await admin1.fetch(
      "/staff/admin/ai/instances",
      {
        instance_key: "w20-primary",
        display_name: "W20 AI Studio",
        adapter_type: "openai_compatible",
        api_protocol: "openai_chat_completions",
        environment: "production",
        base_url: `${aiOrigin}/v1`,
        data_region_policy: "US-ZDR",
        allowed_purposes: ["KNOWLEDGE_TRANSLATION_DRAFT", "CMS_TEMPLATE_TRANSLATION_DRAFT"],
      },
      "POST",
      201,
    );
    await admin1.fetch(`/staff/admin/ai/instances/${inst.instance.id}/secrets`, { secret_name: "api_key", secret_value: "sk-w20-123456" }, "POST", 201);
    await admin1.fetch(`/staff/admin/ai/instances/${inst.instance.id}/probe`, {}, "POST", 200);
    await admin2.fetch(`/staff/admin/ai/instances/${inst.instance.id}/approve`, {}, "POST", 200);

    const mod = await admin1.fetch(
      `/staff/admin/ai/instances/${inst.instance.id}/models`,
      { requested_model_id: "gpt-4o-mini", supports_structured_output: true },
      "POST",
      201,
    );
    await admin1.fetch(
      `/staff/admin/ai/models/${mod.model.id}/rates`,
      { currency: "USD", input_micros_per_1k_tokens: 150, output_micros_per_1k_tokens: 600, rate_source: "official_schedule" },
      "POST",
      201,
    );
    await admin1.fetch(`/staff/admin/ai/models/${mod.model.id}/test`, { target_locale: "en-US" }, "POST", 200);
    await admin2.fetch(`/staff/admin/ai/models/${mod.model.id}/approve`, {}, "POST", 200);

    await admin1.fetch("/staff/admin/ai/prompts/seed", {}, "POST", 201);
    await admin1.fetch("/staff/admin/ai/evals/seed", {}, "POST", 201);
    const prompts = (await admin1.fetch("/staff/admin/ai/prompts?purpose_code=KNOWLEDGE_TRANSLATION_DRAFT")).prompts;
    await admin2.fetch(`/staff/admin/ai/prompts/${prompts[0].id}/publish`, {}, "POST", 200);

    const routeDraft = await admin1.fetch(
      "/staff/admin/ai/routes",
      {
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        primary_instance_id: inst.instance.id,
        primary_model_id: mod.model.id,
        prompt_version_id: prompts[0].id,
      },
      "POST",
      201,
    );
    const evalRun = await admin1.fetch(
      "/staff/admin/ai/evals/run",
      {
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        route_version_id: routeDraft.route.id,
        candidates_by_case_code: {
          "EVAL-POM-HALF-CHEST":
            "Flat 1/2 chest width measured 2.5 cm below armhole, tolerance -0.5 cm to +0.5 cm.",
        },
      },
      "POST",
      201,
    );
    await reviewer.fetch(`/staff/admin/ai/evals/${evalRun.eval_run.id}/review`, { decision: "approved", notes: "OK" }, "POST", 200);
    await admin2.fetch(`/staff/admin/ai/routes/${routeDraft.route.id}/publish`, {}, "POST", 200);

    // Approved glossary term exact match resolves immediately at ZERO AI spend
    const gTerm = await admin1.fetch(
      "/staff/admin/ai/glossary",
      {
        domain: "apparel_qc",
        term_key: "pom_half_chest",
        source_locale: "zh-CN",
        source_term: "平铺半胸宽",
        target_locale: "en-US",
        target_term: "1/2 Flat Chest Width",
      },
      "POST",
      201,
    );
    await reviewer.fetch(`/staff/admin/ai/glossary/${gTerm.term.id}/approve`, {}, "POST", 200);

    const aiCallsBefore = aiCallCount;
    const mixedForm = await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "whole_form",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "inspection_template",
        entity_id: knowledgeEntityId,
        fields: [
          { field_key: "pom_name", source_text: "平铺半胸宽", source_revision: 1 },
          { field_key: "description", source_text: "腋下 2.5 cm 处测量并拍照留存", source_revision: 1 },
        ],
      },
      "POST",
      201 === 201 ? 200 : 200,
    );
    assert.equal(mixedForm.glossary_applied.length, 1);
    assert.equal(mixedForm.queued, true);

    // Repeating auto_blur for the same queued field deduplicates without creating another AI job
    const dupBlur = await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "auto_blur",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "inspection_template",
        entity_id: knowledgeEntityId,
        fields: [{ field_key: "description", source_text: "腋下 2.5 cm 处测量并拍照留存", source_revision: 1 }],
      },
      "POST",
      200,
    );
    assert.equal(dupBlur.queued, false);
    assert(dupBlur.deduplicated.length > 0 || dupBlur.skipped_protected.length > 0);

    await workOnce();
    assert.equal(aiCallCount, aiCallsBefore + 1, "Exact glossary hit must consume 0 AI calls; only uncached description calls AI once");
  });

  await suite.test("T02: human_locked protection, late stale candidates, diff/apply & optimistic concurrency conflict", async () => {
    const entId = randomUUID();
    // 1. Human saves & locks translation for `name`
    const humanCreated = await tplAdmin.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "defect_type",
        entity_id: entId,
        field_key: "name",
        locale: "en-US",
        source_locale: "zh-CN",
        source_revision: 1,
        source_text: "领口跳针",
        translated_text: "Collar Skipped Stitch (Verified)",
        translator_kind: "human",
      },
      "POST",
      201,
    );
    await reviewer.fetch(`/staff/admin/i18n/translations/${humanCreated.translation.id}/decide`, { decision: "lock_human" }, "POST", 200);

    // 2. Explicit force_retranslate runs AI, but NEVER overwrites human_locked row; stages candidate_text instead!
    await admin1.fetch(
      "/staff/admin/translations/request",
      {
        mode: "force_retranslate",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "defect_type",
        entity_id: entId,
        fields: [{ field_key: "name", source_text: "领口跳针", source_revision: 1 }],
      },
      "POST",
      200,
    );
    await workOnce();

    const diff = await reviewer.fetch(`/staff/admin/translations/${humanCreated.translation.id}/diff`);
    assert.equal(diff.current_text, "Collar Skipped Stitch (Verified)");
    assert.equal(diff.candidate_status, "pending_apply");
    assert(diff.candidate_text.includes("领口跳针"));

    // Optimistic concurrency: stale expected_revision -> 409 REVISION_CONFLICT
    const revConflict = await reviewer.fetch(
      `/staff/admin/translations/${humanCreated.translation.id}/apply-candidate`,
      { expected_revision: 99, confirm_overwrite_human_lock: true },
      "POST",
      409,
    );
    assert.equal(revConflict.error.code, "REVISION_CONFLICT");

    // Attempting apply without confirm_overwrite_human_lock -> 409 HUMAN_TRANSLATION_LOCKED
    const lockedErr = await reviewer.fetch(
      `/staff/admin/translations/${humanCreated.translation.id}/apply-candidate`,
      { expected_revision: 1, confirm_overwrite_human_lock: false },
      "POST",
      409,
    );
    assert.equal(lockedErr.error.code, "HUMAN_TRANSLATION_LOCKED");

    // 3. Late candidate arrival AFTER source_text changed -> marked stale_candidate & blocked from apply!
    await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "single_field",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "defect_type",
        entity_id: entId,
        fields: [{ field_key: "severity_note", source_text: "原始严重度说明 A", source_revision: 1 }],
      },
      "POST",
      200,
    );
    // Human updates source text to rev 2 BEFORE worker finishes rev 1 job!
    const v2Human = await tplAdmin.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "defect_type",
        entity_id: entId,
        field_key: "severity_note",
        locale: "en-US",
        source_locale: "zh-CN",
        source_revision: 2,
        source_text: "修改后严重度说明 B",
        translated_text: "Revised Severity Note B",
        translator_kind: "human",
      },
      "POST",
      201,
    );
    await workOnce();

    const staleDiff = await reviewer.fetch(`/staff/admin/translations/${v2Human.translation.id}/diff`);
    assert.equal(staleDiff.current_text, "Revised Severity Note B");
    assert.equal(staleDiff.candidate_status, "stale_candidate");
    const applyStale = await reviewer.fetch(
      `/staff/admin/translations/${v2Human.translation.id}/apply-candidate`,
      { expected_revision: Number(v2Human.translation.revision), confirm_overwrite_human_lock: true },
      "POST",
      409,
    );
    assert.equal(applyStale.error.code, "STALE_TRANSLATION_CANDIDATE");
  });

  await suite.test("T03: stale-on-source-edit, publication completeness gate, and SoD publish", async () => {
    const entId = randomUUID();
    const f1 = await tplAdmin.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "service_offer",
        entity_id: entId,
        field_key: "title",
        locale: "en-US",
        source_locale: "zh-CN",
        source_revision: 1,
        source_text: "标准逐件查验",
        translated_text: "Standard Item Inspection",
        translator_kind: "human",
        submit_for_review: true,
      },
      "POST",
      201,
    );

    // Missing `summary` field blocks entity publish (409 LOCALE_PUBLICATION_BLOCKED)
    const missingBlock = await reviewer.fetch(
      "/staff/admin/translations/publish-entity",
      {
        entity_type: "service_offer",
        entity_id: entId,
        required_fields: ["title", "summary"],
        required_locales: ["en-US"],
      },
      "POST",
      409,
    );
    assert.equal(missingBlock.error.code, "LOCALE_PUBLICATION_BLOCKED");

    // Even if `summary` exists as machine_draft / pending AI, publish-entity blocks it; once human-reviewed & different author, reviewer publishes cleanly!
    await tplAdmin.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "service_offer",
        entity_id: entId,
        field_key: "summary",
        locale: "en-US",
        source_locale: "zh-CN",
        source_revision: 1,
        source_text: "逐件尺量与拍照",
        translated_text: "Piece-by-piece measurement & photos",
        translator_kind: "human",
        submit_for_review: true,
      },
      "POST",
      201,
    );

    // Author (`tplAdmin` doesn't have reviewer role; test `admin1` authoring & failing SoD self-publish vs `reviewer` publishing)
    const selfDoc = await admin1.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "service_offer",
        entity_id: entId,
        field_key: "disclaimer",
        locale: "en-US",
        source_locale: "zh-CN",
        source_revision: 1,
        source_text: "非破坏性查验",
        translated_text: "Non-destructive inspection",
        translator_kind: "human",
        submit_for_review: true,
      },
      "POST",
      201,
    );
    const selfPub = await admin1.fetch(
      "/staff/admin/translations/publish-entity",
      {
        entity_type: "service_offer",
        entity_id: entId,
        required_fields: ["title", "summary", "disclaimer"],
        required_locales: ["en-US"],
      },
      "POST",
      403,
    );
    assert.equal(selfPub.error.code, "SOD_VIOLATION");

    const pubOk = await reviewer.fetch(
      "/staff/admin/translations/publish-entity",
      {
        entity_type: "service_offer",
        entity_id: entId,
        required_fields: ["title", "summary", "disclaimer"],
        required_locales: ["en-US"],
      },
      "POST",
      200,
    );
    assert.equal(pubOk.published_count, 3);
    void f1;
    void selfDoc;

    // Editing source marks published translation `stale` & blocks re-publish check until updated
    await admin1.fetch(
      "/staff/admin/i18n/translations/mark-stale",
      { entity_type: "service_offer", entity_id: entId, field_key: "title", new_source_text: "升级版逐件查验" },
      "POST",
      200,
    );
    const checkAfterStale = await reviewer.fetch(
      "/staff/admin/translations/publish-check",
      {
        entity_type: "service_offer",
        entity_id: entId,
        required_fields: ["title", "summary"],
        required_locales: ["en-US"],
      },
      "POST",
      200,
    );
    assert.equal(checkAfterStale.ready, false);
    assert.equal(checkAfterStale.blockers[0].status, "stale");

    // Re-translating stale `title` preserves v1 history cleanly and creates v2 without falsely flagging stale_candidate
    await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "single_field",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "service_offer",
        entity_id: entId,
        fields: [{ field_key: "title", source_text: "升级版逐件查验", source_revision: 2 }],
      },
      "POST",
      200,
    );
    while (await workOnce()) {}
    const titleHist = await admin1.fetch(
      `/staff/admin/i18n/translations?entity_type=service_offer&entity_id=${entId}&locale=en-US`,
    );
    const titleRows = titleHist.translations.filter((t: any) => t.field_key === "title");
    assert.equal(titleRows.length, 2);
    const latestTitle = titleRows[0];
    assert.equal(latestTitle.status, "machine_draft");
    assert.notEqual(latestTitle.candidate_status, "stale_candidate");
    const olderTitle = titleRows[1];
    assert.equal(olderTitle.source_text, "标准逐件查验", "Historical source_text must never be mutated in-place");

    // Staged candidate rejected via reject-candidate MUST NOT be applicable later (409 RECORD_CONFLICT)
    const sumDraft = await admin1.fetch(
      `/staff/admin/i18n/translations?entity_type=service_offer&entity_id=${entId}&locale=en-US`,
    );
    const sumRow = sumDraft.translations.find((t: any) => t.field_key === "summary");
    await admin1.fetch(
      "/staff/admin/translations/request",
      {
        mode: "force_retranslate",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "service_offer",
        entity_id: entId,
        fields: [{ field_key: "summary", source_text: "逐件尺量与拍照", source_revision: 1 }],
      },
      "POST",
      200,
    );
    while (await workOnce()) {}
    await reviewer.fetch(`/staff/admin/translations/${sumRow.id}/reject-candidate`, {}, "POST", 200);
    const applyRej = await reviewer.fetch(
      `/staff/admin/translations/${sumRow.id}/apply-candidate`,
      { confirm_overwrite_human_lock: true },
      "POST",
      409,
    );
    assert.equal(applyRej.error.code, "RECORD_CONFLICT");
  });

  await suite.test("T04: multi-entity batch preview (cost + protected skip), pause/resume/retry-failed, cancel & CSV formula-safe export", async () => {
    const eProtected = randomUUID();
    const locked = await tplAdmin.fetch(
      "/staff/admin/i18n/translations",
      {
        entity_type: "batch_doc",
        entity_id: eProtected,
        field_key: "safe_title",
        locale: "en-US",
        source_locale: "zh-CN",
        source_revision: 1,
        source_text: "人工已审词条",
        translated_text: "Verified Manual Title",
        translator_kind: "human",
      },
      "POST",
      201,
    );
    await reviewer.fetch(`/staff/admin/i18n/translations/${locked.translation.id}/decide`, { decision: "lock_human" }, "POST", 200);

    const eItem1 = randomUUID();
    const preview = await tplAdmin.fetch(
      "/staff/admin/translations/batches/preview",
      {
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        source_locale: "zh-CN",
        target_locale: "en-US",
        items: [
          { entity_type: "batch_doc", entity_id: eProtected, field_key: "safe_title", source_text: "人工已审词条" },
          { entity_type: "batch_doc", entity_id: eItem1, field_key: "pom_label", source_text: "平铺半胸宽" },
          { entity_type: "batch_doc", entity_id: eItem1, field_key: "fail_then_ok", source_text: "=CMD('calc') 缝线公差 1.5 cm" },
        ],
      },
      "POST",
      200,
    );
    assert.equal(preview.skipped_protected_items, 1);
    assert.equal(preview.glossary_hits, 1);
    assert.equal(preview.total_to_process, 2);
    assert.equal(typeof preview.estimated_cost_cents, "number");

    // Launch batch while `fail_then_ok` will fail first, then pause -> verify pause blocks worker execution
    const bKey = `batch-w20-${randomUUID()}`;
    const createdBatch = await tplAdmin.fetch(
      "/staff/admin/translations/batches",
      {
        idempotency_key: bKey,
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        source_locale: "zh-CN",
        target_locale: "en-US",
        items: [
          { entity_type: "batch_doc", entity_id: eProtected, field_key: "safe_title", source_text: "人工已审词条" },
          { entity_type: "batch_doc", entity_id: eItem1, field_key: "pom_label", source_text: "平铺半胸宽" },
          { entity_type: "batch_doc", entity_id: eItem1, field_key: "fail_then_ok", source_text: "=CMD('calc') 缝线公差 1.5 cm" },
        ],
      },
      "POST",
      201,
    );
    const batchId = createdBatch.batch.id as string;

    // Pause before worker runs -> worker must NOT call AI while paused!
    await tplAdmin.fetch(`/staff/admin/translations/batches/${batchId}/pause`, {}, "POST", 200);
    const aiBeforePause = aiCallCount;
    while (await workOnce()) {}
    assert.equal(aiCallCount, aiBeforePause, "Paused batch job must not call upstream AI provider");

    // Resume + simulate failure on `fail_then_ok`, verify `partial_failed` or `failed`, then retry failed!
    failFields = new Set(["fail_then_ok"]);
    await tplAdmin.fetch(`/staff/admin/translations/batches/${batchId}/resume`, {}, "POST", 200);
    while (await workOnce()) {}
    failFields = new Set();

    const detailFail = await tplAdmin.fetch(`/staff/admin/translations/batches/${batchId}`);
    assert.equal(detailFail.batch.status, "partial_failed");

    await tplAdmin.fetch(`/staff/admin/translations/batches/${batchId}/retry-failed`, {}, "POST", 200);
    while (await workOnce()) {}

    const detailDone = await tplAdmin.fetch(`/staff/admin/translations/batches/${batchId}`);
    assert.equal(detailDone.batch.status, "completed");

    // Verify CSV export requires super_admin + MFA and neutralizes formula injection `=CMD(...)`
    await tplAdmin.fetch(`/staff/admin/translations/batches/${batchId}/export`, undefined, "GET", 403);
    const csvText = (await admin1.fetch(`/staff/admin/translations/batches/${batchId}/export`, undefined, "GET", 200)) as string;
    assert(csvText.includes(`"'=CMD('calc')`), "CSV formula injection trigger must be neutralized with leading single quote");

    // Cancel a fresh queued batch before worker execution -> queued job cancelled cleanly
    const cancelBatch = await tplAdmin.fetch(
      "/staff/admin/translations/batches",
      {
        idempotency_key: `batch-cancel-${randomUUID()}`,
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        source_locale: "zh-CN",
        target_locale: "en-US",
        items: [{ entity_type: "batch_doc", entity_id: randomUUID(), field_key: "note", source_text: "待取消批量条目" }],
      },
      "POST",
      201,
    );
    await tplAdmin.fetch(`/staff/admin/translations/batches/${cancelBatch.batch.id}/cancel`, {}, "POST", 200);
    const aiBeforeCancel = aiCallCount;
    while (await workOnce()) {}
    assert.equal(aiCallCount, aiBeforeCancel);
    const cancelledDetail = await tplAdmin.fetch(`/staff/admin/translations/batches/${cancelBatch.batch.id}`);
    assert.equal(cancelledDetail.batch.status, "cancelled");

    // Multi-entity batch where two entities fail on SAME field_key (`name`) -> retryFailedBatchItems splits per entity without colliding!
    const multiA = randomUUID();
    const multiB = randomUUID();
    const multiBatch = await tplAdmin.fetch(
      "/staff/admin/translations/batches",
      {
        idempotency_key: `batch-multi-retry-${randomUUID()}`,
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        source_locale: "zh-CN",
        target_locale: "en-US",
        items: [
          { entity_type: "pom", entity_id: multiA, field_key: "name", source_text: "前衣长 A 68.5 cm" },
          { entity_type: "pom", entity_id: multiB, field_key: "name", source_text: "后衣长 B 70.0 cm" },
        ],
      },
      "POST",
      201,
    );
    failFields = new Set(["name"]);
    while (await workOnce()) {}
    failFields = new Set();
    const multiFailed = await tplAdmin.fetch(`/staff/admin/translations/batches/${multiBatch.batch.id}`);
    assert.equal(multiFailed.batch.status, "failed");

    const multiRetry = await tplAdmin.fetch(`/staff/admin/translations/batches/${multiBatch.batch.id}/retry-failed`, {}, "POST", 200);
    assert.equal(multiRetry.retried_count, 2);
    assert.equal(multiRetry.jobs.length, 2, "Retried multi-entity items must split per entity cleanly");
    while (await workOnce()) {}

    const multiDone = await tplAdmin.fetch(`/staff/admin/translations/batches/${multiBatch.batch.id}`);
    assert.equal(multiDone.batch.status, "completed");
    const trA = await admin1.fetch(`/staff/admin/i18n/translations?entity_type=pom&entity_id=${multiA}&locale=en-US`);
    const trB = await admin1.fetch(`/staff/admin/i18n/translations?entity_type=pom&entity_id=${multiB}&locale=en-US`);
    assert(trA.translations[0].translated_text.includes("68.5"));
    assert(trB.translations[0].translated_text.includes("70.0"));
  });

  await suite.test("T05: PAGE-M43 RBAC, customer workflow isolation & real catalog/template consumer bilingual flow", async () => {
    // Route RBAC parity for PAGE-M43 (`/admin/translations`)
    const route = resolvePortalRoute("/admin/translations");
    assert(route && route.view === "admin-translations");
    assert.equal(canOpenStaffPage("/admin/translations", route, ["template_admin"]), true);
    assert.equal(canOpenStaffPage("/admin/translations", route, ["reviewer"]), true);
    assert.equal(canOpenStaffPage("/admin/translations", route, ["inspector"]), false);

    // Pure inspector and customers are blocked across workflow, diff, publish-check & batch endpoints
    await inspector.fetch("/staff/admin/translations/batches", undefined, "GET", 403);
    await inspector.fetch(
      "/staff/admin/translations/request",
      { mode: "single_field", purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT", entity_type: "pom", entity_id: randomUUID(), fields: [{ field_key: "name", source_text: "Test" }] },
      "POST",
      403,
    );
    await inspector.fetch(
      "/staff/admin/translations/publish-check",
      { entity_type: "pom", entity_id: randomUUID(), required_fields: ["name"], required_locales: ["en-US"] },
      "POST",
      403,
    );
    await customer.fetch(
      "/staff/admin/translations/publish-check",
      { entity_type: "pom", entity_id: randomUUID(), required_fields: ["name"], required_locales: ["en-US"] },
      "POST",
      403,
    );
    // Customer cannot spoof internal workflow prefix to pollute global i18n_dynamic_translations
    const spoofRes = await customer.fetch(
      "/ai/translations/jobs",
      {
        idempotency_key: `wf:${randomUUID()}`,
        purpose_code: "SUPPORT_INBOUND_TRANSLATE",
        entity_type: "ticket",
        entity_id: randomUUID(),
        source_locale: "en-US",
        target_locale: "zh-CN",
        items: [{ field_id: "body", source_text: "Customer private message must never leak" }],
      },
      "POST",
      403,
    );
    assert.equal(spoofRes.error.code, "FORBIDDEN");

    // Real category consumer created through `/staff/admin/categories` uses `BilingualEntityPanel` API flow end-to-end
    const catRes = await tplAdmin.fetch(
      "/staff/admin/categories",
      { slug: `knitwear-w20-${randomUUID().slice(0, 6)}`, labels: { "zh-CN": "针织运动上衣", en: "Knit Active Tops" } },
      "POST",
      200,
    );
    const deskAfter = await admin1.fetch("/staff/admin/desk");
    const createdCat = deskAfter.categories.find((c: any) => c.slug === catRes.slug);
    assert(createdCat, "Category created via business route must appear on /staff/admin/desk");

    await tplAdmin.fetch(
      "/staff/admin/translations/request",
      {
        mode: "whole_form",
        purpose_code: "KNOWLEDGE_TRANSLATION_DRAFT",
        entity_type: "category",
        entity_id: createdCat.id,
        fields: [
          { field_key: "display_name", source_text: "针织运动上衣" },
          { field_key: "scope_note", source_text: "仅开放成人常规款查验" },
        ],
      },
      "POST",
      200,
    );
    while (await workOnce()) {}

    const catTranslations = await admin1.fetch(
      `/staff/admin/i18n/translations?entity_type=category&entity_id=${createdCat.id}&locale=en-US`,
    );
    assert.equal(catTranslations.translations.length >= 2, true);
    for (const row of catTranslations.translations) {
      await reviewer.fetch(`/staff/admin/i18n/translations/${row.id}/decide`, { decision: "approve" }, "POST", 200);
    }
    const pubCat = await reviewer.fetch(
      "/staff/admin/translations/publish-entity",
      {
        entity_type: "category",
        entity_id: createdCat.id,
        required_fields: ["display_name", "scope_note"],
        required_locales: ["en-US"],
      },
      "POST",
      200,
    );
    assert.equal(pubCat.published_count, 2);
  });
});
