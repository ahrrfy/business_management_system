import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { printStocktakeReport, type StocktakeReportPrintData } from "../stocktakeTemplates";
import { openPrintWindow } from "../brand";
import { stocktakePrintState } from "../stocktakePrintState";
import StocktakeReport from "@/pages/StocktakeReport";

const page = vi.hoisted(() => ({
  status: "REVIEW", sessionType: "NORMAL" as "NORMAL" | "OPENING", actions: undefined as ReactNode,
}));
vi.mock("@/lib/trpc", () => ({ trpc: {
  auth: { me: { useQuery: () => ({ data: { role: "admin" } }) } },
  stocktakes: { report: { useQuery: () => ({ data: {
    session: { id: 31, code: "ST-31", name: "جرد المراجعة", status: page.status, sessionType: page.sessionType },
    assignments: [{ name: "أحمد" }],
    rows: [{ variantId: 1, productName: "دفتر", rawCount: 1, adjustedCount: 1, bookNow: 2, diff: -1, value: "-10.00",
      decision: { action: "ADJUST", reason: "DAMAGE", autoApplied: true } }],
    ledger: { shortExpense: "10.00", overGain: "0.00" },
  } }) } },
} }));
vi.mock("wouter", () => ({ useParams: () => ({ id: "31" }), Link: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ actions }: { actions: ReactNode }) => { page.actions = actions; return null; } }));
vi.mock("@/components/data-table/DataTable", () => ({ DataTable: () => null }));
vi.mock("@/components/WhatsAppShare", () => ({ WhatsAppShare: () => null }));
vi.mock("@/lib/export", () => ({ exportRows: vi.fn() }));
Object.assign(globalThis, { React });

function printAction(node: ReactNode): (() => void) | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) continue;
    if (child.props.onClick && React.Children.toArray(child.props.children).some((text) => typeof text === "string" && text.includes("طباعة المحضر"))) return child.props.onClick;
    const nested = printAction(child.props.children);
    if (nested) return nested;
  }
}

vi.mock("../brand", async (original) => ({
  ...await original<typeof import("../brand")>(), openPrintWindow: vi.fn(() => true),
}));

const report = (status: string, sessionType: "NORMAL" | "OPENING"): StocktakeReportPrintData => ({
  status, sessionType, code: "ST-31", name: "جرد المراجعة", branchName: "الرئيسي", scopeLabel: "شامل",
  blind: true, thresholdPct: "5", thresholdValue: "1000", workerNames: ["أحمد"],
  stats: { counted: 1, matched: 0, over: 0, short: 1, netValue: "-10.00" },
  adjusted: [{ productName: "دفتر", bookQty: 2, adjustedQty: 1, diff: -1, value: "-10.00", reasonLabel: "تلف", decisionLabel: "تسوية تلقائية ضمن الحدّ" }],
  adjustedNetQty: -1, adjustedNetValue: "-10.00", kept: [], matchedNames: [], byReason: [],
  ledger: { shortExpense: "10.00", overGain: "0.00" }, ira: { pct: "0", matched: 0, counted: 1 },
});

describe("stocktake print posting truthfulness", () => {
  beforeEach(() => vi.mocked(openPrintWindow).mockClear());

  it.each(["NORMAL", "OPENING"] as const)("marks %s previews as unposted for every unapproved status", (sessionType) => {
    for (const status of ["COUNTING", "REVIEW", "CANCELLED"]) {
      printStocktakeReport(report(status, sessionType));
      const html = vi.mocked(openPrintWindow).mock.lastCall?.[0] ?? "";
      expect(html).toContain(status === "CANCELLED" ? "الجلسة ملغاة" : "مسوّدة معاينة قبل الاعتماد النهائي");
      expect(html).not.toContain("نُفّذت التسوية");
      expect(html).not.toContain("ثُبتت الكميات");
      expect(html).not.toContain("ثُبتت الأرصدة الافتتاحية");
      expect(html).toContain("−10");
    }
  });

  it.each(["NORMAL", "OPENING"] as const)("retains approved %s execution and the original financial rows", (sessionType) => {
    printStocktakeReport(report("APPROVED", sessionType));
    const html = vi.mocked(openPrintWindow).mock.lastCall?.[0] ?? "";
    expect(html).toContain(sessionType === "OPENING" ? "ثُبتت الأرصدة الافتتاحية" : "نُفّذت التسوية");
    expect(html).not.toContain("مسوّدة معاينة");
    expect(html).toContain("دفتر");
    expect(html).toContain("أحمد");
  });

  it("fails closed for an unfamiliar status and escapes document text at the template boundary", () => {
    const input = { ...report("UNKNOWN", "NORMAL"), code: "<script>bad()</script>" };
    expect(stocktakePrintState(input).approved).toBe(false);
    printStocktakeReport(input);
    const html = vi.mocked(openPrintWindow).mock.lastCall?.[0] ?? "";
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain("&lt;script&gt;bad()");
  });

  it.each(["NORMAL", "OPENING"] as const)("wires %s page status and section wording through the real print action", (sessionType) => {
    page.sessionType = sessionType;
    for (const status of ["COUNTING", "REVIEW", "APPROVED"]) {
      page.status = status;
      page.actions = undefined;
      const expected = stocktakePrintState({ status, sessionType, code: "ST-31" });
      const screen = renderToStaticMarkup(React.createElement(StocktakeReport));
      expect(screen).toContain(expected.adjustedTitle);
      const onPrint = printAction(page.actions);
      expect(onPrint).toBeDefined();
      onPrint?.();
      const printed = vi.mocked(openPrintWindow).mock.lastCall?.[0] ?? "";
      expect(printed).toContain(expected.adjustedTitle);
      expect(printed).toContain("دفتر");
      if (expected.approved) expect(printed).not.toContain("مسوّدة معاينة");
      else expect(printed).toContain("مسوّدة معاينة قبل الاعتماد النهائي");
    }
  });
});
