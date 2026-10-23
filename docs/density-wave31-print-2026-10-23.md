# Printing and export parity — wave 31

Base: `2c806257c` (`origin/main`, merged waves 27–30 / PR #1545).

## Receipt requirements and repairs

- Receipt paper is **80 mm only**, with the existing 576-dot / 203-dpi thermal transport. No 58-mm support is introduced.
- Keep product names, quantities, prices, amounts, payment details, deposits, delivery, digital credentials and actual coupon conditions. Long names wrap completely. The original table fonts and grid remain; header, duplicate promotion text, spacing and contacts consume less paper.
- Both receipt paths use one Storefront QR model: 259 dots, seven dots per module, four white quiet modules, approximately 32.407 mm. Thermal output draws the PNG at its native size without smoothing; HTML uses the matching physical size. The previous thermal image was resampled from 90 to 84 dots (approximately 10.51 mm).
- Thermal rendering measures the content before allocating its final canvas, including long names and optional sections. The thermal coupon disclosure now matches the browser receipt.

## Financial and export defects closed

- Invoice adapters and thermal/browser/A4 templates preserve original items and totals while carrying current total, returns and remaining balance. A 100,000 invoice with a 40,000 return, 10,000 paid and 5,000 courier fee requests **55,000**, not 95,000. Closed invoices retain historical fee information without collection or prepaid claims.
- Customer statements include imported opening balances in the running ledger. Customer/supplier historical closing balances follow either date boundary; live balances remain separate disclosures.
- Review follow-up: the actual POS receipt builder retains COD mode for both thermal and browser output, with ordinary credit/cash controls. End-only customer/supplier statements cap the opening seed at the requested day's end, excluding future corrections without double-counting opening movements.
- Stocktake page and printout share draft/approved state and execution wording. Unapproved NORMAL/OPENING reports do not certify posted adjustments.
- Ordinary AR/AP spreadsheet, CSV and print actions use the visible filtered scope, matching totals and filter metadata. Existing explicit selection behavior remains.
- Shared CSV serialization neutralizes formula-leading text while preserving numeric negatives, Arabic, quoting and BOM. Human report metadata/totals are opt-in, preserving import-template CSV shapes.
- USD spreadsheet columns and totals retain two decimals; existing IQD formatting remains the default. PDF save/download error handling was audited; no additional PDF transport defect was confirmed.

## Measured browser proof

Actual loaded Cairo fonts, logo, customer, cashier, shift and four contact entries; identical synthetic data before/after:

| Receipt | Thermal before / after | Browser before / after |
|---|---|---|
| One short item | 201.3 / 145.6 mm | 270.4 / 177.5 mm |
| Ten short items | 232.9 / 177.2 mm | 342.6 / 236.3 mm |

One-item reductions are approximately 28% and 34%; ten-item reductions are approximately 24% and 31%. Optional content, wrapped names and printer feed affect actual paper use.

- ZXing decoded the actual complete thermal canvas and the rendered HTML QR SVG to `https://alarabiya.online/store`.
- The HTML receipt measures 302 CSS pixels across, without horizontal overflow. A two-item long-name fixture retains the full name and decodes successfully.
- Screenshots and browser fixtures are ignored local evidence under `.codex/`. No physical print job, payment, order or confidential export was submitted.
- Focused validation: **37 files / 416 tests passed**, including all printing tests and relevant export, statement and legacy UI contracts. Type and guard gates remain mandatory before push; complete exact-head CI and Codex review precede merge.
- Review follow-up validation: **64 printing tests passed**, including six actual POS-builder cash/credit/COD cases; **13 statement integration tests passed** against a fresh, isolated local test database on port 3310, including four new positive/negative end-only correction cases. The original nine statement cases remain unchanged.
- D4/D6 counters remain **21,818 / 113** after the reductions in waves 27–30. Printing helpers are below 400 lines; no friction threshold or baseline is raised.
