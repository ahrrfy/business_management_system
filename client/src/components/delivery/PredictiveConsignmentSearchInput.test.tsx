// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PredictiveConsignmentSearchInput } from "./PredictiveConsignmentSearchInput";
import { InvoiceHeaderCard } from "../invoice/InvoiceHeaderCard";
import type { InvoiceDetailData } from "../invoice/InvoiceDetailComponents";
import { D } from "@/lib/money";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  change: null as ((value: string) => void) | null,
  delayedQuery: null as string | null,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    delivery: { predictiveSearch: { useQuery: () => ({ data: state.rows }) } },
  },
}));
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: string) => state.delayedQuery ?? value,
}));
vi.mock("@/lib/notifyBeep", () => ({ playReadyBeep: vi.fn() }));
vi.mock("@/components/search/UnifiedSearchInput", () => ({
  UnifiedSearchInput: React.forwardRef<
    HTMLInputElement,
    { onChange: (value: string) => void }
  >((props, ref) => {
    state.change = props.onChange;
    return <input ref={ref} />;
  }),
}));

const candidate = {
  id: 1461,
  consignmentNumber: "101567",
  invoiceId: 29218,
  invoiceNumber: "101567",
  workOrderId: 859,
  onlineOrderId: null,
  orderNumber: "101567",
  partyId: 1,
  partyName: "شركة",
  partyType: "COMPANY" as const,
  customerName: "عميل",
  customerPhone: null,
  deliveryAddress: null,
  parcelStatus: "OUT_FOR_DELIVERY",
  moneyStatus: "UNSETTLED",
  status: "DISPATCHED",
  codAmount: "9000.00",
  collectedAmount: "0.00",
  counterSettledAmount: "0.00",
  remainingAmount: "9000.00",
  matchedOn: ["INVOICE_NUMBER" as const],
  score: 0,
  externalTrackingRef: null,
};

describe("current invoice and carrier obligations", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as any).React = React;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    state.rows = [];
    state.delayedQuery = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("replaces stale local money with the server result for the same consignment", () => {
    const props = { localCandidates: [candidate], onSelect: vi.fn() };
    act(() => root.render(<PredictiveConsignmentSearchInput {...props} />));
    act(() => state.change!("101567"));
    expect(host.textContent).toContain("9,000");
    state.rows = [
      { ...candidate, remainingAmount: "5000.00", codAmount: "5000.00" },
    ];
    act(() => root.render(<PredictiveConsignmentSearchInput {...props} />));
    expect(host.textContent).toContain("5,000");
    expect(host.textContent).not.toContain("9,000");
  });

  it("does not show the previous server query while the new term is debouncing", () => {
    state.rows = [candidate];
    state.delayedQuery = "101567";
    act(() =>
      root.render(<PredictiveConsignmentSearchInput onSelect={vi.fn()} />),
    );
    act(() => state.change!("another-customer"));
    expect(host.querySelector('[role="option"]')).toBeNull();
  });

  it("shows customer credit and courier exposure as separate amounts", () => {
    state.rows = [
      {
        ...candidate,
        codAmount: "0.00",
        remainingAmount: "0.00",
        invoicePaymentMode: "CREDIT",
        invoiceRemainingAmount: "5000.00",
        deliveryFee: "5000.00",
        feeCollection: "COURIER",
      },
    ];
    act(() =>
      root.render(<PredictiveConsignmentSearchInput onSelect={vi.fn()} />),
    );
    act(() => state.change!("101567"));
    expect(host.textContent).toContain("رصيد آجل على العميل");
    expect(host.textContent).toContain("5,000");
    expect(host.textContent).toContain("أجرة المندوب من العميل");
  });

  it.each(["server", "local"])("shows selected credit collection as 5000 goods plus 5000 fee from %s data", (source) => {
    const row = { ...candidate, codAmount: "5000", remainingAmount: "5000", invoicePaymentMode: "CREDIT", invoiceRemainingAmount: "5000", collectCreditOnDelivery: true, deliveryFee: "5000", feeCollection: "COURIER" };
    if (source === "server") state.rows = [row];
    act(() => root.render(<PredictiveConsignmentSearchInput localCandidates={source === "local" ? [row] : undefined} onSelect={vi.fn()} />));
    act(() => state.change!("101567"));
    expect(host.textContent).not.toContain("رصيد آجل على العميل");
    expect(host.querySelector('[data-testid="predictive-at-door"]')?.textContent).toBe("10,000 د.ع");
  });
  it("does not ask the customer to pay courier cash again after delivery", () => {
    state.rows = [{ ...candidate, parcelStatus: "DELIVERED", remainingAmount: "5000", invoicePaymentMode: "CREDIT", invoiceRemainingAmount: "0", collectCreditOnDelivery: true, cashInCourierCustody: "5000", deliveryFee: "5000", feeCollection: "COURIER" }];
    act(() => root.render(<PredictiveConsignmentSearchInput onSelect={vi.fn()} />));
    act(() => state.change!("101567"));
    expect(host.querySelector('[data-testid="predictive-at-door"]')).toBeNull();
    expect(host.textContent).not.toContain("رصيد آجل على العميل");
    expect(host.textContent).toContain("نقد بعهدة الجهة");
  });
  it("does not display an at-door demand after a declared return", () => {
    state.rows = [{ ...candidate, invoicePaymentMode: "CREDIT", invoiceRemainingAmount: "5000", collectCreditOnDelivery: true, returnDeclaredAt: "2026-10-29T14:00:00Z", deliveryFee: "5000", feeCollection: "COURIER" }];
    act(() => root.render(<PredictiveConsignmentSearchInput onSelect={vi.fn()} />));
    act(() => state.change!("101567"));
    expect(host.querySelector('[data-testid="predictive-at-door"]')).toBeNull();
    expect(host.textContent).not.toContain("رصيد آجل على العميل");
  });

  it("does not relabel a credit invoice as COD or add the full invoice to the delivery demand", () => {
    const data = {
      invoiceNumber: "101567",
      sourceType: "WORKORDER",
      status: "PARTIALLY_PAID",
      subtotal: "35000.00",
      total: "35000.00",
      paidAmount: "30000.00",
      returnedTotal: "0.00",
      paymentMode: "CREDIT",
      paymentMethod: "CARD",
      consignmentStatus: "DISPATCHED",
      courierName: "شركة",
      courierFee: "5000.00",
      courierFeeCollection: "COURIER",
    } as InvoiceDetailData;
    const html = renderToStaticMarkup(
      <InvoiceHeaderCard
        data={data}
        remaining={D(5000)}
        canOpenStatement={false}
      />,
    );
    expect(html).not.toContain("عند الاستلام (COD)");
    expect(html).toContain("آجل — على حساب العميل");
    expect(html).not.toContain("40,000");
    expect(html).toContain("المطلوب عند التسليم");
  });
});
