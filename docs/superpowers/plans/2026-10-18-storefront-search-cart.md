# Storefront search and immediate cart implementation plan

> **For agentic workers:** Use subagent-driven-development. Implement this feature in the order below, then review the combined change before release.

**Goal:** Customers find published products using short Arabic queries, useful suggestions, controlled synonyms and clearly labelled similar results; cart additions happen immediately with a navy button.

**Architecture:** Preserve the existing public catalog and barcode/unit eligibility contracts. Share Arabic normalization and relevance between catalog queries and a bounded suggestion service. Extract the search UI into a focused component instead of growing Storefront.tsx.

**Tech Stack:** Existing React, TanStack/tRPC, Drizzle/MySQL, Vitest and browser verification; no new runtime dependencies or migrations.

## Global constraints

- Traditional, flat RTL presentation. Button background uses `--store-brand` (#1e3a8a), hover `--store-brand-strong` (#172554), white text.
- Add to the cart synchronously on click. Remove moving carts, flying images, bounce and geometry/resize animation work. A short text/check confirmation must not prevent another intended addition.
- Preserve stock limits, configurable-product selection, unit identity, cart persistence and current safe public fields. Never announce successful addition when selection or validation is still needed.
- Search short fragments (two characters for remote suggestions), words in any order, normalized Arabic/digits and a small curated domain synonym set. Preserve raw spaces while typing.
- Suggestions search the full published catalog, not the current page; obey selected category and availability and existing refinements where applicable. Avoid exposing hidden/inactive products or private prices/costs/stock quantities.
- Exact/strong matches rank before synonyms and approximate alternatives. Bounded typo tolerance only for meaningful words, never fuzzy-match barcode/model/year digits. Label similar results separately and offer an explicit correction rather than silently rewriting the query.
- Enter submits all results unless the customer explicitly selects an option with arrows. Escape closes, clear resets, touch and keyboard work. Include an explicit all-results action.
- Debounce 200-250ms; cache bounded short-lived results, deduplicate work and never show stale suggestions for a newer query. Avoid fetching a complete hydrated catalog per keystroke.
- No production orders or financial mutations in verification. Test desktop and mobile before deployment. Run `pnpm check`, `pnpm check:guards`, relevant unit/integration tests and build, then PR/CI, merge and approved deploy.

## Task 1: Complete customer search and cart feature

**Files:**
- Modify `client/src/components/storefront/AnimatedAddToCartButton.tsx` and its CSS/test, preserving callers.
- Modify `shared/storefrontSearchNormalize.ts` and tests; a focused `shared/storefrontSearch*.ts` helper is allowed.
- Modify `server/services/storefrontService.ts`, `server/routers/storefrontRouter.ts`; add a focused `server/services/storefrontSearch*.ts` service as needed.
- Add `client/src/components/storefront/StorefrontSearch*.tsx` and tests; replace the current inline search in `client/src/pages/Storefront.tsx` and remove cart flight state/rendering.
- Add focused `server/services/__tests__/storefrontSearch*.test.ts`, update `Storefront.test.ts` and `vitest.unit.config.ts` only for genuine behavior changes/new unit tests.

**Interfaces:** Keep `AnimatedAddToCartButton` props compatible unless explicit callback success is required; update all its callers atomically if so. Keep catalog `items/nextCursor/hasMore` contract and barcode owner resolution. New public `storefront.searchSuggestions` procedure returns bounded query/category suggestions, products, correction and separately labelled similar products; the client consumes it. Keep business logic in services.

- [ ] First reproduce the cart delay and replace timer-delayed `onAdd` with immediate callback. Test actual click behavior, disabled/validation cases and repeated additions with fake timers or rendered DOM. Preserve selection buttons' labels.
- [ ] Add focused search regressions: `مل` prefix, `ملزمه` normalization, `انكليزي ثالث` reversed tokens, `هايلايتر` synonym, a one-character typo in a meaningful word, Arabic/Latin year digits, unrelated query rejection, punctuation/SQL wildcard safety, exact-before-similar ranking and hidden/out-of-stock exclusion.
- [ ] Implement shared search matching/expansion and catalog integration without breaking barcode-unit identity. Fetch skinny indexed/search candidates with bounded caches and hydrate only a small suggestion set through existing eligibility paths.
- [ ] Add the public procedure and compact RTL search component. Show relevant query/category suggestions and a few products with safe price/availability. Enter searches all unless an option was explicitly selected. Show correction/similar products on a zero-match search and respect the user's scope.
- [ ] Run focused unit tests with `pnpm exec cross-env TZ=UTC vitest run --config vitest.unit.config.ts <test paths>`. Run integration tests on the isolated test DB using the normal config. Report exact commands/results in `.superpowers/sdd/feature-report.md`.

## Task 2: Verify and release

- [ ] Parent prepares an isolated local DB and checks representative real catalog content read-only when useful. Exercise search and cart on 375px and 1440px viewports; capture screenshots in `output/playwright/` and verify no horizontal overflow or clipped controls.
- [ ] Verify short queries, suggestions beyond the first catalog page, synonyms, correction/alternatives, Enter/arrows/Escape, clear, immediate cart updates and valid repeated clicks. Never submit checkout.
- [ ] Run type check, guard suite and build. Obtain an independent review, fix confirmed findings, then commit/push concise conventional commit and create/attach a concise bullet-only PR.
- [ ] Require green CI at the exact PR head, merge through normal repository protection and deploy using `pnpm prod:deploy`. Verify the deployed revision/assets and read-only phone/desktop flows. Record evidence and release coordination claims.
