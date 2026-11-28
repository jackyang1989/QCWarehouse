const MAX_SVG_BYTES = 200 * 1024;

const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "title",
  "desc",
]);

const FORBIDDEN_PATTERNS: [RegExp, string][] = [
  [/<!\s*(?:doctype|entity)|<!\[cdata\[/i, "DTD declarations, entities, and CDATA sections are strictly forbidden in SVG."],
  [/<\s*script\b/i, "<script> tags are strictly forbidden in measurement SVGs."],
  [/<\s*foreignobject\b/i, "<foreignObject> tags are strictly forbidden in measurement SVGs."],
  [
    /<\s*(?:iframe|object|embed|applet|meta|link|base|audio|video|canvas|handler|switch|use|animate|animatetransform|animatemotion|set)\b/i,
    "Active/external/animation/use HTML or SVG tags are forbidden in measurement SVGs.",
  ],
  [/<\s*style\b/i, "Inline <style> blocks are forbidden; use standard vector fill/stroke attributes."],
  [/\bstyle\s*=/i, "Inline style= attributes are forbidden; use explicit vector presentation attributes."],
  [/<\s*image\b/i, "Embedded raster <image> tags are forbidden; measurement templates must be pure vector SVG."],
  [/\bon[a-z0-9_-]+\s*=/i, "Inline event handler attributes (on*=) are strictly forbidden in SVG."],
  [/javascript\s*:/i, "javascript: URIs are forbidden in SVG."],
  [/vbscript\s*:/i, "vbscript: URIs are forbidden in SVG."],
  [/data\s*:/i, "data: URIs are forbidden in pure-vector measurement SVGs."],
  [/(?:href|xlink:href|src)\s*=\s*(?:["']\s*(?!#)|[^"'\s#>])/i, "External or non-local resource references (href/xlink:href/src) are forbidden in SVG."],
  [/@import\b|expression\s*\(|url\s*\(/i, "External CSS imports, expressions, or url() references are forbidden in SVG."],
];

function decodeCharacterEscapesForScan(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);?/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, " ")
    .replace(/&newline;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

export type SanitizedSvgResult = {
  svg: string;
  viewBox: string;
  width: number;
  height: number;
};

export type PureSvgSanitizeOutcome =
  | { ok: true; value: SanitizedSvgResult }
  | { ok: false; message: string };

/**
 * Pure browser- and server-safe SVG vector sanitizer with zero Node-only imports.
 * Single authority called by both server (`validateAndSanitizeSvg`) and `"use client"` UI (`PAGE-M23`).
 */
export function sanitizeSvgPure(rawInput: string): PureSvgSanitizeOutcome {
  const raw = rawInput.replace(/^\uFEFF/, "").trim();
  const utf8Bytes = new TextEncoder().encode(raw).length;
  if (raw.length === 0 || utf8Bytes > MAX_SVG_BYTES) {
    return { ok: false, message: "SVG content must be non-empty and at most 200 KB." };
  }

  if (/<!\s*(?:doctype|entity)|<!\[cdata\[/i.test(raw)) {
    return { ok: false, message: "DTD declarations, entities, and CDATA sections are strictly forbidden in SVG." };
  }

  const cleaned = raw
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  const decoded = decodeCharacterEscapesForScan(cleaned);
  for (const surface of [cleaned, decoded]) {
    for (const [pattern, message] of FORBIDDEN_PATTERNS) {
      if (pattern.test(surface)) {
        return { ok: false, message };
      }
    }
  }

  if (!/^<svg\b/i.test(cleaned) || !/<\/svg>\s*$/i.test(cleaned)) {
    return { ok: false, message: "SVG must contain a single <svg> root element." };
  }
  const svgOpenCount = (cleaned.match(/<svg\b/gi) ?? []).length;
  if (svgOpenCount !== 1) {
    return { ok: false, message: "Nested <svg> elements are not permitted." };
  }

  const openTagMatch = cleaned.match(/^<svg\b([^>]*)>/i);
  if (!openTagMatch) {
    return { ok: false, message: "Malformed <svg> root tag." };
  }
  const viewBoxMatch = openTagMatch[1]!.match(/\bviewBox\s*=\s*["']\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*["']/i);
  if (!viewBoxMatch) {
    return { ok: false, message: 'SVG root must declare numeric viewBox="0 0 <width> <height>".' };
  }
  const width = Number(viewBoxMatch[1]);
  const height = Number(viewBoxMatch[2]);
  if (!(width > 0 && height > 0 && width <= 4000 && height <= 4000)) {
    return { ok: false, message: "SVG viewBox dimensions must be between 1 and 4000." };
  }

  const tagMatches = cleaned.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9:_-]*)\b/g);
  for (const m of tagMatches) {
    const tagName = m[1]!.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      return { ok: false, message: `Unsupported or potentially unsafe SVG element '<${tagName}>'.` };
    }
  }

  return {
    ok: true,
    value: {
      svg: cleaned,
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
    },
  };
}
