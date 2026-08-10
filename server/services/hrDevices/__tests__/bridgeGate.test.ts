import { once } from "node:events";
import { createServer, request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHrDeviceBridge, type HrDeviceBridge } from "../bridge";

let bridge: HrDeviceBridge | null = null;
const original = {
  host: process.env.HR_DEVICE_HOST,
  allowlist: process.env.HR_DEVICE_IP_ALLOWLIST,
  secret: process.env.HR_DEVICE_SHARED_SECRET,
  identityBindings: process.env.HR_DEVICE_IDENTITY_BINDINGS,
  legacyMigration: process.env.HR_DEVICE_LEGACY_IDENTITY_MIGRATION,
  controlDatabaseUrl: process.env.CONTROL_DATABASE_URL,
  nodeEnv: process.env.NODE_ENV,
};

beforeEach(() => {
  delete process.env.CONTROL_DATABASE_URL;
});

afterEach(async () => {
  await bridge?.stop();
  bridge = null;
  if (original.host === undefined) delete process.env.HR_DEVICE_HOST;
  else process.env.HR_DEVICE_HOST = original.host;
  if (original.allowlist === undefined)
    delete process.env.HR_DEVICE_IP_ALLOWLIST;
  else process.env.HR_DEVICE_IP_ALLOWLIST = original.allowlist;
  if (original.secret === undefined) delete process.env.HR_DEVICE_SHARED_SECRET;
  else process.env.HR_DEVICE_SHARED_SECRET = original.secret;
  if (original.identityBindings === undefined)
    delete process.env.HR_DEVICE_IDENTITY_BINDINGS;
  else process.env.HR_DEVICE_IDENTITY_BINDINGS = original.identityBindings;
  if (original.legacyMigration === undefined)
    delete process.env.HR_DEVICE_LEGACY_IDENTITY_MIGRATION;
  else
    process.env.HR_DEVICE_LEGACY_IDENTITY_MIGRATION = original.legacyMigration;
  if (original.controlDatabaseUrl === undefined)
    delete process.env.CONTROL_DATABASE_URL;
  else process.env.CONTROL_DATABASE_URL = original.controlDatabaseUrl;
  if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original.nodeEnv;
});

async function startProtectedBridge(): Promise<number> {
  process.env.HR_DEVICE_HOST = "127.0.0.1";
  process.env.HR_DEVICE_IP_ALLOWLIST = "127.0.0.1";
  process.env.HR_DEVICE_SHARED_SECRET = "test-gateway-secret";
  bridge = await startHrDeviceBridge(0);
  expect(bridge.server.listening).toBe(true);
  const address = bridge.server.address();
  if (!address || typeof address === "string")
    throw new Error("bridge did not bind TCP");
  return address.port;
}

function httpStatus(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("بوابة شبكة جسر الحضور", () => {
  it("لا تفتح المنفذ في الإنتاج عند غياب ضوابط المصدر", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.HR_DEVICE_IP_ALLOWLIST;
    delete process.env.HR_DEVICE_SHARED_SECRET;
    await expect(startHrDeviceBridge(0)).rejects.toThrow(
      "HR_DEVICE_BRIDGE_SECURITY_NOT_READY",
    );
  });

  it("لا تفتح المنفذ في الإنتاج بقائمة شاملة أو سر دوري", async () => {
    process.env.NODE_ENV = "production";
    process.env.HR_DEVICE_IP_ALLOWLIST = "0.0.0.0/0";
    delete process.env.HR_DEVICE_SHARED_SECRET;
    await expect(startHrDeviceBridge(0)).rejects.toThrow(
      "HR_DEVICE_BRIDGE_SECURITY_NOT_READY",
    );

    delete process.env.HR_DEVICE_IP_ALLOWLIST;
    process.env.HR_DEVICE_SHARED_SECRET = "abcd".repeat(8);
    await expect(startHrDeviceBridge(0)).rejects.toThrow(
      "HR_DEVICE_BRIDGE_SECURITY_NOT_READY",
    );

    process.env.HR_DEVICE_IP_ALLOWLIST = "127.0.0.1";
    delete process.env.HR_DEVICE_SHARED_SECRET;
    process.env.HR_DEVICE_LEGACY_IDENTITY_MIGRATION = "1";
    await expect(startHrDeviceBridge(0)).rejects.toThrow(
      "HR_DEVICE_BRIDGE_SECURITY_NOT_READY",
    );
  });

  it("لا يحلّ وعد البدء إلا بعد امتلاك منفذ TCP فعلياً", async () => {
    const port = await startProtectedBridge();
    expect(port).toBeGreaterThan(0);
    expect(bridge?.server.listening).toBe(true);
  });

  it("يرفض البدء عند امتلاك عملية أخرى للمنفذ", async () => {
    process.env.HR_DEVICE_HOST = "127.0.0.1";
    process.env.HR_DEVICE_IP_ALLOWLIST = "127.0.0.1";
    process.env.HR_DEVICE_SHARED_SECRET = "test-gateway-secret";

    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string")
      throw new Error("blocker did not bind TCP");

    try {
      await expect(
        startHrDeviceBridge(address.port, { listenTimeoutMs: 2_000 }),
      ).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("ترفض HTTP بلا سر وتقبل ZK بالسر دون تغيير البروتوكول", async () => {
    const port = await startProtectedBridge();
    expect((await httpStatus(port, "/iclock/cdata")).status).toBe(403);
    const accepted = await httpStatus(
      port,
      "/iclock/cdata?token=test-gateway-secret",
    );
    expect(accepted).toEqual({ status: 200, body: "OK" });
  });

  it("ترفض WebSocket بلا سر وتقبل Aiface بالسر", async () => {
    const port = await startProtectedBridge();
    const rejectedStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
      socket.once("unexpected-response", (_req, res) =>
        resolve(res.statusCode ?? 0),
      );
      socket.once("error", () => undefined);
      socket.once("open", () =>
        reject(new Error("unauthorized socket opened")),
      );
    });
    expect(rejectedStatus).toBe(403);

    const accepted = new WebSocket(
      `ws://127.0.0.1:${port}/?token=test-gateway-secret`,
    );
    await once(accepted, "open");
    accepted.close();
    await once(accepted, "close");
  });
});
