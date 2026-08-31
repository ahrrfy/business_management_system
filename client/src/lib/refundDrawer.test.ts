import { describe, expect, it } from "vitest";
import {
  drawerShortfallWarning,
  eligibleRefundDrawers,
  pickDefaultRefundDrawer,
  refundDrawerBlockReason,
  refundExitsCashDrawer,
  serverAnsweredDeterministically,
  workOrderCancelNeedsCashDrawer,
  type RefundDrawerOption,
} from "./refundDrawer";

const drawer = (over: Partial<RefundDrawerOption> & { shiftId: number }): RefundDrawerOption => ({
  userId: 10,
  userName: "كاشير",
  shiftType: "RECEPTION",
  ...over,
});

describe("eligibleRefundDrawers — الرافدان ليسا واحداً", () => {
  const mixed = [
    drawer({ shiftId: 1, shiftType: "RECEPTION" }),
    drawer({ shiftId: 2, shiftType: "POS" }),
    drawer({ shiftId: 3, shiftType: "RECEPTION" }),
  ];

  it("مسارُ أمر الشغل يقصر على RECEPTION — درجُ POS لا يُعرَض أصلاً", () => {
    // لو عُرِض لأعاد الخادمُ نفسَ رسالة الرفض بعد الاختيار (بابٌ مسدودٌ يرتدي ثوب الحلّ).
    expect(eligibleRefundDrawers(mixed, "RECEPTION").map((d) => d.shiftId)).toEqual([1, 3]);
  });

  it("مسارُ التوصيل يقبل أيّ درجٍ مفتوح", () => {
    expect(eligibleRefundDrawers(mixed, null).map((d) => d.shiftId)).toEqual([1, 2, 3]);
  });

  it("لا نوعَ مطابقاً ⇒ قائمةٌ فارغة لا تسرُّبَ فيها", () => {
    expect(eligibleRefundDrawers(mixed, "WAREHOUSE")).toEqual([]);
  });
});

describe("pickDefaultRefundDrawer — درجُ المنفّذ ثمّ الوحيد ثمّ لا تخمين", () => {
  it("درجُ المنفّذ مفتوحٌ ⇒ يُختار هو ولو تعدّدت الأدراج (قرار المالك)", () => {
    const drawers = [
      drawer({ shiftId: 7, userId: 99, userName: "المديرة" }),
      drawer({ shiftId: 8, userId: 42, userName: "نور" }),
    ];
    expect(pickDefaultRefundDrawer(drawers, 42)).toBe(8);
  });

  it("درجٌ واحدٌ فقط ⇒ يُختار ولو لم يكن للمنفّذ", () => {
    expect(pickDefaultRefundDrawer([drawer({ shiftId: 5, userId: 99 })], 42)).toBe(5);
  });

  it("تعدّدٌ بلا درجٍ للمنفّذ ⇒ null: لا نسبةَ نقدٍ لدرجٍ لم يخرج منه", () => {
    const drawers = [drawer({ shiftId: 1, userId: 98 }), drawer({ shiftId: 2, userId: 99 })];
    expect(pickDefaultRefundDrawer(drawers, 42)).toBeNull();
  });

  it("لا أدراجَ ⇒ null", () => {
    expect(pickDefaultRefundDrawer([], 42)).toBeNull();
  });

  it("هويّةُ المنفّذ غائبة ⇒ يسقط للوحيد ولا ينهار", () => {
    expect(pickDefaultRefundDrawer([drawer({ shiftId: 5 })], undefined)).toBe(5);
    expect(pickDefaultRefundDrawer([drawer({ shiftId: 5 }), drawer({ shiftId: 6 })], null)).toBeNull();
  });
});

describe("refundDrawerBlockReason — الحجبُ يسبق الرفض", () => {
  const two = [drawer({ shiftId: 1, userId: 98 }), drawer({ shiftId: 2, userId: 99 })];

  it("لا نقدَ يخرج ⇒ لا حجبَ إطلاقاً ولو تعدّد الدرج", () => {
    // شاشةٌ تطلب درجاً لردّ نقدٍ لم يُقبض = بلاغُ ReturnComposer السابق حرفياً.
    expect(refundDrawerBlockReason({ needed: false, drawers: two, selectedShiftId: null, emptyLabel: "وردية استقبال" })).toBeNull();
  });

  it("لا أدراجَ مفتوحة ⇒ رسالةٌ تقول ما يُفعَل لا «تعذّر»", () => {
    const reason = refundDrawerBlockReason({ needed: true, drawers: [], selectedShiftId: null, emptyLabel: "وردية استقبال" });
    expect(reason).toContain("وردية استقبال");
    expect(reason).toContain("افتح ورديةً أولاً");
  });

  it("تعدّدٌ بلا اختيار ⇒ يُحجَب بنصٍّ صريح", () => {
    expect(refundDrawerBlockReason({ needed: true, drawers: two, selectedShiftId: null, emptyLabel: "وردية استقبال" }))
      .toBe("حدّد الدرج الذي سيخرج منه النقد فعلياً.");
  });

  it("اختيارٌ صالح ⇒ لا حجب", () => {
    expect(refundDrawerBlockReason({ needed: true, drawers: two, selectedShiftId: 2, emptyLabel: "وردية استقبال" })).toBeNull();
  });

  it("الدرجُ المختار أُغلق بين التحميل والضغط ⇒ يُحجَب بدل إرسالٍ يُرفَض", () => {
    expect(refundDrawerBlockReason({ needed: true, drawers: two, selectedShiftId: 77, emptyLabel: "وردية استقبال" }))
      .toContain("لم يعد مفتوحاً");
  });
});

