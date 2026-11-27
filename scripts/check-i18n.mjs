#!/usr/bin/env node
import { FIXED_I18N_RESOURCES } from "../packages/core/i18n/messages";
import { validateFixedResourceBundle } from "../packages/core/locale-contract";
import { PUBLIC_ROUTE_SEO_KEYS, PUBLIC_ROUTE_SEO_ZH_KEYS } from "../app/public-seo";

const seen = new Set();
const duplicates = [];
const stubHits = [];
const stubPattern = /\b(TODO|TBD|FIXME)\b|\?\?\?/;

for (const entry of FIXED_I18N_RESOURCES) {
  if (seen.has(entry.key)) {
    duplicates.push(entry.key);
  }
  seen.add(entry.key);
  for (const [loc, text] of Object.entries(entry.values)) {
    if (typeof text === "string" && stubPattern.test(text)) {
      stubHits.push({ key: entry.key, locale: loc, text });
    }
  }
}

const bundleCheck = validateFixedResourceBundle(FIXED_I18N_RESOURCES);
const missingSeoZh = PUBLIC_ROUTE_SEO_KEYS.filter((k) => !PUBLIC_ROUTE_SEO_ZH_KEYS.includes(k));
const extraSeoZh = PUBLIC_ROUTE_SEO_ZH_KEYS.filter((k) => !PUBLIC_ROUTE_SEO_KEYS.includes(k));

if (
  duplicates.length > 0 ||
  stubHits.length > 0 ||
  !bundleCheck.ok ||
  missingSeoZh.length > 0 ||
  extraSeoZh.length > 0
) {
  console.error("i18n CI check FAILED:", JSON.stringify({
    duplicates,
    stubHits,
    missingKeys: bundleCheck.missingKeys,
    placeholderMismatches: bundleCheck.placeholderMismatches,
    missingSeoZh,
    extraSeoZh,
  }, null, 2));
  process.exit(1);
}

console.log(
  `i18n CI check OK: ${FIXED_I18N_RESOURCES.length} fixed keys (en-US/zh-CN complete, 0 placeholder mismatches, ${PUBLIC_ROUTE_SEO_KEYS.length} SEO routes paired).`,
);
