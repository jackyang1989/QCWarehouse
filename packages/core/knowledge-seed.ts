import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, lock, role, type Actor } from "./common";

export const KNOWLEDGE_SEED_VERSION = "2026-11-apparel-v2";

export type SeedComplexityLevel = {
  code: "L1" | "L2" | "L3" | "L4" | "L5";
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  suggested_base_price_cents: number | null;
  pricing_mode: "fixed_draft" | "manual_quote";
  adjustment_factors: { code: string; label_zh: string; label_en: string; effect_note: string }[];
  sort_order: number;
};

export const SEED_COMPLEXITY_LEVELS: readonly SeedComplexityLevel[] = [
  {
    code: "L1",
    name_zh: "基础款（建议预置 $5/件）",
    name_en: "Basic Tier (Draft $5/piece)",
    description_zh: "结构简单、单层无里布的基础服装，如T恤、背心、打底衫、运动上衣、紧身上衣、短裤、瑜伽裤、紧身裤、内裤等。初始建议预置价为未经商业审批的知识库草稿。",
    description_en: "Single-layer basic garments such as tees, tanks, base layers, athletic tops, shorts, yoga pants, leggings, and underwear. Initial $5 draft requires formal commercial approval.",
    suggested_base_price_cents: 500,
    pricing_mode: "fixed_draft",
    adjustment_factors: [
      { code: "simple_single_layer", label_zh: "单层常规结构", label_en: "Single-layer standard construction", effect_note: "L1 draft baseline $5" },
    ],
    sort_order: 1,
  },
  {
    code: "L2",
    name_zh: "常规款（建议预置 $8/件）",
    name_en: "Standard Tier (Draft $8/piece)",
    description_zh: "含领口/门襟/裤腰/拉链/贴身的日常常规款，如Polo衫、衬衫、雪纺衫、针织衫、毛衣、开衫、卫衣、连帽卫衣、牛仔裤、西裤、休闲长裤、泳装、文胸、塑身衣、童装、婴幼儿服装等。",
    description_en: "Everyday structured garments with plackets, collars, waistbands, zippers, knit/woven seams, swimwear, bras, shapewear, or kids wear. Initial $8 draft requires commercial approval.",
    suggested_base_price_cents: 800,
    pricing_mode: "fixed_draft",
    adjustment_factors: [
      { code: "standard_trim_hardware", label_zh: "含门襟/拉链/口袋等常规辅料", label_en: "Includes placket, zipper, buttons, or multi-pocket construction", effect_note: "L2 draft baseline $8" },
    ],
    sort_order: 2,
  },
  {
    code: "L3",
    name_zh: "中高复杂款（建议预置 $12/件）",
    name_en: "Mid-Complex Tier (Draft $12/piece)",
    description_zh: "含里布、百褶工艺、连体或两件组合结构及常规外套，如连衣裙、连体裤、两件套、运动/瑜伽/睡衣套装、薄夹克、牛仔外套、棒球服、风衣、西装外套、工装裤、百褶裙等。",
    description_en: "Garments featuring lining, pleats, jumpsuits, coordinated 2-piece sets, or light/tailored jackets and trench coats. Initial $12 draft requires commercial approval.",
    suggested_base_price_cents: 1200,
    pricing_mode: "fixed_draft",
    adjustment_factors: [
      { code: "lining_layers_pockets", label_zh: "层数/里布/口袋及拼接结构", label_en: "Layers, lining, pocket count, and seam complexity", effect_note: "L3 draft baseline $12" },
    ],
    sort_order: 3,
  },
  {
    code: "L4",
    name_zh: "高复杂款（建议预置 $18/件）",
    name_en: "High-Complex Tier (Draft $18/piece)",
    description_zh: "厚重棉服、羽绒服、厚大衣、多层外套、带可拆卸部件外套及多件组合服装，需翻面、防钻绒及多部件拆合检验。初始 $18 仅为草稿建议值。",
    description_en: "Heavy padded/down jackets, overcoats, multi-layer jackets, detachable-component jackets, and multi-piece garment bundles. Initial $18 draft requires commercial approval.",
    suggested_base_price_cents: 1800,
    pricing_mode: "fixed_draft",
    adjustment_factors: [
      { code: "down_detachable_multilayer", label_zh: "羽绒防钻绒/可拆卸部件/翻面工时", label_en: "Down leakage, detachable components, inside-out handling", effect_note: "L4 draft baseline $18" },
    ],
    sort_order: 4,
  },
  {
    code: "L5",
    name_zh: "特殊复杂款（默认人工报价）",
    name_en: "Special Complex Tier (Manual Quote)",
    description_zh: "礼服、婚纱、复杂刺绣服装、特殊装饰服装、特殊材料服装及非标要求，默认必须人工报价并审核仓端作业能力。",
    description_en: "Evening gowns, wedding dresses, heavy embroidery, special embellishments, special delicate materials, requiring manual quote & capability review.",
    suggested_base_price_cents: null,
    pricing_mode: "manual_quote",
    adjustment_factors: [
      { code: "manual_engineering_quote", label_zh: "人工工时、特殊摆放拍摄与能力评估", label_en: "Manual工时 (labor time), special handling & capability assessment", effect_note: "Manual quote required" },
    ],
    sort_order: 5,
  },
];

export type SeedInspectionModule = {
  code: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  module_tier: "base_included" | "optional_addon" | "manual_quote";
  billing_unit: "included_in_base" | "per_piece" | "per_order" | "per_item_batch" | "manual_quote";
  suggested_price_cents: number | null;
  pricing_tiers: Record<string, unknown>;
  depends_on_codes: string[];
  conflicts_with_codes: string[];
  requires_capability_codes: string[];
  scope_boundary_zh: string;
  scope_boundary_en: string;
  is_destructive_possible: boolean;
  requires_customer_authorization: boolean;
  sort_order: number;
};

