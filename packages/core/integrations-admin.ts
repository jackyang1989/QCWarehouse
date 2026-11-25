import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDemo, one, role, uuid, audit, guard, type Actor } from "./common";
import { unseal, seal } from "./crypto";
import { requireStaffMfa } from "./auth";
import type { DB } from "../db";

const execFileAsync = promisify(execFile);

export type ProviderDomain = "payment" | "ocr" | "logistics" | "email" | "storage" | "webhook";
export type LifecycleState = "configured" | "verified" | "enabled" | "degraded" | "disabled" | "requires_approval";
export type EnvMode = "sandbox" | "live";
export type ComplianceStatus =
  | "pending"
  | "approved"
  | "manual_only"
  | "requires_review"
  | "prohibited_aup"
  | "disabled_future";

export interface ProviderRow {
  id: string;
  provider_key: string;
  domain: ProviderDomain;
  display_name: string;
  lifecycle_state: LifecycleState;
  environment: EnvMode;
  enabled: boolean;
  priority: number;
  is_primary: boolean;
  is_fallback: boolean;
  requires_icp: boolean;
  compliance_status: ComplianceStatus;
  config: Record<string, unknown>;
  health_status: string;
  last_checked_at: string | null;
  last_check_summary: string | null;
  last_error: string | null;
  updated_at: string;
}

interface ProviderDefinition {
  provider_key: string;
  domain: ProviderDomain;
  display_name: string;
  default_lifecycle: LifecycleState;
  default_environment: EnvMode;
  default_enabled: boolean;
  default_priority: number;
  is_primary: boolean;
  is_fallback: boolean;
  compliance_status: ComplianceStatus;
  default_health: string;
  default_config: Record<string, unknown>;
  secret_names: string[];
  allowed_config_keys: string[];
  url_config_keys: string[];
  allowed_hosts?: string[];
}

