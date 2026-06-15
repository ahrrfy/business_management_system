// كشوف الحساب بفترة + رصيد مُرحَّل (B1) — اختبارات تكاملية ضد قاعدة الاختبار:
//   ١) الرصيد المُرحَّل = قيد OPENING + نشاط ما قبل الفترة (فواتير − صافي دفعات).
//   ٢) الفترة تقصّ المستندات على تاريخها هي (دفعة حديثة على فاتورة قديمة تظهر).
//   ٣) السندات المستقلّة (بلا فاتورة) تظهر في الكشف وتؤثّر في المُرحَّل باتجاهها.
//   ٤) بلا from/to ⇒ السلوك القديم نفسه (توافق رجعي).
//   ٥) المورد بالمثل: orderDate للأوامر، entryDate لدفعات PAYMENT_OUT، وDRAFT لا يلتزم.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createSale, processPayment } from "../saleService";
import { createVoucher } from "../voucherService";
import { getCustomerStatement, getSupplierStatement } from "../reportsService";

const actor = { userId: 1, branchId: 1 };

const TABLES = [
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
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 1000 });
  // M5/M8: processPayment CASH يَلزم وردية مفتوحة (يُحلّ shiftId من وردية الموظّف).
  await d.insert(s.shifts).values({
    userId: 1, branchId: 1, status: 'OPEN',
    openedAt: new Date(),
    openGuard: '1:1', openingBalance: '0',
  });
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

/** تاريخ محلي YYYY-MM-DD قبل n يوماً — تواريخ نسبية كي لا تتعفّن الاختبارات مع الزمن. */
function ymdDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const OLD = ymdDaysAgo(100); // قبل بداية الفترة بكثير
const FROM = ymdDaysAgo(30); // بداية الفترة المختبَرة
const TODAY = ymdDaysAgo(0);

/** ترجيع فاتورة إلى الماضي (invoiceDate timestamp). */
async function backdateInvoice(invoiceId: number, ymd: string) {
  await db().update(s.invoices).set({ invoiceDate: new Date(`${ymd}T10:00:00`) }).where(eq(s.invoices.id, invoiceId));
}
/** ترجيع receipts فاتورة إلى الماضي (createdAt هو تاريخ الدفعة في الكشف). */
async function backdateInvoiceReceipts(invoiceId: number, ymd: string) {
  await db().update(s.receipts).set({ createdAt: new Date(`${ymd}T10:00:00`) }).where(eq(s.receipts.invoiceId, invoiceId));
}
/** ترجيع receipt واحد (سند مستقل) إلى الماضي. */
async function backdateReceipt(receiptId: number, ymd: string) {
  await db().update(s.receipts).set({ createdAt: new Date(`${ymd}T10:00:00`) }).where(eq(s.receipts.id, receiptId));
}

/** بيع آجل (ORDER) بعدد درازن — الدرزن 120.00. */
async function creditSale(customerId: number, dozens: string) {
  return createSale(
    { branchId: 1, customerId, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 2, quantity: dozens }] },
    actor
  );
}

