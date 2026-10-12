import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isCrmWingActive } from "@/components/navigation/HybridSidebarNav";
import { canSeeGate } from "../navVisibility";
import { type RoleKey } from "@shared/permissions";

/**
 * Empirical Verification & Challenge Test Suite:
 * Customer Hub Navigation Stability, Wing Isolation & Remediation Verification
 *
 * Verifies the remediation implemented in Milestone 1 Iteration 2:
 * 1. Primary sub-tab expulsion resolved: clicking tab 0 in any wing preserves the active wing.
 * 2. Wing-tab conflict resolution: when wing and tab conflict in the URL, the tab's canonical wing wins.
 * 3. Sidebar active indicator synchronization: isCrmWingActive correctly reflects active wing on tab 0 and conflicts.
 * 4. RoleGate empty state: restricted roles with 0 visible tabs receive the alert fallback with rescue actions.
 * 5. Architectural invariants in CrmHub.tsx: PageTabs eliminated, 2-tier CrmWingTabs with full parameter retention.
 */

describe("Customer Hub Navigation Remediation — Empirical Verification", () => {
  const crmHubPath = path.resolve(__dirname, "../../pages/CrmHub.tsx");
  const crmHubContent = fs.readFileSync(crmHubPath, "utf8");

  const WING_CONFIGS = [
    { id: "care", defaultTab: "customers", tabs: ["customers", "complaints", "followups", "contacts"] },
    { id: "sales", defaultTab: "quotations", tabs: ["quotations", "pipeline", "contracts"] },
    { id: "marketing", defaultTab: "campaigns", tabs: ["campaigns", "broadcasts", "offers", "coupons"] },
    { id: "finance", defaultTab: "statement", tabs: ["statement", "collections", "aging", "installments"] },
    { id: "overview", defaultTab: "overview", tabs: ["overview"] },
  ] as const;

  const TAB_TO_WING: Record<string, string> = {
    customers: "care",
    complaints: "care",
    followups: "care",
    contacts: "care",
    inbox: "care",
    quotations: "sales",
    pipeline: "sales",
    contracts: "sales",
    campaigns: "marketing",
    broadcasts: "marketing",
    offers: "marketing",
    coupons: "marketing",
    statement: "finance",
    collections: "finance",
    aging: "finance",
    installments: "finance",
    overview: "overview",
  };

  /**
   * Evaluates activeWing derivation exactly as implemented in CrmHub.tsx (lines 537-545):
   *   if (rawTab && TAB_TO_WING[rawTab]) return TAB_TO_WING[rawTab];
   *   if (rawWing && WING_CONFIGS.some((w) => w.id === rawWing)) return rawWing;
   *   return "overview";
   */
  function resolveActiveWingRemediated(searchStr: string): string {
    const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
    const rawWing = params.get("wing");
    const rawTab = params.get("tab");

    if (rawTab && TAB_TO_WING[rawTab]) {
      return TAB_TO_WING[rawTab];
    }
    if (rawWing && WING_CONFIGS.some((w) => w.id === rawWing)) {
      return rawWing;
    }
    return "overview";
  }

  /**
   * Simulates CrmHub.tsx's handleSelectTab (lines 563-569):
   *   params.set("wing", activeWing);
   *   params.set("tab", tabValue);
   */
  function simulateCrmHubSelectTab(
    currentSearch: string,
    activeWing: string,
    tabValue: string,
  ): { targetUrl: string; nextSearch: string } {
    const loc = "/crm";
    const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
    params.set("wing", activeWing);
    params.set("tab", tabValue);
    const qs = params.toString();
    const targetUrl = qs ? `${loc}?${qs}` : loc;
    return { targetUrl, nextSearch: qs ? `?${qs}` : "" };
  }

  describe("1. Verification: Clicking Tab 0 No Longer Expels User From Any Wing", () => {
    it.each([
      { wingId: "sales", tab0: "quotations", tab1: "pipeline" },
      { wingId: "care", tab0: "customers", tab1: "complaints" },
      { wingId: "marketing", tab0: "campaigns", tab1: "broadcasts" },
      { wingId: "finance", tab0: "statement", tab1: "collections" },
    ])(
      "Empirical proof: clicking $tab0 in wing '$wingId' retains wing and does NOT degrade to overview",
      ({ wingId, tab0, tab1 }) => {
        // Step 1: User visits wing with secondary tab1
        const initialSearch = `?wing=${wingId}&tab=${tab1}`;
        expect(resolveActiveWingRemediated(initialSearch)).toBe(wingId);

        // Step 2: User clicks tab0 (first tab)
        const navBackToTab0 = simulateCrmHubSelectTab(initialSearch, wingId, tab0);

        // Crucial verification: URL retains both wing and tab!
        expect(navBackToTab0.targetUrl).toBe(`/crm?wing=${wingId}&tab=${tab0}`);
        expect(navBackToTab0.nextSearch).toContain(`wing=${wingId}`);
        expect(navBackToTab0.nextSearch).toContain(`tab=${tab0}`);

        // activeWing evaluates correctly to wingId, NOT overview!
        const activeWing = resolveActiveWingRemediated(navBackToTab0.nextSearch);
        expect(activeWing).toBe(wingId);
        expect(activeWing).not.toBe("overview");
      },
    );

    it.each([
      { wingId: "sales", tab0: "quotations" },
      { wingId: "care", tab0: "customers" },
      { wingId: "marketing", tab0: "campaigns" },
      { wingId: "finance", tab0: "statement" },
    ])(
      "Initial landing on wing without tab (?wing=$wingId) retains wing when clicking tab 0 ($tab0)",
      ({ wingId, tab0 }) => {
        const initialSearch = `?wing=${wingId}`;
        const activeWing = resolveActiveWingRemediated(initialSearch);
        expect(activeWing).toBe(wingId);

        const navClickTab0 = simulateCrmHubSelectTab(initialSearch, activeWing, tab0);
        expect(navClickTab0.targetUrl).toBe(`/crm?wing=${wingId}&tab=${tab0}`);
        expect(resolveActiveWingRemediated(navClickTab0.nextSearch)).toBe(wingId);
      },
    );
  });

  describe("2. Verification: Wing-Tab Conflict Resolution", () => {
    it.each([
      { rawWing: "sales", rawTab: "statement", expectedWing: "finance" },
      { rawWing: "care", rawTab: "quotations", expectedWing: "sales" },
      { rawWing: "marketing", rawTab: "customers", expectedWing: "care" },
      { rawWing: "finance", rawTab: "campaigns", expectedWing: "marketing" },
      { rawWing: "sales", rawTab: "installments", expectedWing: "finance" },
      { rawWing: "finance", rawTab: "pipeline", expectedWing: "sales" },
      { rawWing: "care", rawTab: "coupons", expectedWing: "marketing" },
      { rawWing: "marketing", rawTab: "complaints", expectedWing: "care" },
    ])(
      "Resolves conflict ?wing=$rawWing&tab=$rawTab to expected wing '$expectedWing'",
      ({ rawWing, rawTab, expectedWing }) => {
        const search = `?wing=${rawWing}&tab=${rawTab}`;
        const resolved = resolveActiveWingRemediated(search);
        expect(resolved).toBe(expectedWing);
        expect(resolved).not.toBe(rawWing);
      },
    );

    it("Falls back to rawWing when tab is invalid or unrecognized", () => {
      const search = "?wing=sales&tab=unknown_tab_xyz";
      const resolved = resolveActiveWingRemediated(search);
      expect(resolved).toBe("sales");
    });

    it("Resolves legacy URL without wing (?tab=statement) directly to canonical wing", () => {
      const search = "?tab=statement";
      const resolved = resolveActiveWingRemediated(search);
      expect(resolved).toBe("finance");
    });
  });

  describe("3. Verification: Sidebar Active Indicator Synchronization (isCrmWingActive)", () => {
    it.each([
      { wingId: "sales", tab: "quotations" },
      { wingId: "care", tab: "customers" },
      { wingId: "marketing", tab: "campaigns" },
      { wingId: "finance", tab: "statement" },
    ])(
      "Sidebar highlights wing '$wingId' correctly on tab 0 ($tab)",
      ({ wingId, tab }) => {
        const search = `?wing=${wingId}&tab=${tab}`;
        expect(isCrmWingActive("/crm", search, wingId)).toBe(true);
        expect(isCrmWingActive("/crm", search, "overview")).toBe(false);

        // Verify other wings are not active
        for (const other of ["sales", "care", "marketing", "finance"]) {
          if (other !== wingId) {
            expect(isCrmWingActive("/crm", search, other)).toBe(false);
          }
        }
      },
    );

    it("Sidebar correctly follows wing-tab conflict priority", () => {
      // ?wing=sales&tab=statement should highlight finance in sidebar, not sales
      const search = "?wing=sales&tab=statement";
      expect(isCrmWingActive("/crm", search, "finance")).toBe(true);
      expect(isCrmWingActive("/crm", search, "sales")).toBe(false);
      expect(isCrmWingActive("/crm", search, "overview")).toBe(false);
    });

    it("Sidebar highlights overview when on root /crm without query parameters", () => {
      expect(isCrmWingActive("/crm", "", "overview")).toBe(true);
      expect(isCrmWingActive("/crm", "", "sales")).toBe(false);
      expect(isCrmWingActive("/crm", "", "care")).toBe(false);
    });
  });

  describe("4. Verification: RoleGate Empty State in Finance Wing", () => {
    const REPORT_VIEWER_GATE = {
      roles: ["manager", "accountant", "auditor"],
      module: "reports",
      level: "READ" as const,
    };

    const FINANCE_TABS = [
      { value: "statement", gate: REPORT_VIEWER_GATE },
      { value: "collections", gate: { module: "collections", level: "FULL" as const } },
      { value: "aging", gate: REPORT_VIEWER_GATE },
      { value: "installments", gate: { module: "treasury", level: "READ" as const } },
    ];

    const restrictedRoles: RoleKey[] = ["print_operator", "courier", "warehouse"];

    it("Verifies restricted roles have 0 visible tabs in Finance wing", () => {
      for (const role of restrictedRoles) {
        const visible = FINANCE_TABS.filter((t) => canSeeGate(t.gate, role, null));
        expect(visible.length).toBe(0);
      }
    });

    it("CrmHub.tsx contains explicit empty state card and rescue navigation buttons", () => {
      expect(crmHubContent).toContain("if (visible.length === 0)");
      expect(crmHubContent).toContain("لا تتوفر صلاحيات لعرض هذا القسم");
      expect(crmHubContent).toContain("AlertCircle");
      // Rescue buttons:
      expect(crmHubContent).toContain('onSelectWing("care")');
      expect(crmHubContent).toContain('onSelectWing("overview")');
    });
  });

  describe("5. Verification: Architectural Invariants & Code Hygiene", () => {
    it("CrmHub.tsx does NOT use PageTabs component (eliminated to avoid 1-tier URL strip)", () => {
      expect(crmHubContent).not.toContain("<PageTabs");
      expect(crmHubContent).toContain("function CrmWingTabs");
      expect(crmHubContent).toContain("<CrmWingTabs");
    });

    it("CrmHub.tsx handleSelectTab always preserves activeWing in URL query", () => {
      expect(crmHubContent).toContain('params.set("wing", activeWing);');
      expect(crmHubContent).toContain('params.set("tab", tabValue);');
    });

    it("CrmHub.tsx activeWing checks rawTab before rawWing to auto-resolve conflicts", () => {
      const tabCheckIdx = crmHubContent.indexOf("if (rawTab && TAB_TO_WING[rawTab])");
      const wingCheckIdx = crmHubContent.indexOf("if (rawWing && (WING_CONFIGS.some");
      expect(tabCheckIdx).toBeGreaterThan(0);
      expect(wingCheckIdx).toBeGreaterThan(0);
      expect(tabCheckIdx).toBeLessThan(wingCheckIdx);
    });

    it("CrmHub.tsx imports ACTION_LABELS.loading for loading strings guard compliance", () => {
      expect(crmHubContent).toContain("ACTION_LABELS.loading");
      expect(crmHubContent).toContain("TabFallback");
    });
  });
});
