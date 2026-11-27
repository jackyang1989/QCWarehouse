import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
const { handle } = await import("../packages/core/http");
const { pool, transaction } = await import("../packages/db");
const { addEmailOtpIdentity } = await import("../packages/core/auth");
const { seedAuthoritativeChinaRegions } = await import("../packages/core/regions-seed");

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
    ["admin", "receiving", "inspector"].map((n) => n + "@qcw.test"),
  ]);
});

after(() => pool.end());

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
  async loginOtp(email: string) {
    const otp = await this.fetch("/auth/otp/request", { email }, "POST", 202);
    return this.fetch("/auth/otp/verify", { challenge_id: otp.challenge_id, code: otp.demo_code });
  }
}

async function createCustomer(prefix: string) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@qcw.test`;
  const c = new Client();
  await c.loginOtp(email);
  const { terms } = await c.fetch("/public/terms");
  await c.fetch("/auth/registration/complete", {
    terms_version_ids: terms.filter((t: { kind: string }) => ["terms", "privacy"].includes(t.kind)).map((t: { id: string }) => t.id),
  });
  return { client: c, email };
}

async function createSecondAdmin() {
  const email = `reg-admin2-${randomUUID().slice(0, 6)}@qcw.test`;
  const userId = randomUUID();
  await transaction(async (db) => {
    await db.query("insert into users(id,display_name,locale) values($1,'Region Reviewer','zh-CN')", [userId]);
    const ver = await db.query<{ id: string }>(
      `insert into user_emails(user_id,original_email,normalized_email,verified_at,is_primary,login_enabled)
       values($1,$2::text,($2::text)::citext,now(),true,true) returning id`,
      [userId, email],
    );
    await addEmailOtpIdentity(db, userId, ver.rows[0].id);
    await db.query("insert into staff_roles(user_id,role) values($1,'super_admin')", [userId]);
  });
  const c = new Client();
  await c.loginOtp(email);
  return { client: c, userId };
}

test("TASK-181 (REG01-16 & COM01): complete GB/T 2260 region DB, special tiers, bilingual search, parse without member_code, version governance & immutable snapshots", async () => {
  const anon = new Client();
  // Before seed: honest not-ready overview
  const beforeSeed = await anon.fetch("/regions/overview");
  assert.equal(beforeSeed.ready, false);

  // REG01: Full @province-city-china/data seed + idempotent re-run preservation
  const seed1 = await transaction((db) => seedAuthoritativeChinaRegions(db, { includeTownships: true }));
  assert.equal(seed1.skipped, false);
  assert.equal(seed1.counts.provinces, 34);
  assert.equal(seed1.counts.prefectures, 333);
  assert.equal(seed1.counts.counties, 2873);
  assert.equal(seed1.counts.townships, 38930);

  const seed2 = await transaction((db) => seedAuthoritativeChinaRegions(db, { includeTownships: true }));
  assert.equal(seed2.skipped, true);

  const overview = await anon.fetch("/regions/overview");
  assert.equal(overview.ready, true);
  assert.equal(overview.active_version.province_count, 34);
  assert.equal(overview.active_version.township_count, 38930);

  // REG02: Special administrative hierarchies (municipalities, terminal prefectures, province-direct counties, autonomous prefectures, HK/MO/TW)
  const bjSearch = await anon.fetch("/regions/search?q=110105");
  const bjChaoyang = bjSearch.items.find((x: { official_code: string }) => x.official_code === "110105");
  assert.ok(bjChaoyang);
  assert.equal(bjChaoyang.ancestors.length, 2); // 北京市 -> 朝阳区 (NO synthetic 市辖区 tier)
  assert.equal(bjChaoyang.ancestors[0].official_code, "110000");

  const dgSearch = await anon.fetch("/regions/search?q=Dongguan");
  const dongguan = dgSearch.items.find((x: { official_code: string }) => x.official_code === "441900");
  assert.ok(dongguan);
  assert.equal(dongguan.is_terminal_official, true);
  const dgValid = await anon.fetch("/regions/validate-path", { prefecture_id: dongguan.id });
  assert.equal(dgValid.domestic_auto_quote_eligible, true);

  const jiyuan = (await anon.fetch("/regions/search?q=419001")).items.find(
    (x: { official_code: string }) => x.official_code === "419001",
  );
  assert.ok(jiyuan);
  assert.equal(jiyuan.ancestors.length, 2); // 河南省 -> 济源市 (NO synthetic 419000 node)
  assert.equal(jiyuan.ancestors[0].official_code, "410000");

  const hkCentral = (await anon.fetch("/regions/search?q=810001")).items[0];
  assert.equal(hkCentral.market_scope, "hk_mo_tw");
  const hkValid = await anon.fetch("/regions/validate-path", { county_id: hkCentral.id });
  assert.equal(hkValid.domestic_auto_quote_eligible, false);

  // Autonomous prefecture / league / banner exist in DB
  const specialTypes = (
    await pool.query<{ t: string }>(
      "select distinct admin_type as t from regions where admin_type = any($1::text[])",
      [["autonomous_prefecture", "league", "banner", "forestry_district"]],
    )
  ).rows.map((r) => r.t);
  assert.equal(specialTypes.length, 4);

  // REG03: Bilingual / code / alias search + duplicate district ambiguity + forged path rejection (422)
  const szSearch = await anon.fetch("/regions/search?q=Shenzhen");
  assert.ok(szSearch.items.some((x: { official_code: string }) => x.official_code === "440300"));
  const yueSearch = await anon.fetch("/regions/search?q=%E7%B2%A4");
  assert.ok(yueSearch.items.some((x: { official_code: string }) => x.official_code === "440000"));
  const dupSearch = await anon.fetch("/regions/search?q=%E6%9C%9D%E9%98%B3%E5%8C%BA");
  assert.ok(dupSearch.items.length >= 2);
  assert.equal(dupSearch.items[0].ambiguous_name, true);

  const nanshan = (await anon.fetch("/regions/search?q=440305")).items[0];
  await anon.fetch(
    "/regions/validate-path",
    { province_id: bjChaoyang.ancestors[0].id, county_id: nanshan.id },
    "POST",
    422,
  );

  // Paginated children check + malformed query params return 422 (never 500)
  const provPage = await anon.fetch("/regions/children?level=province&limit=10&offset=0");
  assert.equal(provPage.items.length, 10);
  await anon.fetch("/regions/children?parent_id=not-a-uuid", undefined, "GET", 422);
  await anon.fetch("/regions/children?limit=abc", undefined, "GET", 422);

  // REG04 & COM01: Unified paste parser without member_code / insert_position fields
  const { client: cust1 } = await createCustomer("addr1");
  const { client: cust2 } = await createCustomer("addr2");

  // Conflicting province/prefecture vs county ("广州市" vs "南山区") must trigger needs_confirmation instead of auto-selecting
  const conflictHierarchyParse = await cust1.fetch("/addresses/parse", {
    raw_text: "张伟 13812345678 广东省广州市南山区科技园1号",
  });
  assert.equal(conflictHierarchyParse.needs_confirmation, true);
  assert.equal(conflictHierarchyParse.ready_for_dispatch, false);
  assert.ok(conflictHierarchyParse.candidates.length >= 1);

  const forwarderPaste = await cust1.fetch("/addresses/parse", {
    raw_text: "张伟(CW8899) 13812345678\n广东省深圳市南山区科技园南区高新南一道88号(入库码CW8899)",
  });
  assert.equal("member_code" in forwarderPaste, false);
  assert.equal("insert_position" in forwarderPaste, false);
  assert.equal(forwarderPaste.recipient_name, "张伟(CW8899)");
  assert.equal(forwarderPaste.contact_phone_normalized, "13812345678");
  assert.equal(forwarderPaste.region_path.county.official_code, "440305");
  assert.ok(forwarderPaste.detail_address.includes("CW8899"));
  assert.equal(forwarderPaste.ready_for_dispatch, true);

  // Ambiguous duplicate district without province/city -> needs_confirmation + multiple candidates
  const ambiguousParse = await cust1.fetch("/addresses/parse", {
    raw_text: "李四 13900139000 朝阳区建国路88号",
  });
  assert.equal(ambiguousParse.needs_confirmation, true);
  assert.ok(ambiguousParse.candidates.length >= 2);

  // Landline + extension supported; masked phone flagged non-dispatchable & blocked for domestic snapshot (422)
  const landlineParse = await cust1.fetch("/addresses/parse", {
    raw_text: "王五 0755-82345678-102 广东省深圳市福田区华强北路1号",
  });
  assert.equal(landlineParse.contact_phone_normalized, "0755-82345678-102");
  const maskedParse = await cust1.fetch("/addresses/parse", {
    raw_text: "赵六 138****5678 广东省深圳市南山区粤海街道1号",
  });
  assert.equal(maskedParse.contact_phone_masked, true);
  assert.equal(maskedParse.ready_for_dispatch, false);
  await cust1.fetch(
    "/addresses/snapshots",
    {
      purpose: "freight_forwarder",
      recipient_name: "赵六",
      contact_phone_raw: "138****5678",
      county_region_id: nanshan.id,
      detail_address: "粤海街道1号",
    },
    "POST",
    422,
  );

  // HK / international address recognized & excluded from domestic auto quote
  const hkParse = await cust1.fetch("/addresses/parse", {
    raw_text: "Chan Tai Man +852-91234567 香港特别行政区中西区皇后大道中99号",
  });
  assert.equal(hkParse.market_scope, "hk_mo_tw");
  assert.equal(hkParse.domestic_auto_quote_eligible, false);

  // REG12 & REG15: Immutable address_snapshots + cross-tenant isolation
  const snap = await cust1.fetch(
    "/addresses/snapshots",
    {
      purpose: "freight_forwarder",
      raw_input_text: forwarderPaste.raw_input_text,
      recipient_name: "张伟(CW8899)",
      contact_phone_raw: "13812345678",
      county_region_id: nanshan.id,
      detail_address: "科技园南区高新南一道88号(入库码CW8899)",
    },
    "POST",
    201,
  );
  assert.equal(snap.domestic_deliverable, true);
  await cust2.fetch(`/addresses/snapshots/${snap.id}`, undefined, "GET", 403);
  await assert.rejects(
    () => pool.query("update address_snapshots set recipient_name = 'Tampered' where id = $1", [snap.id]),
    /immutable/,
  );

  // REG10 & REG11: Version import validation, mass-deletion guard, SoD publish, notification/event & rollback
  const admin = new Client();
  await admin.loginOtp("admin@qcw.test");
  const { client: admin2 } = await createSecondAdmin();
  await cust1.fetch("/staff/admin/regions/versions", undefined, "GET", 403);

  const sampleRegions = [
    {
      code_system: "mca_gbt2260" as const,
      official_code: "440000",
      level: "province" as const,
      admin_type: "province",
      name_zh: "广东省",
      name_en: "Guangdong Province",
      pinyin: "Guangdong",
      parent_official_code: null,
    },
    {
      code_system: "mca_gbt2260" as const,
      official_code: "440300",
      level: "prefecture" as const,
      admin_type: "prefecture_city",
      name_zh: "深圳市",
      name_en: "Shenzhen",
      pinyin: "Shenzhen",
      parent_official_code: "440000",
    },
    {
      code_system: "mca_gbt2260" as const,
      official_code: "440305",
      level: "county" as const,
      admin_type: "district",
      name_zh: "南山区(新版命名)",
      name_en: "Nanshan District",
      pinyin: "Nanshan",
      parent_official_code: "440300",
    },
  ];

  // Mass deletion >10% rejected without allow_mass_deletion
  await admin.fetch(
    "/staff/admin/regions/import",
    {
      version_code: "v-test-2027-blocked",
      source_name: "MCA Test Update",
      source_url: "https://example.invalid/mca",
      license: "MIT",
      data_as_of: "2027-01-01",
      source_sha256: "a".repeat(64),
      regions: sampleRegions,
    },
    "POST",
    422,
  );

  // Orphan parent / bad code rejected without mutating active version
  await admin.fetch(
    "/staff/admin/regions/import",
    {
      version_code: "v-test-2027-orphan",
      source_name: "Bad Orphan Update",
      source_url: "https://example.invalid/mca",
      license: "MIT",
      data_as_of: "2027-01-01",
      source_sha256: "b".repeat(64),
      allow_mass_deletion: true,
      regions: [{ ...sampleRegions[2], parent_official_code: "999999" }],
    },
    "POST",
    422,
  );

  // Valid staged draft -> SoD blocks self-publish -> Admin2 publishes -> Admin2 rolls back to v1 cleanly
  const draft = await admin.fetch(
    "/staff/admin/regions/import",
    {
      version_code: "v-test-2027.01",
      source_name: "MCA Controlled Release",
      source_url: "https://example.invalid/mca-2027",
      license: "MIT",
      data_as_of: "2027-01-01",
      source_sha256: "c".repeat(64),
      allow_mass_deletion: true,
      regions: sampleRegions,
      change_mappings: [
        {
          from_official_code: "440305",
          to_official_code: "440305",
          change_type: "renamed",
          effective_date: "2027-01-01",
          evidence_note: "Controlled rename test",
        },
      ],
    },
    "POST",
    201,
  );
  assert.equal(draft.status, "staged");
  assert.equal(draft.diff_summary.renamed, 1);

  await admin.fetch(`/staff/admin/regions/versions/${draft.id}/publish`, { reason: "Self publish blocked" }, "POST", 403);
  // Cannot activate an unapproved staged draft via rollback (closes SoD bypass)
  await admin2.fetch(`/staff/admin/regions/versions/${draft.id}/rollback`, { reason: "Illegal rollback to draft" }, "POST", 409);

  const pub = await admin2.fetch(`/staff/admin/regions/versions/${draft.id}/publish`, { reason: "Independent review pass" });
  assert.equal(pub.status, "active");

  // Verify outbox_events and staff notification created for dataset publication
  const pubSignals = (
    await pool.query<{ events: string; notifs: string }>(
      `select
         (select count(*)::text from outbox_events where type = 'region.dataset_published' and payload->>'version_id' = $1) as events,
         (select count(*)::text from notifications where template = 'region.dataset_published' and payload->>'version_id' = $1) as notifs`,
      [draft.id],
    )
  ).rows[0];
  assert.equal(Number(pubSignals.events), 1);
  assert.ok(Number(pubSignals.notifs) >= 1);

  // Alias create & revoke without altering official region name
  const createdAlias = await admin.fetch(
    "/staff/admin/regions/aliases",
    {
      stable_region_key: "mca_gbt2260:440305",
      alias_text: "南山科技园片区",
      alias_kind: "logistics_park",
      locale: "zh-CN",
      source_note: "Alias CRUD verification",
    },
    "POST",
    201,
  );
  await admin.fetch(`/staff/admin/regions/aliases/${createdAlias.id}/revoke`, {}, "POST", 200);

  const rolled = await admin2.fetch(`/staff/admin/regions/versions/${overview.active_version.id}/rollback`, {
    reason: "Rollback test verification",
  });
  assert.equal(rolled.status, "active");

  // Unauthorized staff role (inspector) blocked from reading OR creating non-permitted customer/warehouse snapshots (403)
  const inspector = new Client();
  await inspector.loginOtp("inspector@qcw.test");
  await inspector.fetch(`/addresses/snapshots/${snap.id}`, undefined, "GET", 403);
  await inspector.fetch(
    "/addresses/snapshots",
    {
      purpose: "freight_forwarder",
      org_id: snap.org_id,
      manual_unstandardized: true,
      recipient_name: "越权代建",
      contact_phone_raw: "13800138000",
      detail_address: "越权跳过校验",
    },
    "POST",
    403,
  );
  await inspector.fetch(
    "/addresses/snapshots",
    {
      purpose: "warehouse_receiving",
      recipient_name: "仓管",
      contact_phone_raw: "13800138000",
      county_region_id: nanshan.id,
      detail_address: "非法创建",
    },
    "POST",
    403,
  );

  // Abolished/deprecated node in active dataset rejected by validateRegionPath (422)
  await pool.query("update regions set status = 'abolished' where id = $1", [nanshan.id]);
  await anon.fetch("/regions/validate-path", { county_id: nanshan.id }, "POST", 422);
  await pool.query("update regions set status = 'active' where id = $1", [nanshan.id]);

  // Historical snapshot untouched & public detail exposes zero customer PII
  const snapAfter = await cust1.fetch(`/addresses/snapshots/${snap.id}`);
  assert.equal(snapAfter.recipient_name, "张伟(CW8899)");
  const regionDetail = await anon.fetch(`/regions/${nanshan.id}`);
  assert.equal(regionDetail.region.name_zh, "南山区");
  const serializedDetail = JSON.stringify(regionDetail);
  assert.equal(serializedDetail.includes("recipient_name"), false);
  assert.equal(serializedDetail.includes("张伟"), false);
  assert.equal(regionDetail.references_summary.address_snapshot_count, 1);
});
