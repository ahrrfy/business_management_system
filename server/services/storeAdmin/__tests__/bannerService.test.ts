/**
 * اختبارات bannerService — بنرات المتجر بمواضعها الثلاثة (0074):
 * HERO (كاروسيل، افتراضي الصفوف القديمة) / SIDE (جانبي طولي) / INLINE (فاصل بين المنتجات).
 * يغطّي: افتراضية HERO، حفظ/تعديل الموضع، وإرجاع listActiveBanners للموضع مع احترام
 * فلاتر التفعيل/النافذة الزمنية عبر كل المواضع.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { createBanner, listActiveBanners, updateBanner } from "../bannerService";
import { truncateTables } from "../../__tests__/__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

beforeEach(async () => {
  await truncateTables(["storeBanners", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
});

describe("createBanner — الموضع", () => {
  it("بلا placement ⇒ يُحفظ HERO (توافق الصفوف/الاستدعاءات القديمة)", async () => {
    const r = await createBanner({ title: "بنر قديم النمط" }, 1);
    const [row] = await db().select().from(s.storeBanners).where(eq(s.storeBanners.id, r.id));
    expect(row.placement).toBe("HERO");
  });

  it("SIDE وINLINE يُحفظان كما أُرسلا", async () => {
    const side = await createBanner({ title: "جانبي", placement: "SIDE" }, 1);
    const inline = await createBanner({ title: "فاصل", placement: "INLINE" }, 1);
    const rows = await db().select().from(s.storeBanners);
    expect(rows.find((r) => r.id === side.id)?.placement).toBe("SIDE");
    expect(rows.find((r) => r.id === inline.id)?.placement).toBe("INLINE");
  });
});

describe("updateBanner — تغيير الموضع", () => {
  it("تحديث placement يغيّره، وتحديثٌ لا يذكره لا يمسّه", async () => {
    const r = await createBanner({ title: "بنر", placement: "HERO" }, 1);
    await updateBanner(r.id, { placement: "SIDE" });
    let [row] = await db().select().from(s.storeBanners).where(eq(s.storeBanners.id, r.id));
    expect(row.placement).toBe("SIDE");

    await updateBanner(r.id, { title: "بنر معدَّل" });
    [row] = await db().select().from(s.storeBanners).where(eq(s.storeBanners.id, r.id));
    expect(row.placement).toBe("SIDE");
    expect(row.title).toBe("بنر معدَّل");
  });
});

describe("listActiveBanners — إرجاع الموضع مع فلاتر الفعالية", () => {
  it("يعيد المواضع الثلاثة معاً بحقل placement، ويستبعد المعطّل ومنتهي النافذة أياً كان موضعه", async () => {
    await createBanner({ title: "رئيسي فعّال", placement: "HERO" }, 1);
    await createBanner({ title: "جانبي فعّال", placement: "SIDE" }, 1);
    await createBanner({ title: "فاصل فعّال", placement: "INLINE" }, 1);
    await createBanner({ title: "جانبي معطّل", placement: "SIDE", isActive: false }, 1);
    await createBanner({ title: "فاصل منتهٍ", placement: "INLINE", effectiveTo: "2020-01-01" }, 1);

    const list = await listActiveBanners();
    const titles = list.map((b) => b.title);
    expect(titles).toContain("رئيسي فعّال");
    expect(titles).toContain("جانبي فعّال");
    expect(titles).toContain("فاصل فعّال");
    expect(titles).not.toContain("جانبي معطّل");
    expect(titles).not.toContain("فاصل منتهٍ");

    expect(list.find((b) => b.title === "رئيسي فعّال")?.placement).toBe("HERO");
    expect(list.find((b) => b.title === "جانبي فعّال")?.placement).toBe("SIDE");
    expect(list.find((b) => b.title === "فاصل فعّال")?.placement).toBe("INLINE");
  });
});

/**
 * انحدار #203 (صور متعددة مجدولة) — عولج بـ#205 «return active text-only banners».
 *
 * الخلل: `listActiveBanners` صارت flatMap على مصادر الصور، وكان
 * `sources = images.length ? images : (imageUrl ? [...] : [])` ⇒ بنرٌ بلا صور **وبلا** imageUrl
 * يُنتج **صفراً** من الصفوف فيختفي من المتجر **بصمت** (كان يُعرض بعنوانه/زرّه)، بينما تبقى
 * لوحة الإدارة تعرضه (BannerManager يرسم أيقونةً بديلة للبنر بلا صورة) ⇒ المستخدم يراه في
 * اللوحة ولا يجده في الموقع. أحمَر ذلك `main` عبر اختبار المواضع أعلاه.
 *
 * **لماذا هذه الاختبارات (#205 لم يُضِف أيّاً):** اختبار المواضع كان يحرس هذا **بالصدفة** (بذرته
 * بلا صور) ⇒ أيّ تعديلٍ لبذرته يُسقط الحراسة **صامتاً**. هنا نُسمّي الثوابت صراحةً.
 *
 * 📌 قاعدة عامّة: تحويل `map` إلى `flatMap` يُدخل حالة «صفر صفوف» لم تكن ممكنة ⇒ اسأل دائماً:
 *    متى تعود `[]`؟ وهل الاختفاء مقصود أم صامت؟
 */