describe("كشف حساب العميل بفترة + رصيد مُرحَّل", () => {
  it("الرصيد المُرحَّل = قيد OPENING + فواتير سابقة − دفعات سابقة، والفترة تعرض فواتيرها فقط", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    // قيد OPENING مستورد (import-integration): 1000 لصالحنا.
    await db().insert(s.accountingEntries).values({
      entryType: "OPENING", customerId: 1, amount: "1000.00",
      entryDate: new Date(`${OLD}T00:00:00`), dedupeKey: "OPENING:CUSTOMER:1",
    });
    // نشاط سابق للفترة: فاتورة 240 + دفعة 100.
    const saleA = await creditSale(1, "2"); // 240
    await processPayment({ invoiceId: saleA.invoiceId, amount: "100.00", method: "CASH" }, actor);
    await backdateInvoice(saleA.invoiceId, OLD);
    await backdateInvoiceReceipts(saleA.invoiceId, OLD);
    // نشاط داخل الفترة: فاتورة 120.
    await creditSale(1, "1"); // 120 الآن

    const stmt = await getCustomerStatement(1, { from: FROM });
    expect(stmt).not.toBeNull();
    // 1000 + 240 − 100 = 1140
    expect(stmt!.summary.openingBalance).toBe("1140.00");
    expect(stmt!.invoices).toHaveLength(1);
    expect(stmt!.invoices[0].total).toBe("120.00");
    expect(stmt!.summary.totalSales).toBe("120.00");
    expect(stmt!.payments).toHaveLength(0); // الدفعة قبل الفترة لا تُعرض ضمنها
  });

  it("الفترة تقصّ على تاريخ المستند نفسه: دفعة حديثة على فاتورة قديمة تظهر والفاتورة لا", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const saleA = await creditSale(1, "2"); // 240
    await backdateInvoice(saleA.invoiceId, OLD);
    // الدفعة الآن (داخل الفترة) على الفاتورة القديمة.
    await processPayment({ invoiceId: saleA.invoiceId, amount: "100.00", method: "CASH" }, actor);

    const stmt = await getCustomerStatement(1, { from: FROM, to: TODAY });
    expect(stmt!.invoices).toHaveLength(0);
    expect(stmt!.payments).toHaveLength(1);
    expect(stmt!.payments[0].amount).toBe("100.00");
    // الفاتورة قبل الفترة كاملة في المُرحَّل (الدفعة بعد from فلا تُخصم منه).
    expect(stmt!.summary.openingBalance).toBe("240.00");
  });

  it("السند المستقل يظهر في الكشف ويؤثّر في المُرحَّل باتجاهه (IN ينقص، OUT يزيد)", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const saleA = await creditSale(1, "2"); // 240
    await backdateInvoice(saleA.invoiceId, OLD);
    // سند قبض مستقل 50 (ينقص ذمته) + سند صرف مستقل 20 (يزيدها) — كلاهما قبل الفترة.
    const vIn = await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "50.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "دفعة على الحساب" },
      actor
    );
    const vOut = await createVoucher(
      { voucherType: "PAYMENT", branchId: 1, amount: "20.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "صرف للعميل" },
      actor
    );

    // بلا فترة: السندان يظهران موسومَين مستقلَّين (إصلاح علّة غيابهما عن الكشف).
    const all = await getCustomerStatement(1);
    expect(all!.payments).toHaveLength(2);
    expect(all!.payments.every((p) => p.isStandalone)).toBe(true);
    expect(all!.payments.map((p) => p.voucherNumber).every((v) => v != null)).toBe(true);
    // بلا from: المُرحَّل = قيود OPENING فقط (لا قيود هنا).
    expect(all!.summary.openingBalance).toBe("0.00");

    // مع from وسندات قبل الفترة: 240 − 50 + 20 = 210.
    await backdateReceipt(vIn.receiptId, OLD);
    await backdateReceipt(vOut.receiptId, OLD);
    const stmt = await getCustomerStatement(1, { from: FROM });
    expect(stmt!.summary.openingBalance).toBe("210.00");
    expect(stmt!.payments).toHaveLength(0);
    expect(stmt!.invoices).toHaveLength(0);
  });

  it("بلا from/to: السلوك القديم نفسه (فواتير + دفعات + ملخّص) و openingBalance = OPENING فقط", async () => {
    await db().insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0" });
    const sale = await creditSale(1, "2"); // 240
    await processPayment({ invoiceId: sale.invoiceId, amount: "100.00", method: "CASH" }, actor);

    const stmt = await getCustomerStatement(1);
    expect(stmt).not.toBeNull();
    expect(stmt!.invoices).toHaveLength(1);
    expect(stmt!.payments).toHaveLength(1);
    expect(stmt!.payments[0].direction).toBe("IN");
    expect(stmt!.payments[0].isStandalone).toBe(false);
    expect(stmt!.summary.totalSales).toBe("240.00");
    expect(stmt!.summary.totalPaid).toBe("100.00");
    expect(stmt!.summary.unpaid).toBe("140.00");
    expect(stmt!.summary.currentBalance).toBe("140.00");
    expect(stmt!.summary.openingBalance).toBe("0.00");
  });
});

