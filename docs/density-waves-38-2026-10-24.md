# Density waves 38–39 — recipe copies and related products

Initial base: `5083f6d515622b61bf6d4cd6d29e96650c1c6833` (origin/main).

## Wave 38 — quick production recipe editor

- Resetting a draft invalidates its in-flight template copy and replacement confirmation. Changing the output variant or closing/reopening starts a separate draft session; old success, error and completion handlers cannot alter the new session.
- Recipe creation uses the submitted `outputVariantId` for the parent callback, including a response arriving after the dialog closes. Waiting for that callback cannot close a newer draft. A synchronous submission lock prevents duplicate creation; form controls are disabled through the mutation and its callback.
- Copied quantities and costs are expressed in base units by the existing recipe contract. Their display uses the base-unit name rather than a saved non-base unit such as a dozen. Unit IDs, quantities, costs, conversion and mutation payload remain unchanged.
- The dialog delegates template selection, identity/cost fields, material rows, draft calculations and save lifecycle to bounded modules. Public exports, required batch multiple, percentage normalization, self-input exclusions, fields, API contracts and parent cache refresh remain available.

## Wave 39 — complementary-product relations

- Saving requires a successful read, preventing a failed initial query from replacing unknown existing relations with an empty list. Errors offer retry.
- A keyed product editing session removes the previous product's draft before loading another product. Dirty edits survive background data refresh. A late post-save refetch cannot overwrite a later edit, and an old product's save invalidates only its submitted product.
- Read revocation hides cached relations and prevents mutation. Read/write/search controls match their existing operation permissions. A synchronous lock prevents duplicate submission.
- The editor enforces the existing API limits of 30 relations and integer order 0–999. Search results deduplicate variants of the same product; relation-type choices use AppSelect and the shared `PRODUCT_RELATION_LABELS` dictionary. Visible labels identify type and order on small screens, and long names wrap.

## Evidence and scope

- Five real React regressions failed against the original relation editor and passed after correction. Deferred-promise recipe regressions prove reset/target/callback isolation, retained payloads and submission locking. Existing recipe arithmetic tests remain in the registered suite.
- Type checks, all guards and 42 focused cases pass. The new relation UI test is included by the full CI suite through `client/src/**/*.test.tsx`. Focused development uses an ignored unit configuration; the concurrently owned unit whitelist is unchanged.
- Read-only browser fixtures mount actual components, local Cairo fonts and the production theme/comfort styles with synthetic query data. Mutations are blocked. Layouts are checked at widths 375, 768 and 1280; the recipe retains its five-column material table in an independent horizontal scroller and keeps the footer reachable while content scrolls vertically.
- No real recipes, production inventory or recommendation links were created during QA. No backend financial, schema, dependency or permission-policy changes.
- ImportDialog was inspected as a follow-up candidate; its lifecycle and partial-batch failure paths are not fixed or claimed verified by this wave. These changes do not claim to audit every remaining screen.

| Metric | Before | After |
| --- | ---: | ---: |
| D4 excess physical lines | 21,147 / 99 files | 20,544 / 98 files |
| D6 local dictionaries | 106 / 88 files | 105 / 87 files |
| Vocabulary violations | 0 | 0 |
| Oversized pages | 0 | 0 |

D4 falls by 603 and D6 by 1. Extracted production modules remain below 400 physical lines. Only the resolved relation-label baseline entry is removed; unrelated historical friction remains visible.
