import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getArApAgingDetail } from "../reportsAgingDetailService";
import { getCashFlow, getFinancialPosition, getProfitAndLoss } from "../reportsFinancialService";
import { getSalesRegister } from "../reportsSalesService";
import { getCustomerStatement } from "../reportsService";
import { getARAging } from "../reports/arAging";
import { createPostingIntent, createPostingIntentEvidence, debitLine, creditLine } from "../accounting/postingEngine";
import { encodeSystemPaymentRequest } from "../voucher/create";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "inventoryValuationSnapshots", "financialPeriods", "expenses", "voucherCategories",
  "journalLines", "journalEntries", "doubleEntrySettings",
  "employeeAdvanceRepaymentAllocations", "employeeAdvanceRepaymentRequests",
  "terminationAdvanceAllocations", "advanceSettlements", "employeeAdvances", "employeeTerminations",
  "payrollAccountingEvents", "payrollObligationAllocations", "payrollObligations",
  "payrollRemittanceRequests", "payrollItems", "payrollRuns",
  "accountingEntries", "receipts", "invoiceItems", "invoices",
  "digitalWalletTransactions", "digitalWallets", "digitalProviders",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productVariants",
  "products", "customers", "suppliers", "employees", "users", "branches",
];

beforeEach(async () => {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await db().insert(s.branches).values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "financial-reports", name: "مدير", role: "manager", loginMethod: "local" });
});

