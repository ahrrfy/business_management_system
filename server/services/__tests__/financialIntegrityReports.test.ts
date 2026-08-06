import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getArApAgingDetail } from "../reportsAgingDetailService";
import { getCashFlow, getFinancialPosition, getProfitAndLoss } from "../reportsFinancialService";
import { getSalesRegister } from "../reportsSalesService";
import { getCustomerStatement } from "../reportsService";
import { getARAging } from "../reports/arAging";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "accountingEntries", "receipts", "invoiceItems", "invoices",
  "digitalWalletTransactions", "digitalWallets", "digitalProviders",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productVariants",
  "products", "customers", "suppliers", "users", "branches",
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
    await db().insert(s.accountingEntries).values({
      entryType: "RETURN", branchId: 1, purchaseOrderId: 1, supplierId: 1,
      amount: "-40.00", cost: "-40.00", entryDate: new Date("2026-07-02"),
    });

    const detail = await getArApAgingDetail({ side: "AP", branchId: 1 });
    expect(detail.rows).toHaveLength(1);
    expect(detail.rows[0].unpaid).toBe("60.00");
  });

  it("عكس راتب منفرد في الفترة يظهر كتخفيض مصروف ولا يختفي", async () => {
    await db().insert(s.accountingEntries).values({
      entryType: "PAYMENT_OUT", amount: "-100.00",
      entryDate: new Date("2026-07-15"), dedupeKey: "PAYROLL-REV:1:1",
    });
    const pl = await getProfitAndLoss({ from: "2026-07-01", to: "2026-07-31" });
    expect(pl.current.expenseLines.find((x) => x.key === "PAYROLL")?.amount).toBe("-100.00");
    expect(pl.current.totalExpenses).toBe("-100.00");
    expect(pl.current.netProfit).toBe("100.00");
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
});
