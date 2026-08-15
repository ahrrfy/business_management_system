import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { digitalSaleIntents, externalPaymentAttempts, invoices, receipts } from "../../drizzle/schema";
import { getDb, type Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { isDupEntry } from "@shared/errorMap.ar";
import { logger } from "../logger";
import { money, toDbMoney } from "./money";
import { createSaleInTx, DIGITAL_SALE_CAPABILITY, notifySaleCustomerAfterCommit } from "./sale/create";
import type { CreateSaleInput, CreateSaleResult } from "./sale/types";
import { withTx, type Actor } from "./tx";

export type PosExternalPaymentMethod = "CARD" | "CHECK" | "TRANSFER" | "WALLET";
export type PosExternalPaymentChannel = "POS" | "PRINT_POS";

export interface ExternalPaymentAttemptInput {
  branchId: number;
  channel: PosExternalPaymentChannel;
  method: PosExternalPaymentMethod;
  amount: string;
  reference: string;
  requestId: string;
  deviceId: string;
}

export interface ExternalPaymentBindingInput {
  branchId: number;
  channel: PosExternalPaymentChannel;
  method: string;
  amount: string;
  attemptId?: number | null;
  deviceId?: string | null;
  digitalSaleIntentId?: number | null;
}

export type LockedExternalPaymentAttempt = typeof externalPaymentAttempts.$inferSelect;

export type ConfirmedPosSaleInput = Omit<CreateSaleInput, "payment"> & {
  payment?: (NonNullable<CreateSaleInput["payment"]> & {
    externalPaymentAttemptId?: number | null;
    /** حجز داخلي للبطاقات الرقمية؛ لا يقبله راوتر البيع العام. */
    externalPaymentIntentId?: number | null;
  }) | null;
  /** حارس القناة العامة؛ تُبقي الاستدعاءات الداخلية القديمة خارج نطاق شريحة POS. */
  requireExternalPaymentAttempt?: boolean;
};

function normalizedReference(value: string): string {
  const reference = value.trim();
  if (!reference) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع الدفع الخارجي مطلوب للدفع غير النقدي" });
  }
  if (reference.length > 100) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع الدفع الخارجي أطول من 100 محرف" });
  }
  return reference.toUpperCase();
}

function accountReference(branchId: number, method: PosExternalPaymentMethod): string {
  // الحسابات الخارجية التفصيلية غير مُهيّأة بعد؛ هذا نطاق ثابت وصادق: حساب طريقة الدفع لهذا الفرع.
  return `BRANCH:${branchId}:${method}`;
}

function fingerprintMatches(
  row: LockedExternalPaymentAttempt,
  input: ExternalPaymentAttemptInput,
  actor: Actor,
): boolean {
  return Number(row.branchId) === input.branchId
    && row.channel === input.channel
    && row.paymentMethod === input.method
    && money(row.amount).eq(money(input.amount))
    && row.normalizedReference === normalizedReference(input.reference)
    && row.deviceId === input.deviceId.trim()
    && Number(row.createdBy) === actor.userId;
}

function publicAttempt(row: LockedExternalPaymentAttempt) {
  return {
    attemptId: Number(row.id),
    state: row.state,
    reference: row.externalReference,
    amount: row.amount,
    method: row.paymentMethod,
  };
}

/**
 * ينشئ INITIATED فقط. لا إيصال ولا فاتورة ولا ذمّة هنا؛ التأكيد والاستهلاك خطوتان منفصلتان.
 * requestId يجعل إعادة إرسال نفس النقرة idempotent، بينما قيد المرجع العالمي يحسم السباق الحقيقي.
 */
