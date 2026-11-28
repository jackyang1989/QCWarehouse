import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
const { resolvePortalRoute, canOpenStaffPage, staffTabs } = await import("../packages/core/portal-routes");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

let pureInspectorId = "";
let tShirtId = "";
let bagsPlaceholderId = "";
let modM05Id = "";

before(async () => {
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

  pureInspectorId = randomUUID();
  const inspEmailId = randomUUID();
  await pool.query(
    `insert into users(id, display_name, status, locale) values($1, 'Pure Inspector W22', 'active', 'zh-CN')`,
    [pureInspectorId],
  );
  await pool.query(
    `insert into user_emails(id, user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
     values($1, $2, 'insp.only.w22@qcw.test', 'insp.only.w22@qcw.test', now(), true, true)`,
    [inspEmailId, pureInspectorId],
  );
  await pool.query(
    `insert into auth_identities(user_id, provider, issuer, subject, status, linked_at, email_id)
     values($1, 'email_otp', 'qcwarehouse', ($2::uuid)::text, 'active', now(), $2)`,
    [pureInspectorId, inspEmailId],
  );
  await pool.query(`insert into staff_roles(user_id, role) values($1, 'inspector')`, [pureInspectorId]);
  await pool.query(
    `insert into staff_profiles(user_id, employee_no, work_email, employment_status, account_security_status)
     values($1, 'EMP-W22I', 'insp.only.w22@qcw.test', 'active', 'active')`,
    [pureInspectorId],
  );
});

after(async () => {
  await pool.end();
});

