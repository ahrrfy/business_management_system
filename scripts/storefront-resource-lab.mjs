/** Synthetic, bounded actual-service measurement. Run only through the isolated lab runner. */
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const url = new URL(process.env.DATABASE_URL ?? "mysql://invalid");
if (
  url.hostname !== "127.0.0.1" ||
  url.port !== "33324" ||
  url.pathname !== "/erp_storefront_resources_lab_20261030_test"
)
  throw new Error("Only the dedicated isolated lab schema is allowed");
// Defense in depth: no actual external integrations even if a transitive path changes.
globalThis.fetch = async () => {
  throw new Error("External fetch forbidden in resource lab");
};
const mode = process.argv[2] ?? "baseline";
if (!["baseline", "observe", "enforce"].includes(mode))
  throw new Error("Invalid lab mode");
process.env.STOREFRONT_RESOURCE_MODE = mode === "baseline" ? "observe" : mode;
const { getDb, getPool, closeDb } = await import("../server/db.ts");
const s = await import("../drizzle/schema.ts");
const { sql } = await import("drizzle-orm");
const {
  storefrontCatalog,
  storefrontCategories,
  storefrontOffers,
  storefrontCacheResourceMetrics,
} = await import("../server/services/storefrontService.ts");
const { getStorefrontThematicCollections } =
  await import("../server/services/storefrontThematicService.ts");
const { listActiveBanners } =
  await import("../server/services/storeAdmin/bannerService.ts");
const { getPublicStoreSettings } =
  await import("../server/services/storeAdmin/storeSettingsService.ts");
const { publicBatchCost } =
  await import("../server/middleware/storefrontAdmission.ts");
const { listForPos } = await import("../server/services/catalog/pos.ts");
const { quoteOnlineOrder, createOnlineOrder, findOwnedOnlineOrderReplay } =
  await import("../server/services/onlineOrderService.ts");
const { createVerifiedStorefrontOrder } =
  await import("../server/services/storefrontOrderGate.ts");
const { createResourceAdmission, STOREFRONT_RESOURCE_CANDIDATE } =
  await import("../server/lib/resourceAdmission.ts");
const db = getDb();
if (!db) throw new Error("Lab database missing");
const count = Number(
  (await db.select({ n: sql`COUNT(*)` }).from(s.products))[0].n,
);
if (count === 0) {
  await db
    .insert(s.branches)
    .values({ id: 1, name: "Synthetic MAIN", code: "MAIN", type: "MAIN" });
  await db
    .insert(s.categories)
    .values({ id: 1, name: "Synthetic category", showInStore: true });
  await db
    .insert(s.products)
    .values(
      Array.from({ length: 160 }, (_, n) => ({
        id: n + 1,
        categoryId: 1,
        name: `Synthetic قلم item ${n + 1}`,
        showInStore: true,
      })),
    );
  await db
    .insert(s.productVariants)
    .values(
      Array.from({ length: 160 }, (_, n) => ({
        id: n + 1,
        productId: n + 1,
        sku: `LAB-${n + 1}`,
        costPrice: "1.00",
      })),
    );
  await db
    .insert(s.productUnits)
    .values(
      Array.from({ length: 160 }, (_, n) => ({
        id: n + 1,
        variantId: n + 1,
        unitName: "piece",
        isBaseUnit: true,
        isStoreSaleUnit: true,
      })),
    );
  await db
    .insert(s.productPrices)
    .values(
      Array.from({ length: 160 }, (_, n) => ({
        productUnitId: n + 1,
        priceTier: "RETAIL",
        price: "1000.00",
      })),
    );
  await db
    .insert(s.branchStock)
    .values(
      Array.from({ length: 160 }, (_, n) => ({
        variantId: n + 1,
        branchId: 1,
        quantity: 10000,
      })),
    );
}
await db
  .insert(s.storeSettings)
  .values({ id: 1, fulfillmentBranchId: 1, isOpen: true })
  .onDuplicateKeyUpdate({ set: { fulfillmentBranchId: 1, isOpen: true } });
