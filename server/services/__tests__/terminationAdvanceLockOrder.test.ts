import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(
  new URL("../terminationSettlementService.ts", import.meta.url),
  "utf8",
);

describe("termination advance reversal lock-order contract", () => {
  it("locks sorted employee advances before the termination allocation ledger", () => {
    const reversalStart = serviceSource.indexOf(
      "export async function reverseTerminationRecognition",
    );
    const reversalSource = serviceSource.slice(reversalStart);
    const previewStart = reversalSource.indexOf(
      "const advanceApplicationPreview",
    );
    const advanceLockStart = reversalSource.indexOf(
      "const lockedTerminationAdvances",
      previewStart,
    );
    const allocationLockStart = reversalSource.indexOf(
      "const advanceApplications",
      advanceLockStart,
    );

    expect(reversalStart).toBeGreaterThanOrEqual(0);
    expect(previewStart).toBeGreaterThanOrEqual(0);
    expect(advanceLockStart).toBeGreaterThan(previewStart);
    expect(allocationLockStart).toBeGreaterThan(advanceLockStart);

    const advanceLock = reversalSource.slice(
      advanceLockStart,
      allocationLockStart,
    );
    expect(advanceLock).toContain(".from(employeeAdvances)");
    expect(advanceLock).toContain(".orderBy(asc(employeeAdvances.id))");
    expect(advanceLock).toContain('.for("update")');

    const allocationLockEnd = reversalSource.indexOf(
      "const previewFingerprint",
      allocationLockStart,
    );
    const allocationLock = reversalSource.slice(
      allocationLockStart,
      allocationLockEnd,
    );
    expect(allocationLock).toContain(".from(terminationAdvanceAllocations)");
    expect(allocationLock).toContain(
      "asc(terminationAdvanceAllocations.advanceId)",
    );
    expect(allocationLock).toContain('.for("update")');

    const applicationLoopStart = reversalSource.indexOf(
      "for (const application of eventAdvanceApplications)",
      allocationLockEnd,
    );
    const applicationLoopEnd = reversalSource.indexOf(
      "if (settlementObligations.length > 0)",
      applicationLoopStart,
    );
    expect(applicationLoopStart).toBeGreaterThan(allocationLockEnd);
    expect(
      reversalSource.slice(applicationLoopStart, applicationLoopEnd),
    ).not.toContain(".from(employeeAdvances)");
  });
});
