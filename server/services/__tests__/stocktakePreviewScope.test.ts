/**
 * previewScope: يعكس منطق resolveScope في create.ts حرفياً (FULL/MOVING/CATEGORY)
 * — بدون كتابة. عدّاد الـWizard كان يعتمد `inventory.onHand.length` الذي يعدّ صفوف
 * `branchStock` السابقة فقط ⇒ يُخفي الأصناف التي لم تُلامَس بحركة بعد، وفارقٌ قاتلٌ في
 * الجرد الافتتاحي (عرض ٤٩٠ بدل الآلاف). هذا الملفّ حارس انحدار: أيّ تغيّر في resolveScope
 * يجب أن يُطبَّق هنا أيضاً وإلّا فشلت اختبارات المطابقة.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { previewScope } from "../stocktake/queries";

const TABLES = [
  "stocktakeItemReviewEvents",
  "stocktakeDecisions",
  "stocktakeCountOperations",
  "stocktakeCounts",
  "stocktakeItems",
  "stocktakeAssignments",
  "stocktakeSessions",
  "openingModeSettings",
  "inventoryMovements",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "categories",
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
  await d.insert(s.users).values([
    { id: 1, openId: "u_admin", name: "المدير", role: "admin", loginMethod: "local" },
  ]);
  await d.insert(s.categories).values([
    { id: 10, name: "قرطاسية" },
    { id: 20, name: "ورق" },
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف أزرق", categoryId: 10, isActive: true, isBundle: false, isConsignment: false },
    { id: 2, name: "دفتر ١٠٠ ورقة", categoryId: 20, isActive: true, isBundle: false, isConsignment: false },
    { id: 3, name: "مسطرة", categoryId: 10, isActive: true, isBundle: false, isConsignment: false },
    // منتج غير نشط ⇒ يجب أن يُستبعَد من كل النطاقات
    { id: 4, name: "منتج معطَّل", categoryId: 10, isActive: false, isBundle: false, isConsignment: false },
    // بكج ⇒ يُستبعَد دائماً (NORMAL وOPENING) — resolveScope B7
    { id: 5, name: "بكج مدرسي", categoryId: 10, isActive: true, isBundle: true, isConsignment: false },
    // أمانة ⇒ يُستبعَد في OPENING فقط
    { id: 6, name: "كتاب المعلّم (أمانة)", categoryId: 20, isActive: true, isBundle: false, isConsignment: true },
  ]);
  await d.insert(s.productVariants).values([
    // ٣ متغيّرات (لون/قياس) للقلم — حبيبة الجرد
    { id: 10, productId: 1, sku: "PEN-BLU-S", costPrice: "250.00", isActive: true },
    { id: 11, productId: 1, sku: "PEN-BLU-M", costPrice: "250.00", isActive: true },
    { id: 12, productId: 1, sku: "PEN-BLU-L", costPrice: "250.00", isActive: true },
    // متغيّر واحد لكل من البقية
    { id: 20, productId: 2, sku: "NB-100", costPrice: "1500.00", isActive: true },
    { id: 30, productId: 3, sku: "RUL-1", costPrice: "500.00", isActive: true },
    { id: 40, productId: 4, sku: "OLD-1", costPrice: "100.00", isActive: true }, // منتج معطَّل
    { id: 50, productId: 5, sku: "PKG-1", costPrice: "0.00", isActive: true }, // بكج
    { id: 60, productId: 6, sku: "CONS-1", costPrice: "3000.00", isActive: true }, // أمانة
    // متغيّر معطَّل ⇒ يُستبعَد
    { id: 70, productId: 2, sku: "NB-100-OLD", costPrice: "1500.00", isActive: false },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 10, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 11, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 3, variantId: 12, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 4, variantId: 20, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 5, variantId: 30, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 6, variantId: 40, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 7, variantId: 50, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 8, variantId: 60, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 9, variantId: 70, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

/* ─────────── FULL ─────────── */

