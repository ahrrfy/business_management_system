import { describe, it, expect, vi } from "vitest";
import { assertCreditLimit } from "../credit";

function makeMockTx(creditLimit: string | null, currentBalance: string = "0") {
  const rows = [{ creditLimit, currentBalance }];
  const from = vi.fn(() => ({
    where: vi.fn(() => ({
      for: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  }));
  const select = vi.fn(() => ({ from }));
  return { select } as unknown as Parameters<typeof assertCreditLimit>[0];
}

describe("VULN-FIN-01: Zero Credit Limit Bypass Invariant Tests", () => {
  it("TC-CREDIT-01: Zero limit with zero balance rejects credit purchases", async () => {
    const tx = makeMockTx("0", "0");
    await expect(assertCreditLimit(tx, 101, "50000", 1, "CREDIT"))
      .rejects.toThrow(/حدّ ائتمانه صفر/);
  });

  it("TC-CREDIT-02: Zero limit with existing debt (VULN-FIN-01) MUST reject additional credit", async () => {
    const tx = makeMockTx("0", "120000");
    await expect(assertCreditLimit(tx, 102, "25000", 1, "CREDIT"))
      .rejects.toThrow(/حدّ ائتمانه صفر/);
    await expect(assertCreditLimit(tx, 102, "25000", 1, "CREDIT"))
      .rejects.toThrow(/رصيد سابق/);
  });

  it("TC-CREDIT-03: Zero limit with credit balance rejects deferred purchase", async () => {
    const tx = makeMockTx("0", "-50000");
    await expect(assertCreditLimit(tx, 103, "20000", 1, "CREDIT"))
      .rejects.toThrow(/حدّ ائتمانه صفر/);
  });

  it("TC-CREDIT-04: Zero limit with zero addAmount resolves immediately", async () => {
    const tx = makeMockTx("0", "50000");
    await expect(assertCreditLimit(tx, 104, "0", 1, "CREDIT")).resolves.toBeUndefined();
  });

  it("TC-CREDIT-05: COD mode bypasses credit checks even with zero limit and debt", async () => {
    const tx = makeMockTx("0", "50000");
    await expect(assertCreditLimit(tx, 105, "50000", 1, "COD")).resolves.toBeUndefined();
  });

  it("TC-CREDIT-06: Unlimited customer (null) permits arbitrary credit additions", async () => {
    const tx = makeMockTx(null, "500000");
    await expect(assertCreditLimit(tx, 106, "1000000", 1, "CREDIT")).resolves.toBeUndefined();
  });

  it("TC-CREDIT-07: Positive limit allows purchase within capacity", async () => {
    const tx = makeMockTx("1000", "500");
    await expect(assertCreditLimit(tx, 107, "400", 1, "CREDIT")).resolves.toBeUndefined();
  });

  it("TC-CREDIT-08: Positive limit rejects purchase exceeding capacity", async () => {
    const tx = makeMockTx("1000", "500");
    await expect(assertCreditLimit(tx, 108, "600", 1, "CREDIT"))
      .rejects.toThrow(/تجاوز حدّ الائتمان/);
  });
});
