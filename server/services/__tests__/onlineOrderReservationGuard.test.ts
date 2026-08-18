import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { sweepExpiredOnlineOrdersOnce } from "../onlineOrderExpirySweeper";
import { truncateTables } from "./__testUtils__";

const TRIGGER_NAME = "trg_online_orders_expired_activation_bu";
const MIGRATION_PATH = resolve(
  process.cwd(),
  "drizzle/migrations/0210_online_order_reservation_guard.sql",
);

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function dropGuard(): Promise<void> {
  await db().execute(sql.raw(`DROP TRIGGER IF EXISTS \`${TRIGGER_NAME}\``));
}

async function applyGuardMigration(): Promise<void> {
  const migration = await readFile(MIGRATION_PATH, "utf8");
  const statements = migration
    .split(/-->\s*statement-breakpoint/g)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter(
      (statement) =>
        !statement
          .split("\n")
          .every((line) => line.trim() === "" || line.trim().startsWith("--")),
    );
  for (const statement of statements) {
    await db().execute(sql.raw(statement));
  }
}

async function seedPendingOrder(input: {
  id: number;
  orderDate: Date;
  reservationExpiresAt: Date | null;
}): Promise<void> {
  await db()
    .insert(s.onlineOrders)
    .values({
      id: input.id,
      orderNumber: `ORD-GUARD-${input.id}`,
      customerId: 1,
      branchId: 1,
      orderDate: input.orderDate,
      reservationExpiresAt: input.reservationExpiresAt,
      subtotal: "100.00",
      total: "100.00",
      status: "PENDING",
    });
}

async function directOldWorkerUpdate(
  id: number,
  status: "CONFIRMED" | "PROCESSING" | "CANCELLED",
): Promise<void> {
  await db().execute(sql`
    UPDATE onlineOrders
    SET orderStatus = ${status}
    WHERE id = ${id}
  `);
}

async function storedStatus(id: number): Promise<string> {
  const row = (
    await db()
      .select({ status: s.onlineOrders.status })
      .from(s.onlineOrders)
      .where(eq(s.onlineOrders.id, id))
      .limit(1)
  )[0];
  if (!row) throw new Error(`missing online order ${id}`);
  return row.status;
}

beforeEach(async () => {
  await dropGuard();
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

// يبقى مخطط قاعدة الاختبار مطابقاً للهجرة بعد كل حالة، حتى حالة RED التي تسقط الحارس عمداً.
afterEach(applyGuardMigration);

describe("0210 mixed-version online-order reservation guard", () => {
  it("demonstrates the pre-guard vulnerability: an expired direct confirm succeeds", async () => {
    const now = Date.now();
    await seedPendingOrder({
      id: 1,
      orderDate: new Date(now - 25 * 60 * 60 * 1_000),
      reservationExpiresAt: new Date(now - 1_000),
    });

    await expect(
      directOldWorkerUpdate(1, "CONFIRMED"),
    ).resolves.toBeUndefined();
    await expect(storedStatus(1)).resolves.toBe("CONFIRMED");
  });

  it.each(["CONFIRMED", "PROCESSING"] as const)(
    "rejects an expired direct PENDING -> %s activation",
    async (status) => {
      const now = Date.now();
      await applyGuardMigration();
      await seedPendingOrder({
        id: 2,
        orderDate: new Date(now - 25 * 60 * 60 * 1_000),
        reservationExpiresAt: new Date(now - 1_000),
      });

      await expect(directOldWorkerUpdate(2, status)).rejects.toMatchObject({
        cause: {
          code: "ER_SIGNAL_EXCEPTION",
          errno: 1644,
          sqlState: "45000",
        },
      });
      await expect(storedStatus(2)).resolves.toBe("PENDING");
    },
  );

  it("uses orderDate + 24 hours when a legacy worker left expiry NULL", async () => {
    const now = Date.now();
    await applyGuardMigration();
    await seedPendingOrder({
      id: 3,
      orderDate: new Date(now - 25 * 60 * 60 * 1_000),
      reservationExpiresAt: null,
    });

    await expect(directOldWorkerUpdate(3, "CONFIRMED")).rejects.toMatchObject({
      cause: { sqlState: "45000" },
    });
    await expect(storedStatus(3)).resolves.toBe("PENDING");
  });

  it("allows a future PENDING reservation to be confirmed", async () => {
    const now = Date.now();
    await applyGuardMigration();
    await seedPendingOrder({
      id: 4,
      orderDate: new Date(now),
      reservationExpiresAt: new Date(now + 60_000),
    });

    await expect(
      directOldWorkerUpdate(4, "CONFIRMED"),
    ).resolves.toBeUndefined();
    await expect(storedStatus(4)).resolves.toBe("CONFIRMED");
  });

  it("allows an expired PENDING reservation to be cancelled", async () => {
    const now = Date.now();
    await applyGuardMigration();
    await seedPendingOrder({
      id: 5,
      orderDate: new Date(now - 25 * 60 * 60 * 1_000),
      reservationExpiresAt: new Date(now - 1_000),
    });

    await expect(
      directOldWorkerUpdate(5, "CANCELLED"),
    ).resolves.toBeUndefined();
    await expect(storedStatus(5)).resolves.toBe("CANCELLED");
  });

  it("keeps an expired reservation cancelled in a direct-confirm versus sweeper race", async () => {
    const now = new Date();
    await applyGuardMigration();
    await seedPendingOrder({
      id: 6,
      orderDate: new Date(now.getTime() - 25 * 60 * 60 * 1_000),
      reservationExpiresAt: new Date(now.getTime() - 1_000),
    });

    const [confirm, sweep] = await Promise.allSettled([
      directOldWorkerUpdate(6, "CONFIRMED"),
      sweepExpiredOnlineOrdersOnce(now, 50),
    ]);

    expect(confirm.status).toBe("rejected");
    expect(sweep).toMatchObject({
      status: "fulfilled",
      value: { cancelled: 1 },
    });
    await expect(storedStatus(6)).resolves.toBe("CANCELLED");
  });

  it("re-applies idempotently without creating a conflicting trigger", async () => {
    const now = Date.now();
    await applyGuardMigration();
    await applyGuardMigration();
    await seedPendingOrder({
      id: 7,
      orderDate: new Date(now - 25 * 60 * 60 * 1_000),
      reservationExpiresAt: new Date(now - 1_000),
    });

    await expect(directOldWorkerUpdate(7, "CONFIRMED")).rejects.toMatchObject({
      cause: { sqlState: "45000" },
    });
  });
});
