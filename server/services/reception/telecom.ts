// ش٥ (§٩.٤) — ضوابط قبض رصيد الاتصال (زين حصراً): تُشحن **مع** الطريقة لا بعدها.
//
// رصيد الاتصال هو طريقة الدفع الوحيدة بلا أيّ مُثبِتٍ خارج كلمة الموظف (البطاقة لها قسيمة
// جهاز، والتحويل سجلّ مصرف) — وI15 يضمن أنها لا تُنتج DRAWER أبداً فالدرج يُغلق بفارغ صفرٍ
// حتى لو دفع الزبون نقداً وسُجِّلت «رصيد اتصال» وأُخذ النقد. لذلك الضوابط الخمسة هنا:
//  ١) كود كارت الشحن إلزاميّ **وأحاديّ الاستعمال** (الكود يُشحن مرّةً واحدة فيزيائياً —
//     تكراره إمّا خطأ إدخالٍ وإمّا تسجيل قبضٍ لم يحدث). + هاتف مُرسِلٍ اختياريّ مُطبَّع
//     بقيد (رقم، يوم، مبلغ) لتحويلات الرصيد المباشرة.
//  ٢) سقفٌ لكل عملية (ENV TELECOM_MAX_PER_TX_IQD، افتراضي ٢٥٠ ألفاً).
//  ٣) سقفٌ يوميّ لكل مستخدم (ENV TELECOM_MAX_PER_USER_DAY_IQD، افتراضي مليون).
//  ٤) قفلٌ تلقائيّ عند تقادم المطابقة (ENV TELECOM_RECON_MAX_AGE_DAYS، افتراضي ٧):
//     لا قبض جديد إن تجاوز عمرُ آخر مطابقة زين الحدَّ — ومنذ أول قبضٍ إن لم تُطابَق قط.
//  ٥) «زين حصراً» بنيوياً: لا حقل مزوّدٍ أصلاً — TELECOM = رصيد زين تسميةً وسلوكاً
//     (PAY_METHOD_AR/METHOD_LABEL)، فلا يُمثَّل غيرُه.
// القراءات الحارسة **قافلة** (فخّ لقطة MVCC الموثَّق في deposits.ts).
import { TRPCError } from "@trpc/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { cardReconciliations, receipts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { normalizeIraqPhoneE164 } from "../../lib/phone";
import { utcTodayStart } from "../businessDay";
import { money, round2 } from "../money";

