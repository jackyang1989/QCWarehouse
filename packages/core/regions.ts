import { z } from "zod";
import type { DB } from "../db";
import { audit, event, guard, lock, one, role, uuid, type Actor } from "./common";
import { requireStaffMfa } from "./auth";
import { stripAdminSuffix } from "./regions-seed";

export const regionChildrenQuerySchema = z.object({
  version_id: z.uuid().optional(),
  parent_id: z.uuid().optional(),
  level: z.enum(["province", "prefecture", "county", "township"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(50000).default(0),
});

export const regionSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  version_id: z.uuid().optional(),
  level: z.enum(["province", "prefecture", "county", "township"]).optional(),
  market_scope: z.enum(["cn_mainland", "hk_mo_tw"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const regionPathValidateSchema = z.object({
  version_id: z.uuid().optional(),
  province_id: z.uuid().optional(),
  prefecture_id: z.uuid().optional(),
  county_id: z.uuid().optional(),
  township_id: z.uuid().optional(),
});

export const parseChineseAddressSchema = z.object({
  raw_text: z.string().trim().min(2).max(1500),
  version_id: z.uuid().optional(),
});

export const createAddressSnapshotSchema = z.object({
  purpose: z.enum([
    "freight_forwarder",
    "supplier_return",
    "other_domestic",
    "warehouse_receiving",
    "warehouse_dispatch",
    "international_billing",
  ]),
  raw_input_text: z.string().trim().max(1500).optional(),
  recipient_name: z.string().trim().min(1).max(160),
  contact_phone_raw: z.string().trim().min(3).max(60),
  region_version_id: z.uuid().optional(),
  province_region_id: z.uuid().optional(),
  prefecture_region_id: z.uuid().optional(),
  county_region_id: z.uuid().optional(),
  township_region_id: z.uuid().optional(),
  detail_address: z.string().trim().min(1).max(500),
  postal_code: z.string().trim().max(20).optional(),
  delivery_note: z.string().trim().max(500).optional(),
  manual_unstandardized: z.boolean().default(false),
  market_scope: z.enum(["cn_mainland", "hk_mo_tw", "international"]).optional(),
  org_id: z.uuid().optional(),
});

export const regionImportDraftSchema = z.object({
  version_code: z.string().trim().min(3).max(80),
  source_name: z.string().trim().min(3).max(200),
  source_url: z.string().trim().url().max(400),
  license: z.string().trim().min(2).max(80),
  data_as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source_sha256: z.string().trim().regex(/^[a-f0-9]{64}$/),
  allow_mass_deletion: z.boolean().default(false),
  regions: z
    .array(
      z.object({
        stable_region_key: z.string().trim().min(3).max(120).optional(),
        code_system: z.enum(["mca_gbt2260", "mca_township"]),
        official_code: z.string().trim().min(6).max(16),
        level: z.enum(["province", "prefecture", "county", "township"]),
        admin_type: z.string().trim().min(2).max(40),
        name_zh: z.string().trim().min(1).max(120),
        short_name_zh: z.string().trim().min(1).max(80).optional(),
        name_en: z.string().trim().min(1).max(160).optional(),
        pinyin: z.string().trim().min(1).max(160).optional(),
        parent_official_code: z.string().trim().min(6).max(16).nullable().default(null),
        market_scope: z.enum(["cn_mainland", "hk_mo_tw", "international"]).default("cn_mainland"),
        is_terminal_official: z.boolean().default(false),
        status: z.enum(["active", "deprecated", "abolished"]).default("active"),
      }),
    )
    .min(1),
  change_mappings: z
    .array(
      z.object({
        from_official_code: z.string().trim().min(6).max(16),
        to_official_code: z.string().trim().min(6).max(16).nullable().default(null),
        change_type: z.enum(["renamed", "merged", "split", "reparented", "code_changed", "abolished", "added"]),
        effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        evidence_note: z.string().trim().max(400).optional(),
      }),
    )
    .default([]),
});

export const regionAliasCreateSchema = z.object({
  stable_region_key: z.string().trim().min(3).max(120),
  alias_text: z.string().trim().min(1).max(120),
  alias_kind: z.enum(["short_name", "historical_name", "pinyin", "english", "traditional_zh", "logistics_park"]),
  locale: z.enum(["en-US", "zh-CN"]).default("zh-CN"),
  source_note: z.string().trim().max(240).optional(),
});

export interface RegionNodeRow {
  id: string;
  stable_region_key: string;
  version_id: string;
  code_system: "mca_gbt2260" | "mca_township";
  official_code: string;
  level: "province" | "prefecture" | "county" | "township";
  admin_type: string;
  name_zh: string;
  short_name_zh: string;
  name_en: string;
  pinyin: string;
  parent_id: string | null;
  market_scope: "cn_mainland" | "hk_mo_tw" | "international";
  is_terminal_official: boolean;
  status: string;
}

async function resolveTargetVersionId(db: Pick<DB, "query">, versionId?: string | null): Promise<string> {
  if (versionId) {
    const v = await one<{ id: string }>(db, "select id from region_dataset_versions where id = $1", [versionId]);
    return v.id;
  }
  const active = (
    await db.query<{ id: string }>("select id from region_dataset_versions where status = 'active' limit 1")
  ).rows[0];
  guard(active, "REGION_DATASET_NOT_READY", "No active region dataset version is published.", 409);
  return active.id;
}

async function loadAncestorChain(db: Pick<DB, "query">, regionId: string, versionId: string): Promise<RegionNodeRow[]> {
  const { rows } = await db.query<RegionNodeRow>(
    `with recursive chain as (
       select r.*, 0 as depth
       from regions r where r.id = $1 and r.version_id = $2
       union all
       select p.*, c.depth + 1
       from regions p join chain c on p.id = c.parent_id
       where p.version_id = $2 and c.depth < 6
     )
     select id, stable_region_key, version_id, code_system, official_code, level, admin_type,
            name_zh, short_name_zh, name_en, pinyin, parent_id, market_scope, is_terminal_official, status
     from chain order by depth desc`,
    [regionId, versionId],
  );
  return rows;
}

export async function getActiveRegionOverview(db: Pick<DB, "query">) {
  const version = (
    await db.query<{
      id: string;
      version_code: string;
      source_name: string;
      source_url: string;
      license: string;
      data_as_of: string;
      source_sha256: string;
      province_count: number;
      prefecture_count: number;
      county_count: number;
      township_count: number;
      activated_at: string | null;
    }>(
      `select id, version_code, source_name, source_url, license, data_as_of::text, source_sha256,
              province_count, prefecture_count, county_count, township_count, activated_at::text
       from region_dataset_versions where status = 'active' limit 1`,
    )
  ).rows[0];

  if (!version) {
    return { ready: false as const, active_version: null };
  }
  const aliasCount = (
    await db.query<{ count: string }>("select count(*)::text as count from region_aliases where status = 'active'")
  ).rows[0];
  return {
    ready: true as const,
    active_version: version,
    active_alias_count: Number(aliasCount.count),
  };
}

export async function listRegionChildren(
  db: Pick<DB, "query">,
  query: { version_id?: string; parent_id?: string; level?: string; limit?: number; offset?: number },
) {
  const versionId = await resolveTargetVersionId(db, query.version_id);
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 200);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  const params: unknown[] = [versionId];
  const where: string[] = ["r.version_id = $1", "r.status = 'active'"];
  if (query.parent_id) {
    params.push(query.parent_id);
    where.push(`r.parent_id = $${params.length}`);
  } else if (query.level) {
    params.push(query.level);
    where.push(`r.level = $${params.length}`);
  } else {
    where.push("r.parent_id is null");
  }
  params.push(limit, offset);
  const { rows } = await db.query<RegionNodeRow & { child_count: number }>(
    `select r.id, r.stable_region_key, r.version_id, r.code_system, r.official_code, r.level, r.admin_type,
            r.name_zh, r.short_name_zh, r.name_en, r.pinyin, r.parent_id, r.market_scope, r.is_terminal_official, r.status,
            (select count(*)::int from regions c where c.parent_id = r.id and c.status = 'active') as child_count
     from regions r
     where ${where.join(" and ")}
     order by r.official_code asc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { version_id: versionId, limit, offset, items: rows };
}

export async function searchRegions(db: Pick<DB, "query">, input: z.infer<typeof regionSearchQuerySchema>) {
  const versionId = await resolveTargetVersionId(db, input.version_id);
  const qLower = input.q.toLowerCase();
  const qLike = `%${input.q}%`;
  const qLowerLike = `%${qLower}%`;
  const params: unknown[] = [versionId, input.q, qLower, qLike, qLowerLike];
  const filters: string[] = ["r.version_id = $1", "r.status = 'active'"];
  if (input.level) {
    params.push(input.level);
    filters.push(`r.level = $${params.length}`);
  }
  if (input.market_scope) {
    params.push(input.market_scope);
    filters.push(`r.market_scope = $${params.length}`);
  }
  params.push(input.limit);

  const { rows } = await db.query<RegionNodeRow & { duplicate_name_count: number; matched_alias: string | null }>(
    `select r.id, r.stable_region_key, r.version_id, r.code_system, r.official_code, r.level, r.admin_type,
            r.name_zh, r.short_name_zh, r.name_en, r.pinyin, r.parent_id, r.market_scope, r.is_terminal_official, r.status,
            (select count(*)::int from regions d where d.version_id = r.version_id and d.name_zh = r.name_zh and d.level = r.level) as duplicate_name_count,
            (select a.alias_text from region_aliases a
             where a.stable_region_key = r.stable_region_key
               and a.status = 'active'
               and (a.alias_text ilike $4 or lower(a.alias_text) = $3)
             limit 1) as matched_alias
     from regions r
     where ${filters.join(" and ")}
       and (
         r.official_code = $2
         or r.official_code like ($2 || '%')
         or r.name_zh ilike $4
         or r.short_name_zh ilike $4
         or lower(r.name_en) like $5
         or lower(r.pinyin) like $5
         or exists (
           select 1 from region_aliases a
           where a.stable_region_key = r.stable_region_key
             and a.status = 'active'
             and (a.alias_text ilike $4 or lower(a.alias_text) = $3)
         )
       )
     order by (r.official_code = $2 or r.short_name_zh = $2 or r.name_zh = $2) desc,
              (r.level = 'province') desc,
              (r.level = 'prefecture') desc,
              (r.level = 'county') desc,
              r.official_code asc
     limit $${params.length}`,
    params,
  );

  const items = [];
  for (const r of rows) {
    const chain = await loadAncestorChain(db, r.id, versionId);
    items.push({
      ...r,
      ambiguous_name: r.duplicate_name_count > 1,
      path_zh: chain.map((c) => c.name_zh).join(" / "),
      ancestors: chain.map((c) => ({
        id: c.id,
        official_code: c.official_code,
        level: c.level,
        name_zh: c.name_zh,
        name_en: c.name_en,
      })),
    });
  }

  return { version_id: versionId, query: input.q, items };
}

export async function getRegionDetail(db: Pick<DB, "query">, regionId: string) {
  const region = await one<RegionNodeRow>(
    db,
    `select id, stable_region_key, version_id, code_system, official_code, level, admin_type,
            name_zh, short_name_zh, name_en, pinyin, parent_id, market_scope, is_terminal_official, status
     from regions where id = $1`,
    [regionId],
  );
  const ancestors = await loadAncestorChain(db, region.id, region.version_id);
  const children = (
    await db.query<RegionNodeRow>(
      `select id, stable_region_key, version_id, code_system, official_code, level, admin_type,
              name_zh, short_name_zh, name_en, pinyin, parent_id, market_scope, is_terminal_official, status
       from regions where parent_id = $1 and status = 'active' order by official_code asc limit 200`,
      [region.id],
    )
  ).rows;
  const aliases = (
    await db.query<{ id: string; alias_text: string; alias_kind: string; locale: string; status: string; source_note: string | null }>(
      `select id, alias_text, alias_kind, locale, status, source_note
       from region_aliases where stable_region_key = $1 order by created_at asc`,
      [region.stable_region_key],
    )
  ).rows;
  const changeMappings = (
    await db.query(
      `select from_official_code, to_official_code, change_type, effective_date, evidence_note, requires_manual_confirm
       from region_change_mappings
       where from_region_id = $1 or to_region_id = $1
       order by created_at desc limit 20`,
      [region.id],
    )
  ).rows;
  const snapshotStats = (
    await db.query<{ snapshot_count: string }>(
      `select count(*)::text as snapshot_count from address_snapshots
       where province_region_id = $1 or prefecture_region_id = $1 or county_region_id = $1 or township_region_id = $1`,
      [region.id],
    )
  ).rows[0];

  return {
    region,
    ancestors,
    children,
    aliases,
    change_mappings: changeMappings,
    references_summary: {
      address_snapshot_count: Number(snapshotStats.snapshot_count),
    },
  };
}

export async function validateRegionPath(db: Pick<DB, "query">, input: z.infer<typeof regionPathValidateSchema>) {
  const versionId = await resolveTargetVersionId(db, input.version_id);
  const deepestId = input.township_id ?? input.county_id ?? input.prefecture_id ?? input.province_id;
  guard(deepestId, "REGION_REQUIRED", "At least one region level ID is required.", 422);

  const chain = await loadAncestorChain(db, deepestId, versionId);
  guard(chain.length > 0, "INVALID_REGION_PATH", "Region node does not exist in the selected dataset version.", 422);
  guard(
    chain.every((node) => node.status === "active"),
    "INVALID_REGION_PATH",
    "Selected region hierarchy contains an inactive or abolished administrative division.",
    422,
  );

  const byLevel = new Map<RegionNodeRow["level"], RegionNodeRow>();
  for (const node of chain) {
    byLevel.set(node.level, node);
  }
  const requestedChecks: Array<[RegionNodeRow["level"], string | undefined]> = [
    ["province", input.province_id],
    ["prefecture", input.prefecture_id],
    ["county", input.county_id],
    ["township", input.township_id],
  ];
  for (const [lvl, expectedId] of requestedChecks) {
    if (expectedId) {
      const actual = byLevel.get(lvl);
      guard(actual && actual.id === expectedId, "INVALID_REGION_PATH", `Provided '${lvl}' region does not match the true administrative hierarchy.`, 422);
    }
  }

  const prov = byLevel.get("province");
  guard(prov, "INVALID_REGION_PATH", "Resolved path must terminate at a valid province.", 422);
  const terminalNode = chain[chain.length - 1]!;
  const domesticAutoQuoteEligible =
    terminalNode.market_scope === "cn_mainland" &&
    (terminalNode.level === "county" ||
      terminalNode.level === "township" ||
      (terminalNode.level === "prefecture" && terminalNode.is_terminal_official));

  return {
    valid: true as const,
    version_id: versionId,
    market_scope: terminalNode.market_scope,
    domestic_auto_quote_eligible: domesticAutoQuoteEligible,
    province: byLevel.get("province") ?? null,
    prefecture: byLevel.get("prefecture") ?? null,
    county: byLevel.get("county") ?? null,
    township: byLevel.get("township") ?? null,
    path_codes: chain.map((c) => c.official_code),
    path_names_zh: chain.map((c) => c.name_zh),
  };
}

/**
 * Pure local rule-based Chinese address parser (§59.1 & §59.5).
 * NEVER stores or synthesizes separate forwarder member_code fields; preserves raw text & digits intact.
 */
export async function parseChineseAddress(db: Pick<DB, "query">, input: z.infer<typeof parseChineseAddressSchema>) {
  const versionId = await resolveTargetVersionId(db, input.version_id);
  const raw = input.raw_text;
  const compact = raw.replace(/[\r\n]+/g, " ").replace(/[，,；;]+/g, " ").replace(/\s+/g, " ").trim();

  // Check explicit masked phone patterns (never dispatch-ready)
  const maskedPhoneMatch = compact.match(/(?<!\d)1[3-9]\d[*＊]{4}\d{4}(?!\d)/);
  const mobileMatch = compact.match(/(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d{9})(?!\d)/);
  const landlineMatch = compact.match(/(?<!\d)(0\d{2,3}-\d{7,8}(?:-\d{1,6})?)(?!\d)/);
  const explicitPostalMatch = compact.match(/(?:邮编|邮政编码)[:：\s]*([1-9]\d{5})(?!\d)/);

  const contactPhoneRaw = mobileMatch?.[0]?.trim() ?? landlineMatch?.[1] ?? maskedPhoneMatch?.[0] ?? "";
  const contactPhoneNormalized = mobileMatch?.[1] ?? (landlineMatch?.[1] ? landlineMatch[1] : null);
  const contactPhoneMasked = Boolean(maskedPhoneMatch && !mobileMatch && !landlineMatch);

  // Detect HK / MO / TW or international text early
  const isHkMoTw = /(?:香港|澳門|澳门|台灣|台湾|Hong Kong|Macau|Taiwan)/i.test(compact);
  const isLikelyInternational = !/[\u4e00-\u9fff]/.test(compact) && /(?:USA|United States|UK|United Kingdom|Street|Ave|Road|Australia|Canada)/i.test(compact);

  // Extract candidate tokens stripped of phone label to match regions from active version
  const withoutPhones = compact
    .replace(/(?:收件人|收货人|联系人|姓名|电话|手机|联系方式|地址|所在地区|详细地址)[:：]/g, " ")
    .replace(contactPhoneRaw || "__NO_MATCH__", " ")
    .replace(/\s+/g, " ")
    .trim();

  // Match provinces, prefectures, counties (and active aliases) that appear in text
  const { rows: candidateRegions } = await db.query<RegionNodeRow>(
    `select id, stable_region_key, version_id, code_system, official_code, level, admin_type,
            name_zh, short_name_zh, name_en, pinyin, parent_id, market_scope, is_terminal_official, status
     from regions
     where version_id = $1 and status = 'active' and level in ('province', 'prefecture', 'county')
       and (
         position(name_zh in $2) > 0
         or (char_length(short_name_zh) >= 2 and position(short_name_zh in $2) > 0)
       )
     order by case level when 'county' then 1 when 'prefecture' then 2 else 3 end, char_length(name_zh) desc`,
    [versionId, withoutPhones],
  );

  // Also check explicit alias matches (e.g. historical names or logistics parks)
  const { rows: aliasMatchedRegions } = await db.query<RegionNodeRow>(
    `select r.id, r.stable_region_key, r.version_id, r.code_system, r.official_code, r.level, r.admin_type,
            r.name_zh, r.short_name_zh, r.name_en, r.pinyin, r.parent_id, r.market_scope, r.is_terminal_official, r.status
     from region_aliases a
     join regions r on r.stable_region_key = a.stable_region_key and r.version_id = $1 and r.status = 'active'
     where a.status = 'active' and char_length(a.alias_text) >= 2 and position(a.alias_text in $2) > 0`,
    [versionId, withoutPhones],
  );

  const mergedCandidates = new Map<string, RegionNodeRow>();
  for (const r of candidateRegions) {
    if (r.name_zh && withoutPhones.includes(r.name_zh)) {
      mergedCandidates.set(r.id, r);
    } else if (r.short_name_zh.length >= 2) {
      const idx = withoutPhones.indexOf(r.short_name_zh);
      if (idx >= 0) {
        const nextChar = withoutPhones[idx + r.short_name_zh.length] ?? "";
        const blockedSuffix =
          r.level === "province"
            ? /[路街道巷弄园村号栋室]/
            : r.level === "prefecture"
              ? /[省区县旗盟州路街道巷弄园村号栋室]/
              : /[省市区县旗盟州路街道巷弄园村号栋室]/;
        if (!blockedSuffix.test(nextChar)) {
          mergedCandidates.set(r.id, r);
        }
      }
    }
  }
  for (const r of aliasMatchedRegions) {
    mergedCandidates.set(r.id, r);
  }
  const allCandidates = [...mergedCandidates.values()];
  const provincesMatched = allCandidates.filter((r) => r.level === "province");
  const prefecturesMatched = allCandidates.filter((r) => r.level === "prefecture");
  let countiesMatched = allCandidates.filter((r) => r.level === "county");
  const exactCountyMatches = countiesMatched.filter((c) => withoutPhones.includes(c.name_zh));
  if (exactCountyMatches.length > 0) {
    countiesMatched = exactCountyMatches;
  }

  // Prefer county whose ancestor matches a matched province or prefecture; detect ambiguity otherwise
  let compatibleCounties = countiesMatched;
  let hasHierarchyConflict = false;
  const countyChains = new Map<string, RegionNodeRow[]>();
  for (const c of countiesMatched) {
    countyChains.set(c.id, await loadAncestorChain(db, c.id, versionId));
  }
  if (provincesMatched.length > 0 || prefecturesMatched.length > 0) {
    const provIds = new Set(provincesMatched.map((p) => p.id));
    const prefIds = new Set(prefecturesMatched.map((p) => p.id));
    const narrowed = countiesMatched.filter((c) => {
      const chainIds = (countyChains.get(c.id) ?? []).map((x) => x.id);
      return (prefIds.size === 0 || chainIds.some((id) => prefIds.has(id))) && (provIds.size === 0 || chainIds.some((id) => provIds.has(id)));
    });
    if (narrowed.length > 0) {
      compatibleCounties = narrowed;
    } else if (countiesMatched.length > 0) {
      hasHierarchyConflict = true;
    }
  }

  let selectedChain: RegionNodeRow[] = [];
  let ambiguityCandidates: Array<{ region_id: string; official_code: string; path_zh: string }> = [];
  let needsConfirmation = false;

  if (hasHierarchyConflict) {
    needsConfirmation = true;
    ambiguityCandidates = countiesMatched.map((c) => ({
      region_id: c.id,
      official_code: c.official_code,
      path_zh: (countyChains.get(c.id) ?? []).map((x) => x.name_zh).join(" / "),
    }));
  } else if (compatibleCounties.length === 1) {
    selectedChain = countyChains.get(compatibleCounties[0]!.id) ?? [];
  } else if (compatibleCounties.length > 1) {
    needsConfirmation = true;
    ambiguityCandidates = compatibleCounties.map((c) => ({
      region_id: c.id,
      official_code: c.official_code,
      path_zh: (countyChains.get(c.id) ?? []).map((x) => x.name_zh).join(" / "),
    }));
  } else if (prefecturesMatched.length === 1) {
    selectedChain = await loadAncestorChain(db, prefecturesMatched[0]!.id, versionId);
    if (!prefecturesMatched[0]!.is_terminal_official) needsConfirmation = true;
  } else if (provincesMatched.length === 1) {
    selectedChain = [provincesMatched[0]!];
    needsConfirmation = true;
  } else {
    needsConfirmation = true;
  }

  // Infer recipient name from non-region token(s) next to phone without stripping embedded forwarder IDs
  const tokens = withoutPhones.split(" ").filter(Boolean);
  let recipientName = "";
  let detailTokens: string[] = [];
  if (tokens.length >= 2) {
    // Usually first token before region/detail or token immediately adjacent to phone when short/name-like
    const regionTextSet = new Set(selectedChain.flatMap((n) => [n.name_zh, n.short_name_zh]));
    const firstNonRegion = tokens.find((t) => !regionTextSet.has(t) && t.length <= 28);
    if (firstNonRegion && !/(?:省|市|区|县|路|街|道|号|栋|室|园|仓)$/.test(firstNonRegion)) {
      recipientName = firstNonRegion;
      detailTokens = tokens.filter((t) => t !== firstNonRegion);
    } else {
      detailTokens = tokens;
    }
  } else {
    detailTokens = tokens;
  }

  // If recipient is at the end (e.g., "... 88号 张伟(CW8899) 13800138000"), inspect last short token
  if (!recipientName && tokens.length >= 2) {
    const tail = tokens[tokens.length - 1]!;
    if (tail.length <= 28 && !/(?:路|街|道|号|栋|室|园|村)$/.test(tail)) {
      recipientName = tail;
      detailTokens = tokens.slice(0, -1);
    }
  }

  const byLevel = new Map<RegionNodeRow["level"], RegionNodeRow>();
  for (const n of selectedChain) byLevel.set(n.level, n);

  const marketScope: "cn_mainland" | "hk_mo_tw" | "international" = isLikelyInternational
    ? "international"
    : selectedChain.some((n) => n.market_scope === "hk_mo_tw") || isHkMoTw
      ? "hk_mo_tw"
      : "cn_mainland";

  const domesticAutoQuoteEligible =
    marketScope === "cn_mainland" &&
    !needsConfirmation &&
    (byLevel.has("county") || Boolean(byLevel.get("prefecture")?.is_terminal_official));

  if (!contactPhoneNormalized || !recipientName) {
    needsConfirmation = true;
  }

  return {
    version_id: versionId,
    raw_input_text: raw,
    recipient_name: recipientName || null,
    contact_phone_raw: contactPhoneRaw || null,
    contact_phone_normalized: contactPhoneNormalized,
    contact_phone_masked: contactPhoneMasked,
    postal_code: explicitPostalMatch?.[1] ?? null,
    market_scope: marketScope,
    domestic_auto_quote_eligible: domesticAutoQuoteEligible,
    ready_for_dispatch: !contactPhoneMasked && Boolean(contactPhoneNormalized) && Boolean(recipientName) && marketScope === "cn_mainland" && !needsConfirmation,
    needs_confirmation: needsConfirmation,
    region_path: {
      province: byLevel.get("province") ?? null,
      prefecture: byLevel.get("prefecture") ?? null,
      county: byLevel.get("county") ?? null,
    },
    candidates: ambiguityCandidates,
    detail_address: detailTokens.join(" ") || raw,
  };
}

export async function createAddressSnapshot(
  db: DB,
  actor: Actor,
  input: z.infer<typeof createAddressSnapshotSchema>,
) {
  const isStaff = actor.kind === "staff";
  if (input.purpose === "warehouse_receiving" || input.purpose === "warehouse_dispatch") {
    role(actor, "super_admin", "warehouse_admin");
  } else if (isStaff) {
    role(actor, "super_admin", "warehouse_admin", "support");
  } else {
    guard(Boolean(actor.org), "FORBIDDEN", "Customer organization profile is required.", 403);
    if (input.org_id) {
      guard(input.org_id === actor.org, "FORBIDDEN", "Cross-organization address snapshot creation is forbidden.", 403);
    }
  }
  const targetOrgId = isStaff ? (input.org_id ?? null) : actor.org;

  const isMasked = /[*＊]{2,}/.test(input.contact_phone_raw);
  guard(
    !(isMasked && input.purpose !== "international_billing"),
    "MASKED_PHONE_NOT_DISPATCHABLE",
    "Masked contact phone numbers cannot be locked into a shipping address snapshot.",
    422,
  );

  const normalizedPhone = input.contact_phone_raw.replace(/[\s+]/g, "");
  let versionId: string | null = null;
  let provinceId: string | null = null;
  let prefectureId: string | null = null;
  let countyId: string | null = null;
  let townshipId: string | null = null;
  let pathCodes: string[] = [];
  let pathNamesZh: string[] = [];
  let marketScope: "cn_mainland" | "hk_mo_tw" | "international" =
    input.market_scope ?? (input.purpose === "international_billing" ? "international" : "cn_mainland");
  let parseStatus: "structured" | "parsed_confirmed" | "manual_unstandardized" | "needs_confirmation" = "structured";
  let domesticDeliverable = false;

  const hasAnyRegionId = Boolean(
    input.province_region_id || input.prefecture_region_id || input.county_region_id || input.township_region_id,
  );

  if (input.manual_unstandardized) {
    guard(
      isStaff || input.purpose === "international_billing",
      "STAFF_CONFIRMATION_REQUIRED",
      "Manual unstandardized domestic shipping snapshots require staff verification.",
      403,
    );
    if (hasAnyRegionId) {
      const validated = await validateRegionPath(db, {
        version_id: input.region_version_id,
        province_id: input.province_region_id,
        prefecture_id: input.prefecture_region_id,
        county_id: input.county_region_id,
        township_id: input.township_region_id,
      });
      versionId = validated.version_id;
      provinceId = validated.province?.id ?? null;
      prefectureId = validated.prefecture?.id ?? null;
      countyId = validated.county?.id ?? null;
      townshipId = validated.township?.id ?? null;
      pathCodes = validated.path_codes;
      pathNamesZh = validated.path_names_zh;
      marketScope = input.market_scope ?? validated.market_scope;
    }
    parseStatus = "manual_unstandardized";
  } else {
    const validated = await validateRegionPath(db, {
      version_id: input.region_version_id,
      province_id: input.province_region_id,
      prefecture_id: input.prefecture_region_id,
      county_id: input.county_region_id,
      township_id: input.township_region_id,
    });
    versionId = validated.version_id;
    provinceId = validated.province?.id ?? null;
    prefectureId = validated.prefecture?.id ?? null;
    countyId = validated.county?.id ?? null;
    townshipId = validated.township?.id ?? null;
    pathCodes = validated.path_codes;
    pathNamesZh = validated.path_names_zh;
    marketScope = validated.market_scope;
    domesticDeliverable = validated.domestic_auto_quote_eligible;
    parseStatus = input.raw_input_text ? "parsed_confirmed" : "structured";
  }

  const snapshotId = uuid();
  const row = await one(
    db,
    `insert into address_snapshots(
       id, org_id, owner_user_id, purpose, raw_input_text, recipient_name, contact_phone_raw, contact_phone_normalized,
       region_dataset_version_id, province_region_id, prefecture_region_id, county_region_id, township_region_id,
       region_path_codes, region_path_names_zh, detail_address, postal_code, delivery_note,
       market_scope, parse_status, domestic_deliverable, confirmed_by, confirmed_at
     ) values(
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       $14::text[], $15::text[], $16, $17, $18,
       $19, $20, $21, $22, now()
     )
     returning *`,
    [
      snapshotId,
      targetOrgId,
      actor.id,
      input.purpose,
      input.raw_input_text ?? null,
      input.recipient_name,
      input.contact_phone_raw,
      normalizedPhone,
      versionId,
      provinceId,
      prefectureId,
      countyId,
      townshipId,
      pathCodes,
      pathNamesZh,
      input.detail_address,
      input.postal_code ?? null,
      input.delivery_note ?? null,
      marketScope,
      parseStatus,
      domesticDeliverable,
      actor.id,
    ],
  );
  await audit(db, actor, "create_address_snapshot", "address_snapshots", snapshotId, {
    purpose: input.purpose,
    market_scope: marketScope,
    parse_status: parseStatus,
  });
  return row;
}

export async function getAddressSnapshot(db: Pick<DB, "query">, actor: Actor, snapshotId: string) {
  const snap = (
    await db.query<{
      id: string;
      org_id: string | null;
      owner_user_id: string | null;
      purpose: string;
      raw_input_text: string | null;
      recipient_name: string;
      contact_phone_raw: string;
      contact_phone_normalized: string | null;
      region_dataset_version_id: string | null;
      region_path_codes: string[];
      region_path_names_zh: string[];
      detail_address: string;
      postal_code: string | null;
      delivery_note: string | null;
      market_scope: string;
      parse_status: string;
      domestic_deliverable: boolean;
      created_at: string;
    }>("select * from address_snapshots where id = $1", [snapshotId])
  ).rows[0];
  guard(snap, "NOT_FOUND", "Address snapshot not found.", 404);
  if (actor.kind === "staff") {
    role(actor, "super_admin", "warehouse_admin", "support", "finance", "receiver");
  } else {
    guard(
      (actor.org && snap.org_id === actor.org) || snap.owner_user_id === actor.id,
      "FORBIDDEN",
      "You cannot access another customer's address snapshot.",
      403,
    );
  }
  return snap;
}

export async function listRegionDatasetVersions(db: Pick<DB, "query">, actor: Actor) {
  role(actor, "super_admin");
  const { rows } = await db.query(
    `select id, version_code, source_name, source_url, license, data_as_of::text, source_sha256, status,
            province_count, prefecture_count, county_count, township_count, diff_summary, impact_summary,
            created_by, approved_by, activated_at, created_at
     from region_dataset_versions order by created_at desc limit 50`,
  );
  return { versions: rows };
}

export async function importRegionDatasetDraft(
  db: DB,
  actor: Actor,
  input: z.infer<typeof regionImportDraftSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "region_dataset_import");

  const dupCodeCheck = (
    await db.query("select 1 from region_dataset_versions where version_code = $1", [input.version_code])
  ).rowCount;
  guard(!dupCodeCheck, "VERSION_EXISTS", `Region dataset version '${input.version_code}' already exists.`, 409);

  // Validate syntax, duplicates, parents, and cycles strictly before creating a draft version
  const seenKey = new Set<string>();
  const rowByCode = new Map<string, (typeof input.regions)[number]>();
  for (const r of input.regions) {
    if (r.code_system === "mca_gbt2260") {
      guard(/^\d{6}$/.test(r.official_code), "INVALID_REGION_CODE", `GB/T 2260 code '${r.official_code}' must be 6 digits.`, 422);
    } else {
      guard(/^\d{9,12}$/.test(r.official_code), "INVALID_REGION_CODE", `Township code '${r.official_code}' must be 9-12 digits.`, 422);
    }
    const compound = `${r.code_system}:${r.official_code}`;
    guard(!seenKey.has(compound), "DUPLICATE_REGION_CODE", `Duplicate official code '${compound}'.`, 422);
    seenKey.add(compound);
    rowByCode.set(r.official_code, r);
  }

  for (const r of input.regions) {
    if (r.level === "province") {
      guard(!r.parent_official_code, "INVALID_PARENT", `Province '${r.official_code}' cannot have a parent.`, 422);
    } else if (r.parent_official_code) {
      guard(rowByCode.has(r.parent_official_code), "ORPHAN_PARENT", `Parent '${r.parent_official_code}' not found for '${r.official_code}'.`, 422);
    } else {
      guard(false, "ORPHAN_PARENT", `Non-province region '${r.official_code}' must reference an existing parent_official_code.`, 422);
    }
    // Cycle check
    const visited = new Set<string>([r.official_code]);
    let cur = r.parent_official_code;
    while (cur) {
      guard(!visited.has(cur), "CYCLE_DETECTED", `Cycle detected at '${cur}'.`, 422);
      visited.add(cur);
      cur = rowByCode.get(cur)?.parent_official_code ?? null;
    }
  }

  const currentActive = (
    await db.query<{ id: string }>("select id from region_dataset_versions where status = 'active' limit 1")
  ).rows[0];

  let added = 0;
  let renamed = 0;
  let reparented = 0;
  let removed = 0;
  const oldByCode = new Map<string, { id: string; name_zh: string; parent_code: string | null }>();
  if (currentActive) {
    const oldRows = (
      await db.query<{ id: string; official_code: string; name_zh: string; parent_code: string | null }>(
        `select r.id, r.official_code, r.name_zh, p.official_code as parent_code
         from regions r left join regions p on p.id = r.parent_id
         where r.version_id = $1`,
        [currentActive.id],
      )
    ).rows;
    for (const o of oldRows) oldByCode.set(o.official_code, o);
    for (const r of input.regions) {
      const prev = oldByCode.get(r.official_code);
      if (!prev) added += 1;
      else {
        if (prev.name_zh !== r.name_zh) renamed += 1;
        if (prev.parent_code !== r.parent_official_code) reparented += 1;
      }
    }
    for (const oldCode of oldByCode.keys()) {
      if (!rowByCode.has(oldCode)) removed += 1;
    }
    if (oldRows.length >= 20 && removed > oldRows.length * 0.1 && !input.allow_mass_deletion) {
      guard(
        false,
        "MASS_DELETION_BLOCKED",
        `Draft deletes ${removed}/${oldRows.length} active regions (>10%); confirm allow_mass_deletion explicitly.`,
        422,
      );
    }
  } else {
    added = input.regions.length;
  }

  const versionId = uuid();
  const idByOfficialCode = new Map<string, string>();
  for (const r of input.regions) idByOfficialCode.set(r.official_code, uuid());

  const counts = {
    province: input.regions.filter((r) => r.level === "province").length,
    prefecture: input.regions.filter((r) => r.level === "prefecture").length,
    county: input.regions.filter((r) => r.level === "county").length,
    township: input.regions.filter((r) => r.level === "township").length,
  };

  const impactedSnapshots = currentActive
    ? Number(
        (
          await db.query<{ c: string }>(
            "select count(*)::text as c from address_snapshots where region_dataset_version_id = $1",
            [currentActive.id],
          )
        ).rows[0].c,
      )
    : 0;

  await db.query(
    `insert into region_dataset_versions(
       id, version_code, source_name, source_url, license, data_as_of, source_sha256, status,
       province_count, prefecture_count, county_count, township_count,
       diff_summary, impact_summary, created_by
     ) values($1, $2, $3, $4, $5, $6, $7, 'staged', $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)`,
    [
      versionId,
      input.version_code,
      input.source_name,
      input.source_url,
      input.license,
      input.data_as_of,
      input.source_sha256,
      counts.province,
      counts.prefecture,
      counts.county,
      counts.township,
      JSON.stringify({ added, removed, renamed, reparented, total_rows: input.regions.length }),
      JSON.stringify({ historical_snapshots_on_active: impactedSnapshots }),
      actor.id,
    ],
  );

  // Topological order insert (province -> prefecture -> county -> township)
  for (const lvl of ["province", "prefecture", "county", "township"] as const) {
    const chunk = input.regions.filter((r) => r.level === lvl);
    if (!chunk.length) continue;
    await db.query(
      `insert into regions(
         id, stable_region_key, version_id, code_system, official_code,
         level, admin_type, name_zh, short_name_zh, name_en, pinyin,
         parent_id, market_scope, is_terminal_official, status
       )
       select
         t.id, t.stable_region_key, $1::uuid, t.code_system, t.official_code,
         t.level, t.admin_type, t.name_zh, t.short_name_zh, t.name_en, t.pinyin,
         t.parent_id, t.market_scope, t.is_terminal_official, t.status
       from unnest(
         $2::uuid[], $3::text[], $4::text[], $5::text[],
         $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
         $12::uuid[], $13::text[], $14::boolean[], $15::text[]
       ) as t(
         id, stable_region_key, code_system, official_code,
         level, admin_type, name_zh, short_name_zh, name_en, pinyin,
         parent_id, market_scope, is_terminal_official, status
       )`,
      [
        versionId,
        chunk.map((r) => idByOfficialCode.get(r.official_code)!),
        chunk.map((r) => r.stable_region_key ?? `${r.code_system}:${r.official_code}`),
        chunk.map((r) => r.code_system),
        chunk.map((r) => r.official_code),
        chunk.map((r) => r.level),
        chunk.map((r) => r.admin_type),
        chunk.map((r) => r.name_zh),
        chunk.map((r) => r.short_name_zh ?? stripAdminSuffix(r.name_zh, r.level)),
        chunk.map((r) => r.name_en ?? r.name_zh),
        chunk.map((r) => r.pinyin ?? r.official_code),
        chunk.map((r) => (r.parent_official_code ? idByOfficialCode.get(r.parent_official_code)! : null)),
        chunk.map((r) => r.market_scope),
        chunk.map((r) => r.is_terminal_official),
        chunk.map((r) => r.status),
      ],
    );
  }

  for (const m of input.change_mappings) {
    const oldInfo = oldByCode.get(m.from_official_code);
    const toId = m.to_official_code ? (idByOfficialCode.get(m.to_official_code) ?? null) : null;
    await db.query(
      `insert into region_change_mappings(
         id, from_version_id, to_version_id, from_region_id, from_official_code,
         to_region_id, to_official_code, change_type, effective_date, evidence_note, requires_manual_confirm
       ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        uuid(),
        currentActive?.id ?? null,
        versionId,
        oldInfo?.id ?? null,
        m.from_official_code,
        toId,
        m.to_official_code,
        m.change_type,
        m.effective_date ?? null,
        m.evidence_note ?? null,
        m.change_type === "split" || m.change_type === "merged",
      ],
    );
  }

  await db.query(
    `insert into region_import_runs(id, version_id, mode, status, summary, started_by)
     values($1, $2, 'import_draft', 'succeeded', $3::jsonb, $4)`,
    [uuid(), versionId, JSON.stringify({ added, removed, renamed, reparented }), actor.id],
  );
  await audit(db, actor, "import_region_dataset_draft", "region_dataset_versions", versionId, {
    version_code: input.version_code,
    diff: { added, removed, renamed, reparented },
  });

  return {
    id: versionId,
    version_code: input.version_code,
    status: "staged" as const,
    diff_summary: { added, removed, renamed, reparented, total_rows: input.regions.length },
    impact_summary: { historical_snapshots_on_active: impactedSnapshots },
  };
}

async function notifyActiveAdminsOfRegionChange(
  db: DB,
  template: "region.dataset_published" | "region.dataset_rolled_back",
  versionId: string,
  versionCode: string,
) {
  const admins = (
    await db.query<{ user_id: string }>(
      `select distinct sr.user_id
       from staff_roles sr join users u on u.id = sr.user_id
       where sr.role in ('super_admin', 'warehouse_admin') and u.status = 'active'`,
    )
  ).rows;
  for (const a of admins) {
    await db.query(
      `insert into notifications(id, user_id, template, locale, payload, dedupe_key)
       values($1, $2, $3, 'zh-CN', $4::jsonb, $5)
       on conflict (dedupe_key) do nothing`,
      [uuid(), a.user_id, template, JSON.stringify({ version_id: versionId, version_code: versionCode }), `${template}:${versionId}:${a.user_id}`],
    );
  }
}

export async function publishRegionDatasetVersion(
  db: DB,
  actor: Actor,
  versionId: string,
  reason: string,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "region_dataset_active");

  const draft = await one<{ id: string; version_code: string; status: string; created_by: string | null }>(
    db,
    "select id, version_code, status, created_by from region_dataset_versions where id = $1 for update",
    [versionId],
  );
  guard(draft.status === "staged", "VERSION_NOT_STAGED", `Version status '${draft.status}' cannot be published.`, 409);
  guard(
    !draft.created_by || draft.created_by !== actor.id,
    "SELF_REVIEW_FORBIDDEN",
    "Dataset draft importer cannot self-approve publication.",
    403,
  );

  await db.query(
    "update region_dataset_versions set status = 'superseded' where status = 'active' and id <> $1",
    [versionId],
  );
  const activated = await one(
    db,
    `update region_dataset_versions
     set status = 'active', approved_by = $2, activated_at = now()
     where id = $1
     returning id, version_code, status, approved_by, activated_at`,
    [versionId, actor.id],
  );

  await db.query(
    "insert into region_import_runs(id, version_id, mode, status, summary, started_by) values($1, $2, 'publish', 'succeeded', $3::jsonb, $4)",
    [uuid(), versionId, JSON.stringify({ reason }), actor.id],
  );
  await notifyActiveAdminsOfRegionChange(db, "region.dataset_published", versionId, draft.version_code);
  await event(db, "region.dataset_published", { version_id: versionId, version_code: draft.version_code, approved_by: actor.id });
  await audit(db, actor, "publish_region_dataset", "region_dataset_versions", versionId, {
    version_code: draft.version_code,
    reason,
  });

  return activated;
}

export async function rollbackRegionDatasetVersion(
  db: DB,
  actor: Actor,
  targetVersionId: string,
  reason: string,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "region_dataset_active");

  const target = await one<{ id: string; version_code: string; status: string }>(
    db,
    "select id, version_code, status from region_dataset_versions where id = $1 for update",
    [targetVersionId],
  );
  guard(
    target.status === "superseded" || target.status === "rolled_back",
    "ROLLBACK_TARGET_INVALID",
    "Can only roll back to a previously published region dataset version.",
    409,
  );

  await db.query(
    "update region_dataset_versions set status = 'rolled_back' where status = 'active' and id <> $1",
    [targetVersionId],
  );
  const restored = await one(
    db,
    `update region_dataset_versions
     set status = 'active', approved_by = $2, activated_at = now()
     where id = $1
     returning id, version_code, status, approved_by, activated_at`,
    [targetVersionId, actor.id],
  );

  await db.query(
    "insert into region_import_runs(id, version_id, mode, status, summary, started_by) values($1, $2, 'rollback', 'succeeded', $3::jsonb, $4)",
    [uuid(), targetVersionId, JSON.stringify({ reason }), actor.id],
  );
  await notifyActiveAdminsOfRegionChange(db, "region.dataset_rolled_back", targetVersionId, target.version_code);
  await event(db, "region.dataset_rolled_back", { version_id: targetVersionId, version_code: target.version_code });
  await audit(db, actor, "rollback_region_dataset", "region_dataset_versions", targetVersionId, {
    version_code: target.version_code,
    reason,
  });

  return restored;
}

