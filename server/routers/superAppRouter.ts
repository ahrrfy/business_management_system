import {
  PERMISSION_MODULES,
  ROLE_TEMPLATES,
  ROLES,
  resolvePermissions,
  type AccessLevel,
  type RoleKey,
} from "@shared/permissions";
import { LEAVE_TYPES } from "@shared/hr";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  attendance,
  branches,
  branchStock,
  channelIntegrations,
  commissionPlans,
  commissionRuns,
  consignmentNotes,
  conversations,
  customers,
  deliveryConsignments,
  deliveryParties,
  digitalWallets,
  employees,
  expenses,
  fixedAssets,
  giftCampaigns,
  giftVouchers,
  invoices,
  leaveRequests,
  onlineOrders,
  payrollItems,
  payrollRuns,
  products,
  productVariants,
  purchaseOrders,
  receipts,
  reservations,
  shifts,
  suppliers,
  tasks,
  users,
  workOrders,
  crmCampaigns,
  promotions,
} from "../../drizzle/schema";
import { logAudit } from "../services/auditService";
import {
  createAppNotification,
  getNotificationPreferences,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationPreferences,
} from "../services/appNotificationService";
import { createLeave, withdrawPendingLeave } from "../services/leaveService";
import { listStockAdjustmentRequests } from "../services/inventory/adjustmentApproval";
import { requireDb } from "../services/tx";
import {
  canSeeCostForUser,
  canViewReports,
  router,
  selfServiceProcedure,
  superAppProcedure,
} from "../trpc";
import { detectAll as detectCatalogAnomalies } from "../services/catalogAnomalies/detectors";
import { getTodayNetSales } from "../services/reports/todaySales";
import { getAPAging } from "../services/reports/apAging";

const leaveTypeKeys = LEAVE_TYPES.map((item) => item.key) as [
  string,
  ...string[],
];
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح");
const quietTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "الوقت يجب أن يكون HH:mm")
  .nullable();

/** نفس سلامة طلب المصروف التي تتطلبها خدمة الاعتماد؛ لا نعرض قراراً سيفشل حتماً عند تنفيذه. */
function actionableExpenseApprovalWhere(ownerUserId: number) {
  return and(
    eq(expenses.status, "PENDING_APPROVAL"),
    eq(expenses.source, "CASH"),
    eq(receipts.direction, "OUT"),
    eq(receipts.status, "PENDING"),
    eq(receipts.approvalStatus, "PENDING_APPROVAL"),
    isNull(expenses.shiftId),
    isNull(expenses.cashBucket),
    isNull(receipts.shiftId),
    isNull(receipts.cashBucket),
    isNull(receipts.invoiceId),
    isNull(receipts.workOrderId),
    isNull(receipts.reservationId),
    isNull(receipts.voucherNumber),
    sql`${expenses.createdBy} IS NOT NULL`,
    ne(expenses.createdBy, ownerUserId),
    sql`${receipts.branchId} <=> ${expenses.branchId}`,
    sql`${receipts.amount} <=> ${expenses.amount}`,
    sql`${receipts.paymentMethod} <=> ${expenses.paymentMethod}`,
    sql`${receipts.createdBy} <=> ${expenses.createdBy}`,
  );
}

function isVisible(level: AccessLevel | undefined): boolean {
  return level === "FULL" || level === "READ";
}

type SuperAppAuthorityUser = {
  role: string;
  isOwner?: boolean;
  branchId?: number | null;
  permissionsOverride?: unknown;
  roleLockedByInactiveCustomRole?: boolean;
};

/** Single authority contract shared by bootstrap and mobile operational pulses. */
export function resolveSuperAppAuthority(user: SuperAppAuthorityUser) {
  const ownerOrAdmin = user.isOwner === true || user.role === "admin";
  const role = (ownerOrAdmin ? "admin" : user.role) as RoleKey;
  // Server gates intentionally give admin unconditional module access. The mobile
  // contract must not hide a module that the same session can open server-side.
  // `isOwner` is the persisted authority invariant: a stale/custom base role
  // must never turn the company owner into a branch-scoped pseudo-manager.
  const permissions = ownerOrAdmin
    ? { ...ROLE_TEMPLATES.admin }
    : resolvePermissions(
        role,
        (user.permissionsOverride ?? null) as Record<
          string,
          AccessLevel
        > | null,
      );
  const allBranches = ownerOrAdmin;
  const requestedBranchId =
    user.branchId == null ? null : Number(user.branchId);
  const branchId =
    requestedBranchId != null &&
    Number.isInteger(requestedBranchId) &&
    requestedBranchId > 0
      ? requestedBranchId
      : null;
  return {
    role,
    permissions,
    scope: {
      branchId,
      allBranches,
      // A manager is a branch manager. Missing assignment is an explicit empty
      // scope, never an implicit company-wide scope.
      effectiveBranchId: allBranches ? null : (branchId ?? -1),
    },
    capabilities: {
      isOwner: user.isOwner === true,
      canSeeCost: ownerOrAdmin || canSeeCostForUser(user),
      canViewReports: ownerOrAdmin || canViewReports(user),
      isExecutive: ownerOrAdmin || role === "manager",
      roleDegraded: user.roleLockedByInactiveCustomRole === true,
    },
  };
}

function baghdadDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

/** Branch-safe customer summary. Party master balances are company-wide, so a
 * branch view derives receivables from that branch's invoices instead. */
export async function getScopedCustomerPulse(scopedBranchId: number | null) {
  const db = requireDb();
  if (scopedBranchId == null) {
    const [row] = await db
      .select({
        count: sql<number>`count(*)`,
        balance: sql<string>`coalesce(sum(case when ${customers.currentBalance} > 0 then ${customers.currentBalance} else 0 end), 0)`,
      })
      .from(customers)
      .where(eq(customers.isActive, true));
    return {
      count: Number(row?.count ?? 0),
      balance: String(row?.balance ?? "0"),
    };
  }

  const [customerRow, balanceRow] = await Promise.all([
    db
      .select({ count: sql<number>`count(distinct ${customers.id})` })
      .from(customers)
      .innerJoin(invoices, eq(invoices.customerId, customers.id))
      .where(
        and(
          eq(customers.isActive, true),
          eq(invoices.branchId, scopedBranchId),
        ),
      )
      .then((rows) => rows[0]),
    db
      .select({
        balance: sql<string>`coalesce(sum(greatest(${invoices.total} - ${invoices.paidAmount} - ${invoices.returnedTotal}, 0)), 0)`,
      })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .where(
        and(
          eq(customers.isActive, true),
          eq(invoices.branchId, scopedBranchId),
          inArray(invoices.status, ["PENDING", "PARTIALLY_PAID"]),
        ),
      )
      .then((rows) => rows[0]),
  ]);
  return {
    count: Number(customerRow?.count ?? 0),
    balance: String(balanceRow?.balance ?? "0"),
  };
}

/** Branch-safe supplier summary. Global supplier balances cannot be allocated
 * to a branch, so branch AP is derived from the canonical AP-aging ledger. */
