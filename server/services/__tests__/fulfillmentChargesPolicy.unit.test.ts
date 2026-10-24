import { describe, expect, it } from "vitest";
import { money } from "../money";
import {
  chargeAccrualIntent,
  chargeCostIntent,
  chargeCollectionIntent,
  chargeCreditIntent,
  chargeRefundIntent,
  chargePayeeIntent,
  chargeCustodyIntent,
} from "../fulfillment/chargePosting";
import {
  validatePostingIntentPolicy,
  type PostingIntent,
} from "../accounting/postingEngine";

function role(intent: PostingIntent, name: string) {
  const line = intent.lines.find((l) => l.role === name);
  return line ? money(line.debit).minus(line.credit).toFixed(2) : "0.00";
}
describe("classified fulfillment charge journal contracts", () => {
  it("recognizes outsourced gross 5000 and cost 3000 independently, never just margin", () => {
    const revenue = chargeAccrualIntent("OUTSOURCED", money("5000")),
      cost = chargeCostIntent(money("3000"), "AP");
    expect(role(revenue, "AR")).toBe("5000.00");
    expect(role(revenue, "OTHER_REVENUE")).toBe("-5000.00");
    expect(role(cost, "OPERATING_EXPENSE")).toBe("3000.00");
    expect(role(cost, "AP")).toBe("-3000.00");
    expect(() =>
      validatePostingIntentPolicy(revenue, "ADJUST", {
        amount: "5000",
        revenue: "5000",
        roleDebits: { AR: "5000" },
        roleCredits: { OTHER_REVENUE: "5000" },
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(cost, "ADJUST", {
        amount: "3000",
        cost: "3000",
        roleDebits: { OPERATING_EXPENSE: "3000" },
        roleCredits: { AP: "3000" },
      }),
    ).not.toThrow();
  });
  it("pass-through 3000 creates a liability and zero revenue", () => {
    const intent = chargeAccrualIntent("PASS_THROUGH", money("3000"));
    expect(role(intent, "OTHER_LIABILITY")).toBe("-3000.00");
    expect(role(intent, "OTHER_REVENUE")).toBe("0.00");
    expect(() =>
      validatePostingIntentPolicy(intent, "ADJUST", {
        amount: "3000",
        revenue: "0",
        roleDebits: { AR: "3000" },
        roleCredits: { OTHER_LIABILITY: "3000" },
      }),
    ).not.toThrow();
  });
  it("shop expense creates cost/payable, no customer claim", () => {
    const intent = chargeCostIntent(money("3000"), "ACCRUED_EXPENSES");
    expect(role(intent, "AR")).toBe("0.00");
    expect(role(intent, "OPERATING_EXPENSE")).toBe("3000.00");
  });
  it.each(["CARD", "TRANSFER", "WALLET"])(
    "%s actual collection never touches drawer",
    (method) => {
      const intent = chargeCollectionIntent(
        money("2000"),
        money("2000"),
        method,
        null,
      );
      expect(role(intent, "CASH")).toBe("0.00");
      expect(role(intent, "TREASURY_CASH")).toBe("0.00");
      const asset=method==="WALLET"?"PAYMENT_WALLET":"CARD_BANK";
      expect(role(intent, asset)).toBe("2000.00");
      expect(() =>
        validatePostingIntentPolicy(intent, "PAYMENT_IN", {
          amount: "2000",
          roleDebits: { [asset]: "2000" },
          roleCredits: { AR: "2000" },
        }),
      ).not.toThrow();
    },
  );
  it("overcollection is explicit liability, customer AR only allocated 2000", () => {
    const intent = chargeCollectionIntent(
      money("2300"),
      money("2000"),
      "CASH",
      "DRAWER",
    );
    expect(role(intent, "CASH")).toBe("2300.00");
    expect(role(intent, "AR")).toBe("-2000.00");
    expect(role(intent, "OTHER_LIABILITY")).toBe("-300.00");
    expect(() =>
      validatePostingIntentPolicy(intent, "PAYMENT_IN", {
        amount: "2300",
        roleDebits: { CASH: "2300" },
        roleCredits: { AR: "2000", OTHER_LIABILITY: "300" },
      }),
    ).not.toThrow();
  });
  it("card refund credits original bank rail while credit and payout cancel AR", () => {
    const credit = chargeCreditIntent("SERVICE", money("500")),
      refund = chargeRefundIntent(money("500"), "CARD", null);
    expect(money(role(credit, "AR")).plus(role(refund, "AR")).toFixed(2)).toBe(
      "0.00",
    );
    expect(role(refund, "CASH")).toBe("0.00");
    expect(role(refund, "CARD_BANK")).toBe("-500.00");
    expect(() =>
      validatePostingIntentPolicy(credit, "ADJUST", {
        amount: "-500",
        revenue: "-500",
        roleDebits: { OTHER_REVENUE: "500" },
        roleCredits: { AR: "500" },
      }),
    ).not.toThrow();
  });
  it("payee payout clears payable without a second expense", () => {
    const intent = chargePayeeIntent(money("3000"), "AP", "CASH", "DRAWER");
    expect(role(intent, "CASH")).toBe("-3000.00");
    expect(role(intent, "AP")).toBe("3000.00");
    expect(role(intent, "OPERATING_EXPENSE")).toBe("0.00");
  });
  it("courier collection moves AR to real custody with zero drawer effect", () => {
    const intent = chargeCustodyIntent(money("2000"));
    expect(role(intent, "AR")).toBe("-2000.00");
    expect(role(intent, "DELIVERY_FLOAT")).toBe("2000.00");
    expect(role(intent, "CASH")).toBe("0.00");
  });
  it("rejects a balanced journal whose independent source facts do not agree", () => {
    const intent = chargeAccrualIntent("SERVICE", money("5000"));
    expect(() =>
      validatePostingIntentPolicy(intent, "ADJUST", {
        amount: "5000",
        revenue: "4000",
        roleDebits: { AR: "5000" },
        roleCredits: { OTHER_REVENUE: "5000" },
      }),
    ).toThrow();
  });
});