describe("previewScope — FULL", () => {
  it("NORMAL: يشمل كل المتغيّرات النشطة لمنتجات نشطة، يستبعد البكج فقط (الأمانة تُشمَل)", async () => {
    const r = await previewScope({ branchId: 1, sessionType: "NORMAL", scopeType: "FULL" });
    // 10,11,12 (قلم × ٣) + 20 (دفتر) + 30 (مسطرة) + 60 (أمانة) = ٦
    // مستبعَد: 40 (منتج غير نشط) + 50 (بكج) + 70 (متغيّر غير نشط)
    expect(r.variantCount).toBe(6);
    // ٤ منتجات أمّ (قلم/دفتر/مسطرة/أمانة)
    expect(r.productCount).toBe(4);
    expect(r.excludedOpened).toBe(0);
    // NORMAL: لا نحسب هذه العدّادات
    expect(r.excludedBundle).toBe(0);
    expect(r.excludedConsignment).toBe(0);
  });

  it("OPENING: يستبعد البكج + الأمانة معاً", async () => {
    const r = await previewScope({ branchId: 1, sessionType: "OPENING", scopeType: "FULL" });
    // 10,11,12 + 20 + 30 = ٥ (بلا الأمانة 60)
    expect(r.variantCount).toBe(5);
    // ٣ منتجات أمّ (قلم/دفتر/مسطرة)
    expect(r.productCount).toBe(3);
    expect(r.excludedOpened).toBe(0);
    // OPENING FULL: يعرض عدّادات الشفافيّة
    expect(r.excludedBundle).toBeGreaterThanOrEqual(1); // متغيّر بكج واحد
    expect(r.excludedConsignment).toBeGreaterThanOrEqual(1); // متغيّر أمانة واحد
  });

  it("OPENING: يستبعد المُفتتَح مسبقاً (openedAt≠NULL) من العدّاد", async () => {
    // نفتتح متغيّرَين للفرع ١
    await db().insert(s.branchStock).values([
      { branchId: 1, variantId: 10, quantity: 5, openedAt: new Date() },
      { branchId: 1, variantId: 20, quantity: 3, openedAt: new Date() },
      // صفّ بلا openedAt ⇒ لا يُعدّ مُفتتَحاً
      { branchId: 1, variantId: 30, quantity: 0, openedAt: null },
    ]);
    const r = await previewScope({ branchId: 1, sessionType: "OPENING", scopeType: "FULL" });
    // النطاق الخام = ٥ (بلا الأمانة/البكج) − ٢ مُفتتَح = ٣
    expect(r.variantCount).toBe(3);
    expect(r.excludedOpened).toBe(2);
    // منتج ١ (قلم) لا يزال يظهر لأنّ متغيّرَيه الآخرَين (11,12) لم يُفتتَحا؛
    // منتج ٢ (دفتر) اختفى (متغيّره الوحيد 20 مُفتتَح). فيبقى: قلم + مسطرة = ٢ أمّ.
    expect(r.productCount).toBe(2);
  });

  it("OPENING: كل النطاق مُفتتَح ⇒ variantCount = 0", async () => {
    // نفتتح كل المتغيّرات في نطاق OPENING (5 متغيّرات: 10,11,12,20,30)
    await db().insert(s.branchStock).values(
      [10, 11, 12, 20, 30].map((vid) => ({
        branchId: 1,
        variantId: vid,
        quantity: 0,
        openedAt: new Date(),
      })),
    );
    const r = await previewScope({ branchId: 1, sessionType: "OPENING", scopeType: "FULL" });
    expect(r.variantCount).toBe(0);
    expect(r.excludedOpened).toBe(5);
    expect(r.productCount).toBe(0);
  });

  it("openedAt في فرع آخر لا يؤثّر", async () => {
    // نفتتحه في فرع ٢ فقط ⇒ يجب أن يبقى ضمن نطاق OPENING للفرع ١
    await db().insert(s.branchStock).values({
      branchId: 2,
      variantId: 10,
      quantity: 5,
      openedAt: new Date(),
    });
    const r = await previewScope({ branchId: 1, sessionType: "OPENING", scopeType: "FULL" });
    expect(r.variantCount).toBe(5); // بلا استبعاد للفرع ١
    expect(r.excludedOpened).toBe(0);
  });
});

/* ─────────── MOVING ─────────── */

describe("previewScope — MOVING", () => {
  it("يعدّ فقط المتغيّرات التي عليها حركة داخل النافذة وعلى الفرع الصحيح", async () => {
    const now = Date.now();
    await db().insert(s.inventoryMovements).values([
      // متغيّر ١٠ في فرع ١ خلال ١٠ أيام ⇒ يُعَدّ
      {
        variantId: 10, branchId: 1, movementType: "IN", quantity: 100, baseQuantity: 100,
        referenceType: "PURCHASE", referenceId: 1, createdBy: 1, createdAt: new Date(now - 10 * 86_400_000),
      },
      // متغيّر ٢٠ في فرع ٢ ⇒ لا يُعَدّ (فرع مختلف)
      {
        variantId: 20, branchId: 2, movementType: "IN", quantity: 50, baseQuantity: 50,
        referenceType: "PURCHASE", referenceId: 2, createdBy: 1, createdAt: new Date(now - 5 * 86_400_000),
      },
      // متغيّر ٣٠ في فرع ١ لكن قبل ٦٠ يوماً ⇒ خارج نافذة ٣٠ يوم ⇒ لا يُعَدّ
      {
        variantId: 30, branchId: 1, movementType: "IN", quantity: 10, baseQuantity: 10,
        referenceType: "PURCHASE", referenceId: 3, createdBy: 1, createdAt: new Date(now - 60 * 86_400_000),
      },
    ]);
    const r = await previewScope({ branchId: 1, sessionType: "NORMAL", scopeType: "MOVING", movingDays: 30 });
    expect(r.variantCount).toBe(1); // فقط متغيّر ١٠
    expect(r.productCount).toBe(1);
  });

  it("MOVING مع OPENING يستبعد الأمانة والبكج (لا حركة عليهما هنا فلا فرق)", async () => {
    await db().insert(s.inventoryMovements).values([
      // متغيّر أمانة (60) — يجب استبعاده في OPENING
      {
        variantId: 60, branchId: 1, movementType: "IN", quantity: 5, baseQuantity: 5,
        referenceType: "PURCHASE", referenceId: 1, createdBy: 1, createdAt: new Date(),
      },
      // متغيّر عاديّ (10)
      {
        variantId: 10, branchId: 1, movementType: "IN", quantity: 10, baseQuantity: 10,
        referenceType: "PURCHASE", referenceId: 2, createdBy: 1, createdAt: new Date(),
      },
    ]);
    const rN = await previewScope({ branchId: 1, sessionType: "NORMAL", scopeType: "MOVING", movingDays: 30 });
    expect(rN.variantCount).toBe(2); // 10 + 60

    const rO = await previewScope({ branchId: 1, sessionType: "OPENING", scopeType: "MOVING", movingDays: 30 });
    expect(rO.variantCount).toBe(1); // 60 مستبعَد
  });
});

