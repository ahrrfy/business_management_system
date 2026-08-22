import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  approveExpense,
  cancelExpense,
  createExpense,
  getExpenseTrace,
  listExpenses,
} from "../expenseService";
import { openShift } from "../shiftService";
import { resubmitRejectedExpensePayment } from "../voucher/approval";
import { computeSignature } from "../voucher/helpers";
import { listVouchers } from "../voucherService";

const manager1 = { userId: 1, branchId: 1, role: "manager" };
const manager2 = { userId: 2, branchId: 1, role: "manager" };

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "idempotencyKeys",
    "auditLogs",
    "accrualCorrectionRequests",
    "accrualObligationEvents",
    "accrualObligations",
    "accountingEntries",
    "expenseStockItems",
    "receipts",
    "expenses",
    "assetMaintenance",
    "fixedAssets",
    "purchaseOrderItems",
    "purchaseOrders",
    "suppliers",
    "shifts",
    "branches",
    "users",
  ]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "expense-trace-m1",
      name: "مروة",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "expense-trace-m2",
      name: "تغريد",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await d.insert(s.branches).values({ id: 2, name: "SALES", code: "SALES", type: "SALES" });
  await d.insert(s.suppliers).values({ id: 1, name: "TRACE-SUPPLIER" });
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "20000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "EXPENSE-TRACE-TREASURY-FUND",
    createdBy: manager1.userId,
  });
}

type RecognizedRequestCase =
  | { kind: "PURCHASE_SHIPPING"; approvalStatus: "PENDING_APPROVAL" }
  | { kind: "ASSET_MAINTENANCE"; approvalStatus: "REJECTED" };

async function recognizedUnsettledExpense(
  input: RecognizedRequestCase,
  options: { resubmit?: boolean; cancel?: boolean } = {},
) {
  const shipping = input.kind === "PURCHASE_SHIPPING";
  const receiptId = shipping ? 401 : 402;
  const expenseId = shipping ? 501 : 502;
  const amount = shipping ? "400.00" : "250.00";
  const request = shipping
    ? {
        kind: "PURCHASE_SHIPPING" as const,
        purchaseOrderId: 91,
        requestToken: "abcdef0123456789",
        expectedAmount: amount,
        sourceShippingTotal: amount,
      }
    : {
        kind: "ASSET_MAINTENANCE" as const,
        assetId: 81,
        maintenanceId: 71,
      };
  const referenceNumber = shipping
    ? "SHIP-TRACE-PO-91-abcdef0123456789"
    : "ASSET-MAINT-71";
  const accrualDedupe = shipping
    ? "PURCHASE_SHIPPING_ACCRUAL:91:abcdef0123456789"
    : "ASSET_MAINT_ACCRUAL:71";

  if (shipping) {
    await db().insert(s.purchaseOrders).values({
      id: 91,
      poNumber: "TRACE-PO-91",
      supplierId: 1,
      branchId: 1,
      subtotal: "0.00",
      shippingCost: amount,
      customsCost: "0.00",
      total: "0.00",
      status: "RECEIVED",
      createdBy: manager1.userId,
    });
  } else {
    await db().insert(s.fixedAssets).values([
      {
        id: 81,
        code: "AST-TRACE-81",
        name: "TRACE-ASSET-81",
        category: "devices",
        branchId: 1,
        purchaseDate: "2026-01-01",
        purchaseValue: "1000.00",
        usefulLifeYears: 5,
      },
      {
        id: 82,
        code: "AST-TRACE-82",
        name: "TRACE-ASSET-82",
        category: "devices",
        branchId: 1,
        purchaseDate: "2026-01-01",
        purchaseValue: "1000.00",
        usefulLifeYears: 5,
      },
    ]);
    await db().insert(s.assetMaintenance).values({
      id: 71,
      assetId: 81,
      maintDate: "2026-08-15",
      type: "TRACE-MAINTENANCE",
      cost: amount,
    });
  }

  await db()
    .insert(s.receipts)
    .values({
      id: receiptId,
      branchId: 1,
      shiftId: null,
      cashBucket: null,
      direction: "OUT",
      amount,
      paymentMethod: "CASH",
      status: input.approvalStatus === "REJECTED" ? "FAILED" : "PENDING",
      approvalStatus: input.approvalStatus,
      approvedBy: input.approvalStatus === "REJECTED" ? manager2.userId : null,
      approvedAt: input.approvalStatus === "REJECTED" ? new Date() : null,
      referenceNumber,
      partyType: "OTHER",
      counterpartyName: shipping ? "شركة النقل/الكمرك" : "فني الصيانة",
      description: shipping ? "شحن مستحق غير مدفوع" : "صيانة مستحقة غير مدفوعة",
      internalNote: `@SYSTEM_PAYMENT_REQUEST:${JSON.stringify(request)}`,
      createdBy: manager1.userId,
    });
  await db()
    .insert(s.expenses)
    .values({
      id: expenseId,
      branchId: 1,
      shiftId: null,
      cashBucket: "TREASURY",
      expenseDate: new Date("2026-08-15T00:00:00.000Z"),
      category: shipping ? "TRANSPORT" : "MAINTENANCE",
      amount,
      paymentMethod: "CASH",
      source: "CASH",
      description: shipping ? "شحن/كمرك أمر شراء" : "صيانة أصل",
      referenceNumber,
      payee: null,
      receiptId,
      status: "ACTIVE",
      createdBy: manager1.userId,
    });
  await db()
    .insert(s.accountingEntries)
    .values({
      entryType: "PAYMENT_OUT",
      branchId: 1,
      purchaseOrderId: shipping ? 91 : null,
      receiptId: null,
      amount,
      entryDate: new Date("2026-08-15T00:00:00.000Z"),
      dedupeKey: accrualDedupe,
      notes: "قيد استحقاق اختبار",
    });

  let activeReceiptId = receiptId;
  if (options.resubmit) {
    const replacement = await resubmitRejectedExpensePayment(
      receiptId,
      manager2,
      {
        note: "TRACE-RESUBMISSION",
        priorReceiptId: receiptId,
        reissueReason: "أُعيد ربط مستند التتبع",
      },
    );
    activeReceiptId = replacement.receiptId;
  }
  if (options.cancel !== false) await cancelExpense(expenseId, manager2);
  return { expenseId, receiptId: activeReceiptId, originalReceiptId: receiptId, amount };
}

