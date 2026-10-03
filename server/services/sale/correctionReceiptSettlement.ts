// تسوية مقبوضات الفاتورة الأصلية عند «التصحيح الكامل» (قرار المالك ٣/١٠/٢٦).
//
// المشكلة: تصحيحٌ يغيّر العميل (عابر ← عميل مسجَّل، ابن ← أب) أو يقرّ بأنّ المقبوض المسجَّل
// لم يُستلم فعلاً (نقدي سُجِّل خطأً بدل آجل) كان مرفوضاً كلّياً. الحلّ هنا لا يمحو تاريخاً:
//
//   ① كل إيصال قبضٍ أصليّ يُوسَم REVERSED ويُكتب له إيصالٌ تعويضيّ OUT على **الوردية نفسها
//      والطريقة نفسها والدلو نفسه** (نمط voucher/cancel.ts) + قيد PAYMENT_OUT معاكس بطرف الأصل.
//      صيغ الدرج تجمع COMPLETED وREVERSED ⇒ الزوج يصافر الأثر على الوردية الأصلية.
//   ② ما استُلم فعلاً (R) يُعاد قيده إيصالَ قبضٍ جديداً على الوردية/الطريقة الأصلية نفسها باسم
//      الطرف الجديد، ويُمرَّر preCollected للفاتورة البديلة ⇒ صافي الدرج للمبلغ المستلَم = صفر،
//      وكشف كل طرفٍ صحيح (الأب يرى دفعته، والابن يرى قبضاً وعكسه).
//   ③ الجزء غير المستلَم (المسجَّل − R) يخرج من «النقد المتوقَّع» لوردية الأصل:
//        · وردية مفتوحة: تلقائياً عبر الإيصال التعويضي (الدرج لا يُطالَب بمالٍ لم يدخله).
//        · وردية مغلقة: تسوية موثّقة بعد الإغلاق — يُعاد حساب expectedCash/variance للوردية
//          دون إعادة فتحها ولا مسّ المعدود أو تسليم الخزينة، ويُسجَّل أثرٌ تدقيقيّ كامل. إن صار
//          الفرق صفراً ⇒ MATCHED فيزول حاجز «وردية غير مطابقة» عن إقفال اليوم.
//
// حدود مقصودة (رفضٌ نظيف قبل أي أثر):
//   · وردية مغلقة لم يكن فيها عجزٌ يقابل المبلغ (عدّها أثبت وجود النقد) ⇒ المال استُلم فعلاً.
//   · وردية مفتوحة يصير رصيد درجها سالباً ⇒ النقد خرج من الدرج فعلاً (سحب/صرف) فهو مستلَم.
//   · يومٌ أُقفلت مطابقة خزينته (cashDailyReconciliations=CLOSED) ⇒ يُعاد فتحه أولاً.
//   · إيصالات الخزينة الإدارية أو النقد التاريخي بلا دلو أو طرق غير مدعومة ⇒ إلغاء وإعادة بيع.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import {
  auditLogs,
  cashDailyReconciliations,
  receipts,
  shifts,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractAffectedRows, extractInsertId } from "../../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { computeDrawerCashBalance } from "../cash/cashAvailability";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import type { Actor } from "../tx";
import { paymentAssetRole } from "./paymentPosting";

