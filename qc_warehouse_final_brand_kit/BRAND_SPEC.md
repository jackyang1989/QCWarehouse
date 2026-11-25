# QC Warehouse (Open QC) — Final Brand Identity Standard

## 1. Exact Measured Geometry (Normalized to Q Outer Diameter D = 100)
- **Outer Diameter (D)**: `100.0` (Radius `R_out = 50.0`)
- **Inner Diameter (D_in)**: `61.4` (Radius `R_in = 30.7`)
- **Ring Thickness (T)**: `19.3`
- **Tail Width × Length**: `17.7 × 53.2` (`45.0°`, `s_start = 14.7` to `s_end = 67.9`, outer extension `+17.9`)
- **Negative Space (G)**: `7.3` each side (`1:1` symmetric parallel channel)
- **Pixel-Level Vector Fidelity**: `97.28%` IoU against approved master bitmap (`深海蓝 QC Warehouse 几何字标.png`)

## 2. Official Color Palette (Flat Monochrome Only)
- **Primary Brand Color (Deep Navy)**: `#031129` (RGB `3, 17, 41`)
- **Reversed White**: `#FFFFFF`
- **Pure Black (Thermal Label / Print)**: `#000000`
- **Platform Interactive Accent Blue (UI Buttons Only)**: `#245DE4`

## 3. Included Production Files
- `master/`: Preserved unmodified user-uploaded source bitmaps:
  - `qc-warehouse-wordmark-master-upload.jpg` (`1024×341` RGB, SHA-256 `9f650cfdcf62199c297a7d194616eb76c3e256c538f943a9d7614b9e722dcce9`, detected tight wordmark crop `x=105..919, y=126..224`, `815×99`)
  - `open-qc-master-upload.png` (`256×256` RGBA, SHA-256 `1488f23dd899ccc38d57d6d7e5acc3437847220d029e35384b71173da0d702a0`)
- `svg/`: `wordmark.svg`, `wordmark-white.svg`, `wordmark-black.svg`, `open-qc.svg`, `open-qc-white.svg`, `open-qc-black.svg`, `app-icon.svg`, `favicon.svg`
- `png/`: App Icons (`16×16` through `1024×1024`), Standalone Marks (`64/256/512`), Transparent Wordmarks (`640w/1280w`)
- `qc-warehouse-brand-standard.pdf`: Vector Brand Identity Standard Sheet

## 4. Application Deployment Paths & Single Source of Truth
- Canonical constants: `packages/core/brand.ts` (`BRAND_NAME = "QC Warehouse"`, `BRAND_DOMAIN = "qcwarehouse.com"`)
- Shared UI component: `app/chrome.tsx` (`<Brand variant="default" | "white" mode="wordmark" | "mark"/>`)
- Public PNG wordmarks (`1280×164` RGBA, identical alpha channel verified with `sharp`):
  - `public/brand/qc-warehouse-wordmark.png` (`#031129`, SHA-256 `0181a5f0bcab26a2...`)
  - `public/brand/qc-warehouse-wordmark-white.png` (`#FFFFFF`, SHA-256 `45a653ff05d6ab3a...`)
- Standalone Open QC icons (`512×512` RGBA, identical alpha channel):
  - `public/brand/open-qc.png`, `public/brand/open-qc-white.png`
- App & Favicon routes: `app/icon.svg`, `app/icon.png` (`192×192`), `app/apple-icon.png` (`180×180`), `public/brand/app-icon-192.png`, `public/brand/app-icon-512.png`
- Automated check: `npm run test:brand` (`tests/brand-consistency.test.mts`)
