import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { purchaseRouter } from "../../routers/purchaseRouter";
import { decidePurchaseOrderControl } from "../purchase/controls";
import { loadPurchaseSettlements } from "../purchase/settlementProjection";
import {
  decidePurchaseReturn,
  requestPurchaseReturn,
} from "../purchase/returnGovernance";
import {
  decideSupplierPayment,
  decideSupplierPaymentRefund,
  requestSupplierPayment,
  requestSupplierPaymentRefund,
} from "../purchase/supplierPayments";
import { confirmPurchaseOrder, createPurchaseOrder } from "../purchaseService";
import { getSupplierStatement } from "../reports/apAging";

const creator = { userId: 1, branchId: 1, role: "admin" as const };
const approver = { userId: 2, branchId: 1, role: "manager" as const };
const treasurer = { userId: 3, branchId: 1, role: "manager" as const };
const db = () => getDb()!;
const key = () => randomUUID();
const caller = () =>
  purchaseRouter.createCaller({
    req: { headers: {} } as never,
    res: { cookie() {}, clearCookie() {} } as never,
    user: {
      id: 3,
      role: "manager",
      branchId: 1,
      name: "مالك الاختبار",
      isActive: true,
      isOwner: true,
    } as never,
  });

beforeEach(async () => {
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "settlement-creator",
        name: "منشئ",
        role: "admin",
        branchId: 1,
      },
      {
        id: 2,
        openId: "settlement-reviewer",
        name: "مراجع",
        role: "manager",
        branchId: 1,
      },
      {
        id: 3,
        openId: "settlement-owner",
        name: "مالك",
        role: "manager",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.suppliers).values({ id: 1, name: "مورد" });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "SETTLEMENT-PAPER",
    costPrice: "4.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db()
    .insert(s.branchStock)
    .values({ variantId: 1, branchId: 1, quantity: 10 });
});

async function purchase(
  currency: "IQD" | "USD" = "IQD",
  settlementType: "CREDIT" | "CASH" = "CREDIT",
) {
  const draft = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType,
      clientRequestId: key(),
      agreedCurrency: currency,
      ...(currency === "USD"
        ? { agreedRate: "1500.0000", usdTotal: "10.00" }
        : {}),
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: "10",
          unitPrice: currency === "USD" ? "1.0000" : "24000.00",
          ...(currency === "USD" ? { usdUnitPrice: "1.0000" } : {}),
        },
      ],
    },
    creator,
  );
  const submitted = await confirmPurchaseOrder(
    {
      purchaseOrderId: draft.purchaseOrderId,
      expectedVersion: draft.version,
      reason: "تحققت من الأسعار والكميات وأرسلت الأمر",
      clientRequestId: key(),
    },
    creator,
  );
  await decidePurchaseOrderControl(
    {
      requestId: submitted.requestId,
      decisionKey: key(),
      approve: true,
      reason: "وصلت البضاعة كاملة وتحُقّق من مستند المورد",
      confirmedFullReceipt: true,
    },
    settlementType === "CASH" ? treasurer : approver,
  );
  return draft.purchaseOrderId;
}

async function invoice() {
  return (
    await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.supplierId, 1))
  )[0]!;
}

async function surfaces(poId: number) {
  const [list, detail, statement] = await Promise.all([
    caller().list({}),
    caller().get({ purchaseOrderId: poId }),
    getSupplierStatement(1),
  ]);
  const listed = list.find((row) => Number(row.id) === poId)!;
  const statementPo = statement!.purchaseOrders.find(
    (row) => Number(row.id) === poId,
  )!;
  expect(listed.settlement).toEqual(detail!.settlement);
  expect(listed.settlement).toEqual(statementPo.settlement);
  expect(listed.paidAmount).toBe(detail!.paidAmount);
  expect(listed.paidAmount).toBe(statementPo.paidAmount);
  expect(statementPo.settlementType).toBe(listed.settlementType);
  return listed.settlement!;
}

