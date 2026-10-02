import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { addProductToCart } from "../lib/cart-context";
import { formatIqd, formatLatinNumber } from "../lib/storefront-api";
import type { CartLine, Product } from "../shared/storefront";
import {
  CART_BOUNCE_SPRING_CONFIG,
  CLAYMORPHIC_SPRING_CONFIG,
  IRAQI_GOVERNORATES,
  calculateLoyaltyProgress,
  formatDealsCountdown,
  isSub10kDeal,
  resolveDeliveryLocation,
} from "./store-modernization-e2e.test";

const mobileRoot = resolve(__dirname, "..");
const FORBIDDEN_EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}]/u;

function makeMockProduct(
  id: string,
  price: string,
  salePrice?: string,
  isCustomizable = false,
): Product {
  const numericId = Array.from(id).reduce((sum, c) => sum * 31 + c.charCodeAt(0), 19);
  return {
    id,
    productId: numericId,
    productUnitId: numericId + 5,
    variantId: numericId + 10,
    title: `منتج تجريبي ${id}`,
    subtitle: "قطعة",
    categoryId: "stationery",
    description: "منتج تجريبي لاختبارات المتجر الفاخر",
    icon: "menu-book",
    accent: "#E7F1EC",
    availability: "متوفر",
    price,
    salePrice: salePrice ?? null,
    inStock: true,
    isCustomizable,
  };
}