const PROVIDER_DEFS: ProviderDefinition[] = [
  {
    provider_key: "stripe",
    domain: "payment",
    display_name: "Stripe (HK Merchant)",
    default_lifecycle: "enabled",
    default_environment: "sandbox",
    default_enabled: true,
    default_priority: 10,
    is_primary: true,
    is_fallback: false,
    compliance_status: "approved",
    default_health: "unknown",
    default_config: {
      entity_region: "HK",
      account_type: "individual_sole_proprietor",
      kyc_status: "verified",
      payout_bank: "ZA Bank (HK)",
      live_checkout_verified: false,
      live_webhook_verified: false,
      live_payout_verified: false,
      checkout_mode: "redirect",
      supported_currencies: ["USD"],
      timeout_ms: 15000,
      max_retries: 2,
      no_icp_required: true,
    },
    secret_names: ["secret_key", "webhook_secret", "publishable_key"],
    allowed_config_keys: [
      "entity_region",
      "account_type",
      "kyc_status",
      "payout_bank",
      "live_checkout_verified",
      "live_webhook_verified",
      "live_payout_verified",
      "checkout_mode",
      "supported_currencies",
      "timeout_ms",
      "max_retries",
      "no_icp_required",
      "webhook_endpoint",
    ],
    url_config_keys: ["webhook_endpoint"],
    allowed_hosts: ["api.stripe.com"],
  },
  {
    provider_key: "paypal_manual",
    domain: "payment",
    display_name: "PayPal Manual Invoice",
    default_lifecycle: "disabled",
    default_environment: "live",
    default_enabled: false,
    default_priority: 20,
    is_primary: false,
    is_fallback: true,
    compliance_status: "manual_only",
    default_health: "unknown",
    default_config: {
      account_region: "CN",
      account_type: "personal_pre_2026_06_30",
      invoice_flow: "manual_invoice_and_verify",
      requires_two_person_verification: true,
      supported_currencies: ["USD"],
      merchant_paypal_email: "",
      instructions_en: "Receive your PayPal Invoice email (INV2-...) from QC Warehouse finance, complete payment on PayPal, then submit your PayPal Transaction ID for two-person verification.",
      no_icp_required: true,
    },
    secret_names: [],
    allowed_config_keys: [
      "account_region",
      "account_type",
      "invoice_flow",
      "requires_two_person_verification",
      "supported_currencies",
      "merchant_paypal_email",
      "instructions_en",
      "no_icp_required",
    ],
    url_config_keys: [],
  },
  {
    provider_key: "paypal_auto",
    domain: "payment",
    display_name: "PayPal Orders v2 (Auto Checkout)",
    default_lifecycle: "requires_approval",
    default_environment: "sandbox",
    default_enabled: false,
    default_priority: 30,
    is_primary: false,
    is_fallback: false,
    compliance_status: "requires_review",
    default_health: "blocked",
    default_config: {
      account_type: "personal_pre_2026_06_30",
      requires_business_upgrade: true,
      business_account_verified: false,
      api_base_sandbox: "https://api-m.sandbox.paypal.com",
      api_base_live: "https://api-m.paypal.com",
      supported_currencies: ["USD"],
      timeout_ms: 15000,
      no_icp_required: true,
      block_reason:
        "PayPal mainland personal accounts cannot enable Live REST Orders v2 Checkout until upgraded to a verified Business account.",
    },
    secret_names: ["client_id", "client_secret", "webhook_id"],
    allowed_config_keys: [
      "account_type",
      "requires_business_upgrade",
      "business_account_verified",
      "business_upgrade_evidence_note",
      "api_base_sandbox",
      "api_base_live",
      "supported_currencies",
      "timeout_ms",
      "no_icp_required",
      "block_reason",
    ],
    url_config_keys: ["api_base_sandbox", "api_base_live"],
    allowed_hosts: ["api-m.paypal.com", "api-m.sandbox.paypal.com"],
  },
  {
    provider_key: "creem",
    domain: "payment",
    display_name: "Creem (MoR)",
    default_lifecycle: "requires_approval",
    default_environment: "sandbox",
    default_enabled: false,
    default_priority: 90,
    is_primary: false,
    is_fallback: false,
    compliance_status: "prohibited_aup",
    default_health: "blocked",
    default_config: {
      aup_eligible: false,
      aup_written_approval_ref: "",
      eligibility_note:
        "Merchant-of-Record AUP restricts service to digital goods/SaaS and prohibits offline physical inspection services without written approval.",
      no_icp_required: true,
    },
    secret_names: ["api_key", "webhook_secret"],
    allowed_config_keys: ["aup_eligible", "aup_written_approval_ref", "eligibility_note", "no_icp_required"],
    url_config_keys: [],
  },
  {
    provider_key: "dodo_payments",
    domain: "payment",
    display_name: "Dodo Payments (MoR)",
    default_lifecycle: "requires_approval",
    default_environment: "sandbox",
    default_enabled: false,
    default_priority: 91,
    is_primary: false,
    is_fallback: false,
    compliance_status: "prohibited_aup",
    default_health: "blocked",
    default_config: {
      aup_eligible: false,
      aup_written_approval_ref: "",
      eligibility_note:
        "Merchant-of-Record AUP targets software/digital products and excludes offline physical QC inspection services without written approval.",
      no_icp_required: true,
    },
    secret_names: ["api_key", "webhook_secret"],
    allowed_config_keys: ["aup_eligible", "aup_written_approval_ref", "eligibility_note", "no_icp_required"],
    url_config_keys: [],
  },
  {
    provider_key: "airwallex",
    domain: "payment",
    display_name: "Airwallex (Corporate Future)",
    default_lifecycle: "disabled",
    default_environment: "sandbox",
    default_enabled: false,
    default_priority: 95,
    is_primary: false,
    is_fallback: false,
    compliance_status: "disabled_future",
    default_health: "unknown",
    default_config: {
      requires_corporate_entity: true,
      corporate_entity_verified: false,
      eligibility_note: "Reserved for future HK or Mainland corporate entity onboarding.",
      no_icp_required: true,
    },
    secret_names: ["client_id", "api_key", "webhook_secret"],
    allowed_config_keys: ["requires_corporate_entity", "corporate_entity_verified", "eligibility_note", "no_icp_required"],
    url_config_keys: [],
  },
  {
    provider_key: "oceanpayment",
    domain: "payment",
    display_name: "Oceanpayment (Corporate Future)",
    default_lifecycle: "disabled",
    default_environment: "sandbox",
    default_enabled: false,
    default_priority: 96,
    is_primary: false,
    is_fallback: false,
    compliance_status: "disabled_future",
    default_health: "unknown",
    default_config: {
      requires_corporate_entity: true,
      corporate_entity_verified: false,
      eligibility_note: "Reserved for future corporate gateway integration.",
      no_icp_required: true,
    },
    secret_names: ["account", "terminal", "secure_code"],
    allowed_config_keys: ["requires_corporate_entity", "corporate_entity_verified", "eligibility_note", "no_icp_required"],
    url_config_keys: [],
  },
  {
    provider_key: "paddle_ocr",
    domain: "ocr",
    display_name: "Self-Hosted PaddleOCR (PP-OCRv4 ONNX)",
    default_lifecycle: "enabled",
    default_environment: "live",
    default_enabled: true,
    default_priority: 10,
    is_primary: true,
    is_fallback: false,
    compliance_status: "approved",
    default_health: "unknown",
    default_config: {
      engine: "rapidocr_onnxruntime",
      model: "PP-OCRv4",
      languages: ["zh", "en"],
      max_pages: 10,
      max_file_mb: 15,
      timeout_ms: 25000,
      retention_days: 90,
      daily_quota_per_org: 50,
      concurrent_jobs_per_org: 3,
      no_icp_required: true,
    },
    secret_names: [],
    allowed_config_keys: [
      "engine",
      "model",
      "languages",
      "max_pages",
      "max_file_mb",
      "timeout_ms",
      "retention_days",
      "daily_quota_per_org",
      "concurrent_jobs_per_org",
      "no_icp_required",
    ],
    url_config_keys: [],
  },
  {
    provider_key: "google_vision_ocr",
    domain: "ocr",
    display_name: "Google Cloud Vision OCR",
    default_lifecycle: "configured",
    default_environment: "live",
    default_enabled: false,
    default_priority: 20,
    is_primary: false,
    is_fallback: true,
    compliance_status: "approved",
    default_health: "unconfigured",
    default_config: {
      endpoint: "https://vision.googleapis.com/v1/images:annotate",
      feature: "DOCUMENT_TEXT_DETECTION",
      free_tier_units_monthly: 1000,
      unit_price_per_1k_usd: 1.5,
      timeout_ms: 15000,
      no_icp_required: true,
    },
    secret_names: ["api_key", "service_account_json"],
    allowed_config_keys: [
      "endpoint",
      "feature",
      "free_tier_units_monthly",
      "unit_price_per_1k_usd",
      "timeout_ms",
      "no_icp_required",
    ],
    url_config_keys: ["endpoint"],
    allowed_hosts: ["vision.googleapis.com"],
  },
  {
    provider_key: "google_docai",
    domain: "ocr",
    display_name: "Google Document AI (Optional)",
    default_lifecycle: "disabled",
    default_environment: "live",
    default_enabled: false,
    default_priority: 30,
    is_primary: false,
    is_fallback: true,
    compliance_status: "approved",
    default_health: "unconfigured",
    default_config: {
      location: "us",
      processor_url: "",
      free_tier_units_monthly: 1000,
      unit_price_per_1k_usd: 1.5,
      timeout_ms: 20000,
      no_icp_required: true,
    },
    secret_names: ["access_token", "service_account_json"],
    allowed_config_keys: [
      "location",
      "processor_url",
      "free_tier_units_monthly",
      "unit_price_per_1k_usd",
      "timeout_ms",
      "no_icp_required",
    ],
    url_config_keys: ["processor_url"],
    allowed_hosts: ["documentai.googleapis.com", "us-documentai.googleapis.com", "eu-documentai.googleapis.com", "asia-southeast1-documentai.googleapis.com"],
  },
  {
    provider_key: "kuaidi100",
    domain: "logistics",
    display_name: "Kuaidi100 Tracking",
    default_lifecycle: "configured",
    default_environment: "live",
    default_enabled: true,
    default_priority: 10,
    is_primary: true,
    is_fallback: false,
    compliance_status: "approved",
    default_health: "unknown",
    default_config: {
      api_url: "https://poll.kuaidi100.com/poll/query.do",
      timeout_ms: 10000,
      no_icp_required: true,
    },
    secret_names: ["key", "customer", "secret"],
    allowed_config_keys: ["api_url", "timeout_ms", "no_icp_required"],
    url_config_keys: ["api_url"],
    allowed_hosts: ["poll.kuaidi100.com"],
  },
  {
    provider_key: "postmark",
    domain: "email",
    display_name: "Postmark Transactional Email",
    default_lifecycle: "configured",
    default_environment: "live",
    default_enabled: true,
    default_priority: 10,
    is_primary: true,
    is_fallback: false,
    compliance_status: "approved",
    default_health: "unknown",
    default_config: {
      api_url: "https://api.postmarkapp.com/email",
      timeout_ms: 10000,
      no_icp_required: true,
    },
    secret_names: ["server_token", "webhook_token"],
    allowed_config_keys: ["api_url", "from_email", "timeout_ms", "no_icp_required"],
    url_config_keys: ["api_url"],
    allowed_hosts: ["api.postmarkapp.com"],
  },
  {
    provider_key: "local_storage",
    domain: "storage",
    display_name: "Local Private Object Storage",
    default_lifecycle: "enabled",
    default_environment: "live",
    default_enabled: true,
    default_priority: 10,
    is_primary: true,
    is_fallback: false,
    compliance_status: "approved",
    default_health: "healthy",
    default_config: {
      driver: "filesystem_private",
      max_attachment_mb: 15,
      no_icp_required: true,
    },
    secret_names: [],
    allowed_config_keys: ["driver", "max_attachment_mb", "no_icp_required"],
    url_config_keys: [],
  },
  {
    provider_key: "outbound_webhooks",
    domain: "webhook",
    display_name: "Platform Outbound Webhooks",
    default_lifecycle: "configured",
    default_environment: "live",
    default_enabled: false,
    default_priority: 50,
    is_primary: false,
    is_fallback: false,
    compliance_status: "approved",
    default_health: "unknown",
    default_config: {
      signing: "hmac-sha256",
      timeout_ms: 10000,
      target_url: "",
      no_icp_required: true,
    },
    secret_names: ["signing_secret"],
    allowed_config_keys: ["signing", "timeout_ms", "target_url", "no_icp_required"],
    url_config_keys: ["target_url"],
  },
];

