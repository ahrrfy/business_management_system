# Density waves 36–37 — product image studio

Base: `d3be9d7f6c5fad474cd6cfdb37e1bb333d980a81` (origin/main).

## Wave 36 — barcode capture and image saving

- A processing/capture generation binds asynchronous results, cache writes, fallbacks and busy state to the current product and image. Closing, changing target, replacing/discarding the image or unmounting invalidates earlier work.
- A synchronous save lock covers thumbnail preparation and the mutation. The saved payload and handled-product callback use the submitted snapshot; an old response cannot clear a newer capture. General cache invalidation still occurs for successful saves.
- The public component delegates lookup, provider availability, capture/processing, editor, product gallery and zoom dialog to bounded modules. Existing tRPC procedures, payloads, review/approval policy and image pipelines are preserved.

## Wave 37 — discovery and immediate campaigns

- Campaign previews resolve actual product IDs using the current health states, search, bundle filter and ordering. Reopening honours the initiating scope. The global no-image shortcut uses an explicit no-image scope rather than an unrelated current filter.
- The create API accepts at most 5,000 products. The preview requests 5,001 IDs to detect an oversized scope and requires narrower filtering instead of silently truncating or submitting an invalid campaign.
- A synchronous launch lock prevents duplicate clicks. A known created campaign is retained when generation or distribution fails, including closing/reopening the dialog; retry resumes that campaign. Distribution runs explicitly so errors propagate. Remaining generation is reported truthfully and can be resumed. This does not provide server-side idempotency for a lost creation response.
- Photographer deselection remains effective. Input limits match the existing API. Selection is cleared when its filter context changes, survives pagination, and an old assignment response cannot clear selection in a newer context. Direct assignment enforces the API's 100-product limit without silently dropping IDs.
- Cached discovery data is masked after read permission is lost. Failed results provide retry; pagination remains reachable on an empty final page. Long names, category buttons and campaign actions wrap; the modal scrolls within short viewports.
- Health and ordering dictionaries now come from `shared/terms.ts`. No schema, dependency, backend posting or production-data changes.

## Verification and boundaries

- Focused React regressions use deferred promises and synthetic data: stale processing/capture/save completion, duplicate submission, scope reset, filter payload, loading/oversized/revoked preview, retry after known creation, distribution errors, and selection across filter changes.
- Local type check and all guards pass. Full tests and final-head review/CI are release gates in accordance with CLAUDE.md. No paid provider requests, campaign creation or production writes were used for QA.
- Actual discovery and launcher components were rendered in an isolated browser fixture with local Cairo fonts and theme CSS. At 375×812 the page has no horizontal overflow, the 343px-wide dialog scrolls vertically and its footer is reachable. Launcher layouts were also inspected at 768×900 and 1280×900. Screenshots remain ignored local evidence in `.codex/visual/`; this is component-fixture evidence, not an audit of every production screen.

| Metric | Before | After |
| --- | ---: | ---: |
| D4 excess physical lines | 22,106 / 102 files | 21,147 / 99 files |
| D6 local dictionaries | 108 / 89 files | 106 / 88 files |
| Vocabulary violations | 0 | 0 |
| Oversized pages | 0 | 0 |

D4 falls by 959 and D6 by 2. Every extracted module is below 400 physical lines. Only the resolved discovery baseline entries are removed; unrelated historical friction remains visible.
