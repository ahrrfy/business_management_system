// خدمة `dateRange` — حدود الفترة المحلية ومُساعد «اليوم محلياً».
// تَضمن أن إدراج عمود DATE لا يَنزاح يوماً عند تباين منطقة الخادم مع منطقة العمل (بغداد +٠٣:٠٠).
import { describe, expect, it } from "vitest";
import { localDayStart, localNextDayStart, localTodayDate } from "../dateRange";

describe("localDayStart — بداية اليوم محلياً", () => {
  it("يُرجع منتصف ليل اليوم المُمرَّر بمكوّناته المحلية", () => {
    const d = localDayStart("2026-06-15");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // يونيو
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
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

describe("localNextDayStart — بداية اليوم التالي محلياً", () => {
  it("اليوم العادي ⇒ التالي مباشرةً", () => {
    const d = localNextDayStart("2026-06-15");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(16);
  });

  it("نهاية الشهر ⇒ يومٌ في الشهر التالي", () => {
    const d = localNextDayStart("2026-06-30");
    expect(d.getMonth()).toBe(6); // يوليو
    expect(d.getDate()).toBe(1);
  });

  it("نهاية السنة ⇒ يومٌ في السنة التالية", () => {
    const d = localNextDayStart("2026-12-31");
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0); // يناير
    expect(d.getDate()).toBe(1);
  });

  it("نهاية فبراير غير الكبيسة ⇒ ١ مارس", () => {
    const d = localNextDayStart("2026-02-28");
    expect(d.getMonth()).toBe(2); // مارس
    expect(d.getDate()).toBe(1);
  });
});

describe("localTodayDate — حماية من انزياح TZ على عمود DATE", () => {
  it("يَستخدم مكوّنات اليوم المحلية بالضبط (تطابق new Date() المحلي)", () => {
    // الإثبات المعماري: مهما كانت منطقة الخادم، الـY/M/D المُرجَع يطابق ما يَقرؤه المستخدم
    // محلياً، فحين يُسلسَل لـMySQL DATE لا يَنزاح يوماً. الـnew Date() الخامة ستَستعمل UTC
    // فتُخزَّن أحياناً تاريخ الأمس على بغداد +٠٣:٠٠ بين منتصف ليل و٠٣:٠٠ ص.
    const today = localTodayDate();
    const now = new Date();
    expect(today.getFullYear()).toBe(now.getFullYear());
    expect(today.getMonth()).toBe(now.getMonth());
    expect(today.getDate()).toBe(now.getDate());
  });

  it("الوقت بمنتصف الليل بالضبط (٠٠:٠٠:٠٠.٠٠٠ محلياً)", () => {
    const today = localTodayDate();
    expect(today.getHours()).toBe(0);
    expect(today.getMinutes()).toBe(0);
    expect(today.getSeconds()).toBe(0);
    expect(today.getMilliseconds()).toBe(0);
  });

  it("الإدراج المتكرّر خلال نفس اليوم يُرجع نفس Date (سلوك حتمي خلال نطاق اليوم)", () => {
    // الاستيراد قد ينشئ مئات قيود OPENING بـlocalTodayDate() — كلّها بنفس التاريخ بالضبط.
    const a = localTodayDate();
    const b = localTodayDate();
    expect(a.getTime()).toBe(b.getTime()); // متطابقان (ليس مجرّد قريب)
  });
});
