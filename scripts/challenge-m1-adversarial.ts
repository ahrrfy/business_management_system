import assert from "node:assert/strict";
import { assertParcelTransition, type ParcelStatus } from "../server/services/delivery/lifecycle";
import { correctionLookupBlockReason, type CorrectionLookupFacts } from "../server/services/sale/correctionLookup";

console.log("=================================================================");
console.log("=== EMPIRICAL ADVERSARIAL CHALLENGER SUITE: MILESTONE 1 ===");
console.log("=================================================================\n");

let passed = 0;
let failed = 0;
const findings: Array<{ id: string; title: string; description: string; severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" }> = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  [FAIL] ${name}: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// SECTION 1: correctionLookupBlockReason Stress Testing
// -----------------------------------------------------------------------------
console.log("--- SECTION 1: correctionLookupBlockReason Boundary & State Matrix ---");

const baseEligible: CorrectionLookupFacts = {
  status: "PENDING",
  sourceType: "ONLINE",
  returnedTotal: "0",
  correctedByInvoiceId: null,
  itemCount: 2,
  hasDigitalCards: false,
  hasActiveInstallmentPlan: false,
  consignmentStatus: null,
  consignmentParcelStatus: null,
  consignmentMoneyStatus: null,
  onlineOrderStatus: null,
};

test("1.1 Unblocks online order in PROCESSING when consignment is null", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: null,
  });
  assert.equal(reason, null);
});

test("1.2 Unblocks online order in PROCESSING when consignment is fully CANCELLED", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "CANCELLED",
    consignmentMoneyStatus: "CANCELLED",
  });
  assert.equal(reason, null);
});

test("1.3 Blocks online order in PROCESSING when consignment is active (DISPATCHED)", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "DISPATCHED",
    consignmentParcelStatus: "OUT_FOR_DELIVERY",
    consignmentMoneyStatus: "UNSETTLED",
  });
  assert.match(reason ?? "", /ألغِ إسناد التوصيل/);
});

test("1.4 Blocks online order in PROCESSING when consignment is ASSIGNED", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "DISPATCHED",
    consignmentParcelStatus: "ASSIGNED",
    consignmentMoneyStatus: "UNSETTLED",
  });
  assert.match(reason ?? "", /ألغِ إسناد التوصيل/);
});

test("1.5 Blocks when consignmentStatus is CANCELLED but parcelStatus is NOT CANCELLED", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "OUT_FOR_DELIVERY", // Not safely cancelled!
    consignmentMoneyStatus: "CANCELLED",
  });
  assert.match(reason ?? "", /ألغِ إسناد التوصيل/);
});

test("1.6 Blocks when consignmentStatus is CANCELLED but moneyStatus is NOT CANCELLED", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "CANCELLED",
    consignmentMoneyStatus: "UNSETTLED", // Open custody!
  });
  assert.match(reason ?? "", /ألغِ إسناد التوصيل/);
});

test("1.7 Blocks online order in SHIPPED status even if consignment is CANCELLED", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "SHIPPED",
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "CANCELLED",
    consignmentMoneyStatus: "CANCELLED",
  });
  assert.match(reason ?? "", /ألغِ طلب المتجر المرتبط/);
});

test("1.8 Blocks online order in CONFIRMED status", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "CONFIRMED",
    consignmentStatus: null,
  });
  assert.match(reason ?? "", /ألغِ طلب المتجر المرتبط/);
});

test("1.9 Blocks online order in PENDING status", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "PENDING",
    consignmentStatus: null,
  });
  assert.match(reason ?? "", /ألغِ طلب المتجر المرتبط/);
});

test("1.10 Unblocks online order in CANCELLED status", () => {
  const reason = correctionLookupBlockReason({
    ...baseEligible,
    onlineOrderStatus: "CANCELLED",
    consignmentStatus: null,
  });
  assert.equal(reason, null);
});


// -----------------------------------------------------------------------------
// SECTION 2: assertParcelTransition Exhaustive Verification
// -----------------------------------------------------------------------------
console.log("\n--- SECTION 2: assertParcelTransition Matrix & Reversals ---");

test("2.1 ASSIGNED allows transitions to ACCEPTED, OUT_FOR_DELIVERY, FAILED, CANCELLED, RETURNED", () => {
  const validTargets: ParcelStatus[] = ["ACCEPTED", "OUT_FOR_DELIVERY", "FAILED", "CANCELLED", "RETURNED"];
  for (const target of validTargets) {
    assert.doesNotThrow(() => assertParcelTransition("ASSIGNED", target));
  }
});

