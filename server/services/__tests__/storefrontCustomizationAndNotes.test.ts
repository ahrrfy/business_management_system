import express from "express";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { COOKIE_NAME } from "@shared/const";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../../../drizzle/schema";
import { signSession } from "../../auth/session";
import { getDb } from "../../db";
import { imageRouter } from "../../imageRoute";
import { __resetImageStoreForTest } from "../../lib/imageStore";
import { storefrontRouter } from "../../routers/storefrontRouter";
import { router } from "../../trpc";
import { hashCouponCode } from "../couponService";
import { createOnlineOrder, quoteOnlineOrder } from "../onlineOrderService";
import * as salesPromoService from "../salesPromotionService";
import { resolveCouponPromotionForLine, resolvePromotionForLine } from "../salesPromotionService";
import { getOnlineOrder, updateOnlineOrder } from "../storeAdmin/orderFulfillmentService";
import { withTx } from "../tx";
import { truncateAllTables } from "./__testUtils__";

const mountedStorefrontRouter = router({ storefront: storefrontRouter });

const STAFF_SECRET = "staff_jwt_secret_for_testing_purposes_only_12345";
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_IMAGE_STORE_DRIVER = process.env.IMAGE_STORE_DRIVER;
const ORIGINAL_IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR;

// Minimal valid binary payloads for PNG (1x1), JPEG (1x1), and WEBP (1x1 VP8L)
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const VALID_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
  0x00, 0xff, 0xd9,
]);
const VALID_JPEG_BASE64 = VALID_JPEG_BYTES.toString("base64");
const VALID_WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe,
  0x07, 0x00,
]);
const VALID_WEBP_BASE64 = VALID_WEBP_BYTES.toString("base64");

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function publicCaller() {
  return mountedStorefrontRouter.createCaller({
    req: { ip: "198.51.100.88", headers: {}, socket: { remoteAddress: "198.51.100.88" } },
    res: {},
    user: null,
    sessionId: null,
    platformAdmin: null,
  } as never).storefront;
}

