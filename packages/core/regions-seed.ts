import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DB } from "../db";
import { lock, uuid } from "./common";

const require = createRequire(import.meta.url);

export interface RawPccRow {
  code: string;
  name: string;
  province: string;
  city: string | number;
  area: string | number;
  town: string | number;
}

export interface NormalizedRegionRow {
  id: string;
  stableRegionKey: string;
  codeSystem: "mca_gbt2260" | "mca_township";
  officialCode: string;
  level: "province" | "prefecture" | "county" | "township";
  adminType: string;
  nameZh: string;
  shortNameZh: string;
  nameEn: string;
  pinyin: string;
  parentId: string | null;
  marketScope: "cn_mainland" | "hk_mo_tw";
  isTerminalOfficial: boolean;
}

const TERMINAL_PREFECTURE_CODES = new Set(["441900", "442000", "460400", "620200"]);
const HK_MO_TW_PROVINCE_PREFIXES = new Set(["71", "81", "82"]);
const SYNTHETIC_CITY_RE = /(?:省直辖县级行政区划|自治区直辖县级行政区划|^市辖区$|^县$)/;

const KNOWN_EN_NAMES: Record<string, { en: string; pinyin: string; short?: string }> = {
  "110000": { en: "Beijing", pinyin: "Beijing", short: "北京" },
  "120000": { en: "Tianjin", pinyin: "Tianjin", short: "天津" },
  "130000": { en: "Hebei Province", pinyin: "Hebei", short: "河北" },
  "140000": { en: "Shanxi Province", pinyin: "Shanxi", short: "山西" },
  "150000": { en: "Inner Mongolia Autonomous Region", pinyin: "Neimenggu", short: "内蒙古" },
  "210000": { en: "Liaoning Province", pinyin: "Liaoning", short: "辽宁" },
  "220000": { en: "Jilin Province", pinyin: "Jilin", short: "吉林" },
  "230000": { en: "Heilongjiang Province", pinyin: "Heilongjiang", short: "黑龙江" },
  "310000": { en: "Shanghai", pinyin: "Shanghai", short: "上海" },
  "320000": { en: "Jiangsu Province", pinyin: "Jiangsu", short: "江苏" },
  "330000": { en: "Zhejiang Province", pinyin: "Zhejiang", short: "浙江" },
  "340000": { en: "Anhui Province", pinyin: "Anhui", short: "安徽" },
  "350000": { en: "Fujian Province", pinyin: "Fujian", short: "福建" },
  "360000": { en: "Jiangxi Province", pinyin: "Jiangxi", short: "江西" },
  "370000": { en: "Shandong Province", pinyin: "Shandong", short: "山东" },
  "410000": { en: "Henan Province", pinyin: "Henan", short: "河南" },
  "420000": { en: "Hubei Province", pinyin: "Hubei", short: "湖北" },
  "430000": { en: "Hunan Province", pinyin: "Hunan", short: "湖南" },
  "440000": { en: "Guangdong Province", pinyin: "Guangdong", short: "广东" },
  "450000": { en: "Guangxi Zhuang Autonomous Region", pinyin: "Guangxi", short: "广西" },
  "460000": { en: "Hainan Province", pinyin: "Hainan", short: "海南" },
  "500000": { en: "Chongqing", pinyin: "Chongqing", short: "重庆" },
  "510000": { en: "Sichuan Province", pinyin: "Sichuan", short: "四川" },
  "520000": { en: "Guizhou Province", pinyin: "Guizhou", short: "贵州" },
  "530000": { en: "Yunnan Province", pinyin: "Yunnan", short: "云南" },
  "540000": { en: "Tibet Autonomous Region", pinyin: "Xizang", short: "西藏" },
  "610000": { en: "Shaanxi Province", pinyin: "Shaanxi", short: "陕西" },
  "620000": { en: "Gansu Province", pinyin: "Gansu", short: "甘肃" },
  "630000": { en: "Qinghai Province", pinyin: "Qinghai", short: "青海" },
  "640000": { en: "Ningxia Hui Autonomous Region", pinyin: "Ningxia", short: "宁夏" },
  "650000": { en: "Xinjiang Uygur Autonomous Region", pinyin: "Xinjiang", short: "新疆" },
  "710000": { en: "Taiwan", pinyin: "Taiwan", short: "台湾" },
  "810000": { en: "Hong Kong SAR", pinyin: "Xianggang", short: "香港" },
  "820000": { en: "Macau SAR", pinyin: "Aomen", short: "澳门" },
  // Key logistics, sourcing & municipality cities/districts
  "440100": { en: "Guangzhou", pinyin: "Guangzhou", short: "广州" },
  "440300": { en: "Shenzhen", pinyin: "Shenzhen", short: "深圳" },
  "440400": { en: "Zhuhai", pinyin: "Zhuhai", short: "珠海" },
  "440600": { en: "Foshan", pinyin: "Foshan", short: "佛山" },
  "441300": { en: "Huizhou", pinyin: "Huizhou", short: "惠州" },
  "441900": { en: "Dongguan", pinyin: "Dongguan", short: "东莞" },
  "442000": { en: "Zhongshan", pinyin: "Zhongshan", short: "中山" },
  "330100": { en: "Hangzhou", pinyin: "Hangzhou", short: "杭州" },
  "330200": { en: "Ningbo", pinyin: "Ningbo", short: "宁波" },
  "330700": { en: "Jinhua", pinyin: "Jinhua", short: "金华" },
  "320100": { en: "Nanjing", pinyin: "Nanjing", short: "南京" },
  "320500": { en: "Suzhou", pinyin: "Suzhou", short: "苏州" },
  "350100": { en: "Fuzhou", pinyin: "Fuzhou", short: "福州" },
  "350200": { en: "Xiamen", pinyin: "Xiamen", short: "厦门" },
  "350500": { en: "Quanzhou", pinyin: "Quanzhou", short: "泉州" },
  "370200": { en: "Qingdao", pinyin: "Qingdao", short: "青岛" },
  "410100": { en: "Zhengzhou", pinyin: "Zhengzhou", short: "郑州" },
  "420100": { en: "Wuhan", pinyin: "Wuhan", short: "武汉" },
  "430100": { en: "Changsha", pinyin: "Changsha", short: "长沙" },
  "510100": { en: "Chengdu", pinyin: "Chengdu", short: "成都" },
  "610100": { en: "Xi'an", pinyin: "Xian", short: "西安" },
  "440304": { en: "Futian District", pinyin: "Futian" },
  "440305": { en: "Nanshan District", pinyin: "Nanshan" },
  "440306": { en: "Bao'an District", pinyin: "Baoan" },
  "440307": { en: "Longgang District", pinyin: "Longgang" },
  "440309": { en: "Longhua District", pinyin: "Longhua" },
  "440106": { en: "Tianhe District", pinyin: "Tianhe" },
  "440111": { en: "Baiyun District", pinyin: "Baiyun" },
  "440113": { en: "Panyu District", pinyin: "Panyu" },
  "330782": { en: "Yiwu City", pinyin: "Yiwu", short: "义乌" },
  "330603": { en: "Keqiao District", pinyin: "Keqiao", short: "柯桥" },
  "110105": { en: "Chaoyang District", pinyin: "Chaoyang" },
  "220104": { en: "Chaoyang District", pinyin: "Chaoyang" },
  "320106": { en: "Gulou District", pinyin: "Gulou" },
  "350102": { en: "Gulou District", pinyin: "Gulou" },
};

