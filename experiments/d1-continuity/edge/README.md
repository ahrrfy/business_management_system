# Actual-service Workers staging: first slice

**Overall cashier/storefront migration is incomplete.** This experiment runs the
original price lookup, billing calculations and cart-share creation on Workers
with D1. It does not execute original sale commitment, checkout, credit,
returns, digital issuance, COD dispatch, stock mutation or ERP authentication.
Those routes explicitly return 501. The console is a limited test interface;
the original POS/storefront UIs have not been migrated.

## Actual code and boundaries

The build imports unchanged `server/services/pricing.ts`, `billing.ts`,
`money.ts` and `storefrontCartShareService.ts`, plus their original schema and
error contracts. `build/source-evidence.json` records source SHA256 and the
bundle graph. Production `server/db.ts`, mysql2, providers and the earlier
synthetic `commands.mjs` are forbidden dependencies.

The two deliberate substitutions are request-scoped `getDb` via
AsyncLocalStorage, and an unavailable `storefrontProduct` stub used only by the
unexposed cart-resolution path. Called business functions are not replaced.
The adapter admits the exact original price SELECT and stages the exact single
cart-share INSERT. Transactions, other SQL and unknown methods fail closed.
It is **not a general MySQL-to-D1 adapter**. D1 uses small synthetic projections
of `productPrices` and `storefrontCartShares`, not the complete ERP schema.

Actual POS and checkout depend on interactive MySQL transactions, locking,
numbering and multiple linked financial effects. D1 requires a deliberately
prepared command plus one revalidated atomic batch. Dropping locks or using
separate awaited D1 writes would break that contract. The audits and remaining
port work are recorded in the result report.

## Journal and recovery contract

Cart-share preparation invokes the original normalizer, random token and
seven-day expiry code without a primary write. The separate journal database
chooses an immutable request/hash/plan/result for same-key competitors. The
primary then applies the cart and request result together in a guarded batch.
After reading the actual source row, including ID and creation timestamp, the
Worker writes its signed COMMITTED snapshot to the journal before returning
success. A failure between those steps is uncertain/pending; the original key
must be replayed. Different-payload reuse returns 409. Journal failure blocks
new writes, including recovery confirmation; it is not treated as success.

The journal is a different D1 database within Cloudflare. The cloud test also
exports signed records to a file on this computer and calls fsync before
reading it back. A separate restore Worker has only the fresh target DB
binding, **no journal binding**, and recovers from that external signed file.
Signing material is kept in the ignored private test-secret file; it is never
embedded in the bundle, public console, result log or repository.

Each signed restore input chunk is validated before mutation and commits in one
native batch, including full source ID/timestamp guards. At most eight records
use 49 database statements including the identity query. Different chunks of a
file are resumable and idempotent, not one atomic transaction for the entire file.

This is a cart-share recovery experiment. The journal is not an independent
cloud provider, and the local copy is a tested checkpoint, not a continuously
acknowledged off-provider copy of every future operation. No no-loss ERP or
regional-disaster guarantee is established. Full financial recovery must also
preserve and reconcile every authoritative source/effect, media and key.

## Run and isolation

Use installed laboratory/root dependencies. No command reads root `.env`.

```powershell
node --test experiments/d1-continuity/edge/actual.test.mjs experiments/d1-continuity/edge/edge.test.mjs
node experiments/d1-continuity/edge/build.mjs
```

Cloud commands are opt-in and pinned to the exact separately created resources.
They do not register a domain, configure production DNS/zone routes, create new resources,
activate billing or reset an existing database. Initialization refuses a
nonempty database and cannot be repeated automatically. The private runtime
descriptor is `.superpowers/sdd/edge-runtime.json`.

```powershell
node experiments/d1-continuity/edge/cloud-run.mjs --initialize --confirm-synthetic-sandbox
node experiments/d1-continuity/edge/cloud-run.mjs --deploy --confirm-synthetic-sandbox
node experiments/d1-continuity/edge/load.mjs --confirm-synthetic-sandbox
```

**The full cloud runner requires an empty restore target.** Do not rerun it
against the populated evidence target. After a focused fix, verify the final
bundle by replaying the preserved signed checkpoint without resetting data.
The runner caps HTTP requests and concurrency, preserves failure evidence and
separates worker wall time from CPU measurement. It is not in the root suite.

Wrangler runs from a dedicated TEMP directory with an explicit config and a
restricted environment; disk logs are disabled with `WRANGLER_WRITE_LOGS=false`.
All API/data/fault/recovery paths require a private test token. Public console
responses are no-store/noindex and include no credentials or real data. The
token is not ERP authentication. Results/keys/database state/builds stay ignored.

Local tests deny Worker outbound HTTP and verify zero attempts. The deployed
service graph contains no Hostinger connection. This models Hostinger absence
for this slice without stopping or querying production; it does not establish
outage readiness for the unported services.

Permanent results: `docs/superpowers/plans/2026-10-17-d1-edge-poc-results.md`.
References: [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[Express on Workers](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
