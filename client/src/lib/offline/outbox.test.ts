import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineOutboxItem } from "./db";

const storage = vi.hoisted(() => ({
  rows: new Map<string, OfflineOutboxItem>(),
  tail: Promise.resolve(),
  lastSync: new Date().toISOString() as string | null,
  failRead: false,
  failAdd: false,
  inTransaction: false,
  key: null as CryptoKey | null,
}));
vi.mock("./db", () => ({
  getMeta: async () => "device-42",
  setMeta: async () => {},
  offlineDb: {
    transaction: async (
      _mode: string,
      _table: unknown,
      run: () => Promise<unknown>,
    ) => {
      const previous = storage.tail;
      let unlock!: () => void;
      storage.tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      storage.inTransaction = true;
      try {
        return await run();
      } finally {
        storage.inTransaction = false;
        unlock();
      }
    },
    outbox: {
      add: async (row: OfflineOutboxItem) => {
        if (!storage.inTransaction) throw new Error("Admission requires a transaction");
        if (storage.failAdd) throw new Error("Quota exceeded");
        if (storage.rows.has(row.clientRequestId)) throw new Error("Duplicate key");
        storage.rows.set(row.clientRequestId, structuredClone(row));
      },
      get: async (key: string) => structuredClone(storage.rows.get(key)),
      update: async (key: string, patch: Partial<OfflineOutboxItem>) => {
        const row = storage.rows.get(key);
        if (row) storage.rows.set(key, { ...row, ...patch });
      },
      bulkDelete: async () => {},
      where: (field: keyof OfflineOutboxItem) => {
        const result = (values: unknown[]) => ({
          toArray: async () => {
            if (storage.failRead) throw new Error("Storage unavailable");
            return structuredClone(
              Array.from(storage.rows.values()).filter((row) =>
                values.includes(row[field]),
              ),
            );
          },
          sortBy: async () =>
            structuredClone(
              Array.from(storage.rows.values())
                .filter((row) => values.includes(row[field]))
                .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
            ),
        });
        return {
          equals: (value: unknown) => result([value]),
          anyOf: (...values: unknown[]) => result(values),
        };
      },
    },
    keys: {
      get: async () => {
        if (storage.inTransaction) throw new Error("Encryption inside transaction");
        return storage.key ? { key: storage.key } : undefined;
      },
      put: async ({ key }: { key: CryptoKey }) => { storage.key = key; },
    },
  },
}));
vi.mock("./catalogSync", () => ({ getLastSyncAt: async () => storage.lastSync }));
vi.mock("./pinLock", () => ({ getOfflineProfile: async () => null }));

function pending(
  key = "saved-request",
  userId: number | null = 11,
): OfflineOutboxItem {
  return {
    clientRequestId: key,
    kind: "SALE",
    capturedByUserId: userId,
    capturedAt: "2026-10-27T10:30:00.000Z",
    branchId: 7,
    shiftId: 42,
    offlineReceiptNumber: "OFF-7-original-3",
    status: "SENDING",
    attempts: 0,
    total: "1500.00",
    lastError: null,
    payload: {
      clientRequestId: key,
      branchId: 7,
      shiftId: 42,
      lines: [],
      payment: { amount: "1500.00", method: "CASH" },
    },
  };
}

beforeEach(() => {
  storage.rows.clear();
  storage.lastSync = new Date().toISOString();
  storage.failRead = false;
  storage.failAdd = false;
  storage.key = null;
  vi.resetModules();
});

