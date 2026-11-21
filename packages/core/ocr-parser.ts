export interface OcrRawBlock {
  page: number;
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
  source?: string;
}

export interface ParsedCandidateRow {
  sort_index: number;
  platform: string | null;
  supplier_name: string | null;
  platform_order_no: string | null;
  tracking_no: string | null;
  item_name: string;
  sku_code: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  unit_price_text: string | null;
  currency: string | null;
  order_date: string | null;
  confidence: number;
  field_confidences: Record<string, number>;
  bbox: { page: number; rect: [number, number, number, number] } | null;
  raw_excerpt: string;
}

export interface ParsedOcrDocument {
  platform: string | null;
  supplier_name: string | null;
  platform_order_no: string | null;
  tracking_no: string | null;
  order_date: string | null;
  currency: string | null;
  candidates: ParsedCandidateRow[];
  warnings: string[];
  needs_review: boolean;
}

const PLATFORM_RULES: Array<{ name: string; re: RegExp }> = [
  { name: "1688", re: /(?:1688|阿里巴巴|alibaba\.com|批发订单)/i },
  { name: "Taobao", re: /(?:淘宝|taobao|tmall|天猫|已买到的宝贝|宝贝详情)/i },
  { name: "Weidian", re: /(?:微店|weidian)/i },
  { name: "Pinduoduo", re: /(?:拼多多|pinduoduo)/i },
  { name: "Poizon/Dewu", re: /(?:得物|poizon|dewu)/i },
  { name: "Packing List", re: /(?:packing\s*list|commercial\s*invoice|箱单|装箱单|采购清单|purchase\s*order)/i },
];

const TRACKING_PATTERNS: RegExp[] = [
  /\b(SF\d{12,15})\b/i,
  /\b(JT\d{11,15})\b/i,
  /\b(YT\d{12,15})\b/i,
  /\b(ZT\d{11,15})\b/i,
  /\b(JD[A-Z]{0,2}\d{10,15})\b/i,
  /\b(7[5-9]\d{12})\b/,
  /\b(77\d{12,13})\b/,
  /\b(43\d{11,13})\b/,
  /\b(31\d{11,13})\b/,
];

const COLOR_MAP: Array<[RegExp, string]> = [
  [/黑|black|obsidian|noir/i, "Black"],
  [/白|white|ivory|cream/i, "White"],
  [/灰|grey|gray|charcoal|heather/i, "Grey"],
  [/藏青|navy/i, "Navy"],
  [/蓝|blue/i, "Blue"],
  [/绿|sage|olive|green/i, "Green"],
  [/红|burgundy|wine|red/i, "Red"],
  [/粉|pink|rose/i, "Pink"],
  [/咖|棕|卡其|brown|khaki|coffee|mocha/i, "Brown/Khaki"],
];

function detectColor(text: string): string | null {
  for (const [re, label] of COLOR_MAP) {
    if (re.test(text)) return label;
  }
  return null;
}

function detectSize(text: string): string | null {
  const spaced = text
    .replace(/([A-Za-z])(XXXL|XXL|XL|XS|S|M|L)(?=\s|SKU|Qty|Size|$)/g, "$1 $2")
    .replace(/([A-Za-z0-9])((?:SKU|Qty|Quantity|Size|Color|Price)\s*[:：])/gi, "$1 $2");
  const m =
    spaced.match(/(?:尺码|size|码数|规格)\s*[:：]?\s*(XXXS|XXXL|XXL|XL|XS|S|M|L|Free|One\s*Size|\d{2,3}(?:cm)?)\b/i) ??
    spaced.match(/\b(XXXL|XXL|XL|XS|S|M|L)\b/);
  return m ? m[1].toUpperCase() : null;
}

function detectQuantity(text: string): number {
  const m =
    text.match(/(?:数量|qty|quantity|件数|count)\s*[:：]?\s*(\d{1,4})(?=\D|$)/i) ??
    text.match(/[x×*]\s*(\d{1,4})(?=\D|$)/i) ??
    text.match(/\b(\d{1,3})\s*(?:件|pcs|pieces|units|套|条)\b/i);
  if (!m) return 1;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 && n <= 9999 ? n : 1;
}

