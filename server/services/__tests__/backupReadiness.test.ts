import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectBackupReadiness, resolveRecordedArchive, summarizeRestoreDrill, writeRestoreDrillAttempt,
} from "../../lib/backupEvidence";
import {
  BackupDeleteGuardError,
  deleteBackup,
  OnlineMaintenanceBlockedError,
  resolveStoredRestoreFile,
  runBackup,
  runRestore,
  startRestoreDrill,
} from "../maintenanceService";

const execBackup = vi.hoisted(() => vi.fn<
  (executable: string, args: string[], options: object) => Promise<{ stdout: string }>
>());
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: execBackup }) };
});

const sql = "-- test SQL\n".repeat(100);
const encrypted = "synthetic archive";
const startedAt = "2026-11-10T00:00:00.000Z";
const finishedAt = "2026-11-10T00:05:00.000Z";
const restoredAt = "2026-11-10T00:10:00.000Z";
const backup = "erp-backup.sql";
const prefix = "erp-backup-readiness-test-";

function fingerprint(content: string) {
  return { size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
}

async function writeCopy(directory: string, name: string, content = encrypted) {
  const file = name + ".gpg";
  await writeFile(path.join(directory, file), content);
  const manifest = {
    version: 1,
    file,
    ...fingerprint(content),
    publishedAt: finishedAt,
    source: { file: name, ...fingerprint(sql) },
  };
  await writeFile(path.join(directory, file + ".manifest.json"), JSON.stringify(manifest));
}

async function writeAttempt(directory: string, file: string, status: "STARTED" | "COMPLETED" | "FAILED", start = startedAt) {
  await writeFile(path.join(directory, file + ".attempt.json"), JSON.stringify({
    version: 1, file, status, startedAt: start, finishedAt: status === "STARTED" ? null : finishedAt,
  }));
}

describe("backup readiness evidence", () => {
  let root: string;
  let local: string;
  let offsite: string;
  let reports: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), prefix));
    local = path.join(root, "local");
    offsite = path.join(root, "offsite");
    reports = path.join(local, "restore-reports");
    await Promise.all([mkdir(offsite), mkdir(reports, { recursive: true })]);
    vi.stubEnv("BACKUP_DIR", local);
    vi.stubEnv("CONTROL_DATABASE_URL", undefined);
    execBackup.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith(prefix)) {
      throw new Error("Unsafe backup test cleanup path");
    }
    await rm(root, { recursive: true, force: true });
  });

  it("distinguishes old SQL, unfinished attempts and uncommitted archives, scoped to the company", async () => {
    const old = "erp-2026-11-09T08-00-00.sql";
    await Promise.all([
      writeFile(path.join(local, old), sql),
      writeFile(path.join(local, old + ".gpg"), encrypted),
      writeFile(path.join(local, "other-company.sql"), sql),
      writeFile(path.join(local, "erp-partial.sql.partial"), sql),
      writeAttempt(local, "erp-failed.sql", "FAILED"),
      writeAttempt(local, "erp-interrupted.sql", "STARTED", finishedAt),
    ]);

    const result = await inspectBackupReadiness(local, offsite, "erp-");
    expect(result.backups).toHaveLength(3);
    expect(result.latestAttempt).toMatchObject({ file: "erp-interrupted.sql", status: "STARTED", finishedAt: null });
    expect(result.latestOffsite).toBeNull();
    expect(result.latestRestore).toBeNull();
    expect(result.backups).toContainEqual(expect.objectContaining({
      name: "erp-failed.sql", sqlAvailable: false, attempt: expect.objectContaining({ status: "FAILED" }),
    }));
    expect(result.backups).toContainEqual(expect.objectContaining({
      name: old, createdAt: "2026-11-09T08:00:00.000Z", sqlAvailable: true,
      encryption: { status: "UNVERIFIED", at: null }, restoredAt: null,
    }));
  });

  it("reports a verified copy and the matching SQL drill even if the local SQL was removed", async () => {
    await writeCopy(local, backup);
    await writeCopy(offsite, backup);
    await writeAttempt(local, backup, "COMPLETED");
    await writeFile(path.join(reports, backup + ".restore.json"), JSON.stringify({
      status: "SQL_RESTORED_CORE_READS_PASSED", productionContact: false, stopped: true,
      finishedAt: restoredAt, sourceBefore: fingerprint(encrypted), sourceAfter: fingerprint(encrypted),
      sqlFingerprint: fingerprint(sql), privateEvidencePath: "do not expose this",
    }));
    const result = await inspectBackupReadiness(local, offsite, null);
    expect(result.latestOffsite).toEqual({ name: backup, at: expect.any(String) });
    expect(result.latestRestore).toEqual({ name: backup, at: restoredAt });
    expect(result.backups[0]).toMatchObject({
      name: backup, sqlAvailable: false,
      encryption: { status: "RECORDED" }, offsite: { status: "RECORDED" }, restoredAt,
    });
    expect(JSON.stringify(result)).not.toContain("do not expose this");
  });

  it("does not credit a different archive, a mismatched drill or an archive edited after its marker", async () => {
    await writeCopy(local, backup);
    await writeCopy(offsite, backup, "different archive");
    await writeFile(path.join(reports, backup + ".restore.json"), JSON.stringify({
      status: "SQL_RESTORED_CORE_READS_PASSED", productionContact: false, stopped: true,
      finishedAt: restoredAt, sourceBefore: fingerprint(encrypted), sourceAfter: fingerprint(encrypted),
      sqlFingerprint: fingerprint("different SQL"),
    }));
    const mismatch = await inspectBackupReadiness(local, offsite, null);
    expect(mismatch.backups[0]).toMatchObject({
      encryption: { status: "RECORDED" }, offsite: { status: "UNVERIFIED" }, restoredAt: null,
    });
    const modified = new Date(Date.now() + 60_000);
    await utimes(path.join(local, backup + ".gpg"), modified, modified);
    const changed = await inspectBackupReadiness(local, local, null);
    expect(changed.backups[0]).toMatchObject({
      encryption: { status: "UNVERIFIED" }, offsite: { status: "MISSING" }, restoredAt: null,
    });
  });

  it("records a missing GPG key only for the matching unchanged source archive", async () => {
    await writeCopy(local, backup);
    const file = path.join(reports, backup + ".restore.json");
    const evidence = {
      status: "NOT_RESTORE_VERIFIED", failure: "BACKUP_KEY_REQUIRED", productionContact: false,
      finishedAt: restoredAt, sourceBefore: fingerprint(encrypted), sourceAfter: fingerprint(encrypted),
    };
    await writeFile(file, JSON.stringify(evidence));
    const result = await inspectBackupReadiness(local, undefined, null);
    expect(result.latestRestore).toBeNull();
    expect(result.backups[0]).toMatchObject({
      restoredAt: null, restoreFailure: { code: "KEY_REQUIRED", at: restoredAt }, attachmentCheck: null,
    });

    await writeFile(file, JSON.stringify({ ...evidence, sourceAfter: fingerprint("changed") }));
    const changed = await inspectBackupReadiness(local, undefined, null);
    expect(changed.backups[0].restoreFailure).toBeNull();
  });

  it("only publishes consistent attachment counts bound to a successful SQL drill", async () => {
    await writeCopy(local, backup);
    const file = path.join(reports, backup + ".restore.json");
    const attachmentCheck = {
      scope: "KNOWN_FILE_REFERENCES_V1", references: 7, inlineVerified: 2, mirroredVerified: 1,
    };
    const evidence = {
      status: "SQL_RESTORED_CORE_READS_PASSED", productionContact: false, stopped: true,
      finishedAt: restoredAt, sourceBefore: fingerprint(encrypted), sourceAfter: fingerprint(encrypted),
      sqlFingerprint: fingerprint(sql), attachmentCheck: { ...attachmentCheck, privatePath: "not published" },
    };
    await writeFile(file, JSON.stringify(evidence));
    const result = await inspectBackupReadiness(local, undefined, null);
    expect(result.backups[0].attachmentCheck).toEqual(attachmentCheck);

    await writeFile(file, JSON.stringify({
      ...evidence, attachmentCheck: { ...attachmentCheck, mirroredVerified: 8 },
    }));
    const inconsistent = await inspectBackupReadiness(local, undefined, null);
    expect(inconsistent.backups[0]).toMatchObject({ restoredAt, attachmentCheck: null });
  });

  it("binds an owner exercise to its archive, checks rollback evidence, and preserves incomplete attachment status", async () => {
    await writeCopy(offsite, backup);
    const archive = await resolveRecordedArchive(local, offsite, backup + ".gpg");
    if (!archive) throw Error("Expected recorded test archive");
    const lease = "123:00000000-0000-0000-0000-000000000001";
    const attempt = { version: 1 as const, file: backup, source: fingerprint(encrypted), lease, startedAt };
    await writeRestoreDrillAttempt(local, { ...attempt, finishedAt: null, result: null });
    const running = await inspectBackupReadiness(local, offsite, null, lease);
    expect(running.backups[0].drill?.status).toBe("RUNNING");
    const interrupted = await inspectBackupReadiness(local, offsite, null);
    expect(interrupted.backups[0].drill?.status).toBe("INTERRUPTED");
    const proof = {
      status: "SQL_RESTORED_CORE_READS_PASSED", productionContact: false, stopped: true,
      screenExercise: true, candidateRemoved: true, encryptedBackup: "GPG_AUTHENTICATED_DECRYPTION_PASSED",
      finishedAt, sourceBefore: fingerprint(encrypted), sourceAfter: fingerprint(encrypted), sqlFingerprint: fingerprint(sql),
      tableCount: 9, rowCounts: { users: 1, branches: 2, invoices: 3, products: 4 },
      rollback: { status: "VERIFIED", trigger: "INJECTED_HEALTH_FAILURE" },
      attachmentCheck: { scope: "KNOWN_FILE_REFERENCES_V1", references: 2, inlineVerified: 1, mirroredVerified: 0 },
    };
    const result = summarizeRestoreDrill(proof, archive.manifest, true);
    expect(result.status).toBe("PARTIAL");
    expect(summarizeRestoreDrill({ ...proof, rollback: undefined }, archive.manifest, true).status).toBe("FAILED");
    expect(summarizeRestoreDrill({ ...proof, sourceAfter: fingerprint("other") }, archive.manifest, true))
      .toEqual({ status: "FAILED", code: "ARCHIVE_INVALID" });
    await writeRestoreDrillAttempt(local, { ...attempt, finishedAt, result });
    const done = await inspectBackupReadiness(local, offsite, null);
    expect(done.backups[0]).toMatchObject({ restoredAt: finishedAt, drill: { status: "PARTIAL", tableCount: 9 } });
    expect(done.latestRestore).toEqual({ name: backup, at: finishedAt });
    await writeCopy(offsite, backup, "replacement archive");
    const replaced = await inspectBackupReadiness(local, offsite, null);
    expect(replaced.backups[0]).toMatchObject({ restoredAt: null, drill: null });
  });

  it("returns the file identified by its own backup process when a second backup is also published", async () => {
    const other = "erp-concurrent.sql";
    await Promise.all([
      writeFile(path.join(local, backup), sql),
      writeFile(path.join(local, other), sql),
      writeAttempt(local, backup, "COMPLETED"),
      writeAttempt(local, other, "COMPLETED", "2026-11-10T00:04:00.000Z"),
    ]);
    execBackup.mockResolvedValue({ stdout: "informational text\nERP_BACKUP_RESULT: " + backup + "\r\n" });
    await expect(runBackup()).resolves.toMatchObject({ name: backup, createdAt: startedAt });
    expect(execBackup).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["--print-receipt"]), expect.any(Object));
  });

  it("fails explicitly without a completed receipt for the reported file, even if older SQL exists", async () => {
    await writeFile(path.join(local, backup), sql);
    await writeAttempt(local, backup, "FAILED");
    execBackup.mockResolvedValueOnce({ stdout: "no receipt" })
      .mockResolvedValueOnce({ stdout: "ERP_BACKUP_RESULT: " + backup });
    await expect(runBackup()).rejects.toThrow("تعذّر إثبات");
    await expect(runBackup()).rejects.toThrow("تعذّر إثبات");
  });

  it("restores recorded ciphertext through the SQL executor and clears the temporary plaintext", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "mysql://unused@127.0.0.1:1/owner_archive_test");
    vi.stubEnv("BACKUP_GPG_PASSPHRASE", "synthetic-key");
    vi.stubEnv("BACKUP_OFFSITE_DIR", offsite);
    await writeCopy(offsite, backup);
    const name = backup + ".gpg";
    const archive = path.join(offsite, name);
    await expect(resolveStoredRestoreFile(name)).resolves.toBe(archive);
    await expect(resolveStoredRestoreFile("../" + name)).resolves.toBeNull();
    let sqlFile = "";
    execBackup.mockImplementationOnce(async (_exe, [script, input, output, flag]) => {
      expect(path.basename(script)).toBe("decrypt-restore-archive.mjs");
      expect(input).toBe(archive);
      expect(flag).toBe("--require-manifest");
      sqlFile = output;
      await writeFile(output, sql);
      return { stdout: "" };
    }).mockImplementationOnce(async (_exe, [script, input, confirm, value]) => {
      expect(path.basename(script)).toBe("restore.mjs");
      expect([input, confirm, value]).toEqual([sqlFile, "--confirm", "RESTORE"]);
      await expect(readFile(input, "utf8")).resolves.toBe(sql);
      return { stdout: "" };
    });

    await runRestore(archive);
    expect(execBackup).toHaveBeenCalledTimes(2);
    await expect(readFile(sqlFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(archive, "utf8")).resolves.toBe(encrypted);
  });

  it("removes partial plaintext and never imports SQL when decryption fails", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "mysql://unused@127.0.0.1:1/owner_archive_test");
    vi.stubEnv("BACKUP_GPG_PASSPHRASE", "wrong-synthetic-key");
    let sqlFile = "";
    execBackup.mockImplementationOnce(async (_exe, [, , output]) => {
      sqlFile = output;
      await writeFile(output, "partial SQL");
      throw Object.assign(new Error("decryption failed"), { stderr: "BACKUP_RESTORE_DECRYPTION_FAILED" });
    });
    await expect(runRestore(path.join(local, backup + ".gpg"))).rejects.toThrow("تعذّر تجهيز النسخة المشفّرة");
    expect(execBackup).toHaveBeenCalledTimes(1);
    await expect(readFile(sqlFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a loopback database and the local key before preparing ciphertext", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const archive = path.join(local, backup + ".gpg");
    vi.stubEnv("DATABASE_URL", "mysql://unused@remote.invalid:1/owner_archive_test");
    vi.stubEnv("BACKUP_GPG_PASSPHRASE", "synthetic-key");
    await expect(runRestore(archive)).rejects.toThrow("MySQL");
    vi.stubEnv("DATABASE_URL", "mysql://unused@127.0.0.1:1/owner_archive_test");
    vi.stubEnv("BACKUP_GPG_PASSPHRASE", undefined);
    await expect(runRestore(archive)).rejects.toThrow("GPG");
    expect(execBackup).not.toHaveBeenCalled();
  });

  it("blocks the restore executor in production without starting a subprocess", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(runRestore(path.join(local, backup))).rejects.toBeInstanceOf(OnlineMaintenanceBlockedError);
    await expect(startRestoreDrill(backup)).rejects.toBeInstanceOf(OnlineMaintenanceBlockedError);
    expect(execBackup).not.toHaveBeenCalled();
  });

  it("isolates hyphenated tenant DB prefixes, accepts +00:00 timestamps, and enforces RPO/owner guards on entry retirement", async () => {
    const b1 = "erp-2026-11-25T12-00-00-000Z-11111111.sql";
    const b2 = "erp-2026-11-25T10-00-00-000Z-22222222.sql";
    const b3 = "erp-2026-11-25T08-00-00-000Z-33333333.sql";
    const b4Old = "erp-2026-11-24T08-00-00-000Z-44444444.sql";
    const otherTenant = "erp-baghdad-2026-11-25T12-30-00-000Z-99999999.sql";
    const failedRow = "erp-2026-11-25T07-00-00-000Z-ffffffff.sql";

    for (const n of [b1, b2, b3, b4Old, otherTenant]) {
      await writeCopy(local, n);
      await writeCopy(offsite, n);
    }
    await writeAttempt(local, failedRow, "FAILED");
    await writeFile(path.join(reports, "latest-verified-restore.json"), JSON.stringify({
      version: 1,
      name: otherTenant,
      at: "2026-11-25T11:30:00+00:00",
      byDatabase: {
        erp: { name: b4Old, at: "2026-11-24T09:15:00+00:00" },
        "erp-baghdad": { name: otherTenant, at: "2026-11-25T11:30:00+00:00" },
      },
    }));

    const scoped = await inspectBackupReadiness(local, offsite, "erp-");
    expect(scoped.encryptedCount).toBe(4);
    expect(scoped.backups.map((r) => r.name)).not.toContain(otherTenant);
    expect(scoped.latestRestore).toEqual({ name: b4Old, at: "2026-11-24T09:15:00+00:00" });

    // Admin can immediately clean orphan FAILED attempt
    await expect(deleteBackup(failedRow, { scope: "entry", isOwner: false })).resolves.toBe(true);

    // Non-owner cannot retire a verified encrypted archive
    await expect(deleteBackup(b4Old, { scope: "entry", isOwner: false, passwordVerified: true }))
      .rejects.toBeInstanceOf(BackupDeleteGuardError);

    // Even Owner with password cannot retire any of the 3 newest verified encrypted backups
    await expect(deleteBackup(b1, { scope: "entry", isOwner: true, passwordVerified: true }))
      .rejects.toBeInstanceOf(BackupDeleteGuardError);

    // Owner WITH password CAN soft-retire the 4th archive; row disappears even though offsite copy remains!
    await expect(deleteBackup(b4Old, { scope: "entry", isOwner: true, passwordVerified: true, actorId: 1 }))
      .resolves.toBe(true);
    const afterRetire = await inspectBackupReadiness(local, offsite, "erp-");
    expect(afterRetire.backups.map((r) => r.name)).not.toContain(b4Old);
    expect(afterRetire.encryptedCount).toBe(3);

    // Now only 3 verified archives remain: floor guard blocks retiring any more
    await expect(deleteBackup(b3, { scope: "entry", isOwner: true, passwordVerified: true }))
      .rejects.toBeInstanceOf(BackupDeleteGuardError);
  });

  it("sorts mixed timezone offset timestamps chronologically before computing protectedRecent and delete guards", async () => {
    const newestUtc = "erp-2026-11-25T10-00-00-000Z-aaaa1111.sql";
    const secondUtc = "erp-2026-11-25T09-45-00-000Z-aaaa2222.sql";
    const thirdUtc = "erp-2026-11-25T09-30-00-000Z-aaaa3333.sql";
    // 12:00:00+03:00 equals 09:00:00Z (older than all three above, even though "12:" > "10:" lexicographically!)
    const olderPlus3 = "erp-2026-11-25T09-00-00-000Z-aaaa4444.sql";

    for (const n of [newestUtc, secondUtc, thirdUtc, olderPlus3]) {
      await writeCopy(local, n);
    }
    await writeFile(path.join(local, `${newestUtc}.attempt.json`), JSON.stringify({
      version: 1, file: newestUtc, status: "COMPLETED", startedAt: "2026-11-25T10:00:00Z", finishedAt: "2026-11-25T10:01:00Z",
    }));
    await writeFile(path.join(local, `${secondUtc}.attempt.json`), JSON.stringify({
      version: 1, file: secondUtc, status: "COMPLETED", startedAt: "2026-11-25T09:45:00Z", finishedAt: "2026-11-25T09:46:00Z",
    }));
    await writeFile(path.join(local, `${thirdUtc}.attempt.json`), JSON.stringify({
      version: 1, file: thirdUtc, status: "COMPLETED", startedAt: "2026-11-25T09:30:00Z", finishedAt: "2026-11-25T09:31:00Z",
    }));
    await writeFile(path.join(local, `${olderPlus3}.attempt.json`), JSON.stringify({
      version: 1, file: olderPlus3, status: "COMPLETED", startedAt: "2026-11-25T12:00:00+03:00", finishedAt: "2026-11-25T12:01:00+03:00",
    }));

    const readiness = await inspectBackupReadiness(local, undefined, "erp-");
    expect(readiness.backups.map((r) => r.name)).toEqual([newestUtc, secondUtc, thirdUtc, olderPlus3]);
    expect(readiness.latestAttempt?.file).toBe(newestUtc);
    expect(readiness.backups.find((r) => r.name === thirdUtc)?.protectedRecent).toBe(true);
    expect(readiness.backups.find((r) => r.name === olderPlus3)?.protectedRecent).toBe(false);

    // Chronologically third-newest UTC archive is protected, whereas older +03:00 archive can be retired by Owner
    await expect(deleteBackup(thirdUtc, { scope: "entry", isOwner: true, passwordVerified: true }))
      .rejects.toBeInstanceOf(BackupDeleteGuardError);
    await expect(deleteBackup(olderPlus3, { scope: "entry", isOwner: true, passwordVerified: true, actorId: 1 }))
      .resolves.toBe(true);
  });
});
