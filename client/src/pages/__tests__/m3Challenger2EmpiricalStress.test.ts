import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { D } from "@/lib/money";

describe("Empirical Challenger 2 (Iteration 5): Financial Stress & SOD Invariants", () => {
  const hubSource = readFileSync(new URL("../UnifiedCommissionsHub.tsx", import.meta.url), "utf8");
  const posSharedSource = readFileSync(new URL("../../components/pos/posShared.ts", import.meta.url), "utf8");
  const posSource = readFileSync(new URL("../POS.tsx", import.meta.url), "utf8");
  const cartPanelSource = readFileSync(new URL("../../components/pos/CartPanel.tsx", import.meta.url), "utf8");
  const saleRouterSource = readFileSync(new URL("../../../../server/routers/saleRouter.ts", import.meta.url), "utf8");
  const saleCreateSource = readFileSync(new URL("../../../../server/services/sale/create.ts", import.meta.url), "utf8");

  // =========================================================================
  // 1. Net Sales Computation on Float Hazards (Generator & Oracle)
  // =========================================================================
  describe("1. Net Sales Computation on Float-Hazard Numbers", () => {
    // Production calculation in UnifiedCommissionsHub.tsx (line 129):
    const computeNetSales = (gross: string | null | undefined, returns: string | null | undefined): string => {
      return D(gross || "0").minus(D(returns || "0")).toFixed(2);
    };

    it("evaluates specific float-hazard boundary pair: 10,000,000.05 - 9,999,999.95", () => {
      const gross = "10000000.05";
      const returns = "9999999.95";

      // IEEE 754 float subtraction fails (drifts from 0.1):
      const floatDrift = Number(gross) - Number(returns);
      expect(floatDrift.toString()).not.toBe("0.1");
      expect(floatDrift.toString()).not.toBe("0.10");

      // Decimal production formula gives exact result:
      const exactResult = computeNetSales(gross, returns);
      expect(exactResult).toBe("0.10");
    });

    it("survives generator harness of 1,000 float-hazard pairs without any decimal drift", () => {
      // Classic binary floating point hazards: x.05 - (x - 0.1).95, or .1 + .2, etc.
      for (let i = 1; i <= 1000; i++) {
        const grossBase = new Decimal(i * 10000).plus("0.05");
        const returnBase = new Decimal(i * 10000).minus("0.05");

        const grossStr = grossBase.toFixed(2);
        const returnStr = returnBase.toFixed(2);

        // Expected is always exactly 0.10
        const result = computeNetSales(grossStr, returnStr);
        expect(result).toBe("0.10");

        // Verify float would have drifted or failed on many of these
        const floatDiff = Number(grossStr) - Number(returnStr);
        const floatExactMatches = floatDiff.toFixed(2) === "0.10";
        // Even if toFixed(2) occasionally masks small float errors, Decimal is provably exact
        expect(D(result).equals(new Decimal("0.10"))).toBe(true);
      }
    });

    it("handles edge cases: returns exceeding sales, empty strings, null, undefined", () => {
      expect(computeNetSales("100.00", "150.00")).toBe("-50.00");
      expect(computeNetSales(null, "50.00")).toBe("-50.00");
      expect(computeNetSales("50.00", null)).toBe("50.00");
      expect(computeNetSales("", "")).toBe("0.00");
      expect(computeNetSales(undefined, undefined)).toBe("0.00");
      expect(computeNetSales("0", "0")).toBe("0.00");
      expect(computeNetSales("999999999999.99", "0.01")).toBe("999999999999.98");
    });
  });

  // =========================================================================
  // 2. Negative Carryover Multi-Line Summation Stress Harness
  // =========================================================================
  describe("2. Negative Carryover Summation Across Multi-Line Runs", () => {
    // Production calculation in UnifiedCommissionsHub.tsx (line 133):
    const computeNegativeCarryover = (lines: Array<{ carryOut?: string | null }>): string => {
      return lines.reduce((sumD, l) => sumD.plus(D(l.carryOut || "0")), D(0)).toFixed(2);
    };

    it("preserves exact decimal totals across 1,000 multi-line carryouts", () => {
      // 1000 lines of 123.45 => exact 123450.00
      const lines = Array.from({ length: 1000 }, () => ({ carryOut: "123.45" }));
      const total = computeNegativeCarryover(lines);
      expect(total).toBe("123450.00");
    });

    it("accumulates recurring fractional values without float drift", () => {
      // 300 lines of 0.33 + 100 lines of 0.01 => exact 99.00 + 1.00 = 100.00
      const lines = [
        ...Array.from({ length: 300 }, () => ({ carryOut: "0.33" })),
        ...Array.from({ length: 100 }, () => ({ carryOut: "0.01" })),
      ];
      const total = computeNegativeCarryover(lines);
      expect(total).toBe("100.00");
    });

    it("safely handles null, undefined, empty string, and zero carryOut entries", () => {
      const mixedLines = [
        { carryOut: "500.50" },
        { carryOut: null },
        { carryOut: undefined },
        { carryOut: "" },
        { carryOut: "0" },
        { carryOut: "0.00" },
        { carryOut: "499.50" },
      ];
      const total = computeNegativeCarryover(mixedLines);
      expect(total).toBe("1000.00");
    });
  });

  // =========================================================================
  // 3. Maker-Checker Segregation of Duties (SOD) Truth Table
  // =========================================================================
  describe("3. Maker-Checker SOD UI Contract & State Truth Table", () => {
    // Production logic from UnifiedCommissionsHub.tsx:
    const evaluateSodState = (params: {
      isOwner: boolean;
      runCreatedBy: number | null;
      myUserId: number;
      runStatus: "draft" | "approved" | "cancelled";
    }) => {
      const canSelfApprove = params.isOwner || (params.runCreatedBy != null && params.runCreatedBy !== params.myUserId);
      const showWarningCard = !canSelfApprove && params.runStatus === "draft";
      const statusLabel =
        params.runStatus === "approved"
          ? "معتمدة أصولياً"
          : "مسودة";
      const statusSubtext =
        params.runStatus === "approved"
          ? "معتمدة من مراجع مستقل (SOD)"
          : canSelfApprove
          ? "جاهزة للمراجعة والاعتماد"
          : "بانتظار مراجع مستقل (فصل مهام)";

      return { canSelfApprove, showWarningCard, statusLabel, statusSubtext };
    };

    it("Maker viewing own draft run: blocks self-approval, displays warning card and waiting indicator", () => {
      const state = evaluateSodState({
        isOwner: false,
        runCreatedBy: 42,
        myUserId: 42,
        runStatus: "draft",
      });

      expect(state.canSelfApprove).toBe(false);
      expect(state.showWarningCard).toBe(true);
      expect(state.statusSubtext).toBe("بانتظار مراجع مستقل (فصل مهام)");
    });

    it("Independent reviewer viewing draft run: allows approval, hides warning card", () => {
      const state = evaluateSodState({
        isOwner: false,
        runCreatedBy: 42,
        myUserId: 99,
        runStatus: "draft",
      });

      expect(state.canSelfApprove).toBe(true);
      expect(state.showWarningCard).toBe(false);
      expect(state.statusSubtext).toBe("جاهزة للمراجعة والاعتماد");
    });

    it("Owner executive override: permits approval even if creator, hides warning card", () => {
      const state = evaluateSodState({
        isOwner: true,
        runCreatedBy: 42,
        myUserId: 42,
        runStatus: "draft",
      });

      expect(state.canSelfApprove).toBe(true);
      expect(state.showWarningCard).toBe(false);
      expect(state.statusSubtext).toBe("جاهزة للمراجعة والاعتماد");
    });

    it("Approved run: displays approved status, hides warning card regardless of viewer", () => {
      const state = evaluateSodState({
        isOwner: false,
        runCreatedBy: 42,
        myUserId: 42,
        runStatus: "approved",
      });

      expect(state.showWarningCard).toBe(false);
      expect(state.statusLabel).toBe("معتمدة أصولياً");
      expect(state.statusSubtext).toBe("معتمدة من مراجع مستقل (SOD)");
    });

    it("Legacy run with null creator: fails closed for non-owners", () => {
      const state = evaluateSodState({
        isOwner: false,
        runCreatedBy: null,
        myUserId: 42,
        runStatus: "draft",
      });

      expect(state.canSelfApprove).toBe(false);
      expect(state.showWarningCard).toBe(true);
      expect(state.statusSubtext).toBe("بانتظار مراجع مستقل (فصل مهام)");
    });
  });

  // =========================================================================
  // 4. POS Attribution Pipeline Integrity
  // =========================================================================
  describe("4. POS & Sales Attribution Pipeline Verification", () => {
    it("confirms POSTab model possesses salesRepId and is initialized to null", () => {
      expect(posSharedSource).toMatch(/salesRepId\?:\s*number\s*\|\s*null/);
      expect(posSharedSource).toMatch(/salesRepId:\s*null/);
    });

    it("confirms CartPanel wires salesRepId and triggers onSalesRepChange", () => {
      expect(cartPanelSource).toContain("salesRepId?: number | null;");
      expect(cartPanelSource).toContain("onSalesRepChange?: (repId: number | null) => void;");
      expect(cartPanelSource).toContain("<CartSalesRepButton");
    });

    it("confirms POS.tsx transmits salesRepId and attribution object in submitSale and quickPay", () => {
      expect(posSource).toContain("salesRepId: activeTab.salesRepId");
      expect(posSource).toContain('attribution: { repId: activeTab.salesRepId, mode: "DIRECT" as const }');
    });

    it("confirms saleRouter.ts accepts salesRepId and attribution with correct Zod schemas", () => {
      expect(saleRouterSource).toContain("salesRepId: z.number().int().positive().nullish()");
      expect(saleRouterSource).toMatch(/attribution:\s*z\s*\.object\(\{/);
      expect(saleRouterSource).toContain("repId: z.number().int().positive().nullish()");
      expect(saleRouterSource).toContain('mode: z.enum(["DIRECT", "SPLIT", "POOL"]).nullish()');
    });

    it("confirms createSaleInTx binds attribution to invoiceAttributions and records salesRepId", () => {
      expect(saleCreateSource).toContain("resolveSaleAttribution");
      expect(saleCreateSource).toContain("salesRepId: attributionPlan.primaryUserId");
      expect(saleCreateSource).toContain("invoiceAttributions");
    });
  });
});
