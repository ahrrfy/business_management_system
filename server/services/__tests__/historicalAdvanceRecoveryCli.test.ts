import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  historicalAdvanceRecoveryApplySourceHash,
  type HistoricalAdvanceRecoveryApplyPlan,
  type HistoricalAdvanceRecoveryApplyPlanBase,
} from "../advances/historicalAdvanceRecovery";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_PATH = fileURLToPath(
  new URL(
    "../../../scripts/reconcile-employee-advance-history.ts",
    import.meta.url,
  ),
);
const EVIDENCE_HASH = createHash("sha256")
  .update("historical-cli-owner-attestation", "utf8")
  .digest("hex");

function currentBaghdadPeriod(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function priorGrantedAt(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 15, 8, 0, 0));
}

function makePlan(
  batchKey = "historical-cli-apply-1",
): HistoricalAdvanceRecoveryApplyPlan {
  const priorToPeriod = currentBaghdadPeriod();
  const base: HistoricalAdvanceRecoveryApplyPlanBase = {
    batchKey,
    evidenceKind: "OWNER_ATTESTATION",
    evidenceReference: "owner-attestation:historical-cli-regression",
    evidenceHash: EVIDENCE_HASH,
    priorToPeriod,
    totalAmount: "100000.00",
    rows: [
      {
        advanceId: 101,
        amount: "100000.00",
        expected: {
          employeeId: 10,
          branchId: 1,
          amount: "100000.00",
          remaining: "100000.00",
          receiptId: null,
          grantedAt: priorGrantedAt(priorToPeriod).toISOString(),
        },
      },
    ],
  };
  return {
    ...base,
    sourceHash: historicalAdvanceRecoveryApplySourceHash(base),
  };
}

function childEnvironment(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Keep dotenv from re-enabling tenant routing in the isolated child.
    CONTROL_DATABASE_URL: "",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

function runCli(
  args: string[],
  plan: HistoricalAdvanceRecoveryApplyPlan,
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    input: JSON.stringify(plan),
    encoding: "utf8",
    timeout: 20_000,
  });
}

type AsyncCliResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runCliAsync(
  args: string[],
  plan: HistoricalAdvanceRecoveryApplyPlan,
  env: NodeJS.ProcessEnv,
): Promise<AsyncCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI_PATH, ...args],
      {
        cwd: REPO_ROOT,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("historical recovery CLI child timed out"));
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(plan));
  });
}

function expectCompleted(result: SpawnSyncReturns<string>): void {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
}

function lastJsonLine(
  result: SpawnSyncReturns<string>,
): Record<string, unknown> {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

describe.sequential(
  "historical advance recovery CLI — process boundary",
  () => {
    it("reviews a valid plan without parsing or connecting to DATABASE_URL", () => {
      const result = runCli(
        ["--review", "--stdin"],
        makePlan("historical-cli-review"),
        childEnvironment({ DATABASE_URL: "not-a-database-url" }),
      );

      expectCompleted(result);
      expect(result.status).toBe(0);
      expect(lastJsonLine(result)).toMatchObject({
        mode: "REVIEW_NO_DATABASE",
        totalAmount: "100000.00",
      });
    });

    it("rejects an unknown first argument before reading a target", () => {
      const result = runCli(
        ["--unknown", "--stdin"],
        makePlan("historical-cli-unknown-argument"),
        childEnvironment({ DATABASE_URL: "not-a-database-url" }),
      );

      expectCompleted(result);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unknown argument");
    });
  },
);

function safeIsolatedDatabaseUrl(): string | null {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || process.env.DATABASE_URL !== raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const port = parsed.port ? Number(parsed.port) : 3306;
  if (
    parsed.protocol !== "mysql:" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ||
    !databaseName ||
    !/test/i.test(databaseName) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (port === 3306 && process.env.ALLOW_TEST_DB_PORT_3306 !== "1")
  ) {
    return null;
  }
  return raw;
}

const ISOLATED_DATABASE_URL = safeIsolatedDatabaseUrl();

type TargetIdentity = { serverUuid: string; databaseName: string };

async function targetIdentity(connection: Connection): Promise<TargetIdentity> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT @@server_uuid AS serverUuid, DATABASE() AS databaseName",
  );
  return {
    serverUuid: String(rows[0]?.serverUuid ?? ""),
    databaseName: String(rows[0]?.databaseName ?? ""),
  };
}

