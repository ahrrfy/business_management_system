import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createConfirmedPosSale,
  initiateExternalPaymentAttempt,
  confirmExternalPaymentAttempt,
} from "../posExternalPayment";
import { cancelDeliveryAssignment } from "../delivery/cancellation";
import { dispatchInvoiceToDelivery } from "../delivery/dispatchInvoice";
import { dispatchInvoiceShipment } from "../delivery/shipments";
import {
  previewExcessFeeRefund,
  requestExcessFeeRefund,
} from "../delivery/excessFeeRefund";
import { approveDeliveryPaymentRefund } from "../delivery/paymentRefunds";
import { createWorkOrder } from "../workOrderService";
import { approveWorkOrderCancellationRefund } from "../workOrder/cancel";
import { prepareWorkOrderDeliveryInvoiceInTx } from "../delivery/dispatch";
import { createFulfillmentRequest } from "../fulfillment/requests";
import { withTx } from "../tx";
import { money } from "../money";
import { getCustomerStatement } from "../reportsService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "cashier" } as const,
  owner = { userId: 2, branchId: 1, role: "admin" } as const;
const db = () => getDb()!;
let serial = 0;
const key = () => `excess-${Date.now()}-${++serial}`,
  deviceId = "EXCESS-FEE-DEVICE";
beforeEach(async () => {
  await truncateTables([
    "journalLines",
    "journalEntries",
    "doubleEntrySettings",
    "documentEffects",
    "externalPaymentAttempts",
    "auditLogs",
    "idempotencyKeys",
    "accountingEntries",
    "receipts",
    "deliveryShipmentMembers",
    "deliveryOutbox",
    "deliveryEvents",
    "deliveryLedgerEntries",
    "deliveryRemittanceLines",
    "deliveryRemittances",
    "deliveryConsignments",
    "deliveryPartyMembers",
    "deliveryParties",
    "inventoryMovements",
    "invoiceItems",
    "invoices",
    "workOrders",
    "branchStock",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "shifts",
    "customers",
    "branches",
    "users",
  ]);
  await db()
    .insert(s.branches)
    .values([
      { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
      { id: 2, name: "OTHER", code: "OTHER", type: "SALES" },
    ]);
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "excess-cashier",
        name: "Cashier",
        role: "cashier",
        branchId: 1,
      },
      {
        id: 2,
        openId: "excess-owner",
        name: "Owner",
        role: "admin",
        branchId: 1,
        isOwner: true,
      },
      {
        id: 3,
        openId: "excess-manager",
        name: "Manager",
        role: "manager",
        branchId: 1,
      },
    ]);
  await db().insert(s.customers).values({
    id: 1,
    name: "Buyer",
    currentBalance: "0",
    creditLimit: "1000000",
  });
  await db().insert(s.deliveryParties).values({
    id: 1,
    name: "Company",
    partyType: "COMPANY",
    branchId: 1,
    defaultFee: "5000",
    currentBalance: "0",
  });
  await db().insert(s.products).values({ id: 1, name: "Book" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "EXCESS-BOOK", costPrice: "1000" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "piece",
    conversionFactor: 1,
    isBaseUnit: true,
  });
  await db()
    .insert(s.productPrices)
    .values({ productUnitId: 1, priceTier: "RETAIL", price: "50000" });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 20 });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    shiftType: "RECEPTION",
    openingBalance: "0",
    status: "OPEN",
    openGuard: "1:1:RECEPTION",
  });
});
async function proof(
  amount: string,
  channel: "POS" | "PRINT_POS" = "POS",
  method: "CARD" | "TRANSFER" | "WALLET" = "CARD",
) {
  const p = await initiateExternalPaymentAttempt(
    {
      branchId: 1,
      channel,
      method,
      amount,
      reference: key(),
      requestId: key(),
      deviceId,
    },
    actor,
  );
  await confirmExternalPaymentAttempt(
    { attemptId: p.attemptId, branchId: 1, channel, deviceId },
    actor,
  );
  return p.attemptId;
}
async function sale(method: "CASH" | "CARD" | "TRANSFER" | "WALLET") {
  const attemptId =
    method === "CASH" ? undefined : await proof("55000", "POS", method);
  const sold = await createConfirmedPosSale(
    {
      branchId: 1,
      shiftId: 1,
      customerId: 1,
      deviceId,
      sourceType: "POS",
      clientRequestId: key(),
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { method, amount: "50000", externalPaymentAttemptId: attemptId },
      deliveryFeeHeld: "5000",
      ...(method === "CASH"
        ? {}
        : { deliveryFeeTender: { method, combinedWithPaymentIndex: 0 } }),
      delivery: {
        partyId: 1,
        fee: "5000",
        feeCollection: "COUNTER",
        externalTrackingRef: key(),
        recipientPhone: "07700000000",
      },
    },
    actor,
  );
  const cn = (
    await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.invoiceId, sold.invoiceId))
  )[0];
  await cancelDeliveryAssignment(
    {
      consignmentId: cn.id,
      reason: "combine before physical dispatch",
      clientRequestId: key(),
    },
    actor,
  );
  const invoice = (
    await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, sold.invoiceId))
  )[0];
  return {
    ...sold,
    invoice,
    cn,
    printed: `INV-${invoice.invoiceNumber.replace(/^INV[-|]/i, "")}`,
  };
}
async function requestFor(printed: string) {
  const p = await previewExcessFeeRefund({ documentNumber: printed }, actor);
  if (!p.eligible) throw new Error(p.blockReason);
  return {
    preview: p,
    input: {
      sourceKind: p.sourceKind,
      sourceId: p.sourceId,
      expectedReceiptId: p.receipt.id,
      expectedAmount: p.amount,
      reason: "duplicate fee before group",
      clientRequestId: key(),
      refundShiftId: p.receipt.method === "CASH" ? 1 : undefined,
    },
  };
}
function groupInput(
  a: Awaited<ReturnType<typeof sale>>,
  b: Awaited<ReturnType<typeof sale>>,
) {
  return {
    invoiceId: a.invoiceId,
    invoiceIds: [a.invoiceId, b.invoiceId],
    partyId: 1,
    deliveryFee: "5000",
    feeCollection: "COUNTER" as const,
    externalTrackingRef: a.cn.externalTrackingRef,
    recipientPhone: "07700000000",
    clientRequestId: key(),
  };
}
async function cashNet() {
  return (
    await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.paymentMethod, "CASH"),
          eq(s.receipts.status, "COMPLETED"),
        ),
      )
  )
    .reduce(
      (n, r) => n.plus(money(r.amount).times(r.direction === "IN" ? 1 : -1)),
      money(0),
    )
    .toFixed(2);
}
async function financialSnapshot() {
  return {
    invoices: (await db().select().from(s.invoices)).map((i) => ({
      id: i.id,
      total: i.total,
      paid: i.paidAmount,
      status: i.status,
      returned: i.returnedTotal,
    })),
    stock: await db().select().from(s.branchStock),
    movements: await db().select().from(s.inventoryMovements),
    saleEntries: (await db().select().from(s.accountingEntries)).filter(
      (e) => e.entryType === "SALE",
    ),
    customers: await db().select().from(s.customers),
  };
}

