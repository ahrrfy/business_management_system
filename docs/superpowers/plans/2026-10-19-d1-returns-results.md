# Cash and credit returns: isolated qualification, 2026-10-19

Native and cloud financial/recovery qualification completed on the existing isolated Workers/D1 lab. Only12 additive lab tables/indexes and the two existing lab Worker versions changed. The original367-command journal prefix and historical financial rows were retained. No production application, database, route, DNS or Hostinger process was changed.

The implementation bundles the unchanged original ERP sale, collection and `returnSaleDirect` services, original refund caps and full reversal engine. It captures stock/restock/damaged movements, CASH OUT receipts, customer debt/credit, simplified accounting entries, document effects and the original execution audit action. Source effects commit atomically; an independent signed journal must acknowledge before success. The original full request/key/actor is preserved for reconciliation and retry.

| Verification                             | Result                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real MySQL8.4.11 versus native D1        | 11 scenarios,34 commands,13 financial tables; all money/IDs/links/status/quantity/JSON equal                                                                                                                        |
| Final native load                        | 200 sales,400 returns, four cashiers/two frontends;600 measured commands; P95454.505ms; maximum39 D1 statements                                                                                                     |
| Two-line full cash return                | 43 D1 statements; both stock lines restored                                                                                                                                                                         |
| Atomic policy refusals                   | 11 cases; no partial financial/inventory effects                                                                                                                                                                    |
| Financial races                          | concurrent return/collection, original-authority recheck, retained customer credit and collectible/current invoice value assertions passed                                                                          |
| Decimal reducers                         | 3 tests: fractional cents, document-effect reversal/filter/quantity semantics, read-after-write and ledger/refund clamps                                                                                            |
| Failure/recovery                         | journal unavailable, PREPARED interruption, last-statement rollback, post-primary failure, lost response, real writer reset; original-key recovery/replay passed                                                    |
| Independent recovery                     | actual source runtime disposed; signed interrupted/resumed export restored into a runtime without source/journal/writer binding; snapshots equal; corrupt/out-of-order/replayed records handled correctly           |
| Previous cloud history                   | 367 existing signed commands, epoch368, restored into the additive native schema; all old rows equal; cloud writes0                                                                                                 |
| Previous cash/credit protocol regression | 4 native writer/pipeline/guard tests passed                                                                                                                                                                         |
| UI                                       | actual cash/credit returns on desktop/mobile, immutable lost-response retry/reload and definitive-rejection correction passed; final customer-credit/current-value flow passed; viewport390/scroll390; no JS errors |
| Types                                    | repository `pnpm check` passed;46 experiment TS roots,0 diagnostics                                                                                                                                                 |
| Guards                                   | `pnpm check:guards` passed; generated build artifacts excluded from lint, source coverage unchanged                                                                                                                 |
| Full financial suite                     | 1,244 files passed;13,703 tests passed/41 skipped, zero failed shards; four separate fresh shard/control databases, TZ=UTC, owned MySQL13326                                                                        |
| Independent review                       | source-only financial/recovery/UI and cloud boundary review completed; explicit drawer,422 refusal and restore-first deployment issues corrected                                                                    |

Cloud qualification:39 measured commands (12 cash/credit sales,3 collections,24 partial/full returns), four cashier identities, no hidden measurement retries; all39 returned200. P95 across commands was1460.823ms; return P95 was1349.324ms; maximum42 D1 statements. Correctness/recovery passed, but the earlier subsecond cashier target is **not yet met by this return-stage cloud workload**. Native timing must not be substituted for this deployed result. No paid upgrade was used to mask latency.

Cloud faults covered unavailable log, interruption after PREPARED, atomic last-statement failure, post-primary failure and lost response. Original-key retry/replay and different-payload conflict checks passed. All416 old/new signed commands were restored at epoch417 into the independent restore Worker (no source/journal/writer binding), matching pinned source SHA256 `0ef55ada45ec1ed977e31ae1a0f198e25c310a02252055d51d772203c1d05096`. The source was blocked in the recovery driver; it was not physically shut down. Health checks after offline verification found primary ready and both manifests at417. Existing rows, including customer5's debt, remain preserved; the invoice counter legitimately advanced10137→10154 for17 new invoices.

The financial run completed restoration and snapshot equality before its final historical-row assertion rejected the advancing invoice counter. The corrected validator verifies exact counter/epoch progression and all historical financial rows. A read-only continuation reverified the signed checkpoint,416 successful original restore responses, unchanged56 legacy tables and unchanged resource UUIDs; it repeated zero financial/restore commands. This avoids resetting fixtures or rerunning sales to repair a test assertion.

The11 MySQL scenarios cover walk-in cash, registered cash with retained credit, unpaid credit, part-paid credit plus collection, fully collected credit, damaged goods,83.37/41.68 decimal money, historical WAVG50-to70 with another branch's stock, both IQD cash-rounding directions and invoice discount allocation. Independent execution timestamps are normalized; financial values and reference identity are compared exactly. The oracle resets only its verified fresh synthetic s5 database. No shared3306/3310 database is accessed.

All35 existing projection-table definitions are preserved. Twelve additive tables carry roles, pending return/sales-control requests, installment/work-order/order-payment/delivery/digital/component dependencies and document effects. Return lookups are indexed; the complete target invoice, drawer receipts, relevant customer headers and variant stocks across branches are read without a global1000-row limit. The old signed identity/schema version and Durable Object writer name remain stable, preserving the full recovery prefix.

