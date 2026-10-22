// Local-only, non-financial fixture. Run with Node20 --import tsx.
import assert from "node:assert/strict";
import express from "express";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createHashedStaticAssets } from "../server/staticAssets.ts";
import {
  createOverloadGuard,
  startLagMonitor,
} from "../server/middleware/overloadGuard.ts";
import { createLogger } from "../server/logger.ts";

assert.equal(
  process.versions.node.split(".")[0],
  "20",
  "Use the pinned Node20 runtime",
);
assert.equal(process.env.NODE_ENV, "production", "Keep logger in JSON mode");
const fixture = await mkdtemp(path.join(os.tmpdir(), "erp-asset-cause-"));
const publicRoot = path.join(fixture, "public");
const requestsPerTrial = 104;
const intervalMs = 40; // 25 misses/s; observed 0510 aggregate was about 25/s.
await mkdir(path.join(publicRoot, "assets"), { recursive: true });
await writeFile(
  path.join(publicRoot, "assets", "present-fixture.js"),
  "export const fixture = true;",
);

function get(port, url) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: url, agent: false, timeout: 5000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
        res.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("Local fixture request timeout")),
    );
    req.on("error", reject);
    req.end();
  });
}

async function trial(mode, sequence) {
  const logPath = path.join(fixture, `trial-${sequence}.log`);
  const output = createWriteStream(logPath);
  const logger = createLogger({ pretty: false, destination: output });
  let globalErrors = 0;
  let peakSmoothedLagMs = 0;
  const lagMonitor = startLagMonitor(); // The production 500ms sample and EWMA.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  const sampler = setInterval(() => {
    peakSmoothedLagMs = Math.max(peakSmoothedLagMs, lagMonitor.lagMs());
  }, 25);
  const app = express();
  app.use(
    createOverloadGuard({
      lagMs: lagMonitor.lagMs,
      maxLagMs: 500,
      skip: (req) => req.path.startsWith("/assets/"),
      onShed: (_req, res) => res.status(503).end("shed"),
    }),
  );
  // A constant non-financial canary, with no application/DB bootstrap.
  app.get("/fixture/api-read", (_req, res) => res.end("fixture"));
  if (mode === "before") {
    // Exact /assets options from c707 server/vite.ts, before this patch.
    app.use(
      "/assets",
      express.static(path.join(publicRoot, "assets"), {
        immutable: true,
        maxAge: "1y",
        index: false,
        fallthrough: false,
      }),
    );
  } else {
    app.use(createHashedStaticAssets(publicRoot));
  }
  app.use((_req, res) => res.status(200).end("SPA fixture"));
  app.use((err, _req, res, _next) => {
    globalErrors++;
    logger.error({ err }, "unhandled express error");
    res
      .status(err.status ?? err.statusCode ?? 500)
      .json({ error: "fixture error" });
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const assetStatuses = {};
  const canaryStatuses = {};
  const started = performance.now();
  const cpuBefore = process.cpuUsage();
  loopDelay.enable();
  try {
    for (let n = 0; n < requestsPerTrial; n++) {
      const wait = started + n * intervalMs - performance.now();
      if (wait > 0) await delay(wait);
      const [asset, canary] = await Promise.all([
        get(port, `/assets/missing-fixture-${n % 13}.js`),
        get(port, "/fixture/api-read"),
      ]);
      assetStatuses[asset] = (assetStatuses[asset] ?? 0) + 1;
      canaryStatuses[canary] = (canaryStatuses[canary] ?? 0) + 1;
    }
    peakSmoothedLagMs = Math.max(peakSmoothedLagMs, lagMonitor.lagMs());
    const cpu = process.cpuUsage(cpuBefore);
    assert.deepEqual(assetStatuses, { 404: requestsPerTrial });
    assert.deepEqual(canaryStatuses, { 200: requestsPerTrial });
    assert.equal(globalErrors, mode === "before" ? requestsPerTrial : 0);
    await new Promise((resolve, reject) =>
      output.end((err) => (err ? reject(err) : resolve())),
    );
    return {
      sequence,
      mode,
      requestsPerTrial,
      targetMissingRequestsPerSecond: 1000 / intervalMs,
      elapsedMs: performance.now() - started,
      assetStatuses,
      canaryStatuses,
      globalErrors,
      errorLogBytes: (await stat(logPath)).size,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      peakSmoothedLagMs,
      peakLoopDelayMs: loopDelay.max / 1e6,
    };
  } finally {
    loopDelay.disable();
    clearInterval(sampler);
    lagMonitor.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    if (!output.writableEnded) output.end();
  }
}

try {
  // ABBA limits first-run/order bias; timing is evidence, not a pass threshold.
  const trials = [];
  for (const mode of ["before", "after", "after", "before"]) {
    trials.push(await trial(mode, trials.length + 1));
  }
  const report = {
    at: new Date().toISOString(),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    sourceBase: "c7074ecbc0e8030ccb066dfc11e22d9c0dc22dde",
    purpose:
      "Falsify missing-asset error logging as a sufficient lag/503 mechanism in a bounded local fixture",
    safety: {
      loopbackOnly: true,
      databaseImports: false,
      databaseQueries: false,
      financialFixtures: false,
      productionRequests: false,
      forcedGc: false,
      busyWait: false,
      injectedLag: false,
      thresholdsChanged: false,
    },
    limits: [
      "Windows single-process fixture, not the production Linux/PM2/nginx stack",
      "Synthetic public files and constant canary; no application startup, credentials or DB",
      "Real logger/async local file output; production pipe/disk backpressure and environment are not reproduced",
      "One worker sees the aggregate observed missing-file rate; no throughput/P95/production acceptance claim",
    ],
    trials,
    result: {
      expected404EscapedBefore: 208,
      expected404EscapedAfter: 0,
      local503Reproduced: trials.some((t) => t.canaryStatuses[503]),
      productionLag503RootCauseResolved: false,
      productionAcceptanceGranted: false,
    },
  };
  const reportPath = path.resolve("docs/runtime-asset-miss-20261021.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ reportPath, ...report }));
} finally {
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("erp-asset-cause-"));
  await rm(fixture, { recursive: true });
}
