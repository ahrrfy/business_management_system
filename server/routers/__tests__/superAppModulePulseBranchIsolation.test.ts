import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";
import { baghdadTodayUtcRange } from "../../services/businessDay";
import { getManagementAlerts } from "../../services/reportsAlertsService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function caller(
  branchId: number | null,
  user: Partial<NonNullable<TrpcContext["user"]>> = {},
) {
  const context = {
    req: { headers: {} },
    res: {},
    sessionId: null,
    platformAdmin: null,
    user: {
      id: 50,
      openId: "module-pulse-manager",
      name: "Module pulse manager",
      role: "manager",
      branchId,
      isActive: true,
      isOwner: false,
      ...user,
    },
  } as unknown as TrpcContext;
  return appRouter.createCaller(context);
}

function metricValues(result: { metrics: Array<{ key: string; value: number }> }) {
  return Object.fromEntries(result.metrics.map((item) => [item.key, item.value]));
}

beforeEach(async () => {
  await truncateTables([
    "accountingEntries",
    "purchaseOrders",
    "invoices",
    "customers",
    "suppliers",
    "users",
    "branches",
  ]);
  await db().insert(schema.branches).values([
    { id: 1, name: "Main", code: "PULSE-MAIN", type: "MAIN" },
    { id: 2, name: "Second", code: "PULSE-SECOND", type: "SALES" },
  ]);
});

