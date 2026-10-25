// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MyPerformanceCard } from "../MyPerformanceCard";
const state = vi.hoisted(() => ({ query: {} as any, retry: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    commissions: { performance: { myStatus: { useQuery: () => state.query } } },
  },
}));
let container: HTMLDivElement, root: Root;
const data = () => ({
  period: "2026-10",
  effectiveBase: "150000",
  carryIn: "0",
  consignDeduction: "0",
  target: "100000",
  achievementPct: "150",
  settled: null,
  projectedCommission: "1500",
  planName: "خطة المبيعات",
  history: [
    {
      period: "2026-09",
      effectiveBase: "9999999999999.99",
      commissionAmount: "9999999999999.99",
      status: "approved",
    },
  ],
});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  state.retry.mockReset();
  state.query = {
    data: data(),
    isLoading: false,
    isError: false,
    refetch: state.retry,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render() {
  act(() => root.render(<MyPerformanceCard />));
}
it("distinguishes loading from an employee with no performance plan", () => {
  state.query = { ...state.query, data: undefined, isLoading: true };
  render();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "تحميل",
  );
  state.query = { ...state.query, data: null, isLoading: false };
  render();
  expect(container.textContent).toBe("");
});
it("shows a retry when loading performance fails", () => {
  state.query = { ...state.query, data: undefined, isError: true };
  render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "تعذر",
  );
  act(() => container.querySelector("button")!.click());
  expect(state.retry).toHaveBeenCalledOnce();
});
it("marks cached numbers when refreshing fails", () => {
  state.query = { ...state.query, isError: true };
  render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "محفوظة",
  );
  expect(container.textContent).toContain("150,000");
});
it("clamps the progress track and aria value while displaying the real achievement", () => {
  render();
  const progress = container.querySelector('[role="progressbar"]')!;
  expect(progress.getAttribute("aria-valuenow")).toBe("100");
  expect(progress.getAttribute("aria-valuetext")).toBe("150.0%");
  expect(container.textContent).toContain("150.0%");
});
it("retains commission history amounts and canonical status labels", () => {
  render();
  expect(container.textContent).toContain("معتمدة");
  expect(container.textContent).toContain("2026-09");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
});
