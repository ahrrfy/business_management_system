// تخطيط موسم المدارس (بند 7): خطة الأصناف الموسمية (seasonTarget > 0) بمخزونها الكلّيّ عبر كل الفروع
// مقابل الهدف + الفجوة، تصفية «تحت الهدف»، ضبط الهدف، البحث، والعدّاد الحيّ.
// نمط الإعداد منسوخ من reorderService.test.ts (reset + seed).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  countSeasonBelowTarget,
  listSeasonPlan,
  searchSeasonCandidates,
  setSeasonTarget,
} from "../inventory/seasonPlanning";

const TABLES = ["branchStock", "productVariants", "products", "branches", "users"];

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
  await d.insert(s.products).values([
    { id: 1, name: "دفتر مدرسي" },
    { id: 2, name: "منتج معطَّل", isActive: false },
  ]);
  await d.insert(s.productVariants).values([
    // v1: موسميّ، الهدف 100. المخزون = 30 + 20 = 50 عبر الفرعين ⇒ الفجوة 50.
    { id: 1, productId: 1, sku: "S1", variantName: "أزرق", seasonTarget: 100, costPrice: "500.00" },
    // v2: موسميّ، الهدف 40. المخزون 50 (> الهدف) ⇒ الفجوة 0 (فوق الهدف).
    { id: 2, productId: 1, sku: "S2", variantName: "أحمر", seasonTarget: 40, costPrice: "500.00" },
    // v3: هدفه 0 ⇒ غير موسميّ (مستبعَد) — لاختبار البحث والإضافة.
    { id: 3, productId: 1, sku: "S3", variantName: "أخضر", seasonTarget: 0, costPrice: "500.00" },
    // v4: موسميّ لكنه معطَّل ⇒ مستبعَد.
    { id: 4, productId: 1, sku: "S4", seasonTarget: 200, isActive: false, costPrice: "500.00" },
    // v5: منتجه معطَّل ⇒ مستبعَد حتى وهو موسميّ.
    { id: 5, productId: 2, sku: "S5", seasonTarget: 100, costPrice: "500.00" },
    // v6: موسميّ، الهدف 60، بلا صفوف مخزون قط ⇒ المخزون 0 والفجوة 60 (يختبر LEFT JOIN).
    { id: 6, productId: 1, sku: "S6", variantName: "أصفر", seasonTarget: 60, costPrice: "500.00" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 30 },
    { variantId: 1, branchId: 2, quantity: 20 },
    { variantId: 2, branchId: 1, quantity: 50 },
    { variantId: 3, branchId: 1, quantity: 5 },
    { variantId: 4, branchId: 1, quantity: 0 },
    { variantId: 5, branchId: 1, quantity: 0 },
    // v6: لا مخزون قط.
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("listSeasonPlan", () => {
  it("يجمع المخزون عبر كل الفروع مقابل الهدف + الفجوة = max(0, الهدف − المخزون)", async () => {
    const rows = await listSeasonPlan();
    const v1 = rows.find((r) => r.variantId === 1);
    expect(v1).toMatchObject({
      variantId: 1,
      productId: 1,
      productName: "دفتر مدرسي",
      sku: "S1",
      variantName: "أزرق",
      totalStock: 50, // 30 + 20
      seasonTarget: 100,
      gap: 50, // 100 − 50
    });
    // v6 بلا مخزون قط ⇒ المخزون 0 والفجوة كاملة (LEFT JOIN).
    expect(rows.find((r) => r.variantId === 6)).toMatchObject({ totalStock: 0, gap: 60 });
    // v2 فوق الهدف ⇒ فجوة 0.
    expect(rows.find((r) => r.variantId === 2)).toMatchObject({ totalStock: 50, seasonTarget: 40, gap: 0 });
  });

  it("يستبعد: غير الموسميّ (هدف 0)، المتغيّر المعطَّل، المنتج المعطَّل", async () => {
    const rows = await listSeasonPlan();
    expect(rows.find((r) => r.variantId === 3)).toBeUndefined(); // هدف 0
    expect(rows.find((r) => r.variantId === 4)).toBeUndefined(); // متغيّر معطَّل
    expect(rows.find((r) => r.variantId === 5)).toBeUndefined(); // منتج معطَّل
    expect(rows.map((r) => r.variantId).sort()).toEqual([1, 2, 6]);
  });

  it("الترتيب: الأبعد عن الهدف أولاً (نسبة المخزون إلى الهدف تصاعدياً)", async () => {
    const rows = await listSeasonPlan();
    // v6 (0/60=0) ثم v1 (50/100=0.5) ثم v2 (50/40=1.25).
    expect(rows.map((r) => r.variantId)).toEqual([6, 1, 2]);
  });

  it("onlyBelowTarget يقصر على الفجوة > 0 (قائمة الشراء)", async () => {
    const rows = await listSeasonPlan({ onlyBelowTarget: true });
    // v2 فوق الهدف ⇒ مستبعَد؛ v6 ثم v1.
    expect(rows.map((r) => r.variantId)).toEqual([6, 1]);
    expect(rows.every((r) => r.gap > 0)).toBe(true);
  });
});

describe("countSeasonBelowTarget", () => {
  it("يعدّ المتغيّرات الموسمية تحت الهدف فقط", async () => {
    expect(await countSeasonBelowTarget()).toBe(2); // v6 + v1 (v2 فوق الهدف)
  });

  it("يتغيّر مع ضبط الهدف", async () => {
    await setSeasonTarget({ variantId: 3, seasonTarget: 100 }); // v3 مخزونه 5 < 100 ⇒ يدخل
    expect(await countSeasonBelowTarget()).toBe(3);
    await setSeasonTarget({ variantId: 1, seasonTarget: 0 }); // v1 يخرج
    expect(await countSeasonBelowTarget()).toBe(2);
  });
});

describe("setSeasonTarget", () => {
  it("نجاح: يحدّث الهدف ويعيده، ويدخل الصنف للخطة", async () => {
    const res = await setSeasonTarget({ variantId: 3, seasonTarget: 80 });
    expect(res).toEqual({ variantId: 3, seasonTarget: 80 });
    const plan = await listSeasonPlan();
    expect(plan.find((r) => r.variantId === 3)).toMatchObject({ totalStock: 5, seasonTarget: 80, gap: 75 });
  });

  it("الهدف 0 يُزيل الصنف من الخطة", async () => {
    await setSeasonTarget({ variantId: 1, seasonTarget: 0 });
    const plan = await listSeasonPlan();
    expect(plan.find((r) => r.variantId === 1)).toBeUndefined();
  });

  it("رفض القيم السالبة وغير الصحيحة", async () => {
    await expect(setSeasonTarget({ variantId: 1, seasonTarget: -1 })).rejects.toThrow(/غير سالب/);
    await expect(setSeasonTarget({ variantId: 1, seasonTarget: 2.5 })).rejects.toThrow(/غير سالب/);
  });

  it("متغيّر غير موجود ⇒ NOT_FOUND", async () => {
    await expect(setSeasonTarget({ variantId: 999, seasonTarget: 10 })).rejects.toThrow(/غير موجود/);
  });
});

describe("searchSeasonCandidates", () => {
  it("يبحث باسم المنتج ويُعيد المتغيّرات النشطة مع هدفها الحاليّ والمخزون الكلّيّ", async () => {
    const res = await searchSeasonCandidates("دفتر");
    // منتج 1 النشط: v1, v2, v3, v6 (v4 معطَّل، v5 منتجه معطَّل ⇒ مستبعدان).
    expect(res.map((c) => c.variantId).sort()).toEqual([1, 2, 3, 6]);
    const v1 = res.find((c) => c.variantId === 1);
    expect(v1).toMatchObject({ seasonTarget: 100, totalStock: 50 }); // مُضاف سلفاً
    const v3 = res.find((c) => c.variantId === 3);
    expect(v3).toMatchObject({ seasonTarget: 0, totalStock: 5 }); // قابل للإضافة
  });

  it("يبحث بـ SKU، ويُعيد فارغاً لغير المطابق", async () => {
    expect((await searchSeasonCandidates("S2")).map((c) => c.variantId)).toEqual([2]);
    expect(await searchSeasonCandidates("لا-يوجد-هذا")).toEqual([]);
  });
});
