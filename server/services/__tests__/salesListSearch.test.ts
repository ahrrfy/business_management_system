// sales.list — البحث النصّي الخادميّ (q) والترقيم بـoffset.
//
// الخلل المُعالَج: الشاشة كانت تُحمّل ٢٠٠ صفّاً بلا offset وتبحث فيها **محلّياً** ⇒ فاتورة أقدم
// من السقف تُعطي «لا نتائج» وهي موجودة، وصفحاتها غير قابلة للوصول أصلاً. الثوابت هنا:
//   ب١) q يطال كل المطابق للفلتر لا الصفحة الأولى وحدها (فاتورة خارج الصفحة الأولى تُوجَد).
//   ب٢) q يطابق رقم الفاتورة **واسم العميل**، والاسم مطبَّع عربياً («احمد» يجد «أحمد» — D2).
//   ب٣) listSummary.count يطابق عدد صفوف list تحت نفس q (وإلا كذب الترقيم: «من N» ≠ الواقع).
//   ب٤) offset يتنقّل بلا تكرار ولا فقد.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { createSale } from "../saleService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1 };

function adminCtx(): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}
const caller = () => appRouter.createCaller(adminCtx());

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "10.00" }]);
  // عميلان: الاسم مهموز ليُختبَر التطبيع العربي عبر searchNorm (عمود مولَّد STORED).
  await d.insert(s.customers).values([
    { id: 1, name: "أحمد التاجر", defaultPriceTier: "RETAIL", currentBalance: "0" },
    { id: 2, name: "زينب للقرطاسية", defaultPriceTier: "RETAIL", currentBalance: "0" },
  ]);
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100000 });
});

/** بيع آجل لعميل محدّد. */
async function sale(customerId: number) {
  return createSale(
    { branchId: 1, customerId, sourceType: "ORDER", lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }] },
    actor,
  );
}

describe("sales.list — بحث خادميّ (q) + ترقيم offset", () => {
  it("ب١+ب٣: فاتورة العميل خارج الصفحة الأولى تُوجَد بالبحث، وcount يطابق صفوف list", async () => {
    // ٦ فواتير لزينب ثمّ واحدة لأحمد أقدمُ منها جميعاً (الترتيب desc بالـid ⇒ أحمد الأخير).
    const ahmed = await sale(1);
    for (let i = 0; i < 6; i++) await sale(2);

    // صفحة أولى بحجم ٣ بلا بحث: أحمد **ليس** فيها (خارج السقف) — هذا هو الوضع الذي كان يكذب.
    const page1 = await caller().sales.list({ limit: 3, offset: 0 });
    expect(page1.map((r) => r.id)).not.toContain(ahmed.invoiceId);

    // البحث الخادميّ يجده رغم أنه خارج الصفحة الأولى.
    const found = await caller().sales.list({ limit: 3, offset: 0, q: "أحمد" });
    expect(found.map((r) => r.id)).toContain(ahmed.invoiceId);
    expect(found).toHaveLength(1);

    // ب٣: الإجمالي المعروض في الترقيم = عدد صفوف list فعلاً تحت نفس q.
    const sum = await caller().sales.listSummary({ q: "أحمد" });
    expect(sum.count).toBe(1);

    const sumZ = await caller().sales.listSummary({ q: "زينب" });
    const allZ = await caller().sales.list({ limit: 100, offset: 0, q: "زينب" });
    expect(sumZ.count).toBe(6);
    expect(allZ).toHaveLength(6);
  });

  it("ب٢: q يطابق رقم الفاتورة، واسم العميل مطبَّعاً عربياً («احمد» بلا همزة يجد «أحمد»)", async () => {
    const inv = await sale(1);
    await sale(2);
    const row = (await db().select().from(s.invoices).where(eq(s.invoices.id, inv.invoiceId)))[0];

    // رقم الفاتورة (مطابقة خام).
    const byNumber = await caller().sales.list({ limit: 10, q: String(row.invoiceNumber) });
    expect(byNumber.map((r) => r.id)).toEqual([inv.invoiceId]);

    // D2: التطبيع العربي — «احمد» (بلا همزة) يجد «أحمد».
    const byFolded = await caller().sales.list({ limit: 10, q: "احمد" });
    expect(byFolded.map((r) => r.id)).toEqual([inv.invoiceId]);
  });

  it("ب٤: offset يتنقّل بلا تكرار ولا فقد، والتجميع = القائمة الكاملة", async () => {
    for (let i = 0; i < 5; i++) await sale(2);
    const all = await caller().sales.list({ limit: 100, offset: 0 });
    expect(all).toHaveLength(5);

    const p1 = await caller().sales.list({ limit: 2, offset: 0 });
    const p2 = await caller().sales.list({ limit: 2, offset: 2 });
    const p3 = await caller().sales.list({ limit: 2, offset: 4 });
    expect([...p1, ...p2, ...p3].map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(new Set([...p1, ...p2, ...p3].map((r) => r.id)).size).toBe(5); // لا تكرار
    expect(p3).toHaveLength(1);
  });

  it("بحث بلا مطابقة يعيد فراغاً وcount=0 (لا يتسرّب كل الصفوف عند q غير مطابق)", async () => {
    await sale(1);
    await sale(2);
    const none = await caller().sales.list({ limit: 10, q: "لا-يوجد-هذا-الاسم" });
    expect(none).toEqual([]);
    expect((await caller().sales.listSummary({ q: "لا-يوجد-هذا-الاسم" })).count).toBe(0);
  });

  it("q يهرب من محارف LIKE («%») فلا يتحوّل لمحرف بدل يطابق الكل", async () => {
    await sale(1);
    await sale(2);
    const pct = await caller().sales.list({ limit: 10, q: "%" });
    expect(pct).toEqual([]); // لو لم يُهرَّب لأعاد الفاتورتين
  });
});