describe("Milestone 2 & Milestone 3: Luxury Hybrid Home Experience & Flash Deals Engine", () => {
  // --------------------------------------------------------------------------
  // 1. Smart Header & Delivery Location Tests
  // --------------------------------------------------------------------------
  describe("1. Smart Header Delivery Location & Search Bar", () => {
    it("resolves default delivery location to Baghdad - Karrada", () => {
      const location = resolveDeliveryLocation();
      expect(location.governorate).toBe("بغداد");
      expect(location.area).toBe("الكرادة");
      expect(location.formatted).toBe("التوصيل إلى: بغداد - الكرادة");
    });

    it("resolves supported Iraqi governorates and custom areas accurately", () => {
      expect(IRAQI_GOVERNORATES).toContain("البصرة");
      expect(IRAQI_GOVERNORATES).toContain("أربيل");
      expect(IRAQI_GOVERNORATES).toContain("النجف");
      expect(IRAQI_GOVERNORATES).toContain("كربلاء");

      const erbil = resolveDeliveryLocation("أربيل", "عينكاوة");
      expect(erbil.governorate).toBe("أربيل");
      expect(erbil.area).toBe("عينكاوة");
      expect(erbil.formatted).toBe("التوصيل إلى: أربيل - عينكاوة");
    });

    it("falls back safely to Baghdad when an unsupported governorate is given", () => {
      const foreign = resolveDeliveryLocation("باريس", "الشانزليزيه");
      expect(foreign.governorate).toBe("بغداد");
    });

    it("verifies DeliveryLocationModal component file exists and contains governorate sheet logic", () => {
      const modalPath = resolve(mobileRoot, "components/delivery-location-modal.tsx");
      expect(existsSync(modalPath)).toBe(true);
      const modalSource = readFileSync(modalPath, "utf8");
      expect(modalSource).toContain("export function DeliveryLocationModal");
      expect(modalSource).toContain("IRAQI_GOVERNORATES");
      expect(modalSource).toContain("resolveDeliveryLocation");
      expect(modalSource).toContain("اختر موقع التوصيل");
    });

    it("verifies index.tsx contains the barcode scanner trigger, search capsule, and bounce animation", () => {
      const indexSource = readFileSync(resolve(mobileRoot, "app/(tabs)/index.tsx"), "utf8");
      expect(indexSource).toContain('name="qr-code-scanner"');
      expect(indexSource).toContain('accessibilityLabel="مسح الباركود"');
      expect(indexSource).toContain("handleBarcodeScan");
      expect(indexSource).toContain("triggerCartBounce");
      expect(indexSource).toContain("cartScaleAnim");
      expect(indexSource).toContain("CART_BOUNCE_SPRING_CONFIG");
    });

    it("verifies cart bounce animation matches spring config damping 12, stiffness 200, peak 1.25", () => {
      expect(CART_BOUNCE_SPRING_CONFIG.damping).toBe(12);
      expect(CART_BOUNCE_SPRING_CONFIG.stiffness).toBe(200);
      expect(CART_BOUNCE_SPRING_CONFIG.idleScale).toBe(1.0);
      expect(CART_BOUNCE_SPRING_CONFIG.peakScale).toBe(1.25);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Welcome Hero Card with 3D Mascot
  // --------------------------------------------------------------------------
  describe("2. Welcome Hero Card with 3D Cute Mascot", () => {
    it("contains authoritative greeting 'أهلاً بك في الرؤية العربية!' and emerald/gold accents", () => {
      const heroPath = resolve(mobileRoot, "components/hero-mascot-card.tsx");
      expect(existsSync(heroPath)).toBe(true);

      const heroSource = readFileSync(heroPath, "utf8");
      expect(heroSource).toContain("أهلاً بك في الرؤية العربية!");
      expect(heroSource).toContain("وجهتك الأولى للقرطاسية الفاخرة");
      expect(heroSource).toContain("CuteMascotSvg");
      expect(heroSource).toContain("#064E3B"); // Emerald
      expect(heroSource).toContain("#F59E0B"); // Gold
    });
  });

  // --------------------------------------------------------------------------
  // 3. 3D Claymorphic Categories Grid
  // --------------------------------------------------------------------------
  describe("3. 3D Claymorphic Categories Grid", () => {
    it("strictly satisfies spring physics scale 0.92, damping 15, stiffness 300", () => {
      expect(CLAYMORPHIC_SPRING_CONFIG.scale).toBe(0.92);
      expect(CLAYMORPHIC_SPRING_CONFIG.damping).toBe(15);
      expect(CLAYMORPHIC_SPRING_CONFIG.stiffness).toBe(300);
    });

    it("verifies ClaymorphicCategories component file exists and contains tactile pastel styling", () => {
      const clayPath = resolve(mobileRoot, "components/claymorphic-categories.tsx");
      expect(existsSync(clayPath)).toBe(true);
      const claySource = readFileSync(clayPath, "utf8");
      expect(claySource).toContain("export function ClaymorphicCategories");
      expect(claySource).toContain("CLAYMORPHIC_SPRING_CONFIG");
      expect(claySource).toContain("CLAY_PALETTES");
      expect(claySource).toContain("embossedHighlight");
      expect(claySource).toContain("Haptics.impactAsync");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Flash Deals Engine, Live Countdown, and Circular Quick-Add
  // --------------------------------------------------------------------------
  describe("4. Flash Deals Engine & Quick Add Functionality", () => {
    it("formats deal countdown milliseconds to HH:MM:SS with zero padding", () => {
      // 2 hours, 15 minutes, 3 seconds = 8103000 ms
      const active = formatDealsCountdown(8103000);
      expect(active.formatted).toBe("02:15:03");
      expect(active.hours).toBe(2);
      expect(active.minutes).toBe(15);
      expect(active.seconds).toBe(3);
      expect(active.isExpired).toBe(false);

      // Expired case
      const expired = formatDealsCountdown(0);
      expect(expired.formatted).toBe("00:00:00");
      expect(expired.isExpired).toBe(true);
    });

    it("filters products under 10,000 IQD accurately", () => {
      const item8k = makeMockProduct("item-8k", "8000");
      const itemSale6k = makeMockProduct("item-sale-6k", "12000", "6500");
      const item10k = makeMockProduct("item-10k", "10000");
      const item15k = makeMockProduct("item-15k", "15000");

      expect(isSub10kDeal(item8k)).toBe(true);
      expect(isSub10kDeal(itemSale6k)).toBe(true);
      expect(isSub10kDeal(item10k)).toBe(false);
      expect(isSub10kDeal(item15k)).toBe(false);
    });

    it("circular quick-add button adds non-customizable product directly to cart", () => {
      const normalProduct = makeMockProduct("notebook-1", "7000");
      let cartLines: CartLine[] = [];

      cartLines = addProductToCart(cartLines, normalProduct, 1);
      expect(cartLines).toHaveLength(1);
      expect(cartLines[0].product.id).toBe("notebook-1");
      expect(cartLines[0].quantity).toBe(1);

      // Repeated click increments quantity
      cartLines = addProductToCart(cartLines, normalProduct, 1);
      expect(cartLines[0].quantity).toBe(2);
    });

    it("verifies FlashDealsRail component file exists with countdown timer and quick-add button", () => {
      const dealsPath = resolve(mobileRoot, "components/flash-deals-rail.tsx");
      expect(existsSync(dealsPath)).toBe(true);
      const dealsSource = readFileSync(dealsPath, "utf8");
      expect(dealsSource).toContain("export function FlashDealsRail");
      expect(dealsSource).toContain("formatDealsCountdown");
      expect(dealsSource).toContain("عروض تفليش ساخنة اليوم");
      expect(dealsSource).toContain("quickAddCircle");
      expect(dealsSource).toContain("Haptics.impactAsync");
    });

    it("verifies ProductCard has circular quick-add button and customizable protection", () => {
      const cardSource = readFileSync(resolve(mobileRoot, "components/product-card.tsx"), "utf8");
      expect(cardSource).toContain("handleActionButtonPress");
      expect(cardSource).toContain("addProduct(product, 1)");
      expect(cardSource).toContain("Haptics.impactAsync");
      expect(cardSource).toContain("buyButtonCompact");
      expect(cardSource).toContain('name="add"');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Interactive Loyalty Points Progress Card
  // --------------------------------------------------------------------------
  describe("5. Interactive Loyalty Points Progress Card", () => {
    it("calculates 250 / 500 progress metrics correctly", () => {
      const prog = calculateLoyaltyProgress(250, 500);
      expect(prog.currentPoints).toBe(250);
      expect(prog.threshold).toBe(500);
      expect(prog.progressRatio).toBe(0.5);
      expect(prog.percentageText).toBe("50%");
      expect(prog.pointsRemaining).toBe(250);
      expect(prog.isGoalReached).toBe(false);
    });

    it("reaches goal when points equal or exceed threshold", () => {
      const reached = calculateLoyaltyProgress(500, 500);
      expect(reached.isGoalReached).toBe(true);
      expect(reached.pointsRemaining).toBe(0);
      expect(reached.progressRatio).toBe(1.0);

      const overflow = calculateLoyaltyProgress(800, 500);
      expect(overflow.isGoalReached).toBe(true);
      expect(overflow.progressRatio).toBe(1.0);
    });

    it("verifies loyalty progress card displays canonical text and 3D coin visual", () => {
      const cardPath = resolve(mobileRoot, "components/loyalty-progress-card.tsx");
      expect(existsSync(cardPath)).toBe(true);

      const cardSource = readFileSync(cardPath, "utf8");
      expect(cardSource).toContain("نقطة للخصم القادم");
      expect(cardSource).toContain("GoldCoin3DSvg");
      expect(cardSource).toContain("progressTrack");
      expect(cardSource).toContain("progressFill");
    });
  });

  // --------------------------------------------------------------------------
  // 6. Strict Zero Emoji Compliance Across All Worker 2 Deliverables
  // --------------------------------------------------------------------------
  describe("6. Strict Zero Emoji Guard Across All New Components", () => {
    const filesToCheck = [
      "components/delivery-location-modal.tsx",
      "components/hero-mascot-card.tsx",
      "components/claymorphic-categories.tsx",
      "components/flash-deals-rail.tsx",
      "components/loyalty-progress-card.tsx",
      "components/product-card.tsx",
      "app/(tabs)/index.tsx",
    ];

    for (const relPath of filesToCheck) {
      it(`confirms zero emojis in ${relPath}`, () => {
        const fullPath = resolve(mobileRoot, relPath);
        expect(existsSync(fullPath)).toBe(true);
        const source = readFileSync(fullPath, "utf8");
        expect(FORBIDDEN_EMOJI_REGEX.test(source)).toBe(false);
      });
    }
  });

  // --------------------------------------------------------------------------
  // 7. Preservation of Existing UI String Contracts in index.tsx
  // --------------------------------------------------------------------------
  describe("7. UI String Contract Preservation in index.tsx", () => {
    it("verifies all authoritative strings are present in index.tsx", () => {
      const indexSource = readFileSync(resolve(mobileRoot, "app/(tabs)/index.tsx"), "utf8");

      expect(indexSource).toContain("المكتبة العربية");
      expect(indexSource).toContain("لكل احتياج، من طلب واحد");
      expect(indexSource).toContain("تصفح حسب القسم");
      expect(indexSource).toContain("عروض اليوم");
      expect(indexSource).toContain("عروض اليوم الساخنة");
      expect(indexSource).toContain("باقات الإهداء والطباعة المخصصة");
      expect(indexSource).toContain("أهلاً بك في الرؤية العربية!");
      expect(indexSource).toContain("تسوّق حسب المناسبة");
      expect(indexSource).toContain("منتجات يختارها العملاء");
      expect(indexSource).toContain("تسوّق حسب احتياجك");
      expect(indexSource).toContain("المنتجات المختارة لك");
      expect(indexSource).toContain("كل المنتجات");
      expect(indexSource).toContain("صفقات أقل من 10,000 د.ع");
    });
  });
});
