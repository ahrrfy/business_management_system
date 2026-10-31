# Storefront resource admission — isolated calibration, 2026-10-30

Implementation is verified separately from the latency goal. **Enforce is not release-ready for the requested staff-latency isolation target. Task 6 is required before claiming that target.** Runtime defaults to `STOREFRONT_RESOURCE_MODE=observe`; rollback is setting that mode to observe, retaining nginx, rate limits, overload protection, Turnstile, authorization and idempotency.

## Scope and environment

Base `5fa16543110dd53606b1e17483f0574a431fef45`. No production connections/data, deployment, merge or push. Cached exact Node24.22.1, MySQL8.0.46, dedicated fresh synthetic schemas, internal Docker network with no internet, read-only source mounts, CPU1/RAM512MiB Node runner. Cached dependencies match lockfile; pure-JS qs6.16.1 overlaid by controller. External fetch fails closed in the lab. Actual catalog/search, POS lookup, quote, create-order and owned-replay services were invoked; no full server/background-worker bootstrap.

Historical calibration MySQL memory cap was768MiB. Later, the default test setup's366-table cleanup snapshot OOM-killed that owned MySQL container (exit137). Controller preserved evidence, raised **only its cap to1536MiB**, and restarted the same volume before validation. The classifier-corrected observe/enforce pair below uses1536MiB; no baseline rerun or resource tuning was performed. Thus there is no whole-cycle claim of memory stability without a restart, nor a controlled comparison across the two DB caps.

Synthetic fixture:160 simple products/units, one branch/category, no bundles/images. Each mode uses one cold and one warm six-procedure startup, one cold plus seven warm samples per operation, five mixed rounds of12 search +3 POS +3 quote operations, one create/replay pair, and three300ms idle samples. Original-path baseline was captured before fan-out edits; observe/enforce were captured afterward. The bounded original/observe comparison is noisy; it is not evidence of a causal regression. No soak, production sizing, HTTP throughput or orders/minute claim.

## Historical measured scenario (quote classifier mismatch)

Independent review found that this historical lab assigned quote work to public-order/cost1, while HTTP runtime assigns both quote procedures to public-read. The original JSON/logs are preserved. Its quote-admission results and policy conclusions do not calibrate the shipped runtime. The failed staff-latency result remains historical evidence; it is not replaced by a success claim.

| Measurement                           | Original baseline |  New observe |  New enforce |
| ------------------------------------- | ----------------: | -----------: | -----------: |
| Cold / warm startup ms (one each)     |       328.5 /40.9 |  342.8 /50.3 |  388.5 /15.4 |
| Quiet warm POS P95 ms (n=7)           |              46.9 |         34.9 |         31.2 |
| Mixed POS P95 ms (n=15)               |             320.4 |        460.0 |        263.1 |
| Mixed quote P95 ms (n=15)             |             117.9 |        273.3 |        174.7 |
| Mixed search completed / attempted    |             60/60 |        60/60 |        33/60 |
| Search timeout rejections             |                 0 |            0 |           27 |
| Staff / quote rejections              |              0 /0 |         0 /0 |         0 /0 |
| SQL acquired peak                     |                10 |           10 |           10 |
| SQL enqueue events                    |              1097 |         1099 |          336 |
| SQL connection wait P95 ms            |              8.85 |        19.97 |         1.86 |
| Admission active-cost / queue peak    |         untracked |        30 /0 |        17 /7 |
| CPU user+system seconds               |             2.005 |        2.684 |        1.994 |
| Measured wall seconds (includes idle) |             3.003 |        3.614 |        2.932 |
| Event-loop-delay P95 ms               |             30.15 |        38.57 |        29.61 |
| Start / final idle RSS MiB            |      208.4 /241.2 | 213.4 /249.7 | 211.5 /241.9 |

Enforce improved mixed POS P95 relative to observe in this one scenario, but **263.1ms exceeds its matched quiet31.2ms by about743%**, far above the20% target. Sample sizes are small and quiet/mixed workloads differ by design; that limitation cannot turn the failed isolation criterion into a pass. Retain observe by default; do not enable enforce as a substitute for Task6 separation.

Heap/external bytes and all three idle samples are preserved in JSON. Enforce heap-used ended about83.4MiB, external15.8MiB; RSS plateaued during the0.9s idle window. This neither establishes a leak nor proves long-term recovery. The earlier90%-RSS snapshot has no defensible leak interpretation; this experiment uses curves and still has only a short observation window.

## Classifier-corrected pair (one observe/enforce run each)

Both runs use shared `publicBatchCost` and `STOREFRONT_RESOURCE_CANDIDATE`; JSON records procedure identities and resolved lane/cost. Startup is public-read10, catalog/search public-read2, quotes public-read2, create/replay public-order2, and the explicitly selected staff fixture `catalog.posList` staff1. No client header or public authentication upgrades priority. These remain direct-service runs: HTTP, tenancy and session authentication are not exercised or measured, although the public request cost floor is included. Node CPU1/RAM512MiB and owned MySQL CPU1/RAM1536MiB were unchanged across this pair.