const PRESET_ALIASES: Array<{
  stableRegionKey: string;
  aliasText: string;
  aliasKind: "short_name" | "historical_name" | "pinyin" | "english" | "traditional_zh" | "logistics_park";
  sourceNote: string;
}> = [
  { stableRegionKey: "mca_gbt2260:110000", aliasText: "京", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:120000", aliasText: "津", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:310000", aliasText: "沪", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:320000", aliasText: "苏", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:330000", aliasText: "浙", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:350000", aliasText: "闽", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:370000", aliasText: "鲁", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:410000", aliasText: "豫", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:420000", aliasText: "鄂", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:430000", aliasText: "湘", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:440000", aliasText: "粤", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:500000", aliasText: "渝", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:510000", aliasText: "川", aliasKind: "short_name", sourceNote: "Standard CN abbreviation" },
  { stableRegionKey: "mca_gbt2260:440100", aliasText: "穗", aliasKind: "short_name", sourceNote: "Standard city abbreviation" },
  { stableRegionKey: "mca_gbt2260:440100", aliasText: "廣州", aliasKind: "traditional_zh", sourceNote: "Traditional Chinese" },
  { stableRegionKey: "mca_gbt2260:440300", aliasText: "深", aliasKind: "short_name", sourceNote: "Standard city abbreviation" },
  { stableRegionKey: "mca_gbt2260:440300", aliasText: "鵬城", aliasKind: "short_name", sourceNote: "Common logistics alias" },
  { stableRegionKey: "mca_gbt2260:440111", aliasText: "嘉禾物流园", aliasKind: "logistics_park", sourceNote: "Guangzhou Baiyun logistics park mapping" },
  { stableRegionKey: "mca_gbt2260:330782", aliasText: "义乌国际商贸城", aliasKind: "logistics_park", sourceNote: "Yiwu wholesale hub mapping" },
  { stableRegionKey: "mca_gbt2260:440306", aliasText: "宝安县", aliasKind: "historical_name", sourceNote: "Historical pre-1992 county name" },
  { stableRegionKey: "mca_gbt2260:110101", aliasText: "崇文区", aliasKind: "historical_name", sourceNote: "Merged into Dongcheng District in 2010" },
  { stableRegionKey: "mca_gbt2260:110102", aliasText: "宣武区", aliasKind: "historical_name", sourceNote: "Merged into Xicheng District in 2010" },
  { stableRegionKey: "mca_gbt2260:310106", aliasText: "闸北区", aliasKind: "historical_name", sourceNote: "Merged into Jing'an District in 2015" },
  { stableRegionKey: "mca_township:659001100000", aliasText: "石北泉镇", aliasKind: "short_name", sourceNote: "PCC 9.0.0 deduped alternate township spelling" },
  { stableRegionKey: "mca_township:659001100000", aliasText: "石总场北泉镇", aliasKind: "short_name", sourceNote: "PCC 9.0.0 deduped alternate township spelling" },
];

