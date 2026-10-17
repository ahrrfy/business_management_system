import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(repoRoot, "package.json"));
const mysql = require("mysql2/promise");
const execFileAsync = promisify(execFile);
const PORT = 13317;
const DATABASE = "erp_d1_poc_20261017_test";
const normalized = value => resolve(value).toLowerCase();

async function readRuntime() {
  const text = await readFile(resolve(repoRoot, ".superpowers/sdd/mysql-runtime.json"), "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

// No environment/URL override, dotenv or configurable SQL target is accepted.
// Both listener ownership and the actual server are checked before any mutation.
export async function assertRuntimeProcessIdentity(runtime) {
  assert.equal(process.platform, "win32", "Portable laboratory server requires Windows");
  assert.equal(runtime.port, PORT);
  assert.equal(runtime.database, DATABASE);
  assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0, "invalid recorded child PID");
  const root = await realpath(runtime.root);
  const temp = await realpath(os.tmpdir());
  assert.equal(normalized(dirname(root)), normalized(temp), "laboratory root must be directly inside TEMP");
  assert.match(basename(root), /^erp-d1-poc-mysql-20261017-[0-9a-f]{8}$/i, "unexpected fresh laboratory root");
  const binaryRoot = resolve(root, "mysql-8.4.9-winx64");
  assert.equal(normalized(runtime.binaryRoot), normalized(binaryRoot), "recorded binary root identity mismatch");
  const expectedExecutable = await realpath(resolve(binaryRoot, "bin/mysqld.exe"));
  const expectedDataDir = await realpath(resolve(root, "data"));
  assert.equal(normalized(expectedDataDir), normalized(resolve(root,"data")), "laboratory data directory must not redirect outside its recorded root");
  const script = `$ErrorActionPreference='Stop'; $labProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${runtime.pid}'; $labListeners=@(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $labOwner=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess); [pscustomobject]@{pid=$_.OwningProcess; address=$_.LocalAddress; executable=$labOwner.ExecutablePath; parent=$labOwner.ParentProcessId} }); [pscustomobject]@{executable=$labProcess.ExecutablePath; listeners=$labListeners} | ConvertTo-Json -Depth 4 -Compress`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide:true, timeout:15000 });
  const identity = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  assert.equal(normalized(identity.executable ?? ""), normalized(expectedExecutable), "process executable identity mismatch");
  assert.ok(identity.listeners.length > 0, "recorded server has no loopback listener");
  for (const listener of identity.listeners) {
    assert.ok(listener.pid === runtime.pid || listener.parent === runtime.pid, "listener process identity mismatch");
    assert.equal(normalized(listener.executable ?? ""), normalized(expectedExecutable), "listener executable identity mismatch");
    assert.equal(listener.address, "127.0.0.1", "laboratory listener must be loopback only");
  }
  return { expectedDataDir };
}

async function assertServerIdentity(connection, expectedDataDir) {
  assert.equal(connection.config.host, "127.0.0.1", "connection must use the fixed loopback host");
  assert.equal(connection.config.port, PORT, "connection must use the fixed laboratory port");
  const [[server]] = await connection.query("SELECT @@port AS port, @@datadir AS dataDir, @@version AS version");
  assert.equal(server.port, PORT, "server port identity mismatch");
  const [actual, expected] = await Promise.all([realpath(server.dataDir), realpath(expectedDataDir).catch(() => resolve(expectedDataDir))]);
  assert.equal(normalized(actual), normalized(expected), "data directory identity mismatch; refusing all mutating SQL");
  assert.match(server.version, /^8\.4\./, "unexpected laboratory MySQL version");
  return server;
}

async function connectVerified() {
  const runtime = await readRuntime();
  const { expectedDataDir } = await assertRuntimeProcessIdentity(runtime);
  // Deliberately NO default database: verify identity before USE or CREATE.
  const connection = await mysql.createConnection({ host:"127.0.0.1", port:PORT, user:"root", password:"", decimalNumbers:false, multipleStatements:false, connectTimeout:5000 });
  try {
    const server = await assertServerIdentity(connection, expectedDataDir);
    return { connection, server, expectedDataDir };
  } catch(error) {
    await connection.end();
    throw error;
  }
}

export async function provisionDatabaseOnVerifiedConnection(connection, expectedDataDir) {
  const server = await assertServerIdentity(connection, expectedDataDir);
  await connection.query(`CREATE DATABASE IF NOT EXISTS ${DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  return server;
}

export async function connectReference() {
  const verified = await connectVerified();
  try {
    // The same connection has already proved its actual datadir and server port.
    await verified.connection.query(`USE ${DATABASE}`);
    return verified;
  } catch(error) {
    await verified.connection.end();
    throw error;
  }
}

export async function loadProductionMoney() {
  const { build } = require("esbuild");
  const result = await build({
    stdin: { contents:'export * from "./server/services/money.ts"; export * from "./server/services/billing.ts";', resolveDir:repoRoot, sourcefile:"lab-production-money-reference.ts", loader:"ts" },
    bundle:true, platform:"node", format:"esm", write:false,
    alias:{"@shared":resolve(repoRoot,"shared")}, logLevel:"silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  assert.ok(action === "--provision" || action === "--shutdown", "explicit local laboratory action required");
  const verified = await connectVerified();
  try {
    if(action === "--provision") {
      await provisionDatabaseOnVerifiedConnection(verified.connection, verified.expectedDataDir);
      console.log("Verified child PID/listener and actual datadir/port before CREATE DATABASE on the same connection");
    } else {
      await assertServerIdentity(verified.connection, verified.expectedDataDir);
      await verified.connection.query("SHUTDOWN");
      console.log("Shutdown issued only on the same verified laboratory connection");
    }
  } finally { await verified.connection.end(); }
}
