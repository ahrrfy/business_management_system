import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineOutboxItem } from "./db";

const storage = vi.hoisted(() => ({
  rows: new Map<string, OfflineOutboxItem>(),
  tail: Promise.resolve(),
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
      try {
        return await run();
      } finally {
        unlock();
      }
    },
    outbox: {
      get: async (key: string) => structuredClone(storage.rows.get(key)),
      update: async (key: string, patch: Partial<OfflineOutboxItem>) => {
        const row = storage.rows.get(key);
        if (row) storage.rows.set(key, { ...row, ...patch });
      },
      bulkDelete: async () => {},
      where: (field: keyof OfflineOutboxItem) => {
        const result = (values: unknown[]) => ({
          toArray: async () =>
            structuredClone(
              Array.from(storage.rows.values()).filter((row) =>
                values.includes(row[field]),
              ),
            ),
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
  },
}));
vi.mock("./catalogSync", () => ({ getLastSyncAt: async () => null }));
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
  vi.resetModules();
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
