import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../CommissionRuns.tsx", import.meta.url), "utf8");

describe("واجهة اعتماد تشغيلات العمولات", () => {
  it("تحول الاعتماد المباشر إلى طلب مسبب بحسب نطاق الشركة/الفرع", () => {
    expect(page).toContain("سبب طلب اعتماد الشركة");
    expect(page).toContain("سبب طلب اعتماد الفرع");
    expect(page).toContain("طلب اعتماد الشركة");
    expect(page).toContain("طلب اعتماد الفرع");
    expect(page).toContain("أُرسل طلب الاعتماد بانتظار مراجع مستقل");
  });

  it("تعرض قائمة المراجعة وتفصل أثر الفرع عن إقفال الشركة", () => {
    expect(page).toContain("approvalRequests.useQuery");
    expect(page).toContain("approveRequest.useMutation");
    expect(page).toContain("rejectRequest.useMutation");
    expect(page).toContain("اعتُمد نطاق الفرع بلا تغيير تشغيلة الشركة");
    expect(page).toContain("expectedVersion: Number(row.baseRunVersion)");
    expect(page).not.toContain("runs.unapprove.useMutation");
    expect(page).not.toContain("إلغاء اعتماد عمولات");
  });
});
