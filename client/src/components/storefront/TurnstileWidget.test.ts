import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STOREFRONT_TURNSTILE_ACTION } from "@shared/storefrontTurnstile";
import {
  TurnstileWidget,
  reduceTurnstileStatus,
} from "./TurnstileWidget";

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
  });
});
