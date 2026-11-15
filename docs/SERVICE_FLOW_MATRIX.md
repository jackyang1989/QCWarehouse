# QCWarehouse — Service Flow, State Machine & 6-Step Matrix

Date: 2026-11-15
Category Scope: `apparel` (sole `ACTIVE` online booking category; `footwear`, `bags`, `home`, `electronics` are disabled in Step 1 and rejected by backend catalog validation).

## 1. Service Switching State Machine & Validation Contracts

| Trigger / State | Step 3A Purchase Evidence (`purchaseEvidences`) | Step 3B Product Lines (`expectedLines`) & 3B Attachment (`attachmentId`) | Step 3C Parcels (`plannedParcels`) | Step 2–5 Options & Quote (`serverQuote`) | Backend Enforcement (`../packages/core/orders.ts`) |
|---|---|---|---|---|---|
| Switch `serviceKind` or `category_id` on Step 1 (`chooseOffer`) | Uploaded files (`media_id` present) retained in 3A, stripped of prior candidates, and marked `extraction_status: "pending_reassociation"`. Unsaved pasted queues cleared. | Cleared (`expectedLines = []`, `attachmentId = undefined`, `attachmentPurpose = "reference_photo"`, `attachmentSha256 = undefined`, `itemName = ""`). `Sample Comparison` auto-initializes 2 or 3 fresh rows on entering Step 3. | Reset to `parcelMode = "single"`, `plannedParcels = []`. | `referenceId = ""`, `sizeMismatchConfirmed = false`, `toleranceMode = "record_only"`, `pointTolerances = {}`, `serverQuote = undefined`. | `validateLineSamples` rejects any payload with `extraction_status === "pending_reassociation"` (`422 VALIDATION_FAILED`). |
| Confirm retained evidence in Step 3A (`Confirm for {serviceLabel}`) | Status transitions `"pending_reassociation" -> "confirmed"` (without fabricating SKUs). | Ready to pair with manual/paste/matrix lines in 3B. | Unchanged. | Quote remains invalidated until recalculated in Step 5. | Accepted on `PATCH /orders/:id` & `/quotes`. |
| Step 2 -> Step 3 navigation with existing `draftOrder` (`goToStep(2)`) | Defers server `PATCH` (`deferDraftSaveUntilStep3`) if `pendingReassociationEvidences`, `unconfirmedEvidences`, qty mismatch, or `!currentLine` requires user action inside Step 3. | Opens Step 3 cleanly so user can resolve 3A/3B items. | Preserved for valid drafts; re-mapped before Step 4. | Still unquoted until Step 4 -> Step 5. | `POST/PATCH` & `/quotes` still reject incomplete or `pending_reassociation` payloads (`422`). |
| Step 3 -> Step 4 / Step 4 -> Step 5 / API `/orders/:id/quotes` | Blocks with inline reason + scroll if `pending_reassociation` or `needs_confirmation` remains. | Blocks if `expectedLines.length === 0`, missing Name/Color/Size/Qty, `sum(qty) !== line.quantity`, or unconfirmed `compare` size mismatch. | Validates tracking/allocation rules. | `syncDraftAndQuote()` posts fresh `revision` to `/orders/:id/quotes`; mismatch returns `422`. | Rejects `pending_reassociation`, unconfirmed candidates (`needs_confirmation`), `sum(expected_lines.qty) !== line.quantity`, non-active/cross-tenant/wrong-category `reference_item_id` (`422`). |

## 2. Six-Step Buyer Journey by Inspection Service

### A. Product Inspection (`apparel-inspection-1` `$29.00`, `apparel-sub-{tops,bottoms,sports-bra}-inspection-1` `$35.00`)
- **Step 1**: Choose `Apparel` + `Product Inspection` (`switchToServiceKind` defaults to `3` units).
- **Step 2**: Choose garment template (`General Apparel`, `Tops & Knitwear`, `Bottoms & Leggings`, `Sports Bra & Activewear`) and quantity (`1–100` online; `>100` triggers manual quote card `#step2-manual-quote-card`).
- **Step 3**:
  - **3A**: Optionally upload PO screenshot/CSV/PDF (`Reference only (No Auto-OCR)`) or paste CSV/TSV/1688 text into candidate confirmation queue (`+ Transcribe Row` / `Confirm Selected & Add to Order`).
  - **3B**: Empty state displays `0 line(s)` + `PROVISIONAL ESTIMATE` + `Continue →` blocked until >=1 confirmed row exists (for `3` identical hoodies: 1 row `Qty = 3`; for `50` mixed units: e.g. `6` SKU rows across sizes/colors or `Quick Matrix`). Independent 3B reference photo/size chart uploader never writes to 3A.
  - **3C**: Choose `Single Parcel / One Box`, `Multiple Parcels / Suppliers` (auto-grouped from line waybills/suppliers), or `Add Tracking After Payment`.
