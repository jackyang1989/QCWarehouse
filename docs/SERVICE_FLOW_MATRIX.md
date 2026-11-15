# QCWarehouse — Service Flow & Template Matrix

Date: 2026-11-15
Category Scope: `apparel` (sole `ACTIVE` booking category; `footwear`, `bags`, `home`, `electronics` are disabled in booking UI and backend catalog).

## 1. Published Offers & Pricing Verified Across API & Wizard UI

| Service | Template / Variant | Server Offer SKU | Server Price | Quantity Bounds | Step 1 -> Step 6 Flow & Guardrails | Verified Live Order (E2E) |
|---|---|---|---|---|---|---|
| Product Inspection | General Apparel | `apparel-inspection-1` | `$29.00 / item` | `1–100` online (`>100` manual quote) | `Standard Studio Camera Angles` fallback rendered in Step 2 & Step 4; Step 3 CSV/TSV/paste/matrix batch intake + per-parcel allocation. | Checked UI (`generalApparelShotsFallback`) |
| Product Inspection | Tops & Knitwear | `apparel-sub-tops-inspection-1` | `$35.00 / item` | `1–100` online | Pasted 6 SKUs (50 units, 2 suppliers, 3 parcels), uploaded PO image (SHA-256), auto-grouped parcels, server quote `$1,750.00`, Demo Pay, warehouse 3-parcel intake (`18 + 18 + 12 = 48/50`, `Quantity discrepancy (12/14)`). | `QW-63A714CB655E` (`$1,750.00`) |
| Product Inspection | Bottoms & Trousers / Sports Bra & Activewear | `apparel-sub-{bottoms,sports-bra}-inspection-1` | `$35.00 / item` | `1–100` online | Subcategory-specific measurement points & tolerances in Step 4. | Verified in catalog & integration tests |
| Sample Comparison | General Apparel | `apparel-compare-2`, `apparel-compare-3` | `$59.00` (2), `$79.00` (3) | Fixed `2` or `3` | Incompatible qty resets to fixed package bounds on service switch (`P0-04`). | Verified in integration suite & negative suite |
| Sample Comparison | Tops / Bottoms / Sports Bra (2 samples) | `apparel-sub-{tops,bottoms,sports_bra}-compare-2` | `$65.00 / set` | Fixed `2` | Multi-supplier side-by-side comparison. | Verified in `tests/workflow.test.mts` |
| Sample Comparison | Tops / Bottoms / Sports Bra (3 samples) | `apparel-sub-{tops,bottoms,sports_bra}-compare-3` | `$79.00 / set` | Fixed `3` | `+ Initialize 3 Comparison Sample Lines`, filled 3 distinct suppliers (`Supplier Alpha/Beta/Gamma`), Step 5 official quote `$79.00`, Demo Pay. | `QW-4EE3CBFA1F50` (`$79.00`) |
| Golden Sample Matching | General Apparel / Tops / Bottoms / Sports Bra | `apparel-reference_match-1`, `apparel-sub-{tops,bottoms,sports-bra}-reference_match-1` | `$39.00 / set` | Fixed `1` per reference match online | **0 vault samples**: Step 1 `golden-sample-step1-gate` blocks Continue/Step 2 (`P0-01`). **1+ active sealed sample (`GS-*` in `A-04-02-03`)**: Step 1 shows ready badge, Step 2 displays vault seal metadata (`selected-golden-sample-meta`), Step 3 renders comparison candidate context (`golden-sample-step3-context`), Step 5 official quote `$39.00`, Demo Pay. | `QW-8BE99869AA38` (`$39.00`, seal `GS-20261115-116026`, vault `A-04-02-03`) |

## 2. Backend Validation & Cross-Step Consistency Contracts

- **Expected Line Quantity Invariant**: `packages/core/orders.ts` (`validateLineSamples`) enforces that when `expected_lines` are provided on a line, `sum(expected_lines.quantity) === line.quantity`, rejecting mismatched payloads with `422 VALIDATION_FAILED`.
- **Unconfirmed OCR / Parsed Candidate Guard**: Candidates in `needs_confirmation` block Steps 4–6 navigation, quote estimation (shows `Outdated estimate` / `Action required` in `Order Summary`), and `/quotes` submission until confirmed or discarded in Step 3A.
- **Golden Sample Lifecycle Proven End-to-End**: `POST /orders` (`apparel-sub-tops-inspection-1`) -> `/quotes` -> `/submit` -> `/checkout/demo` -> `/me/parcels` -> `/staff/intake/check-in` -> `/staff/packages/:id/items` -> `/staff/items/:id/assign` -> `/staff/inspection-tasks/lookup` -> `/start` -> 2-pass `/results` + required `/shots` -> `/submit` -> `/report/submit` -> reviewer `/approve` (`202`) -> `workOnce()` publish -> `/me/items/:id/dispositions` (`reserve_reference`) -> `/staff/storage/move` (`seal_code: GS-*`, `A-04-02-03`) -> visible on `/items#reference-samples` -> booked via `/orders/new`.
