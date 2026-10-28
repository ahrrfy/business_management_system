// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShipmentDetailsPanel } from "./ShipmentDetailsPanel";

const state = vi.hoisted(() => ({ invoiceId: 0 }));
vi.mock("@/lib/trpc", () => {
  const mutation = { useMutation: () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})) }) };
  return { trpc: { auth: { me: { useQuery: () => ({ data: { id: 1, role: "admin" } }) } }, useUtils: () => ({ delivery: { invalidate: vi.fn(), documents: { invalidate: vi.fn() } }, sales: { invalidate: vi.fn() }, workOrders: { invalidate: vi.fn() } }), invoicePrinting: { requestPrint: mutation, requestReprint: mutation },
    delivery: { listParties: { useQuery: () => ({ data: [] }) }, documents: { prepareShipmentPrintBundle: mutation, requestPrint: mutation, completePrint: mutation }, staffConfirm: mutation, cancelAssignment: mutation,
      returnConsignment: mutation, staffMarkFailed: mutation, reassignConsignment: mutation, declareReturn: mutation } } };
});
vi.mock("./InvoiceDispatchDialog", () => ({ InvoiceDispatchDialog: ({ invoice }: { invoice: { id: number } | null }) => {
  state.invoiceId = invoice?.id ?? 0; return null;
} }));
vi.mock("@/components/ui/AppSelect", () => ({ AppSelect: ({ children, onValueChange, ...props }: React.ComponentProps<"select"> & { onValueChange?: (value: string) => void }) =>
  <select {...props} onChange={event => onValueChange?.(event.currentTarget.value)}>{children}</select> }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, size: _size, variant: _variant, ...props }: React.ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props}>{children}</button> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Shipment = React.ComponentProps<typeof ShipmentDetailsPanel>["shipment"];
const member = { id: 1, invoiceId: 101, invoiceNumber: "INV-101", invoiceStatus: "CANCELLED", invoiceRemaining: "0.00", operational: false,
  status: "CANCELLED", parcelStatus: "CANCELLED", collectedAmount: "0", returnDeclaredAt: null, partyId: 1, externalTrackingRef: "TRACK-1", assignedUserId: null };
const fixture = () => ({ leaderConsignmentId: 1, consignmentNumber: "CN-1", memberCount: 2, remainingAmount: "10000.00", deliveryFee: "1500.00",
  members: [member, { ...member, id: 2, invoiceId: 102, invoiceNumber: "INV-102", invoiceStatus: "PENDING", invoiceRemaining: "10000.00",
    operational: true, status: "DISPATCHED", parcelStatus: "OUT_FOR_DELIVERY" }] }) as Shipment;
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());
function render(shipment: Shipment) {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  act(() => root.render(<ShipmentDetailsPanel shipment={shipment} />));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  return host;
}

describe("shipment member continuity in the details panel", () => {
  it("keeps physical actions and original tracking visible while preserving cancelled invoice history", () => {
    const host = render(fixture());
    expect(host.querySelector('option[value="confirm"]')).not.toBeNull();
    expect(host.textContent).toContain("ملغاة · خارج إجراءات الشحنة");
    expect(host.textContent).toContain("TRACK-1");
    expect(host.querySelectorAll('a[href^="/invoices/"]')).toHaveLength(2);
  });
  it("opens redispatch on the surviving invoice when all assignments are closed", () => {
    const shipment = fixture();
    shipment.members[1] = { ...shipment.members[1], operational: false, status: "CANCELLED", parcelStatus: "CANCELLED" };
    const host = render(shipment);
    const button = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("إعادة إسناد"))!;
    act(() => button.click());
    expect(state.invoiceId).toBe(102);
  });
});
