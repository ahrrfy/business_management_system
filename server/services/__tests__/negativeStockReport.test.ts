// تقرير السوالب + وسم reconcile («الافتتاح التدريجي» ١٨/٧) — ش٤:
// الحصر بالسالب بحبيبة (صنف×فرع)، القيمة بالتكلفة، وسم «بلا تكلفة»، حالة الافتتاح،
// الاختفاء بعد الجرد الافتتاحي، فلترة الفرع، ووسم reconcileInventory «متوقع» أثناء النافذة.
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { setStock } from "../inventoryService";
import { getNegativeStock } from "../reportsInventoryOpsService";
import { reconcileInventory } from "../reconcileService";

const DAY_MS = 86_400_000;

const TABLES = [
  "openingModeSettings",
  "inventoryMovements",
  "branchStock",
  "categories",
  "productVariants",
  "products",
  "users",
  "branches",
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
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([{ id: 1, openId: "u_admin", name: "المدير", role: "admin", branchId: 1 }]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم حبر" },
    { id: 2, name: "كراس رسم" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-N1", costPrice: "750.00" },
    { id: 2, productId: 2, sku: "SKB-1", costPrice: "0.00" }, // بلا تكلفة — وسم تحذيري
  ]);
}
beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("تقرير السوالب — reports.negativeStock", () => {
  it("يعرض فقط (صنف×فرع) برصيد سالب: القيمة بالتكلفة + وسم بلا تكلفة + حالة الافتتاح + الترتيب بالانكشاف", async () => {
    const d = db();
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: -4 }, // انكشاف 3000 — غير مُفتتَح
      { variantId: 2, branchId: 1, quantity: -10, openedAt: new Date() }, // تكلفة صفر — مُفتتَح (عجز بعد الافتتاح)
      { variantId: 1, branchId: 2, quantity: 7 }, // موجب — لا يظهر (ولا يُعاوض سالب الفرع الآخر)
    ]);
    // حركة بيع أخيرة للصنف ١ (تظهر كآخر بيع).
    await d.insert(s.inventoryMovements).values({
      variantId: 1,
      branchId: 1,
      movementType: "OUT",
      quantity: 4,
      referenceType: "INVOICE",
      referenceId: 55,
    });

    const res = await getNegativeStock({});
    expect(res.summary.count).toBe(2);
    expect(res.summary.totalNegValue).toBe("3000.00"); // 4×750 + 10×0
    expect(res.summary.missingCostCount).toBe(1);
    expect(res.summary.unopenedCount).toBe(1);

    // الترتيب: الأعلى انكشافاً أولاً.
    expect(res.rows[0].variantId).toBe(1);
    expect(res.rows[0].quantity).toBe("-4");
    expect(res.rows[0].negValue).toBe("3000.00");
    expect(res.rows[0].opened).toBe(false);
    expect(res.rows[0].lastSaleDate).not.toBeNull();

    const r2 = res.rows[1];
    expect(r2.variantId).toBe(2);
    expect(r2.costMissing).toBe(true);
    expect(r2.opened).toBe(true);
  });

  it("فلترة الفرع تحصر النتائج به — سالبا الفرعين لا يختلطان", async () => {
    const d = db();
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: -2 },
      { variantId: 1, branchId: 2, quantity: -5 },
    ]);
    const b1 = await getNegativeStock({ branchId: 1 });
    expect(b1.summary.count).toBe(1);
    expect(b1.rows[0].branchId).toBe(1);
    expect(b1.rows[0].quantity).toBe("-2");
    const all = await getNegativeStock({});
    expect(all.summary.count).toBe(2);
  });

  it("الصنف يختفي من التقرير فور اعتماد رصيده الافتتاحي (setStock بمرجع OPENING)", async () => {
    const d = db();
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: -3 });
    expect((await getNegativeStock({})).summary.count).toBe(1);

    // الجرد الافتتاحي وجد ١٢ فعلياً ⇒ ضبط مطلق يبتلع السالب ويختم openedAt.
    await withTx((tx) =>
      setStock(tx, { variantId: 1, branchId: 1, targetQuantity: 12, referenceType: "OPENING", createdBy: 1 }),
    );
    expect((await getNegativeStock({})).summary.count).toBe(0);
  });
});

describe("reconcileInventory — وسم «متوقع» أثناء نافذة الافتتاح", () => {
  it("النافذة فعّالة: السالب غير المُفتتَح يُوسَم؛ والمُفتتَح انحراف حقيقي بلا وسم؛ وبلا نافذة لا وسم لأحد", async () => {
    const d = db();
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: -4 }, // غير مُفتتَح
      { variantId: 2, branchId: 1, quantity: -1, openedAt: new Date() }, // مُفتتَح — عجز حقيقي
    ]);

    // بلا نافذة: صفّان بلا أي وسم.
    let issues = await reconcileInventory();
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.note == null)).toBe(true);

    // نافذة فعّالة: غير المُفتتَح يُوسَم فقط.
    await d.insert(s.openingModeSettings).values({ id: 1, enabled: true, endsAt: new Date(Date.now() + DAY_MS) });
    issues = await reconcileInventory();
    const v1 = issues.find((i) => i.id === 1)!;
    const v2 = issues.find((i) => i.id === 2)!;
    expect(v1.note).toMatch(/متوقع/);
    expect(v2.note).toBeUndefined();

    // النافذة منقضية = كأنها معدومة.
    await d
      .update(s.openingModeSettings)
      .set({ endsAt: new Date(Date.now() - DAY_MS) })
      .where(eq(s.openingModeSettings.id, 1));
    issues = await reconcileInventory();
    expect(issues.every((i) => i.note == null)).toBe(true);
  });
});

describe("عرض السوالب التشغيلي (كميات بلا تكلفة) — inventory.onHand negativeOnly", () => {
  it("الشرط يحصر بالسالب في نطاق الفرع", async () => {
    const d = db();
    await d.insert(s.branchStock).values([
      { variantId: 1, branchId: 1, quantity: -6 },
      { variantId: 2, branchId: 1, quantity: 9 },
    ]);
    // الفحص على مستوى الشرط (الراوتر يمرّ به) — استعلام مطابق لشرط negativeOnly.
    const rows = await d
      .select({ variantId: s.branchStock.variantId, quantity: s.branchStock.quantity })
      .from(s.branchStock)
      .where(and(eq(s.branchStock.branchId, 1), sql`${s.branchStock.quantity} < 0`));
    expect(rows.length).toBe(1);
    expect(Number(rows[0].variantId)).toBe(1);
  });
});
