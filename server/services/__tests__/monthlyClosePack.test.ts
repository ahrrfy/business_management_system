// بند 11 (٧/٧): اختبارات حزمة الإقفال الشهري — كل قسم يُتحقَّق رقمياً بدقة decimal على
// بيانات شهر معلومة، مع فلترة الشهر (حركة خارج الشهر لا تدخل) وعزل الفرع.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getMonthlyClosePack } from "../reports/monthlyClosePack";

const TABLES = [
  "accountingEntries",
  "receipts",
  "expenses",
  "invoiceItems",
  "invoices",
  "purchaseOrders",
  "workOrders",
  "productVariants",
  "products",
  "suppliers",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

// شهر ثابت معلوم (لا اعتماد على «اليوم») — تموز/يوليو 2026.
const MONTH = "2026-07";
const IN_MONTH = "2026-07-10 12:00:00";
const OUT_MONTH = "2026-06-25 12:00:00";

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values({ id: 10, name: "عميل أ", currentBalance: "7500" });
  await d.insert(s.suppliers).values({ id: 20, name: "مورّد أ", currentBalance: "3000" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P-1", costPrice: "100" });
}

async function seedInvoice(opts: { id: number; branchId?: number; date: string; total: string; cost: string; returned?: string; tax?: string }) {
  const d = db();
  await d.insert(s.invoices).values({
    id: opts.id,
    invoiceNumber: `INV-${opts.id}`,
    sourceType: "POS",
    sourceId: `t-${opts.id}`,
    branchId: opts.branchId ?? 1,
    customerId: 10,
    priceTier: "RETAIL",
    subtotal: opts.total,
    taxAmount: opts.tax ?? "0",
    total: opts.total,
    returnedTotal: opts.returned ?? "0",
    costTotal: opts.cost,
    paidAmount: opts.total,
    status: "PAID",
    invoiceDate: new Date(opts.date),
  });
  await d.insert(s.invoiceItems).values({
    invoiceId: opts.id,
    variantId: 1,
    quantity: "1",
    baseQuantity: 1,
    unitPrice: opts.total,
    unitCost: opts.cost,
    total: opts.total,
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("monthlyClosePack", () => {
  it("أقسام المبيعات والربح والمصاريف والخزينة تُحسب لشهرٍ معلوم بدقة", async () => {
    const d = db();
    await seedInvoice({ id: 200, date: IN_MONTH, total: "10000.00", cost: "4000.00", returned: "1000.00" });
    await seedInvoice({ id: 201, date: IN_MONTH, total: "5000.00", cost: "2000.00" });
    // خارج الشهر — يجب ألا تدخل بأي قسم.
    await seedInvoice({ id: 202, date: OUT_MONTH, total: "99999.00", cost: "9999.00" });

    await d.insert(s.expenses).values([
      { branchId: 1, expenseDate: "2026-07-05", category: "RENT", amount: "300000.00", paymentMethod: "CASH", description: "إيجار", payee: "المالك" },
      { branchId: 1, expenseDate: "2026-06-05", category: "RENT", amount: "77777.00", paymentMethod: "CASH", description: "خارج الشهر", payee: "المالك" },
    ]);
    await d.insert(s.receipts).values([
      { branchId: 1, direction: "IN", amount: "8000.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", partyType: "OTHER", description: "قبض", referenceNumber: "R-1", createdBy: 1, receiptDate: new Date(IN_MONTH) },
      { branchId: 1, direction: "OUT", amount: "3000.00", paymentMethod: "CASH", cashBucket: "TREASURY", status: "COMPLETED", partyType: "OTHER", description: "صرف", referenceNumber: "R-2", createdBy: 1, receiptDate: new Date(IN_MONTH) },
    ]);

    const pack = await getMonthlyClosePack({ month: MONTH });

    expect(pack.sales.invoiceCount).toBe(2);
    expect(pack.sales.total).toBe("15000.00");
    expect(pack.sales.returnedTotal).toBe("1000.00");
    expect(pack.sales.netAfterReturns).toBe("14000.00");

    expect(pack.profit.revenue).toBe("15000.00");
    expect(pack.profit.cost).toBe("6000.00");
    expect(pack.profit.profit).toBe("9000.00");

    expect(pack.expenses.total).toBe("300000.00");
    expect(pack.treasury.totalIn).toBe("8000.00");
    expect(pack.treasury.totalOut).toBe("3000.00");
    expect(pack.treasury.net).toBe("5000.00");

    expect(pack.receivablesSnapshot.arTotal).toBe("7500.00");
    expect(pack.receivablesSnapshot.apTotal).toBe("3000.00");
  });

  it("عزل الفرع: فرع 1 لا يرى مبيعات فرع 2", async () => {
    await seedInvoice({ id: 210, branchId: 1, date: IN_MONTH, total: "1000.00", cost: "400.00" });
    await seedInvoice({ id: 211, branchId: 2, date: IN_MONTH, total: "9000.00", cost: "3600.00" });

    const b1 = await getMonthlyClosePack({ month: MONTH, branchId: 1 });
    expect(b1.sales.total).toBe("1000.00");
    expect(b1.profit.profit).toBe("600.00");

    const all = await getMonthlyClosePack({ month: MONTH });
    expect(all.sales.total).toBe("10000.00");
  });

  it("شهر فارغ ⇒ أصفار سليمة بلا أخطاء", async () => {
    const pack = await getMonthlyClosePack({ month: "2025-01" });
    expect(pack.sales.invoiceCount).toBe(0);
    expect(pack.sales.netAfterReturns).toBe("0.00");
    expect(pack.profit.profit).toBe("0.00");
    expect(pack.treasury.net).toBe("0.00");
  });
});
