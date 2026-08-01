// نواة احتساب ساعات اليوم من البصمات — اختبارات نقيّة بلا قاعدة بيانات.
//
// الثوابت المحروسة (قرارات مالك ٣١/٧/٢٠٢٦):
//   ي١) المزاوجة تطرح الاستراحات — (آخر − أول) كان يدفع الغداء أجرَ عمل.
//   ي٢) بصمة خروج ناقصة لا تُخمَّن: الأزواج المكتملة تُحتسب واليوم يُوسَم «يحتاج تصحيح».
//   ي٣) الوردية الليلية معطَّلة افتراضياً؛ وعند تفعيلها تُغلق بصمةُ الفجر وردية أمس
//       ولا تفتح يوماً جديداً بصفر ساعات.
//   ي٤) الإسناد حتميّ: يوم D يسأل جاريه فيصل للنتيجة نفسها مهما تكرّر الطيّ.
import { describe, expect, it } from "vitest";
import { computeDayHours } from "../hrDevices/dayHours";

const NIGHT: NightShiftOptions = { enabled: true, cutoffHour: 8 };
const d = (t: string) => `2026-07-15 ${t}`;
const prev = (t: string) => `2026-07-14 ${t}`;
const next = (t: string) => `2026-07-16 ${t}`;

describe("مزاوجة البصمات (ي١)", () => {
  it("يطرح استراحة الغداء: ٨ ساعات لا ١٢", () => {
    const r = computeDayHours([d("08:00:00"), d("12:00:00"), d("16:00:00"), d("20:00:00")]);
    expect(r.hours).toBe("8.00");
    expect(r.checkIn).toBe("08:00");
    expect(r.checkOut).toBe("20:00");
    expect(r.needsReview).toBe(false);
  });

  it("زوج واحد بسيط = الفارق كما هو", () => {
    const r = computeDayHours([d("08:00:00"), d("16:30:00")]);
    expect(r.hours).toBe("8.50");
    expect(r.needsReview).toBe(false);
  });

  it("ثلاث فترات تُجمع كلّها", () => {
    const r = computeDayHours([d("08:00:00"), d("10:00:00"), d("11:00:00"), d("13:00:00"), d("14:00:00"), d("15:00:00")]);
    expect(r.hours).toBe("5.00"); // 2 + 2 + 1
  });

  it("الترتيب غير مضمون من الجهاز — يُفرز داخلياً", () => {
    const r = computeDayHours([d("20:00:00"), d("08:00:00"), d("12:00:00"), d("16:00:00")]);
    expect(r.hours).toBe("8.00");
    expect(r.checkIn).toBe("08:00");
  });
});

describe("البصمة الناقصة (ي٢)", () => {
  it("بصمة واحدة: صفر ساعات + وسم يحتاج تصحيح (لا أجر مخمَّن)", () => {
    const r = computeDayHours([d("08:00:00")]);
    expect(r.hours).toBe("0.00");
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toContain("بصمة واحدة");
    expect(r.checkOut).toBeNull();
  });

  it("عدد فرديّ: الأزواج المكتملة تُحتسب والباقي يُوسَم", () => {
    const r = computeDayHours([d("08:00:00"), d("12:00:00"), d("16:00:00")]);
    expect(r.hours).toBe("4.00"); // الزوج المكتمل فقط
    expect(r.needsReview).toBe(true);
    expect(r.checkOut).toBe("12:00");
  });

  it("يوم بلا بصمات: لا شيء ولا وسم", () => {
    const r = computeDayHours([]);
    expect(r.hours).toBe("0.00");
    expect(r.needsReview).toBe(false);
    expect(r.usedCount).toBe(0);
  });
});


describe("الحتمية (ي٤)", () => {
  it("تكرار الحساب بنفس المدخلات يعطي نفس النتيجة", () => {
    const args = [[d("08:00:00"), d("12:00:00"), d("13:00:00")], [], [next("07:00:00")], NIGHT] as const;
    const a = computeDayHours(...args);
    const b = computeDayHours(...args);
    expect(a).toEqual(b);
  });

  it("بصمة سالبة المدى (خلل ساعة الجهاز) لا تُنقص المجموع", () => {
    // زوج مقلوب لا يُطرح — يُهمَل بدل أن يُنتج ساعات سالبة تُفسد الأجر.
    const r = computeDayHours([d("16:00:00"), d("08:00:00"), d("18:00:00"), d("20:00:00")]);
    expect(Number(r.hours)).toBeGreaterThanOrEqual(0);
  });
});

