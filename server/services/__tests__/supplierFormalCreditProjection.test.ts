import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  loadSupplierFormalCreditTotals,
  supplierFormalCreditTotalsSql,
} from "../purchase/supplierFormalCreditProjection";
import {
  invoiceReservations,
  listSupplierPaymentSources,
  requestSupplierPayment,
} from "../purchase/supplierPayments";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import { toDbMoney } from "../money";
const db = () => getDb()!;
const owner = { userId: 9, branchId: 1, role: "manager" };
beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 9,
    openId: "book-owner",
    name: "مالك",
    role: "manager",
    isOwner: true,
    branchId: 1,
  });
  await db().insert(s.users).values({
    id: 7,
    openId: "book-maker",
    name: "محاسب",
    role: "accountant",
    branchId: 1,
  });
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد", currentBalance: "100000.00" });
  await db().insert(s.products).values({ id: 1, name: "صنف" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, variantName: "صنف", sku: "BOOK-TEST" });
  for (const [id, amount] of [
    [1, "60000.00"],
    [2, "40000.00"],
  ] as const) {
    await db()
      .insert(s.purchaseOrders)
      .values({
        id,
        poNumber: `PO-${id}`,
        supplierId: 1,
        branchId: 1,
        subtotal: amount,
        total: amount,
        paidAmount: "0.00",
        status: "RECEIVED",
      });
    const entry = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "PURCHASE",
        entryDate: "2026-10-01",
        amount,
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: id,
      }),
    );
    await db()
      .insert(s.purchaseOrderRevisions)
      .values({
        id,
        purchaseOrderId: id,
        revisionNo: 1,
        origin: "NATIVE",
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "IQD",
        settlementType: "CREDIT",
        subtotal: amount,
        total: amount,
        taxAmount: "0.00",
        shippingCost: "0.00",
        customsCost: "0.00",
        invoiceDiscount: "0.00",
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        revisionReason: "اختبار",
        createdBy: 9,
      });
    await db().insert(s.purchaseOrderRevisionItems).values({
      id,
      revisionId: id,
      lineNo: 1,
      variantId: 1,
      quantity: "1.000",
      baseQuantity: 1,
      listUnitPrice: amount,
      unitPrice: amount,
      lineTotal: amount,
      productNameSnapshot: "صنف",
    });
    await db()
      .insert(s.supplierInvoices)
      .values({
        id,
        invoiceNumber: `SI-${id}`,
        clientRequestId: `book-invoice-${id}`,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "NATIVE_AP",
        paymentGate: "OPEN",
        invoiceDate: "2026-10-01",
        currency: "IQD",
        subtotal: amount,
        totalAmount: amount,
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        externalInvoiceNumber: `EXT-${id}`,
        externalNumberNorm: `EXT${id}`,
        evidenceType: "OTHER",
        evidenceReference: "invoice",
        createdBy: 9,
        postingEntryId: entry,
        postedBy: 9,
        postedAt: new Date(),
      });
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: id,
      lineNo: 1,
      purchaseOrderRevisionItemId: id,
      variantId: 1,
      description: "صنف",
      invoicedBaseQuantity: 1,
      unitPriceIqd: amount,
      netAmount: amount,
      totalAmount: amount,
    });
  }
});

