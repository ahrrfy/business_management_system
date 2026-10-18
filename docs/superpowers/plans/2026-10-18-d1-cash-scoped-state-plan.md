# D1 scoped cash state Implementation Plan

> **For agentic workers:** Execute inline with verification checkpoints; use one read-only financial reviewer. Preserve the approved isolated scope.

**Goal:** Remove the history-size staging limit without weakening cash-sale atomicity, replay or recovery.

**Architecture:** Explicit scoped SQL projection and authoritative sequence seeds feed the existing SQLite staging service. Native D1 still commits the original financial plan atomically. Diagnostic/recovery keyset pages bound large verification exports.

**Tech Stack:** Existing TypeScript, SQL.js, Drizzle original services, native workerd/Miniflare, D1 and SQLite Durable Objects; no new dependency.

## Global Constraints

- Only the isolated cash experiment and its report/spec/scratch files are writable.
- Retain all existing Cloudflare history; no stock reset or paid-plan change.
- All money remains Decimal/text; SQL arithmetic is confined to integer IDs/stock metadata.
- Preserve signed PREPARED/ACK, CAS, preimages, original keys, single writer and failure-closed SQL allowlist.
- Run large trials locally and a small authenticated cloud smoke only after local verification.

## Task 1: Scoped staging

- [x] Add native regression with more than1,000 unrelated catalog rows; verify current `SNAPSHOT_LAB_LIMIT` failure.
- [x] Add `cash-state.ts` to generate explicit policy SQL and read boundaries; change `snapshotDatabase(binding,input,actor)` to bind the scoped envelope, seed authoritative sequences, and return row/byte metrics.
- [x] Make `prepareCashSale` use that scoped signature; keep original service calls. Enforce the date boundary before normal commit; exempt only verified restore.
- [x] Verify sparse/deleted sequence high-water, cross-branch original replay collision, unit/tier rejection, reservations/direct/bundle holds, closed date/period and unsupported automatic coupon effects.

## Task 2: Bounded export and comparison

- [x] Add keyset journal and snapshot page functions/routes with pinned epochs, safe schema-derived keys, count/byte limits and strict continuity.
- [x] Add a client that saves signed records durably and compares complete paged state; test cursor tampering, changed epochs, gaps and interrupted/resumed restore.

## Task 3: Load, recovery and final verification

- [x] Run5,000 original cash commands across concurrency1/4/8, record measurements before later assertions, and assert bounded projected state regardless of history size.
- [x] Preserve exact financial money/links/IDs/stock, exact-key replay and changed-payload rejection; destroy source and restore from fsynced signed records only.
- [x] Run existing focused native/unit/type/parity checks and the original ERP suite on a fresh guarded local MySQL child.
- [x] Authenticate and verify existing cloud lab identities; deploy lab only and use at most one new sale from retained stock. Reconcile its saved key and restore it, never regenerate uncertain commands.
- [x] Review exact diff/evidence, write factual results/limits, pass normal commit gates, commit/push session branch only, stop owned MySQL child and release claims.