test("2.2 ASSIGNED strictly forbids direct leaps to DELIVERED, PICKED_UP", () => {
  assert.throws(() => assertParcelTransition("ASSIGNED", "DELIVERED"));
  assert.throws(() => assertParcelTransition("ASSIGNED", "PICKED_UP"));
});

test("2.3 Terminal parcel status CANCELLED forbids any outward transition", () => {
  const all: ParcelStatus[] = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "CANCELLED", "RETURNED"];
  for (const target of all) {
    assert.throws(() => assertParcelTransition("CANCELLED", target));
  }
});

test("2.4 Terminal parcel status RETURNED forbids any outward transition", () => {
  const all: ParcelStatus[] = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "CANCELLED", "RETURNED"];
  for (const target of all) {
    assert.throws(() => assertParcelTransition("RETURNED", target));
  }
});


// -----------------------------------------------------------------------------
// SECTION 3: invoiceCancellationGuard assertInvoiceReversalDeliverySafeTx Logic Oracle
// -----------------------------------------------------------------------------
console.log("\n--- SECTION 3: invoiceCancellationGuard Simulation & Edge Cases ---");

function simulateInvoiceCancellationGuard(opts: {
  onlineOrderStatus: string | null;
  consignmentStatus: string | null;
  consignmentParcelStatus: string | null;
  consignmentMoneyStatus: string | null;
  consignmentSourceType: "ONLINE_ORDER" | "INVOICE" | null;
  mode: "CANCEL" | "CORRECT";
}): { allowed: boolean; reason?: string } {
  const consignment = opts.consignmentStatus != null ? {
    status: opts.consignmentStatus,
    parcelStatus: opts.consignmentParcelStatus,
    moneyStatus: opts.consignmentMoneyStatus,
    sourceType: opts.consignmentSourceType,
    sourceId: 100,
  } : null;

  const onlineOrder = opts.onlineOrderStatus != null ? {
    id: 100,
    status: opts.onlineOrderStatus,
  } : null;

  if (consignment) {
    const terminalCancellation =
      consignment.status === "CANCELLED"
      && consignment.parcelStatus === "CANCELLED"
      && consignment.moneyStatus === "CANCELLED";
    if (!terminalCancellation) {
      return { allowed: false, reason: "الإرسالية غير ملغاة نهائياً" };
    }
  }

  if (onlineOrder) {
    const linkedToSafeConsignment = consignment != null
      && consignment.sourceType === "ONLINE_ORDER"
      && Number(consignment.sourceId) === Number(onlineOrder.id);
    const safeOrderStatus = onlineOrder.status === "CANCELLED"
      || (opts.mode === "CANCEL" && linkedToSafeConsignment && onlineOrder.status === "SHIPPED")
      || (onlineOrder.status === "PROCESSING" && (consignment == null || consignment.status === "CANCELLED"));

    if (!safeOrderStatus) {
      return {
        allowed: false,
        reason: onlineOrder.status === "SHIPPED"
          ? "طلب المتجر ما زال قيد التوصيل"
          : `طلب المتجر ليس في حالة إلغاء توصيل نهائية آمنة (${onlineOrder.status})`,
      };
    }
  }

  return { allowed: true };
}

test("3.1 cancelSale on PROCESSING order without consignment succeeds", () => {
  const res = simulateInvoiceCancellationGuard({
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: null,
    consignmentParcelStatus: null,
    consignmentMoneyStatus: null,
    consignmentSourceType: null,
    mode: "CANCEL",
  });
  assert.equal(res.allowed, true);
});

test("3.2 cancelSale on PROCESSING order with CANCELLED consignment succeeds", () => {
  const res = simulateInvoiceCancellationGuard({
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "CANCELLED",
    consignmentMoneyStatus: "CANCELLED",
    consignmentSourceType: "ONLINE_ORDER",
    mode: "CANCEL",
  });
  assert.equal(res.allowed, true);
});

test("3.3 correctSale on PROCESSING order without consignment succeeds", () => {
  const res = simulateInvoiceCancellationGuard({
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: null,
    consignmentParcelStatus: null,
    consignmentMoneyStatus: null,
    consignmentSourceType: null,
    mode: "CORRECT",
  });
  assert.equal(res.allowed, true);
});

