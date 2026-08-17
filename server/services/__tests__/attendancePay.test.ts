// الأجر بالحضور — نواة نقيّة (قرار المالك ٣١/٧: الحضور أساس الأجر، والاحتساب بالساعات).
//
// الثوابت المحروسة:
//   س١) سعر الساعة = الراتب ÷ ساعات الدوام المقرَّرة (أيام الدوام × الساعات اليومية).
//   س٢) مثال المالك الحرفيّ: غياب يومين + يومٌ بـ٥ ساعات ⇒ خصم ١٩ ساعة.
//   س٣) أيام الراحة لا تُطالَب بحضور ولا تُخصَم — وتختلف بين الموظفين.
//   س٤) الإجازة المدفوعة (أو من الرصيد) = يوم دوامٍ كامل؛ وبلا راتب = لا أجر.
//   س٥) ما قبل تاريخ السريان مدفوعٌ كاملاً — لا تُصفَّر رواتب أشهرٍ سبقت تشغيل الجهاز.
//   س٦) الزيادة عن الساعات القياسية لا تتضخّم في الأساس (عملٌ إضافيّ ببندٍ مستقلّ).
//   س٧) حضورٌ كاملٌ بلا غياب ⇒ الأجر = الراتب بالضبط (لا انحراف تقريب).
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeAttendancePay, dayNameOf, daysBetween, type WorkSchedule } from "../hr/attendancePay";

const D = (n: number | string) => new Decimal(n);

/** تموز ٢٠٢٦ كاملاً، راحة الجمعة، ٨ ساعات يومياً. */
function base(over: Partial<Parameters<typeof computeAttendancePay>[0]> = {}) {
  return computeAttendancePay({
    salary: D(900000),
    employmentStart: "2026-07-01",
    employmentEnd: "2026-07-31",
    schedule: sched(),
    attendedHoursByDate: new Map(),
    paidLeaveDates: new Set(),
    unpaidLeaveDates: new Set(),
    payFrom: "2026-07-01",
    ...over,
  });
}

/** جدول أسبوعيّ: ثمانٍ لكل يوم عدا ما يُمرَّر (صفر = راحة). */
function sched(over: Record<string, number> = { الجمعة: 0 }, rate?: number): WorkSchedule {
  const hours: Record<string, number> = { الأحد: 8, الاثنين: 8, الثلاثاء: 8, الأربعاء: 8, الخميس: 8, الجمعة: 8, السبت: 8, ...over };
  return Object.fromEntries(Object.entries(hours).map(([d, h]) => [d, { hours: h, rate }])) as WorkSchedule;
}

/** حضورٌ كاملٌ بساعات الجدول لكل يوم دوام. */
function fullAttendance(sc: WorkSchedule = sched()): Map<string, Decimal> {
  const m = new Map<string, Decimal>();
  for (const d of daysBetween("2026-07-01", "2026-07-31")) {
    const h = Number(sc[dayNameOf(d)]?.hours ?? 0);
    if (h > 0) m.set(d, D(h));
  }
  return m;
}

describe("مساعدات التقويم", () => {
  it("اسم اليوم بتقويم UTC ثابت", () => {
    expect(dayNameOf("2026-07-03")).toBe("الجمعة");
    expect(dayNameOf("2026-07-04")).toBe("السبت");
  });
  it("daysBetween شاملة الطرفين، ومقلوبة = []", () => {
    expect(daysBetween("2026-07-01", "2026-07-03")).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(daysBetween("2026-07-05", "2026-07-01")).toEqual([]);
  });
});

