// لوحة الخزينة الرئيسية: رصيد الدرج لكل فرع (ورديات مفتوحة) + رصيد الخزينة (مكتوم عن الكاشير)
// + عدّادات اليوم. ⚠️ scopedBranchId (IDOR): الكاشير يرى درجه فقط بلا TREASURY.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { MATERIALIZED_RECEIPT_STATUS_SQL } from "../cash/cashAvailability";
import { isCashier, rowsOf } from "./helpers";

export interface DrawerBalanceRow {
  branchId: number;
  branchName: string;
  openShiftsCount: number;
  expectedCash: string; // openingBalance + cashIn - cashOut (مجموع الورديات المفتوحة)
  totalOpening: string;
}

export interface TreasuryBalanceRow {
  branchId: number;
  branchName: string;
  balance: string; // SUM(IN - OUT) لـcashBucket=TREASURY (تراكمي)
}

export interface DashboardOutput {
  drawerBalances: DrawerBalanceRow[];
  treasuryBalances: TreasuryBalanceRow[];
  openShiftsCount: number;
  todayReceiptsTotal: string; // مجموع receipts IN اليوم (كل طرق الدفع)
  todayExpensesTotal: string; // مجموع expenses الفعّالة اليوم
  // pendingIncomingTransfers يَظهر في المرحلة ٢ — حالياً 0 ثابت.
  pendingIncomingTransfers: number;
  // علم بصري: هل يجب إخفاء TREASURY في الواجهة (الكاشير).
  hideTreasury: boolean;
  generatedAt: string; // ISO timestamp للـ"آخر تحديث".
}

