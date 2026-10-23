// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useVoucherFormShortcuts } from "../useVoucherFormShortcuts";
import { voucherInvoiceEligible } from "../voucherInvoiceAllocation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("voucher editor behavior", () => {
  it("submits the latest delivery party and card digits without rebinding the keyboard listener", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const save = vi.fn();
    function Harness({
      partyId,
      digits,
    }: {
      partyId: number | null;
      digits: string;
    }) {
      useVoucherFormShortcuts({
        isReceipt: true,
        submit: (mode) => save({ partyId, digits, mode }),
        requestCancel: vi.fn(),
      });
      return null;
    }
    try {
      act(() => root.render(<Harness partyId={null} digits="" />));
      act(() => root.render(<Harness partyId={42} digits="1234" />));
      act(() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: true,
            cancelable: true,
          }),
        ),
      );
      expect(save).toHaveBeenLastCalledWith({
        partyId: 42,
        digits: "1234",
        mode: null,
      });
      act(() => root.render(<Harness partyId={53} digits="9876" />));
      act(() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            cancelable: true,
          }),
        ),
      );
      expect(save).toHaveBeenLastCalledWith({
        partyId: 53,
        digits: "9876",
        mode: "thermal",
      });
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it.each(["RETURNED", "CANCELLED", "SUPERSEDED"] as const)(
    "allows allocated money to leave a %s invoice while preventing new collection",
    (status) => {
      expect(voucherInvoiceEligible({ status, paidAmount: "500" }, "OUT")).toBe(
        true,
      );
      expect(voucherInvoiceEligible({ status, paidAmount: "500" }, "IN")).toBe(
        false,
      );
      expect(voucherInvoiceEligible({ status, paidAmount: "0" }, "OUT")).toBe(
        false,
      );
    },
  );
});
