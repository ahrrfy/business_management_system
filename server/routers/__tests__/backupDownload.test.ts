import express from "express";
import compression from "compression";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  resolve: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../auth/session", () => ({
  getUserFromRequest: mocks.user,
  getSessionContext: vi.fn(),
}));
vi.mock("../../services/maintenanceService", () => ({
  resolveBackupFile: mocks.resolve,
  acquireRestoreLock: vi.fn(),
  cleanupTmp: vi.fn(),
  consumeRestoreUploadTicket: vi.fn(),
  currentDbName: vi.fn(),
  quarantineUploadStream: vi.fn(),
  runRestore: vi.fn(),
  verifyRestoreUploadTicket: vi.fn(),
  RestoreUploadValidationError: class extends Error {},
}));
vi.mock("../../services/auditService", () => ({ logAudit: vi.fn() }));
vi.mock("../../logger", () => ({ logger: { error: mocks.error } }));
import { backupRouter } from "../../backupRoutes";

describe("backup download transport", () => {
  let directory: string;
  const data = Buffer.from("-- SQL backup\n".repeat(10000));
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "erp-backup-download-test-"));
    await writeFile(path.join(directory, "valid.sql"), data);
    await writeFile(path.join(directory, "empty.sql"), "");
  });
  afterAll(async () => {
    await unlink(path.join(directory, "valid.sql"));
    await unlink(path.join(directory, "empty.sql"));
    await rmdir(directory);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: 7, role: "admin", isOwner: true });
    mocks.resolve.mockImplementation(async (name: string) =>
      ["valid.sql", "empty.sql"].includes(name)
        ? path.join(directory, name)
        : null,
    );
  });
  async function request(name: string, headers?: Record<string, string>) {
    const app = express();
    app.use(compression());
    app.use("/api/backups", backupRouter());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/backups/download?name=${encodeURIComponent(name)}`,
        { headers },
      );
      const body = Buffer.from(await response.arrayBuffer());
      return { response, body };
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  it("announces the exact source size and sends every byte", async () => {
    const { response, body } = await request("valid.sql", {
      "Accept-Encoding": "identity",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(data.length));
    expect(response.headers.get("x-backup-size")).toBe(String(data.length));
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(body.equals(data)).toBe(true);
  });
  it("compresses SQL over slow connections while preserving the decoded size", async () => {
    const { response, body } = await request("valid.sql", {
      "Accept-Encoding": "gzip",
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("x-backup-size")).toBe(String(data.length));
    expect(body.equals(data)).toBe(true);
  });
  it("resumes an interrupted download through a byte range", async () => {
    const { response, body } = await request("valid.sql", {
      Range: "bytes=32-63",
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-range")).toBe(
      `bytes 32-63/${data.length}`,
    );
    expect(body.equals(data.subarray(32, 64))).toBe(true);
  });
  it("rejects an empty source before sending an attachment", async () => {
    const { response } = await request("empty.sql");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-disposition")).toBeNull();
  });
  it("keeps the admin and safe-path gates", async () => {
    mocks.user.mockResolvedValueOnce({ role: "cashier", isOwner: false });
    expect((await request("valid.sql")).response.status).toBe(403);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect((await request("../private.sql")).response.status).toBe(400);
  });
});
