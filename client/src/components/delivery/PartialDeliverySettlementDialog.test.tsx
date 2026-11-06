// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  settle: vi.fn(),
  invalidate: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/lib/realtime/financialQueries", () => ({
  invalidateFinancialQueries: state.invalidate,
}));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ delivery: { invalidate: state.invalidate } }),
    shifts: {
      list: {
        useQuery: () => ({
          data: {
            rows: [
              { id: 22, shiftType: "RECEPTION" },
              { id: 23, shiftType: "RECEPTION" },
            ],
          },
        }),
      },
    },
    delivery: {
      workflow: {
        previewPartialOutcome: {
          useQuery: () => ({
            data: {
              consignmentId: 1787,
              branchId: 1,
              invoiceNumber: "106208",
              version: "current-plan",
              allowed: true,
              goodsAmount: "7000.00",
              feeAmount: "2000.00",
              feeCollection: "COURIER",
              cashAlreadyRecorded: false,
              deliveredLines: [
                { invoiceItemId: 1, name: "المسلم", baseQuantity: 1 },
              ],
              returnedLines: [
                { invoiceItemId: 2, name: "المرتجع", baseQuantity: 1 },
              ],
            },
          }),
        },
        settlePartialOutcome: {
          useMutation: () => ({ mutate: state.settle, isPending: false }),
        },
      },
    },
  },
}));
vi.mock("@/components/ui/dialog", () => ({
  useDialogComposition: () => ({
    justEndedComposing: () => false,
    setComposing: vi.fn(),
    markCompositionEnd: vi.fn(),
  }),
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ children, onValueChange, ...props }: any) => (
    <select {...props} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
}));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange }: any) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));
import SettlementDialog from "./PartialDeliverySettlementDialog";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
describe("partial settlement receiving drawer", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function render(fixed = true) {
    await act(async () =>
      root.render(
        <SettlementDialog
          consignmentId={1787}
          onClose={state.close}
          {...(fixed ? { targetShiftId: 22 } : {})}
        />,
      ),
    );
  }
  it("uses and locks the current receiving shift supplied by the barcode station", async () => {
    await render();
    const drawer = host.querySelector("select")!;
    expect(drawer.value).toBe("22");
    expect(drawer.disabled).toBe(true);
  });
  it("preserves explicit drawer choice when opened outside the barcode station", async () => {
    await render(false);
    const drawer = host.querySelector("select")!;
    expect(drawer.value).toBe("");
    expect(drawer.disabled).toBe(false);
  });
  it("sends only the reviewed goods cash to the current shift after explicit evidence and witnessing", async () => {
    await render();
    const evidence = host.querySelector<HTMLInputElement>(
      'input[maxlength="2000"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(evidence, "استلام يدوي سابق من المندوب");
      evidence.dispatchEvent(new Event("input", { bubbles: true }));
      evidence.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    const confirm = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("إثبات التسليم والقبض والتوريد"),
    )!;
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(state.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        consignmentId: 1787,
        expectedVersion: "current-plan",
        targetShiftId: 22,
        cashReceivedAmount: "7000.00",
        evidence: "استلام يدوي سابق من المندوب",
      }),
    );
    expect(state.settle).toHaveBeenCalledTimes(1);
  });
});
