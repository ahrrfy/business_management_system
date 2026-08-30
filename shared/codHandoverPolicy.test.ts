import { describe, it, expect } from "vitest";
import {
  requiresFullPaymentAtHandover,
  COD_PICKUP_PAYMENT_ERROR_AR,
} from "./codHandoverPolicy";

describe("requiresFullPaymentAtHandover — ضمان الدفع الكامل للاستلام COD (Slice O)", () => {
  it("COD + استلام (بلا توصيل) ⇒ يُلزم دفع كامل", () => {
    expect(requiresFullPaymentAtHandover("COD", false)).toBe(true);
  });

  it("COD + توصيل ⇒ لا يُلزم (المندوب يقبض؛ متبقٍّ = تسليم جزئيّ مشروع)", () => {
    expect(requiresFullPaymentAtHandover("COD", true)).toBe(false);
  });

  it("PREPAID + استلام ⇒ لا يُلزم (فحصُ الائتمان الاعتياديّ)", () => {
    expect(requiresFullPaymentAtHandover("PREPAID", false)).toBe(false);
  });

  it("PREPAID + توصيل ⇒ لا يُلزم", () => {
    expect(requiresFullPaymentAtHandover("PREPAID", true)).toBe(false);
  });

  it("CREDIT + استلام ⇒ لا يُلزم (ذمّة صريحة بسقفٍ حادّ)", () => {
    expect(requiresFullPaymentAtHandover("CREDIT", false)).toBe(false);
  });

  it("CREDIT + توصيل ⇒ لا يُلزم", () => {
    expect(requiresFullPaymentAtHandover("CREDIT", true)).toBe(false);
  });
});

describe("COD_PICKUP_PAYMENT_ERROR_AR — رسالة الرفض العربية", () => {
  it("تحمل المتبقّي المطلوب بدقّة", () => {
    const msg = COD_PICKUP_PAYMENT_ERROR_AR("15000.00");
    expect(msg).toContain("15000.00");
    expect(msg).toContain("د.ع");
    expect(msg).toContain("حصّل المبلغ");
  });

  it("تُخبر الكاشير بالإجراء التالي (لا رفض أعمى)", () => {
    const msg = COD_PICKUP_PAYMENT_ERROR_AR("5000");
    expect(msg).toMatch(/حصّل.*قبل.*تسليم/);
  });
});
