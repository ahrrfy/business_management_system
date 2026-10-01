import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { addProductToCart, sanitizeCartLines } from "../lib/cart-context";
import {
  catalogDisplayState,
  formatIqd,
  formatLatinNumber,
  productDiscountPercent,
} from "../lib/storefront-api";
import type { CartLine, Product } from "../shared/storefront";
import {
  CART_BOUNCE_SPRING_CONFIG,
  CLAYMORPHIC_SPRING_CONFIG,
  formatDealsCountdown,
  isSub10kDeal,
  calculateLoyaltyProgress,
  LOYALTY_TIERS,
} from "./store-modernization-e2e.test";

const mobileRoot = resolve(__dirname, "..");

let mockProductCounter = 1000;

function createMockProduct(id: string, overrides: Partial<Product> = {}): Product {
  const numericId = ++mockProductCounter;
  return {
    id,
    productId: numericId,
    productUnitId: numericId + 10,
    variantId: numericId + 20,
    title: `منتج تجريبي ${id}`,
    subtitle: "قطعة",
    categoryId: "stationery",
    description: "وصف منتج تجريبي للأغراض الهجومية",
    icon: "menu-book",
    accent: "#E7F1EC",
    availability: "متوفر",
    price: "5000",
    inStock: true,
    ...overrides,
  };
}