describe("سعر الساعة وأيام الدوام (س١، س٣)", () => {
  it("تموز فيه ٢٦ يوم دوام (٢٠٨ ساعة) لكنّ **مقام السعر ٣٠ يوماً** لا طول الشهر", () => {
    const r = base({ attendedHoursByDate: fullAttendance() });
    expect(r.scheduledHours).toBe("208.00"); // تموز كاملاً
    expect(r.standardHours).toBe("208.00"); // أول ٣٠ يوماً منه (٣١ تموز جمعة = راحة)
    expect(r.hourlyRate).toBe("4326.92"); // 900000 ÷ 208
  });

  it("س٣) الجمعة والسبت صفراً يُقلّلان المقام ويرفعان سعر الساعة", () => {
    const sc = sched({ الجمعة: 0, السبت: 0 });
    const r = base({ schedule: sc, attendedHoursByDate: fullAttendance(sc) });
    expect(r.scheduledHours).toBe("176.00"); // 22 يوماً × 8 في تموز
    expect(r.absentDays).toBe(0);
    expect(r.basePay).toBe("900000.00"); // ٣١ تموز جمعة (راحة) ⇒ لا يوم إضافيّ
  });

  it("س٧) حضور كامل في تموز ⇒ لا ساعة غير مستحقّة (والأجر فوق الراتب لطول الشهر)", () => {
    const r = base({ attendedHoursByDate: fullAttendance() });
    expect(r.payableHours).toBe("208.00");
    expect(r.unpaidHours).toBe("0.00");
    expect(r.absentDays).toBe(0);
  });
});

describe("مثال المالك الحرفيّ (س٢)", () => {
  it("غياب يومين + يومٌ بـ٥ ساعات ⇒ ١٩ ساعة غير مستحقّة", () => {
    const att = fullAttendance();
    att.delete("2026-07-06"); // غياب يوم
    att.delete("2026-07-07"); // غياب يوم
    att.set("2026-07-08", D(5)); // خرج مبكراً
    const r = base({ attendedHoursByDate: att });

    expect(r.absentDays).toBe(2);
    expect(r.shortHours).toBe("3.00");
    expect(r.unpaidHours).toBe("19.00"); // 8 + 8 + 3 — الثابت المحروس
    expect(r.payableHours).toBe("189.00");
    // 189 × 4326.92… = 817,788.46
    expect(Number(r.basePay)).toBeCloseTo(817788.46, 1);
  });
});

describe("الإجازات (س٤)", () => {
  it("المدفوعة تُحتسب يوم دوامٍ كامل ولو بلا بصمة", () => {
    const att = fullAttendance();
    att.delete("2026-07-13");
    att.delete("2026-07-14");
    const r = base({ attendedHoursByDate: att, paidLeaveDates: new Set(["2026-07-13", "2026-07-14"]) });
    expect(r.absentDays).toBe(0);
    expect(r.unpaidHours).toBe("0.00"); // الإجازة المدفوعة لا تُنقص شيئاً
  });

  it("بلا راتب لا تُحتسب — وتُميَّز عن الغياب في التفصيل", () => {
    const att = fullAttendance();
    att.delete("2026-07-13");
    att.delete("2026-07-14");
    const r = base({ attendedHoursByDate: att, unpaidLeaveDates: new Set(["2026-07-13", "2026-07-14"]) });
    expect(r.unpaidLeaveDays).toBe(2);
    expect(r.absentDays).toBe(0);
    expect(r.unpaidHours).toBe("16.00");
  });

  it("إجازة تقع في يوم راحة لا تُحتسب مرّتين", () => {
    const r = base({ attendedHoursByDate: fullAttendance(), paidLeaveDates: new Set(["2026-07-03"]) });
    expect(r.scheduledHours).toBe("208.00");
    expect(r.payableHours).toBe("208.00");
  });
});

describe("تاريخ السريان (س٥)", () => {
  it("ما قبله مدفوعٌ كاملاً رغم انعدام بيانات الحضور", () => {
    const r = base({ attendedHoursByDate: new Map(), payFrom: "2026-07-20" });
    // أيام الدوام قبل ٢٠ تموز تُدفع كاملةً؛ وما بعدها غيابٌ كامل.
    expect(r.absentDays).toBeGreaterThan(0);
    expect(Number(r.payableHours)).toBeGreaterThan(0);
    expect(Number(r.payableHours)).toBeLessThan(208);
  });

  it("payFrom=null ⇒ كل الشهر مدفوع (الميزة معطَّلة) بلا أي غياب", () => {
    const r = base({ attendedHoursByDate: new Map(), payFrom: null });
    expect(r.payableHours).toBe("208.00");
    expect(r.absentDays).toBe(0);
  });
});

