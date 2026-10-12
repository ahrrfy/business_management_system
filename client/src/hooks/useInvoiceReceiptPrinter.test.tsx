// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterOutputs } from "@/lib/trpc";
import type { Receipt } from "@/components/pos/posShared";

const mocks = vi.hoisted(() => ({ first: vi.fn(), reprint: vi.fn(), transport: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { invoicePrinting: {
  requestPrint: { useMutation: () => ({ mutateAsync: mocks.first }) },
  requestReprint: { useMutation: () => ({ mutateAsync: mocks.reprint }) },
} } }));
vi.mock("@/lib/offline/db", () => ({ getMeta: vi.fn(), setMeta: vi.fn() }));
vi.mock("@/lib/printing/print", () => ({ printReceipt: mocks.transport }));
vi.mock("@/lib/printing/brand", () => ({ releaseReservedPrintWindow: vi.fn() }));
vi.mock("@/components/pos/posShared", () => ({ buildBrandedReceipt: (value: unknown) => value }));
import { useInvoiceReceiptPrinter } from "./useInvoiceReceiptPrinter";

afterEach(() => { vi.clearAllMocks(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe("actual receipt printer authorization retry", () => {
  it("prevents thermal, A4 and shipping transports when fresh authorization rejects their selected operations", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const user = { id: 9011, role: "manager", operationPolicyEnabled: true,
      resolvedOperationPolicy: { version: 1, grants: {} },
    } as RouterOutputs["auth"]["me"];
    mocks.first.mockRejectedValue(new Error("FORBIDDEN"));
    mocks.reprint.mockRejectedValue(new Error("FORBIDDEN"));
    const render = vi.fn();
    let printer: ReturnType<typeof useInvoiceReceiptPrinter>;
    function Harness() { printer = useInvoiceReceiptPrinter(user, user?.id); return null; }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness />));
      await expect(printer!.printAuthorizedReceiptData({ invoiceId: 9050 } as never)).rejects.toThrow("FORBIDDEN");
      await expect(printer!.printAuthorizedDocument(9051, "A4", true, render)).rejects.toThrow("FORBIDDEN");
      await expect(printer!.printAuthorizedDocument(9052, "SHIPPING_LABEL", true, render)).rejects.toThrow("FORBIDDEN");
      expect(mocks.transport).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(mocks.first.mock.calls[0][0]).toMatchObject({ invoiceId: 9050, purpose: "THERMAL" });
      expect(mocks.reprint.mock.calls.map((args) => args[0].invoiceId)).toEqual([9051, 9052]);
    } finally { await act(async () => root.unmount()); }
  });
  it("authorizes each real invoice in a paired receipt separately and retains a thrown-render attempt", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const user = { id: 9012, role: "cashier", operationPolicyEnabled: true,
      resolvedOperationPolicy: { version: 1, grants: { "operation.invoicePrinting.requestPrint": true } },
    } as RouterOutputs["auth"]["me"];
    mocks.first.mockResolvedValue({ authorized: true });
    mocks.transport.mockResolvedValue({ ok: true, via: "browser" });
    let printer: ReturnType<typeof useInvoiceReceiptPrinter>;
    function Harness() { printer = useInvoiceReceiptPrinter(user, user?.id); return null; }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Harness />));
      await printer!.printAuthorizedReceiptData({ invoiceId: 9060 } as never);
      await printer!.printAuthorizedReceiptData({ invoiceId: 9061 } as never);
      expect(mocks.first.mock.calls.map((args) => args[0].invoiceId)).toEqual([9060, 9061]);
      mocks.transport.mockRejectedValueOnce(new Error("transport-lost"));
      await expect(printer!.printAuthorizedReceiptData({ invoiceId: 9062 } as never)).rejects.toThrow("transport-lost");
      await printer!.printAuthorizedReceiptData({ invoiceId: 9062 } as never, true);
      expect(mocks.first.mock.calls[2][0].requestId).toBe(mocks.first.mock.calls[3][0].requestId);
      expect(mocks.reprint).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); }
  });
  it("retries a failed FIRST print with the same authorization even when REPRINT is denied", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const user = { id: 9007, role: "cashier", operationPolicyEnabled: true,
      resolvedOperationPolicy: { version: 1, grants: { "operation.invoicePrinting.requestPrint": true, "operation.invoicePrinting.requestReprint": false } },
    } as RouterOutputs["auth"]["me"];
    const receipt = { invoiceId: 9042 } as Receipt;
    mocks.first.mockResolvedValue({ authorized: true });
    mocks.reprint.mockRejectedValue(new Error("FORBIDDEN"));
    mocks.transport.mockResolvedValueOnce({ ok: false, via: "browser" }).mockResolvedValueOnce({ ok: true, via: "browser" });
    let printer: ReturnType<typeof useInvoiceReceiptPrinter>;
    function Harness() { printer = useInvoiceReceiptPrinter(user, user?.id); return null; }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      expect(await printer!.printAuthorizedReceipt(receipt)).toMatchObject({ ok: false });
      expect(await printer!.printAuthorizedReceipt(receipt, true)).toMatchObject({ ok: true });
      expect(mocks.first).toHaveBeenCalledTimes(2);
      expect(mocks.first.mock.calls[0][0].requestId).toBe(mocks.first.mock.calls[1][0].requestId);
      expect(mocks.reprint).not.toHaveBeenCalled();
      await expect(printer!.printAuthorizedReceipt(receipt, true)).rejects.toThrow("FORBIDDEN");
      expect(mocks.transport).toHaveBeenCalledTimes(2);
    } finally { await act(async () => root.unmount()); }
  });
});