// Strictly aligned with §05 (M01-M11) & §43.2 draft pricing examples
export const SEED_INSPECTION_MODULES: readonly SeedInspectionModule[] = [
  {
    code: "M01",
    name_zh: "基础外观与做工检查",
    name_en: "Base Appearance & Workmanship Check",
    description_zh: "整体外观、明显污渍、破损孔洞、表面异常、脱线、线头、跳针、开线爆缝、明显左右不对称、明显变形、商品身份/款式/颜色/尺码标签基础核对及缺陷必要拍照（按 L1=$5/L2=$8/L3=$12/L4=$18/L5人工 计价，基础项不得通过附加模块重复收费）。",
    description_en: "Overall appearance, stains, holes, surface flaws, skipped stitches, open seams, symmetry, basic label/SKU verification, and mandatory defect photos (base tier by L1=$5..L4=$18/L5 quote; never double-billed).",
    module_tier: "base_included",
    billing_unit: "per_piece",
    suggested_price_cents: 500,
    pricing_tiers: { l1_cents: 500, l2_cents: 800, l3_cents: 1200, l4_cents: 1800, l5_mode: "manual_quote" },
    depends_on_codes: [],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "逐件全检客观外观核查（非 AQL 整批抽检放行）；不包含完整缝线密度测试、尺寸测量或实验室测试。",
    scope_boundary_en: "100% piece-by-piece visual inspection (NOT statistical AQL sampling); excludes seam density lab tests, POM measurement, or material labs.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 1,
  },
  {
    code: "M02",
    name_zh: "尺寸测量（3点/5点/8点/全量/自定义）",
    name_en: "Dimension Measurement (3/5/8-Pt / Full / Custom POM)",
    description_zh: "支持3点关键尺寸($8起)、5点标准($12起)、8点详细($18起)、额外点位($3/点起)、单位换算及公差对照，须使用品类动态测量图谱。",
    description_en: "Supports 3-point ($8 draft), 5-point ($12 draft), 8-point ($18 draft), extra POM ($3/pt draft), unit lock, and tolerance comparison via category POM diagrams.",
    module_tier: "optional_addon",
    billing_unit: "per_piece",
    suggested_price_cents: 800,
    pricing_tiers: { points_3_cents: 800, points_5_cents: 1200, points_8_cents: 1800, extra_point_cents: 300 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: ["measurement_tool"],
    scope_boundary_zh: "成衣平铺人工量测受面料弹性与摆放张力影响，不允许对所有服装套用固定同一测量点集合。",
    scope_boundary_en: "Manual flat-lay garment measurement reflects relaxed state under recorded bench conditions; POM sets vary strictly by garment type.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 2,
  },
  {
    code: "M03",
    name_zh: "颜色检查与参考对比",
    name_en: "Color Check & Reference Comparison",
    description_zh: "客户声明颜色核对、同SKU件间一致性、与确认样视觉颜色对比、主辅拼色及左右部件/批次色差观察（建议 $5/件起）。",
    description_en: "Customer color verification, intra-SKU shade consistency, golden-sample visual match, main vs trim shading, and panel/batch shade variance ($5/piece draft).",
    module_tier: "optional_addon",
    billing_unit: "per_piece",
    suggested_price_cents: 500,
    pricing_tiers: { default_per_piece_cents: 500 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "未配置经验证的标准光源箱、灰卡或色差仪能力时，严禁承诺客观色差等级、精确 Delta E 数值或实验室颜色测定。",
    scope_boundary_en: "Without calibrated light-booth, grey-scale, or spectrophotometer capabilities, NEVER promise Delta E values or lab color ratings.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 3,
  },
  {
    code: "M04",
    name_zh: "面料外观及手感检查",
    name_en: "Fabric Appearance & Handfeel Check",
    description_zh: "面料外观、表面纹理、织法观察、粗细厚薄感、手感对比、毛羽及明显起球、与确认样手感比对及标签标注成分文本核对（建议 $7/件起）。",
    description_en: "Fabric surface texture, weave observation, thickness/handfeel comparison, fuzzing/pilling, reference match, and label fiber text check ($7/piece draft).",
    module_tier: "optional_addon",
    billing_unit: "per_piece",
    suggested_price_cents: 700,
    pricing_tiers: { default_per_piece_cents: 700 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "明确声明：核对标签标注纤维成分文本绝不代表实验室验证真实纤维含量。",
    scope_boundary_en: "EXPLICIT BOUNDARY: Label fiber text check does NOT verify true laboratory fiber composition.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 4,
  },
  {
    code: "M05",
    name_zh: "重量及面料克重（整衣称重 $2 / 破坏性GSM $12）",
    name_en: "Garment Weight ($2/pc) & Fabric GSM ($12/cut)",
    description_zh: "区分整件成品服装实称重量（建议 $2/件起）与圆盘破坏性面料 GSM 测定（建议 $12/次起或人工报价）。",
    description_en: "Strictly separates finished garment gross weight ($2/piece draft) from destructive circular-cutter fabric GSM ($12/cut draft or manual quote).",
    module_tier: "optional_addon",
    billing_unit: "per_piece",
    suggested_price_cents: 200,
    pricing_tiers: { garment_weight_cents: 200, fabric_gsm_destructive_cents: 1200 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: ["calibrated_scale"],
    scope_boundary_zh: "严禁把整衣实称克重(g)换算为面料克重(GSM)；未经客户明确破坏性授权及合格圆盘取样能力严禁裁剪样品。",
    scope_boundary_en: "NEVER convert garment gross weight (g) to fabric GSM (g/m²); destructive GSM requires explicit customer authorization & fabric_gsm_cutter capability.",
    is_destructive_possible: true,
    requires_customer_authorization: true,
    sort_order: 5,
  },
  {
    code: "M06",
    name_zh: "辅料及功能检查",
    name_en: "Trims, Hardware & Functional Testing",
    description_zh: "拉链、纽扣、按扣、魔术贴、抽绳、松紧带、调节扣、肩带、挂钩、金属装饰及可拆卸部件专项核查（辅料 $5/件起；功能测试 $5/测试组起）。",
    description_en: "Zippers, buttons, snaps, Velcro, drawcords, elastic, adjusters, straps, hooks, metal trims & detachable parts ($5/piece trims; $5/test-group functional).",
    module_tier: "optional_addon",
    billing_unit: "per_piece",
    suggested_price_cents: 500,
    pricing_tiers: { trims_per_piece_cents: 500, functional_test_group_cents: 500 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "仓内非破坏性手工开合与异常触发取证，不包含实验室拉力/盐雾腐蚀/镍释放测试。",
    scope_boundary_en: "Non-destructive manual warehouse tests; excludes lab tensile, salt-spray, or chemical nickel testing.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 6,
  },
  {
    code: "M07",
    name_zh: "标签、印花及刺绣",
    name_en: "Labels, Print & Embroidery Verification",
    description_zh: "品牌标、尺码标、洗水唛、成分/产地标、吊牌、条码核对（$4/件起），及印花位置完整性/刺绣线头设计比对（$5/件起）。",
    description_en: "Brand/size/care/fiber/origin labels, hangtags & barcodes ($4/piece draft), plus print registration/integrity & embroidery vs design ($5/piece draft).",
    module_tier: "optional_addon",
    billing_unit: "per_piece",
    suggested_price_cents: 400,
    pricing_tiers: { label_verification_cents: 400, print_embroidery_cents: 500 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "严禁将商品标签外观/文字核对描述为法定进口或安全合规认证；不作商标真伪鉴定。",
    scope_boundary_en: "NEVER represent visual label verification as statutory/regulatory import compliance or trademark authentication.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 7,
  },
  {
    code: "M08",
    name_zh: "包装检查（单件 $3/件 · 外箱 $6/箱）",
    name_en: "Packaging Inspection ($3/piece · $6/carton)",
    description_zh: "分别管理单件折叠/透明袋/防护袋/包装标签/配件（$3/件起），与外箱箱唛/装箱数量/箱体状态检查（$6/箱起），清晰区分件与箱计费单位。",
    description_en: "Separates individual garment folding/polybag/stickers/accessories ($3/piece draft) from master carton marks/pack count/box state ($6/carton draft).",
    module_tier: "optional_addon",
    billing_unit: "per_piece",
    suggested_price_cents: 300,
    pricing_tiers: { piece_packaging_cents: 300, outer_carton_cents: 600 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "严格区分单件包装与外箱计费单位，不含承运商物流破损责任仲裁或零售 GS1 合规审批。",
    scope_boundary_en: "Strictly distinguishes per-piece vs per-carton billing; excludes carrier damage arbitration or GS1 certification.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 8,
  },
  {
    code: "M09",
    name_zh: "专项照片服务（5张 $5 · 细节 $3/张）",
    name_en: "Dedicated Commercial Photo Service ($5/5 · $3/shot)",
    description_zh: "满足客户额外指定角度或局部商业拍摄（$5/5张起、特殊细节 $3/张起）；明确基础模块已含照片、检测必要证据及异常缺陷照不得重复收费。",
    description_en: "Additional customer-requested angles ($5 per 5 photos; $3 per special detail photo); explicitly never double-bills base, mandatory check, or defect photos.",
    module_tier: "optional_addon",
    billing_unit: "per_item_batch",
    suggested_price_cents: 500,
    pricing_tiers: { extra_5_photos_cents: 500, detail_photo_cents: 300 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "M01 基础照片、检测项目必要证据照、缺陷取证照禁止通过本模块重复加收；保留原图，不做商业修图。",
    scope_boundary_en: "Base routine photos, mandatory check photos, and defect evidence are NEVER billed via M09; unretouched originals only.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 9,
  },
  {
    code: "M10",
    name_zh: "视频证据及功能演示（30s $8 / 60s $12 / 120s $20）",
    name_en: "Video Evidence & Functional Demo (30s $8 / 60s $12 / 120s $20)",
    description_zh: "商品整体/正反面展示、拉链纽扣动态测试、面料细节、特定缺陷、确认样同框及指定演示（30秒 $8 / 60秒 $12 / 120秒 $20 草稿）。",
    description_en: "360/front-back clip, dynamic zipper/button demo, fabric motion, defect clip, reference comparison, custom demo ($8/30s, $12/60s, $20/120s draft).",
    module_tier: "optional_addon",
    billing_unit: "per_item_batch",
    suggested_price_cents: 800,
    pricing_tiers: { up_to_30s_cents: 800, up_to_60s_cents: 1200, up_to_120s_cents: 2000 },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: ["video_capture_station"],
    scope_boundary_zh: "需具备审批通过的视频摄制工位能力，不得承诺尚未落地的生产级视频服务。",
    scope_boundary_en: "Requires approved video_capture_station capability; never promises unverified video capture SLAs.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 10,
  },
  {
    code: "M11",
    name_zh: "特殊检查及人工服务",
    name_en: "Special Inspection & Manual Services",
    description_zh: "支持客户提交特殊测量、复杂工艺、技术包(Tech Pack)核对、特殊摄影、额外复核与异常件处理需求，由运营审核能力并签发结构化人工报价。",
    description_en: "Structured manual quote for custom POMs, intricate craft, tech-pack review, bespoke media, or special exception handling after capability assessment.",
    module_tier: "manual_quote",
    billing_unit: "manual_quote",
    suggested_price_cents: null,
    pricing_tiers: { mode: "manual_quote" },
    depends_on_codes: ["M01"],
    conflicts_with_codes: [],
    requires_capability_codes: [],
    scope_boundary_zh: "明确声明：平台不承担采购代理、卖家退款仲裁、工厂现场 AQL 验货及无实际能力的实验室化学检测。",
    scope_boundary_en: "EXPLICIT NON-SERVICE BOUNDARY: NO sourcing brokerage, NO seller refund arbitration, NO factory on-site AQL, NO uncapable lab tests.",
    is_destructive_possible: false,
    requires_customer_authorization: false,
    sort_order: 11,
  },
];

export type SeedProductType = {
  code: string;
  category_slug: "apparel" | "bags" | "home";
  group_code:
    | "tops"
    | "bottoms"
    | "dresses_sets"
    | "outerwear"
    | "underwear_activewear"
    | "special_apparel"
    | "bags_non_open"
    | "home_non_open";
  group_name_zh: string;
  group_name_en: string;
  name_zh: string;
  name_en: string;
  aliases: string[];
  default_complexity_code: "L1" | "L2" | "L3" | "L4" | "L5";
  structural_options: { key: string; label_zh: string; label_en: string; type: "boolean" | "select"; options?: string[] }[];
  billing_unit: "piece" | "set" | "component";
  included_components: string[];
  applicable_module_codes: string[];
  quote_mode: "online_standard" | "conditional" | "manual_quote";
  capability_status: "ready" | "requires_capability_approval" | "not_admitted";
  sort_order: number;
};

function apparelOpts(extras: { key: string; label_zh: string; label_en: string; type: "boolean" | "select"; options?: string[] }[] = []) {
  return [
    { key: "has_print_embroidery", label_zh: "含印花/刺绣", label_en: "Has Print / Embroidery", type: "boolean" as const },
    { key: "has_zipper_hardware", label_zh: "含拉链/五金辅料", label_en: "Has Zipper / Hardware", type: "boolean" as const },
    ...extras,
  ];
}

// EXACT 54 apparel types from frozen §04 (L196-207) + 2 non-apparel closed placeholders
export const SEED_PRODUCT_TYPES: readonly SeedProductType[] = [
  // 1. 上装 (13) — T恤、背心、Polo衫、衬衫、雪纺衫、针织衫、毛衣、开衫、卫衣、连帽卫衣、运动上衣、紧身上衣、打底衫
  { code: "t_shirt", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "T恤", name_en: "T-Shirt", aliases: ["tee", "short sleeve tee", "圆领T恤"], default_complexity_code: "L1", structural_options: apparelOpts([{ key: "sleeve_type", label_zh: "袖型", label_en: "Sleeve Style", type: "select", options: ["short", "long", "raglan"] }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 1 },
  { code: "tank_top_camisole", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "背心", name_en: "Tank Top / Camisole", aliases: ["吊带背心", "singlet", "camisole"], default_complexity_code: "L1", structural_options: apparelOpts([{ key: "has_adjustable_strap", label_zh: "含可调节肩带", label_en: "Adjustable Straps", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 2 },
  { code: "polo_shirt", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "Polo衫", name_en: "Polo Shirt", aliases: ["翻领T恤", "golf shirt"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_buttons", label_zh: "门襟纽扣", label_en: "Placket Buttons", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 3 },
  { code: "shirt_blouse", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "衬衫", name_en: "Shirt / Woven Blouse", aliases: ["dress shirt", "长袖衬衫", "男衬衣"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_buttons", label_zh: "含门襟及袖口纽扣", label_en: "Front & Cuff Buttons", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 4 },
  { code: "chiffon_blouse", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "雪纺衫", name_en: "Chiffon Blouse", aliases: ["雪纺上衣", "sheer blouse"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_lining", label_zh: "含防透内衬", label_en: "Inner Camisole Lining", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 5 },
  { code: "knitwear_top", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "针织衫", name_en: "Knitwear Top", aliases: ["fine knit", "针织上衣"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "knit_gauge", label_zh: "针织密度", label_en: "Knit Gauge", type: "select", options: ["fine", "medium"] }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 6 },
  { code: "sweater_pullover", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "毛衣", name_en: "Sweater / Pullover", aliases: ["粗针毛衣", "wool jumper"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "knit_gauge", label_zh: "粗细针织支数", label_en: "Yarn Weight", type: "select", options: ["medium", "chunky"] }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 7 },
  { code: "cardigan", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "开衫", name_en: "Cardigan", aliases: ["针织开衫", "button cardigan"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_buttons", label_zh: "前门襟纽扣", label_en: "Front Buttons", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 8 },
  { code: "sweatshirt", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "卫衣", name_en: "Sweatshirt", aliases: ["圆领卫衣", "crewneck sweatshirt"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "brushed_fleece", label_zh: "抓绒/毛圈内里", label_en: "Brushed Fleece Interior", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 9 },
  { code: "hoodie", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "连帽卫衣", name_en: "Hoodie", aliases: ["拉链连帽卫衣", "pullover hoodie"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_drawcord", label_zh: "含帽绳/气眼/袋鼠袋", label_en: "Drawcord, Eyelets & Kangaroo Pocket", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 10 },
  { code: "athletic_top", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "运动上衣", name_en: "Athletic Top", aliases: ["速干运动服上衣", "training tee"], default_complexity_code: "L1", structural_options: apparelOpts([{ key: "flatlock_seams", label_zh: "四针六线平缝", label_en: "Flatlock Seams", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 11 },
  { code: "fitted_compression_top", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "紧身上衣", name_en: "Fitted / Compression Top", aliases: ["紧身健身服", "slim stretch top"], default_complexity_code: "L1", structural_options: apparelOpts([{ key: "high_elastane", label_zh: "高弹力面料回弹检验", label_en: "High-Elastane Recovery", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 12 },
  { code: "base_layer_tee", category_slug: "apparel", group_code: "tops", group_name_zh: "上装", group_name_en: "Tops", name_zh: "打底衫", name_en: "Base Layer Shirt", aliases: ["长袖打底衫", "德绒内搭"], default_complexity_code: "L1", structural_options: apparelOpts(), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 13 },

  // 2. 下装 (10) — 短裤、休闲长裤、西裤、牛仔裤、运动裤、瑜伽裤、紧身裤、工装裤、半身裙、百褶裙
  { code: "shorts", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "短裤", name_en: "Shorts", aliases: ["denim shorts", "运动短裤"], default_complexity_code: "L1", structural_options: apparelOpts([{ key: "has_pockets", label_zh: "侧袋/后袋", label_en: "Side & Back Pockets", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 14 },
  { code: "casual_pants", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "休闲长裤", name_en: "Casual Pants / Chinos", aliases: ["chinos", "斜纹休闲裤"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_pockets", label_zh: "含前后插袋", label_en: "Front & Back Pockets", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 15 },
  { code: "dress_pants", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "西裤", name_en: "Dress Pants / Trousers", aliases: ["suit trousers", "正装西裤"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_lining", label_zh: "含膝衬里布", label_en: "Knee Lining", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 16 },
  { code: "jeans_denim_pants", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "牛仔裤", name_en: "Jeans / Denim Pants", aliases: ["denim", "水洗牛仔裤"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_wash_effect", label_zh: "水洗磨白/猫须工艺", label_en: "Denim Wash / Whiskers", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 17 },
  { code: "sweatpants", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "运动裤", name_en: "Sweatpants / Joggers", aliases: ["卫裤", "track pants"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "elastic_waist", label_zh: "松紧腰头抽绳", label_en: "Elastic Waistband & Drawcord", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 18 },
  { code: "yoga_pants", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "瑜伽裤", name_en: "Yoga Pants", aliases: ["高腰瑜伽裤", "flare yoga pants"], default_complexity_code: "L1", structural_options: apparelOpts([{ key: "gusset_crotch", label_zh: "三角裆底无痕拼接", label_en: "Contoured Gusset Crotch", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 19 },
  { code: "leggings", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "紧身裤", name_en: "Leggings", aliases: ["打底裤", "鲨鱼裤"], default_complexity_code: "L1", structural_options: apparelOpts(), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 20 },
  { code: "cargo_pants", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "工装裤", name_en: "Cargo Pants", aliases: ["多袋工装裤", "utility pants"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "multi_cargo_pockets", label_zh: "立体风琴贴袋与魔术贴", label_en: "Multi-Bellow Cargo Pockets & Velcro", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 21 },
  { code: "skirt", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "半身裙", name_en: "Skirt", aliases: ["A字裙", "midi skirt"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "has_lining", label_zh: "含内衬/安全裤", label_en: "Inner Lining / Safety Shorts", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 22 },
  { code: "pleated_skirt", category_slug: "apparel", group_code: "bottoms", group_name_zh: "下装", group_name_en: "Bottoms", name_zh: "百褶裙", name_en: "Pleated Skirt", aliases: ["学院风百褶裙", "jk skirt"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "pleat_crispness", label_zh: "定型褶皱对称与定位缝线", label_en: "Pleat Alignment & Crispness", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 23 },

  // 3. 连体及套装 (8) — 连衣裙、连体裤、连体衣、两件套、运动套装、瑜伽套装、睡衣套装、多件组合服装
  { code: "casual_dress", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "连衣裙", name_en: "Dress", aliases: ["day dress", "连身裙"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "has_lining", label_zh: "含裙身里布", label_en: "Bodice/Skirt Lining", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 24 },
  { code: "jumpsuit", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "连体裤", name_en: "Jumpsuit / Playsuit", aliases: ["工装连体裤", "romper pants"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "waist_tie_or_zip", label_zh: "腰带或隐形拉链", label_en: "Waist Belt or Concealed Zipper", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 25 },
  { code: "bodysuit_romper", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "连体衣", name_en: "Bodysuit / Romper", aliases: ["底部按扣连体衣", "snap bodysuit"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "crotch_snaps", label_zh: "底部按扣结构", label_en: "Crotch Snap Closure", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 26 },
  { code: "two_piece_set", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "两件套", name_en: "Two-Piece Set", aliases: ["co-ord set", "上下两件套"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "color_match_between_pieces", label_zh: "上下件缸差配对核查", label_en: "Cross-Piece Color Matching", type: "boolean" }]), billing_unit: "set", included_components: ["top", "bottom"], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 27 },
  { code: "tracksuit_set", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "运动套装", name_en: "Tracksuit Set", aliases: ["卫衣套装", "athletic suit"], default_complexity_code: "L3", structural_options: apparelOpts(), billing_unit: "set", included_components: ["top", "pants"], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 28 },
  { code: "yoga_set", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "瑜伽套装", name_en: "Yoga Set", aliases: ["健身两件套", "active bra + leggings set"], default_complexity_code: "L3", structural_options: apparelOpts(), billing_unit: "set", included_components: ["sports_bra_or_top", "yoga_pants"], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 29 },
  { code: "pajama_set", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "睡衣套装", name_en: "Pajama / Sleepwear Set", aliases: ["家居服套装", "loungewear set"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "delicate_satin", label_zh: "丝绸/缎面防勾丝检查", label_en: "Delicate Satin Surface Check", type: "boolean" }]), billing_unit: "set", included_components: ["top", "bottom"], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 30 },
  { code: "multi_piece_garment_set", category_slug: "apparel", group_code: "dresses_sets", group_name_zh: "连体及套装", group_name_en: "Dresses & Sets", name_zh: "多件组合服装", name_en: "Multi-Piece Combined Garment Set", aliases: ["三件套西装", "multi-piece bundle"], default_complexity_code: "L4", structural_options: apparelOpts([{ key: "component_count_3_plus", label_zh: "3件及以上拆分核对", label_en: "3+ Components Unbundling", type: "boolean" }]), billing_unit: "set", included_components: ["outer", "inner", "bottom"], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11"], quote_mode: "conditional", capability_status: "ready", sort_order: 31 },

  // 4. 外套 (10) — 薄夹克、牛仔外套、棒球服、风衣、西装外套、棉服、羽绒服、厚大衣、多层外套、带可拆卸部件的外套
  { code: "light_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "薄夹克", name_en: "Light Jacket", aliases: ["harrington", "bomber light"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "has_lining", label_zh: "含网眼/涤塔夫里布", label_en: "Mesh or Taffeta Lining", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 32 },
  { code: "denim_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "牛仔外套", name_en: "Denim Jacket", aliases: ["trucker jacket", "牛仔夹克"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "metal_shank_buttons", label_zh: "含工字金属纽扣", label_en: "Metal Shank Buttons", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 33 },
  { code: "varsity_baseball_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "棒球服", name_en: "Baseball / Varsity Jacket", aliases: ["flight jacket", "letterman jacket"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "chenille_patch_rib", label_zh: "含毛巾绣贴布与罗纹拼色", label_en: "Chenille Patches & Rib Trim", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 34 },
  { code: "trench_coat", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "风衣", name_en: "Trench Coat", aliases: ["长风衣", "mac coat"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "has_belt_epaulettes", label_zh: "含腰带/袖袢/肩章", label_en: "Belt, Cuff Tabs & Epaulettes", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 35 },
  { code: "blazer_suit_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "西装外套", name_en: "Blazer / Suit Jacket", aliases: ["tailored blazer", "小西装"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "shoulder_pad", label_zh: "垫肩及全里布", label_en: "Shoulder Pads & Full Lining", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 36 },
  { code: "padded_cotton_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "棉服", name_en: "Padded Cotton Jacket", aliases: ["夹棉外套", "quilted jacket"], default_complexity_code: "L4", structural_options: apparelOpts([{ key: "baffle_fill_evenness", label_zh: "绗缝夹棉均匀度", label_en: "Quilted Fill Uniformity", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 37 },
  { code: "down_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "羽绒服", name_en: "Down Jacket", aliases: ["down parka", "羽绒外套"], default_complexity_code: "L4", structural_options: apparelOpts([{ key: "has_hood", label_zh: "防风帽或防钻绒格位检查", label_en: "Hood & Down Leakage Check", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 38 },
  { code: "heavy_overcoat", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "厚大衣", name_en: "Heavy Overcoat / Wool Coat", aliases: ["呢大衣", "peacoat", "double faced wool"], default_complexity_code: "L4", structural_options: apparelOpts([{ key: "heavy_weight_coat", label_zh: "重磅毛呢/双面呢翻面检查", label_en: "Heavy Wool Inside-Out Inspection", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 39 },
  { code: "multi_layer_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "多层外套", name_en: "Multi-Layer Jacket / Shell", aliases: ["冲锋衣", "three-layer shell"], default_complexity_code: "L4", structural_options: apparelOpts([{ key: "seam_taped", label_zh: "内里热封压胶条", label_en: "Internal Seam-Sealed Tape", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 40 },
  { code: "detachable_parts_jacket", category_slug: "apparel", group_code: "outerwear", group_name_zh: "外套", group_name_en: "Outerwear", name_zh: "带可拆卸部件的外套", name_en: "Jacket with Detachable Components", aliases: ["三合一外套", "detachable liner jacket"], default_complexity_code: "L4", structural_options: apparelOpts([{ key: "detachable_liner_or_hood", label_zh: "可拆卸内胆/帽子/毛领", label_en: "Detachable Liner, Hood or Collar", type: "boolean" }]), billing_unit: "piece", included_components: ["outer_shell", "detachable_part"], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11"], quote_mode: "conditional", capability_status: "ready", sort_order: 41 },

  // 5. 内衣及运动服装 (6) — 运动内衣、普通文胸、内裤、塑身衣、泳装、功能性运动服装
  { code: "sports_bra", category_slug: "apparel", group_code: "underwear_activewear", group_name_zh: "内衣及运动服装", group_name_en: "Underwear & Activewear", name_zh: "运动内衣", name_en: "Sports Bra", aliases: ["瑜伽背心内衣", "high impact sports bra"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "removable_cups", label_zh: "可拆卸胸垫", label_en: "Removable Cups", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 42 },
  { code: "regular_bra", category_slug: "apparel", group_code: "underwear_activewear", group_name_zh: "内衣及运动服装", group_name_en: "Underwear & Activewear", name_zh: "普通文胸", name_en: "Regular Bra / Bralette", aliases: ["钢圈文胸", "lace bra"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "hook_eye_underwire", label_zh: "背扣/钢圈/调节扣", label_en: "Hook & Eye / Underwire / Sliders", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 43 },
  { code: "underwear_briefs", category_slug: "apparel", group_code: "underwear_activewear", group_name_zh: "内衣及运动服装", group_name_en: "Underwear & Activewear", name_zh: "内裤", name_en: "Underwear / Briefs / Boxers", aliases: ["boxer briefs", "平角裤"], default_complexity_code: "L1", structural_options: apparelOpts(), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 44 },
  { code: "shapewear_bodysuit", category_slug: "apparel", group_code: "underwear_activewear", group_name_zh: "内衣及运动服装", group_name_en: "Underwear & Activewear", name_zh: "塑身衣", name_en: "Shapewear", aliases: ["收腹束腰", "compression shapewear"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "boning_hook_compression", label_zh: "排扣/鱼骨及压力区接缝", label_en: "Hook Closure, Boning & Bonded Seams", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 45 },
  { code: "swimwear", category_slug: "apparel", group_code: "underwear_activewear", group_name_zh: "内衣及运动服装", group_name_en: "Underwear & Activewear", name_zh: "泳装", name_en: "Swimwear", aliases: ["bikini", "连体泳衣"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "hygiene_liner", label_zh: "防污裆贴与挂扣检查", label_en: "Hygiene Liner & Clasp Check", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"], quote_mode: "online_standard", capability_status: "ready", sort_order: 46 },
  { code: "functional_sportswear", category_slug: "apparel", group_code: "underwear_activewear", group_name_zh: "内衣及运动服装", group_name_en: "Underwear & Activewear", name_zh: "功能性运动服装", name_en: "Functional Sportswear", aliases: ["骑行服", "ski base", "滑雪防风服"], default_complexity_code: "L3", structural_options: apparelOpts([{ key: "reflective_bonding", label_zh: "反光压胶/透气网眼拼接", label_en: "Reflective Bonding & Mesh Zones", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 47 },

  // 6. 特殊服装 (7) — 童装、婴幼儿服装、礼服、婚纱、复杂刺绣服装、特殊装饰服装、特殊材料服装
  { code: "kids_apparel", category_slug: "apparel", group_code: "special_apparel", group_name_zh: "特殊服装", group_name_en: "Special Apparel", name_zh: "童装", name_en: "Kids Apparel", aliases: ["children wear", "大童服饰"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "drawcord_safety_check", label_zh: "童装绳带小附件安全提示", label_en: "Drawcord & Trim Safety Check", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10"], quote_mode: "online_standard", capability_status: "ready", sort_order: 48 },
  { code: "baby_toddler_apparel", category_slug: "apparel", group_code: "special_apparel", group_name_zh: "特殊服装", group_name_en: "Special Apparel", name_zh: "婴幼儿服装", name_en: "Baby & Toddler Apparel", aliases: ["哈衣爬服", "infant wear"], default_complexity_code: "L2", structural_options: apparelOpts([{ key: "small_parts_caution", label_zh: "小附件牢度/异物与标签检查", label_en: "Small Parts & Label Check", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M08", "M09", "M10", "M11"], quote_mode: "conditional", capability_status: "ready", sort_order: 49 },
  { code: "formal_dress_gown", category_slug: "apparel", group_code: "special_apparel", group_name_zh: "特殊服装", group_name_en: "Special Apparel", name_zh: "礼服", name_en: "Formal Dress / Gown", aliases: ["晚礼服", "evening gown"], default_complexity_code: "L5", structural_options: apparelOpts([{ key: "beading_boning", label_zh: "鱼骨/拖尾/多层薄纱", label_en: "Boning, Train & Multi-Layer Tulle", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11"], quote_mode: "manual_quote", capability_status: "ready", sort_order: 50 },
  { code: "wedding_dress", category_slug: "apparel", group_code: "special_apparel", group_name_zh: "特殊服装", group_name_en: "Special Apparel", name_zh: "婚纱", name_en: "Wedding Dress / Bridal Gown", aliases: ["bridal", "长拖尾婚纱"], default_complexity_code: "L5", structural_options: apparelOpts([{ key: "bridal_lace_tulle", label_zh: "蕾丝裙撑及大体积拍摄条件", label_en: "Lace Applique & Oversized Table Prep", type: "boolean" }]), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11"], quote_mode: "manual_quote", capability_status: "ready", sort_order: 51 },
  { code: "heavy_embroidery_apparel", category_slug: "apparel", group_code: "special_apparel", group_name_zh: "特殊服装", group_name_en: "Special Apparel", name_zh: "复杂刺绣服装", name_en: "Complex Embroidered Apparel", aliases: ["重工满绣", "hand embroidery"], default_complexity_code: "L5", structural_options: apparelOpts(), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M07", "M09", "M10", "M11"], quote_mode: "manual_quote", capability_status: "ready", sort_order: 52 },
  { code: "special_embellishment_apparel", category_slug: "apparel", group_code: "special_apparel", group_name_zh: "特殊服装", group_name_en: "Special Apparel", name_zh: "特殊装饰服装", name_en: "Special Embellished Apparel (Beads/Sequins)", aliases: ["重工钉珠", "亮片服装"], default_complexity_code: "L5", structural_options: apparelOpts(), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M06", "M07", "M09", "M10", "M11"], quote_mode: "manual_quote", capability_status: "ready", sort_order: 53 },
  { code: "special_material_apparel", category_slug: "apparel", group_code: "special_apparel", group_name_zh: "特殊服装", group_name_en: "Special Apparel", name_zh: "特殊材料服装", name_en: "Special Material Apparel (Silk/Leather/Fur)", aliases: ["真丝/真皮/羊绒", "delicate leather"], default_complexity_code: "L5", structural_options: apparelOpts(), billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M02", "M03", "M04", "M05", "M08", "M09", "M10", "M11"], quote_mode: "manual_quote", capability_status: "ready", sort_order: 54 },

  // 7. Non-apparel closed placeholders (default NOT open for sales per §03 & L03 TASK-195)
  { code: "bags_general", category_slug: "bags", group_code: "bags_non_open", group_name_zh: "箱包（规划中未开放）", group_name_en: "Bags (Planned - Not Open)", name_zh: "通用箱包占位（未开放售卖）", name_en: "General Bag Placeholder (Closed by Default)", aliases: ["handbag", "backpack"], default_complexity_code: "L3", structural_options: [], billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M11"], quote_mode: "manual_quote", capability_status: "not_admitted", sort_order: 101 },
  { code: "home_general", category_slug: "home", group_code: "home_non_open", group_name_zh: "家居用品（规划中未开放）", group_name_en: "Home Goods (Planned - Not Open)", name_zh: "通用家居占位（未开放售卖）", name_en: "General Home Item Placeholder (Closed by Default)", aliases: ["bedding", "cushion"], default_complexity_code: "L2", structural_options: [], billing_unit: "piece", included_components: [], applicable_module_codes: ["M01", "M11"], quote_mode: "manual_quote", capability_status: "not_admitted", sort_order: 102 },
];

export type SeedCheckItem = {
  code: string;
  module_code: string;
  name_zh: string;
  name_en: string;
  method_zh: string;
  method_en: string;
  scope_limit_zh: string;
  scope_limit_en: string;
  applicable_group_codes: string[];
  applicable_part_codes: string[];
  evidence_requirement: "mandatory_photo" | "photo_if_defect" | "measurement_record" | "label_photo" | "video_optional" | "none";
  billing_included_in_base: boolean;
  requires_capability_code: string | null;
  sort_order: number;
};

const ALL_APPAREL_GROUPS = ["tops", "bottoms", "dresses_sets", "outerwear", "underwear_activewear", "special_apparel"];

// Strictly mapped to §05 modules M01-M11
export const SEED_CHECK_ITEMS: readonly SeedCheckItem[] = [
  // M01 Base Appearance & Workmanship (included in base L1-L5)
  { code: "CHK_M01_APPEARANCE_MATCH", module_code: "M01", name_zh: "整体外观、款式与颜色基础核对", name_en: "Overall Appearance, Style & Color Basic Check", method_zh: "拆袋后目视核对款式、颜色、尺码与订单相符并拍摄正反面基准原图。", method_en: "Compare unpacked garment style, colorway, and size against commission; capture base front/back photos.", scope_limit_zh: "逐件目视核对（非 AQL 抽检放行）。", scope_limit_en: "Piece-by-piece visual match (NOT AQL lot certification).", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface"], evidence_requirement: "mandatory_photo", billing_included_in_base: true, requires_capability_code: null, sort_order: 1 },
  { code: "CHK_M01_STAINS_HOLES_SURFACE", module_code: "M01", name_zh: "明显污渍、破损孔洞及表面异常", name_en: "Visible Stains, Holes & Surface Flaws", method_zh: "检查正反面油污、霉点、撕裂破洞、明显抽纱或表面变形。", method_en: "Inspect front and back surfaces for stains, tears, holes, snags, or distortion.", scope_limit_zh: "发现缺陷须加拍带刻度尺定位特写照（包含于基础）。", scope_limit_en: "Defect scale photos are included in base coverage.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface"], evidence_requirement: "photo_if_defect", billing_included_in_base: true, requires_capability_code: null, sort_order: 2 },
  { code: "CHK_M01_WORKMANSHIP_SEAMS", module_code: "M01", name_zh: "脱线/跳针/开线爆缝/过长线头", name_en: "Skipped Stitch, Open Seam & Loose Threads", method_zh: "沿肩缝、侧缝、袖笼、裤裆及下摆检查车缝连续性、跳针、开线及多余线头。", method_en: "Check shoulder, side seam, armhole, crotch, and hem stitching for skips, open seams, and loose threads.", scope_limit_zh: "不含实验室缝线密度拉伸破坏试验。", scope_limit_en: "Excludes lab stitch-density or seam-strength tensile tests.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["shoulder", "side_seam", "sleeve", "inseam", "crotch", "hem"], evidence_requirement: "photo_if_defect", billing_included_in_base: true, requires_capability_code: null, sort_order: 3 },
  { code: "CHK_M01_SYMMETRY_AND_BASE_LABELS", module_code: "M01", name_zh: "明显左右不对称及基础标签核对", name_en: "Left-Right Symmetry & Basic Label Verification", method_zh: "平铺比对袖长/裤长/口袋对称度并核对主标/尺码标基础身份。", method_en: "Lay flat to check left-right symmetry and verify basic brand/size label presence.", scope_limit_zh: "深度洗标/成分/条码全面核对见 M07。", scope_limit_en: "Deep multi-tag/print verification is covered in M07.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["collar", "pocket", "brand_label", "care_label"], evidence_requirement: "label_photo", billing_included_in_base: true, requires_capability_code: null, sort_order: 4 },
  { code: "CHK_M01_LINING_FILL_BASE", module_code: "M01", name_zh: "里布吊紧与羽绒钻绒基础检查", name_en: "Lining Tension & Down Poke-Through Basic Check", method_zh: "翻面检视内衬拼合包边及厚重外套钻绒结块明显异常。", method_en: "Turn inside-out to inspect lining tension and obvious feather poke-through.", scope_limit_zh: "适用有里布或填充外套。", scope_limit_en: "Applies to lined or filled outerwear.", applicable_group_codes: ["dresses_sets", "outerwear", "special_apparel"], applicable_part_codes: ["lining", "fabric_surface"], evidence_requirement: "photo_if_defect", billing_included_in_base: true, requires_capability_code: null, sort_order: 5 },

  // M02 Dimension Measurement ($8 3pt / $12 5pt / $18 8pt / $3 extra)
  { code: "CHK_M02_UPPER_BODY_POM", module_code: "M02", name_zh: "上衣及外套点位测量（3/5/8点及自定义）", name_en: "Upper-Body & Outerwear POM Measurement (3/5/8/Custom)", method_zh: "依据品类图谱测量衣长、1/2胸围、肩宽、袖长、下摆等点位，触发超差执行复测。", method_en: "Measure body length, 1/2 chest width, shoulder width, sleeve length, hem etc. per POM diagram with double check on tolerance breach.", scope_limit_zh: "单位锁定 cm/in，不得全品类通用同一固定点位表。", scope_limit_en: "Unit-locked cm/in; POM sets adapt to specific garment type.", applicable_group_codes: ["tops", "dresses_sets", "outerwear", "underwear_activewear", "special_apparel"], applicable_part_codes: ["chest", "shoulder", "sleeve", "hem"], evidence_requirement: "measurement_record", billing_included_in_base: false, requires_capability_code: "measurement_tool", sort_order: 6 },
  { code: "CHK_M02_LOWER_BODY_POM", module_code: "M02", name_zh: "下装点位测量（严格区分 Inseam / Outseam）", name_en: "Lower-Body POM Measurement (Inseam vs Outseam)", method_zh: "量测 1/2腰围、1/2臀围、前浪、内长(Inseam)、外长(Outseam)与脚口。", method_en: "Measure 1/2 waist, 1/2 hip, front rise, inseam, outseam, and leg opening.", scope_limit_zh: "严禁混淆 Inseam 与 Outseam 定义。", scope_limit_en: "Strictly separates inseam vs outseam.", applicable_group_codes: ["bottoms", "dresses_sets", "underwear_activewear", "special_apparel"], applicable_part_codes: ["waistband", "inseam", "crotch", "hem"], evidence_requirement: "measurement_record", billing_included_in_base: false, requires_capability_code: "measurement_tool", sort_order: 7 },
  { code: "CHK_M02_SCALE_PROOF_PHOTO", module_code: "M02", name_zh: "卷尺刻度入镜实测取证（含超差照）", name_en: "Measuring Tape Scale-Visible Photo Proof", method_zh: "拍摄起止刻度清晰的量测俯拍图，超差项须全量拍照留底。", method_en: "Photograph measuring tape start-to-end scale clearly, mandatory for every out-of-tolerance POM.", scope_limit_zh: "必要检测证据不得通过 M09 重复计费。", scope_limit_en: "Mandatory check evidence NEVER double-billed via M09.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["chest", "waistband"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: "measurement_tool", sort_order: 8 },

  // M03 Color Check & Reference Comparison ($5/piece)
  { code: "CHK_M03_COLOR_CONSISTENCY", module_code: "M03", name_zh: "客户声明颜色及同SKU件间/左右片色差", name_en: "Declared Color, Intra-SKU & Panel Shade Consistency", method_zh: "在标准光照与统一白平衡下对比主辅拼色、左右袖/腿及不同件之间的色泽差异。", method_en: "Compare primary/contrast panels, left/right parts, and multiple pieces of same SKU under uniform bench lighting.", scope_limit_zh: "无标准光源箱/色差仪时严禁宣称 Delta E 数值或客观评级。", scope_boundary_en: "No Delta E claims without calibrated spectrophotometer.", scope_limit_en: "Visual white-balanced observation only unless spectrophotometer capability approved.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface", "collar", "sleeve"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 9 } as SeedCheckItem,
  { code: "CHK_M03_GOLDEN_SAMPLE_MATCH", module_code: "M03", name_zh: "实物与确认样（Golden Sample）同框视觉比色", name_en: "Visual Side-by-Side Color Match vs Golden Sample", method_zh: "将委检样品与已封存确认样并排置入标准拍摄台对比色差，并拍摄同框对照原图。", method_en: "Place sample alongside archived golden sample under identical exposure and capture side-by-side comparison photo.", scope_limit_zh: "仅限视觉对照，不代表工业色卡认证。", scope_limit_en: "Visual reference comparison only; no Pantone lab certificate.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 10 },

  // M04 Fabric Appearance & Handfeel ($7/piece)
  { code: "CHK_M04_SURFACE_TEXTURE_WEAVE", module_code: "M04", name_zh: "面料表面纹理、织法与粗细厚薄观察", name_en: "Fabric Texture, Weave, Thickness & Handfeel Assessment", method_zh: "近距检验织纹密度、粗细均匀度、毛羽起球及手感对比，若有确认样则同台触感对比。", method_en: "Inspect weave structure, thickness uniformity, surface fuzz/pilling, and handfeel against golden sample when present.", scope_limit_zh: "非破坏性目视与触感观察。", scope_limit_en: "Non-destructive visual & tactile check.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface"], evidence_requirement: "photo_if_defect", billing_included_in_base: false, requires_capability_code: null, sort_order: 11 },
  { code: "CHK_M04_FIBER_LABEL_TEXT_CHECK", module_code: "M04", name_zh: "标签标注成分与客户声明材质核对", name_en: "Label Fiber Text vs Customer Material Expectation", method_zh: "读取水洗唛印制成分说明并与客户订单材质要求核对。", method_en: "Read care-label fiber composition text and match against customer expected material specification.", scope_limit_zh: "严正声明：标签成分文本核对绝不代表实验室纤维定量检测。", scope_limit_en: "EXPLICIT BOUNDARY: Printed fiber text is NOT laboratory composition verification.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["care_label", "fabric_surface"], evidence_requirement: "label_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 12 },

  // M05 Weight ($2/piece) & Destructive GSM ($12/cut)
  { code: "CHK_M05_GARMENT_GROSS_WEIGHT", module_code: "M05", name_zh: "整衣去袋实称克重（克 g）", name_en: "Finished Garment Gross Weight (Grams)", method_zh: "去外袋在已校零电子秤上实称整件重量（g）并拍称面读数照。", method_en: "Unbag garment, zero calibrated digital scale, weigh total garment in grams (g), and photograph readout.", scope_limit_zh: "严禁换算或冒充面料 GSM（g/m²）。", scope_limit_en: "EXPLICIT BOUNDARY: Garment weight (g) is NEVER equivalent to fabric GSM (g/m²).", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: "calibrated_scale", sort_order: 13 },
  { code: "CHK_M05_DESTRUCTIVE_GSM_CUT", module_code: "M05", name_zh: "破坏性圆盘取样测算面料 GSM（g/m²）", name_en: "Destructive Circular-Cutter Fabric GSM Measurement", method_zh: "仅在具备圆盘取样器能力 AND 客户明确破坏性授权时裁取 100cm² 样布精称换算 GSM。", method_en: "ONLY with approved fabric_gsm_cutter capability AND explicit customer destructive authorization: cut 100cm² swatch and convert to g/m².", scope_limit_zh: "永久损毁成衣；无客户明确授权严禁裁剪。", scope_limit_en: "Destroys sample permanently; strictly blocked without explicit customer authorization.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: "fabric_gsm_cutter", sort_order: 14 },

  // M06 Trims & Functional Testing ($5/piece, $5/group)
  { code: "CHK_M06_ZIPPER_VELCRO_TRIMS", module_code: "M06", name_zh: "拉链、魔术贴、金属装饰及调节扣功能测试", name_en: "Zipper, Velcro, Slider & Metal Trim Functional Test", method_zh: "拉链全行程拉合测试3次，测试魔术贴粘合力及可调节扣/肩带滑动牢度。", method_en: "Cycle zipper full track 3 times; verify Velcro grip, strap sliders, and metal hardware.", scope_limit_zh: "仓库非破坏性手工操作，异常触发照片或视频取证。", scope_limit_en: "Manual non-destructive functional checks.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["zipper", "strap", "pocket"], evidence_requirement: "photo_if_defect", billing_included_in_base: false, requires_capability_code: null, sort_order: 15 },
  { code: "CHK_M06_BUTTONS_SNAPS_CORDS", module_code: "M06", name_zh: "纽扣、按扣、抽绳、松紧带与可拆卸部件核查", name_en: "Buttons, Snaps, Drawcord, Elastic & Detachable Parts Check", method_zh: "逐粒扣合检验按扣/纽扣、排查帽绳长度及可拆卸内胆/帽子接驳完整性。", method_en: "Fasten/unfasten buttons and snaps; verify drawcords, elastic recovery, and detachable components.", scope_limit_zh: "童装绳带与小零件发现风险即刻高亮标记。", scope_limit_en: "Flag small-part / cord hazards prominently for kids apparel.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["button", "hood", "waistband", "cuff"], evidence_requirement: "photo_if_defect", billing_included_in_base: false, requires_capability_code: null, sort_order: 16 },

  // M07 Labels, Print & Embroidery ($4 labels / $5 print & embroidery)
  { code: "CHK_M07_ALL_LABELS_BARCODES", module_code: "M07", name_zh: "品牌/尺码/洗水/成分/产地/吊牌/条码专项核查", name_en: "Brand, Size, Care, Fiber, Origin, Hangtag & Barcode Audit", method_zh: "逐一拍照核对所有内外标签、成分产地字样、吊牌及条码可扫内容。", method_en: "Verify and photograph all sewn labels, origin/fiber wording, cardstock hangtags, and barcode scans.", scope_limit_zh: "不代表进口国法定法规合规或品牌真伪认定。", scope_limit_en: "NOT regulatory import compliance certification or brand authentication.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["brand_label", "care_label", "hangtag"], evidence_requirement: "label_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 17 },
  { code: "CHK_M07_PRINT_EMBROIDERY_SPEC", module_code: "M07", name_zh: "印花位置完整性与刺绣线头设计比对", name_en: "Print Placement/Integrity & Embroidery Craft Check", method_zh: "核查印花居中偏位、龟裂沾粘、刺绣浮线/衬纸及对照参考设计稿一致性。", method_en: "Check graphic centering, cracking/tackiness, embroidery backing/threads, and consistency vs reference design.", scope_limit_zh: "不含机洗水洗色牢度破坏测试。", scope_limit_en: "Excludes domestic wash-cycle durability tests.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["print_area", "embroidery_area"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 18 },

  // M08 Packaging Inspection ($3/piece, $6/carton)
  { code: "CHK_M08_PIECE_PACKAGING", module_code: "M08", name_zh: "单件折叠/透明袋/防护包装/贴码/配件核查", name_en: "Individual Fold, Polybag, Sticker & Accessory Packaging Check", method_zh: "核对折叠规范、防尘透明袋透气孔/警示语、包装标签条码与随包配件齐全。", method_en: "Inspect folding method, polybag condition/air holes, bag stickers, and enclosed accessories.", scope_limit_zh: "按件计费，独立于外箱检查。", scope_limit_en: "Per-piece check separate from carton billing.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["polybag_packaging", "hangtag"], evidence_requirement: "photo_if_defect", billing_included_in_base: false, requires_capability_code: null, sort_order: 19 },
  { code: "CHK_M08_MASTER_CARTON_CHECK", module_code: "M08", name_zh: "外箱箱唛、装箱数量及外箱完好状态", name_en: "Master Carton Marks, Pack Count & Box Condition Check", method_zh: "核实外箱印刷箱唛、实际装箱件数与箱体受潮抗压状态。", method_en: "Verify exterior carton shipping marks, packed unit count, and carton crush/moisture condition.", scope_limit_zh: "按箱计费，不承担承运商在途破损赔偿定责。", scope_limit_en: "Billed per carton; carrier transit liability excluded.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["outer_carton"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 20 },

  // M09 Dedicated Photo Service ($5/5 photos, $3/detail photo)
  { code: "CHK_M09_COMMERCIAL_EXTRA_ANGLES", module_code: "M09", name_zh: "客户额外加购多角度/细节商业照片（非基础证据）", name_en: "Customer-Requested Extra Angle & Macro Photos (Commercial Add-On)", method_zh: "按客户指定列表补充拍摄侧面、内衬、领口、下摆或与确认样并排对照高清图。", method_en: "Capture requested supplemental angles (side profile, interior, collar, hem, or side-by-side reference shots).", scope_limit_zh: "严格区分 M01 基础照与异常缺陷证据照，绝不重复收费。", scope_limit_en: "Strictly separated from included base, check, and defect evidence.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface", "collar", "cuff", "hem", "zipper", "lining"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 21 },

  // M10 Video Evidence & Functional Demo ($8 30s / $12 60s / $20 120s)
  { code: "CHK_M10_VIDEO_FUNCTIONAL_CLIP", module_code: "M10", name_zh: "高清视频证据摄制（360展示/拉链演示/确认样对比）", name_en: "HD Video Capture (Full Rotation, Hardware Demo, Reference Compare)", method_zh: "在已审批视频工位摄制不超约定秒数（30s/60s/120s）的无剪辑连续视频原件。", method_en: "Record unedited continuous clip (30s/60s/120s max) on approved video capture workstation showing requested action.", scope_limit_zh: "需具备审批通过的 video_capture_station 能力；不作剪辑特效。", scope_limit_en: "Requires approved video_capture_station capability; raw uncut clip only.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface", "zipper", "button"], evidence_requirement: "video_optional", billing_included_in_base: false, requires_capability_code: "video_capture_station", sort_order: 22 },

  // M11 Special Inspection & Manual Services
  { code: "CHK_M11_TECH_PACK_CUSTOM_CHECK", module_code: "M11", name_zh: "人工审核技术包(Tech Pack)/定制清单逐条核验", name_en: "Manual-Quoted Tech Pack / Bespoke Checklist Execution", method_zh: "按经报价确认的技术包尺寸图/工艺要求逐项现场验证并全量拍照留存。", method_en: "Execute staff-quoted tech-pack and bespoke checklist rules step by step with photo audit.", scope_limit_zh: "不承接采购代理、卖家仲裁或工厂现场 AQL 验货。", scope_limit_en: "No sourcing agency, seller arbitration, or factory on-site AQL.", applicable_group_codes: ALL_APPAREL_GROUPS, applicable_part_codes: ["fabric_surface"], evidence_requirement: "mandatory_photo", billing_included_in_base: false, requires_capability_code: null, sort_order: 23 },
];

export const SEED_GARMENT_PARTS: readonly { code: string; name_zh: string; name_en: string; description_zh: string; description_en: string; applicable_group_codes: string[]; sort_order: number }[] = [
  { code: "collar", name_zh: "领口 / 领片", name_en: "Collar / Neckline", description_zh: "圆领螺纹、翻领、立领及领贴接缝区域", description_en: "Ribbed crew neckline, turn-down collar, stand collar, and neck tape area", applicable_group_codes: ["tops", "dresses_sets", "outerwear", "special_apparel"], sort_order: 1 },
  { code: "shoulder", name_zh: "肩部 / 肩缝", name_en: "Shoulder / Shoulder Seam", description_zh: "左右肩线、肩斜及插肩拼接部位", description_en: "Left/right shoulder seams, shoulder slope, and raglan join", applicable_group_codes: ["tops", "dresses_sets", "outerwear", "special_apparel"], sort_order: 2 },
  { code: "chest", name_zh: "胸部 / 前幅", name_en: "Chest / Front Bodice", description_zh: "腋下约2.5cm水平胸围量测区及前幅中心区", description_en: "Chest measurement zone ~2.5cm below armhole and upper front panel", applicable_group_codes: ["tops", "dresses_sets", "outerwear", "underwear_activewear", "special_apparel"], sort_order: 3 },
  { code: "sleeve", name_zh: "袖身 / 袖笼", name_en: "Sleeve / Armhole", description_zh: "袖山弧度、袖管拼缝及袖笼拼合部位", description_en: "Sleeve cap, sleeve underarm seam, and armhole assembly", applicable_group_codes: ["tops", "dresses_sets", "outerwear", "special_apparel"], sort_order: 4 },
  { code: "cuff", name_zh: "袖口", name_en: "Cuff / Sleeve Opening", description_zh: "螺纹袖口、开衩纽扣袖克夫或松紧袖口", description_en: "Rib knit cuff, buttoned woven cuff, or elasticized sleeve opening", applicable_group_codes: ["tops", "dresses_sets", "outerwear", "special_apparel"], sort_order: 5 },
  { code: "hem", name_zh: "下摆 / 脚口", name_en: "Bottom Hem / Leg Opening", description_zh: "成衣底边压线、裤脚边或裙摆底边", description_en: "Garment bottom hem, trouser leg opening, or skirt sweep hem", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 6 },
  { code: "side_seam", name_zh: "侧缝", name_en: "Side Seam", description_zh: "左右腋下至下摆或腰头至脚口侧骨线", description_en: "Lateral body seam from underarm/waist down to hem", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 7 },
  { code: "zipper", name_zh: "拉链（链齿/拉头/挡风片）", name_en: "Zipper Assembly", description_zh: "前门襟、裤裆或口袋拉链及其拉头止口", description_en: "Center-front, fly, or pocket zipper track, slider, puller, and stoppers", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 8 },
  { code: "button", name_zh: "纽扣 / 按扣 / 四合扣", name_en: "Buttons / Snaps / Fasteners", description_zh: "工字扣、树脂扣、金属按扣及对应扣眼", description_en: "Buttons, shank buttons, snap fasteners, hook-and-eye, and buttonholes", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 9 },
  { code: "pocket", name_zh: "口袋 / 袋布", name_en: "Pocket & Pocket Bag", description_zh: "贴袋、插袋、风琴工装袋与内袋布包边", description_en: "Patch pockets, welt pockets, cargo pockets, and interior pocket bags", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 10 },
  { code: "lining", name_zh: "内衬 / 里布 / 内胆", name_en: "Lining & Interlining", description_zh: "服装内部里布、压胶内层、夹棉及可拆卸内胆", description_en: "Interior fabric lining, fusible interlining, quilted batting, or detachable liner", applicable_group_codes: ["tops", "bottoms", "dresses_sets", "outerwear", "special_apparel"], sort_order: 11 },
  { code: "waistband", name_zh: "腰头 / 橡筋", name_en: "Waistband & Elastic", description_zh: "裤腰、裙腰、松紧带、腰耳及抽绳腰头", description_en: "Trouser/skirt waistband, encased elastic, belt loops, and drawstring casing", applicable_group_codes: ["bottoms", "dresses_sets", "underwear_activewear", "special_apparel"], sort_order: 12 },
  { code: "inseam", name_zh: "裤内长（内骨）", name_en: "Inseam (Inner Leg Seam)", description_zh: "裆底交叉点沿内侧裤缝至裤脚口", description_en: "Inner leg seam measured from crotch intersection to leg opening", applicable_group_codes: ["bottoms", "dresses_sets", "underwear_activewear", "special_apparel"], sort_order: 13 },
  { code: "crotch", name_zh: "裆部（前浪/后浪/底裆）", name_en: "Crotch / Rise / Gusset", description_zh: "前浪/后浪十字交汇处及贴身内档加固片", description_en: "Front/back rise intersection, cross-seam alignment, and inner gusset", applicable_group_codes: ["bottoms", "dresses_sets", "underwear_activewear", "special_apparel"], sort_order: 14 },
  { code: "hood", name_zh: "帽兜 / 帽檐 / 帽绳", name_en: "Hood & Drawcord", description_zh: "连帽衫与外套帽片、双层帽里及帽绳部件", description_en: "Two/three-piece hood shell, hood lining, visor brim, and drawcord", applicable_group_codes: ["tops", "outerwear", "special_apparel"], sort_order: 15 },
  { code: "strap", name_zh: "肩带 / 调节扣", name_en: "Shoulder Strap & Adjusters", description_zh: "吊带、文胸、泳衣及塑身衣肩带与调节五金", description_en: "Camisole, bra, swimwear, or shapewear straps and metal/plastic sliders", applicable_group_codes: ["tops", "bottoms", "dresses_sets", "underwear_activewear"], sort_order: 16 },
  { code: "print_area", name_zh: "印花图案区", name_en: "Print / Graphic Area", description_zh: "丝网印、数码直喷、热转印或烫金区域", description_en: "Screen print, DTG, heat-transfer, or foil graphic placement area", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 17 },
  { code: "embroidery_area", name_zh: "刺绣 / 贴布 / 钉珠区", name_en: "Embroidery / Applique / Beading Area", description_zh: "平绣、毛巾绣、贴布绣与重工钉珠亮片区", description_en: "Flat/chenille embroidery, applique patch, or sequin/beaded zone", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 18 },
  { code: "care_label", name_zh: "洗水唛 / 成分标", name_en: "Care & Composition Label", description_zh: "侧缝内侧织唛/印唛洗涤及成分标注标签", description_en: "Interior side-seam woven/printed care instructions & fiber content tag", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 19 },
  { code: "brand_label", name_zh: "主标（领标/腰标）与尺码标", name_en: "Main Brand Label & Size Tab", description_zh: "后领中或腰头中缝主商标及尺码标识", description_en: "Center-back neck/waist brand label and size indicator tab", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 20 },
  { code: "hangtag", name_zh: "吊牌 / 吊粒 / 合格证", name_en: "Hangtag & Fastener", description_zh: "纸质吊牌、塑料枪针或棉绳吊粒附件", description_en: "Cardstock hangtag, swift-tack barb, or string seal fastener", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 21 },
  { code: "polybag_packaging", name_zh: "单件内包装袋及贴码", name_en: "Individual Polybag & Sticker", description_zh: "单件胶袋/拉链磨砂袋、透气孔及外袋 SKU 贴纸", description_en: "Individual garment polybag, suffocation warning/air hole, and SKU sticker", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 22 },
  { code: "outer_carton", name_zh: "入库/发货外箱", name_en: "Master Outer Carton", description_zh: "来料纸箱或集中封箱波纹箱体与封箱胶带", description_en: "Incoming corrugated shipping carton, tape seal, and exterior shipping marks", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 23 },
  { code: "fabric_surface", name_zh: "面料大身正反面", name_en: "Main Fabric Body Surface", description_zh: "成衣大身梭织/针织/皮革主面料表面", description_en: "Primary woven, knit, fleece, or leather exterior shell surface", applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 24 },
];

const NON_AQL_ZH = "本缺陷分类仅用于单件逐件质量记录与客户处置沟通，绝不构成统计 AQL 整批抽检放行判定。";
const NON_AQL_EN = "Used strictly for piece-by-piece defect documentation and customer disposition; does NOT constitute a statistical AQL batch pass/fail certification.";

export const SEED_DEFECT_TYPES: readonly {
  code: string;
  name_zh: string;
  name_en: string;
  category_group: string;
  default_severity: "minor" | "major" | "critical_safety";
  severity_guidance_zh: string;
  severity_guidance_en: string;
  applicable_part_codes: string[];
  applicable_group_codes: string[];
  sort_order: number;
}[] = [
  { code: "stain_soiling", name_zh: "污渍 / 油污 / 水印", name_en: "Stain / Oil Spot / Soiling", category_group: "appearance", default_severity: "major", severity_guidance_zh: "不可擦除油污或正面显眼处大面积脏污为重大缺陷；可拍落微尘仅记录提示。", severity_guidance_en: "Visible permanent oil/ink stain or front soiling is Major; brushable dust is Minor/note.", applicable_part_codes: ["fabric_surface", "collar", "cuff", "hem"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 1 },
  { code: "hole_tear_damage", name_zh: "破洞 / 撕裂 / 剪坏", name_en: "Hole / Tear / Cut Damage", category_group: "appearance", default_severity: "major", severity_guidance_zh: "任意穿孔、纱线断裂破洞或裁剪割破均属重大缺陷。", severity_guidance_en: "Any through-hole, fabric tear, or scissor nick is Major.", applicable_part_codes: ["fabric_surface", "side_seam", "pocket"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 2 },
  { code: "broken_skip_stitch", name_zh: "断线 / 跳针", name_en: "Broken Stitch / Skipped Stitch", category_group: "workmanship", default_severity: "major", severity_guidance_zh: "关键受力部位或正面明线连续跳针/断线为重大缺陷；隐蔽处单针跳线为轻微。", severity_guidance_en: "Broken or skipped stitches on stressed seams or visible topstitching are Major.", applicable_part_codes: ["shoulder", "side_seam", "collar", "hem"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 3 },
  { code: "open_seam", name_zh: "开线 / 爆口 / 漏缝", name_en: "Open Seam / Raw Edge Exposed", category_group: "workmanship", default_severity: "major", severity_guidance_zh: "未锁紧或接缝脱开导致透口露毛边为重大缺陷。", severity_guidance_en: "Unstitched gap or bursting seam exposing raw edges is Major.", applicable_part_codes: ["shoulder", "side_seam", "inseam", "crotch", "sleeve"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 4 },
  { code: "puckering_twisted_seam", name_zh: "起皱 / 扭骨 / 歪斜", name_en: "Seam Puckering / Garment Twist", category_group: "workmanship", default_severity: "minor", severity_guidance_zh: "轻微车缝张力起皱为轻微；严重影响穿着平顺度或裤脚扭骨超1.5cm为重大。", severity_guidance_en: "Mild seam tension wave is Minor; obvious twisting affecting drape (>1.5cm) is Major.", applicable_part_codes: ["side_seam", "zipper", "hem", "collar"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 5 },
  { code: "loose_threads", name_zh: "多余长线头 / 线结", name_en: "Untrimmed Loose Threads", category_group: "workmanship", default_severity: "minor", severity_guidance_zh: "超过1cm未修剪线头较多影响观感记为轻微缺陷（非开线）。", severity_guidance_en: "Untrimmed thread tails >1cm without seam unraveling; classified as Minor.", applicable_part_codes: ["fabric_surface", "button", "hem"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 6 },
  { code: "color_shade_variation", name_zh: "明显色差 / 批差 / 阴阳片", name_en: "Color Shading / Panel Shade Variation", category_group: "color_fabric", default_severity: "major", severity_guidance_zh: "同件服装前后片、袖身与大身或套装上下件肉眼可辨色差为重大缺陷。", severity_guidance_en: "Noticeable shade difference between panels on the same piece or top/bottom of a set is Major.", applicable_part_codes: ["fabric_surface", "sleeve", "collar"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 7 },
  { code: "dye_bleeding_transfer", name_zh: "串色 / 搭色 / 干擦掉色", name_en: "Dye Bleeding / Color Transfer", category_group: "color_fabric", default_severity: "major", severity_guidance_zh: "拼色边界渗色、叠压印染迁移或轻擦白布明显沾色为重大缺陷。", severity_guidance_en: "Dye migration across contrast panels or heavy dry transfer onto white test cloth is Major.", applicable_part_codes: ["fabric_surface", "collar", "cuff"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 8 },
  { code: "print_cracking_misalignment", name_zh: "印花开裂 / 偏位 / 粘连 / 模糊", name_en: "Print Cracking / Misalignment / Tackiness", category_group: "craftsmanship", default_severity: "major", severity_guidance_zh: "主体图案偏歪明显、龟裂掉漆或双面粘花为重大缺陷；极微边缘飞墨记为轻微。", severity_guidance_en: "Cracked ink, peeled transfer, smeared registration, or adhesive sticking is Major.", applicable_part_codes: ["print_area"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 9 },
  { code: "embroidery_defect", name_zh: "刺绣脱线 / 垫纸残留 / 露底", name_en: "Embroidery Defect / Backing Residue", category_group: "craftsmanship", default_severity: "minor", severity_guidance_zh: "大面积跳线露底布或字母错拼为重大；背面衬纸微留未撕净可先记轻微。", severity_guidance_en: "Exposed base fabric or misspelled motif is Major; minor untrimmed stabilizer is Minor.", applicable_part_codes: ["embroidery_area"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 10 },
  { code: "pilling_snagging_fabric_flaw", name_zh: "起球 / 勾丝 / 抽纱 / 织疵", name_en: "Pilling / Snagging / Weaving Flaw", category_group: "color_fabric", default_severity: "major", severity_guidance_zh: "大身明显勾丝抽纱、粗节横档或表面严重起球影响整洁为重大缺陷。", severity_guidance_en: "Visible snags, pulled loops, barre stripes, or surface pilling in primary view is Major.", applicable_part_codes: ["fabric_surface"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 11 },
  { code: "hardware_zipper_button_defect", name_zh: "拉链卡滞 / 掉扣 / 五金氧化", name_en: "Zipper Jamming / Missing Button / Hardware Flaw", category_group: "hardware", default_severity: "major", severity_guidance_zh: "拉链拉不开/爆牙、少扣或锋利毛刺为重大；五金微划痕依部位记轻微或重大。", severity_guidance_en: "Non-functioning zipper, missing/loose button, or sharp hardware burr is Major.", applicable_part_codes: ["zipper", "button", "strap"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 12 },
  { code: "wrong_missing_label", name_zh: "错标 / 漏标 / 标歪 / 吊牌不符", name_en: "Wrong / Missing / Misaligned Label or Hangtag", category_group: "labeling", default_severity: "major", severity_guidance_zh: "尺码标与实物/吊牌冲突、缺主标或洗水唛装反无法辨认为重大；轻微缝歪为轻微。", severity_guidance_en: "Conflicting size label vs hangtag, missing required tag, or illegible care label is Major.", applicable_part_codes: ["brand_label", "care_label", "hangtag"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 13 },
  { code: "wrong_size_spec_mismatch", name_zh: "错码 / 实测尺寸严重超公差", name_en: "Wrong Size / Spec Measurement Out of Tolerance", category_group: "measurement", default_severity: "major", severity_guidance_zh: "超过锁定模板公差上限（如胸围/腰围/衣长超标且复测确认）记为重大尺寸不符。", severity_guidance_en: "Confirmed after 2-attempt measurement to exceed locked template tolerance bands -> Major.", applicable_part_codes: ["chest", "waistband", "shoulder", "inseam"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 14 },
  { code: "asymmetry_distortion", name_zh: "左右不对称（袖长/裤长/领尖/袋位）", name_en: "Left-Right Asymmetry / Distortion", category_group: "measurement", default_severity: "major", severity_guidance_zh: "左右袖长、裤脚或口袋高低差超出视觉容许与公差范围记为重大。", severity_guidance_en: "Noticeable left/right difference in sleeves, legs, collar tips, or pockets is Major.", applicable_part_codes: ["sleeve", "pocket", "collar", "hem"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 15 },
  { code: "lining_interlining_defect", name_zh: "里布吊紧 / 粘合衬起泡 / 脱胶", name_en: "Lining Tension / Interlining Bubbling", category_group: "workmanship", default_severity: "major", severity_guidance_zh: "面里布互相拉扯导致外衣褶皱变形或领口粘合衬起泡为重大缺陷。", severity_guidance_en: "Lining pulling outer shell out of shape or delaminated collar/placket interlining bubbles is Major.", applicable_part_codes: ["lining", "collar"], applicable_group_codes: ["tops", "dresses_sets", "outerwear", "special_apparel"], sort_order: 16 },
  { code: "fill_leakage_clumping", name_zh: "钻绒跑毛 / 充绒不均 / 结块", name_en: "Down Leakage / Uneven Fill / Clumping", category_group: "outerwear_special", default_severity: "major", severity_guidance_zh: "羽绒针孔持续钻出羽梗或局部格位空腔结块属重大缺陷。", severity_guidance_en: "Continuous feather/down poke-through or clumped/empty baffles is Major.", applicable_part_codes: ["lining", "fabric_surface", "side_seam"], applicable_group_codes: ["outerwear", "special_apparel"], sort_order: 17 },
  { code: "unusual_odor_mold", name_zh: "明显异味 / 霉味 / 潮湿霉点", name_en: "Unusual Odor / Musty Smell / Mold", category_group: "safety_hygiene", default_severity: "critical_safety", severity_guidance_zh: "发现可见霉斑、刺鼻化学品气味或贴身/婴童装异味，应立刻隔离标记高风险安全瑕疵。", severity_guidance_en: "Visible mold, pungent chemical fumes, or severe odor is Critical Safety / Hygiene.", applicable_part_codes: ["fabric_surface", "polybag_packaging"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 18 },
  { code: "packaging_barcode_defect", name_zh: "包装破损 / 错贴码 / 条码无法识别", name_en: "Packaging Tear / Wrong Barcode Sticker", category_group: "packaging", default_severity: "minor", severity_guidance_zh: "内袋破损可建议换袋处置；贴错 SKU 条码或水浸损污则记为重大履约风险。", severity_guidance_en: "Torn polybag alone is Minor; wrong SKU barcode sticker risking inventory mix-up is Major.", applicable_part_codes: ["polybag_packaging", "outer_carton", "hangtag"], applicable_group_codes: ALL_APPAREL_GROUPS, sort_order: 19 },
];

export const SEED_REWORK_TYPES: readonly {
  code: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  platform_fault_free_rework: boolean;
  requires_customer_approval: boolean;
  sort_order: number;
}[] = [
  { code: "re_measurement", name_zh: "重测复核尺寸", name_en: "Re-Measurement Verification", description_zh: "按客户复议或复核质疑对指定 POM 点位重新铺平双次测量并附刻度尺照片。", description_en: "Re-flatten garment and perform fresh double measurement of contested POM with scale photo.", platform_fault_free_rework: false, requires_customer_approval: true, sort_order: 1 },
  { code: "re_shoot_evidence", name_zh: "补拍/重拍标准机位原图", name_en: "Re-Shoot Standard Station Photos", description_zh: "按清晰度、光照或角度要求重新拍摄指定机位静态高清原图。", description_en: "Re-capture sharp, properly lit station photos for requested garment angles.", platform_fault_free_rework: false, requires_customer_approval: true, sort_order: 2 },
  { code: "additional_close_up", name_zh: "追加细节/特写拍摄", name_en: "Additional Close-Up Capture", description_zh: "针对面料纹理、针迹、五金内侧或特定辅料追加高倍率微距特写照片。", description_en: "Capture additional macro close-up photos of fabric texture, stitching, or interior hardware.", platform_fault_free_rework: false, requires_customer_approval: true, sort_order: 3 },
  { code: "re_check_defect", name_zh: "指定部位/疑似缺陷复检", name_en: "Targeted Defect Re-Inspection", description_zh: "再次调出实物复核某疑似污渍是否可拭去或确认双面缺陷范围。", description_en: "Retrieve physical garment to verify whether a mark is brushable lint or confirm defect scope.", platform_fault_free_rework: false, requires_customer_approval: true, sort_order: 4 },
  { code: "re_verify_label_barcode", name_zh: "洗水唛/吊牌/条码重核", name_en: "Label & Barcode Re-Verification", description_zh: "再次展开核查水洗标全页正反文字、成分比例文本或扫读条码数字。", description_en: "Re-inspect multi-page care label text, brand label, and barcode scan value.", platform_fault_free_rework: false, requires_customer_approval: true, sort_order: 5 },
  { code: "re_weigh_garment", name_zh: "重称整衣克重", name_en: "Re-Weigh Finished Garment", description_zh: "在去袋并校准电子秤后重新称重并重拍秤面读数照片。", description_en: "Re-zero calibrated scale, remove packaging, re-weigh garment in grams, and photograph display.", platform_fault_free_rework: false, requires_customer_approval: true, sort_order: 6 },
  { code: "re_inspect_after_return_replacement", name_zh: "退换新到货件复检", name_en: "Re-Inspection After Supplier Replacement", description_zh: "商家换货新到仓的替代实物，按原订单标准重新执行质检。", description_en: "Full inspection of supplier-dispatched replacement piece received after prior return.", platform_fault_free_rework: false, requires_customer_approval: true, sort_order: 7 },
  { code: "platform_missed_check_rework", name_zh: "平台漏检责任免费返工", name_en: "Platform Missed-Check Free Rework", description_zh: "复核或客户投诉查实为仓库漏执行已购买模块或明显错判导致的平台责任免费重检。", description_en: "Free platform-liability rework triggered when paid checks were missed or misclassified by staff.", platform_fault_free_rework: true, requires_customer_approval: false, sort_order: 8 },
  { code: "platform_evidence_quality_rework", name_zh: "平台取证画质不达标免费返工", name_en: "Platform Evidence-Quality Free Rework", description_zh: "复核驳回的模糊、欠曝、遮挡刻度尺或误传照片引发的平台内部免费重拍返工。", description_en: "Free internal rework triggered by QA rejection of blurry, underexposed, or blocked scale photos.", platform_fault_free_rework: true, requires_customer_approval: false, sort_order: 9 },
];

type SeedTermPair = {
  term_code: string;
  domain: "garment_type" | "measurement_pom" | "defect" | "part" | "module" | "sop" | "boundary_disclaimer";
  context_categories: string[];
  zh: { standard_name: string; definition: string; synonyms: string[]; forbidden_translations: string[]; method_and_limits: string };
  en: { standard_name: string; definition: string; synonyms: string[]; forbidden_translations: string[]; method_and_limits: string };
};

export const SEED_TERM_PAIRS: readonly SeedTermPair[] = [
  {
    term_code: "pom_chest_width_half",
    domain: "measurement_pom",
    context_categories: ["tops", "outerwear", "dresses_sets"],
    zh: { standard_name: "1/2胸围（平铺胸宽）", definition: "服装完全平铺状态下，袖笼底点下约 2.5cm 处从左侧缝量至右侧缝的直线半围尺寸。", synonyms: ["平铺胸宽", "半胸围"], forbidden_translations: ["Full Chest Circumference（禁止直接当整圈周长）"], method_and_limits: "须在单层整平不拉伸下测量；如需整圈周长须另由派生公式 ×2 标明。" },
    en: { standard_name: "Chest Width (1/2 Chest)", definition: "Straight flat-lay measurement from side seam to side seam ~2.5 cm below the armhole.", synonyms: ["Half Chest Width", "Chest Flat"], forbidden_translations: ["Full Bust Circumference", "Total Chest Girth"], method_and_limits: "Flat unstretched measure; full circumference is a separate derived metric (2× 1/2 Chest)." },
  },
  {
    term_code: "pom_chest_circumference_derived",
    domain: "measurement_pom",
    context_categories: ["tops", "outerwear", "dresses_sets"],
    zh: { standard_name: "胸围全周长（派生值 = 2 × 1/2胸围）", definition: "由平铺 1/2胸围乘以 2 计算得到的参考整圈胸围尺寸，报告中须标注为派生计算结果。", synonyms: ["整圈胸围"], forbidden_translations: ["1/2胸宽"], method_and_limits: "非直接围量人体，严格派生自已测 1/2胸围。" },
    en: { standard_name: "Chest Circumference (Derived = 2× 1/2 Chest)", definition: "Reference full chest girth derived strictly by doubling measured 1/2 chest width; labeled as derived.", synonyms: ["Full Chest Girth (Derived)"], forbidden_translations: ["Half Chest"], method_and_limits: "Computed from flat 1/2 chest width; explicitly marked as derived." },
  },
  {
    term_code: "pom_inseam_vs_outseam",
    domain: "measurement_pom",
    context_categories: ["bottoms", "underwear_activewear"],
    zh: { standard_name: "裤内长（Inseam）", definition: "从裤裆十字交叉缝起沿内侧腿缝直线量至裤脚底边的长度，严格区分外侧裤长（Outseam）。", synonyms: ["内档长", "内侧裤长"], forbidden_translations: ["外侧裤长", "Outseam", "Total Pants Length"], method_and_limits: "必须由裤裆底交叉点起尺，不可从腰头上沿起尺。" },
    en: { standard_name: "Inseam (Inner Leg Length)", definition: "Length measured along the inner leg seam from the crotch cross-seam to the bottom hem opening; strictly distinct from Outseam.", synonyms: ["Inside Leg"], forbidden_translations: ["Outseam", "Full Trouser Length"], method_and_limits: "Starts strictly at crotch seam intersection, never at waistband." },
  },
  {
    term_code: "pom_outseam",
    domain: "measurement_pom",
    context_categories: ["bottoms"],
    zh: { standard_name: "裤外长（含腰头侧长）", definition: "沿裤身外侧骨线从腰头上沿最外点量至裤脚底边的总外侧长度。", synonyms: ["裤全长", "侧缝总长"], forbidden_translations: ["内长", "Inseam"], method_and_limits: "报告须明确说明包含腰头宽度。" },
    en: { standard_name: "Outseam (Side Length incl. Waistband)", definition: "Length measured along the outer side seam from top edge of waistband down to bottom hem.", synonyms: ["Side Seam Length"], forbidden_translations: ["Inseam", "Crotch Length"], method_and_limits: "Explicitly includes waistband height." },
  },
  {
    term_code: "boundary_gross_weight_vs_gsm",
    domain: "boundary_disclaimer",
    context_categories: ALL_APPAREL_GROUPS,
    zh: { standard_name: "整衣实称克重（非面料 GSM）", definition: "整件成品服装在已校准电子秤上实称的总重量（克 g）。绝对不等同于面料单位面积质量（GSM / g/m²）。", synonyms: ["成衣单件重量", "Finished Garment Weight"], forbidden_translations: ["面料克重", "Fabric GSM", "g/m²"], method_and_limits: "仅 M05 具备圆盘取样器及客户明确破坏性授权时才可测定真实 GSM。" },
    en: { standard_name: "Finished Garment Weight (Grams, NOT GSM)", definition: "Total physical mass of a single finished garment measured in grams (g) on a calibrated scale. NEVER equals fabric areal weight (GSM, g/m²).", synonyms: ["Garment Gross Weight"], forbidden_translations: ["Fabric GSM", "Grams per Square Meter", "Fabric Weight g/m²"], method_and_limits: "Areal GSM requires destructive circular cutting under Module M05 with explicit customer authorization." },
  },
  {
    term_code: "boundary_label_vs_lab_compliance",
    domain: "boundary_disclaimer",
    context_categories: ALL_APPAREL_GROUPS,
    zh: { standard_name: "标签外观核查（非成分与法规认证）", definition: "核查洗水唛/成分标/吊牌物理存在与字迹清晰度，绝不构成纤维成分实验室检测、OEKO-TEX 或进出口法规合格认证。", synonyms: ["水洗标目视核查"], forbidden_translations: ["实验室成分鉴定", "合规认证证书", "Lab Compliance Certificate"], method_and_limits: "仅能确认标签印刷文本现状与缝制位置。" },
    en: { standard_name: "Visual Label Check (NOT Lab / Regulatory Compliance)", definition: "Visual verification of label presence, legibility, and stitching; NEVER constitutes lab fiber testing or statutory safety/import compliance certification.", synonyms: ["Care Label Visual Check"], forbidden_translations: ["Lab Fiber Certification", "Regulatory Compliance Approval"], method_and_limits: "Documents visible printed/woven text on label only." },
  },
  {
    term_code: "boundary_piece_qc_vs_aql",
    domain: "boundary_disclaimer",
    context_categories: ALL_APPAREL_GROUPS,
    zh: { standard_name: "逐件全检记录（非 AQL 整批抽检放行）", definition: "对客户实际委托入库的所有件数逐一独立检验并形成单件证据，不使用 AQL 抽样接收标准或签发整批放行合格证。", synonyms: ["100%逐件质检"], forbidden_translations: ["AQL 2.5 抽检合格", "AQL Lot Pass Certificate"], method_and_limits: "按件输出所见事实与客户自主处置选项。" },
    en: { standard_name: "Piece-by-Piece Inspection (NOT Statistical AQL Sampling)", definition: "Individual 100% factual inspection of every commissioned garment piece; does NOT perform statistical AQL sampling or issue lot-acceptance certificates.", synonyms: ["100% Piece Inspection"], forbidden_translations: ["AQL 2.5 Pass", "Statistical Lot Release"], method_and_limits: "Reports observed condition per piece for customer-directed disposition." },
  },
  {
    term_code: "defect_pilling_vs_snagging",
    domain: "defect",
    context_categories: ALL_APPAREL_GROUPS,
    zh: { standard_name: "起球（Pilling）与勾丝（Snagging）区分术语", definition: "起球指纤维缠结形成的小毛球；勾丝指单根长丝或纱线被钩拉出织物表面的线环或抽紧痕。", synonyms: ["起毛球", "勾丝抽纱"], forbidden_translations: ["将起球与抽纱破洞混用"], method_and_limits: "在报告缺陷卡片中须配对特写照精确标注。" },
    en: { standard_name: "Pilling vs. Snagging Distinction", definition: "Pilling denotes entangled fiber balls on the surface; snagging denotes pulled yarn loops or drawn threads caught on sharp points.", synonyms: ["Surface Fuzz Balls / Pulled Loops"], forbidden_translations: ["Hole / Open Seam"], method_and_limits: "Use exact code pilling_snagging_fabric_flaw and clarify type in bilingual remark." },
  },
  {
    term_code: "defect_shading_vs_bleeding",
    domain: "defect",
    context_categories: ALL_APPAREL_GROUPS,
    zh: { standard_name: "色差（Shading）与串色沾色（Dye Bleeding）区分术语", definition: "色差指裁片或件与件之间的染色深浅/色相差异；串色指拼色边缘染料洇染迁移至浅色区。", synonyms: ["缸差", "洇色搭色"], forbidden_translations: ["将裁片缸差译作洗水掉色"], method_and_limits: "须同光线同帧对比拍摄。" },
    en: { standard_name: "Color Shading vs. Dye Bleeding Distinction", definition: "Shading is dye-lot tone variance across panels or pieces; bleeding is dye migration staining adjacent contrast areas.", synonyms: ["Lot Shade Variance / Color Migration"], forbidden_translations: ["Print Cracking"], method_and_limits: "Photograph panels together under uniform desk lighting." },
  },
  {
    term_code: "defect_skipped_stitch",
    domain: "defect",
    context_categories: ALL_APPAREL_GROUPS,
    zh: { standard_name: "跳针（Skipped Stitch）", definition: "缝纫过程中底线与面线未交织锁定形成的空档或超长浮线，受力易引发开线。", synonyms: ["浮线漏针"], forbidden_translations: ["Loose Thread（普通多余线头）"], method_and_limits: "须在特写中拨开相邻织物显示线迹空档。" },
    en: { standard_name: "Skipped Stitch", definition: "Missed needle/bobbin lock along a seam creating an elongated gap stitch prone to seam failure.", synonyms: ["Dropped Stitch"], forbidden_translations: ["Untrimmed Thread Tail"], method_and_limits: "Capture macro photo clearly displaying missed stitch interval." },
  },
  {
    term_code: "defect_seam_puckering",
    domain: "defect",
    context_categories: ALL_APPAREL_GROUPS,
    zh: { standard_name: "缝线起皱（Seam Puckering）", definition: "缝线张力过高或推拉布料不均导致接缝呈现波浪皱缩。", synonyms: ["扯皱", "波浪骨"], forbidden_translations: ["Twisted Leg（整条裤脚扭骨）"], method_and_limits: "自然平铺后仍明显皱缩方判定。" },
    en: { standard_name: "Seam Puckering", definition: "Wavy rippling along a stitched seam caused by thread tension or differential fabric feed.", synonyms: ["Seam Rippling"], forbidden_translations: ["Storage Crease"], method_and_limits: "Assessed after smoothing garment flat without steam pressing." },
  },
  {
    term_code: "part_raglan_armhole",
    domain: "part",
    context_categories: ["tops", "outerwear"],
    zh: { standard_name: "插肩袖笼线（Raglan Seam）", definition: "从腋下斜向延伸至领口侧边的对角线拼接缝，用于部分卫衣与运动外套。", synonyms: ["插肩斜缝"], forbidden_translations: ["Set-in Shoulder Drop（平肩袖缝）"], method_and_limits: "量测肩袖长时从后领中量至袖口。" },
    en: { standard_name: "Raglan Seam", definition: "Diagonal seam extending from underarm to collar edge on raglan-sleeve tops and jackets.", synonyms: ["Diagonal Sleeve Seam"], forbidden_translations: ["Dropped Shoulder Seam"], method_and_limits: "Measure across shoulder + sleeve from center back neck." },
  },
  {
    term_code: "part_placket_zipper_fly",
    domain: "part",
    context_categories: ["tops", "bottoms", "outerwear"],
    zh: { standard_name: "门襟 / 裤裆门襟（Placket / Fly）", definition: "前襟叠压装扣片区或裤前中心拉链遮盖布。", synonyms: ["前门襟", "小襟贴"], forbidden_translations: ["Side Seam Pocket"], method_and_limits: "需翻转内衬查看挡风片及止口锁紧。" },
    en: { standard_name: "Placket / Trouser Fly", definition: "Folded front fabric panel supporting buttons/snaps or concealing front trouser zipper.", synonyms: ["Front Placket", "Zipper Fly"], forbidden_translations: ["Waistband Loop"], method_and_limits: "Check interior facing and bartack reinforcement." },
  },
  {
    term_code: "part_gusset",
    domain: "part",
    context_categories: ["bottoms", "underwear_activewear"],
    zh: { standard_name: "裆底插片（Gusset）", definition: "裤裆或贴身衣物底部用于增强活动量与加固的四片交汇菱形/椭圆形插布。", synonyms: ["内档加固片", "菱形裆布"], forbidden_translations: ["Outer Pocket Bag"], method_and_limits: "内翻检查四边包缝或无痕贴合状态。" },
    en: { standard_name: "Crotch Gusset", definition: "Diamond or contoured fabric inset at crotch intersection improving mobility and seam durability.", synonyms: ["Inner Gusset Panel"], forbidden_translations: ["Lining Hem"], method_and_limits: "Inspect interior four-point seam lock or bonded edge." },
  },
  {
    term_code: "sop_down_leak_check",
    domain: "sop",
    context_categories: ["outerwear", "special_apparel"],
    zh: { standard_name: "羽绒防钻绒手感与充绒核查规范", definition: "沿所有绗缝针孔、内衬接缝轻拍按压查验钻毛与结块情况，同时称重对比。", synonyms: ["羽绒外套核查SOP"], forbidden_translations: ["实验室蓬松度检验（Fill Power Lab Test）"], method_and_limits: "严禁剪开羽绒胆破坏成衣（除非 M05 GSM 授权）。" },
    en: { standard_name: "Down Leakage & Loft Check SOP", definition: "Manual pat-and-press inspection along baffle stitch lines for feather poke-through and fill clumping alongside gross weight tally.", synonyms: ["Down Jacket QA SOP"], forbidden_translations: ["IDFB Fill Power Lab Certification"], method_and_limits: "Strictly non-destructive; never slit down chamber." },
  },
  {
    term_code: "garment_windbreaker_seam_seal",
    domain: "garment_type",
    context_categories: ["outerwear", "special_apparel"],
    zh: { standard_name: "多层外套压胶接缝检查项", definition: "针对户外防风壳外衣内侧缝隙贴附热熔防水胶带的起翘、气泡、交汇点漏压核查。", synonyms: ["防水压胶条检查"], forbidden_translations: ["耐水压静水压实验室测试"], method_and_limits: "逐条沿着内侧接缝指腹轻压确认贴合平整。" },
    en: { standard_name: "Seam-Sealed Shell Tape Check", definition: "Visual and tactile check of internal heat-welded waterproof seam tape on multi-layer jackets for lifting, air bubbles, or missed intersections.", synonyms: ["Seam Tape Adhesion Check"], forbidden_translations: ["Hydrostatic Head Waterproof Certification"], method_and_limits: "Physical interior inspection; no pressurized water immersion." },
  },
];

export const SEED_SOPS: readonly {
  code: string;
  title_zh: string;
  title_en: string;
  applicable_group_codes: string[];
  applicable_module_codes: string[];
  steps_zh: string[];
  steps_en: string[];
  safety_and_boundary_zh: string;
  safety_and_boundary_en: string;
  sort_order: number;
}[] = [
  {
    code: "SOP_APPAREL_RECEIVING_01",
    title_zh: "服装来料拆包核对与去包装规范",
    title_en: "Apparel Receiving, Unpacking & SKU Matching SOP",
    applicable_group_codes: ALL_APPAREL_GROUPS,
    applicable_module_codes: ["M01", "M08"],
    steps_zh: [
      "1. 扫描来料快递面单并核对客户专属收件码及订单委托编号，未核验归属前不得向客户开放。",
      "2. 剪开外箱前检查箱体受潮破损并留存外箱开箱影像。",
      "3. 逐袋点清实际件数、颜色及尺码标注，发现少件/多件/错款即时记录异常并拍照。",
      "4. 保留原透明包装袋及吊牌附件不丢失，完成检验后按要求复位装袋。"
    ],
    steps_en: [
      "1. Scan incoming parcel tracking number and match customer receiving code and order attribution before releasing visibility.",
      "2. Photograph exterior carton damage or moisture staining prior to opening.",
      "3. Tally exact unpacked quantity, colorway, and size labels; log shortages or mismatches with photo evidence.",
      "4. Preserve original polybag, hangtags, and desiccants for re-bagging after inspection."
    ],
    safety_and_boundary_zh: "严禁丢弃厂家原包装及合格证配件；禁止跨客户混放实物。",
    safety_and_boundary_en: "Never discard original accessories or mix physical goods across customer accounts.",
    sort_order: 1,
  },
  {
    code: "SOP_APPAREL_BASE_QC_02",
    title_zh: "基础外观与做工检验及基准取证规范（M01）",
    title_en: "Standard Base Inspection & Photo Evidence SOP (M01)",
    applicable_group_codes: ALL_APPAREL_GROUPS,
    applicable_module_codes: ["M01", "M09"],
    steps_zh: [
      "1. 将成衣平铺于洁净标准白光台面，抚平自然折痕（不熨烫改变缩率）。",
      "2. 依次拍摄正面全貌、背面全貌及基础主标高清原图（包含于基础检查，不得通过 M09 重复收费）。",
      "3. 沿领口、肩缝、袖笼、侧缝、门襟、下摆及内里逐一翻检车缝与表面瑕疵。",
      "4. 每发现一处缺陷，放置厘米刻度尺紧邻缺陷旁拍摄中景定位照及微距特写。"
    ],
    steps_en: [
      "1. Lay garment smoothly on clean daylight-calibrated bench without steam pressing.",
      "2. Capture original overhead front, back, and primary label photos (included in M01 base; NEVER double-billed via M09).",
      "3. Inspect collar, shoulders, armholes, side seams, placket, hem, and interior lining sequentially.",
      "4. For each detected defect, capture a locator context shot and a macro close-up beside a centimeter scale."
    ],
    safety_and_boundary_zh: "属 100% 逐件全检记录，严禁对客户出具统计抽样 AQL 合格证或品牌真伪鉴定结论。",
    safety_and_boundary_en: "100% piece-by-piece documentation; strictly forbidden from issuing AQL lot certifications or trademark authenticity opinions.",
    sort_order: 2,
  },
  {
    code: "SOP_APPAREL_POM_MEASURE_03",
    title_zh: "成衣平铺关键尺寸测量作业规范（M02）",
    title_en: "Flat-Lay POM Measurement & Double-Attempt SOP (M02)",
    applicable_group_codes: ALL_APPAREL_GROUPS,
    applicable_module_codes: ["M02"],
    steps_zh: [
      "1. 扣好门襟纽扣、拉全拉链，轻拍铺平消除鼓包，不得用力拉扯针织弹力面料。",
      "2. 按对应品类 SVG 图谱定义锁定起止点与单位（cm 或 inch 全程一致）。",
      "3. 录入首次读数并由平台校验公差；触发超差时须重新整平后录入第二次复核读数并附带刻度尺照片。"
    ],
    steps_en: [
      "1. Fasten buttons/zippers and smooth garment flat without stretching knit fabrics.",
      "2. Follow category POM diagram start/end anchor points consistently in locked cm or inch units.",
      "3. Record primary reading; when tolerance breach is flagged, re-smooth garment, record 2nd verification reading, and attach scale photo."
    ],
    safety_and_boundary_zh: "严格区分 1/2 胸围与全胸围、裤内长(Inseam)与裤外长(Outseam)。",
    safety_and_boundary_en: "Strictly distinguish 1/2 Chest vs Derived Full Chest, and Inseam vs Outseam.",
    sort_order: 3,
  },
  {
    code: "SOP_APPAREL_COLOR_FABRIC_04",
    title_zh: "颜色参考对比与面料外观手感检验规范（M03/M04）",
    title_en: "Visual Color Comparison & Fabric Handfeel Inspection SOP (M03/M04)",
    applicable_group_codes: ALL_APPAREL_GROUPS,
    applicable_module_codes: ["M03", "M04"],
    steps_zh: [
      "1. 在固定白光照明与锁定的曝光白平衡下，将样品与确认样或同SKU对比件同框平放比较色泽。",
      "2. 近距检视面料纹理、织法密度、粗细厚薄感、毛羽起球，并读取水洗唛成分文本与订单核对。"
    ],
    steps_en: [
      "1. Place sample alongside reference sample or sibling pieces under locked desk lighting and white balance.",
      "2. Inspect fabric weave, thickness, fuzz/pilling, and handfeel; compare printed care-label fiber text against order specs."
    ],
    safety_and_boundary_zh: "无色差仪不得承诺 Delta E 数值；标签成分文本不代表实验室真实纤维含量检验。",
    safety_and_boundary_en: "No Delta E claims without spectrophotometer; label text != lab fiber composition verification.",
    sort_order: 4,
  },
  {
    code: "SOP_APPAREL_WEIGHT_AND_GSM_05",
    title_zh: "整衣称重与破坏性 GSM 取样严控规范（M05）",
    title_en: "Garment Gross Weight vs Authorized Destructive GSM SOP (M05)",
    applicable_group_codes: ALL_APPAREL_GROUPS,
    applicable_module_codes: ["M05"],
    steps_zh: [
      "1. 常规 M05 称重（$2/件草稿）：去除外塑料袋，在已校准电子秤归零后称取整衣净重（g）并拍摄读数照，明确标注『整衣重量 ≠ 面料 GSM』。",
      "2. 破坏性 M05 GSM（$12/次草稿，仅在拥有审批通过的 fabric_gsm_cutter 能力 AND 系统锁定客户明确破坏性授权时方可执行）：在隐蔽位置裁取 100cm² 样布精称换算 g/m² 并留存授权及毁样照。"
    ],
    steps_en: [
      "1. Non-destructive M05 Gross Weight ($2 draft): Remove polybag, zero calibrated scale, weigh finished garment in grams, photograph readout, label 'Garment weight != Fabric GSM'.",
      "2. Destructive M05 GSM ($12 draft, ONLY if approved fabric_gsm_cutter capability AND explicit customer destructive authorization exist): cut 100cm² swatch, weigh, convert to g/m², archive photo."
    ],
    safety_and_boundary_zh: "严禁把 M05 整衣克数写成面料 GSM；严禁未获客户事前破坏性授权动剪或用圆盘刀。",
    safety_and_boundary_en: "NEVER label garment gross weight as fabric GSM; NEVER perform destructive cutting without explicit pre-authorization.",
    sort_order: 5,
  },
  {
    code: "SOP_APPAREL_TRIMS_VIDEO_SPECIAL_06",
    title_zh: "辅料功能、标签印花、视频摄制及特殊人工服务规范（M06/M07/M10/M11）",
    title_en: "Trims, Labels/Print, Video Demo & Manual Service Escalation SOP (M06/M07/M10/M11)",
    applicable_group_codes: ALL_APPAREL_GROUPS,
    applicable_module_codes: ["M06", "M07", "M10", "M11"],
    steps_zh: [
      "1. M06：拉链全行程开合 3 次，逐粒检验纽扣/按扣/魔术贴/抽绳及可拆卸件。",
      "2. M07：核对全部标签、吊牌、条码与印花刺绣位置，严禁将标签核对表述为法规合规认证。",
      "3. M10/M11：按核定秒数（30s/60s/120s）摄制原片或将礼服/婚纱/特殊装饰/定制清单转入人工评估报价。"
    ],
    steps_en: [
      "1. M06: Cycle zippers 3x; verify buttons, snaps, Velcro, cords, and detachable accessories.",
      "2. M07: Inspect all labels/barcodes and print/embroidery; NEVER claim regulatory compliance certification.",
      "3. M10/M11: Capture raw video clips (30/60/120s) on approved stations or escalate gowns/custom requests to manual quote."
    ],
    safety_and_boundary_zh: "不承担采购代理、卖家退款仲裁、工厂现场 AQL 或无实际能力实验室检测。",
    safety_and_boundary_en: "Excludes sourcing brokerage, seller refund arbitration, factory on-site AQL, and uncapable lab testing.",
    sort_order: 6,
  },
];

export type KnowledgeSeedResult = {
  seed_version: string;
  ran_at: string;
  inserted_counts: Record<string, number>;
  skipped_existing_counts: Record<string, number>;
  apparel_total_count: number;
  apparel_published_sellable_count: number;
  non_apparel_closed_count: number;
};

async function insertSeedV1History(
  db: DB,
  kind: string,
  row: Record<string, unknown>,
  codeCol: string,
  actorId: string,
) {
  await db.query(
    `insert into knowledge_revision_history (
      entity_kind, entity_id, entity_code, version, action, actor_id, snapshot, note
    ) values ($1, $2::uuid, $3, 1, 'seed_v1', $4::uuid, $5::jsonb, $6)`,
    [kind, row.id, String(row[codeCol]), actorId, JSON.stringify(row), `Seeded baseline v1 (${KNOWLEDGE_SEED_VERSION})`],
  );
}

/**
 * Idempotently initializes the full authoritative Product Catalog & Apparel Knowledge Base.
 * Strictly preserves any administrator-edited or published records via ON CONFLICT DO NOTHING,
 * and records immutable seed_v1 baseline snapshots for rollback safety.
 * Non-apparel categories remain non-admitted / draft / not publicly sellable by default.
 */
export async function initializeKnowledgeBase(
  db: DB,
  actor: Actor,
  sessionHash: string,
): Promise<KnowledgeSeedResult> {
  role(actor, "super_admin", "template_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "knowledge:seed-init");

  const inserted: Record<string, number> = {
    complexity_levels: 0,
    inspection_modules: 0,
    product_types: 0,
    check_items: 0,
    garment_parts: 0,
    defect_types: 0,
    rework_types: 0,
    terminology_entries: 0,
    sops: 0,
  };
  const skipped: Record<string, number> = { ...inserted };

  const catRows = (
    await db.query<{ id: string; slug: string }>(
      "select id, slug from categories where slug = any($1::text[])",
      [["apparel", "bags", "home"]],
    )
  ).rows;
  const categoryIdBySlug = new Map(catRows.map((r) => [r.slug, r.id]));

  for (const lvl of SEED_COMPLEXITY_LEVELS) {
    const res = await db.query<Record<string, unknown>>(
      `insert into complexity_levels (
        code, name_zh, name_en, description_zh, description_en,
        suggested_base_price_cents, pricing_mode, pricing_status, requires_commercial_approval,
        adjustment_factors, sort_order, status, is_seed_default, admin_modified, created_by
      ) values (
        $1, $2, $3, $4, $5,
        $6::int, $7, 'draft_unverified', true,
        $8::jsonb, $9::int, 'draft', true, false, $10::uuid
      ) on conflict (code) do nothing returning *`,
      [
        lvl.code,
        lvl.name_zh,
        lvl.name_en,
        lvl.description_zh,
        lvl.description_en,
        lvl.suggested_base_price_cents,
        lvl.pricing_mode,
        JSON.stringify(lvl.adjustment_factors),
        lvl.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.complexity_levels += 1;
      await insertSeedV1History(db, "complexity_level", res.rows[0]!, "code", actor.id);
    } else skipped.complexity_levels += 1;
  }

  for (const mod of SEED_INSPECTION_MODULES) {
    const res = await db.query<Record<string, unknown>>(
      `insert into inspection_modules (
        code, name_zh, name_en, description_zh, description_en,
        module_tier, billing_unit, suggested_price_cents, pricing_tiers, pricing_status, requires_commercial_approval,
        depends_on_codes, conflicts_with_codes, requires_capability_codes,
        scope_boundary_zh, scope_boundary_en, is_destructive_possible, requires_customer_authorization,
        sort_order, status, is_seed_default, admin_modified, created_by
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7, $8::int, $9::jsonb, 'draft_unverified', true,
        $10::text[], $11::text[], $12::text[],
        $13, $14, $15::boolean, $16::boolean,
        $17::int, 'draft', true, false, $18::uuid
      ) on conflict (code) do nothing returning *`,
      [
        mod.code,
        mod.name_zh,
        mod.name_en,
        mod.description_zh,
        mod.description_en,
        mod.module_tier,
        mod.billing_unit,
        mod.suggested_price_cents,
        JSON.stringify(mod.pricing_tiers),
        mod.depends_on_codes,
        mod.conflicts_with_codes,
        mod.requires_capability_codes,
        mod.scope_boundary_zh,
        mod.scope_boundary_en,
        mod.is_destructive_possible,
        mod.requires_customer_authorization,
        mod.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.inspection_modules += 1;
      await insertSeedV1History(db, "inspection_module", res.rows[0]!, "code", actor.id);
    } else skipped.inspection_modules += 1;
  }

  for (const pt of SEED_PRODUCT_TYPES) {
    const catId = categoryIdBySlug.get(pt.category_slug) ?? null;
    const res = await db.query<Record<string, unknown>>(
      `insert into catalog_product_types (
        code, category_id, category_slug, group_code, group_name_zh, group_name_en,
        name_zh, name_en, aliases, default_complexity_code, structural_options,
        billing_unit, included_components, applicable_module_codes, default_evidence_rules,
        quote_mode, capability_status, public_sellable, status, sort_order,
        is_seed_default, admin_modified, created_by
      ) values (
        $1, $2::uuid, $3, $4, $5, $6,
        $7, $8, $9::jsonb, $10, $11::jsonb,
        $12, $13::jsonb, $14::text[], '{"base_mandatory_photos":true,"scale_for_defects":true}'::jsonb,
        $15, $16, false, 'draft', $17::int,
        true, false, $18::uuid
      ) on conflict (code) do nothing returning *`,
      [
        pt.code,
        catId,
        pt.category_slug,
        pt.group_code,
        pt.group_name_zh,
        pt.group_name_en,
        pt.name_zh,
        pt.name_en,
        JSON.stringify(pt.aliases),
        pt.default_complexity_code,
        JSON.stringify(pt.structural_options),
        pt.billing_unit,
        JSON.stringify(pt.included_components),
        pt.applicable_module_codes,
        pt.quote_mode,
        pt.capability_status,
        pt.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.product_types += 1;
      await insertSeedV1History(db, "product_type", res.rows[0]!, "code", actor.id);
    } else skipped.product_types += 1;
  }

  for (const part of SEED_GARMENT_PARTS) {
    const res = await db.query<Record<string, unknown>>(
      `insert into knowledge_garment_parts (
        code, name_zh, name_en, description_zh, description_en,
        applicable_group_codes, sort_order, status, is_seed_default, admin_modified, created_by
      ) values (
        $1, $2, $3, $4, $5, $6::text[], $7::int, 'draft', true, false, $8::uuid
      ) on conflict (code) do nothing returning *`,
      [
        part.code,
        part.name_zh,
        part.name_en,
        part.description_zh,
        part.description_en,
        part.applicable_group_codes,
        part.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.garment_parts += 1;
      await insertSeedV1History(db, "garment_part", res.rows[0]!, "code", actor.id);
    } else skipped.garment_parts += 1;
  }

  for (const item of SEED_CHECK_ITEMS) {
    const res = await db.query<Record<string, unknown>>(
      `insert into knowledge_check_items (
        code, module_code, name_zh, name_en, method_zh, method_en,
        scope_limit_zh, scope_limit_en, applicable_group_codes, applicable_part_codes,
        evidence_requirement, billing_included_in_base, requires_capability_code,
        sort_order, status, is_seed_default, admin_modified, created_by
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9::text[], $10::text[],
        $11, $12::boolean, $13::text,
        $14::int, 'draft', true, false, $15::uuid
      ) on conflict (code) do nothing returning *`,
      [
        item.code,
        item.module_code,
        item.name_zh,
        item.name_en,
        item.method_zh,
        item.method_en,
        item.scope_limit_zh,
        item.scope_limit_en,
        item.applicable_group_codes,
        item.applicable_part_codes,
        item.evidence_requirement,
        item.billing_included_in_base,
        item.requires_capability_code,
        item.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.check_items += 1;
      await insertSeedV1History(db, "check_item", res.rows[0]!, "code", actor.id);
    } else skipped.check_items += 1;
  }

  for (const def of SEED_DEFECT_TYPES) {
    const res = await db.query<Record<string, unknown>>(
      `insert into knowledge_defect_types (
        code, name_zh, name_en, category_group, default_severity,
        severity_guidance_zh, severity_guidance_en, non_aql_disclaimer_zh, non_aql_disclaimer_en,
        applicable_part_codes, applicable_group_codes, sort_order,
        status, is_seed_default, admin_modified, created_by
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10::text[], $11::text[], $12::int,
        'draft', true, false, $13::uuid
      ) on conflict (code) do nothing returning *`,
      [
        def.code,
        def.name_zh,
        def.name_en,
        def.category_group,
        def.default_severity,
        def.severity_guidance_zh,
        def.severity_guidance_en,
        NON_AQL_ZH,
        NON_AQL_EN,
        def.applicable_part_codes,
        def.applicable_group_codes,
        def.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.defect_types += 1;
      await insertSeedV1History(db, "defect_type", res.rows[0]!, "code", actor.id);
    } else skipped.defect_types += 1;
  }

  for (const rw of SEED_REWORK_TYPES) {
    const res = await db.query<Record<string, unknown>>(
      `insert into knowledge_rework_types (
        code, name_zh, name_en, description_zh, description_en,
        platform_fault_free_rework, requires_customer_approval, sort_order,
        status, is_seed_default, admin_modified, created_by
      ) values (
        $1, $2, $3, $4, $5,
        $6::boolean, $7::boolean, $8::int,
        'draft', true, false, $9::uuid
      ) on conflict (code) do nothing returning *`,
      [
        rw.code,
        rw.name_zh,
        rw.name_en,
        rw.description_zh,
        rw.description_en,
        rw.platform_fault_free_rework,
        rw.requires_customer_approval,
        rw.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.rework_types += 1;
      await insertSeedV1History(db, "rework_type", res.rows[0]!, "code", actor.id);
    } else skipped.rework_types += 1;
  }

  for (const pair of SEED_TERM_PAIRS) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const entry = locale === "zh-CN" ? pair.zh : pair.en;
      const res = await db.query<Record<string, unknown>>(
        `insert into knowledge_terminology_entries (
          term_code, domain, locale, version, standard_name, definition,
          context_categories, synonyms, forbidden_translations, method_and_limits,
          status, is_seed_default, admin_modified, created_by
        ) values (
          $1, $2, $3, 1, $4, $5,
          $6::text[], $7::text[], $8::text[], $9,
          'draft', true, false, $10::uuid
        ) on conflict (term_code, locale, version) do nothing returning *`,
        [
          pair.term_code,
          pair.domain,
          locale,
          entry.standard_name,
          entry.definition,
          pair.context_categories,
          entry.synonyms,
          entry.forbidden_translations,
          entry.method_and_limits,
          actor.id,
        ],
      );
      if ((res.rowCount ?? 0) > 0) {
        inserted.terminology_entries += 1;
        await insertSeedV1History(db, "terminology", res.rows[0]!, "term_code", actor.id);
      } else skipped.terminology_entries += 1;
    }
  }

  for (const sop of SEED_SOPS) {
    const res = await db.query<Record<string, unknown>>(
      `insert into knowledge_sops (
        code, title_zh, title_en, applicable_group_codes, applicable_module_codes,
        steps_zh, steps_en, safety_and_boundary_zh, safety_and_boundary_en,
        sort_order, status, is_seed_default, admin_modified, created_by
      ) values (
        $1, $2, $3, $4::text[], $5::text[],
        $6::jsonb, $7::jsonb, $8, $9,
        $10::int, 'draft', true, false, $11::uuid
      ) on conflict (code) do nothing returning *`,
      [
        sop.code,
        sop.title_zh,
        sop.title_en,
        sop.applicable_group_codes,
        sop.applicable_module_codes,
        JSON.stringify(sop.steps_zh),
        JSON.stringify(sop.steps_en),
        sop.safety_and_boundary_zh,
        sop.safety_and_boundary_en,
        sop.sort_order,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) {
      inserted.sops += 1;
      await insertSeedV1History(db, "sop", res.rows[0]!, "code", actor.id);
    } else skipped.sops += 1;
  }

  const runRow = (
    await db.query<{ id: string; ran_at: Date }>(
      `insert into knowledge_seed_runs (seed_version, actor_id, inserted_counts, skipped_existing_counts)
       values ($1, $2::uuid, $3::jsonb, $4::jsonb)
       returning id, ran_at`,
      [KNOWLEDGE_SEED_VERSION, actor.id, JSON.stringify(inserted), JSON.stringify(skipped)],
    )
  ).rows[0];

  await audit(db, actor, "knowledge_seed_init", "knowledge_seed_runs", runRow.id, {
    seed_version: KNOWLEDGE_SEED_VERSION,
    inserted_counts: inserted,
    skipped_existing_counts: skipped,
  });

  const stats = (
    await db.query<{ apparel_total: number; apparel_published_sellable: number; non_apparel_closed: number }>(`
      select
        count(*) filter (where category_slug = 'apparel')::int as apparel_total,
        count(*) filter (where category_slug = 'apparel' and status = 'published' and public_sellable)::int as apparel_published_sellable,
        count(*) filter (where category_slug <> 'apparel' and not public_sellable)::int as non_apparel_closed
      from catalog_product_types
    `)
  ).rows[0];

  return {
    seed_version: KNOWLEDGE_SEED_VERSION,
    ran_at: runRow.ran_at.toISOString(),
    inserted_counts: inserted,
    skipped_existing_counts: skipped,
    apparel_total_count: stats?.apparel_total ?? 0,
    apparel_published_sellable_count: stats?.apparel_published_sellable ?? 0,
    non_apparel_closed_count: stats?.non_apparel_closed ?? 0,
  };
}