- **Step 4**: Review checklist & optional dimensional tolerances (`Record measured values` vs `Custom tolerances`).
- **Step 5**: System saves draft & fetches immutable server quote (`Official quote`), displays separated 3A Purchase Evidence & 3B Ref/Size Chart, collects consent checkboxes (`allConsentsChecked`).
- **Step 6**: Click `Confirm quote and pay $X.XX` -> Demo Checkout (`Confirm test payment`) -> `/orders/QW-*`.

### B. Sample Comparison (`apparel-compare-{2,3}` `$59.00/$79.00`, `apparel-sub-*-compare-{2,3}` `$65.00/$79.00`)
- **Step 1**: Clicking `Sample Comparison` selects the **2-sample** base SKU first (`switchToServiceKind` sorts `rules.minimum` asc, never inheriting `Product Inspection` qty=3).
- **Step 2**: Choose template & preset (`2 samples` vs `3 samples`). Toggling `2 <-> 3` preserves already-entered sample names/suppliers (`buildComparisonSampleLines`).
- **Step 3**: Auto-initializes exact `2` or `3` editable candidate rows immediately (`No manual initialize click required`). Different declared sizes trigger `[data-testid="compare-condition-warning"]` and require `#step3b-size-mismatch-check` acknowledgment before Step 4. Supports separate or shared supplier waybills in 3C.
- **Steps 4–6**: Exact package pricing (`$59.00` / `$65.00` / `$79.00`), consents, Demo Pay, order creation (`QW-*`).

### C. Golden Sample Matching (`apparel-reference_match-1` / `apparel-sub-*-reference_match-1`, `$39.00 / set`, fixed `1` candidate unit online)
- **Step 1 Gate**:
  - **`0` active sealed vault samples**: Shows `#golden-sample-step1-gate` with 4 counters (`Active sealed`, `Pending vault seal`, `Ready to reserve`, `In-flight orders`), disables `Continue →` & Step 2, provides direct CTAs to Product Inspection or `/items#reference-samples`, and preserves 3A uploads if switching.
  - **`pending_safe_storage` only**: Shows specific seal details (e.g. `S-E2E-* · Seal GS-*`), continues blocking online booking, and backend rejects direct API creation (`422`).
  - **`1+` active sealed vault sample (`active`)**: Badge turns green (`1 active vault sample ready`), Step 2 auto-selects when `1` non-busy active sample exists (or `#step2-reference-select` lists seal/location/expiry).
- **Step 3–6**: Shows `[data-testid="golden-sample-step3-context"]` reminder (`Declare only the 1 incoming candidate unit`), user adds 1 confirmed line (`Qty = 1`), `$39.00` official quote in Step 5, Demo Pay in Step 6. *(Note: multi-unit candidate restock pricing under `reference_match` offers stays fixed to `minimum: 1, maximum: 1` per current catalog pricing rule without modifying server SKUs).*

## 3. Verified Live Orders in Isolated E2E Database (`qcw_test_user_journey_e2e`)

| Scenario | Service / Template | Server Offer SKU | Verified Total / Outcome | Order / Seal Reference |
|---|---|---|---|---|
| `S1` | Product Inspection (`tops`, 3u, 1 SKU) | `apparel-sub-tops-inspection-1` | `$105.00` (`PASS`) | `QW-85DCCB501DFF` |
| `S2` | Product Inspection (`basic`, 50u, 6 SKUs, 1 Box + `48/50` discrepancy) | `apparel-inspection-1` | `$1,450.00` (`PASS`, `48/50` on `/parcels`) | `QW-99E01DD69B28` |
| `S3` | Product Inspection (`basic`, 50u, 3 Parcels, 2 Suppliers) | `apparel-inspection-1` | `$1,450.00` (`PASS`) | `QW-6E7DAF4E7614` |
| `S5` | Sample Comparison (`basic`, 2 samples, size mismatch ack) | `apparel-compare-2` | `$59.00` (`PASS`) | `QW-38B1D175B491` |
| `S6` | Sample Comparison (`basic`, 2->3 toggle preserves edit, 3 samples) | `apparel-compare-3` | `$79.00` (`PASS`) | `QW-9983EC2169EB` |
| `S9` | Golden Sample Matching (`tops`, active `GS-*` vault seal, cross-tenant 422 verified) | `apparel-sub-tops-reference_match-1` | `$39.00` (`PASS`) | `QW-5714FC2C66A8` / `GS-20261115-863240` |
