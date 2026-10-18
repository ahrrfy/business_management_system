# D1 actual credit sale and collection Implementation Plan

> **For agentic workers:** Execute inline with verification checkpoints. Reuse one read-only verifier under CLAUDE§7. Do not modify production, original financial services or prior proof records.

**Goal:** Run original stocked credit POS sale and subsequent CASH collection with complete customer AR and accounting effects, independent recovery and stable replay.

**Architecture:** Configurable existing staging/plan primitives, separate credit schema and scoped dependency closure, original service calls, one global FIFO writer, native D1 atomic batch plus independent signed ACK, source-free restore.

**Tech Stack:** Existing TypeScript/Drizzle/Decimal/SQL.js, Workers/D1/SQLite DO and Miniflare; no new dependency or subscription.

## Constraints

- Add experiment files only; retain cash defaults and every existing cloud/legacy row.
- No Hostinger/production/DNS/main changes. No upgrades or new cloud databases.
- All money arithmetic is Decimal/text, including original SQL customer AR increments.
- Original credit limits, contract pricing, auto-settlement and collection guards run; reject unsupported histories explicitly.
- Sale and collection use identical durable command/journal/epoch ownership. No successful reply without signed ACK.

## 1. Core and dependency closure

- [x] Verify a native credit lifecycle fails on the current cash-only worker.
- [x] Parameterize projection/staging/plan application with unchanged cash defaults; add credit schema, fixture, strict inputs and exact original SQL allowlist.
- [x] Bind original collection transaction, defer hooks, preserve Decimal customer increments and full open-invoice FIFO scope; reject delivery and bypass flags.
- [x] Validate original invoice, stock, customer AR, receipt and ledger effects, prior credit/FIFO and replay after later collection.

## 2. Recovery and UI

- [x] Reuse journal with separate credit identity and shared writer; add authenticated credit UI/status/evidence routes.
- [x] Test faults/restart/CAS, duplicate/changed requests, credit-headroom concurrency, interrupted export and independent full-state restore.
- [x] Validate MySQL parity; run focused cash regression and type/guard checks.
- [x] Complete original full ERP suite in fresh isolated owned databases:1244 files,13703 passed,41 skipped,zero failed shards.

## 3. Additive cloud proof and closure

- [x] Preflight exact three reused database identities/disjoint schemas; save existing legacy rows/hash. Add credit tables only, deploy isolated workers, run a small saved-key sale/partial/final collection and restore.
- [x] Prove all old rows unchanged, exact new-state recovery, no unexpected network, existing plan/resources unchanged; report actual cost boundaries.
- [x] Read-only final review (PASS); resolve all three bounded recovery/dependency/budget findings with native tests.
- [x] Normal commit gates and independent review passed; owned MySQL13323 stopped and connection refusal verified.

Closure procedure: commit/push the session branch only, inspect exact-head CI without claiming green CI when absent, release both owned claims, and report the verified remote head in the hand-off. Production/main remain outside scope.