describe.sequential("سلامة مصادر التقارير المالية", () => {
  it("لا يحسب السند المعلّق نقداً، ويفصل البطاقة، ولا يخفي ذمة طرف غير نشط", async () => {
    await db().insert(s.customers).values({
      id: 1, name: "inactive debtor", isActive: false, currentBalance: "100.00",
    });
    await db().insert(s.receipts).values([
      {
        branchId: 1, direction: "IN", amount: "750000.00", paymentMethod: "CASH",
        status: "COMPLETED", approvalStatus: "PENDING_APPROVAL",
      },
      {
        branchId: 1, direction: "IN", amount: "100.00", paymentMethod: "CASH",
        status: "COMPLETED", approvalStatus: "APPROVED",
      },
      {
        branchId: 1, direction: "IN", amount: "200.00", paymentMethod: "CARD",
        status: "COMPLETED", approvalStatus: "APPROVED",
      },
    ]);

    const pos = await getFinancialPosition({ verify: false });
    expect(pos.cash).toBe("100.00");
    expect(pos.card).toBe("200.00");
    expect(pos.arDebit).toBe("100.00");
    expect(pos.totalAssets).toBe("400.00");
    const aging = await getARAging();
    expect(aging).toHaveLength(1);
    expect(aging[0].currentBalance).toBe("100.00");
    const flow = await getCashFlow({ from: "2000-01-01", to: "2099-12-31" });
    expect(flow.totalIn).toBe("300.00");
  });

  it("سجل المبيعات يصفي الإيراد والتكلفة بعد مرتجع كامل معاد للمخزون", async () => {
    await db().insert(s.products).values({ id: 1, name: "item" });
    await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "SKU", costPrice: "60.00" });
    await db().insert(s.invoices).values({
      id: 1, invoiceNumber: "INV-1", sourceType: "POS", branchId: 1,
      invoiceDate: new Date("2026-07-10T10:00:00Z"), subtotal: "100.00",
      total: "100.00", costTotal: "60.00", returnedTotal: "100.00", status: "RETURNED",
    });
    await db().insert(s.invoiceItems).values({
      invoiceId: 1, variantId: 1, quantity: "1", baseQuantity: 1,
      unitPrice: "100.00", unitCost: "60.00", total: "100.00",
      returnedBaseQuantity: 1, returnedRestockedBaseQuantity: 1,
    });

    const report = await getSalesRegister({ from: "2026-07-10", to: "2026-07-10" });
    expect(report.totals.revenue).toBe("0.00");
    expect(report.totals.cost).toBe("0.00");
    expect(report.totals.profit).toBe("0.00");
  });

  it("كشف العميل يستبعد السند المعلّق ويعرض قيد المرتجع الائتماني", async () => {
    await db().insert(s.customers).values({ id: 1, name: "customer", currentBalance: "60.00" });
    await db().insert(s.invoices).values({
      id: 1, invoiceNumber: "INV-1", sourceType: "ORDER", branchId: 1, customerId: 1,
      invoiceDate: new Date("2026-07-10T10:00:00Z"), subtotal: "100.00",
      total: "100.00", returnedTotal: "40.00", status: "PARTIALLY_PAID",
    });
    await db().insert(s.accountingEntries).values({
      entryType: "RETURN", branchId: 1, invoiceId: 1, customerId: 1,
      revenue: "-40.00", cost: "0.00", profit: "-40.00", amount: "-40.00",
      entryDate: new Date("2026-07-11"),
    });
    await db().insert(s.receipts).values({
      invoiceId: 1, branchId: 1, direction: "IN", amount: "50.00", paymentMethod: "CASH",
      status: "COMPLETED", approvalStatus: "PENDING_APPROVAL",
    });

    const stmt = await getCustomerStatement(1, { from: "2026-07-01", to: "2026-07-31" });
    expect(stmt?.payments).toHaveLength(1);
    expect(stmt?.payments[0].paymentMethod).toBe("RETURN");
    expect(stmt?.payments[0].amount).toBe("40.00");
  });

  it("تفصيل AP يطرح مرتجع الشراء مثل الملخص", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "supplier", currentBalance: "60.00" });
    await db().insert(s.purchaseOrders).values({
      id: 1, poNumber: "PO-1", supplierId: 1, branchId: 1,
      orderDate: new Date("2026-07-01T10:00:00Z"), subtotal: "100.00",
      total: "100.00", status: "RECEIVED",
    });
    await db().insert(s.accountingEntries).values([
      {
        entryType: "PURCHASE", branchId: 1, purchaseOrderId: 1, supplierId: 1,
        amount: "100.00", cost: "100.00", entryDate: new Date("2026-07-01"),
      },
      {
        entryType: "RETURN", branchId: 1, purchaseOrderId: 1, supplierId: 1,
        amount: "-40.00", cost: "-40.00", entryDate: new Date("2026-07-02"),
      },
    ]);

    const detail = await getArApAgingDetail({ side: "AP", branchId: 1 });
    expect(detail.rows).toHaveLength(1);
    expect(detail.rows[0].unpaid).toBe("60.00");
  });

  it("يعترف بتكلفة الرواتب من أحداث الاستحقاق الموقعة ويستبعد دفع الصافي والتحويلات", async () => {
    await db().insert(s.accountingEntries).values([
      {
        id: 900, entryType: "ADJUST", branchId: 1, amount: "100.00",
        entryDate: new Date("2026-06-30"), dedupeKey: "PAYROLL:ACCRUAL:1:0:1",
      },
      {
        id: 901, entryType: "ADJUST", branchId: 1, amount: "-100.00",
        entryDate: new Date("2026-07-15"), dedupeKey: "PAYROLL:ACCRUAL-REV:1:0:1",
      },
      {
        id: 902, entryType: "PAYMENT_OUT", branchId: 1, amount: "900.00",
        entryDate: new Date("2026-07-15"), dedupeKey: "PAYROLL:1:1",
      },
    ]);
    await db().insert(s.payrollAccountingEvents).values([
      {
        id: 900, branchIdSnapshot: 1, revisionNo: 0, eventKind: "ACCRUAL",
        accountingEntryId: 900, sourceKey: "PAYROLL:ACCRUAL:1:0:1", sourceHash: "a".repeat(64),
        occurredAt: new Date("2026-06-30T12:00:00Z"), createdBy: 1,
      },
      {
        id: 901, branchIdSnapshot: 1, revisionNo: 0, eventKind: "ACCRUAL_REVERSAL",
        accountingEntryId: 901, reversalOfId: 900, sourceKey: "PAYROLL:ACCRUAL-REV:1:0:1", sourceHash: "b".repeat(64),
        occurredAt: new Date("2026-07-15T12:00:00Z"), createdBy: 1,
      },
      {
        id: 902, branchIdSnapshot: 1, revisionNo: 0, eventKind: "SALARY_PAYMENT",
        accountingEntryId: 902, sourceKey: "PAYROLL:1:1", sourceHash: "c".repeat(64),
        occurredAt: new Date("2026-07-15T12:00:00Z"), createdBy: 1,
      },
    ]);
    const pl = await getProfitAndLoss({ from: "2026-07-01", to: "2026-07-31" });
    expect(pl.current.expenseLines.find((x) => x.key === "PAYROLL")?.amount).toBe("-100.00");
    expect(pl.current.totalExpenses).toBe("-100.00");
    expect(pl.current.netProfit).toBe("100.00");
  });

  it.each(["ACTIVE", "SHADOW"] as const)("يعرض خصوم الرواتب في %s من صافي دائن أدوار اليومية مع التاريخ والفرع", async (mode) => {
    const cycleId = "payroll-position-cycle";
    await db().insert(s.branches).values({ id: 2, name: "SALES", code: "SALES", type: "SALES" });
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode, shadowCycleId: cycleId });
    await db().insert(s.accountingEntries).values([
      { id: 920, entryType: "ADJUST", branchId: 1, amount: "1000.00", entryDate: new Date("2026-07-31") },
      { id: 921, entryType: "PAYMENT_OUT", branchId: 1, amount: "520.00", entryDate: new Date("2026-08-01") },
      { id: 922, entryType: "ADJUST", branchId: 2, amount: "999.00", entryDate: new Date("2026-07-31") },
    ]);
    await db().insert(s.journalEntries).values([
      { id: 920, entryId: 920, cycleId, entryDate: "2026-07-31", branchId: 1, status: "POSTED" },
      { id: 921, entryId: 921, cycleId, entryDate: "2026-08-01", branchId: 1, status: "POSTED" },
      { id: 922, entryId: 922, cycleId, entryDate: "2026-07-31", branchId: 2, status: "POSTED" },
    ]);
    await db().insert(s.journalLines).values([
      { journalId: 920, role: "ACCRUED_SALARY", debit: "0.00", credit: "700.00" },
      { journalId: 920, role: "PAYROLL_TAX_PAYABLE", debit: "0.00", credit: "50.00" },
      { journalId: 920, role: "SOCIAL_SECURITY_PAYABLE", debit: "0.00", credit: "100.00" },
      { journalId: 920, role: "EOS_PROVISION", debit: "0.00", credit: "150.00" },
      // تسوية لاحقة: الرصيد الطبيعي = الدائن − المدين، لا مجموعٌ مطلق ولا حالة المسيّر.
      { journalId: 921, role: "ACCRUED_SALARY", debit: "500.00", credit: "0.00" },
      { journalId: 921, role: "PAYROLL_TAX_PAYABLE", debit: "20.00", credit: "0.00" },
      { journalId: 922, role: "ACCRUED_SALARY", debit: "0.00", credit: "999.00" },
    ]);

    const july = await getFinancialPosition({ branchId: 1, asOf: "2026-07-31", verify: false });
    expect(july.accruedSalaryLiability).toBe("700.00");
    expect(july.payrollTaxPayable).toBe("50.00");
    expect(july.socialSecurityPayable).toBe("100.00");
    expect(july.eosProvision).toBe("150.00");
    expect(july.totalLiabilities).toBe("1000.00");

    const current = await getFinancialPosition({ branchId: 1, verify: false });
    expect(current.accruedSalaryLiability).toBe("200.00");
    expect(current.payrollTaxPayable).toBe("30.00");
    expect(current.totalLiabilities).toBe("480.00");
  });

  it("يعرض خصوم الرواتب في OFF من باقي دفتر الالتزامات ولا يسقطها إلى صفر", async () => {
    await db().insert(s.employees).values({
      id: 70, branchId: 1, firstName: "موظف", lastName: "التزام", employmentStatus: "active", isActive: true,
    });
    await db().insert(s.payrollRuns).values({ id: 70, period: "2026-07", status: "approved", revisionNo: 0 });
    await db().insert(s.payrollItems).values({ id: 70, runId: 70, employeeId: 70, revisionNo: 0, payType: "monthly" });
    await db().insert(s.payrollObligations).values([
      { id: 700, runId: 70, itemId: 70, employeeId: 70, branchIdSnapshot: 1, revisionNo: 0, kind: "SALARY_NET", originalAmount: "700.00", remainingAmount: "200.00", dueDate: "2026-07-31", status: "PARTIAL", sourceType: "PAYROLL_APPROVAL", sourceKey: "OFF:SALARY" },
      { id: 701, runId: 70, itemId: 70, employeeId: 70, branchIdSnapshot: 1, revisionNo: 0, kind: "INCOME_TAX", originalAmount: "50.00", remainingAmount: "50.00", dueDate: "2026-07-31", status: "OPEN", sourceType: "PAYROLL_APPROVAL", sourceKey: "OFF:TAX" },
      { id: 702, runId: 70, itemId: 70, employeeId: 70, branchIdSnapshot: 1, revisionNo: 0, kind: "SOCIAL_SECURITY", originalAmount: "100.00", remainingAmount: "100.00", dueDate: "2026-07-31", status: "OPEN", sourceType: "PAYROLL_APPROVAL", sourceKey: "OFF:SS" },
      { id: 703, runId: 70, itemId: 70, employeeId: 70, branchIdSnapshot: 1, revisionNo: 0, kind: "EOS_PROVISION", originalAmount: "150.00", remainingAmount: "150.00", dueDate: "2026-07-31", status: "OPEN", sourceType: "PAYROLL_APPROVAL", sourceKey: "OFF:EOS" },
    ]);
    await db().insert(s.accountingEntries).values({
      id: 930, entryType: "PAYMENT_OUT", branchId: 1, amount: "500.00", entryDate: new Date("2026-08-05"),
    });
    await db().insert(s.payrollAccountingEvents).values({
      id: 930, runId: 70, obligationId: 700, branchIdSnapshot: 1, revisionNo: 0,
      eventKind: "SALARY_PAYMENT", accountingEntryId: 930,
      sourceKey: "OFF:SALARY:PAY:930", sourceHash: "7".repeat(64),
      occurredAt: new Date("2026-08-05T12:00:00.000Z"), createdBy: 1,
    });
    await db().insert(s.payrollObligationAllocations).values({
      obligationId: 700, accountingEventId: 930, direction: "APPLY", amount: "500.00",
      sourceKey: "OFF:SALARY:ALLOC:930", occurredAt: new Date("2026-08-05T12:00:00.000Z"), createdBy: 1,
    });
    const july = await getFinancialPosition({ branchId: 1, asOf: "2026-07-31", verify: false });
    expect(july.accruedSalaryLiability).toBe("700.00");
    expect(july.totalLiabilities).toBe("1000.00");

    const pos = await getFinancialPosition({ branchId: 1, verify: false });
    expect(pos.accruedSalaryLiability).toBe("200.00");
    expect(pos.payrollTaxPayable).toBe("50.00");
    expect(pos.socialSecurityPayable).toBe("100.00");
    expect(pos.eosProvision).toBe("150.00");
    expect(pos.totalLiabilities).toBe("500.00");
  });

  it.each(["ACTIVE", "SHADOW"] as const)("يفصح عن مقاصة الفروع في %s ويصفرها في قائمة الشركة المجمعة", async (mode) => {
    await db().insert(s.branches).values({ id: 2, name: "SALES", code: "SALES", type: "SALES" });
    const cycleId = `interbranch-${mode.toLowerCase()}`;
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode, shadowCycleId: cycleId });
    await db().insert(s.accountingEntries).values([
      { id: 940, entryType: "ADJUST", branchId: 1, amount: "100.00", entryDate: new Date("2026-07-31") },
      { id: 941, entryType: "ADJUST", branchId: 2, amount: "100.00", entryDate: new Date("2026-07-31") },
    ]);
    await db().insert(s.journalEntries).values([
      { id: 940, entryId: 940, cycleId, entryDate: "2026-07-31", branchId: 1, status: "POSTED" },
      { id: 941, entryId: 941, cycleId, entryDate: "2026-07-31", branchId: 2, status: "POSTED" },
    ]);
    await db().insert(s.journalLines).values([
      { journalId: 940, role: "INTERBRANCH_CLEARING", debit: "0.00", credit: "100.00" },
      { journalId: 941, role: "INTERBRANCH_CLEARING", debit: "100.00", credit: "0.00" },
    ]);

    const source = await getFinancialPosition({ branchId: 1, asOf: "2026-07-31", verify: false });
    expect(source.dueFromBranches).toBe("0.00");
    expect(source.dueToBranches).toBe("100.00");
    expect(source.totalLiabilities).toBe("100.00");
    const destination = await getFinancialPosition({ branchId: 2, asOf: "2026-07-31", verify: false });
    expect(destination.dueFromBranches).toBe("100.00");
    expect(destination.dueToBranches).toBe("0.00");
    expect(destination.totalAssets).toBe("100.00");
    const company = await getFinancialPosition({ asOf: "2026-07-31", verify: false });
    expect(company.dueFromBranches).toBe("0.00");
    expect(company.dueToBranches).toBe("0.00");
  });

  it.each(["ACTIVE", "SHADOW"] as const)("يعرض سلف الموظفين في %s من صافي مدين دور اليومية حسب التاريخ والفرع", async (mode) => {
    await db().insert(s.branches).values({ id: 2, name: "SALES", code: "SALES", type: "SALES" });
    const cycleId = `advance-position-${mode.toLowerCase()}`;
    await db().insert(s.doubleEntrySettings).values({ id: 1, mode, shadowCycleId: cycleId });
    await db().insert(s.accountingEntries).values([
      { id: 950, entryType: "PAYMENT_OUT", branchId: 1, amount: "1000.00", entryDate: new Date("2026-07-01") },
      { id: 951, entryType: "ADJUST", branchId: 1, amount: "400.00", entryDate: new Date("2026-08-05") },
      { id: 952, entryType: "PAYMENT_OUT", branchId: 2, amount: "999.00", entryDate: new Date("2026-07-01") },
    ]);
    await db().insert(s.journalEntries).values([
      { id: 950, entryId: 950, cycleId, entryDate: "2026-07-01", branchId: 1, status: "POSTED" },
      { id: 951, entryId: 951, cycleId, entryDate: "2026-08-05", branchId: 1, status: "POSTED" },
      { id: 952, entryId: 952, cycleId, entryDate: "2026-07-01", branchId: 2, status: "POSTED" },
    ]);
    await db().insert(s.journalLines).values([
      { journalId: 950, role: "EMPLOYEE_ADVANCES", debit: "1000.00", credit: "0.00" },
      { journalId: 951, role: "EMPLOYEE_ADVANCES", debit: "0.00", credit: "400.00" },
      { journalId: 952, role: "EMPLOYEE_ADVANCES", debit: "999.00", credit: "0.00" },
    ]);

    const july = await getFinancialPosition({ branchId: 1, asOf: "2026-07-31", verify: false });
    expect(july.employeeAdvanceReceivable).toBe("1000.00");
    expect(july.totalAssets).toBe("1000.00");
    const current = await getFinancialPosition({ branchId: 1, verify: false });
    expect(current.employeeAdvanceReceivable).toBe("600.00");
    expect(current.totalAssets).toBe("600.00");
  });

  it("يعيد بناء سلف الموظفين تاريخياً في OFF من تخصيصات الرواتب والإنهاء وعكوسها", async () => {
    await db().insert(s.branches).values({ id: 2, name: "SALES", code: "SALES", type: "SALES" });
    await db().insert(s.employees).values({ id: 80, branchId: 1, firstName: "موظف", lastName: "سلفة", employmentStatus: "terminated", isActive: false });
    await db().insert(s.employeeAdvances).values([
      { id: 800, employeeId: 80, branchId: 1, amount: "1000.00", remaining: "900.00", status: "ACTIVE", createdBy: 1, grantedAt: new Date("2026-07-01T12:00:00Z") },
      { id: 801, employeeId: 80, branchId: 2, amount: "999.00", remaining: "999.00", status: "ACTIVE", createdBy: 1, grantedAt: new Date("2026-07-01T12:00:00Z") },
    ]);
    await db().insert(s.payrollRuns).values({ id: 80, period: "2026-07", status: "paid", revisionNo: 0 });
    await db().insert(s.advanceSettlements).values([
      { id: 800, runId: 80, advanceId: 800, employeeId: 80, amount: "200.00", revisionNo: 0, direction: "APPLY", sourceKey: "ADV:APPLY:800", occurredAt: new Date("2026-07-10T12:00:00Z"), createdBy: 1 },
      { id: 801, runId: 80, advanceId: 800, employeeId: 80, amount: "100.00", revisionNo: 0, direction: "REVERSE", reversalOfId: 800, sourceKey: "ADV:REV:800", occurredAt: new Date("2026-07-15T12:00:00Z"), createdBy: 1 },
    ]);
    await db().insert(s.employeeTerminations).values({ id: 80, employeeId: 80, terminationType: "RESIGNATION", lastDay: "2026-07-20", settlement: "0.00", earnedGrossWages: "300.00", advanceRecovery: "300.00", settlementEvidenceNote: "اختبار استرداد سلفة جزئي", zeroAmountsAttested: true, status: "completed", createdBy: 1 });
    await db().insert(s.accountingEntries).values([
      { id: 960, entryType: "ADJUST", branchId: 1, amount: "300.00", entryDate: new Date("2026-07-20") },
      { id: 961, entryType: "ADJUST", branchId: 1, amount: "-300.00", entryDate: new Date("2026-07-25") },
    ]);
    await db().insert(s.payrollAccountingEvents).values([
      { id: 960, terminationId: 80, branchIdSnapshot: 1, revisionNo: 0, eventKind: "EOS_SETTLEMENT", accountingEntryId: 960, sourceKey: "TERM:ADV:960", sourceHash: "9".repeat(64), occurredAt: new Date("2026-07-20T12:00:00Z"), createdBy: 1 },
      { id: 961, terminationId: 80, branchIdSnapshot: 1, revisionNo: 0, eventKind: "EOS_SETTLEMENT_REVERSAL", accountingEntryId: 961, reversalOfId: 960, sourceKey: "TERM:ADV:961", sourceHash: "8".repeat(64), occurredAt: new Date("2026-07-25T12:00:00Z"), createdBy: 1 },
    ]);
    await db().insert(s.terminationAdvanceAllocations).values([
      { id: 810, terminationId: 80, advanceId: 800, accountingEventId: 960, direction: "APPLY", amount: "300.00", sourceKey: "TERM:ADV:APPLY:810", occurredAt: new Date("2026-07-20T12:00:00Z"), createdBy: 1 },
      { id: 811, terminationId: 80, advanceId: 800, accountingEventId: 961, direction: "REVERSE", amount: "300.00", reversalOfId: 810, sourceKey: "TERM:ADV:REV:810", occurredAt: new Date("2026-07-25T12:00:00Z"), createdBy: 1 },
    ]);
    await db().insert(s.receipts).values([
      { id: 970, branchId: 1, direction: "IN", amount: "200.00", paymentMethod: "TRANSFER", referenceNumber: "ADV-REPAY-970", voucherDate: "2026-07-28", status: "COMPLETED", approvalStatus: "PENDING_APPROVAL" },
      { id: 971, branchId: 1, direction: "OUT", amount: "200.00", paymentMethod: "TRANSFER", referenceNumber: "ADV-RETURN-971", voucherDate: "2026-08-03", status: "COMPLETED", approvalStatus: "PENDING_APPROVAL" },
    ]);
    await db().insert(s.accountingEntries).values([
      { id: 970, entryType: "PAYMENT_IN", branchId: 1, receiptId: 970, amount: "200.00", entryDate: new Date("2026-07-28") },
      { id: 971, entryType: "PAYMENT_OUT", branchId: 1, receiptId: 971, amount: "200.00", entryDate: new Date("2026-08-03") },
    ]);
    await db().insert(s.employeeAdvanceRepaymentRequests).values([
      {
        id: 820, requestKind: "REPAYMENT", status: "APPROVED", employeeId: 80, branchId: 1,
        amount: "200.00", paymentMethod: "TRANSFER", referenceNumber: "ADV-REPAY-970",
        transactionDate: "2026-07-28", evidenceNote: "اختبار قبض سداد مستقل موثق",
        clientRequestId: "adv-repay-db-820", sourceKey: "ADV:REPAY:820",
        sourceHash: "7".repeat(64), evidenceHash: "6".repeat(64), receiptId: 970,
        accountingEntryId: 970, createdBy: 1, reviewedBy: 1, reviewedAt: new Date("2026-07-28T12:00:00Z"),
      },
      {
        id: 821, requestKind: "RETURN", status: "APPROVED", employeeId: 80, branchId: 1,
        originalRequestId: 820, amount: "200.00", paymentMethod: "TRANSFER", referenceNumber: "ADV-RETURN-971",
        transactionDate: "2026-08-03", evidenceNote: "اختبار إعادة قبض السداد المستقل موثق",
        clientRequestId: "adv-return-db-821", sourceKey: "ADV:RETURN:821",
        sourceHash: "5".repeat(64), evidenceHash: "4".repeat(64), receiptId: 971,
        accountingEntryId: 971, createdBy: 1, reviewedBy: 1, reviewedAt: new Date("2026-08-03T12:00:00Z"),
      },
    ]);
    await db().insert(s.employeeAdvanceRepaymentAllocations).values([
      { id: 820, requestId: 820, advanceId: 800, direction: "APPLY", amount: "200.00", receiptId: 970, accountingEntryId: 970, sourceKey: "ADV:REPAY:ALLOC:820", occurredAt: new Date("2026-07-28T12:00:00Z"), createdBy: 1 },
      { id: 821, requestId: 821, advanceId: 800, direction: "REVERSE", amount: "200.00", reversalOfId: 820, receiptId: 971, accountingEntryId: 971, sourceKey: "ADV:RETURN:ALLOC:821", occurredAt: new Date("2026-08-03T12:00:00Z"), createdBy: 1 },
    ]);

    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-05", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "1000.00", totalAssets: "1000.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-12", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "800.00", totalAssets: "800.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-18", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "900.00", totalAssets: "900.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-22", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "600.00", totalAssets: "600.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-27", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "900.00", totalAssets: "900.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-31", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "700.00", totalAssets: "700.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-08-02", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "700.00", totalAssets: "700.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-08-05", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "900.00", totalAssets: "900.00" });
    await expect(getFinancialPosition({ branchId: 2, asOf: "2026-08-05", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "999.00", totalAssets: "999.00" });
  });

  it("يصفر السلفة الملغاة في OFF من تاريخ الإلغاء ويبقيها قبل ذلك التاريخ", async () => {
    await db().insert(s.employees).values({ id: 81, branchId: 1, firstName: "موظف", lastName: "إلغاء", employmentStatus: "active", isActive: true });
    await db().insert(s.employeeAdvances).values({
      id: 802, employeeId: 81, branchId: 1, amount: "300.00", remaining: "300.00",
      status: "CANCELLED", createdBy: 1, grantedAt: new Date("2026-07-01T12:00:00Z"),
      updatedAt: new Date("2026-07-10T12:00:00Z"),
    });

    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-09", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "300.00", totalAssets: "300.00" });
    await expect(getFinancialPosition({ branchId: 1, asOf: "2026-07-10", verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "0.00", totalAssets: "0.00" });
    await expect(getFinancialPosition({ branchId: 1, verify: false })).resolves.toMatchObject({ employeeAdvanceReceivable: "0.00", totalAssets: "0.00" });
  });

  it("يعرض رصيد محافظ المزوّدين أصلاً ولو كانت المحفظة معطلة ويعيد بناءه تاريخياً", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مزود بطاقات" });
    await db().insert(s.digitalProviders).values({
      id: 1,
      supplierId: 1,
      providerType: "TELECOM",
      settlementMode: "PREPAID",
      recognitionMode: "PRINCIPAL_GROSS",
      referencePolicy: "OPTIONAL",
      settlementCycle: "ON_DEMAND",
      createdBy: 1,
    });
    await db().insert(s.digitalWallets).values({
      id: 1,
      providerId: 1,
      branchId: 1,
      code: "REPORT-WALLET",
      name: "محفظة التقرير",
      currentBalance: "250.00",
      reservedBalance: "0",
      isActive: false,
    });
    await db().insert(s.digitalWalletTransactions).values([
      {
        transactionNumber: "REPORT-IN",
        walletId: 1,
        branchId: 1,
        type: "DEPOSIT",
        direction: "IN",
        amount: "300.00",
        balanceAfter: "300.00",
        status: "ACTIVE",
        createdBy: 1,
        createdAt: new Date("2026-07-01T10:00:00Z"),
      },
      {
        transactionNumber: "REPORT-OUT",
        walletId: 1,
        branchId: 1,
        type: "WITHDRAWAL",
        direction: "OUT",
        amount: "50.00",
        balanceAfter: "250.00",
        status: "ACTIVE",
        createdBy: 1,
        createdAt: new Date("2026-07-20T10:00:00Z"),
      },
    ]);

    const current = await getFinancialPosition({ verify: false });
    expect(current.digitalWalletAsset).toBe("250.00");
    expect(current.totalAssets).toBe("250.00");

    const historical = await getFinancialPosition({ verify: false, asOf: "2026-07-15" });
    expect(historical.digitalWalletAsset).toBe("300.00");
    expect(historical.totalAssets).toBe("300.00");
  });

  it("يدرج شطب البطاقة الرقمية ضمن المصروف وصافي الربح", async () => {
    await db().insert(s.accountingEntries).values({
      entryType: "DIGITAL_WRITEOFF",
      branchId: 1,
      amount: "75.00",
      revenue: "0",
      cost: "75.00",
      profit: "-75.00",
      entryDate: new Date("2026-07-15"),
      dedupeKey: "TEST:DIGITAL_WRITEOFF:1",
    });
    const pl = await getProfitAndLoss({ from: "2026-07-01", to: "2026-07-31" });
    expect(pl.current.expenseLines.find((x) => x.key === "DIGITAL_CARD_WRITEOFF")?.amount).toBe("75.00");
    expect(pl.current.totalExpenses).toBe("75.00");
    expect(pl.current.netProfit).toBe("-75.00");
  });
  it("يفصل سحب المالك ورد المرتجع وتسوية المصروف ويحفظ دور السند المختوم رغم تغيير الفئة", async () => {
    await db().insert(s.voucherCategories).values([
      { id: 1, name: "مالك", direction: "OUT", postingRole: "OWNER_CURRENT" },
      { id: 2, name: "إيجار", direction: "OUT", postingRole: "RENT" },
    ]);
    await db().insert(s.receipts).values([
      { id: 10, branchId: 1, direction: "OUT", amount: "10.00", paymentMethod: "CASH", partyType: "OTHER" },
      { id: 11, branchId: 1, direction: "OUT", amount: "100.00", paymentMethod: "CASH", partyType: "OTHER", voucherNumber: "OWNER-11", voucherCategoryId: 1 },
      { id: 12, branchId: 1, direction: "OUT", amount: "20.00", paymentMethod: "CASH", partyType: "OTHER" },
      { id: 13, branchId: 1, direction: "OUT", amount: "5.00", paymentMethod: "CASH", partyType: "OTHER", voucherNumber: "RENT-13", voucherCategoryId: 2 },
      { id: 14, branchId: 1, direction: "OUT", amount: "7.00", paymentMethod: "CASH", partyType: "OTHER", voucherNumber: "HISTORIC-14", voucherCategoryId: 1 },
    ]);
    await db().insert(s.expenses).values({ branchId: 1, expenseDate: new Date("2026-07-15"), category: "TRANSPORT", amount: "10.00", description: "نقل معترف به", receiptId: 10, createdBy: 1 });
    const components = { roleDebits: { RENT: "7.00" }, roleCredits: { CASH: "7.00" } };
    const evidence = createPostingIntentEvidence(createPostingIntent("PAYMENT_OUT_CATEGORY", "PAYMENT_OUT", [debitLine("RENT", "7.00"), creditLine("CASH", "7.00")], components), { ...components, amount: "7.00" });
    await db().insert(s.accountingEntries).values([
      { entryType: "SALE", branchId: 1, revenue: "100.00", cost: "60.00", profit: "40.00", amount: "100.00", entryDate: new Date("2026-07-15") },
      { entryType: "RETURN", branchId: 1, receiptId: 12, revenue: "-20.00", cost: "-12.00", profit: "-8.00", amount: "-20.00", entryDate: new Date("2026-07-15") },
      ...[[10,"10.00"],[11,"100.00"],[12,"20.00"],[13,"5.00"]].map(([id,amount]) => ({ entryType: "PAYMENT_OUT" as const, branchId: 1, receiptId: Number(id), amount: String(amount), entryDate: new Date("2026-07-15") })),
      { entryType: "PAYMENT_OUT", branchId: 1, receiptId: 14, amount: "7.00", entryDate: new Date("2026-07-15"), ...evidence },
    ]);
    const pl = (await getProfitAndLoss({ from: "2026-07-01", to: "2026-07-31" })).current;
    expect(pl).toMatchObject({ revenue: "80.00", cogs: "48.00", grossProfit: "32.00", totalExpenses: "22.00", netProfit: "10.00" });
  });

  it("يبقي مصروف السند الأصلي في تاريخه ويطرح التعويض المعتمد في تاريخ العكس", async () => {
    await db().insert(s.voucherCategories).values({ id: 1, name: "إيجار", direction: "OUT", postingRole: "RENT" });
    await db().insert(s.receipts).values([
      { id: 20, branchId: 1, direction: "OUT", amount: "100.00", paymentMethod: "CASH", partyType: "OTHER", voucherNumber: "RENT-20", voucherCategoryId: 1, status: "REVERSED" },
      { id: 21, branchId: 1, direction: "IN", amount: "100.00", paymentMethod: "CASH", partyType: "OTHER", voucherNumber: "CANCEL-21", voucherCategoryId: 1, referenceNumber: "CANCEL-VCH-20", internalNote: encodeSystemPaymentRequest({ kind: "VOUCHER_CANCELLATION", originalReceiptId: 20, originalCreatorId: 1, originalDirection: "OUT", originalPaymentMethod: "CASH", originalCategoryId: 1, originalReferenceNumber: null, originalCheckNumber: null, originalCardLastFour: null, priorCancellationReceiptId: null, reissueReason: null, attempt: 1 }) },
    ]);
    await db().insert(s.accountingEntries).values([
      { entryType: "PAYMENT_OUT", branchId: 1, receiptId: 20, amount: "100.00", entryDate: new Date("2026-07-30") },
      { entryType: "PAYMENT_IN", branchId: 1, receiptId: 21, amount: "100.00", entryDate: new Date("2026-08-02") },
    ]);
    expect((await getProfitAndLoss({ from: "2026-07-01", to: "2026-07-31" })).current.totalExpenses).toBe("100.00");
    expect((await getProfitAndLoss({ from: "2026-08-01", to: "2026-08-31" })).current.totalExpenses).toBe("-100.00");
    expect((await getProfitAndLoss({ from: "2026-07-01", to: "2026-08-31" })).current.totalExpenses).toBe("0.00");
  });

  it("يستعمل قيمة لقطة المخزون ومصدرها نفسه في مجموع أصول الفرع", async () => {
    await db().insert(s.products).values({ id: 1, name: "منتج" });
    await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "SNAP", costPrice: "50.00" });
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 3 });
    await db().insert(s.financialPeriods).values([
      { id: 899, cutoffDate: "2026-07-31", lockedBy: 1, status: "ARCHIVED" },
      { id: 900, cutoffDate: "2026-07-31", lockedBy: 1, status: "LOCKED" },
    ]);
    await db().insert(s.branches).values({ id: 2, name: "SECOND", code: "SECOND", type: "SALES" });
    await db().insert(s.inventoryValuationSnapshots).values({ periodLockId: 899, cutoffDate: "2026-07-31", scopeKey: "COMPANY", totalValue: "999.00", stockValue: "999.00", inTransitValue: "0.00", branchesJson: JSON.stringify([{ branchId: 1, value: "999.00" }]), capturedBy: 1 });
    await db().insert(s.inventoryValuationSnapshots).values({ periodLockId: 900, cutoffDate: "2026-07-31", scopeKey: "COMPANY", totalValue: "300.00", stockValue: "300.00", inTransitValue: "0.00", branchesJson: JSON.stringify([{ branchId: 1, value: "100.00" }, { branchId: 2, value: "200.00" }]), capturedBy: 1 });
    const historical = await getFinancialPosition({ asOf: "2026-07-31", branchId: 1, verify: false });
    expect(historical).toMatchObject({ inventory: "100.00", totalAssets: "100.00", inventoryValuation: { source: "SNAPSHOT", value: "100.00", branchId: 1, cutoffDate: "2026-07-31" } });
    const current = await getFinancialPosition({ branchId: 1, verify: false });
    expect(current).toMatchObject({ inventory: "150.00", totalAssets: "150.00", inventoryValuation: { source: "LIVE", value: "150.00" } });
  });

  it("يقرأ COGS الأمانة من الدليل أو التكلفة الأصلية دون هدايا أو شراء عادي أو تعديل التاريخ", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "consignor" });
    await db().insert(s.invoices).values([2,3,4].map(id=>({ id, invoiceNumber: `CONSIG-${id}`, sourceType: "POS" as const, branchId: 1, subtotal: "100.00", total: "100.00" })));
    const paid = { roleDebits: { COGS: "70.00", GIFTS_PROMO: "30.00" }, roleCredits: { CONSIGNMENT_PAYABLE: "100.00" } };
    const original = createPostingIntentEvidence(createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [debitLine("COGS","70.00"),debitLine("GIFTS_PROMO","30.00"),creditLine("CONSIGNMENT_PAYABLE","100.00")], paid), { ...paid, amount: "100.00" });
    const date = new Date("2026-07-15");
    await db().insert(s.accountingEntries).values([
      { entryType: "SALE", branchId: 1, invoiceId: 2, amount: "100.00", revenue: "100.00", cost: "20.00", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "100.00", cost: "70.00", ...original, entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, invoiceId: 2, amount: "20.00", cost: "0.00", dedupeKey: "CONSIG:2:1", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "900.00", cost: "900.00", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "5.00", cost: "5.00", postingProfile: "PURCHASE_CONSIGNMENT_SHORTAGE", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "5.00", cost: "5.00", dedupeKey: "CONSIG:STK:7:1", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "6.00", cost: "6.00", dedupeKey: "CONSIG:TRANSFER_SHORT:7:1", entryDate: date },
    ]);
    const period = { from: "2026-07-15", to: "2026-07-15", branchId: 1 };
    expect((await getProfitAndLoss(period)).current).toMatchObject({ revenue: "100.00", cogs: "90.00", grossProfit: "10.00" });
    const reversal = { roleDebits: { CONSIGNMENT_PAYABLE: "100.00" }, roleCredits: { COGS: "70.00", GIFTS_PROMO: "30.00" } };
    const reversed = createPostingIntentEvidence(createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [debitLine("CONSIGNMENT_PAYABLE","100.00"),creditLine("COGS","70.00"),creditLine("GIFTS_PROMO","30.00")], reversal), { ...reversal, amount: "-100.00" });
    await db().insert(s.accountingEntries).values([
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "-100.00", cost: "0.00", ...reversed, entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, invoiceId: 3, amount: "50.00", cost: "40.00", dedupeKey: "CONSIG:3:1", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, invoiceId: 3, amount: "-50.00", cost: "0.00", dedupeKey: "CONSIG:DELIVERY_RETURN:3:1", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, invoiceId: 4, amount: "10.00", cost: "0.00", dedupeKey: "CONSIG:4:1", notes: "استحقاق أمانة؛ COGS مبسّط=0.00؛ هدايا=10.00", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, invoiceId: 4, amount: "-10.00", cost: "0.00", dedupeKey: "CONSIG:DELIVERY_RETURN:4:1", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "-10.00", cost: "-10.00", notes: "عكس استحقاق أمانة — مرتجع", entryDate: date },
      { entryType: "PURCHASE", branchId: 1, supplierId: 1, amount: "10.00", cost: "10.00", notes: "استحقاق تلف مرتجع أمانة", entryDate: date },
    ]);
    const before=await db().select().from(s.accountingEntries);
    expect((await getProfitAndLoss(period)).current.cogs).toBe("20.00");
    expect((await getProfitAndLoss({ ...period, from: "2026-07-16", to: "2026-07-16" })).current.cogs).toBe("0.00");
    expect(await db().select().from(s.accountingEntries)).toEqual(before);
    await db().insert(s.accountingEntries).values({ entryType: "PURCHASE", branchId: 1, supplierId: 1, invoiceId: 2, amount: "-20.00", cost: "0.00", dedupeKey: "CONSIG:DELIVERY_RETURN:2:1", entryDate: date });
    await expect(getProfitAndLoss(period)).rejects.toThrow("تعذر إثبات تكلفة عكس الأمانة");
  });

  it("يفصل التحويل الداخلي عن حركة وسائل الدفع ويؤرخ القبض بالتنفيذ دون تكرار وصلات الدفتر", async () => {
    await db().insert(s.receipts).values([
      { id: 30, branchId: 1, direction: "OUT", amount: "100.00", paymentMethod: "CASH", cashBucket: "TREASURY", referenceNumber: "INTERNAL-30", createdAt: new Date("2026-07-31T20:00:00Z") },
      { id: 31, branchId: 1, direction: "IN", amount: "100.00", paymentMethod: "CASH", cashBucket: "DRAWER", referenceNumber: "INTERNAL-30", createdAt: new Date("2026-07-31T20:00:00Z") },
      { id: 32, branchId: 1, direction: "IN", amount: "25.00", paymentMethod: "CASH", createdAt: new Date("2026-07-31T23:00:00Z"), executedAt: new Date("2026-08-01T01:00:00Z") },
    ]);
    await db().insert(s.accountingEntries).values([
      { entryType: "SHIFT_FLOAT_OUT", branchId: 1, receiptId: 30, amount: "100.00", entryDate: new Date("2026-07-31") },
      { entryType: "PAYMENT_IN", branchId: 1, receiptId: 32, amount: "25.00", entryDate: new Date("2026-07-31") },
      { entryType: "PAYMENT_IN", branchId: 1, receiptId: 32, amount: "25.00", entryDate: new Date("2026-07-31") },
    ]);
    const july = await getCashFlow({ from: "2026-07-31", to: "2026-07-31" });
    expect(july).toMatchObject({ purpose: "PAYMENT_MOVEMENTS", totalIn: "0.00", totalOut: "0.00", internal: { totalIn: "100.00", totalOut: "100.00", net: "0.00" } });
    expect(await getCashFlow({ from: "2026-08-01", to: "2026-08-01" })).toMatchObject({ totalIn: "25.00", net: "25.00" });
  });

});
