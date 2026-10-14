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
