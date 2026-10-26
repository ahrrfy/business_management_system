// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowDocumentPrinter } from "./useWorkflowDocumentPrinter";
import type { WorkflowDocumentSnapshot } from "@/lib/printing/workflowDocuments";
import type { WorkflowDocumentType } from "@shared/deliveryWorkflow";

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
  openPreview: vi.fn(),
  userId: 1,
  branchId: 1,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      delivery: { documents: { list: { invalidate: state.invalidate } } },
    }),
    auth: {
      me: {
        useQuery: () => ({ data: { id: state.userId, role: "admin", isOwner: true } }),
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
vi.mock("@/lib/printing/brand", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/printing/brand")>(),
  openPrintWindow: state.openPreview,
}));
vi.mock("@/lib/printing/render", () => ({
  docToHtml: async () => "<html><body>workflow document</body></html>",
}));

let printer: ReturnType<typeof useWorkflowDocumentPrinter>;
function Consumer() {
  printer = useWorkflowDocumentPrinter(state.branchId);
  return null;
}

function document(
  id: number,
  documentType: WorkflowDocumentType,
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
    printHistory: [] as WorkflowDocumentSnapshot["printHistory"],
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
    localStorage.clear();
    state.userId = 1;
    state.branchId = 1;
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
    state.openPreview.mockReturnValue(true);
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(window.document.createElement("div"));
    act(() => root.render(<Consumer />));
  });
  afterEach(() => act(() => root.unmount()));

  function remount() {
    act(() => root.unmount());
    root = createRoot(window.document.createElement("div"));
    act(() => root.render(<Consumer />));
  }

  function waybill() {
    return document(6, "AFTERCARE_WAYBILL", "assignment", manifest("بوليصة معالجة بعد البيع"));
  }

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

  it("persists an original request before the API and replays it after a lost response and remount", async () => {
    state.request.mockImplementationOnce(async (input) => {
      expect(Object.values(localStorage)).toContainEqual(expect.stringContaining(input.clientRequestId));
      throw new Error("request response lost");
    });
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    expect(state.printDoc).not.toHaveBeenCalled();
    const first = state.request.mock.calls[0][0];
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    expect(state.request.mock.calls[1][0]).toEqual(first);
    expect(first.copyType).toBe("ORIGINAL");
    expect(state.printDoc).toHaveBeenCalledOnce();
  });

  it("replays a label request after a lost response and remount", async () => {
    state.documents.push(document(5, "SHIPPING_LABEL", "assignment", dispatch));
    state.request.mockRejectedValueOnce(new Error("request response lost"));
    await act(async () => { await printer.printLabel(7, null); });
    const first = state.request.mock.calls[0][0];
    remount();
    await act(async () => { await printer.printLabel(7, null); });
    expect(state.request.mock.calls[1][0]).toEqual(first);
    expect(state.printLabel).toHaveBeenCalledOnce();
  });

  it("retries a known SENT acknowledgement after remount without sending another document", async () => {
    state.complete.mockRejectedValueOnce(new Error("completion response lost"));
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    const first = state.request.mock.calls[0][0];
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    expect(state.request.mock.calls[1][0]).toEqual(first);
    expect(state.printDoc).toHaveBeenCalledOnce();
    expect(state.complete.mock.calls.map(([input]) => input)).toEqual([
      { printId: 6, branchId: 1, status: "SENT" },
      { printId: 6, branchId: 1, status: "SENT" },
    ]);
  });

  it("retries a label completion acknowledgement without reopening its preview", async () => {
    state.documents.push(document(5, "SHIPPING_LABEL", "assignment", dispatch));
    state.complete.mockRejectedValueOnce(new Error("completion response lost"));
    await act(async () => { await printer.printLabel(7, null); });
    const first = state.request.mock.calls[0][0];
    remount();
    await act(async () => { await printer.printLabel(7, null); });
    expect(state.request.mock.calls[1][0]).toEqual(first);
    expect(state.printLabel).toHaveBeenCalledOnce();
    expect(state.complete).toHaveBeenCalledTimes(2);
  });

  it("retries a known FAILED acknowledgement without repeating the failed transport", async () => {
    state.printDoc.mockRejectedValueOnce(new Error("printer disconnected"));
    state.complete.mockRejectedValueOnce(new Error("completion response lost"));
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    expect(state.printDoc).toHaveBeenCalledOnce();
    expect(state.complete.mock.calls[1][0]).toEqual(state.complete.mock.calls[0][0]);
    expect(state.complete.mock.calls[1][0].status).toBe("FAILED");
  });

  it.each(["ORIGINAL", "REPRINT"] as const)("resumes this actor's server REQUESTED %s with its exact reason and printer", async (copyType) => {
    const snapshot = waybill();
    snapshot.printHistory = [
      ...(copyType === "REPRINT" ? [{ status: "SENT" }] : []),
      { id: 65, status: "REQUESTED", clientRequestId: "pending-server-request", requestedBy: 1, copyType,
        reason: copyType === "REPRINT" ? "سبب النسخة السابق" : null, printerKey: "saved-printer" },
    ];
    await act(async () => { await printer.printSnapshot(snapshot, null); });
    expect(state.request).toHaveBeenCalledWith({ snapshotId: 6, branchId: 1,
      clientRequestId: "pending-server-request", copyType, printerKey: "saved-printer",
      ...(copyType === "REPRINT" ? { reason: "سبب النسخة السابق" } : {}) });
    expect(state.printDoc).toHaveBeenCalledOnce();
  });

  it("keeps pending identities isolated by actor and branch", async () => {
    state.request.mockRejectedValue(new Error("response lost"));
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    const first = state.request.mock.calls[0][0];
    state.userId = 2;
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    state.userId = 1;
    state.branchId = 2;
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    state.branchId = 1;
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    const inputs = state.request.mock.calls.map(([input]) => input);
    expect(new Set(inputs.slice(0, 3).map((input) => input.clientRequestId)).size).toBe(3);
    expect(inputs[2].branchId).toBe(2);
    expect(inputs[3]).toEqual(first);
    expect(state.printDoc).not.toHaveBeenCalled();
  });

  it("never resumes another actor's server REQUESTED original", async () => {
    const snapshot = waybill();
    snapshot.printHistory = [{ id: 65, status: "REQUESTED", clientRequestId: "other-actor-request", requestedBy: 2, copyType: "ORIGINAL" }];
    state.request.mockRejectedValueOnce(new Error("original belongs to another actor"));
    await act(async () => { await printer.printSnapshot(snapshot, null); });
    expect(state.request.mock.calls[0][0].clientRequestId).not.toBe("other-actor-request");
    expect(state.printDoc).not.toHaveBeenCalled();
  });

  it("does not send a document already SENT in the replay response", async () => {
    state.request.mockRejectedValueOnce(new Error("response lost"));
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    state.request.mockResolvedValueOnce({ print: { id: 6, status: "SENT" } });
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    expect(state.printDoc).not.toHaveBeenCalled();
    expect(state.complete).toHaveBeenCalledWith({ printId: 6, branchId: 1, status: "SENT" });
  });

  it("acknowledges both shipment documents after remount without repeating either physical send", async () => {
    state.complete.mockRejectedValue(new Error("completion response lost"));
    await act(async () => { await printer.printShipment(7, null); });
    expect(state.printDoc).toHaveBeenCalledTimes(2);
    remount();
    state.complete.mockResolvedValue({});
    await act(async () => { await printer.printShipment(7, null); });
    expect(state.printDoc).toHaveBeenCalledTimes(2);
    expect(state.complete).toHaveBeenCalledTimes(4);
    expect(state.request.mock.calls[2][0]).toEqual(state.request.mock.calls[0][0]);
    expect(state.request.mock.calls[3][0]).toEqual(state.request.mock.calls[1][0]);
  });

  it("does not reopen a successful browser pack while retrying its completion acknowledgement", async () => {
    state.printDoc.mockResolvedValue({ ok: false, via: "browser", reason: "popup-blocked" });
    state.complete.mockRejectedValueOnce(new Error("completion response lost"));
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    remount();
    await act(async () => { await printer.printSnapshot(waybill(), null); });
    expect(state.openPreview).toHaveBeenCalledOnce();
    expect(state.printDoc).toHaveBeenCalledOnce();
    expect(state.complete).toHaveBeenCalledTimes(2);
    expect(printer.message).toContain("معاينة الطباعة");
  });

  it("keeps an explicit label REPRINT identity and reason when its response is lost", async () => {
    const label = document(5, "SHIPPING_LABEL", "assignment", dispatch);
    label.printHistory = [{ status: "SENT" }];
    state.documents.push(label);
    state.request.mockRejectedValueOnce(new Error("request response lost"));
    await act(async () => { await printer.printLabel(7, null); });
    const first = state.request.mock.calls[0][0];
    label.printHistory = [];
    remount();
    await act(async () => { await printer.printLabel(7, null); });
    expect(first).toMatchObject({ copyType: "REPRINT", reason: "إعادة طباعة ملصق الشحنة من محطة سير العمل" });
    expect(state.request.mock.calls[1][0]).toEqual(first);
    expect(state.printLabel.mock.calls[0][0].isReprint).toBe(true);
  });

  it("creates an explicit reprint with a new identity after a successful original", async () => {
    const snapshot = waybill();
    await act(async () => { await printer.printSnapshot(snapshot, null); });
    snapshot.printHistory = [{ status: "SENT" }];
    await act(async () => { await printer.printSnapshot(snapshot, null); });
    expect(state.request.mock.calls[1][0]).toMatchObject({ copyType: "REPRINT", reason: "إعادة طباعة من محطة سير العمل" });
    expect(state.request.mock.calls[1][0].clientRequestId).not.toBe(state.request.mock.calls[0][0].clientRequestId);
    expect(state.printDoc).toHaveBeenCalledTimes(2);
  });

  it("does not authorize printing when durable browser storage is unavailable", async () => {
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("storage blocked"); });
    try {
      await act(async () => { await printer.printSnapshot(waybill(), null); });
      expect(state.request).not.toHaveBeenCalled();
      expect(state.printDoc).not.toHaveBeenCalled();
      expect(state.error).toHaveBeenCalledWith(expect.stringContaining("فعّل تخزين المتصفح"));
    } finally { save.mockRestore(); }
  });
});
