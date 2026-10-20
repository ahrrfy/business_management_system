// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSelect } from "./AppSelect";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("controlled select inside an account form", () => {
  function Form({ changed }: { changed: (value: string) => void }) {
    const [value, setValue] = useState("courier");
    return <form><AppSelect value={value} onValueChange={(next) => { changed(next); setValue(next); }}>
      <option value="">بدون اختيار</option>
      <option value="courier">مندوب توصيل</option>
      <option value="warehouse">أمين مخزن</option>
    </AppSelect></form>;
  }
  function nativeChange(value: string) {
    const select = container.querySelector("select")!;
    act(() => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  it("does not erase a loaded role on the hidden select synchronization event", () => {
    const changed = vi.fn();
    act(() => root.render(<Form changed={changed} />));
    changed.mockClear();
    nativeChange("");
    expect(changed).not.toHaveBeenCalled();
    expect(container.querySelector('[role="combobox"]')?.textContent).toContain("مندوب توصيل");
  });
  it("still accepts an explicit empty choice, an ordinary role change, and searchable combobox filtering", () => {
    const changed = vi.fn();
    act(() => root.render(<Form changed={changed} />));
    changed.mockClear();
    nativeChange("warehouse");
    expect(changed).toHaveBeenLastCalledWith("warehouse");
    nativeChange("__appselect_empty__");
    expect(changed).toHaveBeenLastCalledWith("");

    function SearchableForm() {
      const [value, setValue] = useState("1");
      return (
        <AppSelect
          value={value}
          onValueChange={setValue}
          searchable
          searchPlaceholder="ابحث عن وصفة..."
          open
        >
          <option value="">اختر وصفة</option>
          <option value="1">دفتر ملاحظات أزرق</option>
          <option value="2">حقيبة مدرسية كبيرة</option>
        </AppSelect>
      );
    }

    act(() => root.render(<SearchableForm />));
    const searchInput = document.body.querySelector('input[placeholder="ابحث عن وصفة..."]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    expect(searchInput.getAttribute("role")).toBe("combobox");
    const listbox = document.body.querySelector('[role="listbox"]');
    expect(listbox).toBeTruthy();
    expect(searchInput.getAttribute("aria-controls")).toBe(listbox?.getAttribute("id"));
    expect(listbox?.contains(searchInput)).toBe(false);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "حقيبه");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const visibleItems = Array.from(document.body.querySelectorAll('[role="listbox"] [role="option"]'));
    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0]?.textContent).toContain("حقيبة مدرسية كبيرة");
    expect(container.querySelector('[data-slot="select-trigger"]')?.textContent).toContain("دفتر ملاحظات أزرق");
  });
});
