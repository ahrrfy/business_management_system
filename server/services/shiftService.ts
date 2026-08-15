import { TRPCError } from "@trpc/server";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import {
  expenses,
  invoices,
  receipts,
  shifts,
  users,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { money, toDbMoney } from "./money";
import type { Tx } from "../db";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { isDupEntry } from "@shared/errorMap.ar";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { postEntry } from "./ledgerService";
import {
  assertCashOutAvailable,
  assertTreasuryOutException,
  computeDrawerCashBalance,
} from "./cash/cashAvailability";
import { utcTodayStart } from "./businessDay";
import { assertPeriodOpen } from "./periodLockService";
import { lockBranchMonthCloseGate } from "./reports/monthCloseGate";
import {
  IQD_DENOMINATIONS,
  MATERIAL_SHIFT_VARIANCE_IQD,
  SHIFT_VARIANCE_CODES,
  type ShiftVarianceCode,
} from "@shared/shiftCashGovernance";

/**
 * نوع الوردية — كلٌّ درجٌ/رصيد افتتاحي/Z-report مستقلّ:
 *  - RETAIL: كاشير التجزئة/القرطاسية.
 *  - RECEPTION: خدمة الزبائن (استقبال أوامر الشغل — عرابين).
 *  - PRINT_SERVICES: كاشير خدمات الطباعة والاستنساخ (قرار المالك ٢٣/٧/٢٦: فصلٌ كامل عن التجزئة).
 */
export type ShiftType = "RETAIL" | "RECEPTION" | "PRINT_SERVICES";

const VARIANCE_EPSILON = money("0.005");
const ALLOWED_DENOMINATIONS = new Set<number>(IQD_DENOMINATIONS);

function validateCountedBreakdown(
  breakdown: Record<string, number> | null | undefined,
  countedCash: ReturnType<typeof money>,
) {
  // كائنٌ فارغ {} = غياب كشفٍ لا كشفٌ مجموعه صفر: المسار الافتراضي الجديد (كتابة المعدود مباشرةً)
  // قد يمرّر {} فلا يجوز معاملته ككشف فئات حقيقيّ (وإلّا رُفض أيّ معدود موجب بـ«مجموع الفئات 0 ≠ المعدود»).
  if (!breakdown || Object.keys(breakdown).length === 0) return null;
  let total = money("0");
  for (const [rawDenomination, rawCount] of Object.entries(breakdown)) {
    const denomination = Number(rawDenomination);
    if (!ALLOWED_DENOMINATIONS.has(denomination)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `فئة نقدية غير معتمدة في العد: ${rawDenomination}`,
      });
    }
    if (!Number.isSafeInteger(rawCount) || rawCount < 0 || rawCount > 10_000) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `عدد الأوراق غير صالح لفئة ${rawDenomination}`,
      });
    }
    total = total.plus(money(String(denomination)).times(rawCount));
  }
  if (!total.eq(countedCash)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `مجموع عدّ الفئات (${total.toFixed(2)}) لا يساوي النقد المعدود (${countedCash.toFixed(2)}). أعد العد قبل الإغلاق.`,
    });
  }
  return total;
}

/** Open a shift. One open shift per user per branch **per type** (RETAIL/RECEPTION/PRINT_SERVICES). */
export async function openShift(
  input: {
    branchId: number;
    openingBalance: string;
    shiftType?: ShiftType;
  },
  actor: Actor,
) {
  const shiftType: ShiftType = input.shiftType ?? "RETAIL";
  const executeOpen = async (tx: Tx) => {
    // يتسلسل مع اعتماد الإقفال العام. بعد نيل القفل نعيد فحص اليوم مقابل أحدث period lock؛
    // الصفر في الرصيد الافتتاحي لا يجوز أن يصنع مساراً يتجاوز الحارس لغياب postEntry.
    await lockBranchMonthCloseGate(tx, input.branchId);
    await assertPeriodOpen(tx, utcTodayStart());

    const existing = await tx
      .select({ id: shifts.id })
      .from(shifts)
      .where(
        and(
          eq(shifts.userId, actor.userId),
          eq(shifts.branchId, input.branchId),
          eq(shifts.status, "OPEN"),
          eq(shifts.shiftType, shiftType),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          shiftType === "RECEPTION"
            ? "لديك وردية خدمة زبائن مفتوحة بالفعل في هذا الفرع"
            : shiftType === "PRINT_SERVICES"
              ? "لديك وردية خدمات طباعة مفتوحة بالفعل في هذا الفرع"
              : "لديك وردية مفتوحة بالفعل في هذا الفرع",
      });
    }

    // ورديات مستقلّة (قرار المالك ٢٨/٧/٢٦): كلّ وردية برصيدها الافتتاحيّ الخاصّ (عهدة جديدة تُصرَف عند
    // البدء) ورصيدها الذي تنتهي به، بمعزلٍ تامٍّ عن السابقة واللاحقة — لا مطابقةَ لمتبقّي وردية سابقة
    // ولا حظر. النقد يُسلَّم كاملاً للخزينة بين الورديتين، ثم تبدأ التالية بعهدةٍ من الخزينة. الضبط ضدّ
    // التسرّب يبقى قائماً *داخل* الوردية: closeShift يحسب المتوقَّع = الافتتاحيّ + المبيعات النقدية −
    // المدفوعات ويقارنه بالمعدود ⇒ فرق الوردية مسجَّلٌ ومعزولٌ لصاحبها. العمودان openingExpectedCash/
    // openingDiscrepancyReason مُهمَلان الآن (يبقيان null بلا هجرة إسقاط).
    const opening = money(input.openingBalance);
    // ترتيب الأقفال الحاكم هو مصدر النقد ثم المستند. إدراج الوردية أولاً يأخذ قفل FK مشتركاً
    // على الفرع، فتستطيع معاملتا فتح متزامنتان أن تتعطلا كلتاهما عند محاولة ترقيته إلى X.
    // لذلك نتحقق من تمويل الخزينة ونقفل حسابها قبل إنشاء صف الوردية نفسه.
    if (opening.gt(0)) assertTreasuryOutException("SHIFT_FLOAT_INTERNAL");
    const treasuryAvailability = opening.gt(0)
      ? await assertCashOutAvailable(tx, {
          branchId: input.branchId,
          cashBucket: "TREASURY",
          amount: opening,
          operation: "تمويل عهدة افتتاح الوردية",
        })
      : null;
    try {
      const res = await tx.insert(shifts).values({
        branchId: input.branchId,
        userId: actor.userId,
        openingBalance: toDbMoney(input.openingBalance),
        status: "OPEN",
        shiftType,
        openGuard: `${actor.userId}:${input.branchId}:${shiftType}`, // حارس ذرّي ضدّ الفتح المزدوج المتزامن لنفس النوع
        openingExpectedCash: null,
        openingDiscrepancyReason: null,
      });
      const shiftId = extractInsertId(res);

      // العهدة الوسيطة (imprest، قرار المالك ٢٨/٧/٢٦؛ إصلاح Codex P1 على #377): عهدة الافتتاح تُسحَب
      // فعلياً من **الخزينة** إلى الدرج ⇒ نُسجّل حركة خزينة صريحة (TREASURY OUT) وإلّا فُكَّت لوحة الخزينة
      // (الدرج يزيد بلا نقصان مقابل في الخزينة ⇒ ازدواج وهميّ). جانب الدرج ضمنيّ في اللوحة (Σ openingBalance
      // للورديات المفتوحة) فلا نُنشئ إيصال DRAWER IN (وإلّا احتُسِب مرّتين). إن نقصت الخزينة عن العهدة
      // يُرفض فتح الوردية ذرياً إن لم تكفِ الخزينة؛ حدّ الصلاحية لا يصنع نقداً ولا يسمح بعهدة سالبة.
      let treasuryBalanceAfter: string | null = null;
      let treasuryWarning = false;
      if (opening.gt(0)) {
        treasuryBalanceAfter = treasuryAvailability!.availableAfter;
        treasuryWarning = false;
        const outRes = await tx.insert(receipts).values({
          branchId: input.branchId,
          shiftId: null, // حركة خزينة (لا درج) ⇒ خارج computeExpectedCash لأيّ وردية
          direction: "OUT",
          amount: toDbMoney(opening),
          paymentMethod: "CASH",
          cashBucket: "TREASURY",
          referenceNumber: `SF-${input.branchId}-${shiftId}`, // فريد بنيوياً: عهدة واحدة لكل وردية
          status: "COMPLETED",
          partyType: "OTHER",
          description: `عهدة افتتاح وردية #${shiftId} (سحب من الخزينة)`,
          createdBy: actor.userId,
        });
        const outReceiptId = extractInsertId(outRes);
        // قيد SHIFT_FLOAT_OUT (نقلٌ خزينة→درج، revenue/cost=0). dedupeKey فريد لكل وردية.
        await postEntry(tx, {
          entryType: "SHIFT_FLOAT_OUT",
          postingIntent: createPostingIntent("SHIFT_FLOAT_FROM_TREASURY", "SHIFT_FLOAT_OUT", [
            debitLine("CASH", opening),
            creditLine("TREASURY_CASH", opening),
          ]),
          branchId: input.branchId,
          receiptId: outReceiptId,
          amount: opening,
          dedupeKey: `SHIFT_FLOAT:${shiftId}`,
        });
      }

      return {
        shiftId,
        expectedOpening: null as string | null,
        hasDiscrepancy: false,
        difference: null as string | null,
        discrepancyReason: null as string | null,
        // العهدة الوسيطة: رصيد الخزينة بعد السحب. يبقى الحقل التاريخي treasuryWarning=false
        // حفاظاً على عقد الاستجابة؛ العجز لم يعد حالة نجاح ممكنة.
        treasuryBalanceAfter,
        treasuryWarning,
      };
    } catch (e: any) {
      if (isDupEntry(e)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "لديك وردية مفتوحة بالفعل في هذا الفرع",
        });
      }
      throw e;
    }
  };
  return withTx(executeOpen, { gate: "FINANCIAL_WRITER" });
}

