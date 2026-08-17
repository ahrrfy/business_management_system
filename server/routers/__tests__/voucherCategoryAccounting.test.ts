import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../voucherRouter.ts", import.meta.url),
  "utf8",
);

describe("voucher category accounting router contract", () => {
  it("requires a validated posting role for every custom category", () => {
    expect(source).toContain("postingRole: voucherCategoryPostingRole");
    expect(source).toContain("assertVoucherCategoryDefinition({");
    expect(source).toContain("postingRole: input.postingRole");
  });

  it("locks classification once any receipt references the category", () => {
    expect(source).toContain('.for("update")');
    expect(source).toContain(
      ".where(eq(receipts.voucherCategoryId, input.id))",
    );
    expect(source).toContain(
      "لا يمكن تغيير الحساب المقابل لفئة مرتبطة بأي سند",
    );
  });

  it("merges only into an active direction-compatible classified target", () => {
    expect(source).toContain(
      'target.direction === "BOTH" || target.direction === source.direction',
    );
    expect(source).toContain(
      "source.postingRole == null || source.postingRole === target.postingRole",
    );
    expect(source).toContain(
      "الدمج المحاسبي يتطلب فئة هدف بنفس الحساب المقابل",
    );
    const receiptLockIndex = source.indexOf(".orderBy(asc(receipts.id))");
    const categoryLockIndex = source.indexOf(
      ".orderBy(asc(voucherCategories.id))",
    );
    expect(receiptLockIndex).toBeGreaterThan(-1);
    expect(categoryLockIndex).toBeGreaterThan(-1);
    expect(receiptLockIndex).toBeLessThan(categoryLockIndex);
  });

  it("offers a locked audited remediation route and preserves specialized requests", () => {
    expect(source).toContain("unclassifiedOther: treasuryManagerReadProcedure");
    expect(source).toContain(
      "assignHistoricalCategory: treasuryManagerProcedure",
    );
    expect(source).toContain("isCanonicalSystemPaymentRequest(");
    expect(source).toContain("reservedSystemEnvelope");
    expect(source).toContain("hasSystemPaymentRequestEnvelope(");
    expect(source).toContain("isSystemPaymentReference(row.referenceNumber)");
    expect(source).toContain(
      "isSystemPaymentReference(receipt.referenceNumber)",
    );
    expect(source).toContain("reservedSystemSource");
    expect(source).toContain("await assertBranchOwnership(");
    expect(source).toContain("يحتاج مساراً تخصصياً من وحدته المصدرية");
    expect(source).toContain("await logAuditTx(tx, ctx, {");
    expect(source).toContain('action: "voucherCategory.remediateHistorical"');
  });

  it("uses the same accountant treasury capability for every category write", () => {
    expect(source).not.toContain("create: adminProcedure");
    expect(source).not.toContain("update: adminProcedure");
    expect(source).not.toContain("merge: adminProcedure");
    // كتابات الفئة بياناتٌ مرجعية عامّة (الجدول بلا branchId) ⇒ البوّابة العامّة: نفس قدرة
    // الوحدة تماماً بلا اشتراط فرعٍ مُسنَد، الذي كان يصدّ محاسب الإدارة عن إنشاء فئةٍ إلزامية.
    expect(source).toContain("create: treasuryGlobalProcedure");
    expect(source).toContain("update: treasuryGlobalProcedure");
    expect(source).toContain("setActive: treasuryGlobalProcedure");
    expect(source).toContain("restoreDefaults: treasuryGlobalProcedure");
    // كل ما يكتب في `receipts` يبقى مقصوراً بالفرع: الدمج ينقل سندات فئةٍ إلى أخرى.
    expect(source).toContain("merge: treasuryManagerProcedure");
    expect(source).toContain("assignHistoricalCategory: treasuryManagerProcedure");
    // ولا تخفيف في القدرة نفسها: نفس الوحدة ونفس المستوى ونفس قائمة الأدوار.
    const trpcSource = readFileSync(
      new URL("../../trpc.ts", import.meta.url),
      "utf8",
    );
    expect(trpcSource).toMatch(
      /treasuryGlobalProcedure = t\.procedure\.use\(\s*requireModuleGate\(\["manager", "accountant"\], "treasury", "FULL"\)/,
    );
    expect(trpcSource).toMatch(
      /treasuryGlobalReadProcedure = t\.procedure\.use\(\s*requireModuleGate\(\["manager", "accountant"\], "treasury", "READ"\)/,
    );
  });

  it("seeds the default catalog through one idempotent audited route", () => {
    expect(source).toContain("ensureDefaultVoucherCategories()");
    expect(source).toContain('action: "voucherCategory.restoreDefaults"');
    // معرّف الإدراج عبر المُستخرِج الموحّد — لا Number(undefined) ⇒ NaN صامت للواجهة/التدقيق.
    expect(source).toContain("const id = extractInsertId(");
  });

  it("does not emit a second audit record for an exact payment-resubmission replay", () => {
    expect(source).toContain(
      "const res = await resubmitRejectedExpensePayment(",
    );
    expect(source).toContain("if (!res.replayed)");
    expect(source).toContain('action: "voucher.systemPayment.resubmit"');
  });
});
