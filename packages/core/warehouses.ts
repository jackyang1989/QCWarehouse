import { z } from "zod";
import type { DB } from "../db";
import { audit, event, guard, lock, numericCode, one, role, shanghaiYYMMDD, uuid, type Actor } from "./common";
import { requireStaffMfa } from "./auth";

const ZONE_TYPES = [
  "receiving",
  "unidentified",
  "pending_qc",
  "in_progress",
  "pending_qa",
  "normal_storage",
  "golden_sample",
  "quarantine",
  "pending_pack",
  "pending_handover",
] as const;

type ZoneType = (typeof ZONE_TYPES)[number];

const LEGACY_ZONE_BY_TYPE: Record<
  ZoneType,
  "receiving" | "queue" | "inspecting" | "post_inspection" | "reference" | "unmatched" | "quarantine"
> = {
  receiving: "receiving",
  unidentified: "unmatched",
  pending_qc: "queue",
  in_progress: "inspecting",
  pending_qa: "inspecting",
  normal_storage: "post_inspection",
  golden_sample: "reference",
  quarantine: "quarantine",
  pending_pack: "post_inspection",
  pending_handover: "post_inspection",
};

export const warehouseCreateSchema = z.object({
  warehouse_code: z.string().trim().min(3).max(24).regex(/^[A-Z0-9-]+$/),
  name_zh: z.string().trim().min(2).max(120),
  name_en: z.string().trim().min(2).max(120),
  legal_entity_id: z.uuid().optional(),
  manager_user_id: z.uuid().optional(),
  timezone: z.string().trim().min(3).max(60).default("Asia/Shanghai"),
  receiving_address_snapshot_id: z.uuid().optional(),
  dispatch_address_snapshot_id: z.uuid().optional(),
  cutoff_receiving_time: z.string().regex(/^\d{2}:\d{2}$/).default("17:30"),
  cutoff_dispatch_time: z.string().regex(/^\d{2}:\d{2}$/).default("16:00"),
  working_days: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6]),
  supported_categories: z.array(z.string().trim().min(2).max(40)).min(1).max(20).default(["apparel"]),
});

export const warehouseControlsSchema = z.object({
  status: z.enum(["draft", "active", "paused"]).optional(),
  accept_new_orders: z.boolean().optional(),
  accept_inbound_transit: z.boolean().optional(),
  allow_fulfillment: z.boolean().optional(),
  allow_dispatch: z.boolean().optional(),
  receiving_address_snapshot_id: z.uuid().optional(),
  dispatch_address_snapshot_id: z.uuid().optional(),
  cutoff_receiving_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  cutoff_dispatch_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  working_days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  reason: z.string().trim().min(2).max(400).optional(),
});

export const warehouseZoneCreateSchema = z.object({
  zone_code: z.string().trim().min(1).max(16).regex(/^[A-Z0-9-]+$/),
  name_zh: z.string().trim().min(1).max(80),
  name_en: z.string().trim().min(1).max(80),
  zone_type: z.enum(ZONE_TYPES),
  is_ground_staging: z.boolean().default(false),
  storage_conditions: z.record(z.string(), z.unknown()).default({}),
});