/** Expected cash = opening balance + cash received − cash refunded during the shift. */
export async function computeExpectedCash(
  tx: Tx,
  shiftId: number,
  openingBalance: string,
) {
  // فلتر DRAWER+CASH وصيغة حالات الإلغاء يعيشان في الدالة المركزية نفسها التي يستعملها
  // حارس الصرف؛ هذا يمنع انجراف Z-report عن الرصيد الذي سمح الحارس بإنفاقه.
  return computeDrawerCashBalance(tx, shiftId, openingBalance);
}

/**
 * Close a shift: compute expected cash, record counted cash + variance.
 * سياسة #14 — ملكية/فرع: الكاشير يُغلق ورديته نفسها فقط؛ المدير يُغلق أي وردية في فرعه
 * (لمعالجة الوردية المنسيّة)؛ admin مرور حر.
 *
 * العهدة الوسيطة (imprest، قرار المالك ٢٨/٧/٢٦): عند الإغلاق يعود **كامل** النقد المعدود إلى الخزينة
 * تلقائياً (settleShiftReturnTx داخل نفس الـtx) ⇒ الدرج يُفرَّغ (closingDrawerCash=0). countedBreakdown
 * اختياري (snapshot عدّاد الفئات). لا يقبل هذا الطور تسليماً جزئياً/يدوياً من العميل — الإرجاع كامل وحتميّ.
 */