export async function initiateExternalPaymentAttempt(input: ExternalPaymentAttemptInput, actor: Actor) {
  const amount = money(input.amount);
  if (!amount.isFinite() || !amount.gt(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ محاولة الدفع يجب أن يكون موجباً" });
  }
  const reference = input.reference.trim();
  const normalized = normalizedReference(reference);
  const requestId = input.requestId.trim();
  if (!requestId || requestId.length > 80) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف طلب محاولة الدفع غير صالح" });
  }
  const deviceId = input.deviceId.trim();
  if (!deviceId || deviceId.length > 64) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف جهاز الدفع مطلوب ولا يتجاوز 64 محرفاً" });
  }

  try {
    return await withTx(async (tx) => {
      const existing = (await tx
        .select()
        .from(externalPaymentAttempts)
        .where(and(
          eq(externalPaymentAttempts.createdBy, actor.userId),
          eq(externalPaymentAttempts.requestId, requestId),
        ))
        .limit(1))[0];
      if (existing) {
        if (!fingerprintMatches(existing, input, actor)) {
          throw new TRPCError({ code: "CONFLICT", message: "معرّف محاولة الدفع مستعمَل لبيانات مختلفة" });
        }
        return publicAttempt(existing);
      }

      const inserted = await tx.insert(externalPaymentAttempts).values({
        branchId: input.branchId,
        channel: input.channel,
        paymentMethod: input.method,
        amount: toDbMoney(amount),
        providerCode: input.method,
        accountReference: accountReference(input.branchId, input.method),
        deviceId,
        externalReference: reference,
        normalizedReference: normalized,
        state: "INITIATED",
        requestId,
        createdBy: actor.userId,
      });
      const id = extractInsertId(inserted);
      const row = (await tx.select().from(externalPaymentAttempts).where(eq(externalPaymentAttempts.id, id)).limit(1))[0]!;
      return publicAttempt(row);
    });
  } catch (error) {
    if (!isDupEntry(error)) throw error;

    // سباق إعادة إرسال requestId نفسه: استرجع الفائز فقط إن كانت البصمة مطابقة.
    const db = getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
    const existing = (await db
      .select()
      .from(externalPaymentAttempts)
      .where(and(
        eq(externalPaymentAttempts.createdBy, actor.userId),
        eq(externalPaymentAttempts.requestId, requestId),
      ))
      .limit(1))[0];
    if (existing && fingerprintMatches(existing, input, actor)) return publicAttempt(existing);
    throw new TRPCError({
      code: "CONFLICT",
      message: "مرجع الدفع الخارجي مستخدَم في محاولة أخرى — لا يمكن تسجيل القبض مرتين",
    });
  }
}

/** انتقال INITIATED→CONFIRMED مسجّل في الخادم؛ لا يغيّر الفاتورة أو الدفتر بعد. */
export async function confirmExternalPaymentAttempt(
  input: { attemptId: number; branchId: number; channel: PosExternalPaymentChannel; deviceId: string },
  actor: Actor,
) {
  return withTx(async (tx) => {
    const row = (await tx
      .select()
      .from(externalPaymentAttempts)
      .where(eq(externalPaymentAttempts.id, input.attemptId))
      .for("update")
      .limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "محاولة الدفع غير موجودة" });
    if (Number(row.branchId) !== input.branchId || row.channel !== input.channel || Number(row.createdBy) !== actor.userId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "محاولة الدفع لا تخص هذا الكاشير أو الفرع أو القناة" });
    }
    if (row.deviceId !== input.deviceId.trim()) {
      throw new TRPCError({ code: "FORBIDDEN", message: "محاولة الدفع تخص جهاز كاشير آخر" });
    }
    if (row.state === "CONFIRMED") return publicAttempt(row);
    if (row.state !== "INITIATED") {
      throw new TRPCError({ code: "CONFLICT", message: `لا يمكن تأكيد محاولة دفع حالتها ${row.state}` });
    }
    if (row.invoiceId != null || row.receiptId != null) {
      throw new TRPCError({ code: "CONFLICT", message: "محاولة الدفع مستهلكة مسبقاً" });
    }
    await tx
      .update(externalPaymentAttempts)
      .set({ state: "CONFIRMED", confirmedBy: actor.userId, confirmedAt: new Date() })
      .where(eq(externalPaymentAttempts.id, row.id));
    return publicAttempt({ ...row, state: "CONFIRMED", confirmedBy: actor.userId, confirmedAt: new Date() });
  });
}

