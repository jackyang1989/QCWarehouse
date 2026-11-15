# QCWarehouse — P0/P1 End-to-End Acceptance Report

Date: 2026-11-15
Target Application: `http://localhost:3000` (`next dev --webpack --port 3000`, `QCW_DEMO=1`, DB `qcw_test-workspace-final`)
Integration Database: `postgresql://127.0.0.1:5432/qcw_test-workspace`

## 1. Automated Verification Summary

| Gate | Command | Scope & Conditions | Observed Result |
|---|---|---|---|
| TypeScript check | `npm run check` | `tsc --noEmit` across entire repo | **PASS** (exit `0`) |
| Whitespace / patch hygiene | `git diff --check` | All modified tracked files | **PASS** (exit `0`) |
| Docs & API contract check | `python3 docs/contracts/check.py` | 174 tasks, E1–E236, 69 pages, 111 cases, 46 product gates, 49 ops | **PASS** (exit `0`) |
| Production Next.js build | `npm run build` | `next build` (Turbopack) | **PASS** (exit `0`) |
| Empty schema + SQL invariants | `docs/contracts/schema.sql` + `docs/contracts/verify.sql` on `qcw_verify` | Executed in disposable clean Postgres DB before commit | **PASS** (exit `0`, rollback verified) |
| Backend integration suite | `TEST_DATABASE_URL=postgresql://127.0.0.1:5432/qcw_test-workspace npm run test:integration` | Full `tests/workflow.test.mts` suite including new `expected_lines` 422 & subcategory offer test | **PASS** (`68 / 68` passed, `0` failed, `0` skipped, `30856ms`) |
| Live Browser P0/P1 E2E Suite | `QCW_PLAYWRIGHT_MODULE=/tmp/qcw-browser-tooling/node_modules/playwright/index.mjs node /Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/scratch/p0_final_e2e.mjs` | Chromium headless against running Next dev server; real session cookies, CSRF, multipart media uploads, Demo Pay, worker publish, warehouse intake & vault sealing | **PASS** (exit `0`, `0` page errors) |

*(Note: The legacy full-stack `tests/workspace.browser.mjs` runner was not separately executed after the final edit; all customer workspace routes, negative cases, 6 viewports, and all 3 service flows were verified directly via `p0_final_e2e.mjs` + `68 / 68` integration tests.)*

## 2. Browser E2E Test Matrix (`p0_final_e2e.mjs`)

### A. Negative & Guardrail Cases (`9 / 9 PASS`)
1. `invalidOfferParam`: `/orders/new?offer=does-not-exist` surfaces warning notice without crashing or silent default masking — **PASS**
2. `categoryStatusConsistency`: `/` homepage (`Apparel Is Live Today`) and Step 1 agree `Apparel` is active and planned/restricted categories are genuinely disabled — **PASS**
3. `goldenSampleZeroBlockedStep1`: With `0` active vault samples, `Golden Sample Matching` shows `"Requires an approved reference sample"` and `golden-sample-step1-gate`, and disables `Continue →` and `Step 2` across `1440px` and `390px` — **PASS**
4. `generalApparelShotsFallback`: Step 2 displays `Standard Studio Camera Angles` when template `shots` list is empty on `General Apparel` — **PASS**
5. `unconfirmedCandidatesBlocked`: Pasting rows into Step 3A puts `Order Summary` into `Action required` and disables Step 4 navigation until confirmed — **PASS**
6. `quantityMismatchInvalidatesEstimate`: Editing line qty `2 -> 4` while auto-sync is off marks `CATALOG ESTIMATE` as `Outdated estimate` with zero payable dollar total — **PASS**
7. `autoSyncImmediateFix`: Checking `Auto-sync Step 2 commissioned quantity` immediately syncs qty to `4` and updates estimate to `$140.00` — **PASS**
8. `serviceSwitchResetsState`: Returning Step 3 -> Step 1 and switching `Product Inspection` -> `Sample Comparison` clears incompatible lines/parcels/quotes while preserving uploaded `media_id` file (`1 file(s)`) — **PASS**
9. `evidenceRemoveSyncsCount`: Clicking `Remove File` updates `Order Summary` to `0 file(s)` — **PASS**

