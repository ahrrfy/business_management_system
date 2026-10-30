// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type ExcelJS from "exceljs";
import type { RouterOutputs } from "@/lib/trpc";
import SalesReport from "../SalesReport";
import { printSalesReportV2 } from "@/lib/printing/printTemplatesV2";
import { notify } from "@/lib/notify";

type Row = RouterOutputs["reports"]["salesReport"]["rows"][number];
const mock = vi.hoisted(() => ({ role: "admin", loadingIdentity: false, rows: [] as any[], nextRows: [] as any[],
  fetch: vi.fn(), columns: [] as any[], printed: "", workbook: null as ExcelJS.Workbook | null,
  downloadCompleted: null as Promise<void> | null }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  auth: { me: { useQuery: () => ({ data: mock.loadingIdentity ? undefined : { role: mock.role } }) } },
  branches: { list: { useQuery: () => ({ data: [] }) } }, sales: { salespeople: { useQuery: () => ({ data: [] }) } },
  reports: {
    salesReport: { useQuery: () => ({ data: { rows: mock.rows, nextCursor: mock.nextRows.length ? mock.rows[0].id : null,
      totals: { count: mock.rows.length + mock.nextRows.length, total: "100000", paid: "0", unpaid: "0" } } }) },
    topProducts: { useQuery: () => ({}) }, slowMovers: { useQuery: () => ({}) }, profitByCategory: { useQuery: () => ({}) },
  },
  useUtils: () => ({ reports: { salesReport: { fetch: mock.fetch } } }),
} }));
vi.mock("@/hooks/useUrlFilters", () => ({ useUrlFilters: () => [{ from: "2026-10-01", to: "2026-10-28" }, vi.fn(), vi.fn()] }));
vi.mock("@/components/data-table/DataTable", () => ({ DataTable: ({ columns, data, toolbar }: any) => {
  mock.columns = columns;
  return <div>{toolbar}<table><thead><tr>{columns.map((c: any, i: number) => <th key={i}>{c.header}</th>)}</tr></thead>
    <tbody>{data.map((r: any) => <tr key={r.id}>{columns.map((c: any, i: number) => <td key={i}>{String(r[c.accessorKey] ?? "")}</td>)}</tr>)}</tbody></table></div>;
} }));
vi.mock("wouter", () => ({ Link: ({ children }: any) => <span>{children}</span> }));
vi.mock("@/components/reports/PeriodFilter", () => ({ DEFAULT_PERIOD: () => ({ from: "2026-10-01", to: "2026-10-28" }), PeriodFilter: () => null }));
vi.mock("@/lib/notify", () => ({ notify: { err: vi.fn() } }));
vi.mock("@/lib/printing/brand", async original => ({ ...await original<any>(), openPrintWindow: (html: string) => { mock.printed = html; return true; } }));
vi.mock("exceljs", async original => {
  const actual = await original<{ default: typeof import("exceljs") }>();
  return { default: { ...actual.default, Workbook: class extends actual.default.Workbook {
    constructor() { super(); mock.workbook = this; }
  } } };
});

