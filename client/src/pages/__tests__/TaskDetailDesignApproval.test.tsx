import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { designApprovalSelfReviewBlocked } from "../TaskDetail";

const taskDetailSource = readFileSync(new URL("../TaskDetail.tsx", import.meta.url), "utf8");
const cardSource = readFileSync(
  new URL("../../components/workorder/DesignApprovalCard.tsx", import.meta.url),
  "utf8",
);
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
    expect(cardSource).toContain("workOrderDesignApproval.getCurrent");
    expect(cardSource).toContain("workOrderDesignApproval.request");
    expect(cardSource).not.toContain("workOrders.requestDesignApproval");
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
    expect(cardSource).toContain("requestInput ??");
    expect(cardSource).toContain("request.mutate(input)");
    expect(taskDetailSource).toContain("replayInput ??");
    expect(taskDetailSource).toContain("decide.mutate(input)");
    // القرارُ داخل البطاقة يحمل نفسَ حماية التكرار (مفتاحُ قرارٍ ثابتٌ لكلّ محاولة).
    expect(cardSource).toContain("replayInput ??");
    expect(cardSource).toContain("decide.mutate(input)");
  });

  it("⭐ لا تشترط البطاقةُ رفعَ ملفّ تصميم قبل طلب الاعتماد (قرار المالك ١/٩/٢٦)", () => {
    // الحائطُ القديم كان شرطاً في الواجهة وحدها؛ الخادمُ يُثبّت النسخة تلقائياً.
    expect(cardSource).not.toContain("revision != null && approval == null");
    // نصُّ الحائط المعروض للمستخدم — لا عبارةُ التوثيق التي تقتبسه في رأس الملفّ.
    expect(cardSource).not.toContain("لا توجد نسخة تصميم مثبتة بعد");
    expect(cardSource).toContain("رفعُ ملفّ التصميم غير مطلوب");
    expect(cardSource).toContain("const mayRequest = canManage && !terminal && approval == null");
  });

  it("⭐ تحسم البطاقةُ الاعتماد في مكانه بسلطة المدير وفصل الواجبات", () => {
    expect(cardSource).toContain("workOrderDesignApproval.decide");
    expect(cardSource).toContain("canDecideDesignApproval");
    expect(cardSource).toContain("designApprovalSelfReviewBlocked");
    // الأطرافُ الأربعة نفسها التي يرفضها الخادم في `forbiddenActors`.
    expect(cardSource).toContain("approval?.requestedBy");
    expect(cardSource).toContain("revision?.createdBy");
    expect(cardSource).toContain("order?.assignedTo");
    expect(cardSource).toContain("task?.assignedTo");
    // ونفسُ حدّ الخادم على السبب والمرجع — لا زرَّ يَعِد بما سيُرفض.
    expect(cardSource).toContain("reason.trim().length >= 3");
  });
});
