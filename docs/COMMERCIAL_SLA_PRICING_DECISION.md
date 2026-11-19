# Commercial Pricing, Work Depth & SLA Decision Matrix (Advisory Analysis)

> **Status & Governance Boundary:** This document is an **advisory commercial, industrial engineering (IE), and SLA decision model** requested for pre-commercial launch review. **No production catalog SKU prices, offers, or payment calculation logic have been modified** in code or database records. Production catalog pricing updates require explicit business sign-off via admin SKU price versioning. All warehouse stopwatch minutes labeled **[Assumed / Pending Floor Validation]** are engineering estimates and must be calibrated with live floor time studies before locking SLA guarantees.

Related specifications and evidence:
- [Service Flow & Acceptance Matrix](SERVICE_FLOW_MATRIX.md)
- [End-to-End Acceptance Report](E2E_ACCEPTANCE.md)
- [P0/P1 Rectification Issue Matrix](P0-P1_ISSUE_MATRIX.md)
- [Production Contract Schema](contracts/schema.sql)

---

## 1. Service Positioning & Inspection Work Depth Separation

Treating a **1–3 unit pre-production supplier sample** identically to a **10–100 unit small-batch restock order** causes severe warehouse capacity misallocation and distorted pricing. The two operational workflows must be governed as distinct inspection depths:

| Dimension | Tier A · Detailed Sample Inspection (Pre-Production / Sourcing Sample) | Tier B · Small-Batch Inspection & Sorting (Production / Restock Lot) | Tier C · Sample Comparison / Golden Sample Matching |
|---|---|---|---|
| **Typical Order Size** | `1–3` units | `10–100` units (`4–9` transitional band) | `2–3` supplier samples (Comparison) or `1–10+` candidate units vs `1` vault reference (Golden Match) |
| **Buyer Intent** | Deep vendor qualification, tech-pack verification, fit/spec audit | Defect removal before international forwarding/3PL, SKU/size count sorting | Side-by-side supplier selection or batch drift control against sealed reference |
| **Visual & Workmanship Check** | **100%** piece-by-piece detailed check (all seams, stitching density, labels, trims) | **100%** piece-by-piece defect & label/size/color verification + good/defect separation | **100%** comparative attribute & defect evaluation across paired items |
| **Point Measurement Depth** | **100%** full metric tape measurement across all template measurement points | **Recommended Default:** `max(3, ceil(20%))` stratified sampled measurement across SKUs + **optional 100% full measurement add-on** | Per-sample measurement; **cross-size dimensional grading prohibited** when declared sizes differ |
| **Studio Photography** | **100%** full studio angle set (`5–6` angles/unit) + defect macro close-ups | Batch overview + representative SKU angle set + **100% defect macro photos for every flagged unit** | Side-by-side synchronous studio comparison shots + defect/drift close-ups |
| **Deliverable Output** | Unit-level comprehensive audit report | Lot pass/fail tally + defective unit code list + sorting/disposal instructions | Structured side-by-side comparison / drift delta matrix |

---

## 2. Warehouse Step-by-Step Industrial Engineering (IE) Time Model

> **Calibration Notice:** All durations below are **[Assumed / Pending Floor Stopwatch Timing]** estimates for softlines apparel (tops, leggings, sports bras) assuming a 1-person QC bench + overhead camera rig.

