import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, expect, test, vi } from "vitest";
import { OWNER_RESTORE_STATUS_PATH, ownerRestoreConfirmation } from "../../../shared/ownerRestore";
import { ownerRestorePaths } from "../../lib/ownerRestoreFiles";
import { ownerRestoreMaintenanceBoundary, readOwnerRestoreStatus } from "../ownerRestoreService";

afterEach(() => vi.unstubAllEnvs());

test("accepts mysqldump session settings and rejects an unapproved DEFINER", async ({ onTestFinished }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "erp-owner-restore-test-"));
  const file = path.join(directory, "backup.sql");
  onTestFinished(async () => { await rm(file, { force: true }); await rmdir(directory); });
  const dump = (definer: string) => "-- ALROYA_DB_NEUTRAL_BACKUP:erp\n" +
    "-- " + "mysqldump ".repeat(60) + "\n" +
    "/*!50003 SET @saved_cs_results = @@character_set_results */;\n" +
    "/*!50003 SET @saved_sql_mode = @@sql_mode */;\n" +
    "/*!50003 SET sql_mode = 'IGNORE_SPACE,NO_ENGINE_SUBSTITUTION' */;\n" +
    "/*!50003 SET sql_mode = @saved_sql_mode */;\n" +
    "CREATE TABLE users (id INT PRIMARY KEY);\nDELIMITER ;;\n" +
    "CREATE DEFINER=" + "`" + definer + "`@`%` TRIGGER test_bi BEFORE INSERT ON users FOR EACH ROW BEGIN " +
    "DECLARE CONTINUE HANDLER FOR NOT FOUND SET @missing=1; SET NEW.id = NEW.id; END;;\nDELIMITER ;\n";
  const validate = () => spawnSync(process.execPath, [
    "scripts/restore.mjs", file, "--validate-only", "--expected-definer", "erp_app@%",
  ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "mysql://validator@127.0.0.1:1/erp",
    DOTENV_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null" } });
  await writeFile(file, dump("erp_app"));
  const valid = validate();
  expect(valid.status, valid.stderr).toBe(0);
  await writeFile(file, dump("root"));
  const invalid = validate();
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("RESTORE_DEFINER_NOT_ALLOWED");
  expect(ownerRestoreConfirmation("backup.sql")).toBe("استعادة backup.sql.gpg");
});

test("rejects API requests during maintenance and serves a read-only receipt", async ({ onTestFinished }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "erp-owner-restore-test-"));
  const paths = ownerRestorePaths(directory)!;
  onTestFinished(async () => {
    await Promise.all([paths.state, paths.fence].map(file => rm(file, { force: true })));
    await rmdir(directory);
  });
  vi.stubEnv("ERP_OWNER_RESTORE_DIRECTORY", directory);
  const ticket = "a".repeat(64);
  const now = new Date().toISOString();
  const status = { id: randomUUID(), name: "backup.sql", phase: "MAINTENANCE",
    startedAt: now, updatedAt: now, safetyArchive: null, error: null };
  await writeFile(paths.state, JSON.stringify({ ticketDigest: createHash("sha256").update(ticket).digest("hex"), status }));
  await writeFile(paths.fence, status.id);
  const app = express();
  app.get(OWNER_RESTORE_STATUS_PATH, readOwnerRestoreStatus);
  app.use(ownerRestoreMaintenanceBoundary());
  app.post("/api/probe", (_req, res) => res.sendStatus(204));
  const server = app.listen(0, "127.0.0.1");
  onTestFinished(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => server.once("listening", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected a loopback test server");
  const origin = "http://127.0.0.1:" + address.port;
  expect((await fetch(origin + "/api/probe", { method: "POST" })).status).toBe(503);
  expect((await fetch(origin + OWNER_RESTORE_STATUS_PATH)).status).toBe(404);
  expect((await fetch(origin + OWNER_RESTORE_STATUS_PATH, { headers: { Authorization: "Bearer " + "b".repeat(64) } })).status).toBe(404);
  const receipt = await fetch(origin + OWNER_RESTORE_STATUS_PATH, { headers: { Authorization: "Bearer " + ticket } });
  await expect(receipt.json()).resolves.toEqual(status);
  expect(receipt.headers.get("cache-control")).toBe("no-store");
  await unlink(paths.fence);
  expect((await fetch(origin + "/api/probe", { method: "POST" })).status).toBe(204);
});