function detectPrice(text: string): { text: string; currency: string | null } | null {
  const m = text.match(/([¥￥$€]|USD|CNY|RMB|HKD)\s*(\d+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const sym = m[1].toUpperCase();
  const currency =
    sym === "$" || sym === "USD" ? "USD" : sym === "HKD" ? "HKD" : sym === "€" ? "EUR" : "CNY";
  return { text: `${m[1]}${m[2]}`, currency };
}

function detectSku(text: string): string | null {
  const spaced = text.replace(/([A-Za-z0-9])((?:SKU|Qty|Quantity|Size|Color|Price)\s*[:：])/gi, "$1 $2");
  const m =
    spaced.match(/(?:SKU|款号|货号|item\s*code|style)\s*[:：#]?\s*([A-Z0-9][A-Z0-9_-]{2,24}?)(?=\s|(?:Qty|Quantity|Size|Color|数量|尺码|[¥￥$€])|$)/i) ??
    spaced.match(/\b([A-Z]{2,6}[-_][A-Z0-9-]{2,20})\b/);
  return m ? m[1] : null;
}

/**
 * Group horizontally aligned OCR blocks into visual reading rows so table/column screenshots become line items.
 */
function groupBlocksIntoRows(blocks: OcrRawBlock[]): Array<{ page: number; text: string; conf: number; bbox: [number, number, number, number] }> {
  const sorted = [...blocks].sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const rows: Array<{ page: number; parts: OcrRawBlock[]; yCenter: number }> = [];

  for (const blk of sorted) {
    const yc = (blk.bbox[1] + blk.bbox[3]) / 2;
    const h = Math.max(0.012, blk.bbox[3] - blk.bbox[1]);
    const match = rows.find((r) => r.page === blk.page && Math.abs(r.yCenter - yc) <= Math.max(0.018, h * 0.75));
    if (match) {
      match.parts.push(blk);
      match.yCenter = match.parts.reduce((acc, p) => acc + (p.bbox[1] + p.bbox[3]) / 2, 0) / match.parts.length;
    } else {
      rows.push({ page: blk.page, parts: [blk], yCenter: yc });
    }
  }

  return rows.map((row) => {
    const parts = [...row.parts].sort((a, b) => a.bbox[0] - b.bbox[0]);
    const text = parts.map((p) => p.text).join("  ");
    const conf = Number((parts.reduce((acc, p) => acc + p.confidence, 0) / parts.length).toFixed(4));
    const bbox: [number, number, number, number] = [
      Math.min(...parts.map((p) => p.bbox[0])),
      Math.min(...parts.map((p) => p.bbox[1])),
      Math.max(...parts.map((p) => p.bbox[2])),
      Math.max(...parts.map((p) => p.bbox[3])),
    ];
    return { page: row.page, text, conf, bbox };
  });
}

function isMetadataOnlyLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length < 3) return true;
  if (/^(?:订单号|order\s*(?:id|no|number)|运单号|快递单号|tracking|物流单号|实付款|合计|总计|subtotal|total|运费|shipping|收货地址|address|日期|date|店铺|seller|supplier)\s*[:：]?/i.test(t) && t.length < 48) {
    return true;
  }
  if (/^(?:item|product|sku|qty|quantity|size|color|price|商品名称|规格|颜色|尺码|数量|单价)[\s|/:]+/i.test(t) && !/\d{2,}/.test(t)) {
    return true;
  }
  return false;
}

export function parseOcrDocument(fullText: string, blocks: OcrRawBlock[], avgConfidence: number): ParsedOcrDocument {
  const warnings: string[] = [];
  const rawLines = fullText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let platform: string | null = null;
  for (const rule of PLATFORM_RULES) {
    if (rule.re.test(fullText)) {
      platform = rule.name;
      break;
    }
  }

  const orderNoMatch =
    fullText.match(/(?:订单编号|订单号|Order\s*(?:No|ID|#))\s*[:：]?\s*([A-Z0-9-]{8,32})/i) ??
    fullText.match(/\b(\d{16,22})\b/);
  const platformOrderNo = orderNoMatch ? orderNoMatch[1] : null;

  let trackingNo: string | null = null;
  const labeledTracking = fullText.match(/(?:运单号|快递单号|物流单号|Tracking(?:\s*No)?)\s*[:：]?\s*([A-Z0-9-]{8,30})/i);
  if (labeledTracking) {
    trackingNo = labeledTracking[1].toUpperCase();
  } else {
    for (const pat of TRACKING_PATTERNS) {
      const m = fullText.match(pat);
      if (m) {
        trackingNo = m[1].toUpperCase();
        break;
      }
    }
  }

  const supplierMatch = fullText.match(/(?:店铺|卖家|供应商|商家|Supplier|Seller|Store)\s*[:：]\s*([^\n]{2,60})/i);
  const supplierName = supplierMatch ? supplierMatch[1].trim() : null;

  const dateMatch = fullText.match(/\b(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)\b/);
  const orderDate = dateMatch ? dateMatch[1] : null;

  const docPrice = detectPrice(fullText);
  const docCurrency = docPrice?.currency ?? (/¥|￥|RMB|CNY|元/.test(fullText) ? "CNY" : /USD|\$/i.test(fullText) ? "USD" : null);

  const groupedRows = blocks.length > 0 ? groupBlocksIntoRows(blocks) : rawLines.map((line, i) => ({
    page: 1,
    text: line,
    conf: avgConfidence || 0.7,
    bbox: [0.05, Math.min(0.9, i * 0.05), 0.95, Math.min(0.95, (i + 1) * 0.05)] as [number, number, number, number],
  }));

  const candidates: ParsedCandidateRow[] = [];

  for (const row of groupedRows) {
    const line = row.text.trim();
    if (isMetadataOnlyLine(line)) continue;

    const sku = detectSku(line);
    const color = detectColor(line);
    const size = detectSize(line);
    const hasQtyToken = /(?:数量|qty|x|×|\*|件|pcs|pieces|units)/i.test(line);
    const qty = detectQuantity(line);
    const rowPrice = detectPrice(line);

    const looksLikeLineItem =
      Boolean(sku) ||
      Boolean(color && size) ||
      Boolean(hasQtyToken) ||
      Boolean(rowPrice && line.length >= 8) ||
      /(?:hoodie|tee|t-shirt|legging|bra|shorts|jacket|pants|dress|skirt|卫衣|T恤|短袖|瑜伽|裤|外套|运动内衣|连衣裙)/i.test(line);

    if (!looksLikeLineItem) continue;

    let cleanName = line
      .replace(/([A-Za-z])(XXXL|XXL|XL|XS|S|M|L)(?=\s|SKU|Qty|Size|$)/g, "$1 $2")
      .replace(/([A-Za-z0-9])((?:SKU|Qty|Quantity|Size|Color|Price)\s*[:：])/gi, "$1 $2")
      .replace(/(?:SKU|款号|货号)\s*[:：#]?\s*[A-Z0-9][A-Z0-9_-]*?(?=\s|(?:Qty|Quantity|Size|Color|数量|尺码|[¥￥$€])|$)/gi, "")
      .replace(/(?:数量|qty)\s*[:：]?\s*\d+/gi, "")
      .replace(/[x×*]\s*\d+\b/gi, "")
      .replace(/([¥￥$€]|USD|CNY|RMB|HKD)\s*\d+(?:\.\d{1,2})?/gi, "")
      .replace(/\b(XXXL|XXL|XL|XS|S|M|L)\b/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[|\-–—•·\d.\s]+(?=[A-Za-z\u4e00-\u9fa5])/, "")
      .trim();

    if (!cleanName || cleanName.length < 2) {
      cleanName = line.slice(0, 80);
    }

    const rowConf = Number(Math.max(0.2, Math.min(0.99, row.conf)).toFixed(4));
    const itemConf = cleanName.length >= 4 ? rowConf : Math.min(rowConf, 0.6);

    candidates.push({
      sort_index: candidates.length,
      platform,
      supplier_name: supplierName,
      platform_order_no: platformOrderNo,
      tracking_no: trackingNo,
      item_name: cleanName.slice(0, 140),
      sku_code: sku,
      color,
      size,
      quantity: qty,
      unit_price_text: rowPrice?.text ?? null,
      currency: rowPrice?.currency ?? docCurrency,
      order_date: orderDate,
      confidence: itemConf,
      field_confidences: {
        item_name: itemConf,
        sku_code: sku ? rowConf : 0.4,
        color: color ? rowConf : 0.45,
        size: size ? rowConf : 0.45,
        quantity: hasQtyToken ? rowConf : 0.55,
      },
      bbox: { page: row.page, rect: row.bbox },
      raw_excerpt: line.slice(0, 220),
    });
  }

  if (candidates.length === 0) {
    warnings.push("No structured SKU/product line items were confidently isolated. Review raw text or transcribe manually.");
  }
  if (!trackingNo) {
    warnings.push("Waybill/tracking number was not detected in this file; enter or verify tracking separately.");
  }
  const lowConfCount = candidates.filter((c) => c.confidence < 0.72).length;
  if (lowConfCount > 0) {
    warnings.push(`${lowConfCount} extracted item row(s) have confidence below 72% — inspect highlighted fields before confirming.`);
  }
  if (avgConfidence > 0 && avgConfidence < 0.72) {
    warnings.push(`Average OCR confidence is ${(avgConfidence * 100).toFixed(0)}%. Please double-check extracted values.`);
  }

  const needsReview = candidates.length === 0 || lowConfCount > 0 || avgConfidence < 0.72;
  return {
    platform,
    supplier_name: supplierName,
    platform_order_no: platformOrderNo,
    tracking_no: trackingNo,
    order_date: orderDate,
    currency: docCurrency,
    candidates,
    warnings,
    needs_review: needsReview,
  };
}
