import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtlCache } from "../../lib/ttlCache";
import { REALTIME_EVENT_TYPES as E, createRealtimeEvent, type RealtimeEvent } from "@shared/realtimeEvents";

const state = vi.hoisted(() => ({ receive: (_event: RealtimeEvent) => {} }));
vi.mock("../bridge", () => ({ onBridgeEvent: (receive: typeof state.receive) => { state.receive = receive; } }));

let key: (key: string) => string;
let alertsKey: (key: string) => string;

beforeEach(async () => {
  vi.resetModules();
  const module = await import("../financialCache");
  key = module.financialCacheKey;
  alertsKey = module.financialAlertsCacheKey;
});
afterEach(() => vi.restoreAllMocks());

const changed = () => state.receive(createRealtimeEvent(E.FINANCIAL_DATA_CHANGED, { branchIds: null }));

describe("financial server cache revisions", () => {
  it("keeps expensive alert reads shared for 30 seconds despite hundreds of commits", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const cache = createTtlCache<string, string>({ ttlMs: 30_000 });
    const loader = vi.fn(async () => "fresh alerts");
    const original = alertsKey("all");
    for (let i = 0; i < 300; i++) {
      changed();
      await cache.get(alertsKey("all"), loader);
    }
    expect(alertsKey("all")).toBe(original);
    expect(loader).toHaveBeenCalledOnce();
    clock.mockReturnValue(31_000);
    expect(alertsKey("all")).not.toBe(original);
    await cache.get(alertsKey("all"), loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("refreshes a warm cache on a bridged commit while sharing concurrent fresh reads", async () => {
    const cache = createTtlCache<string, string>({ ttlMs: 30_000 });
    let authoritative = "1000.25";
    const loader = vi.fn(async () => authoritative);
    expect(await cache.get(key("branch:1"), loader)).toBe("1000.25");
    expect(await cache.get(key("branch:1"), loader)).toBe("1000.25");
    expect(loader).toHaveBeenCalledOnce();
    authoritative = "1250.50";
    changed();
    expect(await Promise.all([cache.get(key("branch:1"), loader), cache.get(key("branch:1"), loader)]))
      .toEqual(["1250.50", "1250.50"]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("cannot reuse a pre-commit in-flight snapshot under the new revision", async () => {
    const cache = createTtlCache<string, string>({ ttlMs: 30_000 });
    let finish!: (value: string) => void;
    const old = cache.get(key("all"), () => new Promise<string>((r) => { finish = r; }));
    changed();
    expect(await cache.get(key("all"), async () => "2000.25")).toBe("2000.25");
    finish("1000.25");
    await old;
    expect(await cache.get(key("all"), async () => "should stay cached")).toBe("2000.25");
  });

  it("advances revision after bridge recovery (RESYNC_REQUIRED)", () => {
    const first = key("all");
    state.receive(createRealtimeEvent(E.RESYNC_REQUIRED, {}));
    expect(key("all")).not.toBe(first);
  });
});
