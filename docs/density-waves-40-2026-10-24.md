# Density waves 40–41 — import sessions and report periods

Base: `origin/main` `14d43cf10d8b89fb98f9b632a645fca12c550c56`.

## Wave 40: shared import dialog

- Each open/entity/schema owns its draft. Closing removes the old session; no delayed reset can erase a reopened form. Late parse success, errors and finalizers cannot populate the next session.
- Keep the established skip-failed default (`true`) on every open. Clear the file input after selection so the same corrected file can be selected again.
- Lock submissions synchronously through the completion callback. Callback failure cannot return an acknowledged write to the submission form.
- Preserve acknowledged batch results and refresh callbacks when a later request loses its response. The current batch is explicitly unconfirmed; later batches are not sent and there is no automatic retry or invented rollback.
- Rolled-back classifications are not saved creations. A failed preflight has zero creations/updates; otherwise valid rows are shown as not executed. Both customer and asset response conventions are covered.
- Export completed server failure/skipped reasons, not only client preview errors. Remove the universal retry-safety promise: asset imports do not guarantee whole-file idempotency.
- Separate file selection, mapping/options/preview, outcome rendering, validation and batch execution. Keep the public props, payloads, grouping, preflight ordering, USD rate, balance polarity and validation contracts. No backend, schema or posting changes.
- Mapping uses AppSelect. The form scrolls vertically, the six-column preview scrolls horizontally, and the submit footer stays reachable. Preserve 16px side margins on tablet as well as phone.

## Wave 41: shared report period filter

- Move period/comparison vocabulary to `shared/reportPeriod.ts`; retain exported types and helpers.
- Wrap date and comparison controls on small screens, keeping each date with its label.
- Reject invalid/reversed comparison ranges and clamp leap-day year comparisons to the last actual day of February. Preset and inclusive previous-period behavior are preserved.

## Evidence

- Existing implementation failed the initial lifecycle regressions; 15 import UI cases and 8 report cases now pass. Including both existing import parser suites: **113 cases**.
- Focused development config is ignored `.codex/vitest-wave40.config.ts`; new UI suites are included in normal CI through `client/src/**/*.test.tsx`. The concurrently owned unit whitelist is unchanged.
- `pnpm check` and all 46 `pnpm check:guards` checks pass locally.
- Raw friction: D4 **20,544 / 98 files → 20,115 / 97** (−429), D6 **105 / 87 → 104 / 86** (−1). Remove only the two resolved baseline entries. Vocabulary and oversized-page ratchets remain zero.
- Actual components rendered with production CSS, semantic tokens and local Cairo fonts at 375×600, 768×600 and 1280×600. Synthetic CSV exercises long Arabic names, phone leading zeroes, USD/IQD, signed balances, mapping, rate and polarity controls. No real imports or production data writes during QA.
- At 768px: dialog x=16, width=736, page width=768; submit bottom=547 within 600px viewport; all six columns remain present. At 375px the table has independent horizontal scrolling and the submit footer remains visible.
- This slice covers the shared import flow and report-period control, not a claim of visual completion of all remaining ERP screens.
