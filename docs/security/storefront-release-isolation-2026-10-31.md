# Storefront frontend release isolation — 2026-10-31

## Contract

`node scripts/build-web.mjs` builds complete independent outputs: ERP `dist/public` and public `dist/storefront`. The public entry reuses `StorefrontBootstrap` public routes, never imports `App`, `AppLayout`, `CommandPalette`, product studio, or financial realtime startup. `/login` and `/account` keep their existing same-origin ERP entry. Other host redirects, public/mobile/legal/application routes and API paths retain the existing policy. Internal navigation from the public shell to a shared auth route opens the server-selected ERP document.

Each output contains `release.json`: `{ schema: 1, kind, fingerprint, files: [{ file, sha256 }] }`. The fingerprint is SHA256 over JSON of sorted relative filenames and content hashes, excluding only root `release.json`. It contains no git revision or build timestamp. `readWebRelease(root, kind)` checks every byte, symlink rejection and required complete shell files. Storefront CSS scans its actual esbuild runtime source closure; ERP-only utility classes cannot change its CSS. Storefront Sentry error capture still uses its public DSN; per-commit release injection and source map uploads remain on the ERP build to keep storefront bytes independent of an administrative release identifier.

The existing ERP `web-current` remains independent of `.runtime/storefront-current`. The deployment integration prepares `.runtime/storefront-releases/<fingerprint>` before activation, changes the public pointer only when content differs, and retains current plus two previous complete public versions. Existing ERP snapshots remain retained under `.runtime/web-releases/<id>/{candidate,previous}/public`. The static resolver can retrieve bounded retained hashes, including legacy unified ERP hashes after first migration. Unknown hashes return terminal uncached 404 responses, never SPA HTML. Missing first-migration public pointer falls back to the complete legacy ERP build until the public candidate is ready.

## Update safety

The deployed service worker URL `/sw.js`, scope `/`, manifest URL and origin-scoped install identity `/store` stay stable. Build outputs generate separate origin manifests and namespace precache/runtime caches. New registrations do not overlap the existing registration. No code unregisters workers or clears all CacheStorage/localStorage. Push handler, cart, checkout fields and durable request keys are preserved.

API prices and orders remain network-only; only the existing explicitly public image routes may use image caching. The public precache contains public pages and their dependencies, with no ERP shell/pages. `skipWaiting` and `clientsClaim` stay false until the existing save/activation flow verifies readiness. A durable unresolved checkout key blocks activation and reload, including after a committed request loses its reply. The waiting worker also asks all open storefront tabs to confirm safety. An unanswered legacy tab vetoes activation; it must be reopened or closed before activation can proceed. A safe tab cannot force activation over another tab's unresolved order. Existing idempotent checkout recovery remains unchanged.

## Verification and limits

Focused unit gate: public route/source isolation, existing bootstrap runtime CSS coverage, lifecycle, and production static routing: 4 files / 39 tests. Existing PWA delivery/draft persistence tests: 1 file / 19 tests. Node contract tests verify complete content manifests, deterministic hash changes, cross-tab acceptance/veto, anonymous activation and non-responding legacy clients. The PWA artifact verifier checks the manifest static import closure, forbidden ERP chunks, navigation fallback, public-image allowlist and API network-only fallback.

The recorded local build experiment used Node 24.22.1, `TZ=UTC`, dotenv disabled, and the installed frozen dependencies. Initial ERP + public builds A, administrative-entry-only build B, and public-entry change C were real Vite builds. Temporary source edits were restored byte-for-byte in `finally`; complete baseline output folders were restored. Evidence: `phase7-storefront-release-isolation/deterministic-build-proof.{mjs,json,log}` under the task's visualization evidence directory.

| Output                   | A                                                                  | B administrative edit                                              | C public edit                                                      |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| ERP fingerprint          | `8ccea2712492cbec17660f86315ce0b7fa97496ecca2041cf84bb78031604b76` | `bec24f016519d252f934e53e75bdc89736c0f2b3e7175527e046dae84e114b1a` | not rebuilt                                                        |
| Storefront fingerprint   | `0a8030f5b2957dd9f5381ff848b1d5d7fe6fd228554b2e5496c2b18d90202d88` | identical                                                          | `e68b5dbe7ded1b2077b8a59b3af3c54aedef4579b920cb32f22242742f6b4027` |
| Storefront worker SHA256 | `1b8deb1f7dc81ed3904b5ceef8bc43d4ae65c8e743a6157131fac2bbfaf50d49` | identical                                                          | `a668000dc2424164d99cac27ec48233f3adc50bfce4633b75e75ed30586ec62c` |

These are experiment fingerprints, not a claim about the final production artifact. Public artifact verification found 22 JS/CSS assets, 40 precache entries and 12 required static-import files. Scope/lifecycle safeguards are covered at module/worker simulation level. A real installed-browser migration, actual offline download interruption and physical push delivery were not exercised in this local task. Browser-managed atomic SW installation is retained; no custom partial-install activation path was introduced. Final global gates, exact-head CI and production smoke evidence belong to the parent integration/release.

## Rollback

Restore only the affected frontend pointer to a retained complete version. Retain old hashed assets and additive API compatibility for open/installed clients. Do not restore a database or change financial/inventory records for a frontend rollback. A storefront pointer switch occurs only after the existing backend activation journal reaches RELEASED and internal health checks pass; its failure does not roll back released ERP binaries.

## تصحيح المراجعة النهائي

أثبت اختبار انحدار فاشل أن تبويباً قديماً انتقل إلى صفحة قانونية كان يمكن تجاهله في حارس التفعيل. جرى توسيع الاستعلام إلى كل نوافذ الأصل نفسه؛ التبويب غير المستجيب وصفحة الحساب ذات حالة غير آمنة يمنعان skipWaiting. نجح الاختبار بعد التصحيح. تجربة A/B أعلاه سبقت هذا التصحيح المحدود للعامل؛ تبقى دليلاً على فصل رسم البناء، ولا يُفترض أن بصماتها هي بصمات حزمة CI النهائية بعد التصحيح. التحقق النهائي يبني المصدر المصحح ويعيد حساب manifest.