// Production-like cache path; environment still has synthetic URL and no network.
process.env.NODE_ENV = "development";
const rawPool = getPool();
const pool = rawPool.pool;
let acquired = 0,
  peakAcquired = 0,
  enqueues = 0;
pool.on("acquire", () => {
  acquired++;
  peakAcquired = Math.max(peakAcquired, acquired);
});
pool.on("release", () => {
  acquired--;
});
pool.on("enqueue", () => {
  enqueues++;
});
const waits = [];
const originalGetConnection = pool.getConnection;
pool.getConnection = function (callback) {
  const start = performance.now();
  return originalGetConnection.call(this, (err, conn) => {
    waits.push(performance.now() - start);
    callback(err, conn);
  });
};
const operationProcedures = {
  startup: [
    "storefront.categories",
    "storefront.offers",
    "storefront.banners",
    "storefront.settings",
    "storefront.catalog",
    "storefront.thematicCollections",
  ],
  staff: ["catalog.posList"],
  purchase: ["storefront.quoteOrder"],
  create: ["storefront.createOrder"],
  replay: ["storefront.createOrder"],
  search: ["storefront.catalog"],
};
const operationAdmission = Object.fromEntries(
  Object.entries(operationProcedures).map(([name, procedures]) => [
    name,
    publicBatchCost(procedures) ?? { lane: "staff", cost: 1 },
  ]),
);
const gate =
  mode === "baseline"
    ? null
    : createResourceAdmission({
        mode,
        ...STOREFRONT_RESOURCE_CANDIDATE,
      });
const samples = [],
  memory = [],
  cacheSamples = [];
const sampleCaches = (phase) => {
  cacheSamples.push({
    phase,
    atMs: Math.round(performance.now()),
    caches: storefrontCacheResourceMetrics(),
  });
};
const mem = (phase) => {
  sampleCaches(phase);
  memory.push({
    phase,
    atMs: Math.round(performance.now()),
    ...process.memoryUsage(),
  });
};
const run = async (kind, label, work) => {
  const start = performance.now();
  const operation = label === "create" || label === "replay" ? label : kind;
  const reservation = operationAdmission[operation];
  const identity = {
    procedures: operationProcedures[operation],
    ...reservation,
  };
  let ticket;
  try {
    ticket = await gate?.acquire(reservation.lane, reservation.cost);
    await work();
    samples.push({
      kind,
      label,
      ...identity,
      ok: true,
      ms: performance.now() - start,
    });
  } catch (error) {
    samples.push({
      kind,
      label,
      ...identity,
      ok: false,
      reason: error.reason ?? error.message,
      ms: performance.now() - start,
    });
    if (!error.reason) throw error;
  } finally {
    ticket?.release();
  }
};
const quote = () =>
  quoteOnlineOrder({
    governorate: "baghdad",
    lines: [{ productUnitId: 1, quantity: 1 }],
  });
const staff = () => listForPos(1, "RETAIL", "Synthetic", 30);
const search = (n) =>
  storefrontCatalog({ search: `قلم item ${n % 10}`, limit: 30 });
const cpu = process.cpuUsage(),
  wall = performance.now();
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
mem("start");
// Fixed aggregate cache names only; sampled peaks can miss shorter spikes.
const cacheSamplingIntervalMs = 100;
const cacheSampler = setInterval(
  () => sampleCaches("interval"),
  cacheSamplingIntervalMs,
);
cacheSampler.unref();
const startup = () =>
  Promise.all([
    storefrontCategories(),
    storefrontOffers(),
    listActiveBanners(),
    getPublicStoreSettings(),
    storefrontCatalog({ limit: 30 }),
    getStorefrontThematicCollections(),
  ]);