/** سقف العملية الواحدة (IQD). */
export function getTelecomMaxPerTx(): number {
  const n = Number(process.env.TELECOM_MAX_PER_TX_IQD);
  return Number.isFinite(n) && n > 0 ? n : 250_000;
}
/** السقف اليومي للمستخدم الواحد (IQD). */
export function getTelecomMaxPerUserDay(): number {
  const n = Number(process.env.TELECOM_MAX_PER_USER_DAY_IQD);
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}
/** أقصى عمرٍ لآخر مطابقة زين قبل قفل القبض (أيام). */
export function getTelecomReconMaxAgeDays(): number {
  const n = Number(process.env.TELECOM_RECON_MAX_AGE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export interface TelecomCollectCheck {
  userId: number;
  amount: string;
  /** كود كارت الشحن (referenceNumber) — إلزاميّ. */
  reference: string | null | undefined;
  /** هاتف المُرسِل لتحويل الرصيد المباشر — اختياريّ، يُطبَّع E.164. */
  senderPhone?: string | null;
}

/**
 * حارس قبض رصيد زين — يُستدعى داخل معاملة كل مسار قبضٍ يقبل TELECOM
 * (collectDeposit / collectOnInvoice / checkoutReceptionInTx) قبل إنشاء الإيصال.
 * يعيد الهاتف المُطبَّع (إن ورد) ليُخزَّن في receipts.telecomSenderPhone.
 */
export async function assertTelecomCollectAllowed(
  tx: Tx,
  input: TelecomCollectCheck,
): Promise<{ normalizedSenderPhone: string | null }> {
  const amountD = round2(money(input.amount));

  // ١) الكود إلزاميّ وبشكلٍ معقول (أرقام كروت زين).
  const code = input.reference?.trim() ?? "";
  if (code.length < 6 || code.length > 40) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "أدخل أرقام كارت شحن زين (الكود) — إلزاميّ لرصيد الاتصال",
    });
  }
  // أحاديّ الاستعمال: كودٌ سبق قبضُه = خطأ إدخالٍ أو قبضٌ لم يحدث. قراءة قافلة (تسلسل تحت التزامن).
  const dup = (
    await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.paymentMethod, "TELECOM"), eq(receipts.referenceNumber, code)))
      .for("update")
      .limit(1)
  )[0];
  if (dup) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `كارت الشحن هذا سبق قبضُه (إيصال #${dup.id}) — الكود يُشحن مرّةً واحدة؛ تحقّق من الأرقام`,
    });
  }

  // هاتف المُرسِل (اختياريّ): تطبيعٌ صارم + قيد (رقم، يوم، مبلغ) — تحويلان متطابقان في يومٍ
  // واحد شبهةُ تسجيلٍ مزدوج لتحويلٍ واحد.
  let normalizedSenderPhone: string | null = null;
  if (input.senderPhone?.trim()) {
    normalizedSenderPhone = normalizeIraqPhoneE164(input.senderPhone.trim());
    const dupPhone = (
      await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(and(
          eq(receipts.paymentMethod, "TELECOM"),
          eq(receipts.telecomSenderPhone, normalizedSenderPhone),
          eq(receipts.amount, amountD.toFixed(2)),
          gte(receipts.createdAt, utcTodayStart()),
        ))
        .for("update")
        .limit(1)
    )[0];
    if (dupPhone) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `تحويلٌ بنفس الرقم والمبلغ سُجِّل اليوم (إيصال #${dupPhone.id}) — لا يُسجَّل التحويل الواحد مرّتين`,
      });
    }
  }

  // ٢) سقف العملية.
  const maxPerTx = getTelecomMaxPerTx();
  if (amountD.gt(maxPerTx)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `قبض رصيد الاتصال محدودٌ بـ${maxPerTx.toLocaleString("en-US")} د.ع للعملية الواحدة — قسّم المبلغ أو استعمل طريقةً أخرى`,
    });
  }

  // ٣) السقف اليوميّ للمستخدم (المكتمل غير المعكوس).
  const dayRow = (
    await tx
      .select({ v: sql<string>`COALESCE(SUM(${receipts.amount}), 0)` })
      .from(receipts)
      .where(and(
        eq(receipts.paymentMethod, "TELECOM"),
        eq(receipts.direction, "IN"),
        eq(receipts.status, "COMPLETED"),
        eq(receipts.createdBy, input.userId),
        gte(receipts.createdAt, utcTodayStart()),
      ))
      .for("update")
  )[0];
  const maxPerDay = getTelecomMaxPerUserDay();
  const dayTotal = round2(money(dayRow?.v ?? "0").plus(amountD));
  if (dayTotal.gt(maxPerDay)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `تجاوزتَ سقفك اليوميّ لرصيد الاتصال (${maxPerDay.toLocaleString("en-US")} د.ع) — المتبقّي لك اليوم ${Math.max(0, maxPerDay - Number(dayRow?.v ?? 0)).toLocaleString("en-US")} د.ع`,
    });
  }

  // ٤) قفل تقادم المطابقة: آخر مطابقة زين أقدم من الحدّ ⇒ لا قبض جديد حتى تُطابَق.
  //    ومنذ أوّل قبضٍ إن لم تُطابَق قطّ (يغلق ثغرة «لا نطابق أبداً فلا نُقفل أبداً»).
  const maxAgeMs = getTelecomReconMaxAgeDays() * 86_400_000;
  const lastRecon = (
    await tx
      .select({ createdAt: cardReconciliations.createdAt })
      .from(cardReconciliations)
      .where(eq(cardReconciliations.accountKind, "TELECOM"))
      .orderBy(sql`${cardReconciliations.createdAt} DESC`)
      .limit(1)
  )[0];
  const anchor = lastRecon?.createdAt
    ?? (
      await tx
        .select({ createdAt: receipts.createdAt })
        .from(receipts)
        .where(eq(receipts.paymentMethod, "TELECOM"))
        .orderBy(sql`${receipts.createdAt} ASC`)
        .limit(1)
    )[0]?.createdAt
    ?? null;
  if (anchor && Date.now() - new Date(anchor).getTime() > maxAgeMs) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: lastRecon
        ? `مطابقة حساب زين متقادمة (أكثر من ${getTelecomReconMaxAgeDays()} أيام) — طابق كشف زين من شاشة حساب البطاقة/زين ثم تابع القبض`
        : `حساب زين لم يُطابَق منذ بدء استعماله — أنشئ أوّل مطابقةٍ من شاشة حساب البطاقة/زين ثم تابع القبض`,
    });
  }

  return { normalizedSenderPhone };
}