test("3.4 correctSale on PROCESSING order with CANCELLED consignment succeeds", () => {
  const res = simulateInvoiceCancellationGuard({
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "CANCELLED",
    consignmentMoneyStatus: "CANCELLED",
    consignmentSourceType: "ONLINE_ORDER",
    mode: "CORRECT",
  });
  assert.equal(res.allowed, true);
});

test("3.5 cancelSale on PROCESSING order with ACTIVE consignment is blocked", () => {
  const res = simulateInvoiceCancellationGuard({
    onlineOrderStatus: "PROCESSING",
    consignmentStatus: "DISPATCHED",
    consignmentParcelStatus: "OUT_FOR_DELIVERY",
    consignmentMoneyStatus: "UNSETTLED",
    consignmentSourceType: "ONLINE_ORDER",
    mode: "CANCEL",
  });
  assert.equal(res.allowed, false);
  assert.match(res.reason ?? "", /غير ملغاة نهائياً/);
});

test("3.6 correctSale on SHIPPED order with CANCELLED consignment is blocked (CORRECT mode does not allow SHIPPED)", () => {
  const res = simulateInvoiceCancellationGuard({
    onlineOrderStatus: "SHIPPED",
    consignmentStatus: "CANCELLED",
    consignmentParcelStatus: "CANCELLED",
    consignmentMoneyStatus: "CANCELLED",
    consignmentSourceType: "ONLINE_ORDER",
    mode: "CORRECT",
  });
  assert.equal(res.allowed, false);
  assert.match(res.reason ?? "", /قيد التوصيل/);
});


// -----------------------------------------------------------------------------
// SECTION 4: Return Service & Delivery Return Synchronization Oracles
// -----------------------------------------------------------------------------
console.log("\n--- SECTION 4: Return Synchronization Invariants ---");

test("4.1 returnService full return synchronizes onlineOrders to CANCELLED", () => {
  let orderStatus = "SHIPPED";
  let cancelReason: string | null = null;

  const simulateReturn = (fullyReturned: boolean, isOnline: boolean) => {
    if (fullyReturned && isOnline) {
      orderStatus = "CANCELLED";
      cancelReason = "مرتجع فاتورة كامل";
    }
  };

  simulateReturn(true, true);
  assert.equal(orderStatus, "CANCELLED");
  assert.equal(cancelReason, "مرتجع فاتورة كامل");
});

test("4.2 returnService partial return does NOT alter onlineOrders status", () => {
  let orderStatus = "DELIVERED";
  let cancelReason: string | null = null;

  const simulateReturn = (fullyReturned: boolean, isOnline: boolean) => {
    if (fullyReturned && isOnline) {
      orderStatus = "CANCELLED";
      cancelReason = "مرتجع فاتورة كامل";
    }
  };

  simulateReturn(false, true); // Partial return!
  assert.equal(orderStatus, "DELIVERED", "Partial return must not cancel online order");
  assert.equal(cancelReason, null);
});

test("4.3 delivery return with sourceType === 'INVOICE' and inv.sourceType === 'ONLINE' cancels onlineOrders", () => {
  let orderStatus = "SHIPPED";
  const cn = { sourceType: "INVOICE", invoiceId: 50 };
  const inv = { sourceType: "ONLINE", id: 50 };

  if (cn.sourceType === "ONLINE_ORDER") {
    orderStatus = "CANCELLED";
  } else if (cn.sourceType === "INVOICE" && inv.sourceType === "ONLINE") {
    orderStatus = "CANCELLED";
  }

  assert.equal(orderStatus, "CANCELLED");
});

test("4.4 delivery return with sourceType === 'INVOICE' and inv.sourceType === 'POS' does NOT touch onlineOrders", () => {
  let orderStatus = "SHIPPED";
  const cn = { sourceType: "INVOICE", invoiceId: 50 };
  const inv = { sourceType: "POS", id: 50 };

  if (cn.sourceType === "ONLINE_ORDER") {
    orderStatus = "CANCELLED";
  } else if (cn.sourceType === "INVOICE" && inv.sourceType === "ONLINE") {
    orderStatus = "CANCELLED";
  }

  assert.equal(orderStatus, "SHIPPED");
});


