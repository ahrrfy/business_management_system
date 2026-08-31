import { createHash, timingSafeEqual } from "node:crypto";
import type { Decimal } from "decimal.js";
import type { EntryType } from "../ledgerService";
import { money, round2, type DecimalInput } from "../money";

/** Stable semantic roles resolved to chart accounts when a journal is written. */
export const ACCOUNT_ROLES = [
  "CASH",
  "CARD_BANK",
  "CHECKS_RECEIVABLE",
  "PAYMENT_WALLET",
  "TELECOM_BALANCE",
  "TREASURY_CASH",
  "CASH_IN_TRANSIT",
  "INTERBRANCH_CLEARING",
  "INVENTORY",
  "WORK_IN_PROGRESS",
  "AR",
  "EMPLOYEE_ADVANCES",
  "FIXED_ASSETS",
  "EXCHANGE_WALLET_IQD",
  "EXCHANGE_WALLET_USD",
  "EXCHANGE_RECEIVABLE_IQD",
  "EXCHANGE_RECEIVABLE_USD",
  "EXCHANGE_PAYABLE_IQD",
  "EXCHANGE_PAYABLE_USD",
  "FOREIGN_CASH_USD",
  "DIGITAL_WALLET",
  "DELIVERY_FLOAT",
  "AP",
  "CONSIGNMENT_PAYABLE",
  "ACCRUED_SALARY",
  "PAYROLL_TAX_PAYABLE",
  "SOCIAL_SECURITY_PAYABLE",
  "EOS_PROVISION",
  "ACCRUED_EXPENSES",
  "COURIER_PAYABLE",
  "TAX_PAYABLE",
  "ACCUMULATED_DEPRECIATION",
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
  "OTHER_LIABILITY",
  "CAPITAL",
  "RETAINED_EARNINGS",
  "OPENING_EQUITY",
  "SALES_STATIONERY",
  "SALES_PRINT",
  "SALES_FLEX",
  "DELIVERY_REVENUE",
  "EXCHANGE_COMMISSION",
  "FX_GAIN",
  "OTHER_REVENUE",
  "COGS",
  "SALARIES",
  "SOCIAL_SECURITY_EXPENSE",
  "EOS_EXPENSE",
  "RENT",
  "UTILITIES",
  "OPERATING_EXPENSE",
  "DELIVERY_EXPENSE",
  "GIFTS_PROMO",
  "DEPRECIATION_EXPENSE",
  "FX_LOSS",
  "ROUNDING_DIFF",
  "ASSET_DISPOSAL_GAIN",
  "ASSET_DISPOSAL_LOSS",
  "PURCHASE_PRICE_VARIANCE",
  "LOSSES",
  "OTHER_EXPENSE",
] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export interface JournalLine {
  role: AccountRole;
  debit: string;
  credit: string;
}

/** The persisted operational meaning that selected the journal map. */
export type PostingProfile =
  | "SALE_INVENTORY"
  | "SALE_SERVICE"
  | "SALE_SERVICE_FLEX"
  | "SALE_FIXED_ASSET"
  | "SALE_DIGITAL"
  | "SALE_CONSIGNMENT"
  | "SALE_MIXED"
  | "PURCHASE_INVENTORY"
  | "PURCHASE_INVENTORY_CASH_CLEARING"
  | "PURCHASE_FIXED_ASSET"
  | "PURCHASE_DIGITAL"
  | "PURCHASE_CONSIGNMENT"
  | "PURCHASE_CONSIGNMENT_SHORTAGE"
  | "PAYMENT_IN_CUSTOMER"
  | "PAYMENT_IN_SUPPLIER_REFUND"
  | "PAYMENT_IN_PURCHASE_CASH_CLEARING"
  | "PAYMENT_IN_OTHER"
  | "PAYMENT_IN_CATEGORY"
  | "PAYMENT_IN_CATEGORY_REVERSAL"
  | "PAYMENT_IN_TREASURY"
  | "PAYMENT_IN_COURIER"
  | "PAYMENT_IN_PAYROLL_NET_RETURN"
  | "PAYMENT_IN_PAYROLL_TAX_RETURN"
  | "PAYMENT_IN_PAYROLL_SS_RETURN"
  | "PAYMENT_IN_EMPLOYEE_ADVANCE_REPAYMENT"
  | "PAYMENT_OUT_SUPPLIER"
  | "PAYMENT_OUT_PURCHASE_CASH_CLEARING"
  | "PAYMENT_OUT_CUSTOMER_REFUND"
  | "PAYMENT_OUT_DIGITAL_REFUND"
  | "PAYMENT_OUT_EXPENSE"
  | "PAYMENT_OUT_SALARY"
  | "PAYMENT_OUT_FIXED_ASSET"
  | "PAYMENT_OUT_EMPLOYEE_ADVANCE"
  | "PAYMENT_OUT_EMPLOYEE_ADVANCE_REPAYMENT_RETURN"
  | "PAYMENT_OUT_COURIER"
  | "PAYMENT_OUT_PAYROLL_NET"
  | "PAYMENT_OUT_PAYROLL_TAX_REMIT"
  | "PAYMENT_OUT_PAYROLL_SS_REMIT"
  | "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT"
  | "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT"
  | "PAYMENT_OUT_OTHER"
  | "PAYMENT_OUT_CATEGORY"
  | "PAYMENT_OUT_CATEGORY_REVERSAL"
  | "RETURN_SALE_INVENTORY"
  | "RETURN_SALE_SERVICE"
  | "RETURN_SALE_FLEX"
  | "RETURN_SALE_FLEX_WORKORDER"
  | "RETURN_SALE_FIXED_ASSET"
  | "RETURN_SALE_DIGITAL"
  | "RETURN_SALE_CONSIGNMENT"
  | "RETURN_SALE_MIXED"
  | "RETURN_PURCHASE_INVENTORY"
  | "RETURN_PURCHASE_INVENTORY_CASH_CLEARING"
  | "RETURN_PURCHASE_FIXED_ASSET"
  | "RETURN_PURCHASE_DIGITAL"
  | "RETURN_PURCHASE_CONSIGNMENT"
  | "ADJUST_INVENTORY_GAIN"
  | "ADJUST_INVENTORY_LOSS"
  | "ADJUST_WIP_CONSUME"
  | "ADJUST_WIP_WASTE"
  | "ADJUST_WIP_CANCEL"
  | "ADJUST_CASH"
  | "ADJUST_AR"
  | "ADJUST_AP"
  | "ADJUST_ROUNDING"
  | "ADJUST_DEPRECIATION"
  | "ADJUST_TAX"
  | "ADJUST_OWNER_CURRENT"
  | "ADJUST_LOAN"
  | "ADJUST_ASSET_DISPOSAL"
  | "ADJUST_YEAR_CLOSE"
  | "ADJUST_YEAR_CLOSE_ZERO"
  | "ADJUST_PAYROLL_ACCRUAL"
  | "ADJUST_PAYROLL_ACCRUAL_REVERSAL"
  | "ADJUST_EOS_SETTLEMENT"
  | "ADJUST_EOS_SETTLEMENT_REVERSAL"
  | "ADJUST_EOS_PROVISION_TRANSFER_OUT"
  | "ADJUST_EOS_PROVISION_TRANSFER_REVERSAL"
  | "ADJUST_TERMINATION_ADVANCE_TRANSFER_OUT"
  | "ADJUST_TERMINATION_ADVANCE_TRANSFER_REVERSAL"
  | "ADJUST_EXPENSE_ACCRUAL"
  | "ADJUST_EXPENSE_ACCRUAL_REVERSAL"
  | "ADJUST_FIXED_ASSET_ACCRUAL"
  | "ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL"
  | "ADJUST_EXCHANGE_CONTROL_RECLASS"
  | "CASH_DAILY_SHORTAGE"
  | "CASH_DAILY_SURPLUS"
  | "OPENING_CUSTOMER"
  | "OPENING_SUPPLIER"
  | "OPENING_CASH"
  | "OPENING_TREASURY"
  | "OPENING_INVENTORY"
  | "OPENING_FIXED_ASSET"
  | "OPENING_EMPLOYEE_ADVANCE"
  | "OPENING_EXCHANGE_IQD"
  | "OPENING_EXCHANGE_USD"
  | "OPENING_EXCHANGE_COMBINED"
  | "OPENING_DIGITAL_WALLET"
  | "OPENING_OWNER_CURRENT"
  | "OPENING_LOAN"
  | "INTERNAL_USE_INVENTORY"
  | "WASTAGE_INVENTORY"
  | "CASH_HANDOVER_TO_TREASURY"
  | "CASH_HANDOVER_TO_TRANSIT"
  | "CASH_DROP_TO_TRANSIT"
  | "CASH_TRANSFER_OUT_IN_TRANSIT"
  | "INTERBRANCH_CLEARING_OUT"
  | "CASH_TRANSFER_IN_FROM_TRANSIT"
  | "CASH_TRANSFER_IN_FROM_CLEARING"
  | "CASH_CUSTODY_SHORTAGE"
  | "CASH_CUSTODY_SURPLUS"
  | "SHIFT_FLOAT_FROM_TREASURY"
  | "TREASURY_FUNDING_CAPITAL"
  | "TREASURY_FUNDING_OWNER_CURRENT"
  | "TREASURY_FUNDING_LOAN"
  | "DELIVERY_DISPATCH_COD"
  | "DELIVERY_REMIT_COD"
  | "DELIVERY_FEE_EXPENSE"
  | "DELIVERY_FEE_ACCRUAL"
  | "DELIVERY_FEE_SETTLEMENT"
  | "DELIVERY_COMMISSION_SETTLEMENT"
  | "DELIVERY_FEE_HELD_RECEIPT"
  | "DELIVERY_FEE_HELD_PAYOUT"
  | "DELIVERY_WRITEOFF_FLOAT"
  | "EXCHANGE_DEPOSIT_IQD"
  | "EXCHANGE_DEPOSIT_USD_CASH"
  | "EXCHANGE_WITHDRAW_IQD"
  | "EXCHANGE_WITHDRAW_USD_CASH"
  | "EXCHANGE_FX_BUY"
  | "EXCHANGE_SETTLE_SUPPLIER"
  | "EXCHANGE_FEE_EXPENSE"
  | "EXCHANGE_FX_GAIN"
  | "EXCHANGE_FX_LOSS"
  | "GIFT_OUT_PROMO"
  | "GIFT_OUT_MIXED_PROMO"
  | "GIFT_OUT_CONSIGNMENT_MEMO"
  | "DIGITAL_WALLET_DEPOSIT_ASSET"
  | "DIGITAL_WALLET_WITHDRAWAL_ASSET"
  | "DIGITAL_WALLET_CONSUMPTION_SALE"
  | "DIGITAL_WALLET_REVERSAL_SALE"
  | "DIGITAL_WALLET_ADJUSTMENT_GAIN"
  | "DIGITAL_WALLET_ADJUSTMENT_LOSS"
  | "DIGITAL_WRITEOFF_EXPENSE";

/** Synthetic journal heads also persist this cutover profile. */
export type JournalPostingProfile = PostingProfile | "SHADOW_OPENING_V1";

function freezeProfileRegistry(
  registry: Record<EntryType, readonly PostingProfile[]>,
): Readonly<Record<EntryType, readonly PostingProfile[]>> {
  (Object.keys(registry) as EntryType[]).forEach((entryType) =>
    Object.freeze(registry[entryType]),
  );
  return Object.freeze(registry);
}