| Measurement | Corrected observe | Corrected enforce |
| --- | ---: | ---: |
| Cold / warm startup ms (one each) | 2222.4 /44.3 | 866.7 /41.8 |
| Quiet warm POS P95 ms (n=7) | 124.6 | 95.2 |
| Mixed POS P95 ms (n=15) | 719.6 | 538.0 |
| Mixed quote completed / attempted | 15/15 | 0/15 |
| Mixed quote P95 ms (successful samples) | 221.1 | no successes |
| Mixed search completed / attempted | 60/60 | 30/60 |
| Search timeouts | 0 | 30 |
| Quote timeouts / queue-full | 0 /0 | 10 /5 |
| Staff rejections | 0 | 0 |
| SQL acquired peak / enqueues | 10 /1094 | 9 /0 |
| SQL connection wait P95 ms | 30.70 | 0.75 |
| Admission active-cost / queue peak | 33 /0 | 15 /8 |
| CPU user+system / wall seconds | 4.825 /7.881 | 3.708 /4.846 |
| Event-loop-delay P95 ms | 25.28 | 26.82 |
| Start / final idle RSS MiB | 199.4 /220.4 | 192.9 /216.9 |

Enforce mixed staff P95 is about465.2% above its own quiet P95: **the20% criterion still FAILS**. Saturated browsing also rejects all15 quotes because runtime quotes share the read lane; this is a separate checkout-availability degradation, despite the reserved order admission lane. The historical zero-quote-rejection claim cannot be carried forward. **Enforce has no release approval for either staff isolation or quote availability.** Both create/owned-replay pairs completed with one mocked verification and the same order. No parameter was tuned or scenario rerun to improve these results, and no original baseline was rerun. The different historical DB cap, small/no-bundle fixture, separate process runs and direct-service scope prevent production or causal cross-run conclusions.

Four fixed aggregate cache names are sampled every100ms and at memory/burst/idle phases, without keys or customer data. Sampled in-flight peaks (candidates/search/categories/sold) are3/9/1/2 observe and3/5/1/0 enforce; all cache rejection counters are0. These are **sampled peaks, not exact instantaneous maxima** (sold peak0 in enforce can miss short loads). Final in-flight counts and admission active/queued cost are0 in both runs. Enforce final heap-used95.5MiB/external17.1MiB and the0.9s idle window do not establish long-term memory recovery or a leak. Full curves and raw samples are preserved in `lab-classifier-corrected-observe.json` and `lab-classifier-corrected-enforce.json`, with distinct matching logs.

## Candidate limits and cost model

| Setting                               |              Candidate |
| ------------------------------------- | ---------------------: |
| STOREFRONT_RESOURCE_ACTIVE_COST       |                     18 |
| STOREFRONT_RESOURCE_PUBLIC_COST       |                     14 |
| STOREFRONT_RESOURCE_READ_COST         |                     12 |
| STOREFRONT_RESOURCE_ORDER_COST        |                      2 |
| STOREFRONT_RESOURCE_QUEUE             |             8 requests |
| STOREFRONT_RESOURCE_QUEUE_COST        |               24 units |
| STOREFRONT_RESOURCE_WAIT_MS           |                  150ms |
| Target-cache distinct unsettled loads | 8 per cache in enforce |

Request cost is `max(2, sum(procedure costs))`: the floor covers the known once-per-request peak of two simultaneous user/session authentication reads. Context finishes before procedures start; it is charged once rather than once per member. Procedure costs are4 for two-worker product-share/thematic hydration,3 for both review submissions (two detached notification transactions overlapping the common automatic audit INSERT),2 for catalog/product/media work, and1 for smaller/sequential operations. Thus a single small read, quote or order reserves2; the six-member startup batch still costs10. The unchanged2-unit order limit now admits one single-order request at a time. These are conservative code-derived SQL fan-out admission units, not measured physical reservations or a calibrated production capacity claim. The review overlap is covered by an actual common-tRPC-root/mock-SQL regression; the fixed lab does not exercise review routes, so this correction does not require recalibration and does not change the failed staff/quote acceptance results.

A12-unit browsing limit admits that startup batch. Four total units remain outside the public ceiling and two public units outside browsing for order admission. These are **admission headroom**, not reserved CPU/RAM/SQL connections. SQL pool policy remains unchanged at its existing default10 connections/queue100. Every batch member is counted, including private members in a mixed batch; public work never gains staff priority. Mixed order/non-order batches are rejected429 before tenancy in enforce. Observe admits their aggregate public-read cost and increments would-reject; the order lane is therefore not enforced in observe. Existing browser transport already sends every order-lane procedure separately via httpLink (`client/src/lib/trpcClient.ts`). Other mixed staff/public batches remain public-read. Maximum batch size20 and existing public-sensitive batching guard remain. Quotes use public-read in both lab and runtime.

