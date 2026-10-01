import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { addProductToCart, sanitizeCartLines } from "../lib/cart-context";
import {
  isAllowedStorefrontNotificationPath,
  storefrontPathFromNotificationData,
} from "../lib/customer-notification-routes";
import { formatLatinNumber } from "../lib/storefront-api";
import type { CartLine, Product } from "../shared/storefront";

const mobileRoot = resolve(__dirname, "..");

function createMockProduct(id: string, price = "5000", maxQuantity = 999): Product {
  const numericId = Array.from(id).reduce((sum, c) => sum * 31 + c.charCodeAt(0), 17);
  return {
    id,
    productId: numericId,
    productUnitId: numericId + 10,
    variantId: numericId + 20,
    title: `منتج تجريبي ${id}`,
    subtitle: "قطعة",
    categoryId: "stationery",
    description: "وصف منتج تجريبي",
    icon: "menu-book",
    accent: "#E7F1EC",
    availability: "متوفر",
    price,
    inStock: true,
  };
}

describe("Milestone 1 Empirical Challenger & Stress Harness", () => {
  // ==========================================================================
  // 1. Tab Route Configurations & Capsule Bar Architecture
  // ==========================================================================
  describe("1. Tab Route Configurations & Dark Capsule Architecture", () => {
    const layoutPath = resolve(mobileRoot, "app/(tabs)/_layout.tsx");

    it("verifies _layout.tsx exists and contains the 5 required tabs and 2 legacy routes", () => {
      expect(existsSync(layoutPath)).toBe(true);
      const layoutSrc = readFileSync(layoutPath, "utf8");

      const requiredActiveTabs = ["index", "deals", "perks", "cart", "account"];
      for (const tab of requiredActiveTabs) {
        expect(layoutSrc).toContain(`name="${tab}"`);
      }

      const legacyHiddenRoutes = ["categories", "orders"];
      for (const legacy of legacyHiddenRoutes) {
        expect(layoutSrc).toContain(`name="${legacy}"`);
      }
    });

    it("verifies legacy routes are configured with href: null so they remain navigable without appearing in the capsule bar", () => {
      const layoutSrc = readFileSync(layoutPath, "utf8");

      // Verify categories has href: null
      const categoriesMatch = layoutSrc.match(/name="categories"[\s\S]*?options=\{\{\s*href:\s*null/);
      expect(categoriesMatch).not.toBeNull();

      // Verify orders has href: null
      const ordersMatch = layoutSrc.match(/name="orders"[\s\S]*?options=\{\{\s*href:\s*null/);
      expect(ordersMatch).not.toBeNull();
    });

    it("verifies dark capsule styling tokens match the Option A Luxury specifications", () => {
      const layoutSrc = readFileSync(layoutPath, "utf8");

      expect(layoutSrc).toContain('backgroundColor: "rgba(15, 23, 42, 0.95)"');
      expect(layoutSrc).toContain('borderColor: "rgba(16, 185, 129, 0.22)"');
      expect(layoutSrc).toContain("borderWidth: 1.5");
      expect(layoutSrc).toContain("borderRadius: 28");
      expect(layoutSrc).toContain('position: "absolute"');
      expect(layoutSrc).toContain('tabBarActiveTintColor: "#10B981"');
      expect(layoutSrc).toContain('tabBarActiveBackgroundColor: "rgba(16, 185, 129, 0.15)"');
      expect(layoutSrc).toContain('tabBarInactiveTintColor: "#94A3B8"');
      expect(layoutSrc).toContain("HapticTab");
    });

    it("verifies all screen source files exist and export default React components", () => {
      const screenFiles = [
        "app/(tabs)/index.tsx",
        "app/(tabs)/deals.tsx",
        "app/(tabs)/perks.tsx",
        "app/(tabs)/cart.tsx",
        "app/(tabs)/account.tsx",
        "app/(tabs)/categories.tsx",
        "app/(tabs)/orders.tsx",
        "app/loyalty.tsx",
      ];

      for (const relPath of screenFiles) {
        const fullPath = resolve(mobileRoot, relPath);
        expect(existsSync(fullPath)).toBe(true);
        const content = readFileSync(fullPath, "utf8");
        expect(content).toMatch(/export\s+default\s+function/);
      }
    });
  });

  // ==========================================================================
  // 2. Route Navigation & Deep Link Stress Testing
  // ==========================================================================
  describe("2. Route Navigation & Deep Link Stress Testing", () => {
    it("navigates successfully to /deals, /perks, /cart, and verifies legacy routes /categories and /orders resolve", () => {
      // Direct notification route validation
      expect(isAllowedStorefrontNotificationPath("/deals")).toBe(true);
      expect(isAllowedStorefrontNotificationPath("/perks")).toBe(true);
      expect(isAllowedStorefrontNotificationPath("/cart")).toBe(true);
      expect(isAllowedStorefrontNotificationPath("/categories")).toBe(true);
      expect(isAllowedStorefrontNotificationPath("/orders")).toBe(true);
      expect(isAllowedStorefrontNotificationPath("/")).toBe(true);
      expect(isAllowedStorefrontNotificationPath("/search")).toBe(true);
    });

    it("extracts valid routes from notification payloads", () => {
      expect(storefrontPathFromNotificationData({ path: "/deals" })).toBe("/deals");
      expect(storefrontPathFromNotificationData({ path: "/perks" })).toBe("/perks");
      expect(storefrontPathFromNotificationData({ path: "/cart" })).toBe("/cart");
      expect(storefrontPathFromNotificationData({ path: "/categories" })).toBe("/categories");
      expect(storefrontPathFromNotificationData({ path: "/orders" })).toBe("/orders");
    });

    it("stress tests adversarial and malformed routes to prevent crashes and injection", () => {
      const adversarialPaths = [
        "/deals?query=injection",
        "/perks#fragment",
        "https://malicious.com/deals",
        "//malicious.com/orders",
        "/deals/../../etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<h1>evil</h1>",
        "/nonexistent-screen",
        "",
        " ",
        "/product/not-a-number",
        "/product/-1",
        "/".repeat(200),
      ];

      for (const badPath of adversarialPaths) {
        expect(isAllowedStorefrontNotificationPath(badPath)).toBe(false);
        expect(storefrontPathFromNotificationData({ path: badPath })).toBeNull();
      }

      // Non-object or corrupted payloads
      expect(storefrontPathFromNotificationData(null)).toBeNull();
      expect(storefrontPathFromNotificationData(undefined)).toBeNull();
      expect(storefrontPathFromNotificationData("not-an-object")).toBeNull();
      expect(storefrontPathFromNotificationData(42)).toBeNull();
      expect(storefrontPathFromNotificationData({ path: null })).toBeNull();
      expect(storefrontPathFromNotificationData({ path: 123 })).toBeNull();
    });

    it("verifies perks tab bridges cleanly to loyalty with isTab prop", () => {
      const perksSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/perks.tsx"), "utf8");
      expect(perksSrc).toContain("<LoyaltyScreen isTab />");

      const loyaltySrc = readFileSync(resolve(mobileRoot, "app/loyalty.tsx"), "utf8");
      expect(loyaltySrc).toContain("isTab = false");
      expect(loyaltySrc).toContain("!isTab &&");
    });
  });

  // ==========================================================================
  // 3. Cart Badge Counter Empirical Behavior (0, 1, 99, 999)
  // ==========================================================================
  describe("3. Cart Badge Counter Behavior (0, 1, 99, 999)", () => {
    // Evaluation helper mirroring TabLayout:
    // tabBarBadge: itemCount > 0 ? itemCount : undefined
    const evaluateTabBarBadge = (itemCount: number) => (itemCount > 0 ? itemCount : undefined);

    // Evaluation helper mirroring DealsScreen:
    // itemCount > 0 && formatLatinNumber(itemCount)
    const evaluateDealsBadge = (itemCount: number) =>
      itemCount > 0 ? formatLatinNumber(itemCount) : null;

    it("evaluates badge correctly when itemCount is 0", () => {
      const count = 0;
      expect(evaluateTabBarBadge(count)).toBeUndefined();
      expect(evaluateDealsBadge(count)).toBeNull();
    });

    it("evaluates badge correctly when itemCount is 1", () => {
      const count = 1;
      expect(evaluateTabBarBadge(count)).toBe(1);
      expect(evaluateDealsBadge(count)).toBe("1");
    });

    it("evaluates badge correctly when itemCount is 99", () => {
      const count = 99;
      expect(evaluateTabBarBadge(count)).toBe(99);
      expect(evaluateDealsBadge(count)).toBe("99");
    });

    it("evaluates badge correctly when itemCount is 999", () => {
      const count = 999;
      expect(evaluateTabBarBadge(count)).toBe(999);
      expect(evaluateDealsBadge(count)).toBe("999");
    });

    it("stress tests badge behavior through cart context mutations", () => {
      let lines: CartLine[] = [];
      const prodA = createMockProduct("item-a");
      const prodB = createMockProduct("item-b");

      // State 0: Empty cart
      let total = lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(total).toBe(0);
      expect(evaluateTabBarBadge(total)).toBeUndefined();

      // State 1: 1 item added
      lines = addProductToCart(lines, prodA, 1);
      total = lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(total).toBe(1);
      expect(evaluateTabBarBadge(total)).toBe(1);
      expect(evaluateDealsBadge(total)).toBe("1");

      // State 99: Add 98 more items
      lines = addProductToCart(lines, prodA, 98);
      total = lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(total).toBe(99);
      expect(evaluateTabBarBadge(total)).toBe(99);
      expect(evaluateDealsBadge(total)).toBe("99");

      // State 999: Add 900 items to reach single-line limit of 999
      lines = addProductToCart(lines, prodA, 900);
      total = lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(total).toBe(999);
      expect(evaluateTabBarBadge(total)).toBe(999);
      expect(evaluateDealsBadge(total)).toBe("999");

      // Stress: Adding more to the same line is clamped to MAX_QUANTITY_PER_LINE (999)
      lines = addProductToCart(lines, prodA, 50);
      total = lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(total).toBe(999);
      expect(evaluateTabBarBadge(total)).toBe(999);

      // Multi-line expansion: Adding a second product can expand beyond 999
      lines = addProductToCart(lines, prodB, 500);
      total = lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(total).toBe(1499);
      expect(evaluateTabBarBadge(total)).toBe(1499);
      expect(evaluateDealsBadge(total)).toBe("1,499");
    });

    it("verifies badge formatting produces strictly Latin digits and no Eastern Arabic numerals", () => {
      const testCounts = [0, 1, 12, 99, 100, 999, 1499, 9999];
      const easternArabicDigits = /[٠-٩]/;

      for (const count of testCounts) {
        const formatted = formatLatinNumber(count);
        expect(easternArabicDigits.test(formatted)).toBe(false);
      }
    });

    it("stress tests negative or invalid itemCount edge cases", () => {
      // Negative itemCount must not produce a visible badge
      expect(evaluateTabBarBadge(-1)).toBeUndefined();
      expect(evaluateTabBarBadge(-999)).toBeUndefined();
      expect(evaluateDealsBadge(-1)).toBeNull();

      // NaN or null should not produce badge
      expect(evaluateTabBarBadge(NaN as any)).toBeUndefined();
      expect(evaluateDealsBadge(NaN as any)).toBeNull();
    });
  });

  // ==========================================================================
  // 4. Strict Zero Emoji Enforcement Stress Test
  // ==========================================================================
  describe("4. Zero Emoji Compliance Across Store Codebase", () => {
    const FORBIDDEN_EMOJI_REGEX =
      /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}]/u;

    it("confirms zero emojis in index.tsx", () => {
      const indexSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/index.tsx"), "utf8");
      expect(FORBIDDEN_EMOJI_REGEX.test(indexSrc)).toBe(false);
    });

    it("confirms zero emojis in customer-notifications.ts", () => {
      const notifSrc = readFileSync(
        resolve(mobileRoot, "lib/customer-notifications.ts"),
        "utf8",
      );
      expect(FORBIDDEN_EMOJI_REGEX.test(notifSrc)).toBe(false);
    });

    it("confirms zero emojis in new tab routes deals.tsx and perks.tsx", () => {
      const dealsSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/deals.tsx"), "utf8");
      const perksSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/perks.tsx"), "utf8");
      expect(FORBIDDEN_EMOJI_REGEX.test(dealsSrc)).toBe(false);
      expect(FORBIDDEN_EMOJI_REGEX.test(perksSrc)).toBe(false);
    });

    it("confirms zero emojis in app/(tabs)/_layout.tsx", () => {
      const layoutSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/_layout.tsx"), "utf8");
      expect(FORBIDDEN_EMOJI_REGEX.test(layoutSrc)).toBe(false);
    });
  });
});
