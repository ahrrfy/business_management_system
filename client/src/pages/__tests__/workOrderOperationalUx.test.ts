import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moduleAccessAllowed } from "@shared/permissions";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readReceptionQueue = () =>
  readFileSync(new URL("../../components/reception/ReceptionOrderQueue.tsx", import.meta.url), "utf8");
const readCancelDialog = () =>
  readFileSync(new URL("../../components/workorder/CancelWorkOrderDialog.tsx", import.meta.url), "utf8");

describe("عقد صلاحيات وفشل واجهات أوامر الشغل التشغيلية", () => {
  it("تربط محطة التنفيذ ببوابة workorders FULL وتنفذ المنح والتقييد الصريح", () => {
    const hub = readPage("PrintHub.tsx");
    const station = readPage("WorkOrderStation.tsx");

    expect(hub).toContain('module: "workorders", level: "FULL"');
    expect(station).toContain("const canOperateWorkOrders = !!me.data?.role && moduleAccessAllowed(");
    expect(
      moduleAccessAllowed("user", { workorders: "FULL" }, "workorders", "FULL", ["cashier", "manager", "print_operator"]),
    ).toBe(true);
    expect(
      moduleAccessAllowed("cashier", { workorders: "NONE" }, "workorders", "FULL", ["cashier", "manager", "print_operator"]),
    ).toBe(false);
  });

  it("لا يحول فشل قوائم المحطة أو تفاصيل الأمر وسجله إلى حالة فارغة", () => {
    const source = readPage("WorkOrderStation.tsx");
    for (const query of ["mineQ", "queueQ", "detail", "timeline"]) {
      expect(source).toContain(`${query}.isLoading`);
      expect(source).toContain(`${query}.isError`);
      expect(source).toContain(`${query}.refetch()`);
    }
    expect(source).toContain("لا يمكن افتراض أن قوائم العمل فارغة");
    expect(source).toContain("لم نفترض أن الأمر غير موجود");
    expect(source.indexOf("const release = trpc.workOrders.release.useMutation"))
      .toBeLessThan(source.indexOf("if (detail.isLoading)"));
  });

  it("يفصل صلاحية تنفيذ الطلب عن الإرسال ويعلن فشل الجهات والطلبات المسلمة", () => {
    const source = readReceptionQueue();

    expect(source).toContain("const canFulfill = !!role && moduleAccessAllowed(");
    expect(source).not.toContain('const canFulfill = role === "admin"');
    expect(source).toContain("const canDispatch = canFulfill");
    expect(source).toContain('hasModuleAccess(role ?? "", permissions, "store", "READ")');
    for (const query of ["active", "deliveredToday", "parties"]) {
      expect(source).toContain(`${query}.isLoading`);
      expect(source).toContain(`${query}.isError`);
      expect(source).toContain(`${query}.refetch()`);
    }
    expect(source).toContain("أُوقف الإسناد للمندوب حتى نجاح التحميل");
    expect(source).toContain("لا يمكن افتراض عدم وجود طلبات");
    expect(source).toContain("disabled: !partiesReady");
  });

  it("يلغي الاختصار الخطر ويثبت النسخة والسبب والدرج والحمولة الكاملة قبل الإلغاء", () => {
    const board = readPage("WorkOrders.tsx");
    const detail = readPage("WorkOrderDetail.tsx");
    const dialog = readCancelDialog();

    expect(board).toContain("navigate(`/work-orders/${d.id}?cancel=1`)");
    expect(board).not.toContain("cancel.mutate({ workOrderId: d.id");
    expect(detail).toContain("controlPreflight");
    expect(detail).toContain("expectedVersion: preflight.version");
    expect(detail).toContain('kind: "CONTROL_REQUEST"');
    expect(detail).toContain("JSON.stringify(attempt)");
    expect(detail).toContain("cancel.mutate(attempt.input)");
    expect(dialog).toContain("درج ردّ النقد");
    expect(dialog).toContain("أُوقف الإلغاء حتى نجاح التحقق");
    expect(dialog).toContain("refundShiftId: refundShiftId ?? undefined");
  });

  it("يستمد حجب البدء والجاهزية من اعتماد نسخة التصميم الحالية لا من المهمة العامة القديمة", () => {
    const detail = readPage("WorkOrderDetail.tsx");
    const station = readPage("WorkOrderStation.tsx");

    expect(detail).toContain("workOrderDesignApproval.getCurrent.useQuery");
    expect(detail).toContain('designApproval.data.approval?.status === "APPROVED"');
    expect(detail).toContain("markReady.isPending || blockedByDesign");
    expect(detail).not.toContain("const blockedByDesign = !!data.blockingTask");
    expect(detail).not.toContain("blockingTask={(data.blockingTask");
    expect(station).toContain("workOrderDesignApproval.getCurrent.useQuery");
    expect(station).toContain('designApproval.data.approval?.status !== "APPROVED"');
    expect(station).toContain("disabled={busy || blockedByDesign}");
    expect(station).not.toContain("blockingTask={(d.blockingTask");
  });
});
