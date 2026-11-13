import express from "express";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBodyParsers } from "../bodyParsers";
import { backupRouter } from "../../backupRoutes";
import * as authSession from "../../auth/session";
import * as audit from "../../services/auditService";
import * as maintenance from "../../services/maintenanceService";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("مالك") });
  });

  it.each([
    { env: "production", control: undefined, isOwner: true, reason: "الإنتاج" },
    { env: "development", control: "mysql://unused@127.0.0.1/control", isOwner: true, reason: "تعدّد الشركات" },
    { env: "development", control: undefined, isOwner: false, reason: "مالك" },
  ])("يرفض الرفع عند حارس السياسة قبل التحقق من التصريح أو قراءة الدفق ($reason)", async ({ env, control, isOwner, reason }) => {
    vi.stubEnv("NODE_ENV", env);
    vi.stubEnv("CONTROL_DATABASE_URL", control);
    vi.spyOn(authSession, "getSessionContext").mockResolvedValue({
      user: { id: 1, isOwner, role: "admin" } as authSession.SessionContext["user"],
      sessionId: 10,
      nativeClientId: null,
    });
    const verifyTicket = vi.spyOn(maintenance, "verifyRestoreUploadTicket");
    const readUpload = vi.spyOn(maintenance, "quarantineUploadStream");
    const app = express();
    applyBodyParsers(app);
    app.use("/api/backups", backupRouter());

    const response = await fetch(`${await listen(app)}/api/backups/restore-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/sql" },
      body: "synthetic input",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining(reason) });
    expect(verifyTicket).not.toHaveBeenCalled();
    expect(readUpload).not.toHaveBeenCalled();
  });

  it("يطلب تصريح رفع صالحاً للمالك في بيئة أحادية خارج الإنتاج", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CONTROL_DATABASE_URL", undefined);
    vi.spyOn(authSession, "getSessionContext").mockResolvedValue({
      user: { id: 1, isOwner: true, role: "admin" } as authSession.SessionContext["user"],
      sessionId: 10,
      nativeClientId: null,
    });
    const app = express();
    applyBodyParsers(app);
    app.use("/api/backups", backupRouter());
    const response = await fetch(`${await listen(app)}/api/backups/restore-upload`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("يمرر النسخة المشفّرة من المالك بعد التحقق من نوعها وتصريحها لمرة واحدة", async () => {
    const dbName = "owner_archive_test";
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CONTROL_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", `mysql://unused@127.0.0.1:1/${dbName}`);
    vi.stubEnv("JWT_SECRET", "synthetic-restore-ticket-test-secret");
    vi.stubEnv("BACKUP_GPG_PASSPHRASE", "synthetic-key");
    vi.spyOn(authSession, "getSessionContext").mockResolvedValue({
      user: { id: 1, isOwner: true, role: "admin" } as authSession.SessionContext["user"],
      sessionId: 10,
      nativeClientId: null,
    });
    vi.spyOn(audit, "logAudit").mockResolvedValue(true);
    const body = Buffer.alloc(257, 120);
    const run = vi.spyOn(maintenance, "runRestore").mockImplementation(async (file, options) => {
      expect(file).toMatch(/upload\.sql\.gpg$/);
      expect(options).toEqual({ requireArchiveManifest: false });
      await expect(readFile(file)).resolves.toEqual(body);
    });
    const fileName = "owner-backup.sql.gpg";
    const ticket = await maintenance.issueRestoreUploadTicket({
      userId: 1, sessionId: 10, dbName, fileName, fileSize: body.length,
    });
    const app = express();
    applyBodyParsers(app);
    app.use("/api/backups", backupRouter());
    const url = `${await listen(app)}/api/backups/restore-upload`;
    const upload = (type: string) => fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ticket}`, "Content-Type": type },
      body,
    });

    expect((await upload("application/sql")).status).toBe(415);
    expect(run).not.toHaveBeenCalled();
    const response = await upload("application/octet-stream");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, source: fileName });
    expect((await upload("application/octet-stream")).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
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

  it("يسمح بحمولة JSON حتى 3MB لمسار storefront.uploadCustomizationAsset المفرد ويرفض التجميع أو تجاوز 3MB", async () => {
    const app = express();
    applyBodyParsers(app);
    app.post("/api/trpc/storefront.uploadCustomizationAsset", (_req, res) => res.status(204).end());
    app.post("/api/trpc/auth.login,storefront.uploadCustomizationAsset", (_req, res) => res.status(204).end());
    const url = await listen(app);

    // ~2.7MB base64 JSON (يمثّل صورة خام ~2MiB ضمن العقد المعلن) يمرّ عبر المسار المفرد
    const allowedResponse = await fetch(`${url}/api/trpc/storefront.uploadCustomizationAsset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "LOGO",
        mimeType: "image/png",
        dataBase64: "A".repeat(2_700_000),
      }),
    });
    expect(allowedResponse.status).toBe(204);

    // مسار مجمَّع يحمل الاسم نفسه يبقى محكوماً بسقف 1MB العام (413)
    const batchedResponse = await fetch(`${url}/api/trpc/auth.login,storefront.uploadCustomizationAsset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "A".repeat(1_500_000) }),
    });
    expect(batchedResponse.status).toBe(413);

    // تجاوز سقف 3MB على المسار المفرد يُرفض بـ 413
    const oversizedResponse = await fetch(`${url}/api/trpc/storefront.uploadCustomizationAsset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataBase64: "A".repeat(3_300_000) }),
    });
    expect(oversizedResponse.status).toBe(413);
  });
});
