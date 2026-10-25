import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_COUPON_STORAGE_KEY,
  clearActiveCouponCode,
  loadActiveCouponCode,
  normalizeActiveCouponCode,
  reconcileStoredCouponWithCheckout,
  saveActiveCouponCode,
  shouldInvalidateCouponOnQuoteError,
  type ActiveCouponStorage,
} from "../lib/active-coupon";
import {
  filterDealsProducts,
  isDiscountedDealProduct,
  isUnder10kDealProduct,
} from "../lib/deals-filter";
import { filterAndSortSearchProducts } from "../lib/search-filter";
import {
  extractDeliveryHandshakeOtp,
  getStorefrontProductReviews,
  quoteStorefrontOrder,
  resolveStorefrontAppVersion,
  storefrontMutationHeaders,
  storefrontQueryHeaders,
  type OnlineOrderTracking,
} from "../lib/storefront-api";
import type { Product } from "../shared/storefront";

const mobileRoot = resolve(__dirname, "..");

function makeProduct(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    productId: Number.parseInt(id.replace(/\D/g, ""), 10) || 1,
    productUnitId: 101,
    variantId: 201,
    title: `منتج ${id}`,
    subtitle: "قرطاسية • قطعة",
    categoryId: "1",
    description: "وصف منتج تجريبي",
    icon: "menu-book",
    accent: "#E5EEF1",
    availability: "متوفر",
    price: "15000",
    salePrice: null,
    promotionName: null,
    inStock: true,
    isCustomizable: false,
    ...overrides,
  };
}

function createMemoryCouponStorage(initialValue: string | null = null): ActiveCouponStorage & {
  dump: () => Map<string, string>;
} {
  const map = new Map<string, string>();
  if (initialValue !== null) {
    map.set(ACTIVE_COUPON_STORAGE_KEY, initialValue);
  }
  return {
    async getItem(key: string) {
      return map.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      map.set(key, value);
    },
    async removeItem(key: string) {
      map.delete(key);
    },
    dump: () => map,
  };
}

