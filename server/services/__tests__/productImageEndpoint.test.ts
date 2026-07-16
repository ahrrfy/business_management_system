/**
 * صور المنتجات كموارد HTTP — `GET /api/img/product/:id` (تعميم نمط البنرات، ١٦/٧).
 *
 * يحرس ثلاثة أشياء **كلٌّ منها انكسر أو كاد ينكسر مرّةً في هذه العائلة**:
 *  ① **البوّابة**: النقطة علنية مجهولة الهوية ⇒ لا تُخدَم إلا صورة منتجٍ يعرضه المتجر أصلاً.
 *    خصوصاً `showInStore=0` (إخفاءٌ صريح من المالك) — بلا هذا الاختبار يكفي تخمين عددٍ صحيح
 *    لسحب صور ما أُخفي عمداً. **البوّابة تعيش في معالج Express** ⇒ لا يكفي اختبار الخدمة:
 *    اختبار البنرات (#212) غطّى الوحدات وحدها وترك الطبقة HTTP للتحقّق الحيّ.
 *  ② **العقد الثلاثيّ** في `storefrontService`: data URL ⇒ رابط | قيمة أخرى ⇒ **كما هي** | تالفة ⇒ null.
 *    الوسط تحديداً هو انحدار #207 (صورةٌ تعمل تختفي بصمت) — نفس صنف #203.
 *  ③ **XSS**: العمود نصٌّ حرّ ⇒ لا يُخدَم `Content-Type` منه بلا قائمة بيضاء.
 *
 * نُشغّل الراوتر على منفذٍ عابر بـ`node:http` (لا supertest): صفر اعتمادية جديدة، واختبارٌ
 * للسلوك HTTP الحقيقي (الحالة + الترويسات + البايتات) لا لمحاكاةٍ له.
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { imageRouter } from "../../imageRoute";
import { storefrontProduct } from "../storefrontService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

/** يرفع الراوتر على منفذٍ عابر، ينفّذ الفحص، ثم يُغلق حتماً (finally) كي لا تتسرّب المنافذ. */
async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/api/img", imageRouter());
  const srv = createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

/** أصغر JPEG صالح فعلاً: يبدأ FFD8 وينتهي FFD9 ⇒ يمرّ بالقائمة البيضاء ويُفكّ إلى بايتات. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`;

/** يزرع منتجاً كامل السلسلة (منتج→متغيّر→وحدة→سعر) + صورةً رئيسية، ويعيد معرّف الصورة. */
async function seedProduct(opts: {
  productId: number;
  showInStore?: boolean;
  isActive?: boolean;
  isService?: boolean;
  imageValue?: string | null;
}): Promise<number> {
  const d = db();
  const id = opts.productId;
  await d.insert(s.products).values({
    id,
    name: `منتج ${id}`,
    isActive: opts.isActive ?? true,
    isService: opts.isService ?? false,
    showInStore: opts.showInStore ?? true,
  });
  await d.insert(s.productVariants).values({ id, productId: id, sku: `SKU-${id}`, variantName: "أساسي", isActive: true });
  await d.insert(s.productUnits).values({
    id,
    variantId: id,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
    isActive: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: id, priceTier: "RETAIL", price: "1000" });
  const value = opts.imageValue === undefined ? JPEG_DATA_URL : opts.imageValue;
  if (value == null) return 0;
  await d.insert(s.productImages).values({ id, productId: id, url: value, isPrimary: true });
  return id;
}

beforeEach(async () => {
  await truncateTables(["productImages", "productPrices", "productUnits", "productVariants", "products", "branches", "users"]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
});

describe("GET /api/img/product/:id — البوّابة (علنية مجهولة الهوية)", () => {
  it("منتج معروضٌ في المتجر ⇒ 200 ببايتات JPEG سليمة + immutable + ETag + nosniff", async () => {
    const imageId = await seedProduct({ productId: 1 });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG_BYTES); // غير مقتطعة
    });
  });

  it("🔒 showInStore=0 ⇒ 404 — إخفاء المالك يسري على الصورة لا على القائمة وحدها", async () => {
    const imageId = await seedProduct({ productId: 2, showInStore: false });
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/${imageId}`)).status).toBe(404);
    });
  });

  it("🔒 منتج معطَّل (isActive=0) أو خدمة ⇒ 404", async () => {
    const inactive = await seedProduct({ productId: 3, isActive: false });
    const service = await seedProduct({ productId: 4, isService: true });
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/${inactive}`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/product/${service}`)).status).toBe(404);
    });
  });

  it("معرّف غير موجود ⇒ 404، وغير رقميّ/سالب ⇒ 400 (المفتاح عددٌ لا مسار ⇒ لا traversal)", async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/99999`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/product/abc`)).status).toBe(400);
      expect((await fetch(`${base}/api/img/product/-1`)).status).toBe(400);
    });
  });

  it("ETag مطابق ⇒ 304 بصفر بايت (إعادة التحقّق رخيصة)", async () => {
    const imageId = await seedProduct({ productId: 5 });
    await withServer(async (base) => {
      const first = await fetch(`${base}/api/img/product/${imageId}`);
      const etag = first.headers.get("etag")!;
      const second = await fetch(`${base}/api/img/product/${imageId}`, { headers: { "If-None-Match": etag } });
      expect(second.status).toBe(304);
      expect((await second.arrayBuffer()).byteLength).toBe(0);
    });
  });
});

describe("GET /api/img/product/:id — XSS (العمود نصٌّ حرّ في DB)", () => {
  it("data:text/html وsvg+xml ⇒ 404 — لا يُخدَم Content-Type مأخوذاً من DB بلا قائمة بيضاء", async () => {
    const html = await seedProduct({
      productId: 6,
      imageValue: `data:text/html;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`,
    });
    const svg = await seedProduct({
      productId: 7,
      imageValue: `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`,
    });
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/${html}`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/product/${svg}`)).status).toBe(404);
    });
  });
});

describe("storefrontService — العقد الثلاثيّ لصورة المنتج", () => {
  it("data URL ⇒ رابط النقطة ببصمة المحتوى (لا base64 في الردّ)", async () => {
    const imageId = await seedProduct({ productId: 8 });
    const item = await storefrontProduct(8, 1);
    expect(item?.imageUrl).toMatch(new RegExp(`^/api/img/product/${imageId}\\?v=[0-9a-f]{16}$`));
    expect(item?.imageUrl).not.toContain("base64");
  });

  /** انحدار #207: تحويل **أيّ** قيمة ليست data URL إلى null ⇒ صورةٌ تعمل تختفي بصمت. */
  it("قيمة ليست data URL (مسار مستورَد) ⇒ تُمرَّر كما هي — لا تختفي", async () => {
    await seedProduct({ productId: 9, imageValue: "/uploads/legacy/9.jpg" });
    expect((await storefrontProduct(9, 1))?.imageUrl).toBe("/uploads/legacy/9.jpg");
  });

  it("data URL تالفة/نوعٌ غير مسموح ⇒ null (لا تُشحَن نفايةٌ base64 في الردّ)", async () => {
    await seedProduct({ productId: 10, imageValue: "data:text/html;base64,PHNjcmlwdD4=" });
    expect((await storefrontProduct(10, 1))?.imageUrl).toBeNull();
  });

  it("بلا صورة ⇒ null والمنتج يبقى ظاهراً (لا اختفاء صامت — درس #203)", async () => {
    await seedProduct({ productId: 11, imageValue: null });
    const item = await storefrontProduct(11, 1);
    expect(item).not.toBeNull();
    expect(item?.imageUrl).toBeNull();
  });
});
