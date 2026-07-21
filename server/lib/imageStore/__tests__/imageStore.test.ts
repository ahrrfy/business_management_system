import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { contentHash, extForMime, objectKeyFor, shortHash } from "../contentAddress";
import { FsImageStore } from "../fsStore";

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
});
