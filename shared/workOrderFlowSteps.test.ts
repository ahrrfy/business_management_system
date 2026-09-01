/** مسارُ الطلب: محطّةٌ حاليّةٌ واحدة دائماً، وسببٌ مقروءٌ لكلّ تعثّر. */
import { describe, expect, it } from "vitest";
import { deriveWorkOrderFlowSteps, type WorkOrderFlowInput } from "./workOrderFlowSteps";

const base: WorkOrderFlowInput = {
  status: "RECEIVED",
  designApprovalStatus: null,
  hasDelivery: false,
  consignmentId: null,
  courierDeliveredAt: null,
};

function stateOf(steps: ReturnType<typeof deriveWorkOrderFlowSteps>, key: string) {
  return steps.find((step) => step.key === key)?.state;
}

describe("اشتقاق مسار أمر الشغل", () => {
  it("يوقف الطريق عند اعتماد التصميم ويقول إنّ الرفع غير لازم", () => {
    const steps = deriveWorkOrderFlowSteps(base);
    expect(stateOf(steps, "DESIGN")).toBe("BLOCKED");
    expect(stateOf(steps, "PRODUCTION")).toBe("PENDING");
    const design = steps.find((step) => step.key === "DESIGN");
    expect(design?.hint).toContain("لا يلزم رفعُ أيّ ملفّ");
  });

  it("⭐ فور اعتماد التصميم تصير محطّةُ التنفيذ هي الحاليّة — لا طريقَ بلا فاعل", () => {
    const steps = deriveWorkOrderFlowSteps({ ...base, designApprovalStatus: "APPROVED" });
    expect(stateOf(steps, "DESIGN")).toBe("DONE");
    expect(stateOf(steps, "PRODUCTION")).toBe("CURRENT");
    expect(steps.filter((step) => step.state === "CURRENT")).toHaveLength(1);
  });

  it("يميّز انتظارَ القرار عن رفضِه عن استبدالِه", () => {
    const hint = (s: WorkOrderFlowInput["designApprovalStatus"]) =>
      deriveWorkOrderFlowSteps({ ...base, designApprovalStatus: s }).find((x) => x.key === "DESIGN")?.hint ?? "";
    expect(hint("PENDING")).toContain("بانتظار قرار");
    expect(hint("REJECTED")).toContain("رفض العميل");
    expect(hint("SUPERSEDED")).toContain("النسخة الأحدث");
    // تعذُّرُ القراءة لا يُقدَّم على أنه «لم يُطلب بعد» — لا نكذب بغياب المعطى.
    expect(hint(undefined)).toContain("تعذّر");
  });

  it("يعرض حجز التنفيذ بسببه المكتوب على الأمر", () => {
    const steps = deriveWorkOrderFlowSteps({
      ...base,
      status: "IN_PROGRESS",
      designApprovalStatus: "APPROVED",
      kanbanState: "BLOCKED",
      blockedReason: "تغيير التصميم إلى النسخة 2",
    });
    expect(stateOf(steps, "PRODUCTION")).toBe("BLOCKED");
    expect(steps.find((s) => s.key === "PRODUCTION")?.hint).toContain("النسخة 2");
  });

  it("يبدّل المحطّة الأخيرة بحسب طريقة التسليم", () => {
    const direct = deriveWorkOrderFlowSteps({ ...base, status: "READY", designApprovalStatus: "APPROVED" });
    expect(direct.at(-1)?.label).toBe("تسليم وفوترة");
    expect(direct.at(-1)?.hint).toContain("تسليم وإصدار فاتورة");

    const courier = deriveWorkOrderFlowSteps({
      ...base, status: "READY", designApprovalStatus: "APPROVED", hasDelivery: true,
    });
    expect(courier.at(-1)?.label).toBe("إسناد للتوصيل");
    expect(courier.at(-1)?.hint).toContain("إسناد لمندوب التوصيل");
  });

  it("المُرسَل مع مندوبٍ لم يصل بعد ليس «منتهياً»", () => {
    const dispatched = deriveWorkOrderFlowSteps({
      ...base,
      status: "DELIVERED",
      designApprovalStatus: "APPROVED",
      hasDelivery: true,
      consignmentId: 7,
      courierDeliveredAt: null,
    });
    expect(dispatched.at(-1)?.state).toBe("CURRENT");
    expect(dispatched.at(-1)?.hint).toContain("بانتظار تأكيد الوصول");

    const arrived = deriveWorkOrderFlowSteps({
      ...base,
      status: "DELIVERED",
      designApprovalStatus: "APPROVED",
      hasDelivery: true,
      consignmentId: 7,
      courierDeliveredAt: new Date("2026-09-01T09:00:00Z"),
    });
    expect(arrived.at(-1)?.state).toBe("DONE");
    expect(arrived.every((step) => step.state === "DONE")).toBe(true);
  });

  it("الملغى يُختصر إلى محطّتين بسببٍ ظاهر — لا طريقٌ يوحي بأنّ التنفيذ قادم", () => {
    const steps = deriveWorkOrderFlowSteps({ ...base, status: "CANCELLED" });
    expect(steps.map((s) => s.key)).toEqual(["RECEIVED", "CANCELLED"]);
    expect(steps.at(-1)?.hint).toContain("ردّ المبالغ");
  });
});