/** Exhaustive, runtime-immutable profile registry for all 32 EntryTypes. */
export const ENTRY_TYPE_PROFILES = freezeProfileRegistry({
  SALE: [
    "SALE_INVENTORY",
    "SALE_SERVICE",
    "SALE_SERVICE_FLEX",
    "SALE_FIXED_ASSET",
    "SALE_DIGITAL",
    "SALE_CONSIGNMENT",
    "SALE_MIXED",
  ],
  PURCHASE: [
    "PURCHASE_INVENTORY",
    "PURCHASE_INVENTORY_CASH_CLEARING",
    "PURCHASE_FIXED_ASSET",
    "PURCHASE_DIGITAL",
    "PURCHASE_CONSIGNMENT",
    "PURCHASE_CONSIGNMENT_SHORTAGE",
  ],
  PAYMENT_IN: [
    "PAYMENT_IN_CUSTOMER",
    "PAYMENT_IN_SUPPLIER_REFUND",
    "PAYMENT_IN_PURCHASE_CASH_CLEARING",
    "PAYMENT_IN_OTHER",
    "PAYMENT_IN_CATEGORY",
    "PAYMENT_IN_CATEGORY_REVERSAL",
    "PAYMENT_IN_TREASURY",
    "PAYMENT_IN_COURIER",
    "PAYMENT_IN_PAYROLL_NET_RETURN",
    "PAYMENT_IN_PAYROLL_TAX_RETURN",
    "PAYMENT_IN_PAYROLL_SS_RETURN",
    "PAYMENT_IN_EMPLOYEE_ADVANCE_REPAYMENT",
  ],
  PAYMENT_OUT: [
    "PAYMENT_OUT_SUPPLIER",
    "PAYMENT_OUT_PURCHASE_CASH_CLEARING",
    "PAYMENT_OUT_CUSTOMER_REFUND",
    "PAYMENT_OUT_DIGITAL_REFUND",
    "PAYMENT_OUT_EXPENSE",
    "PAYMENT_OUT_SALARY",
    "PAYMENT_OUT_FIXED_ASSET",
    "PAYMENT_OUT_EMPLOYEE_ADVANCE",
    "PAYMENT_OUT_EMPLOYEE_ADVANCE_REPAYMENT_RETURN",
    "PAYMENT_OUT_COURIER",
    "PAYMENT_OUT_PAYROLL_NET",
    "PAYMENT_OUT_PAYROLL_TAX_REMIT",
    "PAYMENT_OUT_PAYROLL_SS_REMIT",
    "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
    "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT",
    "PAYMENT_OUT_OTHER",
    "PAYMENT_OUT_CATEGORY",
    "PAYMENT_OUT_CATEGORY_REVERSAL",
  ],
  RETURN: [
    "RETURN_SALE_INVENTORY",
    "RETURN_SALE_SERVICE",
    "RETURN_SALE_FLEX",
    "RETURN_SALE_FLEX_WORKORDER",
    "RETURN_SALE_FIXED_ASSET",
    "RETURN_SALE_DIGITAL",
    "RETURN_SALE_CONSIGNMENT",
    "RETURN_SALE_MIXED",
    "RETURN_PURCHASE_INVENTORY",
    "RETURN_PURCHASE_INVENTORY_CASH_CLEARING",
    "RETURN_PURCHASE_FIXED_ASSET",
    "RETURN_PURCHASE_DIGITAL",
    "RETURN_PURCHASE_CONSIGNMENT",
  ],
  ADJUST: [
    "ADJUST_INVENTORY_GAIN",
    "ADJUST_INVENTORY_LOSS",
    "ADJUST_WIP_CONSUME",
    "ADJUST_WIP_CANCEL",
    "ADJUST_WIP_WASTE",
    "ADJUST_CASH",
    "ADJUST_AR",
    "ADJUST_AP",
    "ADJUST_ROUNDING",
    "ADJUST_DEPRECIATION",
    "ADJUST_TAX",
    "ADJUST_OWNER_CURRENT",
    "ADJUST_LOAN",
    "ADJUST_ASSET_DISPOSAL",
    "ADJUST_YEAR_CLOSE",
    "ADJUST_YEAR_CLOSE_ZERO",
    "ADJUST_PAYROLL_ACCRUAL",
    "ADJUST_PAYROLL_ACCRUAL_REVERSAL",
    "ADJUST_EOS_SETTLEMENT",
    "ADJUST_EOS_SETTLEMENT_REVERSAL",
    "ADJUST_EOS_PROVISION_TRANSFER_OUT",
    "ADJUST_EOS_PROVISION_TRANSFER_REVERSAL",
    "ADJUST_TERMINATION_ADVANCE_TRANSFER_OUT",
    "ADJUST_TERMINATION_ADVANCE_TRANSFER_REVERSAL",
    "ADJUST_EXPENSE_ACCRUAL",
    "ADJUST_EXPENSE_ACCRUAL_REVERSAL",
    "ADJUST_FIXED_ASSET_ACCRUAL",
    "ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL",
    "ADJUST_EXCHANGE_CONTROL_RECLASS",
    "CASH_DAILY_SHORTAGE",
    "CASH_DAILY_SURPLUS",
  ],
  OPENING: [
    "OPENING_CUSTOMER",
    "OPENING_SUPPLIER",
    "OPENING_CASH",
    "OPENING_TREASURY",
    "OPENING_INVENTORY",
    "OPENING_FIXED_ASSET",
    "OPENING_EMPLOYEE_ADVANCE",
    "OPENING_EXCHANGE_IQD",
    "OPENING_EXCHANGE_USD",
    "OPENING_EXCHANGE_COMBINED",
    "OPENING_DIGITAL_WALLET",
    "OPENING_OWNER_CURRENT",
    "OPENING_LOAN",
  ],
  INTERNAL_USE: ["INTERNAL_USE_INVENTORY"],
  WASTAGE: ["WASTAGE_INVENTORY"],
  CASH_HANDOVER: ["CASH_HANDOVER_TO_TREASURY"],
  CASH_TRANSFER_OUT: [
    "CASH_HANDOVER_TO_TRANSIT",
    "CASH_DROP_TO_TRANSIT",
    "CASH_TRANSFER_OUT_IN_TRANSIT",
    "INTERBRANCH_CLEARING_OUT",
  ],
  CASH_TRANSFER_IN: [
    "CASH_TRANSFER_IN_FROM_TRANSIT",
    "CASH_TRANSFER_IN_FROM_CLEARING",
    "CASH_CUSTODY_SHORTAGE",
    "CASH_CUSTODY_SURPLUS",
  ],
  SHIFT_FLOAT_OUT: ["SHIFT_FLOAT_FROM_TREASURY"],
  TREASURY_FUNDING: [
    "TREASURY_FUNDING_CAPITAL",
    "TREASURY_FUNDING_OWNER_CURRENT",
    "TREASURY_FUNDING_LOAN",
  ],
  DELIVERY_DISPATCH: ["DELIVERY_DISPATCH_COD"],
  DELIVERY_REMIT: ["DELIVERY_REMIT_COD"],
  DELIVERY_FEE: [
    "DELIVERY_FEE_EXPENSE",
    "DELIVERY_FEE_ACCRUAL",
    "DELIVERY_FEE_SETTLEMENT",
    "DELIVERY_COMMISSION_SETTLEMENT",
  ],
  DELIVERY_FEE_HELD: ["DELIVERY_FEE_HELD_RECEIPT", "DELIVERY_FEE_HELD_PAYOUT"],
  DELIVERY_WRITEOFF: ["DELIVERY_WRITEOFF_FLOAT"],
  EXCHANGE_DEPOSIT: ["EXCHANGE_DEPOSIT_IQD", "EXCHANGE_DEPOSIT_USD_CASH"],
  EXCHANGE_WITHDRAW: ["EXCHANGE_WITHDRAW_IQD", "EXCHANGE_WITHDRAW_USD_CASH"],
  EXCHANGE_FX_BUY: ["EXCHANGE_FX_BUY"],
  EXCHANGE_SETTLE: ["EXCHANGE_SETTLE_SUPPLIER"],
  EXCHANGE_FEE: ["EXCHANGE_FEE_EXPENSE"],
  EXCHANGE_FX_DIFF: ["EXCHANGE_FX_GAIN", "EXCHANGE_FX_LOSS"],
  GIFT_OUT: [
    "GIFT_OUT_PROMO",
    "GIFT_OUT_MIXED_PROMO",
    "GIFT_OUT_CONSIGNMENT_MEMO",
  ],
  DIGITAL_WALLET_DEPOSIT: ["DIGITAL_WALLET_DEPOSIT_ASSET"],
  DIGITAL_WALLET_WITHDRAWAL: ["DIGITAL_WALLET_WITHDRAWAL_ASSET"],
  DIGITAL_WALLET_CONSUMPTION: ["DIGITAL_WALLET_CONSUMPTION_SALE"],
  DIGITAL_WALLET_REVERSAL: ["DIGITAL_WALLET_REVERSAL_SALE"],
  DIGITAL_WALLET_ADJUSTMENT: [
    "DIGITAL_WALLET_ADJUSTMENT_GAIN",
    "DIGITAL_WALLET_ADJUSTMENT_LOSS",
  ],
  DIGITAL_WRITEOFF: ["DIGITAL_WRITEOFF_EXPENSE"],
});

export interface ImmutableMembershipSet<T> extends Iterable<T> {
  readonly size: number;
  has(value: T): boolean;
}

function immutableSet<T>(values: readonly T[]): ImmutableMembershipSet<T> {
  const source = new Set(values);
  return Object.freeze({
    get size() {
      return source.size;
    },
    has(value: T) {
      return source.has(value);
    },
    [Symbol.iterator]() {
      return source[Symbol.iterator]();
    },
  });
}

export const MAPPED_ENTRY_TYPES: ImmutableMembershipSet<EntryType> =
  immutableSet(Object.keys(ENTRY_TYPE_PROFILES) as EntryType[]);

export interface PostingIntent {
  readonly profile: PostingProfile;
  readonly entryType: EntryType;
  readonly lines: readonly JournalLine[];
  /** Producer-supplied component facts required by multi-purpose profiles. */
  readonly sourceComponents?: PostingSourceComponents;
}

export type PostingSide = "DEBIT" | "CREDIT";

export interface PostingRoleSide {
  readonly role: AccountRole;
  readonly side: PostingSide;
}

export interface PostingRoleSideRequirement {
  /** At least one role/side in this group must be present. */
  readonly anyOf: readonly PostingRoleSide[];
}

export interface PostingRequiredPattern {
  /** Every group must match; one complete pattern is sufficient. */
  readonly allOf: readonly PostingRoleSideRequirement[];
}

export type PostingSourceAmountField =
  | "amount"
  | "revenue"
  | "cost"
  | "profit"
  | "taxAmount";

export type PostingRoleAmounts = Partial<Record<AccountRole, DecimalInput>>;

export interface PostingSourceComponents {
  readonly roleDebits?: PostingRoleAmounts;
  readonly roleCredits?: PostingRoleAmounts;
}

export interface PostingSourceAmounts extends PostingSourceComponents {
  readonly amount?: DecimalInput;
  readonly revenue?: DecimalInput;
  readonly cost?: DecimalInput;
  readonly profit?: DecimalInput;
  readonly taxAmount?: DecimalInput;
}

export interface PostingSourceAssertion {
  readonly field: PostingSourceAmountField;
  readonly measure: "DEBIT_MINUS_CREDIT" | "CREDIT_MINUS_DEBIT";
  readonly roles: readonly AccountRole[];
  /** ABS_LTE also requires the measured value to have the source's sign. */
  readonly comparison?: "EQUAL" | "ABS_EQUAL" | "ABS_LTE";
}

export interface PostingProfilePolicy {
  readonly entryType: EntryType;
  readonly memoOnly: boolean;
  readonly allowed: readonly PostingRoleSide[];
  readonly requiredOneOf: readonly PostingRequiredPattern[];
  readonly sourceAssertions: readonly PostingSourceAssertion[];
  /** Exact per-side source facts are mandatory for these component roles. */
  readonly requireRoleComponents: readonly AccountRole[];
}

const DEBIT: PostingSide = "DEBIT";
const CREDIT: PostingSide = "CREDIT";

function roleSides(
  roles: readonly AccountRole[],
  side: PostingSide,
): PostingRoleSide[] {
  return roles.map((role) => Object.freeze({ role, side }));
}

function requirement(
  roles: readonly AccountRole[],
  side: PostingSide,
): PostingRoleSideRequirement {
  return Object.freeze({ anyOf: Object.freeze(roleSides(roles, side)) });
}

function sourceAssertion(
  field: PostingSourceAmountField,
  measure: PostingSourceAssertion["measure"],
  roles: readonly AccountRole[],
  comparison: PostingSourceAssertion["comparison"] = "EQUAL",
): PostingSourceAssertion {
  return Object.freeze({
    field,
    measure,
    roles: Object.freeze([...roles]),
    comparison,
  });
}

function profilePolicy(
  entryType: EntryType,
  debitRoles: readonly AccountRole[],
  creditRoles: readonly AccountRole[],
  options: {
    reversible?: boolean;
    requiredDebitRoles?: readonly AccountRole[];
    requiredCreditRoles?: readonly AccountRole[];
    sourceAssertions?: readonly PostingSourceAssertion[];
    requireRoleComponents?: readonly AccountRole[];
  } = {},
): PostingProfilePolicy {
  const requiredDebit = options.requiredDebitRoles ?? debitRoles;
  const requiredCredit = options.requiredCreditRoles ?? creditRoles;
  const normal = Object.freeze({
    allOf: Object.freeze([
      requirement(requiredDebit, DEBIT),
      requirement(requiredCredit, CREDIT),
    ]),
  });
  const reverse = Object.freeze({
    allOf: Object.freeze([
      requirement(requiredDebit, CREDIT),
      requirement(requiredCredit, DEBIT),
    ]),
  });
  const reversible = options.reversible !== false;
  return Object.freeze({
    entryType,
    memoOnly: false,
    allowed: Object.freeze([
      ...roleSides(debitRoles, DEBIT),
      ...roleSides(creditRoles, CREDIT),
      ...(reversible ? roleSides(debitRoles, CREDIT) : []),
      ...(reversible ? roleSides(creditRoles, DEBIT) : []),
    ]),
    requiredOneOf: Object.freeze(reversible ? [normal, reverse] : [normal]),
    sourceAssertions: Object.freeze([...(options.sourceAssertions ?? [])]),
    requireRoleComponents: Object.freeze([
      ...(options.requireRoleComponents ?? []),
    ]),
  });
}

function memoPolicy(entryType: EntryType): PostingProfilePolicy {
  return Object.freeze({
    entryType,
    memoOnly: true,
    allowed: Object.freeze([]),
    requiredOneOf: Object.freeze([]),
    sourceAssertions: Object.freeze([]),
    requireRoleComponents: Object.freeze([]),
  });
}

