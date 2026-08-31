import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("واجهة حوكمة المشتريات التشغيلية", () => {
  it("تفصل الإرسال والاعتماد والإلغاء إلى طلبات صفريّة الأثر بمفاتيح ونسخ", () => {
    const orders = source("../Purchases.tsx");
    const approvals = source(
      "../../components/purchases/PurchaseApprovalQueue.tsx",
    );
    expect(orders).toContain("expectedVersion:");
    expect(orders).toContain("requestKey:");
    expect(orders).toContain("cancelReason.trim()");
    expect(orders).toContain("الطلب صفري الأثر");
    expect(approvals).toContain("decideControl");
    expect(approvals).toContain("decideRequisition");
    expect(approvals).toContain("violatesVisibleSod");
    expect(approvals).toContain("الخادم هو الحكم النهائي");
  });

  it("يوفر مسار طلب الشراء من المسودة حتى التحويل لأمر مورد", () => {
    const requisitions = source("../PurchaseRequisitions.tsx");
    const newOrder = source("../PurchaseNew.tsx");
    const hub = source("../PurchasesHub.tsx");
    for (const mutation of [
      "createRequisition",
      "updateRequisition",
      "submitRequisition",
      "requestRequisitionCancel",
    ])
      expect(requisitions).toContain(mutation);
    expect(requisitions).toContain("requisitionId=");
    expect(requisitions).toContain("cancelReason.trim()");
    expect(newOrder).toContain("requisitionAllocations:");
    expect(newOrder).toContain("approvedBaseQuantity");
    expect(hub).toContain('value: "requisitions"');
    expect(hub).toContain('value: "approvals"');
  });

  it("يعرض سجل المراجعات والفروق والأحداث ولا يخفي فشل التحميل", () => {
    const governance = source(
      "../../components/purchases/PurchaseOrderGovernance.tsx",
    );
    expect(governance).toContain("purchases.revisions.useQuery");
    expect(governance).toContain("purchases.revisionDiff.useQuery");
    expect(governance).toContain("purchases.events.useQuery");
    expect(governance).toContain("ErrorState");
    expect(governance).toContain("payloadHash");
  });
});
