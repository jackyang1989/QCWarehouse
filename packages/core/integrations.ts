import { isDemo } from "./common";
import { resendSettings } from "./resend-settings";
import type { DB } from "../db";

export type OidcProvider = "google" | "microsoft";
const oauth = {
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET", issuer: "https://accounts.google.com" },
  microsoft: { id: "MICROSOFT_CLIENT_ID", secret: "MICROSOFT_CLIENT_SECRET", issuer: "https://login.microsoftonline.com/consumers/v2.0" },
} as const;

function get(name: string) {
  return process.env[name]?.trim() || undefined;
}
function origin(value: string | undefined, allowLocal = false) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol === "https:" || (allowLocal && url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) {
      return url.origin;
    }
  } catch {
    return null;
  }
  return null;
}
export function oidcSettings(provider: OidcProvider) {
  const { id, secret, issuer } = oauth[provider];
  const clientId = get(id), clientSecret = get(secret);
  const base = origin(get("APP_URL") ?? "http://localhost:3000", process.env.NODE_ENV !== "production");
  const callback=base&&base+"/api/v1/auth/"+provider+"/callback";
  return {clientId,clientSecret,issuer,callback,configured:!!(clientId && clientSecret && callback)};
}
export function stripeSettings() {
  const key = get("STRIPE_SECRET_KEY"), webhook = get("STRIPE_WEBHOOK_SECRET");
  const mode = /^(sk|rk)_live_\S+$/.test(key ?? "") ? "live" : /^(sk|rk)_test_\S+$/.test(key ?? "") ? "test" : null;
  return {
    key, mode, webhook: /^whsec_\S+$/.test(webhook ?? "") ? webhook : undefined,
    liveEnabled: get("STRIPE_LIVE_ENABLED") === "1" && origin(get("APP_URL")) !== null && !isDemo(),
  };
}

export function stripeCheckoutMode(reference:unknown) {
  if(typeof reference!=="string")return null;
  return reference.startsWith("cs_live_")?"live":reference.startsWith("cs_test_")?"test":null;
}

export async function stripeSettlementCredentials(db: Pick<import("../db").DB,"query">, mode:"live"|"test") {
  const {resolveProviderSecret}=await import("./integrations-admin");
  const environment=mode==="live"?"live":"sandbox";
  const [key,webhook]=await Promise.all([
    resolveProviderSecret(db,"stripe",environment,"secret_key"),
    resolveProviderSecret(db,"stripe",environment,"webhook_secret"),
  ]);
  const keyPattern=mode==="live"?/^(sk|rk)_live_\S+$/:/^(sk|rk)_test_\S+$/;
  return {key:key&&keyPattern.test(key)?key:undefined,webhook:webhook&&/^whsec_\S+$/.test(webhook)?webhook:undefined};
}

