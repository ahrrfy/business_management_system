import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { decideDecision, listDecisionInbox } from "../decisions";
import { createSale } from "../saleService";

const db = () => getDb()!;
const owner = {
  userId: 1,
  branchId: 1,
  role: "admin",
  isOwner: true,
  crossBranch: true,
  permissionsOverride: null,
};
const manager = {
  userId: 2,
  branchId: 1,
  role: "manager",
  isOwner: false,
  crossBranch: false,
  permissionsOverride: null,
};
const api = () =>
  appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: { cookie() {}, clearCookie() {} },
    user: { ...owner, id: owner.userId, isActive: true },
  } as never);

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Synthetic main", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "native-refund-owner",
        role: "admin",
        isOwner: true,
        branchId: 1,
        loginMethod: "local",
      },
      {
        id: 2,
        openId: "native-refund-manager",
        role: "manager",
        isOwner: false,
        branchId: 1,
        loginMethod: "local",
      },
    ]);
  await db()
    .insert(s.customers)
    .values({
      id: 1,
      name: "Synthetic registered customer",
      currentBalance: "0.00",
    });
  await db()
    .insert(s.products)
    .values({ id: 1, name: "Synthetic stocked item" });
  await db()
    .insert(s.productVariants)
    .values({
      id: 1,
      productId: 1,
      sku: "NATIVE-REFUND",
      costPrice: "4000.00",
    });
  await db()
    .insert(s.productUnits)
    .values({
      id: 1,
      variantId: 1,
      unitName: "piece",
      conversionFactor: "1",
      isBaseUnit: true,
    });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "10000.00" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 100 });
});

async function state(invoiceId: number) {
  return {
    invoice: await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, invoiceId)),
    items: await db()
      .select()
      .from(s.invoiceItems)
      .where(eq(s.invoiceItems.invoiceId, invoiceId)),
    receipts: await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.invoiceId, invoiceId)),
    entries: await db().select().from(s.accountingEntries),
    effects: await db()
      .select()
      .from(s.documentEffects)
      .where(
        and(
          eq(s.documentEffects.documentType, "INVOICE"),
          eq(s.documentEffects.documentId, invoiceId),
        ),
      ),
    movements: await db().select().from(s.inventoryMovements),
    stock: await db().select().from(s.branchStock),
    customer: await db().select().from(s.customers),
  };
}

describe("native legacy returns.create deferred refund inbox", () => {
  it("routes one real TRANSFER refund to its owner and settles its original effects once", async () => {
    // Native service/manual-reference contract: no CASH receipt mutation and no invented provider attempt.
    const sale = await createSale(
      {
        branchId: 1,
        customerId: 1,
        sourceType: "POS",
        clientRequestId: "native-transfer-sale",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "10" }],
        payment: {
          amount: "100000.00",
          method: "TRANSFER",
          reference: "SYNTHETIC-MANUAL-TRANSFER-100000",
        },
      },
      owner,
    );
    const sold = await state(sale.invoiceId);
    expect(sold.receipts).toHaveLength(1);
    expect(sold.receipts[0]).toMatchObject({
      paymentMethod: "TRANSFER",
      cashBucket: null,
      direction: "IN",
      amount: "100000.00",
      referenceNumber: "SYNTHETIC-MANUAL-TRANSFER-100000",
    });
    const input = {
      invoiceId: sale.invoiceId,
      lines: [{ invoiceItemId: sold.items[0]!.id, baseQuantity: 1 }],
      refund: { method: "TRANSFER" as const, amount: "10000.00" },
      restock: true,
      reason: "Synthetic native deferred refund acceptance",
      clientRequestId: "native-transfer-return",
    };
    const result = await api().returns.create(input);
    expect(result.mode).toBe("EXECUTED");
    const pending = await state(sale.invoiceId);
    const receipt = pending.receipts.find((row) => row.direction === "OUT")!;
    expect(receipt).toMatchObject({
      invoiceId: sale.invoiceId,
      paymentMethod: "TRANSFER",
      amount: "10000.00",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
      shiftId: null,
      partyType: "CUSTOMER",
      partyId: 1,
      createdBy: 1,
      internalNote: `SALE_CUSTOMER_REFUND:RETURN:${sale.invoiceId}`,
    });
    expect(receipt.referenceNumber).toMatch(
      new RegExp(`^SALE-RETURN-PENDING-${sale.invoiceId}-0-`),
    );
    expect(receipt.voucherNumber).toBeTruthy();
    expect(pending.invoice[0]).toMatchObject({
      total: "100000.00",
      returnedTotal: "10000.00",
      paidAmount: "100000.00",
    });
    expect(pending.stock[0]!.quantity).toBe(91);
    expect(pending.customer[0]!.currentBalance).toBe("-10000.00");
    // This legacy partial-return path keeps its pending obligation on invoice/customer.
    // It does not materialize the cancellation engine's documentEffects ledger.
    expect(pending.effects).toEqual([]);
    const inboxInput = { kind: "treasury.voucher.approve", branchId: 1 };
    const inbox = await listDecisionInbox(owner, inboxInput);
    expect(inbox.failedSources).toEqual([]);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]).toMatchObject({
      id: receipt.id,
      amount: "10000.00",
      requestedBy: 1,
      href: "/treasury?tab=vouchers",
      allowedActions: ["APPROVE", "REJECT"],
    });
    expect((await listDecisionInbox(manager, inboxInput)).rows).toEqual([]);
    const decision = {
      kind: inboxInput.kind,
      id: receipt.id,
      action: "APPROVE" as const,
      clientRequestId: "native-transfer-approval",
    };
    await expect(decideDecision(decision, manager)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await state(sale.invoiceId)).toEqual(pending);
    expect(await decideDecision(decision, owner)).toMatchObject({
      outcome: "EXECUTED",
    });
    const approved = await state(sale.invoiceId);
    expect(
      approved.receipts.find((row) => row.id === receipt.id),
    ).toMatchObject({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      invoiceId: sale.invoiceId,
      cashBucket: null,
      paymentMethod: "TRANSFER",
      referenceNumber: receipt.referenceNumber,
      internalNote: receipt.internalNote,
      createdBy: 1,
    });
    expect(approved.invoice[0]).toMatchObject({
      returnedTotal: "10000.00",
      paidAmount: "90000.00",
    });
    expect(approved.customer[0]!.currentBalance).toBe("0.00");
    expect(approved.stock).toEqual(pending.stock);
    expect(approved.movements).toEqual(pending.movements);
    expect(approved.items).toEqual(pending.items);
    expect(approved.receipts).toHaveLength(2);
    expect(approved.entries).toHaveLength(pending.entries.length + 1);
    expect(
      approved.entries.filter((row) => row.receiptId === receipt.id),
    ).toHaveLength(1);
    expect(approved.effects).toEqual([]);
    expect((await listDecisionInbox(owner, inboxInput)).rows).toEqual([]);
    expect(await decideDecision(decision, owner)).toMatchObject({
      outcome: "STALE",
    });
    const replay = await api().returns.create(input);
    expect(replay).toMatchObject({ mode: "EXECUTED", idempotentReplay: true });
    expect(await state(sale.invoiceId)).toEqual(approved);
  });
});
