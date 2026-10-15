import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moduleAccessAllowed } from "@shared/permissions";
import { canLifecycleOperation } from "@/lib/lifecycleOperationAccess";
import { type OperationUser } from "@shared/operationPermissions";

const readPage = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readReceptionQueue = () =>
  readFileSync(new URL("../../components/reception/ReceptionOrderQueue.tsx", import.meta.url), "utf8");
const readCancelDialog = () =>
  readFileSync(new URL("../../components/workorder/CancelWorkOrderDialog.tsx", import.meta.url), "utf8");

describe("عقد صلاحيات وفشل واجهات أوامر الشغل التشغيلية", () => {
  it("يظهر التفويض لمندوب مستقل لكل مرحلة ولا يحول القراءة أو بدء التنفيذ إلى إذن تسليم", () => {
    const user: OperationUser = {
      role: "courier",
      operationPolicy: { version: 1, grants: {
        "operation.workOrders.get": true,
        "operation.workOrders.start": true,
        "operation.workOrders.requestControl": true,
      } },
    };
    expect(canLifecycleOperation(user, "workOrders.get", false)).toBe(true);
    expect(canLifecycleOperation(user, "workOrders.start", false)).toBe(true);
    expect(canLifecycleOperation(user, "workOrders.requestControl", false)).toBe(true);
    expect(canLifecycleOperation(user, "workOrders.markReady", true)).toBe(false);
    expect(canLifecycleOperation(user, "workOrders.deliver", true)).toBe(false);
    expect(canLifecycleOperation(user, "workOrders.assign", true)).toBe(false);
    expect(canLifecycleOperation(user, "suppliers.delete", true)).toBe(false);
  });

  it("يحترم المنع الفردي فوق الدور ويحافظ على شرط الواجهة السابق للحسابات غير المنقولة", () => {
    const user: OperationUser = {
      role: "manager",
      roleOperationPolicy: { version: 1, grants: {
        "operation.workOrders.start": true,
        "operation.workOrders.markReady": true,
      } },
      operationPolicy: { version: 1, grants: { "operation.workOrders.start": false } },
    };
    expect(canLifecycleOperation(user, "workOrders.start", true)).toBe(false);
    expect(canLifecycleOperation(user, "workOrders.markReady", false)).toBe(true);
    expect(canLifecycleOperation({ role: "print_operator" }, "workOrders.start", true)).toBe(true);
    expect(canLifecycleOperation({ role: "print_operator" }, "workOrders.deliver", false)).toBe(false);
    expect(canLifecycleOperation(undefined, "workOrders.start", true)).toBe(false);
  });

  it("تربط محطة التنفيذ ببوابة workorders FULL وتنفذ المنح والتقييد الصريح", () => {
    const hub = readPage("PrintHub.tsx");
    const station = readPage("WorkOrderStation.tsx");

    expect(hub).toContain('module: "workorders", level: "FULL"');
    expect(station).toContain("const legacyOperateWorkOrders = !!me.data?.role && moduleAccessAllowed(");
    expect(station).toContain('canLifecycleOperation(me.data, "workOrders.list", legacyOperateWorkOrders)');
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

    expect(source).toContain("const legacyCanFulfill = !!role && moduleAccessAllowed(");
    expect(source).toContain('const canFulfill = lifecycleActionAllowed(me.data, "workOrders.deliver", legacyCanFulfill)');
    expect(source).not.toContain('const canFulfill = role === "admin"');
    expect(source).toContain("const legacyCanDispatch = legacyCanFulfill");
    expect(source).toContain('const canDispatch = lifecycleActionAllowed(me.data, "delivery.dispatch", legacyCanDispatch)');
    expect(source).toContain('const canReadParties = lifecycleActionAllowed(me.data, "delivery.listParties", legacyCanDispatch)');
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

  /**
   * ⭐ **انقلب العقد** (قرار المالك ١/٩/٢٦): كان يحرس أنّ الشاشتين تشتقّان الحجب من اعتماد
   * التصميم. حُذفت الخطوةُ من المسار كلّياً — خادماً وواجهةً — فصار الحارس يمنع **عودتها**.
   */
  it("⭐ لا تحجب أيُّ شاشةٍ البدءَ أو الجاهزية باعتماد تصميم", () => {
    const detail = readPage("WorkOrderDetail.tsx");
    const station = readPage("WorkOrderStation.tsx");

    for (const page of [detail, station]) {
      expect(page).not.toContain("workOrderDesignApproval");
      expect(page).not.toContain("DesignApprovalCard");
      expect(page).not.toContain("بانتظار اعتماد التصميم");
    }
    // ولا عودةَ للحجب العامّ القديم بالمهمّة على هاتين الشاشتين.
    expect(detail).not.toContain("const blockedByDesign = !!data.blockingTask");
    expect(detail).not.toContain("blockingTask={(data.blockingTask");
    expect(station).not.toContain("blockingTask={(d.blockingTask");
    // الحجزُ الوحيد الباقي في محطّة الفنّي هو الصلاحية نفسها.
    expect(station).toContain('canLifecycleOperation(me.data, "workOrders.start", canOperateWorkOrders)');
    expect(station).toContain('canLifecycleOperation(me.data, "workOrders.markReady", canOperateWorkOrders)');
  });

  it("⭐ يحرس استقلال إحصائيات أعمدة الكانبان وعزل مبالغ «طابور وارد» عن «مسحوب» بلا تكرار", () => {
    const board = readPage("WorkOrders.tsx");
    // يمنع ربط مبالغ الأعمدة بالحالة الخادمية العامة المسببة لتكرار مبالغ RECEIVED
    expect(board).not.toContain("serverCounts?.stats?.[s.status]");
    expect(board).toContain("colStatsMap");
    expect(board).toContain("toAccessibleMoney(colStats.totalValue)");
    expect(board).toContain('<bdi dir="ltr" aria-hidden="true">');
    expect(board).toContain("wob-curr");
  });

  it("⭐ يحرس ظهور أوامر الشغل لفني المطبعة والمنفذ وإتاحة السحب والإعادة للطابور والانتقال بين المراحل", async () => {
    const { workOrderDetailOperationAccess } = await import("@/lib/workOrderDetailOperationAccess");
    const { ROLE_TEMPLATES } = await import("@shared/permissions");
    const { buildDefaultRoleOperationPolicy } = await import("@shared/roleOperationPresets");

    const printOpPolicy = buildDefaultRoleOperationPolicy(
      "print_operator",
      "print_operator",
      ROLE_TEMPLATES.print_operator,
    );
    const printOpUser: OperationUser = {
      role: "print_operator",
      operationPolicyEnabled: true,
      resolvedOperationPolicy: printOpPolicy,
    };
    const access = workOrderDetailOperationAccess(printOpUser);
    expect(access.canClaimWorkOrder).toBe(true);
    expect(access.canReleaseWorkOrder).toBe(true);
    expect(access.canStartWorkOrder).toBe(true);
    expect(access.canMarkReady).toBe(true);
    expect(access.canDeliverWorkOrder).toBe(false);

    const revokedClaimAccess = workOrderDetailOperationAccess({
      role: "print_operator",
      operationPolicyEnabled: true,
      operationPolicy: {
        version: 1,
        grants: { "operation.workOrders.claim": false },
      },
    });
    expect(revokedClaimAccess.canClaimWorkOrder).toBe(false);
    expect(revokedClaimAccess.canReleaseWorkOrder).toBe(true);
    expect(revokedClaimAccess.canStartWorkOrder).toBe(true);
    expect(revokedClaimAccess.canMarkReady).toBe(true);

    const board = readPage("WorkOrders.tsx");
    const detail = readPage("WorkOrderDetail.tsx");
    const station = readPage("WorkOrderStation.tsx");
    const receptionQueue = readReceptionQueue();
    const kanbanCard = readFileSync(new URL("../../components/workOrders/WorkOrderKanbanCard.tsx", import.meta.url), "utf8");
    const previewDrawer = readFileSync(new URL("../../components/workOrders/WorkOrderPreviewDrawer.tsx", import.meta.url), "utf8");
    const table = readFileSync(new URL("../../components/workOrders/WorkOrdersTable.tsx", import.meta.url), "utf8");

    expect(board).toContain('canLifecycleOperation(me.data, "workOrders.claim", legacyExec)');
    expect(board).toContain('canLifecycleOperation(me.data, "workOrders.release", legacyExec)');
    expect(board).toContain("trpc.workOrders.claim.useMutation");
    expect(board).toContain("trpc.workOrders.release.useMutation");
    expect(board).toContain("if (!dndEnabled || !canDragOrder) return;");
    expect(board).toContain("Number(o.assignedTo) === Number(me.data?.id)");
    expect(detail).toContain("trpc.workOrders.claim.useMutation");
    expect(detail).toContain("trpc.workOrders.release.useMutation");
    expect(detail).toContain("Number(data.assignedTo) === Number(me.data?.id)");
    expect(station).toContain('canLifecycleOperation(me.data, "workOrders.claim", canOperateWorkOrders)');
    expect(station).toContain("سحب الأمر إلى قائمتي");
    expect(station).toContain("Number(d.assignedTo) === Number(me.data?.id)");
    expect(kanbanCard).toContain("سحب الأمر");
    expect(previewDrawer).toContain("سحب الأمر");
    expect(previewDrawer).toContain("Number(d.assignedTo) === Number(me.data?.id)");
    expect(table).toContain("سحب الأمر");
    expect(table).toContain("Number(o.assignedTo) === Number(me.data?.id)");
    expect(receptionQueue).toContain("branchQueue: true");
  });
});
