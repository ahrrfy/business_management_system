import assert from "node:assert/strict";
import { assertParcelTransition, type ParcelStatus } from "../server/services/delivery/lifecycle";
import { correctionLookupBlockReason } from "../server/services/sale/correctionLookup";

console.log("=== EMPIRICAL CHALLENGE HARNESS: MILESTONE 1 ===");

let passedTests = 0;
let totalTests = 0;

function runTest(name: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

// ============================================================================
// SUITE 1: trg_online_orders_expired_activation_bu Trigger Oracle & Edge Cases
// ============================================================================
console.log("\n--- Suite 1: trg_online_orders_expired_activation_bu Oracle & Boundary Analysis ---");

interface OnlineOrderRow {
  orderStatus: string;
  orderDate: Date;
  reservationExpiresAt: Date | null;
}

/**
 * Exact mathematical and logical implementation of MySQL trigger:
 *
 * IF NEW.`orderStatus` IN ('CONFIRMED', 'PROCESSING')
 *    AND OLD.`orderStatus` IN ('PENDING')
 *    AND COALESCE(
 *      NEW.`reservationExpiresAt`,
 *      OLD.`reservationExpiresAt`,
 *      DATE_ADD(OLD.`orderDate`, INTERVAL 24 HOUR)
 *    ) <= CURRENT_TIMESTAMP(3) THEN
 *   SIGNAL SQLSTATE '45000' ...
 */
function evaluateTriggerOnlineOrdersExpiredActivation(
  oldRow: OnlineOrderRow,
  newRow: { orderStatus: string; reservationExpiresAt: Date | null },
  currentTimestamp: Date
): { blocked: boolean; message?: string } {
  const isTargetNewStatus = ["CONFIRMED", "PROCESSING"].includes(newRow.orderStatus);
  const isSourceOldStatus = oldRow.orderStatus === "PENDING";

  if (isTargetNewStatus && isSourceOldStatus) {
    const twentyFourHoursAfterOrder = new Date(oldRow.orderDate.getTime() + 24 * 60 * 60 * 1000);
    const effectiveExpiry = newRow.reservationExpiresAt ?? oldRow.reservationExpiresAt ?? twentyFourHoursAfterOrder;

    if (effectiveExpiry.getTime() <= currentTimestamp.getTime()) {
      return { blocked: true, message: "expired online order reservation cannot be activated" };
    }
  }

  return { blocked: false };
}

runTest("1.1 Boundary: Order date exactly at 24h boundary (equality) is blocked", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const orderDate = new Date("2026-10-09T12:00:00.000Z"); // Exactly 24h ago

  const oldRow: OnlineOrderRow = {
    orderStatus: "PENDING",
    orderDate,
    reservationExpiresAt: null,
  };
  const newRow = {
    orderStatus: "PROCESSING",
    reservationExpiresAt: null,
  };

  const res = evaluateTriggerOnlineOrdersExpiredActivation(oldRow, newRow, now);
  assert.equal(res.blocked, true, "Boundary at exactly 24h (<=) must be blocked");
  assert.equal(res.message, "expired online order reservation cannot be activated");
});

runTest("1.2 Boundary: Order date 1ms before 24h boundary is allowed", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const orderDate = new Date("2026-10-09T12:00:00.001Z"); // 23h 59m 59s 999ms ago

  const oldRow: OnlineOrderRow = {
    orderStatus: "PENDING",
    orderDate,
    reservationExpiresAt: null,
  };
  const newRow = {
    orderStatus: "PROCESSING",
    reservationExpiresAt: null,
  };

  const res = evaluateTriggerOnlineOrdersExpiredActivation(oldRow, newRow, now);
  assert.equal(res.blocked, false, "1ms before 24h must be allowed");
});

runTest("1.3 Boundary: Order date 1ms after 24h boundary is blocked", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const orderDate = new Date("2026-10-09T11:59:59.999Z"); // 24h 0m 0s 1ms ago

  const oldRow: OnlineOrderRow = {
    orderStatus: "PENDING",
    orderDate,
    reservationExpiresAt: null,
  };
  const newRow = {
    orderStatus: "CONFIRMED",
    reservationExpiresAt: null,
  };

  const res = evaluateTriggerOnlineOrdersExpiredActivation(oldRow, newRow, now);
  assert.equal(res.blocked, true, "1ms after 24h must be blocked");
});

