import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  InvalidPostingIntentError,
  createPostingIntent,
  creditLine,
  debitLine,
  validatePostingIntentPolicy,
} from "./postingEngine";

describe("ADJUST_CUSTODY_RECOVERY double-entry contract", () => {
  it("posts Dr EMPLOYEE_ADVANCES / Cr OTHER_REVENUE so payroll deduction zeroes EMPLOYEE_ADVANCES without touching INVENTORY", () => {
    const lossAmount = new Decimal("75000.00");
    const components = {
      roleDebits: { EMPLOYEE_ADVANCES: lossAmount },
      roleCredits: { OTHER_REVENUE: lossAmount },
    };
    const intent = createPostingIntent(
      "ADJUST_CUSTODY_RECOVERY",
      "ADJUST",
      [
        debitLine("EMPLOYEE_ADVANCES", lossAmount),
        creditLine("OTHER_REVENUE", lossAmount),
      ],
      components,
    );

    const validated = validatePostingIntentPolicy(intent, "ADJUST", {
      amount: lossAmount,
      ...components,
    });
    expect(validated.profile).toBe("ADJUST_CUSTODY_RECOVERY");
    expect(validated.lines).toEqual([
      { role: "EMPLOYEE_ADVANCES", debit: "75000.00", credit: "0.00" },
      { role: "OTHER_REVENUE", debit: "0.00", credit: "75000.00" },
    ]);

    // When payroll later deducts OTHER_DEDUCTION, it credits EMPLOYEE_ADVANCES for 75,000 -> net 0.00.
    const custodyDebit = new Decimal(validated.lines[0].debit);
    const payrollCredit = new Decimal("75000.00");
    expect(custodyDebit.minus(payrollCredit).toFixed(2)).toBe("0.00");
  });

  it("clears EMPLOYEE_ADVANCES and OTHER_REVENUE via ADJUST_CUSTODY_RECOVERY_REVERSAL when compensation is waived", () => {
    const waiverAmount = new Decimal("75000.00");
    const components = {
      roleDebits: { OTHER_REVENUE: waiverAmount },
      roleCredits: { EMPLOYEE_ADVANCES: waiverAmount },
    };
    const intent = createPostingIntent(
      "ADJUST_CUSTODY_RECOVERY_REVERSAL",
      "ADJUST",
      [
        debitLine("OTHER_REVENUE", waiverAmount),
        creditLine("EMPLOYEE_ADVANCES", waiverAmount),
      ],
      components,
    );

    const validated = validatePostingIntentPolicy(intent, "ADJUST", {
      amount: waiverAmount,
      ...components,
    });
    expect(validated.profile).toBe("ADJUST_CUSTODY_RECOVERY_REVERSAL");
    expect(validated.lines).toEqual([
      { role: "OTHER_REVENUE", debit: "75000.00", credit: "0.00" },
      { role: "EMPLOYEE_ADVANCES", debit: "0.00", credit: "75000.00" },
    ]);
  });

  it("rejects touching INVENTORY or LOSSES under ADJUST_CUSTODY_RECOVERY", () => {
    const badInventory = createPostingIntent("ADJUST_CUSTODY_RECOVERY", "ADJUST", [
      debitLine("EMPLOYEE_ADVANCES", "50000.00"),
      creditLine("INVENTORY", "50000.00"),
    ]);
    expect(() =>
      validatePostingIntentPolicy(badInventory, "ADJUST", {
        amount: "50000.00",
        roleDebits: { EMPLOYEE_ADVANCES: "50000.00" },
        roleCredits: { INVENTORY: "50000.00" },
      }),
    ).toThrow(InvalidPostingIntentError);

    const badLosses = createPostingIntent("ADJUST_CUSTODY_RECOVERY", "ADJUST", [
      debitLine("LOSSES", "50000.00"),
      creditLine("OTHER_REVENUE", "50000.00"),
    ]);
    expect(() =>
      validatePostingIntentPolicy(badLosses, "ADJUST", {
        amount: "50000.00",
        roleDebits: { LOSSES: "50000.00" },
        roleCredits: { OTHER_REVENUE: "50000.00" },
      }),
    ).toThrow(InvalidPostingIntentError);
  });
});
