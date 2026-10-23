// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  invoice: {} as any,
  owner: false,
  direct: false,
  railAllowed: false,
  mutation: vi.fn(),
  withdraw: vi.fn(),
  legacyWithdraw: vi.fn(),
  rails: vi.fn(),
  invalidate: vi.fn(async () => {}),
  enqueue: vi.fn(async () => true),
  pending: false,
}));
vi.mock("@/hooks/useOperationPermission", () => ({
  useOperationPermission: (path: string) => ({
    allowed:
      path === "returns.direct"
        ? state.direct
        : path === "refundRails.preflight"
          ? state.railAllowed
          : true,
    reason: "غير مفوض",
  }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      returns: {
        getInvoice: { invalidate: state.invalidate },
        requests: { invalidate: state.invalidate },
      },
      salesControl: { list: { invalidate: state.invalidate } },
      decisions: { inbox: { invalidate: state.invalidate } },
    }),
    auth: {
      me: {
        useQuery: () => ({
          data: { id: 7, role: "cashier", isOwner: state.owner },
        }),
      },
    },
    returns: {
      getInvoice: { useQuery: () => ({ data: state.invoice }) },
      getRequest: { useQuery: () => ({ data: undefined }) },
      create: {
        useMutation: (options: any) => ({
          isPending: state.pending,
          mutate: (input: unknown) => state.mutation(input, options),
        }),
      },
      approveRequest: {
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
      },
      withdrawRequest: {
        useMutation: (options: any) => ({
          isPending: false,
          mutateAsync: async (input: unknown) => {
            state.legacyWithdraw(input);
            state.invoice = { ...state.invoice, pendingRequest: null };
            await options.onSuccess();
          },
        }),
      },
    },
    salesControl: {
      withdraw: {
        useMutation: (options: any) => ({
          isPending: false,
          mutateAsync: async (input: unknown) => {
            state.withdraw(input);
            state.invoice = { ...state.invoice, pendingRequest: null };
            await options.onSuccess();
          },
        }),
      },
    },
  },
}));
vi.mock("@/components/ui/RefundRailPicker", () => ({
  RefundRailPicker: (props: any) => {
    state.rails(props);
    React.useEffect(
      () =>
        props.onStateChange({
          selection: { rail: "TREASURY" },
          loading: false,
          error: null,
          blockReason: null,
          preflight: { estimatedCashOut: props.context.amount },
        }),
      [props.context.amount],
    );
    return <span>مصدر الرد</span>;
  },
}));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/lib/notify", () => ({
  notify: { ok: vi.fn(), err: vi.fn(), info: vi.fn(), errBig: vi.fn() },
}));
vi.mock("@/lib/offline/outbox", () => ({
  isOfflineSaleEnabled: async () => true,
  assertCanCapture: async () => ({ ok: true }),
  allocateOfflineReceiptNumber: async () => "OFF-44",
  enqueueOfflineReturn: (...args: unknown[]) => state.enqueue(...args),
}));
import { ReturnComposer } from "./ReturnComposer";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("return form recovery", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    state.owner = false;
    state.direct = false;
    state.railAllowed = false;
    state.pending = false;
    state.enqueue.mockClear();
    state.mutation.mockClear();
    state.withdraw.mockClear();
    state.legacyWithdraw.mockClear();
    state.rails.mockClear();
    state.invoice = {
      id: 11,
      invoiceNumber: "INV-11",
      branchId: 2,
      status: "PENDING",
      subtotal: "1000",
      discountAmount: "0",
      taxAmount: "0",
      total: "1000",
      returnedTotal: "0",
      paidAmount: "0",
      sourcePaidAmountIqd: "0",
      refundablePaidAmount: "0",
      refundPool: "0",
      refundOptions: [
        { method: "CASH", cap: "0", blockedReason: "لا يوجد مقبوض" },
      ],
      refundShifts: [],
      pendingRequest: null,
      walkInResolutionPolicy: { required: true },
      items: [
        {
          invoiceItemId: 12,
          baseQuantity: 2,
          returnedBaseQuantity: 0,
          remaining: 2,
          total: "1000",
          unitPrice: "500",
          productName: "دفتر",
          unitName: "قطعة",
          conversionFactor: 1,
        },
      ],
    };
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
  function render() {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ReturnComposer invoiceId={11} initialMode="FULL" />
        </QueryClientProvider>,
      ),
    );
  }
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((element) =>
      element.textContent?.includes(text),
    );

  it("executes an unpaid return without a drawer permission or approval label", async () => {
    render();
    const execute = button("تنفيذ المرتجع الآن");
    expect(execute).toBeDefined();
    expect((execute as HTMLButtonElement).disabled).toBe(false);
    expect(state.rails).not.toHaveBeenCalled();
    await act(async () => execute!.click());
    expect(state.mutation.mock.calls[0][0]).toMatchObject({
      directExecution: true,
      resolution: { amount: "0.00" },
    });
  });

  it.each(["CONTROL", "LEGACY"])(
    "withdraws only the actor's explicit %s pending request then permits a fresh return",
    async (source) => {
      state.invoice = {
        ...state.invoice,
        pendingRequest: {
          source,
          id: 44,
          requestType: "SALES_RETURN",
          isMine: true,
          requestedBy: 7,
          reason: "طلب قديم",
        },
      };
      render();
      const withdraw = button("سحب طلبي");
      expect(withdraw).toBeDefined();
      await act(async () => withdraw!.click());
      expect(
        source === "CONTROL" ? state.withdraw : state.legacyWithdraw,
      ).toHaveBeenCalledWith({ requestId: 44, reason: expect.any(String) });
      expect((button("تنفيذ المرتجع الآن") as HTMLButtonElement).disabled).toBe(
        false,
      );
    },
  );

  it("keeps another actor's pending request blocked without a withdrawal action", () => {
    state.owner = true;
    state.invoice = {
      ...state.invoice,
      pendingRequest: {
        source: "CONTROL",
        id: 44,
        isMine: false,
        requestedBy: 9,
        reason: "طلب آخر",
      },
    };
    render();
    expect(button("سحب طلبي")).toBeUndefined();
    expect((button("تنفيذ المرتجع الآن") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (button("إرجاع سريع لكامل الفاتورة") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps an unpaid partial return executable after choosing its quantity", async () => {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ReturnComposer invoiceId={11} initialMode="PARTIAL" />
        </QueryClientProvider>,
      ),
    );
    const add = host.querySelector<HTMLButtonElement>(
      '[aria-label="زد كمية الإرجاع"]',
    )!;
    act(() => add.click());
    act(() => button("تراجع العميل عن الشراء")!.click());
    expect((button("تنفيذ المرتجع الآن") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(state.rails).not.toHaveBeenCalled();
  });

  it("honors a server-approved treasury rail for an owner with cashier base role and no personal shift", () => {
    state.owner = true;
    state.railAllowed = true;
    state.invoice = {
      ...state.invoice,
      paidAmount: "1000",
      sourcePaidAmountIqd: "1000",
      refundablePaidAmount: "1000",
      refundPool: "1000",
      refundOptions: [{ method: "CASH", cap: "1000", blockedReason: null }],
    };
    render();
    expect((button("تنفيذ المرتجع الآن") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  function paidRegisteredInvoice() {
    state.owner = true;
    state.railAllowed = true;
    state.invoice = {
      ...state.invoice,
      customerId: 20,
      walkInResolutionPolicy: null,
      paidAmount: "1000",
      sourcePaidAmountIqd: "1000",
      refundablePaidAmount: "1000",
      refundPool: "1000",
      refundOptions: [{ method: "CASH", cap: "1000", blockedReason: null }],
    };
  }
  it("keeps an incomplete refund editor mounted and prevents an accidental zero-refund submission", () => {
    paidRegisteredInvoice();
    render();
    const change = (raw: string) =>
      act(() => {
        const input = host.querySelector<HTMLInputElement>("#ret-amount")!;
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, raw);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    change("");
    expect(host.querySelector("#ret-amount")).not.toBeNull();
    expect((button("تنفيذ المرتجع الآن") as HTMLButtonElement).disabled).toBe(
      true,
    );
    change(".");
    expect(host.querySelector("#ret-amount")).not.toBeNull();
    change("500");
    expect((button("تنفيذ المرتجع الآن") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
  it("captures the submitted intent after a transport failure instead of the subsequently reset editor", async () => {
    paidRegisteredInvoice();
    render();
    await act(async () => button("تنفيذ المرتجع الآن")!.click());
    const [submission, options] = state.mutation.mock.calls.at(-1)!;
    const snapshot = options.onMutate(submission);
    act(() => button("إعادة ضبط")!.click());
    await act(async () => {
      options.onError(new Error("Failed to fetch"), submission, snapshot);
    });
    expect(state.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          invoiceId: submission.invoiceId,
          branchId: 2,
          lines: submission.lines,
          reason: submission.reason,
          clientRequestId: submission.clientRequestId,
          refund: { amount: "1000.00", method: "CASH" },
        }),
      }),
    );
  });
  it("locks quantity and reset controls while the submitted return is pending", async () => {
    paidRegisteredInvoice();
    render();
    await act(async () => button("تنفيذ المرتجع الآن")!.click());
    state.pending = true;
    render();
    expect(button("إعادة ضبط")!.matches(":disabled")).toBe(true);
    expect(
      host
        .querySelector('[aria-label="زد كمية الإرجاع"]')!
        .matches(":disabled"),
    ).toBe(true);
  });
  it("scans into an eligible duplicate line after an earlier line was fully returned", () => {
    const item = state.invoice.items[0];
    state.invoice.items = [
      { ...item, barcode: "DUP", remaining: 0, returnedBaseQuantity: 2 },
      { ...item, barcode: "DUP", invoiceItemId: 13 },
    ];
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ReturnComposer invoiceId={11} initialMode="PARTIAL" />
        </QueryClientProvider>,
      ),
    );
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <ReturnComposer
            invoiceId={11}
            initialMode="PARTIAL"
            scannedBarcode="DUP"
          />
        </QueryClientProvider>,
      ),
    );
    expect(
      host.querySelector<HTMLInputElement>(
        '[aria-label="كمية إرجاع دفتر بوحدة قطعة"]',
      )!.value,
    ).toBe("1");
  });

  it("preflights the resolved current invoice when scanning a superseded invoice", () => {
    state.owner = true;
    state.railAllowed = true;
    state.invoice = {
      ...state.invoice,
      id: 22,
      scannedInvoiceId: 11,
      scannedInvoiceNumber: "INV-11",
      paidAmount: "1000",
      sourcePaidAmountIqd: "1000",
      refundablePaidAmount: "1000",
      refundPool: "1000",
      refundOptions: [{ method: "CASH", cap: "1000", blockedReason: null }],
    };
    render();
    expect(state.rails.mock.calls.at(-1)![0].context.sourceDocId).toBe(22);
  });
});
