/**
 * تدقيق Codex (م٤) — عقدُ مصدرٍ نصّيّ (بلا قاعدة) على أنّ `logAudit` لإنشاء السند يُمرَّر إليه
 * فرعُ السند صراحةً. رفيقٌ لاختبار التكامل `voucherAuditBranch.test.ts` (الذي يُثبت السلوكَ
 * على قاعدةٍ حيّة): هذا يحرس السطرَ نفسه بلا قاعدة فيبقى قابلاً للتشغيل في `test:unit`.
 *
 * لماذا: أدمنٌ عابرُ الفروع بلا فرعٍ مُسنَد يُنشئ سنداً على `voucherBranchId` المختار صراحةً، لكنّ
 * `logAudit(ctx, …)` يشتقّ الفرعَ من `ctx.user.branchId` (= null) ⇒ صفٌّ بفرعٍ NULL يختفي من
 * تدقيق الفرع. الإصلاح: تمريرُ `branchId: voucherBranchId` داخل حمولة `logAudit`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../voucherRouter.ts", import.meta.url), "utf8");

describe("عقد تدقيق إنشاء السند — فرعُ السند صريحٌ على الأثر", () => {
  it("logAudit للإنشاء يُمرِّر branchId: voucherBranchId بين entityId وnewValue", () => {
    // بين معرّف الكيان وحمولة التغيير يجب أن يُثبَّت فرعُ السند صراحةً (تسمح النقطتان `[\s\S]` بأسطر
    // التعليق). لا يُطابق `const scopedInput = { ...input, branchId: voucherBranchId }` (لا يسبقه
    // entityId، ولا يتلوه newValue).
    expect(source).toMatch(
      /entityId: res\.receiptId,[\s\S]*?branchId: voucherBranchId,[\s\S]*?newValue: \{/,
    );
  });

  it("يبقى للأدمن بلا فرعٍ مُسنَد مسارٌ صريح (voucherBranchId مصدرُ الفرع لا ctx.user.branchId)", () => {
    // الفرعُ المُستعمَل للسند مشتقٌّ صراحةً، لا مأخوذٌ من الفاعل صامتاً.
    expect(source).toContain("const voucherBranchId =");
    expect(source).toContain("input.branchId ?? assignedBranchId");
  });
});
