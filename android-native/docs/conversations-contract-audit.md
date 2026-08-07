# Native conversations contract audit

This slice is a native Jetpack Compose implementation. It does not use a WebView, TWA, embedded browser, or invented endpoint.

## Consumed contracts

| Native operation | Server procedure | Required server access |
| --- | --- | --- |
| Conversation page | `conversations.list` | `channels:READ`, branch scoped |
| Message thread | `conversations.messages` | `channels:READ`, branch scoped |
| Mark read | `conversations.markRead` | `channels:FULL`, branch scoped |
| WhatsApp free-form send | `conversations.sendMessage` | `channels:FULL`, active WhatsApp integration, open 24-hour window |
| Approved templates | `integrations.templates.list` | manager/admin |
| WhatsApp template send | `conversations.sendTemplate` | `channels:FULL`, approved Meta template |
| Retry failed outbox row | `conversations.retrySend` | `channels:FULL`, failed row in the same branch |

The selected list row is the conversation header and `conversations.messages` is its thread. There is no `conversations.get` detail procedure.

`contacts.search`/`contacts.contact360` are protected by CRM read permissions and are not needed for this read/send slice: `conversations.list` already returns the linked customer name and the channel handle. Creating/linking a conversation is intentionally not simulated through contacts because it is a separate write workflow and was not part of this slice.

## Fail-closed client behavior

- Non-WhatsApp channels are read-only because the server has no real outbound transport contract for them.
- Free text is sent through the API only when the list row reports `apiActive=true` and `windowExpiresAt` is still open.
- A non-queued result from the WhatsApp API path is treated as failure and is never shown as a successful send.
- Template discovery is shown only to manager/admin accounts because that is the real permission on `integrations.templates.list`.
- External WhatsApp is an explicit handoff: the user reviews a confirmation dialog, then the app targets only the installed official WhatsApp or WhatsApp Business package. There is no generic browser fallback and the UI never claims the text was sent.
- Phone numbers are normalized to E.164 digits; invalid characters/extensions are rejected. Draft text removes control and bidi-override characters and is length bounded before either API or external handoff.

## Integration gaps outside this isolated slice

1. An admin with all-branch scope must receive the currently selected branch from the central application shell before loading conversations; the server intentionally rejects an unscoped admin list.
2. `conversations.sendMessage` currently falls back to a manual log if the integration disappears between list loading and mutation. The client rejects the non-queued response, but an atomic server-side `requireTransport=true` option is still needed to prevent the manual row itself.
3. A read-only channels user can read messages but cannot mark them read because `markRead` is under `channels:FULL`.
4. External WhatsApp cannot produce a trusted sent/delivered receipt. Only Cloud API/outbox messages expose delivery state.
5. Conversation bodies, phone numbers, and previews must not be copied into push notification payloads. Push should carry only opaque entity/deep-link identifiers and fetch protected content after authenticated app open.
6. The central native route still needs to instantiate `ConversationsRepository`, `ConversationCapabilities.fromBootstrap`, and `ConversationsViewModelFactory`; this slice deliberately does not edit shared root/navigation files.
