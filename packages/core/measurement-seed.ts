import type { DB } from "../db";
import { requireStaffMfa } from "./auth";
import { audit, lock, role, type Actor } from "./common";
import type { MeasurementPoint, MeasurementSvgView } from "./measurement-templates";
import { validateAndSanitizeSvg } from "./svg-sanitizer";

export const MEASUREMENT_SEED_VERSION = "2026-11-pom-23-v1";

export const SEED_CAMERA_PRESETS = [
  {
    code: "overhead_flat_front",
    name_zh: "正面上方俯拍平铺机位",
    name_en: "Overhead Front Flat-Lay Station Camera",
    view_key: "front",
    framing_notes_zh: "成衣平铺居中，四边留白 8%–10%，标准 5500K 柔和白光。",
    framing_notes_en: "Centered garment flat-lay with 8-10% margin on daylight-calibrated bench.",
    requires_scale_ruler: false,
    recommended_resolution: "2560x1920",
    sort_order: 1,
  },
  {
    code: "overhead_flat_back",
    name_zh: "背面上方俯拍平铺机位",
    name_en: "Overhead Back Flat-Lay Station Camera",
    view_key: "back",
    framing_notes_zh: "背面抚平，后领中及背缝清晰入镜。",
    framing_notes_en: "Smooth back view showing center-back neck, yoke, and rear seams.",
    requires_scale_ruler: false,
    recommended_resolution: "2560x1920",
    sort_order: 2,
  },
  {
    code: "macro_ruler_pom",
    name_zh: "带刻度皮尺实测特写机位",
    name_en: "Scale-Aligned POM Measurement Close-Up",
    view_key: "front",
    framing_notes_zh: "皮尺零刻度与终点刻度必须同框清晰可读，触发超差必拍。",
    framing_notes_en: "Tape start zero mark and endpoint reading sharply visible; mandatory on tolerance breach.",
    requires_scale_ruler: true,
    recommended_resolution: "2560x1920",
    sort_order: 3,
  },
  {
    code: "macro_label_care",
    name_zh: "主标与洗水唛微距机位",
    name_en: "Brand & Care Label Macro Camera",
    view_key: "inside",
    framing_notes_zh: "微距对焦保证文字可读。",
    framing_notes_en: "Macro focus on brand tab and interior care label typography.",
    requires_scale_ruler: false,
    recommended_resolution: "2560x1920",
    sort_order: 4,
  },
  {
    code: "detail_hardware_zipper",
    name_zh: "辅料五金及局部结构机位",
    name_en: "Hardware / Zipper / Trim Detail Camera",
    view_key: "detail",
    framing_notes_zh: "展示拉头止口、扣位、下扒/压胶条细节。",
    framing_notes_en: "Shows slider stops, buttonholes, underband, or seam-tape construction.",
    requires_scale_ruler: true,
    recommended_resolution: "1920x1080",
    sort_order: 5,
  },
  {
    code: "inside_lining_turn",
    name_zh: "翻面内里与侧面立体机位",
    name_en: "Inside-Out Lining / Side Profile Camera",
    view_key: "side",
    framing_notes_zh: "展示多层里衬包边、侧缝开衩或帽兜高度。",
    framing_notes_en: "Inspect interior lining bindings, side slits, or hood height profile.",
    requires_scale_ruler: false,
    recommended_resolution: "1920x1080",
    sort_order: 6,
  },
] as const;

type ShapeKind =
  | "tee_short"
  | "tee_long"
  | "polo_shirt"
  | "hoodie"
  | "sweater"
  | "tank"
  | "trousers"
  | "shorts"
  | "jeans"
  | "leggings"
  | "skirt"
  | "dress"
  | "jumpsuit"
  | "sports_bra"
  | "swimwear"
  | "light_jacket"
  | "heavy_coat"
  | "down_jacket"
  | "blazer"
  | "briefs"
  | "tracksuit_set"
  | "kids_toddler"
  | "special_craft";

const FRONT_PATH: Record<ShapeKind, string> = {
  tee_short: "M170 72 L212 58 Q260 80 308 58 L350 72 L408 138 L372 166 L338 126 L338 308 L182 308 L182 126 L148 166 L112 138 Z",
  tee_long: "M172 70 L212 56 Q260 76 308 56 L348 70 L452 208 L422 228 L338 124 L338 308 L182 308 L182 124 L98 228 L68 208 Z",
  polo_shirt: "M174 74 L216 54 L260 66 L304 54 L346 74 L402 138 L368 164 L336 126 L336 308 L184 308 L184 126 L152 164 L118 138 Z M248 66 L248 136 L272 136 L272 66",
  hoodie: "M198 66 L216 22 Q260 12 304 22 L322 66 L362 84 L446 202 L416 226 L342 130 L342 304 L178 304 L178 130 L104 226 L74 202 L158 84 Z M208 212 L312 212 L324 282 L196 282 Z",
  sweater: "M172 68 L216 54 Q260 74 304 54 L348 68 L448 205 L418 228 L340 126 L340 300 L180 300 L180 126 L102 228 L72 205 Z M180 286 L340 286",
  tank: "M196 58 L224 58 Q260 112 296 58 L324 58 L314 142 L334 306 L186 306 L206 142 Z",
  trousers: "M176 48 L344 48 L364 318 L286 318 L260 156 L234 318 L156 318 Z M176 74 L344 74",
  shorts: "M174 68 L346 68 L372 222 L286 222 L260 154 L234 222 L148 222 Z M174 96 L346 96",
  jeans: "M174 46 L346 46 L364 322 L288 322 L260 150 L232 322 L156 322 Z M174 72 L346 72 M260 72 L260 132 M186 84 Q206 112 224 84 M334 84 Q314 112 296 84",
  leggings: "M186 48 L334 48 L336 82 L344 322 L292 322 L260 148 L228 322 L176 322 L184 82 Z M184 82 L336 82",
  skirt: "M190 66 L330 66 L392 288 L128 288 Z M190 90 L330 90 M220 90 L200 288 M260 90 L260 288 M300 90 L320 288",
  dress: "M194 52 L222 48 Q260 82 298 48 L326 52 L340 128 L320 144 L394 316 L126 316 L200 144 L180 128 Z M198 148 L322 148",
  jumpsuit: "M190 48 L222 44 Q260 74 298 44 L330 48 L348 118 L322 146 L354 324 L284 324 L260 198 L236 324 L166 324 L198 146 L172 118 Z M196 146 L324 146",
  sports_bra: "M186 78 L218 78 Q260 142 302 78 L334 78 L330 170 L342 228 L178 228 L190 170 Z M180 196 L340 196",
  swimwear: "M188 64 L216 64 Q260 126 304 64 L332 64 L322 162 L338 242 Q260 318 182 242 L198 162 Z",
  light_jacket: "M168 68 L216 50 L260 66 L304 50 L352 68 L448 202 L416 226 L342 126 L342 304 L178 304 L178 126 L104 226 L72 202 Z M260 66 L260 304",
  heavy_coat: "M166 66 L216 44 L260 64 L304 44 L354 66 L452 212 L418 234 L344 128 L352 332 L168 332 L176 128 L102 234 L68 212 Z M260 64 L260 332 M224 58 L260 132 L296 58",
  down_jacket: "M162 66 L204 28 L316 28 L358 66 L456 206 L418 232 L346 128 L346 308 L174 308 L174 128 L102 232 L64 206 Z M260 66 L260 308 M174 152 L346 152 M174 202 L346 202 M174 252 L346 252",
  blazer: "M168 68 L216 48 L260 116 L304 48 L352 68 L446 206 L416 226 L340 126 L336 306 L272 306 L260 286 L248 306 L184 306 L180 126 L104 226 L74 206 Z M222 52 L248 158 L260 116 L272 158 L298 52",
  briefs: "M164 112 L356 112 L364 162 L338 192 Q294 218 276 266 L244 266 Q226 218 182 192 L156 162 Z M164 140 L356 140 M230 140 Q260 186 290 140",
  tracksuit_set: "M62 76 L98 62 Q144 80 190 62 L226 76 L264 176 L244 192 L206 122 L206 286 L82 286 L82 122 L44 192 L24 176 Z M294 64 L446 64 L462 308 L392 308 L370 164 L348 308 L278 308 Z M294 88 L446 88",
  kids_toddler: "M176 74 L218 60 Q260 80 302 60 L344 74 L412 158 L384 178 L338 126 L338 262 Q304 294 260 294 Q216 294 182 262 L182 126 L136 178 L108 158 Z M234 274 L286 274",
  special_craft: "M174 68 L216 54 Q260 82 304 54 L346 68 L412 152 L384 176 L338 126 L356 308 L164 308 L182 126 L136 176 L108 152 Z M206 106 L314 106 L314 196 L206 196 Z",
};

