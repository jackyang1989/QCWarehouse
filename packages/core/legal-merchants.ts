import { z } from "zod";
import type { DB } from "../db";
import { audit, guard, isDemo, lock, one, role, uuid, type Actor } from "./common";
import { requireStaffMfa } from "./auth";
import { emailChannelReadiness } from "./email";
import { integrationPreflight, signInMethods } from "./integrations";
import { stripeSettingsFromDb } from "./integrations";
import { demoWarehouseAddressZh } from "./demo-fixtures";

export const legalEntityCreateSchema = z.object({
  entity_code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i),
  entity_type: z.enum(["sole_proprietor", "individual_operator", "company"]),
  public_trade_name: z.string().trim().min(2).max(160),
  legal_name: z.string().trim().min(2).max(200),
  jurisdiction: z.string().trim().min(2).max(80),
  registration_no: z.string().trim().max(120).nullable().optional(),
  tax_id: z.string().trim().max(120).nullable().optional(),
  contact_email: z.email().max(254).transform((v) => v.toLowerCase()),
  service_address: z.string().trim().min(4).max(400),
});

export const merchantInstanceCreateSchema = z.object({
  instance_code: z.string().trim().min(2).max(60).regex(/^[a-z0-9_-]+$/i),
  provider: z.enum(["stripe", "paypal_manual", "paypal_auto"]),
  environment: z.enum(["sandbox", "live"]),
  legal_entity_id: z.uuid(),
  external_account_id: z.string().trim().min(2).max(160),
  supported_currencies: z.array(z.enum(["USD", "CNY"])).min(1),
  settlement_account_masked: z.string().trim().min(2).max(120),
  status: z.enum(["accepting_new", "legacy_only", "paused", "revoked", "retired"]).default("paused"),
  is_primary_for_new_orders: z.boolean().default(false),
});

export const merchantInstanceStatusSchema = z.object({
  status: z.enum(["accepting_new", "legacy_only", "paused", "revoked", "retired"]),
  is_primary_for_new_orders: z.boolean().optional(),
  reason: z.string().trim().min(4).max(500),
});

export async function listLegalEntities(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin");
  const { rows } = await db.query(
    `select id, entity_code, entity_type, public_trade_name, legal_name, jurisdiction,
            registration_no, tax_id, contact_email, service_address, status,
            is_default_for_new_orders, version, created_by, approved_by, created_at, updated_at
     from legal_entities
     order by is_default_for_new_orders desc, created_at desc`,
  );
  return { entities: rows };
}

export async function createLegalEntityDraft(
  db: DB,
  actor: Actor,
  input: z.infer<typeof legalEntityCreateSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  if (input.entity_type === "company") {
    guard(
      Boolean(input.registration_no?.trim()),
      "REGISTRATION_NO_REQUIRED",
      "Company entities require a valid corporate registration/BR number.",
      422,
    );
  }
  const id = uuid();
  const created = await one(
    db,
    `insert into legal_entities(
       id, entity_code, entity_type, public_trade_name, legal_name, jurisdiction,
       registration_no, tax_id, contact_email, service_address, status, is_default_for_new_orders, created_by
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', false, $11)
     returning id, entity_code, entity_type, public_trade_name, legal_name, jurisdiction, registration_no, status, is_default_for_new_orders, version`,
    [
      id,
      input.entity_code.toUpperCase(),
      input.entity_type,
      input.public_trade_name,
      input.legal_name,
      input.jurisdiction,
      input.registration_no?.trim() || null,
      input.tax_id?.trim() || null,
      input.contact_email,
      input.service_address,
      actor.id,
    ],
  );
  await audit(db, actor, "create_legal_entity_draft", "legal_entities", id, {
    entity_code: input.entity_code.toUpperCase(),
    entity_type: input.entity_type,
  });
  return created;
}

export async function activateLegalEntity(db: DB, actor: Actor, entityId: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "legal_entities:default");
  const current = await one<{ id: string; status: string; entity_code: string }>(
    db,
    "select id, status, entity_code from legal_entities where id = $1 for update",
    [entityId],
  );
  guard(current.status !== "retired", "ENTITY_RETIRED", "Retired legal entities cannot be reactivated; create a new draft.", 409);

  await db.query("update legal_entities set is_default_for_new_orders = false, updated_at = now() where is_default_for_new_orders");
  const activated = await one(
    db,
    `update legal_entities
     set status = 'active', is_default_for_new_orders = true, approved_by = $2, updated_at = now()
     where id = $1
     returning id, entity_code, entity_type, public_trade_name, legal_name, jurisdiction, status, is_default_for_new_orders, version`,
    [entityId, actor.id],
  );
  await audit(db, actor, "activate_legal_entity", "legal_entities", entityId, {
    entity_code: current.entity_code,
    is_default_for_new_orders: true,
  });
  return activated;
}

