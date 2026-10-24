# Barcode workflow acceptance ledger

Scope: existing cashier/reception and workflow stations. Traditional flat controls, no mandatory fulfillment workspace/tab detour. Production checks are read-only; isolated test data and document rendering never constitute physical stock, carrier or printer proof.

## Station coverage

| Station | Input/context | Required completed action | Recovery and boundary |
|---|---|---|---|
| Cashier / reception | Current sale, actual tender legs, SERVICE or approved charge, held delivery | One server transaction, real receipt allocations, one change amount | Confirmed provider attempt reused after missing reply; original tender/allocation replay; zero SERVICE cap requires review |
| Dispatch | Sequential invoice/WO/request/execution/charge scans | Canonical source dedup, current versions, explicit carrier/driver, recipient/fee preview, one confirmation | FIFO draft, stale-generation rejection, immutable pending command, actual committed CN reprint |
| Cancel assignment | Any source or its current CN | Server-permitted cancel/reassign/declare return | Physical pre-pickup evidence; actual return after departure; old carrier claims retained |
| Collection | CN or any member source | One current group/claim; actual carrier cash distinct from customer COD | No duplicate group selection; original statement/remittance idempotency; AE fees and CHG open in context |
| Invoice correction | Current invoice version/relations | Native correction with current source guards | Protected active dispatch/aftercare requires its explicit correction route; no historical replay |
| Return/cancel | Source, actual CN members, evidence | Physical receipt, commercial return and monetary refund distinguished | Actual inspected quantities, original payment rail, pending external proof; no administrative stock restoration |
| Shortage / compensation | Original sale, case, prepared execution | Independent review, real preparation, dispatch/return, controlled settlement, close | Delivered and settled quantities separate; original issue-cost recovery; all customer/carrier liabilities resolved |

## Financial and stock oracles

- Goods 50,000 + SERVICE 3,000 + held delivery 5,000 = actual receipts 58,000, goods invoice 50,000, one goods issue; service income and courier liability remain separate.
- Outsourced accrual preserves gross revenue, actual outside cost and payee liability; later payment does not expense twice.
- Guest fully paid immediate SERVICE has no fake customer, invoice or AR; deferred claim requires a real customer.
- Card proof funds actual allocations once; mixed CARD/CASH refunds retain original rails and actual provider completion.
- Original MISSING_HELD has no new sale/OUT; replacement has one OUT/quality expense; reprint consumes only actual new materials; reissue never consumes again.
- Controlled stop restores only usable proven stock at original issue cost, separates consumed/damaged quantities, and closes only resolved customer rights/carrier custody/fees.

## Verification evidence

| Gate | Evidence | State |
|---|---|---|
| Initial source typecheck | `.codex/workflow-integration-types.log`, `workflow-integration-types-2.log` | Passed intermediate source snapshots; final head pending |
| Source financial profile oracles | `.codex/workflow-posting-unit.log` | 11 passed |
| Pure navigation/cap tests | `.codex/workflow-pure-tests.log` | 13 passed initial snapshot |
| Focused actual DB integration | `.codex/workflow-focused-db*.log` | Initial failures diagnosed and corrected. Latest component/native-return rerun16/16; dispatch10/10, settlement7/7, checkout15/15, scan4/4 and work inbox2/2 on intermediate snapshots. Receiver integration and final head remain pending. |
| Physical migration baseline + repeat | `.codex/workflow-migration-proof.log` | Passed twice:4 new tables,5 columns,1 generated active key; no historical financial backfill |
| Actual local roles/layout/printing | `output/playwright/workflow-*`, `.codex/workflow-ui-*.txt` | Owner and cashier aftercare cost/action separation; actual dispatch and guest-service payment; desktop1366 and narrow390 with125% layout zoom; return controls hit-tested without horizontal page overflow. Document renderer checked separately from physical printing. |
| Final types / 46 guards / build | Final exact-head logs | Pending |
| Full financial suite / security / exact-head review | Final PR CI and review | Pending |
| Exact-main CI / managed deployment / read-only production | Release evidence | Pending |

## Interaction budget

Before baseline: user-supplied existing dispatch/checkout screenshots and pre-change source (`f67c8787`). New fulfillment capability required navigation to a separate workspace and kind tabs. This is source evidence, not a measured live-browser pass.

Target: ordinary cases remain in their familiar station; N dispatch scans, one source list and one final confirmation; no mandatory additional page transition. Advanced request preparation, classified payee/refund and controlled settlement expand only in their station/context. Preserve required financial confirmations. Record final measured clicks/route transitions and reachable controls with actual isolated browser evidence before acceptance.

Intermediate actual browser proof:1366x768 and390x844 dispatch; two consecutive invoice scans retained in order, duplicate feedback with count2, reload retained both codes and5,000 fee. All six text fields and confirmation were reachable; document hit-testing proved confirmation unobscured. Screenshots are local `output/playwright/workflow-dispatch-{desktop,narrow}.png`. One same-raw cache path originally omitted duplicate feedback; corrected and reproduced successfully in the actual UI. Final integrated-head station coverage remains pending.

Actual dispatch: two already-paid invoices, one confirmation dialog, one grouped request and one consignment number (two real source-member CN rows). Receipts3→3, invoices3→3, inventory movements7→7, available quantity16→16. Reload/reprint reused that committed identity. With the print bridge and popup blocked, the station displayed the committed/reprint message, without new financial or inventory effects. Initial QA inherited Windows automatic local bridge discovery and submitted three test tickets; subsequent QA explicitly disabled `PRINT_TARGET` and blocked printer routes. Submission is not evidence of physical paper output.

Actual Reception guest service: entered description and3,000, collected with the existing cash shift and no customer/product. Receipts3→4, invoices3→3, movements7→7 and quantity16→16. UI reset the committed intent and exposed its receipt/recovery reference. The subsequent UI correction presents a single primary charge-only payment action and the actual extra-charge collection badge. Actual follow-up at1366 and390 width with125% layout zoom hit-tested the description, amount and single payment action: all reachable, no horizontal page overflow; temporary display-only intent removed without collection.

The actual renderer exposed a missing COD caption: the generic amount-in-words heuristic incorrectly interpreted “أجرة التوصيل فقط” as a words-only row. Restricted that heuristic to an exact “فقط” caption or explicit writing/words captions, with a real dispatch-builder/HTML regression. Grouped prepaid slip shows goods100,000, paid100,000, fee5,000 and customer COD5,000 once; AE slip shows COD0 and SHOP fee.

Independent final source reviews found and closed two issues: native release paths could silently choose an inactive/out-of-branch internal driver; an invoice alias inside an existing FR could inherit authority over a different unbilled WO. Shared locked backend validation and per-actual-member authorization now cover those paths; regression cases prove zero effects on denial. Native positive fixtures explicitly select their real driver, rather than weakening the guard.

Build verification split the aftercare station into a lazy module within the same page after the route exceeded its existing500kB budget. The workflow chunk fell to413.68kB without raising the budget. Release gates below remain mandatory; this ledger records pre-release source evidence and does not replace exact-head CI.
