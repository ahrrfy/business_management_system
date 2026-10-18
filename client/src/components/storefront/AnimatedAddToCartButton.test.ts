// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AnimatedAddToCartButton } from "./AnimatedAddToCartButton";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function render(
  onAdd: () => boolean,
  disabled = false,
  label = "أضف إلى السلة",
) {
  act(() =>
    root.render(
      createElement(AnimatedAddToCartButton, { onAdd, disabled, label }),
    ),
  );
  return container.querySelector("button")!;
}
describe("immediate navy cart button", () => {
  it("adds before any timer and allows an intended second addition during confirmation", () => {
    const onAdd = vi.fn(() => true);
    const button = render(onAdd);
    act(() => button.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(button.textContent).toContain("تمت الإضافة");
    act(() => button.click());
    expect(onAdd).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1000));
    expect(button.textContent).toContain("أضف إلى السلة");
  });
  it("does not confirm selection-only or stock-limit rejection and preserves the selection label", () => {
    const onAdd = vi.fn(() => false);
    const button = render(onAdd, false, "اختر اللون");
    act(() => button.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(button.textContent).toContain("اختر اللون");
    expect(button.textContent).not.toContain("تمت الإضافة");
  });
  it("does not invoke the mutation while disabled", () => {
    const onAdd = vi.fn(() => true);
    const button = render(onAdd, true);
    act(() => button.click());
    expect(onAdd).not.toHaveBeenCalled();
  });
  it("clears an earlier confirmation when a later addition is rejected", () => {
    const onAdd = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const button = render(onAdd);
    act(() => button.click());
    act(() => button.click());
    expect(button.textContent).toContain("أضف إلى السلة");
  });
  it("uses brand tokens without geometry animation or resize work", () => {
    const css = readFileSync(
      "client/src/components/storefront/animated-add-to-cart.css",
      "utf8",
    );
    const source = readFileSync(
      "client/src/components/storefront/AnimatedAddToCartButton.tsx",
      "utf8",
    );
    expect(css).toContain("var(--store-brand,");
    expect(css).toContain("var(--store-brand-strong,");
    expect(css).not.toContain("@keyframes");
    expect(source).not.toContain("getBoundingClientRect");
    expect(source).not.toContain('addEventListener("resize"');
  });
});
