import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { PurchaseTenderInput } from "@shared/purchaseTender";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import {
  createPurchaseOrder,
  confirmPurchaseOrder,
  updatePurchaseOrder,
} from "../purchaseService";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { readPurchaseTenderTx } from "../purchase/tender";
import { getCardSummary } from "../cardAccountService";
import { computeExpectedCash } from "../shiftService";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import { getSupplierStatement } from "../reports/apAging";
import { getPurchaseIntegrityReport } from "../purchaseIntegrityService";
import {
  requestSupplierPayment,
  requestSupplierPaymentInTx,
  decideSupplierPayment,
  requestSupplierPaymentRefund,
  decideSupplierPaymentRefund,
} from "../purchase/supplierPayments";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const maker = { userId: 1, branchId: 1, role: "admin" };
const owner = { userId: 2, branchId: 1, role: "manager", isOwner: true };
const db = () => getDb()!;
const tables = [
  "idempotencyKeys",
  "auditLogs",
  "supplierBookSettlementAllocations",
  "supplierBookSettlementSources",
  "supplierPaymentRefundItems",
  "supplierPaymentRefunds",
  "supplierPaymentRefundRequestItems",
  "supplierPaymentRefundRequests",
  "supplierPaymentAllocations",
  "supplierPayments",
  "supplierPaymentRequestAllocations",
  "supplierPaymentRequests",
  "supplierInvoiceApprovalRequests",
  "supplierInvoiceMatchAllocations",
  "supplierInvoiceMatchRuns",
  "supplierInvoiceLines",
  "supplierInvoices",
  "goodsReceiptAccountingLinks",
  "goodsReceiptItems",
  "goodsReceipts",
  "purchaseOrderControlRequests",
  "purchaseOrderEvents",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accountingEntries",
  "expenses",
  "receipts",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "purchaseControlSettings",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "suppliers",
  "accounts",
  "users",
  "branches",
] as const;

beforeEach(async () => {
  await truncateTables(tables);
  await db()
    .insert(s.branches)
    .values({ id: 1, code: "MAIN", name: "الرئيسي", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "tender-maker",
        name: "منشئ",
        role: "admin",
        branchId: 1,
      },
      {
        id: 2,
        openId: "tender-owner",
        name: "معتمد",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db()
    .insert(s.suppliers)
    .values({ id: 1, name: "المورد", currentBalance: "0" });
  await db().insert(s.accounts).values({
    id: 50,
    code: "1150",
    name: "حساب البطاقة والبنك",
    type: "ASSET",
    systemRole: "CARD_BANK",
  });
  await db().insert(s.shifts).values({
    id: 1,
    userId: 1,
    branchId: 1,
    openingBalance: "500",
    status: "OPEN",
    openGuard: "1:1:RETAIL",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "2000",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    createdBy: 2,
  });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db()
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "TENDER-PAPER", costPrice: "0" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
});

const card = (referenceNumber: string = randomUUID()): PurchaseTenderInput => ({
  mode: "CARD",
  accountId: 50,
  cardLastFour: "4321",
  referenceNumber,
});
async function draft(tender: PurchaseTenderInput, amount = "100") {
  return createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      tender,
      clientRequestId: randomUUID(),
      items: [
        { variantId: 1, productUnitId: 1, quantity: "1", unitPrice: amount },
      ],
    },
    maker,
  );
}
async function submit(created: Awaited<ReturnType<typeof draft>>) {
  const request = await confirmPurchaseOrder(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "إرسال الفاتورة للاعتماد",
      clientRequestId: randomUUID(),
    },
    maker,
  );
  return {
    requestId: request.requestId,
    decisionKey: randomUUID(),
    approve: true,
    reason: "تحققت من وصول البضاعة والسداد",
    confirmedFullReceipt: true,
  } as const;
}
async function approve(tender: PurchaseTenderInput, amount = "100") {
  const created = await draft(tender, amount);
  const decision = await submit(created);
  await decidePurchaseOrderControl(decision, owner);
  return { created, decision };
}
async function balances() {
  const [supplier] = await db()
    .select()
    .from(s.suppliers)
    .where(eq(s.suppliers.id, 1));
  return {
    supplier: supplier.currentBalance,
    drawer: await db().transaction(async (tx) =>
      (await computeExpectedCash(tx, 1, "500")).toFixed(2),
    ),
    treasury: await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    ),
    card: (
      await getCardSummary({ branchId: 1 }, { role: "admin", branchId: 1 })
    ).balance,
  };
}
async function previousPayment(amount: string) {
  // Existing approved advance, with its original receipt/GL/AP effect already
  // present before the purchase. Adoption must preserve these originals.
  const receiptId = extractInsertId(
    await db()
      .insert(s.receipts)
      .values({
        branchId: 1,
        amount,
        direction: "OUT",
        paymentMethod: "CARD",
        cardLastFour: "1111",
        referenceNumber: randomUUID(),
        partyType: "SUPPLIER",
        partyId: 1,
        description: "دفعة سابقة مثبتة",
        createdBy: 1,
        status: "COMPLETED",
        approvalStatus: "APPROVED",
        approvedBy: 2,
        approvedAt: new Date("2026-01-01T00:00:00Z"),
        voucherDate: new Date("2026-01-01T00:00:00Z"),
      }),
  );
  await db()
    .insert(s.accountingEntries)
    .values({
      entryType: "PAYMENT_OUT",
      branchId: 1,
      supplierId: 1,
      receiptId,
      amount,
      entryDate: new Date("2026-01-01T00:00:00Z"),
      createdBy: 1,
    });
  await db()
    .update(s.suppliers)
    .set({ currentBalance: sql`${s.suppliers.currentBalance} - ${amount}` })
    .where(eq(s.suppliers.id, 1));
  return receiptId;
}

