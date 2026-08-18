import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { sweepExpiredOnlineOrdersOnce } from "../onlineOrderExpirySweeper";
import { truncateTables } from "./__testUtils__";

const PRE_TRIGGER_NAME = "trg_online_orders_expired_activation_pre_bu";
const FINAL_TRIGGER_NAME = "trg_online_orders_expired_activation_bu";
const MIGRATION_PATH = resolve(
  process.cwd(),
  "drizzle/migrations/0208_online_order_reservation_expiry.sql",
);

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return (result[0] as T[]) ?? [];
  return (result as { rows?: T[] }).rows ?? [];
}

async function migrationStatements(): Promise<string[]> {
  const migration = await readFile(MIGRATION_PATH, "utf8");
  return migration
    .split(/-->\s*statement-breakpoint/g)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter(
      (statement) =>
        !statement
          .split("\n")
          .every((line) => line.trim() === "" || line.trim().startsWith("--")),
    );
}

async function executeStatements(statements: string[]): Promise<void> {
  for (const statement of statements) {
    await db().execute(sql.raw(statement));
  }
}

async function apply0208Migration(): Promise<void> {
  await executeStatements(await migrationStatements());
}

async function hasReservationExpiryColumn(): Promise<boolean> {
  const result = await db().execute(sql`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'onlineOrders'
      AND COLUMN_NAME = 'reservationExpiresAt'
  `);
  return (
    Number(resultRows<{ count: number | string }>(result)[0]?.count ?? 0) === 1
  );
}

async function triggerCount(name: string): Promise<number> {
  const result = await db().execute(sql`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.TRIGGERS
    WHERE TRIGGER_SCHEMA = DATABASE()
      AND EVENT_OBJECT_TABLE = 'onlineOrders'
      AND TRIGGER_NAME = ${name}
  `);
  return Number(resultRows<{ count: number | string }>(result)[0]?.count ?? 0);
}

async function hasReservationExpiryIndex(): Promise<boolean> {
  const result = await db().execute(sql`
    SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'onlineOrders'
      AND INDEX_NAME = 'idx_order_status_reservation_expiry'
  `);
  return (
    Number(resultRows<{ count: number | string }>(result)[0]?.count ?? 0) > 0
  );
}

async function resetToPre0208Schema(): Promise<void> {
  await db().execute(
    sql.raw(`DROP TRIGGER IF EXISTS \`${FINAL_TRIGGER_NAME}\``),
  );
  await db().execute(sql.raw(`DROP TRIGGER IF EXISTS \`${PRE_TRIGGER_NAME}\``));
  if (await hasReservationExpiryIndex()) {
    await db().execute(
      sql.raw(
        "DROP INDEX `idx_order_status_reservation_expiry` ON `onlineOrders`",
      ),
    );
  }
  if (await hasReservationExpiryColumn()) {
    await db().execute(
      sql.raw("ALTER TABLE `onlineOrders` DROP COLUMN `reservationExpiresAt`"),
    );
  }
}

