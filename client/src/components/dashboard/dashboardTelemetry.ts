import { fmtAr } from "@/lib/money";

export interface DashboardTelemetrySource {
  shift?: {
    id: number;
    openedAt: string | Date;
    cashierName?: string | null;
  } | null;
  lowStockCount?: number;
  overdueARCount?: number;
  todaySalesInvoiceCount?: number;
  overdueWorkOrders?: number;
  myOpenTasks?: number;
  pendingStocktakesCount?: number;
}

export interface ModuleTelemetry {
  type: "shift" | "alert" | "info" | "badge";
  text: string;
  pulse?: boolean;
  badgeTone: "emerald" | "amber" | "rose" | "blue" | "neutral";
  detail?: string;
}

export interface ModuleQuickAction {
  label: string;
  href: string;
}

export const MODULE_QUICK_ACTIONS: Record<string, readonly ModuleQuickAction[]> = {
  pos: [
    { label: "فاتورة سريعة", href: "/pos" },
    { label: "الوردية", href: "/shifts" },
  ],
  sales: [
    { label: "فاتورة جديدة", href: "/invoices?action=new" },
    { label: "سند قبض", href: "/treasury" },
  ],
  invoices: [
    { label: "فاتورة جديدة", href: "/invoices?action=new" },
    { label: "سند قبض", href: "/treasury" },
  ],
  crm: [
    { label: "إضافة عميل", href: "/customers" },
  ],
  customers: [
    { label: "إضافة عميل", href: "/customers" },
  ],
  priceChecker: [
    { label: "فحص باركود", href: "/barcode" },
  ],
  barcode: [
    { label: "فحص باركود", href: "/barcode" },
  ],
  returns: [
    { label: "مرتجع جديد", href: "/returns" },
  ],
  inventory: [
    { label: "جرد سريع", href: "/stocktakes" },
    { label: "إضافة صنف", href: "/catalog" },
  ],
  purchases: [
    { label: "أمر شراء جديد", href: "/purchasing" },
  ],
  purchasing: [
    { label: "أمر شراء جديد", href: "/purchasing" },
  ],
  suppliers: [
    { label: "مورد جديد", href: "/suppliers" },
  ],
  workOrders: [
    { label: "أمر شغل جديد", href: "/work-orders" },
  ],
  "work-orders": [
    { label: "أمر شغل جديد", href: "/work-orders" },
  ],
  treasury: [
    { label: "سند صرف", href: "/treasury" },
    { label: "سند قبض", href: "/treasury" },
  ],
  reports: [
    { label: "تقرير اليوم", href: "/reports" },
  ],
  tasks: [
    { label: "مهمة جديدة", href: "/tasks" },
  ],
};

export function getModuleTelemetry(
  moduleId: string,
  source?: DashboardTelemetrySource,
): ModuleTelemetry | undefined {
  if (!source) return undefined;

  switch (moduleId) {
    case "pos":
      if (source.shift) {
        return {
          type: "shift",
          text: "وردية نشطة",
          pulse: true,
          badgeTone: "emerald",
        };
      }
      return {
        type: "shift",
        text: "لا توجد وردية",
        pulse: false,
        badgeTone: "neutral",
      };

    case "inventory":
      if (source.lowStockCount && source.lowStockCount > 0) {
        return {
          type: "alert",
          text: `${fmtAr(source.lowStockCount)} منخفض`,
          pulse: true,
          badgeTone: "amber",
        };
      }
      if (source.pendingStocktakesCount && source.pendingStocktakesCount > 0) {
        return {
          type: "badge",
          text: `${fmtAr(source.pendingStocktakesCount)} جرد معلّق`,
          badgeTone: "blue",
        };
      }
      return undefined;

    case "workOrders":
    case "work-orders":
      if (source.overdueWorkOrders && source.overdueWorkOrders > 0) {
        return {
          type: "alert",
          text: `${fmtAr(source.overdueWorkOrders)} متأخر`,
          pulse: true,
          badgeTone: "rose",
        };
      }
      return undefined;

    case "sales":
    case "invoices":
      if (source.overdueARCount && source.overdueARCount > 0) {
        return {
          type: "alert",
          text: `${fmtAr(source.overdueARCount)} ذمم متأخرة`,
          pulse: false,
          badgeTone: "amber",
        };
      }
      if (source.todaySalesInvoiceCount && source.todaySalesInvoiceCount > 0) {
        return {
          type: "info",
          text: `${fmtAr(source.todaySalesInvoiceCount)} فواتير اليوم`,
          badgeTone: "blue",
        };
      }
      return undefined;

    case "tasks":
      if (source.myOpenTasks && source.myOpenTasks > 0) {
        return {
          type: "badge",
          text: `${fmtAr(source.myOpenTasks)} مهام مفتوحة`,
          badgeTone: "blue",
        };
      }
      return undefined;

    default:
      return undefined;
  }
}