export const warehouseBinBatchSchema = z
  .object({
    warehouse_zone_id: z.uuid(),
    rack_code: z.string().trim().min(1).max(12).regex(/^[A-Z0-9]+$/),
    shelf_level: z.number().int().min(0).max(99),
    start_slot: z.number().int().min(1).max(999),
    end_slot: z.number().int().min(1).max(999),
    capacity: z.number().int().min(1).max(999),
    max_weight_g: z.number().int().min(100).max(10_000_000).optional(),
    notes: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.start_slot <= v.end_slot && v.end_slot - v.start_slot < 200, "Slot range must be ascending with at most 200 bins.");

export const binGovernanceSchema = z.object({
  capacity: z.number().int().min(1).max(999).optional(),
  active: z.boolean().optional(),
  frozen: z.boolean().optional(),
  notes: z.string().trim().max(200).optional(),
});

export const locationReserveSchema = z.object({
  location_id: z.uuid(),
  reference_type: z.enum(["inbound_advice", "qc_task", "golden_sample", "dispatch_pack", "transfer"]),
  reference_id: z.string().trim().min(1).max(120),
  quantity: z.number().int().min(1).max(999),
  expires_hours: z.number().int().min(1).max(720).optional(),
});

export const recommendLocationsQuerySchema = z.object({
  zone_type: z.enum(ZONE_TYPES).optional(),
  min_free_units: z.coerce.number().int().min(1).max(999).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const containerCreateSchema = z.object({
  container_code: z.string().trim().min(3).max(40).regex(/^[A-Z0-9-]+$/),
  container_type: z.enum(["tote", "carton", "pallet", "garment_rack", "vault_box"]),
  location_id: z.uuid().optional(),
  parent_container_id: z.uuid().optional(),
  capacity_units: z.number().int().min(1).max(999),
});

export const containerMoveSchema = z.object({
  location_id: z.uuid().nullable().optional(),
  parent_container_id: z.uuid().nullable().optional(),
});

export const transferDispatchSchema = z.object({
  from_warehouse_id: z.uuid(),
  to_warehouse_id: z.uuid(),
  container_id: z.uuid().optional(),
  item_count: z.number().int().min(1).max(10000),
  note: z.string().trim().max(400).optional(),
});

export const transferReceiveSchema = z.object({
  received_item_count: z.number().int().min(0).max(10000),
  destination_location_id: z.uuid().optional(),
  note: z.string().trim().max(400).optional(),
});

export const consumableCreateSchema = z.object({
  sku_code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9-]+$/),
  name_zh: z.string().trim().min(1).max(120),
  name_en: z.string().trim().min(1).max(120),
  category: z.enum(["carton", "polybag", "label_roll", "security_seal", "cushioning", "desiccant", "other"]),
  unit_name: z.string().trim().min(1).max(20).default("pcs"),
  unit_cost_cents: z.number().int().min(0).max(10_000_000).default(0),
  reorder_threshold_qty: z.number().int().min(0).max(1_000_000).default(0),
});

export const consumableAdjustSchema = z.object({
  delta_qty: z.number().int().refine((n) => n !== 0, "delta_qty cannot be zero."),
  reason_code: z.enum(["restock", "pack_consume", "stocktake_adjust", "damage_writeoff", "transfer_out", "transfer_in"]),
  reference_id: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
});

async function assertValidWarehouseSnapshot(db: DB, snapshotId: string) {
  const snap = await one<{ id: string; purpose: string; market_scope: string; domestic_deliverable: boolean }>(
    db,
    "select id, purpose, market_scope, domestic_deliverable from address_snapshots where id = $1",
    [snapshotId],
  );
  guard(
    snap.purpose === "warehouse_receiving" || snap.purpose === "warehouse_dispatch",
    "INVALID_ADDRESS_PURPOSE",
    `Address snapshot '${snapshotId}' must have warehouse_receiving or warehouse_dispatch purpose.`,
    422,
  );
  if (snap.market_scope === "cn_mainland") {
    guard(snap.domestic_deliverable, "ADDRESS_SNAPSHOT_NOT_DELIVERABLE", "Domestic warehouse address must resolve to a deliverable mainland region.", 422);
  }
}

async function recalculateWarehouseCapacity(db: DB, warehouseId: string) {
  await db.query(
    `update warehouses
     set total_capacity_units = coalesce((
           select sum(coalesce(capacity, 0))::int from storage_locations where warehouse_id = $1 and active
         ), 0),
         updated_at = now()
     where id = $1`,
    [warehouseId],
  );
}

export async function listWarehouses(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin", "warehouse_admin", "receiver", "inspector", "reviewer", "support", "finance");
  const { rows } = await db.query(
    `select w.id, w.warehouse_code, w.name_zh, w.name_en, w.status, w.timezone,
            w.accept_new_orders, w.accept_inbound_transit, w.allow_fulfillment, w.allow_dispatch,
            w.total_capacity_units, w.receiving_address_snapshot_id, w.dispatch_address_snapshot_id,
            w.cutoff_receiving_time, w.cutoff_dispatch_time, w.working_days, w.supported_categories,
            (select count(*)::int from warehouse_zones z where z.warehouse_id = w.id) as zone_count,
            (select count(*)::int from storage_locations sl where sl.warehouse_id = w.id and sl.active) as active_bin_count,
            (select coalesce(sum(sl.reserved_units), 0)::int from storage_locations sl where sl.warehouse_id = w.id) as reserved_units,
            (select count(*)::int from warehouse_items wi
             join storage_locations sl on sl.id = wi.location_id
             where sl.warehouse_id = w.id and wi.custody_state in ('received', 'stored')) as occupied_units
     from warehouses w
     order by w.created_at asc`,
  );
  return { warehouses: rows };
}

export async function getWarehouseDetail(db: Pick<DB, "query">, actor: Actor, warehouseId: string) {
  role(actor, "super_admin", "warehouse_admin", "receiver", "inspector", "reviewer", "support", "finance");
  const warehouse = await one(
    db,
    `select w.*,
            rs.region_path_names_zh as receiving_region_path_names_zh, rs.detail_address as receiving_detail_address,
            ds.region_path_names_zh as dispatch_region_path_names_zh, ds.detail_address as dispatch_detail_address
     from warehouses w
     left join address_snapshots rs on rs.id = w.receiving_address_snapshot_id
     left join address_snapshots ds on ds.id = w.dispatch_address_snapshot_id
     where w.id = $1`,
    [warehouseId],
  );
  const zones = (
    await db.query("select * from warehouse_zones where warehouse_id = $1 order by zone_code asc", [warehouseId])
  ).rows;
  const bins = (
    await db.query(
      `select sl.id, sl.code, sl.zone, sl.warehouse_zone_id, sl.rack_code, sl.shelf_level, sl.bin_slot,
              sl.capacity, sl.reserved_units, sl.frozen, sl.active, sl.max_weight_g,
              (select count(*)::int from warehouse_items wi where wi.location_id = sl.id and wi.custody_state in ('received','stored')) as occupied_units
       from storage_locations sl
       where sl.warehouse_id = $1 order by sl.code asc limit 500`,
      [warehouseId],
    )
  ).rows;
  const containers = (
    await db.query("select * from warehouse_containers where warehouse_id = $1 order by created_at desc limit 200", [warehouseId])
  ).rows;
  return { warehouse, zones, bins, containers };
}

export async function createWarehouse(
  db: DB,
  actor: Actor,
  input: z.infer<typeof warehouseCreateSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, `warehouse:code:${input.warehouse_code}`);
  if (input.receiving_address_snapshot_id) await assertValidWarehouseSnapshot(db, input.receiving_address_snapshot_id);
  if (input.dispatch_address_snapshot_id) await assertValidWarehouseSnapshot(db, input.dispatch_address_snapshot_id);

  const id = uuid();
  const created = await one(
    db,
    `insert into warehouses(
       id, warehouse_code, name_zh, name_en, legal_entity_id, manager_user_id, timezone,
       status, accept_new_orders, accept_inbound_transit, allow_fulfillment, allow_dispatch,
       receiving_address_snapshot_id, dispatch_address_snapshot_id,
       cutoff_receiving_time, cutoff_dispatch_time, working_days, supported_categories, created_by
     ) values($1,$2,$3,$4,$5,$6,$7,'draft',false,false,false,false,$8,$9,$10,$11,$12::int[],$13::text[],$14)
     returning *`,
    [
      id,
      input.warehouse_code,
      input.name_zh,
      input.name_en,
      input.legal_entity_id ?? null,
      input.manager_user_id ?? null,
      input.timezone,
      input.receiving_address_snapshot_id ?? null,
      input.dispatch_address_snapshot_id ?? null,
      input.cutoff_receiving_time,
      input.cutoff_dispatch_time,
      input.working_days,
      input.supported_categories,
      actor.id,
    ],
  );
  await audit(db, actor, "create_warehouse", "warehouses", id, { warehouse_code: input.warehouse_code });
  return created;
}