export async function closeShift(
  input: {
    shiftId: number;
    countedCash: string;
    countedBreakdown?: Record<string, number> | null;
    varianceReasonCode?: ShiftVarianceCode | null;
    varianceReason?: string | null;
    /** هوية مدير تحقّق الراوتر من بياناته؛ لا تُقبل أبداً من حمولة العميل مباشرة. */
    managerApprovedByUserId?: number | null;
    /** تضبطها بوابة API. تُترك اختيارية لتوافق مهام الصيانة/الاختبارات الداخلية القديمة. */
    enforceCashGovernance?: boolean;
  },
  actor: Actor & { role?: string },
) {
  const executeClose = async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(shifts)
      .where(eq(shifts.id, input.shiftId))
      .for("update")
      .limit(1);
    const sh = rows[0];
    if (!sh)
      throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });

    const role = actor.role ?? "cashier";
    if (role === "admin") {
      // مرور حر — للمعالجة العابرة للفروع.
    } else if (role === "manager") {
      if (Number(sh.branchId) !== actor.branchId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا يمكنك إغلاق وردية فرع آخر",
        });
      }
    } else {
      if (Number(sh.userId) !== actor.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا يمكنك إغلاق وردية موظّف آخر",
        });
      }
      if (Number(sh.branchId) !== actor.branchId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "لا يمكنك إغلاق وردية فرع آخر",
        });
      }
    }

    // أوفلاين (ش٤) — إغلاق idempotent: انقطاعٌ منتصف الإغلاق (الالتزام تمّ والردّ ضاع) كان
    // يجعل إعادة المحاولة تفشل بـ«مغلقة بالفعل» فيظن الكاشير أن الإغلاق لم يتم. الآن نعيد
    // اللقطة الملتزمة كما هي (بلا أي كتابة — countedCash الجديدة تُهمَل عمداً: الحقيقة هي أول
    // إغلاق ملتزم، وإعادة العدّ لا تُعدّل Z-report بأثر رجعي). فحوص الملكية أعلاه تسبق هذا.
    if (sh.status !== "OPEN") {
      return {
        shiftId: input.shiftId,
        openingBalance: toDbMoney(money(sh.openingBalance)),
        expectedCash: toDbMoney(money(sh.expectedCash ?? "0")),
        countedCash: toDbMoney(money(sh.countedCash ?? "0")),
        variance: toDbMoney(money(sh.variance ?? "0")),
        reconciliationStatus: sh.reconciliationStatus,
        varianceReasonCode: sh.varianceReasonCode,
        varianceReason: sh.varianceReason,
        requiresManagerReview: money(sh.variance ?? "0")
          .abs()
          .gte(MATERIAL_SHIFT_VARIANCE_IQD),
        treasuryReturn: null,
        alreadyClosed: true as const,
      };
    }

    const expected = await computeExpectedCash(
      tx,
      input.shiftId,
      sh.openingBalance,
    );
    const counted = money(input.countedCash);
    const variance = counted.minus(expected);
    const hasVariance = variance.abs().gt(VARIANCE_EPSILON);
    const isMaterialVariance = variance.abs().gte(MATERIAL_SHIFT_VARIANCE_IQD);
    const reason = (input.varianceReason ?? "").trim();
    const reasonCode = input.varianceReasonCode ?? null;
    const varianceApproverId =
      role === "manager" || role === "admin"
        ? actor.userId
        : (input.managerApprovedByUserId ?? null);

    // العدّ يثبت الموجود مادياً فقط ولا ينشئ مصدراً نقدياً. بوابة API لا تسمح بإغلاق
    // الوردية مع أي فرق، حتى بموافقة مدير: يجب تصحيح الفاتورة/المرتجع أو تسجيل الحركة
    // النظامية من وحدتها المختصة أولاً، ثم يعاد احتساب المتوقع وتتم المطابقة.
    validateCountedBreakdown(input.countedBreakdown, counted);
    if (input.enforceCashGovernance && hasVariance) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          `لا يمكن إغلاق الوردية لأن النقد المعدود (${counted.toFixed(2)} د.ع) ` +
          `لا يساوي النقد المتوقع من المصادر المسجلة (${expected.toFixed(2)} د.ع)، ` +
          `والفرق ${variance.toFixed(2)} د.ع. العدّ لا ينشئ مالاً: راجع الرصيد الافتتاحي ` +
          `والمبيعات والمرتجعات النقدية، وسجّل أو صحّح العملية من وحدتها المختصة ثم أعد الإغلاق.`,
      });
    }

    // العهدة الوسيطة (imprest، قرار المالك ٢٨/٧/٢٦): يعود **كامل** النقد المعدود إلى الخزينة تلقائياً
    // (drawer→0) — لا تسليم جزئيّ/يدويّ. هذا يُبقي لوحة الخزينة متّسقة مع سحب العهدة عند الفتح: صافي
    // أثر الخزينة للوردية = المعدود − عهدة الافتتاح = المبيعات النقدية − المدفوعات النقدية. يُنفَّذ **بعد**
    // computeExpectedCash أعلاه (إيصال الإرجاع OUT بـshiftId هذا لا يدخل حساب المتوقَّع لأنه بعده).
    let treasuryReturn: {
      handoverNumber: string;
      outReceiptId: number;
      inReceiptId: number;
    } | null = null;
    if (counted.gt(0)) {
      // استيراد كسول لتجنّب حلقة (cashHandover → ledger → period).
      const { settleShiftReturnTx } = await import("./cashHandoverService");
      treasuryReturn = await settleShiftReturnTx(
        tx,
        {
          shiftId: input.shiftId,
          branchId: Number(sh.branchId),
          amount: toDbMoney(counted),
        },
        { ...actor, role: actor.role ?? "cashier" },
      );
    }

    // الدرج يُفرَّغ كاملاً للخزينة عند الإغلاق ⇒ المتبقّي دائماً صفر (ورديات مستقلّة: التالية تسحب عهدةً
    // جديدة من الخزينة لا من متبقّي السابقة). العمود يبقى للتوافق ولإعادة طباعة Z-report.
    const closingDrawerCash = money("0");

    await tx
      .update(shifts)
      .set({
        status: "CLOSED",
        closedAt: new Date(),
        openGuard: null, // يحرّر الحارس ⇒ يسمح بفتح وردية جديدة لنفس الموظّف/الفرع
        expectedCash: toDbMoney(expected),
        countedCash: toDbMoney(counted),
        variance: toDbMoney(variance),
        countedBreakdown: input.countedBreakdown ?? null,
        closingDrawerCash: toDbMoney(closingDrawerCash), // ①ج متبقّي الدرج للوردية التالية
        varianceReasonCode: hasVariance ? reasonCode : null,
        varianceReason: hasVariance ? reason : null,
        reconciliationStatus: !hasVariance
          ? "MATCHED"
          : varianceApproverId
            ? "MANAGER_APPROVED"
            : "EXPLAINED",
        closedByUserId: actor.userId,
        varianceReviewedByUserId: hasVariance ? varianceApproverId : null,
      })
      .where(eq(shifts.id, input.shiftId));

    return {
      shiftId: input.shiftId,
      openingBalance: toDbMoney(sh.openingBalance),
      expectedCash: toDbMoney(expected),
      countedCash: toDbMoney(counted),
      variance: toDbMoney(variance),
      reconciliationStatus: !hasVariance
        ? ("MATCHED" as const)
        : varianceApproverId
          ? ("MANAGER_APPROVED" as const)
          : ("EXPLAINED" as const),
      varianceReasonCode: hasVariance ? reasonCode : null,
      varianceReason: hasVariance ? reason : null,
      requiresManagerReview: isMaterialVariance,
      treasuryReturn,
    };
  };
  return withTx(executeClose, { gate: "FINANCIAL_WRITER" });
}

type CashReconciliationCategory =
  | "opening"
  | "cashSales"
  | "priorInvoiceCollections"
  | "otherCashIn"
  | "cashRefunds"
  | "expenses"
  | "cashDrops"
  | "otherCashOut";

export interface ShiftCashReconciliationItem {
  category: CashReconciliationCategory | "treasuryHandover";
  receiptId: number | null;
  documentType:
    | "SHIFT"
    | "INVOICE"
    | "EXPENSE"
    | "WORK_ORDER"
    | "RESERVATION"
    | "VOUCHER"
    | "RECEIPT";
  documentId: number | string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  invoiceShiftId: number | null;
  expenseId: number | null;
  workOrderId: number | null;
  reservationId: number | null;
  voucherNumber: string | null;
  referenceNumber: string | null;
  description: string | null;
  direction: "IN" | "OUT" | null;
  amount: string;
  createdBy: number | null;
  createdByName: string | null;
  timestamp: Date;
  cashBucket: "DRAWER" | "TREASURY" | null;
  shiftId: number | null;
  receiptStatus: "PENDING" | "COMPLETED" | "FAILED" | "REVERSED" | null;
  approvalStatus: "APPROVED" | "PENDING_APPROVAL" | "REJECTED" | null;
  pairedTreasuryReceiptId: number | null;
  pairedTreasuryReceiptStatus:
    | "PENDING"
    | "COMPLETED"
    | "FAILED"
    | "REVERSED"
    | null;
}

