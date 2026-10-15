import assert from "node:assert/strict";
import * as contract from "./storefront-pwa-contract.mjs";
assert.equal(typeof contract.storefrontApiNetworkMatcher, "function");
const { storefrontApiNetworkMatcher } = contract;
for (const route of [
  "/api/realtime/stream",
  "/api/realtime/stream/",
  "/api/realtime/stream?branchId=2",
]) {
  assert.equal(
    storefrontApiNetworkMatcher({
      url: new URL(route, "https://alarabiya.online"),
    }),
    false,
    route,
  );
}
for (const route of [
  "/api/trpc/auth.me",
  "/api/realtime/health",
  "/api/realtime/stream-extra",
  "/api/img/count-product/1/2",
]) {
  assert.equal(
    storefrontApiNetworkMatcher({
      url: new URL(route, "https://alarabiya.online"),
    }),
    true,
    route,
  );
}
console.log("SSE bypass and private API network-only contract: passed");