| Step # | Warehouse Operation | Granularity | Apparel Est. (Min / Target / Max) | Notes / Variance Drivers |
|---|---|---|---|---|
| **1** | Inbound parcel scan, carrier/label check & outer box photo | Per parcel | `1.0 / 1.8 / 3.5 min` | Damaged cartons (`crushed`/`torn`/`wet`) add macro documentation |
| **2** | Unboxing, inner polybag count & parcel receipt logging | Per parcel + unit | `2.0 + 0.3/u` min target | Mixed-SKU boxes with poor seller markings add sorting overhead |
| **3** | SKU / Color / Size verification & unique barcode tag application (`S-*`) | Per unit | `0.8 / 1.3 / 2.2 min` | Hangtag / care-label ambiguity or `Contents unknown` boxes increase scan time |
| **4** | Garment flat-lay setup & steaming/smoothing prep | Per unit | `0.6 / 1.0 / 1.8 min` | Knitwear/hoodies slower than basic tees; heavy wrinkles delay flat-lay |
| **5** | Flat metric tape measurements (`5–7` template points) | Per measured unit | `2.5 / 3.8 / 6.0 min` | Skipped/sampled on non-measured Tier B units unless add-on purchased |
| **6** | Standard multi-angle studio camera capture (`5–6` shots) | Per studio unit | `1.8 / 2.6 / 4.0 min` | On Tier B lots, studio shots on 1/SKU + defect units saves ~60% bench time |
| **7** | Defect inspection, hangtag/care-label check & defect macro photography | Per unit + per defect | `1.0/u + 1.5/defect` | Defect rate (`5%` vs `30%`) strongly drives rework and macro annotation time |
| **8** | Supervisory QA review & tolerance calculation audit | Per order / SKU lot | `4.0 / 6.5 / 12.0 min` | Multi-SKU tolerance checks require per-size spec lookup |
| **9** | Bilingual/structured report compilation & PDF rendering check | Per order | `3.0 / 5.0 / 9.0 min` | Large `50–100` unit lot summaries add SKU summary verification time |
| **10** | Pass / Defect segregation, individual re-bagging & storage put-away | Per unit | `0.7 / 1.1 / 2.0 min` | Individual polybagging + SKU labeling adds cost if seller shipped loose |
| **11** | Outbound staging (Return-to-seller / Forwarder consolidation / Hold) | Per parcel / batch | `4.0 / 6.0 / 10.0 min` | Multi-seller combined returns require supplier segregation check |

### Aggregated Hands-On Minutes Formula (Target Estimates — Assumed)

- **Tier A (`100%` Full Sample Depth):** `~14.0 min` fixed order/parcel overhead + `~11.1 min/unit` (`+1.5 min` per defect unit).
- **Tier B (`100%` Visual/Sort + `20%` Sampled Measurement & Representative Studio):** `~16.0 min` order overhead + `~5.2 min/unit` base + `~5.4 min/sampled unit` (`+1.5 min` per defect unit).

---

## 3. Unit Cost, Gross Margin & Defect-Rate Stress Test (`1` to `100` Units)

> **Assumed Direct Cost Baseline (Pending Accounting Audit):**
> - Fully loaded QC operator cost (Guangdong/Foshan facility, wage + benefits + floor supervision): **$14.00 / productive hour** (`$0.233 / min`) [Assumed]
> - Consumables (thermal barcode labels, tamper seals, polybags, amortization of camera/lighting rig): **$0.45 / unit + $1.20 / parcel** [Assumed]
> - Payment processing (Stripe international card blended fee): **3.4% + $0.30** [Standard Assumption]
> - Current production catalog baseline (for Tops product inspection): **$29.00 / item** (`$35.00` Bottoms, `$39.00` Sports Bras; `$59 / $79` Sample Comparison sets).

### Table 3A · Stress Test Under Current Flat Unit Price (`$29.00 / unit`, `15%` Medium Defect Rate)