describe("انحدار #203 — بنر بلا صورة لا يختفي (سلوك #205)", () => {
  it("بلا صور وبلا imageUrl ⇒ صفٌّ واحد بـimageUrl=null (لا يختفي)", async () => {
    await createBanner({ title: "بنر نصّي بلا صورة" }, 1);
    const list = await listActiveBanners();
    const hits = list.filter((b) => b.title === "بنر نصّي بلا صورة");
    expect(hits).toHaveLength(1); // كان 0 ⇒ اختفاء صامت
    expect(hits[0].imageUrl).toBeNull();
  });

  it("imageUrl وحده (النمط القديم) ⇒ صفٌّ واحد بصورته", async () => {
    await createBanner({ title: "بنر أحادي", imageUrl: "/img/a.jpg" }, 1);
    const hits = (await listActiveBanners()).filter((b) => b.title === "بنر أحادي");
    expect(hits).toHaveLength(1);
    expect(hits[0].imageUrl).toBe("/img/a.jpg");
  });

  it("صور متعددة فعّالة ⇒ صفٌّ لكل صورة بالترتيب (ميزة #203 سليمة)", async () => {
    await createBanner(
      {
        title: "بنر متعدّد",
        images: [
          { url: "/img/2.jpg", sortOrder: 1 },
          { url: "/img/1.jpg", sortOrder: 0 },
        ],
      },
      1,
    );
    const hits = (await listActiveBanners()).filter((b) => b.title === "بنر متعدّد");
    expect(hits.map((b) => b.imageUrl)).toEqual(["/img/1.jpg", "/img/2.jpg"]); // مرتّبة بـsortOrder
    expect(hits.map((b) => b.imageIndex)).toEqual([0, 1]);
  });

  /**
   * ✅ **قرار المالك (١٦/٧/٢٠٢٦): «يُعرض نصّياً كما هو الآن» — مقصودٌ لا أثرٌ جانبيّ.**
   *
   * بنرٌ **فعّال** كلُّ صوره مجدولة خارج نافذة اليوم ⇒ يُعرض **نصّياً** (imageUrl=null، وBannerFrame
   * يرسم تدرّجاً بديلاً) ولا يُخفى. المنطق: نافذة **البنر** (effectiveFrom/To على الصفّ) هي التي
   * تقرّر ظهوره، وجدولة الصور تختار **أيّها** يُعرض داخل حياته لا **إن كان** يظهر.
   *
   * ⛔ فلا «تُصلح» هذا بإخفاء البنر: كان بديلاً مطروحاً ورفضه المالك صراحةً. الإخفاء هنا **انحدارٌ
   * وظيفيّ** لا تحسين. (وهذه الحالة قريبةٌ شكلاً من انحدار #203 «بنر يختفي بصمت» أدناه لكنها
   * نقيضه سبباً: هناك اختفاءٌ **بخطأ**، وهنا عرضٌ **بقرار**.)
   */
  it("صور كلّها خارج النافذة ⇒ يُعرض نصّياً (نافذة البنر تحكم الظهور، لا جدولة الصور)", async () => {
    await createBanner(
      { title: "بنر مجدول لاحقاً", images: [{ url: "/img/soon.jpg", effectiveFrom: "2999-01-01" }] },
      1,
    );
    const hits = (await listActiveBanners()).filter((b) => b.title === "بنر مجدول لاحقاً");
    expect(hits).toHaveLength(1);
    expect(hits[0].imageUrl).toBeNull(); // لا تُسرَّب صورة خارج نافذتها
  });

  it("بنرٌ خارج نافذته هو (لا صوره) ⇒ مُخفيّ فعلاً", async () => {
    await createBanner(
      { title: "بنر منتهٍ", imageUrl: "/img/x.jpg", effectiveTo: "2020-01-01" },
      1,
    );
    const titles = (await listActiveBanners()).map((b) => b.title);
    expect(titles).not.toContain("بنر منتهٍ");
  });

  it("صورة معطّلة داخل بنر فعّال تُستبعَد وحدها دون البنر", async () => {
    await createBanner(
      {
        title: "بنر بصورتين إحداهما معطّلة",
        images: [
          { url: "/img/on.jpg", sortOrder: 0 },
          { url: "/img/off.jpg", sortOrder: 1, isActive: false },
        ],
      },
      1,
    );
    const hits = (await listActiveBanners()).filter((b) => b.title === "بنر بصورتين إحداهما معطّلة");
    expect(hits.map((b) => b.imageUrl)).toEqual(["/img/on.jpg"]);
  });
});
