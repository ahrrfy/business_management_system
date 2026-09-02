import { describe, expect, it } from "vitest";
import {
  assertStorefrontProductionReadiness,
  storefrontProductionIssues,
} from "./storefrontProductionReadiness";

const TEST_KEYS: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  STOREFRONT_ORDERING_ENABLED: "1",
  STOREFRONT_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  STOREFRONT_TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

describe("storefront production Turnstile gate", () => {
  it("allows Cloudflare test keys outside production", () => {
    expect(storefrontProductionIssues(TEST_KEYS)).toEqual([]);
  });

  it("rejects Cloudflare test keys in production without echoing their values", () => {
    const env = { ...TEST_KEYS, NODE_ENV: "production" };
    expect(storefrontProductionIssues(env)).toEqual([
      "BARCODE_SECRET_MISSING_OR_WEAK",
      "TURNSTILE_TEST_SITE_KEY_FORBIDDEN",
      "TURNSTILE_TEST_SECRET_KEY_FORBIDDEN",
    ]);
    let message = "";
    try {
      assertStorefrontProductionReadiness(env);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("STOREFRONT_PRODUCTION_NOT_READY");
    expect(message).not.toContain(env.STOREFRONT_TURNSTILE_SITE_KEY!);
    expect(message).not.toContain(env.STOREFRONT_TURNSTILE_SECRET_KEY!);
  });

  it("accepts non-test production keys", () => {
    expect(() =>
      assertStorefrontProductionReadiness({
        ...TEST_KEYS,
        NODE_ENV: "production",
        BARCODE_SECRET: "b".repeat(64),
        STOREFRONT_TURNSTILE_SITE_KEY: "production-site-key-placeholder",
        STOREFRONT_TURNSTILE_SECRET_KEY: "production-secret-key-placeholder",
      }),
    ).not.toThrow();
  });

  it("requires a strong barcode signing secret when production ordering is enabled", () => {
    const production = {
      ...TEST_KEYS,
      NODE_ENV: "production",
      STOREFRONT_TURNSTILE_SITE_KEY: "production-site-key-placeholder",
      STOREFRONT_TURNSTILE_SECRET_KEY: "production-secret-key-placeholder",
    };
    expect(storefrontProductionIssues(production)).toEqual([
      "BARCODE_SECRET_MISSING_OR_WEAK",
    ]);
    expect(storefrontProductionIssues({
      ...production,
      BARCODE_SECRET: "example-secret-that-must-never-pass-1234567890",
    })).toEqual(["BARCODE_SECRET_MISSING_OR_WEAK"]);
  });
});
