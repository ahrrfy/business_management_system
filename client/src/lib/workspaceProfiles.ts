import {
  POS_STATION_GATES,
  deriveEffectiveAccess,
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

export type WorkspaceNavItem = Readonly<{
  id: string;
  label: string;
  href: string;
  /** المسار فقط، لأن useLocation لا يضم query string. */
  activePath: string;
  gate?: RoleGate;
  station?: PosStation;
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
  gate?: RoleGate;
  station?: PosStation;
}>;

type WorkspaceProfileDefinition = Readonly<{
  defaultActionId?: string;
  primaryNav: readonly WorkspaceNavItem[];
  queues: readonly WorkspaceQueue[];
}>;

const MAX_PRIMARY_NAV = 6;

function stationGate(station: PosStation): RoleGate {
  const gate = POS_STATION_GATES[station];
  return { roles: gate.allowedRoles, module: gate.module, level: "FULL" };
}

function stationItem(
  station: PosStation,
  id: string,
  label: string,
): WorkspaceNavItem {
  return Object.freeze({
    id,
    label,
    href: `/pos?mode=${station}`,
    activePath: "/pos",
    gate: stationGate(station),
    station,
  });
}

const NAV = {
  retailPos: stationItem("RETAIL", "retail_pos", "كاشير التجزئة"),
  printPos: stationItem("PRINT_SERVICES", "print_pos", "كاشير خدمات الطباعة"),
  receptionPos: stationItem("RECEPTION", "reception_pos", "استقبال الطلبات"),
  myWork: { id: "my_work", label: "مطلوب مني الآن", href: "/my-work", activePath: "/my-work" },
  tasks: { id: "my_tasks", label: "مهامي", href: "/tasks?tab=mine", activePath: "/tasks", gate: { module: "tasks", level: "READ" } },
  invoices: { id: "invoices", label: "الفواتير", href: "/invoices", activePath: "/invoices", gate: INVOICE_LIST_GATE },
  returns: { id: "sales_returns", label: "مرتجعات البيع", href: "/returns?tab=sales", activePath: "/returns", gate: { roles: ["manager", "cashier", "accountant", "auditor"], module: "sales", level: "READ" } },
  workOrders: { id: "work_orders", label: "أوامر الشغل", href: "/work-orders", activePath: "/work-orders", gate: WORK_ORDERS_HUB_GATE },
  productStudio: { id: "product_studio", label: "استوديو المنتجات", href: "/catalog/image-studio", activePath: "/catalog/image-studio", gate: { roles: ["manager", "print_operator", "auditor"], module: "productStudio", level: "READ" } },
  inbox: { id: "inbox", label: "صندوق الوارد", href: "/crm?tab=inbox", activePath: "/crm", gate: { module: "channels", level: "READ" } },
  crmFollowups: { id: "sales_followups", label: "متابعات العملاء", href: "/crm?tab=followups", activePath: "/crm", gate: { module: "crm", level: "READ" } },
  pipeline: { id: "sales_pipeline", label: "خط المبيعات", href: "/crm?tab=pipeline", activePath: "/crm", gate: { module: "crm", level: "READ" } },
  quotations: { id: "quotations", label: "عروض الأسعار", href: "/crm?tab=quotations", activePath: "/crm", gate: { module: "crm", level: "READ" } },
  inventory: { id: "inventory", label: "المخزون", href: "/inventory", activePath: "/inventory", gate: { module: "inventory", level: "READ" } },
  myStocktakes: { id: "my_stocktakes", label: "جردي", href: "/my-stocktake", activePath: "/my-stocktake", gate: { module: "inventory", level: "FULL" } },
  transfers: { id: "transfers", label: "التحويلات", href: "/inventory?tab=transfers", activePath: "/inventory", gate: { module: "inventory", level: "FULL" } },
  backorders: { id: "backorders", label: "النواقص والحجوزات", href: "/inventory?tab=backorders", activePath: "/inventory", gate: { module: "inventory", level: "READ" } },
  purchases: { id: "purchases", label: "المشتريات", href: "/purchases", activePath: "/purchases", gate: { module: "purchases", level: "READ" } },
  purchaseNew: { id: "purchase_new", label: "أمر شراء جديد", href: "/purchases/new", activePath: "/purchases/new", gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" } },
  suppliers: { id: "suppliers", label: "الموردون", href: "/suppliers", activePath: "/suppliers", gate: { module: "suppliers", level: "READ" } },
  reorder: { id: "reorder", label: "إعادة الطلب", href: "/inventory?tab=reorder", activePath: "/inventory", gate: { module: "purchases", level: "FULL" } },
  treasury: { id: "treasury", label: "الخزينة", href: "/treasury", activePath: "/treasury", gate: { module: "treasury", level: "READ" } },
  reports: { id: "reports", label: "التقارير", href: "/reports", activePath: "/reports", gate: { roles: ["manager", "accountant", "auditor"], module: "reports", level: "READ" } },
  closing: { id: "closing", label: "الإقفال والرقابة", href: "/closing", activePath: "/closing", gate: { roles: ["manager", "accountant", "auditor"], module: "reports", level: "READ" } },
  ar: { id: "ar", label: "الذمم المدينة", href: "/crm?tab=aging", activePath: "/crm", gate: { module: "collections", level: "READ" } },
  ap: { id: "ap", label: "الذمم الدائنة", href: "/suppliers?tab=aging", activePath: "/suppliers", gate: { module: "suppliers", level: "READ" } },
  delivery: { id: "delivery", label: "التوصيل والتسويات", href: "/delivery", activePath: "/delivery", gate: { roles: ["manager", "accountant", "cashier", "auditor"], module: "store", level: "READ" } },
  myDeliveries: { id: "my_deliveries", label: "توصيلاتي", href: "/my-deliveries", activePath: "/my-deliveries", gate: { roles: ["courier"], module: "courier", level: "READ" } },
  priceChecker: { id: "price_checker", label: "قارئ الأسعار", href: "/price-checker", activePath: "/price-checker" },
} as const satisfies Record<string, WorkspaceNavItem>;

const QUEUE = {
  decisions: { id: "decisions" },
  myTasks: { id: "my_tasks", gate: { module: "tasks", level: "READ" } },
  cashReconciliation: { id: "cash_reconciliation", gate: { module: "treasury", level: "FULL" } },
  deliverySettlement: { id: "delivery_settlement", gate: { module: "consignments", level: "READ" } },
  retailShift: { id: "retail_shift", gate: stationGate("RETAIL"), station: "RETAIL" },
  printShift: { id: "print_shift", gate: stationGate("PRINT_SERVICES"), station: "PRINT_SERVICES" },
  receptionShift: { id: "reception_shift", gate: stationGate("RECEPTION"), station: "RECEPTION" },
  receptionHandover: { id: "reception_handover", gate: stationGate("RECEPTION"), station: "RECEPTION" },
  workOrdersMine: { id: "work_orders_mine", gate: WORK_ORDERS_HUB_GATE },
  workOrdersUnassigned: { id: "work_orders_unassigned", gate: { roles: ["manager"], module: "workorders", level: "FULL" } },
  myStocktakes: { id: "my_stocktakes", gate: { module: "inventory", level: "FULL" } },
  backorders: { id: "backorders", gate: { module: "inventory", level: "READ" } },
  reorder: { id: "reorder", gate: { module: "purchases", level: "FULL" } },
  purchaseControls: { id: "purchase_controls", gate: { roles: ["manager", "purchasing"], module: "purchases", level: "FULL" } },
  salesFollowups: { id: "sales_followups", gate: { module: "crm", level: "READ" } },
  auditExceptions: { id: "audit_exceptions", gate: { roles: ["manager", "accountant", "auditor"], module: "reports", level: "READ" } },
  myDeliveries: { id: "my_deliveries", gate: { roles: ["courier"], module: "courier", level: "READ" } },
} as const satisfies Record<string, WorkspaceQueue>;

const PROFILES: Readonly<Record<Exclude<WorkspaceProfileId, "unresolved">, WorkspaceProfileDefinition>> = {
  management: {
    defaultActionId: NAV.myWork.id,
    primaryNav: [NAV.myWork, NAV.reports, NAV.treasury, NAV.workOrders, NAV.closing],
    queues: [QUEUE.decisions, QUEUE.cashReconciliation, QUEUE.deliverySettlement, QUEUE.workOrdersUnassigned],
  },
  accounting: {
    defaultActionId: NAV.treasury.id,
    primaryNav: [NAV.treasury, NAV.reports, NAV.ar, NAV.ap, NAV.delivery, NAV.myWork],
    queues: [QUEUE.decisions, QUEUE.cashReconciliation, QUEUE.deliverySettlement, QUEUE.auditExceptions],
  },
  cashier_multi: {
    defaultActionId: NAV.retailPos.id,
    primaryNav: [NAV.retailPos, NAV.printPos, NAV.receptionPos, NAV.invoices, NAV.returns, NAV.tasks],
    queues: [QUEUE.retailShift, QUEUE.printShift, QUEUE.receptionShift, QUEUE.myTasks],
  },
  cashier_retail: {
    defaultActionId: NAV.retailPos.id,
    primaryNav: [NAV.retailPos, NAV.invoices, NAV.returns, NAV.tasks, NAV.myWork],
    queues: [QUEUE.retailShift, QUEUE.myTasks, QUEUE.decisions],
  },
  cashier_print: {
    defaultActionId: NAV.printPos.id,
    primaryNav: [NAV.printPos, NAV.invoices, NAV.priceChecker, NAV.tasks, NAV.myWork],
    queues: [QUEUE.printShift, QUEUE.myTasks, QUEUE.decisions],
  },
  reception: {
    defaultActionId: NAV.receptionPos.id,
    primaryNav: [NAV.receptionPos, NAV.workOrders, NAV.invoices, NAV.tasks, NAV.myWork],
    queues: [QUEUE.receptionShift, QUEUE.receptionHandover, QUEUE.workOrdersMine, QUEUE.myTasks],
  },
  technician: {
    defaultActionId: NAV.workOrders.id,
    primaryNav: [NAV.workOrders, NAV.tasks, NAV.productStudio, NAV.inbox, NAV.myWork],
    queues: [QUEUE.workOrdersMine, QUEUE.myTasks, QUEUE.decisions],
  },
  warehouse: {
    defaultActionId: NAV.inventory.id,
    primaryNav: [NAV.inventory, NAV.myStocktakes, NAV.transfers, NAV.backorders, NAV.tasks, NAV.myWork],
    queues: [QUEUE.myStocktakes, QUEUE.backorders, QUEUE.myTasks],
  },
  purchasing: {
    defaultActionId: NAV.purchases.id,
    primaryNav: [NAV.purchases, NAV.purchaseNew, NAV.suppliers, NAV.reorder, NAV.reports, NAV.myWork],
    queues: [QUEUE.purchaseControls, QUEUE.reorder, QUEUE.decisions],
  },
  sales: {
    defaultActionId: NAV.crmFollowups.id,
    primaryNav: [NAV.crmFollowups, NAV.inbox, NAV.pipeline, NAV.quotations, NAV.tasks, NAV.myWork],
    queues: [QUEUE.salesFollowups, QUEUE.myTasks, QUEUE.decisions],
  },
  audit: {
    defaultActionId: NAV.reports.id,
    primaryNav: [NAV.reports, NAV.closing, NAV.invoices, NAV.inventory, NAV.treasury, NAV.myWork],
    queues: [QUEUE.auditExceptions, QUEUE.decisions, QUEUE.deliverySettlement],
  },
  courier: {
    defaultActionId: NAV.myDeliveries.id,
    primaryNav: [NAV.myDeliveries, NAV.tasks],
    queues: [QUEUE.myDeliveries, QUEUE.myTasks],
  },
  general: {
    primaryNav: [NAV.retailPos, NAV.printPos, NAV.receptionPos, NAV.myWork, NAV.tasks, NAV.invoices, NAV.inventory, NAV.reports],
    queues: [QUEUE.decisions, QUEUE.myTasks, QUEUE.retailShift, QUEUE.printShift, QUEUE.receptionShift],
  },
};

function chooseProfile(role: RoleKey, stations: readonly PosStation[]): Exclude<WorkspaceProfileId, "unresolved"> {
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
  item: Pick<WorkspaceNavItem, "gate" | "station">,
  role: RoleKey,
  permissionsOverride: PermissionMap | null,
  stations: readonly PosStation[],
): boolean {
  if (item.station && !stations.includes(item.station)) return false;
  return canSeeGate(item.gate, role, permissionsOverride);
}

export function resolveWorkspaceProfile(input: WorkspaceProfileInput): ResolvedWorkspaceProfile {
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
    .filter((item) => allowed(item, role, permissionsOverride, access.stations))
    .filter((item) => !seen.has(item.id) && seen.add(item.id))
    .slice(0, MAX_PRIMARY_NAV);
  const defaultAction = primaryNav.find((item) => item.id === definition.defaultActionId)
    ?? primaryNav[0]
    ?? null;
  const queues = definition.queues
    .filter((queue) => allowed(queue, role, permissionsOverride, access.stations))
    .map((queue) => queue.id);

  return Object.freeze({
    id,
    stations: Object.freeze([...access.stations]),
    homeVariant: id,
    defaultAction,
    primaryNav: Object.freeze(primaryNav),
    queues: Object.freeze(queues),
  });
}
