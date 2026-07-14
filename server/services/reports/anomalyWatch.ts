// رقيب الشذوذ (للقراءة فقط) — كواشف حتمية لمنع تسرّب الأموال، بلا أي ذكاء اصطناعي.
//
// ستة كواشف SQL على بيانات موجودة أصلاً (لا جداول ولا هجرات):
//   D1 بيع دون الكلفة    — لقطة الكلفة التاريخية invoiceItems.unitCost وقت البيع (لا الكلفة الحالية).
//   D2 طفرة خصومات       — الخصم اليدوي (رأس الفاتورة + الأسطر) لكل كاشير مقابل متوسط النطاق؛
//                           promotionDiscount يُعرض منفصلاً (خصم آليّ من عرضٍ مُعرَّف، لا قرار كاشير).
//   D3 تركّز المرتجعات    — (أ) على بائع الفاتورة الأصلية (invoices.returnedTotal ÷ مبيعاته)؛
//                           (ب) على معالج الإرجاع من auditLogs (action='return.create') — best-effort:
//                           سجلّ التدقيق لا يُرمى عند فشله فقد يَنقص، ويُوثَّق هذا في الواجهة.
//   D4 عجوزات الورديات    — shifts.variance لكل كاشير (عجز متكرر أو كبير).
//   D5 عكس السندات        — receipts.status='REVERSED' + سند التعويض CANCEL-VCH-{id} (عاكسه createdBy).
//   D6 سلامة تسلسل الترقيم — الترقيم gapless بالتصميم (MAX+1 تحت GET_LOCK ولا حذف تطبيقي للفواتير)
//                           ⇒ أي فجوة = صفّ حُذف مباشرة من القاعدة = تحذير حرج (كاشف عبث لا كاشف كاشير).
//                           حدّه: حذف صاحب أعلى seq في اليوم لا يُكشف (COUNT=MAX يتطابقان) — موثَّق.
//
// كل كاشف داخل safe() (نمط reportsAlertsService): فشل مصدرٍ لا يُسقط التقرير.
// كل الأموال نصوص decimal (§٥ — لا parseFloat). أسماء أعمدة DB الخام camelCase
// (invoices.invoiceStatus · shifts.shiftStatus · receipts.receiptStatus).
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { getDb } from "../../db";
import { money, toDbMoney } from "../money";
import { localDayStart, localNextDayStart } from "../dateRange";

/* ── عتبات الأعلام (ثوابت مسماة — الجداول تعرض الجميع والعلم يرتّب لا يحجب) ── */
/** مضاعف متوسط النطاق: يُعلَّم الكاشير إذا بلغت نسبته ≥ المضاعف × متوسط كل الكاشيرية بالفترة. */
const FLAG_RATE_MULTIPLIER = 2;
/** أرضية نسبة الخصم اليدوي (٥٪) — دون المتوسطات الصغيرة جداً لا معنى للمضاعف وحده. */
const FLAG_MIN_DISCOUNT_RATE = new Decimal("0.05");
/** أرضية نسبة المرتجعات (٥٪) من مبيعات البائع. */
const FLAG_MIN_RETURN_RATE = new Decimal("0.05");
/** ورديات العجز: عدد الورديات ذات العجز الذي يستوجب العلم. */
const FLAG_SHORTAGE_MIN_SHIFTS = 2;
/** أو إجمالي عجز بالفترة ≥ هذا المبلغ (د.ع). */
const FLAG_SHORTAGE_TOTAL_IQD = new Decimal("25000");
/** عكس سندات: يُعلَّم المستخدم الذي عكس ≥ هذا العدد بالفترة. */
const FLAG_REVERSALS_PER_USER = 2;
/** حدّ أسوأ أسطر البيع دون الكلفة المعروضة. */
const WORST_LINES_LIMIT = 10;

function rowsOf(res: unknown): any[] {
  const data = (res as any)?.[0] ?? res;
  return Array.isArray(data) ? data : [];
}

