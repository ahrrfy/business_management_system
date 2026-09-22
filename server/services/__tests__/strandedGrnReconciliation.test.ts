import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder } from "../purchaseService";
import { createGoodsReceiptInTx } from "../purchase/goodsReceipts";
import { reconcileSupplierBalances, reconcileUnbilledGoodsReceipts } from "../reconcileService";
import { getSupplierStatement } from "../reports/apAging";
import { postSupplierInvoiceGrniTx } from "../purchase/grniAccounting";
import { adjustSupplierBalance } from "../ledgerService";
import { withTx } from "../tx";
import { money } from "../money";
import { truncateTables } from "./__testUtils__";

const creator = { userId: 1, branchId: 1, role: "admin" as const };
const receiver = { userId: 2, branchId: 1, role: "manager" as const };

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "purchaseOrderEvents",
  "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "supplierInvoiceApprovalRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierPaymentAllocations",
  "supplierPayments",
  "supplierPaymentRequestAllocations",
  "supplierPaymentRequests",
  "supplierInvoices",
  "goodsReceiptAccountingLinks",
  "goodsReceiptItems",
  "goodsReceipts",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accrualObligationEvents",
  "accrualObligations",
  "accountingEntries",
  "expenses",
  "receipts",
  "financialPeriods",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "purchaseControlSettings",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      { id: 1, openId: "reconcile-creator", name: "منشئ", role: "admin", loginMethod: "local", branchId: 1 },
      { id: 2, openId: "reconcile-receiver", name: "مستلم", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
    ]);
  await db().insert(s.suppliers).values({ id: 1, name: "مطبعة دار المغرب", currentBalance: "0.00" });
  await db().insert(s.products).values({ id: 1, name: "ملازم دراسية" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "MAL-01", costPrice: "10000.00" });
  await db().insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "نسخة", conversionFactor: "1", isBaseUnit: true });
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 50 });
}