const BACK_PATH: Record<ShapeKind, string> = {
  ...FRONT_PATH,
  tee_short: "M170 72 L216 58 Q260 64 304 58 L350 72 L408 138 L372 166 L338 126 L338 308 L182 308 L182 126 L148 166 L112 138 Z",
  polo_shirt: "M174 74 L216 54 Q260 62 304 54 L346 74 L402 138 L368 164 L336 126 L336 308 L184 308 L184 126 L152 164 L118 138 Z M184 102 L336 102",
  hoodie: "M198 66 L216 22 Q260 12 304 22 L322 66 L362 84 L446 202 L416 226 L342 130 L342 304 L178 304 L178 130 L104 226 L74 202 L158 84 Z M260 22 L260 66",
  jeans: "M174 46 L346 46 L364 322 L288 322 L260 150 L232 322 L156 322 Z M174 72 L346 72 M194 94 L244 94 L240 138 L198 138 Z M276 94 L326 94 L322 138 L280 138 Z",
  sports_bra: "M186 78 L218 78 L260 158 L302 78 L334 78 L330 170 L342 228 L178 228 L190 170 Z M180 196 L340 196",
  light_jacket: "M168 68 L216 50 Q260 60 304 50 L352 68 L448 202 L416 226 L342 126 L342 304 L178 304 L178 126 L104 226 L72 202 Z M178 108 L342 108",
  heavy_coat: "M166 66 L216 44 Q260 54 304 44 L354 66 L452 212 L418 234 L344 128 L352 332 L168 332 L176 128 L102 234 L68 212 Z M260 54 L260 332 M176 112 L344 112",
  down_jacket: "M162 66 L204 28 L316 28 L358 66 L456 206 L418 232 L346 128 L346 308 L174 308 L174 128 L102 232 L64 206 Z M174 152 L346 152 M174 202 L346 202 M174 252 L346 252",
  blazer: "M168 68 L216 48 Q260 58 304 48 L352 68 L446 206 L416 226 L340 126 L336 306 L184 306 L180 126 L104 226 L74 206 Z M260 58 L260 286 M248 286 L248 306",
  briefs: "M164 112 L356 112 L364 162 L346 212 Q296 244 276 266 L244 266 Q224 244 174 212 L156 162 Z M164 140 L356 140",
  tracksuit_set: "M62 76 L98 62 Q144 68 190 62 L226 76 L264 176 L244 192 L206 122 L206 286 L82 286 L82 122 L44 192 L24 176 Z M294 64 L446 64 L462 308 L392 308 L370 164 L348 308 L278 308 Z M294 84 L446 84",
  kids_toddler: "M176 74 L218 60 Q260 66 302 60 L344 74 L412 158 L384 178 L338 126 L338 262 Q304 294 260 294 Q216 294 182 262 L182 126 L136 178 L108 158 Z",
  special_craft: "M174 68 L216 54 Q260 64 304 54 L346 68 L412 152 L384 176 L338 126 L356 308 L164 308 L182 126 L136 176 L108 152 Z M260 62 L260 220",
};

function makeViews(shape: ShapeKind, titleZh: string, titleEn: string): MeasurementSvgView[] {
  const rawFront = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 360" width="520" height="360"><rect width="520" height="360" rx="10" fill="#f8fafc" stroke="#cbd5e1"/><text x="18" y="24" font-family="sans-serif" font-size="12" font-weight="bold" fill="#0f172a">${titleEn} · FRONT (${titleZh}正面)</text><path d="${FRONT_PATH[shape]}" fill="#e2e8f0" stroke="#334155" stroke-width="2"/></svg>`;
  const rawBack = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 360" width="520" height="360"><rect width="520" height="360" rx="10" fill="#f8fafc" stroke="#cbd5e1"/><text x="18" y="24" font-family="sans-serif" font-size="12" font-weight="bold" fill="#0f172a">${titleEn} · BACK (${titleZh}背面)</text><path d="${BACK_PATH[shape]}" fill="#e2e8f0" stroke="#334155" stroke-width="2"/></svg>`;
  const vf = validateAndSanitizeSvg(rawFront);
  const vb = validateAndSanitizeSvg(rawBack);
  return [
    { view_key: "front", label_zh: "正面平铺视图", label_en: "Front Flat-Lay View", svg: vf.svg, viewBox: vf.viewBox, width: vf.width, height: vf.height },
    { view_key: "back", label_zh: "背面平铺视图", label_en: "Back Flat-Lay View", svg: vb.svg, viewBox: vb.viewBox, width: vb.width, height: vb.height },
  ];
}

function pt(
  point_id: string,
  marker_code: string,
  view_key: "front" | "back" | "side" | "inside" | "detail",
  name_zh: string,
  name_en: string,
  location_zh: string,
  location_en: string,
  method_zh: string,
  method_en: string,
  coords: [number, number, number, number, number, number],
  color: string,
  tol = 1.0,
  sort_order = 10,
): MeasurementPoint {
  return {
    point_id,
    marker_code,
    view_key,
    name_zh,
    name_en,
    location_zh,
    location_en,
    method_zh,
    method_en,
    start_x: coords[0],
    start_y: coords[1],
    end_x: coords[2],
    end_y: coords[3],
    label_x: coords[4],
    label_y: coords[5],
    guide_line_style: "dashed",
    color,
    unit: "cm",
    value_type: "numeric",
    precision_decimals: 1,
    default_tolerance_plus: tol,
    default_tolerance_minus: tol,
    is_required: true,
    requires_target: false,
    requires_tolerance: true,
    requires_photo: true,
    allow_na: true,
    retest_threshold: 0.5,
    report_visible: true,
    camera_preset_code: "macro_ruler_pom",
    check_item_code: "CHK_M02_UPPER_BODY_POM",
    sort_order,
  };
}

function upperPoints(extra: MeasurementPoint[] = []): MeasurementPoint[] {
  return [
    pt("pom_body_length_hps", "A", "front", "衣长 (HPS)", "Body Length (HPS)", "肩颈最高点至下摆底边", "High Point Shoulder vertically to bottom hem", "垂直平铺拉直从领肩最高点量至底边", "Measure vertically from HPS to bottom hem flat.", [232, 58, 232, 306, 232, 180], "#dc2626", 1.5, 1),
    pt("pom_chest_width_half", "B", "front", "1/2胸围（平铺胸宽）", "Chest Width (1/2 Chest)", "腋下 2.5cm 水平处左侧缝至右侧缝", "2.5cm below armholes seam-to-seam", "平铺不拉伸水平量取腋下2.5cm胸宽", "Measure straight across 2.5cm below armhole flat.", [182, 138, 338, 138, 268, 138], "#059669", 1.0, 2),
    pt("pom_shoulder_width", "C", "front", "肩宽", "Shoulder Width", "左肩点至右肩点", "Shoulder seam to shoulder seam across top", "直线量取两肩点之间距离", "Measure straight across from shoulder point to shoulder point.", [172, 72, 348, 72, 260, 72], "#2563eb", 1.0, 3),
    pt("pom_hem_width_half", "D", "front", "1/2下摆宽", "Bottom Hem Width (1/2)", "下摆底边左侧缝至右侧缝", "Along bottom hem seam-to-seam", "自然平铺下摆边缘量宽", "Measure straight across bottom hem flat.", [182, 294, 338, 294, 260, 294], "#7c3aed", 1.0, 4),
    pt("pom_collar_width", "E", "front", "领口宽", "Neck Width", "内领缘左肩点至右肩点", "Inner neck opening seam to seam", "按自然领弧上端直线测量", "Measure straight inside neck opening across.", [216, 58, 304, 58, 260, 58], "#0891b2", 0.5, 5),
    pt("pom_center_back_length", "F", "back", "后衣长 (CB)", "Center Back Length", "后领中缝至后下摆底边", "Center back neck seam to back hem", "背面铺平从后领中心量至下摆", "Measure vertically from center back neck to hem.", [260, 62, 260, 306, 260, 185], "#dc2626", 1.5, 6),
    ...extra,
  ];
}