describe("super app module pulse branch isolation", () => {
  it("isolates supplier counts and ledger payables and fails a branchless manager closed", async () => {
    await db().insert(schema.suppliers).values([
      { id: 101, name: "Branch one supplier", currentBalance: "100", isActive: true },
      { id: 202, name: "Branch two supplier", currentBalance: "250", isActive: true },
      { id: 303, name: "Opening-only supplier", currentBalance: "75", isActive: true },
    ]);
    await db().insert(schema.purchaseOrders).values([
      {
        id: 1001,
        poNumber: "PULSE-PO-1",
        supplierId: 101,
        branchId: 1,
        subtotal: "100",
        total: "100",
        paidAmount: "0",
        status: "CONFIRMED",
      },
      {
        id: 2001,
        poNumber: "PULSE-PO-2",
        supplierId: 202,
        branchId: 2,
        subtotal: "250",
        total: "250",
        paidAmount: "0",
        status: "CONFIRMED",
      },
    ]);
    await db().insert(schema.accountingEntries).values([
      {
        entryType: "PURCHASE",
        branchId: 1,
        supplierId: 101,
        purchaseOrderId: 1001,
        amount: "100",
        entryDate: "2026-08-09",
        dedupeKey: "PULSE:PO:1",
      },
      {
        entryType: "PURCHASE",
        branchId: 2,
        supplierId: 202,
        purchaseOrderId: 2001,
        amount: "250",
        entryDate: "2026-08-09",
        dedupeKey: "PULSE:PO:2",
      },
    ]);

    const scoped = await caller(1).superApp.modulePulse({ moduleKey: "suppliers" });
    const branchless = await caller(null).superApp.modulePulse({ moduleKey: "suppliers" });
    const [branchOneAlerts, branchTwoAlerts, companyAlerts] = await Promise.all([
      getManagementAlerts({ branchId: 1, isAdmin: false }),
      getManagementAlerts({ branchId: 2, isAdmin: false }),
      getManagementAlerts({ isAdmin: true }),
    ]);
    const branchOnePayables = branchOneAlerts.alerts.find((item) => item.key === "ap-due");
    const branchTwoPayables = branchTwoAlerts.alerts.find((item) => item.key === "ap-due");
    const companyPayables = companyAlerts.alerts.find((item) => item.key === "ap-due");

    expect(metricValues(scoped)).toEqual({ "active-suppliers": 1, payables: 100 });
    expect(metricValues(branchless)).toEqual({ "active-suppliers": 0, payables: 0 });
    expect(branchOnePayables).toMatchObject({ count: 1, amount: "100.00" });
    expect(branchTwoPayables).toMatchObject({ count: 1, amount: "250.00" });
    expect(companyPayables).toMatchObject({ count: 3, amount: "425.00" });
  });

  it("isolates customer receivables, users, and branches for managers", async () => {
    await db().insert(schema.users).values([
      { id: 1, openId: "pulse-user-1", name: "Branch one user", role: "cashier", branchId: 1 },
      { id: 2, openId: "pulse-user-2", name: "Branch two user", role: "cashier", branchId: 2 },
    ]);
    await db().insert(schema.customers).values([
      { id: 301, name: "Branch one customer", currentBalance: "999", isActive: true },
      { id: 302, name: "Branch two customer", currentBalance: "999", isActive: true },
    ]);
    await db().insert(schema.invoices).values([
      {
        invoiceNumber: "PULSE-INV-1",
        sourceType: "POS",
        branchId: 1,
        customerId: 301,
        subtotal: "100",
        total: "100",
        paidAmount: "20",
        returnedTotal: "10",
        status: "PENDING",
      },
      {
        invoiceNumber: "PULSE-INV-2",
        sourceType: "POS",
        branchId: 2,
        customerId: 302,
        subtotal: "400",
        total: "400",
        paidAmount: "50",
        returnedTotal: "0",
        status: "PARTIALLY_PAID",
      },
    ]);

    const scopedCaller = caller(1);
    const branchlessCaller = caller(null);
    const [crm, users, settings, emptyCrm, emptyUsers, emptySettings] = await Promise.all([
      scopedCaller.superApp.modulePulse({ moduleKey: "crm" }),
      scopedCaller.superApp.modulePulse({ moduleKey: "users" }),
      scopedCaller.superApp.modulePulse({ moduleKey: "settings" }),
      branchlessCaller.superApp.modulePulse({ moduleKey: "crm" }),
      branchlessCaller.superApp.modulePulse({ moduleKey: "users" }),
      branchlessCaller.superApp.modulePulse({ moduleKey: "settings" }),
    ]);

    expect(metricValues(crm)).toEqual({ "active-customers": 1, receivables: 70 });
    expect(metricValues(users)).toEqual({ active: 1, locked: 0 });
    expect(metricValues(settings)).toMatchObject({ branches: 1 });
    expect(metricValues(emptyCrm)).toEqual({ "active-customers": 0, receivables: 0 });
    expect(metricValues(emptyUsers)).toEqual({ active: 0, locked: 0 });
    expect(metricValues(emptySettings)).toMatchObject({ branches: 0 });
  });

  it("advertises stale persisted owners as effective admins with admin modules", async () => {
    const bootstrap = await caller(1, {
      role: "user",
      isOwner: true,
      permissionsOverride: { users: "NONE", settings: "NONE" },
    }).superApp.bootstrap();
    const modules = Object.fromEntries(bootstrap.modules.map((item) => [item.key, item.access]));

    expect(bootstrap.user.role).toBe("admin");
    expect(bootstrap.scope.allBranches).toBe(true);
    expect(bootstrap.capabilities.isOwner).toBe(true);
    expect(modules).toMatchObject({ users: "FULL", settings: "FULL" });
  });

  it("rejects command-center access when the effective reports grant is disabled", async () => {
    const request = caller(1, {
      permissionsOverride: {
        reports: "NONE",
        sales: "NONE",
        pos: "NONE",
        collections: "NONE",
        inventory: "NONE",
        products: "NONE",
        workorders: "NONE",
        tasks: "NONE",
        treasury: "NONE",
        purchases: "NONE",
        suppliers: "NONE",
      },
    }).executive.commandCenter();

    await expect(request).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("uses the same bounded net-sales definition in module pulse and command center", async () => {
    const now = new Date();
    const { endExclusive: tomorrow } = baghdadTodayUtcRange(now);
    await db().insert(schema.invoices).values([
      {
        invoiceNumber: "PULSE-SALES-NET",
        sourceType: "POS",
        branchId: 1,
        invoiceDate: now,
        subtotal: "100",
        total: "100",
        returnedTotal: "40",
        status: "PAID",
      },
      {
        invoiceNumber: "PULSE-SALES-FUTURE",
        sourceType: "POS",
        branchId: 1,
        invoiceDate: tomorrow,
        subtotal: "800",
        total: "800",
        status: "PAID",
      },
      {
        invoiceNumber: "PULSE-SALES-CANCELLED",
        sourceType: "POS",
        branchId: 1,
        invoiceDate: now,
        subtotal: "700",
        total: "700",
        status: "CANCELLED",
      },
    ]);

    const [pulse, commandCenter] = await Promise.all([
      caller(1).superApp.modulePulse({ moduleKey: "sales" }),
      caller(1).executive.commandCenter({ branchId: 1 }),
    ]);

    expect(metricValues(pulse)).toMatchObject({ "today-count": 1, "today-total": 60 });
    expect(commandCenter.operationalSnapshot.salesToday).toMatchObject({
      invoiceCount: 1,
      total: "60.00",
    });
  });
});
