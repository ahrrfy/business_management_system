import { describe, expect, it } from "vitest";
import {
  goodsReceiptReversalTrigger,
  purchaseChargeControlTrigger,
  purchaseIntegrityResolutionTrigger,
  purchaseOrderControlTrigger,
  purchaseRequisitionControlTrigger,
  purchaseReturnReversalTrigger,
  purchaseReturnTrigger,
  supplierInvoiceApprovalTrigger,
  supplierPaymentRefundTrigger,
  supplierPaymentTrigger,
  cashVarianceApprovalRetainsLegacy,
  cashVarianceApprovalTrigger,
  voucherApprovalRetainsLegacy,
  voucherApprovalTrigger,
  costRevaluationApprovalTrigger,
  stockAdjustmentApprovalTrigger,
} from "./approvalTriggers";

/**
 * كلُّ تأكيدٍ هنا يحرس **ضابطاً ماليّاً**، لا صياغةَ دالّة. وقلبُه ثلاثةُ ثوابت:
 *   ١) الرفضُ حرٌّ في كل المسارات — لا يكتب شيئاً ماليّاً.
 *   ٢) الاعتماد يحمل تصنيفه، والتصنيفُ ثبت بتفنيدٍ عدائيّ لا بالتخمين.
 *   ٣) الفعلُ لا الإجراء: `decideControl` بلا بوّابةٍ عند الاعتماد وببوّابةٍ عند الإلغاء.
 */
describe("أمر الشراء — الفعلُ لا الإجراء", () => {
  it("اعتمادُ المراجعة لا بوّابةَ له — إنشاءُ التزامٍ تعاقديّ لا مالٌ ولا محو", () => {
    expect(purchaseOrderControlTrigger("APPROVE_REVISION", true)).toBeNull();
  });

  it("الاستثناءُ الطارئ لا بوّابةَ له — لا يُكتب على أمر الشراء أصلاً", () => {
    expect(purchaseOrderControlTrigger("EMERGENCY_ORDER", true)).toBeNull();
  });

  it("⭐ إلغاءُ الأمر مُبوَّبٌ بالاتّجاه الآمن — لا بسبب توقيع الجرد", () => {
    // سببُ «محو توقيع الجرد» **سقط بتحقيقٍ مخصَّص**: الإبطال ضابطٌ مقصودٌ لا ثغرة، ويقع
    // أيضاً من `createOrder`/`updateOrder` بلا مُعتمِدٍ ثانٍ. الباقي: الإلغاء يُدرج صفوفاً
    // في وعاء تقييم جردٍ نشط ويُحرّر حجوزات الطلب ⇒ يُبوَّب تحفّظاً، وإسقاطُه قرارُ مالك.
    expect(purchaseOrderControlTrigger("CANCEL_ORDER", true)).toBe("ERASE_EFFECT");
  });

  it("والرفضُ حرٌّ في الأنواع الثلاثة", () => {
    for (const kind of ["APPROVE_REVISION", "CANCEL_ORDER", "EMERGENCY_ORDER"] as const) {
      expect(purchaseOrderControlTrigger(kind, false), kind).toBeNull();
    }
  });
});

describe("خروجُ المال — ثلاثةُ مسارات أثبت التفنيد أنّها تُنقص الدرج فعلاً", () => {
  it("سدادُ المورّد", () => {
    expect(supplierPaymentTrigger("APPROVE")).toBe("MONEY_OUT");
  });
  it("مصاريف الشراء", () => {
    expect(purchaseChargeControlTrigger("APPROVE")).toBe("MONEY_OUT");
  });
  it("عكسُ مرتجع الشراء", () => {
    expect(purchaseReturnReversalTrigger("APPROVE")).toBe("MONEY_OUT");
  });
});

describe("محوُ الأثر — أربعةُ مسارات تعكس قيداً منشوراً أو تُخرج مخزوناً", () => {
  it("عكسُ الاستلام — applyMovement بـOUT + قيدٌ عكسيّ لـGRNI", () => {
    expect(goodsReceiptReversalTrigger("APPROVE")).toBe("ERASE_EFFECT");
  });
  it("عكسُ فاتورة المورّد — الكاتبُ الوحيد للحالة REVERSED", () => {
    expect(supplierInvoiceApprovalTrigger("REVERSE_INVOICE", "APPROVE")).toBe("ERASE_EFFECT");
  });
  it("مرتجعُ الشراء", () => {
    expect(purchaseReturnTrigger("APPROVE")).toBe("ERASE_EFFECT");
  });
  it("استردادُ سدادٍ — عكسٌ جبريٌّ سطراً بسطر", () => {
    expect(supplierPaymentRefundTrigger("APPROVE")).toBe("ERASE_EFFECT");
  });
});

describe("ما لا بوّابةَ له — والفارقُ الذي يجعل الشراء الطبيعيّ باعتمادٍ واحد", () => {
  it("ترحيلُ فاتورة المورّد: ذمّةٌ جديدة لا مالٌ خارج ولا أثرٌ يُمحى", () => {
    expect(supplierInvoiceApprovalTrigger("POST_INVOICE", "APPROVE")).toBeNull();
  });

  it("طلبُ الشراء الداخليّ: الوحيدُ الذي صمد تصنيفُه بلا تفنيد", () => {
    expect(purchaseRequisitionControlTrigger()).toBeNull();
  });

  it("حالاتُ السلامة: حالةٌ وحدثُ تدقيق فقط", () => {
    expect(purchaseIntegrityResolutionTrigger()).toBeNull();
  });
});

