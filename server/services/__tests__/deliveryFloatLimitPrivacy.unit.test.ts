import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";
import { assertFloatLimitTx } from "../delivery/parties";
import { money } from "../money";

function transaction(exposure: string): Tx {
  return {
    select: (fields: Record<string, unknown>) => {
      const rows = "exposure" in fields ? [{ exposure }] : [];
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      };
      for (const key of ["from", "where", "groupBy"]) chain[key] = () => chain;
      return chain;
    },
  } as unknown as Tx;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("delivery capacity refusal privacy", () => {
  it("still rejects over-limit dispatch without disclosing company exposure or its limit", async () => {
    vi.stubEnv("ROLLOUT_COURIER_LEDGER_DERIVED", "OFF");
    const error = await assertFloatLimitTx(
      transaction("97543.21"),
      { id: 7, name: "شركة التوصيل", currentBalance: "97543.21", floatLimit: "98000.00" },
      money("1000.00"),
    ).then(() => null, (reason) => reason);
    expect(error).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(error.message).toContain("شركة التوصيل");
    for (const sensitiveAmount of ["97543.21", "98543.21", "98000.00"])
      expect(error.message).not.toContain(sensitiveAmount);
  });

  it.each(["98543.21", "99000.00"])("allows dispatch at or below the configured limit %s", async (floatLimit) => {
    vi.stubEnv("ROLLOUT_COURIER_LEDGER_DERIVED", "OFF");
    await expect(assertFloatLimitTx(
      transaction("97543.21"),
      { id: 7, name: "شركة التوصيل", currentBalance: "0.00", floatLimit },
      money("1000.00"),
    )).resolves.toBeUndefined();
  });

  it("still uses the larger stored cash balance to reject an unsafe dispatch", async () => {
    vi.stubEnv("ROLLOUT_COURIER_LEDGER_DERIVED", "OFF");
    await expect(assertFloatLimitTx(
      transaction("1.00"),
      { id: 7, name: "شركة التوصيل", currentBalance: "97543.21", floatLimit: "98000.00" },
      money("1000.00"),
    )).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("keeps a disabled limit from rejecting dispatch", async () => {
    await expect(assertFloatLimitTx(
      transaction("97543.21"),
      { id: 7, name: "شركة التوصيل", currentBalance: "97543.21", floatLimit: "0.00" },
      money("1000.00"),
    )).resolves.toBeUndefined();
  });
});
