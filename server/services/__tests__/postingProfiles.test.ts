import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { accountingEntries } from "../../../drizzle/schema";
import type { EntryType } from "../ledgerService";
import {
  ACCOUNT_ROLES,
  ALL_POSTING_PROFILES,
  ENTRY_TYPE_PROFILES,
  MAPPED_ENTRY_TYPES,
  POSTING_POLICY_HASH,
  PROFILE_POLICIES,
  InvalidPostingIntentError,
  canonicalizePostingIntent,
  createPostingIntent,
  createPostingIntentEvidence,
  creditLine,
  debitLine,
  hashPostingIntent,
  validatePostingIntentPolicy,
  verifyPostingIntentEvidence,
  type AccountRole,
  type JournalLine,
  type PostingIntent,
  type PostingProfile,
  type PostingSourceAmounts,
} from "../accounting/postingEngine";
import { money, round2 } from "../money";
import { CHART_ACCOUNTS } from "../accounting/chartSeed";

const ALL_ENTRY_TYPES: EntryType[] = [
  "SALE",
  "PURCHASE",
  "PAYMENT_IN",
  "PAYMENT_OUT",
  "RETURN",
  "ADJUST",
  "OPENING",
  "INTERNAL_USE",
  "WASTAGE",
  "CASH_HANDOVER",
  "CASH_TRANSFER_OUT",
  "CASH_TRANSFER_IN",
  "SHIFT_FLOAT_OUT",
  "TREASURY_FUNDING",
  "DELIVERY_DISPATCH",
  "DELIVERY_REMIT",
  "DELIVERY_FEE",
  "DELIVERY_FEE_HELD",
  "DELIVERY_WRITEOFF",
  "EXCHANGE_DEPOSIT",
  "EXCHANGE_WITHDRAW",
  "EXCHANGE_FX_BUY",
  "EXCHANGE_SETTLE",
  "EXCHANGE_FEE",
  "EXCHANGE_FX_DIFF",
  "GIFT_OUT",
  "DIGITAL_WALLET_DEPOSIT",
  "DIGITAL_WALLET_WITHDRAWAL",
  "DIGITAL_WALLET_CONSUMPTION",
  "DIGITAL_WALLET_REVERSAL",
  "DIGITAL_WALLET_ADJUSTMENT",
  "DIGITAL_WRITEOFF",
];

const NEW_ROLES = [
  "TREASURY_CASH",
  "CASH_IN_TRANSIT",
  "INTERBRANCH_CLEARING",
  "DELIVERY_FLOAT",
  "COURIER_PAYABLE",
  "DELIVERY_EXPENSE",
  "EXCHANGE_WALLET_IQD",
  "EXCHANGE_WALLET_USD",
  "FOREIGN_CASH_USD",
  "DIGITAL_WALLET",
  "CHECKS_RECEIVABLE",
  "PAYMENT_WALLET",
  "TELECOM_BALANCE",
  "WORK_IN_PROGRESS",
  "FX_GAIN",
  "FX_LOSS",
  "GIFTS_PROMO",
  "ROUNDING_DIFF",
  "TAX_PAYABLE",
  "ACCUMULATED_DEPRECIATION",
  "DEPRECIATION_EXPENSE",
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
  "ASSET_DISPOSAL_GAIN",
  "ASSET_DISPOSAL_LOSS",
  "PURCHASE_PRICE_VARIANCE",
  "PAYROLL_TAX_PAYABLE",
  "SOCIAL_SECURITY_PAYABLE",
  "EOS_PROVISION",
  "SOCIAL_SECURITY_EXPENSE",
  "EOS_EXPENSE",
  "ACCRUED_EXPENSES",
  "EXCHANGE_RECEIVABLE_IQD",
  "EXCHANGE_RECEIVABLE_USD",
  "EXCHANGE_PAYABLE_IQD",
  "EXCHANGE_PAYABLE_USD",
] as const;

function measured(
  lines: readonly JournalLine[],
  roles: readonly AccountRole[],
  measure: "DEBIT_MINUS_CREDIT" | "CREDIT_MINUS_DEBIT",
): string {
  const selected = new Set<AccountRole>(roles);
  let value = money(0);
  for (const line of lines) {
    if (!selected.has(line.role)) continue;
    value = value.plus(line.debit).minus(line.credit);
  }
  if (measure === "CREDIT_MINUS_DEBIT") value = value.neg();
  return round2(value).toFixed(2);
}

