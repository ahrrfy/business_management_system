import { beforeEach, describe, expect, it } from "vitest";
import { appRouter } from "../../routers";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import * as s from "../../../drizzle/schema";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";
import { truncateTables } from "../../services/__tests__/__testUtils__";

function context(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 11,
      role: "admin",
      branchId: 1,
      name: "owner",
      email: "owner@test.local",
      isActive: true,
    } as TrpcContext["user"],
  };
}

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function expectNoReceptionArtifacts() {
  expect(await db().select().from(s.invoices)).toHaveLength(0);
  expect(await db().select().from(s.receipts)).toHaveLength(0);
  expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
  expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  expect(await db().select().from(s.workOrders)).toHaveLength(0);
  expect(await db().select().from(s.orderPayments)).toHaveLength(0);
}

beforeEach(async () => {
  await truncateTables([
    "orderPayments",
    "workOrders",
    "inventoryMovements",
    "accountingEntries",
    "receipts",
    "invoiceItems",
    "invoices",
  ]);
});

/**
 * الطرق المدعومة (بطاقة/تحويل/محفظة) تمرّ بمرجعها؛ ورصيد زين مرفوض بنيوياً في كل منفذ قبض
 * بلا أيّ أثرٍ ماليّ أو مخزنيّ — وهذا ما يحرسه هذا الملف على حدود كل طفرةٍ في المحطة.
 */
describe("رفض رصيد زين في كل منافذ قبض المحطة", () => {
  it("يرفض قبض البطاقة من طابور الاستقبال بلا محاولة SALES_COLLECTION مؤكدة", async () => {
    await expect(
      appRouter.createCaller(context()).reception.collectOnInvoice({
        invoiceId: 999,
        amount: "1000.00",
        method: "CARD",
        reference: "REF-CARD-WITHOUT-ATTEMPT",
        clientRequestId: "COLLECT-CARD-WITHOUT-ATTEMPT",
      }),
    ).rejects.toThrow(/أكّد الدفع الخارجي/);

    await expectNoReceptionArtifacts();
  });

  it.each(["TELECOM"] as const)("يرفض %s بلا أيّ أثر", async (method) => {
    const caller = appRouter.createCaller(context());

    await expect(caller.reception.collectOnInvoice({
      invoiceId: 999,
      amount: "1000.00",
      method,
      reference: `REF-${method}`,
      clientRequestId: `COLLECT-${method}`,
    } as never),
    ).rejects.toThrow();

    await expect(caller.reception.collectDeposit({
      draftId: 999,
      amount: "1000.00",
      method,
      reference: `REF-${method}`,
      clientRequestId: `DEPOSIT-${method}`,
    } as never),
    ).rejects.toThrow();

    await expect(caller.reception.draftCommit({
      draftId: 999,
      version: 0,
      expectedTotal: "1000.00",
      shiftId: 1,
      collectNow: { amount: "1000.00", method, reference: `REF-${method}` },
    } as never),
    ).rejects.toThrow();

    await expect(caller.workOrders.receptionCheckout({
      branchId: 1,
      shiftId: 1,
      paymentMethod: method,
      paymentReference: `REF-${method}`,
      paidAmount: "1000.00",
      clientRequestId: `CHECKOUT-${method}`,
      regularSale: {
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        amount: "1000.00",
      },
    } as never),
    ).rejects.toThrow();

    await expect(caller.workOrders.create({
      branchId: 1,
      customerId: 1,
      title: "طلب اختبار",
      salePrice: "1000.00",
      deposit: "1000.00",
      paymentMethod: method,
      paymentReference: `REF-${method}`,
      clientRequestId: `WO-${method}`,
    } as never),
    ).rejects.toThrow();

    await expect(caller.workOrders.deliver({
      workOrderId: 999,
      payment: { amount: "1000.00", method, reference: `REF-${method}` },
      clientRequestId: `DELIVER-${method}`,
    } as never),
    ).rejects.toThrow();

    await expect(caller.reservations.convert({
      reservationId: 999,
      payment: { amount: "1000.00", method, reference: `REF-${method}` },
    } as never),
    ).rejects.toThrow();

    await expect(caller.quotations.convert({
      quotationId: 999,
      payment: { amount: "1000.00", method },
    } as never),
    ).rejects.toThrow();

    await expect(caller.sales.reissue({
      originalInvoiceId: 999,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      reason: "payment policy regression",
      additionalPayment: { amount: "1000.00", method, reference: `REF-${method}`,
        },
    } as never),
    ).rejects.toThrow();

    await expectNoReceptionArtifacts();
    expect(INBOUND_TELECOM_DISABLED_MESSAGE).toMatch(/رصيد زين/);
  });
});
