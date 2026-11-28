import { z } from "zod";
import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, guard, one, role, type Actor } from "./common";
import { localizePublicPath, type EnabledLocale } from "./locale-contract";

export const PUBLIC_CONTACT_ADMIN_ROLES = ["super_admin", "support"] as const;
export const PUBLIC_ROUTE_ADMIN_ROLES = ["super_admin"] as const;
export const E164_PHONE_RE = /^\+[1-9]\d{6,14}$/;

export const DEFAULT_PUBLIC_CONTACT_CONFIG = {
  support_email: "support@qcwarehouse.com",
  whatsapp_enabled: false,
  whatsapp_verified: false,
  whatsapp_number: null as string | null,
  whatsapp_url: null as string | null,
  business_hours_zh: "周一至周六 09:00–18:00（北京时间 / Asia/Shanghai）",
  business_hours_en: "Mon–Sat 09:00–18:00 (Asia/Shanghai · UTC+8)",
  response_sla_zh: "工单与邮件通常于 1 个工作日内人工回复（非实时在线聊天）",
  response_sla_en: "Inquiries & tickets are reviewed within 1 business day (no live chat)",
  timezone: "Asia/Shanghai",
  widget_enabled: true,
  widget_notice_zh: "欢迎提交售前或物流质检咨询，我们会通过邮件与工单记录跟进。",
  widget_notice_en: "Submit pre-order or inspection questions anytime—we follow up via email and ticket threads.",
  updated_at: null as string | null,
};

export const contactConfigUpdateSchema = z
  .object({
    support_email: z.string().trim().email().max(180),
    whatsapp_enabled: z.boolean().default(false),
    whatsapp_verified: z.boolean().default(false),
    whatsapp_number: z
      .string()
      .trim()
      .regex(E164_PHONE_RE, "WhatsApp number must use strict E.164 format (e.g. +8613800138000).")
      .nullable()
      .optional(),
    whatsapp_url: z
      .string()
      .trim()
      .url()
      .max(300)
      .refine((v) => v.startsWith("https://"), "WhatsApp URL must use HTTPS.")
      .nullable()
      .optional(),
    business_hours_zh: z.string().trim().min(2).max(240),
    business_hours_en: z.string().trim().min(2).max(240),
    response_sla_zh: z.string().trim().min(2).max(240),
    response_sla_en: z.string().trim().min(2).max(240),
    timezone: z.string().trim().min(2).max(80).default("Asia/Shanghai"),
    widget_enabled: z.boolean().default(true),
    widget_notice_zh: z.string().trim().min(2).max(500),
    widget_notice_en: z.string().trim().min(2).max(500),
  })
  .superRefine((v, ctx) => {
    if (v.whatsapp_enabled && (!v.whatsapp_verified || !v.whatsapp_number || !v.whatsapp_url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verified WhatsApp requires whatsapp_verified=true, whatsapp_number, and HTTPS whatsapp_url before enabling.",
      });
    }
  });

export const routeStatusQuerySchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine(
      (p) => p.startsWith("/") && !p.startsWith("//") && !p.includes("\\"),
      "Path must be a valid relative path starting with '/'.",
    ),
});

export const retiredRouteUpsertSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .transform((p) => {
        const stripped = p.length > 1 ? p.replace(/\/+$/, "") : p;
        return stripped.toLowerCase();
      })
      .refine((p) => /^\/[a-z0-9/_-]+$/.test(p), "Path must contain only lowercase letters, digits, '/', '_' or '-'."),
    http_status: z.union([z.literal(301), z.literal(410)]),
    redirect_to: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\\"), "redirect_to must be a relative path starting with '/'.")
      .nullable()
      .optional(),
    title_zh: z.string().trim().min(2).max(200),
    title_en: z.string().trim().min(2).max(200),
    reason_zh: z.string().trim().min(4).max(800),
    reason_en: z.string().trim().min(4).max(800),
    replacement_path: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\\"), "replacement_path must start with '/'.")
      .default("/catalog"),
  })
  .superRefine((v, ctx) => {
    if (v.http_status === 301 && !v.redirect_to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "http_status 301 requires a valid redirect_to path." });
    }
    if (v.http_status === 410 && v.redirect_to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "http_status 410 must set redirect_to to null." });
    }
  });

export const retiredRouteDeleteSchema = z.object({
  path: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .transform((p) => (p.length > 1 ? p.replace(/\/+$/, "") : p).toLowerCase()),
});

