import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { checkoutReception } from "../receptionCheckoutService";
import { confirmExternalPaymentAttempt, initiateExternalPaymentAttempt } from "../posExternalPayment";
import { collectDeposit, commitDraft, promoteDraft } from "../reception";
import { approveWorkOrderControlRequest, requestWorkOrderControl } from "../workOrder/controlRequests";
import { deliverWorkOrder } from "../workOrder/deliver";
import { prepareWorkOrderDeliveryInvoiceInTx } from "../delivery/dispatch";
import { withTx } from "../tx";
import { loadWorkOrderDepositReceiptSet } from "../workOrder/depositReceiptSet";

const actor = { userId: 2, branchId: 1, role: "cashier" } as const;
const device = "RECEPTION-SPLIT-DEVICE";
const db = () => getDb()!;
let seq = 0;
const key = () => `reception-split-${Date.now()}-${++seq}`;

beforeEach(async () => {
  await db().insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 2, openId: "split-cashier", name: "Cashier", role: "cashier", branchId: 1 });
  await db().insert(s.users).values({ id: 3, openId: "split-admin", name: "Admin", role: "admin", branchId: 1, isOwner: true });
  await db().insert(s.customers).values({ id: 1, name: "عميل محفوظ", phone: "07701234567", creditLimit: "100000" });
  await db().insert(s.products).values([
    { id: 1, name: "Goods" },
    { id: 2, name: "Print", productType: "PRINT_SERVICE", isService: true },
  ]);
  await db().insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SPLIT-GOODS", costPrice: "100" },
    { id: 2, productId: 2, sku: "SPLIT-PRINT", costPrice: "0" },
  ]);
  await db().insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "piece", conversionFactor: 1, isBaseUnit: true },
    { id: 2, variantId: 2, unitName: "service", conversionFactor: 1, isBaseUnit: true },
  ]);
  await db().insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "1000" },
    { productUnitId: 2, priceTier: "RETAIL", price: "1000" },
  ]);
  await db().insert(s.branchStock).values({ branchId: 1, variantId: 1, quantity: 100 });
  await db().insert(s.shifts).values({ id: 1, userId: 2, branchId: 1, shiftType: "RECEPTION", status: "OPEN", openingBalance: "5000", openGuard: "1:2:RECEPTION" });
});

async function card(amount: string) {
  const initiated = await initiateExternalPaymentAttempt({ branchId: 1, channel: "PRINT_POS", method: "CARD", amount, reference: key(), requestId: key(), deviceId: device }, actor);
  await confirmExternalPaymentAttempt({ branchId: 1, channel: "PRINT_POS", attemptId: initiated.attemptId, deviceId: device }, actor);
  return { method: "CARD" as const, amount, externalPaymentAttemptId: initiated.attemptId, externalPaymentDeviceId: device };
}
function input(payments: unknown[], extra: Record<string, unknown> = {}) {
  return { branchId: 1, shiftId: 1, customerId: 1, clientRequestId: key(),
    regularSale: { amount: "1000.00", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] },
    printSale: { amount: "1000.00", lines: [{ variantId: 2, productUnitId: 2, quantity: "1" }] },
    payments, ...extra } as any;
}
async function noEffects() {
  expect(await db().select().from(s.invoices)).toHaveLength(0);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  expect((await db().select().from(s.branchStock))[0].quantity).toBe(100);
}

