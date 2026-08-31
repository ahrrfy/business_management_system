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
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import * as s from "../../../drizzle/schema";
import { signSession } from "../../auth/session";
import { getDb } from "../../db";
import { imageRouter, productImageUrl } from "../../imageRoute";
import {
  __resetImageStoreForTest,
  contentHash,
  getImageStore,
  ImageStoreUnavailableError,
  MAX_PUBLISHED_PRODUCT_IMAGE_BYTES,
  objectKeyFor,
  shortHash,
} from "../../lib/imageStore";
import { storefrontProduct } from "../storefrontService";
import { approveStudioTask, assignStudioTask, submitStudioCandidate } from "../productStudioService";
import { COUNT_COOKIE_NAME, signCountToken } from "../countPortal/token";
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
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const THUMB_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const THUMB_DATA_URL = `data:image/png;base64,${THUMB_BYTES.toString("base64")}`;
const WEBP_1X1 =
  "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
let imageStoreDir = "";
const previousJwtSecret = process.env.JWT_SECRET;

/** يزرع منتجاً كامل السلسلة (منتج→متغيّر→وحدة→سعر) + صورةً رئيسية، ويعيد معرّف الصورة. */
async function seedProduct(opts: {
  productId: number;
  showInStore?: boolean;
  isActive?: boolean;
  isService?: boolean;
  imageValue?: string | null;
  reviewStatus?: "APPROVED" | "PENDING_REVIEW" | "REJECTED";
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
    isStoreSaleUnit: true,
    isActive: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: id, priceTier: "RETAIL", price: "1000" });
  const value = opts.imageValue === undefined ? JPEG_DATA_URL : opts.imageValue;
  if (value == null) return 0;
  await d.insert(s.productImages).values({
    id,
    productId: id,
    url: value,
    isPrimary: true,
    reviewStatus: opts.reviewStatus ?? "APPROVED",
  });
  return id;
}

beforeEach(async () => {
  process.env.JWT_SECRET = "product-image-endpoint-test-secret-at-least-32-characters";
  imageStoreDir = await mkdtemp(path.join(tmpdir(), "erp-product-image-route-"));
  process.env.IMAGE_STORE_DRIVER = "fs";
  process.env.IMAGE_STORE_DIR = imageStoreDir;
  __resetImageStoreForTest();
  await truncateTables([
    "stocktakeItems",
    "stocktakeAssignments",
    "stocktakeSessions",
    "productImages",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "branches",
    "users",
  ]);
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  __resetImageStoreForTest();
  delete process.env.IMAGE_STORE_DRIVER;
  delete process.env.IMAGE_STORE_DIR;
  if (previousJwtSecret == null) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
  if (imageStoreDir) await rm(imageStoreDir, { recursive: true, force: true });
});

