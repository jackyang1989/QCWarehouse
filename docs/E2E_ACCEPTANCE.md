# QCWarehouse — P0/P1 End-to-End Acceptance Report

Date: 2026-11-15
Live Local Workspace: `http://localhost:3000` (`next dev --webpack --port 3000`, PID `11253`, `QCW_DEMO=1`, `DATABASE_URL=postgresql://127.0.0.1:5432/qcw_test-workspace-final`) — existing Demo user `f84bf4d6…` (`4` drafts, `8` non-draft orders, `0` active Golden Samples) preserved untouched.
Isolated User-Journey E2E Server & DB: `http://localhost:3005` (`qcw_test_user_journey_e2e`, stopped cleanly after E2E finished).

## 1. Automated Verification Summary

| Gate | Command | Scope & Conditions | Observed Result |
|---|---|---|---|
| TypeScript check | `npm run check` | `tsc --noEmit` across entire repository | **PASS** (exit `0`) |
| Whitespace / patch hygiene | `git diff --check` | All modified tracked files | **PASS** (exit `0`) |
| Docs & API contract check | `python3 docs/contracts/check.py` | 174 tasks, E1–E236, 69 pages, 111 cases, 46 product gates, 49 ops | **PASS** (exit `0`) |
| Production Next.js build | `npm run build` | `next build` (Turbopack) | **PASS** (exit `0`) |
| Backend integration suite | `TEST_DATABASE_URL=postgresql://127.0.0.1:5432/qcw_test-workspace npm run test:integration` | Full `../tests/workflow.test.mts` including `PATCH /orders/:id` `pending_reassociation` `422` test | **PASS** (`68 / 68` passed, `0` failed, `0` skipped, `29998ms`) |
| 10-Scenario Real Browser User-Journey Suite | `node /Users/jianouyang/.gemini/antigravity/brain/d5ad6ffa-b7ba-43c8-939e-75f0337636c2/scratch/p0_user_journey_e2e.mjs` | Headless Chrome against isolated `qcw_test_user_journey_e2e` (`http://localhost:3005`); OTP login, registration, multipart uploads, 4 viewports, Demo Pay, warehouse intake & GS sealing | **PASS** (`10 / 10` scenarios, `21 / 21` unique screenshots, `21 / 21` viewport overflow `0px`, `0` page/console errors) |

## 2. Ten-Scenario Real User-Journey Matrix (`p0_user_journey_e2e.mjs`)