const SETTLEABLE_METHODS = new Set(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const WHAT = "تعذّر تنفيذ تعديل الفاتورة";

/** مقبوضات الفاتورة القابلة للنقل (IN مكتمل، عدا أمانة أجرة التوصيل) — نفس تعريف correct.ts. */
function transferableReceiptConds(invoiceId: number) {
  return and(
    eq(receipts.invoiceId, invoiceId),
    eq(receipts.direction, "IN"),
    eq(receipts.status, "COMPLETED"),
    sql`NOT EXISTS (SELECT 1 FROM accountingEntries ae WHERE ae.receiptId = ${receipts.id} AND ae.entryType = 'DELIVERY_FEE_HELD')`,
  );
}

/**
 * يقفل ورديات مقبوضات الفاتورة **قبل** قفل الفاتورة (ترتيب الأقفال الحاكم: المصدر ← المستند).
 * قراءةٌ بلا قفل للإيصالات ثم قفل صفوف الورديات تصاعدياً؛ التحقّق من ثبات المجموعة يجري بعد
 * قفل الإيصالات نفسها في settlePriorPaymentsTx (أي تغيّرٍ بينهما ⇒ CONFLICT بلا أثر).
 */
export async function lockPriorPaymentShiftsTx(tx: Tx, invoiceId: number): Promise<Set<number>> {
  const rows = await tx
    .select({ shiftId: receipts.shiftId })
    .from(receipts)
    .where(transferableReceiptConds(invoiceId));
  const ids = Array.from(
    new Set(rows.map((r) => (r.shiftId == null ? null : Number(r.shiftId))).filter((v): v is number => v != null)),
  ).sort((a, b) => a - b);
  for (const id of ids) {
    await tx.select({ id: shifts.id }).from(shifts).where(eq(shifts.id, id)).for("update").limit(1);
  }
  return new Set(ids);
}

export interface SettlementInput {
  invoiceId: number;
  invoiceNumber: string;
  branchId: number;
  originalCustomerId: number | null;
  targetCustomerId: number | null;
  /** المسجَّل الكلّي المتحقَّق = paidAmount. */
  recordedAmount: Decimal;
  /** ما استُلم فعلاً من المسجَّل (0..المسجَّل). */
  receivedAmount: Decimal;
  lockedShiftIds: ReadonlySet<number>;
}

export interface ReRecordedReceipt {
  receiptId: number;
  sourceReceiptId: number;
  amount: Decimal;
  paymentMethod: string;
  cashBucket: "DRAWER" | "TREASURY" | null;
  shiftId: number | null;
}

export interface ShiftSettlementEffect {
  shiftId: number;
  status: "OPEN" | "CLOSED";
  /** صافي أثر هذا التصحيح على نقد درج الوردية (سالب = خرج من المتوقَّع). */
  cashDelta: string;
  expectedBefore?: string;
  expectedAfter?: string;
  varianceBefore?: string;
  varianceAfter?: string;
  reconciliationBefore?: string | null;
  reconciliationAfter?: string | null;
}

export interface SettlementResult {
  reversedReceiptIds: number[];
  compensatingReceiptIds: number[];
  reRecorded: ReRecordedReceipt[];
  carriedAmount: Decimal;
  notReceivedAmount: Decimal;
  shiftEffects: ShiftSettlementEffect[];
}

function fail(code: "BAD_REQUEST" | "CONFLICT" | "PRECONDITION_FAILED", why: string, doThis: string): never {
  throw new TRPCError({ code, message: appErrorMessage({ what: WHAT, why, doThis }) });
}

/**
 * ينفّذ التسوية داخل معاملة التصحيح نفسها (قبل createSaleInTx). يعيد إيصالات القبض الجديدة
 * غير المختومة (invoiceId=NULL) ليمرّرها المستدعي preCollected ثم يرحّل قيودها بعد إنشاء
 * الفاتورة البديلة عبر postReRecordedPaymentsTx.
 */
export async function settlePriorPaymentsTx(
  tx: Tx,
  input: SettlementInput,
  actor: Actor,
): Promise<SettlementResult> {
  const recorded = round2(input.recordedAmount);
  const received = round2(input.receivedAmount);
  if (received.lt(0) || received.gt(recorded)) {
    fail(
      "BAD_REQUEST",
      `المبلغ المستلَم فعلاً (${received.toFixed(2)}) خارج المسجَّل على الفاتورة (${recorded.toFixed(2)})`,
      "حدّث شاشة التعديل ليُعاد احتساب المقبوض ثم أعد الحفظ",
    );
  }

  const rows = await tx
    .select()
    .from(receipts)
    .where(transferableReceiptConds(input.invoiceId))
    .orderBy(asc(receipts.id))
    .for("update");
  const sum = round2(rows.reduce((s, r) => s.plus(money(r.amount)), new Decimal(0)));
  if (!sum.eq(recorded)) {
    fail(
      "CONFLICT",
      "تغيّرت مقبوضات الفاتورة أثناء التعديل",
      "حدّث الفاتورة وأعد التعديل؛ لم يتغيّر المال أو المخزون",
    );
  }
  for (const r of rows) {
    if (!SETTLEABLE_METHODS.has(String(r.paymentMethod))) {
      fail(
        "PRECONDITION_FAILED",
        `إيصال القبض رقم ${r.id} بطريقة ${r.paymentMethod} لا تدعم إعادة التخصيص الآلي`,
        "ألغِ الفاتورة كاملةً ثم أعد البيع بالبيانات الصحيحة",
      );
    }
    if (r.approvalStatus !== "APPROVED") {
      fail("CONFLICT", `إيصال القبض رقم ${r.id} غير معتمد`, "حدّث الفاتورة وأعد التعديل");
    }
    if (r.paymentMethod === "CASH" && r.cashBucket !== "DRAWER") {
      fail(
        "PRECONDITION_FAILED",
        r.cashBucket === "TREASURY"
          ? `إيصال القبض النقدي رقم ${r.id} دخل الخزينة الإدارية لا درج وردية`
          : `إيصال القبض النقدي رقم ${r.id} تاريخي بلا دلو نقد محدد`,
        "ألغِ الفاتورة كاملةً من مسار الإلغاء ثم أعد البيع؛ إعادة التخصيص الآلي تخص نقد الأدراج",
      );
    }
    if (r.shiftId != null && !input.lockedShiftIds.has(Number(r.shiftId))) {
      fail("CONFLICT", "تغيّرت وردية أحد إيصالات القبض أثناء التعديل", "أعد المحاولة على أحدث حالة");
    }
    if (r.paymentMethod === "CASH" && r.shiftId == null) {
      fail("PRECONDITION_FAILED", `إيصال القبض النقدي رقم ${r.id} بلا وردية`, "ألغِ الفاتورة كاملةً ثم أعد البيع");
    }
  }

  // ── الورديات المعنية (مقفلة سلفاً) + حارس يوم الخزينة المُقفل للورديات المغلقة ──
  const shiftIds = Array.from(new Set(rows.map((r) => r.shiftId).filter((v) => v != null).map(Number)));
  const shiftRows = shiftIds.length
    ? await tx.select().from(shifts).where(inArray(shifts.id, shiftIds)).for("update")
    : [];
  const shiftById = new Map(shiftRows.map((s) => [Number(s.id), s]));
  for (const id of shiftIds) {
    const sh = shiftById.get(id);
    if (!sh || Number(sh.branchId) !== Number(input.branchId)) {
      fail("CONFLICT", `وردية الإيصال رقم ${id} غير موجودة أو من فرع آخر`, "أبلغ مسؤول النظام برقم الفاتورة");
    }
  }

  // ── ① عكس كل الأصول بإيصالٍ تعويضي (الأصل يبقى للتدقيق) ──
  const reversedIds = rows.map((r) => Number(r.id));
  if (reversedIds.length) {
    const upd = await tx
      .update(receipts)
      .set({ status: "REVERSED" })
      .where(and(inArray(receipts.id, reversedIds), eq(receipts.status, "COMPLETED")));
    if (extractAffectedRows(upd) !== reversedIds.length) {
      fail("CONFLICT", "تغيّرت حالة أحد إيصالات القبض أثناء التعديل", "أعد المحاولة على أحدث حالة");
    }
  }
  const compensatingIds: number[] = [];
  const cashDeltaByShift = new Map<number, Decimal>();
  const addDelta = (r: (typeof rows)[number], amount: Decimal) => {
    if (r.paymentMethod !== "CASH" || r.cashBucket !== "DRAWER" || r.shiftId == null) return;
    const key = Number(r.shiftId);
    cashDeltaByShift.set(key, (cashDeltaByShift.get(key) ?? new Decimal(0)).plus(amount));
  };
  for (const r of rows) {
    const amount = round2(money(r.amount));
    const res = await tx.insert(receipts).values({
      invoiceId: input.invoiceId,
      branchId: Number(r.branchId ?? input.branchId),
      shiftId: r.shiftId,
      cashBucket: r.cashBucket,
      direction: "OUT",
      amount: toDbMoney(amount),
      paymentMethod: r.paymentMethod,
      referenceNumber: `CORR-REV-${r.id}`,
      checkNumber: r.checkNumber,
      cardLastFour: r.cardLastFour,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: r.partyType,
      partyId: r.partyId,
      description: `عكس قبض الفاتورة ${input.invoiceNumber} (إيصال ${r.id}) بالتصحيح الكامل — لا مال خرج فعلاً`,
      internalNote: `SALE_CORRECTION_REVERSAL:${input.invoiceId}:${r.id}`,
      createdBy: actor.userId,
    });
    const outId = extractInsertId(res);
    compensatingIds.push(outId);
    // الحساب الذي مسّه القبض الأصلي يُدان عكساً (شيكٌ مقبوض يعود من أوراق القبض لا من البنك).
    const role = paymentAssetRole(r.paymentMethod, r.cashBucket as "DRAWER" | "TREASURY" | null, "IN");
    const source = { roleDebits: { AR: amount }, roleCredits: { [role]: amount } };
    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: Number(r.branchId ?? input.branchId),
      invoiceId: input.invoiceId,
      receiptId: outId,
      customerId: input.originalCustomerId,
      amount,
      notes: `عكس قبض الفاتورة ${input.invoiceNumber} بالتصحيح الكامل`,
      postingIntent: createPostingIntent(
        "PAYMENT_OUT_CUSTOMER_REFUND",
        "PAYMENT_OUT",
        [debitLine("AR", amount), creditLine(role, amount)],
        source,
      ),
      postingSourceComponents: source,
    });
    addDelta(r, amount.neg());
  }

  // ── ② إعادة قيد المستلَم فعلاً باسم الطرف الجديد على الوردية/الطريقة نفسها ──
  const reRecorded: ReRecordedReceipt[] = [];
  let remaining = received;
  for (const r of rows) {
    if (remaining.lte(0)) break;
    const amount = round2(Decimal.min(money(r.amount), remaining));
    remaining = remaining.minus(amount);
    if (amount.lte(0)) continue;
    const res = await tx.insert(receipts).values({
      invoiceId: null,
      branchId: Number(r.branchId ?? input.branchId),
      shiftId: r.shiftId,
      cashBucket: r.cashBucket,
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: r.paymentMethod,
      referenceNumber: r.referenceNumber,
      checkNumber: r.checkNumber,
      cardLastFour: r.cardLastFour,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: input.targetCustomerId != null ? "CUSTOMER" : null,
      partyId: input.targetCustomerId,
      description: `إعادة قيد المقبوض فعلاً من الفاتورة ${input.invoiceNumber} (إيصال ${r.id}) على الفاتورة المصحّحة`,
      internalNote: `SALE_CORRECTION_RECARRY:${input.invoiceId}:${r.id}`,
      createdBy: actor.userId,
    });
    const inId = extractInsertId(res);
    reRecorded.push({
      receiptId: inId,
      sourceReceiptId: Number(r.id),
      amount,
      paymentMethod: String(r.paymentMethod),
      cashBucket: r.cashBucket as "DRAWER" | "TREASURY" | null,
      shiftId: r.shiftId == null ? null : Number(r.shiftId),
    });
    addDelta(r, amount);
  }

  // ── ③ أثر الوردية: المفتوحة تتحرّك تلقائياً، والمغلقة تُسوّى تسويةً موثّقة بعد الإغلاق ──
  const shiftEffects: ShiftSettlementEffect[] = [];
  for (const [shiftId, rawDelta] of Array.from(cashDeltaByShift.entries()).sort((a, b) => a[0] - b[0])) {
    const delta = round2(rawDelta);
    const sh = shiftById.get(shiftId)!;
    if (delta.isZero()) {
      shiftEffects.push({ shiftId, status: sh.status, cashDelta: "0.00" });
      continue;
    }
    if (sh.status === "OPEN") {
      const balance = await computeDrawerCashBalance(tx, shiftId, sh.openingBalance ?? "0");
      if (balance.lt(0)) {
        fail(
          "PRECONDITION_FAILED",
          `إخراج ${delta.abs().toFixed(2)} د.ع غير مستلَمة من درج الوردية ${shiftId} يجعل رصيده سالباً (${balance.toFixed(2)})؛ أي أنّ هذا النقد دخل الدرج وخرج منه فعلاً`,
          "اختر «استُلم فعلاً» للمقبوض الأصلي، أو عالج حركة الدرج من وحدتها ثم أعد التعديل",
        );
      }
      shiftEffects.push({ shiftId, status: "OPEN", cashDelta: delta.toFixed(2) });
      continue;
    }
    // وردية مغلقة: Z لا يُعاد فتحه؛ المعدود والتسليم كما هما، والمتوقَّع وحده يُصحَّح.
    const businessDate = new Date(sh.openedAt).toISOString().slice(0, 10);
    const day = (
      await tx
        .select({ id: cashDailyReconciliations.id, status: cashDailyReconciliations.status })
        .from(cashDailyReconciliations)
        .where(and(
          eq(cashDailyReconciliations.branchId, Number(input.branchId)),
          eq(cashDailyReconciliations.businessDate, businessDate),
        ))
        .for("update")
        .limit(1)
    )[0];
    if (day?.status === "CLOSED") {
      fail(
        "PRECONDITION_FAILED",
        `يوم ${businessDate} الذي تتبعه الوردية ${shiftId} مُقفلة مطابقة خزينته`,
        "أعد فتح مطابقة ذلك اليوم من شاشة إقفال اليوم ثم أعد التعديل",
      );
    }
    const expectedBefore = round2(money(sh.expectedCash ?? "0"));
    const counted = round2(money(sh.countedCash ?? "0"));
    const varianceBefore = round2(money(sh.variance ?? counted.minus(expectedBefore)));
    const expectedAfter = round2(expectedBefore.plus(delta));
    const varianceAfter = round2(counted.minus(expectedAfter));
    if (varianceAfter.abs().gt(varianceBefore.abs())) {
      fail(
        "PRECONDITION_FAILED",
        `الوردية ${shiftId} أُغلقت ونقدها المعدود يطابق ${varianceBefore.isZero() ? "المتوقَّع تماماً" : `فرقاً قدره ${varianceBefore.toFixed(2)} د.ع فقط`}؛ فإخراج ${delta.abs().toFixed(2)} د.ع يخلق فائضاً لم يحدث — العدّ أثبت أنّ المال استُلم`,
        "اختر «استُلم فعلاً» للمقبوض الأصلي (ثم ردّه الآن من درج مفتوح إن لزم)",
      );
    }
    const matched = varianceAfter.isZero();
    const reconciliationAfter = matched ? "MATCHED" : sh.reconciliationStatus;
    await tx
      .update(shifts)
      .set({
        expectedCash: toDbMoney(expectedAfter),
        variance: toDbMoney(varianceAfter),
        reconciliationStatus: reconciliationAfter,
        ...(matched ? { varianceReasonCode: null, varianceReason: null, varianceReviewedByUserId: null } : {}),
      })
      .where(and(eq(shifts.id, shiftId), eq(shifts.status, "CLOSED")));
    const effect: ShiftSettlementEffect = {
      shiftId,
      status: "CLOSED",
      cashDelta: delta.toFixed(2),
      expectedBefore: expectedBefore.toFixed(2),
      expectedAfter: expectedAfter.toFixed(2),
      varianceBefore: varianceBefore.toFixed(2),
      varianceAfter: varianceAfter.toFixed(2),
      reconciliationBefore: sh.reconciliationStatus,
      reconciliationAfter,
    };
    shiftEffects.push(effect);
    await tx.insert(auditLogs).values({
      userId: actor.userId,
      branchId: Number(input.branchId),
      action: "shift.postCloseCorrectionAdjustment",
      entityType: "shift",
      entityId: String(shiftId),
      oldValue: {
        expectedCash: effect.expectedBefore,
        variance: effect.varianceBefore,
        reconciliationStatus: sh.reconciliationStatus,
        varianceReasonCode: sh.varianceReasonCode,
        varianceReason: sh.varianceReason,
      },
      newValue: {
        expectedCash: effect.expectedAfter,
        variance: effect.varianceAfter,
        reconciliationStatus: reconciliationAfter,
        cashDelta: effect.cashDelta,
        invoiceId: input.invoiceId,
        invoiceNumber: input.invoiceNumber,
        reversedReceiptIds: reversedIds,
        compensatingReceiptIds: compensatingIds,
        reRecordedReceiptIds: reRecorded.map((r) => r.receiptId),
        dailyReconciliationId: day?.id ?? null,
        note: "تسوية موثّقة بعد الإغلاق: مقبوضٌ سُجِّل خطأً ولم يُستلم؛ لا إعادة فتح للوردية ولا مساس بالمعدود",
      },
    });
  }

  // ── حارس الاتزان: صافي أثر كل وردية = −(غير المستلَم المنسوب إليها)، والمجموع = −(المسجَّل − R) ──
  const notReceived = round2(recorded.minus(received));
  const carried = round2(reRecorded.reduce((s, r) => s.plus(r.amount), new Decimal(0)));
  if (!carried.eq(received)) {
    fail("CONFLICT", "لم يكتمل توزيع المقبوض المستلَم على إيصالات الأصل", "أعد المحاولة؛ لم يتغيّر شيء");
  }

  return {
    reversedReceiptIds: reversedIds,
    compensatingReceiptIds: compensatingIds,
    reRecorded,
    carriedAmount: carried,
    notReceivedAmount: notReceived,
    shiftEffects,
  };
}

