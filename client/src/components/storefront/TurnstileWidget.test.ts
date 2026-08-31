import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STOREFRONT_TURNSTILE_ACTION } from "@shared/storefrontTurnstile";
import {
  TurnstileWidget,
  loadTurnstileScript,
  reduceTurnstileStatus,
  turnstileStatusAllowsRetry,
} from "./TurnstileWidget";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("managed Turnstile widget contract", () => {
  it("renders an explicit RTL/mobile verification region without putting the site key in text", () => {
    const html = renderToStaticMarkup(createElement(TurnstileWidget, {
      siteKey: "public-site-key-placeholder",
      resetKey: 0,
      onTokenChange: () => undefined,
    }));

    expect(html).toContain('dir="rtl"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("التحقق من أن الطلب صادر من شخص حقيقي");
    expect(html).not.toContain("public-site-key-placeholder");
  });

  it("uses the exact server-validated action", () => {
    expect(STOREFRONT_TURNSTILE_ACTION).toBe("storefront_order_verify");
  });

  it("makes expiry and error explicit and returns to ready after reset", () => {
    expect(reduceTurnstileStatus("loading", "SCRIPT_READY")).toBe("ready");
    expect(reduceTurnstileStatus("ready", "VERIFIED")).toBe("verified");
    expect(reduceTurnstileStatus("verified", "EXPIRED")).toBe("expired");
    expect(reduceTurnstileStatus("verified", "ERROR")).toBe("error");
    expect(reduceTurnstileStatus("error", "RESET")).toBe("ready");
    expect(turnstileStatusAllowsRetry("error")).toBe(true);
    expect(turnstileStatusAllowsRetry("expired")).toBe(true);
    expect(turnstileStatusAllowsRetry("verified")).toBe(false);
  });

  it("removes a failed script so reopening checkout performs a real retry", async () => {
    type Listener = () => void;
    const scripts: Array<{
      listeners: Map<string, Listener>;
      remove: () => void;
    }> = [];
    let activeScript: (typeof scripts)[number] | null = null;

    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      querySelector: () => activeScript,
      createElement: () => {
        const listeners = new Map<string, Listener>();
        const script = {
          listeners,
          src: "",
          async: false,
          defer: false,
          addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
          remove: () => {
            if (activeScript === script) activeScript = null;
          },
        };
        scripts.push(script);
        return script;
      },
      head: {
        appendChild: (script: (typeof scripts)[number]) => {
          activeScript = script;
        },
      },
    });

    const firstAttempt = loadTurnstileScript();
    scripts[0]?.listeners.get("error")?.();
    await expect(firstAttempt).rejects.toThrow("TURNSTILE_SCRIPT_FAILED");
    expect(activeScript).toBeNull();

    const retryAttempt = loadTurnstileScript();
    expect(scripts).toHaveLength(2);
    (window as Window).turnstile = {} as Window["turnstile"];
    scripts[1]?.listeners.get("load")?.();
    await expect(retryAttempt).resolves.toBeUndefined();
  });
});
