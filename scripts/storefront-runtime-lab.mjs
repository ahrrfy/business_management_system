/** Isolated synthetic HTTP lab. Never run against an existing application database. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { createRuntimeLabObservation, validateRuntimeLabObservationFlags } from "./storefront-runtime-lab-observation.mjs";

import { changedPayloadConflictProved, financialEffectTables, seedRuntimeStoreSettings, runtimeLabHeaders, runtimeLabOrderReadback, pendingRuntimeLabOrder, runtimeLabStaffPreflight, runtimeLabSampleSummary } from "./storefront-runtime-lab-contract.mjs";

const database = new URL(process.env.DATABASE_URL ?? "mysql://invalid");
assert.equal(process.env.NODE_ENV, "test", "Lab requires NODE_ENV=test");
assert.equal(database.hostname, "127.0.0.1");
assert.equal(database.port, "33324");
assert.equal(database.pathname, "/erp_storefront_runtime_lab_20261031_test");
assert.equal(process.env.CONTROL_DATABASE_URL || "", "");
const labFlags = validateRuntimeLabObservationFlags(process.env);
for (const key of [
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "INTEGRATIONS_ENCRYPTION_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "FCM_SERVICE_ACCOUNT_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "VAPID_PRIVATE_KEY",
])
  assert.equal(process.env[key] || "", "", `Lab forbids ${key}`);
const action = process.argv[2];
assert.ok(["seed", "worker", "measure", "probe", "reset"].includes(action));
const out = "/evidence";
const label = process.env.RUNTIME_LAB_MODE ?? "unified";
assert.ok(["unified", "split"].includes(label));
const jwtSecret = process.env.JWT_SECRET;
assert.ok(jwtSecret?.length >= 32, "Synthetic JWT secret required");
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (
    action === "worker" &&
    url.href === "https://challenges.cloudflare.com/turnstile/v0/siteverify"
  ) {
    const form = new URLSearchParams(options?.body);
    assert.equal(form.get("response"), "runtime-lab-token");
    return new Response(
      JSON.stringify({
        success: true,
        action: "storefront_order_verify",
        hostname: "lab.invalid",
      }),
      { status: 200 },
    );
  }
  assert.ok(
    url.hostname === "127.0.0.1" && ["3400", "3401", "3402"].includes(url.port),
    "External fetch forbidden",
  );
  return nativeFetch(input, options);
};

if (action === "worker") {
  const observation = labFlags.diagnosticsEnabled ? createRuntimeLabObservation() : null;
  observation?.subscribe();
  observation?.installHttp();
  const mysql = (await import("mysql2/promise")).default;
  const original = mysql.createPool;
  const pools = [];
  mysql.createPool = function (...args) {
    const promisePool = original.apply(this, args);
    const raw = promisePool.pool;
    const metrics = {
      active: 0,
      peak: 0,
      enqueue: 0,
      waitCount: 0,
      waitTotalMs: 0,
      waitMaxMs: 0,
      limit: raw.config.connectionLimit,
    };
    pools.push({ raw, metrics });
    raw.on("acquire", () => {
      metrics.active++;
      metrics.peak = Math.max(metrics.peak, metrics.active);
    });
    raw.on("release", () => {
      metrics.active--;
    });
    raw.on("enqueue", () => {
      metrics.enqueue++;
    });
    const get = raw.getConnection;
    raw.getConnection = function (callback) {
      const start = performance.now();
      return get.call(this, (error, connection) => {
        const elapsed = performance.now() - start;
        metrics.waitCount++;
        metrics.waitTotalMs += elapsed;
        metrics.waitMaxMs = Math.max(metrics.waitMaxMs, elapsed);
        callback(error, connection);
      });
    };
    observation?.instrumentPool(raw);
    return promisePool;
  };
  const file = path.join(out, `${label}-worker-${process.env.PORT}.jsonl`);
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const sample = () => {
    fs.appendFileSync(
      file,
      JSON.stringify({
        at: Date.now(),
        pid: process.pid,
        role: process.env.WEB_RUNTIME_ROLE || "legacy",
        cachePolicy: { enabled: labFlags.readCacheEnabled, index: { ttlMs: 5000, maxEntries: 8 }, suggestions: { ttlMs: 5000, maxEntries: 80 }, candidates: { ttlMs: 30000, maxEntries: 60 }, search: { ttlMs: 30000, maxEntries: 40 }, categories: { ttlMs: 60000, maxEntries: 8 }, sold: { ttlMs: 300000, maxEntries: 120 } },
        diagnostics: observation?.drain() ?? null,
        sourceMapsEnabled: process.sourceMapsEnabled ?? null,
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        eventLoopDelay: {
          unit: "ms",
          resolutionMs: 20,
          samples: eventLoopDelay.count,
          p95: eventLoopDelay.count ? eventLoopDelay.percentile(95) / 1e6 : null,
          p99: eventLoopDelay.count ? eventLoopDelay.percentile(99) / 1e6 : null,
          max: eventLoopDelay.count ? eventLoopDelay.max / 1e6 : null,
        },
        pools: pools.map(({ raw, metrics }) => ({
          ...metrics,
          connections: raw._allConnections?.length,
          free: raw._freeConnections?.length,
          queued: raw._connectionQueue?.length,
        })),
      }) + "\n",
    );
    eventLoopDelay.reset();
  };
  fs.writeFileSync(file, "");
  sample();
  setInterval(sample, 1000).unref();
  process.once("exit", () => { try { sample(); } catch { /* Final diagnostic failure must not change exit semantics. */ } });
  await import("../dist/index.js");
} else {
  const { getDb, getPool, closeDb } = await import("../server/db.ts");
  const s = await import("../drizzle/schema.ts");
  const { sql } = await import("drizzle-orm");
  const db = getDb();
  assert.ok(db);
  if (action === "reset") {
    assert.equal(
      process.env.RUNTIME_LAB_CONFIRM_RESET,
      "dedicated-fixture-only",
    );
    const pool = getPool();
    const connection = await pool.getConnection();
    try {
      const [tables] = await connection.query(
        "SELECT TABLE_NAME name FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?",
        [database.pathname.slice(1), "BASE TABLE"],
      );
      await connection.query("SET FOREIGN_KEY_CHECKS=0");
      for (const { name } of tables) {
        assert.match(name, /^[A-Za-z0-9_]+$/);
        if (!name.startsWith("__drizzle"))
          await connection.query(`TRUNCATE TABLE \`${name}\``);
      }
    } finally {
      await connection.query("SET FOREIGN_KEY_CHECKS=1");
      connection.release();
    }
    console.log(
      JSON.stringify({ reset: true, schema: database.pathname.slice(1) }),
    );
  } else if (action === "seed") {
    await db.transaction(async (db) => {
    for (const table of [s.branches, s.categories, s.users, s.userSessions])
      assert.equal(Number((await db.select({ n: sql`COUNT(*)` }).from(table))[0].n), 0, "Seed requires clean fixture tables");
    assert.equal(
      Number((await db.select({ n: sql`COUNT(*)` }).from(s.products))[0].n),
      0,
      "Seed requires fresh empty lab",
    );
    await db
      .insert(s.branches)
      .values({
        id: 1,
        name: "Runtime synthetic MAIN",
        code: "MAIN",
        type: "MAIN",
      });
    await db
      .insert(s.categories)
      .values({ id: 1, name: "Runtime synthetic category", showInStore: true });
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
          sku: `RUNTIME-${n + 1}`,
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
          quantity: n === 159 ? 1 : 10000,
        })),
      );
    await seedRuntimeStoreSettings(db, s.storeSettings);
    await db
      .insert(s.users)
      .values({
        id: 1,
        openId: "runtime-lab-staff",
        name: "Synthetic staff",
        role: "admin",
        branchId: 1,
        isActive: true,
      });
    await db
      .insert(s.userSessions)
      .values({
        id: 1,
        userId: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    });
    console.log(
      JSON.stringify({ seeded: true, products: 160, lastUnitVariant: 160 }),
    );
  } else {
    const { signSession } = await import("../server/auth/session.ts");
    const token = await signSession(
      1,
      3_600_000,
      { headers: runtimeLabHeaders(undefined, true) },
      undefined,
      undefined,
      1,
    );
    const cookie = `app_session_id=${token}`;
    const superjson = (await import("superjson")).default;
    const publicPorts = label === "split" ? [3402] : [3400, 3401, 3402];
    const staffPorts = label === "split" ? [3400, 3401] : [3400, 3401, 3402];
    let pub = 0,
      staff = 0;
    const samples = [],
      health = [];
    const headers = (authenticated = false) => runtimeLabHeaders(cookie, authenticated);
    const samplesFile = path.join(out, `${label}-http-samples.jsonl`);
    fs.writeFileSync(samplesFile, "");
    async function call(
      procedure,
      input,
      authenticated = false,
      fixedPort,
      mutation = false,
      kind,
    ) {
      const port =
        fixedPort ??
        (authenticated
          ? staffPorts[staff++ % staffPorts.length]
          : publicPorts[pub++ % publicPorts.length]);
      const payload = superjson.serialize(input);
      const start = performance.now();
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/trpc/${procedure}`,
          {
            method: "POST",
            headers: { ...headers(authenticated), ...(kind === "replay" ? { "x-runtime-lab-kind": "replay" } : {}) },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8000),
          },
        );
        const body = await response.json();
        const error = body.error?.json ?? body.error;
        return {
          ok: response.ok && !body.error,
          status: response.status,
          ms: performance.now() - start,
          error: error?.data?.code ?? error?.message,
          value: body.result?.data
            ? superjson.deserialize(body.result.data)
            : null,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          ms: performance.now() - start,
          error: error.message,
        };
      }
    }
    async function run(
      phase,
      kind,
      procedure,
      input,
      authenticated = false,
      fixedPort,
    ) {
      const result = await call(procedure, input, authenticated, fixedPort, false, kind);
      const sample = { phase, kind, ...result, value: undefined };
      samples.push(sample);
      fs.appendFileSync(samplesFile, JSON.stringify(sample) + "\n");
      return result;
    }
    async function snapshot(phase) {
      for (const port of [3400, 3401, 3402]) {
        try {
          health.push({
            phase,
            port,
            body: await (
              await fetch(`http://127.0.0.1:${port}/healthz`, {
                signal: AbortSignal.timeout(3000),
              })
            ).json(),
          });
        } catch (error) {
          health.push({ phase, port, error: error.message });
        }
      }
    }
    const pos = { branchId: 1, tier: "RETAIL", query: "Synthetic", limit: 24 };
    const quoteInput = {
      governorate: "baghdad",
      lines: [{ productUnitId: 1, quantity: 1 }],
    };
    const preflightFile = path.join(out, `${label}-http-preflight.jsonl`);
    fs.writeFileSync(preflightFile, "");
    const recordPreflight = row => fs.appendFileSync(preflightFile, JSON.stringify(row) + "\n");
    await runtimeLabStaffPreflight(staffPorts, port => call("catalog.posList", pos, true, port), row => recordPreflight({ kind: "staff", ...row, value: undefined }));
    // Validate the actual schema projection even when no order exists yet.
    try {
      await runtimeLabOrderReadback(db, s.onlineOrders, `runtime-${label}-fixed-order`);
      recordPreflight({ kind: "order-status-readback", ok: true });
    } catch (error) {
      recordPreflight({ kind: "order-status-readback", ok: false, error: error.message });
      throw error;
    }
    const baselineEffects = async () => {
      const [rows] = await getPool().query(
        `SELECT ${financialEffectTables.map((table) => `(SELECT COUNT(*) FROM ${table}) ${table}`).join(", ")}, (SELECT SUM(quantity) FROM branchStock) stock`,
      );
      return rows[0];
    };
    if (action === "probe") {
      await snapshot("probe");
      const result = await call("catalog.posList", pos, true);
      const release = await fetch(`http://127.0.0.1:${staffPorts[0]}/api/realtime/pwa-quiesce`, {
        method: "POST", headers: headers(true), body: "{}", signal: AbortSignal.timeout(5000),
      });
      console.log(
        JSON.stringify({
          health,
          quiesce: { status: release.status, body: await release.json() },
          staff: { ok: result.ok, status: result.status, error: result.error },
        }),
      );
    } else {
      const eventAbort = new AbortController();
      let eventText = "";
      const eventDeadline = setTimeout(() => eventAbort.abort(), 8000);
      let eventResponse;
      try {
        eventResponse = await fetch(
          `http://127.0.0.1:${staffPorts[0]}/api/realtime/stream`,
          { headers: headers(true), signal: eventAbort.signal },
        );
      } catch (error) {
        recordPreflight({ kind: "staff-sse", ok: false, error: error.message });
        throw error;
      } finally {
        clearTimeout(eventDeadline);
      }
      recordPreflight({ kind: "staff-sse", status: eventResponse.status, ok: eventResponse.status === 200 });
      assert.equal(eventResponse.status, 200, "Authenticated SSE preflight failed");
      const eventTask = (async () => {
        try {
          for await (const chunk of eventResponse.body)
            eventText += Buffer.from(chunk).toString("utf8");
        } catch (error) {
          if (!eventAbort.signal.aborted) eventText += `ERROR:${error.message}`;
        }
      })();
      try {
      const before = await baselineEffects();
      await snapshot("cold");
      for (let n = 0; n < 12; n++)
        await run("quiet", "staff", "catalog.posList", pos, true);
      for (let n = 0; n < 6; n++)
        await run("warmup", "browse", "storefront.catalog", {
          search: "Synthetic",
          limit: 24,
        });
      await snapshot("warm");
      const priced = await call("storefront.quoteOrder", quoteInput);
      assert.ok(priced.ok, `Quiet quotation failed: ${priced.error}`);
      const order = {
        customerName: "Runtime synthetic customer",
        customerPhone: "07700000000",
        governorate: "baghdad",
        addressText: "Synthetic isolated lab",
        clientRequestId: `runtime-${label}-fixed-order`,
        lines: [
          {
            productUnitId: 1,
            quantity: 1,
            expectedUnitPrice: priced.value.lines[0].unitPrice,
          },
        ],
        expectedGrandTotal: priced.value.total,
        turnstileToken: "runtime-lab-token",
      };
      const burst = Array.from({ length: 12 }, (_, lane) =>
        (async () => {
          for (let n = 0; n < 12; n++)
            await run("mixed", "browse", "storefront.catalog", {
              search: `item ${((n * 13 + lane) % 160) + 1}`,
              limit: 24,
            });
        })(),
      );
      const quotes = (async () => {
        for (let n = 0; n < 15; n++) {
          await run(
            "mixed",
            "quote",
            n % 2 ? "storefront.quoteOrderPrivate" : "storefront.quoteOrder",
            quoteInput,
          );
          await delay(20);
        }
      })();
      const staffWork = (async () => {
        for (let n = 0; n < 24; n++) {
          await run("mixed", "staff", "catalog.posList", pos, true);
          await delay(15);
        }
      })();
      const mixedCreate = (async () => {
        await delay(50);
        await run("mixed", "create", "storefront.createOrder", order);
        await run("mixed", "replay", "storefront.createOrder", order);
      })();
      await Promise.all([...burst, quotes, staffWork, mixedCreate]);
      const created = await run(
        "recovery",
        "create",
        "storefront.createOrder",
        order,
      );
      const replayed = await run(
        "recovery",
        "replay",
        "storefront.createOrder",
        order,
      );
      const originalSnapshot = async () => {
        const [orders] = await getPool().query("SELECT * FROM onlineOrders WHERE clientRequestId = ? ORDER BY id", [order.clientRequestId]);
        const [lines] = await getPool().query("SELECT l.* FROM onlineOrderItems l JOIN onlineOrders o ON o.id = l.onlineOrderId WHERE o.clientRequestId = ? ORDER BY l.id", [order.clientRequestId]);
        return { orders, lines };
      };
      const beforeMismatch = await originalSnapshot();
      const mismatched = await run(
        "recovery",
        "changed-payload",
        "storefront.createOrder",
        { ...order, addressText: "Changed synthetic payload" },
      );
      const afterMismatch = await originalSnapshot();
      const lastUnit = await run(
        "recovery",
        "last-unit-quote",
        "storefront.quoteOrder",
        { ...quoteInput, lines: [{ productUnitId: 160, quantity: 1 }] },
      );
      await run(
        "recovery",
        "last-unit-pos-read",
        "catalog.posList",
        { ...pos, query: "item 160" },
        true,
      );
      const lostOrder = {
        ...order,
        clientRequestId: `runtime-${label}-lost-response`,
      };
      await new Promise((resolve, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${publicPorts[0]}/api/trpc/storefront.createOrder`,
          { method: "POST", headers: headers() },
          (response) => {
            response.destroy(); // The transaction has replied; discard the entire response body.
            resolve();
          },
        );
        request.setTimeout(8000, () =>
          request.destroy(new Error("Lost-response probe timeout")),
        );
        request.on("error", reject);
        request.end(JSON.stringify(superjson.serialize(lostOrder)));
      });
      const recoveredLost = await run(
        "recovery",
        "lost-after-commit",
        "storefront.createOrder",
        lostOrder,
      );
      const beforeSend = {
        ...order,
        clientRequestId: `runtime-${label}-before-send`,
      };
      const cancelled = httpRequest(
        `http://127.0.0.1:${publicPorts[0]}/api/trpc/storefront.createOrder`,
        { method: "POST", headers: headers() },
      );
      cancelled.on("error", () => {});
      cancelled.destroy(); // No body sent: definitively before commit.
      const [beforeRows] = await getPool().query(
        "SELECT id FROM onlineOrders WHERE clientRequestId = ?",
        [beforeSend.clientRequestId],
      );
      assert.equal(beforeRows.length, 0);
      const recoveredBefore = await run(
        "recovery",
        "lost-before-send",
        "storefront.createOrder",
        beforeSend,
      );
      await delay(300);
      eventAbort.abort();
      await eventTask;
      const after = await baselineEffects();
      const orders = await runtimeLabOrderReadback(db, s.onlineOrders, order.clientRequestId);
      await snapshot("idle");
      const summarize = (phase, kind) => {
        const rows = samples.filter(
          (r) => r.phase === phase && r.kind === kind,
        );
        return runtimeLabSampleSummary(rows);
      };
      const quiet = summarize("quiet", "staff"),
        mixed = summarize("mixed", "staff");
      const validStaffLatency = quiet.ok === quiet.total && mixed.ok === mixed.total && quiet.total > 0 && mixed.total > 0;
      const report = {
        mode: label,
        limitations: [
          "Direct Node test bootstrap; PM2 source-map/daemon overhead is not represented.",
          "Local Siteverify fixture; no provider integration or production capacity proof.",
          "Last-unit POS is a read interaction, not a committed POS sale.",
          "Before-commit loss is cancelled before sending; mid-transaction loss not injected.",
          "External process restart is a separate probe.",
        ],
        summary: {
          quietStaff: quiet,
          mixedStaff: mixed,
          validStaffLatency,
          staffP95Degradation: validStaffLatency ? mixed.p95Ms / quiet.p95Ms - 1 : null,
          quote: summarize("mixed", "quote"),
          create: summarize("mixed", "create"),
          replay: summarize("mixed", "replay"),
          browse: summarize("mixed", "browse"),
        },
        invariants: {
          before,
          after,
          unchangedEffects: JSON.stringify(before) === JSON.stringify(after),
          orders,
          orderPending: pendingRuntimeLabOrder(orders, order.clientRequestId),
          created: created.ok,
          replayed: replayed.ok && replayed.value?.idempotentReplay === true,
          changedPayloadRejected: changedPayloadConflictProved(mismatched, beforeMismatch, afterMismatch, order),
          changedPayloadEvidence: { response: mismatched, before: beforeMismatch, after: afterMismatch },
          lastUnitQuoted: lastUnit.ok,
          recoveredLost:
            recoveredLost.ok && recoveredLost.value?.idempotentReplay === true,
          recoveredBefore: recoveredBefore.ok,
          adminOrderEventSeen: eventText.includes("STOREFRONT_ORDER_PLACED"),
        },
        health,
        samples,
      };
      fs.writeFileSync(
        path.join(out, `${label}-http-report.json`),
        JSON.stringify(report, null, 2),
      );
      console.log(
        JSON.stringify({
          mode: label,
          summary: report.summary,
          invariants: report.invariants,
        }),
      );
      } finally {
        eventAbort.abort();
        await eventTask;
      }
    }
  }
  await closeDb();
}