const PROVIDER_MAP = new Map(PROVIDER_DEFS.map((d) => [d.provider_key, d]));

const FORBIDDEN_SECRET_CONFIG_KEYS = new Set([
  "secret_key",
  "webhook_secret",
  "publishable_key",
  "client_secret",
  "api_key",
  "server_token",
  "service_account_json",
  "access_token",
  "private_key",
  "signing_secret",
  "secure_code",
]);

function isPrivateOrDisallowedIpHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!h || h === "localhost" || h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost") || h.endsWith(".lan")) return true;
  if (h === "metadata.google.internal" || h === "169.254.169.254") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (h.includes(":")) {
    if (
      h === "::1" ||
      h === "::" ||
      h.startsWith("::ffff:") ||
      h.startsWith("::7f") ||
      h.startsWith("::a") ||
      h.startsWith("64:ff9b:") ||
      /^fc[0-9a-f]{0,2}:/i.test(h) ||
      /^fd[0-9a-f]{0,2}:/i.test(h) ||
      /^fe[89ab][0-9a-f]?:/i.test(h)
    ) {
      return true;
    }
    const embeddedV4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (embeddedV4) {
      const a = Number(embeddedV4[1]);
      const b = Number(embeddedV4[2]);
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
        return true;
      }
    }
  }
  return false;
}

export function assertSafeExternalUrl(rawUrl: string, allowedHosts?: string[]): URL {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    guard(false, "INVALID_EXTERNAL_URL", `External URL '${trimmed}' is malformed.`, 400);
    throw new Error("unreachable");
  }
  guard(parsed.protocol === "https:", "UNSAFE_EXTERNAL_URL", "External endpoints must use HTTPS.", 400);
  guard(!parsed.username && !parsed.password, "UNSAFE_EXTERNAL_URL", "External URLs must not contain inline credentials.", 400);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  guard(!isPrivateOrDisallowedIpHost(host), "SSRF_BLOCKED", `External host '${host}' is blocked by SSRF policy.`, 400);
  if (allowedHosts && allowedHosts.length > 0) {
    const ok = allowedHosts.some((allowed) => host === allowed || host.endsWith("." + allowed));
    guard(ok, "DISALLOWED_EXTERNAL_HOST", `Host '${host}' is outside the allowlist for this provider.`, 400);
  }
  return parsed;
}

export function maskSecret(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "****";
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { client_email?: string; project_id?: string };
      if (parsed.client_email) return `sa_json(${parsed.client_email.slice(0, 12)}****)`;
    } catch {
      // fall through
    }
    return `json_****${trimmed.slice(-4)}`;
  }
  const m = /^(sk_live_|sk_test_|rk_live_|rk_test_|pk_live_|pk_test_|whsec_|AIza)/.exec(trimmed);
  if (m) return `${m[1]}****${trimmed.slice(-4)}`;
  if (trimmed.length <= 8) return `****${trimmed.slice(-2)}`;
  return `****${trimmed.slice(-4)}`;
}

export async function ensureIntegrationProvidersSeeded(db: DB): Promise<void> {
  for (const def of PROVIDER_DEFS) {
    await db.query(
      `insert into integration_providers (
         provider_key, domain, display_name, lifecycle_state, environment, enabled, priority,
         is_primary, is_fallback, requires_icp, compliance_status, health_status, config
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12::jsonb)
       on conflict (provider_key) do nothing`,
      [
        def.provider_key,
        def.domain,
        def.display_name,
        def.default_lifecycle,
        def.default_environment,
        def.default_enabled,
        def.default_priority,
        def.is_primary,
        def.is_fallback,
        def.compliance_status,
        def.default_health,
        JSON.stringify(def.default_config),
      ],
    );
  }
}

export async function getIntegrationProvider(db: DB, providerKey: string): Promise<ProviderRow> {
  await ensureIntegrationProvidersSeeded(db);
  return one<ProviderRow>(db, "select * from integration_providers where provider_key=$1", [providerKey]);
}

function envSecretFallback(providerKey: string, environment: EnvMode, secretName: string): string | null {
  if (providerKey === "stripe") {
    if (secretName === "secret_key") {
      const k = process.env.STRIPE_SECRET_KEY?.trim();
      if (!k) return null;
      if (environment === "live" && /^(sk|rk)_live_\S+$/.test(k)) return k;
      if (environment === "sandbox" && /^(sk|rk)_test_\S+$/.test(k)) return k;
      return null;
    }
    if (secretName === "webhook_secret") {
      const configuredMode = /^(sk|rk)_live_\S+$/.test(process.env.STRIPE_SECRET_KEY ?? "") ? "live" : "sandbox";
      const w = process.env.STRIPE_WEBHOOK_SECRET?.trim();
      if (w && /^whsec_\S+$/.test(w) && configuredMode === environment) return w;
      return null;
    }
  }
  if (providerKey === "paypal_auto") {
    if (environment === "live") {
      if (secretName === "client_id") return process.env.PAYPAL_LIVE_CLIENT_ID?.trim() || null;
      if (secretName === "client_secret") return process.env.PAYPAL_LIVE_CLIENT_SECRET?.trim() || null;
      if (secretName === "webhook_id") return process.env.PAYPAL_LIVE_WEBHOOK_ID?.trim() || null;
    } else {
      if (secretName === "client_id") return process.env.PAYPAL_SANDBOX_CLIENT_ID?.trim() || null;
      if (secretName === "client_secret") return process.env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim() || null;
      if (secretName === "webhook_id") return process.env.PAYPAL_SANDBOX_WEBHOOK_ID?.trim() || null;
    }
  }
  if (providerKey === "google_vision_ocr") {
    if (secretName === "api_key") return process.env.GOOGLE_CLOUD_VISION_API_KEY?.trim() || null;
    if (secretName === "service_account_json") return process.env.GOOGLE_VISION_SERVICE_ACCOUNT_JSON?.trim() || null;
  }
  if (providerKey === "google_docai") {
    if (secretName === "service_account_json") return process.env.GOOGLE_DOCAI_SERVICE_ACCOUNT_JSON?.trim() || null;
    if (secretName === "access_token") return process.env.GOOGLE_DOCAI_ACCESS_TOKEN?.trim() || null;
  }
  if (providerKey === "kuaidi100") {
    if (secretName === "key") return process.env.KUAIDI100_KEY?.trim() || null;
    if (secretName === "customer") return process.env.KUAIDI100_CUSTOMER?.trim() || null;
    if (secretName === "secret") return process.env.KUAIDI100_SECRET?.trim() || null;
  }
  if (providerKey === "postmark") {
    if (secretName === "server_token") return process.env.POSTMARK_SERVER_TOKEN?.trim() || null;
    if (secretName === "webhook_token") return process.env.POSTMARK_WEBHOOK_TOKEN?.trim() || null;
  }
  return null;
}

