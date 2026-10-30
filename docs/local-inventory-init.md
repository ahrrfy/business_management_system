# Local development inventory initialization

`db:push` creates the inventory projection tables, but does not backfill saved
transfer evidence or publish readiness. After creating and seeding a **dedicated
development database**, run `pnpm db:dev:inventory:init` explicitly before starting
the application. This command supports Windows Docker Desktop and local Unix
Docker. It never changes the application's readiness checks or production
deployment activation.

Stop the application, database clients and other writers first. The initializer
rejects every other database session, including sleeping sessions. The container
must have no active healthcheck, event scheduler or replication writer. A backfill
failure before commit rolls back its changes. A refused replay or a failure after
commit can leave an existing ready marker intact. After an uncertain/postcommit
failure, keep the application stopped and rerun the explicit command to verify
identity, saved evidence and parity. Never manually reset or publish readiness.

## Dedicated Docker target

Run from this worktree's project root. Choose an unused local port other than
3306/3307, and a new container with a database named `erp_<name>_dev`. Do not relabel
an existing database or production mirror. The following PowerShell example uses
33324; verify that it is free or select another unused port.

```powershell
Get-NetTCPConnection -LocalPort 33324 -ErrorAction SilentlyContinue
$devInventoryContainer = 'erp-inventory-dev'
$env:ERP_LOCAL_DEV_PASSWORD = '<choose a local development password>'
docker run -d --name $devInventoryContainer --no-healthcheck `
  --label online.alarabiya.erp.environment=development `
  --label "online.alarabiya.erp.project-root=$($PWD.Path)" `
  --label online.alarabiya.erp.database=erp_local_inventory_dev `
  -p 127.0.0.1:33324:3306 `
  -e "MYSQL_ROOT_PASSWORD=$env:ERP_LOCAL_DEV_PASSWORD" `
  -e MYSQL_DATABASE=erp_local_inventory_dev `
  mysql:8.0.46 --event-scheduler=OFF
```

Wait for MySQL to finish its first initialization, then inspect the server UUID.
The command below opens a connection to this explicitly created container only.
Do not leave polling clients running during activation.

```powershell
$devInventoryServerUuid = docker exec -e "MYSQL_PWD=$env:ERP_LOCAL_DEV_PASSWORD" $devInventoryContainer `
  mysql -uroot --batch --skip-column-names -e "SELECT @@server_uuid"
$devPassword = [Uri]::EscapeDataString($env:ERP_LOCAL_DEV_PASSWORD)
$env:DATABASE_URL = "mysql://root:$devPassword@127.0.0.1:33324/erp_local_inventory_dev"
$env:CONTROL_DATABASE_URL = ''
$env:NODE_ENV = 'development'
pnpm db:push
$env:CONFIRM_SAMPLE_DATA_SEED = '1'
$env:ADMIN_PASSWORD = '<choose a strong sample admin password>'
pnpm seed
pnpm db:dev:inventory:init --container $devInventoryContainer `
  --server-uuid $devInventoryServerUuid --confirm-local-development
pnpm dev
```

Persist the development `DATABASE_URL` in this worktree's ignored `.env` when
needed. The command requires a literal `127.0.0.1` host, exact loopback port
mapping, matching database/container/project labels, a local Docker context and
the matching SQL server UUID. Production mode, ports 3306/3307, remote targets,
production-like names, URL connection overrides and tenant control databases are
rejected before opening a database connection.

The initializer holds the existing exclusive company writer gate, checks for
unowned sessions, derives saved transit evidence, backfills projections, checks
independent SQL parity, and commits readiness atomically through the existing
activation primitive. It only creates missing operational singleton rows as
unready. It never resets a ready projection or directly publishes `readyVersion=1`.

Run the same explicit command again while the application is stopped to verify
an existing activation. A successful replay reports `replayed:true`, validates
saved transfer evidence and parity, and preserves activation provenance and
business records. A ready projection with drift or missing provenance is refused.
