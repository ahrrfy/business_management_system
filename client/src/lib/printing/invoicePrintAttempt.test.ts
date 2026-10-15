import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

describe("invoice printing retries", () => {
  it("resumes the same FIRST authorization after a failed attempt and a remount", async () => {
    const first = await import("./invoicePrintAttempt");
    const attempt = first.beginInvoicePrintAttempt(7, 42, "THERMAL", false);
    vi.resetModules();
    const remounted = await import("./invoicePrintAttempt");
    const retry = remounted.beginInvoicePrintAttempt(7, 42, "THERMAL", true);
    expect(retry).toEqual(attempt);
    expect(retry.mode).toBe("PRINT");
    remounted.completeInvoicePrintAttempt(retry);
    const next = remounted.beginInvoicePrintAttempt(7, 42, "THERMAL", true);
    expect(next.mode).toBe("REPRINT");
    expect(next.requestId).not.toBe(attempt.requestId);
  });
  it("isolates users, invoices and purposes and ignores an obsolete completion", async () => {
    const api = await import("./invoicePrintAttempt");
    const attempt = api.beginInvoicePrintAttempt(7, 42, "A4", false);
    expect(api.beginInvoicePrintAttempt(8, 42, "A4", true).mode).toBe("REPRINT");
    expect(api.beginInvoicePrintAttempt(7, 43, "A4", true).mode).toBe("REPRINT");
    expect(api.beginInvoicePrintAttempt(7, 42, "WAREHOUSE", true).mode).toBe("REPRINT");
    api.completeInvoicePrintAttempt({ ...attempt, requestId: crypto.randomUUID() });
    expect(api.hasPendingFirstInvoicePrint(7, 42, "A4")).toBe(true);
  });
  it("uses independently granted REPRINT when FIRST is revoked, then retires the failed FIRST attempt", async () => {
    const api = await import("./invoicePrintAttempt");
    api.beginInvoicePrintAttempt(7, 42, "A4", false);
    const allowedReprint = api.beginInvoicePrintAttempt(7, 42, "A4", true, false);
    expect(allowedReprint.mode).toBe("REPRINT");
    api.completeInvoicePrintAttempt(allowedReprint);
    expect(api.hasPendingFirstInvoicePrint(7, 42, "A4")).toBe(false);
  });
});
