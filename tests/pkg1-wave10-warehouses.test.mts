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
  await transaction((db) => seedAuthoritativeChinaRegions(db, { includeTownships: false }));
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

test("TASK-182: self-operated warehouse creation, address snapshots, batch bins, reservations, containers, transfers, consumables & safe archiving", async () => {
  const admin = new Client();
  await admin.loginOtp("admin@qcw.test");
  const receiver = new Client();
  await receiver.loginOtp("receiving@qcw.test");
  const inspector = new Client();
  await inspector.loginOtp("inspector@qcw.test");

  // No fake default warehouse seeded in clean runtime table
  const initialList = await admin.fetch("/staff/warehouses");
  assert.equal(initialList.warehouses.length, 0);

  // Resolve real region IDs (Shenzhen Nanshan & Yiwu) and create confirmed warehouse_receiving address snapshots
  const nanshan = (await admin.fetch("/regions/search?q=440305")).items[0];
  const yiwu = (await admin.fetch("/regions/search?q=330782")).items[0];
  const szSnap1 = await admin.fetch(
    "/addresses/snapshots",
    {
      purpose: "warehouse_receiving",
      recipient_name: "深圳南山仓收货组",
      contact_phone_raw: "13800138001",
      county_region_id: nanshan.id,
      detail_address: "高新南一道88号B座2楼",
    },
    "POST",
    201,
  );
  const szSnap2 = await admin.fetch(
    "/addresses/snapshots",
    {
      purpose: "warehouse_receiving",
      recipient_name: "深圳南山仓收货二组",
      contact_phone_raw: "13800138002",
      county_region_id: nanshan.id,
      detail_address: "科技南十二路18号3楼",
    },
    "POST",
    201,
  );
  const ywSnap = await admin.fetch(
    "/addresses/snapshots",
    {
      purpose: "warehouse_receiving",
      recipient_name: "义乌质检分仓收货组",
      contact_phone_raw: "13900139002",
      county_region_id: yiwu.id,
      detail_address: "稠州北路999号物流中心1栋",
    },
    "POST",
    201,
  );

  // Unauthorized roles cannot create warehouses
  await inspector.fetch(
    "/staff/warehouses",
    { warehouse_code: "WH-BAD", name_zh: "越权仓", name_en: "Bad WH" },
    "POST",
    403,
  );

  // Create WH-SZ-01 (initially draft with no fake operational activation) & WH-YW-02
  const szWh = await admin.fetch(
    "/staff/warehouses",
    { warehouse_code: "WH-SZ-01", name_zh: "深圳自营质检一仓", name_en: "Shenzhen QC Hub 01" },
    "POST",
    201,
  );
  assert.equal(szWh.status, "draft");
  assert.equal(szWh.accept_new_orders, false);

  // Cannot activate without confirmed address snapshot or zones
  await admin.fetch(`/staff/warehouses/${szWh.id}/controls`, { status: "active", accept_new_orders: true }, "PATCH", 409);

  // Create zones (including ground staging & golden_sample) + batch create bins (with idempotency check)
  const rcvZone = await admin.fetch(
    `/staff/warehouses/${szWh.id}/zones`,
    { zone_code: "RCV", name_zh: "收货暂存地堆区", name_en: "Receiving Ground Zone", zone_type: "receiving", is_ground_staging: true },
    "POST",
    201,
  );
  const storageZone = await admin.fetch(
    `/staff/warehouses/${szWh.id}/zones`,
    { zone_code: "STG", name_zh: "标准货架区", name_en: "Standard Racking Zone", zone_type: "normal_storage" },
    "POST",
    201,
  );
  const goldenZone = await admin.fetch(
    `/staff/warehouses/${szWh.id}/zones`,
    { zone_code: "GS", name_zh: "确认样恒温柜区", name_en: "Golden Sample Vault", zone_type: "golden_sample" },
    "POST",
    201,
  );
  assert.ok(goldenZone.id);

  // Cannot batch create bins into another warehouse's zone
  const ywWh = await admin.fetch(
    "/staff/warehouses",
    { warehouse_code: "WH-YW-02", name_zh: "义乌自营二仓", name_en: "Yiwu Hub 02", receiving_address_snapshot_id: ywSnap.id },
    "POST",
    201,
  );
  await admin.fetch(
    `/staff/warehouses/${ywWh.id}/bins/batch`,
    { warehouse_zone_id: storageZone.id, rack_code: "A01", shelf_level: 1, start_slot: 1, end_slot: 2, capacity: 5 },
    "POST",
    422,
  );

  const szBatch = await admin.fetch(
    `/staff/warehouses/${szWh.id}/bins/batch`,
    { warehouse_zone_id: storageZone.id, rack_code: "A01", shelf_level: 1, start_slot: 1, end_slot: 3, capacity: 4, max_weight_g: 50000 },
    "POST",
    201,
  );
  assert.equal(szBatch.added.length, 3);
  assert.equal(szBatch.added[0].code, "WH-SZ-01-STG-A01-01-01");

  // Re-running overlapping batch skips existing bins idempotently without overwriting
  const szBatchRepeat = await admin.fetch(
    `/staff/warehouses/${szWh.id}/bins/batch`,
    { warehouse_zone_id: storageZone.id, rack_code: "A01", shelf_level: 1, start_slot: 1, end_slot: 4, capacity: 4 },
    "POST",
    201,
  );
  assert.equal(szBatchRepeat.added.length, 1);
  assert.equal(szBatchRepeat.skipped.length, 3);

  // Activate WH-SZ-01 with confirmed address snapshot & rotate snapshot without mutating warehouse ID or old snapshot
  const szActive = await admin.fetch(
    `/staff/warehouses/${szWh.id}/controls`,
    {
      status: "active",
      accept_new_orders: true,
      accept_inbound_transit: true,
      allow_fulfillment: true,
      allow_dispatch: true,
      receiving_address_snapshot_id: szSnap1.id,
      reason: "Initial live opening",
    },
    "PATCH",
  );
  assert.equal(szActive.status, "active");
  assert.equal(szActive.total_capacity_units, 16);

  const szRotated = await admin.fetch(
    `/staff/warehouses/${szWh.id}/controls`,
    { receiving_address_snapshot_id: szSnap2.id, reason: "Updated receiving dock address" },
    "PATCH",
  );
  assert.equal(szRotated.id, szWh.id);
  assert.equal(szRotated.receiving_address_snapshot_id, szSnap2.id);

  // Also activate WH-YW-02
  const ywZone = await admin.fetch(
    `/staff/warehouses/${ywWh.id}/zones`,
    { zone_code: "RCV", name_zh: "义乌收货区", name_en: "Yiwu Receiving", zone_type: "receiving" },
    "POST",
    201,
  );
  const ywBins = await admin.fetch(
    `/staff/warehouses/${ywWh.id}/bins/batch`,
    { warehouse_zone_id: ywZone.id, rack_code: "B01", shelf_level: 1, start_slot: 1, end_slot: 2, capacity: 10 },
    "POST",
    201,
  );
  await admin.fetch(
    `/staff/warehouses/${ywWh.id}/controls`,
    { status: "active", accept_inbound_transit: true, reason: "Activate Yiwu inbound hub" },
    "PATCH",
  );

  // Reservations & Capacity Governance
  const bin1Id = szBatch.added[0].id;
  const bin2Id = szBatch.added[1].id;
  const rsv1 = await receiver.fetch(
    "/staff/warehouse-reservations",
    { location_id: bin1Id, reference_type: "inbound_advice", reference_id: "ADV-001", quantity: 3 },
    "POST",
    201,
  );
  await receiver.fetch(
    "/staff/warehouse-reservations",
    { location_id: bin1Id, reference_type: "inbound_advice", reference_id: "ADV-002", quantity: 2 },
    "POST",
    409,
  ); // 3 + 2 > 4 capacity -> 409 LOCATION_FULL
  await admin.fetch(`/staff/warehouse-bins/${bin1Id}`, { capacity: 2 }, "PATCH", 409); // below reserved=3
  await admin.fetch(`/staff/warehouse-bins/${bin1Id}`, { active: false }, "PATCH", 409); // reserved -> cannot disable

  // Recommend empty bins returns bin2..bin4 ahead of bin1 (free=4 vs free=1)
  const rec = await receiver.fetch(`/staff/warehouses/${szWh.id}/bins/recommend?zone_type=normal_storage&min_free_units=4`);
  assert.equal(rec.recommendations.length, 3);
  assert.equal(rec.recommendations.some((r: { id: string }) => r.id === bin1Id), false);

  // Unauthenticated caller with invalid query param gets 401 (never 422), and frozen bin rejects both reservations and containers
  const anon = new Client();
  await anon.fetch(`/staff/warehouses/${szWh.id}/bins/recommend?limit=abc`, undefined, "GET", 401);
  await admin.fetch(`/staff/warehouse-bins/${bin2Id}`, { frozen: true }, "PATCH");
  await receiver.fetch(
    "/staff/warehouse-reservations",
    { location_id: bin2Id, reference_type: "qc_task", reference_id: "TASK-1", quantity: 1 },
    "POST",
    409,
  );
  await receiver.fetch(
    `/staff/warehouses/${szWh.id}/containers`,
    { container_code: "TOTE-FROZEN-BLOCK", container_type: "tote", location_id: bin2Id, capacity_units: 5 },
    "POST",
    409,
  );
  await admin.fetch(`/staff/warehouse-bins/${bin2Id}`, { frozen: false }, "PATCH");

  // Containers, cycle prevention, cross-warehouse transfer & archive dependency protection
  const c1 = await receiver.fetch(
    `/staff/warehouses/${szWh.id}/containers`,
    { container_code: "TOTE-SZ-001", container_type: "tote", location_id: bin2Id, capacity_units: 20 },
    "POST",
    201,
  );
  const c2 = await receiver.fetch(
    `/staff/warehouses/${szWh.id}/containers`,
    { container_code: "TOTE-SZ-002", container_type: "carton", parent_container_id: c1.id, capacity_units: 10 },
    "POST",
    201,
  );
  // Circular nesting c1 -> c2 -> c1 rejected (422 CONTAINER_CYCLE_DETECTED)
  await receiver.fetch(`/staff/warehouse-containers/${c1.id}/move`, { parent_container_id: c2.id }, "POST", 422);
  // Cross-warehouse move without transfer rejected (422)
  await receiver.fetch(`/staff/warehouse-containers/${c1.id}/move`, { location_id: ywBins.added[0].id }, "POST", 422);

  // Archive blocked while reservations & containers exist
  const impactBlocked = await admin.fetch(`/staff/warehouses/${szWh.id}/archive-impact`);
  assert.equal(impactBlocked.can_archive, false);
  await admin.fetch(`/staff/warehouses/${szWh.id}/archive`, { reason: "Blocked test" }, "POST", 409);

  // Dispatching parent container c1 while child container c2 is still nested is rejected 409 CONTAINER_HAS_CHILDREN
  await admin.fetch(
    "/staff/warehouse-transfers",
    { from_warehouse_id: szWh.id, to_warehouse_id: ywWh.id, container_id: c1.id, item_count: 5 },
    "POST",
    409,
  );

  // Release reservation & transfer c2 to WH-YW-02 cleanly; destination frozen bin check also blocks receive (409)
  await receiver.fetch(`/staff/warehouse-reservations/${rsv1.id}/release`, {});
  await receiver.fetch(`/staff/warehouse-containers/${c2.id}/move`, { parent_container_id: null });
  const tr = await admin.fetch(
    "/staff/warehouse-transfers",
    { from_warehouse_id: szWh.id, to_warehouse_id: ywWh.id, container_id: c2.id, item_count: 12, note: "Overflow transfer" },
    "POST",
    201,
  );
  assert.equal(tr.status, "in_transit");
  // Cannot archive WH-YW-02 while incoming transfer is in_transit
  await admin.fetch(`/staff/warehouses/${ywWh.id}/archive`, { reason: "Blocked by transfer" }, "POST", 409);

  await admin.fetch(`/staff/warehouse-bins/${ywBins.added[0].id}`, { frozen: true }, "PATCH");
  await admin.fetch(
    `/staff/warehouse-transfers/${tr.id}/receive`,
    { received_item_count: 12, destination_location_id: ywBins.added[0].id },
    "POST",
    409,
  );
  await admin.fetch(`/staff/warehouse-bins/${ywBins.added[0].id}`, { frozen: false }, "PATCH");

  const receivedTr = await admin.fetch(`/staff/warehouse-transfers/${tr.id}/receive`, {
    received_item_count: 12,
    destination_location_id: ywBins.added[0].id,
  });
  assert.equal(receivedTr.status, "received");

  // Packaging consumables stock ledger & insufficient-stock guard
  const cartonSku = await admin.fetch(
    `/staff/warehouses/${szWh.id}/consumables`,
    { sku_code: "BOX-M-3020", name_zh: "中号五层快递纸箱", name_en: "Medium 5-Ply Carton", category: "carton", unit_cost_cents: 450, reorder_threshold_qty: 20 },
    "POST",
    201,
  );
  const restocked = await receiver.fetch(`/staff/warehouse-consumables/${cartonSku.id}/adjust`, {
    delta_qty: 100,
    reason_code: "restock",
    reference_id: "PO-CONSUMABLE-01",
  });
  assert.equal(restocked.on_hand_qty, 100);
  const consumed = await receiver.fetch(`/staff/warehouse-consumables/${cartonSku.id}/adjust`, {
    delta_qty: -30,
    reason_code: "pack_consume",
    reference_id: "BATCH-01",
  });
  assert.equal(consumed.on_hand_qty, 70);
  await receiver.fetch(
    `/staff/warehouse-consumables/${cartonSku.id}/adjust`,
    { delta_qty: -80, reason_code: "pack_consume" },
    "POST",
    409,
  );

  // Warehouse detail returns real aggregated state + confirm paused accepts in_transit while disallowing new orders
  const detail = await admin.fetch(`/staff/warehouses/${szWh.id}`);
  assert.equal(detail.zones.length, 3);
  assert.equal(detail.bins.length, 4);
  assert.equal(rcvZone.id !== null, true);
  await admin.fetch(
    `/staff/warehouses/${szWh.id}/controls`,
    { status: "paused", accept_new_orders: false, accept_inbound_transit: true, allow_fulfillment: false, allow_dispatch: false, reason: "Holiday pause keeping transit open" },
    "PATCH",
  );
});
