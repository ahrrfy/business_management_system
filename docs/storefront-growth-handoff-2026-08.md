# Storefront growth handoff — 2026-08

## Production baseline

- PR #732 was merged as `9ccdab619e8d93727131d37dc11185c03c206ae1`.
- The first deployment attempt used `/home/deploy/erp` before the checkout was confirmed and served an older build.
- The corrected deployment pulled `origin/main` from `/home/deploy/erp`, ran `pnpm prod:deploy`, applied the deployment migration path, reloaded PM2, and completed in 168.1 seconds.
- The deployment output reported `erp-server` and `erp-hr-bridge` online, storefront readiness OK for `srv1548487.hstgr.cloud` and `alarabiya.online`, and healthz returned `{"ok":true}`.
- A live asset check after deployment found `animate__heartBeat`, `animate__tada`, `storefront-action-ring`, `store-cart-flight`, and `store-action-button` in the served CSS/JS.

## Shipped in PR #732

- Related products for product details, price filtering, anonymous recommendation-click aggregates, analytics dashboard support, and animate.css micro-interactions for wishlist, sharing, and cart add feedback.
- Motion remains short, non-infinite, and disabled for `prefers-reduced-motion`.

## Follow-up PR

- Branch: `feature/storefront-share-consent-cart`.
- Commit: `fe256ac66a760701178050ea0b10c3b2d3d8772f`.
- PR: https://github.com/ahrrfy/business_management_system/pull/739
- Changes: explicit storefront consent banner/preferences, analytics gating for product/cart/checkout conversion events, server-backed seven-day cart-share tokens storing product/unit IDs and quantities only, live-product rehydration with current pricing, and direct add-to-cart for a single simple available catalog unit while retaining detail selection for variants/customization.
- Migration: `0261_storefront_cart_shares`, registered at journal index 261.
- Local validation: 23 targeted tests passed; Storefront esbuild passed; server esbuild passed; schema/journal validation passed; `git diff --check` passed. Full local TypeScript hook was terminated by sandbox resource limits, so CI remains authoritative.
- CI status at handoff: GitGuardian, Security Audit, and authz-guard passed; the two main test shards were still `in_progress`/pending on run `32670328655`. Do not merge PR #739 until both shards finish successfully and PR status is CLEAN.

## Known privacy boundaries

- Necessary local storage covers cart, wishlist, and consent preference only.
- Analytics and marketing are off by default and are not enabled by a missing or malformed consent record.
- Cart-share tokens do not store customer name, phone, address, payment, final price, IP, or session identity. Shared cart items are re-read from the live catalog and must pass the existing quote and checkout validation.
- Shared customizations are not encoded into the token; a recipient must choose customization again when required.

## Release rule

After PR #739 is green and merged, deploy only from the verified production checkout using the documented `pnpm prod:deploy` path. Then verify PM2, `pm2-deploy.service`, `/healthz`, `pnpm db:verify`, and the customer flows for consent, cart sharing, wishlist add, quote repricing, and checkout.