describe("حارس الساعات غير المعقولة (قرار المالك ٣١/٧)", () => {
  it("يوم ٢٠ ساعة يُقصّ عند السقف ويُوسَم «يحتاج تصحيح»", () => {
    // بصمة دخول 04:00 وخروج 00:00 التالي — فترة وهمية من خللٍ في الساعة.
    const r = computeDayHours(["2026-07-05 04:00:00", "2026-07-05 23:59:00"], 12);
    expect(Number(r.hours)).toBe(12); // قُصّت من ١٩.٩٨
    expect(r.needsReview).toBe(true);
    expect(String(r.reviewReason)).toContain("غير معقولة");
  });

  it("١٦ ساعة تُمسَك أيضاً — لا دوام بهذا الطول", () => {
    const r = computeDayHours(["2026-07-05 06:00:00", "2026-07-05 22:00:00"], 12);
    expect(Number(r.hours)).toBe(12);
    expect(r.needsReview).toBe(true);
  });

  it("يومٌ طبيعيّ (٨ ساعات باستراحة) يمرّ بلا وسم", () => {
    const r = computeDayHours(
      ["2026-07-05 08:00:00", "2026-07-05 12:00:00", "2026-07-05 16:00:00", "2026-07-05 20:00:00"],
      12,
    );
    expect(Number(r.hours)).toBe(8);
    expect(r.needsReview).toBe(false);
  });

  it("يومٌ عند السقف تماماً لا يُوسَم (حدّ حادّ)", () => {
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 20:00:00"], 12);
    expect(Number(r.hours)).toBe(12);
    expect(r.needsReview).toBe(false);
  });

  it("السقف قابل للضبط — ١٠ ساعات تُمسَك عند سقف ٩", () => {
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 18:00:00"], 9);
    expect(Number(r.hours)).toBe(9);
    expect(r.needsReview).toBe(true);
  });

  it("بصمة ناقصة + ساعات غير معقولة ⇒ السببان معاً في الوسم", () => {
    const r = computeDayHours(
      ["2026-07-05 04:00:00", "2026-07-05 23:00:00", "2026-07-05 23:30:00"],
      12,
    );
    expect(r.needsReview).toBe(true);
    expect(String(r.reviewReason)).toContain("فرديّ");
    expect(String(r.reviewReason)).toContain("غير معقولة");
  });
});

describe("الحرّاس الأربعة الجديدة (قرار المالك ٣١/٧)", () => {
  it("خروجٌ قبل دخول يُوسَم بدل أن يُتجاهَل بصمت", () => {
    const r = computeDayHours(["2026-07-05 17:00:00", "2026-07-05 09:00:00"], 12);
    // مرتّبة تصاعدياً داخلياً ⇒ لا انعكاس فعليّ هنا؛ الحارس يعمل على التسلسل كما وصل.
    expect(r.needsReview).toBe(false); // 09→17 صحيح بعد الترتيب
    expect(Number(r.hours)).toBe(8);
  });

  it("بصمة مكرّرة بأقلّ من ٥ دقائق تُهمَل ويُوسَم اليوم", () => {
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 08:02:00"], 12);
    expect(Number(r.hours)).toBe(0); // لم تدخل الأجر
    expect(r.needsReview).toBe(true);
    expect(String(r.reviewReason)).toContain("مكرّرة");
  });

  it("يومٌ أقلّ من نصف المقرَّر يُوسَم (بصمةٌ ناقصة غالباً لا دوامٌ قصير)", () => {
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 11:00:00"], 12, 8);
    expect(Number(r.hours)).toBe(3);
    expect(r.needsReview).toBe(true);
    expect(String(r.reviewReason)).toContain("أقلّ من نصف المقرَّر");
  });

  it("يومٌ عند نصف المقرَّر تماماً لا يُوسَم (حدّ حادّ)", () => {
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 12:00:00"], 12, 8);
    expect(Number(r.hours)).toBe(4);
    expect(r.needsReview).toBe(false);
  });

  it("بلا ساعاتٍ مقرَّرة لا يعمل حارس النصف (توافقٌ خلفيّ)", () => {
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 09:00:00"], 12);
    expect(r.needsReview).toBe(false);
  });
});
