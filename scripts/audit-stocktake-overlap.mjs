// Diagnostic SELECT-only review. Never posts movements, ledger entries or repairs.
// Capture: pipe this file into `ssh alroya-erp "cd /home/deploy/erp && node --input-type=module - --capture"`.
// Offline: node scripts/audit-stocktake-overlap.mjs --input snapshot.json --output review.json
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function assertSelect(query) {
  if (
    !/^\s*SELECT\b/i.test(query) ||
    /;|--|\/\*|\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|CALL|INTO|OUTFILE|DUMPFILE|FOR\s+UPDATE|LOCK|SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|LOAD_FILE)\b/i.test(
      query,
    )
  )
    throw new Error("Only bounded SELECT queries are permitted");
}

export async function readOnlySnapshot(connection, work) {
  await connection.query("SET SESSION MAX_EXECUTION_TIME=15000");
  await connection.query("SET TRANSACTION READ ONLY");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  try {
    return await work(async (query, params = []) => {
      assertSelect(query);
      const [rows] = await connection.query(query, params);
      return rows;
    });
  } finally {
    await connection.rollback();
  }
}

const instant = (value) => new Date(value).getTime();
const pairKey = (row) => `${row.sessionId}:${row.variantId}`;
const sumQty = (rows) =>
  rows.reduce((total, row) => total + Number(row.signedDelta ?? 0), 0);
const cents = (value) => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? "0"));
  if (!match) throw new Error(`Expected a two-decimal money string: ${value}`);
  return (
    (match[1] ? -1n : 1n) *
    (BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0")))
  );
};
const money = (value) =>
  `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, "0")}`;
const addMoney = (rows, field) =>
  rows.reduce((sum, row) => sum + cents(row[field]), 0n);

export function effectiveCount(rows) {
  const sorted = [...rows].sort(
    (a, b) =>
      instant(a.countedAt) - instant(b.countedAt) ||
      Number(a.id) - Number(b.id),
  );
  const latest = (kind) => sorted.filter((row) => row.kind === kind).at(-1);
  const first = latest("FIRST"),
    recount = latest("RECOUNT"),
    verify = latest("VERIFY");
  const used =
    recount ??
    (first
      ? verify?.isConflict && verify.resolvedPick === "VERIFY"
        ? verify
        : first
      : null);
  return {
    used,
    openConflict: Boolean(
      verify?.isConflict && !verify.resolvedPick && !recount,
    ),
    supersededCountIds: sorted
      .filter((row) => row !== used)
      .map((row) => row.id),
  };
}

export function decisionLedgerExpectation(items, sessionType = "NORMAL") {
  let short = 0n,
    over = 0n,
    consignmentShort = 0n;
  for (const row of items) {
    if (
      sessionType === "OPENING" ||
      row.action !== "ADJUST" ||
      !Number(row.diffQty)
    )
      continue;
    const value = cents(row.value),
      consignment = Boolean(row.isConsignment && row.consignorId != null);
    if (Number(row.diffQty) < 0) {
      const loss = value < 0n ? -value : value;
      if (consignment) consignmentShort += loss;
      else short += loss;
    } else if (!consignment) over += value;
  }
  return {
    short: money(short),
    over: money(over),
    consignmentShort: money(consignmentShort),
    cost: money(short - over + consignmentShort),
    profit: money(over - short - consignmentShort),
    amount: "0.00",
  };
}