type RecognizedExpenseResult = Awaited<ReturnType<typeof recognizedUnsettledExpense>>;
type SourceTamperCase = {
  label: string;
  input: RecognizedRequestCase;
  options?: { resubmit?: boolean };
  mutate: (result: RecognizedExpenseResult) => Promise<unknown>;
};

async function tamperSystemRequest(
  receiptId: number,
  patch: Record<string, unknown>,
) {
  const [receipt] = await db()
    .select({ internalNote: s.receipts.internalNote })
    .from(s.receipts)
    .where(eq(s.receipts.id, receiptId));
  const prefix = "@SYSTEM_PAYMENT_REQUEST:";
  if (!receipt?.internalNote?.startsWith(prefix)) throw new Error("system request missing");
  const request = JSON.parse(receipt.internalNote.slice(prefix.length));
  await db()
    .update(s.receipts)
    .set({ internalNote: `${prefix}${JSON.stringify({ ...request, ...patch })}` })
    .where(eq(s.receipts.id, receiptId));
}

const sourceTamperCases: SourceTamperCase[] = [
  {
    label: "maintenance asset relation",
    input: { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
    mutate: () => db().update(s.assetMaintenance).set({ assetId: 82 }).where(eq(s.assetMaintenance.id, 71)),
  },
  {
    label: "missing maintenance source",
    input: { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
    mutate: () => db().delete(s.assetMaintenance).where(eq(s.assetMaintenance.id, 71)),
  },
  {
    label: "shipping source snapshot",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: ({ receiptId }) => tamperSystemRequest(receiptId, { sourceShippingTotal: "401.00" }),
  },
  {
    label: "expense source reference",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: ({ expenseId }) => db().update(s.expenses).set({ referenceNumber: "SHIP-TAMPERED" }).where(
      eq(s.expenses.id, expenseId),
    ),
  },
  {
    label: "non-cash expense and receipt pair",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: async ({ expenseId, receiptId }) => {
      await db().update(s.expenses).set({ paymentMethod: "CARD" }).where(eq(s.expenses.id, expenseId));
      await db().update(s.receipts).set({ paymentMethod: "CARD" }).where(eq(s.receipts.id, receiptId));
    },
  },
  {
    label: "receipt party linkage",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: ({ receiptId }) => db().update(s.receipts).set({ partyType: "CUSTOMER", partyId: 777 }).where(
      eq(s.receipts.id, receiptId),
    ),
  },
  {
    label: "purchase order source",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: () => db().update(s.purchaseOrders).set({ branchId: 2 }).where(eq(s.purchaseOrders.id, 91)),
  },
  {
    label: "accrual purchase order",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: () => db().update(s.accountingEntries).set({ purchaseOrderId: null }).where(
      eq(s.accountingEntries.dedupeKey, "PURCHASE_SHIPPING_ACCRUAL:91:abcdef0123456789"),
    ),
  },
  {
    label: "accrual amount",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: () => db().update(s.accountingEntries).set({ amount: "399.00" }).where(
      eq(s.accountingEntries.dedupeKey, "PURCHASE_SHIPPING_ACCRUAL:91:abcdef0123456789"),
    ),
  },
  {
    label: "accrual branch",
    input: { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
    mutate: () => db().update(s.accountingEntries).set({ branchId: 2 }).where(
      eq(s.accountingEntries.dedupeKey, "PURCHASE_SHIPPING_ACCRUAL:91:abcdef0123456789"),
    ),
  },
  {
    label: "resubmission rejection proof",
    input: { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
    options: { resubmit: true },
    mutate: ({ originalReceiptId }) => db().update(s.receipts).set({ approvedAt: null }).where(
      eq(s.receipts.id, originalReceiptId),
    ),
  },
  {
    label: "resubmission parent null party identity",
    input: { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
    options: { resubmit: true },
    mutate: ({ originalReceiptId }) => db().update(s.receipts).set({ partyId: 0 }).where(
      eq(s.receipts.id, originalReceiptId),
    ),
  },
  {
    label: "duplicate resubmission link",
    input: { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
    options: { resubmit: true },
    mutate: ({ receiptId }) => db().insert(s.idempotencyKeys).values({
      operation: "voucher.create",
      clientRequestId: "system-expense-resubmit-999999",
      refId: receiptId,
    }),
  },
];

beforeEach(reset);

describe("عقد التتبع التفصيلي للمصروفات", () => {
  it("يعيد المنشئ وصاحب الدرج والسند والاعتماد والفلاتر والمجاميع", async () => {
    const { shiftId } = await openShift(
      { branchId: 1, openingBalance: "5000" },
      manager1,
    );
    const created = await createExpense(
      {
        branchId: 1,
        shiftId,
        cashSource: "OWN_DRAWER",
        category: "UTILITIES",
        amount: "1250.00",
        paymentMethod: "CASH",
        description: "اشتراك الإنترنت",
        referenceNumber: "NET-1250",
        payee: "شركة الإنترنت",
        costCenter: "الإدارة والتشغيل",
        isRecurring: true,
        recurringFrequency: "MONTHLY",
      },
      manager1,
    );

    const listed = await listExpenses({
      fundingKind: "DRAWER",
      createdBy: 1,
      shiftId,
      amount: "1250.00",
      q: "1250",
    });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]).toMatchObject({
      id: created.expenseId,
      branchName: "الرئيسي",
      branchCode: "MAIN",
      cashBucket: "DRAWER",
      fundingKind: "DRAWER",
      payee: "شركة الإنترنت",
      costCenter: "الإدارة والتشغيل",
      isRecurring: true,
      recurringFrequency: "MONTHLY",
      receiptId: created.receiptId,
      linkedReceiptId: created.receiptId,
      createdBy: 1,
      createdByName: "مروة",
      shiftOwnerId: 1,
      shiftOwnerName: "مروة",
      shiftStatus: "OPEN",
      receiptDirection: "OUT",
      receiptStatus: "COMPLETED",
      receiptApprovalStatus: "APPROVED",
      receiptApprovedBy: null,
      needsAudit: false,
      integrityWarnings: [],
    });
    expect(listed.totals).toMatchObject({
      active: "1250.00",
      drawer: "1250.00",
      treasury: "0.00",
      nonCash: "0.00",
      stock: "0.00",
      cancelled: "0.00",
      needsAudit: 0,
      count: 1,
    });

    const trace = await getExpenseTrace(created.expenseId, { branchId: 1 });
    expect(trace?.expense.createdByName).toBe("مروة");
    expect(trace?.ledgerEntries).toHaveLength(1);
    expect(trace?.ledgerEntries[0]).toMatchObject({
      entryType: "PAYMENT_OUT",
      createdBy: 1,
    });
  });

  it("طلب TREASURY لا ينفذ قبل اعتماد مالك آخر وOWN_DRAWER يرفض وردية شخص آخر", async () => {
    const own = await openShift(
      { branchId: 1, openingBalance: "1000" },
      manager1,
    );
    const treasury = await createExpense(
      {
        branchId: 1,
        shiftId: own.shiftId,
        cashSource: "TREASURY",
        category: "RENT",
        amount: "300.00",
        paymentMethod: "CASH",
        description: "صرف من الخزينة",
        payee: "مستفيد موثق",
      },
      manager1,
    );
    const pendingRow = (await listExpenses({ status: "PENDING_APPROVAL" }))
      .rows[0];
    expect(pendingRow).toMatchObject({
      id: treasury.expenseId,
      shiftId: null,
      cashBucket: null,
      status: "PENDING_APPROVAL",
      needsAudit: false,
    });
    await approveExpense(treasury.expenseId, {
      ...manager2,
      isOwner: true,
    });
    const treasuryRow = (await listExpenses({ fundingKind: "TREASURY" }))
      .rows[0];
    expect(treasuryRow).toMatchObject({
      id: treasury.expenseId,
      shiftId: null,
      cashBucket: "TREASURY",
      fundingKind: "TREASURY",
      needsAudit: false,
    });

    const other = await openShift(
      { branchId: 1, openingBalance: "1000" },
      manager2,
    );
    await expect(
      createExpense(
        {
          branchId: 1,
          shiftId: other.shiftId,
          cashSource: "OWN_DRAWER",
          category: "SUPPLIES",
          amount: "50.00",
          paymentMethod: "CASH",
          description: "محاولة درج آخر",
        },
        manager1,
      ),
    ).rejects.toThrow(/درج وردية المُنشئ فقط/);
  });

  it("يكشف اختلاف المصروف عن السند ويحسب needsAudit", async () => {
    const created = await createExpense(
      {
        branchId: 1,
        category: "MAINTENANCE",
        amount: "400.00",
        paymentMethod: "TRANSFER",
        description: "صيانة",
        referenceNumber: "TX-400",
        payee: "الفني",
      },
      manager1,
    );
    await approveExpense(created.expenseId, {
      ...manager2,
      isOwner: true,
    });
    await db()
      .update(s.receipts)
      .set({ amount: "401.00" })
      .where(eq(s.receipts.id, created.receiptId!));

    const listed = await listExpenses({ fundingKind: "NON_CASH", q: "الفني" });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0].fundingKind).toBe("NON_CASH");
    expect(listed.rows[0].integrityWarnings).toContain(
      "RECEIPT_AMOUNT_MISMATCH",
    );
    expect(listed.rows[0].needsAudit).toBe(true);
    expect(listed.totals).toMatchObject({ nonCash: "400.00", needsAudit: 1 });
  });

  it.skip.each([
    {
      label: "طلب شحن معلّق",
      input: {
        kind: "PURCHASE_SHIPPING",
        approvalStatus: "PENDING_APPROVAL",
      } as const,
    },
    {
      label: "طلب صيانة مرفوض",
      input: {
        kind: "ASSET_MAINTENANCE",
        approvalStatus: "REJECTED",
      } as const,
    },
  ])(
    "إلغاء $label بعكس استحقاق صحيح لا يولّد إنذاراً كاذباً في القائمة أو الأثر",
    async ({ input }) => {
      const { expenseId } = await recognizedUnsettledExpense(input);

      const listed = await listExpenses({ status: "CANCELLED" });
      expect(listed.rows).toHaveLength(1);
      expect(listed.rows[0]).toMatchObject({
        id: expenseId,
        status: "CANCELLED",
        receiptStatus: "REVERSED",
        receiptApprovalStatus: input.approvalStatus,
        integrityWarnings: [],
        needsAudit: false,
      });
      expect(listed.totals).toMatchObject({
        needsAudit: 0,
        missingPayee: 0,
        sourceMismatch: 0,
      });

      const trace = await getExpenseTrace(expenseId, { branchId: 1 });
      expect(trace?.expense).toMatchObject({
        id: expenseId,
        integrityWarnings: [],
        needsAudit: false,
      });
    },
  );

  it.skip("يبقي التحذير إذا عُبث بعكس استحقاق مصروف ملغى غير مدفوع", async () => {
    const { expenseId } = await recognizedUnsettledExpense({
      kind: "PURCHASE_SHIPPING",
      approvalStatus: "PENDING_APPROVAL",
    });
    await db()
      .update(s.accountingEntries)
      .set({ amount: "-399.00" })
      .where(
        eq(
          s.accountingEntries.dedupeKey,
          `EXPENSE_ACCRUAL_CANCEL:${expenseId}`,
        ),
      );

    const listed = await listExpenses({ status: "CANCELLED" });
    expect(listed.rows[0].integrityWarnings).toContain("RECEIPT_NOT_APPROVED");
    expect(listed.rows[0].needsAudit).toBe(true);
    expect(listed.totals).toMatchObject({ needsAudit: 1, sourceMismatch: 1 });

    const trace = await getExpenseTrace(expenseId, { branchId: 1 });
    expect(trace?.expense.integrityWarnings).toContain("RECEIPT_NOT_APPROVED");
    expect(trace?.expense.needsAudit).toBe(true);
  });
});

describe("0193 obligation-backed expense trace", () => {
  it("projects an immutable A<n> chain and fails the display closed when its suffix is tampered", async () => {
    await db().insert(s.receipts).values([
      {
        id: 710,
        branchId: 1,
        direction: "OUT",
        amount: "400.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: "شركة نقل الرافدين",
        description: "طلب دفع الشحن الأصلي",
        referenceNumber: "SHIP-91-ABCDEF0123456789",
        voucherNumber: "PV-710",
        status: "FAILED",
        approvalStatus: "REJECTED",
        createdBy: manager1.userId,
        approvedBy: manager2.userId,
        approvedAt: new Date("2026-08-15T08:00:00.000Z"),
      },
      {
        id: 711,
        branchId: 1,
        direction: "OUT",
        amount: "400.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: "شركة نقل الرافدين",
        description: "إعادة تقديم الشحن — المحاولة A1 بعد السند #710: أُرفقت فاتورة النقل المصححة",
        referenceNumber: "SHIP-91-ABCDEF0123456789",
        voucherNumber: "PV-711",
        status: "FAILED",
        approvalStatus: "REJECTED",
        createdBy: manager1.userId,
        approvedBy: manager2.userId,
        approvedAt: new Date("2026-08-15T09:00:00.000Z"),
      },
      {
        id: 712,
        branchId: 1,
        direction: "OUT",
        amount: "400.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        counterpartyName: "شركة نقل الرافدين",
        description: "إعادة تقديم الشحن — المحاولة A2 بعد السند #711: ثُبت مرجع الناقل النهائي",
        referenceNumber: "SHIP-91-ABCDEF0123456789",
        voucherNumber: "PV-712",
        status: "PENDING",
        approvalStatus: "PENDING_APPROVAL",
        createdBy: manager1.userId,
      },
    ]);
    await db().insert(s.idempotencyKeys).values([
      {
        operation: "voucher.create",
        clientRequestId: "system-expense-resubmit-710-A1",
        refId: 711,
      },
      {
        operation: "voucher.create",
        clientRequestId: "system-expense-resubmit-710-A2",
        refId: 712,
      },
    ]);

    const listed = await listVouchers({ limit: 10 });
    expect(listed.find((row) => Number(row.id) === 712)).toMatchObject({
      resubmitLineageStatus: "VALID",
      resubmitRootReceiptId: 710,
      resubmitAttempt: 2,
      resubmitPriorReceiptId: 711,
      resubmitReason: "ثُبت مرجع الناقل النهائي",
    });

    await db().update(s.receipts)
      .set({ description: "إعادة تقديم الشحن — المحاولة A2 بعد السند #710: عُبث بالسند السابق" })
      .where(eq(s.receipts.id, 712));
    expect((await listVouchers({ limit: 10 })).find((row) => Number(row.id) === 712)).toMatchObject({
      resubmitLineageStatus: "BROKEN",
      resubmitRootReceiptId: 710,
      resubmitAttempt: 2,
      resubmitPriorReceiptId: null,
      resubmitReason: null,
    });
  });

  it("links recognition, settlement, and correction review to the expense source without a receipt shortcut", async () => {
    await db().insert(s.purchaseOrders).values({
      id: 91,
      poNumber: "TRACE-PO-0193",
      supplierId: 1,
      branchId: 1,
      subtotal: "0.00",
      shippingCost: "400.00",
      customsCost: "0.00",
      total: "0.00",
      status: "RECEIVED",
      createdBy: manager1.userId,
    });
    await db().insert(s.receipts).values({
      id: 701,
      branchId: 1,
      cashBucket: "TREASURY",
      direction: "OUT",
      amount: "400.00",
      paymentMethod: "CASH",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      referenceNumber: "SHIP-TRACE-0193",
      partyType: "OTHER",
      counterpartyName: "شركة نقل الرافدين",
      createdBy: manager1.userId,
      approvedBy: manager2.userId,
      approvedAt: new Date("2026-08-15T09:00:00.000Z"),
    });
    await db().insert(s.expenses).values({
      id: 801,
      branchId: 1,
      shiftId: null,
      cashBucket: null,
      expenseDate: new Date("2026-08-14T00:00:00.000Z"),
      category: "TRANSPORT",
      amount: "400.00",
      paymentMethod: "ACCRUAL",
      source: "ACCRUAL",
      description: "شحن أمر شراء مثبت ومستحق",
      referenceNumber: "SHIP-TRACE-0193",
      payee: "شركة نقل الرافدين",
      receiptId: null,
      status: "ACTIVE",
      createdBy: manager1.userId,
    });
    await db().insert(s.accountingEntries).values([
      {
        id: 901,
        entryType: "ADJUST",
        postingProfile: "ADJUST_EXPENSE_ACCRUAL",
        branchId: 1,
        purchaseOrderId: 91,
        receiptId: null,
        amount: "400.00",
        entryDate: new Date("2026-08-14T00:00:00.000Z"),
        dedupeKey: "PURCHASE_SHIPPING_ACCRUAL:91:trace0193",
      },
      {
        id: 902,
        entryType: "PAYMENT_OUT",
        postingProfile: "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
        branchId: 1,
        purchaseOrderId: 91,
        receiptId: 701,
        amount: "400.00",
        entryDate: new Date("2026-08-15T00:00:00.000Z"),
        dedupeKey: "ACCRUAL:SETTLEMENT:601:701",
      },
    ]);
    await db().insert(s.accrualObligations).values({
      id: 601,
      kind: "PURCHASE_SHIPPING",
      branchId: 1,
      expenseId: 801,
      purchaseOrderId: 91,
      sourceKey: "PURCHASE_SHIPPING_ACCRUAL:91:trace0193",
      recognizedAmount: "400.00",
      status: "PAID",
      beneficiaryType: "OTHER",
      beneficiaryName: "شركة نقل الرافدين",
      evidenceReference: "SHIP-INVOICE-0193",
      plannedPaymentMethod: "CASH",
      clientRequestId: "trace-obligation-0193",
      sourceHash: "a".repeat(64),
      recognizedBy: manager1.userId,
      recognizedAt: new Date("2026-08-14T09:00:00.000Z"),
    });
    await db().insert(s.accrualObligationEvents).values([
      {
        obligationId: 601,
        eventType: "RECOGNIZED",
        amount: "400.00",
        accountingEntryId: 901,
        evidenceReference: "SHIP-INVOICE-0193",
        actorId: manager1.userId,
        dedupeKey: "TRACE:RECOGNIZED:601",
      },
      {
        obligationId: 601,
        eventType: "PAYMENT_REQUESTED",
        amount: "400.00",
        receiptId: 701,
        evidenceReference: "SHIP-INVOICE-0193",
        actorId: manager1.userId,
        dedupeKey: "TRACE:PAYMENT_REQUESTED:601",
      },
      {
        obligationId: 601,
        eventType: "PAYMENT_SETTLED",
        amount: "400.00",
        receiptId: 701,
        accountingEntryId: 902,
        evidenceReference: "SHIP-INVOICE-0193",
        actorId: manager1.userId,
        reviewerId: manager2.userId,
        dedupeKey: "TRACE:PAYMENT_SETTLED:601",
      },
      {
        obligationId: 601,
        eventType: "CORRECTION_REQUESTED",
        amount: "400.00",
        evidenceReference: "CREDIT-NOTE-REVIEW-0193",
        actorId: manager1.userId,
        dedupeKey: "TRACE:CORRECTION_REQUESTED:601",
      },
      {
        obligationId: 601,
        eventType: "CORRECTION_REJECTED",
        amount: "400.00",
        evidenceReference: "المستند لا يطابق المصدر",
        actorId: manager1.userId,
        reviewerId: manager2.userId,
        dedupeKey: "TRACE:CORRECTION_REJECTED:601",
      },
    ]);
    await db().insert(s.accrualCorrectionRequests).values({
      id: 501,
      obligationId: 601,
      status: "REJECTED",
      previousObligationStatus: "PAID",
      reason: "مراجعة إشعار دائن",
      externalEvidenceReference: "CREDIT-NOTE-REVIEW-0193",
      attachmentUrl: "data:image/png;base64,QUJD",
      clientRequestId: "trace-correction-0193",
      payloadHash: "b".repeat(64),
      requestedBy: manager1.userId,
      reviewedBy: manager2.userId,
      rejectionReason: "المستند لا يطابق المصدر",
      reviewedAt: new Date("2026-08-15T10:00:00.000Z"),
    });

    const listed = await listExpenses({ fundingKind: "ACCRUED_PAID" });
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]).toMatchObject({
      id: 801,
      fundingKind: "ACCRUED_PAID",
      receiptId: null,
      linkedReceiptId: 701,
      settlementStatus: "PAID",
      beneficiaryName: "شركة نقل الرافدين",
      evidenceReference: "SHIP-INVOICE-0193",
      needsAudit: false,
    });
    const trace = await getExpenseTrace(801, { branchId: 1 });
    const eventIds = trace?.obligationEvents.map((event) => Number(event.id)) ?? [];
    expect(eventIds).toEqual([...eventIds].sort((left, right) => left - right));
    expect(trace?.obligationEvents.map((event) => event.eventType)).toEqual([
      "RECOGNIZED",
      "PAYMENT_REQUESTED",
      "PAYMENT_SETTLED",
      "CORRECTION_REQUESTED",
      "CORRECTION_REJECTED",
    ]);
    const ledgerIds = trace?.ledgerEntries.map((entry) => Number(entry.id)) ?? [];
    expect(ledgerIds).toEqual([...ledgerIds].sort((left, right) => left - right));
    expect(trace?.ledgerEntries.map((entry) => entry.postingProfile)).toEqual([
      "ADJUST_EXPENSE_ACCRUAL",
      "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
    ]);
    expect(trace?.correctionRequests).toEqual([
      expect.objectContaining({
        id: 501,
        status: "REJECTED",
        externalEvidenceReference: "CREDIT-NOTE-REVIEW-0193",
        requestedBy: manager1.userId,
        reviewedBy: manager2.userId,
      }),
    ]);
  });
});

