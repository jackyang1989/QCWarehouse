# QCWarehouse — P0/P1 End-to-End Acceptance Report

Date: 2026-11-19
Live Local Workspace: `http://localhost:3000` (`next dev --webpack --port 3000`, `QCW_DEMO=1`, `DATABASE_URL=postgresql://127.0.0.1:5432/qcw_test-workspace-final`) — existing Demo user `f84bf4d6…` (`4` drafts, `8` non-draft orders, `0` active Golden Samples) preserved untouched.
Isolated User-Journey E2E Server & DB: `http://localhost:3005` (`qcw_test_user_journey_e2e`, stopped cleanly after E2E finished).

See also: [Commercial Pricing & SLA Decision Matrix](COMMERCIAL_SLA_PRICING_DECISION.md), [P0/P1 Remediation Matrix](P0-P1_ISSUE_MATRIX.md), and [Service Flow Matrix](SERVICE_FLOW_MATRIX.md).

## 1. Automated Verification Summary

| Gate | Command | Scope & Conditions | Observed Result |
|---|---|---|---|
| TypeScript check | `npm run check` | `tsc --noEmit` across entire repository | **PASS** (exit `0`) |
| Whitespace / patch hygiene | `git diff --check` | All modified tracked files | **PASS** (exit `0`) |
| Docs & API contract check | `python3 docs/contracts/check.py` | Contracts, pages, tasks, and relative doc links | **PASS** (exit `0`) |
| Production Next.js build | `npm run build` | `next build` (Turbopack) | **PASS** (exit `0`) |
| Backend integration suite | `TEST_DATABASE_URL=postgresql://127.0.0.1:5432/qcw_test-workspace npm run test:integration` | Full `../tests/workflow.test.mts` including strict OpenAPI response validation (`all core operations`) | **PASS** (`68 / 68` passed, `0` failed, `0` skipped, `30636ms`) |
| Pre-Launch 9-Scenario Real Browser E2E (`A–I`) | `node /Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/scratch/p1_prelaunch_e2e.mjs` | Headless Chrome against isolated `qcw_test_user_journey_e2e` (`http://localhost:3005`); OTP onboarding, 1440/1280/768/390px viewports, multi-parcel `Contents unknown`, `48/50` unidentified vs SKU-level discrepancy + customer proceed resolution, cross-size rule, Golden Sample 4 states, RBAC | **PASS** (`A–I` all passed, `16 / 16` unique screenshots, `0px` viewport overflow across all `16` checks, `0` console/page errors) |

## 2. Pre-Launch Real Browser Verification Matrix (`A–I`, `p1_prelaunch_e2e.mjs`)

| Scenario | Scope & Path Tested | Observed Result & Evidence |
|---|---|---|
| `A` | Product Inspection · `tops`, 1 SKU × 3 units (`$105.00`) + Step 2 SLA clock-start prerequisites + Step 1–6 Pay | **PASS** (`QW-71B7424DCDD7`, `$105.00`) |
| `B` | Product Inspection · `basic`, 50u / 6 SKUs (`4` clicks, `530ms`) -> auto-collapse 3B defaults -> `48/50` intake discrepancy: Phase B1 honest `48 Unidentified (Pending SKU scan)` -> `/actions` entry -> Phase B2 after SKU assignment pinpoints `TEE-WHT-L (2 missing)` -> customer clicks `Proceed with Received Items (48)` without changing `$1,450.00` charge | **PASS** (`QW-E48639038165`, `$1,450.00`, `Proceed recorded`) |
| `C` | Product Inspection · `basic`, 50u / 3 Parcels / 2 Suppliers with `Contents unknown — warehouse will reconcile on receipt` -> 1-click `Register all declared waybills (3)` -> check in Parcel 1 (`20` units), Parcels 2–3 in transit (`0` false shortage alerts) | **PASS** (`QW-D8F28AC791CC`, `20 arrived / 2 in transit`) |
| `D` | Screenshot Upload Only (`No Auto-OCR` `OPEN`) -> 4-option `[data-testid="step3a-next-action-guide"]`, disabled Continue -> `+ Transcribe Row Here` -> `Edited` tag -> confirm & unblock | **PASS** |
| `E` | Sample Comparison (`2` samples `$59.00` & `3` samples `$79.00`) + different sizes (`M` vs `L`) -> explicit `[data-testid="compare-cross-size-grading-rule"]` rendered on Steps 3B, 4, and 5 | **PASS** (`QW-3503029BEBAB`, `QW-C37CBC057F0D`) |
| `F` | Golden Sample Matching 4 states: `0` active (`EXPECTED_BLOCKED`) -> `pending_safe_storage` (`EXPECTED_BLOCKED`) -> active `GS-20261119-031885` (`1` candidate `$39.00`, full Order Detail vault card) -> `10` candidate units (`422 MANUAL_QUOTE_REQUIRED` catalog `max=1` `OPEN` disclosed in Step 2) | **PASS** (`QW-3C94307DC68F` / `OPEN max=1`) |
| `G` | Service Switch (`Product Inspection -> Sample Comparison`) -> immediate `[data-testid="step1-confirm-retained-btn"]` in Step 1 clears Step 3 `Pending re-association` guard upfront | **PASS** |
| `H` | Customer Workspace Role Isolation & RBAC -> `Portal switcher` / `Customer preview` / 1-click staff escalation absent in customer header; `/wh` & `/admin` blocked (`需要员工权限`); `/api/v1/staff/desk` & `/api/v1/staff/orders` return `403` | **PASS** (`Header isolated`, `/api/v1/staff/* 403`) |
| `I` | Responsive `1440px`, `1280px`, `768px`, `390px` active inputs -> `768px` & `390px` render compact top status bar & place Step 3 form above collapsed summary (`formTop < summaryCardTop`); desktop `Product Name` input width `168px` (`0` text truncation), `0px` horizontal overflow everywhere | **PASS** (`16 / 16` layout checks) |

