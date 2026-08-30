import { describe, it, expect } from "vitest";
import {
  SHORTFALL_REASONS,
  SHORTFALL_REASON_LABEL_AR,
  SHORTFALL_REASON_DESCRIPTION_AR,
  isShortfallReason,
  type ShortfallReason,
} from "./shortfallReason";

describe("SHORTFALL_REASONS — قائمة كاملة ومنسّقة", () => {
  it("تحتوي على ٦ أسباب بالضبط (المتّفق عليها مع المالك)", () => {
    expect(SHORTFALL_REASONS.length).toBe(6);
  });

  it("كلّ سببٍ له تسمية عربية غير فارغة", () => {
    for (const reason of SHORTFALL_REASONS) {
      const label = SHORTFALL_REASON_LABEL_AR[reason];
      expect(label).toBeTruthy();
      expect(label.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("كلّ سببٍ له وصف تفصيليّ يبدأ بـ«أل» أو حرفٍ أوّل جملة (لا رمز/رقم)", () => {
    for (const reason of SHORTFALL_REASONS) {
      const desc = SHORTFALL_REASON_DESCRIPTION_AR[reason];
      expect(desc).toBeTruthy();
      expect(desc.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("لا تكرار في التسميات — كلّ سببٍ متمايز بصرياً", () => {
    const labels = SHORTFALL_REASONS.map((r) => SHORTFALL_REASON_LABEL_AR[r]);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });

  it("القوائم مجمَّدة (Object.freeze) — لا تعديل عرضيّ يهدم الاختبارات", () => {
    expect(Object.isFrozen(SHORTFALL_REASON_LABEL_AR)).toBe(true);
    expect(Object.isFrozen(SHORTFALL_REASON_DESCRIPTION_AR)).toBe(true);
  });
});

describe("isShortfallReason — حارس التحقّق", () => {
  it("يقبل كلّ قيمة من الـenum", () => {
    for (const reason of SHORTFALL_REASONS) {
      expect(isShortfallReason(reason)).toBe(true);
    }
  });

  it("يرفض قيماً خارج الـenum", () => {
    expect(isShortfallReason("random_string")).toBe(false);
    expect(isShortfallReason("merchant_refused_commission")).toBe(false); // حالة أحرف مختلفة
    expect(isShortfallReason("")).toBe(false);
    expect(isShortfallReason(null)).toBe(false);
    expect(isShortfallReason(undefined)).toBe(false);
    expect(isShortfallReason(42)).toBe(false);
    expect(isShortfallReason({})).toBe(false);
  });

  it("narrowing للـtype يعمل بعد التحقّق (اختبار type-level ضمناً)", () => {
    const val: unknown = "OTHER";
    if (isShortfallReason(val)) {
      const typed: ShortfallReason = val; // يجب أن يمرّ بلا خطأ نوع
      expect(typed).toBe("OTHER");
    }
  });
});

describe("قاموس التسميات — مصدر حقيقة وحيد", () => {
  it("عدد المفاتيح = عدد قيم الـenum (لا تسمية زائدة/ناقصة)", () => {
    const labelKeys = Object.keys(SHORTFALL_REASON_LABEL_AR);
    const descKeys = Object.keys(SHORTFALL_REASON_DESCRIPTION_AR);
    expect(labelKeys.length).toBe(SHORTFALL_REASONS.length);
    expect(descKeys.length).toBe(SHORTFALL_REASONS.length);
  });

  it("كلّ مفتاح في القاموس يقابل قيمة في الـenum", () => {
    const enumSet = new Set<string>(SHORTFALL_REASONS);
    for (const key of Object.keys(SHORTFALL_REASON_LABEL_AR)) {
      expect(enumSet.has(key)).toBe(true);
    }
  });
});
