import { describe, expect, it } from "vitest";
import {
  DAYS_OF_WEEK,
  ALL_DAYS_MASK,
  getBaghdadDayOfWeek,
  getBaghdadDayName,
  isDayActive,
  formatActiveDays,
} from "../promotionScheduling";

describe("shared/promotionScheduling — جدولة العروض وفحص أيام الأسبوع", () => {
  it("يحتوي على كافة أيام الأسبوع السبعة باللغة العربية", () => {
    expect(DAYS_OF_WEEK).toHaveLength(7);
    expect(DAYS_OF_WEEK[0]).toEqual({ id: 0, nameAr: "الأحد", shortAr: "أحد" });
    expect(DAYS_OF_WEEK[2]).toEqual({ id: 2, nameAr: "الثلاثاء", shortAr: "ثلاثاء" });
    expect(DAYS_OF_WEEK[4]).toEqual({ id: 4, nameAr: "الخميس", shortAr: "خميس" });
    expect(DAYS_OF_WEEK[6]).toEqual({ id: 6, nameAr: "السبت", shortAr: "سبت" });
    expect(ALL_DAYS_MASK).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("يحسب يوم الأسبوع بتوقيت بغداد (UTC+3) بدقة حتى عند أطراف منتصف الليل", () => {
    // 2026-10-11 الساعة 22:00:00 بتوقيت UTC هو الأحد
    // في بغداد (UTC+3) يكون 2026-10-12 الساعة 01:00:00 (الإثنين = 1)
    const sundayNightUtc = new Date("2026-10-11T22:00:00.000Z");
    expect(getBaghdadDayOfWeek(sundayNightUtc)).toBe(1); // الإثنين
    expect(getBaghdadDayName(sundayNightUtc)).toBe("الإثنين");

    // 2026-10-13 الساعة 12:00:00 بتوقيت UTC هو الثلاثاء (2)
    const tuesdayUtc = new Date("2026-10-13T12:00:00.000Z");
    expect(getBaghdadDayOfWeek(tuesdayUtc)).toBe(2); // الثلاثاء
    expect(getBaghdadDayName(tuesdayUtc)).toBe("الثلاثاء");
  });

  it("يفحص صلاحية اليوم عند تقييد العرض بأيام محددة (مثل الثلاثاء أو الخميس)", () => {
    const tuesdayUtc = new Date("2026-10-13T12:00:00.000Z"); // الثلاثاء (2)
    const wednesdayUtc = new Date("2026-10-14T12:00:00.000Z"); // الأربعاء (3)

    // عرض مخصص للثلاثاء والخميس فقط [2, 4]
    const tuesdayThursday = [2, 4];

    expect(isDayActive(tuesdayUtc, tuesdayThursday)).toBe(true);
    expect(isDayActive(wednesdayUtc, tuesdayThursday)).toBe(false);

    // إذا كانت القائمة فارغة أو غير محددة، فيعتبر الكوبون فعالاً طوال الأسبوع
    expect(isDayActive(tuesdayUtc, null)).toBe(true);
    expect(isDayActive(tuesdayUtc, undefined)).toBe(true);
    expect(isDayActive(tuesdayUtc, [])).toBe(true);
    expect(isDayActive(tuesdayUtc, ALL_DAYS_MASK)).toBe(true);
  });

  it("يصيغ التسمية النصية للأيام بدقة ووضوح لبطاقة الكوبون والشاشات", () => {
    expect(formatActiveDays(null)).toBe("طوال أيام الأسبوع");
    expect(formatActiveDays([])).toBe("طوال أيام الأسبوع");
    expect(formatActiveDays(ALL_DAYS_MASK)).toBe("طوال أيام الأسبوع");

    expect(formatActiveDays([2])).toBe("كل الثلاثاء فقط");
    expect(formatActiveDays([2, 4])).toBe("كل الثلاثاء والخميس");
    expect(formatActiveDays([0, 2, 4])).toBe("أيام: الأحد، الثلاثاء، الخميس");
  });
});
