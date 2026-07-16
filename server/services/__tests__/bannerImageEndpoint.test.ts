// خدمة صور البنرات كموارد HTTP مستقلّة (المرحلة ١ من خطة حجم البنرات، ١٦/٧).
//
// السبب (قياسٌ حيّ): ردّ `storefront.banners` العلنيّ كان **١٫٣٢ م.ب مضغوطة** في كل تحميلٍ
// للمتجر (٨× حجم حزمة JS كلّها)، لأن الصور data-URL base64 **داخل JSON** ⇒ لا كاش HTTP ولا
// تحميل كسول ولا تحميل متوازٍ، +٣٣٪ من base64. الآن: رابطٌ لمورد HTTP بـimmutable+ETag.
//
// الثوابت:
//   ص١) العلنيّ يُعيد **رابطاً** لا data URL — وهو جوهر التوفير.
//   ص٢) البنر النصّي (بلا صورة) يبقى `null` — قرار المالك ١٦/٧ (لا رابط ميت).
//   ص٣) الرابط يحمل بصمة **المحتوى** ⇒ `immutable` آمنة: تغيّر الصورة ⇒ تغيّر الرابط.
//   ص٤) **أمان:** فكّ data URL يقبل الصور فقط — `data:text/html` مرفوض (وإلا خُدِم
//       Content-Type: text/html من عمودٍ نصّيّ حرّ = XSS على نطاق المتجر).
//   ص٥) لوحة الإدارة (`listBanners`) تبقى data URL — المحرّر يعرض الصورة ويعدّلها.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { bannerImageUrl, decodeDataUrl, imageHash } from "../../imageRoute";
import { createBanner, listActiveBanners, listBanners } from "../storeAdmin/bannerService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

