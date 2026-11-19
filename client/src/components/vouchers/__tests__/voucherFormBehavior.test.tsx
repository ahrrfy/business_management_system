// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { D } from "@/lib/money";
import { QuickVoucherSheet } from "../QuickVoucherSheet";
import { VoucherBalanceImpactCard } from "../VoucherBalanceImpactCard";
import { VoucherErrorRecoveryBanner } from "../VoucherErrorRecoveryBanner";
import { useVoucherFormShortcuts } from "../useVoucherFormShortcuts";
import { voucherInvoiceEligible } from "../voucherInvoiceAllocation";

const sheetMock = vi.hoisted(() => ({ formProps: [] as Array<Record<string, unknown>> }));
vi.mock("../VoucherFormShared", () => ({
  default: (props: Record<string, unknown>) => {
    sheetMock.formProps.push(props);
    return <div data-testid="embedded-voucher-form">{String(props.voucherType)}</div>;
  },
}));
vi.mock("wouter", () => ({
  Link: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

function renderIntoHost(node: React.ReactElement, assertions: (host: HTMLDivElement) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(node));
    assertions(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

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

  it("renders live balance impact with independent USD reference badge and pending reservation", () => {
    renderIntoHost(
      <VoucherBalanceImpactCard
        direction="OUT"
        partyType="SUPPLIER"
        amountDec={D("200.00")}
        method="CASH"
        treasuryNotice={false}
        awaitsOwnerDisbursement={true}
        supplierBalance="500.00"
        supplierBalanceUsd="200.00"
        pendingReserved="100.00"
      />,
      (host) => {
        const text = host.textContent ?? "";
        expect(text).toContain("أثر السند ومصدر النقد");
        expect(text).toContain("مرجع الدولار المستقل");
        expect(text).toContain("$200.00");
        expect(text).toContain("500");
        expect(text).toContain("300");
        expect(text).toContain("100");
        expect(text).toContain("طلب صرف");
      },
    );
    renderIntoHost(
      <VoucherBalanceImpactCard
        direction="OUT"
        partyType="SUPPLIER"
        amountDec={D("0")}
        method="CASH"
        treasuryNotice={false}
        awaitsOwnerDisbursement={false}
        supplierBalance="500.00"
      />,
      (host) => {
        const badge = Array.from(host.querySelectorAll('[data-slot="badge"]')).find((el) =>
          el.textContent?.includes("طلب صرف"),
        );
        expect(badge).toBeTruthy();
        expect(badge?.className).toContain("badge-stock-low");
        expect(badge?.className).not.toContain("badge-status-active");
      },
    );
  });

  it("offers guided recovery buttons for supplier overpay, advance-refund switch, and missing cash shift", () => {
    const onEnableSupplierOverpay = vi.fn();
    const onApplySuggestedAmount = vi.fn();
    const onSwitchSupplierCreditMode = vi.fn();
    const onSwitchMethod = vi.fn();
    renderIntoHost(
      <VoucherErrorRecoveryBanner
        err="المبلغ أكبر من المستحق للمورد"
        direction="OUT"
        partyType="SUPPLIER"
        customerId={null}
        supplierId={14}
        invoiceId={null}
        method="CASH"
        amountDec={D("450.00")}
        supplierBalance="300.00"
        supplierReceiptPurpose="CREDIT_OBLIGATION"
        allowSupplierOverpay={false}
        onEnableSupplierOverpay={onEnableSupplierOverpay}
        onApplySuggestedAmount={onApplySuggestedAmount}
        onClearInvoice={vi.fn()}
        onSwitchMethod={onSwitchMethod}
        onSwitchSupplierCreditMode={onSwitchSupplierCreditMode}
      />,
      (host) => {
        const buttons = Array.from(host.querySelectorAll("button"));
        buttons.find((b) => b.textContent?.includes("السماح بالسلفة"))?.click();
        buttons.find((b) => b.textContent?.includes("تحديد المبلغ بحد المستحق"))?.click();
        expect(onEnableSupplierOverpay).toHaveBeenCalledTimes(1);
        expect(onApplySuggestedAmount).toHaveBeenCalledWith("300.00");
        expect(host.querySelectorAll("a button, button a")).toHaveLength(0);
        expect(host.querySelector('a[data-slot="button"][href="/suppliers-statement?id=14"]')).toBeTruthy();
      },
    );
    renderIntoHost(
      <VoucherErrorRecoveryBanner
        err="لا توجد وردية مفتوحة لدرج الكاشير"
        direction="IN"
        partyType="SUPPLIER"
        customerId={null}
        supplierId={14}
        invoiceId={null}
        method="CASH"
        amountDec={D("100.00")}
        supplierBalance="0.00"
        supplierReceiptPurpose="ADVANCE_REFUND"
        onApplySuggestedAmount={vi.fn()}
        onClearInvoice={vi.fn()}
        onSwitchMethod={onSwitchMethod}
        onSwitchSupplierCreditMode={onSwitchSupplierCreditMode}
      />,
      (host) => {
        const buttons = Array.from(host.querySelectorAll("button"));
        buttons.find((b) => b.textContent?.includes("قبض يرفع حساب المورد"))?.click();
        buttons.find((b) => b.textContent?.includes("تحويل"))?.click();
        expect(onSwitchSupplierCreditMode).toHaveBeenCalledTimes(1);
        expect(onSwitchMethod).toHaveBeenCalledWith("TRANSFER");
      },
    );
  });

  it("forwards default party, amount, and balance snapshot props from QuickVoucherSheet into embedded VoucherFormShared", () => {
    sheetMock.formProps.length = 0;
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    renderIntoHost(
      <QuickVoucherSheet
        open={true}
        onOpenChange={onOpenChange}
        defaultType="PAYMENT"
        defaultPartyType="SUPPLIER"
        defaultPartyId={9}
        defaultPartyName="مورد الاختبار"
        defaultAmount="250.00"
        currentBalance="500.00"
        pendingReserved="100.00"
        onSuccess={onSuccess}
      />,
      (host) => {
        expect(host.textContent).toContain("سند صرف سريع");
        expect(host.textContent).toContain("مورد الاختبار");
        const props = sheetMock.formProps[0];
        expect(props).toMatchObject({
          voucherType: "PAYMENT",
          embedded: true,
          initialPartyType: "SUPPLIER",
          initialPartyId: 9,
          initialAmount: "250.00",
          initialCurrentBalance: "500.00",
          initialPendingReserved: "100.00",
        });
        act(() => {
          (props.onSubmitted as () => void)();
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onSuccess).toHaveBeenCalledTimes(1);
      },
    );
  });
});