const CASH_ASSETS = [
  "CASH",
  "CARD_BANK",
  "CHECKS_RECEIVABLE",
  "PAYMENT_WALLET",
  "TELECOM_BALANCE",
  "TREASURY_CASH",
] as const;
const VOUCHER_CATEGORY_IN_ROLES = [
  "OTHER_REVENUE",
  "CAPITAL",
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
  "OTHER_LIABILITY",
] as const;
const VOUCHER_CATEGORY_OUT_ROLES = [
  "OWNER_CURRENT",
  "LOAN_PAYABLE",
  "OTHER_LIABILITY",
  "SALARIES",
  "RENT",
  "UTILITIES",
  "OPERATING_EXPENSE",
  "DELIVERY_EXPENSE",
  "GIFTS_PROMO",
  "LOSSES",
  "OTHER_EXPENSE",
] as const;
const SALES_REVENUE = [
  "SALES_STATIONERY",
  "SALES_PRINT",
  "SALES_FLEX",
  "DELIVERY_REVENUE",
  "OTHER_REVENUE",
] as const;
const EXPENSE_ROLES = [
  "COGS",
  "SALARIES",
  "SOCIAL_SECURITY_EXPENSE",
  "EOS_EXPENSE",
  "RENT",
  "UTILITIES",
  "OPERATING_EXPENSE",
  "DELIVERY_EXPENSE",
  "GIFTS_PROMO",
  "DEPRECIATION_EXPENSE",
  "FX_LOSS",
  "ROUNDING_DIFF",
  "ASSET_DISPOSAL_LOSS",
  "PURCHASE_PRICE_VARIANCE",
  "LOSSES",
  "OTHER_EXPENSE",
] as const;
const PAYROLL_EXPENSE_ROLES = [
  "SALARIES",
  "SOCIAL_SECURITY_EXPENSE",
  "EOS_EXPENSE",
] as const;
const PAYROLL_LIABILITY_ROLES = [
  "ACCRUED_SALARY",
  "EMPLOYEE_ADVANCES",
  "PAYROLL_TAX_PAYABLE",
  "SOCIAL_SECURITY_PAYABLE",
  "EOS_PROVISION",
] as const;
const ACCRUABLE_EXPENSE_ROLES = [
  "RENT",
  "UTILITIES",
  "OPERATING_EXPENSE",
  "DELIVERY_EXPENSE",
  "OTHER_EXPENSE",
] as const;
const EXCHANGE_CONTROL_ROLES = [
  "EXCHANGE_WALLET_IQD",
  "EXCHANGE_WALLET_USD",
  "EXCHANGE_RECEIVABLE_IQD",
  "EXCHANGE_RECEIVABLE_USD",
  "EXCHANGE_PAYABLE_IQD",
  "EXCHANGE_PAYABLE_USD",
] as const;
const PNL_ROLES = [
  ...SALES_REVENUE,
  "EXCHANGE_COMMISSION",
  "FX_GAIN",
  "ASSET_DISPOSAL_GAIN",
  ...EXPENSE_ROLES,
] as const;

/**
 * Executable posting contract.  `satisfies Record<...>` makes a new profile a
 * compile error until its allowed/required roles and source assertions exist.
 */
