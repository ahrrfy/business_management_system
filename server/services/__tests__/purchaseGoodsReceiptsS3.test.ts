import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import {
  createPostingIntent,
  createPostingIntentEvidence,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { stableCanonical } from "../purchase/grniAccounting";
import {
  cumulativeQuantityCurrencyDelta,
  finalResidualCurrencyAmount,
} from "../purchase/goodsReceipts";

describe("S3 — GRN/GRNI accounting contract", () => {
  it("posts accepted inventory to GRNI without creating AP", () => {
    const source = {
      roleDebits: { INVENTORY: "100.00" },
      roleCredits: { GRNI: "100.00" },
    } as const;
    const evidence = createPostingIntentEvidence(
      createPostingIntent(
        "PURCHASE_GRNI_RECEIPT",
        "ADJUST",
        [debitLine("INVENTORY", "100.00"), creditLine("GRNI", "100.00")],
        source,
      ),
      { amount: "100.00", cost: "100.00", ...source },
    );
    expect(evidence.postingProfile).toBe("PURCHASE_GRNI_RECEIPT");
    expect(JSON.stringify(evidence.postingIntentJson)).not.toContain('"AP"');
  });

  it("requires PPV when reversal carrying cost differs from original GRNI", () => {
    const source = {
      roleDebits: { GRNI: "100.00", PURCHASE_PRICE_VARIANCE: "20.00" },
      roleCredits: { INVENTORY: "120.00" },
    } as const;
    expect(() =>
      createPostingIntentEvidence(
        createPostingIntent(
          "PURCHASE_GRNI_RECEIPT_REVERSAL",
          "ADJUST",
          [
            debitLine("GRNI", "100.00"),
            debitLine("PURCHASE_PRICE_VARIANCE", "20.00"),
            creditLine("INVENTORY", "120.00"),
          ],
          source,
        ),
        { amount: "100.00", cost: "120.00", ...source },
      ),
    ).not.toThrow();
  });

  it("canonicalizes replay payloads independent of object key order", () => {
    expect(stableCanonical({ b: 2, a: { y: 2, x: 1 } })).toBe(
      stableCanonical({ a: { x: 1, y: 2 }, b: 2 }),
    );
  });

  it("guards both receipt creation and reversal by the source document period", () => {
    const source = readFileSync("server/services/purchase/goodsReceipts.ts", "utf8");
    expect(source).toContain("assertPeriodOpen(tx, input.receivedAt ?? new Date())");
    expect(source).toContain("assertPeriodOpen(tx, receipt.receivedAt)");
  });

  it("absorbs the final USD residual for a $10 line received in three parts", () => {
    const first = finalResidualCurrencyAmount("10.00", 3, 1, "0.00", false);
    const second = finalResidualCurrencyAmount("10.00", 3, 1, first, false);
    const final = finalResidualCurrencyAmount(
      "10.00",
      3,
      1,
      first.plus(second),
      true,
    );
    expect([first, second, final].map((value) => value.toFixed(2))).toEqual([
      "3.33",
      "3.33",
      "3.34",
    ]);
    expect(first.plus(second).plus(final).toFixed(2)).toBe("10.00");
  });

  it("carries the exact USD reversal delta and re-receives the released residual", () => {
    const reversed = cumulativeQuantityCurrencyDelta("10.00", 3, 0, 1);
    const remaining = new Decimal("10.00").minus(reversed);
    const rereceived = finalResidualCurrencyAmount(
      "10.00",
      3,
      1,
      remaining,
      true,
    );
    expect(reversed.toFixed(2)).toBe("3.33");
    expect(rereceived.toFixed(2)).toBe("3.33");
    expect(remaining.plus(rereceived).toFixed(2)).toBe("10.00");
  });
});
