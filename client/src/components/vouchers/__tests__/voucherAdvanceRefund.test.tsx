// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoucherForm, type VoucherFormModel } from "../useVoucherForm";
import { SupplierAdvanceRefundFields } from "../VoucherFormShared";

const mock = vi.hoisted(() => ({
  mutate: vi.fn(),
  confirm: vi.fn(async () => true),
  queryInputs: [] as unknown[],
  sources: {
    data: [
      {
        id: 71,
        voucherNumber: "PV-71",
        paymentMethod: "CARD",
        amount: "150.00",
        remainingAmount: "150.00",
        unusedAmount: "50.00",
      },
    ] as
      | Array<{
          id: number;
          voucherNumber: string | null;
          paymentMethod: string;
          amount: string;
          remainingAmount: string;
          unusedAmount: string;
        }>
      | undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null as { message: string } | null,
    refetch: vi.fn(),
  },
}));
function proxy(path = ""): unknown {
  return new Proxy(() => undefined, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      const next = path ? `${path}.${key}` : key;
      if (next === "useUtils") return () => proxy("utils");
      if (path.startsWith("utils") && key === "invalidate")
        return vi.fn(async () => undefined);
      if (next === "vouchers.supplierAdvanceRefundSources.useQuery")
        return (input: unknown) => {
          mock.queryInputs.push(input);
          return mock.sources;
        };
      if (key === "useQuery")
        return () => ({
          data:
            path === "auth.me"
              ? { id: 7, role: "manager", isOwner: true }
              : path === "shifts.current"
                ? { id: 33 }
                : path === "suppliers.get" || path === "customers.get"
                  ? { id: 1, name: "طرف السند", currentBalance: "-150.00" }
                  : [],
          isLoading: false,
          isError: false,
        });
      if (key === "useMutation")
        return () => ({
          mutate:
            next === "vouchers.create.useMutation" ? mock.mutate : vi.fn(),
          mutateAsync: vi.fn(),
          isPending: false,
        });
      return proxy(next);
    },
  });
}
vi.mock("@/lib/trpc", () => ({ trpc: proxy() }));
vi.mock("wouter", () => ({
  useLocation: () => ["/vouchers/receipt/new", vi.fn()],
  useSearch: () => "",
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/useSessionContext", () => ({
  useSessionContext: () => ({ context: { businessDay: "2026-10-26" } }),
}));
vi.mock("@/hooks/usePrintAudit", () => ({ usePrintAudit: () => ({}) }));
vi.mock("@/hooks/useUnsavedGuard", () => ({
  useUnsavedGuard: vi.fn(),
  bypassUnsavedGuard: vi.fn(),
}));
vi.mock("@/lib/treasuryOperationAccess", () => ({
  treasuryOperationAllowed: () => true,
}));
vi.mock("@/lib/confirm", () => ({ confirm: mock.confirm }));
vi.mock("@/lib/notify", () => ({
  notify: { ok: vi.fn(), err: vi.fn(), warn: vi.fn() },
}));
vi.mock("../useVoucherPrintAfterCreate", () => ({
  useVoucherPrintAfterCreate: () => ({
    pendingPrintRef: null,
    setPendingPrintRef: vi.fn(),
    tryPrintAfterCreate: vi.fn(),
  }),
}));
vi.mock("../VoucherPaymentFields", () => ({
  VoucherPaymentFields: () => null,
}));
vi.mock("../VoucherPartyAllocationFields", () => ({
  VoucherPartyAllocationFields: () => null,
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({
    children,
    value,
    onValueChange,
    ...props
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select
      {...props}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
}));

let root: Root, host: HTMLDivElement, model: VoucherFormModel;
function Harness({
  voucherType = "RECEIPT",
}: {
  voucherType?: "RECEIPT" | "PAYMENT";
}) {
  model = useVoucherForm({ voucherType });
  return <SupplierAdvanceRefundFields model={model} />;
}
async function render(voucherType: "RECEIPT" | "PAYMENT" = "RECEIPT") {
  await act(async () => root.render(<Harness voucherType={voucherType} />));
}
async function supplier() {
  await act(async () => {
    model.setBranchId(1);
    model.setPartyType("SUPPLIER");
    model.setSupplierId(1);
    model.setAmount("10");
    model.setDescription("استرداد جزء من دفعة المورد");
    model.setVoucherDate("2026-10-26");
  });
}
async function select() {
  const field = host.querySelector<HTMLSelectElement>(
    '[aria-label="الدفعة السابقة المستردة"]',
  )!;
  await act(async () => {
    field.value = "71";
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
  mock.mutate.mockClear();
  mock.confirm.mockClear();
  mock.queryInputs.length = 0;
  mock.sources.data = [
    {
      id: 71,
      voucherNumber: "PV-71",
      paymentMethod: "CARD",
      amount: "150.00",
      remainingAmount: "150.00",
      unusedAmount: "50.00",
    },
  ];
  mock.sources.isLoading = false;
  mock.sources.isFetching = false;
  mock.sources.isError = false;
  mock.sources.error = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("supplier advance refund source binding", () => {
  it("requires an explicit source and submits its identity with the actual refund rail", async () => {
    await supplier();
    expect(model.supplierAdvanceRefundReceiptId).toBeNull();
    await act(async () => model.submit());
    expect(mock.mutate).not.toHaveBeenCalled();
    expect(mock.confirm).not.toHaveBeenCalled();
    await select();
    expect(host.textContent).toContain("PV-71");
    expect(host.textContent).toContain("طريقة الدفعة الأصلية");
    expect(host.textContent).toContain("طريقة الاسترداد الفعلية");
    expect(model.method).toBe("CASH");
    await act(async () => model.submit());
    expect(mock.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        voucherType: "RECEIPT",
        partyType: "SUPPLIER",
        partyId: 1,
        supplierAdvanceRefundReceiptId: 71,
        paymentMethod: "CASH",
        amount: "10",
      }),
    );
  });
  it.each(["branch", "supplier", "party", "direction"] as const)(
    "clears a selected source on %s change",
    async (scope) => {
      await supplier();
      await select();
      if (scope === "direction") await render("PAYMENT");
      else
        await act(async () => {
          if (scope === "branch") model.setBranchId(2);
          if (scope === "supplier") model.setSupplierId(2);
          if (scope === "party") {
            model.setPartyType("CUSTOMER");
            model.setCustomerId(3);
          }
        });
      expect(model.supplierAdvanceRefundReceiptId).toBeNull();
      expect(model.buildPayload()).not.toHaveProperty(
        "supplierAdvanceRefundReceiptId",
      );
    },
  );
  it("blocks amounts above refundable money and warns before reopening linked invoices", async () => {
    await supplier();
    await select();
    await act(async () => model.setAmount("60"));
    expect(model.supplierAdvanceRefundBlocked).toBe(false);
    expect(model.supplierAdvanceRefundWarning).toContain("فتح ذمة");
    await act(async () => model.setAmount("150.01"));
    expect(model.supplierAdvanceRefundBlocked).toBe(true);
    expect(model.validate()).toContain("يتجاوز المتبقي");
  });
  it("retains the current refund method's own card and transfer evidence checks", async () => {
    await supplier();
    await select();
    await act(async () => model.setMethod("CARD"));
    expect(model.validate()).toContain("آخر 4");
    await act(async () => model.setCardLastFour("9876"));
    expect(model.validate()).toBe("");
    await act(async () => model.setMethod("TRANSFER"));
    expect(model.validate()).toContain("الرقم المرجعي");
    await act(async () => model.setReferenceNumber("ACTUAL-REFUND-TRANSFER"));
    expect(model.buildPayload()).toMatchObject({
      supplierAdvanceRefundReceiptId: 71,
      paymentMethod: "TRANSFER",
      referenceNumber: "ACTUAL-REFUND-TRANSFER",
    });
  });
  it("blocks unavailable or loading evidence and displays the backend's actionable error", async () => {
    await supplier();
    mock.sources.isError = true;
    mock.sources.error = {
      message: "المصدر التاريخي ملتبس؛ راجع السند وتخصيصاته",
    };
    await render();
    expect(host.textContent).toContain("المصدر التاريخي ملتبس");
    expect(model.supplierAdvanceRefundBlocked).toBe(true);
    await act(async () => model.submit());
    expect(mock.mutate).not.toHaveBeenCalled();
    mock.sources.isError = false;
    mock.sources.isLoading = true;
    mock.sources.data = undefined;
    await render();
    expect(model.supplierAdvanceRefundBlocked).toBe(true);
  });
  it("keeps ordinary customer receipts and supplier receipts with no advances unchanged", async () => {
    await supplier();
    mock.sources.data = [];
    await render();
    expect(model.supplierAdvanceRefundBlocked).toBe(false);
    expect(host.textContent).toBe("");
    expect(model.validate()).toBe("");
    await act(async () => {
      model.setPartyType("CUSTOMER");
      model.setCustomerId(3);
    });
    mock.sources.isError = true;
    mock.sources.error = { message: "supplier-only query failure" };
    await render();
    expect(model.supplierAdvanceRefundBlocked).toBe(false);
    expect(model.validate()).toBe("");
    expect(model.buildPayload()).not.toHaveProperty(
      "supplierAdvanceRefundReceiptId",
    );
  });
});