export const PROFILE_POLICIES = Object.freeze({
  SALE_INVENTORY: profilePolicy(
    "SALE",
    ["AR", "OTHER_LIABILITY", "COGS"],
    ["AR", "SALES_STATIONERY", "DELIVERY_REVENUE", "TAX_PAYABLE", "INVENTORY"],
    {
      reversible: false,
      requiredDebitRoles: ["AR"],
      requiredCreditRoles: ["SALES_STATIONERY", "DELIVERY_REVENUE"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_STATIONERY",
          "DELIVERY_REVENUE",
        ]),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "AR",
        "OTHER_LIABILITY",
        "COGS",
        "SALES_STATIONERY",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "INVENTORY",
      ],
    },
  ),
  SALE_SERVICE: profilePolicy(
    "SALE",
    ["AR", "OTHER_LIABILITY", "COGS"],
    [
      "AR",
      "SALES_PRINT",
      "DELIVERY_REVENUE",
      "TAX_PAYABLE",
      "WORK_IN_PROGRESS",
      "INVENTORY",
    ],
    {
      reversible: false,
      requiredDebitRoles: ["AR"],
      requiredCreditRoles: ["SALES_PRINT", "DELIVERY_REVENUE"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_PRINT",
          "DELIVERY_REVENUE",
        ]),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "AR",
        "OTHER_LIABILITY",
        "COGS",
        "SALES_PRINT",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "WORK_IN_PROGRESS",
        "INVENTORY",
      ],
    },
  ),
  SALE_SERVICE_FLEX: profilePolicy(
    "SALE",
    ["AR", "OTHER_LIABILITY", "COGS"],
    [
      "AR",
      "SALES_FLEX",
      "DELIVERY_REVENUE",
      "TAX_PAYABLE",
      "WORK_IN_PROGRESS",
      "INVENTORY",
    ],
    {
      reversible: false,
      requiredDebitRoles: ["AR"],
      requiredCreditRoles: ["SALES_FLEX", "DELIVERY_REVENUE"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_FLEX",
          "DELIVERY_REVENUE",
        ]),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "AR",
        "OTHER_LIABILITY",
        "COGS",
        "SALES_FLEX",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "WORK_IN_PROGRESS",
        "INVENTORY",
      ],
    },
  ),
  SALE_FIXED_ASSET: profilePolicy("SALE", ["AR"], ["ASSET_DISPOSAL_GAIN"], {
    reversible: false,
    sourceAssertions: [sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["AR"])],
    requireRoleComponents: ["AR", "ASSET_DISPOSAL_GAIN"],
  }),
  SALE_DIGITAL: profilePolicy(
    "SALE",
    ["AR", "OTHER_LIABILITY", "COGS"],
    ["AR", "OTHER_REVENUE", "DELIVERY_REVENUE", "TAX_PAYABLE", "INVENTORY"],
    {
      reversible: false,
      requiredDebitRoles: ["AR"],
      requiredCreditRoles: ["OTHER_REVENUE", "DELIVERY_REVENUE"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "OTHER_REVENUE",
          "DELIVERY_REVENUE",
        ]),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "AR",
        "OTHER_LIABILITY",
        "COGS",
        "OTHER_REVENUE",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "INVENTORY",
      ],
    },
  ),
  SALE_CONSIGNMENT: profilePolicy(
    "SALE",
    ["AR", "OTHER_LIABILITY"],
    ["AR", "SALES_STATIONERY", "DELIVERY_REVENUE", "TAX_PAYABLE"],
    {
      reversible: false,
      requiredDebitRoles: ["AR"],
      requiredCreditRoles: ["SALES_STATIONERY", "DELIVERY_REVENUE"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_STATIONERY",
          "DELIVERY_REVENUE",
        ]),
      ],
      requireRoleComponents: [
        "AR",
        "OTHER_LIABILITY",
        "SALES_STATIONERY",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
      ],
    },
  ),
  SALE_MIXED: profilePolicy(
    "SALE",
    ["AR", "OTHER_LIABILITY", "COGS"],
    ["AR", ...SALES_REVENUE, "TAX_PAYABLE", "INVENTORY"],
    {
      reversible: false,
      requiredDebitRoles: ["AR"],
      requiredCreditRoles: SALES_REVENUE,
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", SALES_REVENUE),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "AR",
        "OTHER_LIABILITY",
        "COGS",
        ...SALES_REVENUE,
        "TAX_PAYABLE",
        "INVENTORY",
      ],
    },
  ),

  PURCHASE_INVENTORY: profilePolicy(
    "PURCHASE",
    ["INVENTORY", "TAX_PAYABLE"],
    ["AP"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["AP"]),
      ],
      requireRoleComponents: ["INVENTORY", "TAX_PAYABLE", "AP"],
    },
  ),
  PURCHASE_INVENTORY_CASH_CLEARING: profilePolicy(
    "PURCHASE",
    ["INVENTORY", "TAX_PAYABLE"],
    ["OTHER_LIABILITY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", [
          "OTHER_LIABILITY",
        ]),
      ],
      requireRoleComponents: [
        "INVENTORY",
        "TAX_PAYABLE",
        "OTHER_LIABILITY",
      ],
    },
  ),
  PURCHASE_FIXED_ASSET: profilePolicy("PURCHASE", ["FIXED_ASSETS"], ["AP"], {
    sourceAssertions: [sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["AP"])],
  }),
  PURCHASE_DIGITAL: profilePolicy("PURCHASE", ["INVENTORY"], ["AP"], {
    sourceAssertions: [sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["AP"])],
  }),
  PURCHASE_CONSIGNMENT: profilePolicy(
    "PURCHASE",
    ["COGS", "GIFTS_PROMO", "INVENTORY"],
    ["CONSIGNMENT_PAYABLE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", [
          "CONSIGNMENT_PAYABLE",
        ]),
      ],
      requireRoleComponents: [
        "COGS",
        "GIFTS_PROMO",
        "INVENTORY",
        "CONSIGNMENT_PAYABLE",
      ],
    },
  ),
  PURCHASE_CONSIGNMENT_SHORTAGE: profilePolicy(
    "PURCHASE",
    ["LOSSES"],
    ["CONSIGNMENT_PAYABLE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", [
          "CONSIGNMENT_PAYABLE",
        ]),
      ],
      requireRoleComponents: ["LOSSES", "CONSIGNMENT_PAYABLE"],
    },
  ),

  PAYMENT_IN_CUSTOMER: profilePolicy("PAYMENT_IN", CASH_ASSETS, ["AR"], {
    sourceAssertions: [
      sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
    ],
    requireRoleComponents: [...CASH_ASSETS, "AR"],
  }),
  PAYMENT_IN_SUPPLIER_REFUND: profilePolicy("PAYMENT_IN", CASH_ASSETS, ["AP"], {
    sourceAssertions: [
      sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
    ],
    requireRoleComponents: [...CASH_ASSETS, "AP"],
  }),
  PAYMENT_IN_PURCHASE_CASH_CLEARING: profilePolicy(
    "PAYMENT_IN",
    CASH_ASSETS,
    ["OTHER_LIABILITY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "OTHER_LIABILITY"],
    },
  ),
  PAYMENT_IN_OTHER: profilePolicy(
    "PAYMENT_IN",
    [...CASH_ASSETS, "ACCUMULATED_DEPRECIATION"],
    [
      "EMPLOYEE_ADVANCES",
      "FIXED_ASSETS",
      "OTHER_LIABILITY",
      "OTHER_REVENUE",
      "ASSET_DISPOSAL_GAIN",
      ...EXPENSE_ROLES,
    ],
    {
      sourceAssertions: [
        sourceAssertion(
          "amount",
          "DEBIT_MINUS_CREDIT",
          CASH_ASSETS,
          "ABS_EQUAL",
        ),
      ],
      requireRoleComponents: [
        ...CASH_ASSETS,
        "ACCUMULATED_DEPRECIATION",
        "EMPLOYEE_ADVANCES",
        "FIXED_ASSETS",
        "OTHER_LIABILITY",
        "OTHER_REVENUE",
        "ASSET_DISPOSAL_GAIN",
        ...EXPENSE_ROLES,
      ],
    },
  ),
  PAYMENT_IN_CATEGORY: profilePolicy(
    "PAYMENT_IN",
    CASH_ASSETS,
    VOUCHER_CATEGORY_IN_ROLES,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [
        ...CASH_ASSETS,
        ...VOUCHER_CATEGORY_IN_ROLES,
      ],
    },
  ),
  /** ردّ فعلي لصرف مصنّف سابق: Dr أصل الدفع / Cr نفس مصروف/سحب الصرف. */
  PAYMENT_IN_CATEGORY_REVERSAL: profilePolicy(
    "PAYMENT_IN",
    CASH_ASSETS,
    VOUCHER_CATEGORY_OUT_ROLES,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [
        ...CASH_ASSETS,
        ...VOUCHER_CATEGORY_OUT_ROLES,
      ],
    },
  ),
  PAYMENT_IN_TREASURY: profilePolicy(
    "PAYMENT_IN",
    ["TREASURY_CASH"],
    ["OWNER_CURRENT", "CAPITAL", "LOAN_PAYABLE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
      requireRoleComponents: [
        "TREASURY_CASH",
        "OWNER_CURRENT",
        "CAPITAL",
        "LOAN_PAYABLE",
      ],
    },
  ),
  PAYMENT_IN_COURIER: profilePolicy("PAYMENT_IN", ["DELIVERY_FLOAT"], ["AR"], {
    sourceAssertions: [
      sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["DELIVERY_FLOAT"]),
    ],
  }),
  PAYMENT_IN_PAYROLL_NET_RETURN: profilePolicy(
    "PAYMENT_IN",
    CASH_ASSETS,
    ["ACCRUED_SALARY"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "ACCRUED_SALARY"],
    },
  ),
  PAYMENT_IN_PAYROLL_TAX_RETURN: profilePolicy(
    "PAYMENT_IN",
    CASH_ASSETS,
    ["PAYROLL_TAX_PAYABLE"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "PAYROLL_TAX_PAYABLE"],
    },
  ),
  PAYMENT_IN_PAYROLL_SS_RETURN: profilePolicy(
    "PAYMENT_IN",
    CASH_ASSETS,
    ["SOCIAL_SECURITY_PAYABLE"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "SOCIAL_SECURITY_PAYABLE"],
    },
  ),
  PAYMENT_IN_EMPLOYEE_ADVANCE_REPAYMENT: profilePolicy(
    "PAYMENT_IN",
    CASH_ASSETS,
    ["EMPLOYEE_ADVANCES"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "EMPLOYEE_ADVANCES"],
    },
  ),
  PAYMENT_OUT_SUPPLIER: profilePolicy("PAYMENT_OUT", ["AP"], CASH_ASSETS, {
    sourceAssertions: [
      sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
    ],
    requireRoleComponents: ["AP", ...CASH_ASSETS],
  }),
  PAYMENT_OUT_PURCHASE_CASH_CLEARING: profilePolicy(
    "PAYMENT_OUT",
    ["OTHER_LIABILITY"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["OTHER_LIABILITY", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_CUSTOMER_REFUND: profilePolicy(
    "PAYMENT_OUT",
    ["AR"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["AR", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_DIGITAL_REFUND: profilePolicy(
    "PAYMENT_OUT",
    ["AR"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["AR", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_EXPENSE: profilePolicy(
    "PAYMENT_OUT",
    EXPENSE_ROLES,
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...EXPENSE_ROLES, ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_SALARY: profilePolicy(
    "PAYMENT_OUT",
    ["ACCRUED_SALARY"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["ACCRUED_SALARY", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_PAYROLL_NET: profilePolicy(
    "PAYMENT_OUT",
    ["ACCRUED_SALARY"],
    CASH_ASSETS,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["ACCRUED_SALARY", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_PAYROLL_TAX_REMIT: profilePolicy(
    "PAYMENT_OUT",
    ["PAYROLL_TAX_PAYABLE"],
    CASH_ASSETS,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["PAYROLL_TAX_PAYABLE", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_PAYROLL_SS_REMIT: profilePolicy(
    "PAYMENT_OUT",
    ["SOCIAL_SECURITY_PAYABLE"],
    CASH_ASSETS,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["SOCIAL_SECURITY_PAYABLE", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT: profilePolicy(
    "PAYMENT_OUT",
    ["ACCRUED_EXPENSES"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["ACCRUED_EXPENSES", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT: profilePolicy(
    "PAYMENT_OUT",
    ["ACCRUED_EXPENSES"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["ACCRUED_EXPENSES", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_FIXED_ASSET: profilePolicy(
    "PAYMENT_OUT",
    ["FIXED_ASSETS"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["FIXED_ASSETS", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_EMPLOYEE_ADVANCE: profilePolicy(
    "PAYMENT_OUT",
    ["EMPLOYEE_ADVANCES"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["EMPLOYEE_ADVANCES", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_EMPLOYEE_ADVANCE_REPAYMENT_RETURN: profilePolicy(
    "PAYMENT_OUT",
    ["EMPLOYEE_ADVANCES"],
    CASH_ASSETS,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["EMPLOYEE_ADVANCES", ...CASH_ASSETS],
    },
  ),
  PAYMENT_OUT_COURIER: profilePolicy(
    "PAYMENT_OUT",
    ["COURIER_PAYABLE", "DELIVERY_EXPENSE"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: [
        "COURIER_PAYABLE",
        "DELIVERY_EXPENSE",
        ...CASH_ASSETS,
      ],
    },
  ),
  PAYMENT_OUT_OTHER: profilePolicy(
    "PAYMENT_OUT",
    ["OTHER_LIABILITY", "OWNER_CURRENT", "LOAN_PAYABLE", ...EXPENSE_ROLES],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: [
        "OTHER_LIABILITY",
        "OWNER_CURRENT",
        "LOAN_PAYABLE",
        ...EXPENSE_ROLES,
        ...CASH_ASSETS,
      ],
    },
  ),
  PAYMENT_OUT_CATEGORY: profilePolicy(
    "PAYMENT_OUT",
    VOUCHER_CATEGORY_OUT_ROLES,
    CASH_ASSETS,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: [
        ...VOUCHER_CATEGORY_OUT_ROLES,
        ...CASH_ASSETS,
      ],
    },
  ),
  /** ردّ فعلي لقبض مصنّف سابق: Dr نفس إيراد/التزام القبض / Cr أصل الدفع. */
  PAYMENT_OUT_CATEGORY_REVERSAL: profilePolicy(
    "PAYMENT_OUT",
    VOUCHER_CATEGORY_IN_ROLES,
    CASH_ASSETS,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: [
        ...VOUCHER_CATEGORY_IN_ROLES,
        ...CASH_ASSETS,
      ],
    },
  ),

  RETURN_SALE_INVENTORY: profilePolicy(
    "RETURN",
    ["SALES_STATIONERY", "DELIVERY_REVENUE", "TAX_PAYABLE", "INVENTORY"],
    ["AR", "COGS"],
    {
      reversible: false,
      requiredDebitRoles: ["SALES_STATIONERY", "DELIVERY_REVENUE"],
      requiredCreditRoles: ["AR"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_STATIONERY",
          "DELIVERY_REVENUE",
        ]),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "SALES_STATIONERY",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "INVENTORY",
        "AR",
        "COGS",
      ],
    },
  ),
  RETURN_SALE_SERVICE: profilePolicy(
    "RETURN",
    ["SALES_PRINT", "DELIVERY_REVENUE", "TAX_PAYABLE"],
    ["AR"],
    {
      reversible: false,
      requiredDebitRoles: ["SALES_PRINT", "DELIVERY_REVENUE"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_PRINT",
          "DELIVERY_REVENUE",
        ]),
      ],
      requireRoleComponents: [
        "SALES_PRINT",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "AR",
      ],
    },
  ),
  /**
   * **عكسُ تسليم أمر شغل** (٢٠/٨) — مرآةُ `SALE_SERVICE_FLEX` دوراً بدور.
   *
   * `RETURN_SALE_FLEX` القائم لا يكفي: مدينُه `SALES_FLEX/DELIVERY_REVENUE/TAX_PAYABLE`
   * ودائنُه `AR` وحده، و`requireRoleComponents` تفرض ذلك ⇒ لا مكانَ لعكس COGS/WIP ولا
   * لإعادة فتح أمانة العربون (`OTHER_LIABILITY`). فالعكسُ به يترك التكلفةَ معترَفاً بها
   * لبيعٍ أُلغي، والعربونَ مُقفَلاً وقد صار دَيناً على المكتبة.
   *
   * الثابت المحروس: `Σ(SALE_SERVICE_FLEX) + Σ(RETURN_SALE_FLEX_WORKORDER) = 0` لكل دور.
   */
  RETURN_SALE_FLEX_WORKORDER: profilePolicy(
    "RETURN",
    ["SALES_FLEX", "DELIVERY_REVENUE", "TAX_PAYABLE", "WORK_IN_PROGRESS", "AR"],
    ["AR", "OTHER_LIABILITY", "COGS"],
    {
      reversible: false,
      requiredDebitRoles: ["SALES_FLEX"],
      requiredCreditRoles: ["AR"],
      sourceAssertions: [
        sourceAssertion("revenue", "DEBIT_MINUS_CREDIT", ["SALES_FLEX", "DELIVERY_REVENUE"]),
        sourceAssertion("cost", "CREDIT_MINUS_DEBIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "AR",
        "OTHER_LIABILITY",
        "COGS",
        "SALES_FLEX",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "WORK_IN_PROGRESS",
      ],
    },
  ),
  RETURN_SALE_FLEX: profilePolicy(
    "RETURN",
    ["SALES_FLEX", "DELIVERY_REVENUE", "TAX_PAYABLE"],
    ["AR"],
    {
      reversible: false,
      requiredDebitRoles: ["SALES_FLEX", "DELIVERY_REVENUE"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_FLEX",
          "DELIVERY_REVENUE",
        ]),
      ],
      requireRoleComponents: [
        "SALES_FLEX",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "AR",
      ],
    },
  ),
  RETURN_SALE_FIXED_ASSET: profilePolicy(
    "RETURN",
    ["ASSET_DISPOSAL_GAIN"],
    ["AR"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["AR"]),
      ],
      requireRoleComponents: ["ASSET_DISPOSAL_GAIN", "AR"],
    },
  ),
  RETURN_SALE_DIGITAL: profilePolicy(
    "RETURN",
    ["OTHER_REVENUE", "DELIVERY_REVENUE", "TAX_PAYABLE", "INVENTORY"],
    ["AR", "COGS"],
    {
      reversible: false,
      requiredDebitRoles: ["OTHER_REVENUE", "DELIVERY_REVENUE"],
      requiredCreditRoles: ["AR"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "OTHER_REVENUE",
          "DELIVERY_REVENUE",
        ]),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        "OTHER_REVENUE",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "INVENTORY",
        "AR",
        "COGS",
      ],
    },
  ),
  RETURN_SALE_CONSIGNMENT: profilePolicy(
    "RETURN",
    ["SALES_STATIONERY", "DELIVERY_REVENUE", "TAX_PAYABLE"],
    ["AR"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", [
          "SALES_STATIONERY",
          "DELIVERY_REVENUE",
        ]),
      ],
      requireRoleComponents: [
        "SALES_STATIONERY",
        "DELIVERY_REVENUE",
        "TAX_PAYABLE",
        "AR",
      ],
    },
  ),
  RETURN_SALE_MIXED: profilePolicy(
    "RETURN",
    [...SALES_REVENUE, "TAX_PAYABLE", "INVENTORY"],
    ["AR", "COGS"],
    {
      reversible: false,
      requiredDebitRoles: SALES_REVENUE,
      requiredCreditRoles: ["AR"],
      sourceAssertions: [
        sourceAssertion("revenue", "CREDIT_MINUS_DEBIT", SALES_REVENUE),
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["COGS"]),
      ],
      requireRoleComponents: [
        ...SALES_REVENUE,
        "TAX_PAYABLE",
        "INVENTORY",
        "AR",
        "COGS",
      ],
    },
  ),
  RETURN_PURCHASE_INVENTORY: profilePolicy(
    "RETURN",
    ["AP", "PURCHASE_PRICE_VARIANCE"],
    ["INVENTORY", "TAX_PAYABLE", "PURCHASE_PRICE_VARIANCE"],
    {
      requiredDebitRoles: ["AP"],
      requiredCreditRoles: ["INVENTORY", "TAX_PAYABLE"],
      requireRoleComponents: [
        "AP",
        "INVENTORY",
        "TAX_PAYABLE",
        "PURCHASE_PRICE_VARIANCE",
      ],
    },
  ),
  RETURN_PURCHASE_INVENTORY_CASH_CLEARING: profilePolicy(
    "RETURN",
    ["OTHER_LIABILITY", "PURCHASE_PRICE_VARIANCE"],
    ["INVENTORY", "TAX_PAYABLE", "PURCHASE_PRICE_VARIANCE"],
    {
      requiredDebitRoles: ["OTHER_LIABILITY"],
      requiredCreditRoles: ["INVENTORY", "TAX_PAYABLE"],
      requireRoleComponents: [
        "OTHER_LIABILITY",
        "INVENTORY",
        "TAX_PAYABLE",
        "PURCHASE_PRICE_VARIANCE",
      ],
    },
  ),
  RETURN_PURCHASE_FIXED_ASSET: profilePolicy(
    "RETURN",
    ["AP"],
    ["FIXED_ASSETS"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["AP"]),
      ],
    },
  ),
  RETURN_PURCHASE_DIGITAL: profilePolicy("RETURN", ["AP"], ["INVENTORY"], {
    sourceAssertions: [sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["AP"])],
  }),
  RETURN_PURCHASE_CONSIGNMENT: profilePolicy(
    "RETURN",
    ["CONSIGNMENT_PAYABLE"],
    ["COGS", "GIFTS_PROMO", "INVENTORY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", [
          "CONSIGNMENT_PAYABLE",
        ]),
      ],
      requireRoleComponents: [
        "CONSIGNMENT_PAYABLE",
        "COGS",
        "GIFTS_PROMO",
        "INVENTORY",
      ],
    },
  ),

  ADJUST_INVENTORY_GAIN: profilePolicy(
    "ADJUST",
    ["INVENTORY"],
    ["OTHER_REVENUE"],
    {
      requireRoleComponents: ["INVENTORY", "OTHER_REVENUE"],
    },
  ),
  ADJUST_INVENTORY_LOSS: profilePolicy("ADJUST", ["LOSSES"], ["INVENTORY"], {
    requireRoleComponents: ["LOSSES", "INVENTORY"],
  }),
  ADJUST_WIP_CONSUME: profilePolicy(
    "ADJUST",
    ["WORK_IN_PROGRESS"],
    ["INVENTORY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["WORK_IN_PROGRESS"]),
      ],
      requireRoleComponents: ["WORK_IN_PROGRESS", "INVENTORY"],
    },
  ),
  ADJUST_WIP_CANCEL: profilePolicy(
    "ADJUST",
    ["INVENTORY"],
    ["WORK_IN_PROGRESS"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["INVENTORY"]),
      ],
      requireRoleComponents: ["INVENTORY", "WORK_IN_PROGRESS"],
    },
  ),
  /**
   * **هدرُ إلغاء أمر الشغل** (ش٤، ١٩/٨) — القيمةُ تنتقل من WIP إلى **خسارة** لا إلى مخزون.
   *
   * ولا يمكن إعادةُ استعمال `WASTAGE_INVENTORY`: دائنُه مثبَّتٌ على `INVENTORY`
   * و`validatePostingIntentPolicy` تفرضه — والمادّة المُهدَرة **خرجت من المخزون فعلاً** عند
   * بدء التنفيذ، فرصيدُها في WIP لا في INVENTORY. حسابُها هناك خطأٌ مزدوج.
   *
   * ⛔ **ولا حركةَ مخزونٍ لهذا القيد إطلاقاً**: `createStockExpenseTx` تستدعي `applyMovement`
   * بـOUT، والمادّة مخصومةٌ سلفاً ⇒ **خصمٌ مزدوج** يُنتج رصيداً سالباً كاذباً أو رفضَ
   * CONFLICT عند الإلغاء. الأثر قيدٌ فقط.
   *
   * والثابت المحروس: `ADJUST_WIP_CONSUME` (دخولٌ) − `ADJUST_WIP_CANCEL` (رجوع) −
   * `ADJUST_WIP_WASTE` (هدر) = **صفر** لكل أمرٍ عند إغلاقه.
   */
  ADJUST_WIP_WASTE: profilePolicy(
    "ADJUST",
    ["LOSSES"],
    ["WORK_IN_PROGRESS"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["LOSSES"]),
      ],
      requireRoleComponents: ["LOSSES", "WORK_IN_PROGRESS"],
    },
  ),
  ADJUST_CASH: profilePolicy("ADJUST", CASH_ASSETS, ["ROUNDING_DIFF"], {
    sourceAssertions: [
      sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
    ],
    requireRoleComponents: [...CASH_ASSETS, "ROUNDING_DIFF"],
  }),
  CASH_DAILY_SHORTAGE: profilePolicy(
    "ADJUST",
    ["LOSSES"],
    ["TREASURY_CASH"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["LOSSES"]),
      ],
      requireRoleComponents: ["LOSSES", "TREASURY_CASH"],
    },
  ),
  CASH_DAILY_SURPLUS: profilePolicy(
    "ADJUST",
    ["TREASURY_CASH"],
    ["OTHER_LIABILITY"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
      requireRoleComponents: ["TREASURY_CASH", "OTHER_LIABILITY"],
    },
  ),
  ADJUST_AR: profilePolicy("ADJUST", ["AR"], ["OPENING_EQUITY"], {
    sourceAssertions: [sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["AR"])],
  }),
  ADJUST_AP: profilePolicy("ADJUST", ["OPENING_EQUITY"], ["AP"], {
    sourceAssertions: [sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["AP"])],
  }),
  ADJUST_ROUNDING: profilePolicy("ADJUST", ["AR"], ["ROUNDING_DIFF"], {
    sourceAssertions: [sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["AR"])],
  }),
  ADJUST_DEPRECIATION: profilePolicy(
    "ADJUST",
    ["DEPRECIATION_EXPENSE"],
    ["ACCUMULATED_DEPRECIATION"],
    {
      sourceAssertions: [
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["DEPRECIATION_EXPENSE"]),
      ],
    },
  ),
  ADJUST_TAX: profilePolicy("ADJUST", ["OPENING_EQUITY"], ["TAX_PAYABLE"], {
    sourceAssertions: [
      sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["TAX_PAYABLE"]),
    ],
  }),
  ADJUST_OWNER_CURRENT: profilePolicy(
    "ADJUST",
    CASH_ASSETS,
    ["OWNER_CURRENT"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "OWNER_CURRENT"],
    },
  ),
  ADJUST_LOAN: profilePolicy("ADJUST", CASH_ASSETS, ["LOAN_PAYABLE"], {
    sourceAssertions: [
      sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
    ],
    requireRoleComponents: [...CASH_ASSETS, "LOAN_PAYABLE"],
  }),
  ADJUST_ASSET_DISPOSAL: profilePolicy(
    "ADJUST",
    ["ACCUMULATED_DEPRECIATION", "TREASURY_CASH", "ASSET_DISPOSAL_LOSS"],
    ["FIXED_ASSETS", "ASSET_DISPOSAL_GAIN"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", [
          "ASSET_DISPOSAL_GAIN",
          "ASSET_DISPOSAL_LOSS",
        ]),
      ],
      requireRoleComponents: [
        "ACCUMULATED_DEPRECIATION",
        "TREASURY_CASH",
        "ASSET_DISPOSAL_LOSS",
        "FIXED_ASSETS",
        "ASSET_DISPOSAL_GAIN",
      ],
    },
  ),
  ADJUST_PAYROLL_ACCRUAL: profilePolicy(
    "ADJUST",
    PAYROLL_EXPENSE_ROLES,
    PAYROLL_LIABILITY_ROLES,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion(
          "amount",
          "DEBIT_MINUS_CREDIT",
          PAYROLL_EXPENSE_ROLES,
        ),
      ],
      requireRoleComponents: [
        ...PAYROLL_EXPENSE_ROLES,
        ...PAYROLL_LIABILITY_ROLES,
      ],
    },
  ),
  ADJUST_PAYROLL_ACCRUAL_REVERSAL: profilePolicy(
    "ADJUST",
    PAYROLL_LIABILITY_ROLES,
    PAYROLL_EXPENSE_ROLES,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion(
          "amount",
          "DEBIT_MINUS_CREDIT",
          PAYROLL_EXPENSE_ROLES,
        ),
      ],
      requireRoleComponents: [
        ...PAYROLL_EXPENSE_ROLES,
        ...PAYROLL_LIABILITY_ROLES,
      ],
    },
  ),
  ADJUST_EOS_SETTLEMENT: profilePolicy(
    "ADJUST",
    [
      "SALARIES",
      "SOCIAL_SECURITY_EXPENSE",
      "EOS_PROVISION",
      "EOS_EXPENSE",
      "INTERBRANCH_CLEARING",
    ],
    [
      "ACCRUED_SALARY",
      "EMPLOYEE_ADVANCES",
      "PAYROLL_TAX_PAYABLE",
      "SOCIAL_SECURITY_PAYABLE",
      "EOS_EXPENSE",
      "INTERBRANCH_CLEARING",
    ],
    {
      reversible: false,
      requireRoleComponents: [
        "SALARIES",
        "SOCIAL_SECURITY_EXPENSE",
        "EOS_PROVISION",
        "EOS_EXPENSE",
        "ACCRUED_SALARY",
        "EMPLOYEE_ADVANCES",
        "PAYROLL_TAX_PAYABLE",
        "SOCIAL_SECURITY_PAYABLE",
        "INTERBRANCH_CLEARING",
      ],
    },
  ),
  ADJUST_EOS_SETTLEMENT_REVERSAL: profilePolicy(
    "ADJUST",
    [
      "ACCRUED_SALARY",
      "EMPLOYEE_ADVANCES",
      "PAYROLL_TAX_PAYABLE",
      "SOCIAL_SECURITY_PAYABLE",
      "EOS_EXPENSE",
      "INTERBRANCH_CLEARING",
    ],
    [
      "SALARIES",
      "SOCIAL_SECURITY_EXPENSE",
      "EOS_PROVISION",
      "EOS_EXPENSE",
      "INTERBRANCH_CLEARING",
    ],
    {
      reversible: false,
      requireRoleComponents: [
        "SALARIES",
        "SOCIAL_SECURITY_EXPENSE",
        "EOS_PROVISION",
        "EOS_EXPENSE",
        "ACCRUED_SALARY",
        "EMPLOYEE_ADVANCES",
        "PAYROLL_TAX_PAYABLE",
        "SOCIAL_SECURITY_PAYABLE",
        "INTERBRANCH_CLEARING",
      ],
    },
  ),
  // A provision accumulated in a previous branch cannot be debited in the
  // employee's current branch. Move only the liability through the explicit
  // inter-branch clearing role; the current branch then recognizes the single
  // employee payable. Company-wide clearing remains exactly zero.
  ADJUST_EOS_PROVISION_TRANSFER_OUT: profilePolicy(
    "ADJUST",
    ["EOS_PROVISION"],
    ["INTERBRANCH_CLEARING"],
    {
      reversible: false,
      requireRoleComponents: ["EOS_PROVISION", "INTERBRANCH_CLEARING"],
    },
  ),
  ADJUST_EOS_PROVISION_TRANSFER_REVERSAL: profilePolicy(
    "ADJUST",
    ["INTERBRANCH_CLEARING"],
    ["EOS_PROVISION"],
    {
      reversible: false,
      requireRoleComponents: ["EOS_PROVISION", "INTERBRANCH_CLEARING"],
    },
  ),
  ADJUST_TERMINATION_ADVANCE_TRANSFER_OUT: profilePolicy(
    "ADJUST",
    ["INTERBRANCH_CLEARING"],
    ["EMPLOYEE_ADVANCES"],
    {
      reversible: false,
      requireRoleComponents: ["INTERBRANCH_CLEARING", "EMPLOYEE_ADVANCES"],
    },
  ),
  ADJUST_TERMINATION_ADVANCE_TRANSFER_REVERSAL: profilePolicy(
    "ADJUST",
    ["EMPLOYEE_ADVANCES"],
    ["INTERBRANCH_CLEARING"],
    {
      reversible: false,
      requireRoleComponents: ["EMPLOYEE_ADVANCES", "INTERBRANCH_CLEARING"],
    },
  ),
  ADJUST_EXPENSE_ACCRUAL: profilePolicy(
    "ADJUST",
    ACCRUABLE_EXPENSE_ROLES,
    ["ACCRUED_EXPENSES"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion(
          "amount",
          "DEBIT_MINUS_CREDIT",
          ACCRUABLE_EXPENSE_ROLES,
        ),
      ],
      requireRoleComponents: [
        ...ACCRUABLE_EXPENSE_ROLES,
        "ACCRUED_EXPENSES",
      ],
    },
  ),
  ADJUST_EXPENSE_ACCRUAL_REVERSAL: profilePolicy(
    "ADJUST",
    ["ACCRUED_EXPENSES"],
    ACCRUABLE_EXPENSE_ROLES,
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion(
          "amount",
          "DEBIT_MINUS_CREDIT",
          ACCRUABLE_EXPENSE_ROLES,
        ),
      ],
      requireRoleComponents: [
        ...ACCRUABLE_EXPENSE_ROLES,
        "ACCRUED_EXPENSES",
      ],
    },
  ),
  ADJUST_FIXED_ASSET_ACCRUAL: profilePolicy(
    "ADJUST",
    ["FIXED_ASSETS"],
    ["ACCRUED_EXPENSES"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["FIXED_ASSETS"]),
      ],
      requireRoleComponents: ["FIXED_ASSETS", "ACCRUED_EXPENSES"],
    },
  ),
  ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL: profilePolicy(
    "ADJUST",
    ["ACCRUED_EXPENSES"],
    ["FIXED_ASSETS"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["FIXED_ASSETS"]),
      ],
      requireRoleComponents: ["FIXED_ASSETS", "ACCRUED_EXPENSES"],
    },
  ),
  ADJUST_EXCHANGE_CONTROL_RECLASS: profilePolicy(
    "ADJUST",
    EXCHANGE_CONTROL_ROLES,
    EXCHANGE_CONTROL_ROLES,
    {
      requireRoleComponents: EXCHANGE_CONTROL_ROLES,
    },
  ),
  ADJUST_YEAR_CLOSE: profilePolicy(
    "ADJUST",
    [...PNL_ROLES, "RETAINED_EARNINGS"],
    [...PNL_ROLES, "RETAINED_EARNINGS"],
    {
      requireRoleComponents: [...PNL_ROLES, "RETAINED_EARNINGS"],
    },
  ),
  ADJUST_YEAR_CLOSE_ZERO: memoPolicy("ADJUST"),

  OPENING_CUSTOMER: profilePolicy("OPENING", ["AR"], ["OPENING_EQUITY"], {
    sourceAssertions: [sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["AR"])],
  }),
  OPENING_SUPPLIER: profilePolicy("OPENING", ["OPENING_EQUITY"], ["AP"], {
    sourceAssertions: [sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["AP"])],
  }),
  OPENING_CASH: profilePolicy("OPENING", ["CASH"], ["OPENING_EQUITY"], {
    sourceAssertions: [
      sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["CASH"]),
    ],
  }),
  OPENING_TREASURY: profilePolicy(
    "OPENING",
    ["TREASURY_CASH"],
    ["OPENING_EQUITY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
    },
  ),
  OPENING_INVENTORY: profilePolicy(
    "OPENING",
    ["INVENTORY"],
    ["OPENING_EQUITY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["INVENTORY"]),
      ],
    },
  ),
  OPENING_FIXED_ASSET: profilePolicy(
    "OPENING",
    ["FIXED_ASSETS"],
    ["OPENING_EQUITY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["FIXED_ASSETS"]),
      ],
    },
  ),
  OPENING_EMPLOYEE_ADVANCE: profilePolicy(
    "OPENING",
    ["EMPLOYEE_ADVANCES"],
    ["OPENING_EQUITY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["EMPLOYEE_ADVANCES"]),
      ],
    },
  ),
  OPENING_EXCHANGE_IQD: profilePolicy(
    "OPENING",
    ["EXCHANGE_RECEIVABLE_IQD", "OPENING_EQUITY"],
    ["EXCHANGE_PAYABLE_IQD", "OPENING_EQUITY"],
    {
      reversible: false,
      requireRoleComponents: [
        "EXCHANGE_RECEIVABLE_IQD",
        "EXCHANGE_PAYABLE_IQD",
        "OPENING_EQUITY",
      ],
    },
  ),
  OPENING_EXCHANGE_USD: profilePolicy(
    "OPENING",
    ["EXCHANGE_RECEIVABLE_USD", "OPENING_EQUITY"],
    ["EXCHANGE_PAYABLE_USD", "OPENING_EQUITY"],
    {
      reversible: false,
      requireRoleComponents: [
        "EXCHANGE_RECEIVABLE_USD",
        "EXCHANGE_PAYABLE_USD",
        "OPENING_EQUITY",
      ],
    },
  ),
  OPENING_EXCHANGE_COMBINED: profilePolicy(
    "OPENING",
    [
      "EXCHANGE_RECEIVABLE_IQD",
      "EXCHANGE_RECEIVABLE_USD",
      "OPENING_EQUITY",
    ],
    [
      "EXCHANGE_PAYABLE_IQD",
      "EXCHANGE_PAYABLE_USD",
      "OPENING_EQUITY",
    ],
    {
      reversible: false,
      requireRoleComponents: [
        "EXCHANGE_RECEIVABLE_IQD",
        "EXCHANGE_RECEIVABLE_USD",
        "EXCHANGE_PAYABLE_IQD",
        "EXCHANGE_PAYABLE_USD",
        "OPENING_EQUITY",
      ],
    },
  ),
  OPENING_DIGITAL_WALLET: profilePolicy(
    "OPENING",
    ["DIGITAL_WALLET"],
    ["OPENING_EQUITY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["DIGITAL_WALLET"]),
      ],
    },
  ),
  OPENING_OWNER_CURRENT: profilePolicy(
    "OPENING",
    ["OPENING_EQUITY"],
    ["OWNER_CURRENT"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["OWNER_CURRENT"]),
      ],
    },
  ),
  OPENING_LOAN: profilePolicy("OPENING", ["OPENING_EQUITY"], ["LOAN_PAYABLE"], {
    sourceAssertions: [
      sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["LOAN_PAYABLE"]),
    ],
  }),

  INTERNAL_USE_INVENTORY: profilePolicy(
    "INTERNAL_USE",
    ["OPERATING_EXPENSE"],
    ["INVENTORY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["OPERATING_EXPENSE"]),
      ],
    },
  ),
  WASTAGE_INVENTORY: profilePolicy("WASTAGE", ["LOSSES"], ["INVENTORY"], {
    sourceAssertions: [
      sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["LOSSES"]),
    ],
  }),
  CASH_HANDOVER_TO_TREASURY: profilePolicy(
    "CASH_HANDOVER",
    ["TREASURY_CASH"],
    ["CASH"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
    },
  ),
  CASH_HANDOVER_TO_TRANSIT: profilePolicy(
    "CASH_TRANSFER_OUT",
    ["CASH_IN_TRANSIT"],
    ["CASH"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["CASH_IN_TRANSIT"]),
      ],
    },
  ),
  CASH_DROP_TO_TRANSIT: profilePolicy(
    "CASH_TRANSFER_OUT",
    ["CASH_IN_TRANSIT"],
    ["CASH"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["CASH_IN_TRANSIT"]),
      ],
    },
  ),
  CASH_TRANSFER_OUT_IN_TRANSIT: profilePolicy(
    "CASH_TRANSFER_OUT",
    ["CASH_IN_TRANSIT"],
    ["TREASURY_CASH"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["CASH_IN_TRANSIT"]),
      ],
    },
  ),
  INTERBRANCH_CLEARING_OUT: profilePolicy(
    "CASH_TRANSFER_OUT",
    ["INTERBRANCH_CLEARING"],
    ["CASH_IN_TRANSIT"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", [
          "INTERBRANCH_CLEARING",
        ]),
      ],
    },
  ),
  CASH_TRANSFER_IN_FROM_TRANSIT: profilePolicy(
    "CASH_TRANSFER_IN",
    ["TREASURY_CASH"],
    ["CASH_IN_TRANSIT"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
    },
  ),
  CASH_TRANSFER_IN_FROM_CLEARING: profilePolicy(
    "CASH_TRANSFER_IN",
    ["TREASURY_CASH"],
    ["INTERBRANCH_CLEARING"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
    },
  ),
  CASH_CUSTODY_SHORTAGE: profilePolicy(
    "CASH_TRANSFER_IN",
    ["TREASURY_CASH", "EMPLOYEE_ADVANCES"],
    ["CASH_IN_TRANSIT"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
      requireRoleComponents: [
        "TREASURY_CASH",
        "EMPLOYEE_ADVANCES",
        "CASH_IN_TRANSIT",
      ],
    },
  ),
  CASH_CUSTODY_SURPLUS: profilePolicy(
    "CASH_TRANSFER_IN",
    ["TREASURY_CASH"],
    ["CASH_IN_TRANSIT", "OTHER_LIABILITY"],
    {
      reversible: false,
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
      requireRoleComponents: [
        "TREASURY_CASH",
        "CASH_IN_TRANSIT",
        "OTHER_LIABILITY",
      ],
    },
  ),
  SHIFT_FLOAT_FROM_TREASURY: profilePolicy(
    "SHIFT_FLOAT_OUT",
    ["CASH"],
    ["TREASURY_CASH"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["CASH"]),
      ],
    },
  ),
  TREASURY_FUNDING_CAPITAL: profilePolicy(
    "TREASURY_FUNDING",
    ["TREASURY_CASH"],
    ["CAPITAL"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
    },
  ),
  TREASURY_FUNDING_OWNER_CURRENT: profilePolicy(
    "TREASURY_FUNDING",
    ["TREASURY_CASH"],
    ["OWNER_CURRENT"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
    },
  ),
  TREASURY_FUNDING_LOAN: profilePolicy(
    "TREASURY_FUNDING",
    ["TREASURY_CASH"],
    ["LOAN_PAYABLE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
    },
  ),

  DELIVERY_DISPATCH_COD: memoPolicy("DELIVERY_DISPATCH"),
  DELIVERY_REMIT_COD: profilePolicy(
    "DELIVERY_REMIT",
    CASH_ASSETS,
    ["DELIVERY_FLOAT"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["DELIVERY_FLOAT"]),
      ],
      requireRoleComponents: [...CASH_ASSETS, "DELIVERY_FLOAT"],
    },
  ),
  DELIVERY_FEE_EXPENSE: profilePolicy(
    "DELIVERY_FEE",
    ["DELIVERY_EXPENSE"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["DELIVERY_EXPENSE"]),
      ],
      requireRoleComponents: ["DELIVERY_EXPENSE", ...CASH_ASSETS],
    },
  ),
  DELIVERY_FEE_ACCRUAL: profilePolicy(
    "DELIVERY_FEE",
    ["DELIVERY_EXPENSE"],
    ["COURIER_PAYABLE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["DELIVERY_EXPENSE"]),
      ],
    },
  ),
  DELIVERY_FEE_SETTLEMENT: profilePolicy(
    "DELIVERY_FEE",
    ["COURIER_PAYABLE"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", CASH_ASSETS),
      ],
      requireRoleComponents: ["COURIER_PAYABLE", ...CASH_ASSETS],
    },
  ),
  // H2 (٢٩/٨/٢٦): تسويةٌ باستبدال الأجرة بالعمولة — المندوب يستلم العمولة نقداً، والفارقُ إيرادُ توصيلٍ للمكتبة.
  // DR COURIER_PAYABLE = feeAmount, CR CASH = commissionAmount, CR DELIVERY_REVENUE = (fee − commission).
  DELIVERY_COMMISSION_SETTLEMENT: profilePolicy(
    "DELIVERY_FEE",
    ["COURIER_PAYABLE"],
    [...CASH_ASSETS, "DELIVERY_REVENUE"],
    {
      sourceAssertions: [
        // القيدُ متوازنٌ داخلياً — لا مصدرٌ يقود المبلغَ من قيدٍ آخر.
      ],
      requireRoleComponents: ["COURIER_PAYABLE", ...CASH_ASSETS],
    },
  ),
  DELIVERY_FEE_HELD_RECEIPT: profilePolicy(
    "DELIVERY_FEE_HELD",
    CASH_ASSETS,
    ["COURIER_PAYABLE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "COURIER_PAYABLE"],
    },
  ),
  DELIVERY_FEE_HELD_PAYOUT: profilePolicy(
    "DELIVERY_FEE_HELD",
    CASH_ASSETS,
    ["COURIER_PAYABLE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", CASH_ASSETS),
      ],
      requireRoleComponents: [...CASH_ASSETS, "COURIER_PAYABLE"],
    },
  ),
  DELIVERY_WRITEOFF_FLOAT: profilePolicy(
    "DELIVERY_WRITEOFF",
    ["LOSSES"],
    ["DELIVERY_FLOAT"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["LOSSES"]),
      ],
    },
  ),

  EXCHANGE_DEPOSIT_IQD: profilePolicy(
    "EXCHANGE_DEPOSIT",
    ["EXCHANGE_WALLET_IQD"],
    ["TREASURY_CASH"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", [
          "EXCHANGE_WALLET_IQD",
        ]),
      ],
      requireRoleComponents: ["EXCHANGE_WALLET_IQD", "TREASURY_CASH"],
    },
  ),
  EXCHANGE_DEPOSIT_USD_CASH: profilePolicy(
    "EXCHANGE_DEPOSIT",
    ["EXCHANGE_WALLET_USD"],
    ["FOREIGN_CASH_USD"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", [
          "EXCHANGE_WALLET_USD",
        ]),
      ],
      requireRoleComponents: ["EXCHANGE_WALLET_USD", "FOREIGN_CASH_USD"],
    },
  ),
  EXCHANGE_WITHDRAW_IQD: profilePolicy(
    "EXCHANGE_WITHDRAW",
    ["TREASURY_CASH"],
    ["EXCHANGE_WALLET_IQD"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["TREASURY_CASH"]),
      ],
      requireRoleComponents: ["TREASURY_CASH", "EXCHANGE_WALLET_IQD"],
    },
  ),
  EXCHANGE_WITHDRAW_USD_CASH: profilePolicy(
    "EXCHANGE_WITHDRAW",
    ["FOREIGN_CASH_USD"],
    ["EXCHANGE_WALLET_USD"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["FOREIGN_CASH_USD"]),
      ],
      requireRoleComponents: ["FOREIGN_CASH_USD", "EXCHANGE_WALLET_USD"],
    },
  ),
  EXCHANGE_FX_BUY: profilePolicy(
    "EXCHANGE_FX_BUY",
    ["FOREIGN_CASH_USD"],
    ["EXCHANGE_WALLET_USD"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["FOREIGN_CASH_USD"]),
      ],
      requireRoleComponents: ["FOREIGN_CASH_USD", "EXCHANGE_WALLET_USD"],
    },
  ),
  EXCHANGE_SETTLE_SUPPLIER: profilePolicy(
    "EXCHANGE_SETTLE",
    ["AP"],
    ["EXCHANGE_WALLET_IQD", "EXCHANGE_WALLET_USD"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["AP"]),
      ],
      requireRoleComponents: [
        "AP",
        "EXCHANGE_WALLET_IQD",
        "EXCHANGE_WALLET_USD",
      ],
    },
  ),
  EXCHANGE_FEE_EXPENSE: profilePolicy(
    "EXCHANGE_FEE",
    ["OPERATING_EXPENSE", "OTHER_EXPENSE"],
    ["EXCHANGE_WALLET_IQD", "EXCHANGE_WALLET_USD", ...CASH_ASSETS],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", [
          "OPERATING_EXPENSE",
          "OTHER_EXPENSE",
        ]),
      ],
      requireRoleComponents: [
        "OPERATING_EXPENSE",
        "OTHER_EXPENSE",
        "EXCHANGE_WALLET_IQD",
        "EXCHANGE_WALLET_USD",
        ...CASH_ASSETS,
      ],
    },
  ),
  EXCHANGE_FX_GAIN: profilePolicy(
    "EXCHANGE_FX_DIFF",
    ["EXCHANGE_WALLET_IQD", "EXCHANGE_WALLET_USD", ...CASH_ASSETS],
    ["FX_GAIN"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["FX_GAIN"]),
      ],
      requireRoleComponents: [
        "EXCHANGE_WALLET_IQD",
        "EXCHANGE_WALLET_USD",
        ...CASH_ASSETS,
        "FX_GAIN",
      ],
    },
  ),
  EXCHANGE_FX_LOSS: profilePolicy(
    "EXCHANGE_FX_DIFF",
    ["FX_LOSS"],
    ["EXCHANGE_WALLET_IQD", "EXCHANGE_WALLET_USD", ...CASH_ASSETS],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["FX_LOSS"]),
      ],
      requireRoleComponents: [
        "FX_LOSS",
        "EXCHANGE_WALLET_IQD",
        "EXCHANGE_WALLET_USD",
        ...CASH_ASSETS,
      ],
    },
  ),
  GIFT_OUT_PROMO: profilePolicy("GIFT_OUT", ["GIFTS_PROMO"], ["INVENTORY"], {
    sourceAssertions: [
      sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["GIFTS_PROMO"]),
    ],
  }),
  GIFT_OUT_MIXED_PROMO: profilePolicy(
    "GIFT_OUT",
    ["GIFTS_PROMO"],
    ["INVENTORY"],
    {
      sourceAssertions: [
        sourceAssertion(
          "cost",
          "DEBIT_MINUS_CREDIT",
          ["GIFTS_PROMO"],
          "ABS_LTE",
        ),
      ],
      requireRoleComponents: ["GIFTS_PROMO", "INVENTORY"],
    },
  ),
  GIFT_OUT_CONSIGNMENT_MEMO: memoPolicy("GIFT_OUT"),

  DIGITAL_WALLET_DEPOSIT_ASSET: profilePolicy(
    "DIGITAL_WALLET_DEPOSIT",
    ["DIGITAL_WALLET"],
    CASH_ASSETS,
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["DIGITAL_WALLET"]),
      ],
      requireRoleComponents: ["DIGITAL_WALLET", ...CASH_ASSETS],
    },
  ),
  DIGITAL_WALLET_WITHDRAWAL_ASSET: profilePolicy(
    "DIGITAL_WALLET_WITHDRAWAL",
    CASH_ASSETS,
    ["DIGITAL_WALLET"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "CREDIT_MINUS_DEBIT", ["DIGITAL_WALLET"]),
      ],
      requireRoleComponents: [...CASH_ASSETS, "DIGITAL_WALLET"],
    },
  ),
  DIGITAL_WALLET_CONSUMPTION_SALE: profilePolicy(
    "DIGITAL_WALLET_CONSUMPTION",
    ["INVENTORY"],
    ["DIGITAL_WALLET"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["INVENTORY"]),
      ],
    },
  ),
  DIGITAL_WALLET_REVERSAL_SALE: profilePolicy(
    "DIGITAL_WALLET_REVERSAL",
    ["DIGITAL_WALLET"],
    ["INVENTORY"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["DIGITAL_WALLET"]),
      ],
    },
  ),
  DIGITAL_WALLET_ADJUSTMENT_GAIN: profilePolicy(
    "DIGITAL_WALLET_ADJUSTMENT",
    ["DIGITAL_WALLET"],
    ["OTHER_REVENUE"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["DIGITAL_WALLET"]),
      ],
    },
  ),
  DIGITAL_WALLET_ADJUSTMENT_LOSS: profilePolicy(
    "DIGITAL_WALLET_ADJUSTMENT",
    ["LOSSES"],
    ["DIGITAL_WALLET"],
    {
      sourceAssertions: [
        sourceAssertion("amount", "DEBIT_MINUS_CREDIT", ["LOSSES"]),
      ],
    },
  ),
  DIGITAL_WRITEOFF_EXPENSE: profilePolicy(
    "DIGITAL_WRITEOFF",
    ["LOSSES"],
    ["INVENTORY"],
    {
      sourceAssertions: [
        sourceAssertion("cost", "DEBIT_MINUS_CREDIT", ["LOSSES"]),
      ],
    },
  ),
} satisfies Record<PostingProfile, PostingProfilePolicy>);

