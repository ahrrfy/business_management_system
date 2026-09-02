import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import {
  createPurchaseOrder,
  receivePurchase,
} from "../purchaseService";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import { payPurchaseOrder } from "../purchase/pay";
import { computeExpectedCash } from "../shiftService";
import { approveVoucher, cancelVoucher, rejectVoucher } from "../voucherService";
import { resubmitRejectedExpensePayment } from "../voucher/approval";
import { getArApAgingDetail } from "../reportsAgingDetailService";
import { getAPAging, getSupplierStatement } from "../reports/apAging";
import { getCashFlowSeries } from "../treasury/cashFlow";
import { getRecentMovements } from "../treasury/movements";
import { getTreasurySummary } from "../reportsTreasuryService";
import { createPurchaseReturn } from "../purchaseReturnsService";
import { getFinancialPosition, plSnapshot } from "../reportsFinancialService";
import { reconcileSupplierBalances } from "../reconcileService";
import { truncateTables } from "./__testUtils__";

const creator = { userId: 1, branchId: 1, role: "purchasing" as const };
const receiver = { userId: 2, branchId: 1, role: "warehouse" as const };
const approver = { userId: 3, branchId: 1, role: "manager" as const };

const TABLES = [
  "idempotencyKeys",
  "purchaseOrderEvents",
  "purchaseOrderControlRequests",
  "purchaseOrderRequisitionAllocations",
  "purchaseOrderRevisionItems",
  "purchaseOrderRevisions",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "purchaseReturnItems",
  "purchaseReturns",
  "accountingEntries",
  "expenses",
  "receipts",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
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
  await db().insert(s.users).values([
    {
      id: 1,
      openId: "cash-po-creator",
      name: "منشئ الشراء",
      role: "purchasing",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "cash-po-receiver",
      name: "مستلم المخزون",
      role: "warehouse",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 3,
      openId: "cash-po-approver",
      name: "معتمد الصرف",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await db().insert(s.suppliers).values({ id: 1, name: "مورد نقدي", currentBalance: "0.00" });
  await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 1,
    openingBalance: "250.00",
    status: "OPEN",
    openGuard: "1:1:RETAIL",
  });
  await db().insert(s.receipts).values({
    branchId: 1,
    shiftId: null,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "5000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "CASH-PO-TREASURY-FUND",
    createdBy: 1,
  });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAPER-1", costPrice: "0.00" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

async function treasuryBalance() {
  return db().transaction(async (tx) => (await computeTreasuryCashBalance(tx, 1)).toFixed(2));
}

async function expectedDrawerCash() {
  return db().transaction(async (tx) => (await computeExpectedCash(tx, 1, "250.00")).toFixed(2));
}

async function approveCreatedPurchaseOrder(
  created: Awaited<ReturnType<typeof createPurchaseOrder>>,
) {
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "إرسال أمر الشراء للاعتماد المستقل",
      requestKey: `cash-po-submit:${created.purchaseOrderId}:${randomUUID()}`,
    },
    creator,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `cash-po-approve:${created.purchaseOrderId}:${randomUUID()}`,
      approve: true,
      reason: "مراجعة المورد والكميات والأسعار واعتماد الأمر",
    },
    approver,
  );
}

async function createApprovedPurchaseOrder(
  input: Omit<Parameters<typeof createPurchaseOrder>[0], "status">,
) {
  const created = await createPurchaseOrder({ ...input, status: "DRAFT" }, creator);
  await approveCreatedPurchaseOrder(created);
  return created;
}

