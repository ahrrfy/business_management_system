import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { designApprovalSelfReviewBlocked } from "../TaskDetail";

const taskDetailSource = readFileSync(new URL("../TaskDetail.tsx", import.meta.url), "utf8");
const cardSource = readFileSync(
  new URL("../../components/workorder/DesignApprovalCard.tsx", import.meta.url),
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
    for (const evidenceType of [
      "WHATSAPP_MESSAGE",
      "CUSTOMER_SIGNATURE",
      "EMAIL",
      "ATTACHMENT",
      "OTHER",
    ]) {
      expect(taskDetailSource).toContain(evidenceType);
    }
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
  });
});