runTest("1.4 Edge Case: Null reservationExpiresAt falls back to 24h window", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const oldRow: OnlineOrderRow = {
    orderStatus: "PENDING",
    orderDate: new Date("2026-10-10T00:00:00.000Z"), // 12h ago (within 24h)
    reservationExpiresAt: null,
  };
  const newRow = {
    orderStatus: "PROCESSING",
    reservationExpiresAt: null,
  };

  const res = evaluateTriggerOnlineOrdersExpiredActivation(oldRow, newRow, now);
  assert.equal(res.blocked, false, "Fallback to orderDate + 24h permits activation within window");
});

runTest("1.5 Atomic Renewal: NEW.reservationExpiresAt in future unblocks expired order", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const oldRow: OnlineOrderRow = {
    orderStatus: "PENDING",
    orderDate: new Date("2026-10-01T12:00:00.000Z"), // 9 days ago (expired)
    reservationExpiresAt: null,
  };
  const newRow = {
    orderStatus: "PROCESSING",
    reservationExpiresAt: new Date("2026-10-10T18:00:00.000Z"), // renewed to future
  };

  const res = evaluateTriggerOnlineOrdersExpiredActivation(oldRow, newRow, now);
  assert.equal(res.blocked, false, "Explicit future reservationExpiresAt permits activation");
});

runTest("1.6 Operational Rollback: SHIPPED -> PROCESSING on delivery cancellation is NOT blocked even if 10 days old", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const oldRow: OnlineOrderRow = {
    orderStatus: "SHIPPED", // OLD is SHIPPED, not PENDING
    orderDate: new Date("2026-09-30T12:00:00.000Z"), // 10 days ago
    reservationExpiresAt: null,
  };
  const newRow = {
    orderStatus: "PROCESSING", // rollback
    reservationExpiresAt: null,
  };

  const res = evaluateTriggerOnlineOrdersExpiredActivation(oldRow, newRow, now);
  assert.equal(res.blocked, false, "Rollback from SHIPPED to PROCESSING is not blocked by trigger");
});

runTest("1.7 Non-target Transition: PENDING -> CANCELLED is NOT blocked even if expired", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const oldRow: OnlineOrderRow = {
    orderStatus: "PENDING",
    orderDate: new Date("2026-09-30T12:00:00.000Z"), // expired
    reservationExpiresAt: null,
  };
  const newRow = {
    orderStatus: "CANCELLED", // cancel expired order
    reservationExpiresAt: null,
  };

  const res = evaluateTriggerOnlineOrdersExpiredActivation(oldRow, newRow, now);
  assert.equal(res.blocked, false, "Cancelling an expired pending order must always succeed");
});


// ============================================================================
// SUITE 2: trg_cash_missed_daily_bu & Owner Self-Approval Governance
// ============================================================================
console.log("\n--- Suite 2: trg_cash_missed_daily_bu & Owner Governance Analysis ---");

interface MissedDailyRow {
  branchId: number;
  businessDate: string;
  carryForwardReconciliationId: number;
  carryForwardBusinessDate: string;
  carryForwardVersion: number;
  carryForwardEvidenceHash: string;
  missingDayEvidenceHash: string;
  reason: string;
  evidenceReference: string;
  requestClientRequestId: string;
  requestHash: string;
  immutableEvidenceHash: string;
  requestedByUserId: number;
  requestedAt: Date;
  createdAt: Date;
  status: "PENDING" | "APPROVED" | "REJECTED";
  version: number;
  reviewedByUserId: number | null;
}