export const ACTIVE_REGION_DATASET_VERSION_CODE = "mca-pcc-2026.10";

export function stripAdminSuffix(name: string, level: NormalizedRegionRow["level"]): string {
  if (level === "province") {
    const stripped = name.replace(/(?:维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区|省|市)$/, "");
    return stripped.length >= 2 ? stripped : name;
  }
  if (level === "prefecture") {
    const stripped = name.replace(/(?:自治州|地区|盟|市)$/, "");
    return stripped.length >= 2 ? stripped : name;
  }
  if (level === "county") {
    if (name.length <= 2) return name;
    const stripped = name.replace(/(?:自治县|自治旗|林区|特区|堂区|新区|市|区|县|旗)$/, "");
    return stripped.length >= 2 ? stripped : name;
  }
  if (name.length <= 2) return name;
  const stripped = name.replace(/(?:街道办事处|街道|苏木|镇|乡)$/, "");
  return stripped.length >= 2 ? stripped : name;
}

function classifyAdminType(name: string, level: NormalizedRegionRow["level"]): string {
  if (level === "province") {
    if (/^(?:北京市|天津市|上海市|重庆市)$/.test(name)) return "municipality";
    if (name.endsWith("特别行政区")) return "sar";
    if (name.endsWith("自治区")) return "autonomous_region";
    return "province";
  }
  if (level === "prefecture") {
    if (name.endsWith("自治州")) return "autonomous_prefecture";
    if (name.endsWith("盟")) return "league";
    if (name.endsWith("地区")) return "prefecture";
    return "prefecture_city";
  }
  if (level === "county") {
    if (name.endsWith("自治县")) return "autonomous_county";
    if (name.endsWith("自治旗")) return "autonomous_banner";
    if (name.endsWith("旗")) return "banner";
    if (name.endsWith("林区")) return "forestry_district";
    if (name.endsWith("特区")) return "special_district";
    if (name.endsWith("区") || name.endsWith("堂区")) return "district";
    if (name.endsWith("市")) return "county_city";
    return "county";
  }
  if (name.includes("街道")) return "subdistrict";
  if (name.endsWith("镇")) return "town";
  if (name.endsWith("苏木")) return "sumu";
  return "township";
}