test("1. Idempotent §04/§05 apparel knowledge init preserves admin edits & seeds v1 baseline snapshots", async () => {
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test"); // template_admin + inspector in demo seed

  const seed1 = await tplAdmin.fetch("/staff/admin/knowledge/seed-init", {}, "POST", 200);
  assert.equal(seed1.inserted_counts.complexity_levels, 5);
  assert.equal(seed1.inserted_counts.inspection_modules, 11);
  assert.equal(seed1.inserted_counts.product_types, 56); // 54 exact §04 apparel + 2 closed non-apparel
  assert.equal(seed1.inserted_counts.garment_parts, 24);
  assert.equal(seed1.inserted_counts.defect_types, 19);
  assert.equal(seed1.inserted_counts.rework_types, 9);
  assert.equal(seed1.inserted_counts.sops, 6);
  assert(seed1.inserted_counts.check_items >= 23);
  assert(seed1.inserted_counts.terminology_entries >= 32);
  assert.equal(seed1.apparel_total_count, 54);
  assert.equal(seed1.apparel_published_sellable_count, 0); // Must require independent review before publishing!
  assert.equal(seed1.non_apparel_closed_count, 2);

  // Verify §05 exact module pricing_tiers & draft_unverified protection
  const mods = await tplAdmin.fetch("/staff/admin/knowledge/entities/inspection_module");
  const modMap = new Map<string, Record<string, any>>(mods.items.map((m: Record<string, any>) => [m.code, m]));
  assert.equal(modMap.get("M01")?.suggested_price_cents, 500);
  assert.equal(modMap.get("M02")?.pricing_tiers?.points_5_cents, 1200);
  assert.equal(modMap.get("M02")?.pricing_tiers?.points_8_cents, 1800);
  assert.equal(modMap.get("M02")?.pricing_tiers?.extra_point_cents, 300);
  assert.equal(modMap.get("M03")?.suggested_price_cents, 500);
  assert.equal(modMap.get("M04")?.suggested_price_cents, 700);
  assert.equal(modMap.get("M05")?.pricing_tiers?.garment_weight_cents, 200);
  assert.equal(modMap.get("M05")?.pricing_tiers?.fabric_gsm_destructive_cents, 1200);
  assert.equal(modMap.get("M06")?.pricing_tiers?.functional_test_group_cents, 500);
  assert.equal(modMap.get("M07")?.pricing_tiers?.label_verification_cents, 400);
  assert.equal(modMap.get("M07")?.pricing_tiers?.print_embroidery_cents, 500);
  assert.equal(modMap.get("M08")?.pricing_tiers?.piece_packaging_cents, 300);
  assert.equal(modMap.get("M08")?.pricing_tiers?.outer_carton_cents, 600);
  assert.equal(modMap.get("M09")?.pricing_tiers?.extra_5_photos_cents, 500);
  assert.equal(modMap.get("M09")?.pricing_tiers?.detail_photo_cents, 300);
  assert.equal(modMap.get("M10")?.pricing_tiers?.up_to_30s_cents, 800);
  assert.equal(modMap.get("M10")?.pricing_tiers?.up_to_120s_cents, 2000);
  assert.equal(modMap.get("M11")?.module_tier, "manual_quote");
  for (const m of mods.items) assert.equal(m.pricing_status, "draft_unverified");

  // Verify §04 specific types explicitly exist across all 6 apparel groups
  const pts = await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type");
  const ptCodes = new Set(pts.items.map((x: Record<string, unknown>) => x.code));
  for (const requiredCode of [
    "t_shirt",
    "chiffon_blouse",
    "yoga_pants",
    "pleated_skirt",
    "yoga_set",
    "varsity_baseball_jacket",
    "shapewear_bodysuit",
    "wedding_dress",
    "special_material_apparel",
  ]) {
    assert(ptCodes.has(requiredCode), `Missing exact §04 apparel type: ${requiredCode}`);
  }

  const tShirt = pts.items.find((x: Record<string, unknown>) => x.code === "t_shirt");
  const bags = pts.items.find((x: Record<string, unknown>) => x.code === "bags_general");
  assert(tShirt && bags);
  assert.equal(bags.public_sellable, false);
  assert.equal(bags.capability_status, "not_admitted");
  tShirtId = tShirt.id;
  bagsPlaceholderId = bags.id;
  const m05 = modMap.get("M05")!;
  modM05Id = m05.id;

  // Admin edits BOTH t_shirt AND M05 (bumping version to v2 while preserving seed_v1 history!)
  const editedShirt = await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type", {
    id: tShirtId,
    code: "t_shirt",
    category_slug: "apparel",
    group_code: "tops",
    group_name_zh: "上装",
    group_name_en: "Tops",
    name_zh: "重磅圆领T恤（人工修订）",
    name_en: "Heavyweight Crewneck T-Shirt (Edited)",
    aliases: ["tee", "edited tee"],
    default_complexity_code: "L1",
    structural_options: tShirt.structural_options,
    billing_unit: "piece",
    included_components: [],
    applicable_module_codes: tShirt.applicable_module_codes,
    quote_mode: "online_standard",
    capability_status: "ready",
    sort_order: 1,
    note: "Edit t_shirt before repeat seed",
  });
  assert.equal(editedShirt.version, 2);

  const editedM05 = await tplAdmin.fetch("/staff/admin/knowledge/entities/inspection_module", {
    id: modM05Id,
    code: "M05",
    name_zh: "整衣重量及面料GSM（人工编辑版）",
    name_en: "Weight & GSM (Admin Edited)",
    description_zh: m05.description_zh,
    description_en: m05.description_en,
    module_tier: m05.module_tier,
    billing_unit: m05.billing_unit,
    suggested_price_cents: 250,
    pricing_tiers: m05.pricing_tiers,
    depends_on_codes: m05.depends_on_codes,
    conflicts_with_codes: m05.conflicts_with_codes,
    requires_capability_codes: m05.requires_capability_codes,
    scope_boundary_zh: m05.scope_boundary_zh,
    scope_boundary_en: m05.scope_boundary_en,
    is_destructive_possible: m05.is_destructive_possible,
    requires_customer_authorization: m05.requires_customer_authorization,
    sort_order: m05.sort_order,
    note: "Edit M05 before repeat seed",
  });
  assert.equal(editedM05.version, 2);

  // Repeat seed run MUST be 100% idempotent and preserve BOTH admin edits
  const seed2 = await tplAdmin.fetch("/staff/admin/knowledge/seed-init", {}, "POST", 200);
  for (const k of Object.keys(seed2.inserted_counts)) {
    assert.equal(seed2.inserted_counts[k], 0);
    assert(seed2.skipped_existing_counts[k] > 0);
  }
  const tShirtAfter = (await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type?search=t_shirt")).items.find(
    (x: Record<string, unknown>) => x.code === "t_shirt",
  );
  const m05After = (await tplAdmin.fetch("/staff/admin/knowledge/entities/inspection_module?search=M05")).items.find(
    (x: Record<string, unknown>) => x.code === "M05",
  );
  assert.equal(tShirtAfter.name_zh, "重磅圆领T恤（人工修订）");
  assert.equal(m05After.suggested_price_cents, 250);

  // Rollback M05 to seed_v1 -> restores original $2.00 suggested_price_cents & name as draft_unverified!
  const rolledM05 = await tplAdmin.fetch(`/staff/admin/knowledge/entities/inspection_module/${modM05Id}/rollback`, {
    target_version: 1,
    note: "Restore M05 seed_v1 baseline",
  });
  assert.equal(rolledM05.suggested_price_cents, 200);
  assert.equal(rolledM05.pricing_status, "draft_unverified");
  assert.equal(rolledM05.requires_commercial_approval, true);
  assert.equal(rolledM05.status, "draft");
});

