import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  send: vi.fn(),
  audit: vi.fn(),
  resolvedContext: vi.fn(),
}));
vi.mock("../../context", () => ({ createContext: state.resolvedContext }));
vi.mock("../../services/tx", () => ({ withTx: vi.fn() }));
vi.mock("../../services/auditService", () => ({
  logAudit: state.audit,
  logAuditTx: vi.fn(),
}));
vi.mock("../../services/printService", () => ({
  getConfiguredTarget: () => ({ kind: "tcp" }),
  describeTarget: () => "test",
  isBridgeEnabled: () => true,
  sendToPrinter: state.send,
  buildTestTicket: () => Buffer.from("test"),
}));

import { printRouter } from "../../printRoute";

let server: Server;
let base: string;
beforeEach(async () => {
  state.user = {
    id: 7,
    branchId: 2,
    role: "manager",
    operationPolicyEnabled: true,
    resolvedOperationPolicy: {
      version: 1,
      grants: { "operation.invoicePrinting.authorizeBridge": false },
    },
  };
  state.resolvedContext
    .mockReset()
    .mockImplementation(async () => ({ user: state.user }));
  state.send.mockReset().mockResolvedValue({ kind: "tcp" });
  state.audit.mockReset().mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  app.use("/api/print", printRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function post(route: string) {
  return fetch(`${base}/api/print/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bytesB64: "dGVzdA==" }),
  });
}

describe("raw HTTP printing authorization", () => {
  it.each(["raw", "test"])(
    "rejects canonical denial on /%s before printer dispatch",
    async (route) => {
      expect((await post(route)).status).toBe(403);
      expect(state.resolvedContext).toHaveBeenCalledOnce();
      expect(state.send).not.toHaveBeenCalled();
    },
  );
  it("permits the exact canonical bridge grant independently of base role", async () => {
    state.user = {
      ...state.user,
      role: "courier",
      resolvedOperationPolicy: {
        version: 1,
        grants: { "operation.invoicePrinting.authorizeBridge": true },
      },
    };
    expect((await post("raw")).status).toBe(200);
    // Mock transport only: this suite never submits a physical print job.
    expect(state.send).toHaveBeenCalledOnce();
  });
  it("legacy courier cannot use direct raw HTTP to bypass the UI", async () => {
    state.user = { id: 7, role: "courier" };
    expect((await post("test")).status).toBe(403);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("unauthenticated requests never reach printer dispatch", async () => {
    state.user = null;
    expect((await post("raw")).status).toBe(401);
    expect(state.send).not.toHaveBeenCalled();
  });
});
