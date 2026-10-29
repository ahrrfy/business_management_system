import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createStockTransfer,
  receiveStockTransfer,
  cancelStockTransfer,
} from "../transferService";
import { withTx } from "../tx";
import {
  lockEconomicInventoryScope,
  readEconomicOwnedPositions,
  readEconomicVariant,
} from "../inventory/economicOwnership";
import { lockInventoryVariants } from "../inventory/stockLock";
import {
  changeTransitProjection,
  parseTransitProjection,
} from "../inventory/transitProjection";
import * as inventory from "../inventoryService";

const db = () => {
  const d = getDb();
  if (!d) throw new Error("test DB missing");
  return d;
};
const actor = { userId: 1, role: "admin", branchId: 1 };
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
      { id: 2, name: "Sales", code: "SALES", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values({
      id: 1,
      openId: "projection-test",
      name: "Owner",
      role: "admin",
      branchId: 1,
    });
  await db()
    .insert(s.products)
    .values([
      { id: 1, name: "Owned" },
      { id: 2, name: "Other" },
    ]);
  await db()
    .insert(s.productVariants)
    .values([
      { id: 1, productId: 1, sku: "projection-1", costPrice: "100.00" },
      { id: 2, productId: 2, sku: "projection-2", costPrice: "200.00" },
    ]);
  await db()
    .insert(s.branchStock)
    .values([
      { variantId: 1, branchId: 1, quantity: 10 },
      { variantId: 2, branchId: 1, quantity: 10 },
    ]);
});
const dispatch = (quantity = 10, key?: string) =>
  withTx((tx) =>
    createStockTransfer(tx, {
      fromBranchId: 1,
      toBranchId: 2,
      items: [{ variantId: 1, baseQuantity: quantity }],
      createdBy: 1,
      clientRequestId: key,
    }),
  );
async function lineOf(id: number) {
  return (
    await db()
      .select()
      .from(s.stockTransferLines)
      .where(eq(s.stockTransferLines.transferId, id))
  )[0];
}
async function projection() {
  return (
    await db()
      .select()
      .from(s.productVariants)
      .where(eq(s.productVariants.id, 1))
  )[0].transitBaseBySourceBranch;
}

it("values owned shortage at current carrying cost after dispatch", async () => {
  const sent = await dispatch();
  await db()
    .update(s.productVariants)
    .set({ costPrice: "150.00" })
    .where(eq(s.productVariants.id, 1));
  const line = await lineOf(sent.transferId);
  await withTx((tx) =>
    receiveStockTransfer(tx, {
      transferId: sent.transferId,
      actor,
      lines: [{ lineId: line.id, quantityReceived: 8, note: "two lost" }],
    }),
  );
  const [loss] = await db()
    .select()
    .from(s.accountingEntries)
    .where(
      eq(s.accountingEntries.dedupeKey, `TRANSFER_LOSS:${sent.transferId}`),
    );
  expect(loss.cost).toBe("300.00");
});

it("does not require or fabricate historical owned cost when current carrying cost and dispatch quantities are proven", async () => {
  const sent = await dispatch(); const line = await lineOf(sent.transferId);
  await db().update(s.inventoryMovements).set({ notes: null });
  await withTx(tx => receiveStockTransfer(tx, { transferId: sent.transferId, actor, lines: [{ lineId: line.id, quantityReceived: 8, note: "lost" }] }));
  expect((await db().select().from(s.accountingEntries))[0].cost).toBe("200.00");
});

it("maintains source quantity on dispatch, receive with shortage, and exact replay", async () => {
  const sent = await dispatch(10, "projection-send");
  expect(await projection()).toEqual({ "1": "10" });
  await dispatch(10, "projection-send");
  expect(await projection()).toEqual({ "1": "10" });
  const line = await lineOf(sent.transferId);
  const args = {
    transferId: sent.transferId,
    actor,
    clientRequestId: "projection-receive",
    lines: [{ lineId: line.id, quantityReceived: 8, note: "two lost" }],
  };
  await withTx((tx) => receiveStockTransfer(tx, args));
  expect(await projection()).toEqual({});
  expect(
    (await withTx((tx) => receiveStockTransfer(tx, args))).idempotentReplay,
  ).toBe(true);
  expect(await projection()).toEqual({});
});

