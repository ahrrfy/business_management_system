// Publish ciphertext only after encryption finishes. The manifest is the commit marker.
import { createReadStream } from "node:fs";
import { stat, writeFile, rename, access, copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

export async function fingerprint(file) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

export async function publishEncryptedBackup({ sqlFile, encrypt, sourceRevision = null }) {
  const final = `${sqlFile}.gpg`;
  const manifestFile = `${final}.manifest.json`;
  // Backup names are unique. Never overwrite an existing publication or evidence.
  for (const file of [final, manifestFile]) {
    try { await access(file); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("BACKUP_PUBLICATION_EXISTS");
  }
  const partial = `${final}.${randomUUID()}.partial`;
  const source = await fingerprint(sqlFile);
  if (source.size < 512) throw new Error("BACKUP_SOURCE_TOO_SMALL");
  await encrypt(partial);
  if (!(await stat(partial)).isFile()) throw new Error("BACKUP_CIPHERTEXT_NOT_FILE");
  const encrypted = await fingerprint(partial);
  if (!encrypted.size) throw new Error("BACKUP_CIPHERTEXT_EMPTY");
  const after = await fingerprint(sqlFile);
  if (source.sha256 !== after.sha256 || source.size !== after.size)
    throw new Error("BACKUP_SOURCE_CHANGED");
  const manifest = {
    version: 1,
    file: basename(final),
    ...encrypted,
    publishedAt: new Date().toISOString(),
    source: { file: basename(sqlFile), ...source, revision: sourceRevision },
    recovery: {
      status: "NOT_RESTORE_VERIFIED",
      requiredEscrow: ["BACKUP_GPG_PASSPHRASE", "INTEGRATIONS_ENCRYPTION_KEY"],
      mediaManifest: null,
    },
  };
  const pendingManifest = `${manifestFile}.${randomUUID()}.partial`;
  await writeFile(pendingManifest, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(partial, final);
  // A crash before this rename leaves ciphertext uncommitted and rejected by consumers.
  await rename(pendingManifest, manifestFile);
  return manifest;
}

// No retention/deletion here. Existing mismatches are preserved for investigation.
export async function mirrorPublishedBackup(file, directory) {
  await mkdir(directory, { recursive: true });
  const manifest = JSON.parse(await readFile(`${file}.manifest.json`, "utf8"));
  if (manifest.version !== 1 || manifest.file !== basename(file))
    throw new Error("BACKUP_MANIFEST_INVALID");
  const expected = await fingerprint(file);
  if (expected.size !== manifest.size || expected.sha256 !== manifest.sha256)
    throw new Error("BACKUP_SOURCE_INTEGRITY_FAILED");
  const destination = join(directory, basename(file));
  if (resolve(destination) === resolve(file)) return;
  let exists = false;
  try { await access(destination); exists = true; } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (exists) {
    const old = await fingerprint(destination);
    if (old.size === expected.size && old.sha256 === expected.sha256) {
      // Verify the receipt too; never overwrite an existing untrusted receipt.
      let receipt;
      try { receipt = JSON.parse(await readFile(`${destination}.manifest.json`, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        // Recover a crash between ciphertext and receipt publication. Rehash first.
        const current = await fingerprint(destination);
        if (current.size !== expected.size || current.sha256 !== expected.sha256)
          throw new Error("BACKUP_MIRROR_CHANGED");
        const pending = `${destination}.manifest.json.${randomUUID()}.partial`;
        await writeFile(pending, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
        await rename(pending, `${destination}.manifest.json`);
        return;
      }
      if (receipt.version === 1 && receipt.file === manifest.file && receipt.size === expected.size && receipt.sha256 === expected.sha256) return;
    }
    throw new Error("BACKUP_MIRROR_EXISTS_UNVERIFIED");
  }
  try { await access(`${destination}.manifest.json`); throw new Error("BACKUP_MIRROR_RECEIPT_EXISTS"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const partial = `${destination}.${randomUUID()}.partial`;
  await copyFile(file, partial, 1);
  const copied = await fingerprint(partial);
  if (copied.size !== expected.size || copied.sha256 !== expected.sha256)
    throw new Error("BACKUP_MIRROR_INTEGRITY_FAILED");
  const pending = `${destination}.manifest.json.${randomUUID()}.partial`;
  await writeFile(pending, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
  await rename(partial, destination);
  await rename(pending, `${destination}.manifest.json`);
}