describe("Wave 1 Mobile Storefront Quick Fixes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Search screen runaway catalog fetch removal & filter/sort accuracy", () => {
    it("removes the runaway useEffect calling loadMore() on active filters while keeping FlatList pagination", () => {
      const searchSrc = readFileSync(resolve(mobileRoot, "app/search.tsx"), "utf8");
      expect(searchSrc).not.toMatch(/useEffect\s*\(\s*\(\)\s*=>\s*\{[^}]*loadMore\s*\(/s);
      expect(searchSrc).toContain("onEndReached={loadMore}");
      expect(searchSrc).toContain("filterAndSortSearchProducts");
    });

    it("filters ALL / IN_STOCK / SALE and sorts without treating null prices as 0 IQD", () => {
      const items: Product[] = [
        makeProduct("p-in-stock", { price: "12000", inStock: true, availability: "متوفر" }),
        makeProduct("p-soon", { price: "8000", inStock: false, availability: "متوفر قريباً" }),
        makeProduct("p-sale-25", { price: "20000", salePrice: "15000", inStock: true, availability: "متوفر" }),
        makeProduct("p-sale-50", { price: "10000", salePrice: "5000", inStock: true, availability: "متوفر" }),
        makeProduct("p-promo", { price: "14000", salePrice: null, promotionName: "عرض خاص", inStock: true }),
        makeProduct("p-unpriced", { price: null, salePrice: null, inStock: true, availability: "متوفر" }),
      ];

      expect(
        filterAndSortSearchProducts(items, { availability: "ALL", sort: "RELEVANCE" }).map((p) => p.id),
      ).toEqual(["p-in-stock", "p-soon", "p-sale-25", "p-sale-50", "p-promo", "p-unpriced"]);

      expect(
        filterAndSortSearchProducts(items, { availability: "IN_STOCK", sort: "RELEVANCE" }).map((p) => p.id),
      ).toEqual(["p-in-stock", "p-sale-25", "p-sale-50", "p-promo", "p-unpriced"]);

      expect(
        filterAndSortSearchProducts(items, { availability: "SALE", sort: "DISCOUNT" }).map((p) => p.id),
      ).toEqual(["p-sale-50", "p-sale-25", "p-promo"]);

      const ascIds = filterAndSortSearchProducts(items, {
        availability: "ALL",
        sort: "PRICE_ASC",
      }).map((p) => p.id);
      expect(ascIds).toEqual([
        "p-sale-50",
        "p-soon",
        "p-in-stock",
        "p-promo",
        "p-sale-25",
        "p-unpriced",
      ]);

      const descIds = filterAndSortSearchProducts(items, {
        availability: "ALL",
        sort: "PRICE_DESC",
      }).map((p) => p.id);
      expect(descIds).toEqual([
        "p-sale-25",
        "p-promo",
        "p-in-stock",
        "p-soon",
        "p-sale-50",
        "p-unpriced",
      ]);
    });
  });

  describe("2. X-App-Version additive header on outgoing tRPC requests", () => {
    it("resolves version from expoConfig.version, nativeAppVersion, or safe 1.0.0 fallback", () => {
      expect(resolveStorefrontAppVersion({ expoConfig: { version: "2.3.1" }, nativeAppVersion: "2.0.0" })).toBe("2.3.1");
      expect(resolveStorefrontAppVersion({ expoConfig: { version: "  " }, nativeAppVersion: "1.4.2" })).toBe("1.4.2");
      expect(resolveStorefrontAppVersion({ expoConfig: null, nativeAppVersion: null })).toBe("1.0.0");
      expect(resolveStorefrontAppVersion(null)).toBe("1.0.0");
      expect(resolveStorefrontAppVersion({})).toBe("1.0.0");
    });

    it("includes X-App-Version in both query and mutation headers without breaking CSRF/native headers", () => {
      expect(storefrontQueryHeaders("1.2.0")).toEqual({
        Accept: "application/json",
        "X-App-Version": "1.2.0",
      });
      expect(storefrontQueryHeaders("   ")).toEqual({
        Accept: "application/json",
        "X-App-Version": "1.0.0",
      });
      expect(storefrontMutationHeaders("android", "1.2.0")).toEqual({
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-App-Version": "1.2.0",
        "x-alrueya-client": "android-native",
      });
      expect(storefrontMutationHeaders("web", "1.2.0")).toEqual({
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-App-Version": "1.2.0",
        "x-erp-csrf": "1",
      });
    });

    it("sends X-App-Version over fetch on both GET queries and POST mutations", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Response(
            JSON.stringify({ result: { data: { json: { summary: { count: 0, average: 0 }, items: [] } } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            result: {
              data: {
                json: {
                  couponCode: null,
                  couponProgramName: null,
                  couponDiscount: "0",
                  pricingBenefitType: "NONE",
                  pricingBenefitLabel: null,
                  pricingBenefitDiscount: "0",
                  couponSuperseded: false,
                  wholesaleProgress: [],
                  lines: [],
                  retailSubtotal: "10000",
                  subtotal: "10000",
                  deliveryFee: "5000",
                  total: "15000",
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      await getStorefrontProductReviews(987654);
      await quoteStorefrontOrder("baghdad", [{ productUnitId: 101, quantity: 1 }]);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const getHeaders = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
      const postHeaders = fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>;
      expect(getHeaders["X-App-Version"]).toBeTruthy();
      expect(postHeaders["X-App-Version"]).toBeTruthy();
      expect(postHeaders["x-alrueya-client"]).toBe("android-native");
    });
  });

  describe("3. Loyalty <-> Checkout coupon AsyncStorage synchronization", () => {
    it("round-trips normalized coupon codes through shared ACTIVE_COUPON_STORAGE_KEY", async () => {
      expect(ACTIVE_COUPON_STORAGE_KEY).toBe("alarabiya-active-coupon");
      expect(normalizeActiveCouponCode("  welcome 10 ")).toBe("WELCOME10");
      expect(normalizeActiveCouponCode("   ")).toBeNull();
      expect(normalizeActiveCouponCode(null)).toBeNull();

      const storage = createMemoryCouponStorage();
      expect(await loadActiveCouponCode(storage)).toBeNull();

      const saved = await saveActiveCouponCode(storage, "  vip 25 ");
      expect(saved).toBe("VIP25");
      expect(storage.dump().get("alarabiya-active-coupon")).toBe("VIP25");
      expect(await loadActiveCouponCode(storage)).toBe("VIP25");

      await clearActiveCouponCode(storage);
      expect(await loadActiveCouponCode(storage)).toBeNull();
    });

    it("reconciles stored Loyalty coupon with Checkout state across mount, switch, and unsaved typing", () => {
      // Fresh mount in Checkout after activating WELCOME10 in Loyalty
      expect(
        reconcileStoredCouponWithCheckout({
          savedCoupon: "WELCOME10",
          couponDraft: "",
          appliedCouponCode: null,
        }),
      ).toEqual({
        shouldApply: true,
        couponDraft: "WELCOME10",
        appliedCouponCode: "WELCOME10",
      });

      // Switching active coupon in Loyalty from OLD10 to NEW20 and returning to Checkout
      expect(
        reconcileStoredCouponWithCheckout({
          savedCoupon: "NEW20",
          couponDraft: "OLD10",
          appliedCouponCode: "OLD10",
        }),
      ).toEqual({
        shouldApply: true,
        couponDraft: "NEW20",
        appliedCouponCode: "NEW20",
      });

      // Preserves unsaved manual typing in Checkout
      expect(
        reconcileStoredCouponWithCheckout({
          savedCoupon: "OLD10",
          couponDraft: "MYTYPED",
          appliedCouponCode: null,
        }),
      ).toEqual({
        shouldApply: false,
        couponDraft: "MYTYPED",
        appliedCouponCode: null,
      });

      // Already synced -> no redundant reset
      expect(
        reconcileStoredCouponWithCheckout({
          savedCoupon: "WELCOME10",
          couponDraft: "WELCOME10",
          appliedCouponCode: "WELCOME10",
        }),
      ).toEqual({
        shouldApply: false,
        couponDraft: "WELCOME10",
        appliedCouponCode: "WELCOME10",
      });
    });

    it("wires both loyalty.tsx and checkout.tsx to the shared active-coupon module without keystroke snap-back", () => {
      const loyaltySrc = readFileSync(resolve(mobileRoot, "app/loyalty.tsx"), "utf8");
      const checkoutSrc = readFileSync(resolve(mobileRoot, "app/checkout.tsx"), "utf8");

      expect(loyaltySrc).toContain("@/lib/active-coupon");
      expect(loyaltySrc).toContain("ACTIVE_COUPON_STORAGE_KEY");
      expect(loyaltySrc).toContain("AsyncStorage.setItem");

      expect(checkoutSrc).toContain("@/lib/active-coupon");
      expect(checkoutSrc).toContain("loadActiveCouponCode");
      expect(checkoutSrc).toContain("saveActiveCouponCode");
      expect(checkoutSrc).toContain("clearActiveCouponCode");
      expect(checkoutSrc).toContain("shouldInvalidateCouponOnQuoteError");
      expect(checkoutSrc).toContain("couponStateRef");
      // Must NOT re-run useFocusEffect on every couponDraft/appliedCouponCode keystroke
      expect(checkoutSrc).not.toContain("}, [appliedCouponCode, couponDraft])");
    });

    it("preserves stored loyalty coupons on transient network/timeout/5xx/429/401 errors and clears only on definitive client rejections", () => {
      const offlineErr = Object.assign(new TypeError("Network request failed"));
      const fetchFailedErr = Object.assign(new TypeError("Failed to fetch"));
      const abortErr = Object.assign(new Error("Aborted"), { name: "AbortError" });
      const rateLimitErr = Object.assign(new Error("تعذر إرسال الطلب (429)"), { httpStatus: 429 });
      const badGatewayErr = Object.assign(new Error("تعذر إرسال الطلب (502)"), { httpStatus: 502 });
      const expiredSessionErr = Object.assign(new Error("تعذر إرسال الطلب (401)"), { httpStatus: 401 });

      expect(shouldInvalidateCouponOnQuoteError(offlineErr)).toBe(false);
      expect(shouldInvalidateCouponOnQuoteError(fetchFailedErr)).toBe(false);
      expect(shouldInvalidateCouponOnQuoteError(abortErr)).toBe(false);
      expect(shouldInvalidateCouponOnQuoteError(rateLimitErr)).toBe(false);
      expect(shouldInvalidateCouponOnQuoteError(badGatewayErr)).toBe(false);
      expect(shouldInvalidateCouponOnQuoteError(expiredSessionErr)).toBe(false);

      const badRequestErr = Object.assign(new Error("تعذر إرسال الطلب (400)"), { httpStatus: 400 });
      const forbiddenErr = Object.assign(new Error("تعذر إرسال الطلب (403)"), { httpStatus: 403 });
      const notFoundErr = Object.assign(new Error("تعذر إرسال الطلب (404)"), { httpStatus: 404 });
      const conflictErr = Object.assign(new Error("تعذر إرسال الطلب (409)"), { httpStatus: 409 });
      const unprocessableErr = Object.assign(new Error("تعذر إرسال الطلب (422)"), { httpStatus: 422 });
      const trpcCodeErr = Object.assign(new Error("استجابة الطلب غير صالحة"), { code: "BAD_REQUEST" });

      expect(shouldInvalidateCouponOnQuoteError(badRequestErr)).toBe(true);
      expect(shouldInvalidateCouponOnQuoteError(forbiddenErr)).toBe(true);
      expect(shouldInvalidateCouponOnQuoteError(notFoundErr)).toBe(true);
      expect(shouldInvalidateCouponOnQuoteError(conflictErr)).toBe(true);
      expect(shouldInvalidateCouponOnQuoteError(unprocessableErr)).toBe(true);
      expect(shouldInvalidateCouponOnQuoteError(trpcCodeErr)).toBe(true);
    });
  });

  describe("4. Order tracking deliveryHandshakeOtp additive display", () => {
    it("extracts trimmed non-empty deliveryHandshakeOtp safely and ignores null/blank/missing values", () => {
      const baseTracking: OnlineOrderTracking = {
        orderNumber: "ORD-5001",
        status: "SHIPPED",
        subtotal: "15000",
        pricingBenefitType: "NONE",
        pricingBenefitLabel: null,
        pricingBenefitDiscount: "0",
        deliveryFee: "5000",
        total: "20000",
        governorate: "بغداد",
        createdAt: "2026-10-25T12:00:00.000Z",
        items: [],
      };

      expect(extractDeliveryHandshakeOtp(baseTracking)).toBeNull();
      expect(extractDeliveryHandshakeOtp({ ...baseTracking, deliveryHandshakeOtp: null })).toBeNull();
      expect(extractDeliveryHandshakeOtp({ ...baseTracking, deliveryHandshakeOtp: "   " })).toBeNull();
      expect(extractDeliveryHandshakeOtp({ ...baseTracking, deliveryHandshakeOtp: " 482910 " })).toBe("482910");
      expect(extractDeliveryHandshakeOtp(null)).toBeNull();
    });

    it("renders Handshake PIN card in app/(tabs)/orders.tsx with narrow-screen RTL flex guards", () => {
      const ordersSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/orders.tsx"), "utf8");
      expect(ordersSrc).toContain("extractDeliveryHandshakeOtp");
      expect(ordersSrc).toContain("رمز تسليم الشحنة للمندوب");
      expect(ordersSrc).toContain("سلّم هذا الرمز للمندوب يداً بيد عند استلام شحنتك");
      expect(ordersSrc).toMatch(/handshakeTitle:\s*\{[^}]*flexShrink:\s*1/s);
      expect(ordersSrc).toMatch(/handshakeBadge:\s*\{[^}]*flexShrink:\s*0/s);
    });
  });

  describe("5. Deals screen accurate discount/promotional & sub-10k filtering", () => {
    it("identifies genuine discounted/promotional items and rejects corrupt/fake sale prices", () => {
      expect(isDiscountedDealProduct(makeProduct("real-sale", { price: "20000", salePrice: "15000" }))).toBe(true);
      expect(isDiscountedDealProduct(makeProduct("named-promo", { price: "20000", salePrice: null, promotionName: "عرض الخريف" }))).toBe(true);
      expect(
        isDiscountedDealProduct(
          makeProduct("variant-sale", {
            price: "20000",
            salePrice: null,
            storeUnits: [
              {
                productUnitId: 301,
                unitName: "علبة",
                conversionFactor: "12",
                price: "20000",
                salePrice: "16000",
                promotionName: null,
                inStock: true,
                stockLeft: 5,
              },
            ],
          }),
        ),
      ).toBe(true);

      expect(isDiscountedDealProduct(makeProduct("full-price", { price: "20000", salePrice: null }))).toBe(false);
      expect(isDiscountedDealProduct(makeProduct("zero-sale", { price: "20000", salePrice: "0" }))).toBe(false);
      expect(isDiscountedDealProduct(makeProduct("empty-sale", { price: "20000", salePrice: "" }))).toBe(false);
      expect(isDiscountedDealProduct(makeProduct("equal-sale", { price: "20000", salePrice: "20000" }))).toBe(false);
      expect(isDiscountedDealProduct(makeProduct("higher-sale", { price: "15000", salePrice: "18000" }))).toBe(false);
    });

    it("identifies strict sub-10,000 IQD items using effective display price", () => {
      expect(isUnder10kDealProduct(makeProduct("p-8500", { price: "8500", salePrice: null }))).toBe(true);
      expect(isUnder10kDealProduct(makeProduct("p-sale-7500", { price: "12000", salePrice: "7500" }))).toBe(true);
      expect(isUnder10kDealProduct(makeProduct("p-boundary-10k", { price: "10000", salePrice: null }))).toBe(false);
      expect(isUnder10kDealProduct(makeProduct("p-sale-10k", { price: "15000", salePrice: "10000" }))).toBe(false);
      expect(isUnder10kDealProduct(makeProduct("p-corrupt-zero", { price: "15000", salePrice: "0" }))).toBe(false);
      expect(isUnder10kDealProduct(makeProduct("p-null", { price: null, salePrice: null }))).toBe(false);
    });

    it("filters ALL / FLASH / UNDER_10K / DISCOUNTED accurately with zero fake fallbacks and exact fractional sort order", () => {
      const full25k = makeProduct("full-25k", { price: "25000", salePrice: null });
      const corruptZero = makeProduct("corrupt-zero", { price: "18000", salePrice: "0" });
      const budget6k = makeProduct("budget-6k", { price: "6000", salePrice: null });
      const sale20pct = makeProduct("sale-20pct", { price: "25000", salePrice: "20000" });
      const sale50pct = makeProduct("sale-50pct", { price: "16000", salePrice: "8000" });
      const namedPromo = makeProduct("named-promo", { price: "14000", salePrice: null, promotionName: "عرض خاص" });

      const catalog = [full25k, corruptZero, budget6k, sale20pct, sale50pct, namedPromo];

      expect(filterDealsProducts(catalog, "ALL").map((p) => p.id)).toEqual([
        "budget-6k",
        "sale-20pct",
        "sale-50pct",
        "named-promo",
      ]);
      expect(filterDealsProducts(catalog, "FLASH").map((p) => p.id)).toEqual([
        "sale-20pct",
        "sale-50pct",
        "named-promo",
      ]);
      expect(filterDealsProducts(catalog, "UNDER_10K").map((p) => p.id)).toEqual([
        "budget-6k",
        "sale-50pct",
      ]);
      expect(filterDealsProducts(catalog, "DISCOUNTED").map((p) => p.id)).toEqual([
        "sale-50pct",
        "sale-20pct",
        "named-promo",
      ]);

      // Exact fractional ratio tie-breaker: both round to 33%, but 33.44% beats 33.00%
      const discount33Low = makeProduct("sale-33-low", { price: "30000", salePrice: "20100" });
      const discount33High = makeProduct("sale-33-high", { price: "30000", salePrice: "19968" });
      expect(
        filterDealsProducts([discount33Low, discount33High], "DISCOUNTED").map((p) => p.id),
      ).toEqual(["sale-33-high", "sale-33-low"]);
      expect(
        filterAndSortSearchProducts([discount33Low, discount33High], {
          availability: "SALE",
          sort: "DISCOUNT",
        }).map((p) => p.id),
      ).toEqual(["sale-33-high", "sale-33-low"]);

      // When catalog has NO deals at all, every filter returns [] instead of faking deals!
      const noDealsCatalog = [full25k, corruptZero];
      expect(filterDealsProducts(noDealsCatalog, "ALL")).toEqual([]);
      expect(filterDealsProducts(noDealsCatalog, "FLASH")).toEqual([]);
      expect(filterDealsProducts(noDealsCatalog, "UNDER_10K")).toEqual([]);
      expect(filterDealsProducts(noDealsCatalog, "DISCOUNTED")).toEqual([]);
    });

    it("wires app/(tabs)/deals.tsx to filterDealsProducts without fake slice(0, 8) fallback", () => {
      const dealsSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/deals.tsx"), "utf8");
      expect(dealsSrc).toContain("filterDealsProducts");
      expect(dealsSrc).not.toContain("products.slice(0, 8)");
    });
  });
});

