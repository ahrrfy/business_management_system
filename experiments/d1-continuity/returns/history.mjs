import assert from "node:assert/strict";
import { canonical } from "../cash/paged-client.mjs";

// Historical financial rows stay immutable. Counter/epoch rows advance only by
// the proven new invoices and the independently signed checkpoint.
export function assertHistoricalRows({
  baselineRows,
  recoveredRows,
  before,
  recovered,
  tableNames,
}) {
  const known = new Set([
    ...tableNames,
    "cashEpoch",
    "cashCommands",
    "cashOutbox",
  ]);
  const addedInvoices = recovered.counts.invoices - before.counts.invoices;
  assert.ok(Number.isSafeInteger(addedInvoices) && addedInvoices >= 0);
  const omitUpdatedAt = ({ updatedAt, ...rest }) => rest;
  for (const [table, rows] of Object.entries(baselineRows)) {
    assert.ok(known.has(table), "Unknown snapshot table: " + table);
    for (const row of rows) {
      let expected = row;
      if (table === "cashEpoch") expected = { ...row, epoch: recovered.epoch };
      if (table === "documentCounters" && row.counterKey === "invoice") {
        assert.ok(Number.isSafeInteger(row.lastValue));
        expected = { ...row, lastValue: row.lastValue + addedInvoices };
      }
      const timestampMayRefresh =
        (table === "customers" && row.id === 1) ||
        (table === "branchStock" &&
          row.branchId === 1 &&
          [1, 2].includes(row.variantId)) ||
        (table === "productVariants" && [1, 2].includes(row.id)) ||
        (table === "documentCounters" && row.counterKey === "invoice");
      const normalize = timestampMayRefresh ? omitUpdatedAt : (value) => value;
      assert.ok(
        recoveredRows[table]?.some(
          (candidate) =>
            canonical(normalize(candidate)) === canonical(normalize(expected)),
        ),
        "Historical row changed: " + table,
      );
    }
  }
  return { addedInvoices, preservedTables: Object.keys(baselineRows).length };
}
