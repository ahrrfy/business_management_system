#!/usr/bin/env node

import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ORIGINS = [
  "https://srv1548487.hstgr.cloud",
  "https://alarabiya.online",
];

function normalizeOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("STOREFRONT_SMOKE_ORIGIN_INVALID");
  }
  return url.origin;
}

function positiveInteger(raw, fallback, code) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
  return value;
}

function trpcUrl(origin, procedure, json) {
  const input = encodeURIComponent(JSON.stringify({ json }));
  return `${origin}/api/trpc/${procedure}?input=${input}`;
}

function smokeError(code, origin, target, detail = "") {
  const suffix = detail ? `:${detail}` : "";
  return new Error(`${code}:${new URL(origin).hostname}:${target}${suffix}`);
}

async function fetchChecked(fetchImpl, url, target, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: target === "page" ? "text/html" : "application/json",
        "User-Agent": "Alroya-Deploy-Storefront-Smoke/1.0",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw smokeError("STOREFRONT_SMOKE_TIMEOUT", url, target);
    }
    throw smokeError("STOREFRONT_SMOKE_NETWORK", url, target);
  }
  if (!response.ok) throw smokeError("STOREFRONT_SMOKE_HTTP", url, target, String(response.status));
  return response;
}

async function readTrpcJson(fetchImpl, origin, procedure, json, timeoutMs) {
  const response = await fetchChecked(fetchImpl, trpcUrl(origin, procedure, json), procedure, timeoutMs);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw smokeError("STOREFRONT_SMOKE_JSON_INVALID", origin, procedure);
  }
  const data = payload?.result?.data?.json;
  if (data === undefined) throw smokeError("STOREFRONT_SMOKE_TRPC_SHAPE_INVALID", origin, procedure);
  return data;
}

