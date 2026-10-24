import { describe, expect, it } from "vitest";
import type {
  WorkflowDispatchBatchInput,
  WorkflowDispatchBatchResult,
  WorkflowScanPreview,
} from "@shared/deliveryWorkflow";
import {
  appendDispatchDraftCode,
  commitDispatchDraft,
  dispatchDraftKey,
  dispatchPrintIdentity,
  dispatchRestoreCodes,
  dispatchRestorePlan,
  emptyDispatchDraft,
  parseDispatchDraft,
} from "./dispatchDraft";

const pending: WorkflowDispatchBatchInput = {
  sources: [
    { kind: "workOrder", id: 17, expectedVersion: "current-economic-snapshot" },
  ],
  branchId: 2,
  partyId: 9,
  assignedUserId: 5,
  deliveryFee: "5000.00",
  feeCollection: "COURIER",
  recipientName: "عميل فعلي",
  recipientPhone: "07701234567",
  deliveryAddress: "بغداد المنصور",
  clientRequestId: "saved-lost-response-command",
};
const result: WorkflowDispatchBatchResult = {
  consignmentId: 801,
  consignmentNumber: "100091",
  fulfillmentRequestId: 67,
  invoiceIds: [42, 43],
  idempotentReplay: false,
};

describe("barcode dispatch draft and committed recovery", () => {
  it("keeps unresolved FIFO codes durable across StrictMode cleanup and effect replay", () => {
    const first = appendDispatchDraftCode(emptyDispatchDraft(), "INV-10001");
    const second = appendDispatchDraftCode(first, "WO-10002");
    const queued = appendDispatchDraftCode(second, "CHG-23");
    const initial = dispatchRestorePlan(null, 0, queued);
    expect(initial?.codes).toEqual(["INV-10001", "WO-10002", "CHG-23"]);
    expect(dispatchRestorePlan(0, 0, queued)).toBeNull();
    // The first generation's reads were cancelled before resolution. The next
    // setup must schedule all saved codes again instead of retaining restored=true.
    expect(dispatchRestorePlan(0, 1, queued)?.codes).toEqual(initial?.codes);
    expect(queued.codes).toEqual(initial?.codes);
  });
  it("recovers a pending command verbatim and never requeues it as a new dispatch", () => {
    const draft = { ...emptyDispatchDraft(), codes: ["WO-17"], pending };
    const recovered = parseDispatchDraft(JSON.stringify(draft), 2)!;
    expect(recovered.pending).toEqual(pending);
    expect(dispatchRestoreCodes(recovered)).toEqual([]);
    expect(dispatchRestorePlan(null, 3, recovered)).toMatchObject({
      requiresRecovery: true,
      codes: [],
    });
    expect(appendDispatchDraftCode(recovered, "INV-20000")).toBe(recovered);
    expect(parseDispatchDraft(JSON.stringify(draft), 1)).toBeNull();
  });
  it("persists the actual committed CN separately from the cleared mutable draft for reload reprinting", () => {
    const draft = {
      ...emptyDispatchDraft(),
      codes: ["INV-10001", "WO-10002"],
      pending,
    };
    const committed = commitDispatchDraft(draft, result, 2, "الناقل المختار");
    const reloaded = parseDispatchDraft(JSON.stringify(committed), 2)!;
    expect(reloaded).toMatchObject({
      codes: [],
      pending: null,
      name: "",
      lastCommitted: { branchId: 2, partyName: "الناقل المختار", result },
    });
    expect(dispatchRestoreCodes(reloaded)).toEqual([]);
    expect(parseDispatchDraft(JSON.stringify(committed), 1)).toBeNull();
    // A later draft preserves the prior committed result, rather than turning
    // the reprint action back into a financial command.
    expect(
      appendDispatchDraftCode(reloaded, "AE-70").lastCommitted?.result,
    ).toEqual(result);
  });
  it("accepts existing v1 drafts without a committed result and keeps limits/user scopes", () => {
    const { lastCommitted: _oldField, ...old } = emptyDispatchDraft();
    expect(
      parseDispatchDraft(JSON.stringify(old), 2)?.lastCommitted,
    ).toBeNull();
    const full = {
      ...emptyDispatchDraft(),
      codes: Array.from({ length: 30 }, (_, i) => `INV-${i + 1}`),
    };
    expect(appendDispatchDraftCode(full, "INV-31")).toBe(full);
    expect(appendDispatchDraftCode(full, "INV-1")).toBe(full);
    expect(dispatchDraftKey(1, 2)).not.toBe(dispatchDraftKey(2, 2));
    expect(dispatchDraftKey(1, 2)).not.toBe(dispatchDraftKey(1, 1));
  });
  it("rejects corrupt, expired or fabricated committed record IDs", () => {
    const draft = commitDispatchDraft(emptyDispatchDraft(), result, 2, "ناقل");
    expect(
      parseDispatchDraft(
        JSON.stringify({ ...draft, savedAt: 1 }),
        2,
        86_400_002,
      ),
    ).toBeNull();
    expect(
      parseDispatchDraft(
        JSON.stringify({
          ...draft,
          lastCommitted: {
            ...draft.lastCommitted,
            result: { ...result, consignmentId: 0 },
          },
        }),
        2,
      ),
    ).toBeNull();
    expect(parseDispatchDraft("invalid-json", 2)).toBeNull();
  });
});

describe("reload-safe real print identities", () => {
  it.each([
    [
      {
        sourceType: "INVOICE",
        sourceId: 42,
        number: "70001",
        invoiceId: 42,
        invoiceNumber: "70001",
      },
      "invoice",
    ],
    [
      {
        sourceType: "WORK_ORDER",
        sourceId: 17,
        number: "70002",
        workOrderId: 17,
        invoiceId: 43,
      },
      "workOrder",
    ],
    [
      {
        sourceType: "FULFILLMENT_REQUEST",
        sourceId: 67,
        number: "FR-2-real",
        fulfillmentRequestId: 67,
      },
      "fulfillmentRequest",
    ],
    [
      {
        sourceType: "AFTERCARE_EXECUTION",
        sourceId: 70,
        number: "AE-70",
        aftercareExecutionId: 70,
      },
      "aftercare",
    ],
  ] as const)(
    "prints authoritative %s identity after original scan rows have been cleared",
    (source, kind) => {
      const printed = dispatchPrintIdentity({
        printSource: source as WorkflowScanPreview["printSource"],
      });
      expect(printed.orderNumber).toBe(source.number);
      expect(printed.orderKind).toBe(kind);
      expect(printed.sourceId).toBe(source.sourceId);
      expect(printed.orderNumber).not.toBe(result.consignmentNumber);
      expect(printed.invoiceId).not.toBe(result.consignmentId);
      if (
        source.sourceType === "AFTERCARE_EXECUTION" ||
        source.sourceType === "FULFILLMENT_REQUEST"
      )
        expect(printed.invoiceId).toBeNull();
    },
  );
});