export async function getDashboard(
  input: { branchId?: number },
  scope: { scopedBranchId: number | null; role: string; userId: number },
): Promise<DashboardOutput> {
  const db = getDb();
  const base: DashboardOutput = {
    drawerBalances: [],
    treasuryBalances: [],
    openShiftsCount: 0,
    todayReceiptsTotal: "0",
    todayExpensesTotal: "0",
    pendingIncomingTransfers: 0,
    hideTreasury: isCashier(scope.role),
    generatedAt: new Date().toISOString(),
  };
  if (!db) return base;

  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  const branchFilter = effectiveBranch != null ? sql`AND b.id = ${effectiveBranch}` : sql``;

  // DRAWER-ISOLATION (تدقيق ٢/٧): الكاشير يصل الداشبورد (branchScopedProcedure) وكان يرى مجموع أدراج
  // كل زملائه في فرعه لحظياً. الآن نقصر تجميع الأدراج على ورديته هو (userId) — المدير/الأدمن يرون الكل.
  const cashierOwn = isCashier(scope.role);
  const drawerUserJoin = cashierOwn ? sql`AND s.userId = ${scope.userId}` : sql``;
  const drawerUserSub = cashierOwn ? sql`AND s2.userId = ${scope.userId}` : sql``;

  // ── (أ) DRAWER لكل فرع: مجموع الورديات المفتوحة (opening + cashIn − cashOut) ──
  const drawerRows = rowsOf(
    await db.execute(sql`
      SELECT
        b.id AS branchId,
        b.name AS branchName,
        COUNT(DISTINCT s.id) AS openShiftsCount,
        CAST(COALESCE(SUM(s.openingBalance), 0) AS CHAR) AS totalOpening,
        CAST(COALESCE((
          SELECT SUM(r.amount)
          FROM receipts r
          WHERE r.cashBucket = 'DRAWER'
            AND r.receiptApprovalStatus = 'APPROVED'
            AND r.direction = 'IN'
            AND r.shiftId IN (
              SELECT s2.id FROM shifts s2
              WHERE s2.branchId = b.id AND s2.shiftStatus = 'OPEN' ${drawerUserSub}
            )
        ), 0) AS CHAR) AS cashIn,
        CAST(COALESCE((
          SELECT SUM(r.amount)
          FROM receipts r
          WHERE r.cashBucket = 'DRAWER'
            AND r.receiptApprovalStatus = 'APPROVED'
            AND r.direction = 'OUT'
            AND r.shiftId IN (
              SELECT s2.id FROM shifts s2
              WHERE s2.branchId = b.id AND s2.shiftStatus = 'OPEN' ${drawerUserSub}
            )
        ), 0) AS CHAR) AS cashOut
      FROM branches b
      LEFT JOIN shifts s ON s.branchId = b.id AND s.shiftStatus = 'OPEN' ${drawerUserJoin}
      WHERE b.isActive = TRUE
        ${branchFilter}
      GROUP BY b.id, b.name
      ORDER BY b.id ASC
    `),
  );

  const drawerBalances: DrawerBalanceRow[] = drawerRows.map((r) => {
    const opening = money(r.totalOpening ?? 0);
    const cIn = money(r.cashIn ?? 0);
    const cOut = money(r.cashOut ?? 0);
    return {
      branchId: Number(r.branchId),
      branchName: String(r.branchName ?? ""),
      openShiftsCount: Number(r.openShiftsCount ?? 0),
      totalOpening: toDbMoney(opening),
      expectedCash: toDbMoney(opening.plus(cIn).minus(cOut)),
    };
  });

  // ── (ب) TREASURY لكل فرع — مكتوم للكاشير ──
  let treasuryBalances: TreasuryBalanceRow[] = [];
  if (!isCashier(scope.role)) {
    const treasuryRows = rowsOf(
      await db.execute(sql`
        SELECT
          b.id AS branchId,
          b.name AS branchName,
          CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END), 0) AS CHAR) AS balance
        FROM branches b
        LEFT JOIN receipts r ON r.branchId = b.id
          AND r.cashBucket = 'TREASURY'
          AND r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
          AND r.receiptApprovalStatus = 'APPROVED'
        WHERE b.isActive = TRUE
          ${branchFilter}
        GROUP BY b.id, b.name
        ORDER BY b.id ASC
      `),
    );
    treasuryBalances = treasuryRows.map((r) => ({
      branchId: Number(r.branchId),
      branchName: String(r.branchName ?? ""),
      balance: toDbMoney(money(r.balance ?? 0)),
    }));
  }

  // ── (ج) عدد الورديات المفتوحة (مجموع كل الفروع المرئيّة) ──
  const openShiftsCount = drawerBalances.reduce((sum, r) => sum + r.openShiftsCount, 0);

  // ── (د) مقبوضات/مصروفات اليوم (مجموع كل طرق الدفع) ──
  const branchFilterRaw = effectiveBranch != null ? sql`AND branchId = ${effectiveBranch}` : sql``;
  // العهدة الوسيطة (imprest): استبعاد إيصالات الحركة الداخلية من «مقبوضات اليوم» — CH- (تسليم/إرجاع
  // درج→خزينة)، CD- (سحب)، SF-/STF- (عهدة خزينة→درج)، CT- (تحويل بين فروع)، TF- (تمويل رأس مال)،
  // CANCEL-CT- (إلغاء تحويل). CANCEL-VCH/EXP تعويض خارجي يجب ألّا يُخفى. ليست الحركة الداخلية قبضاً؛
  // ثم إرجاع TREASURY IN) كل إغلاق. أرصدة الدرج/الخزينة تبقى صحيحة (تُحسب من استعلاماتها الخاصّة).
  const todayReceipts = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS total
      FROM receipts
      WHERE direction = 'IN'
        AND receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
        AND receiptApprovalStatus = 'APPROVED'
        AND DATE(createdAt) = CURDATE()
        AND COALESCE(referenceNumber, '') NOT REGEXP '^(CH|CD|SF|CT|TF)-|^CANCEL-CT-'
        AND NOT (
          COALESCE(receipts.referenceNumber, '') LIKE 'STF-%'
          AND EXISTS (
            SELECT 1
            FROM accountingEntries sfEntry
            INNER JOIN receipts sfRequest ON sfRequest.id = sfEntry.receiptId
            WHERE sfEntry.entryType = 'SHIFT_FLOAT_OUT'
              AND sfRequest.referenceNumber = receipts.referenceNumber
              AND sfRequest.branchId = receipts.branchId
              AND sfRequest.direction = 'OUT'
              AND sfRequest.cashBucket = 'TREASURY'
              AND sfRequest.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
              AND sfRequest.receiptApprovalStatus = 'APPROVED'
              AND (
                receipts.id = sfRequest.id
                OR (
                  receipts.direction = 'IN'
                  AND receipts.cashBucket = 'DRAWER'
                  AND receipts.signatureHash IS NOT NULL
                  AND receipts.signatureHash = sfRequest.signatureHash
                  AND receipts.internalNote = sfRequest.internalNote
                )
              )
          )
        )
        ${branchFilterRaw}
    `),
  );
  const todayExpenses = rowsOf(
    await db.execute(sql`
      SELECT CAST(COALESCE(SUM(amount), 0) AS CHAR) AS total
      FROM expenses
      WHERE expenseStatus = 'ACTIVE'
        AND expenseDate = CURDATE()
        ${branchFilterRaw}
    `),
  );

  // تحويلات واردة «بالطريق» للفرع (تدقيق ١٧/٧: كان صفراً ثابتاً رغم اكتمال وحدة التحويلات ⇒ المدير
  // المستلِم لا يرى تنبيهاً بنقدٍ/بضاعةٍ في الطريق إليه). العمود transferStatus (mysqlEnum) + فهرس
  // idx_transfer_to_status. admin بلا فرع يرى الكل بالطريق.
  const pendingTransfers = rowsOf(
    await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM stockTransfers
      WHERE transferStatus = 'IN_TRANSIT'
        ${effectiveBranch != null ? sql`AND toBranchId = ${effectiveBranch}` : sql``}
    `),
  );

  return {
    drawerBalances,
    treasuryBalances,
    openShiftsCount,
    todayReceiptsTotal: toDbMoney(money(todayReceipts[0]?.total ?? 0)),
    todayExpensesTotal: toDbMoney(money(todayExpenses[0]?.total ?? 0)),
    pendingIncomingTransfers: Number(pendingTransfers[0]?.cnt ?? 0),
    hideTreasury: isCashier(scope.role),
    generatedAt: new Date().toISOString(),
  };
}
