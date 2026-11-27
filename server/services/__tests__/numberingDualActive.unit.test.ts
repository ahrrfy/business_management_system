import { afterEach, describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  getDocumentCounterNode,
  nextCounterValue,
  nextInvoiceNumber,
  nextTransactionTrackingNumber,
} from "../numbering";
import { resolveInvoiceNumberTx } from "../sale/invoiceNumbering";
import { resolveDeliveryInvoiceNumber } from "../workOrder/helpers";
import { nextConsignmentNumber } from "../delivery/numbering";
import {
  ensureBranchStockRowsForAllBranches,
  ensureBranchStockRowsForBranch,
} from "../inventory/stockLock";

const dialect = new MySqlDialect();

function makeMockTx(
  nextValue = 1,
  opts: { maxExistingCounter?: number; invoiceHistoryMax?: number } = {},
) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const tx: any = {
    execute: async (query: any) => {
      const rendered = dialect.sqlToQuery(query);
      executed.push(rendered);
      if (rendered.sql.includes("SELECT counterKey, lastValue")) {
        return [[{ counterKey: "unified_transaction_floor", lastValue: 100050 }]];
      }
      if (rendered.sql.includes("AS maxExisting")) {
        return [[{ maxExisting: opts.maxExistingCounter ?? 0 }]];
      }
      if (rendered.sql.includes("SELECT COALESCE(MAX(")) {
        return [[{ legacyFloor: 0 }]];
      }
      if (rendered.sql.includes("SELECT LAST_INSERT_ID()")) {
        return [[{ v: nextValue }]];
      }
      return [[]];
    },
  };
  if (opts.invoiceHistoryMax !== undefined) {
    tx.select = () => ({
      from: () => ({
        where: async () => [{ maxSeq: opts.invoiceHistoryMax }],
      }),
    });
  }
  return { tx, executed };
}