async function resetAndSeed(connection: Connection): Promise<void> {
  await connection.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const table of [
    "employeeAdvanceHistoricalRecoveries",
    "auditLogs",
    "employeeAdvances",
    "doubleEntrySettings",
    "employees",
    "monthCloseSequence",
    "users",
    "branches",
  ]) {
    await connection.query(`DELETE FROM \`${table}\``);
  }
  await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  await connection.query(
    "INSERT INTO branches (id, name, code, branchType) VALUES (1, ?, ?, 'MAIN')",
    ["فرع اختبار CLI", "HIST-CLI"],
  );
  await connection.query(
    "INSERT INTO users (id, openId, name, role, branchId, isOwner, isActive) " +
      "VALUES (1, ?, ?, 'admin', 1, TRUE, TRUE)",
    ["historical-cli-owner", "مالك اختبار CLI"],
  );
  await connection.query(
    "INSERT INTO employees (id, branchId, firstName, lastName, payType, salary) " +
      "VALUES (10, 1, ?, ?, 'monthly', '1000000.00')",
    ["موظف", "CLI"],
  );
  await connection.query(
    "INSERT INTO doubleEntrySettings (id, mode) VALUES (1, 'OFF')",
  );
  const plan = makePlan();
  await connection.query(
    "INSERT INTO employeeAdvances " +
      "(id, employeeId, branchId, amount, remaining, advanceSourceType, payrollPeriod, advanceStatus, receiptId, createdBy, grantedAt) " +
      "VALUES (101, 10, 1, '100000.00', '100000.00', 'LEGACY_UNCLASSIFIED', NULL, 'ACTIVE', NULL, 1, ?)",
    [new Date(plan.rows[0].expected.grantedAt)],
  );
  await connection.query("INSERT INTO monthCloseSequence (id) VALUES (1)");
}

async function durableSnapshot(connection: Connection) {
  const [advanceRows] = await connection.query<RowDataPacket[]>(
    "SELECT advanceStatus AS status, remaining FROM employeeAdvances WHERE id = 101",
  );
  const [countRows] = await connection.query<RowDataPacket[]>(
    "SELECT " +
      "(SELECT COUNT(*) FROM employeeAdvanceHistoricalRecoveries) AS recoveries, " +
      "(SELECT COUNT(*) FROM auditLogs WHERE action = 'employeeAdvance.historicalRecovery.apply') AS audits, " +
      "(SELECT COUNT(*) FROM monthCloseSequence WHERE id = 1) AS gateRows",
  );
  return {
    advance: {
      status: String(advanceRows[0]?.status ?? ""),
      remaining: String(advanceRows[0]?.remaining ?? ""),
    },
    recoveries: Number(countRows[0]?.recoveries ?? -1),
    audits: Number(countRows[0]?.audits ?? -1),
    gateRows: Number(countRows[0]?.gateRows ?? -1),
  };
}