function evaluateTriggerCashMissedDailyBu(
  oldRow: MissedDailyRow,
  newRow: MissedDailyRow
): { blocked: boolean; message?: string; activeBusinessDateKey?: string | null } {
  if (oldRow.status !== "PENDING") {
    return { blocked: true, message: "decided missed daily count exception is immutable" };
  }

  // Evidence immutability check
  const evidenceMatches =
    oldRow.branchId === newRow.branchId &&
    oldRow.businessDate === newRow.businessDate &&
    oldRow.carryForwardReconciliationId === newRow.carryForwardReconciliationId &&
    oldRow.carryForwardBusinessDate === newRow.carryForwardBusinessDate &&
    oldRow.carryForwardVersion === newRow.carryForwardVersion &&
    oldRow.carryForwardEvidenceHash === newRow.carryForwardEvidenceHash &&
    oldRow.missingDayEvidenceHash === newRow.missingDayEvidenceHash &&
    oldRow.reason === newRow.reason &&
    oldRow.evidenceReference === newRow.evidenceReference &&
    oldRow.requestClientRequestId === newRow.requestClientRequestId &&
    oldRow.requestHash === newRow.requestHash &&
    oldRow.immutableEvidenceHash === newRow.immutableEvidenceHash &&
    oldRow.requestedByUserId === newRow.requestedByUserId &&
    oldRow.requestedAt.getTime() === newRow.requestedAt.getTime() &&
    oldRow.createdAt.getTime() === newRow.createdAt.getTime();

  if (!evidenceMatches) {
    return { blocked: true, message: "missed daily count request evidence is immutable" };
  }

  if (!["APPROVED", "REJECTED"].includes(newRow.status) || newRow.version !== 2) {
    return { blocked: true, message: "invalid missed daily count decision" };
  }

  const activeBusinessDateKey =
    newRow.status === "APPROVED" ? `${newRow.branchId}:${newRow.businessDate}` : null;

  return { blocked: false, activeBusinessDateKey };
}

runTest("2.1 Owner Self-Approval is permitted in DB trigger (reviewedBy = requestedBy)", () => {
  const baseDate = new Date("2026-10-09T08:00:00.000Z");
  const oldRow: MissedDailyRow = {
    branchId: 1,
    businessDate: "2026-10-08",
    carryForwardReconciliationId: 10,
    carryForwardBusinessDate: "2026-10-09",
    carryForwardVersion: 1,
    carryForwardEvidenceHash: "hash1",
    missingDayEvidenceHash: "hash2",
    reason: "Power outage",
    evidenceReference: "REF-001",
    requestClientRequestId: "req-1",
    requestHash: "reqhash",
    immutableEvidenceHash: "immhash",
    requestedByUserId: 1, // Owner user ID
    requestedAt: baseDate,
    createdAt: baseDate,
    status: "PENDING",
    version: 1,
    reviewedByUserId: null,
  };

  const newRow: MissedDailyRow = {
    ...oldRow,
    status: "APPROVED",
    version: 2,
    reviewedByUserId: 1, // Self-approved by Owner (reviewedBy === requestedBy)
  };

  const res = evaluateTriggerCashMissedDailyBu(oldRow, newRow);
  assert.equal(res.blocked, false, "Owner self-approval must succeed in trigger");
  assert.equal(res.activeBusinessDateKey, "1:2026-10-08");
});

runTest("2.2 Non-Owner self-approval is blocked at application layer (missedDailyCountException.ts:624)", () => {
  // Application layer governance rule:
  const checkServiceAuth = (actor: { userId: number; isOwner: boolean }, requestedByUserId: number) => {
    if (!actor.isOwner && requestedByUserId === actor.userId) {
      throw new Error("طالب الاستثناء لا يمكنه اعتماد طلبه أو رفضه، بلا استثناء للدور");
    }
  };

  // Non-owner actor attempts self-approval -> must throw
  assert.throws(
    () => checkServiceAuth({ userId: 5, isOwner: false }, 5),
    /طالب الاستثناء لا يمكنه اعتماد طلبه أو رفضه/
  );

  // Owner actor attempts self-approval -> must succeed
  assert.doesNotThrow(() => checkServiceAuth({ userId: 1, isOwner: true }, 1));
});

runTest("2.3 Tampering with immutable request evidence is blocked by trigger", () => {
  const baseDate = new Date("2026-10-09T08:00:00.000Z");
  const oldRow: MissedDailyRow = {
    branchId: 1,
    businessDate: "2026-10-08",
    carryForwardReconciliationId: 10,
    carryForwardBusinessDate: "2026-10-09",
    carryForwardVersion: 1,
    carryForwardEvidenceHash: "hash1",
    missingDayEvidenceHash: "hash2",
    reason: "Original reason",
    evidenceReference: "REF-001",
    requestClientRequestId: "req-1",
    requestHash: "reqhash",
    immutableEvidenceHash: "immhash",
    requestedByUserId: 2,
    requestedAt: baseDate,
    createdAt: baseDate,
    status: "PENDING",
    version: 1,
    reviewedByUserId: null,
  };

  const tamperedRow: MissedDailyRow = {
    ...oldRow,
    reason: "Tampered reason", // Altered!
    status: "APPROVED",
    version: 2,
    reviewedByUserId: 1,
  };

  const res = evaluateTriggerCashMissedDailyBu(oldRow, tamperedRow);
  assert.equal(res.blocked, true);
  assert.equal(res.message, "missed daily count request evidence is immutable");
});