function fixtureFor(profile: PostingProfile): {
  intent: PostingIntent;
  source: PostingSourceAmounts;
} {
  const policy = PROFILE_POLICIES[profile];
  if (policy.memoOnly) {
    return {
      intent: createPostingIntent(profile, policy.entryType, []),
      source: {},
    };
  }
  const pattern = policy.requiredOneOf[0]!;
  const lines = pattern.allOf.map((group) => {
    const selected = group.anyOf[0]!;
    return selected.side === "DEBIT"
      ? debitLine(selected.role, "10.00")
      : creditLine(selected.role, "10.00");
  });
  const roleDebits: Partial<Record<AccountRole, string>> = {};
  const roleCredits: Partial<Record<AccountRole, string>> = {};
  for (const role of policy.requireRoleComponents) {
    const debit = lines
      .filter((line) => line.role === role)
      .reduce((sum, line) => sum.plus(line.debit), money(0));
    const credit = lines
      .filter((line) => line.role === role)
      .reduce((sum, line) => sum.plus(line.credit), money(0));
    if (!debit.isZero()) roleDebits[role] = debit.toFixed(2);
    if (!credit.isZero()) roleCredits[role] = credit.toFixed(2);
  }
  const components = policy.requireRoleComponents.length
    ? { roleDebits, roleCredits }
    : undefined;
  const source: PostingSourceAmounts = { ...(components ?? {}) };
  for (const assertion of policy.sourceAssertions) {
    source[assertion.field] = measured(
      lines,
      assertion.roles,
      assertion.measure,
    );
  }
  return {
    intent: createPostingIntent(profile, policy.entryType, lines, components),
    source,
  };
}

