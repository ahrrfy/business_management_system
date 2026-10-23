// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  invoices: {} as Record<string, any>,
  policies: {} as Record<number, any>,
  execute: vi.fn(),
  printed: vi.fn(),
  withdraw: vi.fn(),
  refetch: vi.fn(async () => ({})),
}));
vi.mock("@/hooks/useOperationPermission", () => ({
  useOperationPermission: () => ({ allowed: true, reason: "" }),
}));
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: unknown) => value,
}));
vi.mock("@/components/invoice/ProductSearchBar", () => ({
  ProductSearchBar: (props: any) => (
    <button
      type="button"
      onClick={() =>
        props.onAddProduct({
          variantId: 1,
          productUnitId: 1,
          name: "دفتر",
          price: "500",
          qty: 1,
          conversionFactor: 1,
          unit: "قطعة",
          barcode: "DUP",
        })
      }
    >
      إضافة صنف اختبار
    </button>
  ),
}));
vi.mock("./printThermalReturnReceipt", () => ({
  printSalesReturnReceipt: (...args: unknown[]) => state.printed(...args),
}));
vi.mock("@/lib/notify", () => ({
  notify: { ok: vi.fn(), warn: vi.fn(), err: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      returns: {
        inspectInvoiceForReturn: {
          fetch: async ({ invoiceNumber }: any) =>
            state.invoices[invoiceNumber],
        },
      },
    }),
    auth: {
      me: {
        useQuery: () => ({ data: { id: 7, role: "cashier", branchId: 2 } }),
      },
    },
    branches: { list: { useQuery: () => ({ data: [{ id: 2 }] }) } },
    customers: { smartSearch: { useQuery: () => ({ data: [] }) } },
    returns: {
      inspectInvoiceForReturn: {
        useQuery: ({ invoiceNumber }: any) => ({
          data: state.invoices[invoiceNumber],
        }),
      },
      getOpenRefundDrawers: {
        useQuery: () => ({ data: [], refetch: state.refetch }),
      },
      getInvoice: {
        useQuery: ({ invoiceId }: any) => ({
          data: state.policies[invoiceId],
          refetch: state.refetch,
        }),
      },
      executeSalesReturnCart: {
        useMutation: () => ({ isPending: false, mutateAsync: state.execute }),
      },
      withdrawRequest: {
        useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
      },
    },
    salesControl: {
      withdraw: {
        useMutation: () => ({
          isPending: false,
          mutateAsync: async (input: any) => {
            state.withdraw(input);
            for (const value of Object.values(state.policies))
              value.pendingRequest = null;
          },
        }),
      },
    },
  },
}));
import { SalesReturnPortal } from "./SalesReturnPortal";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("main return portal unpaid invoices", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  function fixture(id = 11, customerId: number | null = null) {
    return {
      id,
      invoiceNumber: `INV-${id}`,
      status: "PENDING",
      isDead: false,
      isFullyReturned: false,
      isOtherBranch: false,
      branchId: 2,
      customerId,
      customerName: customerId ? "عميل مسجل" : "عميل نقدي",
      customerPhone: customerId ? "07712345678" : null,
      total: "1000",
      paidAmount: "0",
      returnedTotal: "0",
      unpaidAmount: "1000",
      remainingInvoiceTotal: "1000",
      maxRefundable: "0",
      maxCreditOffsetAmount: "1000",
      refundablePaidAmount: "0",
      sourcePaidAmountIqd: "0",
      previousReturns: [],
      items: [
        {
          invoiceItemId: id + 1,
          variantId: 1,
          productUnitId: 1,
          remainingQuantity: 2,
          baseQuantity: 2,
          returnedBaseQuantity: 0,
          productName: "دفتر",
          unitPrice: "500",
          effectiveUnitPrice: "500",
          remainingLineTotal: "1000",
          conversionFactor: 1,
          unitName: "قطعة",
        },
      ],
    };
  }
  beforeEach(() => {
    state.invoices = { "INV-11": fixture() };
    state.policies = {
      11: {
        id: 11,
        branchId: 2,
        sourcePaidAmountIqd: "0",
        pendingRequest: null,
      },
    };
    state.execute.mockReset().mockResolvedValue({
      returnNumber: "RET-44",
      originalInvoiceNumber: "INV-11",
      customerName: "عميل نقدي",
      disposition: "RESTOCK",
      method: "CREDIT_OFFSET",
      totalAmount: "1000",
      items: [{ name: "دفتر", quantity: 2, unitPrice: "500" }],
      noCashNoAccount: true,
      payoutAmount: "0.00",
      debtOffsetAmount: "1000.00",
    });
    state.printed.mockClear();
    state.withdraw.mockClear();
    client = new QueryClient();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    client.clear();
  });
  async function render(invoiceNumber = "INV-11") {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SalesReturnPortal
            initialInvoiceNo={invoiceNumber}
            initialMode="FULL"
            onReturnSuccess={vi.fn()}
          />
        </QueryClientProvider>,
      ),
    );
  }
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((element) =>
      element.textContent?.includes(text),
    ) as HTMLButtonElement | undefined;
  async function execute() {
    await act(async () =>
      (button("استعادة نتيجة المرتجع السابق") ??
        button("تأكيد المرتجع وطباعة الإيصال"))!.click(),
    );
  }

  it("returns an unpaid walk-in invoice without a drawer or invented customer and preserves printing", async () => {
    await render();
    await execute();
    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.execute.mock.calls[0][0]).toMatchObject({
      invoiceNumber: "INV-11",
      settlement: {
        method: "CREDIT_OFFSET",
        totalAmount: "1000",
        shiftId: undefined,
      },
    });
    expect(state.execute.mock.calls[0][0].customer.customerId).toBeUndefined();
    expect(state.printed).toHaveBeenCalledWith(
      expect.objectContaining({
        noCashNoAccount: true,
        payoutAmount: "0.00",
        debtOffsetAmount: "1000.00",
      }),
    );
  });
  it("keeps the full-invoice cart editable while a decimal price is incomplete", async () => {
    await render();
    const input = host.querySelector<HTMLInputElement>(
      '[aria-label="سعر الوحدة"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, ".");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('[aria-label="سعر الوحدة"]')).not.toBeNull();
    expect(button("تأكيد المرتجع وطباعة الإيصال")!.disabled).toBe(true);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("selects the returnable duplicate invoice line when the first matching variant is exhausted", async () => {
    const item = state.invoices["INV-11"].items[0];
    state.invoices["INV-11"].items = [
      { ...item, remainingQuantity: 0 },
      { ...item, invoiceItemId: 13 },
    ];
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SalesReturnPortal
            initialInvoiceNo="INV-11"
            initialMode="PARTIAL"
            onReturnSuccess={vi.fn()}
          />
        </QueryClientProvider>,
      ),
    );
    act(() => button("إضافة صنف اختبار")!.click());
    await execute();
    expect(state.execute.mock.calls[0][0].items).toEqual([
      expect.objectContaining({ invoiceItemId: 13, quantity: 1 }),
    ]);
  });
  it("refreshes the inspected total after an external invoice change without recreating the cart", async () => {
    await render();
    state.invoices["INV-11"] = {
      ...state.invoices["INV-11"],
      remainingInvoiceTotal: "1200",
      unpaidAmount: "1200",
      maxCreditOffsetAmount: "1200",
    };
    await render();
    await execute();
    expect(state.execute.mock.calls[0][0].settlement.totalAmount).toBe("1200");
  });
  it("blocks a cart whose quantities were returned by another device until it is reviewed", async () => {
    await render();
    const previous = state.invoices["INV-11"];
    state.invoices["INV-11"] = {
      ...previous,
      returnedTotal: "500",
      remainingInvoiceTotal: "500",
      maxCreditOffsetAmount: "500",
      items: [
        {
          ...previous.items[0],
          remainingQuantity: 1,
          remainingLineTotal: "500",
        },
      ],
    };
    await render();
    expect(button("تأكيد المرتجع وطباعة الإيصال")!.disabled).toBe(true);
    expect(host.textContent).toContain("تغيّرت بنود الفاتورة");
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("reuses the same intent key after a transport error", async () => {
    state.execute.mockRejectedValueOnce(new Error("Failed to fetch"));
    await render();
    await execute();
    await execute();
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[0][0].clientRequestId).toBe(
      state.execute.mock.calls[1][0].clientRequestId,
    );
  });
  it("recovers a committed return after a lost reply and live full-return refresh using the exact intent", async () => {
    state.execute.mockRejectedValueOnce(new Error("Failed to fetch"));
    await render();
    await execute();
    const intent = state.execute.mock.calls[0][0];
    state.invoices["INV-11"] = {
      ...state.invoices["INV-11"],
      status: "RETURNED",
      isDead: true,
      isFullyReturned: true,
      remainingInvoiceTotal: "0",
      maxCreditOffsetAmount: "0",
      items: [],
    };
    await render();
    expect(button("تأكيد المرتجع وطباعة الإيصال")).toBeUndefined();
    await execute();
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.execute.mock.calls[1][0]).toEqual(intent);
    expect(state.printed).toHaveBeenCalledOnce();
  });
  it("clears a committed cart while background financial refresh is slow", async () => {
    vi.spyOn(client, "invalidateQueries").mockImplementation(
      () => new Promise(() => {}),
    );
    await render();
    await execute();
    expect(state.execute).toHaveBeenCalledOnce();
    expect(button("تأكيد المرتجع وطباعة الإيصال")!.disabled).toBe(true);
    expect(host.textContent).not.toContain("(المتبقي بالفاتورة: 2)");
  });
  it("clears a previous registered customer's identity when switching to a walk-in invoice", async () => {
    state.invoices["INV-22"] = fixture(22, 8);
    state.policies[22] = {
      id: 22,
      branchId: 2,
      sourcePaidAmountIqd: "0",
      pendingRequest: null,
    };
    await render("INV-22");
    await render("INV-11");
    await execute();
    expect(state.execute.mock.calls[0][0].customer).toMatchObject({
      customerId: undefined,
      phone: undefined,
    });
  });
  it("blocks a pending request until its owner explicitly withdraws it", async () => {
    state.policies[11].pendingRequest = {
      source: "CONTROL",
      id: 44,
      isMine: true,
      requestedBy: 7,
      reason: "طلب سابق",
    };
    await render();
    expect(button("تأكيد المرتجع وطباعة الإيصال")!.disabled).toBe(true);
    expect(button("سحب طلبي")).toBeDefined();
    await act(async () => button("سحب طلبي")!.click());
    expect(state.withdraw).toHaveBeenCalledWith({
      requestId: 44,
      reason: expect.any(String),
    });
  });
  it("includes invoice delivery and rounding residue when all remaining quantities are selected", async () => {
    state.invoices["INV-11"] = {
      ...state.invoices["INV-11"],
      total: "1200",
      unpaidAmount: "1200",
      remainingInvoiceTotal: "1200",
      maxCreditOffsetAmount: "1200",
    };
    await render();
    await execute();
    expect(state.execute.mock.calls[0][0].settlement.totalAmount).toBe("1200");
  });
  it("returns unremitted COD custody without requesting cash from an empty store drawer", async () => {
    state.invoices["INV-11"] = {
      ...state.invoices["INV-11"],
      status: "PAID",
      paidAmount: "1000",
      unpaidAmount: "0",
      maxCreditOffsetAmount: "1000",
      sourcePaidAmountIqd: "1000",
    };
    state.policies[11].sourcePaidAmountIqd = "1000";
    await render();
    await execute();
    expect(state.execute.mock.calls[0][0].settlement.method).toBe(
      "CREDIT_OFFSET",
    );
  });
  it("keeps partial unpaid selection available without customer or drawer", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SalesReturnPortal
            initialInvoiceNo="INV-11"
            initialMode="PARTIAL"
            onReturnSuccess={vi.fn()}
          />
        </QueryClientProvider>,
      ),
    );
    act(() =>
      [...host.querySelectorAll("button")]
        .find((element) => element.textContent === "إضافة")!
        .click(),
    );
    await execute();
    expect(state.execute.mock.calls[0][0]).toMatchObject({
      items: [{ quantity: 1 }],
      settlement: { method: "CREDIT_OFFSET", totalAmount: "500" },
    });
  });
  it("does not offer withdrawal of another employee's pending request", async () => {
    state.policies[11].pendingRequest = {
      source: "CONTROL",
      id: 44,
      isMine: false,
      requestedBy: 9,
      reason: "طلب آخر",
    };
    await render();
    expect(button("تأكيد المرتجع وطباعة الإيصال")!.disabled).toBe(true);
    expect(button("سحب طلبي")).toBeUndefined();
  });
});
