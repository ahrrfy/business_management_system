import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  advanceSettlements,
  payrollAccountingEvents,
  payrollItems,
  payrollObligationAllocations,
  payrollObligations,
  payrollRemittanceRequests,
  payrollRuns,
} from "../../../drizzle/schema";
import { CHART_ACCOUNTS } from "../accounting/chartSeed";

const migration = readFileSync(
  new URL(
    "../../../drizzle/migrations/0188_payroll_and_expense_accrual.sql",
    import.meta.url,
  ),
  "utf8",
);

const journal = JSON.parse(
  readFileSync(
    new URL("../../../drizzle/migrations/meta/_journal.json", import.meta.url),
    "utf8",
  ),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

function columnNames(table: Parameters<typeof getTableConfig>[0]) {
  return new Set(getTableConfig(table).columns.map((column) => column.name));
}

describe("0185 payroll and expense accrual schema", () => {
  it("freezes approval revisions, legal evidence, branch grain and cancellation", () => {
    expect(payrollRuns.status.enumValues).toEqual([
      "draft",
      "approved",
      "paid",
      "cancelled",
    ]);
    const runColumns = columnNames(payrollRuns);
    for (const name of [
      "revisionNo",
      "accrualDate",
      "legalPolicySnapshot",
      "legalPolicyHash",
      "approvalSnapshotHash",
      "cancelledBy",
      "cancelledAt",
      "cancelReason",
    ]) {
      expect(runColumns.has(name)).toBe(true);
    }
    const itemColumns = columnNames(payrollItems);
    for (const name of [
      "branchIdSnapshot",
      "revisionNo",
      "wageReduction",
      "snapshotHash",
    ]) {
      expect(itemColumns.has(name)).toBe(true);
    }
    expect(
      getTableConfig(payrollItems).checks.map((check) => check.name),
    ).toContain("chk_payitem_wage_reduction_nonnegative");
  });

  it("defines an independent remaining-balance subledger with strict reversals", () => {
    const obligation = getTableConfig(payrollObligations);
    const obligationColumns = new Set(
      obligation.columns.map((column) => column.name),
    );
    for (const name of [
      "payrollObligationKind",
      "originalAmount",
      "remainingAmount",
      "payrollObligationStatus",
      "payrollObligationSourceType",
      "sourceKey",
      "branchIdSnapshot",
      "revisionNo",
    ]) {
      expect(obligationColumns.has(name)).toBe(true);
    }
    expect(obligation.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "chk_payroll_obligation_positive_original",
        "chk_payroll_obligation_remaining_range",
        "chk_payroll_obligation_status_balance",
        "chk_payroll_obligation_approval_source",
      ]),
    );

    const allocation = getTableConfig(payrollObligationAllocations);
    expect(allocation.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "chk_payroll_allocation_positive_amount",
        "chk_payroll_allocation_reversal_shape",
      ]),
    );
    expect(columnNames(payrollAccountingEvents).has("accountingEntryId")).toBe(
      true,
    );
    expect(columnNames(payrollAccountingEvents).has("sourceHash")).toBe(true);
  });

  it("requires remittance evidence columns (no DB-level maker/checker after 0333) and preserves advance history", () => {
    const remittance = getTableConfig(payrollRemittanceRequests);
    const remittanceColumns = new Set(
      remittance.columns.map((column) => column.name),
    );
    for (const name of [
      "payrollRemittanceKind",
      "requestedAmount",
      "authorityName",
      "referenceNumber",
      "supportingDocumentUrl",
      "receiptId",
      "createdBy",
      "approvedBy",
    ]) {
      expect(remittanceColumns.has(name)).toBe(true);
    }
    // ⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ بعد المالك — قيدُ
    // `chk_payroll_remittance_maker_checker` أُسقط بالهجرة 0333 (كان يمنع owner من اعتماد
    // ما أنشأه هو بنفسه بلا استثناء). راجع ownerSelfApprovalCheckConstraints.test.ts.
    expect(remittance.checks.map((check) => check.name)).not.toContain(
      "chk_payroll_remittance_maker_checker",
    );

    const advance = getTableConfig(advanceSettlements);
    const advanceColumns = new Set(
      advance.columns.map((column) => column.name),
    );
    for (const name of [
      "revisionNo",
      "advanceSettlementDirection",
      "reversalOfId",
      "sourceKey",
      "occurredAt",
    ]) {
      expect(advanceColumns.has(name)).toBe(true);
    }
    expect(advance.checks.map((check) => check.name)).toContain(
      "chk_advsettle_reversal_shape",
    );
    expect(migration).toMatch(
      /DROP FOREIGN KEY `advanceSettlements_runId_payrollRuns_id_fk`/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(`runId`\) REFERENCES `payrollRuns`\(`id`\) ON DELETE no action/,
    );
  });

  it("is a strict, ordered migration and never infers legacy branch ownership", () => {
    expect(migration).not.toMatch(/\bINSERT\s+IGNORE\b/i);
    expect(migration).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(migration).not.toMatch(
      /UPDATE\s+`payrollItems`[\s\S]*SET\s+`branchIdSnapshot`/i,
    );
    expect(migration).not.toMatch(/payrollItems[\s\S]*JOIN\s+`?employees`?/i);

    const tail = journal.entries.filter(
      (entry) => entry.idx >= 181 && entry.idx <= 188,
    );
    expect(tail.map((entry) => entry.idx)).toEqual([
      181, 182, 183, 184, 185, 186, 187, 188,
    ]);
    expect(tail.map((entry) => entry.tag)).toEqual([
      "0181_store_fulfillment_branch",
      "0182_expense_approval_lifecycle",
      "0183_pos_external_payment_reference",
      "0184_shift_funding_source_links",
      "0185_cash_drop_reference_uniqueness",
      "0186_offline_recovery_queue",
      "0187_double_entry_posting_profiles",
      "0188_payroll_and_expense_accrual",
    ]);
    expect(tail.map((entry) => entry.when)).toEqual([
      1787879434000, 1787879435000, 1787879436000, 1787879437000,
      1787965837000, 1788052237000, 1788052238000, 1788052239000,
    ]);
  });

  it("seeds exact payroll, accrued-expense and interbranch clearing roles", () => {
    const expected = new Map<string, "ASSET" | "LIABILITY" | "EXPENSE">([
      ["PAYROLL_TAX_PAYABLE", "LIABILITY"],
      ["SOCIAL_SECURITY_PAYABLE", "LIABILITY"],
      ["EOS_PROVISION", "LIABILITY"],
      ["SOCIAL_SECURITY_EXPENSE", "EXPENSE"],
      ["EOS_EXPENSE", "EXPENSE"],
      ["ACCRUED_EXPENSES", "LIABILITY"],
      ["INTERBRANCH_CLEARING", "ASSET"],
    ]);
    const selected = CHART_ACCOUNTS.filter(
      (account) => account.systemRole && expected.has(account.systemRole),
    );
    expect(selected).toHaveLength(expected.size);
    expect(new Set(selected.map((account) => account.code)).size).toBe(
      expected.size,
    );
    for (const account of selected) {
      expect(account.type).toBe(expected.get(account.systemRole!));
      expect(migration).toContain(`'${account.systemRole}'`);
    }
  });
});
