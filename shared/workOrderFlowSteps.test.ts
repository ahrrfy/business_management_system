/** مسارُ الطلب: محطّةٌ حاليّةٌ واحدة دائماً، وسببٌ مقروءٌ لكلّ تعثّر. */
import { describe, expect, it } from "vitest";
import { deriveWorkOrderFlowSteps, type WorkOrderFlowInput } from "./workOrderFlowSteps";

const base: WorkOrderFlowInput = {
  status: "RECEIVED",
  hasDelivery: false,
  consignmentId: null,
  courierDeliveredAt: null,
};

function stateOf(steps: ReturnType<typeof deriveWorkOrderFlowSteps>, key: string) {
  return steps.find((step) => step.key === key)?.state;
}

describe("اشتقاق مسار أمر الشغل", () => {
  it("⭐ لا محطّةَ اعتمادِ تصميمٍ في الطريق — أمرٌ مُستلَمٌ خطوتُه التالية البدء مباشرةً", () => {
    const steps = deriveWorkOrderFlowSteps(base);
    expect(steps.map((step) => step.key)).not.toContain("DESIGN");
    expect(stateOf(steps, "PRODUCTION")).toBe("CURRENT");
    expect(steps.filter((step) => step.state === "CURRENT")).toHaveLength(1);
    expect(steps.find((s) => s.key === "PRODUCTION")?.hint).toContain("بدء التنفيذ");
    // ولا أثرَ لأيّ نصٍّ يَعِد بخطوةِ موافقةٍ محذوفة.
    expect(JSON.stringify(steps)).not.toContain("اعتماد");
  });

  it("يعرض حجز التنفيذ بسببه المكتوب على الأمر", () => {
    const steps = deriveWorkOrderFlowSteps({
      ...base,
      status: "IN_PROGRESS",
      kanbanState: "BLOCKED",
      blockedReason: "تغيير التصميم إلى النسخة 2",
    });
    expect(stateOf(steps, "PRODUCTION")).toBe("BLOCKED");
    expect(steps.find((s) => s.key === "PRODUCTION")?.hint).toContain("النسخة 2");
  });

  it("يبدّل المحطّة الأخيرة بحسب طريقة التسليم", () => {
    const direct = deriveWorkOrderFlowSteps({ ...base, status: "READY" });
    expect(direct.at(-1)?.label).toBe("تسليم وفوترة");
    expect(direct.at(-1)?.hint).toContain("تسليم وإصدار فاتورة");

    const courier = deriveWorkOrderFlowSteps({
      ...base, status: "READY", hasDelivery: true,
    });
    expect(courier.at(-1)?.label).toBe("إسناد للتوصيل");
    expect(courier.at(-1)?.hint).toContain("إسناد لمندوب التوصيل");
  });

  it("المُرسَل مع مندوبٍ لم يصل بعد ليس «منتهياً»", () => {
    const dispatched = deriveWorkOrderFlowSteps({
      ...base,
      status: "DELIVERED",
      hasDelivery: true,
      consignmentId: 7,
      courierDeliveredAt: null,
    });
    expect(dispatched.at(-1)?.state).toBe("CURRENT");
    expect(dispatched.at(-1)?.hint).toContain("بانتظار تأكيد الوصول");

    const arrived = deriveWorkOrderFlowSteps({
      ...base,
      status: "DELIVERED",
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
