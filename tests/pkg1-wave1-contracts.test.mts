import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { DB } from "../packages/db";
import { Problem, type Actor } from "../packages/core/common";
import {
  ACTION_CATALOG,
  assertCustomerTenantOwnership,
  assertIdempotencyContract,
  assertLastOwnerPreserved,
  assertLifecycleTransition,
  authorizeOwnerBootstrap,
  buildDomainEventEnvelope,
  evaluateAuthorization,
  redactFieldsForActor,
  resolvePermissionsForRoles,
  type StaffScopeContext,
} from "../packages/core/authz-contract";
import { canOpenStaffPage, resolvePortalRoute } from "../packages/core/portal-routes";
import {
  assertBusinessFactsPreserved,
  assertEnabledLocale,
  buildLocaleSafeOAuthReturnPath,
  buildSsrLocaleMetadata,
  createDynamicTranslationDraft,
  ENABLED_LOCALES,
  freezeHistoricalLocaleSnapshot,
  FUTURE_EXTENSIBLE_LOCALES,
  LOCALE_REGISTRY,
  localizePublicPath,
  markTranslationStaleIfSourceChanged,
  normalizeLocaleTag,
  resolveAccountLocalePreferences,
  resolveLocalizedPublicPath,
  toLegacyDbLocale,
  validateFixedResourceBundle,
  type DynamicTranslationRecord,
} from "../packages/core/locale-contract";

// ---------- TASK-180A: Unified AuthZ & Domain Contracts ----------

test("TASK-180A: ordinary roles cannot bypass direct admin routes or LIF-004 privilege drift", () => {
  const blockedForTemplateAdmin = [
    "/admin/users",
    "/admin/legal",
    "/admin/config",
    "/admin/shipping-rates",
    "/admin/catalog",
    "/admin/categories",
    "/admin/templates",
    "/admin/integrations",
    "/admin/integrations/payments",
    "/admin/integrations/ocr",
    "/admin/integrations/email",
    "/admin/integrations/logistics",
    "/admin/audit",
    "/admin/operations",
  ];
  for (const path of blockedForTemplateAdmin) {
    const route = resolvePortalRoute(path);
    assert.ok(route, `Expected route resolution for ${path}`);
    assert.equal(canOpenStaffPage(path, route, ["template_admin"]), false, `template_admin must not open ${path}`);
    assert.equal(canOpenStaffPage(path, route, ["receiver"]), false, `receiver must not open ${path}`);
    assert.equal(canOpenStaffPage(path, route, ["super_admin"]), true, `super_admin must open ${path}`);
  }
  const settingsRoute = resolvePortalRoute("/admin/settings")!;
  assert.equal(canOpenStaffPage("/admin/settings", settingsRoute, ["template_admin"]), true);

  // Align ADMIN_DIRECT_ROUTE_ROLES parity on /admin/customers and /admin/inspections
  const customersRoute = resolvePortalRoute("/admin/customers")!;
  const inspectionsRoute = resolvePortalRoute("/admin/inspections")!;
  assert.equal(canOpenStaffPage("/admin/customers", customersRoute, ["support"]), true);
  assert.equal(canOpenStaffPage("/admin/customers", customersRoute, ["template_admin"]), false);
  assert.equal(canOpenStaffPage("/admin/inspections", inspectionsRoute, ["inspector"]), true);
  assert.equal(canOpenStaffPage("/admin/inspections", inspectionsRoute, ["template_admin"]), false);
});