export function buildReview(snapshot) {
  const {
    firstCandidates,
    sessions,
    items,
    counts,
    movements,
    currentStock,
    laterMovements,
    entries,
    journalRoles = [],
  } = snapshot;
  const sessionMap = new Map(sessions.map((row) => [Number(row.id), row]));
  const pairs = [
    ...new Map(firstCandidates.map((row) => [pairKey(row), row])).values(),
  ];
  const candidateReviews = pairs.map((candidate) => {
    const session = sessionMap.get(Number(candidate.sessionId));
    const item = items.find((row) => pairKey(row) === pairKey(candidate));
    const countRows = counts.filter(
      (row) => pairKey(row) === pairKey(candidate),
    );
    const selected = effectiveCount(countRows);
    const used = selected.used;
    const windowMoves = used
      ? movements.filter(
          (row) =>
            Number(row.variantId) === Number(candidate.variantId) &&
            Number(row.branchId) === Number(session.branchId) &&
            instant(row.createdAt) > instant(used.countedAt) &&
            instant(row.createdAt) < instant(session.approvedAt) &&
            !(
              row.referenceType === "STOCKTAKE" &&
              Number(row.referenceId) === Number(session.id)
            ),
        )
      : [];
    const interfering = windowMoves.filter(
      (row) =>
        row.referenceType === "STOCKTAKE" &&
        Number(row.referenceId) !== Number(session.id),
    );
    const otherAdjustments = windowMoves.filter(
      (row) =>
        row.movementType === "ADJUST" && row.referenceType !== "STOCKTAKE",
    );
    const operational = windowMoves.filter(
      (row) => row.movementType !== "ADJUST",
    );
    const own = movements.filter(
      (row) =>
        Number(row.variantId) === Number(candidate.variantId) &&
        Number(row.branchId) === Number(session.branchId) &&
        row.referenceType === "STOCKTAKE" &&
        Number(row.referenceId) === Number(session.id),
    );
    const observedNet = sumQty(windowMoves),
      interferenceNet = sumQty(interfering);
    const observedTarget = used ? Number(used.qty) + observedNet : null;
    const withoutInterference = used
      ? Number(used.qty) + observedNet - interferenceNet
      : null;
    const bookAtApproval =
      item.finalQty != null && item.diffQty != null
        ? Number(item.finalQty) - Number(item.diffQty)
        : null;
    const diagnosticDiff =
      withoutInterference != null && bookAtApproval != null
        ? withoutInterference - bookAtApproval
        : null;
    const selectedCandidates = firstCandidates.filter(
      (row) => pairKey(row) === pairKey(candidate),
    );
    const sourceCounts = interfering.map((movement) => ({
      movementId: movement.id,
      sourceSession: sessionMap.get(Number(movement.referenceId)),
      effectiveCount: effectiveCount(
        counts.filter(
          (row) =>
            Number(row.sessionId) === Number(movement.referenceId) &&
            Number(row.variantId) === Number(candidate.variantId),
        ),
      ).used,
    }));
    const later = laterMovements.filter(
      (row) => pairKey(row) === pairKey(candidate),
    );
    let classification = "NO_EFFECTIVE_OVERLAP";
    if (interfering.length)
      classification =
        item.action === "KEEP"
          ? "KEEP_NO_OWN_ADJUSTMENT"
          : "ADJUST_REQUIRES_DOCUMENT_REVIEW";
    if (selected.openConflict || !used)
      classification = "AMBIGUOUS_COUNT_REQUIRES_REVIEW";
    return {
      sessionId: session.id,
      code: session.code,
      branchId: session.branchId,
      variantId: item.variantId,
      sku: item.sku,
      productName: item.productName,
      classification,
      firstCandidateMovementIds: selectedCandidates.map(
        (row) => row.otherMovementId,
      ),
      effectiveCount: used,
      supersededCountIds: selected.supersededCountIds,
      openConflict: selected.openConflict,
      allHistoricalCounts: countRows,
      decision: {
        action: item.action,
        decidedBy: item.decidedBy,
        autoApplied: item.autoApplied,
        reason: item.reason,
        note: item.note,
        finalQty: item.finalQty,
        diffQty: item.diffQty,
        value: item.value,
        unitCost: item.unitCost,
      },
      approvedAt: session.approvedAt,
      approvedBy: session.approvedBy,
      reviewApprovedAt: item.reviewApprovedAt,
      reviewApprovedBy: item.reviewApprovedBy,
      interferingAdjustments: interfering,
      interferingSourceCounts: sourceCounts,
      operationalDeltas: { net: sumQty(operational), rows: operational },
      otherAdjustments,
      actualOwnMovements: own,
      ownMovementMatchesDecision:
        item.action === "KEEP"
          ? own.length === 0
          : sumQty(own) === Number(item.diffQty),
      decisionValueMatchesSnapshotCost:
        item.value != null &&
        item.diffQty != null &&
        cents(item.value) === BigInt(item.diffQty) * cents(item.unitCost),
      diagnosticOnly: {
        observedNetAfterCount: observedNet,
        interferingNet: interferenceNet,
        reconstructedFinalQty: observedTarget,
        finalQtyMatchesReconstruction: observedTarget === Number(item.finalQty),
        bookAtApproval,
        finalQtyExcludingOtherStocktake: withoutInterference,
        diffQtyExcludingOtherStocktake: diagnosticDiff,
        valueExcludingOtherStocktake:
          diagnosticDiff == null
            ? null
            : money(BigInt(diagnosticDiff) * cents(item.unitCost)),
        originalValue: item.value,
        staleOrContradictoryCount: interfering.length > 0,
        multipleOverlaps: interfering.length > 1,
        safeCorrectedQuantity: null,
      },
      accountingClassification:
        item.action === "KEEP" || !Number(item.diffQty)
          ? "NO_POSTING"
          : item.isConsignment && item.consignorId != null
            ? Number(item.diffQty) < 0
              ? "CONSIGNMENT_SHORTAGE_LOSSES_AND_SUPPLIER_PAYABLE"
              : "CONSIGNMENT_GAIN_NO_LIBRARY_REVENUE"
            : Number(item.diffQty) < 0
              ? "OWNED_SHORTAGE_LOSSES_AND_INVENTORY"
              : "OWNED_GAIN_INVENTORY_AND_OTHER_REVENUE",
      currentStock:
        currentStock.find(
          (row) =>
            Number(row.variantId) === Number(item.variantId) &&
            Number(row.branchId) === Number(session.branchId),
        ) ?? null,
      laterMovementGroups: later,
      protectedPolicy: {
        allowBackorderNow: Boolean(item.allowBackorder),
        historicalPolicyUnknown: true,
        negativeTargetsCanRepresentOperationalSalesAfterCount: true,
        neverClampNegativeToZero: true,
      },
      nextAction:
        item.action === "KEEP"
          ? "Verify evidence and later counts; no reversal of a movement that did not occur"
          : "Targeted physical recount and documented stock/valuation review; do not apply the diagnostic quantity to current stock",
    };
  });
  const reviewedIds = [
    ...new Set(firstCandidates.map((row) => Number(row.sessionId))),
  ].sort((a, b) => a - b);
  const sessionReviews = reviewedIds.map((id) => {
    const session = sessionMap.get(id),
      allItems = items.filter((row) => Number(row.sessionId) === id);
    const expected = decisionLedgerExpectation(allItems, session.sessionType);
    const actual = entries.filter((row) =>
      row.dedupeKey?.startsWith(`STOCKTAKE:${id}:`),
    );
    const consignmentEntries = entries.filter((row) =>
      row.dedupeKey?.startsWith(`CONSIG:STK:${id}:`),
    );
    const short = actual.filter(
        (row) => row.dedupeKey === `STOCKTAKE:${id}:SHORT`,
      ),
      over = actual.filter((row) => row.dedupeKey === `STOCKTAKE:${id}:OVER`);
    const actualShort = addMoney(short, "cost"),
      actualOver = -addMoney(over, "cost");
    const ownReviews = candidateReviews.filter(
      (row) => Number(row.sessionId) === id,
    );
    const allEntries = [...actual, ...consignmentEntries];
    const consignmentSuppliers = [
      ...new Set(
        allItems
          .filter(
            (row) =>
              row.action === "ADJUST" &&
              Number(row.diffQty) < 0 &&
              row.isConsignment &&
              row.consignorId != null,
          )
          .map((row) => Number(row.consignorId)),
      ),
    ];
    const consignmentSupplierChecks = consignmentSuppliers.map((supplierId) => {
      const relevant = allItems.filter(
        (row) => Number(row.consignorId) === supplierId,
      );
      const expectedSupplier = decisionLedgerExpectation(
        relevant,
        session.sessionType,
      ).consignmentShort;
      const matching = consignmentEntries.filter(
        (entry) =>
          entry.dedupeKey === `CONSIG:STK:${id}:${supplierId}` &&
          Number(entry.supplierId) === supplierId,
      );
      return {
        supplierId,
        expected: expectedSupplier,
        actual: money(addMoney(matching, "cost")),
        matches:
          matching.length === 1 &&
          addMoney(matching, "cost") === cents(expectedSupplier),
      };
    });
    const ledgerChecks = {
      shortMatches: actualShort === cents(expected.short),
      overMatches: actualOver === cents(expected.over),
      consignmentShortMatches:
        addMoney(consignmentEntries, "cost") ===
        cents(expected.consignmentShort),
      profitMatches: addMoney(allEntries, "profit") === cents(expected.profit),
      zeroCashAmountOnOwnedAdjustments: addMoney(actual, "amount") === 0n,
      zeroSalesRevenue: addMoney(allEntries, "revenue") === 0n,
      noReceiptOrPurchaseOrPartyLinksOnOwnedAdjustments: actual.every(
        (row) =>
          row.receiptId == null &&
          row.purchaseOrderId == null &&
          row.invoiceId == null &&
          row.supplierId == null &&
          row.customerId == null,
      ),
      consignmentLiabilityNotCash: consignmentEntries.every(
        (row) =>
          row.entryType === "PURCHASE" &&
          row.supplierId != null &&
          row.invoiceId == null &&
          row.receiptId == null &&
          cents(row.amount) === cents(row.cost) &&
          cents(row.profit) === -cents(row.cost),
      ),
      signsAndType:
        short.every(
          (row) =>
            row.entryType === "ADJUST" &&
            cents(row.cost) >= 0n &&
            cents(row.profit) === -cents(row.cost),
        ) &&
        over.every(
          (row) =>
            row.entryType === "ADJUST" &&
            cents(row.cost) <= 0n &&
            cents(row.profit) === -cents(row.cost),
        ),
      uniqueDedupe:
        new Set(allEntries.map((row) => row.dedupeKey)).size ===
        allEntries.length,
    };
    ledgerChecks.consignmentSupplierDimensionsMatch =
      consignmentSupplierChecks.every((row) => row.matches);
    ledgerChecks.decisionValuesMatchSnapshotCost = allItems.every(
      (row) =>
        row.diffQty != null &&
        row.value != null &&
        cents(row.value) === BigInt(row.diffQty) * cents(row.unitCost),
    );
    return {
      ...session,
      totalItems: allItems.length,
      totalAdjustDecisions: allItems.filter((row) => row.action === "ADJUST")
        .length,
      totalKeepDecisions: allItems.filter((row) => row.action === "KEEP")
        .length,
      candidateItems: ownReviews.length,
      effectiveOverlapItems: ownReviews.filter(
        (row) => row.interferingAdjustments.length,
      ).length,
      reviewClassifications: ownReviews.map((row) => ({
        variantId: row.variantId,
        classification: row.classification,
      })),
      expectedLedgerFromAllDecisions: expected,
      actualLedger: {
        short: money(actualShort),
        over: money(actualOver),
        consignmentShort: money(addMoney(consignmentEntries, "cost")),
        ownedCost: money(addMoney(actual, "cost")),
        cost: money(addMoney(allEntries, "cost")),
        profit: money(addMoney(allEntries, "profit")),
        amount: money(addMoney(actual, "amount")),
        nonCashConsignmentLiabilityAmount: money(
          addMoney(consignmentEntries, "amount"),
        ),
        entries: allEntries,
        journalRoles: journalRoles.filter((row) =>
          allEntries.some((entry) => Number(entry.id) === Number(row.entryId)),
        ),
        consignmentSupplierChecks,
      },
      ledgerChecks,
      ledgerMatches: Object.values(ledgerChecks).every(Boolean),
      accountingInterpretation:
        "Owned SHORT: debit LOSSES / credit INVENTORY; owned OVER: debit INVENTORY / credit OTHER_REVENUE. Consignment shortage: debit LOSSES / credit CONSIGNMENT_PAYABLE, recorded PURCHASE with supplier amount and no receipt; consignment gain creates no library revenue. No automatic cash/AP/receipt corrections. Current product flags and historical policy require source review.",
    };
  });
  return {
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
    supplementalSource: snapshot.supplementalSource ?? null,
    boundary:
      "READ ONLY consistent snapshot; diagnostic only; no changes to inventory, ledger, cash, supplier balances, receipts or server files",
    scope: {
      firstCandidateMovementLinks: firstCandidates.length,
      candidateItems: candidateReviews.length,
      sessions: sessionReviews.length,
      effectiveOverlapItems: candidateReviews.filter(
        (row) => row.interferingAdjustments.length,
      ).length,
      effectiveOverlapMovements: candidateReviews.reduce(
        (sum, row) => sum + row.interferingAdjustments.length,
        0,
      ),
      allSessionLedgersMatch: sessionReviews.every((row) => row.ledgerMatches),
      allCandidateMovementsMatchDecisions: candidateReviews.every(
        (row) => row.ownMovementMatchesDecision,
      ),
      allCandidateFinalQuantitiesReconstructed: candidateReviews.every(
        (row) => row.diagnosticOnly.finalQtyMatchesReconstruction,
      ),
    },
    limits: [
      "Candidates reproduce the previous FIRST-based search, then use effective RECOUNT/selected VERIFY; this is a bounded review of those candidates, not a new full-population anomaly search",
      "Removing another stocktake delta is a conditional arithmetic diagnostic, not a valid historical or current physical quantity",
      "A newer approved count supersedes confidence in the old count; contradictory physical counts and later operational activity prevent automatic reversal",
      "Product consignment/backorder flags are current, not time-versioned historical facts",
      "Movement and count timestamps have second precision; equal-time cross-document events need document/order evidence",
      "A matching journal proves consistent posting of the recorded decision, not correctness of the physical count",
    ],
    sessionReviews,
    candidateReviews,
  };
}