### B. Full Positive Service Workflows (`3 / 3 PASS`)
1. **Product Inspection (Tops & Knitwear · 50 units · 6 SKUs · 2 suppliers · 3 parcels · 48/50 Discrepancy)**:
   - Order `QW-63A714CB655E`, `$1,750.00 USD` (`Tops & Knitwear × 50`), paid via Demo Pay.
   - Purchased PO image uploaded (`_fixture_po.png`) + 6 CSV rows parsed (`2` total evidence items verified on Step 5 & Order Summary).
   - Auto-grouped `Planned Multi-Parcel List (3)`; warehouse checked in 3 parcels and logged `18 + 18 + 12 = 48` units vs `50` expected; `/parcels?tab=received` rendered `Quantity discrepancy (12/14)`.
2. **Sample Comparison (Tops & Knitwear · 3 samples · 3 suppliers)**:
   - Order `QW-4EE3CBFA1F50`, `$79.00 USD`, 3 initialized lines (`Supplier Alpha`, `Supplier Beta`, `Supplier Gamma`), Demo Pay completed.
3. **Golden Sample Matching (Seed -> Vault Sealing -> Match Order)**:
   - Seed inspection order received, inspected (`2`-pass measurements + required shots), report approved (`202`), published via `workOnce()`, reserved (`reserve_reference`), sealed by warehouse into `A-04-02-03` (`GS-20261115-116026`).
   - Verified `/items#reference-samples` visibility, booked restock match order `QW-8BE99869AA38` (`$39.00 USD`), Demo Pay completed.

### C. Responsive & DOM Uniqueness Matrix (`0px` horizontal overflow across all checks)
- Viewports verified: `1440px`, `1280px`, `1024px`, `768px`, `390px`, `375px` (`6` widths on 50-unit Step 3; `1440/1280/768/390/375` across `/account`, `/orders`, `/actions`, `/reports`, `/parcels`, `/items#reference-samples`, `/account/billing`, `/account/notifications`, `/support`).
- Every `/orders/new` check asserted strictly `order-summary-card === 1`, `order-summary-estimate === 1`, `order-summary-alert <= 1`, and `document.documentElement.scrollWidth - window.innerWidth <= 1` (`0px` observed).

## 3. Visually Inspected Screenshot Evidence (`browser_evidence/p0_final/`)
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/01-home-category-consistency-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/02-step1-golden-blocked-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/03-step1-golden-blocked-390.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/04-step3-qty-mismatch-outdated-estimate-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/05-step3-scrolled-single-summary-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/06-flow1-50u-step3-1280.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/06-flow1-50u-step3-390.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/06-flow1-50u-step3-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/07-flow1-50u-step5-quote-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/08-flow1-parcels-48-vs-50-discrepancy-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/09-flow1-order-detail-discrepancy-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/10-flow2-compare-3-step5-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/11-flow3-golden-step1-ready-1440.png`
- `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/12-flow3-golden-step5-quote-1440.png`
- Raw JSON summary: `/Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/browser_evidence/p0_final/summary.json`

## 4. Known Open Items (`OPEN`)
- **Automated Vision/PDF OCR service**: Marked `OPEN` cleanly in UI (`Vision / PDF OCR Status (OPEN)`), never faked; deterministic CSV/TSV/1688 text parsing and manual transcription with SHA-256 evidence archival and user confirmation queue are production-ready.
- **External SaaS & real warehouse environment verification**: Real Stripe live webhook/checkout, Postmark production mail, Kuaidi100 live webhook credentials, and physical scanner/warehouse SOP sign-off remain separate go-live gates.
