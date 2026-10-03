// تقرير مطابقة إقفال اليوم للنقد (Cash Day-Close Reconciliation) — للقراءة فقط.
// يوازن نقد الدرج لكل وردية في **يوم عمل** (يوم UTC عبر businessDay) وفرعٍ من ثلاث زوايا:
//   المتوقَّع (محسوبٌ من الدفتر) مقابل المعدود (نقد الإغلاق) مقابل الفرق (drift).
//
// ── مصدر الحقيقة للمتوقَّع = نفس صيغة shiftService.computeExpectedCash بالضبط ──
//   expected = openingBalance + Σ(IN, CASH, DRAWER) − Σ(OUT, CASH, DRAWER بلا تسليمات الخزينة)
//   ⇒ يساوي shifts.expectedCash المخزَّن عند الإغلاق حرفياً، و drift = counted − expected = shifts.variance.
//   نُظهر أيضاً القيمتَين المخزَّنتَين (storedExpected/storedVariance) لتأكيد التطابق بصرياً.
//
// ⚠️ تسليمات الخزينة (handover — receipts.referenceNumber LIKE 'CH-%') **لا تُطرَح من المتوقَّع**:
//   إنها نقلٌ للنقد المعدود إلى الخزينة الإدارية **بعد** العدّ (closeShift يحسب expected أولاً ثم
//   يُنشئ سند التسليم — راجع shiftService.closeShift: computeExpectedCash يسبق createHandover).
//   طرحُها من المتوقَّع بينما «المعدود» هو الدرج الكامل قبل التسليم = فائضٌ وهميٌّ بمقدار التسليم.
//   لذا تُعرَض منفصلةً («خرج إلى العهدة») مع «المتبقّي في الدرج» = المعدود − التسليمات.
//
// النقد فقط: paymentMethod='CASH' وcashBucket='DRAWER' (تُستبعَد البطاقة/التحويل والخزينة الإدارية).
// لا فلتر receiptStatus — العكوس تُصافَر بإيصالٍ تعويضيّ IN (مطابقةً حرفيةً لـcomputeExpectedCash).
// كل الأموال عبر decimal.js (money/toDbMoney) — ممنوع Number/parseFloat على المال (§٥).
// نطاق اليوم عبر businessDay.utcDayRange (نطاق نصف مفتوح [00:00, +يوم)) — لا بناء Date محليّ
//   (حارس check:date-boundaries). المصدر الوحيد لحدّ اليوم.
//
// السحب النقديّ أثناء الوردية (cash drop, referenceNumber LIKE 'CD-%' — cashDropService): يقع
//   **أثناء** الوردية فيُدرَج في computeExpectedCash (يُنقِص المتوقَّع) والنقد المعدود يُنقِص بالمثل ⇒
//   الفرق لا يتأثّر. يُصنَّف في دلو cashDrops (ضمن الخارج التشغيليّ)، خلافاً لتسليم الإغلاق CH.
import { and, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, ne, notExists, notInArray, notLike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  accountingEntries,
  branches,
  cashTransfers,
  cashCustodyCounts,
  customers,
  expenseCategories,
  expenses,
  invoices,
  payrollAccountingEvents,
  receipts,
  shifts,
  suppliers,
  users,
  voucherCategories,
  workOrders,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { utcDayRange } from "./businessDay";
import { MATERIALIZED_RECEIPT_STATUSES, materializedDrawerCashConditions } from "./cash/cashAvailability";
import { cashEventAtSql } from "./cash/cashEventAt";
import {
  isPotentialCashCustodyRecipient,
  type CashCustodyVisibilityActor,
} from "./cash/custodyBlindCount";
import { money, toDbMoney } from "./money";
import { expenseBucketLabel } from "../../shared/expenseCategories";
import { withTx } from "./tx";

/** تفصيل حركة نقدية واحدة في درج الوردية (لتوضيح مصدر الإيراد ومستفيد المصروف). */
export interface DayCloseShiftMovementItem {
  id: number;
  direction: "IN" | "OUT";
  categoryType:
    | "SALE"
    | "COLLECTION"
    | "OTHER_IN"
    | "RETURN"
    | "EXPENSE"
    | "CASH_DROP"
    | "HANDOVER"
    | "OTHER_OUT";
  categoryLabel: string;
  amount: string;
  referenceNumber: string | null;
  voucherNumber: string | null;
  partyName: string | null;      // من أين جاء الإيراد / لمن صُرف المصروف
  payee: string | null;          // جهة الصرف المحددة
  description: string | null;    // البيان وسبب الحركة
  classification: string | null; // فئة المصروف أو نوع البيع
  documentNumber: string | null; // رقم الفاتورة أو أمر الشغل أو السند
  createdAt: Date | string;
  createdByName: string | null;
}

/** سطر مطابقة وردية واحدة. كل الحقول المالية نصّية decimal(15,2). */
export interface DayCloseShiftLine {
  shiftId: number;
  branchId: number;
  branchName: string | null;
  userId: number;
  userName: string | null;
  shiftType: "RETAIL" | "RECEPTION" | "PRINT_SERVICES";
  status: "OPEN" | "CLOSED";
  openedAt: Date | string;
  closedAt: Date | string | null;
  /** الرصيد الافتتاحي (بداية الوردية). */
  opening: string;
  // ── الداخل (IN, نقد, درج) ──
  salesCash: string;        // مبيعات نقدية (إيصال مرتبط بفاتورة، بلا رقم سند)
  collectionsCash: string;  // تحصيلات نقدية (سندات قبض RV)
  otherIn: string;          // مقبوضات أخرى (عربون أمر شغل…) — الباقي المتبقّي من cashIn
  cashIn: string;           // = salesCash + collectionsCash + otherIn
  // ── الخارج التشغيليّ (OUT, نقد, درج — يؤثّر على المتوقَّع) ──
  returnsCash: string;      // مرتجعات نقدية (استرداد مرتبط بفاتورة)
  expensesCash: string;     // مصروفات/سندات صرف نقدية (PV أو مصروف مرتبط)
  otherOut: string;         // مصروفات أخرى — الباقي التشغيليّ
  operatingOut: string;     // = returnsCash + expensesCash + otherOut = cashOut − handoversCash
  // ── تسليم الخزينة (لا يؤثّر على المتوقَّع — يُعرَض منفصلاً) ──
  handoversCash: string;    // خرج من الدرج إلى عهدة إغلاق (CH-…)؛ لا يعني أن الخزينة قبلته
  cashDrops: string;        // خطاف شريحة لاحقة (السحب أثناء الوردية) — صفر حالياً
  // ── المطابقة ──
  expected: string;         // opening + cashIn − operatingOut  (== storedExpectedCash)
  counted: string | null;   // shifts.countedCash (null لوردية مفتوحة)
  drift: string | null;     // counted − expected (== storedVariance)؛ +فائض / −عجز
  retainedInDrawer: string | null; // counted − handoversCash (النقد المتبقّي فعلاً بعد التسليم)
  // ── القيم المخزَّنة (تأكيد التطابق مع Z-report) ──
  storedExpectedCash: string | null;
  storedVariance: string | null;
  // ── تفاصيل الحركات الفردية (من أين جاء الإيراد ولمن صُرف المصروف) ──
  movements: DayCloseShiftMovementItem[];
}

/** ملخص حركات النقد المباشرة (الخزينة أو خارج الورديات المفتوحة). */
export interface DayCloseDirectSummary {
  salesCash: string;
  collectionsCash: string;
  otherIn: string;
  cashIn: string;
  returnsCash: string;
  expensesCash: string;
  otherOut: string;
  operatingOut: string;
  netCash: string;
  receiptCount: number;
}

export interface DayCloseTotals {
  shiftCount: number;
  openCount: number;
  closedCount: number;
  opening: string;
  salesCash: string;
  collectionsCash: string;
  otherIn: string;
  cashIn: string;
  returnsCash: string;
  expensesCash: string;
  otherOut: string;
  operatingOut: string;
  handoversCash: string;
  cashDrops: string;
  expected: string;
  counted: string;   // Σ المعدود (الورديات المغلقة فقط)
  drift: string;     // Σ الفرق (الورديات المغلقة فقط)
  retainedInDrawer: string;
  closedExpected: string;
  openRunningExpected: string;
  /** النقد الموجود الآن في الأدراج فقط: المتبقّي من المغلقة + الجاري في المفتوحة. */
  physicalDrawerCash: string;
  // تفكيك المقبوضات/المصروفات المباشرة (الخزينة/خارج الورديات)
  directSalesCash: string;
  directCollectionsCash: string;
  directOtherIn: string;
  directCashIn: string;
  directReturnsCash: string;
  directExpensesCash: string;
  directOtherOut: string;
  directOperatingOut: string;
  directNetCash: string;
  // مبالغ الورديات وحدها
  shiftSalesCash: string;
  shiftCollectionsCash: string;
  shiftCashIn: string;
  shiftOperatingOut: string;
  shiftExpected: string;
}

export interface DayCloseReconciliationResult {
  date: string;
  branchId: number | null;
  shifts: DayCloseShiftLine[];
  /** ورديات محجوبة عن مستلم محتمل حتى يثبّت أول عدّ أعمى للعهدة. */
  withheldBlindCountShiftCount: number;
  directOperations: DayCloseDirectSummary;
  totals: DayCloseTotals;
  balancedCount: number; // ورديات مغلقة فرقها = صفر
  driftCount: number;    // ورديات مغلقة فرقها ≠ صفر
  overCount: number;     // فائض (drift > 0)
  shortCount: number;    // عجز (drift < 0)
  /** ش٦ — بنود الاستقبال في إقفال اليوم: عرابين معلّقة (لقطة حاضرة لا يوم) + خصم كل موظف. */
  directMovements: { count: number; net: string; in: string; out: string; details: Array<{ id: number; time: string; userName: string | null; direction: 'IN' | 'OUT'; amount: string; description: string; }>; };
  receptionExtras: {
    /** مسوّدات OPEN مموّلة الآن — مالُ زبائن محتجزٌ بلا مستندٍ نهائيّ (عرابين غير مُسلَّمة). */
    fundedDrafts: { count: number; heldNet: string };
    /** متوسّط الخصم اليدويّ (رأس الفاتورة) لكل موظفٍ لفواتير اليوم — بحدود بيانات الرأس. */
    discountByUser: Array<{
      userId: number | null;
      userName: string;
      invoiceCount: number;
      subtotal: string;
      manualDiscount: string;
      avgRatePct: string;
    }>;
  };
  /** موضع النقد النهائي، لا حجم الحركة خلال اليوم. يُحجب إن تعذّر إثبات رقم كامل. */
  cashPosition: {
    branchCount: number;
    expectedTreasuryCash: string;
    expectedDrawersCash: string;
    cashInTransit: string;
    expectedCashOnHand: string;
    isReadyForFinalCount: boolean;
  } | null;
}

interface ReceiptAgg {
  cashIn: string;
  cashOut: string;
  salesCash: string;
  collectionsCash: string;
  handoversCash: string;
  cashDropsCash: string;
  expensesCash: string;
  returnsCash: string;
}

/**
 * تقرير مطابقة إقفال اليوم لفرعٍ (أو كل الفروع) في يوم عملٍ واحد.
 * @param opts.date تاريخ اليوم YYYY-MM-DD (يوم UTC).
 * @param opts.branchId فرعٌ محدّد، أو undefined لكل الفروع (يفرضه الراوتر بعزلٍ صارم).
 */
export async function getDayCloseReconciliation(opts: {
  date: string;
  branchId?: number;
  actor?: CashCustodyVisibilityActor;
}): Promise<DayCloseReconciliationResult> {
  const emptyDirectSummary: DayCloseDirectSummary = {
    salesCash: "0.00",
    collectionsCash: "0.00",
    otherIn: "0.00",
    cashIn: "0.00",
    returnsCash: "0.00",
    expensesCash: "0.00",
    otherOut: "0.00",
    operatingOut: "0.00",
    netCash: "0.00",
    receiptCount: 0,
  };

  const emptyTotals: DayCloseTotals = {
    shiftCount: 0, openCount: 0, closedCount: 0,
    opening: "0.00", salesCash: "0.00", collectionsCash: "0.00", otherIn: "0.00", cashIn: "0.00",
    returnsCash: "0.00", expensesCash: "0.00", otherOut: "0.00", operatingOut: "0.00",
    handoversCash: "0.00", cashDrops: "0.00", expected: "0.00", counted: "0.00", drift: "0.00",
    retainedInDrawer: "0.00", closedExpected: "0.00", openRunningExpected: "0.00", physicalDrawerCash: "0.00",
    directSalesCash: "0.00", directCollectionsCash: "0.00", directOtherIn: "0.00", directCashIn: "0.00",
    directReturnsCash: "0.00", directExpensesCash: "0.00", directOtherOut: "0.00", directOperatingOut: "0.00",
    directNetCash: "0.00",
    shiftSalesCash: "0.00", shiftCollectionsCash: "0.00", shiftCashIn: "0.00",
    shiftOperatingOut: "0.00", shiftExpected: "0.00",
  };
  const base: DayCloseReconciliationResult = {
    date: opts.date,
    branchId: opts.branchId ?? null,
    shifts: [],
    withheldBlindCountShiftCount: 0,
    directOperations: emptyDirectSummary,
    totals: emptyTotals,
    balancedCount: 0, driftCount: 0, overCount: 0, shortCount: 0,
    directMovements: { count: 0, net: '0.00', in: '0.00', out: '0.00', details: [] },
    receptionExtras: { fundedDrafts: { count: 0, heldNet: "0.00" }, discountByUser: [] },
    cashPosition: null,
  };

  const connection = getDb();
  if (!connection) return base;

  // كل أرقام التقرير تُقرأ من لقطةٍ واحدة؛ وإلا قد تجمع الاستعلامات المتعددة
  // حالاتٍ ماليةً من لحظات مختلفة أثناء ترحيل متزامن.
  return withTx(async (db) => {

  // نطاق اليوم التجاريّ [start, endExclusive) على openedAt (اتّساقاً مع بقية تقارير الخزينة).
  const { start, endExclusive } = utcDayRange(opts.date, opts.date);

  const eventAt = cashEventAtSql({
    approvedBy: receipts.approvedBy,
    createdBy: receipts.createdBy,
    approvedAt: receipts.approvedAt,
    createdAt: receipts.createdAt,
  });
  const custodyEvidenceReceipt = alias(receipts, "dayCloseCustodyEvidenceReceipt");
  const custodySourceEvidence = db
    .select({ receiptId: accountingEntries.receiptId })
    .from(accountingEntries)
    .innerJoin(
      custodyEvidenceReceipt,
      eq(custodyEvidenceReceipt.id, accountingEntries.receiptId),
    )
    .where(and(
      isNotNull(accountingEntries.receiptId),
      inArray(accountingEntries.entryType, ["CASH_TRANSFER_OUT", "CASH_HANDOVER"]),
    ))
    .groupBy(accountingEntries.receiptId)
    .having(sql`
      COUNT(*) = 1
      AND MAX(${accountingEntries.branchId}) = MAX(${custodyEvidenceReceipt.branchId})
      AND MAX(${accountingEntries.amount}) = MAX(${custodyEvidenceReceipt.amount})
    `)
    .as("dayCloseCustodySourceEvidence");
  const openingFloatReceipt = alias(receipts, "dayCloseOpeningFloatReceipt");
  const openingFloatEntry = alias(accountingEntries, "dayCloseOpeningFloatEntry");
  const openingFloatEventAt = cashEventAtSql({
    approvedBy: openingFloatReceipt.approvedBy,
    createdBy: openingFloatReceipt.createdBy,
    approvedAt: openingFloatReceipt.approvedAt,
    createdAt: openingFloatReceipt.createdAt,
  });
  const openingFloatEntryJoin = and(
    eq(openingFloatEntry.entryType, "SHIFT_FLOAT_OUT"),
    eq(openingFloatEntry.dedupeKey, sql`CONCAT('SHIFT_FLOAT:', ${shifts.id})`),
  );
  const openingFloatReceiptJoin = eq(openingFloatReceipt.id, openingFloatEntry.receiptId);
  const openingFloatLinkContract = and(
    eq(openingFloatEntry.branchId, shifts.branchId),
    eq(openingFloatEntry.amount, shifts.openingBalance),
    eq(openingFloatReceipt.branchId, shifts.branchId),
    eq(openingFloatReceipt.amount, shifts.openingBalance),
    eq(openingFloatReceipt.direction, "OUT"),
    eq(openingFloatReceipt.cashBucket, "TREASURY"),
    eq(openingFloatReceipt.paymentMethod, "CASH"),
    eq(openingFloatReceipt.approvalStatus, "APPROVED"),
    inArray(openingFloatReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
  );
  const fundedShiftVisibleAtCutoff = or(
    sql`${shifts.openingBalance} = 0`,
    // ورديات ما قبل عقد SF التاريخي لا تملك إيصالاً مرتبطاً؛ يبقى openedAt دليلها
    // الوحيد. أمّا إذا وُجد SF فلا تدخل العهدة قبل لحظة تحقّقه المالية.
    isNull(openingFloatEntry.id),
    and(
      openingFloatLinkContract,
      lt(openingFloatEventAt, endExclusive),
    ),
  );

  const shiftConds = [
    gte(shifts.openedAt, start),
    lt(shifts.openedAt, endExclusive),
    fundedShiftVisibleAtCutoff,
  ];
  if (opts.branchId != null) shiftConds.push(eq(shifts.branchId, opts.branchId));

  const shiftRows = await db
    .select({
      shiftId: shifts.id,
      branchId: shifts.branchId,
      branchName: branches.name,
      userId: shifts.userId,
      userName: users.name,
      shiftType: shifts.shiftType,
      status: shifts.status,
      openedAt: shifts.openedAt,
      closedAt: shifts.closedAt,
      opening: shifts.openingBalance,
      countedCash: shifts.countedCash,
      expectedCash: shifts.expectedCash,
      variance: shifts.variance,
    })
    .from(shifts)
    .leftJoin(branches, eq(branches.id, shifts.branchId))
    .leftJoin(users, eq(users.id, shifts.userId))
    .leftJoin(openingFloatEntry, openingFloatEntryJoin)
    .leftJoin(openingFloatReceipt, openingFloatReceiptJoin)
    .where(and(...shiftConds))
    .orderBy(shifts.branchId, shifts.openedAt, shifts.id);

  const protectedShiftIds = new Set<number>();
  let withholdCashPosition = false;
  if (opts.actor) {
    const sourceReceipt = alias(receipts, "blindCountSourceReceipt");
    const pendingReceipt = alias(receipts, "blindCountPendingReceipt");
    const firstCount = alias(cashCustodyCounts, "blindCountFirstCount");
    const sourceShift = alias(shifts, "blindCountSourceShift");
    const sourceEventAt = cashEventAtSql({
      approvedBy: sourceReceipt.approvedBy,
      createdBy: sourceReceipt.createdBy,
      approvedAt: sourceReceipt.approvedAt,
      createdAt: sourceReceipt.createdAt,
    });
    const pendingBlindRows = await db
      .select({
        shiftId: sourceReceipt.shiftId,
        branchId: sourceReceipt.branchId,
        handedOverByUserId: sourceReceipt.createdBy,
        shiftOwnerUserId: sourceShift.userId,
      })
      .from(sourceReceipt)
      .innerJoin(
        custodySourceEvidence,
        eq(custodySourceEvidence.receiptId, sourceReceipt.id),
      )
      .innerJoin(
        pendingReceipt,
        and(
          eq(pendingReceipt.branchId, sourceReceipt.branchId),
          sql`UPPER(TRIM(${pendingReceipt.referenceNumber})) = UPPER(TRIM(${sourceReceipt.referenceNumber}))`,
          eq(pendingReceipt.amount, sourceReceipt.amount),
          eq(pendingReceipt.direction, "IN"),
          eq(pendingReceipt.paymentMethod, "CASH"),
          eq(pendingReceipt.cashBucket, "TREASURY"),
          eq(pendingReceipt.status, "PENDING"),
          eq(pendingReceipt.approvalStatus, "APPROVED"),
          isNull(pendingReceipt.voucherNumber),
          isNull(pendingReceipt.invoiceId),
          isNull(pendingReceipt.workOrderId),
          isNull(pendingReceipt.reservationId),
        ),
      )
      .leftJoin(firstCount, eq(firstCount.treasuryReceiptId, pendingReceipt.id))
      .leftJoin(sourceShift, eq(sourceShift.id, sourceReceipt.shiftId))
      .where(
        and(
          ...(opts.branchId != null ? [eq(sourceReceipt.branchId, opts.branchId)] : []),
          eq(sourceReceipt.direction, "OUT"),
          eq(sourceReceipt.paymentMethod, "CASH"),
          eq(sourceReceipt.cashBucket, "DRAWER"),
          eq(sourceReceipt.status, "COMPLETED"),
          eq(sourceReceipt.approvalStatus, "APPROVED"),
          or(
            sql`UPPER(TRIM(${sourceReceipt.referenceNumber})) LIKE 'CH-%'`,
            sql`UPPER(TRIM(${sourceReceipt.referenceNumber})) LIKE 'CD-%'`,
          ),
          eq(sourceShift.branchId, sourceReceipt.branchId),
          lt(sourceEventAt, endExclusive),
          isNull(firstCount.id),
        ),
      );

    for (const row of pendingBlindRows) {
      if (
        isPotentialCashCustodyRecipient(opts.actor, {
          branchId: row.branchId == null ? null : Number(row.branchId),
          handedOverByUserId:
            row.handedOverByUserId == null ? null : Number(row.handedOverByUserId),
          shiftOwnerUserId:
            row.shiftOwnerUserId == null ? null : Number(row.shiftOwnerUserId),
        })
      ) {
        if (row.shiftId != null) protectedShiftIds.add(Number(row.shiftId));
        withholdCashPosition = true;
      }
    }
  }

  // لا نعيد صفاً ناقصاً يمكن جمع أجزائه لاستنتاج المبلغ؛ نحجب الوردية ومساهمتها
  // في المجاميع كاملةً حتى أول عد، ونصرّح فقط بعدد الصفوف المحجوبة بلا معرّفات.
  const visibleShiftRows = shiftRows.filter(
    (row) => !protectedShiftIds.has(Number(row.shiftId)),
  );
  const withheldBlindCountShiftCount = shiftRows.length - visibleShiftRows.length;
  const shiftIds = visibleShiftRows.map((r) => Number(r.shiftId));

  // تفكيك مقبوضات/مدفوعات الدرج النقدية لكل وردية عبر SUM(CASE …). البِنى متنافية بالإنشاء:
  //   • تسليم الخزينة يحمل referenceNumber='CH-…' وبلا voucherNumber/expense/invoiceId ⇒ دلوُه وحده.
  //   • salesCash: IN بفاتورة بلا سند. collectionsCash: IN بسند قبض. (otherIn = المتبقّي.)
  //   • expensesCash: OUT بسند صرف أو مصروف مرتبط. returnsCash: OUT بفاتورة بلا سند/مصروف/CH.
  // cashIn/cashOut إجماليّان (الصيغة القانونية) ⇒ otherIn/otherOut = بواقٍ تضمن التطابق دوماً.
  // المسار ز (١٦/٨): كانت الشروط تُكتب هنا يدوياً بلا حالةٍ ولا اعتماد ⇒ إيصالٌ معلَّق أو
  // غير معتمَد يدخل «المتوقَّع» في التقرير ولا يدخله في حارس الوردية ⇒ فرقٌ يُتَّهم به الكاشير.
  // المصدر صار واحداً بالبناء: materializedDrawerCashConditions.
  const aggByShift = new Map<number, ReceiptAgg>();
  if (shiftIds.length > 0) {
    const isDrawerCash = and(inArray(receipts.shiftId, shiftIds), ...materializedDrawerCashConditions());
    const aggRows = await db
      .select({
        shiftId: receipts.shiftId,
        cashIn: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE 0 END), 0)`,
        cashOut: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' THEN ${receipts.amount} ELSE 0 END), 0)`,
        salesCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.voucherNumber} IS NULL AND ${receipts.invoiceId} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
        collectionsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.voucherNumber} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
        handoversCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${custodySourceEvidence.receiptId} IS NOT NULL AND UPPER(TRIM(${receipts.referenceNumber})) LIKE 'CH-%' THEN ${receipts.amount} ELSE 0 END), 0)`,
        cashDropsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${custodySourceEvidence.receiptId} IS NOT NULL AND UPPER(TRIM(${receipts.referenceNumber})) LIKE 'CD-%' THEN ${receipts.amount} ELSE 0 END), 0)`,
        expensesCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${custodySourceEvidence.receiptId} IS NULL AND (${receipts.voucherNumber} IS NOT NULL OR ${expenses.id} IS NOT NULL) THEN ${receipts.amount} ELSE 0 END), 0)`,
        returnsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${custodySourceEvidence.receiptId} IS NULL AND ${receipts.voucherNumber} IS NULL AND ${expenses.id} IS NULL AND ${receipts.invoiceId} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
      })
      .from(receipts)
      .innerJoin(
        shifts,
        and(eq(shifts.id, receipts.shiftId), eq(shifts.branchId, receipts.branchId)),
      )
      .leftJoin(expenses, eq(expenses.receiptId, receipts.id))
      .leftJoin(custodySourceEvidence, eq(custodySourceEvidence.receiptId, receipts.id))
      .where(isDrawerCash)
      .groupBy(receipts.shiftId);

    for (const r of aggRows) {
      aggByShift.set(Number(r.shiftId), {
        cashIn: r.cashIn, cashOut: r.cashOut, salesCash: r.salesCash,
        collectionsCash: r.collectionsCash, handoversCash: r.handoversCash,
        cashDropsCash: r.cashDropsCash,
        expensesCash: r.expensesCash, returnsCash: r.returnsCash,
      });
    }
  }

  // ── مقبوضات ومدفوعات النقد المباشرة / الخزينة (خارج أدراج الورديات) ──
  // تشمل أي تدفق نقدي مشروع (سند قبض RV، تحصيل، مبيعات مباشرة، سند صرف PV)
  // لا ينتمي لدرج وردية معروضة، لمنع أي فائض أو تسرب صامت في مطابقة إقفال اليوم.
  const directConds = [
    eq(receipts.paymentMethod, "CASH"),
    inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
    eq(receipts.approvalStatus, "APPROVED"),
    gte(eventAt, start),
    lt(eventAt, endExclusive),
    or(
      eq(receipts.cashBucket, "TREASURY"),
      and(
        isNull(receipts.shiftId),
        or(isNull(receipts.cashBucket), ne(receipts.cashBucket, "DRAWER")),
      ),
    ),
    or(
      isNotNull(receipts.voucherNumber),
      isNotNull(receipts.invoiceId),
      isNull(receipts.referenceNumber),
      and(
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "CH-%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "CD-%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "SF-%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "STF-%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "CT-%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "CANCEL-CT-%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "TF-%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "TEST-TREASURY%"),
        notLike(sql`UPPER(TRIM(${receipts.referenceNumber}))`, "TREASURY-SEED%"),
      ),
    ),
    // استبعاد صرف الرواتب والتحويلات القانونية (تسويات الخزينة المرتبطة بأحداث الرواتب)
    // حتى لا تُحسب كعمليات تشغيلية مباشرة تفرّغ النقد المتوقع للأدراج.
    notExists(
      db
        .select({ one: sql`1` })
        .from(payrollAccountingEvents)
        .where(eq(payrollAccountingEvents.receiptId, receipts.id)),
    ),
  ];
  if (opts.branchId != null) {
    directConds.push(eq(receipts.branchId, opts.branchId));
  }
  if (protectedShiftIds.size > 0) {
    directConds.push(
      or(
        isNull(receipts.shiftId),
        notInArray(receipts.shiftId, Array.from(protectedShiftIds)),
      ),
    );
  }

  const directAggRows = await db
    .select({
      count: sql<number>`COUNT(*)`,
      cashIn: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE 0 END), 0)`,
      cashOut: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' THEN ${receipts.amount} ELSE 0 END), 0)`,
      salesCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.voucherNumber} IS NULL AND ${receipts.invoiceId} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
      collectionsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.voucherNumber} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
      expensesCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND (${receipts.voucherNumber} IS NOT NULL OR ${expenses.id} IS NOT NULL) THEN ${receipts.amount} ELSE 0 END), 0)`,
      returnsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${receipts.voucherNumber} IS NULL AND ${expenses.id} IS NULL AND ${receipts.invoiceId} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
    })
    .from(receipts)
    .leftJoin(expenses, eq(expenses.receiptId, receipts.id))
    .where(and(...directConds));

  const directAgg = directAggRows[0];
  const directCount = Number(directAgg?.count ?? 0);
  const directCashIn = money(directAgg?.cashIn ?? 0);
  const directCashOut = money(directAgg?.cashOut ?? 0);
  const directSales = money(directAgg?.salesCash ?? 0);
  const directCollections = money(directAgg?.collectionsCash ?? 0);
  const directOtherIn = directCashIn.minus(directSales).minus(directCollections);
  const directReturns = money(directAgg?.returnsCash ?? 0);
  const directExpenses = money(directAgg?.expensesCash ?? 0);
  const directOtherOut = directCashOut.minus(directReturns).minus(directExpenses);
  const directOperatingOut = directCashOut;
  const directNetCash = directCashIn.minus(directOperatingOut);

  // جلب تفاصيل الحركات النقدية الفردية لكل وردية لبيان مصدر الإيراد ومستفيد المصروف
  const movementsByShift = new Map<number, DayCloseShiftMovementItem[]>();
  if (shiftIds.length > 0) {
    const isDrawerCash = and(inArray(receipts.shiftId, shiftIds), ...materializedDrawerCashConditions());
    const partyCustomer = alias(customers, "partyCustomer");
    const invoiceCustomer = alias(customers, "invoiceCustomer");
    const receiptUsers = alias(users, "receiptUsers");

    const movementRows = await db
      .select({
        id: receipts.id,
        shiftId: receipts.shiftId,
        direction: receipts.direction,
        amount: receipts.amount,
        referenceNumber: receipts.referenceNumber,
        voucherNumber: receipts.voucherNumber,
        partyType: receipts.partyType,
        partyId: receipts.partyId,
        counterpartyName: receipts.counterpartyName,
        description: receipts.description,
        createdAt: receipts.createdAt,
        createdBy: receipts.createdBy,
        createdByName: receiptUsers.name,
        custodyEvidenceReceiptId: custodySourceEvidence.receiptId,
        // Invoices
        invoiceId: receipts.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
        invoiceSaleType: invoices.sourceType,
        // Expenses
        expenseId: expenses.id,
        expensePayee: expenses.payee,
        expenseDescription: expenses.description,
        expenseCategory: expenses.category,
        expenseCategoryName: expenseCategories.name,
        expenseReferenceNumber: expenses.referenceNumber,
        // Vouchers
        voucherCategoryName: voucherCategories.name,
        // Work orders
        workOrderId: receipts.workOrderId,
        workOrderNumber: workOrders.orderNumber,
        workOrderTitle: workOrders.title,
        // Customers
        partyCustomerName: partyCustomer.name,
        invoiceCustomerName: invoiceCustomer.name,
        // Suppliers
        supplierName: suppliers.name,
      })
      .from(receipts)
      .innerJoin(
        shifts,
        and(eq(shifts.id, receipts.shiftId), eq(shifts.branchId, receipts.branchId)),
      )
      .leftJoin(receiptUsers, eq(receiptUsers.id, receipts.createdBy))
      .leftJoin(expenses, eq(expenses.receiptId, receipts.id))
      .leftJoin(expenseCategories, eq(expenseCategories.id, expenses.expenseCategoryId))
      .leftJoin(voucherCategories, eq(voucherCategories.id, receipts.voucherCategoryId))
      .leftJoin(invoices, eq(invoices.id, receipts.invoiceId))
      .leftJoin(invoiceCustomer, eq(invoiceCustomer.id, invoices.customerId))
      .leftJoin(
        partyCustomer,
        and(eq(receipts.partyType, "CUSTOMER"), eq(partyCustomer.id, receipts.partyId)),
      )
      .leftJoin(
        suppliers,
        and(eq(receipts.partyType, "SUPPLIER"), eq(suppliers.id, receipts.partyId)),
      )
      .leftJoin(workOrders, eq(workOrders.id, receipts.workOrderId))
      .leftJoin(custodySourceEvidence, eq(custodySourceEvidence.receiptId, receipts.id))
      .where(isDrawerCash)
      .orderBy(desc(receipts.createdAt), desc(receipts.id));

    for (const r of movementRows) {
    if (r.shiftId == null) continue;
    const sId = Number(r.shiftId);
    const ref = (r.referenceNumber ?? "").trim().toUpperCase();
    const hasCustodyEvidence = r.custodyEvidenceReceiptId != null;
    const isHandover = r.direction === "OUT" && hasCustodyEvidence && ref.startsWith("CH-");
    const isCashDrop = r.direction === "OUT" && hasCustodyEvidence && ref.startsWith("CD-");
    const isExpense =
      r.direction === "OUT" &&
      !hasCustodyEvidence &&
      (r.voucherNumber != null || r.expenseId != null);
    const isReturn =
      r.direction === "OUT" &&
      !hasCustodyEvidence &&
      r.voucherNumber == null &&
      r.expenseId == null &&
      r.invoiceId != null;

    const isSale =
      r.direction === "IN" &&
      r.voucherNumber == null &&
      r.invoiceId != null;
    const isCollection =
      r.direction === "IN" && r.voucherNumber != null;
    const isWorkOrderDeposit =
      r.direction === "IN" && r.workOrderId != null;

    let categoryType: DayCloseShiftMovementItem["categoryType"];
    let categoryLabel: string;
    let payee: string | null = null;
    let partyName: string | null = null;
    let description: string | null = null;
    let classification: string | null = null;
    let documentNumber: string | null = null;

    if (isHandover) {
      categoryType = "HANDOVER";
      categoryLabel = "خرج إلى العهدة";
      payee = "الخزينة الرئيسية";
      partyName = "الخزينة الرئيسية";
      description = r.description || "تسليم نقد الإغلاق إلى الخزينة";
      documentNumber = r.referenceNumber;
    } else if (isCashDrop) {
      categoryType = "CASH_DROP";
      categoryLabel = "سحب أثناء الوردية";
      payee = r.counterpartyName || "أمين الصندوق";
      partyName = r.counterpartyName || "عهدة السحب";
      description = r.description || "سحب نقد تشغيلي أثناء الوردية";
      documentNumber = r.referenceNumber;
    } else if (isExpense) {
      categoryType = "EXPENSE";
      categoryLabel = r.voucherNumber ? "سند صرف" : "مصروف تشغيلي";
      payee =
        r.expensePayee ||
        r.counterpartyName ||
        r.supplierName ||
        r.partyCustomerName ||
        "غير محدد";
      partyName = payee;
      description = r.expenseDescription || r.description || "مصروف نقدي من الدرج";
      classification =
        r.expenseCategoryName ||
        (r.expenseCategory ? expenseBucketLabel(r.expenseCategory) : null) ||
        r.voucherCategoryName ||
        "مصروفات عامة";
      documentNumber =
        r.voucherNumber || r.expenseReferenceNumber || r.referenceNumber || null;
    } else if (isReturn) {
      categoryType = "RETURN";
      categoryLabel = "مرتجع مبيعات";
      partyName = r.invoiceCustomerName || r.partyCustomerName || "زبون نقدي";
      payee = partyName;
      description = r.description || "استرداد نقدي لمرتجع مبيعات";
      classification = "مرتجع فاتورة";
      documentNumber = r.invoiceNumber || null;
    } else if (r.direction === "OUT") {
      categoryType = "OTHER_OUT";
      categoryLabel = "خارج تشغيلي آخر";
      payee =
        r.counterpartyName ||
        r.partyCustomerName ||
        r.supplierName ||
        "جهة غير محددة";
      partyName = payee;
      description = r.description || "صرف نقدي من الدرج";
      classification = "صرف نقدي";
      documentNumber = r.referenceNumber || null;
    } else if (isSale) {
      categoryType = "SALE";
      categoryLabel = "مبيعات نقدية";
      partyName = r.invoiceCustomerName || r.partyCustomerName || "زبون نقدي";
      description =
        r.description ||
        (r.invoiceSaleType ? `فاتورة بيع (${r.invoiceSaleType})` : "مبيعات نقدية بالدرج");
      classification = r.invoiceSaleType || "مبيعات نقطة البيع";
      documentNumber = r.invoiceNumber || null;
    } else if (isCollection) {
      categoryType = "COLLECTION";
      categoryLabel = "تحصيل / سند قبض";
      partyName = r.partyCustomerName || r.counterpartyName || "عميل";
      description = r.description || "سند قبض نقدي بالدرج";
      classification = r.voucherCategoryName || "تحصيل حساب عميل";
      documentNumber = r.voucherNumber || null;
    } else if (isWorkOrderDeposit) {
      categoryType = "OTHER_IN";
      categoryLabel = "عربون أمر شغل";
      partyName = r.partyCustomerName || r.invoiceCustomerName || "عميل أمر الشغل";
      description =
        r.description ||
        (r.workOrderTitle ? `عربون: ${r.workOrderTitle}` : "عربون نقدي لأمر شغل");
      classification = "أمر شغل";
      documentNumber = r.workOrderNumber || null;
    } else {
      categoryType = "OTHER_IN";
      categoryLabel = "مقبوضات أخرى";
      partyName = r.counterpartyName || r.partyCustomerName || "مقبوضات نقدية";
      description = r.description || "إيراد نقدي متنوع بالدرج";
      classification = "مقبوضات نقدية";
      documentNumber = r.referenceNumber || null;
    }

    const item: DayCloseShiftMovementItem = {
      id: Number(r.id),
      direction: r.direction as "IN" | "OUT",
      categoryType,
      categoryLabel,
      amount: r.amount,
      referenceNumber: r.referenceNumber ?? null,
      voucherNumber: r.voucherNumber ?? null,
      partyName,
      payee,
      description,
      classification,
      documentNumber,
      createdAt: r.createdAt,
      createdByName: r.createdByName ?? null,
    };

    const list = movementsByShift.get(sId);
    if (!list) {
      movementsByShift.set(sId, [item]);
    } else {
      list.push(item);
    }
  }
}

  // مُجمِّعات الإجماليات (decimal).
  let tOpening = money(0), tSales = money(0), tColl = money(0), tOtherIn = money(0), tCashIn = money(0);
  let tReturns = money(0), tExpenses = money(0), tOtherOut = money(0), tOpOut = money(0);
  let tHandovers = money(0), tCashDrops = money(0), tExpected = money(0), tCounted = money(0), tDrift = money(0), tRetained = money(0);
  let tClosedExpected = money(0), tOpenRunningExpected = money(0);
  let openCount = 0, closedCount = 0, balancedCount = 0, driftCount = 0, overCount = 0, shortCount = 0;

  const lines: DayCloseShiftLine[] = visibleShiftRows.map((sh) => {
    const agg = aggByShift.get(Number(sh.shiftId));
    const opening = money(sh.opening);
    const cashIn = money(agg?.cashIn ?? 0);
    const cashOut = money(agg?.cashOut ?? 0);
    const salesCash = money(agg?.salesCash ?? 0);
    const collectionsCash = money(agg?.collectionsCash ?? 0);
    const handoversCash = money(agg?.handoversCash ?? 0);
    const cashDrops = money(agg?.cashDropsCash ?? 0); // سحبٌ أثناء الوردية (CD-…) — يُنقِص المتوقَّع
    const expensesCash = money(agg?.expensesCash ?? 0);
    const returnsCash = money(agg?.returnsCash ?? 0);

    // بواقٍ تضمن Σ الأجزاء = الإجمالي القانونيّ حتى لو ظهر نمطٌ غير مصنَّف.
    const otherIn = cashIn.minus(salesCash).minus(collectionsCash);
    // الخارج التشغيليّ (بلا تسليم الإغلاق CH؛ يشمل السحب CD لأنه يقع أثناء الوردية فيُنقِص المتوقَّع).
    const operatingOut = cashOut.minus(handoversCash);
    const otherOut = operatingOut.minus(returnsCash).minus(expensesCash).minus(cashDrops);

    // المتوقَّع في الدرج عند العدّ = الافتتاحيّ + الداخل − الخارج التشغيليّ (بلا تسليم الخزينة).
    const expected = opening.plus(cashIn).minus(operatingOut);

    const isClosed = sh.countedCash != null; // الإغلاق يضع countedCash دائماً؛ المفتوحة NULL.
    const counted = isClosed ? money(sh.countedCash) : null;
    const drift = counted ? counted.minus(expected) : null;
    const retained = counted ? counted.minus(handoversCash) : null;

    if (isClosed) {
      closedCount++;
      tClosedExpected = tClosedExpected.plus(expected);
      if (drift!.isZero()) balancedCount++;
      else {
        driftCount++;
        if (drift!.isPositive()) overCount++;
        else shortCount++;
      }
    } else {
      openCount++;
      tOpenRunningExpected = tOpenRunningExpected.plus(expected);
    }

    // تجميع.
    tOpening = tOpening.plus(opening);
    tSales = tSales.plus(salesCash);
    tColl = tColl.plus(collectionsCash);
    tOtherIn = tOtherIn.plus(otherIn);
    tCashIn = tCashIn.plus(cashIn);
    tReturns = tReturns.plus(returnsCash);
    tExpenses = tExpenses.plus(expensesCash);
    tOtherOut = tOtherOut.plus(otherOut);
    tOpOut = tOpOut.plus(operatingOut);
    tHandovers = tHandovers.plus(handoversCash);
    tCashDrops = tCashDrops.plus(cashDrops);
    tExpected = tExpected.plus(expected);
    if (counted) tCounted = tCounted.plus(counted);
    if (drift) tDrift = tDrift.plus(drift);
    if (retained) tRetained = tRetained.plus(retained);

    return {
      shiftId: Number(sh.shiftId),
      branchId: Number(sh.branchId),
      branchName: sh.branchName ?? null,
      userId: Number(sh.userId),
      userName: sh.userName ?? null,
      shiftType: sh.shiftType as "RETAIL" | "RECEPTION" | "PRINT_SERVICES",
      status: sh.status as "OPEN" | "CLOSED",
      openedAt: sh.openedAt,
      closedAt: sh.closedAt ?? null,
      opening: toDbMoney(opening),
      salesCash: toDbMoney(salesCash),
      collectionsCash: toDbMoney(collectionsCash),
      otherIn: toDbMoney(otherIn),
      cashIn: toDbMoney(cashIn),
      returnsCash: toDbMoney(returnsCash),
      expensesCash: toDbMoney(expensesCash),
      otherOut: toDbMoney(otherOut),
      operatingOut: toDbMoney(operatingOut),
      handoversCash: toDbMoney(handoversCash),
      cashDrops: toDbMoney(cashDrops),
      expected: toDbMoney(expected),
      counted: counted ? toDbMoney(counted) : null,
      drift: drift ? toDbMoney(drift) : null,
      retainedInDrawer: retained ? toDbMoney(retained) : null,
      storedExpectedCash: sh.expectedCash != null ? toDbMoney(money(sh.expectedCash)) : null,
      storedVariance: sh.variance != null ? toDbMoney(money(sh.variance)) : null,
      movements: movementsByShift.get(Number(sh.shiftId)) ?? [],
    };
  });

  // ش٦ — بنود الاستقبال: (١) لقطة حاضرة للمسوّدات المموّلة OPEN (مالٌ محتجزٌ بلا مستند —
  // «عرابين غير مُسلَّمة»)؛ (٢) متوسّط الخصم اليدويّ (رأس الفاتورة) لكل موظفٍ لفواتير اليوم.
  const rowsOf = (res: unknown): any[] => {
    const data = (res as any)?.[0] ?? res;
    return Array.isArray(data) ? data : [];
  };
  const branchDraftCond = opts.branchId != null ? sql`AND d.branchId = ${opts.branchId}` : sql``;
  const branchInvCond = opts.branchId != null ? sql`AND i.branchId = ${opts.branchId}` : sql``;
  const directMovementsRes = await db
    .select({
      id: receipts.id,
      eventAt: sql<Date>`${eventAt}`.as("eventAt"),
      direction: receipts.direction,
      amount: receipts.amount,
      referenceNumber: receipts.referenceNumber,
      description: receipts.description,
      status: receipts.status,
      userId: receipts.createdBy,
      userName: users.name,
    })
    .from(receipts)
    .leftJoin(users, eq(users.id, receipts.createdBy))
    .where(and(...directConds))
    .orderBy(eventAt, receipts.id);

  const [fundedRes, discRes] = await Promise.all([
    db.execute(sql`
      SELECT COUNT(*) AS c, CAST(COALESCE(SUM(h.heldNet), 0) AS CHAR) AS t
      FROM (
        SELECT d.id,
          -- تدقيق ٦/٨ (ث١٣): البسط كان يقتصر على HELD بينما المقام يطرح **كل** الردود —
          -- فقبضٌ رُدَّ كاملاً (يصير REFUNDED) يُطرح بلا أن يُجمع أصلُه ⇒ الرقم يُبخَس أو
          -- يصير سالباً فيسقط الطلب من التقرير كلّه. الحالتان معاً كتعريف heldNetOfDraft.
          (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op
            WHERE op.draftId = d.id AND op.orderPayKind = 'COLLECTION'
              AND op.orderPayStatus IN ('HELD','REFUNDED'))
          - (SELECT COALESCE(SUM(op.amount), 0) FROM orderPayments op
            WHERE op.draftId = d.id AND op.orderPayKind = 'REFUND') AS heldNet
        FROM receptionDrafts d
        WHERE d.draftStatus = 'OPEN' AND d.moneyLocked = 1 ${branchDraftCond}
      ) h
      WHERE h.heldNet > 0
    `).catch(() => null),
    db.execute(sql`
      SELECT i.createdBy AS userId, u.name AS userName,
        COUNT(*) AS invoiceCount,
        CAST(COALESCE(SUM(i.subtotal), 0) AS CHAR) AS subtotal,
        CAST(COALESCE(SUM(i.discountAmount), 0) AS CHAR) AS manualDiscount
      FROM invoices i
      LEFT JOIN users u ON u.id = i.createdBy
      WHERE i.createdAt >= ${start} AND i.createdAt < ${endExclusive}
        AND i.invoiceStatus NOT IN ('CANCELLED')
        ${branchInvCond}
      GROUP BY i.createdBy, u.name
      HAVING SUM(i.discountAmount) > 0
      ORDER BY SUM(i.discountAmount) DESC
    `).catch(() => null),
  ]);
  const fundedRow = rowsOf(fundedRes)[0];
  const discountByUser = rowsOf(discRes).map((r) => {
    const sub = money(r.subtotal ?? 0);
    const disc = money(r.manualDiscount ?? 0);
    return {
      userId: r.userId == null ? null : Number(r.userId),
      userName: r.userName ?? "غير معروف",
      invoiceCount: Number(r.invoiceCount ?? 0),
      subtotal: toDbMoney(sub),
      manualDiscount: toDbMoney(disc),
      avgRatePct: sub.gt(0) ? disc.div(sub).times(100).toDecimalPlaces(2).toFixed(2) : "0.00",
    };
  });

  const directOperations: DayCloseDirectSummary = {
    salesCash: toDbMoney(directSales),
    collectionsCash: toDbMoney(directCollections),
    otherIn: toDbMoney(directOtherIn),
    cashIn: toDbMoney(directCashIn),
    returnsCash: toDbMoney(directReturns),
    expensesCash: toDbMoney(directExpenses),
    otherOut: toDbMoney(directOtherOut),
    operatingOut: toDbMoney(directOperatingOut),
    netCash: toDbMoney(directNetCash),
    receiptCount: directCount,
  };

  const cashPosition = withholdCashPosition
    ? null
    : await (async () => {
        if (opts.branchId == null) {
          const [branchlessCash] = await db
            .select({ count: sql<number>`COUNT(*)` })
            .from(receipts)
            .where(and(
              isNull(receipts.branchId),
              eq(receipts.paymentMethod, "CASH"),
              eq(receipts.approvalStatus, "APPROVED"),
              inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
              lt(eventAt, endExclusive),
            ));
          // لا يمكن إسناد هذا النقد إلى أي فرع، ولذلك لا يجوز إسقاطه من موقف المنشأة.
          if (Number(branchlessCash?.count ?? 0) > 0) return null;
        }

        let scopedBranches: Array<{ id: number }>;
        if (opts.branchId != null) {
          scopedBranches = [{ id: opts.branchId }];
        } else {
          // لا نكرّر بناء الأدلة لكل وحدة خاملة: الفروع المؤثرة هي التي تحمل نقد خزينة
          // أو وردية ظاهرة/مفتوحة، مع بقاء المجموع شاملاً لكل النقد التاريخي المتراكم.
          const [treasuryBranches, shiftBranches] = await Promise.all([
            db.selectDistinct({ id: receipts.branchId }).from(receipts).where(and(
              eq(receipts.cashBucket, "TREASURY"),
              eq(receipts.paymentMethod, "CASH"),
              lt(eventAt, endExclusive),
            )),
            db.selectDistinct({ id: shifts.branchId }).from(shifts).where(lt(shifts.openedAt, endExclusive)),
          ]);
          const ids = new Set<number>(lines.map((line) => line.branchId));
          for (const row of [...treasuryBranches, ...shiftBranches]) {
            if (row.id != null) ids.add(Number(row.id));
          }
          scopedBranches = Array.from(ids, (id) => ({ id }));
        }

        const scopedBranchIds = scopedBranches.map((branch) => Number(branch.id));
        const scopeReceipt = scopedBranchIds.length > 0
          ? [inArray(receipts.branchId, scopedBranchIds)]
          : [];

        // وجود قيد SF يعني أن الوردية تخضع للعقد الحديث، فلا يجوز إسقاط وردية ذات
        // إيصالٍ مربوط بفرع/مبلغ مختلف وكأنها وردية تاريخية بلا دليل. هذا فساد دليل
        // ماليّ، ولذلك نحجب الموضع النهائي بدلاً من نشر مجموع خزينة ودرج غير متقابلين.
        const [invalidOpeningFloat] = scopedBranchIds.length === 0
          ? [{ count: 0 }]
          : await db
              .select({ count: sql<number>`COUNT(*)` })
              .from(shifts)
              .innerJoin(openingFloatEntry, openingFloatEntryJoin)
              .leftJoin(openingFloatReceipt, openingFloatReceiptJoin)
              .where(and(
                inArray(shifts.branchId, scopedBranchIds),
                lt(shifts.openedAt, endExclusive),
                sql`NOT COALESCE((${openingFloatLinkContract!}), FALSE)`,
              ));
        if (Number(invalidOpeningFloat?.count ?? 0) > 0) return null;

        // استعلامات موضع محدودة ومجمّعة؛ لا نعيد بناء بصمات دليل اليوم لكل فرع عند
        // عرض «كل الفروع»، فذلك يمسح التاريخ الكامل مرات متكررة بلا حاجة للتقرير.
        const [treasuryRow] = await db
          .select({
            amount: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)`,
          })
          .from(receipts)
          .where(and(
            ...scopeReceipt,
            eq(receipts.cashBucket, "TREASURY"),
            eq(receipts.paymentMethod, "CASH"),
            eq(receipts.approvalStatus, "APPROVED"),
            inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            lt(eventAt, endExclusive),
          ));
        const expectedTreasuryCash = money(treasuryRow?.amount ?? 0);

        const custodySourceReceipt = alias(receipts, "dayCloseCustodySourceReceipt");
        const custodyTargetReceipt = alias(receipts, "dayCloseCustodyTargetReceipt");
        const custodySourceEventAt = cashEventAtSql({
          approvedBy: custodySourceReceipt.approvedBy,
          createdBy: custodySourceReceipt.createdBy,
          approvedAt: custodySourceReceipt.approvedAt,
          createdAt: custodySourceReceipt.createdAt,
        });
        const custodyTargetEventAt = cashEventAtSql({
          approvedBy: custodyTargetReceipt.approvedBy,
          createdBy: custodyTargetReceipt.createdBy,
          approvedAt: custodyTargetReceipt.approvedAt,
          createdAt: custodyTargetReceipt.createdAt,
        });
        const sourceScope = scopedBranchIds.length > 0
          ? [inArray(custodySourceReceipt.branchId, scopedBranchIds)]
          : [];
        const targetScope = scopedBranchIds.length > 0
          ? [inArray(custodyTargetReceipt.branchId, scopedBranchIds)]
          : [];
        const matchingCustodyTarget = and(
          eq(custodyTargetReceipt.branchId, custodySourceReceipt.branchId),
          sql`UPPER(TRIM(${custodyTargetReceipt.referenceNumber})) = UPPER(TRIM(${custodySourceReceipt.referenceNumber}))`,
          eq(custodyTargetReceipt.amount, custodySourceReceipt.amount),
          eq(custodyTargetReceipt.direction, "IN"),
          eq(custodyTargetReceipt.cashBucket, "TREASURY"),
          eq(custodyTargetReceipt.paymentMethod, "CASH"),
          eq(custodyTargetReceipt.approvalStatus, "APPROVED"),
          isNull(custodyTargetReceipt.voucherNumber),
          isNull(custodyTargetReceipt.invoiceId),
          isNull(custodyTargetReceipt.workOrderId),
          isNull(custodyTargetReceipt.reservationId),
        );
        const matchingCustodySource = and(
          eq(custodySourceReceipt.branchId, custodyTargetReceipt.branchId),
          sql`UPPER(TRIM(${custodySourceReceipt.referenceNumber})) = UPPER(TRIM(${custodyTargetReceipt.referenceNumber}))`,
          eq(custodySourceReceipt.amount, custodyTargetReceipt.amount),
          eq(custodySourceReceipt.direction, "OUT"),
          eq(custodySourceReceipt.cashBucket, "DRAWER"),
          eq(custodySourceReceipt.paymentMethod, "CASH"),
          eq(custodySourceReceipt.approvalStatus, "APPROVED"),
          inArray(custodySourceReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
          lt(custodySourceEventAt, endExclusive),
        );
        const custodyInTransitTarget = or(
          eq(custodyTargetReceipt.status, "PENDING"),
          and(
            inArray(custodyTargetReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            gte(custodyTargetEventAt, endExclusive),
          ),
        );
        const custodyTargetContractState = or(
          eq(custodyTargetReceipt.status, "PENDING"),
          inArray(custodyTargetReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        );
        const custodyReference = or(
          sql`UPPER(TRIM(${custodySourceReceipt.referenceNumber})) LIKE 'CH-%'`,
          sql`UPPER(TRIM(${custodySourceReceipt.referenceNumber})) LIKE 'CD-%'`,
        );
        const targetCustodyReference = or(
          sql`UPPER(TRIM(${custodyTargetReceipt.referenceNumber})) LIKE 'CH-%'`,
          sql`UPPER(TRIM(${custodyTargetReceipt.referenceNumber})) LIKE 'CD-%'`,
        );

        // العهدة بالطريق تبدأ عند حدث خروج الدرج، لا عند إنشاء إيصال الاستلام. قد يُنشأ
        // إيصال الطرف الثاني بعد منتصف الليل؛ النقد يبقى موجوداً بالطريق عند حد اليوم.
        const [custodyTransitRow] = await db
          .select({ amount: sql<string>`COALESCE(SUM(${custodySourceReceipt.amount}), 0)` })
          .from(custodySourceReceipt)
          .innerJoin(
            custodySourceEvidence,
            eq(custodySourceEvidence.receiptId, custodySourceReceipt.id),
          )
          .where(and(
            ...sourceScope,
            eq(custodySourceReceipt.direction, "OUT"),
            eq(custodySourceReceipt.cashBucket, "DRAWER"),
            eq(custodySourceReceipt.paymentMethod, "CASH"),
            eq(custodySourceReceipt.approvalStatus, "APPROVED"),
            inArray(custodySourceReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            custodyReference,
            lt(custodySourceEventAt, endExclusive),
            exists(
              db.select({ id: custodyTargetReceipt.id })
                .from(custodyTargetReceipt)
                .where(and(matchingCustodyTarget, custodyInTransitTarget)),
            ),
          ));

        // أي نصف عقد منفرد يجعل الرقم النهائي غير قابل للإثبات: هدف بلا خروج مادي،
        // أو خروج بلا هدف استلام. لا نخمن مكان النقد ولا نسرّب مبلغ عهدة غير موثقة.
        const [invalidCustodySource] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(custodySourceReceipt)
          .innerJoin(
            custodySourceEvidence,
            eq(custodySourceEvidence.receiptId, custodySourceReceipt.id),
          )
          .where(and(
            ...sourceScope,
            eq(custodySourceReceipt.direction, "OUT"),
            eq(custodySourceReceipt.cashBucket, "DRAWER"),
            eq(custodySourceReceipt.paymentMethod, "CASH"),
            eq(custodySourceReceipt.approvalStatus, "APPROVED"),
            inArray(custodySourceReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            custodyReference,
            lt(custodySourceEventAt, endExclusive),
            notExists(
              db.select({ id: custodyTargetReceipt.id })
                .from(custodyTargetReceipt)
                .where(and(matchingCustodyTarget, custodyTargetContractState)),
            ),
          ));
        const [invalidCustodyTarget] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(custodyTargetReceipt)
          .where(and(
            ...targetScope,
            eq(custodyTargetReceipt.direction, "IN"),
            eq(custodyTargetReceipt.cashBucket, "TREASURY"),
            eq(custodyTargetReceipt.paymentMethod, "CASH"),
            eq(custodyTargetReceipt.approvalStatus, "APPROVED"),
            isNull(custodyTargetReceipt.voucherNumber),
            isNull(custodyTargetReceipt.invoiceId),
            isNull(custodyTargetReceipt.workOrderId),
            isNull(custodyTargetReceipt.reservationId),
            targetCustodyReference,
            lt(custodyTargetEventAt, endExclusive),
            custodyTargetContractState,
            notExists(
              db.select({ id: custodySourceReceipt.id })
                .from(custodySourceReceipt)
                .innerJoin(
                  custodySourceEvidence,
                  eq(custodySourceEvidence.receiptId, custodySourceReceipt.id),
                )
                .where(matchingCustodySource),
            ),
          ));
        const duplicateCustodyTargets = await db
          .select({ receiptId: custodySourceReceipt.id })
          .from(custodySourceReceipt)
          .innerJoin(
            custodySourceEvidence,
            eq(custodySourceEvidence.receiptId, custodySourceReceipt.id),
          )
          .innerJoin(
            custodyTargetReceipt,
            and(matchingCustodyTarget, custodyTargetContractState),
          )
          .where(and(
            ...sourceScope,
            eq(custodySourceReceipt.direction, "OUT"),
            eq(custodySourceReceipt.cashBucket, "DRAWER"),
            eq(custodySourceReceipt.paymentMethod, "CASH"),
            eq(custodySourceReceipt.approvalStatus, "APPROVED"),
            inArray(custodySourceReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            custodyReference,
            lt(custodySourceEventAt, endExclusive),
          ))
          .groupBy(custodySourceReceipt.id)
          .having(sql`COUNT(DISTINCT ${custodyTargetReceipt.id}) > 1`);
        const duplicateCustodySources = await db
          .select({ receiptId: custodyTargetReceipt.id })
          .from(custodyTargetReceipt)
          .innerJoin(custodySourceReceipt, matchingCustodySource)
          .innerJoin(
            custodySourceEvidence,
            eq(custodySourceEvidence.receiptId, custodySourceReceipt.id),
          )
          .where(and(
            ...targetScope,
            eq(custodyTargetReceipt.direction, "IN"),
            eq(custodyTargetReceipt.cashBucket, "TREASURY"),
            eq(custodyTargetReceipt.paymentMethod, "CASH"),
            eq(custodyTargetReceipt.approvalStatus, "APPROVED"),
            isNull(custodyTargetReceipt.voucherNumber),
            isNull(custodyTargetReceipt.invoiceId),
            isNull(custodyTargetReceipt.workOrderId),
            isNull(custodyTargetReceipt.reservationId),
            targetCustodyReference,
            lt(custodyTargetEventAt, endExclusive),
            custodyTargetContractState,
          ))
          .groupBy(custodyTargetReceipt.id)
          .having(sql`COUNT(DISTINCT ${custodySourceReceipt.id}) > 1`);
        if (
          Number(invalidCustodySource?.count ?? 0) > 0 ||
          Number(invalidCustodyTarget?.count ?? 0) > 0 ||
          duplicateCustodyTargets.length > 0 ||
          duplicateCustodySources.length > 0
        ) return null;

        const sentReceipt = alias(receipts, "dayCloseTransferSentReceipt");
        const receivedReceipt = alias(receipts, "dayCloseTransferReceivedReceipt");
        const reversalReceipt = alias(receipts, "dayCloseTransferReversalReceipt");
        const sentEventAt = cashEventAtSql({
          approvedBy: sentReceipt.approvedBy,
          createdBy: sentReceipt.createdBy,
          approvedAt: sentReceipt.approvedAt,
          createdAt: sentReceipt.createdAt,
        });
        const receivedEventAt = cashEventAtSql({
          approvedBy: receivedReceipt.approvedBy,
          createdBy: receivedReceipt.createdBy,
          approvedAt: receivedReceipt.approvedAt,
          createdAt: receivedReceipt.createdAt,
        });
        const reversalEventAt = cashEventAtSql({
          approvedBy: reversalReceipt.approvedBy,
          createdBy: reversalReceipt.createdBy,
          approvedAt: reversalReceipt.approvedAt,
          createdAt: reversalReceipt.createdAt,
        });
        const sentReceiptContract = and(
          eq(sentReceipt.branchId, cashTransfers.fromBranchId),
          eq(sentReceipt.direction, "OUT"),
          eq(sentReceipt.paymentMethod, "CASH"),
          eq(sentReceipt.cashBucket, "TREASURY"),
          sql`UPPER(TRIM(${sentReceipt.referenceNumber})) = UPPER(TRIM(${cashTransfers.transferNumber}))`,
          eq(sentReceipt.amount, cashTransfers.amount),
          eq(sentReceipt.approvalStatus, "APPROVED"),
          inArray(sentReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        );
        const receivedReceiptContract = and(
          eq(receivedReceipt.branchId, cashTransfers.toBranchId),
          eq(receivedReceipt.direction, "IN"),
          eq(receivedReceipt.paymentMethod, "CASH"),
          eq(receivedReceipt.cashBucket, "TREASURY"),
          sql`UPPER(TRIM(${receivedReceipt.referenceNumber})) = UPPER(TRIM(${cashTransfers.transferNumber}))`,
          eq(receivedReceipt.amount, cashTransfers.amount),
          eq(receivedReceipt.approvalStatus, "APPROVED"),
          inArray(receivedReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        );
        const reversalReceiptContract = and(
          eq(reversalReceipt.branchId, cashTransfers.fromBranchId),
          eq(reversalReceipt.direction, "IN"),
          eq(reversalReceipt.paymentMethod, "CASH"),
          eq(reversalReceipt.cashBucket, "TREASURY"),
          sql`UPPER(TRIM(${reversalReceipt.referenceNumber})) = CONCAT('CANCEL-', UPPER(TRIM(${cashTransfers.transferNumber})))`,
          eq(reversalReceipt.amount, cashTransfers.amount),
          eq(reversalReceipt.approvalStatus, "APPROVED"),
          inArray(reversalReceipt.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        );
        const transferScope = and(
          inArray(cashTransfers.fromBranchId, scopedBranchIds),
          or(lt(cashTransfers.sentAt, endExclusive), lt(sentEventAt, endExclusive)),
        );
        const [invalidTransferEvidence] = scopedBranchIds.length === 0
          ? [{ count: 0 }]
          : await db
              .select({ count: sql<number>`COUNT(*)` })
              .from(cashTransfers)
              .leftJoin(sentReceipt, eq(sentReceipt.id, cashTransfers.sentReceiptId))
              .leftJoin(receivedReceipt, eq(receivedReceipt.id, cashTransfers.receivedReceiptId))
              .leftJoin(reversalReceipt, eq(reversalReceipt.id, cashTransfers.reversalReceiptId))
              .where(and(
                transferScope,
                or(
                  isNull(sentReceipt.id),
                  sql`NOT COALESCE((${sentReceiptContract!}), FALSE)`,
                  and(
                    isNotNull(cashTransfers.receivedReceiptId),
                    lt(receivedEventAt, endExclusive),
                    or(
                      isNull(receivedReceipt.id),
                      sql`NOT COALESCE((${receivedReceiptContract!}), FALSE)`,
                    ),
                  ),
                  and(
                    isNotNull(cashTransfers.reversalReceiptId),
                    lt(reversalEventAt, endExclusive),
                    or(
                      isNull(reversalReceipt.id),
                      sql`NOT COALESCE((${reversalReceiptContract!}), FALSE)`,
                    ),
                  ),
                  and(
                    isNotNull(cashTransfers.receivedReceiptId),
                    isNotNull(cashTransfers.reversalReceiptId),
                    lt(receivedEventAt, endExclusive),
                    lt(reversalEventAt, endExclusive),
                  ),
                ),
              ));
        if (Number(invalidTransferEvidence?.count ?? 0) > 0) return null;
        const [transferTransitRow] = scopedBranchIds.length === 0
          ? [{ amount: "0.00" }]
          : await db
              .select({ amount: sql<string>`COALESCE(SUM(${cashTransfers.amount}), 0)` })
              .from(cashTransfers)
              .innerJoin(sentReceipt, eq(sentReceipt.id, cashTransfers.sentReceiptId))
              .leftJoin(receivedReceipt, eq(receivedReceipt.id, cashTransfers.receivedReceiptId))
              .leftJoin(reversalReceipt, eq(reversalReceipt.id, cashTransfers.reversalReceiptId))
              .where(and(
                transferScope,
                sentReceiptContract,
                lt(sentEventAt, endExclusive),
                or(
                  isNull(cashTransfers.receivedReceiptId),
                  gte(receivedEventAt, endExclusive),
                ),
                or(
                  isNull(cashTransfers.reversalReceiptId),
                  gte(reversalEventAt, endExclusive),
                ),
              ));
        const cashInTransit = money(custodyTransitRow?.amount ?? 0).plus(transferTransitRow?.amount ?? 0);

        // موضع الدرج عند حدّ التقرير لا عند الحالة الحالية للوردية. الوردية التي أُغلقت
        // في اليوم التالي كانت ما تزال مفتوحة عند القطع، وتسليمٌ لاحق لا يمحو رصيدها تاريخياً.
        const cutoffReceiptShift = alias(shifts, "dayCloseCutoffReceiptShift");
        const cutoffDrawerReceipts = db
          .select({
            shiftId: receipts.shiftId,
            cashIn: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE 0 END), 0)`.as("cashIn"),
            cashOut: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' THEN ${receipts.amount} ELSE 0 END), 0)`.as("cashOut"),
            handoversCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${custodySourceEvidence.receiptId} IS NOT NULL AND UPPER(TRIM(${receipts.referenceNumber})) LIKE 'CH-%' THEN ${receipts.amount} ELSE 0 END), 0)`.as("handoversCash"),
          })
          .from(receipts)
          .innerJoin(
            cutoffReceiptShift,
            and(
              eq(cutoffReceiptShift.id, receipts.shiftId),
              eq(cutoffReceiptShift.branchId, receipts.branchId),
            ),
          )
          .leftJoin(custodySourceEvidence, eq(custodySourceEvidence.receiptId, receipts.id))
          .where(and(
            ...(scopedBranchIds.length > 0 ? [inArray(receipts.branchId, scopedBranchIds)] : []),
            ...materializedDrawerCashConditions(),
            lt(eventAt, endExclusive),
          ))
          .groupBy(receipts.shiftId)
          .as("cutoffDrawerReceipts");
        const closedByCutoff = sql`${shifts.closedAt} IS NOT NULL AND ${shifts.closedAt} < ${endExclusive}`;
        const drawerAtCutoff = sql`CASE
          WHEN ${closedByCutoff} AND ${shifts.countedCash} IS NOT NULL
            THEN ${shifts.countedCash} - COALESCE(${cutoffDrawerReceipts.handoversCash}, 0)
          ELSE ${shifts.openingBalance}
            + COALESCE(${cutoffDrawerReceipts.cashIn}, 0)
            - COALESCE(${cutoffDrawerReceipts.cashOut}, 0)
          END`;
        const [cutoffPosition] = scopedBranchIds.length === 0
          ? [{ expectedDrawersCash: "0.00", openAtCutoffCount: 0, unsettledDrawerCount: 0 }]
          : await db
              .select({
                expectedDrawersCash: sql<string>`COALESCE(SUM(${drawerAtCutoff}), 0)`,
                openAtCutoffCount: sql<number>`COALESCE(SUM(CASE WHEN NOT (${closedByCutoff}) THEN 1 ELSE 0 END), 0)`,
                unsettledDrawerCount: sql<number>`COALESCE(SUM(CASE WHEN ${drawerAtCutoff} <> 0 OR (${closedByCutoff} AND ${shifts.countedCash} IS NULL) THEN 1 ELSE 0 END), 0)`,
              })
              .from(shifts)
              .leftJoin(cutoffDrawerReceipts, eq(cutoffDrawerReceipts.shiftId, shifts.id))
              .leftJoin(openingFloatEntry, openingFloatEntryJoin)
              .leftJoin(openingFloatReceipt, openingFloatReceiptJoin)
              .where(and(
                inArray(shifts.branchId, scopedBranchIds),
                lt(shifts.openedAt, endExclusive),
                fundedShiftVisibleAtCutoff,
              ));
        const expectedDrawersCash = money(cutoffPosition?.expectedDrawersCash ?? 0);
        const openAtCutoffCount = Number(cutoffPosition?.openAtCutoffCount ?? 0);
        const unsettledDrawerCount = Number(cutoffPosition?.unsettledDrawerCount ?? 0);
        const [unmatchedDay] = scopedBranchIds.length === 0
          ? [{ count: 0 }]
          : await db
              .select({
                count: sql<number>`COALESCE(SUM(CASE WHEN
                  ${shifts.closedAt} IS NULL OR ${shifts.closedAt} >= ${endExclusive}
                  OR ${shifts.reconciliationStatus} <> 'MATCHED'
                  OR ${shifts.variance} IS NULL OR ${shifts.variance} <> 0
                  OR ${shifts.expectedCash} IS NULL OR ${shifts.countedCash} IS NULL
                  OR ${shifts.expectedCash} <> ${shifts.countedCash}
                  THEN 1 ELSE 0 END), 0)`,
              })
              .from(shifts)
              .leftJoin(openingFloatEntry, openingFloatEntryJoin)
              .leftJoin(openingFloatReceipt, openingFloatReceiptJoin)
              .where(and(
                inArray(shifts.branchId, scopedBranchIds),
                gte(shifts.openedAt, start),
                lt(shifts.openedAt, endExclusive),
                fundedShiftVisibleAtCutoff,
              ));

        // أي نقد مادي غير منسوب لخزينة أو لوردية لا يدخل المعادلة، ولذلك لا يجوز
        // نشر رقم نهائي ناقص حتى تُعالج السجلات اليتيمة في تقرير المعالجة.
        const orphanReceiptShift = alias(shifts, "dayCloseOrphanReceiptShift");
        const [orphanCash] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(receipts)
          .leftJoin(orphanReceiptShift, eq(orphanReceiptShift.id, receipts.shiftId))
          .where(and(
            // في عرض كل الفروع يجب فحص كل النقد المادي مباشرةً؛ قائمة الفروع
            // المشتقة من الخزائن/الورديات لا تشمل فرعاً لا يحمل إلا سجلاً يتيماً.
            ...(opts.branchId != null ? [eq(receipts.branchId, opts.branchId)] : []),
            eq(receipts.paymentMethod, "CASH"),
            eq(receipts.approvalStatus, "APPROVED"),
            inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
            lt(eventAt, endExclusive),
            or(
              isNull(receipts.cashBucket),
              and(
                eq(receipts.cashBucket, "DRAWER"),
                or(
                  isNull(receipts.shiftId),
                  isNull(orphanReceiptShift.id),
                  ne(orphanReceiptShift.branchId, receipts.branchId),
                ),
              ),
            ),
          ));
        if (Number(orphanCash?.count ?? 0) > 0) return null;

        const isReadyForFinalCount =
          openAtCutoffCount === 0 &&
          unsettledDrawerCount === 0 &&
          Number(unmatchedDay?.count ?? 0) === 0 &&
          cashInTransit.isZero();
        return {
          branchCount: scopedBranches.length,
          expectedTreasuryCash: toDbMoney(expectedTreasuryCash),
          expectedDrawersCash: toDbMoney(expectedDrawersCash),
          cashInTransit: toDbMoney(cashInTransit),
          expectedCashOnHand: toDbMoney(expectedTreasuryCash.plus(expectedDrawersCash).plus(cashInTransit)),
          isReadyForFinalCount,
        };
      })();

  return {
    date: opts.date,
    branchId: opts.branchId ?? null,
    shifts: lines,
    withheldBlindCountShiftCount,
    directOperations,
    directMovements: (() => {
      let tIn = money(0);
      let tOut = money(0);
      const details = directMovementsRes.map((r) => {
        const amt = money(r.amount);
        if (r.direction === 'IN') tIn = tIn.plus(amt);
        else tOut = tOut.plus(amt);
        return {
          id: r.id,
          time: new Date(r.eventAt).toISOString(),
          userName: r.userName,
          direction: r.direction as 'IN' | 'OUT',
          amount: toDbMoney(amt),
          description: r.description || r.referenceNumber || ''
        };
      });
      return {
        count: details.length,
        net: toDbMoney(tIn.minus(tOut)),
        in: toDbMoney(tIn),
        out: toDbMoney(tOut),
        details
      };
    })(),
    receptionExtras: {
      fundedDrafts: {
        count: Number(fundedRow?.c ?? 0),
        heldNet: toDbMoney(money(fundedRow?.t ?? 0)),
      },
      discountByUser,
    },
    cashPosition,
    totals: {
      shiftCount: lines.length,
      openCount,
      closedCount,
      opening: toDbMoney(tOpening),
      salesCash: toDbMoney(tSales.plus(directSales)),
      collectionsCash: toDbMoney(tColl.plus(directCollections)),
      otherIn: toDbMoney(tOtherIn.plus(directOtherIn)),
      cashIn: toDbMoney(tCashIn.plus(directCashIn)),
      returnsCash: toDbMoney(tReturns.plus(directReturns)),
      expensesCash: toDbMoney(tExpenses.plus(directExpenses)),
      otherOut: toDbMoney(tOtherOut.plus(directOtherOut)),
      operatingOut: toDbMoney(tOpOut.plus(directOperatingOut)),
      handoversCash: toDbMoney(tHandovers),
      cashDrops: toDbMoney(tCashDrops),
      expected: toDbMoney(tExpected.plus(directNetCash)),
      counted: toDbMoney(tCounted),
      drift: toDbMoney(tDrift),
      retainedInDrawer: toDbMoney(tRetained),
      closedExpected: toDbMoney(tClosedExpected),
      openRunningExpected: toDbMoney(tOpenRunningExpected),
      physicalDrawerCash: toDbMoney(tRetained.plus(tOpenRunningExpected)),
      directSalesCash: toDbMoney(directSales),
      directCollectionsCash: toDbMoney(directCollections),
      directOtherIn: toDbMoney(directOtherIn),
      directCashIn: toDbMoney(directCashIn),
      directReturnsCash: toDbMoney(directReturns),
      directExpensesCash: toDbMoney(directExpenses),
      directOtherOut: toDbMoney(directOtherOut),
      directOperatingOut: toDbMoney(directOperatingOut),
      directNetCash: toDbMoney(directNetCash),
      shiftSalesCash: toDbMoney(tSales),
      shiftCollectionsCash: toDbMoney(tColl),
      shiftCashIn: toDbMoney(tCashIn),
      shiftOperatingOut: toDbMoney(tOpOut),
      shiftExpected: toDbMoney(tExpected),
    },
    balancedCount,
    driftCount,
    overCount,
    shortCount,
  };
  }, { gate: "NONE" });
}
