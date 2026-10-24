// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProductRelatedProductsEditor } from "../ProductRelatedProductsEditor";
const state = vi.hoisted(() => ({
  read: true,
  write: true,
  search: true,
  data: undefined as any,
  loading: false,
  error: false,
  fetching: false,
  matches: [] as any[],
  mutate: vi.fn(),
  refetch: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/lib/catalogPeopleOperationAccess", () => ({
  useCatalogPeopleOperationAccess: () => ({
    can: (path: string) =>
      path === "bundles.getRelatedProducts"
        ? state.read
        : path === "bundles.setRelatedProducts"
          ? state.write
          : state.search,
  }),
}));
vi.mock("@/lib/notify", () => ({ notify: { ok: vi.fn(), err: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bundles: { getRelatedProducts: { invalidate: state.invalidate } },
    }),
    bundles: {
      getRelatedProducts: {
        useQuery: () => ({
          data: state.data,
          isLoading: state.loading,
          isPending: state.loading,
          isFetching: state.fetching,
          isError: state.error,
          isSuccess: !state.error && !state.loading && state.data !== undefined,
          refetch: state.refetch,
        }),
      },
      searchComponents: {
        useQuery: () => ({
          data: { items: state.matches },
          isLoading: false,
          isFetching: false,
          isError: false,
          refetch: state.refetch,
        }),
      },
      setRelatedProducts: {
        useMutation: () => ({
          isPending: false,
          mutate: state.mutate,
          mutateAsync: state.mutate,
        }),
      },
    },
  },
}));
let root: Root, host: HTMLDivElement;
const relation = {
  relatedProductId: 2,
  productName: "دفتر قديم",
  relationType: "COMPLETE_KIT",
  sortOrder: 0,
};
const render = (productId = 1) =>
  act(() =>
    root.render(<ProductRelatedProductsEditor productId={productId} />),
  );
const saveButton = () =>
  Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("حفظ العلاقات"),
  )!;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  state.read = true;
  state.write = true;
  state.search = true;
  state.loading = false;
  state.error = false;
  state.fetching = false;
  state.data = { items: [relation] };
  state.matches = [];
  state.mutate.mockReset();
  state.refetch.mockReset();
  state.refetch.mockImplementation(async () => ({
    data: state.data,
    isError: false,
  }));
  state.mutate.mockResolvedValue({ count: 1 });
  state.invalidate.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
describe("related products editor session", () => {
  it("cannot replace existing relations with an unknown empty list after a read error", () => {
    state.data = undefined;
    state.error = true;
    render();
    expect(saveButton().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("تعذر");
  });
  it("preserves dirty edits across a background refresh", () => {
    render();
    act(() =>
      (
        host.querySelector(
          '[aria-label="حذف علاقة دفتر قديم"]',
        ) as HTMLButtonElement
      ).click(),
    );
    state.data = { items: [{ ...relation }] };
    render();
    expect(host.textContent).not.toContain("دفتر قديم");
  });
  it("drops the previous product draft before a failed load of a new product", () => {
    render();
    state.data = undefined;
    state.error = true;
    render(3);
    expect(host.textContent).not.toContain("دفتر قديم");
    expect(saveButton().disabled).toBe(true);
  });
  it("hides cached relations and disables saving when read access is revoked", () => {
    render();
    state.read = false;
    render();
    expect(host.textContent).not.toContain("دفتر قديم");
    expect(saveButton().disabled).toBe(true);
  });
  it("locks synchronously so a double click cannot submit twice", async () => {
    let resolve!: (value: { count: number }) => void;
    state.mutate.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render();
    act(() => {
      saveButton().click();
      saveButton().click();
    });
    expect(state.mutate).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ count: 1 }));
  });
});

describe("related products limits and late completion", () => {
  it("uses fresh server data while pristine", () => {
    render();
    state.data = { items: [{ ...relation, productName: "دفتر جديد" }] };
    render();
    expect(host.textContent).toContain("دفتر جديد");
    expect(host.textContent).not.toContain("دفتر قديم");
  });
  it("keeps a newer draft when an earlier post-save refresh completes", async () => {
    let resolve!: (value: any) => void;
    state.refetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render();
    await act(async () => saveButton().click());
    act(() =>
      (
        host.querySelector(
          '[aria-label="حذف علاقة دفتر قديم"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await act(async () =>
      resolve({ data: { items: [relation] }, isError: false }),
    );
    expect(host.textContent).not.toContain("دفتر قديم");
  });
  it("invalidates only the submitted product when its save completes after switching products", async () => {
    let resolve!: (value: { count: number }) => void;
    state.mutate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render();
    act(() => saveButton().click());
    state.data = {
      items: [{ ...relation, relatedProductId: 4, productName: "منتج ب" }],
    };
    render(3);
    await act(async () => resolve({ count: 1 }));
    expect(state.mutate.mock.calls[0][0].sourceProductId).toBe(1);
    expect(state.invalidate).toHaveBeenCalledWith({ sourceProductId: 1 });
    expect(state.refetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain("منتج ب");
  });
  it("enforces API limits before submission", () => {
    state.data = {
      items: Array.from({ length: 30 }, (_, i) => ({
        ...relation,
        relatedProductId: i + 2,
      })),
    };
    render();
    expect(
      (
        host.querySelector(
          '[aria-label="بحث عن منتج مكمل"]',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    state.data = { items: [{ ...relation, sortOrder: 1.5 }] };
    render(3);
    expect(saveButton().disabled).toBe(true);
    expect(host.querySelector('[aria-invalid="true"]')).not.toBeNull();
  });
});

it("invalidates a committed save even when read access changed during the request", async () => {
  let resolve!: (value: { count: number }) => void;
  state.mutate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render();
  act(() => saveButton().click());
  state.read = false;
  render();
  await act(async () => resolve({ count: 1 }));
  expect(state.invalidate).toHaveBeenCalledWith({ sourceProductId: 1 });
  expect(host.textContent).not.toContain("دفتر قديم");
});
