import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("../CashVarianceResolutionPanel.tsx", import.meta.url), "utf8");
const hub = readFileSync(new URL("../../../pages/TreasuryHub.tsx", import.meta.url), "utf8");

describe("عقد واجهة تسوية فروقات النقد", () => {
  it("تربط الإدراج والقائمة والتفاصيل والاعتماد والرفض", () => {
    for (const endpoint of ["list", "get", "propose", "approve", "reject"]) {
      expect(panel).toContain(`cashVariance.${endpoint}.use`);
    }
    expect(hub).toContain('value: "cash-variance"');
    expect(hub).toContain('label: "فروقات النقد"');
  });

  it("تعلن حالات التحميل والخطأ وتمنع الاعتماد المتكرر أثناء التنفيذ", () => {
    expect(panel).toContain("<LoadingState");
    expect(panel).toContain("<ErrorState");
    expect(panel).toContain("approveM.isPending || rejectM.isPending");
    expect(panel).toContain("expectedVersion: selected.version");
    expect(panel).toContain("لا يستطيع المنشئ أو منفذ العد أو الموظف المسؤول اعتماد الحالة");
    expect(panel).not.toContain("responsibleUserId");
    expect(panel).not.toContain("cashVariance.responsibleUsers");
    expect(panel).toContain('sourceType === "CUSTODY"');
    expect(panel).toContain("لا يعيّن موظفاً");
  });
});
