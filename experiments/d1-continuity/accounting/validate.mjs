// Offline assertions against full captured rows: no database or provider access.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Decimal from "decimal.js";
export function validateEvidence(evidence) {
  const sum = (rows, field) =>
    rows.reduce((n, r) => n.plus(r[field]), new Decimal(0)).toFixed(2);
  const normal = evidence.scenarios.filter((s) =>
    /^\w+-(cash-partial-full|credit-unpaid|credit-part-paid-collected)$/.test(
      s.name,
    ),
  );
  for (const scenario of normal) {
    const final = scenario.commands.at(-1).after;
    const expected = scenario.name.endsWith("credit-unpaid")
      ? "750.30"
      : "1250.52";
    assert.equal(
      sum(final.journalLines, "debit"),
      expected,
      scenario.name + " total debit",
    );
    assert.equal(
      sum(final.journalLines, "credit"),
      expected,
      scenario.name + " total credit",
    );
    assert.equal(sum(final.accountingEntries, "revenue"), "0.00");
    assert.equal(sum(final.accountingEntries, "cost"), "0.00");
    assert.equal(
      final.receipts
        .reduce(
          (n, r) =>
            r.direction === "IN" ? n.plus(r.amount) : n.minus(r.amount),
          new Decimal(0),
        )
        .toFixed(2),
      "0.00",
    );
    assert.equal(final.invoices[0].total, "250.11");
    assert.equal(final.invoices[0].returnedTotal, "250.11");
    assert.equal(
      final.productVariants.find((v) => v.id === 1).costPrice,
      "41.68",
    );
    assert.equal(
      final.doubleEntrySettings[0].policyApprovalPolicyHash,
      evidence.policyHash,
    );
    for (const source of final.accountingEntries) {
      assert.equal(source.postingIntentJson.profile, source.postingProfile);
      assert.equal(source.postingIntentJson.entryType, source.entryType);
      assert.match(source.postingIntentHash, /^[a-f0-9]{64}$/);
      assert.ok(
        final.journalEntries.some(
          (j) => String(j.entryId) === String(source.id),
        ),
      );
    }
    for (const line of final.journalLines) {
      assert.ok(
        final.statutoryAccountMappings.some(
          (m) =>
            String(m.internalAccountId) === String(line.accountId) &&
            String(m.statutoryAccountId) === String(line.statutoryAccountId),
        ),
      );
    }
    assert.equal(final.invoices.length, 1);
    assert.equal(final.inventoryMovements.length, 3);
  }
  assert.equal(normal.length, 6);
  for (const scenario of evidence.scenarios) {
    for (const command of scenario.commands) {
      if (command.error)
        assert.deepEqual(
          command.after,
          command.before,
          scenario.name + " rejection rollback",
        );
      if (scenario.fault && command.error)
        assert.match(
          command.error.message,
          scenario.fault === "missing-map" ? /يفتقد/ : /ACTIVE/,
        );
    }
  }
  return {
    normalScenarios: normal.length,
    exactDecimalTotals: true,
    sourceEvidence: true,
  };
}
if (process.argv[1]?.endsWith("validate.mjs"))
  console.log(
    JSON.stringify(
      validateEvidence(
        JSON.parse(
          await readFile(
            process.argv[2] ??
              "experiments/d1-continuity/accounting/results/mysql-oracle.json",
            "utf8",
          ),
        ),
      ),
    ),
  );