export async function retireLegalEntity(db: DB, actor: Actor, entityId: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "legal_entities:default");
  const current = await one<{ id: string; is_default_for_new_orders: boolean; entity_code: string }>(
    db,
    "select id, is_default_for_new_orders, entity_code from legal_entities where id = $1 for update",
    [entityId],
  );
  guard(!current.is_default_for_new_orders, "ENTITY_IN_USE", "Switch default legal entity before retiring the active default.", 409);
  const activeMerchants = (
    await db.query(
      "select 1 from merchant_instances where legal_entity_id = $1 and status = 'accepting_new' limit 1",
      [entityId],
    )
  ).rowCount;
  guard(!activeMerchants, "ENTITY_HAS_ACTIVE_MERCHANTS", "Pause or move merchant instances out of accepting_new first.", 409);

  const retired = await one(
    db,
    "update legal_entities set status = 'retired', updated_at = now() where id = $1 returning id, entity_code, status",
    [entityId],
  );
  await audit(db, actor, "retire_legal_entity", "legal_entities", entityId, { entity_code: current.entity_code });
  return retired;
}

export async function listMerchantInstances(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin");
  const { rows } = await db.query(
    `select m.id, m.instance_code, m.provider, m.environment, m.legal_entity_id,
            le.entity_code, le.legal_name, m.external_account_id, m.supported_currencies,
            m.settlement_account_masked, m.status, m.is_primary_for_new_orders,
            m.config_version, m.created_at, m.updated_at
     from merchant_instances m
     join legal_entities le on le.id = m.legal_entity_id
     order by m.provider, m.environment, m.is_primary_for_new_orders desc, m.created_at desc`,
  );
  return { instances: rows };
}

export async function createMerchantInstance(
  db: DB,
  actor: Actor,
  input: z.infer<typeof merchantInstanceCreateSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const entity = await one<{ id: string; status: string }>(
    db,
    "select id, status from legal_entities where id = $1",
    [input.legal_entity_id],
  );
  guard(entity.status !== "retired", "ENTITY_RETIRED", "Cannot bind merchant instance to a retired legal entity.", 409);
  const makePrimary = input.status === "accepting_new" && input.is_primary_for_new_orders;

  await lock(db, `merchant_instances:${input.provider}:${input.environment}`);
  if (makePrimary) {
    await db.query(
      `update merchant_instances set is_primary_for_new_orders = false, updated_at = now()
       where provider = $1 and environment = $2 and is_primary_for_new_orders`,
      [input.provider, input.environment],
    );
  }
  const id = uuid();
  const created = await one(
    db,
    `insert into merchant_instances(
       id, instance_code, provider, environment, legal_entity_id, external_account_id,
       supported_currencies, settlement_account_masked, status, is_primary_for_new_orders, created_by
     ) values($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11)
     returning id, instance_code, provider, environment, legal_entity_id, external_account_id,
               supported_currencies, settlement_account_masked, status, is_primary_for_new_orders, config_version`,
    [
      id,
      input.instance_code.toLowerCase(),
      input.provider,
      input.environment,
      input.legal_entity_id,
      input.external_account_id,
      input.supported_currencies,
      input.settlement_account_masked,
      input.status,
      makePrimary,
      actor.id,
    ],
  );
  await audit(db, actor, "create_merchant_instance", "merchant_instances", id, {
    instance_code: input.instance_code.toLowerCase(),
    provider: input.provider,
    environment: input.environment,
    status: input.status,
  });
  return created;
}

export async function transitionMerchantInstanceStatus(
  db: DB,
  actor: Actor,
  instanceId: string,
  input: z.infer<typeof merchantInstanceStatusSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const existing = await one<{
    id: string;
    instance_code: string;
    provider: string;
    environment: string;
    status: string;
    is_primary_for_new_orders: boolean;
  }>(
    db,
    `select id, instance_code, provider, environment, status, is_primary_for_new_orders
     from merchant_instances where id = $1 for update`,
    [instanceId],
  );
  await lock(db, `merchant_instances:${existing.provider}:${existing.environment}`);
  const nextPrimary =
    input.status === "accepting_new" ? Boolean(input.is_primary_for_new_orders ?? existing.is_primary_for_new_orders) : false;

  if (nextPrimary) {
    await db.query(
      `update merchant_instances set is_primary_for_new_orders = false, updated_at = now()
       where provider = $1 and environment = $2 and is_primary_for_new_orders and id <> $3`,
      [existing.provider, existing.environment, instanceId],
    );
  }
  const updated = await one(
    db,
    `update merchant_instances
     set status = $2, is_primary_for_new_orders = $3, config_version = config_version + 1, updated_at = now()
     where id = $1
     returning id, instance_code, provider, environment, status, is_primary_for_new_orders, config_version`,
    [instanceId, input.status, nextPrimary],
  );
  await audit(db, actor, "transition_merchant_instance", "merchant_instances", instanceId, {
    instance_code: existing.instance_code,
    previous_status: existing.status,
    next_status: input.status,
    is_primary_for_new_orders: nextPrimary,
    reason: input.reason,
  });
  return updated;
}

