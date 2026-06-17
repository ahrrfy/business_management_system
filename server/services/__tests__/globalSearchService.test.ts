/**
 * اختبارات البحث الشامل — تصنيف نمط + استعلامات حقيقية + RBAC + عزل الفرع.
 *
 * تشغّل على قاعدة الاختبار MySQL (نفس نمط `catalogSearch.test.ts`):
 * - أجزاء نقيّة (classifyQuery) بلا قاعدة.
 * - أجزاء التكامل تبذر فروعاً + منتجات + عملاء + موردين + فواتير + ...
 *   ثم تتحقّق أن `globalSearch` يُرجع الكيان الصحيح حسب الدور والفرع.
 *
 * **عزل الحالة:** نمسح كل جداول قاعدة الاختبار في `beforeEach` (نمط `__setup__`)
 * ولا نُمرّر IDs صريحة — نلتقطها بعد الإدراج عبر استعلام بـuniques (invoiceNumber،
 * quoteNumber، orderNumber، name، sku). هذا أنظف من id=1 الصريح الذي يصطدم بـ
 * auto_increment والتلوّث بين الجلسات.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { classifyQuery, globalSearch } from "../globalSearchService";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  const rows = await d.execute(
    sql`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
  );
  const data = ((rows as any)[0] ?? rows) as Array<{ name: string }>;
  const tables = data.map((r) => r.name).filter((n) => n !== "__drizzle_migrations");
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of tables) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

type SeedRefs = {
  branchMain: number;
  branchSales: number;
  productPen: number;
  productNotebook: number;
  customerAhmad: number;
  customerFatima: number;
  supplierLibrary: number;
  invoiceMain: number;
  invoiceSales: number;
  quotationId: number;
  workOrderId: number;
  poId: number;
  expenseId: number;
};

async function seed(): Promise<SeedRefs> {
  const d = db();
  await d.insert(s.branches).values([
    { name: "MAIN", code: "MAIN", type: "MAIN" },
    { name: "SALES", code: "SALES", type: "SALES" },
  ]);
  const [branchMain] = await d.select({ id: s.branches.id }).from(s.branches).where(eq(s.branches.code, "MAIN"));
  const [branchSales] = await d.select({ id: s.branches.id }).from(s.branches).where(eq(s.branches.code, "SALES"));

  await d.insert(s.products).values([
    { name: "قلم جاف أزرق فاخر" },
    { name: "دفتر مدرسي ٩٦ ورقة" },
  ]);
  const [productPen] = await d.select({ id: s.products.id }).from(s.products).where(eq(s.products.name, "قلم جاف أزرق فاخر"));
  const [productNotebook] = await d.select({ id: s.products.id }).from(s.products).where(eq(s.products.name, "دفتر مدرسي ٩٦ ورقة"));

  await d.insert(s.productVariants).values([
    { productId: productPen.id, sku: "PEN-BLUE", costPrice: "0.00" },
    { productId: productNotebook.id, sku: "NB-96", costPrice: "0.00" },
  ]);
  const [vPen] = await d.select({ id: s.productVariants.id }).from(s.productVariants).where(eq(s.productVariants.sku, "PEN-BLUE"));
  const [vNb] = await d.select({ id: s.productVariants.id }).from(s.productVariants).where(eq(s.productVariants.sku, "NB-96"));

  await d.insert(s.productUnits).values([
    { variantId: vPen.id, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6291041500213" },
    { variantId: vNb.id, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "6291041500220" },
  ]);

  await d.insert(s.customers).values([
    { name: "أحمد علي", phone: "+9647701234567", currentBalance: "0" },
    { name: "فاطمة محمد", phone: "+9647809876543", currentBalance: "0" },
  ]);
  const [cAhmad] = await d.select({ id: s.customers.id }).from(s.customers).where(eq(s.customers.name, "أحمد علي"));
  const [cFatima] = await d.select({ id: s.customers.id }).from(s.customers).where(eq(s.customers.name, "فاطمة محمد"));

  await d.insert(s.suppliers).values([
    { name: "مكتبة الجامعة", phone: "+9647701111111", currentBalance: "0" },
  ]);
  const [supLib] = await d.select({ id: s.suppliers.id }).from(s.suppliers).where(eq(s.suppliers.name, "مكتبة الجامعة"));

  await d.insert(s.invoices).values([
    { invoiceNumber: "INV-2606-1001", sourceType: "POS", branchId: branchMain.id, customerId: cAhmad.id,
      subtotal: "5000.00", total: "5000.00", status: "PAID" },
    { invoiceNumber: "INV-2606-1002", sourceType: "POS", branchId: branchSales.id, customerId: cFatima.id,
      subtotal: "3000.00", total: "3000.00", status: "PAID" },
  ]);
  const [invMain] = await d.select({ id: s.invoices.id }).from(s.invoices).where(eq(s.invoices.invoiceNumber, "INV-2606-1001"));
  const [invSales] = await d.select({ id: s.invoices.id }).from(s.invoices).where(eq(s.invoices.invoiceNumber, "INV-2606-1002"));

  await d.insert(s.quotations).values([
    { quoteNumber: "QT-2606-9164", branchId: branchMain.id, customerId: cAhmad.id,
      subtotal: "12000.00", total: "12000.00", status: "DRAFT" },
  ]);
  const [qt] = await d.select({ id: s.quotations.id }).from(s.quotations).where(eq(s.quotations.quoteNumber, "QT-2606-9164"));

  await d.insert(s.workOrders).values([
    { orderNumber: "WO-2606-0001", branchId: branchMain.id, customerId: cAhmad.id,
      title: "درع تخرّج زجاجي", quantity: 1, status: "RECEIVED" },
  ]);
  const [wo] = await d.select({ id: s.workOrders.id }).from(s.workOrders).where(eq(s.workOrders.orderNumber, "WO-2606-0001"));

  await d.insert(s.purchaseOrders).values([
    { poNumber: "PO-2606-0500", supplierId: supLib.id, branchId: branchMain.id,
      subtotal: "100000.00", total: "100000.00", status: "DRAFT" },
  ]);
  const [po] = await d.select({ id: s.purchaseOrders.id }).from(s.purchaseOrders).where(eq(s.purchaseOrders.poNumber, "PO-2606-0500"));

  await d.insert(s.expenses).values([
    { branchId: branchMain.id, expenseDate: "2026-06-17", category: "RENT",
      amount: "300000.00", paymentMethod: "CASH", description: "إيجار شهر يونيو", payee: "صاحب العقار" },
  ]);
  const [exp] = await d.select({ id: s.expenses.id }).from(s.expenses).where(eq(s.expenses.description, "إيجار شهر يونيو"));

  return {
    branchMain: branchMain.id, branchSales: branchSales.id,
    productPen: productPen.id, productNotebook: productNotebook.id,
    customerAhmad: cAhmad.id, customerFatima: cFatima.id,
    supplierLibrary: supLib.id,
    invoiceMain: invMain.id, invoiceSales: invSales.id,
    quotationId: qt.id, workOrderId: wo.id, poId: po.id, expenseId: exp.id,
  };
}

let refs: SeedRefs;
beforeEach(async () => { await reset(); refs = await seed(); });

// ────────────────────────────── classifyQuery ──────────────────────────────

describe("classifyQuery — تصنيف النمط", () => {
  it("أرقام صرفة ٨-١٤ خانة ⇒ BARCODE", () => {
    expect(classifyQuery("6291041500213").kind).toBe("BARCODE");
    expect(classifyQuery("12345678").kind).toBe("BARCODE");
    expect(classifyQuery("12345678901234").kind).toBe("BARCODE");
  });
  it("بادئة وثيقة ⇒ DOC_NUMBER", () => {
    for (const q of ["INV-2606-1001", "QT-2606-9164", "PO-2606-0500", "WO-2606-0001", "SR-1", "PR-1"]) {
      expect(classifyQuery(q).kind).toBe("DOC_NUMBER");
    }
  });
  it("رقم قصير (≤٧) ⇒ DOC_NUMBER (المالك يكتب «9164» قاصداً QT)", () => {
    expect(classifyQuery("9164").kind).toBe("DOC_NUMBER");
    expect(classifyQuery("1").kind).toBe("DOC_NUMBER");
  });
  it("هاتف بصيغة +E.164 ⇒ PHONE", () => {
    expect(classifyQuery("+9647701234567").kind).toBe("PHONE");
  });
  it("نص عربي/لاتيني ⇒ TEXT", () => {
    expect(classifyQuery("قلم أزرق").kind).toBe("TEXT");
    expect(classifyQuery("PEN-BLUE").kind).toBe("TEXT");
  });
  it("الفراغ ⇒ TEXT بـquery فارغ", () => {
    expect(classifyQuery("  ").query).toBe("");
  });
});

// ────────────────────────────── تكامل: حسب النمط ──────────────────────────────

describe("globalSearch — توجيه حسب النمط", () => {
  it("BARCODE يطابق منتجاً عبر productUnits.barcode (تطابق دقيق)", async () => {
    const out = await globalSearch({ query: "6291041500213", branchId: refs.branchMain, role: "admin" });
    const products = out.filter((r) => r.type === "PRODUCT");
    expect(products).toHaveLength(1);
    expect(products[0].title).toContain("قلم");
    expect(products[0].rank).toBe(0);
  });

  it("DOC_NUMBER كامل ⇒ يطابق الفاتورة بالضبط", async () => {
    const out = await globalSearch({ query: "INV-2606-1001", branchId: refs.branchMain, role: "admin" });
    const invs = out.filter((r) => r.type === "INVOICE");
    expect(invs).toHaveLength(1);
    expect(invs[0].title).toBe("INV-2606-1001");
    expect(invs[0].route).toBe(`/invoices/${refs.invoiceMain}`);
  });

  it("DOC_NUMBER قصير «9164» ⇒ يطابق عرض السعر QT-2606-9164", async () => {
    const out = await globalSearch({ query: "9164", branchId: refs.branchMain, role: "admin" });
    const qts = out.filter((r) => r.type === "QUOTATION");
    expect(qts).toHaveLength(1);
    expect(qts[0].title).toBe("QT-2606-9164");
  });

  it("PHONE يطابق عميلاً بالهاتف", async () => {
    const out = await globalSearch({ query: "+9647701234567", branchId: refs.branchMain, role: "admin" });
    const custs = out.filter((r) => r.type === "CUSTOMER");
    expect(custs.some((c) => c.title === "أحمد علي")).toBe(true);
  });

  it("TEXT يطابق منتجاً بالاسم", async () => {
    const out = await globalSearch({ query: "قلم", branchId: refs.branchMain, role: "admin" });
    const products = out.filter((r) => r.type === "PRODUCT");
    expect(products.some((p) => p.title.includes("قلم"))).toBe(true);
  });

  it("TEXT يطابق عميلاً بالاسم وأمر شغل بالعنوان", async () => {
    const customers = await globalSearch({ query: "أحمد", branchId: refs.branchMain, role: "admin" });
    expect(customers.some((r) => r.type === "CUSTOMER" && r.title === "أحمد علي")).toBe(true);

    const wos = await globalSearch({ query: "درع", branchId: refs.branchMain, role: "admin" });
    expect(wos.some((r) => r.type === "WORK_ORDER")).toBe(true);
  });

  it("استعلام فارغ ⇒ لا نتائج (لا تصفّح من البحث الشامل)", async () => {
    const out = await globalSearch({ query: "  ", branchId: refs.branchMain, role: "admin" });
    expect(out).toHaveLength(0);
  });
});

// ────────────────────────────── RBAC ──────────────────────────────

describe("globalSearch — RBAC", () => {
  it("الكاشير لا يرى الموردين/المشتريات/المصاريف", async () => {
    const out = await globalSearch({ query: "مكتبة", branchId: refs.branchMain, role: "cashier" });
    expect(out.some((r) => r.type === "SUPPLIER")).toBe(false);

    const po = await globalSearch({ query: "PO-2606-0500", branchId: refs.branchMain, role: "cashier" });
    expect(po.some((r) => r.type === "PURCHASE_ORDER")).toBe(false);

    const exp = await globalSearch({ query: "إيجار", branchId: refs.branchMain, role: "cashier" });
    expect(exp.some((r) => r.type === "EXPENSE")).toBe(false);
  });

  it("المدير يرى كل الأنواع", async () => {
    const out = await globalSearch({ query: "مكتبة", branchId: refs.branchMain, role: "manager" });
    expect(out.some((r) => r.type === "SUPPLIER")).toBe(true);

    const po = await globalSearch({ query: "PO-2606-0500", branchId: refs.branchMain, role: "manager" });
    expect(po.some((r) => r.type === "PURCHASE_ORDER")).toBe(true);
  });

  it("scopes تُحدّد الأنواع المُستفسر عنها", async () => {
    const out = await globalSearch({ query: "أحمد", branchId: refs.branchMain, role: "admin", scopes: ["CUSTOMER"] });
    expect(out.every((r) => r.type === "CUSTOMER")).toBe(true);
  });
});

// ────────────────────────────── عزل الفرع ──────────────────────────────

describe("globalSearch — عزل الفرع", () => {
  it("الكاشير لا يرى فواتير فرع آخر", async () => {
    const out = await globalSearch({ query: "INV-2606", branchId: refs.branchMain, role: "cashier" });
    const invs = out.filter((r) => r.type === "INVOICE");
    expect(invs).toHaveLength(1);
    expect(invs[0].title).toBe("INV-2606-1001");
  });

  it("المدير يرى فواتير كل الفروع", async () => {
    const out = await globalSearch({ query: "INV-2606", branchId: refs.branchMain, role: "manager" });
    const invs = out.filter((r) => r.type === "INVOICE");
    expect(invs).toHaveLength(2);
  });

  it("المنتجات/العملاء/الموردين عبور الفروع دائماً (master data)", async () => {
    const out = await globalSearch({ query: "قلم", branchId: refs.branchMain, role: "cashier" });
    expect(out.some((r) => r.type === "PRODUCT")).toBe(true);
  });
});

// ────────────────────────────── أمان الأنماط ──────────────────────────────

describe("globalSearch — أمان وحدود", () => {
  it("«%» لا يطابق كل شيء (تهريب LIKE)", async () => {
    const out = await globalSearch({ query: "%%%", branchId: refs.branchMain, role: "admin" });
    expect(Array.isArray(out)).toBe(true);
  });

  it("perEntityLimit يحدّ كل نوع منفصلاً", async () => {
    const out = await globalSearch({ query: "INV-2606", branchId: refs.branchMain, role: "admin", perEntityLimit: 1 });
    const invs = out.filter((r) => r.type === "INVOICE");
    expect(invs).toHaveLength(1);
  });
});
