/**
 * اختباراتُ عقد `<RefundRailPicker>` الموحَّد — الدلالةُ لا الشكل.
 *
 * القاعدةُ الحاكمة: **لا نوعَ مستندٍ يُقبَل هنا قبل أن يكون له تمهيدٌ خادميٌّ حقيقيّ**.
 * الاختبارُ يمسك أيّ إضافةٍ مقتضبةٍ لنوعٍ في القاموس بلا تسميةٍ عربية — فيتذكّر مَن يضيف
 * أن يبني تسميةً + تمهيداً + بوّابةً في الشريحة نفسها لا في بلاغٍ لاحق.
 */
import { describe, expect, it } from "vitest";
import {
  CARD_REFERENCE_MIN_LENGTH,
  REFUND_RAILS,
  REFUND_SOURCE_DOC_LABEL,
  REFUND_SOURCE_DOC_TYPES,
  RefundRailContextSchema,
  availableRefundRails,
  cardReferenceIsMissing,
  refundRailAvailability,
} from "./refundRails";

const drawer = { shiftId: 7, userId: 2, userName: "كاشير", shiftType: "RECEPTION", sufficient: true };

describe("توفّرُ الروافد — ما يقبله فعلُ التنفيذ فعلاً (م٢ ق١٠)", () => {
  it("كلُّ رافدٍ غيرِ متاح يحمل سبباً مقروءاً — لا إخفاءَ صامتاً", () => {
    for (const type of REFUND_SOURCE_DOC_TYPES) {
      for (const drawers of [[], [drawer]]) {
        for (const cardRefundAllowed of [false, true]) {
          const rails = refundRailAvailability(type, { drawers, cardRefundAllowed }, true);
          for (const rail of REFUND_RAILS) {
            if (!rails[rail].available) {
              expect(rails[rail].reason, `${type}/${rail}`).toBeTruthy();
              expect((rails[rail].reason ?? "").length, `${type}/${rail}`).toBeGreaterThan(15);
            } else {
              expect(rails[rail].reason, `${type}/${rail}`).toBeNull();
            }
          }
        }
      }
    }
  });

  it("عكسُ التسليم: الخزينةُ متاحةٌ حين لا وردية استقبال مفتوحة فقط (المفتاح الناقص) والبطاقةُ لا", () => {
    const none = refundRailAvailability("WORKORDER_REVERSE_DELIVERY", { drawers: [], cardRefundAllowed: true });
    expect(availableRefundRails(none)).toEqual(["TREASURY"]);
    const withDrawer = refundRailAvailability("WORKORDER_REVERSE_DELIVERY", { drawers: [drawer], cardRefundAllowed: true });
    expect(availableRefundRails(withDrawer)).toEqual(["DRAWER"]);
    expect(withDrawer.TREASURY.reason).toMatch(/وردية استقبال مفتوحة/);
  });

  it("مرتجعُ البيع: الخزينةُ مخرجُ الإداريّ حين لا وردية، ومحجوبةٌ عن غيره بسببٍ يذكر المدير", () => {
    const admin = refundRailAvailability("SALE_RETURN", { drawers: [], cardRefundAllowed: true }, true);
    expect(availableRefundRails(admin)).toEqual(["TREASURY", "CARD"]);
    const staff = refundRailAvailability("SALE_RETURN", { drawers: [], cardRefundAllowed: false }, false);
    expect(availableRefundRails(staff)).toEqual([]);
    expect(staff.TREASURY.reason).toMatch(/المدير/);
  });

  it("إرجاعُ الإرسالية: الدرجُ وحده — والخزينةُ معلَنةٌ غيرَ مبنيّةٍ باسم فعلها لا مخفيّة", () => {
    const rails = refundRailAvailability("CONSIGNMENT_RETURN", { drawers: [drawer], cardRefundAllowed: false });
    expect(availableRefundRails(rails)).toEqual(["DRAWER"]);
    expect(rails.TREASURY.reason).toMatch(/delivery\.returnConsignment/);
  });
});

describe("عقدُ منتقي روافد الردّ", () => {
  it("كلُّ نوعِ مستندٍ في القاموس يملك تسميةً عربية غيرَ فارغة", () => {
    for (const t of REFUND_SOURCE_DOC_TYPES) {
      expect(REFUND_SOURCE_DOC_LABEL[t]).toBeTruthy();
      expect(REFUND_SOURCE_DOC_LABEL[t].length).toBeGreaterThan(3);
    }
  });

  it("الحمولةُ ترفض معرّفاً ≤ 0 أو نوعاً غيرَ مسجَّل", () => {
    expect(RefundRailContextSchema.safeParse({ sourceDocType: "WORKORDER_CANCEL", sourceDocId: 0 }).success).toBe(false);
    expect(RefundRailContextSchema.safeParse({ sourceDocType: "WORKORDER_CANCEL", sourceDocId: -1 }).success).toBe(false);
    expect(RefundRailContextSchema.safeParse({ sourceDocType: "UNKNOWN_KIND", sourceDocId: 1 }).success).toBe(false);
  });

  it("الحمولةُ تقبل نوعاً مسجَّلاً بمعرّفٍ موجب", () => {
    for (const t of REFUND_SOURCE_DOC_TYPES) {
      expect(RefundRailContextSchema.safeParse({ sourceDocType: t, sourceDocId: 42 }).success).toBe(true);
    }
  });

  it("الروافدُ الثلاثة موجودةٌ — أيّ حذفٍ بلا خطّةِ ترحيلٍ يكسر الاختبار", () => {
    // مصدرٌ واحد للأسماء يمنع «رافدٌ رابع» صامتاً أو حذفَ رافدٍ يستعمله مستهلك.
    expect([...REFUND_RAILS]).toEqual(["DRAWER", "TREASURY", "CARD"]);
  });

  it("`cardReferenceIsMissing` تفرّق بين الروافد وبين المرجع الفعليّ", () => {
    // درجٌ وخزينةٌ لا يلزمهما مرجع أصلاً — قيمةُ المرجع تخمَل بلا أثر.
    expect(cardReferenceIsMissing("DRAWER", "")).toBe(false);
    expect(cardReferenceIsMissing("DRAWER", "abc")).toBe(false);
    expect(cardReferenceIsMissing("TREASURY", null)).toBe(false);

    // بطاقةٌ + مرجعٌ فارغ = ناقص.
    expect(cardReferenceIsMissing("CARD", "")).toBe(true);
    expect(cardReferenceIsMissing("CARD", null)).toBe(true);
    expect(cardReferenceIsMissing("CARD", undefined)).toBe(true);

    // العتبةُ ثلاثةٌ — «AB» ناقص و«ABC» كافٍ.
    expect(CARD_REFERENCE_MIN_LENGTH).toBe(3);
    expect(cardReferenceIsMissing("CARD", "AB")).toBe(true);
    expect(cardReferenceIsMissing("CARD", "ABC")).toBe(false);

    // مسافاتٌ محيطة تُقلَّم قبل القياس — لا يمرّ «   » كافياً.
    expect(cardReferenceIsMissing("CARD", "   ")).toBe(true);
    expect(cardReferenceIsMissing("CARD", "  ABCDE  ")).toBe(false);
  });
});