describe("drawerShortfallWarning — تحذيرٌ لا حجب، ولا تخمينَ بلا رقم", () => {
  const drawers = [
    drawer({ shiftId: 1, userName: "المدير", expectedCash: "570000.00" }),
    drawer({ shiftId: 2, userName: "نور", expectedCash: "30000.00" }),
  ];

  it("الدرجُ يغطّي المبلغ ⇒ لا تحذير", () => {
    expect(drawerShortfallWarning({ drawers, selectedShiftId: 1, estimatedAmount: "70000" })).toBeNull();
  });

  it("الدرجُ لا يغطّي ⇒ تحذيرٌ بالرقمين", () => {
    const w = drawerShortfallWarning({ drawers, selectedShiftId: 2, estimatedAmount: "70000" });
    expect(w).toEqual({ shiftId: 2, availableCash: "30000.00", needed: "70000" });
  });

  it("بلا اختيارٍ ⇒ لا تحذير (لا درجَ يُقاس عليه)", () => {
    expect(drawerShortfallWarning({ drawers, selectedShiftId: null, estimatedAmount: "70000" })).toBeNull();
  });

  /**
   * ⭐ السلوكُ الذي يعتمد عليه مسارُ **استرجاع التسليم**: الشاشةُ لا تعرف الشقّ النقديّ من
   * `invoicePaidAmount` (قد يكون نصفُه بطاقة)، فتُمرّر `null`. تحذيرٌ على رقمٍ مجهول يُطالب
   * الكاشير بتمويل درجٍ لمالٍ لن يخرج منه — إسقاطُه أصدقُ من تخمينه.
   */
  it("⭐ تقديرٌ غائب/صفر/معطوب ⇒ لا تحذير إطلاقاً", () => {
    expect(drawerShortfallWarning({ drawers, selectedShiftId: 2, estimatedAmount: null })).toBeNull();
    expect(drawerShortfallWarning({ drawers, selectedShiftId: 2, estimatedAmount: "0" })).toBeNull();
    expect(drawerShortfallWarning({ drawers, selectedShiftId: 2, estimatedAmount: "" })).toBeNull();
    expect(drawerShortfallWarning({ drawers, selectedShiftId: 2, estimatedAmount: "abc" })).toBeNull();
  });

  it("درجٌ بلا `expectedCash` معلوم ⇒ لا تحذير (لا نُنذر بما لا نعرف)", () => {
    const unknown = [drawer({ shiftId: 9, expectedCash: null })];
    expect(drawerShortfallWarning({ drawers: unknown, selectedShiftId: 9, estimatedAmount: "70000" })).toBeNull();
  });
});

describe("refundExitsCashDrawer — رصيدُ زين يخرج نقداً", () => {
  it("النقدُ ورصيدُ زين ⇒ درجٌ نقديّ", () => {
    expect(refundExitsCashDrawer("CASH")).toBe(true);
    // TELECOM بلا سكّة ردّ ⇒ يُردّ نقداً؛ إغفالُه يُخفي المنتقي عن حالةٍ تحتاجه.
    expect(refundExitsCashDrawer("TELECOM")).toBe(true);
  });

  it("البطاقةُ والتحويلُ والمحفظة ⇒ لا درج (cashBucket = NULL)", () => {
    expect(refundExitsCashDrawer("CARD")).toBe(false);
    expect(refundExitsCashDrawer("TRANSFER")).toBe(false);
    expect(refundExitsCashDrawer("WALLET")).toBe(false);
    expect(refundExitsCashDrawer(null)).toBe(false);
    expect(refundExitsCashDrawer(undefined)).toBe(false);
  });
});

