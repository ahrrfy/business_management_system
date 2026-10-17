# Opt-in Cloud D1 proof

Runs the existing synthetic `../commands.mjs` locally against **real Cloudflare
D1 SQL over its REST API**. No public Worker, ERP endpoint, DNS route, Hostinger
deployment, real customer, payment or card provider is involved. This is a
database feasibility proof; it does not measure Worker CPU or production RTO.

The account has no workers.dev subdomain. The remote binding attempt stopped
with Cloudflare code 10063; this experiment uses the supported D1 REST endpoint
without account onboarding, broader OAuth scopes or paid-plan activation.

## Admission and credentials

Cloud execution requires an explicit flag, an ignored local runtime descriptor,
the pinned test account/database/name, a verified remote resource identity and
a synthetic schema marker. Unknown application tables stop initialization/reset.
The restore client additionally verifies the separately created target UUID and
creation time. Imported source identity is admitted explicitly in memory; it is
never silently rewritten to disguise an unrelated database.

Authentication uses the official pinned Wrangler CLI with its encrypted local
OAuth store. The CLI's token JSON is captured privately and retained in memory
only, with `WRANGLER_WRITE_LOGS=false` for its subprocess. Wrangler otherwise
persists logger output even when stdout is captured: this was found during
review and credential fields were removed from the affected session logs.
Credentials, headers, root `.env` and CLI auth output are not written to evidence.
Do not copy a token into these files. Neither runner creates/deletes a cloud
database, enables a paid plan or registers a workers.dev name.

## Run

Local safety tests make no cloud requests:

```powershell
node --test experiments/d1-continuity/cloud/safety.test.mjs
```

Cloud fixtures reset their pinned synthetic source database. These runners are
intentionally absent from `npm test` and the root suite. Never run the two
commands concurrently: export blocks source database requests.

```powershell
node experiments/d1-continuity/cloud/run.mjs --confirm-synthetic-sandbox
node experiments/d1-continuity/cloud/recovery.mjs --confirm-synthetic-sandbox
```

The first command tests exact money, cash/credit effects, last-stock contention,
COD reservations, original-payload replay, native batch rollback, refund caps,
scope/epoch gates and a synthetic digital UNKNOWN state. Each failed assertion
is recorded; transport/auth/budget failures remain failures, never business
rejections. The API budget limits request count, observed rows and concurrency.
Metadata includes successful/failed response observations; row counters do not
estimate unreported work inside rejected SQL or CLI export/import.

The recovery runner requires a **fresh, empty, separately approved target** in
`.superpowers/sdd/cloud-restore-runtime.json`; reusing a populated target stops
before import. It exports a quiescent source, then commits one further sale with
the complete original command saved outside D1. After import it compares every
original synthetic application table, proves that the later sale is missing
from the backup, replays it, and checks exact state equality and no duplicate
effects after reconnect/retry. Signed DECIMAL(20,2) extrema are checked through
the actual export/import.

## Evidence and interpretation

Generated results, SQL exports and synthetic command logs stay ignored under
`cloud/results/`. Main evidence files are `latest.json` and
`recovery-latest.json`; they record source hashes and exact run results.
The permanent result report is
`docs/superpowers/plans/2026-10-17-d1-cloud-poc-results.md`.

Backup recovery here is a bounded synthetic replay with an externally preserved
command log. A backup alone has an observable gap. No regional outage, Time
Travel recovery, complete disaster recovery service or all-function ERP
migration is proven. Production acceptance still requires full auth/pricing,
shared-writer fencing, real provider reconciliation, media/printing, conversion
of the actual schema/reports, realistic load and independent recovery drills.

References: [D1 REST query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
