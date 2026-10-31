import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRuntimeProcedure,
  createAdminPublicHttpBoundary,
} from "../runtimeBoundary";
import { publicStorefrontHostBoundary } from "../publicStorefrontHost";
import { readFileSync } from "node:fs";
import { runtimeDrainBoundary } from "../../lib/workDrain";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listener(role: string, authenticated = false) {
  vi.stubEnv("WEB_RUNTIME_ROLE", role);
  const app = express();
  app.use(publicStorefrontHostBoundary);
  app.use(createAdminPublicHttpBoundary(async () => authenticated));
  const router = express.Router();
  router.get(["/feeds/:file", "/api/feeds/:file", "/store/feeds/:file"], (req, res) => res.json({ path: req.path }));
  app.use(router);
  app.use((_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}
describe("two-sided process boundary", () => {
  it("leaves device and stocktake image authorization to their existing handlers", async () => {
    vi.stubEnv("WEB_RUNTIME_ROLE", "admin");
    const app = express();
    const verifyStaff = vi.fn(async () => false);
    app.use(createAdminPublicHttpBoundary(verifyStaff));
    // Stand-ins prove downstream authenticators are reached, not real credential validity.
    app.get(["/api/img/kiosk-product/:id", "/api/img/count-product/:code/:id"], (req, res) => {
      res.status(req.get("cookie") === "private-device=synthetic-valid" ? 204 : 401).end();
    });
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    for (const endpoint of ["/api/img/kiosk-product/1", "/api/img/count-product/synthetic-code/1"]) {
      const url = `http://127.0.0.1:${address.port}${endpoint}`;
      expect((await fetch(url, { headers: { cookie: "private-device=synthetic-valid" } })).status).toBe(204);
      expect((await fetch(url)).status).toBe(401);
    }
    expect(verifyStaff).not.toHaveBeenCalled();
  });
  it("initializes the actual bootstrap router with case-sensitive application routes", async () => {
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const start = source.indexOf("  const app = express();");
    const end = source.indexOf("  app.use(publicStorefrontHostBoundary);", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // Execute the production initialization prefix without booting integrations.
    const app = new Function("express", "runtimeDrainBoundary", `${source.slice(start, end)}\nreturn app;`)(express, runtimeDrainBoundary) as express.Express;
    app.get("/CaseProbe", (_req, res) => res.sendStatus(204));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const url = `http://127.0.0.1:${address.port}`;
    expect((await fetch(url + "/CaseProbe")).status).toBe(204);
    expect((await fetch(url + "/caseprobe")).status).toBe(404);
  });
  it("public denies private APIs with ERP Host and forged forwarding headers", async () => {
    const url = await listener("public");
    for (const path of [
      "/api/trpc/sales.list",
      "/api/trpc/storefront.catalog,sales.list",
      "/api/realtime",
      "/api/print/raw",
    ])
      expect(
        (
          await fetch(url + path, {
            headers: {
              host: "srv1548487.hstgr.cloud",
              "x-forwarded-host": "staff.invalid",
            },
          })
        ).status,
      ).toBe(404);
    expect((await fetch(url + "/api/trpc/storefront.catalog")).status).toBe(
      200,
    );
  });
  it("admin public procedure access requires verified staff, including mixed batches per procedure", () => {
    vi.stubEnv("WEB_RUNTIME_ROLE", "admin");
    for (const path of [
      "storefront.catalog",
      "storefront.quoteOrder",
      "storefront.createOrder",
      "kiosk.publicBranches",
      "recruitment.submit",
    ]) {
      expect(() => assertRuntimeProcedure(path, false)).toThrow();
      expect(() => assertRuntimeProcedure(path, true)).not.toThrow();
    }
    expect(() => assertRuntimeProcedure("auth.login", false)).not.toThrow();
  });
  it("admin denies anonymous image/SEO/sitemap work and retains staff preview", async () => {
    const url = await listener("admin");
    for (const path of [
      "/api/img/product/1",
      "/api/img/banner/1/main",
      "/api/img/company/synthetic-company/product/1",
      "/store",
      "/store/product/1",
      "/sitemap.xml", "/FEEDS/google-merchant.xml", "/API/Feeds/google-merchant.xml/", "/STORE/FEEDS/google-merchant.xml", "/STORE/", "/API/IMG/product/1",
    ])
      expect((await fetch(url + path)).status).toBe(404);
    const staff = await listener("admin", true);
    expect((await fetch(staff + "/api/img/product/1")).status).toBe(200);
    expect((await fetch(staff + "/store")).status).toBe(200);
    expect(await (await fetch(staff + "/API/Feeds/CaseID/")).json()).toEqual({ path: "/API/Feeds/CaseID/" });
  });
});

// The laboratory contract is pure and cannot open a database or start a worker.
import * as labContract from "../../../scripts/storefront-runtime-lab-contract.mjs";
const { changedPayloadConflictProved, financialEffectTables, seedRuntimeStoreSettings } = labContract;
import { drizzle } from "drizzle-orm/mysql2";
import { onlineOrders, storeSettings } from "../../../drizzle/schema";
it("requires conflict plus unchanged persisted order/payload, rejecting unrelated failures", () => {
  const original = { clientRequestId: "fixed", addressText: "Original" };
  const snapshot = { orders: [{ id: 1, clientRequestId: "fixed", shippingAddress: "Original" }], lines: [{ productUnitId: 1, quantity: 1 }] };
  expect(changedPayloadConflictProved({ ok: false, status: 409, error: "CONFLICT" }, snapshot, snapshot, original)).toBe(true);
  for (const response of [{ ok: false, status: 503, error: "CONFLICT" }, { ok: false, status: 0, error: "timeout" }, { ok: false, status: 409, error: "OTHER" }, { ok: true, status: 200 }])
    expect(changedPayloadConflictProved(response, snapshot, snapshot, original)).toBe(false);
  expect(changedPayloadConflictProved({ ok: false, status: 409, error: "CONFLICT" }, snapshot, { ...snapshot, lines: [] }, original)).toBe(false);
  expect(changedPayloadConflictProved({ ok: false, status: 409, error: "CONFLICT" }, { orders: [] }, { orders: [] }, original)).toBe(false);
  expect(financialEffectTables).toContain("accountingEntries");
  expect(financialEffectTables).toContain("journalEntries");
});
it("upserts only legitimate fixture settings over the migrated singleton", () => {
  const db = drizzle.mock();
  const query = seedRuntimeStoreSettings(db, storeSettings).toSQL();
  expect(query.sql).toContain("on duplicate key update");
  expect(query.sql).toContain("`fulfillmentBranchId` = ?");
  expect(query.params.slice(-2)).toEqual([true, 1]);
});

it("signs the actual lab session with the same HTTP fingerprint on every staff path", async () => {
  vi.stubEnv("JWT_SECRET", "synthetic-runtime-lab-auth-regression-only");
  const { signSession, verifySession } = await import("../../auth/session");
  const source = readFileSync(new URL("../../../scripts/storefront-runtime-lab.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("    const token = await signSession(");
  const end = source.indexOf("    const cookie", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const token = await new AsyncFunction("signSession", "runtimeLabHeaders", source.slice(begin, end) + "\nreturn token;")(signSession, labContract.runtimeLabHeaders);
  const req = { headers: { "user-agent": "erp-runtime-lab-synthetic-staff/1" } };
  expect(await verifySession(token, req)).toMatchObject({ uid: 1, sid: 1 });
  expect(await verifySession(token, { headers: { "user-agent": "other" } })).toBeNull();
  expect(await verifySession(token, { headers: {} })).toBeNull();
  const unbound = await signSession(1, 60000);
  expect(await verifySession(unbound, req)).toBeNull();
  const cookie = "app_session_id=synthetic";
  expect(labContract.runtimeLabHeaders(cookie, true)).toMatchObject({ cookie, ...req.headers });
  expect(labContract.runtimeLabHeaders(cookie, false).cookie).toBeUndefined();
});

it("projects the real physical orderStatus column as status before the timed workload", () => {
  const query = labContract.runtimeLabOrderReadback(drizzle.mock(), onlineOrders, "synthetic-key").toSQL();
  expect(query.sql).toContain("`orderStatus`");
  expect(query.sql).not.toMatch(/`status`/);
  expect(query.params).toEqual(["synthetic-key"]);
  expect(labContract.pendingRuntimeLabOrder([{ id: 1, status: "PENDING", clientRequestId: "synthetic-key" }], "synthetic-key")).toBe(true);
  expect(labContract.pendingRuntimeLabOrder([{ id: 1, status: "CONFIRMED", clientRequestId: "synthetic-key" }], "synthetic-key")).toBe(false);
  expect(labContract.pendingRuntimeLabOrder([], "synthetic-key")).toBe(false);
});

it("fails staff preflight before timed work and retains failure evidence", async () => {
  const recorded: unknown[] = [];
  const timed = vi.fn();
  const run = async () => {
    await labContract.runtimeLabStaffPreflight([3400, 3401], async (port: number) => ({ ok: port === 3400, status: port === 3400 ? 200 : 401, error: port === 3400 ? undefined : "UNAUTHORIZED" }), (row: unknown) => recorded.push(row));
    timed();
  };
  await expect(run()).rejects.toThrow(/preflight.*3401.*401/i);
  expect(timed).not.toHaveBeenCalled();
  expect(recorded).toHaveLength(2);
  expect(recorded[1]).toMatchObject({ port: 3401, status: 401, ok: false });
  expect(labContract.runtimeLabSampleSummary([{ ok: false, ms: 1, status: 401 }, { ok: true, ms: 100, status: 200 }])).toMatchObject({ total: 2, ok: 1, p95Ms: 100, p99Ms: 100 });
  expect(labContract.runtimeLabSampleSummary([{ ok: false, ms: 1, status: 401 }]).p95Ms).toBeNull();
});
