import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { declareConsignmentReturn } from "../delivery/declaredReturn";
import { declareShipmentReturn, returnShipment } from "../delivery/shipmentOperations";

const actor = { userId: 1, branchId: 1, role: "cashier" };
const request = { consignmentId: 11, reason: "رفض العميل الاستلام", statementNumber: "RETURN-STMT-1", clientRequestId: "declare-shipment-return-1" };
function db() { const value = getDb(); if (!value) throw new Error("Isolated test DB is required"); return value; }

beforeEach(async () => {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }, { id: 2, name: "الثاني", code: "B2", type: "SALES" }]);
  await db().insert(s.users).values({ id: 1, openId: "shipment-return-cashier", role: "cashier", branchId: 1 });
  await db().insert(s.customers).values({ id: 1, name: "عميل الشحنة", currentBalance: "300.00", creditLimit: null });
  await db().insert(s.deliveryParties).values({ id: 1, name: "شركة التوصيل", partyType: "COMPANY", currentBalance: "0.00", isActive: true });
  await db().insert(s.products).values({ id: 1, name: "دفتر" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "DECLARED-SHIPMENT-NB", costPrice: "40.00" });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 7 });
  for (const [index, total] of [100, 200].entries()) {
    const invoiceId = index + 1;
    const consignmentId = 11 + index;
    await db().insert(s.invoices).values({ id: invoiceId, invoiceNumber: `DECLARE-SHIPMENT-INV-${invoiceId}`, branchId: 1, customerId: 1, subtotal: String(total), total: String(total), paidAmount: "0.00", createdBy: 1 });
    await db().insert(s.invoiceItems).values({ invoiceId, variantId: 1, quantity: String(invoiceId), baseQuantity: invoiceId, unitPrice: "100.00", unitCost: "40.00", lineCost: String(invoiceId * 40), total: String(total) });
    await db().insert(s.inventoryMovements).values({ variantId: 1, branchId: 1, quantity: invoiceId, movementType: "OUT", referenceType: "INVOICE", referenceId: invoiceId, createdBy: 1 });
    await db().insert(s.deliveryConsignments).values({ id: consignmentId, consignmentNumber: `DECLARE-SHIPMENT-CN-${consignmentId}`, partyId: 1, branchId: 1, invoiceId, sourceId: invoiceId, sourceType: "INVOICE", endCustomerId: 1, codAmount: String(total), deliveryFee: "0.00", feeCollection: "COURIER", parcelStatus: "OUT_FOR_DELIVERY", dispatchedBy: 1 });
    await db().insert(s.deliveryShipmentMembers).values({ consignmentId, leaderConsignmentId: 11, createdBy: 1 });
    await db().insert(s.deliveryLedgerEntries).values({ eventKey: `DECLARE-SHIPMENT:${consignmentId}:ASSIGNED`, partyId: 1, branchId: 1, consignmentId, entryType: "COD_ASSIGNED", amount: String(total), createdBy: 1 });
  }
});

async function snapshot() {
  return { cn: await db().select().from(s.deliveryConsignments), invoices: await db().select().from(s.invoices), customers: await db().select().from(s.customers), stock: await db().select().from(s.branchStock), movements: await db().select().from(s.inventoryMovements), parties: await db().select().from(s.deliveryParties), receipts: await db().select().from(s.receipts), entries: await db().select().from(s.accountingEntries), ledger: await db().select().from(s.deliveryLedgerEntries), events: await db().select().from(s.deliveryEvents), keys: await db().select().from(s.idempotencyKeys) };
}

describe("whole-shipment return declaration", () => {
  it("declares every invoice and releases expected COD without changing stock, invoices or cash; replay cannot release twice", async () => {
    const before = await snapshot();
    expect(await declareShipmentReturn(request, actor)).toMatchObject({ consignmentId: 11, consignmentIds: [11, 12], idempotentReplay: false });
    const declared = await snapshot();
    expect(declared.cn.map((row) => row.returnDeclaredAt != null)).toEqual([true, true]);
    expect(declared.cn.map((row) => row.parcelStatus)).toEqual(["OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY"]);
    expect(declared.cn.every((row) => row.returnDeclaredReason?.includes("RETURN-STMT-1"))).toBe(true);
    expect(declared.ledger.filter((row) => row.entryType === "COD_RELEASED").map((row) => row.amount)).toEqual(["100.00", "200.00"]);
    for (const field of ["invoices", "customers", "stock", "movements", "parties", "receipts", "entries"] as const) expect(declared[field]).toEqual(before[field]);
    expect((await declareShipmentReturn({ ...request, consignmentId: 12 }, actor)).idempotentReplay).toBe(true);
    await expect(declareShipmentReturn({ ...request, clientRequestId: "another-declaration" }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(declared);
  });

  it("serializes concurrent duplicate declarations with exactly one release per invoice", async () => {
    const results = await Promise.all([declareShipmentReturn(request, actor), declareShipmentReturn(request, actor)]);
    expect(results.filter((row) => row.idempotentReplay)).toHaveLength(1);
    expect((await snapshot()).ledger.filter((row) => row.entryType === "COD_RELEASED")).toHaveLength(2);
  });

  it("rolls back earlier member changes when a later member has already collected money", async () => {
    await db().update(s.deliveryConsignments).set({ collectedAmount: "10.00" }).where(eq(s.deliveryConsignments.id, 12));
    const before = await snapshot();
    await expect(declareShipmentReturn(request, actor)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await snapshot()).toEqual(before);
  });

  it("checks branch scope before replay and rejects changed statement payload", async () => {
    await declareShipmentReturn(request, actor);
    const before = await snapshot();
    await expect(declareShipmentReturn(request, { ...actor, branchId: 2 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(declareShipmentReturn(request, { ...actor, branchId: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(declareShipmentReturn({ ...request, statementNumber: "OTHER-STMT" }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the physical receipt path usable and never releases COD again after return", async () => {
    await declareShipmentReturn(request, actor);
    await returnShipment({ consignmentId: 12, reason: "وصلت الشحنة وفُحصت", clientRequestId: "receive-declared-shipment" }, actor);
    const state = await snapshot();
    expect(state.cn.map((row) => row.parcelStatus)).toEqual(["RETURNED", "RETURNED"]);
    expect(state.stock[0].quantity).toBe(10);
    expect(state.invoices.map((row) => row.returnedTotal)).toEqual(["100.00", "200.00"]);
    expect(state.ledger.filter((row) => row.entryType === "COD_RELEASED").map((row) => row.amount)).toEqual(["100.00", "200.00"]);
  });

  it("preserves declarations without a request key and the direct-member guard", async () => {
    await expect(declareConsignmentReturn({ consignmentId: 12, reason: request.reason }, actor)).rejects.toThrow(/الشحنة/);
    await declareShipmentReturn({ consignmentId: 11, reason: request.reason, clientRequestId: null }, actor);
    const before = await snapshot();
    await expect(declareShipmentReturn({ consignmentId: 11, reason: request.reason }, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await snapshot()).toEqual(before);
  });
});