export async function updateWarehouseControls(
  db: DB,
  actor: Actor,
  warehouseId: string,
  input: z.infer<typeof warehouseControlsSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const current = await one<{
    id: string;
    warehouse_code: string;
    status: string;
    receiving_address_snapshot_id: string | null;
    dispatch_address_snapshot_id: string | null;
    accept_new_orders: boolean;
    accept_inbound_transit: boolean;
    allow_fulfillment: boolean;
    allow_dispatch: boolean;
    cutoff_receiving_time: string;
    cutoff_dispatch_time: string;
    working_days: number[];
  }>(db, "select * from warehouses where id = $1 for update", [warehouseId]);

  guard(current.status !== "archived", "WAREHOUSE_ARCHIVED", "Archived warehouses cannot be modified.", 409);

  if (input.receiving_address_snapshot_id) await assertValidWarehouseSnapshot(db, input.receiving_address_snapshot_id);
  if (input.dispatch_address_snapshot_id) await assertValidWarehouseSnapshot(db, input.dispatch_address_snapshot_id);

  const nextStatus = input.status ?? current.status;
  const nextReceivingSnap = input.receiving_address_snapshot_id ?? current.receiving_address_snapshot_id;
  const nextDispatchSnap = input.dispatch_address_snapshot_id ?? current.dispatch_address_snapshot_id;

  if (nextStatus === "active") {
    guard(nextReceivingSnap, "ADDRESS_REQUIRED", "An active warehouse requires a confirmed receiving address snapshot.", 409);
    const activeZone = (
      await db.query("select 1 from warehouse_zones where warehouse_id = $1 and status = 'active' limit 1", [warehouseId])
    ).rowCount;
    guard(activeZone, "ZONE_REQUIRED", "An active warehouse requires at least one active zone before activation.", 409);
  }

  const nextAcceptNew = input.accept_new_orders ?? (nextStatus === "active" ? current.accept_new_orders : false);
  const nextAcceptTransit = input.accept_inbound_transit ?? current.accept_inbound_transit;
  const nextAllowFulfill = input.allow_fulfillment ?? (nextStatus === "active" ? current.allow_fulfillment : false);
  const nextAllowDispatch = input.allow_dispatch ?? (nextStatus === "active" ? current.allow_dispatch : false);

  if (nextStatus !== "active") {
    guard(
      !nextAcceptNew && !nextAllowFulfill && !nextAllowDispatch,
      "WAREHOUSE_NOT_ACTIVE",
      "Paused or draft warehouses cannot accept new orders, fulfillment, or outbound dispatch.",
      409,
    );
  }

  const updated = await one(
    db,
    `update warehouses
     set status = $2,
         accept_new_orders = $3,
         accept_inbound_transit = $4,
         allow_fulfillment = $5,
         allow_dispatch = $6,
         receiving_address_snapshot_id = $7,
         dispatch_address_snapshot_id = $8,
         cutoff_receiving_time = $9,
         cutoff_dispatch_time = $10,
         working_days = $11::int[],
         updated_at = now()
     where id = $1
     returning *`,
    [
      warehouseId,
      nextStatus,
      nextAcceptNew,
      nextAcceptTransit,
      nextAllowFulfill,
      nextAllowDispatch,
      nextReceivingSnap,
      nextDispatchSnap,
      input.cutoff_receiving_time ?? current.cutoff_receiving_time,
      input.cutoff_dispatch_time ?? current.cutoff_dispatch_time,
      input.working_days ?? current.working_days,
    ],
  );

  await audit(db, actor, "update_warehouse_controls", "warehouses", warehouseId, {
    status: nextStatus,
    accept_new_orders: nextAcceptNew,
    accept_inbound_transit: nextAcceptTransit,
    reason: input.reason ?? null,
  });
  return updated;
}

