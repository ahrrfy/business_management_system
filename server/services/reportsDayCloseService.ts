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
//   لذا تُعرَض منفصلةً («سُلّم للخزينة») مع «المتبقّي في الدرج» = المعدود − التسليمات.
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
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { branches, expenses, receipts, shifts, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { utcDayRange } from "./businessDay";
import { money, toDbMoney } from "./money";

/** سطر مطابقة وردية واحدة. كل الحقول المالية نصّية decimal(15,2). */
export interface DayCloseShiftLine {
  shiftId: number;
  branchId: number;
  branchName: string | null;
  userId: number;
  userName: string | null;
  shiftType: "RETAIL" | "RECEPTION";
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
  handoversCash: string;    // سُلّم للخزينة الإدارية (CH-…)
  cashDrops: string;        // خطاف شريحة لاحقة (السحب أثناء الوردية) — صفر حالياً
  // ── المطابقة ──
  expected: string;         // opening + cashIn − operatingOut  (== storedExpectedCash)
  counted: string | null;   // shifts.countedCash (null لوردية مفتوحة)
  drift: string | null;     // counted − expected (== storedVariance)؛ +فائض / −عجز
  retainedInDrawer: string | null; // counted − handoversCash (النقد المتبقّي فعلاً بعد التسليم)
  // ── القيم المخزَّنة (تأكيد التطابق مع Z-report) ──
  storedExpectedCash: string | null;
  storedVariance: string | null;
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
}

export interface DayCloseReconciliationResult {
  date: string;
  branchId: number | null;
  shifts: DayCloseShiftLine[];
  totals: DayCloseTotals;
  balancedCount: number; // ورديات مغلقة فرقها = صفر
  driftCount: number;    // ورديات مغلقة فرقها ≠ صفر
  overCount: number;     // فائض (drift > 0)
  shortCount: number;    // عجز (drift < 0)
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
}): Promise<DayCloseReconciliationResult> {
  const emptyTotals: DayCloseTotals = {
    shiftCount: 0, openCount: 0, closedCount: 0,
    opening: "0.00", salesCash: "0.00", collectionsCash: "0.00", otherIn: "0.00", cashIn: "0.00",
    returnsCash: "0.00", expensesCash: "0.00", otherOut: "0.00", operatingOut: "0.00",
    handoversCash: "0.00", cashDrops: "0.00", expected: "0.00", counted: "0.00", drift: "0.00",
    retainedInDrawer: "0.00",
  };
  const base: DayCloseReconciliationResult = {
    date: opts.date,
    branchId: opts.branchId ?? null,
    shifts: [],
    totals: emptyTotals,
    balancedCount: 0, driftCount: 0, overCount: 0, shortCount: 0,
  };

  const db = getDb();
  if (!db) return base;

  // نطاق اليوم التجاريّ [start, endExclusive) على openedAt (اتّساقاً مع بقية تقارير الخزينة).
  const { start, endExclusive } = utcDayRange(opts.date, opts.date);

  const shiftConds = [gte(shifts.openedAt, start), lt(shifts.openedAt, endExclusive)];
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
    .where(and(...shiftConds))
    .orderBy(shifts.branchId, shifts.openedAt, shifts.id);

  if (shiftRows.length === 0) return base;

  const shiftIds = shiftRows.map((r) => Number(r.shiftId));

  // تفكيك مقبوضات/مدفوعات الدرج النقدية لكل وردية عبر SUM(CASE …). البِنى متنافية بالإنشاء:
  //   • تسليم الخزينة يحمل referenceNumber='CH-…' وبلا voucherNumber/expense/invoiceId ⇒ دلوُه وحده.
  //   • salesCash: IN بفاتورة بلا سند. collectionsCash: IN بسند قبض. (otherIn = المتبقّي.)
  //   • expensesCash: OUT بسند صرف أو مصروف مرتبط. returnsCash: OUT بفاتورة بلا سند/مصروف/CH.
  // cashIn/cashOut إجماليّان (الصيغة القانونية) ⇒ otherIn/otherOut = بواقٍ تضمن التطابق دوماً.
  const isDrawerCash = and(
    inArray(receipts.shiftId, shiftIds),
    eq(receipts.cashBucket, "DRAWER"),
    eq(receipts.paymentMethod, "CASH"),
  );
  const aggRows = await db
    .select({
      shiftId: receipts.shiftId,
      cashIn: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE 0 END), 0)`,
      cashOut: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' THEN ${receipts.amount} ELSE 0 END), 0)`,
      salesCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.voucherNumber} IS NULL AND ${receipts.invoiceId} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
      collectionsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND ${receipts.voucherNumber} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
      handoversCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${receipts.referenceNumber} LIKE 'CH-%' THEN ${receipts.amount} ELSE 0 END), 0)`,
      cashDropsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND ${receipts.referenceNumber} LIKE 'CD-%' THEN ${receipts.amount} ELSE 0 END), 0)`,
      expensesCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND (${receipts.referenceNumber} IS NULL OR ${receipts.referenceNumber} NOT LIKE 'CH-%') AND (${receipts.voucherNumber} IS NOT NULL OR ${expenses.id} IS NOT NULL) THEN ${receipts.amount} ELSE 0 END), 0)`,
      returnsCash: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND (${receipts.referenceNumber} IS NULL OR ${receipts.referenceNumber} NOT LIKE 'CH-%') AND ${receipts.voucherNumber} IS NULL AND ${expenses.id} IS NULL AND ${receipts.invoiceId} IS NOT NULL THEN ${receipts.amount} ELSE 0 END), 0)`,
    })
    .from(receipts)
    .leftJoin(expenses, eq(expenses.receiptId, receipts.id))
    .where(isDrawerCash)
    .groupBy(receipts.shiftId);

  const aggByShift = new Map<number, ReceiptAgg>();
  for (const r of aggRows) {
    aggByShift.set(Number(r.shiftId), {
      cashIn: r.cashIn, cashOut: r.cashOut, salesCash: r.salesCash,
      collectionsCash: r.collectionsCash, handoversCash: r.handoversCash,
      cashDropsCash: r.cashDropsCash,
      expensesCash: r.expensesCash, returnsCash: r.returnsCash,
    });
  }

  // مُجمِّعات الإجماليات (decimal).
  let tOpening = money(0), tSales = money(0), tColl = money(0), tOtherIn = money(0), tCashIn = money(0);
  let tReturns = money(0), tExpenses = money(0), tOtherOut = money(0), tOpOut = money(0);
  let tHandovers = money(0), tCashDrops = money(0), tExpected = money(0), tCounted = money(0), tDrift = money(0), tRetained = money(0);
  let openCount = 0, closedCount = 0, balancedCount = 0, driftCount = 0, overCount = 0, shortCount = 0;

  const lines: DayCloseShiftLine[] = shiftRows.map((sh) => {
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
      if (drift!.isZero()) balancedCount++;
      else {
        driftCount++;
        if (drift!.isPositive()) overCount++;
        else shortCount++;
      }
    } else {
      openCount++;
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
      shiftType: sh.shiftType as "RETAIL" | "RECEPTION",
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
    };
  });

  return {
    date: opts.date,
    branchId: opts.branchId ?? null,
    shifts: lines,
    totals: {
      shiftCount: lines.length,
      openCount,
      closedCount,
      opening: toDbMoney(tOpening),
      salesCash: toDbMoney(tSales),
      collectionsCash: toDbMoney(tColl),
      otherIn: toDbMoney(tOtherIn),
      cashIn: toDbMoney(tCashIn),
      returnsCash: toDbMoney(tReturns),
      expensesCash: toDbMoney(tExpenses),
      otherOut: toDbMoney(tOtherOut),
      operatingOut: toDbMoney(tOpOut),
      handoversCash: toDbMoney(tHandovers),
      cashDrops: toDbMoney(tCashDrops),
      expected: toDbMoney(tExpected),
      counted: toDbMoney(tCounted),
      drift: toDbMoney(tDrift),
      retainedInDrawer: toDbMoney(tRetained),
    },
    balancedCount,
    driftCount,
    overCount,
    shortCount,
  };
}
