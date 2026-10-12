// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionContext } from "./useSessionContext";

const state = vi.hoisted(() => ({
  user: {
    id: 5,
    branchId: 9,
    role: "cashier",
    isOwner: false,
    operationPolicyRevision: 1,
    inheritedOperationPolicyRevision: 2,
  },
  updatedAt: 1,
  contextData: null as any,
  invalidate: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  const utils = {
    sessionContext: {
      get: { invalidate: state.invalidate, reset: state.reset },
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      auth: {
        me: {
          useQuery: () => ({
            data: state.user,
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
          }),
        },
      },
      sessionContext: {
        get: {
          useQuery: () => ({
            isPending: state.contextData == null,
            isError: false,
            data: state.contextData ?? undefined,
            dataUpdatedAt: state.updatedAt,
            refetch: vi.fn(),
          }),
        },
      },
    },
  };
});
(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function Consumer() {
  const session = useSessionContext();
  return (
    <output>
      {session.status}:{JSON.stringify(session.context?.scope)}
    </output>
  );
}
describe("session context permission revisions", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    state.user = {
      id: 5,
      branchId: 9,
      role: "cashier",
      isOwner: false,
      operationPolicyRevision: 1,
      inheritedOperationPolicyRevision: 2,
    };
    state.contextData = {
      context: {
        actor: { userId: 5, role: "cashier", isOwner: false },
        branch: { id: 9, name: "الفرع" },
        businessDay: "2026-10-12",
        allowedPaymentMethods: ["CASH"],
        defaultPriceTier: "RETAIL",
        canCrossBranches: false,
        scope: { scopedBranchId: 9, scopedOwnerId: null },
        derivedAt: "2026-10-12T10:00:00Z",
      },
      selectableBranches: [{ id: 9, name: "الفرع" }],
    };
    state.updatedAt = 1;
    state.invalidate.mockClear();
    state.reset.mockClear();
    state.reset.mockImplementation(() => { state.contextData = null; return Promise.resolve(); });
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root.render(<Consumer />));
  });
  afterEach(() => act(() => root.unmount()));
  it.each([
    "operationPolicyRevision",
    "inheritedOperationPolicyRevision",
  ] as const)(
    "resets shared context on %s despite unchanged user, branch and role",
    (revision) => {
      state.user = { ...state.user, [revision]: state.user[revision] + 1 };
      act(() => root.render(<Consumer />));
      expect(state.reset).toHaveBeenCalledTimes(1);
      expect(state.invalidate).not.toHaveBeenCalled();
    },
  );
  it("does not refetch unchanged permissions on re-render", () => {
    state.user = { ...state.user };
    act(() => root.render(<Consumer />));
    expect(state.invalidate).not.toHaveBeenCalled();
  });
  it.each([
    "operationPolicyRevision",
    "inheritedOperationPolicyRevision",
  ] as const)(
    "masks the old context until a response refreshed after %s arrives",
    (revision) => {
      expect(container.textContent).toContain("ready");
      const refreshed = structuredClone(state.contextData);
      state.user = { ...state.user, [revision]: state.user[revision] + 1 };
      act(() => root.render(<Consumer />));
      expect(container.textContent).toBe("loading:");
      // An unrelated render before the response must not expose the same cached authority.
      act(() => root.render(<Consumer />));
      expect(container.textContent).toBe("loading:");
      refreshed.context.scope.scopedOwnerId = 5;
      state.contextData = refreshed;
      state.updatedAt = 2;
      act(() => root.render(<Consumer />));
      expect(container.textContent).toContain(
        'ready:{"scopedBranchId":9,"scopedOwnerId":5}',
      );
    },
  );
  it("a newly mounted consumer cannot reuse authority while the revision refresh is pending", () => {
    state.user = { ...state.user, inheritedOperationPolicyRevision: 3 };
    act(() => root.render(<Consumer />));
    act(() => root.render(<><Consumer /><Consumer /></>));
    expect([...container.querySelectorAll("output")].map(node => node.textContent)).toEqual(["loading:", "loading:"]);
  });
});
