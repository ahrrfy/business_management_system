import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createOnlineOrder } from "../../services/onlineOrderService";
import { createStorefrontQuoteRequest } from "../../services/storefrontQuoteRequestService";
import { truncateAllTables } from "../../services/__tests__/__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function signCustomerToken(customerId: number, phone: string): Promise<string> {
  const secret = process.env.STOREFRONT_JWT_SECRET?.trim() || process.env.JWT_SECRET || "test_secret";
  return new SignJWT({
    scope: "storefront-customer",
    cid: customerId,
    fuid: `fuid-${customerId}`,
    phone,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("alarabiya-storefront")
    .setAudience("customer-mobile")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

function makePublicCaller() {
  return appRouter.createCaller({
    req: { headers: {}, ip: "127.0.0.1" },
    res: {},
    user: null,
    sessionId: null,
  } as never);
}

describe("storefront automatic auditLogs relief — إعفاء القراءات والقياس العلني فقط", () => {
  let customerToken = "";
  let orderNumber = "";
  let orderTrackingToken = "";
  let quoteRequestNumber = "";
  let quoteTrackingToken = "";

  beforeEach(async () => {
    await truncateAllTables();
    const d = db();
    await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
    await d.insert(s.users).values({
      id: 1,
      openId: "audit-relief-admin",
      name: "المشرف",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
    });
    await d.insert(s.customers).values({
      id: 10,
      name: "زبون المتجر",
      phone: "+9647701234567",
      customerType: "فرد",
      defaultPriceTier: "RETAIL",
      creditLimit: "0",
      currentBalance: "0",
      isActive: true,
      clientRequestId: "firebase-phone:fuid-10",
    });
    await d.insert(s.products).values([
      { id: 1, name: "دفتر جامعي", showInStore: true, isActive: true },
      { id: 2, name: "قلم جاف", showInStore: true, isActive: true },
    ]);
    await d.insert(s.productVariants).values([
      { id: 1, productId: 1, sku: "NB-1", costPrice: "1000.00", isActive: true },
      { id: 2, productId: 2, sku: "PEN-2", costPrice: "200.00", isActive: true },
    ]);
    await d.insert(s.productUnits).values([
      { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, isActive: true },
      { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, isStoreSaleUnit: true, isActive: true },
    ]);
    await d.insert(s.productPrices).values([
      { productUnitId: 1, priceTier: "RETAIL", price: "2500.00" },
      { productUnitId: 2, priceTier: "RETAIL", price: "500.00" },
    ]);
    await d.insert(s.branchStock).values([
      { branchId: 1, variantId: 1, quantity: 50 },
      { branchId: 1, variantId: 2, quantity: 50 },
    ]);
    await d.insert(s.storeSettings).values({ id: 1, fulfillmentBranchId: 1, isOpen: true });
    await d.insert(s.storeBanners).values({
      id: 1,
      title: "بنر ترحيبي",
      imageUrl: "/images/banner.jpg",
      isActive: true,
      sortOrder: 1,
    });

    customerToken = await signCustomerToken(10, "+9647701234567");

    const order = await createOnlineOrder({
      customerName: "زبون المتجر",
      customerPhone: "+9647701234567",
      governorate: "baghdad",
      addressText: "الكرادة",
      lines: [{ productUnitId: 1, quantity: 2 }],
      authenticatedCustomer: { customerId: 10, phone: "+9647701234567" },
    });
    orderNumber = order.orderNumber;
    orderTrackingToken = order.guestTrackingToken!;

    const quoteReq = await createStorefrontQuoteRequest({
      customerName: "زبون المتجر",
      customerPhone: "+9647701234567",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "طلب عرض سعر تجريبي",
      clientRequestId: "quote-req-audit-test-01",
      lines: [{ productUnitId: 1, quantity: 5 }],
      authenticatedCustomer: { customerId: 10, phone: "+9647701234567" },
    });
    quoteRequestNumber = quoteReq.requestNumber;
    quoteTrackingToken = quoteReq.guestTrackingToken!;

    // صفّر auditLogs قبل قياس الإجراءات التعاقدية عبر tRPC
    await d.delete(s.auditLogs);
  });

  it("لا يكتب أي سطر في auditLogs عند استدعاء إجراءات التسعير والتتبع والقياس غير المالية", async () => {
    const caller = makePublicCaller();

    const quoteRes = await caller.storefront.quoteOrderPrivate({
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 2 }],
      customerSessionToken: customerToken,
    });
    expect(Number(quoteRes.subtotal)).toBe(5000);

    const benefitsRes = await caller.storefront.customerBenefitsPrivate({
      customerSessionToken: customerToken,
    });
    expect(benefitsRes.customer.id).toBe(10);

    const trackedPrivate = await caller.storefront.trackOrderPrivate({
      orderNumber,
      customerSessionToken: customerToken,
    });
    expect(trackedPrivate?.orderNumber).toBe(orderNumber);

    const trackedGuest = await caller.storefront.trackOrderByToken({
      trackingToken: orderTrackingToken,
    });
    expect(trackedGuest?.orderNumber).toBe(orderNumber);

    const trackedQuotePrivate = await caller.storefront.trackQuoteRequestPrivate({
      requestNumber: quoteRequestNumber,
      customerSessionToken: customerToken,
    });
    expect(trackedQuotePrivate?.requestNumber).toBe(quoteRequestNumber);

    const trackedQuoteGuest = await caller.storefront.trackQuoteRequestByToken({
      trackingToken: quoteTrackingToken,
    });
    expect(trackedQuoteGuest?.requestNumber).toBe(quoteRequestNumber);

    await caller.storefront.trackBanner({ bannerId: 1, placement: "HERO", event: "IMPRESSION" });
    await caller.storefront.trackConversion({ event: "PRODUCT_VIEW" });
    await caller.storefront.trackRecommendationClick({ sourceProductId: 1, recommendedProductId: 2 });
    await caller.storefront.trackPushInteraction({ deliveryId: 9999, event: "OPEN" });

    // حتى لو كان المتصفح نفسه يحمل جلسة موظف (ctx.user != null) أثناء تصفح المتجر، لا تضخّم هذه القراءات auditLogs
    const staffBrowsingCaller = appRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1" },
      res: {},
      user: {
        id: 1,
        openId: "audit-relief-admin",
        name: "المشرف",
        role: "admin",
        branchId: 1,
        isActive: true,
      },
      sessionId: 1,
    } as never);
    await staffBrowsingCaller.storefront.trackConversion({ event: "ADD_TO_CART" });
    await staffBrowsingCaller.storefront.trackOrderByToken({
      trackingToken: orderTrackingToken,
    });

    const auditRows = await db().select().from(s.auditLogs);
    expect(auditRows).toHaveLength(0);
  });

  it("يُبقي التدقيق التلقائي كاملاً 100% لإجراءات الكتابة الفعلية في المتجر وإجراءات الإدارة", async () => {
    const caller = makePublicCaller();

    // ١) مشاركة المفضلة والسلة تكتب سجلاً عاماً ⇒ تُدقَّق
    await caller.storefront.createWishlistShare({ productIds: [1] });
    await caller.storefront.createCartShare({
      lines: [{ productId: 1, productUnitId: 1, quantity: 2 }],
    });

    // ٢) إلغاء طلب المتجر حالة مالية/تشغيلية مغيِّرة لحجز المخزون ⇒ يُدقَّق حتماً
    await caller.storefront.cancelOrderByToken({
      trackingToken: orderTrackingToken,
    });

    const publicWriteAudits = await db().select().from(s.auditLogs);
    const actions = publicWriteAudits.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "rpc.storefront.createWishlistShare",
        "rpc.storefront.createCartShare",
        "rpc.storefront.cancelOrderByToken",
      ]),
    );

    // ٣) إجراءات الإدارة الداخلية تظل خاضعة للتدقيق الكامل
    const adminCaller = appRouter.createCaller({
      req: { headers: {}, ip: "127.0.0.1" },
      res: {},
      user: {
        id: 1,
        openId: "audit-relief-admin",
        name: "المشرف",
        role: "admin",
        branchId: 1,
        isActive: true,
      },
      sessionId: 1,
    } as never);
    await adminCaller.storeAdmin.banners.create({
      title: "بنر مدقَّق",
      imageUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      isActive: true,
      sortOrder: 2,
    });
    const adminAudit = await db()
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, "store.banner.create"));
    expect(adminAudit).toHaveLength(1);
  });
});
