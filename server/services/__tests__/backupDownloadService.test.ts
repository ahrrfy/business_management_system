import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBackupDownload } from "../backupDownloadService";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

describe("private backup download snapshots", () => {
  let directory: string;
  const actor = { userId: 7, companyId: 2 };
  const name = "erp-backup.sql";
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "erp-download-cache-test-"));
    await writeFile(path.join(directory, name), "-- complete SQL\n");
  });
  afterEach(async () => {
    // Only the absolute mkdtemp directory owned by this test is removed.
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error("unsafe test path");
    await rm(directory, { recursive: true, force: true });
  });
  const request = (directory: string) => ({
    directory,
    name,
    ...actor,
    sourcePath: path.join(directory, name),
  });
  it("reclaims an expired interrupted allocation without extending its age", async () => {
    const cache = path.join(directory, ".download-cache");
    await mkdir(cache);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (let i = 0; i < 16; i++) {
      const slot = path.join(cache, String(i).padStart(2, "0"));
      await mkdir(slot);
      await writeFile(
        path.join(slot, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sql"),
        "-- orphaned pin",
      );
      await utimes(slot, old, old);
    }
    const snapshot = await getBackupDownload(request(directory));
    expect(await readFile(snapshot.path, "utf8")).toBe("-- complete SQL\n");
  });

  it("survives source rotation and a fresh worker without recopying SQL", async () => {
    const first = await getBackupDownload(request(directory));
    await unlink(path.join(directory, name));
    const resumed = await getBackupDownload({
      directory,
      name,
      ...actor,
      downloadId: first.id,
    });
    expect(resumed.id).toBe(first.id);
    expect(await readFile(resumed.path, "utf8")).toBe("-- complete SQL\n");
    expect(resumed.size).toBe(16);
  });
  it("binds the snapshot to the original user, tenant and name", async () => {
    const first = await getBackupDownload(request(directory));
    for (const mismatch of [
      { userId: 8 },
      { companyId: 3 },
      { name: "other.sql" },
    ]) {
      await expect(
        getBackupDownload({
          directory,
          name,
          ...actor,
          downloadId: first.id,
          ...mismatch,
        }),
      ).rejects.toThrow();
    }
    await expect(
      getBackupDownload({
        directory,
        name,
        ...actor,
        downloadId: "../outside",
      }),
    ).rejects.toThrow();
  });
  it("reuses the same source and bounds allocation without evicting a live snapshot", async () => {
    const first = await getBackupDownload(request(directory));
    expect((await getBackupDownload(request(directory))).id).toBe(first.id);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        getBackupDownload({ ...request(directory), userId: i + 20 }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled").length,
    ).toBeLessThanOrEqual(15);
    expect(
      (
        await getBackupDownload({
          directory,
          name,
          ...actor,
          downloadId: first.id,
        })
      ).id,
    ).toBe(first.id);
    expect(
      (await readdir(path.join(directory, ".download-cache"))).length,
    ).toBeLessThanOrEqual(16);
  });
  it("expires snapshots after 24 hours and rejects symbolic-link sources", async () => {
    const first = await getBackupDownload(request(directory), 1000);
    await expect(
      getBackupDownload(
        { directory, name, ...actor, downloadId: first.id },
        1000 + 86400001,
      ),
    ).rejects.toThrow();
    // Junction/symlink creation is platform dependent; the source guard is also tested by the HTTP suite.
    if (process.platform !== "win32") {
      const link = path.join(directory, "linked.sql");
      await symlink(path.join(directory, name), link);
      await expect(
        getBackupDownload({
          ...request(directory),
          name: "linked.sql",
          sourcePath: link,
        }),
      ).rejects.toThrow();
    }
  });
  it("never expires a new generation using another worker's stale observation", async () => {
    const old = await getBackupDownload(request(directory), 1000);
    const native =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let newer: Awaited<ReturnType<typeof getBackupDownload>> | undefined;
    let interleaved = false;
    vi.mocked(mkdir).mockImplementation(async (target, options) => {
      if (
        String(target) === path.join(path.dirname(old.path), ".cleanup") &&
        !interleaved
      ) {
        interleaved = true;
        newer = await getBackupDownload(
          { ...request(directory), userId: 8 },
          1000 + 86400001,
        );
      }
      return native.mkdir(
        target,
        options as Parameters<typeof native.mkdir>[1],
      );
    });
    try {
      await getBackupDownload(
        { ...request(directory), userId: 9 },
        1000 + 86400001,
      );
      expect(newer).toBeDefined();
      expect(await readFile(newer!.path, "utf8")).toBe("-- complete SQL\n");
      expect(newer!.path).not.toBe(old.path);
      // A path returned to an old response can fail closed, never open a new owner's SQL.
      await expect(readFile(old.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.mocked(mkdir).mockImplementation(native.mkdir);
    }
  });
  it("preserves a new worker's empty reservation during stale expiry", async () => {
    const old = await getBackupDownload(request(directory), 1000);
    const slot = path.dirname(old.path);
    const native =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let replaced = false;
    vi.mocked(mkdir).mockImplementation(async (target, options) => {
      if (String(target) === path.join(slot, ".cleanup") && !replaced) {
        replaced = true;
        await native.unlink(old.path);
        await native.unlink(path.join(slot, "snapshot.json"));
        await native.rmdir(slot);
        await native.mkdir(slot);
      }
      return native.mkdir(
        target,
        options as Parameters<typeof native.mkdir>[1],
      );
    });
    try {
      const next = await getBackupDownload(
        { ...request(directory), userId: 8 },
        1000 + 86400001,
      );
      expect(path.dirname(next.path)).not.toBe(slot);
      expect(await readdir(slot)).toEqual([]);
    } finally {
      vi.mocked(mkdir).mockImplementation(native.mkdir);
    }
  });
});
