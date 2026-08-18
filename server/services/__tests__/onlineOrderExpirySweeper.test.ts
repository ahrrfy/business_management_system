import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { sweepExpiredOnlineOrdersOnce } from "../onlineOrderExpirySweeper";
import { truncateTables } from "./__testUtils__";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seedOrder(
  id: number,
  status: "PENDING" | "CONFIRMED",
  expiry: Date,
): Promise<void> {
  await db()
    .insert(s.onlineOrders)
    .values({
      id,
      orderNumber: `ORD-SWEEP-${id}`,
      customerId: 1,
      branchId: 1,
      subtotal: "100.00",
      total: "100.00",
      status,
    });
  await db().execute(sql`
    UPDATE onlineOrders
    SET reservationExpiresAt = ${expiry}
    WHERE id = ${id}
  `);
}

beforeEach(async () => {
  await truncateTables([
    "onlineOrderItems",
    "onlineOrders",
    "customers",
    "branches",
  ]);
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.customers).values({ id: 1, name: "زبون تجريبي" });
});

describe("storefront PENDING reservation expiry sweeper", () => {
  it("cancels only due PENDING rows and is idempotent", async () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    await seedOrder(1, "PENDING", new Date(now.getTime() - 1));
    await seedOrder(2, "PENDING", new Date(now.getTime() + 60_000));
    await seedOrder(3, "CONFIRMED", new Date(now.getTime() - 60_000));

    await expect(sweepExpiredOnlineOrdersOnce(now, 50)).resolves.toEqual({
      cancelled: 1,
    });
    const rows = (await db().execute(sql`
      SELECT id, orderStatus AS status, cancelReason
      FROM onlineOrders
      ORDER BY id
    `)) as unknown;
    const values = Array.isArray(rows)
      ? (rows[0] as Array<{
          id: number;
          status: string;
          cancelReason: string | null;
        }>)
      : ((
          rows as {
            rows?: Array<{
              id: number;
              status: string;
              cancelReason: string | null;
            }>;
          }
        ).rows ?? []);
    expect(values).toEqual([
      expect.objectContaining({
        id: 1,
        status: "CANCELLED",
        cancelReason: expect.stringMatching(/مهلة حجز المخزون/),
      }),
      expect.objectContaining({ id: 2, status: "PENDING" }),
      expect.objectContaining({ id: 3, status: "CONFIRMED" }),
    ]);
    await expect(sweepExpiredOnlineOrdersOnce(now, 50)).resolves.toEqual({
      cancelled: 0,
    });
  });
});