/**
 * Dormant paths are still activation-critical: ACTIVE is unsafe when a payroll
 * or accrued-expense producer has no exact executable profile, even when the
 * 30-day observation window happened not to exercise that path.
 */
export const ACTIVATION_REQUIRED_POSTING_PROFILES = Object.freeze([
  "PURCHASE_INVENTORY_CASH_CLEARING",
  "PAYMENT_OUT_PURCHASE_CASH_CLEARING",
  "PAYMENT_IN_PURCHASE_CASH_CLEARING",
  "RETURN_PURCHASE_INVENTORY_CASH_CLEARING",
  "PAYMENT_IN_CATEGORY",
  "PAYMENT_IN_CATEGORY_REVERSAL",
  "PAYMENT_OUT_CATEGORY",
  "PAYMENT_OUT_CATEGORY_REVERSAL",
  "ADJUST_PAYROLL_ACCRUAL",
  "ADJUST_PAYROLL_ACCRUAL_REVERSAL",
  "ADJUST_EOS_SETTLEMENT",
  "ADJUST_EOS_SETTLEMENT_REVERSAL",
  "ADJUST_EOS_PROVISION_TRANSFER_OUT",
  "ADJUST_EOS_PROVISION_TRANSFER_REVERSAL",
  "ADJUST_TERMINATION_ADVANCE_TRANSFER_OUT",
  "ADJUST_TERMINATION_ADVANCE_TRANSFER_REVERSAL",
  "PAYMENT_OUT_PAYROLL_NET",
  "PAYMENT_IN_PAYROLL_NET_RETURN",
  "PAYMENT_OUT_PAYROLL_TAX_REMIT",
  "PAYMENT_IN_PAYROLL_TAX_RETURN",
  "PAYMENT_OUT_PAYROLL_SS_REMIT",
  "PAYMENT_IN_PAYROLL_SS_RETURN",
  "PAYMENT_IN_EMPLOYEE_ADVANCE_REPAYMENT",
  "PAYMENT_OUT_EMPLOYEE_ADVANCE_REPAYMENT_RETURN",
  "ADJUST_EXPENSE_ACCRUAL",
  "ADJUST_EXPENSE_ACCRUAL_REVERSAL",
  "PAYMENT_OUT_ACCRUED_EXPENSE_SETTLEMENT",
  "ADJUST_FIXED_ASSET_ACCRUAL",
  "ADJUST_FIXED_ASSET_ACCRUAL_REVERSAL",
  "PAYMENT_OUT_FIXED_ASSET_ACCRUAL_SETTLEMENT",
  "ADJUST_EXCHANGE_CONTROL_RECLASS",
] as const satisfies readonly PostingProfile[]);