/**
 * يقفل محاولة مؤكدة قبل أي كتابة أعمال. صفّ المحاولة يبقى مقفولاً حتى التزام/تراجع معاملة البيع،
 * لذلك لا يستطيع POS وPrintPOS استهلاك المرجع نفسه بالتوازي.
 */
export async function lockConfirmedExternalPaymentAttempt(
  tx: Tx,
  input: ExternalPaymentBindingInput,
  actor: Actor,
): Promise<LockedExternalPaymentAttempt> {
  if (input.method === "CASH") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الدفع النقدي لا يرتبط بمحاولة دفع خارجية" });
  }
  if (!input.attemptId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "أكّد الدفع الخارجي قبل إتمام البيع" });
  }
  const row = (await tx
    .select()
    .from(externalPaymentAttempts)
    .where(eq(externalPaymentAttempts.id, input.attemptId))
    .for("update")
    .limit(1))[0];
  if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "محاولة الدفع الخارجية غير موجودة" });
  if (Number(row.branchId) !== input.branchId || row.channel !== input.channel) {
    throw new TRPCError({ code: "CONFLICT", message: "محاولة الدفع تخص فرعاً أو قناةً أخرى" });
  }
  if (row.paymentMethod !== input.method) {
    throw new TRPCError({ code: "CONFLICT", message: "طريقة الدفع لا تطابق المحاولة المؤكدة" });
  }
  if (!money(row.amount).eq(money(input.amount))) {
    throw new TRPCError({ code: "CONFLICT", message: "مبلغ البيع لا يطابق مبلغ المحاولة المؤكدة" });
  }
  if ((row.deviceId ?? null) !== (input.deviceId?.trim() || null)) {
    throw new TRPCError({ code: "CONFLICT", message: "جهاز البيع لا يطابق جهاز محاولة الدفع" });
  }
  if (row.state !== "CONFIRMED" || row.confirmedAt == null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الدفع الخارجي غير مؤكّد" });
  }
  if (row.invoiceId != null || row.receiptId != null || row.consumedAt != null) {
    throw new TRPCError({ code: "CONFLICT", message: "محاولة الدفع استُهلكت في بيع سابق" });
  }
  const linkedIntent = (await tx
    .select({ id: digitalSaleIntents.id })
    .from(digitalSaleIntents)
    .where(eq(digitalSaleIntents.externalPaymentAttemptId, row.id))
    .limit(1))[0];
  if (linkedIntent && Number(linkedIntent.id) !== input.digitalSaleIntentId) {
    throw new TRPCError({ code: "CONFLICT", message: "محاولة الدفع محجوزة لبيع رقمي آخر" });
  }
  if (input.digitalSaleIntentId != null && (!linkedIntent || Number(linkedIntent.id) !== input.digitalSaleIntentId)) {
    throw new TRPCError({ code: "CONFLICT", message: "نيّة البيع الرقمي لا تطابق محاولة الدفع المؤكدة" });
  }
  // إنقاذ نيّة رقمية NEEDS_REVIEW ينفّذه مدير بعد إصدار الكروت. الربط الفريد بالنيّة
  // هو التفويض هنا؛ نبقي createdBy/confirmedBy الأصليين ولا ننسب التأكيد إلى المدير.
  const trustedDigitalRecovery = input.digitalSaleIntentId != null
    && linkedIntent != null
    && Number(linkedIntent.id) === input.digitalSaleIntentId
    && (actor.role === "admin" || actor.role === "manager");
  if (!trustedDigitalRecovery && Number(row.createdBy) !== actor.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "محاولة الدفع لم ينشئها هذا الكاشير" });
  }
  if (row.confirmedBy == null || (!trustedDigitalRecovery && Number(row.confirmedBy) !== actor.userId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "محاولة الدفع لم يؤكدها هذا الكاشير" });
  }
  return row;
}

