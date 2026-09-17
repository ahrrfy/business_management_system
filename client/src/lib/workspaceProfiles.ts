import {
  deriveEffectiveAccess,
  type AccessLevel,
  type PermissionMap,
  type PosStation,
  type RoleKey,
} from "@shared/permissions";
import {
  INVOICE_LIST_GATE,
  WORK_ORDERS_HUB_GATE,
  canSeeGate,
  type RoleGate,
} from "./navVisibility";

export type WorkspaceProfileId =
  | "unresolved"
  | "management"
  | "accounting"
  | "cashier_multi"
  | "cashier_retail"
  | "cashier_print"
  | "reception"
  | "technician"
  | "warehouse"
  | "purchasing"
  | "sales"
  | "audit"
  | "courier"
  | "general";

export type WorkspaceQueueId =
  | "decisions"
  | "my_tasks"
  | "cash_reconciliation"
  | "delivery_settlement"
  | "retail_shift"
  | "print_shift"
  | "reception_shift"
  | "reception_handover"
  | "work_orders_mine"
  | "work_orders_unassigned"
  | "my_stocktakes"
  | "backorders"
  | "reorder"
  | "purchase_controls"
  | "sales_followups"
  | "audit_exceptions"
  | "my_deliveries";

/** كل مدخل يصرّح بسبب ظهوره؛ لا بوابة اختيارية يمكن أن تفشل مفتوحة. */
export type WorkspaceAccess =
  | Readonly<{ kind: "PUBLIC" }>
  | Readonly<{ kind: "AUTHENTICATED" }>
  | Readonly<{ kind: "GATE"; gate: RoleGate }>
  | Readonly<{ kind: "STATION"; station: PosStation }>;

export type WorkspaceNavItem = Readonly<{
  id: string;
  label: string;
  href: string;
  /** المسار فقط، لأن useLocation لا يضم query string. */
  activePath: string;
  access: WorkspaceAccess;
}>;

export type WorkspaceProfileInput = Readonly<{
  role: RoleKey | null | undefined;
  /** فرق الصلاحيات الخام القادم من auth.me، لا الخريطة المحلولة. */
  permissionsOverride?: PermissionMap | null;
}>;

export type ResolvedWorkspaceProfile = Readonly<{
  id: WorkspaceProfileId;
  stations: readonly PosStation[];
  homeVariant: WorkspaceProfileId;
  defaultAction: WorkspaceNavItem | null;
  primaryNav: readonly WorkspaceNavItem[];
  queues: readonly WorkspaceQueueId[];
}>;

type WorkspaceQueue = Readonly<{
  id: WorkspaceQueueId;
  access: WorkspaceAccess;
}>;

type WorkspaceProfileDefinition = Readonly<{
  defaultActionId?: string;
  primaryNav: readonly WorkspaceNavItem[];
  queues: readonly WorkspaceQueue[];
}>;

const MAX_PRIMARY_NAV = 4;

export const REPORT_VIEWER_GATE: RoleGate = {
  roles: ["manager", "accountant", "auditor"],
  module: "reports",
  level: "READ",
};

export const TREASURY_READ_GATE: RoleGate = {
  roles: ["manager", "accountant", "cashier", "auditor"],
  module: "treasury",
  level: "READ",
};

const PUBLIC_ACCESS: WorkspaceAccess = Object.freeze({ kind: "PUBLIC" });
const AUTHENTICATED_ACCESS: WorkspaceAccess = Object.freeze({
  kind: "AUTHENTICATED",
});

function gateAccess(gate: RoleGate): WorkspaceAccess {
  return Object.freeze({ kind: "GATE", gate });
}

function moduleAccess(
  module: string,
  level: AccessLevel = "READ",
  roles?: RoleKey[],
): WorkspaceAccess {
  return gateAccess(
    roles === undefined ? { module, level } : { roles, module, level },
  );
}

function stationAccess(station: PosStation): WorkspaceAccess {
  return Object.freeze({ kind: "STATION", station });
}

function nav(
  id: string,
  label: string,
  href: string,
  access: WorkspaceAccess,
): WorkspaceNavItem {
  const queryAt = href.indexOf("?");
  return Object.freeze({
    id,
    label,
    href,
    activePath: queryAt === -1 ? href : href.slice(0, queryAt),
    access,
  });
}

function stationItem(
  station: PosStation,
  id: string,
  label: string,
): WorkspaceNavItem {
  return nav(id, label, `/pos?mode=${station}`, stationAccess(station));
}

