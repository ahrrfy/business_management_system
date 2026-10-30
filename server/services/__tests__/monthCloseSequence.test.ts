import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../../db";
const transactionProbe = vi.hoisted(() => ({ events: [] as string[], gateError: false, authorityError: false }));
vi.mock("../../db", () => ({ getDb: () => ({ transaction: async (fn: (tx: Tx) => Promise<unknown>) => {
  transactionProbe.events.push("begin");
  const result = await fn({} as Tx);
  transactionProbe.events.push("commit");
  return result;
} }) }));
vi.mock("../reports/monthCloseGate", () => ({
  lockFinancialPostingGate: async () => {
    transactionProbe.events.push("writer");
    if (transactionProbe.gateError) throw new Error("gate rejected");
  },
  lockCompanyMonthCloseGate: async () => { transactionProbe.events.push("exclusive"); },
  isMonthCloseGateMissing: () => false,
  ensureFinancialPostingGate: vi.fn(),
}));
// Keep the real async dispatch scope and withTx; substitute only stored authority I/O.
vi.mock("../authorization/operationAuthority", () => ({ assertOperationAuthorityTx: async () => {
  transactionProbe.events.push("authority");
  if (transactionProbe.authorityError) throw new Error("authority rejected");
} }));
import { withGovernanceTx, withTx, assertFinancialWriterGateHeld } from "../tx";
import { withOperationAuthority } from "../authorization/operationExecutionScope";
import {
  monthCloseCertificates,
  monthCloseEvents,
  monthCloseSequence,
  yearEndReopenRequests,
} from "../../../drizzle/schema";
import {
  canonicalCloseJson,
  closeSha256,
  monthCutoff,
  monthOfCutoff,
  nextMonth,
} from "../reports/monthCloseSequence";
import { certificateEvidenceStructuralReasons } from "../reports/monthCloseCertificate";

function chunk(datasetCode: string, chunkNo = 1, rows = [{ id: 1 }]) {
  const referenceCanonical = canonicalCloseJson(rows);
  return {
    datasetCode,
    chunkNo,
    rowCount: rows.length,
    minId: rows.length ? Number(rows[0]!.id) : null,
    maxId: rows.length ? Number(rows[rows.length - 1]!.id) : null,
    canonicalRowsHash: closeSha256(referenceCanonical),
    referenceCanonical,
  };
}

