import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { truncateTables } from "../../services/__tests__/__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

function adminCaller() {
  const ctx: TrpcContext = {
    req: { headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id: 1, role: "admin", branchId: 1, name: "admin", email: "admin@test.local", isActive: true } as TrpcContext["user"],
  };
  return appRouter.createCaller(ctx);
}

beforeEach(async () => {
  await truncateTables(["users", "branches"]);
  await db().insert(s.branches).values([
    { id: 1, name: "Main", code: "MAIN", type: "MAIN" },
    { id: 2, name: "Retail", code: "RETAIL", type: "SALES" },
  ]);
  await db().insert(s.users).values({
    id: 1, openId: "admin", name: "Admin", email: "admin@test.local", role: "admin", loginMethod: "local", branchId: 1,
  });
});

describe("users.list branch filter", () => {
  it("filters and paginates in SQL instead of dropping a branch after the first 500 users", async () => {
    await db().insert(s.users).values(
      Array.from({ length: 501 }, (_, index) => ({
        openId: `main-${index}`,
        name: `A-${String(index).padStart(3, "0")}`,
        email: `main-${index}@test.local`,
        role: "cashier" as const,
        loginMethod: "local" as const,
        branchId: 1,
      })),
    );
    await db().insert(s.users).values([
      { openId: "retail-1", name: "Z-Retail 1", email: "retail-1@test.local", role: "cashier", loginMethod: "local", branchId: 2 },
      { openId: "retail-2", name: "Z-Retail 2", email: "retail-2@test.local", role: "cashier", loginMethod: "local", branchId: 2 },
    ]);

    const result = await adminCaller().users.list({ branchId: 2, limit: 1, offset: 1 });

    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toBe("Z-Retail 2");
    expect(result.rows[0]?.branchId).toBe(2);
  });
});