describe("stranded goods receipts & supplier statement reconciliation", () => {
  beforeEach(async () => {
    await truncateTables(TABLES);
    await seed();
  });

  it("reconcileUnbilledGoodsReceipts يرصد الاستلام غير المفوتر ويزول بعد ترحيل فاتورة المورد", async () => {
    // 1. إنشاء أمر شراء آجل
    const poResult = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "CONFIRMED",
        settlementType: "CREDIT",
        shippingCost: "0.00",
        customsCost: "0.00",
        clientRequestId: `po-test-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            unitId: 1,
            quantity: 10,
            unitPrice: "10000.00",
          },
        ],
      },
      creator,
    );
    const purchaseOrderId = poResult.id;

    // 2. إثبات استلام مخزني POSTED دون فاتورة مورد (بضاعة معلقة في GRNI)
    const grnResult = await withTx(async (tx) => {
      return createGoodsReceiptInTx(
        tx,
        {
          purchaseOrderId,
          purchaseOrderRevisionId: purchaseOrderId,
          expectedOrderVersion: 1,
          supplierDeliveryNote: "DN-1234",
          notes: "استلام بضاعة تجريبي",
          lines: [
            {
              purchaseOrderItemId: poResult.items[0].id,
              acceptedBaseQuantity: 10,
              rejectedBaseQuantity: 0,
            },
          ],
        },
        receiver,
      );
    });
    const goodsReceiptId = "goodsReceiptId" in grnResult ? Number(grnResult.goodsReceiptId) : Number(grnResult.id);

    // 3. التحقق من أن reconcileUnbilledGoodsReceipts يرصد هذا الاستلام العالق بدقة
    const unbilledBefore = await reconcileUnbilledGoodsReceipts();
    expect(unbilledBefore.length).toBeGreaterThanOrEqual(1);
    const flagged = unbilledBefore.find((u) => u.id === goodsReceiptId);
    expect(flagged).toBeDefined();
    expect(flagged?.entity).toBe("goodsReceipt");
    expect(Number(flagged?.drift)).toBe(100000);

    // 4. التحقق من كشف الحساب: يظهر الإفصاح عن الاستلام غير المفوتر
    const statementBefore = await getSupplierStatement(1);
    expect(statementBefore).not.toBeNull();
    expect(statementBefore?.unbilledReceipts?.some((r) => r.goodsReceiptId === goodsReceiptId)).toBe(true);

    // 5. ترحيل فاتورة المورد وإثبات قيد GRNI:SUPPLIER_INVOICE
    await withTx(async (tx) => {
      // إنشاء الفاتورة
      const [inv] = await tx.insert(s.supplierInvoices).values({
        invoiceNumber: `SIN-1-20260902-99999`,
        clientRequestId: `sinv-${randomUUID()}`,
        origin: "NATIVE",
        supplierId: 1,
        branchId: 1,
        externalInvoiceNumber: "INV-DN-1234",
        externalNumberNorm: "inv-dn-1234",
        invoiceDate: "2026-09-02",
        currency: "IQD",
        subtotal: "100000.00",
        taxAmount: "0.00",
        discountAmount: "0.00",
        totalAmount: "100000.00",
        status: "MATCHED",
        draftState: "ACTIVE",
        paymentGate: "OPEN",
        payloadCanonical: "{}",
        payloadHash: "abc",
        evidenceType: "OTHER",
        evidenceReference: "REF-TEST",
        createdBy: 1,
      });
      const supplierInvoiceId = Number(inv.insertId);

      // خط الفاتورة
      const [line] = await tx.insert(s.supplierInvoiceLines).values({
        supplierInvoiceId,
        lineNo: 1,
        purchaseOrderRevisionItemId: purchaseOrderId,
        variantId: 1,
        description: "ملازم",
        invoicedBaseQuantity: 10,
        unitPriceIqd: "10000.00",
        netAmount: "100000.00",
        taxAmount: "0.00",
        totalAmount: "100000.00",
      });
      const lineId = Number(line.insertId);

      // المطابقة
      const [run] = await tx.insert(s.supplierInvoiceMatchRuns).values({
        matchKey: `match-${randomUUID()}`,
        supplierInvoiceId,
        supplierId: 1,
        branchId: 1,
        runNo: 1,
        outcome: "EXACT",
        policyVersion: 1,
        policySnapshot: "{}",
        policyHash: "h1",
        poRevisionSetHash: "h2",
        goodsReceiptSetHash: "h3",
        invoiceHash: "h4",
        priceTolerancePercent: "0.0000",
        quantityToleranceBase: 0,
        totalToleranceAmount: "0.00",
        orderedBaseQuantity: 10,
        receivedBaseQuantity: 10,
        invoicedBaseQuantity: 10,
        poTotal: "100000.00",
        grnTotal: "100000.00",
        invoiceTotal: "100000.00",
        quantityVarianceBase: 0,
        priceVarianceAmount: "0.00",
        totalVarianceAmount: "0.00",
        holdCodes: [],
        evidenceSnapshot: "{}",
        evidenceHash: "h5",
        performedBy: 1,
      });
      const matchRunId = Number(run.insertId);

      await tx.insert(s.supplierInvoiceMatchAllocations).values({
        matchRunId,
        supplierInvoiceLineId: lineId,
        purchaseOrderRevisionItemId: purchaseOrderId,
        goodsReceiptItemId: goodsReceiptId,
        matchedBaseQuantity: 10,
        poUnitPriceIqd: "10000.00",
        grnUnitCostIqd: "10000.00",
        invoiceUnitPriceIqd: "10000.00",
        quantityVarianceBase: 0,
        priceVarianceAmount: "0.00",
        matchedAmount: "100000.00",
      });

      const entryId = await postSupplierInvoiceGrniTx(tx, {
        supplierInvoiceId,
        purchaseOrderId,
        supplierId: 1,
        branchId: 1,
        invoiceAmount: money("100000.00"),
        taxAmount: money("0.00"),
        grniAmount: money("100000.00"),
        actorId: 1,
      });

      await tx
        .update(s.supplierInvoices)
        .set({
          status: "POSTED",
          postingEntryId: entryId,
          postedBy: 1,
          postedAt: new Date(),
        })
        .where(s.eq(s.supplierInvoices.id, supplierInvoiceId));

      await adjustSupplierBalance(tx, 1, money("100000.00"));
    });

    // 6. التحقق من أن reconcileUnbilledGoodsReceipts أصبح نظيفاً تماماً
    const unbilledAfter = await reconcileUnbilledGoodsReceipts();
    expect(unbilledAfter.find((u) => u.id === goodsReceiptId)).toBeUndefined();

    // 7. التحقق من اتزان كشف الحساب والرصيد
    const statementAfter = await getSupplierStatement(1);
    expect(statementAfter).not.toBeNull();
    expect(statementAfter?.summary.currentBalance).toBe("100000.00");
    expect(statementAfter?.purchaseOrders.some((p) => p.id === purchaseOrderId)).toBe(true);
    expect(statementAfter?.unbilledReceipts?.some((r) => r.goodsReceiptId === goodsReceiptId)).toBe(false);

    // 8. التحقق من خلو reconcileSupplierBalances من أي انحراف
    const drift = await reconcileSupplierBalances();
    expect(drift.filter((d) => d.id === 1)).toEqual([]);
  });
});
