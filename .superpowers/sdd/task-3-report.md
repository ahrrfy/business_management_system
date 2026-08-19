# Task 3 — Encrypted resilient drafts

## Delivered

- Added IndexedDB v4 `studioDrafts`, whose records contain only an AES-GCM envelope; user/task identity, revision, editable text, compressed image data URL, mode, and timestamps are encrypted inside it.
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