export async function previewWarehouseDeactivationImpact(db: Pick<DB, "query">, actor: Actor, warehouseId: string) {
  role(actor, "super_admin", "warehouse_admin");
  await one(db, "select id from warehouses where id = $1", [warehouseId]);
  const counts = await one<{
    occupied_items: number;
    active_reservations: number;
    active_containers: number;
    open_transfers: number;
  }>(
    db,
    `select
       (select count(*)::int from warehouse_items wi join storage_locations sl on sl.id = wi.location_id
        where sl.warehouse_id = $1 and wi.custody_state in ('received', 'stored')) as occupied_items,
       (select count(*)::int from location_reservations where warehouse_id = $1 and status = 'active') as active_reservations,
       (select count(*)::int from warehouse_containers where warehouse_id = $1 and status <> 'retired') as active_containers,
       (select count(*)::int from warehouse_transfer_orders
        where (from_warehouse_id = $1 or to_warehouse_id = $1) and status in ('dispatched', 'in_transit', 'discrepancy')) as open_transfers`,
    [warehouseId],
  );
  return {
    warehouse_id: warehouseId,
    can_archive:
      counts.occupied_items === 0 &&
      counts.active_reservations === 0 &&
      counts.active_containers === 0 &&
      counts.open_transfers === 0,
    ...counts,
  };
}

export async function archiveWarehouse(
  db: DB,
  actor: Actor,
  warehouseId: string,
  reason: string,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const wh = await one<{ id: string; status: string; warehouse_code: string }>(
    db,
    "select id, status, warehouse_code from warehouses where id = $1 for update",
    [warehouseId],
  );
  guard(wh.status !== "archived", "ALREADY_ARCHIVED", "Warehouse is already archived.", 409);

  const impact = await previewWarehouseDeactivationImpact(db, actor, warehouseId);
  guard(
    impact.can_archive,
    "WAREHOUSE_HAS_ACTIVE_DEPENDENCIES",
    `Cannot archive warehouse '${wh.warehouse_code}' while occupied items (${impact.occupied_items}), reservations (${impact.active_reservations}), containers (${impact.active_containers}), or open transfers (${impact.open_transfers}) remain.`,
    409,
  );

  const archived = await one(
    db,
    `update warehouses
     set status = 'archived', accept_new_orders = false, accept_inbound_transit = false,
         allow_fulfillment = false, allow_dispatch = false, updated_at = now()
     where id = $1 returning *`,
    [warehouseId],
  );
  await audit(db, actor, "archive_warehouse", "warehouses", warehouseId, { reason });
  return archived;
}

export async function createWarehouseZone(
  db: DB,
  actor: Actor,
  warehouseId: string,
  input: z.infer<typeof warehouseZoneCreateSchema>,
) {
  role(actor, "super_admin", "warehouse_admin");
  const wh = await one<{ id: string; status: string }>(
    db,
    "select id, status from warehouses where id = $1 for update",
    [warehouseId],
  );
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot add zones to an archived warehouse.", 409);

  const id = uuid();
  const zone = await one(
    db,
    `insert into warehouse_zones(id, warehouse_id, zone_code, name_zh, name_en, zone_type, is_ground_staging, storage_conditions)
     values($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning *`,
    [id, warehouseId, input.zone_code, input.name_zh, input.name_en, input.zone_type, input.is_ground_staging, JSON.stringify(input.storage_conditions)],
  );
  await audit(db, actor, "create_warehouse_zone", "warehouse_zones", id, { warehouse_id: warehouseId, zone_code: input.zone_code });
  return zone;
}

export async function batchCreateWarehouseBins(
  db: DB,
  actor: Actor,
  warehouseId: string,
  input: z.infer<typeof warehouseBinBatchSchema>,
) {
  role(actor, "super_admin", "warehouse_admin");
  const wh = await one<{ id: string; warehouse_code: string; status: string }>(
    db,
    "select id, warehouse_code, status from warehouses where id = $1 for update",
    [warehouseId],
  );
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot create bins on an archived warehouse.", 409);

  const zoneRow = (
    await db.query<{ id: string; zone_code: string; zone_type: ZoneType; status: string }>(
      "select id, zone_code, zone_type, status from warehouse_zones where id = $1 and warehouse_id = $2 for update",
      [input.warehouse_zone_id, warehouseId],
    )
  ).rows[0];
  guard(zoneRow, "ZONE_WAREHOUSE_MISMATCH", "Zone does not belong to the specified warehouse.", 422);
  guard(zoneRow.status === "active", "ZONE_NOT_ACTIVE", "Cannot batch create bins under a disabled or frozen zone.", 409);

  const legacyZone = LEGACY_ZONE_BY_TYPE[zoneRow.zone_type];
  const added: Array<{ id: string; code: string }> = [];
  const skipped: string[] = [];

  for (let s = input.start_slot; s <= input.end_slot; s++) {
    const code = `${wh.warehouse_code}-${zoneRow.zone_code}-${input.rack_code}-${String(input.shelf_level).padStart(2, "0")}-${String(s).padStart(2, "0")}`;
    const { rows } = await db.query<{ id: string; code: string }>(
      `insert into storage_locations(
         id, code, zone, capacity, notes, warehouse_id, warehouse_zone_id, rack_code, shelf_level, bin_slot, max_weight_g
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (code) do nothing
       returning id, code`,
      [
        uuid(),
        code,
        legacyZone,
        input.capacity,
        input.notes ?? null,
        warehouseId,
        zoneRow.id,
        input.rack_code,
        input.shelf_level,
        s,
        input.max_weight_g ?? null,
      ],
    );
    if (rows[0]) added.push(rows[0]);
    else skipped.push(code);
  }

  await recalculateWarehouseCapacity(db, warehouseId);
  await audit(db, actor, "batch_create_warehouse_bins", "warehouses", warehouseId, {
    zone_id: zoneRow.id,
    added_count: added.length,
    skipped_count: skipped.length,
  });
  return { added, skipped };
}

