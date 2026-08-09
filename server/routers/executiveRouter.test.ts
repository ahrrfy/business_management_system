import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { alertAction, assertExecutiveAccess, getExecutiveTodaySales, resolveExecutiveBranch } from "./executiveRouter";

describe("executive command center contract", () => {
  it("allows admin aggregate scope and an explicit branch", () => {
    expect(resolveExecutiveBranch({ role: "admin", branchId: null })).toBeUndefined();
    expect(resolveExecutiveBranch({ role: "admin", branchId: null }, 7)).toBe(7);
  });

  it("pins every non-admin to the assigned branch", () => {
    expect(resolveExecutiveBranch({ role: "manager", branchId: 3 })).toBe(3);
    expect(resolveExecutiveBranch({ role: "manager", branchId: 3 }, 3)).toBe(3);
    expect(() => resolveExecutiveBranch({ role: "manager", branchId: null })).toThrow();
    expect(() => resolveExecutiveBranch({ role: "manager", branchId: 3 }, 4)).toThrow(/فرع آخر/);
    expect(() => resolveExecutiveBranch({ role: "accountant", branchId: null })).toThrow(/فرع مسند/);
  });

  it("rejects roles without executive authority", () => {
    expect(() => assertExecutiveAccess({ role: "user" })).toThrow();
    expect(() => assertExecutiveAccess({ role: "accountant" })).toThrow();
    expect(() => assertExecutiveAccess({ role: "sales" })).toThrow();
    expect(() => assertExecutiveAccess({ role: "manager" })).not.toThrow();
    expect(() => assertExecutiveAccess({ role: "admin" })).not.toThrow();
  });

  it("uses net returns and Baghdad-midnight boundaries for company and branch aggregates", async () => {
    const db = getDb();
    if (!db) throw new Error("test database unavailable");
    const prefix = `EXEC-${Date.now()}`;
    const branchId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const beforeBaghdadMidnight = new Date("2026-08-09T20:59:59.999Z");
    const atBaghdadMidnight = new Date("2026-08-09T21:00:00.000Z");
    await db.execute(sql`INSERT INTO branches (id, name, code, branchType) VALUES (${branchId}, 'Executive test', ${prefix}, 'SALES')`);
    const [companyBefore, branchBefore, companyNextBefore, branchNextBefore] = await Promise.all([
      getExecutiveTodaySales(undefined, beforeBaghdadMidnight),
      getExecutiveTodaySales(branchId, beforeBaghdadMidnight),
      getExecutiveTodaySales(undefined, atBaghdadMidnight),
      getExecutiveTodaySales(branchId, atBaghdadMidnight),
    ]);
    try {
      await db.execute(sql`
        INSERT INTO invoices (invoiceNumber, sourceType, branchId, invoiceDate, subtotal, total, returnedTotal, invoiceStatus)
        VALUES
          (${`${prefix}-NET`}, 'POS', ${branchId}, '2026-08-09 20:30:00', 100, 100, 40, 'PAID'),
          (${`${prefix}-OLD`}, 'POS', ${branchId}, '2026-08-08 20:59:59', 900, 900, 0, 'PAID'),
          (${`${prefix}-NEXT`}, 'POS', ${branchId}, '2026-08-09 21:00:00', 800, 800, 0, 'PAID'),
          (${`${prefix}-VOID`}, 'POS', ${branchId}, '2026-08-09 20:45:00', 700, 700, 0, 'CANCELLED')
      `);
      const [companyAfter, branchAfter, companyNextAfter, branchNextAfter] = await Promise.all([
        getExecutiveTodaySales(undefined, beforeBaghdadMidnight),
        getExecutiveTodaySales(branchId, beforeBaghdadMidnight),
        getExecutiveTodaySales(undefined, atBaghdadMidnight),
        getExecutiveTodaySales(branchId, atBaghdadMidnight),
      ]);
      expect(companyAfter.invoiceCount - companyBefore.invoiceCount).toBe(1);
      expect(branchAfter.invoiceCount - branchBefore.invoiceCount).toBe(1);
      expect(Number(companyAfter.total) - Number(companyBefore.total)).toBe(60);
      expect(Number(branchAfter.total) - Number(branchBefore.total)).toBe(60);
      expect(companyNextAfter.invoiceCount - companyNextBefore.invoiceCount).toBe(1);
      expect(branchNextAfter.invoiceCount - branchNextBefore.invoiceCount).toBe(1);
      expect(Number(companyNextAfter.total) - Number(companyNextBefore.total)).toBe(800);
      expect(Number(branchNextAfter.total) - Number(branchNextBefore.total)).toBe(800);
      expect(companyAfter.generatedAt).toBe(beforeBaghdadMidnight.toISOString());
    } finally {
      await db.execute(sql`DELETE FROM invoices WHERE invoiceNumber LIKE ${`${prefix}-%`}`);
      await db.execute(sql`DELETE FROM branches WHERE id = ${branchId}`);
    }
  });

  it("maps server report links to a closed native destination vocabulary", () => {
    expect(alertAction({ key: "stock-out", href: "/reports/stock-status" })).toEqual({
      destinationKey: "PRODUCTS", args: { stockState: "out" },
    });
    expect(alertAction({ key: "ar-90", href: "/reports/aging-hub" })).toEqual({
      destinationKey: "RECEIVABLES", args: { bucket: "ar-90" },
    });
    expect(alertAction({ key: "unknown", href: "https://malicious.example" })).toEqual({
      destinationKey: "INSIGHTS", args: { section: "managementAlerts" },
    });
  });
});
