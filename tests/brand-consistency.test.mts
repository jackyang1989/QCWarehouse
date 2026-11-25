import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { BRAND_ASSETS, BRAND_COLOR_NAVY, BRAND_DOMAIN, BRAND_NAME, BRAND_UPPERCASE } from "../packages/core/brand.ts";

const ROOT = process.cwd();

test("brand configuration single source of truth", () => {
  assert.equal(BRAND_NAME, "QC Warehouse");
  assert.equal(BRAND_UPPERCASE, "QC WAREHOUSE");
  assert.equal(BRAND_DOMAIN, "qcwarehouse.com");
  assert.equal(BRAND_COLOR_NAVY, "#031129");
});

test("official brand PNG wordmarks and icons exist with exact alpha parity", async () => {
  const requiredFiles = [
    path.join(ROOT, "public", BRAND_ASSETS.wordmark),
    path.join(ROOT, "public", BRAND_ASSETS.wordmarkWhite),
    path.join(ROOT, "public", BRAND_ASSETS.openQc),
    path.join(ROOT, "public", BRAND_ASSETS.openQcWhite),
    path.join(ROOT, "public", BRAND_ASSETS.appIcon192),
    path.join(ROOT, "public", BRAND_ASSETS.appIcon512),
    path.join(ROOT, "app", "icon.svg"),
    path.join(ROOT, "app", "icon.png"),
    path.join(ROOT, "app", "apple-icon.png"),
  ];
  for (const file of requiredFiles) {
    assert.ok(fs.existsSync(file), `Missing brand asset: ${path.relative(ROOT, file)}`);
  }

  const navyWm = await sharp(path.join(ROOT, "public", BRAND_ASSETS.wordmark)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const whiteWm = await sharp(path.join(ROOT, "public", BRAND_ASSETS.wordmarkWhite)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(navyWm.info.width, BRAND_ASSETS.width);
  assert.equal(navyWm.info.height, BRAND_ASSETS.height);
  assert.equal(whiteWm.info.width, BRAND_ASSETS.width);
  assert.equal(whiteWm.info.height, BRAND_ASSETS.height);

  for (let i = 0; i < navyWm.data.length; i += 4) {
    assert.equal(navyWm.data[i + 3], whiteWm.data[i + 3], `Wordmark alpha mismatch at byte ${i}`);
    if (whiteWm.data[i + 3] > 200) {
      assert.equal(whiteWm.data[i], 255);
      assert.equal(whiteWm.data[i + 1], 255);
      assert.equal(whiteWm.data[i + 2], 255);
      assert.ok(navyWm.data[i] <= 5 && navyWm.data[i + 1] <= 20 && navyWm.data[i + 2] <= 46);
    }
  }

  const navyQ = await sharp(path.join(ROOT, "public", BRAND_ASSETS.openQc)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const whiteQ = await sharp(path.join(ROOT, "public", BRAND_ASSETS.openQcWhite)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(navyQ.info.width, BRAND_ASSETS.iconSize);
  assert.equal(navyQ.info.height, BRAND_ASSETS.iconSize);
  assert.equal(whiteQ.info.width, BRAND_ASSETS.iconSize);
  assert.equal(whiteQ.info.height, BRAND_ASSETS.iconSize);
  for (let i = 0; i < navyQ.data.length; i += 4) {
    assert.equal(navyQ.data[i + 3], whiteQ.data[i + 3], `Open QC icon alpha mismatch at byte ${i}`);
  }
});

test("legacy 3D cube mark and hardcoded concatenated brand spelling are removed", () => {
  const chrome = fs.readFileSync(path.join(ROOT, "app", "chrome.tsx"), "utf8");
  assert.doesNotMatch(chrome, /M19 3 33 11v16/);
  assert.doesNotMatch(chrome, /<span>QCWarehouse<\/span>|<span>QC Warehouse<\/span>/);
  assert.match(chrome, /BRAND_ASSETS\.wordmark/);

  const favicon = fs.readFileSync(path.join(ROOT, "app", "icon.svg"), "utf8");
  assert.doesNotMatch(favicon, /M19 3 33 11v16/);
  assert.match(favicon, /#031129/);

  const scanDirs = ["app", "packages", "public"];
  const skipExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf", ".ico", ".sql", ".DS_Store"]);
  const hits: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "migrations" || entry.name === "brand") continue;
        walk(full);
      } else if (!skipExt.has(path.extname(entry.name))) {
        const text = fs.readFileSync(full, "utf8");
        for (const [idx, line] of text.split("\n").entries()) {
          if (/QCWarehouse|QCWAREHOUSE/.test(line)) {
            hits.push(`${path.relative(ROOT, full)}:${idx + 1}:${line.trim()}`);
          }
        }
      }
    }
  }
  for (const d of scanDirs) walk(path.join(ROOT, d));
  assert.deepEqual(hits, [], `Found unstandardized user-facing brand spellings:\n${hits.join("\n")}`);
});