describe("excess original held fee before consolidation", () => {
  it("refunds only the second CASH fee once then groups two fully paid goods invoices on one actual fee", async () => {
    const a = await sale("CASH"),
      b = await sale("CASH"),
      before = await financialSnapshot();
    expect(await cashNet()).toBe("110000.00");
    await expect(
      dispatchInvoiceShipment(groupInput(a, b), actor),
    ).rejects.toThrow(/أمانات|أمانة/);
    const { preview, input } = await requestFor(b.printed);
    expect(preview.receipt.method).toBe("CASH");
    const result = await requestExcessFeeRefund(input, actor);
    expect(await requestExcessFeeRefund(input, actor)).toMatchObject({
      ...result,
      replayed: true,
    });
    expect(await financialSnapshot()).toEqual(before);
    expect(await cashNet()).toBe("105000.00");
    expect(
      (await db().select().from(s.receipts)).filter(
        (r) => r.direction === "OUT",
      ),
    ).toMatchObject([
      {
        id: result.receiptId,
        invoiceId: b.invoiceId,
        paymentMethod: "CASH",
        amount: "5000.00",
        status: "COMPLETED",
      },
    ]);
    const group = await dispatchInvoiceShipment(groupInput(a, b), actor);
    expect(group.leaderConsignmentId).toBe(a.cn.id);
    expect(await financialSnapshot()).toEqual(before);
    expect(await cashNet()).toBe("105000.00");
    await expect(
      requestExcessFeeRefund({ ...input, clientRequestId: key() }, actor),
    ).rejects.toThrow();
  });
  it.each(["CARD", "TRANSFER", "WALLET"] as const)(
    "%s fee stays pending and blocks dispatch until an owner confirms its own provider success",
    async (method) => {
      const a = await sale(method),
        b = await sale(method),
        before = await financialSnapshot();
      const { input } = await requestFor(b.printed);
      const result = await requestExcessFeeRefund(input, actor);
      const refund = (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, result.receiptId))
      )[0];
      expect(refund).toMatchObject({
        invoiceId: b.invoiceId,
        paymentMethod: method,
        cashBucket: null,
        amount: "5000.00",
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        partyType: "OTHER",
        partyId: null,
      });
      expect(await financialSnapshot()).toEqual(before);
      expect(await cashNet()).toBe("0.00");
      await expect(
        dispatchInvoiceShipment(groupInput(a, b), actor),
      ).rejects.toThrow(/معلق|معلّق/);
      await expect(
        dispatchInvoiceToDelivery(
          {
            invoiceId: b.invoiceId,
            partyId: 1,
            deliveryFee: "5000",
            feeCollection: "COUNTER",
            externalTrackingRef: b.cn.externalTrackingRef,
            clientRequestId: key(),
          },
          actor,
        ),
      ).rejects.toThrow(/معلق|معلّق/);
      const approval = {
        receiptId: result.receiptId,
        providerReference: key(),
        clientRequestId: key(),
      };
      await approveDeliveryPaymentRefund(approval, owner);
      expect(await approveDeliveryPaymentRefund(approval, owner)).toMatchObject(
        { replayed: true },
      );
      const statement = (await getCustomerStatement(1, { branchId: 1 }))!;
      expect(statement.summary.currentBalance).toBe("0.00");
      expect(statement.payments.some((r) => r.id === result.receiptId)).toBe(false);
      const nextDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const carried = (await getCustomerStatement(1, { branchId: 1, from: nextDay }))!;
      expect(carried.summary.openingBalance).toBe("0.00");
      expect(
        await dispatchInvoiceShipment(groupInput(a, b), actor),
      ).toMatchObject({ leaderConsignmentId: a.cn.id });
      expect(await financialSnapshot()).toEqual(before);
      expect(await cashNet()).toBe("0.00");
    },
  );
  it("requires an exact printed number within the branch and never guesses internal IDs", async () => {
    const sold = await sale("CASH"),
      { input } = await requestFor(sold.printed);
    await expect(
      previewExcessFeeRefund({ documentNumber: String(sold.invoiceId) }, actor),
    ).rejects.toThrow();
    await expect(
      previewExcessFeeRefund(
        { documentNumber: sold.printed },
        { ...actor, branchId: 2 },
      ),
    ).rejects.toThrow();
    await expect(
      requestExcessFeeRefund(input, { ...actor, branchId: 2 }),
    ).rejects.toThrow();
    expect(
      (await db().select().from(s.receipts)).filter(
        (r) => r.direction === "OUT",
      ),
    ).toHaveLength(0);
  });
  it("serializes refund against actual dispatch: only one can consume the original held source", async () => {
    const sold = await sale("CASH"),
      { input } = await requestFor(sold.printed);
    const result = await Promise.allSettled([
      requestExcessFeeRefund(input, actor),
      dispatchInvoiceToDelivery(
        {
          invoiceId: sold.invoiceId,
          partyId: 1,
          deliveryFee: "5000",
          feeCollection: "COUNTER",
          externalTrackingRef: sold.cn.externalTrackingRef,
          clientRequestId: key(),
        },
        actor,
      ),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const outs = (await db().select().from(s.receipts)).filter(
      (r) => r.direction === "OUT",
    );
    expect(outs.length).toBeLessThanOrEqual(1);
    const current = (
      await db()
        .select()
        .from(s.deliveryConsignments)
        .where(eq(s.deliveryConsignments.id, sold.cn.id))
    )[0];
    expect(current.status === "DISPATCHED" && outs.length > 0).toBe(false);
  });
  it("keeps original document identity in a blocked preview and refuses an already dispatched source", async () => {
    const sold = await sale("CASH"),
      { input } = await requestFor(sold.printed);
    await dispatchInvoiceToDelivery(
      {
        invoiceId: sold.invoiceId,
        partyId: 1,
        deliveryFee: "5000",
        feeCollection: "COUNTER",
        externalTrackingRef: sold.cn.externalTrackingRef,
        clientRequestId: key(),
      },
      actor,
    );
    const preview = await previewExcessFeeRefund(
      { documentNumber: sold.printed },
      actor,
    );
    expect(preview).toMatchObject({
      eligible: false,
      sourceKind: "INVOICE",
      sourceId: sold.invoiceId,
      number: sold.invoice.invoiceNumber,
    });
    await expect(requestExcessFeeRefund(input, actor)).rejects.toThrow(
      /إرسالية|حي/,
    );
    expect(
      (await db().select().from(s.receipts)).filter(
        (r) => r.direction === "OUT",
      ),
    ).toHaveLength(0);
  });
  it("cash outside the collecting cashier requires a different verified active manager", async () => {
    const sold = await sale("CASH"),
      { input } = await requestFor(sold.printed);
    await expect(requestExcessFeeRefund(input, owner)).rejects.toThrow(/مدير/);
    await expect(
      requestExcessFeeRefund(
        { ...input, approvedByManagerId: owner.userId },
        owner,
      ),
    ).rejects.toThrow(/مدير/);
    const result = await requestExcessFeeRefund(
      { ...input, approvedByManagerId: 3 },
      owner,
    );
    expect(
      (
        await db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, result.receiptId))
      )[0],
    ).toMatchObject({
      approvedBy: 3,
      createdBy: owner.userId,
      amount: "5000.00",
      paymentMethod: "CASH",
    });
  });
  it("ready WO original CARD fee remains protected after linking to a real prepared invoice", async () => {
    const attemptId = await proof("5000", "PRINT_POS");
    const order = await createWorkOrder(
      {
        branchId: 1,
        shiftId: 1,
        customerId: 1,
        title: "Custom",
        salePrice: "50000",
        deposit: "0",
        clientRequestId: key(),
        hasDelivery: true,
        deliveryCost: "5000",
        deliveryFeeCollection: "COUNTER",
        deliveryFeeTender: {
          method: "CARD",
          externalPaymentAttemptId: attemptId,
          externalPaymentDeviceId: deviceId,
        },
      },
      actor,
    );
    await db()
      .update(s.workOrders)
      .set({ status: "READY" })
      .where(eq(s.workOrders.id, order.workOrderId));
    const fulfillment = await createFulfillmentRequest(
      {
        branchId: 1,
        customerId: 1,
        recipientName: "Buyer",
        recipientPhone: "07700000000",
        deliveryAddress: "Baghdad",
        partyId: 1,
        deliveryFee: "5000",
        feeCollection: "COUNTER",
        sources: [{ workOrderId: order.workOrderId }],
        clientRequestId: key(),
      },
      owner,
    );
    const prepared = await withTx((tx) =>
      prepareWorkOrderDeliveryInvoiceInTx(
        tx,
        {
          workOrderId: order.workOrderId,
          partyId: 1,
          requestId: fulfillment.id,
        },
        actor,
      ),
    );
    const current = (
      await db()
        .select()
        .from(s.workOrders)
        .where(eq(s.workOrders.id, order.workOrderId))
    )[0];
    const { input } = await requestFor(
      `WO-${current.orderNumber.replace(/^WO[-|]/i, "")}`,
    );
    const before = await financialSnapshot();
    const statementBefore = (await getCustomerStatement(1, { branchId: 1 }))!;
    const nextDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const openingBefore = (await getCustomerStatement(1, { branchId: 1, from: nextDay }))!;
    const result = await requestExcessFeeRefund(input, actor);
    await expect(
      dispatchInvoiceToDelivery(
        {
          invoiceId: prepared.invoiceId,
          partyId: 1,
          deliveryFee: "5000",
          feeCollection: "COUNTER",
          externalTrackingRef: key(),
          clientRequestId: key(),
        },
        actor,
      ),
    ).rejects.toThrow(/معلق|معلّق/);
    expect(await financialSnapshot()).toEqual(before);
    expect(await db().select().from(s.deliveryConsignments)).toHaveLength(0);
    await approveWorkOrderCancellationRefund(result.receiptId, owner, key(), {
      user: { id: owner.userId, branchId: 1 } as never,
      req: undefined as never,
    });
    const refund = (
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, result.receiptId))
    )[0];
    expect(refund).toMatchObject({
      invoiceId: prepared.invoiceId,
      workOrderId: order.workOrderId,
      status: "COMPLETED",
      paymentMethod: "CARD",
      partyType: "OTHER",
      partyId: 1,
    });
    const statementAfter = (await getCustomerStatement(1, { branchId: 1 }))!;
    expect(statementAfter.summary.currentBalance).toBe(statementBefore.summary.currentBalance);
    expect(statementAfter.payments.some((r) => r.id === result.receiptId)).toBe(false);
    const openingAfter = (await getCustomerStatement(1, { branchId: 1, from: nextDay }))!;
    expect(openingAfter.summary.openingBalance).toBe(openingBefore.summary.openingBalance);
    expect(await financialSnapshot()).toEqual(before);
    expect(await cashNet()).toBe("0.00");
  });
});
