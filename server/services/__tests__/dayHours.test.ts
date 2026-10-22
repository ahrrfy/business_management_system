// نواة احتساب ساعات اليوم من البصمات — اختبارات نقيّة بلا قاعدة بيانات.
//
// الثوابت المحروسة (قرارات مالك ٣١/٧/٢٠٢٦):
//   ي١) المزاوجة تطرح الاستراحات — (آخر − أول) كان يدفع الغداء أجرَ عمل.
//   ي٢) بصمة خروج ناقصة لا تُخمَّن: الأزواج المكتملة تُحتسب واليوم يُوسَم «يحتاج تصحيح».
//   ي٣) الوردية الليلية معطَّلة افتراضياً؛ وعند تفعيلها تُغلق بصمةُ الفجر وردية أمس
//       ولا تفتح يوماً جديداً بصفر ساعات.
//   ي٤) الإسناد حتميّ: يوم D يسأل جاريه فيصل للنتيجة نفسها مهما تكرّر الطيّ.
import { describe, expect, it } from "vitest";
import { computeDayHours, type NightShiftOptions } from "../hrDevices/dayHours";

const NIGHT: NightShiftOptions = { enabled: true, cutoffHour: 8 };
const d = (t: string) => `2026-07-15 ${t}`;
const next = (t: string) => `2026-07-16 ${t}`;
/** يوم D مع بصمات فجر اليوم التالي — الشكل الذي يمرّره الطيّ. */
const withDawn = (own: string[], dawn: string[], cutoffHour = 8) =>
  computeDayHours(own, 12, undefined, { enabled: true, cutoffHour, nextDayPunches: dawn });

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


describe("الوردية الليلية (ي٣)", () => {
  it("معطَّلة افتراضياً: وردية 22:00→06:00 تصير يومين ببصمةٍ واحدة لكلٍّ — صفر ساعات", () => {
    const r = computeDayHours([d("22:00:00")]);
    expect(r.hours).toBe("0.00");
    expect(r.needsReview).toBe(true);
    expect(r.checkOut).toBeNull();
  });

  it("عند تفعيلها تُغلق بصمةُ الفجر وردية أمس: ثماني ساعات لا صفر", () => {
    const r = withDawn([d("22:00:00")], [next("06:00:00")]);
    expect(r.hours).toBe("8.00");
    expect(r.checkIn).toBe("22:00");
    expect(r.checkOut).toBe("06:00");
    expect(r.checkOutNextDay).toBe(true);
    expect(r.needsReview).toBe(false);
  });

  it("بصمةُ فجر هذا اليوم تخصّ وردية أمس ⇒ تُستبعَد من يومه", () => {
    // 06:00 من يوم D تُغلق وردية D-1؛ فلا تفتح يوماً جديداً هنا.
    const r = withDawn([d("06:00:00"), d("22:00:00")], [next("06:00:00")]);
    expect(r.checkIn).toBe("22:00"); // لا 06:00
    expect(r.hours).toBe("8.00");
  });

  it("يومٌ كلُّ بصماته قبل الفصل ⇒ لا وردية له إطلاقاً (تخصّ أمس)", () => {
    const r = withDawn([d("05:00:00"), d("07:00:00")], [next("06:00:00")]);
    expect(r.usedCount).toBe(0); // ⇒ الطيّ يركنها «أُسندت لوردية اليوم السابق»
    expect(r.hours).toBe("0.00");
    expect(r.needsReview).toBe(false);
  });

  it("لا يجرّ فجرَ الغد إلى يومٍ بلا افتتاح — وإلّا سُرق انصرافُ وردية غيره", () => {
    const r = withDawn([], [next("06:00:00")]);
    expect(r.usedCount).toBe(0);
    expect(r.hours).toBe("0.00");
  });

  it("ساعة الفصل قابلة للضبط: بفصلٍ عند ٤ لا تُضمّ بصمةُ ٠٦:٠٠", () => {
    const r = withDawn([d("22:00:00")], [next("06:00:00")], 4);
    expect(r.hours).toBe("0.00"); // 06:00 ≥ 4 ⇒ تخصّ الغد لا هذه الوردية
    expect(r.needsReview).toBe(true);
  });

  it("النهار العاديّ لا يتأثّر بالتفعيل — صفر انحدار", () => {
    const r = withDawn([d("08:00:00"), d("12:00:00"), d("16:00:00"), d("20:00:00")], []);
    expect(r.hours).toBe("8.00");
    expect(r.checkOutNextDay).toBe(false);
    expect(r.needsReview).toBe(false);
  });

  it("سقف اليوم يبقى نافذاً على الوردية الليلية", () => {
    const r = withDawn([d("18:00:00")], [next("07:30:00")]);
    expect(Number(r.hours)).toBe(12); // قُصّت من ١٣.٥
    expect(String(r.reviewReason)).toContain("غير معقولة");
  });
});