export async function capture(connection) {
  return readOnlySnapshot(connection, async (select) => {
    const source = await select(
      "SELECT UTC_TIMESTAMP(6) capturedAtUtc, VERSION() mysqlVersion",
    );
    const firstCandidates =
      await select(`SELECT c.sessionId,c.variantId,s.branchId,c.id firstCountId,c.countedAt firstCountedAt,m.id otherMovementId,m.referenceId otherSessionId,m.signedDelta,m.createdAt otherAdjustmentAt
      FROM stocktakeCounts c JOIN stocktakeSessions s ON s.id=c.sessionId
      JOIN inventoryMovements m ON m.variantId=c.variantId AND m.branchId=s.branchId AND m.referenceType='STOCKTAKE' AND m.referenceId<>c.sessionId AND m.createdAt>c.countedAt AND m.createdAt<s.approvedAt
      WHERE s.stocktakeStatus='APPROVED' AND c.kind='FIRST' ORDER BY c.sessionId,c.variantId,m.id LIMIT 101`);
    if (firstCandidates.length > 100)
      throw new Error(
        "Candidate scope exceeds the bounded audit; narrow explicitly before retrying",
      );
    if (!firstCandidates.length)
      throw new Error("No candidates in the historical FIRST search");
    const ids = [
      ...new Set(firstCandidates.map((row) => Number(row.sessionId))),
    ];
    const sourceIds = [
      ...new Set([
        ...ids,
        ...firstCandidates.map((row) => Number(row.otherSessionId)),
      ]),
    ];
    const marks = (values) => values.map(() => "?").join(",");
    const sessions = await select(
      `SELECT id,code,name,branchId,sessionType,stocktakeStatus,createdBy,createdAt,approvedAt,approvedBy,firstSignBy,firstSignAt FROM stocktakeSessions WHERE id IN (${marks(sourceIds)}) ORDER BY id`,
      sourceIds,
    );
    const items = await select(
      `SELECT i.sessionId,i.variantId,i.branchId,i.expectedQty,i.unitCost,i.reviewApprovedBy,i.reviewApprovedAt,d.action,d.finalQty,d.diffQty,d.value,d.reason,d.note,d.decidedBy,d.autoApplied,v.sku,p.name productName,p.isConsignment,p.consignorId,p.allowBackorder
      FROM stocktakeItems i JOIN productVariants v ON v.id=i.variantId JOIN products p ON p.id=v.productId LEFT JOIN stocktakeDecisions d ON d.sessionId=i.sessionId AND d.variantId=i.variantId
      WHERE i.sessionId IN (${marks(ids)}) ORDER BY i.sessionId,i.variantId`,
      ids,
    );
    const pairs = [
      ...new Map(
        firstCandidates
          .flatMap((row) => [
            row,
            { sessionId: row.otherSessionId, variantId: row.variantId },
          ])
          .map((row) => [pairKey(row), row]),
      ).values(),
    ];
    const pairWhere = pairs
      .map(() => "(sessionId=? AND variantId=?)")
      .join(" OR ");
    const counts = await select(
      `SELECT id,sessionId,variantId,kind,qty,countedAt,createdAt,countedByName,countedByUserId,isConflict,resolvedPick,resolvedBy,resolvedAt FROM stocktakeCounts WHERE ${pairWhere} ORDER BY sessionId,variantId,countedAt,id`,
      pairs.flatMap((row) => [row.sessionId, row.variantId]),
    );
    const candidatePairs = [
      ...new Map(firstCandidates.map((row) => [pairKey(row), row])).values(),
    ];
    const moveWhere = candidatePairs
      .map(
        () =>
          "(m.variantId=? AND m.branchId=? AND m.createdAt>=? AND m.createdAt<=?)",
      )
      .join(" OR ");
    const moveParams = candidatePairs.flatMap((row) => {
      const session = sessions.find(
        (s) => Number(s.id) === Number(row.sessionId),
      );
      const count = counts
        .filter((c) => pairKey(c) === pairKey(row))
        .sort((a, b) => instant(a.countedAt) - instant(b.countedAt))[0];
      return [row.variantId, row.branchId, count.countedAt, session.approvedAt];
    });
    const ownWhere = candidatePairs
      .map(
        () =>
          "(m.referenceType='STOCKTAKE' AND m.referenceId=? AND m.variantId=?)",
      )
      .join(" OR ");
    const movements = await select(
      `SELECT m.id,m.variantId,m.branchId,m.movementType,m.signedDelta,m.quantity,m.referenceType,m.referenceId,m.documentNumber,m.createdAt,m.createdBy FROM inventoryMovements m WHERE ${moveWhere} OR ${ownWhere} ORDER BY m.id LIMIT 10001`,
      [
        ...moveParams,
        ...candidatePairs.flatMap((row) => [row.sessionId, row.variantId]),
      ],
    );
    if (
      movements.length > 10000 ||
      movements.some((row) => row.signedDelta == null)
    )
      throw new Error(
        "Movement boundary or signedDelta evidence is incomplete",
      );
    const stockPairs = [
      ...new Map(
        firstCandidates.map((row) => [`${row.branchId}:${row.variantId}`, row]),
      ).values(),
    ];
    const currentStock = await select(
      `SELECT variantId,branchId,quantity,lastCountedAt,openedAt FROM branchStock WHERE ${stockPairs.map(() => "(variantId=? AND branchId=?)").join(" OR ")} ORDER BY branchId,variantId`,
      stockPairs.flatMap((row) => [row.variantId, row.branchId]),
    );
    const laterMovements = await select(
      `SELECT i.sessionId,i.variantId,m.referenceType,COUNT(*) movements,SUM(m.signedDelta) net,MIN(m.createdAt) firstAt,MAX(m.createdAt) lastAt FROM stocktakeItems i JOIN stocktakeSessions s ON s.id=i.sessionId JOIN inventoryMovements m ON m.variantId=i.variantId AND m.branchId=i.branchId AND m.createdAt>s.approvedAt AND NOT (m.referenceType='STOCKTAKE' AND m.referenceId=i.sessionId) WHERE ${candidatePairs.map(() => "(i.sessionId=? AND i.variantId=?)").join(" OR ")} GROUP BY i.sessionId,i.variantId,m.referenceType ORDER BY i.sessionId,i.variantId,m.referenceType`,
      candidatePairs.flatMap((row) => [row.sessionId, row.variantId]),
    );
    const entryKeys = ids.flatMap((id) => [
      `STOCKTAKE:${id}:SHORT`,
      `STOCKTAKE:${id}:OVER`,
    ]);
    const entries = await select(
      `SELECT id,entryType,branchId,dedupeKey,postingProfile,postingIntentJson,postingCycleId,revenue,cost,profit,amount,entryDate,createdAt,receiptId,purchaseOrderId,invoiceId,supplierId,customerId FROM accountingEntries WHERE dedupeKey IN (${marks(entryKeys)}) OR ${ids.map(() => "dedupeKey LIKE ?").join(" OR ")} ORDER BY id`,
      [...entryKeys, ...ids.map((id) => `CONSIG:STK:${id}:%`)],
    );
    const journalRoles = entries.length
      ? await select(
          `SELECT j.entryId,j.id journalId,j.status,j.cycleId,j.postingProfile,l.role,SUM(l.debit) debit,SUM(l.credit) credit FROM journalEntries j LEFT JOIN journalLines l ON l.journalId=j.id WHERE j.entryId IN (${marks(entries)}) GROUP BY j.entryId,j.id,j.status,j.cycleId,j.postingProfile,l.role ORDER BY j.entryId,l.role`,
          entries.map((row) => row.id),
        )
      : [];
    return {
      capturedAt: new Date().toISOString(),
      source: source[0],
      firstCandidates,
      sessions,
      items,
      counts,
      movements,
      currentStock,
      laterMovements,
      entries,
      journalRoles,
    };
  });
}

async function main(args) {
  if (args.includes("--capture")) {
    if (args.length !== 1)
      throw new Error("Capture accepts no mutation mode or SQL argument");
    await import("dotenv/config");
    const { createConnection } = await import("mysql2/promise");
    const connection = await createConnection({
      uri: process.env.DATABASE_URL,
      timezone: "Z",
    });
    try {
      console.log(JSON.stringify(await capture(connection)));
    } finally {
      await connection.end();
    }
    return;
  }
  const input = args.indexOf("--input"),
    output = args.indexOf("--output");
  if (input < 0 || output < 0 || args.length !== 4)
    throw new Error(
      "Use --capture, or --input snapshot.json --output review.json; no write/repair mode exists",
    );
  const snapshot = JSON.parse(await readFile(args[input + 1], "utf8"));
  const review = buildReview(snapshot);
  await writeFile(args[output + 1], `${JSON.stringify(review, null, 2)}\n`);
  console.log(JSON.stringify(review.scope));
}

if (
  process.argv[1] === "-" ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  await main(process.argv.slice(2));
}
