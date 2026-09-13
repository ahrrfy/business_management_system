// خدمة تقارير الخزينة والمصروفات (للقراءة فقط) — تُغذّي مركز التقارير.
// المصادر (لا تخمين):
//  • المقبوضات/المدفوعات: جدول receipts المكتمل (receiptStatus='COMPLETED') — أساس نقدي.
//  • فروقات الورديات: جدول shifts في الفترة (DATE(openedAt) BETWEEN).
//  • المصروفات: جدول expenses الفعّال (expenseStatus='ACTIVE') مصنّفاً + أكبر جهات الصرف.
// ⚠️ أسماء أعمدة DB الخام: receipts.receiptStatus · expenses.expenseCategory/expenseStatus/expenseDate
//   · shifts.shiftStatus/variance/countedCash/openedAt. كل الأموال عبر decimal.js (money/toDbMoney).
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";
import { MATERIALIZED_RECEIPT_STATUS_SQL } from "./cash/cashAvailability";
import { receiptCashEventAtSql } from "./cash/cashEventAt";

/** فكّ نتيجة mysql2 (الصفوف في الفهرس 0). */
function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

// طلب maker-checker يتحقق نقدياً عند اعتماد شخصٍ آخر؛ الحركة الفورية تبقى بتاريخ إنشائها.
const RECEIPT_CASH_EVENT_AT_SQL = receiptCashEventAtSql("r");

const PAY_METHOD_AR: Record<string, string> = {
  CASH: "نقدي", CARD: "بطاقة", CHECK: "صك", TRANSFER: "تحويل", WALLET: "محفظة", TELECOM: "رصيد زين",
};

// تسمياتٌ خاصّة بهذا التقرير (تشرح السياق: «رواتب (مُسجَّلة كمصروف)» ≠ مسير الأجور).
// تسمية الواجهة العامة للدلو في shared/expenseCategories.ts — لا تُوحَّدا: هذه تحمل معنىً إضافياً.
const EXPENSE_CATEGORY_AR: Record<string, string> = {
  RENT: "الإيجار",
  UTILITIES: "الخدمات",
  SUPPLIES: "المستلزمات",
  SALARY: "رواتب",
  TRANSPORT: "النقل",
  MAINTENANCE: "الصيانة",
  MARKETING: "التسويق",
  OTHER: "أخرى",
};

/* ============================ ملخّص الخزينة ============================ */

export interface TreasuryMethodLine {
  key: string;
  label: string;
  in: string;
  out: string;
  /** صافي الحركة للطريقة نفسها؛ موجب = تحصيل أكثر من الصرف. */
  net: string;
  /** النقد وحده هو ما يُفترض وجوده فعلياً في درج الكاشير. */
  settlement: "DRAWER" | "NON_CASH";
}

export interface TreasuryShiftLine {
  id: number;
  branchName: string | null;
  cashierName: string | null;
  shiftType: string;
  status: "OPEN" | "CLOSED";
  openedAt: Date | string;
  closedAt: Date | string | null;
  openingBalance: string;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  reconciliationStatus: string | null;
}

export interface TreasurySummaryResult {
  period: { from: string; to: string };
  methods: TreasuryMethodLine[];
  totalIn: string;
  totalOut: string;
  net: string;
  shifts: {
    count: number;
    /** عدد الصفوف الظاهرة. يُحدّ التقرير التفصيلي لحماية صفحة التقرير. */
    shownCount: number;
    totalVariance: string;
    totalCounted: string;
    rows: TreasuryShiftLine[];
  };
}