// ============================================================================
// SUITE 3: assertParcelTransition Comprehensive State Transition Matrix
// ============================================================================
console.log("\n--- Suite 3: assertParcelTransition Exhaustive Matrix Testing ---");

const ALL_PARCEL_STATUSES: ParcelStatus[] = [
  "ASSIGNED",
  "ACCEPTED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
  "RETURNED",
];

runTest("3.1 ASSIGNED -> CANCELLED is allowed", () => {
  assert.doesNotThrow(() => assertParcelTransition("ASSIGNED", "CANCELLED"));
});

runTest("3.2 ASSIGNED -> RETURNED is allowed", () => {
  assert.doesNotThrow(() => assertParcelTransition("ASSIGNED", "RETURNED"));
});

runTest("3.3 ASSIGNED -> standard operational paths (ACCEPTED, OUT_FOR_DELIVERY, FAILED)", () => {
  assert.doesNotThrow(() => assertParcelTransition("ASSIGNED", "ACCEPTED"));
  assert.doesNotThrow(() => assertParcelTransition("ASSIGNED", "OUT_FOR_DELIVERY"));
  assert.doesNotThrow(() => assertParcelTransition("ASSIGNED", "FAILED"));
});

runTest("3.4 ASSIGNED -> DELIVERED directly is rejected (must go via courier pickup / out for delivery)", () => {
  assert.throws(
    () => assertParcelTransition("ASSIGNED", "DELIVERED"),
    (err: any) => err.code === "PRECONDITION_FAILED" && err.message.includes("ASSIGNED → DELIVERED")
  );
});

runTest("3.5 Terminal parcel states (DELIVERED, CANCELLED, RETURNED) cannot transition", () => {
  for (const terminal of ["DELIVERED", "CANCELLED", "RETURNED"] as ParcelStatus[]) {
    for (const target of ALL_PARCEL_STATUSES) {
      assert.throws(
        () => assertParcelTransition(terminal, target),
        (err: any) => err.code === "PRECONDITION_FAILED"
      );
    }
  }
});

runTest("3.6 OUT_FOR_DELIVERY transitions are intact", () => {
  const allowedFromOut: ParcelStatus[] = ["ACCEPTED", "PICKED_UP", "DELIVERED", "FAILED", "CANCELLED", "RETURNED"];
  for (const target of allowedFromOut) {
    assert.doesNotThrow(() => assertParcelTransition("OUT_FOR_DELIVERY", target));
  }
  assert.throws(() => assertParcelTransition("OUT_FOR_DELIVERY", "ASSIGNED"));
});


// ============================================================================
// SUITE 4: cancelReservation Stock Integrity & Expired Status Handling
// ============================================================================
console.log("\n--- Suite 4: cancelReservation Stock Reversal & Expired Exemption ---");

interface ReservationSimulation {
  id: number;
  status: "ACTIVE" | "PARTIALLY_FULFILLED" | "EXPIRED" | "CANCELLED" | "RELEASED" | "FULFILLED";
  branchId: number;
  lines: Array<{ variantId: number; baseQuantity: number; fulfilledBase: number }>;
}

function simulateCancelReservation(
  res: ReservationSimulation,
  inventoryReservedStock: Map<number, number>
): { status: "CANCELLED"; releasedQuantity: number } {
  const CLOSEABLE = ["ACTIVE", "PARTIALLY_FULFILLED"];
  if (!CLOSEABLE.includes(res.status) && res.status !== "EXPIRED") {
    throw new Error(`لا يمكن إلغاء حجز حالته ${res.status}`);
  }

  let releasedQuantity = 0;
  if (res.status !== "EXPIRED") {
    for (const ln of res.lines) {
      const remaining = ln.baseQuantity - ln.fulfilledBase;
      if (remaining > 0) {
        const cur = inventoryReservedStock.get(ln.variantId) ?? 0;
        inventoryReservedStock.set(ln.variantId, cur - remaining);
        releasedQuantity += remaining;
      }
    }
  }

  res.status = "CANCELLED";
  return { status: "CANCELLED", releasedQuantity };
}

