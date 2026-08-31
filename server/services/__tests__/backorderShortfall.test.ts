import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { listBackorderShortfall } from "../inventory/backorderShortfall";

/**
 * «المُسنَد المطلوب توريده» — الشاشة تُجيب «كم أطلب الآن؟»، فالرقم الحاكم ليس الرصيد السالب
 * بل **الصافي المطلوب** = |السالب| − ما هو قيد الشراء.
 *
 * ⭐ أخطر ما تحرسه هذه الحزمة هو حالة **المسوَّدة**: استبعادُها من «قيد الشراء» يُظهر حاجةً
 * كاملةً لصنفٍ سبق أن جهّز له المديرُ أمرَ شراء ⇒ **طلبٌ مكرَّر للمورّد**. والخطأ صامتٌ
 * تماماً: الشاشة تبدو صحيحة، والرقم معقول، والمورّد يشحن مرّتين.
 */

const TABLES = [
  "auditLogs",
  "purchaseOrderItems",
  "purchaseOrders",
  "inventoryMovements",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "users",
  "branches",
];

const PLAIN = 1; // صنفٌ عاديّ سالب — يجب ألّا يظهر أصلاً
const BACKORDER = 2; // «يُباع بالطلب» — موضوع الشاشة

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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({
    id: 1, openId: "local_admin", name: "المدير", email: "admin@m.test",
    role: "admin", loginMethod: "local", branchId: 1,
  });
  await d.insert(s.suppliers).values({ id: 1, name: "مطبعة الشريك", isActive: true });
  await d.insert(s.products).values([
    { id: PLAIN, name: "دفتر ٤٠ ورقة" },
    { id: BACKORDER, name: "طباعة بوستر A0", allowBackorder: true },
  ]);
  await d.insert(s.productVariants).values([
    { id: PLAIN, productId: PLAIN, sku: "NOTE-40", costPrice: "500.00" },
    { id: BACKORDER, productId: BACKORDER, sku: "PRINT-A0", costPrice: "7000.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: PLAIN, variantId: PLAIN, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: BACKORDER, variantId: BACKORDER, unitName: "نسخة", conversionFactor: "1", isBaseUnit: true },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: PLAIN, branchId: 1, quantity: -4 }, // سالبٌ تاريخيّ لصنفٍ عاديّ
    { variantId: BACKORDER, branchId: 1, quantity: -10 },
  ]);
}

/** أمر شراء مفتوح/مغلق بحالةٍ ما، بكمّيةٍ ومستلَمٍ منها. */
async function addPurchaseOrder(
  id: number,
  status: "DRAFT" | "SENT" | "CONFIRMED" | "RECEIVED" | "CANCELLED",
  baseQuantity: number,
  receivedBaseQuantity = 0,
  branchId = 1,
) {
  const d = db();
  await d.insert(s.purchaseOrders).values({
    id, supplierId: 1, branchId, status, poNumber: `PO-${id}`,
    subtotal: "0.00", total: "0.00", createdBy: 1,
  });
  await d.insert(s.purchaseOrderItems).values({
    purchaseOrderId: id, variantId: BACKORDER, productUnitId: BACKORDER,
    quantity: baseQuantity, baseQuantity, receivedBaseQuantity,
    unitPrice: "7000.00", total: String(7000 * baseQuantity),
  });
}