## 3. Latest Pre-Launch Screenshot Evidence (`browser_evidence/prelaunch_e2e/`)

| File | Route / Viewport | Verified Visual & Interactive Element | SHA-256 Prefix & Bytes |
|---|---|---|---|
| `A-step3-single-sku-1440.png` | `/orders/new` · `1440x900` | Single SKU active input table + sticky Summary | `e597d168a889` (`377937 B`) |
| `A-step3-single-sku-1280.png` | `/orders/new` · `1280x900` | Compact desktop sidebar + full-width Product Name | `b3bc0d6bc973` (`375541 B`) |
| `A-step3-single-sku-768.png` | `/orders/new` · `768x1024` | Top compact summary bar + 3-col tablet cards first | `27a047a8e6b4` (`295970 B`) |
| `A-step3-single-sku-390.png` | `/orders/new` · `390x844` | Mobile compact bar + 2-col card rows above summary | `b134dd154fd3` (`279777 B`) |
| `B-step3-50u-6sku-1280.png` | `/orders/new` · `1280x900` | Auto-collapsed 3B defaults + 6 SKUs / 50u legible | `59f088cbcdbb` (`444622 B`) |
| `B-order-48-unidentified-1440.png` | `/orders/QW-E48639038165` · `1440x900` | Dual reconciliation: 48 unidentified pending SKU scan | `2a86f9c7d9c5` (`600835 B`) |
| `B-order-48-sku-missing-1440.png` | `/orders/QW-E48639038165` · `1440x900` | Dual reconciliation: `TEE-WHT-L 2 missing` + 3 resolution buttons | `3f31b6f25f83` (`732288 B`) |
| `C-step3-3parcels-unknown-768.png` | `/orders/new` · `768x1024` | Step 3C 3-parcel `Contents unknown` mode on tablet | `3f666da567df` (`523614 B`) |
| `C-order-3parcels-1arrived-1440.png` | `/orders/QW-D8F28AC791CC` · `1440x900` | 3 parcels (`20` logged, `2` in transit, `0` false shortage) | `9a46db6921da` (`558926 B`) |
| `D-screenshot-guide-EXPECTED_BLOCKED-1440.png` | `/orders/new` · `1440x900` | 3A Recommended Next Step 4-option action card | `ad885053b4be` (`502004 B`) |
| `E-step3-compare-cross-size-1440.png` | `/orders/new` · `1440x900` | Cross-size dimensional exclusion rule + wide Sample Comparison table | `ef0a7f029b00` (`448606 B`) |
| `F-order-golden-1u-1440.png` | `/orders/QW-3C94307DC68F` · `1440x900` | Golden Sample `GS-20261119-031885` vault card on Order Detail | `3b710ace6c96` (`243171 B`) |
| `H-customer-header-isolated-1440.png` | `/account` · `1440x900` | Clean customer workspace topbar without `Warehouse / Admin / Customer preview` | `16f341616eac` (`190010 B`) |

*(Baseline 21-screenshot pre-check archive also retained in `browser_evidence/user_journey_e2e/`.)*

## 4. Open External Dependencies (`OPEN`)

- **Automated Vision / PDF OCR Service (`OPEN`)**: No external OCR backend is wired in this environment; Step 3A strictly marks image/PDF uploads `Reference only (No Auto-OCR)` and never fabricates SKU rows or billable quantities.
- **Production Third-Party Services & Warehouse Sign-off (`OPEN`)**: Production Stripe live keys/webhooks, Postmark email credentials, Kuaidi100 webhook credentials, physical barcode scanner/printer testing, and formal commercial SLA/rate-card approvals remain separate production release gates.
