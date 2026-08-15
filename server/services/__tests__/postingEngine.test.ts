import type Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import {
  InvalidPostingIntentError,
  MAPPED_ENTRY_TYPES,
  UnmappedEntryTypeError,
  assertBalanced,
  createPostingIntent,
  creditLine,
  debitLine,
  postingLinesFor,
  signedPostingLines,
  validatePostingIntent,
  validatePostingIntentPolicy,
  type JournalLine,
  type PostingIntent,
} from "../accounting/postingEngine";

function netByRole(lines: JournalLine[]): Record<string, Decimal> {
  const net: Record<string, Decimal> = {};
  for (const line of lines) {
    const current = net[line.role] ?? money(0);
    net[line.role] = current.plus(money(line.debit)).minus(money(line.credit));
  }
  return net;
}

function total(lines: JournalLine[], side: "debit" | "credit"): Decimal {
  let result = money(0);
  for (const line of lines) result = result.plus(money(line[side]));
  return result;
}

function expectMoney(actual: Decimal | undefined, expected: string): void {
  expect(actual?.eq(money(expected))).toBe(true);
}

describe("postingEngine — legacy fallback and exact money", () => {
  it("keeps the six legacy derivations balanced while Sh2 migrates callers", () => {
    const cases = [
      {
        entryType: "SALE",
        revenue: "10000.00",
        cost: "6000.00",
        amount: "10000.00",
      },
      {
        entryType: "RETURN",
        revenue: "-10000.00",
        cost: "-6000.00",
        amount: "-10000.00",
      },
      { entryType: "PURCHASE", amount: "5000.00" },
      {
        entryType: "PAYMENT_IN",
        amount: "3000.00",
        party: "CUSTOMER" as const,
      },
      {
        entryType: "PAYMENT_OUT",
        amount: "2000.00",
        party: "SUPPLIER" as const,
      },
      { entryType: "OPENING", amount: "4000.00", party: "CUSTOMER" as const },
    ];
    for (const input of cases) {
      const lines = postingLinesFor(input);
      expect(total(lines, "debit").eq(total(lines, "credit"))).toBe(true);
      expect(() => assertBalanced(lines, input.entryType)).not.toThrow();
      for (const line of lines) {
        expect(money(line.debit).isNegative()).toBe(false);
        expect(money(line.credit).isNegative()).toBe(false);
      }
    }
  });

  it("derives inventory sale, tax-like liability, and cost without floating-point conversion", () => {
    const net = netByRole(
      postingLinesFor({
        entryType: "SALE",
        revenue: "10000.10",
        cost: "6000.05",
        amount: "11000.15",
      }),
    );
    expectMoney(net.AR, "11000.15");
    expectMoney(net.SALES_STATIONERY, "-10000.10");
    expectMoney(net.OTHER_LIABILITY, "-1000.05");
    expectMoney(net.COGS, "6000.05");
    expectMoney(net.INVENTORY, "-6000.05");
  });

  it("reverses a customer sale exactly and keeps supplier return out of fallback", () => {
    const sale = netByRole(
      postingLinesFor({
        entryType: "SALE",
        revenue: "100.10",
        cost: "60.05",
        amount: "100.10",
      }),
    );
    const returned = netByRole(
      postingLinesFor({
        entryType: "RETURN",
        revenue: "-100.10",
        cost: "-60.05",
        amount: "-100.10",
      }),
    );
    for (const role of Object.keys(sale))
      expectMoney(returned[role], sale[role].negated().toFixed(2));
    expect(() =>
      postingLinesFor({
        entryType: "RETURN",
        party: "SUPPLIER",
        amount: "1.00",
      }),
    ).toThrow(UnmappedEntryTypeError);
  });

  it("does not infer non-legacy or ambiguous payment maps", () => {
    expect(() =>
      postingLinesFor({ entryType: "EXCHANGE_DEPOSIT", amount: "1000.00" }),
    ).toThrow(UnmappedEntryTypeError);
    expect(() =>
      postingLinesFor({ entryType: "PAYMENT_IN", amount: "10.00" }),
    ).toThrow(UnmappedEntryTypeError);
    expect(() =>
      postingLinesFor({
        entryType: "PAYMENT_OUT",
        amount: "10.00",
        party: "CUSTOMER",
      }),
    ).toThrow(UnmappedEntryTypeError);
    expect(MAPPED_ENTRY_TYPES.has("EXCHANGE_DEPOSIT")).toBe(true);
  });
});

