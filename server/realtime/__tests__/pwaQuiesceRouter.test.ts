import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { COOKIE_NAME } from "@shared/const";
import { onBridgeEvent, realtimeBridge } from "../bridge";
import { realtimeRouter, sseManager } from "../index";
import {
  createRealtimeEvent,
  type RealtimeEvent,
} from "@shared/realtimeEvents";

const auth = vi.hoisted(() => ({
  companyId: 1 as number | null,
  getSession: vi.fn(),
}));
vi.mock("../../auth/session", () => ({
  getSessionContext: (...args: unknown[]) => auth.getSession(...args),
}));
vi.mock("../../tenancy/context", () => ({
  getCurrentCompanyId: () => auth.companyId,
}));
vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("POST realtime PWA quiescence", () => {
  let server: Server;
  let base: string;
  const received: RealtimeEvent[] = [];
  const published: RealtimeEvent[] = [];
  let unsubscribe: () => void;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/realtime", realtimeRouter);
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    unsubscribe = onBridgeEvent((event) => received.push(event));
  });
  beforeEach(async () => {
    await realtimeBridge.init({ inMemoryOnly: true, expectedWorkerCount: 1 });
    published.length = 0;
    const publishConfirmed =
      realtimeBridge.publishConfirmed.bind(realtimeBridge);
    vi.spyOn(realtimeBridge, "publishConfirmed").mockImplementation(
      (event, timeoutMs) => {
        published.push(event);
        return publishConfirmed(event, timeoutMs);
      },
    );
    auth.companyId = 1;
    received.length = 0;
    auth.getSession
      .mockReset()
      .mockResolvedValue({ user: { id: 10, role: "cashier", branchId: 1 } });
  });
  afterEach(async () => {
    sseManager.closeAll();
    vi.restoreAllMocks();
    await realtimeBridge.stop();
  });
  afterAll(async () => {
    unsubscribe();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const post = (headers: Record<string, string> = {}, query = "") =>
    fetch(`${base}/api/realtime/pwa-quiesce${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, ...headers },
      body: JSON.stringify({ userId: 999, companyId: 999 }),
    });
  const register = (id: string, userId: number, companyId: number | null) => {
    const req = new EventEmitter() as any;
    const res = new EventEmitter() as any;
    res.writableEnded = false;
    res.destroyed = false;
    res.write = vi.fn();
    res.end = vi.fn(() => {
      res.writableEnded = true;
    });
    sseManager.registerClient({
      id,
      userId,
      companyId,
      role: "cashier",
      scopedBranchId: 1,
      req,
      res,
    });
    return res;
  };

  it("authenticates cookie and derives the actor/company scope while ignoring attacker body IDs", async () => {
    const own = register("own", 10, 1);
    const otherUser = register("other-user", 11, 1);
    const otherCompany = register("other-company", 10, 2);
    const response = await post({ Cookie: `${COOKIE_NAME}=valid-session` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(auth.getSession).toHaveBeenCalledOnce();
    expect(received).toHaveLength(0);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "PWA_SSE_QUIESCE",
      payload: {},
      scope: { userId: 10, companyId: 1 },
    });
    expect(own.end).toHaveBeenCalledOnce();
    expect(otherUser.end).not.toHaveBeenCalled();
    expect(otherCompany.end).not.toHaveBeenCalled();
    expect(own.write).not.toHaveBeenCalled();
    expect(otherUser.write).not.toHaveBeenCalled();
    expect(otherCompany.write).not.toHaveBeenCalled();
    sseManager.broadcast(
      createRealtimeEvent(
        "FINANCIAL_DATA_CHANGED",
        {},
        { userId: 11, companyId: 1 },
      ),
    );
    expect(otherUser.write).toHaveBeenCalledOnce();
  });

  it("publishes an explicit null scope for the primary single-tenant context", async () => {
    auth.companyId = null;
    const own = register("primary", 10, null);
    const tenant = register("tenant", 10, 1);
    const response = await post({ Cookie: `${COOKIE_NAME}=valid-session` });
    expect(response.status).toBe(200);
    expect(published[0].scope).toEqual({ userId: 10, companyId: null });
    expect(own.end).toHaveBeenCalledOnce();
    expect(tenant.end).not.toHaveBeenCalled();
  });

  it.each<{ headers: Record<string, string>; query: string }>([
    { headers: {}, query: "" },
    { headers: { Authorization: "Bearer valid-session" }, query: "" },
    { headers: {}, query: "?token=valid-session" },
  ])("rejects non-cookie authentication %j", async ({ headers, query }) => {
    const response = await post(headers, query);
    expect(response.status).toBe(401);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("rejects an expired or invalid cookie session", async () => {
    auth.getSession.mockResolvedValue({ user: null });
    const response = await post({ Cookie: `${COOKIE_NAME}=expired-session` });
    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("rejects a cross-origin request before authentication or any stream closure", async () => {
    const own = register("own", 10, 1);
    const response = await post({
      Cookie: `${COOKIE_NAME}=valid-session`,
      Origin: "https://other.invalid",
    });
    expect(response.status).toBe(403);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(own.end).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("accepts the same-origin worker fetch proof when Origin is omitted", async () => {
    const response = await fetch(`${base}/api/realtime/pwa-quiesce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${COOKIE_NAME}=valid-session`,
        "Sec-Fetch-Site": "same-origin",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(published).toHaveLength(1);
  });

  it("rejects cookie requests without any CSRF source proof", async () => {
    const response = await fetch(`${base}/api/realtime/pwa-quiesce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${COOKIE_NAME}=valid-session`,
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("returns a retriable failure instead of claiming release when all-worker delivery is unproven", async () => {
    const own = register("own", 10, 1);
    await realtimeBridge.init({
      inMemoryOnly: true,
      isMultiWorker: true,
      expectedWorkerCount: 3,
    });
    const response = await post({ Cookie: `${COOKIE_NAME}=valid-session` });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "PWA_RELEASE_UNCONFIRMED",
      retryable: true,
    });
    expect(own.end).not.toHaveBeenCalled();
  });
});
