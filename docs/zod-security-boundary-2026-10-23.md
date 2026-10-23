# Zod security boundary, 2026-10-23

All resolved Zod packages must be at least 4.6.6 for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The former IMG.LY 3.25.76 exception has been removed from the lockfile policy and OSV configuration.

IMG.LY 1.7.0 embeds Zod 3.24.2 in both published bundles, so a dependency override alone is insufficient. The checked-in pnpm patch removes that embedded implementation from ESM and CJS and imports the patched Zod dependency instead. The override is scoped to IMG.LY, not a global major-version replacement.

The compatibility adapter preserves v3 default processing through `prefault`, including the `medium` model alias and default output configuration. It preserves progress callback argument and return validation using a Zod 4 function wrapper. Existing public declarations retain the v3 type vocabulary via the type-only `zod/v3` export of the installed Zod 4 package; application runtime imports of that legacy API remain forbidden. Image decoding, model inference, assets and output code are unchanged. Stale upstream bundle source-map references are removed.

`node scripts/verify-zod-security.mjs` runs before every build. It checks the installed ESM/CJS bundles, configuration defaults/model aliases, invalid configuration rejection, callback validation, and early rejection of oversized bounded arrays/sets/maps, including async arrays. Ten original upstream configuration fixtures were also compared before migration. Type checking and the existing build/integration CI remain mandatory.

Unbounded collections still need application-level input limits; the upstream fix is not a universal resource bound.

Rollback uses the previous immutable web artifact and the backed-up package/lock/dependency tree. This change has no database migration and must never restore a production database automatically. Host package updates are separate from this application release.

The deployment audit also gained [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) during validation. The Express dependency is narrowly overridden to body-parser 1.20.9, without changing its other resolved dependencies. The pre-build HTTP probe exercises normal compressed JSON and malformed trailing bytes against an isolated loopback server, then verifies that the process still answers requests. No malformed requests are sent to production.
