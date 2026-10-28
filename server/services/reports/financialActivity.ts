import { sql } from "drizzle-orm";
import type { DB } from "../../db";
import { verifyPostingIntentEvidence } from "../accounting/postingEngine";
import { money, toDbMoney } from "../money";
import {
  parseSystemPaymentRequest,
  isCanonicalSystemPaymentRequest,
  hasSystemPaymentRequestEnvelope,
} from "../voucher/create";

const EXPENSE_ROLES = new Set([
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
]);
const REVENUE_ROLES = new Set(["OTHER_REVENUE"]);

interface VoucherActivityRow {
  receiptId: number;
  entryType: string;
  amount: string;
  postingProfile: string | null;
  postingIntentJson: unknown;
  postingIntentHash: string | null;
  partyType: string | null;
  invoiceId: number | null;
  workOrderId: number | null;
  voucherNumber: string | null;
  category: string | null;
  postingRole: string | null;
  referenceNumber: string | null;
  internalNote: string | null;
  representedExpense: number;
  returnSettlement: number;
  accrualSettlement: number;
}

function rowsOf(result: unknown): VoucherActivityRow[] {
  return ((result as unknown[][])[0] ?? result) as VoucherActivityRow[];
}

function cancellationOf(row: VoucherActivityRow) {
  const request = parseSystemPaymentRequest(row.internalNote);
  return request?.kind === "VOUCHER_CANCELLATION" &&
    isCanonicalSystemPaymentRequest(request, row.referenceNumber)
    ? request
    : null;
}

/** Classifies persisted accounts first; present category configuration is a legacy fallback only. */
export function voucherFinancialEffect(row: VoucherActivityRow): {
  expense: string;
  revenue: string;
} {
  const zero = { expense: "0.00", revenue: "0.00" };
  // These sources already recognise their result elsewhere. Paying/refunding is settlement.
  if (row.representedExpense || row.returnSettlement || row.accrualSettlement)
    return zero;
  if (row.postingIntentJson != null || row.postingIntentHash != null) {
    const intent = verifyPostingIntentEvidence({
      expectedEntryType: row.entryType,
      postingProfile: row.postingProfile,
      postingIntentJson: row.postingIntentJson,
      postingIntentHash: row.postingIntentHash,
      source: { amount: row.amount },
    });
    let expense = money(0);
    let revenue = money(0);
    for (const line of intent.lines) {
      if (EXPENSE_ROLES.has(line.role))
        expense = expense.plus(money(line.debit).minus(line.credit));
      if (REVENUE_ROLES.has(line.role))
        revenue = revenue.plus(money(line.credit).minus(line.debit));
    }
    return { expense: toDbMoney(expense), revenue: toDbMoney(revenue) };
  }
  // A free voucher is the only legacy source for which its category selects the counter-account.
  // Anonymous return/drawer receipts and system payments must never become expenses via OTHER.
  if (
    row.partyType !== "OTHER" ||
    !row.voucherNumber ||
    row.workOrderId != null ||
    hasSystemPaymentRequestEnvelope(row.internalNote)
  )
    return zero;
  const outward = row.entryType === "PAYMENT_OUT";
  const role =
    row.postingRole ??
    (row.invoiceId == null
      ? outward
        ? "OTHER_EXPENSE"
        : "OTHER_REVENUE"
      : "");
  return {
    expense: EXPENSE_ROLES.has(role)
      ? toDbMoney(money(row.amount).times(outward ? 1 : -1))
      : "0.00",
    revenue: REVENUE_ROLES.has(role)
      ? toDbMoney(money(row.amount).times(outward ? -1 : 1))
      : "0.00",
  };
}