it("rolls back settlement on projection underflow, including stock and header", async () => {
  const sent = await dispatch();
  await db()
    .update(s.productVariants)
    .set({ transitBaseBySourceBranch: { "1": "9" } })
    .where(eq(s.productVariants.id, 1));
  await expect(
    withTx((tx) =>
      cancelStockTransfer(tx, { transferId: sent.transferId, actor }),
    ),
  ).rejects.toThrow(/projection|الإسقاط|بالطريق/);
  expect((await db().select().from(s.stockTransfers))[0].status).toBe(
    "IN_TRANSIT",
  );
  expect(
    (await db().select().from(s.branchStock)).map((r) => r.quantity),
  ).toEqual([0, 10]);
  expect(await projection()).toEqual({ "1": "9" });
});

it("rolls back already-written receive stock, loss and lines when final projection debit underflows", async () => {
  const sent = await dispatch();
  const line = await lineOf(sent.transferId);
  await db()
    .update(s.productVariants)
    .set({ transitBaseBySourceBranch: { "1": "9" } })
    .where(eq(s.productVariants.id, 1));
  await expect(
    withTx((tx) =>
      receiveStockTransfer(tx, {
        transferId: sent.transferId,
        actor,
        lines: [{ lineId: line.id, quantityReceived: 8, note: "lost" }],
      }),
    ),
  ).rejects.toThrow(/الإسقاط/);
  expect((await lineOf(sent.transferId)).quantityReceived).toBeNull();
  expect((await db().select().from(s.stockTransfers))[0].status).toBe(
    "IN_TRANSIT",
  );
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  expect(
    (await db().select().from(s.inventoryMovements)).filter(
      (m) => m.movementType === "TRANSFER_IN",
    ),
  ).toHaveLength(0);
  expect(await projection()).toEqual({ "1": "9" });
});

it("rolls back projection, document and saved components on dispatch movement fault", async () => {
  const fault = vi
    .spyOn(inventory, "applyMovement")
    .mockRejectedValueOnce(new Error("injected physical movement fault"));
  try {
    await expect(dispatch()).rejects.toThrow(
      "injected physical movement fault",
    );
  } finally {
    fault.mockRestore();
  }
  expect(await projection()).toEqual({});
  expect(await db().select().from(s.stockTransfers)).toHaveLength(0);
  expect(await db().select().from(s.stockTransferLines)).toHaveLength(0);
  expect(
    (await db().select().from(s.branchStock)).find((row) => row.variantId === 1)
      ?.quantity,
  ).toBe(10);
});

it("fails closed on missing, unready, malformed and NULL state", async () => {
  await db().update(s.inventoryProjectionState).set({ readyVersion: 0 });
  await expect(dispatch()).rejects.toThrow(/غير مهيأ/);
  await db().update(s.inventoryProjectionState).set({ readyVersion: 1 });
  await db()
    .update(s.productVariants)
    .set({ transitBaseBySourceBranch: null })
    .where(eq(s.productVariants.id, 1));
  await expect(dispatch()).rejects.toThrow(/غير مهيأ/);
  await db()
    .update(s.productVariants)
    .set({ transitBaseBySourceBranch: { "01": "2" } })
    .where(eq(s.productVariants.id, 1));
  await expect(dispatch()).rejects.toThrow(/معطوب/);
  await db().delete(s.inventoryProjectionState);
  await expect(dispatch()).rejects.toThrow(/غير مهيأ/);
  expect(await db().select().from(s.stockTransfers)).toHaveLength(0);
});

