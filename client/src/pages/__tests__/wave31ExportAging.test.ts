// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  actions: undefined as ReactNode,
  tableRows: [] as unknown[],
  exportRows: vi.fn(),
  printAR: vi.fn(),
  printAP: vi.fn(),
  filters: { branch: "7", q: "سارة", bucket: "d31_60", ctype: "شركة" },
  rows: [
    {
      customerId: 1,
      supplierId: 1,
      customerName: "سارة",
      supplierName: "سارة",
      customerType: "شركة",
      phone: "07700000001",
      d0_30: "0.00",
      d31_60: "0.10",
      d61_90: "0.00",
      d91p: "0.00",
      unpaidTotal: "0.10",
      currentBalance: "0.30",
      unbucketed: "0.20",
      oldestInvoiceDate: "2026-10-01",
      oldestPoDate: "2026-10-01",
    },
    {
      customerId: 2,
      supplierId: 2,
      customerName: "اسم مخفي",
      supplierName: "اسم مخفي",
      customerType: "فرد",
      phone: "07700000002",
      d0_30: "20.00",
      d31_60: "0.00",
      d61_90: "0.00",
      d91p: "0.00",
      unpaidTotal: "20.00",
      currentBalance: "40.00",
      unbucketed: "20.00",
      oldestInvoiceDate: "2026-10-01",
      oldestPoDate: "2026-10-01",
    },
  ],
}));
vi.mock("@/lib/export", () => ({ exportRows: harness.exportRows }));
vi.mock("@/lib/printing/printTemplates", () => ({
  printARAging: harness.printAR,
  printAPAging: harness.printAP,
}));
vi.mock("@/hooks/useUrlFilters", () => ({
  useUrlFilters: () => [harness.filters, vi.fn(), vi.fn()],
}));
vi.mock("@/components/PageHeader", () => ({
  PageHeader: ({ actions }: { actions: ReactNode }) => {
    harness.actions = actions;
    return null;
  },
}));
vi.mock("@/components/data-table/DataTable", () => ({
  DataTable: ({ data }: { data: unknown[] }) => {
    harness.tableRows = data;
    return null;
  },
}));
vi.mock("@/components/crm/CustomerDossierDrawer", () => ({
  CustomerDossierDrawer: () => null,
}));
vi.mock("@/components/list/SelectionBar", () => ({
  useRowSelection: () => ({
    clear: vi.fn(),
    isSelected: () => false,
    count: 0,
  }),
  SelectionBar: () => null,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: { me: { useQuery: () => ({ data: { role: "admin" } }) } },
    branches: {
      list: { useQuery: () => ({ data: [{ id: 7, name: "فرع الاختبار" }] }) },
    },
    reports: {
      arAging: { useQuery: () => ({ data: harness.rows }) },
      apAging: { useQuery: () => ({ data: harness.rows }) },
    },
    customers: { autoSettleAll: { useMutation: () => ({ mutate: vi.fn() }) } },
    useUtils: () => ({ reports: { arAging: { invalidate: vi.fn() } } }),
  },
}));

import ARAging from "../ARAging";
import APAging from "../APAging";
import { buildAgingOutput } from "@/lib/agingOutput";
Object.assign(globalThis, { React });

function buttonByText(
  node: ReactNode,
  text: string,
): React.ReactElement<{ onClick: () => void; disabled?: boolean }> | undefined {
  for (const child of React.Children.toArray(node)) {
    if (
      !React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(
        child,
      )
    )
      continue;
    if (child.props.children === text && child.props.onClick)
      return child as React.ReactElement<{ onClick: () => void }>;
    const nested = buttonByText(child.props.children, text);
    if (nested) return nested;
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.actions = undefined;
  Object.assign(harness.filters, {
    branch: "7",
    q: "سارة",
    bucket: "d31_60",
    ctype: "شركة",
  });
});

describe.each([
  {
    name: "AR",
    Page: ARAging,
    print: harness.printAR,
    formats: ["تصدير Excel", "تصدير CSV"],
  },
  {
    name: "AP",
    Page: APAging,
    print: harness.printAP,
    formats: ["تصدير Excel"],
  },
])("$name aging output scope", ({ Page, print, formats }) => {
  it("exports exactly the filtered table rows and prints matching totals with filter metadata", () => {
    renderToStaticMarkup(React.createElement(Page));
    expect(harness.tableRows).toEqual([harness.rows[0]]);
    for (const label of formats) {
      const button = buttonByText(harness.actions, label);
      expect(button, label).toBeDefined();
      button?.props.onClick();
      const [rows, options] = harness.exportRows.mock.calls.at(-1)!;
      expect(rows).toEqual([harness.rows[0]]);
      expect(options.totalsRow).toEqual(
        expect.objectContaining({
          unpaidTotal: 0.1,
          currentBalance: 0.3,
          unbilled: 0.2,
        }),
      );
      expect(options.csvReport).toBe(true);
      expect(options.meta).toEqual(
        expect.arrayContaining([
          { label: "الفرع", value: "فرع الاختبار" },
          { label: "البحث", value: "سارة" },
          { label: "الشريحة", value: "31–60 يوم" },
        ]),
      );
    }
    const button = buttonByText(harness.actions, "طباعة PDF");
    expect(button).toBeDefined();
    button?.props.onClick();
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            name: "سارة",
            unpaidTotal: 0.1,
            currentBalance: 0.3,
            unbucketed: 0.2,
          }),
        ],
        totals: expect.objectContaining({
          unpaidTotal: 0.1,
          currentBalance: 0.3,
          unbucketed: 0.2,
        }),
        filters: expect.stringContaining("سارة"),
      }),
    );
  });
  it("disables ordinary export and print when the current filters hide all rows", () => {
    harness.filters.q = "بحث بلا نتائج";
    renderToStaticMarkup(React.createElement(Page));
    expect(harness.tableRows).toEqual([]);
    for (const label of [...formats, "طباعة PDF"]) {
      expect(buttonByText(harness.actions, label)?.props.disabled).toBe(true);
    }
  });
});

it("sums the selected output scope with Decimal rather than accumulating binary rounding", () => {
  const result = buildAgingOutput(
    [
      harness.rows[0],
      {
        ...harness.rows[0],
        unpaidTotal: "0.20",
        currentBalance: "0.30",
        unbucketed: "0.10",
      },
    ],
    { kind: "AR", branchName: "فرع الاختبار", query: "", bucket: "" },
  );
  expect(result.print.totals).toEqual(
    expect.objectContaining({
      unpaidTotal: 0.3,
      currentBalance: 0.6,
      unbucketed: 0.3,
    }),
  );
  expect(result.sheet.totalsRow).toEqual(
    expect.objectContaining({
      unpaidTotal: 0.3,
      currentBalance: 0.6,
      unbilled: 0.3,
    }),
  );
});
