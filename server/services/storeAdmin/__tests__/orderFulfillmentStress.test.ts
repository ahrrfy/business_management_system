/**
 * Empirical Adversarial Stress Harness for Store Order Fulfillment
 *
 * Verifies Milestone M1 (Transactional Concurrency & State Engine Integrity):
 * 1. High-concurrency race condition: 10 concurrent promises hitting claimOnlineOrder
 *    on the exact same PENDING order simultaneously.
 * 2. Row-locking serialization (for update): exactly 1 winner, colliding claims reject with 409 CONFLICT.
 * 3. Immediate rejection of claiming SHIPPED orders (400 BAD_REQUEST).
 * 4. markOnlineOrderPrepared idempotency: repeated calls do NOT alter preparedAt or duration.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import {
  claimOnlineOrder,
  markOnlineOrderPrepared,
} from "../orderFulfillmentService";
import { ensureFinancialPostingGate } from "../../reports/monthCloseGate";

function db() {
  const d = getDb();
  if (!d) throw new Error("Database connection is not available in test harness");
  return d;
}

let currentBranchId = 1;
let currentCustomerId = 1;

async function setupBaselineData() {
  const d = db();
  await ensureFinancialPostingGate(d);

  // Seed or fetch branch
  const existingBranch = (await d.select({ id: s.branches.id }).from(s.branches).limit(1))[0];
  if (existingBranch) {
    currentBranchId = Number(existingBranch.id);
  } else {
    await d.insert(s.branches).values({
      name: "الفرع الرئيسي",
      code: `MAIN-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      type: "MAIN",
    });
    const b = (await d.select({ id: s.branches.id }).from(s.branches).limit(1))[0];
    currentBranchId = Number(b.id);
  }

  // Seed or fetch customer
  const existingCustomer = (await d.select({ id: s.customers.id }).from(s.customers).limit(1))[0];
  if (existingCustomer) {
    currentCustomerId = Number(existingCustomer.id);
  } else {
    await d.insert(s.customers).values({
      name: "عميل تجريبي",
      phone: `+964770${Math.floor(1000000 + Math.random() * 9000000)}`,
    });
    const c = (await d.select({ id: s.customers.id }).from(s.customers).limit(1))[0];
    currentCustomerId = Number(c.id);
  }

  // Seed users 1..19 for multi-staff concurrency tests
  const usersToSeed = [
    { id: 1, openId: "usr_admin", name: "المشرف", username: "admin_u", email: "admin@erp.local", passwordHash: "h", role: "admin", branchId: currentBranchId },
    { id: 2, openId: "usr_staff1", name: "موظف 1", username: "staff_1", email: "s1@erp.local", passwordHash: "h", role: "user", branchId: currentBranchId },
    { id: 3, openId: "usr_staff2", name: "موظف 2", username: "staff_2", email: "s2@erp.local", passwordHash: "h", role: "user", branchId: currentBranchId },
    { id: 4, openId: "usr_manager", name: "المدير", username: "manager_u", email: "m@erp.local", passwordHash: "h", role: "manager", branchId: currentBranchId },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 10 + i,
      openId: `usr_swarm_${i}`,
      name: `موظف سرب ${i}`,
      username: `swarm_${i}`,
      email: `swarm${i}@erp.local`,
      passwordHash: "h",
      role: "user",
      branchId: currentBranchId,
    })),
  ];

  for (const u of usersToSeed) {
    await d
      .insert(s.users)
      .values(u)
      .onDuplicateKeyUpdate({ set: { name: u.name, branchId: currentBranchId } });
  }
}

async function seedTestOrder(
  status: "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" = "PENDING",
  overrides: {
    claimedByUserId?: number | null;
    claimedAt?: Date | null;
    preparedByUserId?: number | null;
    preparedAt?: Date | null;
    fulfillmentDurationMinutes?: number | null;
    reservationExpiresAt?: Date | null;
    orderDate?: Date;
  } = {}
): Promise<number> {
  const d = db();
  await setupBaselineData();
  const orderNumber = `ORD-TEST-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

  await d.insert(s.onlineOrders).values({
    orderNumber,
    customerId: currentCustomerId,
    branchId: currentBranchId,
    subtotal: "50000.00",
    shippingCost: "5000.00",
    deliveryFree: false,
    taxAmount: "0.00",
    total: "55000.00",
    status,
    claimedByUserId: overrides.claimedByUserId ?? null,
    claimedAt: overrides.claimedAt ?? null,
    preparedByUserId: overrides.preparedByUserId ?? null,
    preparedAt: overrides.preparedAt ?? null,
    fulfillmentDurationMinutes: overrides.fulfillmentDurationMinutes ?? null,
    contactStatus: "NOT_CONTACTED",
    shippingAddress: "بغداد - الكرادة",
    governorate: "baghdad",
    ...(overrides.orderDate ? { orderDate: overrides.orderDate } : {}),
    ...(overrides.reservationExpiresAt !== undefined ? { reservationExpiresAt: overrides.reservationExpiresAt } : {}),
  });

  const row = (
    await d
      .select({ id: s.onlineOrders.id })
      .from(s.onlineOrders)
      .where(eq(s.onlineOrders.orderNumber, orderNumber))
      .limit(1)
  )[0];

  return Number(row.id);
}

async function fetchOrder(orderId: number) {
  return (
    await db()
      .select()
      .from(s.onlineOrders)
      .where(eq(s.onlineOrders.id, orderId))
      .limit(1)
  )[0];
}

beforeEach(async () => {
  await setupBaselineData();
});

describe("Milestone M1 Empirical Stress Tests — Concurrency & State Machine Integrity", () => {
  // =========================================================================
  // 1. HIGH-CONCURRENCY RACE CONDITION: 10 CONCURRENT CLAIMS ON SAME PENDING ORDER
  // =========================================================================
  it("Stress Test 1: 10 concurrent staff claims on the exact same PENDING order -> Exactly 1 winner, 9 CONFLICT", async () => {
    const orderId = await seedTestOrder("PENDING");

    // Launch 10 concurrent worker claims simultaneously
    const workerIds = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const promises = workerIds.map((userId) =>
      claimOnlineOrder({ id: orderId, scopedBranchId: currentBranchId }, { userId, role: "user" })
    );

    const outcomes = await Promise.allSettled(promises);

    const fulfilled = outcomes.filter(
      (o): o is PromiseFulfilledResult<{ success: boolean; claimedByUserId: number; orderNumber: string }> =>
        o.status === "fulfilled"
    );
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === "rejected"
    );

    // Rule: Exactly 1 claim MUST succeed
    expect(fulfilled).toHaveLength(1);
    const winner = fulfilled[0].value;
    expect(winner.success).toBe(true);
    expect(workerIds).toContain(winner.claimedByUserId);

    // Rule: All 9 colliding claims MUST reject with 409 CONFLICT
    expect(rejected).toHaveLength(9);
    for (const rej of rejected) {
      expect(rej.reason).toMatchObject({
        code: "CONFLICT",
      });
      // Verify Arabic message indicates the order was already claimed
      expect(rej.reason.message).toContain("الطلب مستلم ومحجوز مسبقاً");
    }

    // Verify database state: order is CONFIRMED, claimedByUserId equals winner, claimedAt is set
    const finalOrder = await fetchOrder(orderId);
    expect(finalOrder.status).toBe("CONFIRMED");
    expect(Number(finalOrder.claimedByUserId)).toBe(winner.claimedByUserId);
    expect(finalOrder.claimedAt).not.toBeNull();
  });

  // =========================================================================
  // 2. MULTI-ROUND RACE HARNESS: 5 BATCHES UNDER RAPID FIRE
  // =========================================================================
  it("Stress Test 2: Rapid-fire multi-round concurrency stress across 5 distinct orders (0 corruptions)", async () => {
    for (let round = 1; round <= 5; round++) {
      const orderId = await seedTestOrder("PENDING");
      const workers = [2, 3, 10, 11, 12];

      const outcomes = await Promise.allSettled(
        workers.map((userId) =>
          claimOnlineOrder({ id: orderId, scopedBranchId: null }, { userId, role: "user" })
        )
      );

      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);

      const winnerUserId = (fulfilled[0] as PromiseFulfilledResult<any>).value.claimedByUserId;
      const orderInDb = await fetchOrder(orderId);
      expect(orderInDb.status).toBe("CONFIRMED");
      expect(Number(orderInDb.claimedByUserId)).toBe(winnerUserId);
    }
  });

  // =========================================================================
  // 3. REJECTION OF CLAIMING SHIPPED ORDERS (400 BAD_REQUEST)
  // =========================================================================
  it("Stress Test 3: Claiming a SHIPPED order must immediately reject with 400 BAD_REQUEST", async () => {
    const shippedOrderId = await seedTestOrder("SHIPPED");

    await expect(
      claimOnlineOrder({ id: shippedOrderId, scopedBranchId: null }, { userId: 2, role: "user" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    // In-depth error check: verify reason states order is already shipped
    try {
      await claimOnlineOrder({ id: shippedOrderId, scopedBranchId: null }, { userId: 2, role: "user" });
      expect.fail("Expected claimOnlineOrder on SHIPPED order to throw");
    } catch (err: any) {
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toContain("تم شحن الطلب وتسليمه للمندوب بالفعل");
    }

    // Verify DB immutability: status remains SHIPPED, claimedByUserId remains null
    const order = await fetchOrder(shippedOrderId);
    expect(order.status).toBe("SHIPPED");
    expect(order.claimedByUserId).toBeNull();
  });

  // =========================================================================
  // 4. REJECTION OF CLAIMING OTHER TERMINAL STATES (CANCELLED, DELIVERED)
  // =========================================================================
  it("Stress Test 4: Claiming CANCELLED or DELIVERED orders must reject with 400 BAD_REQUEST", async () => {
    const cancelledId = await seedTestOrder("CANCELLED");
    await expect(
      claimOnlineOrder({ id: cancelledId, scopedBranchId: null }, { userId: 2, role: "user" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    const deliveredId = await seedTestOrder("DELIVERED");
    await expect(
      claimOnlineOrder({ id: deliveredId, scopedBranchId: null }, { userId: 2, role: "user" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  // =========================================================================
  // 5. MARK ONLINE ORDER PREPARED IDEMPOTENCY & TIMESTAMP IMMUTABILITY
  // =========================================================================
  it("Stress Test 5: markOnlineOrderPrepared idempotency — repeated calls preserve original preparedAt", async () => {
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
    const orderId = await seedTestOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: twentyMinsAgo,
    });

    // First call: initial preparation
    const firstCall = await markOnlineOrderPrepared(
      { id: orderId, scopedBranchId: null },
      { userId: 2, role: "user" }
    );

    expect(firstCall.success).toBe(true);
    expect(firstCall.idempotent).toBe(false);
    expect(firstCall.status).toBe("PROCESSING");
    expect(firstCall.durationMinutes).toBe(20);
    expect(firstCall.preparedByUserId).toBe(2);

    const orderAfterFirst = await fetchOrder(orderId);
    expect(orderAfterFirst.status).toBe("PROCESSING");
    expect(orderAfterFirst.preparedAt).not.toBeNull();
    const originalPreparedAtMs = new Date(orderAfterFirst.preparedAt!).getTime();

    // Small delay to verify that clock progression does NOT overwrite preparedAt
    await new Promise((r) => setTimeout(r, 50));

    // Second call: same worker calls markOnlineOrderPrepared again
    const secondCall = await markOnlineOrderPrepared(
      { id: orderId, scopedBranchId: null },
      { userId: 2, role: "user" }
    );

    expect(secondCall.success).toBe(true);
    expect(secondCall.idempotent).toBe(true);
    expect(secondCall.durationMinutes).toBe(20);

    const orderAfterSecond = await fetchOrder(orderId);
    const secondPreparedAtMs = new Date(orderAfterSecond.preparedAt!).getTime();

    // VERIFY CRITICAL INVARIANT: preparedAt must NOT be modified
    expect(secondPreparedAtMs).toBe(originalPreparedAtMs);
    expect(orderAfterSecond.fulfillmentDurationMinutes).toBe(20);
    expect(Number(orderAfterSecond.preparedByUserId)).toBe(2);

    // Third call: manager calls markOnlineOrderPrepared on already-prepared order
    const managerCall = await markOnlineOrderPrepared(
      { id: orderId, scopedBranchId: null },
      { userId: 4, role: "manager" }
    );

    expect(managerCall.success).toBe(true);
    expect(managerCall.idempotent).toBe(true);
    expect(managerCall.durationMinutes).toBe(20);

    const orderAfterManager = await fetchOrder(orderId);
    expect(new Date(orderAfterManager.preparedAt!).getTime()).toBe(originalPreparedAtMs);
    expect(Number(orderAfterManager.preparedByUserId)).toBe(2);
  });

  // =========================================================================
  // 6. CONCURRENT markOnlineOrderPrepared RACE HARNESS
  // =========================================================================
  it("Stress Test 6: Concurrent markOnlineOrderPrepared calls serialize cleanly with 1 primary write and idempotent completions", async () => {
    const orderId = await seedTestOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    // 5 concurrent calls from worker 2 hitting markOnlineOrderPrepared
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        markOnlineOrderPrepared({ id: orderId, scopedBranchId: null }, { userId: 2, role: "user" })
      )
    );

    // All must succeed
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.durationMinutes).toBe(10);
    }

    // Exactly one should be the original writer (idempotent: false) and 4 idempotent
    const initialWrites = results.filter((r) => r.idempotent === false);
    const idempotentReturns = results.filter((r) => r.idempotent === true);

    expect(initialWrites).toHaveLength(1);
    expect(idempotentReturns).toHaveLength(4);

    const order = await fetchOrder(orderId);
    expect(order.status).toBe("PROCESSING");
    expect(Number(order.preparedByUserId)).toBe(2);
    expect(order.fulfillmentDurationMinutes).toBe(10);
  });

  // =========================================================================
  // 7. ILLEGAL TRANSITIONS ON markOnlineOrderPrepared
  // =========================================================================
  it("Stress Test 7: markOnlineOrderPrepared rejects SHIPPED, DELIVERED, CANCELLED, and PENDING orders (400 BAD_REQUEST)", async () => {
    const shippedId = await seedTestOrder("SHIPPED");
    await expect(
      markOnlineOrderPrepared({ id: shippedId, scopedBranchId: null }, { userId: 2, role: "user" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const deliveredId = await seedTestOrder("DELIVERED");
    await expect(
      markOnlineOrderPrepared({ id: deliveredId, scopedBranchId: null }, { userId: 2, role: "user" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const cancelledId = await seedTestOrder("CANCELLED");
    await expect(
      markOnlineOrderPrepared({ id: cancelledId, scopedBranchId: null }, { userId: 2, role: "user" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Unconfirmed PENDING order cannot be marked prepared directly
    const pendingId = await seedTestOrder("PENDING");
    await expect(
      markOnlineOrderPrepared({ id: pendingId, scopedBranchId: null }, { userId: 2, role: "user" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // =========================================================================
  // 8. RIVAL STAFF CONFLICT ON markOnlineOrderPrepared
  // =========================================================================
  it("Stress Test 8: Non-elevated staff attempting to mark another worker's order as prepared rejects with 409 CONFLICT", async () => {
    const orderId = await seedTestOrder("CONFIRMED", {
      claimedByUserId: 2,
      claimedAt: new Date(),
    });

    // Staff 3 (regular user) tries to prepare Staff 2's claimed order
    await expect(
      markOnlineOrderPrepared({ id: orderId, scopedBranchId: null }, { userId: 3, role: "user" })
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const order = await fetchOrder(orderId);
    expect(order.preparedByUserId).toBeNull();
    expect(order.preparedAt).toBeNull();
  });
});
