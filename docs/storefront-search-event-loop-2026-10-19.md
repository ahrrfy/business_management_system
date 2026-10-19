# Storefront search responsiveness — 2026-10-19

The product-image 503 at 14:37:17 UTC was emitted by the overload guard before the image handler. Its worker reported 378 ms EWMA lag; an overlapping search/catalog batch completed in 1,790 ms. A later worker reported 371 ms while rejecting the manifest and four font requests; an overlapping catalog request completed in 1,556 ms. All three web workers remained online with unchanged restart counts. These records establish worker overload as the source of those responses, not a failed image lookup or storage read.

Historical logs do not identify which JavaScript stack consumed CPU. The overlapping routes are correlation. The isolated reproduction below establishes a concrete search starvation mechanism; it does not retrospectively profile either incident.

## Isolated evidence

A read-only snapshot captured 6,649 published retail-unit text rows representing 5,457 products. It excludes customer data, financial records, image bytes and product prices. The benchmark uses the actual search-index, normalization, matching, ranking and overload-guard code with an in-memory query adapter. HTTP probes run in a separate worker thread. The image response is a fixture; database, TLS and storage latency are not modeled.

| Workload | Original | Repaired |
|---|---:|---:|
| 12 distinct simultaneous searches; 40 image requests | 32 image 503; 8 image 200 | 40 image 200 |
| Maximum observed guard EWMA in that run | 627 ms | 54 ms |
| Maximum observed 10 ms timer interval | 1,548 ms | 210 ms |
| Maximum image-request latency | 2,298 ms | 199 ms |

The guard retains its existing 500 ms normal / 300 ms storefront thresholds and 500 ms sampling. All 12 full search/ranking result digests match. All 24 results from the separate cold-index / warm-match / full-ranking comparison also match. Smaller original four- and eight-search workloads returned 200 throughout, but delayed one image by 802 ms and 1,536 ms respectively; these runs are retained as well.

The original CPU profile concentrates work in repeated Arabic normalization and repeated synonym expansion. The repair:

- Replaces 26 whole-string split/join passes with an equivalent character-map replacement, preserving Arabic locale case folding and whitespace/diacritic handling.
- Prepares query relevance terms once per matcher and reuses the matcher across catalog products and shared suggestions.
- Preserves the eight-token relevance ceiling even when synonym expansion introduces a ninth matching term. All expanded terms remain mandatory for matching.
- Yields to the event loop after roughly 8 ms of index construction, scanning or candidate scoring. This is cooperative scheduling between rows, not preemption of a single row or the final native sort, and not a strict global latency bound.

No new cache, database schema, financial write path, request-priority rule or paid service is introduced. Existing company-scoped single-flight caching publishes only complete indexes.

A Linux/Node22 cross-check of the original workload returned 200 throughout but delayed one image by 1,812 ms. This illustrates the guard sampling/timing dependency: starvation does not always produce503. The repaired Linux run and its raw timings are retained separately.

## Regression and release gates

The cold-index fairness regression failed before repair: the queued event ran only after all 30,000 rows had been processed. It passes after repair without asserting hardware-specific wall-clock thresholds. The full-catalog ranking regression likewise failed before cooperative scoring and passes with identical complete ordered ids. A separate regression caught and fixed the expanded-synonym scoring edge (6,570 versus the original 6,510). Mixed Unicode normalization is compared with an independent pre-optimization oracle.

Focused validation: 63 tests across search normalization, indexing responsiveness, candidate ranking and thematic matching. Type checking, all repository guards, independent review, exact-head CI and guarded deployment are required before release. Full CI covers the existing integration and financial suites.

After deployment, verify the active runtime source fingerprints, all workers, MySQL and both public hosts; observe image, manifest/font, catalog and cashier reads across cache expirations. Live financial test transactions are not part of this incident repair. Hostinger hypervisor shutdown remains a separate availability risk addressed by the isolated Cloudflare qualification project.