function lowerPoints(kind: "long" | "short" | "leggings"): MeasurementPoint[] {
  const isShort = kind === "short";
  const inseamY2 = isShort ? 222 : 320;
  const outY2 = isShort ? 222 : 320;
  const waistY = isShort ? 70 : 52;
  const riseTopY = isShort ? 68 : 50;
  const riseMidY = isShort ? 110 : 102;
  const lowerPts: MeasurementPoint[] = [
    { ...pt("pom_waist_width_half", "A", "front", "1/2腰围（平铺）", "Waist Width (1/2 Flat)", "腰头上沿左至右平铺", "Along top edge of waistband flat", "对齐前后腰头上沿水平拉平测量", "Align front/back waistband flat and measure straight across.", [176, waistY, 344, waistY, 260, waistY], "#2563eb", 1.0, 1), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    { ...pt("pom_hip_width_half", "B", "front", "1/2臀围", "Hip Width (1/2)", "裆底上方约 8cm 处", "Across widest hip area ~8cm above crotch", "平铺水平量测两侧缝臀宽", "Measure straight across fullest hip flat.", [168, 126, 352, 126, 260, 126], "#059669", 1.5, 2), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    { ...pt("pom_front_rise", "C", "front", "前浪", "Front Rise", "腰头上沿至裆十字交叉点", "Top of waistband down to crotch cross-seam", "沿前门襟中心量至裆底交汇点", "Measure from top of front waistband to crotch seam intersection.", [260, riseTopY, 260, 154, 260, riseMidY], "#d97706", 0.8, 3), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    { ...pt("pom_inseam_length", "D", "front", "裤内长 (Inseam)", "Inseam (Inner Leg)", "裆底交叉缝沿内缝至脚口", "Crotch cross-seam along inner leg to hem", "严格从裆底交叉点起尺沿内侧腿缝量至脚口", "Start strictly at crotch intersection along inner seam to hem.", [254, 156, 232, inseamY2, 240, isShort ? 188 : 210], "#dc2626", 1.5, 4), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    { ...pt("pom_outseam_length", "E", "front", "裤外长 (Outseam)", "Outseam (Side Length)", "腰头上沿外侧沿侧骨至脚口", "Outer top edge along side seam to hem", "沿裤外侧缝含腰头总长", "Measure along outer side seam including waistband.", [174, riseTopY, 152, outY2, 160, isShort ? 148 : 185], "#7c3aed", 1.5, 5), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    { ...pt("pom_leg_opening_half", "F", "front", "1/2裤脚口", "Leg Opening (1/2)", "裤脚底边内侧至外侧", "Bottom hem across one leg opening", "自然平铺裤脚底边量宽", "Measure flat across single leg hem opening.", [156, outY2 - 4, 234, inseamY2 - 4, 195, outY2 - 12], "#0891b2", 0.8, 6), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    { ...pt("pom_back_rise", "G", "back", "后浪", "Back Rise", "后腰头上沿至裆十字交叉点", "Center back waistband to crotch seam", "背面拉平量取后浪垂直高度", "Measure center back waist top edge down to crotch intersection.", [260, riseTopY, 260, 154, 260, riseMidY + 4], "#ea580c", 0.8, 7), check_item_code: "CHK_M02_LOWER_BODY_POM" },
  ];
  return lowerPts;
}

export type SeedMeasurementTemplate = {
  code: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  applicable_product_type_codes: string[];
  applicable_group_codes: string[];
  views: MeasurementSvgView[];
  points: MeasurementPoint[];
  camera_preset_codes: string[];
};

// 23 distinct apparel SVG families covering §14 (17+ families), §41.3 (26 garment categories), and all 54 §04 apparel types
export const SEED_MEASUREMENT_TEMPLATES: readonly SeedMeasurementTemplate[] = [
  {
    code: "short_sleeve_top",
    name_zh: "短袖T恤/运动上衣测量模板",
    name_en: "Short-Sleeve Top / Tee Measurement Template",
    description_zh: "适用于圆领短袖T恤、运动短袖及紧身压缩短袖（仅适用上装几何点位，不包含裤内长或重量/GSM）。",
    description_en: "Dedicated upper-body POM diagram for tees and athletic tops (excludes lower-body or non-geometric weight points).",
    applicable_product_type_codes: ["t_shirt", "athletic_top", "fitted_compression_top"],
    applicable_group_codes: ["tops"],
    views: makeViews("tee_short", "短袖上衣", "SHORT SLEEVE TOP"),
    points: upperPoints([
      pt("pom_sleeve_length", "G", "front", "短袖长", "Short Sleeve Length", "肩点沿袖外缘至袖口", "Shoulder point to sleeve opening", "平铺顺直量肩缝至袖口边缘", "Measure from shoulder seam to cuff edge flat.", [350, 72, 408, 138, 382, 104], "#d97706", 0.8, 7),
      pt("pom_cuff_opening_half", "H", "front", "1/2袖口宽", "Sleeve Opening (1/2)", "袖口横截宽度", "Across sleeve hem opening", "平铺袖口量宽", "Measure across flat sleeve opening.", [372, 166, 408, 138, 392, 152], "#0d9488", 0.5, 8),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "macro_label_care"],
  },
  {
    code: "long_sleeve_top",
    name_zh: "长袖打底衫测量模板",
    name_en: "Long-Sleeve Top / Base Layer Template",
    description_zh: "适用于长袖打底衫与长袖T恤，涵盖全袖长与罗纹袖口平铺量测。",
    description_en: "Long-sleeve flat-lay POM diagram with full sleeve length and cuff opening.",
    applicable_product_type_codes: ["base_layer_tee"],
    applicable_group_codes: ["tops"],
    views: makeViews("tee_long", "长袖上衣", "LONG SLEEVE TOP"),
    points: upperPoints([
      pt("pom_long_sleeve_length", "G", "front", "长袖袖长", "Long Sleeve Length", "肩点沿长袖外缘至袖口", "Shoulder seam to wrist cuff edge", "袖管自然铺直量至袖口边", "Measure straight from shoulder point to wrist cuff.", [348, 70, 452, 208, 402, 138], "#d97706", 1.0, 7),
      pt("pom_wrist_cuff_half", "H", "front", "1/2腕口袖宽", "Wrist Cuff Opening (1/2)", "长袖腕口底边", "Flat across wrist cuff edge", "罗纹不拉扯平量", "Measure flat without stretching cuff rib.", [422, 228, 452, 208, 438, 218], "#0d9488", 0.5, 8),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "polo_shirt_woven",
    name_zh: "Polo衫/衬衫/雪纺衫测量模板",
    name_en: "Polo & Woven Shirt / Blouse Measurement Template",
    description_zh: "适用于带门襟、领座或雪纺片结构上衣，含门襟长度及后过肩贴检查点位。",
    description_en: "Tailored collar/placket POM diagram for polos, dress shirts, and chiffon blouses.",
    applicable_product_type_codes: ["polo_shirt", "shirt_blouse", "chiffon_blouse"],
    applicable_group_codes: ["tops"],
    views: makeViews("polo_shirt", "Polo与衬衫", "POLO / WOVEN SHIRT"),
    points: upperPoints([
      pt("pom_placket_length", "G", "front", "前门襟长", "Placket Length", "领座底端至门襟底止口", "Neck seam to bottom of placket box", "扣好门襟纽扣直线量门襟", "Fasten buttons and measure center placket length.", [260, 66, 260, 136, 260, 102], "#d97706", 0.5, 7),
      pt("pom_across_back_yoke", "H", "back", "后过肩宽", "Across Back / Yoke Width", "背面两腋上约12cm过肩拼缝", "Across upper back yoke seam", "铺平背面沿过肩线量宽", "Measure horizontally along back yoke seam.", [184, 102, 336, 102, 260, 102], "#0d9488", 0.8, 8),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "detail_hardware_zipper"],
  },
  {
    code: "hoodie_sweatshirt",
    name_zh: "连帽卫衣与卫衣测量模板",
    name_en: "Hoodie & Sweatshirt Measurement Template",
    description_zh: "专为帽兜高度、袋鼠插袋、长袖及螺纹下摆设计的卫衣模板，并作为宽松连帽卫衣等子版型继承基准。",
    description_en: "Hoodie & crewneck POM diagram including hood height, hood depth, and kangaroo pocket dimensions.",
    applicable_product_type_codes: ["hoodie", "sweatshirt"],
    applicable_group_codes: ["tops"],
    views: makeViews("hoodie", "连帽卫衣", "HOODIE & SWEATSHIRT"),
    points: upperPoints([
      pt("pom_hood_height", "G", "front", "帽高", "Hood Height", "领接缝至帽顶折线", "Neck seam vertically to top of hood", "铺平帽兜自肩领缝量至帽顶", "Flatten hood sidewise and measure from neck seam to hood apex.", [260, 16, 260, 66, 260, 40], "#d97706", 1.0, 7),
      pt("pom_hood_width", "H", "front", "帽宽（帽深）", "Hood Depth", "帽口前沿至后脑中心折边", "Front hood opening to center back curve", "平铺量最宽帽深", "Measure straight across hood midpoint depth.", [208, 42, 312, 42, 290, 42], "#ea580c", 1.0, 8),
      pt("pom_long_sleeve_hoodie", "I", "front", "袖长", "Sleeve Length", "肩缝至螺纹袖口", "Shoulder seam to rib cuff edge", "沿袖管外侧量全长", "Measure along outer arm from shoulder to cuff.", [362, 84, 446, 202, 404, 142], "#0d9488", 1.0, 9),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "detail_hardware_zipper"],
  },
  {
    code: "knitwear_sweater",
    name_zh: "针织衫/毛衣/开衫测量模板",
    name_en: "Knitwear / Sweater / Cardigan Measurement Template",
    description_zh: "适用于针织衫、粗针毛衣及开衫，注明禁止用力拉扯弹性罗纹。",
    description_en: "Relaxed flat-lay knit POM template preventing stretch distortion across rib hems.",
    applicable_product_type_codes: ["knitwear_top", "sweater_pullover", "cardigan"],
    applicable_group_codes: ["tops"],
    views: makeViews("sweater", "针织毛衣", "KNITWEAR / SWEATER"),
    points: upperPoints([
      pt("pom_knit_sleeve", "G", "front", "毛衣袖长", "Knit Sleeve Length", "肩缝至螺纹袖口边", "Shoulder join to rib cuff", "自然平整轻放测量不拉伸", "Measure relaxed sleeve without tension.", [348, 68, 448, 205, 398, 136], "#d97706", 1.2, 7),
      pt("pom_rib_hem_height", "H", "front", "下摆罗纹高度", "Bottom Rib Height", "大身接缝至底边罗纹末", "Seam top of bottom rib to hem", "垂直量取罗纹组织宽度", "Measure vertical height of bottom rib trim.", [210, 286, 210, 300, 210, 293], "#0d9488", 0.5, 8),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "tank_camisole",
    name_zh: "无袖背心与吊带测量模板",
    name_en: "Tank Top & Camisole Measurement Template",
    description_zh: "针对无袖、深挖袖笼及可调节细肩带的背心结构设计（不含袖长点位）。",
    description_en: "Sleeveless tank & strap-length POM template with armhole drop and strap span.",
    applicable_product_type_codes: ["tank_top_camisole"],
    applicable_group_codes: ["tops"],
    views: makeViews("tank", "无袖背心", "TANK TOP / CAMISOLE"),
    points: [
      pt("pom_tank_length_hps", "A", "front", "背心总衣长 (HPS)", "Tank Length (HPS)", "肩带最高点至下摆", "Shoulder strap peak to bottom hem", "拉直肩带量至底边", "Measure vertically from strap top peak to hem.", [212, 58, 212, 306, 212, 182], "#dc2626", 1.2, 1),
      pt("pom_tank_chest_half", "B", "front", "1/2胸宽", "Chest Width (1/2)", "夹圈底水平跨度", "Across chest at underarm base", "铺平水平测量", "Measure across flat underarm base.", [206, 142, 314, 142, 260, 142], "#059669", 1.0, 2),
      pt("pom_tank_armhole_drop", "C", "front", "夹圈直深", "Armhole Drop", "肩顶水平线下至夹圈底垂直深", "Vertical drop from shoulder peak to underarm base", "对齐肩顶与夹圈垂直量深", "Measure vertical depth from strap top line to underarm.", [324, 58, 324, 142, 324, 100], "#2563eb", 0.8, 3),
      pt("pom_tank_hem_half", "D", "front", "1/2下摆宽", "Hem Width (1/2)", "底边平铺宽度", "Across flat bottom hem", "自然铺平下摆量宽", "Measure straight across flat bottom hem.", [186, 294, 334, 294, 260, 294], "#7c3aed", 1.0, 4),
      pt("pom_tank_back_cb", "E", "back", "后背正中长", "Center Back Length", "后领口正中至后底边", "Back neck curve center to back hem", "背面拉平正中线测量", "Measure vertically along back centerline.", [260, 110, 260, 306, 260, 210], "#d97706", 1.0, 5),
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "trousers_pants",
    name_zh: "长裤/西裤/休闲裤/工装裤测量模板",
    name_en: "Trousers, Chinos, Sweatpants & Cargo Pants Template",
    description_zh: "标准长裤矢量图与内/外裤长、前后浪、大腿与脚口 POM，严格区分 Inseam 与 Outseam。",
    description_en: "Full lower-body diagram separating Inseam vs Outseam, Front/Back Rise, Waist, Hip & Leg Opening.",
    applicable_product_type_codes: ["casual_pants", "dress_pants", "sweatpants", "cargo_pants"],
    applicable_group_codes: ["bottoms"],
    views: makeViews("trousers", "长裤与休闲西裤", "TROUSERS & PANTS"),
    points: lowerPoints("long"),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "shorts_bottom",
    name_zh: "短裤测量模板",
    name_en: "Shorts Measurement Template",
    description_zh: "专为短裤裁剪轮廓与短内长(Inseam)/侧长(Outseam)设计的 POM 模板。",
    description_en: "Dedicated shorts silhouette with short inseam, outseam, waist, hip & hem width.",
    applicable_product_type_codes: ["shorts"],
    applicable_group_codes: ["bottoms"],
    views: makeViews("shorts", "短裤", "SHORTS"),
    points: lowerPoints("short"),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "jeans_denim",
    name_zh: "牛仔裤测量模板（含门襟与后贴袋定位）",
    name_en: "Denim Jeans Measurement Template",
    description_zh: "专含牛仔裤前袋弧、门襟长度与背面双后贴袋高度对位 POM。",
    description_en: "Denim-specific diagram adding fly length and rear patch-pocket alignment checks.",
    applicable_product_type_codes: ["jeans_denim_pants"],
    applicable_group_codes: ["bottoms"],
    views: makeViews("jeans", "牛仔裤", "DENIM JEANS"),
    points: [
      ...lowerPoints("long"),
      { ...pt("pom_thigh_width_half", "H", "front", "1/2大腿围", "Thigh Width (2.5cm below crotch)", "裆底下方约2.5cm裤腿横宽", "Across single leg 2.5cm below crotch seam", "平铺单一裤腿垂直外侧线量宽", "Measure flat across thigh perpendicular to outer seam.", [166, 178, 244, 178, 205, 178], "#0d9488", 1.0, 8), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "detail_hardware_zipper"],
  },
  {
    code: "leggings_yoga",
    name_zh: "瑜伽裤与紧身打底裤测量模板",
    name_en: "Yoga Pants & Leggings Measurement Template",
    description_zh: "体现高腰弹力腰头宽度、紧身裤腿与无痕裆底拼片的高弹力下装模板。",
    description_en: "High-waisted yoga & compression legging diagram with waistband height and inseam/outseam.",
    applicable_product_type_codes: ["yoga_pants", "leggings"],
    applicable_group_codes: ["bottoms"],
    views: makeViews("leggings", "瑜伽裤/紧身裤", "YOGA & LEGGINGS"),
    points: [
      ...lowerPoints("leggings"),
      { ...pt("pom_waistband_height", "H", "front", "高腰腰头高度", "High-Waist Band Height", "腰头上沿至腰头下接缝", "Top waistband fold to lower waistband seam", "平铺不拉伸垂直测量腰头条高度", "Measure relaxed vertical waistband panel height.", [194, 48, 194, 82, 194, 65], "#0d9488", 0.5, 8), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "skirt_pleated",
    name_zh: "半身裙与百褶裙测量模板",
    name_en: "Skirt & Pleated Skirt Measurement Template",
    description_zh: "独立裙装梯形与褶皱定位矢量图，测量腰围、臀围、全裙长及下摆展开宽（无裤裆点位）。",
    description_en: "Skirt/pleated silhouette with waist, hip, center front length & sweep width (no crotch/inseam).",
    applicable_product_type_codes: ["skirt", "pleated_skirt"],
    applicable_group_codes: ["bottoms"],
    views: makeViews("skirt", "半身裙/百褶裙", "SKIRT / PLEATED SKIRT"),
    points: [
      { ...pt("pom_skirt_waist_half", "A", "front", "1/2裙腰围", "Skirt Waist (1/2)", "腰头上沿平铺宽", "Across flat top waistband edge", "扣好拉链平铺测量", "Close zipper and measure straight across waist.", [190, 70, 330, 70, 260, 70], "#2563eb", 1.0, 1), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_skirt_hip_half", "B", "front", "1/2裙臀围", "Skirt Hip (1/2)", "腰下18cm水平宽", "Across skirt 18cm below waistband", "百褶裙沿褶轻理整平", "Smooth pleats gently without stretching and measure.", [166, 152, 354, 152, 260, 152], "#059669", 1.2, 2), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_skirt_length", "C", "front", "裙长（中长）", "Skirt Center Front Length", "腰头上沿正中至裙摆底边", "Center front top edge down to skirt hem", "正中线垂直量测至下摆", "Measure vertically down center front to hem.", [260, 68, 260, 288, 260, 178], "#dc2626", 1.0, 3), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_skirt_sweep_half", "D", "front", "1/2裙摆围", "Bottom Sweep Width (1/2)", "自然平铺底摆左右边缘", "Across flat skirt sweep hem", "褶皱自然状态下量下摆跨度", "Measure across hem width in natural lay.", [128, 286, 392, 286, 260, 286], "#7c3aed", 1.5, 4), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_skirt_back_length", "E", "back", "后裙长", "Skirt Center Back Length", "后腰中线至后裙摆", "Center back waist to back hem", "背面正中量取", "Measure vertically down center back.", [260, 68, 260, 288, 260, 185], "#d97706", 1.0, 5), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "dress_onepiece",
    name_zh: "连衣裙/礼服/婚纱测量模板",
    name_en: "Dress, Formal Gown & Wedding Dress Template",
    description_zh: "全身连身轮廓图，包含 HPS 总裙长、1/2 胸围、收腰 1/2 腰围及裙摆展开度。",
    description_en: "Full dress silhouette covering HPS dress length, 1/2 chest, 1/2 waist seam & skirt sweep.",
    applicable_product_type_codes: ["casual_dress", "formal_dress_gown", "wedding_dress"],
    applicable_group_codes: ["dresses_sets", "special_apparel"],
    views: makeViews("dress", "连衣裙与礼服", "DRESS / GOWN"),
    points: [
      pt("pom_dress_length_hps", "A", "front", "连衣裙总长 (HPS)", "Total Dress Length (HPS)", "肩颈最高点至裙摆底边", "High Point Shoulder vertically to dress hem", "垂直抚平量总衣长", "Measure vertically from HPS straight to dress hem.", [224, 48, 224, 316, 224, 185], "#dc2626", 2.0, 1),
      pt("pom_dress_chest_half", "B", "front", "1/2胸围", "Bust / Chest Width (1/2)", "腋下底水平跨度", "Across bust 2.5cm below armhole", "平铺水平测量", "Measure straight across bust line flat.", [180, 118, 340, 118, 260, 118], "#059669", 1.2, 2),
      pt("pom_dress_waist_half", "C", "front", "1/2腰节围", "Waist Seam Width (1/2)", "腰部收省或腰线接缝", "Across horizontal waist seam", "对齐腰线接缝量宽", "Measure straight across waistline flat.", [198, 148, 322, 148, 260, 148], "#2563eb", 1.0, 3),
      pt("pom_dress_sweep_half", "D", "front", "1/2底摆宽", "Dress Hem Sweep (1/2)", "下摆自然展开宽度", "Across flared dress hem", "铺平下摆最宽处", "Measure straight across dress bottom sweep.", [126, 312, 394, 312, 260, 312], "#7c3aed", 2.0, 4),
      pt("pom_dress_back_length", "E", "back", "后中裙长", "Center Back Dress Length", "后领中心或拉链顶至底边", "Back neck / zipper top down to hem", "背面拉平后中量长", "Measure down center back from top seam to hem.", [260, 62, 260, 316, 260, 200], "#d97706", 2.0, 5),
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "jumpsuit_romper",
    name_zh: "连体裤与连体衣测量模板",
    name_en: "Jumpsuit & Bodysuit / Romper Measurement Template",
    description_zh: "兼顾连体上下身的 HPS 至裆底(Torso Length)、裤内长(Inseam)及全长 POM 模板。",
    description_en: "Combined upper-to-crotch torso length + lower inseam POM template for jumpsuits and bodysuits.",
    applicable_product_type_codes: ["jumpsuit", "bodysuit_romper"],
    applicable_group_codes: ["dresses_sets"],
    views: makeViews("jumpsuit", "连体裤/连体衣", "JUMPSUIT / ROMPER"),
    points: [
      pt("pom_jumpsuit_total_length", "A", "front", "连体全长 (HPS)", "Total Length (HPS to Hem)", "肩点至裤脚底边", "Shoulder peak vertically to trouser hem", "拉直铺平全身量测", "Measure straight from HPS to leg opening hem.", [216, 46, 204, 324, 210, 180], "#dc2626", 2.0, 1),
      pt("pom_jumpsuit_torso_hps_crotch", "B", "front", "肩至裆顶躯干长", "HPS to Crotch Torso Length", "肩颈点至裆十字交汇", "Shoulder peak straight down to crotch seam", "测量上身合体躯干纵向长度", "Measure vertically from HPS down to crotch intersection.", [260, 68, 260, 198, 260, 134], "#ea580c", 1.2, 2),
      pt("pom_jumpsuit_chest_half", "C", "front", "1/2胸围", "Chest Width (1/2)", "腋下水平横宽", "Across bust below armhole", "平铺量宽", "Measure across bust flat.", [184, 114, 336, 114, 260, 114], "#059669", 1.0, 3),
      pt("pom_jumpsuit_waist_half", "D", "front", "1/2腰围", "Waist Width (1/2)", "腰线拼缝横宽", "Across waist seam flat", "腰线处水平量宽", "Measure flat across waist seam.", [196, 146, 324, 146, 260, 146], "#2563eb", 1.0, 4),
      { ...pt("pom_jumpsuit_inseam", "E", "front", "裤内长 (Inseam)", "Inseam", "裆底至脚口内缝", "Crotch intersection to inner leg hem", "沿内裤缝量取", "Measure inner leg seam from crotch to hem.", [254, 198, 236, 324, 244, 260], "#7c3aed", 1.5, 5), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "sports_bra_intimates",
    name_zh: "运动内衣/普通文胸/塑身衣测量模板",
    name_en: "Sports Bra, Regular Bra & Shapewear Template",
    description_zh: "专用文胸与内衣结构矢量图，精确定义上胸围宽、下扒松紧底围宽、前中鸡心高及肩带长。",
    description_en: "Dedicated bra/shapewear diagram specifying bust width, underband width, center front height & strap drop.",
    applicable_product_type_codes: ["sports_bra", "regular_bra", "shapewear_bodysuit"],
    applicable_group_codes: ["underwear_activewear"],
    views: makeViews("sports_bra", "运动内衣与文胸", "SPORTS BRA & SHAPEWEAR"),
    points: [
      pt("pom_bra_bust_half", "A", "front", "1/2胸围宽", "Upper Chest / Bust Width (1/2)", "罩杯夹圈底水平跨度", "Across cup/underarm horizontal width", "铺平不拉伸测量", "Lay flat relaxed and measure across cup level.", [190, 152, 330, 152, 260, 152], "#059669", 0.8, 1),
      pt("pom_bra_underband_half", "B", "front", "1/2下胸围/底围宽", "Underband Width (1/2 Relaxed)", "底部松紧橡筋下沿左右跨度", "Across bottom elastic underband relaxed", "松紧自然状态下水平测量", "Measure across bottom underband flat without stretching.", [178, 224, 342, 224, 260, 224], "#2563eb", 0.8, 2),
      pt("pom_bra_underband_height", "C", "front", "下扒底围高度", "Underband Trim Height", "底围接缝至底边垂直高度", "Vertical height of bottom elastic band", "垂直测量底围橡筋宽度", "Measure vertical band height.", [202, 196, 202, 228, 202, 212], "#0891b2", 0.3, 3),
      pt("pom_bra_center_front_height", "D", "front", "前中鸡心高度", "Center Front Height", "前领U形最低点至底边", "Lowest front neckline center to underband edge", "正中垂直量测", "Measure vertically from front neckline trough to bottom edge.", [260, 140, 260, 228, 260, 180], "#dc2626", 0.5, 4),
      pt("pom_bra_strap_length", "E", "front", "肩带总长度/垂直高度", "Shoulder Strap Drop / Length", "肩带顶至前胸接缝", "Top shoulder peak to front cup join", "拉直铺平测量肩带段", "Measure strap vertical height from top peak to cup join.", [218, 78, 206, 134, 212, 106], "#d97706", 0.5, 5),
      pt("pom_bra_back_wing_height", "F", "back", "后背扣带/工字背高度", "Back Wing / Racerback Height", "后背正中上缘至底围", "Back strap intersection to bottom hem", "背面展开量取后背中心高度", "Measure back center height from neck cutout to bottom.", [260, 158, 260, 228, 260, 192], "#7c3aed", 0.5, 6),
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "detail_hardware_zipper"],
  },
  {
    code: "briefs_underwear",
    name_zh: "内裤/平角裤专用测量模板",
    name_en: "Underwear Briefs / Boxers Measurement Template",
    description_zh: "专为男女内裤与平角底裤设计的平铺模板，仅包含腰围松紧、侧边高、前浪底裆深、腿口宽与后浪，排除胸围/肩带点位。",
    description_en: "Dedicated briefs & boxer silhouette measuring waistband, side seam, front rise, gusset/leg opening & back rise (no bra points).",
    applicable_product_type_codes: ["underwear_briefs"],
    applicable_group_codes: ["underwear_activewear"],
    views: makeViews("briefs", "内裤与平角裤", "UNDERWEAR BRIEFS"),
    points: [
      { ...pt("pom_briefs_waist_half", "A", "front", "1/2橡筋腰围（放松态）", "Waistband Width (1/2 Relaxed)", "腰头上沿左侧至右侧", "Across relaxed top waistband seam-to-seam", "松紧自然铺平不拉伸量测", "Measure flat across relaxed waistband without tension.", [164, 118, 356, 118, 260, 118], "#2563eb", 0.8, 1), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_briefs_side_height", "B", "front", "侧骨高度", "Side Seam Height", "腰头上沿外侧至腿叉上缘", "Outer top waistband to top of leg opening", "沿外侧骨垂直测量", "Measure outer side seam height from waist top to leg cutout.", [160, 114, 156, 162, 144, 138], "#059669", 0.5, 2), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_briefs_front_rise", "C", "front", "前浪总深（至底裆）", "Front Rise to Gusset", "腰头正中上沿至底裆折线", "Center front waist top edge down to gusset fold", "正中线自然拉平量至裆底", "Measure straight down center front to bottom crotch edge.", [260, 114, 260, 266, 260, 190], "#dc2626", 0.8, 3), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_briefs_gusset_width", "D", "front", "底裆最窄宽", "Crotch Gusset Width", "底裆左右脚口最低沿跨度", "Across bottom crotch gusset width", "铺平量底裆接缝处宽度", "Measure across narrowest crotch gusset seam.", [244, 262, 276, 262, 260, 276], "#7c3aed", 0.4, 4), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_briefs_leg_opening", "E", "front", "腿口弧度斜宽", "Leg Opening Half Width", "外腿叉高点斜量至底裆角", "Diagonal span from side leg top to gusset corner", "自然平铺斜量腿围开口", "Measure straight diagonally across flattened leg opening.", [156, 162, 244, 264, 192, 214], "#d97706", 0.8, 5), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_briefs_back_rise", "F", "back", "后浪高度", "Back Rise to Gusset", "后腰中心上沿至底裆缝", "Center back waist top edge down to gusset bottom", "背面铺平正中垂直量取", "Measure vertically along center back from waist to gusset.", [260, 114, 260, 266, 260, 196], "#0891b2", 0.8, 6), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "swimwear_active",
    name_zh: "泳装与功能运动服装测量模板",
    name_en: "Swimwear & Functional Sportswear Template",
    description_zh: "连体泳装与功能运动贴身装专用轮廓，包含肩至底裆直长与高叉腿围弧点位。",
    description_en: "One-piece swimwear & functional active silhouette capturing HPS-to-crotch, bust, waist & leg cut.",
    applicable_product_type_codes: ["swimwear", "functional_sportswear"],
    applicable_group_codes: ["underwear_activewear"],
    views: makeViews("swimwear", "泳装", "SWIMWEAR & ACTIVE"),
    points: [
      pt("pom_swim_torso_length", "A", "front", "肩至底裆总长", "Total Swimsuit Length (HPS to Crotch)", "肩带最高点至底裆最低点", "Shoulder peak vertically to gusset bottom", "不拉伸自然平铺量直长", "Measure flat without stretching elastic from shoulder to crotch.", [260, 118, 260, 294, 260, 205], "#dc2626", 1.2, 1),
      pt("pom_swim_bust_half", "B", "front", "1/2胸宽", "Bust Width (1/2)", "腋下底水平宽", "Across bust at armhole base", "平铺量测", "Measure straight across underarm base.", [198, 162, 322, 162, 260, 162], "#059669", 0.8, 2),
      pt("pom_swim_waist_half", "C", "front", "1/2腰宽", "Waist Width (1/2)", "腰部最窄曲线平铺宽", "Across narrowest waist curve", "水平测量", "Measure across narrowest waist section.", [202, 202, 318, 202, 260, 202], "#2563eb", 0.8, 3),
      pt("pom_swim_hip_half", "D", "front", "1/2胯宽", "Hip Width (1/2)", "腿叉起点上方水平跨度", "Across hip right above leg cutout", "水平量宽", "Measure across hip above leg openings.", [184, 242, 336, 242, 260, 242], "#7c3aed", 1.0, 4),
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "light_jacket_varsity",
    name_zh: "薄夹克/牛仔外套/棒球服测量模板",
    name_en: "Light Jacket, Denim Jacket & Varsity Jacket Template",
    description_zh: "带拉链前门襟与插肩/立领罗纹袖口外套模板。",
    description_en: "Front-zipper outer shell POM diagram for light, denim, and varsity jackets.",
    applicable_product_type_codes: ["light_jacket", "denim_jacket", "varsity_baseball_jacket"],
    applicable_group_codes: ["outerwear"],
    views: makeViews("light_jacket", "薄夹克/棒球服", "LIGHT / VARSITY JACKET"),
    points: upperPoints([
      pt("pom_jacket_sleeve", "G", "front", "外套袖长", "Jacket Sleeve Length", "肩点沿袖外线至袖口罗纹末", "Shoulder seam along outer sleeve to cuff edge", "顺着袖笼外弯量全长", "Measure along outer arm from shoulder point to cuff.", [352, 68, 448, 202, 400, 134], "#d97706", 1.2, 7),
      pt("pom_zipper_center_front", "H", "front", "前拉链长度", "Center Front Zipper Length", "前领止口至下摆拉链底", "Collar zip stop to bottom hem zip stop", "拉合门襟测量金属/树脂链长", "Close zipper and measure full zipper tape track.", [260, 68, 260, 302, 260, 185], "#0d9488", 0.8, 8),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "detail_hardware_zipper"],
  },
  {
    code: "heavy_coat_trench",
    name_zh: "风衣/厚大衣/多层外套测量模板",
    name_en: "Trench Coat, Heavy Overcoat & Multi-Layer Jacket Template",
    description_zh: "中长款大衣与风衣大翻领模板，几何坐标精确对齐长款底摆、肩宽、胸宽、袖长及后开衩后背长。",
    description_en: "Long overcoat silhouette aligned to extended coat hem (y=332), shoulder, chest, sleeve & center back.",
    applicable_product_type_codes: ["trench_coat", "heavy_overcoat", "multi_layer_jacket"],
    applicable_group_codes: ["outerwear"],
    views: makeViews("heavy_coat", "风衣/厚大衣", "TRENCH & HEAVY COAT"),
    points: [
      pt("pom_coat_total_length", "A", "front", "大衣前长 (HPS to Hem)", "Coat Total Length (HPS)", "肩颈最高点至长款底摆", "High Point Shoulder vertically to overcoat hem", "垂直抚平拉直量全衣长", "Measure straight down from HPS to overcoat hem.", [224, 48, 224, 330, 224, 188], "#dc2626", 2.0, 1),
      pt("pom_coat_chest_half", "B", "front", "1/2大衣胸围", "Coat Chest Width (1/2)", "扣好前襟腋下 2.5cm 水平宽", "Across buttoned chest 2.5cm below armholes", "扣好门襟平铺量胸宽", "Button front closure and measure straight across flat.", [176, 136, 344, 136, 268, 136], "#059669", 1.5, 2),
      pt("pom_coat_shoulder_width", "C", "front", "大衣肩宽", "Coat Shoulder Width", "左肩点至右肩点", "Shoulder point to shoulder point across top", "直线量两肩端点", "Measure straight across shoulder seam points.", [168, 66, 352, 66, 260, 66], "#2563eb", 1.2, 3),
      pt("pom_coat_hem_half", "D", "front", "1/2大衣下摆宽", "Coat Bottom Sweep (1/2)", "长款大衣底摆左右侧缝", "Along extended coat bottom hem seam to seam", "自然铺平长下摆量宽", "Measure straight across bottom coat sweep flat.", [170, 322, 350, 322, 260, 322], "#7c3aed", 1.5, 4),
      pt("pom_coat_sleeve", "E", "front", "大衣袖长", "Coat Sleeve Length", "肩点沿袖线至袖口", "Shoulder seam along outer sleeve to cuff edge", "沿袖山外线平量", "Measure from shoulder point to sleeve cuff edge.", [354, 66, 452, 212, 402, 138], "#d97706", 1.2, 5),
      pt("pom_coat_center_back", "F", "back", "大衣后背正中长 (CB)", "Coat Center Back Length", "后领接缝至大衣后底摆", "Center back collar seam to rear coat hem", "背面铺平沿正中背缝量至底摆", "Measure straight down center back seam to rear hem.", [260, 56, 260, 330, 260, 195], "#0891b2", 2.0, 6),
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "inside_lining_turn"],
  },
  {
    code: "down_jacket_puffer",
    name_zh: "羽绒服/棉服/带可拆卸部件外套测量模板",
    name_en: "Down Jacket, Padded Coat & Detachable Outerwear Template",
    description_zh: "专含防风帽兜高度、绗缝充绒格位与外套膨胀公差说明的厚冬装模板（重量/充绒检查走 M05 独立面板）。",
    description_en: "Quilted puffer/down jacket POM diagram with hood height, baffle alignment & lofted outer tolerances.",
    applicable_product_type_codes: ["down_jacket", "padded_cotton_jacket", "detachable_parts_jacket"],
    applicable_group_codes: ["outerwear"],
    views: makeViews("down_jacket", "羽绒服/棉服", "DOWN & PUFFER JACKET"),
    points: upperPoints([
      pt("pom_down_sleeve", "G", "front", "羽绒袖长", "Puffer Sleeve Length", "肩线至防风袖口", "Shoulder point to outer sleeve cuff", "轻按排平表面充绒后测量", "Lightly pat flat along outer sleeve from shoulder to cuff.", [358, 66, 456, 206, 406, 136], "#d97706", 1.5, 7),
      pt("pom_down_hood_height", "H", "front", "羽绒帽高", "Puffer Hood Height", "后领接缝至帽顶", "Neck join vertically to hood crown", "平铺帽兜量高度", "Measure flattened hood height from neck seam.", [260, 28, 260, 66, 260, 46], "#ea580c", 1.5, 8),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "inside_lining_turn"],
  },
  {
    code: "blazer_suit",
    name_zh: "西装外套测量模板",
    name_en: "Tailored Blazer / Suit Jacket Template",
    description_zh: "专业驳领西装结构模板，包含垫肩宽、前门襟纽扣位胸宽、中腰收省宽及后开衩长度。",
    description_en: "Structured blazer POM template covering padded shoulder, half-chest, suppressed waist & back vent.",
    applicable_product_type_codes: ["blazer_suit_jacket"],
    applicable_group_codes: ["outerwear"],
    views: makeViews("blazer", "西装外套", "TAILORED BLAZER"),
    points: upperPoints([
      pt("pom_blazer_waist_half", "G", "front", "1/2中腰收腰宽", "Blazer Suppressed Waist (1/2)", "第一粒门襟扣上方收省处", "Across narrowest tailored waist level", "扣好门襟扣水平测量中腰", "Fasten main button and measure across tailored waist.", [182, 198, 338, 198, 260, 198], "#ea580c", 1.0, 7),
      pt("pom_blazer_sleeve", "H", "front", "西装袖长", "Blazer Sleeve Length", "肩点沿大袖片至袖口", "Shoulder seam along top sleeve to cuff", "顺直铺平量西装袖长", "Measure straight along top sleeve from shoulder point to cuff.", [352, 68, 446, 206, 398, 136], "#d97706", 1.0, 8),
    ]),
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "inside_lining_turn"],
  },
  {
    code: "two_piece_tracksuit_set",
    name_zh: "两件套/运动套装/瑜伽套装/睡衣套装/多件组合测量模板",
    name_en: "Two-Piece, Tracksuit, Yoga, Pajama & Multi-Piece Set Template",
    description_zh: "双联装组合模板（§41.3 运动套装必备）：同画布左侧分件展示上衣几何点位，右侧展示下装裤腿/腰臀点位，支持上下件分拆核尺。",
    description_en: "Dual-piece split diagram for co-ords, tracksuits, yoga sets, pajama sets & multi-piece bundles (top left + bottom right).",
    applicable_product_type_codes: ["two_piece_set", "tracksuit_set", "yoga_set", "pajama_set", "multi_piece_garment_set"],
    applicable_group_codes: ["dresses_sets"],
    views: makeViews("tracksuit_set", "两件套与运动套装", "TWO-PIECE & TRACKSUIT SET"),
    points: [
      pt("pom_set_top_length_hps", "A", "front", "套装上衣长 (HPS)", "Set Top Length (HPS)", "上衣肩颈点至上衣底摆", "Set top HPS vertically to top hem", "左侧上衣平铺垂直测量衣长", "Measure upper piece length vertically flat.", [112, 64, 112, 286, 112, 175], "#dc2626", 1.5, 1),
      pt("pom_set_top_chest_half", "B", "front", "1/2套装上衣胸宽", "Set Top Chest Width (1/2)", "上衣腋下2.5cm水平跨度", "Across upper piece below armholes", "平铺量取上衣胸宽", "Measure straight across flat upper piece chest.", [82, 134, 206, 134, 144, 134], "#059669", 1.2, 2),
      pt("pom_set_top_sleeve", "C", "front", "套装上衣袖长", "Set Top Sleeve Length", "上衣肩点至袖口边", "Shoulder point to outer cuff on set top", "沿袖山外缘量全长", "Measure along outer top sleeve edge to cuff.", [226, 76, 262, 178, 244, 128], "#d97706", 1.0, 3),
      { ...pt("pom_set_bottom_waist_half", "D", "front", "1/2套装裤腰围", "Set Bottom Waist (1/2)", "下装腰头上沿左右平铺", "Across lower piece flat waistband", "右侧下装腰头自然平铺量宽", "Measure lower piece waistband flat across.", [294, 68, 446, 68, 370, 68], "#2563eb", 1.0, 4), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_set_bottom_inseam", "E", "front", "套装裤内长 (Inseam)", "Set Bottom Inseam", "下装裆底交汇至裤脚内侧", "Lower piece crotch intersection to inner leg hem", "沿内裤缝量取", "Measure lower piece inner leg seam to hem.", [366, 164, 348, 308, 354, 236], "#7c3aed", 1.5, 5), check_item_code: "CHK_M02_LOWER_BODY_POM" },
      { ...pt("pom_set_bottom_outseam", "F", "front", "套装裤外长 (Outseam)", "Set Bottom Outseam", "下装腰头外沿沿侧缝至脚口", "Lower piece outer waistband to outer leg hem", "沿下装外侧缝量总长", "Measure lower piece outer side seam from waist to hem.", [294, 66, 280, 308, 286, 188], "#0891b2", 1.5, 6), check_item_code: "CHK_M02_LOWER_BODY_POM" },
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom"],
  },
  {
    code: "kids_toddler_apparel",
    name_zh: "童装与婴幼儿服装测量模板",
    name_en: "Kids & Baby/Toddler Apparel Measurement Template",
    description_zh: "专为大童装及婴幼儿爬服/哈衣设计的高精度小尺码模板，包含肩档直长（爬服扣长）与严格 0.5cm 级公差控制。",
    description_en: "Precision kids & infant wear POM diagram capturing HPS body length, chest, shoulder, sleeve & romper crotch drop.",
    applicable_product_type_codes: ["kids_apparel", "baby_toddler_apparel"],
    applicable_group_codes: ["special_apparel"],
    views: makeViews("kids_toddler", "童装与婴幼儿装", "KIDS & TODDLER APPAREL"),
    points: [
      pt("pom_kids_body_length_hps", "A", "front", "童装/爬服全长 (HPS)", "Kids/Romper Body Length (HPS)", "肩颈最高点至底摆/底裆按扣沿", "HPS vertically to bottom hem or snap closure edge", "垂直拉平量至下摆或裆部底边", "Measure straight from HPS to hem or crotch snap bottom.", [230, 62, 230, 290, 230, 176], "#dc2626", 0.8, 1),
      pt("pom_kids_chest_half", "B", "front", "1/2童装胸宽", "Kids Chest Width (1/2)", "腋下 2cm 处水平跨度", "Across chest 2cm below armholes", "不拉扯平铺量宽", "Measure flat across chest without tension.", [182, 134, 338, 134, 260, 134], "#059669", 0.6, 2),
      pt("pom_kids_shoulder_width", "C", "front", "童装肩宽", "Kids Shoulder Width", "左肩缝至右肩缝", "Shoulder point to shoulder point", "直线量取肩点间距", "Measure straight across shoulder seam tips.", [176, 74, 344, 74, 260, 74], "#2563eb", 0.5, 3),
      pt("pom_kids_sleeve_length", "D", "front", "童装袖长", "Kids Sleeve Length", "肩点沿袖山外线至袖口", "Shoulder seam along outer sleeve to cuff", "顺直轻铺量取袖长", "Measure smoothly from shoulder point to sleeve cuff.", [344, 74, 412, 158, 380, 114], "#d97706", 0.6, 4),
      pt("pom_kids_crotch_drop", "E", "back", "后背衣长 (CB)", "Kids Center Back Length", "后领中心至后底摆/底裆", "Center back collar edge to rear bottom hem", "背面铺平正中垂直测量", "Measure vertically down center back.", [260, 66, 260, 290, 260, 178], "#7c3aed", 0.8, 5),
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "macro_label_care"],
  },
  {
    code: "special_craft_material_apparel",
    name_zh: "重工刺绣/特殊装饰/特殊材质服装测量模板",
    name_en: "Heavy Embroidery, Special Embellishment & Material Template",
    description_zh: "适用于重工满绣、钉珠亮片与真丝/皮革/羊绒特材成衣，包含装饰区定位尺寸、HPS 全长、胸宽、摆宽与无损伤轻放量测规范。",
    description_en: "Special-craft/delicate-material diagram capturing HPS length, motif/embellishment zone span, chest, hem sweep & zero-tension back CB.",
    applicable_product_type_codes: ["heavy_embroidery_apparel", "special_embellishment_apparel", "special_material_apparel"],
    applicable_group_codes: ["special_apparel"],
    views: makeViews("special_craft", "重工刺绣与特材装", "SPECIAL CRAFT & MATERIAL"),
    points: [
      pt("pom_craft_length_hps", "A", "front", "特材/礼衣总长 (HPS)", "Garment Total Length (HPS)", "肩颈最高点至底摆（禁止重力悬拉）", "HPS vertically to hem flat without stretch/hanging", "平铺真丝/重工面轻按测量", "Measure flat gently without tension on delicate fabric.", [224, 56, 224, 306, 224, 180], "#dc2626", 1.5, 1),
      pt("pom_craft_chest_half", "B", "front", "1/2胸宽", "Chest / Bust Width (1/2)", "腋下 2.5cm 处水平跨度", "Across chest 2.5cm below underarm", "隔软尺平量避免刮伤珠片", "Measure carefully across bust keeping tape off beadwork.", [180, 134, 340, 134, 260, 134], "#059669", 1.0, 2),
      pt("pom_craft_motif_span", "C", "front", "核心刺绣/重工装饰区横宽", "Embellishment / Motif Zone Width", "主图案最外缘左至右宽度", "Horizontal span of primary embroidery/beadwork panel", "紧贴主纹样外缘量横宽", "Measure outer width of primary craft panel flat.", [206, 152, 314, 152, 260, 166], "#d97706", 0.8, 3),
      pt("pom_craft_hem_half", "D", "front", "1/2下摆宽", "Bottom Sweep Width (1/2)", "底边自然平铺左右宽度", "Across flat bottom hem edge", "自然舒展下摆边缘测量", "Measure straight across bottom sweep flat.", [166, 300, 354, 300, 260, 300], "#7c3aed", 1.5, 4),
      pt("pom_craft_back_cb", "E", "back", "后背正中长 (CB)", "Center Back Length", "后领中心至后底摆", "Center back neck join to rear hem", "背面轻展平量正中纵长", "Measure center back length flat without creasing.", [260, 62, 260, 306, 260, 185], "#0891b2", 1.5, 5),
    ],
    camera_preset_codes: ["overhead_flat_front", "overhead_flat_back", "macro_ruler_pom", "detail_hardware_zipper"],
  },
];

export type MeasurementSeedResult = {
  seed_version: string;
  ran_at: string;
  inserted_counts: { camera_presets: number; measurement_templates: number };
  skipped_existing_counts: { camera_presets: number; measurement_templates: number };
  total_families: number;
};

/**
 * Idempotently seeds the 6 standard camera presets and 23 distinct apparel SVG measurement template families.
 * Strictly preserves administrator-modified templates via ON CONFLICT DO NOTHING.
 */
export async function initializeMeasurementTemplates(
  db: DB,
  actor: Actor,
  sessionHash: string,
): Promise<MeasurementSeedResult> {
  role(actor, "super_admin", "template_admin");
  await requireStaffMfa(db, actor, sessionHash, 15);
  await lock(db, "measurement_templates:seed-init");

  let insertedPresets = 0;
  let skippedPresets = 0;
  for (const preset of SEED_CAMERA_PRESETS) {
    const res = await db.query(
      `insert into measurement_camera_presets (
        code, name_zh, name_en, view_key, framing_notes_zh, framing_notes_en,
        requires_scale_ruler, recommended_resolution, sort_order, active
      ) values ($1,$2,$3,$4,$5,$6,$7::boolean,$8,$9::int,true)
      on conflict (code) do nothing returning id`,
      [
        preset.code,
        preset.name_zh,
        preset.name_en,
        preset.view_key,
        preset.framing_notes_zh,
        preset.framing_notes_en,
        preset.requires_scale_ruler,
        preset.recommended_resolution,
        preset.sort_order,
      ],
    );
    if ((res.rowCount ?? 0) > 0) insertedPresets += 1;
    else skippedPresets += 1;
  }

  let insertedTemplates = 0;
  let skippedTemplates = 0;
  for (const tpl of SEED_MEASUREMENT_TEMPLATES) {
    const res = await db.query(
      `insert into measurement_templates (
        code, parent_template_id, name_zh, name_en, description_zh, description_en,
        applicable_product_type_codes, applicable_group_codes, default_unit,
        views, points, point_overrides, camera_preset_codes,
        status, is_seed_default, admin_modified, created_by
      ) values (
        $1, null, $2, $3, $4, $5,
        $6::text[], $7::text[], 'cm',
        $8::jsonb, $9::jsonb, '{"disabled_point_ids":[],"overridden_points":{},"added_points":[]}'::jsonb, $10::text[],
        'draft', true, false, $11::uuid
      ) on conflict (code) do nothing returning id`,
      [
        tpl.code,
        tpl.name_zh,
        tpl.name_en,
        tpl.description_zh,
        tpl.description_en,
        tpl.applicable_product_type_codes,
        tpl.applicable_group_codes,
        JSON.stringify(tpl.views),
        JSON.stringify(tpl.points),
        tpl.camera_preset_codes,
        actor.id,
      ],
    );
    if ((res.rowCount ?? 0) > 0) insertedTemplates += 1;
    else skippedTemplates += 1;
  }

  const insertedCounts = { camera_presets: insertedPresets, measurement_templates: insertedTemplates };
  const skippedCounts = { camera_presets: skippedPresets, measurement_templates: skippedTemplates };
  const runRow = (
    await db.query<{ id: string; ran_at: Date }>(
      `insert into measurement_template_seed_runs (seed_version, actor_id, inserted_counts, skipped_existing_counts)
       values ($1, $2::uuid, $3::jsonb, $4::jsonb)
       returning id, ran_at`,
      [MEASUREMENT_SEED_VERSION, actor.id, JSON.stringify(insertedCounts), JSON.stringify(skippedCounts)],
    )
  ).rows[0]!;

  await audit(db, actor, "measurement_templates_seed_init", "measurement_template_seed_runs", runRow.id, {
    seed_version: MEASUREMENT_SEED_VERSION,
    inserted_counts: insertedCounts,
    skipped_existing_counts: skippedCounts,
  });

  const totalFamilies = (await db.query<{ n: number }>("select count(*)::int n from measurement_templates")).rows[0]!.n;

  return {
    seed_version: MEASUREMENT_SEED_VERSION,
    ran_at: runRow.ran_at.toISOString(),
    inserted_counts: insertedCounts,
    skipped_existing_counts: skippedCounts,
    total_families: totalFamilies,
  };
}
