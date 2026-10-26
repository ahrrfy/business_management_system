import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(__dirname, "..");
const loyaltySrc = readFileSync(resolve(mobileRoot, "app/loyalty.tsx"), "utf8");
const perksSrc = readFileSync(resolve(mobileRoot, "app/(tabs)/perks.tsx"), "utf8");
const apiSrc = readFileSync(resolve(mobileRoot, "lib/storefront-api.ts"), "utf8");

// Strict Zero-Emoji Regex guard
const FORBIDDEN_EMOJI_REGEX =
  /[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/u;

describe("Milestone 4: Dedicated Loyalty & Rewards Experience", () => {
  describe("1. Membership Tier Perks & Ladder", () => {
    it("verifies tier resolution logic in loyalty screen", () => {
      expect(loyaltySrc).toContain("export const LOYALTY_TIERS");
      expect(loyaltySrc).toContain("export function resolveLoyaltyTier");
      expect(loyaltySrc).toContain('"BRONZE"');
      expect(loyaltySrc).toContain('"SILVER"');
      expect(loyaltySrc).toContain('"GOLD"');
      expect(loyaltySrc).toContain('"VIP"');
    });

    it("verifies tier perk cards content in loyalty screen source", () => {
      expect(loyaltySrc).toContain("توصيل مجاني");
      expect(loyaltySrc).toContain("كوبونات خصم حصرية");
      expect(loyaltySrc).toContain("نقاط مضاعفة 2x");
      expect(loyaltySrc).toContain("مزايا مستواك الحالي");
      expect(loyaltySrc).toContain("مستويات العضوية في البرنامج");
    });
  });

  describe("2. Dynamic Points Progress towards Next Tier (250 / 500 Contract)", () => {
    it("verifies dynamic progress calculation in loyalty screen source", () => {
      expect(loyaltySrc).toContain("export function calculateLoyaltyProgress");
      expect(loyaltySrc).toContain("nextTierThreshold");
      expect(loyaltySrc).toContain("pointsRemaining");
      expect(loyaltySrc).toContain("progressRatio");
      expect(loyaltySrc).toContain("percentageText");
    });

    it("verifies 3D coin visual styling and sparkle vector icons in source", () => {
      expect(loyaltySrc).toContain("coinOuterGlow");
      expect(loyaltySrc).toContain("sparkleTop");
      expect(loyaltySrc).toContain("sparkleBottom");
      expect(loyaltySrc).toContain("coinOuterRing");
      expect(loyaltySrc).toContain("coinMiddleRim");
      expect(loyaltySrc).toContain("coinInnerEmboss");
      expect(loyaltySrc).toContain('name="auto-awesome"');
      expect(loyaltySrc).toContain('name="stars"');
    });
  });

  describe("3. Direct Voucher / Coupon Activation & Self-Service Points Redemption", () => {
    it("verifies activate coupon button and success state in loyalty screen", () => {
      expect(loyaltySrc).toContain("تفعيل الكوبون");
      expect(loyaltySrc).toContain("تم التفعيل بنجاح");
      expect(loyaltySrc).toContain("handleActivateCoupon");
      expect(loyaltySrc).toContain("saveActiveCouponCode");
      expect(loyaltySrc).toContain("Clipboard.setString");
      expect(loyaltySrc).toContain("Haptics.notificationAsync");
    });

    it("verifies self-service loyalty points redemption wiring and idempotent request key", () => {
      expect(apiSrc).toContain("redeemStorefrontLoyaltyPoints");
      expect(apiSrc).toContain('"storefront.redeemLoyaltyPoints"');
      expect(apiSrc).toContain("computeLoyaltyRedeemPreview");
      expect(loyaltySrc).toContain("redeemStorefrontLoyaltyPoints");
      expect(loyaltySrc).toContain("computeLoyaltyRedeemPreview");
      expect(loyaltySrc).toContain("بدون حد أدنى");
      expect(loyaltySrc).toContain("استبدال النقاط بقسيمة خصم");
      expect(loyaltySrc).toContain("استبدال النقاط وتفعيل الكوبون");
      expect(loyaltySrc).toContain("clientRequestId: redeemRequestId");
      expect(loyaltySrc).toContain("ORDER_REVERSE");
      expect(loyaltySrc).toContain("REDEEM");
    });

    it("computes deterministic redemption preview matching backend maxRedeemPercent and 1,000,000 cap rules", async () => {
      const { computeLoyaltyRedeemPreview, MAX_LOYALTY_REDEEM_POINTS } = await import("../lib/storefront-api");

      // maxRedeemPercent = 0 means NO relative cap (minOrderSpendIqd = 0, NOT divided by 1%!)
      const uncappedZero = computeLoyaltyRedeemPreview({
        pointsNumber: 500,
        redeemPointsInput: "100",
        loyalty: {
          iqdDiscountPerPoint: "50",
          minRedeemPoints: 50,
          maxRedeemPercent: 0,
        },
      });
      expect(uncappedZero).toMatchObject({
        discountIqd: 5000,
        minOrderSpendIqd: 0,
        hasRelativeCap: false,
        canRedeem: true,
      });

      // maxRedeemPercent = 100 also means NO relative cap beyond discount itself (minOrderSpendIqd = 0)
      const uncappedHundred = computeLoyaltyRedeemPreview({
        pointsNumber: 500,
        redeemPointsInput: "100",
        loyalty: {
          iqdDiscountPerPoint: "50",
          minRedeemPoints: 50,
          maxRedeemPercent: 100,
        },
      });
      expect(uncappedHundred).toMatchObject({
        discountIqd: 5000,
        minOrderSpendIqd: 0,
        hasRelativeCap: false,
        canRedeem: true,
      });

      // maxRedeemPercent = 25 enforces ceil(5000 * 100 / 25) = 20,000 IQD min cart spend
      const capped25 = computeLoyaltyRedeemPreview({
        pointsNumber: 500,
        redeemPointsInput: "100",
        loyalty: {
          iqdDiscountPerPoint: "50",
          minRedeemPoints: 50,
          maxRedeemPercent: 25,
        },
      });
      expect(capped25).toMatchObject({
        discountIqd: 5000,
        minOrderSpendIqd: 20000,
        hasRelativeCap: true,
        canRedeem: true,
      });

      // Balance > 1,000,000 caps single-transaction redeemableBalance at 1,000,000 matching server Zod .max(1_000_000)
      const hugeBalance = computeLoyaltyRedeemPreview({
        pointsNumber: 1_500_000,
        redeemPointsInput: "1200000",
        loyalty: {
          iqdDiscountPerPoint: "10",
          minRedeemPoints: 100,
          maxRedeemPercent: 50,
        },
      });
      expect(hugeBalance.redeemableBalance).toBe(MAX_LOYALTY_REDEEM_POINTS);
      expect(hugeBalance.canRedeem).toBe(false);
    });
  });

  describe("4. Tab Route Integration & Floating Capsule Scroll Padding", () => {
    it("verifies isTab prop bridging in perks tab and loyalty screen", () => {
      expect(perksSrc).toContain("<LoyaltyScreen isTab />");
      expect(loyaltySrc).toContain("isTab = false");
      expect(loyaltySrc).toContain("!isTab &&");
      expect(loyaltySrc).toContain("tabContent: { paddingBottom: 110 }");
      expect(loyaltySrc).toContain("stackContent: { paddingBottom: 34 }");
    });
  });

  describe("5. Preserved Text Contracts & Zero Emojis", () => {
    it("preserves all required text contracts in loyalty.tsx", () => {
      expect(loyaltySrc).toContain("مزايا حسابك ومكافآت الولاء");
      expect(loyaltySrc).toContain("رصيدك المتاح");
      expect(loyaltySrc).toContain("نقطة ولاء");
      expect(loyaltySrc).toContain("طلب كوبون الترحيب");
      expect(loyaltySrc).toContain("طلب كوبون أول طلب");
      expect(loyaltySrc).toContain("طلب كوبون الطلب الأول");
      expect(loyaltySrc).toContain("الرجوع للمتجر");
      expect(loyaltySrc).toContain("سياسة التوفير في الطلب");
      expect(loyaltySrc).toContain("منفعة سعرية واحدة فقط على المنتجات في كل طلب");
      expect(loyaltySrc).toContain("سعر الجملة أو العرض أو الكوبون");
      expect(loyaltySrc).toContain("يُعتمد الأعلى توفيراً تلقائياً");
      expect(loyaltySrc).toContain("عرض التوصيل مستقل عن هذه المنفعة");
      expect(loyaltySrc).toContain("اطلبه بنفسك قبل إنشاء أول طلب");
    });

    it("verifies strict zero emojis in loyalty.tsx and perks.tsx", () => {
      expect(FORBIDDEN_EMOJI_REGEX.test(loyaltySrc)).toBe(false);
      expect(FORBIDDEN_EMOJI_REGEX.test(perksSrc)).toBe(false);
    });
  });
});
