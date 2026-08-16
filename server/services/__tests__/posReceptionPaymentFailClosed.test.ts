import { describe, expect, it } from "vitest";
import { INBOUND_TELECOM_DISABLED_MESSAGE } from "@shared/inboundPaymentPolicy";

/**
 * الطرق المرفوضة **بنيوياً** في كل منافذ القبض: رصيد زين (مساره شاشة البطاقات الرقمية).
 * البطاقة/التحويل/المحفظة مسموحة، وبوّابتها محاولةُ الدفع المؤكَّدة داخل المعاملة
 * (يحرسها `posExternalPayment.test.ts`) لا رفضٌ عند حدود الخدمة.
 */
const STRUCTURALLY_REJECTED = ["TELECOM"] as const;
import { createPrintSaleInTx } from "../printSaleService";
import { createSaleInTx } from "../sale/create";
import { processPayment } from "../sale/payment";
import { checkoutReceptionInTx } from "../receptionCheckoutService";
import { collectOnReceptionInvoice } from "../reception/collect";
import { collectDeposit } from "../reception/deposits";
import { createWorkOrderInTx } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { convertReservationToSale } from "../reservations/convert";
import { convertQuotation } from "../quotationService";
import { correctSale } from "../sale/correct";

const ACTOR = { userId: 7, branchId: 1, role: "cashier" } as const;

function forbiddenTx() {
  let accesses = 0;
  const tx = new Proxy({}, {
    get() {
      accesses += 1;
      throw new Error("TX_ACCESSED");
    },
  });
  return { tx: tx as never, accesses: () => accesses };
}

async function expectPolicyRejection(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow(INBOUND_TELECOM_DISABLED_MESSAGE);
}

describe("حدود خدمات المحطة/الكاشير ترفض الطريقة غير المدعومة قبل أيّ لمسٍ للمعاملة", () => {
  it.each(STRUCTURALLY_REJECTED)("يرفض %s قبل أيّ وصولٍ لفاتورة/إيصال/مخزون/أمر شغل", async (method) => {
    {
      const guarded = forbiddenTx();
      await expectPolicyRejection(createSaleInTx(guarded.tx, {
        branchId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "1000.00", method },
        clientRequestId: `SALE-CORE-${method}`,
      }, ACTOR));
      expect(guarded.accesses()).toBe(0);
    }

    {
      const guarded = forbiddenTx();
      await expectPolicyRejection(createPrintSaleInTx(guarded.tx, {
        branchId: 1,
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "1000.00" }],
        payment: { amount: "1000.00", method },
        // Regression: reception does not set the PrintPOS marker. The core must still reject.
        requireExternalPaymentAttempt: false,
        clientRequestId: `PRINT-NO-MARKER-${method}`,
      }, ACTOR));
      expect(guarded.accesses()).toBe(0);
    }

    {
      const guarded = forbiddenTx();
      await expectPolicyRejection(checkoutReceptionInTx(guarded.tx, {
        branchId: 1,
        shiftId: 1,
        paymentMethod: method,
        paidAmount: "1000.00",
        clientRequestId: `RECEPTION-${method}`,
        regularSale: {
          lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
          amount: "1000.00",
        },
      } as never, ACTOR));
      expect(guarded.accesses()).toBe(0);
    }

    await expectPolicyRejection(collectOnReceptionInvoice({
      invoiceId: 999,
      amount: "1000.00",
      method,
      reference: `REF-${method}`,
      clientRequestId: `COLLECT-${method}`,
    } as never, ACTOR));

    await expectPolicyRejection(collectDeposit({
      draftId: 999,
      amount: "1000.00",
      method,
      reference: `REF-${method}`,
      clientRequestId: `DEPOSIT-${method}`,
    } as never, ACTOR));

    await expectPolicyRejection(processPayment({
      invoiceId: 999,
      amount: "1000.00",
      method,
      reference: `REF-${method}`,
      clientRequestId: `PAY-${method}`,
    }, ACTOR));

    await expectPolicyRejection(deliverWorkOrder({
      workOrderId: 999,
      payment: { amount: "1000.00", method, reference: `REF-${method}` },
      clientRequestId: `DELIVER-${method}`,
    }, ACTOR));

    await expectPolicyRejection(convertReservationToSale({
      reservationId: 999,
      payment: { amount: "1000.00", method, reference: `REF-${method}` },
    }, ACTOR));

    await expectPolicyRejection(convertQuotation({
      quotationId: 999,
      payment: { amount: "1000.00", method },
    } as never, ACTOR));

    await expectPolicyRejection(correctSale({
      originalInvoiceId: 999,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      additionalPayment: { amount: "1000.00", method },
    } as never, ACTOR));

    {
      const guarded = forbiddenTx();
      await expectPolicyRejection(createWorkOrderInTx(guarded.tx, {
        branchId: 1,
        customerId: 1,
        title: "طلب اختبار",
        salePrice: "1000.00",
        deposit: "1000.00",
        paymentMethod: method,
        clientRequestId: `WO-${method}`,
      } as never, ACTOR));
      expect(guarded.accesses()).toBe(0);
    }
  });

  it("lets CASH pass the core policy boundary", async () => {
    const guarded = forbiddenTx();
    await expect(createPrintSaleInTx(guarded.tx, {
      branchId: 1,
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPriceOverride: "1000.00" }],
      payment: { amount: "1000.00", method: "CASH" },
      clientRequestId: "PRINT-CASH-BOUNDARY",
    }, ACTOR)).rejects.toThrow("TX_ACCESSED");
    expect(guarded.accesses()).toBe(1);
  });
});
