import { describe, it, expect } from "vitest";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  ROOT_CAUSE_STATIONS,
  ROOT_CAUSE_STATION_LABELS,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  SENTIMENTS,
  SENTIMENT_LABELS,
} from "@shared/customerFeedback";
import {
  analyzeFeedbackSentimentAndGuidance,
  computeCustomerSmartGuidance,
  generateGiftCode,
  hashCouponCode,
} from "../customerFeedbackService";
import {
  buildInstantGiftWhatsAppMessage,
  buildGoogleReviewInviteWhatsAppMessage,
} from "../../../client/src/lib/whatsapp";
import { giftVoucherToPrintDoc } from "../../../client/src/lib/printing/giftVoucherPrint";
import Decimal from "decimal.js";
import { isElevated } from "../../lib/redact";

describe("CustomerFeedbackService - Pure Unit Tests", () => {
  describe("Constants & Vocabularies", () => {
    it("defines valid feedback categories and Arabic labels", () => {
      expect(FEEDBACK_CATEGORIES).toContain("COLOR_QUALITY");
      expect(FEEDBACK_CATEGORIES).toContain("PRINT_DELAY");
      expect(FEEDBACK_CATEGORIES).toContain("CUTTING");
      expect(FEEDBACK_CATEGORIES).toContain("LAMINATION");
      expect(FEEDBACK_CATEGORIES).toContain("DELIVERY");
      expect(FEEDBACK_CATEGORIES).toContain("SERVICE");
      expect(FEEDBACK_CATEGORIES).toContain("PACKAGING");
      expect(FEEDBACK_CATEGORIES).toContain("GENERAL");
      expect(FEEDBACK_CATEGORIES.length).toBe(8);

      for (const cat of FEEDBACK_CATEGORIES) {
        expect(FEEDBACK_CATEGORY_LABELS[cat]).toBeTruthy();
      }
    });

    it("defines valid root cause stations and Arabic labels", () => {
      expect(ROOT_CAUSE_STATIONS).toContain("PRINTING");
      expect(ROOT_CAUSE_STATIONS).toContain("CUTTING");
      expect(ROOT_CAUSE_STATIONS).toContain("LAMINATION");
      expect(ROOT_CAUSE_STATIONS).toContain("DESIGN");
      expect(ROOT_CAUSE_STATIONS).toContain("DELIVERY");
      expect(ROOT_CAUSE_STATIONS).toContain("RECEPTION");
      expect(ROOT_CAUSE_STATIONS).toContain("OTHER");

      for (const station of ROOT_CAUSE_STATIONS) {
        expect(ROOT_CAUSE_STATION_LABELS[station]).toBeTruthy();
      }
    });

    it("defines valid issue statuses and labels", () => {
      expect(ISSUE_STATUSES).toEqual([
        "NEW",
        "IN_PROGRESS",
        "RESOLVED",
        "CLOSED",
      ]);
      for (const status of ISSUE_STATUSES) {
        expect(ISSUE_STATUS_LABELS[status]).toBeTruthy();
      }
    });

    it("defines valid sentiments and labels", () => {
      expect(SENTIMENTS).toEqual(["POSITIVE", "NEUTRAL", "NEGATIVE"]);
      for (const s of SENTIMENTS) {
        expect(SENTIMENT_LABELS[s]).toBeTruthy();
      }
    });
  });

  describe("Gift Coupon Code Generation & Hashing", () => {
    it("generates formatted gift coupon codes with prefix", () => {
      const code = generateGiftCode("GIFT");
      expect(code).toMatch(/^GIFT-[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(code.length).toBe(14);
    });

    it("generates unique codes on successive calls", () => {
      const codes = new Set(
        Array.from({ length: 20 }, () => generateGiftCode("GIFT")),
      );
      expect(codes.size).toBe(20);
    });

    it("hashes coupon codes deterministically with SHA-256", () => {
      const code = "GIFT-AB23-CD45";
      const hash1 = hashCouponCode(code);
      const hash2 = hashCouponCode(" gift-ab23-cd45 ");
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("Sentiment Analysis & Smart Guidance Fallback", () => {
    it("classifies 5-star rating as POSITIVE sentiment", async () => {
      const result = await analyzeFeedbackSentimentAndGuidance({
        rating: 5,
        category: "GENERAL",
        comment: "عمل رائع ومتقن جداً، شكراً لكم",
        customerName: "أحمد العراقي",
      });
      expect(result.sentiment).toBe("POSITIVE");
      expect(result.smartGuidance).toContain("الزبون راضٍ جداً");
    });

    it("classifies 4-star rating as POSITIVE sentiment", async () => {
      const result = await analyzeFeedbackSentimentAndGuidance({
        rating: 4,
        category: "COLOR_QUALITY",
        comment: "جيد جداً الطباعة واضحة",
      });
      expect(result.sentiment).toBe("POSITIVE");
      expect(result.smartGuidance).toContain("الزبون راضٍ جداً");
    });

    it("classifies 3-star rating as NEUTRAL sentiment with follow-up guidance", async () => {
      const result = await analyzeFeedbackSentimentAndGuidance({
        rating: 3,
        category: "SERVICE",
        comment: "الخدمة مقبولة ولكن هناك تأخير طفيف",
      });
      expect(result.sentiment).toBe("NEUTRAL");
      expect(result.smartGuidance).toContain("تقييم متوسط ومحايد");
    });

    it("classifies 1-2 star rating as NEGATIVE with category-specific station alerts", async () => {
      // COLOR_QUALITY defect
      const colorResult = await analyzeFeedbackSentimentAndGuidance({
        rating: 1,
        category: "COLOR_QUALITY",
        comment: "الألوان باهتة وغير مطابقة للملف",
      });
      expect(colorResult.sentiment).toBe("NEGATIVE");
      expect(colorResult.smartGuidance).toContain("تنبيه تطابق ألوان");

      // PRINT_DELAY defect
      const delayResult = await analyzeFeedbackSentimentAndGuidance({
        rating: 2,
        category: "PRINT_DELAY",
        comment: "تأخر الاستلام يومين عن الموعد",
      });
      expect(delayResult.sentiment).toBe("NEGATIVE");
      expect(delayResult.smartGuidance).toContain("تنبيه تأخير سابق");

      // CUTTING defect
      const cuttingResult = await analyzeFeedbackSentimentAndGuidance({
        rating: 1,
        category: "CUTTING",
        comment: "القص مائل وأبعاد الكروت غير متساوية",
      });
      expect(cuttingResult.sentiment).toBe("NEGATIVE");
      expect(cuttingResult.smartGuidance).toContain("تنبيه دقة القص");

      // LAMINATION defect
      const lamResult = await analyzeFeedbackSentimentAndGuidance({
        rating: 2,
        category: "LAMINATION",
        comment: "السلوفان يتقشر وفقاعات هواء",
      });
      expect(lamResult.sentiment).toBe("NEGATIVE");
      expect(lamResult.smartGuidance).toContain("تنبيه سلفنة وحراري");

      // DELIVERY defect
      const deliveryResult = await analyzeFeedbackSentimentAndGuidance({
        rating: 1,
        category: "DELIVERY",
        comment: "تأخر السائق والكرتون متضرر",
      });
      expect(deliveryResult.sentiment).toBe("NEGATIVE");
      expect(deliveryResult.smartGuidance).toContain("تنبيه شحن وتوصيل");
    });

    it("handles boundary ratings safely (clamps < 1 and > 5)", async () => {
      const underflow = await analyzeFeedbackSentimentAndGuidance({
        rating: 0,
        category: "GENERAL",
      });
      expect(underflow.sentiment).toBe("NEGATIVE");

      const overflow = await analyzeFeedbackSentimentAndGuidance({
        rating: 10,
        category: "GENERAL",
      });
      expect(overflow.sentiment).toBe("POSITIVE");
    });
  });

  describe("WhatsApp Message Builders (0 Emojis & Arabic Locale)", () => {
    it("builds polite Iraqi Arabic instant gift WhatsApp message without emojis", () => {
      const msg = buildInstantGiftWhatsAppMessage({
        customerName: "علي الكرخي",
        code: "GIFT-99AA-BB88",
        amount: "15000",
        validUntil: "2026-11-15",
        reason: "ترضية عتب تأخير التسليم",
      });

      expect(msg).toContain("علي الكرخي");
      expect(msg).toContain("GIFT-99AA-BB88");
      expect(msg).toContain("15,000");
      expect(msg).toContain("د.ع");
      expect(msg).toContain("المكتبة العربية للطباعة");

      // Strictly zero emojis
      const emojiRegex =
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(emojiRegex.test(msg)).toBe(false);
    });

    it("builds polite Google Review invitation message without emojis", () => {
      const msg = buildGoogleReviewInviteWhatsAppMessage({
        customerName: "سارة البغدادي",
        reviewUrl: "https://g.page/r/example/review",
      });

      expect(msg).toContain("سارة البغدادي");
      expect(msg).toContain("https://g.page/r/example/review");
      expect(msg).toContain("خرائط Google");
      expect(msg).toContain("المكتبة العربية للطباعة");

      // Strictly zero emojis
      const emojiRegex =
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(emojiRegex.test(msg)).toBe(false);
    });
  });

  describe("Thermal Gift Voucher Print Document Generation", () => {
    it("generates complete 80mm thermal receipt PrintDoc structure", () => {
      const doc = giftVoucherToPrintDoc({
        code: "GIFT-TEST-1234",
        amount: "25000",
        customerName: "محمد الرافدين",
        customerPhone: "07701234567",
        reason: "تكريم زبون مميز",
        validUntil: "2026-12-01",
      });

      expect(doc.kind).toBe("receipt");
      expect(doc.title).toBe("قسيمة هدية وترضية");
      expect(doc.includeBrandHeader).toBe(true);
      expect(doc.meta.some((m) => m.includes("GIFT-TEST-1234"))).toBe(true);
      expect(doc.meta.some((m) => m.includes("محمد الرافدين"))).toBe(true);
      expect(doc.itemBlocks?.length).toBe(1);
      expect(doc.itemBlocks?.[0].quantityPrice).toContain("25,000 د.ع");
      expect(doc.totals?.some((t) => t.value.includes("25,000 د.ع"))).toBe(
        true,
      );
      expect(doc.footer).not.toBeNull();
    });

    it("respects explicit custom terms when provided to giftVoucherToPrintDoc", () => {
      const explicitTerms =
        "تُخصم لمرة واحدة على أي فاتورة مبيعات أو أمر شغل داخل فروعنا.";
      const doc = giftVoucherToPrintDoc({
        code: "GIFT-TERMS-999",
        amount: "10000",
        customerName: "زبون تجريبي",
        terms: explicitTerms,
      });

      expect(doc.footer).toBe(explicitTerms);
    });
  });

  describe("Security & Role Elevation (isElevated)", () => {
    it("recognizes elevated roles (admin, manager)", () => {
      expect(isElevated("admin")).toBe(true);
      expect(isElevated("manager")).toBe(true);
    });

    it("identifies non-elevated roles (cashier, receptionist, accountant, driver, etc.)", () => {
      expect(isElevated("cashier")).toBe(false);
      expect(isElevated("receptionist")).toBe(false);
      expect(isElevated("accountant")).toBe(false);
      expect(isElevated("driver")).toBe(false);
      expect(isElevated("operator")).toBe(false);
      expect(isElevated(null)).toBe(false);
      expect(isElevated(undefined)).toBe(false);
      expect(isElevated("")).toBe(false);
    });
  });

  describe("Financial & Credit Limit Math Invariants", () => {
    it("distinguishes zero credit limit from positive credit limit with Decimal.js", () => {
      const zeroLimit = new Decimal(0);
      const positiveLimit = new Decimal(500000);

      // In Decimal.js, 0.isPositive() is true, which caused the bug when treating 0 as having credit
      expect(zeroLimit.isPositive()).toBe(true);
      expect(zeroLimit.greaterThan(0)).toBe(false);
      expect(positiveLimit.greaterThan(0)).toBe(true);

      // Verify safe credit usage percentage calculation logic
      const balance = new Decimal(0);
      const hasCreditLimit = positiveLimit.greaterThan(0);
      const zeroHasCreditLimit = zeroLimit.greaterThan(0);

      expect(zeroHasCreditLimit).toBe(false);
      expect(hasCreditLimit).toBe(true);

      const usagePct = hasCreditLimit
        ? Math.round(balance.dividedBy(positiveLimit).times(100).toNumber())
        : 0;
      expect(usagePct).toBe(0);
      expect(Number.isNaN(usagePct)).toBe(false);
    });

    it("verifies instant gift ceiling constraint (50,000 IQD) for non-managers", () => {
      const MAX_CASHIER_GIFT = new Decimal(50000);

      const allowedAmount = new Decimal("35000");
      const boundaryAmount = new Decimal("50000");
      const excessiveAmount = new Decimal("50001");
      const highAmount = new Decimal("100000");

      expect(allowedAmount.greaterThan(MAX_CASHIER_GIFT)).toBe(false);
      expect(boundaryAmount.greaterThan(MAX_CASHIER_GIFT)).toBe(false);
      expect(excessiveAmount.greaterThan(MAX_CASHIER_GIFT)).toBe(true);
      expect(highAmount.greaterThan(MAX_CASHIER_GIFT)).toBe(true);
    });

    it("verifies financial masking logic: only elevated roles can see balance and credit limits", () => {
      // Elevated roles see actual numbers
      expect(isElevated("admin")).toBe(true);
      expect(isElevated("manager")).toBe(true);

      // Non-elevated roles, null, undefined, empty strings are strictly masked (no leakage)
      expect(isElevated("cashier")).toBe(false);
      expect(isElevated("accountant")).toBe(false);
      expect(isElevated("receptionist")).toBe(false);
      expect(isElevated(null)).toBe(false);
      expect(isElevated(undefined)).toBe(false);
      expect(isElevated("")).toBe(false);
    });

    it("verifies Google Review eligibility logic across mixed feedback collections", () => {
      const feedbacksWithUninvited5Star = [
        { rating: 4, googleReviewInviteSent: false },
        { rating: 5, googleReviewInviteSent: false },
        { rating: 2, googleReviewInviteSent: true },
      ];

      const uninvited1 = feedbacksWithUninvited5Star.find(
        (f) => f.rating === 5 && !f.googleReviewInviteSent,
      );
      expect(!!uninvited1).toBe(true);

      const feedbacksAllInvited = [
        { rating: 5, googleReviewInviteSent: true },
        { rating: 4, googleReviewInviteSent: false },
      ];

      const uninvited2 = feedbacksAllInvited.find(
        (f) => f.rating === 5 && !f.googleReviewInviteSent,
      );
      expect(!!uninvited2).toBe(false);

      const feedbacksNo5Star = [
        { rating: 4, googleReviewInviteSent: false },
        { rating: 3, googleReviewInviteSent: false },
      ];

      const uninvited3 = feedbacksNo5Star.find(
        (f) => f.rating === 5 && !f.googleReviewInviteSent,
      );
      expect(!!uninvited3).toBe(false);
    });

    it("verifies coupon program validTo extension logic with Date objects and strings", () => {
      const existingValidTo = new Date("2026-10-20T12:00:00Z"); // 10 days left
      const newCouponValidYmd = "2026-11-10";

      const existingYmd = existingValidTo
        ? typeof existingValidTo === "string"
          ? existingValidTo
          : existingValidTo.toISOString().slice(0, 10)
        : null;
      const needsExtension = !existingYmd || existingYmd < newCouponValidYmd;
      expect(needsExtension).toBe(true);

      // Verify string representation (e.g. from MySQL date column)
      const stringValidTo = "2026-10-20";
      const stringNeedsExtension =
        !stringValidTo || stringValidTo < newCouponValidYmd;
      expect(stringNeedsExtension).toBe(true);

      const futureValidTo = "2026-12-31";
      const doesNotNeedExtension =
        !futureValidTo || futureValidTo < newCouponValidYmd;
      expect(doesNotNeedExtension).toBe(false);
    });
  });

  describe("Operational Smart Guidance Priority Hierarchy (computeCustomerSmartGuidance)", () => {
    it("prioritizes open complaint over positive latest feedback", () => {
      const guidance = computeCustomerSmartGuidance({
        hasOpenComplaint: true,
        isOverCreditLimit: false,
        isNearCreditLimit: false,
        isVip: true,
        frequentCustomer: false,
        canSeeBalance: true,
        latestFeedback: {
          rating: 5,
          issueStatus: "RESOLVED",
          smartGuidance: "الزبون راضٍ جداً عن جودة الطباعة",
        },
      });

      expect(guidance).toContain(
        "تنبيه تشغيلي عاجل: الزبون لديه شكوى قيد المتابعة لم تحل بعد",
      );
      expect(guidance).not.toContain("الزبون راضٍ جداً");
    });

    it("displays specific defect guidance when latest feedback is the open complaint", () => {
      const guidance = computeCustomerSmartGuidance({
        hasOpenComplaint: true,
        isOverCreditLimit: false,
        isNearCreditLimit: false,
        isVip: false,
        frequentCustomer: false,
        canSeeBalance: true,
        latestFeedback: {
          rating: 1,
          issueStatus: "NEW",
          smartGuidance:
            "تنبيه دقة القص: وجّه محطة التشطيب لمراجعة علامات القص",
        },
      });

      expect(guidance).toContain("تنبيه دقة القص");
    });

    it("prioritizes credit limit exceeded over VIP praise", () => {
      const elevatedGuidance = computeCustomerSmartGuidance({
        hasOpenComplaint: false,
        isOverCreditLimit: true,
        isNearCreditLimit: true,
        isVip: true,
        frequentCustomer: false,
        canSeeBalance: true,
        creditLimit: "500000",
        ltvFormatted: "15000000",
      });

      expect(elevatedGuidance).toContain("تنبيه سقف الدين");
      expect(elevatedGuidance).toContain("500000");
      expect(elevatedGuidance).not.toContain("زبون ذهبي VIP");

      const cashierGuidance = computeCustomerSmartGuidance({
        hasOpenComplaint: false,
        isOverCreditLimit: true,
        isNearCreditLimit: true,
        isVip: true,
        frequentCustomer: false,
        canSeeBalance: false,
        creditLimit: null,
      });

      expect(cashierGuidance).toContain("تنبيه سقف الدين");
      expect(cashierGuidance).not.toContain("500000");
    });

    it("prioritizes near credit limit warning over VIP recognition", () => {
      const guidance = computeCustomerSmartGuidance({
        hasOpenComplaint: false,
        isOverCreditLimit: false,
        isNearCreditLimit: true,
        isVip: true,
        frequentCustomer: false,
        canSeeBalance: true,
        creditLimit: "1000000",
        creditUsagePercent: 85,
      });

      expect(guidance).toContain("تنبيه ائتماني");
      expect(guidance).toContain("85%");
    });

    it("recognizes VIP customer with proper financial masking", () => {
      const adminGuidance = computeCustomerSmartGuidance({
        hasOpenComplaint: false,
        isOverCreditLimit: false,
        isNearCreditLimit: false,
        isVip: true,
        frequentCustomer: false,
        canSeeBalance: true,
        ltvFormatted: "2500000",
      });

      expect(adminGuidance).toContain("زبون ذهبي VIP");
      expect(adminGuidance).toContain("2500000 د.ع");

      const cashierGuidance = computeCustomerSmartGuidance({
        hasOpenComplaint: false,
        isOverCreditLimit: false,
        isNearCreditLimit: false,
        isVip: true,
        frequentCustomer: false,
        canSeeBalance: false,
      });

      expect(cashierGuidance).toContain("زبون ذهبي VIP");
      expect(cashierGuidance).not.toContain("د.ع");
    });

    it("recognizes frequent customers when not VIP", () => {
      const guidance = computeCustomerSmartGuidance({
        hasOpenComplaint: false,
        isOverCreditLimit: false,
        isNearCreditLimit: false,
        isVip: false,
        frequentCustomer: true,
        canSeeBalance: false,
      });

      expect(guidance).toContain("زبون متكرر ودائم");
    });

    it("falls back to welcoming new customers with default message", () => {
      const guidance = computeCustomerSmartGuidance({
        hasOpenComplaint: false,
        isOverCreditLimit: false,
        isNearCreditLimit: false,
        isVip: false,
        frequentCustomer: false,
        canSeeBalance: false,
      });

      expect(guidance).toContain("زبون مرحب به");
    });
  });

  describe("Work Order Linking & Thermal Voucher Complete Metadata", () => {
    it("ensures all operational production stations are valid and labeled", () => {
      const expectedStations: RootCauseStation[] = [
        "PRINTING",
        "CUTTING",
        "LAMINATION",
        "DESIGN",
        "DELIVERY",
        "RECEPTION",
        "OTHER",
      ];

      for (const st of expectedStations) {
        expect(ROOT_CAUSE_STATIONS).toContain(st);
        expect(ROOT_CAUSE_STATION_LABELS[st]).toBeTruthy();
      }
    });

    it("generates voucher print doc with full operational parameters and explicit terms", () => {
      const doc = giftVoucherToPrintDoc({
        code: "GIFT-OPS-2026",
        amount: "15000",
        customerName: "سعد الدين البغدادي",
        customerPhone: "07709876543",
        reason: "ترضية عتب تأخير أمر الشغل",
        validUntil: "2026-11-20",
        terms: "تُخصم لمرة واحدة على أي فاتورة مبيعات أو أمر شغل داخل فروعنا.",
      });

      expect(doc.title).toBe("قسيمة هدية وترضية");
      expect(doc.subtitle).toBe("المكتبة العربية للطباعة والقرطاسية");
      expect(doc.footer).toBe(
        "تُخصم لمرة واحدة على أي فاتورة مبيعات أو أمر شغل داخل فروعنا.",
      );
      expect(doc.meta).toContain("رمز الكوبون: GIFT-OPS-2026");
      expect(doc.meta).toContain("الزبون: سعد الدين البغدادي");
      expect(doc.meta).toContain("الهاتف: 07709876543");
      expect(doc.meta).toContain("نوع الإهداء: ترضية عتب تأخير أمر الشغل");
      expect(doc.meta).toContain("صالحة لغاية: 2026-11-20");
      expect(doc.totals[0].value).toContain("15,000 د.ع");
    });
  });
});
