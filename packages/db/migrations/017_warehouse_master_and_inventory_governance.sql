-- 017: Self-operated warehouse master data, zones, hierarchical bins, reservations, containers, transfers & packaging consumables (TASK-182)

CREATE TABLE IF NOT EXISTS warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_code text NOT NULL UNIQUE,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  legal_entity_id uuid REFERENCES legal_entities(id),
  manager_user_id uuid REFERENCES users(id),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  status text NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  accept_new_orders boolean NOT NULL DEFAULT false,
  accept_inbound_transit boolean NOT NULL DEFAULT false,
  allow_fulfillment boolean NOT NULL DEFAULT false,
  allow_dispatch boolean NOT NULL DEFAULT false,
  receiving_address_snapshot_id uuid REFERENCES address_snapshots(id),
  dispatch_address_snapshot_id uuid REFERENCES address_snapshots(id),
  legacy_warehouse_address_id uuid REFERENCES warehouse_addresses(id),
  cutoff_receiving_time text NOT NULL DEFAULT '17:30',
  cutoff_dispatch_time text NOT NULL DEFAULT '16:00',
  working_days int[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5, 6],
  supported_categories text[] NOT NULL DEFAULT ARRAY['apparel']::text[],
  total_capacity_units int NOT NULL DEFAULT 0 CHECK (total_capacity_units >= 0),
  code_rules jsonb NOT NULL DEFAULT '{"location_pattern":"{WH}-{ZONE}-{RACK}-{LEVEL}-{BIN}","container_prefix":"TOTE"}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouse_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  zone_code text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  zone_type text NOT NULL CHECK (zone_type IN (
    'receiving', 'unidentified', 'pending_qc', 'in_progress', 'pending_qa',
    'normal_storage', 'golden_sample', 'quarantine', 'pending_pack', 'pending_handover'
  )),
  is_ground_staging boolean NOT NULL DEFAULT false,
  storage_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, zone_code)
);

ALTER TABLE storage_locations
  ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id),
  ADD COLUMN IF NOT EXISTS warehouse_zone_id uuid REFERENCES warehouse_zones(id),
  ADD COLUMN IF NOT EXISTS rack_code text,
  ADD COLUMN IF NOT EXISTS shelf_level int,
  ADD COLUMN IF NOT EXISTS bin_slot int,
  ADD COLUMN IF NOT EXISTS max_weight_g int CHECK (max_weight_g IS NULL OR max_weight_g > 0),
  ADD COLUMN IF NOT EXISTS reserved_units int NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  ADD COLUMN IF NOT EXISTS frozen boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS storage_locations_warehouse_idx
  ON storage_locations (warehouse_id, warehouse_zone_id);

CREATE TABLE IF NOT EXISTS warehouse_containers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  container_code text NOT NULL UNIQUE,
  container_type text NOT NULL CHECK (container_type IN ('tote', 'carton', 'pallet', 'garment_rack', 'vault_box')),
  parent_container_id uuid REFERENCES warehouse_containers(id),
  location_id uuid REFERENCES storage_locations(id),
  capacity_units int NOT NULL CHECK (capacity_units > 0),
  occupied_units int NOT NULL DEFAULT 0 CHECK (occupied_units >= 0 AND occupied_units <= capacity_units),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_transit', 'retired')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_container_id IS NULL OR parent_container_id <> id)
);

CREATE INDEX IF NOT EXISTS warehouse_containers_wh_idx
  ON warehouse_containers (warehouse_id, status);

CREATE TABLE IF NOT EXISTS location_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES storage_locations(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  reference_type text NOT NULL CHECK (reference_type IN ('inbound_advice', 'qc_task', 'golden_sample', 'dispatch_pack', 'transfer')),
  reference_id text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released', 'expired')),
  reserved_by uuid REFERENCES users(id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX IF NOT EXISTS location_reservations_loc_idx
  ON location_reservations (location_id, status);

CREATE TABLE IF NOT EXISTS packaging_consumables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  sku_code text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  category text NOT NULL CHECK (category IN ('carton', 'polybag', 'label_roll', 'security_seal', 'cushioning', 'desiccant', 'other')),
  unit_name text NOT NULL DEFAULT 'pcs',
  unit_cost_cents int NOT NULL DEFAULT 0 CHECK (unit_cost_cents >= 0),
  reorder_threshold_qty int NOT NULL DEFAULT 0 CHECK (reorder_threshold_qty >= 0),
  on_hand_qty int NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, sku_code)
);

CREATE TABLE IF NOT EXISTS consumable_stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumable_id uuid NOT NULL REFERENCES packaging_consumables(id),
  delta_qty int NOT NULL CHECK (delta_qty <> 0),
  balance_after int NOT NULL CHECK (balance_after >= 0),
  reason_code text NOT NULL CHECK (reason_code IN ('restock', 'pack_consume', 'stocktake_adjust', 'damage_writeoff', 'transfer_out', 'transfer_in')),
  reference_id text,
  note text,
  actor_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouse_transfer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no text NOT NULL UNIQUE,
  from_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  to_warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  container_id uuid REFERENCES warehouse_containers(id),
  item_count int NOT NULL CHECK (item_count > 0),
  status text NOT NULL CHECK (status IN ('dispatched', 'in_transit', 'received', 'discrepancy', 'cancelled')),
  dispatched_by uuid REFERENCES users(id),
  received_by uuid REFERENCES users(id),
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_warehouse_id <> to_warehouse_id)
);