export async function readLegacyVoucherActivity(
  db: DB,
  from: string,
  to: string,
  branchId?: number,
) {
  const selection = sql`
    SELECT ae.receiptId, ae.entryType, CAST(ae.amount AS CHAR) AS amount,
      ae.postingProfile, ae.postingIntentJson, ae.postingIntentHash,
      r.voucherPartyType AS partyType, r.invoiceId, r.workOrderId, r.voucherNumber,
      vc.name AS category, vc.postingRole, r.referenceNumber, r.internalNote,
      EXISTS(SELECT 1 FROM expenses e WHERE e.receiptId = r.id) AS representedExpense,
      EXISTS(SELECT 1 FROM accountingEntries ret WHERE ret.receiptId = r.id
        AND ret.entryType = 'RETURN' AND ret.supplierId IS NULL) AS returnSettlement,
      EXISTS(SELECT 1 FROM accrualObligationEvents aoe WHERE aoe.receiptId = r.id
        AND aoe.eventType IN ('PAYMENT_SETTLED','SETTLEMENT_REVERSED')) AS accrualSettlement
    FROM accountingEntries ae
    INNER JOIN receipts r ON r.id = ae.receiptId
    LEFT JOIN voucherCategories vc ON vc.id = r.voucherCategoryId
    WHERE ae.entryType IN ('PAYMENT_IN','PAYMENT_OUT')
      AND (r.voucherPartyType = 'OTHER' OR ae.postingProfile IN (
        'PAYMENT_OUT_EXPENSE','PAYMENT_OUT_OTHER','PAYMENT_IN_OTHER',
        'PAYMENT_OUT_CATEGORY','PAYMENT_IN_CATEGORY','PAYMENT_OUT_CATEGORY_REVERSAL','PAYMENT_IN_CATEGORY_REVERSAL'
      ))
      AND r.receiptStatus IN ('COMPLETED','REVERSED') AND r.receiptApprovalStatus = 'APPROVED'
      AND (ae.dedupeKey IS NULL OR ae.dedupeKey NOT LIKE 'FULFILLMENT_CHARGE_%')`;
  const rows = rowsOf(
    await db.execute(sql`${selection}
    AND ae.entryDate >= ${from} AND ae.entryDate <= ${to}
    ${branchId ? sql`AND ae.branchId = ${branchId}` : sql``}`),
  );
  const originalIds = Array.from(
    new Set(
      rows
        .map(cancellationOf)
        .filter((request) => request != null)
        .map((request) => request.originalReceiptId),
    ),
  );
  const originals = originalIds.length
    ? rowsOf(
        await db.execute(sql`${selection}
    AND r.id IN (${sql.join(
      originalIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    ${branchId ? sql`AND ae.branchId = ${branchId}` : sql``}`),
      )
    : [];
  const byReceipt = new Map(
    originals.map((row) => [Number(row.receiptId), row]),
  );
  const expenseLines = new Map<string, ReturnType<typeof money>>();
  let revenue = money(0);
  for (const row of rows) {
    const cancellation = cancellationOf(row);
    const original = cancellation
      ? byReceipt.get(cancellation.originalReceiptId)
      : undefined;
    if (
      original &&
      (original.representedExpense ||
        original.returnSettlement ||
        original.accrualSettlement)
    )
      continue;
    let effect = voucherFinancialEffect(row);
    if (
      cancellation &&
      row.postingIntentJson == null &&
      row.postingIntentHash == null
    ) {
      if (
        !original ||
        !money(original.amount).equals(row.amount) ||
        original.entryType === row.entryType
      )
        continue;
      const source = voucherFinancialEffect(original);
      effect = {
        expense: toDbMoney(money(source.expense).neg()),
        revenue: toDbMoney(money(source.revenue).neg()),
      };
    }
    revenue = revenue.plus(effect.revenue);
    const amount = money(effect.expense);
    if (amount.isZero()) continue;
    const label = original?.category ?? row.category ?? "مصروفات سندات متنوعة";
    expenseLines.set(label, (expenseLines.get(label) ?? money(0)).plus(amount));
  }
  return {
    revenue: toDbMoney(revenue),
    expenseLines: Array.from(expenseLines.entries())
      .filter(([, amount]) => !amount.isZero())
      .map(([category, amount]) => ({ category, amount: toDbMoney(amount) })),
  };
}