describe("posting profile registry and executable policies", () => {
  it("is exhaustive for exactly the 32 EntryTypes and every profile", () => {
    expect(ALL_ENTRY_TYPES).toHaveLength(32);
    expect(Object.keys(ENTRY_TYPE_PROFILES).sort()).toEqual(
      [...ALL_ENTRY_TYPES].sort(),
    );
    expect(MAPPED_ENTRY_TYPES.size).toBe(32);
    expect(Object.isFrozen(ENTRY_TYPE_PROFILES)).toBe(true);
    expect(Object.isFrozen(MAPPED_ENTRY_TYPES)).toBe(true);
    expect(Object.keys(PROFILE_POLICIES).sort()).toEqual(
      [...ALL_POSTING_PROFILES].sort(),
    );
    for (const policy of Object.values(PROFILE_POLICIES)) {
      if (policy.memoOnly) continue;
      expect(
        policy.sourceAssertions.length > 0 ||
          policy.requireRoleComponents.length > 0,
      ).toBe(true);
      const semanticRoleCount = new Set(policy.allowed.map(({ role }) => role))
        .size;
      if (semanticRoleCount > 2) {
        expect(policy.requireRoleComponents.length).toBeGreaterThan(0);
      }
    }
    expect(POSTING_POLICY_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates a policy-correct runtime fixture for every declared profile", () => {
    const owners = new Map<PostingProfile, EntryType>();
    for (const profile of ALL_POSTING_PROFILES) {
      const policy = PROFILE_POLICIES[profile];
      expect(owners.has(profile)).toBe(false);
      owners.set(profile, policy.entryType);
      const { intent, source } = fixtureFor(profile);
      expect(
        validatePostingIntentPolicy(intent, policy.entryType, source),
      ).toMatchObject({ profile, entryType: policy.entryType });
    }
    expect(owners.size).toBe(ALL_POSTING_PROFILES.length);
  });

  it("keeps the producer factory pure but rejects invalid roles at runtime", () => {
    const invalid = createPostingIntent("SALE_SERVICE", "SALE", [
      debitLine("AR", "100.00"),
      creditLine("OTHER_REVENUE", "100.00"),
    ]);
    expect(invalid.profile).toBe("SALE_SERVICE");
    expect(() =>
      validatePostingIntentPolicy(invalid, "SALE", {
        revenue: "100.00",
        cost: "0.00",
        roleDebits: { AR: "100.00" },
        roleCredits: { OTHER_REVENUE: "100.00" },
      }),
    ).toThrow(InvalidPostingIntentError);
  });

  it("detects a credit line even though Decimal +0 reports positive", () => {
    const intent = createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [
      debitLine("CASH", "100.00"),
      creditLine("AR", "100.00"),
    ]);
    expect(() =>
      validatePostingIntentPolicy(intent, "PAYMENT_IN", {
        amount: "100.00",
        roleDebits: { CASH: "100.00" },
        roleCredits: { AR: "100.00" },
      }),
    ).not.toThrow();
  });

  it("keeps interbranch receipt clearing branch-specific and role-exact", () => {
    const sender = createPostingIntent(
      "INTERBRANCH_CLEARING_OUT",
      "CASH_TRANSFER_OUT",
      [
        debitLine("INTERBRANCH_CLEARING", "25.00"),
        creditLine("CASH_IN_TRANSIT", "25.00"),
      ],
    );
    const receiver = createPostingIntent(
      "CASH_TRANSFER_IN_FROM_CLEARING",
      "CASH_TRANSFER_IN",
      [
        debitLine("TREASURY_CASH", "25.00"),
        creditLine("INTERBRANCH_CLEARING", "25.00"),
      ],
    );
    expect(() =>
      validatePostingIntentPolicy(sender, "CASH_TRANSFER_OUT", {
        amount: "25.00",
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(receiver, "CASH_TRANSFER_IN", {
        amount: "25.00",
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent(
          "CASH_TRANSFER_IN_FROM_CLEARING",
          "CASH_TRANSFER_IN",
          [
            debitLine("TREASURY_CASH", "25.00"),
            creditLine("CASH_IN_TRANSIT", "25.00"),
          ],
        ),
        "CASH_TRANSFER_IN",
        { amount: "25.00" },
      ),
    ).toThrow(InvalidPostingIntentError);
  });

  it("rejects amount mismatch and missing/mismatched independent components", () => {
    const payment = createPostingIntent("PAYMENT_IN_CUSTOMER", "PAYMENT_IN", [
      debitLine("CASH", "90.00"),
      creditLine("AR", "90.00"),
    ]);
    expect(() =>
      validatePostingIntentPolicy(payment, "PAYMENT_IN", {
        amount: "100.00",
        roleDebits: { CASH: "90.00" },
        roleCredits: { AR: "90.00" },
      }),
    ).toThrow(/amount=100.00/);

    const declared = {
      roleDebits: { AR: "100.00" },
      roleCredits: { SALES_FLEX: "100.00" },
    } as const;
    const service = createPostingIntent(
      "SALE_SERVICE_FLEX",
      "SALE",
      [debitLine("AR", "100.00"), creditLine("SALES_FLEX", "100.00")],
      declared,
    );
    expect(() =>
      validatePostingIntentPolicy(service, "SALE", {
        amount: "100.00",
        revenue: "100.00",
        cost: "0.00",
      }),
    ).toThrow(/independent source role components are missing/);
    expect(() =>
      validatePostingIntentPolicy(service, "SALE", {
        amount: "100.00",
        revenue: "100.00",
        cost: "0.00",
        roleDebits: { AR: "100.00" },
        roleCredits: { SALES_FLEX: "90.00" },
      }),
    ).toThrow(/do not match/);
  });

  it("keeps voucher category normal and reversal directions exact", () => {
    const validate = (
      profile: PostingProfile,
      entryType: "PAYMENT_IN" | "PAYMENT_OUT",
      debitRole: AccountRole,
      creditRole: AccountRole,
    ) => {
      const components = {
        roleDebits: { [debitRole]: "100.00" },
        roleCredits: { [creditRole]: "100.00" },
      };
      return () => validatePostingIntentPolicy(
          createPostingIntent(
            profile,
            entryType,
            [debitLine(debitRole, "100.00"), creditLine(creditRole, "100.00")],
            components,
          ),
          entryType,
          { amount: "100.00", ...components },
        );
    };

    expect(validate("PAYMENT_IN_CATEGORY", "PAYMENT_IN", "CASH", "OTHER_REVENUE")).not.toThrow();
    expect(validate("PAYMENT_OUT_CATEGORY", "PAYMENT_OUT", "RENT", "CASH")).not.toThrow();
    expect(validate("PAYMENT_IN_CATEGORY_REVERSAL", "PAYMENT_IN", "CASH", "RENT")).not.toThrow();
    expect(validate("PAYMENT_OUT_CATEGORY_REVERSAL", "PAYMENT_OUT", "OTHER_REVENUE", "CASH")).not.toThrow();

    expect(validate("PAYMENT_IN_CATEGORY", "PAYMENT_IN", "CASH", "RENT")).toThrow(InvalidPostingIntentError);
    expect(validate("PAYMENT_OUT_CATEGORY", "PAYMENT_OUT", "OTHER_REVENUE", "CASH")).toThrow(InvalidPostingIntentError);
    expect(validate("PAYMENT_IN_CATEGORY_REVERSAL", "PAYMENT_IN", "CASH", "OTHER_REVENUE")).toThrow(InvalidPostingIntentError);
    expect(validate("PAYMENT_OUT_CATEGORY_REVERSAL", "PAYMENT_OUT", "RENT", "CASH")).toThrow(InvalidPostingIntentError);
  });

  it("rejects balanced but source-false P&L classifications and costs", () => {
    const wrongCost = createPostingIntent("SALE_INVENTORY", "SALE", [
      debitLine("AR", "100.00"),
      creditLine("SALES_STATIONERY", "100.00"),
      debitLine("COGS", "5.00"),
      creditLine("INVENTORY", "5.00"),
    ]);
    expect(() =>
      validatePostingIntentPolicy(wrongCost, "SALE", {
        amount: "100.00",
        revenue: "100.00",
        cost: "60.00",
        roleDebits: { AR: "100.00", COGS: "60.00" },
        roleCredits: { SALES_STATIONERY: "100.00", INVENTORY: "60.00" },
      }),
    ).toThrow(/component COGS|source cost/);

    const wrongRevenueSplit = createPostingIntent("SALE_INVENTORY", "SALE", [
      debitLine("AR", "100.00"),
      creditLine("SALES_STATIONERY", "90.00"),
      creditLine("DELIVERY_REVENUE", "10.00"),
    ]);
    expect(() =>
      validatePostingIntentPolicy(wrongRevenueSplit, "SALE", {
        amount: "100.00",
        revenue: "100.00",
        cost: "0.00",
        roleDebits: { AR: "100.00" },
        roleCredits: { SALES_STATIONERY: "100.00" },
      }),
    ).toThrow(/component SALES_STATIONERY/);

    const wrongExpenseClass = createPostingIntent(
      "PAYMENT_OUT_EXPENSE",
      "PAYMENT_OUT",
      [debitLine("RENT", "100.00"), creditLine("CASH", "100.00")],
    );
    expect(() =>
      validatePostingIntentPolicy(wrongExpenseClass, "PAYMENT_OUT", {
        amount: "100.00",
        roleDebits: { OPERATING_EXPENSE: "100.00" },
        roleCredits: { CASH: "100.00" },
      }),
    ).toThrow(/component RENT/);

    const wrongExchangeExpense = createPostingIntent(
      "EXCHANGE_FEE_EXPENSE",
      "EXCHANGE_FEE",
      [
        debitLine("OTHER_EXPENSE", "100.00"),
        creditLine("EXCHANGE_WALLET_IQD", "100.00"),
      ],
    );
    expect(() =>
      validatePostingIntentPolicy(wrongExchangeExpense, "EXCHANGE_FEE", {
        amount: "100.00",
        roleDebits: { OPERATING_EXPENSE: "100.00" },
        roleCredits: { EXCHANGE_WALLET_IQD: "100.00" },
      }),
    ).toThrow(/component OPERATING_EXPENSE|component OTHER_EXPENSE/);
  });

  it("enforces exact payroll accrual and liability-clearing components", () => {
    const components = {
      roleDebits: {
        SALARIES: "100.00",
        SOCIAL_SECURITY_EXPENSE: "12.00",
        EOS_EXPENSE: "5.00",
      },
      roleCredits: {
        ACCRUED_SALARY: "65.00",
        EMPLOYEE_ADVANCES: "10.00",
        PAYROLL_TAX_PAYABLE: "8.00",
        SOCIAL_SECURITY_PAYABLE: "29.00",
        EOS_PROVISION: "5.00",
      },
    } as const;
    const accrual = createPostingIntent(
      "ADJUST_PAYROLL_ACCRUAL",
      "ADJUST",
      [
        debitLine("SALARIES", "100.00"),
        debitLine("SOCIAL_SECURITY_EXPENSE", "12.00"),
        debitLine("EOS_EXPENSE", "5.00"),
        creditLine("ACCRUED_SALARY", "65.00"),
        creditLine("EMPLOYEE_ADVANCES", "10.00"),
        creditLine("PAYROLL_TAX_PAYABLE", "8.00"),
        creditLine("SOCIAL_SECURITY_PAYABLE", "29.00"),
        creditLine("EOS_PROVISION", "5.00"),
      ],
      components,
    );
    expect(() =>
      validatePostingIntentPolicy(accrual, "ADJUST", {
        amount: "117.00",
        ...components,
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(accrual, "ADJUST", {
        amount: "117.00",
        ...components,
        roleCredits: { ...components.roleCredits, ACCRUED_SALARY: "64.99" },
      }),
    ).toThrow(/do not match/);

    const netPaymentComponents = {
      roleDebits: { ACCRUED_SALARY: "65.00" },
      roleCredits: { TREASURY_CASH: "65.00" },
    } as const;
    const netPayment = createPostingIntent(
      "PAYMENT_OUT_PAYROLL_NET",
      "PAYMENT_OUT",
      [
        debitLine("ACCRUED_SALARY", "65.00"),
        creditLine("TREASURY_CASH", "65.00"),
      ],
      netPaymentComponents,
    );
    expect(() =>
      validatePostingIntentPolicy(netPayment, "PAYMENT_OUT", {
        amount: "65.00",
        ...netPaymentComponents,
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent("PAYMENT_OUT_PAYROLL_NET", "PAYMENT_OUT", [
          debitLine("SALARIES", "65.00"),
          creditLine("TREASURY_CASH", "65.00"),
        ]),
        "PAYMENT_OUT",
        { amount: "65.00" },
      ),
    ).toThrow(InvalidPostingIntentError);
  });

  it("settles EOS provision before expensing a shortfall and releases a surplus exactly", () => {
    const shortageComponents = {
      roleDebits: {
        SALARIES: "20.00",
        SOCIAL_SECURITY_EXPENSE: "0.00",
        EOS_PROVISION: "60.00",
        EOS_EXPENSE: "40.00",
        INTERBRANCH_CLEARING: "0.00",
      },
      roleCredits: {
        ACCRUED_SALARY: "120.00",
        EMPLOYEE_ADVANCES: "0.00",
        PAYROLL_TAX_PAYABLE: "0.00",
        SOCIAL_SECURITY_PAYABLE: "0.00",
      },
    } as const;
    const shortage = createPostingIntent(
      "ADJUST_EOS_SETTLEMENT",
      "ADJUST",
      [
        debitLine("SALARIES", "20.00"),
        debitLine("EOS_PROVISION", "60.00"),
        debitLine("EOS_EXPENSE", "40.00"),
        creditLine("ACCRUED_SALARY", "120.00"),
      ],
      shortageComponents,
    );
    expect(() =>
      validatePostingIntentPolicy(shortage, "ADJUST", shortageComponents),
    ).not.toThrow();

    const grossToNetComponents = {
      roleDebits: {
        SALARIES: "500.00",
        SOCIAL_SECURITY_EXPENSE: "30.00",
        EOS_PROVISION: "0.00",
        EOS_EXPENSE: "0.00",
        INTERBRANCH_CLEARING: "0.00",
      },
      roleCredits: {
        ACCRUED_SALARY: "325.00",
        EMPLOYEE_ADVANCES: "100.00",
        PAYROLL_TAX_PAYABLE: "50.00",
        SOCIAL_SECURITY_PAYABLE: "55.00",
        EOS_EXPENSE: "0.00",
      },
    } as const;
    const grossToNet = createPostingIntent(
      "ADJUST_EOS_SETTLEMENT",
      "ADJUST",
      [
        debitLine("SALARIES", "500.00"),
        debitLine("SOCIAL_SECURITY_EXPENSE", "30.00"),
        creditLine("ACCRUED_SALARY", "325.00"),
        creditLine("EMPLOYEE_ADVANCES", "100.00"),
        creditLine("PAYROLL_TAX_PAYABLE", "50.00"),
        creditLine("SOCIAL_SECURITY_PAYABLE", "55.00"),
      ],
      grossToNetComponents,
    );
    expect(() =>
      validatePostingIntentPolicy(
        grossToNet,
        "ADJUST",
        grossToNetComponents,
      ),
    ).not.toThrow();

    const releaseComponents = {
      roleDebits: {
        SALARIES: "0.00",
        SOCIAL_SECURITY_EXPENSE: "0.00",
        EOS_PROVISION: "100.00",
        EOS_EXPENSE: "0.00",
        INTERBRANCH_CLEARING: "0.00",
      },
      roleCredits: {
        ACCRUED_SALARY: "70.00",
        EMPLOYEE_ADVANCES: "0.00",
        PAYROLL_TAX_PAYABLE: "0.00",
        SOCIAL_SECURITY_PAYABLE: "0.00",
        EOS_EXPENSE: "30.00",
      },
    } as const;
    const release = createPostingIntent(
      "ADJUST_EOS_SETTLEMENT",
      "ADJUST",
      [
        debitLine("EOS_PROVISION", "100.00"),
        creditLine("ACCRUED_SALARY", "70.00"),
        creditLine("EOS_EXPENSE", "30.00"),
      ],
      releaseComponents,
    );
    expect(() =>
      validatePostingIntentPolicy(release, "ADJUST", releaseComponents),
    ).not.toThrow();

    const reverseComponents = {
      roleDebits: {
        ACCRUED_SALARY: "70.00",
        EMPLOYEE_ADVANCES: "0.00",
        PAYROLL_TAX_PAYABLE: "0.00",
        SOCIAL_SECURITY_PAYABLE: "0.00",
        EOS_EXPENSE: "30.00",
      },
      roleCredits: {
        SALARIES: "0.00",
        SOCIAL_SECURITY_EXPENSE: "0.00",
        EOS_PROVISION: "100.00",
        EOS_EXPENSE: "0.00",
        INTERBRANCH_CLEARING: "0.00",
      },
    } as const;
    const reverse = createPostingIntent(
      "ADJUST_EOS_SETTLEMENT_REVERSAL",
      "ADJUST",
      [
        debitLine("ACCRUED_SALARY", "70.00"),
        debitLine("EOS_EXPENSE", "30.00"),
        creditLine("EOS_PROVISION", "100.00"),
      ],
      reverseComponents,
    );
    expect(() =>
      validatePostingIntentPolicy(reverse, "ADJUST", reverseComponents),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(reverse, "ADJUST", {
        ...reverseComponents,
        roleCredits: { EOS_PROVISION: "99.99" },
      }),
    ).toThrow(/do not match/);

    const transferComponents = {
      roleDebits: { EOS_PROVISION: "25.00" },
      roleCredits: { INTERBRANCH_CLEARING: "25.00" },
    } as const;
    const transfer = createPostingIntent(
      "ADJUST_EOS_PROVISION_TRANSFER_OUT",
      "ADJUST",
      [
        debitLine("EOS_PROVISION", "25.00"),
        creditLine("INTERBRANCH_CLEARING", "25.00"),
      ],
      transferComponents,
    );
    expect(() =>
      validatePostingIntentPolicy(transfer, "ADJUST", transferComponents),
    ).not.toThrow();
    const transferReversalComponents = {
      roleDebits: { INTERBRANCH_CLEARING: "25.00" },
      roleCredits: { EOS_PROVISION: "25.00" },
    } as const;
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent(
          "ADJUST_EOS_PROVISION_TRANSFER_REVERSAL",
          "ADJUST",
          [
            debitLine("INTERBRANCH_CLEARING", "25.00"),
            creditLine("EOS_PROVISION", "25.00"),
          ],
          transferReversalComponents,
        ),
        "ADJUST",
        transferReversalComponents,
      ),
    ).not.toThrow();
  });

  it("keeps accrued settlement reversals signed and exchange opening off raw wallets", () => {
    const returned = {
      roleDebits: { TREASURY_CASH: "25.00" },
      roleCredits: { ACCRUED_EXPENSES: "25.00" },
    } as const;
    const settlementReturn = createPostingIntent(
      "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
      "PAYMENT_OUT",
      [
        debitLine("TREASURY_CASH", "25.00"),
        creditLine("ACCRUED_EXPENSES", "25.00"),
      ],
      returned,
    );
    expect(() =>
      validatePostingIntentPolicy(settlementReturn, "PAYMENT_OUT", {
        amount: "-25.00",
        ...returned,
      }),
    ).not.toThrow();

    const exchangeComponents = {
      roleDebits: {
        EXCHANGE_RECEIVABLE_IQD: "100.00",
        OPENING_EQUITY: "40.00",
      },
      roleCredits: {
        EXCHANGE_PAYABLE_USD: "140.00",
      },
    } as const;
    const exchangeOpening = createPostingIntent(
      "OPENING_EXCHANGE_COMBINED",
      "OPENING",
      [
        debitLine("EXCHANGE_RECEIVABLE_IQD", "100.00"),
        debitLine("OPENING_EQUITY", "40.00"),
        creditLine("EXCHANGE_PAYABLE_USD", "140.00"),
      ],
      exchangeComponents,
    );
    expect(() =>
      validatePostingIntentPolicy(exchangeOpening, "OPENING", {
        ...exchangeComponents,
      }),
    ).not.toThrow();
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent("OPENING_EXCHANGE_COMBINED", "OPENING", [
          debitLine("EXCHANGE_WALLET_IQD", "100.00"),
          creditLine("OPENING_EQUITY", "100.00"),
        ]),
        "OPENING",
        { amount: "100.00" },
      ),
    ).toThrow(InvalidPostingIntentError);
  });

  it("permits only declared memo profiles and never memo lines", () => {
    for (const profile of [
      "DELIVERY_DISPATCH_COD",
      "GIFT_OUT_CONSIGNMENT_MEMO",
      "ADJUST_YEAR_CLOSE_ZERO",
    ] as const) {
      const intent = createPostingIntent(
        profile,
        PROFILE_POLICIES[profile].entryType,
        [],
      );
      expect(() =>
        validatePostingIntentPolicy(intent, intent.entryType, {}),
      ).not.toThrow();
    }
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent("SALE_SERVICE", "SALE", []),
        "SALE",
        {},
      ),
    ).toThrow();
    expect(() =>
      validatePostingIntentPolicy(
        createPostingIntent("DELIVERY_DISPATCH_COD", "DELIVERY_DISPATCH", [
          debitLine("DELIVERY_FLOAT", "1.00"),
          creditLine("AR", "1.00"),
        ]),
        "DELIVERY_DISPATCH",
        {},
      ),
    ).toThrow();
  });
});

