import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { getDashboardMetrics } from "../reportsService";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";

const actor = { userId: 1, branchId: 1 };

/** مُنادٍ tRPC بدور/فرع محدَّدين — لاختبار وصل الراوتر (canViewReports⇒includeFinancials). */
function caller(role: string, branchId: number | null = 1) {
  const ctx = {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  } as TrpcContext;
  return appRouter.createCaller(ctx);
}

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

/** تاريخ ظهرَ UTC قبل N يوماً — لإدراج فواتير ضمن نافذة نبض المبيعات بلا انزياح حدّ اليوم. */
function dayNoonUTC(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0));
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

  it("(ح) morningBrief.arRemindersDue/promisedToday يجمعان كل الفروع حين لا فلتر (مراجعة ٥/٧: كان `?? 1` يثبّتهما على الفرع ١)", async () => {
    const d = db();
    const past15 = new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10);
    const todayYmd = new Date().toISOString().slice(0, 10);
    await d.insert(s.customers).values([
      { id: 1, name: "متأخّر فرع ١", phone: "07901111111", defaultPriceTier: "RETAIL", currentBalance: "120000" },
      { id: 2, name: "متأخّر فرع ٢", phone: "07902222222", defaultPriceTier: "RETAIL", currentBalance: "90000" },
    ]);
    // فاتورتان آجلتان متأخّرتان ١٥ يوماً في فرعين مختلفين (إدراج مباشر — لا يلزم مخزون).
    await d.insert(s.invoices).values([
      { id: 501, invoiceNumber: "INV-B1", sourceType: "ORDER", sourceId: "t-501", branchId: 1, customerId: 1, priceTier: "RETAIL", dueDate: past15, subtotal: "120000", total: "120000", paidAmount: "0", status: "PENDING" },
      { id: 502, invoiceNumber: "INV-B2", sourceType: "ORDER", sourceId: "t-502", branchId: 2, customerId: 2, priceTier: "RETAIL", dueDate: past15, subtotal: "90000", total: "90000", paidAmount: "0", status: "PENDING" },
    ]);
    // وعد اليوم لعميل الفرع ٢ — يجب أن يظهر في promisedToday المجمَّع لا في فرع ١.
    await d.insert(s.arReminders).values({
      customerId: 2,
      branchId: 2,
      totalUnpaidSnapshot: "90000.00",
      oldestInvoiceDate: past15,
      daysOverdue: 15,
      messageBody: "",
      status: "SKIPPED",
      skipReason: "وعد اليوم",
      promisedDate: todayYmd,
      createdBy: 1,
    });

    const m1 = await getDashboardMetrics({ branchId: 1 });
    const m2 = await getDashboardMetrics({ branchId: 2 });
    const mAll = await getDashboardMetrics({});
    expect(m1.morningBrief.arRemindersDue).toBe(1);
    expect(m1.morningBrief.promisedToday).toBe(0);
    expect(m2.morningBrief.arRemindersDue).toBe(1);
    expect(m2.morningBrief.promisedToday).toBe(1);
    // ← هذان تحديداً كانا يفشلان مع `?? 1` (يعيدان أرقام الفرع ١ فقط).
    expect(mAll.morningBrief.arRemindersDue).toBe(2);
    expect(mAll.morningBrief.promisedToday).toBe(1);
  });

  it("(ط) مدينو الرصيد الافتتاحي (بلا فاتورة) لا يُحتسَبون في morningBrief — حصر عمداً بنطاق openingScope الأدمن (تحقّق عدائي ٥/٧)", async () => {
    const d = db();
    // عميل رصيد افتتاحي بحت: لا فاتورة إطلاقاً، فقط قيد OPENING + currentBalance موجب.
    await d.insert(s.customers).values({
      id: 1,
      name: "مدين افتتاحي",
      defaultPriceTier: "RETAIL",
      currentBalance: "500000",
    });
    const openedOn = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.accountingEntries).values({
      entryType: "OPENING",
      customerId: 1,
      amount: "500000",
      entryDate: openedOn,
      dedupeKey: "OPENING:CUSTOMER:1",
    });
    // getDashboardMetrics({}) ⇒ getReminderQueue({branchId:null}) بلا openingOnly (مطابق dashboard.ts:82
    // فعلياً) — كان هذا يُسرِّب مدينِي الافتتاحي لأي مدير مرتفع قبل الإصلاح؛ يجب أن يبقى صفراً الآن.
    const mAll = await getDashboardMetrics({});
    expect(mAll.morningBrief.arRemindersDue).toBe(0);
    const m1 = await getDashboardMetrics({ branchId: 1 });
    expect(m1.morningBrief.arRemindersDue).toBe(0);
  });

  it("(ك) مدينو الرصيد الافتتاحي يُحتسَبون عند includeOpeningBalance:true (أدمن حصراً) وفي العرض المجمَّع فقط (إصلاح gap-audit HIGH ٥/٧)", async () => {
    const d = db();
    await d.insert(s.customers).values({
      id: 1,
      name: "مدين افتتاحي",
      defaultPriceTier: "RETAIL",
      currentBalance: "500000",
    });
    const openedOn = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.accountingEntries).values({
      entryType: "OPENING",
      customerId: 1,
      amount: "500000",
      entryDate: openedOn,
      dedupeKey: "OPENING:CUSTOMER:1",
    });
    // بلا العلَم (منتحل دور مدير) ⇒ سلوك test (ط) القائم: صفر، حتى مع branchId=null.
    const mDefault = await getDashboardMetrics({});
    expect(mDefault.morningBrief.arRemindersDue).toBe(0);
    // مع العلَم صراحةً (منتحل دور أدمن) + branchId=null (العرض المجمَّع) ⇒ يُحتسَب الآن.
    const mAdmin = await getDashboardMetrics({ includeOpeningBalance: true });
    expect(mAdmin.morningBrief.arRemindersDue).toBe(1);
    // مع العلَم لكن على فرع محدَّد ⇒ يبقى صفراً (لا انتماء فرعيّ لهؤلاء المدينين — الشرط يفحص branchId==null أيضاً).
    const mAdminBranch1 = await getDashboardMetrics({ branchId: 1, includeOpeningBalance: true });
    expect(mAdminBranch1.morningBrief.arRemindersDue).toBe(0);
  });

  it("(ز) قاعدة فارغة ⇒ كل الحقول صفر (لا انهيار)", async () => {
    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.morningBrief.arRemindersDue).toBe(0);
    expect(m.morningBrief.promisedToday).toBe(0);
    expect(m.morningBrief.overdueWorkOrders).toBe(0);
    // نبض المبيعات على قاعدة فارغة ⇒ صفر/flat بلا انهيار.
    expect(m.salesPulse.yesterday).toBe("0.00");
    expect(m.salesPulse.direction).toBe("flat");
    expect(m.salesPulse.changePct).toBe(0);
  });

  it("(ط) salesPulse: مبيعات أمس ضعف المعدّل ⇒ direction=up + changePct=100", async () => {
    const d = db();
    // أمس (D-1) 200000 + يوم سابق (D-2) 500000 ⇒ مجموع النافذة 700000، المعدّل = 700000/7 = 100000.
    // أمس (200000) = ضعف المعدّل (100000) ⇒ +100٪ صعوداً.
    await d.insert(s.invoices).values([
      { id: 601, invoiceNumber: "INV-Y", sourceType: "ORDER", sourceId: "t-601", branchId: 1, priceTier: "RETAIL", subtotal: "200000", total: "200000", paidAmount: "0", status: "PENDING", invoiceDate: dayNoonUTC(1) },
      { id: 602, invoiceNumber: "INV-P", sourceType: "ORDER", sourceId: "t-602", branchId: 1, priceTier: "RETAIL", subtotal: "500000", total: "500000", paidAmount: "0", status: "PENDING", invoiceDate: dayNoonUTC(2) },
    ]);
    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.salesPulse.yesterday).toBe("200000.00");
    expect(m.salesPulse.avg7d).toBe("100000.00");
    expect(m.salesPulse.direction).toBe("up");
    expect(m.salesPulse.changePct).toBe(100);
  });

  it("(ي) salesPulse: مساواة المعدّل ⇒ flat + changePct=0؛ واليوم الجاري لا يُحتسَب", async () => {
    const d = db();
    // أمس (D-1) 100000 + سابق (D-2) 600000 ⇒ مجموع 700000، معدّل 100000 = أمس بالضبط ⇒ flat.
    // + فاتورة اليوم (D-0) ضخمة يجب أن تُستبعَد (النافذة < UTC_DATE()).
    await d.insert(s.invoices).values([
      { id: 701, invoiceNumber: "INV-FY", sourceType: "ORDER", sourceId: "t-701", branchId: 1, priceTier: "RETAIL", subtotal: "100000", total: "100000", paidAmount: "0", status: "PENDING", invoiceDate: dayNoonUTC(1) },
      { id: 702, invoiceNumber: "INV-FP", sourceType: "ORDER", sourceId: "t-702", branchId: 1, priceTier: "RETAIL", subtotal: "600000", total: "600000", paidAmount: "0", status: "PENDING", invoiceDate: dayNoonUTC(2) },
      { id: 703, invoiceNumber: "INV-TODAY", sourceType: "ORDER", sourceId: "t-703", branchId: 1, priceTier: "RETAIL", subtotal: "9000000", total: "9000000", paidAmount: "0", status: "PENDING", invoiceDate: dayNoonUTC(0) },
    ]);
    const m = await getDashboardMetrics({ branchId: 1 });
    expect(m.salesPulse.yesterday).toBe("100000.00");
    expect(m.salesPulse.avg7d).toBe("100000.00");
    expect(m.salesPulse.direction).toBe("flat");
    expect(m.salesPulse.changePct).toBe(0);
  });
});

