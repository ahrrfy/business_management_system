// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { saveInteractionDraft } from "./lib/interactionDraft";
import {
  isStandalonePublicRoute,
  shouldBootStandalonePublicShell,
} from "./StorefrontBootstrap";
import { isSharedPath, resolveHostRedirect } from "./lib/siteHosts";

describe("standalone storefront release", () => {
  it("keeps the current public and shared host policy", () => {
    for (const route of [
      "/store",
      "/store/product/42",
      "/store/mobile-turnstile",
      "/apply",
      "/legal/privacy",
      "/shelf-lookup",
      "/price-check",
      "/s/w/token",
    ]) {
      expect(isStandalonePublicRoute(route)).toBe(true);
      expect(shouldBootStandalonePublicShell(route, "alarabiya.online")).toBe(
        true,
      );
      expect(resolveHostRedirect("srv1548487.hstgr.cloud", route)).toBe(
        "public",
      );
    }
    for (const route of ["/login", "/account"]) {
      expect(isSharedPath(route)).toBe(true);
      expect(resolveHostRedirect("alarabiya.online", route)).toBe(null);
    }
    expect(resolveHostRedirect("alarabiya.online", "/pos")).toBe("internal");
  });
  it("has no ERP shell, studio overlay or ERP realtime boot in its entry modules", () => {
    for (const file of ["storefront-main.tsx", "StorefrontBootstrap.tsx"]) {
      const source = fs.readFileSync(
        path.join(import.meta.dirname, file),
        "utf8",
      );
      expect(source).not.toMatch(
        /(?:import\(["']\.\/App|CommandPalette|ErpRealtimeBoot|financialQueries|productStudio)/,
      );
    }
  });
  it("keeps the old registration URL and scope while namespacing caches", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../vite.config.ts"),
      "utf8",
    );
    expect(source).toContain(
      'cacheId: storefront ? "alarabiya-storefront" : "alarabiya-erp"',
    );
    expect(source).toContain("skipWaiting: false");
    expect(source).toContain("clientsClaim: false");
    expect(source).toContain("cleanupOutdatedCaches: false");
    const update = fs.readFileSync(
      path.join(import.meta.dirname, "components/PwaUpdateManager.tsx"),
      "utf8",
    );
    expect(update).not.toMatch(/caches\.delete|registration\.unregister/);
  });
});

it("restores a saved application draft through the actual standalone entry", async () => {
  const mountedRoots: Root[] = [];
  const installAudio = vi.fn(() => vi.fn());
  const oldScale = localStorage.getItem("erp:display-scale:v1");
  const oldUiScale = document.documentElement.dataset.uiScale;
  const oldUrl = window.location.href;
  const observers: MutationObserver[] = [];
  const BrowserMutationObserver = MutationObserver;
  const passThrough = ({ children }: { children?: React.ReactNode }) =>
    children;
  const empty = () => null;
  function ApplicationForm({ initial = "" }: { initial?: string }) {
    const [applicant, setApplicant] = useState(initial);
    const [date, setDate] = useState("");
    return React.createElement(
      "form",
      null,
      React.createElement("input", {
        name: "applicant",
        value: applicant,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          setApplicant(event.target.value),
      }),
      React.createElement("input", {
        type: "date",
        name: "availableOn",
        value: date,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          setDate(event.target.value),
      }),
      React.createElement("output", null, applicant),
    );
  }
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "MutationObserver",
    class extends BrowserMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  vi.useFakeTimers();
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
  const mocks = [
    "@/components/ConfirmHost",
    "@/components/PwaUpdateManager",
    "@/lib/trpc",
    "@/lib/trpcClient",
    "@/lib/offline/connectivity",
    "@/lib/audioFeedback",
    "next-themes",
    "./StorefrontBootstrap",
    "./sentry",
    "react-dom/client",
  ];
  vi.doMock("@/components/ConfirmHost", () => ({ ConfirmHost: empty }));
  vi.doMock("@/components/PwaUpdateManager", () => ({
    PwaUpdateManager: empty,
  }));
  vi.doMock("@/lib/trpc", () => ({ trpc: { Provider: passThrough } }));
  vi.doMock("@/lib/trpcClient", () => ({ createErpTrpcClient: () => ({}) }));
  vi.doMock("@/lib/offline/connectivity", () => ({
    initConnectivity: vi.fn(),
  }));
  vi.doMock("@/lib/audioFeedback", () => ({
    playAudioFeedback: vi.fn(),
    installGlobalInteractionAudio: installAudio,
  }));
  vi.doMock("next-themes", () => ({
    ThemeProvider: passThrough,
    useTheme: () => ({ theme: "light" }),
  }));
  vi.doMock("./StorefrontBootstrap", () => ({
    StorefrontBootstrap: ApplicationForm,
  }));
  vi.doMock("./sentry", () => ({}));
  vi.doMock("react-dom/client", () => ({
    createRoot: (container: Element) => {
      expect(
        document.documentElement.dataset.uiScale,
        "stored scale must apply before first render",
      ).toBe("large");
      expect(installAudio).toHaveBeenCalledTimes(1);
      const root = createRoot(container);
      mountedRoots.push(root);
      return root;
    },
  }));
  sessionStorage.clear();
  window.history.replaceState(null, "", "/apply");
  const host = document.createElement("div");
  host.id = "root";
  document.body.appendChild(host);
  try {
    // Save through the real PWA draft function, then simulate the fresh entry after reload.
    const beforeReload = createRoot(host);
    act(() =>
      beforeReload.render(
        React.createElement(ApplicationForm, { initial: "طلب توظيف محفوظ" }),
      ),
    );
    expect(saveInteractionDraft()).toBe(true);
    const stored = sessionStorage.getItem("alroya.interaction-draft.v1:/apply");
    act(() => beforeReload.unmount());
    localStorage.setItem("erp:display-scale:v1", "large");
    delete document.documentElement.dataset.uiScale;
    await act(async () => {
      await import("./storefront-main");
    });
    act(() => vi.advanceTimersByTime(10));
    const date = host.querySelector<HTMLInputElement>('input[type="date"]');
    expect(date?.lang).toBe("en-GB");
    expect(date?.dir).toBe("ltr");
    expect(host.querySelector("output")?.textContent).toBe("");
    const restore = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "استعادة",
    );
    expect(
      restore,
      "standalone entry must mount draft recovery before its Toaster",
    ).toBeDefined();
    act(() => restore!.click());
    act(() => vi.advanceTimersByTime(10));
    expect(host.querySelector("output")?.textContent).toBe("طلب توظيف محفوظ");
    expect(sessionStorage.getItem("alroya.interaction-draft.v1:/apply")).toBe(
      stored,
    );
  } finally {
    act(() => {
      for (const root of mountedRoots) root.unmount();
      toast.dismiss();
      vi.runOnlyPendingTimers();
    });
    host.remove();
    for (const observer of observers) observer.disconnect();
    if (oldScale === null) localStorage.removeItem("erp:display-scale:v1");
    else localStorage.setItem("erp:display-scale:v1", oldScale);
    if (oldUiScale === undefined)
      delete document.documentElement.dataset.uiScale;
    else document.documentElement.dataset.uiScale = oldUiScale;
    window.history.replaceState(null, "", oldUrl);
    sessionStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const mocked of mocks) vi.doUnmock(mocked);
  }
});