describe("canonical PostingIntent evidence", () => {
  const paymentComponents = {
    roleDebits: { CASH: "100.00" },
    roleCredits: { AR: "100.00" },
  } as const;
  const intent = createPostingIntent(
    "PAYMENT_IN_CUSTOMER",
    "PAYMENT_IN",
    [creditLine("AR", "100"), debitLine("CASH", "100.0")],
    paymentComponents,
  );

  it("normalizes/sorts v1 deterministically and binds the row entryType", () => {
    const evidence = createPostingIntentEvidence(intent, {
      amount: "100",
      ...paymentComponents,
    });
    expect(evidence.postingIntentHash).toBe(hashPostingIntent(intent));
    expect(canonicalizePostingIntent(intent)).toContain('"debit":"100.00"');
    expect(
      verifyPostingIntentEvidence({
        expectedEntryType: "PAYMENT_IN",
        ...evidence,
        source: { amount: "100.00" },
      }),
    ).toMatchObject({ profile: "PAYMENT_IN_CUSTOMER" });
    expect(() =>
      verifyPostingIntentEvidence({
        expectedEntryType: "SALE",
        ...evidence,
        source: { amount: "100.00" },
      }),
    ).toThrow(/does not match/);
  });

  it("round-trips sealed role components without requiring live document facts", () => {
    const source: PostingSourceAmounts = {
      amount: "100.00",
      revenue: "100.00",
      cost: "60.00",
      roleDebits: { AR: "100.00", COGS: "60.00" },
      roleCredits: { SALES_STATIONERY: "100.00", INVENTORY: "60.00" },
    };
    const sale = createPostingIntent("SALE_INVENTORY", "SALE", [
      debitLine("AR", "100.00"),
      creditLine("SALES_STATIONERY", "100.00"),
      debitLine("COGS", "60.00"),
      creditLine("INVENTORY", "60.00"),
    ]);
    const evidence = createPostingIntentEvidence(sale, source);
    expect(() =>
      verifyPostingIntentEvidence({
        expectedEntryType: "SALE",
        ...evidence,
        source: { amount: "100.00", revenue: "100.00", cost: "60.00" },
      }),
    ).not.toThrow();
    expect(() =>
      verifyPostingIntentEvidence({
        expectedEntryType: "SALE",
        ...evidence,
        source: {
          amount: "100.00",
          revenue: "100.00",
          cost: "60.00",
          roleDebits: { AR: "100.00", COGS: "5.00" },
          roleCredits: { SALES_STATIONERY: "100.00", INVENTORY: "5.00" },
        },
      }),
    ).toThrow(/do not match/);
  });

  it("rejects component tampering with either an old or recomputed hash", () => {
    const original = createPostingIntent("SALE_INVENTORY", "SALE", [
      debitLine("AR", "100.00"),
      creditLine("SALES_STATIONERY", "100.00"),
      debitLine("COGS", "60.00"),
      creditLine("INVENTORY", "60.00"),
    ]);
    const originalEvidence = createPostingIntentEvidence(original, {
      amount: "100.00",
      revenue: "100.00",
      cost: "60.00",
      roleDebits: { AR: "100.00", COGS: "60.00" },
      roleCredits: { SALES_STATIONERY: "100.00", INVENTORY: "60.00" },
    });
    const tampered = createPostingIntent(
      "SALE_INVENTORY",
      "SALE",
      [
        debitLine("AR", "100.00"),
        creditLine("SALES_STATIONERY", "100.00"),
        debitLine("COGS", "5.00"),
        creditLine("INVENTORY", "5.00"),
      ],
      {
        roleDebits: { AR: "100.00", COGS: "5.00" },
        roleCredits: { SALES_STATIONERY: "100.00", INVENTORY: "5.00" },
      },
    );
    const tamperedJson = JSON.parse(canonicalizePostingIntent(tampered));
    expect(() =>
      verifyPostingIntentEvidence({
        expectedEntryType: "SALE",
        postingProfile: "SALE_INVENTORY",
        postingIntentJson: tamperedJson,
        postingIntentHash: originalEvidence.postingIntentHash,
        source: { amount: "100.00", revenue: "100.00", cost: "5.00" },
      }),
    ).toThrow(/postingIntentHash does not match/);
    expect(() =>
      verifyPostingIntentEvidence({
        expectedEntryType: "SALE",
        postingProfile: "SALE_INVENTORY",
        postingIntentJson: tamperedJson,
        postingIntentHash: hashPostingIntent(tampered),
        source: { amount: "100.00", revenue: "100.00", cost: "60.00" },
      }),
    ).toThrow(/source cost=60.00/);
  });

  it("rejects JSON tampering with the old hash", () => {
    const evidence = createPostingIntentEvidence(intent, {
      amount: "100.00",
      ...paymentComponents,
    });
    const tampered = JSON.parse(JSON.stringify(evidence.postingIntentJson));
    tampered.lines[0].credit = "99.00";
    expect(() =>
      verifyPostingIntentEvidence({
        expectedEntryType: "PAYMENT_IN",
        postingProfile: evidence.postingProfile,
        postingIntentJson: tampered,
        postingIntentHash: evidence.postingIntentHash,
        source: { amount: "100.00" },
      }),
    ).toThrow(InvalidPostingIntentError);
  });

  it("rejects a recomputed hash when the document violates policy", () => {
    const invalid = createPostingIntent("SALE_SERVICE", "SALE", [
      debitLine("AR", "100.00"),
      creditLine("OTHER_REVENUE", "100.00"),
    ]);
    expect(() =>
      verifyPostingIntentEvidence({
        expectedEntryType: "SALE",
        postingProfile: invalid.profile,
        postingIntentJson: JSON.parse(canonicalizePostingIntent(invalid)),
        postingIntentHash: hashPostingIntent(invalid),
        source: {
          amount: "100.00",
          revenue: "100.00",
          cost: "0.00",
          roleDebits: { AR: "100.00" },
          roleCredits: { OTHER_REVENUE: "100.00" },
        },
      }),
    ).toThrow(InvalidPostingIntentError);
  });
});

