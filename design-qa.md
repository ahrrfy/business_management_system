# Design QA — Digital Offering Assignments

## Scope

- Added assigned device and assigned wallet information to the digital cards/subscriptions table.
- Added an explicit column chooser while keeping all 11 columns visible by default.
- Preserved the existing RTL table, toolbar, status, and action patterns.

## Evidence

- Source screenshot: `C:/Users/alara/AppData/Local/Temp/codex-clipboard-eb39f77a-d34d-46f4-9ae9-268232113c66.png`
- Normalized source region: `.product-design-audit/digital-offering-assignments/source-table-region.png`
- Implementation, all columns: `.product-design-audit/digital-offering-assignments/implementation-light-all-columns.png`
- Implementation, chooser open: `.product-design-audit/digital-offering-assignments/implementation-column-chooser.png`
- Combined comparison: `.product-design-audit/digital-offering-assignments/comparison-source-vs-implementation.png`

The source and implementation comparison uses a 1173 x 905 table-region pair in light mode. The implementation was verified on `/digital-cards?tab=offerings` with representative card and subscription records and two branch assignments per offering.

## Visual review

- The original table hierarchy, neutral surfaces, typography, row dividers, green status badge, and red disable action remain consistent.
- The new device and wallet cells use compact stacked branch assignments, keeping each device/wallet relationship unambiguous.
- Missing assignments have an explicit `غير مسند` state; postpaid offerings can state that settlement is deferred without implying a wallet.
- The column chooser is discoverable in the existing toolbar as `الأعمدة 11/11`, and its menu follows the same component styling.
- Horizontal overflow remains available when all columns are shown, with the table minimum width derived from the visible-column count.

## Interaction review

- Opened the column chooser successfully.
- Hid `بيانات طالب`; the header disappeared and the visible count changed to 10/11.
- Restored all columns; the visible count returned to 11/11 and the device, wallet, and student-data headers were present.
- Browser console warnings/errors: none.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: the QA fixture has three representative rows rather than the production screenshot's 28 rows; this is a data-state difference, not a layout defect.

final result: passed
