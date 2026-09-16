import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * مِسبارٌ نصّيّ على [`NextActionChip.tsx`] — يفحص العقودَ التي لو انحرفت لأخفت العلّةَ التي
 * صُمّمت الرقاقةُ لإظهارها. لا يفحص التصميمَ ولا الاختصار، فذلك ذوقٌ لا حارس. يفحص:
 *  · `dir="rtl"` مضبوطةٌ على حاويةٍ حاويةٍ للأيقونة+النصّ+الرابط ⇒ الترتيب ينعكس تلقائياً.
 *  · **بلا `toLocaleString("ar-")`** — أرقام لاتينية دائماً (حارس `check:locale-numbers`).
 *  · موانع `blockedBy` تُعرَض **نصّاً بنصّ** (لا تُعدَّ ولا تُختصر) — علّة «الزرّ المعطَّل
 *    بأربعة شروطٍ لا يقول أيُّها فشل».
 *  · نصّ `nextActionOwnerLabel` مُستهلَك — يمنع انزلاقاً إلى قواميس أدوارٍ محلّية.
 */

const SOURCE = readFileSync(
  new URL("./NextActionChip.tsx", import.meta.url),
  "utf8",
);

describe("NextActionChip — عقودُ العرض", () => {
  it("`dir=\"rtl\"` مُطبّق على الحاوية", () => {
    expect(SOURCE).toContain('dir="rtl"');
  });

  it("لا `toLocaleString` بأرقامٍ عربية — الأرقام لاتينيّة", () => {
    expect(SOURCE).not.toMatch(/toLocaleString\(["']ar-/);
    expect(SOURCE).not.toMatch(/Intl\.NumberFormat\(["']ar-(?!.*-nu-latn)/);
  });

  it("`nextActionOwnerLabel` مُستهلَك من العقد المشترك", () => {
    expect(SOURCE).toContain("nextActionOwnerLabel");
    expect(SOURCE).toContain('from "@shared/nextAction"');
  });

  it("موانع التنفيذ تُعرَض بنصّها الأصليّ (خرائط `map(line`)", () => {
    expect(SOURCE).toMatch(/blockedBy[\s\S]{0,200}\.map/);
  });

  it("رابطُ `href` مشروطٌ بالوجود لا يُطبع فارغاً", () => {
    expect(SOURCE).toContain("nextAction.href != null");
  });

  it("سببُ النهاية `terminalReason` يُعرَض حين لا خطوة — لا مربّعٌ فارغ", () => {
    expect(SOURCE).toContain("لا خطوة قادمة");
    expect(SOURCE).toContain("terminalReason");
  });
});