test("TASK-180A: multi-role evaluation, scope intersection, SoD, revocation & field redaction enforce zero bypass", () => {
  const inspector: Actor = {
    id: "11111111-1111-4111-8111-111111111111",
    org: null,
    kind: "staff",
    roles: ["inspector", "support"],
  };
  const activeScope: StaffScopeContext = {
    accountStatus: "active",
    sessionAuthVersion: 3,
    userAuthVersion: 3,
    mfaFresh: true,
    allowedWarehouseIds: ["wh-sz-01"],
    assignedTaskIds: ["task-a"],
    allowedOrgIds: ["org-1"],
  };

  assert.equal(evaluateAuthorization(inspector, "qc.execute", activeScope, { warehouseId: "wh-sz-01", taskId: "task-a" }).allowed, true);

  // Ordinary multi-role staff (inspector + support) cannot approve refunds, rotate secrets, or read PII export.
  for (const forbidden of ["finance.refund_approve", "system.secrets_rotate", "customers.read_pii", "staff.grant_roles"] as const) {
    assert.throws(
      () => evaluateAuthorization(inspector, forbidden, activeScope),
      (err: unknown) => err instanceof Problem && err.status === 403 && err.code === "FORBIDDEN",
    );
  }

  // Multi-role combination NEVER widens unauthorized warehouse, task, or customer tenant scope.
  assert.throws(
    () => evaluateAuthorization(inspector, "qc.execute", activeScope, { warehouseId: "wh-gz-99", taskId: "task-a" }),
    (err: unknown) => err instanceof Problem && err.code === "WAREHOUSE_SCOPE_DENIED",
  );
  assert.throws(
    () => evaluateAuthorization(inspector, "qc.execute", activeScope, { warehouseId: "wh-sz-01", taskId: "task-unassigned" }),
    (err: unknown) => err instanceof Problem && err.code === "TASK_SCOPE_DENIED",
  );
  assert.throws(
    () => evaluateAuthorization(inspector, "orders.read", activeScope, { orgId: "org-other" }),
    (err: unknown) => err instanceof Problem && err.code === "TENANT_SCOPE_DENIED",
  );
  // Undefined assignedTaskIds / allowedOrgIds fail closed when target specifies taskId / orgId
  assert.throws(
    () => evaluateAuthorization(inspector, "qc.execute", { accountStatus: "active", allowedWarehouseIds: "ALL" }, { taskId: "task-a" }),
    (err: unknown) => err instanceof Problem && err.code === "TASK_SCOPE_DENIED",
  );
  assert.throws(
    () => evaluateAuthorization(inspector, "orders.read", { accountStatus: "active", allowedWarehouseIds: "ALL" }, { orgId: "org-1" }),
    (err: unknown) => err instanceof Problem && err.code === "TENANT_SCOPE_DENIED",
  );

  // Explicit deny & Separation of Duties beat even super_admin role grants.
  const superAdmin: Actor = {
    id: "22222222-2222-4222-8222-222222222222",
    org: null,
    kind: "staff",
    roles: ["super_admin"],
  };
  assert.throws(
    () =>
      evaluateAuthorization(
        superAdmin,
        "qc.qa_approve",
        { accountStatus: "active", sessionAuthVersion: 1, userAuthVersion: 1, allowedWarehouseIds: "ALL" },
        { actorLinks: { inspector_id: superAdmin.id } },
      ),
    (err: unknown) => err instanceof Problem && err.code === "SELF_REVIEW_FORBIDDEN",
  );
  assert.throws(
    () =>
      evaluateAuthorization(
        superAdmin,
        "system.secrets_rotate",
        { accountStatus: "active", mfaFresh: false, allowedWarehouseIds: "ALL" },
      ),
    (err: unknown) => err instanceof Problem && err.code === "STAFF_REAUTH_REQUIRED",
  );
  assert.throws(
    () =>
      evaluateAuthorization(
        superAdmin,
        "qc.execute",
        { accountStatus: "active", sessionAuthVersion: 1, userAuthVersion: 2, allowedWarehouseIds: "ALL" },
      ),
    (err: unknown) => err instanceof Problem && err.status === 401 && err.code === "SESSION_VERSION_STALE",
  );
  assert.throws(
    () =>
      evaluateAuthorization(
        superAdmin,
        "qc.execute",
        { accountStatus: "active", sessionRevokedAt: new Date().toISOString(), allowedWarehouseIds: "ALL" },
      ),
    (err: unknown) => err instanceof Problem && err.status === 401 && err.code === "SESSION_REVOKED",
  );

  // Field projection strips cost/margin/customer PII from unauthorized roles.
  const rawOrder = {
    public_no: "QW261127001",
    customer_email: "buyer@example.com",
    selling_cents: 4500,
    actual_cost_cents: 1200,
    profit_cents: 3300,
  };
  const redactedForSupport = redactFieldsForActor(inspector, rawOrder, {
    customer_email: "customer_contact",
    selling_cents: "selling_price",
    actual_cost_cents: "actual_cost",
    profit_cents: "profit_margin",
  });
  assert.equal(redactedForSupport.public_no, "QW261127001");
  assert.equal(redactedForSupport.customer_email, "buyer@example.com");
  assert.equal("actual_cost_cents" in redactedForSupport, false);
  assert.equal("profit_cents" in redactedForSupport, false);

  // Customer tenant isolation & lifecycle/idempotency contracts.
  assert.throws(
    () => assertCustomerTenantOwnership({ id: "u1", org: "org-a", kind: "customer", roles: [] }, "org-b"),
    (err: unknown) => err instanceof Problem && err.status === 404,
  );
  assert.throws(
    () => assertLifecycleTransition("draft", "completed", { draft: ["submitted"], submitted: ["completed"], completed: [] }),
    (err: unknown) => err instanceof Problem && err.code === "INVALID_STATE_TRANSITION",
  );
  const env = buildDomainEventEnvelope({
    eventType: "order.submitted",
    actor: superAdmin,
    entityType: "orders",
    entityId: "ord-1",
    entityVersion: 2,
    payload: { total_cents: 4500 },
  });
  assert.equal(env.schema_version, 1);
  assert.equal(env.entity_version, 2);
  assert.ok(resolvePermissionsForRoles(["receiver"]).includes("warehouse.intake"));
  assert.equal(Object.keys(ACTION_CATALOG).length >= 50, true);
});

