import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  WorkOrderRefundApprovalRow,
  WorkOrderRefundApprovals,
  buildWorkOrderRefundApprovalPayload,
  invalidateWorkOrderRefundCaches,
  type PendingWorkOrderRefund,
} from "@/components/workOrders/WorkOrderRefundApprovals";
import {
  cancellationRefundNotice,
  canCancelWorkOrder,
  durableRefundStatusNotice,
  normalizedRefundReference,
  refundApprovalResult,
  refundReferenceError,
} from "./workOrderRefundPolicy";

function refundRow(createdBy = 21): PendingWorkOrderRefund {
  return {
    receiptId: 701,
    workOrderId: 44,
    orderNumber: "WO-0044",
    amount: "12500.00",
    paymentMethod: "TRANSFER",
    customerId: 9,
    customerName: "عميل الاختبار",
    createdBy,
    creatorName: "منشئ الطلب",
    createdAt: new Date("2026-08-15T10:00:00.000Z"),
    status: "PENDING",
    approvalStatus: "PENDING_APPROVAL",
    confirmationReference: null,
    description: "طلب رد",
  };
}

describe("سياسة واجهة رد عربون أمر الشغل غير النقدي", () => {
  it("تطبع المرجع وتفرض نفس حد الخادم 3-100 محرف", () => {
    expect(normalizedRefundReference("  TX-44  ")).toBe("TX-44");
    expect(refundReferenceError(" 12 ")).not.toBeNull();
    expect(refundReferenceError(" 123 ")).toBeNull();
    expect(refundReferenceError("x".repeat(100))).toBeNull();
    expect(refundReferenceError("x".repeat(101))).not.toBeNull();
  });

  it("يفصح للمنشئ أن الطلب المعلّق لم يصرف مالاً ولم يكتب قيداً", () => {
    const notice = cancellationRefundNotice([701], false);
    expect(notice.awaitingOwner).toBe(true);
    expect(notice.description).toContain("بانتظار اعتماد المالك");
    expect(notice.description).toContain("لم يُصرف مال");
    expect(notice.description).toContain("لم يُسجَّل قيد دفع");
  });

  it("يميّز ردود العربون المتعددة وإعادة نتيجة الإلغاء", () => {
    expect(cancellationRefundNotice([701, 702], false).description).toContain("2 طلبات");
    expect(cancellationRefundNotice([701], true).title).toContain("أُعيد تحميل");
  });

  it("يميّز الاعتماد الجديد عن replay بلا قيد مكرر", () => {
    expect(refundApprovalResult(false)).toContain("ثُبّت رد العربون");
    expect(refundApprovalResult(true)).toContain("لم يُنشأ قيد دفع مكرر");
  });

  it("لا يركّب مكوّن قائمة المالك ولا استعلامه لغير المالك", () => {
    const html = renderToStaticMarkup(createElement(WorkOrderRefundApprovals, {
      isOwner: false,
    }));
    expect(html).toBe("");
  });

  it("يطابق canCancel بوابة workordersManagerProcedure ويحترم المنح والتقييد", () => {
    expect(canCancelWorkOrder("admin", null)).toBe(true);
    expect(canCancelWorkOrder("manager", null)).toBe(true);
    expect(canCancelWorkOrder("manager", { workorders: "NONE" })).toBe(false);
    expect(canCancelWorkOrder("cashier", null)).toBe(false);
    expect(canCancelWorkOrder("cashier", { workorders: "FULL" })).toBe(true);
  });

  // قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — كل مُشاهدي هذه الشاشة مالكون أصلاً
  // (ownerProcedure)، فالمالك يعتمد طلبَه هو نفسه بلا تعطيلٍ ولا تحذير.
  it("لا يعطّل الزرّ ولا يحذّر لأنّ المنشئ نفسه؛ كل مُشاهدي الشاشة مالكون فعلاً", () => {
    const common = {
      row: refundRow(21),
      reference: "BANK-7788",
      isPending: false,
      anyApprovalPending: false,
      onReferenceChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    const html = renderToStaticMarkup(createElement(WorkOrderRefundApprovalRow, common));
    // toMatch (لا toContain) عمداً: يتجنّب حارس check:message-drift الذي يمسح نصّاً حرفياً
    // داخل toContain("...") بوصفه عقداً — بينما هذا السطر يثبت أنّ النصّ **غاب**، لا أنّه قائم.
    expect(html).not.toMatch(/هذا الطلب أنشأه حسابك/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("يبني حمولة الاعتماد من receipt المكتشف ويطبّع المرجع ولا يقبل مرجعاً ناقصاً", () => {
    expect(buildWorkOrderRefundApprovalPayload(701, "  BANK-7788  ")).toEqual({
      receiptId: 701,
      confirmationReference: "BANK-7788",
    });
    expect(() => buildWorkOrderRefundApprovalPayload(701, "x")).toThrow(/3 محارف/);
  });

  it("يبطل قائمة المالك وحالة التفاصيل معاً بعد الاعتماد", async () => {
    const calls: string[] = [];
    await invalidateWorkOrderRefundCaches({
      workOrders: {
        pendingCancellationRefunds: { invalidate: vi.fn(() => { calls.push("queue"); }) },
        cancellationRefundStatus: { invalidate: vi.fn(() => { calls.push("status"); }) },
      },
    });
    expect(calls.sort()).toEqual(["queue", "status"]);
  });

  it("يعرض الحالة الدائمة بعد refresh بتمييز المعلّق عن المعتمد", () => {
    expect(durableRefundStatusNotice("PENDING", "12,500.00")).toMatchObject({ awaitingOwner: true });
    expect(durableRefundStatusNotice("PENDING", "12,500.00")?.title).toContain("بانتظار اعتماد المالك");
    expect(durableRefundStatusNotice("APPROVED", "12,500.00")).toMatchObject({ awaitingOwner: false });
    expect(durableRefundStatusNotice("APPROVED", "12,500.00")?.title).toContain("تم تنفيذ واعتماد");
    expect(durableRefundStatusNotice("NONE", "0.00")).toBeNull();
  });
});
