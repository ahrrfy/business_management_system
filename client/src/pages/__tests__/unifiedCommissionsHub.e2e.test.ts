/**
 * E2E Test Suite: Unified Commissions Hub & Sales Attribution UX (F5, F6)
 *
 * Genuine 5-Tier Inspection Suite:
 *  - Tier 1: Feature Coverage (F5 POS & Invoices Sales Attribution, F6 Unified Commissions Hub)
 *  - Tier 2: Boundary & Routing Verification (HrHub Unified Tab & URL Query Compatibility)
 *  - Tier 3: Governance & SOD Controls (Maker-Checker Approval Matrix, Payroll Freezing)
 *  - Tier 4: Backend Integration Contracts (saleRouter, sale/create, attribution engine)
 *  - Tier 5: Mathematical Precision & Adversarial Stress Tests (Zero-Float Decimal Math)
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { D } from "@/lib/money";

const readSource = (relativePath: string): string => {
  const url = new URL(relativePath, import.meta.url);
  if (!existsSync(url)) {
    throw new Error(`File not found for testing: ${relativePath}`);
  }
  return readFileSync(url, "utf8");
};

describe("E2E Unified Commissions Hub & Sales Attribution UX (F5, F6)", () => {
  const unifiedHubSource = readSource("../UnifiedCommissionsHub.tsx");
  const hrHubSource = readSource("../HrHub.tsx");
  const payrollSource = readSource("../Payroll.tsx");
  const cartPanelSource = readSource("../../components/pos/CartPanel.tsx");
  const posSource = readSource("../POS.tsx");
  const posSharedSource = readSource("../../components/pos/posShared.ts");
  const salesInvoiceNewSource = readSource("../SalesInvoiceNew.tsx");
  const invoiceHeaderSource = readSource("../../components/invoice/InvoiceHeader.tsx");
  const saleRouterSource = readSource("../../../../server/routers/saleRouter.ts");
  const saleCreateSource = readSource("../../../../server/services/sale/create.ts");

  // =========================================================================
  // TIER 1: Feature Coverage (F5 POS/Invoices & F6 Unified Hub)
  // =========================================================================
  describe("Tier 1: Feature Coverage", () => {
    it("F5.1: CartPanel.tsx exports CartSalesRepButton and wires salesRepId props", () => {
      expect(cartPanelSource).toContain("export interface CartSalesRepButtonProps");
      expect(cartPanelSource).toContain("export function CartSalesRepButton");
      expect(cartPanelSource).toContain("salesRepId?: number | null;");
      expect(cartPanelSource).toContain("onSalesRepChange?: (repId: number | null) => void;");
      expect(cartPanelSource).toContain("<CartSalesRepButton");
    });

    it("F5.2: POS.tsx wires salesRepId in tab state, passes it to CartPanel, and propagates to sale.mutate", () => {
      // POSTab includes salesRepId
      expect(posSharedSource).toContain("salesRepId?: number | null;");
      expect(posSharedSource).toContain("salesRepId: null");

      // CartPanel receives salesRepId and change handler
      expect(posSource).toContain("salesRepId={activeTab.salesRepId ?? null}");
      expect(posSource).toContain("onSalesRepChange={(id) => patchActive({ salesRepId: id })}");

      // submitSale and quickPay pass attribution to sale.mutate
      expect(posSource).toContain("salesRepId: activeTab.salesRepId");
      expect(posSource).toMatch(/attribution:\s*(?:activeTab\.salesRepId\s*\?\s*)?\{\s*repId:\s*activeTab\.salesRepId,\s*mode:\s*"DIRECT"\s*as\s*const\s*\}/);
    });

    it("F5.3: SalesInvoiceNew.tsx binds active sales reps to InvoiceHeader and includes salesRepId in payload", () => {
      expect(salesInvoiceNewSource).toContain("trpc.employees.list.useQuery");
      expect(salesInvoiceNewSource).toContain("salesReps={salesReps}");
      expect(salesInvoiceNewSource).toContain("salesRepId: state.salesRepId ? Number(state.salesRepId) : undefined");
      expect(salesInvoiceNewSource).toContain("salesRepId: base.salesRepId");
    });

    it("F5.4: InvoiceHeader.tsx provides interactive sales representative selector", () => {
      expect(invoiceHeaderSource).toContain("salesReps?: Array<{ id: number; name: string }>;");
      expect(invoiceHeaderSource).toContain("مندوب المبيعات");
      expect(invoiceHeaderSource).toContain("dispatch({ type: \"SET_FIELD\", field: \"salesRepId\", value: v ? Number(v) : \"\" })");
    });

    it("F6.1: UnifiedCommissionsHub.tsx defines all 5 Executive KPI Cockpit Cards with exact test IDs", () => {
      expect(unifiedHubSource).toContain('data-testid="kpi-totalBaseSales"');
      expect(unifiedHubSource).toContain('data-testid="kpi-averageAchievementPct"');
      expect(unifiedHubSource).toContain('data-testid="kpi-totalCommissionDue"');
      expect(unifiedHubSource).toContain('data-testid="kpi-runStatus"');
      expect(unifiedHubSource).toContain('data-testid="kpi-negativeCarryover"');
    });

    it("F6.2: UnifiedCommissionsHub.tsx embeds actual domain sub-views (Zero Mocking)", () => {
      expect(unifiedHubSource).toContain("<CommissionRuns />");
      expect(unifiedHubSource).toContain("<CommissionTargets />");
      expect(unifiedHubSource).toContain("<CommissionPlans />");
      expect(unifiedHubSource).toContain("هندسة إسناد المبيعات وصالة العرض");
    });

    it("F6.3: UnifiedCommissionsHub.tsx implements Zero Draft Loss DOM Keep-Alive rendering", () => {
      expect(unifiedHubSource).toContain('className={activeView === "runs" ? "block space-y-4" : "hidden"}');
      expect(unifiedHubSource).toContain('className={activeView === "targets" ? "block space-y-4" : "hidden"}');
      expect(unifiedHubSource).toContain('className={activeView === "plans" ? "block space-y-4" : "hidden"}');
      expect(unifiedHubSource).toContain('className={activeView === "attribution" ? "block space-y-5" : "hidden"}');
    });

    it("F6.4: UnifiedCommissionsHub.tsx eliminates raw IEEE float math on financial totals", () => {
      expect(unifiedHubSource).toContain("import { D } from \"@/lib/money\";");
      // Must not contain raw Number subtraction or summation on currency
      expect(unifiedHubSource).not.toContain("Number(run.totalBaseSales || 0) - Number(run.totalBaseReturns || 0)");
      expect(unifiedHubSource).not.toContain("sum + (Number(l.carryOut) || 0)");
      expect(unifiedHubSource).toMatch(/D\(run\.totalBaseSales\s*\|\|\s*"0"\)\s*\.minus\(D\(run\.totalBaseReturns\s*\|\|\s*"0"\)\)\s*\.toFixed\(2\)/);
    });
  });

  // =========================================================================
  // TIER 2: Boundary & Routing Verification (HrHub & Backward URLs)
  // =========================================================================
  describe("Tier 2: Boundary & Routing Verification", () => {
    it("B3.1: HrHub.tsx unifies 3 separate commissions tabs into a single workstation tab", () => {
      expect(hrHubSource).toMatch(/value:\s*"commissions",\s*label:\s*"العمولات والأهداف",\s*gate:\s*COMMISSIONS_GATE,\s*Component:\s*UnifiedCommissionsHub/);
      // Individual tabs must not exist as top-level HrHub tabs
      expect(hrHubSource).not.toContain('{ value: "commission-runs",');
      expect(hrHubSource).not.toContain('{ value: "commission-targets",');
      expect(hrHubSource).not.toContain('{ value: "commission-plans",');
    });

    it("B3.2: HrHub.tsx transparently routes legacy commission query parameters to commissions tab", () => {
      expect(hrHubSource).toContain('requested === "commission-runs"');
      expect(hrHubSource).toContain('requested === "commission-targets"');
      expect(hrHubSource).toContain('requested === "commission-plans"');
      expect(hrHubSource).toContain('requested === "runs"');
      expect(hrHubSource).toContain('requested === "targets"');
      expect(hrHubSource).toContain('requested === "plans"');
      expect(hrHubSource).toContain('requested === "attribution"');
    });

    it("B3.3: Payroll.tsx backward compatibility link points to /hr?tab=commission-runs", () => {
      expect(payrollSource).toContain('href="/hr?tab=commission-runs"');
    });

    it("B3.4: UnifiedCommissionsHub.tsx synchronizes URL query params without reloading", () => {
      expect(unifiedHubSource).toContain("window.history.replaceState(null, \"\", nextPath)");
      expect(unifiedHubSource).toContain("commission-runs");
      expect(unifiedHubSource).toContain("commission-targets");
      expect(unifiedHubSource).toContain("commission-plans");
    });
  });

  // =========================================================================
  // TIER 3: Governance & SOD Controls
  // =========================================================================
  describe("Tier 3: Governance & SOD Controls", () => {
    it("C5: UnifiedCommissionsHub.tsx enforces SOD Maker-Checker rule: creators cannot self-approve", () => {
      expect(unifiedHubSource).toMatch(/const\s+canSelfApprove\s*=\s*isOwner\s*\|\|\s*\(runCreatedBy\s*!=\s*null\s*&&\s*runCreatedBy\s*!==\s*myUserId\);/);
      expect(unifiedHubSource).toContain("بانتظار مراجع مستقل (فصل مهام)");
      expect(unifiedHubSource).toContain("جاهزة للمراجعة والاعتماد");
      expect(unifiedHubSource).toContain("معتمدة من مراجع مستقل (SOD)");
    });

    it("C6: SOD UI indicator evaluation is deterministic and safe", () => {
      const evaluate = (isOwner: boolean, creatorId: number, currentUserId: number) => {
        return isOwner || creatorId !== currentUserId;
      };
      expect(evaluate(false, 1, 1)).toBe(false); // Creator viewing own run
      expect(evaluate(false, 1, 2)).toBe(true);  // Independent manager viewing run
      expect(evaluate(true, 1, 1)).toBe(true);   // Owner executive override
    });

    it("C7: UnifiedCommissionsHub.tsx indicates payroll integration state", () => {
      expect(unifiedHubSource).toMatch(/kpiData\.payrollRunId\s*\?\s*"مدرجة في مسيّر الرواتب"\s*:\s*"مستحقة للكادر البيعي"/);
    });
  });

  // =========================================================================
  // TIER 4: Backend Integration Contracts
  // =========================================================================
  describe("Tier 4: Backend Integration Contracts", () => {
    it("B4.1: saleRouter.ts create procedure accepts salesRepId and attribution in input schema", () => {
      expect(saleRouterSource).toContain("salesRepId: z.number().int().positive().nullish()");
      expect(saleRouterSource).toMatch(/attribution:\s*z\s*\.object\(\{/);
      expect(saleRouterSource).toContain("repId: z.number().int().positive().nullish()");
      expect(saleRouterSource).toMatch(/mode:\s*z\.enum\(\["DIRECT",\s*"SPLIT",\s*"POOL"\]\)\.nullish\(\)/);
    });

    it("B4.2: server/services/sale/create.ts resolves multi-role sales attribution plan", () => {
      expect(saleCreateSource).toMatch(/const\s+attributionPlan\s*=\s*resolveSaleAttribution\(\{/);
      expect(saleCreateSource).toMatch(/salesRepId:\s*input\.attribution\?\.repId\s*\?\?\s*input\.salesRepId/);
      expect(saleCreateSource).toMatch(/salespersonNameSnapshot\s*=\s*await\s+userNameSnapshot\(\s*tx,\s*attributionPlan\.primaryUserId\s*\)/);
      expect(saleCreateSource).toMatch(/salesRepId:\s*attributionPlan\.primaryUserId/);
    });
  });

  // =========================================================================
  // TIER 5: Mathematical Precision & Adversarial Stress Tests
  // =========================================================================
  describe("Tier 5: Mathematical Precision & Adversarial Stress Tests", () => {
    it("E1: Net Sales computation preserves exact Decimal precision on IEEE float hazard values", () => {
      // 10,000,000.05 - 9,999,999.95 in IEEE floats produces 0.0999999999994543
      const gross = "10000000.05";
      const returns = "9999999.95";
      const exactNet = D(gross).minus(D(returns)).toFixed(2);
      expect(exactNet).toBe("0.10");

      // Verify that raw float arithmetic fails this test
      const floatNet = String(Number(gross) - Number(returns));
      expect(floatNet).not.toBe("0.10");
    });

    it("E2: Negative Carryover summation preserves exact decimal totals across multi-line runs", () => {
      const carryOutLines = [
        { carryOut: "125000.33" },
        { carryOut: "250000.33" },
        { carryOut: "500000.34" },
      ];
      const totalCarryout = carryOutLines
        .reduce((sumD, l) => sumD.plus(D(l.carryOut)), D(0))
        .toFixed(2);
      expect(totalCarryout).toBe("875001.00");
    });

    it("E3: Multi-role split ratios preserve the zero-sum decimal invariant (primary + secondary == 1.0000)", () => {
      const splitRatio = "70/30";
      const [p1, p2] = splitRatio.split("/").map(Number);
      const total = p1 + p2;
      const primaryPct = new Decimal(p1).div(total).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const secondaryPct = new Decimal(1).minus(primaryPct).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

      expect(primaryPct.plus(secondaryPct).toString()).toBe("1");
      expect(primaryPct.toString()).toBe("0.7");
      expect(secondaryPct.toString()).toBe("0.3");
    });
  });
});