describe("GET /api/img/inventory-product/:id — صورة داخلية محمية", () => {
  it("تخدم المادة المخفية لمستخدم النظام فقط ولا تخدم صورة غير معتمدة", async () => {
    const hiddenImage = await seedProduct({ productId: 41, showInStore: false, isActive: false });
    const pendingImage = await seedProduct({ productId: 42, reviewStatus: "PENDING_REVIEW" });
    const userAgent = "inventory-image-route-test";
    const sessionToken = await signSession(
      1,
      undefined,
      { headers: { "user-agent": userAgent } },
      Math.floor(Date.now() / 1000) + 1,
    );

    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/inventory-product/${hiddenImage}`)).status).toBe(401);

      const headers = {
        Cookie: `${COOKIE_NAME}=${sessionToken}`,
        "User-Agent": userAgent,
      };
      const allowed = await fetch(`${base}/api/img/inventory-product/${hiddenImage}`, { headers });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toContain("private");
      expect(Buffer.from(await allowed.arrayBuffer())).toEqual(JPEG_BYTES);
      expect((await fetch(`${base}/api/img/inventory-product/${pendingImage}`, { headers })).status).toBe(404);
    });
  });
});

describe("GET /api/img/count-product/:sessionCode/:id — صورة ضمن نطاق الجلسة", () => {
  it("تقبل هوية PIN للجلسة نفسها وتمنع تخمين صورة منتج خارج نطاقها", async () => {
    const inScopeImage = await seedProduct({ productId: 51, showInStore: false });
    const outsideImage = await seedProduct({ productId: 52, showInStore: false });
    await db().insert(s.stocktakeSessions).values({
      id: 501,
      code: "CNT-IMG-501",
      name: "جرد الصور",
      branchId: 1,
      scopeType: "MANUAL",
      status: "COUNTING",
    });
    await db().insert(s.stocktakeAssignments).values({
      id: 502,
      sessionId: 501,
      name: "عامل الصور",
      method: "PIN",
      status: "ACTIVE",
    });
    await db().insert(s.stocktakeItems).values({
      id: 503,
      sessionId: 501,
      assignmentId: 502,
      variantId: 51,
      branchId: 1,
      expectedQty: 0,
      unitCost: "0",
    });
    const countToken = await signCountToken(501, 502);

    await withServer(async (base) => {
      const path = `${base}/api/img/count-product/CNT-IMG-501`;
      expect((await fetch(`${path}/${inScopeImage}`)).status).toBe(401);

      const headers = { Cookie: `${COUNT_COOKIE_NAME}=${countToken}` };
      const allowed = await fetch(`${path}/${inScopeImage}`, { headers });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toContain("private");
      expect(Buffer.from(await allowed.arrayBuffer())).toEqual(JPEG_BYTES);
      expect((await fetch(`${path}/${outsideImage}`, { headers })).status).toBe(404);
    });
  });
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

  it("🔒 صورة قيد المراجعة أو مرفوضة ⇒ 404 حتى لو كان المنتج منشوراً", async () => {
    const pending = await seedProduct({ productId: 31, reviewStatus: "PENDING_REVIEW" });
    const rejected = await seedProduct({ productId: 32, reviewStatus: "REJECTED" });
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/${pending}`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/product/${rejected}`)).status).toBe(404);
    });
  });

  it("لا يُضمّن الكتالوج رابط صورة غير معتمدة أصلاً", async () => {
    await seedProduct({ productId: 33, reviewStatus: "PENDING_REVIEW" });
    expect((await storefrontProduct(33, 1))?.imageUrl).toBeNull();
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

describe("GET /api/img/product/:id — مشتق معتمد من المخزن الخاص", () => {
  async function seedStored(
    productId: number,
    prefix = "single/studio/candidate",
    thumbDataUrl: string | null = THUMB_DATA_URL,
  ) {
    const imageId = await seedProduct({ productId });
    const hash = contentHash(JPEG_BYTES);
    const objectKey = objectKeyFor(hash, "image/jpeg", prefix);
    await getImageStore().put(objectKey, JPEG_BYTES, "image/jpeg");
    await db().update(s.productImages).set({
      url: `/api/img/product/${imageId}?v=${shortHash(hash)}`,
      objectKey,
      contentHash: hash,
      mime: "image/jpeg",
      bytes: JPEG_BYTES.length,
      width: 1200,
      height: 1200,
      thumbDataUrl,
      reviewStatus: "APPROVED",
    });
    return { imageId, hash };
  }

  it("يبث المشتق المعتمد عبر الخادم بلا redirect أو كشف objectKey", async () => {
    const { imageId, hash } = await seedStored(81);
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG_BYTES);
    });
  });

  it("يخدم مشتق 320 المعتمد من DB دون فتح R2 وبسقف كاش قصير قابل لإعادة التحقق", async () => {
    const { imageId, hash } = await seedStored(97);
    const getBuffer = vi.spyOn(getImageStore(), "getBuffer");
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}&w=320`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-image-variant")).toBe("320");
      expect(res.headers.get("cache-control")).toContain("max-age=300");
      expect(res.headers.get("cache-control")).not.toContain("immutable");
      expect(Number(res.headers.get("content-length"))).toBeLessThanOrEqual(128 * 1024);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(THUMB_BYTES);
    });
    expect(getBuffer).not.toHaveBeenCalled();
  });

  it("يقيد w إلى 320/640/1200 ويعلن fallback للأصل عند غياب مشتق الحجم", async () => {
    const { imageId, hash } = await seedStored(98);
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}&w=321`)).status).toBe(400);
      for (const width of [640, 1200]) {
        const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}&w=${width}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-image-variant")).toBe("original-fallback");
        expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG_BYTES);
      }
    });
  });

  it("يعيد محاولة قراءة R2 العابرة مرة واحدة قبل السقوط إلى المصغّرة", async () => {
    const { imageId, hash } = await seedStored(99);
    const getBuffer = vi.spyOn(getImageStore(), "getBuffer")
      .mockRejectedValueOnce(new ImageStoreUnavailableError("upstream", "get"))
      .mockResolvedValueOnce(JPEG_BYTES);
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}&w=1200`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-image-fallback")).toBeNull();
      expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG_BYTES);
    });
    expect(getBuffer).toHaveBeenCalledTimes(2);
  });

  it("يعيد 304 من البصمة قبل فتح كائن المخزن", async () => {
    const { imageId, hash } = await seedStored(87);
    const getBuffer = vi.spyOn(getImageStore(), "getBuffer");
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`, {
        headers: { "If-None-Match": `"${shortHash(hash)}"` },
      });
      expect(res.status).toBe(304);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });
    expect(getBuffer).not.toHaveBeenCalled();
  });

  it("يقبل أكبر مشتق صالح وفق عقد submit المشترك دون خفض صامت للحد", async () => {
    const imageId = await seedProduct({ productId: 96 });
    const payload = Buffer.alloc(MAX_PUBLISHED_PRODUCT_IMAGE_BYTES, 0x5a);
    const hash = contentHash(payload);
    const objectKey = objectKeyFor(hash, "image/jpeg", "single/studio/candidate");
    await getImageStore().put(objectKey, payload, "image/jpeg");
    await db().update(s.productImages).set({
      url: `/api/img/product/${imageId}?v=${shortHash(hash)}`,
      objectKey,
      contentHash: hash,
      mime: "image/jpeg",
      bytes: payload.length,
      reviewStatus: "APPROVED",
    }).where(eq(s.productImages.id, imageId));
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`);
      expect(response.status).toBe(200);
      expect(Number(response.headers.get("content-length"))).toBe(MAX_PUBLISHED_PRODUCT_IMAGE_BYTES);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    });
  });

  it("يسقط عند عطل R2 العابر إلى thumbDataUrl المعتمدة فقط وبلا كاش ثابت", async () => {
    const { imageId, hash } = await seedStored(88);
    // قيمة url مختلفة عمداً: لو استعملها fallback بدل thumbDataUrl لكشف الاختبار ذلك.
    await db().update(s.productImages).set({ url: JPEG_DATA_URL }).where(eq(s.productImages.id, imageId));
    vi.spyOn(getImageStore(), "getBuffer").mockRejectedValue(new ImageStoreUnavailableError("upstream", "get"));

    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("x-image-fallback")).toBe("thumbnail");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(THUMB_BYTES);
    });
  });

  it("submit→approve ينشر WebP المصغّرة ثم يخدمها عند عطل R2 العابر", async () => {
    await seedProduct({ productId: 92, imageValue: null });
    await db().insert(s.users).values({
      id: 2,
      openId: "studio-route-worker",
      name: "موظف الصور",
      role: "print_operator",
      branchId: 1,
      loginMethod: "local",
    });
    const admin = { userId: 1, branchId: null, role: "admin" } as const;
    const worker = { userId: 2, branchId: 1, role: "print_operator" } as const;
    const { taskId } = await assignStudioTask(admin, { productId: 92, assigneeId: 2, sourceImageId: null });
    await submitStudioCandidate(worker, {
      taskId,
      originalDataUrl: PNG_1X1,
      processedDataUrl: PNG_1X1,
      thumbnailDataUrl: WEBP_1X1,
      mode: "FLATTEN",
    });
    const { imageId } = await approveStudioTask(admin, taskId);
    const [published] = await db().select().from(s.productImages).where(eq(s.productImages.id, imageId));
    expect(published?.thumbDataUrl).toBe(WEBP_1X1);
    vi.spyOn(getImageStore(), "getBuffer").mockRejectedValue(new ImageStoreUnavailableError("upstream", "get"));

    await withServer(async (base) => {
      const res = await fetch(`${base}${published!.url}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-image-fallback")).toBe("thumbnail");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(WEBP_1X1.split(",")[1], "base64"));
    });
  });

  it("لا يحول AccessDenied أو غياب الكائن إلى fallback ولا يخفي خطأ الإعداد", async () => {
    const denied = await seedStored(89);
    const missing = await seedStored(90);
    const store = getImageStore();
    vi.spyOn(store, "getBuffer")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }))
      .mockResolvedValueOnce(null);

    await withServer(async (base) => {
      const deniedResponse = await fetch(`${base}/api/img/product/${denied.imageId}?v=${shortHash(denied.hash)}`);
      expect(deniedResponse.status).toBe(500);
      expect(deniedResponse.headers.get("cache-control")).toBe("no-store");
      expect(deniedResponse.headers.get("etag")).toBeNull();
      const missingResponse = await fetch(`${base}/api/img/product/${missing.imageId}?v=${shortHash(missing.hash)}`);
      expect(missingResponse.status).toBe(404);
      expect(missingResponse.headers.get("cache-control")).toBe("no-store");
      expect(missingResponse.headers.get("etag")).toBeNull();
    });
  });

  it("عطل عابر بلا مصغّرة آمنة ⇒ 503 ولا يسقط إلى url أو الأصل", async () => {
    const { imageId, hash } = await seedStored(91, "single/studio/candidate", null);
    vi.spyOn(getImageStore(), "getBuffer").mockRejectedValueOnce(new ImageStoreUnavailableError("circuit_open", "get"));
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    });
  });

  it("خطأ body العابر قبل اكتماله يعيد المصغّرة وحدها بلا partial أو كاش", async () => {
    const { imageId, hash } = await seedStored(93);
    vi.spyOn(getImageStore(), "getBuffer").mockRejectedValue(new ImageStoreUnavailableError(
      "upstream",
      "get",
      Object.assign(new Error("body reset"), { code: "ECONNRESET" }),
    ));
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("x-image-fallback")).toBe("thumbnail");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(THUMB_BYTES);
    });
  });

  it("يفشل مغلقاً عند فساد البصمة أو metadata فوق سقف العرض ولا يستخدم المصغّرة", async () => {
    const corrupt = await seedStored(94);
    const oversized = await seedStored(95);
    const wrongHash = "f".repeat(64);
    await db().update(s.productImages).set({ contentHash: wrongHash }).where(eq(s.productImages.id, corrupt.imageId));
    await db().update(s.productImages).set({ bytes: MAX_PUBLISHED_PRODUCT_IMAGE_BYTES + 1 }).where(eq(s.productImages.id, oversized.imageId));
    const getBuffer = vi.spyOn(getImageStore(), "getBuffer");

    await withServer(async (base) => {
      const corruptResponse = await fetch(`${base}/api/img/product/${corrupt.imageId}?v=${shortHash(wrongHash)}`);
      expect(corruptResponse.status).toBe(500);
      expect(corruptResponse.headers.get("cache-control")).toBe("no-store");
      expect(corruptResponse.headers.get("x-image-fallback")).toBeNull();
      const oversizedResponse = await fetch(`${base}/api/img/product/${oversized.imageId}?v=${shortHash(oversized.hash)}`);
      expect(oversizedResponse.status).toBe(500);
      expect(oversizedResponse.headers.get("cache-control")).toBe("no-store");
      expect(oversizedResponse.headers.get("x-image-fallback")).toBeNull();
    });
    expect(getBuffer).toHaveBeenCalledTimes(1);
  });

  it("يرفض بصمة رابط ناقصة/خاطئة ولا يفتح R2 كدليل ملفات", async () => {
    const { imageId, hash } = await seedStored(82);
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/${imageId}`)).status).toBe(404);
      expect((await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}0`)).status).toBe(404);
    });
  });

  it("لا يخدم مفتاح الأصل حتى لو أُدخل خطأً في صف صورة منشورة", async () => {
    const { imageId, hash } = await seedStored(83, "single/studio/original");
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`)).status).toBe(404);
    });
  });

  it("لا يخدم مشتقاً pending/rejected ولو كان كائنه موجوداً ومعرّفه معلوماً", async () => {
    for (const [offset, reviewStatus] of ["PENDING_REVIEW", "REJECTED"].entries()) {
      const { imageId, hash } = await seedStored(84 + offset);
      await db().update(s.productImages).set({ reviewStatus: reviewStatus as "PENDING_REVIEW" | "REJECTED" })
        .where(eq(s.productImages.id, imageId));
      await withServer(async (base) => {
        expect((await fetch(`${base}/api/img/product/${imageId}?v=${shortHash(hash)}`)).status).toBe(404);
      });
    }
  });
});

describe("storefrontService — العقد الثلاثيّ لصورة المنتج", () => {
  it("data URL ⇒ رابط النقطة ببصمة المحتوى (لا base64 في الردّ)", async () => {
    const imageId = await seedProduct({ productId: 8 });
    const item = await storefrontProduct(8, 1);
    expect(item?.imageUrl).toMatch(new RegExp(`^/api/img/product/${imageId}\\?v=[0-9a-f]{16}&w=1200$`));
    expect(item?.imageUrl).not.toContain("base64");
  });

  it("يبني روابط الأحجام المسموحة فقط وبمفتاح كاش مستقل", () => {
    expect(productImageUrl(7, JPEG_DATA_URL, 320)).toMatch(/^\/api\/img\/product\/7\?v=[0-9a-f]{16}&w=320$/);
    expect(() => productImageUrl(7, JPEG_DATA_URL, 321 as never)).toThrow();
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
