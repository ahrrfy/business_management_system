import { beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({
  meta: new Map<string, { key: string; value: string }>(),
  keys: new Map<string, { name: string; key: CryptoKey }>(),
  tail: Promise.resolve(),
  fail: false,
}));
vi.mock("./offline/db", () => ({
  offlineDb: {
    meta: {
      get: async (key: string) => store.meta.get(key),
      add: async (row: { key: string; value: string }) => {
        if (store.fail) throw Error("quota");
        if (store.meta.has(row.key)) throw Error("duplicate");
        store.meta.set(row.key, row);
      },
      delete: async (key: string) => {
        store.meta.delete(key);
      },
    },
    keys: {
      get: async (key: string) => store.keys.get(key),
      add: async (row: { name: string; key: CryptoKey }) => {
        if (store.keys.has(row.name)) throw Error("duplicate");
        store.keys.set(row.name, row);
      },
    },
    transaction: async (
      _mode: string,
      _table: unknown,
      run: () => Promise<unknown>,
    ) => {
      const prior = store.tail;
      let unlock!: () => void;
      store.tail = new Promise<void>((r) => {
        unlock = r;
      });
      await prior;
      try {
        return await run();
      } finally {
        unlock();
      }
    },
  },
}));
import {
  financialIntentScopeKey,
  isDefinitiveIntentRejection,
  loadFinancialIntent,
  reserveFinancialIntent,
  resolveFinancialIntent,
  type FinancialIntentScope,
} from "./persistedFinancialIntent";
const scope: FinancialIntentScope = {
  companyId: null,
  userId: 7,
  branchId: 2,
  operation: "SALES_PAYMENT",
  target: "invoice:11",
};
const command = (id = "original") => ({
  id,
  createdAt: new Date().toISOString(),
  payload: {
    amount: "5000.00",
    clientRequestId: id,
    reference: "PRIVATE-BANK-REFERENCE",
  },
});
beforeEach(() => {
  store.meta.clear();
  store.keys.clear();
  store.tail = Promise.resolve();
  store.fail = false;
});
describe("durable financial command envelope", () => {
  it("encrypts the original command, restores it, and never replaces it with changed input", async () => {
    const original = command();
    expect(await reserveFinancialIntent(scope, original)).toEqual(original);
    expect(JSON.stringify(Array.from(store.meta.values()))).not.toContain(
      "PRIVATE-BANK-REFERENCE",
    );
    expect((await reserveFinancialIntent(scope, command("changed"))).id).toBe(
      "original",
    );
    expect(await loadFinancialIntent(scope)).toEqual(original);
    expect(Array.from(store.keys.values())[0].key.extractable).toBe(false);
  });
  it("chooses one durable encryption key and one command on simultaneous first captures", async () => {
    const values = await Promise.all([
      reserveFinancialIntent(scope, command("first")),
      reserveFinancialIntent(scope, command("second")),
    ]);
    expect(values[0]).toEqual(values[1]);
    expect(store.meta.size).toBe(1);
    expect(store.keys.size).toBe(1);
    expect(await loadFinancialIntent(scope)).toEqual(values[0]);
  });
  it.each([
    { userId: 8 },
    { branchId: 3 },
    { companyId: 1 },
    { target: "invoice:12" },
  ])("isolates another identity/target %j", async (changed) => {
    await reserveFinancialIntent(scope, command());
    const other = { ...scope, ...changed };
    expect(await loadFinancialIntent(other)).toBeNull();
    const row = store.meta.get(financialIntentScopeKey(scope))!;
    store.meta.set(financialIntentScopeKey(other), {
      key: financialIntentScopeKey(other),
      value: row.value,
    });
    await expect(loadFinancialIntent(other)).rejects.toThrow("هوية");
  });
  it("clears only the matching definitive outcome", async () => {
    await reserveFinancialIntent(scope, command());
    expect(await resolveFinancialIntent(scope, "other")).toBe(false);
    expect(await loadFinancialIntent(scope)).not.toBeNull();
    expect(await resolveFinancialIntent(scope, "original")).toBe(true);
    expect(await loadFinancialIntent(scope)).toBeNull();
  });
  it("fails closed on storage failure or loss of an existing key without removing evidence", async () => {
    store.fail = true;
    await expect(reserveFinancialIntent(scope, command())).rejects.toThrow(
      "quota",
    );
    store.fail = false;
    await reserveFinancialIntent(scope, command());
    store.keys.clear();
    await expect(loadFinancialIntent(scope)).rejects.toThrow("مفتاح");
    expect(store.meta.size).toBe(1);
    expect(store.keys.size).toBe(0);
  });
  it("distinguishes a fresh server rejection from a transport or unknown failure", () => {
    expect(isDefinitiveIntentRejection({ data: { code: "BAD_REQUEST" } })).toBe(
      true,
    );
    expect(isDefinitiveIntentRejection(new Error("Failed to fetch"))).toBe(
      false,
    );
    expect(
      isDefinitiveIntentRejection({ data: { code: "INTERNAL_SERVER_ERROR" } }),
    ).toBe(false);
  });
});