async function requestPayment(
  amount: string,
  currencyAmount = amount,
  currency: "IQD" | "USD" = "IQD",
) {
  const inv = await invoice();
  return requestSupplierPayment(
    {
      supplierId: 1,
      branchId: 1,
      requestKey: key(),
      currency,
      exchangeRate: currency === "USD" ? "1500.0000" : null,
      amount,
      currencyAmount,
      paymentMethod: "TRANSFER",
      externalReference: `BANK-${key()}`,
      evidenceType: "BANK_ADVICE",
      evidenceReference: `DOCUMENT-${key()}`,
      reason: "تسديد فعلي موثق بمرجع التحويل",
      allocations: [
        {
          supplierInvoiceId: Number(inv.id),
          invoiceVersion: Number(inv.version),
          amount,
          currencyAmount,
        },
      ],
    },
    creator,
  );
}

async function pay(
  amount: string,
  currencyAmount = amount,
  currency: "IQD" | "USD" = "IQD",
) {
  const request = await requestPayment(amount, currencyAmount, currency);
  const decision = {
    requestId: request.requestId,
    decisionKey: key(),
    action: "APPROVE" as const,
    reviewReason: "تحققت من تحويل المبلغ للمورد",
  };
  const posted = await decideSupplierPayment(decision, treasurer);
  await expect(
    decideSupplierPayment(decision, treasurer),
  ).resolves.toMatchObject({ idempotent: true });
  return posted;
}

async function creditReturn(quantity: number) {
  const inv = await invoice();
  const match = (
    await db()
      .select()
      .from(s.supplierInvoiceMatchRuns)
      .where(eq(s.supplierInvoiceMatchRuns.supplierInvoiceId, Number(inv.id)))
  )[0]!;
  const allocation = (
    await db()
      .select()
      .from(s.supplierInvoiceMatchAllocations)
      .where(eq(s.supplierInvoiceMatchAllocations.matchRunId, Number(match.id)))
  )[0]!;
  const request = await requestPurchaseReturn(
    {
      supplierInvoiceId: Number(inv.id),
      matchRunId: Number(match.id),
      expectedInvoiceVersion: Number(inv.version),
      requestKey: key(),
      settlement: "CREDIT",
      paymentMethod: "CASH",
      evidenceType: "RETURN_NOTE",
      evidenceReference: `RETURN-${key()}`,
      reason: "إرجاع بضاعة وتخفيض ذمة المورد",
      lines: [
        { matchAllocationId: Number(allocation.id), baseQuantity: quantity },
      ],
    },
    creator,
  );
  return decidePurchaseReturn(
    {
      requestId: request.requestId,
      decisionKey: key(),
      action: "APPROVE",
      reviewReason: "تحققت من المرتجع وقبوله من المورد",
    },
    treasurer,
  );
}

