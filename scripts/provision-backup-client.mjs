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
  const prepared = provisionBackupClient({
    pull: args.includes("--pull"),
    forceIsolated: args.includes("--isolated"),
  });
  console.log(
    prepared.kind === "native"
      ? "Backup client ready: capable native mysqldump."
      : `Backup client ready: ${BACKUP_CLIENT_VERSION} (${BACKUP_CLIENT_IMAGE}); runtime pulls disabled.`,
  );
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