describe("الحتمية (ي٤)", () => {
  it("تكرار الحساب بنفس المدخلات يعطي نفس النتيجة", () => {
    const own = [d("08:00:00"), d("12:00:00"), d("13:00:00")];
    const opts: NightShiftOptions = { ...NIGHT, nextDayPunches: [next("07:00:00")] };
    const a = computeDayHours(own, 12, undefined, opts);
    const b = computeDayHours(own, 12, undefined, opts);
    expect(a).toEqual(b);
  });

  it("الإسناد يُشتقّ من الجيران لا من حالةٍ مخزَّنة ⇒ إعادة الطيّ لا تغيّر شيئاً", () => {
    const own = [d("22:00:00")];
    const dawn = [next("06:00:00")];
    const runs = [0, 1, 2].map(() => withDawn(own, dawn));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
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
  it("ترتيبٌ مضطرب في الوارد يُوسَم — يُكتشف قبل الفرز وإلا استحال (Codex P2)", () => {
    const r = computeDayHours(["2026-07-05 17:00:00", "2026-07-05 09:00:00"], 12);
    expect(Number(r.hours)).toBe(8); // يُحتسب بعد الفرز
    expect(r.needsReview).toBe(true);
    expect(String(r.reviewReason)).toContain("مضطرب");
  });

  it("مسحٌ مزدوج عند الدخول لا يُصفّر اليوم — يُنقّى قبل المزاوجة (Codex P1)", () => {
    // 08:00 · 08:02 (مكرّرة) · 17:00 ⇒ كان ينكسر التكافؤ فيصير الخروج معلَّقاً والأجر صفراً.
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 08:02:00", "2026-07-05 17:00:00"], 12);
    expect(Number(r.hours)).toBe(9);
    expect(r.needsReview).toBe(true);
    expect(String(r.reviewReason)).toContain("مكرّرة");
  });

  it("مسحٌ مزدوج عند الدخول والخروج معاً يبقى يوماً سليماً", () => {
    const r = computeDayHours(
      ["2026-07-05 08:00:00", "2026-07-05 08:01:00", "2026-07-05 17:00:00", "2026-07-05 17:02:00"],
      12,
    );
    expect(Number(r.hours)).toBe(9);
    expect(r.needsReview).toBe(true);
  });

  it("بصمتان متلاصقتان فقط ⇒ صفر ساعات وبصمة معلَّقة", () => {
    const r = computeDayHours(["2026-07-05 08:00:00", "2026-07-05 08:02:00"], 12);
    expect(Number(r.hours)).toBe(0);
    expect(r.needsReview).toBe(true);
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

describe("الإسناد الذكي لبصمات ما بعد منتصف الليل (smartCrossMidnight — قرار المالك ٢٢/١٠)", () => {
  it("يُغلق بصمة أمس المسائية المفتوحة (15:07) ببصمة ما بعد منتصف الليل (00:02) ويحسب 8.92 ساعة", () => {
    const oct5 = computeDayHours(["2026-10-05 15:07:00"], 12, 8, {
      enabled: false,
      cutoffHour: 8,
      smartCrossMidnight: true,
      nextDayPunches: ["2026-10-06 00:02:00", "2026-10-06 14:16:00", "2026-10-06 22:30:00"],
    });
    expect(oct5.checkIn).toBe("15:07");
    expect(oct5.checkOut).toBe("00:02");
    expect(oct5.checkOutNextDay).toBe(true);
    expect(oct5.hours).toBe("8.92");
    expect(oct5.needsReview).toBe(false);
  });

  it("يستبعد بصمة 00:02 المستهلكة من يوم 2026-10-06 فلا تزاوج خطأً مع دخول 14:16 عصراً", () => {
    const oct6 = computeDayHours(
      ["2026-10-06 00:02:00", "2026-10-06 14:16:00", "2026-10-06 22:30:00"],
      12,
      8,
      {
        enabled: false,
        cutoffHour: 8,
        smartCrossMidnight: true,
        prevDayPunches: ["2026-10-05 15:07:00"],
      },
    );
    expect(oct6.checkIn).toBe("14:16");
    expect(oct6.checkOut).toBe("22:30");
    expect(oct6.checkOutNextDay).toBe(false);
    expect(oct6.hours).toBe("8.23");
    expect(oct6.needsReview).toBe(false);
  });

  it("يدعم أياماً متتالية عابرة لمنتصف الليل دون تداخل (مثلاً 12 و13 أكتوبر)", () => {
    const oct12 = computeDayHours(["2026-10-12 15:01:00"], 12, 8, {
      enabled: false,
      cutoffHour: 8,
      smartCrossMidnight: true,
      nextDayPunches: ["2026-10-13 00:03:00", "2026-10-13 13:52:00", "2026-10-13 23:18:00"],
    });
    expect(oct12.checkIn).toBe("15:01");
    expect(oct12.checkOut).toBe("00:03");
    expect(oct12.checkOutNextDay).toBe(true);
    expect(oct12.hours).toBe("9.03");
    expect(oct12.needsReview).toBe(false);

    const oct13 = computeDayHours(
      ["2026-10-13 00:03:00", "2026-10-13 13:52:00", "2026-10-13 23:18:00"],
      12,
      8,
      {
        enabled: false,
        cutoffHour: 8,
        smartCrossMidnight: true,
        prevDayPunches: ["2026-10-12 15:01:00"],
      },
    );
    expect(oct13.checkIn).toBe("13:52");
    expect(oct13.checkOut).toBe("23:18");
    expect(oct13.hours).toBe("9.43");
    expect(oct13.needsReview).toBe(false);
  });

  it("لا يسرق بصمة الصباح المبكّر إن كان اليوم السابق مغلقاً (سواء أكان دوام أمس مسائياً أم صباحياً مبكّراً < 06:00)", () => {
    const day2AfterEvening = computeDayHours(["2026-10-08 05:30:00", "2026-10-08 13:30:00"], 12, 8, {
      enabled: false,
      cutoffHour: 8,
      smartCrossMidnight: true,
      prevDayPunches: ["2026-10-07 15:00:00", "2026-10-07 23:00:00"],
    });
    expect(day2AfterEvening.checkIn).toBe("05:30");
    expect(day2AfterEvening.checkOut).toBe("13:30");
    expect(day2AfterEvening.hours).toBe("8.00");
    expect(day2AfterEvening.needsReview).toBe(false);

    // الحالة الحرجة: يوم أمس نفسه بدأ ببصمة صباح مبكّر (05:30 -> 17:00) وأُغلق، واليوم التالي بدأ 05:00 -> 13:30
    const day2AfterEarlyMorning = computeDayHours(["2026-10-08 05:00:00", "2026-10-08 13:30:00"], 12, 8, {
      enabled: false,
      cutoffHour: 8,
      smartCrossMidnight: true,
      prevDayPunches: ["2026-10-07 05:30:00", "2026-10-07 17:00:00"],
    });
    expect(day2AfterEarlyMorning.checkIn).toBe("05:00");
    expect(day2AfterEarlyMorning.checkOut).toBe("13:30");
    expect(day2AfterEarlyMorning.hours).toBe("8.50");
    expect(day2AfterEarlyMorning.needsReview).toBe(false);
  });

  it("يدعم سلسلة ٣ ليالٍ متتالية عابرة لمنتصف الليل حيث يحتوي اليوم الأوسط على بصمة انصراف الفجر + بصمة دخول العصر", () => {
    // ليلة ١ (4 أكتوبر): دخول 15:00 وانصراف 00:02 فجر 5 أكتوبر
    // ليلة ٢ (5 أكتوبر): فيها بصمتان خام [00:02 (انصراف ليلة ١)، 15:07 (دخول ليلة ٢)] وانصرافها 00:05 فجر 6 أكتوبر
    // ليلة ٣ (6 أكتوبر): فيها [00:05 (انصراف ليلة ٢)، 14:16 (دخول)، 22:30 (انصراف)]
    const oct5 = computeDayHours(["2026-10-05 00:02:00", "2026-10-05 15:07:00"], 12, 8, {
      enabled: false,
      cutoffHour: 8,
      smartCrossMidnight: true,
      prevDayPunches: ["2026-10-04 15:00:00"],
      nextDayPunches: ["2026-10-06 00:05:00", "2026-10-06 14:16:00", "2026-10-06 22:30:00"],
    });
    expect(oct5.checkIn).toBe("15:07");
    expect(oct5.checkOut).toBe("00:05");
    expect(oct5.checkOutNextDay).toBe(true);
    expect(oct5.hours).toBe("8.97");
    expect(oct5.needsReview).toBe(false);

    const oct6 = computeDayHours(
      ["2026-10-06 00:05:00", "2026-10-06 14:16:00", "2026-10-06 22:30:00"],
      12,
      8,
      {
        enabled: false,
        cutoffHour: 8,
        smartCrossMidnight: true,
        prevDayPunches: ["2026-10-05 00:02:00", "2026-10-05 15:07:00"],
      },
    );
    expect(oct6.checkIn).toBe("14:16");
    expect(oct6.checkOut).toBe("22:30");
    expect(oct6.checkOutNextDay).toBe(false);
    expect(oct6.hours).toBe("8.23");
    expect(oct6.needsReview).toBe(false);
  });
});

describe("فترات الدوام المجزّأ والاستراحة / الزمنية في computeDayHours", () => {
  it("يُرجع تفاصيل كل فترة دوام وفترة الاستراحة بينها عند البصم على فترتين (صباحاً وعصراً)", () => {
    const r = computeDayHours(["2026-10-10 08:00:00", "2026-10-10 12:00:00", "2026-10-10 16:00:00", "2026-10-10 20:00:00"], 12, 8);
    expect(r.hours).toBe("8.00");
    expect(r.checkIn).toBe("08:00");
    expect(r.checkOut).toBe("20:00");
    expect(r.sessions).toEqual([
      { checkIn: "08:00", checkOut: "12:00", hours: "4.00", checkOutNextDay: false },
      { checkIn: "16:00", checkOut: "20:00", hours: "4.00", checkOutNextDay: false },
    ]);
    expect(r.breaks).toEqual([{ from: "12:00", to: "16:00", minutes: 240, hours: "4.00" }]);
    expect(r.breakMinutes).toBe(240);
    expect(r.breakHours).toBe("4.00");
    expect(r.needsReview).toBe(false);
  });

  it("يرصد الفترة الثانية المفتوحة والاستراحة السابقة لها عندما يبصم الموظف ٣ بصمات (دخول ١، خروج ١، دخول ٢ بلا خروج)", () => {
    const r = computeDayHours(["2026-10-10 08:00:00", "2026-10-10 12:00:00", "2026-10-10 16:00:00"], 12, 8);
    expect(r.hours).toBe("4.00");
    expect(r.needsReview).toBe(true);
    expect(r.reviewReason).toContain("بصمة دخول 16:00 بلا انصراف");
    expect(r.sessions).toEqual([
      { checkIn: "08:00", checkOut: "12:00", hours: "4.00", checkOutNextDay: false },
      { checkIn: "16:00", checkOut: null, hours: "0.00", checkOutNextDay: false },
    ]);
    expect(r.breakMinutes).toBe(240);
    expect(r.breakHours).toBe("4.00");
  });
});

