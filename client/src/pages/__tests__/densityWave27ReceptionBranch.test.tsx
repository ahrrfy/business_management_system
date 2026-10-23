// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceptionBranchGate } from "@/components/reception/ReceptionBranchGate";

const state = vi.hoisted(() => ({
  user: {
    id: 1,
    companyId: 10 as number | null,
    branchId: null as number | null,
    role: "admin",
    isOwner: false,
  },
  branchQueries: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      me: {
        useQuery: () => ({
          data: state.user,
          isPending: false,
          isError: false,
        }),
      },
    },
    branches: {
      list: {
        useQuery: (_: unknown, options: { enabled: boolean }) => {
          state.branchQueries(options.enabled);
          return {
            data: [{ id: 2, name: "الفرع الثاني" }],
            isPending: false,
            isError: false,
          };
        },
      },
    },
  },
}));
vi.mock("@/lib/receptionOperationAccess", () => ({
  receptionOperationAllowed: () => true,
}));
vi.mock("@/components/ui/AppSelect", () => ({
  AppSelect: (props: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      value={props.value}
      onChange={(event) => props.onValueChange(event.target.value)}
    >
      {props.children}
    </select>
  ),
}));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
let root: Root, container: HTMLDivElement;
const mounted = vi.fn();
function Workspace({ branchId }: { branchId: number }) {
  mounted(branchId);
  return <span data-branch={branchId} />;
}
const render = () =>
  act(() =>
    root.render(
      <ReceptionBranchGate>
        {(branchId) => <Workspace branchId={branchId} />}
      </ReceptionBranchGate>,
    ),
  );
function choose() {
  act(() => {
    const select = container.querySelector("select")!;
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.user = {
    id: 1,
    companyId: 10,
    branchId: null,
    role: "admin",
    isOwner: false,
  };
  state.branchQueries.mockClear();
  mounted.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
describe("Reception branch gate", () => {
  it("does not mount branch queries or workspace actions before explicit branch selection", () => {
    render();
    expect(mounted).not.toHaveBeenCalled();
    expect(container.textContent).toContain("اختر فرع الاستقبال");
    choose();
    expect(mounted).toHaveBeenLastCalledWith(2);
    expect(container.querySelector('[data-branch="2"]')).not.toBeNull();
  });
  it.each(["user", "company"])(
    "discards a prior branch synchronously when %s identity changes",
    (identity) => {
      render();
      choose();
      mounted.mockClear();
      state.user = {
        ...state.user,
        ...(identity === "user" ? { id: 3 } : { companyId: 11 }),
      };
      render();
      expect(mounted).not.toHaveBeenCalled();
      expect(container.querySelector("[data-branch]")).toBeNull();
    },
  );
  it("uses the assigned branch authoritatively without listing selectable branches", () => {
    state.user.branchId = 7;
    render();
    expect(mounted).toHaveBeenCalledWith(7);
    expect(state.branchQueries).toHaveBeenLastCalledWith(false);
  });
  it("allows an unassigned owner to choose a branch regardless of the legacy role", () => {
    state.user = { ...state.user, isOwner: true, role: "cashier" };
    render();
    choose();
    expect(mounted).toHaveBeenLastCalledWith(2);
  });
});
