/** Local review only. No write mode, production target, or URL-bearing output. */
import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "../drizzle/schema";
import { reviewDigitalCommissionDifferences } from "../server/services/commissions/digitalReconciliation";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "node --import tsx scripts/digital-commission-reconcile.mts --period YYYY-MM --actor-id ID --database NAME_test [--branch-id ID] [--user-id ID]\nReads TEST_DATABASE_URL on 127.0.0.1:3311 only; JSON output. Branch filters frozen employee-home-branch lines; bases follow company-wide user activity.",
    );
    return;
  }
  const allowed = new Set([
    "--period",
    "--actor-id",
    "--database",
    "--branch-id",
    "--user-id",
  ]);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith("--"))
      throw new Error("Invalid or repeated arguments; use --help.");
    flags.set(key, value);
  }
  const period = flags.get("--period");
  const database = flags.get("--database");
  const id = (key: string, required = false) => {
    const raw = flags.get(key);
    if (raw == null && !required) return undefined;
    if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new Error(`Missing or invalid ${key}; use --help.`);
    return Number(raw);
  };
  const actorUserId = id("--actor-id", true)!;
  const branchId = id("--branch-id");
  const userId = id("--user-id");
  if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    throw new Error("An explicit YYYY-MM period is required.");
  if (!database || !/^[a-z0-9_]+_test$/.test(database))
    throw new Error("An explicit local _test database name is required.");
  let target: URL;
  try {
    target = new URL(process.env.TEST_DATABASE_URL ?? "");
  } catch {
    throw new Error("Configure a valid isolated TEST_DATABASE_URL.");
  }
  if (
    target.protocol !== "mysql:" ||
    target.hostname !== "127.0.0.1" ||
    target.port !== "3311" ||
    decodeURIComponent(target.pathname.slice(1)) !== database
  )
    throw new Error(
      "Target must match the explicit database on 127.0.0.1:3311.",
    );
  const identity = { host: "127.0.0.1", port: 3311, database };
  console.error(JSON.stringify({ target: identity, period, readOnly: true }));
  // Construct connection options explicitly: URL query parameters cannot replace
  // the already validated host, database, timezone or connection limits.
  const pool = mysql.createPool({
    host: identity.host,
    port: identity.port,
    database,
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    timezone: "Z",
    connectionLimit: 1,
    connectTimeout: 10_000,
  });
  try {
    const db = drizzle(pool, { schema, mode: "default" });
    const report = await reviewDigitalCommissionDifferences(db, {
      period,
      actorUserId,
      branchId,
      userId,
    });
    console.log(JSON.stringify({ target: identity, ...report }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  // Database errors can include SQL values, credentials or connection details.
  // Expose only our fixed argument messages or the service's known authority code.
  const message = error instanceof Error ? error.message : "";
  const safeArgument =
    /^(Invalid or repeated|Missing or invalid|An explicit|Configure a valid|Target must match)/.test(
      message,
    );
  console.error(
    safeArgument
      ? message
      : "Read-only review failed; verify database availability and persisted active admin/owner authority.",
  );
  process.exitCode = 1;
});
