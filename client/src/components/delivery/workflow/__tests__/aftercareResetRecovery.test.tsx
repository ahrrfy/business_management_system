// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  approve: vi.fn(),
  refresh: vi.fn(),
  rights: {
    originalRefundMethods: [],
    rights: [
      {
        rightIndex: 0,
        componentVariantId: 7,
        baseQuantity: 1,
        commercialAmount: "3000.00",
        executed: true,
        refunds: [
          {
            receiptId: 101,
            voucherNumber: "A",
            method: "CASH",
            amount: "1000.00",
            status: "PENDING",
          },
          {
            receiptId: 102,
            voucherNumber: "B",
            method: "CASH",
            amount: "2000.00",
            status: "PENDING",
          },
        ],
      },
    ],
  },
}));

vi.mock("@/lib/trpc", () => {
  const mutation = {
    useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  };
  return {
    trpc: {
      auth: {
        me: {
          useQuery: () => ({ data: { id: 1, name: "المالك", isOwner: true } }),
        },
      },
      vouchers: {
        approve: {
          useMutation: () => ({ isPending: false, mutateAsync: state.approve }),
        },
      },
      delivery: {
        fulfillment: {
          aftercare: {
            settlementRequest: mutation,
            approveSettlement: mutation,
            settlementPost: mutation,
            settlementWithdraw: mutation,
            settlementPreview: { useQuery: () => ({ data: undefined }) },
            rightsPreview: {
              useQuery: () => ({ data: state.rights, refetch: state.refresh }),
            },
            rightsPost: mutation,
            rightsConfirmRefund: mutation,
          },
        },
      },
    },
  };
});
vi.mock("@/hooks/useOperationPermission", () => ({
  useOperationPermission: () => ({ allowed: false }),
}));
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("@/lib/printing/brand", () => ({ preopenDocumentWindow: () => null }));
vi.mock("@/lib/printing/cashierLifecycleReceipts", () => ({
  printOverageRefundReceipt: vi.fn(async () => undefined),
}));
vi.mock("@/hooks/useWorkflowDocumentPrinter", () => ({
  useWorkflowDocumentPrinter: () => ({ busy: false }),
}));
vi.mock("@/components/delivery/workflow/WorkflowPrintActions", () => ({
  WorkflowPrintActions: () => null,
}));

import { AftercareSettlementPanel } from "@/components/fulfillment/AftercareSettlementPanel";
import {
  WorkflowResetButton,
  WorkflowScanResetScope,
} from "../workflowScanReset";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("aftercare lookup recovery ownership", () => {
  let root: Root;
  let host: HTMLDivElement;
  const clear = vi.fn();
  const changed = vi.fn(async () => undefined);

  beforeEach(() => {
    state.approve.mockReset();
    state.refresh.mockReset().mockResolvedValue(undefined);
    clear.mockClear();
    changed.mockClear();
    for (const refund of state.rights.rights[0]!.refunds)
      refund.status = "PENDING";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function resetButton() {
    const button = Array.from(host.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("مسح الاستعلام"),
    );
    if (!button) throw new Error("Lookup reset button missing");
    return button;
  }
  function approveButton(voucher: "A" | "B") {
    const receipt = Array.from(host.querySelectorAll("p")).find((node) =>
      node.textContent?.startsWith(`سند ${voucher} —`),
    );
    const button = receipt?.parentElement?.querySelector("button");
    if (!button)
      throw new Error(`Approval button missing for receipt ${voucher}`);
    return button;
  }

  it("keeps receipt A locked after B succeeds and unlocks only when A itself succeeds", async () => {
    const data = {
      case: { id: 1, branchId: 1, version: 1 },
      executions: [],
      lines: [],
      settlement: {
        id: 51,
        status: "POSTED",
        sourceRights: [{}],
        reason: "تسوية",
        evidence: "فحص فعلي",
        createdBy: 2,
      },
    } as unknown as Parameters<typeof AftercareSettlementPanel>[0]["data"];
    await act(async () =>
      root.render(
        <WorkflowScanResetScope>
          <AftercareSettlementPanel data={data} onChange={changed} />
          <WorkflowResetButton onReset={clear} />
        </WorkflowScanResetScope>,
      ),
    );
    expect(resetButton().disabled).toBe(false);

    state.approve.mockRejectedValueOnce(
      new Error("NetworkError: response lost"),
    );
    await act(async () => approveButton("A").click());
    expect(state.approve).toHaveBeenLastCalledWith({ receiptId: 101 });
    expect(resetButton().disabled).toBe(true);

    state.approve.mockImplementationOnce(async () => {
      state.rights.rights[0]!.refunds[1]!.status = "COMPLETED";
    });
    await act(async () => approveButton("B").click());
    expect(state.approve).toHaveBeenLastCalledWith({ receiptId: 102 });
    expect(resetButton().disabled).toBe(true);
    await act(async () => resetButton().click());
    expect(clear).not.toHaveBeenCalled();

    state.approve.mockImplementationOnce(async () => {
      state.rights.rights[0]!.refunds[0]!.status = "COMPLETED";
    });
    await act(async () => approveButton("A").click());
    expect(state.approve).toHaveBeenLastCalledWith({ receiptId: 101 });
    expect(state.approve).toHaveBeenCalledTimes(3);
    expect(resetButton().disabled).toBe(false);
    await act(async () => resetButton().click());
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
