import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { D, moneyInput } from "./money";

/**
 * انحدارٌ حقيقيّ أمسكته مراجعةٌ عدائية (٢/٩/٢٦): شرطُ معاينةٍ في `CustomerNew` استُبدل من
 * `Number(x) > 0` إلى `D(x).greaterThan(0)` التزاماً بقاعدة «لا `Number` على مال» — فصار
 * **يرمي داخل التصيير** على مُدخَلٍ جزئيٍّ مشروع تُنتجه `MoneyInput` نفسها، والنتيجة شاشةٌ
 * بيضاء بينما المستخدم يكتب رقماً صحيحاً.
 *
 * القاعدةُ لم تكن خاطئة؛ كان ينقصها **مدخلٌ آمن**. وهذه الحالات تُثبت الطرفين معاً: أنّ `D`
 * ترمي فعلاً (فلا يُقال «الادّعاء نظريّ»)، وأنّ `moneyInput` تصمد.
 */

/**
 * ما تُنتجه `sanitizeRaw` في [`MoneyInput`](../components/form/MoneyInput.tsx) أثناء الكتابة.
 * أهمُّها `"."`: أوّلُ ضغطةٍ لمن يكتب «.5» — تُبقيها الدالّة عمداً كي لا تُقاوم المستخدم.
 */
const PARTIAL_INPUTS = [".", "-", "-.", "", "   "] as const;

describe("moneyInput — مُدخَلٌ ماليٌّ قيد الكتابة", () => {
  it("⭐ `D` ترمي فعلاً على «.» — الادّعاء مُثبَتٌ لا مفترَض", () => {
    expect(() => D(".")).toThrow(/Invalid argument/);
  });

  it.each(PARTIAL_INPUTS)("لا ترمي على المُدخَل الجزئيّ %j وتقرؤه صفراً", (raw) => {
    expect(() => moneyInput(raw)).not.toThrow();
    expect(moneyInput(raw).isZero()).toBe(true);
  });

  it("والصفرُ يعني «لا رقمَ بعد» ⇒ شرطُ الإظهار لا يشتعل على مُدخَلٍ ناقص", () => {
    expect(moneyInput(".").greaterThan(0)).toBe(false);
  });

  it("الفارغ والغائب صفرٌ كذلك", () => {
    expect(moneyInput(null).isZero()).toBe(true);
    expect(moneyInput(undefined).isZero()).toBe(true);
  });

  it("والمُدخَلُ المكتمل يُقرأ بدقّته كاملةً — لا قصَّ ولا تقريبَ صامت", () => {
    expect(moneyInput("500000").toFixed(2)).toBe("500000.00");
    expect(moneyInput("5.").toFixed(2)).toBe("5.00");
    expect(moneyInput("1234.56").toFixed(2)).toBe("1234.56");
    // أربعُ منازلَ تمرّ كما هي: دقّةُ سعر الوحدة بالدولار يحفظها المستودع عمداً.
    expect(moneyInput("3.4566").toString()).toBe("3.4566");
    expect(moneyInput("-250").toFixed(2)).toBe("-250.00");
  });

  it("المسافات المحيطة تُقصّ — لصقُ مبلغٍ من مستندٍ لا يُصفّره", () => {
    expect(moneyInput("  1500  ").toFixed(2)).toBe("1500.00");
  });

  it("تُرجع Decimal لا سلسلةً ولا رقماً — فتُسلسَل للإرسال بلا انجراف", () => {
    expect(moneyInput("1500")).toBeInstanceOf(Decimal);
  });
});
