import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectBackupReadiness } from "../../lib/backupEvidence";
import { OnlineMaintenanceBlockedError, resolveStoredRestoreFile, runBackup, runRestore } from "../maintenanceService";

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

  it.each([
    { mode: "production", control: undefined },
    { mode: "development", control: "mysql://unused@127.0.0.1/control" },
  ])("blocks the restore executor without starting a subprocess ($mode, $control)", async ({ mode, control }) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("CONTROL_DATABASE_URL", control);
    await expect(runRestore(path.join(local, backup))).rejects.toBeInstanceOf(OnlineMaintenanceBlockedError);
    expect(execBackup).not.toHaveBeenCalled();
  });
});
