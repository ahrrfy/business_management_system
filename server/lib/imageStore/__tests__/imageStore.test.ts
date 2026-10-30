import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { contentHash, extForMime, objectKeyFor, shortHash } from "../contentAddress";
import { FsImageStore } from "../fsStore";
import { assertImageStoreStartupConfiguration } from "../index";

describe("ImageStore startup contract", () => {
  const validR2 = {
    NODE_ENV: "production",
    IMAGE_STORE_DRIVER: "r2",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_IMAGE_BUCKET: "erp-private-media",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
  } satisfies NodeJS.ProcessEnv;

  it("يسمح ببقاء التخزين القديم ما دام سائق R2 غير مفعّل صراحةً", () => {
    expect(() => assertImageStoreStartupConfiguration({ NODE_ENV: "production" })).not.toThrow();
  });

  it("يفشل عند الإقلاع إذا فُعّل R2 باعتماد ناقص ويقبل العقد الكامل", () => {
    expect(() => assertImageStoreStartupConfiguration({ NODE_ENV: "production", IMAGE_STORE_DRIVER: "r2" }))
      .toThrow(/R2_ACCOUNT_ID/);
    expect(() => assertImageStoreStartupConfiguration(validR2)).not.toThrow();
  });

  it("يفشل عند الإقلاع إذا كانت حدود R2 غير صحيحة بدلاً من حد غير مقصود", () => {
    expect(() => assertImageStoreStartupConfiguration({ ...validR2, R2_MAX_CONCURRENCY: "0" }))
      .toThrow(/R2_MAX_CONCURRENCY/);
    expect(() => assertImageStoreStartupConfiguration({ ...validR2, R2_MAX_QUEUE: "100000" }))
      .toThrow(/R2_MAX_QUEUE/);
  });

  it("يرفض fs والسائق المجهول في الإنتاج", () => {
    expect(() => assertImageStoreStartupConfiguration({ NODE_ENV: "production", IMAGE_STORE_DRIVER: "fs" }))
      .toThrow(/محظور في الإنتاج/);
    expect(() => assertImageStoreStartupConfiguration({ NODE_ENV: "production", IMAGE_STORE_DRIVER: "unknown" }))
      .toThrow(/fs أو r2/);
  });
});

describe("contentAddress", () => {
  it("contentHash حتميّ وبطول ٦٤ hex ويتغيّر بتغيّر البايتات", () => {
    const h = contentHash(Buffer.from("مرحبا"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(Buffer.from("مرحبا"))).toBe(h);
    expect(contentHash(Buffer.from("أخرى"))).not.toBe(h);
  });

  it("shortHash = أوّل ١٦ محرفاً", () => {
    expect(shortHash("a".repeat(64))).toBe("a".repeat(16));
  });

  it("extForMime + objectKeyFor بالشكل المنطَّق بالشركة والمشظّى", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/PNG")).toBe("png");
    expect(extForMime("image/unknown")).toBe("bin");
    const h = "ab" + "c".repeat(62);
    expect(objectKeyFor(h, "image/webp", "co7")).toBe(`co7/p/ab/${h}.webp`);
    expect(objectKeyFor(h, "image/jpeg")).toBe(`default/p/ab/${h}.jpg`);
  });
});

