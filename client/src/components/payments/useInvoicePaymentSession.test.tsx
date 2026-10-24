// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { useInvoicePaymentSession } from "./useInvoicePaymentSession";
import { useSplitTender } from "./useSplitTender";
import { vi } from "vitest";
const apiState = vi.hoisted(() => ({ start: vi.fn(), finish: vi.fn() }));
vi.mock("@/lib/trpc", () => {
  const api = {
    initiateExternalPayment: {
      useMutation: () => ({ mutateAsync: apiState.start }),
    },
    confirmExternalPayment: {
      useMutation: () => ({ mutateAsync: apiState.finish }),
    },
  };
  return { trpc: { sales: api, reception: api } };
});
vi.mock("@/lib/offline/outbox", () => ({
  getDeviceCode: async () => "device-a",
}));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn() } }));
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

describe("advanced invoice payment recovery identity", () => {
  let host: HTMLDivElement;
  let root: Root;
  let session: ReturnType<typeof useInvoicePaymentSession>;
  let draft: ReturnType<typeof useSplitTender>;
  function Harness({ owner }: { owner?: number }) {
    session = useInvoicePaymentSession(owner);
    draft = useSplitTender({
      ownerId: owner,
      branchId: 2,
      channel: "POS",
      sessionKey: `new:${session[0]}`,
      canConfirm: !!owner,
    });
    return null;
  }
  function render(owner?: number) {
    act(() => root.render(<Harness owner={owner} />));
  }
  function reload(owner = 7) {
    act(() => root.unmount());
    root = createRoot(host);
    render(owner);
  }
  beforeEach(() => {
    apiState.start.mockReset().mockResolvedValue({ attemptId: 11 });
    apiState.finish.mockReset().mockResolvedValue({});
    sessionStorage.clear();
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  it("waits for the actor and restores the same key and confirmed split after an actual remount", async () => {
    render();
    expect(session[0]).toBe("");
    render(7);
    const original = session[0];
    expect(original).not.toBe("");
    act(() => draft.enable("100"));
    const [cash, card] = draft.parts;
    act(() => {
      draft.update(cash.id, { amount: "60" });
      draft.update(card.id, { amount: "40", reference: "ref-001" });
    });
    await act(async () => draft.confirm(card.id));
    expect(draft.problem("100")).toBeNull();
    reload();
    expect(session[0]).toBe(original);
    expect(draft.tendered).toBe("100.00");
    expect(draft.problem("100")).toBeNull();
  });
  it("recovers a lost initiation response through both production hooks after remount", async () => {
    render(7);
    act(() => draft.enable("100"));
    const [cash, card] = draft.parts;
    act(() => {
      draft.update(cash.id, { amount: "60" });
      draft.update(card.id, { amount: "40", reference: "ref-lost" });
    });
    apiState.start.mockRejectedValueOnce(new Error("response lost"));
    await act(async () => draft.confirm(card.id));
    const original = apiState.start.mock.calls[0][0];
    reload();
    await act(async () => draft.confirm(card.id));
    expect(apiState.start.mock.calls[1][0]).toEqual(original);
    expect(draft.problem("100")).toBeNull();
  });
  it("rotates the persisted identity on successful save or explicit reset", () => {
    render(7);
    const original = session[0];
    const next = crypto.randomUUID();
    act(() => session[1](next));
    expect(next).not.toBe(original);
    reload();
    expect(session[0]).toBe(next);
  });
  it("isolates actors and starts another tab from a separate session store", () => {
    render(7);
    const original = session[0];
    render(8);
    expect(session[0]).not.toBe(original);
    render(7);
    expect(session[0]).toBe(original);
    sessionStorage.clear();
    reload();
    expect(session[0]).not.toBe(original);
  });
});
