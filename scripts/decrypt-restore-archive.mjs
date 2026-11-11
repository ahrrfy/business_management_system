// Prepare an encrypted backup for the existing SQL restore process.
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decryptBackupWithOwnedAgent } from "./lib/backup-gpg.mjs";
import { fingerprint, readEncryptedPublication, sameFingerprint } from "./lib/backup-publication.mjs";
import { assertPrivateRecoveryDirectory } from "./lib/recovery-mysql.mjs";

const maxSqlBytes = 2 * 1024 ** 3;

function gpgForPlatform() {
  if (process.platform !== "win32") return {};
  const gitGpg = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "gpg.exe");
  return existsSync(gitGpg) ? { gpg: gitGpg, msys: true } : {};
}

export async function prepareEncryptedRestore({
  archive, sqlFile, requireManifest, passphrase, gpgOptions = gpgForPlatform(),
}) {
  if (!passphrase) throw Error("BACKUP_KEY_REQUIRED");
  if (!path.isAbsolute(archive) || !/\.sql\.gpg$/i.test(archive) ||
      !path.isAbsolute(sqlFile) || !sqlFile.endsWith(".sql") || !(await lstat(archive)).isFile()) {
    throw Error("BACKUP_RESTORE_INPUT_INVALID");
  }

  const requestedDirectory = path.dirname(sqlFile);
  if (!(await lstat(requestedDirectory)).isDirectory()) throw Error("BACKUP_RESTORE_INPUT_INVALID");
  const directory = await realpath(requestedDirectory);
  const outputFile = path.join(directory, path.basename(sqlFile));
  const newStagingDirectory = path.basename(outputFile) === "decrypted.sql" &&
    /^erp-restore-decrypted-[A-Za-z0-9_-]+$/.test(path.basename(directory)) &&
    path.relative(await realpath(tmpdir()), path.dirname(directory)) === "";
  await assertPrivateRecoveryDirectory(directory, { restrictNewWindowsDirectory: newStagingDirectory });

  const cipher = await fingerprint(archive);
  const publication = await readEncryptedPublication(archive, cipher);
  if (requireManifest && !publication) throw Error("BACKUP_MANIFEST_INVALID");
  const maxBytes = publication?.source.size ?? maxSqlBytes;
  if (maxBytes > maxSqlBytes) throw Error("BACKUP_RESTORE_SQL_TOO_LARGE");

  await decryptBackupWithOwnedAgent({ ...gpgOptions, archive, sqlFile: outputFile, passphrase, maxBytes });
  const output = await lstat(outputFile);
  if (!output.isFile() || output.size < 512 || output.size > maxBytes) throw Error("BACKUP_RESTORE_INPUT_INVALID");
  if (publication && !sameFingerprint(await fingerprint(outputFile), publication.source)) {
    throw Error("DECRYPTED_SQL_FINGERPRINT_MISMATCH");
  }
  if (!sameFingerprint(await fingerprint(archive), cipher)) throw Error("BACKUP_ARCHIVE_CHANGED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [archive, sqlFile, flag] = process.argv.slice(2);
  try {
    await prepareEncryptedRestore({
      archive, sqlFile, requireManifest: flag === "--require-manifest",
      passphrase: process.env.BACKUP_GPG_PASSPHRASE,
    });
  } catch (error) {
    const code = error?.code ?? error?.message;
    console.error(typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code) ? code : "BACKUP_RESTORE_DECRYPTION_FAILED");
    process.exitCode = 1;
  }
}
