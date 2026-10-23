// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  allowed: true,
  loading: false,
  error: true,
  retry: vi.fn(),
}));
vi.mock("../useProductRecipe", () => ({
  useProductRecipe: () => ({
    can: () => state.allowed,
    recipeQ: {
      isLoading: state.loading,
      isError: state.error,
      error: { message: "تعذر الاتصال" },
      refetch: state.retry,
    },
  }),
}));
vi.mock("../useRecipeTransfer", () => ({ useRecipeTransfer: () => ({}) }));
vi.mock("../useRecipeCosts", () => ({ useRecipeCosts: () => ({}) }));
vi.mock("../useRecipeSave", () => ({ useRecipeSave: () => ({}) }));
import { ProductRecipeSection } from "../ProductRecipeSection";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

describe("recipe load state", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    state.allowed = true;
    state.loading = false;
    state.error = true;
    state.retry.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  it("reports query failure and retries without offering to overwrite a supposedly missing recipe", async () => {
    await act(async () => root.render(<ProductRecipeSection productId={4} />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "تعذر الاتصال",
    );
    expect(host.textContent).not.toContain("لا توجد وصفة");
    expect(host.textContent).not.toContain("إنشاء وصفة");
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click(),
    );
    expect(state.retry).toHaveBeenCalledOnce();
  });
  it("keeps the loading state distinct from an empty recipe", async () => {
    state.loading = true;
    state.error = false;
    await act(async () => root.render(<ProductRecipeSection productId={4} />));
    expect(host.textContent).toContain("جارٍ تحميل");
    expect(host.textContent).not.toContain("إنشاء وصفة");
  });
  it("does not expose recipe actions without read authority", async () => {
    state.allowed = false;
    await act(async () => root.render(<ProductRecipeSection productId={4} />));
    expect(host.textContent).toContain("غير مفوض");
    expect(host.querySelector("button")).toBeNull();
  });
});
