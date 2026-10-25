import { describe, expect, it } from "vitest";
import { money } from "../money";
import {
  chargeAccrualIntent,
  chargeCollectionIntent,
  chargeCostIntent,
  chargeCreditIntent,
  chargePayeeIntent,
  chargeRecognitionIntent,
  immediateServiceAccrualIntent,
  immediateServiceIntent,
} from "../fulfillment/chargePosting";
import { deliveryFeeHeldReceiptIntent } from "../delivery/posting";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  validatePostingIntentAgainstSource,
  type PostingIntent,
  type PostingSourceAmounts,
} from "../accounting/postingEngine";

function validate(intent: PostingIntent, source: PostingSourceAmounts) {
  return validatePostingIntentAgainstSource(intent, source);
}

describe("fulfillment financial classification and source facts", () => {
  it("posts a paid guest service directly and refunds its original card asset without customer AR", () => {
    const paid = immediateServiceIntent(money(3000), "CARD", null);
    expect(() =>
      validate(paid, {
        amount: money(3000),
        revenue: money(3000),
        roleDebits: { CARD_BANK: money(3000) },
        roleCredits: { OTHER_REVENUE: money(3000) },
      }),
    ).not.toThrow();
    const refund = immediateServiceIntent(money(1000), "CARD", null, true);
    expect(() =>
      validate(refund, {
        amount: money(1000),
        revenue: money(-1000),
        roleDebits: { OTHER_REVENUE: money(1000) },
        roleCredits: { CARD_BANK: money(1000) },
      }),
    ).not.toThrow();
    expect(
      paid.lines.some(
        (line) => line.role === "AR" || line.role === "INVENTORY",
      ),
    ).toBe(false);
    expect(() =>
      validate(refund, {
        amount: money(1000),
        revenue: money(-1000),
        roleDebits: { OTHER_REVENUE: money(1000) },
        roleCredits: { CASH: money(1000) },
      }),
    ).toThrow();
  });
  it("reverses only the original quality issue cost actually restored to stock", () => {
    const intent = createPostingIntent(
      "AFTERCARE_ISSUE_RETURN",
      "ADJUST",
      [debitLine("INVENTORY", money(200)), creditLine("LOSSES", money(200))],
      {
        roleDebits: { INVENTORY: money(200) },
        roleCredits: { LOSSES: money(200) },
      },
    );
    expect(() =>
      validate(intent, {
        amount: money(-200),
        cost: money(-200),
        profit: money(200),
        roleDebits: { INVENTORY: money(200) },
        roleCredits: { LOSSES: money(200) },
      }),
    ).not.toThrow();
    expect(() =>
      validate(intent, {
        amount: money(-900),
        cost: money(-900),
        roleDebits: { INVENTORY: money(900) },
        roleCredits: { LOSSES: money(900) },
      }),
    ).toThrow();
  });
  it("defers an outsourced customer fee, then recognises it separately from contractor cost", () => {
    const accrual = chargeAccrualIntent("OUTSOURCED", money(5000));
    const recognition = chargeRecognitionIntent(money(5000));
    const cost = chargeCostIntent(money(3000), "AP");
    expect(() =>
      validate(accrual, {
        revenue: money(0),
        amount: money(5000),
        roleDebits: { AR: money(5000) },
        roleCredits: { DEFERRED_REVENUE: money(5000) },
      }),
    ).not.toThrow();
    expect(() =>
      validate(recognition, {
        revenue: money(5000),
        amount: money(5000),
        roleDebits: { DEFERRED_REVENUE: money(5000) },
        roleCredits: { OTHER_REVENUE: money(5000) },
      }),
    ).not.toThrow();
    expect(() =>
      validate(cost, {
        cost: money(3000),
        amount: money(3000),
        roleDebits: { OPERATING_EXPENSE: money(3000) },
        roleCredits: { AP: money(3000) },
      }),
    ).not.toThrow();
    expect(accrual.lines.some((line) => line.role === "INVENTORY")).toBe(false);
    expect(cost.lines.some((line) => line.role === "AR")).toBe(false);
  });

  it("keeps an immediate checkout service as direct revenue", () => {
    const intent = immediateServiceAccrualIntent(money(3000));
    expect(() =>
      validate(intent, {
        revenue: money(3000),
        amount: money(3000),
        roleDebits: { AR: money(3000) },
        roleCredits: { OTHER_REVENUE: money(3000) },
      }),
    ).not.toThrow();
  });

  it("keeps a pass-through amount as a liability with no revenue", () => {
    const intent = chargeAccrualIntent("PASS_THROUGH", money(3000));
    expect(() =>
      validate(intent, {
        revenue: money(0),
        amount: money(3000),
        roleDebits: { AR: money(3000) },
        roleCredits: { OTHER_LIABILITY: money(3000) },
      }),
    ).not.toThrow();
    expect(intent.lines.map((line) => line.role)).toEqual([
      "AR",
      "OTHER_LIABILITY",
    ]);
  });

  it("rejects a balanced pass-through journal misclassified as income", () => {
    const wrong = chargeAccrualIntent("SERVICE", money(3000));
    expect(() =>
      validate(wrong, {
        revenue: money(0),
        amount: money(3000),
        roleDebits: { AR: money(3000) },
        roleCredits: { OTHER_LIABILITY: money(3000) },
      }),
    ).toThrow();
  });

  it.each(["CARD", "TRANSFER", "WALLET"])(
    "collects a courier fee by %s without fabricating drawer cash",
    (method) => {
      const asset = method === "WALLET" ? "PAYMENT_WALLET" : "CARD_BANK";
      const intent = deliveryFeeHeldReceiptIntent(money(5000), method, null);
      expect(() =>
        validate(intent, {
          amount: money(5000),
          roleDebits: { [asset]: money(5000) },
          roleCredits: { COURIER_PAYABLE: money(5000) },
        }),
      ).not.toThrow();
      expect(
        intent.lines.some(
          (line) => line.role === "CASH" || line.role === "TREASURY_CASH",
        ),
      ).toBe(false);
      expect(() =>
        validate(intent, {
          amount: money(5000),
          roleDebits: { CASH: money(5000) },
          roleCredits: { COURIER_PAYABLE: money(5000) },
        }),
      ).toThrow();
    },
  );

  it("separates actual card receipt from AR allocation and the excess held for the customer", () => {
    const intent = chargeCollectionIntent(
      money(7000),
      money(5000),
      "CARD",
      null,
    );
    expect(() =>
      validate(intent, {
        amount: money(7000),
        roleDebits: { CARD_BANK: money(7000) },
        roleCredits: { AR: money(5000), OTHER_LIABILITY: money(2000) },
      }),
    ).not.toThrow();
    expect(() =>
      validate(intent, {
        amount: money(7000),
        roleDebits: { CARD_BANK: money(7000) },
        roleCredits: { AR: money(7000) },
      }),
    ).toThrow();
  });

  it("credits only refunded service revenue, leaving contractor cost payable", () => {
    const credit = chargeCreditIntent("OUTSOURCED", money(2000));
    expect(() =>
      validate(credit, {
        revenue: money(-2000),
        amount: money(-2000),
        roleDebits: { OTHER_REVENUE: money(2000) },
        roleCredits: { AR: money(2000) },
      }),
    ).not.toThrow();
    expect(
      credit.lines.some((line) =>
        ["AP", "OPERATING_EXPENSE", "COURIER_PAYABLE"].includes(line.role),
      ),
    ).toBe(false);
  });

  it("reverses deferred revenue, not income, when refunded before completion", () => {
    const credit = chargeCreditIntent("SERVICE", money(2000), false);
    expect(() =>
      validate(credit, {
        revenue: money(0),
        amount: money(-2000),
        roleDebits: { DEFERRED_REVENUE: money(2000) },
        roleCredits: { AR: money(2000) },
      }),
    ).not.toThrow();
    expect(credit.lines.some((line) => line.role === "OTHER_REVENUE")).toBe(
      false,
    );
  });

  it("pays an accrued contractor obligation without expensing it a second time", () => {
    const payment = chargePayeeIntent(money(3000), "AP", "CASH", "TREASURY");
    expect(() =>
      validate(payment, {
        amount: money(3000),
        cost: money(0),
        roleDebits: { AP: money(3000) },
        roleCredits: { TREASURY_CASH: money(3000) },
      }),
    ).not.toThrow();
    expect(
      payment.lines.some((line) => line.role === "OPERATING_EXPENSE"),
    ).toBe(false);
  });
});