export async function updateBinGovernance(
  db: DB,
  actor: Actor,
  locationId: string,
  input: z.infer<typeof binGovernanceSchema>,
) {
  role(actor, "super_admin", "warehouse_admin");
  const loc = await one<{
    id: string;
    code: string;
    warehouse_id: string | null;
    capacity: number | null;
    reserved_units: number;
    active: boolean;
    frozen: boolean;
    notes: string | null;
  }>(db, "select id, code, warehouse_id, capacity, reserved_units, active, frozen, notes from storage_locations where id = $1 for update", [locationId]);

  const occupied = Number(
    (
      await db.query<{ n: string }>(
        "select count(*)::text as n from warehouse_items where location_id = $1 and custody_state in ('received', 'stored')",
        [locationId],
      )
    ).rows[0].n,
  );
  const totalCommitted = occupied + loc.reserved_units;

  if (input.capacity !== undefined) {
    guard(
      input.capacity >= totalCommitted,
      "CAPACITY_BELOW_OCCUPANCY",
      `Cannot reduce bin capacity (${input.capacity}) below committed occupancy + reservations (${totalCommitted}).`,
      409,
    );
  }
  if (input.active === false) {
    guard(
      totalCommitted === 0,
      "LOCATION_IN_USE",
      `Move occupied items and release reservations (${totalCommitted}) before disabling bin '${loc.code}'.`,
      409,
    );
  }

  const updated = await one(
    db,
    `update storage_locations
     set capacity = coalesce($2, capacity),
         active = coalesce($3, active),
         frozen = coalesce($4, frozen),
         notes = coalesce($5, notes)
     where id = $1
     returning id, code, warehouse_id, capacity, reserved_units, active, frozen, notes`,
    [locationId, input.capacity ?? null, input.active ?? null, input.frozen ?? null, input.notes ?? null],
  );
  if (loc.warehouse_id) await recalculateWarehouseCapacity(db, loc.warehouse_id);
  await audit(db, actor, "update_bin_governance", "storage_locations", locationId, input);
  return updated;
}

export async function reserveLocationSpace(
  db: DB,
  actor: Actor,
  input: z.infer<typeof locationReserveSchema>,
) {
  role(actor, "super_admin", "warehouse_admin", "receiver");
  const loc = await one<{
    id: string;
    code: string;
    warehouse_id: string | null;
    capacity: number | null;
    reserved_units: number;
    active: boolean;
    frozen: boolean;
  }>(
    db,
    "select id, code, warehouse_id, capacity, reserved_units, active, frozen from storage_locations where id = $1 for update",
    [input.location_id],
  );
  guard(loc.warehouse_id, "BIN_WAREHOUSE_UNASSIGNED", "Location must belong to a configured warehouse to reserve capacity.", 409);
  const wh = await one<{ status: string }>(db, "select status from warehouses where id = $1 for share", [loc.warehouse_id]);
  guard(wh.status === "active" || wh.status === "paused", "WAREHOUSE_NOT_OPERATIONAL", "Cannot reserve bins in a draft or archived warehouse.", 409);
  guard(loc.active && !loc.frozen, "LOCATION_UNAVAILABLE", `Bin '${loc.code}' is disabled or frozen.`, 409);

  const occupied = Number(
    (
      await db.query<{ n: string }>(
        "select count(*)::text as n from warehouse_items where location_id = $1 and custody_state in ('received', 'stored')",
        [loc.id],
      )
    ).rows[0].n,
  );
  const committedAfter = occupied + loc.reserved_units + input.quantity;
  guard(
    loc.capacity === null || committedAfter <= loc.capacity,
    "LOCATION_FULL",
    `Insufficient free capacity at bin '${loc.code}' (committed ${occupied + loc.reserved_units}, requested ${input.quantity}, capacity ${loc.capacity}).`,
    409,
  );

  await db.query("update storage_locations set reserved_units = reserved_units + $2 where id = $1", [loc.id, input.quantity]);
  const reservationId = uuid();
  const res = await one(
    db,
    `insert into location_reservations(id, location_id, warehouse_id, reference_type, reference_id, quantity, status, reserved_by, expires_at)
     values($1, $2, $3, $4, $5, $6, 'active', $7, case when $8::int is not null then now() + make_interval(hours => $8::int) else null end)
     returning *`,
    [reservationId, loc.id, loc.warehouse_id, input.reference_type, input.reference_id, input.quantity, actor.id, input.expires_hours ?? null],
  );
  await audit(db, actor, "reserve_location_space", "location_reservations", reservationId, {
    location_id: loc.id,
    quantity: input.quantity,
    reference_type: input.reference_type,
  });
  return res;
}