describe("Dual-Active Document Counter Parity & Inventory Pre-Seed (Unit)", () => {
  const prevNodeId = process.env.ALROYA_NODE_ID;

  afterEach(() => {
    if (prevNodeId === undefined) delete process.env.ALROYA_NODE_ID;
    else process.env.ALROYA_NODE_ID = prevNodeId;
  });

  it("getDocumentCounterNode defaults to single-node when unset and isolates cloud (odd) / local (even)", () => {
    delete process.env.ALROYA_NODE_ID;
    expect(getDocumentCounterNode()).toEqual({ nodeId: null, targetRemainder: null });

    expect(getDocumentCounterNode({ ALROYA_NODE_ID: "" } as NodeJS.ProcessEnv)).toEqual({
      nodeId: null,
      targetRemainder: null,
    });
    expect(getDocumentCounterNode({ ALROYA_NODE_ID: "CLOUD" } as NodeJS.ProcessEnv)).toEqual({
      nodeId: "cloud",
      targetRemainder: 1,
    });
    expect(getDocumentCounterNode({ ALROYA_NODE_ID: " local " } as NodeJS.ProcessEnv)).toEqual({
      nodeId: "local",
      targetRemainder: 0,
    });
    expect(() =>
      getDocumentCounterNode({ ALROYA_NODE_ID: "replica-3" } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid ALROYA_NODE_ID/);
  });

  it("nextCounterValue preserves unsuffixed +1 in single-node mode and uses odd/even scoped keys in Dual-Active", async () => {
    delete process.env.ALROYA_NODE_ID;
    const single = makeMockTx(10001);
    expect(await nextCounterValue(single.tx, "invoice")).toBe(10001);
    expect(single.executed[0].params).toContain("invoice");
    expect(single.executed[0].sql).not.toContain("MOD(lastValue + 1, 2)");

    process.env.ALROYA_NODE_ID = "cloud";
    const cloud = makeMockTx(10001);
    expect(await nextCounterValue(cloud.tx, "invoice")).toBe(10001);
    const cloudIns = cloud.executed.find((q) =>
      q.sql.includes("INSERT INTO documentCounters"),
    )!;
    expect(cloudIns.params[0]).toBe("invoice:cloud");
    expect(cloudIns.params[1]).toBe(10001);
    expect(cloudIns.sql).toContain("MOD(lastValue + 1, 2)");

    process.env.ALROYA_NODE_ID = "local";
    const local = makeMockTx(10002);
    expect(await nextCounterValue(local.tx, "invoice")).toBe(10002);
    const localIns = local.executed.find((q) =>
      q.sql.includes("INSERT INTO documentCounters"),
    )!;
    expect(localIns.params[0]).toBe("invoice:local");
    expect(localIns.params[1]).toBe(10002);
  });

  it("seeds node-scoped invoice counters above existing unsuffixed counters and historical invoices", async () => {
    process.env.ALROYA_NODE_ID = "cloud";
    const cloudFromCounter = makeMockTx(10451, { maxExistingCounter: 10450 });
    expect(await nextCounterValue(cloudFromCounter.tx, "invoice")).toBe(10451);
    const cloudIns = cloudFromCounter.executed.find((q) =>
      q.sql.includes("INSERT INTO documentCounters"),
    )!;
    expect(cloudIns.params[0]).toBe("invoice:cloud");
    expect(cloudIns.params[1]).toBe(10451);

    process.env.ALROYA_NODE_ID = "local";
    const localFromHistory = makeMockTx(10482, { invoiceHistoryMax: 10480 });
    expect(await nextCounterValue(localFromHistory.tx, "invoice")).toBe(10482);
    const localIns = localFromHistory.executed.find((q) =>
      q.sql.includes("INSERT INTO documentCounters"),
    )!;
    expect(localIns.params[0]).toBe("invoice:local");
    expect(localIns.params[1]).toBe(10482);
  });

  it("nextTransactionTrackingNumber and delivery numbering scope keys per node cleanly", async () => {
    process.env.ALROYA_NODE_ID = "local";
    const tracking = makeMockTx(100052);
    expect(await nextTransactionTrackingNumber(tracking.tx)).toBe("100052");
    expect(tracking.executed[0].params).toContain("unified_transaction:local");
    const upsertCalls = tracking.executed.filter(
      (q) =>
        q.sql.includes("INSERT INTO documentCounters") &&
        q.params.includes("unified_transaction:local"),
    );
    expect(upsertCalls.length).toBeGreaterThanOrEqual(2);

    const deliv = makeMockTx(2);
    const cn = await nextConsignmentNumber(deliv.tx, 1);
    expect(cn).toMatch(/^CN-1-\d{8}-00002$/);
    expect(String(deliv.executed[0].params[0])).toMatch(/:local$/);
  });

  it("self-heals unified_transaction:cloud above invoice:cloud in O(1) without scanning invoices (WO-771 116465 regression)", async () => {
    process.env.ALROYA_NODE_ID = "cloud";
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    let fullTableRegExpScans = 0;
    const tx: any = {
      execute: async (query: any) => {
        const rendered = dialect.sqlToQuery(query);
        executed.push(rendered);
        if (rendered.sql.includes("SELECT counterKey, lastValue")) {
          return [[
            { counterKey: "unified_transaction_floor", lastValue: 100034 },
            { counterKey: "unified_transaction:cloud", lastValue: 116463 },
            { counterKey: "invoice:cloud", lastValue: 116465 },
          ]];
        }
        if (rendered.sql.includes("AS maxExisting")) {
          return [[{ maxExisting: 116465 }]];
        }
        if (rendered.sql.includes("SELECT LAST_INSERT_ID()")) {
          return [[{ v: 116467 }]];
        }
        return [[]];
      },
      select: () => ({
        from: () => ({
          where: (cond: any) => {
            const rendered = dialect.sqlToQuery(cond);
            if (rendered.sql.includes("REGEXP")) {
              fullTableRegExpScans += 1;
              return Promise.resolve([{ maxSeq: 116465 }]);
            }
            return { limit: async () => [] };
          },
        }),
      }),
    };

    const nextNum = await nextTransactionTrackingNumber(tx);
    expect(nextNum).toBe("116467");
    expect(fullTableRegExpScans).toBe(0);

    const counterUpsert = executed.find(
      (q) =>
        q.sql.includes("INSERT INTO documentCounters") &&
        q.params[0] === "unified_transaction:cloud",
    )!;
    // firstValid must jump past 116465 straight to odd 116467 (never 116465)
    expect(counterUpsert.params[1]).toBe(116467);

    // Legacy work order (< 100000) delivery uses resolveInvoiceNumberTx (O(1) point lookup, zero REGEXP scan)
    const legacyDeliveryInv = await resolveDeliveryInvoiceNumber(tx, "5679", 1);
    expect(legacyDeliveryInv).toBe("116467");
    expect(fullTableRegExpScans).toBe(0);
    expect(
      executed.some(
        (q) =>
          q.sql.includes("INSERT INTO documentCounters") &&
          String(q.params[0]).startsWith("invoice"),
      ),
    ).toBe(false);
  });

  it("resolveInvoiceNumberTx self-heals counter floor in 1 shot across arbitrary historical gaps without ER_DUP_ENTRY, and nextInvoiceNumber shares unified_transaction", async () => {
    delete process.env.ALROYA_NODE_ID;
    let seq = 116464;
    let floorReconciled = false;
    const occupied = new Set(["116465"]);
    const executedKeys: unknown[] = [];
    const tx: any = {
      execute: async (query: any) => {
        const rendered = dialect.sqlToQuery(query);
        if (rendered.sql.includes("SELECT counterKey, lastValue")) {
          return [[
            { counterKey: "unified_transaction_floor", lastValue: 100000 },
            { counterKey: "unified_transaction", lastValue: seq },
          ]];
        }
        if (rendered.sql.includes("FROM onlineOrders")) {
          if (rendered.params.includes("unified_transaction")) {
            // 1-shot reconciliation jumps across even a 500-invoice gap in one query
            floorReconciled = true;
            seq = 117000;
          }
          return [[]];
        }
        if (rendered.sql.includes("INSERT INTO documentCounters")) {
          executedKeys.push(rendered.params[0]);
          seq += 1;
          return [[]];
        }
        if (rendered.sql.includes("SELECT LAST_INSERT_ID()")) {
          return [[{ v: seq }]];
        }
        return [[]];
      },
      select: () => ({
        from: () => ({
          where: (cond: any) => {
            const rendered = dialect.sqlToQuery(cond);
            const candidate = String(rendered.params[0] ?? "");
            return {
              limit: async () =>
                occupied.has(candidate) ? [{ invoiceNumber: candidate }] : [],
            };
          },
        }),
      }),
    };

    const resolved = await resolveInvoiceNumberTx(tx, {});
    expect(floorReconciled).toBe(true);
    expect(resolved).toBe("117001");

    const directNextInv = await nextInvoiceNumber(tx, 1);
    expect(directNextInv).toBe("117002");
    expect(executedKeys.every((k) => k === "unified_transaction")).toBe(true);
  });

  it("ensureBranchStockRowsForAllBranches & ForBranch chunk cleanly and short-circuit on empty inputs", async () => {
    let inserts = 0;
    const txEmpty = {
      select: () => {
        throw new Error("should not query when variantIds is empty");
      },
      insert: () => {
        inserts++;
        throw new Error("should not insert");
      },
    } as any;
    await ensureBranchStockRowsForAllBranches(txEmpty, []);
    expect(inserts).toBe(0);

    const insertedBatches: Array<Array<{ variantId: number; branchId: number; quantity: number }>> = [];
    const makeTx = (branchesList: Array<{ id: number }>, variantsList: Array<{ id: number }>) =>
      ({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                orderBy: async () => variantsList,
              }),
            }),
            orderBy: async () => branchesList,
          }),
        }),
        insert: () => ({
          values: (vals: any) => {
            insertedBatches.push(vals);
            return {
              onDuplicateKeyUpdate: async () => undefined,
            };
          },
        }),
      }) as any;

    await ensureBranchStockRowsForAllBranches(makeTx([{ id: 2 }, { id: 1 }], []), [30, 10, 30]);
    expect(insertedBatches).toHaveLength(1);
    expect(insertedBatches[0]).toEqual([
      { variantId: 10, branchId: 2, quantity: 0 },
      { variantId: 10, branchId: 1, quantity: 0 },
      { variantId: 30, branchId: 2, quantity: 0 },
      { variantId: 30, branchId: 1, quantity: 0 },
    ]);

    insertedBatches.length = 0;
    const manyVariants = Array.from({ length: 505 }, (_, i) => ({ id: i + 1 }));
    await ensureBranchStockRowsForBranch(makeTx([], manyVariants), 7);
    expect(insertedBatches).toHaveLength(2);
    expect(insertedBatches[0]).toHaveLength(500);
    expect(insertedBatches[1]).toHaveLength(5);
    expect(insertedBatches[1][0].branchId).toBe(7);
  });
});
