# Mobile dependency security exceptions

## Patched transitive dependency: `image-size@1.2.1`

Reviewed on 2026-09-05 for GitHub issue #916.

Expo SDK 54 resolves Metro 0.83.3, which directly resolves `image-size@1.2.1` for build-time asset inspection. The dependency is not bundled into the customer application and processes repository-controlled assets during Metro builds. The official `image-size` repository was archived on 2026-06-03, npm still publishes `2.0.2` as latest, and current Metro releases still request `image-size@^1.0.2`. Consequently, neither an Expo/Metro upgrade nor an official `image-size` release currently removes the affected package.

The installed version is covered by [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq). Instead of accepting the unmodified vulnerable code or replacing it with a newly published third-party fork, pnpm applies the audited local patch at `patches/image-size@1.2.1.patch`. The patch:

- rejects invalid ICNS entry lengths smaller than the eight-byte entry header;
- treats an ISO-BMFF zero-sized box as extending to the end of its input, so every parser step advances;
- rejects unsupported or undersized ISO-BMFF headers.

`pnpm check:image-size-security -- --check-upstream` runs the crafted ICNS and JXL inputs in a subprocess with a hard timeout and verifies ordinary PNG parsing. It also compares every newer official stable release against both advisory IDs in OSV and checks whether the latest Metro still depends on `image-size`; either available remediation fails CI and forces review. The check runs in the Expo CI workflow, including its weekly schedule. A scanner may continue to identify version `1.2.1`; that is a narrowly scoped metadata exception only while the checked local patch remains applied.

Remove the patch and this exception after a compatible official fixed version is published or Metro removes the dependency. Do not broaden the exception to another package, advisory, version, or runtime use.