describe("purchase settlement evidence across list, detail and supplier statement", () => {
  it("settles newly received CASH IQD purchase atomically across all surfaces", async () => {
    await db().insert(s.receipts).values({
      branchId: 1,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: "500000.00",
      paymentMethod: "CASH",
      partyType: "OTHER",
      voucherNumber: "RV-TREASURY-SEED-1",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      description: "تغذية خزينة للاختبار",
      createdBy: treasurer.userId,
      approvedBy: treasurer.userId,
      approvedAt: new Date(),
    });
    const poId = await purchase("IQD", "CASH");
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "240000.00",
      returnedAmountIqd: "0.00",
      remainingAmountIqd: "0.00",
      status: "PAID",
      requiresReview: false,
    });
    expect(await db().select().from(s.supplierPayments)).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT")),
    ).toHaveLength(1);
  });

  it("keeps historical received CASH PO262-like purchase unpaid until a documented payment", async () => {
    const poId = await purchase("IQD", "CREDIT");
    await db()
      .update(s.purchaseOrders)
      .set({ settlementType: "CASH", paidAmount: "0.00" })
      .where(eq(s.purchaseOrders.id, poId));
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "0.00",
      returnedAmountIqd: "0.00",
      remainingAmountIqd: "240000.00",
      status: "UNPAID",
      requiresReview: false,
    });
    expect(await db().select().from(s.supplierPayments)).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "OUT")),
    ).toHaveLength(0);
  });

  it("keeps pending requests unpaid and displays approved noncash payment once", async () => {
    const poId = await purchase();
    const request = await requestPayment("240000.00");
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "0.00",
      remainingAmountIqd: "240000.00",
      status: "UNPAID",
    });
    const decision = {
      requestId: request.requestId,
      decisionKey: key(),
      action: "APPROVE" as const,
      reviewReason: "تحققت من التحويل وإشعار البنك",
    };
    await decideSupplierPayment(decision, treasurer);
    await decideSupplierPayment(decision, treasurer);
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "240000.00",
      remainingAmountIqd: "0.00",
      status: "PAID",
    });
  });

  it("separates credit-only return from paid money", async () => {
    const poId = await purchase();
    await creditReturn(6);
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "0.00",
      returnedAmountIqd: "144000.00",
      remainingAmountIqd: "96000.00",
      status: "UNPAID",
      requiresReview: false,
    });
  });

  it("closes a partial payment plus credit return without calling the credit cash paid", async () => {
    const poId = await purchase();
    await pay("96000.00");
    await creditReturn(6);
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "96000.00",
      returnedAmountIqd: "144000.00",
      remainingAmountIqd: "0.00",
      status: "CREDITED",
      requiresReview: false,
    });
  });

  it("reopens paid balance after governed payment refund", async () => {
    const poId = await purchase();
    const posted = await pay("240000.00");
    const payment = (
      await db()
        .select()
        .from(s.supplierPayments)
        .where(eq(s.supplierPayments.id, Number(posted.supplierPaymentId)))
    )[0]!;
    const allocation = (
      await db()
        .select()
        .from(s.supplierPaymentAllocations)
        .where(
          eq(
            s.supplierPaymentAllocations.supplierPaymentId,
            Number(payment.id),
          ),
        )
    )[0]!;
    const request = await requestSupplierPaymentRefund(
      {
        supplierPaymentId: Number(payment.id),
        expectedPaymentVersion: Number(payment.version),
        requestKey: key(),
        refundMethod: "TRANSFER",
        externalReference: `REFUND-${key()}`,
        evidenceType: "BANK_ADVICE",
        evidenceReference: `DOCUMENT-${key()}`,
        reason: "استرداد جزء من تحويل المورد موثقاً",
        allocations: [
          {
            supplierPaymentAllocationId: Number(allocation.id),
            amount: "48000.00",
            currencyAmount: "48000.00",
          },
        ],
      },
      creator,
    );
    await decideSupplierPaymentRefund(
      {
        requestId: request.requestId,
        decisionKey: key(),
        action: "APPROVE",
        reviewReason: "تحققت من الاسترداد في البنك",
      },
      treasurer,
    );
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "192000.00",
      returnedAmountIqd: "0.00",
      remainingAmountIqd: "48000.00",
      status: "PARTIAL",
    });
    // Older posted refunds had no PO on their own GL entry; the original payment still proves the link.
    const refund = (await db().select().from(s.supplierPaymentRefunds))[0]!;
    await db()
      .update(s.accountingEntries)
      .set({ purchaseOrderId: null })
      .where(eq(s.accountingEntries.id, Number(refund.accountingEntryId)));
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "192000.00",
      remainingAmountIqd: "48000.00",
      requiresReview: false,
    });
  });

  it("uses USD payment allocations and agreed-rate credit amounts consistently", async () => {
    const poId = await purchase("USD");
    await pay("6000.00", "4.00", "USD");
    await creditReturn(6);
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "6000.00",
      returnedAmountIqd: "9000.00",
      remainingAmountIqd: "0.00",
      paidAmountCurrency: "4.00",
      returnedAmountCurrency: "6.00",
      remainingAmountCurrency: "0.00",
      status: "CREDITED",
    });
  });

  it("ignores unsupported native paid cache, flags review and writes nothing", async () => {
    const poId = await purchase();
    await db()
      .update(s.purchaseOrders)
      .set({ paidAmount: "240000.00" })
      .where(eq(s.purchaseOrders.id, poId));
    const before = (
      await db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, poId))
    )[0]!;
    expect(await surfaces(poId)).toMatchObject({
      paidAmountIqd: "0.00",
      remainingAmountIqd: "240000.00",
      requiresReview: true,
    });
    const after = (
      await db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, poId))
    )[0]!;
    expect(after).toEqual(before);
    const current = await db().transaction(async (tx) =>
      loadPurchaseSettlements(tx, [before], { currentRead: true }),
    );
    expect(current.get(poId)?.requiresReview).toBe(true);
  });

  it("does not warn about missing receipt recognition before a confirmed order is received", async () => {
    await db().insert(s.purchaseOrders).values({
      id: 995,
      poNumber: "UNRECEIVED-CONFIRMED",
      supplierId: 1,
      branchId: 1,
      subtotal: "1000.00",
      total: "1000.00",
      paidAmount: "0.00",
      status: "CONFIRMED",
      settlementType: "CREDIT",
    });
    const order = (
      await db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, 995))
    )[0]!;
    expect(
      (await loadPurchaseSettlements(db(), [order])).get(995)?.requiresReview,
    ).toBe(false);
  });

  it("limits legacy partial-receipt liability to the recognized purchase", async () => {
    await db().insert(s.purchaseOrders).values({
      id: 996,
      poNumber: "LEGACY-PARTIAL",
      supplierId: 1,
      branchId: 1,
      subtotal: "1000.00",
      total: "1000.00",
      paidAmount: "0.00",
      status: "CONFIRMED",
      settlementType: "CREDIT",
    });
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "PURCHASE",
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: 996,
        amount: "500.00",
        entryDate: new Date().toISOString().slice(0, 10),
      });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "500.00" })
      .where(eq(s.suppliers.id, 1));
    const detail = await caller().get({ purchaseOrderId: 996 });
    const statement = await getSupplierStatement(1);
    expect(detail!.settlement).toMatchObject({
      paidAmountIqd: "0.00",
      remainingAmountIqd: "500.00",
    });
    expect(statement!.purchaseOrders[0].total).toBe("500.00");
    expect(statement!.purchaseOrders[0].settlement?.remainingAmountIqd).toBe(
      "500.00",
    );
    expect(statement!.summary.aging.d0_30).toBe("500.00");
  });

  it.each(["DRAFT", "ON_HOLD", "MATCHED"] as const)(
    "preserves legacy liability when native history is unposted %s",
    async (status) => {
      const poId = await purchase();
      const inv = await invoice();
      await db()
        .update(s.accountingEntries)
        .set({ amount: "0.00" })
        .where(eq(s.accountingEntries.id, Number(inv.postingEntryId)));
      await db()
        .update(s.supplierInvoices)
        .set({
          status,
          draftState: status === "DRAFT" ? "VOIDED" : "ACTIVE",
          postingEntryId: null,
          postedBy: null,
          postedAt: null,
          voidedBy: status === "DRAFT" ? creator.userId : null,
          voidedAt: status === "DRAFT" ? new Date() : null,
          voidReason: status === "DRAFT" ? "مسودة ملغاة" : null,
        })
        .where(eq(s.supplierInvoices.id, Number(inv.id)));
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "PURCHASE",
          branchId: 1,
          supplierId: 1,
          purchaseOrderId: poId,
          amount: "500.00",
          entryDate: new Date().toISOString().slice(0, 10),
        });
      const order = (
        await db()
          .select()
          .from(s.purchaseOrders)
          .where(eq(s.purchaseOrders.id, poId))
      )[0]!;
      expect(
        (await loadPurchaseSettlements(db(), [order])).get(poId),
      ).toMatchObject({
        remainingAmountIqd: "500.00",
        paidAmountIqd: "0.00",
        requiresReview: false,
      });
    },
  );

  it("uses current ledger and refund evidence after a refund commits beyond an RR snapshot", async () => {
    const poId = await purchase();
    const posted = await pay("240000.00");
    const payment = (
      await db()
        .select()
        .from(s.supplierPayments)
        .where(eq(s.supplierPayments.id, Number(posted.supplierPaymentId)))
    )[0]!;
    const allocation = (
      await db().select().from(s.supplierPaymentAllocations)
    )[0]!;
    await db().transaction(async (tx) => {
      await tx
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, poId));
      const request = await requestSupplierPaymentRefund(
        {
          supplierPaymentId: Number(payment.id),
          expectedPaymentVersion: Number(payment.version),
          requestKey: key(),
          refundMethod: "TRANSFER",
          externalReference: `REFUND-${key()}`,
          evidenceType: "BANK_ADVICE",
          evidenceReference: `DOCUMENT-${key()}`,
          reason: "استرداد فعلي بعد فتح لقطة قراءة قديمة",
          allocations: [
            {
              supplierPaymentAllocationId: Number(allocation.id),
              amount: "48000.00",
              currencyAmount: "48000.00",
            },
          ],
        },
        creator,
      );
      await decideSupplierPaymentRefund(
        {
          requestId: request.requestId,
          decisionKey: key(),
          action: "APPROVE",
          reviewReason: "تحققت من الاسترداد",
        },
        treasurer,
      );
      const refund = (await db().select().from(s.supplierPaymentRefunds))[0]!;
      await db()
        .update(s.accountingEntries)
        .set({ purchaseOrderId: null })
        .where(eq(s.accountingEntries.id, Number(refund.accountingEntryId)));
      const current = (
        await tx
          .select()
          .from(s.purchaseOrders)
          .where(eq(s.purchaseOrders.id, poId))
          .for("share")
      )[0]!;
      const result = await loadPurchaseSettlements(tx, [current], {
        currentRead: true,
      });
      expect(result.get(poId)).toMatchObject({
        paidAmountIqd: "192000.00",
        remainingAmountIqd: "48000.00",
        requiresReview: false,
      });
    });
  });

  it("flags a shared invoice even when only one of its POs is requested", async () => {
    const first = await purchase();
    await pay("96000.00");
    const second = await purchase();
    const firstInvoice = await invoice();
    const secondOrder = (
      await db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, second))
    )[0]!;
    const secondItem = (
      await db()
        .select()
        .from(s.purchaseOrderRevisionItems)
        .where(
          eq(
            s.purchaseOrderRevisionItems.revisionId,
            Number(secondOrder.currentRevisionId),
          ),
        )
    )[0]!;
    const firstLine = (
      await db()
        .select()
        .from(s.supplierInvoiceLines)
        .where(
          eq(s.supplierInvoiceLines.supplierInvoiceId, Number(firstInvoice.id)),
        )
    )[0]!;
    const { id: _lineId, ...line } = firstLine;
    // Simulate a historical shared document; a whole invoice allocation cannot prove either PO's share.
    await db()
      .insert(s.supplierInvoiceLines)
      .values({
        ...line,
        lineNo: 2,
        purchaseOrderRevisionItemId: Number(secondItem.id),
      });
    expect(await surfaces(first)).toMatchObject({
      paidAmountIqd: "0.00",
      returnedAmountIqd: "0.00",
      remainingAmountIqd: "240000.00",
      requiresReview: true,
    });
    const returnEntryId = extractInsertId(
      await db()
        .insert(s.accountingEntries)
        .values({
          entryType: "RETURN",
          entryDate: new Date().toISOString().slice(0, 10),
          branchId: 1,
          supplierId: 1,
          purchaseOrderId: first,
          amount: "-10000.00",
        }),
    );
    await db()
      .insert(s.purchaseReturns)
      .values({
        returnNumber: `RET-SHARED-${returnEntryId}`,
        clientRequestId: `ret-shared-${returnEntryId}`,
        origin: "LEGACY",
        supplierInvoiceId: null,
        purchaseOrderId: first,
        supplierId: 1,
        branchId: 1,
        accountingEntryId: returnEntryId,
        settlement: "CREDIT",
        netAmount: "10000.00",
        totalAmount: "10000.00",
        creditOffsetAmount: "10000.00",
        createdBy: creator.userId,
        createdByNameSnapshot: "creator",
      });
    expect(await surfaces(first)).toMatchObject({
      paidAmountIqd: "0.00",
      returnedAmountIqd: "0.00",
      remainingAmountIqd: "240000.00",
      requiresReview: true,
    });
  });
});
