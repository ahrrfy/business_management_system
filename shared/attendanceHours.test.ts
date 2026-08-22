/**
 * نواة اتّساق ساعات اليوم مع وقتَي الدخول والانصراف (shared/attendanceHours.ts).
 *
 * الحزمة تُثبّت الاتجاهين معاً — المنعَ حيث يجب و**المرورَ حيث يجب**. الثاني ليس تزيّناً:
 * الطيّ التلقائي يُنتج ساعاتٍ أقلّ من المدى مشروعةً (الاستراحات مطروحة بمزاوجة البصمات)،
 * فحارسٌ يفرض المساواة يوقف ingest الأجهزة كلَّه.
 */
import { describe, expect, it } from "vitest";
import { HOURS_SPAN_TOLERANCE, attendanceHoursViolation, spanHours } from "./attendanceHours";

const paid = (hours: number, checkIn: string | null, checkOut: string | null) =>
  attendanceHoursViolation({ checkIn, checkOut, hours, isPaidStatus: true });

describe("spanHours", () => {
  it("يحسب المدى بمنزلتين", () => {
    expect(spanHours("08:00", "17:00")).toBe(9);
    expect(spanHours("07:53", "22:49")).toBe(14.93);
    expect(spanHours("16:02", "23:10")).toBe(7.13);
  });

  it("يُرجع null حين ينقص وقتٌ أو لا يكون الانصراف بعد الدخول", () => {
    expect(spanHours("08:00", null)).toBeNull();
    expect(spanHours(null, "17:00")).toBeNull();
    expect(spanHours("17:00", "08:00")).toBeNull(); // لا يعبر منتصف الليل
    expect(spanHours("08:00", "08:00")).toBeNull(); // مدىً صفر ليس دواماً
    expect(spanHours("8:0", "17:00")).toBeNull(); // تنسيق غير صالح
    expect(spanHours("25:00", "26:00")).toBeNull(); // ساعة خارج النطاق
  });
});

describe("attendanceHoursViolation — ما يجب منعه", () => {
  it("يمنع ساعاتٍ تتجاوز المدى (أجرُ وقتٍ لم يقع)", () => {
    expect(paid(15, "08:00", "17:00")).toMatch(/تتجاوز المدى/);
  });

  it("يمنع صفر ساعاتٍ مع وقتين كاملين — الفخّ الذي يُصفّر أجر اليوم", () => {
    expect(paid(0, "07:58", "17:00")).toMatch(/صفراً/);
  });

  it("يمنع انصرافاً قبل الدخول", () => {
    expect(paid(5, "17:00", "08:00")).toMatch(/بعد وقت الدخول/);
  });

  it("يمنع ساعاتٍ غير رقمية", () => {
    expect(paid(Number.NaN, "08:00", "17:00")).toMatch(/غير صالحة/);
  });
});

describe("attendanceHoursViolation — ما يجب أن يمرّ", () => {
  it("يمرّر ساعاتٍ أقلّ من المدى — الاستراحة المطروحة بالمزاوجة (مسار الطيّ)", () => {
    expect(paid(8, "08:00", "20:00")).toBeNull();
  });

  it("يمرّر المساواة التامّة", () => {
    expect(paid(9, "08:00", "17:00")).toBeNull();
  });

  it("يمرّر تجاوزاً داخل التسامح — قصّ الثواني في HH:MM لا يكسر الطيّ", () => {
    // أقصى انحرافٍ بنيويّ: ٥٩ ثانية ≈ 0.0164 ساعة + تقريب منزلتين.
    expect(paid(9 + HOURS_SPAN_TOLERANCE, "08:00", "17:00")).toBeNull();
    expect(paid(9.02, "08:00", "17:00")).toBeNull();
  });

  it("يمنع تجاوزاً يفوق التسامح ولو بقليل", () => {
    expect(paid(9 + HOURS_SPAN_TOLERANCE + 0.01, "08:00", "17:00")).toMatch(/تتجاوز المدى/);
  });

  it("لا حكم بلا وقتين كاملين — البصمة الفردية حالةٌ مشروعة تُوسَم للمراجعة", () => {
    expect(paid(0, "07:58", null)).toBeNull();
    expect(paid(0, null, null)).toBeNull();
    expect(paid(12, "07:58", null)).toBeNull();
  });

  it("يمرّر صفر ساعاتٍ لحالةٍ بلا أجر — الغياب المعلَن ليس فخّاً", () => {
    expect(attendanceHoursViolation({ checkIn: "08:00", checkOut: "17:00", hours: 0, isPaidStatus: false })).toBeNull();
  });

  it("يبقى الاتجاه الأعلى محروساً حتى لحالةٍ بلا أجر", () => {
    expect(attendanceHoursViolation({ checkIn: "08:00", checkOut: "17:00", hours: 20, isPaidStatus: false })).toMatch(/تتجاوز المدى/);
  });
});