export async function stripeSettingsFromDb(db: Pick<import("../db").DB, "query">) {
  const env = stripeSettings();
  const providerRow = (
    await db.query<{ environment: "sandbox" | "live"; enabled: boolean; updated_by: string | null; config: Record<string, unknown> }>(
      "select environment, enabled, updated_by, config from integration_providers where provider_key='stripe' limit 1",
    )
  ).rows[0];
  if (!providerRow) {
    return {
      ...env,
      enabled: true,
      environment: env.mode === "live" ? ("live" as const) : ("sandbox" as const),
      config: {} as Record<string, unknown>,
    };
  }

  const targetEnv = providerRow.environment;
  const vaultRowCount = (
    await db.query("select 1 from integration_secrets where provider_key='stripe' and environment=$1 limit 1", [targetEnv])
  ).rowCount;
  const dbGoverned =
    Boolean(providerRow.updated_by) ||
    providerRow.enabled === false ||
    targetEnv === "live" ||
    Boolean(vaultRowCount);

  const { resolveProviderSecret } = await import("./integrations-admin");
  const dbKey = await resolveProviderSecret(db, "stripe", targetEnv, "secret_key");
  const dbWebhook = await resolveProviderSecret(db, "stripe", targetEnv, "webhook_secret");

  const key = dbGoverned ? (dbKey ?? undefined) : (dbKey ?? env.key);
  const webhook = dbGoverned ? (dbWebhook ?? undefined) : (dbWebhook ?? env.webhook);

  const rawMode = /^(sk|rk)_live_\S+$/.test(key ?? "") ? ("live" as const) : /^(sk|rk)_test_\S+$/.test(key ?? "") ? ("test" as const) : null;
  const mode = dbGoverned
    ? targetEnv === "live"
      ? rawMode === "live"
        ? ("live" as const)
        : null
      : rawMode === "test"
        ? ("test" as const)
        : null
    : rawMode;

  const cfg = providerRow.config ?? {};
  const validWebhook = /^whsec_\S+$/.test(webhook ?? "") ? webhook : undefined;
  const liveReadyInDb =
    targetEnv === "live" &&
    mode === "live" &&
    Boolean(key && validWebhook) &&
    cfg.kyc_status === "verified" &&
    cfg.live_checkout_verified === true &&
    cfg.live_webhook_verified === true &&
    origin(get("APP_URL")) !== null;
  return {
    key,
    mode,
    webhook: validWebhook,
    liveEnabled: providerRow.enabled && !isDemo() && (liveReadyInDb || (!dbGoverned && env.liveEnabled)),
    enabled: providerRow.enabled,
    environment: targetEnv,
    config: cfg,
  };
}
export function postmarkSettings() {
  const token = get("POSTMARK_SERVER_TOKEN"), from = get("EMAIL_FROM");
  const stream = get("POSTMARK_MESSAGE_STREAM") ?? "outbound";
  const webhookToken = get("POSTMARK_WEBHOOK_TOKEN");
  const testToken = token === "POSTMARK_API_TEST";
  return {provider:"postmark" as const, token, from, stream, webhookToken, testToken, enabled: !isDemo() && !!(token && from) && !testToken};
}
export async function emailSettings(db: Pick<DB, "query">) {
  switch (get("EMAIL_PROVIDER") ?? "resend") {
    case "resend": {
      const settings = await resendSettings(db);
      return { ...settings, enabled: !isDemo() && settings.enabled };
    }
    case "postmark": return postmarkSettings();
    default: return { provider: null, enabled: false as const };
  }
}

export function trackingSettings() {
  return {
    key: get("KUAIDI100_KEY"), customer: get("KUAIDI100_CUSTOMER"),
    callbackBase: origin(get("TRACKING_CALLBACK_BASE_URL") ?? get("APP_URL")),
  };
}
export async function signInMethods(db: Pick<DB, "query">) {
  return {
    google:oidcSettings("google").configured,
    microsoft:oidcSettings("microsoft").configured,
    email:!isDemo() && (await emailSettings(db)).enabled,
    demo:isDemo(),
  };
}
export type SignInMethods = Awaited<ReturnType<typeof signInMethods>>;

export function stripeCheckoutReady(stripe:ReturnType<typeof stripeSettings>&{enabled?:boolean}) {
  return !isDemo()&&stripe.enabled!==false&&!!stripe.key&&!!stripe.webhook&&
    (stripe.mode==="test"||stripe.mode==="live"&&stripe.liveEnabled);
}

export function integrationPreflight(stripe:ReturnType<typeof stripeSettings>&{enabled?:boolean}=stripeSettings()) {
  const demo = isDemo(), mail = postmarkSettings(), tracking = trackingSettings();
  function oidcStatus(provider: OidcProvider) {
    const {configured,callback}=oidcSettings(provider);
    return {configured,callback};
  }
  return {
    demo, google: oidcStatus("google"), microsoft: oidcStatus("microsoft"),
    stripe: {mode: stripe.mode, webhookConfigured: !!stripe.webhook, liveEnabled: stripe.liveEnabled,
      checkoutConfigured:stripeCheckoutReady(stripe)},
    postmark: {configured: !!(mail.token && mail.from), testToken: mail.testToken, enabled: mail.enabled},
    kuaidi100: {queryConfigured: !!(tracking.key && tracking.customer), httpsCallbackConfigured: !!tracking.callbackBase,
      subscribeConfigured: !!(tracking.key && tracking.callbackBase), workerEnabled: !demo && !!(tracking.key && (tracking.customer || tracking.callbackBase))},
  };
}
