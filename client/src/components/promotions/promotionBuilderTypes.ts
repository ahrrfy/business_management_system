/**
 * أنواع وبيانات المحرر المرئي الموحد للعروض والكوبونات (Milestone M2 & M3)
 * يضمن التوافق التام مع مخطط الطفرة crm.coupons.createUnified وحراس النظام.
 */

export type PromotionDiscountType = "PERCENT" | "AMOUNT";
export type PromotionScope = "ALL" | "CATEGORIES" | "PRODUCTS";

/**
 * الأنماط الترويجية المتخصصة:
 * - COUPON_BATCH: حملة كوبونات عامة مع توليد دفعات متعددة وتصدير PDF بطاقات 54×84 مم.
 * - AFFILIATE: كوبون شركاء ومؤثرين بالعمولة (رمز مخصص ونسبة عمولة وتتبع أداء).
 * - BOUNCE_BACK: كوبون عودة تلقائي يصدر ويُطبع مع فواتير الكاشير عند بلوغ سقف الشراء.
 * - FIRST_ORDER: كوبون ترحيبي للطلب الأول (إصدار ذاتي للعميل الموثق فقط).
 * - DIRECT_PROMO: عرض خصم مالي مباشر بدون كود (تطبيق آلي على الفاتورة في الكاشير والمتجر).
 */
export type PromotionArchetype =
  | "COUPON_BATCH"
  | "AFFILIATE"
  | "BOUNCE_BACK"
  | "FIRST_ORDER"
  | "DIRECT_PROMO";

export interface PromotionFormData {
  archetype: PromotionArchetype;
  name: string;
  description: string;
  codePrefix: string;
  sampleCode: string;
  type: PromotionDiscountType;
  discountPercent: string;
  discountAmount: string;
  maxDiscountAmount: string;
  minOrderSpend: string;
  freeShipping: boolean;
  shippingDiscountAmount: string;
  scope: PromotionScope;
  targetCategoryIds: number[];
  targetProductIds: number[];
  validFrom: string;
  validTo: string;
  perCouponLimit: number;
  perCustomerLimit: number;
  isFirstOrderSelfService: boolean;
  initialBatchCount: number;
  customCodesList: string;
  exportPdfOnCreate: boolean;
  affiliateName: string;
  affiliatePhone: string;
  affiliateCommissionRate: string;
  activeDays: number[];
  isAutoBounceBack: boolean;
  autoBounceBackMinInvoice: string;
  bounceBackValidityDays: number;
  bounceBackPrefix: string;
  bounceBackHeadline: string;
  design: {
    title: string;
    subtitle: string;
    terms: string;
    color: string;
  };
  campaignId: number | null;
}

export function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export const INITIAL_PROMOTION_FORM_DATA: PromotionFormData = {
  archetype: "COUPON_BATCH",
  name: "عرض ترويجي خاص",
  description: "",
  codePrefix: "VIP",
  sampleCode: "VIP-2026",
  type: "PERCENT",
  discountPercent: "15",
  discountAmount: "10000",
  maxDiscountAmount: "25000",
  minOrderSpend: "50000",
  freeShipping: false,
  shippingDiscountAmount: "0",
  scope: "ALL",
  targetCategoryIds: [],
  targetProductIds: [],
  validFrom: todayYmd(),
  validTo: "",
  perCouponLimit: 1,
  perCustomerLimit: 1,
  isFirstOrderSelfService: false,
  initialBatchCount: 20,
  customCodesList: "",
  exportPdfOnCreate: true,
  affiliateName: "",
  affiliatePhone: "",
  affiliateCommissionRate: "5.00",
  activeDays: [0, 1, 2, 3, 4, 5, 6],
  isAutoBounceBack: false,
  autoBounceBackMinInvoice: "50000",
  bounceBackValidityDays: 14,
  bounceBackPrefix: "NEXT",
  bounceBackHeadline: "قسيمة هدية لزيارتك القادمة",
  design: {
    title: "عرض ترويجي حصري",
    subtitle: "تسوق الآن واستفد من التوفير الفوري",
    terms: "يُستخدم لمرة واحدة · لا يُجمع مع أسعار تعاقدية أو عروض أخرى",
    color: "#0D6B52",
  },
  campaignId: null,
};

