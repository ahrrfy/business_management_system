# Task 3 — Encrypted resilient drafts

## Delivered

- Added IndexedDB `studioDrafts` and `studioDraftIdentity`, whose records contain only AES-GCM envelopes; user/task identity, revision, editable text, compressed image data URL, mode, and timestamps are encrypted inside them.
- Autosave is debounced to local encrypted storage; only the same authenticated user on the same device can restore it. Drafts expire after 24 hours and are removed on submit, logout/session reset, or user change.
- Reconnect refetches the selected task and compares its `updatedAt` revision. A matching editable draft resumes once; a stale/non-editable one remains encrypted and is surfaced as a conflict.
- Offline blocks studio server mutations and provider calls while retaining local image processing and encrypted autosave.

## Verification

- RED/GREEN witnessed for missing draft module, session purge, page wiring, and offline provider gate.
- `pnpm exec vitest run --config vitest.unit.config.ts client/src/lib/productStudio/studioDrafts.test.ts` — 8 passing.
- `pnpm check` — passing.
- `pnpm check:guards` — passing.

## Scope note

- No server schema, provider API, approval, rejection, publishing, or offline replay path was added.

## Follow-up hardening

- Replaced plaintext `userId:taskId` record keys with a device-held non-extractable HMAC index.
- Persisted the once-only resume claim inside the encrypted envelope, including protection from an unchanged autosave after reload.
- Added encrypted original image and processing-receipt fields, offline discovery without a task-query cache, and an explicit conflict path for a disappeared task.
- Focused suite now covers 10 end-to-end store-state cases, including reload and full submission state.

## Lease and cold-start hardening

- Replaced the permanent resume marker with a 60-second encrypted session lease: it blocks concurrent resumes, survives a reload during the lease, then permits safe retry after expiry.
- Drafts now contain a non-sensitive encrypted task snapshot, so a cold offline editor has an effective selected task without a TanStack task cache.
- Added encrypted, device-bound studio identity metadata. The successful online login path records it; logout/session reset clears it. It is used only to find the local owner's drafts and never authorizes an online operation.
- Focused suite now covers 11 cases, including lease retry and cold offline identity + full task snapshot recovery.