describe("month-close canonical sequence contract", () => {
  beforeEach(() => {
    transactionProbe.events = [];
    transactionProbe.gateError = false;
    transactionProbe.authorityError = false;
  });
  it("orders object keys recursively and produces a stable SHA-256 seal", () => {
    const left = canonicalCloseJson({
      z: [{ b: "2", a: "1" }],
      a: { y: false, x: null },
    });
    const right = canonicalCloseJson({
      a: { x: null, y: false },
      z: [{ a: "1", b: "2" }],
    });

    expect(left).toBe(right);
    expect(closeSha256(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(closeSha256(left)).toBe(closeSha256(right));
  });

  it("rejects timestamps and non-integer numbers until producers normalize them", () => {
    expect(() => canonicalCloseJson({ at: new Date() })).toThrow(
      "convert Date",
    );
    expect(() => canonicalCloseJson({ amount: 1.5 })).toThrow("safe integers");
  });

  it("handles Baghdad acceptance months without skipping December or leap February", () => {
    expect(monthCutoff("2024-02")).toBe("2024-02-29");
    expect(monthOfCutoff("2024-02-29")).toBe("2024-02");
    expect(nextMonth("2025-12")).toBe("2026-01");
    expect(() => monthOfCutoff("2025-12-30")).toThrow();
  });

  it("fails closed on missing mandatory evidence, chunk gaps, and count/range drift", () => {
    const datasets = [
      "ACCOUNTING_ENTRIES",
      "JOURNAL",
      "ROLE_BALANCES",
      "WIP_WORK_ORDERS",
      "APPROVAL_READINESS",
      "CLOSE_INTEGRITY",
    ].map((code) => chunk(code));
    expect(
      certificateEvidenceStructuralReasons("MONTH_CLOSE", datasets),
    ).toEqual([]);

    const missing = datasets.filter(
      (item) => item.datasetCode !== "ROLE_BALANCES",
    );
    expect(
      certificateEvidenceStructuralReasons("MONTH_CLOSE", missing),
    ).toContain("MANDATORY_DATASET_MISSING:ROLE_BALANCES");

    const broken = datasets.concat({
      ...chunk("JOURNAL", 3, [{ id: 9 }]),
      rowCount: 2,
      minId: 8,
    });
    expect(certificateEvidenceStructuralReasons("MONTH_CLOSE", broken)).toEqual(
      expect.arrayContaining([
        "EVIDENCE_ROW_COUNT_MISMATCH:JOURNAL:3",
        "EVIDENCE_RANGE_MISMATCH:JOURNAL:3",
        "EVIDENCE_CHUNK_SEQUENCE_BROKEN:JOURNAL",
      ]),
    );
    expect(
      certificateEvidenceStructuralReasons("YEAR_END", datasets),
    ).toContain("MANDATORY_DATASET_MISSING:YEAR_END_EVIDENCE");
  });

  it("keeps raw migrations aligned with Drizzle physical enum column names", () => {
    const schemaColumns = [
      ...getTableConfig(monthCloseCertificates).columns.map(
        (column) => column.name,
      ),
      ...getTableConfig(monthCloseEvents).columns.map((column) => column.name),
      ...getTableConfig(monthCloseSequence).columns.map(
        (column) => column.name,
      ),
      ...getTableConfig(yearEndReopenRequests).columns.map(
        (column) => column.name,
      ),
    ];
    const expectedPhysicalColumns = [
      "monthCloseCertificateKind",
      "certificateDoubleEntryMode",
      "monthCloseEventType",
      "monthCloseSequenceStatus",
      "yearEndReopenStatus",
    ];
    expect(schemaColumns).toEqual(
      expect.arrayContaining(expectedPhysicalColumns),
    );

    const migrationSql = [
      readFileSync(
        "drizzle/migrations/0192_month_close_sequence_certificates.sql",
        "utf8",
      ),
      readFileSync(
        "drizzle/migrations/0197_year_end_reopen_requests.sql",
        "utf8",
      ),
      readFileSync(
        "drizzle/migrations/extras/0192_0197_month_close_triggers.sql",
        "utf8",
      ),
    ].join("\n");
    for (const column of expectedPhysicalColumns) {
      expect(migrationSql).toContain(`\`${column}\``);
    }
    expect(migrationSql).not.toMatch(
      /`(?:kind|doubleEntryMode|eventType|status)`/,
    );
    expect(migrationSql).toContain(
      "((`month` IS NULL AND `periodId` IS NULL) OR (`month` IS NOT NULL AND `periodId` IS NOT NULL))",
    );
    expect(migrationSql).toContain(
      "(`monthCloseEventType` = 'UNLOCK' AND `month` IS NOT NULL AND `requestId` IS NULL AND `periodId` IS NOT NULL)",
    );
  });

  it("acquires the default financial gate before real scoped authority and domain work", async () => {
    await expect(withOperationAuthority({ actor: { userId: 7 }, path: "purchases.decideControl", legacyAllowed: () => true },
      () => withTx(async tx => {
        assertFinancialWriterGateHeld(tx);
        transactionProbe.events.push("domain");
        return "done";
      }))).resolves.toBe("done");
    expect(transactionProbe.events).toEqual(["begin", "writer", "authority", "domain", "commit"]);
  });

  it("uses the exclusive gate at governance entry without taking a writer gate", async () => {
    await withGovernanceTx(async tx => {
      assertFinancialWriterGateHeld(tx);
      transactionProbe.events.push("domain");
    });
    expect(transactionProbe.events).toEqual(["begin", "exclusive", "domain", "commit"]);
  });

  it.each(["gate", "authority"] as const)("does not enter the domain when %s fails", async failure => {
    transactionProbe.gateError = failure === "gate";
    transactionProbe.authorityError = failure === "authority";
    const domain = vi.fn(async () => "forbidden");
    await expect(withOperationAuthority({ actor: { userId: 7 }, path: "purchases.decideControl", legacyAllowed: () => true },
      () => withTx(domain))).rejects.toThrow(`${failure} rejected`);
    expect(domain).not.toHaveBeenCalled();
    expect(transactionProbe.events).toEqual(failure === "gate" ? ["begin", "writer"] : ["begin", "writer", "authority"]);
  });

  it("routes close governance exclusively and retains explicit writer entries", () => {

    const yearRouter = readFileSync("server/routers/yearEndRouter.ts", "utf8");
    const periodRouter = readFileSync(
      "server/routers/periodLockRouter.ts",
      "utf8",
    );
    expect(yearRouter.match(/withGovernanceTx\(/g)).toHaveLength(4);
    expect(periodRouter.match(/withGovernanceTx\(/g)).toHaveLength(5);

    const saleSource = readFileSync("server/services/sale/create.ts", "utf8");
    const shiftSource = readFileSync("server/services/shiftService.ts", "utf8");
    expect(saleSource).toContain('{ gate: "FINANCIAL_WRITER" }');
    expect(shiftSource.match(/gate: "FINANCIAL_WRITER"/g)).toHaveLength(2);
  });
});
