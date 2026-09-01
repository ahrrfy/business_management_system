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
    expect(panel).toContain("selected.decisionPolicy.canDecide");
    expect(panel).toContain("selected.decisionPolicy.blockedReason");
    expect(panel).toContain("قرار فصل المهام صادر من الخادم");
    expect(panel).not.toContain("responsibleUserId");
    expect(panel).not.toContain("cashVariance.responsibleUsers");
    expect(panel).toContain('sourceType === "CUSTODY"');
    expect(panel).toContain("لا يعيّن موظفاً");
  });

  it("يفصل فرع السجل عن نموذج المصدر ويعرض الحقائق والأثر قبل قرار مؤكد", () => {
    expect(panel).toContain("filterBranchId");
    expect(panel).toContain("فرع سجل فروقات النقد");
    expect(panel).toContain("CASH_VARIANCE_REASON_CODES_BY_SOURCE[sourceType]");
    for (const label of ["المتوقع", "الفعلي", "الفرق", "المسؤول", "الأثر المحاسبي"]) {
      expect(panel).toContain(label);
    }
    expect(panel).toContain("await confirm({");
    expect(panel).toContain("اعتماد وترحيل القيد");
  });

  it("يحمّل طابور الاعتماد كاملاً ولا يخفي القضايا الأقدم بعد حد الصفحة", () => {
    expect(panel).toContain("cashVariance.list.useInfiniteQuery");
    expect(panel).toContain("pages.flatMap((page) => page.rows)");
    expect(panel).toContain("getNextPageParam");
    expect(panel).toContain("listQ.fetchNextPage()");
    expect(panel).toContain("listQ.hasNextPage");
    expect(panel).toContain("إجمالي الحالات");
  });
});
