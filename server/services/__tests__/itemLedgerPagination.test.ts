// ترقيم بطاقة الصنف (Kardex): البطاقة كانت تُعيد كل حركات المتغيّر مدى الحياة في حمولة واحدة
// (صنف قديم كثير الحركة ⇒ تجمّد الشاشة). الرصيد فيها **تراكميّ** فلا يصحّ قصّه بـLIMIT وحده:
// رصيد أول صفّ في صفحةٍ ما يعتمد كلَّ ما قبله. هذه الاختبارات تُثبّت الثوابت الثلاثة:
//   ط١) الرصيد المتحرّك عبر الصفحات = نفسه بلا ترقيم (لا تصفير عند حدّ الصفحة).
//   ط٢) openingBalance/closingBalance/total مقاييس **للنطاق كلّه** لا للصفحة المعروضة.
//   ط٣) صافي «ما قبل الصفحة» يحترم إشارة ADJUST (INV-001) — تخطّي تسوية هابطة لا يَنفخ الرصيد.
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { setStock } from "../inventoryService";
import { getItemLedger } from "../reportsInventoryAnalyticsService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

/** خمس تسويات متتالية ⇒ أرصدة متحرّكة معروفة: 100, 60, 90, 50, 70 (فيها هابطتان). */
const EXPECTED_BALANCES = [100, 60, 90, 50, 70];

beforeEach(async () => {
  await truncateTables(["inventoryMovements", "branchStock", "productVariants", "products", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "4.00" });

  for (const target of [100, 60, 90, 50, 70]) {
    await withTx((tx) => setStock(tx, { variantId: 1, branchId: 1, targetQuantity: target, createdBy: 1 }));
  }
});

describe("ترقيم بطاقة الصنف — الرصيد المتحرّك لا ينكسر عند حدّ الصفحة", () => {
  it("بلا ترقيم: خمس حركات بأرصدة متحرّكة معروفة + total = عدد النطاق", async () => {
    const led = await getItemLedger({ variantId: 1, branchId: 1 });
    expect(led.rows.map((r) => r.balance)).toEqual(EXPECTED_BALANCES);
    expect(led.total).toBe(5);
    expect(led.closingBalance).toBe(70);
    expect(led.openingBalance).toBe(0); // بلا from ⇒ الافتتاحي صفر
  });

  it("ط١+ط٣: الصفحة الثانية تُكمل الرصيد من حيث انتهت الأولى (وقد تخطّت تسويةً هابطة)", async () => {
    const p1 = await getItemLedger({ variantId: 1, branchId: 1, limit: 2, offset: 0 });
    expect(p1.rows.map((r) => r.balance)).toEqual([100, 60]);

    // الحاسم: offset=2 يتخطّى (+100) و(−40). لو جُمعت المطلقات لصار الافتتاحي 140 ⇒ 170/130.
    const p2 = await getItemLedger({ variantId: 1, branchId: 1, limit: 2, offset: 2 });
    expect(p2.rows.map((r) => r.balance)).toEqual([90, 50]);

    const p3 = await getItemLedger({ variantId: 1, branchId: 1, limit: 2, offset: 4 });
    expect(p3.rows.map((r) => r.balance)).toEqual([70]);

    // تجميع الصفحات = القائمة الكاملة بالضبط (لا صفّ مفقود ولا مكرّر ولا رصيد منحرف).
    expect([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.balance)).toEqual(EXPECTED_BALANCES);
    expect([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id)).toEqual(
      (await getItemLedger({ variantId: 1, branchId: 1 })).rows.map((r) => r.id),
    );
  });

  it("ط٢: closingBalance/total للنطاق كلّه لا للصفحة (وإلا كذبت مؤشّرات البطاقة)", async () => {
    const p1 = await getItemLedger({ variantId: 1, branchId: 1, limit: 2, offset: 0 });
    // الصفحة الأولى تنتهي عند رصيد 60، لكن ختامي **النطاق** 70 وعدده 5.
    expect(p1.rows.at(-1)?.balance).toBe(60);
    expect(p1.closingBalance).toBe(70);
    expect(p1.total).toBe(5);

    const p2 = await getItemLedger({ variantId: 1, branchId: 1, limit: 2, offset: 2 });
    expect(p2.closingBalance).toBe(70);
    expect(p2.total).toBe(5);
  });

  it("صفحة بعد النهاية تعود فارغة بلا انفجار (total يظلّ صادقاً)", async () => {
    const beyond = await getItemLedger({ variantId: 1, branchId: 1, limit: 2, offset: 999 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(5);
    expect(beyond.closingBalance).toBe(70);
  });

  it("مع نافذة from: الافتتاحي (ما قبل النافذة) + صافي ما قبل الصفحة يتراكبان صحيحاً", async () => {
    // نافذة تبدأ اليوم ⇒ كل الحركات داخلها (أُنشئت للتوّ) والافتتاحي صفر.
    const today = new Date().toISOString().slice(0, 10);
    const p2 = await getItemLedger({ variantId: 1, branchId: 1, from: today, limit: 2, offset: 2 });
    expect(p2.openingBalance).toBe(0);
    expect(p2.rows.map((r) => r.balance)).toEqual([90, 50]);
    expect(p2.closingBalance).toBe(70);

    // نافذة مستقبلية ⇒ كل الحركات قبلها ⇒ الافتتاحي = 70 والنطاق فارغ.
    const future = await getItemLedger({ variantId: 1, branchId: 1, from: "2999-01-01", limit: 2, offset: 0 });
    expect(future.openingBalance).toBe(70);
    expect(future.rows).toEqual([]);
    expect(future.total).toBe(0);
    expect(future.closingBalance).toBe(70);
  });
});