describe("كشف حساب المورد بفترة + رصيد مُرحَّل", () => {
  /** أمر شراء مؤكَّد + استلام (+ دفعة اختيارية). الإجمالي = qty × unitPrice. */
  async function poReceived(supplierId: number, qty: number, unitPrice: string, pay?: string) {
    const po = await createPurchaseOrder(
      { supplierId, branchId: 1, taxRatePercent: "0", status: "CONFIRMED", items: [{ variantId: 1, productUnitId: 1, quantity: String(qty), unitPrice }] },
      actor
    );
    const item = (await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    await receivePurchase(
      {
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: qty }],
        payment: pay ? { amount: pay, method: "CASH" } : undefined,
      },
      actor
    );
    return po;
  }
  async function backdatePO(purchaseOrderId: number, ymd: string) {
    await db().update(s.purchaseOrders).set({ orderDate: new Date(`${ymd}T10:00:00`) }).where(eq(s.purchaseOrders.id, purchaseOrderId));
  }
  async function backdateSupplierPayments(supplierId: number, ymd: string) {
    await db()
      .update(s.accountingEntries)
      .set({ entryDate: new Date(`${ymd}T00:00:00`) })
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.supplierId, supplierId)));
  }

  it("المُرحَّل = OPENING + مشتريات ملتزمة − PAYMENT_OUT قبل from، والفترة تقصّ الأوامر والدفعات", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    await db().insert(s.accountingEntries).values({
      entryType: "OPENING", supplierId: 1, amount: "500.00",
      entryDate: new Date(`${OLD}T00:00:00`), dedupeKey: "OPENING:SUPPLIER:1",
    });
    // نشاط سابق: أمر 500 (استُلم) + دفعة 200 — يُرجَّعان قبل الفترة.
    const poA = await poReceived(1, 100, "5.00", "200.00");
    await backdatePO(poA.purchaseOrderId, OLD);
    await backdateSupplierPayments(1, OLD);
    // نشاط داخل الفترة: أمر 120 بلا دفعة.
    await poReceived(1, 12, "10.00");

    const stmt = await getSupplierStatement(1, { from: FROM, to: TODAY });
    expect(stmt).not.toBeNull();
    // 500 + 500 − 200 = 800
    expect(stmt!.summary.openingBalance).toBe("800.00");
    expect(stmt!.purchaseOrders).toHaveLength(1);
    expect(stmt!.purchaseOrders[0].total).toBe("120.00");
    expect(stmt!.payments).toHaveLength(0); // دفعة 200 قبل الفترة

    // بلا فترة: كل المستندات + المُرحَّل = OPENING فقط (السلوك القديم + الحقل الجديد).
    const all = await getSupplierStatement(1);
    expect(all!.purchaseOrders).toHaveLength(2);
    expect(all!.payments).toHaveLength(1);
    expect(all!.summary.totalPurchases).toBe("620.00");
    expect(all!.summary.totalPaid).toBe("200.00");
    expect(all!.summary.openingBalance).toBe("500.00");
  });

  it("أمر DRAFT قبل from لا يدخل الرصيد المُرحَّل (غير ملتزم مالياً)", async () => {
    await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
    const draft = await createPurchaseOrder(
      { supplierId: 1, branchId: 1, taxRatePercent: "0", status: "DRAFT", items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }] },
      actor
    );
    await backdatePO(draft.purchaseOrderId, OLD);

    const stmt = await getSupplierStatement(1, { from: FROM });
    expect(stmt!.summary.openingBalance).toBe("0.00");
  });
});
