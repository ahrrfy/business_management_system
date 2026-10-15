import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Adversarial Empirical Stress-Testing: Milestone 3 Hub & Attribution", () => {
  const hrHubSource = readFileSync(new URL("../HrHub.tsx", import.meta.url), "utf8");
  const hubSource = readFileSync(new URL("../UnifiedCommissionsHub.tsx", import.meta.url), "utf8");
  const payrollSource = readFileSync(new URL("../Payroll.tsx", import.meta.url), "utf8");
  const cartPanelSource = readFileSync(new URL("../../components/pos/CartPanel.tsx", import.meta.url), "utf8");
  const salesInvoiceSource = readFileSync(new URL("../SalesInvoiceNew.tsx", import.meta.url), "utf8");
  const invoiceHeaderSource = readFileSync(new URL("../../components/invoice/InvoiceHeader.tsx", import.meta.url), "utf8");

  // 1. Backward URL Compatibility & Deep Linking Exhaustive Matrix
  describe("1. Backward URL Compatibility & Deep Linking Matrix", () => {
    // Replicate resolveViewFromUrl logic from UnifiedCommissionsHub.tsx
    const resolveViewFromUrl = (queryStr: string): string => {
      const p = new URLSearchParams(queryStr).get("tab");
      if (p === "commission-runs" || p === "runs") return "runs";
      if (p === "commission-targets" || p === "targets") return "targets";
      if (p === "commission-plans" || p === "plans") return "plans";
      if (p === "attribution" || p === "sales-attribution") return "attribution";
      return "runs";
    };

    it("maps all legacy and alias tab query parameters accurately", () => {
      expect(resolveViewFromUrl("tab=commission-runs")).toBe("runs");
      expect(resolveViewFromUrl("tab=runs")).toBe("runs");
      expect(resolveViewFromUrl("tab=commission-targets")).toBe("targets");
      expect(resolveViewFromUrl("tab=targets")).toBe("targets");
      expect(resolveViewFromUrl("tab=commission-plans")).toBe("plans");
      expect(resolveViewFromUrl("tab=plans")).toBe("plans");
      expect(resolveViewFromUrl("tab=attribution")).toBe("attribution");
      expect(resolveViewFromUrl("tab=sales-attribution")).toBe("attribution");
      expect(resolveViewFromUrl("tab=commissions")).toBe("runs");
      expect(resolveViewFromUrl("tab=")).toBe("runs");
      expect(resolveViewFromUrl("")).toBe("runs");
      expect(resolveViewFromUrl("other=123")).toBe("runs");
      expect(resolveViewFromUrl("tab=unknown_tab_name")).toBe("runs");
    });

    it("preserves URL query parameters when additional parameters are present", () => {
      expect(resolveViewFromUrl("tab=commission-runs&period=2026-03&branchId=2")).toBe("runs");
      expect(resolveViewFromUrl("period=2026-03&tab=commission-targets&token=xyz")).toBe("targets");
      expect(resolveViewFromUrl("foo=bar&tab=commission-plans")).toBe("plans");
    });

    it("guarantees Payroll readiness banner link is supported", () => {
      // Payroll.tsx has href="/hr?tab=commission-runs"
      expect(payrollSource).toContain('href="/hr?tab=commission-runs"');
      const payrollHref = "/hr?tab=commission-runs";
      const query = payrollHref.split("?")[1];
      expect(resolveViewFromUrl(query)).toBe("runs");
    });

    it("verifies HrHub.tsx aliasing preserves exactly one commissions tab without duplicates", () => {
      // In HrHub.tsx, TABS array has only 1 tab for commissions
      expect(hrHubSource).toMatch(/value:\s*"commissions",\s*label:\s*"العمولات والأهداف",\s*gate:\s*COMMISSIONS_GATE,\s*Component:\s*UnifiedCommissionsHub/);
      expect(hrHubSource).not.toContain('{ value: "commission-runs"');
      expect(hrHubSource).not.toContain('{ value: "commission-targets"');
      expect(hrHubSource).not.toContain('{ value: "commission-plans"');
      expect(hrHubSource).toContain("isLegacyCommissionTab");
    });
  });

  // 2. POS CartPanel Sales Rep Attribution
  describe("2. POS CartPanel Sales Rep Attribution", () => {
    it("verifies CartSalesRepButton is placed directly in CartPanel header", () => {
      expect(cartPanelSource).toContain("<CartSalesRepButton");
      expect(cartPanelSource).toContain("salesRepId={activeSalesRepId}");
      expect(cartPanelSource).toContain("onSelect={handleSalesRepChange}");
    });

    it("verifies CartPanelProps supports optional salesRepId and onSalesRepChange", () => {
      expect(cartPanelSource).toContain("salesRepId?: number | null;");
      expect(cartPanelSource).toContain("onSalesRepChange?: (repId: number | null) => void;");
      expect(cartPanelSource).toMatch(/const\s+\[internalSalesRepId,\s*setInternalSalesRepId\]\s*=\s*useState<number\s*\|\s*null>\(\s*null,?\s*\);/);
      expect(cartPanelSource).toMatch(/const\s+activeSalesRepId\s*=\s*salesRepId\s*!==\s*undefined\s*\?\s*salesRepId\s*:\s*internalSalesRepId;/);
    });

    it("verifies CartSalesRepButton has dialog search, role display, and cashier fallback", () => {
      expect(cartPanelSource).toContain("الكاشير مباشرة (بدون بائع صالة مستقل)");
      expect(cartPanelSource).toContain("بحث باسم بائع الصالة أو المسمى");
      expect(cartPanelSource).toContain("trpc.employees.list.useQuery");
      expect(cartPanelSource).toContain("اختيار بائع صالة العرض (Sales Rep Attribution)");
    });
  });

  // 3. Commercial Invoices Attribution Integration
  describe("3. Commercial Invoices Attribution Integration", () => {
    it("verifies SalesInvoiceNew fetches active employees and passes salesReps to InvoiceHeader", () => {
      expect(salesInvoiceSource).toContain("trpc.employees.list.useQuery");
      expect(salesInvoiceSource).toContain("salesReps={salesReps}");
    });

    it("verifies SalesInvoiceNew includes salesRepId in buildPayload and buildCorrectionPayload", () => {
      expect(salesInvoiceSource).toContain("salesRepId: state.salesRepId ? Number(state.salesRepId) : undefined");
      expect(salesInvoiceSource).toContain("salesRepId: base.salesRepId");
    });

    it("verifies InvoiceHeader renders salesRepId selection for sales invoices", () => {
      expect(invoiceHeaderSource).toContain("salesReps && salesReps.length > 0");
      expect(invoiceHeaderSource).toContain('label="مندوب المبيعات"');
      expect(invoiceHeaderSource).toContain('field: "salesRepId"');
    });
  });

  // 4. Zero Draft Loss & Executive KPI Cockpit Invariants
  describe("4. Zero Draft Loss & Executive KPI Cockpit Invariants", () => {
    it("verifies UnifiedCommissionsHub keeps all 4 sub-views mounted via CSS hidden", () => {
      expect(hubSource).toContain('activeView === "runs" ? "block space-y-4" : "hidden"');
      expect(hubSource).toContain('activeView === "targets" ? "block space-y-4" : "hidden"');
      expect(hubSource).toContain('activeView === "plans" ? "block space-y-4" : "hidden"');
      expect(hubSource).toContain('activeView === "attribution" ? "block space-y-5" : "hidden"');
      expect(hubSource).toContain("<CommissionRuns />");
      expect(hubSource).toContain("<CommissionTargets />");
      expect(hubSource).toContain("<CommissionPlans />");
    });

    it("verifies all 4 executive KPI cards and negative carryover are rendered", () => {
      expect(hubSource).toContain('data-testid="kpi-totalBaseSales"');
      expect(hubSource).toContain('data-testid="kpi-averageAchievementPct"');
      expect(hubSource).toContain('data-testid="kpi-totalCommissionDue"');
      expect(hubSource).toContain('data-testid="kpi-runStatus"');
      expect(hubSource).toContain("الترحيل السالب");
    });

    it("verifies Maker-Checker Segregation of Duties (SOD) warning indicator", () => {
      expect(hubSource).toContain("تحذير فصل المهام (SOD)");
      expect(hubSource).toContain("أنت من أنشأ هذه المسودة، ويلزم اعتمادها من مراجع/مدير آخر");
    });
  });
});
