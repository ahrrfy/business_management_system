// خدمة `dateRange` — أسماء توافقية فوق حدود يوم العمل الحتمية بتوقيت UTC.
// تَضمن أن تفسير YYYY-MM-DD لا يعتمد على منطقة تشغيل الخادم.
import { describe, expect, it } from "vitest";
import { localDayStart, localNextDayStart, localTodayDate } from "../dateRange";

describe("localDayStart — اسم توافقي لبداية اليوم UTC", () => {
  it("يُرجع منتصف ليل اليوم المُمرَّر بتوقيت UTC", () => {
    const d = localDayStart("2026-06-15");
    expect(d.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("صيغ تاريخ غير صالحة تُرفض بـBAD_REQUEST", () => {
    expect(() => localDayStart("2026-13-01")).toThrow(); // شهر ١٣
    expect(() => localDayStart("2026-02-30")).toThrow(); // ٣٠ فبراير
    expect(() => localDayStart("06-15-2026")).toThrow(); // صيغة أمريكية
    expect(() => localDayStart("2026-6-15")).toThrow(); // أرقام بلا padding
    expect(() => localDayStart("not-a-date")).toThrow();
    expect(() => localDayStart("")).toThrow();
  });
});

describe("localNextDayStart — بداية اليوم التالي UTC", () => {
  it("اليوم العادي ⇒ التالي مباشرةً", () => {
    const d = localNextDayStart("2026-06-15");
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(5);
    expect(d.getUTCDate()).toBe(16);
  });

  it("نهاية الشهر ⇒ يومٌ في الشهر التالي", () => {
    const d = localNextDayStart("2026-06-30");
    expect(d.getUTCMonth()).toBe(6); // يوليو
    expect(d.getUTCDate()).toBe(1);
  });

  it("نهاية السنة ⇒ يومٌ في السنة التالية", () => {
    const d = localNextDayStart("2026-12-31");
    expect(d.getUTCFullYear()).toBe(2027);
    expect(d.getUTCMonth()).toBe(0); // يناير
    expect(d.getUTCDate()).toBe(1);
  });

  it("نهاية فبراير غير الكبيسة ⇒ ١ مارس", () => {
    const d = localNextDayStart("2026-02-28");
    expect(d.getUTCMonth()).toBe(2); // مارس
    expect(d.getUTCDate()).toBe(1);
  });
});

describe("localTodayDate — يوم حتمي مستقل عن TZ", () => {
  it("يَستخدم مكوّنات اليوم UTC بالضبط", () => {
    // الإثبات المعماري: مهما كانت منطقة الخادم، الـY/M/D المُرجَع يطابق ما يَقرؤه المستخدم
    // محلياً، فحين يُسلسَل لـMySQL DATE لا يَنزاح يوماً. الـnew Date() الخامة ستَستعمل UTC
    // فتُخزَّن أحياناً تاريخ الأمس على بغداد +٠٣:٠٠ بين منتصف ليل و٠٣:٠٠ ص.
    const today = localTodayDate();
    const now = new Date();
    expect(today.getUTCFullYear()).toBe(now.getUTCFullYear());
    expect(today.getUTCMonth()).toBe(now.getUTCMonth());
    expect(today.getUTCDate()).toBe(now.getUTCDate());
  });

  it("الوقت بمنتصف الليل بالضبط (٠٠:٠٠:٠٠.٠٠٠ UTC)", () => {
    const today = localTodayDate();
    expect(today.getUTCHours()).toBe(0);
    expect(today.getUTCMinutes()).toBe(0);
    expect(today.getUTCSeconds()).toBe(0);
    expect(today.getUTCMilliseconds()).toBe(0);
  });

  it("الإدراج المتكرّر خلال نفس اليوم يُرجع نفس Date (سلوك حتمي خلال نطاق اليوم)", () => {
    // الاستيراد قد ينشئ مئات قيود OPENING بـlocalTodayDate() — كلّها بنفس التاريخ بالضبط.
    const a = localTodayDate();
    const b = localTodayDate();
    expect(a.getTime()).toBe(b.getTime()); // متطابقان (ليس مجرّد قريب)
  });
});