describe("حدّ يوم العمل (س٦)", () => {
  it("١٢ ساعة في يوم تُحتسب ٨ في الأساس و٤ أوفر تايم ببندٍ مستقلّ", () => {
    const att = fullAttendance();
    att.set("2026-07-06", D(12));
    const r = base({ attendedHoursByDate: att });
    expect(r.payableHours).toBe("208.00"); // الأساس لا يتضخّم
    expect(r.overtimeHours).toBe("4.00");
    expect(Number(r.overtimePay)).toBeCloseTo(17307.69, 1); // ٤ × 4326.92
  });

  it("سعر ساعةٍ صريح لكل يوم هو الأصل — والراتب = مجموع (ساعات × سعر يومها)", () => {
    // قرار المالك: حقل الراتب مرجعيّ لا قيد. سعر ٤٥٠٠ لكل يوم دوام.
    const sc = sched({ الجمعة: 0 }, 4500);
    const r = base({ schedule: sc, attendedHoursByDate: fullAttendance(sc) });
    expect(r.scheduledHours).toBe("208.00");
    // السعر الصريح يتجاوز المُشتقّ: 208 × 4500 = 936,000 (حقل الراتب مرجعيّ لا قيد).
    expect(r.basePay).toBe("936000.00");
  });

  it("تفصيل يوميّ: صفٌّ لكل يوم دوام بحالته وسعره وأجره", () => {
    const att = fullAttendance();
    att.delete("2026-07-06");
    const r = base({ attendedHoursByDate: att });
    expect(r.days.length).toBe(26);
    const absent = r.days.find((x) => x.date === "2026-07-06");
    expect(absent?.state).toBe("absent");
    expect(absent?.amount).toBe("0.00");
    const present = r.days.find((x) => x.date === "2026-07-07");
    expect(present?.state).toBe("present");
    expect(present?.countedHours).toBe("8.00");
    expect(Number(present?.amount)).toBeGreaterThan(0);
  });
});

describe("نافذة العمل الجزئية", () => {
  it("تعيينٌ في منتصف الشهر ⇒ أيام دوامه وحدها هي المقام", () => {
    const att = new Map<string, Decimal>();
    for (const d of daysBetween("2026-07-16", "2026-07-31")) {
      if (dayNameOf(d) !== "الجمعة") att.set(d, D(8));
    }
    const r = base({ employmentStart: "2026-07-16", attendedHoursByDate: att });
    expect(r.absentDays).toBe(0);
    // المقام ثابت (٣٠ يوماً) ⇒ نصف شهرٍ يُنتج نحو نصف الراتب لا راتباً كاملاً.
    expect(Number(r.basePay)).toBeLessThan(900000);
    expect(Number(r.basePay)).toBeGreaterThan(0);
  });
});

