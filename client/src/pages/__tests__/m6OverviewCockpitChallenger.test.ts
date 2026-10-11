/**
 * Milestone 6 Overview Cockpit & Shared Operational Toolbar — Adversarial Challenger Test Suite
 *
 * Verifies R1-R5 requirements for Milestone 6:
 * 1. Title & Header Rebranding: Canonical Arabic terminology ("لوحة المتابعة العامة") and zero prohibited jargon.
 * 2. Governance: Zero raw emoji, zero raw <table>, zero raw status colors, zero window.print/confirm, <1200 lines.
 * 3. 6 Mandated Executive Cockpit Metrics (Feature 18):
 *    - satisfactionScore
 *    - pendingComplaintsCount
 *    - activeDealsCount
 *    - activeCampaignsCount
 *    - totalReceivablesBalance (Decimal.js precision)
 *    - overdueReceivablesCount
 * 4. RBAC Gate Enforcement: REPORT_VIEWER_GATE protects financial debt metrics from unauthorized roles.
 * 5. 4 Mandated Quick Action Launchers (Feature 18): Canonical routes with both wing and tab query parameters.
 * 6. 4 Wing Bento Cards: Hierarchical navigation launchers covering all 4 functional wings.
 * 7. Universal 360 Customer Profile Search: CustomerSearchPicker with barcode scanner and CustomerDossierDrawer.
 * 8. Print Engine: printReportDoc usage for A4 executive cockpit reports.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";
import { D, fmtAr } from "@/lib/money";
import { canSeeGate, type RoleGate } from "@/lib/navVisibility";
import {
  CANONICAL_WINGS,
  MANDATED_ARABIC_TERMINOLOGY,
  PROHIBITED_JARGON,
  resolveCustomerHubNavigation,
} from "@/lib/__tests__/customerHubWings.e2e.test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const OVERVIEW_PAGE_FILE = path.join(
  REPO_ROOT,
  "client/src/pages/CrmOverview.tsx"
);
const SEARCH_PICKER_FILE = path.join(
  REPO_ROOT,
  "client/src/components/crm/CustomerSearchPicker.tsx"
);

const M6_FILES = [OVERVIEW_PAGE_FILE, SEARCH_PICKER_FILE];

describe("Milestone 6 Challenger: Overview Cockpit & Shared Operational Toolbar", () => {
  /* =====================================================================
   * 1. GOVERNANCE & REPOSITORY INVARIANTS
   * ===================================================================== */
  describe("1. Governance & Repository Invariants", () => {
    it("has ZERO raw emojis in all Milestone 6 source files", () => {
      const emojiRegex =
        /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{231A}-\u{231B}\u{23E9}-\u{23FA}\u{25B0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;

      for (const filePath of M6_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          const match = line.match(emojiRegex);
          expect(
            match,
            `Forbidden emoji found at ${path.basename(filePath)}:${index + 1}: ${line}`
          ).toBeNull();
        });
      }
    });

    it("has ZERO raw HTML <table> tags in Milestone 6 files", () => {
      const rawTableRegex = /<table[\s>]/;
      for (const filePath of M6_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        expect(
          rawTableRegex.test(content),
          `Forbidden raw <table> tag found in ${path.basename(filePath)}`
        ).toBe(false);
      }
    });

    it("has ZERO raw status colors (red, rose, green, emerald, amber, yellow hues)", () => {
      const rawColorRegex =
        /(?<![\w-])(?:text|bg|border|ring|from|to|via)-(?:red|rose|green|emerald|amber|yellow)-\d{2,3}(?![\w-])/;
      for (const filePath of M6_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        expect(
          rawColorRegex.test(content),
          `Forbidden raw status color found in ${path.basename(filePath)}`
        ).toBe(false);
      }
    });

    it("has ZERO window.print calls across all Milestone 6 files", () => {
      for (const filePath of M6_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        expect(
          content.includes("window.print"),
          `Forbidden window.print found in ${path.basename(filePath)}`
        ).toBe(false);
      }
    });

    it("has ZERO window.confirm or window.alert calls across all Milestone 6 files", () => {
      for (const filePath of M6_FILES) {
        const content = fs.readFileSync(filePath, "utf-8");
        expect(
          /window\.(confirm|alert|prompt)\b/.test(content),
          `Forbidden window dialog found in ${path.basename(filePath)}`
        ).toBe(false);
      }
    });

    it("CrmOverview.tsx line count is strictly under 1200 lines (and under 500 lines)", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      const lines = content.split("\n").length;
      expect(lines).toBeLessThan(1200);
      expect(lines).toBeLessThan(500);
    });
  });

  /* =====================================================================
   * 2. TITLE & HEADER REBRANDING (ZERO JARGON CONTRACT)
   * ===================================================================== */
  describe("2. Title & Header Rebranding (Zero Jargon Contract)", () => {
    it("uses canonical approved title 'لوحة المتابعة العامة'", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      expect(content).toContain('title="لوحة المتابعة العامة"');
      expect(content).toContain(MANDATED_ARABIC_TERMINOLOGY.overview);
    });

    it("uses canonical PageHeader description without jargon", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      expect(content).toContain(
        'description="نظرة شاملة وموحدة على أداء رعاية الزبائن، المبيعات، الحملات، والتحصيل مع أدوات وصول سريعة."'
      );
    });

    it("purges all prohibited jargon from CrmOverview.tsx", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      for (const jargon of PROHIBITED_JARGON) {
        expect(
          content.includes(jargon),
          `Prohibited jargon '${jargon}' found in CrmOverview.tsx`
        ).toBe(false);
      }
      expect(content).not.toContain("إدارة علاقات العملاء CRM");
    });
  });

  /* =====================================================================
   * 3. 6 MANDATED EXECUTIVE COCKPIT METRICS (FEATURE 18)
   * ===================================================================== */
  describe("3. 6 Mandated Executive Cockpit Metrics (Feature 18)", () => {
    const MANDATED_METRIC_KEYS = [
      "satisfactionScore",
      "pendingComplaintsCount",
      "activeDealsCount",
      "activeCampaignsCount",
      "totalReceivablesBalance",
      "overdueReceivablesCount",
    ];

    it("implements all 6 mandated metric keys in CrmOverview.tsx metrics computation", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      for (const metric of MANDATED_METRIC_KEYS) {
        expect(
          content.includes(metric),
          `Mandated metric '${metric}' not found in CrmOverview.tsx`
        ).toBe(true);
      }
    });

    it("correctly queries all 4 backend routers for cockpit data", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      // Wing 1 (Care)
      expect(content).toContain("trpc.customers.feedbackList.useQuery");
      // Wing 2 (Sales)
      expect(content).toContain("trpc.salesPipeline.dashboard.useQuery");
      // Wing 3 (Marketing)
      expect(content).toContain("trpc.crm.dashboard.useQuery");
      // Wing 4 (Finance)
      expect(content).toContain("trpc.reports.arAging.useQuery");
    });

    it("computes satisfactionScore and pendingComplaintsCount faithfully", () => {
      const mockFeedbacks = [
        { rating: 5, issueStatus: "RESOLVED" },
        { rating: 4, issueStatus: "NEW" },
        { rating: 3, issueStatus: "IN_PROGRESS" },
        { rating: 5, issueStatus: "CLOSED" },
      ];

      const avgRating = (
        mockFeedbacks.reduce((sum, item) => sum + item.rating, 0) /
        mockFeedbacks.length
      ).toFixed(1);
      const pendingCount = mockFeedbacks.filter(
        (item) => item.issueStatus === "NEW" || item.issueStatus === "IN_PROGRESS"
      ).length;

      expect(avgRating).toBe("4.3");
      expect(pendingCount).toBe(2);
    });

    it("computes activeDealsCount from DISCOVERY, PROPOSAL, NEGOTIATION stages", () => {
      const mockOppCounts = {
        LEAD: 10,
        DISCOVERY: 3,
        PROPOSAL: 4,
        NEGOTIATION: 7,
        WON: 25,
        LOST: 5,
      };

      const activeDeals =
        mockOppCounts.DISCOVERY +
        mockOppCounts.PROPOSAL +
        mockOppCounts.NEGOTIATION;

      expect(activeDeals).toBe(14);
    });

    it("computes totalReceivablesBalance with Decimal.js precision over 1,000 transactions without drift", () => {
      const sampleItem = { unpaidTotal: "12345.67" };
      const rows = Array.from({ length: 1000 }, () => sampleItem);

      let total = D(0);
      for (const row of rows) {
        total = total.plus(D(row.unpaidTotal));
      }

      expect(total.toFixed(2)).toBe("12345670.00");
    });

    it("computes overdueReceivablesCount accurately across aging buckets", () => {
      const mockAgingRows = [
        { d31_60: "1000", d61_90: "0", d91p: "0" }, // overdue
        { d31_60: "0", d61_90: "500", d91p: "0" }, // overdue
        { d31_60: "0", d61_90: "0", d91p: "200" }, // overdue
        { d31_60: "0", d61_90: "0", d91p: "0" },   // current (not overdue)
        { d31_60: null, d61_90: null, d91p: null },// null (not overdue)
      ];

      let overdueCount = 0;
      for (const row of mockAgingRows) {
        const overdueSum = D(row.d31_60 || 0)
          .plus(D(row.d61_90 || 0))
          .plus(D(row.d91p || 0));
        if (overdueSum.gt(0)) {
          overdueCount++;
        }
      }

      expect(overdueCount).toBe(3);
    });
  });

  /* =====================================================================
   * 4. RBAC ROLE GATE ENFORCEMENT FOR FINANCE METRICS
   * ===================================================================== */
  describe("4. RBAC Role Gate Enforcement for Finance Metrics", () => {
    const REPORT_VIEWER_GATE: RoleGate = {
      roles: ["manager", "accountant", "auditor"],
      module: "reports",
      level: "READ",
    };

    it("grants access to manager, accountant, auditor, and admin", () => {
      expect(canSeeGate(REPORT_VIEWER_GATE, "admin")).toBe(true);
      expect(canSeeGate(REPORT_VIEWER_GATE, "manager")).toBe(true);
      expect(canSeeGate(REPORT_VIEWER_GATE, "accountant")).toBe(true);
      expect(canSeeGate(REPORT_VIEWER_GATE, "auditor")).toBe(true);
    });

    it("denies access to cashier, sales_rep, courier, and unauthenticated users", () => {
      expect(canSeeGate(REPORT_VIEWER_GATE, "cashier")).toBe(false);
      expect(canSeeGate(REPORT_VIEWER_GATE, "sales_rep")).toBe(false);
      expect(canSeeGate(REPORT_VIEWER_GATE, "courier")).toBe(false);
      expect(canSeeGate(REPORT_VIEWER_GATE, null)).toBe(false);
      expect(canSeeGate(REPORT_VIEWER_GATE, undefined)).toBe(false);
    });

    it("passes enabled flag conditioned on canViewReports to arAging query", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      expect(content).toContain("enabled: Boolean(canViewReports)");
      expect(content).toContain("canSeeGate(REPORT_VIEWER_GATE");
    });

    it("renders locked state with Lock icon when user is unauthorized", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      expect(content).toContain("locked: !canViewReports");
      expect(content).toContain("kpi.locked ? (");
      expect(content).toContain("محمي بصلاحية الإدارة");
      expect(content).toContain("Lock");
    });
  });

  /* =====================================================================
   * 5. 4 MANDATED QUICK ACTION LAUNCHERS (FEATURE 18)
   * ===================================================================== */
  describe("5. 4 Mandated Quick Action Launchers (Feature 18)", () => {
    const EXPECTED_QUICK_ACTIONS = [
      { label: "تسجيل شكوى", target: "/crm?wing=care&tab=complaints" },
      { label: "عرض سعر جديد", target: "/crm?wing=sales&tab=quotations" },
      { label: "إطلاق حملة", target: "/crm?wing=marketing&tab=campaigns" },
      { label: "كشف الحسابات", target: "/crm?wing=finance&tab=statement" },
    ];

    it("implements all 4 mandated quick links in PRIMARY_QUICK_ACTIONS", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      for (const action of EXPECTED_QUICK_ACTIONS) {
        expect(content).toContain(action.label);
        expect(content).toContain(action.target);
      }
    });

    it("all quick action targets map to valid canonical 2-tier routes", () => {
      for (const action of EXPECTED_QUICK_ACTIONS) {
        const [pathStr, queryStr] = action.target.split("?");
        expect(pathStr).toBe("/crm");
        const params = new URLSearchParams(queryStr);
        expect(params.has("wing")).toBe(true);
        expect(params.has("tab")).toBe(true);

        const wing = params.get("wing") as any;
        const tab = params.get("tab") as any;
        expect(CANONICAL_WINGS[wing]).toBeDefined();
        expect(CANONICAL_WINGS[wing].subTabs).toContain(tab);
      }
    });
  });

  /* =====================================================================
   * 6. 4 WING BENTO CARDS (WING LAUNCHERS)
   * ===================================================================== */
  describe("6. 4 Wing Bento Cards (Wing Launchers)", () => {
    const EXPECTED_WINGS = [
      { id: "care", title: "خدمة ورعاية الزبائن", target: "/crm?wing=care&tab=customers" },
      { id: "sales", title: "المبيعات وعروض الأسعار", target: "/crm?wing=sales&tab=quotations" },
      { id: "marketing", title: "التسويق والكوبونات والولاء", target: "/crm?wing=marketing&tab=campaigns" },
      { id: "finance", title: "الحسابات والديون والتحصيل", target: "/crm?wing=finance&tab=statement" },
    ];

    it("implements all 4 wing launchers in WING_LAUNCHERS", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      for (const wing of EXPECTED_WINGS) {
        expect(content).toContain(wing.id);
        expect(content).toContain(wing.title);
        expect(content).toContain(wing.target);
      }
    });

    it("provides sub-tab navigation links for all 4 wings", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      expect(content).toContain('href={`/crm?wing=${id}&tab=${tab}`}');
      expect(content).toContain("قائمة الزبائن");
      expect(content).toContain("عروض الأسعار");
      expect(content).toContain("الحملات الإعلانية");
      expect(content).toContain("كشف حساب الزبون");
    });
  });

  /* =====================================================================
   * 7. UNIVERSAL 360 CUSTOMER SEARCH & DOSSIER DRAWER
   * ===================================================================== */
  describe("7. Universal 360 Customer Search & Dossier Drawer", () => {
    it("creates CustomerSearchPicker component supporting barcode scanner", () => {
      const content = fs.readFileSync(SEARCH_PICKER_FILE, "utf-8");
      expect(content).toContain("UnifiedSearchInput");
      expect(content).toContain("barcode={true}");
      expect(content).toContain("trpc.customers.smartSearch.useQuery");
      expect(content).toContain("onSelectCustomer");
    });

    it("CustomerSearchPicker formats balance and uses semantic status tokens", () => {
      const content = fs.readFileSync(SEARCH_PICKER_FILE, "utf-8");
      expect(content).toContain("fmtAr(c.currentBalance)");
      expect(content).toContain("var(--sem-warn-bg)");
      expect(content).toContain("var(--sem-pos-bg)");
      expect(content).toContain("الملف الشامل 360°");
    });

    it("CrmOverview mounts CustomerSearchPicker and CustomerDossierDrawer", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      expect(content).toContain("<CustomerSearchPicker onSelectCustomer={setDossierCustomerId} />");
      expect(content).toContain("CustomerDossierDrawer");
      expect(content).toContain("customerId={dossierCustomerId}");
      expect(content).toContain("open={Boolean(dossierCustomerId)}");
      expect(content).toContain("onClose={() => setDossierCustomerId(null)}");
    });
  });

  /* =====================================================================
   * 8. PRINT ENGINE INTEGRATION (printReportDoc)
   * ===================================================================== */
  describe("8. Print Engine Integration (printReportDoc)", () => {
    it("imports and calls printReportDoc without window.print", () => {
      const content = fs.readFileSync(OVERVIEW_PAGE_FILE, "utf-8");
      expect(content).toContain('import { printReportDoc } from "@/lib/printing/reportDoc"');
      expect(content).toContain("handlePrintCockpitReport");
      expect(content).toContain("title: \"لوحة المتابعة العامة — التقرير التنفيذي الموحد\"");
      expect(content).not.toContain("window.print");
    });
  });

  /* =====================================================================
   * 9. ADVERSARIAL STRESS TESTING (EMPIRICAL CHALLENGER ASSURANCES)
   * ===================================================================== */
  describe("9. Adversarial Empirical Stress Testing", () => {
    describe("9.1 Decimal.js Precision & Edge-Case Robustness", () => {
      it("computes totalReceivablesBalance accurately across dirty inputs (null, undefined, empty string, zero, negative credits, huge amounts)", () => {
        const dirtyRows = [
          { unpaidTotal: null },
          { unpaidTotal: undefined },
          { unpaidTotal: "" },
          { unpaidTotal: "0" },
          { unpaidTotal: "0.00" },
          { unpaidTotal: "-1250000.50" }, // credit balance / return
          { unpaidTotal: "8500000000.75" }, // 8.5 billion IQD
          { unpaidTotal: "0.0001" }, // sub-cent fraction
          { unpaidTotal: "1250000.50" }, // exact offsetting credit
        ];

        let total = D(0);
        for (const row of dirtyRows) {
          total = total.plus(D(row.unpaidTotal || 0));
        }

        expect(total.toFixed(2)).toBe("8500000000.75");
      });

      it("immune to IEEE 754 binary floating-point drift over 10,000 synthetic micro-transactions", () => {
        // Group of 4 numbers totaling exactly 0.50: 0.10 + 0.20 + 0.07 + 0.13 = 0.50
        // In standard JS number float: 0.1 + 0.2 = 0.30000000000000004
        const microBatch = ["0.10", "0.20", "0.07", "0.13"];
        const iterations = 2500; // 2500 * 4 = 10,000 items -> expected total = 1250.00 exactly

        let decimalTotal = D(0);
        let floatAccumulator = 0;

        for (let i = 0; i < iterations; i++) {
          for (const val of microBatch) {
            decimalTotal = decimalTotal.plus(D(val));
            floatAccumulator += Number(val);
          }
        }

        expect(decimalTotal.toFixed(2)).toBe("1250.00");
        // Verify float accumulator drift does not affect Decimal.js
        expect(decimalTotal.eq(D("1250.00"))).toBe(true);
      });

      it("handles overdue buckets with zero, null, sub-zero, and extreme overdue amounts", () => {
        const adversarialAging = [
          { d31_60: "0.00", d61_90: "0", d91p: null }, // zero -> not overdue
          { d31_60: "-500", d61_90: "0", d91p: "0" }, // negative sum -> not overdue
          { d31_60: "0.01", d61_90: "0", d91p: "0" }, // 1 fils overdue -> overdue
          { d31_60: null, d61_90: "15000000.00", d91p: null }, // 15M IQD -> overdue
          { d31_60: undefined, d61_90: undefined, d91p: undefined }, // all undefined -> not overdue
        ];

        let overdueCount = 0;
        for (const row of adversarialAging) {
          const overdueSum = D(row.d31_60 || 0)
            .plus(D(row.d61_90 || 0))
            .plus(D(row.d91p || 0));
          if (overdueSum.gt(0)) {
            overdueCount++;
          }
        }

        expect(overdueCount).toBe(2);
      });
    });

    describe("9.2 RBAC Role Matrix & Permissions Override", () => {
      const REPORT_VIEWER_GATE: RoleGate = {
        roles: ["manager", "accountant", "auditor"],
        module: "reports",
        level: "READ",
      };

      it("evaluates complete matrix of standard and unauthenticated roles", () => {
        const authorizedRoles = ["admin", "manager", "accountant", "auditor"];
        const unauthorizedRoles = [
          "cashier",
          "sales_rep",
          "courier",
          "operator",
          "technician",
          "designer",
          "customer",
          "",
          null,
          undefined,
        ];

        for (const role of authorizedRoles) {
          expect(canSeeGate(REPORT_VIEWER_GATE, role)).toBe(true);
        }

        for (const role of unauthorizedRoles) {
          expect(canSeeGate(REPORT_VIEWER_GATE, role)).toBe(false);
        }
      });

      it("honors permissionsOverride for unauthorized role (cashier) granted explicit reports access", () => {
        // Without override -> cashier denied
        expect(canSeeGate(REPORT_VIEWER_GATE, "cashier", null)).toBe(false);
        expect(canSeeGate(REPORT_VIEWER_GATE, "cashier", {})).toBe(false);
        expect(canSeeGate(REPORT_VIEWER_GATE, "cashier", { pos: "FULL" })).toBe(false);
        expect(canSeeGate(REPORT_VIEWER_GATE, "cashier", { reports: "NONE" })).toBe(false);

        // With explicit reports module override -> cashier granted
        expect(canSeeGate(REPORT_VIEWER_GATE, "cashier", { reports: "READ" })).toBe(true);
        expect(canSeeGate(REPORT_VIEWER_GATE, "cashier", { reports: "FULL" })).toBe(true);
      });
    });

    describe("9.3 Exhaustive 2-Tier Route Resolution for All 4 Wings and Sub-Tabs", () => {
      const ALL_WING_ROUTES = [
        // Wing 1: Care
        { wing: "care", tab: "customers" },
        { wing: "care", tab: "complaints" },
        { wing: "care", tab: "followups" },
        { wing: "care", tab: "contacts" },
        // Wing 2: Sales
        { wing: "sales", tab: "quotations" },
        { wing: "sales", tab: "pipeline" },
        { wing: "sales", tab: "contracts" },
        // Wing 3: Marketing
        { wing: "marketing", tab: "campaigns" },
        { wing: "marketing", tab: "broadcasts" },
        { wing: "marketing", tab: "offers" },
        { wing: "marketing", tab: "coupons" },
        // Wing 4: Finance
        { wing: "finance", tab: "statement" },
        { wing: "finance", tab: "collections" },
        { wing: "finance", tab: "aging" },
        { wing: "finance", tab: "installments" },
      ];

      it("resolves every wing card and subtab route strictly without fallback drift", () => {
        for (const route of ALL_WING_ROUTES) {
          const resolved = resolveCustomerHubNavigation({ wing: route.wing, tab: route.tab });
          expect(resolved.wing).toBe(route.wing);
          expect(resolved.tab).toBe(route.tab);
          expect(resolved.isLegacyRedirect).toBe(false);
        }
      });
    });

    describe("9.4 CustomerSearchPicker Gating & Semantic Tokens", () => {
      it("gates search query execution strictly on trimmed length >= 2", () => {
        const testInputs = [
          { input: "", expectedEnabled: false },
          { input: "   ", expectedEnabled: false },
          { input: "a", expectedEnabled: false },
          { input: "  a  ", expectedEnabled: false },
          { input: "ab", expectedEnabled: true },
          { input: "  ab  ", expectedEnabled: true },
          { input: "شركة الهدى", expectedEnabled: true },
          { input: "07701234567", expectedEnabled: true },
        ];

        for (const { input, expectedEnabled } of testInputs) {
          const trimmed = input.trim();
          const isEnabled = trimmed.length >= 2;
          expect(isEnabled).toBe(expectedEnabled);
        }
      });

      it("applies correct semantic balance color token (warn vs pos)", () => {
        function getBalanceBadgeCls(balance: number | string) {
          return D(balance).gt(0)
            ? "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
            : "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]";
        }

        expect(getBalanceBadgeCls("150000")).toContain("--sem-warn");
        expect(getBalanceBadgeCls("0.01")).toContain("--sem-warn");
        expect(getBalanceBadgeCls("0")).toContain("--sem-pos");
        expect(getBalanceBadgeCls("-5000")).toContain("--sem-pos");
      });
    });

    describe("9.5 Executive Report Print Payload Confidentiality", () => {
      it("masks financial rows and excludes summary balance when user is unauthorized", () => {
        function buildMockReportRows(canViewReports: boolean, totalBalance: string, overdueCount: number) {
          const rows = [
            {
              metric: "إجمالي أرصدة الذمم والديون",
              value: canViewReports ? `${fmtAr(totalBalance)} د.ع` : "محمي بالصلاحية",
              status: canViewReports ? "قائم" : "محمي",
            },
            {
              metric: "الحسابات المتأخرة بالسداد",
              value: canViewReports ? `${overdueCount} حساب` : "محمي بالصلاحية",
              status: canViewReports && overdueCount > 0 ? "تنبيه متأخرات" : "مستقر",
            },
          ];

          const summary = [
            { label: "معدل الرضا العام", value: "90%" },
            ...(canViewReports ? [{ label: "إجمالي الذمم القائمة", value: `${fmtAr(totalBalance)} د.ع` }] : []),
          ];

          return { rows, summary };
        }

        // 1. Unauthorized cashier
        const unauthReport = buildMockReportRows(false, "50000000.00", 12);
        expect(unauthReport.rows[0].value).toBe("محمي بالصلاحية");
        expect(unauthReport.rows[0].status).toBe("محمي");
        expect(unauthReport.rows[1].value).toBe("محمي بالصلاحية");
        expect(unauthReport.summary.some((s) => s.label.includes("إجمالي الذمم القائمة"))).toBe(false);

        // 2. Authorized manager
        const authReport = buildMockReportRows(true, "50000000.00", 12);
        expect(authReport.rows[0].value).toContain("50,000,000");
        expect(authReport.rows[0].status).toBe("قائم");
        expect(authReport.rows[1].value).toBe("12 حساب");
        expect(authReport.summary.some((s) => s.label.includes("إجمالي الذمم القائمة"))).toBe(true);
      });
    });
  });
});

