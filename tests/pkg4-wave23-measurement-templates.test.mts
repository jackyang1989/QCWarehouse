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
let tShirtTemplateId = "";
let hoodieTemplateId = "";

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
    `insert into users(id, display_name, status, locale) values($1, 'Pure Inspector W23', 'active', 'zh-CN')`,
    [pureInspectorId],
  );
  await pool.query(
    `insert into user_emails(id, user_id, original_email, normalized_email, verified_at, is_primary, login_enabled)
     values($1, $2, 'insp.only.w23@qcw.test', 'insp.only.w23@qcw.test', now(), true, true)`,
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
     values($1, 'EMP-W23I', 'insp.only.w23@qcw.test', 'active', 'active')`,
    [pureInspectorId],
  );
});

after(async () => {
  await pool.end();
});

test("1. Idempotent 23-family SVG seed (54/54 §04 apparel) + 6 camera presets preserve admin edits", async () => {
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test"); // template_admin + inspector

  // Initialize knowledge base first so apparel product types exist for mapping checks
  await tplAdmin.fetch("/staff/admin/knowledge/seed-init", {}, "POST", 200);

  const seed1 = await tplAdmin.fetch("/staff/admin/measurement-templates/seed-init", {}, "POST", 200);
  assert.equal(seed1.inserted_counts.camera_presets, 6);
  assert.equal(seed1.inserted_counts.measurement_templates, 23);

  const overview1 = await tplAdmin.fetch("/staff/admin/measurement-templates/overview");
  assert.equal(Number(overview1.summary.total), 23);
  assert.equal(Number(overview1.summary.draft), 23); // Requires reviewer approval before publish
  assert.equal(Number(overview1.summary.published), 0);
  assert.equal(overview1.camera_presets.length, 6);

  const listRes = await tplAdmin.fetch("/staff/admin/measurement-templates");
  const templates: Record<string, any>[] = listRes.templates;
  assert.equal(templates.length, 23);

  // Verify ALL 54 §04 apparel product types are mapped across the 23 measurement templates!
  const kbPtRes = await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type");
  const apparelCodes = new Set<string>(
    (kbPtRes.items as Record<string, any>[])
      .filter((pt) => pt.category_slug === "apparel")
      .map((pt) => String(pt.code)),
  );
  assert.equal(apparelCodes.size, 54);
  const coveredCodes = new Set<string>();
  for (const t of templates) {
    for (const c of t.applicable_product_type_codes ?? []) coveredCodes.add(String(c));
  }
  const missingCodes = [...apparelCodes].filter((c) => !coveredCodes.has(c));
  assert.deepEqual(missingCodes, [], `Missing measurement mapping for apparel product types: ${missingCodes.join(",")}`);

  const byCode = new Map(templates.map((t) => [t.code, t]));
  const tee = byCode.get("short_sleeve_top");
  const pants = byCode.get("trousers_pants");
  const bra = byCode.get("sports_bra_intimates");
  const briefs = byCode.get("briefs_underwear");
  const tracksuit = byCode.get("two_piece_tracksuit_set");
  const hoodie = byCode.get("hoodie_sweatshirt");
  assert(tee && pants && bra && briefs && tracksuit && hoodie);
  tShirtTemplateId = tee.id;
  hoodieTemplateId = hoodie.id;

  // Verify garment-specific SVGs & POMs are distinct across garment families (§14)
  assert.equal(tee.views.length, 2); // front + back
  assert.equal(tee.views[0].view_key, "front");
  assert.equal(tee.views[1].view_key, "back");
  assert.notEqual(tee.views[0].svg, pants.views[0].svg);
  assert.notEqual(tee.views[0].svg, bra.views[0].svg);
  assert.notEqual(briefs.views[0].svg, bra.views[0].svg);
  assert.notEqual(hoodie.views[0].svg, hoodie.views[1].svg); // Back hoodie excludes front pocket!

  assert.equal(
    tee.points.some((p: Record<string, any>) => p.point_id === "pom_body_length_hps"),
    true,
  );
  assert.equal(
    tee.points.some((p: Record<string, any>) => /inseam|weight|gsm/i.test(p.point_id)),
    false,
    "Short sleeve top must not include trouser inseam or weight/GSM",
  );
  assert.equal(
    pants.points.some((p: Record<string, any>) => p.point_id === "pom_inseam_length"),
    true,
  );
  assert.equal(
    bra.points.some((p: Record<string, any>) => p.point_id === "pom_bra_underband_half"),
    true,
  );
  assert.equal(
    briefs.points.some((p: Record<string, any>) => p.point_id === "pom_briefs_front_rise"),
    true,
  );
  assert.equal(
    briefs.points.some((p: Record<string, any>) => /bra|strap|bust/i.test(p.point_id)),
    false,
    "Briefs must not include bra bust/strap points",
  );
  assert.equal(
    tracksuit.points.some((p: Record<string, any>) => p.point_id === "pom_set_bottom_inseam"),
    true,
  );

  // Admin edits short_sleeve_top description & saves draft -> second seed-init inserts 0 and keeps edit!
  const editedName = "短袖T恤测量模板（管理员已调图）";
  await tplAdmin.fetch("/staff/admin/measurement-templates", {
    id: tee.id,
    code: tee.code,
    name_zh: editedName,
    name_en: tee.name_en,
    description_zh: tee.description_zh,
    description_en: tee.description_en,
    applicable_product_type_codes: tee.applicable_product_type_codes,
    applicable_group_codes: tee.applicable_group_codes,
    default_unit: tee.default_unit,
    views: tee.views,
    points: tee.points,
    point_overrides: tee.point_overrides,
    camera_preset_codes: tee.camera_preset_codes,
  });

  const seed2 = await tplAdmin.fetch("/staff/admin/measurement-templates/seed-init", {}, "POST", 200);
  assert.equal(seed2.inserted_counts.camera_presets, 0);
  assert.equal(seed2.inserted_counts.measurement_templates, 0);

  const teeAfter = await tplAdmin.fetch(`/staff/admin/measurement-templates/${tee.id}`);
  assert.equal(teeAfter.template.name_zh, editedName);
  assert.equal(teeAfter.template.admin_modified, true);

  // Save/update camera preset
  const presetSaved = await tplAdmin.fetch("/staff/admin/measurement-templates/presets", {
    code: "macro_ruler_pom",
    name_zh: "标尺近景 POM 拍摄机位（高清校准）",
    name_en: "Macro Ruler POM Camera Preset (Calibrated)",
    view_key: "detail",
    framing_notes_zh: "确保游标尺零点与 POM 起点对齐且清晰无反光",
    framing_notes_en: "Align ruler zero mark cleanly with POM start point.",
    requires_scale_ruler: true,
    recommended_resolution: "3840x2160",
    sort_order: 3,
    active: true,
  });
  assert.equal(presetSaved.recommended_resolution, "3840x2160");
});

test("2. SVG XSS sanitizer, T28 duplicate point/marker rejection & §14 geometric POM guard", async () => {
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test");
  const detail = await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}`);
  const baseTpl = detail.template;

  // Reject unsafe SVG payloads including HTML entities, CSS escapes, style=, DTD/ENTITY & SVG <animate>/<use>
  const unsafePayloads = [
    `<svg viewBox="0 0 520 360"><script>alert(1)</script><rect width="10" height="10"/></svg>`,
    `<svg viewBox="0 0 520 360"><rect width="10" height="10" onload="fetch('https://evil.test')"/></svg>`,
    `<svg viewBox="0 0 520 360"><foreignObject width="10" height="10"><div>xss</div></foreignObject></svg>`,
    `<svg viewBox="0 0 520 360"><a href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>`,
    `<svg viewBox="0 0 520 360"><image href="https://evil.test/track.png" width="10" height="10"/></svg>`,
    `<svg viewBox="0 0 520 360"><rect width="10" height="10" style="background:&#x75;rl(https://evil.test/exfil)"/></svg>`,
    `<svg viewBox="0 0 520 360"><rect width="10" height="10" style="background:\\75 rl(https://evil.test/exfil)"/></svg>`,
    `<svg viewBox="0 0 520 360"><rect width="10" height="10" filter="&#117;rl(https://evil.test/x.svg#f)"/></svg>`,
    `<!DOCTYPE svg [<!ENTITY xxe "bad">]><svg viewBox="0 0 520 360"><rect width="10" height="10"/></svg>`,
    `<svg viewBox="0 0 520 360"><use href="#loop"/></svg>`,
    `<svg viewBox="0 0 520 360"><animate attributeName="href" to="javascript:alert(1)"/></svg>`,
    `<svg viewBox="0 0 520 360"><a href=https://evil.test><rect width="10" height="10"/></a></svg>`,
    `<svg viewBox="0 0 520 360"><a href="data:text/javascript,alert(1)"><rect width="10" height="10"/></a></svg>`,
  ];
  for (const badSvg of unsafePayloads) {
    const err = await tplAdmin.fetch(
      "/staff/admin/measurement-templates",
      {
        id: baseTpl.id,
        code: baseTpl.code,
        name_zh: baseTpl.name_zh,
        name_en: baseTpl.name_en,
        description_zh: baseTpl.description_zh,
        description_en: baseTpl.description_en,
        applicable_product_type_codes: baseTpl.applicable_product_type_codes,
        applicable_group_codes: baseTpl.applicable_group_codes,
        default_unit: "cm",
        views: [
          { view_key: "front", label_zh: "正面", label_en: "Front", svg: badSvg },
          baseTpl.views[1],
        ],
        points: baseTpl.points,
        point_overrides: baseTpl.point_overrides,
        camera_preset_codes: baseTpl.camera_preset_codes,
      },
      "POST",
      422,
    );
    assert.equal(err.error.code, "UNSAFE_SVG_CONTENT");
  }

  // Reject duplicate marker_code (T28)
  const dupMarkerPts = [
    ...baseTpl.points,
    { ...baseTpl.points[0], point_id: "pom_extra_dup_marker", marker_code: baseTpl.points[0].marker_code },
  ];
  const dupErr = await tplAdmin.fetch(
    "/staff/admin/measurement-templates",
    {
      id: baseTpl.id,
      code: baseTpl.code,
      name_zh: baseTpl.name_zh,
      name_en: baseTpl.name_en,
      description_zh: baseTpl.description_zh,
      description_en: baseTpl.description_en,
      applicable_product_type_codes: baseTpl.applicable_product_type_codes,
      applicable_group_codes: baseTpl.applicable_group_codes,
      default_unit: "cm",
      views: baseTpl.views,
      points: dupMarkerPts,
      point_overrides: baseTpl.point_overrides,
      camera_preset_codes: baseTpl.camera_preset_codes,
    },
    "POST",
    422,
  );
  assert.equal(dupErr.error.code, "DUPLICATE_MARKER_CODE");

  // Reject non-geometric weight/GSM measurement points including pom_ prefix (§14 separation)
  for (const [ptId, ptZh, ptEn] of [
    ["pom_fabric_gsm_weight", "克重测量", "Fabric GSM Weight"],
    ["pom_garment_weight", "成衣重量", "Finished Garment Weight"],
  ] as const) {
    const gsmPts = [
      ...baseTpl.points,
      {
        ...baseTpl.points[0],
        point_id: ptId,
        marker_code: "Z",
        name_zh: ptZh,
        name_en: ptEn,
        sort_order: 99,
      },
    ];
    const gsmErr = await tplAdmin.fetch(
      "/staff/admin/measurement-templates",
      {
        id: baseTpl.id,
        code: baseTpl.code,
        name_zh: baseTpl.name_zh,
        name_en: baseTpl.name_en,
        description_zh: baseTpl.description_zh,
        description_en: baseTpl.description_en,
        applicable_product_type_codes: baseTpl.applicable_product_type_codes,
        applicable_group_codes: baseTpl.applicable_group_codes,
        default_unit: "cm",
        views: baseTpl.views,
        points: gsmPts,
        point_overrides: baseTpl.point_overrides,
        camera_preset_codes: baseTpl.camera_preset_codes,
      },
      "POST",
      422,
    );
    assert.equal(gsmErr.error.code, "NON_GEOMETRIC_POINT_FORBIDDEN");
  }

  // Reject duplicate point_id, duplicate view_key, and duplicate template code without id (T28)
  const dupIdErr = await tplAdmin.fetch(
    "/staff/admin/measurement-templates",
    {
      id: baseTpl.id,
      code: baseTpl.code,
      name_zh: baseTpl.name_zh,
      name_en: baseTpl.name_en,
      description_zh: baseTpl.description_zh,
      description_en: baseTpl.description_en,
      applicable_product_type_codes: baseTpl.applicable_product_type_codes,
      applicable_group_codes: baseTpl.applicable_group_codes,
      default_unit: "cm",
      views: baseTpl.views,
      points: [...baseTpl.points, { ...baseTpl.points[0], marker_code: "Z" }],
      point_overrides: baseTpl.point_overrides,
      camera_preset_codes: baseTpl.camera_preset_codes,
    },
    "POST",
    422,
  );
  assert.equal(dupIdErr.error.code, "DUPLICATE_POINT_ID");

  const dupViewErr = await tplAdmin.fetch(
    "/staff/admin/measurement-templates",
    {
      id: baseTpl.id,
      code: baseTpl.code,
      name_zh: baseTpl.name_zh,
      name_en: baseTpl.name_en,
      description_zh: baseTpl.description_zh,
      description_en: baseTpl.description_en,
      applicable_product_type_codes: baseTpl.applicable_product_type_codes,
      applicable_group_codes: baseTpl.applicable_group_codes,
      default_unit: "cm",
      views: [baseTpl.views[0], baseTpl.views[0]],
      points: baseTpl.points,
      point_overrides: baseTpl.point_overrides,
      camera_preset_codes: baseTpl.camera_preset_codes,
    },
    "POST",
    422,
  );
  assert.equal(dupViewErr.error.code, "DUPLICATE_VIEW_KEY");

  const dupCodeErr = await tplAdmin.fetch(
    "/staff/admin/measurement-templates",
    {
      code: baseTpl.code,
      name_zh: baseTpl.name_zh,
      name_en: baseTpl.name_en,
      description_zh: baseTpl.description_zh,
      description_en: baseTpl.description_en,
      applicable_product_type_codes: baseTpl.applicable_product_type_codes,
      applicable_group_codes: baseTpl.applicable_group_codes,
      default_unit: "cm",
      views: baseTpl.views,
      points: baseTpl.points,
      point_overrides: baseTpl.point_overrides,
      camera_preset_codes: baseTpl.camera_preset_codes,
    },
    "POST",
    409,
  );
  assert.equal(dupCodeErr.error.code, "DUPLICATE_TEMPLATE_CODE");
});