describe("purchase tender — atomic real settlement", () => {
  it.each(["auto-cash-po:reserved", "AUTO-CASH-PO:reserved"])(
    "reserves automatic namespace %s before public requests enter a transaction",
    async (requestKey) => {
      await expect(
        requestSupplierPayment(
          {
            supplierId: 1,
            branchId: 1,
            requestKey,
            currency: "IQD",
            amount: "100",
            currencyAmount: "100",
            paymentMethod: "CARD",
            externalReference: "RESERVED-TEST",
            evidenceType: "BANK_ADVICE",
            evidenceReference: "RESERVED-TEST",
            reason: "طلب غير صالح ببادئة محجوزة",
            allocations: [
              {
                supplierInvoiceId: 999,
                invoiceVersion: 1,
                amount: "100",
                currencyAmount: "100",
              },
            ],
          },
          maker,
        ),
      ).rejects.toThrow(/محجوزة/);
      expect(await db().select().from(s.supplierPaymentRequests)).toHaveLength(
        0,
      );
    },
  );

  it("rejects an existing automatic key whose approved allocation belongs to another invoice", async () => {
    const first = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        settlementType: "CREDIT",
        clientRequestId: randomUUID(),
        items: [
          { variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "100" },
        ],
      },
      maker,
    );
    await decidePurchaseOrderControl(await submit(first), owner);
    const [invoice] = await db().select().from(s.supplierInvoices);
    const second = await draft(card());
    const decision = await submit(second);
    // Simulate a pre-existing request from before public namespace reservation,
    // using the real internal request/approval path and its actual allocation.
    const old = await withTx((tx) =>
      requestSupplierPaymentInTx(
        tx,
        {
          supplierId: 1,
          branchId: 1,
          requestKey: `auto-cash-po:${decision.decisionKey}`,
          currency: "IQD",
          amount: "100",
          currencyAmount: "100",
          paymentMethod: "CARD",
          externalReference: "OLD-ALLOCATION",
          evidenceType: "BANK_ADVICE",
          evidenceReference: "OLD-ALLOCATION",
          reason: "دفعة مسجلة مسبقاً لفاتورة أخرى",
          allocations: [
            {
              supplierInvoiceId: invoice.id,
              invoiceVersion: invoice.version,
              amount: "100",
              currencyAmount: "100",
            },
          ],
        },
        maker,
      ),
    );
    await decideSupplierPayment(
      {
        requestId: old.requestId,
        decisionKey: randomUUID(),
        action: "APPROVE",
        reviewReason: "اعتماد الدفعة الأصلية",
      },
      owner,
    );
    await expect(decidePurchaseOrderControl(decision, owner)).rejects.toThrow(
      /فاتورة شراء مختلفة/,
    );
    expect(await db().select().from(s.supplierInvoices)).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect((await balances()).card).toBe("-100.00");
  });

  it("preserves intent in draft and settles CARD once with no drawer/treasury movement", async () => {
    const tender = card("CARD-INVOICE-ONE");
    const created = await draft(tender);
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
    const [po] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
    expect(
      await readPurchaseTenderTx(db(), po.id, po.currentRevisionId),
    ).toEqual(tender);
    const decision = await submit(created);
    await decidePurchaseOrderControl(decision, owner);
    await decidePurchaseOrderControl(decision, owner);
    expect(await balances()).toEqual({
      supplier: "0.00",
      drawer: "500.00",
      treasury: "2000.00",
      card: "-100.00",
    });
    const payments = await db().select().from(s.supplierPayments);
    expect(payments).toHaveLength(1);
    const [receipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, payments[0].receiptId!));
    expect(receipt).toMatchObject({
      paymentMethod: "CARD",
      cashBucket: null,
      shiftId: null,
      cardLastFour: "4321",
      referenceNumber: "CARD-INVOICE-ONE",
      createdBy: 1,
      approvedBy: 2,
    });
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    const [posted] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, po.id));
    const settled = (await loadPurchaseSettlements(db(), [posted])).get(po.id)!;
    expect(settled).toMatchObject({
      paidAmountIqd: "100.00",
      remainingAmountIqd: "0.00",
    });
    const statement = await getSupplierStatement(1, { branchId: 1 });
    expect(
      statement?.purchaseOrders.find((row) => row.id === po.id)?.paidAmount,
    ).toBe("100.00");
  });

  it.each(["DRAWER", "TREASURY"] as const)(
    "settles explicit %s with the correct cash effect",
    async (mode) => {
      await approve(mode === "DRAWER" ? { mode, shiftId: 1 } : { mode });
      expect(await balances()).toEqual({
        supplier: "0.00",
        drawer: mode === "DRAWER" ? "400.00" : "500.00",
        treasury: mode === "TREASURY" ? "1900.00" : "2000.00",
        card: "0.00",
      });
    },
  );

  it("rejects reuse of a card reference and rolls back goods/invoice/accounting", async () => {
    await approve(card("SAME-CARD-REFERENCE"));
    const second = await draft(card("SAME-CARD-REFERENCE"));
    const decision = await submit(second);
    await expect(decidePurchaseOrderControl(decision, owner)).rejects.toThrow(
      /مرجع هذه العملية/,
    );
    expect(await db().select().from(s.supplierInvoices)).toHaveLength(1);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect((await balances()).card).toBe("-100.00");
  });

  it("rejects a company card reference already used in another branch", async () => {
    await db()
      .insert(s.branches)
      .values({ id: 2, code: "OTHER", name: "آخر", type: "SALES" });
    await db().insert(s.receipts).values({
      branchId: 2,
      amount: "100",
      direction: "OUT",
      paymentMethod: "CARD",
      referenceNumber: "GLOBAL-CARD-REFERENCE",
      createdBy: 2,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    const created = await draft(card("GLOBAL-CARD-REFERENCE"));
    await expect(
      decidePurchaseOrderControl(await submit(created), owner),
    ).rejects.toThrow(/مرجع هذه العملية/);
    expect(await db().select().from(s.supplierInvoices)).toHaveLength(0);
  });

  it("rejects new card disbursement after deactivating the original maker", async () => {
    const created = await draft(card());
    const decision = await submit(created);
    await db()
      .update(s.users)
      .set({ isActive: false })
      .where(eq(s.users.id, 1));
    await expect(decidePurchaseOrderControl(decision, owner)).rejects.toThrow(
      /غير فعال/,
    );
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
  });

  it("rolls back when the declared drawer closed without falling back to funded treasury", async () => {
    const created = await draft({ mode: "DRAWER", shiftId: 1 });
    const decision = await submit(created);
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(s.shifts.id, 1));
    await expect(decidePurchaseOrderControl(decision, owner)).rejects.toThrow(
      /أُغلقت|صالحة للصرف/,
    );
    expect(await db().select().from(s.supplierInvoices)).toHaveLength(0);
    expect((await balances()).treasury).toBe("2000.00");
  });

  it.each(["40", "100", "150"])(
    "attributes prior %s and disburses only the uncovered amount",
    async (amount) => {
      const receiptId = await previousPayment(amount);
      await approve({ ...card(), previousReceiptId: receiptId });
      const expectedBank = amount === "150" ? "-150.00" : "-100.00";
      expect((await balances()).card).toBe(expectedBank);
      expect((await balances()).supplier).toBe(
        amount === "150" ? "-50.00" : "0.00",
      );
      expect(await db().select().from(s.supplierPayments)).toHaveLength(
        amount === "40" ? 1 : 0,
      );
      const [po] = await db().select().from(s.purchaseOrders);
      expect(
        (await loadPurchaseSettlements(db(), [po])).get(po.id),
      ).toMatchObject({ paidAmountIqd: "100.00", remainingAmountIqd: "0.00" });
      const integrity = await getPurchaseIntegrityReport({
        branchId: 1,
        limit: 20,
      });
      expect(
        integrity.findings.filter((row) => row.purchaseOrderId === po.id),
      ).toEqual([]);
    },
  );

  it("uses prior-only full coverage with no live drawer and never inserts another OUT", async () => {
    const receiptId = await previousPayment("100");
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(s.shifts.id, 1));
    await approve({ mode: "DRAWER", previousReceiptId: receiptId });
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
    expect((await balances()).treasury).toBe("2000.00");
    expect((await balances()).card).toBe("-100.00");
  });

  it("does not silently pay treasury after another invoice consumes a previously sufficient advance", async () => {
    const receiptId = await previousPayment("100");
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null })
      .where(eq(s.shifts.id, 1));
    const original = await draft({
      mode: "DRAWER",
      previousReceiptId: receiptId,
    });
    const decision = await submit(original);
    await approve({ ...card(), previousReceiptId: receiptId }, "50");
    await expect(decidePurchaseOrderControl(decision, owner)).rejects.toThrow(
      /حدد الوردية صراحةً/,
    );
    expect(await db().select().from(s.supplierInvoices)).toHaveLength(1);
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
    expect((await balances()).treasury).toBe("2000.00");
  });

  it("refunds CARD through original native allocation without touching cash and replays once", async () => {
    await approve(card());
    const [payment] = await db().select().from(s.supplierPayments);
    const [allocation] = await db().select().from(s.supplierPaymentAllocations);
    const request = await requestSupplierPaymentRefund(
      {
        supplierPaymentId: payment.id,
        expectedPaymentVersion: payment.version,
        requestKey: randomUUID(),
        refundMethod: "CARD",
        externalReference: "CARD-REFUND-1",
        evidenceType: "BANK_ADVICE",
        evidenceReference: "CARD-REFUND-1",
        reason: "استرداد موثق إلى بطاقة الشركة",
        allocations: [
          {
            supplierPaymentAllocationId: allocation.id,
            amount: "25",
            currencyAmount: "25",
          },
        ],
      },
      maker,
    );
    const decision = {
      requestId: request.requestId,
      decisionKey: randomUUID(),
      action: "APPROVE" as const,
      reviewReason: "تحققت من الاسترداد المصرفي",
    };
    await decideSupplierPaymentRefund(decision, owner);
    await decideSupplierPaymentRefund(decision, owner);
    expect(await balances()).toEqual({
      supplier: "25.00",
      drawer: "500.00",
      treasury: "2000.00",
      card: "-75.00",
    });
    expect(await db().select().from(s.supplierPaymentRefunds)).toHaveLength(1);
  });
});
