// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ start: vi.fn(), finish: vi.fn() }));
vi.mock("@/lib/trpc", () => {
  const api = {
    initiateExternalPayment: {
      useMutation: () => ({ mutateAsync: state.start }),
    },
    confirmExternalPayment: {
      useMutation: () => ({ mutateAsync: state.finish }),
    },
  };
  return { trpc: { sales: api, reception: api } };
});
vi.mock("@/lib/offline/outbox", () => ({
  getDeviceCode: async () => "device-a",
}));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn() } }));
import { useSplitTender } from "./useSplitTender";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
describe("split tender confirmation and recovery", () => {
  let host: HTMLDivElement;
  let root: Root;
  let draft: ReturnType<typeof useSplitTender>;
  function Harness({
    branch = 2,
    session = "invoice-a",extra="0",
  }: {
    branch?: number;
    session?: string;extra?:string;
  }) {
    draft = useSplitTender({
      branchId: branch,
      ownerId: 7,
      sessionKey: session,
      channel: "RECEPTION",
      canConfirm: true,additionalFirstPaymentAmount:extra,
    });
    return <span>{draft.tendered}</span>;
  }
  function render(branch = 2, session = "invoice-a",extra="0") {
    act(() => root.render(<Harness branch={branch} session={session} extra={extra} />));
  }
  function prepare() {
    act(() => draft.enable("100"));
    const [cash, card] = draft.parts;
    act(() => {
      draft.update(cash.id, { amount: "60" });
      draft.update(card.id, { amount: "40", reference: "000123" });
    });
    return card.id;
  }
  beforeEach(() => {
    localStorage.clear();
    state.start.mockReset().mockResolvedValue({ attemptId: 11 });
    state.finish.mockReset().mockResolvedValue({});
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    render();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  it("sends separate raw tenders and binds the confirmed card attempt", async () => {
    const id = prepare();
    await act(async () => draft.confirm(id));
    expect(draft.payments("100")).toEqual([
      { method: "CASH", amount: "60.00" },
      {
        method: "CARD",
        amount: "40.00",
        externalPaymentAttemptId: 11,
        externalPaymentDeviceId: "device-a",
      },
    ]);
    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 2,
        amount: "40.00",
        reference: "000123",
      }),
    );
  });
  it.each([false, true])(
    "recovers a lost initiation response with the same request and device (reload=%s)",
    async (reload) => {
      state.start.mockRejectedValueOnce(new Error("initiation response lost"));
      const id = prepare();
      await act(async () => draft.confirm(id));
      const originalRequest = state.start.mock.calls[0][0];
      expect(state.finish).not.toHaveBeenCalled();
      if (reload) {
        act(() => root.unmount());
        root = createRoot(host);
        render();
      }
      await act(async () => draft.confirm(id));
      expect(state.start).toHaveBeenCalledTimes(2);
      expect(state.start.mock.calls[1][0]).toEqual(originalRequest);
      expect(state.finish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          attemptId: 11,
          deviceId: originalRequest.deviceId,
        }),
      );
      expect(draft.problem("100")).toBeNull();
    },
  );
  it("retries a failed confirmation with the existing initiated attempt", async () => {
    const id = prepare();
    state.finish.mockRejectedValueOnce(new Error("temporary"));
    await act(async () => draft.confirm(id));
    expect(draft.problem("100")).toContain("أكّد");
    await act(async () => draft.confirm(id));
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.finish).toHaveBeenCalledTimes(2);
    expect(draft.problem("100")).toBeNull();
  });
  it("requires a new confirmation after a real amount change", async () => {
    const id = prepare();
    await act(async () => draft.confirm(id));
    act(() => draft.update(id, { amount: "30" }));
    expect(draft.problem("100")).toContain("أكّد");
    act(() => draft.update(id, { amount: "40", reference: " 000123 " }));
    expect(draft.problem("100")).toBeNull();
  });
  it("restores the exact tender draft and proof after a reload", async () => {
    const id = prepare();
    await act(async () => draft.confirm(id));
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(draft.tendered).toBe("100.00");
    expect(draft.problem("100")).toBeNull();
    await act(async () => draft.confirm(draft.parts[1].id));
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.finish).toHaveBeenCalledOnce();
  });
  it("does not apply a late proof to a different branch", async () => {
    let release!: (value: { attemptId: number }) => void;
    state.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const id = prepare();
    let pending!: Promise<void>;
    act(() => {
      pending = draft.confirm(id);
    });
    await act(async () => {
      await Promise.resolve();
    });
    render(3);
    await act(async () => {
      release({ attemptId: 11 });
      await pending;
    });
    expect(draft.parts).toEqual([]);
    expect(draft.pendingId).toBeNull();
    expect(state.finish).not.toHaveBeenCalled();
  });
  it("never restores a late confirmed proof from the previous invoice in the same branch", async () => {
    let release!: (value: unknown) => void;
    state.finish.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const id = prepare();
    let pending!: Promise<void>;
    act(() => {
      pending = draft.confirm(id);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.finish).toHaveBeenCalledOnce();
    render(2, "invoice-b");
    await act(async () => {
      release({});
      await pending;
    });
    prepare();
    expect(draft.parts[1].proof).toBeNull();
    expect(draft.problem("100")).toContain("أكّد");
  });
  it("first goods leg confirms goods plus services, and changing services invalidates proof without changing goods",async()=>{
    render(2,"invoice-a","3");act(()=>draft.enable("100"));const [first,second]=draft.parts;
    act(()=>{draft.update(first.id,{method:"CARD",amount:"40",reference:"bank"});draft.update(second.id,{method:"CASH",amount:"60"});});
    await act(async()=>draft.confirm(first.id));expect(state.start).toHaveBeenCalledWith(expect.objectContaining({amount:"43.00"}));
    expect(draft.payments("100")?.[0].amount).toBe("40.00");expect(draft.parts[0].proof?.confirmed).toBe(true);
    render(2,"invoice-a","4");expect(draft.parts[0].proof).toBeNull();expect(draft.problem("100")).toContain("أكّد");
    await act(async()=>draft.confirm(first.id));expect(state.start).toHaveBeenLastCalledWith(expect.objectContaining({amount:"44.00"}));
  });

});
