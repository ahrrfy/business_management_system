import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPurchaseOrder,
  updatePurchaseOrder,
  receivePurchase as receivePurchaseRaw,
} from "../purchaseService";
import {
  decidePurchaseOrderControl,
  requestPurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";
import { postApprovedPurchaseInvoiceInTx } from "../purchase/automaticInvoicePosting";
import { settlePurchaseShippingFromShift } from "../purchase/pay";
import { closeShift, getShiftReport, openShift } from "../shiftService";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
import { withTx } from "../tx";
import { cancelExpense } from "../expenseService";
import { purchaseOrderControlSource } from "../decisions/sources/purchasing";
import { requestAccrualCorrection } from "../accounting/accrualCorrection";
import { approveVoucher, cancelVoucher, getVoucher, rejectVoucher } from "../voucherService";
import { resubmitRejectedExpensePayment } from "../voucher/approval";
import { truncateTables } from "./__testUtils__";

const adminActor = { userId: 1, branchId: 1, role: "admin" as const };
const ownerActor = { userId: 2, branchId: 1, role: "manager" as const };
const cashierActor = { userId: 3, branchId: 1, role: "cashier" as const };

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
  "accrualCorrectionRequests",
  "accrualObligationEvents",
  "accrualObligations",
  "accountingEntries",
  "expenses",
  "receipts",
  "shifts",
  "financialPeriods",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "purchaseControlSettings",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function receivePurchase(
  input: Parameters<typeof receivePurchaseRaw>[0],
  currentActor: Parameters<typeof receivePurchaseRaw>[1],
) {
  return receivePurchaseRaw(
    {
      shippingBeneficiaryName: "شركة الشحن السريع",
      shippingEvidenceReference: `SHIP-EVIDENCE-PO-${input.purchaseOrderId}`,
      ...input,
    },
    currentActor,
  );
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "MAIN", code: "MAIN", type: "MAIN" },
    { id: 2, name: "SALES", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "admin-1",
      name: "المدير العام",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "owner-2",
      name: "المالك المعتمد",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
    {
      id: 3,
      openId: "cashier-3",
      name: "كاشير الوردية",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
  ]);
  await d
    .insert(s.suppliers)
    .values({ id: 1, name: "مورد البضاعة", currentBalance: "0" });
  await d.insert(s.receipts).values([
    {
      branchId: 1,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: "10000000.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      referenceNumber: "TEST-TREASURY-FUND-1",
      createdBy: 1,
    },
    {
      branchId: 2,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: "10000000.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      referenceNumber: "TEST-TREASURY-FUND-2",
      createdBy: 1,
    },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "منتج تجريبي 1" },
    { id: 2, name: "منتج تجريبي 2" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "SKU-1", costPrice: "0.00" },
    { id: 2, productId: 2, sku: "SKU-2", costPrice: "0.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
    {
      id: 2,
      variantId: 2,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

async function createApprovedPurchaseOrder(
  input: Parameters<typeof createPurchaseOrder>[0],
  creator: typeof cashierActor = cashierActor,
) {
  const created = await createPurchaseOrder(input, creator);
  const submitted = await submitPurchaseOrderForApproval(
    {
      purchaseOrderId: created.purchaseOrderId,
      expectedVersion: created.version,
      reason: "اعتماد أمر الشراء لاختبار حوكمة صرف الشحن من درج الوردية",
      requestKey: `shipping-shift-submit:${randomUUID()}`,
    },
    creator,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: `shipping-shift-approve:${randomUUID()}`,
      approve: true,
      reason: "اعتماد أمر الشراء",
    },
    ownerActor,
    { legacyConfirmOnly: true },
  );
  return created;
}

async function itemsOf(poId: number) {
  return db()
    .select()
    .from(s.purchaseOrderItems)
    .where(eq(s.purchaseOrderItems.purchaseOrderId, poId))
    .orderBy(s.purchaseOrderItems.id);
}

async function approveDeclaredShipping(purchaseOrderId: number) {
  const [obligation] = await db().select().from(s.accrualObligations)
    .where(eq(s.accrualObligations.purchaseOrderId, purchaseOrderId));
  const [request] = await db().select().from(s.accrualObligationEvents)
    .where(and(eq(s.accrualObligationEvents.obligationId, obligation.id), eq(s.accrualObligationEvents.eventType, "PAYMENT_REQUESTED")));
  return approveVoucher(Number(request.receiptId), ownerActor);
}

describe("حوكمة صرف مصاريف الشحن من درج نقدية الوردية (DRAWER Cash)", () => {
  it("invoice approval only requests shipping payment; independent cash approval debits the frozen creator drawer", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const reviewerShift = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      ownerActor,
    );
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        shippingCost: "2000.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: creatorShift.shiftId,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
      cashierActor,
    );
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe(
      "100000.00",
    );
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "Documented shipping paid from creator drawer",
        requestKey: randomUUID(),
      },
      cashierActor,
    );
    const decisions = await purchaseOrderControlSource.list(
      {
        ...ownerActor,
        isOwner: true,
        permissionsOverride: null,
        crossBranch: true,
      },
      { branchIds: [1], now: new Date() },
    );
    const shippingEvidence = decisions
      .find((row) => row.id === submitted.requestId)
      ?.summaryItems.map((item) => item.label)
      .join(" ");
    expect(shippingEvidence).toContain("2000.00 د.ع");
    expect(shippingEvidence).toContain(`ورديته #${creatorShift.shiftId}`);
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: randomUUID(),
        approve: true,
        reason: "Independent full receipt review",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe("100000.00");
    const pendingShipping = (await db().select().from(s.receipts))
      .find((receipt) => receipt.referenceNumber?.startsWith("SHIP-"))!;
    expect(pendingShipping).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null, shiftId: null });
    await expect(approveVoucher(Number(pendingShipping.id), ownerActor, { cashSource: { mode: "DRAWER", shiftId: reviewerShift.shiftId } })).rejects.toThrow(/لا يطابق تصريح المنشئ/);
    await expect(approveVoucher(Number(pendingShipping.id), ownerActor, { cashSource: { mode: "TREASURY" } })).rejects.toThrow(/لا يطابق تصريح المنشئ/);
    await expect(settlePurchaseShippingFromShift({ purchaseOrderId: draft.purchaseOrderId }, ownerActor)).rejects.toThrow(/اعتماد سند الصرف المستقل/);
    await approveVoucher(Number(pendingShipping.id), ownerActor);
    const creatorReport = await getShiftReport(creatorShift.shiftId);
    expect(creatorReport.expectedCash).toBe("98000.00");
    expect((await getShiftReport(reviewerShift.shiftId)).expectedCash).toBe(
      "80000.00",
    );
    expect(
      creatorReport.cashReconciliation.breakdown.expenses.some(
        (item) => item.amount === "2000.00",
      ),
    ).toBe(true);
  });
  it("manager reissue preserves the shipping payer, separate audit actor, and drawer replay after closure", async () => {
    const creatorShift = await openShift({ branchId: 1, openingBalance: "100000.00" }, cashierActor);
    const reviewerShift = await openShift({ branchId: 1, openingBalance: "80000.00" }, ownerActor);
    const draft = await createPurchaseOrder({
      supplierId: 1, branchId: 1, shippingCost: "2000.00",
      shippingFundingSource: "DRAWER", shippingShiftId: creatorShift.shiftId,
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    }, cashierActor);
    const submitted = await submitPurchaseOrderForApproval({
      purchaseOrderId: draft.purchaseOrderId, expectedVersion: draft.version,
      reason: "Creator drawer declaration", requestKey: randomUUID(),
    }, cashierActor);
    await decidePurchaseOrderControl({
      requestId: submitted.requestId, decisionKey: randomUUID(), approve: true,
      reason: "Full goods receipt review only", confirmedFullReceipt: true,
    }, ownerActor);
    const original = (await db().select().from(s.receipts))
      .find((receipt) => receipt.referenceNumber?.startsWith("SHIP-"))!;
    await rejectVoucher(Number(original.id), ownerActor, "صحح مرفق دليل الشحن");
    const correction = {
      priorReceiptId: Number(original.id), reissueReason: "تم تصحيح مرفق دليل الشحن",
      attachmentUrl: "https://example.test/corrected-shipping-proof.pdf",
    };
    const replacement = await resubmitRejectedExpensePayment(Number(original.id), adminActor, correction);
    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.id, replacement.receiptId));
    expect(pending).toMatchObject({ createdBy: cashierActor.userId, cashBucket: null, shiftId: null, approvalStatus: "PENDING_APPROVAL" });
    const [reissueEvent] = await db().select().from(s.accrualObligationEvents)
      .where(and(eq(s.accrualObligationEvents.receiptId, replacement.receiptId), eq(s.accrualObligationEvents.eventType, "PAYMENT_REQUESTED")));
    expect(reissueEvent.actorId).toBe(cashierActor.userId);
    const [reissueAudit] = await db().select().from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityId, String(replacement.receiptId)), eq(s.auditLogs.action, "voucher.systemPayment.preserveDrawerMaker")));
    expect(reissueAudit.userId).toBe(adminActor.userId);
    expect(await resubmitRejectedExpensePayment(Number(original.id), adminActor, correction))
      .toMatchObject({ receiptId: replacement.receiptId, replayed: true });
    await approveVoucher(replacement.receiptId, ownerActor);
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe("98000.00");
    expect((await getShiftReport(reviewerShift.shiftId)).expectedCash).toBe("80000.00");
    const [paid] = await db().select().from(s.receipts).where(eq(s.receipts.id, replacement.receiptId));
    expect(paid).toMatchObject({ createdBy: cashierActor.userId, approvedBy: ownerActor.userId, cashBucket: "DRAWER", shiftId: creatorShift.shiftId });
    expect(await resubmitRejectedExpensePayment(Number(original.id), adminActor, correction))
      .toMatchObject({ receiptId: replacement.receiptId, approvalStatus: "APPROVED", replayed: true });
    await closeShift({ shiftId: creatorShift.shiftId, countedCash: "98000.00", enforceCashGovernance: true }, cashierActor);
    expect(await resubmitRejectedExpensePayment(Number(original.id), adminActor, correction))
      .toMatchObject({ receiptId: replacement.receiptId, approvalStatus: "APPROVED", replayed: true });
    const payments = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.receiptId, replacement.receiptId), eq(s.accountingEntries.entryType, "PAYMENT_OUT")));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ createdBy: cashierActor.userId, amount: "2000.00" });
    const [preserved] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(original.id)));
    expect(preserved).toMatchObject({ status: "FAILED", approvalStatus: "REJECTED", createdBy: cashierActor.userId, cashBucket: null, shiftId: null });
  });
  it("keeps the frozen shipping drawer and rejects approval after it closes, without using the reviewer's drawer", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const reviewerShift = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      ownerActor,
    );
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        shippingCost: "2000.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: creatorShift.shiftId,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
      cashierActor,
    );
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "Documented creator shipping payment",
        requestKey: randomUUID(),
      },
      cashierActor,
    );
    // Historical/race fixture: the source closed before this safeguard existed.
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null, closedAt: new Date() })
      .where(eq(s.shifts.id, creatorShift.shiftId));
    await expect(
      decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: randomUUID(),
          approve: true,
          reason: "Independent full receipt review",
          confirmedFullReceipt: true,
        },
        ownerActor,
      ),
    ).rejects.toThrow(/وردية مغلقة/);
    expect((await getShiftReport(reviewerShift.shiftId)).expectedCash).toBe(
      "80000.00",
    );
  });
  it("independent shipping approval refuses a closed frozen drawer even after the creator opens a newer one", async () => {
    const original = await openShift({ branchId: 1, openingBalance: "100000.00" }, cashierActor);
    const draft = await createPurchaseOrder({
      supplierId: 1, branchId: 1, shippingCost: "2000.00",
      shippingFundingSource: "DRAWER", shippingShiftId: original.shiftId,
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }],
    }, cashierActor);
    const submitted = await submitPurchaseOrderForApproval({
      purchaseOrderId: draft.purchaseOrderId, expectedVersion: draft.version,
      reason: "Creator drawer declaration", requestKey: randomUUID(),
    }, cashierActor);
    await decidePurchaseOrderControl({
      requestId: submitted.requestId, decisionKey: randomUUID(), approve: true,
      reason: "Full goods receipt review only", confirmedFullReceipt: true,
    }, ownerActor);
    // Historical/race fixture only: normal closure is blocked until payment.
    await db().update(s.shifts).set({ status: "CLOSED", openGuard: null, closedAt: new Date() })
      .where(eq(s.shifts.id, original.shiftId));
    const newer = await openShift({ branchId: 1, openingBalance: "70000.00" }, cashierActor);
    await expect(approveDeclaredShipping(draft.purchaseOrderId)).rejects.toThrow(/مغلقة/);
    expect((await getShiftReport(newer.shiftId)).expectedCash).toBe("70000.00");
  });
  it("refuses a shipping payment declaration from another user's drawer and a reused key with changed payment source", async () => {
    const reviewerShift = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      ownerActor,
    );
    const input = {
      supplierId: 1,
      branchId: 1,
      shippingCost: "2000.00",
      clientRequestId: randomUUID(),
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
    };
    await expect(
      createPurchaseOrder(
        {
          ...input,
          shippingFundingSource: "DRAWER",
          shippingShiftId: reviewerShift.shiftId,
        },
        cashierActor,
      ),
    ).rejects.toThrow(/منشئ الفاتورة/);
    await createPurchaseOrder(input, cashierActor);
    await expect(
      createPurchaseOrder(
        { ...input, shippingFundingSource: "DRAWER" },
        cashierActor,
      ),
    ).rejects.toThrow();
    expect((await getShiftReport(reviewerShift.shiftId)).expectedCash).toBe(
      "80000.00",
    );
  });
  it("blocks shift closure until declared paid invoice shipping is posted, instead of accepting a false count", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        shippingCost: "2000.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: creatorShift.shiftId,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
      cashierActor,
    );
    await expect(
      closeShift(
        {
          shiftId: creatorShift.shiftId,
          countedCash: "100000.00",
          enforceCashGovernance: true,
        },
        cashierActor,
      ),
    ).rejects.toThrow(/شحن.*لم يسجل/);
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "Paid shipping evidence",
        requestKey: randomUUID(),
      },
      cashierActor,
    );
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: randomUUID(),
        approve: true,
        reason: "Reviewed creator payment",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    await expect(closeShift({ shiftId: creatorShift.shiftId, countedCash: "98000.00", enforceCashGovernance: true }, cashierActor)).rejects.toThrow(/شحن.*لم يسجل/);
    await approveDeclaredShipping(draft.purchaseOrderId);
    const closed = await closeShift(
      {
        shiftId: creatorShift.shiftId,
        countedCash: "98000.00",
        enforceCashGovernance: true,
      },
      cashierActor,
    );
    expect(closed.variance).toBe("0.00");
  });
  it("preserves the creator's shipping declaration on unrelated edits and refuses reviewer changes to it", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const input = {
      supplierId: 1,
      shippingCost: "2000.00",
      shippingFundingSource: "DRAWER" as const,
      shippingShiftId: creatorShift.shiftId,
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
    };
    const draft = await createPurchaseOrder(
      { ...input, branchId: 1 },
      cashierActor,
    );
    const updated = await updatePurchaseOrder(
      {
        ...input,
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        revisionReason: "Unrelated note",
        notes: "Delivery reference only",
      },
      ownerActor,
    );
    await expect(
      updatePurchaseOrder(
        {
          ...input,
          shippingFundingSource: "ACCRUAL",
          shippingShiftId: null,
          purchaseOrderId: draft.purchaseOrderId,
          expectedVersion: updated.version,
          revisionReason: "Clear creator paid declaration",
        },
        ownerActor,
      ),
    ).rejects.toThrow(/تصريح دفع الشحن/);
    await expect(
      updatePurchaseOrder(
        {
          ...input,
          shippingCost: "3000.00",
          purchaseOrderId: draft.purchaseOrderId,
          expectedVersion: updated.version,
          revisionReason: "Alter paid amount",
        },
        ownerActor,
      ),
    ).rejects.toThrow(/تصريح دفع الشحن/);
  });
  it("cancelling goods preserves actual creator-paid shipping without receiving goods or paying a supplier, and replays once", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const reviewerShift = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      ownerActor,
    );
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        shippingCost: "2000.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: creatorShift.shiftId,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
      cashierActor,
    );
    const cancellation = await requestPurchaseOrderControl(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        kind: "CANCEL_ORDER",
        requestKey: randomUUID(),
        reason: "Goods cancelled; freight already paid",
      },
      cashierActor,
    );
    const decision = {
      requestId: cancellation.requestId,
      decisionKey: randomUUID(),
      approve: true,
      reason: "Cancel goods and retain actual freight expense",
    };
    await decidePurchaseOrderControl(decision, ownerActor);
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe("100000.00");
    await approveDeclaredShipping(draft.purchaseOrderId);
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe(
      "98000.00",
    );
    expect((await getShiftReport(reviewerShift.shiftId)).expectedCash).toBe(
      "80000.00",
    );
    expect(
      await db()
        .select()
        .from(s.goodsReceipts)
        .where(eq(s.goodsReceipts.purchaseOrderId, draft.purchaseOrderId)),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.supplierInvoices)
        .where(
          eq(s.supplierInvoices.legacyPurchaseOrderId, draft.purchaseOrderId),
        ),
    ).toHaveLength(0);
    await closeShift(
      {
        shiftId: creatorShift.shiftId,
        countedCash: "98000.00",
        enforceCashGovernance: true,
      },
      cashierActor,
    );
    expect(
      (await decidePurchaseOrderControl(decision, ownerActor)).idempotent,
    ).toBe(true);
    expect((await approveDeclaredShipping(draft.purchaseOrderId)).replayed).toBe(true);
  });
  it("refuses generic cancellation of governed paid shipping without inventing a refund", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        shippingCost: "2000.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: creatorShift.shiftId,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
      cashierActor,
    );
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "Paid shipping evidence",
        requestKey: randomUUID(),
      },
      cashierActor,
    );
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: randomUUID(),
        approve: true,
        reason: "Reviewed creator payment",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    await approveDeclaredShipping(draft.purchaseOrderId);
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    await expect(
      cancelExpense(Number(obligation.expenseId), ownerActor),
    ).rejects.toThrow(/طلب تصحيح المصدر/);
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe(
      "98000.00",
    );
    expect(
      (
        await closeShift(
          {
            shiftId: creatorShift.shiftId,
            countedCash: "98000.00",
            enforceCashGovernance: true,
          },
          cashierActor,
        )
      ).variance,
    ).toBe("0.00");
  });
  it("concurrent copies of the same shipping approval return one result and one cash debit", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        shippingCost: "2000.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: creatorShift.shiftId,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
      cashierActor,
    );
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "Paid shipping evidence",
        requestKey: randomUUID(),
      },
      cashierActor,
    );
    const decision = {
      requestId: submitted.requestId,
      decisionKey: randomUUID(),
      approve: true,
      reason: "Concurrent identical delivery decision",
      confirmedFullReceipt: true,
    };
    const results = await Promise.all([
      decidePurchaseOrderControl(decision, ownerActor),
      decidePurchaseOrderControl(decision, ownerActor),
    ]);
    expect(results.filter((result) => result.idempotent)).toHaveLength(1);
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe("100000.00");
    const paymentResults = await Promise.all([approveDeclaredShipping(draft.purchaseOrderId), approveDeclaredShipping(draft.purchaseOrderId)]);
    expect(paymentResults.filter((result) => result.replayed)).toHaveLength(1);
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe(
      "98000.00",
    );
  });
  it("rejects generic shipping cancellation and allows a governed real refund without blocking drawer closure", async () => {
    const creatorShift = await openShift(
      { branchId: 1, openingBalance: "100000.00" },
      cashierActor,
    );
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        shippingCost: "2000.00",
        shippingFundingSource: "DRAWER",
        shippingShiftId: creatorShift.shiftId,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
      },
      cashierActor,
    );
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "Paid shipping evidence",
        requestKey: randomUUID(),
      },
      cashierActor,
    );
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: randomUUID(),
        approve: true,
        reason: "Reviewed creator payment",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    const shippingPayment = await approveDeclaredShipping(draft.purchaseOrderId);
    await expect(cancelVoucher(shippingPayment.receiptId, ownerActor)).rejects.toThrow(/الوحدة المصدر/);
    expect(await getVoucher(shippingPayment.receiptId)).toMatchObject({ status: "COMPLETED", approvalStatus: "APPROVED", cashBucket: "DRAWER", shiftId: creatorShift.shiftId });
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe("98000.00");
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    const correction = await requestAccrualCorrection(
      {
        obligationId: Number(obligation.id),
        reason: "Carrier refunded to the actual drawer receiver",
        externalEvidenceReference: "TEST-CARRIER-REFUND",
        attachmentUrl: "https://example.invalid/refund-proof",
        refundPaymentMethod: "CASH",
        refundCashBucket: "DRAWER",
        clientRequestId: randomUUID(),
      },
      cashierActor,
    );
    await approveVoucher(Number(correction.refundRequestReceiptId), {
      ...ownerActor,
      isOwner: true,
    });
    expect(await getVoucher(shippingPayment.receiptId)).toMatchObject({ status: "COMPLETED", approvalStatus: "APPROVED" });
    expect((await getShiftReport(creatorShift.shiftId)).expectedCash).toBe(
      "100000.00",
    );
    expect(
      (
        await closeShift(
          {
            shiftId: creatorShift.shiftId,
            countedCash: "100000.00",
            enforceCashGovernance: true,
          },
          cashierActor,
        )
      ).variance,
    ).toBe("0.00");
  });
  it("(١) صرف أجور الشحن مباشرة من الدرج عند الاستلام — ينقص نقد الدرج المتوقع ويغلق الوردية بفارق 0.00 د.ع", async () => {
    // 1. فتح وردية كاشير برصيد افتتاحي 100,000 د.ع
    const shift = await openShift(
      { branchId: 1, openingBalance: "100000.00", shiftType: "RETAIL" },
      cashierActor,
    );
    expect(shift.shiftId).toBeGreaterThan(0);

    // الرصيد المتوقع للدرج لحظة الافتتاح
    const balanceInitial = await withTx((tx) =>
      computeDrawerCashBalance(tx, shift.shiftId, "100000.00"),
    );
    expect(balanceInitial.toFixed(2)).toBe("100000.00");

    // 2. إنشاء واعتماد أمر شراء بشحن 3,000 د.ع وكمرك 2,000 د.ع (إجمالي الشحن = 5,000 د.ع)
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" }, // 1,000
        { variantId: 2, productUnitId: 2, quantity: "5", unitPrice: "600.00" }, // 3,000
      ],
      shippingCost: "3000.00",
      customsCost: "2000.00",
    });

    const items = await itemsOf(po.purchaseOrderId);

    // 3. استلام أمر الشراء مع تحديد مصدر تمويل الشحن من الدرج (DRAWER) للوردية المفتوحة
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        shippingFundingSource: "DRAWER",
        shippingShiftId: shift.shiftId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // 4. التحقق من رصيد الدرج المتوقع بعد الصرف: 100,000 - 5,000 = 95,000 د.ع
    const balanceAfter = await withTx((tx) =>
      computeDrawerCashBalance(tx, shift.shiftId, "100000.00"),
    );
    expect(balanceAfter.toFixed(2)).toBe("95000.00");

    // 5. التحقق من التزام الشحن: تحول إلى PAID
    const obligations = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    expect(obligations).toHaveLength(1);
    expect(obligations[0].kind).toBe("PURCHASE_SHIPPING");
    expect(obligations[0].status).toBe("PAID");
    expect(obligations[0].recognizedAmount).toBe("5000.00");

    // 6. التحقق من إيصال الصرف وسجل المصروف
    const [expRow] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligations[0].expenseId)));
    expect(expRow).toBeTruthy();
    expect(expRow.cashBucket).toBe("DRAWER");
    expect(expRow.shiftId).toBe(shift.shiftId);
    expect(expRow.paymentMethod).toBe("CASH");
    expect(expRow.receiptId).toBeGreaterThan(0);

    const [rcptRow] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(expRow.receiptId)));
    expect(rcptRow).toBeTruthy();
    expect(rcptRow.direction).toBe("OUT");
    expect(rcptRow.cashBucket).toBe("DRAWER");
    expect(rcptRow.shiftId).toBe(shift.shiftId);
    expect(rcptRow.amount).toBe("5000.00");
    expect(rcptRow.status).toBe("COMPLETED");
    expect(rcptRow.approvalStatus).toBe("APPROVED");

    // 7. التحقق من مطابقة تسوية الوردية (Z-report): المصروف 5,000 د.ع والمتوقع 95,000 د.ع
    const report = await getShiftReport(shift.shiftId);
    expect(report?.cashReconciliation.expenses).toBe("5000.00");
    expect(report?.cashReconciliation.expectedCash).toBe("95000.00");

    // 8. إغلاق الوردية بالمبلغ الفعلي في الدرج (95,000 د.ع) — فارق العجز صفر تماماً!
    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "95000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("95000.00");
    expect(closed.variance).toBe("0.00");
    expect(closed.reconciliationStatus).toBe("MATCHED");
  });

  it("(٢) تسوية أجور الشحن لاحقاً من وردية الكاشير (settlePurchaseShippingFromShift) — ينقص نقد الدرج ويغلق الوردية بفارق 0.00 د.ع", async () => {
    // 1. إنشاء أمر شراء بشحن 5,000 وكمرك 3,000 (الإجمالي 8,000 د.ع) واستلامه بدون صرف مباشر من الدرج
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "5000.00",
      customsCost: "3000.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // التزام الشحن معلق بمبلغ 8,000 د.ع
    const [initialObligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, po.purchaseOrderId));
    expect(initialObligation.status).toMatch(/ACCRUED_UNPAID|PAYMENT_PENDING/);
    expect(initialObligation.recognizedAmount).toBe("8000.00");

    // 2. الكاشير يفتح وردية برصيد 50,000 د.ع
    const shift = await openShift(
      { branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    // 3. صرف وتسوية أجور الشحن نقداً من درج الوردية المفتوحة
    const settleRes = await settlePurchaseShippingFromShift(
      {
        purchaseOrderId: po.purchaseOrderId,
        shiftId: shift.shiftId,
      },
      ownerActor,
    );

    expect(settleRes.status).toBe("PAID");
    expect(settleRes.amount).toBe("8000.00");
    expect(settleRes.shiftId).toBe(shift.shiftId);
    expect(settleRes.receiptId).toBeGreaterThan(0);

    // 4. التحقق من هبوط نقد الدرج المتوقع: 50,000 - 8,000 = 42,000 د.ع
    const balanceAfter = await withTx((tx) =>
      computeDrawerCashBalance(tx, shift.shiftId, "50000.00"),
    );
    expect(balanceAfter.toFixed(2)).toBe("42000.00");

    // 5. التحقق من التزام الشحن بعد التسوية
    const [settledObligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.id, initialObligation.id));
    expect(settledObligation.status).toBe("PAID");

    // 6. التحقق من إضافة حدث PO-SHIPPING-DRAWER-SETTLED
    const poEvents = await db()
      .select()
      .from(s.purchaseOrderEvents)
      .where(eq(s.purchaseOrderEvents.purchaseOrderId, po.purchaseOrderId));
    const settleEvent = poEvents.find(
      (e) => e.eventType === "SHIPPING_SETTLED_FROM_DRAWER",
    );
    expect(settleEvent).toBeTruthy();
    expect(settleEvent?.reason).toContain("صرف أجور الشحن");

    // 7. إغلاق الوردية بالمبلغ الفعلي (42,000 د.ع) — فارق العجز صفر تماماً!
    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "42000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("42000.00");
    expect(closed.variance).toBe("0.00");
    expect(closed.reconciliationStatus).toBe("MATCHED");
  });

  it("(٣) حارس سقف النثرية النقدية يمنع صرف الشحن ≥ ٥٠٠٬٠٠٠ د.ع من الدرج", async () => {
    // إنشاء أمر شراء بشحن 500,000 د.ع
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "500000.00",
      customsCost: "0.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    const shift = await openShift(
      { branchId: 1, openingBalance: "600000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    try {
      // محاولة الصرف من الدرج يجب أن ترفض بسبب سقف النثرية
      await expect(
        settlePurchaseShippingFromShift(
          {
            purchaseOrderId: po.purchaseOrderId,
            shiftId: shift.shiftId,
          },
          cashierActor,
        ),
      ).rejects.toThrow(/سقف النثرية/);
    } finally {
      await closeShift(
        { shiftId: shift.shiftId, countedCash: "600000.00" },
        cashierActor,
      );
    }
  });

  it("(٤) حارس وجود الوردية المفتوحة يمنع الصرف من الدرج عند عدم وجود وردية مفتوحة", async () => {
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "5000.00",
      customsCost: "0.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // محاولة الصرف بدون فتح وردية
    await expect(
      settlePurchaseShippingFromShift(
        {
          purchaseOrderId: po.purchaseOrderId,
        },
        cashierActor,
      ),
    ).rejects.toThrow(/فتح وردية/);
  });

  it("(٥) اعتماد أمر أنشأه الكاشير مع وردية مفتوحة يثبت الشحن استحقاقاً ولا يصرف من الدرج", async () => {
    // 1. فتح وردية للكاشير
    const shift = await openShift(
      { branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    // 2. الكاشير ينشئ أمر الشراء متضمناً شحن وكمرك
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
        shippingCost: "3000.00",
        customsCost: "2000.00",
      },
      cashierActor,
    );

    // 3. الكاشير يرسل الأمر للاعتماد
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء بضاعة مع شحن وكمرك من الكاشير",
        requestKey: `shipping-maker-checker-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    // 4. المالك يعتمد أمر الشراء استلاماً فورياً
    const approved = await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-maker-checker-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد أمر شراء الكاشير",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    expect(approved.status).toBe("APPROVED");

    // 5. التحقق من التزام الشحن
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    expect(obligation).toBeDefined();
    expect(obligation.status).toBe("PAYMENT_PENDING");
    expect(obligation.recognizedAmount).toBe("5000.00");
    expect(obligation.recognizedBy).toBe(cashierActor.userId);

    // 6. المصروف مستحق ومنسوب للكاشير، بلا اختيار مصدر نقدي
    const [exp] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(exp).toBeDefined();
    expect(exp.createdBy).toBe(cashierActor.userId);
    expect(exp.amount).toBe("5000.00");
    expect(exp.paymentMethod).toBe("ACCRUAL");
    expect(exp.cashBucket).toBeNull();
    expect(exp.shiftId).toBeNull();

    // 7. طلب الصرف يبقى معلقاً حتى قرار دفع مستقل
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    const shippingReceipt = outReceipts.find(
      (r) =>
        r.referenceNumber?.includes(`SHIP-PO-`) ||
        r.description?.includes("شحن"),
    );
    expect(shippingReceipt).toBeDefined();
    expect(shippingReceipt?.createdBy).toBe(cashierActor.userId);
    expect(shippingReceipt?.approvedBy).toBeNull();
    expect(shippingReceipt?.cashBucket).toBeNull();
    expect(shippingReceipt?.shiftId).toBeNull();
    expect(shippingReceipt?.status).toBe("PENDING");
    expect(shippingReceipt?.approvalStatus).toBe("PENDING_APPROVAL");

    // 8. التحقق من القيود المحاسبية: قيد التسوية منسوب للكاشير
    const poEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, draft.purchaseOrderId));
    const settleEntry = poEntries.find((e) => e.entryType === "PAYMENT_OUT");
    expect(settleEntry).toBeUndefined();

    // 9. اعتماد الأمر لم يخصم 5,000 د.ع من نقدية الدرج
    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "50000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("50000.00");
    expect(closed.variance).toBe("0.00");
    expect(closed.reconciliationStatus).toBe("MATCHED");
  });

  it("(٦) اعتماد أمر بلا وردية مفتوحة لا يختار الخزينة تلقائياً ويبقي طلب الشحن معلقاً", async () => {
    // لا توجد وردية مفتوحة لأي مستخدم
    // 1. الكاشير ينشئ أمر الشراء
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
        shippingCost: "4000.00",
        customsCost: "0.00",
      },
      cashierActor,
    );

    // 2. الكاشير يرسل للاعتماد
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء كاشير خارج الوردية",
        requestKey: `shipping-treasury-fallback-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    // 3. المالك يعتمد الأمر
    const approved = await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-treasury-fallback-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد وصرف من الخزينة لعدم وجود وردية",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    expect(approved.status).toBe("APPROVED");

    // 4. التحقق من التزام الشحن
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    expect(obligation).toBeDefined();
    expect(obligation.status).toBe("PAYMENT_PENDING");
    expect(obligation.recognizedBy).toBe(cashierActor.userId);

    // 5. التحقق من المصروف المستحق: منسوب للكاشير بلا ادعاء صرف
    const [exp] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(exp).toBeDefined();
    expect(exp.createdBy).toBe(cashierActor.userId);
    expect(exp.amount).toBe("4000.00");
    expect(exp.paymentMethod).toBe("ACCRUAL");

    // 6. طلب الصرف معلق وبلا مصدر نقدي
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    const shippingReceipt = outReceipts.find((r) => r.amount === "4000.00");
    expect(shippingReceipt).toBeDefined();
    expect(shippingReceipt?.createdBy).toBe(cashierActor.userId);
    expect(shippingReceipt?.approvedBy).toBeNull();
    expect(shippingReceipt?.cashBucket).toBeNull();
    expect(shippingReceipt?.shiftId).toBeNull();
    expect(shippingReceipt?.status).toBe("PENDING");
    expect(shippingReceipt?.approvalStatus).toBe("PENDING_APPROVAL");

    // التحقق من طبيعة مصروف الاستحقاق في سقوط الخزينة: منسوب للكاشير وبلا حجز درج
    expect(exp.cashBucket).toBeNull();
    expect(exp.shiftId).toBeNull();

    // 7. التحقق من القيود المحاسبية: قيد PAYMENT_OUT منسوب للكاشير ويحمل الملاحظة
    const poEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, draft.purchaseOrderId));
    const settleEntry = poEntries.find((e) => e.entryType === "PAYMENT_OUT");
    expect(settleEntry).toBeUndefined();
  });

  it("(٧) فتح وردية بعد إنشاء الأمر لا يجعل الاعتماد يصرف الشحن من الدرج", async () => {
    // 1. الكاشير ينشئ أمر الشراء قبل فتح الوردية
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
        shippingCost: "2500.00",
        customsCost: "0.00",
      },
      cashierActor,
    );

    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء قبل الوردية",
        requestKey: `shipping-dynamic-shift-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    // 2. الكاشير يفتح الوردية الآن (قبل الاعتماد)
    const shift = await openShift(
      { branchId: 1, openingBalance: "30000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    // 3. المالك يعتمد الأمر الآن
    const approved = await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-dynamic-shift-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد الأمر بعد فتح الوردية",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    expect(approved.status).toBe("APPROVED");

    // 4. يبقى الشحن استحقاقاً معلقاً رغم وجود وردية مفتوحة
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    expect(obligation.status).toBe("PAYMENT_PENDING");

    const [exp] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(exp.cashBucket).toBeNull();
    expect(exp.shiftId).toBeNull();
    expect(exp.createdBy).toBe(cashierActor.userId);

    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "30000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("30000.00");
    expect(closed.variance).toBe("0.00");
  });

  it("(٨) بلوغ الشحن سقف النثرية لا يجعل اعتماد الأمر يصرفه من الخزينة", async () => {
    // 1. الكاشير يفتح وردية برصيد 600,000 د.ع
    const shift = await openShift(
      { branchId: 1, openingBalance: "600000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    // 2. الكاشير ينشئ أمر شراء بشحن 500,000 د.ع (سقف النثرية)
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5",
            unitPrice: "200.00",
          },
        ],
        shippingCost: "500000.00",
        customsCost: "0.00",
      },
      cashierActor,
    );

    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء شحن كبير يتجاوز سقف النثرية",
        requestKey: `shipping-petty-limit-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    // 3. المالك يعتمد الأمر
    const approved = await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-petty-limit-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد أمر شراء شحن كبير",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    expect(approved.status).toBe("APPROVED");

    // 4. التحقق من بقاء طلب السداد معلقاً بلا اختيار مصدر نقدي
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    expect(obligation.status).toBe("PAYMENT_PENDING");
    expect(obligation.recognizedBy).toBe(cashierActor.userId);

    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    const shippingReceipt = outReceipts.find((r) => r.amount === "500000.00");
    expect(shippingReceipt).toMatchObject({
      createdBy: cashierActor.userId,
      approvedBy: null,
      cashBucket: null,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
    });

    const [exp] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(exp.cashBucket).toBeNull();
    expect(exp.shiftId).toBeNull();
    expect(exp.paymentMethod).toBe("ACCRUAL");
    expect(exp.createdBy).toBe(cashierActor.userId);

    // 5. التحقق أن نقد الدرج لم يُمسّ وظل 600,000 د.ع كاملاً
    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "600000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("600000.00");
    expect(closed.variance).toBe("0.00");
  });

  it("(٩) وردية منشئ الأمر في فرع آخر لا تجعل الاعتماد يصرف من أي درج أو خزينة", async () => {
    // 1. الكاشير يفتح وردية في فرع 2
    const shiftBranch2 = await openShift(
      { branchId: 2, openingBalance: "70000.00", shiftType: "RETAIL" },
      { ...cashierActor, branchId: 2 },
    );

    // 2. الكاشير ينشئ أمر شراء للفرع 1
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "50.00",
          },
        ],
        shippingCost: "3500.00",
        customsCost: "0.00",
      },
      cashierActor,
    );

    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء للفرع 1 من كاشير بالفرع 2",
        requestKey: `shipping-cross-branch-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    // 3. المالك يعتمد الأمر في فرع 1
    const approved = await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-cross-branch-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد أمر فرع 1",
        confirmedFullReceipt: true,
      },
      ownerActor,
    );
    expect(approved.status).toBe("APPROVED");

    // 4. طلب الشحن في فرع 1 يبقى معلقاً بلا مسّ وردية فرع 2
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    const shippingReceipt = outReceipts.find((r) => r.amount === "3500.00");
    expect(shippingReceipt).toMatchObject({
      branchId: 1,
      createdBy: cashierActor.userId,
      approvedBy: null,
      cashBucket: null,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
    });

    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    const [exp] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(exp.cashBucket).toBeNull();
    expect(obligation.status).toBe("PAYMENT_PENDING");

    // 5. التحقق أن وردية الفرع 2 لم تتأثر برصيدها المتوقع إطلاقاً
    const closed = await closeShift(
      { shiftId: shiftBranch2.shiftId, countedCash: "70000.00" },
      { ...cashierActor, branchId: 2 },
    );
    expect(closed.expectedCash).toBe("70000.00");
    expect(closed.variance).toBe("0.00");
  });

  it("(١٠) اعتماد أمر شراء مع تمويل شحن مستحق (ACCRUAL): لا يُصرف نقداً من الدرج ولا الخزينة ويبقى السند والالتزام معلقين", async () => {
    // 1. الكاشير ينشئ أمر شراء بشحن
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "80.00",
          },
        ],
        shippingCost: "2000.00",
        customsCost: "0.00",
      },
      cashierActor,
    );

    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء شحن استحقاق",
        requestKey: `shipping-accrual-mode-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    // 2. المالك يعتمد الأمر (legacyConfirmOnly لنتمكن من ترحيله مع خيار ACCRUAL الصريح)
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-accrual-mode-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد أمر شراء مع شحن مستحق",
      },
      ownerActor,
      { legacyConfirmOnly: true },
    );

    // 3. الترحيل التلقائي مع تحديد خيار ACCRUAL
    await withTx((tx) =>
      postApprovedPurchaseInvoiceInTx(
        tx,
        draft.purchaseOrderId,
        ownerActor,
        `accrual-shipping-key:${randomUUID()}`,
        { shippingFundingSource: { mode: "ACCRUAL" } },
      ),
    );

    // 4. التحقق من التزام الشحن: PAYMENT_PENDING وليس PAID
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    expect(obligation).toBeDefined();
    expect(obligation.status).toBe("PAYMENT_PENDING");
    expect(obligation.recognizedBy).toBe(cashierActor.userId);

    // 5. التحقق من سند الصرف: PENDING / PENDING_APPROVAL بلا أثر نقد
    const [pendingReceipt] = await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.createdBy, cashierActor.userId),
          eq(s.receipts.status, "PENDING"),
        ),
      );
    expect(pendingReceipt).toBeDefined();
    expect(pendingReceipt.status).toBe("PENDING");
    expect(pendingReceipt.approvalStatus).toBe("PENDING_APPROVAL");
    expect(pendingReceipt.cashBucket).toBeNull();
  });

  it("(١١) استلام أمر الشراء (receivePurchase) بمستلم مختلف: يُنسب المصروف والسند وقيد الصرف لمنشئ الأمر (po.createdBy) ويُصرف من درج الكاشير", async () => {
    // 1. الكاشير يفتح وردية
    const shift = await openShift(
      { branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" },
      cashierActor,
    );

    // 2. الكاشير ينشئ أمر الشراء
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
        shippingCost: "5000.00",
        customsCost: "0.00",
      },
      cashierActor,
    );

    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء للاستلام بواسطة أمين المخزن",
        requestKey: `shipping-receive-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-receive-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد أمر الشراء للاستلام اليدوي",
      },
      ownerActor,
      { legacyConfirmOnly: true },
    );

    const items = await itemsOf(draft.purchaseOrderId);

    // 3. مسؤول مختلف (adminActor) يستلم البضاعة في المخزن
    await receivePurchase(
      {
        purchaseOrderId: draft.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // 4. التحقق من التزام الشحن: منسوب لمنشئ الفاتورة (الكاشير)
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    expect(obligation.status).toBe("PAID");
    expect(obligation.recognizedBy).toBe(cashierActor.userId);

    // 5. التحقق من المصروف: منسوب لمنشئ الفاتورة (الكاشير) ومن درج ورديته
    const [exp] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(exp.createdBy).toBe(cashierActor.userId);
    expect(exp.cashBucket).toBe("DRAWER");
    expect(exp.shiftId).toBe(shift.shiftId);
    expect(exp.receiptId).toBeGreaterThan(0);

    // 6. التحقق من إيصال الصرف: المنشئ هو الكاشير، والمعتمد هو المستلم (adminActor)
    const [rcpt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(exp.receiptId)));
    expect(rcpt.createdBy).toBe(cashierActor.userId);
    expect(rcpt.approvedBy).toBe(adminActor.userId);
    expect(rcpt.cashBucket).toBe("DRAWER");
    expect(rcpt.shiftId).toBe(shift.shiftId);

    // 7. التحقق من القيود المحاسبية: كلا القيدين (ADJUST و PAYMENT_OUT) منسوبان لمنشئ الأمر (الكاشير)
    const poEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, draft.purchaseOrderId));
    const adjustEntry = poEntries.find((e) => e.entryType === "ADJUST");
    const settleEntry = poEntries.find((e) => e.entryType === "PAYMENT_OUT");
    expect(adjustEntry?.createdBy).toBe(cashierActor.userId);
    expect(settleEntry?.createdBy).toBe(cashierActor.userId);

    // 8. التحقق من إغلاق وردية الكاشير بفارق صفر
    const closed = await closeShift(
      { shiftId: shift.shiftId, countedCash: "45000.00" },
      cashierActor,
    );
    expect(closed.expectedCash).toBe("45000.00");
    expect(closed.variance).toBe("0.00");
  });

  it("(١٢) استلام أمر الشراء (receivePurchase) بلا وردية مفتوحة للمنشئ: يسقط تلقائياً للخزينة وتُربط السجلات بالكامل", async () => {
    // 1. الكاشير ينشئ أمر الشراء بلا وردية مفتوحة
    const draft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "100.00",
          },
        ],
        shippingCost: "7000.00",
        customsCost: "0.00",
      },
      cashierActor,
    );

    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: draft.purchaseOrderId,
        expectedVersion: draft.version,
        reason: "طلب شراء للاستلام وسقوط الخزينة",
        requestKey: `shipping-receive-fb-submit:${randomUUID()}`,
      },
      cashierActor,
    );

    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `shipping-receive-fb-approve:${randomUUID()}`,
        approve: true,
        reason: "اعتماد أمر الشراء",
      },
      ownerActor,
      { legacyConfirmOnly: true },
    );

    const items = await itemsOf(draft.purchaseOrderId);

    // 2. المالك يستلم البضاعة
    await receivePurchase(
      {
        purchaseOrderId: draft.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      ownerActor,
    );

    // 3. التحقق من السقوط للخزينة
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.purchaseOrderId, draft.purchaseOrderId));
    expect(obligation.status).toBe("PAID");
    expect(obligation.recognizedBy).toBe(cashierActor.userId);

    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    const treasuryReceipt = outReceipts.find(
      (r) => r.cashBucket === "TREASURY" && r.amount === "7000.00",
    );
    expect(treasuryReceipt).toBeDefined();
    expect(treasuryReceipt?.createdBy).toBe(cashierActor.userId);
    expect(treasuryReceipt?.approvedBy).toBe(ownerActor.userId);

    const [exp] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(exp.createdBy).toBe(cashierActor.userId);
    expect(exp.cashBucket).toBeNull();
    expect(exp.shiftId).toBeNull();
    expect(exp.description).toContain(
      "صرف من الخزينة لعدم وجود وردية مفتوحة لمنشئ الفاتورة",
    );

    const poEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, draft.purchaseOrderId));
    const settleEntry = poEntries.find((e) => e.entryType === "PAYMENT_OUT");
    expect(settleEntry?.createdBy).toBe(cashierActor.userId);
    expect(settleEntry?.notes).toContain(
      "صرف من الخزينة لعدم وجود وردية مفتوحة لمنشئ الفاتورة",
    );
  });

  it("(١٣) كاشير أنشأ أمر شراء خارج الوردية، بينما المالك لديه وردية مفتوحة: محاولة الصرف من الدرج (settlePurchaseShippingFromShift) تفشل قطعياً ولا تستنزف درج المالك", async () => {
    // 1. الكاشير ينشئ أمر شراء ويُستلم بدون صرف شحن
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "6000.00",
      customsCost: "0.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // 2. المالك يفتح وردية مبيعات برصيد 100,000 د.ع (بينما الكاشير ليس لديه وردية)
    const ownerShift = await openShift(
      { branchId: 1, openingBalance: "100000.00", shiftType: "RETAIL" },
      ownerActor,
    );

    // 3. المالك يحاول صرف أجور الشحن من الدرج بدون تحديد وردية
    // النظام يجب أن يرفض لأن منشئ أمر الشراء (الكاشير) ليس لديه وردية، ولا يجوز استنزاف درج المالك
    await expect(
      settlePurchaseShippingFromShift(
        {
          purchaseOrderId: po.purchaseOrderId,
        },
        ownerActor,
      ),
    ).rejects.toThrow(/فتح وردية/);

    // 4. التحقق التام من عدم مساس درج المالك
    const ownerBalance = await withTx((tx) =>
      computeDrawerCashBalance(tx, ownerShift.shiftId, "100000.00"),
    );
    expect(ownerBalance.toFixed(2)).toBe("100000.00");

    const closed = await closeShift(
      { shiftId: ownerShift.shiftId, countedCash: "100000.00" },
      ownerActor,
    );
    expect(closed.expectedCash).toBe("100000.00");
    expect(closed.variance).toBe("0.00");
    expect(closed.reconciliationStatus).toBe("MATCHED");
  });

  it("(١٤) محاولة تمرير shiftId تخص موظفاً آخر لصرف أجور الشحن: تُرفض بحظر FORBIDDEN لمنع السحب من درج غير المنشئ", async () => {
    // 1. الكاشير ينشئ أمر شراء ويُستلم بدون صرف شحن
    const po = await createApprovedPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      taxRatePercent: "0",
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
      shippingCost: "4000.00",
      customsCost: "0.00",
    });

    const items = await itemsOf(po.purchaseOrderId);
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: items.map((i) => ({
          purchaseOrderItemId: Number(i.id),
          receivedBaseQuantity: i.baseQuantity,
        })),
      },
      adminActor,
    );

    // 2. المالك يفتح وردية مبيعات
    const ownerShift = await openShift(
      { branchId: 1, openingBalance: "50000.00", shiftType: "RETAIL" },
      ownerActor,
    );

    try {
      // 3. محاولة صرف أجور الشحن من وردية المالك صراحة لأمر شراء أنشأه الكاشير
      await expect(
        settlePurchaseShippingFromShift(
          {
            purchaseOrderId: po.purchaseOrderId,
            shiftId: ownerShift.shiftId,
          },
          ownerActor,
        ),
      ).rejects.toThrow(/لا يمكن صرف أجور الشحن من وردية موظف آخر/);
    } finally {
      await closeShift(
        { shiftId: ownerShift.shiftId, countedCash: "50000.00" },
        ownerActor,
      );
    }
  });

  it("(١٥) وردية المالك المفتوحة لا تجعل اعتماد أمر الكاشير يصرف الشحن تلقائياً", async () => {
    // 1. المالك لديه وردية مفتوحة
    const ownerShift = await openShift(
      { branchId: 1, openingBalance: "80000.00", shiftType: "RETAIL" },
      ownerActor,
    );

    try {
      // 2. الكاشير خارج الوردية ينشئ أمر الشراء
      const draft = await createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          taxRatePercent: "0",
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "10",
              unitPrice: "100.00",
            },
          ],
          shippingCost: "5000.00",
          customsCost: "0.00",
        },
        cashierActor,
      );

      const submitted = await submitPurchaseOrderForApproval(
        {
          purchaseOrderId: draft.purchaseOrderId,
          expectedVersion: draft.version,
          reason: "طلب شراء كاشير خارج الوردية",
          requestKey: `shipping-manager-shift-submit:${randomUUID()}`,
        },
        cashierActor,
      );

      // 3. المالك يعتمد الأمر بكامل الاستلام
      const approved = await decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: `shipping-manager-shift-approve:${randomUUID()}`,
          approve: true,
          reason: "اعتماد أمر الشراء مع وردية مفتوحة للمالك فقط",
          confirmedFullReceipt: true,
        },
        ownerActor,
      );
      expect(approved.status).toBe("APPROVED");

      // 4. طلب الشحن يبقى معلقاً بلا اختيار خزينة أو درج المالك
      const outReceipts = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT"));
      const shippingReceipt = outReceipts.find((r) => r.amount === "5000.00");
      expect(shippingReceipt).toMatchObject({
        createdBy: cashierActor.userId,
        approvedBy: null,
        cashBucket: null,
        shiftId: null,
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
      });

      // 5. التحقق من عدم المساس بدرج المالك المفتوح
      const ownerBalance = await withTx((tx) =>
        computeDrawerCashBalance(tx, ownerShift.shiftId, "80000.00"),
      );
      expect(ownerBalance.toFixed(2)).toBe("80000.00");
    } finally {
      const closed = await closeShift(
        { shiftId: ownerShift.shiftId, countedCash: "80000.00" },
        ownerActor,
      );
      expect(closed.expectedCash).toBe("80000.00");
      expect(closed.variance).toBe("0.00");
      expect(closed.reconciliationStatus).toBe("MATCHED");
    }
  });
});
