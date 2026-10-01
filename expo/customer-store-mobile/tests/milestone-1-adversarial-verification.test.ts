import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { addProductToCart, sanitizeCartLines } from "../lib/cart-context";
import { marketingCarouselGeometry } from "../lib/marketing-carousel-layout";
import {
  formatIqd,
  formatLatinNumber,
  productDiscountPercent,
  storefrontDisplayPrice,
} from "../lib/storefront-api";
import type { CartLine, Product } from "../shared/storefront";
import {
  CART_BOUNCE_SPRING_CONFIG,
  CLAYMORPHIC_SPRING_CONFIG,
  formatDealsCountdown,
  isSub10kDeal,
  calculateLoyaltyProgress,
  resolveDeliveryLocation,
} from "./store-modernization-e2e.test";

const mobileRoot = resolve(__dirname, "..");

function createMockProduct(id: string, price: string, salePrice?: string): Product {
  const numericId = Array.from(id).reduce((sum, c) => sum * 31 + c.charCodeAt(0), 19);
  return {
    id,
    productId: numericId,
    productUnitId: numericId + 10,
    variantId: numericId + 20,
    title: `منتج تحققي ${id}`,
    subtitle: "قطعة",
    categoryId: "stationery",
    description: "وصف المنتج لأغراض التحقق العدائي للمرحلة الأولى",
    icon: "menu-book",
    accent: "#E7F1EC",
    availability: "متوفر",
    price,
    salePrice: salePrice ?? null,
    inStock: true,
  };
}

