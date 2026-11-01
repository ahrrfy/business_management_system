import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { closeDb, type DB, type Tx } from "../server/db";
import {
  applyAdvancePeriodClassificationsTx,
  parseAdvancePeriodClassificationPlan,
  parseAdvancePeriodClassificationReversePlan,
  reverseAdvancePeriodClassificationsTx,
  type AdvancePeriodClassificationResult,
} from "../server/services/advances";
import { requireDb, withTx, type Actor } from "../server/services/tx";

// Internal owner tooling. Review never opens a DB; dry-run always rolls back.
// Apply changes classification metadata only and never creates payroll/cash/GL rows.
const args = process.argv.slice(2);
const modes = ["--review", "--dry-run", "--apply"].filter((value) =>
  args.includes(value),
);
if (modes.length > 1) throw new Error("Choose exactly one execution mode");
const mode = modes[0] ?? "--review";
const reverseMode = args.includes("--reverse");
const planIndex = args.indexOf("--plan");
const planPath = planIndex >= 0 ? args[planIndex + 1] : undefined;
const fromStdin = args.includes("--stdin");
const allowed = new Set([
  "--review",
  "--dry-run",
  "--apply",
  "--reverse",
  "--stdin",
  "--plan",
]);
if (
  args.some(
    (arg, index) =>
      (planIndex < 0 || index !== planIndex + 1) && !allowed.has(arg),
  )
) {
  throw new Error("Unknown argument");
}
if (Boolean(planPath) === fromStdin) {
  throw new Error("Provide --plan <file> or --stdin");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function positiveId(name: string): number {
  const value = required(name);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid ${name}`);
  }
  return Number(value);
}

async function stdinText(): Promise<string> {
  let result = "";
  for await (const chunk of process.stdin) {
    result += String(chunk);
    if (Buffer.byteLength(result) > 131072) {
      throw new Error("Plan exceeds size limit");
    }
  }
  return result;
}

class DryRunComplete extends Error {
  constructor(readonly result: AdvancePeriodClassificationResult) {
    super("Advance period classification dry-run rolled back");
  }
}

function firstRow(response: unknown): Record<string, unknown> | null {
  const row =
    Array.isArray(response) && Array.isArray(response[0])
      ? response[0][0]
      : null;
  return row != null && typeof row === "object" && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

async function assertIdentity(executor: DB | Tx): Promise<void> {
  const response: unknown = await executor.execute(
    sql`SELECT @@server_uuid AS serverUuid, DATABASE() AS databaseName`,
  );
  const row = firstRow(response);
  if (
    row == null ||
    row.serverUuid !== required("DB_TARGET_EXPECTED_UUID") ||
    row.databaseName !== required("EXPECTED_DATABASE_NAME")
  ) {
    throw new Error("Database identity does not match the reviewed target");
  }
}

async function assertExistingFinancialGate(executor: DB | Tx): Promise<void> {
  const response: unknown = await executor.execute(
    sql`SELECT id FROM monthCloseSequence WHERE id = 1 LIMIT 1`,
  );
  const row = firstRow(response);
  if (row?.id !== 1) {
    throw new Error("Financial posting gate is missing on the reviewed target");
  }
}

async function main(): Promise<void> {
  const input = fromStdin
    ? await stdinText()
    : await readFile(planPath!, "utf8");
  if (Buffer.byteLength(input) > 131072)
    throw new Error("Plan exceeds size limit");
  const parsedInput = JSON.parse(input) as unknown;
  const applyPlan = reverseMode
    ? null
    : parseAdvancePeriodClassificationPlan(parsedInput);
  const reversePlan = reverseMode
    ? parseAdvancePeriodClassificationReversePlan(parsedInput)
    : null;
  const sourceHash = reversePlan?.sourceHash ?? applyPlan!.sourceHash;
  const payrollPeriod = reversePlan?.payrollPeriod ?? applyPlan!.payrollPeriod;
  const totalAmount = reversePlan?.totalAmount ?? applyPlan!.totalAmount;
  if (mode === "--review") {
    console.log(
      JSON.stringify(
        reversePlan
          ? {
              mode: "REVIEW_NO_DATABASE",
              operation: "REVERSE",
              reason: reversePlan.reason,
              payrollPeriod,
              totalAmount,
              sourceHash,
              rows: reversePlan.rows.map((row) => ({
                classificationId: row.classificationId,
                advanceId: row.advanceId,
                amount: row.amount,
              })),
              transition:
                "SALARY_ADVANCE/exact period -> LEGACY_UNCLASSIFIED/null",
              effects:
                "Classification rollback only; balances stay active and unchanged; blocked after payroll or settlement effects",
            }
          : {
              mode: "REVIEW_NO_DATABASE",
              operation: "APPLY",
              evidenceKind: applyPlan!.evidenceKind,
              evidenceReference: applyPlan!.evidenceReference,
              payrollPeriod,
              totalAmount,
              sourceHash,
              rows: applyPlan!.rows.map((row) => ({
                advanceId: row.advanceId,
                amount: row.amount,
                receiptId: row.expected.receiptId,
              })),
              transition:
                "LEGACY_UNCLASSIFIED/null -> SALARY_ADVANCE/exact period",
              effects:
                "Classification only; balances stay active and unchanged; no payroll, cash, receipt, or GL write",
            },
      ),
    );
    return;
  }

  const databaseUrl = new URL(required("DATABASE_URL"));
  if (databaseUrl.protocol !== "mysql:")
    throw new Error("Unsupported database protocol");
  if (sourceHash !== required("EXPECTED_PLAN_HASH")) {
    throw new Error("Plan fingerprint differs from the reviewed fingerprint");
  }
  const expectedCommit = required("EXPECTED_RELEASE_SHA");
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) {
    throw new Error("Invalid release fingerprint");
  }
  const git = (...values: string[]) =>
    execFileSync("git", values, { encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== expectedCommit) {
    throw new Error("Unexpected source commit");
  }
  const localTest =
    ["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname) &&
    databaseUrl.port !== "" &&
    databaseUrl.port !== "3306" &&
    /test/i.test(decodeURIComponent(databaseUrl.pathname));
  if (!localTest && git("status", "--porcelain", "--untracked-files=no")) {
    throw new Error("Production source has uncommitted changes");
  }
  required("DB_TARGET_EXPECTED_UUID");
  required("EXPECTED_DATABASE_NAME");
  const actor: Actor = {
    userId: positiveId("ACTOR_USER_ID"),
    branchId:
      reversePlan?.rows[0].branchId ?? applyPlan!.rows[0].expected.branchId,
  };
  if (mode === "--apply") {
    if (
      reverseMode &&
      required("CONFIRM_REVERSE") !==
        "OWNER_CONFIRMED_ADVANCE_PERIOD_CLASSIFICATION_ROLLBACK"
    ) {
      throw new Error(
        "Advance classification rollback confirmation does not match",
      );
    }
    if (
      !reverseMode &&
      required("CONFIRM_APPLY") !== "OWNER_ATTESTED_PERIOD_ADVANCES_UNDEDUCTED"
    ) {
      throw new Error("Advance classification confirmation does not match");
    }
  }

  const database = requireDb();
  await assertIdentity(database);
  await assertExistingFinancialGate(database);
  try {
    const result = await withTx(
      async (tx) => {
        await assertIdentity(tx);
        const applied = reversePlan
          ? await reverseAdvancePeriodClassificationsTx(tx, actor, reversePlan)
          : await applyAdvancePeriodClassificationsTx(tx, actor, applyPlan!);
        if (mode === "--dry-run") throw new DryRunComplete(applied);
        return applied;
      },
      { gate: "GOVERNANCE", bootstrapMissingGate: false },
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    if (!(error instanceof DryRunComplete)) throw error;
    console.log(
      JSON.stringify({ ...error.result, mode: "DRY_RUN_ROLLED_BACK" }),
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Advance classification failed",
    );
    process.exitCode = 1;
  })
  .finally(() => closeDb());
