import assert from "node:assert/strict";
import {
  storefrontPublicImageCacheMatcher,
  storefrontPrivateImageNetworkMatcher,
} from "./storefront-pwa-contract.mjs";
import {
  assertStorefrontImageRuntimePolicy,
  assertStorefrontPrecacheClosure,
} from "./verify-storefront-pwa-build.mjs";

function matches(pathname, method = "GET") {
  return storefrontPublicImageCacheMatcher({
    request: { method },
    url: new URL(`https://alarabiya.online${pathname}`),
  });
}

assert.equal(matches("/api/img/banner/12/main-0?v=abc"), true);
assert.equal(matches("/api/img/product/42?v=abc&w=1200"), true);
assert.equal(matches("/api/img/company/baghdad/product/42?v=abc"), true);
assert.equal(matches("/api/img/inventory-product/42?v=abc"), false);
assert.equal(matches("/api/img/count-product/session-code/42?v=abc"), false);
assert.equal(matches("/api/img/kiosk-product/42?v=abc"), false);
assert.equal(matches("/api/img/company/baghdad/inventory-product/42"), false);
assert.equal(matches("/api/img/product/42", "HEAD"), false);
assert.equal(matches("/api/img/product/42", "POST"), false);

function privateMatches(pathname) {
  return storefrontPrivateImageNetworkMatcher({
    request: { method: "GET" },
    url: new URL(`https://alarabiya.online${pathname}`),
  });
}

assert.equal(privateMatches("/api/img/inventory-product/42?v=abc"), true);
assert.equal(privateMatches("/api/img/count-product/session-code/42?v=abc"), true);
assert.equal(privateMatches("/api/img/kiosk-product/42?v=abc"), true);
assert.equal(privateMatches("/api/img/product/42?v=abc"), false);

const manifest = {
  "index.html": {
    file: "assets/app-aaa.js",
    isEntry: true,
    imports: ["_framework.js"],
    dynamicImports: ["src/pages/Storefront.tsx", "src/pages/Admin.tsx"],
  },
  "src/pages/Storefront.tsx": {
    file: "assets/Storefront-bbb.js",
    isDynamicEntry: true,
    imports: ["_date.js"],
  },
  "src/pages/Admin.tsx": {
    file: "assets/Admin-ccc.js",
    isDynamicEntry: true,
  },
  "_framework.js": { file: "assets/framework-ddd.js" },
  "_date.js": {
    file: "assets/date-eee.js",
    imports: ["_number-normalize.js"],
  },
  "_number-normalize.js": { file: "assets/numberNormalize-fff.js" },
};

const completeSw = `self.__WB_MANIFEST = [
  {"url":"index.html","revision":"1"},
  {"url":"assets/app-aaa.js","revision":null},
  {"url":"assets/framework-ddd.js","revision":null},
  {"url":"assets/Storefront-bbb.js","revision":null},
  {"url":"assets/date-eee.js","revision":null},
  {"url":"assets/numberNormalize-fff.js","revision":null}
];`;

const result = assertStorefrontPrecacheClosure({ manifest, swSource: completeSw });
assert.deepEqual(result.requiredFiles, [
  "assets/Storefront-bbb.js",
  "assets/app-aaa.js",
  "assets/date-eee.js",
  "assets/framework-ddd.js",
  "assets/numberNormalize-fff.js",
]);

assert.throws(
  () => assertStorefrontPrecacheClosure({
    manifest,
    swSource: completeSw.replace(
      '{"url":"assets/numberNormalize-fff.js","revision":null}',
      "",
    ),
  }),
  /STOREFRONT_PRECACHE_STATIC_IMPORT_MISSING:assets\/numberNormalize-fff\.js/,
);

assert.throws(
  () => assertStorefrontPrecacheClosure({
    manifest,
    swSource: completeSw.replace(
      "];",
      ',{"url":"assets/Admin-ccc.js","revision":null}];',
    ),
  }),
  /STOREFRONT_PRECACHE_ADMIN_ENTRY_FORBIDDEN:assets\/Admin-ccc\.js/,
);

assert.throws(
  () => assertStorefrontPrecacheClosure({
    manifest,
    swSource: completeSw.replace(
      "];",
      ',{"url":"assets\/ort-runtime.wasm","revision":null}];',
    ),
  }),
  /STOREFRONT_PRECACHE_HEAVY_ASSET_FORBIDDEN:assets\/ort-runtime\.wasm/,
);

const runtimePolicy = [
  'registerRoute(privateMatcher,new NetworkOnly({cacheName:"private-images-no-cache",inventory:"inventory-product",count:"count-product",kiosk:"kiosk-product"}))',
  'registerRoute(publicMatcher,new CacheFirst({cacheName:"store-images",banner:"banner",product:"product",company:"company"}))',
  'registerRoute(apiMatcher,new NetworkOnly({cacheName:"api-no-cache"}))',
].join(";");
assert.doesNotThrow(() => assertStorefrontImageRuntimePolicy(runtimePolicy));

const unminifiedRuntimePolicy = [
  `registerRoute(
    ({ url }) => ["inventory-product", "count-product", "kiosk-product"].some((part) => url.pathname.includes(part)),
    new NetworkOnly({ "cacheName": "private-images-no-cache" }),
  )`,
  `registerRoute(
    ({ url }) => ["banner", "product", "company"].some((part) => url.pathname.includes(part)),
    new CacheFirst({ "cacheName": "store-images" }),
  )`,
  `registerRoute(
    ({ url }) => url.pathname.startsWith("/api"),
    new NetworkOnly({ "cacheName": "api-no-cache" }),
  )`,
].join(";\n");
assert.doesNotThrow(() => assertStorefrontImageRuntimePolicy(unminifiedRuntimePolicy));

assert.throws(
  () => assertStorefrontImageRuntimePolicy(runtimePolicy.replace("NetworkOnly", "CacheFirst")),
  /STOREFRONT_SW_PRIVATE_IMAGE_CACHE_FORBIDDEN/,
);
assert.throws(
  () => assertStorefrontImageRuntimePolicy(runtimePolicy.replace("inventory-product", "product")),
  /STOREFRONT_SW_PRIVATE_IMAGE_POLICY_INVALID:inventory-product/,
);

console.log("storefront PWA build contract test: OK");
