// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BalanceSheet from "./BalanceSheet";

const mocks = vi.hoisted(() => ({
  report: {} as Record<string, unknown>,
  exported: vi.fn(),
  printed: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    branches: {
      list: { useQuery: () => ({ data: [{ id: 1, name: "الفرع الرئيسي" }] }) },
    },
    reports: {
      financialPosition: {
        useQuery: () => ({
          data: mocks.report,
          isLoading: false,
          isError: false,
        }),
      },
    },
  },
}));
vi.mock("@/components/reports/ReportShell", () => ({
  ReportShell: ({ onExport, onPrint, filters, children }: any) => (
    <div>
      <button onClick={onExport}>Excel</button>
      <button onClick={onPrint}>Print</button>
      {filters}
      {children}
    </div>
  ),
}));
vi.mock("@/components/data-table/DataTable", () => ({
  DataTable: ({ data, columns }: any) => (
    <table>
      <tbody>
        {data.map((row: any) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td>{row.v}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          {columns.map((column: any) => (
            <td key={column.id}>{column.footer?.()}</td>
          ))}
        </tr>
      </tfoot>
    </table>
  ),
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ children, onValueChange, ...props }: any) => (
    <select {...props} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
}));
vi.mock("wouter", () => ({
  Link: ({ children, href }: any) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/export", () => ({ exportRows: mocks.exported }));
vi.mock("@/lib/printing/reportDoc", () => ({ printReportDoc: mocks.printed }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  mocks.report = new Proxy(
    {
      cash: "-100.00",
      inventory: "1000.00",
      totalAssets: "900.00",
      totalLiabilities: "0.00",
      equity: "900.00",
      accountingMode: "OFF",
      asOf: "2026-09-30",
      historicalNote: null,
      interbranchNote: null,
      inventoryValuation: {
        source: "SNAPSHOT",
        cutoffDate: "2026-09-30",
        value: "1000.00",
        branchId: null,
        capturedAt: "2026-10-01T00:00:00.000Z",
      },
    } as Record<string, unknown>,
    {
      get: (target, key) =>
        typeof key === "string" && Object.hasOwn(target, key) ? target[key] : "0.00",
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const page = readFileSync(
  resolve(process.cwd(), "client/src/pages/BalanceSheet.tsx"),
  "utf8",
);

describe("Balance sheet payroll liabilities", () => {
  it("يفصح عن الالتزامات الأربعة من عقد التقرير", () => {
    expect(page).toContain("p.accruedSalaryLiability");
    expect(page).toContain("p.payrollTaxPayable");
    expect(page).toContain("p.socialSecurityPayable");
    expect(page).toContain("p.eosProvision");
  });

  it("لا يخفي رصيداً عكسياً بل يبقي إشارته ظاهرة للتدقيق", () => {
    expect(page).toContain("!D(r.v).isZero()");
  });

  it("shows interbranch due-from and due-to balances in UI, print, and export rows", () => {
    expect(page).toContain("p.dueFromBranches");
    expect(page).toContain("p.dueToBranches");
    expect(page).toContain("p?.interbranchNote");
    expect(page).toContain("toExcelMoney(r.amount)");
    expect(page).not.toContain("Number(r.amount)");
  });

  it("يعرض سلف الموظفين أصلاً ويُدخلها في صفوف الطباعة والتصدير", () => {
    expect(page).toContain("p.employeeAdvanceReceivable");
    expect(page).toContain("سلف مستحقة على الموظفين");
  });
});

describe("Balance sheet review and export", () => {
  it("shows a negative asset so the details reconcile with the displayed total", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<BalanceSheet />));
    const rows = Array.from(host.querySelectorAll("tbody tr"));
    const negativeCash = rows.find((row) =>
      row.textContent?.includes("النقد المقبوض فعلياً"),
    );
    expect(negativeCash?.lastElementChild?.textContent).toBe("-100.00");
    expect(
      rows.reduce(
        (sum, row) => sum + Number(row.lastElementChild?.textContent),
        0,
      ),
    ).toBe(900);
    expect(host.querySelector("tfoot")?.textContent).toContain("900");
    act(() => root.unmount());
  });

  it("exports numeric signed amounts together with scope, valuation provenance and disclosures", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<BalanceSheet />));
    act(() => {
      const select = host.querySelector("select")!;
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    const [rows, spec] = mocks.exported.mock.calls[0];
    const amountColumn = spec.columns.find(
      (column: any) => column.key === "amount",
    );
    const cash = rows.find((row: any) =>
      row.label.includes("النقد المقبوض فعلياً"),
    );
    expect(amountColumn.map(cash)).toBe(-100);
    expect(spec.meta).toEqual(
      expect.arrayContaining([
        { label: "كما في", value: "2026-09-30" },
        { label: "الفرع", value: "الفرع الرئيسي" },
        { label: "مصدر تقييم المخزون", value: "لقطة رسمية بتاريخ 2026-09-30" },
        { label: "وقت التقاط المخزون", value: "2026-10-01T00:00:00.000Z" },
      ]),
    );
    expect(
      spec.meta.find((row: any) => row.label === "ملاحظات التقرير").value,
    ).toContain("مصدر تقييم المخزون");
    expect(spec.filename).toContain("2026-09-30-1");
    act(() => root.unmount());
  });
});
