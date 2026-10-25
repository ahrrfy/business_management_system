import { randomUUID } from "node:crypto";
import { getPurchaseSettlement } from "@shared/purchaseSettlement";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { purchaseOrderControlSource } from "../decisions/sources/purchasing";
import { decidePurchaseOrderControl } from "../purchase/controls";
import {
  decidePurchaseReturn,
  requestPurchaseReturn,
} from "../purchase/returnGovernance";
import {
  decideSupplierPayment,
  decideSupplierPaymentRefund,
  requestSupplierPayment,
  requestSupplierPaymentRefund,
  SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
} from "../purchase/supplierPayments";
import { reconcileSupplierPurchaseSettlement } from "../purchase/historicalSupplierSettlement";
import { getPurchaseIntegrityReport } from "../purchaseIntegrityService";
import {
  confirmPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
} from "../purchaseService";
import { autoSettleSupplierAccountTx } from "../reconciliation/autoSettlementService";
import { computeExpectedCash, openShift } from "../shiftService";
import { withTx } from "../tx";
import { approveVoucher as approveVoucherDirect } from "../voucher/approval";
import {
  approveVoucher,
  cancelVoucher,
  createVoucher,
  getVoucher,
} from "../voucherService";
import { truncateTables } from "./__testUtils__";

const maker = { userId: 1, branchId: 1, role: "purchasing" as const };
const reviewer = { userId: 2, branchId: 1, role: "manager" as const };
const owner = { userId: 3, branchId: 1, role: "admin" as const, isOwner: true };

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
  "supplierPaymentRefundItems",
  "supplierPaymentRefunds",
  "supplierPaymentRefundRequestItems",
  "supplierPaymentRefundRequests",
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
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seedBase(treasuryFund = "500000.00") {
  await db().insert(s.branches).values({
    id: 1,
    name: "الفرع الرئيسي",
    code: "MAIN",
    type: "MAIN",
  });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "cash-fix-maker",
        name: "موظف المشتريات",
        role: "purchasing",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "cash-fix-reviewer",
        name: "مدير المراجعة",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "cash-fix-owner",
        name: "المالك",
        role: "admin",
        loginMethod: "local",
        branchId: 1,
        isOwner: true,
      },
    ]);
  await db().insert(s.suppliers).values({
    id: 1,
    name: "مورد التوريد العام",
    currentBalance: "0.00",
  });
  await db().insert(s.products).values({ id: 1, name: "منتج قياسي" });
  await db().insert(s.productVariants).values({
    id: 1,
    productId: 1,
    sku: "SKU-CASH-FIX-1",
    costPrice: "1000.00",
  });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await db().insert(s.branchStock).values({
    variantId: 1,
    branchId: 1,
    quantity: 5,
  });
  if (Number(treasuryFund) > 0) {
    await db().insert(s.receipts).values({
      branchId: 1,
      shiftId: null,
      cashBucket: "TREASURY",
      direction: "IN",
      amount: treasuryFund,
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "SEED-TREASURY-FUND",
      createdBy: 3,
    });
  }
}

async function createAndSubmitPo(args: {
  settlementType: "CASH" | "CREDIT";
  quantity?: string;
  unitPrice?: string;
  cashSource?: { mode: "DRAWER"; shiftId?: number } | { mode: "TREASURY" };
  actor?: typeof maker | typeof owner;
}) {
  const actor = args.actor ?? maker;
  const draft = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: args.settlementType,
      cashSource: args.cashSource,
      clientRequestId: `po-draft-${randomUUID()}`,
      items: [
        {
          variantId: 1,
          productUnitId: 1,
          quantity: args.quantity ?? "10",
          unitPrice: args.unitPrice ?? "5000.00",
        },
      ],
    },
    actor,
  );
  const confirmed = await confirmPurchaseOrder(
    {
      purchaseOrderId: draft.purchaseOrderId,
      expectedVersion: draft.version,
      reason: "إرسال فاتورة الشراء للاعتماد والترحيل",
      clientRequestId: `po-confirm-${randomUUID()}`,
    },
    actor,
  );
  return {
    purchaseOrderId: draft.purchaseOrderId,
    poNumber: draft.poNumber,
    requestId: confirmed.requestId,
  };
}

beforeEach(async () => {
  vi.stubEnv("ROLLOUT_OWNER_ONLY_APPROVAL", "off");
  await truncateTables(TABLES);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await truncateTables(TABLES);
});