The cache cap8 bounds pending keys independently of completed `maxEntries`; it exceeds the normal simple-catalog concurrency permitted by the candidate read budget. Invalidation retains old unsettled occupancy. A fresh call never receives invalidated pending data; it can receive503 while old work occupies the cap and succeeds on retry after settlement. Other ttlCache callers retain their original defaults. Observe measures pending occupancy while leaving this new cap unenforced.

## Actual work ownership and fan-out

Early tRPC admission precedes tenancy/context SQL. Installed Express adapter returns void; its lower-level promise resolves on response finish, so neither is a work-completion contract. Actual tenancy, createContext and common procedure promises are tracked. Authentication drains both launched SQL promises before propagating a failure to context; each Drizzle thenable is materialized once, preserving the first error without re-executing SQL. Response close only closes the scope; active work retains the ticket. Closed scopes reject later phase entry. Queued requests cancel/expire before loader/service start. Verified staff procedures acquire independent abort-aware tickets, while pre-admitted public batches reuse their aggregate ticket without a second acquisition.

SEO, sitemap/feed and public-image handlers wrap their actual promises. Development/production SPA classification uses originalUrl because Express strips wildcard-mounted req.path; staff pages and the internal-host root bypass storefront admission, matching existing SEO host semantics. Public image preflight matches the actual router's case-insensitive and optional-trailing-slash aliases before tenant lookup; private image handlers retain their existing behavior. Existing R2 bounds/abort logic remain. Cart/wishlist hydration uses two ordered workers and drains siblings before failure. Product-media SQL uses allSettled before propagating errors. Review-manager notification workers are bounded to two; existing detached review/metric origins register tails synchronously before first await. They retain occupancy after the response and never make successful orders wait/fail on telemetry. No order/router/business/schema/pricing/Turnstile logic changed.

| Public surface                                       | SQL/storage fan-out before admission                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog/product/search/related/shelf/recommendations | Sequential context, search/ATP/pricing/reviews/gallery; media fallback2 concurrent SQL; image URLs only                                       |
| Categories/offers/banners/settings                   | Sequential SQL, settings/readiness transaction; no blob fetch                                                                                 |
| Thematic collections                                 | Two catalog workers, up to4 media SQL; many sequential subqueries                                                                             |
| Cart-share resolution                                | Previously up to100 product hydrations/200 media SQL attempts; now two workers/up to4                                                         |
| Wishlist create/resolve                              | Previously6/4 hydrations, now two workers/up to4 media SQL                                                                                    |
| Quote/order/quote-request/accept/cancel              | Owned-customer checks then sequential transactional connection; new writes retain all existing controls; Siteverify only on new order/request |
| Customer identity/benefits/coupons/loyalty/deletion  | Sequential auth/transaction; Firebase JWKS or Siteverify where already required, mocked/blocked in lab                                        |
| Both review submissions                              | Sequential review write, then up to2 detached notification transactions overlapping1 common automatic audit INSERT: peak3; tail retains ticket |
| Metrics/push registration                             | Sequential mutations; existing metric tail tracked                                                                                           |
| Customization upload                                 | Max2MB decode/hash, dimensions<=4096, sequential orphan checks/object put/metadata insert                                                     |
| SEO product/category                                 | Product hydration + review reads, or category read; template file read                                                                        |
| Sitemap/feed aliases                                 | Cold3/2 sequential scans, warm0 SQL; existing cache semantics retained                                                                        |
| Public product/banner images                         | Context/tenant + metadata reads, then existing bounded public storage read/retry; private paths unchanged                                     |

Availability reads bundle components recursively and sequentially; total query count depends on data depth and cache state. Authentication uses up to2 parallel user/session reads plus optional role/native-proof work before service calls. These code-derived peaks are not measured production concurrency limits. Full per-procedure inventory is in the task evidence report.

## Evidence and verification

Evidence directory: `C:/Users/alara/.codex/visualizations/2026/10/29/01a18900-f09e-71d0-a1ec-94cf9441aaa9/phase2-storefront-resources`.

- `lab-baseline.json`, `lab-observe.json`, `lab-enforce.json`: full samples, CPU/memory curve, SQL wait/queue counts, admission outcomes; corresponding logs preserve commands/output.
- `lab-classifier-corrected-observe.json`, `lab-classifier-corrected-enforce.json` and matching logs: one corrected pair, shared runtime classifier/policy, procedure identities,100ms/phase aggregate cache samples,1536MiB DB cap; historical artifacts retained.
- Unit RED: missing admission module; SF-02 starts32 loaders under old code rather than2; invalidation starts fresh unbounded work; detached conversion origin registers0 work. GREEN tests cover corrected limits, failures, freshness, sibling drain and tails.
- Real Express/tRPC tests cover auth/tenancy/handler disconnects, queued staff cancellation, mixed priority, batch limits, timeout-before-start and response-before-tail settlement.
- Actual-service replay test checks one PENDING source order/item, unchanged physical stock, identical source snapshots across replay, zero invoices/receipts/accounting entries, and one mocked token verification.
- Default DB cleanup infrastructure failure and controller-owned1536MiB recovery are preserved separately from application results.

Final check/guard/test counts are recorded in the task report; no deployment verification is claimed.