describe("المُسنَد المطلوب توريده", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("يعرض الموسوم «يُباع بالطلب» وحده — سالبُ صنفٍ عاديّ ليس التزامَ توريدٍ بل عجزٌ يُجرَد", async () => {
    const res = await listBackorderShortfall({ branchId: 1, includeCost: true });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.variantId).toBe(BACKORDER);
    expect(res.total).toBe(1);
  });

  it("بلا أمر شراء: الصافي المطلوب = كامل العجز", async () => {
    const [row] = (await listBackorderShortfall({ branchId: 1, includeCost: true })).rows;
    expect(row!.shortfallBase).toBe(10);
    expect(row!.onOrderBase).toBe(0);
    expect(row!.netNeededBase).toBe(10);
    expect(row!.quantity).toBe(-10); // الإشارة لا تُخفى
  });

  it("⭐ المسوَّدة تُحتسَب قيد الشراء — استبعادُها يُنتج طلباً مكرَّراً للمورّد", async () => {
    await addPurchaseOrder(1, "DRAFT", 6);
    const [row] = (await listBackorderShortfall({ branchId: 1 })).rows;
    expect(row!.onOrderBase).toBe(6);
    expect(row!.netNeededBase).toBe(4);
  });

  it("المُرسَل والمؤكَّد يتراكمان مع المسوَّدة", async () => {
    await addPurchaseOrder(1, "DRAFT", 2);
    await addPurchaseOrder(2, "SENT", 3);
    await addPurchaseOrder(3, "CONFIRMED", 1);
    const [row] = (await listBackorderShortfall({ branchId: 1 })).rows;
    expect(row!.onOrderBase).toBe(6);
    expect(row!.netNeededBase).toBe(4);
  });

  it("المستلَم والملغى لا يُحتسبان — الأوّل رفع الرصيد سلفاً والثاني بلا أثر", async () => {
    await addPurchaseOrder(1, "RECEIVED", 5, 5);
    await addPurchaseOrder(2, "CANCELLED", 5);
    const [row] = (await listBackorderShortfall({ branchId: 1 })).rows;
    expect(row!.onOrderBase).toBe(0);
    expect(row!.netNeededBase).toBe(10);
  });

  it("الاستلام الجزئيّ يُحتسب بالمتبقّي وحده لا بالكمّية الكاملة", async () => {
    await addPurchaseOrder(1, "CONFIRMED", 8, 5); // بقي ٣
    const [row] = (await listBackorderShortfall({ branchId: 1 })).rows;
    expect(row!.onOrderBase).toBe(3);
    expect(row!.netNeededBase).toBe(7);
  });

  it("تغطيةٌ زائدة لا تُنتج صافياً سالباً — «مغطّى» حالةٌ لا رقمٌ تحت الصفر", async () => {
    await addPurchaseOrder(1, "CONFIRMED", 25);
    const [row] = (await listBackorderShortfall({ branchId: 1 })).rows;
    expect(row!.onOrderBase).toBe(25);
    expect(row!.netNeededBase).toBe(0);
    expect((await listBackorderShortfall({ branchId: 1 })).totalNetNeededBase).toBe(0);
  });

  it("أمرُ شراءٍ لفرعٍ آخر لا يُغطّي عجز هذا الفرع — البضاعة تصل هناك لا هنا", async () => {
    await addPurchaseOrder(1, "CONFIRMED", 10, 0, 2);
    const [row] = (await listBackorderShortfall({ branchId: 1 })).rows;
    expect(row!.onOrderBase).toBe(0);
    expect(row!.netNeededBase).toBe(10);
  });

  it("التكلفة تُحجَب حين لا يملك القارئ رؤيتها — الشاشة تبقى مفيدة بلا كشف الهامش", async () => {
    const withCost = (await listBackorderShortfall({ branchId: 1, includeCost: true })).rows[0]!;
    expect(withCost.costPrice).toBe("7000.00");
    expect(withCost.shortfallValue).toBe("70000.00");

    const redacted = await listBackorderShortfall({ branchId: 1, includeCost: false });
    expect(redacted.rows[0]!.costPrice).toBeNull();
    expect(redacted.rows[0]!.shortfallValue).toBeNull();
    expect(redacted.totalShortfallValue).toBeNull();
  });

  it("الرصيد الموجب أو الصفريّ يخرج من القائمة — لا التزامَ قائماً عليه", async () => {
    await db()
      .update(s.branchStock)
      .set({ quantity: 0 })
      .where(and(eq(s.branchStock.variantId, BACKORDER), eq(s.branchStock.branchId, 1)));
    const res = await listBackorderShortfall({ branchId: 1 });
    expect(res.rows).toHaveLength(0);
    expect(res.total).toBe(0);
  });

  it("الصنف المعطَّل يبقى ظاهراً — تعطيلُه لا يُلغي التزاماً تجاه زبونٍ دفع", async () => {
    await db().update(s.products).set({ isActive: false }).where(eq(s.products.id, BACKORDER));
    expect((await listBackorderShortfall({ branchId: 1 })).rows).toHaveLength(1);
  });

  it("عزلُ الفرع: طلبُ فرعٍ بعينه لا يُظهر عجز غيره", async () => {
    await db().insert(s.branchStock).values({ variantId: BACKORDER, branchId: 2, quantity: -3 });
    expect((await listBackorderShortfall({ branchId: 2 })).rows[0]!.shortfallBase).toBe(3);
    expect((await listBackorderShortfall({ branchId: null })).rows).toHaveLength(2); // الأدمن يرى الفرعين
  });
});