/** Z-report data: invoice headline + a receipt-level cash reconciliation for the shift. */
export async function getShiftReport(shiftId: number) {
  const db = getDb();
  if (!db) return null;
  const sh = (
    await db.select().from(shifts).where(eq(shifts.id, shiftId)).limit(1)
  )[0];
  if (!sh) return null;

  const receiptRows = await db
    .select({
      id: receipts.id,
      invoiceId: receipts.invoiceId,
      workOrderId: receipts.workOrderId,
      reservationId: receipts.reservationId,
      branchId: receipts.branchId,
      shiftId: receipts.shiftId,
      direction: receipts.direction,
      amount: receipts.amount,
      paymentMethod: receipts.paymentMethod,
      cashBucket: receipts.cashBucket,
      referenceNumber: receipts.referenceNumber,
      voucherNumber: receipts.voucherNumber,
      description: receipts.description,
      status: receipts.status,
      approvalStatus: receipts.approvalStatus,
      createdBy: receipts.createdBy,
      createdAt: receipts.createdAt,
      createdByName: users.name,
      invoiceNumber: invoices.invoiceNumber,
      invoiceShiftId: invoices.shiftId,
    })
    .from(receipts)
    .leftJoin(invoices, eq(receipts.invoiceId, invoices.id))
    .leftJoin(users, eq(receipts.createdBy, users.id))
    .where(eq(receipts.shiftId, shiftId));

  // reportsDayCloseService يصنّف المصروف المرتبط عبر expenses.receiptId. نجلب الرابط منفصلاً
  // كي يبقى كل إيصال سطراً واحداً حتى لو وُجدت بيانات مصروف مكرّرة/تالفة على الإيصال نفسه.
  const receiptIds = receiptRows.map((row) => Number(row.id));
  const expenseRows =
    receiptIds.length === 0
      ? []
      : await db
          .select({
            id: expenses.id,
            receiptId: expenses.receiptId,
            description: expenses.description,
            referenceNumber: expenses.referenceNumber,
          })
          .from(expenses)
          .where(inArray(expenses.receiptId, receiptIds));
  const expenseByReceipt = new Map<number, (typeof expenseRows)[number]>();
  for (const expense of expenseRows) {
    if (
      expense.receiptId != null &&
      !expenseByReceipt.has(Number(expense.receiptId))
    ) {
      expenseByReceipt.set(Number(expense.receiptId), expense);
    }
  }

  // لا تكفي بادئة CH/CD وحدها: قد تكون مرجعاً تجارياً مشروعاً. نعدّ الحركة تحويلاً داخلياً
  // فقط إذا كان OUT نقد/درج غير مرتبط بمستند وله IN نقد/خزينة مطابق في الفرع والمرجع والمبلغ.
  const transferCandidates = receiptRows.filter((row) => {
    const reference = row.referenceNumber ?? "";
    return (
      row.direction === "OUT" &&
      row.paymentMethod === "CASH" &&
      row.cashBucket === "DRAWER" &&
      (reference.startsWith("CH-") || reference.startsWith("CD-")) &&
      row.invoiceId == null &&
      row.workOrderId == null &&
      row.reservationId == null &&
      row.voucherNumber == null &&
      !expenseByReceipt.has(Number(row.id))
    );
  });
  const transferReferences = Array.from(
    new Set(
      transferCandidates
        .map((row) => row.referenceNumber)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const treasuryPairs =
    transferReferences.length === 0
      ? []
      : await db
          .select({
            id: receipts.id,
            branchId: receipts.branchId,
            referenceNumber: receipts.referenceNumber,
            amount: receipts.amount,
            status: receipts.status,
          })
          .from(receipts)
          .where(
            and(
              eq(receipts.branchId, Number(sh.branchId)),
              eq(receipts.direction, "IN"),
              eq(receipts.paymentMethod, "CASH"),
              eq(receipts.cashBucket, "TREASURY"),
              inArray(receipts.referenceNumber, transferReferences),
            ),
          );
  const treasuryPairsByKey = new Map<
    string,
    (typeof treasuryPairs)[number][]
  >();
  for (const pair of treasuryPairs) {
    if (!pair.referenceNumber) continue;
    const key = `${Number(pair.branchId)}:${pair.referenceNumber}:${toDbMoney(money(pair.amount))}`;
    const matches = treasuryPairsByKey.get(key) ?? [];
    matches.push(pair);
    treasuryPairsByKey.set(key, matches);
  }
  const pairedTransferByReceipt = new Map<
    number,
    (typeof treasuryPairs)[number]
  >();
  for (const candidate of transferCandidates) {
    const key = `${Number(candidate.branchId)}:${candidate.referenceNumber}:${toDbMoney(money(candidate.amount))}`;
    // مطابقة واحد-لواحد: لا يجوز لإيصال خزينة واحد أن «يُثبت» سحبَين متكرّرين بنفس المرجع/المبلغ.
    const pair = treasuryPairsByKey.get(key)?.shift();
    if (pair) pairedTransferByReceipt.set(Number(candidate.id), pair);
  }

  const owner =
    sh.userId == null
      ? null
      : ((
          await db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, Number(sh.userId)))
            .limit(1)
        )[0] ?? null);

  const openingItem: ShiftCashReconciliationItem = {
    category: "opening",
    receiptId: null,
    documentType: "SHIFT",
    documentId: shiftId,
    invoiceId: null,
    invoiceNumber: null,
    invoiceShiftId: null,
    expenseId: null,
    workOrderId: null,
    reservationId: null,
    voucherNumber: null,
    referenceNumber: null,
    description: "رصيد افتتاح الوردية",
    direction: null,
    amount: toDbMoney(money(sh.openingBalance)),
    createdBy: sh.userId == null ? null : Number(sh.userId),
    createdByName: owner?.name ?? null,
    timestamp: sh.openedAt,
    cashBucket: "DRAWER",
    shiftId,
    receiptStatus: null,
    approvalStatus: null,
    pairedTreasuryReceiptId: null,
    pairedTreasuryReceiptStatus: null,
  };

  const makeItem = (
    row: (typeof receiptRows)[number],
    category:
      | Exclude<CashReconciliationCategory, "opening">
      | "treasuryHandover",
  ): ShiftCashReconciliationItem => {
    const expense = expenseByReceipt.get(Number(row.id));
    const pair = pairedTransferByReceipt.get(Number(row.id));
    const documentType = expense
      ? "EXPENSE"
      : row.invoiceId != null
        ? "INVOICE"
        : row.workOrderId != null
          ? "WORK_ORDER"
          : row.reservationId != null
            ? "RESERVATION"
            : row.voucherNumber != null
              ? "VOUCHER"
              : "RECEIPT";
    const documentId = expense
      ? Number(expense.id)
      : row.invoiceId != null
        ? Number(row.invoiceId)
        : row.workOrderId != null
          ? Number(row.workOrderId)
          : row.reservationId != null
            ? Number(row.reservationId)
            : (row.voucherNumber ?? Number(row.id));
    return {
      category,
      receiptId: Number(row.id),
      documentType,
      documentId,
      invoiceId: row.invoiceId == null ? null : Number(row.invoiceId),
      invoiceNumber: row.invoiceNumber ?? null,
      invoiceShiftId:
        row.invoiceShiftId == null ? null : Number(row.invoiceShiftId),
      expenseId: expense ? Number(expense.id) : null,
      workOrderId: row.workOrderId == null ? null : Number(row.workOrderId),
      reservationId:
        row.reservationId == null ? null : Number(row.reservationId),
      voucherNumber: row.voucherNumber ?? null,
      referenceNumber: row.referenceNumber ?? expense?.referenceNumber ?? null,
      description: row.description ?? expense?.description ?? null,
      direction: row.direction,
      amount: toDbMoney(money(row.amount)),
      createdBy: row.createdBy == null ? null : Number(row.createdBy),
      createdByName: row.createdByName ?? null,
      timestamp: row.createdAt,
      cashBucket: row.cashBucket,
      shiftId: row.shiftId == null ? null : Number(row.shiftId),
      receiptStatus: row.status,
      approvalStatus: row.approvalStatus,
      pairedTreasuryReceiptId: pair ? Number(pair.id) : null,
      pairedTreasuryReceiptStatus: pair?.status ?? null,
    };
  };

  const breakdown: Record<
    CashReconciliationCategory,
    ShiftCashReconciliationItem[]
  > = {
    opening: [openingItem],
    cashSales: [],
    priorInvoiceCollections: [],
    otherCashIn: [],
    cashRefunds: [],
    expenses: [],
    cashDrops: [],
    otherCashOut: [],
  };
  const treasuryHandovers: ShiftCashReconciliationItem[] = [];

  for (const row of receiptRows) {
    if (row.paymentMethod !== "CASH" || row.cashBucket !== "DRAWER") continue;
    const pairedTransfer = pairedTransferByReceipt.get(Number(row.id));
    if (pairedTransfer && row.referenceNumber?.startsWith("CH-")) {
      treasuryHandovers.push(makeItem(row, "treasuryHandover"));
      continue;
    }
    if (row.direction === "IN") {
      if (row.invoiceId != null && Number(row.invoiceShiftId) === shiftId) {
        breakdown.cashSales.push(makeItem(row, "cashSales"));
      } else if (row.invoiceId != null) {
        breakdown.priorInvoiceCollections.push(
          makeItem(row, "priorInvoiceCollections"),
        );
      } else {
        breakdown.otherCashIn.push(makeItem(row, "otherCashIn"));
      }
      continue;
    }
    if (pairedTransfer && row.referenceNumber?.startsWith("CD-")) {
      breakdown.cashDrops.push(makeItem(row, "cashDrops"));
    } else if (
      row.invoiceId != null &&
      row.voucherNumber == null &&
      !expenseByReceipt.has(Number(row.id))
    ) {
      breakdown.cashRefunds.push(makeItem(row, "cashRefunds"));
    } else if (
      row.voucherNumber != null ||
      expenseByReceipt.has(Number(row.id))
    ) {
      breakdown.expenses.push(makeItem(row, "expenses"));
    } else {
      breakdown.otherCashOut.push(makeItem(row, "otherCashOut"));
    }
  }

  const sumItems = (items: ShiftCashReconciliationItem[]) =>
    items.reduce((total, item) => total.plus(money(item.amount)), money("0"));
  const reconciliationAmounts = {
    opening: sumItems(breakdown.opening),
    cashSales: sumItems(breakdown.cashSales),
    priorInvoiceCollections: sumItems(breakdown.priorInvoiceCollections),
    otherCashIn: sumItems(breakdown.otherCashIn),
    cashRefunds: sumItems(breakdown.cashRefunds),
    expenses: sumItems(breakdown.expenses),
    cashDrops: sumItems(breakdown.cashDrops),
    otherCashOut: sumItems(breakdown.otherCashOut),
  };
  const formulaExpectedCash = reconciliationAmounts.opening
    .plus(reconciliationAmounts.cashSales)
    .plus(reconciliationAmounts.priorInvoiceCollections)
    .plus(reconciliationAmounts.otherCashIn)
    .minus(reconciliationAmounts.cashRefunds)
    .minus(reconciliationAmounts.expenses)
    .minus(reconciliationAmounts.cashDrops)
    .minus(reconciliationAmounts.otherCashOut);
  const storedExpectedCash =
    sh.expectedCash == null ? null : money(sh.expectedCash);
  const expectedCash =
    sh.status === "CLOSED" && storedExpectedCash != null
      ? storedExpectedCash
      : formulaExpectedCash;

  // تفكيك وسائل الدفع القديم يبقى للتوافق، لكن من نفس صفوف الإيصالات. نستبعد CH المثبت
  // فقط؛ CD يبقى OUT مرة واحدة. لا نستبعد أي مرجع تجاري لمجرد أنه يبدأ بـCH-.
  const paymentGroups = new Map<
    string,
    {
      method: (typeof receiptRows)[number]["paymentMethod"];
      direction: "IN" | "OUT";
      total: ReturnType<typeof money>;
      count: number;
    }
  >();
  for (const row of receiptRows) {
    if (
      pairedTransferByReceipt.has(Number(row.id)) &&
      row.referenceNumber?.startsWith("CH-")
    )
      continue;
    const key = `${row.paymentMethod}:${row.direction}`;
    const current = paymentGroups.get(key) ?? {
      method: row.paymentMethod,
      direction: row.direction,
      total: money("0"),
      count: 0,
    };
    current.total = current.total.plus(money(row.amount));
    current.count += 1;
    paymentGroups.set(key, current);
  }
  const payments = Array.from(paymentGroups.values()).map((group) => ({
    method: group.method,
    direction: group.direction,
    total: toDbMoney(group.total),
    count: group.count,
  }));

  const inv = (
    await db
      .select({
        count: sql<number>`COUNT(*)`,
        total: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
      })
      .from(invoices)
      .where(eq(invoices.shiftId, shiftId))
  )[0];

  // إفصاح فواتير تسليم الطلبات (مراجعة ٥/٨): «مبيعاتي» في وردية الاستقبال تشمل فواتير
  // WORKORDER تُثبَّت لحظة التسليم بينما جزءٌ من قيمتها (العربون) قُبض في ورديةٍ سابقة —
  // نُبرزها كسطرٍ منفصل كي لا يُقرأ الإجمالي وكأن نقده كلَّه في هذا الدرج. لا يغيّر المطابقة
  // (expectedCash يعتمد الإيصالات لا الفواتير) — شفافية عرضٍ فقط.
  const woInv = (
    await db
      .select({
        count: sql<number>`COUNT(*)`,
        total: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.shiftId, shiftId),
          eq(invoices.sourceType, "WORKORDER"),
        ),
      )
  )[0];

  // ش٤ (I14): «عرابين على طلباتٍ لم تُثبَّت» — مالٌ في هذا الدرج مقبوضٌ على مسوّداتٍ ما زالت
  // OPEN (صفوف COLLECTION HELD على هذه الوردية، صافي ردودها). المسوّدة المموّلة **لا تمنع
  // الإغلاق** (المال في receipts والدرج متّسق) — السطر إفصاحٌ يفسّر وجود نقدٍ بلا فاتورة.
  // (استعلامٌ مضمَّن لا استيراد من reception/deposits — يمنع دورة استيراد deposits⇄shiftService.
  //  أسماء أعمدة DB الحرفية: orderPayKind/orderPayStatus — فخّ raw SQL الموثَّق.)
  // دلالة الدرج (مراجعة ش٤): تُطرح ردود **هذه الوردية** فقط (ردُّ درجٍ آخر يخصّ Z درجِه)،
  // ويُضمّ REFUNDED (قُبض هنا فعلاً) — وإلا تحوّر Z المؤرشف رجعياً وفقد تفسير درجه التاريخيّ.
  const heldRes = await db.execute(sql`
    SELECT COUNT(DISTINCT op.draftId) AS c,
           CAST(COALESCE(SUM(op.amount - COALESCE(rf.s, 0)), 0) AS CHAR) AS t
    FROM orderPayments op
    LEFT JOIN (
      SELECT parentPaymentId, SUM(amount) AS s
      FROM orderPayments
      WHERE orderPayKind = 'REFUND' AND shiftId = ${shiftId}
      GROUP BY parentPaymentId
    ) rf ON rf.parentPaymentId = op.id
    WHERE op.shiftId = ${shiftId} AND op.orderPayKind = 'COLLECTION' AND op.orderPayStatus IN ('HELD','REFUNDED')
  `);
  const heldData =
    (heldRes as unknown as [Array<{ c: number | string; t: string }>])[0] ??
    heldRes;
  const heldRow = Array.isArray(heldData) ? heldData[0] : undefined;
  const heldDeposits = {
    count: Number(heldRow?.c ?? 0),
    total: String(heldRow?.t ?? "0.00"),
  };

  // توصيل (١٠/٨) — إفصاح Z: توريدات المناديب وأجور التوصيل كانت تذوب في «نقدي وارد/صادر»
  // فيتضخّم وارد الوردية بلا تمييز بين مبيعات الدرج وتحصيل عُهدٍ قديمة، ويستحيل تتبّع «أين
  // دخل توريد فلان؟» إلا بفتح الإيصالات واحداً واحداً. بصمات المراجع: توريد DR-، تسوية/استرداد
  // DLV-SETTLE-/DLV-RECOVER-، أجور الإرسال CN- (OUT) وأمانات DLV-FEE- (OUT). إفصاح عرضٍ فقط —
  // لا يمسّ expectedCash ولا المطابقة.
  const dlvRows = await db
    .select({
      inCount: sql<number>`SUM(CASE WHEN ${receipts.direction} = 'IN' AND (${receipts.referenceNumber} LIKE 'DR-%' OR ${receipts.referenceNumber} LIKE 'DLV-SETTLE-%' OR ${receipts.referenceNumber} LIKE 'DLV-RECOVER-%') THEN 1 ELSE 0 END)`,
      inTotal: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' AND (${receipts.referenceNumber} LIKE 'DR-%' OR ${receipts.referenceNumber} LIKE 'DLV-SETTLE-%' OR ${receipts.referenceNumber} LIKE 'DLV-RECOVER-%') THEN ${receipts.amount} ELSE 0 END), 0)`,
      outCount: sql<number>`SUM(CASE WHEN ${receipts.direction} = 'OUT' AND (${receipts.referenceNumber} LIKE 'DR-%' OR ${receipts.referenceNumber} LIKE 'CN-%' OR ${receipts.referenceNumber} LIKE 'DLV-FEE-%') THEN 1 ELSE 0 END)`,
      outTotal: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'OUT' AND (${receipts.referenceNumber} LIKE 'DR-%' OR ${receipts.referenceNumber} LIKE 'CN-%' OR ${receipts.referenceNumber} LIKE 'DLV-FEE-%') THEN ${receipts.amount} ELSE 0 END), 0)`,
    })
    .from(receipts)
    .where(eq(receipts.shiftId, shiftId));
  const dlv = dlvRows[0];

  // أوفلاين (ش٤) — «مبيعات مُزامنة لاحقاً»: فواتير أوفلاينية رُحِّلت **بعد** إغلاق الوردية
  // (createdAt > closedAt). تفسّر زيادة الدرج عند العدّ (النقد قُبض قبل الإغلاق والفاتورة
  // وصلت بعده) فلا يُتَّهم الكاشير بفائض مجهول ولا يُساء قراءة Z-report.
  let lateSynced = { count: 0, total: "0.00" };
  if (sh.closedAt) {
    const late = (
      await db
        .select({
          count: sql<number>`COUNT(*)`,
          total: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.shiftId, shiftId),
            eq(invoices.originatedOffline, true),
            gt(invoices.createdAt, sh.closedAt),
          ),
        )
    )[0];
    lateSynced = {
      count: Number(late?.count ?? 0),
      total: late?.total ?? "0.00",
    };
  }

  return {
    shift: sh,
    payments,
    expectedCash: toDbMoney(expectedCash),
    invoiceCount: Number(inv?.count ?? 0),
    salesTotal: inv?.total ?? "0.00",
    woInvoicesCount: Number(woInv?.count ?? 0),
    woInvoicesTotal: woInv?.total ?? "0.00",
    heldDepositsCount: heldDeposits.count,
    heldDepositsTotal: heldDeposits.total,
    // إجمالي رؤوس الفواتير معلومات مبيعات خام، وليس نقداً ولا يدخل معادلة الدرج.
    invoiceSummary: {
      count: Number(inv?.count ?? 0),
      grossTotal: inv?.total ?? "0.00",
      basis: "INVOICE_TOTAL_BY_SHIFT" as const,
      usedInCashReconciliation: false as const,
    },
    cashReconciliation: {
      opening: toDbMoney(reconciliationAmounts.opening),
      cashSales: toDbMoney(reconciliationAmounts.cashSales),
      priorInvoiceCollections: toDbMoney(
        reconciliationAmounts.priorInvoiceCollections,
      ),
      otherCashIn: toDbMoney(reconciliationAmounts.otherCashIn),
      cashRefunds: toDbMoney(reconciliationAmounts.cashRefunds),
      expenses: toDbMoney(reconciliationAmounts.expenses),
      cashDrops: toDbMoney(reconciliationAmounts.cashDrops),
      otherCashOut: toDbMoney(reconciliationAmounts.otherCashOut),
      expectedCash: toDbMoney(formulaExpectedCash),
      storedExpectedCash:
        storedExpectedCash == null ? null : toDbMoney(storedExpectedCash),
      matchesStoredExpectedCash:
        storedExpectedCash == null
          ? null
          : formulaExpectedCash.eq(storedExpectedCash),
      equation: [
        {
          key: "opening",
          operation: "ADD",
          amount: toDbMoney(reconciliationAmounts.opening),
        },
        {
          key: "cashSales",
          operation: "ADD",
          amount: toDbMoney(reconciliationAmounts.cashSales),
        },
        {
          key: "priorInvoiceCollections",
          operation: "ADD",
          amount: toDbMoney(reconciliationAmounts.priorInvoiceCollections),
        },
        {
          key: "otherCashIn",
          operation: "ADD",
          amount: toDbMoney(reconciliationAmounts.otherCashIn),
        },
        {
          key: "cashRefunds",
          operation: "SUBTRACT",
          amount: toDbMoney(reconciliationAmounts.cashRefunds),
        },
        {
          key: "expenses",
          operation: "SUBTRACT",
          amount: toDbMoney(reconciliationAmounts.expenses),
        },
        {
          key: "cashDrops",
          operation: "SUBTRACT",
          amount: toDbMoney(reconciliationAmounts.cashDrops),
        },
        {
          key: "otherCashOut",
          operation: "SUBTRACT",
          amount: toDbMoney(reconciliationAmounts.otherCashOut),
        },
      ] as const,
      breakdown,
      excludedTreasuryHandovers: treasuryHandovers,
    },
    lateSyncedCount: lateSynced.count,
    lateSyncedTotal: lateSynced.total,
    deliveryInCount: Number(dlv?.inCount ?? 0),
    deliveryInTotal: String(dlv?.inTotal ?? "0.00"),
    deliveryOutCount: Number(dlv?.outCount ?? 0),
    deliveryOutTotal: String(dlv?.outTotal ?? "0.00"),
  };
}

/**
 * The user's currently open shift in a branch, if any. حين يُمرَّر shiftType يُفلتَر بدقّة عليه
 * (بوّابة RECEPTION تَطلب وردية استقبال صراحةً)؛ بدونه يُرجِع أيّ وردية مفتوحة (توافق رجعي).
 */
export async function getOpenShift(
  userId: number,
  branchId: number,
  shiftType?: ShiftType,
) {
  const db = getDb();
  if (!db) return null;
  const conds = [
    eq(shifts.userId, userId),
    eq(shifts.branchId, branchId),
    eq(shifts.status, "OPEN"),
  ];
  if (shiftType) conds.push(eq(shifts.shiftType, shiftType));
  const rows = await db
    .select()
    .from(shifts)
    .where(and(...conds))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * معرّف وردية الموظّف المفتوحة في فرعٍ ما، مرتبط بالمعاملة — لنسب إيصالات الصندوق (نقد داخل/خارج)
 * إلى الوردية فيتوازن الـZ-report. يُرجع null إن لم تكن للموظّف وردية مفتوحة (لا شيء يُنسَب).
 *
 * **سباق مع closeShift (تدقيق ٢٣/٦/٢٦):** القراءة بلا قفل كانت تُرجع shiftId='OPEN' لحظةَ
 * إصدار closeShift أمرَ CLOSE نفسها ⇒ تُكتب receipt على وردية أُغلقت توّاً ولا تظهر في
 * Z-report بعد قطع التسوية. الحلّ: نَستعيد المرشّح ثم نَقفل صفّه بـFOR UPDATE ونُعيد فحص
 * status='OPEN' تحت القفل. إن غُيِّر بعد القفل (closeShift سبَقَنا للالتزام) ⇒ نُرجع null
 * كما لو لم تكن وردية مفتوحة، فيرتفع PRECONDITION_FAILED في الطبقة العليا (سلوك مُحدَّد).
 */
export async function openShiftIdTx(
  tx: Tx,
  userId: number,
  branchId: number,
  preferredType: ShiftType = "RETAIL",
): Promise<number | null> {
  // حلٌّ حتميّ صديقٌ للمشغّل الواحد (تدقيق ٢٦/٦/٢٦): قبل نوع الوردية كان `LIMIT 1` كافياً؛
  // بعده قد يَملك الموظّف ورديتَين مفتوحتَين (تجزئة + استقبال) ⇒ `LIMIT 1` لاحتميّ يَنسب النقد
  // لدرجٍ عشوائي. القاعدة: وردية واحدة مفتوحة ⇒ استعملها أيّاً كان نوعها (المشغّل الواحد بلا احتكاك)؛
  // ورديتان ⇒ اختر بالنوع المفضّل للعملية (preferredType).
  const open = await tx
    .select({ id: shifts.id, shiftType: shifts.shiftType })
    .from(shifts)
    .where(
      and(
        eq(shifts.userId, userId),
        eq(shifts.branchId, branchId),
        eq(shifts.status, "OPEN"),
      ),
    );
  if (open.length === 0) return null;
  const chosen =
    open.length === 1
      ? open[0]
      : open.find((s) => s.shiftType === preferredType);
  if (!chosen) return null;
  const id = Number(chosen.id);
  // قفل صفّ الوردية ثم إعادة فحص الحالة: closeShift يأخذ نفس القفل، فلا تُصدَر receipts
  // على وردية أُغلقت في أثناء التسلسل. الـlock يُحَرَّر تلقائياً عند commit/rollback للـtx.
  const locked = await tx
    .select({ status: shifts.status })
    .from(shifts)
    .where(eq(shifts.id, id))
    .for("update")
    .limit(1);
  if (!locked[0] || locked[0].status !== "OPEN") return null;
  return id;
}

/**
 * يحلّ الوردية "الفعليّة" لعملية نقدٍ صادرة من درج فرعٍ (مرتجع نقديّ) حين يكون الفاعل (غالباً
 * مديراً — المرتجعات salesManagerProcedure) شخصاً مختلفاً عن الكاشير الذي يُشغّل الدرج الحقيقيّ.
 * بخلاف openShiftIdTx (يبحث عن وردية *الفاعل* نفسه)، هذه تبحث عن وردية *الفرع* المفتوحة أيّاً كان
 * صاحبها — الدرج مورد فرعٍ لا مستخدم. ربط إيصال الاسترداد بوردية الفاعل حين تختلف عن وردية الكاشير
 * الذي سلّم النقد فعلياً كان يُخفي المرتجع عن Z-report صاحب الدرج الحقيقيّ، فيظهر له عند الإغلاق
 * عجزٌ لا يفهم سببه (النقد خرج من درجه، والنظام حسبه — إن حسبه أصلاً — على وردية غير ورديته).
 *
 * - وردية واحدة مفتوحة بالفرع ⇒ تُستعمل تلقائياً (الحالة الشائعة، بلا احتكاك؛ ونتيجتها مطابقة
 *   لِما كان عليه openShiftIdTx حين يتصادف الفاعل والكاشير الفعليّ — لا تغيير سلوكيّ هناك).
 * - صفر ⇒ يرمي PRECONDITION_FAILED (لا درج مفتوح يُسترَدّ منه نقد).
 * - أكثر من واحدة (مثلاً RETAIL+RECEPTION معاً، أو كاشيران) ⇒ يتطلّب explicitShiftId (اختيارٌ
 *   صريح لأيّ درجٍ خرج منه النقد فعلياً)؛ بدونه يرمي برسالة تُبلغ عن التعدّد.
 *
 * يُعيد openingBalance مع shiftId — المستدعي (مرتجعٌ نقديّ) يحتاجه ليحسب computeExpectedCash
 * ويتحقّق أنّ الدرج المستهدَف يحمل فعلاً هذا المبلغ الآن (نمط cashDropService: لا يُسحَب أكثر ممّا فيه).
 */
export async function resolveBranchCashShiftTx(
  tx: Tx,
  branchId: number,
  explicitShiftId?: number | null,
): Promise<{ shiftId: number; openingBalance: string }> {
  const open = await tx
    .select({ id: shifts.id, openingBalance: shifts.openingBalance })
    .from(shifts)
    .where(and(eq(shifts.branchId, branchId), eq(shifts.status, "OPEN")));

  let chosen: { id: number | string | bigint; openingBalance: string };
  if (explicitShiftId != null) {
    const match = open.find((s) => Number(s.id) === Number(explicitShiftId));
    if (!match) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "الوردية المحدَّدة لاستقبال الاسترداد النقدي غير مفتوحة في هذا الفرع",
      });
    }
    chosen = match;
  } else if (open.length === 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "لا توجد وردية مفتوحة في هذا الفرع لاسترداد نقدي — افتح وردية أولاً",
    });
  } else if (open.length > 1) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `أكثر من وردية مفتوحة في هذا الفرع (${open.length}) — حدّد أيّ درجٍ خرج منه النقد فعلياً`,
    });
  } else {
    chosen = open[0];
  }

  const id = Number(chosen.id);
  // قفل صفّ الوردية ثم إعادة فحص الحالة (نمط openShiftIdTx — يمنع سباقاً مع closeShift المتزامن).
  const locked = await tx
    .select({ status: shifts.status })
    .from(shifts)
    .where(eq(shifts.id, id))
    .for("update")
    .limit(1);
  if (!locked[0] || locked[0].status !== "OPEN") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "الوردية المستهدَفة أُغلقت للتوّ — أعد المحاولة",
    });
  }
  return { shiftId: id, openingBalance: chosen.openingBalance };
}

/**
 * مرآة صارمة لـopenShiftIdTx: ترمي PRECONDITION_FAILED بدل الإرجاع null حين تكون الوردية مغلقة.
 *
 * تُستعمل قبل كل معاملة نقدية تَلمس صندوق الكاشير (مصاريف/سندات بـpaymentMethod='CASH')
 * كي لا تُكتب receipts بـshiftId=null تختفي من Z-report (computeExpectedCash يفلتر
 * بـeq(receipts.shiftId, shiftId)) ⇒ خسارة نقد صامتة + فروقات ظالمة عند الإقفال.
 *
 * المعاملات غير النقدية (BANK/CARD/CHEQUE/TRANSFER/WALLET) لا تَستعملها — لأنها لا تَمسّ الصندوق
 * فيمكن أن تُحفَظ بـshiftId=null مشروعاً (مثل سند بنكي للمورد بلا فتح وردية).
 */
export async function requireOpenShiftIdTx(
  tx: Tx,
  userId: number,
  branchId: number,
  label: string = "معاملة نقدية",
  preferredType: ShiftType = "RETAIL",
): Promise<number> {
  const id = await openShiftIdTx(tx, userId, branchId, preferredType);
  if (id == null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `افتح وردية في هذا الفرع قبل تسجيل ${label} (وإلا تختفي المعاملة من تسوية الصندوق).`,
    });
  }
  return id;
}

/**
 * يَحلّ دور الفاعل: من actor.role إن مُرّر، وإلا يَقرأه من DB (مرّة واحدة). نُقِل من
 * voucherService للاستعمال المُشترَك بين خدمات المعاملات النقدية (مصاريف/سندات/أوامر شغل).
 */
export async function resolveActorRoleTx(
  tx: Tx,
  userId: number,
): Promise<string> {
  const u = (
    await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0];
  return u?.role ?? "";
}

/**
 * **سياسة الخزينة الإدارية vs درج الكاشير** (تدقيق ١٧/٦ — قرار ٣ خبراء بإجماع):
 *
 *  - الكاشير/المخزن (drawer custodians): يَجلسون على درج POS ⇒ كلّ نقد يَجب أن يَنتمي
 *    لوردية مفتوحة، وإلّا يَختفي من Z-report ⇒ نَرمي PRECONDITION_FAILED.
 *  - المدير/الـadmin (treasury custodians): لا يَملكون درج POS ⇒ يُسجّلون معاملات
 *    إدارية ميدانية (إيجار، صرف لمورّد، تَحصيل من تاجر). فَرض الوردية عليهم =
 *    خَلط عُهَد (segregation of custodianship) + تَلويث Z-report بورديات شَبحية.
 *    يُسمَح بـshiftId=null + bucket='TREASURY' ⇒ سجلّ مستقلّ لا يَدخل تسوية الدرج.
 *
 * **حالة المدير الخاصّة:** إن فَتح وردية (مثلاً لتغطية كاشير غائب) ⇒ معاملاته تَذهب
 * لتلك الوردية (DRAWER) لا للخزينة. القرار ديناميكي بحَسب وجود وردية لا بحَسب نيّة.
 *
 * **العزل:** receipts.cashBucket='TREASURY' لا تَدخل أبداً computeExpectedCash لأي
 * وردية كاشير ⇒ تَسوية الدرج تَبقى دقيقة، والمعاملات الإدارية تَظهر في تقرير منفصل.
 */
export async function shiftIdForCashTx(
  tx: Tx,
  actor: { userId: number; branchId?: number; role?: string },
  branchId: number,
  label: string = "معاملة نقدية",
  preferredType: ShiftType = "RETAIL",
): Promise<{ shiftId: number | null; cashBucket: "DRAWER" | "TREASURY" }> {
  const role = actor.role ?? (await resolveActorRoleTx(tx, actor.userId));
  if (role === "admin" || role === "manager") {
    // الأدوار الإدارية: إن وُجدت وردية مفتوحة (تغطية كاشير) ⇒ استَعملها (DRAWER)؛
    // وإلّا shiftId=null + bucket=TREASURY (مشروع، يَظهر في تقرير الخزينة الإدارية).
    const sid = await openShiftIdTx(tx, actor.userId, branchId, preferredType);
    return sid
      ? { shiftId: sid, cashBucket: "DRAWER" }
      : { shiftId: null, cashBucket: "TREASURY" };
  }
  // cashier/warehouse/غيرهم: وردية إلزامية (حماية النقد اليتيم الحقيقي).
  const sid = await requireOpenShiftIdTx(
    tx,
    actor.userId,
    branchId,
    label,
    preferredType,
  );
  return { shiftId: sid, cashBucket: "DRAWER" };
}
