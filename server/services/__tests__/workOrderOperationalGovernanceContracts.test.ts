import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(`${process.cwd()}/${path}`, "utf8");
}

describe("عقود حوكمة العمليات النهائية", () => {
  it("يمنع تغيير مستندات بيع أو تسليم من فترة مقفلة", () => {
    expect(source("server/services/returnService.ts")).toContain(
      "await assertPeriodOpen(tx, inv.invoiceDate)",
    );
    expect(source("server/services/sale/correct.ts")).toContain(
      "await assertPeriodOpen(tx, inv.invoiceDate)",
    );
    const reverse = source("server/services/workOrder/reverseDelivery.ts");
    expect(reverse).toContain("await assertPeriodOpen(tx, inv.invoiceDate)");
    expect(reverse).toContain("await assertPeriodOpen(tx, wo.deliveredAt)");
  });

  it("يفتح تغيير التصميم بعد الإنتاج دورة rework محجوبة", () => {
    const design = source("server/services/workOrder/design.ts");
    expect(design).toContain('status: "IN_PROGRESS" as const');
    expect(design).toContain('kanbanState: "BLOCKED" as const');
    expect(design).toContain('eventType: "DESIGN_CHANGED"');
    expect(source("server/services/workOrder/lifecycle.ts")).toContain(
      'if (wo.kanbanState === "BLOCKED")',
    );
  });

  it("يحفظ هوية المدير الثاني على رد أمانة التوصيل ولا يسمح بتجاوز الدور", () => {
    const refund = source("server/services/workOrder/deliveryFeeRefund.ts");
    expect(refund).not.toContain('opts.actor.role === "admin" || opts.actor.role === "manager"');
    expect(refund).toContain("approvedByManagerId === opts.actor.userId");
    expect(refund).toContain("approvedBy: sameOpenShift ? null : approvedByManagerId");
    const router = source("server/routers/workOrderRouter.ts");
    expect(router).toContain("approvedByManagerId = await verifyManagerApproval");
    expect(router).toContain("Number(approvedByManagerId) === Number(ctx.user.id)");
  });
});