export async function getScopedSupplierPulse(scopedBranchId: number | null) {
  const db = requireDb();
  const countPromise =
    scopedBranchId == null
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(suppliers)
          .where(eq(suppliers.isActive, true))
          .then((rows) => rows[0])
      : db
          .select({ count: sql<number>`count(distinct ${suppliers.id})` })
          .from(suppliers)
          .innerJoin(
            purchaseOrders,
            eq(purchaseOrders.supplierId, suppliers.id),
          )
          .where(
            and(
              eq(suppliers.isActive, true),
              eq(purchaseOrders.branchId, scopedBranchId),
            ),
          )
          .then((rows) => rows[0]);
  const [countRow, agingRows] = await Promise.all([
    countPromise,
    getAPAging({ branchId: scopedBranchId ?? undefined, limit: 10_000 }),
  ]);
  const balance = agingRows.reduce((sum, row) => {
    const value = scopedBranchId == null ? row.currentBalance : row.unpaidTotal;
    const numeric = Number(value ?? 0);
    return sum + (numeric > 0 ? numeric : 0);
  }, 0);
  return { count: Number(countRow?.count ?? 0), balance: String(balance) };
}

/**
 * Mobile BFF contract. It composes an allowed workspace for the current
 * session; domain routers remain the authority for all business mutations.
 */