const row = (id = 1): Row & { netRevenue: string; netCOGS: string; profit: string } => ({
  id, invoiceNumber: `NET-${id}`, invoiceDate: new Date("2026-10-28T08:00:00Z"), sourceType: "ORDER", sourceId: null,
  status: "RETURNED", branchId: 1, branchName: "MAIN", shiftId: null, posDeviceId: null,
  salespersonName: null, paymentMethod: null, priceTier: "RETAIL", subtotal: "100000.00", discountAmount: "0.00", taxAmount: "0.00",
  total: "100000.00", paidAmount: "0.00", returnedTotal: "100000.00", costTotal: "60000.00", customerName: "Customer",
  netRevenue: "0.00", netCOGS: "0.00", profit: "0.00",
});
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mock.role = "admin"; mock.loadingIdentity = false; mock.rows = [row()]; mock.nextRows = [];
  mock.workbook = null; mock.printed = "";
  mock.fetch.mockImplementation(async () => ({ rows: [...mock.rows, ...mock.nextRows], nextCursor: null }));
  vi.stubGlobal("React", React);
  URL.createObjectURL = vi.fn(() => "blob:report");
  mock.downloadCompleted = new Promise<void>((resolve, reject) => {
    URL.revokeObjectURL = vi.fn(() => resolve());
    vi.mocked(notify.err).mockImplementation(error => { reject(error); return ""; });
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(<SalesReport />)); }
async function click(text: string) { const b = Array.from(container.querySelectorAll("button")).find(b => b.textContent === text)!; expect(b).toBeTruthy(); await act(async () => b.click()); }
async function exportExcel() {
  // exportRows returns void; await the download after real XLSX serialization, bounded by the test timeout.
  // Subscribe before React finishes flushing the click so export errors reject with their original cause.
  await Promise.all([click("تصدير Excel"), mock.downloadCompleted]);
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:report");
}
function workbookColumn(header: string) {
  const sheet = mock.workbook!.worksheets[0]!;
  const col = (sheet.getRow(1).values as unknown[]).findIndex(value => value === header);
  expect(col, header).toBeGreaterThan(0);
  return sheet.getCell(2, col).value;
}
function printedCell(header: string) {
  const doc = new DOMParser().parseFromString(mock.printed, "text/html");
  const table = Array.from(doc.querySelectorAll("table")).find(t => Array.from(t.querySelectorAll("th")).some(th => th.textContent === header))!;
  expect(table).toBeTruthy();
  const col = Array.from(table.querySelectorAll("th")).findIndex(th => th.textContent === header);
  return table.querySelectorAll("tbody tr")[0]!.querySelectorAll("td")[col]!.textContent;
}

it("reserves readable financial widths inside A4 and links every invoice to its wrapped metadata", async () => {
  mock.rows = [{ ...row(), netCOGS: "60000.00", profit: "-60000.00",
    salespersonName: "البائع المسؤول", shiftId: 12345, paymentMethod: "CASH" }];
  await render(); await click("طباعة / PDF");
  const doc = new DOMParser().parseFromString(mock.printed, "text/html");
  const headers = Array.from(doc.querySelectorAll<HTMLTableCellElement>("th"));
  expect(headers.reduce((sum, th) => sum + Number.parseInt(th.style.width || "0"), 0)).toBeLessThanOrEqual(1035);
  expect(headers).toHaveLength(10);
  headers.slice(2).forEach(th => expect(Number.parseInt(th.style.width)).toBeGreaterThanOrEqual(110));
  const profitCol = headers.findIndex(th => th.textContent === "الربح");
  const profit = doc.querySelector("tbody tr")!.querySelectorAll<HTMLTableCellElement>("td")[profitCol]!;
  expect(profit.style.direction).toBe("ltr"); expect(profit.textContent).toBe("-60,000");
  const detail = doc.querySelector("tbody tr")!.nextElementSibling!.querySelector("td")!;
  expect(detail.colSpan).toBe(headers.length);
  for (const text of ["التاريخ", "العميل", "الفرع", "الكاشير / البائع", "الوردية", "الدفع", "الحالة",
    "Customer", "MAIN", "البائع المسؤول", "12345", "نقدي"]) expect(detail.textContent).toContain(text);
  expect(detail.querySelector<HTMLElement>("[data-sales-metadata]")!.style.flexWrap).toBe("wrap");
});

