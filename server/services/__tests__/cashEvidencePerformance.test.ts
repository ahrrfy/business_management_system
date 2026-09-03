import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "server/services/cashDailyReconciliationService.ts",
  "utf8",
);

describe("daily treasury evidence bounded-memory contract", () => {
  it("streams the unbounded receipt history in ordered keyset pages", () => {
    expect(source).toContain("gt(receipts.id, treasuryCursor)");
    expect(source).toContain(".limit(500)");
    expect(source).toContain('createHash("sha256")');
    expect(source).not.toContain("treasuryRows.map");
    expect(source).not.toContain("for (const row of treasuryRows)");
    expect(source).not.toContain("BIT_XOR");
  });

  it("keeps a two-part digest and range boundary in the evidence", () => {
    expect(source).toContain("treasuryDigest");
    expect(source).toContain("lt(treasuryCashEventAt, endExclusive)");
    expect(source).toContain("excludeReceiptIds");
    expect(source).toContain("evidenceBeforeLock");
    expect(source).toContain("assertTreasurySnapshotStillCurrentTx");
    expect(source).toContain("treasuryReceiptCount");
    expect(source).toContain("treasuryLastReceiptId");
  });
});