/* ── أشكال الصفوف ── */
export interface BelowCostCashierRow {
  userId: number | null;
  userName: string;
  lineCount: number;
  /** خسارة الفترة = Σ(baseQuantity×unitCost − total) للأسطر دون الكلفة. */
  lossValue: string;
}
export interface BelowCostLineRow {
  invoiceId: number;
  invoiceNumber: string;
  invoiceDate: string;
  userName: string;
  productName: string;
  quantity: string;
  lineTotal: string;
  lineCost: string;
  lossValue: string;
}
export interface DiscountCashierRow {
  userId: number | null;
  userName: string;
  invoiceCount: number;
  /** قيمة البيع قبل كل الخصومات = Σ(كمية×سعر). */
  grossTotal: string;
  /** الخصم اليدوي (رأس الفاتورة + الأسطر) — قرار الكاشير. */
  manualDiscount: string;
  /** خصم العروض الآلي — للسياق فقط، لا يدخل النسبة. */
  promoDiscount: string;
  /** manualDiscount ÷ grossTotal بنسبة مئوية نصاً (خانتان). */
  discountRatePct: string;
  flagged: boolean;
}
export interface ReturnSellerRow {
  userId: number | null;
  userName: string;
  invoiceCount: number;
  salesTotal: string;
  returnedTotal: string;
  returnRatePct: string;
  flagged: boolean;
}
export interface ReturnProcessorRow {
  userId: number | null;
  userName: string;
  opsCount: number;
}
export interface ShiftShortageRow {
  userId: number;
  userName: string;
  closedShifts: number;
  shortageShifts: number;
  totalShortage: string;
  totalSurplus: string;
  flagged: boolean;
}
export interface ReversedVoucherRow {
  receiptId: number;
  voucherNumber: string;
  direction: "IN" | "OUT";
  amount: string;
  createdByName: string;
  reversedById: number | null;
  reversedByName: string;
  reversedAt: string;
  flagged: boolean;
}
export interface SequenceGapRow {
  branchId: number;
  branchName: string;
  day: string;
  actualCount: number;
  maxSeq: number;
  minSeq: number;
  missing: number;
}

export interface AnomalyWatchResult {
  generatedAt: string;
  from: string;
  to: string;
  kpis: {
    belowCostLines: number;
    belowCostLoss: string;
    flaggedDiscountCashiers: number;
    flaggedReturnSellers: number;
    flaggedShortageCashiers: number;
    reversedVouchers: number;
    sequenceGapDays: number;
  };
  belowCost: { cashiers: BelowCostCashierRow[]; worstLines: BelowCostLineRow[] };
  discounts: { rows: DiscountCashierRow[]; scopeAvgRatePct: string };
  returns: { sellers: ReturnSellerRow[]; processors: ReturnProcessorRow[]; scopeAvgRatePct: string };
  shiftShortages: { rows: ShiftShortageRow[] };
  reversedVouchers: { rows: ReversedVoucherRow[] };
  sequenceGaps: { rows: SequenceGapRow[] };
}

const UNKNOWN_USER = "غير معروف";

function pct(x: Decimal): string {
  return x.times(100).toDecimalPlaces(2).toFixed(2);
}

/** عتبة العلم النسبية: max(المضاعف × متوسط النطاق، الأرضية). */
function rateThreshold(scopeAvg: Decimal, floor: Decimal): Decimal {
  const scaled = scopeAvg.times(FLAG_RATE_MULTIPLIER);
  return scaled.gt(floor) ? scaled : floor;
}

/**
 * يبني تقرير رقيب الشذوذ للفترة [from, to] (YYYY-MM-DD شاملة الطرفين) بعزل فرع اختياري.
 * branchId يصل من scopedBranchId في الراوتر حصراً (غير الأدمن مقيَّد بفرعه هناك).
 */
