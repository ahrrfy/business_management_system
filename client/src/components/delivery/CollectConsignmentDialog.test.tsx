// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rows: [] as any[], fetching: false, hasNextPage: false, remit: vi.fn(), next: vi.fn(), staff: vi.fn(), invalidate: vi.fn(), print: vi.fn(), close: vi.fn(), completed: vi.fn() }));
vi.mock("@/lib/lifecycleActionPermission", () => ({ lifecycleActionAllowed: () => true }));
vi.mock("./printRemittanceReceipt", () => ({ printRemittanceReceipt: state.print }));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ delivery: { invalidate: state.invalidate }, shifts: { invalidate: state.invalidate }, treasury: { invalidate: state.invalidate }, sales: { invalidate: state.invalidate }, workOrders: { invalidate: state.invalidate } }),
  auth: { me: { useQuery: () => ({ data: { id: 7, role: "cashier", branchId: 2 } }) } },
  shifts: { current: { useQuery: () => ({ data: { id: 22 } }) } },
  delivery: {
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
  const confirm = () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("تأكيد القبض"))!;
  async function render(selected = target) { await act(async () => root.render(<CollectConsignmentDialog open consignment={selected} onOpenChange={state.close} onCompleted={state.completed} />)); }
  beforeEach(() => {
    state.rows = [{ id: 1, codAmount: "20000", collectedAmount: "0", counterSettledAmount: "5000", shortfallAssigned: "2000", parcelStatus: "DELIVERED" }];
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

  it.each([13000, 5000])("recovers the immutable %i remittance after commit and a lost response without repeating delivery confirmation", async amount => {
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
        const reason = [...host.querySelectorAll("select")].find(select => [...select.options].some(option => option.value === "OTHER"))!;
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
    const recover = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("استعادة نتيجة التوريد"))!;
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
});
