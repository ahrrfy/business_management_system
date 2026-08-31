/**
 * حالة العرض الموحّدة للإرسالية — اختبارٌ نصّيّ يغطّي كل فرع اشتقاقٍ ويحرس التسميات
 * (نمط `workOrderDeliveryState.test.ts`). جوهر القاموس: التفريق بين «مُسنَد — لم يخرج»
 * (جهة ببوّابة ستُحدِّث بنفسها) و«بانتظار كشف الشركة» (لن يأتي تقدّمٌ إلا بإدخال الموظّف) —
 * الخلط بينهما هو الذي ترك ٧٩ طرداً جامداً بلا صاحبِ فعلٍ واضح.
 */
import { describe, expect, it } from "vitest";
import {
  CONSIGNMENT_VIEW_AR,
  CONSIGNMENT_VIEW_CLS,
  CONSIGNMENT_VIEW_ORDER,
  consignmentViewLabel,
  deriveConsignmentView,
  type ConsignmentViewInput,
} from "./consignmentView";

/** صفٌّ حيّ افتراضيّ — كل حالةٍ تُعدَّل منه بما يخصّها فقط. */
const live = (over: Partial<ConsignmentViewInput>): ConsignmentViewInput => ({
  parcelStatus: "ASSIGNED",
  status: "DISPATCHED",
  moneyStatus: "UNSETTLED",
  returnDeclaredAt: null,
  partyHasPortal: true,
  ...over,
});

describe("deriveConsignmentView", () => {
  it("رجوعٌ مُعلَن (والإرسالية حيّة) ⇒ RETURN_DECLARED — يتقدّم على حالة الطرد أيّاً كانت", () => {
    expect(deriveConsignmentView(live({ returnDeclaredAt: new Date() }))).toBe("RETURN_DECLARED");
    expect(
      deriveConsignmentView(live({ returnDeclaredAt: "2026-08-20T10:00:00Z", parcelStatus: "OUT_FOR_DELIVERY" })),
    ).toBe("RETURN_DECLARED");
  });

  it("المرتجع بعد استلامه (status=RETURNED وختمُ الإعلان باقٍ) ⇒ CLOSED لا «بانتظار المرتجع» الأبديّة", () => {
    // returnDeclaredAt أثرٌ تاريخيّ لا يُمسَح عند الاستلام — بلا حارس الحياة يكذب القاموس.
    expect(
      deriveConsignmentView(live({ status: "RETURNED", parcelStatus: "RETURNED", returnDeclaredAt: new Date() })),
    ).toBe("CLOSED");
  });

  it("تعذّر التسليم ⇒ FAILED (قرارٌ مطلوب: إعادة إسناد أو إرجاع)", () => {
    expect(deriveConsignmentView(live({ parcelStatus: "FAILED" }))).toBe("FAILED");
  });

  it("سُلِّم والإغلاق لم يكتمل (DISPATCHED أو PARTIAL) ⇒ بانتظار التوريد — النقد بيد الجهة", () => {
    expect(deriveConsignmentView(live({ parcelStatus: "DELIVERED", moneyStatus: "UNSETTLED" }))).toBe("DELIVERED_AWAITING_REMIT");
    expect(deriveConsignmentView(live({ parcelStatus: "DELIVERED", status: "PARTIAL", moneyStatus: "PARTIAL" }))).toBe("DELIVERED_AWAITING_REMIT");
  });

  it("الحالات الثلاث الوسيطة كلّها «بالطريق»", () => {
    for (const p of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"]) {
      expect(deriveConsignmentView(live({ parcelStatus: p }))).toBe("IN_TRANSIT");
    }
  });

  it("مُسنَد وللجهة بوّابة ⇒ ASSIGNED (التقدّم سيأتي من المندوب نفسه)", () => {
    expect(deriveConsignmentView(live({ partyHasPortal: true }))).toBe("ASSIGNED");
    // SQL يُرجع الأعلام أرقاماً أحياناً — 1 الصادقة تُقرأ بوّابةً.
    expect(deriveConsignmentView(live({ partyHasPortal: 1 }))).toBe("ASSIGNED");
  });

  it("مُسنَد وجهةٌ بلا بوّابة ⇒ AWAITING_STATEMENT — الكرة بملعب الموظّف (كشف الشركة) لا الجهة", () => {
    expect(deriveConsignmentView(live({ partyHasPortal: false }))).toBe("AWAITING_STATEMENT");
    expect(deriveConsignmentView(live({ partyHasPortal: 0 }))).toBe("AWAITING_STATEMENT");
    expect(deriveConsignmentView(live({ partyHasPortal: null }))).toBe("AWAITING_STATEMENT");
  });

  it("الإرسالية غير الحيّة ⇒ CLOSED أيّاً كانت حالة طردها", () => {
    for (const s of ["DELIVERED", "CANCELLED", "RETURNED", "WRITTEN_OFF"]) {
      expect(deriveConsignmentView(live({ status: s }))).toBe("CLOSED");
      expect(deriveConsignmentView(live({ status: s, parcelStatus: "DELIVERED" }))).toBe("CLOSED");
    }
    expect(deriveConsignmentView(live({ status: null }))).toBe("CLOSED");
  });

  it("حالة طردٍ خارج القاموس (CANCELLED/RETURNED على صفٍّ حيّ نظرياً) ⇒ CLOSED لا انفجار", () => {
    expect(deriveConsignmentView(live({ parcelStatus: "CANCELLED" }))).toBe("CLOSED");
    expect(deriveConsignmentView(live({ parcelStatus: null }))).toBe("CLOSED");
  });
});