export async function getAnomalyWatch(opts: {
  from: string;
  to: string;
  branchId?: number;
}): Promise<AnomalyWatchResult> {
  const db = getDb();
  const generatedAt = new Date().toISOString();
  const empty: AnomalyWatchResult = {
    generatedAt,
    from: opts.from,
    to: opts.to,
    kpis: {
      belowCostLines: 0,
      belowCostLoss: "0.00",
      flaggedDiscountCashiers: 0,
      flaggedReturnSellers: 0,
      flaggedShortageCashiers: 0,
      reversedVouchers: 0,
      sequenceGapDays: 0,
    },
    belowCost: { cashiers: [], worstLines: [] },
    discounts: { rows: [], scopeAvgRatePct: "0.00" },
    returns: { sellers: [], processors: [], scopeAvgRatePct: "0.00" },
    shiftShortages: { rows: [] },
    reversedVouchers: { rows: [] },
    sequenceGaps: { rows: [] },
  };
  if (!db) return empty;

  // حدود timestamp: ‎[بداية from محلياً، بداية اليوم التالي لـto) — نمط dateRange المعتمد.
  const fromTs = localDayStart(opts.from);
  const toTs = localNextDayStart(opts.to);
  const branchId = opts.branchId;
  const branchInv = branchId ? sql`AND i.branchId = ${branchId}` : sql``;
  const branchShift = branchId ? sql`AND s.branchId = ${branchId}` : sql``;
  const branchReceipt = branchId ? sql`AND r.branchId = ${branchId}` : sql``;
  const branchAudit = branchId ? sql`AND a.branchId = ${branchId}` : sql``;

  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };

  // ── D1أ: بيع دون الكلفة — تجميع لكل كاشير ──
  // السطر دون الكلفة: total (صافي السطر بعد كل الخصومات) < baseQuantity × unitCost، والكلفة معروفة (> 0)
  // كي لا تُعلَّم الخدمات/الهدايا مجهولة الكلفة. CANCELLED مستبعدة (لا وجود لها من التطبيق أصلاً).
  const belowCostCashiersP = safe(
    db.execute(sql`
      SELECT i.createdBy AS userId, u.name AS userName,
        COUNT(*) AS lineCount,
        CAST(COALESCE(SUM(ii.baseQuantity * ii.unitCost - ii.total), 0) AS CHAR) AS lossValue
      FROM invoiceItems ii
      JOIN invoices i ON i.id = ii.invoiceId
      LEFT JOIN users u ON u.id = i.createdBy
      WHERE i.invoiceStatus <> 'CANCELLED'
        AND i.invoiceDate >= ${fromTs} AND i.invoiceDate < ${toTs}
        AND ii.unitCost > 0
        AND ii.total < ii.baseQuantity * ii.unitCost
        ${branchInv}
      GROUP BY i.createdBy, u.name
      ORDER BY SUM(ii.baseQuantity * ii.unitCost - ii.total) DESC
    `),
    null,
  );

  // ── D1ب: أسوأ الأسطر دون الكلفة ──
  const belowCostLinesP = safe(
    db.execute(sql`
      SELECT i.id AS invoiceId, i.invoiceNumber,
        DATE_FORMAT(i.invoiceDate, '%Y-%m-%d') AS invoiceDate,
        u.name AS userName, p.name AS productName,
        CAST(ii.quantity AS CHAR) AS quantity,
        CAST(ii.total AS CHAR) AS lineTotal,
        CAST(ii.baseQuantity * ii.unitCost AS CHAR) AS lineCost,
        CAST(ii.baseQuantity * ii.unitCost - ii.total AS CHAR) AS lossValue
      FROM invoiceItems ii
      JOIN invoices i ON i.id = ii.invoiceId
      JOIN productVariants v ON v.id = ii.variantId
      JOIN products p ON p.id = v.productId
      LEFT JOIN users u ON u.id = i.createdBy
      WHERE i.invoiceStatus <> 'CANCELLED'
        AND i.invoiceDate >= ${fromTs} AND i.invoiceDate < ${toTs}
        AND ii.unitCost > 0
        AND ii.total < ii.baseQuantity * ii.unitCost
        ${branchInv}
      ORDER BY (ii.baseQuantity * ii.unitCost - ii.total) DESC
      LIMIT ${WORST_LINES_LIMIT}
    `),
    null,
  );

  // ── D2: الخصومات لكل كاشير ──
  // gross = قيمة البيع قبل كل الخصومات = subtotal (صافي الأسطر) + خصوم الأسطر اليدوية + خصوم العروض.
  // الخصم اليدوي = خصم رأس الفاتورة + خصوم الأسطر (computeLineTotal يخزّن النسبة مبلغاً في discountAmount).
  const discountsP = safe(
    db.execute(sql`
      SELECT t.userId, u.name AS userName,
        COUNT(*) AS invoiceCount,
        CAST(COALESCE(SUM(t.gross), 0) AS CHAR) AS grossTotal,
        CAST(COALESCE(SUM(t.manualDisc), 0) AS CHAR) AS manualDiscount,
        CAST(COALESCE(SUM(t.promoDisc), 0) AS CHAR) AS promoDiscount
      FROM (
        SELECT i.id, i.createdBy AS userId,
          i.discountAmount + COALESCE(SUM(ii.discountAmount), 0) AS manualDisc,
          COALESCE(SUM(ii.promotionDiscount), 0) AS promoDisc,
          i.subtotal + COALESCE(SUM(ii.discountAmount), 0) + COALESCE(SUM(ii.promotionDiscount), 0) AS gross
        FROM invoices i
        LEFT JOIN invoiceItems ii ON ii.invoiceId = i.id
        WHERE i.invoiceStatus <> 'CANCELLED'
          AND i.invoiceDate >= ${fromTs} AND i.invoiceDate < ${toTs}
          ${branchInv}
        GROUP BY i.id, i.createdBy, i.discountAmount, i.subtotal
      ) t
      LEFT JOIN users u ON u.id = t.userId
      GROUP BY t.userId, u.name
      ORDER BY SUM(t.manualDisc) DESC
    `),
    null,
  );

  // ── D3أ: المرتجعات على بائع الفاتورة الأصلية ──
  const returnSellersP = safe(
    db.execute(sql`
      SELECT i.createdBy AS userId, u.name AS userName,
        COUNT(*) AS invoiceCount,
        CAST(COALESCE(SUM(i.total), 0) AS CHAR) AS salesTotal,
        CAST(COALESCE(SUM(i.returnedTotal), 0) AS CHAR) AS returnedTotal
      FROM invoices i
      LEFT JOIN users u ON u.id = i.createdBy
      WHERE i.invoiceStatus <> 'CANCELLED'
        AND i.invoiceDate >= ${fromTs} AND i.invoiceDate < ${toTs}
        ${branchInv}
      GROUP BY i.createdBy, u.name
      HAVING SUM(i.total) > 0
      ORDER BY SUM(i.returnedTotal) DESC
    `),
    null,
  );

  // ── D3ب: معالجو الإرجاع (سجلّ التدقيق — best-effort) ──
  const returnProcessorsP = safe(
    db.execute(sql`
      SELECT a.userId, u.name AS userName, COUNT(*) AS opsCount
      FROM auditLogs a
      LEFT JOIN users u ON u.id = a.userId
      WHERE a.action = 'return.create'
        AND a.createdAt >= ${fromTs} AND a.createdAt < ${toTs}
        ${branchAudit}
      GROUP BY a.userId, u.name
      ORDER BY opsCount DESC
    `),
    null,
  );

  // ── D4: عجوزات/فوائض الورديات لكل كاشير ──
  const shortagesP = safe(
    db.execute(sql`
      SELECT s.userId, u.name AS userName,
        COUNT(*) AS closedShifts,
        SUM(CASE WHEN s.variance < 0 THEN 1 ELSE 0 END) AS shortageShifts,
        CAST(COALESCE(SUM(CASE WHEN s.variance < 0 THEN -s.variance ELSE 0 END), 0) AS CHAR) AS totalShortage,
        CAST(COALESCE(SUM(CASE WHEN s.variance > 0 THEN s.variance ELSE 0 END), 0) AS CHAR) AS totalSurplus
      FROM shifts s
      LEFT JOIN users u ON u.id = s.userId
      WHERE s.shiftStatus = 'CLOSED'
        AND s.variance IS NOT NULL
        AND s.closedAt >= ${fromTs} AND s.closedAt < ${toTs}
        ${branchShift}
      GROUP BY s.userId, u.name
      HAVING shortageShifts > 0 OR totalSurplus > 0
      ORDER BY SUM(CASE WHEN s.variance < 0 THEN -s.variance ELSE 0 END) DESC
    `),
    null,
  );

  // ── D5: السندات المعكوسة (تاريخ العكس = createdAt لسند التعويض CANCEL-VCH-{id}) ──
  const reversedP = safe(
    db.execute(sql`
      SELECT r.id AS receiptId, r.voucherNumber, r.direction,
        CAST(r.amount AS CHAR) AS amount,
        uc.name AS createdByName,
        c.createdBy AS reversedById, ur.name AS reversedByName,
        DATE_FORMAT(COALESCE(c.createdAt, r.createdAt), '%Y-%m-%d %H:%i') AS reversedAt
      FROM receipts r
      LEFT JOIN receipts c ON c.referenceNumber = CONCAT('CANCEL-VCH-', r.id)
      LEFT JOIN users uc ON uc.id = r.createdBy
      LEFT JOIN users ur ON ur.id = c.createdBy
      WHERE r.voucherNumber IS NOT NULL
        AND r.receiptStatus = 'REVERSED'
        AND COALESCE(c.createdAt, r.createdAt) >= ${fromTs}
        AND COALESCE(c.createdAt, r.createdAt) < ${toTs}
        ${branchReceipt}
      ORDER BY COALESCE(c.createdAt, r.createdAt) DESC
    `),
    null,
  );

  // ── D6: فجوات تسلسل INV-{فرع}-{YYYYMMDD}-{seq5} لكل (فرع×يوم) ──
  const gapsP = safe(
    db.execute(sql`
      SELECT t.branchId, b.name AS branchName, t.ymd,
        COUNT(*) AS actualCount, MAX(t.seq) AS maxSeq, MIN(t.seq) AS minSeq
      FROM (
        SELECT i.branchId,
          SUBSTRING_INDEX(SUBSTRING_INDEX(i.invoiceNumber, '-', 3), '-', -1) AS ymd,
          CAST(SUBSTRING_INDEX(i.invoiceNumber, '-', -1) AS UNSIGNED) AS seq
        FROM invoices i
        WHERE i.invoiceNumber LIKE 'INV-%'
          AND i.invoiceDate >= ${fromTs} AND i.invoiceDate < ${toTs}
          ${branchInv}
      ) t
      LEFT JOIN branches b ON b.id = t.branchId
      GROUP BY t.branchId, b.name, t.ymd
      HAVING MAX(t.seq) <> COUNT(*) OR MIN(t.seq) <> 1
      ORDER BY t.ymd DESC
    `),
    null,
  );

  const [belowCashRes, belowLinesRes, discRes, retSellersRes, retProcRes, shortRes, revRes, gapsRes] =
    await Promise.all([
      belowCostCashiersP,
      belowCostLinesP,
      discountsP,
      returnSellersP,
      returnProcessorsP,
      shortagesP,
      reversedP,
      gapsP,
    ]);

  // ── D1: تجميع ──
  const belowCostCashiers: BelowCostCashierRow[] = rowsOf(belowCashRes).map((r) => ({
    userId: r.userId == null ? null : Number(r.userId),
    userName: r.userName ?? UNKNOWN_USER,
    lineCount: Number(r.lineCount ?? 0),
    lossValue: toDbMoney(money(r.lossValue ?? 0)),
  }));
  const worstLines: BelowCostLineRow[] = rowsOf(belowLinesRes).map((r) => ({
    invoiceId: Number(r.invoiceId),
    invoiceNumber: String(r.invoiceNumber ?? ""),
    invoiceDate: String(r.invoiceDate ?? ""),
    userName: r.userName ?? UNKNOWN_USER,
    productName: r.productName ?? "",
    quantity: String(r.quantity ?? "0"),
    lineTotal: toDbMoney(money(r.lineTotal ?? 0)),
    lineCost: toDbMoney(money(r.lineCost ?? 0)),
    lossValue: toDbMoney(money(r.lossValue ?? 0)),
  }));
  const belowCostLines = belowCostCashiers.reduce((a, r) => a + r.lineCount, 0);
  const belowCostLoss = toDbMoney(
    belowCostCashiers.reduce<Decimal>((a, r) => a.plus(money(r.lossValue)), new Decimal(0)),
  );

  // ── D2: نسب وأعلام الخصومات ──
  const discRaw = rowsOf(discRes);
  const discGrossSum = discRaw.reduce<Decimal>((a, r) => a.plus(money(r.grossTotal ?? 0)), new Decimal(0));
  const discManualSum = discRaw.reduce<Decimal>((a, r) => a.plus(money(r.manualDiscount ?? 0)), new Decimal(0));
  const discScopeAvg = discGrossSum.gt(0) ? discManualSum.dividedBy(discGrossSum) : new Decimal(0);
  const discThreshold = rateThreshold(discScopeAvg, FLAG_MIN_DISCOUNT_RATE);
  const discountRows: DiscountCashierRow[] = discRaw.map((r) => {
    const gross = money(r.grossTotal ?? 0);
    const manual = money(r.manualDiscount ?? 0);
    const rate = gross.gt(0) ? manual.dividedBy(gross) : new Decimal(0);
    return {
      userId: r.userId == null ? null : Number(r.userId),
      userName: r.userName ?? UNKNOWN_USER,
      invoiceCount: Number(r.invoiceCount ?? 0),
      grossTotal: toDbMoney(gross),
      manualDiscount: toDbMoney(manual),
      promoDiscount: toDbMoney(money(r.promoDiscount ?? 0)),
      discountRatePct: pct(rate),
      flagged: manual.gt(0) && rate.gte(discThreshold),
    };
  });

  // ── D3: نسب وأعلام المرتجعات ──
  const retRaw = rowsOf(retSellersRes);
  const retSalesSum = retRaw.reduce<Decimal>((a, r) => a.plus(money(r.salesTotal ?? 0)), new Decimal(0));
  const retReturnedSum = retRaw.reduce<Decimal>((a, r) => a.plus(money(r.returnedTotal ?? 0)), new Decimal(0));
  const retScopeAvg = retSalesSum.gt(0) ? retReturnedSum.dividedBy(retSalesSum) : new Decimal(0);
  const retThreshold = rateThreshold(retScopeAvg, FLAG_MIN_RETURN_RATE);
  const returnSellers: ReturnSellerRow[] = retRaw.map((r) => {
    const sales = money(r.salesTotal ?? 0);
    const returned = money(r.returnedTotal ?? 0);
    const rate = sales.gt(0) ? returned.dividedBy(sales) : new Decimal(0);
    return {
      userId: r.userId == null ? null : Number(r.userId),
      userName: r.userName ?? UNKNOWN_USER,
      invoiceCount: Number(r.invoiceCount ?? 0),
      salesTotal: toDbMoney(sales),
      returnedTotal: toDbMoney(returned),
      returnRatePct: pct(rate),
      flagged: returned.gt(0) && rate.gte(retThreshold),
    };
  });
  const returnProcessors: ReturnProcessorRow[] = rowsOf(retProcRes).map((r) => ({
    userId: r.userId == null ? null : Number(r.userId),
    userName: r.userName ?? UNKNOWN_USER,
    opsCount: Number(r.opsCount ?? 0),
  }));

  // ── D4: أعلام العجوزات ──
  const shortageRows: ShiftShortageRow[] = rowsOf(shortRes).map((r) => {
    const shortage = money(r.totalShortage ?? 0);
    const shortageShifts = Number(r.shortageShifts ?? 0);
    return {
      userId: Number(r.userId),
      userName: r.userName ?? UNKNOWN_USER,
      closedShifts: Number(r.closedShifts ?? 0),
      shortageShifts,
      totalShortage: toDbMoney(shortage),
      totalSurplus: toDbMoney(money(r.totalSurplus ?? 0)),
      flagged: shortageShifts >= FLAG_SHORTAGE_MIN_SHIFTS || shortage.gte(FLAG_SHORTAGE_TOTAL_IQD),
    };
  });

  // ── D5: أعلام العكوس (≥ حدّ لكل عاكس بالفترة) ──
  const revRaw = rowsOf(revRes);
  const reversalsByUser = new Map<number, number>();
  for (const r of revRaw) {
    if (r.reversedById != null) {
      const id = Number(r.reversedById);
      reversalsByUser.set(id, (reversalsByUser.get(id) ?? 0) + 1);
    }
  }
  const reversedRows: ReversedVoucherRow[] = revRaw.map((r) => ({
    receiptId: Number(r.receiptId),
    voucherNumber: String(r.voucherNumber ?? ""),
    direction: r.direction === "OUT" ? "OUT" : "IN",
    amount: toDbMoney(money(r.amount ?? 0)),
    createdByName: r.createdByName ?? UNKNOWN_USER,
    reversedById: r.reversedById == null ? null : Number(r.reversedById),
    reversedByName: r.reversedByName ?? UNKNOWN_USER,
    reversedAt: String(r.reversedAt ?? ""),
    flagged:
      r.reversedById != null &&
      (reversalsByUser.get(Number(r.reversedById)) ?? 0) >= FLAG_REVERSALS_PER_USER,
  }));

  // ── D6: الفجوات ──
  const gapRows: SequenceGapRow[] = rowsOf(gapsRes).map((r) => {
    const actual = Number(r.actualCount ?? 0);
    const maxSeq = Number(r.maxSeq ?? 0);
    const minSeq = Number(r.minSeq ?? 0);
    return {
      branchId: Number(r.branchId),
      branchName: r.branchName ?? String(r.branchId),
      day: String(r.ymd ?? ""),
      actualCount: actual,
      maxSeq,
      minSeq,
      // المتوقع 1..maxSeq (التسلسل يبدأ من 1) ⇒ المفقود = maxSeq − الموجود (HAVING يضمن ≥ 1).
      missing: Math.max(maxSeq - actual, 1),
    };
  });

  return {
    generatedAt,
    from: opts.from,
    to: opts.to,
    kpis: {
      belowCostLines,
      belowCostLoss,
      flaggedDiscountCashiers: discountRows.filter((r) => r.flagged).length,
      flaggedReturnSellers: returnSellers.filter((r) => r.flagged).length,
      flaggedShortageCashiers: shortageRows.filter((r) => r.flagged).length,
      reversedVouchers: reversedRows.length,
      sequenceGapDays: gapRows.length,
    },
    belowCost: { cashiers: belowCostCashiers, worstLines },
    discounts: { rows: discountRows, scopeAvgRatePct: pct(discScopeAvg) },
    returns: { sellers: returnSellers, processors: returnProcessors, scopeAvgRatePct: pct(retScopeAvg) },
    shiftShortages: { rows: shortageRows },
    reversedVouchers: { rows: reversedRows },
    sequenceGaps: { rows: gapRows },
  };
}