describe("Final Empirical Challenger & Adversarial Stress Harness", () => {
  // ==========================================================================
  // 1. Rapid / Concurrent Quick-Add Taps & Cart Limits
  // ==========================================================================
  describe("1. Rapid / Concurrent Quick-Add Taps & Cart Capacity Stress", () => {
    it("handles 1,500 rapid sequential taps on a single product and clamps at MAX_QUANTITY_PER_LINE (999)", () => {
      const product = createMockProduct("p-rapid-single");
      let cart: CartLine[] = [];

      for (let i = 0; i < 1500; i++) {
        cart = addProductToCart(cart, product, 1);
      }

      expect(cart).toHaveLength(1);
      expect(cart[0].quantity).toBe(999);
      expect(cart[0].product.id).toBe("p-rapid-single");
    });

    it("handles batch additions exceeding quantity per line and clamps accurately", () => {
      const product = createMockProduct("p-bulk-tap");
      let cart = addProductToCart([], product, 500);
      expect(cart[0].quantity).toBe(500);

      cart = addProductToCart(cart, product, 600);
      expect(cart[0].quantity).toBe(999); // Clamped at 999
    });

    it("strictly clamps at MAX_CART_LINES (30) when adding 45 distinct products", () => {
      let cart: CartLine[] = [];

      for (let i = 1; i <= 45; i++) {
        const product = createMockProduct(`p-distinct-${i}`);
        cart = addProductToCart(cart, product, 1);
      }

      expect(cart).toHaveLength(30);
      expect(cart[0].product.id).toBe("p-distinct-1");
      expect(cart[29].product.id).toBe("p-distinct-30");
      expect(cart.some((l) => l.product.id === "p-distinct-31")).toBe(false);
    });

    it("respects global MAX_TOTAL_QUANTITY (10,000) when sanitizing stored cart lines", () => {
      const hugeBatch: any[] = [];
      for (let i = 1; i <= 35; i++) {
        hugeBatch.push({
          lineId: `line-${i}`,
          quantity: 999,
          maxQuantity: 999,
          product: createMockProduct(`prod-${i}`),
          selectionDetails: { productUnitId: i + 100 },
        });
      }

      const sanitized = sanitizeCartLines(hugeBatch);
      expect(sanitized.length).toBeLessThanOrEqual(30);
      const totalQty = sanitized.reduce((sum, l) => sum + l.quantity, 0);
      expect(totalQty).toBeLessThanOrEqual(10000);
    });

    it("rejects quick-add taps on products with ordering issues without corrupting cart state", () => {
      let cart: CartLine[] = [];
      const validProduct = createMockProduct("p-valid");
      cart = addProductToCart(cart, validProduct, 2);
      expect(cart).toHaveLength(1);

      // Try adding customizable product (ordering blocked by productOnlineOrderingIssue guard)
      const customizable = createMockProduct("p-custom", { isCustomizable: true });
      cart = addProductToCart(cart, customizable, 1);
      expect(cart).toHaveLength(1);

      // Try adding product with invalid productUnitId (unitId <= 0 fails normalizeCartLine)
      const invalidUnit = createMockProduct("p-bad-unit", { productUnitId: 0 });
      cart = addProductToCart(cart, invalidUnit, 1);
      expect(cart).toHaveLength(1);

      expect(cart[0].quantity).toBe(2);
      expect(cart[0].product.id).toBe("p-valid");
    });

    it("verifies state immutability: addProductToCart always produces fresh references", () => {
      const product = createMockProduct("p-immutable");
      const initialCart: CartLine[] = [];
      const cartAfter1 = addProductToCart(initialCart, product, 1);
      const cartAfter2 = addProductToCart(cartAfter1, product, 1);

      expect(cartAfter1).not.toBe(initialCart);
      expect(cartAfter2).not.toBe(cartAfter1);
      expect(cartAfter1[0].quantity).toBe(1);
      expect(cartAfter2[0].quantity).toBe(2);
    });

    it("verifies product-card.tsx circular quick-add button triggers addProduct without navigating", () => {
      const productCardSrc = readFileSync(resolve(mobileRoot, "components/product-card.tsx"), "utf8");
      expect(productCardSrc).toContain("addProduct(product, 1)");
      expect(productCardSrc).toContain("Haptics.impactAsync");
      expect(productCardSrc).toContain("buyButtonCompact");
      expect(productCardSrc).toContain('name="add"');
    });
  });

  // ==========================================================================
  // 2. Countdown Timer Resilience & Non-Negative Clamping
  // ==========================================================================
  describe("2. Countdown Timer Resilience & Non-Negative Clamping", () => {
    it("formats standard positive countdown durations into HH:MM:SS format", () => {
      const ms = (5 * 3600 + 34 * 60 + 20) * 1000;
      const res = formatDealsCountdown(ms);
      expect(res.formatted).toBe("05:34:20");
      expect(res.hours).toBe(5);
      expect(res.minutes).toBe(34);
      expect(res.seconds).toBe(20);
      expect(res.isExpired).toBe(false);
    });

    it("handles exact 1-second boundary tick without prematurely expiring", () => {
      const res = formatDealsCountdown(1000);
      expect(res.formatted).toBe("00:00:01");
      expect(res.hours).toBe(0);
      expect(res.minutes).toBe(0);
      expect(res.seconds).toBe(1);
      expect(res.isExpired).toBe(false);
    });

    it("clamps 0ms and negative values to 00:00:00 and marks isExpired = true", () => {
      const zero = formatDealsCountdown(0);
      expect(zero.formatted).toBe("00:00:00");
      expect(zero.isExpired).toBe(true);

      const neg1 = formatDealsCountdown(-1);
      expect(neg1.formatted).toBe("00:00:00");
      expect(neg1.isExpired).toBe(true);

      const negHuge = formatDealsCountdown(-999999999);
      expect(negHuge.formatted).toBe("00:00:00");
      expect(negHuge.isExpired).toBe(true);
    });

    it("clamps non-finite values (NaN, Infinity, -Infinity) gracefully", () => {
      expect(formatDealsCountdown(Number.NaN)).toEqual({
        formatted: "00:00:00",
        hours: 0,
        minutes: 0,
        seconds: 0,
        isExpired: true,
      });

      expect(formatDealsCountdown(Number.POSITIVE_INFINITY)).toEqual({
        formatted: "00:00:00",
        hours: 0,
        minutes: 0,
        seconds: 0,
        isExpired: true,
      });

      expect(formatDealsCountdown(Number.NEGATIVE_INFINITY)).toEqual({
        formatted: "00:00:00",
        hours: 0,
        minutes: 0,
        seconds: 0,
        isExpired: true,
      });
    });

    it("verifies minute, hour, and multi-day rollovers correctly", () => {
      expect(formatDealsCountdown(59 * 1000).formatted).toBe("00:00:59");
      expect(formatDealsCountdown(60 * 1000).formatted).toBe("00:01:00");
      expect(formatDealsCountdown((59 * 60 + 59) * 1000).formatted).toBe("00:59:59");
      expect(formatDealsCountdown(3600 * 1000).formatted).toBe("01:00:00");
      expect(formatDealsCountdown(26 * 3600 * 1000).formatted).toBe("26:00:00");
    });

    it("verifies flash-deals-rail.tsx source contains timer tick and non-negative clamp", () => {
      const dealsRailSrc = readFileSync(resolve(mobileRoot, "components/flash-deals-rail.tsx"), "utf8");
      expect(dealsRailSrc).toContain("setInterval");
      expect(dealsRailSrc).toContain("setMsRemaining((prev) => (prev > 1000 ? prev - 1000 : 0))");
      expect(dealsRailSrc).toContain("clearInterval(timer)");
      expect(dealsRailSrc).toContain("export function formatDealsCountdown");
    });

    it("tests isSub10kDeal boundary conditions (9,999 vs 10,000 vs 10,001 and salePrice)", () => {
      expect(isSub10kDeal(createMockProduct("p1", { price: "9999" }))).toBe(true);
      expect(isSub10kDeal(createMockProduct("p2", { price: "10000" }))).toBe(false);
      expect(isSub10kDeal(createMockProduct("p3", { price: "10001" }))).toBe(false);
      expect(isSub10kDeal(createMockProduct("p4", { price: "0" }))).toBe(false);
      expect(isSub10kDeal(createMockProduct("p5", { price: "-500" }))).toBe(false);

      // Sale price takes precedence
      expect(isSub10kDeal(createMockProduct("p6", { price: "15000", salePrice: "8500" }))).toBe(true);
      expect(isSub10kDeal(createMockProduct("p7", { price: "15000", salePrice: "10000" }))).toBe(false);
      expect(isSub10kDeal(createMockProduct("p8", { price: "5000", salePrice: "12000" }))).toBe(false);

      // Non-numeric or empty prices
      expect(isSub10kDeal(createMockProduct("p9", { price: "" }))).toBe(false);
      expect(isSub10kDeal(createMockProduct("p10", { price: "abc" }))).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Category Filtering & Routing Resilience
  // ==========================================================================
  describe("3. Category Filtering & Routing Resilience", () => {
    const indexSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/index.tsx"), "utf8");
    const claySrc = readFileSync(resolve(mobileRoot, "components/claymorphic-categories.tsx"), "utf8");

    it("ensures catalogDisplayState returns EMPTY when category filter matches 0 products", () => {
      const state = catalogDisplayState([], false, null);
      expect(state).toBe("EMPTY");
    });

    it("ensures catalogDisplayState returns READY when products exist", () => {
      const state = catalogDisplayState([createMockProduct("p-test")], false, null);
      expect(state).toBe("READY");
    });

    it("ensures catalogDisplayState returns LOADING or ERROR when appropriate", () => {
      expect(catalogDisplayState([], true, null)).toBe("LOADING");
      expect(catalogDisplayState([], false, "network timeout")).toBe("ERROR");
    });

    it("verifies index.tsx fallback categories are defined for empty category responses", () => {
      expect(indexSrc).toContain("const FALLBACK_DISCOVERY_CATEGORIES");
      expect(indexSrc).toContain('"قرطاسية"');
      expect(indexSrc).toContain('"مستلزمات الدراسة"');
      expect(indexSrc).toContain('"الطباعة"');
      expect(indexSrc).toContain('"المكتب"');
    });

    it("verifies index.tsx resets category filter gracefully when selecting '0'", () => {
      expect(indexSrc).toContain('setHomeCategoryId(categoryId === "0" ? null : categoryId)');
    });

    it("verifies CLAYMORPHIC_SPRING_CONFIG parameters conform to specification", () => {
      expect(CLAYMORPHIC_SPRING_CONFIG.scale).toBe(0.92);
      expect(CLAYMORPHIC_SPRING_CONFIG.damping).toBe(15);
      expect(CLAYMORPHIC_SPRING_CONFIG.stiffness).toBe(300);
    });

    it("verifies claymorphic-categories.tsx contains spring animation handlers and tactile styling", () => {
      expect(claySrc).toContain("CLAYMORPHIC_SPRING_CONFIG");
      expect(claySrc).toContain("Animated.spring");
      expect(claySrc).toContain("onPressIn={handlePressIn}");
      expect(claySrc).toContain("onPressOut={handlePressOut}");
      expect(claySrc).toContain("embossedHighlight");
    });

    it("verifies CART_BOUNCE_SPRING_CONFIG parameters conform to specification", () => {
      expect(CART_BOUNCE_SPRING_CONFIG.damping).toBe(12);
      expect(CART_BOUNCE_SPRING_CONFIG.stiffness).toBe(200);
      expect(CART_BOUNCE_SPRING_CONFIG.idleScale).toBe(1.0);
      expect(CART_BOUNCE_SPRING_CONFIG.peakScale).toBe(1.25);
    });
  });

  // ==========================================================================
  // 4. Loyalty Points Math & Boundary Thresholds
  // ==========================================================================
  describe("4. Loyalty Points Math & Boundary Thresholds", () => {
    const loyaltySrc = readFileSync(resolve(mobileRoot, "app/loyalty.tsx"), "utf8");

    it("computes exact progress at 0 points (0 / 500 = 0%)", () => {
      const res = calculateLoyaltyProgress(0, 500);
      expect(res.currentPoints).toBe(0);
      expect(res.threshold).toBe(500);
      expect(res.progressRatio).toBe(0);
      expect(res.percentageText).toBe("0%");
      expect(res.pointsRemaining).toBe(500);
      expect(res.isGoalReached).toBe(false);
    });

    it("computes exact progress at 250 points (250 / 500 = 50%)", () => {
      const res = calculateLoyaltyProgress(250, 500);
      expect(res.currentPoints).toBe(250);
      expect(res.threshold).toBe(500);
      expect(res.progressRatio).toBe(0.5);
      expect(res.percentageText).toBe("50%");
      expect(res.pointsRemaining).toBe(250);
      expect(res.isGoalReached).toBe(false);
    });

    it("computes exact progress at goal boundary 500 points (500 / 500 = 100%)", () => {
      const res = calculateLoyaltyProgress(500, 500);
      expect(res.currentPoints).toBe(500);
      expect(res.threshold).toBe(500);
      expect(res.progressRatio).toBe(1.0);
      expect(res.percentageText).toBe("100%");
      expect(res.pointsRemaining).toBe(0);
      expect(res.isGoalReached).toBe(true);
    });

    it("clamps overflow progress at >500 points (750 / 500 = 100% ratio 1.0)", () => {
      const res = calculateLoyaltyProgress(750, 500);
      expect(res.currentPoints).toBe(750);
      expect(res.threshold).toBe(500);
      expect(res.progressRatio).toBe(1.0);
      expect(res.percentageText).toBe("100%");
      expect(res.pointsRemaining).toBe(0);
      expect(res.isGoalReached).toBe(true);
    });

    it("safely handles hostile inputs (negative points, NaN, Infinity, threshold <= 0)", () => {
      const neg = calculateLoyaltyProgress(-150, 500);
      expect(neg.currentPoints).toBe(0);
      expect(neg.progressRatio).toBe(0);
      expect(neg.pointsRemaining).toBe(500);

      const nanRes = calculateLoyaltyProgress(Number.NaN, 500);
      expect(nanRes.currentPoints).toBe(0);
      expect(nanRes.progressRatio).toBe(0);

      const zeroThresh = calculateLoyaltyProgress(100, 0);
      expect(zeroThresh.threshold).toBe(1);
      expect(Number.isFinite(zeroThresh.progressRatio)).toBe(true);

      const negThresh = calculateLoyaltyProgress(100, -50);
      expect(negThresh.threshold).toBe(1);
      expect(Number.isFinite(negThresh.progressRatio)).toBe(true);
    });

    it("verifies LOYALTY_TIERS definitions across all 4 tiers", () => {
      expect(LOYALTY_TIERS.BRONZE.minPoints).toBe(0);
      expect(LOYALTY_TIERS.BRONZE.pointsMultiplier).toBe(1.0);

      expect(LOYALTY_TIERS.SILVER.minPoints).toBe(500);
      expect(LOYALTY_TIERS.SILVER.pointsMultiplier).toBe(1.25);

      expect(LOYALTY_TIERS.GOLD.minPoints).toBe(1000);
      expect(LOYALTY_TIERS.GOLD.pointsMultiplier).toBe(1.5);

      expect(LOYALTY_TIERS.VIP.minPoints).toBe(2500);
      expect(LOYALTY_TIERS.VIP.pointsMultiplier).toBe(2.0);
    });

    it("verifies loyalty screen source contains coupon activation and haptics", () => {
      expect(loyaltySrc).toContain("تفعيل الكوبون");
      expect(loyaltySrc).toContain("تم التفعيل بنجاح");
      expect(loyaltySrc).toContain("Haptics.notificationAsync");
      expect(loyaltySrc).toContain("AsyncStorage.setItem");
    });
  });

  // ==========================================================================
  // 5. Zero Emoji Adversarial Sweep Across All Mobile Files
  // ==========================================================================
  describe("5. Zero Emoji Adversarial Sweep Across All Mobile Files", () => {
    const emojiRegex =
      /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

    function getSourceFiles(dir: string): string[] {
      const results: string[] = [];
      if (!existsSync(dir)) return results;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== ".expo") {
            results.push(...getSourceFiles(fullPath));
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
            results.push(fullPath);
          }
        }
      }
      return results;
    }

    it("verifies zero emojis in customer-store-mobile app/ directory", () => {
      const appFiles = getSourceFiles(resolve(mobileRoot, "app"));
      expect(appFiles.length).toBeGreaterThan(0);

      const violations: { file: string; line: number; match: string }[] = [];
      for (const file of appFiles) {
        const content = readFileSync(file, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          if (line.includes("//") || line.includes("/*") || line.includes("*")) {
            return;
          }
          const match = line.match(emojiRegex);
          if (match) {
            violations.push({
              file: file.replace(mobileRoot, ""),
              line: index + 1,
              match: match[0],
            });
          }
        });
      }

      expect(violations).toEqual([]);
    });

    it("verifies zero emojis in customer-store-mobile components/ directory", () => {
      const componentFiles = getSourceFiles(resolve(mobileRoot, "components"));
      expect(componentFiles.length).toBeGreaterThan(0);

      const violations: { file: string; line: number; match: string }[] = [];
      for (const file of componentFiles) {
        const content = readFileSync(file, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          if (line.includes("//") || line.includes("/*") || line.includes("*")) {
            return;
          }
          const match = line.match(emojiRegex);
          if (match) {
            violations.push({
              file: file.replace(mobileRoot, ""),
              line: index + 1,
              match: match[0],
            });
          }
        });
      }

      expect(violations).toEqual([]);
    });

    it("verifies zero emojis in customer-store-mobile lib/ directory", () => {
      const libFiles = getSourceFiles(resolve(mobileRoot, "lib"));
      expect(libFiles.length).toBeGreaterThan(0);

      const violations: { file: string; line: number; match: string }[] = [];
      for (const file of libFiles) {
        const content = readFileSync(file, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          if (line.includes("//") || line.includes("/*") || line.includes("*")) {
            return;
          }
          const match = line.match(emojiRegex);
          if (match) {
            violations.push({
              file: file.replace(mobileRoot, ""),
              line: index + 1,
              match: match[0],
            });
          }
        });
      }

      expect(violations).toEqual([]);
    });
  });

  // ==========================================================================
  // 6. Currency & Localization Invariants
  // ==========================================================================
  describe("6. Currency & Localization Invariants", () => {
    it("formats IQD currency strictly with Latin numerals and Iraqi dinar suffix", () => {
      const formatted = formatIqd(12500);
      expect(formatted).toContain("12,500");
      expect(formatted).toContain("د.ع");
      expect(/[\u0660-\u0669]/.test(formatted)).toBe(false);
    });

    it("formats Latin numbers without eastern numerals", () => {
      const latin = formatLatinNumber(4567);
      expect(latin).toBe("4,567");
      expect(/[\u0660-\u0669]/.test(latin)).toBe(false);
    });

    it("computes product discount percentage accurately", () => {
      expect(productDiscountPercent(createMockProduct("p-disc-1", { price: "10000", salePrice: "7500" }))).toBe(25);
      expect(productDiscountPercent(createMockProduct("p-disc-2", { price: "20000", salePrice: "10000" }))).toBe(50);
      expect(productDiscountPercent(createMockProduct("p-disc-3", { price: "10000", salePrice: undefined }))).toBeNull();
      expect(productDiscountPercent(createMockProduct("p-disc-4", { price: "10000", salePrice: "10000" }))).toBeNull();
      expect(productDiscountPercent(createMockProduct("p-disc-5", { price: "10000", salePrice: "12000" }))).toBeNull();
    });
  });
});