describe("الثابت العامّ: الرفضُ حرٌّ في كل مسارات المشتريات", () => {
  it("لا مسارَ يحجب الرفض", () => {
    expect(goodsReceiptReversalTrigger("REJECT")).toBeNull();
    expect(supplierInvoiceApprovalTrigger("REVERSE_INVOICE", "REJECT")).toBeNull();
    expect(supplierInvoiceApprovalTrigger("POST_INVOICE", "REJECT")).toBeNull();
    expect(purchaseReturnTrigger("REJECT")).toBeNull();
    expect(purchaseReturnReversalTrigger("REJECT")).toBeNull();
    expect(purchaseChargeControlTrigger("REJECT")).toBeNull();
    expect(supplierPaymentTrigger("REJECT")).toBeNull();
    expect(supplierPaymentRefundTrigger("REJECT")).toBeNull();
  });
});

describe("مسارُ الشراء الطبيعيّ — اعتمادٌ واحدٌ من المالك لا خمسةُ أشخاص", () => {
  it("إنشاء ⇒ اعتماد الأمر ⇒ استلام ⇒ ترحيل الفاتورة: صفرُ بوّابات", () => {
    expect(purchaseRequisitionControlTrigger()).toBeNull();
    expect(purchaseOrderControlTrigger("APPROVE_REVISION", true)).toBeNull();
    // الاستلامُ نفسه ليس بوّابةً أصلاً — المُبوَّب هو عكسُه.
    expect(supplierInvoiceApprovalTrigger("POST_INVOICE", "APPROVE")).toBeNull();
  });

  it("والسدادُ وحده يفتح البوّابة", () => {
    expect(supplierPaymentTrigger("APPROVE")).toBe("MONEY_OUT");
  });
});

describe("الخزينة والسندات — الفعلُ لا الإجراء، والضابطُ المُستبقى بقرار مالك", () => {
  it("صرفُ سندٍ خروجُ مال — حارسُ توفّرٍ ثمّ إيصالٌ بـcashBucket", () => {
    expect(voucherApprovalTrigger("OUT", null)).toBe("MONEY_OUT");
    // ونوعُ الطلب النظاميّ لا يُخفّف خروج المال.
    expect(voucherApprovalTrigger("OUT", "VOUCHER_CANCELLATION")).toBe("MONEY_OUT");
  });

  it("قبضٌ يعكس مستنداً قائماً محوُ أثر — لا قبضٌ عاديّ", () => {
    expect(voucherApprovalTrigger("IN", "VOUCHER_CANCELLATION")).toBe("ERASE_EFFECT");
    expect(voucherApprovalTrigger("IN", "ACCRUAL_CORRECTION_REFUND")).toBe("ERASE_EFFECT");
  });

  it("⭐ سندُ القبض العاديّ تصنيفُه null — والمالك أبقى ضابطَه (٢/٩/٢٦)", () => {
    // القاعدةُ تقول «لا بوّابة»، والواقعُ أنّه الضابط الوحيد على نقدٍ مجهول المصدر يدخل
    // الخزينة. الحلُّ ليس مُطلِقاً ثالثاً بل استبقاءُ الضابط القائم كما هو.
    expect(voucherApprovalTrigger("IN", null)).toBeNull();
    expect(voucherApprovalRetainsLegacy("IN", null)).toBe(true);
  });

  it("والاستبقاءُ لا يمسّ ما له مُطلِقٌ أصلاً — فلا يُزدوج الضابط", () => {
    expect(voucherApprovalRetainsLegacy("OUT", null)).toBe(false);
    expect(voucherApprovalRetainsLegacy("IN", "VOUCHER_CANCELLATION")).toBe(false);
    expect(voucherApprovalRetainsLegacy("IN", "ACCRUAL_CORRECTION_REFUND")).toBe(false);
  });

  it("عجزُ النقد خروجُ مال، وزيادتُه إنشاءُ قيدٍ لا عكسُه", () => {
    expect(cashVarianceApprovalTrigger("SHORTAGE", "APPROVE")).toBe("MONEY_OUT");
    expect(cashVarianceApprovalTrigger("SURPLUS", "APPROVE")).toBeNull();
  });

  it("والزيادةُ نظيرُ سند القبض ⇒ ضابطُها مُستبقًى حتى يحسمها المالك", () => {
    expect(cashVarianceApprovalRetainsLegacy("SURPLUS", "APPROVE")).toBe(true);
    expect(cashVarianceApprovalRetainsLegacy("SHORTAGE", "APPROVE")).toBe(false);
  });

  it("والرفضُ حرٌّ هنا أيضاً — ولا ضابطَ يُستبقى عليه", () => {
    expect(cashVarianceApprovalTrigger("SHORTAGE", "REJECT")).toBeNull();
    expect(cashVarianceApprovalTrigger("SURPLUS", "REJECT")).toBeNull();
    expect(cashVarianceApprovalRetainsLegacy("SURPLUS", "REJECT")).toBe(false);
  });
});

describe("المخزون — مساران يُصنّفهما العقد ووُصلا بالبوّابة (PR #954)", () => {
  it("اعتمادُ تسوية المخزون محوُ أثر — حركةٌ على رصيدٍ قائم وقيدُ ADJUST", () => {
    expect(stockAdjustmentApprovalTrigger("APPROVE")).toBe("ERASE_EFFECT");
  });

  it("واعتمادُ إعادة تقييم التكلفة كذلك — تُغيّر القيمة الدفترية لمخزونٍ قائم", () => {
    expect(costRevaluationApprovalTrigger("APPROVE")).toBe("ERASE_EFFECT");
  });

  it("والرفضُ حرٌّ فيهما — حالةٌ وأثرُ تدقيقٍ بلا حركةٍ ولا قيد", () => {
    expect(stockAdjustmentApprovalTrigger("REJECT")).toBeNull();
    expect(costRevaluationApprovalTrigger("REJECT")).toBeNull();
  });
});