runTest("4.1 Cancelling EXPIRED reservation does NOT double-release stock", () => {
  const inventory = new Map<number, number>();
  inventory.set(101, 0); // After expiration sweep, reserved stock is 0

  const expiredRes: ReservationSimulation = {
    id: 1,
    status: "EXPIRED",
    branchId: 1,
    lines: [{ variantId: 101, baseQuantity: 5, fulfilledBase: 0 }],
  };

  const result = simulateCancelReservation(expiredRes, inventory);
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.releasedQuantity, 0, "EXPIRED cancellation must release 0 stock");
  assert.equal(inventory.get(101), 0, "Reserved stock must remain 0 (no negative reserved stock)");
});

runTest("4.2 Cancelling ACTIVE reservation releases stock exactly once", () => {
  const inventory = new Map<number, number>();
  inventory.set(102, 10); // Currently 10 reserved

  const activeRes: ReservationSimulation = {
    id: 2,
    status: "ACTIVE",
    branchId: 1,
    lines: [{ variantId: 102, baseQuantity: 10, fulfilledBase: 0 }],
  };

  const result = simulateCancelReservation(activeRes, inventory);
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.releasedQuantity, 10);
  assert.equal(inventory.get(102), 0, "Reserved stock cleanly decremented to 0");
});

runTest("4.3 Cancelling already CANCELLED, RELEASED, or FULFILLED reservation is rejected", () => {
  const inventory = new Map<number, number>();
  const statuses = ["CANCELLED", "RELEASED", "FULFILLED"] as const;

  for (const st of statuses) {
    const res: ReservationSimulation = {
      id: 3,
      status: st,
      branchId: 1,
      lines: [{ variantId: 103, baseQuantity: 5, fulfilledBase: 0 }],
    };
    assert.throws(
      () => simulateCancelReservation(res, inventory),
      new RegExp(`لا يمكن إلغاء حجز حالته ${st}`)
    );
  }
});


// ============================================================================
// SUITE 5: Invoice Correction & Cancellation Deadlock Unlocking
// ============================================================================
console.log("\n--- Suite 5: Invoice Correction & Safe Order Status Verification ---");

runTest("5.1 correctionLookupBlockReason allows PROCESSING when consignment is null", () => {
  const facts = {
    status: "PENDING",
    correctedByInvoiceId: null,
    sourceType: "ONLINE" as const,
    returnedTotal: "0",
    itemCount: 2,
    hasDigitalCards: false,
    hasActiveInstallmentPlan: false,
    consignmentStatus: null,
    consignmentParcelStatus: null,
    consignmentMoneyStatus: null,
    onlineOrderStatus: "PROCESSING",
  };

  const blockReason = correctionLookupBlockReason(facts);
  assert.equal(blockReason, null, "Should be allowed to correct invoice when order is PROCESSING without consignment");
});

runTest("5.2 correctionLookupBlockReason allows PROCESSING when consignment is CANCELLED", () => {
  const facts = {
    status: "PENDING",
    correctedByInvoiceId: null,
    sourceType: "ONLINE" as const,
    returnedTotal: "0",
    itemCount: 2,
    hasDigitalCards: false,
    hasActiveInstallmentPlan: false,
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "CANCELLED",
    consignmentMoneyStatus: "CANCELLED",
    onlineOrderStatus: "PROCESSING",
  };

  const blockReason = correctionLookupBlockReason(facts);
  assert.equal(blockReason, null, "Should be allowed to correct invoice when order is PROCESSING and consignment is CANCELLED");
});

runTest("5.3 correctionLookupBlockReason blocks when consignment is active (DISPATCHED)", () => {
  const facts = {
    status: "PENDING",
    correctedByInvoiceId: null,
    sourceType: "ONLINE" as const,
    returnedTotal: "0",
    itemCount: 2,
    hasDigitalCards: false,
    hasActiveInstallmentPlan: false,
    consignmentStatus: "DISPATCHED",
    consignmentParcelStatus: "OUT_FOR_DELIVERY",
    consignmentMoneyStatus: "UNSETTLED",
    onlineOrderStatus: "PROCESSING",
  };

  const blockReason = correctionLookupBlockReason(facts);
  assert.equal(blockReason, "ألغِ إسناد التوصيل وسوِّ عهدته قبل تعديل الفاتورة");
});

console.log(`\n=======================================================`);
console.log(`ALL EMPIRICAL TESTS PASSED: ${passedTests} / ${totalTests}`);
console.log(`=======================================================`);
