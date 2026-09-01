// ردّ أمانة أجرة توصيل أمر الشغل (DLV-FEE-WO) غير المصروفة — بحوكمة الردّ النقديّ (نظير refundDeposit).
//
// السياق (تدقيق ٦/٨ + مراجعة Codex على PR #531، ١٠/٨): أمانة أجرة COUNTER تُقبَض **نقداً** في
// الدرج عند إنشاء أمر الشغل (create.ts، feeMethod ثابتٌ CASH) ومبرِّئوها إمّا الإرسال (dispatch
// يصرفها للمندوب) أو الإلغاء (cancel). لكنّ «إعادة تصنيف الطلب إلى استلامٍ مباشر ثم تسليمه»
// (updateWorkOrderDeliveryMethod) لا يمرّ بأيّهما ⇒ الأمانة تعلق في الدرج للأبد: Σ FEE_HELD موجب
// دائم + نقد زبونٍ بلا مسار ردّ (خرق «لا دينار بلا مسار» §٥).
//
// المحاولة الأولى (ردٌّ تلقائيّ صامت) سُحبت لأنها كانت تُخرج النقد بلا إبلاغ الكاشير وتتجاوز حوكمة
// الردّ النقديّ. هذا المساعد يردّها بنفس حوكمة **ردّ العربون** (refundDeposit، قرار المالك ب/٨/٨):
// الردّ النقديّ ذاتيٌّ فقط ضمن وردية القبض نفسها وهي مفتوحة بيد القابض؛ عبر ورديةٍ أخرى أو بعد
// إغلاقها (المال عاد للخزينة بالعهدة الوسيطة) ⇒ اعتماد مدير ثانٍ مختلف عن المنفّذ، بلا تجاوزٍ للدور.
//
// النِّت = Σ(IN − OUT) لإيصالات المرجع DLV-FEE-WO-{id} — فهو نفسه حارس idempotency الأساس: بعد
// الردّ الأوّل يصير صفراً فلا يُردّ ثانيةً؛ ومفتاح القيد الفريد (DELIVERY_FEE_HELD_REFUND) حزامٌ
// ثانٍ ضدّ التزامن (نداءان متزامنان ⇒ ER_DUP على الثاني فيتراجع، يمتصّه retryOnDup في الراوتر).
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { receipts, shifts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { resolveBranchCashShiftTx } from "../shiftService";
import { assertCashOutAvailable } from "../cash/cashAvailability";
import type { Actor } from "../tx";

export interface RefundWorkOrderFeeHeldOpts {
  workOrderId: number;
  branchId: number;
  actor: Actor & { role?: string };
  /** درج ردّ الأمانة — يُلزَم فقط حين يتعدّد الدرج المفتوح بالفرع. */
  refundShiftId?: number | null;
  /** هوية مدير ثانٍ تحقق الراوتر من بياناته — تُخزّن على سند الرد ولا يجوز أن تساوي المنفذ. */
  approvedByManagerId?: number | null;
  reason: string;
}

/** صافي أمانة أجرة التوصيل المحتجزة لأمر الشغل = Σ(IN − OUT) لإيصالات DLV-FEE-WO-{id} المكتملة. */
export async function workOrderFeeHeldNet(tx: Tx, workOrderId: number): Promise<ReturnType<typeof money>> {
  const row = (
    await tx
      .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
      .from(receipts)
      .where(and(
        eq(receipts.workOrderId, workOrderId),
        eq(receipts.referenceNumber, `DLV-FEE-WO-${workOrderId}`),
        eq(receipts.status, "COMPLETED"),
      ))
  )[0];
  return round2(money(row?.v ?? "0"));
}

/**
 * يردّ أمانة أجرة التوصيل غير المصروفة لأمر الشغل **نقداً** من الدرج، بحوكمة refundDeposit.
 * يعيد المبلغ المردود ({ refunded }) — "0.00" إن لا أمانة. **يجب** أن يُستدعى تحت قفل صفّ أمر
 * الشغل (المستدعون يقفلونه: loadWorkOrder... يُتبَع بكتابة) كي لا يتسابق نداءان على نفس الأمانة.
 */
export async function refundWorkOrderDeliveryFeeHeld(
  tx: Tx,
  opts: RefundWorkOrderFeeHeldOpts,
): Promise<{ refunded: string }> {
  const feeHeldNet = await workOrderFeeHeldNet(tx, opts.workOrderId);
  if (!feeHeldNet.gt(0)) return { refunded: "0.00" };

  // حوكمة الردّ النقديّ (نظير refundDeposit، قرار المالك ب/٨/٨): الأمانة نقديّةٌ دائماً. الردّ
  // ذاتيٌّ فقط ضمن وردية القبض نفسها وهي مفتوحة بيد القابض؛ غير ذلك ⇒ مدير ثانٍ
  // محدد الهوية. الصلاحية توسّع الرؤية ولا تلغي maker-checker.
  const collReceipt = (
      await tx
        .select({ shiftId: receipts.shiftId })
        .from(receipts)
        .where(and(
          eq(receipts.workOrderId, opts.workOrderId),
          eq(receipts.referenceNumber, `DLV-FEE-WO-${opts.workOrderId}`),
          eq(receipts.direction, "IN"),
          eq(receipts.status, "COMPLETED"),
        ))
        .orderBy(asc(receipts.id))
        .limit(1)
  )[0];
  const collShiftId = collReceipt?.shiftId != null ? Number(collReceipt.shiftId) : null;
  const collShift = collShiftId != null
    ? (await tx.select({ status: shifts.status, userId: shifts.userId }).from(shifts).where(eq(shifts.id, collShiftId)).limit(1))[0]
    : undefined;
  const sameOpenShift = collShift != null && collShift.status === "OPEN" && Number(collShift.userId) === opts.actor.userId;
  const approvedByManagerId = opts.approvedByManagerId == null ? null : Number(opts.approvedByManagerId);
  if (!sameOpenShift) {
    if (!Number.isInteger(approvedByManagerId) || approvedByManagerId! <= 0 || approvedByManagerId === opts.actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `ردّ أمانة أجرة توصيلٍ نقديّة عبر ورديةٍ أخرى أو بعد إغلاق وردية القبض (#${collShiftId ?? "?"}) يتطلّب اعتماد مدير ثانٍ مختلف — المال عاد إلى الخزينة عند الإغلاق.`,
      });
    }
  }

  const resolved = await resolveBranchCashShiftTx(tx, opts.branchId, opts.refundShiftId ?? null);
  await assertCashOutAvailable(tx, {
    branchId: opts.branchId, cashBucket: "DRAWER", shiftId: resolved.shiftId,
    amount: feeHeldNet, operation: "رد أمانة أجرة توصيل أمر الشغل",
  });
  const feeOut = await tx.insert(receipts).values({
    branchId: opts.branchId, shiftId: resolved.shiftId, workOrderId: opts.workOrderId,
    direction: "OUT", amount: toDbMoney(feeHeldNet), paymentMethod: "CASH", cashBucket: "DRAWER",
    status: "COMPLETED", partyType: "OTHER",
    approvalStatus: "APPROVED",
    approvedBy: sameOpenShift ? null : approvedByManagerId,
    approvedAt: sameOpenShift ? null : new Date(),
    referenceNumber: `DLV-FEE-WO-${opts.workOrderId}`,
    description: `${opts.reason} — طلب #${opts.workOrderId}`,
    createdBy: opts.actor.userId,
  });
  await postEntry(tx, {
    entryType: "DELIVERY_FEE_HELD",
    dedupeKey: `DELIVERY_FEE_HELD_REFUND:WO:${opts.workOrderId}`,
    branchId: opts.branchId,
    receiptId: extractInsertId(feeOut),
    amount: feeHeldNet.neg(),
    notes: `${opts.reason} — طلب #${opts.workOrderId}`,
    postingSourceComponents: {
      roleDebits: { COURIER_PAYABLE: feeHeldNet },
      roleCredits: { CASH: feeHeldNet },
    },
    postingIntent: createPostingIntent("DELIVERY_FEE_HELD_PAYOUT", "DELIVERY_FEE_HELD", [debitLine("COURIER_PAYABLE", feeHeldNet), creditLine("CASH", feeHeldNet)], {
      roleDebits: { COURIER_PAYABLE: feeHeldNet },
      roleCredits: { CASH: feeHeldNet },
    }),
  });
  return { refunded: feeHeldNet.toFixed(2) };
}
