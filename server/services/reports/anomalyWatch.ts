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
import { MATERIALIZED_RECEIPT_STATUS_SQL } from "../cash/cashAvailability";

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
/** سحب بضاعة الأمانة: يُعلَّم مُنشئ ≥ هذا العدد من سندات السحب/الاستبدال بالفترة (SOD فاعل واحد). */
const FLAG_CONSIGN_WITHDRAWALS_PER_USER = 3;
/** D8 (ش٤): مسوّدات مموّلة أُلغيت بلا تثبيت — يُعلَّم مُنشئ ≥ هذا العدد بالفترة (نمط
 *  «اقبض ثم رُدّ ثم ألغِ» المتكرّر أثرُ تلاعبٍ محتملٌ بالدرج وإن كان كل مستندٍ فردياً سليماً). */
const FLAG_CANCELLED_FUNDED_DRAFTS_PER_USER = 2;
/** D9 (ش٥ — §٩.٤): نسبة «رصيد زين» من تحصيل الموظف — الطريقة الوحيدة بلا مُثبِتٍ خارجيّ
 *  (لا قسيمة جهازٍ ولا سجلّ مصرف)، فتركّزها لدى موظفٍ إشارةُ «قبض نقدٍ سُجِّل رصيداً». */
const FLAG_TELECOM_SHARE = new Decimal("0.30");
/** أرضية مبلغ زين بالفترة قبل احتساب النسبة (يمنع أعلام موظفٍ حصّل ٥ آلاف كلها زين). */
const FLAG_TELECOM_MIN_TOTAL = new Decimal("100000");
/** D11 (ش٦): تسديداتٌ على فواتير أنشأها غير القابض — يُعلَّم القابض عند ≥ هذا العدد بالفترة. */
const FLAG_OTHERS_COLLECT_PER_USER = 5;
/** D12 (ش٦): خفض إجمالي مسوّدةٍ مموّلة بعد القبض — يُعلَّم الفاعل عند ≥ هذا العدد بالفترة. */
const FLAG_FUNDED_REDUCED_PER_USER = 3;
/** D13 (توصيل ١٠/٨): عهدة مندوبٍ متقادمة — يُعلَّم مَن أقدمُ إرساليةٍ مفتوحةٍ له ≥ هذه الأيام. */
const FLAG_DELIVERY_CUSTODY_AGE_DAYS = 14;
/** D13: أو عهدة ≥ هذا المبلغ (د.ع) بعمر ≥ نصف الحدّ — نقد كبير بيد مندوب لا يُنتظر أسبوعين. */
const FLAG_DELIVERY_CUSTODY_IQD = new Decimal("200000");
/** D14 (توصيل ١٠/٨): تكرار توريداتٍ بعجز (SHORT) لنفس الجهة بالفترة — نمط «سلّم أقل» المزمن. */
const FLAG_DELIVERY_SHORT_REMITS = 3;
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
/** D7: تركّز سحوبات بضاعة الأمانة لكل مُنشئ (ضابط تعويضيّ لـSOD السحب أحاديّ الفاعل). */
export interface ConsignWithdrawRow {
  userId: number | null;
  userName: string;
  /** عدد سندات السحب + الاستبدال التي أنشأها. */
  noteCount: number;
  /** إجمالي الوحدات الأساس المسحوبة (أسطر OUT). */
  totalQty: number;
  /** قيمة الحصص المسحوبة بلقطة السند = Σ(baseQuantity × unitShareSnapshot). */
  totalValue: string;
  flagged: boolean;
}

/** D8 (ش٤): مسوّدات استقبالٍ مموّلة أُلغيت بلا تثبيت — لكل مُنشئ (يُشحن مع ميزة العرابين). */
export interface CancelledFundedDraftRow {
  userId: number | null;
  userName: string;
  draftCount: number;
  /** Σ ما قُبض على تلك المسوّدات (COLLECTION). */
  collectedTotal: string;
  /** Σ ما رُدّ منها (REFUND) — يساوي المقبوض حتماً قبل الإلغاء (شرط الإلغاء صافي صفر). */
  refundedTotal: string;
  flagged: boolean;
}