describe("مقام ٣٠ يوماً — قرار المالك (٣١/٧)", () => {
  /** موظف المالك الفعليّ: راتب ٣٥٠٬٠٠٠ و٧ ساعات كل يوم بلا راحة (٤٩ ساعة/أسبوع). */
  const SEVEN: WorkSchedule = Object.fromEntries(
    ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"].map((d) => [d, { hours: 7 }]),
  );

  /** حضورٌ كامل بساعات الجدول لكل يوم في المدى. */
  function attAll(from: string, to: string, sc: WorkSchedule): Map<string, Decimal> {
    const m = new Map<string, Decimal>();
    for (const d of daysBetween(from, to)) {
      const h = Number((sc[dayNameOf(d)] as { hours: number }).hours);
      if (h > 0) m.set(d, D(h));
    }
    return m;
  }

  function run(from: string, to: string, att?: Map<string, Decimal>) {
    return computeAttendancePay({
      salary: D(350000), employmentStart: from, employmentEnd: to, schedule: SEVEN,
      attendedHoursByDate: att ?? attAll(from, to, SEVEN),
      paidLeaveDates: new Set(), unpaidLeaveDates: new Set(), payFrom: from,
      monthStart: from, monthEnd: to,
    });
  }

  it("المقام ٢١٠ ساعة (٣٠ يوماً × ٧) وسعر الساعة ١٬٦٦٦٫٦٧ — لا يتبع طول الشهر", () => {
    const r = run("2026-08-01", "2026-08-31");
    expect(r.standardHours).toBe("210.00");
    expect(r.hourlyRate).toBe("1666.67");
  });

  it("شهرٌ من ٣٠ يوماً بحضورٍ كامل ⇒ الراتب بالضبط دون نقصان دينار", () => {
    const r = run("2026-09-01", "2026-09-30");
    expect(r.scheduledHours).toBe("210.00");
    expect(r.basePay).toBe("350000.00"); // مطابقة تامّة لا تقريبية
  });

  it("شهرٌ من ٣١ يوماً ⇒ الراتب + أجر يومٍ إضافيّ (اليوم ٣١ فوق الراتب)", () => {
    const r = run("2026-08-01", "2026-08-31");
    expect(r.scheduledHours).toBe("217.00"); // ٧ ساعات زيادة
    // 350,000 + (7 × 1666.666…) = 361,666.67
    expect(r.basePay).toBe("361666.67");
  });

  it("شباط (٢٨ يوماً) ⇒ **الراتب كاملاً** — الشهر القصير يُهمَل ويُقسَم على ٣٠", () => {
    const r = run("2026-02-01", "2026-02-28");
    expect(r.scheduledHours).toBe("196.00"); // فعليّ
    expect(r.shortMonthHours).toBe("14.00"); // يومان تعويضاً
    expect(r.basePay).toBe("350000.00"); // دون نقصان دينار
  });

  it("تعويض الشهر القصير لا يُلغي الغياب — يجبر نقصَ التقويم لا نقصَ الحضور", () => {
    const att = attAll("2026-02-01", "2026-02-28", SEVEN);
    att.delete("2026-02-10"); // غياب يوم
    att.delete("2026-02-11"); // غياب يوم
    const r = run("2026-02-01", "2026-02-28", att);
    expect(r.absentDays).toBe(2);
    expect(r.shortMonthHours).toBe("14.00");
    // (196 − 14 غياب) + 14 تعويض = 196 ساعة × 1666.67
    expect(r.payableHours).toBe("196.00");
    expect(r.basePay).toBe("326666.67");
  });

  it("المعيَّن في منتصف شهرٍ قصير لا يُمنح التعويض (وإلا قبض ما قبل تعيينه)", () => {
    const r = computeAttendancePay({
      salary: D(350000), employmentStart: "2026-02-15", employmentEnd: "2026-02-28", schedule: SEVEN,
      attendedHoursByDate: attAll("2026-02-15", "2026-02-28", SEVEN),
      paidLeaveDates: new Set(), unpaidLeaveDates: new Set(), payFrom: "2026-02-01",
      monthStart: "2026-02-01", monthEnd: "2026-02-28",
    });
    expect(r.shortMonthHours).toBe("0.00");
    expect(Number(r.basePay)).toBeLessThan(350000);
  });

  it("جدولٌ فيه راحة في شهرٍ من ٣٠ يوماً ⇒ الراتب بالضبط (المقام من التقويم الفعليّ)", () => {
    const sc: WorkSchedule = Object.fromEntries(
      ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "السبت"].map((d) => [d, { hours: 8 }]),
    );
    sc["الجمعة"] = { hours: 0 };
    const r = computeAttendancePay({
      salary: D(350000), employmentStart: "2026-09-01", employmentEnd: "2026-09-30", schedule: sc,
      attendedHoursByDate: attAll("2026-09-01", "2026-09-30", sc),
      paidLeaveDates: new Set(), unpaidLeaveDates: new Set(), payFrom: "2026-09-01",
    });
    // أيلول ٢٠٢٦: ٣٠ يوماً فيها ٤ جُمَع ⇒ ٢٦ يوم دوام × ٨ = ٢٠٨ ساعة معيارية
    expect(r.standardHours).toBe("208.00");
    expect(r.basePay).toBe("350000.00"); // حضور كامل ⇒ الراتب حرفياً
  });
});