async function startImageTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use("/api/img", imageRouter());
  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind ephemeral server");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("Storefront Wave 2 — Customizer Asset Upload, Staff Image Gate, customerNotes & Batched Pricing", () => {
  let tempImageDir = "";

  beforeEach(async () => {
    tempImageDir = mkdtempSync(path.join(tmpdir(), "w2-img-store-"));
    process.env.JWT_SECRET = STAFF_SECRET;
    process.env.IMAGE_STORE_DRIVER = "fs";
    process.env.IMAGE_STORE_DIR = tempImageDir;
    __resetImageStoreForTest();
    await truncateAllTables();

    const d = db();
    await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
    await d.insert(s.users).values([
      {
        id: 1,
        openId: "w2-store-admin",
        name: "مدير المتجر",
        role: "admin",
        branchId: 1,
        loginMethod: "local",
        isActive: true,
        sessionsValidFrom: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: 2,
        openId: "w2-courier",
        name: "مندوب توصيل",
        role: "courier",
        branchId: 1,
        loginMethod: "local",
        isActive: true,
        sessionsValidFrom: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    await d.insert(s.storeSettings).values({
      id: 1,
      fulfillmentBranchId: 1,
      isOpen: true,
    });
    await d.insert(s.categories).values([
      { id: 10, name: "قرطاسية", isActive: true, showInStore: true },
      { id: 20, name: "هدايا مطبوعة", isActive: true, showInStore: true },
    ]);
    await d.insert(s.products).values([
      {
        id: 100,
        name: "كوب سيراميك مخصص",
        categoryId: 20,
        isCustomizable: true,
        showInStore: true,
        isActive: true,
      },
      {
        id: 200,
        name: "دفتر جامعي",
        categoryId: 10,
        isCustomizable: false,
        showInStore: true,
        isActive: true,
      },
      {
        id: 300,
        name: "قلم جاف",
        categoryId: 10,
        isCustomizable: false,
        showInStore: true,
        isActive: true,
      },
    ]);
    await d.insert(s.productVariants).values([
      { id: 100, productId: 100, sku: "MUG-CUSTOM", color: "أبيض", costPrice: "2000.00" },
      { id: 200, productId: 200, sku: "NOTE-A4", color: "أزرق", costPrice: "1000.00" },
      { id: 300, productId: 300, sku: "PEN-BLK", color: "أسود", costPrice: "250.00" },
    ]);
    await d.insert(s.productUnits).values([
      { id: 100, variantId: 100, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true },
      { id: 200, variantId: 200, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true },
      { id: 300, variantId: 300, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 100, priceTier: "RETAIL", price: "5000.00" },
      { productUnitId: 200, priceTier: "RETAIL", price: "3000.00" },
      { productUnitId: 200, priceTier: "WHOLESALE", price: "2400.00" },
      { productUnitId: 300, priceTier: "RETAIL", price: "1000.00" },
    ]);
    await d.insert(s.branchStock).values([
      { branchId: 1, variantId: 100, quantity: 50 },
      { branchId: 1, variantId: 200, quantity: 200 },
      { branchId: 1, variantId: 300, quantity: 200 },
    ]);
    await d.insert(s.productCustomizationTemplates).values({
      id: 1,
      productId: 100,
      kind: "GIFT",
      title: "تخصيص الكوب",
      isActive: true,
    });
    await d.insert(s.productCustomizationFields).values({
      id: 1,
      templateId: 1,
      fieldKey: "engraving_text",
      label: "النص المطبوع",
      fieldType: "TEXT",
      isRequired: true,
      maxLength: 80,
      priceDelta: "1500.00",
      sortOrder: 1,
      isActive: true,
    });
  });

  afterEach(() => {
    __resetImageStoreForTest();
    if (tempImageDir) rmSync(tempImageDir, { recursive: true, force: true });
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    if (ORIGINAL_IMAGE_STORE_DRIVER === undefined) delete process.env.IMAGE_STORE_DRIVER;
    else process.env.IMAGE_STORE_DRIVER = ORIGINAL_IMAGE_STORE_DRIVER;
    if (ORIGINAL_IMAGE_STORE_DIR === undefined) delete process.env.IMAGE_STORE_DIR;
    else process.env.IMAGE_STORE_DIR = ORIGINAL_IMAGE_STORE_DIR;
  });

  it("validates real magic bytes & 2MB binary cap on uploadCustomizationAsset, rejecting SVG/HTML/fake-PNG/WAV-as-WEBP", async () => {
    const caller = publicCaller();

    // Valid PNG, JPEG, WEBP uploads succeed
    const pngRes = await caller.uploadCustomizationAsset({
      kind: "LOGO",
      mimeType: "image/png",
      dataBase64: VALID_PNG_BASE64,
    });
    expect(pngRes).toMatchObject({
      assetKey: expect.stringMatching(/^single\/storefront-customizer\/logo\/[0-9a-f]{64}\.png$/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      mimeType: "image/png",
      byteLength: Buffer.from(VALID_PNG_BASE64, "base64").length,
    });

    const jpgRes = await caller.uploadCustomizationAsset({
      kind: "PREVIEW",
      mimeType: "image/jpeg",
      dataBase64: VALID_JPEG_BASE64,
    });
    expect(jpgRes.assetKey).toMatch(/^single\/storefront-customizer\/preview\/[0-9a-f]{64}\.jpg$/);

    const webpRes = await caller.uploadCustomizationAsset({
      kind: "PREVIEW",
      mimeType: "image/webp",
      dataBase64: VALID_WEBP_BASE64,
    });
    expect(webpRes.assetKey).toMatch(/^single\/storefront-customizer\/preview\/[0-9a-f]{64}\.webp$/);

    // SVG disguised as PNG -> rejected with BAD_REQUEST
    const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    await expect(
      caller.uploadCustomizationAsset({
        kind: "LOGO",
        mimeType: "image/png",
        dataBase64: svgBase64,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // RIFF....WAVE disguised as image/webp -> rejected with BAD_REQUEST
    const fakeWebpWav = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "binary").toString("base64");
    await expect(
      caller.uploadCustomizationAsset({
        kind: "LOGO",
        mimeType: "image/webp",
        dataBase64: fakeWebpWav,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Valid PNG bytes declared as image/jpeg -> rejected with BAD_REQUEST
    await expect(
      caller.uploadCustomizationAsset({
        kind: "LOGO",
        mimeType: "image/jpeg",
        dataBase64: VALID_PNG_BASE64,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // > 2MB PNG binary -> rejected with BAD_REQUEST
    const over2MbPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2 * 1024 * 1024, 0x41),
    ]);
    await expect(
      caller.uploadCustomizationAsset({
        kind: "LOGO",
        mimeType: "image/png",
        dataBase64: over2MbPng.toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // PNG decompression bomb (8192x8192 IHDR > 4096 max dimension) -> rejected with BAD_REQUEST
    const png8192Header = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x20, 0x00, // width = 8192
      0x00, 0x00, 0x20, 0x00, // height = 8192
      0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    await expect(
      caller.uploadCustomizationAsset({
        kind: "LOGO",
        mimeType: "image/png",
        dataBase64: png8192Header.toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("attaches logoAssetKey & previewAssetKey to createOnlineOrder snapshot, persists customerNotes, and gates /api/img/order-customization to store staff only", async () => {
    const caller = publicCaller();
    const logoAsset = await caller.uploadCustomizationAsset({
      kind: "LOGO",
      mimeType: "image/png",
      dataBase64: VALID_PNG_BASE64,
    });
    const secondLogoAsset = await caller.uploadCustomizationAsset({
      kind: "LOGO",
      mimeType: "image/jpeg",
      dataBase64: VALID_JPEG_BASE64,
    });
    const previewAsset = await caller.uploadCustomizationAsset({
      kind: "PREVIEW",
      mimeType: "image/webp",
      dataBase64: VALID_WEBP_BASE64,
    });

    // Wrong kind (PREVIEW key passed as logoAssetKey) must be rejected
    await expect(
      quoteOnlineOrder({
        governorate: "baghdad",
        lines: [
          {
            productUnitId: 100,
            quantity: 1,
            customization: {
              templateId: 1,
              values: { engraving_text: "مكتبة الرؤية" },
              logoAssetKey: previewAsset.assetKey,
            } as any,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Unknown assetKey must be rejected
    await expect(
      quoteOnlineOrder({
        governorate: "baghdad",
        lines: [
          {
            productUnitId: 100,
            quantity: 1,
            customization: {
              templateId: 1,
              values: { engraving_text: "مكتبة الرؤية" },
              logoAssetKey: `single/storefront-customizer/logo/${"f".repeat(64)}.png`,
            } as any,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Cross-tenant & path-traversal assetKey must be rejected
    for (const badKey of [
      `other-tenant/storefront-customizer/logo/${logoAsset.sha256}.png`,
      `single/storefront-customizer/../product-images/${logoAsset.sha256}.png`,
    ]) {
      await expect(
        quoteOnlineOrder({
          governorate: "baghdad",
          lines: [
            {
              productUnitId: 100,
              quantity: 1,
              customization: {
                templateId: 1,
                values: { engraving_text: "مكتبة الرؤية" },
                logoAssetKey: badKey,
              } as any,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    // Valid quote + createOnlineOrder + idempotent replay + customerNotes
    const customizationInput = {
      templateId: 1,
      values: { engraving_text: "مكتبة الرؤية" },
      logoAssetKey: logoAsset.assetKey,
      previewAssetKey: previewAsset.assetKey,
    };
    const quote = await quoteOnlineOrder({
      governorate: "baghdad",
      lines: [{ productUnitId: 100, quantity: 2, customization: customizationInput as any }],
    });
    expect(quote.lines[0]?.unitPrice).toBe("6500.00");
    expect(quote.lines[0]?.customization).toMatchObject({
      templateId: 1,
      logoAssetKey: logoAsset.assetKey,
      previewAssetKey: previewAsset.assetKey,
    });

    const [preAttachLogoRow] = await db()
      .select()
      .from(s.storefrontCustomizationAssets)
      .where(eq(s.storefrontCustomizationAssets.assetKey, logoAsset.assetKey));
    expect(preAttachLogoRow.expiresAt).toBeInstanceOf(Date);

    const created = await createOnlineOrder({
      customerName: "نور الهدى",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "شارع فلسطين - قرب الجامعة المستنصرية",
      notes: "  الاتصال قبل الوصول بنصف ساعة  ",
      clientRequestId: "w2-custom-order-req-001",
      expectedGrandTotal: quote.total,
      lines: [
        {
          productUnitId: 100,
          quantity: 2,
          expectedUnitPrice: "6500.00",
          customization: customizationInput as any,
        },
      ],
    } as any);

    // Attached assets have expiresAt cleared to null, and duplicate upload preserves null
    await caller.uploadCustomizationAsset({
      kind: "LOGO",
      mimeType: "image/png",
      dataBase64: VALID_PNG_BASE64,
    });
    const [postAttachLogoRow] = await db()
      .select()
      .from(s.storefrontCustomizationAssets)
      .where(eq(s.storefrontCustomizationAssets.assetKey, logoAsset.assetKey));
    expect(postAttachLogoRow.expiresAt).toBeNull();

    // Idempotent replay with identical customized payload succeeds without CONFLICT
    const replay = await createOnlineOrder({
      customerName: "نور الهدى",
      customerPhone: "07701234567",
      governorate: "baghdad",
      addressText: "شارع فلسطين - قرب الجامعة المستنصرية",
      notes: "الاتصال قبل الوصول بنصف ساعة",
      clientRequestId: "w2-custom-order-req-001",
      expectedGrandTotal: quote.total,
      lines: [
        {
          productUnitId: 100,
          quantity: 2,
          expectedUnitPrice: "6500.00",
          customization: customizationInput as any,
        },
      ],
    } as any);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.orderId).toBe(created.orderId);

    // Replay with same clientRequestId + same text values + DIFFERENT logoAssetKey must fail with CONFLICT
    await expect(
      createOnlineOrder({
        customerName: "نور الهدى",
        customerPhone: "07701234567",
        governorate: "baghdad",
        addressText: "شارع فلسطين - قرب الجامعة المستنصرية",
        notes: "الاتصال قبل الوصول بنصف ساعة",
        clientRequestId: "w2-custom-order-req-001",
        expectedGrandTotal: quote.total,
        lines: [
          {
            productUnitId: 100,
            quantity: 2,
            expectedUnitPrice: "6500.00",
            customization: {
              ...customizationInput,
              logoAssetKey: secondLogoAsset.assetKey,
            } as any,
          },
        ],
      } as any),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Expired unattached orphan asset must be rejected by quoteOnlineOrder
    await db()
      .update(s.storefrontCustomizationAssets)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(s.storefrontCustomizationAssets.assetKey, secondLogoAsset.assetKey));
    await expect(
      quoteOnlineOrder({
        governorate: "baghdad",
        lines: [
          {
            productUnitId: 100,
            quantity: 1,
            customization: {
              templateId: 1,
              values: { engraving_text: "مكتبة الرؤية" },
              logoAssetKey: secondLogoAsset.assetKey,
            } as any,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const [persistedOrder] = await db()
      .select()
      .from(s.onlineOrders)
      .where(eq(s.onlineOrders.id, created.orderId));
    expect(persistedOrder.customerNotes).toBe("الاتصال قبل الوصول بنصف ساعة");
    expect(persistedOrder.shippingAddress).toBe(
      "شارع فلسطين - قرب الجامعة المستنصرية\nملاحظة: الاتصال قبل الوصول بنصف ساعة",
    );

    const detail = (await getOnlineOrder(created.orderId, null)) as any;
    expect(detail.customerNotes).toBe("الاتصال قبل الوصول بنصف ساعة");
    expect(detail.items[0]?.logoAssetUrl).toMatch(/^\/api\/img\/order-customization\//);
    expect(detail.items[0]?.previewAssetUrl).toMatch(/^\/api\/img\/order-customization\//);

    // Pre-0406 fallback: if customerNotes is NULL in DB, getOnlineOrder falls back to shippingAddress note
    await db()
      .update(s.onlineOrders)
      .set({ customerNotes: null })
      .where(eq(s.onlineOrders.id, created.orderId));
    const fallbackDetail = (await getOnlineOrder(created.orderId, null)) as any;
    expect(fallbackDetail.customerNotes).toBe("الاتصال قبل الوصول بنصف ساعة");

    // Staff updateOnlineOrder synchronizes customerNotes
    await updateOnlineOrder(
      {
        id: created.orderId,
        notes: "توصيل بعد الساعة الرابعة عصراً",
        scopedBranchId: null,
      },
      1,
    );
    const updatedDetail = (await getOnlineOrder(created.orderId, null)) as any;
    expect(updatedDetail.customerNotes).toBe("توصيل بعد الساعة الرابعة عصراً");

    // Verify HTTP staff gate on /api/img/order-customization/...
    const srv = await startImageTestServer();
    try {
      const targetUrl = `${srv.baseUrl}${detail.items[0].logoAssetUrl}`;

      // 1) Anonymous visitor -> 401
      const anonRes = await fetch(targetUrl);
      expect(anonRes.status).toBe(401);

      // 2) Authenticated courier (store === "NONE") -> 403
      const staffUa = "vitest-staff-browser/1.0";
      const courierCookie = `${COOKIE_NAME}=${await signSession(2, undefined, {
        headers: { "user-agent": staffUa },
      })}`;
      const courierRes = await fetch(targetUrl, {
        headers: { cookie: courierCookie, "user-agent": staffUa },
      });
      expect(courierRes.status).toBe(403);

      // 3) Authenticated store admin (store !== "NONE") -> 200 with private no-store + nosniff
      const adminCookie = `${COOKIE_NAME}=${await signSession(1, undefined, {
        headers: { "user-agent": staffUa },
      })}`;
      const adminRes = await fetch(targetUrl, {
        headers: { cookie: adminCookie, "user-agent": staffUa },
      });
      expect(adminRes.status).toBe(200);
      expect(adminRes.headers.get("content-type")).toBe("image/png");
      expect(adminRes.headers.get("cache-control")).toContain("private");
      expect(adminRes.headers.get("cache-control")).toContain("no-store");
      expect(adminRes.headers.get("x-content-type-options")).toBe("nosniff");
      const servedBytes = Buffer.from(await adminRes.arrayBuffer());
      expect(servedBytes.equals(Buffer.from(VALID_PNG_BASE64, "base64"))).toBe(true);

      // 4) Proxy-decoded path (/api/img/order-customization/single/storefront-customizer/...) also works for store admin
      const unencodedRes = await fetch(
        `${srv.baseUrl}/api/img/order-customization/${logoAsset.assetKey}`,
        { headers: { cookie: adminCookie, "user-agent": staffUa } },
      );
      expect(unencodedRes.status).toBe(200);
      expect(Buffer.from(await unencodedRes.arrayBuffer()).equals(servedBytes)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("batches multi-line promotion & coupon queries in quoteOnlineOrder with exact parity against per-line resolution", async () => {
    const d = db();
    await d.insert(s.promotions).values([
      {
        id: 21,
        name: "خصم فئة القرطاسية 10%",
        type: "PERCENT",
        discountPercent: "10.00",
        discountAmount: "0.00",
        maxDiscountAmount: "250.00",
        scope: "CATEGORIES",
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2027-01-01"),
        branchId: 1,
        customerTier: "RETAIL",
        minLineAmount: "2000.00",
        priority: 20,
        isActive: true,
        applicationMode: "AUTO",
        isStoreManaged: true,
      },
      {
        id: 22,
        name: "خصم الكوب المخصص 500",
        type: "AMOUNT",
        discountPercent: "0.00",
        discountAmount: "500.00",
        scope: "PRODUCTS",
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2027-01-01"),
        branchId: 1,
        customerTier: "RETAIL",
        minLineAmount: "0.00",
        priority: 30,
        isActive: true,
        applicationMode: "AUTO",
        isStoreManaged: true,
      },
      {
        id: 23,
        name: "كوبون المتجر الشامل 20%",
        type: "PERCENT",
        discountPercent: "20.00",
        discountAmount: "0.00",
        scope: "ALL",
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2027-01-01"),
        branchId: 1,
        customerTier: "RETAIL",
        minLineAmount: "0.00",
        priority: 50,
        isActive: true,
        applicationMode: "COUPON",
        isStoreManaged: true,
      },
    ]);
    await d.insert(s.promotionTargets).values([
      { promotionId: 21, categoryId: 10 },
      { promotionId: 22, productId: 100 },
    ]);
    await d.insert(s.couponPrograms).values({
      id: 23,
      promotionId: 23,
      name: "حملة 20%",
      status: "ACTIVE",
      branchId: 1,
      validFrom: new Date("2026-01-01"),
      validTo: new Date("2027-01-01"),
      perCouponLimit: 5,
      perCustomerLimit: 5,
      codePrefix: "SAVE20",
      createdBy: 1,
    });
    await d.insert(s.coupons).values({
      id: 230,
      programId: 23,
      code: "SAVE20NOW",
      codeHash: hashCouponCode("SAVE20NOW"),
      status: "ACTIVE",
    });

    const lines = [
      {
        productUnitId: 100,
        quantity: 2,
        customization: { templateId: 1, values: { engraving_text: "هدية تخرج" } },
      },
      { productUnitId: 200, quantity: 3 },
      { productUnitId: 300, quantity: 1 }, // lineAmount = 1000 < minLineAmount 2000 for promo 21!
    ];

    // 1) AUTO offer parity against per-line resolvePromotionForLine + O(1) runtime snapshot load
    const snapshotSpy = vi.spyOn(salesPromoService, "loadPromotionRuleSnapshot");
    const autoQuote = await quoteOnlineOrder({
      governorate: "baghdad",
      lines,
    });
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    const todayYmd = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const expectedPerLineAuto = await withTx(async (tx) => [
      await resolvePromotionForLine(tx, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 100,
        variantId: 100,
        categoryId: 20,
        unitPrice: "5000.00",
        lineAmount: "10000.00",
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true,
      }),
      await resolvePromotionForLine(tx, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 200,
        variantId: 200,
        categoryId: 10,
        unitPrice: "3000.00",
        lineAmount: "9000.00",
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true,
      }),
      await resolvePromotionForLine(tx, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 300,
        variantId: 300,
        categoryId: 10,
        unitPrice: "1000.00",
        lineAmount: "1000.00",
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true,
      }),
    ]);

    expect(autoQuote.pricingBenefitType).toBe("OFFER");
    expect(autoQuote.lines.map((l) => l.discountPerUnit)).toEqual(
      expectedPerLineAuto.map((p) => p?.discountForUnit ?? "0.00"),
    );
    expect(autoQuote.lines.map((l) => l.discountPerUnit)).toEqual(["500.00", "250.00", "0.00"]);

    // 2) COUPON parity against per-line resolveCouponPromotionForLine + O(1) runtime snapshot load
    snapshotSpy.mockClear();
    const couponQuote = await quoteOnlineOrder({
      governorate: "baghdad",
      couponCode: "SAVE20NOW",
      lines,
    });
    expect(snapshotSpy).toHaveBeenCalledTimes(2); // 1 AUTO snapshot + 1 COUPON snapshot across all 3 lines
    snapshotSpy.mockRestore();
    const expectedPerLineCoupon = await withTx(async (tx) => [
      await resolveCouponPromotionForLine(tx, 23, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 100,
        variantId: 100,
        categoryId: 20,
        unitPrice: "5000.00",
        lineAmount: "10000.00",
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true,
      }),
      await resolveCouponPromotionForLine(tx, 23, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 200,
        variantId: 200,
        categoryId: 10,
        unitPrice: "3000.00",
        lineAmount: "9000.00",
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true,
      }),
      await resolveCouponPromotionForLine(tx, 23, {
        branchId: 1,
        customerTier: "RETAIL",
        productId: 300,
        variantId: 300,
        categoryId: 10,
        unitPrice: "1000.00",
        lineAmount: "1000.00",
        hasContractPrice: false,
        todayYmd,
        includeStoreManaged: true,
      }),
    ]);

    expect(couponQuote.pricingBenefitType).toBe("COUPON");
    expect(couponQuote.lines.map((l) => l.couponDiscountPerUnit)).toEqual(
      expectedPerLineCoupon.map((p) => p?.discountForUnit ?? "0.00"),
    );
    expect(couponQuote.lines.map((l) => l.couponDiscountPerUnit)).toEqual([
      "1000.00",
      "600.00",
      "200.00",
    ]);

    // 3) Static source check: priceOnlineOrderLines does NOT call resolvePromotionForLine or resolveCouponPromotionForLine inside per-line loop
    const { readFileSync } = await import("node:fs");
    const onlineOrderSrc = readFileSync(
      new URL("../onlineOrderService.ts", import.meta.url),
      "utf8",
    );
    expect(onlineOrderSrc).not.toMatch(/await\s+resolvePromotionForLine\s*\(/);
    expect(onlineOrderSrc).not.toMatch(/await\s+resolveCouponPromotionForLine\s*\(/);
  });
});
