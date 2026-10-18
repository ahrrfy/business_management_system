// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrderTrackingRefresh } from "./useOrderTrackingRefresh";

type Order = { orderNumber: string; status: string };
type Options = Parameters<typeof useOrderTrackingRefresh<Order>>[0];
let root: Root;
let container: HTMLDivElement;
let hidden = false;
let online = true;
function Harness(options: Options) {
  useOrderTrackingRefresh(options);
  return null;
}
async function render(options: Options) {
  await act(async () => {
    root.render(createElement(Harness, options));
  });
}
const order: Order = { orderNumber: "ORD-1", status: "SHIPPED" };
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  hidden = false;
  online = true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("open customer order tracking refresh", () => {
  it("refreshes the bound token after 30 seconds without repeating the initial lookup", async () => {
    const fetchLatest = vi.fn(async () => ({ ...order, status: "DELIVERED" }));
    const onResult = vi.fn();
    await render({
      enabled: true,
      trackingToken: "bound-token",
      result: order,
      fetchLatest,
      onResult,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchLatest).toHaveBeenCalledExactlyOnceWith("bound-token");
    expect(onResult).toHaveBeenCalledWith({ ...order, status: "DELIVERED" });
  });
  it("pauses while hidden or offline and coalesces reconnect and focus", async () => {
    const fetchLatest = vi.fn(async () => order);
    await render({
      enabled: true,
      trackingToken: "bound-token",
      result: order,
      fetchLatest,
      onResult: vi.fn(),
    });
    hidden = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    hidden = false;
    online = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "discards a response after closing or changing the tracked order (%s)",
    async (changed) => {
      let finish!: (value: Order) => void;
      const fetchLatest = vi.fn(
        () =>
          new Promise<Order>((resolve) => {
            finish = resolve;
          }),
      );
      const onResult = vi.fn();
      await render({
        enabled: true,
        trackingToken: "bound-token",
        result: order,
        fetchLatest,
        onResult,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await render({
        enabled: changed,
        trackingToken: changed ? "other-token" : "bound-token",
        result: changed ? { ...order, orderNumber: "ORD-2" } : order,
        fetchLatest,
        onResult,
      });
      await act(async () => {
        finish({ ...order, status: "DELIVERED" });
      });
      expect(onResult).not.toHaveBeenCalled();
    },
  );
  it.each(["DELIVERED", "CANCELLED"])(
    "stops periodic reads for terminal status %s",
    async (status) => {
      const fetchLatest = vi.fn(async () => order);
      await render({
        enabled: true,
        trackingToken: "bound-token",
        result: { ...order, status },
        fetchLatest,
        onResult: vi.fn(),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(fetchLatest).not.toHaveBeenCalled();
    },
  );
});
