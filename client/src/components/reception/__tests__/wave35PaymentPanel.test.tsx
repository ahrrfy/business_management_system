// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PaymentPanel } from "../PaymentPanel";
import { tenderTotals } from "@/components/payments/splitTender";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
describe("reception payment controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  const submit = vi.fn();
  const confirmFee = vi.fn();
  const base = () => ({
    payInput: "100",
    setPayInput: vi.fn(),
    deferred: false,
    setDeferred: vi.fn(),
    deferredAvailable: false,
    deferredCustomerName: null,
    deferredDisabledReason: null,
    method: "CASH",
    setMethod: vi.fn(),
    paymentReference: "",
    setPaymentReference: vi.fn(),
    needPaymentRef: false,
    grandTotal: 100,
    expectedNow: 100,
    cashRoundingDelta: 0,
    sumDirect: 100,
    sumCustom: 0,
    heldDelivery: 0,
    cashDueNow: 100,
    invoiceDiscountPct: "",
    setInvoiceDiscountPct: vi.fn(),
    invoiceDiscountAmount: 0,
    invoiceDiscountAllowed: false,
    invoiceDiscountMaxPct: 15,
    orderDelivery: null,
    heldDeposit: 0,
    paid: 100,
    change: 0,
    remaining: 0,
    isChange: false,
    isOwing: false,
    hasCustom: false,
    depositMenuOpen: false,
    setDepositMenuOpen: vi.fn(),
    depositOptions: [],
    payAll: vi.fn(),
    couponCode: null,
    couponLabel: null,
    couponInput: "",
    setCouponInput: vi.fn(),
    couponOpen: false,
    setCouponOpen: vi.fn(),
    applyCoupon: vi.fn(),
    clearCoupon: vi.fn(),
    couponPending: false,
    submitting: false,
    cartEmpty: false,
    hasShift: true,
    onSubmit: submit,
  });
  const split = () => ({
    active: true,
    parts: [
      { id: "one", method: "CASH", amount: "100", reference: "", proof: null },
    ],
    tendered: "100.00",
    problem: () => null,
    totals: (due: string) =>
      tenderTotals(
        [
          {
            id: "one",
            method: "CASH",
            amount: "100",
            reference: "",
            proof: null,
          },
        ],
        due,
      ),
    editorOpen: false,
    setEditorOpen: vi.fn(),
    enable: vi.fn(),
  });
  beforeEach(() => {
    submit.mockClear();
    confirmFee.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function render(extra: Record<string, unknown> = {}) {
    act(() => root.render(<PaymentPanel {...(base() as any)} {...extra} />));
  }
  it("submits exactly the chosen split, with one explicit action and no quick-full override", () => {
    render({ splitTender: split(), hasCustom: true, sumCustom: 100 });
    const buttons = [...host.querySelectorAll("button")];
    expect(host.textContent).not.toContain("بلا عربون");
    expect(host.textContent).not.toContain("تحصيل الإجمالي وطباعة");
    const save = buttons.find((b) => b.textContent === "تثبيت الدفعات وطباعة");
    expect(save).toBeDefined();
    act(() => save!.click());
    expect(submit).toHaveBeenCalledExactlyOnceWith({ quickFullPay: false });
    expect(
      host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
        ?.readOnly,
    ).toBe(true);
  });
  it("preserves ordinary cash/card controls and the legacy single-payment submission", () => {
    render();
    expect(host.textContent).toContain("نقدي");
    expect(host.textContent).toContain("بطاقة");
    const save = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "إتمام البيع المباشر",
    );
    act(() => save!.click());
    expect(submit).toHaveBeenCalledWith({ quickFullPay: false });
    expect(
      host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
        ?.readOnly,
    ).toBe(false);
  });
  it("separately explains and confirms the delivery fee without claiming a combined charge", () => {
    render({
      splitTender: split(),
      method: "CARD",
      heldDelivery: 5,
      cashDueNow: 105,
      deliveryFeePayment: {
        capturedAmount: "5.00",
        confirmed: false,
        pending: false,
        error: null,
        confirm: confirmFee,
      },
    });
    expect(host.textContent).toContain("أجرة التوصيل في عملية مستقلة");
    expect(host.textContent).not.toContain("البضاعة والأجرة في عملية واحدة");
    const proof = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("تأكيد نجاح الدفع لدى المزوّد"),
    );
    act(() => proof!.click());
    expect(confirmFee).toHaveBeenCalledOnce();
    const save = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "تثبيت الدفعات وطباعة",
    );
    expect(save?.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});
