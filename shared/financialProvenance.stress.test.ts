import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  computeProvenanceReconciliation,
  type ProvenanceSubItem,
  type FinancialCellProvenancePayload,
} from "./financialProvenance";

describe("Milestone 1 Empirical Stress Test & Boundary Harness", () => {
  describe("1. Extreme Amounts (Billions & Trillions IQD)", () => {
    it("handles 100 Billion IQD exact match", () => {
      const total = "100000000000.00";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "دفعة مشاريع كبرى 1", amount: "60000000000.00" },
        { id: 2, label: "دفعة مشاريع كبرى 2", amount: "40000000000.00" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("100000000000.00");
      expect(recon.subItemsSum).toBe("100000000000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("handles 1 Trillion IQD with formatted string commas", () => {
      const total = "1,000,000,000,000.00 د.ع";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "استثمار أ", amount: "750,000,000,000.00" },
        { id: 2, label: "استثمار ب", amount: "250,000,000,000.00" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("1000000000000.00");
      expect(recon.subItemsSum).toBe("1000000000000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("handles amounts exceeding Number.MAX_SAFE_INTEGER when passed as string", () => {
      // 9,007,199,254,740,991 is MAX_SAFE_INTEGER (~9 quadrillion)
      const total = "99999999999999999.00";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "رصيد سيادي 1", amount: "50000000000000000.00" },
        { id: 2, label: "رصيد سيادي 2", amount: "49999999999999999.00" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("99999999999999999.00");
      expect(recon.subItemsSum).toBe("99999999999999999.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });
  });

  describe("2. Negative Balances, Mixed Adjustments & Deficits", () => {
    it("handles net negative balance with negative sub-items", () => {
      const total = "-75000.00";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "عجز خزينة رئيسية", amount: "-50000.00" },
        { id: 2, label: "عجز نقطة بيع", amount: -25000 },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("-75000.00");
      expect(recon.subItemsSum).toBe("-75000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("handles mixed positive and negative sub-items reconciling to net positive", () => {
      // Total 40,000 = +60,000 (sale) - 20,000 (return/discount)
      const total = 40000;
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "إجمالي المبيعات", amount: 60000 },
        { id: 2, label: "مردودات مبيعات", amount: -20000 },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("40000.00");
      expect(recon.subItemsSum).toBe("40000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("handles mixed positive and negative sub-items reconciling to net negative", () => {
      // Total -15,000 = +10,000 - 25,000
      const total = "-15,000 د.ع";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "مقبوضات", amount: "10,000.00" },
        { id: 2, label: "مدفوعات", amount: "-25,000.00" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("-15000.00");
      expect(recon.subItemsSum).toBe("-15000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("detects discrepancy when signs differ (positive total vs negative sum)", () => {
      const total = "10000.00";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "بند سالب خاطئ", amount: "-10000.00" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("10000.00");
      expect(recon.subItemsSum).toBe("-10000.00");
      expect(recon.discrepancy).toBe("20000.00");
      expect(recon.isFullyReconciled).toBe(false);
    });

    it("handles net zero total with balancing debit and credit entries", () => {
      const total = "0.00";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "تسوية مدين", amount: 15000 },
        { id: 2, label: "تسوية دائن", amount: -15000 },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("0.00");
      expect(recon.subItemsSum).toBe("0.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });
  });

  describe("3. Fractional Amounts, Decimal Precision & Rounding Epsilon", () => {
    it("tolerates rounding differences within epsilon threshold (<= 0.005)", () => {
      // 100.00 vs 100.004 -> diff 0.004 <= 0.005
      const recon = computeProvenanceReconciliation("100.00", [
        { id: 1, label: "بند أ", amount: "100.004" },
      ]);
      expect(recon.isFullyReconciled).toBe(true);
      expect(recon.discrepancy).toBe("0.00");
    });

    it("rejects rounding differences exceeding epsilon threshold (> 0.005)", () => {
      // 100.00 vs 100.006 -> sum rounds to 100.01, diff is 0.01 > 0.005
      const recon = computeProvenanceReconciliation("100.00", [
        { id: 1, label: "بند أ", amount: "100.006" },
      ]);
      expect(recon.isFullyReconciled).toBe(false);
      expect(recon.discrepancy).toBe("0.01");
    });

    it("handles thirds division (33.333333 x 3 = 100.00)", () => {
      const total = "100.00";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "ثلث أول", amount: "33.333333" },
        { id: 2, label: "ثلث ثاني", amount: "33.333333" },
        { id: 3, label: "ثلث ثالث", amount: "33.333334" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("100.00");
      expect(recon.subItemsSum).toBe("100.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });
  });

  describe("4. Arabic Numerals (Eastern Arabic Digits) & Suffixes", () => {
    it("converts pure Eastern Arabic digits (٠١٢٣٤٥٦٧٨٩)", () => {
      const total = "١٥٠٠٠٠٠";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "بند ١", amount: "١٠٠٠٠٠٠" },
        { id: 2, label: "بند ٢", amount: "٥٠٠٠٠٠" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("1500000.00");
      expect(recon.subItemsSum).toBe("1500000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("handles Eastern Arabic digits with Iraqi Dinar currency suffix and commas", () => {
      const total = "١,٢٥٠,٠٠٠ د.ع";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "دفعة نقدية", amount: "٧٥٠,٠٠٠ د.ع" },
        { id: 2, label: "باقي الحساب", amount: "٥٠٠,٠٠٠ د.ع" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("1250000.00");
      expect(recon.subItemsSum).toBe("1250000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("handles negative Eastern Arabic numbers", () => {
      const total = "-١٥٠٠٠";
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "خصم", amount: "-١٥٠٠٠" },
      ];
      const recon = computeProvenanceReconciliation(total, subItems);

      expect(recon.expectedTotal).toBe("-15000.00");
      expect(recon.subItemsSum).toBe("-15000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });
  });

  describe("5. Malformed, Null, Undefined & Edge Inputs", () => {
    it("handles null and undefined gracefully as zero", () => {
      const reconNull = computeProvenanceReconciliation(null as any);
      expect(reconNull.expectedTotal).toBe("0.00");
      expect(reconNull.subItemsSum).toBe("0.00");
      expect(reconNull.isFullyReconciled).toBe(true);

      const reconUndef = computeProvenanceReconciliation(undefined as any);
      expect(reconUndef.expectedTotal).toBe("0.00");
      expect(reconUndef.subItemsSum).toBe("0.00");
      expect(reconUndef.isFullyReconciled).toBe(true);
    });

    it("handles empty string and whitespace cleanly", () => {
      const recon = computeProvenanceReconciliation("   ");
      expect(recon.expectedTotal).toBe("0.00");
      expect(recon.subItemsSum).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });

    it("handles NaN and Infinity cleanly by falling back to 0", () => {
      const reconNaN = computeProvenanceReconciliation(NaN);
      expect(reconNaN.expectedTotal).toBe("0.00");

      const reconInf = computeProvenanceReconciliation(Infinity);
      expect(reconInf.expectedTotal).toBe("0.00");

      const reconStrInf = computeProvenanceReconciliation("Infinity");
      expect(reconStrInf.expectedTotal).toBe("0.00");
    });

    it("handles sub-items with null/undefined amounts without throwing", () => {
      const subItems: ProvenanceSubItem[] = [
        { id: 1, label: "بند صالح", amount: "5000.00" },
        { id: 2, label: "بند بلا مبلغ", amount: null as any },
        { id: 3, label: "بند نص فارغ", amount: "" },
      ];
      const recon = computeProvenanceReconciliation("5000.00", subItems);

      expect(recon.expectedTotal).toBe("5000.00");
      expect(recon.subItemsSum).toBe("5000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
    });
  });

  describe("6. Large Sub-Item Arrays (Performance & Scalability)", () => {
    it("processes 100 sub-items in < 10ms with exact reconciliation", () => {
      const count = 100;
      const unitAmount = 2500;
      const subItems: ProvenanceSubItem[] = Array.from({ length: count }, (_, i) => ({
        id: `item-${i}`,
        label: `بند فرعي #${i + 1}`,
        amount: unitAmount,
        quantity: 1,
        unitPrice: unitAmount,
      }));

      const totalAmount = count * unitAmount; // 250,000

      const t0 = performance.now();
      const recon = computeProvenanceReconciliation(totalAmount, subItems);
      const elapsed = performance.now() - t0;

      expect(recon.expectedTotal).toBe("250000.00");
      expect(recon.subItemsSum).toBe("250000.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
      expect(recon.subItemsCount).toBe(100);
      expect(elapsed).toBeLessThan(50); // Under 50ms (well within requirement)
    });

    it("processes 1,000 sub-items with complex decimal strings in < 50ms", () => {
      const count = 1000;
      const subItems: ProvenanceSubItem[] = Array.from({ length: count }, (_, i) => ({
        id: i,
        label: `بند مركب #${i}`,
        amount: "1,250.25 د.ع",
      }));

      // 1000 * 1250.25 = 1,250,250.00
      const totalAmount = "1250250.00";

      const t0 = performance.now();
      const recon = computeProvenanceReconciliation(totalAmount, subItems);
      const elapsed = performance.now() - t0;

      expect(recon.expectedTotal).toBe("1250250.00");
      expect(recon.subItemsSum).toBe("1250250.00");
      expect(recon.discrepancy).toBe("0.00");
      expect(recon.isFullyReconciled).toBe(true);
      expect(recon.subItemsCount).toBe(1000);
      expect(elapsed).toBeLessThan(200);
    });

    it("detects discrepancy in large array when single item is off by 1 IQD", () => {
      const count = 200;
      const subItems: ProvenanceSubItem[] = Array.from({ length: count }, (_, i) => ({
        id: i,
        label: `بند #${i}`,
        amount: 1000,
      }));
      // Tamper item 100
      subItems[99].amount = 1001;

      const recon = computeProvenanceReconciliation(200000, subItems);

      expect(recon.expectedTotal).toBe("200000.00");
      expect(recon.subItemsSum).toBe("200001.00");
      expect(recon.discrepancy).toBe("1.00");
      expect(recon.isFullyReconciled).toBe(false);
    });
  });
});