describe("P2 chart roles", () => {
  it("backs each approved role with one unique test-chart account", () => {
    const runtimeRoles = new Set<string>(ACCOUNT_ROLES);
    const chartRoles = new Set(CHART_ACCOUNTS.map((a) => a.systemRole));
    for (const role of NEW_ROLES) {
      expect(runtimeRoles.has(role)).toBe(true);
      expect(chartRoles.has(role)).toBe(true);
    }
    const added = CHART_ACCOUNTS.filter((a) =>
      NEW_ROLES.includes(a.systemRole as (typeof NEW_ROLES)[number]),
    );
    expect(added).toHaveLength(NEW_ROLES.length);
    expect(new Set(added.map((a) => a.code)).size).toBe(added.length);
    expect(new Set(added.map((a) => a.systemRole)).size).toBe(added.length);
  });

  it("persists and indexes exact posting-cycle ownership in schema and 0184", () => {
    const table = getTableConfig(accountingEntries);
    expect(
      table.columns.some((column) => column.name === "postingCycleId"),
    ).toBe(true);
    expect(
      table.indexes.some(
        (index) => index.config.name === "idx_entry_posting_cycle",
      ),
    ).toBe(true);
    const migration = readFileSync(
      new URL(
        "../../../drizzle/migrations/0187_double_entry_posting_profiles.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toMatch(/ADD COLUMN `postingCycleId` varchar\(36\) NULL/);
    expect(migration).toMatch(/idx_entry_posting_cycle.*`postingCycleId`/s);
  });
});
