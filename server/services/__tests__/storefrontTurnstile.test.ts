import { describe, expect, it, vi } from "vitest";
import {
  STOREFRONT_TURNSTILE_ACTION,
  assertStorefrontOrderingReadiness,
  checkStorefrontOrderingReadiness,
  getPublicStorefrontTurnstileSettings,
  verifyStorefrontTurnstile,
} from "../storefrontTurnstile";

const READY_ENV: NodeJS.ProcessEnv = {
  STOREFRONT_ORDERING_ENABLED: "1",
  STOREFRONT_TURNSTILE_ENABLED: "1",
  STOREFRONT_TURNSTILE_SITE_KEY: "public-site-key-placeholder",
  STOREFRONT_TURNSTILE_SECRET_KEY: "secret-key-placeholder",
  STOREFRONT_TURNSTILE_HOSTNAMES: "alarabiya.online,www.alarabiya.online",
};

describe("storefront ordering startup readiness", () => {
  it("stays closed without requiring credentials when ordering is not enabled", () => {
    expect(checkStorefrontOrderingReadiness({})).toEqual({
      orderingEnabled: false,
      ready: true,
      issues: [],
    });
  });

  it("fails startup with stable non-secret issue codes when ordering lacks Turnstile", () => {
    const env = {
      STOREFRONT_ORDERING_ENABLED: "1",
      STOREFRONT_TURNSTILE_SECRET_KEY: "must-never-appear",
    };
    const result = checkStorefrontOrderingReadiness(env);

    expect(result).toEqual({
      orderingEnabled: true,
      ready: false,
      issues: [
        "TURNSTILE_DISABLED",
        "TURNSTILE_SITE_KEY_MISSING",
        "TURNSTILE_HOSTNAMES_INVALID",
      ],
    });
    expect(() => assertStorefrontOrderingReadiness(env)).toThrow(
      "STOREFRONT_ORDERING_NOT_READY:TURNSTILE_DISABLED",
    );
    expect(JSON.stringify(result)).not.toContain("must-never-appear");
  });

  it("accepts an explicit exact-hostname configuration", () => {
    expect(checkStorefrontOrderingReadiness(READY_ENV)).toEqual({
      orderingEnabled: true,
      ready: true,
      issues: [],
    });
    expect(() => assertStorefrontOrderingReadiness(READY_ENV)).not.toThrow();
  });

  it("exposes only the public site key to storefront settings", () => {
    const publicSettings = getPublicStorefrontTurnstileSettings(READY_ENV);
    expect(publicSettings).toEqual({
      orderingEnabled: true,
      turnstileSiteKey: "public-site-key-placeholder",
    });
    expect(JSON.stringify(publicSettings)).not.toContain("secret-key-placeholder");
    expect(JSON.stringify(publicSettings)).not.toContain("TURNSTILE_SECRET_KEY");
  });
});

describe("Cloudflare Turnstile Siteverify", () => {
  it("accepts only the configured action and exact hostname", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      action: STOREFRONT_TURNSTILE_ACTION,
      hostname: "alarabiya.online",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(verifyStorefrontTurnstile("visitor-token", {
      env: READY_ENV,
      fetchImpl,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    })).resolves.toBeUndefined();

    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(String(body)).toContain("idempotency_key=11111111-1111-4111-8111-111111111111");
    expect(String(body)).toContain("response=visitor-token");
  });

  it.each([
    { action: "other_action", hostname: "alarabiya.online" },
    { action: STOREFRONT_TURNSTILE_ACTION, hostname: "evil.example" },
    { action: STOREFRONT_TURNSTILE_ACTION, hostname: "sub.alarabiya.online" },
  ])("fails closed for mismatched verification metadata: %o", async (payload) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, ...payload }), { status: 200 }));
    await expect(verifyStorefrontTurnstile("visitor-token", { env: READY_ENV, fetchImpl }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("retries one transient failure with the same idempotency key", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError("temporary network failure");
      return new Response(JSON.stringify({
        success: true,
        action: STOREFRONT_TURNSTILE_ACTION,
        hostname: "alarabiya.online",
      }), { status: 200 });
    });

    await verifyStorefrontTurnstile("visitor-token", {
      env: READY_ENV,
      fetchImpl,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(bodies[0]).get("idempotency_key"))
      .toBe(new URLSearchParams(bodies[1]).get("idempotency_key"));
  });

  it("rejects missing and oversized tokens before any outbound request", async () => {
    const fetchImpl = vi.fn();
    await expect(verifyStorefrontTurnstile("", { env: READY_ENV, fetchImpl }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(verifyStorefrontTurnstile("x".repeat(2049), { env: READY_ENV, fetchImpl }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
