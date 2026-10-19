// Derived from returns/mysql-lab.mjs; only the private record path is configurable.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
export const parentLab =
  "D:/business_management_system-worktrees/continuity-plan-20261017";
export const oracleDatabase = "erp_d1_returns_actual_20261019_s5_test";
export const oracleEnv = {
  DATABASE_URL: "mysql://root@127.0.0.1:13326/" + oracleDatabase,
  TEST_DATABASE_URL: "mysql://root@127.0.0.1:13326/" + oracleDatabase,
  CONTROL_DATABASE_URL: "",
  TEST_CONTROL_DATABASE_URL: "",
  NODE_ENV: "test",
  TZ: "UTC",
};
export async function connectAccountingOracle() {
  const r = JSON.parse(
    await readFile(
      process.env.ACCOUNTING_ORACLE_RUNTIME ??
        parentLab + "/.superpowers/sdd/returns-actual-wsl-runtime.json",
      "utf8",
    ),
  );
  assert.equal(r.port, 13326);
  assert.match(
    r.root,
    /^\/tmp\/erp-d1-returns-actual-wsl-20261019-[a-z0-9_]{8}$/,
  );
  const verified = await promisify(execFile)(
    "wsl.exe",
    [
      "-d",
      "Ubuntu",
      "--",
      "python3",
      "/mnt/d/business_management_system-worktrees/continuity-plan-20261017/.superpowers/sdd/returns-actual-wsl-server.py",
      "verify",
      r.root,
    ],
    { windowsHide: true, timeout: 15000 },
  );
  assert.deepEqual(JSON.parse(verified.stdout), r);
  const c = await mysql.createConnection({
    host: "127.0.0.1",
    port: 13326,
    user: "root",
    password: "",
    timezone: "Z",
    decimalNumbers: false,
  });
  try {
    const [[server]] = await c.query(
      "SELECT @@port port,@@datadir dataDir,@@version version,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),NOW()) utcOffset",
    );
    assert.equal(server.port, 13326);
    assert.equal(server.dataDir, r.root + "/data/");
    assert.match(server.version, /^8\.4\.11-0ubuntu0\.26\.04\.1/);
    assert.equal(server.utcOffset, 0);
    await c.query("USE " + oracleDatabase);
    // Cross-process advisory lock prevents simultaneous oracle reset/commands.
    const [[lock]] = await c.query("SELECT GET_LOCK(?,0) acquired", [
      oracleDatabase + ":accounting",
    ]);
    assert.equal(lock.acquired, 1);
    return { connection: c, server };
  } catch (e) {
    await c.end();
    throw e;
  }
}