describe("أمر الشراء النقدي — مسار المال الكامل", () => {
  it("DRAFT → اعتماد → استلام → طلب صرف → اعتماد: لا ذمة ولا دينار يضيعان", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        status: "DRAFT",
        settlementType: "CASH",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
      },
      creator,
    );

    let [order] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
    expect(order).toMatchObject({ status: "DRAFT", settlementType: "CASH", paidAmount: "0.00" });

    await approveCreatedPurchaseOrder(created);
    [order] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
    expect(order.status).toBe("CONFIRMED");
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await treasuryBalance()).toBe("5000.00");
    expect(await expectedDrawerCash()).toBe("250.00");

    const [item] = await db()
      .select()
      .from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    const received = await receivePurchase(
      {
        purchaseOrderId: created.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: item.baseQuantity }],
        clientRequestId: "cash-po-full-receipt",
      },
      receiver,
    );

    const requestId = Number(received.supplierPaymentRequestReceiptId);
    expect(requestId).toBeGreaterThan(0);
    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.id, requestId));
    expect(pending).toMatchObject({
      direction: "OUT",
      amount: "1000.00",
      paymentMethod: "CASH",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
      shiftId: null,
      partyType: "SUPPLIER",
      partyId: 1,
    });

    const [supplierBeforeApproval] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1));
    [order] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
    const entriesBeforeApproval = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, created.purchaseOrderId));
    const stock = await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1));
    const movements = await db()
      .select()
      .from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceId, created.purchaseOrderId));

    expect(supplierBeforeApproval.currentBalance).toBe("0.00");
    expect(order.paidAmount).toBe("0.00");
    expect(entriesBeforeApproval).toHaveLength(1);
    expect(entriesBeforeApproval[0]).toMatchObject({
      entryType: "PURCHASE",
      purchaseOrderId: created.purchaseOrderId,
      supplierId: 1,
      receiptId: null,
      amount: "1000.00",
      cost: "1000.00",
      purchaseLiabilityAccount: "CASH_CLEARING",
    });
    expect(await getAPAging()).toEqual([]);
    expect((await getArApAgingDetail({ side: "AP" })).rows).toEqual([]);
    expect(await reconcileSupplierBalances()).toEqual([]);
    expect(stock[0].quantity).toBe(10);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      movementType: "IN",
      referenceType: "PURCHASE_ORDER",
      referenceId: created.purchaseOrderId,
      quantity: 10,
    });
    expect(await treasuryBalance()).toBe("5000.00");
    expect(await expectedDrawerCash()).toBe("250.00");
    expect(await getFinancialPosition({ verify: true })).toMatchObject({
      apCredit: "0.00",
      cashPurchaseClearingDebit: "0.00",
      cashPurchaseClearingCredit: "1000.00",
      apReconciled: true,
    });

    const approved = await approveVoucher(requestId, approver);
    const replayed = await approveVoucher(requestId, approver);
    expect(approved.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);

    const [supplierAfterApproval] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1));
    [order] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
    const [approvedReceipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, requestId));
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, created.purchaseOrderId))
      .orderBy(asc(s.accountingEntries.id));

    expect(supplierAfterApproval.currentBalance).toBe("0.00");
    expect(order.paidAmount).toBe("1000.00");
    expect(approvedReceipt).toMatchObject({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      cashBucket: "TREASURY",
      shiftId: null,
    });
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      entryType: "PAYMENT_OUT",
      purchaseOrderId: created.purchaseOrderId,
      supplierId: 1,
      receiptId: requestId,
      amount: "1000.00",
      purchaseLiabilityAccount: "CASH_CLEARING",
    });
    expect(await treasuryBalance()).toBe("4000.00");
    expect(await expectedDrawerCash()).toBe("250.00");
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect(await getFinancialPosition({ verify: true })).toMatchObject({
      apCredit: "0.00",
      cashPurchaseClearingDebit: "0.00",
      cashPurchaseClearingCredit: "0.00",
      apReconciled: true,
    });
  });

  it("يرحّل SHADOW المخزون مقابل تسوية نقدية ثم يطفئها مقابل الخزينة بلا AP", async () => {
    await db().insert(s.doubleEntrySettings).values({
      id: 1,
      mode: "SHADOW",
      shadowCycleId: "cash-purchase-clearing-test",
    });
    const created = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    });
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    const received = await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 10 }],
      clientRequestId: "cash-po-shadow-receive",
    }, receiver);

    let lines = await db().select({
      profile: s.journalEntries.postingProfile,
      role: s.journalLines.role,
      debit: s.journalLines.debit,
      credit: s.journalLines.credit,
    }).from(s.journalLines)
      .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.journalId));
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "PURCHASE_INVENTORY_CASH_CLEARING", role: "INVENTORY", debit: "1000.00", credit: "0.00" }),
      expect.objectContaining({ profile: "PURCHASE_INVENTORY_CASH_CLEARING", role: "OTHER_LIABILITY", debit: "0.00", credit: "1000.00" }),
    ]));
    expect(lines.some((line) => line.role === "AP")).toBe(false);

    await approveVoucher(Number(received.supplierPaymentRequestReceiptId), approver);
    lines = await db().select({
      profile: s.journalEntries.postingProfile,
      role: s.journalLines.role,
      debit: s.journalLines.debit,
      credit: s.journalLines.credit,
    }).from(s.journalLines)
      .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.journalId));
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "PAYMENT_OUT_PURCHASE_CASH_CLEARING", role: "OTHER_LIABILITY", debit: "1000.00", credit: "0.00" }),
      expect.objectContaining({ profile: "PAYMENT_OUT_PURCHASE_CASH_CLEARING", role: "TREASURY_CASH", debit: "0.00", credit: "1000.00" }),
    ]));
    expect(lines.some((line) => line.role === "AP")).toBe(false);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect(await treasuryBalance()).toBe("4000.00");
  });

  it("يبقي قيد CASH التاريخي غير الموسوم على AP حتى تُعتمد دفعته القديمة بأمان", async () => {
    const created = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    });
    await db().insert(s.accountingEntries).values({
      entryType: "PURCHASE",
      branchId: 1,
      purchaseOrderId: created.purchaseOrderId,
      supplierId: 1,
      amount: "1000.00",
      cost: "1000.00",
      entryDate: "2026-08-22",
      dedupeKey: `TEST:LEGACY:CASH:${created.purchaseOrderId}`,
    });
    await db().update(s.suppliers).set({ currentBalance: "1000.00" }).where(eq(s.suppliers.id, 1));
    await db().update(s.purchaseOrders).set({ status: "RECEIVED" }).where(eq(s.purchaseOrders.id, created.purchaseOrderId));

    const request = await payPurchaseOrder({
      purchaseOrderId: created.purchaseOrderId,
      amount: "1000.00",
      method: "CASH",
      clientRequestId: "legacy-cash-po-payment",
    }, creator);
    await approveVoucher(request.paymentRequestReceiptId, approver);

    const entries = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, created.purchaseOrderId))
      .orderBy(asc(s.accountingEntries.id));
    expect(entries.map((entry) => entry.purchaseLiabilityAccount)).toEqual([null, "AP"]);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect(await treasuryBalance()).toBe("4000.00");
    expect(await reconcileSupplierBalances()).toEqual([]);
  });

  it("الاستلام الجزئي ينشئ طلباً بقيمة كل دفعة، ويقبل اعتماد الطلبات بأي ترتيب", async () => {
    const created = await createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CASH",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    }, creator);
    await approveCreatedPurchaseOrder(created);
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));

    const first = await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 4 }],
      clientRequestId: "cash-po-part-1",
    }, receiver);
    const second = await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 6 }],
      clientRequestId: "cash-po-part-2",
    }, receiver);

    const [firstRequest] = await db().select().from(s.receipts)
      .where(eq(s.receipts.id, Number(first.supplierPaymentRequestReceiptId)));
    const [secondRequest] = await db().select().from(s.receipts)
      .where(eq(s.receipts.id, Number(second.supplierPaymentRequestReceiptId)));
    expect(firstRequest.amount).toBe("400.00");
    expect(secondRequest.amount).toBe("600.00");
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect(await treasuryBalance()).toBe("5000.00");

    await approveVoucher(Number(secondRequest.id), approver);
    expect((await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, created.purchaseOrderId)))[0].paidAmount).toBe("600.00");
    expect(await treasuryBalance()).toBe("4400.00");
    await approveVoucher(Number(firstRequest.id), approver);
    expect((await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, created.purchaseOrderId)))[0].paidAmount).toBe("1000.00");
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect(await treasuryBalance()).toBe("4000.00");
    expect(await expectedDrawerCash()).toBe("250.00");
  });

  it("مرتجع الشراء النقدي واسترداده يعكسان التسوية والمخزون والدرج بلا لمس ذمة المورد", async () => {
    const created = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    });
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    const received = await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 10 }],
      clientRequestId: "cash-po-return-receive",
    }, receiver);
    await approveVoucher(Number(received.supplierPaymentRequestReceiptId), approver);

    const returned = await createPurchaseReturn({
      clientRequestId: "cash-po-return-refund",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: created.purchaseOrderId,
      items: [{ purchaseOrderItemId: Number(item.id), quantity: "4" }],
      settlement: "CASH",
      paymentMethod: "CASH",
    }, creator);

    expect(returned).toMatchObject({
      returnedTotal: "400.00",
      cashRefundAmount: "400.00",
      creditOffsetAmount: "0.00",
    });
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity).toBe(6);
    expect(await treasuryBalance()).toBe("4000.00");
    expect(await expectedDrawerCash()).toBe("650.00");
    expect(await getAPAging()).toEqual([]);
    expect(await reconcileSupplierBalances()).toEqual([]);
    expect(await getFinancialPosition({ verify: true })).toMatchObject({
      apCredit: "0.00",
      cashPurchaseClearingDebit: "0.00",
      cashPurchaseClearingCredit: "0.00",
      apReconciled: true,
    });
    const entries = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, created.purchaseOrderId))
      .orderBy(asc(s.accountingEntries.id));
    expect(entries.map((entry) => entry.entryType)).toEqual([
      "PURCHASE",
      "PAYMENT_OUT",
      "RETURN",
      "PAYMENT_IN",
    ]);
    expect(entries.every((entry) => entry.purchaseLiabilityAccount === "CASH_CLEARING")).toBe(true);
  });

  it("رفض دفعة PO ثم إعادة تقديمها وإلغاؤها وإعادة طلبها يحافظ على التسوية والتخصيص والنقد بلا ذمة مورد", async () => {
    const created = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    });
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    const received = await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 10 }],
      clientRequestId: "cash-po-reject",
    }, receiver);
    const rejectedId = Number(received.supplierPaymentRequestReceiptId);

    await rejectVoucher(rejectedId, approver, "مراجعة مستند المورد");
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, created.purchaseOrderId)))[0].paidAmount).toBe("0.00");
    expect(await treasuryBalance()).toBe("5000.00");

    const replacement = await resubmitRejectedExpensePayment(rejectedId, creator, {
      priorReceiptId: rejectedId,
      reissueReason: "استكمال مستند المورد",
      note: "تم التصحيح",
    });
    expect(replacement.receiptId).not.toBe(rejectedId);
    await approveVoucher(replacement.receiptId, approver);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, created.purchaseOrderId)))[0].paidAmount).toBe("1000.00");
    expect(await treasuryBalance()).toBe("4000.00");

    const cancellation = await cancelVoucher(replacement.receiptId, creator);
    expect(cancellation.status).toBe("PENDING_APPROVAL");
    await approveVoucher(Number(cancellation.approvalReceiptId), approver);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, created.purchaseOrderId)))[0].paidAmount).toBe("0.00");
    expect(await treasuryBalance()).toBe("5000.00");
    const linkedEntries = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, created.purchaseOrderId));
    expect(linkedEntries.map((entry) => entry.entryType)).toEqual(["PURCHASE", "PAYMENT_OUT", "PAYMENT_IN"]);

    const requestedAgain = await payPurchaseOrder({
      purchaseOrderId: created.purchaseOrderId,
      amount: "1000.00",
      method: "CASH",
      clientRequestId: "cash-po-after-cancel",
    }, creator);
    await approveVoucher(requestedAgain.paymentRequestReceiptId, approver);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("0.00");
    expect((await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, created.purchaseOrderId)))[0].paidAmount).toBe("1000.00");
    expect(await treasuryBalance()).toBe("4000.00");
  });

  it("يستخدم معامل الوحدة المثبت في سطر PO حتى لو عُدّلت الوحدة قبل الاستلام", async () => {
    await db().update(s.productUnits).set({ conversionFactor: "12" }).where(eq(s.productUnits.id, 1));
    const created = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "120.00" }],
    });
    await db().update(s.productUnits).set({ conversionFactor: "24" }).where(eq(s.productUnits.id, 1));
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));

    await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 12 }],
      clientRequestId: "po-unit-snapshot",
    }, receiver);
    expect((await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0].costPrice).toBe("10.00");
    expect((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity).toBe(12);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("120.00");
  });

  it("يرفض دفعة CREDIT تتجاوز الرصيد المعترف به لنفس PO ويعيد الاستلام كله", async () => {
    const other = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    });
    let [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, other.purchaseOrderId));
    await receivePurchase({
      purchaseOrderId: other.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 10 }],
      clientRequestId: "other-po-debt",
    }, receiver);

    const target = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    });
    [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, target.purchaseOrderId));
    await expect(receivePurchase({
      purchaseOrderId: target.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 5 }],
      payment: { amount: "1000.00", method: "CASH" },
      clientRequestId: "target-po-overallocation",
    }, receiver)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect((await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.id, Number(item.id))))[0].receivedBaseQuantity).toBe(0);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("1000.00");
    expect((await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1)))[0].quantity).toBe(10);
  });

  it("تفصيل AP يستبعد غير المستلم ويعرض الاستلام الجزئي بتاريخ الاعتراف لا تاريخ الطلب", async () => {
    const created = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    });
    expect((await getArApAgingDetail({ side: "AP", branchId: 1 })).rows).toHaveLength(0);

    const oldOrderDate = new Date(Date.now() - 120 * 86_400_000);
    await db().update(s.purchaseOrders).set({ orderDate: oldOrderDate })
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 5 }],
      clientRequestId: "aging-partial-receive",
    }, receiver);

    const detail = await getArApAgingDetail({ side: "AP", branchId: 1 });
    expect(detail.rows).toHaveLength(1);
    expect(detail.rows[0].unpaid).toBe("500.00");
    expect(detail.rows[0].bucket).toBe("0-30");
    const today = new Date().toISOString().slice(0, 10);
    expect(detail.rows[0].date).toBe(today);
    const statement = await getSupplierStatement(1, { from: today, to: today, branchId: 1 });
    expect(statement?.purchaseOrders).toHaveLength(1);
    expect(statement?.summary.totalPurchases).toBe("500.00");
  });

  it("فلتر فرع AP يعيد رصيد الفرع من GL ولا يسرّب رصيد المورد العالمي", async () => {
    await db().insert(s.branches).values({ id: 2, name: "فرع ثانٍ", code: "B2", type: "SALES" });
    await db().update(s.suppliers).set({ currentBalance: "300.00" }).where(eq(s.suppliers.id, 1));
    await db().insert(s.purchaseOrders).values([
      { id: 101, poNumber: "PO-B1", supplierId: 1, branchId: 1, subtotal: "100.00", total: "100.00", status: "RECEIVED" },
      { id: 102, poNumber: "PO-B2", supplierId: 1, branchId: 2, subtotal: "200.00", total: "200.00", status: "RECEIVED" },
    ]);
    await db().insert(s.accountingEntries).values([
      { entryType: "PURCHASE", branchId: 1, purchaseOrderId: 101, supplierId: 1, amount: "100.00", entryDate: new Date() },
      { entryType: "PURCHASE", branchId: 2, purchaseOrderId: 102, supplierId: 1, amount: "200.00", entryDate: new Date() },
    ]);

    const rows = await getAPAging({ branchId: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ currentBalance: "100.00", unpaidTotal: "100.00", unbucketed: "0.00" });
  });

  it("طلب D1 المعتمد D2 يظهر في تقارير النقد يوم الاعتماد فقط", async () => {
    const created = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      settlementType: "CASH",
      items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1000.00" }],
    });
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    const received = await receivePurchase({
      purchaseOrderId: created.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 1 }],
      clientRequestId: "cash-report-approval-day",
    }, receiver);
    const requestId = Number(received.supplierPaymentRequestReceiptId);
    await approveVoucher(requestId, approver);

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await db().update(s.receipts).set({
      createdAt: new Date(`${yesterday}T12:00:00.000Z`),
      approvedAt: new Date(`${today}T12:00:00.000Z`),
    }).where(eq(s.receipts.id, requestId));

    const series = await getCashFlowSeries({ days: 2, branchId: 1 }, { scopedBranchId: null, role: "manager" });
    expect(series.find((point) => point.day === yesterday)?.outflow).toBe("0.00");
    expect(series.find((point) => point.day === today)?.outflow).toBe("1000.00");
    expect((await getTreasurySummary({ from: yesterday, to: yesterday, branchId: 1 })).totalOut).toBe("0.00");
    expect((await getTreasurySummary({ from: today, to: today, branchId: 1 })).totalOut).toBe("1000.00");
    const movements = await getRecentMovements(
      { branchId: 1, from: today, to: today, limit: 20 },
      { scopedBranchId: null, role: "manager" },
    );
    expect(movements.some((movement) => movement.rawId === requestId)).toBe(true);
  });

  it("مرتجع شراء بسعر يختلف عن WAVG يثبت فرق السعر ولا يكسر قيمة المخزون مقابل AP", async () => {
    const receiveCredit = async (unitPrice: string, key: string) => {
      const po = await createApprovedPurchaseOrder({
        supplierId: 1,
        branchId: 1,
        settlementType: "CREDIT",
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice }],
      });
      const [item] = await db().select().from(s.purchaseOrderItems)
        .where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId));
      await receivePurchase({
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 10 }],
        clientRequestId: key,
      }, receiver);
      return po.purchaseOrderId;
    };
    await receiveCredit("100.00", "wavg-low");
    const highPoId = await receiveCredit("200.00", "wavg-high");
    const [highPoItem] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, highPoId));
    expect((await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1)))[0].costPrice).toBe("150.00");

    await createPurchaseReturn({
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: highPoId,
      settlement: "CREDIT",
      clientRequestId: "wavg-high-return",
      items: [{ purchaseOrderItemId: Number(highPoItem.id), quantity: "10" }],
    }, receiver);

    const [stock] = await db().select().from(s.branchStock).where(eq(s.branchStock.variantId, 1));
    const [variant] = await db().select().from(s.productVariants).where(eq(s.productVariants.id, 1));
    const [supplier] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1));
    const [returnEntry] = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.entryType, "RETURN"));
    expect(stock.quantity).toBe(10);
    expect(variant.costPrice).toBe("150.00");
    expect(supplier.currentBalance).toBe("1000.00");
    expect(returnEntry).toMatchObject({ amount: "-2000.00", cost: "-1500.00", profit: "500.00" });
    const statement = await getSupplierStatement(1);
    expect(statement?.purchaseOrders.find((po) => po.id === highPoId)).toMatchObject({
      total: "2000.00",
      paidAmount: "2000.00",
    });
    const today = new Date().toISOString().slice(0, 10);
    const pl = await plSnapshot(today, today, 1);
    expect(pl.expenseLines.find((line) => line.key === "PURCH_RETURN_PRICE_VARIANCE")?.amount).toBe("-500.00");
    expect(pl.netProfit).toBe("500.00");

    await expect(createPurchaseReturn({
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: highPoId,
      settlement: "CREDIT",
      clientRequestId: "wavg-high-return",
      items: [{ purchaseOrderItemId: Number(highPoItem.id), quantity: "5" }],
    }, receiver)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