| ID | Scenario & Path Tested | Expected Behavior | Observed Result & Order/Evidence |
|---|---|---|---|
| `S1` | Product Inspection · `tops`, 1 style × 3 units (`$35 × 3 = $105.00`) | Fresh account starts at `0 line(s)` + `PROVISIONAL ESTIMATE`, `+ Add 1 Product Line (Qty = 3)` confirms row -> Steps 4–6 + Demo Pay | **PASS** (`QW-85DCCB501DFF`, `$105.00`) |
| `S2` | Product Inspection · `basic`, 50 units / 6 SKUs / 1 Box (`$29 × 50 = $1,450.00`) + warehouse intake discrepancy | Paste 6 CSV lines -> confirm -> `Single Parcel / One Box` -> pay -> staff logs `48` units -> `/parcels?tab=received` shows `Quantity discrepancy (48/50)` | **PASS** (`QW-99E01DD69B28`, `$1,450.00`, `48/50`) |
| `S3` | Product Inspection · `basic`, 50 units / 3 Parcels / 2 Suppliers (`$1,450.00`) | Auto-group 3 tracking numbers & 2 suppliers -> `Order Summary` shows `3 waybill(s)` & `SUPPLIERS 2` -> Demo Pay | **PASS** (`QW-6E7DAF4E7614`, `$1,450.00`) |
| `S4` | Screenshot-Only (No Auto-OCR) + 3A/3B strict separation + Manual Transcription recovery | Upload PO screenshot in 3A -> `Reference only (No Auto-OCR)`, `0 line(s)`, 3B attachment `No file chosen`, `Continue →` disabled with `#wizard-continue-block-reason`; upload Size chart in 3B -> verify 3A unchanged; `+ Transcribe Row` -> confirm -> unblocks | **EXPECTED_BLOCKED -> RECOVERED (`PASS`)** |
| `S5` | Sample Comparison · 2 Samples (`basic`, `$59.00`) + auto-init + differing-size guard | Switching Step 1 selects `compare-2` (`$59.00`), Step 3 auto-renders 2 rows without clicking init, differing sizes trigger `[data-testid="compare-condition-warning"]` + block Continue until `#step3b-size-mismatch-check` checked -> Demo Pay | **PASS** (`QW-38B1D175B491`, `$59.00`) |
| `S6` | Sample Comparison · `2 -> 3` toggle (`$79.00`) preserves edits | Edit row 0 (`Atelier Alpha Jacket`) -> Step 2 `3 samples` -> Step 3 keeps row 0 edit and renders 3 rows (`$79.00`) -> Demo Pay | **PASS** (`QW-9983EC2169EB`, `$79.00`) |
| `S7` | Golden Sample Matching · `0` active samples (`EXPECTED_BLOCKED`) | `#golden-sample-step1-gate` displays `Active sealed: 0`, `Pending vault seal: 0`, blocks `Continue →` across `1440px` and `390px` | **EXPECTED_BLOCKED (`PASS`)** |
| `S8` | Golden Sample Matching · `pending_safe_storage` only (`EXPECTED_BLOCKED` + backend `422`) | Seed sample inspected, report published, reserved (`reserve_reference`), not yet vaulted: Step 1 shows `Pending vault seal: 1` & blocks Continue; `POST /orders` returns `422` | **EXPECTED_BLOCKED (`PASS`)** |
| `S9` | Golden Sample Matching · Active vault sample (`GS-20261115-863240`) + Cross-tenant `422` + `$39.00` Checkout | Warehouse seals sample into `A-04-02-03`; cross-tenant buyer rejected (`422`); owner completes Step 1–6 & Demo Pay for 1 candidate unit (`$39.00`) | **PASS** (`QW-5714FC2C66A8`, `$39.00`) |
| `S10` | Service Switching Hygiene + Reload Draft Recovery + `Pending re-association` Guard | Upload 3A PO + 3B line/photo on `Product Inspection` -> reload restores edits -> switch to `Sample Comparison` shows Step 1 switch banner, clears 3B ref photo, enters Step 3 cleanly via `deferDraftSaveUntilStep3`, blocks Continue under `Pending re-association` until `"Confirm for Sample Comparison"` is clicked | **PASS** |

## 3. Visually Verified Screenshot Evidence Inventory (`browser_evidence/user_journey_e2e/`)

All `21` screenshots passed size (`>5KB`), zero duplicate SHA-256, and `0px` horizontal overflow checks:

| File | Route / Viewport | Service / Step | SHA-256 Prefix & Bytes |
|---|---|---|---|
| `s1-step1-select-1440.png` | `/orders/new` · `1440x900` | Product Inspection · Step 1 | `9ca06d53ac95` (`262655 B`) |
| `s1-step2-configure-1440.png` | `/orders/new` · `1440x900` | Product Inspection · Step 2 | `d047475cbdcb` (`231958 B`) |
| `s1-step3-single-sku-1440.png` | `/orders/new` · `1440x900` | Product Inspection · Step 3 | `4ddbedb396a7` (`411699 B`) |
| `s1-step3-single-sku-1280.png` | `/orders/new` · `1280x900` | Product Inspection · Step 3 | `e192840509cd` (`407434 B`) |
| `s1-step3-single-sku-768.png` | `/orders/new` · `768x1024` | Product Inspection · Step 3 | `ab39619564de` (`359094 B`) |
| `s1-step3-single-sku-390.png` | `/orders/new` · `390x844` | Product Inspection · Step 3 | `388b7b14a35e` (`297952 B`) |
| `s1-pi-3u-step5-1440.png` | `/orders/new` · `1440x900` | Product Inspection · Step 5 | `b48870bb3bba` (`276358 B`) |
| `s1-pi-3u-step6-1440.png` | `/orders/new` · `1440x900` | Product Inspection · Step 6 | `9feed0a2ea0a` (`219801 B`) |
| `s2-50u-6sku-1box-1280.png` | `/orders/new` · `1280x900` | Product Inspection · Step 3 (50u 1 Box) | `e6b0dbbb89ff` (`475517 B`) |
| `s2-parcels-48-vs-50-1440.png` | `/parcels` · `1440x900` | Warehouse Intake Discrepancy (`48/50`) | `e1ed95252555` (`124208 B`) |
| `s3-50u-3parcels-768.png` | `/orders/new` · `768x1024` | Product Inspection · Step 3 (3 Parcels / 2 Suppliers) | `5486c0ed5668` (`509859 B`) |
| `s4-screenshot-only-EXPECTED_BLOCKED-1440.png` | `/orders/new` · `1440x900` | Product Inspection · Step 3 (`EXPECTED_BLOCKED`) | `3c3face80c40` (`474403 B`) |
| `s5-compare-2samples-1440.png` | `/orders/new` · `1440x900` | Sample Comparison · Step 3 (2 Samples) | `320ed5f1532a` (`456850 B`) |
| `s6-compare-3samples-1440.png` | `/orders/new` · `1440x900` | Sample Comparison · Step 3 (3 Samples) | `5c78ae42b973` (`463598 B`) |
| `s7-golden-zero-EXPECTED_BLOCKED-1440.png` | `/orders/new` · `1440x900` | Golden Sample Matching · Step 1 (`EXPECTED_BLOCKED`) | `42197dbc5e2c` (`345430 B`) |
| `s7-golden-zero-EXPECTED_BLOCKED-390.png` | `/orders/new` · `390x844` | Golden Sample Matching · Step 1 (`EXPECTED_BLOCKED`) | `a9052c7da718` (`226805 B`) |
| `s8-golden-pending-seal-EXPECTED_BLOCKED-1440.png` | `/orders/new` · `1440x900` | Golden Sample Matching · Step 1 (`EXPECTED_BLOCKED`) | `1f98f95a0e6d` (`354111 B`) |
| `s9-golden-active-1440.png` | `/orders/new` · `1440x900` | Golden Sample Matching · Step 3 (Active Seal) | `c34da715d898` (`429063 B`) |
| `s9-golden-step5-1440.png` | `/orders/new` · `1440x900` | Golden Sample Matching · Step 5 | `6cfae2e06830` (`278740 B`) |
| `s9-golden-step6-1440.png` | `/orders/new` · `1440x900` | Golden Sample Matching · Step 6 | `7d8284eea2eb` (`220841 B`) |
| `s10-service-switch-reassoc-EXPECTED_BLOCKED-1440.png` | `/orders/new` · `1440x900` | Sample Comparison · Step 3 (`EXPECTED_BLOCKED`) | `0d30378044e9` (`529063 B`) |

## 4. Open External Dependencies (`OPEN`)

- **Automated Vision / PDF OCR Service (`OPEN`)**: No external OCR backend is wired in this environment; Step 3A strictly marks image/PDF uploads `Reference only (No Auto-OCR)` and never fabricates SKU rows or billable quantities.
- **Production Third-Party Services & Warehouse Sign-off (`OPEN`)**: Production Stripe live keys/webhooks, Postmark email credentials, Kuaidi100 webhook credentials, physical barcode scanner/printer testing, and formal commercial SLA/rate-card approvals remain separate production release gates.