export async function verifyStorefrontOrigin(rawOrigin, options = {}) {
  const origin = normalizeOrigin(rawOrigin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(options.timeoutMs, 10_000, "STOREFRONT_SMOKE_TIMEOUT_INVALID");
  const minCategories = positiveInteger(options.minCategories, 1, "STOREFRONT_SMOKE_MIN_CATEGORIES_INVALID");
  const minProducts = positiveInteger(options.minProducts, 1, "STOREFRONT_SMOKE_MIN_PRODUCTS_INVALID");

  const pageResponse = await fetchChecked(fetchImpl, `${origin}/store`, "page", timeoutMs);
  const page = await pageResponse.text();
  if (!/<div\s+id=["']root["']><\/div>/i.test(page)) {
    throw smokeError("STOREFRONT_SMOKE_SPA_INVALID", origin, "page");
  }

  const [settings, categories, catalog] = await Promise.all([
    readTrpcJson(fetchImpl, origin, "storefront.settings", null, timeoutMs),
    readTrpcJson(fetchImpl, origin, "storefront.categories", null, timeoutMs),
    readTrpcJson(fetchImpl, origin, "storefront.catalog", { limit: minProducts }, timeoutMs),
  ]);

  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw smokeError("STOREFRONT_SMOKE_SETTINGS_INVALID", origin, "storefront.settings");
  }
  if (!Number.isSafeInteger(settings.fulfillmentBranchId) || settings.fulfillmentBranchId < 1) {
    throw smokeError("STOREFRONT_SMOKE_SETTINGS_NOT_READY", origin, "storefront.settings");
  }
  if (!Array.isArray(categories)) {
    throw smokeError("STOREFRONT_SMOKE_CATEGORIES_INVALID", origin, "storefront.categories");
  }
  if (categories.length < minCategories) {
    throw smokeError("STOREFRONT_SMOKE_CATEGORIES_EMPTY", origin, "storefront.categories", String(categories.length));
  }
  if (categories.some((category) =>
    !category ||
    !Number.isSafeInteger(category.id) ||
    category.id < 1 ||
    typeof category.name !== "string" ||
    category.name.trim() === "" ||
    !Number.isSafeInteger(category.productCount) ||
    category.productCount < 1
  )) {
    throw smokeError("STOREFRONT_SMOKE_CATEGORIES_INVALID", origin, "storefront.categories");
  }
  if (!catalog || !Array.isArray(catalog.items)) {
    throw smokeError("STOREFRONT_SMOKE_CATALOG_INVALID", origin, "storefront.catalog");
  }
  if (catalog.items.length < minProducts) {
    throw smokeError("STOREFRONT_SMOKE_CATALOG_EMPTY", origin, "storefront.catalog", String(catalog.items.length));
  }
  if (catalog.items.some((item) => !item || !Number.isSafeInteger(item.productId) || item.productId < 1)) {
    throw smokeError("STOREFRONT_SMOKE_CATALOG_INVALID", origin, "storefront.catalog");
  }

  return {
    origin,
    categories: categories.length,
    products: catalog.items.length,
  };
}

export async function verifyStorefrontOrigins(origins, options = {}) {
  const unique = [...new Set(origins.map(normalizeOrigin))];
  if (unique.length < 2) throw new Error("STOREFRONT_SMOKE_REQUIRES_TWO_ORIGINS");
  const results = [];
  for (const origin of unique) results.push(await verifyStorefrontOrigin(origin, options));
  return results;
}

function fakeStorefrontFetch(overrides = {}) {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/store") {
      return new Response(overrides.page ?? '<!doctype html><html><body><div id="root"></div></body></html>', {
        status: overrides.pageStatus ?? 200,
        headers: { "content-type": "text/html" },
      });
    }
    const procedure = url.pathname.split("/").at(-1);
    const values = {
      "storefront.settings": overrides.settings ?? { isOpen: true, fulfillmentBranchId: 1 },
      "storefront.categories": overrides.categories ?? [{ id: 1, name: "Ready", productCount: 1 }],
      "storefront.catalog": overrides.catalog ?? { items: [{ productId: 1 }] },
    };
    const status = overrides.statuses?.[procedure] ?? 200;
    return new Response(JSON.stringify({ result: { data: { json: values[procedure] } } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

async function selftest() {
  const good = await verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch(), timeoutMs: 100 });
  assert.equal(good.categories, 1);
  assert.equal(good.products, 1);
  const both = await verifyStorefrontOrigins(
    ["https://internal.example", "https://public.example"],
    { fetchImpl: fakeStorefrontFetch(), timeoutMs: 100 },
  );
  assert.deepEqual(both.map((result) => result.origin), ["https://internal.example", "https://public.example"]);
  await assert.rejects(
    () => verifyStorefrontOrigins(["https://store.example", "https://store.example/"], { fetchImpl: fakeStorefrontFetch(), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_REQUIRES_TWO_ORIGINS/,
  );
  await assert.rejects(
    () => verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch({ settings: {} }), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_SETTINGS_NOT_READY/,
  );

  await assert.rejects(
    () => verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch({ statuses: { "storefront.catalog": 403 } }), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_HTTP:store\.example:storefront\.catalog:403/,
  );
  await assert.rejects(
    () => verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch({ categories: [] }), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_CATEGORIES_EMPTY/,
  );
  await assert.rejects(
    () => verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch({ catalog: { items: [] } }), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_CATALOG_EMPTY/,
  );
  await assert.rejects(
    () => verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch({ categories: [{ id: 1, name: "Broken", productCount: 0 }] }), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_CATEGORIES_INVALID/,
  );
  await assert.rejects(
    () => verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch({ catalog: { items: [{ productId: 0 }] } }), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_CATALOG_INVALID/,
  );
  await assert.rejects(
    () => verifyStorefrontOrigin("https://store.example", { fetchImpl: fakeStorefrontFetch({ page: "forbidden" }), timeoutMs: 100 }),
    /STOREFRONT_SMOKE_SPA_INVALID/,
  );
  console.log("storefront external-readiness selftest: OK");
}

async function runExternalSmoke() {
  const origins = (process.env.STOREFRONT_SMOKE_ORIGINS ?? DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const attempts = positiveInteger(process.env.STOREFRONT_SMOKE_ATTEMPTS, 6, "STOREFRONT_SMOKE_ATTEMPTS_INVALID");
  const retryDelayMs = positiveInteger(process.env.STOREFRONT_SMOKE_RETRY_DELAY_MS, 2_000, "STOREFRONT_SMOKE_RETRY_DELAY_INVALID");
  const options = {
    timeoutMs: positiveInteger(process.env.STOREFRONT_SMOKE_TIMEOUT_MS, 10_000, "STOREFRONT_SMOKE_TIMEOUT_INVALID"),
    minCategories: positiveInteger(process.env.STOREFRONT_SMOKE_MIN_CATEGORIES, 1, "STOREFRONT_SMOKE_MIN_CATEGORIES_INVALID"),
    minProducts: positiveInteger(process.env.STOREFRONT_SMOKE_MIN_PRODUCTS, 1, "STOREFRONT_SMOKE_MIN_PRODUCTS_INVALID"),
  };

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const results = await verifyStorefrontOrigins(origins, options);
      for (const result of results) {
        console.log(`storefront readiness: ${new URL(result.origin).hostname} OK categories=${result.categories} products=${result.products}`);
      }
      return;
    } catch (error) {
      lastError = error;
      console.error(`storefront readiness: attempt ${attempt}/${attempts} failed: ${error?.message ?? "STOREFRONT_SMOKE_FAILED"}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw lastError ?? new Error("STOREFRONT_SMOKE_FAILED");
}

async function main() {
  if (process.argv[2] === "--selftest" && process.argv.length === 3) {
    await selftest();
    return;
  }
  if (process.argv.length > 2) throw new Error("STOREFRONT_SMOKE_ARGUMENTS_INVALID");
  await runExternalSmoke();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`storefront readiness: FAILED: ${error?.message ?? "STOREFRONT_SMOKE_FAILED"}`);
    process.exitCode = 1;
  });
}
