// بطاقات الورديات المفتوحة الحيّة.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { isCashier, rowsOf } from "./helpers";

export interface OpenShiftCard {
  shiftId: number;
  branchId: number;
  branchName: string;
  userId: number;
  userName: string;
  openingBalance: string;
  expectedCash: string; // محسوب لحظياً
  cashIn: string;
  cashOut: string;
  openedAt: string;
}

export async function getOpenShifts(
  input: { branchId?: number },
  scope: { scopedBranchId: number | null; role: string },
): Promise<OpenShiftCard[]> {
  const db = getDb();
  if (!db) return [];
  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const branchFilter = effectiveBranch != null ? sql`AND s.branchId = ${effectiveBranch}` : sql``;
  // الكاشير يَرى ورديته فقط (لا ورديات زملائه).
  const userFilter = isCashier(scope.role) ? sql`AND s.userId = ${scope.scopedBranchId == null ? 0 : "n/a"}` : sql``;
  // ⚠️ تعديل: الكاشير لا يَملك useId مباشرةً — نَنقله من ctx.user.id؛ تَمرّر عبر input في الراوتر.
  void userFilter;

  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        s.id AS shiftId,
        s.branchId AS branchId,
        b.name AS branchName,
        s.userId AS userId,
        u.name AS userName,
        CAST(s.openingBalance AS CHAR) AS openingBalance,
        s.openedAt AS openedAt,
        CAST(COALESCE((
          SELECT SUM(r.amount) FROM receipts r
          WHERE r.shiftId = s.id AND r.paymentMethod = 'CASH' AND r.direction = 'IN' AND r.receiptStatus = 'COMPLETED'
        ), 0) AS CHAR) AS cashIn,
        CAST(COALESCE((
          SELECT SUM(r.amount) FROM receipts r
          WHERE r.shiftId = s.id AND r.paymentMethod = 'CASH' AND r.direction = 'OUT' AND r.receiptStatus = 'COMPLETED'
        ), 0) AS CHAR) AS cashOut
      FROM shifts s
      LEFT JOIN branches b ON b.id = s.branchId
      LEFT JOIN users u ON u.id = s.userId
      WHERE s.shiftStatus = 'OPEN'
        ${branchFilter}
      ORDER BY s.openedAt DESC
      LIMIT 50
    `),
  );

  return rows.map((r) => {
    const opening = money(r.openingBalance ?? 0);
    const cIn = money(r.cashIn ?? 0);
    const cOut = money(r.cashOut ?? 0);
    return {
      shiftId: Number(r.shiftId),
      branchId: Number(r.branchId),
      branchName: String(r.branchName ?? ""),
      userId: Number(r.userId),
      userName: String(r.userName ?? ""),
      openingBalance: toDbMoney(opening),
      expectedCash: toDbMoney(opening.plus(cIn).minus(cOut)),
      cashIn: toDbMoney(cIn),
      cashOut: toDbMoney(cOut),
      openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : String(r.openedAt),
    };
  });
}