describe("القاموس نفسه", () => {
  it("التسميات المعتمدة (Slice DFP2 ٣١/٨/٢٦: بلا تشكيلٍ في الشارات — خطّ الواجهة يشوّهها بالحجم الصغير)", () => {
    expect(CONSIGNMENT_VIEW_AR).toEqual({
      RETURN_DECLARED: "بانتظار المرتجع",
      FAILED: "تعذر التسليم",
      DELIVERED_AWAITING_REMIT: "سلم — بانتظار التوريد",
      IN_TRANSIT: "بالطريق",
      AWAITING_STATEMENT: "بانتظار كشف الشركة",
      ASSIGNED: "مسند — لم يخرج",
      CLOSED: "مغلقة",
    });
    expect(consignmentViewLabel("FAILED")).toBe("تعذر التسليم");
  });

  it("لكل مفتاحٍ تسمية وتوكن وموضعُ ترتيب — التغطية كاملة بلا زيادة", () => {
    const keys = Object.keys(CONSIGNMENT_VIEW_AR).sort();
    expect(Object.keys(CONSIGNMENT_VIEW_CLS).sort()).toEqual(keys);
    expect([...CONSIGNMENT_VIEW_ORDER].sort()).toEqual(keys);
    expect(new Set(CONSIGNMENT_VIEW_ORDER).size).toBe(CONSIGNMENT_VIEW_ORDER.length);
  });

  it("توكنز دلالية لا ألوان خامّة: info للمنتظر فعلَنا، warn لما بيد الجهة، danger للمتعثّر، ok للمُسلَّم", () => {
    expect(CONSIGNMENT_VIEW_CLS.ASSIGNED).toContain("--sem-info");
    expect(CONSIGNMENT_VIEW_CLS.AWAITING_STATEMENT).toContain("--sem-info");
    expect(CONSIGNMENT_VIEW_CLS.IN_TRANSIT).toContain("--sem-warn");
    expect(CONSIGNMENT_VIEW_CLS.RETURN_DECLARED).toContain("--sem-warn");
    expect(CONSIGNMENT_VIEW_CLS.FAILED).toContain("--sem-danger");
    expect(CONSIGNMENT_VIEW_CLS.DELIVERED_AWAITING_REMIT).toContain("--sem-ok");
  });

  it("الترتيب يقدّم الأحوجَ لقرار: المتعثّر أوّلاً والمُغلق آخراً", () => {
    expect(CONSIGNMENT_VIEW_ORDER[0]).toBe("FAILED");
    expect(CONSIGNMENT_VIEW_ORDER[CONSIGNMENT_VIEW_ORDER.length - 1]).toBe("CLOSED");
  });
});