async function waitForGateLockWait(connection: Connection): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA = DATABASE()
          AND requested.OBJECT_NAME = 'monthCloseSequence'`,
    );
    if (Number(rows[0]?.waiters ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("CLI did not reach the expected governance gate lock wait");
}

describe.skipIf(!ISOLATED_DATABASE_URL)(
  "historical advance recovery CLI — isolated MySQL process regressions",
  () => {
    let connection: Connection | null = null;
    let identity: TargetIdentity;
    let releaseSha: string;

    beforeEach(async () => {
      connection = await mysql.createConnection({
        uri: ISOLATED_DATABASE_URL!,
        timezone: "Z",
      });
      await resetAndSeed(connection);
      identity = await targetIdentity(connection);
      releaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
    });

    afterEach(async () => {
      await connection?.end();
      connection = null;
    });

    function applyEnvironment(
      plan: HistoricalAdvanceRecoveryApplyPlan,
      overrides: Record<string, string | undefined> = {},
    ): NodeJS.ProcessEnv {
      return childEnvironment({
        DATABASE_URL: ISOLATED_DATABASE_URL!,
        DB_TARGET_EXPECTED_UUID: identity.serverUuid,
        EXPECTED_DATABASE_NAME: identity.databaseName,
        EXPECTED_PLAN_HASH: plan.sourceHash,
        EXPECTED_RELEASE_SHA: releaseSha,
        ACTOR_USER_ID: "1",
        ACTOR_BRANCH_ID: "",
        CONFIRM_APPLY: "OWNER_ATTESTED_PRIOR_DEDUCTIONS_ONLY",
        ...overrides,
      });
    }

    it("does not write or bootstrap on dry-run when identity is wrong and the gate is missing", async () => {
      const plan = makePlan("historical-cli-wrong-identity");
      await connection!.query("DELETE FROM monthCloseSequence WHERE id = 1");
      const before = await durableSnapshot(connection!);

      const result = runCli(
        ["--dry-run", "--stdin"],
        plan,
        applyEnvironment(plan, {
          DB_TARGET_EXPECTED_UUID: "wrong-server-uuid",
        }),
      );

      expectCompleted(result);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Database identity does not match the reviewed target",
      );
      expect(await durableSnapshot(connection!)).toEqual(before);
    });

    it("does not bootstrap a missing gate after a correct read-only identity preflight", async () => {
      const plan = makePlan("historical-cli-missing-gate");
      await connection!.query("DELETE FROM monthCloseSequence WHERE id = 1");
      const before = await durableSnapshot(connection!);

      const result = runCli(
        ["--apply", "--stdin"],
        plan,
        applyEnvironment(plan),
      );

      expectCompleted(result);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Financial posting gate is missing on the reviewed target",
      );
      expect(await durableSnapshot(connection!)).toEqual(before);
      expect((await durableSnapshot(connection!)).gateRows).toBe(0);
    });

    it("fails closed when the gate disappears after preflight but before the governance lock", async () => {
      const plan = makePlan("historical-cli-gate-race");
      await connection!.query("START TRANSACTION");
      await connection!.query("DELETE FROM monthCloseSequence WHERE id = 1");
      const childResult = runCliAsync(
        ["--apply", "--stdin"],
        plan,
        applyEnvironment(plan),
      );

      let waitError: unknown;
      try {
        await waitForGateLockWait(connection!);
      } catch (error) {
        waitError = error;
      }
      await connection!.query(waitError ? "ROLLBACK" : "COMMIT");
      const result = await childResult;
      if (waitError) throw waitError;

      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MONTH_CLOSE_GATE_MISSING");
      expect(await durableSnapshot(connection!)).toEqual({
        advance: { status: "ACTIVE", remaining: "100000.00" },
        recoveries: 0,
        audits: 0,
        gateRows: 0,
      });
    });

    it("rejects an unreviewed hash and missing apply confirmation without changes", async () => {
      const plan = makePlan("historical-cli-preconditions");
      const before = await durableSnapshot(connection!);

      const wrongHash = runCli(
        ["--apply", "--stdin"],
        plan,
        applyEnvironment(plan, { EXPECTED_PLAN_HASH: "0".repeat(64) }),
      );
      expectCompleted(wrongHash);
      expect(wrongHash.status).not.toBe(0);
      expect(wrongHash.stderr).toContain(
        "Plan fingerprint differs from the reviewed fingerprint",
      );
      expect(await durableSnapshot(connection!)).toEqual(before);

      const missingConfirmation = runCli(
        ["--apply", "--stdin"],
        plan,
        applyEnvironment(plan, { CONFIRM_APPLY: undefined }),
      );
      expectCompleted(missingConfirmation);
      expect(missingConfirmation.status).not.toBe(0);
      expect(missingConfirmation.stderr).toContain("Missing CONFIRM_APPLY");
      expect(await durableSnapshot(connection!)).toEqual(before);
    });

    it("applies once and verifies an exact process replay without duplicate effects", async () => {
      const plan = makePlan("historical-cli-happy-replay");
      const env = applyEnvironment(plan);

      const applied = runCli(["--apply", "--stdin"], plan, env);
      expectCompleted(applied);
      expect(applied.status).toBe(0);
      expect(lastJsonLine(applied)).toMatchObject({
        mode: "APPLIED",
        sourceHash: plan.sourceHash,
        totalAmount: "100000.00",
      });
      const afterApply = await durableSnapshot(connection!);
      expect(afterApply).toEqual({
        advance: { status: "SETTLED", remaining: "0.00" },
        recoveries: 1,
        audits: 1,
        gateRows: 1,
      });

      const replay = runCli(["--apply", "--stdin"], plan, env);
      expectCompleted(replay);
      expect(replay.status).toBe(0);
      expect(lastJsonLine(replay)).toMatchObject({
        mode: "REPLAY_VERIFIED",
        sourceHash: plan.sourceHash,
        totalAmount: "100000.00",
      });
      expect(await durableSnapshot(connection!)).toEqual(afterApply);
    });
  },
);