function queue(id: WorkspaceQueueId, access: WorkspaceAccess): WorkspaceQueue {
  return Object.freeze({ id, access });
}

const NAV = {
  retailPos: stationItem("RETAIL", "retail_pos", "كاشير التجزئة"),
  printPos: stationItem("PRINT_SERVICES", "print_pos", "كاشير خدمات الطباعة"),
  receptionPos: stationItem("RECEPTION", "reception_pos", "استقبال الطلبات"),
  myWork: nav("my_work", "مطلوب مني الآن", "/my-work", AUTHENTICATED_ACCESS),
  tasks: nav("my_tasks", "مهامي", "/tasks?tab=mine", moduleAccess("tasks")),
  courierTasks: nav(
    "my_tasks",
    "مهامي",
    "/tasks?tab=mine",
    moduleAccess("tasks", "READ", []),
  ),
  invoices: nav(
    "invoices",
    "الفواتير",
    "/invoices",
    gateAccess(INVOICE_LIST_GATE),
  ),
  returns: nav(
    "sales_returns",
    "مرتجعات البيع",
    "/returns?tab=sales",
    moduleAccess("sales", "READ", [
      "manager",
      "cashier",
      "accountant",
      "auditor",
    ]),
  ),
  workOrders: nav(
    "work_orders",
    "أوامر الشغل",
    "/work-orders",
    gateAccess(WORK_ORDERS_HUB_GATE),
  ),
  productStudio: nav(
    "product_studio",
    "استوديو المنتجات",
    "/catalog/image-studio",
    moduleAccess("productStudio", "READ", [
      "manager",
      "print_operator",
      "auditor",
    ]),
  ),
  inbox: nav(
    "inbox",
    "صندوق الوارد",
    "/crm?tab=inbox",
    moduleAccess("channels"),
  ),
  crmFollowups: nav(
    "sales_followups",
    "متابعات العملاء",
    "/crm?tab=followups",
    moduleAccess("crm"),
  ),
  pipeline: nav(
    "sales_pipeline",
    "خط المبيعات",
    "/crm?tab=pipeline",
    moduleAccess("crm"),
  ),
  quotations: nav(
    "quotations",
    "عروض الأسعار",
    "/crm?tab=quotations",
    moduleAccess("sales"),
  ),
  inventory: nav(
    "inventory",
    "المخزون",
    "/inventory",
    moduleAccess("inventory"),
  ),
  myStocktakes: nav(
    "my_stocktakes",
    "جردي",
    "/my-stocktake",
    AUTHENTICATED_ACCESS,
  ),
  transfers: nav(
    "transfers",
    "التحويلات",
    "/inventory?tab=transfers",
    moduleAccess("inventory", "FULL", ["warehouse", "manager"]),
  ),
  backorders: nav(
    "backorders",
    "المطلوب توريده",
    "/inventory?tab=backorder",
    moduleAccess("inventory"),
  ),
  purchases: nav(
    "purchases",
    "المشتريات",
    "/purchases",
    moduleAccess("purchases"),
  ),
  purchaseNew: nav(
    "purchase_new",
    "أمر شراء جديد",
    "/purchases/new",
    moduleAccess("purchases", "FULL", ["manager", "purchasing"]),
  ),
  suppliers: nav(
    "suppliers",
    "الموردون",
    "/suppliers",
    moduleAccess("suppliers"),
  ),
  reorder: nav(
    "reorder",
    "إعادة الطلب",
    "/inventory?tab=reorder",
    moduleAccess("inventory"),
  ),
  treasury: nav(
    "treasury",
    "الخزينة",
    "/treasury",
    gateAccess(TREASURY_READ_GATE),
  ),
  reports: nav(
    "reports",
    "التقارير",
    "/reports",
    gateAccess(REPORT_VIEWER_GATE),
  ),
  closing: nav(
    "closing",
    "الإقفال والرقابة",
    "/closing",
    gateAccess(REPORT_VIEWER_GATE),
  ),
  ar: nav(
    "ar",
    "الذمم المدينة",
    "/crm?tab=aging",
    gateAccess(REPORT_VIEWER_GATE),
  ),
  ap: nav(
    "ap",
    "الذمم الدائنة",
    "/suppliers?tab=aging",
    gateAccess(REPORT_VIEWER_GATE),
  ),
  myDeliveries: nav(
    "my_deliveries",
    "توصيلاتي",
    "/my-deliveries",
    moduleAccess("courier", "READ", ["courier"]),
  ),
  priceChecker: nav(
    "price_checker",
    "قارئ الأسعار",
    "/price-checker",
    PUBLIC_ACCESS,
  ),
} as const satisfies Record<string, WorkspaceNavItem>;

