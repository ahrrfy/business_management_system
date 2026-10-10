/**
 * أنواع وبيانات المحرر المرئي الموحد للعروض والكوبونات (Milestone M2 & M3)
 * يضمن التوافق التام مع مخطط الطفرة crm.coupons.createUnified وحراس النظام.
 */

export type PromotionDiscountType = "PERCENT" | "AMOUNT";
export type PromotionScope = "ALL" | "CATEGORIES" | "PRODUCTS";

export interface PromotionFormData {
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
  affiliateName: string;
  affiliatePhone: string;
  affiliateCommissionRate: string;
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
  affiliateName: "",
  affiliatePhone: "",
  affiliateCommissionRate: "0.00",
  design: {
    title: "هدية خاصة لك",
    subtitle: "خصم ترويجي مميز لعملائنا الكرام",
    terms: "يُستخدم لمرة واحدة ولا يُجمع مع أسعار تعاقدية أو عروض أخرى",
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

  if (!data.codePrefix.trim()) {
    errors.codePrefix = "بادئة الكود مطلوبة (مثل VIP أو CRM)";
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
    const cap = parseFloat(data.maxDiscountAmount);
    if (isNaN(cap) || cap <= 0) {
      errors.maxDiscountAmount = "سقف الخصم الأقصى بالدينار إلزامي لمنع الخسائر غير المتوقعة";
    }
  } else {
    const amt = parseFloat(data.discountAmount);
    if (isNaN(amt) || amt <= 0) {
      errors.discountAmount = "مبلغ الخصم بالدينار العراقي إلزامي ويجب أن يكون أكبر من صفر";
    }
  }

  const minSpend = parseFloat(data.minOrderSpend);
  if (isNaN(minSpend) || minSpend < 0) {
    errors.minOrderSpend = "الحد الأدنى لقيمة الفاتورة لا يمكن أن يكون سالباً";
  }

  if (data.affiliateName.trim() && !data.affiliateCommissionRate.trim()) {
    errors.affiliateCommissionRate = "حدد نسبة العمولة عند إضافة مسوق";
  }

  if (data.affiliateCommissionRate.trim()) {
    const rate = parseFloat(data.affiliateCommissionRate);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      errors.affiliateCommissionRate = "نسبة عمولة المسوق يجب أن تكون بين 0٪ و 100٪";
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}
