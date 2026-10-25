// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTabs, type HubTab } from "./PageTabs";

const state = vi.hoisted(() => ({ search: "", role: "manager", navigate: vi.fn() }));
vi.mock("wouter", () => ({ useLocation: () => ["/delivery", state.navigate], useSearch: () => state.search }));
vi.mock("@/lib/trpc", () => ({ trpc: { auth: { me: { useQuery: () => ({ data: { role: state.role, permissionsOverride: null } }) } } } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tabs: HubTab[] = [
  { value: "workflow", label: "سير العمل", Component: () => <div data-testid="workflow">Workflow</div> },
  { value: "dispatch", label: "إدارة التوصيل", gate: { roles: ["manager"] }, Component: () => <div data-testid="dispatch">{state.search}</div> },
];
const aliases = { settle: "dispatch", transit: "dispatch", board: "dispatch" };

describe("PageTabs nested deep-link compatibility", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    state.search = ""; state.role = "manager"; state.navigate.mockClear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const render = (tabAliases?: Record<string, string>) => act(() => root.render(<PageTabs tabs={tabs} tabAliases={tabAliases} />));
  const active = () => host.querySelector('[role="tab"][data-state="active"]')?.textContent;

  it("keeps canonical tab selection unchanged without aliases", () => {
    state.search = "tab=dispatch&party=1"; render();
    expect(active()).toBe("إدارة التوصيل");
    expect(host.querySelector('[data-testid="dispatch"]')?.textContent).toBe("tab=dispatch&party=1");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it.each(["settle", "transit", "board"])("opens the parent for %s while preserving the nested query", (alias) => {
    state.search = `tab=${alias}&party=1&from=2026-10-01`; render(aliases);
    expect(active()).toBe("إدارة التوصيل");
    expect(host.querySelector('[data-testid="dispatch"]')?.textContent).toBe(state.search);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });
  it("falls back safely for unknown or unconfigured nested values", () => {
    state.search = "tab=unknown&party=1"; render(aliases); expect(active()).toBe("سير العمل");
    state.search = "tab=settle&party=1"; render(); expect(active()).toBe("سير العمل");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("cannot reveal a parent tab denied by the role gate", () => {
    state.role = "cashier"; state.search = "tab=settle&party=1"; render(aliases);
    expect(active()).toBe("سير العمل");
    expect(host.querySelector('[data-testid="dispatch"]')).toBeNull();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("preserves direct tab precedence over an alias collision", () => {
    state.search = "tab=workflow"; render({ workflow: "dispatch" }); expect(active()).toBe("سير العمل");
  });
  it("wires the legacy DeliveryHub and administrative deep links to the three daily entries", () => {
    const source = readFileSync("client/src/pages/DeliveryCenter.tsx", "utf8");
    for (const alias of ["dispatch", "transit", "board"])
      expect(source).toMatch(new RegExp(`${alias}:\\s*"followup"`));
    expect(source).toMatch(/settle:\s*"settlement"/);
    for (const alias of ["parties", "pricing", "performance", "aging"])
      expect(source).toMatch(new RegExp(`${alias}:\\s*"more"`));
  });
});
