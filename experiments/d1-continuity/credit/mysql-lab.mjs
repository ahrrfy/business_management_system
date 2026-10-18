import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
export const oracleDatabase = "erp_d1_credit_actual_20261018_s5_test";
export const oracleEnv = {
  DATABASE_URL: "mysql://root@127.0.0.1:13323/" + oracleDatabase,
  TEST_DATABASE_URL: "mysql://root@127.0.0.1:13323/" + oracleDatabase,
  CONTROL_DATABASE_URL: "",
  TEST_CONTROL_DATABASE_URL: "",
  NODE_ENV: "test",
  TZ: "UTC",
};
export async function connectCreditOracle() {
  const r = JSON.parse(
    await readFile(".superpowers/sdd/credit-actual-wsl-runtime.json", "utf8"),
  );
  assert.equal(r.port, 13323);
  assert.match(
    r.root,
    /^\/tmp\/erp-d1-credit-actual-wsl-20261018-[a-z0-9_]{8}$/,
  );
  const exec = promisify(execFile),
    python =
      "/mnt/d/business_management_system-worktrees/continuity-plan-20261017/.superpowers/sdd/credit-actual-wsl-server.py";
  assert.deepEqual(
    JSON.parse(
      (
        await exec(
          "wsl.exe",
          ["-d", "Ubuntu", "--", "python3", python, "verify", r.root],
          { windowsHide: true, timeout: 15000 },
        )
      ).stdout,
    ),
    r,
  );
  const c = await mysql.createConnection({
    host: "127.0.0.1",
    port: 13323,
    user: "root",
    password: "",
    timezone: "Z",
    decimalNumbers: false,
  });
  try {
    const [[s]] = await c.query(
      "SELECT @@port port,@@datadir dataDir,@@version version",
    );
    assert.equal(s.port, 13323);
    assert.equal(s.dataDir, r.root + "/data/");
    assert.match(s.version, /^8\.4\.11-0ubuntu0\.26\.04\.1/);
    await c.query("USE " + oracleDatabase);
    return { connection: c, server: s };
  } catch (e) {
    await c.end();
    throw e;
  }
}