test("2. Strict RBAC (template_admin cannot publish), SoD (author/submitter cannot approve), closure, clone & retire", async () => {
  const author = new Client();
  await author.loginWithMfa("inspector@qcw.test"); // template_admin + inspector ONLY
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const superAdmin = new Client();
  await superAdmin.loginWithMfa("admin@qcw.test");

  // Author submits t_shirt; template_admin MUST NOT be allowed to publish (even another author's entry -> 403 FORBIDDEN)
  await author.fetch(`/staff/admin/knowledge/entities/product_type/${tShirtId}/submit`, { note: "Ready for review" });
  await author.fetch(`/staff/admin/knowledge/entities/product_type/${tShirtId}/publish`, {}, "POST", 403);
  await author.fetch(`/staff/admin/knowledge/entities/inspection_module/${modM05Id}/publish`, {}, "POST", 403);

  // Submitter SoD test: superAdmin creates/submits a separate complexity item, or superAdmin submits reviewer's/author's item -> submitted_by === actor.id blocked!
  await superAdmin.fetch(`/staff/admin/knowledge/entities/product_type/${tShirtId}/submit`, { note: "SuperAdmin re-submits" });
  await superAdmin.fetch(`/staff/admin/knowledge/entities/product_type/${tShirtId}/publish`, {}, "POST", 403); // SELF_REVIEW_FORBIDDEN even for super_admin!

  // Independent reviewer publishes all L1-L5, M01-M11, 54 apparel product types, check items, parts, defects, reworks, terminology, SOPs
  const publishAllKind = async (kind: string, filterFn?: (row: Record<string, unknown>) => boolean, publicSellable?: boolean) => {
    const res = await reviewer.fetch(`/staff/admin/knowledge/entities/${kind}`);
    const ids = res.items
      .filter((r: Record<string, unknown>) => r.status !== "published" && (!filterFn || filterFn(r)))
      .map((r: Record<string, unknown>) => r.id);
    if (ids.length > 0) {
      await reviewer.fetch(`/staff/admin/knowledge/entities/${kind}/batch-publish`, {
        ids,
        ...(publicSellable !== undefined ? { public_sellable: publicSellable } : {}),
        note: "Independent reviewer batch approval",
      });
    }
  };

  await publishAllKind("complexity_level");
  await publishAllKind("inspection_module");
  await publishAllKind("product_type", (r) => r.category_slug === "apparel", true);
  await publishAllKind("check_item");
  await publishAllKind("garment_part");
  await publishAllKind("defect_type");
  await publishAllKind("rework_type");
  await publishAllKind("terminology");
  await publishAllKind("sop");

  // Non-apparel closed placeholders cannot be opened publicly (422 CATEGORY_NOT_ADMITTED),
  // AND even if internally published as draft-closed (`public_sellable: false`), task compiler still rejects non-admitted category!
  await reviewer.fetch(`/staff/admin/knowledge/entities/product_type/${bagsPlaceholderId}/publish`, { public_sellable: true }, "POST", 422);
  await reviewer.fetch(`/staff/admin/knowledge/entities/product_type/${bagsPlaceholderId}/publish`, { public_sellable: false }, "POST", 200);
  await superAdmin.fetch("/staff/admin/knowledge/compile-preview", { product_type_code: "bags_general" }, "POST", 422);

  // Clone t_shirt -> t_shirt_oversized, publish by reviewer, retire without losing history
  const cloned = await author.fetch(
    `/staff/admin/knowledge/product-types/${tShirtId}/clone`,
    { code: "t_shirt_oversized", name_zh: "落肩宽松T恤", name_en: "Oversized Drop-Shoulder Tee" },
    "POST",
    201,
  );
  assert.equal(cloned.parent_type_id, tShirtId);
  await author.fetch(`/staff/admin/knowledge/entities/product_type/${cloned.id}/submit`, {});
  await reviewer.fetch(`/staff/admin/knowledge/entities/product_type/${cloned.id}/publish`, { public_sellable: true });

  await author.fetch(`/staff/admin/knowledge/entities/product_type/${cloned.id}/retire`, { note: "Seasonal archive" });
  await author.fetch("/catalog/form-schema?product_type_code=t_shirt_oversized", undefined, "GET", 404);
  await superAdmin.fetch("/staff/admin/knowledge/compile-preview", { product_type_code: "t_shirt_oversized" }, "POST", 422);
  const cloneHistory = await reviewer.fetch(`/staff/admin/knowledge/entities/product_type/${cloned.id}/history`);
  assert(cloneHistory.history.some((h: Record<string, unknown>) => h.action === "retire"));

  // Verify PUT /staff/admin/categories/{pack}/status works by slug!
  await superAdmin.fetch(
    "/staff/admin/categories/apparel/status",
    {
      status: "ACTIVE",
      admission_snapshot: {
        sop_ref: "SOP-APPAREL-2026-V1",
        pilot_evidence: "Verified W22 apparel pilot via slug",
        training_completed: true,
        equipment_verified: true,
      },
    },
    "PUT",
    200,
  );
});

