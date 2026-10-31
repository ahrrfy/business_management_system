import assert from "node:assert/strict";
import "./storefront-pwa-contract.test.mjs";
import {
  STOREFRONT_SHELL_CHUNK_GLOB,
  STOREFRONT_SHELL_CSS_GLOB,
  storefrontPublicImageCacheMatcher,
  storefrontPrivateImageNetworkMatcher,
} from "./storefront-pwa-contract.mjs";
import {
  assertStorefrontImageRuntimePolicy,
  assertStorefrontPrecacheClosure,
  assertStorefrontPrecacheNavigationPolicy,
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
assert.equal(
  privateMatches("/api/img/count-product/session-code/42?v=abc"),
  true,
);
assert.equal(privateMatches("/api/img/kiosk-product/42?v=abc"), true);
assert.equal(privateMatches("/api/img/product/42?v=abc"), false);

const manifest = {
  "index.html": {
    file: "assets/app-aaa.js",
    isEntry: true,
    imports: ["_framework.js"],
    css: ["assets/index-aaa.css"],
    dynamicImports: [
      "src/pages/Storefront.tsx",
      "src/pages/Admin.tsx",
      "src/App.tsx",
    ],
  },
  "src/pages/Storefront.tsx": {
    file: "assets/Storefront-bbb.js",
    isDynamicEntry: true,
    imports: ["_date.js", "_UnifiedSearchInput.js", "_dialog.js"],
    css: ["assets/Storefront-bbb.css"],
  },
  "src/pages/Admin.tsx": {
    file: "assets/Admin-ccc.js",
    isDynamicEntry: true,
  },
  "src/App.tsx": {
    file: "assets/App-erp.js",
    isDynamicEntry: true,
  },
  "_framework.js": { file: "assets/framework-ddd.js" },
  "_UnifiedSearchInput.js": {
    file: "assets/UnifiedSearchInput-search.js",
    imports: ["_BarcodeSearchCue.js", "_useBarcodeInput.js"],
  },
  "_BarcodeSearchCue.js": {
    file: "assets/BarcodeSearchCue-cue.js",
    imports: ["_framework.js"],
  },
  "_dialog.js": {
    file: "assets/dialog-dialoghash.js",
    imports: ["_framework.js"],
  },
  "_useBarcodeInput.js": { file: "assets/useBarcodeInput-barcodehash.js" },
  "_date.js": {
    file: "assets/date-eee.js",
    imports: ["_number-normalize.js"],
  },
  "_number-normalize.js": { file: "assets/numberNormalize-fff.js" },
};

const completeSw = `self.__WB_MANIFEST = [
  {"url":"index.html","revision":"1"},
  {"url":"assets/app-aaa.js","revision":null},
  {"url":"assets/index-aaa.css","revision":null},
  {"url":"assets/framework-ddd.js","revision":null},
  {"url":"assets/Storefront-bbb.js","revision":null},
  {"url":"assets/Storefront-bbb.css","revision":null},
  {"url":"assets/date-eee.js","revision":null},
  {"url":"assets/numberNormalize-fff.js","revision":null},
  {"url":"assets/UnifiedSearchInput-search.js","revision":null},
  {"url":"assets/BarcodeSearchCue-cue.js","revision":null},
  {"url":"assets/dialog-dialoghash.js","revision":null},
  {"url":"assets/useBarcodeInput-barcodehash.js","revision":null}
];`;

const result = assertStorefrontPrecacheClosure({
  manifest,
  swSource: completeSw,
});
assert.deepEqual(result.requiredFiles, [
  "assets/BarcodeSearchCue-cue.js",
  "assets/Storefront-bbb.css",
  "assets/Storefront-bbb.js",
  "assets/UnifiedSearchInput-search.js",
  "assets/app-aaa.js",
  "assets/date-eee.js",
  "assets/dialog-dialoghash.js",
  "assets/framework-ddd.js",
  "assets/index-aaa.css",
  "assets/numberNormalize-fff.js",
  "assets/useBarcodeInput-barcodehash.js",
]);

// The canonical allowlist must cover the storefront's shared search-input graph,
// including the dialog and barcode chunks emitted after the Vite 7.3.7 patch.
// Unrelated ERP pages and ERP RBAC/offline/chart chunks must remain excluded.
const shellChunkNames = STOREFRONT_SHELL_CHUNK_GLOB.match(
  /^assets\/\{([^}]+)\}-\*\.js$/,
)?.[1].split(",");
assert.ok(shellChunkNames, "storefront shell glob has explicit chunk names");
for (const file of result.requiredFiles.filter(
  (file) => file.endsWith(".js") && !file.startsWith("assets/app-"),
)) {
  const chunkName = file.replace(/^assets\//, "").replace(/-[^-]+\.js$/, "");
  assert.ok(
    shellChunkNames.includes(chunkName),
    `${chunkName} must be included in storefront shell precache`,
  );
}

const shellCssNames = STOREFRONT_SHELL_CSS_GLOB.match(
  /^assets\/\{([^}]+)\}-\*\.css$/,
)?.[1].split(",");
assert.deepEqual(shellCssNames, ["index", "Storefront"]);
for (const cssFile of result.requiredFiles.filter((file) =>
  file.endsWith(".css"),
)) {
  const cssChunkName = cssFile
    .replace(/^assets\//, "")
    .replace(/-[^-]+\.css$/, "");
  assert.ok(
    shellCssNames.includes(cssChunkName),
    `${cssChunkName} CSS must be included in storefront shell CSS glob`,
  );
}

for (const forbiddenChunk of [
  "Admin",
  "POS",
  "ProductNew",
  "Treasury",
  "App",
  "erp",
  "erp-variants",
  "app-shell",
  "erp-shell",
  "erp-navigation",
  "CommandPalette",
  "operation-catalog-1",
  "operation-catalog-2",
  "authorization-vendor",
  "validation-vendor",
  "offline-store",
  "charts",
  "legacy-permissions",
  "permission-extensions",
]) {
  assert.equal(
    shellChunkNames.includes(forbiddenChunk),
    false,
    `${forbiddenChunk} must not be in storefront shell glob`,
  );
  assert.equal(
    shellCssNames.includes(forbiddenChunk),
    false,
    `${forbiddenChunk} must not be in storefront shell CSS glob`,
  );
}

for (const erpChunkFile of [
  "assets/App-erp.js",
  "assets/erp-abc.css",
  "assets/erp-variants-abc.css",
  "assets/erp-shell-abc.css",
  "assets/app-shell-abc.js",
  "assets/erp-shell-abc.js",
  "assets/operation-catalog-1-abc.js",
  "assets/operation-catalog-2-abc.js",
  "assets/authorization-vendor-abc.js",
  "assets/validation-vendor-abc.js",
  "assets/offline-store-abc.js",
  "assets/charts-abc.js",
  "assets/CommandPalette-abc.js",
]) {
  assert.throws(
    () =>
      assertStorefrontPrecacheClosure({
        manifest,
        swSource: completeSw.replace(
          "];",
          `,{"url":"${erpChunkFile}","revision":null}];`,
        ),
      }),
    new RegExp(
      `STOREFRONT_PRECACHE_ERP_CHUNK_FORBIDDEN:${erpChunkFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
}

for (const missingCss of ["index-aaa", "Storefront-bbb"]) {
  assert.throws(
    () =>
      assertStorefrontPrecacheClosure({
        manifest,
        swSource: completeSw.replace(
          `{"url":"assets/${missingCss}.css","revision":null}`,
          "",
        ),
      }),
    /STOREFRONT_PRECACHE_STATIC_IMPORT_MISSING/,
  );
}

for (const missingChunk of [
  "UnifiedSearchInput-search",
  "BarcodeSearchCue-cue",
  "dialog-dialoghash",
  "useBarcodeInput-barcodehash",
]) {
  assert.throws(
    () =>
      assertStorefrontPrecacheClosure({
        manifest,
        swSource: completeSw.replace(
          `{"url":"assets/${missingChunk}.js","revision":null}`,
          "",
        ),
      }),
    /STOREFRONT_PRECACHE_STATIC_IMPORT_MISSING/,
  );
}

assert.throws(
  () =>
    assertStorefrontPrecacheClosure({
      manifest,
      swSource: completeSw.replace(
        '{"url":"assets/numberNormalize-fff.js","revision":null}',
        "",
      ),
    }),
  /STOREFRONT_PRECACHE_STATIC_IMPORT_MISSING:assets\/numberNormalize-fff\.js/,
);

assert.throws(
  () =>
    assertStorefrontPrecacheClosure({
      manifest,
      swSource: completeSw.replace(
        "];",
        ',{"url":"assets/Admin-ccc.js","revision":null}];',
      ),
    }),
  /STOREFRONT_PRECACHE_ADMIN_ENTRY_FORBIDDEN:assets\/Admin-ccc\.js/,
);

assert.throws(
  () =>
    assertStorefrontPrecacheClosure({
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
assert.doesNotThrow(() =>
  assertStorefrontImageRuntimePolicy(unminifiedRuntimePolicy),
);

assert.throws(
  () =>
    assertStorefrontImageRuntimePolicy(
      runtimePolicy.replace("NetworkOnly", "CacheFirst"),
    ),
  /STOREFRONT_SW_PRIVATE_IMAGE_CACHE_FORBIDDEN/,
);
assert.throws(
  () =>
    assertStorefrontImageRuntimePolicy(
      runtimePolicy.replace("inventory-product", "product"),
    ),
  /STOREFRONT_SW_PRIVATE_IMAGE_POLICY_INVALID:inventory-product/,
);

assert.doesNotThrow(() =>
  assertStorefrontPrecacheNavigationPolicy(
    "precacheAndRoute(self.__WB_MANIFEST,{directoryIndex:null})",
  ),
);
assert.doesNotThrow(() =>
  assertStorefrontPrecacheNavigationPolicy(
    'precacheAndRoute(self.__WB_MANIFEST, { "directoryIndex": null })',
  ),
);
assert.throws(
  () =>
    assertStorefrontPrecacheNavigationPolicy(
      "precacheAndRoute(self.__WB_MANIFEST,{})",
    ),
  /STOREFRONT_SW_DIRECTORY_INDEX_MUST_BE_NULL/,
);

console.log("storefront PWA build contract test: OK");

// Split output names may be shared with public lazy components without a src key.
const isolatedManifest = structuredClone(manifest);
isolatedManifest["storefront.html"] = isolatedManifest["index.html"];
delete isolatedManifest["index.html"];
isolatedManifest["_Storefront-bbb.js"] = {
  ...isolatedManifest["src/pages/Storefront.tsx"],
  name: "Storefront",
};
delete isolatedManifest["_Storefront-bbb.js"].src;
delete isolatedManifest["src/pages/Storefront.tsx"];
assertStorefrontPrecacheClosure({
  manifest: isolatedManifest,
  swSource: completeSw,
});
