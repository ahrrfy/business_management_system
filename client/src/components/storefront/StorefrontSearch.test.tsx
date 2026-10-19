// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorefrontSearch } from "./StorefrontSearch";
const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { storefront: { searchSuggestions: { useQuery } } },
}));
let root: Root;
let container: HTMLDivElement;
const onSearch = vi.fn();
const onSelectProduct = vi.fn();
const onChange = vi.fn();
const data = {
  query: "دفتر",
  queries: [],
  categories: [],
  correction: null,
  similar: [],
  products: [
    {
      productId: 99,
      productName: "دفتر من آخر الكتالوج",
      brand: null,
      categoryId: null,
      category: null,
      price: "2500",
      salePrice: null,
      inStock: true,
    },
  ],
};
function Harness() {
  const [value, setValue] = useState("");
  return (
    <StorefrontSearch
      value={value}
      onChange={(raw) => {
        onChange(raw);
        setValue(raw);
      }}
      onSearch={onSearch}
      onSelectProduct={onSelectProduct}
      categoryId={null}
      availability="IN_STOCK"
      brand=""
      priceFilter="ALL"
    />
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSearch.mockReset();
  onSelectProduct.mockReset();
  onChange.mockReset();
  useQuery.mockImplementation(({ query }: { query: string }) => ({
    data: query.length >= 2 ? data : undefined,
    isPlaceholderData: false,
    isError: false,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function type(value: string) {
  const input = container.querySelector("input")!;
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function key(value: string) {
  act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: value, bubbles: true }),
      ),
  );
}
function debounce() {
  act(() => vi.advanceTimersByTime(220));
}
describe("customer search interaction", () => {
  it("preserves live spaces and debounces remote suggestions", () => {
    type("انكليزي ");
    expect(onChange).toHaveBeenLastCalledWith("انكليزي ");
    expect(container.querySelector("input")!.value).toBe("انكليزي ");
    expect(useQuery.mock.lastCall?.[0].query).toBe("");
    debounce();
    expect(useQuery.mock.lastCall?.[0].query).toBe("انكليزي");
  });
  it("Enter displays all results until the customer explicitly chooses an option using arrows", () => {
    type("دفتر");
    debounce();
    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
    key("Enter");
    expect(onSearch).toHaveBeenCalledWith("دفتر", undefined);
    expect(onSelectProduct).not.toHaveBeenCalled();
    type("دفتر ");
    debounce();
    key("ArrowDown");
    key("Enter");
    expect(onSelectProduct).toHaveBeenCalledWith(99);
  });
  it("preserves the explicitly selected all-results action when a delayed response inserts products", () => {
    let pending = true;
    useQuery.mockImplementation(() => ({
      data: pending ? undefined : data,
      isPlaceholderData: false,
      isError: false,
    }));
    type("دفتر");
    debounce();
    key("ArrowDown");
    expect(
      container.querySelector('[aria-selected="true"]')?.textContent,
    ).toContain("عرض جميع النتائج");
    pending = false;
    act(() => root.render(<Harness />));
    expect(
      container.querySelector('[aria-selected="true"]')?.textContent,
    ).toContain("عرض جميع النتائج");
    key("Enter");
    expect(onSearch).toHaveBeenCalledWith("دفتر", undefined);
    expect(onSelectProduct).not.toHaveBeenCalled();
  });
  it("Escape closes, edits reopen and clear submits an empty search", () => {
    type("دفتر");
    debounce();
    key("Escape");
    expect(container.querySelector("[role=listbox]")).toBeNull();
    expect(container.querySelector("input")!.value).toBe("دفتر");
    expect(container.querySelector('[aria-label="مسح البحث"]')?.getAttribute("title")).toBe("مسح البحث");
    type("دفتر ج");
    debounce();
    expect(container.querySelector("[role=listbox]")).not.toBeNull();
    act(() =>
      (
        container.querySelector(
          '[aria-label="مسح البحث"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(onSearch).toHaveBeenLastCalledWith("", undefined);
  });
  it("hides preceding product suggestions immediately when the query changes", () => {
    type("دفتر");
    debounce();
    expect(container.textContent).toContain("دفتر من آخر الكتالوج");
    type("قلم");
    expect(container.textContent).not.toContain("دفتر من آخر الكتالوج");
    expect(container.textContent).toContain("عرض جميع النتائج");
  });
  it("allows product selection by touch/click and always includes all-results", () => {
    type("دفتر");
    debounce();
    const option = container.querySelector(
      "[role=option]",
    ) as HTMLButtonElement;
    act(() => option.click());
    expect(onSelectProduct).toHaveBeenCalledWith(99);
    type("دفتر ");
    debounce();
    const all = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("عرض جميع النتائج"),
    )!;
    act(() => all.click());
    expect(onSearch).toHaveBeenLastCalledWith("دفتر", undefined);
  });
});