test("3. Real public catalog, offer form-schema, task compiler, bilingual overlay & live inspection consumer", async () => {
  const anon = new Client();
  const catRes = await anon.fetch("/catalog");
  assert(Array.isArray(catRes.offers) && catRes.offers.length > 0);
  assert.equal(catRes.knowledge_catalog.product_types.length, 54);
  assert.equal(catRes.knowledge_catalog.groups.length, 6);
  assert.equal(catRes.knowledge_catalog.product_types.some((pt: Record<string, unknown>) => pt.code === "bags_general"), false);
  assert.equal(catRes.knowledge_catalog.product_types.some((pt: Record<string, unknown>) => pt.code === "t_shirt_oversized"), false);
  for (const pt of catRes.knowledge_catalog.product_types) {
    assert.equal(pt.default_complexity_code, undefined, "Customer catalog must not leak internal L1-L5 codes");
  }

  // Test /catalog/form-schema with BOTH offer_id AND product_type_code
  const apparelOffer = catRes.offers[0];
  const formSchema = await anon.fetch(
    `/catalog/form-schema?offer_id=${apparelOffer.offer_id}&product_type_code=down_jacket`,
  );
  assert.equal(formSchema.product_type.code, "down_jacket");
  assert.equal(formSchema.offer_template.offer_id, apparelOffer.offer_id);
  assert.equal(formSchema.included_base_modules.length, 1); // M01 Base
  assert.equal(formSchema.included_base_modules[0].code, "M01");
  assert.equal(formSchema.included_base_modules[0].addon_billable, false);
  assert(formSchema.optional_addon_modules.some((m: Record<string, unknown>) => m.code === "M02"));

  const staff = new Client();
  await staff.loginWithMfa("inspector@qcw.test");
  // M01 passed as selected_module_codes deduplicates cleanly into included_base_modules (never in billable_addon_modules)
  // M05 non-destructive gross weight works with calibrated_scale; M05 destructive GSM fails without customer_authorized_destructive!
  const compiled = await staff.fetch("/staff/admin/knowledge/compile-preview", {
    product_type_code: "t_shirt",
    selected_module_codes: ["M01", "M02", "M03", "M05"],
    available_capabilities: ["measurement_tool", "calibrated_scale"],
  });
  assert.equal(compiled.manual_quote_required, false);
  assert.deepEqual(
    compiled.billable_addon_modules.map((m: Record<string, unknown>) => m.code),
    ["M02", "M03", "M05"],
  );
  assert.equal(compiled.check_items.some((c: Record<string, unknown>) => c.code === "CHK_M05_GARMENT_GROSS_WEIGHT"), true);
  assert.equal(compiled.check_items.some((c: Record<string, unknown>) => c.code === "CHK_M05_DESTRUCTIVE_GSM_CUT"), false);

  // Requesting destructive GSM option WITHOUT customer authorization MUST fail with 422!
  await staff.fetch(
    "/staff/admin/knowledge/compile-preview",
    {
      product_type_code: "t_shirt",
      selected_module_codes: ["M05"],
      selected_module_options: { M05: "fabric_gsm_destructive" },
      available_capabilities: ["calibrated_scale", "fabric_gsm_cutter"],
      customer_authorized_destructive: false,
    },
    "POST",
    422,
  );
  const gsmCompiled = await staff.fetch("/staff/admin/knowledge/compile-preview", {
    product_type_code: "t_shirt",
    selected_module_codes: ["M05"],
    selected_module_options: { M05: "fabric_gsm_destructive" },
    available_capabilities: ["calibrated_scale", "fabric_gsm_cutter"],
    customer_authorized_destructive: true,
  });
  assert.equal(gsmCompiled.check_items.some((c: Record<string, unknown>) => c.code === "CHK_M05_DESTRUCTIVE_GSM_CUT"), true);

  // L5 garment compiles with manual_quote_required = true
  const customCompiled = await staff.fetch("/staff/admin/knowledge/compile-preview", {
    product_type_code: "wedding_dress",
    selected_module_codes: ["M11"],
  });
  assert.equal(customCompiled.manual_quote_required, true);

  // Publish dynamic translation on catalog_product_type -> verified to reflect in public GET /catalog!
  const manualTrans = await staff.fetch(
    "/staff/admin/i18n/translations",
    {
      entity_type: "catalog_product_type",
      entity_id: tShirtId,
      field_key: "name",
      locale: "en-US",
      source_locale: "zh-CN",
      source_revision: 1,
      source_text: "重磅圆领T恤（人工修订）",
      translated_text: "Heavyweight Crewneck Tee (Bilingual Published)",
      submit_for_review: true,
    },
    "POST",
    201,
  );
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  await reviewer.fetch(`/staff/admin/i18n/translations/${manualTrans.translation.id}/decide`, {
    decision: "publish",
  });
  const catWithOverlay = await anon.fetch("/catalog");
  const overlayShirt = catWithOverlay.knowledge_catalog.product_types.find(
    (p: Record<string, unknown>) => p.code === "t_shirt",
  );
  assert.equal(overlayShirt.name_en, "Heavyweight Crewneck Tee (Bilingual Published)");
});

