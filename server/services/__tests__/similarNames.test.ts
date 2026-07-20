// اختبارات كاشف الأسماء المشابهة (name-assistant) — أغلبية الكلمات + التطابق التام + الاستثناء.
// تعمل على قاعدة الاختبار الحقيقية لأن المطابقة تُنفَّذ على العمود المولَّد products.searchNorm.
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { findSimilarProductNames } from "../catalog/similarNames";

function db() { const d = getDb(); if (!d) throw new Error("DATABASE_URL not set"); return d; }

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["productUnits", "productVariants", "products"]) {
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  }
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/** بذرة تتعمّد ازدواجاً واقعياً بترتيب كلمات مختلف وإملاء متفاوت (نمط الاستيراد القديم). */
async function seed() {
  const d = db();
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف أزرق باركر" },
    { id: 2, name: "باركر قلم ازرق" }, // ازدواج ناقص كلمة وبلا همزة
    { id: 3, name: "دفتر مدرسي ٩٦ ورقة" },
    { id: 4, name: "قلم رصاص HB", isActive: false }, // معطَّل — يجب أن يظهر مُعلَّماً
    { id: 5, name: "مكتبة خشبية صغيرة" },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe("findSimilarProductNames — أغلبية الكلمات لا كلّها", () => {
  it("ازدواج ناقص كلمة يُمسَك: «قلم جاف ازرق باركر» يجد «باركر قلم ازرق» أيضاً", async () => {
    const rows = await findSimilarProductNames("قلم جاف ازرق باركر");
    expect(ids(rows)).toContain(1);
    expect(ids(rows)).toContain(2); // ٣ من ٤ كلمات — الأغلبية تكفي
  });

  it("كلمة واحدة عامة لا تُغرق: «قلم» وحدها تشترط ورودها فقط ولا يطفح غير أصحابها", async () => {
    const rows = await findSimilarProductNames("قلم");
    // كل الأسماء الحاوية «قلم» — وليس الكتالوج كله.
    expect(ids(rows).sort()).toEqual([1, 2, 4]);
  });

  it("التطبيع العربي يعمل: «مكتبه خشبيه» يجد «مكتبة خشبية»", async () => {
    const rows = await findSimilarProductNames("مكتبه خشبيه");
    expect(ids(rows)).toContain(5);
  });

  it("لا تشابه = لا نتائج (لا ضجيج)", async () => {
    const rows = await findSimilarProductNames("طابعة ليزرية ملونة");
    expect(rows).toEqual([]);
  });
});

describe("findSimilarProductNames — التطابق التام والترتيب", () => {
  it("التطابق التام في الفضاء المُطبَّع يتصدّر ويحمل isExact", async () => {
    const rows = await findSimilarProductNames("باركر قلم أزرق"); // بهمزة ≠ إملاء المخزَّن
    expect(rows[0]?.id).toBe(2);
    expect(rows[0]?.isExact).toBe(true);
    const other = rows.find((r) => r.id === 1);
    expect(other?.isExact).toBe(false);
  });

  it("الأرقام العربية-الهندية تُطابق اللاتينية: «دفتر 96 ورقه» تام على «دفتر مدرسي ٩٦ ورقة»", async () => {
    const rows = await findSimilarProductNames("دفتر مدرسي 96 ورقه");
    expect(rows[0]?.id).toBe(3);
    expect(rows[0]?.isExact).toBe(true);
  });
});

describe("findSimilarProductNames — الاستثناء والحالة", () => {
  it("شاشة التعديل تستثني المنتج نفسه", async () => {
    const rows = await findSimilarProductNames("قلم جاف أزرق باركر", { excludeProductId: 1 });
    expect(ids(rows)).not.toContain(1);
    expect(ids(rows)).toContain(2);
  });

  it("المنتج المعطَّل يظهر بحالته (ازدواج نائم يبقى ازدواجاً)", async () => {
    const rows = await findSimilarProductNames("قلم رصاص");
    const hit = rows.find((r) => r.id === 4);
    expect(hit).toBeTruthy();
    expect(hit?.isActive).toBe(false);
  });

  it("الحدّ يُحترم", async () => {
    const rows = await findSimilarProductNames("قلم", { limit: 1 });
    expect(rows.length).toBe(1);
  });
});
