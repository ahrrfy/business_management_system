# Mobile dependency security decisions

## Removed transitive dependency: `image-size`

Resolved on 2026-09-05 for GitHub issue #916.

The old Expo SDK 54 graph resolved Metro 0.83.3, which directly resolved `image-size@1.2.1` for build-time asset inspection. That version is covered by [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq). The official `image-size` repository was archived on 2026-06-03 and npm still publishes vulnerable `2.0.2` as latest, so there is no safe official `image-size` version to force.

The real mitigation is dependency elimination. The mobile package pins the complete Metro family to 0.83.8, whose published manifest no longer depends on `image-size`; the current lockfile contains neither the package nor an edge to it. This avoids a local fork, a permanent advisory suppression, and any parser exposure.

`pnpm check:image-size-security` verifies the installed Metro version and manifest, confirms that Node cannot resolve `image-size`, and scans the lockfile for package or dependency entries. Expo CI runs the guard after every frozen install. Any future Expo/Metro change that reintroduces `image-size` fails before merge.

Do not add an audit exception for these advisories while the vulnerable package is absent. If Metro ever reintroduces it, require a fixed official release or a separately reviewed mitigation.