describe("FsImageStore", () => {
  const root = path.join(os.tmpdir(), `imgstore-test-${process.pid}`);
  const store = new FsImageStore(root);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("put متعادِل + head + getStream + delete", async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const key = "co/p/ab/deadbeef.png";

    const r1 = await store.put(key, bytes, "image/png");
    expect(r1).toMatchObject({ key, bytes: 5, existed: false });
    const r2 = await store.put(key, bytes, "image/png"); // متعادِل — لا كتابة فوقية
    expect(r2.existed).toBe(true);

    expect(await store.head(key)).toEqual({ exists: true, bytes: 5 });
    expect(await store.head("co/p/zz/missing.png")).toEqual({ exists: false });

    const stream = await store.getStream(key);
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(await store.getStream("co/p/zz/missing.png")).toBeNull();

    await store.delete(key);
    expect((await store.head(key)).exists).toBe(false);
    await store.delete(key); // متعادِل — لا يرمي على غياب
  });

  it("يرفض المفاتيح الخارجة عن الجذر (path traversal)", async () => {
    await expect(store.put("../evil.png", Buffer.from([0]), "image/png")).rejects.toThrow();
  });

  it("publishes concurrent identical puts after both observe an absent object", async () => {
    const key = "concurrent/image.png";
    const bytes = Buffer.from([1, 2, 3]);
    let observations = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const head = store.head.bind(store);
    vi.spyOn(store, "head").mockImplementation(async target => {
      const result = await head(target);
      if (++observations === 2) release();
      await barrier;
      return result;
    });

    const results = await Promise.all([
      store.put(key, bytes, "image/png"),
      store.put(key, bytes, "image/png"),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every(result => result.key === key && result.bytes === bytes.length)).toBe(true);
    expect(await fs.readFile(path.join(root, key))).toEqual(bytes);
    expect(await fs.readdir(path.join(root, "concurrent"))).toEqual(["image.png"]);
  });

  it.each(["EPERM", "EEXIST"])("accepts %s only after verifying identical published bytes", async code => {
    const key = `published-${code}/image.png`;
    const bytes = Buffer.from([4, 5, 6]);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (_source, destination) => {
      await fs.writeFile(destination, bytes);
      throw Object.assign(new Error("competing publication"), { code });
    });

    await expect(store.put(key, bytes, "image/png"))
      .resolves.toEqual({ key, bytes: bytes.length, existed: true });
    expect(await fs.readdir(path.dirname(path.join(root, key)))).toEqual(["image.png"]);
  });

  it.each(["missing", "different", "unreadable", "other-error"])(
    "preserves publication errors for %s destinations and removes its own temporary file",
    async scenario => {
      const key = `failed-${scenario}/image.png`;
      const bytes = Buffer.from([7, 8, 9]);
      const failure = Object.assign(new Error("publication failed"), {
        code: scenario === "other-error" ? "EIO" : "EPERM",
      });
      vi.spyOn(fs, "rename").mockImplementationOnce(async (_source, destination) => {
        if (scenario === "unreadable") await fs.mkdir(destination);
        else if (scenario !== "missing") {
          await fs.writeFile(destination, scenario === "different" ? Buffer.from([9, 8, 7]) : bytes);
        }
        throw failure;
      });

      await expect(store.put(key, bytes, "image/png")).rejects.toBe(failure);
      expect(await fs.readdir(path.dirname(path.join(root, key))))
        .toEqual(scenario === "missing" ? [] : ["image.png"]);
      if (scenario === "different") expect(await fs.readFile(path.join(root, key))).toEqual(Buffer.from([9, 8, 7]));
    },
  );

  it.each(["failed-publication", "verified-duplicate"])(
    "preserves %s when removing its temporary file fails",
    async scenario => {
      const key = `cleanup-${scenario}/image.png`;
      const bytes = Buffer.from([10, 11, 12]);
      const publicationFailure = Object.assign(new Error("publication failed"), { code: "EPERM" });
      const cleanupFailure = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      const cleanup = vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupFailure);
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      vi.spyOn(fs, "rename").mockImplementationOnce(async (_source, destination) => {
        if (scenario === "verified-duplicate") await fs.writeFile(destination, bytes);
        throw publicationFailure;
      });

      const publication = store.put(key, bytes, "image/png");
      if (scenario === "verified-duplicate") {
        await expect(publication).resolves.toEqual({ key, bytes: bytes.length, existed: true });
        expect(await fs.readFile(path.join(root, key))).toEqual(bytes);
      } else {
        await expect(publication).rejects.toBe(publicationFailure);
      }
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(expect.any(String), { force: true });
      const temporaryPath = String(cleanup.mock.calls[0][0]);
      expect(temporaryPath.startsWith(`${path.join(root, key)}.tmp-`)).toBe(true);
      expect(path.basename(temporaryPath)).toMatch(/\.tmp-[\da-f-]{36}$/);
      expect(await fs.readFile(temporaryPath)).toEqual(bytes);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`${temporaryPath}: ${String(cleanupFailure)}`),
        { code: "IMAGE_STORE_TEMP_CLEANUP_FAILED" },
      );
    },
  );
});
