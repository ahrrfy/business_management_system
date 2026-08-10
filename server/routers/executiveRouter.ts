import { TRPCError } from "@trpc/server";
import type { AccessLevel } from "@shared/permissions";
import { z } from "zod";
import { reportViewerProcedure, router } from "../trpc";
import { getDashboardMetrics, type DashboardMetricsResult } from "../services/reports/dashboard";
import { getManagementAlerts, type AlertItem } from "../services/reportsAlertsService";
import { getDashboard as getTreasuryDashboard } from "../services/treasuryService";
import { money, toDbMoney } from "../services/money";
import { getTodayNetSales } from "../services/reports/todaySales";
import { resolveSuperAppAuthority } from "./superAppRouter";

export const executiveDestinationKeys = [
  "INSIGHTS", "RECEIVABLES", "PRODUCTS", "SHIFTS", "WORK_ORDERS", "PURCHASING", "TASKS",
] as const;
export type ExecutiveDestinationKey = (typeof executiveDestinationKeys)[number];

export interface ExecutiveAction {
  destinationKey: ExecutiveDestinationKey;
  args: Record<string, string | number | boolean>;
}

type ExecutiveUser = {
  id?: number;
  role: string;
  isOwner?: boolean;
  branchId?: number | null;
  permissionsOverride?: unknown;
  roleLockedByInactiveCustomRole?: boolean;
};

export function assertExecutiveAccess(user: ExecutiveUser): void {
  if (!resolveSuperAppAuthority(user).capabilities.isExecutive) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه اللوحة مخصصة للإدارة المخولة" });
  }
}

export function resolveExecutiveBranch(
  user: ExecutiveUser,
  requested?: number,
): number | undefined {
  const authority = resolveSuperAppAuthority(user);
  if (authority.scope.allBranches) return requested;
  const assigned = authority.scope.effectiveBranchId;
  if (assigned == null || assigned < 1) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يوجد فرع مسند لهذا المستخدم" });
  }
  if (requested != null && requested !== assigned) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن عرض بيانات فرع آخر" });
  }
  return assigned;
}

export function alertAction(alert: Pick<AlertItem, "key" | "href">): ExecutiveAction {
  switch (alert.href) {
    case "/reports/aging-hub": return { destinationKey: "RECEIVABLES", args: { bucket: alert.key } };
    case "/reports/credit-exposure": return { destinationKey: "RECEIVABLES", args: { view: "creditExposure" } };
    case "/reports/stock-status": return { destinationKey: "PRODUCTS", args: { stockState: alert.key === "stock-out" ? "out" : "low" } };
    case "/shifts": return { destinationKey: "SHIFTS", args: { variance: true } };
    case "/reports/work-orders": return { destinationKey: "WORK_ORDERS", args: { overdue: true } };
    case "/reports/inventory-ops": return { destinationKey: "PRODUCTS", args: { stockState: "dead" } };
    case "/ap-aging": return { destinationKey: "PURCHASING", args: { view: "payables" } };
    case "/reports/anomaly-watch": return { destinationKey: "INSIGHTS", args: { section: "anomalies" } };
    case "/reconcile": return { destinationKey: "INSIGHTS", args: { section: "reconciliation" } };
    default: return { destinationKey: "INSIGHTS", args: { section: "managementAlerts" } };
  }
}

function permissionReadable(map: Record<string, AccessLevel>, key: string): boolean {
  return map[key] === "READ" || map[key] === "FULL";
}

export const getExecutiveTodaySales = getTodayNetSales;

export type ExecutiveCapabilities = ReturnType<typeof resolveExecutiveCapabilities>;

export function resolveExecutiveCapabilities(user: ExecutiveUser) {
  const authority = resolveSuperAppAuthority(user);
  const permissions = authority.permissions as Record<string, AccessLevel>;
  return {
    financial: authority.capabilities.canViewReports,
    sales: permissionReadable(permissions, "sales") || permissionReadable(permissions, "pos"),
    inventory: permissionReadable(permissions, "inventory") || permissionReadable(permissions, "products"),
    receivables: permissionReadable(permissions, "collections") || permissionReadable(permissions, "sales"),
    workOrders: permissionReadable(permissions, "workorders"),
    tasks: permissionReadable(permissions, "tasks"),
    treasury: permissionReadable(permissions, "treasury"),
    purchasing: permissionReadable(permissions, "purchases") || permissionReadable(permissions, "suppliers"),
  };
}

/** Never serialize a metric slice whose server capability is false. */
export function selectPermittedExecutiveMetrics(
  metrics: DashboardMetricsResult,
  capabilities: ExecutiveCapabilities,
) {
  const receivables = capabilities.financial && capabilities.receivables;
  const sales = capabilities.financial && capabilities.sales;
  return {
    lowStockCount: capabilities.inventory ? metrics.lowStockCount : null,
    overdueAR: receivables ? metrics.overdueAR : null,
    salesPulse: sales ? metrics.salesPulse : null,
    morningBrief: {
      arRemindersDue: receivables ? metrics.morningBrief.arRemindersDue : null,
      promisedToday: receivables ? metrics.morningBrief.promisedToday : null,
      overdueWorkOrders: capabilities.workOrders ? metrics.morningBrief.overdueWorkOrders : null,
      myOpenTasks: capabilities.tasks ? metrics.morningBrief.myOpenTasks : null,
      overdueTasks: capabilities.tasks ? metrics.morningBrief.overdueTasks : null,
    },
  };
}

