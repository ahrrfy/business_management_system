import "dotenv/config";
import {
  provisionBackupClient,
  BACKUP_CLIENT_IMAGE,
  BACKUP_CLIENT_VERSION,
} from "./lib/backup-client.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => !["--pull", "--isolated"].includes(arg))) {
  console.error(
    "Usage: node scripts/provision-backup-client.mjs [--pull] [--isolated]",
  );
  process.exit(1);
}
try {
  const prepared = await provisionBackupClient({
    pull: args.includes("--pull"),
    forceIsolated: args.includes("--isolated"),
    rawUrl:
      process.env.BACKUP_TARGET_URL ??
      process.env.DATABASE_URL ??
      process.env.BACKUP_SMOKE_DATABASE_URL,
    container: process.env.DB_CONTAINER,
  });
  console.log(
    prepared.kind === "native"
      ? "Backup client ready: capable native mysqldump."
      : prepared.kind === "legacy-container"
        ? "Backup client ready: matching cached MySQL 8.0 image; direct Docker continuity guard required; no client download."
        : `Backup client ready: ${BACKUP_CLIENT_VERSION} (${BACKUP_CLIENT_IMAGE}); runtime pulls disabled.`,
  );
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
