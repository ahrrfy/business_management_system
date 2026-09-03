import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { designApprovalSelfReviewBlocked } from "../TaskDetail";

const taskDetailSource = readFileSync(new URL("../TaskDetail.tsx", import.meta.url), "utf8");
const evidenceSource = readFileSync(
  new URL("../../../../shared/designApprovalEvidence.ts", import.meta.url),
  "utf8",
);

describe("واجهة حوكمة اعتماد التصميم", () => {
  it("تمنع الطالب ومنشئ النسخة والفني والمكلّف من اعتماد عملهم", () => {
    expect(designApprovalSelfReviewBlocked(10, [10, 20, 30, 40])).toBe(true);
    expect(designApprovalSelfReviewBlocked(20, [10, 20, 30, 40])).toBe(true);
    expect(designApprovalSelfReviewBlocked(30, [10, 20, 30, 40])).toBe(true);
    expect(designApprovalSelfReviewBlocked(40, [10, 20, 30, 40])).toBe(true);
    expect(designApprovalSelfReviewBlocked(50, [10, 20, 30, 40])).toBe(false);
  });

  it("تستخدم عقد الاعتماد المتخصص وتزيل مسار الحسم العام من مهمة التصميم", () => {
    expect(taskDetailSource).toContain("workOrderDesignApproval.getByTask");
    expect(taskDetailSource).toContain("workOrderDesignApproval.decide");
    expect(taskDetailSource).toContain("!isDesignApprovalTask && canWrite");
    expect(taskDetailSource).toContain("!isDesignApprovalTask && canManage");
  });

  it("يفرض سبباً ودليلاً منظماً ويعرض النسخة والبصمة والدليل", () => {
    // التسمياتُ انتقلت إلى قاموسٍ مشترك (١/٩/٢٦) لأنّ القرارَ صار يُتّخذ من شاشتين؛ الحارسُ
    // يتبع المصدرَ الواحد بدل أن يُجمّد نسخةً محلّيةً في صفحةٍ بعينها.
    for (const evidenceType of [
      "WHATSAPP_MESSAGE",
      "CUSTOMER_SIGNATURE",
      "EMAIL",
      "ATTACHMENT",
      "OTHER",
    ]) {
      expect(evidenceSource).toContain(evidenceType);
    }
    expect(taskDetailSource).toContain("DESIGN_APPROVAL_EVIDENCE_LABELS");
    expect(taskDetailSource).toContain("contentHash");
    expect(taskDetailSource).toContain("customizationSnapshot");
    expect(taskDetailSource).toContain("evidenceReference");
    expect(taskDetailSource).toContain("reason.trim().length >= 3");
  });

  it("يحافظ على نفس حمولة الطلب والقرار عند إعادة المحاولة", () => {
    expect(taskDetailSource).toContain("replayInput ??");
    expect(taskDetailSource).toContain("decide.mutate(input)");
    // القرارُ داخل البطاقة يحمل نفسَ حماية التكرار (مفتاحُ قرارٍ ثابتٌ لكلّ محاولة).
  });


});