| Commissioned Units | Depth Model | Total Bench Time Target | Direct Labor + Consumables + Stripe Cost | Current Revenue (`$29/u`) | Gross Profit ($) | Gross Margin (%) | Commercial Assessment |
|---:|---|---:|---:|---:|---:|---:|---|
| **1 unit** | Full Detailed (100% measure + 5 shots) | `25.3 min` | `$7.55 + $1.65 + $1.29 = $10.49` | `$29.00` | `$18.51` | **63.8%** | Viable, though `1u` with complex parcel follow-up leaves thin cushion against overhead/support |
| **3 units** | Full Detailed (`3` measured) | `47.8 min` | `$13.11` total (`$11.14` labor) | `$87.00` | `$73.89` | **84.9%** | Healthy unit economics for sample inspection |
| **10 units** | Small-Batch (100% sort + `3` measured) | `84.5 min` | `$25.72` | `$290.00` | `$264.28` | **91.1%** | `$290` feels expensive to SMB buyers for 10 units -> low conversion risk |
| **30 units** | Small-Batch (100% sort + `6` measured) | `211.2 min` | `$64.59` | `$870.00` | `$805.41` | **92.6%** | `$870` triggers buyer resistance vs domestic China QC agents (`$150–$280` flat lot rates) |
| **50 units** | Small-Batch (100% sort + `10` measured) | `341.3 min` | `$104.35` | `$1,450.00` | `$1,345.65` | **92.8%** | **High price barrier:** `$1,450` vs ~$104 direct cost overprices standard batch sorting by >5x |
| **100 units** | Small-Batch (100% sort + `20` measured) | `666.5 min` | `$202.98` | `$2,900.00` | `$2,697.02` | **93.0%** | Uncompetitive without tiered pricing; buyers drop out at Step 2/5 |

### Table 3B · Defect Rate Sensitivity on `50` Units (`5%` Low vs `15%` Med vs `30%` High Defect Rate)

| Defect Scenario | Extra Re-Inspection, Macro Photo & Handling Time | Total Direct Cost (`50u`) | Tier B (`100%` Sort + `20%` Measure) Cost / Unit | Tier A (`100%` Full Measure + Photo on All 50u) Cost / Unit |
|---|---:|---:|---:|---:|
| **5% Low Defects (`3` bad)** | `+4.5 min` | `$101.00` | `$2.02 / unit` | `$3.25 / unit` |
| **15% Medium Defects (`8` bad)** | `+12.0 min` | `$104.35` | `$2.09 / unit` | `$3.33 / unit` |
| **30% High Defects (`15` bad) + Hold** | `+22.5 min` + ticket coordination | `$109.10` (+ support time) | `$2.18 / unit` | `$3.48 / unit` |

### Table 3C · Recommended Pricing Structure Options (Proposal Only — No Production Change Made)

| Option | Structure | Example Pricing Schedule (Tops / Apparel Baseline) | Resulting Buyer Total (`1u / 3u / 10u / 30u / 50u / 100u`) | Est. Gross Margin @ 15% Defect | Fit & Commercial Trade-off |
|---|---|---|---|---:|---|
| **Option 1 (Status Quo)** | Flat per-item (`$29/u`) | `$29 × N` | `$29 / $87 / $290 / $870 / $1,450 / $2,900` | `64%–93%` | Good for `1–3u`; severely uncompetitive above `10u` |
| **Option 2 (Tiered Unit)** | Volume-tiered unit rate | `1–3u: $29/u` · `4–15u: $14/u` · `16–50u: $7/u` · `51–100u: $4.50/u` | `$29 / $87 / $140 / $210 / $350 / $450` | `60%–75%` | Simple mental model; risk of cliff gaming at `3u -> 4u` |
| **Option 3 (Recommended · Base + Unit + Depth Add-on)** | Order Base Fee + Per-Unit Processing + Optional 100% Full Measurement Add-on | **`$39` base order minimum** + **`$4.00/u` (`100%` visual/sort + `20%` measure)**; or **`+$3.00/u`** for `100%` full measurements & 5 studio shots/unit | Base Tier B: `$43 (1u) / $51 (3u) / $79 (10u) / $159 (30u) / $239 (50u) / $439 (100u)` | **`74%–78%`** | Covers minimum overhead on `1u`, scales smoothly for `10–100u`, directly reflects physical bench labor, aligns with competitive cross-border QC rates |

---

## 4. SLA Turnaround Matrix & Mandatory Clock Start Prerequisites