/** بصمة idempotency: نفس المفتاح لا يجوز أن يعيد فاتورةً بمحاولة أخرى. */
export async function assertExternalPaymentReplay(
  tx: Tx,
  invoiceId: number,
  input: ExternalPaymentBindingInput,
  actor: Actor,
): Promise<void> {
  if (input.method === "CASH") {
    if (input.attemptId != null) throw new TRPCError({ code: "CONFLICT", message: "بيع نقدي قديم لا يحمل محاولة دفع خارجية" });
    return;
  }
  if (!input.attemptId) throw new TRPCError({ code: "BAD_REQUEST", message: "أكّد الدفع الخارجي قبل إعادة المحاولة" });
  const row = (await tx
    .select()
    .from(externalPaymentAttempts)
    .where(eq(externalPaymentAttempts.id, input.attemptId))
    .limit(1))[0];
  if (!row || Number(row.invoiceId) !== invoiceId || row.receiptId == null) {
    throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: محاولة الدفع مختلفة عن البيع الأصلي" });
  }
  if (Number(row.branchId) !== input.branchId || row.channel !== input.channel || row.paymentMethod !== input.method || !money(row.amount).eq(money(input.amount))) {
    throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: بيانات الدفع مختلفة عن البيع الأصلي" });
  }
  if (row.deviceId !== (input.deviceId?.trim() || null)) {
    throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: جهاز الدفع مختلف عن البيع الأصلي" });
  }
  let linkedIntentId: number | null = null;
  if (input.digitalSaleIntentId != null) {
    const linkedIntent = (await tx
      .select({ id: digitalSaleIntents.id })
      .from(digitalSaleIntents)
      .where(eq(digitalSaleIntents.externalPaymentAttemptId, row.id))
      .limit(1))[0];
    if (!linkedIntent || Number(linkedIntent.id) !== input.digitalSaleIntentId) {
      throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: محاولة الدفع لا تخص النيّة الرقمية" });
    }
    linkedIntentId = Number(linkedIntent.id);
  }
  const trustedDigitalRecovery = linkedIntentId != null && (actor.role === "admin" || actor.role === "manager");
  if (!trustedDigitalRecovery && (Number(row.createdBy) !== actor.userId || Number(row.confirmedBy) !== actor.userId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "محاولة الدفع الأصلية تخص كاشيراً آخر" });
  }
}

/** يُستهلك الصف المقفول في نفس معاملة invoice+receipt+ledger؛ أي فشل لاحق يعيد الأربعة معاً. */
export async function bindExternalPaymentAttempt(
  tx: Tx,
  attemptId: number,
  invoiceId: number,
  receiptId: number,
): Promise<void> {
  const result: any = await tx
    .update(externalPaymentAttempts)
    .set({ invoiceId, receiptId, consumedAt: new Date() })
    .where(and(
      eq(externalPaymentAttempts.id, attemptId),
      eq(externalPaymentAttempts.state, "CONFIRMED"),
      sql`${externalPaymentAttempts.invoiceId} IS NULL`,
      sql`${externalPaymentAttempts.receiptId} IS NULL`,
    ));
  if (Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0) !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "تعذّر استهلاك محاولة الدفع مرةً واحدة" });
  }
}

function coreSaleInput(input: ConfirmedPosSaleInput, reference?: string): CreateSaleInput {
  const { requireExternalPaymentAttempt: _required, payment, ...rest } = input;
  return {
    ...rest,
    payment: payment
      ? {
          amount: payment.amount,
          method: payment.method,
          reference: reference ?? payment.reference ?? null,
        }
      : null,
  };
}

