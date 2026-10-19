import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  documentCounters,
  invoices,
  purchaseOrders,
  quotations,
  receipts,
} from "../../../drizzle/schema";
import { withTx } from "../tx";
import {
  formatDocumentNumber,
  nextCounterValue,
  nextInvoiceNumber,
  nextTransactionTrackingNumber,
} from "../numbering";

describe("Core Numbering & Atomic Counter (Milestone 1)", () => {
  it("nextTransactionTrackingNumber يبدأ من أرضية 100000 ويعطي 100001 وما يليها بتسلسل ذري", async () => {
    const num1 = await withTx(async (tx) => nextTransactionTrackingNumber(tx));
    const num2 = await withTx(async (tx) => nextTransactionTrackingNumber(tx));

    expect(Number(num1)).toBeGreaterThanOrEqual(100001);
    expect(Number(num2)).toBe(Number(num1) + 1);
  });

  it("formatDocumentNumber ينسق الرقم للمستندات المفردة والشقيقة", () => {
    expect(formatDocumentNumber("100001")).toBe("100001");
    expect(formatDocumentNumber("100001", 0)).toBe("100001");
    expect(formatDocumentNumber("100001", 1)).toBe("100001-1");
    expect(formatDocumentNumber("100001", 2)).toBe("100001-2");
  });

  it("حجز الأرقام المتزامن (Promise.all) لا يُنتج أي تصادم أو تكرار للأرقام", async () => {
    const results = await Promise.all([
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
      withTx(async (tx) => nextTransactionTrackingNumber(tx)),
    ]);

    const unique = new Set(results);
    expect(unique.size).toBe(5);
  });

  it("nextCounterValue يحترم أرضيات العدّادات المختلفة (invoice, workOrder, online_order)", async () => {
    const inv = await withTx(async (tx) => nextInvoiceNumber(tx, 1));
    expect(Number(inv)).toBeGreaterThanOrEqual(10001);

    const ord = await withTx(async (tx) => nextCounterValue(tx, "online_order"));
    expect(Number(ord)).toBeGreaterThanOrEqual(100001);
  });

  it("nextCounterValue يرمّم العدّادات اليومية تلقائياً (QUO, RV, PV, PO, CN مع لاحقة شقيقة) فوق أعلى تسلسل موجود في الجداول حتى لو كان documentCounters غائباً أو متأخراً", async () => {
    const quoteCounterKey = "quotation_1_20991231";
    const existingQuoteNumber = "QUO-1-20991231-00007";
    const rvCounterKey = "voucher_receipt_1_20991231";
    const existingRvNumber = "RV-1-20991231-00006";
    const pvCounterKey = "voucher_payment_1_20991231";
    const existingPvNumber = "PV-1-20991231-00004";
    const poCounterKey = "purchase_order_1_20991231";
    const existingPoNumber = "PO-1-20991231-00003";
    const cnCounterKey = "consignment_1_20991231";
    const existingCnNumber = "CN-1-20991231-00009-1";

    await withTx(async (tx) => {
      await tx.execute(sql`
        INSERT IGNORE INTO branches (id, name, code, isActive)
        VALUES (1, 'فرع الاختبار', 'BR-1', 1)
      `);
      await tx.execute(sql`
        INSERT IGNORE INTO suppliers (id, name, isActive)
        VALUES (1, 'مورد الاختبار', 1)
      `);
      await tx.execute(sql`
        INSERT IGNORE INTO deliveryParties (id, name)
        VALUES (1, 'مندوب الاختبار')
      `);

      await tx.delete(quotations).where(eq(quotations.quoteNumber, existingQuoteNumber));
      await tx.delete(receipts).where(eq(receipts.voucherNumber, existingRvNumber));
      await tx.delete(receipts).where(eq(receipts.voucherNumber, existingPvNumber));
      await tx.delete(purchaseOrders).where(eq(purchaseOrders.poNumber, existingPoNumber));
      await tx.delete(deliveryConsignments).where(eq(deliveryConsignments.consignmentNumber, existingCnNumber));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, quoteCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, rvCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, pvCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, poCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, cnCounterKey));

      // 1. QUO
      await tx.insert(quotations).values({
        quoteNumber: existingQuoteNumber,
        branchId: 1,
        subtotal: "100.00",
        total: "100.00",
      });
      expect(await nextCounterValue(tx, quoteCounterKey)).toBe(8);
      await tx
        .update(documentCounters)
        .set({ lastValue: 2 })
        .where(eq(documentCounters.counterKey, quoteCounterKey));
      expect(await nextCounterValue(tx, quoteCounterKey)).toBe(8);

      // 2. RV & PV (سندات القبض والصرف)
      await tx.insert(receipts).values([
        {
          voucherNumber: existingRvNumber,
          referenceType: "VOUCHER",
          direction: "IN",
          paymentMethod: "CASH",
          amount: "5000.00",
          branchId: 1,
          partyType: "OTHER",
        },
        {
          voucherNumber: existingPvNumber,
          referenceType: "VOUCHER",
          direction: "OUT",
          paymentMethod: "CASH",
          amount: "3000.00",
          branchId: 1,
          partyType: "OTHER",
        },
      ]);
      expect(await nextCounterValue(tx, rvCounterKey)).toBe(7);
      expect(await nextCounterValue(tx, pvCounterKey)).toBe(5);

      // 3. PO (أوامر الشراء)
      await tx.insert(purchaseOrders).values({
        poNumber: existingPoNumber,
        supplierId: 1,
        branchId: 1,
        orderDate: new Date(),
        subtotal: "1000.00",
        total: "1000.00",
      });
      expect(await nextCounterValue(tx, poCounterKey)).toBe(4);

      // 4. CN (إرساليات التوصيل حتى مع وجود لاحقة شقيقة -1)
      await tx.delete(invoices).where(eq(invoices.invoiceNumber, "INV-CN-TEST-20991231"));
      const invInsert: any = await tx.insert(invoices).values({
        invoiceNumber: "INV-CN-TEST-20991231",
        sourceType: "POS",
        branchId: 1,
        priceTier: "RETAIL",
        subtotal: "1000.00",
        taxAmount: "0.00",
        discountAmount: "0.00",
        total: "1000.00",
        costTotal: "500.00",
        paidAmount: "0.00",
        status: "PENDING",
      });
      const testInvoiceId = Number(invInsert?.[0]?.insertId ?? invInsert?.insertId ?? 1);
      await tx.insert(deliveryConsignments).values({
        consignmentNumber: existingCnNumber,
        branchId: 1,
        partyId: 1,
        invoiceId: testInvoiceId,
        sourceType: "INVOICE",
        sourceId: testInvoiceId,
        codAmount: "1000.00",
        collectedAmount: "0.00",
        parcelStatus: "ASSIGNED",
        status: "DISPATCHED",
      });
      expect(await nextCounterValue(tx, cnCounterKey)).toBe(10);

      await tx.delete(quotations).where(eq(quotations.quoteNumber, existingQuoteNumber));
      await tx.delete(receipts).where(eq(receipts.voucherNumber, existingRvNumber));
      await tx.delete(receipts).where(eq(receipts.voucherNumber, existingPvNumber));
      await tx.delete(purchaseOrders).where(eq(purchaseOrders.poNumber, existingPoNumber));
      await tx.delete(deliveryConsignments).where(eq(deliveryConsignments.consignmentNumber, existingCnNumber));
      await tx.delete(invoices).where(eq(invoices.invoiceNumber, "INV-CN-TEST-20991231"));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, quoteCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, rvCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, pvCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, poCounterKey));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, cnCounterKey));
    });
  });

  it("nextTransactionTrackingNumber يرمّم عدّاد المعاملة الموحّد فوق أعلى فاتورة موحّدة قائمة عند غياب unified_transaction_floor", async () => {
    const highInvoiceNum = "109876-1";
    await withTx(async (tx) => {
      await tx.execute(sql`
        INSERT IGNORE INTO branches (id, name, code, isActive)
        VALUES (1, 'فرع الاختبار', 'BR-1', 1)
      `);
      await tx.delete(invoices).where(eq(invoices.invoiceNumber, highInvoiceNum));
      await tx.insert(invoices).values({
        invoiceNumber: highInvoiceNum,
        sourceType: "POS",
        branchId: 1,
        priceTier: "RETAIL",
        subtotal: "1000.00",
        taxAmount: "0.00",
        discountAmount: "0.00",
        total: "1000.00",
        costTotal: "500.00",
        paidAmount: "1000.00",
        status: "PAID",
      });
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, "unified_transaction_floor"));
      await tx.delete(documentCounters).where(eq(documentCounters.counterKey, "unified_transaction"));

      const nextTracking = await nextTransactionTrackingNumber(tx);
      expect(Number(nextTracking)).toBeGreaterThanOrEqual(109877);

      await tx.delete(invoices).where(eq(invoices.invoiceNumber, highInvoiceNum));
    });
  });
});

