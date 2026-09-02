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
