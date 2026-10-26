// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowDocumentPrinter } from "./useWorkflowDocumentPrinter";

const state = vi.hoisted(() => ({
  documents: [] as Array<Record<string, unknown>>,
  prepare: vi.fn(),
  request: vi.fn(),
  complete: vi.fn(),
  invalidate: vi.fn(),
  printDoc: vi.fn(),
  printReceipt: vi.fn(),
  printLabel: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      delivery: { documents: { list: { invalidate: state.invalidate } } },
    }),
    auth: {
      me: {
        useQuery: () => ({ data: { id: 1, role: "admin", isOwner: true } }),
      },
    },
    delivery: {
      documents: {
        prepareShipmentPrintBundle: {
          useMutation: () => ({ mutateAsync: state.prepare }),
        },
        requestPrint: { useMutation: () => ({ mutateAsync: state.request }) },
        completePrint: { useMutation: () => ({ mutateAsync: state.complete }) },
      },
    },
    invoicePrinting: {
      requestPrint: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      requestReprint: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));
vi.mock("@/lib/notify", () => ({
  notify: { warn: state.warn, err: state.error },
  errMsg: (cause: unknown) =>
    cause instanceof Error ? cause.message : String(cause),
}));
vi.mock("@/lib/printing/print", () => ({
  printDoc: state.printDoc,
  printReceipt: state.printReceipt,
}));
vi.mock("@/lib/printing/shippingLabel", () => ({
  printShippingLabel: state.printLabel,
  resolveShippingLabelPaymentState: () => "PAID",
}));

let printer: ReturnType<typeof useWorkflowDocumentPrinter>;
function Consumer() {
  printer = useWorkflowDocumentPrinter(1);
  return null;
}

function document(
  id: number,
  documentType: string,
  eventKey: string,
  payload: unknown,
) {
  return {
    id,
    documentType,
    eventKey,
    documentNumber: `DOC-${id}`,
    eventOccurredAt: "2026-10-26T08:00:00Z",
    payload,
    printHistory: [],
  };
}
const dispatch = {
  shipment: {
    consignmentId: 7,
    consignmentNumber: "AC-7",
    fulfillmentRequestId: null,
    sourceType: "AFTERCARE_EXECUTION",
    sourceId: 4,
  },
  party: { id: 1, name: "الناقل الأصلي" },
  recipient: {
    name: "مستلم المعالجة",
    phone: "07700000000",
    address: "العنوان الأصلي",
    governorate: null,
  },
  money: {
    codAmount: "0.00",
    deliveryFee: "0.00",
    feeCollection: "SHOP",
    currentTotal: "0.00",
    paidAmount: "0.00",
  },
  invoices: [],
};
function manifest(title: string) {
  return {
    schemaVersion: 1,
    title,
    documentNumber: title,
    rows: [{ label: "الجهة", value: "الناقل الأصلي" }],
    totals: [],
  };
}

describe("workflow shipment document selection", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    state.documents = [
      document(
        4,
        "DELIVERY_MANIFEST",
        "customer-collection",
        manifest("تحصيل العميل"),
      ),
      document(3, "DELIVERY_MANIFEST", "assignment", manifest("تسليم الناقل")),
      document(2, "DISPATCH_SLIP", "assignment", dispatch),
      document(
        1,
        "DELIVERY_MANIFEST",
        "old-assignment",
        manifest("إسناد سابق"),
      ),
    ];
    state.prepare.mockImplementation(async () => state.documents);
    state.request.mockImplementation(
      async ({ snapshotId }: { snapshotId: number }) => ({
        print: { id: snapshotId },
      }),
    );
    state.complete.mockResolvedValue({});
    state.invalidate.mockResolvedValue(undefined);
    state.printDoc.mockResolvedValue({ ok: true, via: "server" });
    state.printLabel.mockResolvedValue({ ok: true, via: "browser" });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(window.document.createElement("div"));
    act(() => root.render(<Consumer />));
  });
  afterEach(() => act(() => root.unmount()));

  it("prints the slip's handover manifest after a newer customer collection, without printing an aftercare sale", async () => {
    await act(async () => {
      await printer.printShipment(7, null);
    });
    expect(state.request.mock.calls.map(([input]) => input.snapshotId)).toEqual(
      [2, 3],
    );
    expect(state.printDoc.mock.calls.map(([doc]) => doc.title)).toContain(
      "تسليم الناقل",
    );
    expect(state.printDoc.mock.calls.map(([doc]) => doc.title)).not.toContain(
      "تحصيل العميل",
    );
    expect(state.printReceipt).not.toHaveBeenCalled();
    expect(state.complete).toHaveBeenCalledTimes(2);
    expect(state.error).not.toHaveBeenCalled();
  });

  it("reports a missing handover manifest without substituting a later collection or an older assignment", async () => {
    state.documents = state.documents.filter((row) => row.id !== 3);
    await act(async () => {
      await printer.printShipment(7, null);
    });
    expect(state.request.mock.calls.map(([input]) => input.snapshotId)).toEqual(
      [2],
    );
    expect(state.printDoc).toHaveBeenCalledTimes(1);
    expect(state.warn).toHaveBeenCalledOnce();
  });

  it("prints native aftercare labels from immutable shipment evidence with no customer collection", async () => {
    state.documents.push(document(5, "SHIPPING_LABEL", "assignment", dispatch));
    await act(async () => {
      await printer.printLabel(7, null);
    });
    expect(state.printLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        orderNumber: "AC-7",
        customerName: "مستلم المعالجة",
        addressText: "العنوان الأصلي",
        total: "0.00",
      }),
      { into: null },
    );
    expect(state.complete).toHaveBeenCalledWith({
      printId: 5,
      branchId: 1,
      status: "SENT",
    });
    expect(state.error).not.toHaveBeenCalled();
  });

  it("prints a native aftercare waybill recorded as an operational document", async () => {
    const waybill = {
      ...document(
        6,
        "AFTERCARE_WAYBILL",
        "assignment",
        manifest("بوليصة معالجة بعد البيع"),
      ),
      documentType: "AFTERCARE_WAYBILL" as const,
    };
    await act(async () => {
      await printer.printSnapshot(waybill, null);
    });
    expect(state.printDoc).toHaveBeenCalledWith(
      expect.objectContaining({ title: "بوليصة معالجة بعد البيع" }),
      { into: null },
    );
    expect(state.complete).toHaveBeenCalledWith({
      printId: 6,
      branchId: 1,
      status: "SENT",
    });
    expect(state.error).not.toHaveBeenCalled();
  });
});