test("3. Inheritance clone + overrides, SoD publish workflow & immutable DB freeze trigger", async () => {
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test");
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");

  // Clone hoodie_sweatshirt with inherit = true
  const cloned = await tplAdmin.fetch(
    `/staff/admin/measurement-templates/${hoodieTemplateId}/clone`,
    {
      code: "zip_hoodie_custom",
      name_zh: "拉链连帽卫衣自定义继承版",
      name_en: "Zip Hoodie Inherited Custom",
      inherit: true,
      applicable_product_type_codes: ["sweatshirt"],
    },
    "POST",
    201,
  );
  assert.equal(cloned.parent_template_id, hoodieTemplateId);

  // Override one point's tolerance, disable center_back_length, and add zipper track point
  const clonedDetail = await tplAdmin.fetch(`/staff/admin/measurement-templates/${cloned.id}`);
  assert(clonedDetail.effective.points.length >= 9);
  const overridden = await tplAdmin.fetch("/staff/admin/measurement-templates", {
    id: cloned.id,
    code: cloned.code,
    parent_template_id: hoodieTemplateId,
    name_zh: cloned.name_zh,
    name_en: cloned.name_en,
    description_zh: cloned.description_zh,
    description_en: cloned.description_en,
    applicable_product_type_codes: ["sweatshirt"],
    applicable_group_codes: ["tops"],
    default_unit: "cm",
    views: [],
    points: [],
    point_overrides: {
      disabled_point_ids: ["pom_center_back_length"],
      overridden_points: {
        pom_chest_width_half: { default_tolerance_plus: 2.0, default_tolerance_minus: 2.0 },
      },
      added_points: [
        {
          point_id: "pom_hoodie_zip_front",
          marker_code: "Z",
          view_key: "front",
          name_zh: "前门襟拉链长",
          name_en: "Center Front Zip Length",
          location_zh: "领口止口至底摆拉链止端",
          location_en: "Neck zip stop down to bottom hem zip box",
          method_zh: "拉合门襟垂直测量",
          method_en: "Zip closed and measure full zipper length vertically.",
          default_tolerance_plus: 0.8,
          default_tolerance_minus: 0.8,
          unit: "cm",
          sort_order: 20,
          is_required: true,
          color: "#0ea5e9",
          start_x: 260,
          start_y: 72,
          end_x: 260,
          end_y: 296,
          label_x: 274,
          label_y: 184,
          camera_preset_code: "detail_hardware_zipper",
          check_item_code: "CHK_M02_UPPER_BODY_POM",
        },
      ],
    },
    camera_preset_codes: ["overhead_flat_front", "macro_ruler_pom"],
  });
  assert(overridden.id);

  // Submit by template_admin
  await tplAdmin.fetch(`/staff/admin/measurement-templates/${cloned.id}/submit`, { note: "Ready for review" });

  // template_admin cannot publish (403)
  await tplAdmin.fetch(`/staff/admin/measurement-templates/${cloned.id}/publish`, {}, "POST", 403);

  // super_admin who did NOT create/submit could publish, OR reviewer publishes v1
  const pubRes = await reviewer.fetch(`/staff/admin/measurement-templates/${cloned.id}/publish`, {
    note: "Approved zip hoodie inherited POMs",
  });
  assert.equal(pubRes.version.version, 1);
  const snapPts = pubRes.version.effective_snapshot.points as Record<string, any>[];
  assert.equal(
    snapPts.some((p) => p.point_id === "pom_center_back_length"),
    false,
    "Disabled parent point must be excluded from effective snapshot",
  );
  assert.equal(
    snapPts.find((p) => p.point_id === "pom_chest_width_half")?.default_tolerance_plus,
    2.0,
  );
  assert.equal(
    snapPts.find((p) => p.point_id === "pom_chest_width_half")?.default_tolerance_minus,
    2.0,
  );
  assert.equal(
    snapPts.some((p) => p.point_id === "pom_hoodie_zip_front"),
    true,
  );

  // Submit & check self-review rejection for a reviewer who authored/submitted a draft
  const admin = new Client();
  await admin.loginWithMfa("admin@qcw.test"); // super_admin
  const selfDraft = await admin.fetch("/staff/admin/measurement-templates", {
    code: "self_sod_test_top",
    name_zh: "自我审核测试模板",
    name_en: "Self SoD Test Template",
    description_zh: "Test SoD",
    description_en: "Test SoD",
    applicable_product_type_codes: ["athletic_top"],
    applicable_group_codes: ["tops"],
    default_unit: "cm",
    views: clonedDetail.effective.views,
    points: [snapPts[0]],
    point_overrides: { disabled_point_ids: [], overridden_points: {}, added_points: [] },
    camera_preset_codes: ["overhead_flat_front"],
  });
  await admin.fetch(`/staff/admin/measurement-templates/${selfDraft.id}/submit`, {});
  const selfErr = await admin.fetch(`/staff/admin/measurement-templates/${selfDraft.id}/publish`, {}, "POST", 403);
  assert.equal(selfErr.error.code, "SELF_REVIEW_FORBIDDEN");

  // Batch publish SoD transaction atomicity: mixed batch including self-authored template fails & publishes nothing
  await admin.fetch("/staff/admin/measurement-templates/batch-publish", { ids: [selfDraft.id] }, "POST", 403);

  // Cyclic parent_template_id inheritance detection (TEMPLATE_CYCLE)
  const cycErr = await tplAdmin.fetch(
    "/staff/admin/measurement-templates",
    {
      id: hoodieTemplateId,
      code: "hoodie_sweatshirt",
      parent_template_id: cloned.id,
      name_zh: "Cycle Test",
      name_en: "Cycle Test",
      description_zh: "",
      description_en: "",
      applicable_product_type_codes: ["hoodie"],
      applicable_group_codes: ["tops"],
      default_unit: "cm",
      views: [],
      points: [],
      point_overrides: { disabled_point_ids: [], overridden_points: {}, added_points: [] },
      camera_preset_codes: ["overhead_flat_front"],
    },
    "POST",
    422,
  );
  assert.equal(cycErr.error.code, "TEMPLATE_CYCLE");

  // DB immutability trigger on measurement_template_versions
  await assert.rejects(
    async () => {
      await pool.query(
        "update measurement_template_versions set effective_snapshot = '{}'::jsonb where id = $1::uuid",
        [pubRes.version.id],
      );
    },
    /immutable/i,
  );
});