describe("postingEngine — explicit PostingIntent", () => {
  it("creates and validates a balanced profile and postingLinesFor trusts only that validated intent", () => {
    const intent = createPostingIntent(
      "PAYMENT_IN_CUSTOMER",
      "PAYMENT_IN",
      [debitLine("CASH", "77.35"), creditLine("AR", "77.35")],
      {
        roleDebits: { CASH: "77.35" },
        roleCredits: { AR: "77.35" },
      },
    );
    expect(
      postingLinesFor({
        entryType: "PAYMENT_IN",
        amount: "77.35",
        roleDebits: { CASH: "77.35" },
        roleCredits: { AR: "77.35" },
        intent,
      }),
    ).toEqual(intent.lines);
    expect(validatePostingIntent(intent, "PAYMENT_IN")).toEqual(intent);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.lines)).toBe(true);
  });

  it("requires exact independent components for consignment shortage without allowing INVENTORY", () => {
    const intent = createPostingIntent(
      "PURCHASE_CONSIGNMENT_SHORTAGE",
      "PURCHASE",
      [debitLine("LOSSES", "1200.00"), creditLine("CONSIGNMENT_PAYABLE", "1200.00")],
      {
        roleDebits: { LOSSES: "1200.00" },
        roleCredits: { CONSIGNMENT_PAYABLE: "1200.00" },
      },
    );
    expect(
      postingLinesFor({
        entryType: "PURCHASE",
        amount: "1200.00",
        cost: "1200.00",
        profit: "-1200.00",
        roleDebits: { LOSSES: "1200.00" },
        roleCredits: { CONSIGNMENT_PAYABLE: "1200.00" },
        intent,
      }),
    ).toEqual(intent.lines);
    expect(() =>
      postingLinesFor({
        entryType: "PURCHASE",
        amount: "1200.00",
        roleDebits: { LOSSES: "1199.00" },
        roleCredits: { CONSIGNMENT_PAYABLE: "1200.00" },
        intent,
      }),
    ).toThrow(InvalidPostingIntentError);
    expect(() =>
      postingLinesFor({
        entryType: "PURCHASE",
        amount: "1200.00",
        roleDebits: { LOSSES: "1200.00" },
        roleCredits: { INVENTORY: "1200.00" },
        intent: createPostingIntent(
          "PURCHASE_CONSIGNMENT_SHORTAGE",
          "PURCHASE",
          [debitLine("LOSSES", "1200.00"), creditLine("INVENTORY", "1200.00")],
        ),
      }),
    ).toThrow(InvalidPostingIntentError);
  });

  it("rejects profile/entryType mismatch", () => {
    const intent = {
      profile: "PAYMENT_OUT_SUPPLIER",
      entryType: "PAYMENT_IN",
      lines: [debitLine("CASH", "1.00"), creditLine("AR", "1.00")],
    } as PostingIntent;
    expect(() => validatePostingIntent(intent)).toThrow(
      InvalidPostingIntentError,
    );
  });

  it("rejects a caller entryType different from the intent entryType", () => {
    const intent = createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [
      debitLine("CASH", "1.00"),
      creditLine("AR", "1.00"),
    ]);
    expect(() => postingLinesFor({ entryType: "PAYMENT_OUT", intent })).toThrow(
      InvalidPostingIntentError,
    );
  });

  it("rejects negative, dual-sided, zero, unknown-role, and unbalanced lines", () => {
    expect(() => debitLine("CASH", "-0.01")).toThrow(InvalidPostingIntentError);
    expect(() => creditLine("CASH", "0.00")).toThrow(InvalidPostingIntentError);

    const base = { profile: "ADJUST_CASH", entryType: "ADJUST" } as const;
    expect(() =>
      validatePostingIntent({
        ...base,
        lines: [{ role: "CASH", debit: "1.00", credit: "1.00" }],
      }),
    ).toThrow(InvalidPostingIntentError);
    expect(() =>
      validatePostingIntent({
        ...base,
        lines: [
          { role: "NOT_A_ROLE", debit: "1.00", credit: "0.00" },
          creditLine("CAPITAL", "1.00"),
        ],
      } as PostingIntent),
    ).toThrow(InvalidPostingIntentError);
    const unbalanced = createPostingIntent("ADJUST_CASH", "ADJUST", [
      debitLine("CASH", "2.00"),
      creditLine("CAPITAL", "1.00"),
    ]);
    expect(() => validatePostingIntent(unbalanced)).toThrow(/غير متوازن/);
    expect(() =>
      validatePostingIntent({
        ...base,
        lines: [
          { role: "CASH", debit: "1.001", credit: "0.00" },
          creditLine("CAPITAL", "1.00"),
        ],
      }),
    ).toThrow(/two decimal places/);
  });

  it("copies and freezes caller-owned lines after validation", () => {
    const source = [debitLine("CASH", "3.00"), creditLine("CAPITAL", "3.00")];
    const intent = createPostingIntent("ADJUST_CASH", "ADJUST", source);
    source[0].debit = "999.00";
    expect(intent.lines[0].debit).toBe("3.00");
    expect(Object.isFrozen(intent.lines[0])).toBe(true);
  });

  it("signedPostingLines reverses sides for negative deltas and emits no negative money", () => {
    const positive = signedPostingLines("INVENTORY", "OTHER_REVENUE", "12.34");
    const negative = signedPostingLines("INVENTORY", "OTHER_REVENUE", "-12.34");
    expect(positive).toEqual([
      debitLine("INVENTORY", "12.34"),
      creditLine("OTHER_REVENUE", "12.34"),
    ]);
    expect(negative).toEqual([
      debitLine("OTHER_REVENUE", "12.34"),
      creditLine("INVENTORY", "12.34"),
    ]);
    expect(signedPostingLines("INVENTORY", "OTHER_REVENUE", "0.00")).toEqual(
      [],
    );
  });

  it("permits governed no-journal memo profiles without accepting memo lines", () => {
    const memo = createPostingIntent(
      "DELIVERY_DISPATCH_COD",
      "DELIVERY_DISPATCH",
      [],
    );
    expect(
      postingLinesFor({ entryType: "DELIVERY_DISPATCH", intent: memo }),
    ).toEqual([]);
    const zeroYearClose = createPostingIntent(
      "ADJUST_YEAR_CLOSE_ZERO",
      "ADJUST",
      [],
    );
    expect(
      postingLinesFor({ entryType: "ADJUST", intent: zeroYearClose }),
    ).toEqual([]);
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent("ADJUST_CASH", "ADJUST", []),
        "ADJUST",
        {},
      ),
    ).toThrow(InvalidPostingIntentError);
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent("DELIVERY_DISPATCH_COD", "DELIVERY_DISPATCH", [
          debitLine("DELIVERY_FLOAT", "1.00"),
          creditLine("AR", "1.00"),
        ]),
        "DELIVERY_DISPATCH",
        {},
      ),
    ).toThrow(InvalidPostingIntentError);
  });

  it("keeps drawer cash drops distinct from treasury-origin transfers", () => {
    const cashDrop = createPostingIntent(
      "CASH_DROP_TO_TRANSIT",
      "CASH_TRANSFER_OUT",
      [debitLine("CASH_IN_TRANSIT", "125.00"), creditLine("CASH", "125.00")],
    );
    expect(
      postingLinesFor({
        entryType: "CASH_TRANSFER_OUT",
        amount: "125.00",
        intent: cashDrop,
      }),
    ).toEqual(cashDrop.lines);

    expect(() =>
      postingLinesFor({
        entryType: "CASH_TRANSFER_OUT",
        amount: "125.00",
        intent: createPostingIntent(
          "CASH_TRANSFER_OUT_IN_TRANSIT",
          "CASH_TRANSFER_OUT",
          [
            debitLine("CASH_IN_TRANSIT", "125.00"),
            creditLine("CASH", "125.00"),
          ],
        ),
      }),
    ).toThrow(InvalidPostingIntentError);

    expect(() =>
      postingLinesFor({
        entryType: "CASH_TRANSFER_OUT",
        amount: "125.00",
        intent: createPostingIntent(
          "CASH_DROP_TO_TRANSIT",
          "CASH_TRANSFER_OUT",
          [
            debitLine("CASH_IN_TRANSIT", "125.00"),
            creditLine("TREASURY_CASH", "125.00"),
          ],
        ),
      }),
    ).toThrow(InvalidPostingIntentError);
  });
});