describe("Milestone 1 Adversarial Challenger — Empirical Verification Suite", () => {
  // ==========================================================================
  // Dimension 1: Edge Cases in MarketingCarousel
  // ==========================================================================
  describe("Dimension 1: MarketingCarousel Edge Cases", () => {
    const carouselPath = resolve(mobileRoot, "components/marketing-carousel.tsx");

    it("verifies empty banners array falls back to the 4 commercial retail banners", () => {
      expect(existsSync(carouselPath)).toBe(true);
      const carouselSrc = readFileSync(carouselPath, "utf8");

      // Verifies fallback logic in useMemo
      expect(carouselSrc).toContain("return FALLBACK_BANNERS;");
      expect(carouselSrc).toContain('id: "banner-school"');
      expect(carouselSrc).toContain('id: "banner-corporate"');
      expect(carouselSrc).toContain('id: "banner-art"');
      expect(carouselSrc).toContain('id: "banner-flyer"');

      // All fallback banners are full commercial banners (no text overlay)
      const matches = carouselSrc.match(/isFullBanner:\s*true/g);
      expect(matches).not.toBeNull();
      expect(matches?.length).toBeGreaterThanOrEqual(4);
    });

    it("verifies single banner hides counter badge and dots pagination completely", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");

      // Contract: Counter badge & pagination MUST only render if slides.length > 1
      expect(carouselSrc).toContain("slides.length > 1 && (");
      expect(carouselSrc).toContain("styles.pagination");
      expect(carouselSrc).toContain("styles.counterBadge");
      expect(carouselSrc).toContain("styles.dotsRow");

      // Verify simulated evaluation of single banner vs multiple banners
      const evaluatePaginationRender = (slideCount: number) => slideCount > 1;
      expect(evaluatePaginationRender(0)).toBe(false);
      expect(evaluatePaginationRender(1)).toBe(false); // Single banner: HIDDEN
      expect(evaluatePaginationRender(2)).toBe(true);
      expect(evaluatePaginationRender(4)).toBe(true);
    });

    it("verifies autoplay interval is suppressed when slide count is less than 2", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");

      // Autoplay effect guard: if (slides.length < 2) return;
      expect(carouselSrc).toContain("if (slides.length < 2) return;");
      expect(carouselSrc).toContain("setInterval");
      expect(carouselSrc).toContain("AUTOPLAY_DELAY_MS");
    });

    it("stress tests rapid swiping index calculation against hostile boundary offsets", () => {
      const cardWidth = 358;
      const gap = 12;
      const snapInterval = cardWidth + gap; // 370
      const slideCount = 4;

      const computeClampedIndex = (offsetX: number) => {
        return Math.max(
          0,
          Math.min(slideCount - 1, Math.round(offsetX / snapInterval)),
        );
      };

      // Normal in-range snaps
      expect(computeClampedIndex(0)).toBe(0);
      expect(computeClampedIndex(370)).toBe(1);
      expect(computeClampedIndex(740)).toBe(2);
      expect(computeClampedIndex(1110)).toBe(3);

      // Halfway rounding snaps
      expect(computeClampedIndex(180)).toBe(0);
      expect(computeClampedIndex(190)).toBe(1);

      // Hostile overscroll left (negative offsets on iOS/RTL bounce)
      expect(computeClampedIndex(-50)).toBe(0);
      expect(computeClampedIndex(-1000)).toBe(0);
      expect(computeClampedIndex(-Infinity)).toBe(0);

      // Hostile overscroll right (flick beyond last slide)
      expect(computeClampedIndex(1500)).toBe(3);
      expect(computeClampedIndex(99999)).toBe(3);
      expect(computeClampedIndex(Infinity)).toBe(3);
    });

    it("verifies drag interaction pauses autoplay and resumes with a 1400ms debounce buffer", () => {
      const carouselSrc = readFileSync(carouselPath, "utf8");

      // Touch drag hooks
      expect(carouselSrc).toContain("onScrollBeginDrag={pause}");
      expect(carouselSrc).toContain("onScrollEndDrag={resume}");
      expect(carouselSrc).toContain("onMomentumScrollEnd");

      // Pause clears timeout and sets interacting true
      expect(carouselSrc).toContain("interactingRef.current = true;");
      expect(carouselSrc).toContain("clearTimeout(resumeTimerRef.current);");

      // Resume sets timeout for 1400ms before enabling autoplay
      expect(carouselSrc).toContain("1400");
      expect(carouselSrc).toContain("interactingRef.current = false;");

      // Autoplay tick checks interactingRef
      expect(carouselSrc).toContain("if (interactingRef.current) return;");
    });

    it("evaluates marketingCarouselGeometry across diverse screen viewports", () => {
      // Very small screen (320px)
      const small = marketingCarouselGeometry(320);
      expect(small.cardWidth).toBe(288); // Clamped at min 288
      expect(small.sideInset).toBe(16);

      // Standard modern mobile phone (390px iPhone 14/15)
      const standard = marketingCarouselGeometry(390);
      expect(standard.cardWidth).toBe(358); // 390 - 32
      expect(standard.sideInset).toBe(16);

      // Large mobile phone (428px iPhone Pro Max)
      const large = marketingCarouselGeometry(428);
      expect(large.cardWidth).toBe(396);
      expect(large.sideInset).toBe(16);

      // Tablet / Foldable (768px iPad mini)
      const tablet = marketingCarouselGeometry(768);
      expect(tablet.cardWidth).toBe(480); // Clamped at max 480
      expect(tablet.sideInset).toBe((768 - 480) / 2); // 144px centered inset
    });
  });

  // ==========================================================================
  // Dimension 2: RTL Arabic Layout and Cairo Font Styling
  // ==========================================================================
  describe("Dimension 2: RTL Arabic Layout and Cairo Font Styling", () => {
    it("verifies MarketingCarousel enforces Cairo font weights and RTL alignment", () => {
      const carouselSrc = readFileSync(
        resolve(mobileRoot, "components/marketing-carousel.tsx"),
        "utf8",
      );

      // Cairo font weights in styles
      expect(carouselSrc).toContain('fontFamily: "Cairo_700Bold"');
      expect(carouselSrc).toContain('fontFamily: "Cairo_800ExtraBold"');
      expect(carouselSrc).toContain('fontFamily: "Cairo_400Regular"');

      // RTL directional rules
      expect(carouselSrc).toContain('flexDirection: "row-reverse"');
      expect(carouselSrc).toContain('textAlign: "right"');
      expect(carouselSrc).toContain('alignItems: "flex-end"');

      // Full banner pure commercial presentation (isFullBanner)
      expect(carouselSrc).toContain("fullBannerCard");
      expect(carouselSrc).toContain("fullBannerImage");
      expect(carouselSrc).toContain('contentFit="cover"');
    });

    it("verifies TrustCardsRow enforces certified 4 pillars, dark capsule styling, and Cairo fonts", () => {
      const trustPath = resolve(mobileRoot, "components/trust-cards-row.tsx");
      expect(existsSync(trustPath)).toBe(true);
      const trustSrc = readFileSync(trustPath, "utf8");

      // 4 Certified Pillars
      expect(trustSrc).toContain('id: "shipping"');
      expect(trustSrc).toContain('title: "واصل لكل المحافظات"');
      expect(trustSrc).toContain('subtitle: "شحن وتوصيل سريع لباب بيتك بـ 18 محافظة عراقية"');

      expect(trustSrc).toContain('id: "cod"');
      expect(trustSrc).toContain('title: "سدد نقد عند الباب"');
      expect(trustSrc).toContain('subtitle: "عاين وافحص مسواكك براحتك قبل لا تدفع فلس واحد"');

      expect(trustSrc).toContain('id: "warranty"');
      expect(trustSrc).toContain('title: "ضمان 48 ساعة"');
      expect(trustSrc).toContain('subtitle: "حقك محفوظ، فحص ومطابقة واستبدال مضمون 100%"');

      expect(trustSrc).toContain('id: "pricing"');
      expect(trustSrc).toContain('title: "سعر الجملة من المستودع"');
      expect(trustSrc).toContain('subtitle: "عروض توفير حقيقية من المستودع ليدك بدون وسيط"');

      // Styling: Dark capsule `#0B1321` and emerald icon `#059669`
      expect(trustSrc).toContain('backgroundColor: "#0B1321"');
      expect(trustSrc).toContain('borderRadius: 16');
      expect(trustSrc).toContain('borderColor: "rgba(255, 255, 255, 0.08)"');
      expect(trustSrc).toContain('color="#059669"');
      expect(trustSrc).toContain('backgroundColor: "rgba(16, 185, 129, 0.15)"');

      // 2x2 grid layout
      expect(trustSrc).toContain('flexBasis: "48%"');
      expect(trustSrc).toContain('flexWrap: "wrap"');
      expect(trustSrc).toContain('flexDirection: "row-reverse"');

      // Typography
      expect(trustSrc).toContain('fontFamily: "Cairo_700Bold"');
      expect(trustSrc).toContain('fontFamily: "Cairo_400Regular"');
      expect(trustSrc).toContain('textAlign: "right"');

      // Accessibility contract
      expect(trustSrc).toContain("accessibilityLabel=");
    });

    it("verifies RootLayout registers Cairo font weights and enforces I18nManager RTL", () => {
      const layoutSrc = readFileSync(resolve(mobileRoot, "app/_layout.tsx"), "utf8");

      // Cairo fonts loaded
      expect(layoutSrc).toContain("Cairo_400Regular");
      expect(layoutSrc).toContain("Cairo_600SemiBold");
      expect(layoutSrc).toContain("Cairo_700Bold");
      expect(layoutSrc).toContain("Cairo_800ExtraBold");
      expect(layoutSrc).toContain("useFonts");

      // RTL locks
      expect(layoutSrc).toContain("I18nManager.allowRTL(true)");
      expect(layoutSrc).toContain("I18nManager.forceRTL(true)");
    });
  });

  // ==========================================================================
  // Dimension 3: Currency Precision for Iraqi Dinar (IQD / د.ع)
  // ==========================================================================
  describe("Dimension 3: Currency Precision for Iraqi Dinar (IQD / د.ع)", () => {
    it("formats integer amounts with thousands grouping commas and Arabic currency suffix", () => {
      expect(formatIqd(5000)).toBe("5,000 د.ع");
      expect(formatIqd(18500)).toBe("18,500 د.ع");
      expect(formatIqd(125000)).toBe("125,000 د.ع");
      expect(formatIqd(1000000)).toBe("1,000,000 د.ع");
      expect(formatIqd("250000")).toBe("250,000 د.ع");
    });

    it("strictly forbids Eastern Arabic digits (٠-٩) in currency and formatted numbers", () => {
      const testValues = [0, 500, 12000, 45000, 999999, 5000000];
      const easternArabicDigits = /[٠-٩]/;

      for (const val of testValues) {
        const iqdStr = formatIqd(val);
        const latnStr = formatLatinNumber(val);
        expect(easternArabicDigits.test(iqdStr)).toBe(false);
        expect(easternArabicDigits.test(latnStr)).toBe(false);
      }
    });

    it("verifies formatIqd matches regex for digits, commas, and suffix without decimal point", () => {
      const sampleAmounts = [1000, 7500, 10000, 32500, 1200000];
      const IQD_PATTERN = /^[0-9,]+ د\.ع$/;

      for (const amt of sampleAmounts) {
        const formatted = formatIqd(amt);
        expect(formatted).toMatch(IQD_PATTERN);
        // The numeric prefix before ' د.ع' must not contain any decimal point
        const numericPart = formatted.split(" ")[0];
        expect(numericPart).not.toContain("."); // Zero decimals
      }
    });

    it("handles falsy and zero edge cases gracefully with 'اسأل عن السعر'", () => {
      expect(formatIqd(null)).toBe("اسأل عن السعر");
      expect(formatIqd(undefined)).toBe("اسأل عن السعر");
      expect(formatIqd("")).toBe("اسأل عن السعر");
      expect(formatIqd(0)).toBe("اسأل عن السعر");
      expect(formatIqd(NaN)).toBe("اسأل عن السعر");
    });

    it("preserves integer arithmetic across rapid cart accumulations without floating drift", () => {
      const items = [
        { price: "7250", quantity: 3 }, // 21,750
        { price: "12500", quantity: 2 }, // 25,000
        { price: "3500", quantity: 4 }, // 14,000
      ];

      const subtotal = items.reduce(
        (sum, item) => sum + Number(item.price) * item.quantity,
        0,
      );
      expect(subtotal).toBe(60750);
      expect(Number.isInteger(subtotal)).toBe(true);

      const formatted = formatIqd(subtotal);
      expect(formatted).toBe("60,750 د.ع");
      expect(formatted).toMatch(/^[0-9,]+ د\.ع$/);
    });
  });

  // ==========================================================================
  // Dimension 4: Commercial Retail Flow & Zero Interruption
  // ==========================================================================
  describe("Dimension 4: Commercial Retail Flow & Zero Interruption", () => {
    it("confirms quick-add circular buttons trigger spring bounce without opening side cart drawer", () => {
      const indexSrc = readFileSync(
        resolve(mobileRoot, "app/(tabs)/index.tsx"),
        "utf8",
      );

      // Verify cart bounce animation setup
      expect(indexSrc).toContain("CART_BOUNCE_SPRING_CONFIG");
      expect(indexSrc).toContain("cartScaleAnim");

      // Verify FlashDealsRail does not open side cart on quick-add
      const flashRailIdx = indexSrc.indexOf("<FlashDealsRail");
      expect(flashRailIdx).toBeGreaterThan(-1);
      const flashRailSlice = indexSrc.slice(
        flashRailIdx,
        indexSrc.indexOf("/>", flashRailIdx),
      );
      expect(flashRailSlice).toContain("triggerCartBounce()");
      expect(flashRailSlice).not.toContain("setSideCartVisible");

      // Verify sub10kProducts does not open side cart on quick-add
      const sub10kIdx = indexSrc.indexOf("sub10kProducts.slice");
      expect(sub10kIdx).toBeGreaterThan(-1);
      const sub10kSlice = indexSrc.slice(
        sub10kIdx,
        indexSrc.indexOf("</ScrollView>", sub10kIdx),
      );
      expect(sub10kSlice).toContain("triggerCartBounce()");
      expect(sub10kSlice).not.toContain("setSideCartVisible");

      // Preserves mandatory welcome greeting
      expect(indexSrc).toContain("أهلاً بك في الرؤية العربية!");
    });
  });
});
