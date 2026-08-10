/**
 * Native production report contract:
 * - a hard row ceiling and stable keyset cursor,
 * - authoritative totals independent from the page,
 * - reportViewerProcedure + scopedBranchId prevent cross-branch reads.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { getProductionReportPage } from "../reportsProductionService";
import { truncateTables } from "./__testUtils__";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

function context(role: string, branchId: number | null) {
  return {
    req: { headers: {} },
    res: { cookie() {}, clearCookie() {} },
    user: { id: role === "admin" ? 1 : 2, name: role, role, branchId },
  } as any;
}

const FROM = "2026-08-01";
const TO = "2026-08-31";

beforeEach(async () => {
  await truncateTables(["productionOrders", "branches"]);
  const store = db();
  await store.insert(s.branches).values([
    { id: 1, name: "فرع الإنتاج الأول", code: "PROD-1", type: "MAIN" },
    { id: 2, name: "فرع الإنتاج الثاني", code: "PROD-2", type: "SALES" },
  ]);
  const at = new Date("2026-08-10T12:00:00.000Z");
  await store.insert(s.productionOrders).values([
    ...Array.from({ length: 105 }, (_, index) => ({
      docNumber: `NATIVE-P1-${String(index + 1).padStart(3, "0")}`,
      branchId: 1,
      status: "CONFIRMED" as const,
      materialsCost: "10.00",
      laborCost: "2.00",
      totalCost: "12.00",
      abnormalLoss: "1.00",
      createdAt: at,
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      docNumber: `NATIVE-P2-${String(index + 1).padStart(3, "0")}`,
      branchId: 2,
      status: "CONFIRMED" as const,
      materialsCost: "20.00",
      laborCost: "4.00",
      totalCost: "24.00",
      abnormalLoss: "0.00",
      createdAt: at,
    })),
    {
      docNumber: "NATIVE-P1-CANCELLED",
      branchId: 1,
      status: "CANCELLED" as const,
      materialsCost: "999.00",
      laborCost: "999.00",
      totalCost: "1998.00",
      abnormalLoss: "999.00",
      createdAt: at,
    },
  ]);
});

describe("getProductionReportPage", () => {
  it("caps direct callers, returns no more than limit, and advances without overlap by cursor", async () => {
    const capped = await getProductionReportPage({ from: FROM, to: TO, branchId: 1, limit: 10_000 });
    expect(capped.rows).toHaveLength(100);
    expect(capped.total).toBe(105);
    expect(capped.nextCursor).not.toBeNull();
    expect(capped.rows.every((row) => row.docNumber?.startsWith("NATIVE-P1-"))).toBe(true);
    expect(capped.totals.count).toBe(105);
    expect(capped.totals.totalCost).toBe("1260.00");

    const first = await getProductionReportPage({ from: FROM, to: TO, branchId: 1, limit: 20 });
    const second = await getProductionReportPage({
      from: FROM,
      to: TO,
      branchId: 1,
      limit: 20,
      cursor: first.nextCursor ?? undefined,
    });
    expect(first.rows).toHaveLength(20);
    expect(second.rows).toHaveLength(20);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(40);
    expect(second.totals).toEqual(first.totals);
  });
});

describe("reports.productionReportPage branch scope", () => {
  it("rejects a manager cross-branch request and pins an omitted branch to the manager branch", async () => {
    const manager = appRouter.createCaller(context("manager", 1));
    await expect(manager.reports.productionReportPage({
      from: FROM,
      to: TO,
      branchId: 2,
      limit: 10,
      offset: 0,
    })).rejects.toThrow(/فرع آخر/);

    const own = await manager.reports.productionReportPage({ from: FROM, to: TO, limit: 7, offset: 0 });
    expect(own.rows).toHaveLength(7);
    expect(own.total).toBe(105);
    expect(own.rows.every((row) => row.docNumber?.startsWith("NATIVE-P1-"))).toBe(true);
  });

  it("allows admin to select one branch without leaking rows from another branch", async () => {
    const admin = appRouter.createCaller(context("admin", null));
    const result = await admin.reports.productionReportPage({
      from: FROM,
      to: TO,
      branchId: 2,
      limit: 25,
      offset: 0,
    });
    expect(result.total).toBe(7);
    expect(result.rows).toHaveLength(7);
    expect(result.rows.every((row) => row.docNumber?.startsWith("NATIVE-P2-"))).toBe(true);
  });
});
