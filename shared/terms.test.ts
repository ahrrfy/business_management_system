import { describe, it, expect } from "vitest";
import { TERMS, TERM_KEYS, term, type Term, type TermKey } from "./terms";

/**
 * حرّاسُ العقد — تمنع الانحراف الذي يجعل القاموس بلا فائدة:
 *   ⛔ صيغةٌ فارغة (تُنتج زرّاً بلا نصّ).
 *   ⛔ تشكيلٌ في `compact` (يُفشل مقارنة السلاسل في الفلترة/البحث).
 *   ⛔ مفتاحٌ يتكرّر (يمنعه TypeScript، لكنّ الحرس دفاعٌ في العمق).
 */

/** كل حروف التشكيل العربية التي يجب ألّا تظهر في `compact`. */
const HARAKAT_REGEX = /[ً-ٰٟۖ-ۭ]/;

describe("shared/terms — عقد القاموس", () => {
  it("لا صيغةٌ فارغة في أيّ مصطلح", () => {
    for (const key of TERM_KEYS) {
      const t = TERMS[key];
      expect(t.compact.trim(), `${key}.compact فارغ`).not.toBe("");
      expect(t.prose.trim(), `${key}.prose فارغ`).not.toBe("");
      expect(t.tooltip.trim(), `${key}.tooltip فارغ`).not.toBe("");
    }
  });

  it("لا تشكيلٌ في `compact` (يُفشل مقارنة السلاسل في الفلترة)", () => {
    for (const key of TERM_KEYS) {
      const c = TERMS[key].compact;
      expect(HARAKAT_REGEX.test(c), `${key}.compact فيه تشكيل: "${c}"`).toBe(false);
    }
  });

  it("`compact` أقصر من `prose` أو يساويه (المختصر لا يطول عن السرد)", () => {
    for (const key of TERM_KEYS) {
      const t = TERMS[key];
      expect(t.compact.length, `${key}: compact(${t.compact.length}) أطول من prose(${t.prose.length})`).toBeLessThanOrEqual(
        t.prose.length + 3, // هامشٌ لـ «الـ» في prose التي تجعله أقصر أحياناً
      );
    }
  });

  it("`tooltip` أطول من `prose` (شرحٌ مطوَّل لا اسمٌ آخر)", () => {
    for (const key of TERM_KEYS) {
      const t = TERMS[key];
      expect(t.tooltip.length, `${key}: tooltip قصير جداً`).toBeGreaterThan(t.prose.length);
    }
  });

  it("لا مفتاحٌ فارغٌ أو غامض", () => {
    for (const key of TERM_KEYS) {
      expect(key, "مفتاح فارغ").not.toBe("");
      expect(String(key), `مفتاح غير إنجليزيّ: ${key}`).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
    }
  });

  it("`term()` تعيد المصطلح الصحيح بأمان النوع", () => {
    const t: Term = term("unpaidInvoice");
    expect(t.compact).toBe("غير مدفوعة");
    expect(t.prose).toBe("الفاتورة غير المدفوعة");
    expect(t.tooltip).toContain("لم يُسدَّد");
  });

  it("`TERM_KEYS` تشمل كلّ مفاتيح `TERMS` بلا نقصٍ أو زيادة", () => {
    expect(TERM_KEYS.length).toBe(Object.keys(TERMS).length);
    for (const key of Object.keys(TERMS) as TermKey[]) {
      expect(TERM_KEYS.includes(key), `${key} غائبٌ عن TERM_KEYS`).toBe(true);
    }
  });
});

/**
 * حرّاسٌ محدّدة على المصطلحات التي أبلغ عنها المالك — أيّ رجوعٍ عنها يُمسَك فوراً.
 */
describe("shared/terms — قرارات المالك المُثبتة", () => {
  it("«غير مدفوعة» لا «معلّقة» (تصحيح ١٧/٨/٢٦)", () => {
    expect(TERMS.unpaidInvoice.compact).toBe("غير مدفوعة");
    expect(TERMS.unpaidInvoice.compact).not.toContain("معلّق");
    expect(TERMS.unpaidInvoice.compact).not.toContain("معلق");
  });

  it("أجرة التوصيل ليست عمولة (مسندٌ في ذاكرة delivery-financial-p1)", () => {
    expect(TERMS.deliveryFee.compact).toContain("أجرة");
    expect(TERMS.deliveryFee.compact).not.toContain("عمولة");
    expect(TERMS.commission.compact).toContain("عمولة");
    expect(TERMS.commission.compact).not.toContain("أجرة");
  });

  it("القبض ≠ الصرف — مفتاحان لا واحد", () => {
    expect(TERMS.cashIn.compact).toBe("قبض");
    expect(TERMS.cashOut.compact).toBe("صرف");
  });

  it("المرتجع ≠ الملغاة — التمييز الحاكم", () => {
    expect(TERMS.returnedInvoice.compact).toBe("مرتجعة");
    expect(TERMS.cancelledInvoice.compact).toBe("ملغاة");
    // نصّان مختلفان — يوثِّق أنّهما مفهومان منفصلان لا مترادفان
    expect(TERMS.returnedInvoice.compact).not.toBe(TERMS.cancelledInvoice.compact);
  });

  it("جهة التوصيل تسميةٌ رسميّة (لا «المندوب» — قد يكون شركة)", () => {
    expect(TERMS.deliveryParty.compact).toBe("جهة التوصيل");
  });
});
