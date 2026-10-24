// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comparativeRange, PeriodFilter, presetRange } from "../PeriodFilter";
import {
  REPORT_COMPARE_LABELS,
  REPORT_PERIOD_LABELS,
} from "@shared/reportPeriod";
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ onValueChange, children, size, ...props }: any) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
}));
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
});
afterEach(() => vi.useRealTimers());
describe("report comparison boundaries", () => {
  it.each([
    ["2026-02-31", "2026-03-03"],
    ["2026-03-10", "2026-03-01"],
    ["", "2026-03-01"],
    ["2026-3-01", "2026-03-10"],
  ])("rejects invalid or reversed ranges %s to %s", (from, to) =>
    expect(comparativeRange(from, to, "prev")).toBeNull(),
  );
  it("clamps leap day to the last actual day of the prior February", () => {
    expect(comparativeRange("2024-02-01", "2024-02-29", "yoy")).toEqual({
      from: "2023-02-01",
      to: "2023-02-28",
    });
  });
  it("keeps the preceding range equal in inclusive calendar-day length", () => {
    expect(comparativeRange("2026-03-01", "2026-03-31", "prev")).toEqual({
      from: "2026-01-29",
      to: "2026-02-28",
    });
    expect(comparativeRange("2026-01-01", "2026-01-01", "prev")).toEqual({
      from: "2025-12-31",
      to: "2025-12-31",
    });
  });
  it("keeps last-month and quarter presets intact", () => {
    expect(presetRange("lastMonth", new Date(2024, 2, 15))).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(presetRange("qtd", new Date(2026, 9, 24))).toEqual({
      from: "2026-10-01",
      to: "2026-10-24",
    });
  });
  it("renders the canonical vocabulary and preserves controlled date edits", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn(),
      onCompareChange = vi.fn();
    act(() =>
      root.render(
        <PeriodFilter
          value={{ from: "2026-10-01", to: "2026-10-24", preset: "mtd" }}
          onChange={onChange}
          compare="prev"
          onCompareChange={onCompareChange}
        />,
      ),
    );
    expect(
      Array.from(
        host.querySelectorAll('select[aria-label="الفترة الجاهزة"] option'),
      ).map((node) => node.textContent),
    ).toEqual(Object.values(REPORT_PERIOD_LABELS));
    expect(
      Array.from(
        host.querySelectorAll('select[aria-label="المقارنة"] option'),
      ).map((node) => node.textContent),
    ).toEqual(Object.values(REPORT_COMPARE_LABELS));
    act(() => {
      const select = host.querySelector(
        'select[aria-label="الفترة الجاهزة"]',
      ) as HTMLSelectElement;
      select.value = "custom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({
      from: "2026-10-01",
      to: "2026-10-24",
      preset: "custom",
    });
    expect(host.querySelector('[role="group"]')?.className).toContain(
      "flex-wrap",
    );
    act(() => root.unmount());
    host.remove();
  });
});
