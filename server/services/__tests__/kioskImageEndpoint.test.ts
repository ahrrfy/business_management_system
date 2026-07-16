/**
 * صور كشك المعرض كموارد HTTP — `GET /api/img/kiosk-product/:id` (١٦/٧).
 *
 * **السبب:** `kioskBanner` سقفه ٥٠٠ منتج بترتيب «ذوات الصور أولاً» ⇒ ~٣٥٠ ك.ب لكلٍّ
 * ≈ **١٧٥ م.ب في ردٍّ JSON واحد** حين يمتلئ الكتالوج — أضخم من مشكلة المتجر (٢١ م.ب).
 *
 * **الثابت الحاكم (سبب وجود مسارٍ منفصل أصلاً):** بوّابة الكشك ≠ بوّابة المتجر.
 * الكشك يعرض `isActive && !isService` **بلا** `showInStore` (قرار المالك ٨/٧) وهو **خلف مصادقة**؛
 * والمتجر علنيٌّ مجهول ويشترط `showInStore`. لذلك:
 *   • منتجٌ مخفيّ عن المتجر ⇒ **٢٠٠ للكشك المُصرَّح** و**٤٠٤ للعلنيّ** — الاختباران معاً هنا،
 *     لأن أيّ محاولةٍ لتوحيد المسارين ستُحمِّر أحدهما حتماً.
 *   • بلا مصادقة ⇒ **٤٠١** (وإلا صار المسار بوّابةً خلفيةً تُسقط شرط `showInStore` للعلن).
 *   • الردّ **`private`** لا `public`: يعتمد على المصادقة ⇒ لا تخزّنه ذاكرةٌ وسيطة مشتركة.
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { KIOSK_COOKIE_NAME, signKioskSession } from "../../auth/kioskSession";
import { getDb } from "../../db";
import { imageRouter } from "../../imageRoute";
import { kioskBanner } from "../kioskService";
import { createKioskDevice, deviceLoginByToken } from "../kioskDeviceService";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

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

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`;

/** كوكي جهاز كشك حقيقيّ: يُنشئ الجهاز ثم يسجّل دخوله ثم يوقّع جلسته — نفس مسار الإنتاج. */
async function kioskDeviceCookie(branchId = 1): Promise<string> {
  const created = await createKioskDevice({ branchId, label: "شاشة الاختبار", createdBy: 1 });
  const login = await deviceLoginByToken(created.rawToken, "127.0.0.1");
  if (!login) throw new Error("فشل دخول جهاز الكشك في البذرة");
  const token = await signKioskSession(login.deviceId, login.branchId, login.tokenPrefix);
  return `${KIOSK_COOKIE_NAME}=${token}`;
}

async function seedProduct(opts: { productId: number; showInStore?: boolean; isActive?: boolean; isService?: boolean }): Promise<number> {
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
  await d.insert(s.productUnits).values({ id, variantId: id, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isActive: true });
  await d.insert(s.productPrices).values({ productUnitId: id, priceTier: "RETAIL", price: "1000" });
  await d.insert(s.branchStock).values({ variantId: id, branchId: 1, quantity: 5 });
  await d.insert(s.productImages).values({ id, productId: id, url: JPEG_DATA_URL, isPrimary: true });
  return id;
}

beforeEach(async () => {
  await truncateTables([
    "kioskDevices", "productImages", "branchStock", "productPrices",
    "productUnits", "productVariants", "products", "branches", "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
});

describe("GET /api/img/kiosk-product/:id — المصادقة", () => {
  it("🔒 بلا مصادقة ⇒ 401 — وإلا صار المسار بوّابةً خلفيةً تُسقط شرط showInStore للعلن", async () => {
    const id = await seedProduct({ productId: 1 });
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/kiosk-product/${id}`)).status).toBe(401);
    });
  });

  it("كوكي جهاز كشك صالح ⇒ 200 ببايتات سليمة", async () => {
    const id = await seedProduct({ productId: 2 });
    const cookie = await kioskDeviceCookie();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/kiosk-product/${id}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG_BYTES);
    });
  });

  it("🔒 كوكي جهاز مزوَّر/تالف ⇒ 401 (التوقيع يحكم لا وجود الكوكي)", async () => {
    const id = await seedProduct({ productId: 3 });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/kiosk-product/${id}`, {
        headers: { cookie: `${KIOSK_COOKIE_NAME}=not-a-real-token` },
      });
      expect(res.status).toBe(401);
    });
  });
});

