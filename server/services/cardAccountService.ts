// خدمة «حساب البطاقة/البنك» — رصيد مشتقّ من receipts + لقطات مطابقة كشف البنك.
//
// النموذج المعماريّ (قرار مبنيّ على فحص نظام الخزينة القائم):
//   لا يوجد جدول رصيد مخزَّن في النظام إطلاقاً — رصيد الدرج/الخزينة **مشتقّ** بتجميع receipts
//   (راجع treasuryService: DRAWER = Σ receipts cashBucket='DRAWER'، TREASURY = Σ cashBucket='TREASURY').
//   أموال البطاقة تُكتَب أصلاً في receipts بـpaymentMethod='CARD' (وcashBucket=NULL — ليست نقداً) من كل
//   مسارات البيع/الدفع/السند/الشراء/المرتجع. فحساب البطاقة = **تجميعٌ مشتقّ** بنفس النمط، بلا أي تغيير
//   على مسارات الكتابة (⇒ لا تقاطع مع دورة النقد الورقيّ: الدرج/الخزينة/Z-report).
//
// **ثابت الرصيد (حرِج):** رصيد حساب البطاقة =
//     Σ over receipts WHERE paymentMethod='CARD' AND approvalStatus='APPROVED'
//         of (direction='IN' ? +amount : −amount)
//   • لا نفلتر بـreceiptStatus — مطابقةً لـ computeExpectedCash (shiftService): الإلغاء يَعكس بنمط
//     «وسم الأصل REVERSED + إيصال تعويضيّ بالاتجاه المعاكس بنفس paymentMethod» ⇒ جمعُ كل الحالات
//     يُصفّي السند الملغى ذاتياً. فلتَرة الحالة كانت ستُبقي التعويضيّ وتُسقط الأصل ⇒ رصيد خاطئ.
//   • approvalStatus='APPROVED' إلزاميّ: سند صرف بطاقة فوق العتبة يُكتب PENDING_APPROVAL بصفّ receipts
//     **بلا قيد دفتر ولا أثر ماليّ** حتى يعتمده مديرٌ آخر (SOD)؛ عدّه كان سيَخصم من البطاقة مالاً لم يخرج.
//     (في مسار الدرج يُستبعَد ضمناً لأنّ السند المعلَّق يأخذ shiftId=NULL؛ البطاقة ليست مربوطة بوردية
//      فنُصرّح بالشرط.) الأصل REVERSED يبقى approvalStatus='APPROVED' فيَتصافى مع تعويضيّه — سليم.
import { and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { cardReconciliations, receipts } from "../../drizzle/schema";
import { extractInsertId } from "../lib/insertId";
import { money, toDbMoney } from "./money";
import { withTx } from "./tx";
import { utcTodayStart } from "./businessDay";

/** تطبيع نتيجة db.execute الخام إلى مصفوفة صفوف (mysql2 يعيد [rows, fields]). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(res: unknown): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/** نطاق المستخدم كما يمرّره الراوتر بعد reportViewerProcedure (يَرفض طلب فرعٍ غير فرع غير-الأدمن). */
export interface CardScope {
  role: string;
  /** ctx.user.branchId — الفرع المُسنَد (null للأدمن أو المدير متعدّد الفروع). */
  branchId: number | null;
}

/**
 * الفرع الفعليّ للاستعلام:
 *   • admin: الفرع المطلوب صراحةً (input.branchId) أو null = كل الفروع.
 *   • غير-الأدمن ذو فرعٍ مُسنَد: فرعه حصراً (reportViewerProcedure رفض بالفعل أيّ فرعٍ آخر).
 *   • غير-الأدمن متعدّد الفروع (branchId=null، مدير عامّ): كل الفروع (لا يستطيع تقييد فرعٍ بعينه — مرفوض upstream).
 */
function resolveBranch(scope: CardScope, inputBranchId?: number | null): number | null {
  if (scope.role === "admin") return inputBranchId ?? null;
  if (scope.branchId != null) return scope.branchId;
  return inputBranchId ?? null;
}

/** شرط SQL الأساس لكل صفوف حساب البطاقة (بطاقة + معتمَد).
 *  ⚠️ اسم عمود DB لـapprovalStatus هو `receiptApprovalStatus` (mysqlEnum أوّل معامل = اسم العمود). */
const CARD_WHERE = sql`r.paymentMethod = 'CARD' AND r.receiptApprovalStatus = 'APPROVED'`;
/** المبلغ الموقَّع (IN موجب، OUT سالب) — decimal(15,2) دقيق في SQL. */
const SIGNED = sql`CASE WHEN r.direction = 'IN' THEN r.amount ELSE -r.amount END`;

function branchClause(branchId: number | null) {
  return branchId != null ? sql`AND r.branchId = ${branchId}` : sql``;
}

// ───────────────────────────── ملخّص الرصيد ─────────────────────────────

export interface CardSummary {
  branchId: number | null; // null = كل الفروع (admin)
  balance: string; // الرصيد الجاري (كل الوقت)
  totalIn: string;
  totalOut: string;
  todayIn: string;
  todayOut: string;
  movementCount: number;
  lastReconciliation: {
    asOfDate: string;
    systemBalance: string;
    statementBalance: string;
    difference: string;
    createdAt: Date | string | null;
  } | null;
}

export async function getCardSummary(input: { branchId?: number }, scope: CardScope): Promise<CardSummary> {
  const db = getDb();
  const branchId = resolveBranch(scope, input.branchId);
  const empty: CardSummary = {
    branchId,
    balance: "0.00",
    totalIn: "0.00",
    totalOut: "0.00",
    todayIn: "0.00",
    todayOut: "0.00",
    movementCount: 0,
    lastReconciliation: null,
  };
  if (!db) return empty;

  const todayStart = utcTodayStart();
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE 0 END), 0) AS CHAR) AS totalIn,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'OUT' THEN r.amount ELSE 0 END), 0) AS CHAR) AS totalOut,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' AND r.createdAt >= ${todayStart} THEN r.amount ELSE 0 END), 0) AS CHAR) AS todayIn,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'OUT' AND r.createdAt >= ${todayStart} THEN r.amount ELSE 0 END), 0) AS CHAR) AS todayOut,
        COUNT(*) AS cnt
      FROM receipts r
      WHERE ${CARD_WHERE} ${branchClause(branchId)}
    `),
  );
  const r = rows[0] ?? {};
  const totalIn = money(r.totalIn ?? 0);
  const totalOut = money(r.totalOut ?? 0);

  // آخر لقطة مطابقة (للفرع المحدَّد فقط — عبر الفروع لا معنى للقطة واحدة).
  let lastReconciliation: CardSummary["lastReconciliation"] = null;
  if (branchId != null) {
    const recRows = rowsOf(
      await db.execute(sql`
        SELECT CAST(asOfDate AS CHAR) AS asOfDate,
               CAST(systemBalance AS CHAR) AS systemBalance,
               CAST(statementBalance AS CHAR) AS statementBalance,
               CAST(difference AS CHAR) AS difference,
               createdAt
        FROM cardReconciliations
        WHERE branchId = ${branchId}
        ORDER BY asOfDate DESC, id DESC
        LIMIT 1
      `),
    );
    if (recRows[0]) {
      const rr = recRows[0];
      lastReconciliation = {
        asOfDate: String(rr.asOfDate ?? "").slice(0, 10),
        systemBalance: toDbMoney(money(rr.systemBalance ?? 0)),
        statementBalance: toDbMoney(money(rr.statementBalance ?? 0)),
        difference: toDbMoney(money(rr.difference ?? 0)),
        createdAt: (rr.createdAt as Date | string | null) ?? null,
      };
    }
  }

  return {
    branchId,
    balance: toDbMoney(totalIn.minus(totalOut)),
    totalIn: toDbMoney(totalIn),
    totalOut: toDbMoney(totalOut),
    todayIn: toDbMoney(money(r.todayIn ?? 0)),
    todayOut: toDbMoney(money(r.todayOut ?? 0)),
    movementCount: Number(r.cnt ?? 0),
    lastReconciliation,
  };
}

// ───────────────────────────── الحركات ─────────────────────────────

export type CardMovementSource = "SALE" | "INVOICE_PAYMENT" | "VOUCHER" | "WORK_ORDER" | "OTHER";

export interface CardMovementRow {
  receiptId: number;
  branchId: number | null;
  branchName: string | null;
  createdAt: Date | string | null;
  direction: "IN" | "OUT";
  amount: string;
  /** الرصيد الجاري بعد هذه الحركة — للفرع المحدَّد فقط (null عند عرض كل الفروع). */
  runningBalance: string | null;
  paymentMethod: string;
  cardLastFour: string | null;
  referenceNumber: string | null;
  voucherNumber: string | null;
  invoiceId: number | null;
  source: CardMovementSource;
  partyType: string | null;
  partyName: string | null;
  description: string | null;
  createdByName: string | null;
  reversed: boolean;
}

export interface CardMovementsResult {
  rows: CardMovementRow[];
  count: number;
  totalIn: string;
  totalOut: string;
  net: string;
  hasMore: boolean;
  branchId: number | null;
}

const MOVEMENTS_MAX = 500;

export async function getCardMovements(
  input: { branchId?: number; from?: string; to?: string; direction?: "IN" | "OUT"; limit?: number; offset?: number },
  scope: CardScope,
): Promise<CardMovementsResult> {
  const db = getDb();
  const branchId = resolveBranch(scope, input.branchId);
  const base: CardMovementsResult = { rows: [], count: 0, totalIn: "0.00", totalOut: "0.00", net: "0.00", hasMore: false, branchId };
  if (!db) return base;

  const limit = input.limit && input.limit > 0 && input.limit <= MOVEMENTS_MAX ? Math.floor(input.limit) : 100;
  const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
  const fromClause = input.from ? sql`AND r.createdAt >= ${input.from}` : sql``;
  // to شامل ليومه كاملاً (< بداية اليوم التالي).
  const toClause = input.to ? sql`AND r.createdAt < DATE_ADD(${input.to}, INTERVAL 1 DAY)` : sql``;
  const dirClause = input.direction ? sql`AND r.direction = ${input.direction}` : sql``;
  // نطاق الحساب **بلا** فلتر الاتجاه — عليه يُحسَب الرصيد الجاري كي يبقى صحيحاً (الرصيد بعد كل حركة
  // يشمل الاتجاهين). فلتر الاتجاه يُطبَّق على الصفوف المعروضة فقط (في الاستعلام الخارجي أدناه).
  const streamFilter = sql`${CARD_WHERE} ${branchClause(branchId)} ${fromClause} ${toClause}`;
  // فلتر العرض (يشمل الاتجاه) — للإجماليات/العدّ والصفوف المعروضة.
  const filter = sql`${streamFilter} ${dirClause}`;

  // إجماليات النطاق (كل الصفوف المطابقة، لا الصفحة فقط).
  const totRows = rowsOf(
    await db.execute(sql`
      SELECT
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'IN' THEN r.amount ELSE 0 END), 0) AS CHAR) AS totalIn,
        CAST(COALESCE(SUM(CASE WHEN r.direction = 'OUT' THEN r.amount ELSE 0 END), 0) AS CHAR) AS totalOut,
        COUNT(*) AS cnt
      FROM receipts r
      WHERE ${filter}
    `),
  );
  const t = totRows[0] ?? {};
  const totalIn = money(t.totalIn ?? 0);
  const totalOut = money(t.totalOut ?? 0);
  const count = Number(t.cnt ?? 0);

  // الرصيد الافتتاحيّ قبل النطاق (للفرع المحدَّد فقط) — يجعل الرصيد الجاري صحيحاً حتى مع فلتر التاريخ.
  let opening = money(0);
  if (branchId != null && input.from) {
    const opRows = rowsOf(
      await db.execute(sql`
        SELECT CAST(COALESCE(SUM(${SIGNED}), 0) AS CHAR) AS bal
        FROM receipts r
        WHERE ${CARD_WHERE} AND r.branchId = ${branchId} AND r.createdAt < ${input.from}
      `),
    );
    opening = money(opRows[0]?.bal ?? 0);
  }

  // الرصيد الجاري عبر دالّة نافذة — للفرع المحدَّد فقط (عبر الفروع لا معنى لرصيدٍ جارٍ مختلط).
  const runningExpr = branchId != null
    ? sql`CAST(SUM(${SIGNED}) OVER (ORDER BY r.createdAt, r.id ROWS UNBOUNDED PRECEDING) AS CHAR)`
    : sql`NULL`;

  const rows = rowsOf(
    await db.execute(sql`
      SELECT * FROM (
        SELECT
          r.id AS receiptId,
          r.branchId AS branchId,
          b.name AS branchName,
          r.createdAt AS createdAt,
          r.direction AS direction,
          CAST(r.amount AS CHAR) AS amount,
          ${runningExpr} AS runningBalance,
          r.paymentMethod AS paymentMethod,
          r.cardLastFour AS cardLastFour,
          r.referenceNumber AS referenceNumber,
          r.voucherNumber AS voucherNumber,
          r.invoiceId AS invoiceId,
          r.workOrderId AS workOrderId,
          r.receiptStatus AS receiptStatus,
          r.voucherPartyType AS partyType,
          r.partyId AS partyId,
          cu.name AS customerName,
          su.name AS supplierName,
          r.counterpartyName AS counterpartyName,
          r.description AS description,
          u.name AS createdByName
        FROM receipts r
        LEFT JOIN branches b ON b.id = r.branchId
        LEFT JOIN customers cu ON cu.id = r.partyId AND r.voucherPartyType = 'CUSTOMER'
        LEFT JOIN suppliers su ON su.id = r.partyId AND r.voucherPartyType = 'SUPPLIER'
        LEFT JOIN users u ON u.id = r.createdBy
        WHERE ${streamFilter}
      ) x
      ${input.direction ? sql`WHERE x.direction = ${input.direction}` : sql``}
      ORDER BY x.createdAt DESC, x.receiptId DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  );

  const mapped: CardMovementRow[] = rows.map((r) => {
    const dir: "IN" | "OUT" = r.direction === "OUT" ? "OUT" : "IN";
    const voucherNumber = (r.voucherNumber as string | null) ?? null;
    const invoiceId = r.invoiceId != null ? Number(r.invoiceId) : null;
    const workOrderId = r.workOrderId != null ? Number(r.workOrderId) : null;
    let source: CardMovementSource = "OTHER";
    if (voucherNumber != null) source = "VOUCHER";
    else if (invoiceId != null) source = "INVOICE_PAYMENT";
    else if (workOrderId != null) source = "WORK_ORDER";
    // ملاحظة: إيصال البيع النقديّ اللحظيّ يُكتب بـinvoiceId ⇒ يظهر INVOICE_PAYMENT؛ التمييز الدقيق
    // «بيع مقابل تسديد دفعة» غير جوهريّ للمطابقة (كلاهما دخل بطاقة على الفاتورة).
    const partyName =
      (r.customerName as string | null) ?? (r.supplierName as string | null) ?? (r.counterpartyName as string | null) ?? null;
    const running = r.runningBalance != null ? toDbMoney(opening.plus(money(r.runningBalance))) : null;
    return {
      receiptId: Number(r.receiptId),
      branchId: r.branchId != null ? Number(r.branchId) : null,
      branchName: (r.branchName as string | null) ?? null,
      createdAt: (r.createdAt as Date | string | null) ?? null,
      direction: dir,
      amount: toDbMoney(money(r.amount ?? 0)),
      runningBalance: running,
      paymentMethod: String(r.paymentMethod ?? "CARD"),
      cardLastFour: (r.cardLastFour as string | null) ?? null,
      referenceNumber: (r.referenceNumber as string | null) ?? null,
      voucherNumber,
      invoiceId,
      source,
      partyType: (r.partyType as string | null) ?? null,
      partyName,
      description: (r.description as string | null) ?? null,
      createdByName: (r.createdByName as string | null) ?? null,
      reversed: r.receiptStatus === "REVERSED",
    };
  });

  return {
    rows: mapped,
    count,
    totalIn: toDbMoney(totalIn),
    totalOut: toDbMoney(totalOut),
    net: toDbMoney(totalIn.minus(totalOut)),
    hasMore: offset + rows.length < count,
    branchId,
  };
}