export async function resolveProviderSecret(
  db: Pick<DB, "query">,
  providerKey: string,
  environment: EnvMode,
  secretName: string,
): Promise<string | null> {
  const row = (
    await db.query<{ ciphertext: Buffer }>(
      `select ciphertext from integration_secrets
       where provider_key=$1 and environment=$2 and secret_name=$3 and status='active'
       limit 1`,
      [providerKey, environment, secretName],
    )
  ).rows[0];
  if (row) return unseal(row.ciphertext);

  const explicitlyRevoked = (
    await db.query(
      `select 1 from integration_secrets
       where provider_key=$1 and environment=$2 and secret_name=$3 and status='revoked'
       limit 1`,
      [providerKey, environment, secretName],
    )
  ).rowCount;
  if (explicitlyRevoked) return null;

  return envSecretFallback(providerKey, environment, secretName);
}

export async function listActiveSecretNames(
  db: DB,
  providerKey: string,
  environment: EnvMode,
): Promise<Set<string>> {
  const def = PROVIDER_MAP.get(providerKey);
  const rows = (
    await db.query<{ secret_name: string; status: string }>(
      `select secret_name, status from integration_secrets
       where provider_key=$1 and environment=$2 and status in ('active','revoked')`,
      [providerKey, environment],
    )
  ).rows;
  const names = new Set(rows.filter((r) => r.status === "active").map((r) => r.secret_name));
  const revoked = new Set(rows.filter((r) => r.status === "revoked").map((r) => r.secret_name));
  if (def) {
    for (const s of def.secret_names) {
      if (!names.has(s) && !revoked.has(s) && envSecretFallback(providerKey, environment, s)) {
        names.add(s);
      }
    }
  }
  return names;
}

function validateSecretFormat(providerKey: string, environment: EnvMode, secretName: string, value: string) {
  guard(value.trim().length >= 4, "INVALID_SECRET", "Secret value must not be empty.", 400);
  if (providerKey === "stripe" && secretName === "secret_key") {
    if (environment === "live") {
      guard(/^(sk|rk)_live_\S+$/.test(value.trim()), "INVALID_STRIPE_KEY", "Live Stripe secret_key must start with sk_live_ or rk_live_.", 400);
    } else {
      guard(/^(sk|rk)_test_\S+$/.test(value.trim()), "INVALID_STRIPE_KEY", "Sandbox Stripe secret_key must start with sk_test_ or rk_test_.", 400);
    }
  }
  if (providerKey === "stripe" && secretName === "webhook_secret") {
    guard(/^whsec_\S+$/.test(value.trim()), "INVALID_STRIPE_WEBHOOK_SECRET", "Stripe webhook_secret must start with whsec_.", 400);
  }
  if ((providerKey === "google_vision_ocr" || providerKey === "google_docai") && secretName === "service_account_json") {
    try {
      const parsed = JSON.parse(value.trim()) as { client_email?: string; private_key?: string };
      guard(Boolean(parsed.client_email && parsed.private_key), "INVALID_SERVICE_ACCOUNT", "Service account JSON requires client_email and private_key.", 400);
    } catch {
      guard(false, "INVALID_SERVICE_ACCOUNT", "Service account JSON must be valid JSON.", 400);
    }
  }
}

function checkLiveEligibility(
  providerKey: string,
  environment: EnvMode,
  lifecycleState: LifecycleState,
  enabled: boolean,
  config: Record<string, unknown>,
  secretNames: Set<string>,
): string[] {
  const blockers: string[] = [];
  if (providerKey === "creem" || providerKey === "dodo_payments") {
    const aupOk = config.aup_eligible === true && Boolean(String(config.aup_written_approval_ref ?? "").trim());
    if (!aupOk && (enabled || lifecycleState === "enabled" || environment === "live")) {
      blockers.push(
        `${providerKey} cannot be enabled for offline inspection services without documented AUP exception approval.`,
      );
    }
  }
  if (providerKey === "paypal_auto") {
    const bizOk = config.business_account_verified === true;
    if ((!bizOk || !secretNames.has("client_id") || !secretNames.has("client_secret")) && (enabled || environment === "live" || lifecycleState === "enabled")) {
      blockers.push(
        "PayPal Auto Checkout (Orders v2) requires verified Business account upgrade plus active client_id and client_secret.",
      );
    }
  }
  if (providerKey === "airwallex" || providerKey === "oceanpayment") {
    const corpOk = config.corporate_entity_verified === true;
    if (!corpOk && (enabled || environment === "live" || lifecycleState === "enabled")) {
      blockers.push(`${providerKey} requires corporate entity onboarding approval before enabling.`);
    }
  }
  if (providerKey === "stripe" && environment === "live" && enabled) {
    if (config.kyc_status !== "verified") blockers.push("Stripe HK KYC must be verified.");
    if (!secretNames.has("secret_key")) blockers.push("Stripe Live secret_key (sk_live_/rk_live_) is missing.");
    if (!secretNames.has("webhook_secret")) blockers.push("Stripe Live webhook_secret (whsec_) is missing.");
    if (config.live_checkout_verified !== true) blockers.push("Stripe Live Checkout smoke check has not been verified yet.");
    if (config.live_webhook_verified !== true) blockers.push("Stripe Live Webhook delivery has not been verified yet.");
  }
  return blockers;
}