export async function getPublicContactConfig(db: Pick<DB, "query">) {
  const row = (
    await db.query<Record<string, any>>(
      `select support_email, whatsapp_enabled, whatsapp_verified, whatsapp_number, whatsapp_url,
              business_hours_zh, business_hours_en, response_sla_zh, response_sla_en,
              timezone, widget_enabled, widget_notice_zh, widget_notice_en, updated_at
       from public_contact_settings
       where id='default'`,
    )
  ).rows[0];
  if (!row) return { ...DEFAULT_PUBLIC_CONTACT_CONFIG };
  const waNumber = typeof row.whatsapp_number === "string" ? row.whatsapp_number.trim() : "";
  const waUrl = typeof row.whatsapp_url === "string" ? row.whatsapp_url.trim() : "";
  const waVisible =
    Boolean(row.whatsapp_enabled) &&
    Boolean(row.whatsapp_verified) &&
    E164_PHONE_RE.test(waNumber) &&
    waUrl.startsWith("https://");
  return {
    support_email: String(row.support_email),
    whatsapp_enabled: waVisible,
    whatsapp_verified: Boolean(row.whatsapp_verified),
    whatsapp_number: waVisible ? waNumber : null,
    whatsapp_url: waVisible ? waUrl : null,
    business_hours_zh: String(row.business_hours_zh),
    business_hours_en: String(row.business_hours_en),
    response_sla_zh: String(row.response_sla_zh),
    response_sla_en: String(row.response_sla_en),
    timezone: String(row.timezone),
    widget_enabled: Boolean(row.widget_enabled),
    widget_notice_zh: String(row.widget_notice_zh),
    widget_notice_en: String(row.widget_notice_en),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function getAdminPublicContactConfig(db: DB, actor: Actor) {
  role(actor, ...PUBLIC_CONTACT_ADMIN_ROLES);
  const row = (
    await db.query<Record<string, any>>(
      `select * from public_contact_settings where id='default'`,
    )
  ).rows[0];
  return row ?? { id: "default", ...DEFAULT_PUBLIC_CONTACT_CONFIG };
}

export async function updatePublicContactConfig(db: DB, actor: Actor, rawInput: unknown, sessionHash: string) {
  role(actor, ...PUBLIC_CONTACT_ADMIN_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const parsed = contactConfigUpdateSchema.parse(rawInput);

  const row = await one<Record<string, any>>(
    db,
    `insert into public_contact_settings (
       id, support_email, whatsapp_enabled, whatsapp_verified, whatsapp_number, whatsapp_url,
       business_hours_zh, business_hours_en, response_sla_zh, response_sla_en,
       timezone, widget_enabled, widget_notice_zh, widget_notice_en, updated_by, updated_at
     ) values (
       'default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid, now()
     )
     on conflict (id) do update set
       support_email=excluded.support_email,
       whatsapp_enabled=excluded.whatsapp_enabled,
       whatsapp_verified=excluded.whatsapp_verified,
       whatsapp_number=excluded.whatsapp_number,
       whatsapp_url=excluded.whatsapp_url,
       business_hours_zh=excluded.business_hours_zh,
       business_hours_en=excluded.business_hours_en,
       response_sla_zh=excluded.response_sla_zh,
       response_sla_en=excluded.response_sla_en,
       timezone=excluded.timezone,
       widget_enabled=excluded.widget_enabled,
       widget_notice_zh=excluded.widget_notice_zh,
       widget_notice_en=excluded.widget_notice_en,
       updated_by=excluded.updated_by,
       updated_at=now()
     returning *`,
    [
      parsed.support_email,
      parsed.whatsapp_enabled,
      parsed.whatsapp_verified,
      parsed.whatsapp_number ?? null,
      parsed.whatsapp_url ?? null,
      parsed.business_hours_zh,
      parsed.business_hours_en,
      parsed.response_sla_zh,
      parsed.response_sla_en,
      parsed.timezone,
      parsed.widget_enabled,
      parsed.widget_notice_zh,
      parsed.widget_notice_en,
      actor.id,
    ],
  );

  await audit(db, actor, "public_contact_config_updated", "public_contact_settings", null, {
    support_email: row.support_email,
    whatsapp_enabled: row.whatsapp_enabled,
    whatsapp_verified: row.whatsapp_verified,
    widget_enabled: row.widget_enabled,
    timezone: row.timezone,
  });

  return { config: row, public_preview: await getPublicContactConfig(db) };
}

export type ResolvedRetiredRoute = {
  found: true;
  path: string;
  base_path: string;
  locale: EnabledLocale;
  http_status: 301 | 410;
  redirect_to: string | null;
  replacement_path: string;
  title_zh: string;
  title_en: string;
  reason_zh: string;
  reason_en: string;
};

export async function resolvePublicRetiredRoute(db: Pick<DB, "query">, rawPath: string): Promise<ResolvedRetiredRoute | null> {
  const cleanRaw = rawPath.split("?")[0]?.split("#")[0]?.trim() || "/";
  const normalized = (cleanRaw.length > 1 ? cleanRaw.replace(/\/+$/, "") : cleanRaw).toLowerCase();
  const isZh = normalized === "/zh" || normalized.startsWith("/zh/");
  const basePath = isZh ? (normalized === "/zh" ? "/" : normalized.slice(3) || "/") : normalized;
  const locale: EnabledLocale = isZh ? "zh-CN" : "en-US";

  const row = (
    await db.query<Record<string, any>>(
      `select * from public_retired_routes where path=$1`,
      [basePath],
    )
  ).rows[0];
  if (!row) return null;

  const status = Number(row.http_status) === 301 ? 301 : 410;
  return {
    found: true,
    path: normalized,
    base_path: basePath,
    locale,
    http_status: status,
    redirect_to: row.redirect_to ? localizePublicPath(String(row.redirect_to), locale) : null,
    replacement_path: localizePublicPath(String(row.replacement_path || "/catalog"), locale),
    title_zh: String(row.title_zh),
    title_en: String(row.title_en),
    reason_zh: String(row.reason_zh),
    reason_en: String(row.reason_en),
  };
}

export async function listPublicRetiredRoutes(db: DB, actor: Actor) {
  role(actor, ...PUBLIC_ROUTE_ADMIN_ROLES);
  const { rows } = await db.query<Record<string, any>>(
    `select * from public_retired_routes order by http_status asc, path asc`,
  );
  return { routes: rows };
}

export async function upsertPublicRetiredRoute(db: DB, actor: Actor, rawInput: unknown, sessionHash: string) {
  role(actor, ...PUBLIC_ROUTE_ADMIN_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const parsed = retiredRouteUpsertSchema.parse(rawInput);

  const reservedPrefixes = ["/api/", "/admin", "/wh", "/zh", "/gone", "/robots.txt", "/sitemap.xml", "/login", "/orders", "/account", "/staff"];
  guard(
    !reservedPrefixes.some((pfx) => parsed.path === pfx || parsed.path.startsWith(pfx + "/")) && !parsed.path.startsWith("/api"),
    "INVALID_PUBLIC_PATH",
    "Retired route path must be a non-localized public website path outside reserved portals.",
    422,
  );

  const row = await one<Record<string, any>>(
    db,
    `insert into public_retired_routes (
       path, http_status, redirect_to, title_zh, title_en, reason_zh, reason_en, replacement_path, updated_by, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,now())
     on conflict (path) do update set
       http_status=excluded.http_status,
       redirect_to=excluded.redirect_to,
       title_zh=excluded.title_zh,
       title_en=excluded.title_en,
       reason_zh=excluded.reason_zh,
       reason_en=excluded.reason_en,
       replacement_path=excluded.replacement_path,
       updated_by=excluded.updated_by,
       updated_at=now()
     returning *`,
    [
      parsed.path,
      parsed.http_status,
      parsed.redirect_to ?? null,
      parsed.title_zh,
      parsed.title_en,
      parsed.reason_zh,
      parsed.reason_en,
      parsed.replacement_path,
      actor.id,
    ],
  );

  await audit(db, actor, "public_retired_route_upserted", "public_retired_routes", null, {
    path: row.path,
    http_status: row.http_status,
    redirect_to: row.redirect_to,
  });

  return { route: row };
}

export async function deletePublicRetiredRoute(db: DB, actor: Actor, rawInput: unknown, sessionHash: string) {
  role(actor, ...PUBLIC_ROUTE_ADMIN_ROLES);
  await requireStaffMfa(db, actor, sessionHash, 15);
  const parsed = retiredRouteDeleteSchema.parse(rawInput);

  const res = await db.query("delete from public_retired_routes where path=$1", [parsed.path]);
  guard((res.rowCount ?? 0) > 0, "NOT_FOUND", "Retired route entry not found.", 404);

  await audit(db, actor, "public_retired_route_deleted", "public_retired_routes", null, { path: parsed.path });
  return { deleted: true, path: parsed.path };
}