describe("Reception split tender atomic contract", () => {
  it("does not classify a later linked receipt as a zero creation deposit", async () => {
    const payload = input([], { regularSale: undefined, printSale: undefined, paidAmount: "0.00", workOrders: [{ title: "No initial deposit", quantity: 1, salePrice: "1000.00" }] });
    delete payload.payments;
    const result = await checkoutReception(payload, actor);
    const [order] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, result.workOrders[0].workOrderId));
    await db().insert(s.receipts).values({ workOrderId: order.id, branchId: 1, shiftId: 1, direction: "IN", amount: "10.00", paymentMethod: "CASH", voucherNumber: key(), status: "COMPLETED", approvalStatus: "APPROVED", createdBy: 2 });
    expect(await withTx(tx => loadWorkOrderDepositReceiptSet(tx, order, "0.00"))).toEqual([]);
  });
  it("allocates cash + card across goods and print, consumes proof once and replays exact metadata", async () => {
    const proof = await card("1500.00");
    const payload = input([{ method: "CASH", amount: "500.00" }, proof], { paidAmount: "2000.00" });
    const result = await checkoutReception(payload, actor) as any;
    expect(result.paymentSummary).toEqual({ tenderedAmount: "2000.00", appliedAmount: "2000.00", changeAmount: "0.00" });
    expect(result.paymentAllocations).toHaveLength(3);
    const rows = await db().select().from(s.receipts);
    expect(rows.filter(r => r.paymentMethod === "CASH").map(r => [r.amount, r.cashBucket])).toEqual([["500.00", "DRAWER"]]);
    expect(rows.filter(r => r.paymentMethod === "CARD").map(r => [r.amount, r.cashBucket])).toEqual([["500.00", null], ["1000.00", null]]);
    expect((await db().select().from(s.invoices)).map(r => r.paymentMethod)).toEqual(["MIXED", "CARD"]);
    expect((await db().select().from(s.externalPaymentAttempts))[0].consumedAt).not.toBeNull();
    const replay = await checkoutReception(payload, actor) as any;
    expect(replay.paymentSummary).toEqual(result.paymentSummary);
    expect(replay.paymentAllocations).toEqual(result.paymentAllocations);
    expect(await db().select().from(s.receipts)).toHaveLength(3);
  });

  it("returns change from cash only and records exact noncash", async () => {
    const result = await checkoutReception(input([{ method: "CASH", amount: "900.00" }, await card("1500.00")]), actor) as any;
    expect(result.paymentSummary).toEqual({ tenderedAmount: "2400.00", appliedAmount: "2000.00", changeAmount: "400.00" });
    expect((await db().select().from(s.receipts)).filter(r => r.paymentMethod === "CASH").map(r => r.amount)).toEqual(["500.00"]);
  });

  it("rejects an applied amount echo mismatch without business effects", async () => {
    await expect(checkoutReception(input([{ method: "CASH", amount: "1000.00" }, await card("1000.00")], { paidAmount: "1999.00" }), actor)).rejects.toThrow();
    await noEffects();
  });

  it.each(["amount", "device", "reuse"])("rejects wrong proof %s atomically", async kind => {
    const proof = await card(kind === "amount" ? "999.00" : "1000.00");
    if (kind === "device") proof.externalPaymentDeviceId = "WRONG-DEVICE";
    if (kind === "reuse") {
      await expect(checkoutReception(input([proof, proof]), actor)).rejects.toThrow();
    } else {
      await expect(checkoutReception(input([{ method: "CASH", amount: "1000.00" }, { ...proof, amount: "1000.00" }]), actor)).rejects.toThrow();
    }
    await noEffects();
  });

  it("rolls back all documents and proof consumption when a later print amount is invalid", async () => {
    const proof = await card("1500.00");
    await expect(checkoutReception(input([{ method: "CASH", amount: "500.00" }, proof], { printSale: { amount: "1000.00", lines: [{ variantId: 2, productUnitId: 1, quantity: "1" }] } }), actor)).rejects.toThrow();
    await noEffects();
    expect((await db().select().from(s.externalPaymentAttempts))[0].consumedAt).toBeNull();
  });

  it("draft applies held deposit first and returns only newly collected allocations on replay", async () => {
    const draft = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [{ lineKind: "GOODS", variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1000.00", title: "Goods" }] }, actor);
    const held = await collectDeposit({ draftId: draft.draftId, amount: "200.00", method: "CASH", clientRequestId: key() }, actor);
    const current = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, draft.draftId)))[0];
    const payload = { draftId: draft.draftId, version: current.version, expectedTotal: "1000.00", shiftId: 1, payments: [{ method: "CASH", amount: "300.00" }, await card("500.00")] } as any;
    const result = await commitDraft(payload, actor) as any;
    expect(result.heldApplied).toBe("200.00");
    expect(result.paymentSummary.appliedAmount).toBe("800.00");
    expect(result.paymentAllocations).toHaveLength(2);
    expect(result.paymentAllocations.some((a: any) => a.receiptId === held.receiptId)).toBe(false);
    expect((await db().select().from(s.invoices))[0].paymentMethod).toBe("MIXED");
    const replay = await commitDraft(payload, actor) as any;
    expect(replay.paymentAllocations).toEqual(result.paymentAllocations);
    expect(replay.paymentSummary).toEqual(result.paymentSummary);
    expect(await db().select().from(s.receipts)).toHaveLength(3);
  });

  it("posts split work-order deposits as real per-rail receipts", async () => {
    const result = await checkoutReception(input([{ method: "CASH", amount: "400.00" }, await card("600.00")], { regularSale: undefined, printSale: undefined, workOrders: [{ title: "Custom", quantity: 1, salePrice: "1000.00" }] }), actor) as any;
    const [wo] = await db().select().from(s.workOrders);
    expect(wo.deposit).toBe("1000.00");
    expect(result.paymentAllocations).toHaveLength(2);
    expect((await db().select().from(s.receipts).where(eq(s.receipts.workOrderId, wo.id))).map(r => r.amount)).toEqual(["400.00", "600.00"]);
  });

  it("links every native deposit receipt and derives MIXED at work-order handover", async () => {
    const result = await checkoutReception(input([{ method: "CASH", amount: "400.00" }, await card("600.00")], { regularSale: undefined, printSale: undefined, workOrders: [{ title: "Custom", quantity: 1, salePrice: "1000.00" }] }), actor);
    const id = result.workOrders[0].workOrderId;
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, id));
    const delivered = await deliverWorkOrder({ workOrderId: id, clientRequestId: key() }, actor);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, delivered.invoiceId)))[0].paymentMethod).toBe("MIXED");
    expect(await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, delivered.invoiceId))).toHaveLength(2);
  });

  it("refunds native split deposits using their actual rails without duplicating cash", async () => {
    const result = await checkoutReception(input([{ method: "CASH", amount: "400.00" }, await card("600.00")], { regularSale: undefined, printSale: undefined, workOrders: [{ title: "Custom", quantity: 1, salePrice: "1000.00" }] }), actor);
    const [before] = await db().select().from(s.workOrders).where(eq(s.workOrders.id, result.workOrders[0].workOrderId));
    const request = await requestWorkOrderControl({ workOrderId: before.id, requestKey: key(), requestType: "CANCEL", baseVersion: before.version, reason: "إلغاء طلب العميل", payload: { refundShiftId: 1, materials: null } }, actor);
    await approveWorkOrderControlRequest(Number(request.id), { userId: 3, role: "admin", branchId: 1 }, "راجعت رد العربون على وسيلتي القبض");
    const rows = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(rows.map(r => [r.paymentMethod, r.amount, r.status])).toEqual([["CASH", "400.00", "COMPLETED"], ["CARD", "600.00", "PENDING"]]);
  });

  it("binds an independent delivery-fee proof separately from the new goods legs", async () => {
    const fee = await card("100.00");
    const result = await checkoutReception(input([{ method: "CASH", amount: "400.00" }, await card("600.00")], { regularSale: undefined, printSale: undefined, workOrders: [{ title: "Delivered custom", quantity: 1, salePrice: "1000.00", hasDelivery: true, deliveryCost: "100.00", deliveryFeeCollection: "COUNTER" }], deliveryFeeHeld: "100.00", deliveryFeeTender: fee }), actor) as any;
    expect(result.paymentSummary.appliedAmount).toBe("1000.00");
    expect(result.paymentAllocations).toHaveLength(2);
    expect(await db().select().from(s.receipts)).toHaveLength(3);
    expect((await db().select().from(s.externalPaymentAttempts)).every(r => r.consumedAt != null)).toBe(true);
  });

  it("combined fee indexes the selected leg and requires exactly goods plus fee", async () => {
    const proof = await card("700.00");
    const result = await checkoutReception(input([{ method: "CASH", amount: "400.00" }, { ...proof, amount: "600.00" }], { regularSale: undefined, printSale: undefined, workOrders: [{ title: "Delivered custom", quantity: 1, salePrice: "1000.00", hasDelivery: true, deliveryCost: "100.00", deliveryFeeCollection: "COUNTER" }], deliveryFeeHeld: "100.00", deliveryFeeTender: { ...proof, combinedWithPaymentIndex: 1 } }), actor) as any;
    expect(result.paymentSummary.tenderedAmount).toBe("1000.00");
    expect(result.paymentAllocations).toHaveLength(2);
    expect((await db().select().from(s.externalPaymentAttempts))[0].consumedAt).not.toBeNull();
  });

  it("rejects reusing an already consumed proof for a new checkout", async () => {
    const proof = await card("1000.00");
    await checkoutReception(input([{ method: "CASH", amount: "1000.00" }, proof]), actor);
    await expect(checkoutReception(input([{ method: "CASH", amount: "1000.00" }, proof]), actor)).rejects.toThrow();
    expect(await db().select().from(s.invoices)).toHaveLength(2);
    expect(await db().select().from(s.receipts)).toHaveLength(2);
  });

  it("COD fully funds print first and assigns only the goods remainder to the courier", async () => {
    await db().insert(s.deliveryParties).values({ id: 1, name: "Courier", partyType: "INDIVIDUAL", branchId: 1, isActive: true, currentBalance: "0" });
    const result = await checkoutReception(input([{ method: "CASH", amount: "100.00" }, await card("900.00")], { delivery: { partyId: 1, fee: "0", feeCollection: "COURIER", recipientName: "عميل", recipientPhone: "07701234567", address: "بغداد" } }), actor) as any;
    expect(result.dispatch.codAmount).toBe("1000.00");
    expect(result.paymentAllocations.every((a: any) => a.invoiceId === result.printSale.invoiceId)).toBe(true);
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, result.regularSale.invoiceId)))[0].paidAmount).toBe("0.00");
  });

  it("all-cash split preserves full-cash rounding and returns raw cash change", async () => {
    await db().update(s.productPrices).set({ price: "1060.00" }).where(eq(s.productPrices.productUnitId, 1));
    const result = await checkoutReception(input([{ method: "CASH", amount: "600.00" }, { method: "CASH", amount: "600.00" }], { printSale: undefined, cashRoundIQD: true }), actor) as any;
    expect(result.regularSale.total).toBe("1000.00");
    expect(result.paymentSummary).toEqual({ tenderedAmount: "1200.00", appliedAmount: "1000.00", changeAmount: "200.00" });
  });

  it("partial all-cash credit ignores rounding flags and keeps the raw obligation", async () => {
    await db().update(s.productPrices).set({ price: "1060.00" }).where(eq(s.productPrices.productUnitId, 1));
    const result = await checkoutReception(input([{ method: "CASH", amount: "200.00" }, { method: "CASH", amount: "300.00" }], { regularSale: { amount: "1060.00", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] }, printSale: undefined, cashRoundIQD: true, deferredDirect: true, paymentMode: "CREDIT", paidAmount: "500.00" }), actor) as any;
    expect(result.regularSale.total).toBe("1060.00");
    expect((await db().select().from(s.invoices))[0].paidAmount).toBe("500.00");
    expect((await db().select().from(s.accountingEntries)).some(r => r.entryType === "ADJUST")).toBe(false);
  });

  it("accepts the exact rounded-down full tender below the raw basket", async () => {
    await db().update(s.productPrices).set({ price: "1060.00" }).where(eq(s.productPrices.productUnitId, 1));
    const result = await checkoutReception(input([{ method: "CASH", amount: "600.00" }, { method: "CASH", amount: "400.00" }], { printSale: undefined, cashRoundIQD: true, paidAmount: "1000.00" }), actor) as any;
    expect(result.regularSale.total).toBe("1000.00");
    expect(result.paymentSummary).toEqual({ tenderedAmount: "1000.00", appliedAmount: "1000.00", changeAmount: "0.00" });
  });

  it("mixed tender ignores cash-rounding flags and retains exact money", async () => {
    await db().update(s.productPrices).set({ price: "1060.00" }).where(eq(s.productPrices.productUnitId, 1));
    const result = await checkoutReception(input([{ method: "CASH", amount: "460.00" }, await card("600.00")], { regularSale: { amount: "1060.00", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] }, printSale: undefined, cashRoundIQD: true }), actor) as any;
    expect(result.regularSale.total).toBe("1060.00");
    expect(result.paymentSummary.appliedAmount).toBe("1060.00");
    expect((await db().select().from(s.accountingEntries)).some(r => r.entryType === "ADJUST")).toBe(false);
  });

  it("rejects array/scalar conflicts and edited replay payloads", async () => {
    const proof = await card("1000.00");
    await expect(checkoutReception(input([{ method: "CASH", amount: "1000.00" }, proof], { paymentMethod: "CASH" }), actor)).rejects.toThrow();
    await noEffects();
    const payload = input([{ method: "CASH", amount: "1000.00" }, proof]);
    await checkoutReception(payload, actor);
    await expect(checkoutReception({ ...payload, payments: [{ method: "CASH", amount: "2000.00" }] }, actor)).rejects.toThrow();
  });

  it("keeps split draft replay bound to its original tender array", async () => {
    const draft = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: [{ lineKind: "GOODS", variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1000.00", title: "Goods" }] }, actor);
    const row = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, draft.draftId)))[0];
    const payload = { draftId: draft.draftId, version: row.version, expectedTotal: "1000.00", shiftId: 1, payments: [{ method: "CASH", amount: "400.00" }, await card("600.00")] } as any;
    await commitDraft(payload, actor);
    await expect(commitDraft({ ...payload, payments: [{ method: "CASH", amount: "1000.00" }] }, actor)).rejects.toThrow();
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });

  it("delivery materialization links every native deposit receipt and derives its actual methods", async () => {
    await db().insert(s.deliveryParties).values({ id: 1, name: "Courier", partyType: "INDIVIDUAL", branchId: 1, isActive: true, currentBalance: "0" });
    const checkout = await checkoutReception(input([{ method: "CASH", amount: "400.00" }, await card("600.00")], { regularSale: undefined, printSale: undefined, workOrders: [{ title: "Custom delivery", quantity: 1, salePrice: "1000.00", hasDelivery: true }] }), actor);
    const id = checkout.workOrders[0].workOrderId;
    await db().update(s.workOrders).set({ status: "READY" }).where(eq(s.workOrders.id, id));
    const prepared = await withTx(tx => prepareWorkOrderDeliveryInvoiceInTx(tx, { workOrderId: id, partyId: 1, requestId: 1 }, { userId: 3, role: "admin", branchId: 1 }));
    expect((await db().select().from(s.invoices).where(eq(s.invoices.id, prepared.invoiceId)))[0].paymentMethod).toBe("MIXED");
    expect(await db().select().from(s.receipts).where(eq(s.receipts.invoiceId, prepared.invoiceId))).toHaveLength(2);
  });

  it("rejects digital products even when disguised as work-order bases", async () => {
    await db().update(s.products).set({ productType: "DIGITAL_CARD" }).where(eq(s.products.id, 1));
    await expect(checkoutReception(input([{ method: "CASH", amount: "400.00" }, { method: "CASH", amount: "600.00" }], { regularSale: undefined, printSale: undefined, workOrders: [{ title: "Unsupported digital custom", baseVariantId: 1, baseProductUnitId: 1, quantity: 1, salePrice: "1000.00" }] }), actor)).rejects.toThrow(/رقمية/);
    await noEffects();
    expect(await db().select().from(s.workOrders)).toHaveLength(0);
  });
});