test("4. Pure inspector cannot spoof capabilities, export blocked, RBAC/sidebar parity & live inspection task blueprint", async () => {
  const inspOnly = new Client();
  await inspOnly.loginWithMfa("insp.only.w22@qcw.test");
  await inspOnly.fetch("/staff/admin/knowledge/seed-init", {}, "POST", 403);
  await inspOnly.fetch("/staff/admin/knowledge/export", undefined, "GET", 403);

  // Pure inspector attempting to spoof available_capabilities=["fabric_gsm_cutter"] must be stripped -> 422!
  await inspOnly.fetch(
    "/staff/admin/knowledge/compile-preview",
    {
      product_type_code: "t_shirt",
      selected_module_codes: ["M05"],
      selected_module_options: { M05: "fabric_gsm_destructive" },
      available_capabilities: ["calibrated_scale", "fabric_gsm_cutter"],
      customer_authorized_destructive: true,
    },
    "POST",
    422,
  );

  // RBAC & sidebar visibility parity
  const route = resolvePortalRoute("/admin/knowledge");
  assert(route);
  assert.equal(canOpenStaffPage("/admin/knowledge", route, ["super_admin"]), true);
  assert.equal(canOpenStaffPage("/admin/knowledge", route, ["template_admin"]), true);
  assert.equal(canOpenStaffPage("/admin/knowledge", route, ["reviewer"]), true);
  assert.equal(canOpenStaffPage("/admin/knowledge", route, ["inspector"]), false);
  assert(staffTabs("admin", ["reviewer"]).some(([p]) => p === "/admin/knowledge"));
  assert.deepEqual(
    staffTabs("admin", ["template_admin"]).map(([p]) => p),
    ["/admin", "/admin/settings", "/admin/translations"],
  );

  // Live inspection task consumer check: link an existing inspection task order line with product_type_code = 't_shirt'
  // and verify GET /staff/inspection-tasks/:id returns compiled knowledge_blueprint!
  const existingTask = (await pool.query<{ id: string; order_line_id: string }>("select id, order_line_id from inspection_tasks limit 1")).rows[0];
  if (existingTask) {
    await pool.query(
      `update order_lines set attributes = coalesce(attributes, '{}'::jsonb) || '{"product_type_code":"t_shirt"}'::jsonb where id = $1`,
      [existingTask.order_line_id],
    );
    const taskRes = await inspOnly.fetch(`/staff/inspection-tasks/${existingTask.id}`);
    assert(taskRes.knowledge_blueprint);
    assert.equal(taskRes.knowledge_blueprint.product_type.code, "t_shirt");
    assert(taskRes.knowledge_blueprint.check_items.some((c: Record<string, unknown>) => c.module_code === "M01"));
  }
});
