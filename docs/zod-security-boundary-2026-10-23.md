# Zod advisory boundary, 2026-10-23

[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), updated today, blocked the opening-custody release. Direct web/server and customer-mobile Zod dependencies are upgraded to 4.6.6. Their lockfile changes are confined to Zod and its peer references.

The remaining dependency, Zod 3.25.76, belongs solely to `@imgly/background-removal@1.7.0`. This library also embeds Zod 3.24.2 in its distributed runtime. Overriding its dependency would not patch that embedded code, and v4 breaks its `z.function().args` API and v3 declarations. We do not claim that the embedded validator is patched.

The actual application call is `client/src/lib/imageStudio/segment.ts`: configuration comes from a fixed local object, while the uploaded image is passed separately as a Blob. IMG.LY's `ConfigSchema` validates strings, booleans, enums, one fixed output object and a progress callback receiving three scalar arguments. It does not define a variable-length array, map or set schema. The advisory's oversized collection-validation path is therefore not reachable through this call.

An advisory-specific exception expires **2026-11-06**. It does not suppress other advisories on the old dependency. Before OSV runs, `scripts/check-zod-security-boundary.mjs` rejects unpatched direct dependencies, other old lockfile versions or dependents, new IMG.LY call sites, direct legacy API imports, a changed reviewed configuration source, or expiration. Its self-tests cover accepted and rejected dependency graphs. Future image-library changes must reassess this exception; remove it when the embedded validator can be updated compatibly.

OSV's [configuration contract](https://google.github.io/osv-scanner/configuration/) supports advisory IDs with expiration, but does not combine advisory ID and package version. The preceding fail-closed boundary check supplies that missing restriction without ignoring the package wholesale.