export function loadNormalizedPccDataset() {
  const dataPath = require.resolve("@province-city-china/data/data.json");
  const rawBuf = readFileSync(dataPath);
  const sourceSha256 = createHash("sha256").update(rawBuf).digest("hex");
  const rawRows = JSON.parse(rawBuf.toString("utf8")) as RawPccRow[];

  const provinces: NormalizedRegionRow[] = [];
  const prefectures: NormalizedRegionRow[] = [];
  const counties: NormalizedRegionRow[] = [];
  const townships: NormalizedRegionRow[] = [];

  const provinceIdByCode = new Map<string, string>();
  const prefectureIdByCode = new Map<string, string>();
  const countyIdByCode = new Map<string, string>();
  const seenTownCodes = new Set<string>();

  for (const r of rawRows) {
    if (r.town === 0 && r.area === 0 && r.city === 0) {
      const id = uuid();
      const meta = KNOWN_EN_NAMES[r.code];
      const marketScope = HK_MO_TW_PROVINCE_PREFIXES.has(r.province) ? "hk_mo_tw" : "cn_mainland";
      provinceIdByCode.set(r.code, id);
      provinces.push({
        id,
        stableRegionKey: `mca_gbt2260:${r.code}`,
        codeSystem: "mca_gbt2260",
        officialCode: r.code,
        level: "province",
        adminType: classifyAdminType(r.name, "province"),
        nameZh: r.name,
        shortNameZh: meta?.short ?? stripAdminSuffix(r.name, "province"),
        nameEn: meta?.en ?? r.name,
        pinyin: meta?.pinyin ?? r.code,
        parentId: null,
        marketScope,
        isTerminalOfficial: r.code === "710000",
      });
    }
  }

  for (const r of rawRows) {
    if (r.town === 0 && r.area === 0 && r.city !== 0) {
      if (SYNTHETIC_CITY_RE.test(r.name) || r.code.endsWith("9000")) continue;
      const parentId = provinceIdByCode.get(`${r.province}0000`) ?? null;
      const id = uuid();
      const meta = KNOWN_EN_NAMES[r.code];
      const marketScope = HK_MO_TW_PROVINCE_PREFIXES.has(r.province) ? "hk_mo_tw" : "cn_mainland";
      prefectureIdByCode.set(r.code, id);
      prefectures.push({
        id,
        stableRegionKey: `mca_gbt2260:${r.code}`,
        codeSystem: "mca_gbt2260",
        officialCode: r.code,
        level: "prefecture",
        adminType: classifyAdminType(r.name, "prefecture"),
        nameZh: r.name,
        shortNameZh: meta?.short ?? stripAdminSuffix(r.name, "prefecture"),
        nameEn: meta?.en ?? r.name,
        pinyin: meta?.pinyin ?? r.code,
        parentId,
        marketScope,
        isTerminalOfficial: TERMINAL_PREFECTURE_CODES.has(r.code),
      });
    }
  }

  for (const r of rawRows) {
    if (r.town === 0 && r.area !== 0) {
      const cityCode = `${r.province}${String(r.city).padStart(2, "0")}00`;
      const provCode = `${r.province}0000`;
      // Municipalities and province-direct counties attach directly to province when real prefecture is absent.
      const parentId = prefectureIdByCode.get(cityCode) ?? provinceIdByCode.get(provCode) ?? null;
      const id = uuid();
      const meta = KNOWN_EN_NAMES[r.code];
      const marketScope = HK_MO_TW_PROVINCE_PREFIXES.has(r.province) ? "hk_mo_tw" : "cn_mainland";
      countyIdByCode.set(r.code, id);
      counties.push({
        id,
        stableRegionKey: `mca_gbt2260:${r.code}`,
        codeSystem: "mca_gbt2260",
        officialCode: r.code,
        level: "county",
        adminType: classifyAdminType(r.name, "county"),
        nameZh: r.name,
        shortNameZh: meta?.short ?? stripAdminSuffix(r.name, "county"),
        nameEn: meta?.en ?? r.name,
        pinyin: meta?.pinyin ?? r.code,
        parentId,
        marketScope,
        isTerminalOfficial: true,
      });
    }
  }

  for (const r of rawRows) {
    if (r.town !== 0) {
      const townCode = `${r.code}${String(r.town).padStart(6, "0")}`;
      if (seenTownCodes.has(townCode)) continue;
      seenTownCodes.add(townCode);
      const parentId = countyIdByCode.get(r.code) ?? prefectureIdByCode.get(r.code) ?? provinceIdByCode.get(r.code) ?? null;
      const marketScope = HK_MO_TW_PROVINCE_PREFIXES.has(r.province) ? "hk_mo_tw" : "cn_mainland";
      townships.push({
        id: uuid(),
        stableRegionKey: `mca_township:${townCode}`,
        codeSystem: "mca_township",
        officialCode: townCode,
        level: "township",
        adminType: classifyAdminType(r.name, "township"),
        nameZh: r.name,
        shortNameZh: stripAdminSuffix(r.name, "township"),
        nameEn: r.name,
        pinyin: townCode,
        parentId,
        marketScope,
        isTerminalOfficial: true,
      });
    }
  }

  return {
    sourceSha256,
    provinces,
    prefectures,
    counties,
    townships,
  };
}

