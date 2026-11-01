import express from "express";
import { createServer, get, type Server } from "node:http";
import { once } from "node:events";
import { initTRPC } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceAdmission } from "../../lib/resourceAdmission";
import { hasOverfilledPublicSensitiveBatch } from "../publicSensitiveBatch";
import { imageRouter } from "../../imageRoute";
import { createAdminPublicHttpBoundary } from "../runtimeBoundary";

const defaults = vi.hoisted(() => ({ gate: null as ResourceAdmission | null }));
vi.mock("../../lib/resourceAdmission", async (original) => {
  const actual = await original<typeof import("../../lib/resourceAdmission")>();
  return {
    ...actual,
    storefrontResourceAdmission: () =>
      defaults.gate ?? actual.storefrontResourceAdmission(),
  };
});
vi.mock("../../../vite.config", () => ({ default: {} }));
vi.mock("vite", () => ({
  createServer: async () => ({
    middlewares: (_req: unknown, _res: unknown, next: () => void) => next(),
    transformIndexHtml: async (_url: string, html: string) => html,
    ssrFixStacktrace: () => {},
  }),
}));
vi.mock("../../services/storefrontSeoMetaService", () => ({
  injectStorefrontSeoMeta: async (html: string) => html,
}));
vi.mock("../../tenancy/expressMiddleware", () => ({
  companyCodeTenancyMiddleware:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));
import {
  createResourceAdmission,
  ResourceAdmissionError,
  trackResourceTail,
} from "../../lib/resourceAdmission";
import {
  createStorefrontAdmission,
  createPublicImageAdmission,
  publicResourceHandler,
  withStorefrontContextWork,
  withStorefrontProcedureWork,
} from "../storefrontAdmission";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const servers: Server[] = [];
afterEach(async () => {
  defaults.gate = null;
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
async function fixture(
  opts: {
    tenancy?: () => Promise<void>;
    context?: () => Promise<void>;
    load?: () => Promise<void>;
    staffLoad?: () => Promise<void>;
    mode?: "observe" | "enforce";
  } = {},
) {
  const gate = createResourceAdmission({
    mode: opts.mode ?? "enforce",
    maxActiveCost: 6,
    publicMaxActiveCost: 4,
    readMaxActiveCost: 4,
    orderMaxActiveCost: 2,
    maxQueued: 1,
    maxQueuedCost: 2,
    queueTimeoutMs: 30,
  });
  let contexts = 0,
    loads = 0;
  const t = initTRPC
    .context<{
      req: express.Request;
      res: express.Response;
      user: { id: number };
    }>()
    .create();
  const p = t.procedure.use(({ ctx, path, next }) =>
    withStorefrontProcedureWork(
      ctx.req,
      ctx.res,
      path,
      !!ctx.user,
      () => next(),
      gate,
    ),
  );
  const router = t.router({
    storefront: t.router({
      catalog: p.query(async () => {
        loads++;
        await opts.load?.();
        return { ok: true };
      }),
      offers: p.query(() => ({ ok: true })),
      createOrder: p.mutation(() => ({ ok: true })),
      submitProductReview: p.mutation(() => ({ ok: true })),
    }),
    privateRead: p.query(async () => {
      await opts.staffLoad?.();
      return { ok: true };
    }),
  });
  const app = express();
  app.use(express.json());
  app.use("/api/trpc", (req, res, next) => {
    if (hasOverfilledPublicSensitiveBatch(req.path)) res.status(400).end();
    else next();
  });
  app.use("/api/trpc", createStorefrontAdmission(gate));
  if (opts.tenancy)
    app.use("/api/trpc", (req, _res, next) => {
      void withStorefrontContextWork(req, async () => {
        await opts.tenancy?.();
        next();
      }).catch(next);
    });
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router,
      createContext: ({ req, res }) =>
        withStorefrontContextWork(req, async () => {
          contexts++;
          await opts.context?.();
          return { req, res, user: { id: 1 } };
        }),
      maxBatchSize: 20,
    }),
  );
  const server = createServer(app);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  const url = `http://127.0.0.1:${address.port}/api/trpc/`;
  return { gate, url, counts: () => ({ contexts, loads }) };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++)
    await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe("composed admin image admission", () => {
  async function images(cap: number, auth: () => Promise<boolean>) {
    vi.stubEnv("WEB_RUNTIME_ROLE", "admin");
    const gate = createResourceAdmission({ mode: "enforce", maxActiveCost: cap + 4, publicMaxActiveCost: cap + 2, readMaxActiveCost: cap, orderMaxActiveCost: 2, maxQueued: 1, maxQueuedCost: 2, queueTimeoutMs: 80 });
    defaults.gate = gate;
    let loads = 0;
    const app = express();
    app.use("/api/img", createPublicImageAdmission(gate), (req, _res, next) => {
      void withStorefrontContextWork(req, async () => { next(); }).catch(next);
    }, createAdminPublicHttpBoundary(auth), publicResourceHandler(async (_req, res) => { loads++; res.json({ ok: true }); }, 1, gate));
    app.use(createAdminPublicHttpBoundary(auth));
    app.use((_req, res) => res.end());
    const server = createServer(app); servers.push(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    return { url: `http://127.0.0.1:${address.port}`, gate, loads: () => loads };
  }
  it.each([2, 12])("reserves one sequential auth/image peak at read cap %i, queues bounded overflow and releases", async cap => {
    const hold = deferred();
    let auths = 0;
    const f = await images(cap, async () => { auths++; await hold.promise; return true; });
    const count = cap / 2;
    const requests = Array.from({ length: count }, () => fetch(f.url + "/api/img/product/1"));
    try {
      await until(() => auths === count);
      expect(f.gate.snapshot().active["public-read"]).toBe(cap);
      expect(f.gate.snapshot().queued).toBe(0);
      const queued = fetch(f.url + "/api/img/product/1");
      await until(() => f.gate.snapshot().queued === 1);
      const excess = await fetch(f.url + "/api/img/product/1");
      expect(excess.status).toBe(503);
      expect(excess.headers.get("retry-after")).toBe("1");
      hold.resolve();
      expect((await Promise.all([...requests, queued])).map(r => r.status)).toEqual(Array(count + 1).fill(200));
      await until(() => f.gate.snapshot().activeCost === 0);
      expect(f.loads()).toBe(count + 1);
      expect(f.gate.snapshot().queued).toBe(0);
    } finally { hold.resolve(); await Promise.all(requests); }
  });
  it("refuses anonymous images and preserves standalone boundary503/Retry-After", async () => {
    const f = await images(2, async () => false);
    expect((await fetch(f.url + "/api/img/product/1")).status).toBe(404);
    expect(f.loads()).toBe(0);
    const block = await f.gate.acquire("public-read", 2);
    try {
      const response = await fetch(f.url + "/store");
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
    } finally { block.release(); }
    await until(() => f.gate.snapshot().activeCost === 0);
  });
  it("retains the image peak and work drain through disconnected staff verification", async () => {
    const { runtimeWorkDrain } = await import("../../lib/workDrain");
    const hold = deferred(); let authStarted = false;
    const f = await images(2, async () => { authStarted = true; await hold.promise; return true; });
    const req = get(f.url + "/api/img/product/1"); req.on("error", () => {});
    try {
      await until(() => authStarted);
      req.destroy();
      await new Promise(r => setTimeout(r, 10));
      expect(f.gate.snapshot().activeCost).toBe(2);
      let drained = false;
      const drain = runtimeWorkDrain.wait(1000).then(() => { drained = true; });
      await new Promise(r => setImmediate(r));
      expect(drained).toBe(false);
      hold.resolve(); await drain;
      await until(() => f.gate.snapshot().activeCost === 0);
      expect(f.loads()).toBe(0);
    } finally { hold.resolve(); req.destroy(); }
  });
});

describe("actual Express/tRPC resource lifecycle", () => {
  it.each(["observe", "enforce"] as const)(
    "%s handles a real same-type order/review batch before context",
    async (mode) => {
      expect(
        hasOverfilledPublicSensitiveBatch(
          "/storefront.createOrder,storefront.submitProductReview",
        ),
      ).toBe(false);
      const f = await fixture({ mode });
      const response = await fetch(
        `${f.url}storefront.createOrder,storefront.submitProductReview?batch=1`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-staff-priority": "1",
          },
          body: "{}",
        },
      );
      expect(response.status).toBe(mode === "enforce" ? 429 : 200);
      expect(f.counts().contexts).toBe(mode === "enforce" ? 0 : 1);
      expect(
        f.gate.snapshot()[mode === "enforce" ? "rejected" : "wouldReject"],
      ).toBe(1);
      await until(() => f.gate.snapshot().activeCost === 0);
    },
  );
  it("reserves the two-read context peak for a small single public procedure", async () => {
    const first = deferred(),
      second = deferred();
    let started = 0;
    const f = await fixture({
      context: async () => {
        started += 2;
        await Promise.all([first.promise, second.promise]);
      },
    });
    const response = fetch(`${f.url}storefront.offers`);
    await until(() => started === 2);
    const active = f.gate.snapshot().active;
    first.resolve();
    second.resolve();
    expect((await response).status).toBe(200);
    expect(active).toEqual({ "public-read": 2, "public-order": 0, staff: 0 });
    await until(() => f.gate.snapshot().activeCost === 0);
  });
  it.each(["development", "production"])(
    "%s wildcard SPA admits only the original storefront pathname",
    async (mode) => {
      const f = await fixture();
      defaults.gate = f.gate;
      const blocker = await f.gate.acquire("public-read", 4);
      const app = express();
      const { setupVite, serveStatic } = await import("../../vite");
      const server = createServer(app);
      if (mode === "development") await setupVite(app, server);
      else serveStatic(app, `${process.cwd()}/client`);
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("missing address");
      const base = `http://127.0.0.1:${address.port}`;
      try {
        expect((await fetch(`${base}/pos`)).status).toBe(200);
        expect((await fetch(`${base}/reports?view=all`)).status).toBe(200);
        expect((await fetch(`${base}/`)).status).toBe(200);
        expect(f.gate.snapshot().queued).toBe(0);
        const publicRootStatus = await new Promise<number>((resolve, reject) => {
          get(`${base}/`, { headers: { host: "alarabiya.online" } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }).on("error", reject);
        });
        expect(publicRootStatus).toBe(503);
        expect((await fetch(`${base}/store/product/1?view=all`)).status).toBe(
          503,
        );
        expect(f.gate.snapshot().timedOut).toBe(2);
      } finally {
        blocker.release();
      }
    },
  );
  it("actual image-router aliases are admitted before tenant lookup", async () => {
    const f = await fixture();
    defaults.gate = f.gate;
    let tenants = 0;
    const app = express();
    app.use(
      "/api/img",
      createPublicImageAdmission(f.gate),
      (_req, _res, next) => {
        tenants++;
        next();
      },
      imageRouter(),
    );
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}/api/img`;
    const paths = [
      "/product/1/",
      "/Product/1",
      "/COMPANY/demo/Product/1/",
      "/company/demo/product/1/",
      "/Banner/1/main/",
      "/Banner/1/main",
      "/banner/1/main",
    ];
    // Invalid ids prove each alias reaches the actual installed image handler.
    for (const route of paths)
      expect((await fetch(base + route.replace("/1", "/invalid"))).status).toBe(
        400,
      );
    const blocker = await f.gate.acquire("public-read", 4);
    tenants = 0;
    try {
      for (const route of paths)
        expect((await fetch(base + route)).status).toBe(503);
      expect(tenants).toBe(0);
      expect((await fetch(`${base}/inventory-product/invalid/`)).status).toBe(
        400,
      );
      expect(tenants).toBe(1);
    } finally {
      blocker.release();
    }
  });
  it("public image admission covers tenant lookup and retains running work on disconnect", async () => {
    const gate = createResourceAdmission({
      mode: "enforce",
      maxActiveCost: 4,
      publicMaxActiveCost: 3,
      readMaxActiveCost: 2,
      orderMaxActiveCost: 1,
      maxQueued: 1,
      maxQueuedCost: 1,
      queueTimeoutMs: 20,
    });
    const hold = deferred();
    let tenantStarted = false,
      bodyStarted = false;
    const app = express();
    app.use("/api/img", createPublicImageAdmission(gate), (req, _res, next) => {
      void withStorefrontContextWork(req, async () => {
        tenantStarted = true;
        await hold.promise;
        next();
      }).catch(next);
    });
    app.get(
      "/api/img/product/:id",
      publicResourceHandler(
        async (_req, res) => {
          bodyStarted = true;
          res.end("image");
        },
        1,
        gate,
      ),
    );
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    const req = get(`http://127.0.0.1:${address.port}/api/img/product/1`);
    req.on("error", () => {});
    await until(() => tenantStarted);
    req.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.snapshot().activeCost).toBe(1);
    hold.resolve();
    await until(() => gate.snapshot().activeCost === 0);
    expect(bodyStarted).toBe(false);
  });
  it("maps a loader capacity failure through tRPC's result to 503 with Retry-After", async () => {
    const f = await fixture({
      load: async () => {
        throw new ResourceAdmissionError("queue-full");
      },
    });
    const response = await fetch(`${f.url}storefront.catalog`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await until(() => f.gate.snapshot().activeCost === 0);
  });
  it("queued staff disconnect cancels before business work begins", async () => {
    let staffStarted = false;
    const f = await fixture({
      staffLoad: async () => {
        staffStarted = true;
      },
    });
    const blocker = await f.gate.acquire("staff", 6);
    const req = get(`${f.url}privateRead`);
    req.on("error", () => {});
    await until(() => f.gate.snapshot().queued === 1);
    req.destroy();
    await until(() => f.gate.snapshot().queued === 0);
    blocker.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(staffStarted).toBe(false);
    expect(f.gate.snapshot().activeCost).toBe(0);
  });
  it("disconnect during delayed tenancy retains its real promise and blocks later context", async () => {
    const hold = deferred();
    let started = false;
    const f = await fixture({
      tenancy: async () => {
        started = true;
        await hold.promise;
      },
    });
    const req = get(`${f.url}storefront.catalog`);
    req.on("error", () => {});
    await until(() => started);
    req.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(f.gate.snapshot().activeCost).toBe(2);
    hold.resolve();
    await until(() => f.gate.snapshot().activeCost === 0);
    expect(f.counts()).toEqual({ contexts: 0, loads: 0 });
  });
  it("disconnect during auth retains occupancy until real auth settles and blocks later loader", async () => {
    const hold = deferred();
    const f = await fixture({ context: () => hold.promise });
    const req = get(`${f.url}storefront.catalog`);
    req.on("error", () => {});
    await until(() => f.counts().contexts === 1);
    req.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(f.gate.snapshot().activeCost).toBe(2);
    hold.resolve();
    await until(() => f.gate.snapshot().activeCost === 0);
    expect(f.counts().loads).toBe(0);
  });
  it("disconnect during handler retains its ticket until actual work settles", async () => {
    const hold = deferred();
    const f = await fixture({ load: () => hold.promise });
    const req = get(`${f.url}storefront.catalog`);
    req.on("error", () => {});
    await until(() => f.counts().loads === 1);
    req.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(f.gate.snapshot().activeCost).toBe(2);
    hold.resolve();
    await until(() => f.gate.snapshot().activeCost === 0);
  });
  it("mixed authenticated staff/public batch cannot consume staff reserve", async () => {
    const hold = deferred();
    const firstAuthRead = deferred(),
      secondAuthRead = deferred();
    const f = await fixture({
      context: () =>
        Promise.all([firstAuthRead.promise, secondAuthRead.promise]).then(
          () => undefined,
        ),
      load: () => hold.promise,
    });
    const pending = fetch(`${f.url}storefront.catalog,privateRead?batch=1`);
    await until(() => f.counts().contexts === 1);
    expect(f.gate.snapshot().active).toEqual({
      "public-read": 3,
      "public-order": 0,
      staff: 0,
    });
    firstAuthRead.resolve();
    secondAuthRead.resolve();
    await until(() => f.counts().loads === 1);
    expect(f.gate.snapshot().active).toEqual({
      "public-read": 3,
      "public-order": 0,
      staff: 0,
    });
    const staff = await f.gate.acquire("staff", 2);
    staff.release();
    hold.resolve();
    expect((await pending).status).toBe(200);
    await until(() => f.gate.snapshot().activeCost === 0);
  });
  it("rejects an oversized batch before context SQL", async () => {
    const f = await fixture();
    const response = await fetch(
      `${f.url}${Array(21).fill("storefront.catalog").join(",")}?batch=1`,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(f.counts().contexts).toBe(0);
  });
  it("timed-out queued HTTP work never starts context or loader", async () => {
    const hold = deferred();
    const f = await fixture({ load: () => hold.promise });
    const first = fetch(
      `${f.url}storefront.catalog,storefront.catalog?batch=1`,
    );
    await until(() => f.counts().loads === 2);
    const queued = await fetch(`${f.url}storefront.catalog`);
    expect(queued.status).toBe(503);
    expect(queued.headers.get("retry-after")).toBe("1");
    expect(f.counts()).toEqual({ contexts: 1, loads: 2 });
    hold.resolve();
    await first;
    await until(() => f.gate.snapshot().activeCost === 0);
  });
  it("does not delay response for a detached tail but retains admission", async () => {
    const hold = deferred();
    const f = await fixture({
      load: async () => {
        void trackResourceTail(() => hold.promise);
      },
    });
    expect((await fetch(`${f.url}storefront.catalog`)).status).toBe(200);
    expect(f.gate.snapshot().activeCost).toBe(2);
    hold.resolve();
    await until(() => f.gate.snapshot().activeCost === 0);
  });
});

