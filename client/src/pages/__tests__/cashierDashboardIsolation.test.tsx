// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: {} as Record<string, unknown>, queries: [] as string[] }));
vi.mock("@/lib/trpc", () => {
  const node = (path: string[]): unknown => new Proxy({}, {
    get: (_, key) => key === "useQuery"
      ? () => {
          const name = path.join(".");
          state.queries.push(name);
          return { data: name === "auth.me" ? state.user : undefined, isLoading: false, isError: false, refetch: vi.fn() };
        }
      : node([...path, String(key)]),
  });
  return { trpc: node([]) };
});
vi.mock("@/hooks/useMobile", () => ({ useMediaQuery: () => false }));
vi.mock("framer-motion", () => ({ motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> } }));
vi.mock("@/components/dashboard/CashierHome", () => ({
  CashierHome: ({ station }: { station: string }) => <section aria-label="محطة الكاشير">{station}</section>,
}));
vi.mock("@/components/dashboard/SystemModulesGrid", () => ({ SystemModulesGrid: () => <div>وحدات الإدارة العامة</div> }));
import Dashboard from "../Dashboard";

let root: Root;
let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); });
beforeEach(() => {
  vi.stubGlobal("React", React);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  state.queries.length = 0;
  state.user = { id: 11, name: "موظف الاستقبال", role: "cashier", branchId: 1, isOwner: false };
});
describe("cashier dashboard separation", () => {
  it.each([false, true])("keeps reception station home with canonical policy %s", (canonical) => {
    Object.assign(state.user, {
      operationPolicyEnabled: canonical,
      permissionsOverride: { workorders: "FULL", pos: "NONE", sales: "READ", treasury: "READ", reports: "READ" },
      resolvedOperationPolicy: { version: 1, grants: { "operation.workOrders.receptionCheckout": true, "operation.shifts.current": true } },
    });
    act(() => root.render(<Dashboard />));
    expect(container.querySelector('[aria-label="محطة الكاشير"]')?.textContent).toBe("RECEPTION");
    expect(container.textContent).not.toContain("وحدات الإدارة العامة");
    expect(state.queries).not.toContain("reports.dashboardMetrics");
    expect(state.queries).not.toContain("reports.morningBrief");
  });
  it("preserves the intact retail station", () => {
    Object.assign(state.user, { operationPolicyEnabled: false, permissionsOverride: { sales: "FULL", workorders: "NONE", pos: "NONE" } });
    act(() => root.render(<Dashboard />));
    expect(container.querySelector('[aria-label="محطة الكاشير"]')?.textContent).toBe("RETAIL");
    expect(state.queries).not.toContain("reports.dashboardMetrics");
  });
  it("a cashier without a delegated station never falls into the company dashboard", () => {
    Object.assign(state.user, { operationPolicyEnabled: true, permissionsOverride: { sales: "NONE", pos: "NONE", workorders: "NONE" }, resolvedOperationPolicy: { version: 1, grants: {} } });
    act(() => root.render(<Dashboard />));
    expect(container.textContent).not.toContain("وحدات الإدارة العامة");
    expect(state.queries).not.toContain("reports.dashboardMetrics");
  });
  it("an unrelated sales mutation cannot create a retail station", () => {
    Object.assign(state.user, { operationPolicyEnabled: true, permissionsOverride: { sales: "FULL", pos: "NONE", workorders: "NONE" }, resolvedOperationPolicy: { version: 1, grants: { "operation.sales.correct": true } } });
    act(() => root.render(<Dashboard />));
    expect(container.querySelector('[aria-label="محطة الكاشير"]')).toBeNull();
    expect(container.textContent).toContain("لم تُحدّد محطة عمل مفوّضة");
    expect(state.queries).not.toContain("reports.dashboardMetrics");
  });
});
