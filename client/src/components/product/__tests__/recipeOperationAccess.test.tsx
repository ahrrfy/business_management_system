// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ owner: false }));
vi.mock("@/hooks/useSessionContext", () => ({
  useSessionContext: () => ({ context: { branch: { id: 1 } } }),
}));
vi.mock("@/lib/trpc", () => {
  const query = () => ({ data: undefined, isError: false });
  const mutation = () => ({ isPending: false });
  return {
    trpc: {
      useUtils: () => ({}),
      auth: {
        me: {
          useQuery: () => ({
            data: {
              id: 7,
              role: "cashier",
              companyId: 1,
              branchId: 1,
              isOwner: state.owner,
            },
          }),
        },
      },
      catalog: { materialsForRecipe: { useQuery: query } },
      production: {
        recipes: {
          forProduct: { useQuery: query },
          checkStockAvailability: { useQuery: query },
          create: { useMutation: mutation },
          update: { useMutation: mutation },
          setActive: { useMutation: mutation },
          remove: { useMutation: mutation },
        },
      },
    },
  };
});
import { useProductRecipe } from "../useProductRecipe";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
function Probe() {
  const recipe = useProductRecipe({ productId: 3 });
  return (
    <button disabled={!recipe.can("production.recipes.create")}>
      إنشاء وصفة
    </button>
  );
}
describe("recipe legacy operation authority", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    state.owner = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  it("does not offer manager-only creation to a legacy cashier", async () => {
    await act(async () => root.render(<Probe />));
    expect(host.querySelector("button")?.disabled).toBe(true);
  });
  it("preserves the owner's creation authority", async () => {
    state.owner = true;
    await act(async () => root.render(<Probe />));
    expect(host.querySelector("button")?.disabled).toBe(false);
  });
});
