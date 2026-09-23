import { type PermissionMap } from "@shared/permissions";
import {
  canSeeGate,
  INVOICE_LIST_GATE,
  RECEPTION_STATION_GATE,
  type RoleGate,
} from "@/lib/navVisibility";

export type ReceptionOperationsTabValue =
  | "orders"
  | "invoices"
  | "workflow"
  | "handover"
  | "drafts";

export type ReceptionOperationsTabDefinition = {
  value: ReceptionOperationsTabValue;
  label: string;
  gate: RoleGate;
};

export { RECEPTION_STATION_GATE } from "@/lib/navVisibility";

/** العمليات المالية والتسليم النهائي تتبع workordersCashierProcedure، لا بوابة التنفيذ الأوسع. */
const RECEPTION_CASHIER_GATE: RoleGate = {
  roles: ["cashier", "manager"],
  module: "workorders",
  level: "FULL",
};

const RECEPTION_MANAGER_GATE: RoleGate = {
  roles: ["manager"],
  module: "workorders",
  level: "FULL",
};

const TREASURY_READ_GATE: RoleGate = { module: "treasury", level: "READ" };
const PRODUCTS_READ_GATE: RoleGate = { module: "products", level: "READ" };
const SALES_FULL_GATE: RoleGate = { module: "sales", level: "FULL" };
const DELIVERY_FULL_GATE: RoleGate = {
  roles: ["cashier", "manager", "sales_rep"],
  module: "store",
  level: "FULL",
};

/**
 * الفواتير تقاطعٌ مقصود: INVOICE_LIST_GATE وحدها تقبل المبيعات أو محطة الطباعة،
 * لذلك لا يجوز استعمالها كبديل عن بوابة الاستقبال وإلا اتسع المركز لغير موظفيه.
 */
export const RECEPTION_INVOICES_GATE: RoleGate = {
  allOf: [
    RECEPTION_CASHIER_GATE,
    INVOICE_LIST_GATE,
    TREASURY_READ_GATE,
    PRODUCTS_READ_GATE,
    DELIVERY_FULL_GATE,
  ],
};

const RECEPTION_WORKFLOW_GATE: RoleGate = {
  allOf: [
    // الصفحة القائمة تجمع الإسناد مع الإلغاء المباشر والمرتجع. الإلغاء محروس
    // خادمياً للمدير/الفنّي، بينما المرتجع يحتاج sales:FULL؛ تقاطع الصفحة كاملةً
    // آمن للمدير فقط إلى أن تُفصل أقسامها داخلياً ببوابات مستقلة.
    RECEPTION_MANAGER_GATE,
    DELIVERY_FULL_GATE,
    TREASURY_READ_GATE,
    PRODUCTS_READ_GATE,
    SALES_FULL_GATE,
  ],
};

const RECEPTION_HANDOVER_GATE: RoleGate = {
  allOf: [RECEPTION_CASHIER_GATE, TREASURY_READ_GATE, PRODUCTS_READ_GATE],
};

/** الترتيب عقد واجهة: الأوّل هو السقوط الآمن والافتراضي عند غياب/رفض ?tab=. */
export const RECEPTION_OPERATION_TAB_DEFINITIONS = [
  {
    value: "orders",
    label: "طلبات المحطة",
    gate: RECEPTION_STATION_GATE,
  },
  {
    value: "invoices",
    label: "فواتير التحصيل",
    gate: RECEPTION_INVOICES_GATE,
  },
  {
    value: "workflow",
    label: "التوصيل والمعالجة",
    gate: RECEPTION_WORKFLOW_GATE,
  },
  {
    value: "handover",
    label: "التسليم المباشر",
    gate: RECEPTION_HANDOVER_GATE,
  },
  {
    value: "drafts",
    label: "الطلبات المحفوظة",
    gate: RECEPTION_STATION_GATE,
  },
] satisfies readonly ReceptionOperationsTabDefinition[];

/** مصدر واحد لمرئية تبويبات المركز وبطاقات الرئيسية؛ غياب الفرع يغلقها كلها. */
export function visibleReceptionOperationTabs(input: {
  hasBranch: boolean;
  role: string | null | undefined;
  permissionsOverride?: PermissionMap | null;
}): ReceptionOperationsTabValue[] {
  if (!input.hasBranch) return [];
  return RECEPTION_OPERATION_TAB_DEFINITIONS
    .filter((tab) => canSeeGate(tab.gate, input.role, input.permissionsOverride))
    .map((tab) => tab.value);
}
