import express from "express";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { applyBodyParsers } from "../bodyParsers";
import { backupRouter } from "../../backupRoutes";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("restore upload body parser boundary", () => {
  it("يرفض الرفع الخام الكبير المجهول من الحارس الحقيقي بلا جلسة", async () => {
    const app = express();
    applyBodyParsers(app);
    app.use("/api/backups", backupRouter());
    const url = await listen(app);
    const response = await fetch(`${url}/api/backups/restore-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/sql" },
      body: Buffer.alloc(2 * 1024 * 1024, 120),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("مدير") });
  });

  it("لا يقرأ جسم restore قبل وصوله إلى حارس المسار", async () => {
    const app = express();
    applyBodyParsers(app);
    app.post("/api/backups/restore-upload", (req, res) => {
      expect(req.body).toBeUndefined();
      expect(req.readableEnded).toBe(false);
      res.status(403).json({ error: "denied before body" });
    });
    const url = await listen(app);
    const response = await fetch(`${url}/api/backups/restore-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "denied before body" });
  });

  it("يبقي سقف JSON العام 1MB ولا يعيد استثناء system.restoreUpload القديم", async () => {
    const app = express();
    applyBodyParsers(app);
    app.post("/api/trpc/system.restoreUpload", (_req, res) => res.status(204).end());
    const url = await listen(app);
    const response = await fetch(`${url}/api/trpc/system.restoreUpload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});