it.each([true, false])("preserves maximum signed cents and metadata with sensitive columns=%s", sensitive => {
  printSalesReportV2({ periodLabel: "October", invoiceCount: 1, totalSum: "0", paidSum: "0", unpaidSum: "0",
    rows: [{ invoiceNumber: "INV-EXACT", date: "28/10/2026", customerName: "عميل <script> حرفي",
      branchName: "MAIN", salespersonName: "البائع", shiftId: 7, paymentMethod: "CASH", status: "جزئية",
      total: "9999999999999.99", paid: "0", remaining: "9999999999999.99", netRevenue: "9999999999999.99",
      ...(sensitive ? { cost: "9999999999999.99", netCOGS: "9999999999999.99", profit: "-9999999999999.99" } : {}),
    }] });
  const doc = new DOMParser().parseFromString(mock.printed, "text/html");
  expect(printedCell("صافي الإيراد")).toBe("9,999,999,999,999.99");
  if (sensitive) expect(printedCell("الربح")).toBe("-9,999,999,999,999.99");
  else { expect(mock.printed).not.toContain("تكلفة"); expect(mock.printed).not.toContain("الربح"); }
  const financial = doc.querySelector("[data-sales-financial]")!;
  const detail = financial.nextElementSibling!.querySelector("td")!;
  expect(detail.colSpan).toBe(financial.children.length);
  expect(detail.textContent).toContain("عميل <script> حرفي");
  expect(detail.querySelector("script")).toBeNull();
  expect(detail.textContent).toContain("جزئية");
});

it("actual table uses server net revenue, cost and profit", async () => {
  await render();
  expect(mock.columns.map(c => c.accessorKey)).toEqual(expect.arrayContaining(["netRevenue", "netCOGS", "profit"]));
});

it("actual print handler and template display the server net cost and profit", async () => {
  await render();
  await click("طباعة / PDF");
  expect(mock.printed).toContain("صافي تكلفة المبيعات"); expect(mock.printed).toContain("الربح");
  expect(printedCell("صافي تكلفة المبيعات")).toBe("0"); expect(printedCell("الربح")).toBe("0");
});

it("table, print and actual workbook preserve the same server cents", async () => {
  mock.rows = [{ ...row(), netRevenue: "2.00", netCOGS: "0.67", profit: "1.33" }];
  await render();
  expect(container.querySelector("tbody")!.textContent).toContain("0.67");
  await click("طباعة / PDF");
  expect(printedCell("صافي تكلفة المبيعات")).toBe("0.67"); expect(printedCell("الربح")).toBe("1.33");
  await exportExcel();
  expect(workbookColumn("صافي تكلفة المبيعات")).toBe(0.67); expect(workbookColumn("الربح")).toBe(1.33);
  const sheet = mock.workbook!.worksheets[0]!;
  const col = (sheet.getRow(1).values as unknown[]).findIndex(value => value === "الربح");
  expect(sheet.getCell(2, col).numFmt).toBe("#,##0.00");
});

it("actual Excel handler writes canonical server profit instead of original-cost arithmetic", async () => {
  await render();
  await exportExcel();
  expect(workbookColumn("الربح")).toBe(0);
  expect(workbookColumn("صافي الإيراد")).toBe(0);
  expect(workbookColumn("صافي تكلفة المبيعات")).toBe(0);
});

it.each(["auditor", "loading"])("hides all cost/profit table, print and Excel fields for %s", async identity => {
  mock.role = "auditor"; mock.loadingIdentity = identity === "loading";
  await render();
  expect(mock.columns.map(c => c.accessorKey)).not.toEqual(expect.arrayContaining(["costTotal"]));
  expect(mock.columns.some(c => ["costTotal", "netCOGS", "profit"].includes(c.accessorKey))).toBe(false);
  await click("طباعة / PDF"); expect(mock.printed).not.toContain("تكلفة"); expect(mock.printed).not.toContain("الربح");
  await exportExcel();
  expect(mock.workbook!.worksheets[0]!.getRow(1).values).not.toEqual(expect.arrayContaining(["صافي تكلفة المبيعات", "الربح"]));
});

it("full export retains each later page's canonical server loss", async () => {
  mock.nextRows = [{ ...row(2), netCOGS: "60000.00", profit: "-60000.00" }];
  await render(); await exportExcel();
  expect(mock.fetch).toHaveBeenCalledWith(expect.objectContaining({ limit: 5000, from: "2026-10-01" }));
  const sheet = mock.workbook!.worksheets[0]!;
  const col = (sheet.getRow(1).values as unknown[]).findIndex(value => value === "الربح");
  expect(sheet.getCell(3, col).value).toBe(-60000);
});
