import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSelect,
  readOnlySnapshot,
  effectiveCount,
  decisionLedgerExpectation,
  buildReview,
} from "./audit-stocktake-overlap.mjs";

const at = (hour) => `2026-10-21T${String(hour).padStart(2, "0")}:00:00.000Z`;
const count = (id, kind, qty, hour, extra = {}) => ({
  id,
  sessionId: 10,
  variantId: 7,
  kind,
  qty,
  countedAt: at(hour),
  ...extra,
});
function fixture(action = "ADJUST") {
  return {
    capturedAt: at(20),
    source: { capturedAtUtc: at(20) },
    firstCandidates: [
      {
        sessionId: 10,
        variantId: 7,
        branchId: 1,
        otherMovementId: 80,
        otherSessionId: 11,
      },
    ],
    sessions: [
      {
        id: 10,
        code: "CNT-10",
        branchId: 1,
        sessionType: "NORMAL",
        approvedAt: at(18),
      },
      { id: 11, code: "CNT-11", branchId: 1, approvedAt: at(15) },
    ],
    items: [
      {
        sessionId: 10,
        variantId: 7,
        branchId: 1,
        unitCost: "625.00",
        action,
        finalQty: 10,
        diffQty: -10,
        value: "-6250.00",
        isConsignment: 0,
        allowBackorder: 0,
      },
    ],
    counts: [count(1, "FIRST", 20, 12)],
    movements: [
      {
        id: 80,
        variantId: 7,
        branchId: 1,
        movementType: "ADJUST",
        referenceType: "STOCKTAKE",
        referenceId: 11,
        signedDelta: -10,
        createdAt: at(15),
      },
      ...(action === "ADJUST"
        ? [
            {
              id: 90,
              variantId: 7,
              branchId: 1,
              movementType: "ADJUST",
              referenceType: "STOCKTAKE",
              referenceId: 10,
              signedDelta: -10,
              createdAt: at(18),
            },
          ]
        : []),
    ],
    currentStock: [{ variantId: 7, branchId: 1, quantity: 0 }],
    laterMovements: [],
    entries:
      action === "ADJUST"
        ? [
            {
              id: 100,
              entryType: "ADJUST",
              dedupeKey: "STOCKTAKE:10:SHORT",
              cost: "6250.00",
              profit: "-6250.00",
              amount: "0.00",
              revenue: "0.00",
            },
          ]
        : [],
  };
}

