import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  WorkOrderControlApprovalRow,
  WorkOrderControlApprovals,
  formatWorkOrderControlPayload,
  invalidateWorkOrderControlCaches,
  workOrderControlTypeLabel,
  type PendingWorkOrderControl,
} from "./WorkOrderControlApprovals";

function requestRow(requestedBy = 21): PendingWorkOrderControl {
  return {
    id: 701,
    requestKey: "wo-control-701",
    workOrderId: 5079,
    branchId: 1,
    requestType: "CANCEL",
    status: "PENDING",
    baseVersion: 4,
    payload: { refundShiftId: 12, materials: [{ materialId: 8, action: "RETURN" }] },
    payloadHash: "a".repeat(64),
    reason: "العميل طلب الإلغاء قبل الطباعة",
    requestedBy,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    appliedAt: null,
    createdAt: new Date("2026-08-31T10:00:00.000Z"),
    updatedAt: new Date("2026-08-31T10:00:00.000Z"),
  };
}

describe("واجهة المراجعة الإدارية لطلبات تحكم أوامر الشغل", () => {
  it("يربط الصفحة بعقود القائمة والتفاصيل والاعتماد والرفض دون تركيبها لغير المشرف", () => {
    const component = readFileSync(new URL("./WorkOrderControlApprovals.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../../pages/WorkOrders.tsx", import.meta.url), "utf8");
    for (const endpoint of ["pendingControlRequests", "controlRequest", "approveControl", "rejectControl"]) {
      expect(component).toContain(`workOrders.${endpoint}`);
    }
    expect(component).toContain("if (!canReview) return null");
    expect(page).toContain('me.data?.role === "admin"');
    expect(page).toContain('me.data?.role === "manager"');
    expect(page).toContain("canReview={canReviewWorkOrderControls}");
  });

  it("لا يركّب واجهة أو استعلامات المراجعة لغير المدير والأدمن", () => {
    const html = renderToStaticMarkup(createElement(WorkOrderControlApprovals, {
      canReview: false,
      currentUserId: 21,
    }));
    expect(html).toBe("");
  });

  it("يعرض النوع ورقم الأمر والسبب والطالب والنسخة والحمولة والتاريخ", () => {
    const html = renderToStaticMarkup(createElement(WorkOrderControlApprovalRow, {
      row: requestRow(21),
      currentUserId: 99,
      onApprove: vi.fn(),
      onReject: vi.fn(),
    }));
    expect(html).toContain("إلغاء أمر الشغل");
    expect(html).toContain("رقم الأمر #5079");
    expect(html).toContain("العميل طلب الإلغاء قبل الطباعة");
    expect(html).toContain("مستخدم #21");
    expect(html).toContain("v4");
    expect(html).toContain("refundShiftId");
    expect(html).toContain("2026");
  });

  it("يُظهر فصل الواجبات ويعطّل الاعتماد والرفض على منشئ الطلب", () => {
    const ownHtml = renderToStaticMarkup(createElement(WorkOrderControlApprovalRow, {
      row: requestRow(21),
      currentUserId: 21,
      onApprove: vi.fn(),
      onReject: vi.fn(),
    }));
    const otherHtml = renderToStaticMarkup(createElement(WorkOrderControlApprovalRow, {
      row: requestRow(21),
      currentUserId: 22,
      onApprove: vi.fn(),
      onReject: vi.fn(),
    }));
    expect(ownHtml).toContain("هذا الطلب أنشأه حسابك");
    expect((ownHtml.match(/disabled=""/g) ?? [])).toHaveLength(2);
    expect(otherHtml).not.toContain("هذا الطلب أنشأه حسابك");
    expect(otherHtml).not.toContain('disabled=""');
  });

  it("يحوّل النوع والحمولة إلى عرض تدقيقي ثابت", () => {
    expect(workOrderControlTypeLabel("MATERIAL_ADJUST")).toBe("تعديل مواد الأمر");
    expect(workOrderControlTypeLabel("REVERSE_DELIVERY")).toBe("عكس تسليم أمر الشغل");
    expect(formatWorkOrderControlPayload({ b: 2, a: 1 })).toContain('"b": 2');
    expect(formatWorkOrderControlPayload(null)).toBe("—");
  });

  it("يبطل القائمة والتفاصيل والتحقق القبلي والأحداث بعد القرار", async () => {
    const calls: string[] = [];
    const inv = (name: string) => ({ invalidate: vi.fn(() => { calls.push(name); }) });
    await invalidateWorkOrderControlCaches({
      workOrders: {
        pendingControlRequests: inv("pending"),
        controlRequest: inv("request"),
        list: inv("list"),
        counts: inv("counts"),
        get: inv("detail"),
        controlPreflight: inv("preflight"),
        timeline: inv("events"),
      },
    });
    expect(calls.sort()).toEqual(["counts", "detail", "events", "list", "pending", "preflight", "request"]);
  });
});
