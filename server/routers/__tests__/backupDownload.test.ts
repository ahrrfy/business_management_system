import express from "express";
import compression from "compression";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  directory: "",
}));
vi.mock("../../auth/session", () => ({
  getUserFromRequest: mocks.user,
  getSessionContext: vi.fn(),
}));
vi.mock("../../services/maintenanceService", () => ({
  backupsDir: () => mocks.directory,
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
import { saveBackupToDevice } from "../../../client/src/lib/backupDownload";

describe("backup download transport", () => {
  let directory: string;
  const data = Buffer.from("-- SQL backup\n".repeat(10000));
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "erp-backup-download-test-"));
    mocks.directory = directory;
    await writeFile(path.join(directory, "valid.sql"), data);
    await writeFile(path.join(directory, "empty.sql"), "");
  });
  afterAll(async () => {
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error("unsafe test path");
    await rm(directory, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: 7, role: "admin", isOwner: true });
    mocks.resolve.mockImplementation(async (name: string) =>
      ["valid.sql", "empty.sql", "restart.sql"].includes(name)
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
  it("finishes the exact SQL after a serving socket is killed, the original rotates, and a new server starts", async () => {
    const original = Buffer.alloc(8 * 1024 * 1024, 42);
    await writeFile(path.join(directory, "restart.sql"), original);
    const app = () => {
      const instance = express();
      instance.use(compression());
      instance.use("/api/backups", backupRouter());
      return instance;
    };
    let server = app().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const nativeFetch = globalThis.fetch;
    const chunks: Buffer[] = [];
    let restarted = false;
    const writer = {
      write: vi.fn(async (chunk: Uint8Array) => {
        chunks.push(Buffer.from(chunk));
        if (!restarted) {
          restarted = true;
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await unlink(path.join(directory, "restart.sql"));
          server = app().listen(port, "127.0.0.1");
          await new Promise<void>((resolve) =>
            server.once("listening", resolve),
          );
        }
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const transport = vi.fn((url: string, init: RequestInit) =>
      nativeFetch("http://127.0.0.1:" + port + url, {
        ...init,
        headers: { ...init.headers, "Accept-Encoding": "identity" },
      }),
    );
    vi.stubGlobal("window", {
      showSaveFilePicker: async () => ({ createWritable: async () => writer }),
    });
    vi.stubGlobal("fetch", transport);
    try {
      await expect(
        saveBackupToDevice(
          async () => ({ name: "restart.sql", sizeKb: original.length / 1024 }),
          { suggestedName: "restart.sql" },
        ),
      ).resolves.toBe("saved");
      expect(restarted).toBe(true);
      expect(transport.mock.calls.length).toBeGreaterThan(1);
      expect(transport.mock.calls[1][0]).toContain("downloadId=");
      expect(transport.mock.calls[1][1].headers).toHaveProperty("Range");
      expect(
        createHash("sha256").update(Buffer.concat(chunks)).digest("hex"),
      ).toBe(createHash("sha256").update(original).digest("hex"));
      expect(writer.close).toHaveBeenCalledOnce();
      expect(writer.abort).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
