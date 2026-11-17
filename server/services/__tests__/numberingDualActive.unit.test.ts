import { afterEach, describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  getDocumentCounterNode,
  nextCounterValue,
  nextTransactionTrackingNumber,
} from "../numbering";
import { nextConsignmentNumber } from "../delivery/numbering";
import {
  ensureBranchStockRowsForAllBranches,
  ensureBranchStockRowsForBranch,
} from "../inventory/stockLock";

const dialect = new MySqlDialect();

function makeMockTx(nextValue = 1) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    execute: async (query: any) => {
      const rendered = dialect.sqlToQuery(query);
      executed.push(rendered);
      if (rendered.sql.includes("SELECT counterKey, lastValue")) {
        return [[{ counterKey: "unified_transaction_floor", lastValue: 100050 }]];
      }
      if (rendered.sql.includes("SELECT COALESCE(MAX(")) {
        return [[{ legacyFloor: 0 }]];
      }
      if (rendered.sql.includes("SELECT LAST_INSERT_ID()")) {
        return [[{ v: nextValue }]];
      }
      return [[]];
    },
  } as any;
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
    expect(cloud.executed[0].params[0]).toBe("invoice:cloud");
    expect(cloud.executed[0].params[1]).toBe(10001);
    expect(cloud.executed[0].sql).toContain("MOD(lastValue + 1, 2)");

    process.env.ALROYA_NODE_ID = "local";
    const local = makeMockTx(10002);
    expect(await nextCounterValue(local.tx, "invoice")).toBe(10002);
    expect(local.executed[0].params[0]).toBe("invoice:local");
    expect(local.executed[0].params[1]).toBe(10002);
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