The successful admission estimate is bounded at48 statements and30 changed rows; the tested two-line return used43. Cloudflare currently documents50 D1 queries per Free Worker invocation, including individual statements inside a batch. This is an invocation-budget check, not a claim about an account's current plan, daily row quotas, deployed CPU or cloud latency. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/), checked2026-10-19.

The deployed cloud path pins the previously approved account, exact existing UUIDs/creation identities and Worker names. It checks equal source/restore checkpoints and legacy hashes, adds only the12 empty tables/indexes, and deploys recovery before primary. The bounded qualification uses customer1 only after proving zero balance/no open invoices/headroom320. Customer5's historical debt and all old invoice/receipt/ledger rows are preserved. Attempts are fsynced before requests; an unknown outcome must resume/reconcile its original run rather than reset balances or start replacement commands.

No new subscription, Worker, database or namespace was created, and no plan was upgraded. The account still has the same eight D1 database UUIDs. Existing account allowance was consumed by the bounded qualification; actual billing was not queried. Hostinger failure was modeled with a native outbound503 trap/source disposal and blocking source access during cloud recovery. The production server was never stopped.

Scope is ordinary stocked POS cash/credit, partial/full returns, CASH refunds or registered-customer credit, restock/damaged disposition, and simplified ledger mode OFF. Return input is bounded to two lines; cash sale retains the four-line limit. Digital cards, service/bundle/consignment/backorder, delivery/work-order/deposit/coupon/installment dependencies, non-CASH refunds, approval-request execution, ACTIVE/SHADOW GL and production authentication/outbox delivery are explicitly outside this qualification. The storefront and automatic production failover are not changed by this return stage.

Reproduction and guarded cloud commands are in `experiments/d1-continuity/returns/README.md`. Raw synthetic evidence, signed records, bundles, screenshots and private runtimes remain ignored. Do not downgrade the recovery reader/schema after a new return has entered the journal. Preserve the new reader even when rolling back a writer/UI version.

Evidence hashes (SHA256, under `experiments/d1-continuity/returns/results/`):

| Artifact                         | SHA256                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| `native-recovery.json`           | `a37be5d9472592abc895201c178669fe583870f6a277752bdc96156e47b1a508` |
| `mysql-parity.json`              | `55121943e9635e822cb599e73c39c369de38d2a5c6aa48d4234d8fc46a1f7e36` |
| `policy.json`                    | `4c3399fc1d201e21ddd5e189e958d95d5d008bbd198592d7570b93cab689b2dc` |
| `collection-race.json`           | `57e27840a88edb4b66619666cf538d293bc1a9fc1e67704bcb0a5d96f6e34444` |
| `types.json`                     | `75c8d7158c21f0567c321fb886c74236c4d426057555e176d793662291862516` |
| `ui-final-proof.json`            | `2d79010d53df267ffbf7f3c50aaace27fad73154c6b27d8dcf9654d58adbf8b0` |
| `old-prefix-20261019/proof.json` | `48a1db4c67917ce76551c2dcaecbf86979afcef7f5f884a2a8e45d1af792675d` |

The final native checkpoint is epoch613 with612 independently signed commands. Its retained run directory is `results/recovery-1792397958158/`. Bundled unchanged original sources: `returnService.ts`=`44f9d1de0785191d98fb83ded7af677025c1f04593fff7bfd7c49fb95e8ba01a`, `reversalEngine.ts`=`eaf587e825f054a1ed033015a7ce32a9cc5a8ca45bcdf9eebb5f712f905e0e06`, `returns/refundCaps.ts`=`e85a8bf08381219abd4e4e54a36a4931ad6269030745e265547fbec75bfd26dd`.

Full-suite proof: `experiments/d1-continuity/credit/results/subsecond-suite-20261019/suite-summary.json`, SHA256 `653a7311540dbacf3720906c433f80b5b7d60e4210bacb6bf88ac543aaf26956`. The generated role-preset snapshot was byte-preserved privately and confirmed equal to HEAD after CRLF normalization before restoring it; no semantic snapshot update is included.

Cloud evidence (SHA256, relative to `experiments/d1-continuity/returns/results/cloud-20261019/`):

| Artifact                                   | SHA256                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `before.json`                              | `cd5c39e7b12210d746e5cf48a5d72075d83bcfeb391c5508a18ffd78fedb930b` |
| `extension.json`                           | `489b099e2c48051f7d689fdb7587d0e9ba5a1ad148b6bfab398896bcf4d0c48f` |
| `deploy.json`                              | `f94c150dd245139d8b8e2ce619a72a8a8637528dacaadd445a87616b25a5a9c6` |
| `health.json`                              | `1c80dce29a011611a35d9243efe3ac3465c55990bf7424842fcde41352016ef9` |
| `qualification-1792399263637/summary.json` | `51dcb83e46981a982133512ddef157ba1d4c27a600ddbe476a21bab33464543e` |

Active lab versions: primary `4547c4b5-bad5-4948-9087-ea10c49fe37b`; restore `7e0577e3-80b9-4643-af4d-9d678f57148a`. The recovery version was deployed first. Owned MySQL13326 was stopped after the full suite; a fresh TCP check returned `ECONNREFUSED`, and its data/evidence were retained.