/**
 * §108.4 Opening readiness capability matrix: strictly preserves Google & Microsoft OIDC +
 * Stripe Live + legal entity + primary email + default warehouse as required gates while keeping
 * PayPal manual/OCR optional and separating configured vs live-verified vs production-approved.
 */
export async function evaluateOpeningReadinessMatrix(db: DB, actor: Actor) {
  role(actor, "super_admin");
  const stripe = await stripeSettingsFromDb(db);
  const preflight = integrationPreflight(stripe);
  const oidc = await signInMethods(db);
  const email = await emailChannelReadiness(db, actor);

  const entityRow = (
    await db.query<{ entity_type: string; entity_code: string }>(
      "select entity_type, entity_code from legal_entities where status = 'active' and is_default_for_new_orders limit 1",
    )
  ).rows[0];
  const legacyEntityCfg = (
    await db.query<{ value: Record<string, unknown> }>("select value from app_config where key = 'legal.entity'")
  ).rows[0]?.value;
  const entityConfigured = Boolean(
    entityRow || (legacyEntityCfg?.entity_name && legacyEntityCfg?.entity_address && legacyEntityCfg?.support_email),
  );

  const warehouseOk = Boolean(
    (
      await db.query(
        "select 1 from warehouse_addresses where active and is_default and address_zh <> $1 limit 1",
        [demoWarehouseAddressZh],
      )
    ).rowCount,
  );
  const stripeMerchantCount = (
    await db.query<{ c: number }>(
      "select count(*)::int as c from merchant_instances where provider = 'stripe' and environment = 'live' and status = 'accepting_new'",
    )
  ).rows[0]?.c ?? 0;
  const paypalManualMerchantCount = (
    await db.query<{ c: number }>(
      "select count(*)::int as c from merchant_instances where provider = 'paypal_manual' and status = 'accepting_new'",
    )
  ).rows[0]?.c ?? 0;
  const paypalManualProvider = (
    await db.query<{ enabled: boolean }>(
      "select enabled from integration_providers where provider_key = 'paypal_manual' limit 1",
    )
  ).rows[0];

  const capabilities = {
    google_oidc: {
      tier: "required" as const,
      configured: Boolean(preflight.google.configured && oidc.google),
      live_verified: false,
      status: Boolean(preflight.google.configured && oidc.google) ? ("configured_unverified" as const) : ("missing" as const),
    },
    microsoft_oidc: {
      tier: "required" as const,
      configured: Boolean(preflight.microsoft.configured && oidc.microsoft),
      live_verified: false,
      status: Boolean(preflight.microsoft.configured && oidc.microsoft) ? ("configured_unverified" as const) : ("missing" as const),
    },
    stripe_live: {
      tier: "required" as const,
      configured: stripe.mode === "live" && preflight.stripe.checkoutConfigured && stripeMerchantCount >= 1,
      accepting_new_merchant_count: stripeMerchantCount,
      status:
        stripe.mode === "live" && preflight.stripe.checkoutConfigured && stripeMerchantCount >= 1
          ? ("configured_unverified" as const)
          : ("missing" as const),
    },
    legal_entity: {
      tier: "required" as const,
      configured: entityConfigured,
      default_entity_type: entityRow?.entity_type ?? (legacyEntityCfg ? "legacy_app_config" : null),
      status: entityConfigured ? ("configured" as const) : ("missing" as const),
    },
    default_warehouse: {
      tier: "required" as const,
      configured: warehouseOk,
      status: warehouseOk ? ("configured" as const) : ("missing" as const),
    },
    email_primary: {
      tier: "required" as const,
      configured: email.channels.resend.configured || email.channels.postmark.configured,
      connection_tested: email.channels.resend.connection_tested || email.channels.postmark.connection_tested,
      verified_live_delivery: email.channels.resend.verified_live_delivery || email.channels.postmark.verified_live_delivery,
      status:
        email.channels.resend.configured || email.channels.postmark.configured
          ? ("configured_unverified" as const)
          : ("missing" as const),
    },
    kuaidi100_logistics: {
      tier: "conditional" as const,
      configured: Boolean(preflight.kuaidi100.queryConfigured && preflight.kuaidi100.httpsCallbackConfigured),
      status: preflight.kuaidi100.queryConfigured ? ("configured" as const) : ("optional_or_manual" as const),
    },
    paypal_manual: {
      tier: "optional" as const,
      enabled: Boolean(paypalManualProvider?.enabled),
      accepting_new_merchant_count: paypalManualMerchantCount,
      default_off: !paypalManualProvider?.enabled,
    },
    ocr_paddle: {
      tier: "optional" as const,
      configured: true,
      blocks_manual_workflow: false as const,
    },
  };

  const missingRequired = Object.entries(capabilities)
    .filter(([, entry]) => entry.tier === "required" && !entry.configured)
    .map(([name]) => name);

  return {
    checked_at: new Date().toISOString(),
    demo_mode: isDemo(),
    capabilities,
    missing_required: missingRequired,
    all_required_configured: missingRequired.length === 0,
    opening_approved: false as const,
  };
}
