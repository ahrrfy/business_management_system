import { describe, expect, it } from "vitest";
import {
  createPostingIntent,
  creditLine,
  debitLine,
  postingLinesFor,
  signedPostingLines,
  type JournalLine,
  type AccountRole,
  type PostingIntent,
  type PostingProfile,
  type PostingSourceComponents,
} from "../accounting/postingEngine";
import type { EntryType } from "../ledgerService";
import { money, round2 } from "../money";

const EXACT_COMPONENT_PROFILES = new Set<PostingProfile>([
  "DIGITAL_WALLET_DEPOSIT_ASSET",
  "DIGITAL_WALLET_WITHDRAWAL_ASSET",
  "RETURN_SALE_DIGITAL",
  "EXCHANGE_SETTLE_SUPPLIER",
  "EXCHANGE_FEE_EXPENSE",
  "EXCHANGE_FX_GAIN",
  "EXCHANGE_FX_LOSS",
  "EXCHANGE_DEPOSIT_IQD",
  "EXCHANGE_DEPOSIT_USD_CASH",
  "EXCHANGE_WITHDRAW_IQD",
  "EXCHANGE_WITHDRAW_USD_CASH",
  "EXCHANGE_FX_BUY",
  "ADJUST_INVENTORY_GAIN",
  "ADJUST_INVENTORY_LOSS",
  "OPENING_EXCHANGE_COMBINED",
  "ADJUST_EXCHANGE_CONTROL_RECLASS",
]);

function componentsFor(lines: readonly JournalLine[]): PostingSourceComponents {
  const roleDebits: Partial<Record<AccountRole, ReturnType<typeof money>>> = {};
  const roleCredits: Partial<Record<AccountRole, ReturnType<typeof money>>> = {};
  for (const line of lines) {
    roleDebits[line.role] = money(roleDebits[line.role] ?? 0).plus(line.debit);
    roleCredits[line.role] = money(roleCredits[line.role] ?? 0).plus(line.credit);
  }
  return { roleDebits, roleCredits };
}

function roleNet(lines: readonly JournalLine[], roles: readonly AccountRole[]) {
  return round2(lines.reduce(
    (sum, line) => roles.includes(line.role) ? sum.plus(line.debit).minus(line.credit) : sum,
    money(0),
  ));
}

function sourceAmounts(posting: PostingIntent) {
  const lines = posting.lines;
  switch (posting.profile) {
    case "DIGITAL_WRITEOFF_EXPENSE":
      return { cost: roleNet(lines, ["LOSSES"]) };
    case "RETURN_SALE_DIGITAL":
      return {
        revenue: roleNet(lines, ["OTHER_REVENUE", "DELIVERY_REVENUE"]).neg(),
        cost: roleNet(lines, ["COGS"]),
      };
    case "PURCHASE_DIGITAL":
      return { amount: roleNet(lines, ["AP"]).neg() };
    case "DIGITAL_WALLET_WITHDRAWAL_ASSET":
      return { amount: roleNet(lines, ["DIGITAL_WALLET"]).neg() };
    case "EXCHANGE_WITHDRAW_IQD":
      return { amount: roleNet(lines, ["TREASURY_CASH"]) };
    case "EXCHANGE_WITHDRAW_USD_CASH":
    case "EXCHANGE_FX_BUY":
      return { amount: roleNet(lines, ["FOREIGN_CASH_USD"]) };
    case "EXCHANGE_SETTLE_SUPPLIER":
      return { amount: roleNet(lines, ["AP"]) };
    case "EXCHANGE_FEE_EXPENSE":
      return { amount: roleNet(lines, ["OPERATING_EXPENSE", "OTHER_EXPENSE"]) };
    case "EXCHANGE_FX_GAIN":
      return { amount: roleNet(lines, ["FX_GAIN"]).neg() };
    case "EXCHANGE_FX_LOSS":
      return { amount: roleNet(lines, ["FX_LOSS"]).neg() };
    case "OPENING_EXCHANGE_COMBINED":
    case "ADJUST_EXCHANGE_CONTROL_RECLASS":
      return {};
    case "EXCHANGE_DEPOSIT_IQD":
      return { amount: roleNet(lines, ["EXCHANGE_WALLET_IQD"]) };
    case "EXCHANGE_DEPOSIT_USD_CASH":
      return { amount: roleNet(lines, ["EXCHANGE_WALLET_USD"]) };
    case "DIGITAL_WALLET_CONSUMPTION_SALE":
      return { amount: roleNet(lines, ["INVENTORY"]) };
    case "DIGITAL_WALLET_REVERSAL_SALE":
    case "DIGITAL_WALLET_ADJUSTMENT_GAIN":
    case "DIGITAL_WALLET_DEPOSIT_ASSET":
      return { amount: roleNet(lines, ["DIGITAL_WALLET"]) };
    case "DIGITAL_WALLET_ADJUSTMENT_LOSS":
      return { amount: roleNet(lines, ["LOSSES"]) };
    default:
      return {};
  }
}

