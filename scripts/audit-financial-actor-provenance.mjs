import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/**
 * The query intentionally selects actor IDs and boolean evidence only. It never
 * selects names, notes, document numbers, contact data, or monetary values.
 */
export const AUDIT_SQL = `
SELECT
  ae.entryType AS entryType,
  ae.createdBy IS NULL AS missingCreatedBy,
  NULLIF(TRIM(ae.createdByNameSnapshot), '') IS NULL AS missingNameSnapshot,
  ae.createdBy AS entryCreatedBy,
  r.approvedBy AS receiptApprovedBy,
  r.createdBy AS receiptCreatedBy,
  i.createdBy AS invoiceCreatedBy
FROM accountingEntries ae
LEFT JOIN receipts r ON r.id = ae.receiptId
LEFT JOIN invoices i ON i.id = ae.invoiceId
WHERE ae.createdBy IS NULL
   OR NULLIF(TRIM(ae.createdByNameSnapshot), '') IS NULL
`;

const FORBIDDEN_SQL =
  /\b(?:UPDATE|INSERT|DELETE|REPLACE|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|CALL|LOAD|HANDLER|LOCK|UNLOCK)\b|\bINTO\s+(?:OUTFILE|DUMPFILE)\b|\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i;

export function assertReadOnlySql(sql) {
  if (typeof sql !== "string" || !/^SELECT\b/i.test(sql.trimStart())) {
    throw new Error("read-only SQL assertion failed: expected SELECT");
  }

  const withoutTrailingSemicolon = sql.trim().replace(/;$/, "");
  if (withoutTrailingSemicolon.includes(";") || FORBIDDEN_SQL.test(sql)) {
    throw new Error("read-only SQL assertion failed: unsafe statement");
  }
}

function actorKey(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === "bigint") {
    return value > 0n ? value.toString() : null;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

function truthyDatabaseFlag(value) {
  return value === true || value === 1 || value === "1";
}

/**
 * Uses only direct provenance columns. Entry type may only restrict which
 * linked document is relevant; free text, dedupe keys, dates, roles and
 * amounts are never treated as identity evidence.
 */
export function classifyActorEvidence(row) {
  const entryActor = actorKey(row.entryCreatedBy);
  const entryType = safeEntryType(row.entryType);
  const receiptApprovedBy = actorKey(row.receiptApprovedBy);
  const receiptCreatedBy = actorKey(row.receiptCreatedBy);
  const invoiceCreatedBy = actorKey(row.invoiceCreatedBy);
  const sourceActor =
    entryType === "PAYMENT_IN" || entryType === "PAYMENT_OUT"
      ? (receiptApprovedBy ?? receiptCreatedBy)
      : entryType === "SALE"
        ? invoiceCreatedBy
        : null;

  // No linked document currently carries an immutable creator-name snapshot
  // tied to these actor IDs. In particular, invoice.salespersonNameSnapshot
  // belongs to the salesperson and must never be treated as the creator name.
  const documentedNameSnapshotAvailable = false;

  if (entryActor !== null) {
    return {
      status: "deterministic",
      evidence:
        sourceActor === null
          ? "entry_actor_only"
          : sourceActor === entryActor
            ? "entry_actor_corroborated"
            : "entry_actor_source_conflict",
      documentedNameSnapshotAvailable,
    };
  }

  if (sourceActor === null) {
    return {
      status: "unresolved",
      evidence: "no_explicit_evidence",
      documentedNameSnapshotAvailable,
    };
  }

  const evidence =
    entryType === "SALE"
      ? "invoice_created_by"
      : receiptApprovedBy !== null
        ? "receipt_approved_by"
        : "receipt_created_by";

  return {
    status: "deterministic",
    evidence,
    documentedNameSnapshotAvailable,
  };
}

const EVIDENCE_COUNT_KEYS = {
  entry_actor_only: "entryActorOnly",
  entry_actor_corroborated: "entryActorCorroborated",
  entry_actor_source_conflict: "entryActorSourceConflict",
  receipt_approved_by: "receiptApprovedBy",
  receipt_created_by: "receiptCreatedBy",
  invoice_created_by: "invoiceCreatedBy",
};

function safeEntryType(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value)
    ? value
    : "UNKNOWN";
}

