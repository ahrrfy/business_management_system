import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createAuthContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe("Dashboard Router", () => {
  it("should return stats for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const stats = await caller.dashboard.stats();

    expect(stats).toBeDefined();
    expect(typeof stats.monthlySales).toBe("number");
    expect(typeof stats.dailySales).toBe("number");
    expect(typeof stats.dailyInvoiceCount).toBe("number");
    expect(typeof stats.customerCount).toBe("number");
    expect(typeof stats.productCount).toBe("number");
    expect(typeof stats.supplierCount).toBe("number");
    expect(typeof stats.monthlyReceipts).toBe("number");
    expect(typeof stats.monthlyPayments).toBe("number");
    expect(typeof stats.monthlyProfit).toBe("number");
    expect(typeof stats.employeeCount).toBe("number");
    expect(Array.isArray(stats.lowStockProducts)).toBe(true);
    expect(Array.isArray(stats.recentInvoices)).toBe(true);
  });

  it("should reject unauthenticated users for stats", async () => {
    const ctx = createUnauthContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.dashboard.stats()).rejects.toThrow();
  });

  it("should return sales report for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const report = await caller.dashboard.salesReport({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(Array.isArray(report)).toBe(true);
  });

  it("should return profit/loss report for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const report = await caller.dashboard.profitLossReport({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(report).toBeDefined();
    expect(typeof report.revenue).toBe("number");
    expect(typeof report.purchases).toBe("number");
    expect(typeof report.grossProfit).toBe("number");
    expect(typeof report.netProfit).toBe("number");
    expect(typeof report.profitMargin).toBe("string");
  });

  it("should return top products for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const topProducts = await caller.dashboard.topProducts({ limit: 5 });

    expect(Array.isArray(topProducts)).toBe(true);
  });
});

describe("Products Router", () => {
  it("should list products for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // API يرجع مصفوفة مباشرة مع limit و offset
    const products = await caller.products.list({ limit: 10, offset: 0 });

    expect(products).toBeDefined();
    expect(Array.isArray(products)).toBe(true);
  });

  it("should get low stock products", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const lowStock = await caller.products.getLowStock();

    expect(Array.isArray(lowStock)).toBe(true);
  });
});

describe("Customers Router", () => {
  it("should list customers for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // API يرجع مصفوفة مباشرة مع limit و offset
    const customers = await caller.customers.list({ limit: 10, offset: 0 });

    expect(customers).toBeDefined();
    expect(Array.isArray(customers)).toBe(true);
  });
});

describe("Suppliers Router", () => {
  it("should list suppliers for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // API يرجع مصفوفة مباشرة مع limit و offset
    const suppliers = await caller.suppliers.list({ limit: 10, offset: 0 });

    expect(suppliers).toBeDefined();
    expect(Array.isArray(suppliers)).toBe(true);
  });
});

describe("HR Router", () => {
  it("should list employees for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // API يرجع مصفوفة مباشرة مع limit و offset
    const employees = await caller.hr.listEmployees({ limit: 10, offset: 0 });

    expect(employees).toBeDefined();
    expect(Array.isArray(employees)).toBe(true);
  });
});

describe("Invoices Router", () => {
  it("should get daily stats for authenticated user", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const stats = await caller.invoices.getDailyStats({});

    expect(stats).toBeDefined();
    expect(stats.data).toBeDefined();
    expect(typeof stats.data.totalSales).toBe("number");
    expect(typeof stats.data.invoiceCount).toBe("number");
  });
});
