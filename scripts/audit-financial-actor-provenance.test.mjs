import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_SQL,
  assertReadOnlySql,
  classifyActorEvidence,
  summarizeRows,
} from "./audit-financial-actor-provenance.mjs";

const incompleteRow = (overrides = {}) => ({
  entryType: "PAYMENT_IN",
  missingCreatedBy: 1,
  missingNameSnapshot: 1,
  entryCreatedBy: null,
  receiptApprovedBy: null,
  receiptCreatedBy: null,
  invoiceCreatedBy: null,
  ...overrides,
});

test("audit query is one read-only SELECT without data-changing SQL", () => {
  assert.doesNotThrow(() => assertReadOnlySql(AUDIT_SQL));
  assert.match(AUDIT_SQL.trimStart(), /^SELECT\b/i);
  assert.doesNotMatch(AUDIT_SQL, /\b(?:UPDATE|INSERT|DELETE)\b/i);

  for (const unsafe of [
    "UPDATE accountingEntries SET createdBy = 1",
    "INSERT INTO accountingEntries (id) VALUES (1)",
    "DELETE FROM accountingEntries",
    "SELECT 1; DROP TABLE accountingEntries",
    "SELECT * FROM accountingEntries FOR UPDATE",
  ]) {
    assert.throws(() => assertReadOnlySql(unsafe), /read-only/i);
  }
});

test("an approved receipt actor is deterministic for a payment", () => {
  assert.deepEqual(
    classifyActorEvidence(
      incompleteRow({ receiptApprovedBy: 41, receiptCreatedBy: 12 }),
    ),
    {
      status: "deterministic",
      evidence: "receipt_approved_by",
      documentedNameSnapshotAvailable: false,
    },
  );
});

test("only a source that proves the actor for this entry type is accepted", () => {
  assert.deepEqual(
    classifyActorEvidence(
      incompleteRow({
        entryType: "SALE",
        invoiceCreatedBy: 52,
      }),
    ),
    {
      status: "deterministic",
      evidence: "invoice_created_by",
      documentedNameSnapshotAvailable: false,
    },
  );

  assert.deepEqual(
    classifyActorEvidence(
      incompleteRow({ entryType: "RETURN", invoiceCreatedBy: 99 }),
    ),
    {
      status: "unresolved",
      evidence: "no_explicit_evidence",
      documentedNameSnapshotAvailable: false,
    },
  );
});

test("the classifier never guesses from notes, dedupe keys, or entry type", () => {
  const classification = classifyActorEvidence(
    incompleteRow({
      entryType: "SALE",
      notes: "created by user 77",
      dedupeKey: "SALE:77",
      actorName: "PII_SENTINEL",
    }),
  );

  assert.deepEqual(classification, {
    status: "unresolved",
    evidence: "no_explicit_evidence",
    documentedNameSnapshotAvailable: false,
  });
});

test("an existing entry actor remains authoritative while a source conflict is surfaced", () => {
  assert.deepEqual(
    classifyActorEvidence(
      incompleteRow({
        missingCreatedBy: 0,
        entryCreatedBy: 12,
        receiptCreatedBy: 12,
      }),
    ),
    {
      status: "deterministic",
      evidence: "entry_actor_corroborated",
      documentedNameSnapshotAvailable: false,
    },
  );

  assert.deepEqual(
    classifyActorEvidence(
      incompleteRow({
        missingCreatedBy: 0,
        entryCreatedBy: 12,
        receiptApprovedBy: 13,
      }),
    ),
    {
      status: "deterministic",
      evidence: "entry_actor_source_conflict",
      documentedNameSnapshotAvailable: false,
    },
  );
});

test("summary exposes counts only and never carries source IDs or PII", () => {
  const summary = summarizeRows([
    incompleteRow({ receiptCreatedBy: 41, secretName: "PII_SENTINEL" }),
    incompleteRow({
      entryType: "PURCHASE",
      missingCreatedBy: 0,
      entryCreatedBy: 88,
      receiptApprovedBy: 88,
      secretName: "PII_SENTINEL",
    }),
    incompleteRow({
      entryType: "SALE",
      invoiceCreatedBy: 5,
      secretName: "PII_SENTINEL",
    }),
  ]);

  assert.deepEqual(summary.counts.missingFields, {
    createdBy: 2,
    createdByNameSnapshot: 3,
    both: 2,
  });
  assert.equal(summary.counts.actorAttribution.deterministic, 3);
  assert.equal(summary.counts.actorAttribution.unresolved, 0);
  assert.equal(summary.counts.actorAttribution.conflictingEvidence, 0);
  assert.equal(
    summary.counts.historicalNameSnapshot.documentedSourceAvailable,
    0,
  );
  assert.equal(
    summary.counts.historicalNameSnapshot.unresolvedWithoutSnapshot,
    3,
  );
  assert.equal(JSON.stringify(summary).includes("PII_SENTINEL"), false);
  assert.equal(JSON.stringify(summary).includes("41"), false);
});
