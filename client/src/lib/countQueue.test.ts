import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueUnknown,
  peekUnknown,
  type QueuedUnknownScan,
} from "./countQueue";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function unknownScan(index: number): QueuedUnknownScan {
  return {
    clientRequestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    barcode: `UNKNOWN-${index}`,
    queuedAt: new Date(Date.UTC(2026, 7, 27, 12, 0, index % 60)).toISOString(),
  };
}

describe("countQueue — طابور الباركود المجهول", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("يرفض المسح 501 بلا تغيير الطابور كي لا تدّعي الواجهة نجاحاً مع إسقاط الأحدث", () => {
    const sessionCode = "CNT-QUEUE-CAP";
    for (let i = 1; i <= 500; i++) {
      expect(enqueueUnknown(sessionCode, unknownScan(i))).toBe(true);
    }
    const before = peekUnknown(sessionCode);

    expect(enqueueUnknown(sessionCode, unknownScan(501))).toBe(false);
    expect(peekUnknown(sessionCode)).toEqual(before);
    expect(peekUnknown(sessionCode)).toHaveLength(500);
    expect(peekUnknown(sessionCode).at(-1)?.barcode).toBe("UNKNOWN-500");
  });

  it("يسمح بتحديث باركود موجود عند الامتلاء لأنه لا يزيد عدد العناصر", () => {
    const sessionCode = "CNT-QUEUE-REPLACE";
    for (let i = 1; i <= 500; i++) {
      expect(enqueueUnknown(sessionCode, unknownScan(i))).toBe(true);
    }
    const replacement = {
      ...unknownScan(500),
      clientRequestId: "00000000-0000-4000-8000-999999999999",
      queuedAt: "2026-08-27T13:00:00.000Z",
    };

    expect(enqueueUnknown(sessionCode, replacement)).toBe(true);
    const queued = peekUnknown(sessionCode);
    expect(queued).toHaveLength(500);
    expect(queued.at(-1)).toEqual(replacement);
  });
});
