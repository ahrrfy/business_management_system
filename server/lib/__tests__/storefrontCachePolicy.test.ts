import { expect, it } from "vitest";
import {
  storefrontCacheGet,
  storefrontReadCacheEnabled,
} from "../storefrontCachePolicy";

it.each(["production", "development", undefined])(
  "preserves %s cache defaults",
  (NODE_ENV) => {
    expect(storefrontReadCacheEnabled({ NODE_ENV })).toBe(true);
  },
);
it("preserves ordinary tests and accepts only explicit test opt-in", () => {
  for (const RUNTIME_LAB_READ_CACHE of [undefined, "", "0", "true", "yes"])
    expect(
      storefrontReadCacheEnabled({ NODE_ENV: "test", RUNTIME_LAB_READ_CACHE }),
    ).toBe(false);
  expect(
    storefrontReadCacheEnabled({
      NODE_ENV: "test",
      RUNTIME_LAB_READ_CACHE: "1",
    }),
  ).toBe(true);
});
it("returns the cache's original promise when diagnostics has no subscriber", () => {
  const original = Promise.resolve("value");
  const cache = {
    get: () => original,
    clear() {},
    invalidate() {},
    snapshot: () => ({ entries: 0, inFlight: 0, rejected: 0 }),
  };
  expect(
    storefrontCacheGet(cache, "index", "key", async () => "unexpected"),
  ).toBe(original);
});
