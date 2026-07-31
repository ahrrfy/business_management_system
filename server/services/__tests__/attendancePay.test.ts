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
import { computeAttendancePay, dayNameOf, daysBetween } from "../hr/attendancePay";

const D = (n: number | string) => new Decimal(n);

/** تموز ٢٠٢٦ كاملاً، راحة الجمعة، ٨ ساعات يومياً. */
function base(over: Partial<Parameters<typeof computeAttendancePay>[0]> = {}) {
  return computeAttendancePay({
    salary: D(900000),
    employmentStart: "2026-07-01",
    employmentEnd: "2026-07-31",
    restDays: ["الجمعة"],
    dailyHours: D(8),
    attendedHoursByDate: new Map(),
    paidLeaveDates: new Set(),
    unpaidLeaveDates: new Set(),
    payFrom: "2026-07-01",
    ...over,
  });
}

/** حضورٌ كاملٌ ٨ ساعات لكل أيام الدوام. */
function fullAttendance(restDays = ["الجمعة"], hours = 8): Map<string, Decimal> {
  const m = new Map<string, Decimal>();
  const rest = new Set(restDays);
  for (const d of daysBetween("2026-07-01", "2026-07-31")) {
    if (!rest.has(dayNameOf(d))) m.set(d, D(hours));
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
  it("تموز ٢٠٢٦ فيه ٥ جُمَع ⇒ ٢٦ يوم دوام × ٨ = ٢٠٨ ساعة", () => {
    const r = base({ attendedHoursByDate: fullAttendance() });
    expect(r.scheduledHours).toBe("208.00");
    // 900000 ÷ 208 = 4326.92…
    expect(r.hourlyRate).toBe("4326.92");
  });

  it("س٣) راحة الجمعة والسبت تُقلّل أيام الدوام وترفع سعر الساعة", () => {
    const rest = ["الجمعة", "السبت"];
    const r = base({ restDays: rest, attendedHoursByDate: fullAttendance(rest) });
    expect(r.scheduledHours).toBe("176.00"); // 22 يوماً × 8
    expect(r.absentDays).toBe(0);
    expect(Number(r.basePay)).toBeCloseTo(900000, 0);
  });

  it("س٧) حضور كامل ⇒ الأجر = الراتب بالضبط", () => {
    const r = base({ attendedHoursByDate: fullAttendance() });
    expect(r.payableHours).toBe("208.00");
    expect(r.unpaidHours).toBe("0.00");
    expect(Number(r.basePay)).toBeCloseTo(900000, 0);
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
    expect(r.unpaidHours).toBe("19.00"); // 8 + 8 + 3
    expect(r.payableHours).toBe("189.00");
    // الخصم = 19 × 4326.92 ≈ 82,211 ⇒ الأجر ≈ 817,788
    expect(Number(r.basePay)).toBeCloseTo(817788.46, 0);
  });
});

describe("الإجازات (س٤)", () => {
  it("المدفوعة تُحتسب يوم دوامٍ كامل ولو بلا بصمة", () => {
    const att = fullAttendance();
    att.delete("2026-07-13");
    att.delete("2026-07-14");
    const r = base({ attendedHoursByDate: att, paidLeaveDates: new Set(["2026-07-13", "2026-07-14"]) });
    expect(r.absentDays).toBe(0);
    expect(r.unpaidHours).toBe("0.00");
    expect(Number(r.basePay)).toBeCloseTo(900000, 0);
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
    expect(Number(r.basePay)).toBeCloseTo(900000, 0);
  });
});

describe("حدّ يوم العمل (س٦)", () => {
  it("١٢ ساعة في يوم تُحتسب ٨ — الزيادة عملٌ إضافيّ ببندٍ مستقلّ", () => {
    const att = fullAttendance();
    att.set("2026-07-06", D(12));
    const r = base({ attendedHoursByDate: att });
    expect(r.payableHours).toBe("208.00"); // لا ٢١٢
    expect(Number(r.basePay)).toBeCloseTo(900000, 0);
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
    // حضر كل أيام دوامه ⇒ يستحقّ راتباً كاملاً عن فترته (سعر ساعته أعلى لأن مقامه أصغر).
    expect(Number(r.basePay)).toBeCloseTo(900000, 0);
  });
});