describe("GET /api/img/kiosk-product/:id — البوّابة تختلف عن العلنيّ (سبب فصل المسار)", () => {
  it("⭐ منتجٌ مخفيّ عن المتجر ⇒ 200 للكشك المُصرَّح، و404 للعلنيّ — المساران لا يُوحَّدان", async () => {
    const id = await seedProduct({ productId: 4, showInStore: false });
    const cookie = await kioskDeviceCookie();
    await withServer(async (base) => {
      const viaKiosk = await fetch(`${base}/api/img/kiosk-product/${id}`, { headers: { cookie } });
      const viaPublic = await fetch(`${base}/api/img/product/${id}`);
      expect(viaKiosk.status).toBe(200); // الكشك يعرض الكتالوج كاملاً (قرار المالك ٨/٧)
      expect(viaPublic.status).toBe(404); // إخفاء المالك يسري على العلن
    });
  });

  it("🔒 منتج معطَّل أو خدمة ⇒ 404 حتى للكشك المُصرَّح (بوّابة الكشك ليست «كل شيء»)", async () => {
    const inactive = await seedProduct({ productId: 5, isActive: false });
    const service = await seedProduct({ productId: 6, isService: true });
    const cookie = await kioskDeviceCookie();
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/kiosk-product/${inactive}`, { headers: { cookie } })).status).toBe(404);
      expect((await fetch(`${base}/api/img/kiosk-product/${service}`, { headers: { cookie } })).status).toBe(404);
    });
  });
});

describe("GET /api/img/kiosk-product/:id — قابلية التخبئة", () => {
  it("⭐ الردّ private لا public — يعتمد على المصادقة ⇒ لا تخزّنه ذاكرةٌ وسيطة مشتركة", async () => {
    const id = await seedProduct({ productId: 7 });
    const cookie = await kioskDeviceCookie();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/kiosk-product/${id}`, { headers: { cookie } });
      const cc = res.headers.get("cache-control")!;
      expect(cc).toContain("private");
      expect(cc).not.toContain("public");
      expect(cc).toContain("immutable");
      expect(res.headers.get("etag")).toBeTruthy();
    });
  });

  /**
   * 🛡️ مراجعة Codex (P1): `private` **وحدها لا تكفي**. كاش المتصفّح مُفتَّحٌ بالـ**رابط** لا
   * بالجلسة، و`immutable` تعني «لا تُعِد التحقّق سنةً» ⇒ بعد خروج الجهاز/إبطال كوكيه يُخدَم
   * نفس الرابط **من الكاش بلا مرورٍ بـ`kioskViewerAllowed`** فتُعمَّر الرؤية بعد الجلسة.
   * `Vary: Cookie` يجعل المفتاح = (الرابط + الكوكي) ⇒ زوال الكوكي = مفتاحٌ آخر = شبكة = ٤٠١.
   */
  it("⭐ الردّ يحمل Vary: Cookie — وإلا عُمِّرت رؤية الصورة في الكاش بعد انتهاء الجلسة", async () => {
    const id = await seedProduct({ productId: 71 });
    const cookie = await kioskDeviceCookie();
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/kiosk-product/${id}`, { headers: { cookie } });
      expect(res.headers.get("vary")).toMatch(/cookie/i);
    });
  });

  it("⭐ حتى الردّ 304 يحمل Vary وCache-Control (وإلا حدّث الكاش مُدخَله من ردٍّ لا يصف تجزئته)", async () => {
    const id = await seedProduct({ productId: 72 });
    const cookie = await kioskDeviceCookie();
    await withServer(async (base) => {
      const first = await fetch(`${base}/api/img/kiosk-product/${id}`, { headers: { cookie } });
      const second = await fetch(`${base}/api/img/kiosk-product/${id}`, {
        headers: { cookie, "If-None-Match": first.headers.get("etag")! },
      });
      expect(second.status).toBe(304);
      expect(second.headers.get("vary")).toMatch(/cookie/i);
      expect(second.headers.get("cache-control")).toContain("private");
    });
  });

  it("العلنيّ يبقى public **وبلا Vary** (إضافتها تُجزّئ الكاش المشترك بلا مقابل ⇒ تُضعف #212/#213)", async () => {
    const id = await seedProduct({ productId: 8 });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${id}`);
      const cc = res.headers.get("cache-control")!;
      expect(cc).toContain("public");
      expect(cc).not.toContain("private");
      expect(res.headers.get("vary")).toBeNull();
    });
  });

  it("ETag مطابق ⇒ 304 بصفر بايت", async () => {
    const id = await seedProduct({ productId: 9 });
    const cookie = await kioskDeviceCookie();
    await withServer(async (base) => {
      const first = await fetch(`${base}/api/img/kiosk-product/${id}`, { headers: { cookie } });
      const second = await fetch(`${base}/api/img/kiosk-product/${id}`, {
        headers: { cookie, "If-None-Match": first.headers.get("etag")! },
      });
      expect(second.status).toBe(304);
      expect((await second.arrayBuffer()).byteLength).toBe(0);
    });
  });
});

describe("kioskService — الردّ يحمل روابط لا base64", () => {
  it("⭐ بنر الكشك يُعيد روابط النقطة (صفر base64) — جوهر التوفير", async () => {
    await seedProduct({ productId: 10 });
    await seedProduct({ productId: 11, showInStore: false }); // الكشك يعرضه أيضاً
    const rows = await kioskBanner(1);
    const withImages = rows.filter((r) => r.imageUrl);
    expect(withImages.length).toBe(2); // المخفيّ عن المتجر حاضرٌ في الكشك
    for (const r of withImages) {
      expect(r.imageUrl).toMatch(/^\/api\/img\/kiosk-product\/\d+\?v=[0-9a-f]{16}$/);
      expect(r.imageUrl).not.toContain("base64");
    }
    expect(JSON.stringify(rows)).not.toContain("base64");
  });

  /** درس #207: تحويل أيّ قيمة ليست data URL إلى null ⇒ صورةٌ تعمل تختفي بصمت. */
  it("قيمة ليست data URL (مسار مستورَد) ⇒ تُمرَّر كما هي", async () => {
    await seedProduct({ productId: 12 });
    await db().update(s.productImages).set({ url: "/uploads/legacy/12.jpg" });
    const row = (await kioskBanner(1)).find((r) => r.productId === 12);
    expect(row?.imageUrl).toBe("/uploads/legacy/12.jpg");
  });
});
