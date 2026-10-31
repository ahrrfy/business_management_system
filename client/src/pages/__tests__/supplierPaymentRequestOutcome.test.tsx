// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  callbacks: {} as Record<string, (result: { status: string }) => Promise<void>>,
  invalidate: vi.fn<() => Promise<void>>(), ok: vi.fn(), info: vi.fn(), err: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  const query = { useQuery: () => ({ data: [] }) };
  const infinite = { useInfiniteQuery: () => ({ data: { pages: [] } }) };
  const mutation = (name: string) => ({ useMutation: (options: { onSuccess: (result: { status: string }) => Promise<void> }) => {
    state.callbacks[name] = options.onSuccess;
    return { mutateAsync: vi.fn(), isPending: false };
  } });
  return { trpc: {
    auth: { me: { useQuery: () => ({ data: { id: 1, branchId: 1, role: "manager", isOwner: true }, isLoading: false }) } },
    branches: { list: query }, suppliers: { list: query },
    supplierPayments: { paymentSources: infinite, refundSources: infinite, pendingPayments: query, pendingRefunds: infinite,
      requestPayment: mutation("payment"), requestRefund: mutation("refund"), decidePayment: mutation("decidePayment"), decideRefund: mutation("decideRefund") },
    useUtils: () => ({ supplierPayments: Object.fromEntries(["paymentSources", "refundSources", "pendingPayments", "pendingRefunds"].map(key => [key, { invalidate: state.invalidate }])), purchaseIntegrity: { monthCloseBlockers: { invalidate: state.invalidate } } }),
  } };
});
vi.mock("@/lib/notify", () => ({ notify: { ok: state.ok, info: state.info, err: state.err } }));
vi.mock("@/lib/lifecycleOperationAccess", () => ({ canLifecycleOperation: () => true }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/purchases/DecideInInboxNotice", () => ({ DecideInInboxNotice: () => null }));
vi.mock("@/components/purchases/SupplierPaymentsGovernanceWorkspace", () => ({ SupplierPaymentsGovernanceWorkspace: () => null }));
import SupplierPaymentsGovernance from "../SupplierPaymentsGovernance";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

describe("supplier request server outcome", () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(async () => {
    state.callbacks = {}; vi.clearAllMocks(); state.invalidate.mockReset().mockResolvedValue(undefined);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root.render(<SupplierPaymentsGovernance />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  describe.each(["payment", "refund"])("%s", operation => {
    it.each(["PENDING", "APPROVED", "REJECTED", "STALE"])("reports %s instead of assuming a pending financial effect", async status => {
      await state.callbacks[operation]({ status });
      if (status === "APPROVED") {
        expect(state.ok).toHaveBeenCalledWith("تم الاعتماد وتطبيق الأثر داخل المعاملة");
        expect(state.info).not.toHaveBeenCalled();
      } else if (status === "PENDING") {
        expect(state.info).toHaveBeenCalledWith(
          operation === "payment" ? "تم إرسال طلب السداد للاعتماد" : "تم إرسال طلب استرداد الدفعة",
          operation === "payment" ? "لم تتغير ذمة المورد ولم يخرج مال بعد" : "لم يدخل مال ولم تتغير التخصيصات بعد",
        );
        expect(state.ok).not.toHaveBeenCalled();
      } else {
        const message = String(state.info.mock.calls[0]?.[0]);
        expect(message).toContain(status === "REJECTED" ? "رفض" : "نسخة المستند");
        expect(message).not.toContain("تم إرسال");
        expect(state.ok).not.toHaveBeenCalled();
      }
    });
  });
  it("preserves the successful outcome if refreshing the source lists fails", async () => {
    state.invalidate.mockRejectedValue(Error("refresh unavailable"));
    await expect(state.callbacks.payment({ status: "APPROVED" })).resolves.toBeUndefined();
    expect(state.ok).toHaveBeenCalledWith("تم الاعتماد وتطبيق الأثر داخل المعاملة");
    expect(state.err).toHaveBeenCalledWith("العملية مسجلة", expect.any(String));
  });
});
