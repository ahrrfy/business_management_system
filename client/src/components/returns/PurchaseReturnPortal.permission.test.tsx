// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  visible: false,
  userId: 10,
  companyId: 5,
  mutate: vi.fn(),
  lookup: vi.fn(),
  openDrawers: [{ shiftId: 7, userName: "����� ������", isMine: true }],
  add: null as null | ((line: any) => void),
  suppliersAllowed: true,
  suppliers: vi.fn(),
  drawers: vi.fn(),
}));
vi.mock("@/hooks/useOperationPermission", () => ({
  useOperationPermission: () => ({ allowed: true }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      returns: { lookupItemForReturn: { fetch: state.lookup } },
      suppliers: { list: { invalidate: vi.fn() } },
    }),
    auth: {
      me: {
        useQuery: () => ({
          data: {
            id: state.userId,
            companyId: state.companyId,
            branchId: 2,
            role: "manager",
            operationPolicyEnabled: true,
            resolvedOperationPolicy: {
              version: 1,
              grants: {
                "operation.returns.executePurchaseReturnCart": true,
                "operation.suppliers.list": state.suppliersAllowed,
                "operation.returns.getOpenRefundDrawers": true,
              },
              dataVisibility: {
                purchaseCost: state.visible,
                profitMargin: state.visible,
              },
            },
          },
        }),
      },
    },
    branches: { list: { useQuery: () => ({ data: [{ id: 2 }] }) } },
    suppliers: {
      list: {
        useQuery: (...args: unknown[]) => {
          state.suppliers(...args);
          return {
            data: [{ id: 1, name: "المورد", currentBalance: "987654" }],
          };
        },
      },
    },
    returns: {
      getOpenRefundDrawers: {
        useQuery: (...args: unknown[]) => {
          state.drawers(...args);
          return {
            data: state.openDrawers,
          };
        },
      },
      executePurchaseReturnCart: {
        useMutation: () => ({ isPending: false, mutateAsync: state.mutate }),
      },
    },
  },
}));
vi.mock("@/components/invoice/ProductSearchBar", () => ({
  ProductSearchBar: (props: any) => {
    state.add = props.onAddProduct;
    return <span>بحث تكلفة البضاعة</span>;
  },
}));
vi.mock("./printThermalReturnReceipt", () => ({
  printPurchaseReturnVoucher: vi.fn(),
}));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/lib/notify", () => ({
  notify: { ok: vi.fn(), err: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: (p: any) => (
    <select value={p.value} onChange={(e) => p.onValueChange(e.target.value)}>
      {p.children}
    </select>
  ),
}));
import { purchaseReturnCartInputSchema } from "@shared/purchaseReturnCartInput";
import { confirm } from "@/lib/confirm";
import { PurchaseReturnPortal } from "./PurchaseReturnPortal";
import { printPurchaseReturnVoucher } from "./printThermalReturnReceipt";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
describe("purchase return financial surface", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    sessionStorage.clear();
    state.mutate.mockReset();
    vi.mocked(confirm).mockClear();
    state.userId = 10;
    state.companyId = 5;
    state.openDrawers = [
      { shiftId: 7, userName: "����� ������", isMine: true },
    ];
    state.visible = false;
    state.suppliersAllowed = true;
    state.suppliers.mockClear();
    state.drawers.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function render() {
    act(() => root.render(<PurchaseReturnPortal onReturnSuccess={vi.fn()} />));
  }
  it("does not show cached supplier and drawer data or fetch them without independent cost visibility", () => {
    render();
    expect(host.textContent).toContain("عرض التكلفة والربح");
    expect(host.textContent).not.toContain("بحث تكلفة البضاعة");
    expect(host.textContent).not.toContain("خزينة الشركة");
    expect(state.suppliers).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
    );
    expect(state.drawers).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
    );
  });
  it("removes a previously visible financial surface immediately after visibility is revoked", () => {
    state.visible = true;
    render();
    expect(host.textContent).toContain("بحث تكلفة البضاعة");
    state.visible = false;
    render();
    expect(host.textContent).not.toContain("بحث تكلفة البضاعة");
    expect(host.textContent).not.toContain("خزينة الشركة");
  });
  it("fails closed when the supplier-list dependency is revoked", () => {
    state.visible = true;
    state.suppliersAllowed = false;
    render();
    expect(host.textContent).toContain("صلاحية عرض قائمة الموردين");
    expect(host.textContent).not.toContain("بحث تكلفة البضاعة");
    expect(state.suppliers).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
    );
  });
  const input = () => ({
    supplierId: 1,
    branchId: 2,
    reference: "ACK",
    evidenceType: "SUPPLIER_ACKNOWLEDGEMENT",
    clientRequestId: "11111111-1111-4111-8111-111111111111",
    items: [
      { variantId: 1, productName: "Paper", quantity: 1, unitCost: "150" },
    ],
    settlement: { method: "CASH_IN", totalAmount: "150", shiftId: 7 },
    reason: "Supplier agreement",
  });
  const storageKey = () =>
    `purchase-return-pending:${JSON.stringify([window.location.origin, 5, 10, 2])}`;
  function restore() {
    sessionStorage.setItem(
      storageKey(),
      JSON.stringify({ proposal: input(), requestId: 44 }),
    );
    state.visible = true;
    render();
  }
  async function click(submit = false) {
    await act(async () => {
      const buttons = Array.from(host.querySelectorAll("button"));
      const button = submit
        ? buttons.at(-1)
        : buttons.find((b) => !b.closest("fieldset"));
      expect(button).toBeDefined();
      button!.click();
    });
  }

  function remount() {
    act(() => root.unmount());
    root = createRoot(host);
    render();
  }
  it("restores pending identity across real unmount and continues CASH with no open drawers", async () => {
    restore();
    remount();
    state.openDrawers = [];
    render();
    expect(state.openDrawers).toHaveLength(0);
    expect(host.textContent).toContain("لا توجد وردية كاشير مفتوحة حالياً");
    state.mutate.mockResolvedValue({
      mode: "REQUESTED",
      requestId: 44,
      status: "PENDING",
    });
    await click();
    expect(state.mutate).toHaveBeenCalledWith(input());
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.textContent).toContain("44");
  });
  it("keeps unknown outcome frozen across unmount and retries exactly the original payload", async () => {
    restore();
    state.mutate.mockRejectedValue(new Error("connection lost"));
    await click();
    remount();
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    state.mutate.mockResolvedValue({
      mode: "REQUESTED",
      requestId: 44,
      status: "PENDING",
    });
    await click();
    expect(state.mutate.mock.calls.map((c) => c[0])).toEqual([
      input(),
      input(),
    ]);
  });
  it("separates another company or user from a retained proposal", () => {
    restore();
    state.userId = 11;
    render();
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    expect(host.textContent).not.toContain("Paper");
    state.userId = 10;
    state.companyId = 6;
    render();
    expect(host.textContent).not.toContain("Paper");
    state.companyId = 5;
    render();
    expect(host.textContent).toContain("Paper");
  });
  it("unfreezes only an explicit rolled-back proposal and preserves its key for visible correction", async () => {
    restore();
    state.mutate.mockResolvedValue({
      mode: "INVALID_PROPOSAL",
      message: "Invalid unit",
    });
    await click();
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
    expect(sessionStorage.getItem(storageKey())).toBeNull();
    state.mutate.mockResolvedValue({
      mode: "REQUESTED",
      requestId: 45,
      status: "PENDING",
    });
    await click(true);
    expect(state.mutate.mock.calls[1][0].clientRequestId).toBe(
      input().clientRequestId,
    );
  });

  it("freezes an initial dispatch immediately and ignores deferred product callbacks through lost response and reopen", async () => {
    restore();
    state.mutate.mockResolvedValueOnce({
      mode: "INVALID_PROPOSAL",
      message: "Invalid unit",
    });
    await click();
    act(() =>
      state.add!({ variantId: 1, name: "Paper", qty: 1, price: "150" }),
    );
    let reject!: (e: Error) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    await click(true);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(state.mutate.mock.calls[1][0].items[0].quantity).toBe(2);
    act(() =>
      state.add!({ variantId: 1, name: "Paper", qty: 7, price: "999" }),
    );
    expect(
      (host.querySelector('input[type="number"]') as HTMLInputElement).value,
    ).toBe("2");
    await act(async () => reject(new Error("response lost")));
    remount();
    expect(
      (host.querySelector('input[type="number"]') as HTMLInputElement).value,
    ).toBe("2");
    state.mutate.mockResolvedValueOnce({
      mode: "REQUESTED",
      requestId: 44,
      status: "PENDING",
    });
    await click();
    expect(state.mutate.mock.calls[2][0]).toEqual(
      state.mutate.mock.calls[1][0],
    );
  });

  it("prints the committed document on closed-drawer continuation with its original key", async () => {
    restore();
    state.openDrawers = [];
    render();
    expect(state.openDrawers).toHaveLength(0);
    expect(host.textContent).toContain("لا توجد وردية كاشير مفتوحة حالياً");
    vi.mocked(printPurchaseReturnVoucher).mockClear();
    state.mutate.mockResolvedValue({
      mode: "EXECUTED",
      requestId: 44,
      document: {
        returnNumber: "RET-44",
        supplierName: "Supplier",
        totalAmount: "150.00",
        settlement: "CASH",
        paymentMethod: "CASH",
        postedAt: "2026-10-29",
        createdByName: "Owner",
        origin: "OWNER_EXCEPTION",
        items: [
          {
            productNameSnapshot: "Paper",
            quantity: 1,
            unitPrice: "150.00",
            lineTotal: "150.00",
          },
        ],
      },
    });
    await click();
    expect(state.mutate).toHaveBeenCalledWith(input());
    expect(printPurchaseReturnVoucher).toHaveBeenCalledWith(
      expect.objectContaining({
        returnNumber: "RET-44",
        postedAt: "2026-10-29",
        totalAmount: "150.00",
      }),
    );
    expect(sessionStorage.getItem(storageKey())).toBeNull();
  });
  it("retains an in-flight submission when navigation unmounts before a response arrives", async () => {
    restore();
    let resolve!: (v: unknown) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await click();
    remount();
    await act(async () =>
      resolve({ mode: "REQUESTED", requestId: 44, status: "PENDING" }),
    );
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(storageKey())!).proposal).toEqual(
      input(),
    );
    state.mutate.mockResolvedValueOnce({
      mode: "REQUESTED",
      requestId: 44,
      status: "PENDING",
    });
    await click();
    expect(state.mutate.mock.calls[1][0]).toEqual(input());
  });
  it("submits a new visible cart then restores the same pending identity after navigation", async () => {
    state.visible = true;
    render();
    await act(async () => {
      const supplier = host.querySelector("select")!;
      supplier.value = "1";
      supplier.dispatchEvent(new Event("change", { bubbles: true }));
      const fields = Array.from(host.querySelectorAll("input"));
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(fields[0], "ACK-NEW");
      fields[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(fields[1], "New supplier agreement");
      fields[1].dispatchEvent(new Event("input", { bubbles: true }));
      state.add!({ variantId: 1, name: "New paper", qty: 2, price: "175" });
    });
    let finish!: (value: unknown) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(printPurchaseReturnVoucher).mockClear();
    await click(true);
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    act(() =>
      state.add!({ variantId: 1, name: "New paper", qty: 9, price: "999" }),
    );
    expect(
      (host.querySelector('input[type="number"]') as HTMLInputElement).value,
    ).toBe("2");
    await act(async () =>
      finish({ mode: "REQUESTED", requestId: 77, status: "PENDING" }),
    );
    const sent = state.mutate.mock.calls[0][0];
    expect(sent).toMatchObject({
      reference: "ACK-NEW",
      reason: "New supplier agreement",
      items: [{ quantity: 2, unitCost: "175" }],
    });
    expect(printPurchaseReturnVoucher).not.toHaveBeenCalled();
    remount();
    expect(host.textContent).toContain("77");
    state.mutate.mockResolvedValueOnce({
      mode: "REQUESTED",
      requestId: 77,
      status: "PENDING",
    });
    await click();
    expect(state.mutate.mock.calls[1][0]).toEqual(sent);
  });
  function setText(index: number, value: string) {
    act(() => {
      const field = host.querySelectorAll("input")[index];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function newCart(qty = 3, price = "100.10") {
    state.visible = true;
    render();
    act(() => {
      const supplier = host.querySelector("select")!;
      supplier.value = "1";
      supplier.dispatchEvent(new Event("change", { bubbles: true }));
      state.add!({ variantId: 1, name: "Paper", qty, price });
    });
    setText(0, "ACK-NEW");
    setText(1, "Supplier agreement");
  }
  function chooseRail(text: string) {
    act(() => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes(text))!.click());
  }
  function expectEditableWithoutDispatch() {
    expect(state.mutate).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(storageKey())).toBeNull();
    expect(host.querySelector("fieldset")?.disabled).toBe(false);
  }
  it("serializes a visible 100.10 x3 cart as exact 300.30 accepted by the router contract", async () => {
    newCart();
    state.mutate.mockImplementation(async proposal => {
      expect(proposal.settlement.totalAmount).toBe("300.30");
      expect(purchaseReturnCartInputSchema.safeParse(proposal).success).toBe(true);
      return { mode: "REQUESTED", requestId: 55, status: "PENDING" };
    });
    await click(true);
    expect(state.mutate).toHaveBeenCalledTimes(1);
    const sent = state.mutate.mock.calls[0][0];
    expect(sent.settlement.totalAmount).toBe("300.30");
    expect(purchaseReturnCartInputSchema.safeParse(sent).success).toBe(true);
    expect(host.textContent).toContain("55");
    remount();
    await click();
    expect(state.mutate.mock.calls[1][0]).toEqual(sent);
  });
  it("rejects a 161 character transfer reference before confirmation and allows correction", async () => {
    newCart();
    chooseRail("حوالة بنكية");
    setText(0, "R".repeat(161));
    await click(true);
    expectEditableWithoutDispatch();
    setText(0, "R".repeat(160));
    state.mutate.mockResolvedValue({ mode: "REQUESTED", requestId: 55, status: "PENDING" });
    await click(true);
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(purchaseReturnCartInputSchema.safeParse(state.mutate.mock.calls[0][0]).success).toBe(true);
  });
  it.each([[0, 501], [1, 501]])("rejects overlong evidence/reason field %s before confirmation", async (field, length) => {
    newCart();
    setText(field, "R".repeat(length));
    await click(true);
    expectEditableWithoutDispatch();
  });
  it.each<[number, string]>([[1.5, "100.10"], [-1, "100.10"], [3, "-1"], [3, "1.001"]])("rejects quantity/money outside router bounds: %s / %s", async (qty, price) => {
    newCart(qty, price);
    await click(true);
    expectEditableWithoutDispatch();
  });
  it("refuses a new cash cart when the actual drawer query is empty", async () => {
    state.openDrawers = [];
    newCart();
    chooseRail("مردود نقدي (توريد نقد للصندوق)");
    expect(state.openDrawers).toHaveLength(0);
    expect(host.textContent).toContain("لا توجد وردية كاشير مفتوحة حالياً");
    await click(true);
    expectEditableWithoutDispatch();
  });
  it("retains even a router-invalid saved unknown proposal verbatim on retry", async () => {
    const saved = input();
    saved.settlement.totalAmount = "300.29999999999995";
    sessionStorage.setItem(storageKey(), JSON.stringify({proposal: saved, requestId: null}));
    state.visible = true;
    render();
    state.mutate.mockRejectedValue(new Error("BAD_REQUEST"));
    await click();
    expect(state.mutate).toHaveBeenCalledWith(saved);
    expect(JSON.parse(sessionStorage.getItem(storageKey())!).proposal).toEqual(saved);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
  });

  it.each<[string, (p: any) => void]>([
    ["supplier", (p: any) => { p.supplierId = 0; }],
    ["branch", (p: any) => { p.branchId = 1.5; }],
    ["evidence type", (p: any) => { p.evidenceType = "INVALID"; }],
    ["variant", (p: any) => { p.items[0].variantId = -1; }],
    ["unit", (p: any) => { p.items[0].productUnitId = 0; }],
    ["name", (p: any) => { p.items[0].productName = ""; }],
    ["barcode", (p: any) => { p.items[0].barcode = 3; }],
    ["empty items", (p: any) => { p.items = []; }],
    ["501 items", (p: any) => { p.items = Array(501).fill(p.items[0]); }],
    ["settlement method", (p: any) => { p.settlement.method = "INVALID"; }],
    ["total precision", (p: any) => { p.settlement.totalAmount = "300.29999999999995"; }],
    ["shift", (p: any) => { p.settlement.shiftId = 0; }],
    ["request key", (p: any) => { p.clientRequestId = "K".repeat(65); }],
  ])("uses the shared router bound for %s", (_name, invalidate) => {
    const proposal = input();
    expect(purchaseReturnCartInputSchema.safeParse(proposal).success).toBe(true);
    invalidate(proposal);
    expect(purchaseReturnCartInputSchema.safeParse(proposal).success).toBe(false);
  });

});
