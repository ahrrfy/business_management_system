// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DueRow, PlanRow, PlanDetail } from "./installmentTypes";
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const state = vi.hoisted(() => ({ adopt: vi.fn(), allowed: true }));
vi.mock("@/components/data-table/DataTable", () => ({ DataTable: ({ data, columns }: any) =>
  <div>{data.map((original: any) => <div key={original.id}>{columns.map((column: any) =>
    <div key={column.id}>{column.cell ? React.createElement(column.cell, { row: { original } }) : null}</div>)}</div>)}</div> }));
vi.mock("@/components/list", () => ({ RowActions: ({ contact }: any) => <span>{contact?.message}</span> }));
vi.mock("@/components/WhatsAppShare", () => ({ WhatsAppShare: () => null }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: () => null }));
vi.mock("@/hooks/useOperationPermission", () => ({ useOperationPermission: () => ({ allowed: state.allowed }) }));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => {
  const Element = ({ children }: any) => <div>{children}</div>;
  return { Dialog: ({ open, children }: any) => open ? <div>{children}</div> : null,
    DialogContent: Element, DialogHeader: Element, DialogTitle: Element,
    DialogDescription: Element, DialogFooter: Element };
});
vi.mock("@/lib/trpc", () => ({ trpc: { installments: {
  get: { useQuery: () => ({ data: { id: 1, customerId: 1, customerName: "عميل", branchId: 1,
    totalAmount: "100000", downPayment: "0", status: "ACTIVE", reconciliationRequired: true,
    invoiceNetPaidAmount: "30000", lines: [] }, refetch: vi.fn() }) },
  adoptLegacyHistory: { useMutation: () => ({ mutate: state.adopt, isPending: false }) },
  bounce: { useMutation: () => ({}) }, cancel: { useMutation: () => ({}) },
} } }));
import { DueSoonSection } from "./DueSoonSection";
import { PlansTable } from "./PlansTable";
import { PlanDetailDialog } from "./PlanDetailDialog";
import { printDueSoonReport, printPlanScheduleReport } from "./installmentReportPrint";
const due = { lineId: 1, planId: 1, seq: 1, customerId: 1, customerName: "عميل", customerPhone: "07700000000",
  dueDate: "2026-11-01", kind: "CASH", daysOverdue: 0, amount: "50000", paidAmount: "50000",
  remainingAmount: "0", reconciliationRequired: true, pendingApproval: false,
  invoiceNetPaidAmount: "30000", invoiceRemainingAmount: "70000" } as DueRow;
describe("installment disclosure", () => {
  it("list and due-soon disclose actual invoice paid/remaining separately from documented 50k", () => {
    const row = { ...due, id: 1, status: "ACTIVE", paidLines: 1, totalLines: 2,
      totalAmount: "100000", downPayment: "0", remainingAmount: "50000", createdAt: new Date() } as unknown as PlanRow;
    const list = renderToStaticMarkup(<PlansTable rows={[row]} hasMore={false} isLoading={false} isError={false}
      refetch={() => {}} onDetail={() => {}} onOpenDossier={() => {}} offset={0} limit={50} onPage={() => {}} />);
    const queue = renderToStaticMarkup(<DueSoonSection rows={[due]} days={7} isLoading={false} onDaysChange={() => {}} onPay={() => {}} />);
    for (const html of [list, queue]) {
      expect(html).toContain("30,000"); expect(html).toContain("70,000"); expect(html).toContain("50,000");
      expect(html).toContain("تحتاج مطابقة");
    }
    expect(queue).toContain("يرجى مطابقة السندات");
    expect(queue).not.toContain("القسط المستحق:");
    const print = vi.fn(() => true);
    printPlanScheduleReport({ ...row, invoiceRemainingAmount: "70000", lines: [
      { ...due, id: 1, amount: "100000", paidAmount: "50000", remainingAmount: "50000", status: "PENDING", paymentHistory: [] },
    ] } as unknown as PlanDetail, print);
    const printed = JSON.stringify(print.mock.calls);
    expect(printed).toContain("30,000"); expect(printed).toContain("70,000"); expect(printed).toContain("50,000");
  });
  it("pending receipt stays pending in print and contact without another payment request", () => {
    const pending = { ...due, reconciliationRequired: false, pendingApproval: true, paidAmount: "0", remainingAmount: "50000" };
    const html = renderToStaticMarkup(<DueSoonSection rows={[pending]} days={7} isLoading={false} onDaysChange={() => {}} onPay={() => {}} />);
    expect(html).toContain("بانتظار اعتماد السند");
    expect(html).not.toContain("يرجى تأكيد موعد السداد");
    const print = vi.fn(() => true);
    printDueSoonReport([due, pending], print);
    const document = (print.mock.calls as unknown as [[{ rows: { overdue: string }[] }]])[0][0];
    expect(document.rows[0].overdue).toContain("تحتاج مطابقة");
    expect(document.rows[1].overdue).toContain("بانتظار اعتماد السند");
  });
  it("detail exposes governed evidence adoption and dispatches actual endpoint", async () => {
    const host = document.createElement("div"); const root = createRoot(host);
    try {
      await act(async () => root.render(<PlanDetailDialog planId={1} onClose={() => {}} onPay={() => {}} onChanged={() => {}} />));
      const button = Array.from(host.querySelectorAll("button")).find(row => row.textContent?.includes("مطابقة السجل التاريخي"));
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(state.adopt).toHaveBeenCalledWith({ planId: 1 });
    } finally { await act(async () => root.unmount()); }
  });
});
