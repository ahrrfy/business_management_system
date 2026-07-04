import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { getDashboardMetrics } from "../reportsService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
  "arReminders",
  "workOrders",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "categories",
  "purchaseOrderItems",
  "purchaseOrders",
  "shifts",
  "customers",
  "suppliers",
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

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  // منتج بقلم تجريبي (يُستعمل في اختبار AR overdue).
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
  ]);
  await d.insert(s.productPrices).values([
    { productUnitId: 1, priceTier: "RETAIL", price: "10.00" },
    { productUnitId: 2, priceTier: "RETAIL", price: "120.00" },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("getDashboardMetrics", () => {
  it("(أ) lowStockCount = 2 عند وجود متغيّرَين تحت minStock، ويستثني متغيّراً سليماً ومتغيّراً بلا حدّ أدنى", async () => {
    const d = db();
    // متغيّرات إضافية لاختبار العدّ:
    //   v=2: minStock=10، quantity=5 ⇒ منخفض (يُعدّ)
    //   v=3: minStock=20، quantity=20 ⇒ منخفض على الحدّ تماماً (يُعدّ — العلامة ≤)
    //   v=4: minStock=10، quantity=50 ⇒ سليم (لا يُعدّ)
    //   v=5: minStock=0،  quantity=0  ⇒ بلا حدّ أدنى (يُستثنى)
    //   v=1 (من seed): لا قيد على الحدّ — minStock=0 ⇒ يُستثنى تلقائياً.
    await d.insert(s.productVariants).values([
      { id: 2, productId: 1, sku: "PEN-2", costPrice: "4.00", minStock: 10 },
      { id: 3, productId: 1, sku: "PEN-3", costPrice: "4.00", minStock: 20 },
      { id: 4, productId: 1, sku: "PEN-4", costPrice: "4.00", minStock: 10 },
      { id: 5, productId: 1, sku: "PEN-5", costPrice: "4.00", minStock: 0 },
    ]);
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 0 },   // minStock=0 ⇒ يُستثنى
      { variantId: 2, branchId: 1, quantity: 5 },   // منخفض ✓
      { variantId: 3, branchId: 1, quantity: 20 },  // على الحدّ ⇒ منخفض ✓
      { variantId: 4, branchId: 1, quantity: 50 },  // سليم
      { variantId: 5, branchId: 1, quantity: 0 },   // بلا حدّ ⇒ يُستثنى
    ]);

    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.lowStockCount).toBe(2);
  });

  it("(ب) overdueAR.count=1 ومجموع المتبقّي صحيح لفاتورة عمرها ٤٥ يوماً", async () => {
    const d = db();
    // مخزون كافٍ لإتمام البيع.
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    await d.insert(s.customers).values([
      { id: 1, name: "عميل متأخّر", defaultPriceTier: "RETAIL", currentBalance: "0" },
      { id: 2, name: "عميل حديث", defaultPriceTier: "RETAIL", currentBalance: "0" },
    ]);

    // فاتورة متأخّرة (٤٥ يوماً): 2 درزن × 120 = 240، بلا دفعة ⇒ متبقّي 240.
    const overdueSale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "2" }] },
      actor
    );
    // ادفع تاريخ الإصدار إلى الوراء ٤٥ يوماً ⇒ DATEDIFF=45 > 30.
    await d.execute(sql`
      UPDATE invoices SET invoiceDate = DATE_SUB(NOW(), INTERVAL 45 DAY)
      WHERE id = ${overdueSale.invoiceId}
    `);

    // فاتورة حديثة (٥ أيام): يجب ألّا تُعدّ.
    const freshSale = await createSale(
      { branchId: 1, customerId: 2, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] },
      actor
    );
    await d.execute(sql`
      UPDATE invoices SET invoiceDate = DATE_SUB(NOW(), INTERVAL 5 DAY)
      WHERE id = ${freshSale.invoiceId}
    `);

    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.overdueAR.count).toBe(1);
    expect(m.overdueAR.total).toBe("240.00");
  });

  it("(ج) morningBrief.arRemindersDue = عدد العملاء المؤهَّلين اليوم (≥٧ أيام + خارج التبريد)", async () => {
    const d = db();
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    await d.insert(s.customers).values([
      { id: 1, name: "متأخّر ١٥ يوماً", phone: "07901234567", defaultPriceTier: "RETAIL", currentBalance: "0" },
      { id: 2, name: "متأخّر ٥ أيام (تحت الحدّ)", phone: "07907654321", defaultPriceTier: "RETAIL", currentBalance: "0" },
    ]);
    const overdue = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] },
      actor,
    );
    await d.execute(sql`
      UPDATE invoices SET dueDate = DATE_SUB(UTC_DATE(), INTERVAL 15 DAY)
      WHERE id = ${overdue.invoiceId}
    `);
    const recent = await createSale(
      { branchId: 1, customerId: 2, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] },
      actor,
    );
    await d.execute(sql`
      UPDATE invoices SET dueDate = DATE_SUB(UTC_DATE(), INTERVAL 5 DAY)
      WHERE id = ${recent.invoiceId}
    `);

    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.morningBrief.arRemindersDue).toBe(1); // فقط العميل ١
    expect(m.morningBrief.promisedToday).toBe(0);
  });

  it("(د) morningBrief.promisedToday يعدّ العملاء الموعودين اليوم بالضبط", async () => {
    const d = db();
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    await d.insert(s.customers).values({
      id: 1,
      name: "موعود اليوم",
      phone: "07901234567",
      defaultPriceTier: "RETAIL",
      currentBalance: "0",
    });
    const sale = await createSale(
      { branchId: 1, customerId: 1, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: "1" }] },
      actor,
    );
    await d.execute(sql`
      UPDATE invoices SET dueDate = DATE_SUB(UTC_DATE(), INTERVAL 20 DAY)
      WHERE id = ${sale.invoiceId}
    `);
    // تخطٍّ سابق بوعد اليوم ⇒ isPromiseDue=true
    const todayYmd = new Date().toISOString().slice(0, 10);
    await d.insert(s.arReminders).values({
      customerId: 1,
      branchId: 1,
      totalUnpaidSnapshot: "120.00",
      oldestInvoiceDate: todayYmd,
      daysOverdue: 20,
      messageBody: "",
      status: "SKIPPED",
      skipReason: "وعد اليوم",
      promisedDate: todayYmd,
      createdBy: 1,
    });

    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.morningBrief.arRemindersDue).toBe(1);
    expect(m.morningBrief.promisedToday).toBe(1);
  });

  it("(هـ) morningBrief.overdueWorkOrders يعدّ أوامر متجاوزة dueDate وحالتها غير مُسلَّمة/ملغاة", async () => {
    const d = db();
    await d.insert(s.customers).values({ id: 1, name: "عميل ورشة", defaultPriceTier: "RETAIL", currentBalance: "0" });
    // ٤ أوامر شغل:
    //   1: IN_PROGRESS، dueDate = أمس ⇒ متأخّر ✓
    //   2: READY، dueDate = قبل ٥ أيام ⇒ متأخّر ✓
    //   3: DELIVERED، dueDate = قبل ١٠ أيام ⇒ يُستثنى (مُسلَّم)
    //   4: IN_PROGRESS، dueDate = بعد ٣ أيام ⇒ يُستثنى (لم يتأخّر بعد)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const past5 = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const past10 = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const future3 = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.workOrders).values([
      { id: 1, orderNumber: "WO-001", branchId: 1, customerId: 1, status: "IN_PROGRESS", dueDate: yesterday, title: "طلبية اختبار", subtotal: "100", total: "100" },
      { id: 2, orderNumber: "WO-002", branchId: 1, customerId: 1, status: "READY", dueDate: past5, title: "طلبية اختبار", subtotal: "100", total: "100" },
      { id: 3, orderNumber: "WO-003", branchId: 1, customerId: 1, status: "DELIVERED", dueDate: past10, title: "طلبية اختبار", subtotal: "100", total: "100" },
      { id: 4, orderNumber: "WO-004", branchId: 1, customerId: 1, status: "IN_PROGRESS", dueDate: future3, title: "طلبية اختبار", subtotal: "100", total: "100" },
    ]);

    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.morningBrief.overdueWorkOrders).toBe(2);
  });

  it("(و) عزل الفرع: أوامر فرع آخر متأخّرة لا تُحسَب في فرعي", async () => {
    const d = db();
    await d.insert(s.customers).values({ id: 1, name: "ع", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.workOrders).values([
      { id: 10, orderNumber: "WO-B1", branchId: 1, customerId: 1, status: "IN_PROGRESS", dueDate: yesterday, title: "طلبية اختبار", subtotal: "100", total: "100" },
      { id: 11, orderNumber: "WO-B2", branchId: 2, customerId: 1, status: "IN_PROGRESS", dueDate: yesterday, title: "طلبية اختبار", subtotal: "100", total: "100" },
    ]);
    const m1 = await getDashboardMetrics({ branchId: 1 });
    const m2 = await getDashboardMetrics({ branchId: 2 });
    expect(m1.morningBrief.overdueWorkOrders).toBe(1);
    expect(m2.morningBrief.overdueWorkOrders).toBe(1);
    // بلا فلتر فرع ⇒ يجمع الاثنين
    const mAll = await getDashboardMetrics({});
    expect(mAll.morningBrief.overdueWorkOrders).toBe(2);
  });

  it("(ز) قاعدة فارغة ⇒ كل الحقول صفر (لا انهيار)", async () => {
    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.morningBrief.arRemindersDue).toBe(0);
    expect(m.morningBrief.promisedToday).toBe(0);
    expect(m.morningBrief.overdueWorkOrders).toBe(0);
  });
});