describe("العمل في يوم الراحة (قرار المالك ٣١/٧: سعر عادي)", () => {
  it("من حضر يوم راحته يتقاضى ساعاته بالسعر العاديّ — كان لا يتقاضى شيئاً", () => {
    const att = fullAttendance();
    att.set("2026-07-03", D(8)); // الجمعة = راحة في الجدول
    const r = base({ attendedHoursByDate: att });
    expect(r.restWorkedHours).toBe("8.00");
    const fri = r.days.find((x) => x.date === "2026-07-03");
    expect(fri?.state).toBe("restWorked");
    expect(Number(fri?.amount)).toBeGreaterThan(0);
    // ٨ ساعات × سعر الساعة تُضاف فوق أجر أيام الدوام.
    expect(Number(r.basePay)).toBeGreaterThan(900000);
  });

  it("يوم الراحة لا يدخل مقام السعر (عملٌ فوق الجدول لا جزءٌ منه)", () => {
    const att = fullAttendance();
    att.set("2026-07-03", D(8));
    const r = base({ attendedHoursByDate: att });
    expect(r.standardHours).toBe("208.00"); // كما لو لم يعمل الجمعة
  });

  it("يوم راحةٍ بلا حضور يبقى غير موجود (لا صفّ ولا أجر)", () => {
    const r = base({ attendedHoursByDate: fullAttendance() });
    expect(r.restWorkedHours).toBe("0.00");
    expect(r.days.some((x) => x.state === "restWorked")).toBe(false);
  });

  it("العمل في يوم الراحة يخضع لسقف الساعات أيضاً", () => {
    const att = fullAttendance();
    att.set("2026-07-03", D(20));
    const r = base({ attendedHoursByDate: att, maxDailyHours: 12 });
    expect(r.restWorkedHours).toBe("12.00");
  });
});

/*
 * س٨) اليوم **المفتوح** (دخولٌ بلا انصراف) ليس غياباً — تدقيق ١٧/٨.
 * كان يصل المحرّك بساعاتٍ صفرٍ فيقرأه غياباً ويدفعه صفراً صامتاً، ويضخّم «غياب N يوم»
 * في ملاحظة المسيّر بأيامٍ لم يغبها الموظف. الفرق بين الحالتين أجرُ يومٍ كامل.
 */
describe("اليوم المفتوح — دخولٌ بلا انصراف (س٨)", () => {
  const openDay = "2026-07-06"; // اثنين — يوم دوام

  it("يُميَّز بحالة open ولا يُحتسب غياباً", () => {
    const att = fullAttendance();
    att.set(openDay, D(0)); // ساعاته صفرٌ لأنها لا تُخمَّن
    const r = base({ attendedHoursByDate: att, openDates: new Set([openDay]) });

    expect(r.openDays).toBe(1);
    expect(r.openDates).toEqual([openDay]);
    expect(r.absentDays).toBe(0); // ← جوهر الإصلاح: لم يعد يُعدّ غياباً
    expect(r.days.find((x) => x.date === openDay)?.state).toBe("open");
  });

  it("بلا openDates يبقى السلوك السابق كما هو — غياب (صفر انحدار)", () => {
    const att = fullAttendance();
    att.set(openDay, D(0));
    const r = base({ attendedHoursByDate: att });

    expect(r.openDays).toBe(0);
    expect(r.absentDays).toBe(1);
    expect(r.days.find((x) => x.date === openDay)?.state).toBe("absent");
  });

  it("لا يُدفع أجرُه (ساعاته مجهولة) — والمسيّر يوقف نفسه عنده لا يخمّنه", () => {
    const att = fullAttendance();
    att.set(openDay, D(0));
    const r = base({ attendedHoursByDate: att, openDates: new Set([openDay]) });
    const day = r.days.find((x) => x.date === openDay)!;

    expect(day.amount).toBe("0.00");
    expect(day.totalAmount).toBe("0.00");
  });
});

