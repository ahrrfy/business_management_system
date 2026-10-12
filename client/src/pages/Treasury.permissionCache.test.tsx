import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationUser } from "@shared/operationPermissions";
import { canSeeGate } from "@/lib/navVisibility";
import Treasury from "./Treasury";
import TreasuryHub from "./TreasuryHub";

const state = vi.hoisted(() => ({
  user: null as OperationUser | null,
  tabs: [] as any[],
}));
const cached = {
  getDashboard: {
    generatedAt: "2026-10-12T10:00:00Z",
    hideTreasury: false,
    drawerBalances: [
      {
        branchId: 9,
        branchName: "الفرع",
        expectedCash: "812301",
        openShiftsCount: 1,
      },
    ],
    treasuryBalances: [{ branchId: 9, branchName: "الفرع", balance: "812302" }],
    openShiftsCount: 1,
    todayReceiptsTotal: "812303",
    todayExpensesTotal: "812304",
  },
  getKpiTrends: {
    drawerTotal: { deltaPct: 812305 },
    treasuryTotal: { deltaPct: 812306 },
    openShifts: { deltaPct: 812307 },
    todayReceipts: { deltaPct: 812308, sparkline: [812309] },
    todayExpenses: { deltaPct: 812310, sparkline: [812311] },
  },
  getCashFlowSeries: [{ cashIn: "812312", cashOut: "812313" }],
  getPaymentMethodBreakdown: [{ paymentMethod: "CASH", total: "812314" }],
  getRecentMovements: {
    rows: [{ id: "812315", amount: "812316" }],
    hasMore: false,
  },
  getOpenShifts: [{ id: 812317, expectedCash: "812318" }],
  pendingHandoverReceipts: [],
  pendingHandoverQueue: [{ id: 812319, amount: "812320" }],
};
vi.mock("@/lib/trpc", () => {
  const result = (data: unknown) => ({
    data,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  const procedures = new Proxy(
    {},
    {
      get: (_target, path: string) => ({
        useQuery: () => result(cached[path as keyof typeof cached]),
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
        invalidate: vi.fn(),
      }),
    },
  );
  return {
    trpc: {
      useUtils: () => ({ treasury: procedures }),
      auth: { me: { useQuery: () => result(state.user) } },
      branches: {
        list: {
          useQuery: () =>
            result([{ id: 9, name: "الفرع", branchType: "MAIN" }]),
        },
      },
      treasury: procedures,
      shifts: procedures,
    },
  };
});
function snapshot(props: unknown) {
  return React.createElement("output", null, JSON.stringify(props));
}
vi.mock("@/components/treasury/TreasuryKpiCard", () => ({
  TreasuryKpiCard: snapshot,
}));
vi.mock("@/components/treasury/BranchBalanceCard", () => ({
  BranchBalanceCard: snapshot,
}));
vi.mock("@/components/treasury/BranchComparisonChart", () => ({
  BranchComparisonChart: snapshot,
}));
vi.mock("@/components/treasury/CashFlowChart", () => ({
  CashFlowChart: snapshot,
}));
vi.mock("@/components/treasury/OpenShiftsPanel", () => ({
  OpenShiftsPanel: snapshot,
}));
vi.mock("@/components/treasury/PaymentMethodDonut", () => ({
  PaymentMethodDonut: snapshot,
}));
vi.mock("@/components/treasury/DeliveryCustodyCard", () => ({
  DeliveryCustodyCard: () => null,
}));
vi.mock("@/components/treasury/PendingHandoversSection", () => ({
  PendingHandoversSection: ({ canGovernHandovers, pendingQueue }: any) =>
    canGovernHandovers ? snapshot(pendingQueue.data) : null,
  CustodyQueryNotice: () => null,
}));
vi.mock("@/components/treasury/FundTreasuryDialog", () => ({
  FundTreasuryDialog: () => null,
}));
vi.mock("@/components/data-table/DataTable", () => ({
  DataTable: ({ data }: any) => snapshot(data),
}));
vi.mock("@/components/PageTabs", () => ({
  PageTabs: ({ tabs }: any) => {
    state.tabs = tabs;
    return null;
  },
}));
vi.mock("wouter", () => ({
  Link: ({ href, children }: any) =>
    React.createElement("a", { href }, children),
}));
(globalThis as any).React = React;

function grants(...paths: string[]): OperationUser {
  return {
    role: "cashier",
    operationPolicyEnabled: true,
    roleOperationPolicy: {
      version: 1,
      grants: Object.fromEntries(
        paths.map((path) => [`operation.${path}`, true]),
      ),
    },
  };
}
const finance = [
  "treasury.getDashboard",
  "treasury.getKpiTrends",
  "treasury.getCashFlowSeries",
  "treasury.getPaymentMethodBreakdown",
  "treasury.getRecentMovements",
  "treasury.getOpenShifts",
];

describe("treasury cached data follows current exact grants", () => {
  beforeEach(() => {
    state.user = grants(...finance);
  });
  it("masks cached KPI trends while dashboard remains independently allowed", () => {
    const allowed = renderToStaticMarkup(<Treasury />);
    expect(allowed).toContain("812305");
    state.user = grants("treasury.getDashboard");
    const revoked = renderToStaticMarkup(<Treasury />);
    expect(revoked).toContain("812302");
    for (let sentinel = 812305; sentinel <= 812318; sentinel++)
      expect(revoked).not.toContain(String(sentinel));
  });
  it("hides cached totals after revocation while preserving independently granted funding and custody", () => {
    expect(renderToStaticMarkup(<Treasury />)).toContain("812302");
    state.user = grants(
      "treasury.fundTreasury",
      "treasury.pendingHandoverQueue",
    );
    const html = renderToStaticMarkup(<Treasury />);
    for (let sentinel = 812301; sentinel <= 812318; sentinel++)
      expect(html).not.toContain(String(sentinel));
    expect(html).toContain("تمويل الخزينة");
    expect(html).toContain("812320");
    expect(html).not.toContain("آخر تحديث:");
    expect(html).not.toContain("النقد في الدروج");
    expect(html).not.toContain("مقبوضات اليوم");
  });
  it.each([
    "treasury.fundTreasury",
    "treasury.pendingHandoverReceipts",
    "treasury.pendingHandoverQueue",
  ])("does not unlock the dashboard tab with %s", (path) => {
    state.user = grants(path);
    renderToStaticMarkup(<TreasuryHub />);
    const dashboard = state.tabs.find((tab) => tab.value === "dashboard");
    expect(
      canSeeGate(
        dashboard.gate,
        "cashier",
        null,
        state.user.roleOperationPolicy,
      ),
    ).toBe(false);
    const custody = state.tabs.find((tab) => tab.value === "custody");
    expect(custody).toBeDefined();
    expect(
      canSeeGate(custody.gate, "cashier", null, state.user.roleOperationPolicy),
    ).toBe(true);
  });
  it("preserves deliberate dashboard access and legacy cashier access", () => {
    renderToStaticMarkup(<TreasuryHub />);
    const gate = state.tabs.find((tab) => tab.value === "dashboard").gate;
    expect(
      canSeeGate(
        gate,
        "cashier",
        null,
        grants("treasury.getDashboard").roleOperationPolicy,
      ),
    ).toBe(true);
    expect(canSeeGate(gate, "cashier", null, null)).toBe(true);
  });
  it("renders the operational custody pane without corporate totals even when other grants exist", () => {
    state.user = grants(
      ...finance,
      "treasury.fundTreasury",
      "treasury.pendingHandoverQueue",
    );
    const html = renderToStaticMarkup(<Treasury operationalOnly />);
    expect(html).toContain("العهدة والتمويل");
    expect(html).toContain("تمويل الخزينة");
    expect(html).toContain("812320");
    for (let sentinel = 812301; sentinel <= 812318; sentinel++)
      expect(html).not.toContain(String(sentinel));
    expect(html).not.toContain("سند قبض");
    expect(html).not.toContain("سند صرف");
    expect(html).not.toContain("النقد في الدروج");
    expect(html).not.toContain("مقبوضات اليوم");
    expect(html).not.toContain("مصروفات اليوم");
  });
});