// تسريب dashboardMetrics (تدقيق ١٧/٧): الأرقام المالية (overdueAR/salesPulse/عدّادا AR في برنامج
// اليوم) تُحجب عن أدوار reports=NONE عبر includeFinancials=false (يمرّره الراوتر من canViewReports).
// lowStockCount + overdueWorkOrders تشغيليّان ⇒ يبقيان محسوبَين. سيناريو واحد يُقاس بالعلَمين.
describe("getDashboardMetrics — بوّابة includeFinancials (حجب المالي عن reports=NONE)", () => {
  async function seedFinancialScenario() {
    const d = db();
    // (تشغيليّ) متغيّر منخفض المخزون — يجب أن يُعدّ في كلا الحالتين.
    await d.insert(s.productVariants).values({ id: 2, productId: 1, sku: "PEN-LOW", costPrice: "4.00", minStock: 10 });
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: 100 },
      { variantId: 2, branchId: 1, quantity: 3 }, // منخفض ✓
    ]);
    // (تشغيليّ) أمر شغل متأخّر — يجب أن يُعدّ في كلا الحالتين.
    await d.insert(s.customers).values({ id: 1, name: "عميل متأخّر", phone: "07901234567", defaultPriceTier: "RETAIL", currentBalance: "240000" });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.workOrders).values({ id: 1, orderNumber: "WO-OVR", branchId: 1, customerId: 1, status: "IN_PROGRESS", dueDate: yesterday, title: "طلبية", subtotal: "100", total: "100" });
    // (ماليّ) فاتورة آجلة متأخّرة ٤٥ يوماً ⇒ overdueAR + مؤهّلة لتذكير AR (dueDate قبل ١٥ يوماً).
    const past15 = new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10);
    await d.insert(s.invoices).values([
      { id: 801, invoiceNumber: "INV-OVR", sourceType: "ORDER", sourceId: "t-801", branchId: 1, customerId: 1, priceTier: "RETAIL", subtotal: "240000", total: "240000", paidAmount: "0", status: "PENDING", invoiceDate: dayNoonUTC(45), dueDate: past15 },
      // (ماليّ) مبيعات أمس ⇒ salesPulse.
      { id: 802, invoiceNumber: "INV-YDAY", sourceType: "ORDER", sourceId: "t-802", branchId: 1, priceTier: "RETAIL", subtotal: "300000", total: "300000", paidAmount: "0", status: "PENDING", invoiceDate: dayNoonUTC(1) },
    ]);
  }

  it("(ل) includeFinancials:false ⇒ overdueAR/salesPulse/عدّادا AR أصفار، وlowStock+أوامر متأخّرة محفوظة", async () => {
    await seedFinancialScenario();
    const gated = await getDashboardMetrics({ branchId: 1, includeFinancials: false });
    // المالي محجوب (صفر محايد لا الرقم الحقيقي).
    expect(gated.overdueAR).toEqual({ count: 0, total: "0.00" });
    expect(gated.salesPulse.yesterday).toBe("0.00");
    expect(gated.salesPulse.direction).toBe("flat");
    expect(gated.morningBrief.arRemindersDue).toBe(0);
    expect(gated.morningBrief.promisedToday).toBe(0);
    // التشغيليّ محفوظ.
    expect(gated.lowStockCount).toBe(1);
    expect(gated.morningBrief.overdueWorkOrders).toBe(1);
  });

  it("(م) includeFinancials:true (والافتراضي) ⇒ الأرقام المالية الحقيقية تظهر", async () => {
    await seedFinancialScenario();
    const shown = await getDashboardMetrics({ branchId: 1, includeFinancials: true });
    expect(shown.overdueAR.count).toBe(1);
    expect(shown.overdueAR.total).toBe("240000.00");
    expect(shown.salesPulse.yesterday).toBe("300000.00");
    expect(shown.morningBrief.arRemindersDue).toBe(1);
    // نفس النتيجة عند حذف العلَم (الافتراضي true للمستدعين المُتحقَّق منهم: المجدول/التنفيذيّة).
    const dflt = await getDashboardMetrics({ branchId: 1 });
    expect(dflt.overdueAR.total).toBe("240000.00");
    // التشغيليّ ثابت بين الحالتين.
    expect(shown.lowStockCount).toBe(1);
    expect(shown.morningBrief.overdueWorkOrders).toBe(1);
  });

  // وصل الراوتر: reports.dashboardMetrics على protectedProcedure يمرّر canViewReports(ctx.user)
  // إلى includeFinancials ⇒ الدور reports=NONE (كاشير) يتلقّى أصفاراً، والمخوّل (مدير) الأرقام الحقيقية.
  // هذا هو الحاجز الأمنيّ الفعليّ للتسريب (الواجهة إخفاءٌ تجميليّ فوقه).
  it("(ن) الراوتر: كاشير (reports=NONE) يتلقّى overdueAR مُصفّراً بينما المدير يراه — مع بقاء lowStock للاثنين", async () => {
    await seedFinancialScenario();
    const mgr = await caller("manager", 1).reports.dashboardMetrics({ branchId: 1 });
    const csh = await caller("cashier", 1).reports.dashboardMetrics({ branchId: 1 });
    // المدير يرى الرقم الحقيقيّ.
    expect(mgr.overdueAR).toEqual({ count: 1, total: "240000.00" });
    expect(mgr.salesPulse.yesterday).toBe("300000.00");
    // الكاشير محجوب — صفر محايد لا الرقم.
    expect(csh.overdueAR).toEqual({ count: 0, total: "0.00" });
    expect(csh.salesPulse.yesterday).toBe("0.00");
    expect(csh.morningBrief.arRemindersDue).toBe(0);
    // lowStock تشغيليّ ⇒ يراه الاثنان (اللوحة تبقى متاحة للكاشير بلا تسريب ماليّ).
    expect(csh.lowStockCount).toBe(1);
    expect(mgr.lowStockCount).toBe(1);
  });
});
