// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ records: {} as Record<number, any>, fetch: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ sales: { get: { fetch: state.fetch } } }),
  auth: { me: { useQuery: () => ({ data: { role: "cashier" } }) } },
  sales: { get: { useQuery: (input: { invoiceId: number }) => ({ data: state.records[input.invoiceId], refetch: vi.fn() }) } },
} }));
vi.mock("@/components/ui/sheet", () => ({ Sheet: ({ children }: any) => <div>{children}</div>, SheetContent: ({ children }: any) => <div>{children}</div>, SheetHeader: ({ children }: any) => <div>{children}</div>, SheetTitle: ({ children }: any) => <h2>{children}</h2> }));
vi.mock("./QuickSalesPaymentDialog", () => ({ QuickSalesPaymentDialog: () => null }));
vi.mock("@/components/data-table/DataTable", () => ({ DataTable: () => null }));
import { InvoiceDetailDrawer } from "./InvoiceDetailDrawer";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("historical invoice drawer", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    const common = { branchId: 2, paidAmount: "0", returnedTotal: "0", items: [], payments: [], returns: [] };
    state.records = {
      1: { ...common, id: 1, invoiceNumber: "INV-OLD", status: "SUPERSEDED", total: "1000", correctedByInvoiceId: 2 },
      2: { ...common, id: 2, invoiceNumber: "INV-MIDDLE", status: "SUPERSEDED", total: "1500", correctedByInvoiceId: 3 },
      3: { ...common, id: 3, invoiceNumber: "INV-CURRENT", status: "PENDING", total: "2000", correctedByInvoiceId: null },
    };
    state.fetch.mockReset().mockImplementation(async ({ invoiceId }) => state.records[invoiceId]);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  it("labels historical amounts and opens the latest invoice through the correction chain in one action", async () => {
    act(() => root.render(<InvoiceDetailDrawer invoiceId={1} onClose={vi.fn()} />));
    expect(host.textContent).toContain("نسخة تاريخية");
    const open = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("فتح الفاتورة الحالية"));
    expect(open).toBeDefined();
    await act(async () => open!.click());
    expect(state.fetch).toHaveBeenCalledWith({ invoiceId: 2 });
    expect(state.fetch).toHaveBeenCalledWith({ invoiceId: 3 });
    expect(host.textContent).toContain("INV-CURRENT");
    expect(host.textContent).not.toContain("INV-OLD");
  });
});