async function bulkInsertRegions(db: DB, versionId: string, rows: NormalizedRegionRow[]) {
  const BATCH = 5000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await db.query(
      `insert into regions(
         id, stable_region_key, version_id, code_system, official_code,
         level, admin_type, name_zh, short_name_zh, name_en, pinyin,
         parent_id, market_scope, is_terminal_official, status
       )
       select
         t.id, t.stable_region_key, $1::uuid, t.code_system, t.official_code,
         t.level, t.admin_type, t.name_zh, t.short_name_zh, t.name_en, t.pinyin,
         t.parent_id, t.market_scope, t.is_terminal_official, 'active'
       from unnest(
         $2::uuid[], $3::text[], $4::text[], $5::text[],
         $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
         $12::uuid[], $13::text[], $14::boolean[]
       ) as t(
         id, stable_region_key, code_system, official_code,
         level, admin_type, name_zh, short_name_zh, name_en, pinyin,
         parent_id, market_scope, is_terminal_official
       )`,
      [
        versionId,
        chunk.map((r) => r.id),
        chunk.map((r) => r.stableRegionKey),
        chunk.map((r) => r.codeSystem),
        chunk.map((r) => r.officialCode),
        chunk.map((r) => r.level),
        chunk.map((r) => r.adminType),
        chunk.map((r) => r.nameZh),
        chunk.map((r) => r.shortNameZh),
        chunk.map((r) => r.nameEn),
        chunk.map((r) => r.pinyin),
        chunk.map((r) => r.parentId),
        chunk.map((r) => r.marketScope),
        chunk.map((r) => r.isTerminalOfficial),
      ],
    );
  }
}