function intent(
  profile: PostingProfile,
  entryType: EntryType,
  lines: JournalLine[],
): PostingIntent {
  return createPostingIntent(
    profile,
    entryType,
    lines,
    EXACT_COMPONENT_PROFILES.has(profile) ? componentsFor(lines) : undefined,
  );
}

describe("P2 Sh2 — digital wallets, exchange and inventory posting intents", () => {
  it.each([
    {
      title: "digital wallet deposit moves treasury cash into the wallet asset",
      posting: intent(
        "DIGITAL_WALLET_DEPOSIT_ASSET",
        "DIGITAL_WALLET_DEPOSIT",
        [
          debitLine("DIGITAL_WALLET", "1000"),
          creditLine("TREASURY_CASH", "1000"),
        ],
      ),
      expected: [
        { role: "DIGITAL_WALLET", debit: "1000.00", credit: "0.00" },
        { role: "TREASURY_CASH", debit: "0.00", credit: "1000.00" },
      ],
    },
    {
      title: "digital wallet withdrawal restores the bank asset",
      posting: intent(
        "DIGITAL_WALLET_WITHDRAWAL_ASSET",
        "DIGITAL_WALLET_WITHDRAWAL",
        [debitLine("CARD_BANK", "750"), creditLine("DIGITAL_WALLET", "750")],
      ),
      expected: [
        { role: "CARD_BANK", debit: "750.00", credit: "0.00" },
        { role: "DIGITAL_WALLET", debit: "0.00", credit: "750.00" },
      ],
    },
    {
      title: "prepaid digital consumption capitalizes issued inventory",
      posting: intent(
        "DIGITAL_WALLET_CONSUMPTION_SALE",
        "DIGITAL_WALLET_CONSUMPTION",
        [debitLine("INVENTORY", "425"), creditLine("DIGITAL_WALLET", "425")],
      ),
      expected: [
        { role: "INVENTORY", debit: "425.00", credit: "0.00" },
        { role: "DIGITAL_WALLET", debit: "0.00", credit: "425.00" },
      ],
    },
    {
      title: "confirmed digital reversal restores the wallet from inventory",
      posting: intent(
        "DIGITAL_WALLET_REVERSAL_SALE",
        "DIGITAL_WALLET_REVERSAL",
        [debitLine("DIGITAL_WALLET", "425"), creditLine("INVENTORY", "425")],
      ),
      expected: [
        { role: "DIGITAL_WALLET", debit: "425.00", credit: "0.00" },
        { role: "INVENTORY", debit: "0.00", credit: "425.00" },
      ],
    },
    {
      title: "wallet surplus is an explicit gain",
      posting: intent(
        "DIGITAL_WALLET_ADJUSTMENT_GAIN",
        "DIGITAL_WALLET_ADJUSTMENT",
        [debitLine("DIGITAL_WALLET", "25"), creditLine("OTHER_REVENUE", "25")],
      ),
      expected: [
        { role: "DIGITAL_WALLET", debit: "25.00", credit: "0.00" },
        { role: "OTHER_REVENUE", debit: "0.00", credit: "25.00" },
      ],
    },
    {
      title: "wallet shortage is an explicit loss",
      posting: intent(
        "DIGITAL_WALLET_ADJUSTMENT_LOSS",
        "DIGITAL_WALLET_ADJUSTMENT",
        [debitLine("LOSSES", "25"), creditLine("DIGITAL_WALLET", "25")],
      ),
      expected: [
        { role: "LOSSES", debit: "25.00", credit: "0.00" },
        { role: "DIGITAL_WALLET", debit: "0.00", credit: "25.00" },
      ],
    },
    {
      title: "digital writeoff expenses already-issued inventory",
      posting: intent("DIGITAL_WRITEOFF_EXPENSE", "DIGITAL_WRITEOFF", [
        debitLine("LOSSES", "600"),
        creditLine("INVENTORY", "600"),
      ]),
      expected: [
        { role: "LOSSES", debit: "600.00", credit: "0.00" },
        { role: "INVENTORY", debit: "0.00", credit: "600.00" },
      ],
    },
    {
      title:
        "postpaid digital issue capitalizes inventory against supplier payable",
      posting: intent("PURCHASE_DIGITAL", "PURCHASE", [
        debitLine("INVENTORY", "600"),
        creditLine("AP", "600"),
      ]),
      expected: [
        { role: "INVENTORY", debit: "600.00", credit: "0.00" },
        { role: "AP", debit: "0.00", credit: "600.00" },
      ],
    },
    {
      title: "digital sale reversal cancels revenue, receivable and COGS",
      posting: intent("RETURN_SALE_DIGITAL", "RETURN", [
        debitLine("OTHER_REVENUE", "1000"),
        creditLine("AR", "1000"),
        debitLine("INVENTORY", "600"),
        creditLine("COGS", "600"),
      ]),
      expected: [
        { role: "OTHER_REVENUE", debit: "1000.00", credit: "0.00" },
        { role: "AR", debit: "0.00", credit: "1000.00" },
        { role: "INVENTORY", debit: "600.00", credit: "0.00" },
        { role: "COGS", debit: "0.00", credit: "600.00" },
      ],
    },
    {
      title:
        "IQD exchange deposit moves administrative treasury into the exchange wallet",
      posting: intent("EXCHANGE_DEPOSIT_IQD", "EXCHANGE_DEPOSIT", [
        debitLine("EXCHANGE_WALLET_IQD", "2500"),
        creditLine("TREASURY_CASH", "2500"),
      ]),
      expected: [
        { role: "EXCHANGE_WALLET_IQD", debit: "2500.00", credit: "0.00" },
        { role: "TREASURY_CASH", debit: "0.00", credit: "2500.00" },
      ],
    },
    {
      title: "IQD exchange withdrawal restores administrative treasury",
      posting: intent("EXCHANGE_WITHDRAW_IQD", "EXCHANGE_WITHDRAW", [
        debitLine("TREASURY_CASH", "2500"),
        creditLine("EXCHANGE_WALLET_IQD", "2500"),
      ]),
      expected: [
        { role: "TREASURY_CASH", debit: "2500.00", credit: "0.00" },
        { role: "EXCHANGE_WALLET_IQD", debit: "0.00", credit: "2500.00" },
      ],
    },
    {
      title: "FX purchase receives physical USD against the signed house control",
      posting: intent("EXCHANGE_FX_BUY", "EXCHANGE_FX_BUY", [
        debitLine("FOREIGN_CASH_USD", "131000"),
        creditLine("EXCHANGE_WALLET_USD", "131000"),
      ]),
      expected: [
        { role: "FOREIGN_CASH_USD", debit: "131000.00", credit: "0.00" },
        { role: "EXCHANGE_WALLET_USD", debit: "0.00", credit: "131000.00" },
      ],
    },
    {
      title:
        "supplier settlement clears AP against the selected exchange wallet",
      posting: intent("EXCHANGE_SETTLE_SUPPLIER", "EXCHANGE_SETTLE", [
        debitLine("AP", "131000"),
        creditLine("EXCHANGE_WALLET_USD", "131000"),
      ]),
      expected: [
        { role: "AP", debit: "131000.00", credit: "0.00" },
        { role: "EXCHANGE_WALLET_USD", debit: "0.00", credit: "131000.00" },
      ],
    },
    {
      title: "exchange fee is an operating expense paid from the wallet",
      posting: intent("EXCHANGE_FEE_EXPENSE", "EXCHANGE_FEE", [
        debitLine("OPERATING_EXPENSE", "1000"),
        creditLine("EXCHANGE_WALLET_IQD", "1000"),
      ]),
      expected: [
        { role: "OPERATING_EXPENSE", debit: "1000.00", credit: "0.00" },
        { role: "EXCHANGE_WALLET_IQD", debit: "0.00", credit: "1000.00" },
      ],
    },
    {
      title:
        "realized FX gain corrects the wallet carrying credit and recognizes gain",
      posting: intent("EXCHANGE_FX_GAIN", "EXCHANGE_FX_DIFF", [
        debitLine("EXCHANGE_WALLET_USD", "500"),
        creditLine("FX_GAIN", "500"),
      ]),
      expected: [
        { role: "EXCHANGE_WALLET_USD", debit: "500.00", credit: "0.00" },
        { role: "FX_GAIN", debit: "0.00", credit: "500.00" },
      ],
    },
    {
      title: "realized FX loss increases the wallet carrying credit",
      posting: intent("EXCHANGE_FX_LOSS", "EXCHANGE_FX_DIFF", [
        debitLine("FX_LOSS", "500"),
        creditLine("EXCHANGE_WALLET_USD", "500"),
      ]),
      expected: [
        { role: "FX_LOSS", debit: "500.00", credit: "0.00" },
        { role: "EXCHANGE_WALLET_USD", debit: "0.00", credit: "500.00" },
      ],
    },
    {
      title: "inventory surplus and upward revaluation recognize a gain",
      posting: intent("ADJUST_INVENTORY_GAIN", "ADJUST", [
        debitLine("INVENTORY", "300"),
        creditLine("OTHER_REVENUE", "300"),
      ]),
      expected: [
        { role: "INVENTORY", debit: "300.00", credit: "0.00" },
        { role: "OTHER_REVENUE", debit: "0.00", credit: "300.00" },
      ],
    },
    {
      title: "inventory shortage and downward revaluation recognize a loss",
      posting: intent("ADJUST_INVENTORY_LOSS", "ADJUST", [
        debitLine("LOSSES", "300"),
        creditLine("INVENTORY", "300"),
      ]),
      expected: [
        { role: "LOSSES", debit: "300.00", credit: "0.00" },
        { role: "INVENTORY", debit: "0.00", credit: "300.00" },
      ],
    },
  ])("$title", ({ posting, expected }) => {
    const independentComponents = EXACT_COMPONENT_PROFILES.has(posting.profile)
      ? componentsFor(expected)
      : {};
    expect(
      postingLinesFor({
        entryType: posting.entryType,
        intent: posting,
        ...sourceAmounts(posting),
        ...independentComponents,
      }),
    ).toEqual(expected);
  });

  it("reverses asset, settlement, fee, FX gain and FX loss lines without negative journal amounts", () => {
    expect(signedPostingLines("INVENTORY", "AP", "-600")).toEqual([
      { role: "AP", debit: "600.00", credit: "0.00" },
      { role: "INVENTORY", debit: "0.00", credit: "600.00" },
    ]);
    expect(
      signedPostingLines("EXCHANGE_WALLET_IQD", "TREASURY_CASH", "-2500"),
    ).toEqual([
      { role: "TREASURY_CASH", debit: "2500.00", credit: "0.00" },
      { role: "EXCHANGE_WALLET_IQD", debit: "0.00", credit: "2500.00" },
    ]);
    expect(signedPostingLines("AP", "EXCHANGE_WALLET_USD", "-131000")).toEqual([
      { role: "EXCHANGE_WALLET_USD", debit: "131000.00", credit: "0.00" },
      { role: "AP", debit: "0.00", credit: "131000.00" },
    ]);
    expect(
      signedPostingLines("OPERATING_EXPENSE", "EXCHANGE_WALLET_IQD", "-1000"),
    ).toEqual([
      { role: "EXCHANGE_WALLET_IQD", debit: "1000.00", credit: "0.00" },
      { role: "OPERATING_EXPENSE", debit: "0.00", credit: "1000.00" },
    ]);
    expect(
      signedPostingLines("EXCHANGE_WALLET_USD", "FX_GAIN", "-500"),
    ).toEqual([
      { role: "FX_GAIN", debit: "500.00", credit: "0.00" },
      { role: "EXCHANGE_WALLET_USD", debit: "0.00", credit: "500.00" },
    ]);
    expect(signedPostingLines("EXCHANGE_WALLET_USD", "FX_LOSS", "500")).toEqual(
      [
        { role: "EXCHANGE_WALLET_USD", debit: "500.00", credit: "0.00" },
        { role: "FX_LOSS", debit: "0.00", credit: "500.00" },
      ],
    );

    const directDepositReverse = intent(
      "EXCHANGE_DEPOSIT_USD_CASH",
      "EXCHANGE_DEPOSIT",
      signedPostingLines("EXCHANGE_WALLET_USD", "FOREIGN_CASH_USD", "-131000"),
    );
    expect(postingLinesFor({
      entryType: "EXCHANGE_DEPOSIT",
      intent: directDepositReverse,
      ...sourceAmounts(directDepositReverse),
      ...componentsFor(directDepositReverse.lines),
    })).toEqual(directDepositReverse.lines);

    const fxGainReverse = intent(
      "EXCHANGE_FX_GAIN",
      "EXCHANGE_FX_DIFF",
      signedPostingLines("EXCHANGE_WALLET_USD", "FX_GAIN", "-500"),
    );
    expect(postingLinesFor({
      entryType: "EXCHANGE_FX_DIFF",
      intent: fxGainReverse,
      ...sourceAmounts(fxGainReverse),
      ...componentsFor(fxGainReverse.lines),
    })).toEqual(fxGainReverse.lines);

    const fxBuyReverse = intent(
      "EXCHANGE_FX_BUY",
      "EXCHANGE_FX_BUY",
      signedPostingLines("FOREIGN_CASH_USD", "EXCHANGE_WALLET_USD", "-131000"),
    );
    expect(postingLinesFor({
      entryType: "EXCHANGE_FX_BUY",
      intent: fxBuyReverse,
      ...sourceAmounts(fxBuyReverse),
      ...componentsFor(fxBuyReverse.lines),
    })).toEqual(fxBuyReverse.lines);

    const fxLossReverse = intent(
      "EXCHANGE_FX_LOSS",
      "EXCHANGE_FX_DIFF",
      signedPostingLines("EXCHANGE_WALLET_USD", "FX_LOSS", "500"),
    );
    expect(postingLinesFor({
      entryType: "EXCHANGE_FX_DIFF",
      intent: fxLossReverse,
      ...sourceAmounts(fxLossReverse),
      ...componentsFor(fxLossReverse.lines),
    })).toEqual(fxLossReverse.lines);
  });

  it.each([
    {
      title: "positive IQD and USD opening",
      iqd: "1000",
      usdIqd: "650",
      expected: [
        { role: "EXCHANGE_RECEIVABLE_IQD", debit: "1000.00", credit: "0.00" },
        { role: "OPENING_EQUITY", debit: "0.00", credit: "1000.00" },
        { role: "EXCHANGE_RECEIVABLE_USD", debit: "650.00", credit: "0.00" },
        { role: "OPENING_EQUITY", debit: "0.00", credit: "650.00" },
      ],
    },
    {
      title: "negative IQD and USD opening",
      iqd: "-1000",
      usdIqd: "-650",
      expected: [
        { role: "OPENING_EQUITY", debit: "1000.00", credit: "0.00" },
        { role: "EXCHANGE_PAYABLE_IQD", debit: "0.00", credit: "1000.00" },
        { role: "OPENING_EQUITY", debit: "650.00", credit: "0.00" },
        { role: "EXCHANGE_PAYABLE_USD", debit: "0.00", credit: "650.00" },
      ],
    },
    {
      title: "mixed-sign IQD and USD opening",
      iqd: "1000",
      usdIqd: "-650",
      expected: [
        { role: "EXCHANGE_RECEIVABLE_IQD", debit: "1000.00", credit: "0.00" },
        { role: "OPENING_EQUITY", debit: "0.00", credit: "1000.00" },
        { role: "OPENING_EQUITY", debit: "650.00", credit: "0.00" },
        { role: "EXCHANGE_PAYABLE_USD", debit: "0.00", credit: "650.00" },
      ],
    },
  ])(
    "balances $title without collapsing the two currencies",
    ({ iqd, usdIqd, expected }) => {
      const posting = intent("OPENING_EXCHANGE_COMBINED", "OPENING", [
        ...(money(iqd).isPositive()
          ? [debitLine("EXCHANGE_RECEIVABLE_IQD", iqd), creditLine("OPENING_EQUITY", iqd)]
          : [debitLine("OPENING_EQUITY", money(iqd).abs()), creditLine("EXCHANGE_PAYABLE_IQD", money(iqd).abs())]),
        ...(money(usdIqd).isPositive()
          ? [debitLine("EXCHANGE_RECEIVABLE_USD", usdIqd), creditLine("OPENING_EQUITY", usdIqd)]
          : [debitLine("OPENING_EQUITY", money(usdIqd).abs()), creditLine("EXCHANGE_PAYABLE_USD", money(usdIqd).abs())]),
      ]);
      expect(
        postingLinesFor({
          entryType: "OPENING",
          intent: posting,
          ...sourceAmounts(posting),
          ...componentsFor(expected),
        }),
      ).toEqual(expected);
    },
  );

  it("reclassifies each exchange counterparty gross and splits a zero crossing", () => {
    const posting = intent("ADJUST_EXCHANGE_CONTROL_RECLASS", "ADJUST", [
      creditLine("EXCHANGE_WALLET_USD", "1700"),
      debitLine("EXCHANGE_PAYABLE_USD", "700"),
      debitLine("EXCHANGE_RECEIVABLE_USD", "1000"),
    ]);
    expect(postingLinesFor({
      entryType: "ADJUST",
      intent: posting,
      ...componentsFor(posting.lines),
    })).toEqual(posting.lines);
  });

  it("maps direct USD custody deposit and withdrawal to the physical foreign-cash asset", () => {
    const deposit = intent("EXCHANGE_DEPOSIT_USD_CASH", "EXCHANGE_DEPOSIT", [
      debitLine("EXCHANGE_WALLET_USD", "131000"),
      creditLine("FOREIGN_CASH_USD", "131000"),
    ]);
    const withdrawal = intent("EXCHANGE_WITHDRAW_USD_CASH", "EXCHANGE_WITHDRAW", [
      debitLine("FOREIGN_CASH_USD", "131000"),
      creditLine("EXCHANGE_WALLET_USD", "131000"),
    ]);
    expect(postingLinesFor({ entryType: "EXCHANGE_DEPOSIT", intent: deposit, ...sourceAmounts(deposit), ...componentsFor(deposit.lines) }))
      .toEqual(deposit.lines);
    expect(postingLinesFor({ entryType: "EXCHANGE_WITHDRAW", intent: withdrawal, ...sourceAmounts(withdrawal), ...componentsFor(withdrawal.lines) }))
      .toEqual(withdrawal.lines);
  });
});
