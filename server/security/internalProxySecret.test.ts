import { describe, expect, it } from "vitest";
import {
  matchesInternalProxySecret,
  readInternalProxySecrets,
} from "./internalProxySecret";

const CURRENT = "a".repeat(64);
const PREVIOUS = "b".repeat(64);

describe("internal proxy secret rotation", () => {
  it("accepts the current and temporary previous values only", () => {
    const secrets = readInternalProxySecrets({
      INTERNAL_PROXY_SECRET: CURRENT,
      INTERNAL_PROXY_SECRET_PREVIOUS: PREVIOUS,
    });

    expect(matchesInternalProxySecret(CURRENT, secrets)).toBe(true);
    expect(matchesInternalProxySecret(PREVIOUS, secrets)).toBe(true);
    expect(matchesInternalProxySecret("c".repeat(64), secrets)).toBe(false);
    expect(matchesInternalProxySecret("short", secrets)).toBe(false);
  });

  it("keeps the one-secret steady state", () => {
    const secrets = readInternalProxySecrets({
      INTERNAL_PROXY_SECRET: CURRENT,
    });

    expect(secrets.previous).toBeUndefined();
    expect(matchesInternalProxySecret(CURRENT, secrets)).toBe(true);
    expect(matchesInternalProxySecret(PREVIOUS, secrets)).toBe(false);
    expect(matchesInternalProxySecret("0".repeat(64), secrets)).toBe(false);
  });

  it.each(["short", "z".repeat(64)])(
    "fails closed for an invalid previous value: %s",
    (previous) => {
      expect(() =>
        readInternalProxySecrets({
          INTERNAL_PROXY_SECRET: CURRENT,
          INTERNAL_PROXY_SECRET_PREVIOUS: previous,
        }),
      ).toThrow(/INTERNAL_PROXY_SECRET_PREVIOUS/u);
    },
  );

  it("fails closed when current and previous are equal", () => {
    expect(() =>
      readInternalProxySecrets({
        INTERNAL_PROXY_SECRET: CURRENT,
        INTERNAL_PROXY_SECRET_PREVIOUS: CURRENT,
      }),
    ).toThrow(/مختلف/u);
  });
});
