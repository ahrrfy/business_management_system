import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  accrualCorrectionRequests,
  accrualObligationEvents,
  accrualObligations,
  assetMaintenance,
  expenses,
  fixedAssets,
} from "../../../drizzle/schema";

const migration = readFileSync(
  new URL(
    "../../../drizzle/migrations/0196_accrual_obligation_lifecycle.sql",
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

function checkNames(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).checks.map((item) => item.name);
}

function columnNames(table: Parameters<typeof getTableConfig>[0]) {
  return new Set(getTableConfig(table).columns.map((column) => column.name));
}

function foreignKeyNames(table: Parameters<typeof getTableConfig>[0]) {
  return getTableConfig(table).foreignKeys.map((item) => item.getName());
}

function schemaIdentifierNames(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table);
  return [
    ...config.indexes.map((item) => item.config.name),
    ...config.foreignKeys.map((item) => item.getName()),
    ...config.checks.map((item) => item.name),
    ...config.uniqueConstraints
      .map((item) => item.getName())
      .filter((name): name is string => Boolean(name)),
  ];
}

describe("0193 accrual-obligation lifecycle schema", () => {
  it("makes unpaid expense recognition explicit and acquisition commands idempotent", () => {
    expect(expenses.paymentMethod.enumValues).toContain("ACCRUAL");
    expect(expenses.source.enumValues).toContain("ACCRUAL");
    expect(checkNames(expenses)).toContain("chk_expense_accrual_method");

    for (const table of [fixedAssets, assetMaintenance]) {
      expect("clientRequestId" in table).toBe(true);
      expect("requestPayloadHash" in table).toBe(true);
      expect(table.clientRequestId.notNull).toBe(false);
      expect(table.requestPayloadHash.notNull).toBe(false);
    }
    expect(assetMaintenance.financialStatus.enumValues).toEqual([
      "ACTIVE",
      "CORRECTION_PENDING",
      "CORRECTED",
    ]);
    expect(fixedAssets.recognitionStatus.enumValues).toEqual([
      "ACTIVE",
      "CORRECTION_PENDING",
      "CORRECTED",
    ]);
    expect("evidenceReference" in assetMaintenance).toBe(true);
    expect("vendorSupplierId" in assetMaintenance).toBe(true);
  });

  it("defines the exact current projection and source/beneficiary invariants", () => {
    const obligationColumns = [
      "id",
      "kind",
      "branchId",
      "expenseId",
      "purchaseOrderId",
      "assetId",
      "maintenanceId",
      "sourceKey",
      "recognizedAmount",
      "status",
      "beneficiaryType",
      "beneficiarySupplierId",
      "beneficiaryName",
      "evidenceReference",
      "plannedPaymentMethod",
      "clientRequestId",
      "sourceHash",
      "recognizedBy",
      "recognizedAt",
      "updatedAt",
    ];
    for (const name of obligationColumns) {
      expect(name in accrualObligations).toBe(true);
    }
    expect(columnNames(accrualObligations)).toEqual(new Set(obligationColumns));
    expect(accrualObligations.kind.enumValues).toEqual([
      "PURCHASE_SHIPPING",
      "ASSET_MAINTENANCE",
      "ASSET_ACQUISITION_CASH",
      "ASSET_ACQUISITION_SUPPLIER",
    ]);
    expect(accrualObligations.status.enumValues).toEqual([
      "ACCRUED_UNPAID",
      "PAYMENT_PENDING",
      "PAYABLE_UNSETTLED",
      "PAID",
      "CORRECTION_PENDING",
      "REFUND_PENDING",
      "REFUNDED",
      "RECOGNITION_REVERSED",
    ]);
    expect(accrualObligations.beneficiaryType.enumValues).toEqual([
      "SUPPLIER",
      "OTHER",
    ]);
    expect(checkNames(accrualObligations)).toEqual(
      expect.arrayContaining([
        "chk_accrual_obligation_positive",
        "chk_accrual_obligation_evidence",
        "chk_accrual_obligation_beneficiary",
        "chk_accrual_obligation_supplier_kind",
        "chk_accrual_obligation_source_shape",
      ]),
    );
    expect(migration).toMatch(
      /'PURCHASE_SHIPPING'[\s\S]*`expenseId` IS NOT NULL[\s\S]*`purchaseOrderId` IS NOT NULL[\s\S]*`assetId` IS NULL[\s\S]*`maintenanceId` IS NULL/,
    );
    expect(migration).toMatch(
      /'ASSET_MAINTENANCE'[\s\S]*`expenseId` IS NOT NULL[\s\S]*`purchaseOrderId` IS NULL[\s\S]*`assetId` IS NOT NULL[\s\S]*`maintenanceId` IS NOT NULL/,
    );
  });

  it("keeps monetary history append-only and permits active-owner self-approval", () => {
    expect(columnNames(accrualObligationEvents)).toEqual(
      new Set([
        "id",
        "obligationId",
        "eventType",
        "amount",
        "receiptId",
        "accountingEntryId",
        "evidenceReference",
        "actorId",
        "reviewerId",
        "dedupeKey",
        "createdAt",
      ]),
    );
    expect(accrualObligationEvents.eventType.enumValues).toEqual([
      "RECOGNIZED",
      "PAYMENT_REQUESTED",
      "PAYMENT_REJECTED",
      "PAYMENT_SETTLED",
      "CORRECTION_REQUESTED",
      "CORRECTION_REJECTED",
      "SETTLEMENT_REVERSED",
      "RECOGNITION_REVERSED",
    ]);
    expect(checkNames(accrualObligationEvents)).toEqual(
      expect.arrayContaining([
        "chk_accrual_event_positive_amount",
        "chk_accrual_event_reference_shape",
      ]),
    );
    expect(migration).toMatch(
      /'PAYMENT_REQUESTED','PAYMENT_REJECTED'[\s\S]*`accountingEntryId` IS NULL AND `receiptId` IS NOT NULL/,
    );
    expect(migration).toMatch(
      /'CORRECTION_REQUESTED','CORRECTION_REJECTED'[\s\S]*`accountingEntryId` IS NULL AND `receiptId` IS NULL/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER `trg_accrual_event_no_update` BEFORE UPDATE ON `accrualObligationEvents`/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER `trg_accrual_event_no_delete` BEFORE DELETE ON `accrualObligationEvents`/,
    );
    expect(
      migration.match(/events are (?:immutable|append-only)/g),
    ).toHaveLength(2);

    const correctionColumns = [
      "id",
      "obligationId",
      "status",
      "previousObligationStatus",
      "reason",
      "externalEvidenceReference",
      "attachmentUrl",
      "refundPaymentMethod",
      "refundCashBucket",
      "refundReferenceNumber",
      "refundCardLastFour",
      "refundRequestReceiptId",
      "clientRequestId",
      "payloadHash",
      "requestedBy",
      "reviewedBy",
      "rejectionReason",
      "requestedAt",
      "reviewedAt",
    ];
    for (const name of correctionColumns) {
      expect(name in accrualCorrectionRequests).toBe(true);
    }
    expect(columnNames(accrualCorrectionRequests)).toEqual(
      new Set(correctionColumns),
    );
    expect(accrualCorrectionRequests.status.enumValues).toEqual([
      "PENDING",
      "APPROVED",
      "REJECTED",
    ]);
    expect(checkNames(accrualCorrectionRequests)).toEqual(
      expect.arrayContaining([
        "chk_accrual_correction_evidence",
        "chk_accrual_correction_status",
        "chk_accrual_correction_refund_shape",
      ]),
    );
    expect(checkNames(accrualCorrectionRequests)).not.toContain(
      "chk_accrual_correction_maker_checker",
    );
    expect(migration).toMatch(
      /INDEX `idx_accrual_correction_refund_receipt` \(`refundRequestReceiptId`\)/,
    );
  });

  it("is strict, ordered after 0195 and keeps every identifier MySQL-safe", () => {
    expect(migration).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(migration).not.toMatch(/\bINSERT\s+IGNORE\b/i);
    expect(migration).not.toMatch(/UPDATE `(?:fixedAssets|assetMaintenance)`/);
    expect(migration.match(/DEFAULT 'ACTIVE'/g)).toHaveLength(2);
    const identifiers = [
      ...migration.matchAll(/\b(?:CONSTRAINT|INDEX|TRIGGER)\s+`([^`]+)`/g),
    ].map((match) => match[1]);
    expect(identifiers.filter((name) => name.length > 64)).toEqual([]);

    expect(
      journal.entries.filter((entry) => entry.idx >= 195 && entry.idx <= 196),
    ).toEqual([
      {
        idx: 195,
        version: "5",
        when: 1788052246000,
        tag: "0195_termination_advance_snapshot",
        breakpoints: true,
      },
      {
        idx: 196,
        version: "5",
        when: 1788052247000,
        tag: "0196_accrual_obligation_lifecycle",
        breakpoints: true,
      },
    ]);
  });

  it("names every 0196 foreign key explicitly and keeps schema identifiers within 64 characters", () => {
    const expectedForeignKeys = new Map([
      [assetMaintenance, ["fk_maint_vendor_supplier"]],
      [
        accrualObligations,
        [
          "fk_acc_ob_branch",
          "fk_acc_ob_expense",
          "fk_acc_ob_purchase",
          "fk_acc_ob_asset",
          "fk_acc_ob_maint",
          "fk_acc_ob_supplier",
          "fk_acc_ob_actor",
        ],
      ],
      [
        accrualObligationEvents,
        [
          "fk_acc_evt_obligation",
          "fk_acc_evt_receipt",
          "fk_acc_evt_entry",
          "fk_acc_evt_actor",
          "fk_acc_evt_reviewer",
        ],
      ],
      [
        accrualCorrectionRequests,
        [
          "fk_acc_corr_obligation",
          "fk_acc_corr_refund_receipt",
          "fk_acc_corr_requested_by",
          "fk_acc_corr_reviewed_by",
        ],
      ],
    ] as const);

    for (const [table, expected] of expectedForeignKeys) {
      const actual = foreignKeyNames(table);
      expect(actual).toEqual(expect.arrayContaining([...expected]));
      for (const name of expected) {
        expect(migration).toContain(`CONSTRAINT \`${name}\``);
      }
    }

    const all0193Identifiers = [
      expenses,
      fixedAssets,
      assetMaintenance,
      accrualObligations,
      accrualObligationEvents,
      accrualCorrectionRequests,
    ].flatMap(schemaIdentifierNames);
    expect(all0193Identifiers.filter((name) => name.length > 64)).toEqual([]);
  });
});