export const ACTIVATION_REQUIRED_ACCOUNT_ROLES = Object.freeze([
  "OTHER_LIABILITY",
  "PAYROLL_TAX_PAYABLE",
  "SOCIAL_SECURITY_PAYABLE",
  "EOS_PROVISION",
  "SOCIAL_SECURITY_EXPENSE",
  "EOS_EXPENSE",
  "INTERBRANCH_CLEARING",
  "ACCRUED_EXPENSES",
  "EXCHANGE_RECEIVABLE_IQD",
  "EXCHANGE_RECEIVABLE_USD",
  "EXCHANGE_PAYABLE_IQD",
  "EXCHANGE_PAYABLE_USD",
] as const satisfies readonly AccountRole[]);

export const ALL_POSTING_PROFILES: readonly PostingProfile[] = Object.freeze(
  Object.keys(PROFILE_POLICIES).sort() as PostingProfile[],
);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeRoleAmounts(
  values: PostingRoleAmounts | undefined,
  label: string,
): Readonly<PostingRoleAmounts> {
  const normalized: Record<string, string> = {};
  if (!values) return Object.freeze(normalized);
  const knownRoles = new Set<string>(ACCOUNT_ROLES);
  for (const role of Object.keys(values).sort()) {
    if (!knownRoles.has(role)) {
      throw new InvalidPostingIntentError(`${label} has unknown role ${role}`);
    }
    const amount = round2(money(values[role as AccountRole] ?? 0));
    if (amount.isNegative()) {
      throw new InvalidPostingIntentError(
        `${label}.${role} cannot be negative`,
      );
    }
    if (!amount.isZero()) normalized[role] = amount.toFixed(2);
  }
  return Object.freeze(normalized as PostingRoleAmounts);
}