await run("startup", "cold", startup);
await run("startup", "warm", startup);
for (let n = 0; n < 8; n++) {
  await run("staff", n ? "warm" : "cold", staff);
  await run("purchase", n ? "warm" : "cold", quote);
  await run("search", n ? "warm" : "cold", () => search(1));
}
for (let round = 0; round < 5; round++) {
  await Promise.all([
    ...Array.from({ length: 12 }, (_, n) =>
      run("search", "mixed", () => search(n)),
    ),
    ...Array.from({ length: 3 }, () => run("staff", "mixed", staff)),
    ...Array.from({ length: 3 }, () => run("purchase", "mixed", quote)),
  ]);
  mem(`burst-${round}`);
}
// Real owned replay after success with the original response deliberately discarded.
let verified = 0;
const orderInput = {
  customerName: "Synthetic customer",
  customerPhone: "07700000000",
  governorate: "baghdad",
  addressText: "Synthetic lab address",
  clientRequestId: `lab-${mode}-${Date.now()}`,
  lines: [{ productUnitId: 1, quantity: 1 }],
};
const dependencies = {
  findOwnedReplay: findOwnedOnlineOrderReplay,
  verifyTurnstile: async () => {
    verified++;
  },
  createOrder: createOnlineOrder,
};
let initial;
await run("purchase", "create", async () => {
  initial = await createVerifiedStorefrontOrder(
    orderInput,
    "mock-only-token",
    dependencies,
  );
});
let replay;
await run("purchase", "replay", async () => {
  replay = await createVerifiedStorefrontOrder(
    orderInput,
    "same-mock-token",
    dependencies,
  );
});
assert.equal(initial.orderId, replay.orderId);
assert.equal(replay.idempotentReplay, true);
assert.equal(verified, 1);
for (let n = 0; n < 3; n++) {
  await delay(300);
  mem(`idle-${n}`);
}
clearInterval(cacheSampler);
lag.disable();
const pct = (values, p) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
    : null;
const summary = {};
for (const kind of ["startup", "staff", "purchase", "search"])
  for (const label of ["cold", "warm", "mixed", "create", "replay"]) {
    const rows = samples.filter((r) => r.kind === kind && r.label === label);
    if (rows.length)
      summary[`${kind}.${label}`] = {
        attempted: rows.length,
        completed: rows.filter((r) => r.ok).length,
        rejected: rows.filter((r) => !r.ok).length,
        p50Ms: pct(
          rows.filter((r) => r.ok).map((r) => r.ms),
          0.5,
        ),
        p95Ms: pct(
          rows.filter((r) => r.ok).map((r) => r.ms),
          0.95,
        ),
      };
  }
const status = await rawPool.query(
  "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running')",
);
const output = {
  mode,
  node: process.version,
  operationAdmission,
  operationProcedures,
  policy: gate?.policy ?? null,
  contextMeasured: false,
  mysqlMemoryLimitMiB: 1536,
  fixture: { products: 160, bundles: 0, images: 0 },
  summary,
  cpu: process.cpuUsage(cpu),
  wallMs: performance.now() - wall,
  eventLoopP95Ms: lag.percentile(95) / 1e6,
  sql: {
    peakAcquired,
    enqueues,
    connectionWaitP95Ms: pct(waits, 0.95),
    status: status[0],
  },
  admission: gate?.snapshot() ?? null,
  replay: {
    sameOrder: true,
    verifies: verified,
    idempotentReplay: replay.idempotentReplay,
  },
  memory,
  caches: {
    samplingIntervalMs: cacheSamplingIntervalMs,
    sampledPeak: Object.fromEntries(
      ["candidates", "search", "categories", "sold"].map((name) => [
        name,
        {
          inFlight: Math.max(
            ...cacheSamples.map((sample) => sample.caches[name].inFlight),
          ),
          rejected: Math.max(
            ...cacheSamples.map((sample) => sample.caches[name].rejected),
          ),
        },
      ]),
    ),
    final: storefrontCacheResourceMetrics(),
    samples: cacheSamples,
  },
  samples,
};
await writeFile(
  `/evidence/lab-classifier-corrected-${mode}.json`,
  JSON.stringify(output, null, 2),
);
console.log(
  JSON.stringify({
    mode,
    summary,
    sql: output.sql,
    admission: output.admission,
    replay: output.replay,
  }),
);
await closeDb();
