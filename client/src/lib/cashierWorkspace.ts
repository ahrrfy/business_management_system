import type { WorkspaceNavItem } from "./workspaceProfiles";

export type CashierActionIcon =
  | "station"
  | "invoice"
  | "returns"
  | "tasks"
  | "workorders"
  | "price";

export type CashierActionDescriptor = Readonly<{
  id: string;
  href: string;
  name: string;
  description: string;
  icon: CashierActionIcon;
  requiresBranch: boolean;
}>;

const ACTION_META: Readonly<
  Record<string, Readonly<{
    description: string;
    icon: CashierActionIcon;
    requiresBranch: boolean;
  }>>
> = Object.freeze({
  retail_pos: {
    description: "بيع مباشر من محطة التجزئة المصرح بها",
    icon: "station",
    requiresBranch: true,
  },
  print_pos: {
    description: "تسعير وتحصيل خدمات الطباعة من محطتها المخصصة",
    icon: "station",
    requiresBranch: true,
  },
  reception_pos: {
    description: "استقبال الطلبات والتخصيص والدفع من محطة الخدمة",
    icon: "station",
    requiresBranch: true,
  },
  invoices: {
    description: "فواتير محطتك المصرح لك بعرضها وإعادة طباعتها",
    icon: "invoice",
    requiresBranch: true,
  },
  sales_returns: {
    description: "مرتجعات البيع ضمن صلاحية محطتك",
    icon: "returns",
    requiresBranch: true,
  },
  my_tasks: {
    description: "المهام المسندة إليك وما ينتظر متابعتك",
    icon: "tasks",
    requiresBranch: true,
  },
  work_orders: {
    description: "أوامر الشغل ومراحل التنفيذ المصرح بها",
    icon: "workorders",
    requiresBranch: true,
  },
  price_checker: {
    description: "فحص سعر أي منتج سريعاً بالباركود",
    icon: "price",
    requiresBranch: false,
  },
});

/** يحوّل إجراءات profile المسموحة وحدها إلى بطاقات، مع حذف بطاقة المحطة الرئيسية المكررة. */
export function cashierProfileActions(
  primaryNav: readonly WorkspaceNavItem[],
  defaultActionId: string,
  options: Readonly<{ hasBranch: boolean }> = { hasBranch: true },
): readonly CashierActionDescriptor[] {
  return primaryNav
    .filter((item) => item.id !== defaultActionId)
    .map((item) => {
      const meta = ACTION_META[item.id] ?? {
        description: "مدخل عمل مصرح به لهذا الحساب",
        icon: "tasks" as const,
        requiresBranch: true,
      };
      return Object.freeze({
        id: item.id,
        href: item.href,
        name: item.label,
        description: meta.description,
        icon: meta.icon,
        requiresBranch: meta.requiresBranch,
      });
    })
    .filter((item) => options.hasBranch || !item.requiresBranch);
}
