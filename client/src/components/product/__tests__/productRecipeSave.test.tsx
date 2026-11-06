// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  saveProduct: vi.fn(),
  saveRecipe: vi.fn(),
  createRecipe: vi.fn(),
  invalidate: vi.fn(),
  guard: vi.fn(),
  navigate: vi.fn(),
  allowRecipeWrite: true,
  productPending: false,
  hasRecipe: true,
  showEditor: true,
  fingerprint: "recipe-original",
}));

const document = {
  id: 5350,
  name: "طباعة علم",
  productType: null,
  brand: null,
  modelName: null,
  description: null,
  categoryId: null,
  isCustomizable: false,
  allowAutoCartRecommendations: true,
  isService: true,
  allowBackorder: false,
  isBundle: false,
  isActive: true,
  showInReception: true,
  showInPrintPos: false,
  showInQuotations: false,
  showInAdvancedSales: false,
  isConsignment: false,
  consignorId: null,
  consignorName: null,
  images: [],
  unitTemplate: [
    {
      unitName: "خدمة",
      conversionFactor: "1",
      isBaseUnit: true,
      isStoreSaleUnit: true,
      retail: "50000.00",
      wholesale: "",
      government: "",
    },
  ],
  variants: [
    {
      id: 3420,
      sku: "FLAG",
      variantKind: "VARIANT",
      variantName: null,
      color: null,
      colorHex: null,
      size: null,
      costPrice: "0.00",
      baseRetail: "50000.00",
      reorderPoint: 0,
      minStock: 0,
      isActive: true,
      unitBarcodes: {},
      stockByBranch: {},
      image: null,
    },
  ],
};

function recipeDocument() {
  return {
    product: document,
    primaryVariantId: 3420,
    primaryProductUnitId: 3421,
    recipeFingerprint: state.fingerprint,
    recipe: state.hasRecipe
      ? {
          id: 7,
          name: "وصفة العلم",
          outputVariantId: 3420,
          outputProductUnitId: 3421,
          laborPerOutputBase: "0.00",
          wasteStdPct: "0.00",
          notes: null,
          isActive: true,
          lines: [
            {
              id: 1,
              inputVariantId: 9,
              inputProductUnitId: null,
              inputProductName: "خامة",
              inputSku: "MAT",
              inputCostPrice: "1000.00",
              qtyPerOutputBase: "1.0000",
              notes: null,
              units: [{ isBaseUnit: true, unitName: "متر" }],
            },
          ],
        }
      : null,
  };
}

