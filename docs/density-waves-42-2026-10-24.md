# Density waves 42–43 — content drafts and contact sessions

Base: `origin/main` `ba11639257949c0af5c58d1aa7d685cf2956836e`.

## Wave 42: product-content assistant

- Product-scoped editor sessions and fact/revision snapshots prevent late generation, validation or save responses from populating another product or approving newly edited text.
- Save requests retain the submitted product/facts. Invalidate that product after acknowledged persistence; late completion does not attach an old saved-ID badge to another draft. Editing clears the badge.
- Synchronous locks prevent duplicate generation, validation and decision requests. No paid providers are called during tests or visual QA.
- Show history decision failures independently of generation and keep them visible when facts change within the same product. Two red-to-green UI regressions cover the automated review finding.
- Read existing history without triggering generation. Hide cached history when its read permission is revoked; respect the separate save and decision operations.
- Display canonical Arabic field/status labels. Enforce the tighter AI/channel field limits, including POS 120 characters, without truncating generated text. Over-limit content must be edited and revalidated before save/application.
- Preserve all six editable fields, hints, keyword/claim/warning details, confidence, cache/image badges, generation/retry, validation, saved history and approval/rejection. Keep API/DTOs and backend policy unchanged.

## Wave 43: contact 360 panel

- Key each party session by kind/id and each person-editor opening separately. A cached party switch cannot submit another party's draft. An old save refreshes its own owner without closing a newer editor.
- Recheck mount/access after a pending deactivate confirmation; synchronous locks prevent duplicate submissions. Consent completion invalidates the submitted customer.
- Resolve per-operation UI grants through the existing operation-access helper while preserving the router's additional supplier READ/FULL gate. Hide cached contact/person data when its read operation is revoked.
- Match the router's role-based redaction: show `محجوب` for masked balances/credit limits, real zeroes for elevated readers and `بلا حد` for genuinely unlimited credit. No financial-policy or backend changes.
- Preserve name, phone, role, notes and primary flag, create/update nullability, inactivity workflow, WhatsApp target/message, consent, invoices, conversations and duplicate lookup.
- Wrap long invoice/conversation rows and names. The actual browser caught a WhatsApp button repeating the full long party name and overflowing the phone drawer; its concise action label preserves target/message and removes that overflow.
- Separate summary, activity, people editor/list, consent, duplicates and access policy into bounded components.

## Verification

- 13 initial actual React regressions failed the original implementation. All **27 focused cases** pass after the fixes, including real operation-policy grants/denials, supplier gating, masked versus zero balances, late responses, duplicate clicks, field/payload parity, and edited draft validation.
- Both suites registered in `vitest.unit.config.ts` and covered by normal full CI. `pnpm check` and all 46 guards pass locally.
- Raw friction: D4 **23,704 / 104 files → 23,351 / 102** (−353); D6 **104 / 86 → 103 / 85** (−1). Only the three resolved baseline entries are removed. Vocabulary and oversized-page ratchets remain zero.
- Actual components, production CSS/tokens and local Cairo fonts: 375×600, 768×600, 1280×600. All content fields/history actions remain reachable; person form footer is reachable at 375×600. Long invoice number, large total, superseded status, conversations, phones and full names remain visible.
- Final phone drawer: viewport/page width 375, drawer client/scroll width 374/374, no overflowing visible descendants. Cashier view displays two masked financial fields. Synthetic fixtures block all contact mutations and decisions; AI responses are local mocks.
- Scope is these two shared components and their callers, not a claim that all remaining ERP screens were visually audited.