// ───────────────────────── لقطات المطابقة ─────────────────────────

export interface CardReconciliationRow {
  id: number;
  branchId: number;
  branchName: string | null;
  asOfDate: string;
  systemBalance: string;
  statementBalance: string;
  difference: string;
  statementLabel: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: Date | string | null;
}

export async function listCardReconciliations(
  input: { branchId?: number; limit?: number },
  scope: CardScope,
): Promise<CardReconciliationRow[]> {
  const db = getDb();
  if (!db) return [];
  const branchId = resolveBranch(scope, input.branchId);
  const limit = input.limit && input.limit > 0 && input.limit <= 200 ? Math.floor(input.limit) : 50;
  const branchFilter = branchId != null ? sql`WHERE cr.branchId = ${branchId}` : sql``;
  const rows = rowsOf(
    await db.execute(sql`
      SELECT
        cr.id AS id,
        cr.branchId AS branchId,
        b.name AS branchName,
        CAST(cr.asOfDate AS CHAR) AS asOfDate,
        CAST(cr.systemBalance AS CHAR) AS systemBalance,
        CAST(cr.statementBalance AS CHAR) AS statementBalance,
        CAST(cr.difference AS CHAR) AS difference,
        cr.statementLabel AS statementLabel,
        cr.note AS note,
        u.name AS createdByName,
        cr.createdAt AS createdAt
      FROM cardReconciliations cr
      LEFT JOIN branches b ON b.id = cr.branchId
      LEFT JOIN users u ON u.id = cr.createdBy
      ${branchFilter}
      ORDER BY cr.asOfDate DESC, cr.id DESC
      LIMIT ${limit}
    `),
  );
  return rows.map((r) => ({
    id: Number(r.id),
    branchId: Number(r.branchId),
    branchName: (r.branchName as string | null) ?? null,
    asOfDate: String(r.asOfDate ?? "").slice(0, 10),
    systemBalance: toDbMoney(money(r.systemBalance ?? 0)),
    statementBalance: toDbMoney(money(r.statementBalance ?? 0)),
    difference: toDbMoney(money(r.difference ?? 0)),
    statementLabel: (r.statementLabel as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdByName: (r.createdByName as string | null) ?? null,
    createdAt: (r.createdAt as Date | string | null) ?? null,
  }));
}

export interface CreateReconciliationInput {
  branchId?: number;
  asOfDate: string; // YYYY-MM-DD
  statementBalance: string;
  statementLabel?: string;
  note?: string;
}

export interface CreateReconciliationResult {
  id: number;
  branchId: number;
  asOfDate: string;
  systemBalance: string;
  statementBalance: string;
  difference: string;
}

/**
 * يُنشئ لقطة مطابقة: يحسب رصيد النظام المتوقَّع (لكامل حركات البطاقة حتى نهاية asOfDate) ثم يقارنه
 * بكشف البنك المُدخَل يدوياً. سجلٌّ تدقيقيٌّ بحت — لا يمسّ أيّ رصيد. systemBalance يُحسَب خادمياً
 * (لا يُدخِله المستخدم) ⇒ الفرق ذو معنى: صفقات لم تُسوَّ بعد، رسوم بنكيّة، أو خطأ يستدعي المراجعة.
 */
export async function createCardReconciliation(
  input: CreateReconciliationInput,
  actor: { userId: number; role: string; branchId: number | null },
): Promise<CreateReconciliationResult> {
  const scope: CardScope = { role: actor.role, branchId: actor.branchId ?? null };
  const branchId = resolveBranch(scope, input.branchId);
  if (branchId == null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يجب تحديد الفرع لإنشاء مطابقة حساب البطاقة" });
  }
  const asOf = String(input.asOfDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "تاريخ المطابقة غير صالح (الصيغة YYYY-MM-DD)" });
  }
  const statementBalance = money(input.statementBalance);

  return withTx(async (tx) => {
    // رصيد النظام حتى نهاية يوم asOfDate (شامل) — نفس ثابت الرصيد.
    const rows = rowsOf(
      await tx.execute(sql`
        SELECT CAST(COALESCE(SUM(${SIGNED}), 0) AS CHAR) AS bal
        FROM receipts r
        WHERE ${CARD_WHERE} AND r.branchId = ${branchId}
          AND r.createdAt < DATE_ADD(${asOf}, INTERVAL 1 DAY)
      `),
    );
    const systemBalance = money(rows[0]?.bal ?? 0);
    const difference = systemBalance.minus(statementBalance);

    const res = await tx.insert(cardReconciliations).values({
      branchId,
      asOfDate: asOf,
      systemBalance: toDbMoney(systemBalance),
      statementBalance: toDbMoney(statementBalance),
      difference: toDbMoney(difference),
      statementLabel: input.statementLabel?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: actor.userId,
    });
    const id = extractInsertId(res);

    return {
      id,
      branchId,
      asOfDate: asOf,
      systemBalance: toDbMoney(systemBalance),
      statementBalance: toDbMoney(statementBalance),
      difference: toDbMoney(difference),
    };
  });
}