async function credit(invoiceId: number | null = null, amount = "10000.00") {
  const entryId = extractInsertId(
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "RETURN",
        amount: `-${amount}`,
        entryDate: new Date("2026-10-02T00:00:00Z"),
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
      }),
  );
  return extractInsertId(
    await db()
      .insert(s.purchaseReturns)
      .values({
        returnNumber: `RC-${entryId}`,
        clientRequestId: `rc-${entryId}`,
        origin: "LEGACY",
        supplierInvoiceId: invoiceId,
        purchaseOrderId: 1,
        supplierId: 1,
        branchId: 1,
        accountingEntryId: entryId,
        settlement: "CREDIT",
        netAmount: amount,
        totalAmount: amount,
        creditOffsetAmount: amount,
        createdBy: 9,
        createdByNameSnapshot: "owner",
      }),
  );
}
describe("formal supplier credit ownership", () => {
  it("resolves direct and unique PO-only credits identically in current raw reads, SQL, capacity and PO projection", async () => {
    await credit();
    await credit(1, "5000.00");
    expect((await loadSupplierFormalCreditTotals(db(), [1, 2])).get(1)).toBe(
      "15000.00",
    );
    const [raw] = await db()
      .select(supplierFormalCreditTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    expect(toDbMoney(raw.amount)).toBe("15000.00");
    expect(Boolean(raw.eligible)).toBe(true);
    const reservations = await invoiceReservations(
      db() as never,
      [1, 2],
      false,
    );
    expect(reservations.creditReturns.get(1)?.toFixed(2)).toBe("15000.00");
    const page = await listSupplierPaymentSources(
      { branchId: 1, supplierId: 1 },
      owner,
    );
    expect(page.rows.find((row) => row.id === 1)?.remainingAmount).toBe(
      "45000.00",
    );
    const orders = await db().select().from(s.purchaseOrders);
    expect((await loadPurchaseSettlements(db(), orders)).get(1)).toMatchObject({
      returnedAmountIqd: "15000.00",
      remainingAmountIqd: "45000.00",
    });
  });
  it("fails closed on ambiguous PO-only targets and removes them before pagination and counts", async () => {
    await credit();
    await db().insert(s.supplierInvoiceLines).values({
      supplierInvoiceId: 2,
      lineNo: 2,
      purchaseOrderRevisionItemId: 1,
      variantId: 1,
      description: "shared PO",
      invoicedBaseQuantity: 1,
      unitPriceIqd: "1000.00",
      netAmount: "1000.00",
      totalAmount: "1000.00",
    });
    await expect(loadSupplierFormalCreditTotals(db(), [1])).rejects.toThrow(
      /فاتورة ذمة وحيدة/,
    );
    const [raw] = await db()
      .select(supplierFormalCreditTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    expect(Boolean(raw.eligible)).toBe(false);
    expect(
      (
        await listSupplierPaymentSources(
          { branchId: 1, supplierId: 1, limit: 1 },
          owner,
        )
      ).total,
    ).toBe(0);
    await expect(
      requestSupplierPayment(
        {
          supplierId: 1,
          branchId: 1,
          requestKey: "AMBIGUOUS-CREDIT",
          currency: "IQD",
          amount: "1000.00",
          currencyAmount: "1000.00",
          paymentMethod: "TRANSFER",
          externalReference: "BANK",
          evidenceType: "BANK_ADVICE",
          evidenceReference: "BANK",
          reason: "no inference",
          allocations: [
            {
              supplierInvoiceId: 1,
              invoiceVersion: 1,
              amount: "1000.00",
              currencyAmount: "1000.00",
            },
          ],
        },
        { userId: 7, branchId: 1, role: "accountant" },
      ),
    ).rejects.toThrow(/فاتورة ذمة وحيدة/);
    expect(await db().select().from(s.supplierPaymentRequests)).toHaveLength(0);
  });
  it("uses current raw credit rows even after a pre-existing transaction snapshot", async () => {
    await db().transaction(async (tx) => {
      await tx.select().from(s.suppliers);
      await credit();
      expect((await loadSupplierFormalCreditTotals(tx, [1])).has(1)).toBe(
        false,
      );
      expect(
        (
          await loadSupplierFormalCreditTotals(tx, [1], { currentRead: true })
        ).get(1),
      ).toBe("10000.00");
    });
  });
  it("allocates PO-only credits canonically across exclusive multi-batch invoices of the same PO and fails closed on total PO capacity overflow", async () => {
    await db()
      .update(s.purchaseOrders)
      .set({ subtotal: "75000.00", total: "75000.00" })
      .where(eq(s.purchaseOrders.id, 1));
    const secondBatchEntry = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "PURCHASE",
        entryDate: "2026-10-02",
        amount: "15000.00",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
      }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        id: 3,
        invoiceNumber: "SI-3",
        clientRequestId: "book-invoice-3",
        origin: "LEGACY",
        legacyPurchaseOrderId: 1,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "LEGACY_UNKNOWN",
        paymentGate: "BLOCKED_REVIEW",
        invoiceDate: "2026-10-02",
        currency: "IQD",
        subtotal: "15000.00",
        totalAmount: "15000.00",
        legacySettlementEvidenceHash: "b".repeat(64),
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        evidenceType: "LEGACY_LEDGER",
        postingEntryId: secondBatchEntry,
      });
    // Direct credit of 5,000 on invoice 1 (leaves 55,000 capacity on invoice 1)
    // plus PO-only credit of 62,000 on PO 1 -> 55,000 absorbed by invoice 1 (total 60,000)
    // and 7,000 spills over to invoice 3 (leaves 8,000 on invoice 3).
    await credit(null, "62000.00");
    await credit(1, "5000.00");
    const both = await loadSupplierFormalCreditTotals(db(), [1, 3]);
    expect(both.get(1)).toBe("60000.00");
    expect(both.get(3)).toBe("7000.00");
    expect((await loadSupplierFormalCreditTotals(db(), [1])).get(1)).toBe(
      "60000.00",
    );
    expect((await loadSupplierFormalCreditTotals(db(), [3])).get(3)).toBe(
      "7000.00",
    );
    const [sql1] = await db()
      .select(supplierFormalCreditTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    const [sql3] = await db()
      .select(supplierFormalCreditTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 3));
    expect(toDbMoney(sql1.amount)).toBe("60000.00");
    expect(Boolean(sql1.eligible)).toBe(true);
    expect(toDbMoney(sql3.amount)).toBe("7000.00");
    expect(Boolean(sql3.eligible)).toBe(true);

    const orders = await db().select().from(s.purchaseOrders);
    const settlement = (await loadPurchaseSettlements(db(), orders)).get(1)!;
    expect(settlement).toMatchObject({
      recognizedAmountIqd: "75000.00",
      returnedAmountIqd: "67000.00",
      remainingAmountIqd: "8000.00",
      requiresReview: false,
    });

    // Overflowing the remaining 8,000 capacity on PO 1 must fail closed in both JS and SQL
    await credit(null, "9000.00");
    await expect(loadSupplierFormalCreditTotals(db(), [1])).rejects.toThrow(
      /قيمة المرتجعات تتجاوز فاتورة المورد 3/,
    );
    const [sql3AfterOverflow] = await db()
      .select(supplierFormalCreditTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 3));
    expect(Boolean(sql3AfterOverflow.eligible)).toBe(false);
    // Read-only settlement projection isolates the overflow to PO 1's requiresReview without crashing PO 2
    const isolated = await loadPurchaseSettlements(db(), orders);
    expect(isolated.get(1)?.requiresReview).toBe(true);
    expect(isolated.get(1)?.evidenceReason).toMatch(
      /قيمة المرتجعات تتجاوز فاتورة المورد 3/,
    );
    expect(isolated.get(2)?.requiresReview).toBe(false);
  });
  it("preserves JS and SQL parity when a sibling invoice on the same PO has an overflowing direct credit", async () => {
    await db()
      .update(s.purchaseOrders)
      .set({ subtotal: "75000.00", total: "75000.00" })
      .where(eq(s.purchaseOrders.id, 1));
    const secondBatchEntry = extractInsertId(
      await db().insert(s.accountingEntries).values({
        entryType: "PURCHASE",
        entryDate: "2026-10-02",
        amount: "15000.00",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 1,
      }),
    );
    await db()
      .insert(s.supplierInvoices)
      .values({
        id: 3,
        invoiceNumber: "SI-3",
        clientRequestId: "book-invoice-3",
        origin: "LEGACY",
        legacyPurchaseOrderId: 1,
        supplierId: 1,
        branchId: 1,
        status: "POSTED",
        liabilityClass: "LEGACY_AP",
        paymentGate: "OPEN",
        invoiceDate: "2026-10-02",
        currency: "IQD",
        subtotal: "15000.00",
        totalAmount: "15000.00",
        legacySettlementEvidenceHash: "b".repeat(64),
        payloadCanonical: "{}",
        payloadHash: "0".repeat(64),
        evidenceType: "LEGACY_LEDGER",
        postingEntryId: secondBatchEntry,
      });
    // Sibling invoice 3 has a direct credit overflow (20,000 > 15,000), while PO 1 has no PO-only credit yet.
    // Querying invoice 1 alone should stay isolated and eligible in both JS and SQL.
    await credit(3, "20000.00");
    expect((await loadSupplierFormalCreditTotals(db(), [1])).has(1)).toBe(
      false,
    );
    const [sql1WithoutPoCredit] = await db()
      .select(supplierFormalCreditTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    expect(Boolean(sql1WithoutPoCredit.eligible)).toBe(true);

    // Once a PO-only credit return exists on PO 1, canonical waterfall allocation across PO 1's invoices
    // depends on every sibling's residual capacity, so both JS and SQL must fail closed for invoice 1 too.
    await credit(null, "5000.00");
    await expect(loadSupplierFormalCreditTotals(db(), [1])).rejects.toThrow(
      /قيمة المرتجعات تتجاوز فاتورة المورد 3/,
    );
    const [sql1WithPoCredit] = await db()
      .select(supplierFormalCreditTotalsSql(s.supplierInvoices.id))
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, 1));
    expect(Boolean(sql1WithPoCredit.eligible)).toBe(false);
  });
});
