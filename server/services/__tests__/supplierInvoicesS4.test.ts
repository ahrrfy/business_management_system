import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createPostingIntent,
  createPostingIntentEvidence,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";

describe("S4 — supplier invoice three-way posting", () => {
  it("creates AP only when the matched invoice is posted", () => {
    const source = {
      roleDebits: { GRNI: "100.00", PURCHASE_PRICE_VARIANCE: "5.00" },
      roleCredits: { AP: "105.00" },
    } as const;
    const evidence = createPostingIntentEvidence(
      createPostingIntent(
        "SUPPLIER_INVOICE_GRNI",
        "ADJUST",
        [
          debitLine("GRNI", "100.00"),
          debitLine("PURCHASE_PRICE_VARIANCE", "5.00"),
          creditLine("AP", "105.00"),
        ],
        source,
      ),
      { amount: "105.00", cost: "100.00", ...source },
    );
    expect(evidence.postingProfile).toBe("SUPPLIER_INVOICE_GRNI");
  });

  it("reversal restores GRNI and removes AP with the opposite PPV", () => {
    const source = {
      roleDebits: { AP: "105.00" },
      roleCredits: { GRNI: "100.00", PURCHASE_PRICE_VARIANCE: "5.00" },
    } as const;
    expect(() =>
      createPostingIntentEvidence(
        createPostingIntent(
          "SUPPLIER_INVOICE_GRNI_REVERSAL",
          "ADJUST",
          [
            debitLine("AP", "105.00"),
            creditLine("GRNI", "100.00"),
            creditLine("PURCHASE_PRICE_VARIANCE", "5.00"),
          ],
          source,
        ),
        { amount: "105.00", cost: "100.00", ...source },
      ),
    ).not.toThrow();
  });

  it("guards create, post, and reversal by the original invoice period", () => {
    const source = readFileSync("server/services/purchase/supplierInvoices.ts", "utf8");
    expect(source).toContain("assertPeriodOpen(tx, new Date(`${input.invoiceDate}T00:00:00.000Z`))");
    expect(source).toMatch(/assertPeriodOpen\(\s*tx,\s*new Date\(`\$\{invoice\.invoiceDate\}T00:00:00\.000Z`\),?\s*\)/);
  });
});
