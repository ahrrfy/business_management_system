# ERP Node.js 24.22.1 migration

The ERP runtime is pinned in `.node-version`. CI reads that file, and type checks,
builds and production deployment reject another version. PM2 remains at 7.0.3.

## Isolation

- Install the official Linux x64 archive under `/opt/alroya-erp/node-v24.22.1-linux-x64`, owned by root and not writable by deploy.
- Verify the archive against the official HTTPS SHASUMS256.txt before extraction. The expected SHA-256 is `6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6`.
- Preserve `/usr/bin/node`, global npm packages, the root PM2 daemon, Docker, nginx, Odoo and Siraj.
- Persist the ERP-only PATH prefix in the deploy account login profile; preserve its previous contents for rollback.
- Prefix PATH with `/opt/alroya-erp/node-v24.22.1-linux-x64/bin` for ERP commands only. Run repository, pnpm and PM2 commands as deploy with `PM2_HOME=/home/deploy/.pm2`.

## Activation

1. Record health, `/proc` executable paths and start times for ERP and neighboring services. Save the deploy PM2 dump, active artifact paths, installed helper and systemd drop-in in a root-only backup directory.
2. Require successful checks on the exact main release. Install the helper and drop-in using the SHA-256 values published by that main CI run, following `deployment-vps.md`.
3. Stop only `pm2-deploy.service`. Update `exec_interpreter` in its saved dump to the isolated Node path, including pm2-logrotate. Start only that service. This short ERP maintenance interval replaces the deploy daemon: cluster workers inherit the daemon's Node runtime.
4. Verify the daemon and every deploy Node process via `/proc/<pid>/exe`, not only `node -v` or cached PM2 metadata. Verify public health before continuing.
5. Run `pnpm prod:deploy` with the isolated Node path first in PATH. The existing deployment controller retains backup, migration, immutable artifact, bridge stability and rollback gates.
6. Verify exact production commit and active artifact, all live and saved interpreters, public health, bridge readiness, and unchanged neighboring process start times and shared binary hash.

## Rollback

If activation fails, stop only the deploy service, restore its saved PM2 dump,
helper and drop-in, reload systemd configuration and start that service. Verify
public health and the saved artifact paths. Node 20 is retained solely for this
emergency rollback; it remains unsupported. Never restore the database as part
of a runtime rollback. A failed subsequent application deployment uses the
existing deployment controller's artifact rollback and preserves Node 24.
