import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectBackupReadiness } from "../../lib/backupEvidence";
import { OnlineMaintenanceBlockedError, runBackup, runRestore } from "../maintenanceService";

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