vi.mock("@/lib/catalogPeopleOperationAccess", () => ({
  useCatalogPeopleOperationAccess: () => ({ can: () => true }),
}));
vi.mock("@shared/operationPermissions", () => ({
  operationDecision: (_user: unknown, path: string) => ({
    allowed:
      !["production.recipes.create", "production.recipes.update"].includes(
        path,
      ) || state.allowRecipeWrite,
  }),
}));
vi.mock("@/hooks/useSessionContext", () => ({
  useSessionContext: () => ({ context: { branch: { id: 1 } } }),
}));
vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: (value: unknown) => value,
}));
vi.mock("@/hooks/useUnsavedGuard", () => ({
  useUnsavedGuard: (dirty: boolean) => state.guard(dirty),
  bypassUnsavedGuard: vi.fn(),
}));
vi.mock("wouter", () => ({
  useParams: () => ({ id: "5350" }),
  useLocation: () => ["/products/5350/edit", state.navigate],
}));
vi.mock("@/lib/notify", () => ({
  notify: { ok: vi.fn(), err: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/product/BarcodeAliasDialog", () => ({
  BarcodeAliasDialog: () => null,
}));
vi.mock("@/components/product/SimpleProductEditForm", () => ({
  default: () => null,
}));
vi.mock("@/lib/trpc", () => {
  const invalidate = (...args: unknown[]) => state.invalidate(...args);
  const cache = { invalidate };
  const utils = {
    catalog: { posList: cache, adminList: cache, getForVariantEdit: cache },
    production: {
      recipes: {
        forProduct: cache,
        suggestSimilar: cache,
        listForImport: cache,
      },
    },
  };
  const mutation =
    (execute: (payload: unknown) => Promise<unknown>) =>
    (options?: {
      onSuccess?: (result: unknown) => unknown;
      onError?: (error: Error) => unknown;
    }) => ({
      isPending: execute === state.saveProduct && state.productPending,
      mutateAsync: async (payload: unknown) => {
        try {
          const result = await execute(payload);
          await options?.onSuccess?.(result);
          return result;
        } catch (error) {
          options?.onError?.(error as Error);
          throw error;
        }
      },
    });
  return {
    trpc: {
      useUtils: () => utils,
      auth: {
        me: {
          useQuery: () => ({
            data: {
              id: 1,
              role: "admin",
              isOwner: true,
              companyId: 1,
              branchId: 1,
            },
          }),
        },
      },
      branches: {
        list: { useQuery: () => ({ data: [{ id: 1, name: "الرئيسي" }] }) },
      },
      catalog: {
        categories: { useQuery: () => ({ data: [] }) },
        getForVariantEdit: { useQuery: () => ({ data: document }) },
        checkBarcodes: { useQuery: () => ({ data: [] }) },
        materialsForRecipe: { useQuery: () => ({ data: [] }) },
        updateProductVariants: { useMutation: mutation(state.saveProduct) },
      },
      production: {
        recipes: {
          forProduct: {
            useQuery: () => ({
              data: recipeDocument(),
              isLoading: false,
              isError: false,
            }),
          },
          checkStockAvailability: { useQuery: () => ({ data: undefined }) },
          create: { useMutation: mutation(state.createRecipe) },
          update: { useMutation: mutation(state.saveRecipe) },
          setActive: { useMutation: mutation(vi.fn()) },
          remove: { useMutation: mutation(vi.fn()) },
        },
      },
    },
  };
});
vi.mock("@/components/form/product/ProductFormFields", async () => {
  const { useProductRecipe } = await import("../useProductRecipe");
  const { useRecipeSave } = await import("../useRecipeSave");
  function RecipeEditor() {
    const recipe = useProductRecipe({ productId: 5350 });
    const save = useRecipeSave(recipe);
    return (
      <div>
        <button onClick={recipe.startEditing}>تعديل الوصفة</button>
        {recipe.isEditing && (
          <>
            <output data-recipe-quantity>
              {recipe.formLines[0]?.qtyPerOutputBase}
            </output>
            <button onClick={() => recipe.handleLineQtyChange(0, "1.5")}>
              استهلاك 1.5
            </button>
            <button
              onClick={() =>
                recipe.handleAddMaterial({
                  variantId: 9,
                  productName: "خامة",
                  variantName: null,
                  sku: "MAT",
                  unitName: "متر",
                  costPrice: "1000.00",
                })
              }
            >
              إضافة خامة
            </button>
            <button onClick={() => recipe.handleLineQtyChange(0, "0.00001")}>
              دقة زائدة
            </button>
            <button onClick={save.handleSave}>حفظ الوصفة</button>
          </>
        )}
      </div>
    );
  }
  return {
    ProductFormFields: () => (state.showEditor ? <RecipeEditor /> : null),
  };
});

import ProductEdit from "@/pages/ProductEdit";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

describe("product screen recipe saves", () => {
  let host: HTMLDivElement;
  let root: Root;
  async function click(label: string) {
    const button = Array.from(host.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
    expect(button, `button ${label}`).toBeDefined();
    await act(async () => button!.click());
  }
  async function editRecipe() {
    await click("تعديل الوصفة");
    await click("استهلاك 1.5");
  }
  beforeEach(async () => {
    state.saveProduct.mockReset().mockResolvedValue({
      productId: 5350,
      recipeId: 7,
      recipeFingerprint: "saved",
    });
    state.saveRecipe
      .mockReset()
      .mockResolvedValue({ recipeId: 7, recipeFingerprint: "saved" });
    state.createRecipe.mockReset();
    state.invalidate.mockReset().mockResolvedValue(undefined);
    state.guard.mockReset();
    state.navigate.mockReset();
    state.allowRecipeWrite = true;
    state.productPending = false;
    state.hasRecipe = true;
    state.showEditor = true;
    state.fingerprint = "recipe-original";
    host = globalThis.document.createElement("div");
    globalThis.document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<ProductEdit />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  it("saves fractional recipe changes in the product footer request", async () => {
    await editRecipe();
    expect(state.guard).toHaveBeenLastCalledWith(true);
    await click("حفظ التعديلات");
    expect(state.saveProduct).toHaveBeenCalledOnce();
    expect(state.saveProduct.mock.calls[0][0]).toMatchObject({
      productId: 5350,
      recipeChange: {
        recipeId: 7,
        expectedFingerprint: "recipe-original",
        lines: [{ inputVariantId: 9, qtyPerOutputBase: "1.5" }],
      },
    });
    expect(state.saveRecipe).not.toHaveBeenCalled();
    expect(state.guard).toHaveBeenLastCalledWith(false);
  });
  it("uses the same atomic request for Ctrl+S", async () => {
    await editRecipe();
    await act(async () =>
      globalThis.window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
      ),
    );
    expect(state.saveProduct.mock.calls[0]?.[0]).toHaveProperty(
      "recipeChange.lines.0.qtyPerOutputBase",
      "1.5",
    );
    expect(state.saveProduct).toHaveBeenCalledOnce();
  });
  it("keeps fields disabled until save-and-close cache settlement completes", async () => {
    let release!: () => void;
    state.invalidate.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    await editRecipe();
    await click("حفظ وإغلاق");
    expect(state.saveProduct).toHaveBeenCalledOnce();
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => { release(); });
    expect(state.navigate).toHaveBeenCalledWith("/products");
  });
  it("retains the fractional draft and navigation guard after a rejected save-and-close", async () => {
    state.saveProduct.mockRejectedValue(new Error("تغيّرت الوصفة"));
    await editRecipe();
    await click("حفظ وإغلاق");
    expect(host.querySelector("[data-recipe-quantity]")?.textContent).toBe(
      "1.5",
    );
    expect(state.guard).toHaveBeenLastCalledWith(true);
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("keeps the fingerprint captured on edit when the query refreshes", async () => {
    await editRecipe();
    state.fingerprint = "another-user-saved";
    await act(async () => root.render(<ProductEdit />));
    await click("حفظ التعديلات");
    expect(state.saveProduct.mock.calls[0]?.[0]).toHaveProperty(
      "recipeChange.expectedFingerprint",
      "recipe-original",
    );
  });
  it("blocks excessive material precision before sending a product mutation", async () => {
    await click("تعديل الوصفة");
    await click("دقة زائدة");
    await click("حفظ التعديلات");
    expect(state.saveProduct).not.toHaveBeenCalled();
    expect(host.textContent).toContain("أربع منازل");
  });
  it("continues supporting independent recipe saves with the edit fingerprint", async () => {
    await editRecipe();
    await click("حفظ الوصفة");
    expect(state.saveRecipe.mock.calls[0]?.[0]).toMatchObject({
      id: 7,
      expectedFingerprint: "recipe-original",
      lines: [{ qtyPerOutputBase: "1.5" }],
    });
    expect(state.saveProduct).not.toHaveBeenCalled();
  });
  it("saves a newly created recipe through the same footer transaction", async () => {
    state.hasRecipe = false;
    state.fingerprint = "NONE";
    await act(async () => root.render(<ProductEdit />));
    await click("تعديل الوصفة");
    await click("إضافة خامة");
    await click("استهلاك 1.5");
    await click("حفظ التعديلات");
    expect(state.saveProduct.mock.calls[0]?.[0]).toHaveProperty(
      "recipeChange",
      expect.objectContaining({
        recipeId: null,
        expectedFingerprint: "NONE",
        outputVariantId: 3420,
        outputProductUnitId: 3421,
        lines: [expect.objectContaining({ qtyPerOutputBase: "1.5" })],
      }),
    );
    expect(state.createRecipe).not.toHaveBeenCalled();
  });
  it("does not grant recipe writes through product-only authority", async () => {
    await editRecipe();
    state.allowRecipeWrite = false;
    await act(async () => root.render(<ProductEdit />));
    await click("حفظ التعديلات");
    expect(state.saveProduct).not.toHaveBeenCalled();
    expect(host.textContent).toContain("غير مفوضة لحفظ الوصفة");
  });
  it("prevents an independent recipe save while the product transaction is pending", async () => {
    await editRecipe();
    state.productPending = true;
    await act(async () => root.render(<ProductEdit />));
    await click("حفظ الوصفة");
    expect(state.saveRecipe).not.toHaveBeenCalled();
    expect(host.querySelector("[data-recipe-quantity]")?.textContent).toBe(
      "1.5",
    );
  });
  it("keeps an independently rejected recipe draft dirty", async () => {
    state.saveRecipe.mockRejectedValue(new Error("تغيّرت الوصفة"));
    await editRecipe();
    await click("حفظ الوصفة");
    expect(host.querySelector("[data-recipe-quantity]")?.textContent).toBe(
      "1.5",
    );
    expect(state.guard).toHaveBeenLastCalledWith(true);
  });
  it("saves and closes only after committing both changes", async () => {
    await editRecipe();
    await click("حفظ وإغلاق");
    expect(state.saveProduct.mock.calls[0]?.[0]).toHaveProperty(
      "recipeChange.lines.0.qtyPerOutputBase",
      "1.5",
    );
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/products");
    expect(state.guard).toHaveBeenLastCalledWith(false);
  });
  it("keeps a no-op recipe editor out of a product-only save", async () => {
    await click("تعديل الوصفة");
    await click("حفظ التعديلات");
    expect(state.saveProduct.mock.calls[0]?.[0]).not.toHaveProperty(
      "recipeChange",
    );
    expect(state.saveRecipe).not.toHaveBeenCalled();
  });
  it("unregisters a removed editor without unlocking a pending parent transaction", async () => {
    await editRecipe();
    expect(state.guard).toHaveBeenLastCalledWith(true);
    state.productPending = true;
    await act(async () => root.render(<ProductEdit />));
    state.showEditor = false;
    await act(async () => root.render(<ProductEdit />));
    expect(state.guard).toHaveBeenLastCalledWith(false);
    const saveButton = host.querySelector<HTMLButtonElement>(
      '[data-slot="save-bar"] button',
    );
    expect(saveButton?.disabled).toBe(true);
    state.productPending = false;
    await act(async () => root.render(<ProductEdit />));
    expect(saveButton?.disabled).toBe(false);
  });
});