// Serialized in-memory Dexie model: checks admission policy/interleavings, not IndexedDB auto-commit.
describe("offline incoming exposure admission", () => {
  async function capture(total: string, key = "new", kind: OfflineOutboxItem["kind"] = "SALE") {
    const { enqueueOfflineItem } = await import("./outbox");
    return enqueueOfflineItem({
      kind, total, capturedByUserId: 11, offlineReceiptNumber: `OFF-${key}`,
      payload: { branchId: 7, shiftId: 42, clientRequestId: key, lines: [], payment: { amount: total, method: "CASH" } },
    });
  }

  it("counts PARKED 4.9m and rejects another 0.2m without touching the saved row", async () => {
    const row = { ...pending(), status: "PARKED" as const, total: "4900000" };
    storage.rows.set(row.clientRequestId, row);
    const { assertCanCapture, queuedTotalIQD } = await import("./outbox");
    expect(await queuedTotalIQD()).toBe(4_900_000);
    expect((await assertCanCapture(200_000)).ok).toBe(false);
    expect(await capture("200000")).toBe(false);
    expect(Array.from(storage.rows.values())).toEqual([row]);
  });

  it("preserves legacy zero-value incoming rows without poisoning sale capacity", async () => {
    const zeroRows = (["QUEUED", "SENDING", "PARKED"] as const).map((status) => ({
      ...pending(`zero-${status}`), status, total: "0.00",
    }));
    for (const row of zeroRows) storage.rows.set(row.clientRequestId, row);
    const { assertCanCapture, queuedTotalIQD } = await import("./outbox");
    expect(await queuedTotalIQD()).toBe(0);
    expect((await assertCanCapture(5_000_000)).ok).toBe(true);
    expect(await capture("5000000")).toBe(true);
    expect(await queuedTotalIQD()).toBe(5_000_000);
    expect(await capture("0.01", "extra")).toBe(false);
    for (const row of zeroRows) expect(storage.rows.get(row.clientRequestId)).toEqual(row);
  });

  it("serializes parallel captures so their combined exposure cannot exceed 5m", async () => {
    const results = await Promise.all([capture("3000000", "a"), capture("3000000", "b")]);
    expect(results.sort()).toEqual([false, true]);
    const { queuedTotalIQD } = await import("./outbox");
    expect(await queuedTotalIQD()).toBe(3_000_000);
    expect(storage.rows.size).toBe(1);
  });

  it("includes all incoming kinds and legacy missing kind; excludes SENT and RETURN", async () => {
    for (const [index, kind] of Array.from(["SALE", "PRINT_SALE", "RECEPTION", undefined].entries())) {
      storage.rows.set(`s${index}`, { ...pending(`s${index}`), kind, status: ["QUEUED", "SENDING", "PARKED", "PARKED"][index], total: "1000000" } as OfflineOutboxItem);
    }
    storage.rows.set("sent", { ...pending("sent"), status: "SENT", total: "9000000" });
    storage.rows.set("return", { ...pending("return"), kind: "RETURN", total: "9000000" });
    const { queuedTotalIQD } = await import("./outbox");
    expect(await queuedTotalIQD()).toBe(4_000_000);
    expect(await capture("1000000")).toBe(true);
    expect(await capture("0.01", "extra")).toBe(false);
  });

  it("RETURN remains capturable at full sale exposure and with stale catalog", async () => {
    storage.rows.set("full", { ...pending("full"), total: "5000000" });
    storage.lastSync = null;
    const { enqueueOfflineReturn, readItemPayload, queuedTotalIQD } = await import("./outbox");
    const payload = { branchId: 7, shiftId: 42, invoiceId: 1, lines: [], refund: { amount: "9000000", method: "CASH" as const }, restock: true, reason: "return", clientRequestId: "return" };
    expect(await enqueueOfflineReturn({ payload, total: "9000000", offlineReceiptNumber: "OFF-return", capturedByUserId: 11 })).toBe(true);
    const saved = storage.rows.get("return")!;
    expect(saved.payload).toMatchObject({ enc: true, v: 1 });
    expect(await readItemPayload(saved)).toEqual(payload);
    expect(await queuedTotalIQD()).toBe(5_000_000);
    storage.lastSync = new Date().toISOString();
    expect(await capture("0.01")).toBe(false);
  });

  it("the return UI gate preserves freshness without using incoming sale capacity", async () => {
    storage.rows.set("full", { ...pending("full"), status: "PARKED", total: "5000000" });
    const { assertCanCapture } = await import("./outbox");
    expect((await assertCanCapture(1000, "RETURN")).ok).toBe(true);
    expect((await assertCanCapture(1000)).ok).toBe(false);
    expect((await assertCanCapture(1.001, "RETURN")).ok).toBe(false);
    storage.lastSync = null;
    expect((await assertCanCapture(1000, "RETURN")).ok).toBe(false);
  });

  it.each(["0", "-1", "", "bad", "NaN", "Infinity", "-Infinity", "0x10", "1,000", "1.001", "1.000"])("rejects invalid total %s without saving", async (total) => {
    const { assertCanCapture } = await import("./outbox");
    if (!["0x10", "1.000"].includes(total)) expect((await assertCanCapture(Number(total))).ok).toBe(false);
    expect(await capture(total)).toBe(false);
    expect(storage.rows.size).toBe(0);
  });

  it("uses Decimal at the exact boundary without rounding away one cent", async () => {
    storage.rows.set("prior", { ...pending("prior"), total: "4999999.70" });
    expect(await capture("0.30")).toBe(true);
    expect(await capture("0.01", "extra")).toBe(false);
  });

  it.each([null, "invalid", new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(), new Date(Date.now() + 60_000).toISOString()])("capture itself rejects stale/missing/invalid catalog %s", async (lastSync) => {
    storage.lastSync = lastSync;
    expect(await capture("1")).toBe(false);
    expect(storage.rows.size).toBe(0);
  });

  it.each(["QUEUED", "SENDING", "PARKED", "SENT"] as const)("preserves same-key %s rows on retries", async (status) => {
    const original = { ...pending(), status, attempts: 3, sendingToken: "saved-lease", sendingLeaseUntil: Date.now() + 60_000 };
    storage.rows.set(original.clientRequestId, structuredClone(original));
    expect(await capture("9000", original.clientRequestId)).toBe(false);
    expect(storage.rows.get(original.clientRequestId)).toEqual(original);
  });

  it.each(["NaN", "-1", "", undefined, null])("rejects corrupt existing exposure %s safely and preserves it", async (total) => {
    const original = { ...pending(), total } as OfflineOutboxItem;
    storage.rows.set(original.clientRequestId, original);
    const { assertCanCapture } = await import("./outbox");
    expect((await assertCanCapture(1)).ok).toBe(false);
    expect(await capture("1")).toBe(false);
    expect(Array.from(storage.rows.values())).toEqual([original]);
  });

  it.each(["read", "add"])("handles storage %s failures without uncaught errors or row loss", async (failure) => {
    const original = pending();
    storage.rows.set(original.clientRequestId, original);
    storage.failRead = failure === "read";
    storage.failAdd = failure === "add";
    const { assertCanCapture } = await import("./outbox");
    if (failure === "read") expect((await assertCanCapture(1)).ok).toBe(false);
    await expect(capture("1")).resolves.toBe(false);
    expect(Array.from(storage.rows.values())).toEqual([original]);
  });
});