it("binds scope to gated active Tx and rejects late expansion or variant-first entry", async () => {
  await expect(
    db().transaction((tx) => lockEconomicInventoryScope(tx, [1])),
  ).rejects.toThrow();
  await expect(
    withTx((tx) => lockEconomicInventoryScope(tx, [1]), { gate: "NONE" }),
  ).rejects.toThrow();
  let captured: Parameters<typeof readEconomicVariant>[0] | undefined;
  let token: Awaited<ReturnType<typeof lockEconomicInventoryScope>> | undefined;
  await withTx(async (tx) => {
    captured = tx;
    token = await lockEconomicInventoryScope(tx, [1]);
    expect(await lockEconomicInventoryScope(tx, [1])).toBe(token);
    await expect(lockEconomicInventoryScope(tx, [1, 2])).rejects.toThrow(
      /نطاق/,
    );
  });
  await expect(readEconomicVariant(captured!, token!, 1)).rejects.toThrow();
  await withTx(
    async (tx) => {
      await lockEconomicInventoryScope(tx, [1]);
    },
    { gate: "GOVERNANCE" },
  );
  await expect(
    withTx(async (tx) => {
      await lockInventoryVariants(tx, [1]);
      await lockEconomicInventoryScope(tx, [1]);
    }),
  ).rejects.toThrow(/قبل أقفال/);
});

it("reads current own writes repeatedly and attributes transit to its source", async () => {
  await dispatch(5);
  await withTx(async (tx) => {
    const scope = await lockEconomicInventoryScope(tx, [1]);
    expect((await readEconomicOwnedPositions(tx, scope, 1)).positions).toEqual([
      {
        variantId: 1,
        branchId: 1,
        shelfQuantity: 5,
        inTransitQuantity: 5,
        ownedQuantity: 10,
      },
    ]);
    await tx
      .update(s.productVariants)
      .set({ costPrice: "123.00" })
      .where(eq(s.productVariants.id, 1));
    expect((await readEconomicVariant(tx, scope, 1)).costPrice).toBe("123.00");
    await tx
      .update(s.productVariants)
      .set({ costPrice: "124.00" })
      .where(eq(s.productVariants.id, 1));
    expect((await readEconomicVariant(tx, scope, 1)).costPrice).toBe("124.00");
  });
});

it("maintains separate source branches for the same physical variant", async () => {
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 2, quantity: 4 });
  const first = await dispatch(3);
  await withTx(tx => createStockTransfer(tx, { fromBranchId: 2, toBranchId: 1, items: [{ variantId: 1, baseQuantity: 2 }], createdBy: 1 }));
  expect(await projection()).toEqual({ "1": "3", "2": "2" });
  await withTx(tx => cancelStockTransfer(tx, { transferId: first.transferId, actor }));
  expect(await projection()).toEqual({ "2": "2" });
});

it("preserves saved consignment share while keeping quantity projection separate from owned value", async () => {
  await db().insert(s.suppliers).values({ id: 1, name: "Consignor", supplierKind: "CONSIGNOR" });
  await db().update(s.products).set({ isConsignment: true, consignorId: 1 }).where(eq(s.products.id, 1));
  const sent = await dispatch(); const line = await lineOf(sent.transferId);
  await db().update(s.productVariants).set({ costPrice: "150.00" }).where(eq(s.productVariants.id, 1));
  await withTx(async tx => { const scope = await lockEconomicInventoryScope(tx, [1]); expect((await readEconomicOwnedPositions(tx, scope, 1)).positions).toEqual([]); });
  await withTx(tx => receiveStockTransfer(tx, { transferId: sent.transferId, actor, lines: [{ lineId: line.id, quantityReceived: 8, note: "lost" }] }));
  expect((await db().select().from(s.accountingEntries))[0].cost).toBe("200.00");
  expect((await db().select().from(s.suppliers))[0].currentBalance).toBe("200.00");
  expect(await projection()).toEqual({});
});

it("rejects invalid quantities/branches and arithmetic overflow without rounding", () => {
  for (const value of [
    null,
    [],
    { "0": "1" },
    { "1": "-1" },
    { "1": "1.2" },
    { "1": "01" },
    { "1": "9007199254740992" },
  ])
    expect(() => parseTransitProjection(value)).toThrow();
  expect(() =>
    changeTransitProjection({ "1": "9007199254740991" }, 1, 1),
  ).toThrow();
  expect(() => changeTransitProjection({ "1": "1" }, 1, -2)).toThrow();
  expect(changeTransitProjection({ "1": "1" }, 1, -1)).toEqual({});
});