export function summarizeRows(rows) {
  const counts = {
    incompleteEntries: rows.length,
    missingFields: {
      createdBy: 0,
      createdByNameSnapshot: 0,
      both: 0,
    },
    actorAttribution: {
      deterministic: 0,
      unresolved: 0,
      noExplicitEvidence: 0,
      conflictingEvidence: 0,
    },
    deterministicEvidence: {
      entryActorOnly: 0,
      entryActorCorroborated: 0,
      entryActorSourceConflict: 0,
      receiptApprovedBy: 0,
      receiptCreatedBy: 0,
      invoiceCreatedBy: 0,
    },
    historicalNameSnapshot: {
      alreadyPresent: 0,
      documentedSourceAvailable: 0,
      unresolvedWithoutSnapshot: 0,
    },
    byEntryType: {},
  };

  for (const row of rows) {
    const missingCreatedBy = truthyDatabaseFlag(row.missingCreatedBy);
    const missingNameSnapshot = truthyDatabaseFlag(row.missingNameSnapshot);
    if (missingCreatedBy) counts.missingFields.createdBy += 1;
    if (missingNameSnapshot) counts.missingFields.createdByNameSnapshot += 1;
    if (missingCreatedBy && missingNameSnapshot) counts.missingFields.both += 1;

    const classification = classifyActorEvidence(row);
    if (classification.status === "deterministic") {
      counts.actorAttribution.deterministic += 1;
      counts.deterministicEvidence[
        EVIDENCE_COUNT_KEYS[classification.evidence]
      ] += 1;
    } else {
      counts.actorAttribution.unresolved += 1;
      if (classification.evidence === "conflicting_evidence") {
        counts.actorAttribution.conflictingEvidence += 1;
      } else {
        counts.actorAttribution.noExplicitEvidence += 1;
      }
    }

    if (!missingNameSnapshot) {
      counts.historicalNameSnapshot.alreadyPresent += 1;
    } else if (classification.documentedNameSnapshotAvailable) {
      counts.historicalNameSnapshot.documentedSourceAvailable += 1;
    } else {
      counts.historicalNameSnapshot.unresolvedWithoutSnapshot += 1;
    }

    const entryType = safeEntryType(row.entryType);
    counts.byEntryType[entryType] = (counts.byEntryType[entryType] ?? 0) + 1;
  }

  counts.byEntryType = Object.fromEntries(
    Object.entries(counts.byEntryType).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

  return { ok: true, counts };
}

export function runSelfTest() {
  assert.doesNotThrow(() => assertReadOnlySql(AUDIT_SQL));
  assert.throws(
    () => assertReadOnlySql("UPDATE accountingEntries SET createdBy = 1"),
    /read-only/,
  );

  assert.equal(
    classifyActorEvidence({ entryType: "PAYMENT_IN", receiptCreatedBy: 9 })
      .evidence,
    "receipt_created_by",
  );
  assert.equal(
    classifyActorEvidence({
      entryType: "RETURN",
      receiptCreatedBy: 9,
      invoiceCreatedBy: 10,
    }).status,
    "unresolved",
  );
  assert.equal(
    classifyActorEvidence({ notes: "created by 9", dedupeKey: "SALE:9" })
      .evidence,
    "no_explicit_evidence",
  );

  const redacted = summarizeRows([
    {
      entryType: "SALE",
      missingCreatedBy: 1,
      missingNameSnapshot: 1,
      receiptCreatedBy: 9,
      secretName: "PII_SENTINEL",
    },
  ]);
  assert.equal(JSON.stringify(redacted).includes("PII_SENTINEL"), false);
  assert.equal(JSON.stringify(redacted).includes('"9"'), false);

  return 6;
}

async function readRowsFromDatabase() {
  const { config: loadEnv } = await import("dotenv");
  loadEnv({ quiet: true });

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  assertReadOnlySql(AUDIT_SQL);
  const { createConnection } = await import("mysql2/promise");
  const connection = await createConnection(databaseUrl);
  let transactionStarted = false;

  try {
    await connection.query("START TRANSACTION READ ONLY");
    transactionStarted = true;
    const [rows] = await connection.execute(AUDIT_SQL);
    return rows;
  } finally {
    if (transactionStarted) {
      await connection.query("ROLLBACK");
    }
    await connection.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--selftest")) {
    throw new Error("unsupported argument");
  }

  if (args.includes("--selftest")) {
    const passed = runSelfTest();
    console.log(
      JSON.stringify({ ok: true, counts: { selfTestsPassed: passed } }),
    );
    return;
  }

  const rows = await readRowsFromDatabase();
  console.log(JSON.stringify(summarizeRows(rows)));
}

const isDirectRun =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main().catch(() => {
    console.error(
      JSON.stringify({
        ok: false,
        counts: { structuralErrors: 1 },
      }),
    );
    process.exitCode = 1;
  });
}