const QUEUE = {
  decisions: queue("decisions", AUTHENTICATED_ACCESS),
  myTasks: queue("my_tasks", moduleAccess("tasks")),
  courierTasks: queue("my_tasks", moduleAccess("tasks", "READ", [])),
  cashReconciliation: queue(
    "cash_reconciliation",
    moduleAccess("treasury", "FULL", ["manager", "accountant"]),
  ),
  deliverySettlement: queue(
    "delivery_settlement",
    moduleAccess("consignments"),
  ),
  retailShift: queue("retail_shift", stationAccess("RETAIL")),
  printShift: queue("print_shift", stationAccess("PRINT_SERVICES")),
  receptionShift: queue("reception_shift", stationAccess("RECEPTION")),
  receptionHandover: queue("reception_handover", stationAccess("RECEPTION")),
  workOrdersMine: queue("work_orders_mine", gateAccess(WORK_ORDERS_HUB_GATE)),
  workOrdersUnassigned: queue(
    "work_orders_unassigned",
    moduleAccess("workorders", "FULL", ["manager"]),
  ),
  myStocktakes: queue("my_stocktakes", AUTHENTICATED_ACCESS),
  backorders: queue("backorders", moduleAccess("inventory")),
  reorder: queue("reorder", moduleAccess("inventory")),
  purchaseControls: queue(
    "purchase_controls",
    moduleAccess("purchases", "FULL", ["manager", "purchasing"]),
  ),
  salesFollowups: queue("sales_followups", moduleAccess("crm")),
  auditExceptions: queue("audit_exceptions", gateAccess(REPORT_VIEWER_GATE)),
  myDeliveries: queue(
    "my_deliveries",
    moduleAccess("courier", "READ", ["courier"]),
  ),
} as const satisfies Record<string, WorkspaceQueue>;

const PROFILES: Readonly<
  Record<Exclude<WorkspaceProfileId, "unresolved">, WorkspaceProfileDefinition>
> = {
  management: {
    defaultActionId: NAV.myWork.id,
    primaryNav: [NAV.myWork, NAV.reports, NAV.treasury, NAV.workOrders],
    queues: [
      QUEUE.decisions,
      QUEUE.cashReconciliation,
      QUEUE.deliverySettlement,
      QUEUE.workOrdersUnassigned,
    ],
  },
  accounting: {
    defaultActionId: NAV.treasury.id,
    primaryNav: [NAV.treasury, NAV.reports, NAV.ar, NAV.ap],
    queues: [
      QUEUE.decisions,
      QUEUE.cashReconciliation,
      QUEUE.deliverySettlement,
      QUEUE.auditExceptions,
    ],
  },
  cashier_multi: {
    defaultActionId: NAV.retailPos.id,
    primaryNav: [NAV.retailPos, NAV.printPos, NAV.receptionPos, NAV.invoices],
    queues: [
      QUEUE.retailShift,
      QUEUE.printShift,
      QUEUE.receptionShift,
      QUEUE.myTasks,
    ],
  },
  cashier_retail: {
    defaultActionId: NAV.retailPos.id,
    primaryNav: [NAV.retailPos, NAV.invoices, NAV.returns, NAV.tasks],
    queues: [QUEUE.retailShift, QUEUE.myTasks, QUEUE.decisions],
  },
  cashier_print: {
    defaultActionId: NAV.printPos.id,
    primaryNav: [NAV.printPos, NAV.invoices, NAV.priceChecker, NAV.tasks],
    queues: [QUEUE.printShift, QUEUE.myTasks, QUEUE.decisions],
  },
  reception: {
    defaultActionId: NAV.receptionPos.id,
    primaryNav: [NAV.receptionPos, NAV.workOrders, NAV.invoices, NAV.tasks],
    queues: [
      QUEUE.receptionShift,
      QUEUE.receptionHandover,
      QUEUE.workOrdersMine,
      QUEUE.myTasks,
    ],
  },
  technician: {
    defaultActionId: NAV.workOrders.id,
    primaryNav: [NAV.workOrders, NAV.tasks, NAV.productStudio, NAV.inbox],
    queues: [QUEUE.workOrdersMine, QUEUE.myTasks, QUEUE.decisions],
  },
  warehouse: {
    defaultActionId: NAV.inventory.id,
    primaryNav: [
      NAV.inventory,
      NAV.myStocktakes,
      NAV.transfers,
      NAV.backorders,
    ],
    queues: [QUEUE.myStocktakes, QUEUE.backorders, QUEUE.myTasks],
  },
  purchasing: {
    defaultActionId: NAV.purchases.id,
    primaryNav: [NAV.purchases, NAV.purchaseNew, NAV.suppliers, NAV.reorder],
    queues: [QUEUE.purchaseControls, QUEUE.reorder, QUEUE.decisions],
  },
  sales: {
    defaultActionId: NAV.crmFollowups.id,
    primaryNav: [NAV.crmFollowups, NAV.inbox, NAV.pipeline, NAV.quotations],
    queues: [QUEUE.salesFollowups, QUEUE.myTasks, QUEUE.decisions],
  },
  audit: {
    defaultActionId: NAV.reports.id,
    primaryNav: [NAV.reports, NAV.closing, NAV.invoices, NAV.inventory],
    queues: [QUEUE.auditExceptions, QUEUE.decisions, QUEUE.deliverySettlement],
  },
  courier: {
    defaultActionId: NAV.myDeliveries.id,
    primaryNav: [NAV.myDeliveries, NAV.courierTasks],
    queues: [QUEUE.myDeliveries, QUEUE.courierTasks],
  },
  general: {
    primaryNav: [
      NAV.retailPos,
      NAV.printPos,
      NAV.receptionPos,
      NAV.myWork,
      NAV.tasks,
      NAV.invoices,
      NAV.inventory,
      NAV.reports,
    ],
    queues: [
      QUEUE.decisions,
      QUEUE.myTasks,
      QUEUE.retailShift,
      QUEUE.printShift,
      QUEUE.receptionShift,
    ],
  },
};