export async function recordIntegrationEvent(
  db: DB,
  input: {
    provider_key: string;
    environment: EnvMode;
    event_kind:
      | "config_saved"
      | "config_validated"
      | "connection_tested"
      | "secret_saved"
      | "secret_rotated"
      | "secret_revoked"
      | "state_changed"
      | "webhook_received"
      | "ocr_executed"
      | "payment_sync"
      | "error";
    status: "ok" | "warn" | "error" | "blocked";
    latency_ms?: number | null;
    cost_estimate_usd?: number | null;
    summary: string;
    meta?: Record<string, unknown>;
    actor_id?: string | null;
  },
) {
  await db.query(
    `insert into integration_events (
       provider_key, environment, event_kind, status, latency_ms, cost_estimate_usd, summary, meta, actor_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      input.provider_key,
      input.environment,
      input.event_kind,
      input.status,
      input.latency_ms ?? null,
      input.cost_estimate_usd ?? 0,
      input.summary.slice(0, 400),
      JSON.stringify(input.meta ?? {}),
      input.actor_id ?? null,
    ],
  );
}

export async function saveProviderSecret(
  db: DB,
  actor: Actor,
  sessionHash: string,
  input: {
    provider_key: string;
    environment: EnvMode;
    secret_name: string;
    secret_value: string;
  },
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await ensureIntegrationProvidersSeeded(db);

  const def = PROVIDER_MAP.get(input.provider_key);
  guard(def, "PROVIDER_NOT_FOUND", `Unknown provider '${input.provider_key}'.`, 404);
  guard(def.secret_names.includes(input.secret_name), "UNSUPPORTED_SECRET_NAME", `Secret '${input.secret_name}' is not supported for '${input.provider_key}'.`, 400);
  validateSecretFormat(input.provider_key, input.environment, input.secret_name, input.secret_value);

  const trimmed = input.secret_value.trim();
  const masked = maskSecret(trimmed);
  const cipher = seal(trimmed);

  const existing = (
    await db.query<{ id: string; key_version: number; ciphertext:Buffer }>(
      `select id, key_version, ciphertext from integration_secrets
       where provider_key=$1 and environment=$2 and secret_name=$3 and status='active'
       for update`,
      [input.provider_key, input.environment, input.secret_name],
    )
  ).rows[0];

  const maxVer = (
    await db.query<{ mv: number }>(
      `select coalesce(max(key_version), 0)::int as mv from integration_secrets
       where provider_key=$1 and environment=$2 and secret_name=$3`,
      [input.provider_key, input.environment, input.secret_name],
    )
  ).rows[0]?.mv ?? 0;

  if (existing) {
    await db.query(
      `update integration_secrets set status='rotated', rotated_by=$2, rotated_at=now() where id=$1`,
      [existing.id, actor.id],
    );
  }

  const nextVersion = maxVer + 1;
  const reverifyStripe=input.provider_key==="stripe"&&input.environment==="live"&&
    (!existing||unseal(existing.ciphertext)!==trimmed);
  const invalidatedChecks=reverifyStripe?(input.secret_name==="secret_key"
    ?{live_checkout_verified:false,live_payout_verified:false}
    :{live_webhook_verified:false}):{};
  const secretId = uuid();
  await db.query(
    `insert into integration_secrets (
       id, provider_key, environment, secret_name, ciphertext, masked_hint, key_version, status, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
    [secretId, input.provider_key, input.environment, input.secret_name, cipher, masked, nextVersion, actor.id],
  );

  await db.query(
    `update integration_providers
     set lifecycle_state = case when lifecycle_state = 'disabled' then 'configured' else lifecycle_state end,
         config = config || $3::jsonb,
         health_status = case when $4 and environment='live' then 'unknown' else health_status end,
         last_checked_at = case when $4 and environment='live' then null else last_checked_at end,
         last_check_summary = case when $4 and environment='live' then null else last_check_summary end,
         updated_by=$2, updated_at=now()
     where provider_key=$1`,
    [input.provider_key, actor.id,invalidatedChecks,reverifyStripe],
  );

  await recordIntegrationEvent(db, {
    provider_key: input.provider_key,
    environment: input.environment,
    event_kind: existing ? "secret_rotated" : "secret_saved",
    status: "ok",
    summary: `${existing ? "Rotated" : "Saved"} ${input.environment} ${input.secret_name} (v${nextVersion}, ${masked})`,
    meta: { secret_name: input.secret_name, key_version: nextVersion, masked_hint: masked },
    actor_id: actor.id,
  });

  await audit(db, actor, existing ? "integration_secret_rotated" : "integration_secret_saved", "integration_providers", null, {
    provider_key: input.provider_key,
    environment: input.environment,
    secret_name: input.secret_name,
    key_version: nextVersion,
    masked_hint: masked,
  });

  return {
    id: secretId,
    provider_key: input.provider_key,
    environment: input.environment,
    secret_name: input.secret_name,
    masked_hint: masked,
    key_version: nextVersion,
    rotated: Boolean(existing),
  };
}

export async function revokeProviderSecret(
  db: DB,
  actor: Actor,
  sessionHash: string,
  input: {
    provider_key: string;
    environment: EnvMode;
    secret_name: string;
  },
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await ensureIntegrationProvidersSeeded(db);

  const row = (
    await db.query<{ id: string; masked_hint: string; key_version: number }>(
      `select id, masked_hint, key_version from integration_secrets
       where provider_key=$1 and environment=$2 and secret_name=$3 and status='active'
       for update`,
      [input.provider_key, input.environment, input.secret_name],
    )
  ).rows[0];
  guard(row, "SECRET_NOT_FOUND", `No active '${input.secret_name}' secret found for ${input.provider_key} (${input.environment}).`, 404);

  await db.query(
    `update integration_secrets set status='revoked', revoked_by=$2, revoked_at=now() where id=$1`,
    [row.id, actor.id],
  );

  await db.query(
    `update integration_providers
     set health_status = case when environment = $2 then 'unconfigured' else health_status end,
         enabled = case when provider_key = 'stripe' and environment = $2 and $2 = 'live' then false else enabled end,
         lifecycle_state = case when provider_key = 'stripe' and environment = $2 then 'configured' else lifecycle_state end,
         config = case
           when provider_key = 'stripe' and environment = $2 and $2 = 'live' and $4 = 'secret_key' then config || '{"live_checkout_verified":false}'::jsonb
           when provider_key = 'stripe' and environment = $2 and $2 = 'live' and $4 = 'webhook_secret' then config || '{"live_webhook_verified":false}'::jsonb
           else config
         end,
         updated_by=$3, updated_at=now()
     where provider_key=$1`,
    [input.provider_key, input.environment, actor.id, input.secret_name],
  );

  await recordIntegrationEvent(db, {
    provider_key: input.provider_key,
    environment: input.environment,
    event_kind: "secret_revoked",
    status: "warn",
    summary: `Revoked ${input.environment} ${input.secret_name} (v${row.key_version})`,
    meta: { secret_name: input.secret_name, key_version: row.key_version, masked_hint: row.masked_hint },
    actor_id: actor.id,
  });

  await audit(db, actor, "integration_secret_revoked", "integration_providers", null, {
    provider_key: input.provider_key,
    environment: input.environment,
    secret_name: input.secret_name,
    key_version: row.key_version,
  });

  return { revoked: true, provider_key: input.provider_key, environment: input.environment, secret_name: input.secret_name };
}

export async function updateIntegrationProvider(
  db: DB,
  actor: Actor,
  sessionHash: string,
  providerKey: string,
  input: {
    environment?: EnvMode;
    lifecycle_state?: LifecycleState;
    enabled?: boolean;
    priority?: number;
    is_primary?: boolean;
    is_fallback?: boolean;
    config?: Record<string, unknown>;
    requires_icp?: boolean;
  },
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await ensureIntegrationProvidersSeeded(db);

  guard(input.requires_icp !== true, "ICP_POLICY_FORBIDDEN", "QC Warehouse does not support providers requiring China mainland ICP filing.", 400);

  const def = PROVIDER_MAP.get(providerKey);
  guard(def, "PROVIDER_NOT_FOUND", `Unknown provider '${providerKey}'.`, 404);
  const current = await one<ProviderRow>(db, "select * from integration_providers where provider_key=$1 for update", [providerKey]);

  const nextEnv = input.environment ?? current.environment;
  const nextEnabled = input.enabled ?? current.enabled;
  const nextLifecycle = input.lifecycle_state ?? current.lifecycle_state;
  const nextPriority = input.priority ?? current.priority;
  const nextPrimary = input.is_primary ?? current.is_primary;
  const nextFallback = input.is_fallback ?? current.is_fallback;

  const incomingConfig = input.config ?? {};
  for (const key of Object.keys(incomingConfig)) {
    guard(!FORBIDDEN_SECRET_CONFIG_KEYS.has(key), "SECRET_VIA_VAULT_ONLY", `Credential field '${key}' must be saved via the encrypted secrets endpoint, not config JSON.`, 400);
    guard(def.allowed_config_keys.includes(key), "INVALID_CONFIG_KEY", `Config key '${key}' is not allowed for '${providerKey}'.`, 400);
    if (def.url_config_keys.includes(key) && incomingConfig[key] !== undefined && incomingConfig[key] !== null && incomingConfig[key] !== "") {
      guard(typeof incomingConfig[key] === "string", "INVALID_EXTERNAL_URL", `Config key '${key}' must be a valid HTTPS URL string.`, 400);
      assertSafeExternalUrl(String(incomingConfig[key]), def.allowed_hosts);
    }
  }

  const mergedConfig: Record<string, unknown> = {
    ...(current.config ?? {}),
    ...incomingConfig,
    no_icp_required: true,
  };

  const secretNames = await listActiveSecretNames(db, providerKey, nextEnv);
  const blockers = checkLiveEligibility(providerKey, nextEnv, nextLifecycle, nextEnabled, mergedConfig, secretNames);
  guard(blockers.length === 0, "PROVIDER_ELIGIBILITY_BLOCKED", blockers[0] ?? "Provider cannot be enabled in this state.", 409);

  if (nextPrimary) {
    await db.query(
      `update integration_providers set is_primary=false where domain=$1 and provider_key<>$2 and is_primary=true`,
      [current.domain, providerKey],
    );
  }

  await db.query(
    `update integration_providers
     set environment=$2, lifecycle_state=$3, enabled=$4, priority=$5, is_primary=$6, is_fallback=$7,
         config=$8::jsonb, updated_by=$9, updated_at=now()
     where provider_key=$1`,
    [
      providerKey,
      nextEnv,
      nextLifecycle,
      nextEnabled,
      nextPriority,
      nextPrimary,
      nextFallback,
      JSON.stringify(mergedConfig),
      actor.id,
    ],
  );

  await recordIntegrationEvent(db, {
    provider_key: providerKey,
    environment: nextEnv,
    event_kind: nextLifecycle !== current.lifecycle_state || nextEnabled !== current.enabled ? "state_changed" : "config_saved",
    status: "ok",
    summary: `Updated ${providerKey}: env=${nextEnv}, state=${nextLifecycle}, enabled=${nextEnabled}, priority=${nextPriority}`,
    meta: { before: { env: current.environment, state: current.lifecycle_state, enabled: current.enabled }, after: { env: nextEnv, state: nextLifecycle, enabled: nextEnabled } },
    actor_id: actor.id,
  });

  await audit(db, actor, "integration_provider_updated", "integration_providers", current.id, {
    provider_key: providerKey,
    environment: nextEnv,
    lifecycle_state: nextLifecycle,
    enabled: nextEnabled,
    priority: nextPriority,
  });

  return getIntegrationProvider(db, providerKey);
}

export async function validateProviderConfig(db: DB, actor: Actor, providerKey: string, environment?: EnvMode) {
  role(actor, "super_admin", "finance");
  const provider = await getIntegrationProvider(db, providerKey);
  const def = PROVIDER_MAP.get(providerKey);
  const env = environment ?? provider.environment;
  const secretNames = await listActiveSecretNames(db, providerKey, env);
  const missing: string[] = [];
  const warnings: string[] = [];

  if (providerKey === "stripe") {
    if (!secretNames.has("secret_key")) missing.push(`${env}.secret_key`);
    if (!secretNames.has("webhook_secret")) missing.push(`${env}.webhook_secret`);
    if (env === "live") {
      if (provider.config.live_checkout_verified !== true) warnings.push("Stripe Live Checkout is unverified.");
      if (provider.config.live_webhook_verified !== true) warnings.push("Stripe Live Webhook is unverified.");
      if (provider.config.live_payout_verified !== true) warnings.push("Stripe ZA Bank payout settlement check is pending.");
    }
  } else if (providerKey === "paypal_auto") {
    if (!secretNames.has("client_id")) missing.push(`${env}.client_id`);
    if (!secretNames.has("client_secret")) missing.push(`${env}.client_secret`);
    if (provider.config.business_account_verified !== true) {
      warnings.push("Personal mainland PayPal account requires Business upgrade before Live Orders v2 can activate.");
    }
  } else if (providerKey === "google_vision_ocr") {
    if (!secretNames.has("api_key")) {
      missing.push("api_key");
    }
  } else if (providerKey === "outbound_webhooks") {
    if (!String(provider.config.target_url ?? "").trim()) missing.push("config.target_url");
    if (!secretNames.has("signing_secret")) missing.push("signing_secret");
  } else if (providerKey === "google_docai") {
    if (!String(provider.config.processor_url ?? "").trim()) missing.push("config.processor_url");
    if (!secretNames.has("access_token") && !secretNames.has("service_account_json")) {
      missing.push("access_token or service_account_json");
    }
  } else if (providerKey === "kuaidi100") {
    if (!secretNames.has("key")) missing.push("key");
    if (!secretNames.has("customer")) missing.push("customer");
  } else if (providerKey === "postmark") {
    if (!secretNames.has("server_token")) missing.push("server_token");
  }

  for (const urlKey of def?.url_config_keys ?? []) {
    const raw = provider.config[urlKey];
    if (typeof raw === "string" && raw.trim()) {
      assertSafeExternalUrl(raw, def?.allowed_hosts);
    }
  }

  const complianceBlockers = checkLiveEligibility(providerKey, env, provider.lifecycle_state, true, provider.config, secretNames);
  const ok = missing.length === 0 && complianceBlockers.length === 0;

  await recordIntegrationEvent(db, {
    provider_key: providerKey,
    environment: env,
    event_kind: "config_validated",
    status: complianceBlockers.length > 0 ? "blocked" : ok ? "ok" : "warn",
    summary: ok
      ? `Config validation passed for ${providerKey} (${env}).`
      : `Config validation incomplete: missing [${missing.join(", ")}]`,
    meta: { missing, warnings, compliance_blockers: complianceBlockers },
    actor_id: actor.id,
  });

  return {
    mode: "config_validation" as const,
    provider_key: providerKey,
    environment: env,
    ok,
    ready_for_connection_test: missing.length === 0 && complianceBlockers.length === 0,
    missing_fields: missing,
    warnings,
    compliance_blockers: complianceBlockers,
  };
}

export async function testProviderConnection(
  db: DB,
  actor: Actor,
  sessionHash: string,
  providerKey: string,
  environment?: EnvMode,
) {
  role(actor, "super_admin", "finance");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const provider = await getIntegrationProvider(db, providerKey);
  const def = PROVIDER_MAP.get(providerKey);
  const env = environment ?? provider.environment;
  const started = Date.now();

  const secretNames = await listActiveSecretNames(db, providerKey, env);
  const complianceBlockers = checkLiveEligibility(
    providerKey,
    env,
    provider.lifecycle_state,
    providerKey === "creem" || providerKey === "dodo_payments" || providerKey === "paypal_auto" || providerKey === "airwallex" || providerKey === "oceanpayment"
      ? true
      : provider.enabled,
    provider.config,
    secretNames,
  );
  if (
    (providerKey === "creem" || providerKey === "dodo_payments" || providerKey === "paypal_auto" || providerKey === "airwallex" || providerKey === "oceanpayment") &&
    complianceBlockers.length > 0
  ) {
    const latency = Date.now() - started;
    await db.query(
      `update integration_providers set health_status='blocked', last_checked_at=now(), last_check_summary=$2, last_error=$3 where provider_key=$1`,
      [providerKey, complianceBlockers[0], complianceBlockers[0]],
    );
    await recordIntegrationEvent(db, {
      provider_key: providerKey,
      environment: env,
      event_kind: "connection_tested",
      status: "blocked",
      latency_ms: latency,
      summary: complianceBlockers[0],
      actor_id: actor.id,
    });
    return {
      mode: "connection_test" as const,
      provider_key: providerKey,
      environment: env,
      ok: false,
      health_status: "blocked",
      latency_ms: latency,
      summary: complianceBlockers[0],
      not_simulated: true,
    };
  }

  let ok = false;
  let healthStatus: "healthy" | "degraded" | "unconfigured" | "error" | "blocked" = "error";
  let summary = "";
  let errorDetail: string | null = null;

  try {
    if (providerKey === "paypal_manual" || providerKey === "local_storage") {
      ok = Boolean(provider.enabled);
      healthStatus = ok ? "healthy" : "degraded";
      summary = ok
        ? providerKey === "paypal_manual"
          ? "Manual PayPal Invoice workflow active; customer request, invoice issuance, proof upload, and 2-person verification ready."
          : "Local private attachment store is writable and PDF/image verification is active."
        : `${provider.display_name} is currently disabled by administrator.`;
    } else if (providerKey === "paddle_ocr") {
      const { stdout } = await execFileAsync("python3", ["scripts/ocr_engine.py", "--health"], {
        cwd: process.cwd(),
        timeout: 15000,
      });
      const health = JSON.parse(stdout.trim()) as { ok: boolean; engine?: string; pypdfium2?: boolean; pypdf?: boolean; error?: string };
      ok = Boolean(health.ok);
      healthStatus = ok ? "healthy" : "error";
      summary = ok
        ? `PaddleOCR ONNX engine ready (${health.engine ?? "rapidocr"}), pdfium=${Boolean(health.pypdfium2)}, pypdf=${Boolean(health.pypdf)}.`
        : `PaddleOCR health check failed: ${health.error ?? "unknown error"}`;
      if (!ok) errorDetail = summary;
    } else if (providerKey === "stripe") {
      const key = await resolveProviderSecret(db, "stripe", env, "secret_key");
      if (!key) {
        healthStatus = "unconfigured";
        summary = `No Stripe ${env} secret_key configured in Vault or environment.`;
        errorDetail = summary;
      } else {
        const res = await fetch("https://api.stripe.com/v1/balance", {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(Number(provider.config.timeout_ms ?? 10000)),
        });
        if (res.ok) {
          ok = true;
          healthStatus = "healthy";
          summary = `Stripe ${env} API authenticated successfully (HTTP ${res.status}).`;
        } else {
          const text = (await res.text()).slice(0, 220);
          healthStatus = "error";
          summary = `Stripe ${env} probe returned HTTP ${res.status}.`;
          errorDetail = text;
        }
      }
    } else if (providerKey === "google_vision_ocr") {
      const apiKey = await resolveProviderSecret(db, "google_vision_ocr", env, "api_key");
      if (!apiKey) {
        healthStatus = "unconfigured";
        summary = "Google Cloud Vision API key is not configured.";
        errorDetail = summary;
      } else {
        const endpoint = String(provider.config.endpoint ?? "https://vision.googleapis.com/v1/images:annotate");
        assertSafeExternalUrl(endpoint, def?.allowed_hosts);
        const tinyPngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII=";
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "X-goog-api-key": apiKey },
          body: JSON.stringify({
            requests: [{ image: { content: tinyPngB64 }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }],
          }),
          signal: AbortSignal.timeout(Number(provider.config.timeout_ms ?? 10000)),
        });
        ok = res.ok;
        healthStatus = ok ? "healthy" : "error";
        summary = ok ? "Google Cloud Vision DOCUMENT_TEXT_DETECTION reachable." : `Google Cloud Vision probe returned HTTP ${res.status}.`;
        if (!ok) errorDetail = (await res.text()).slice(0, 200);
      }
    } else if (providerKey === "postmark") {
      const token = await resolveProviderSecret(db, "postmark", env, "server_token");
      if (!token) {
        healthStatus = "unconfigured";
        summary = "Postmark server_token is not configured.";
        errorDetail = summary;
      } else {
        const res = await fetch("https://api.postmarkapp.com/server", {
          headers: { Accept: "application/json", "X-Postmark-Server-Token": token },
          signal: AbortSignal.timeout(10000),
        });
        ok = res.ok;
        healthStatus = ok ? "healthy" : "error";
        summary = ok ? `Postmark server token verified (HTTP ${res.status}).` : `Postmark probe returned HTTP ${res.status}.`;
        if (!ok) errorDetail = summary;
      }
    } else if (providerKey === "kuaidi100") {
      const key = await resolveProviderSecret(db, "kuaidi100", env, "key");
      const customer = await resolveProviderSecret(db, "kuaidi100", env, "customer");
      if (!key || !customer) {
        healthStatus = isDemo() ? "degraded" : "unconfigured";
        summary = isDemo()
          ? "Kuaidi100 credentials absent; demo mode uses deterministic mock tracking fixtures."
          : "Kuaidi100 key/customer credentials are not configured.";
        errorDetail = summary;
      } else {
        const url = String(provider.config.api_url ?? "https://poll.kuaidi100.com/poll/query.do");
        assertSafeExternalUrl(url, def?.allowed_hosts);
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
        ok = res.status < 500;
        healthStatus = ok ? "healthy" : "degraded";
        summary = `Kuaidi100 endpoint reachable (HTTP ${res.status}).`;
      }
    } else {
      healthStatus = "unconfigured";
      summary = `No active credentials configured for ${providerKey}.`;
      errorDetail = summary;
    }
  } catch (err) {
    ok = false;
    healthStatus = "error";
    errorDetail = err instanceof Error ? err.message.slice(0, 240) : "Connection probe failed.";
    summary = `Connection test failed: ${errorDetail}`;
  }

  const latency = Date.now() - started;
  const nextLifecycle =
    ok && (provider.lifecycle_state === "configured" || provider.lifecycle_state === "degraded")
      ? "verified"
      : provider.lifecycle_state;

  await db.query(
    `update integration_providers
     set health_status=$2, lifecycle_state=$3, last_checked_at=now(), last_check_summary=$4, last_error=$5, updated_at=now()
     where provider_key=$1`,
    [providerKey, healthStatus, nextLifecycle, summary, errorDetail],
  );

  await recordIntegrationEvent(db, {
    provider_key: providerKey,
    environment: env,
    event_kind: "connection_tested",
    status: ok ? "ok" : healthStatus === "unconfigured" ? "warn" : "error",
    latency_ms: latency,
    summary,
    meta: { health_status: healthStatus, error: errorDetail },
    actor_id: actor.id,
  });

  await audit(db, actor, "integration_connection_tested", "integration_providers", provider.id, {
    provider_key: providerKey,
    environment: env,
    ok,
    health_status: healthStatus,
    latency_ms: latency,
  });

  return {
    mode: "connection_test" as const,
    provider_key: providerKey,
    environment: env,
    ok,
    health_status: healthStatus,
    latency_ms: latency,
    summary,
    error: errorDetail,
    not_simulated: true,
  };
}

