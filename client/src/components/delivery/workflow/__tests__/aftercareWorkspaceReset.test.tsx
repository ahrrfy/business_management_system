// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  search: "", locked: false, selected: vi.fn(), scans: vi.fn(),
  sourceA: { relations: { aftercareCaseId: 11 } },
  sourceB: { relations: { aftercareCaseId: 22 } },
}));
vi.mock("wouter", () => ({
  useSearch: () => state.search,
  useLocation: () => ["/delivery", vi.fn()],
}));
vi.mock("@/hooks/useOperationPermission", () => ({ useOperationPermission: () => ({ allowed: true }) }));
vi.mock("@/components/data-table/DataTable", async () => {
  const { useWorkflowResetGuard } = await import("@/components/delivery/workflow/workflowScanReset");
  return { DataTable: () => { useWorkflowResetGuard(state.locked); return <div data-testid="case-list" />; } };
});
vi.mock("@/components/search/UnifiedSearchInput", () => ({
  UnifiedSearchInput: React.forwardRef<HTMLInputElement, any>((props, ref) => <input
    ref={ref} aria-label={props["aria-label"]} value={props.value} disabled={props.disabled}
    onChange={event => props.onChange(event.target.value)}
    onKeyDown={event => { if (event.key === "Enter") props.onSubmit(props.value); }}
  />),
}));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ children, value, onValueChange }: any) => <select value={value} onChange={event => onValueChange?.(event.target.value)}>{children}</select> }));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: () => null }));
vi.mock("@/components/form/IntlPhoneInput", () => ({ IntlPhoneInput: () => null }));
vi.mock("@/components/delivery/workflow/WorkflowPrintActions", () => ({ WorkflowPrintActions: () => null }));
vi.mock("@/components/fulfillment/AftercareSettlementPanel", () => ({ AftercareSettlementPanel: () => null }));
vi.mock("@/hooks/useWorkflowDocumentPrinter", () => ({ useWorkflowDocumentPrinter: () => ({ busy: false }) }));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }));
vi.mock("@/lib/printing/brand", () => ({ preopenDocumentWindow: vi.fn() }));
vi.mock("@/lib/printing/shippingLabel", () => ({ preopenShippingLabelWindow: vi.fn() }));
vi.mock("@/lib/printing/print", () => ({ printLabel: vi.fn() }));
vi.mock("@/lib/printing/cashierLifecycleReceipts", () => ({
  printAftercarePrepareLabel: vi.fn(), printAssignmentCancelReceipt: vi.fn(),
  printDeliveryFeePaymentReceipt: vi.fn(), printInvoicePaymentReceipt: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  const mutation = { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) };
  const refetch = vi.fn();
  const aftercare = {
    list: { useQuery: () => ({ data: undefined, refetch }) },
    resolveExecution: { useQuery: () => ({ data: undefined }) },
    preview: { useQuery: () => ({ data: undefined, isFetching: false }) },
    get: { useQuery: ({ id }: { id: number }) => { state.selected(id); return { data: undefined, refetch }; } },
    create: mutation, approve: mutation, cancel: mutation, resolve: mutation,
  };
  return { trpc: { delivery: {
    workflow: { preview: { useQuery: ({ raw }: { raw: string }, options: { enabled: boolean }) => {
      state.scans(raw);
      return { data: options.enabled ? raw === "A" ? state.sourceA : raw === "B" ? state.sourceB : undefined : undefined };
    } } },
    fulfillment: { aftercare },
  } } };
});
import AftercareWorkspace from "@/components/fulfillment/AftercareWorkspace";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("aftercare lookup sources across reset locks", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.clearAllMocks(); state.search = ""; state.locked = false;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = async (scannedBarcode?: string) => {
    await act(async () => root.render(<AftercareWorkspace branchId={1} scannedBarcode={scannedBarcode} />));
  };
  it("consumes the linked create source once rather than reopening a closed form after guard unlock", async () => {
    state.search = "section=aftercare&branchId=1&invoiceId=33494";
    await render();
    expect(host.textContent).toContain("فتح حالة من المستند الأصلي");
    const toggle = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.trim() === "حالة معالجة")!;
    await act(async () => toggle.click());
    expect(host.textContent).not.toContain("فتح حالة من المستند الأصلي");
    state.locked = true; await render();
    state.locked = false; await render();
    expect(host.textContent).not.toContain("فتح حالة من المستند الأصلي");
  });
  it("lets a newer parent barcode replace the previous locally submitted barcode", async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>('[aria-label="باركود أصل المعالجة"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "A");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(state.selected).toHaveBeenLastCalledWith(11);
    await render("B");
    expect(state.scans).toHaveBeenLastCalledWith("B");
    expect(state.selected).toHaveBeenLastCalledWith(22);
  });
});