describe.skip("legacy receipt-linked recognized source integrity (superseded by 0193 obligations)", () => {
  it("keeps a rejected then resubmitted cancellation clean through its system chain", async () => {
    const { expenseId, receiptId, originalReceiptId } = await recognizedUnsettledExpense(
      { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
      { resubmit: true },
    );
    expect(receiptId).not.toBe(originalReceiptId);

    const listed = await listExpenses({ status: "CANCELLED" });
    expect(listed.rows[0]).toMatchObject({
      id: expenseId,
      createdBy: manager1.userId,
      receiptCreatedBy: manager2.userId,
      receiptStatus: "REVERSED",
      receiptApprovalStatus: "PENDING_APPROVAL",
      integrityWarnings: [],
      needsAudit: false,
    });
    expect(listed.totals).toMatchObject({ needsAudit: 0, sourceMismatch: 0 });
    expect((await getExpenseTrace(expenseId, { branchId: 1 }))?.expense).toMatchObject({
      integrityWarnings: [],
      needsAudit: false,
    });
  });

  it.each(sourceTamperCases)(
    "fails closed before cancellation when $label is tampered",
    async ({ input, options, mutate }) => {
      const result = await recognizedUnsettledExpense(input, { ...options, cancel: false });
      await mutate(result);

      await expect(cancelExpense(result.expenseId, manager2)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      const [expense] = await db()
        .select({ status: s.expenses.status })
        .from(s.expenses)
        .where(eq(s.expenses.id, result.expenseId));
      const [receipt] = await db()
        .select({ status: s.receipts.status })
        .from(s.receipts)
        .where(eq(s.receipts.id, result.receiptId));
      expect(expense.status).toBe("ACTIVE");
      expect(receipt.status).not.toBe("REVERSED");
    },
  );

  it.each(sourceTamperCases)(
    "keeps list, trace and totals in audit state when $label is tampered after cancellation",
    async ({ input, options, mutate }) => {
      const result = await recognizedUnsettledExpense(input, options);
      await mutate(result);

      const listed = await listExpenses({ status: "CANCELLED" });
      expect(listed.rows[0].integrityWarnings).toContain("RECEIPT_NOT_APPROVED");
      expect(listed.rows[0].needsAudit).toBe(true);
      expect(listed.totals).toMatchObject({ needsAudit: 1, sourceMismatch: 1 });

      const trace = await getExpenseTrace(result.expenseId, { branchId: 1 });
      expect(trace?.expense.integrityWarnings).toContain("RECEIPT_NOT_APPROVED");
      expect(trace?.expense.needsAudit).toBe(true);
    },
  );

  it("rejects a forged materialized system expense before creating any cancellation artifact", async () => {
    const result = await recognizedUnsettledExpense(
      { kind: "PURCHASE_SHIPPING", approvalStatus: "PENDING_APPROVAL" },
      { cancel: false },
    );
    const voucherDate = "2026-08-15";
    const voucherNumber = "PV-1-20260815-00401";
    await db().update(s.receipts).set({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      cashBucket: "TREASURY",
      approvedBy: manager2.userId,
      approvedAt: new Date("2026-08-15T09:00:00.000Z"),
      voucherDate,
      voucherNumber,
      signatureHash: null,
    }).where(eq(s.receipts.id, result.receiptId));

    await expect(cancelExpense(result.expenseId, manager2)).rejects.toMatchObject({ code: "CONFLICT" });

    const forgedSignature = computeSignature({
      id: result.receiptId,
      amount: result.amount,
      partyType: "OTHER",
      partyId: null,
      paymentMethod: "CASH",
      voucherDate,
      voucherNumber,
      createdBy: manager1.userId,
      approvedBy: manager2.userId,
      branchId: 1,
    });
    await db().update(s.receipts).set({ signatureHash: forgedSignature }).where(eq(s.receipts.id, result.receiptId));
    await tamperSystemRequest(result.receiptId, { purchaseOrderId: 999999 });

    await expect(cancelExpense(result.expenseId, manager2)).rejects.toMatchObject({ code: "CONFLICT" });
    const [expense] = await db().select().from(s.expenses).where(eq(s.expenses.id, result.expenseId));
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, result.receiptId));
    expect(expense.status).toBe("ACTIVE");
    expect(receipt.status).toBe("COMPLETED");
    expect(await db().select().from(s.receipts).where(
      eq(s.receipts.referenceNumber, `CANCEL-EXP-${result.expenseId}`),
    )).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries).where(
      eq(s.accountingEntries.dedupeKey, `EXPENSE_ACCRUAL_CANCEL:${result.expenseId}`),
    )).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries).where(
      eq(s.accountingEntries.entryType, "PAYMENT_IN"),
    )).toHaveLength(0);
  });

  it("refuses resubmission when only the non-unique reference matches the expense", async () => {
    const result = await recognizedUnsettledExpense(
      { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
      { cancel: false },
    );
    await db().update(s.expenses).set({ receiptId: null }).where(eq(s.expenses.id, result.expenseId));

    await expect(
      resubmitRejectedExpensePayment(result.originalReceiptId, manager2, {
        note: "BROKEN-EDGE",
        priorReceiptId: result.originalReceiptId,
        reissueReason: "اختبار رابط مصدر مكسور",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.idempotencyKeys)).toHaveLength(0);
    expect(await db().select().from(s.receipts).where(
      eq(s.receipts.approvalStatus, "PENDING_APPROVAL"),
    )).toHaveLength(0);
  });

  it("replays the same rejected-expense resubmission without creating a second child", async () => {
    const result = await recognizedUnsettledExpense(
      { kind: "ASSET_MAINTENANCE", approvalStatus: "REJECTED" },
      { cancel: false },
    );
    const first = await resubmitRejectedExpensePayment(result.originalReceiptId, manager2, {
      note: "REPLAY",
      priorReceiptId: result.originalReceiptId,
      reissueReason: "إعادة محاولة اختبارية مثبتة",
    });
    const second = await resubmitRejectedExpensePayment(result.originalReceiptId, manager2, {
      note: "REPLAY",
      priorReceiptId: result.originalReceiptId,
      reissueReason: "إعادة محاولة اختبارية مثبتة",
    });

    expect(second).toEqual(first);
    const pending = await db().select().from(s.receipts).where(
      eq(s.receipts.approvalStatus, "PENDING_APPROVAL"),
    );
    expect(pending).toHaveLength(1);
    expect(Number(pending[0].id)).toBe(first.receiptId);
    expect(await db().select().from(s.idempotencyKeys).where(
      eq(s.idempotencyKeys.clientRequestId, `system-expense-resubmit-${result.originalReceiptId}`),
    )).toHaveLength(1);
    const [expense] = await db().select().from(s.expenses).where(eq(s.expenses.id, result.expenseId));
    expect(Number(expense.receiptId)).toBe(first.receiptId);
  });
});
