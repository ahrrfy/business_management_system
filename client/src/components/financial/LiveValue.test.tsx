// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveValue } from "./LiveValue";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let reduced = false;
const cancel = vi.fn();
const animate = vi.fn(() => ({ cancel }));
beforeEach(() => {
  reduced = false; cancel.mockClear(); animate.mockClear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: reduced }) });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const show = (value: string, identity = 1) => act(() => root.render(<LiveValue value={value} identity={identity} />));
describe("exact financial values with optional motion", () => {
  it("does not animate mount/unchanged values, displays the new precise value immediately", () => {
    show("999,999,999,999.99"); show("999,999,999,999.99");
    expect(animate).not.toHaveBeenCalled();
    show("-1,000,000,000,000.01");
    expect(host.textContent).toBe("-1,000,000,000,000.01");
    expect(animate).toHaveBeenCalledOnce();
    expect(host.querySelectorAll("[aria-live]")).toHaveLength(0);
  });
  it("cancels obsolete animations and never shows a fabricated intermediate balance", () => {
    show("100"); show("200"); show("0");
    expect(cancel).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("0");
  });
  it("respects reduced motion and does not animate a different record in the same table position", () => {
    show("100"); reduced = true; show("200");
    expect(animate).not.toHaveBeenCalled();
    reduced = false; show("500", 2);
    expect(animate).not.toHaveBeenCalled();
    expect(host.textContent).toBe("500");
  });
  it("preserves child interactions and avoids nested animation", () => {
    const render = (v: string) => act(() => root.render(
      <LiveValue value={v}><button><LiveValue value={v} /></button></LiveValue>,
    ));
    render("100"); render("200");
    expect(host.querySelector("button")?.textContent).toBe("200");
    expect(animate).toHaveBeenCalledOnce();
  });
});
