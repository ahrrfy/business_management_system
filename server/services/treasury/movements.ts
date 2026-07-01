// آخر حركات نقدية موحَّدة (receipts + expenses) — للسجلّ.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { PAY_METHOD_AR, isCashier, rowsOf } from "./helpers";

export interface MovementRow {
  id: string; // r:NN أو e:NN
  source: "RECEIPT" | "EXPENSE";
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  branchId: number | null;
  branchName: string | null;
  description: string | null;
  voucherNumber: string | null;
  createdAt: string;
}

export async function getRecentMovements(
  input: { branchId?: number; limit?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<MovementRow[]> {
  const db = getDb();
  if (!db) return [];

  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const limit = input.limit && input.limit > 0 && input.limit <= 100 ? input.limit : 20;
  const branchFilterR = effectiveBranch != null ? sql`AND r.branchId = ${effectiveBranch}` : sql``;
  const branchFilterE = effectiveBranch != null ? sql`AND e.branchId = ${effectiveBranch}` : sql``;
  // الكاشير لا يَرى TREASURY مطلقاً (IDOR + إخفاء معلومات إدارية).
  // ⚠️ أسماء أعمدة DB الخام: receipts.cashBucket / expenses.expenseCashBucket / expenses.expensePaymentMethod.
  const bucketFilterR = isCashier(scope.role) ? sql`AND (r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL)` : sql``;
  const bucketFilterE = isCashier(scope.role) ? sql`AND (e.expenseCashBucket = 'DRAWER' OR e.expenseCashBucket IS NULL)` : sql``;

  const rows = rowsOf(
    await db.execute(sql`
      (
        SELECT
          CONCAT('r:', r.id) AS id,
          'RECEIPT' AS source,
          r.direction AS direction,
          CAST(r.amount AS CHAR) AS amount,
          r.paymentMethod AS paymentMethod,
          r.cashBucket AS cashBucket,
          r.branchId AS branchId,
          b.name AS branchName,
          r.description AS description,
          r.voucherNumber AS voucherNumber,
          r.createdAt AS createdAt
        FROM receipts r
        LEFT JOIN branches b ON b.id = r.branchId
        WHERE r.receiptStatus = 'COMPLETED'
          ${branchFilterR}
          ${bucketFilterR}
      )
      UNION ALL
      (
        SELECT
          CONCAT('e:', e.id) AS id,
          'EXPENSE' AS source,
          'OUT' AS direction,
          CAST(e.amount AS CHAR) AS amount,
          e.expensePaymentMethod AS paymentMethod,
          e.expenseCashBucket AS cashBucket,
          e.branchId AS branchId,
          b.name AS branchName,
          CONCAT('مصروف — ', e.expenseCategory) AS description,
          NULL AS voucherNumber,
          e.createdAt AS createdAt
        FROM expenses e
        LEFT JOIN branches b ON b.id = e.branchId
        WHERE e.expenseStatus = 'ACTIVE'
          ${branchFilterE}
          ${bucketFilterE}
      )
      ORDER BY createdAt DESC
      LIMIT ${limit}
    `),
  );

  return rows.map((r) => ({
    id: String(r.id),
    source: r.source === "EXPENSE" ? "EXPENSE" : "RECEIPT",
    direction: r.direction === "OUT" ? "OUT" : "IN",
    amount: toDbMoney(money(r.amount ?? 0)),
    paymentMethod: String(r.paymentMethod ?? ""),
    paymentMethodLabel: PAY_METHOD_AR[String(r.paymentMethod ?? "")] ?? String(r.paymentMethod ?? ""),
    cashBucket: r.cashBucket === "TREASURY" ? "TREASURY" : r.cashBucket === "DRAWER" ? "DRAWER" : null,
    branchId: r.branchId == null ? null : Number(r.branchId),
    branchName: r.branchName == null ? null : String(r.branchName),
    description: r.description == null ? null : String(r.description),
    voucherNumber: r.voucherNumber == null ? null : String(r.voucherNumber),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}