function actionPermitted(action: ExecutiveAction, capabilities: ExecutiveCapabilities): boolean {
  switch (action.destinationKey) {
    case "RECEIVABLES": return capabilities.financial && capabilities.receivables;
    case "PRODUCTS": return capabilities.inventory;
    case "SHIFTS": return capabilities.treasury;
    case "WORK_ORDERS": return capabilities.workOrders;
    case "PURCHASING": return capabilities.purchasing;
    case "TASKS": return capabilities.tasks;
    case "INSIGHTS": return capabilities.financial;
  }
}

const emptyMetrics = (): DashboardMetricsResult => ({
  lowStockCount: 0,
  overdueAR: { count: 0, total: "0.00" },
  salesPulse: { yesterday: "0.00", avg7d: "0.00", direction: "flat", changePct: 0 },
  morningBrief: { arRemindersDue: 0, promisedToday: 0, overdueWorkOrders: 0, myOpenTasks: 0, overdueTasks: 0 },
  health: { status: "degraded", sourceErrors: ["metrics"] },
});

export const executiveRouter = router({
  commandCenter: reportViewerProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      assertExecutiveAccess(ctx.user);
      const authority = resolveSuperAppAuthority(ctx.user);
      const branchId = resolveExecutiveBranch(ctx.user, input?.branchId);
      const capabilities = resolveExecutiveCapabilities(ctx.user);
      const partialErrors: Array<{ section: string; code: string }> = [];
      const safe = async <T>(section: string, load: () => Promise<T>, fallback: T): Promise<T> => {
        try { return await load(); }
        catch { partialErrors.push({ section, code: "SOURCE_UNAVAILABLE" }); return fallback; }
      };
      const [metrics, alertsResult, salesToday, treasuryDashboard] = await Promise.all([
        safe("metrics", () => getDashboardMetrics({
          branchId: branchId ?? null,
          includeOpeningBalance: authority.scope.allBranches && branchId == null,
          includeFinancials: capabilities.financial && (capabilities.sales || capabilities.receivables),
          userId: ctx.user.id,
        }), emptyMetrics()),
        capabilities.financial
          ? safe("alerts", () => getManagementAlerts({ branchId, isAdmin: authority.scope.allBranches }), { alerts: [], generatedAt: "", sourceErrors: ["alerts"] })
          : Promise.resolve({ alerts: [], generatedAt: "", sourceErrors: [] }),
        capabilities.sales
          ? safe("salesToday", () => getExecutiveTodaySales(branchId), null)
          : Promise.resolve(null),
        capabilities.treasury
          ? safe("treasurySnapshot", () => getTreasuryDashboard(
            { branchId },
            { scopedBranchId: authority.scope.allBranches ? null : branchId ?? null, role: authority.scope.allBranches ? "admin" : ctx.user.role, userId: ctx.user.id },
          ), null)
          : Promise.resolve(null),
      ]);
      for (const source of metrics.health.sourceErrors) {
        partialErrors.push({ section: `metrics.${source}`, code: "SOURCE_UNAVAILABLE" });
      }
      for (const source of alertsResult.sourceErrors) {
        partialErrors.push({ section: `alerts.${source}`, code: "SOURCE_UNAVAILABLE" });
      }
      const asOf = new Date().toISOString();
      const treasurySnapshot = treasuryDashboard == null ? null : {
        treasuryBalance: toDbMoney(treasuryDashboard.treasuryBalances.reduce((sum, row) => sum.plus(money(row.balance)), money(0))),
        drawerBalance: toDbMoney(treasuryDashboard.drawerBalances.reduce((sum, row) => sum.plus(money(row.expectedCash)), money(0))),
        todayReceipts: treasuryDashboard.todayReceiptsTotal,
        todayExpenses: treasuryDashboard.todayExpensesTotal,
        openShiftsCount: treasuryDashboard.openShiftsCount,
        generatedAt: treasuryDashboard.generatedAt,
      };
      return {
        asOf,
        scope: { branchId: branchId ?? null, allBranches: authority.scope.allBranches && branchId == null },
        capabilities,
        health: { status: partialErrors.length ? "degraded" as const : "ok" as const, partialErrors },
        operationalSnapshot: {
          salesToday: salesToday == null ? null : {
            total: salesToday.total,
            invoiceCount: salesToday.invoiceCount,
            freshness: { asOf: salesToday.generatedAt, source: "database" as const },
          },
          treasury: treasurySnapshot == null ? null : {
            treasuryBalance: treasurySnapshot.treasuryBalance,
            drawerBalance: treasurySnapshot.drawerBalance,
            todayReceipts: treasurySnapshot.todayReceipts,
            todayExpenses: treasurySnapshot.todayExpenses,
            openShiftsCount: treasurySnapshot.openShiftsCount,
            freshness: { asOf: treasurySnapshot.generatedAt, source: "treasury-ledger" as const },
          },
        },
        metrics: selectPermittedExecutiveMetrics(metrics, capabilities),
        decisions: alertsResult.alerts.flatMap((alert) => {
          const action = alertAction(alert);
          return actionPermitted(action, capabilities) ? [{
            id: alert.key,
            severity: alert.severity,
            title: alert.title,
            count: alert.count,
            amount: alert.amount,
            actionLabel: alert.actionLabel,
            action,
          }] : [];
        }),
      };
    }),
});