export async function createRegionAlias(
  db: DB,
  actor: Actor,
  input: z.infer<typeof regionAliasCreateSchema>,
  sessionHash: string,
) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const existsRegion = (
    await db.query("select 1 from regions where stable_region_key = $1 limit 1", [input.stable_region_key])
  ).rowCount;
  guard(existsRegion, "REGION_NOT_FOUND", `Region key '${input.stable_region_key}' does not exist.`, 404);

  const id = uuid();
  const row = await one(
    db,
    `insert into region_aliases(id, stable_region_key, alias_text, alias_kind, locale, status, source_note, created_by, approved_by)
     values($1, $2, $3, $4, $5, 'active', $6, $7, $7)
     returning *`,
    [id, input.stable_region_key, input.alias_text, input.alias_kind, input.locale, input.source_note ?? null, actor.id],
  );
  await audit(db, actor, "create_region_alias", "region_aliases", id, {
    stable_region_key: input.stable_region_key,
    alias_text: input.alias_text,
    alias_kind: input.alias_kind,
  });
  return row;
}

export async function revokeRegionAlias(db: DB, actor: Actor, aliasId: string, sessionHash: string) {
  role(actor, "super_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  const row = await one(
    db,
    "update region_aliases set status = 'revoked' where id = $1 returning id, stable_region_key, alias_text, status",
    [aliasId],
  );
  await audit(db, actor, "revoke_region_alias", "region_aliases", aliasId, {});
  return row;
}
