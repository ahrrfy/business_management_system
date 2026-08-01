// تطبيع جدول الدوام ووصفُ فرق حزمة الأجر — نواةٌ نقيّة يتقاسمها الخادم والعميل.
//
// الثوابت المحروسة:
//   ن١) الشكل القديم (رقمٌ = ساعات) يُقبل ويُحوَّل — وإلا عرض المحرّر أصفاراً وأرسل
//       أرقاماً خاماً يرفضها تحقّقُ الموجّه ⇒ انسدادُ مسار تغيير الأجر لغير الأدمن.
//   ن٢) يومٌ ناقصٌ داخل جدولٍ موجود = راحة (صفر)، لا ثمانيَ ساعاتٍ افتراضية.
//   ن٣) غيابُ الجدول كلّه ⇒ الاحتياطي كاملاً (احتياطُ الكائن لا دمجٌ يوميّ).
//   ن٤) الفرق يُوصَف **باليوم الذي تغيّر وحده** بقيمه قبل/بعد — هو كلُّ ما يستند إليه
//       المعتمِد الثاني، فإن غاب صار الاعتماد توقيعاً على غير مرئيّ.
import { describe, expect, it } from "vitest";
import { describeWageDiff, normalizeScheduleShape, changedWageFields, type WageProfileShape } from "../wageDiff";

const FALLBACK = {
  الأحد: { hours: 8, rate: null }, الاثنين: { hours: 8, rate: null }, الثلاثاء: { hours: 8, rate: null },
  الأربعاء: { hours: 8, rate: null }, الخميس: { hours: 8, rate: null }, الجمعة: { hours: 0, rate: null },
  السبت: { hours: 8, rate: null },
};

const profile = (over: Partial<WageProfileShape> = {}): WageProfileShape => ({
  payType: "monthly",
  salary: "900000.00",
  allowances: "50000.00",
  attendanceExempt: false,
  dayRates: { الأحد: 5000, الاثنين: 5000, الثلاثاء: 5000, الأربعاء: 5000, الخميس: 5500, الجمعة: 7500, السبت: 6000 },
  workSchedule: FALLBACK,
  ...over,
});

describe("normalizeScheduleShape (ن١–ن٣)", () => {
  it("ن١) يحوّل الشكل القديم (رقم = ساعات) إلى {hours, rate}", () => {
    const out = normalizeScheduleShape({ الأحد: 8, الاثنين: 6 }, FALLBACK);
    expect(out.الأحد).toEqual({ hours: 8, rate: null });
    expect(out.الاثنين).toEqual({ hours: 6, rate: null });
  });

  it("ن٢) واليومُ الناقص داخل جدولٍ موجود راحةٌ لا ثماني ساعات", () => {
    const out = normalizeScheduleShape({ الأحد: 8 }, FALLBACK);
    expect(out.السبت).toEqual({ hours: 0, rate: null });
    expect(Object.keys(out)).toHaveLength(7);
  });

  it("ن٣) وغيابُ الجدول كلّه يقع على الاحتياطي كاملاً", () => {
    expect(normalizeScheduleShape(null, FALLBACK)).toEqual(FALLBACK);
    expect(normalizeScheduleShape("تالف", FALLBACK)).toEqual(FALLBACK);
  });

  it("ساعاتٌ/سعرٌ غير موجب يُطبَّعان صفراً/مُشتقّاً (لا يُعدّان تغييراً)", () => {
    const out = normalizeScheduleShape({ الأحد: { hours: -3, rate: 0 }, الاثنين: { hours: 8, rate: null } }, FALLBACK);
    expect(out.الأحد).toEqual({ hours: 0, rate: null });
    expect(out.الاثنين).toEqual({ hours: 8, rate: null });
  });

  it("والتطبيع مُتماثل (idempotent) — تطبيعُ مُطبَّعٍ لا يغيّره", () => {
    const once = normalizeScheduleShape({ الأحد: 8, الجمعة: { hours: 4, rate: 12000 } }, FALLBACK);
    expect(normalizeScheduleShape(once, FALLBACK)).toEqual(once);
  });
});

describe("describeWageDiff (ن٤)", () => {
  it("بلا تغيير ⇒ لا أسطر", () => {
    expect(describeWageDiff(profile(), profile())).toEqual([]);
  });

  it("يسمّي الراتب بقيمتَيه", () => {
    const rows = describeWageDiff(profile(), profile({ salary: "1200000.00" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "salary", before: "900,000", after: "1,200,000" });
  });

  it("ويُفصّل اليوم المتغيّر وحده من الجدول لا الأيام السبعة", () => {
    const rows = describeWageDiff(
      profile(),
      profile({ workSchedule: { ...FALLBACK, الجمعة: { hours: 4, rate: 12000 } } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toContain("الجمعة");
    expect(rows[0].before).toBe("راحة");
    expect(rows[0].after).toBe("4 ساعة بسعر 12,000");
  });

  it("ويُفصّل سعر يومٍ للساعيّ", () => {
    const rows = describeWageDiff(profile(), profile({ dayRates: { ...profile().dayRates, الأحد: 9000 } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "dayRates", before: "5,000", after: "9,000" });
  });

  it("والإعفاء وطريقة الأجر بنصٍّ مفهوم لا برمز", () => {
    const rows = describeWageDiff(profile(), profile({ attendanceExempt: true, payType: "hourly" }));
    expect(rows.map((r) => r.key).sort()).toEqual(["attendanceExempt", "payType"]);
    expect(rows.find((r) => r.key === "attendanceExempt")).toMatchObject({ before: "خاضع للحضور", after: "معفى" });
  });

  it("changedWageFields يجمع الحقول بلا تكرارٍ لأيامٍ متعددة", () => {
    const to = profile({ workSchedule: { ...FALLBACK, الجمعة: { hours: 4, rate: null }, السبت: { hours: 0, rate: null } } });
    expect(changedWageFields(profile(), to)).toEqual(["workSchedule"]);
  });

  it("وبصمةٌ غائبة (ترقية قديمة بلا حزمة) ⇒ لا أسطر لا انهيار", () => {
    expect(describeWageDiff(null, profile())).toEqual([]);
    expect(describeWageDiff(profile(), null)).toEqual([]);
  });
});
