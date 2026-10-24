# Operational density — waves 32–34

Base: `f67c8787e` (`origin/main`, including merged delivery aftercare PR #1551).

## Scope and repairs

- Wave 32: customer dossier controller, overview, feedback and coupon tabs. Revoking dossier read access immediately removes cached contacts, balances and actions. Closing/reopening or changing the customer creates a separate editing session. A cancelled feedback dialog's late completion cannot close a newer draft. Gift/feedback entry actions mirror their existing submit permissions. Small-screen tabs wrap without losing their labels.
- Wave 33: employee attendance statement and its correction editor. Revoked read access removes cached wages and export/print controls. Failed queries show a retry action. Employee changes discard the previous employee's correction. Month choices use UTC consistently with the statement period, including early Baghdad hours and year boundaries. A late correction response closes only its submitted draft; cache invalidation follows the submitted employee/date. The digital price-mismatch popup scrolls within short viewports so submission remains reachable.
- Wave 34: one shared price-tier vocabulary replaces four component/page dictionaries and the legacy label implementation. Existing label exports, option ordering and unknown-value fallbacks remain available. One shared attendance-state vocabulary serves the screen, spreadsheet and A4 printout.

## Truthful records and preserved behavior

- Opening a WhatsApp composer no longer records an invitation as sent. The operator explicitly confirms sending; cancelling leaves the record untouched. A late confirmation response cannot clear a newer confirmation. No customer message was sent during verification.
- Resolving complaint status records `تمت معالجة الشكوى`, without claiming compensation or customer satisfaction that the action did not establish.
- Payroll snapshot precedence, due basis, amounts, print/Excel/share payloads, split shifts, overnight checkout, breaks and deductions retain their original contracts. Dossier metrics, timelines and coupon printing remain connected to the same APIs.
- No backend posting, permission policy, schema, dependency or production-data correction changes. The 80-mm receipt design from wave 31 is unchanged.

## Verification

- Focused component and vocabulary regressions cover revoked caches, query failures, employee/customer changes, cancelled modal completion, truthful invitation/resolution actions, current correction completion and UTC month boundaries.
- Related legacy CRM/sales contracts and digital basket/attendance calculations are included in focused validation. Type checks and all guard commands are required before push; full tests and exact-head CI/Codex completion remain release gates.
- Read-only browser fixtures mount the actual components, local Cairo fonts and production theme tokens with synthetic tRPC data. Mutations are blocked. HR correction and customer dossier were checked at 375×600; dossier also at 768×560. The mismatch popup's send button remains reachable at 375×280. No document-level horizontal overflow occurred; wide tables retain their own scroll container. Screenshots are ignored local evidence under `.codex/`.

## Measured remaining debt

| Metric                      |              Before |               After |
| --------------------------- | ------------------: | ------------------: |
| D4 excess physical lines    | 23,518 in 105 files | 22,284 in 103 files |
| D6 local dictionaries       |     113 in 94 files |     108 in 89 files |
| Vocabulary guard violations |                   0 |                   0 |
| Oversized pages             |                   0 |                   0 |

D4 falls by 1,234 excess lines; every extracted module is below 400 physical lines. Baselines only decrease. The friction report still contains unrelated historical debt; this batch does not claim to eliminate it or exercise every remaining production screen.
