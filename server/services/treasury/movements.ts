// آخر حركات نقدية موحَّدة (receipts + expenses) — للسجلّ.
import { sql } from "drizzle-orm";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { MATERIALIZED_RECEIPT_STATUS_SQL } from "../cash/cashAvailability";
import { PAY_METHOD_AR, isCashier, rowsOf } from "./helpers";

export interface MovementRow {
  id: string; // r:NN أو e:NN
  rawId: number;
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
  status: string | null;
  approvalStatus: string | null;
  approvedAt: string | null;
  shiftId: number | null;
  shiftOwnerId: number | null;
  shiftOwnerName: string | null;
  createdBy: number | null;
  createdByName: string | null;
  partyType: string | null;
  partyId: number | null;
  partyName: string | null;
  approvedBy: number | null;
  approvedByName: string | null;
  referenceNumber: string | null;
  invoiceId: number | null;
  workOrderId: number | null;
  reservationId: number | null;
  expenseId: number | null;
  expensePayee: string | null;
  expenseCategory: string | null;
  costCenter: string | null;
  ledgerEntryId: number | null;
  documentDate: string | null;
  integrityWarnings: string[];
  createdAt: string;
}

export async function getRecentMovements(
  input: {
    branchId?: number;
    limit?: number;
    from?: string;
    to?: string;
    offset?: number;
  },
  scope: { scopedBranchId: number | null; role: string; userId?: number },
): Promise<MovementRow[]> {
  const db = getDb();
  if (!db) return [];

  const effectiveBranch = scope.scopedBranchId ?? input.branchId ?? null;
  // الحدّ ١٠١ لا ١٠٠: الراوتر يطلب limit+1 داخلياً لاكتشاف hasMore (سقفه الظاهر للعميل ١٠٠) —
  // لولا هامش الواحد لَسقط طلبٌ بـlimit=100 صامتاً إلى الافتراضي ٢٠ عند تجاوزه هذا الحدّ.
  const limit =
    input.limit && input.limit > 0 && input.limit <= 101 ? input.limit : 20;
  const offset =
    input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
  const branchFilterR =
    effectiveBranch != null ? sql`AND r.branchId = ${effectiveBranch}` : sql``;
  const branchFilterE =
    effectiveBranch != null ? sql`AND e.branchId = ${effectiveBranch}` : sql``;
  // مدى تاريخ اختياري (createdAt) — to شامل ليومه كاملاً (نمط getCardMovements: < بداية اليوم التالي).
  const fromFilterR = input.from
    ? sql`AND r.createdAt >= ${input.from}`
    : sql``;
  const toFilterR = input.to
    ? sql`AND r.createdAt < DATE_ADD(${input.to}, INTERVAL 1 DAY)`
    : sql``;
  const fromFilterE = input.from
    ? sql`AND e.createdAt >= ${input.from}`
    : sql``;
  const toFilterE = input.to
    ? sql`AND e.createdAt < DATE_ADD(${input.to}, INTERVAL 1 DAY)`
    : sql``;
  // الكاشير لا يَرى TREASURY مطلقاً (IDOR + إخفاء معلومات إدارية).
  // ⚠️ أسماء أعمدة DB الخام: receipts.cashBucket / expenses.expenseCashBucket / expenses.expensePaymentMethod.
  const bucketFilterR = isCashier(scope.role)
    ? sql`AND (r.cashBucket = 'DRAWER' OR r.cashBucket IS NULL)`
    : sql``;
  const bucketFilterE = isCashier(scope.role)
    ? sql`AND (e.expenseCashBucket = 'DRAWER' OR e.expenseCashBucket IS NULL)`
    : sql``;
  // عزل درج الكاشير (تدقيق ١٧/٧): كان الكاشير يرى حركات دروج زملائه في الفرع نفسه (مبالغ + أرقام
  // سندات + مصروفات لم يُنشئها). درجُه = ورديّاتُه ⇒ نقصره على حركات ورديّةٍ يملكها هو (shiftId).
  const isolateCashier = isCashier(scope.role) && scope.userId != null;
  const ownShiftR = isolateCashier
    ? sql`AND r.shiftId IN (SELECT s.id FROM shifts s WHERE s.userId = ${scope.userId})`
    : sql``;
  const ownShiftE = isolateCashier
    ? sql`AND e.shiftId IN (SELECT s.id FROM shifts s WHERE s.userId = ${scope.userId})`
    : sql``;

  const rows = rowsOf(
    await db.execute(sql`
      (
        SELECT
          CONCAT('r:', r.id) AS id,
          r.id AS rawId,
          'RECEIPT' AS source,
          r.direction AS direction,
          CAST(r.amount AS CHAR) AS amount,
          r.paymentMethod AS paymentMethod,
          r.cashBucket AS cashBucket,
          r.branchId AS branchId,
          b.name AS branchName,
          COALESCE(ex.description, r.description) AS description,
          r.voucherNumber AS voucherNumber,
          r.receiptStatus AS status,
          r.receiptApprovalStatus AS approvalStatus,
          r.approvedAt AS approvedAt,
          r.shiftId AS shiftId,
          s.userId AS shiftOwnerId,
          su.name AS shiftOwnerName,
          r.createdBy AS createdBy,
          cu.name AS createdByName,
          r.voucherPartyType AS partyType,
          r.partyId AS partyId,
          CASE
            WHEN r.voucherPartyType = 'CUSTOMER' THEN cust.name
            WHEN r.voucherPartyType = 'SUPPLIER' THEN supp.name
            ELSE r.counterpartyName
          END AS partyName,
          r.approvedBy AS approvedBy,
          au.name AS approvedByName,
          COALESCE(ex.referenceNumber, r.referenceNumber) AS referenceNumber,
          r.invoiceId AS invoiceId,
          r.workOrderId AS workOrderId,
          r.reservationId AS reservationId,
          ex.id AS expenseId,
          ex.payee AS expensePayee,
          ex.expenseCategory AS expenseCategory,
          ex.costCenter AS costCenter,
          (SELECT ae.id FROM accountingEntries ae WHERE ae.receiptId = r.id ORDER BY ae.id DESC LIMIT 1) AS ledgerEntryId,
          COALESCE(ex.expenseDate, r.voucherDate, DATE(r.createdAt)) AS documentDate,
          r.createdAt AS createdAt
        FROM receipts r
        LEFT JOIN branches b ON b.id = r.branchId
        LEFT JOIN expenses ex ON ex.receiptId = r.id
        LEFT JOIN users cu ON cu.id = r.createdBy
        LEFT JOIN customers cust ON r.voucherPartyType = 'CUSTOMER' AND cust.id = r.partyId
        LEFT JOIN suppliers supp ON r.voucherPartyType = 'SUPPLIER' AND supp.id = r.partyId
        LEFT JOIN users au ON au.id = r.approvedBy
        LEFT JOIN shifts s ON s.id = r.shiftId
        LEFT JOIN users su ON su.id = s.userId
        WHERE r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
          AND r.receiptApprovalStatus = 'APPROVED'
          ${branchFilterR}
          ${fromFilterR}
          ${toFilterR}
          ${bucketFilterR}
          ${ownShiftR}
      )
      UNION ALL
      (
        SELECT
          CONCAT('e:', e.id) AS id,
          e.id AS rawId,
          'EXPENSE' AS source,
          'OUT' AS direction,
          CAST(e.amount AS CHAR) AS amount,
          e.expensePaymentMethod AS paymentMethod,
          e.expenseCashBucket AS cashBucket,
          e.branchId AS branchId,
          b.name AS branchName,
          e.description AS description,
          NULL AS voucherNumber,
          e.expenseStatus AS status,
          NULL AS approvalStatus,
          NULL AS approvedAt,
          e.shiftId AS shiftId,
          s.userId AS shiftOwnerId,
          su.name AS shiftOwnerName,
          e.createdBy AS createdBy,
          cu.name AS createdByName,
          'OTHER' AS partyType,
          NULL AS partyId,
          e.payee AS partyName,
          NULL AS approvedBy,
          NULL AS approvedByName,
          e.referenceNumber AS referenceNumber,
          NULL AS invoiceId,
          NULL AS workOrderId,
          NULL AS reservationId,
          e.id AS expenseId,
          e.payee AS expensePayee,
          e.expenseCategory AS expenseCategory,
          e.costCenter AS costCenter,
          (SELECT ae.id FROM accountingEntries ae WHERE ae.dedupeKey = CONCAT(e.expenseStockReason, ':', e.id) ORDER BY ae.id DESC LIMIT 1) AS ledgerEntryId,
          e.expenseDate AS documentDate,
          e.createdAt AS createdAt
        FROM expenses e
        LEFT JOIN branches b ON b.id = e.branchId
        LEFT JOIN users cu ON cu.id = e.createdBy
        LEFT JOIN shifts s ON s.id = e.shiftId
        LEFT JOIN users su ON su.id = s.userId
        WHERE e.expenseStatus = 'ACTIVE'
          -- Cash expenses already appear through their linked receipt above.
          -- Keep only non-cash/stock expenses that have no receipt.
          AND e.receiptId IS NULL
          ${branchFilterE}
          ${fromFilterE}
          ${toFilterE}
          ${bucketFilterE}
          ${ownShiftE}
      )
      ORDER BY createdAt DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  );

  return rows.map((r) => {
    const cashBucket =
      r.cashBucket === "TREASURY"
        ? "TREASURY"
        : r.cashBucket === "DRAWER"
          ? "DRAWER"
          : null;
    const paymentMethod = String(r.paymentMethod ?? "");
    const shiftId = r.shiftId == null ? null : Number(r.shiftId);
    const warnings: string[] = [];
    if (!String(r.description ?? "").trim())
      warnings.push("DESCRIPTION_MISSING");
    if (r.source === "RECEIPT" && r.createdBy == null)
      warnings.push("ACTOR_MISSING");
    if (paymentMethod === "CASH" && cashBucket == null)
      warnings.push("CASH_SOURCE_MISSING");
    if (cashBucket === "DRAWER" && shiftId == null)
      warnings.push("DRAWER_WITHOUT_SHIFT");
    if (cashBucket === "TREASURY" && shiftId != null)
      warnings.push("TREASURY_WITH_SHIFT");
    if (r.source === "RECEIPT" && r.ledgerEntryId == null)
      warnings.push("LEDGER_ENTRY_MISSING");

    const asIso = (value: unknown) =>
      value == null
        ? null
        : value instanceof Date
          ? value.toISOString()
          : String(value);
    const asId = (value: unknown) => (value == null ? null : Number(value));

    return {
      id: String(r.id),
      rawId: Number(r.rawId),
      source: r.source === "EXPENSE" ? "EXPENSE" : "RECEIPT",
      direction: r.direction === "OUT" ? "OUT" : "IN",
      amount: toDbMoney(money(r.amount ?? 0)),
      paymentMethod,
      paymentMethodLabel: PAY_METHOD_AR[paymentMethod] ?? paymentMethod,
      cashBucket,
      branchId: asId(r.branchId),
      branchName: r.branchName == null ? null : String(r.branchName),
      description: r.description == null ? null : String(r.description),
      voucherNumber: r.voucherNumber == null ? null : String(r.voucherNumber),
      status: r.status == null ? null : String(r.status),
      approvalStatus:
        r.approvalStatus == null ? null : String(r.approvalStatus),
      approvedAt: asIso(r.approvedAt),
      shiftId,
      shiftOwnerId: asId(r.shiftOwnerId),
      shiftOwnerName:
        r.shiftOwnerName == null ? null : String(r.shiftOwnerName),
      createdBy: asId(r.createdBy),
      createdByName: r.createdByName == null ? null : String(r.createdByName),
      partyType: r.partyType == null ? null : String(r.partyType),
      partyId: asId(r.partyId),
      partyName: r.partyName == null ? null : String(r.partyName),
      approvedBy: asId(r.approvedBy),
      approvedByName:
        r.approvedByName == null ? null : String(r.approvedByName),
      referenceNumber:
        r.referenceNumber == null ? null : String(r.referenceNumber),
      invoiceId: asId(r.invoiceId),
      workOrderId: asId(r.workOrderId),
      reservationId: asId(r.reservationId),
      expenseId: asId(r.expenseId),
      expensePayee: r.expensePayee == null ? null : String(r.expensePayee),
      expenseCategory:
        r.expenseCategory == null ? null : String(r.expenseCategory),
      costCenter: r.costCenter == null ? null : String(r.costCenter),
      ledgerEntryId: asId(r.ledgerEntryId),
      documentDate: asIso(r.documentDate),
      integrityWarnings: warnings,
      createdAt: asIso(r.createdAt) ?? "",
    };
  });
}
