import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STOREFRONT_SOURCE = "src/pages/Storefront.tsx";
const INDEX_SOURCE = "index.html";

function normalizedUrl(value) {
  return String(value ?? "").replace(/^\.\//, "").replace(/^\//, "");
}

export function precacheUrlsFromServiceWorker(swSource) {
  const urls = new Set();
  const matcher = /(?:^|[{,])\s*(?:url|["']url["'])\s*:\s*(["'])(.*?)\1/g;
  for (const match of swSource.matchAll(matcher)) {
    urls.add(normalizedUrl(match[2].replace(/\\\//g, "/")));
  }
  return urls;
}

function manifestKeyForSource(manifest, source) {
  if (manifest[source]) return source;
  return Object.entries(manifest).find(([, entry]) => entry?.src === source)?.[0] ?? null;
}

function staticImportClosure(manifest, roots) {
  const visited = new Set();
  const requiredFiles = new Set();

  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry || typeof entry.file !== "string") {
      throw new Error(`STOREFRONT_PRECACHE_MANIFEST_IMPORT_INVALID:${key}`);
    }
    requiredFiles.add(normalizedUrl(entry.file));
    for (const importedKey of entry.imports ?? []) visit(importedKey);
  }

  for (const root of roots) visit(root);
  return [...requiredFiles].sort();
}

export function assertStorefrontPrecacheClosure({ manifest, swSource }) {
  const indexKey = manifestKeyForSource(manifest, INDEX_SOURCE);
  const storefrontKey = manifestKeyForSource(manifest, STOREFRONT_SOURCE);
  if (!indexKey) throw new Error("STOREFRONT_PRECACHE_INDEX_ENTRY_MISSING");
  if (!storefrontKey) throw new Error("STOREFRONT_PRECACHE_STOREFRONT_ENTRY_MISSING");

  const requiredFiles = staticImportClosure(manifest, [indexKey, storefrontKey]);
  const precachedUrls = precacheUrlsFromServiceWorker(swSource);
  const missing = requiredFiles.filter((file) => !precachedUrls.has(file));
  if (missing.length > 0) {
    throw new Error(`STOREFRONT_PRECACHE_STATIC_IMPORT_MISSING:${missing.join(",")}`);
  }

  const heavyAsset = [...precachedUrls].find((url) =>
    /(?:^|\/)ort-[^/]*\.wasm$/i.test(url) ||
    url.includes("/imgly-assets/") ||
    url.startsWith("imgly-assets/"),
  );
  if (heavyAsset) {
    throw new Error(`STOREFRONT_PRECACHE_HEAVY_ASSET_FORBIDDEN:${heavyAsset}`);
  }

  const forbiddenAdminEntry = Object.entries(manifest)
    .filter(([key, entry]) => {
      const source = entry?.src ?? key;
      return entry?.isDynamicEntry === true &&
        /^src\/pages\//.test(source) &&
        source !== STOREFRONT_SOURCE;
    })
    .map(([, entry]) => normalizedUrl(entry.file))
    .find((file) => precachedUrls.has(file));
  if (forbiddenAdminEntry) {
    throw new Error(`STOREFRONT_PRECACHE_ADMIN_ENTRY_FORBIDDEN:${forbiddenAdminEntry}`);
  }

  return {
    requiredFiles,
    precacheCount: precachedUrls.size,
  };
}

function routeSegmentForCache(swSource, cacheName) {
  const escapedCacheName = cacheName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cacheProperty = new RegExp(
    `(?:^|[,{])\\s*(?:cacheName|["']cacheName["'])\\s*:\\s*(?:"${escapedCacheName}"|'${escapedCacheName}')`,
  );
  const cacheMatch = cacheProperty.exec(swSource);
  if (!cacheMatch) throw new Error(`STOREFRONT_SW_ROUTE_MISSING:${cacheName}`);
  const cacheIndex = cacheMatch.index;
  const routeStart = swSource.lastIndexOf("registerRoute", cacheIndex);
  const routeEnd = swSource.indexOf("registerRoute", cacheIndex + cacheName.length);
  if (routeStart < 0) throw new Error(`STOREFRONT_SW_ROUTE_INVALID:${cacheName}`);
  return {
    start: routeStart,
    source: swSource.slice(routeStart, routeEnd < 0 ? swSource.length : routeEnd),
  };
}

export function assertStorefrontImageRuntimePolicy(swSource) {
  const privateRoute = routeSegmentForCache(swSource, "private-images-no-cache");
  const publicRoute = routeSegmentForCache(swSource, "store-images");
  const apiRoute = routeSegmentForCache(swSource, "api-no-cache");

  if (privateRoute.source.includes("CacheFirst")) {
    throw new Error("STOREFRONT_SW_PRIVATE_IMAGE_CACHE_FORBIDDEN");
  }
  for (const marker of ["inventory-product", "count-product", "kiosk-product", "NetworkOnly"]) {
    if (!privateRoute.source.includes(marker)) {
      throw new Error(`STOREFRONT_SW_PRIVATE_IMAGE_POLICY_INVALID:${marker}`);
    }
  }

  for (const marker of ["banner", "product", "company", "CacheFirst"]) {
    if (!publicRoute.source.includes(marker)) {
      throw new Error(`STOREFRONT_SW_PUBLIC_IMAGE_POLICY_INVALID:${marker}`);
    }
  }
  for (const marker of ["inventory-product", "count-product", "kiosk-product"]) {
    if (publicRoute.source.includes(marker)) {
      throw new Error(`STOREFRONT_SW_PRIVATE_IMAGE_IN_PUBLIC_CACHE:${marker}`);
    }
  }

  if (!apiRoute.source.includes("NetworkOnly") ||
      !(privateRoute.start < publicRoute.start && publicRoute.start < apiRoute.start)) {
    throw new Error("STOREFRONT_SW_API_FALLBACK_ORDER_INVALID");
  }
}

export function verifyStorefrontPwaBuild(buildDirectory) {
  const manifestPath = path.join(buildDirectory, ".vite", "manifest.json");
  const serviceWorkerPath = path.join(buildDirectory, "sw.js");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const swSource = fs.readFileSync(serviceWorkerPath, "utf8");
  const result = assertStorefrontPrecacheClosure({ manifest, swSource });
  assertStorefrontImageRuntimePolicy(swSource);
  return result;
}

async function main() {
  if (process.argv.length > 3) throw new Error("STOREFRONT_PRECACHE_ARGUMENTS_INVALID");
  const buildDirectory = path.resolve(process.argv[2] ?? "dist/public");
  const result = verifyStorefrontPwaBuild(buildDirectory);
  console.log(
    `storefront PWA artifact: OK static=${result.requiredFiles.length} precache=${result.precacheCount}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`storefront PWA artifact: FAILED: ${error?.message ?? "UNKNOWN"}`);
    process.exitCode = 1;
  });
}