async function seedPendingOrder(id: number, orderDate: Date): Promise<void> {
  await db().execute(sql`
    INSERT INTO onlineOrders (
      id, orderNumber, customerId, branchId, orderDate,
      subtotal, shippingCost, taxAmount, total, orderStatus
    ) VALUES (
      ${id}, ${`ORD-GUARD-${id}`}, 1, 1, ${orderDate},
      '100.00', '0.00', '0.00', '100.00', 'PENDING'
    )
  `);
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
  await resetToPre0208Schema();
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

// لا يترك الاختبار قاعدة 3310 على مخطط ما قبل 0208 حتى عند فشل حالة وسط الهجرة.
afterEach(async () => {
  await resetToPre0208Schema();
  await apply0208Migration();
});

describe("0208 gapless mixed-version online-order reservation guard", () => {
  it("creates the pre-guard before the column and the final guard before dropping the pre-guard", async () => {
    const migration = await readFile(MIGRATION_PATH, "utf8");
    const createPre = migration.indexOf(
      `CREATE TRIGGER \`${PRE_TRIGGER_NAME}\``,
    );
    const addExpiry = migration.indexOf("ADD COLUMN `reservationExpiresAt`");
    const createFinal = migration.indexOf(
      `CREATE TRIGGER \`${FINAL_TRIGGER_NAME}\``,
    );
    const dropPre = migration.lastIndexOf(
      `DROP TRIGGER IF EXISTS \`${PRE_TRIGGER_NAME}\``,
    );

    expect(createPre).toBeGreaterThanOrEqual(0);
    expect(addExpiry).toBeGreaterThan(createPre);
    expect(createFinal).toBeGreaterThan(addExpiry);
    expect(dropPre).toBeGreaterThan(createFinal);
  });

  it("blocks an expired old-worker update before reservationExpiresAt exists", async () => {
    const now = Date.now();
    await seedPendingOrder(1, new Date(now - 25 * 60 * 60 * 1_000));
    const statements = await migrationStatements();
    const addExpiryAt = statements.findIndex((statement) =>
      statement.includes("ADD COLUMN `reservationExpiresAt`"),
    );
    expect(addExpiryAt).toBeGreaterThan(0);

    await executeStatements(statements.slice(0, addExpiryAt));
    await expect(directOldWorkerUpdate(1, "CONFIRMED")).rejects.toMatchObject({
      cause: { code: "ER_SIGNAL_EXCEPTION", sqlState: "45000" },
    });
    expect(await hasReservationExpiryColumn()).toBe(false);

    await executeStatements(statements.slice(addExpiryAt));
    expect(await triggerCount(FINAL_TRIGGER_NAME)).toBe(1);
    expect(await triggerCount(PRE_TRIGGER_NAME)).toBe(0);
    await expect(storedStatus(1)).resolves.toBe("PENDING");
  });

  it("demonstrates the pre-guard vulnerability: an expired direct confirm succeeds", async () => {
    const now = Date.now();
    await seedPendingOrder(2, new Date(now - 25 * 60 * 60 * 1_000));

    await expect(
      directOldWorkerUpdate(2, "CONFIRMED"),
    ).resolves.toBeUndefined();
    await expect(storedStatus(2)).resolves.toBe("CONFIRMED");
  });

  it.each(["CONFIRMED", "PROCESSING"] as const)(
    "rejects an expired direct PENDING -> %s activation after 0208",
    async (status) => {
      const now = Date.now();
      await seedPendingOrder(3, new Date(now - 25 * 60 * 60 * 1_000));
      await apply0208Migration();

      await expect(directOldWorkerUpdate(3, status)).rejects.toMatchObject({
        cause: {
          code: "ER_SIGNAL_EXCEPTION",
          errno: 1644,
          sqlState: "45000",
        },
      });
      await expect(storedStatus(3)).resolves.toBe("PENDING");
    },
  );

  it("uses orderDate + 24 hours when a legacy worker leaves expiry NULL", async () => {
    const now = Date.now();
    await seedPendingOrder(4, new Date(now - 25 * 60 * 60 * 1_000));
    await apply0208Migration();
    await db().execute(sql`
      UPDATE onlineOrders
      SET reservationExpiresAt = NULL
      WHERE id = 4
    `);

    await expect(directOldWorkerUpdate(4, "CONFIRMED")).rejects.toMatchObject({
      cause: { sqlState: "45000" },
    });
    await expect(storedStatus(4)).resolves.toBe("PENDING");
  });

  it("allows a future reservation to confirm and an expired reservation to cancel", async () => {
    const now = Date.now();
    await seedPendingOrder(5, new Date(now));
    await seedPendingOrder(6, new Date(now - 25 * 60 * 60 * 1_000));
    await apply0208Migration();

    await expect(
      directOldWorkerUpdate(5, "CONFIRMED"),
    ).resolves.toBeUndefined();
    await expect(
      directOldWorkerUpdate(6, "CANCELLED"),
    ).resolves.toBeUndefined();
    await expect(storedStatus(5)).resolves.toBe("CONFIRMED");
    await expect(storedStatus(6)).resolves.toBe("CANCELLED");
  });

  it("keeps an expired reservation cancelled in a direct-confirm versus sweeper race", async () => {
    const now = new Date();
    await seedPendingOrder(7, new Date(now.getTime() - 25 * 60 * 60 * 1_000));
    await apply0208Migration();

    const [confirm, sweep] = await Promise.allSettled([
      directOldWorkerUpdate(7, "CONFIRMED"),
      sweepExpiredOnlineOrdersOnce(now, 50),
    ]);

    expect(confirm.status).toBe("rejected");
    expect(sweep).toMatchObject({
      status: "fulfilled",
      value: { cancelled: 1 },
    });
    await expect(storedStatus(7)).resolves.toBe("CANCELLED");
  });

  it("finishes 0208 with one final guard and no pre-guard", async () => {
    await apply0208Migration();

    expect(await triggerCount(FINAL_TRIGGER_NAME)).toBe(1);
    expect(await triggerCount(PRE_TRIGGER_NAME)).toBe(0);
  });
});
