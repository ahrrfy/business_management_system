import { describe, expect, it } from "vitest";
import { backlogButtonSuffix, canApproveStudioCandidate, isQueuedStudioTask, studioTaskSelection } from "./studioBoardLabels";

describe("studio board labels", () => {
  it("selects independent image tasks sharing the same product", () => {
    const tasks = [
      { id: 21, productId: 7, status: "ASSIGNED" as const, assignedTo: 2, assigneeName: "مصوّر" },
      { id: 22, productId: 7, status: "ASSIGNED" as const, assignedTo: null, assigneeName: null },
      { id: 23, productId: 7, status: "PENDING_REVIEW" as const, assignedTo: 2, assigneeName: "مصوّر" },
    ];
    expect(studioTaskSelection(tasks, new Set([21]))).toEqual({
      queuedTaskIds: [22], allQueuedSelected: false, selectedAssignedTaskIds: [21], selectedActiveTaskIds: [21],
    });
    expect(studioTaskSelection(tasks, new Set([22]))).toEqual({
      queuedTaskIds: [22], allQueuedSelected: true, selectedAssignedTaskIds: [], selectedActiveTaskIds: [22],
    });
  });
  it("يميّز مهمة الطابور عن المهمة المسنَدة رغم تطابق الحالة", () => {
    // هذه هي حالة الإنتاج: ٤٢٨٥ مهمة ASSIGNED بلا منفّذ عُرضت «مسندة/قيد العمل».
    expect(isQueuedStudioTask({ status: "ASSIGNED", assigneeName: null })).toBe(true);
    expect(isQueuedStudioTask({ status: "ASSIGNED", assigneeName: "علي" })).toBe(false);
    expect(isQueuedStudioTask({ status: "IN_PROGRESS", assigneeName: null })).toBe(false);
    expect(isQueuedStudioTask({ status: "PENDING_REVIEW", assigneeName: null })).toBe(false);
  });

  it("لا يطبع صفراً إلا حين تكون المعاينة قد نجحت فعلاً", () => {
    expect(backlogButtonSuffix({ campaignSelected: false, isError: false, isPending: false })).toBe("(اختر حملة)");
    expect(backlogButtonSuffix({ campaignSelected: true, isError: true, isPending: false })).toBe("(تعذّرت المعاينة)");
    expect(backlogButtonSuffix({ campaignSelected: true, isError: false, isPending: true })).toBe("(…)");
    expect(backlogButtonSuffix({ campaignSelected: true, isError: false, isPending: false, count: 0 })).toBe("(0)");
  });

  it("يُعلن حجم الدفعة حين يتجاوز الناقصُ سقفَ التوليد الواحد", () => {
    expect(backlogButtonSuffix({ campaignSelected: true, isError: false, isPending: false, count: 4285, batchLimit: 500 })).toBe("(4285 — دفعة 500)");
    expect(backlogButtonSuffix({ campaignSelected: true, isError: false, isPending: false, count: 120, batchLimit: 500 })).toBe("(120)");
  });

  it("يمنع الاعتماد ما لم تظهر المعاينة", () => {
    const ready = { offline: false, storageDisabled: false, busy: false, reviewable: true, previewLoaded: true };
    expect(canApproveStudioCandidate(ready)).toBe(true);
    // جوهر الثغرة: كل الشروط القديمة متحقّقة والمراجع لا يرى شيئاً.
    expect(canApproveStudioCandidate({ ...ready, previewLoaded: false })).toBe(false);
    expect(canApproveStudioCandidate({ ...ready, offline: true })).toBe(false);
    expect(canApproveStudioCandidate({ ...ready, reviewable: false })).toBe(false);
    expect(canApproveStudioCandidate({ ...ready, storageDisabled: true })).toBe(false);
    expect(canApproveStudioCandidate({ ...ready, busy: true })).toBe(false);
  });
});