/* ─────────── CATEGORY ─────────── */

describe("previewScope — CATEGORY", () => {
  it("فئة قرطاسية (10): قلم × ٣ متغيّرات + مسطرة = ٤ (لا يشمل الأمانة/البكج/المعطَّل)", async () => {
    const r = await previewScope({
      branchId: 1, sessionType: "NORMAL", scopeType: "CATEGORY", categoryIds: [10],
    });
    // 10,11,12 (قلم) + 30 (مسطرة) = ٤
    // مستبعَد: 40 (منتج غير نشط) + 50 (بكج)
    expect(r.variantCount).toBe(4);
    expect(r.productCount).toBe(2);
  });

  it("فئة ورق (20) + OPENING: يستبعد الأمانة (60) — يبقى الدفتر (20)", async () => {
    const r = await previewScope({
      branchId: 1, sessionType: "OPENING", scopeType: "CATEGORY", categoryIds: [20],
    });
    // NORMAL كان سيعدّ: 20 (دفتر) + 60 (أمانة) = ٢
    // OPENING: 20 فقط
    expect(r.variantCount).toBe(1);
    expect(r.productCount).toBe(1);
  });

  it("فئات فارغة ⇒ صفر بلا throw (يختلف عن resolveScope الذي يرمي BAD_REQUEST — القراءة صامتة)", async () => {
    const r = await previewScope({ branchId: 1, sessionType: "NORMAL", scopeType: "CATEGORY", categoryIds: [] });
    expect(r.variantCount).toBe(0);
    expect(r.productCount).toBe(0);
  });

  it("فئة غير موجودة ⇒ صفر (لا throw)", async () => {
    const r = await previewScope({
      branchId: 1, sessionType: "NORMAL", scopeType: "CATEGORY", categoryIds: [999],
    });
    expect(r.variantCount).toBe(0);
  });
});

/* ─────────── حارس مطابقة resolveScope ─────────── */

describe("previewScope — حارس مطابقة (regression)", () => {
  it("FULL NORMAL: previewScope.variantCount == عدد المتغيّرات النشطة لمنتجات نشطة غير بكج", async () => {
    // نحسب مباشرةً من DB نفس الشرط في resolveScope
    const rows = await db()
      .select({ id: s.productVariants.id })
      .from(s.productVariants)
      .innerJoin(s.products, eq(s.productVariants.productId, s.products.id))
      .where(
        and(
          eq(s.productVariants.isActive, true),
          eq(s.products.isActive, true),
          eq(s.products.isBundle, false),
        ),
      );
    const expected = rows.length;
    const preview = await previewScope({ branchId: 1, sessionType: "NORMAL", scopeType: "FULL" });
    expect(preview.variantCount).toBe(expected);
  });

  it("FULL OPENING بعد فتح بعض الأصناف: previewScope يطابق الحساب المباشر", async () => {
    await db().insert(s.branchStock).values([
      { branchId: 1, variantId: 10, quantity: 5, openedAt: new Date() },
      { branchId: 1, variantId: 30, quantity: 0, openedAt: new Date() },
    ]);
    // نحسب مباشرةً: نشط × نشط × غير بكج × غير أمانة × غير مُفتتَح في الفرع
    const [{ c: expectedRaw }] = await db()
      .select({ c: sql<number>`COUNT(*)` })
      .from(s.productVariants)
      .innerJoin(s.products, eq(s.productVariants.productId, s.products.id))
      .where(
        and(
          eq(s.productVariants.isActive, true),
          eq(s.products.isActive, true),
          eq(s.products.isBundle, false),
          eq(s.products.isConsignment, false),
        ),
      );
    const [{ c: openedCount }] = await db()
      .select({ c: sql<number>`COUNT(*)` })
      .from(s.branchStock)
      .where(and(eq(s.branchStock.branchId, 1), isNotNull(s.branchStock.openedAt)));
    const expected = Number(expectedRaw) - Number(openedCount);
    const preview = await previewScope({ branchId: 1, sessionType: "OPENING", scopeType: "FULL" });
    expect(preview.variantCount).toBe(expected);
    expect(preview.excludedOpened).toBe(Number(openedCount));
  });
});
