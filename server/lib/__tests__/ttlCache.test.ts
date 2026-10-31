/** اختبارات كاش TTL أحادي الرحلة (فحص معمارية الحمل ٣٠/٨/٢٦). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtlCache } from "../ttlCache";

describe("bounded pending cache opt-in", () => {
  it("SF-02 bounds 32 distinct keys before loader and keeps same-key dedupe", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 1000, maxEntries: 2, maxInFlight: 2 });
    let started = 0; let finish!: (n: number) => void;
    const hold = new Promise<number>((resolve) => { finish = resolve; });
    const loader = () => { started++; return hold; };
    const requests = Array.from({ length: 32 }, (_, n) => cache.get(String(n), loader));
    const same = cache.get("0", loader);
    const settled = Promise.allSettled(requests);
    expect(started).toBe(2); expect(cache.snapshot().inFlight).toBe(2);
    finish(7);
    expect(await same).toBe(7);
    const outcomes = await settled;
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(cache.snapshot().inFlight).toBe(0);
  });
  it.each(["invalidate", "clear"] as const)("%s retains old occupancy, never returns invalidated pending data", async (method) => {
    const cache = createTtlCache<string, number>({ ttlMs: 1000, maxInFlight: 1 });
    let finish!: (n: number) => void;
    const old = cache.get("k", () => new Promise<number>((resolve) => { finish = resolve; }));
    if (method === "clear") cache.clear(); else cache.invalidate("k");
    await expect(cache.get("k", async () => 2)).rejects.toMatchObject({ httpStatus: 503 });
    expect(cache.snapshot().inFlight).toBe(1); finish(1); expect(await old).toBe(1);
    expect(await cache.get("k", async () => 2)).toBe(2);
  });
  it("loader rejection frees capacity and observe can leave limits disabled", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 1000, maxInFlight: () => 1 });
    await expect(cache.get("a", async () => { throw new Error("loader"); })).rejects.toThrow("loader");
    expect(await cache.get("b", async () => 2)).toBe(2);
    await expect(cache.get("c", () => { throw new Error("sync loader"); })).rejects.toThrow("sync loader");
    expect(cache.snapshot().inFlight).toBe(0);
    expect(await cache.get("c", async () => 3)).toBe(3);
  });
  it("invalidating another key preserves dedupe of unaffected pending work", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 1000, maxInFlight: 2 });
    let finish!: (n: number) => void; let loads = 0;
    const first = cache.get("b", () => { loads++; return new Promise<number>((resolve) => { finish = resolve; }); });
    cache.invalidate("a");
    const second = cache.get("b", async () => { loads++; return 3; });
    expect(loads).toBe(1); finish(2);
    expect(await first).toBe(2); expect(await second).toBe(2);
  });
});

describe("createTtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("إصابة ضمن TTL تعيد القيمة بلا تحميل ثانٍ، وانقضاؤه يعيد التحميل", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 1000 });
    let loads = 0;
    const loader = async () => ++loads;
    expect(await cache.get("k", loader)).toBe(1);
    expect(await cache.get("k", loader)).toBe(1);
    expect(loads).toBe(1);
    vi.setSystemTime(new Date("2026-08-30T12:00:01.001Z"));
    expect(await cache.get("k", loader)).toBe(2);
    expect(loads).toBe(2);
  });

  it("أحادي الرحلة: المستدعون المتزامنون يتشاركون تحميلةً واحدة", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 1000 });
    let loads = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => (release = r));
    const loader = () => {
      loads += 1;
      return gate;
    };
    const a = cache.get("k", loader);
    const b = cache.get("k", loader);
    release(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(loads).toBe(1);
  });

  it("الفشل لا يُكيَّش: الخطأ ينتشر والمحاولة التالية تبدأ طازجة", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 1000 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return 42;
    };
    await expect(cache.get("k", loader)).rejects.toThrow("boom");
    expect(await cache.get("k", loader)).toBe(42);
    expect(calls).toBe(2);
  });

  it("maxEntries يطرد الأقدم إدراجاً", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 60_000, maxEntries: 2 });
    let loads = 0;
    const loaderFor = (v: number) => async () => {
      loads += 1;
      return v;
    };
    await cache.get("a", loaderFor(1));
    await cache.get("b", loaderFor(2));
    await cache.get("c", loaderFor(3)); // يطرد a
    expect(loads).toBe(3);
    expect(await cache.get("b", loaderFor(0))).toBe(2); // ما زال مكيَّشاً
    expect(loads).toBe(3);
    expect(await cache.get("a", loaderFor(9))).toBe(9); // أُعيد تحميله
    expect(loads).toBe(4);
  });

  it("إبطالٌ أثناء تحميلٍ جارٍ: المنتظرون يأخذون القيمة لكنها لا تُكيَّش (المحاولة التالية طازجة)", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 60_000 });
    let loads = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => (release = r));
    const first = cache.get("k", () => {
      loads += 1;
      return gate;
    });
    cache.clear(); // المالك أبطل بينما تحميل الزائر جارٍ على لقطةٍ قديمة
    release(1);
    expect(await first).toBe(1); // المنتظر يأخذ نتيجته
    expect(await cache.get("k", async () => ++loads + 100)).toBe(102); // لكن لا شيء كُيِّش
    expect(loads).toBe(2);
  });

  it("invalidate وclear يمحوان القيمة", async () => {
    const cache = createTtlCache<string, number>({ ttlMs: 60_000 });
    let loads = 0;
    const loader = async () => ++loads;
    await cache.get("k", loader);
    cache.invalidate("k");
    expect(await cache.get("k", loader)).toBe(2);
    cache.clear();
    expect(await cache.get("k", loader)).toBe(3);
  });
});
