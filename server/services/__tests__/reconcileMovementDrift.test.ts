/**
 * P1-#3-ب: كاشف انحراف الحركات ↔ الرصيد في `reconcileInventory` (تقرير المراجعة ٢٥/٨).
 *
 * الثابتُ المُتحقَّق: لكل (متغيّر × فرع)، `Σ signedDelta = branchStock.quantity`.
 * صار ممكناً بعد P1-#3-أ (عمود signedDelta على كل حركة). هذا الكاشف يُظهر:
 *   - تحديثاً مباشراً على branchStock بلا حركة (خرقٌ للطبقة الخدميّة).
 *   - حركةً فُقدت (إخفاق معاملة).
 *   - فسادَ بيانات تراكمي.
 * صفوفٌ بـsignedDelta = NULL (قبل هجرة 0265) تُوسَم صراحةً بدل ابتلاعها.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { reconcileInventory } from "../reconcileService";
import { applyMovement } from "../inventoryService";
import { withTx } from "../tx";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "inventoryMovements",
  "branchStock",
  "productVariants",
  "products",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seed() {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values({
    id: 1,
    openId: "u-admin",
    name: "أدمن",
    role: "admin",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.products).values({ id: 1, name: "قلم" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" });
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

const drifts = (issues: Array<{ entity: string }>) => issues.filter((i) => i.entity === "movementDrift");

describe("movementDrift detector (P1-#3-ب)", () => {
  it("مطابقة كاملة عبر applyMovement ⇒ لا drift", async () => {
    // نُنشئ الرصيد عبر حركاتٍ مشروعة (5+ ثمّ 3-) ⇒ الرصيد 2 = Σ signedDelta.
    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "IN", baseQuantity: 5, referenceType: "TEST", createdBy: 1,
    }));
    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "OUT", baseQuantity: 3, referenceType: "TEST", createdBy: 1,
    }));
    const issues = await reconcileInventory();
    expect(drifts(issues)).toHaveLength(0);
  });

  it("رصيدٌ يدويّ بلا حركة ⇒ drift مكشوف بـexpected=0", async () => {
    // نضع branchStock مباشرة (خرقُ الطبقة الخدميّة).
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 20 });
    const issues = await reconcileInventory();
    const d = drifts(issues);
    expect(d).toHaveLength(1);
    expect(d[0].id).toBe(1);
    expect(d[0].expected).toBe("0");
    expect(d[0].actual).toBe("20");
    expect(d[0].drift).toBe("20");
    expect(d[0].note ?? "").toMatch(/فرع 1/);
    expect(d[0].note ?? "").toMatch(/انحراف حقيقيّ/);
  });

  it("تحديثٌ مباشر على branchStock بعد حركة ⇒ drift بـexpected حركة و actual المحدَّث", async () => {
    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "IN", baseQuantity: 10, referenceType: "TEST", createdBy: 1,
    }));
    // نُغيّر الرصيد يدوياً بلا حركة (سيناريو الخرق).
    await db().update(s.branchStock)
      .set({ quantity: 15 })
      .where(and(eq(s.branchStock.variantId, 1), eq(s.branchStock.branchId, 1)));
    const issues = await reconcileInventory();
    const d = drifts(issues);
    expect(d).toHaveLength(1);
    expect(d[0].expected).toBe("10");
    expect(d[0].actual).toBe("15");
    expect(d[0].drift).toBe("5");
  });

  it("حركةٌ بلا signedDelta (صفٌّ قديم قبل الهجرة) ⇒ يُظهرها الكاشف بوسم صريح", async () => {
    // نُنشئ ADJUST مباشرةً بلا signedDelta — يحاكي صفّاً قبل 0265.
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 5 });
    await db().insert(s.inventoryMovements).values({
      variantId: 1, branchId: 1, movementType: "ADJUST", quantity: 5,
      // signedDelta = null صراحةً (نمط الصفوف القديمة قبل الهجرة)
      signedDelta: null, referenceType: "ADJUST", notes: "ملاحظة بلا وسم", createdBy: 1,
    });
    const issues = await reconcileInventory();
    const d = drifts(issues);
    expect(d).toHaveLength(1);
    // signedDelta=null فينزل بـSUM إلى 0 ⇒ expected=0، actual=5.
    expect(d[0].expected).toBe("0");
    expect(d[0].actual).toBe("5");
    // الوسم يُبلَّغ عن السبب.
    expect(d[0].note ?? "").toMatch(/بلا signedDelta/);
    expect(d[0].note ?? "").toMatch(/غير حاسم/);
  });

  it("رصيد صفر + Σ صفر ⇒ لا يظهر (HAVING يُصفّي الصحيح)", async () => {
    // (variantId,branchId) بلا رصيد ولا حركة — لا يظهر أصلاً في NEG أو DRIFT.
    const issues = await reconcileInventory();
    expect(issues).toHaveLength(0);
  });

  it("رصيد صفر مع حركاتٍ متعادلة (5+ و 5-) ⇒ لا drift", async () => {
    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "IN", baseQuantity: 5, referenceType: "TEST", createdBy: 1,
    }));
    await withTx((tx) => applyMovement(tx, {
      variantId: 1, branchId: 1, movementType: "OUT", baseQuantity: 5, referenceType: "TEST", createdBy: 1,
    }));
    const issues = await reconcileInventory();
    expect(drifts(issues)).toHaveLength(0);
  });

  it("(variantId, branchId) في الحركات فقط بلا branchStock ⇒ لا يظهر (LEFT JOIN من branchStock)", async () => {
    // بنيةُ التقرير من branchStock ⇒ حركةٌ يتيمة (بلا صفّ رصيد) لا يُشتكى منها.
    // هذا مقصود: الأولوية للأرصدة الحيّة، والحركات اليتيمة لا تُشكّل خطراً مالياً مباشراً
    // (لا رصيد يُعرَض/يُباع). كاشفٌ أوسع (movement without stock row) شريحةٌ لاحقة إن لزم.
    await db().insert(s.inventoryMovements).values({
      variantId: 1, branchId: 1, movementType: "IN", quantity: 7, signedDelta: 7,
      referenceType: "TEST", createdBy: 1,
    });
    const issues = await reconcileInventory();
    // لا branchStock ⇒ لا صفّ في التقرير.
    expect(issues).toHaveLength(0);
  });

  it("رصيدٌ سالبٌ + انحراف حركاتٍ في نفس الصفّ ⇒ يظهر مرّتَين (كاشفان مستقلَّان)", async () => {
    // نضع رصيداً سالباً بلا حركات — يظهر كـstock (negative) وكـmovementDrift.
    await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: -3 });
    const issues = await reconcileInventory();
    const stocks = issues.filter((i) => i.entity === "stock");
    const d = drifts(issues);
    expect(stocks).toHaveLength(1);
    expect(d).toHaveLength(1);
    // لا اجتزال بينهما — كل كاشف يُبلّغ عن مجاله بلا لبس.
    expect(stocks[0].id).toBe(1);
    expect(d[0].id).toBe(1);
  });
});