/** أصغر JPEG صالح (بايتان سحريّان) — يكفي لاختبار الفكّ/النوع بلا ملفّ ثقيل. */
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]).toString("base64");
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_B64}`;
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;

beforeEach(async () => {
  await truncateTables(["storeBanners", "branches", "users"]);
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
});

describe("decodeDataUrl — البوّابة الأمنية", () => {
  it("ص٤: يقبل صورةً ويُعيد النوع والبايتات", () => {
    const got = decodeDataUrl(JPEG_DATA_URL);
    expect(got?.mime).toBe("image/jpeg");
    expect(got?.bytes.length).toBeGreaterThan(0);
    expect(decodeDataUrl(PNG_DATA_URL)?.mime).toBe("image/png");
  });

  it("ص٤ (حاسم): يرفض data:text/html — العمود نصّ حرّ، وخدمة نوعه بلا تحقّق = XSS", () => {
    const html = `data:text/html;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`;
    expect(decodeDataUrl(html)).toBeNull();
    expect(decodeDataUrl(`data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`)).toBeNull(); // SVG يُنفّذ سكربتاً ⇒ خارج القائمة البيضاء
    expect(decodeDataUrl(`data:application/javascript;base64,${Buffer.from("alert(1)").toString("base64")}`)).toBeNull();
  });

  it("يرفض الفارغ/المشوَّه/غير المُرمَّز ولا يرمي", () => {
    for (const v of [null, undefined, "", "  ", "https://x/y.jpg", "data:image/jpeg,notbase64", "data:image/jpeg;base64,"]) {
      expect(decodeDataUrl(v as string)).toBeNull();
    }
  });
});

describe("بصمة الرابط", () => {
  it("ص٣: البصمة تتبع المحتوى — نفس الصورة ⇒ نفس الرابط، وتغيّرها ⇒ رابط جديد", () => {
    expect(imageHash(JPEG_DATA_URL)).toBe(imageHash(JPEG_DATA_URL));
    expect(imageHash(JPEG_DATA_URL)).not.toBe(imageHash(PNG_DATA_URL));
    const a = bannerImageUrl(7, "main-0", JPEG_DATA_URL);
    expect(a).toMatch(/^\/api\/img\/banner\/7\/main-0\?v=[0-9a-f]{16}$/);
    expect(bannerImageUrl(7, "main-0", PNG_DATA_URL)).not.toBe(a); // ⇒ immutable آمنة
  });
});

describe("listActiveBanners — رابط لا base64", () => {
  it("ص١: العلنيّ يُعيد رابطاً، والردّ لا يحمل أيّ data URL", async () => {
    await createBanner({ title: "بنر بصورة", imageUrl: JPEG_DATA_URL }, 1);
    const [b] = (await listActiveBanners()).filter((x) => x.title === "بنر بصورة");
    expect(b.imageUrl).toMatch(/^\/api\/img\/banner\/\d+\/main-0\?v=[0-9a-f]{16}$/);
    expect(JSON.stringify(b)).not.toContain("base64"); // الجوهر: صفر بايت صورة في JSON
  });

  it("ص٢: البنر النصّي يبقى null (لا رابط ميت) — قرار المالك", async () => {
    await createBanner({ title: "بنر نصّي" }, 1);
    const [b] = (await listActiveBanners()).filter((x) => x.title === "بنر نصّي");
    expect(b.imageUrl).toBeNull();
  });

  it("ص١: صور متعددة ⇒ رابطٌ لكل فهرس بالترتيب (main-0/main-1)", async () => {
    await createBanner({ title: "متعدّد", images: [{ url: PNG_DATA_URL, sortOrder: 1 }, { url: JPEG_DATA_URL, sortOrder: 0 }] }, 1);
    const hits = (await listActiveBanners()).filter((x) => x.title === "متعدّد");
    expect(hits.map((h) => h.imageUrl)).toEqual([
      expect.stringContaining("/main-0?v="),
      expect.stringContaining("/main-1?v="),
    ]);
    // كل فهرس ببصمته (صورتان مختلفتان ⇒ رابطان مختلفان).
    expect(hits[0].imageUrl).not.toBe(hits[1].imageUrl);
  });

  it("رابطٌ جاهز (صفّ قديم/مستورَد) يُمرَّر كما هو — لا يختفي", async () => {
    // العمود نصٌّ حرّ: صفٌّ قديم قد يحمل مساراً/رابطاً بدل data URL. تحويله إلى null كان
    // **انحداراً صامتاً** (صورة تختفي من المتجر) — أمسكه اختبار #207 القائم قبل الدمج.
    const r = await createBanner({ title: "رابط جاهز", imageUrl: JPEG_DATA_URL }, 1);
    await db().update(s.storeBanners).set({ imageUrl: "/uploads/legacy.png", images: [] }).where(eq(s.storeBanners.id, r.id));
    const [b] = (await listActiveBanners()).filter((x) => x.title === "رابط جاهز");
    expect(b.imageUrl).toBe("/uploads/legacy.png");
  });

  it("data URL ليست صورةً صالحة ⇒ null (لا تُشحَن نفايةٌ base64 في JSON)", async () => {
    const r = await createBanner({ title: "تالف", imageUrl: JPEG_DATA_URL }, 1);
    const junk = `data:text/html;base64,${Buffer.from("<b>x</b>").toString("base64")}`;
    await db().update(s.storeBanners).set({ imageUrl: junk, images: [] }).where(eq(s.storeBanners.id, r.id));
    const [b] = (await listActiveBanners()).filter((x) => x.title === "تالف");
    expect(b.imageUrl).toBeNull();
  });

  it("ص٥: لوحة الإدارة تبقى data URL (المحرّر يحتاج الصورة نفسها)", async () => {
    await createBanner({ title: "للوحة", imageUrl: JPEG_DATA_URL }, 1);
    const [row] = (await listBanners()).filter((x) => x.title === "للوحة");
    expect(row.imageUrl).toBe(JPEG_DATA_URL);
  });
});
