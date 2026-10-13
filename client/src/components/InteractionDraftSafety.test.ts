// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionDraftSafety } from "./InteractionDraftSafety";
import { playAudioFeedback } from "@/lib/audioFeedback";

const route = vi.hoisted(() => ({ location: "/draft-prompt-test" }));
vi.mock("wouter", () => ({ useLocation: () => [route.location, vi.fn()] }));
vi.mock("@/lib/audioFeedback", () => ({ playAudioFeedback: vi.fn() }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function DraftForm() {
  const [customer, setCustomer] = useState("");
  return React.createElement(
    "form",
    null,
    React.createElement("input", {
      name: "customer",
      value: customer,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setCustomer(event.target.value),
    }),
    React.createElement("output", null, customer),
  );
}

describe("interaction draft prompt with the actual notification subscriber", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessionStorage.clear();
    route.location = "/draft-prompt-test";
    window.history.replaceState(null, "", route.location);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", window.clearTimeout.bind(window));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    toast.dismiss();
  });
  afterEach(() => {
    act(() => {
      root.unmount();
      toast.dismiss();
      vi.runOnlyPendingTimers();
    });
    host.remove();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const seedDraft = (path = route.location, value = "مسودة محفوظة") => {
    const raw = JSON.stringify({
      savedAt: Date.now(),
      fields: [
        {
          key: "id:customer",
          kind: "input",
          inputType: "text",
          value,
          checked: false,
        },
      ],
    });
    sessionStorage.setItem(`alroya.interaction-draft.v1:${path}`, raw);
    return raw;
  };
  const render = (strict = false) => {
    const content = React.createElement(
      React.Fragment,
      null,
      React.createElement(InteractionDraftSafety),
      React.createElement(DraftForm, { key: route.location }),
      // The real main.tsx mounts the notification subscriber after draft safety.
      React.createElement(Toaster),
    );
    act(() =>
      root.render(
        strict ? React.createElement(React.StrictMode, null, content) : content,
      ),
    );
  };
  const settle = () => act(() => vi.advanceTimersByTime(10));
  const restoreButton = () =>
    Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "استعادة",
    );
  const navigate = (path: string) => {
    route.location = path;
    window.history.replaceState(null, "", path);
    render();
  };

  it("shows the restore action when safety mounts before the actual Toaster", () => {
    seedDraft();
    render();
    settle();
    expect(restoreButton()).toBeDefined();
    expect(host.textContent).toContain(
      "توجد إدخالات غير محفوظة من الجلسة السابقة",
    );
  });

  it("restores controlled state and keeps the stored recovery draft", () => {
    const stored = seedDraft();
    render();
    settle();
    expect(restoreButton()).toBeDefined();
    act(() => restoreButton()!.click());
    settle();
    expect(host.querySelector("output")!.textContent).toBe("مسودة محفوظة");
    expect(
      sessionStorage.getItem(`alroya.interaction-draft.v1:${route.location}`),
    ).toBe(stored);
  });

  it("cancels a pending prompt when the location changes before publication", () => {
    const oldPath = route.location;
    const stored = seedDraft();
    render();
    navigate("/no-draft-test");
    settle();
    expect(restoreButton()).toBeUndefined();
    expect(playAudioFeedback).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem(`alroya.interaction-draft.v1:${oldPath}`),
    ).toBe(stored);
  });

  it("does not restore another page draft after navigating during the restore timer", () => {
    const oldPath = route.location;
    const stored = seedDraft();
    seedDraft("/other-draft-test", "مسودة الصفحة الأخرى");
    render();
    settle();
    expect(restoreButton()).toBeDefined();
    act(() => restoreButton()!.click());
    navigate("/other-draft-test");
    settle();
    expect(host.querySelector("output")!.textContent).toBe("");
    expect(
      sessionStorage.getItem(`alroya.interaction-draft.v1:${oldPath}`),
    ).toBe(stored);
  });

  it("still offers recovery after StrictMode cancels its first effect setup", () => {
    seedDraft();
    render(true);
    settle();
    expect(restoreButton()).toBeDefined();
  });

  it("does not discard another page draft through a stale real toast cancel callback", () => {
    const oldPath = route.location;
    const original = seedDraft();
    const nextPath = "/cancel-other-draft-test";
    const nextDraft = seedDraft(nextPath, "مسودة الصفحة الأخرى");
    render();
    settle();
    const prompt = toast
      .getToasts()
      .find(
        (item) =>
          "title" in item &&
          item.title === "توجد إدخالات غير محفوظة من الجلسة السابقة",
      );
    const cancel = prompt && "cancel" in prompt ? prompt.cancel : undefined;
    expect(cancel).toBeDefined();
    const cancelAction = cancel as { onClick: () => void };
    navigate(nextPath);
    act(() => cancelAction.onClick());
    expect(
      sessionStorage.getItem(`alroya.interaction-draft.v1:${nextPath}`),
    ).toBe(nextDraft);
    expect(
      sessionStorage.getItem(`alroya.interaction-draft.v1:${oldPath}`),
    ).toBe(original);
  });

  it("allows the current toast cancel action to discard its own page draft", () => {
    seedDraft();
    render();
    settle();
    const cancelButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "تجاهل",
    );
    expect(cancelButton).toBeDefined();
    act(() => cancelButton!.click());
    expect(
      sessionStorage.getItem(`alroya.interaction-draft.v1:${route.location}`),
    ).toBeNull();
  });
});