describe("الفواتير النقدية وفواتير الآجل وسندات صرف الموردين — دورة محاسبية وتشغيلية متكاملة", () => {
  it("يسدد فاتورة الشراء النقدية ذرياً من الخزينة أو الدرج وتبقى ذمة المورد صفراً دون أي فجوة نزاهة", async () => {
    await seedBase("200000.00");

    // 1) CASH PO settled via TREASURY
    const cashTreasury = await createAndSubmitPo({
      settlementType: "CASH",
      quantity: "10",
      unitPrice: "5000.00", // 50,000 IQD
    });
    await decidePurchaseOrderControl(
      {
        requestId: cashTreasury.requestId,
        decisionKey: `approve-treasury-${randomUUID()}`,
        approve: true,
        reason: "اعتماد واستلام وسداد نقدي من الخزينة",
        confirmedFullReceipt: true,
        cashSource: { mode: "TREASURY" },
      },
      owner,
    );

    const [[po1], [inv1], [supAfter1]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, cashTreasury.purchaseOrderId)),
      db()
        .select()
        .from(s.supplierInvoices)
        .where(eq(s.supplierInvoices.supplierId, 1)),
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)),
    ]);

    expect(po1).toMatchObject({
      status: "RECEIVED",
      settlementType: "CASH",
      total: "50000.00",
      paidAmount: "50000.00",
    });
    expect(getPurchaseSettlement(po1)).toMatchObject({
      status: "PAID",
      remainingAmount: "0.00",
    });
    expect(inv1).toMatchObject({
      status: "POSTED",
      paymentGate: "SETTLED",
      totalAmount: "50000.00",
    });
    expect(supAfter1.currentBalance).toBe("0.00");

    // 2) CASH PO settled via maker-declared DRAWER when approved by independent reviewer
    const shift = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      maker,
    );
    const cashDrawer = await createAndSubmitPo({
      settlementType: "CASH",
      quantity: "6",
      unitPrice: "5000.00", // 30,000 IQD
      cashSource: { mode: "DRAWER", shiftId: shift.shiftId },
    });
    await decidePurchaseOrderControl(
      {
        requestId: cashDrawer.requestId,
        decisionKey: `approve-drawer-${randomUUID()}`,
        approve: true,
        reason: "اعتماد مستقل مع صرف من درج المنشئ المصرح به",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const [[po2], [supAfter2]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, cashDrawer.purchaseOrderId)),
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)),
    ]);
    expect(po2).toMatchObject({
      status: "RECEIVED",
      paidAmount: "30000.00",
    });
    expect(supAfter2.currentBalance).toBe("0.00");
    expect(
      await db().transaction(async (tx) =>
        (await computeExpectedCash(tx, shift.shiftId, "80000.00")).toFixed(2),
      ),
    ).toBe("50000.00");

    const integrity = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 50,
    });
    expect(integrity.findings).toHaveLength(0);
  });

  it("يفشل مغلقاً (ROLLBACK) عند عدم كفاية الرصيد النقدي فلا تنشأ فاتورة نقدية مستلمة غير مسددة أبداً", async () => {
    await seedBase("10000.00"); // فقط 10,000 في الخزينة بينما الفاتورة 50,000

    const cashPo = await createAndSubmitPo({
      settlementType: "CASH",
      quantity: "10",
      unitPrice: "5000.00", // 50,000 IQD
    });

    await expect(
      decidePurchaseOrderControl(
        {
          requestId: cashPo.requestId,
          decisionKey: `approve-insufficient-${randomUUID()}`,
          approve: true,
          reason: "محاولة اعتماد فاتورة نقدية برصيد غير كاف",
          confirmedFullReceipt: true,
          cashSource: { mode: "TREASURY" },
        },
        owner,
      ),
    ).rejects.toThrow();

    const [[po], invoices, movements, [supplier]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, cashPo.purchaseOrderId)),
      db().select().from(s.supplierInvoices),
      db().select().from(s.inventoryMovements),
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)),
    ]);

    expect(po.status).toBe("SENT");
    expect(po.paidAmount).toBe("0.00");
    expect(invoices).toHaveLength(0);
    expect(movements).toHaveLength(0);
    expect(supplier.currentBalance).toBe("0.00");
  });

  it("يرفع الذمم في الفواتير الآجلة، ويخفضها ويسوي الفواتير ذرياً عند اعتماد سند الصرف، ويعكس التسوية عند إلغاء السند", async () => {
    await seedBase("500000.00");

    // فاتورة آجلة أولى: 40,000 د.ع
    const creditPo1 = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "8",
      unitPrice: "5000.00", // 40,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: creditPo1.requestId,
        decisionKey: `approve-credit-1-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة آجلة أولى",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    // فاتورة آجلة ثانية: 60,000 د.ع
    const creditPo2 = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "12",
      unitPrice: "5000.00", // 60,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: creditPo2.requestId,
        decisionKey: `approve-credit-2-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة آجلة ثانية",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    // الذمم الآن = 100,000 د.ع، وكلا الفاتورتين OPEN بمدفوع 0.00
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "100000.00",
    );
    const invoicesBefore = await db().select().from(s.supplierInvoices);
    expect(invoicesBefore.map((i) => i.paymentGate)).toEqual(["OPEN", "OPEN"]);
    const inv2 = invoicesBefore.find((i) => Number(i.totalAmount) === 60000)!;

    // ١) سند صرف موجّه للفاتورة الثانية تحديداً بقيمة 25,000 د.ع (سداد جزئي)
    const partialVoucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "25000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        supplierAllocations: [
          {
            supplierInvoiceId: Number(inv2.id),
            invoiceVersion: Number(inv2.version),
            amount: "25000.00",
          },
        ],
        description: "دفعة جزئية على الفاتورة الثانية",
        clientRequestId: `vch-partial-${randomUUID()}`,
      },
      maker,
    );
    await approveVoucher(partialVoucher.receiptId, owner);

    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "75000.00",
    );
    const [[po1AfterPartial], [po2AfterPartial]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, creditPo1.purchaseOrderId)),
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, creditPo2.purchaseOrderId)),
    ]);
    expect(po1AfterPartial.paidAmount).toBe("0.00");
    expect(po2AfterPartial.paidAmount).toBe("25000.00");
    expect(getPurchaseSettlement(po2AfterPartial)).toMatchObject({
      status: "PARTIAL",
      remainingAmount: "35000.00",
    });

    // ٢) سند صرف عام بقيمة 75,000 د.ع يوزّع تلقائياً بالأقدمية (FIFO): 40,000 للأولى + 35,000 للثانية
    const fifoVoucher = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "75000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        description: "تصفية كامل ذمة المورد المتبقية",
        clientRequestId: `vch-fifo-${randomUUID()}`,
      },
      maker,
    );
    await approveVoucher(fifoVoucher.receiptId, owner);

    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "0.00",
    );
    const invoicesAfterFull = await db().select().from(s.supplierInvoices);
    expect(invoicesAfterFull.map((i) => i.paymentGate)).toEqual([
      "SETTLED",
      "SETTLED",
    ]);
    const [[po1Paid], [po2Paid]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, creditPo1.purchaseOrderId)),
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, creditPo2.purchaseOrderId)),
    ]);
    expect(po1Paid.paidAmount).toBe("40000.00");
    expect(po2Paid.paidAmount).toBe("60000.00");

    // فحص النزاهة عبر أوامر متعددة بسند واحد: صفر انحرافات
    const integrityAfterPay = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 50,
    });
    expect(integrityAfterPay.findings).toHaveLength(0);

    // ٣) منع الإلغاء العام للسند المعتمد وتوجيهه حصراً لمسار الاسترداد المحوكم الذي يعكس التخصيصين ويعيد فتح الفاتورتين ويرفع الذمة مجدداً بلا انحراف
    await expect(cancelVoucher(fifoVoucher.receiptId, owner)).rejects.toThrow(
      /استرداد/,
    );
    const [fifoPayment] = await db()
      .select()
      .from(s.supplierPayments)
      .where(eq(s.supplierPayments.receiptId, fifoVoucher.receiptId));
    const fifoAllocs = await db()
      .select()
      .from(s.supplierPaymentAllocations)
      .where(
        eq(
          s.supplierPaymentAllocations.supplierPaymentId,
          Number(fifoPayment.id),
        ),
      );
    const refundReq = await requestSupplierPaymentRefund(
      {
        supplierPaymentId: Number(fifoPayment.id),
        expectedPaymentVersion: Number(fifoPayment.version),
        requestKey: `refund-fifo-${randomUUID()}`,
        refundMethod: "TRANSFER",
        externalReference: `EXT-${randomUUID()}`,
        evidenceType: "BANK_ADVICE",
        evidenceReference: `DOC-${randomUUID()}`,
        reason: "استرداد سند الـ 75,000 د.ع وعكس تخصيصيه",
        allocations: fifoAllocs.map((a) => ({
          supplierPaymentAllocationId: Number(a.id),
          amount: a.allocatedAmount,
          currencyAmount: a.allocatedCurrencyAmount,
        })),
      },
      maker,
    );
    await decideSupplierPaymentRefund(
      {
        requestId: refundReq.requestId,
        decisionKey: `refund-fifo-dec-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "اعتماد الاسترداد المحوكم",
      },
      owner,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );

    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "75000.00",
    );
    const invoicesAfterCancel = await db().select().from(s.supplierInvoices);
    expect(invoicesAfterCancel.map((i) => i.paymentGate)).toEqual([
      "OPEN",
      "OPEN",
    ]);
    const [[po1Reopened], [po2Reopened]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, creditPo1.purchaseOrderId)),
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, creditPo2.purchaseOrderId)),
    ]);
    expect(po1Reopened.paidAmount).toBe("0.00");
    expect(po2Reopened.paidAmount).toBe("25000.00");

    const integrityAfterCancel = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 50,
    });
    expect(integrityAfterCancel.findings).toHaveLength(0);
  });

  it("يكتشف الفاتورة النقدية التاريخية العالقة بلا سداد ويعالجها بسداد المورد المحوكم ليصفر الذمة والانحراف، ولا يسيء تخصيص سند رصيد افتتاحي على فاتورة آجلة جديدة", async () => {
    await seedBase("300000.00");

    // محاكاة فاتورة نقدية تاريخية اعتُمدت قبل الإصلاح وبقيت OPEN بمدفوع 0.00 وذمة مورد متراكمة (مطابقة لحالة الإنتاج الفعلية)
    const creditTemp = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "10",
      unitPrice: "5000.00", // 50,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: creditTemp.requestId,
        decisionKey: `approve-hist-${randomUUID()}`,
        approve: true,
        reason: "ترحيل فاتورة قبل محاكاة العطب التاريخي",
        confirmedFullReceipt: true,
      },
      reviewer,
    );
    await db()
      .update(s.purchaseOrders)
      .set({ settlementType: "CASH" })
      .where(eq(s.purchaseOrders.id, creditTemp.purchaseOrderId));

    // ١) تقرير النزاهة يلتقط الثغرة كـ CRITICAL (CASH_RECEIVED_PAYMENT_COVERAGE_GAP)
    const reportBefore = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 50,
    });
    expect(
      reportBefore.findings.find(
        (f) =>
          f.purchaseOrderId === creditTemp.purchaseOrderId &&
          f.code === "CASH_RECEIVED_PAYMENT_COVERAGE_GAP",
      ),
    ).toMatchObject({
      severity: "CRITICAL",
      evidence: {
        recognizedPurchaseGl: "50000.00",
        netCoveredAmount: "0.00",
        difference: "-50000.00",
      },
    });

    // ٢) تسوية الفاتورة النقدية التاريخية العالقة عبر مسار سداد المورد المحوكم تصفر الذمة وتغلق بوابة الفاتورة وتزيل انحراف النزاهة
    const remShift = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      maker,
    );
    const [unpaidCashInv] = await db().select().from(s.supplierInvoices);
    const payReq = await requestSupplierPayment(
      {
        supplierId: 1,
        branchId: 1,
        requestKey: `remediate-cash-po-${randomUUID()}`,
        currency: "IQD",
        exchangeRate: null,
        amount: "50000.00",
        currencyAmount: "50000.00",
        paymentMethod: "CASH",
        cashSource: { mode: "DRAWER", shiftId: remShift.shiftId },
        evidenceType: "CASH_ACKNOWLEDGEMENT",
        evidenceReference: `REM-CASH-${randomUUID()}`,
        reason: "سداد الفاتورة النقدية التاريخية المستلمة",
        allocations: [
          {
            supplierInvoiceId: Number(unpaidCashInv.id),
            invoiceVersion: Number(unpaidCashInv.version),
            amount: "50000.00",
            currencyAmount: "50000.00",
          },
        ],
      },
      maker,
    );
    await decideSupplierPayment(
      {
        requestId: payReq.requestId,
        decisionKey: `remediate-cash-dec-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "اعتماد سداد الفاتورة النقدية التاريخية",
      },
      owner,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );

    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "0.00",
    );
    const [[remediatedPo], [remediatedInv]] = await Promise.all([
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, creditTemp.purchaseOrderId)),
      db().select().from(s.supplierInvoices),
    ]);
    expect(remediatedPo.paidAmount).toBe("50000.00");
    expect(remediatedInv.paymentGate).toBe("SETTLED");

    const reportAfter = await getPurchaseIntegrityReport({
      branchId: 1,
      limit: 50,
    });
    expect(reportAfter.findings).toHaveLength(0);

    // ٣) اختبار الحماية العكسية: سند قديم سدد رصيداً افتتاحياً لا يُساء تخصيصه على فاتورة آجلة جديدة غير مدفوعة!
    await db().insert(s.suppliers).values({
      id: 2,
      name: "مورد ذو رصيد افتتاحي سابق",
      currentBalance: "0.00", // سُدد رصيده الافتتاحي البالغ 40,000 بسند قديم PV-OPENING-600
    });
    await db().insert(s.receipts).values({
      id: 600,
      branchId: 1,
      cashBucket: "TREASURY",
      direction: "OUT",
      amount: "40000.00",
      paymentMethod: "CASH",
      partyType: "SUPPLIER",
      partyId: 2,
      voucherNumber: "PV-OPENING-600",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      description: "سداد رصيد افتتاحي قديم",
      createdBy: 3,
      approvedBy: 3,
      approvedAt: new Date(),
    });
    // ثم صدرت فاتورة آجلة جديدة بمبلغ 40,000 د.ع فارتفع رصيد المورد #2 إلى 40,000 د.ع
    const draft2 = await createPurchaseOrder(
      {
        supplierId: 2,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CREDIT",
        clientRequestId: `po2-draft-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "8",
            unitPrice: "5000.00",
          },
        ],
      },
      maker,
    );
    const conf2 = await confirmPurchaseOrder(
      {
        purchaseOrderId: draft2.purchaseOrderId,
        expectedVersion: draft2.version,
        reason: "إرسال فاتورة المورد الثاني الآجلة",
        clientRequestId: `po2-confirm-${randomUUID()}`,
      },
      maker,
    );
    await decidePurchaseOrderControl(
      {
        requestId: conf2.requestId,
        decisionKey: `approve-sup2-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة آجلة جديدة للمورد الثاني",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    expect(
      (
        await db()
          .select()
          .from(s.suppliers)
          .where(eq(s.suppliers.id, 2))
      )[0]?.currentBalance,
    ).toBe("40000.00");

    const sup2Settle = await withTx((tx) =>
      autoSettleSupplierAccountTx(tx, 2, owner),
    );
    expect(sup2Settle.totalSettledAmount).toBe("0.00");
    const [poSup2] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, draft2.purchaseOrderId));
    expect(poSup2.paidAmount).toBe("0.00");
  });

  it("يوجه استرداد سند الصرف المعتمد للمسار المحوكم حصراً ويمنع الإلغاء المباشر أو الاسترداد المزدوج", async () => {
    await seedBase("300000.00");

    const creditPo = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "10",
      unitPrice: "5000.00", // 50,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: creditPo.requestId,
        decisionKey: `approve-dbl-guard-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة آجلة لاختبار منع الاسترداد المزدوج",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const pv = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "50000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        description: "سند صرف لسداد الفاتورة الآجلة",
        clientRequestId: `vch-dbl-guard-${randomUUID()}`,
      },
      maker,
    );
    await approveVoucher(pv.receiptId, owner);

    const [payment] = await db()
      .select()
      .from(s.supplierPayments)
      .where(eq(s.supplierPayments.receiptId, pv.receiptId));
    const [allocation] = await db()
      .select()
      .from(s.supplierPaymentAllocations)
      .where(
        eq(
          s.supplierPaymentAllocations.supplierPaymentId,
          Number(payment.id),
        ),
      );
    expect(payment.paymentNumber).toMatch(/^SP-/);

    // الاتجاه الأول: منع إلغاء السند المعتمد عبر المسار العام وتوجيهه لمسار الاسترداد المحوكم
    await expect(cancelVoucher(pv.receiptId, maker)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // الاتجاه الثاني: الاسترداد المحوكم ينجح مرة واحدة ويعيد فتح الفاتورة ويرفع الذمة، ثم يرفض الاسترداد المزدوج بـ CONFLICT
    const refundOnce = await requestSupplierPaymentRefund(
      {
        supplierPaymentId: Number(payment.id),
        expectedPaymentVersion: Number(payment.version),
        requestKey: `refund-req-ok-${randomUUID()}`,
        refundMethod: "TRANSFER",
        externalReference: `EXT-${randomUUID()}`,
        evidenceType: "BANK_ADVICE",
        evidenceReference: `DOC-${randomUUID()}`,
        reason: "استرداد محوكم لدفعة سند الصرف",
        allocations: [
          {
            supplierPaymentAllocationId: Number(allocation.id),
            amount: "50000.00",
            currencyAmount: "50000.00",
          },
        ],
      },
      maker,
    );
    await decideSupplierPaymentRefund(
      {
        requestId: refundOnce.requestId,
        decisionKey: `refund-dec-ok-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "اعتماد الاسترداد المحوكم",
      },
      owner,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );

    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "50000.00",
    );
    expect((await db().select().from(s.supplierInvoices))[0]?.paymentGate).toBe(
      "OPEN",
    );

    const [paymentAfter] = await db()
      .select()
      .from(s.supplierPayments)
      .where(eq(s.supplierPayments.id, Number(payment.id)));
    await expect(
      requestSupplierPaymentRefund(
        {
          supplierPaymentId: Number(payment.id),
          expectedPaymentVersion: Number(paymentAfter.version),
          requestKey: `refund-req-dup-${randomUUID()}`,
          refundMethod: "TRANSFER",
          externalReference: `EXT-DUP-${randomUUID()}`,
          evidenceType: "BANK_ADVICE",
          evidenceReference: `DOC-DUP-${randomUUID()}`,
          reason: "محاولة استرداد مزدوج بعد استرداد كامل الدفعة",
          allocations: [
            {
              supplierPaymentAllocationId: Number(allocation.id),
              amount: "50000.00",
              currencyAmount: "50000.00",
            },
          ],
        },
        maker,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("يحفظ دقة ميزانية المطابقة وإلغاء السندات عند وجود فواتير مورد مفتوحة بالدولار والدينار معاً", async () => {
    await seedBase("500000.00");

    // ١) فاتورة آجلة بالدولار: 10$ × 1500 = 15,000 د.ع على ذمة المورد
    const usdDraft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CREDIT",
        agreedCurrency: "USD",
        agreedRate: "1500.0000",
        usdTotal: "10.00",
        clientRequestId: `usd-draft-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "1.0000",
            usdUnitPrice: "1.0000",
          },
        ],
      },
      maker,
    );
    const usdConf = await confirmPurchaseOrder(
      {
        purchaseOrderId: usdDraft.purchaseOrderId,
        expectedVersion: usdDraft.version,
        reason: "إرسال فاتورة دولار آجلة",
        clientRequestId: `usd-conf-${randomUUID()}`,
      },
      maker,
    );
    await decidePurchaseOrderControl(
      {
        requestId: usdConf.requestId,
        decisionKey: `usd-approve-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة الدولار الآجلة",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    // ٢) فاتورة آجلة بالدينار: 40,000 د.ع (إجمالي ذمة المورد = 55,000 د.ع)
    const iqdPo = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "8",
      unitPrice: "5000.00", // 40,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: iqdPo.requestId,
        decisionKey: `iqd-approve-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة الدينار الآجلة",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "55000.00",
    );

    const beforeInvs = await db().select().from(s.supplierInvoices);
    const iqdTarget = beforeInvs.find((i) => i.currency === "IQD")!;

    // سند صرف ديناري موجه لفاتورة الدينار بقيمة 40,000 د.ع يغلق فاتورة الدينار ويبقي فاتورة الدولار مفتوحة على 15,000 د.ع
    const mixedVch = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "40000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        supplierAllocations: [
          {
            supplierInvoiceId: Number(iqdTarget.id),
            invoiceVersion: Number(iqdTarget.version),
            amount: "40000.00",
          },
        ],
        description: "سداد فاتورة الدينار مع وجود فاتورة دولار مفتوحة",
        clientRequestId: `vch-mixed-${randomUUID()}`,
      },
      maker,
    );
    await approveVoucher(mixedVch.receiptId, owner);

    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "15000.00",
    );

    const allInvs = await db().select().from(s.supplierInvoices);
    const usdInv = allInvs.find((i) => i.currency === "USD")!;
    const iqdInv = allInvs.find((i) => i.currency === "IQD")!;
    expect(iqdInv.paymentGate).toBe("SETTLED");
    expect(usdInv.paymentGate).toBe("OPEN");

    // ٣) التحقق من أن إلغاء دفعة مقدمة غير مخصصة لا يخصم بالخطأ من أمر شراء ديناري قديم مسدد بسبب فاتورة الدولار المفتوحة
    const [legacyPaidInsert] = await db().insert(s.purchaseOrders).values({
      poNumber: "PO-LEGACY-PAID-1",
      supplierId: 1,
      branchId: 1,
      orderDate: new Date("2026-09-01T00:00:00Z"),
      subtotal: "20000.00",
      total: "20000.00",
      paidAmount: "20000.00",
      settlementType: "CREDIT",
      agreedCurrency: "IQD",
      status: "RECEIVED",
      createdBy: 1,
    });
    const legacyPoId = Number(legacyPaidInsert.insertId);

    // سند دفعة مقدمة (دون فواتير دينارية مفتوحة؛ نوقف بوابة منع الدفع الديناري للفاتورة الدولارية مؤقتاً بإدراج دفعة مقدمة مباشرة عبر رصيد دائن)
    // لإنشاء سند صرف قانوني دون خرق حارس الدولار، نسجل للمورد رصيداً افتتاحياً دينارياً موجباً 20,000 د.ع (ليصبح الرصيد 35,000 د.ع) ثم نسدده ونلغيه:
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "35000.00" })
      .where(eq(s.suppliers.id, 1));
    await db().insert(s.receipts).values({
      id: 701,
      branchId: 1,
      cashBucket: "TREASURY",
      direction: "OUT",
      amount: "20000.00",
      paymentMethod: "CASH",
      partyType: "SUPPLIER",
      partyId: 1,
      voucherNumber: "PV-ADV-701",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      description: "سداد رصيد افتتاحي ديناري بوجود فاتورة دولار مفتوحة",
      createdBy: 3,
      approvedBy: 3,
      approvedAt: new Date(),
    });
    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      entryDate: "2026-10-06",
      amount: "20000.00",
      branchId: 1,
      supplierId: 1,
      receiptId: 701,
      createdBy: 3,
    });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "15000.00" })
      .where(eq(s.suppliers.id, 1));

    // نخفض رصيد المورد بـ 20,000 إضافية ليحاكي دفعة مقدمة غير مرتبطة بفاتورة (currentBalance = -5000.00، وعند إلغاء 701 يعود 15000.00 مطابقاً لفاتورة الدولار!)
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "-5000.00" })
      .where(eq(s.suppliers.id, 1));

    const cancelAdv = await cancelVoucher(701, maker);
    await approveVoucher(Number(cancelAdv.approvalReceiptId), owner);

    const [legacyPoAfter] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, legacyPoId));
    expect(legacyPoAfter.paidAmount).toBe("20000.00");
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "15000.00",
    );
  });

  it("يحترم توجيه السند المحدد عبر approveVoucher المباشر ويعيد فتح بوابة الفاتورة بعد مرتجع آجل ثم إلغاء السند", async () => {
    await seedBase("500000.00");

    // ١) اختبار approveVoucher المباشر من ../voucher/approval عندما يهبط الرصيد إلى 0 مع وجود فاتورتين مفتوحتين وتوجيه للفاتورة الثانية
    const poOld = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "6",
      unitPrice: "5000.00", // 30,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: poOld.requestId,
        decisionKey: `old-po-${randomUUID()}`,
        approve: true,
        reason: "اعتماد الفاتورة الأقدم",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const poTarget = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "6",
      unitPrice: "5000.00", // 30,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: poTarget.requestId,
        decisionKey: `target-po-${randomUUID()}`,
        approve: true,
        reason: "اعتماد الفاتورة المستهدفة",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const twoInvs = await db().select().from(s.supplierInvoices);
    const invOld = twoInvs[0]!;
    const invTarget = twoInvs[1]!;

    // خفض الرصيد الافتتاحي بـ 30,000 ليصبح الرصيد الإجمالي 30,000 بحيث يصبح 0.00 فور اعتماد السند الموجه (الحالة التي كانت تطلق autoSettle قبل التخصيص الموجه!)
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "30000.00" })
      .where(eq(s.suppliers.id, 1));

    const targetedVch = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "30000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        supplierAllocations: [
          {
            supplierInvoiceId: Number(invTarget.id),
            invoiceVersion: Number(invTarget.version),
            amount: "30000.00",
          },
        ],
        description: "سداد موجه للفاتورة الثانية عبر approveVoucher المباشر",
        clientRequestId: `vch-direct-target-${randomUUID()}`,
      },
      maker,
    );
    await approveVoucherDirect(targetedVch.receiptId, owner);

    const [[invOldAfter], [invTargetAfter], [spayRow]] = await Promise.all([
      db()
        .select()
        .from(s.supplierInvoices)
        .where(eq(s.supplierInvoices.id, Number(invOld.id))),
      db()
        .select()
        .from(s.supplierInvoices)
        .where(eq(s.supplierInvoices.id, Number(invTarget.id))),
      db()
        .select()
        .from(s.supplierPayments)
        .where(eq(s.supplierPayments.receiptId, targetedVch.receiptId)),
    ]);
    expect(invTargetAfter.paymentGate).toBe("SETTLED");
    expect(invOldAfter.paymentGate).toBe("OPEN");
    expect(spayRow.paymentNumber).toMatch(/^SP-/);

    // ٢) على مورد مستقل (#2): دفعة جزئية بسند (20,000) + مرتجع شراء بالآجل (30,000) يغلق الفاتورة، ثم إلغاء السند يعيد فتحها على 20,000
    await db().insert(s.suppliers).values({
      id: 2,
      name: "مورد اختبار المرتجع والسند",
      currentBalance: "0.00",
    });
    const draftRet = await createPurchaseOrder(
      {
        supplierId: 2,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CREDIT",
        clientRequestId: `ret-po-draft-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "10",
            unitPrice: "5000.00", // 50,000
          },
        ],
      },
      maker,
    );
    const confRet = await confirmPurchaseOrder(
      {
        purchaseOrderId: draftRet.purchaseOrderId,
        expectedVersion: draftRet.version,
        reason: "إرسال فاتورة مورد #2",
        clientRequestId: `ret-po-conf-${randomUUID()}`,
      },
      maker,
    );
    await decidePurchaseOrderControl(
      {
        requestId: confRet.requestId,
        decisionKey: `ret-po-approve-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة مورد #2",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const partialSup2 = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "20000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 2,
        description: "دفعة جزئية قبل مرتجع الآجل",
        clientRequestId: `vch-sup2-part-${randomUUID()}`,
      },
      maker,
    );
    await approveVoucher(partialSup2.receiptId, owner);

    const [sup2Inv] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.supplierId, 2));
    const [matchRun] = await db()
      .select()
      .from(s.supplierInvoiceMatchRuns)
      .where(
        eq(
          s.supplierInvoiceMatchRuns.supplierInvoiceId,
          Number(sup2Inv.id),
        ),
      );
    const [matchAlloc] = await db()
      .select()
      .from(s.supplierInvoiceMatchAllocations)
      .where(
        eq(s.supplierInvoiceMatchAllocations.matchRunId, Number(matchRun.id)),
      );

    // مرتجع آجل لـ 6 قطع (30,000 د.ع) يغلق المتبقي من الفاتورة (50,000 - 20,000 - 30,000 = 0)
    const retReq = await requestPurchaseReturn(
      {
        supplierInvoiceId: Number(sup2Inv.id),
        matchRunId: Number(matchRun.id),
        expectedInvoiceVersion: Number(sup2Inv.version),
        requestKey: `ret-req-${randomUUID()}`,
        settlement: "CREDIT",
        paymentMethod: "CASH",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `RET-NOTE-${randomUUID()}`,
        reason: "إرجاع 6 قطع وتخفيض الذمة",
        lines: [{ matchAllocationId: Number(matchAlloc.id), baseQuantity: 6 }],
      },
      maker,
    );
    await decidePurchaseReturn(
      {
        requestId: retReq.requestId,
        decisionKey: `ret-dec-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "اعتماد مرتجع المشتريات الآجل",
      },
      owner,
    );

    expect(
      (
        await db()
          .select()
          .from(s.supplierInvoices)
          .where(eq(s.supplierInvoices.id, Number(sup2Inv.id)))
      )[0]?.paymentGate,
    ).toBe("SETTLED");
    expect(
      (
        await db()
          .select()
          .from(s.suppliers)
          .where(eq(s.suppliers.id, 2))
      )[0]?.currentBalance,
    ).toBe("0.00");

    // استرداد دفعة الـ 20,000 د.ع عبر المسار المحوكم يعيد فتح بوابة الفاتورة لأن المرتجع وحده (30,000) لا يغطي إجمالي الفاتورة (50,000)
    const [sup2Payment] = await db()
      .select()
      .from(s.supplierPayments)
      .where(eq(s.supplierPayments.receiptId, partialSup2.receiptId));
    const [sup2Alloc] = await db()
      .select()
      .from(s.supplierPaymentAllocations)
      .where(
        eq(
          s.supplierPaymentAllocations.supplierPaymentId,
          Number(sup2Payment.id),
        ),
      );
    const refundPart2 = await requestSupplierPaymentRefund(
      {
        supplierPaymentId: Number(sup2Payment.id),
        expectedPaymentVersion: Number(sup2Payment.version),
        requestKey: `refund-part2-${randomUUID()}`,
        refundMethod: "TRANSFER",
        externalReference: `EXT-P2-${randomUUID()}`,
        evidenceType: "BANK_ADVICE",
        evidenceReference: `DOC-P2-${randomUUID()}`,
        reason: "استرداد الدفعة الجزئية بعد المرتجع الآجل",
        allocations: [
          {
            supplierPaymentAllocationId: Number(sup2Alloc.id),
            amount: "20000.00",
            currencyAmount: "20000.00",
          },
        ],
      },
      maker,
    );
    await decideSupplierPaymentRefund(
      {
        requestId: refundPart2.requestId,
        decisionKey: `refund-part2-dec-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "اعتماد استرداد الدفعة الجزئية",
      },
      owner,
      SUPPLIER_PAYMENT_TREASURY_DECISION_CAPABILITY,
    );

    const [[sup2InvReopened], [sup2AfterCancel], [poSup2Reopened]] =
      await Promise.all([
        db()
          .select()
          .from(s.supplierInvoices)
          .where(eq(s.supplierInvoices.id, Number(sup2Inv.id))),
        db().select().from(s.suppliers).where(eq(s.suppliers.id, 2)),
        db()
          .select()
          .from(s.purchaseOrders)
          .where(eq(s.purchaseOrders.id, draftRet.purchaseOrderId)),
      ]);
    expect(sup2InvReopened.paymentGate).toBe("OPEN");
    expect(sup2AfterCancel.currentBalance).toBe("20000.00");
    expect(poSup2Reopened.paidAmount).toBe("0.00");
  });

  it("يعزل درج المدير المعتمد عن درج منشئ الفاتورة النقدية عند الاعتماد بالوضع التلقائي (cashSource: undefined)", async () => {
    await seedBase("300000.00");

    const makerShift = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      maker,
    );
    const reviewerShift = await openShift(
      { branchId: 1, openingBalance: "90000.00" },
      reviewer,
    );

    const cashPo = await createAndSubmitPo({
      settlementType: "CASH",
      quantity: "6",
      unitPrice: "5000.00", // 30,000
      cashSource: { mode: "DRAWER", shiftId: makerShift.shiftId },
    });

    const inboxRows = await purchaseOrderControlSource.list(
      {
        userId: reviewer.userId,
        branchId: reviewer.branchId,
        role: reviewer.role,
        isOwner: false,
        permissionsOverride: null,
        crossBranch: false,
      },
      { branchIds: [1], now: new Date() },
    );
    const inboxCashRow = inboxRows.find((r) => r.id === cashPo.requestId);
    expect(inboxCashRow?.summaryItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining(
            "تسوية الفاتورة: نقدي — يصرف النقد فورا عند الاعتماد وتسوى الفاتورة تلقائيا ليصبح المتبقي 0.00",
          ),
        }),
      ]),
    );
    expect(inboxCashRow?.confirmations[0]?.label).toContain(
      "يصرف النقد فورا ويسوي الفاتورة في معاملة واحدة",
    );

    // لو أرسل المعتمد المستقل درجه الشخصي بالخطأ، يرفض الخادم ذلك بـ FORBIDDEN
    await expect(
      decidePurchaseOrderControl(
        {
          requestId: cashPo.requestId,
          decisionKey: `approve-wrong-shift-${randomUUID()}`,
          approve: true,
          reason: "محاولة خصم خاطئة من درج المعتمد المستقل",
          confirmedFullReceipt: true,
          cashSource: { mode: "DRAWER", shiftId: reviewerShift.shiftId },
        },
        reviewer,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // بالوضع التلقائي (cashSource: undefined)، يعتمد المدير الفاتورة فتُصرف من درج المنشئ المعلن ويبقى درج المدير سليماً
    await decidePurchaseOrderControl(
      {
        requestId: cashPo.requestId,
        decisionKey: `approve-auto-source-${randomUUID()}`,
        approve: true,
        reason: "اعتماد مستقل بالوضع التلقائي لمصدر النقد",
        confirmedFullReceipt: true,
        cashSource: undefined,
      },
      reviewer,
    );

    const [makerCashAfter, reviewerCashAfter] = await Promise.all([
      db().transaction(async (tx) =>
        (await computeExpectedCash(tx, makerShift.shiftId, "80000.00")).toFixed(
          2,
        ),
      ),
      db().transaction(async (tx) =>
        (
          await computeExpectedCash(tx, reviewerShift.shiftId, "90000.00")
        ).toFixed(2),
      ),
    ]);
    expect(makerCashAfter).toBe("50000.00");
    expect(reviewerCashAfter).toBe("90000.00");
    expect((await db().select().from(s.suppliers))[0]?.currentBalance).toBe(
      "0.00",
    );
  });

  it("يرفض ذريا اعتماد سند صرف موجه لفاتورة سددت او انخفض متبقيها قبل الاعتماد دون سداد مزدوج او تسرب لفاتورة اخرى، وينظف الملاحظة الداخلية في getVoucher", async () => {
    await seedBase("500000.00");

    // ١) مورد له فاتورتان آجلتان مفتوحتان (#1 بقيمة 40,000 و #2 بقيمة 60,000)
    const po1 = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "8",
      unitPrice: "5000.00", // 40,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: po1.requestId,
        decisionKey: `race-po1-${randomUUID()}`,
        approve: true,
        reason: "اعتماد الفاتورة الاولى",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const po2 = await createAndSubmitPo({
      settlementType: "CREDIT",
      quantity: "12",
      unitPrice: "5000.00", // 60,000
    });
    await decidePurchaseOrderControl(
      {
        requestId: po2.requestId,
        decisionKey: `race-po2-${randomUUID()}`,
        approve: true,
        reason: "اعتماد الفاتورة الثانية المستهدفة",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const openInvs = await db().select().from(s.supplierInvoices);
    const inv1 = openInvs.find((i) => Number(i.totalAmount) === 40000)!;
    const inv2 = openInvs.find((i) => Number(i.totalAmount) === 60000)!;

    // إنشاء سند معلق موجه للفاتورة #2 بقيمة 60,000 مع ملاحظة داخلية بشرية
    const vchTargeted = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "60000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        supplierAllocations: [
          {
            supplierInvoiceId: Number(inv2.id),
            invoiceVersion: Number(inv2.version),
            amount: "60000.00",
          },
        ],
        description: "سداد كامل موجه للفاتورة الثانية",
        internalNote: "مراجعة محاسب الموردين",
        clientRequestId: `vch-race-target-${randomUUID()}`,
      },
      maker,
    );
    expect(vchTargeted.approvalStatus).toBe("PENDING_APPROVAL");

    // التحقق من أن getVoucher يحفظ الملاحظة الداخلية البشرية ويعيد تخصيص الفاتورة صريحاً
    const fetchedWithNote = await getVoucher(vchTargeted.receiptId);
    expect(fetchedWithNote?.internalNote).toBe("مراجعة محاسب الموردين");
    expect(fetchedWithNote?.supplierSettlement?.allocations).toEqual([
      expect.objectContaining({
        supplierInvoiceId: Number(inv2.id),
        amount: "60000.00",
      }),
    ]);

    // أثناء وجود سند صرف معلق على الفاتورة #2: يمنع النظام اعتماد مرتجع شراء فوقها (PRECONDITION_FAILED) لحماية التخصيص المحجوز
    const [matchRun2] = await db()
      .select()
      .from(s.supplierInvoiceMatchRuns)
      .where(
        eq(s.supplierInvoiceMatchRuns.supplierInvoiceId, Number(inv2.id)),
      );
    const [matchAlloc2] = await db()
      .select()
      .from(s.supplierInvoiceMatchAllocations)
      .where(
        eq(s.supplierInvoiceMatchAllocations.matchRunId, Number(matchRun2.id)),
      );
    const partialRet = await requestPurchaseReturn(
      {
        supplierInvoiceId: Number(inv2.id),
        matchRunId: Number(matchRun2.id),
        expectedInvoiceVersion: Number(inv2.version),
        requestKey: `race-ret-partial-${randomUUID()}`,
        settlement: "CREDIT",
        paymentMethod: "CASH",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `RACE-RET-1-${randomUUID()}`,
        reason: "مرتجع جزئي يخفض متبقي الفاتورة المستهدفة",
        lines: [{ matchAllocationId: Number(matchAlloc2.id), baseQuantity: 4 }],
      },
      maker,
    );
    await expect(
      decidePurchaseReturn(
        {
          requestId: partialRet.requestId,
          decisionKey: `race-ret-blocked-${randomUUID()}`,
          action: "APPROVE",
          reviewReason: "محاولة اعتماد مرتجع فوق سند صرف معلق",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // بعد سحب السند المعلق بلا أثر مالي، يُعتمد المرتجع فيخفض المتبقي إلى 40,000، وترفض محاولة إنشاء سند جديد بـ 60,000 دون تسريب 20,000 للفاتورة #1
    await cancelVoucher(vchTargeted.receiptId, maker);
    await decidePurchaseReturn(
      {
        requestId: partialRet.requestId,
        decisionKey: `race-ret-partial-dec-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "اعتماد المرتجع الجزئي بعد سحب السند المعلق",
      },
      owner,
    );
    const [inv2AfterRet] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.id, Number(inv2.id)));
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "60000.00",
          paymentMethod: "CASH",
          partyType: "SUPPLIER",
          partyId: 1,
          supplierAllocations: [
            {
              supplierInvoiceId: Number(inv2.id),
              invoiceVersion: Number(inv2AfterRet.version),
              amount: "60000.00",
            },
          ],
          description: "محاولة سداد مفرط بعد المرتجع",
          clientRequestId: `vch-race-over-${randomUUID()}`,
        },
        maker,
      ),
    ).rejects.toThrow();

    const [[supAfterPartialRace], [po1AfterRace], spayAfterRace] =
      await Promise.all([
        db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)),
        db()
          .select()
          .from(s.purchaseOrders)
          .where(eq(s.purchaseOrders.id, po1.purchaseOrderId)),
        db().select().from(s.supplierPayments),
      ]);
    expect(supAfterPartialRace.currentBalance).toBe("80000.00");
    expect(po1AfterRace.paidAmount).toBe("0.00");
    expect(spayAfterRace).toHaveLength(0);

    // ٢) مورد ثان برصيد افتتاحي (30,000) وفاتورة وحيدة تُقفل بالكامل بمرتجع آجل بعد سحب السند المعلق
    await db().insert(s.suppliers).values({
      id: 2,
      name: "مورد الفاتورة الوحيدة",
      currentBalance: "30000.00",
    });
    const singleDraft = await createPurchaseOrder(
      {
        supplierId: 2,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CREDIT",
        clientRequestId: `single-race-draft-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "6",
            unitPrice: "5000.00", // 30,000
          },
        ],
      },
      maker,
    );
    const singleConf = await confirmPurchaseOrder(
      {
        purchaseOrderId: singleDraft.purchaseOrderId,
        expectedVersion: singleDraft.version,
        reason: "ارسال فاتورة المورد الثاني",
        clientRequestId: `single-race-conf-${randomUUID()}`,
      },
      maker,
    );
    await decidePurchaseOrderControl(
      {
        requestId: singleConf.requestId,
        decisionKey: `single-race-dec-${randomUUID()}`,
        approve: true,
        reason: "اعتماد فاتورة المورد الثاني",
        confirmedFullReceipt: true,
      },
      reviewer,
    );

    const [singleInv] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.supplierId, 2));
    const vchSingle = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "30000.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 2,
        supplierAllocations: [
          {
            supplierInvoiceId: Number(singleInv.id),
            invoiceVersion: Number(singleInv.version),
            amount: "30000.00",
          },
        ],
        description: "سداد موجه للفاتورة الوحيدة",
        clientRequestId: `vch-single-race-${randomUUID()}`,
      },
      maker,
    );

    const fetchedEmptyNote = await getVoucher(vchSingle.receiptId);
    expect(fetchedEmptyNote?.internalNote).toBeNull();
    expect(fetchedEmptyNote?.supplierSettlement?.allocations).toEqual([
      expect.objectContaining({
        supplierInvoiceId: Number(singleInv.id),
        amount: "30000.00",
      }),
    ]);

    const [singleMatchRun] = await db()
      .select()
      .from(s.supplierInvoiceMatchRuns)
      .where(
        eq(
          s.supplierInvoiceMatchRuns.supplierInvoiceId,
          Number(singleInv.id),
        ),
      );
    const [singleMatchAlloc] = await db()
      .select()
      .from(s.supplierInvoiceMatchAllocations)
      .where(
        eq(
          s.supplierInvoiceMatchAllocations.matchRunId,
          Number(singleMatchRun.id),
        ),
      );
    const fullRet = await requestPurchaseReturn(
      {
        supplierInvoiceId: Number(singleInv.id),
        matchRunId: Number(singleMatchRun.id),
        expectedInvoiceVersion: Number(singleInv.version),
        requestKey: `single-full-ret-${randomUUID()}`,
        settlement: "CREDIT",
        paymentMethod: "CASH",
        evidenceType: "RETURN_NOTE",
        evidenceReference: `RACE-RET-2-${randomUUID()}`,
        reason: "اقفال الفاتورة الوحيدة بمرتجع آجل كامل",
        lines: [
          { matchAllocationId: Number(singleMatchAlloc.id), baseQuantity: 6 },
        ],
      },
      maker,
    );
    await expect(
      decidePurchaseReturn(
        {
          requestId: fullRet.requestId,
          decisionKey: `single-full-ret-blocked-${randomUUID()}`,
          action: "APPROVE",
          reviewReason: "منع اعتماد المرتجع اثناء حجز السند المعلق",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await cancelVoucher(vchSingle.receiptId, maker);
    await decidePurchaseReturn(
      {
        requestId: fullRet.requestId,
        decisionKey: `single-full-ret-dec-${randomUUID()}`,
        action: "APPROVE",
        reviewReason: "اعتماد المرتجع الكامل بعد سحب السند المعلق",
      },
      owner,
    );

    // بعد سحب السند وإقفال الفاتورة بالمرتجع: محاولة اعتماد السند المسحوب عبر approveVoucherDirect تفشل مغلقة ولا تحول الدفعة إلى الرصيد الافتتاحي
    await expect(
      approveVoucherDirect(vchSingle.receiptId, owner),
    ).rejects.toThrow();

    const [[sup2After], [vchSingleAfter]] = await Promise.all([
      db().select().from(s.suppliers).where(eq(s.suppliers.id, 2)),
      db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, vchSingle.receiptId)),
    ]);
    expect(sup2After.currentBalance).toBe("30000.00");
    expect(vchSingleAfter.status).toBe("REVERSED");
  });

  it("يجدد الوردية الملتقطة تلقائيا (explicit: false) عند اغلاقها لمصلحة وردية جديدة او خزينة المالك، مع الابقاء على الفشل المغلق للدرج او الخزينة المحددة صراحة (explicit: true)", async () => {
    await seedBase("600000.00");

    // ١) التقاط تلقائي (cashSource: undefined => explicit: false) ثم اغلاق الوردية قبل الاعتماد
    const shiftA = await openShift(
      { branchId: 1, openingBalance: "80000.00" },
      maker,
    );
    const autoPo = await createAndSubmitPo({
      settlementType: "CASH",
      quantity: "6",
      unitPrice: "5000.00", // 30,000
      cashSource: undefined,
    });
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null, closedAt: new Date() })
      .where(eq(s.shifts.id, shiftA.shiftId));

    // المدير غير المالك يفشل مغلقاً بـ PRECONDITION_FAILED لعدم وجود وردية مفتوحة للمنشئ وعدم صلاحية الخزينة
    await expect(
      decidePurchaseOrderControl(
        {
          requestId: autoPo.requestId,
          decisionKey: `auto-closed-reviewer-${randomUUID()}`,
          approve: true,
          reason: "محاولة اعتماد مدير مع وردية مغلقة",
          confirmedFullReceipt: true,
          cashSource: undefined,
        },
        reviewer,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // المالك بالوضع التلقائي (cashSource: undefined) يسدد بنجاح من الخزينة دون الارتطام بالوردية المغلقة
    await decidePurchaseOrderControl(
      {
        requestId: autoPo.requestId,
        decisionKey: `auto-closed-owner-${randomUUID()}`,
        approve: true,
        reason: "اعتماد المالك بالوضع التلقائي بعد اغلاق وردية المنشئ",
        confirmedFullReceipt: true,
        cashSource: undefined,
      },
      owner,
    );

    const [poAutoAfter] = await db()
      .select()
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, autoPo.purchaseOrderId));
    expect(poAutoAfter).toMatchObject({
      status: "RECEIVED",
      paidAmount: "30000.00",
    });

    // ٢) تعديل مسودة نقدية التقطت وردية أُغلقت لاحقاً يجدد الارتباط للوردية المفتوحة الجديدة بسلاسة
    const shiftA2 = await openShift(
      { branchId: 1, openingBalance: "70000.00" },
      maker,
    );
    const draftAuto = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        status: "DRAFT",
        settlementType: "CASH",
        clientRequestId: `draft-refresh-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "5",
            unitPrice: "5000.00", // 25,000
          },
        ],
      },
      maker,
    );
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null, closedAt: new Date() })
      .where(eq(s.shifts.id, shiftA2.shiftId));

    const shiftB = await openShift(
      { branchId: 1, openingBalance: "90000.00" },
      maker,
    );
    const editedDraft = await updatePurchaseOrder(
      {
        purchaseOrderId: draftAuto.purchaseOrderId,
        expectedVersion: draftAuto.version,
        supplierId: 1,
        branchId: 1,
        settlementType: "CASH",
        revisionReason: "تعديل الكمية بعد فتح وردية جديدة",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "6",
            unitPrice: "5000.00", // 30,000
          },
        ],
      },
      maker,
    );
    const confirmedEdited = await confirmPurchaseOrder(
      {
        purchaseOrderId: draftAuto.purchaseOrderId,
        expectedVersion: editedDraft.version,
        reason: "ارسال المسودة المحدثة للاعتماد",
        clientRequestId: `draft-refresh-conf-${randomUUID()}`,
      },
      maker,
    );
    await decidePurchaseOrderControl(
      {
        requestId: confirmedEdited.requestId,
        decisionKey: `draft-refresh-dec-${randomUUID()}`,
        approve: true,
        reason: "اعتماد المسودة من الوردية المجددة",
        confirmedFullReceipt: true,
        cashSource: undefined,
      },
      reviewer,
    );

    expect(
      await db().transaction(async (tx) =>
        (await computeExpectedCash(tx, shiftB.shiftId, "90000.00")).toFixed(2),
      ),
    ).toBe("60000.00");

    // ٣) الدرج المحدد صراحة (explicit: true) يبقى محكوماً بالفشل المغلق إذا أُغلقت الوردية حتى لو فُتحت وردية لاحقة
    const explicitPo = await createAndSubmitPo({
      settlementType: "CASH",
      quantity: "4",
      unitPrice: "5000.00", // 20,000
      cashSource: { mode: "DRAWER", shiftId: shiftB.shiftId },
    });
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null, closedAt: new Date() })
      .where(eq(s.shifts.id, shiftB.shiftId));
    const shiftC = await openShift(
      { branchId: 1, openingBalance: "90000.00" },
      maker,
    );

    await expect(
      decidePurchaseOrderControl(
        {
          requestId: explicitPo.requestId,
          decisionKey: `explicit-closed-reviewer-${randomUUID()}`,
          approve: true,
          reason: "محاولة اعتماد درج محدد صراحة بعد اغلاقه",
          confirmedFullReceipt: true,
          cashSource: undefined,
        },
        reviewer,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await expect(
      decidePurchaseOrderControl(
        {
          requestId: explicitPo.requestId,
          decisionKey: `explicit-closed-owner-auto-${randomUUID()}`,
          approve: true,
          reason: "محاولة اعتماد المالك تلقائيا لدرج محدد صراحة مغلق",
          confirmedFullReceipt: true,
          cashSource: undefined,
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // ٤) أمر شراء موجّه صراحة للخزينة (TREASURY) أثناء فتح وردية للمنشئ: لا يُخصم من درج المنشئ ولا يعتمده غير المالك
    const treasuryPo = await createAndSubmitPo({
      settlementType: "CASH",
      quantity: "4",
      unitPrice: "5000.00", // 20,000
      cashSource: { mode: "TREASURY" },
    });

    await expect(
      decidePurchaseOrderControl(
        {
          requestId: treasuryPo.requestId,
          decisionKey: `treasury-po-reviewer-${randomUUID()}`,
          approve: true,
          reason: "محاولة مدير غير مالك اعتماد فاتورة موجهة للخزينة",
          confirmedFullReceipt: true,
          cashSource: undefined,
        },
        reviewer,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await decidePurchaseOrderControl(
      {
        requestId: treasuryPo.requestId,
        decisionKey: `treasury-po-owner-${randomUUID()}`,
        approve: true,
        reason: "اعتماد المالك لفاتورة موجهة للخزينة مع بقاء درج المنشئ سليما",
        confirmedFullReceipt: true,
        cashSource: undefined,
      },
      owner,
    );

    expect(
      await db().transaction(async (tx) =>
        (await computeExpectedCash(tx, shiftC.shiftId, "90000.00")).toFixed(2),
      ),
    ).toBe("90000.00");
  });

  it("يدعم تعديل مصدر النقد وحده في مسودة امر شراء نقدي، ويطابق السندات التاريخية مع الفواتير الاصلية عبر reconcileSupplierPurchaseSettlement", async () => {
    await seedBase("600000.00");
    await db().insert(s.suppliers).values({
      id: 2,
      name: "مورد المطابقة التاريخية",
      currentBalance: "0.00",
    });

    // ١) إنشاء مسودة CASH موجهة صراحة لدرج مفتوح ثم إغلاق الدرج وتعديل المسودة لتغيير مصدر النقد وحده إلى TREASURY
    const shiftDraft = await openShift(
      { branchId: 1, openingBalance: "60000.00" },
      maker,
    );
    const createdDraft = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        settlementType: "CASH",
        cashSource: { mode: "DRAWER", shiftId: shiftDraft.shiftId },
        clientRequestId: `draft-cash-source-only-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "2",
            unitPrice: "5000.00", // 10,000.00
          },
        ],
      },
      maker,
    );
    await db()
      .update(s.shifts)
      .set({ status: "CLOSED", openGuard: null, closedAt: new Date() })
      .where(eq(s.shifts.id, shiftDraft.shiftId));

    const updatedDraft = await updatePurchaseOrder(
      {
        purchaseOrderId: createdDraft.purchaseOrderId,
        expectedVersion: createdDraft.version,
        revisionReason: "تحويل مصدر الصرف النقدي الى الخزينة بعد اغلاق الوردية",
        supplierId: 1,
        settlementType: "CASH",
        cashSource: { mode: "TREASURY" },
        agreedCurrency: "IQD",
        taxRatePercent: "0",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "2",
            unitPrice: "5000.00",
          },
        ],
      },
      owner,
    );
    expect(updatedDraft.revisionNo).toBe(2);

    const submittedDraft = await confirmPurchaseOrder(
      {
        purchaseOrderId: createdDraft.purchaseOrderId,
        expectedVersion: updatedDraft.version,
        reason: "ارسال مسودة محدثة المصدر النقدي للاعتماد",
        clientRequestId: `submit-updated-source-${randomUUID()}`,
      },
      maker,
    );
    await decidePurchaseOrderControl(
      {
        requestId: submittedDraft.requestId,
        decisionKey: `approve-updated-source-${randomUUID()}`,
        approve: true,
        reason: "اعتماد الفاتورة النقدية المحدث مصدرها للخزينة",
        confirmedFullReceipt: true,
      },
      owner,
    );
    const [settledDraftOrder] = await db()
      .select({ status: s.purchaseOrders.status, paidAmount: s.purchaseOrders.paidAmount })
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, createdDraft.purchaseOrderId));
    expect(settledDraftOrder).toEqual({ status: "RECEIVED", paidAmount: "10000.00" });

    // ٢) فاتورة نقدية تاريخية مرتبطة بفاتورة مورد أصلية (supplierInvoices) مع سند صرف تاريخي غير مخصص مطابق
    const histPo = await createPurchaseOrder(
      {
        supplierId: 2,
        branchId: 1,
        settlementType: "CREDIT",
        clientRequestId: `hist-native-po-${randomUUID()}`,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "3",
            unitPrice: "5000.00", // 15,000.00
          },
        ],
      },
      maker,
    );
    const histReq = await confirmPurchaseOrder(
      {
        purchaseOrderId: histPo.purchaseOrderId,
        expectedVersion: histPo.version,
        reason: "ارسال فاتورة للمورد الثاني",
        clientRequestId: `hist-native-confirm-${randomUUID()}`,
      },
      maker,
    );
    await decidePurchaseOrderControl(
      {
        requestId: histReq.requestId,
        decisionKey: `hist-native-approve-${randomUUID()}`,
        approve: true,
        reason: "اعتماد وترحيل فاتورة اصلية للمورد الثاني",
        confirmedFullReceipt: true,
      },
      reviewer,
    );
    // محاكاة الفاتورة النقدية التاريخية قبل الترحيل الذري + سند صرف تاريخي غير مربوط بـ supplierPayments
    await db()
      .update(s.purchaseOrders)
      .set({ settlementType: "CASH", paidAmount: "0.00" })
      .where(eq(s.purchaseOrders.id, histPo.purchaseOrderId));
    const histReceiptIns = await db().insert(s.receipts).values({
      branchId: 1,
      direction: "OUT",
      amount: "15000.00",
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      voucherNumber: "PV-HIST-NATIVE-1",
      partyType: "SUPPLIER",
      partyId: 2,
      referenceNumber: "HIST-NATIVE-REF-1",
      description: "سند صرف تاريخي للمورد الثاني قبل التخصيص الاصلي",
      createdBy: owner.userId,
      approvedBy: owner.userId,
      approvedAt: new Date(),
      executedBy: owner.userId,
      executedAt: new Date(),
      voucherDate: "2026-10-20",
    });
    const histReceiptId = Number(
      (histReceiptIns as unknown as [{ insertId: number }])[0]?.insertId ??
        (histReceiptIns as unknown as { insertId: number }).insertId,
    );
    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT",
      amount: "15000.00",
      supplierId: 2,
      receiptId: histReceiptId,
      branchId: 1,
      description: "قيد صرف تاريخي للمورد الثاني",
      createdBy: owner.userId,
      entryDate: new Date(),
    });
    await db()
      .update(s.suppliers)
      .set({ currentBalance: "0.00" })
      .where(eq(s.suppliers.id, 2));

    // غير المالك يحصل على ownerRequiredEpisodesCount = 1 بدلاً من ادعاء عدم وجود سندات
    const nonOwnerAttempt = await reconcileSupplierPurchaseSettlement(
      { supplierId: 2 },
      reviewer,
    );
    expect(nonOwnerAttempt).toMatchObject({
      totalSettledAmount: "0.00",
      ownerRequiredEpisodesCount: 1,
    });

    // المالك يعتمد الحلقة التاريخية الأصيلة فتُسوى الفاتورة الأصلية وPO دون أي حركة نقد أو ذمة جديدة
    const ownerReconcile = await reconcileSupplierPurchaseSettlement(
      { supplierId: 2 },
      owner,
    );
    expect(ownerReconcile).toMatchObject({
      nativeAdoptedEpisodesCount: 1,
      settledOrdersCount: 1,
      totalSettledAmount: "15000.00",
      ownerRequiredEpisodesCount: 0,
    });
    const [histNativeInv] = await db()
      .select()
      .from(s.supplierInvoices)
      .where(eq(s.supplierInvoices.supplierId, 2));
    expect(histNativeInv).toMatchObject({
      paymentGate: "SETTLED",
    });
    const [histPoAfter] = await db()
      .select({ paidAmount: s.purchaseOrders.paidAmount })
      .from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, histPo.purchaseOrderId));
    expect(histPoAfter?.paidAmount).toBe("15000.00");
  });
});