/**
 * تركيب قناة POS: التأكيد الخارجي + الفاتورة + الإيصال + الاستهلاك في معاملة واحدة.
 * نواة البيع العامة تبقى قابلةً لمساراتها الداخلية، أمّا الراوتر العام والبطاقات الرقمية فيمران هنا.
 */
export async function createConfirmedPosSaleInTx(
  tx: Tx,
  input: ConfirmedPosSaleInput,
  actor: Actor,
  capability?: typeof DIGITAL_SALE_CAPABILITY,
): Promise<CreateSaleResult> {
  const payment = input.payment;
  if (!input.requireExternalPaymentAttempt || !payment) {
    return createSaleInTx(tx, coreSaleInput(input), actor, capability);
  }
  if (payment.method === "CASH") {
    if (payment.externalPaymentAttemptId != null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الدفع النقدي لا يحمل محاولة دفع خارجية" });
    }
    return createSaleInTx(tx, coreSaleInput(input), actor, capability);
  }

  // الإعادة التسلسلية تُعيد الفاتورة فقط إن كانت محاولة القبض نفسها مرتبطة بها.
  // نترك createSaleInTx يعيد فحص بصمة السلة/العميل/الطريقة قبل كشف النتيجة.
  const existingInvoice = input.clientRequestId
    ? (await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.sourceId, input.clientRequestId))
        .limit(1))[0]
    : null;
  if (existingInvoice) {
    const replay = await createSaleInTx(tx, coreSaleInput(input), actor, capability);
    await assertExternalPaymentReplay(tx, replay.invoiceId, {
      branchId: input.branchId,
      channel: "POS",
      method: payment.method,
      amount: payment.amount,
      attemptId: payment.externalPaymentAttemptId,
      deviceId: input.deviceId,
      digitalSaleIntentId: payment.externalPaymentIntentId,
    }, actor);
    return replay;
  }

  const attempt = await lockConfirmedExternalPaymentAttempt(tx, {
    branchId: input.branchId,
    channel: "POS",
    method: payment.method,
    amount: payment.amount,
    attemptId: payment.externalPaymentAttemptId,
    deviceId: input.deviceId,
    digitalSaleIntentId: payment.externalPaymentIntentId,
  }, actor);
  const sale = await createSaleInTx(tx, coreSaleInput(input, attempt.externalReference), actor, capability);
  if (sale.idempotentReplay) {
    await assertExternalPaymentReplay(tx, sale.invoiceId, {
      branchId: input.branchId,
      channel: "POS",
      method: payment.method,
      amount: payment.amount,
      attemptId: payment.externalPaymentAttemptId,
      deviceId: input.deviceId,
      digitalSaleIntentId: payment.externalPaymentIntentId,
    }, actor);
    return sale;
  }

  const receipt = (await tx
    .select({ id: receipts.id, amount: receipts.amount, paymentMethod: receipts.paymentMethod })
    .from(receipts)
    .where(eq(receipts.invoiceId, sale.invoiceId))
    .orderBy(desc(receipts.id))
    .limit(1))[0];
  if (!receipt || receipt.paymentMethod !== payment.method || !money(receipt.amount).eq(money(attempt.amount))) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "لم يُنشأ إيصال مطابق لمحاولة الدفع — تراجعت الفاتورة بالكامل",
    });
  }
  await bindExternalPaymentAttempt(tx, Number(attempt.id), sale.invoiceId, Number(receipt.id));
  return sale;
}

export async function createConfirmedPosSale(
  input: ConfirmedPosSaleInput,
  actor: Actor,
): Promise<CreateSaleResult> {
  const result = await withTx((tx) => createConfirmedPosSaleInTx(tx, input, actor));

  // حافظ على عقد createSale: الإشعار best-effort وبعد الالتزام، حتى في المسار النقدي.
  try {
    await notifySaleCustomerAfterCommit(coreSaleInput(input), result);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), invoiceId: result.invoiceId },
      "confirmed POS sale: تعذّر إرسال إشعار الشكر — تُجوهل",
    );
  }

  return result;
}
