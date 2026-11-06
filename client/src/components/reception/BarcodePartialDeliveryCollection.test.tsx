// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scan: vi.fn(),
  timeline: vi.fn(),
  partial: vi.fn(),
  mutate: vi.fn(),
  parties: [{ id: 2, name: "المندوب", partyType: "INDIVIDUAL", branchId: 1 }],
  obligations: [] as unknown[],
}));
vi.mock("@/lib/trpc", () => {
  const mutation = {
    useMutation: () => ({ isPending: false, mutate: state.mutate }),
  };
  const utils = {
    delivery: {
      workflow: {
        preview: { fetch: state.scan },
        previewPartialOutcome: { fetch: state.partial },
      },
      consignmentTimeline: { fetch: state.timeline },
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      auth: {
        me: {
          useQuery: () => ({ data: { id: 1, role: "admin", isOwner: true } }),
        },
      },
      delivery: {
        listParties: { useQuery: () => ({ data: state.parties }) },
        obligations: { useQuery: () => ({ data: state.obligations }) },
        openConsignments: { useInfiniteQuery: () => ({ data: { pages: [] } }) },
        staffConfirm: mutation,
        recordRemittance: mutation,
        recordCompanyStatement: mutation,
        workflow: { confirmDelivery: mutation },
      },
    },
  };
});
vi.mock("@/lib/notify", () => ({
  errMsg: String,
  notify: { ok: vi.fn(), err: vi.fn(), info: vi.fn() },
}));
vi.mock("@/components/delivery/PartialDeliverySettlementButton", () => ({
  PartialDeliverySettlementButton: (props: any) => (
    <button
      disabled={props.disabled}
      data-shift={props.targetShiftId}
      onClick={() => props.onOpenChange?.(true)}
    >
      {props.label ?? "استكمال تسوية تسليم جزئي"}
    </button>
  ),
}));
vi.mock("@/components/delivery/PredictiveConsignmentSearchInput", () => ({
  PredictiveConsignmentSearchInput: () => <input aria-label="باركود" />,
}));
vi.mock("@/components/delivery/workflow/WorkflowPrintActions", () => ({
  WorkflowPrintActions: () => null,
}));
vi.mock("@/components/delivery/CompanyStatementImport", () => ({
  CompanyStatementImport: () => null,
}));
vi.mock("@/components/delivery/CompanyStatementScanQueue", () => ({
  CompanyStatementScanQueue: () => null,
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: ({ children }: any) => <select>{children}</select>,
}));
import { ReceptionCollectSection } from "./ReceptionCollectSection";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
describe("barcode partial delivery collection in the receiving shift", () => {
  let host: HTMLDivElement;
  let root: Root;
  const preview = () => ({
    source: { kind: "invoice", id: 33494, branchId: 1, version: "v1" },
    printSource: { number: "106208" },
    relations: { invoiceId: 33494, consignmentId: 1787 },
    allowedActions: [{ action: "collect", allowed: true }],
    group: {
      key: "shipment:1787",
      leaderConsignmentId: 1787,
      consignmentIds: [1787],
    },
    money: {
      codAmount: "7000.00",
      heldDeliveryFee: "0.00",
      cashInCourierCustody: "0.00",
    },
    returnState: {
      members: [
        { consignmentId: 1787, received: true, cashInCourierCustody: "0.00" },
      ],
    },
  });
  const timeline = () => ({
    consignment: {
      id: 1787,
      partyId: 2,
      invoiceId: 33494,
      branchId: 1,
      status: "DISPATCHED",
      parcelStatus: "RETURNED",
      moneyStatus: "UNSETTLED",
      invoiceTotal: "17000.00",
      invoiceReturnedTotal: "10000.00",
      partialReturnReceived: true,
      returnDeclaredAt: null,
    },
    shipment: {
      memberCount: 1,
      members: [{ id: 1787, operational: false, parcelStatus: "RETURNED" }],
    },
  });
  const partial = () => ({
    consignmentId: 1787,
    branchId: 1,
    invoiceNumber: "106208",
    version: "p1",
    allowed: true,
    blockedReason: null,
    goodsAmount: "7000.00",
    feeAmount: "2000.00",
    feeCollection: "COURIER",
    cashAlreadyRecorded: false,
  });
  const action = () =>
    Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("تحصيل التسليم الجزئي في الوردية"),
    );
  async function render(
    raw = "106208",
    shift: { id: number } | null = { id: 22 },
  ) {
    await act(async () =>
      root.render(
        <ReceptionCollectSection
          branchId={1}
          shift={shift}
          scannedBarcode={raw}
        />,
      ),
    );
  }
  beforeEach(() => {
    vi.clearAllMocks();
    state.obligations = [
      { partyId: 2, codDueTotal: "7000.00", parcelsInTransitAmount: "0.00" },
    ];
    state.scan.mockResolvedValue(preview());
    state.timeline.mockResolvedValue(timeline());
    state.partial.mockResolvedValue(partial());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it.each(["106208", "CN-106208", "FR-310"])(
    "routes scan %s to the resolved consignment and current shift without moving cash",
    async (raw) => {
      await render(raw);
      expect(state.scan).toHaveBeenCalledWith({
        raw,
        station: "collect",
        branchId: 1,
      });
      expect(state.partial).toHaveBeenCalledWith({ consignmentId: 1787 });
      expect(action()?.dataset.shift).toBe("22");
      expect(host.textContent).toContain("7,000");
      expect(host.textContent).not.toContain(
        "الطرود لا تزال في الطريق مع المندوب",
      );
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );
  it("also offers item-scoped partial receipts that do not mark the whole parcel returned", async () => {
    const scan = preview();
    scan.returnState.members[0]!.received = false;
    const cn = timeline();
    cn.consignment.parcelStatus = "OUT_FOR_DELIVERY";
    cn.shipment.members[0]!.operational = true;
    state.scan.mockResolvedValue(scan);
    state.timeline.mockResolvedValue(cn);
    await render();
    expect(action()).toBeDefined();
    expect(state.partial).toHaveBeenCalledTimes(1);
  });
  it("keeps a full return out of the partial cash path", async () => {
    const cn = timeline();
    cn.consignment.invoiceReturnedTotal = "17000.00";
    state.timeline.mockResolvedValue(cn);
    await render();
    expect(action()).toBeUndefined();
    expect(state.partial).not.toHaveBeenCalled();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("preserves normal goods-plus-charges collection when a scoped return cannot use the special settlement", async () => {
    const scan = preview();
    scan.returnState.members[0]!.received = false;
    scan.money.codAmount = "9000.00";
    const cn = timeline();
    cn.consignment.parcelStatus = "OUT_FOR_DELIVERY";
    cn.shipment.members[0]!.parcelStatus = "OUT_FOR_DELIVERY";
    cn.shipment.members[0]!.operational = true;
    state.scan.mockResolvedValue(scan);
    state.timeline.mockResolvedValue(cn);
    state.partial.mockResolvedValue({
      ...partial(),
      allowed: false,
      blockedReason: "الأجور الإضافية تتطلب مسار التحصيل الأصلي",
    });
    await render();
    expect(action()).toBeUndefined();
    expect(host.textContent).toContain("9,000");
    expect(
      Array.from(host.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("إثبات التسليم وتحصيل العميل"),
      ),
    ).toBe(true);
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("does not fall back to delivery confirmation for a failed parcel", async () => {
    const scan = preview();
    scan.returnState.members[0]!.received = false;
    const cn = timeline();
    cn.consignment.parcelStatus = "FAILED";
    cn.shipment.members[0]!.parcelStatus = "FAILED";
    cn.shipment.members[0]!.operational = true;
    state.scan.mockResolvedValue(scan);
    state.timeline.mockResolvedValue(cn);
    state.partial.mockResolvedValue({
      ...partial(),
      allowed: false,
      blockedReason: "راجع الحالة قبل التسوية",
    });
    await render();
    expect(host.textContent).toContain("راجع الحالة قبل التسوية");
    expect(
      Array.from(host.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("إثبات التسليم وتحصيل العميل"),
      ),
    ).toBe(false);
  });
  it("shows the server block instead of enabling collection", async () => {
    state.partial.mockResolvedValue({
      ...partial(),
      allowed: false,
      blockedReason: "يوجد إيصال سابق؛ طابقه أولاً",
    });
    await render();
    expect(action()).toBeUndefined();
    expect(host.textContent).toContain("يوجد إيصال سابق؛ طابقه أولاً");
  });
  it("requires an open receiving shift", async () => {
    await render("106208", null);
    expect(action()?.disabled).toBe(true);
    expect(host.textContent).toContain("افتح وردية");
  });
  it("does not replace a reviewed partial settlement with another scan while its dialog is open", async () => {
    await render();
    await act(async () => action()!.click());
    await render("106209");
    expect(state.scan).toHaveBeenCalledTimes(1);
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("discards a late partial preview when the receiving shift changes", async () => {
    let resolve!: (value: ReturnType<typeof partial>) => void;
    state.partial.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await render();
    await render("106208", { id: 23 });
    await act(async () => resolve(partial()));
    expect(action()).toBeUndefined();
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
