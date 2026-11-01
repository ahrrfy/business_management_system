import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  advancePeriodClassificationReverseSourceHash,
  advancePeriodClassificationSourceHash,
  type AdvancePeriodClassificationPlan,
  type AdvancePeriodClassificationPlanBase,
  type AdvancePeriodClassificationReversePlan,
  type AdvancePeriodClassificationReversePlanBase,
} from "../advances";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI_PATH = fileURLToPath(
  new URL(
    "../../../scripts/classify-employee-advance-period.ts",
    import.meta.url,
  ),
);

function priorBaghdadPeriod(): string {
  const baghdadNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(baghdadNow.getUTCFullYear(), baghdadNow.getUTCMonth() - 1, 1),
  )
    .toISOString()
    .slice(0, 7);
}

function makeApplyPlan(): AdvancePeriodClassificationPlan {
  const payrollPeriod = priorBaghdadPeriod();
  const base: AdvancePeriodClassificationPlanBase = {
    batchKey: "advance-period-cli-apply",
    evidenceKind: "OWNER_ATTESTATION",
    evidenceReference: "owner-attestation:advance-period-cli",
    evidenceHash: createHash("sha256")
      .update("advance-period-cli-owner-attestation", "utf8")
      .digest("hex"),
    payrollPeriod,
    totalAmount: "25000.00",
    rows: [
      {
        advanceId: 17,
        amount: "25000.00",
        expected: {
          employeeId: 32,
          branchId: 1,
          amount: "25000.00",
          remaining: "25000.00",
          receiptId: 117,
          voucherNumber: "PV-ADV-CLI-117",
          voucherDate: `${payrollPeriod}-15`,
          grantedAt: `${payrollPeriod}-15T08:00:00.000Z`,
        },
      },
    ],
  };
  return { ...base, sourceHash: advancePeriodClassificationSourceHash(base) };
}

function makeReversePlan(
  applyPlan: AdvancePeriodClassificationPlan,
): AdvancePeriodClassificationReversePlan {
  const base: AdvancePeriodClassificationReversePlanBase = {
    batchKey: "advance-period-cli-reverse",
    reason: "Rollback before payroll creation",
    payrollPeriod: applyPlan.payrollPeriod,
    totalAmount: applyPlan.totalAmount,
    rows: [
      {
        classificationId: 701,
        advanceId: 17,
        employeeId: 32,
        branchId: 1,
        amount: "25000.00",
        remaining: "25000.00",
        applySourceHash: applyPlan.sourceHash,
      },
    ],
  };
  return {
    ...base,
    sourceHash: advancePeriodClassificationReverseSourceHash(base),
  };
}

function runCli(
  args: string[],
  plan:
    | AdvancePeriodClassificationPlan
    | AdvancePeriodClassificationReversePlan,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: "not-a-database-url" },
    input: JSON.stringify(plan),
    encoding: "utf8",
    timeout: 20_000,
  });
}

function lastJsonLine(
  result: SpawnSyncReturns<string>,
): Record<string, unknown> {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

describe.sequential(
  "advance period classification CLI — process boundary",
  () => {
    it("reviews an apply plan without opening a database", () => {
      const plan = makeApplyPlan();
      const result = runCli(["--review", "--stdin"], plan);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(lastJsonLine(result)).toMatchObject({
        mode: "REVIEW_NO_DATABASE",
        operation: "APPLY",
        payrollPeriod: plan.payrollPeriod,
        totalAmount: "25000.00",
        sourceHash: plan.sourceHash,
      });
    });

    it("reviews a reverse plan without opening a database", () => {
      const applyPlan = makeApplyPlan();
      const plan = makeReversePlan(applyPlan);
      const result = runCli(["--review", "--reverse", "--stdin"], plan);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(lastJsonLine(result)).toMatchObject({
        mode: "REVIEW_NO_DATABASE",
        operation: "REVERSE",
        payrollPeriod: plan.payrollPeriod,
        totalAmount: "25000.00",
        sourceHash: plan.sourceHash,
      });
    });

    it("rejects unknown arguments and a plan whose canonical hash was changed", () => {
      const plan = makeApplyPlan();
      const unknown = runCli(["--unknown", "--stdin"], plan);
      expect(unknown.status).not.toBe(0);
      expect(unknown.stderr).toContain("Unknown argument");

      const tampered = runCli(["--review", "--stdin"], {
        ...plan,
        sourceHash: "0".repeat(64),
      });
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain(
        "بصمة خطة التصنيف لا تطابق حمولتها canonical",
      );
    });
  },
);