export async function getTreasurySummary(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<TreasurySummaryResult> {
  const db = getDb();
  const base: TreasurySummaryResult = {
    period: { from: opts.from, to: opts.to },
    methods: [],
    totalIn: "0",
    totalOut: "0",
    net: "0",
    shifts: { count: 0, shownCount: 0, totalVariance: "0", totalCounted: "0", rows: [] },
  };
  if (!db) return base;

  // (أ) المقبوضات/المدفوعات المكتملة مجمّعةً حسب الاتّجاه × طريقة الدفع.
  const recRows = rowsOf(
    await db.execute(sql`
      SELECT r.direction AS direction, r.paymentMethod AS method,
             CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS amount
      FROM receipts r
      WHERE r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
        AND r.receiptApprovalStatus = 'APPROVED'
        AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) >= ${opts.from}
        AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) <= ${opts.to}
        -- العهدة الوسيطة: استبعاد الحركة الداخلية وإلغاء التحويل فقط؛ CANCEL-VCH/EXP أثر تعويضي خارجي.
        -- (نقلٌ بين الدلاء/الفروع أو رأس مال، لا قبض/صرف تشغيليّ ⇒ يمنع ازدواج نقد المبيعات).
        AND COALESCE(r.referenceNumber, '') NOT REGEXP '^(CH|CD|SF|CT|TF)-|^CANCEL-CT-'
        AND NOT (
          COALESCE(r.referenceNumber, '') LIKE 'STF-%'
          AND EXISTS (
            SELECT 1
            FROM accountingEntries sfEntry
            INNER JOIN receipts sfRequest ON sfRequest.id = sfEntry.receiptId
            WHERE sfEntry.entryType = 'SHIFT_FLOAT_OUT'
              AND sfRequest.referenceNumber = r.referenceNumber
              AND sfRequest.branchId = r.branchId
              AND sfRequest.direction = 'OUT'
              AND sfRequest.cashBucket = 'TREASURY'
              AND sfRequest.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
              AND sfRequest.receiptApprovalStatus = 'APPROVED'
              AND (
                r.id = sfRequest.id
                OR (
                  r.direction = 'IN'
                  AND r.cashBucket = 'DRAWER'
                  AND r.signatureHash IS NOT NULL
                  AND r.signatureHash = sfRequest.signatureHash
                  AND r.internalNote = sfRequest.internalNote
                )
              )
          )
        )
        ${opts.branchId ? sql`AND r.branchId = ${opts.branchId}` : sql``}
      GROUP BY r.direction, r.paymentMethod
    `),
  );

  // اجمع IN/OUT لكل طريقة في صفّ واحد. حافظ على ترتيب الظهور.
  const methodMap = new Map<string, { in: ReturnType<typeof money>; out: ReturnType<typeof money> }>();
  let totalIn = money(0);
  let totalOut = money(0);
  for (const r of recRows) {
    const key = String(r.method);
    const amt = money(r.amount ?? 0);
    if (!methodMap.has(key)) methodMap.set(key, { in: money(0), out: money(0) });
    const slot = methodMap.get(key)!;
    if (r.direction === "IN") { slot.in = slot.in.add(amt); totalIn = totalIn.add(amt); }
    else { slot.out = slot.out.add(amt); totalOut = totalOut.add(amt); }
  }

  const methods: TreasuryMethodLine[] = Array.from(methodMap.entries()).map(([key, v]) => ({
    key,
    label: PAY_METHOD_AR[key] ?? key,
    in: toDbMoney(v.in),
    out: toDbMoney(v.out),
    net: toDbMoney(v.in.minus(v.out)),
    // البطاقة والتحويل والمحفظة تحصيلات صحيحة، لكن لا تدخل درج الكاشير ولا يجوز
    // مطالبة الموظف بها عند الإغلاق. نُظهر هذا صراحةً في التقرير.
    settlement: key === "CASH" ? "DRAWER" : "NON_CASH",
  }));

  // (ب) فروقات الورديات في الفترة (حسب openedAt). variance/countedCash قد تكون NULL لوردية مفتوحة.
  const sh = rowsOf(
    await db.execute(sql`
      SELECT
        COUNT(*) AS cnt,
        CAST(COALESCE(SUM(s.variance), 0) AS CHAR) AS totalVariance,
        CAST(COALESCE(SUM(s.countedCash), 0) AS CHAR) AS totalCounted
      FROM shifts s
      WHERE DATE(s.openedAt) >= ${opts.from} AND DATE(s.openedAt) <= ${opts.to}
        ${opts.branchId ? sql`AND s.branchId = ${opts.branchId}` : sql``}
    `),
  )[0] ?? { cnt: 0, totalVariance: "0", totalCounted: "0" };

  // صفوف الورديات تجعل الرقم المجمّع قابلاً للمراجعة: من فتح الوردية، أي درجٍ أُغلق،
  // المتوقَّع النقدي فقط، المعدود، والفرق. لا نستخدم مدفوعات البطاقة هنا إطلاقاً.
  const shiftRows = rowsOf(
    await db.execute(sql`
      SELECT
        s.id AS id,
        b.name AS branchName,
        u.name AS cashierName,
        s.shiftType AS shiftType,
        s.shiftStatus AS status,
        s.openedAt AS openedAt,
        s.closedAt AS closedAt,
        CAST(s.openingBalance AS CHAR) AS openingBalance,
        CAST(s.expectedCash AS CHAR) AS expectedCash,
        CAST(s.countedCash AS CHAR) AS countedCash,
        CAST(s.variance AS CHAR) AS variance,
        s.reconciliationStatus AS reconciliationStatus
      FROM shifts s
      LEFT JOIN branches b ON b.id = s.branchId
      LEFT JOIN users u ON u.id = s.userId
      WHERE DATE(s.openedAt) >= ${opts.from} AND DATE(s.openedAt) <= ${opts.to}
        ${opts.branchId ? sql`AND s.branchId = ${opts.branchId}` : sql``}
      ORDER BY s.openedAt DESC, s.id DESC
      LIMIT 500
    `),
  ).map((r): TreasuryShiftLine => ({
    id: Number(r.id),
    branchName: r.branchName == null ? null : String(r.branchName),
    cashierName: r.cashierName == null ? null : String(r.cashierName),
    shiftType: String(r.shiftType ?? "RETAIL"),
    status: r.status === "CLOSED" ? "CLOSED" : "OPEN",
    openedAt: r.openedAt,
    closedAt: r.closedAt ?? null,
    openingBalance: toDbMoney(money(r.openingBalance ?? 0)),
    expectedCash: r.expectedCash == null ? null : toDbMoney(money(r.expectedCash)),
    countedCash: r.countedCash == null ? null : toDbMoney(money(r.countedCash)),
    variance: r.variance == null ? null : toDbMoney(money(r.variance)),
    reconciliationStatus: r.reconciliationStatus == null ? null : String(r.reconciliationStatus),
  }));

  return {
    period: { from: opts.from, to: opts.to },
    methods,
    totalIn: toDbMoney(totalIn),
    totalOut: toDbMoney(totalOut),
    net: toDbMoney(totalIn.sub(totalOut)),
    shifts: {
      count: Number(sh.cnt ?? 0),
      shownCount: shiftRows.length,
      totalVariance: toDbMoney(money(sh.totalVariance ?? 0)),
      totalCounted: toDbMoney(money(sh.totalCounted ?? 0)),
      rows: shiftRows,
    },
  };
}

/* ==================== كشف حركة الخزينة النقدية (رصيد جارٍ) ====================
 * كشفٌ زمنيّ يشرح **كل دينار** دخل الخزينة أو خرج منها، برصيدٍ جارٍ — كي لا يبقى رصيد
 * الخزينة رقماً غامضاً «يتراكم بلا سبب». الثابت الحاكم (money-trail §٥):
 *   الرصيد الختاميّ ≡ computeTreasuryCashBalance (cashAvailability.ts) عند نفس التاريخ.
 * نُحقّقه **بالبناء**: نفس شروط الرصيد القانونيّ حرفياً (TREASURY + CASH + COMPLETED/REVERSED +
 * APPROVED)، والافتتاحيّ = صافي ما قبل from، والختاميّ = الافتتاحيّ + الوارد − الصادر خلال الفترة.
 * فلا «رقمٌ ثانٍ ينجرف» عن اللوحة. REVERSED يظهر معلَّماً (يرافقه تعويضيٌّ معاكس ⇒ صفر أثر صافٍ).
 */

export interface TreasuryStatementMovement {
  receiptId: number;
  at: Date | string;
  direction: "IN" | "OUT";
  amount: string;
  reasonKey: string;
  reason: string;
  reference: string | null;
  voucherNumber: string | null;
  counterparty: string | null;
  description: string | null;
  branchName: string | null;
  /** منشئ الحركة (receipts.createdBy) — §٥: لكلّ دينارٍ فاعلٌ منسوبٌ يُظهره التقرير. */
  createdByName: string | null;
  /** معتمِد الحركة (receipts.approvedBy) — من أذن بالصرف/القبض (NULL إن لم يستلزم اعتماداً). */
  approvedByName: string | null;
  /** أصلٌ معكوس (يرافقه تعويضيٌّ معاكس فيصفر الأثر) — يُعلَّم كي لا يُقرأ خطأً حركةً حيّة. */
  reversed: boolean;
  /** الرصيد بعد هذه الحركة (الافتتاحيّ + صافي الحركات المعروضة حتى هنا). */
  runningBalance: string;
}

export interface TreasuryStatementResult {
  period: { from: string; to: string };
  /** رصيد الخزينة النقديّ قبل بداية الفترة (بدلالة computeTreasuryCashBalance). */
  openingBalance: string;
  totalIn: string;
  totalOut: string;
  /** الافتتاحيّ + الوارد − الصادر ≡ رصيد الخزينة النقديّ كما تعرضه اللوحة عند to. */
  closingBalance: string;
  /** إجمالي الحركات في الفترة (قد يتجاوز المعروض إن اقتُطع). */
  count: number;
  shownCount: number;
  truncated: boolean;
  movements: TreasuryStatementMovement[];
}

// شروط رصيد الخزينة النقديّ — مطابقة حرفيّة لـcomputeTreasuryCashBalance كي يساوي الرصيد
// الختاميّ للكشف رصيدَ الخزينة المعروض دائماً (شرح كل دينار، لا رقمٌ ثانٍ ينجرف).
const TREASURY_CASH_CONDS_SQL = sql`r.cashBucket = 'TREASURY' AND r.paymentMethod = 'CASH' AND r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL} AND r.receiptApprovalStatus = 'APPROVED'`;

/** سبب الحركة من بادئة المرجع/السند/المصروف — بلا تخمين (البوادئ يكتبها منشئوها). */
function treasuryMovementReason(row: {
  direction: "IN" | "OUT";
  referenceNumber: string | null;
  voucherNumber: string | null;
  expenseId: number | null;
  expenseCategory: string | null;
}): { key: string; label: string } {
  const ref = row.referenceNumber ?? "";
  if (/^CANCEL-CT-/.test(ref)) return { key: "CANCEL_TRANSFER", label: "عكس تحويل بين الفروع" };
  if (/^CANCEL-VCH-/.test(ref)) return { key: "CANCEL_VOUCHER", label: "عكس سند" };
  if (/^CANCEL-EXP-/.test(ref)) return { key: "CANCEL_EXPENSE", label: "عكس مصروف" };
  // STF- تمويل وردية إضافيّ من الخزينة (shiftFundingService.REFERENCE_PREFIX). يُفحَص قبل SF-
  // كي لا يُلتقط خطأً كعهدة افتتاح، ويُعطى تسميةً مميّزة بدل «سحب نقديّ» العامّ.
  if (/^STF-/.test(ref)) return { key: "SHIFT_FUNDING_EXTRA", label: "تمويل وردية إضافيّ" };
  if (/^SF-/.test(ref)) return { key: "SHIFT_FLOAT_OUT", label: "عهدة افتتاح وردية" };
  if (/^CH-/.test(ref)) return { key: "CASH_HANDOVER", label: "توريد إغلاق وردية" };
  if (/^CD-/.test(ref)) return { key: "CASH_DROP", label: "تسليم نقديّ من الدرج" };
  if (/^CT-/.test(ref)) return { key: "CASH_TRANSFER", label: row.direction === "IN" ? "تحويل وارد بين الفروع" : "تحويل صادر بين الفروع" };
  if (/^TF-/.test(ref)) return { key: "TREASURY_FUNDING", label: "تمويل الخزينة" };
  if (row.expenseId != null) {
    const cat = row.expenseCategory ? (EXPENSE_CATEGORY_AR[row.expenseCategory] ?? row.expenseCategory) : null;
    return { key: "EXPENSE", label: cat ? `مصروف — ${cat}` : "مصروف" };
  }
  if (row.voucherNumber != null) {
    return row.direction === "IN"
      ? { key: "VOUCHER_IN", label: "سند قبض" }
      : { key: "VOUCHER_OUT", label: "سند صرف" };
  }
  return { key: "OTHER", label: row.direction === "IN" ? "إيداع نقديّ" : "سحب نقديّ" };
}

export async function getTreasuryStatement(opts: {
  from: string;
  to: string;
  branchId?: number;
  limit?: number;
}): Promise<TreasuryStatementResult> {
  const db = getDb();
  const base: TreasuryStatementResult = {
    period: { from: opts.from, to: opts.to },
    openingBalance: "0",
    totalIn: "0",
    totalOut: "0",
    closingBalance: "0",
    count: 0,
    shownCount: 0,
    truncated: false,
    movements: [],
  };
  if (!db) return base;

  const limit = opts.limit && opts.limit > 0 && opts.limit <= 5000 ? opts.limit : 1000;
  const branchFilter = opts.branchId ? sql`AND r.branchId = ${opts.branchId}` : sql``;

  // لقطةٌ واحدةٌ متّسقة: القراءات الثلاث داخل معاملةٍ واحدة (REPEATABLE READ الافتراضيّة في
  // InnoDB) ⇒ يستحيل أن تُضاف حركةٌ معتمَدةٌ بين استعلام الإجماليّ واستعلام التفصيل فتظهر في
  // الصفوف والرصيد الجارٍ وتغيب عن count/الإجماليّات/closingBalance (تناقضٌ داخليّ — عين شكوى
  // «الأرقام المتناقضة»). الثلاثة تقرأ اللقطة نفسها.
  const snap = await db.transaction(async (tx) => {
    // (أ) الرصيد الافتتاحيّ = صافي حركات الخزينة النقديّة قبل from.
    const openRow = rowsOf(
      await tx.execute(sql`
        SELECT CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END), 0) AS CHAR) AS opening
        FROM receipts r
        WHERE ${TREASURY_CASH_CONDS_SQL}
          AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) < ${opts.from}
          ${branchFilter}
      `),
    )[0] ?? { opening: "0" };

    // (ب) إجماليّات الفترة كاملةً (بلا اعتماد على المقتطَع) ⇒ الختاميّ صحيحٌ حتى مع الاقتطاع.
    const aggRow = rowsOf(
      await tx.execute(sql`
        SELECT COUNT(*) AS cnt,
          CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE 0 END), 0) AS CHAR) AS totalIn,
          CAST(COALESCE(SUM(CASE WHEN r.direction = 'OUT' THEN r.amount ELSE 0 END), 0) AS CHAR) AS totalOut
        FROM receipts r
        WHERE ${TREASURY_CASH_CONDS_SQL}
          AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) >= ${opts.from}
          AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) <= ${opts.to}
          ${branchFilter}
      `),
    )[0] ?? { cnt: 0, totalIn: "0", totalOut: "0" };

    // (ج) تفصيل الحركات مرتّباً زمنياً. يحمل كلُّ صفٍّ منشئَه ومعتمِدَه (§٥: فاعلٌ منسوب)، ويُكمِل
    //     الطرفَ/البيانَ من صفّ المصروف حين لا يحملهما الإيصال (سند صرفٍ من الخزينة: المستفيد
    //     والغرض مخزَّنان على expenses لا على receipts فكانا يظهران «—»).
    const rows = rowsOf(
      await tx.execute(sql`
        SELECT
          r.id AS receiptId,
          ${RECEIPT_CASH_EVENT_AT_SQL} AS at,
          r.direction AS direction,
          CAST(r.amount AS CHAR) AS amount,
          r.receiptStatus AS receiptStatus,
          r.referenceNumber AS referenceNumber,
          r.voucherNumber AS voucherNumber,
          COALESCE(r.counterpartyName, e.payee) AS counterparty,
          COALESCE(r.description, e.description) AS description,
          b.name AS branchName,
          cu.name AS createdByName,
          au.name AS approvedByName,
          e.id AS expenseId,
          e.expenseCategory AS expenseCategory
        FROM receipts r
        LEFT JOIN branches b ON b.id = r.branchId
        LEFT JOIN expenses e ON e.receiptId = r.id
        LEFT JOIN users cu ON cu.id = r.createdBy
        LEFT JOIN users au ON au.id = r.approvedBy
        WHERE ${TREASURY_CASH_CONDS_SQL}
          AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) >= ${opts.from}
          AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) <= ${opts.to}
          ${branchFilter}
        ORDER BY ${RECEIPT_CASH_EVENT_AT_SQL} ASC, r.id ASC
        LIMIT ${limit}
      `),
    );
    return { openRow, aggRow, rows };
  });

  const openingBalance = money(snap.openRow.opening ?? 0);
  const count = Number(snap.aggRow.cnt ?? 0);
  const totalIn = money(snap.aggRow.totalIn ?? 0);
  const totalOut = money(snap.aggRow.totalOut ?? 0);
  const closingBalance = openingBalance.plus(totalIn).minus(totalOut);

  let running = openingBalance;
  const movements: TreasuryStatementMovement[] = snap.rows.map((r) => {
    const amt = money(r.amount ?? 0);
    const dir: "IN" | "OUT" = r.direction === "OUT" ? "OUT" : "IN";
    running = dir === "IN" ? running.plus(amt) : running.minus(amt);
    const reason = treasuryMovementReason({
      direction: dir,
      referenceNumber: r.referenceNumber ?? null,
      voucherNumber: r.voucherNumber ?? null,
      expenseId: r.expenseId != null ? Number(r.expenseId) : null,
      expenseCategory: r.expenseCategory ?? null,
    });
    return {
      receiptId: Number(r.receiptId),
      at: r.at,
      direction: dir,
      amount: toDbMoney(amt),
      reasonKey: reason.key,
      reason: reason.label,
      reference: r.referenceNumber ?? null,
      voucherNumber: r.voucherNumber ?? null,
      counterparty: r.counterparty ?? null,
      description: r.description ?? null,
      branchName: r.branchName ?? null,
      createdByName: r.createdByName ?? null,
      approvedByName: r.approvedByName ?? null,
      reversed: String(r.receiptStatus) === "REVERSED",
      runningBalance: toDbMoney(running),
    };
  });

  return {
    period: { from: opts.from, to: opts.to },
    openingBalance: toDbMoney(openingBalance),
    totalIn: toDbMoney(totalIn),
    totalOut: toDbMoney(totalOut),
    closingBalance: toDbMoney(closingBalance),
    count,
    shownCount: movements.length,
    truncated: count > movements.length,
    movements,
  };
}

/* ============================ تقرير المصروفات ============================ */

export interface ExpenseCategoryLine {
  key: string;
  label: string;
  amount: string;
  count: number;
}

export interface ExpensePayeeLine {
  payee: string;
  amount: string;
  count: number;
}

export interface ExpensesReportResult {
  period: { from: string; to: string };
  byCategory: ExpenseCategoryLine[];
  byPayee: ExpensePayeeLine[];
  total: string;
}

export async function getExpensesReport(opts: {
  from: string;
  to: string;
  branchId?: number;
  /** حدّ جهات الصرف المُعادة — افتراضي ٢٠ (توافقاً مع السلوك القديم)، أعلى سقفٍ ٢٠٠. */
  payeeLimit?: number;
}): Promise<ExpensesReportResult> {
  const db = getDb();
  const base: ExpensesReportResult = {
    period: { from: opts.from, to: opts.to },
    byCategory: [],
    byPayee: [],
    total: "0",
  };
  if (!db) return base;

  const branchEx = opts.branchId ? sql`AND e.branchId = ${opts.branchId}` : sql``;
  const payeeLimit = Math.min(Math.max(opts.payeeLimit ?? 20, 1), 200);

  // المصروفات الفعّالة مصنّفةً حسب الفئة.
  const catRows = rowsOf(
    await db.execute(sql`
      SELECT e.expenseCategory AS category,
             CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount,
             COUNT(*) AS cnt
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate >= ${opts.from} AND e.expenseDate <= ${opts.to}
        ${branchEx}
      GROUP BY e.expenseCategory
      ORDER BY SUM(e.amount) DESC
    `),
  );

  // أكبر جهات الصرف (payeeLimit، افتراضي ٢٠ للتوافق) — payee قد تكون NULL ⇒ "غير محدّد" (تُجمَّع في صفّ واحد).
  const payeeRows = rowsOf(
    await db.execute(sql`
      SELECT e.payee AS payee,
             CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS amount,
             COUNT(*) AS cnt
      FROM expenses e
      WHERE e.expenseStatus = 'ACTIVE'
        AND e.expenseDate >= ${opts.from} AND e.expenseDate <= ${opts.to}
        ${branchEx}
      GROUP BY e.payee
      ORDER BY SUM(e.amount) DESC
      LIMIT ${payeeLimit}
    `),
  );

  const byCategory: ExpenseCategoryLine[] = catRows.map((r) => ({
    key: String(r.category),
    label: EXPENSE_CATEGORY_AR[String(r.category)] ?? String(r.category),
    amount: toDbMoney(money(r.amount ?? 0)),
    count: Number(r.cnt ?? 0),
  }));

  const byPayee: ExpensePayeeLine[] = payeeRows.map((r) => ({
    payee: r.payee == null || r.payee === "" ? "غير محدّد" : String(r.payee),
    amount: toDbMoney(money(r.amount ?? 0)),
    count: Number(r.cnt ?? 0),
  }));

  // الإجمالي = مجموع الفئات (مرجع واحد متّسق مع byCategory، بلا استعلام ثالث).
  const total = catRows.reduce((acc, r) => acc.add(money(r.amount ?? 0)), money(0));

  return {
    period: { from: opts.from, to: opts.to },
    byCategory,
    byPayee,
    total: toDbMoney(total),
  };
}

/* ============================ النقد خارج وردية الكاشير (إداري + يتيم) ============================
 * تقرير قراءة فقط لـreceipts بـshiftId IS NULL AND paymentMethod='CASH' AND receiptStatus='COMPLETED'.
 * بعد تَفعيل cash-treasury-mode (تدقيق ١٧/٦) ينقسم إلى فئتَين دلالياً:
 *  - TREASURY: معاملات admin/manager مشروعة بـcashBucket='TREASURY' (خزينة إدارية، متوقَّعة).
 *  - TRUE_ORPHAN: سجلات تاريخية قبل cashBucket (NULL) أو خَلل (cashier/warehouse بـshiftId=null).
 *      هذه يَجب أن تَبقى صفراً للجديد بعد الإنفاذ؛ أيّ زيادة فيها = bug يَستدعي فحصاً.
 * كلتا الفئتَين خارج Z-report ⇒ تَسوية صندوق الكاشير دقيقة، والتقرير يَخدم تَسوية الخزينة المُنفصِلة.
 */

export type CashOrphanCategory = "TREASURY" | "TRUE_ORPHAN";

export interface CashOrphanRow {
  receiptId: number;
  branchId: number | null;
  branchName: string | null;
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod: string;
  voucherNumber: string | null;
  referenceNumber: string | null;
  description: string | null;
  partyType: string | null;
  partyId: number | null;
  source: "EXPENSE" | "VOUCHER" | "OTHER";
  sourceId: number | null;
  createdAt: Date | string;
  createdByName: string | null;
  createdById: number | null;
  createdByRole: string | null;
  cashBucket: "DRAWER" | "TREASURY" | null;
  category: CashOrphanCategory;
}

export interface CashOrphansReportResult {
  period: { from: string | null; to: string | null };
  rows: CashOrphanRow[];
  count: number;
  totalIn: string;
  totalOut: string;
  net: string;
  // فصل العدّادات + الإجماليات حسب الفئة (TREASURY مشروعة، TRUE_ORPHAN تَستدعي فحصاً).
  countTreasury: number;
  totalInTreasury: string;
  totalOutTreasury: string;
  netTreasury: string;
  countTrueOrphan: number;
  totalInTrueOrphan: string;
  totalOutTrueOrphan: string;
  netTrueOrphan: string;
}

export async function getCashOrphansReport(opts: {
  from?: string;
  to?: string;
  branchId?: number;
  limit?: number;
  /** فلتر اختياري يُقصِر النتائج على فئة واحدة (لتبويب الواجهة). */
  category?: CashOrphanCategory;
}): Promise<CashOrphansReportResult> {
  const db = getDb();
  const base: CashOrphansReportResult = {
    period: { from: opts.from ?? null, to: opts.to ?? null },
    rows: [],
    count: 0,
    totalIn: "0",
    totalOut: "0",
    net: "0",
    countTreasury: 0,
    totalInTreasury: "0",
    totalOutTreasury: "0",
    netTreasury: "0",
    countTrueOrphan: 0,
    totalInTrueOrphan: "0",
    totalOutTrueOrphan: "0",
    netTrueOrphan: "0",
  };
  if (!db) return base;

  const limit = opts.limit && opts.limit > 0 && opts.limit <= 5000 ? opts.limit : 1000;

  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        r.id AS receiptId,
        r.branchId AS branchId,
        b.name AS branchName,
        r.direction AS direction,
        CAST(r.amount AS CHAR) AS amount,
        r.paymentMethod AS paymentMethod,
        r.cashBucket AS cashBucket,
        r.voucherNumber AS voucherNumber,
        r.referenceNumber AS referenceNumber,
        r.description AS description,
        r.voucherPartyType AS partyType,
        r.partyId AS partyId,
        e.id AS expenseId,
        ${RECEIPT_CASH_EVENT_AT_SQL} AS createdAt,
        r.createdBy AS createdById,
        u.name AS createdByName,
        u.role AS createdByRole
      FROM receipts r
      LEFT JOIN branches b ON b.id = r.branchId
      LEFT JOIN expenses e ON e.receiptId = r.id
      LEFT JOIN users u ON u.id = r.createdBy
      WHERE r.shiftId IS NULL
        AND r.paymentMethod = 'CASH'
        AND r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
        AND r.receiptApprovalStatus = 'APPROVED'
        ${opts.from ? sql`AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) >= ${opts.from}` : sql``}
        ${opts.to ? sql`AND DATE(${RECEIPT_CASH_EVENT_AT_SQL}) <= ${opts.to}` : sql``}
        ${opts.branchId ? sql`AND r.branchId = ${opts.branchId}` : sql``}
        ${opts.category === "TREASURY" ? sql`AND r.cashBucket = 'TREASURY'` : sql``}
        ${opts.category === "TRUE_ORPHAN" ? sql`AND (r.cashBucket IS NULL OR r.cashBucket = 'DRAWER')` : sql``}
      ORDER BY r.id DESC
      LIMIT ${limit}
    `),
  );

  let totalIn = money(0);
  let totalOut = money(0);
  let totalInTreasury = money(0);
  let totalOutTreasury = money(0);
  let totalInTrueOrphan = money(0);
  let totalOutTrueOrphan = money(0);
  let countTreasury = 0;
  let countTrueOrphan = 0;

  const mapped: CashOrphanRow[] = rows.map((r) => {
    const amt = money(r.amount ?? 0);
    const dir = r.direction === "OUT" ? "OUT" : "IN";
    const bucket: "DRAWER" | "TREASURY" | null = r.cashBucket === "TREASURY" ? "TREASURY" : r.cashBucket === "DRAWER" ? "DRAWER" : null;
    const category: CashOrphanCategory = bucket === "TREASURY" ? "TREASURY" : "TRUE_ORPHAN";

    if (dir === "IN") totalIn = totalIn.plus(amt);
    else totalOut = totalOut.plus(amt);

    if (category === "TREASURY") {
      countTreasury++;
      if (dir === "IN") totalInTreasury = totalInTreasury.plus(amt);
      else totalOutTreasury = totalOutTreasury.plus(amt);
    } else {
      countTrueOrphan++;
      if (dir === "IN") totalInTrueOrphan = totalInTrueOrphan.plus(amt);
      else totalOutTrueOrphan = totalOutTrueOrphan.plus(amt);
    }

    let source: CashOrphanRow["source"] = "OTHER";
    let sourceId: number | null = null;
    if (r.expenseId != null) {
      source = "EXPENSE";
      sourceId = Number(r.expenseId);
    } else if (r.voucherNumber != null) {
      source = "VOUCHER";
      sourceId = Number(r.receiptId);
    }
    return {
      receiptId: Number(r.receiptId),
      branchId: r.branchId != null ? Number(r.branchId) : null,
      branchName: r.branchName ?? null,
      direction: dir,
      amount: toDbMoney(amt),
      paymentMethod: String(r.paymentMethod),
      voucherNumber: r.voucherNumber ?? null,
      referenceNumber: r.referenceNumber ?? null,
      description: r.description ?? null,
      partyType: r.partyType ?? null,
      partyId: r.partyId != null ? Number(r.partyId) : null,
      source,
      sourceId,
      createdAt: r.createdAt,
      createdByName: r.createdByName ?? null,
      createdById: r.createdById != null ? Number(r.createdById) : null,
      createdByRole: r.createdByRole ?? null,
      cashBucket: bucket,
      category,
    };
  });

  return {
    period: { from: opts.from ?? null, to: opts.to ?? null },
    rows: mapped,
    count: mapped.length,
    totalIn: toDbMoney(totalIn),
    totalOut: toDbMoney(totalOut),
    net: toDbMoney(totalIn.minus(totalOut)),
    countTreasury,
    totalInTreasury: toDbMoney(totalInTreasury),
    totalOutTreasury: toDbMoney(totalOutTreasury),
    netTreasury: toDbMoney(totalInTreasury.minus(totalOutTreasury)),
    countTrueOrphan,
    totalInTrueOrphan: toDbMoney(totalInTrueOrphan),
    totalOutTrueOrphan: toDbMoney(totalOutTrueOrphan),
    netTrueOrphan: toDbMoney(totalInTrueOrphan.minus(totalOutTrueOrphan)),
  };
}