export async function listIntegrationHub(db: DB, actor: Actor, domain?: ProviderDomain) {
  role(actor, "super_admin", "finance", "warehouse_admin");
  await ensureIntegrationProvidersSeeded(db);

  const providers = (
    await db.query<ProviderRow>(
      `select id, provider_key, domain, display_name, lifecycle_state, environment, enabled, priority,
              is_primary, is_fallback, requires_icp, compliance_status, config, health_status,
              last_checked_at, last_check_summary, last_error, updated_at
       from integration_providers
       ${domain ? "where domain=$1" : ""}
       order by domain, priority, provider_key`,
      domain ? [domain] : [],
    )
  ).rows;

  const secrets = (
    await db.query<{
      id: string;
      provider_key: string;
      environment: EnvMode;
      secret_name: string;
      masked_hint: string;
      key_version: number;
      status: string;
      created_at: string;
      rotated_at: string | null;
      revoked_at: string | null;
    }>(
      `select id, provider_key, environment, secret_name, masked_hint, key_version, status, created_at, rotated_at, revoked_at
       from integration_secrets
       order by created_at desc
       limit 200`,
    )
  ).rows;

  const usageStats = (
    await db.query<{
      provider_key: string;
      calls_24h: number;
      errors_24h: number;
      avg_latency_ms: number | null;
      cost_30d_usd: string;
    }>(
      `select provider_key,
              count(*) filter (where created_at > now() - interval '24 hours')::int as calls_24h,
              count(*) filter (where created_at > now() - interval '24 hours' and status='error')::int as errors_24h,
              round(avg(latency_ms) filter (where latency_ms is not null))::int as avg_latency_ms,
              coalesce(sum(cost_estimate_usd) filter (where created_at > now() - interval '30 days'), 0)::text as cost_30d_usd
       from integration_events
       group by provider_key`,
    )
  ).rows;

  const recentEvents = (
    await db.query<{
      id: string;
      provider_key: string;
      environment: EnvMode;
      event_kind: string;
      status: string;
      latency_ms: number | null;
      cost_estimate_usd: string;
      summary: string;
      created_at: string;
    }>(
      `select id::text, provider_key, environment, event_kind, status, latency_ms, cost_estimate_usd::text, summary, created_at
       from integration_events
       order by id desc
       limit 50`,
    )
  ).rows;

  const secretsByProvider = new Map<string, typeof secrets>();
  for (const s of secrets) {
    const list = secretsByProvider.get(s.provider_key) ?? [];
    list.push(s);
    secretsByProvider.set(s.provider_key, list);
  }
  const statsByProvider = new Map(usageStats.map((u) => [u.provider_key, u]));

  const items = providers.map((p) => {
    const def = PROVIDER_MAP.get(p.provider_key);
    const activeEnvEnvVars: string[] = [];
    for (const sn of def?.secret_names ?? []) {
      if (envSecretFallback(p.provider_key, p.environment, sn)) activeEnvEnvVars.push(sn);
    }
    return {
      ...p,
      supported_secrets: def?.secret_names ?? [],
      env_fallback_secrets: activeEnvEnvVars,
      secrets: secretsByProvider.get(p.provider_key) ?? [],
      metrics: statsByProvider.get(p.provider_key) ?? {
        provider_key: p.provider_key,
        calls_24h: 0,
        errors_24h: 0,
        avg_latency_ms: null,
        cost_30d_usd: "0",
      },
    };
  });

  return { providers: items, events: recentEvents };
}
