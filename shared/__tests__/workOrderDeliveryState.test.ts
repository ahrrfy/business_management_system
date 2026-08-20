/**
 * حالة التوصيل المشتقّة — اختبارٌ نصّيّ يحرس القاموس المشترك (نمط `invoiceStatus`).
 * الغرض: منع عودة الانجراف الذي كان يقول «قيد التوصيل» لكل شيء، ومنع تعريفٍ محلّيّ في شاشة.
 */
import { describe, expect, it } from "vitest";
import {
  deriveWoDeliveryState,
  woDeliveryStateLabel,
  WO_DELIVERY_STATE_AR,
  WO_DELIVERY_STATE_CLS,
} from "../workOrderDeliveryState";

describe("deriveWoDeliveryState", () => {
  it("بلا إرسالية ⇒ NONE (حالة الأمر نفسها هي القول الفصل)", () => {
    expect(deriveWoDeliveryState(null, null)).toBe("NONE");
    expect(deriveWoDeliveryState(undefined, undefined)).toBe("NONE");
  });

  it("مُسنَد لم يخرج ⇒ ASSIGNED", () => {
    expect(deriveWoDeliveryState("DISPATCHED", "ASSIGNED")).toBe("ASSIGNED");
  });

  it("الحالات الثلاث الوسيطة كلّها «بالطريق» — وهي التي لم تكن تطابقها أيّ قائمة", () => {
    for (const p of ["ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY"]) {
      expect(deriveWoDeliveryState("DISPATCHED", p)).toBe("IN_TRANSIT");
    }
  });

  it("تعذّر التسليم ⇒ FAILED (قرارٌ مطلوب: إعادة محاولة أو استرجاع)", () => {
    expect(deriveWoDeliveryState("DISPATCHED", "FAILED")).toBe("FAILED");
  });

  it("الملغاة/المرتجعة ليست حيّة ⇒ NONE (الأمر يعود لطابور الإرسال)", () => {
    expect(deriveWoDeliveryState("CANCELLED", "CANCELLED")).toBe("NONE");
    expect(deriveWoDeliveryState("RETURNED", "RETURNED")).toBe("NONE");
    // حتى لو بقيت حالة الطرد وسيطةً على صفٍّ ملغى، الإغلاق يحكم.
    expect(deriveWoDeliveryState("CANCELLED", "OUT_FOR_DELIVERY")).toBe("NONE");
  });

  it("بعد التسليم ⇒ NONE (الرحلة انتهت)", () => {
    expect(deriveWoDeliveryState("DELIVERED", "DELIVERED")).toBe("NONE");
  });

  it("كل حالةٍ ظاهرة لها تسمية ولون — ولا تسمية بلا حالة", () => {
    for (const state of ["ASSIGNED", "IN_TRANSIT", "FAILED"] as const) {
      expect(woDeliveryStateLabel(state)).toBe(WO_DELIVERY_STATE_AR[state]);
      expect(WO_DELIVERY_STATE_CLS[state]).toContain("var(--sem-");
    }
    expect(woDeliveryStateLabel("NONE")).toBeNull();
    expect(Object.keys(WO_DELIVERY_STATE_AR).sort()).toEqual(Object.keys(WO_DELIVERY_STATE_CLS).sort());
  });
});