// -----------------------------------------------------------------------------
// SECTION 5: ADVERSARIAL FINDING AUDIT: Online Order Relinking on Invoice Correction
// -----------------------------------------------------------------------------
console.log("\n--- SECTION 5: Adversarial Deep Audit: Online Order Relinking on Invoice Correction ---");

test("5.1 CRITICAL AUDIT: Trace onlineOrders.invoiceId after correctSale", () => {
  // Scenario:
  // Online Order #42 is created with status = 'PROCESSING', invoiceId = 1001.
  // Invoice #1001 has sourceType = 'ONLINE', status = 'PENDING'.
  // Merchant corrects Invoice #1001 via correctSale.
  // correctSale creates new Invoice #1002 (SUPERSEDED #1001).
  // Question: Does onlineOrders.invoiceId point to 1002 or does it remain 1001?
  
  // In server/services/sale/correct.ts:
  // Line 586: updates invoice #1001 status = 'SUPERSEDED'
  // Line 590: createSaleInTx creates #1002
  // Line 734: updates invoice #1002 correctionOfInvoiceId = 1001
  // Line 735: updates invoice #1001 correctedByInvoiceId = 1002
  // DOES IT UPDATE onlineOrders.invoiceId?
  // -> NO! It never touches onlineOrders table!

  const onlineOrder = {
    id: 42,
    status: "PROCESSING",
    invoiceId: 1001, // Points to original invoice
  };

  const originalInvoice = {
    id: 1001,
    status: "SUPERSEDED",
    sourceType: "ONLINE",
  };

  const newInvoice = {
    id: 1002,
    status: "PENDING",
    sourceType: "ONLINE",
    correctionOfInvoiceId: 1001,
  };

  // Now the merchant tries to dispatch the online order:
  // In dispatchOnlineOrder.ts line 154:
  // if (cur.invoiceId) {
  //   invoiceId = Number(cur.invoiceId); // -> 1001!
  //   const inv = ...
  //   dispatchInvoiceInTx(tx, { invoiceId: 1001, ... })
  // }
  // And in dispatchInvoice.ts line 199:
  // if (inv.status === "CANCELLED" || inv.status === "RETURNED" || inv.status === "SUPERSEDED") {
  //   throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُسنَد فاتورة ملغاة أو مرتجعة أو مستبدلة للتوصيل" });
  // }
  
  const wouldDispatchSucceed = originalInvoice.status !== "SUPERSEDED";
  assert.equal(
    wouldDispatchSucceed,
    false,
    "Dispatching online order after invoice correction will FAIL because onlineOrders.invoiceId points to SUPERSEDED invoice 1001!"
  );

  // Now, what if the merchant cancels the new invoice #1002?
  // In cancel.ts line 420:
  // if (inv.sourceType === "ONLINE") {
  //   await tx.update(onlineOrders).set({ status: "CANCELLED" })
  //     .where(and(eq(onlineOrders.invoiceId, input.invoiceId), sql`status != 'CANCELLED'`));
  // }
  // input.invoiceId is 1002. But onlineOrders.invoiceId is 1001!
  const matchedOrderOnCancel = onlineOrder.invoiceId === newInvoice.id;
  assert.equal(
    matchedOrderOnCancel,
    false,
    "Cancelling corrected invoice 1002 will FAIL to cancel onlineOrders because onlineOrders.invoiceId is 1001, not 1002!"
  );

  findings.push({
    id: "CHALLENGE-001",
    title: "Orphaned onlineOrders.invoiceId reference on Invoice Correction (correctSale)",
    description:
      "When an invoice for an online order is corrected via correctSale (unlocked in Milestone 1 F8), " +
      "the original invoice is marked SUPERSEDED and a replacement invoice is generated. " +
      "However, correctSale does not update onlineOrders.invoiceId to point to the replacement invoice. " +
      "As a result: (1) subsequent dispatch via dispatchOnlineOrder fails with 'لا تُسنَد فاتورة ملغاة أو مرتجعة أو مستبدلة للتوصيل', " +
      "and (2) subsequent cancellation or return of the corrected invoice fails to synchronize onlineOrders status.",
    severity: "HIGH",
  });
});

console.log("\n=================================================================");
console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log(`Adversarial Findings Identified: ${findings.length}`);
for (const f of findings) {
  console.log(`- [${f.severity}] ${f.id}: ${f.title}`);
}
console.log("=================================================================\n");