function normalizeSourceComponents(
  source: PostingSourceComponents | undefined,
): PostingSourceComponents | undefined {
  if (!source || (source.roleDebits == null && source.roleCredits == null)) {
    return undefined;
  }
  return Object.freeze({
    roleDebits: normalizeRoleAmounts(source.roleDebits, "roleDebits"),
    roleCredits: normalizeRoleAmounts(source.roleCredits, "roleCredits"),
  });
}

/** Any semantic policy change invalidates the accountant's prior approval. */
export const POSTING_POLICY_HASH = createHash("sha256")
  .update(stableJson(PROFILE_POLICIES), "utf8")
  .digest("hex");

/** Legacy derivation input. New multi-purpose call sites must provide intent. */
export interface PostingInput extends PostingSourceComponents {
  entryType: EntryType | string;
  revenue?: DecimalInput;
  cost?: DecimalInput;
  profit?: DecimalInput;
  amount?: DecimalInput;
  taxAmount?: DecimalInput;
  party?: "CUSTOMER" | "SUPPLIER" | null;
  cashRole?: "CASH" | "CARD_BANK";
  salesRole?: AccountRole;
  intent?: PostingIntent;
}

export class UnmappedEntryTypeError extends Error {
  constructor(public readonly entryType: string) {
    super(`نوع قيد غير مخطّط بلا PostingIntent صريح: ${entryType}`);
    this.name = "UnmappedEntryTypeError";
  }
}

export class InvalidPostingIntentError extends Error {
  constructor(message: string) {
    super(`PostingIntent غير صالح: ${message}`);
    this.name = "InvalidPostingIntentError";
  }
}

function normalizedAmount(value: DecimalInput, context: string): Decimal {
  const amount = round2(money(value));
  if (amount.isNegative()) {
    throw new InvalidPostingIntentError(
      `${context}: المبلغ سالب؛ استعمل signedPostingLines للعكس`,
    );
  }
  if (amount.isZero()) {
    throw new InvalidPostingIntentError(
      `${context}: سطر المبلغ الصفري غير مسموح`,
    );
  }
  return amount;
}

export function debitLine(
  role: AccountRole,
  amount: DecimalInput,
): JournalLine {
  return {
    role,
    debit: normalizedAmount(amount, role).toFixed(2),
    credit: "0.00",
  };
}

export function creditLine(
  role: AccountRole,
  amount: DecimalInput,
): JournalLine {
  return {
    role,
    debit: "0.00",
    credit: normalizedAmount(amount, role).toFixed(2),
  };
}

/** Positive means debitRole is debited; negative reverses both sides. */
export function signedPostingLines(
  debitRole: AccountRole,
  creditRole: AccountRole,
  signedAmount: DecimalInput,
): JournalLine[] {
  const amount = round2(money(signedAmount));
  if (amount.isZero()) return [];
  const absolute = amount.abs();
  return amount.isPositive()
    ? [debitLine(debitRole, absolute), creditLine(creditRole, absolute)]
    : [debitLine(creditRole, absolute), creditLine(debitRole, absolute)];
}

const roleSet: ReadonlySet<string> = new Set(ACCOUNT_ROLES);

function isEntryType(value: string): value is EntryType {
  return Object.prototype.hasOwnProperty.call(ENTRY_TYPE_PROFILES, value);
}

/**
 * Mode-independent normalization only.  It deliberately does not apply a
 * profile policy: producers construct intents before the runtime mode is
 * known, and OFF/SHADOW must never fail a business operation here.
 */
export function validatePostingIntent(
  intent: PostingIntent,
  expectedEntryType?: EntryType | string,
): PostingIntent {
  if (!intent || typeof intent !== "object") {
    throw new InvalidPostingIntentError("intent is missing");
  }
  if (!isEntryType(intent.entryType)) {
    throw new InvalidPostingIntentError(
      `unknown entryType: ${String(intent.entryType)}`,
    );
  }
  if (
    expectedEntryType !== undefined &&
    intent.entryType !== expectedEntryType
  ) {
    throw new InvalidPostingIntentError(
      `entryType=${intent.entryType} does not match ${expectedEntryType}`,
    );
  }
  if (!ENTRY_TYPE_PROFILES[intent.entryType].includes(intent.profile)) {
    throw new InvalidPostingIntentError(
      `profile=${String(intent.profile)} does not belong to ${intent.entryType}`,
    );
  }
  if (!Array.isArray(intent.lines)) {
    throw new InvalidPostingIntentError("lines must be an array");
  }
  const memoOnly = PROFILE_POLICIES[intent.profile].memoOnly;
  if (intent.lines.length === 0 && !memoOnly) {
    throw new InvalidPostingIntentError(
      "a non-memo intent needs journal lines",
    );
  }
  if (intent.lines.length > 0 && memoOnly) {
    throw new InvalidPostingIntentError(`${intent.profile} is memo-only`);
  }
  const normalizedLines = intent.lines.map((line, index) => {
    if (!line || !roleSet.has(line.role)) {
      throw new InvalidPostingIntentError(
        `unknown role on line ${index + 1}: ${String(line?.role)}`,
      );
    }
    const debit = money(line.debit);
    const credit = money(line.credit);
    if (debit.isNegative() || credit.isNegative()) {
      throw new InvalidPostingIntentError(
        `negative amount on line ${index + 1}`,
      );
    }
    if (debit.isZero() === credit.isZero()) {
      throw new InvalidPostingIntentError(
        `line ${index + 1} must have exactly one positive side`,
      );
    }
    if (!debit.eq(round2(debit)) || !credit.eq(round2(credit))) {
      throw new InvalidPostingIntentError(
        `line ${index + 1} exceeds two decimal places`,
      );
    }
    return Object.freeze({
      role: line.role,
      debit: round2(debit).toFixed(2),
      credit: round2(credit).toFixed(2),
    });
  });
  if (!memoOnly) assertBalanced(normalizedLines, intent.entryType);
  const sourceComponents = normalizeSourceComponents(intent.sourceComponents);
  return Object.freeze({
    profile: intent.profile,
    entryType: intent.entryType,
    lines: Object.freeze(normalizedLines),
    ...(sourceComponents ? { sourceComponents } : {}),
  });
}

/** Runtime policy/source validation; call only after resolving OFF/SHADOW/ACTIVE. */
export function validatePostingIntentPolicy(
  intent: PostingIntent,
  expectedEntryType?: EntryType | string,
  source?: PostingSourceAmounts,
): PostingIntent {
  intent = validatePostingIntent(intent, expectedEntryType);
  if (!intent || typeof intent !== "object") {
    throw new InvalidPostingIntentError("القيمة مفقودة");
  }
  if (!isEntryType(intent.entryType)) {
    throw new InvalidPostingIntentError(
      `entryType غير معروف: ${String(intent.entryType)}`,
    );
  }
  if (
    expectedEntryType !== undefined &&
    intent.entryType !== expectedEntryType
  ) {
    throw new InvalidPostingIntentError(
      `entryType=${intent.entryType} لا يطابق القيد ${expectedEntryType}`,
    );
  }
  if (!ENTRY_TYPE_PROFILES[intent.entryType].includes(intent.profile)) {
    throw new InvalidPostingIntentError(
      `profile=${String(intent.profile)} لا ينتمي إلى ${intent.entryType}`,
    );
  }
  if (!Array.isArray(intent.lines)) {
    throw new InvalidPostingIntentError("الأسطر يجب أن تكون مصفوفة");
  }
  const policy = PROFILE_POLICIES[intent.profile];
  if (policy.entryType !== intent.entryType) {
    throw new InvalidPostingIntentError(
      `policy=${intent.profile} belongs to ${policy.entryType}, not ${intent.entryType}`,
    );
  }
  if (intent.lines.length === 0 && !policy.memoOnly) {
    throw new InvalidPostingIntentError(
      "القيد يجب أن يحتوي سطراً واحداً على الأقل",
    );
  }
  if (intent.lines.length > 0 && policy.memoOnly) {
    throw new InvalidPostingIntentError(
      "DELIVERY_DISPATCH_COD مذكرة تشغيلية بلا قيد دفتر",
    );
  }
  const allowed = new Set(
    policy.allowed.map(({ role, side }) => `${role}:${side}`),
  );
  for (let index = 0; index < intent.lines.length; index += 1) {
    const line = intent.lines[index];
    if (!line || !roleSet.has(line.role)) {
      throw new InvalidPostingIntentError(
        `الدور غير معروف في السطر ${index + 1}: ${String(line?.role)}`,
      );
    }
    const debit = money(line.debit);
    const credit = money(line.credit);
    if (debit.isNegative() || credit.isNegative()) {
      throw new InvalidPostingIntentError(
        `السطر ${index + 1} يحمل مبلغاً سالباً`,
      );
    }
    if (debit.isZero() === credit.isZero()) {
      throw new InvalidPostingIntentError(
        `السطر ${index + 1} يجب أن يحمل طرفاً واحداً موجباً والطرف الآخر صفراً`,
      );
    }
    if (!debit.eq(round2(debit)) || !credit.eq(round2(credit))) {
      throw new InvalidPostingIntentError(
        `السطر ${index + 1} يتجاوز منزلتين عشريتين`,
      );
    }
    const side: PostingSide = !debit.isZero() ? DEBIT : CREDIT;
    if (!allowed.has(`${line.role}:${side}`)) {
      throw new InvalidPostingIntentError(
        `role ${line.role} on ${side} is not allowed by ${intent.profile}`,
      );
    }
  }
  if (!policy.memoOnly) {
    assertBalanced(intent.lines, intent.entryType);
    const present = new Set(
      intent.lines.map(
        (line) =>
          `${line.role}:${!money(line.debit).isZero() ? DEBIT : CREDIT}`,
      ),
    );
    const matchesRequiredPattern = policy.requiredOneOf.some((pattern) =>
      pattern.allOf.every((group) =>
        group.anyOf.some(({ role, side }) => present.has(`${role}:${side}`)),
      ),
    );
    if (!matchesRequiredPattern) {
      throw new InvalidPostingIntentError(
        `required role/side pattern is incomplete for ${intent.profile}`,
      );
    }
  }
  const lines = intent.lines.map((line) =>
    Object.freeze({
      role: line.role,
      debit: round2(line.debit).toFixed(2),
      credit: round2(line.credit).toFixed(2),
    }),
  );
  const declaredComponents = normalizeSourceComponents(intent.sourceComponents);
  const suppliedComponents = normalizeSourceComponents(source);
  if (
    declaredComponents &&
    suppliedComponents &&
    stableJson(declaredComponents) !== stableJson(suppliedComponents)
  ) {
    throw new InvalidPostingIntentError(
      `${intent.profile}: source role components do not match the declared intent components`,
    );
  }
  if (policy.requireRoleComponents.length > 0 && !suppliedComponents) {
    throw new InvalidPostingIntentError(
      `${intent.profile}: independent source role components are missing`,
    );
  }
  const sourceComponents = suppliedComponents ?? declaredComponents;
  const validated = Object.freeze({
    profile: intent.profile,
    entryType: intent.entryType,
    lines: Object.freeze(lines),
    ...(sourceComponents ? { sourceComponents } : {}),
  });
  if (source || sourceComponents) {
    validatePostingIntentAgainstSource(validated, {
      ...(source ?? {}),
      ...(sourceComponents ?? {}),
    });
  }
  return validated;
}