export interface FormValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function validatePromotionFormData(data: PromotionFormData): FormValidationResult {
  const errors: Record<string, string> = {};

  if (!data.name.trim() || data.name.trim().length < 2) {
    errors.name = "اسم العرض والبرنامج إلزامي (حرفان على الأقل)";
  }

  // إذا لم يكن العرض خصماً مباشراً تلقائياً، يلزم تحديد بادئة الرمز
  if (data.archetype !== "DIRECT_PROMO") {
    if (!data.codePrefix.trim()) {
      errors.codePrefix = "بادئة الكود مطلوبة (مثل VIP أو CRM)";
    }
  }

  if (!data.validFrom) {
    errors.validFrom = "تاريخ بدء الصلاحية إلزامي";
  }

  if (data.validTo && data.validTo < data.validFrom) {
    errors.validTo = "تاريخ نهاية الصلاحية لا يمكن أن يسبق تاريخ البداية";
  }

  if (data.type === "PERCENT") {
    const pct = parseFloat(data.discountPercent);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      errors.discountPercent = "نسبة الخصم يجب أن تكون بين 0.01٪ و 100٪";
    }
    if (data.archetype !== "DIRECT_PROMO") {
      const cap = parseFloat(data.maxDiscountAmount);
      if (isNaN(cap) || cap <= 0) {
        errors.maxDiscountAmount = "سقف الخصم الأقصى بالدينار إلزامي لمنع الخسائر غير المتوقعة";
      }
    }
  } else {
    const amt = parseFloat(data.discountAmount);
    if (isNaN(amt) || amt <= 0) {
      errors.discountAmount = "مبلغ الخصم بالدينار العراقي إلزامي ويجب أن يكون أكبر من صفر";
    }
  }

  if (data.archetype !== "DIRECT_PROMO") {
    const minSpend = parseFloat(data.minOrderSpend);
    if (isNaN(minSpend) || minSpend < 0) {
      errors.minOrderSpend = "الحد الأدنى لقيمة الفاتورة لا يمكن أن يكون سالباً";
    }
  }

  // التحقق من صحة وعدم تكرار الأكواد المخصصة
  if (data.customCodesList.trim()) {
    const rawLines = data.customCodesList
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const invalidLines = rawLines.filter((l) => !/^[A-Za-z0-9-]+$/.test(l));
    if (invalidLines.length > 0) {
      errors.customCodesList = `تحتوي الأكواد على محارف غير صالحة (يُسمح فقط بالحروف الإنجليزية والأرقام والشرطة): ${invalidLines.slice(0, 3).join(", ")}`;
    } else {
      const normalized = rawLines.map((s) => s.toUpperCase());
      const duplicates = normalized.filter((code, idx) => normalized.indexOf(code) !== idx);
      if (duplicates.length > 0) {
        errors.customCodesList = `يوجد تكرار في الأكواد المدخلة: ${Array.from(new Set(duplicates)).slice(0, 3).join(", ")}`;
      }
    }
  }

  // فحوصات نمط المؤثرين
  if (data.archetype === "AFFILIATE") {
    if (!data.affiliateName.trim()) {
      errors.affiliateName = "اسم المسوق أو الشريك الترويجي إلزامي";
    }
    const rate = parseFloat(data.affiliateCommissionRate);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      errors.affiliateCommissionRate = "نسبة عمولة المسوق يجب أن تكون بين 0٪ و 100٪";
    }
  }

  // فحوصات نمط كوبون العودة
  if (data.archetype === "BOUNCE_BACK") {
    const minInv = parseFloat(data.autoBounceBackMinInvoice);
    if (isNaN(minInv) || minInv <= 0) {
      errors.autoBounceBackMinInvoice = "حدد الحد الأدنى لقيمة الفاتورة لتفعيل كوبون العودة التلقائي";
    }
    if (!data.bounceBackPrefix.trim()) {
      errors.bounceBackPrefix = "بادئة رمز كوبون العودة مطلوبة (مثل NEXT)";
    }
  }

  // فحوصات التوليد المتعدد
  if (data.archetype === "COUPON_BATCH") {
    if (data.initialBatchCount < 0 || data.initialBatchCount > 500) {
      errors.initialBatchCount = "عدد الكوبونات للإصدار المباشر يجب أن يكون بين 0 و 500";
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}