test("4. T127 immutable task freeze + real catalog/compiler/inspection consumers + bilingual overlay + rollback/retire + RBAC", async () => {
  const reviewer = new Client();
  await reviewer.loginWithMfa("reviewer@qcw.test");
  const tplAdmin = new Client();
  await tplAdmin.loginWithMfa("inspector@qcw.test");
  const inspOnly = new Client();
  await inspOnly.loginWithMfa("insp.only.w23@qcw.test");

  // Reviewer approves & publishes seeded short_sleeve_top (v1)
  await reviewer.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/publish`, {
    note: "Publish short_sleeve_top v1 for T127 test",
  });

  // Also publish catalog product type t_shirt + inspection modules so /catalog/form-schema & compile-preview resolve cleanly
  const ptList = await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type?search=t_shirt");
  const tShirtPt = ptList.items.find((p: Record<string, any>) => p.code === "t_shirt");
  assert(tShirtPt);
  await reviewer.fetch("/staff/admin/knowledge/entities/product_type/batch-publish", {
    ids: [tShirtPt.id],
    public_sellable: true,
    note: "Publish t_shirt for form-schema",
  });
  const modList = await tplAdmin.fetch("/staff/admin/knowledge/entities/inspection_module");
  await reviewer.fetch("/staff/admin/knowledge/entities/inspection_module/batch-publish", {
    ids: modList.items.map((m: Record<string, any>) => m.id),
    public_sellable: true,
    note: "Publish inspection modules for compile-preview",
  });

  // Verify public /catalog/form-schema and compile-preview return measurement_template v1
  const anon = new Client();
  const offersRes = await anon.fetch("/catalog");
  const offerId = offersRes.offers[0].offer_id;
  const schemaV1 = await anon.fetch(`/catalog/form-schema?offer_id=${offerId}&product_type_code=t_shirt`);
  assert.equal(schemaV1.measurement_template.published_version, 1);
  assert.equal(schemaV1.measurement_template.views.length, 2);

  // Prepare a READY inspection task linked to product_type_code='t_shirt' and start it via HTTP -> freezes v1!
  const custMembership = (
    await pool.query<{ user_id: string; org_id: string }>(
      `select m.user_id, m.org_id
       from memberships m
       join user_emails ue on ue.user_id = m.user_id
       where ue.normalized_email = 'customer@qcw.test'
       limit 1`,
    )
  ).rows[0];
  assert(custMembership, "Expected demo customer membership");
  const offerTpl = (
    await pool.query<{ offer_id: string; category_id: string; template_version_id: string }>(
      `select ot.offer_id, ot.category_id, ot.template_version_id
       from offer_templates ot
       join categories c on c.id = ot.category_id
       where c.labels->>'en' = 'Apparel'
       limit 1`,
    )
  ).rows[0];
  assert(offerTpl, "Expected demo Apparel offer_template");
  const storageLoc = (await pool.query<{ id: string }>("select id from storage_locations limit 1")).rows[0];
  assert(storageLoc, "Expected demo storage location");

  const orderId = randomUUID();
  const orderLineId = randomUUID();
  const expectedItemId = randomUUID();
  const pkgId = randomUUID();
  const itemId = randomUUID();
  const linkId = randomUUID();
  const readyTaskId = randomUUID();
  await pool.query(
    `insert into orders (id, public_no, org_id, created_by, state, revision)
     values ($1, $2, $3, $4, 'queued', 1)`,
    [orderId, `QW-W23-${orderId.slice(0, 8).toUpperCase()}`, custMembership.org_id, custMembership.user_id],
  );
  await pool.query(
    `insert into order_lines (id, order_id, org_id, offer_id, category_id, template_version_id, quantity, options, attributes)
     values ($1, $2, $3, $4, $5, $6, 1, '{}'::jsonb, '{"product_type_code":"t_shirt"}'::jsonb)`,
    [orderLineId, orderId, custMembership.org_id, offerTpl.offer_id, offerTpl.category_id, offerTpl.template_version_id],
  );
  await pool.query(
    `insert into expected_items (id, order_line_id, position, declared_fields)
     values ($1, $2, 1, '{"product_type_code":"t_shirt"}'::jsonb)`,
    [expectedItemId, orderLineId],
  );
  await pool.query(
    `insert into packages (id, code, org_id, received_by, received_at, received_quantity, state)
     values ($1, $2, $3, $4, now(), 1, 'stored')`,
    [pkgId, `P-W23-${pkgId.slice(0, 6).toUpperCase()}`, custMembership.org_id, pureInspectorId],
  );
  await pool.query(
    `insert into warehouse_items (id, code, org_id, package_id, intake_batch_id, identity_state, condition_state, custody_state, location_id, received_at)
     values ($1, $2, $3, $4, $5, 'matched', 'normal', 'stored', $6, now())`,
    [itemId, `S-W23-${itemId.slice(0, 6).toUpperCase()}`, custMembership.org_id, pkgId, randomUUID(), storageLoc.id],
  );
  await pool.query(
    `insert into order_line_item_links (id, org_id, order_line_id, expected_item_id, item_id, linked_at)
     values ($1, $2, $3, $4, $5, now())`,
    [linkId, custMembership.org_id, orderLineId, expectedItemId, itemId],
  );
  const readyTask = (
    await pool.query<{ id: string; revision: number }>(
      `insert into inspection_tasks (id, order_line_id, template_version_id, assignment_id, state, revision)
       values ($1, $2, $3, $4, 'READY', 1)
       returning id, revision`,
      [readyTaskId, orderLineId, offerTpl.template_version_id, linkId],
    )
  ).rows[0]!;

  await inspOnly.fetch(`/staff/inspection-tasks/${readyTask.id}/start`, { revision: readyTask.revision }, "POST", 200);
  const taskBeforeUpgrade = await inspOnly.fetch(`/staff/inspection-tasks/${readyTask.id}`);
  assert(taskBeforeUpgrade.measurement_template_version_id, "Starting task must freeze measurement_template_version_id");
  assert.equal(taskBeforeUpgrade.measurement_diagram.published_version, 1);

  // Draft applicable_product_type_codes isolation check: saving v2 draft WITHOUT "t_shirt" in applicable_product_type_codes
  // must NOT break live v1 form-schema lookup while v2 is unapproved!
  const detailV1 = await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}`);
  const tplRaw = detailV1.template;
  const ptsV2 = [
    ...tplRaw.points,
    {
      ...tplRaw.points[0],
      point_id: "pom_collar_rib_height",
      marker_code: "K",
      view_key: "front",
      name_zh: "领口罗纹高",
      name_en: "Collar Rib Height",
      sort_order: 15,
    },
  ];
  await tplAdmin.fetch("/staff/admin/measurement-templates", {
    id: tplRaw.id,
    code: tplRaw.code,
    name_zh: tplRaw.name_zh,
    name_en: tplRaw.name_en,
    description_zh: tplRaw.description_zh,
    description_en: tplRaw.description_en,
    applicable_product_type_codes: ["athletic_top"], // temporarily removed t_shirt in draft!
    applicable_group_codes: tplRaw.applicable_group_codes,
    default_unit: tplRaw.default_unit,
    views: tplRaw.views,
    points: ptsV2,
    point_overrides: tplRaw.point_overrides,
    camera_preset_codes: tplRaw.camera_preset_codes,
  });
  const schemaDuringDraft = await anon.fetch(`/catalog/form-schema?offer_id=${offerId}&product_type_code=t_shirt`);
  assert.equal(schemaDuringDraft.measurement_template.published_version, 1, "Unapproved draft must NOT take live v1 offline");

  // Restore t_shirt onto v2 draft, submit & publish v2
  await tplAdmin.fetch("/staff/admin/measurement-templates", {
    id: tplRaw.id,
    code: tplRaw.code,
    name_zh: tplRaw.name_zh,
    name_en: tplRaw.name_en,
    description_zh: tplRaw.description_zh,
    description_en: tplRaw.description_en,
    applicable_product_type_codes: tplRaw.applicable_product_type_codes,
    applicable_group_codes: tplRaw.applicable_group_codes,
    default_unit: tplRaw.default_unit,
    views: tplRaw.views,
    points: ptsV2,
    point_overrides: tplRaw.point_overrides,
    camera_preset_codes: tplRaw.camera_preset_codes,
  });
  await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/submit`, { note: "Submit v2" });
  const pubV2 = await reviewer.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/publish`, {
    note: "Publish t_shirt v2",
  });
  assert.equal(pubV2.version.version, 2);

  // T127 core invariant: ALREADY started task STILL gets v1 without pom_collar_rib_height,
  // while new catalog form-schema & compile-preview get v2!
  const taskAfterUpgrade = await inspOnly.fetch(`/staff/inspection-tasks/${readyTask.id}`);
  assert.equal(taskAfterUpgrade.measurement_diagram.published_version, 1);
  assert.equal(
    taskAfterUpgrade.measurement_diagram.points.some((p: Record<string, any>) => p.point_id === "pom_collar_rib_height"),
    false,
  );

  const schemaV2 = await anon.fetch(`/catalog/form-schema?offer_id=${offerId}&product_type_code=t_shirt`);
  assert.equal(schemaV2.measurement_template.published_version, 2);
  assert.equal(
    schemaV2.measurement_template.points.some((p: Record<string, any>) => p.point_id === "pom_collar_rib_height"),
    true,
  );

  const compiledV2 = await tplAdmin.fetch("/staff/admin/knowledge/compile-preview", {
    product_type_code: "t_shirt",
    selected_module_codes: ["M01", "M02"],
    available_capabilities: ["measurement_tool"],
  });
  assert.equal(compiledV2.measurement_template.published_version, 2);

  // Bilingual dynamic translation overlay on measurement_template_point changes text ONLY, preserving SVG coordinates!
  const createdTrans = await tplAdmin.fetch(
    "/staff/admin/i18n/translations",
    {
      entity_type: "measurement_template_point",
      entity_id: tShirtTemplateId,
      field_key: "pom_body_length_hps.name",
      locale: "en-US",
      source_locale: "zh-CN",
      source_revision: 1,
      source_text: "衣长 (HPS)",
      translated_text: "HPS Body Length (Verified Overlay)",
      submit_for_review: true,
    },
    "POST",
    201,
  );
  await reviewer.fetch(`/staff/admin/i18n/translations/${createdTrans.translation.id}/decide`, { decision: "publish" });

  const schemaTranslated = await anon.fetch(`/catalog/form-schema?offer_id=${offerId}&product_type_code=t_shirt`);
  const translatedPt = schemaTranslated.measurement_template.points.find(
    (p: Record<string, any>) => p.point_id === "pom_body_length_hps",
  );
  assert.equal(translatedPt.name_en, "HPS Body Length (Verified Overlay)");
  assert.equal(translatedPt.start_x, 232);
  assert.equal(translatedPt.start_y, 58);

  // Rollback v2 -> v1 creates draft requiring re-review while preserving v1 & v2 history, then retire preserves frozen task
  const rolledDraft = await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/rollback`, {
    target_version: 1,
    note: "Rollback to v1 draft",
  });
  assert.equal(rolledDraft.status, "draft");
  const versionsRes = await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/versions`);
  assert.equal(versionsRes.versions.length, 2);

  await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/retire`, { note: "Retire test" });
  const schemaAfterRetire = await anon.fetch(`/catalog/form-schema?offer_id=${offerId}&product_type_code=t_shirt`);
  assert.equal(schemaAfterRetire.measurement_template, null, "Retired template must not resolve for new catalog orders");

  // Rolling back a RETIRED template to draft must NOT reactivate live catalog before reviewer approves!
  await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/rollback`, {
    target_version: 1,
    note: "Rollback retired template back to draft",
  });
  const schemaAfterRetiredRollback = await anon.fetch(`/catalog/form-schema?offer_id=${offerId}&product_type_code=t_shirt`);
  assert.equal(
    schemaAfterRetiredRollback.measurement_template,
    null,
    "Rolling back a retired template must NOT bypass reviewer approval to go live",
  );

  // Also test saving a draft directly over a retired template: re-publish v3 -> retire -> save draft -> MUST stay null on live catalog!
  await reviewer.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/publish`, { note: "Publish v3 before retire+draft test" });
  await tplAdmin.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/retire`, { note: "Retire v3" });
  await tplAdmin.fetch("/staff/admin/measurement-templates", {
    id: tplRaw.id,
    code: tplRaw.code,
    name_zh: `${tplRaw.name_zh}（退役后重编辑草稿）`,
    name_en: tplRaw.name_en,
    description_zh: tplRaw.description_zh,
    description_en: tplRaw.description_en,
    applicable_product_type_codes: tplRaw.applicable_product_type_codes,
    applicable_group_codes: tplRaw.applicable_group_codes,
    default_unit: tplRaw.default_unit,
    views: tplRaw.views,
    points: tplRaw.points,
    point_overrides: tplRaw.point_overrides,
    camera_preset_codes: tplRaw.camera_preset_codes,
  });
  const schemaAfterRetiredDraftEdit = await anon.fetch(`/catalog/form-schema?offer_id=${offerId}&product_type_code=t_shirt`);
  assert.equal(
    schemaAfterRetiredDraftEdit.measurement_template,
    null,
    "Saving a draft over a retired template must NOT reactivate old published version before reviewer approval",
  );

  // Frozen inspection task (T127) STILL resolves v1 intact!
  const taskAfterRetire = await inspOnly.fetch(`/staff/inspection-tasks/${readyTask.id}`);
  assert.equal(taskAfterRetire.measurement_diagram.published_version, 1);

  // Publish stale/mismatched dynamic translation source_text (e.g. from future v2 wording) -> frozen v1 ignores mismatched overlay!
  const mismatchedTrans = await tplAdmin.fetch(
    "/staff/admin/i18n/translations",
    {
      entity_type: "measurement_template_point",
      entity_id: tShirtTemplateId,
      field_key: "pom_chest_width_half.name",
      locale: "en-US",
      source_locale: "zh-CN",
      source_revision: 2,
      source_text: "未来修订版修改后的胸宽中文原义",
      translated_text: "Future Mismatched Chest Overlay",
      submit_for_review: true,
    },
    "POST",
    201,
  );
  await reviewer.fetch(`/staff/admin/i18n/translations/${mismatchedTrans.translation.id}/decide`, { decision: "publish" });
  const taskFrozenSourceGuard = await inspOnly.fetch(`/staff/inspection-tasks/${readyTask.id}`);
  const chestPtFrozen = taskFrozenSourceGuard.measurement_diagram.points.find(
    (p: Record<string, any>) => p.point_id === "pom_chest_width_half",
  );
  assert.notEqual(chestPtFrozen.name_en, "Future Mismatched Chest Overlay");

  // Publish ALL remaining apparel product types + target apparel templates & verify sets/kids/briefs/craft compile cleanly
  const unpubPts = (await tplAdmin.fetch("/staff/admin/knowledge/entities/product_type")).items
    .filter((p: Record<string, any>) => p.category_slug === "apparel" && p.status !== "published")
    .map((p: Record<string, any>) => p.id);
  if (unpubPts.length > 0) {
    await reviewer.fetch("/staff/admin/knowledge/entities/product_type/batch-publish", {
      ids: unpubPts,
      public_sellable: true,
      note: "Publish remaining apparel types",
    });
  }
  const allMt = (await tplAdmin.fetch("/staff/admin/measurement-templates")).templates as Record<string, any>[];
  for (const [sampleCode, expectPt] of [
    ["tracksuit_set", "pom_set_bottom_inseam"],
    ["kids_apparel", "pom_kids_body_length_hps"],
    ["heavy_embroidery_apparel", "pom_craft_motif_span"],
    ["underwear_briefs", "pom_briefs_front_rise"],
  ] as const) {
    const tObj = allMt.find((t) => (t.applicable_product_type_codes ?? []).includes(sampleCode));
    assert(tObj);
    if (tObj.status !== "published") {
      await reviewer.fetch(`/staff/admin/measurement-templates/${tObj.id}/publish`, { note: `Publish ${sampleCode}` });
    }
    const comp = await tplAdmin.fetch("/staff/admin/knowledge/compile-preview", {
      product_type_code: sampleCode,
      selected_module_codes: ["M01", "M02"],
      available_capabilities: ["measurement_tool"],
    });
    assert(comp.measurement_template, `Expected measurement_template for ${sampleCode}`);
    assert.equal(
      comp.measurement_template.points.some((p: Record<string, any>) => p.point_id === expectPt),
      true,
    );
  }

  // RBAC: pure inspector denied admin measurement writes & PAGE-M23 (/admin/measurement-templates), anon denied reads
  await anon.fetch("/staff/admin/measurement-templates/overview", undefined, "GET", 401);
  await inspOnly.fetch("/staff/admin/measurement-templates/overview", undefined, "GET", 200);
  await inspOnly.fetch("/staff/admin/measurement-templates/seed-init", {}, "POST", 403);
  await inspOnly.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/submit`, {}, "POST", 403);
  await inspOnly.fetch(`/staff/admin/measurement-templates/${tShirtTemplateId}/publish`, {}, "POST", 403);

  const route = resolvePortalRoute("/admin/measurement-templates");
  assert(route);
  assert.equal(canOpenStaffPage("/admin/measurement-templates", route, ["super_admin"]), true);
  assert.equal(canOpenStaffPage("/admin/measurement-templates", route, ["template_admin"]), true);
  assert.equal(canOpenStaffPage("/admin/measurement-templates", route, ["reviewer"]), true);
  assert.equal(canOpenStaffPage("/admin/measurement-templates", route, ["inspector"]), false);
  assert(staffTabs("admin", ["reviewer"]).some(([p]) => p === "/admin/measurement-templates"));
  assert.deepEqual(
    staffTabs("admin", ["template_admin"]).map(([p]) => p),
    ["/admin", "/admin/settings", "/admin/translations"],
  );
});