describe("offline interrupted sending recovery", () => {
  it("replays an interrupted command using its captured payload, key, time and receipt", async () => {
    const row = pending();
    storage.rows.set(row.clientRequestId, row);
    const { flushOutbox } = await import("./outbox");
    const replay = vi.fn(async () => ({
      invoiceId: 81,
      invoiceNumber: "INV-81",
      idempotentReplay: true,
    }));
    await flushOutbox(replay, { currentUserId: 11, force: true });
    expect(replay).toHaveBeenCalledExactlyOnceWith({
      payload: row.payload,
      capturedAt: row.capturedAt,
      offlineReceiptNumber: row.offlineReceiptNumber,
      deviceId: "device-42",
    });
    expect(storage.rows.get(row.clientRequestId)?.status).toBe("SENT");
  });

  it("quarantines missing identity and leaves another employee's interrupted command untouched", async () => {
    storage.rows.set("other", pending("other", 22));
    storage.rows.set("legacy", pending("legacy", null));
    const { flushOutbox } = await import("./outbox");
    const replay = vi.fn();
    await flushOutbox(replay, { currentUserId: 11, force: true });
    expect(replay).not.toHaveBeenCalled();
    expect(storage.rows.get("other")?.status).toBe("SENDING");
    expect(storage.rows.get("legacy")?.status).toBe("PARKED");
  });

  it("a second tab cannot claim an active sending lease", async () => {
    storage.rows.set("saved-request", { ...pending(), status: "QUEUED" });
    const first = await import("./outbox");
    let complete!: (value: {
      invoiceId: number;
      invoiceNumber: string;
    }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const replay = vi.fn(() => {
      started();
      return new Promise<{ invoiceId: number; invoiceNumber: string }>(
        (resolve) => {
          complete = resolve;
        },
      );
    });
    const sending = first.flushOutbox(replay, {
      currentUserId: 11,
      force: true,
    });
    await ready;
    vi.resetModules();
    const second = await import("./outbox");
    await second.flushOutbox(replay, { currentUserId: 11, force: true });
    complete({ invoiceId: 81, invoiceNumber: "INV-81" });
    await sending;
    expect(replay).toHaveBeenCalledTimes(1);
    expect(storage.rows.get("saved-request")?.status).toBe("SENT");
  });

  it("a manual approved replay keeps an exclusive lease across tabs", async () => {
    storage.rows.set("saved-request", { ...pending(), status: "PARKED" });
    const first = await import("./outbox");
    let complete!: (value: {
      invoiceId: number;
      invoiceNumber: string;
    }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manual = first.replayParkedWithApproval("saved-request", () => {
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    await ready;
    vi.resetModules();
    const second = await import("./outbox");
    const replay = vi.fn(async () => ({
      invoiceId: 81,
      invoiceNumber: "INV-81",
    }));
    await second.flushOutbox(replay, { currentUserId: 11, force: true });
    complete({ invoiceId: 81, invoiceNumber: "INV-81" });
    await manual;
    expect(replay).not.toHaveBeenCalled();
  });

  it("a stale retry button cannot release another tab's active claim", async () => {
    const active = {
      ...pending(),
      sendingToken: "active-tab",
      sendingLeaseUntil: Date.now() + 60_000,
    };
    storage.rows.set(active.clientRequestId, active);
    const { requeueParkedItem } = await import("./outbox");
    await requeueParkedItem(active.clientRequestId);
    expect(storage.rows.get(active.clientRequestId)).toEqual(active);
  });

  it("fences a late response after an expired tab was recovered", async () => {
    storage.rows.set("saved-request", { ...pending(), status: "QUEUED" });
    const first = await import("./outbox");
    let complete!: (value: {
      invoiceId: number;
      invoiceNumber: string;
    }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const oldAttempt = first.flushOutbox(
      () => {
        started();
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
      { currentUserId: 11, force: true },
    );
    await ready;
    const active = storage.rows.get("saved-request")!;
    storage.rows.set("saved-request", {
      ...active,
      sendingLeaseUntil: Date.now() - 1,
    });
    vi.resetModules();
    const recovered = await import("./outbox");
    const replay = vi.fn(async (_args: import("./outbox").ReplayArgs) => ({
      invoiceId: 81,
      invoiceNumber: "INV-recovered",
      idempotentReplay: true,
    }));
    await recovered.flushOutbox(replay, { currentUserId: 11, force: true });
    complete({ invoiceId: 81, invoiceNumber: "INV-stale-response" });
    await oldAttempt;
    expect(replay.mock.calls[0]?.[0].payload).toEqual(pending().payload);
    expect(storage.rows.get("saved-request")?.resultInvoiceNumber).toBe(
      "INV-recovered",
    );
  });
});
