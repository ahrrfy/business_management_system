# Isolated D1 continuity laboratory

This is a synthetic feasibility experiment for representative cashier/storefront
commands. It is **not the migrated ERP**, a production adapter, a complete auth
implementation, or proof that every cashier function can run on D1 today.

No root `.env`, production credentials, domain, Cloudflare account/database ID,
real provider, payment/card issuance or production database is used. Miniflare
runs actual workerd with a local D1 binding; outbound Worker network requests are
rejected and counted. MySQL reference is a fresh portable 8.4.9 instance on
`127.0.0.1:13317`, with the database name and data directory validated before SQL.

## Run

Requires Node 24, Windows PowerShell for the portable MySQL setup, and installed
root dependencies for importing the actual money/billing reference. Install root
dependencies with the repository's frozen lockfile if absent. The laboratory has
its own exact dependency versions and lockfile; it does not change root packages.

```powershell
npm --prefix experiments/d1-continuity ci
npm --prefix experiments/d1-continuity test
powershell -NoProfile -File experiments/d1-continuity/mysql-local.ps1
$env:TZ = 'UTC'
node --test --test-reporter=spec experiments/d1-continuity/reference.test.mjs
node --test --test-reporter=spec experiments/d1-continuity/isolation.test.mjs
powershell -NoProfile -File experiments/d1-continuity/mysql-local.ps1 -Action Stop
```

`mysql-local.ps1` downloads the official MySQL Windows archive into a fresh TEMP
directory, uses `--no-defaults`, refuses an occupied test port and binds loopback
only. Its fixture root account has an empty password and is for this temporary
local server alone. It never discovers or reuses another database. Stop uses the
recorded process identity. If setup fails, the ignored runtime record remains in
`.superpowers/sdd/mysql-runtime.json` for inspection and shutdown. The script does
not delete old directories or restart any existing database/server.

The reference tests bundle and execute **the actual unchanged repository**
`server/services/money.ts` and `billing.ts`, compare calculations to the spike,
then round-trip signed DECIMAL(20,2) boundaries through MySQL and D1. No copy of
those production helpers is used as the expected result. This covers output
money at two decimal places; it does not certify every USD 4dp purchase-price,
quantity, FX, WAVG, tax or accounting-report contract in the ERP.

Machine evidence is written under ignored `results/`. D1 runtime state and
bundles are ignored; no database/binary files or credentials should be committed.
The main repository type/guard checks do not substitute for `npm test` here.

## What the experiment evaluates

- Atomic source, financial/stock effects, request hash, stable result and outbox
  in a single `D1.batch`; a guard that changes zero rows aborts the batch.
- Concurrent cashier sales, storefront reservations/COD dispatch, credit limits,
  approval/coupon consumption, cash/credit refunds and synthetic digital intent.
- Lost response after commit, original-payload replay, different-payload refusal,
  tenant/branch scope, closed period and stale-writer epoch.
- Late failure rollback, persisted local runtime restart and unavailable
  Hostinger binding, with no permitted Worker egress.
- Exact money strings and Decimal calculations, real MySQL reference constraints
  and known SQLite/MySQL collation differences.

## Interpretation

Passing this experiment supports continuing an isolated migration prototype. It
does not approve production cutover. The commands and schema are deliberately
small representative models, not complete sale/return/digital services.

1. Monetary TEXT is exact storage, **not exact SQL arithmetic**. Existing reports
   using SUM/casts/order/filter arithmetic need explicit reviewed replacement;
   optimistic writes must validate every monetary input row/version atomically.
2. SQLite NOCASE does not reproduce MySQL utf8mb4_unicode_ci accent/case/PAD
   semantics. Normalized business-key contracts and collision checks are required.
   The test uses the repository's local-test collation, not a live production read.
3. Local persisted process restart proves local persistence only. Cloudflare
   regional failover, Time Travel, backup restore/reconciliation, latency, quotas,
   billing and the 10GB database limit need separate cloud evidence.
4. Hostinger outage is simulated at the service-binding boundary; the existing
   production app, login, media, printing and shared Hostinger writers are not
   migrated or fenced by this experiment.
5. Digital external issuance remains manual/provider-dependent. Internal
   idempotency cannot establish that an external payment/card was issued once
   without provider idempotency or a reconciliation contract; UNKNOWN must stop
   automatic reissue.

Primary references: [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[local development](https://developers.cloudflare.com/d1/best-practices/local-development/),
[limits](https://developers.cloudflare.com/d1/platform/limits/).