function chooseProfile(
  role: RoleKey,
  stations: readonly PosStation[],
): Exclude<WorkspaceProfileId, "unresolved"> {
  if (role === "admin" || role === "manager") return "management";
  if (role === "courier") return "courier";
  if (role === "print_operator") return "technician";
  if (role === "cashier") {
    if (stations.length > 1) return "cashier_multi";
    if (stations[0] === "RETAIL") return "cashier_retail";
    if (stations[0] === "PRINT_SERVICES") return "cashier_print";
    if (stations[0] === "RECEPTION") return "reception";
    return "general";
  }
  if (role === "accountant") return "accounting";
  if (role === "warehouse") return "warehouse";
  if (role === "purchasing") return "purchasing";
  if (role === "sales_rep") return "sales";
  if (role === "auditor") return "audit";
  return "general";
}

function allowed(
  access: WorkspaceAccess,
  role: RoleKey,
  permissionsOverride: PermissionMap | null,
  stations: readonly PosStation[],
): boolean {
  switch (access.kind) {
    case "PUBLIC":
    case "AUTHENTICATED":
      return true;
    case "GATE":
      return canSeeGate(access.gate, role, permissionsOverride);
    case "STATION":
      return stations.includes(access.station);
  }
}

export function resolveWorkspaceProfile(
  input: WorkspaceProfileInput,
): ResolvedWorkspaceProfile {
  if (!input.role) {
    return Object.freeze({
      id: "unresolved",
      stations: Object.freeze([]),
      homeVariant: "unresolved",
      defaultAction: null,
      primaryNav: Object.freeze([]),
      queues: Object.freeze([]),
    });
  }

  const role = input.role;
  const permissionsOverride = input.permissionsOverride ?? null;
  const access = deriveEffectiveAccess(role, permissionsOverride);
  const id = chooseProfile(role, access.stations);
  const definition = PROFILES[id];
  const seen = new Set<string>();
  const primaryNav = definition.primaryNav
    .filter((item) =>
      allowed(item.access, role, permissionsOverride, access.stations),
    )
    .filter((item) => !seen.has(item.id) && seen.add(item.id))
    .slice(0, MAX_PRIMARY_NAV);
  const defaultAction =
    primaryNav.find((item) => item.id === definition.defaultActionId) ??
    primaryNav[0] ??
    null;
  const queues = definition.queues
    .filter((item) =>
      allowed(item.access, role, permissionsOverride, access.stations),
    )
    .map((item) => item.id);

  return Object.freeze({
    id,
    stations: Object.freeze([...access.stations]),
    homeVariant: id,
    defaultAction,
    primaryNav: Object.freeze(primaryNav),
    queues: Object.freeze(queues),
  });
}