/*
 * س٩) سقف اليوم الواحد يُطبَّق في مسار **يوم الدوام** لا في الطيّ ومسار الراحة وحدهما.
 * كان المسار الأكثر استعمالاً يستهلك الساعات خامّاً، فيمرّ يومٌ مُدخَلٌ يدوياً بعشرين ساعة.
 */
describe("سقف اليوم الواحد في مسار يوم الدوام (س٩)", () => {
  const day = "2026-07-06";

  it("يقصّ الساعات عند السقف قبل تقسيمها أساساً وإضافياً", () => {
    const att = new Map([[day, D(20)]]);
    const r = base({ attendedHoursByDate: att, maxDailyHours: 12 });
    const row = r.days.find((x) => x.date === day)!;

    expect(row.countedHours).toBe("8.00"); // المقرَّر
    expect(row.overtimeHours).toBe("4.00"); // 12 − 8 لا 20 − 8
    expect(row.attendedHours).toBe("20.00"); // الخام يبقى ظاهراً للشفافية
  });

  it("لا يمسّ يوماً دون السقف — صفر انحدار على بيانات الطيّ", () => {
    const att = new Map([[day, D(10)]]);
    const r = base({ attendedHoursByDate: att, maxDailyHours: 12 });
    const row = r.days.find((x) => x.date === day)!;

    expect(row.countedHours).toBe("8.00");
    expect(row.overtimeHours).toBe("2.00");
  });
});

/*
 * س١٠) تفصيل أجر اليوم: الأساس والإضافي والإجمالي. عمود «أجر اليوم» كان يعرض `amount`
 * وحده (الأساس المقصوص عند المقرَّر) فيبدو الإضافي ضائعاً لمن يقرأ العمود.
 */
describe("تفصيل أجر اليوم — أساس + إضافي = إجمالي (س١٠)", () => {
  const day = "2026-07-06";

  it("الإجمالي يساوي مجموع الشقّين، والإضافي = السعر × الساعات الزائدة", () => {
    const r = base({ attendedHoursByDate: new Map([[day, D(12)]]), maxDailyHours: 12 });
    const row = r.days.find((x) => x.date === day)!;
    const rate = Number(row.rate);

    expect(Number(row.overtimeAmount)).toBeCloseTo(rate * 4, 0);
    expect(Number(row.totalAmount)).toBeCloseTo(Number(row.amount) + Number(row.overtimeAmount), 2);
  });

  it("يومٌ بلا إضافي: الإجمالي = الأساس", () => {
    const r = base({ attendedHoursByDate: new Map([[day, D(8)]]) });
    const row = r.days.find((x) => x.date === day)!;

    expect(row.overtimeAmount).toBe("0.00");
    expect(row.totalAmount).toBe(row.amount);
  });

  it("مجموع أيام الشهر يطابق basePay وovertimePay", () => {
    const att = fullAttendance();
    att.set(day, D(12)); // يومٌ فيه أربع ساعات إضافية
    const r = base({ attendedHoursByDate: att, maxDailyHours: 12 });
    const sum = (k: "amount" | "overtimeAmount") =>
      r.days.reduce((a, x) => a + Number(x[k]), 0);

    expect(sum("amount")).toBeCloseTo(Number(r.basePay), 0);
    expect(sum("overtimeAmount")).toBeCloseTo(Number(r.overtimePay), 0);
  });
});
