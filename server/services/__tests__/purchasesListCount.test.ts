// purchases.listCount — الإجمالي الذي يقود ترقيم شاشة المشتريات («عرض ١–٥٠ من N»).
//
// لماذا موجود: القائمة كانت تُحمَّل ٢٠٠ صفّاً بلا offset، والشاشة تعرض rows.length كـ«العدد».
// بعد الترقيم صار rows.length = طول الصفحة ⇒ يلزم عدّ خادميّ حقيقيّ. الخطر أن ينحرف العدّ عن
// الصفوف (فيقول «من ١٠٠» ويعرض ٨٠) أو أن **يتجاوز عزل الفرع** فيُسرّب حجم فرعٍ آخر.
// الثوابت:
//   ع١) listCount = عدد صفوف list تحت نفس الفلتر (بحث/حالة/مورد) — مطابقة بالبناء.
//   ع٢) عزل الفرع يسري على العدّ كما يسري على الصفوف (لا تسريب حجم فرع آخر لمستخدم مقيَّد).
//   ع٣) البحث q يُهرَّب من محارف LIKE في العدّ أيضاً (لا «%» يعدّ الكل).
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { appRouter } from "../../routers";
import { getDb } from "../../db";
import { createPurchaseOrder } from "../purchaseService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

/** سياق مستخدم — الأدمن بلا عزل (كل الفروع)؛ مدير المخزن مقيَّد بفرعه. */
function ctxFor(role: string, branchId: number | null, id = 1): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id, role, branchId, name: "t", email: `${id}@t`, isActive: true } as unknown as TrpcContext["user"],
  };
}
const callerAs = (role: string, branchId: number | null, id = 1) =>
  appRouter.createCaller(ctxFor(role, branchId, id));

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices",
  "productUnits", "productVariants", "products", "suppliers", "branches", "users", "auditLogs",
];

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "a", name: "admin", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "w", name: "warehouse", role: "warehouse", loginMethod: "local", branchId: 2 },
  ]);
  await d.insert(s.suppliers).values([
    { id: 1, name: "مكتبة النور", currentBalance: "0" },
    { id: 2, name: "شركة الورق", currentBalance: "0" },
  ]);
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true });
});

/** أمر شراء في فرع/مورد محدّدين. */
async function po(branchId: number, supplierId: number) {
  return createPurchaseOrder(
    { supplierId, branchId, items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitCost: "1000" }] },
    { userId: 1, branchId },
  );
}

describe("purchases.listCount — الإجمالي يقود الترقيم", () => {
  it("ع١: العدّ = عدد صفوف list تحت نفس الفلتر (بلا فلتر، وبمورد، وببحث)", async () => {
    await po(1, 1); await po(1, 1); await po(1, 2);

    const all = await callerAs("admin", null).purchases.list({ limit: 100 });
    expect((await callerAs("admin", null).purchases.listCount()).count).toBe(all.length);
    expect(all).toHaveLength(3);

    // فلتر المورد.
    const byS1 = await callerAs("admin", null).purchases.list({ limit: 100, supplierId: 1 });
    expect((await callerAs("admin", null).purchases.listCount({ supplierId: 1 })).count).toBe(byS1.length);
    expect(byS1).toHaveLength(2);

    // بحث باسم المورد.
    const byQ = await callerAs("admin", null).purchases.list({ limit: 100, q: "الورق" });
    expect((await callerAs("admin", null).purchases.listCount({ q: "الورق" })).count).toBe(byQ.length);
    expect(byQ).toHaveLength(1);
  });

  it("ع١: العدّ يبقى ثابتاً عبر الصفحات ويطابق التجميع (لا يتبع طول الصفحة)", async () => {
    for (let i = 0; i < 5; i++) await po(1, 1);
    const total = (await callerAs("admin", null).purchases.listCount()).count;
    expect(total).toBe(5);

    const p1 = await callerAs("admin", null).purchases.list({ limit: 2, offset: 0 });
    const p2 = await callerAs("admin", null).purchases.list({ limit: 2, offset: 2 });
    const p3 = await callerAs("admin", null).purchases.list({ limit: 2, offset: 4 });
    expect(p1).toHaveLength(2);
    expect(p3).toHaveLength(1);
    expect([...p1, ...p2, ...p3]).toHaveLength(total);
    expect(new Set([...p1, ...p2, ...p3].map((r) => r.id)).size).toBe(total); // لا تكرار
  });

  it("ع٢: عزل الفرع يسري على العدّ (مستخدم فرع ٢ لا يرى — ولا يَعُدّ — أوامر فرع ١)", async () => {
    await po(1, 1); await po(1, 1); // فرع ١
    await po(2, 1);                 // فرع ٢

    const wRows = await callerAs("warehouse", 2, 2).purchases.list({ limit: 100 });
    const wCount = (await callerAs("warehouse", 2, 2).purchases.listCount()).count;
    expect(wRows).toHaveLength(1);
    expect(wCount).toBe(1); // لا ٣ — العدّ لا يتجاوز العزل

    // ولا يستطيع تجاوزه بتمرير branchId صريح لفرع آخر.
    const spoof = (await callerAs("warehouse", 2, 2).purchases.listCount({ branchId: 1 })).count;
    expect(spoof).toBe(1);

    // الأدمن (بلا عزل) يرى الثلاثة.
    expect((await callerAs("admin", null).purchases.listCount()).count).toBe(3);
  });

  it("ع٣: «%» في البحث تُهرَّب في العدّ (لا تعدّ الكل)", async () => {
    await po(1, 1); await po(1, 2);
    expect((await callerAs("admin", null).purchases.listCount({ q: "%" })).count).toBe(0);
  });
});