test("TASK-180A: Owner bootstrap exception, last-Owner protection & T42 idempotency reject abuse", async () => {
  const token = "bootstrap-secret-token-at-least-24-chars";

  // 1) Bootstrap allowed strictly when 0 active super_admin rows exist and secret matches.
  const emptyOwnerDb = { query: async () => ({ rows: [{ count: 0 }], rowCount: 1 }) } as unknown as Pick<DB, "query">;
  assert.equal((await authorizeOwnerBootstrap(emptyOwnerDb, token, token)).permitted, true);

  // 2) Bad bootstrap token rejected even when count === 0.
  await assert.rejects(
    authorizeOwnerBootstrap(emptyOwnerDb, "wrong-token", token),
    (err: unknown) => err instanceof Problem && err.code === "BOOTSTRAP_CREDENTIAL_INVALID",
  );

  // 3) Once an active super_admin exists, Owner bootstrap exception is permanently closed.
  const activeOwnerDb = { query: async () => ({ rows: [{ count: 1 }], rowCount: 1 }) } as unknown as Pick<DB, "query">;
  await assert.rejects(
    authorizeOwnerBootstrap(activeOwnerDb, token, token),
    (err: unknown) => err instanceof Problem && err.code === "OWNER_BOOTSTRAP_CLOSED",
  );

  // 4) Removing/disabling the sole remaining active super_admin is rejected cleanly.
  await assert.rejects(
    assertLastOwnerPreserved(emptyOwnerDb, "last-owner-id"),
    (err: unknown) => err instanceof Problem && err.code === "LAST_OWNER_PROTECTED" && err.status === 409,
  );

  // 5) Idempotency contract replays identical payload and rejects conflicting payload (T42).
  const key = randomUUID();
  const idempStore = new Map<string, { request_hash: string; response: unknown }>();
  const mockDb = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("select pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("select request_hash")) {
        const hit = idempStore.get(`${params[0]}::${params[1]}`);
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.startsWith("insert into idempotency_keys")) {
        idempStore.set(`${params[0]}::${params[1]}`, {
          request_hash: String(params[2]),
          response: JSON.parse(String(params[3])),
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DB;

  let runs = 0;
  const first = await assertIdempotencyContract(mockDb, "actor-1", "POST", "/orders", key, { qty: 3 }, async () => {
    runs++;
    return { order_id: "ord-1", runs };
  });
  const replay = await assertIdempotencyContract(mockDb, "actor-1", "POST", "/orders", key, { qty: 3 }, async () => {
    runs++;
    return { order_id: "ord-2", runs };
  });
  assert.deepEqual(replay, first);
  assert.equal(runs, 1);

  await assert.rejects(
    assertIdempotencyContract(mockDb, "actor-1", "POST", "/orders", key, { qty: 99 }, async () => ({ order_id: "ord-3" })),
    (err: unknown) => err instanceof Problem && err.code === "IDEMPOTENCY_CONFLICT",
  );
});

// ---------- TASK-190A: Locale Contracts (BCP47, Resources, 3 Tiers, SSR & OAuth) ----------

test("TASK-190A: BCP47 registry enables en-US/zh-CN and isolates unenabled 3rd locales", () => {
  assert.deepEqual(ENABLED_LOCALES, ["en-US", "zh-CN"]);
  assert.equal(normalizeLocaleTag("en"), "en-US");
  assert.equal(normalizeLocaleTag("en_US"), "en-US");
  assert.equal(normalizeLocaleTag("zh"), "zh-CN");
  assert.equal(normalizeLocaleTag("zh_CN"), "zh-CN");
  assert.equal(assertEnabledLocale("zh"), "zh-CN");
  assert.equal(assertEnabledLocale("en-US"), "en-US");
  assert.equal(toLegacyDbLocale("en-US"), "en");
  assert.equal(toLegacyDbLocale("zh-CN"), "zh-CN");

  for (const future of FUTURE_EXTENSIBLE_LOCALES) {
    assert.equal(LOCALE_REGISTRY[future].enabled, false);
    assert.equal(LOCALE_REGISTRY[future].selectable, false);
    assert.throws(
      () => assertEnabledLocale(future),
      (err: unknown) => err instanceof Problem && err.code === "LOCALE_NOT_ENABLED" && err.status === 422,
    );
  }
  assert.throws(
    () => assertEnabledLocale("xx-INVALID"),
    (err: unknown) => err instanceof Problem && err.code === "LOCALE_UNSUPPORTED" && err.status === 422,
  );
});

test("TASK-190A: fixed vs dynamic resources, stale detection, historical snapshot freeze & business-fact guard", () => {
  const validFixed = validateFixedResourceBundle([
    {
      kind: "fixed",
      key: "order.items_count",
      placeholders: ["count", "orderNo"],
      values: {
        "en-US": "Order {orderNo} contains {count} items.",
        "zh-CN": "订单 {orderNo} 共包含 {count} 件实物。",
      },
    },
  ]);
  assert.equal(validFixed.ok, true);

  const brokenFixed = validateFixedResourceBundle([
    {
      kind: "fixed",
      key: "order.items_count",
      placeholders: ["count", "orderNo"],
      values: {
        "en-US": "Order {orderNo} contains {qty} items.",
        "zh-CN": "",
      },
    },
  ]);
  assert.equal(brokenFixed.ok, false);
  assert.equal(brokenFixed.missingKeys.length, 1);
  assert.equal(brokenFixed.placeholderMismatches.length, 1);

  const draft = createDynamicTranslationDraft({
    entityType: "service_offer",
    entityId: "offer-apparel-1",
    fieldKey: "title",
    locale: "zh-CN",
    sourceLocale: "en-US",
    sourceRevision: 1,
    sourceText: "Standard Garment Inspection",
    translatedText: "服装标准质检",
    translatorKind: "human",
  });
  const approved: DynamicTranslationRecord = {
    ...draft,
    status: "approved",
    approvedBy: "reviewer-1",
  };
  const historical = freezeHistoricalLocaleSnapshot({
    snapshotId: "snap-1",
    entityType: "service_offer",
    entityId: "offer-apparel-1",
    entityVersion: 1,
    locale: "zh-CN",
    records: [approved],
    sourceTexts: { title: "Standard Garment Inspection" },
  });
  assert.equal(historical.frozenFields.title, "服装标准质检");

  // Unapproved drafts cannot be frozen into historical snapshots.
  assert.throws(
    () =>
      freezeHistoricalLocaleSnapshot({
        snapshotId: "snap-bad",
        entityType: "service_offer",
        entityId: "offer-apparel-1",
        entityVersion: 1,
        locale: "zh-CN",
        records: [draft],
        sourceTexts: { title: "Standard Garment Inspection" },
      }),
    (err: unknown) => err instanceof Problem && err.code === "LOCALE_TRANSLATION_UNAPPROVED",
  );

  // Source change marks dynamic draft stale WITHOUT mutating historical frozen snapshots.
  const stale = markTranslationStaleIfSourceChanged(approved, "Updated Garment Inspection", 2);
  assert.equal(stale.status, "stale");
  assert.equal(historical.frozenFields.title, "服装标准质检");

  assert.throws(
    () =>
      assertBusinessFactsPreserved(
        { sku_code: "apparel-inspection-1", amount_cents: 4500, address_raw: "广东省东莞市XX路1号" },
        { sku_code: "apparel-inspection-1", amount_cents: 4500, address_raw: "No.1 XX Road, Dongguan" },
      ),
    (err: unknown) => err instanceof Problem && err.code === "NON_TRANSLATABLE_FACT_MUTATION",
  );
});

test("TASK-190A: 3 independent preference tiers, staff zh-CN default, SSR hreflang & OAuth return preservation", () => {
  // Public route explicit URL wins over cookie/Accept-Language without causing redirect loop.
  const pubZh = resolveAccountLocalePreferences({
    surface: "public",
    explicitRouteLocale: "zh-CN",
    manualPreference: "en-US",
    acceptLanguageHeader: "en-US,en;q=0.9",
  });
  assert.equal(pubZh.uiLocale, "zh-CN");

  // Switching UI locale never mutates notificationLocale or reportLocale.
  const customerPrefs = resolveAccountLocalePreferences({
    surface: "customer",
    manualPreference: "zh-CN",
    accountNotificationLocale: "en-US",
    accountReportLocale: "en-US",
  });
  assert.equal(customerPrefs.uiLocale, "zh-CN");
  assert.equal(customerPrefs.notificationLocale, "en-US");
  assert.equal(customerPrefs.reportLocale, "en-US");

  // Staff portal defaults to zh-CN and refuses to auto-switch to en-US just from Accept-Language (§53.2).
  const staffDefault = resolveAccountLocalePreferences({
    surface: "staff",
    acceptLanguageHeader: "en-US,en;q=0.9",
  });
  assert.equal(staffDefault.uiLocale, "zh-CN");

  // Routing / SSR metadata & hreflang integrity.
  assert.deepEqual(resolveLocalizedPublicPath("/zh/catalog"), { locale: "zh-CN", canonicalBasePath: "/catalog" });
  assert.equal(localizePublicPath("/pricing", "zh-CN"), "/zh/pricing");
  assert.equal(localizePublicPath("/zh/pricing", "en-US"), "/pricing");
  const seo = buildSsrLocaleMetadata("https://qcwarehouse.example", "/catalog", "zh-CN");
  assert.equal(seo.htmlLang, "zh-CN");
  assert.equal(seo.canonical, "https://qcwarehouse.example/zh/catalog");
  assert.equal(seo.hreflangAlternates["x-default"], "https://qcwarehouse.example/catalog");

  // OAuth callback return path preserves locale while keeping open-redirect protection intact.
  assert.equal(
    buildLocaleSafeOAuthReturnPath("/orders/new?step=2", "customer", [], "zh-CN"),
    "/orders/new?step=2&locale=zh-CN",
  );
  assert.equal(
    buildLocaleSafeOAuthReturnPath("/orders/new?locale=fr-FR", "customer", [], "zh-CN"),
    "/orders/new?locale=zh-CN",
  );
  assert.equal(
    buildLocaleSafeOAuthReturnPath("/orders/new?locale=zh", "customer", [], "en-US"),
    "/orders/new?locale=zh-CN",
  );
  assert.equal(buildLocaleSafeOAuthReturnPath("https://evil.example/orders", "customer", [], "zh-CN"), null);
  assert.equal(
    buildLocaleSafeOAuthReturnPath("/admin/users", "staff", ["template_admin"], "zh-CN"),
    null,
  );
  assert.equal(
    buildLocaleSafeOAuthReturnPath("/wh/intake", "staff", ["receiver"], "en-US"),
    "/wh/intake?locale=en-US",
  );
});