export async function seedAuthoritativeChinaRegions(
  db: DB,
  options?: { includeTownships?: boolean; startedByUserId?: string | null },
) {
  await lock(db, "region_dataset_seed");
  const existingDataset = (
    await db.query<{ id: string; status: string }>(
      "select id, status from region_dataset_versions where version_code = $1",
      [ACTIVE_REGION_DATASET_VERSION_CODE],
    )
  ).rows[0];

  for (const a of PRESET_ALIASES) {
    await db.query(
      `insert into region_aliases(id, stable_region_key, alias_text, alias_kind, locale, status, source_note)
       values($1, $2, $3, $4, 'zh-CN', 'active', $5)
       on conflict (stable_region_key, alias_text, alias_kind) do nothing`,
      [uuid(), a.stableRegionKey, a.aliasText, a.aliasKind, a.sourceNote],
    );
  }

  if (existingDataset) {
    return { skipped: true as const, version_id: existingDataset.id, status: existingDataset.status };
  }

  const dataset = loadNormalizedPccDataset();
  const includeTownships = options?.includeTownships ?? true;
  const activeCount = (
    await db.query<{ id: string }>("select id from region_dataset_versions where status = 'active' limit 1")
  ).rowCount;
  const initialStatus = activeCount ? "staged" : "active";
  const versionId = uuid();

  await db.query(
    `insert into region_dataset_versions(
       id, version_code, source_name, source_url, license, data_as_of, source_sha256, status,
       province_count, prefecture_count, county_count, township_count,
       diff_summary, impact_summary, created_by, approved_by, activated_at
     ) values(
       $1, $2, $3, $4, 'MIT', '2026-10-09', $5, $6,
       $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $13,
       case when $6 = 'active' then now() else null end
     )`,
    [
      versionId,
      ACTIVE_REGION_DATASET_VERSION_CODE,
      "@province-city-china/data@9.0.0 (GB/T 2260 + township layer)",
      "https://github.com/uiwjs/province-city-china",
      dataset.sourceSha256,
      initialStatus,
      dataset.provinces.length,
      dataset.prefectures.length,
      dataset.counties.length,
      includeTownships ? dataset.townships.length : 0,
      JSON.stringify({ mode: "initial_seed", mainland_provinces: 31 }),
      JSON.stringify({ address_snapshots_affected: 0, warehouse_addresses_affected: 0 }),
      options?.startedByUserId ?? null,
    ],
  );

  await bulkInsertRegions(db, versionId, dataset.provinces);
  await bulkInsertRegions(db, versionId, dataset.prefectures);
  await bulkInsertRegions(db, versionId, dataset.counties);
  if (includeTownships) {
    await bulkInsertRegions(db, versionId, dataset.townships);
  }

  await db.query(
    `insert into region_import_runs(id, version_id, mode, status, summary, started_by)
     values($1, $2, 'seed', 'succeeded', $3::jsonb, $4)`,
    [
      uuid(),
      versionId,
      JSON.stringify({
        provinces: dataset.provinces.length,
        prefectures: dataset.prefectures.length,
        counties: dataset.counties.length,
        townships: includeTownships ? dataset.townships.length : 0,
        status: initialStatus,
      }),
      options?.startedByUserId ?? null,
    ],
  );

  return {
    skipped: false as const,
    version_id: versionId,
    version_code: ACTIVE_REGION_DATASET_VERSION_CODE,
    status: initialStatus,
    counts: {
      provinces: dataset.provinces.length,
      prefectures: dataset.prefectures.length,
      counties: dataset.counties.length,
      townships: includeTownships ? dataset.townships.length : 0,
    },
  };
}