test("SELECT gate rejects mutation, side-effect SELECTs and multiple statements", () => {
  assert.doesNotThrow(() =>
    assertSelect("SELECT id FROM stocktakeItems WHERE sessionId=?"),
  );
  for (const sql of [
    "UPDATE branchStock SET quantity=0",
    "SELECT 1; SELECT 2",
    "SELECT 1 INTO OUTFILE '/tmp/x'",
    "SELECT SLEEP(10)",
    "SELECT GET_LOCK('x',1)",
    "SELECT id FROM branchStock FOR UPDATE",
    "SELECT /* hidden */ 1",
  ])
    assert.throws(() => assertSelect(sql));
});
test("read-only snapshot bounds runtime and always rolls back", async () => {
  const calls = [];
  const connection = {
    query: async (q) => {
      calls.push(q);
      return [[{ id: 1 }]];
    },
    rollback: async () => calls.push("ROLLBACK"),
  };
  await assert.rejects(
    readOnlySnapshot(connection, async (select) => {
      await select("SELECT 1");
      await select("DELETE FROM branchStock");
    }),
  );
  assert.deepEqual(calls, [
    "SET SESSION MAX_EXECUTION_TIME=15000",
    "SET TRANSACTION READ ONLY",
    "START TRANSACTION WITH CONSISTENT SNAPSHOT",
    "SELECT 1",
    "ROLLBACK",
  ]);
});
test("effective RECOUNT supersedes FIRST and resolved VERIFY", () => {
  const result = effectiveCount([
    count(1, "FIRST", 20, 12),
    count(2, "VERIFY", 18, 13, { isConflict: 1, resolvedPick: "VERIFY" }),
    count(3, "RECOUNT", 9, 16),
  ]);
  assert.equal(result.used.id, 3);
  assert.deepEqual(result.supersededCountIds, [1, 2]);
  assert.equal(result.openConflict, false);
});
test("selected VERIFY and latest timestamp/id follow application contract", () => {
  assert.equal(
    effectiveCount([
      count(1, "FIRST", 20, 12),
      count(2, "VERIFY", 18, 13, { isConflict: 1, resolvedPick: "VERIFY" }),
    ]).used.id,
    2,
  );
  assert.equal(
    effectiveCount([count(3, "FIRST", 30, 12), count(4, "FIRST", 40, 12)]).used
      .qty,
    40,
  );
  assert.equal(
    effectiveCount([
      count(1, "FIRST", 20, 12),
      count(2, "VERIFY", 18, 13, { isConflict: 1 }),
    ]).openConflict,
    true,
  );
});
test("KEEP has no stock or accounting effect despite stored nonzero difference", () => {
  const review = buildReview(fixture("KEEP"));
  const row = review.candidateReviews[0];
  assert.equal(row.classification, "KEEP_NO_OWN_ADJUSTMENT");
  assert.equal(row.actualOwnMovements.length, 0);
  assert.equal(row.ownMovementMatchesDecision, true);
  assert.equal(review.sessionReviews[0].ledgerMatches, true);
  assert.equal(
    review.sessionReviews[0].expectedLedgerFromAllDecisions.short,
    "0.00",
  );
});
test("ADJUST reconstructs interference without presenting a safe correction", () => {
  const review = buildReview(fixture());
  const row = review.candidateReviews[0];
  assert.equal(row.diagnosticOnly.finalQtyMatchesReconstruction, true);
  assert.equal(row.diagnosticOnly.finalQtyExcludingOtherStocktake, 20);
  assert.equal(row.diagnosticOnly.valueExcludingOtherStocktake, "0.00");
  assert.equal(row.diagnosticOnly.safeCorrectedQuantity, null);
  assert.equal(review.sessionReviews[0].ledgerMatches, true);
});
test("later RECOUNT removes FIRST-only false positive", () => {
  const snapshot = fixture();
  snapshot.counts.push(count(2, "RECOUNT", 10, 16));
  assert.equal(
    buildReview(snapshot).candidateReviews[0].classification,
    "NO_EFFECTIVE_OVERLAP",
  );
});
test("multiple overlaps and unresolved conflict remain explicit", () => {
  const snapshot = fixture();
  snapshot.movements.push({
    id: 81,
    variantId: 7,
    branchId: 1,
    movementType: "ADJUST",
    referenceType: "STOCKTAKE",
    referenceId: 12,
    signedDelta: 2,
    createdAt: at(16),
  });
  snapshot.counts.push(count(2, "VERIFY", 2, 13, { isConflict: 1 }));
  const row = buildReview(snapshot).candidateReviews[0];
  assert.equal(row.classification, "AMBIGUOUS_COUNT_REQUIRES_REVIEW");
  assert.equal(row.diagnosticOnly.multipleOverlaps, true);
});
test("ledger classification uses signed cost and excludes KEEP, opening and consignment gain", () => {
  const items = [
    { action: "ADJUST", diffQty: -2, value: "-1250.00" },
    { action: "ADJUST", diffQty: 1, value: "625.00" },
    { action: "KEEP", diffQty: -10, value: "-6250.00" },
    {
      action: "ADJUST",
      diffQty: 5,
      value: "100.00",
      isConsignment: 1,
      consignorId: 3,
    },
  ];
  assert.deepEqual(decisionLedgerExpectation(items), {
    short: "1250.00",
    over: "625.00",
    consignmentShort: "0.00",
    cost: "625.00",
    profit: "-625.00",
    amount: "0.00",
  });
  assert.equal(decisionLedgerExpectation(items, "OPENING").cost, "0.00");
  assert.equal(
    decisionLedgerExpectation([
      {
        action: "ADJUST",
        diffQty: -1,
        value: "-50.00",
        isConsignment: 1,
        consignorId: 3,
      },
    ]).consignmentShort,
    "50.00",
  );
});
test("ledger mismatch or cash/party linkage fails reconciliation", () => {
  const snapshot = fixture();
  snapshot.entries[0].amount = "1.00";
  snapshot.entries[0].supplierId = 3;
  const session = buildReview(snapshot).sessionReviews[0];
  assert.equal(session.ledgerMatches, false);
  assert.equal(session.ledgerChecks.zeroCashAmountOnOwnedAdjustments, false);
  assert.equal(
    session.ledgerChecks.noReceiptOrPurchaseOrPartyLinksOnOwnedAdjustments,
    false,
  );
});
test("consignment shortages reconcile supplier liability independently of owned SHORT", () => {
  const snapshot = fixture();
  snapshot.items[0].isConsignment = 1;
  snapshot.items[0].consignorId = 43;
  snapshot.entries = [
    {
      id: 101,
      entryType: "PURCHASE",
      dedupeKey: "CONSIG:STK:10:43",
      supplierId: 43,
      cost: "6250.00",
      profit: "-6250.00",
      revenue: "0.00",
      amount: "6250.00",
    },
  ];
  const session = buildReview(snapshot).sessionReviews[0];
  assert.equal(session.ledgerMatches, true);
  assert.equal(session.actualLedger.short, "0.00");
  assert.equal(session.actualLedger.consignmentShort, "6250.00");
  assert.equal(
    session.actualLedger.nonCashConsignmentLiabilityAmount,
    "6250.00",
  );
  snapshot.entries[0].supplierId = 44;
  assert.equal(
    buildReview(snapshot).sessionReviews[0].ledgerChecks
      .consignmentSupplierDimensionsMatch,
    false,
  );
});
test("own movement can be stamped one second after approval header within its transaction", () => {
  const snapshot = fixture();
  snapshot.movements.find((row) => row.id === 90).createdAt =
    "2026-10-21T18:00:01.000Z";
  assert.equal(
    buildReview(snapshot).candidateReviews[0].ownMovementMatchesDecision,
    true,
  );
});