export function validatePostingIntentAgainstSource(
  intent: PostingIntent,
  source: PostingSourceAmounts,
): PostingIntent {
  const policy = PROFILE_POLICIES[intent.profile];
  const components = normalizeSourceComponents(source);
  if (policy.requireRoleComponents.length > 0 && !components) {
    throw new InvalidPostingIntentError(
      `${intent.profile}: required source role components are missing`,
    );
  }
  if (components) {
    const required = new Set<AccountRole>(policy.requireRoleComponents);
    for (const role of [
      ...Object.keys(components.roleDebits ?? {}),
      ...Object.keys(components.roleCredits ?? {}),
    ] as AccountRole[]) {
      if (!required.has(role)) {
        throw new InvalidPostingIntentError(
          `${intent.profile}: source component role ${role} is not declared by policy`,
        );
      }
    }
    for (const role of Array.from(required)) {
      let debit = money(0);
      let credit = money(0);
      for (const line of intent.lines) {
        if (line.role !== role) continue;
        debit = debit.plus(line.debit);
        credit = credit.plus(line.credit);
      }
      const expectedDebit = round2(money(components.roleDebits?.[role] ?? 0));
      const expectedCredit = round2(money(components.roleCredits?.[role] ?? 0));
      if (
        !round2(debit).eq(expectedDebit) ||
        !round2(credit).eq(expectedCredit)
      ) {
        throw new InvalidPostingIntentError(
          `${intent.profile}: component ${role} expected Dr ${expectedDebit.toFixed(2)}/Cr ${expectedCredit.toFixed(2)}, got Dr ${round2(debit).toFixed(2)}/Cr ${round2(credit).toFixed(2)}`,
        );
      }
    }
  }
  for (const assertion of policy.sourceAssertions) {
    let measured = money(0);
    const roles = new Set<AccountRole>(assertion.roles);
    for (const line of intent.lines) {
      if (!roles.has(line.role)) continue;
      measured = measured.plus(money(line.debit)).minus(money(line.credit));
    }
    if (assertion.measure === "CREDIT_MINUS_DEBIT") measured = measured.neg();
    measured = round2(measured);
    const expected = round2(money(source[assertion.field] ?? 0));
    const comparison = assertion.comparison ?? "EQUAL";
    const valid =
      comparison === "EQUAL"
        ? measured.eq(expected)
        : comparison === "ABS_EQUAL"
          ? measured.abs().eq(expected.abs())
          : measured.abs().lte(expected.abs()) &&
            (measured.isZero() ||
              (!expected.isZero() &&
                measured.isPositive() === expected.isPositive()));
    if (!valid) {
      throw new InvalidPostingIntentError(
        `${intent.profile}: source ${assertion.field}=${expected.toFixed(2)} does not match ${assertion.measure}(${assertion.roles.join("+")})=${measured.toFixed(2)} [${comparison}]`,
      );
    }
  }
  return intent;
}

export function createPostingIntent(
  profile: PostingProfile,
  entryType: EntryType,
  lines: readonly JournalLine[],
  sourceComponents?: PostingSourceComponents,
): PostingIntent {
  const copiedComponents = sourceComponents
    ? Object.freeze({
        ...(sourceComponents.roleDebits
          ? { roleDebits: Object.freeze({ ...sourceComponents.roleDebits }) }
          : {}),
        ...(sourceComponents.roleCredits
          ? { roleCredits: Object.freeze({ ...sourceComponents.roleCredits }) }
          : {}),
      })
    : undefined;
  return Object.freeze({
    profile,
    entryType,
    lines: Object.freeze(
      lines.map((line) =>
        Object.freeze({
          role: line.role,
          debit: line.debit,
          credit: line.credit,
        }),
      ),
    ),
    ...(copiedComponents ? { sourceComponents: copiedComponents } : {}),
  });
}

export interface PostingIntentEvidence {
  readonly postingProfile: PostingProfile;
  /** Canonical v1 object, ready for a MySQL JSON column. */
  readonly postingIntentJson: Readonly<{
    version: 1;
    profile: PostingProfile;
    entryType: EntryType;
    lines: readonly JournalLine[];
    sourceComponents?: PostingSourceComponents;
  }>;
  readonly postingIntentHash: string;
}

function canonicalIntentObject(
  intent: PostingIntent,
): PostingIntentEvidence["postingIntentJson"] {
  const validated = validatePostingIntent(intent, intent.entryType);
  const lines = [...validated.lines]
    .map((line) => ({
      role: line.role,
      debit: round2(line.debit).toFixed(2),
      credit: round2(line.credit).toFixed(2),
    }))
    .sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        a.debit.localeCompare(b.debit) ||
        a.credit.localeCompare(b.credit),
    )
    .map((line) => Object.freeze(line));
  return Object.freeze({
    version: 1 as const,
    profile: validated.profile,
    entryType: validated.entryType,
    lines: Object.freeze(lines),
    ...(validated.sourceComponents
      ? { sourceComponents: validated.sourceComponents }
      : {}),
  });
}

/** Canonical JSON v1: stable keys/line order and exactly two decimals. */
export function canonicalizePostingIntent(intent: PostingIntent): string {
  return stableJson(canonicalIntentObject(intent));
}

export function hashPostingIntent(intent: PostingIntent): string {
  return createHash("sha256")
    .update(canonicalizePostingIntent(intent), "utf8")
    .digest("hex");
}

export function createPostingIntentEvidence(
  intent: PostingIntent,
  source?: PostingSourceAmounts,
): PostingIntentEvidence {
  const validated = validatePostingIntentPolicy(
    intent,
    intent.entryType,
    source,
  );
  const postingIntentJson = canonicalIntentObject(validated);
  return Object.freeze({
    postingProfile: validated.profile,
    postingIntentJson,
    postingIntentHash: createHash("sha256")
      .update(stableJson(postingIntentJson), "utf8")
      .digest("hex"),
  });
}

/** Verifies schema, canonical form, policy/source constraints, and SHA-256. */
export function verifyPostingIntentEvidence(input: {
  expectedEntryType: EntryType | string;
  postingProfile: string | null | undefined;
  postingIntentJson: unknown;
  postingIntentHash: string | null | undefined;
  source?: PostingSourceAmounts;
}): PostingIntent {
  if (
    !input.postingProfile ||
    !input.postingIntentJson ||
    !input.postingIntentHash
  ) {
    throw new InvalidPostingIntentError("posting evidence is incomplete");
  }
  let raw: unknown = input.postingIntentJson;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new InvalidPostingIntentError(
        "postingIntentJson is not valid JSON",
      );
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidPostingIntentError("postingIntentJson must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw new InvalidPostingIntentError(
      `unsupported posting evidence version: ${String(record.version)}`,
    );
  }
  const persistedComponents = record.sourceComponents
    ? (record.sourceComponents as PostingSourceComponents)
    : undefined;
  const callerProvidedComponents =
    input.source?.roleDebits != null || input.source?.roleCredits != null;
  // Independent components are mandatory when evidence is first created.
  // On later persisted verification the canonical copy is itself that sealed
  // evidence; a caller may still supply freshly derived components to compare.
  const verificationSource = callerProvidedComponents
    ? input.source
    : persistedComponents
      ? { ...(input.source ?? {}), ...persistedComponents }
      : input.source;
  const intent = validatePostingIntentPolicy(
    {
      profile: record.profile as PostingProfile,
      entryType: record.entryType as EntryType,
      lines: record.lines as JournalLine[],
      ...(persistedComponents ? { sourceComponents: persistedComponents } : {}),
    },
    input.expectedEntryType,
    verificationSource,
  );
  if (intent.profile !== input.postingProfile) {
    throw new InvalidPostingIntentError(
      "postingProfile does not match postingIntentJson",
    );
  }
  const canonical = canonicalizePostingIntent(intent);
  if (stableJson(raw) !== canonical) {
    throw new InvalidPostingIntentError(
      "postingIntentJson is not the exact canonical v1 document",
    );
  }
  const expectedHash = createHash("sha256").update(canonical, "utf8").digest();
  if (!/^[a-f0-9]{64}$/i.test(input.postingIntentHash)) {
    throw new InvalidPostingIntentError("postingIntentHash is malformed");
  }
  const suppliedHash = Buffer.from(input.postingIntentHash, "hex");
  if (
    suppliedHash.length !== expectedHash.length ||
    !timingSafeEqual(suppliedHash, expectedHash)
  ) {
    throw new InvalidPostingIntentError(
      "postingIntentHash does not match postingIntentJson",
    );
  }
  return intent;
}

/** Explicit intent wins. Derivation fallback remains only for six legacy maps. */
export function postingLinesFor(input: PostingInput): JournalLine[] {
  if (input.intent)
    return [
      ...validatePostingIntentPolicy(input.intent, input.entryType, input)
        .lines,
    ];
  const entryType = input.entryType;
  const revenue = money(input.revenue ?? "0");
  const cost = money(input.cost ?? "0");
  const amount = money(input.amount ?? "0");
  const cashRole = input.cashRole ?? "CASH";
  const salesRole = input.salesRole ?? "SALES_STATIONERY";
  const lines: JournalLine[] = [];

  switch (entryType) {
    case "SALE": {
      lines.push(debitLine("AR", amount), creditLine(salesRole, revenue));
      const taxLike = round2(amount.minus(revenue));
      if (taxLike.gt(0)) lines.push(creditLine("OTHER_LIABILITY", taxLike));
      if (cost.gt(0))
        lines.push(debitLine("COGS", cost), creditLine("INVENTORY", cost));
      break;
    }
    case "RETURN": {
      if (input.party === "SUPPLIER")
        throw new UnmappedEntryTypeError("RETURN(SUPPLIER)");
      const revenueAbsolute = revenue.abs();
      const amountAbsolute = amount.abs();
      const costAbsolute = cost.abs();
      lines.push(debitLine(salesRole, revenueAbsolute));
      const taxLike = round2(amountAbsolute.minus(revenueAbsolute));
      if (taxLike.gt(0)) lines.push(debitLine("OTHER_LIABILITY", taxLike));
      lines.push(creditLine("AR", amountAbsolute));
      if (costAbsolute.gt(0))
        lines.push(
          debitLine("INVENTORY", costAbsolute),
          creditLine("COGS", costAbsolute),
        );
      break;
    }
    case "PURCHASE":
      lines.push(debitLine("INVENTORY", amount), creditLine("AP", amount));
      break;
    case "PAYMENT_IN":
      if (input.party !== "CUSTOMER")
        throw new UnmappedEntryTypeError(
          `PAYMENT_IN(${input.party ?? "NO_PARTY"})`,
        );
      lines.push(debitLine(cashRole, amount), creditLine("AR", amount));
      break;
    case "PAYMENT_OUT":
      if (input.party !== "SUPPLIER")
        throw new UnmappedEntryTypeError(
          `PAYMENT_OUT(${input.party ?? "NO_PARTY"})`,
        );
      lines.push(debitLine("AP", amount), creditLine(cashRole, amount));
      break;
    case "OPENING": {
      if (input.party !== "CUSTOMER" && input.party !== "SUPPLIER") {
        throw new UnmappedEntryTypeError(
          `OPENING(${input.party ?? "NO_PARTY"})`,
        );
      }
      const partyRole: AccountRole = input.party === "SUPPLIER" ? "AP" : "AR";
      const absolute = amount.abs();
      const partyIsDebit =
        input.party === "SUPPLIER" ? amount.isNegative() : amount.gte(0);
      lines.push(
        ...(partyIsDebit
          ? [
              debitLine(partyRole, absolute),
              creditLine("OPENING_EQUITY", absolute),
            ]
          : [
              creditLine(partyRole, absolute),
              debitLine("OPENING_EQUITY", absolute),
            ]),
      );
      break;
    }
    default:
      throw new UnmappedEntryTypeError(entryType);
  }
  assertBalanced(lines, entryType);
  return lines;
}

export function assertBalanced(
  lines: readonly JournalLine[],
  entryType = "",
): void {
  let debit = money(0);
  let credit = money(0);
  for (const line of lines) {
    debit = debit.plus(money(line.debit));
    credit = credit.plus(money(line.credit));
  }
  if (!round2(debit).eq(round2(credit))) {
    throw new InvalidPostingIntentError(
      `قيد غير متوازن (${entryType}): مجموع المدين=${round2(debit).toFixed(2)} لا يساوي مجموع الدائن=${round2(credit).toFixed(2)}`,
    );
  }
}
