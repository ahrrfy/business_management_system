import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { R2_GC_DELETE_CONFIRMATION, loadR2GcDeletionAuthorization } from "../r2RetentionPolicy";

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
  assertMirrorPrefix,
  createRestoreDrill,
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
    const coldRoot = resolve(tmpdir(), "cold-r2");
    expect(resolveMirrorObjectPath(coldRoot, "single/studio/candidate/aa/file.png"))
      .toMatch(/cold-r2[\\/]objects[\\/]single[\\/]studio/);
    expect(() => resolveMirrorObjectPath(coldRoot, "../escape")).toThrow(/MIRROR_KEY_INVALID/);
    expect(() => resolveMirrorObjectPath(coldRoot, "single//file.png")).toThrow(/MIRROR_KEY_INVALID/);
    expect(() => assertMirrorPrefix("single/studio/")).not.toThrow();
    expect(() => assertMirrorPrefix("company-")).not.toThrow();
    expect(() => assertMirrorPrefix("company-*/studio/")).toThrow(/MIRROR_PREFIX_INVALID/);
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

  it("ينفذ restore drill فعلياً إلى وجهة مستقلة ويصدر إيصالاً مربوطاً ببصمة manifest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "r2-restore-drill-"));
    mirrorRoots.push(parent);
    const mirrorRoot = join(parent, "cold-mirror");
    const destinationRoot = join(parent, "independent-target");
    const bytes = Buffer.from("recoverable-cold-object");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const key = `company-42/studio/candidate/${hash.slice(0, 2)}/${hash}.png`;
    const objectPath = resolveMirrorObjectPath(mirrorRoot, key);
    await mkdir(join(objectPath, ".."), { recursive: true });
    await writeFile(objectPath, bytes);
    const manifest = {
      format: MIRROR_MANIFEST_FORMAT,
      completedAt: "2026-08-18T00:00:00.000Z",
      sourcePrefix: "company-",
      sourceScopeSha256: "c".repeat(64),
      entries: {
        [key]: {
          sha256: hash,
          bytes: bytes.length,
          sourcePresent: true,
          lastSeenAt: "2026-08-18T00:00:00.000Z",
          verifiedAt: "2026-08-18T00:00:00.000Z",
        },
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(join(mirrorRoot, "manifest.json"), manifestBytes);

    const result = await createRestoreDrill({
      mirrorRoot,
      destinationRoot,
      now: new Date("2026-08-18T12:00:00.000Z"),
      drillId: "11111111-1111-4111-8111-111111111111",
      sampleLimit: 1,
    });
    expect(result.manifestSha256).toBe(createHash("sha256").update(manifestBytes).digest("hex"));
    expect(result.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.restored).toBe(1);
    const receipt = JSON.parse(await readFile(join(destinationRoot, "receipt.json"), "utf8"));
    expect(receipt).toMatchObject({
      format: "alroya-r2-restore-drill/v1",
      manifestSha256: result.manifestSha256,
      sourcePrefix: "company-",
      destination: { entries: [{ key, sha256: hash, bytes: bytes.length }] },
    });
    expect(await readFile(join(destinationRoot, "objects", ...key.split("/")))).toEqual(bytes);
    const authorization = await loadR2GcDeletionAuthorization({
      R2_GC_MODE: "delete",
      R2_GC_DELETE_CONFIRM: R2_GC_DELETE_CONFIRMATION,
      R2_GC_MIRROR_MANIFEST: join(mirrorRoot, "manifest.json"),
      R2_GC_MIRROR_MANIFEST_SHA256: result.manifestSha256,
      R2_GC_DR_RECEIPT: join(destinationRoot, "receipt.json"),
      R2_GC_DR_RECEIPT_SHA256: result.receiptSha256,
    }, new Date("2026-08-18T12:00:01.000Z"), "company-42/studio/");
    expect(() => authorization.authorize(key)).not.toThrow();

    await expect(createRestoreDrill({
      mirrorRoot,
      destinationRoot: join(mirrorRoot, "nested-destination"),
      now: new Date("2026-08-18T12:00:00.000Z"),
      drillId: "22222222-2222-4222-8222-222222222222",
      sampleLimit: 1,
    })).rejects.toMatchObject({ code: "MIRROR_DR_DESTINATION_NOT_INDEPENDENT" });
  });
});
