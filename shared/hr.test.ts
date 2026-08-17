/**
 * عقد وسم بند المسيّر المحتاج انتباهاً — الحدّ الفاصل بين `payroll/generate.ts` (يكتبه)
 * وشاشة الرواتب (تقرؤه). كسرُه صامتٌ تماماً: البند يُصرف ناقصاً بلا أن يراه أحد.
 */
import { describe, expect, it } from "vitest";
import { PAYROLL_ITEM_ATTENTION_PREFIX, payrollItemNeedsAttention } from "./hr";

describe("وسم بند المسيّر المحتاج انتباهاً", () => {
  it("الوسم نصٌّ عربيّ لا إيموجي — حارس check:emoji يرفض الرموز في الواجهة", () => {
    expect(PAYROLL_ITEM_ATTENTION_PREFIX).toBe("تنبيه:");
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(PAYROLL_ITEM_ATTENTION_PREFIX)).toBe(false);
  });

  it("يكتشف الملاحظة الموسومة كما يكتبها التوليد بالضبط", () => {
    const note = `${PAYROLL_ITEM_ATTENTION_PREFIX} 2 يوم بلا انصراف (2026-06-08، 2026-06-09) — غير محتسَبة — أجر بالحضور: 192.00 من 208.00 ساعة`;
    expect(payrollItemNeedsAttention(note)).toBe(true);
  });

  it("ملاحظةٌ عادية أو فارغة أو معدومة ⇒ لا وسم (لا إنذارٌ كاذب على كل بند)", () => {
    expect(payrollItemNeedsAttention("أجر بالحضور: 208.00 من 208.00 ساعة")).toBe(false);
    expect(payrollItemNeedsAttention("")).toBe(false);
    expect(payrollItemNeedsAttention(null)).toBe(false);
    expect(payrollItemNeedsAttention(undefined)).toBe(false);
  });

  it("الوسم يُفحص في **بداية** الملاحظة وحدها — ذكرُه في وسطها ليس وسماً", () => {
    // التوليد يستعمل unshift لهذا السبب: القصّ عند ٢٥٥ محرفاً يقصّ من الآخِر، فالبداية تنجو.
    expect(payrollItemNeedsAttention(`أجر بالحضور: 100 ساعة — ${PAYROLL_ITEM_ATTENTION_PREFIX} شيء`)).toBe(false);
  });
});