export const superAppRouter = router({
  bootstrap: superAppProcedure.query(async ({ ctx }) => {
    const authority = resolveSuperAppAuthority(ctx.user);
    const { role, permissions } = authority;
    const roleInfo = ROLES.find((item) => item.key === role);
    const db = requireDb();
    const [employeeLink] = await db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.userId, ctx.user.id))
      .limit(1);

    return {
      user: {
        id: ctx.user.id,
        name: ctx.user.name ?? "",
        role,
        roleLabel: ctx.user.customRoleLabel ?? roleInfo?.label ?? role,
        branchId: ctx.user.branchId ?? null,
        isOwner: ctx.user.isOwner === true,
      },
      scope: {
        branchId: authority.scope.branchId,
        allBranches: authority.scope.allBranches,
      },
      modules: PERMISSION_MODULES.filter((module) =>
        isVisible(permissions[module.key]),
      ).map((module) => ({
        key: module.key,
        label: module.label,
        access: permissions[module.key] as AccessLevel,
      })),
      capabilities: {
        ...authority.capabilities,
        hasPersonalWorkspace: Boolean(employeeLink),
        supportsNotifications: true,
      },
      generatedAt: new Date().toISOString(),
    };
  }),

  /**
   * Small, role-scoped operational pulses for mobile module entry screens.
   * Values are deliberately computed from source tables; unsupported modules
   * return an empty metric list rather than fabricated dashboard data.
   */
  modulePulse: superAppProcedure
    .input(z.object({ moduleKey: z.string().min(1).max(60) }))
    .query(async ({ ctx, input }) => {
      const authority = resolveSuperAppAuthority(ctx.user);
      const { role, permissions } = authority;
      const knownModule = PERMISSION_MODULES.some(
        (item) => item.key === input.moduleKey,
      );
      if (!knownModule || !isVisible(permissions[input.moduleKey])) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "الوحدة غير متاحة لهذا الحساب",
        });
      }

      const db = requireDb();
      const scopedBranchId = authority.scope.effectiveBranchId;
      const today = baghdadDate();
      const todayStart = new Date(`${today}T00:00:00+03:00`);
      const tomorrowStart = new Date(
        todayStart.getTime() + 24 * 60 * 60 * 1000,
      );
      type Metric = {
        key: string;
        label: string;
        value: number;
        format: "count" | "money";
        href: string;
      };
      const metric = (
        key: string,
        label: string,
        value: unknown,
        format: Metric["format"],
        href: string,
      ): Metric => ({ key, label, value: Number(value ?? 0), format, href });

      if (input.moduleKey === "campaigns") {
        const [campaignRow, promotionRow] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)` })
            .from(crmCampaigns)
            .where(
              and(
                inArray(crmCampaigns.status, [
                  "DRAFT",
                  "REVIEW",
                  "APPROVED",
                  "SCHEDULED",
                  "ACTIVE",
                  "PAUSED",
                ]),
                scopedBranchId == null
                  ? undefined
                  : or(
                      isNull(crmCampaigns.branchId),
                      eq(crmCampaigns.branchId, scopedBranchId),
                    ),
              ),
            )
            .then((rows) => rows[0]),
          db
            .select({ count: sql<number>`count(*)` })
            .from(promotions)
            .where(
              and(
                eq(promotions.isActive, true),
                scopedBranchId == null
                  ? undefined
                  : or(
                      isNull(promotions.branchId),
                      eq(promotions.branchId, scopedBranchId),
                    ),
              ),
            )
            .then((rows) => rows[0]),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "campaigns",
              "حملات جارية",
              campaignRow?.count,
              "count",
              "/crm?tab=campaigns",
            ),
            metric(
              "offers",
              "عروض فعالة",
              promotionRow?.count,
              "count",
              "/offers",
            ),
          ],
        };
      }

      if (input.moduleKey === "channels") {
        const [row] = await db
          .select({
            open: sql<number>`count(*)`,
            unread: sql<number>`coalesce(sum(${conversations.unreadCount}), 0)`,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.status, "OPEN"),
              scopedBranchId == null
                ? undefined
                : eq(conversations.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric("open", "محادثات مفتوحة", row?.open, "count", "/inbox"),
            metric(
              "unread",
              "رسائل غير مقروءة",
              row?.unread,
              "count",
              "/inbox",
            ),
          ],
        };
      }

      if (input.moduleKey === "store") {
        const [row] = await db
          .select({
            open: sql<number>`count(*)`,
            value: sql<string>`coalesce(sum(${onlineOrders.total}), 0)`,
          })
          .from(onlineOrders)
          .where(
            and(
              inArray(onlineOrders.status, [
                "PENDING",
                "CONFIRMED",
                "PROCESSING",
                "SHIPPED",
              ]),
              scopedBranchId == null
                ? undefined
                : eq(onlineOrders.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "open-orders",
              "طلبات قيد التنفيذ",
              row?.open,
              "count",
              "/store-admin",
            ),
            metric(
              "open-value",
              "قيمة الطلبات",
              row?.value,
              "money",
              "/store-admin",
            ),
          ],
        };
      }

      if (input.moduleKey === "treasury") {
        const [shiftRow, approvalRow, expenseApprovalRow] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)` })
            .from(shifts)
            .where(
              and(
                eq(shifts.status, "OPEN"),
                scopedBranchId == null
                  ? undefined
                  : eq(shifts.branchId, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
          db
            .select({ count: sql<number>`count(*)` })
            .from(receipts)
            .where(
              and(
                eq(receipts.approvalStatus, "PENDING_APPROVAL"),
                notExists(
                  db
                    .select({ id: expenses.id })
                    .from(expenses)
                    .where(eq(expenses.receiptId, receipts.id)),
                ),
                scopedBranchId == null
                  ? undefined
                  : eq(receipts.branchId, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
          authority.capabilities.isOwner
            ? db
                .select({ count: sql<number>`count(*)` })
                .from(expenses)
                .innerJoin(receipts, eq(expenses.receiptId, receipts.id))
                .where(actionableExpenseApprovalWhere(ctx.user.id))
                .then((rows) => rows[0])
            : Promise.resolve({ count: 0 }),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "open-shifts",
              "ورديات مفتوحة",
              shiftRow?.count,
              "count",
              "/shifts",
            ),
            metric(
              "approvals",
              "سندات للاعتماد",
              approvalRow?.count,
              "count",
              "/vouchers",
            ),
            ...(authority.capabilities.isOwner
              ? [
                  metric(
                    "expense-approvals",
                    "طلبات مصروف لاعتماد المالك",
                    expenseApprovalRow?.count,
                    "count",
                    "/treasury?tab=expenses&status=PENDING_APPROVAL",
                  ),
                ]
              : []),
          ],
        };
      }

      if (input.moduleKey === "sales") {
        const row = await getTodayNetSales(scopedBranchId ?? undefined);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "today-count",
              "فواتير اليوم",
              row.invoiceCount,
              "count",
              "/invoices",
            ),
            metric(
              "today-total",
              "مبيعات اليوم",
              row.total,
              "money",
              "/reports/sales-hub",
            ),
          ],
        };
      }

      if (input.moduleKey === "purchases") {
        const [row] = await db
          .select({
            count: sql<number>`count(*)`,
            total: sql<string>`coalesce(sum(${purchaseOrders.total} - ${purchaseOrders.paidAmount}), 0)`,
          })
          .from(purchaseOrders)
          .where(
            and(
              inArray(purchaseOrders.status, ["DRAFT", "SENT", "CONFIRMED"]),
              scopedBranchId == null
                ? undefined
                : eq(purchaseOrders.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "open-orders",
              "أوامر مفتوحة",
              row?.count,
              "count",
              "/purchases",
            ),
            metric(
              "outstanding",
              "غير مسدد",
              row?.total,
              "money",
              "/purchases",
            ),
          ],
        };
      }

      if (input.moduleKey === "inventory") {
        const [row] = await db
          .select({
            positions: sql<number>`count(*)`,
            attention: sql<number>`coalesce(sum(case when ${branchStock.quantity} <= 0 then 1 else 0 end), 0)`,
          })
          .from(branchStock)
          .where(
            scopedBranchId == null
              ? undefined
              : eq(branchStock.branchId, scopedBranchId),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "positions",
              "أرصدة مسجلة",
              row?.positions,
              "count",
              "/inventory",
            ),
            metric(
              "attention",
              "تحتاج متابعة",
              row?.attention,
              "count",
              "/inventory",
            ),
          ],
        };
      }

      if (input.moduleKey === "crm" || input.moduleKey === "collections") {
        const row = await getScopedCustomerPulse(scopedBranchId);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "active-customers",
              "عملاء نشطون",
              row.count,
              "count",
              "/customers",
            ),
            metric(
              "receivables",
              "ذمم مدينة",
              row.balance,
              "money",
              "/ar-aging",
            ),
          ],
        };
      }

      if (input.moduleKey === "tasks") {
        const [row] = await db
          .select({
            open: sql<number>`count(*)`,
            urgent: sql<number>`coalesce(sum(case when ${tasks.priority} in ('HIGH','URGENT') then 1 else 0 end), 0)`,
          })
          .from(tasks)
          .where(
            and(
              inArray(tasks.taskStatus, [
                "NEW",
                "IN_PROGRESS",
                "WAITING_CUSTOMER",
              ]),
              scopedBranchId == null
                ? undefined
                : eq(tasks.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric("open", "مهام مفتوحة", row?.open, "count", "/tasks"),
            metric("urgent", "عالية الأولوية", row?.urgent, "count", "/tasks"),
          ],
        };
      }

      if (input.moduleKey === "workorders" || input.moduleKey === "pos") {
        const [row] = await db
          .select({
            open: sql<number>`count(*)`,
            ready: sql<number>`coalesce(sum(case when ${workOrders.status} = 'READY' then 1 else 0 end), 0)`,
          })
          .from(workOrders)
          .where(
            and(
              inArray(workOrders.status, ["RECEIVED", "IN_PROGRESS", "READY"]),
              scopedBranchId == null
                ? undefined
                : eq(workOrders.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric("open", "قيد التنفيذ", row?.open, "count", "/work-orders"),
            metric(
              "ready",
              "جاهزة للتسليم",
              row?.ready,
              "count",
              "/work-orders",
            ),
          ],
        };
      }

      if (input.moduleKey === "expenses") {
        const [row] = await db
          .select({
            count: sql<number>`count(*)`,
            total: sql<string>`coalesce(sum(${expenses.amount}), 0)`,
          })
          .from(expenses)
          .where(
            and(
              eq(expenses.expenseDate, todayStart),
              eq(expenses.status, "ACTIVE"),
              scopedBranchId == null
                ? undefined
                : eq(expenses.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "today-count",
              "مصروفات اليوم",
              row?.count,
              "count",
              "/expenses",
            ),
            metric(
              "today-total",
              "إجمالي اليوم",
              row?.total,
              "money",
              "/expenses",
            ),
          ],
        };
      }

      if (input.moduleKey === "products") {
        const [productRow, variantRow] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(eq(products.isActive, true))
            .then((rows) => rows[0]),
          db
            .select({ count: sql<number>`count(*)` })
            .from(productVariants)
            .where(eq(productVariants.isActive, true))
            .then((rows) => rows[0]),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "active-products",
              "منتجات نشطة",
              productRow?.count,
              "count",
              "/products",
            ),
            metric(
              "active-variants",
              "متغيرات فعالة",
              variantRow?.count,
              "count",
              "/products",
            ),
          ],
        };
      }

      if (input.moduleKey === "suppliers") {
        const row = await getScopedSupplierPulse(scopedBranchId);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "active-suppliers",
              "موردون نشطون",
              row.count,
              "count",
              "/suppliers",
            ),
            metric(
              "payables",
              "ذمم الموردين",
              row.balance,
              "money",
              "/ap-aging",
            ),
          ],
        };
      }

      if (input.moduleKey === "hr") {
        const [employeeRow, leaveRow] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)` })
            .from(employees)
            .where(
              and(
                eq(employees.isActive, true),
                eq(employees.employmentStatus, "active"),
                scopedBranchId == null
                  ? undefined
                  : eq(employees.branchId, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
          db
            .select({ count: sql<number>`count(*)` })
            .from(leaveRequests)
            .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
            .where(
              and(
                eq(leaveRequests.status, "pending"),
                scopedBranchId == null
                  ? undefined
                  : eq(employees.branchId, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "active-employees",
              "موظفون نشطون",
              employeeRow?.count,
              "count",
              "/hr/employees",
            ),
            metric(
              "pending-leaves",
              "إجازات للمراجعة",
              leaveRow?.count,
              "count",
              "/hr/leaves",
            ),
          ],
        };
      }

      if (input.moduleKey === "reports") {
        const [saleRow, expenseRow] = await Promise.all([
          getTodayNetSales(scopedBranchId ?? undefined),
          db
            .select({
              total: sql<string>`coalesce(sum(${expenses.amount}), 0)`,
            })
            .from(expenses)
            .where(
              and(
                eq(expenses.expenseDate, todayStart),
                eq(expenses.status, "ACTIVE"),
                scopedBranchId == null
                  ? undefined
                  : eq(expenses.branchId, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "sales",
              "مبيعات اليوم",
              saleRow.total,
              "money",
              "/reports/sales-hub",
            ),
            metric(
              "expenses",
              "مصروفات اليوم",
              expenseRow?.total,
              "money",
              "/reports/expenses",
            ),
          ],
        };
      }

      if (input.moduleKey === "assets") {
        const [row] = await db
          .select({
            active: sql<number>`coalesce(sum(case when ${fixedAssets.status} = 'active' then 1 else 0 end), 0)`,
            maintenance: sql<number>`coalesce(sum(case when ${fixedAssets.status} = 'maintenance' then 1 else 0 end), 0)`,
          })
          .from(fixedAssets)
          .where(
            and(
              eq(fixedAssets.isActive, true),
              scopedBranchId == null
                ? undefined
                : eq(fixedAssets.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "active",
              "أصول بالخدمة",
              row?.active,
              "count",
              "/assets/register",
            ),
            metric(
              "maintenance",
              "في الصيانة",
              row?.maintenance,
              "count",
              "/assets/register",
            ),
          ],
        };
      }

      if (input.moduleKey === "commissions") {
        const [planRow, runRow] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)` })
            .from(commissionPlans)
            .where(eq(commissionPlans.isActive, true))
            .then((rows) => rows[0]),
          db
            .select({ count: sql<number>`count(*)` })
            .from(commissionRuns)
            .where(eq(commissionRuns.status, "draft"))
            .then((rows) => rows[0]),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "plans",
              "خطط فعالة",
              planRow?.count,
              "count",
              "/hr?tab=commissions",
            ),
            metric(
              "runs",
              "تشغيلات للمراجعة",
              runRow?.count,
              "count",
              "/hr?tab=commission-runs",
            ),
          ],
        };
      }

      if (input.moduleKey === "consignments") {
        const [row] = await db
          .select({
            today: sql<number>`coalesce(sum(case when ${consignmentNotes.createdAt} >= ${todayStart} then 1 else 0 end), 0)`,
            consignors: sql<number>`count(distinct ${consignmentNotes.consignorId})`,
          })
          .from(consignmentNotes)
          .where(
            scopedBranchId == null
              ? undefined
              : eq(consignmentNotes.branchId, scopedBranchId),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "today",
              "سندات اليوم",
              row?.today,
              "count",
              "/inventory?tab=consignments",
            ),
            metric(
              "consignors",
              "مودعون نشطون",
              row?.consignors,
              "count",
              "/suppliers",
            ),
          ],
        };
      }

      if (input.moduleKey === "reservations") {
        const [row] = await db
          .select({
            active: sql<number>`count(*)`,
            expiring: sql<number>`coalesce(sum(case when ${reservations.expiresAt} <= ${tomorrowStart} then 1 else 0 end), 0)`,
          })
          .from(reservations)
          .where(
            and(
              inArray(reservations.status, ["ACTIVE", "PARTIALLY_FULFILLED"]),
              scopedBranchId == null
                ? undefined
                : eq(reservations.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "active",
              "حجوزات فعالة",
              row?.active,
              "count",
              "/reservations",
            ),
            metric(
              "expiring",
              "تنتهي قريباً",
              row?.expiring,
              "count",
              "/reservations",
            ),
          ],
        };
      }

      if (input.moduleKey === "digital_cards") {
        const [row] = await db
          .select({
            wallets: sql<number>`count(*)`,
            balance: sql<string>`coalesce(sum(${digitalWallets.currentBalance} - ${digitalWallets.reservedBalance}), 0)`,
          })
          .from(digitalWallets)
          .where(
            and(
              eq(digitalWallets.isActive, true),
              scopedBranchId == null
                ? undefined
                : eq(digitalWallets.branchId, scopedBranchId),
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "wallets",
              "محافظ فعالة",
              row?.wallets,
              "count",
              "/digital-cards?tab=wallets",
            ),
            metric(
              "balance",
              "الرصيد المتاح",
              row?.balance,
              "money",
              "/digital-cards",
            ),
          ],
        };
      }

      if (input.moduleKey === "gifts") {
        const [voucherRow, campaignRow] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)` })
            .from(giftVouchers)
            .where(
              and(
                eq(giftVouchers.status, "PENDING_APPROVAL"),
                scopedBranchId == null
                  ? undefined
                  : eq(giftVouchers.branchId, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
          db
            .select({ count: sql<number>`count(*)` })
            .from(giftCampaigns)
            .where(eq(giftCampaigns.status, "ACTIVE"))
            .then((rows) => rows[0]),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "approvals",
              "بانتظار الاعتماد",
              voucherRow?.count,
              "count",
              "/gifts?tab=approvals",
            ),
            metric(
              "campaigns",
              "حملات فعالة",
              campaignRow?.count,
              "count",
              "/gifts?tab=report",
            ),
          ],
        };
      }

      if (input.moduleKey === "catalogAnomalies") {
        const findings = await detectCatalogAnomalies(db, 80);
        const blocker = findings.filter(
          (item) => item.severity === "blocker",
        ).length;
        const warning = findings.filter(
          (item) => item.severity === "warning",
        ).length;
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "blocker",
              "تدقيق عاجل",
              blocker,
              "count",
              "/reports/catalog-anomalies",
            ),
            metric(
              "warning",
              "تحتاج مراجعة",
              warning,
              "count",
              "/reports/catalog-anomalies",
            ),
          ],
        };
      }

      if (input.moduleKey === "courier") {
        const courierOnly =
          role === "courier"
            ? eq(deliveryParties.userId, ctx.user.id)
            : undefined;
        const [row] = await db
          .select({
            open: sql<number>`count(*)`,
            custody: sql<string>`coalesce(sum(${deliveryConsignments.codAmount} - ${deliveryConsignments.collectedAmount}), 0)`,
          })
          .from(deliveryConsignments)
          .innerJoin(
            deliveryParties,
            eq(deliveryParties.id, deliveryConsignments.partyId),
          )
          .where(
            and(
              inArray(deliveryConsignments.status, [
                "DISPATCHED",
                "DELIVERED",
                "PARTIAL",
              ]),
              scopedBranchId == null
                ? undefined
                : eq(deliveryConsignments.branchId, scopedBranchId),
              courierOnly,
            ),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "open",
              "طلبات بعهدتي",
              row?.open,
              "count",
              "/my-deliveries",
            ),
            metric(
              "custody",
              "تحصيل مطلوب",
              row?.custody,
              "money",
              "/my-deliveries?tab=custody",
            ),
          ],
        };
      }

      if (input.moduleKey === "users") {
        const now = new Date();
        const [row] = await db
          .select({
            active: sql<number>`coalesce(sum(case when ${users.isActive} = true then 1 else 0 end), 0)`,
            locked: sql<number>`coalesce(sum(case when ${users.lockedUntil} >= ${now} then 1 else 0 end), 0)`,
          })
          .from(users)
          .where(
            scopedBranchId == null
              ? undefined
              : eq(users.branchId, scopedBranchId),
          );
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric("active", "حسابات فعالة", row?.active, "count", "/users"),
            metric("locked", "حسابات مقفلة", row?.locked, "count", "/users"),
          ],
        };
      }

      if (input.moduleKey === "settings") {
        const [branchRow, integrationRow] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)` })
            .from(branches)
            .where(
              and(
                eq(branches.isActive, true),
                scopedBranchId == null
                  ? undefined
                  : eq(branches.id, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
          db
            .select({ count: sql<number>`count(*)` })
            .from(channelIntegrations)
            .where(
              and(
                eq(channelIntegrations.status, "FAILED"),
                scopedBranchId == null
                  ? undefined
                  : eq(channelIntegrations.branchId, scopedBranchId),
              ),
            )
            .then((rows) => rows[0]),
        ]);
        return {
          moduleKey: input.moduleKey,
          metrics: [
            metric(
              "branches",
              "فروع فعالة",
              branchRow?.count,
              "count",
              "/settings?tab=branches",
            ),
            metric(
              "integrations",
              "تكاملات متعثرة",
              integrationRow?.count,
              "count",
              "/settings/integrations",
            ),
          ],
        };
      }

      return { moduleKey: input.moduleKey, metrics: [] as Metric[] };
    }),

  /**
   * Personal workspace data is selected from the signed-in user's own
   * employee relation, not the HR dashboard. No salary or peer data leaks
   * through the mobile home screen.
   */
  myWorkspace: selfServiceProcedure.query(async ({ ctx }) => {
    const db = requireDb();
    const [employee] = await db
      .select({
        id: employees.id,
        firstName: employees.firstName,
        lastName: employees.lastName,
        position: employees.position,
        department: employees.department,
        branchId: employees.branchId,
        photoUrl: employees.photoUrl,
        employmentStatus: employees.employmentStatus,
        email: employees.email,
        phone: employees.phone,
        hireDate: employees.hireDate,
        payType: employees.payType,
        salary: employees.salary,
        allowances: employees.allowances,
        annualLeaveBalance: employees.annualLeaveBalance,
        sickLeaveBalance: employees.sickLeaveBalance,
      })
      .from(employees)
      .where(eq(employees.userId, ctx.user.id))
      .limit(1);

    const activeTasks = await db
      .select({
        id: tasks.id,
        taskNumber: tasks.taskNumber,
        title: tasks.title,
        priority: tasks.priority,
        status: tasks.taskStatus,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedTo, ctx.user.id),
          inArray(tasks.taskStatus, ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"]),
        ),
      )
      .orderBy(asc(tasks.dueAt), asc(tasks.createdAt))
      .limit(12);

    const today = baghdadDate();
    const [todayAttendance] = employee
      ? await db
          .select({
            date: attendance.attendanceDate,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            status: attendance.status,
            hours: attendance.hours,
            source: attendance.source,
            needsReview: attendance.needsReview,
          })
          .from(attendance)
          .where(
            and(
              eq(attendance.employeeId, employee.id),
              eq(attendance.attendanceDate, today),
            ),
          )
          .limit(1)
      : [];

    const attendanceHistory = employee
      ? await db
          .select({
            id: attendance.id,
            date: attendance.attendanceDate,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            status: attendance.status,
            hours: attendance.hours,
            source: attendance.source,
            needsReview: attendance.needsReview,
          })
          .from(attendance)
          .where(eq(attendance.employeeId, employee.id))
          .orderBy(desc(attendance.attendanceDate))
          .limit(14)
      : [];

    const recentLeaves = employee
      ? await db
          .select({
            id: leaveRequests.id,
            leaveType: leaveRequests.leaveType,
            fromDate: leaveRequests.fromDate,
            toDate: leaveRequests.toDate,
            days: leaveRequests.days,
            status: leaveRequests.status,
            reason: leaveRequests.reason,
            requestedAt: leaveRequests.requestedAt,
            decidedAt: leaveRequests.decidedAt,
          })
          .from(leaveRequests)
          .where(eq(leaveRequests.employeeId, employee.id))
          .orderBy(desc(leaveRequests.requestedAt), desc(leaveRequests.id))
          .limit(20)
      : [];

    const [latestPayroll] = employee
      ? await db
          .select({
            itemId: payrollItems.id,
            runId: payrollRuns.id,
            period: payrollRuns.period,
            status: payrollRuns.status,
            paidAt: payrollRuns.paidAt,
            gross: payrollItems.gross,
            allowances: payrollItems.allowances,
            overtime: payrollItems.overtime,
            commission: payrollItems.commission,
            deductions: payrollItems.deductions,
            net: payrollItems.net,
          })
          .from(payrollItems)
          .innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
          .where(
            and(
              eq(payrollItems.employeeId, employee.id),
              inArray(payrollRuns.status, ["approved", "paid"]),
            ),
          )
          .orderBy(desc(payrollRuns.period), desc(payrollRuns.id))
          .limit(1)
      : [];

    const notifications = [
      ...activeTasks.slice(0, 5).map((task) => ({
        id: `task-${task.id}`,
        kind: "TASK" as const,
        title: task.title,
        body: `${task.taskNumber} · ${task.priority}`,
        createdAt: task.dueAt ?? new Date(),
        route: "/mobile#tasks",
        requiresAction: task.priority === "HIGH" || task.priority === "URGENT",
      })),
      ...(todayAttendance?.checkIn
        ? [
            {
              id: `attendance-${today}`,
              kind: "ATTENDANCE" as const,
              title: todayAttendance.checkOut
                ? "اكتمل سجل دوام اليوم"
                : "تم تسجيل الدخول",
              body: todayAttendance.checkOut
                ? "تمت مزامنة وقتَي الدخول والخروج من جهاز الشركة"
                : "تمت مزامنة بصمة الدخول من جهاز الشركة",
              createdAt: todayAttendance.checkOut ?? todayAttendance.checkIn,
              route: "/mobile#attendance",
              requiresAction: Boolean(todayAttendance.needsReview),
            },
          ]
        : []),
      ...(latestPayroll
        ? [
            {
              id: `payroll-${latestPayroll.runId}`,
              kind: "PAYROLL" as const,
              title:
                latestPayroll.status === "paid"
                  ? "تم صرف الراتب"
                  : "كشف الراتب جاهز",
              body: `الفترة ${latestPayroll.period}`,
              createdAt:
                latestPayroll.paidAt ??
                new Date(`${latestPayroll.period}-01T00:00:00Z`),
              route: "/mobile#payroll",
              requiresAction: false,
            },
          ]
        : []),
    ]
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      )
      .slice(0, 8);

    return {
      date: today,
      employee: employee
        ? {
            id: employee.id,
            name: `${employee.firstName} ${employee.lastName}`.trim(),
            position: employee.position,
            department: employee.department,
            branchId: employee.branchId,
            photoUrl: employee.photoUrl,
            employmentStatus: employee.employmentStatus,
            email: employee.email,
            phone: employee.phone,
            hireDate: employee.hireDate,
            payType: employee.payType,
            baseSalary: employee.salary,
            allowances: employee.allowances,
            annualLeaveBalance: employee.annualLeaveBalance,
            sickLeaveBalance: employee.sickLeaveBalance,
          }
        : null,
      attendance: todayAttendance
        ? {
            ...todayAttendance,
            // Attendance is written exclusively by physical-device integration
            // or permitted HR administration, never from this mobile surface.
            readOnly: true,
          }
        : null,
      tasks: activeTasks,
      attendanceHistory,
      leaveRequests: recentLeaves,
      latestPayroll: latestPayroll ?? null,
      notifications,
    };
  }),

  /**
   * Personal payroll history is always resolved through the employee linked to
   * the authenticated session. There is deliberately no employeeId input.
   */
  payrollHistory: selfServiceProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(36).default(24) })
        .strict()
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = requireDb();
      return db
        .select({
          itemId: payrollItems.id,
          runId: payrollRuns.id,
          period: payrollRuns.period,
          status: payrollRuns.status,
          paidAt: payrollRuns.paidAt,
          gross: payrollItems.gross,
          deductions: payrollItems.deductions,
          net: payrollItems.net,
        })
        .from(payrollItems)
        .innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
        .innerJoin(employees, eq(payrollItems.employeeId, employees.id))
        .where(
          and(
            eq(employees.userId, ctx.user.id),
            inArray(payrollRuns.status, ["approved", "paid"]),
          ),
        )
        .orderBy(desc(payrollRuns.period), desc(payrollItems.id))
        .limit(input?.limit ?? 24);
    }),

  /**
   * A payslip is a structured, read-only detail view. Ownership is enforced
   * in the SQL predicate, so knowing another payroll item id never grants
   * access and no synthetic PDF/document is advertised.
   */
  payslipDetail: selfServiceProcedure
    .input(z.object({ payrollItemId: z.number().int().positive() }).strict())
    .query(async ({ ctx, input }) => {
      const db = requireDb();
      const [row] = await db
        .select({
          itemId: payrollItems.id,
          runId: payrollRuns.id,
          period: payrollRuns.period,
          status: payrollRuns.status,
          paidAt: payrollRuns.paidAt,
          payType: payrollItems.payType,
          hours: payrollItems.hours,
          gross: payrollItems.gross,
          allowances: payrollItems.allowances,
          overtime: payrollItems.overtime,
          commission: payrollItems.commission,
          deductions: payrollItems.deductions,
          advanceDeduction: payrollItems.advanceDeduction,
          socialSecurityEmployee: payrollItems.socialSecurityEmployee,
          incomeTax: payrollItems.incomeTax,
          net: payrollItems.net,
          note: payrollItems.note,
          createdAt: payrollItems.createdAt,
        })
        .from(payrollItems)
        .innerJoin(payrollRuns, eq(payrollItems.runId, payrollRuns.id))
        .innerJoin(employees, eq(payrollItems.employeeId, employees.id))
        .where(
          and(
            eq(payrollItems.id, input.payrollItemId),
            eq(employees.userId, ctx.user.id),
            inArray(payrollRuns.status, ["approved", "paid"]),
          ),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "قسيمة الراتب غير متاحة لهذا الحساب",
        });
      }
      return row;
    }),

  notifications: selfServiceProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(100).default(40) })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listUserNotifications(ctx.user.id, input?.limit ?? 40),
    ),

  /** مركز قرارات موحّد: يجمّع الأعمال المعلّقة من سلطاتها الأصلية من دون نسخ منطق القرار.
   *  كل مسار يبقى محكوماً بصلاحية الوحدة، نطاق الفرع، وفصل المهام في خدمة المجال نفسها. */
  approvalInbox: superAppProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(30),
          offset: z.number().int().min(0).max(450).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 30;
      const offset = input?.offset ?? 0;
      // Top N of a merged, time-sorted stream must be present in the top N of every source.
      // Capping offset + limit at 500 matches the inventory service's audited list ceiling.
      const sourceLimit = Math.min(offset + limit, 500);
      const db = requireDb();
      const role = ctx.user.role as RoleKey;
      const permissions = resolveSuperAppAuthority(ctx.user).permissions;
      if (role !== "admin" && ctx.user.branchId == null) return [];
      const branchId = role === "admin" ? null : Number(ctx.user.branchId);
      const canManage = role === "admin" || role === "manager";
      const canTreasuryApprove =
        role === "admin" || role === "manager" || role === "accountant";

      const [stockRows, leaveRows, voucherRows, expenseRows, giftRows] =
        await Promise.all([
          permissions.inventory === "FULL" && canManage
            ? listStockAdjustmentRequests({
                branchId,
                status: "PENDING_APPROVAL",
              })
            : Promise.resolve([]),
          permissions.hr === "FULL"
            ? db
                .select({
                  id: leaveRequests.id,
                  leaveType: leaveRequests.leaveType,
                  fromDate: leaveRequests.fromDate,
                  toDate: leaveRequests.toDate,
                  days: leaveRequests.days,
                  reason: leaveRequests.reason,
                  requestedAt: leaveRequests.requestedAt,
                  employeeUserId: employees.userId,
                  employeeBranchId: employees.branchId,
                  firstName: employees.firstName,
                  lastName: employees.lastName,
                })
                .from(leaveRequests)
                .innerJoin(
                  employees,
                  eq(leaveRequests.employeeId, employees.id),
                )
                .where(
                  and(
                    eq(leaveRequests.status, "pending"),
                    ...(branchId == null
                      ? []
                      : [eq(employees.branchId, branchId)]),
                  ),
                )
                .orderBy(desc(leaveRequests.requestedAt))
                .limit(sourceLimit)
            : Promise.resolve([]),
          permissions.treasury === "FULL" &&
          canTreasuryApprove &&
          (role === "admin" || ctx.user.branchId != null)
            ? db
                .select({
                  id: receipts.id,
                  voucherNumber: receipts.voucherNumber,
                  amount: receipts.amount,
                  direction: receipts.direction,
                  description: receipts.description,
                  createdBy: receipts.createdBy,
                  createdAt: receipts.createdAt,
                })
                .from(receipts)
                .where(
                  and(
                    eq(receipts.approvalStatus, "PENDING_APPROVAL"),
                    notExists(
                      db
                        .select({ id: expenses.id })
                        .from(expenses)
                        .where(eq(expenses.receiptId, receipts.id)),
                    ),
                    ...(branchId == null
                      ? []
                      : [eq(receipts.branchId, branchId)]),
                    isNull(receipts.invoiceId),
                  ),
                )
                .orderBy(desc(receipts.createdAt))
                .limit(sourceLimit)
            : Promise.resolve([]),
          ctx.user.isOwner === true
            ? db
                .select({
                  id: expenses.id,
                  category: expenses.category,
                  amount: expenses.amount,
                  paymentMethod: expenses.paymentMethod,
                  description: expenses.description,
                  payee: expenses.payee,
                  createdBy: expenses.createdBy,
                  createdAt: expenses.createdAt,
                })
                .from(expenses)
                .innerJoin(receipts, eq(expenses.receiptId, receipts.id))
                .where(actionableExpenseApprovalWhere(ctx.user.id))
                .orderBy(desc(expenses.createdAt))
                .limit(sourceLimit)
            : Promise.resolve([]),
          permissions.gifts === "FULL" && canManage
            ? db
                .select({
                  id: giftVouchers.id,
                  giftNumber: giftVouchers.giftNumber,
                  totalCost: giftVouchers.totalCost,
                  reason: giftVouchers.reason,
                  createdBy: giftVouchers.createdBy,
                  createdAt: giftVouchers.createdAt,
                })
                .from(giftVouchers)
                .where(
                  and(
                    eq(giftVouchers.status, "PENDING_APPROVAL"),
                    ...(branchId == null
                      ? []
                      : [eq(giftVouchers.branchId, branchId)]),
                  ),
                )
                .orderBy(desc(giftVouchers.createdAt))
                .limit(sourceLimit)
            : Promise.resolve([]),
        ]);

      return [
        ...stockRows
          .filter(
            (row) => role === "admin" || Number(row.createdBy) !== ctx.user.id,
          )
          .map((row) => ({
            kind: "inventory" as const,
            id: Number(row.id),
            title: row.productName || "تسوية مخزون",
            reference: row.sku || `طلب #${row.id}`,
            detail: row.notes || "تسوية رصيد مخزني",
            href: "/inventory",
            createdAt: row.createdAt,
            currentQuantity: Number(
              row.currentQuantity ?? row.expectedQuantity,
            ),
            targetQuantity: Number(row.targetQuantity),
            canReject: true,
            capabilities: {
              canApprove: true,
              canReject: true,
              rejectionReason: "required" as const,
              supportsClientRequestId: false,
              duplicatePolicy: "state_transition_guard" as const,
            },
          })),
        ...leaveRows
          .filter((row) => Number(row.employeeUserId) !== ctx.user.id)
          .map((row) => ({
            kind: "leave" as const,
            id: Number(row.id),
            title: `${row.firstName} ${row.lastName}`.trim(),
            reference: row.leaveType,
            detail: `${row.fromDate} — ${row.toDate} · ${row.days} يوم`,
            href: "/hr/leaves",
            createdAt: row.requestedAt,
            canReject: true,
            capabilities: {
              canApprove: true,
              canReject: true,
              rejectionReason: "not_supported" as const,
              supportsClientRequestId: false,
              duplicatePolicy: "state_transition_guard" as const,
            },
          })),
        ...voucherRows
          .filter(
            (row) => role === "admin" || Number(row.createdBy) !== ctx.user.id,
          )
          .map((row) => ({
            kind: "voucher" as const,
            id: Number(row.id),
            title: row.direction === "IN" ? "سند قبض" : "سند صرف",
            reference: row.voucherNumber || `سند #${row.id}`,
            detail: row.description || "سند مالي بانتظار الاعتماد",
            href: "/vouchers",
            createdAt: row.createdAt,
            amount: row.amount,
            canReject: true,
            capabilities: {
              canApprove: true,
              canReject: true,
              rejectionReason: "required" as const,
              supportsClientRequestId: false,
              duplicatePolicy: "state_transition_guard" as const,
            },
          })),
        ...expenseRows
          .filter((row) => Number(row.createdBy) !== ctx.user.id)
          .map((row) => ({
            kind: "expense" as const,
            id: Number(row.id),
            title: "طلب مصروف",
            reference: `EXP#${row.id}`,
            detail:
              [row.description, row.payee, row.category]
                .filter(Boolean)
                .join(" · ") || "طلب مصروف بانتظار اعتماد المالك",
            href: `/treasury?tab=expenses&focus=${row.id}`,
            createdAt: row.createdAt,
            amount: row.amount,
            paymentMethod: row.paymentMethod,
            canReject: true,
            capabilities: {
              canApprove: true,
              canReject: true,
              rejectionReason: "required" as const,
              supportsClientRequestId: false,
              duplicatePolicy: "state_transition_guard" as const,
            },
          })),
        ...giftRows
          .filter(
            (row) => role === "admin" || Number(row.createdBy) !== ctx.user.id,
          )
          .map((row) => ({
            kind: "gift" as const,
            id: Number(row.id),
            title: "هدية صادرة",
            reference: row.giftNumber,
            detail: row.reason || "هدية بانتظار الاعتماد",
            href: "/gifts?tab=approvals",
            createdAt: row.createdAt,
            amount: row.totalCost,
            canReject: false,
            capabilities: {
              canApprove: true,
              canReject: false,
              rejectionReason: "not_supported" as const,
              supportsClientRequestId: false,
              duplicatePolicy: "state_transition_guard" as const,
            },
          })),
      ]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(offset, offset + limit);
    }),

  /** Scoped native detail. A missing, foreign-branch, self-created, or unauthorized request is
   * deliberately indistinguishable (NOT_FOUND) so the endpoint cannot be used as an ID oracle. */
  approvalDetail: superAppProcedure
    .input(
      z.object({
        kind: z.enum(["inventory", "leave", "voucher", "expense", "gift"]),
        id: z.number().int().positive(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = requireDb();
      const role = ctx.user.role as RoleKey;
      const permissions = resolveSuperAppAuthority(ctx.user).permissions;
      const branchId =
        role === "admin"
          ? null
          : ctx.user.branchId == null
            ? -1
            : Number(ctx.user.branchId);
      const canManage = role === "admin" || role === "manager";
      const canTreasuryApprove =
        role === "admin" || role === "manager" || role === "accountant";
      const notFound = (): never => {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "طلب الاعتماد غير موجود أو غير متاح لهذا الحساب",
        });
      };

      if (input.kind === "inventory") {
        if (
          permissions.inventory !== "FULL" ||
          !canManage ||
          (role !== "admin" && (branchId ?? -1) < 0)
        )
          return notFound();
        const row = (
          await listStockAdjustmentRequests({
            branchId,
            status: "PENDING_APPROVAL",
          })
        ).find(
          (item) =>
            Number(item.id) === input.id &&
            (role === "admin" || Number(item.createdBy) !== ctx.user.id),
        );
        if (!row) return notFound();
        return {
          kind: "inventory" as const,
          id: Number(row.id),
          title: row.productName || "تسوية مخزون",
          reference: row.sku || `طلب #${row.id}`,
          detail: row.notes || "تسوية رصيد مخزني",
          createdAt: row.createdAt,
          currentQuantity: Number(row.currentQuantity ?? row.expectedQuantity),
          targetQuantity: Number(row.targetQuantity),
          canReject: true,
          capabilities: {
            canApprove: true,
            canReject: true,
            rejectionReason: "required" as const,
            supportsClientRequestId: false,
            duplicatePolicy: "state_transition_guard" as const,
          },
        };
      }

      if (input.kind === "leave") {
        if (
          permissions.hr !== "FULL" ||
          (role !== "admin" && (branchId ?? -1) < 0)
        )
          return notFound();
        const [row] = await db
          .select({
            id: leaveRequests.id,
            leaveType: leaveRequests.leaveType,
            fromDate: leaveRequests.fromDate,
            toDate: leaveRequests.toDate,
            days: leaveRequests.days,
            reason: leaveRequests.reason,
            requestedAt: leaveRequests.requestedAt,
            employeeUserId: employees.userId,
            firstName: employees.firstName,
            lastName: employees.lastName,
          })
          .from(leaveRequests)
          .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
          .where(
            and(
              eq(leaveRequests.id, input.id),
              eq(leaveRequests.status, "pending"),
              ...(branchId == null ? [] : [eq(employees.branchId, branchId)]),
            ),
          )
          .limit(1);
        if (!row || Number(row.employeeUserId) === ctx.user.id)
          return notFound();
        return {
          kind: "leave" as const,
          id: Number(row.id),
          title: `${row.firstName} ${row.lastName}`.trim(),
          reference: row.leaveType,
          detail: `${row.fromDate} — ${row.toDate} · ${row.days} يوم`,
          reason: row.reason ?? null,
          createdAt: row.requestedAt,
          canReject: true,
          capabilities: {
            canApprove: true,
            canReject: true,
            rejectionReason: "not_supported" as const,
            supportsClientRequestId: false,
            duplicatePolicy: "state_transition_guard" as const,
          },
        };
      }

      if (input.kind === "voucher") {
        if (
          permissions.treasury !== "FULL" ||
          !canTreasuryApprove ||
          (role !== "admin" && ctx.user.branchId == null)
        )
          return notFound();
        const [row] = await db
          .select({
            id: receipts.id,
            voucherNumber: receipts.voucherNumber,
            amount: receipts.amount,
            direction: receipts.direction,
            description: receipts.description,
            createdBy: receipts.createdBy,
            createdAt: receipts.createdAt,
          })
          .from(receipts)
          .where(
            and(
              eq(receipts.id, input.id),
              eq(receipts.approvalStatus, "PENDING_APPROVAL"),
              notExists(
                db
                  .select({ id: expenses.id })
                  .from(expenses)
                  .where(eq(expenses.receiptId, receipts.id)),
              ),
              ...(branchId == null ? [] : [eq(receipts.branchId, branchId)]),
              isNull(receipts.invoiceId),
            ),
          )
          .limit(1);
        if (!row || (role !== "admin" && Number(row.createdBy) === ctx.user.id))
          return notFound();
        return {
          kind: "voucher" as const,
          id: Number(row.id),
          title: row.direction === "IN" ? "سند قبض" : "سند صرف",
          reference: row.voucherNumber || `سند #${row.id}`,
          detail: row.description || "سند مالي بانتظار الاعتماد",
          createdAt: row.createdAt,
          amount: row.amount,
          canReject: true,
          capabilities: {
            canApprove: true,
            canReject: true,
            rejectionReason: "required" as const,
            supportsClientRequestId: false,
            duplicatePolicy: "state_transition_guard" as const,
          },
        };
      }

      if (input.kind === "expense") {
        if (ctx.user.isOwner !== true) return notFound();
        const [row] = await db
          .select({
            id: expenses.id,
            category: expenses.category,
            amount: expenses.amount,
            paymentMethod: expenses.paymentMethod,
            description: expenses.description,
            payee: expenses.payee,
            createdBy: expenses.createdBy,
            createdAt: expenses.createdAt,
          })
          .from(expenses)
          .innerJoin(receipts, eq(expenses.receiptId, receipts.id))
          .where(
            and(
              eq(expenses.id, input.id),
              actionableExpenseApprovalWhere(ctx.user.id),
            ),
          )
          .limit(1);
        if (!row) return notFound();
        return {
          kind: "expense" as const,
          id: Number(row.id),
          title: "طلب مصروف",
          reference: `EXP#${row.id}`,
          detail:
            [row.description, row.payee, row.category]
              .filter(Boolean)
              .join(" · ") || "طلب مصروف بانتظار اعتماد المالك",
          createdAt: row.createdAt,
          amount: row.amount,
          paymentMethod: row.paymentMethod,
          canReject: true,
          capabilities: {
            canApprove: true,
            canReject: true,
            rejectionReason: "required" as const,
            supportsClientRequestId: false,
            duplicatePolicy: "state_transition_guard" as const,
          },
        };
      }

      if (
        permissions.gifts !== "FULL" ||
        !canManage ||
        (role !== "admin" && (branchId ?? -1) < 0)
      )
        return notFound();
      const [row] = await db
        .select({
          id: giftVouchers.id,
          giftNumber: giftVouchers.giftNumber,
          totalCost: giftVouchers.totalCost,
          reason: giftVouchers.reason,
          createdBy: giftVouchers.createdBy,
          createdAt: giftVouchers.createdAt,
        })
        .from(giftVouchers)
        .where(
          and(
            eq(giftVouchers.id, input.id),
            eq(giftVouchers.status, "PENDING_APPROVAL"),
            ...(branchId == null ? [] : [eq(giftVouchers.branchId, branchId)]),
          ),
        )
        .limit(1);
      if (!row || (role !== "admin" && Number(row.createdBy) === ctx.user.id))
        return notFound();
      return {
        kind: "gift" as const,
        id: Number(row.id),
        title: "هدية صادرة",
        reference: row.giftNumber,
        detail: row.reason || "هدية بانتظار الاعتماد",
        createdAt: row.createdAt,
        amount: row.totalCost,
        canReject: false,
        capabilities: {
          canApprove: true,
          canReject: false,
          rejectionReason: "not_supported" as const,
          supportsClientRequestId: false,
          duplicatePolicy: "state_transition_guard" as const,
        },
      };
    }),

  markNotificationRead: selfServiceProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => markNotificationRead(ctx.user.id, input.id)),

  markAllNotificationsRead: selfServiceProcedure.mutation(({ ctx }) =>
    markAllNotificationsRead(ctx.user.id),
  ),

  notificationPreferences: selfServiceProcedure.query(({ ctx }) =>
    getNotificationPreferences(ctx.user.id),
  ),

  updateNotificationPreferences: selfServiceProcedure
    .input(
      z.object({
        taskAssigned: z.boolean(),
        payrollReady: z.boolean(),
        attendance: z.boolean(),
        leaveStatus: z.boolean(),
        approvals: z.boolean(),
        quietHoursStart: quietTime.optional(),
        quietHoursEnd: quietTime.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      updateNotificationPreferences(ctx.user.id, input),
    ),

  /** طلب إجازة ذاتي: employeeId مشتق من الجلسة ولا يمكن للعميل طلب إجازة لموظف آخر. */
  requestLeave: selfServiceProcedure
    .input(
      z.object({
        leaveType: z.enum(leaveTypeKeys),
        fromDate: dateString,
        toDate: dateString,
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = requireDb();
      const [employee] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.userId, ctx.user.id))
        .limit(1);
      if (!employee) throw new Error("لا يوجد ملف موظف مرتبط بهذا الحساب");
      const leave = await createLeave({
        ...input,
        employeeId: employee.id,
        days: 1,
      });
      await logAudit(ctx, {
        action: "leave.selfRequest",
        entityType: "leaveRequest",
        entityId: leave?.id,
        newValue: {
          leaveType: input.leaveType,
          fromDate: input.fromDate,
          toDate: input.toDate,
        },
      });
      if (leave?.id) {
        await createAppNotification({
          userId: ctx.user.id,
          kind: "LEAVE_STATUS",
          title: "تم إرسال طلب الإجازة",
          body: `${input.leaveType} · ${input.fromDate} — ${input.toDate}`,
          route: "/mobile#leave",
          eventKey: `leave:${leave.id}:requested`,
          entityType: "leaveRequest",
          entityId: leave.id,
          push: false,
        });
      }
      return leave;
    }),

  withdrawLeave: selfServiceProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb();
      const [employee] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(eq(employees.userId, ctx.user.id))
        .limit(1);
      if (!employee) throw new Error("لا يوجد ملف موظف مرتبط بهذا الحساب");
      const leave = await withdrawPendingLeave(input.id, employee.id);
      await logAudit(ctx, {
        action: "leave.selfWithdraw",
        entityType: "leaveRequest",
        entityId: input.id,
      });
      return leave;
    }),
});