it("waits actual aborted HTTP handler and a late post-commit tail before resource close", async () => {
  const { runtimeWorkDrain } = await import("../../lib/workDrain");
  const entered = deferred(), commit = deferred(), tailEntered = deferred(), tailDone = deferred();
  const events: string[] = [];
  const { RealtimeBridgeManager } = await import("../../realtime/bridge");
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const bound = probe.address(); if (!bound || typeof bound === "string") throw new Error("port");
  await new Promise<void>(r => probe.close(() => r()));
  const hub = new RealtimeBridgeManager(), client = new RealtimeBridgeManager();
  await hub.init({ port: bound.port, isHub: true, isMultiWorker: true });
  await client.init({ port: bound.port, isHub: false, isMultiWorker: true });
  await vi.waitFor(() => expect(client.getStatus().isConnectedToHub).toBe(true));
  const { createRealtimeEvent, REALTIME_EVENT_TYPES } = await import("@shared/realtimeEvents");
  hub.subscribe(() => events.push("hub-received"));
  try {
  const app = express();
  app.get("/work", publicResourceHandler(async () => {
    entered.resolve();
    await commit.promise;
    void trackResourceTail(async () => { tailEntered.resolve(); await tailDone.promise; client.publish(createRealtimeEvent(REALTIME_EVENT_TYPES.STOREFRONT_ORDER_PLACED, {})); events.push("published"); });
    events.push("handler-ended");
  }, 1, createResourceAdmission({ mode: "observe", maxActiveCost: 6, publicMaxActiveCost: 4, readMaxActiveCost: 4, orderMaxActiveCost: 2, maxQueued: 2, maxQueuedCost: 4, queueTimeoutMs: 100 })));
  const server = createServer(app); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
  const request = get(`http://127.0.0.1:${address.port}/work`); request.on("error", () => {});
  await entered.promise;
  request.destroy();
  await new Promise<void>(r => server.close(() => r()));
  const draining = runtimeWorkDrain.wait(1000).then(async () => { await client.stop({ drain: true, timeoutMs: 1000 }); events.push("resources-close"); });
  await new Promise(r => setImmediate(r));
  expect(events).toEqual([]);
  commit.resolve(); await tailEntered.promise;
  await new Promise(r => setImmediate(r));
  expect(events).toEqual(["handler-ended"]);
  tailDone.resolve(); await draining;
  expect(events).toEqual(["handler-ended", "published", "hub-received", "resources-close"]);
  } finally { commit.resolve(); tailDone.resolve(); await client.stop(); await hub.stop(); }
});
