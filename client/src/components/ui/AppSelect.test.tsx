// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSelect } from "./AppSelect";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
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
  it("still accepts an explicit empty choice and an ordinary role change", () => {
    const changed = vi.fn();
    act(() => root.render(<Form changed={changed} />));
    changed.mockClear();
    nativeChange("warehouse");
    expect(changed).toHaveBeenLastCalledWith("warehouse");
    nativeChange("__appselect_empty__");
    expect(changed).toHaveBeenLastCalledWith("");
  });
});

describe("searchable AppSelect", () => {
  it("filters options with Arabic normalization while keeping the selected value label intact", () => {
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

    // نبحث بـ «حقيبه» (بالتاء/الهاء المطبّعة) فلا يظهر سوى الخيار الثاني، مع بقاء عنوان الخيار المحدد على الزر
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "حقيبه");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const items = Array.from(document.body.querySelectorAll('[data-slot="select-item"]'));
    const visibleItems = items.filter((el) => !el.classList.contains("hidden"));
    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0]?.textContent).toContain("حقيبة مدرسية كبيرة");
    expect(container.querySelector('[role="combobox"]')?.textContent).toContain("دفتر ملاحظات أزرق");
  });
});
