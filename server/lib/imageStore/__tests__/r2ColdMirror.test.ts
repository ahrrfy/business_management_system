import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const cliUrl = new globalThis.URL("../../../../scripts/r2-cold-mirror.mjs", import.meta.url);
const moduleDir = await mkdtemp(join(tmpdir(), "r2-mirror-vitest-"));
const modulePath = join(moduleDir, "r2-cold-mirror.mjs");
const source = (await readFile(fileURLToPath(cliUrl), "utf8"))
  .replace(/^#![^\r\n]*(?:\r?\n|$)/, "")
  .replace(/\r\n/g, "\n");
await writeFile(modulePath, source, "utf8");
afterAll(() => rm(moduleDir, { recursive: true, force: true }));
const mirrorRoots: string[] = [];
afterEach(async () => {
  await Promise.all(mirrorRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const {
  MIRROR_MANIFEST_FORMAT,
  assertMirrorManifestCoversSource,
  mergeCumulativeMirrorEntries,
  resolveMirrorObjectPath,
  safeMirrorFailureCode,
  verifyCumulativeMirrorFiles,
} = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);

describe("R2 cumulative cold mirror", () => {
  it("يبقي الكائنات التي اختفت من المصدر ولا يحول copy إلى sync", () => {
    const previous = {
      "single/p/aa/old.png": {
        sha256: "a".repeat(64),
        bytes: 10,
        sourcePresent: true,
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        verifiedAt: "2026-08-01T00:00:00.000Z",
      },
    };
    const verified = [{
      key: "single/p/bb/new.png",
      sha256: "b".repeat(64),
      bytes: 20,
    }];
    expect(mergeCumulativeMirrorEntries(previous, verified, "2026-08-18T00:00:00.000Z")).toEqual({
      "single/p/aa/old.png": expect.objectContaining({ sourcePresent: false }),
      "single/p/bb/new.png": expect.objectContaining({
        sourcePresent: true,
        sha256: "b".repeat(64),
        lastSeenAt: "2026-08-18T00:00:00.000Z",
        verifiedAt: "2026-08-18T00:00:00.000Z",
      }),
    });
    expect(MIRROR_MANIFEST_FORMAT).toBe("alroya-r2-cold-mirror/v1");
  });

  it("يحصر كل مفتاح داخل objects ويرفض traversal والمفاتيح الملتبسة", () => {
    expect(resolveMirrorObjectPath("C:/cold-r2", "single/studio/candidate/aa/file.png"))
      .toMatch(/cold-r2[\\/]objects[\\/]single[\\/]studio/);
    expect(() => resolveMirrorObjectPath("C:/cold-r2", "../escape")).toThrow(/MIRROR_KEY_INVALID/);
    expect(() => resolveMirrorObjectPath("C:/cold-r2", "single//file.png")).toThrow(/MIRROR_KEY_INVALID/);
  });

  it("لا يعيد تفاصيل المزوّد أو المسارات في رمز الفشل", () => {
    expect(safeMirrorFailureCode(Object.assign(new Error("secret C:/cold-r2"), { code: "MIRROR_GET_FAILED" })))
      .toBe("MIRROR_GET_FAILED");
    expect(safeMirrorFailureCode(new Error("secret C:/cold-r2"))).toBe("MIRROR_UNEXPECTED_FAILURE");
  });

  it("يتحقق من كل ملفات manifest بما فيها النسخ التي اختفت من المصدر", async () => {
    const root = await mkdtemp(join(tmpdir(), "r2-mirror-root-"));
    mirrorRoots.push(root);
    const oldKey = "single/studio/original/aa/old.png";
    const newKey = "single/studio/candidate/bb/new.png";
    const oldBytes = Buffer.from("old-retained-copy");
    const newBytes = Buffer.from("new-source-copy");
    for (const [key, bytes] of [[oldKey, oldBytes], [newKey, newBytes]] as const) {
      const path = resolveMirrorObjectPath(root, key);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, bytes);
    }
    const entries = {
      [oldKey]: {
        sha256: createHash("sha256").update(oldBytes).digest("hex"),
        bytes: oldBytes.length,
        sourcePresent: false,
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        verifiedAt: "2026-08-18T00:00:00.000Z",
      },
      [newKey]: {
        sha256: createHash("sha256").update(newBytes).digest("hex"),
        bytes: newBytes.length,
        sourcePresent: true,
        lastSeenAt: "2026-08-18T00:00:00.000Z",
        verifiedAt: "2026-08-18T00:00:00.000Z",
      },
    };
    await expect(verifyCumulativeMirrorFiles(root, entries)).resolves.toBe(2);
    await writeFile(resolveMirrorObjectPath(root, oldKey), Buffer.from("corrupted"));
    await expect(verifyCumulativeMirrorFiles(root, entries)).rejects.toMatchObject({
      code: "MIRROR_LOCAL_HASH_MISMATCH",
    });
  });

  it("يجعل verify يفشل إذا ظهر كائن مصدر لم تسجله آخر عملية copy", () => {
    const item = { key: "single/studio/candidate/aa/new.png", sha256: "a".repeat(64), bytes: 10 };
    expect(() => assertMirrorManifestCoversSource({}, [item])).toThrow(/MIRROR_MANIFEST_STALE/);
    expect(() => assertMirrorManifestCoversSource({
      [item.key]: {
        sha256: item.sha256,
        bytes: item.bytes,
        sourcePresent: true,
        lastSeenAt: "2026-08-18T00:00:00.000Z",
        verifiedAt: "2026-08-18T00:00:00.000Z",
      },
    }, [item])).not.toThrow();
  });
});