describe("workOrderCancelNeedsCashDrawer — ثلاثةُ روافدَ تُخرج نقداً", () => {
  it("عربونٌ نقديّ ⇒ يلزم درج (حالةُ البلاغ: ٧٠٬٠٠٠ نقداً)", () => {
    expect(workOrderCancelNeedsCashDrawer({ deposit: "70000.00", paymentMethod: "CASH", deliveryFeeHeldNet: "0" })).toBe(true);
  });

  it("عربونُ بطاقةٍ بلا أمانة ⇒ لا درجَ ولا منتقٍ يُربك", () => {
    expect(workOrderCancelNeedsCashDrawer({ deposit: "70000.00", paymentMethod: "CARD", deliveryFeeHeldNet: "0" })).toBe(false);
  });

  it("⭐ عربونُ بطاقةٍ + أمانةُ أجرةِ توصيلٍ نقديّة ⇒ يلزم درجٌ رغم أنّ «طريقة دفع العربون» ليست نقداً", () => {
    expect(workOrderCancelNeedsCashDrawer({ deposit: "50000", paymentMethod: "CARD", deliveryFeeHeldNet: "5000" })).toBe(true);
  });

  it("بلا عربونٍ ولا أمانة ⇒ لا درج", () => {
    expect(workOrderCancelNeedsCashDrawer({ deposit: "0.00", paymentMethod: "CASH", deliveryFeeHeldNet: "0.00" })).toBe(false);
    expect(workOrderCancelNeedsCashDrawer({ deposit: null, paymentMethod: null, deliveryFeeHeldNet: null })).toBe(false);
    expect(workOrderCancelNeedsCashDrawer({ deposit: "", paymentMethod: "CASH", deliveryFeeHeldNet: "" })).toBe(false);
  });

  it("قيمٌ معطوبة لا تُشعل المنتقي كذباً", () => {
    expect(workOrderCancelNeedsCashDrawer({ deposit: "abc", paymentMethod: "CASH", deliveryFeeHeldNet: null })).toBe(false);
  });
});

describe("⏳ الإرجاع بعد أيّام — الوردية الأصلية مُغلقةٌ حتماً", () => {
  /**
   * بلاغُ المالك: «وممكن الإرجاع يكون في وقتٍ لاحق أو بعد عدّة أيّام من الإنشاء».
   * لا نافذةَ زمنية تمنع الإلغاء (`canCancelWorkOrder` دورٌ فقط، ولا حارسَ إقفال فترة على
   * المسار) — لكنّ الدرجَ الذي قبض العربون **مُغلقٌ يقيناً**، فالردّ يخرج من درج **اليوم**.
   * وهذا يجعل تعدّدَ الأدراج (أو انعدامَها) هو الحاجزَ الفعليّ لا الزمن.
   */
  it("درجُ القبض مُغلقٌ فلا يظهر أصلاً — يُختار من المفتوح اليوم", () => {
    const openToday = [drawer({ shiftId: 900, userId: 42, userName: "نور" })];
    expect(pickDefaultRefundDrawer(openToday, 42)).toBe(900);
    expect(refundDrawerBlockReason({ needed: true, drawers: openToday, selectedShiftId: 900, emptyLabel: "وردية استقبال" })).toBeNull();
  });

  it("لا وردية استقبالٍ مفتوحةً بعد أيّام ⇒ رسالةٌ تقول ما يُفعَل لا «تعذّر»", () => {
    expect(refundDrawerBlockReason({ needed: true, drawers: [], selectedShiftId: null, emptyLabel: "وردية استقبال" }))
      .toBe("لا توجد وردية استقبال مفتوحة في هذا الفرع — افتح ورديةً أولاً ليخرج منها النقد.");
  });
});

describe("serverAnsweredDeterministically — «مجهول» ليست مرادفَ «فشل»", () => {
  it("رفضٌ بكودٍ صريح ⇒ حتميّ (لم يحدث شيء)", () => {
    expect(serverAnsweredDeterministically({ data: { code: "PRECONDITION_FAILED" }, message: "توجد عدة ورديات" })).toBe(true);
    expect(serverAnsweredDeterministically({ data: { code: "FORBIDDEN" } })).toBe(true);
    expect(serverAnsweredDeterministically({ data: { code: "BAD_REQUEST" } })).toBe(true);
  });

  it("انقطاعُ نقلٍ بلا كود ⇒ غموضٌ حقيقيّ", () => {
    expect(serverAnsweredDeterministically(new Error("Failed to fetch"))).toBe(false);
    expect(serverAnsweredDeterministically({ data: {} })).toBe(false);
    expect(serverAnsweredDeterministically({ data: null })).toBe(false);
    expect(serverAnsweredDeterministically(null)).toBe(false);
    expect(serverAnsweredDeterministically(undefined)).toBe(false);
  });
});
