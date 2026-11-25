import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exchangeTransactions } from "../../drizzle/schema";
import { computeDepreciation } from "../services/assets/depreciation";

describe("Wave 4 — Treasury, FX executionSeq, Payroll Rebuild & Asset Depreciation Invariants", () => {
  it("computeDepreciation لا يضاعف الإهلاك المرحّل مسبقاً (storedAccum) حين يكون إهلاك العمر أصغر بيوم أو تقريب", () => {
    const res = computeDepreciation(
      {
        purchaseValue: "1200000",
        salvageValue: "0",
        usefulLifeYears: 4,
        depreciationMethod: "sl",
        purchaseDate: "2025-01-02",
        status: "active",
        openingDepreciation: "0",
        accumulatedDepreciation: "300000",
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    // السنة الأولى = 300,000؛ عند 2026-01-01 (أقل بيوم واحد من سنة كاملة) يجب ألا يجمع 300,000 + ~299,178 = ~599,178!
    expect(res.accumulated).toBe(300000);
    expect(res.bookValue).toBe(900000);
  });

  it("computeDepreciation يحافظ على جمع الإهلاك الافتتاحي السابق للنظام فوق إهلاك المدة اللاحقة", () => {
    const res = computeDepreciation(
      {
        purchaseValue: "2000000",
        salvageValue: "0",
        usefulLifeYears: 5,
        depreciationMethod: "sl",
        purchaseDate: "2025-01-01",
        status: "active",
        openingDepreciation: "800000",
        accumulatedDepreciation: "800000",
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    // إهلاك سنة واحدة (~399,726 على أساس 365.25 يوماً) يضاف فوق الإهلاك الافتتاحي (800,000) دون مضاعفة storedAccum
    expect(res.accumulated).toBe(1199726);
    expect(res.bookValue).toBe(800274);
  });

  it("مخطط exchangeTransactions وهجرة 0433 يثبتان عمودَي executionSeq وexecutedAt", () => {
    expect(exchangeTransactions.executionSeq).toBeDefined();
    expect(exchangeTransactions.executedAt).toBeDefined();
    const sql = readFileSync(
      new URL(
        "../../drizzle/migrations/0433_exchange_txn_execution_seq.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN `executionSeq` bigint NULL");
    expect(sql).toContain("ADD COLUMN `executedAt` timestamp(3) NULL");
  });

  it("تحويلات الخزينة وإلغاء سندات التوصيل وإعادة بناء مسودة الرواتب المعاد فتحها موصولة بحراسها", () => {
    const cashTransferSrc = readFileSync(
      new URL("../services/cashTransferService.ts", import.meta.url),
      "utf8",
    );
    const lockMatches = cashTransferSrc.match(
      /lockMaterializedCashReceiptSourceForWrite\s*\(/g,
    );
    expect(lockMatches?.length).toBeGreaterThanOrEqual(2);

    const voucherCancelSrc = readFileSync(
      new URL("../services/voucher/cancel.ts", import.meta.url),
      "utf8",
    );
    expect(voucherCancelSrc).toContain('r.internalNote.startsWith("DELIVERY_PARTY:")');

    const payrollGenSrc = readFileSync(
      new URL("../services/payroll/generate.ts", import.meta.url),
      "utf8",
    );
    expect(payrollGenSrc).toContain("reopenedDraftRunId");
  });
});
