import {
  moduleAccessAllowed,
  type PermissionMap,
  type RoleKey,
} from "@shared/permissions";
import {
  canViewOperationData,
  hasOperationPolicy,
  type OperationUser,
} from "@shared/operationPermissions";
import {
  hasWorkOrderCommercialAuthority,
  hasWorkOrderExecAuthority,
  mayCancelWorkOrderWithoutApproval,
  mayRequestWorkOrderControl,
} from "@shared/workOrderControlAuthority";
import { canLifecycleOperation } from "./lifecycleOperationAccess";

/** Exact workflow actions and cost visibility with the unchanged legacy fallback. */
export function workOrderDetailOperationAccess(
  user: OperationUser | null | undefined,
) {
  // حجب التكلفة بـcanSeeCost (نفس دالة الخادم/الشاشات الأخرى، لا مقارنة دور خام) — الخادم يُخفي
  // materialsCost/laborCost/unitCost بالفعل (null) لغير المخوَّلين، والواجهة تُخفي الصفوف/الأعمدة
  // كاملةً بدل عرضها فارغة («—») بلا داعٍ.
  const showCost = !!user && canViewOperationData(user, "purchaseCost");
  const role = user?.role as RoleKey | undefined;
  const permissions = (user?.permissionsOverride ??
    null) as PermissionMap | null;
  // مرايا بوابات الخادم نفسها: التنفيذ = كاشير/مدير/فني، والمال/التعديل = كاشير/مدير.
  const legacyExec = hasWorkOrderExecAuthority(role, permissions);
  const legacyCommercial = hasWorkOrderCommercialAuthority(role, permissions);
  const canClaimWorkOrder = canLifecycleOperation(
    user,
    "workOrders.claim",
    legacyExec,
  );
  const canReleaseWorkOrder = canLifecycleOperation(
    user,
    "workOrders.release",
    legacyExec,
  );
  const canStartWorkOrder = canLifecycleOperation(
    user,
    "workOrders.start",
    legacyExec,
  );
  const canMarkReady = canLifecycleOperation(
    user,
    "workOrders.markReady",
    legacyExec,
  );
  const canDeliverWorkOrder = canLifecycleOperation(
    user,
    "workOrders.deliver",
    legacyCommercial,
  );
  const canSetDesign = canLifecycleOperation(
    user,
    "workOrders.setDesign",
    legacyCommercial,
  );
  const canSetDeliveryMethod = canLifecycleOperation(
    user,
    "workOrders.setDeliveryMethod",
    legacyCommercial,
  );
  const canSetMaterials = canLifecycleOperation(
    user,
    "workOrders.setMaterials",
    legacyCommercial,
  );
  const canReadControlPreflight = canLifecycleOperation(
    user,
    "workOrders.controlPreflight",
    legacyExec,
  );
  /**
   * **طلبُ الإلغاء صار من حقّ فنّي المطبعة** (قرار المالك ١/٩/٢٦): هو أوّلُ من يتحدّث مع
   * العميل وإليه يتّصل ليُلغي. أمّا التعديلُ التجاريّ وعكسُ التسليم فيبقيان على كاشير/مدير —
   * فالمصدرُ الواحد `mayRequestWorkOrderControl` يفرّق بينهما، والخادمُ يُنفّذ الفرق نفسه.
   */
  const canRequestCancel = canLifecycleOperation(
    user,
    "workOrders.requestControl",
    mayRequestWorkOrderControl("CANCEL", role, permissions),
  );
  /**
   * **إسنادُ المندوب يقرأ بوّابةَ التوصيل لا بوّابةَ أمر الشغل** (مراجعة Codex P2): الحوارُ
   * يستعلم `delivery.listParties` (`store:READ`) وينفّذ `delivery.dispatch` (`store:FULL` +
   * كاشير/مدير). ودورٌ مخصّصٌ بـ`workorders:FULL` و`store:NONE` كان يرى الزرَّ ثمّ يصطدم
   * بـFORBIDDEN. مرآةُ `canDispatch` في `DeliveryHub` حرفياً.
   */
  const canDispatchDelivery = canLifecycleOperation(
    user,
    "delivery.dispatch",
    !!role &&
      moduleAccessAllowed(role, permissions, "store", "FULL", [
        "cashier",
        "manager",
      ]),
  );
  const canRequestCommercialControl = canLifecycleOperation(
    user,
    "workOrders.requestControl",
    mayRequestWorkOrderControl("COMMERCIAL_EDIT", role, permissions),
  );
  const canCancelDirectly = canLifecycleOperation(
    user,
    "workOrders.cancel",
    mayCancelWorkOrderWithoutApproval({
      role,
      override: permissions,
      status: "RECEIVED",
      moneyAtStake: false,
      managerControlRequired: false,
    }),
  );
  const canOpenCancellation = canRequestCancel || canCancelDirectly;
  return {
    showCost,
    role,
    permissions,
    canClaimWorkOrder,
    canReleaseWorkOrder,
    canStartWorkOrder,
    canMarkReady,
    canDeliverWorkOrder,
    canSetDesign,
    canSetDeliveryMethod,
    canSetMaterials,
    canReadControlPreflight,
    canRequestCancel,
    canDispatchDelivery,
    canRequestCommercialControl,
    canCancelDirectly,
    canOpenCancellation,
  };
}

interface CancellationPreflight {
  status: string;
  cancelMoneyAtStake: boolean;
  controlRequired: { cancel: boolean };
}

/** The server-authored document state still determines direct cancellation. */
export function workOrderDirectCancellationAllowed(
  user: OperationUser | null | undefined,
  preflight: CancellationPreflight | null | undefined,
  canCancelDirectly: boolean,
): boolean {
  const role = user?.role as RoleKey | undefined;
  const permissions = (user?.permissionsOverride ??
    null) as PermissionMap | null;
  return (
    preflight != null &&
    (user && hasOperationPolicy(user)
      ? canCancelDirectly &&
        preflight.status === "RECEIVED" &&
        !preflight.cancelMoneyAtStake
      : mayCancelWorkOrderWithoutApproval({
          role,
          override: permissions,
          status: preflight.status,
          moneyAtStake: preflight.cancelMoneyAtStake,
          managerControlRequired: preflight.controlRequired.cancel,
        }))
  );
}
