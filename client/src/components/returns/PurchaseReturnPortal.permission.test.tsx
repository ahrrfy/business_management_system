// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  visible: false,
  suppliers: vi.fn(),
  drawers: vi.fn(),
}));
vi.mock("@/hooks/useOperationPermission", () => ({ useOperationPermission: () => ({ allowed: true }) }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ suppliers: { list: { invalidate: vi.fn() } } }),
  auth: { me: { useQuery: () => ({ data: { role: "manager", operationPolicyEnabled: true, resolvedOperationPolicy: {
    version: 1, grants: { "operation.returns.executePurchaseReturnCart": true },
    dataVisibility: { purchaseCost: state.visible, profitMargin: state.visible },
  } } }) } },
  branches: { list: { useQuery: () => ({ data: [{ id: 2 }] }) } },
  suppliers: { list: { useQuery: (...args: unknown[]) => { state.suppliers(...args); return { data: [{ id: 1, name: "المورد", currentBalance: "987654" }] }; } } },
  returns: {
    getOpenRefundDrawers: { useQuery: (...args: unknown[]) => { state.drawers(...args); return { data: [{ shiftId: 7, userName: "خزينة الشركة", isMine: true }] }; } },
    executePurchaseReturnCart: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
  },
} }));
vi.mock("@/components/invoice/ProductSearchBar", () => ({ ProductSearchBar: () => <span>بحث تكلفة البضاعة</span> }));
vi.mock("./printThermalReturnReceipt", () => ({ printPurchaseReturnVoucher: vi.fn() }));
import { PurchaseReturnPortal } from "./PurchaseReturnPortal";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
describe("purchase return financial surface", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    state.visible = false; state.suppliers.mockClear(); state.drawers.mockClear();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  function render() { act(() => root.render(<PurchaseReturnPortal onReturnSuccess={vi.fn()} />)); }
  it("does not show cached supplier and drawer data or fetch them without independent cost visibility", () => {
    render();
    expect(host.textContent).toContain("عرض التكلفة والربح");
    expect(host.textContent).not.toContain("بحث تكلفة البضاعة");
    expect(host.textContent).not.toContain("خزينة الشركة");
    expect(state.suppliers).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ enabled: false }));
    expect(state.drawers).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ enabled: false }));
  });
  it("removes a previously visible financial surface immediately after visibility is revoked", () => {
    state.visible = true; render();
    expect(host.textContent).toContain("بحث تكلفة البضاعة");
    state.visible = false; render();
    expect(host.textContent).not.toContain("بحث تكلفة البضاعة");
    expect(host.textContent).not.toContain("خزينة الشركة");
  });
});