**SLA Clock Start Rule (`samples_ready_at`):** Service turnaround **never** begins at customer order payment or carrier parcel signature. The SLA timer starts **only when all 4 prerequisites are satisfied simultaneously**:
1. **Physical Receipt Complete:** All commissioned parcels and physical units are delivered and scanned into warehouse intake (`packages.received_at` populated for all expected parcels).
2. **Ownership & SKU/Quantity Reconciliation Clear:** Zero unresolved unverified ownership claims (`identity_state !== 'pending'`), zero unresolved quantity/condition discrepancy blocks (`48/50` shortages acknowledged or adjusted by customer), and every unit assigned to an `expected_item_id`.
3. **Inspection Scope Locked:** Order draft submitted, category/template version and optional measurement tolerances finalized (no open scope revision).
4. **Payment Confirmed on Server:** Authoritative Stripe webhook or verified payment confirmation recorded (`paid_at IS NOT NULL`).

| Quantity Band | Recommended Service Depth | Target Business-Day SLA (After `samples_ready_at`) | Operational Buffer & Caveat |
|---|---|---|---|
| **1–3 units** | Detailed Sample Inspection / Comparison / Single Golden Match | **1–2 business days** (`2` bd current default) | Complex multi-supplier comparisons (`3` parcels staggered) wait until final parcel checks in |
| **4–15 units** | Transition / Multi-SKU Sample Lot | **2 business days** | Add `+1 bd` if `>5` distinct SKUs with custom point-specific tolerances |
| **16–50 units** | Small-Batch Inspection & Sorting (`20%` measure / `100%` visual) | **3 business days** | Add `+1 bd` if **100% Full Measurement** add-on selected or defect rate `>25%` triggers re-check |
| **51–100 units** | Full Small-Batch Lot (`51–100` ceiling for online self-serve) | **4–5 business days** | Requires receiving bench slot reservation; above `100` units routed to **Manual Quote (`>100` up to `300`)** |

---

## 5. Post-Inspection Storage, Return-to-Seller & Consolidation Economics

| Post-Inspection Service | Recommended Policy / Cost Benchmark [Advisory] | Direct Cost Driver | Comparison vs Bulk Consolidation Forwarding |
|---|---|---|---|
| **Free Storage Window** | **`15` calendar days** post-report publication (or cancel date) | Pallet/bin slot occupancy (`$0.12–$0.20 / day / standard garment bin`) | Matches current production contract baseline (`storage_until = +15d`) |
| **Paid Storage Extension** | **Base `$12` handling + `$0.35 / item / week` (or `$0.08 / item / day`)** | Shelf occupancy + stocktake scan overhead + Stripe transaction fee | Encourages prompt customer disposition within `15` days instead of long-term deadstock |
| **Return to Seller** | **`$3.50` per return parcel handling** (or `$1.00 / extra supplier combined`) + **actual domestic freight + 10% admin buffer** | Repacking, seller address validation, combined-return sorting, courier pickup | Cheaper per defect batch when combining defective units back to the same seller (`return_to_seller` multi-item grouping) |
| **Forwarder / Domestic Dispatch (Consolidation vs Split)** | **Consolidated batch: `$5.00` base consolidation + `$0.50 / extra SKU/item` + carton material (`$1.50`) + actual courier freight** | Merging good units across `2–3` supplier parcels into 1 export carton cuts domestic freight cost by **35%–55%** vs shipping separate boxes | **Split-parcel penalty avoidance:** Shipping good units together in 1 master box vs 3 separate parcels saves ~$4–$9 domestic courier base weight charges |
| **Vault Golden Sample Retention** | **`90` days tamper-evident (`GS-*`) archive:** Proposed `$15 / sample / 90 days` or included when bundled with repeat matching order | Locked cabinet (`reference` zone), physical seal serialization, periodic audit | Guarantees sealed continuity for subsequent restock comparison batches |