export async function releaseLocationReservation(db: DB, actor: Actor, reservationId: string) {
  role(actor, "super_admin", "warehouse_admin", "receiver");
  const res = await one<{ id: string; location_id: string; quantity: number; status: string }>(
    db,
    "select id, location_id, quantity, status from location_reservations where id = $1 for update",
    [reservationId],
  );
  guard(res.status === "active", "RESERVATION_NOT_ACTIVE", `Reservation '${reservationId}' is already '${res.status}'.`, 409);
  await db.query("select id from storage_locations where id = $1 for update", [res.location_id]);
  await db.query("update storage_locations set reserved_units = greatest(0, reserved_units - $2) where id = $1", [
    res.location_id,
    res.quantity,
  ]);
  const released = await one(
    db,
    "update location_reservations set status = 'released', released_at = now() where id = $1 returning *",
    [reservationId],
  );
  await audit(db, actor, "release_location_reservation", "location_reservations", reservationId, { quantity: res.quantity });
  return released;
}

export async function recommendEmptyLocations(
  db: Pick<DB, "query">,
  actor: Actor,
  warehouseId: string,
  query: z.infer<typeof recommendLocationsQuerySchema>,
) {
  role(actor, "super_admin", "warehouse_admin", "receiver", "inspector");
  const params: unknown[] = [warehouseId, query.min_free_units];
  const zoneFilter = query.zone_type ? (params.push(query.zone_type), `and wz.zone_type = $${params.length}`) : "";
  params.push(query.limit);
  const { rows } = await db.query(
    `select * from (
       select sl.id, sl.code, wz.zone_code, wz.zone_type, sl.capacity, sl.reserved_units,
              (select count(*)::int from warehouse_items wi where wi.location_id = sl.id and wi.custody_state in ('received','stored')) as occupied_units,
              (coalesce(sl.capacity, 999) - sl.reserved_units - (select count(*)::int from warehouse_items wi where wi.location_id = sl.id and wi.custody_state in ('received','stored'))) as free_units
       from storage_locations sl
       join warehouse_zones wz on wz.id = sl.warehouse_zone_id
       where sl.warehouse_id = $1 and sl.active and not sl.frozen and wz.status = 'active' ${zoneFilter}
     ) q
     where q.free_units >= $2
     order by q.free_units desc, q.code asc
     limit $${params.length}`,
    params,
  );
  return { warehouse_id: warehouseId, recommendations: rows };
}

async function assertWarehouseBinAvailable(
  db: DB,
  locationId: string,
  expectedWarehouseId: string,
  crossWarehouseMessage: string,
) {
  const loc = await one<{ warehouse_id: string | null; active: boolean; frozen: boolean }>(
    db,
    "select warehouse_id, active, frozen from storage_locations where id = $1 for update",
    [locationId],
  );
  guard(loc.warehouse_id === expectedWarehouseId, "CROSS_WAREHOUSE_LOCATION_FORBIDDEN", crossWarehouseMessage, 422);
  guard(loc.active && !loc.frozen, "LOCATION_UNAVAILABLE", "Target storage bin is disabled or frozen.", 409);
}

