// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pending: 0 }));
vi.mock("@tanstack/react-query", () => ({
  useIsMutating: () => state.pending,
}));
import {
  WorkflowResetButton,
  WorkflowScanResetScope,
  useWorkflowResetGuard,
  hasUnresolvedWorkflowError,
} from "./workflowScanReset";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
function Guard({ locked }: { locked: boolean }) {
  useWorkflowResetGuard(locked);
  return null;
}
describe("workflow lookup reset safety", () => {
  let root: Root;
  let host: HTMLDivElement;
  const clear = vi.fn();
  beforeEach(() => {
    state.pending = 0;
    clear.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function render(first = false, second = false, showSecond = true) {
    await act(async () =>
      root.render(
        <WorkflowScanResetScope>
          <Guard locked={first} />
          {showSecond && <Guard locked={second} />}
          <WorkflowResetButton onReset={clear} />
        </WorkflowScanResetScope>,
      ),
    );
  }
  it("resets an idle lookup", async () => {
    await render();
    await act(async () => host.querySelector("button")!.click());
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it("keeps an unresolved result protected after the network call finishes", async () => {
    await render(true);
    expect(host.querySelector("button")!.disabled).toBe(true);
    await act(async () => host.querySelector("button")!.click());
    expect(clear).not.toHaveBeenCalled();
  });
  it("releases only after all nested owners have resolved their requests", async () => {
    await render(true, true);
    await render(false, true);
    expect(host.querySelector("button")!.disabled).toBe(true);
    await render(false, false);
    expect(host.querySelector("button")!.disabled).toBe(false);
  });
  it("releases a removed guard without erasing another owner's lock", async () => {
    await render(true, true);
    await render(true, true, false);
    expect(host.querySelector("button")!.disabled).toBe(true);
    await render(false, true, false);
    expect(host.querySelector("button")!.disabled).toBe(false);
  });
  it("honors the owner's active-write guard even outside a reset scope", async () => {
    await act(async () =>
      root.render(<WorkflowResetButton onReset={clear} disabled />),
    );
    expect(host.querySelector("button")!.disabled).toBe(true);
  });
  it("propagates a nested station's lock to the parent navigation scope", async () => {
    const renderNested = async (locked: boolean) =>
      act(async () =>
        root.render(
          <WorkflowScanResetScope>
            <WorkflowScanResetScope>
              <Guard locked={locked} />
            </WorkflowScanResetScope>
            <WorkflowResetButton onReset={clear} />
          </WorkflowScanResetScope>,
        ),
      );
    await renderNested(true);
    expect(host.querySelector("button")!.disabled).toBe(true);
    await renderNested(false);
    expect(host.querySelector("button")!.disabled).toBe(false);
  });
  it.each([
    undefined,
    null,
    { data: { httpStatus: 400 } },
    { data: { httpStatus: 403 } },
    { data: { httpStatus: 409 } },
  ])("allows abandoning a known rejection or no request: %j", (error) => {
    expect(hasUnresolvedWorkflowError(error)).toBe(false);
  });
  it.each([
    new Error("response lost"),
    { data: { httpStatus: 500 } },
    { data: { httpStatus: 408 } },
  ])("keeps an ambiguous outcome protected: %j", (error) => {
    expect(hasUnresolvedWorkflowError(error)).toBe(true);
  });
});
