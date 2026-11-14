import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, expect, test, vi } from "vitest";
import { assertOwnerRestoreImporterGrants } from "../../../scripts/lib/owner-restore-import-grants";
import { OWNER_RESTORE_STATUS_PATH, ownerRestoreConfirmation } from "../../../shared/ownerRestore";
import { ownerRestorePaths } from "../../lib/ownerRestoreFiles";
import { ownerRestoreMaintenanceBoundary, readOwnerRestoreStatus } from "../ownerRestoreService";

afterEach(() => vi.unstubAllEnvs());

const importerGrants = (definerGrant: string) => [
  "GRANT ALL PRIVILEGES ON `erp`.* TO `erp_restore_import`@`%`",
  "GRANT USAGE ON *.* TO `erp_restore_import`@`%`",
  "GRANT CONNECTION_ADMIN, " + definerGrant + " ON *.* TO `erp_restore_import`@`%`",
];

test.each([
  ["8.0.46", "SET_USER_ID", "SET_ANY_DEFINER"],
  ["8.4.9", "SET_ANY_DEFINER", "SET_USER_ID"],
])("accepts only the matching definer grant on MySQL %s", (version, supportedGrant, legacyOrNewGrant) => {
  expect(() => assertOwnerRestoreImporterGrants(version, "erp", importerGrants(supportedGrant))).not.toThrow();
  expect(() => assertOwnerRestoreImporterGrants(version, "erp", importerGrants(legacyOrNewGrant)))
    .toThrow("RESTORE_IMPORT_PRIVILEGES_TOO_BROAD");
});

test("rejects orphan-definer privileges and grants outside the target schema", () => {
  const grants = importerGrants("SET_ANY_DEFINER");
  expect(() => assertOwnerRestoreImporterGrants("8.4.9", "erp", [
    ...grants, "GRANT ALLOW_NONEXISTENT_DEFINER ON *.* TO `erp_restore_import`@`%`",
  ])).toThrow("RESTORE_IMPORT_PRIVILEGES_TOO_BROAD");
  expect(() => assertOwnerRestoreImporterGrants("8.4.9", "erp", [
    ...grants, "GRANT SELECT ON `other`.* TO `erp_restore_import`@`%`",
  ])).toThrow("RESTORE_IMPORT_PRIVILEGES_TOO_BROAD");
  expect(() => assertOwnerRestoreImporterGrants("8.4.9", "erp", grants.slice(0, 2)))
    .toThrow("RESTORE_IMPORT_PRIVILEGES_INSUFFICIENT");
});

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