export async function createWarehouseContainer(
  db: DB,
  actor: Actor,
  warehouseId: string,
  input: z.infer<typeof containerCreateSchema>,
) {
  role(actor, "super_admin", "warehouse_admin", "receiver");
  const wh = await one<{ id: string; status: string }>(
    db,
    "select id, status from warehouses where id = $1 for update",
    [warehouseId],
  );
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot create containers in an archived warehouse.", 409);

  if (input.location_id) {
    await assertWarehouseBinAvailable(db, input.location_id, warehouseId, "Container location must belong to the same warehouse.");
  }
  if (input.parent_container_id) {
    const parent = await one<{ warehouse_id: string; status: string }>(
      db,
      "select warehouse_id, status from warehouse_containers where id = $1",
      [input.parent_container_id],
    );
    guard(parent.warehouse_id === warehouseId, "CROSS_WAREHOUSE_NESTING_FORBIDDEN", "Parent container must belong to the same warehouse.", 422);
    guard(parent.status === "active", "CONTAINER_NOT_ACTIVE", "Parent container must be active.", 409);
  }

  const id = uuid();
  const created = await one(
    db,
    `insert into warehouse_containers(id, warehouse_id, container_code, container_type, location_id, parent_container_id, capacity_units, created_by)
     values($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [id, warehouseId, input.container_code, input.container_type, input.location_id ?? null, input.parent_container_id ?? null, input.capacity_units, actor.id],
  );
  await audit(db, actor, "create_warehouse_container", "warehouse_containers", id, {
    warehouse_id: warehouseId,
    container_code: input.container_code,
  });
  return created;
}

export async function moveOrNestContainer(
  db: DB,
  actor: Actor,
  containerId: string,
  input: z.infer<typeof containerMoveSchema>,
) {
  role(actor, "super_admin", "warehouse_admin", "receiver");
  const cur = await one<{ id: string; warehouse_id: string; status: string; location_id: string | null; parent_container_id: string | null }>(
    db,
    "select id, warehouse_id, status, location_id, parent_container_id from warehouse_containers where id = $1 for update",
    [containerId],
  );
  guard(cur.status === "active", "CONTAINER_NOT_ACTIVE", `Cannot move container while status is '${cur.status}'.`, 409);
  await lock(db, `warehouse_containers:${cur.warehouse_id}`);

  if (input.location_id) {
    await assertWarehouseBinAvailable(db, input.location_id, cur.warehouse_id, "Use transfer orders to move containers across warehouses.");
  }

  if (input.parent_container_id) {
    guard(input.parent_container_id !== containerId, "CONTAINER_CYCLE_DETECTED", "A container cannot be nested inside itself.", 422);
    const parent = await one<{ warehouse_id: string; status: string }>(
      db,
      "select warehouse_id, status from warehouse_containers where id = $1 for update",
      [input.parent_container_id],
    );
    guard(parent.warehouse_id === cur.warehouse_id, "CROSS_WAREHOUSE_NESTING_FORBIDDEN", "Cannot nest containers across different warehouses.", 422);
    guard(parent.status === "active", "CONTAINER_NOT_ACTIVE", "Target parent container must be active.", 409);

    const cycleCheck = await db.query(
      `with recursive chain as (
         select id, parent_container_id, 0 as depth
         from warehouse_containers where id = $1
         union all
         select c.id, c.parent_container_id, ch.depth + 1
         from warehouse_containers c join chain ch on c.id = ch.parent_container_id
         where ch.depth < 32
       )
       select 1 from chain where id = $2 limit 1`,
      [input.parent_container_id, containerId],
    );
    guard(!cycleCheck.rowCount, "CONTAINER_CYCLE_DETECTED", "Circular container nesting is forbidden.", 422);
  }

  const nextLoc = input.location_id === undefined ? cur.location_id : input.location_id;
  const nextParent = input.parent_container_id === undefined ? cur.parent_container_id : input.parent_container_id;
  const moved = await one(
    db,
    "update warehouse_containers set location_id = $2, parent_container_id = $3, updated_at = now() where id = $1 returning *",
    [containerId, nextLoc, nextParent],
  );
  await audit(db, actor, "move_or_nest_container", "warehouse_containers", containerId, { location_id: nextLoc, parent_container_id: nextParent });
  return moved;
}

export async function createAndDispatchTransfer(
  db: DB,
  actor: Actor,
  input: z.infer<typeof transferDispatchSchema>,
) {
  role(actor, "super_admin", "warehouse_admin");
  guard(input.from_warehouse_id !== input.to_warehouse_id, "INVALID_TRANSFER_ROUTE", "Source and destination warehouses must differ.", 422);

  const fromWh = await one<{ id: string; status: string }>(
    db,
    "select id, status from warehouses where id = $1 for update",
    [input.from_warehouse_id],
  );
  const toWh = await one<{ id: string; status: string; accept_inbound_transit: boolean }>(
    db,
    "select id, status, accept_inbound_transit from warehouses where id = $1 for update",
    [input.to_warehouse_id],
  );
  guard(fromWh.status === "active" || fromWh.status === "paused", "SOURCE_WAREHOUSE_INVALID", "Source warehouse cannot dispatch transfers.", 409);
  guard(
    toWh.status === "active" || (toWh.status === "paused" && toWh.accept_inbound_transit),
    "DESTINATION_WAREHOUSE_UNAVAILABLE",
    "Destination warehouse does not accept inbound transfer deliveries.",
    409,
  );

  if (input.container_id) {
    const c = await one<{ id: string; warehouse_id: string; status: string }>(
      db,
      "select id, warehouse_id, status from warehouse_containers where id = $1 for update",
      [input.container_id],
    );
    guard(c.warehouse_id === input.from_warehouse_id, "CONTAINER_WAREHOUSE_MISMATCH", "Container does not belong to source warehouse.", 409);
    guard(c.status === "active", "CONTAINER_NOT_ACTIVE", "Container must be active to dispatch in transfer.", 409);
    const hasActiveChildren = (
      await db.query(
        "select 1 from warehouse_containers where parent_container_id = $1 and status <> 'retired' limit 1",
        [input.container_id],
      )
    ).rowCount;
    guard(
      !hasActiveChildren,
      "CONTAINER_HAS_CHILDREN",
      "Un-nest or transfer child containers before dispatching a parent container across warehouses.",
      409,
    );
    await db.query(
      "update warehouse_containers set status = 'in_transit', location_id = null, parent_container_id = null, updated_at = now() where id = $1",
      [input.container_id],
    );
  }

  const transferId = uuid();
  const transferNo = numericCode(`TR-${shanghaiYYMMDD()}-`, 4);
  const created = await one(
    db,
    `insert into warehouse_transfer_orders(id, transfer_no, from_warehouse_id, to_warehouse_id, container_id, item_count, status, dispatched_by, note)
     values($1, $2, $3, $4, $5, $6, 'in_transit', $7, $8) returning *`,
    [transferId, transferNo, input.from_warehouse_id, input.to_warehouse_id, input.container_id ?? null, input.item_count, actor.id, input.note ?? null],
  );
  await event(db, "warehouse.transfer_dispatched", { transfer_id: transferId, transfer_no: transferNo, from: input.from_warehouse_id, to: input.to_warehouse_id });
  await audit(db, actor, "dispatch_warehouse_transfer", "warehouse_transfer_orders", transferId, { transfer_no: transferNo });
  return created;
}

export async function receiveWarehouseTransfer(
  db: DB,
  actor: Actor,
  transferId: string,
  input: z.infer<typeof transferReceiveSchema>,
) {
  role(actor, "super_admin", "warehouse_admin");
  const tr = await one<{
    id: string;
    to_warehouse_id: string;
    container_id: string | null;
    item_count: number;
    status: string;
  }>(
    db,
    "select id, to_warehouse_id, container_id, item_count, status from warehouse_transfer_orders where id = $1 for update",
    [transferId],
  );
  guard(tr.status === "in_transit" || tr.status === "dispatched", "TRANSFER_NOT_RECEIVABLE", `Transfer '${transferId}' cannot be received in status '${tr.status}'.`, 409);

  if (input.destination_location_id) {
    await assertWarehouseBinAvailable(db, input.destination_location_id, tr.to_warehouse_id, "Destination bin must belong to destination warehouse.");
  }

  if (tr.container_id) {
    await db.query(
      "update warehouse_containers set warehouse_id = $2, status = 'active', location_id = $3, parent_container_id = null, updated_at = now() where id = $1",
      [tr.container_id, tr.to_warehouse_id, input.destination_location_id ?? null],
    );
  }

  const nextStatus = input.received_item_count === tr.item_count ? "received" : "discrepancy";
  const received = await one(
    db,
    `update warehouse_transfer_orders
     set status = $2, received_by = $3, received_at = now(), note = coalesce($4, note)
     where id = $1 returning *`,
    [transferId, nextStatus, actor.id, input.note ?? null],
  );
  await event(db, "warehouse.transfer_received", { transfer_id: transferId, status: nextStatus, received_item_count: input.received_item_count });
  await audit(db, actor, "receive_warehouse_transfer", "warehouse_transfer_orders", transferId, {
    status: nextStatus,
    received_item_count: input.received_item_count,
  });
  return received;
}

export async function listPackagingConsumables(db: Pick<DB, "query">, actor: Actor, warehouseId: string) {
  role(actor, "super_admin", "warehouse_admin", "receiver", "finance");
  const { rows } = await db.query(
    "select * from packaging_consumables where warehouse_id = $1 order by sku_code asc",
    [warehouseId],
  );
  return { warehouse_id: warehouseId, consumables: rows };
}

export async function createPackagingConsumable(
  db: DB,
  actor: Actor,
  warehouseId: string,
  input: z.infer<typeof consumableCreateSchema>,
) {
  role(actor, "super_admin", "warehouse_admin");
  const wh = await one<{ status: string }>(db, "select status from warehouses where id = $1 for share", [warehouseId]);
  guard(wh.status !== "archived", "WAREHOUSE_ARCHIVED", "Cannot add consumables to an archived warehouse.", 409);

  const id = uuid();
  const row = await one(
    db,
    `insert into packaging_consumables(id, warehouse_id, sku_code, name_zh, name_en, category, unit_name, unit_cost_cents, reorder_threshold_qty)
     values($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [id, warehouseId, input.sku_code, input.name_zh, input.name_en, input.category, input.unit_name, input.unit_cost_cents, input.reorder_threshold_qty],
  );
  await audit(db, actor, "create_packaging_consumable", "packaging_consumables", id, { warehouse_id: warehouseId, sku_code: input.sku_code });
  return row;
}

export async function adjustConsumableStock(
  db: DB,
  actor: Actor,
  consumableId: string,
  input: z.infer<typeof consumableAdjustSchema>,
) {
  role(actor, "super_admin", "warehouse_admin", "receiver");
  const cur = await one<{ id: string; warehouse_id: string; sku_code: string; on_hand_qty: number; status: string }>(
    db,
    "select id, warehouse_id, sku_code, on_hand_qty, status from packaging_consumables where id = $1 for update",
    [consumableId],
  );
  guard(cur.status === "active", "CONSUMABLE_DISABLED", "Disabled consumable SKU cannot be adjusted.", 409);
  const nextQty = cur.on_hand_qty + input.delta_qty;
  guard(nextQty >= 0, "INSUFFICIENT_CONSUMABLE_STOCK", `Consumable '${cur.sku_code}' has ${cur.on_hand_qty} on hand; cannot apply delta ${input.delta_qty}.`, 409);

  const updated = await one(
    db,
    "update packaging_consumables set on_hand_qty = $2, updated_at = now() where id = $1 returning *",
    [consumableId, nextQty],
  );
  await db.query(
    `insert into consumable_stock_ledger(id, consumable_id, delta_qty, balance_after, reason_code, reference_id, note, actor_id)
     values($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuid(), consumableId, input.delta_qty, nextQty, input.reason_code, input.reference_id ?? null, input.note ?? null, actor.id],
  );
  await audit(db, actor, "adjust_consumable_stock", "packaging_consumables", consumableId, {
    delta_qty: input.delta_qty,
    balance_after: nextQty,
    reason_code: input.reason_code,
  });
  return updated;
}