/** يرحّل قيود PAYMENT_IN للمقبوض المُعاد قيده بعد إنشاء الفاتورة البديلة (الطرف = العميل الجديد). */
export async function postReRecordedPaymentsTx(
  tx: Tx,
  args: { reRecorded: ReRecordedReceipt[]; newInvoiceId: number; branchId: number; targetCustomerId: number | null; invoiceNumber: string },
): Promise<void> {
  for (const r of args.reRecorded) {
    const stamped = (
      await tx.select({ invoiceId: receipts.invoiceId }).from(receipts).where(eq(receipts.id, r.receiptId)).limit(1)
    )[0];
    if (Number(stamped?.invoiceId ?? 0) !== Number(args.newInvoiceId)) {
      fail("CONFLICT", "لم يُختم المقبوض المُعاد قيده بالفاتورة البديلة", "أعد المحاولة؛ تراجع التعديل بالكامل");
    }
    const role = paymentAssetRole(r.paymentMethod, r.cashBucket, "IN");
    const source = { roleDebits: { [role]: r.amount }, roleCredits: { AR: r.amount } };
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: args.branchId,
      invoiceId: args.newInvoiceId,
      receiptId: r.receiptId,
      customerId: args.targetCustomerId,
      amount: r.amount,
      notes: `إعادة قيد مقبوض الفاتورة ${args.invoiceNumber} على الفاتورة المصحّحة`,
      postingIntent: createPostingIntent(
        "PAYMENT_IN_CUSTOMER",
        "PAYMENT_IN",
        [debitLine(role, r.amount), creditLine("AR", r.amount)],
        source,
      ),
      postingSourceComponents: source,
    });
  }
}
