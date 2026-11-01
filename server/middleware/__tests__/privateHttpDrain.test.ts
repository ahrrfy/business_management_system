import express from "express";
import { createServer, request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../../context", () => ({ createContext: mocks.context }));
vi.mock("../../trpc", () => ({ twoFactorEnrollmentRequired: () => false }));
vi.mock("../../services/invoicePrintAuthorization", () => ({ assertDirectPrintBridgeAuthorized: vi.fn() }));
vi.mock("../../services/auditService", () => ({ logAudit: mocks.audit }));
vi.mock("../../services/printService", () => ({
  getConfiguredTarget: () => ({ kind: "synthetic" }),
  describeTarget: () => "synthetic",
  isBridgeEnabled: () => true,
  sendToPrinter: mocks.send,
  buildTestTicket: () => Buffer.from("synthetic-ticket"),
}));
vi.mock("../../logger", () => ({ logger: { error: vi.fn() } }));

import { printRouter } from "../../printRoute";
import { runtimeWorkDrain } from "../../lib/workDrain";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => vi.clearAllMocks());

it.each(["raw", "test"])("drains the actual authorized /api/print/%s sender and audit after disconnect", async path => {
  const senderEntered = deferred(), senderDone = deferred();
  const auditEntered = deferred(), auditDone = deferred();
  const events: string[] = [];
  mocks.context.mockResolvedValue({ user: { id: 1, isOwner: true, role: "admin" } });
  mocks.send.mockImplementation(async () => {
    senderEntered.resolve();
    await senderDone.promise;
    events.push("sender-ended");
    return { kind: "synthetic" };
  });
  mocks.audit.mockImplementation(async () => {
    auditEntered.resolve();
    await auditDone.promise;
    events.push("audit-ended");
  });
  const app = express();
  app.use(express.json());
  app.use("/api/print", printRouter());
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const body = JSON.stringify({ bytesB64: Buffer.from("synthetic-bytes").toString("base64") });
  const req = request(`http://127.0.0.1:${address.port}/api/print/${path}`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
  req.on("error", () => {});
  req.end(body);
  try {
    await senderEntered.promise;
    req.destroy();
    await new Promise<void>(r => server.close(() => r()));
    const draining = runtimeWorkDrain.wait(1000).then(() => { events.push("resources-close"); });
    await new Promise(r => setImmediate(r));
    expect(events).toEqual([]);
    senderDone.resolve();
    await auditEntered.promise;
    await new Promise(r => setImmediate(r));
    expect(events).toEqual(["sender-ended"]);
    auditDone.resolve();
    await draining;
    expect(events).toEqual(["sender-ended", "audit-ended", "resources-close"]);
    expect(mocks.audit.mock.calls[0][1]).toMatchObject({ action: `print.${path}`, entityId: "synthetic" });
    expect(mocks.send).toHaveBeenCalledWith(Buffer.from(path === "raw" ? "synthetic-bytes" : "synthetic-ticket"));
  } finally {
    senderDone.resolve(); auditDone.resolve(); req.destroy(); server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await runtimeWorkDrain.wait(1000);
  }
});

it("tracks the status handler's actual asynchronous authorization independently of its socket", async () => {
  const entered = deferred(), authorizationDone = deferred();
  mocks.context.mockImplementation(async () => {
    entered.resolve();
    await authorizationDone.promise;
    return { user: { id: 1, isOwner: true, role: "admin" } };
  });
  const app = express();
  app.use("/api/print", printRouter());
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const req = request(`http://127.0.0.1:${address.port}/api/print/status`);
  req.on("error", () => {}); req.end();
  try {
    await entered.promise; req.destroy();
    await new Promise<void>(r => server.close(() => r()));
    let drained = false;
    const draining = runtimeWorkDrain.wait(1000).then(() => { drained = true; });
    await new Promise(r => setImmediate(r));
    expect(drained).toBe(false);
    authorizationDone.resolve(); await draining;
    expect(drained).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  } finally {
    authorizationDone.resolve(); req.destroy(); server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await runtimeWorkDrain.wait(1000);
  }
});