/** D9 (ش٥): تركيبة تحصيل الموظف — حصّة رصيد زين من وارده. */
export interface TelecomShareRow {
  userId: number | null;
  userName: string;
  telecomIn: string;
  totalIn: string;
  /** النسبة المئوية (0-100) بنصّين عشريين. */
  sharePct: string;
  receiptCount: number;
  flagged: boolean;
}

/** D10 (ش٦): مسوّدة مموّلة OPEN معلّقة > ٢٤ ساعة — كل صفٍّ إنذار. */
export interface FundedStaleDraftRow {
  draftId: number;
  draftNumber: string;
  userId: number | null;
  userName: string;
  heldNet: string;
  ageHours: number;
}
/** D11 (ش٦): تركّز التسديدات على فواتير أنشأها غير القابض. */
export interface OthersCollectRow {
  userId: number | null;
  userName: string;
  receiptCount: number;
  totalAmount: string;
  flagged: boolean;
}
/** D12 (ش٦): خفض إجمالي مسوّدةٍ مموّلة بعد القبض (من حدث التدقيق). */
export interface FundedReducedRow {
  userId: number | null;
  userName: string;
  eventCount: number;
  flagged: boolean;
}

/** D13 (توصيل): عهدة جهةٍ متقادمة — لقطة حالةٍ راهنة (لا تتقيد بنطاق التاريخ، كنمط D10). */
export interface DeliveryCustodyAgingRow {
  partyId: number;
  partyName: string;
  balance: string;
  openCount: number;
  oldestDays: number | null;
  flagged: boolean;
}
/** D14 (توصيل): توريدات بعجز متكرّرة لنفس الجهة بالفترة. */
export interface DeliveryShortRemitRow {
  partyId: number;
  partyName: string;
  remitCount: number;
  shortCount: number;
  shortfallTotal: string;
  flagged: boolean;
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
    flaggedConsignWithdrawers: number;
    flaggedCancelledFundedDrafters: number;
    flaggedTelecomCollectors: number;
    fundedStaleDrafts: number;
    flaggedOthersCollectors: number;
    flaggedFundedReducers: number;
    flaggedDeliveryCustody: number;
    flaggedDeliveryShortRemits: number;
  };
  belowCost: { cashiers: BelowCostCashierRow[]; worstLines: BelowCostLineRow[] };
  discounts: { rows: DiscountCashierRow[]; scopeAvgRatePct: string };
  returns: { sellers: ReturnSellerRow[]; processors: ReturnProcessorRow[]; scopeAvgRatePct: string };
  shiftShortages: { rows: ShiftShortageRow[] };
  reversedVouchers: { rows: ReversedVoucherRow[] };
  sequenceGaps: { rows: SequenceGapRow[] };
  consignWithdrawals: { rows: ConsignWithdrawRow[] };
  cancelledFundedDrafts: { rows: CancelledFundedDraftRow[] };
  telecomShares: { rows: TelecomShareRow[] };
  fundedStaleDrafts: { rows: FundedStaleDraftRow[] };
  othersCollections: { rows: OthersCollectRow[] };
  fundedReductions: { rows: FundedReducedRow[] };
  deliveryCustodyAging: { rows: DeliveryCustodyAgingRow[] };
  deliveryShortRemits: { rows: DeliveryShortRemitRow[] };
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
      flaggedConsignWithdrawers: 0,
      flaggedCancelledFundedDrafters: 0,
      flaggedTelecomCollectors: 0,
      fundedStaleDrafts: 0,
      flaggedOthersCollectors: 0,
      flaggedFundedReducers: 0,
      flaggedDeliveryCustody: 0,
      flaggedDeliveryShortRemits: 0,
    },
    belowCost: { cashiers: [], worstLines: [] },
    discounts: { rows: [], scopeAvgRatePct: "0.00" },
    returns: { sellers: [], processors: [], scopeAvgRatePct: "0.00" },
    shiftShortages: { rows: [] },
    reversedVouchers: { rows: [] },
    sequenceGaps: { rows: [] },
    consignWithdrawals: { rows: [] },
    cancelledFundedDrafts: { rows: [] },
    telecomShares: { rows: [] },
    fundedStaleDrafts: { rows: [] },
    othersCollections: { rows: [] },
    fundedReductions: { rows: [] },
    deliveryCustodyAging: { rows: [] },
    deliveryShortRemits: { rows: [] },
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
  const branchConsign = branchId ? sql`AND n.branchId = ${branchId}` : sql``;

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

  // ── D6: فجوات تسلسل الفواتير ──
  //
  // ⚠️ صيغتان تتعايشان (١٨/٨): التاريخية `INV-{فرع}-{YYYYMMDD}-{seq5}` تسلسلُها **لكل فرعٍ
  // ويوم**؛ والجديدة رقمٌ عالميّ متسلسل من عدّادٍ ذرّيّ (هجرة 0211). الكاشف كان مقصوراً على
  // `LIKE 'INV-%'` ⇒ مع الصيغة الجديدة يعيد صفر صفوف ويعمى **صامتاً** (لا خطأ ولا نتيجة) —
  // أسوأ من الانهيار. الآن فرعان صريحان يجمعهما UNION، كلٌّ بدلالة تسلسله.
  //
  // في الصيغة الجديدة `ymd` هو تاريخُ الفاتورة لا جزءٌ من الرقم، والفجوة تُقاس على المدى
  // (max−min+1) لا على البدء من ١: العدّاد عالميّ فلا يبدأ كلّ يومٍ من الواحد.
  const gapsP = safe(
    db.execute(sql`
      SELECT t.branchId, b.name AS branchName, t.ymd,
        COUNT(*) AS actualCount, MAX(t.seq) AS maxSeq, MIN(t.seq) AS minSeq
      FROM (
        SELECT i.branchId,
          SUBSTRING_INDEX(SUBSTRING_INDEX(i.invoiceNumber, '-', 3), '-', -1) AS ymd,
          CAST(SUBSTRING_INDEX(i.invoiceNumber, '-', -1) AS UNSIGNED) AS seq,
          0 AS isSequential
        FROM invoices i
        WHERE i.invoiceNumber LIKE 'INV-%'
          AND i.invoiceDate >= ${fromTs} AND i.invoiceDate < ${toTs}
          ${branchInv}
      ) t
      LEFT JOIN branches b ON b.id = t.branchId
      GROUP BY t.branchId, b.name, t.ymd
      HAVING MAX(t.seq) <> COUNT(*) OR MIN(t.seq) <> 1

      UNION ALL

      -- ٢٠/٨ (تصويب مراجعة Codex): الترقيمُ الجديد **عدّادٌ عالميّ** لا يُعاد لكلّ فرعٍ
      -- ويوم. فتجزئتُه بـ(فرع×يوم) تُعلن فجواتٍ كاذبةً من التداخل الطبيعيّ: الفرع ١ يأخذ
      -- 10001 والفرع ٢ يأخذ 10002 والفرع ١ يأخذ 10003 ⇒ مجموعةُ الفرع ١ تُبلّغ عن «10002
      -- مفقود» وهو فاتورةٌ صحيحةٌ في فرعٍ آخر. وحدُّ اليوم يفعل الشيء نفسه عند منتصف الليل.
      -- ⇒ يُفحَص المدى **عالمياً** بلا تجميع. ويُسكَت الفحصُ كلّياً حين يكون النطاق مقيَّداً
      -- بفرع، إذ لا معنى لاتّصال عدّادٍ عالميّ داخل شريحةِ فرعٍ واحد.
      SELECT NULL AS branchId, NULL AS branchName, NULL AS ymd,
        COUNT(*) AS actualCount, MAX(t.seq) AS maxSeq, MIN(t.seq) AS minSeq
      FROM (
        SELECT CAST(i.invoiceNumber AS UNSIGNED) AS seq
        FROM invoices i
        WHERE i.invoiceNumber REGEXP '^[0-9]+$'
          AND i.invoiceDate >= ${fromTs} AND i.invoiceDate < ${toTs}
      ) t
      WHERE ${branchId == null ? sql`1 = 1` : sql`1 = 0`}
      HAVING COUNT(*) > 0 AND MAX(t.seq) - MIN(t.seq) + 1 <> COUNT(*)
      ORDER BY ymd DESC
    `),
    null,
  );

  // ── D7: تركّز سحوبات بضاعة الأمانة لكل مُنشئ ──
  // السحب/الاستبدال يعيد بضاعة المودِع بلا فاعلٍ ثانٍ (SOD أحاديّ) ⇒ يُعدّ ويُرتَّب لكل مُنشئ.
  // العدّ على أسطر OUT (الاستبدال يحمل أسطر IN مودَعة أيضاً — لا تُحسب سحباً). القيمة بلقطة الحصة (توثيقية).
  const consignWithdrawP = safe(
    db.execute(sql`
      SELECT n.createdBy AS userId, u.name AS userName,
        COUNT(DISTINCT n.id) AS noteCount,
        CAST(COALESCE(SUM(l.baseQuantity), 0) AS CHAR) AS totalQty,
        CAST(COALESCE(SUM(l.baseQuantity * l.unitShareSnapshot), 0) AS CHAR) AS totalValue
      FROM consignmentNotes n
      JOIN consignmentNoteLines l ON l.noteId = n.id AND l.lineDirection = 'OUT'
      LEFT JOIN users u ON u.id = n.createdBy
      WHERE n.noteType IN ('WITHDRAW', 'EXCHANGE')
        AND n.createdAt >= ${fromTs} AND n.createdAt < ${toTs}
        ${branchConsign}
      GROUP BY n.createdBy, u.name
      ORDER BY COUNT(DISTINCT n.id) DESC
    `),
    null,
  );

  // ── D8 (ش٤): «قبضٌ ثم ردٌّ بلا تثبيت» — لكل فاعل ──
  // مراجعة ش٤ العدائية: النسخة الأولى اشترطت CANCELLED فكانت عمياء بنيوياً عن الفاعل الوحيد
  // المصمَّمة لمراقبته — الكاشير لا يملك إلغاء المموّلة (مديريّ) فمسوّدته تبقى OPEN أبداً بعد
  // «اقبض بإيصال ثم رُدّ لنفسك». الإشارتان الآن: (أ) مسوّدة مموّلة أُلغيت (لمنشئها)، أو
  // (ب) قبضٌ رُدَّ **كاملاً** على مسوّدة غير مثبّتة أياً كانت حالتها (لرادّ المال — هو من مسّه).
  const branchDraft = branchId ? sql`AND d.branchId = ${branchId}` : sql``;
  const branchDraft2 = branchId ? sql`AND d2.branchId = ${branchId}` : sql``;
  const cancelledFundedP = safe(
    db.execute(sql`
      SELECT a.userId AS userId, u.name AS userName,
        COUNT(DISTINCT a.draftId) AS draftCount,
        CAST(COALESCE(SUM(a.collected), 0) AS CHAR) AS collectedTotal,
        CAST(COALESCE(SUM(a.refunded), 0) AS CHAR) AS refundedTotal
      FROM (
        SELECT d.createdBy AS userId, d.id AS draftId,
          (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op WHERE op.draftId = d.id AND op.orderPayKind = 'COLLECTION') AS collected,
          (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op WHERE op.draftId = d.id AND op.orderPayKind = 'REFUND') AS refunded
        FROM receptionDrafts d
        WHERE d.draftStatus = 'CANCELLED' AND d.moneyLocked = 1
          AND d.cancelledAt >= ${fromTs} AND d.cancelledAt < ${toTs}
          ${branchDraft}
        UNION
        SELECT DISTINCT rf.createdBy AS userId, d2.id AS draftId,
          (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op WHERE op.draftId = d2.id AND op.orderPayKind = 'COLLECTION') AS collected,
          (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op WHERE op.draftId = d2.id AND op.orderPayKind = 'REFUND') AS refunded
        FROM orderPayments rf
        JOIN orderPayments coll ON coll.id = rf.parentPaymentId
        JOIN receptionDrafts d2 ON d2.id = coll.draftId
        WHERE rf.orderPayKind = 'REFUND' AND coll.orderPayStatus = 'REFUNDED'
          AND d2.draftStatus NOT IN ('COMMITTED', 'CANCELLED')
          AND rf.createdAt >= ${fromTs} AND rf.createdAt < ${toTs}
          ${branchDraft2}
      ) a
      LEFT JOIN users u ON u.id = a.userId
      GROUP BY a.userId, u.name
      ORDER BY COUNT(DISTINCT a.draftId) DESC
    `),
    null,
  );

  // ── D9 (ش٥): نسبة رصيد زين من وارد كل موظف — TELECOM بلا مُثبِتٍ خارجيّ، وتركّزه لدى
  // موظفٍ (فوق أرضية مبلغ) إشارةُ «نقدٌ قُبض وسُجِّل رصيداً» فالدرج يُغلق بفارغ صفرٍ زوراً.
  const telecomShareP = safe(
    db.execute(sql`
      SELECT r.createdBy AS userId, u.name AS userName,
        CAST(COALESCE(SUM(CASE WHEN r.paymentMethod = 'TELECOM' THEN r.amount ELSE 0 END), 0) AS CHAR) AS telecomIn,
        CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS totalIn,
        SUM(CASE WHEN r.paymentMethod = 'TELECOM' THEN 1 ELSE 0 END) AS telecomCount
      FROM receipts r
      LEFT JOIN users u ON u.id = r.createdBy
      WHERE r.direction = 'IN' AND r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
        AND r.receiptApprovalStatus = 'APPROVED'
        AND r.createdAt >= ${fromTs} AND r.createdAt < ${toTs}
        ${branchReceipt}
      GROUP BY r.createdBy, u.name
      HAVING SUM(CASE WHEN r.paymentMethod = 'TELECOM' THEN r.amount ELSE 0 END) > 0
      ORDER BY telecomIn DESC
    `),
    null,
  );

  // ── D10 (ش٦): مسوّدات مموّلة OPEN معلّقة > ٢٤ ساعة — مال زبونٍ محتجزٌ بلا مستند نهائيّ.
  //    كاشف حالةٍ راهنة (لا يتقيّد بنطاق التاريخ): كل صفٍّ إنذارٌ بذاته.
  const fundedStaleP = safe(
    db.execute(sql`
      SELECT x.draftId, x.draftNumber, x.userId, u.name AS userName,
        CAST(x.heldNet AS CHAR) AS heldNet, x.ageHours
      FROM (
        SELECT d.id AS draftId, d.draftNumber AS draftNumber, d.createdBy AS userId,
          -- تدقيق ٦/٨ (ث١٣، مرآة إقفال اليوم): البسط يشمل REFUNDED وإلّا طُرح ردٌّ لم يُجمع أصلُه.
          (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op
            WHERE op.draftId = d.id AND op.orderPayKind = 'COLLECTION'
              AND op.orderPayStatus IN ('HELD','REFUNDED'))
          - (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op
            WHERE op.draftId = d.id AND op.orderPayKind = 'REFUND') AS heldNet,
          TIMESTAMPDIFF(HOUR, d.createdAt, NOW()) AS ageHours
        FROM receptionDrafts d
        WHERE d.draftStatus = 'OPEN' AND d.moneyLocked = 1
          AND d.createdAt < DATE_SUB(NOW(), INTERVAL 24 HOUR)
          ${branchDraft}
      ) x
      LEFT JOIN users u ON u.id = x.userId
      WHERE x.heldNet > 0
      ORDER BY x.ageHours DESC
      LIMIT 100
    `),
    null,
  );

  // ── D11 (ش٦): تركّز التسديدات على فواتير الغير — موظفٌ يكثر قبضُه على فواتير أنشأها غيره
  //    (القبض مشروعٌ بنطاق الفرع §٩.٣، لكنّ تركّزه إشارةُ التفافٍ على مساءلة الدرج/العمولة).
  const othersCollectP = safe(
    db.execute(sql`
      SELECT r.createdBy AS userId, u.name AS userName,
        COUNT(*) AS receiptCount,
        CAST(COALESCE(SUM(r.amount), 0) AS CHAR) AS totalAmount
      FROM receipts r
      JOIN invoices i ON i.id = r.invoiceId
      LEFT JOIN users u ON u.id = r.createdBy
      WHERE r.direction = 'IN' AND r.receiptStatus ${MATERIALIZED_RECEIPT_STATUS_SQL}
        AND r.receiptApprovalStatus = 'APPROVED'
        AND r.voucherNumber IS NULL
        AND i.createdBy IS NOT NULL AND r.createdBy IS NOT NULL AND i.createdBy <> r.createdBy
        AND r.createdAt >= ${fromTs} AND r.createdAt < ${toTs}
        ${branchReceipt}
      GROUP BY r.createdBy, u.name
      ORDER BY COUNT(*) DESC
    `),
    null,
  );

  // ── D12 (ش٦): خفض إجماليٍّ بعد قبض — من حدث تدقيق reception.fundedTotalReduced (يكتبه
  //    syncDraft داخل المعاملة) مجمَّعاً بالفاعل. best-effort كنمط D3(ب) الموثَّق.
  const fundedReducedP = safe(
    db.execute(sql`
      SELECT a.userId AS userId, u.name AS userName, COUNT(*) AS eventCount
      FROM auditLogs a
      LEFT JOIN users u ON u.id = a.userId
      WHERE a.action = 'reception.fundedTotalReduced'
        AND a.createdAt >= ${fromTs} AND a.createdAt < ${toTs}
        ${branchId ? sql`AND a.branchId = ${branchId}` : sql``}
      GROUP BY a.userId, u.name
      ORDER BY COUNT(*) DESC
    `),
    null,
  );

  // ── D13 (توصيل): عهدة جهةٍ متقادمة — لقطة راهنة (نمط D10): كل جهةٍ رصيدها موجب مع عمر
  //    أقدم إرساليةٍ مفتوحة. عهدة المتجر بلا إرساليات ⇒ oldestDays قد يكون NULL والرصيد موجباً
  //    (تُعلَّم بالمبلغ وحده عند تجاوزه الحدّ — نقدٌ محصَّل بيد المندوب بلا توريد).
  const deliveryCustodyP = safe(
    db.execute(sql`
      SELECT p.id AS partyId, p.name AS partyName,
        CAST(p.currentBalance AS CHAR) AS balance,
        COALESCE(c.openCount, 0) AS openCount,
        c.oldestDays AS oldestDays
      FROM deliveryParties p
      LEFT JOIN (
        SELECT partyId, COUNT(*) AS openCount, MAX(TIMESTAMPDIFF(DAY, dispatchedAt, NOW())) AS oldestDays
        FROM deliveryConsignments
        WHERE consignmentStatus IN ('DISPATCHED','PARTIAL')
        GROUP BY partyId
      ) c ON c.partyId = p.id
      WHERE p.currentBalance > 0
        ${branchId ? sql`AND (p.branchId = ${branchId} OR p.branchId IS NULL)` : sql``}
      ORDER BY p.currentBalance DESC
      LIMIT 100
    `),
    null,
  );

  // ── D14 (توصيل): توريدات بعجز متكرّرة لنفس الجهة بالفترة — «سلّم أقل» المزمن.
  const deliveryShortP = safe(
    db.execute(sql`
      SELECT r.partyId AS partyId, p.name AS partyName,
        COUNT(*) AS remitCount,
        SUM(CASE WHEN r.deliveryRemittanceStatus = 'SHORT' THEN 1 ELSE 0 END) AS shortCount,
        CAST(COALESCE(SUM(r.shortfallTotal), 0) AS CHAR) AS shortfallTotal
      FROM deliveryRemittances r
      LEFT JOIN deliveryParties p ON p.id = r.partyId
      WHERE r.receivedAt >= ${fromTs} AND r.receivedAt < ${toTs}
        ${branchId ? sql`AND r.branchId = ${branchId}` : sql``}
      GROUP BY r.partyId, p.name
      HAVING SUM(CASE WHEN r.deliveryRemittanceStatus = 'SHORT' THEN 1 ELSE 0 END) > 0
      ORDER BY shortCount DESC
    `),
    null,
  );

  const [belowCashRes, belowLinesRes, discRes, retSellersRes, retProcRes, shortRes, revRes, gapsRes, consignWithdrawRes, cancelledFundedRes, telecomShareRes, fundedStaleRes, othersCollectRes, fundedReducedRes, deliveryCustodyRes, deliveryShortRes] =
    await Promise.all([
      belowCostCashiersP,
      belowCostLinesP,
      discountsP,
      returnSellersP,
      returnProcessorsP,
      shortagesP,
      reversedP,
      gapsP,
      consignWithdrawP,
      cancelledFundedP,
      telecomShareP,
      fundedStaleP,
      othersCollectP,
      fundedReducedP,
      deliveryCustodyP,
      deliveryShortP,
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
    // الصفُّ العالميّ (عدّاد الترقيم الجديد) يصل بـ`branchId = NULL` — لا يُصبّ رقماً
    // كاذباً (`Number(null) = 0` كان سيُظهر «فرع #0»).
    const isGlobal = r.branchId == null;
    return {
      branchId: isGlobal ? 0 : Number(r.branchId),
      branchName: isGlobal ? "كل الفروع (تسلسل عامّ)" : (r.branchName ?? String(r.branchId)),
      day: String(r.ymd ?? ""),
      actualCount: actual,
      maxSeq,
      minSeq,
      // المفقود = طولُ المدى المرصود ناقصَ الموجود فيه. الصيغة التاريخية تبدأ من ١ لكل
      // (فرع×يوم) فيؤول هذا إلى `maxSeq − actual`؛ والجديدة عدّادٌ عالميّ لا يبدأ من ١، ولو
      // طُبّقت عليها المعادلة القديمة لأعلنت آلاف المفقودات زوراً في أوّل يوم. (HAVING يضمن ≥١.)
      missing: Math.max(maxSeq - minSeq + 1 - actual, 1),
    };
  });

  // ── D7: أعلام سحوبات الأمانة (≥ حدّ لكل مُنشئ بالفترة) ──
  const consignWithdrawRows: ConsignWithdrawRow[] = rowsOf(consignWithdrawRes).map((r) => {
    const noteCount = Number(r.noteCount ?? 0);
    return {
      userId: r.userId == null ? null : Number(r.userId),
      userName: r.userName ?? UNKNOWN_USER,
      noteCount,
      totalQty: Number(r.totalQty ?? 0),
      totalValue: toDbMoney(money(r.totalValue ?? 0)),
      flagged: noteCount >= FLAG_CONSIGN_WITHDRAWALS_PER_USER,
    };
  });

  // ── D8: أعلام المسوّدات المموّلة الملغاة (≥ حدّ لكل مُنشئ بالفترة) ──
  const cancelledFundedRows: CancelledFundedDraftRow[] = rowsOf(cancelledFundedRes).map((r) => {
    const draftCount = Number(r.draftCount ?? 0);
    return {
      userId: r.userId == null ? null : Number(r.userId),
      userName: r.userName ?? UNKNOWN_USER,
      draftCount,
      collectedTotal: toDbMoney(money(r.collectedTotal ?? 0)),
      refundedTotal: toDbMoney(money(r.refundedTotal ?? 0)),
      flagged: draftCount >= FLAG_CANCELLED_FUNDED_DRAFTS_PER_USER,
    };
  });

  // ── D9: حصّة رصيد زين لكل موظف — العلم عند نسبة ≥ العتبة **ومبلغٍ ≥ الأرضية** ──
  const telecomShareRows: TelecomShareRow[] = rowsOf(telecomShareRes).map((r) => {
    const telecomIn = money(r.telecomIn ?? 0);
    const totalIn = money(r.totalIn ?? 0);
    const share = totalIn.gt(0) ? telecomIn.div(totalIn) : new Decimal(0);
    return {
      userId: r.userId == null ? null : Number(r.userId),
      userName: r.userName ?? UNKNOWN_USER,
      telecomIn: toDbMoney(telecomIn),
      totalIn: toDbMoney(totalIn),
      sharePct: pct(share),
      receiptCount: Number(r.telecomCount ?? 0),
      flagged: share.gte(FLAG_TELECOM_SHARE) && telecomIn.gte(FLAG_TELECOM_MIN_TOTAL),
    };
  });

  // ── D10/D11/D12 (ش٦): تجميع ──
  const fundedStaleRows: FundedStaleDraftRow[] = rowsOf(fundedStaleRes).map((r) => ({
    draftId: Number(r.draftId),
    draftNumber: String(r.draftNumber ?? ""),
    userId: r.userId == null ? null : Number(r.userId),
    userName: r.userName ?? UNKNOWN_USER,
    heldNet: toDbMoney(money(r.heldNet ?? 0)),
    ageHours: Number(r.ageHours ?? 0),
  }));
  const othersCollectRows: OthersCollectRow[] = rowsOf(othersCollectRes).map((r) => ({
    userId: r.userId == null ? null : Number(r.userId),
    userName: r.userName ?? UNKNOWN_USER,
    receiptCount: Number(r.receiptCount ?? 0),
    totalAmount: toDbMoney(money(r.totalAmount ?? 0)),
    flagged: Number(r.receiptCount ?? 0) >= FLAG_OTHERS_COLLECT_PER_USER,
  }));
  const fundedReducedRows: FundedReducedRow[] = rowsOf(fundedReducedRes).map((r) => ({
    userId: r.userId == null ? null : Number(r.userId),
    userName: r.userName ?? UNKNOWN_USER,
    eventCount: Number(r.eventCount ?? 0),
    flagged: Number(r.eventCount ?? 0) >= FLAG_FUNDED_REDUCED_PER_USER,
  }));

  // ── D13/D14 (توصيل ١٠/٨): تجميع ──
  const deliveryCustodyRows: DeliveryCustodyAgingRow[] = rowsOf(deliveryCustodyRes).map((r) => {
    const balance = money(r.balance ?? 0);
    const oldestDays = r.oldestDays == null ? null : Number(r.oldestDays);
    return {
      partyId: Number(r.partyId),
      partyName: r.partyName ?? UNKNOWN_USER,
      balance: toDbMoney(balance),
      openCount: Number(r.openCount ?? 0),
      oldestDays,
      flagged:
        (oldestDays != null && oldestDays >= FLAG_DELIVERY_CUSTODY_AGE_DAYS)
        || (balance.gte(FLAG_DELIVERY_CUSTODY_IQD)
          && (oldestDays == null || oldestDays >= FLAG_DELIVERY_CUSTODY_AGE_DAYS / 2)),
    };
  });
  const deliveryShortRows: DeliveryShortRemitRow[] = rowsOf(deliveryShortRes).map((r) => ({
    partyId: Number(r.partyId),
    partyName: r.partyName ?? UNKNOWN_USER,
    remitCount: Number(r.remitCount ?? 0),
    shortCount: Number(r.shortCount ?? 0),
    shortfallTotal: toDbMoney(money(r.shortfallTotal ?? 0)),
    flagged: Number(r.shortCount ?? 0) >= FLAG_DELIVERY_SHORT_REMITS,
  }));

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
      flaggedConsignWithdrawers: consignWithdrawRows.filter((r) => r.flagged).length,
      flaggedCancelledFundedDrafters: cancelledFundedRows.filter((r) => r.flagged).length,
      flaggedTelecomCollectors: telecomShareRows.filter((r) => r.flagged).length,
      fundedStaleDrafts: fundedStaleRows.length,
      flaggedOthersCollectors: othersCollectRows.filter((r) => r.flagged).length,
      flaggedFundedReducers: fundedReducedRows.filter((r) => r.flagged).length,
      flaggedDeliveryCustody: deliveryCustodyRows.filter((r) => r.flagged).length,
      flaggedDeliveryShortRemits: deliveryShortRows.filter((r) => r.flagged).length,
    },
    belowCost: { cashiers: belowCostCashiers, worstLines },
    discounts: { rows: discountRows, scopeAvgRatePct: pct(discScopeAvg) },
    returns: { sellers: returnSellers, processors: returnProcessors, scopeAvgRatePct: pct(retScopeAvg) },
    shiftShortages: { rows: shortageRows },
    reversedVouchers: { rows: reversedRows },
    sequenceGaps: { rows: gapRows },
    consignWithdrawals: { rows: consignWithdrawRows },
    cancelledFundedDrafts: { rows: cancelledFundedRows },
    telecomShares: { rows: telecomShareRows },
    fundedStaleDrafts: { rows: fundedStaleRows },
    othersCollections: { rows: othersCollectRows },
    fundedReductions: { rows: fundedReducedRows },
    deliveryCustodyAging: { rows: deliveryCustodyRows },
    deliveryShortRemits: { rows: deliveryShortRows },
  };
}
