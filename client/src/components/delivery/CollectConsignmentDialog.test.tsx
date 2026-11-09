// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rows: [] as any[], timeline: undefined as any, fetching: false, hasNextPage: false, remit: vi.fn(), next: vi.fn(), staff: vi.fn(), invalidate: vi.fn(), print: vi.fn(), close: vi.fn(), completed: vi.fn() }));
vi.mock("@/lib/lifecycleActionPermission", () => ({ lifecycleActionAllowed: () => true }));
vi.mock("./printRemittanceReceipt", () => ({ printRemittanceReceipt: state.print }));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ delivery: { invalidate: state.invalidate }, shifts: { invalidate: state.invalidate }, treasury: { invalidate: state.invalidate }, sales: { invalidate: state.invalidate }, workOrders: { invalidate: state.invalidate } }),
  auth: { me: { useQuery: () => ({ data: { id: 7, role: "cashier", branchId: 2 } }) } },
  shifts: { current: { useQuery: () => ({ data: { id: 22 } }) } },
  delivery: {
    consignmentTimeline: { useQuery: () => ({ data: state.timeline, isFetching: false }) },
    openConsignments: {
      useQuery: () => ({ data: { rows: state.rows }, isFetching: state.fetching }),
      useInfiniteQuery: () => ({ data: { pages: [{ rows: state.rows }] }, isFetching: state.fetching, hasNextPage: state.hasNextPage, fetchNextPage: state.next }),
    },
    getParty: { useQuery: () => ({ data: { branchId: 2 } }) },
    staffConfirm: { useMutation: () => ({ isPending: false, mutateAsync: state.staff }) },
    recordRemittance: { useMutation: () => ({ isPending: false, mutateAsync: state.remit }) },
  },
} }));
vi.mock("@/components/ui/dialog", () => ({ useDialogComposition: () => ({ justEndedComposing: () => false, setComposing: vi.fn(), markCompositionEnd: vi.fn() }), Dialog: ({ children }: any) => <div>{children}</div>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <div>{children}</div>, DialogFooter: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ children, onValueChange, ...props }: any) => <select {...props} onChange={event => onValueChange(event.target.value)}>{children}</select> }));
vi.mock("@/components/form/MoneyInput", () => ({ MoneyInput: ({ onChange, ariaLabel, ...props }: any) => <input {...props} aria-label={ariaLabel} onInput={event => onChange(event.currentTarget.value)} /> }));
import { CollectConsignmentDialog } from "./CollectConsignmentDialog";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
describe("current collection obligation", () => {
  let host: HTMLDivElement; let root: Root;
  const target = { id: 1, partyId: 2, codDue: "40000", codAmount: "40000", parcelStatus: "DELIVERED" };
  const confirm = () => Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("تأكيد القبض"))!;
  async function render(selected = target) { await act(async () => root.render(<CollectConsignmentDialog open consignment={selected} onOpenChange={state.close} onCompleted={state.completed} />)); }
  beforeEach(() => {
    state.rows = [{ id: 1, codAmount: "20000", collectedAmount: "0", counterSettledAmount: "5000", shortfallAssigned: "2000", parcelStatus: "DELIVERED" }];
    state.timeline = undefined;
    state.fetching = false; state.hasNextPage = false; state.next.mockClear(); state.remit.mockReset();
    state.staff.mockReset(); state.staff.mockResolvedValue({});
    state.invalidate.mockReset(); state.invalidate.mockResolvedValue(undefined);
    state.print.mockClear(); state.close.mockClear(); state.completed.mockClear();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  it("uses refreshed collection and return amounts instead of the frozen dialog target", async () => {
    await render(); expect(confirm().textContent).toContain("13,000");
    state.rows = [{ ...state.rows[0], counterSettledAmount: "12000" }];
    await render(); expect(confirm().textContent).toContain("6,000");
  });
  it("clears the obligation when a returned or cancelled consignment disappears", async () => {
    await render(); state.rows = []; await render();
    expect(confirm().textContent).toContain("(0"); expect(confirm().disabled).toBe(true);
    expect(state.remit).not.toHaveBeenCalled();
  });
  it("waits for a complete fresh list before allowing remittance", async () => {
    state.fetching = true; await render(); expect(confirm().disabled).toBe(true);
    state.fetching = false; state.hasNextPage = true; await render(); expect(confirm().disabled).toBe(true);
  });

  it("does not allow manually changing the invoice remittance amount", async () => {
    await render();
    expect(host.querySelector<HTMLInputElement>('[aria-label="المبلغ المقبوض"]')?.disabled).toBe(true);
  });
  it.each([13000])("recovers the immutable %i remittance after commit and a lost response without repeating delivery confirmation", async amount => {
    const selected = { ...target, parcelStatus: "IN_TRANSIT" };
    state.rows = [{ ...state.rows[0], parcelStatus: "IN_TRANSIT" }];
    const receipt = { remittanceId: 91, remittanceNumber: "REM-91", netRemitted: String(amount), shortfallTotal: String(13000 - amount) };
    state.remit.mockImplementationOnce(async () => {
      state.rows = [];
      throw new Error("Failed to fetch");
    }).mockResolvedValueOnce(receipt);
    await render(selected);
    if (amount !== 13000) {
      await act(async () => {
        const input = host.querySelector<HTMLInputElement>('[aria-label="المبلغ المقبوض"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(amount));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        const reason = Array.from(host.querySelectorAll("select")).find(select => Array.from(select.options).some(option => option.value === "OTHER"))!;
        reason.value = "OTHER";
        reason.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    expect(state.staff).toHaveBeenCalledTimes(1);
    expect(state.remit).toHaveBeenCalledTimes(1);
    const submitted = state.remit.mock.calls[0][0];
    expect(submitted).toMatchObject({ partyId: 2, countedCash: String(amount), lines: [{ consignmentId: 1, collectedAmount: String(amount) }] });
    expect(submitted.clientRequestId).toBeTruthy();
    expect(submitted.shortfall).toEqual(amount === 13000 ? null : { reason: "OTHER", notes: null });
    expect(state.close).not.toHaveBeenCalled();

    state.fetching = true;
    await render(selected);
    expect(confirm().disabled).toBe(true);
    const recover = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("استعادة نتيجة التوريد"))!;
    expect(recover).toBeDefined();
    expect(recover.disabled).toBe(false);
    // An acknowledged receipt must print/close even while refreshed lists are still pending.
    state.invalidate.mockImplementation(() => new Promise(() => {}));
    await act(async () => recover.click());
    expect(state.remit).toHaveBeenCalledTimes(2);
    expect(state.remit.mock.calls[1][0]).toBe(submitted);
    expect(state.staff).toHaveBeenCalledTimes(1);
    expect(state.print).toHaveBeenCalledWith("جهة التوصيل", receipt);
    expect(state.close).toHaveBeenCalledWith(false);
    expect(state.completed).toHaveBeenCalledTimes(1);
  });

  it("collects all invoices of a grouped multi-invoice shipment with exact Decimal math and wholeShipment confirmation", async () => {
    state.rows = [
      { id: 10, shipmentLeaderConsignmentId: 10, shipmentInvoiceCount: 2, codAmount: "100.10", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "OUT_FOR_DELIVERY" },
      { id: 11, shipmentLeaderConsignmentId: 10, shipmentInvoiceCount: 2, codAmount: "200.20", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "OUT_FOR_DELIVERY" },
    ];
    state.remit.mockResolvedValueOnce({ remittanceId: 99, remittanceNumber: "REM-99", netRemitted: "300.30", shortfallTotal: "0.00" });
    await render({ id: 10, partyId: 2, codDue: "100.10", codAmount: "100.10", parcelStatus: "OUT_FOR_DELIVERY" });
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    expect(state.staff).toHaveBeenCalledWith(expect.objectContaining({
      wholeShipment: true,
      consignmentId: 10,
      collectedAmount: "300.3",
    }));
    expect(state.remit).toHaveBeenCalledWith(expect.objectContaining({
      partyId: 2,
      targetShiftId: 22,
      countedCash: "300.3",
      lines: [
        { consignmentId: 10, collectedAmount: "100.1" },
        { consignmentId: 11, collectedAmount: "200.2" },
      ],
    }));
  });

  it("excludes zero-custody credit deliveries in ALL_PARTY remittance mode", async () => {
    state.rows = [
      { id: 1, codAmount: "10000", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "DELIVERED", cashInCourierCustody: "10000.00" },
      { id: 2, codAmount: "5000", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "DELIVERED", cashInCourierCustody: "5000.00" },
      { id: 3, codAmount: "8000", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "DELIVERED", cashInCourierCustody: "0.00" },
    ];
    state.remit.mockResolvedValueOnce({ remittanceId: 101, remittanceNumber: "REM-101", netRemitted: "15000.00", shortfallTotal: "0.00" });
    await render();
    const allPartyBtn = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("تصفير كامل ذمة المندوب"))!;
    await act(async () => allPartyBtn.click());
    expect(confirm().textContent).toContain("15,000");
    await act(async () => confirm().click());
    expect(state.remit).toHaveBeenCalledWith(expect.objectContaining({
      partyId: 2,
      countedCash: "15000",
      lines: [
        { consignmentId: 1, collectedAmount: "10000" },
        { consignmentId: 2, collectedAmount: "5000" },
      ],
    }));
  });

  it("resolves partyId from consignmentTimeline when opened with partyId=0", async () => {
    state.timeline = { consignment: { id: 1, partyId: 9 } };
    state.remit.mockResolvedValueOnce({ remittanceId: 102, remittanceNumber: "REM-102", netRemitted: "13000.00", shortfallTotal: "0.00" });
    await render({ ...target, partyId: 0 });
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    expect(state.remit).toHaveBeenCalledWith(expect.objectContaining({
      partyId: 9,
      countedCash: "13000",
    }));
  });

  it("settles a grouped shipment even when opened from its zero-COD leader row", async () => {
    state.rows = [
      { id: 10, shipmentLeaderConsignmentId: 10, shipmentInvoiceCount: 2, codAmount: "0.00", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "OUT_FOR_DELIVERY" },
      { id: 11, shipmentLeaderConsignmentId: 10, shipmentInvoiceCount: 2, codAmount: "25000.00", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "OUT_FOR_DELIVERY" },
    ];
    state.remit.mockResolvedValueOnce({ remittanceId: 103, remittanceNumber: "REM-103", netRemitted: "25000.00", shortfallTotal: "0.00" });
    await render({ id: 10, partyId: 2, codDue: "0.00", codAmount: "0.00", parcelStatus: "OUT_FOR_DELIVERY" } as any);
    expect(host.textContent).toContain("شحنة 2 فواتير");
    expect(confirm().disabled).toBe(false);
    await act(async () => confirm().click());
    expect(state.staff).toHaveBeenCalledWith(expect.objectContaining({
      wholeShipment: true,
      consignmentId: 10,
      collectedAmount: "25000",
    }));
    expect(state.remit).toHaveBeenCalledWith(expect.objectContaining({
      partyId: 2,
      countedCash: "25000",
      lines: [{ consignmentId: 11, collectedAmount: "25000" }],
    }));
  });

  it("blocks grouped shipment settlement when a zero-COD leader has feeWithholdingBlocked", async () => {
    state.rows = [
      { id: 10, shipmentLeaderConsignmentId: 10, shipmentInvoiceCount: 2, codAmount: "0.00", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "DELIVERED", cashInCourierCustody: "0.00", feeWithholdingBlocked: true },
      { id: 11, shipmentLeaderConsignmentId: 10, shipmentInvoiceCount: 2, codAmount: "25000.00", collectedAmount: "0", counterSettledAmount: "0", shortfallAssigned: "0", parcelStatus: "DELIVERED", cashInCourierCustody: "25000.00", feeWithholdingBlocked: false },
    ];
    await render({ id: 11, partyId: 2, codDue: "25000.00", codAmount: "25000.00", parcelStatus: "DELIVERED" } as any);
    expect(confirm().disabled).toBe(true);
    expect(host.textContent).toContain("قيود على أجرة هذه الشحنة");
  });
});
