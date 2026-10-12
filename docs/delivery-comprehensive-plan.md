# Delivery operations implementation plan

> Agent workers implement scoped tasks with independent review; preserve all original receipts, ledger entries, closure snapshots, customer balances and company balances.

Goal: complete smart search, company open-order statements, scoped receivables, full exports and direct operations with traditional clear RTL screens.

Global constraints: no data rewrite or balancing entries; no schema migration; use existing transactional financial commands. One writer per file, isolated worker worktrees. Decimal money, UnifiedSearchInput, existing DataTable/export/printing contracts. Every read and export must enforce the caller branch. Search does not authorize automatic financial matching. Preserve active filters and clearly disclose pagination. Do not create a second financial truth.

## Task 1: shared search contract (leader)
- [x] Implement `normalizeDeliverySearch`, `deliverySearchTerms`, `deliveryPhoneDigits`, `matchesDeliverySearch`, `scoreDeliverySearch` in shared/deliverySearch.ts.
- [x] Prove Iraqi local/international, Arabic/Persian digits, multiword cross-field, partial identifiers and exact match ranking with 22 pure tests and independent review.
- [x] Run unit tests, type check and guards before committing.

## Task 2: company reads and financial statements (backend worker)
Files: server/services/delivery/queries.ts, lifecycle.ts, parties.ts, server/routers/deliveryRouter.ts, scoped delivery integration tests.
- [ ] Add scopedBranchId to party consignments, remittances, statements, store transit and financials; preserve optional default for internal callers/tests.
- [ ] Consignments accepts page {limit,cursor,query,from,to,state}; state values ALL, IN_TRANSIT, DELIVERED_UNCOLLECTED, COLLECTED_UNREMITTED, RETURN_PENDING, CLOSED. SQL filters apply before limits. Include tracking reference, counterSettledAmount, shortfallAssigned and authoritative remainingDue (COD minus credited collections, counter settlement and assigned shortfall, clamped at zero). Keep existing row fields.
- [ ] Define and report all-filter totals/count separate from page values; physical and monetary classifications use existing shared contracts and ledger facts.
- [ ] Remittances retain array API for existing consumers, add optional cursor and limit+1 paging endpoint if necessary with the same permissions; include receipt link/evidence when available.
- [ ] Statement returns existing entries/currentBalance plus openingBalance, closingBalance, debitTotal, creditTotal; boundaries include carry from pre-period entries and closing as-of the end, branch scoped. No old ledger changes.
- [ ] Expose actual historical cash received separately from gross COD settled and assigned shortfall; retain old fields for compatibility. Keep inactive parties with outstanding fees visible.
- [ ] Reuse the shared search semantics in SQL predictive lookup including Arabic numeric tracking and ranking before limit; no unbounded candidate ranking after a small recent-only limit.
- [ ] Test shared company branch isolation, >200 consignments, partial/counter/shortfall remaining, period carry, duplicate retries/read preservation. Run scoped integration tests, check and guards, commit, report exact contracts.

## Task 3: company workspace and exports (UI worker)
Files: client/src/pages/DeliveryPartyDetail.tsx, new focused delivery components/helpers, relevant client tests. No hot routes or layout files.
- [ ] Replace narrow static company detail with spacious responsive workspace in existing entry point; keep settings/member/commission functions reachable.
- [ ] Clear current exposure cards link to filtered orders. Separate actual cash, outstanding settlement, shortfall and fees; historical totals secondary.
- [ ] Server search/filter/date/status, complete cursor paging, proper errors/empty/loading. Use authoritative remainingDue and existing direct collect/cancel/return/timeline actions with permission checks.
- [ ] Full filtered/selected exports XLSX/CSV and reportDoc printing with company/branch/filter/time/count/totals; fetch all pages only when requested, never present loaded subset as complete. Phone/tracking remain text.
- [ ] Remittance complete history and date filtering; opening/closing statements with full period exports. Keep search/date/navigation context during operations.
- [ ] Verify frontend contracts after backend integration, relevant interaction tests, check and guards; commit.

## Task 4: operational search and batch workflow (operations worker)
Files: client/src/pages/DeliveryHub.tsx, client/src/components/reception/ReceptionCollectSection.tsx, client/src/components/delivery/CompanyStatementScanQueue.tsx and tests, DeliverySettleTab.tsx, DeliveryManifestButton.tsx, operational helper tests if needed.
- [ ] Replace divergent raw search with UnifiedSearchInput and shared matcher across ready/in-transit/company settlement. Multiword Arabic/phone/reference search works with existing fully loaded pages.
- [ ] Make filtered batch selection use displayed results, label scope/count and preserve prior unrelated selection intentionally. Show selected count and amount before financial confirmation.
- [ ] Scanner passes raw code immediately to resolver instead of reading stale state; manual Enter obeys same contract. Test first scan, consecutive scans and duplicates.
- [ ] Unify physical vs financial Arabic labels, explicit full/partial action results, preserve draft when failures occur. Keep return/reassign/settle transaction authority unchanged.
- [ ] Ensure manifest completion/errors are disclosed and no signature-ready partial list is printed. Avoid new polling.
- [ ] Run interaction/pure tests, check and guards; commit.

## Task 5: verification and release (leader + independent reviewers)
- [ ] Task review: spec compliance and code quality for each scoped diff; resolve material findings.
- [ ] Integrate workers; run pnpm check, pnpm check:guards, focused tests, complete financial suite TZ=UTC in isolated 3310 test DB and build.
- [ ] Browser verify desktop/mobile RTL, search, clear labels, no clipped tables, filtered totals/export, partial settlement UI; no production financial test operations.
- [ ] Commit/push concise PR, exact-head green CI, final independent review. Follow authorized repository merge/deploy workflow only after all gates pass.
