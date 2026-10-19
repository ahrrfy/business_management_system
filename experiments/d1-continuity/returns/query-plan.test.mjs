import test from "node:test";
import assert from "node:assert/strict";
import { creditProjectionSql } from "./state.ts";
import { nativeLab } from "./native.mjs";
test("scoped history uses indexed receipt and ledger id sets instead of scanning complete financial tables", async () => {
  const l = await nativeLab({ name: "perf-indexed-plan" });
  try {
    for (const commandType of ["SALE", "COLLECT", "RETURN"]) {
      const envelope = {
        input: {
          commandType,
          clientRequestId: "query-plan-read-only",
          branchId: 1,
          shiftId: 1,
          invoiceId: 1,
          customerId: 1,
          lines: [],
        },
        actor: { userId: 1, branchId: 1, role: "cashier" },
      };
      const plan = (
        await l.db
          .prepare("EXPLAIN QUERY PLAN " + creditProjectionSql)
          .bind(JSON.stringify(envelope))
          .all()
      ).results;
      assert.ok(
        !plan.some((row) =>
          /^SCAN (receipts|accountingEntries)( |$)/.test(row.detail),
        ),
        JSON.stringify(
          plan.filter((row) => /receipts|accountingEntries/.test(row.detail)),
        ),
      );
      assert.ok(
        plan.some((row) => row.detail.includes("returns_receipt_ledger")),
      );
    }
  } finally {
    await l.close();
  }
});
