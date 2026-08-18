/**
 * حارسُ «المدقّق قراءةٌ محضة» — `scripts/audit-payroll-decisions.mjs`.
 *
 * السكربت يُشغَّل على **قاعدة الإنتاج أثناء الدوام** (`pnpm audit:payroll`)، وأمانُه كلُّه
 * قائمٌ على أنه لا يكتب شيئاً. وذلك ليس خاصيّةً يحفظها التعليق: عبارةُ كتابةٍ تُضاف لاحقاً
 * بحسن نيّة (تصحيحُ صفٍّ، وسمُ بندٍ «مراجَع») تجعله يُعدّل رواتب حقيقية.
 *
 * ⚠️ **الاختبار الذاتيّ (س٠) ليس زينةً**: النسخة الأولى من هذا الحارس كانت **لا تمسك**
 * `UPDATE payrollItems SET …` لأن نمطها انتهى بـ`update\s+\w` متبوعاً بـ`\b` — والحرفُ
 * الواحد الذي يلتقطه `\w` يليه حرفُ كلمةٍ آخر فيسقط حدُّ الكلمة. أمسكها حقنٌ يدويّ لعبارة
 * كتابة، فصار الحقنُ حالةً دائمة: حارسٌ لا يُثبَت أنه يَفشل عند العطب ليس حارساً بل طُمأنينة.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("scripts/audit-payroll-decisions.mjs", "utf8");

/** أسطرُ الشيفرة وحدها — التعليقات تذكر أسماء العبارات شرحاً لا تنفيذاً. */
function codeLinesOf(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trim();
    return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

// بلا `\b` ختاميّ: البديل الذي ينتهي بـ`\w` يجعل حدَّ الكلمة يسقط دائماً (علّة النسخة الأولى).
// وحدُّ الكلمة الابتدائيّ يكفي لمنع الإنذار الكاذب على `updatedAt` و`createConnection`.
const WRITE_SQL =
  /\b(insert\s+into|update\s+[`"'\w]|delete\s+from|drop\s+(table|database|index|schema)|alter\s+table|truncate\s+(table\s+)?[`"'\w]|create\s+(table|database|index|schema)|replace\s+into|set\s+foreign_key_checks)/i;

const LOCKING = /\b(start\s+transaction|for\s+update|lock\s+in\s+share|lock\s+tables)/i;

const offenders = (src: string, re: RegExp) => codeLinesOf(src).filter((l) => re.test(l));

describe("audit-payroll-decisions.mjs — قراءةٌ محضة", () => {
  it("س٠) الحارس نفسه يمسك عبارات الكتابة (اختبارٌ ذاتيّ)", () => {
    const mustCatch = [
      'await q("UPDATE payrollItems SET note = ? WHERE id = ?", ["مراجَع", 1]);',
      'await q("INSERT INTO payrollItems (runId) VALUES (?)", [1]);',
      'await q("DELETE FROM attendance WHERE id = ?", [1]);',
      'await q("TRUNCATE TABLE payrollRuns");',
      'await q("ALTER TABLE employees ADD COLUMN x INT");',
      'await q("DROP TABLE payrollItems");',
      'await q("REPLACE INTO branches VALUES (1)");',
    ];
    for (const bad of mustCatch) expect(WRITE_SQL.test(bad), bad).toBe(true);

    // ولا يُنذر كاذباً على ما يستعمله المدقّق فعلاً:
    const mustPass = [
      "const conn = await createConnection(url);",
      "SELECT e.updatedAt FROM employees e",
      "ORDER BY e.updatedAt DESC",
      "AND e.updatedAt > ?",
    ];
    for (const ok of mustPass) expect(WRITE_SQL.test(ok), ok).toBe(false);
  });

  it("لا عبارة كتابةٍ واحدة في السكربت", () => {
    expect(offenders(SRC, WRITE_SQL)).toEqual([]);
  });

  it("لا معاملة ولا قفل — قراءةٌ لا تحجز صفّاً على قاعدةٍ حيّة", () => {
    expect(LOCKING.test('await q("SELECT 1 FOR UPDATE")')).toBe(true); // الحارس يمسك
    expect(offenders(SRC, LOCKING)).toEqual([]);
  });

  it("يقرأ وسمَ الانتباه من shared/hr.ts ولا يُكرّره نصّاً", () => {
    // نسخةٌ ثانية تنجرف صامتةً فيكفّ المدقّق عن رؤية البنود الموسومة **ويُطمئن كاذباً**.
    expect(SRC).toContain("PAYROLL_ITEM_ATTENTION_PREFIX");
    expect(SRC).toContain("shared/hr.ts");
    expect(codeLinesOf(SRC).filter((l) => /["']تنبيه:["']/.test(l))).toEqual([]);
  });
});
