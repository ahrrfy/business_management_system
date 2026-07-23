/**
 * سياسة عزل أوضاع نقطة البيع (قرار المالك ٢٣/٧/٢٦: فصلٌ كامل بين التجزئة وخدمات الطباعة).
 * يوثّق مصفوفة العزل كـ«مواصفة تنفيذية» تحرس ضدّ أيّ انزلاقٍ مستقبليّ في ربط التبويب بوحدته.
 */
import { describe, expect, it } from "vitest";
import { MODE_GATES, canSeeMode } from "../posModeGates";

describe("عزل تبويبات نقطة البيع (posModeGates)", () => {
  it("ربط كل تبويب بوحدته الخادمية الصحيحة (حارس ضدّ إعادة الربط الخاطئ)", () => {
    expect(MODE_GATES.RETAIL.module).toBe("sales");
    expect(MODE_GATES.PRINT_SERVICES.module).toBe("pos");
    expect(MODE_GATES.RECEPTION.module).toBe("workorders");
  });

  it("admin يرى الأقسام الثلاثة", () => {
    expect(canSeeMode("RETAIL", "admin")).toBe(true);
    expect(canSeeMode("PRINT_SERVICES", "admin")).toBe(true);
    expect(canSeeMode("RECEPTION", "admin")).toBe(true);
  });

  it("الكاشير القالبيّ يرى التجزئة والطباعة معاً (توافق رجعيّ)", () => {
    expect(canSeeMode("RETAIL", "cashier")).toBe(true);
    expect(canSeeMode("PRINT_SERVICES", "cashier")).toBe(true);
  });

  it("كاشير تجزئة مخصَّص (pos=NONE) يرى التجزئة فقط لا الطباعة", () => {
    const retailOnly = { pos: "NONE" as const };
    expect(canSeeMode("RETAIL", "cashier", retailOnly)).toBe(true);
    expect(canSeeMode("PRINT_SERVICES", "cashier", retailOnly)).toBe(false);
  });

  it("كاشير طباعة مخصَّص (sales=NONE) يرى الطباعة فقط لا التجزئة", () => {
    const printOnly = { sales: "NONE" as const };
    expect(canSeeMode("PRINT_SERVICES", "cashier", printOnly)).toBe(true);
    expect(canSeeMode("RETAIL", "cashier", printOnly)).toBe(false);
  });

  it("المحاسب لا يرى أيّ قسم بيعٍ نقديّ (sales=READ/pos=NONE، خارج قائمة البوّابة)", () => {
    expect(canSeeMode("RETAIL", "accountant")).toBe(false);
    expect(canSeeMode("PRINT_SERVICES", "accountant")).toBe(false);
  });

  it("فنّي المطبعة القالبيّ لا يرى قسمَي البيع النقديّ (pos/sales=NONE)", () => {
    expect(canSeeMode("RETAIL", "print_operator")).toBe(false);
    expect(canSeeMode("PRINT_SERVICES", "print_operator")).toBe(false);
  });

  it("منحٌ صريح للوحدة يفتح التبويب لدورٍ خارج القائمة (مرآة moduleAccessAllowed)", () => {
    // دور «user» (pos/sales=NONE قالبياً) يُمنح pos=FULL صراحةً ⇒ يرى الطباعة فقط.
    expect(canSeeMode("PRINT_SERVICES", "user", { pos: "FULL" as const })).toBe(true);
    expect(canSeeMode("RETAIL", "user", { pos: "FULL" as const })).toBe(false);
  });

  it("بلا دورٍ محدَّد ⇒ لا يرى شيئاً", () => {
    expect(canSeeMode("RETAIL", undefined)).toBe(false);
    expect(canSeeMode("PRINT_SERVICES", undefined)).toBe(false);
    expect(canSeeMode("RECEPTION", undefined)).toBe(false);
  });
});
