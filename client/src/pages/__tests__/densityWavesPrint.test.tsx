// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  build: vi.fn(),
  print: vi.fn(() => true),
  error: vi.fn(),
}));
vi.mock("@/lib/printing/shippingLabel", () => ({
  shippingLabelHtml: state.build,
}));
vi.mock("@/lib/printing/brand", () => ({ openPrintWindow: state.print }));
vi.mock("@/lib/printing/render", () => ({
  docToHtml: async () => "<p>online</p>",
}));
vi.mock("@/lib/printing/onlineOrder", () => ({
  buildOnlineOrderThermalDoc: () => ({}),
}));
vi.mock("@/lib/printing/printTemplates", () => ({
  buildShiftOpenHtml: () => "<p>open</p>",
  buildShiftCloseHtml: () => "<p>close</p>",
  buildBrowserReceiptHtml: () => "<p>pos</p>",
}));
vi.mock("@/lib/notify", () => ({ notify: { err: state.error } }));
import PrintStudio from "../PrintStudio";
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("React", React);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/print-studio?doc=invalid");
  state.build
    .mockReset()
    .mockResolvedValue("<html><body>current preview</body></html>");
  state.print.mockClear().mockReturnValue(true);
  state.error.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const printButton = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "طباعة تجريبية الآن",
  )!;
const togglePayment = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "دفع عند الاستلام",
  )!;
describe("print studio preview and popup contract", () => {
  it("falls back from unknown document types and synchronously prints the built preview", async () => {
    await act(async () => root.render(<PrintStudio />));
    expect(state.build).toHaveBeenCalledOnce();
    expect(printButton().disabled).toBe(false);
    const html = container.querySelector("iframe")!.getAttribute("srcdoc");
    act(() => printButton().click());
    expect(state.print).toHaveBeenCalledWith(html, "width=900,height=1100");
    expect(state.build).toHaveBeenCalledOnce();
  });
  it("prevents printing the old preview while its replacement is still building", async () => {
    await act(async () => root.render(<PrintStudio />));
    let finish: (html: string) => void = () => {};
    state.build.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    act(() => togglePayment().click());
    expect(printButton().disabled).toBe(true);
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toBe("");
    await act(async () => finish("<p>updated preview</p>"));
    act(() => printButton().click());
    expect(state.print).toHaveBeenCalledWith(
      "<p>updated preview</p>",
      "width=900,height=1100",
    );
  });
  it("reports generation and popup failures without reusing a stale document", async () => {
    await act(async () => root.render(<PrintStudio />));
    state.print.mockReturnValue(false);
    act(() => printButton().click());
    expect(state.error).toHaveBeenCalledWith(
      expect.stringContaining("حجب المتصفح"),
    );
    state.build.mockRejectedValue(new Error("generation failed"));
    await act(async () => togglePayment().click());
    expect(printButton().disabled).toBe(true);
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toBe("");
    expect(state.error).toHaveBeenCalledWith("تعذّر إنشاء معاينة الطباعة");
  });
});
