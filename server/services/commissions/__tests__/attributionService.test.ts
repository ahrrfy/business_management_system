import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  parseSplitRatio,
  resolveSaleAttribution,
} from "../attribution";
import { money } from "../../money";

describe("Milestone 1: Attribution Helper Service (attribution.ts)", () => {
  describe("parseSplitRatio", () => {
    it("parses slash format '70/30'", () => {
      const { primaryPct, secondaryPct } = parseSplitRatio("70/30");
      expect(primaryPct.toString()).toBe("0.7");
      expect(secondaryPct.toString()).toBe("0.3");
      expect(primaryPct.plus(secondaryPct).toString()).toBe("1");
    });

    it("parses colon format '80:20'", () => {
      const { primaryPct, secondaryPct } = parseSplitRatio("80:20");
      expect(primaryPct.toString()).toBe("0.8");
      expect(secondaryPct.toString()).toBe("0.2");
      expect(primaryPct.plus(secondaryPct).toString()).toBe("1");
    });

    it("parses decimal string format '0.65'", () => {
      const { primaryPct, secondaryPct } = parseSplitRatio("0.65");
      expect(primaryPct.toString()).toBe("0.65");
      expect(secondaryPct.toString()).toBe("0.35");
      expect(primaryPct.plus(secondaryPct).toString()).toBe("1");
    });

    it("parses integer percentage format '75'", () => {
      const { primaryPct, secondaryPct } = parseSplitRatio("75");
      expect(primaryPct.toString()).toBe("0.75");
      expect(secondaryPct.toString()).toBe("0.25");
      expect(primaryPct.plus(secondaryPct).toString()).toBe("1");
    });

    it("defaults to 70/30 when ratio is null or undefined", () => {
      const defNull = parseSplitRatio(null);
      expect(defNull.primaryPct.toString()).toBe("0.7");
      expect(defNull.secondaryPct.toString()).toBe("0.3");

      const defUndef = parseSplitRatio(undefined);
      expect(defUndef.primaryPct.toString()).toBe("0.7");
      expect(defUndef.secondaryPct.toString()).toBe("0.3");
    });
  });

  describe("resolveSaleAttribution", () => {
    it("falls back to 100% Cashier DIRECT when no rep or attribution is provided", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        baseAmount: "150000.00",
      });

      expect(plan.primaryUserId).toBe(30);
      expect(plan.attributionMode).toBe("DIRECT");
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0]).toEqual({
        userId: 30,
        role: "CASHIER",
        attributionMode: "DIRECT",
        sharePct: "1.0000",
        creditedBaseAmount: "150000.00",
      });
    });

    it("resolves Floor Rep DIRECT attribution", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        salesRepId: 10,
        attributionMode: "DIRECT",
        baseAmount: "250000.00",
      });

      expect(plan.primaryUserId).toBe(10);
      expect(plan.attributionMode).toBe("DIRECT");
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0]).toEqual({
        userId: 10,
        role: "FLOOR_REP",
        attributionMode: "DIRECT",
        sharePct: "1.0000",
        creditedBaseAmount: "250000.00",
      });
    });

    it("resolves Floor Rep SPLIT attribution with 70/30 split and exact penny allocation", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        salesRepId: 10,
        attributionMode: "SPLIT",
        attribution: {
          repId: 10,
          assistedById: 30,
          mode: "SPLIT",
          splitRatio: "70/30",
        },
        baseAmount: "200000.00",
      });

      expect(plan.primaryUserId).toBe(10);
      expect(plan.attributionMode).toBe("SPLIT");
      expect(plan.lines).toHaveLength(2);

      const rep = plan.lines.find((l) => l.userId === 10);
      const cashier = plan.lines.find((l) => l.userId === 30);

      expect(rep?.creditedBaseAmount).toBe("140000.00");
      expect(cashier?.creditedBaseAmount).toBe("60000.00");
      expect(
        new Decimal(rep!.creditedBaseAmount)
          .plus(cashier!.creditedBaseAmount)
          .toString(),
      ).toBe("200000");
    });

    it("resolves Store Order Fulfiller DIRECT attribution", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        attribution: {
          repId: 40,
          role: "FULFILLER",
          mode: "DIRECT",
        },
        baseAmount: "85000.00",
      });

      expect(plan.primaryUserId).toBe(40);
      expect(plan.attributionMode).toBe("DIRECT");
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0]).toEqual({
        userId: 40,
        role: "FULFILLER",
        attributionMode: "DIRECT",
        sharePct: "1.0000",
        creditedBaseAmount: "85000.00",
      });
    });

    it("resolves Reception Draft Conversion SPLIT (70% Receptionist / 30% Cashier)", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        receptionistUserId: 20,
        baseAmount: "100000.00",
      });

      expect(plan.primaryUserId).toBe(20);
      expect(plan.attributionMode).toBe("SPLIT");
      expect(plan.lines).toHaveLength(2);

      const rec = plan.lines.find((l) => l.userId === 20);
      const cashier = plan.lines.find((l) => l.userId === 30);

      expect(rec?.role).toBe("RECEPTIONIST");
      expect(rec?.creditedBaseAmount).toBe("70000.00");
      expect(cashier?.role).toBe("CASHIER");
      expect(cashier?.creditedBaseAmount).toBe("30000.00");
    });

    it("resolves Reception Draft Conversion when receptionist is the cashier", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 20,
        receptionistUserId: 20,
        baseAmount: "100000.00",
      });

      expect(plan.primaryUserId).toBe(20);
      expect(plan.attributionMode).toBe("DIRECT");
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0].userId).toBe(20);
    });

    it("handles Custom Splits across multiple participants with penny conservation", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        attribution: {
          customSplits: [
            { userId: 10, role: "FLOOR_REP", sharePct: "0.5000" },
            { userId: 11, role: "FLOOR_REP", sharePct: "0.3000" },
            { userId: 30, role: "CASHIER", sharePct: "0.2000" },
          ],
        },
        baseAmount: "100000.01",
      });

      expect(plan.attributionMode).toBe("SPLIT");
      expect(plan.lines).toHaveLength(3);

      const sum = plan.lines.reduce(
        (acc, l) => acc.plus(l.creditedBaseAmount),
        new Decimal(0),
      );
      expect(sum.toString()).toBe("100000.01");
    });

    it("throws BAD_REQUEST error with appErrorMessage when custom splits do not sum to 100%", () => {
      expect(() =>
        resolveSaleAttribution({
          branchId: 1,
          cashierUserId: 30,
          attribution: {
            customSplits: [
              { userId: 10, role: "FLOOR_REP", sharePct: "0.5000" },
              { userId: 30, role: "CASHIER", sharePct: "0.3000" },
            ],
          },
          baseAmount: "100000.00",
        }),
      ).toThrow(/نسب إسناد المبيعات/);
    });

    it("preserves exact precision for extreme multi-million IQD scale", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        salesRepId: 10,
        attributionMode: "SPLIT",
        attribution: {
          repId: 10,
          assistedById: 30,
          mode: "SPLIT",
          splitRatio: "70/30",
        },
        baseAmount: "500000000.00",
      });

      const rep = plan.lines.find((l) => l.userId === 10);
      const cashier = plan.lines.find((l) => l.userId === 30);

      expect(rep?.creditedBaseAmount).toBe("350000000.00");
      expect(cashier?.creditedBaseAmount).toBe("150000000.00");
      expect(
        new Decimal(rep!.creditedBaseAmount)
          .plus(cashier!.creditedBaseAmount)
          .toString(),
      ).toBe("500000000");
    });
  });

  describe("Adversarial Empirical Stress Tests (Challenger)", () => {
    it("conserves residual penny on 3-way split with odd amount (10,001 IQD) allocating remainder to primary rep", () => {
      // 3-way split with 0.3334 for primary rep and 0.3333 for two secondary reps
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        attribution: {
          customSplits: [
            { userId: 10, role: "FLOOR_REP", sharePct: "0.3334" },
            { userId: 11, role: "FLOOR_REP", sharePct: "0.3333" },
            { userId: 30, role: "CASHIER", sharePct: "0.3333" },
          ],
        },
        baseAmount: "10001.00",
      });

      expect(plan.attributionMode).toBe("SPLIT");
      expect(plan.primaryUserId).toBe(10);
      expect(plan.lines).toHaveLength(3);

      const repPrimary = plan.lines.find((l) => l.userId === 10);
      const repSecondary = plan.lines.find((l) => l.userId === 11);
      const cashier = plan.lines.find((l) => l.userId === 30);

      // 10001 * 0.3334 = 3334.3334 -> unadjusted = 3334.33
      // 10001 * 0.3333 = 3333.3333 -> 3333.33 each
      // unadjusted sum = 3334.33 + 3333.33 + 3333.33 = 10000.99
      // delta = 10001.00 - 10000.99 = +0.01 (assigned to primary rep 10)
      expect(repPrimary?.creditedBaseAmount).toBe("3334.34");
      expect(repSecondary?.creditedBaseAmount).toBe("3333.33");
      expect(cashier?.creditedBaseAmount).toBe("3333.33");

      const sum = plan.lines.reduce(
        (acc, l) => acc.plus(l.creditedBaseAmount),
        new Decimal(0),
      );
      expect(sum.toFixed(2)).toBe("10001.00");
    });

    it("conserves residual on 3-way split with equal numeric 1/3 splits on 10,001 IQD", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        attribution: {
          customSplits: [
            { userId: 10, role: "FLOOR_REP", sharePct: 1 / 3 },
            { userId: 11, role: "FLOOR_REP", sharePct: 1 / 3 },
            { userId: 30, role: "CASHIER", sharePct: 1 / 3 },
          ],
        },
        baseAmount: "10001.00",
      });

      expect(plan.attributionMode).toBe("SPLIT");
      expect(plan.primaryUserId).toBe(10);
      expect(plan.lines).toHaveLength(3);

      const repPrimary = plan.lines.find((l) => l.userId === 10);
      const repSecondary = plan.lines.find((l) => l.userId === 11);
      const cashier = plan.lines.find((l) => l.userId === 30);

      // 1/3 rounds to 0.3333 (4 decimals)
      // 10001 * 0.3333 = 3333.33 for each of the 3
      // sum = 9999.99
      // delta = 10001.00 - 9999.99 = 1.01 (allocated to primary rep at index 0)
      expect(repPrimary?.creditedBaseAmount).toBe("3334.34");
      expect(repSecondary?.creditedBaseAmount).toBe("3333.33");
      expect(cashier?.creditedBaseAmount).toBe("3333.33");

      const sum = plan.lines.reduce(
        (acc, l) => acc.plus(l.creditedBaseAmount),
        new Decimal(0),
      );
      expect(sum.toFixed(2)).toBe("10001.00");
    });

    it("conserves residual on 3-way split on 1 IQD minimal positive denomination", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        attribution: {
          customSplits: [
            { userId: 10, role: "FLOOR_REP", sharePct: "0.3334" },
            { userId: 11, role: "FLOOR_REP", sharePct: "0.3333" },
            { userId: 30, role: "CASHIER", sharePct: "0.3333" },
          ],
        },
        baseAmount: "1.00",
      });

      // 1 * 0.3334 = 0.33, 1 * 0.3333 = 0.33, 1 * 0.3333 = 0.33
      // sum = 0.99, delta = +0.01 -> primary gets 0.34
      const repPrimary = plan.lines.find((l) => l.userId === 10);
      expect(repPrimary?.creditedBaseAmount).toBe("0.34");

      const sum = plan.lines.reduce(
        (acc, l) => acc.plus(l.creditedBaseAmount),
        new Decimal(0),
      );
      expect(sum.toFixed(2)).toBe("1.00");
    });

    it("conserves residual on negative returns amount (-10,001 IQD) on 3-way split", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        attribution: {
          customSplits: [
            { userId: 10, role: "FLOOR_REP", sharePct: "0.3334" },
            { userId: 11, role: "FLOOR_REP", sharePct: "0.3333" },
            { userId: 30, role: "CASHIER", sharePct: "0.3333" },
          ],
        },
        baseAmount: "-10001.00",
      });

      expect(plan.primaryUserId).toBe(10);
      const repPrimary = plan.lines.find((l) => l.userId === 10);
      const repSecondary = plan.lines.find((l) => l.userId === 11);
      const cashier = plan.lines.find((l) => l.userId === 30);

      expect(repPrimary?.creditedBaseAmount).toBe("-3334.34");
      expect(repSecondary?.creditedBaseAmount).toBe("-3333.33");
      expect(cashier?.creditedBaseAmount).toBe("-3333.33");

      const sum = plan.lines.reduce(
        (acc, l) => acc.plus(l.creditedBaseAmount),
        new Decimal(0),
      );
      expect(sum.toFixed(2)).toBe("-10001.00");
    });

    it("verifies 100% Cashier fallback when attribution is completely omitted (undefined, null, empty)", () => {
      // Case 1: attribution completely omitted
      const planOmitted = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 42,
        baseAmount: "75250.00",
      });
      expect(planOmitted.primaryUserId).toBe(42);
      expect(planOmitted.attributionMode).toBe("DIRECT");
      expect(planOmitted.lines).toEqual([
        {
          userId: 42,
          role: "CASHIER",
          attributionMode: "DIRECT",
          sharePct: "1.0000",
          creditedBaseAmount: "75250.00",
        },
      ]);

      // Case 2: attribution is explicit null
      const planNull = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 42,
        attribution: null,
        salesRepId: null,
        assistedByUserId: null,
        receptionistUserId: null,
        baseAmount: "75250.00",
      });
      expect(planNull.primaryUserId).toBe(42);
      expect(planNull.attributionMode).toBe("DIRECT");
      expect(planNull.lines).toEqual([
        {
          userId: 42,
          role: "CASHIER",
          attributionMode: "DIRECT",
          sharePct: "1.0000",
          creditedBaseAmount: "75250.00",
        },
      ]);

      // Case 3: attribution is empty object
      const planEmpty = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 42,
        attribution: {},
        baseAmount: "75250.00",
      });
      expect(planEmpty.primaryUserId).toBe(42);
      expect(planEmpty.attributionMode).toBe("DIRECT");
      expect(planEmpty.lines).toEqual([
        {
          userId: 42,
          role: "CASHIER",
          attributionMode: "DIRECT",
          sharePct: "1.0000",
          creditedBaseAmount: "75250.00",
        },
      ]);
    });

    it("resolves multi-role split between two floor sales reps (salesRepId + assistedByUserId)", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        salesRepId: 10,
        assistedByUserId: 12,
        attributionMode: "SPLIT",
        attribution: {
          repId: 10,
          assistedById: 12,
          mode: "SPLIT",
          splitRatio: "60/40",
        },
        baseAmount: "25000.00",
      });

      expect(plan.primaryUserId).toBe(10);
      expect(plan.attributionMode).toBe("SPLIT");
      expect(plan.lines).toHaveLength(2);

      const rep1 = plan.lines.find((l) => l.userId === 10);
      const rep2 = plan.lines.find((l) => l.userId === 12);

      expect(rep1?.role).toBe("FLOOR_REP");
      expect(rep1?.creditedBaseAmount).toBe("15000.00");
      expect(rep2?.role).toBe("FLOOR_REP");
      expect(rep2?.creditedBaseAmount).toBe("10000.00");
    });

    it("safely handles edge case when salesRepId is identical to cashierUserId", () => {
      const plan = resolveSaleAttribution({
        branchId: 1,
        cashierUserId: 30,
        salesRepId: 30,
        baseAmount: "50000.00",
      });

      expect(plan.primaryUserId).toBe(30);
      expect(plan.attributionMode).toBe("DIRECT");
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0]).toEqual({
        userId: 30,
        role: "CASHIER",
        attributionMode: "DIRECT",
        sharePct: "1.0000",
        creditedBaseAmount: "50000.00",
      });
    });

    it("safely parses unusual or messy splitRatio strings with robust fallback", () => {
      // garbage text falls back to standard 70/30
      const resGarbage = parseSplitRatio("invalid:ratio");
      expect(resGarbage.primaryPct.toString()).toBe("0.7");
      expect(resGarbage.secondaryPct.toString()).toBe("0.3");

      // out of range percentage (> 100 after / 100) falls back to standard 70/30
      const resOutOfRange = parseSplitRatio("150");
      expect(resOutOfRange.primaryPct.toString()).toBe("0.7");
      expect(resOutOfRange.secondaryPct.toString()).toBe("0.3");

      // zero-sum split ratio with negative component falls back to standard 70/30
      const resZeroSumNeg = parseSplitRatio("-10/10");
      expect(resZeroSumNeg.primaryPct.toString()).toBe("0.7");
      expect(resZeroSumNeg.secondaryPct.toString()).toBe("0.3");

      // "0/0" edge-case: parseFloat("0/0") yields 0, allocating 0% to primary and 100% to secondary
      const resDiv0 = parseSplitRatio("0/0");
      expect(resDiv0.primaryPct.toString()).toBe("0");
      expect(resDiv0.secondaryPct.toString()).toBe("1");
      expect(resDiv0.primaryPct.plus(resDiv0.secondaryPct).toString()).toBe("1");
    });
  });
});

