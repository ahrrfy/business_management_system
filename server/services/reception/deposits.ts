// ش٤ — العرابين على مسوّدات الاستقبال (م٢: عربونٌ بأيّ طريقةٍ والربح يبقى عند التسليم).
//
// النموذج الماليّ مرآةُ عربون أمر الشغل القائم حرفياً (workOrder/create.ts:129-164):
// إيصال IN (DRAWER للنقد، NULL لغيره) + قيد PAYMENT_IN بلا invoiceId بوسم [DRAFT_DEPOSIT:{id}]
// — بلا adjustCustomerBalance (المال أمانةٌ محتجزة، لا تسديدَ ذمّة). الحقيقة البنيوية في
// orderPayments (receiptId UNIQUE — الإصلاح الجذريّ لعلّة V3: لا مسح ظنّيّاً أبداً).
//
// ترتيب الأقفال الموحَّد (§٧.٤): مسوّدة ← وردية ← أمر شغل. كلّ كتابة مالٍ هنا تبدأ بقفل
// صفّ المسوّدة FOR UPDATE ⇒ I2 (سقف المقبوض) مُحكمٌ تحت التزامن الحقيقيّ بلا قفل جدول.
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  orderPayments,
  receptionDraftLines,
  receptionDrafts,
  receipts,
  shifts,
  workOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { findIdempotentRefId, recordIdempotencyKey } from "../idempotency";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import {
  computeExpectedCash,
  getOpenShift,
  openShiftIdTx,
  resolveBranchCashShiftTx,
} from "../shiftService";
import { withTx, type Actor } from "../tx";

/** طرق العربون المقبولة في ش٤ — TELECOM محجوزة في الـenum منذ 0153 وتُفتح في ش٥ بضوابط §٩.٤. */
export type DepositMethod = "CASH" | "CARD" | "TRANSFER" | "WALLET";

export interface CollectDepositInput {
  draftId: number;
  amount: string;
  method: DepositMethod;
  reference?: string | null;
  clientRequestId: string;
}

export interface RefundDepositInput {
  paymentId: number;
  amount: string;
  reason: string;
  clientRequestId: string;
}

type Decimal = ReturnType<typeof money>;

/** صافي المحتجز على مسوّدة: Σ COLLECTION (غير المردودة كلياً تُحمل بصافيها) − Σ REFUND.
 *  ⚠️ قراءةٌ **قافلة** (FOR UPDATE) عمداً — فخّ MVCC أمسكه اختبار التزامن I2: القراءة العادية
 *  داخل معاملةٍ سبق فيها SELECT عاديّ (فحص idempotency) تقرأ من لقطةٍ أقدم من قفل الصفّ،
 *  فيمرّ قبضان متزامنان يتجاوزان الإجمالي معاً. القراءة القافلة ترى آخر الملتزم دائماً.
 *  تُستدعى حصراً بعد قفل صفّ المسوّدة (ترتيب الأقفال: مسوّدة ← صفوف المال). */
export async function heldNetOfDraft(tx: Tx, draftId: number): Promise<Decimal> {
  const rows = await tx
    .select({ kind: orderPayments.kind, amount: orderPayments.amount })
    .from(orderPayments)
    .where(and(eq(orderPayments.draftId, draftId), inArray(orderPayments.kind, ["COLLECTION", "REFUND"])))
    .for("update");
  let net = money(0);
  for (const r of rows) {
    net = r.kind === "COLLECTION" ? net.plus(money(r.amount)) : net.minus(money(r.amount));
  }
  return round2(net);
}

/** إجمالي المسوّدة مُعاداً حسابه من الأسطر (لا من أعمدة الرأس — ذاكرة عرضٍ فقط).
 *  قراءةٌ قافلة لنفس علّة MVCC أعلاه (زميلٌ زامن أسطراً أرخص قبيل قفلنا ⇒ لقطةٌ قديمة تُريها أغلى). */
async function recomputedDraftTotal(tx: Tx, draftId: number): Promise<Decimal> {
  const lines = await tx
    .select({
      quantity: receptionDraftLines.quantity,
      unitPrice: receptionDraftLines.unitPrice,
      discountAmount: receptionDraftLines.discountAmount,
    })
    .from(receptionDraftLines)
    .where(eq(receptionDraftLines.draftId, draftId))
    .for("update");
  let total = money(0);
  for (const l of lines) {
    const gross = round2(money(l.unitPrice).times(money(l.quantity)));
    total = total.plus(gross).minus(round2(money(l.discountAmount ?? "0")));
  }
  return round2(total);
}

/**
 * قبض عربون على مسوّدة محفوظة — بوردية استقبالٍ **مُلزَمة بنوعها** (V12، حتى للمدير):
 * الدرج الذي يدخله النقد هو درجُ من سيُحاسَب عليه عند الإغلاق (تأكيد المالك ٥/٨)، والوردية
 * تُختم على صفّ orderPayments وتبقى عليه أبداً (قاعدة ٤ / I12) حتى لو ثُبِّت الطلب بوردية أخرى.
 * بلا `version` عمداً: قبضُ مالٍ لا يفشل لأنّ زميلاً أضاف سطراً — حاميه clientRequestId.
 */
export async function collectDeposit(input: CollectDepositInput, actor: Actor & { role?: string }) {
  return withTx(async (tx) => {
    // idempotency أولاً: إعادة إرسال نفس الطلب تعيد النتيجة نفسها بلا قبضٍ ثانٍ.
    const existingId = await findIdempotentRefId(tx, "reception.collectDeposit", input.clientRequestId);
    if (existingId) {
      const row = (
        await tx.select().from(orderPayments).where(eq(orderPayments.id, existingId)).limit(1)
      )[0];
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "سجلّ العربون المكرَّر مفقود" });
      const collectedTotal = await heldNetOfDraft(tx, Number(row.draftId));
      return {
        paymentId: Number(row.id),
        receiptId: Number(row.receiptId),
        collectedTotal: toDbMoney(collectedTotal),
        idempotentReplay: true as const,
      };
    }

    const amountD = round2(money(input.amount));
    if (amountD.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ العربون يجب أن يكون أكبر من صفر" });
    if ((input.method as string) === "TELECOM") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "قبض رصيد الاتصال يُفتح في مرحلته بضوابطه — غير متاح بعد" });
    }
    if (input.method !== "CASH" && !input.reference?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المرجع إلزاميّ لغير النقد (رقم القسيمة/التحويل)" });
    }

    // ١) قفل المسوّدة — رأس ترتيب الأقفال، وبوّابة I2.
    const draft = (
      await tx.select().from(receptionDrafts).where(eq(receptionDrafts.id, input.draftId)).for("update").limit(1)
    )[0];
    if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب المحفوظ غير موجود" });
    if (draft.status !== "OPEN") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الطلب لم يعد مفتوحاً — لا يُقبض عربون على طلبٍ مُثبَّت/ملغى" });
    }
    const elevated = actor.role === "admin" || actor.role === "manager";
    if (!elevated && Number(draft.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
    }

    // ٢) وردية استقبال مفتوحة للقابض **بنوعها الدقيق** (لا تسامح openShiftIdTx — V12).
    const myShift = await getOpenShift(actor.userId, Number(draft.branchId), "RECEPTION");
    if (!myShift) {
      const anyShift = await getOpenShift(actor.userId, Number(draft.branchId));
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: anyShift
          ? `ورديتك المفتوحة ليست وردية استقبال (${anyShift.shiftType}) — العربون يُقبض على وردية استقبالٍ يدخل درجَها ويُحاسَب عليها`
          : "افتح وردية استقبال أولاً — العربون يدخل درجك أنت وتُحاسَب عليه عند الإغلاق",
      });
    }
    // مراجعة ش٤: getOpenShift قراءةٌ عاديّة خارج المعاملة — closeShift المتزامن كان يُهبط إيصال
    // العربون على ورديةٍ أُغلقت وسُوِّيت للتوّ (نقدٌ خارج Z نهائياً — نفس سباق تدقيق ٢٣/٦ الموثَّق
    // في openShiftIdTx). القفل + إعادة الفحص تحت القفل يجعلانه مستحيلاً (ترتيب §٧.٤: مسوّدة ← وردية).
    const lockedShift = (
      await tx
        .select({ status: shifts.status, shiftType: shifts.shiftType })
        .from(shifts)
        .where(eq(shifts.id, Number(myShift.id)))
        .for("update")
        .limit(1)
    )[0];
    if (!lockedShift || lockedShift.status !== "OPEN" || lockedShift.shiftType !== "RECEPTION") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "ورديتك أُغلقت للتوّ — افتح وردية استقبال ثم أعد قبض العربون",
      });
    }

    // ٣) I2 تحت القفل: المقبوض الجديد + الصافي المحتجز <= إجمالي الأسطر المُعاد حسابه.
    const held = await heldNetOfDraft(tx, input.draftId);
    const total = await recomputedDraftTotal(tx, input.draftId);
    const nextHeld = round2(held.plus(amountD));
    if (nextHeld.gt(total)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `المقبوض يتجاوز إجمالي الطلب: محتجزٌ ${held.toFixed(2)} + الجديد ${amountD.toFixed(2)} > الإجمالي ${total.toFixed(2)}`,
      });
    }

    // ٤) الإيصال + القيد — مرآة عربون أمر الشغل (بلا partyType/partyId: ليس سنداً مستقلاً
    //    يظهر في كشف العميل، وقارئ reconcile يستثنيه عبر orderPayments — holdReceipts.ts).
    const rRes = await tx.insert(receipts).values({
      branchId: Number(draft.branchId),
      shiftId: Number(myShift.id),
      direction: "IN",
      amount: toDbMoney(amountD),
      paymentMethod: input.method,
      referenceNumber: input.reference?.trim() || null,
      cashBucket: input.method === "CASH" ? "DRAWER" : null,
      status: "COMPLETED",
      description: `عربون طلب محفوظ ${draft.draftNumber}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rRes);
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      branchId: Number(draft.branchId),
      receiptId,
      customerId: draft.customerId != null ? Number(draft.customerId) : null,
      amount: amountD,
      notes: `[DRAFT_DEPOSIT:${input.draftId}]`,
    });

    const pRes = await tx.insert(orderPayments).values({
      draftId: input.draftId,
      branchId: Number(draft.branchId),
      customerId: draft.customerId != null ? Number(draft.customerId) : null,
      kind: "COLLECTION",
      amount: toDbMoney(amountD),
      method: input.method,
      receiptId,
      shiftId: Number(myShift.id),
      status: "HELD",
      referenceNumber: input.reference?.trim() || null,
      clientRequestId: input.clientRequestId,
      createdBy: actor.userId,
    });
    const paymentId = extractInsertId(pRes);

    // ٥) moneyLocked يُرفع ولا يُخفَض أبداً (العمود الفقريّ لحارس I3 وبوّابة الإلغاء المديريّ).
    if (!draft.moneyLocked) {
      await tx.update(receptionDrafts).set({ moneyLocked: true }).where(eq(receptionDrafts.id, input.draftId));
    }

    await recordIdempotencyKey(tx, "reception.collectDeposit", input.clientRequestId, paymentId);
    return {
      paymentId,
      receiptId,
      collectedTotal: toDbMoney(nextHeld),
      heldBefore: toDbMoney(held),
      draftNumber: draft.draftNumber,
      shiftId: Number(myShift.id),
      idempotentReplay: false as const,
    };
  });
}

/**
 * ردّ عربونٍ محتجز — **بطريقة القبض حتماً**، مربوطاً بأمّه (parentPaymentId)، بمبلغٍ <= الصافي
 * المتبقّي منها. المطبَّق على فاتورة (APPLIED) لا يُردّ من هنا — مسارُه مرتجع الفاتورة المديريّ.
 * النقد يخرج من درج الفرع بفحص كفايةٍ (مرآة workOrder/cancel.ts) ⇒ I17: OUT موثَّق مربوط.
 */
export async function refundDeposit(
  input: RefundDepositInput,
  actor: Actor & { role?: string },
  opts: { refundShiftId?: number | null } = {},
) {
  return withTx(async (tx) => {
    const existingId = await findIdempotentRefId(tx, "reception.refundDeposit", input.clientRequestId);
    if (existingId) {
      const row = (
        await tx.select().from(orderPayments).where(eq(orderPayments.id, existingId)).limit(1)
      )[0];
      return {
        refundPaymentId: existingId,
        refundReceiptId: row ? Number(row.receiptId) : null,
        idempotentReplay: true as const,
      };
    }

    const amountD = round2(money(input.amount));
    if (amountD.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ الردّ يجب أن يكون أكبر من صفر" });

    // قراءة استرشادية لمعرفة المسوّدة، ثم قفلٌ بالترتيب الموحَّد: مسوّدة ← الصفّ الماليّ.
    const probe = (
      await tx.select().from(orderPayments).where(eq(orderPayments.id, input.paymentId)).limit(1)
    )[0];
    if (!probe || probe.kind !== "COLLECTION") {
      throw new TRPCError({ code: "NOT_FOUND", message: "سجلّ قبض العربون غير موجود" });
    }
    const draft = (
      await tx.select().from(receptionDrafts).where(eq(receptionDrafts.id, Number(probe.draftId))).for("update").limit(1)
    )[0];
    if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب المحفوظ غير موجود" });
    const payment = (
      await tx.select().from(orderPayments).where(eq(orderPayments.id, input.paymentId)).for("update").limit(1)
    )[0]!;

    const elevated = actor.role === "admin" || actor.role === "manager";
    if (!elevated && Number(draft.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
    }
    if (payment.status !== "HELD") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: payment.status === "APPLIED"
          ? "هذا المبلغ طُبِّق على فاتورةٍ عند التثبيت — استرداده بمرتجع الفاتورة (مدير)"
          : "هذا القبض مردودٌ بكامله سلفاً",
      });
    }

    // قراءةٌ قافلة (نفس فخّ لقطة MVCC): ردّان متزامنان لا يتجاوزان المتبقّي معاً.
    const refunded = await tx
      .select({ v: sql<string>`COALESCE(SUM(${orderPayments.amount}), 0)` })
      .from(orderPayments)
      .where(and(eq(orderPayments.parentPaymentId, input.paymentId), eq(orderPayments.kind, "REFUND")))
      .for("update");
    const refundable = round2(money(payment.amount).minus(money(refunded[0]?.v ?? "0")));
    if (amountD.gt(refundable)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `مبلغ الردّ (${amountD.toFixed(2)}) يتجاوز المتبقّي من هذا القبض (${refundable.toFixed(2)})`,
      });
    }

    // بطريقة القبض حتماً — لا «قُبض بطاقةً ورُدّ نقداً» (I17 + اختبار ش٤ الصريح).
    const method = (payment.method ?? "CASH") as DepositMethod;
    let shiftId: number | null;
    if (method === "CASH") {
      const resolved = await resolveBranchCashShiftTx(tx, Number(draft.branchId), opts.refundShiftId ?? null);
      shiftId = resolved.shiftId;
      const drawer = await computeExpectedCash(tx, shiftId, resolved.openingBalance);
      if (amountD.gt(drawer)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `المبلغ يتجاوز النقد المتوفّر حالياً في هذا الدرج (المتاح ${drawer.toFixed(2)} < المطلوب ${amountD.toFixed(2)})`,
        });
      }
    } else {
      shiftId = await openShiftIdTx(tx, actor.userId, Number(draft.branchId), "RECEPTION");
    }

    const rRes = await tx.insert(receipts).values({
      branchId: Number(draft.branchId),
      shiftId,
      direction: "OUT",
      amount: toDbMoney(amountD),
      paymentMethod: method,
      cashBucket: method === "CASH" ? "DRAWER" : null,
      status: "COMPLETED",
      referenceNumber: `DRF-REFUND-${Number(draft.id)}`,
      description: `استرداد عربون طلب محفوظ ${draft.draftNumber}: ${input.reason}`,
      createdBy: actor.userId,
    });
    const refundReceiptId = extractInsertId(rRes);
    // مراجعة ش٤: ساقا الردّ بعميل **القبض الأمّ** لا بعميل المسوّدة الحاليّ — تغييرُ عميل
    // المسوّدة بين القبض والردّ كان يترك ساقين على عميلين مختلفين دائمتين في AR الفرعيّ المشتقّ.
    const legCustomerId = payment.customerId != null ? Number(payment.customerId) : null;
    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: Number(draft.branchId),
      receiptId: refundReceiptId,
      customerId: legCustomerId,
      amount: amountD,
      notes: `[DRAFT_DEPOSIT:${Number(draft.id)}] استرداد: ${input.reason}`,
    });

    const refRes = await tx.insert(orderPayments).values({
      draftId: Number(draft.id),
      branchId: Number(draft.branchId),
      customerId: legCustomerId,
      kind: "REFUND",
      amount: toDbMoney(amountD),
      method,
      receiptId: refundReceiptId,
      shiftId,
      parentPaymentId: input.paymentId,
      clientRequestId: input.clientRequestId,
      createdBy: actor.userId,
    });
    const refundPaymentId = extractInsertId(refRes);

    if (amountD.gte(refundable)) {
      await tx.update(orderPayments).set({ status: "REFUNDED" }).where(eq(orderPayments.id, input.paymentId));
    }
    // moneyLocked لا يُخفَض أبداً — حتى بعد ردٍّ كامل يبقى الإلغاء مديرياً (أثرٌ ماليّ مرّ من هنا).

    await recordIdempotencyKey(tx, "reception.refundDeposit", input.clientRequestId, refundPaymentId);
    return {
      refundPaymentId,
      refundReceiptId,
      // لإتمام حمولة التدقيق في الراوتر (درج الخروج + المتبقّي قبل الردّ).
      shiftId,
      refundableBefore: toDbMoney(refundable),
      idempotentReplay: false as const,
    };
  });
}

/** سجلّ عرابين مسوّدة (للشاشة): الصفوف + الصافي المحتجز.
 *  مراجعة ش٤ (IDOR): عزل الفرع إلزاميّ — كانت النقطة الوحيدة في الشريحة بلا حارس فرع،
 *  فتُقرأ مبالغ ومراجع بطاقات أيّ فرعٍ بمعرّفٍ متسلسل. */
export async function listDraftPayments(draftId: number, actor?: (Actor & { role?: string }) | null, tx?: Tx) {
  const run = async (t: Tx) => {
    if (actor) {
      const draft = (
        await t
          .select({ branchId: receptionDrafts.branchId })
          .from(receptionDrafts)
          .where(eq(receptionDrafts.id, draftId))
          .limit(1)
      )[0];
      if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب المحفوظ غير موجود" });
      const elevated = actor.role === "admin" || actor.role === "manager";
      if (!elevated && Number(draft.branchId) !== Number(actor.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
      }
    }
    const rows = await t
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.draftId, draftId))
      .orderBy(asc(orderPayments.id));
    let net = money(0);
    for (const r of rows) {
      if (r.kind === "COLLECTION") net = net.plus(money(r.amount));
      else if (r.kind === "REFUND") net = net.minus(money(r.amount));
    }
    return { rows, heldNet: toDbMoney(round2(net)) };
  };
  if (tx) return run(tx);
  return withTx(run);
}

export interface AllocationTarget {
  kind: "INVOICE" | "WORKORDER";
  id: number;
  /** حصّة هذا الهدف من المال المقبوض سلفاً (P) — من التوزيع الجشع في checkoutReceptionInTx. */
  preAmount: string;
}

/**
 * تخصيص المحتجز على المستندات لحظة التثبيت (تُستدعى داخل معاملة commitDraft بعد إنشاء
 * المستندات): صفوف APPLICATION لكل (قبضٍ × هدف) بالجشع نفسه (أقدم قبضٍ أولاً × ترتيب
 * الأهداف كما وزّعها checkout)، ثم COLLECTION ⇒ APPLIED. الإيصال الذي ذهب مالُه كلُّه
 * لفاتورةٍ واحدة يُختم عليها invoiceId (نمط deliver.ts — append-only، لا مسّ للقيود)؛
 * المُشظّى بين أهدافٍ يبقى بلا ختم — حقيقتُه في orderPayments (I4).
 */
export async function allocateAtCommit(
  tx: Tx,
  args: { draftId: number; targets: AllocationTarget[]; actor: Actor },
) {
  const collections = await tx
    .select()
    .from(orderPayments)
    .where(
      and(
        eq(orderPayments.draftId, args.draftId),
        eq(orderPayments.kind, "COLLECTION"),
        eq(orderPayments.status, "HELD"),
      ),
    )
    .orderBy(asc(orderPayments.id));
  if (!collections.length) return { appliedPayments: [] as Array<{ paymentId: number; appliedKind: "INVOICE" | "WORKORDER"; appliedId: number; amount: string }> };

  // صافي كل قبضٍ بعد ردوده الجزئية.
  const refundRows = await tx
    .select({ parentPaymentId: orderPayments.parentPaymentId, v: sql<string>`COALESCE(SUM(${orderPayments.amount}), 0)` })
    .from(orderPayments)
    .where(and(eq(orderPayments.draftId, args.draftId), eq(orderPayments.kind, "REFUND")))
    .groupBy(orderPayments.parentPaymentId);
  const refundedOf = new Map<number, string>(refundRows.map((r) => [Number(r.parentPaymentId), String(r.v)]));

  const targetLeft = args.targets.map((t) => ({ ...t, left: round2(money(t.preAmount)) }));
  const appliedPayments: Array<{ paymentId: number; appliedKind: "INVOICE" | "WORKORDER"; appliedId: number; amount: string }> = [];

  for (const c of collections) {
    let left = round2(money(c.amount).minus(money(refundedOf.get(Number(c.id)) ?? "0")));
    const touched: AllocationTarget[] = [];
    for (const t of targetLeft) {
      if (left.lte(0)) break;
      if (t.left.lte(0)) continue;
      const share = left.gte(t.left) ? t.left : left;
      t.left = round2(t.left.minus(share));
      left = round2(left.minus(share));
      await tx.insert(orderPayments).values({
        draftId: args.draftId,
        branchId: Number(c.branchId),
        customerId: c.customerId != null ? Number(c.customerId) : null,
        kind: "APPLICATION",
        amount: toDbMoney(share),
        parentPaymentId: Number(c.id),
        appliedKind: t.kind,
        appliedId: t.id,
        createdBy: args.actor.userId,
      });
      touched.push(t);
      appliedPayments.push({ paymentId: Number(c.id), appliedKind: t.kind, appliedId: t.id, amount: toDbMoney(share) });
    }
    await tx.update(orderPayments).set({ status: "APPLIED" }).where(eq(orderPayments.id, Number(c.id)));
    // ختم الفاتورة على الإيصال **الصادق كاملاً** فقط: هدفٌ واحد **وبلا أيّ ردٍّ جزئيّ** — الإيصال
    // المختوم يدخل سقف استرداد المرتجع بمبلغه الكامل (returnService)، فختمُ إيصال ٥٠٠ رُدّ منه
    // ٢٠٠ كان يسمح باسترداد ٥٠٠ لفاتورةٍ دفعت ٣٠٠ صافياً (مراجعة ش٤ — نزيف درجٍ حقيقيّ).
    // المشوب بردٍّ يبقى بلا ختمٍ وحقيقتُه في orderPayments (نفس عقيدة المُشظّى I4).
    const hadRefund = money(refundedOf.get(Number(c.id)) ?? "0").gt(0);
    if (touched.length === 1 && touched[0].kind === "INVOICE" && c.receiptId != null && !hadRefund) {
      await tx
        .update(receipts)
        .set({ invoiceId: touched[0].id })
        .where(and(eq(receipts.id, Number(c.receiptId)), sql`${receipts.invoiceId} IS NULL`));
    }
  }
  return { appliedPayments };
}

/**
 * حقيقة عربون أمر شغلٍ وُلد من مسوّدة: حصص القبضات المطبَّقة عليه (P) — يقرؤها deliver
 * (لختم أحاديّ الهدف) وcancel (لردّ P بطريقة قبض كلّ حصّة) بدل الاعتماد على إيصال
 * depositReceiptId وحده (يحمل N الجديد فقط، وقد يكون صفراً). V3 بصيغتها البنيوية النهائية.
 */
export async function appliedCollectionsForWorkOrder(tx: Tx, workOrderId: number) {
  const apps = await tx
    .select({
      applicationId: orderPayments.id,
      amount: orderPayments.amount,
      parentPaymentId: orderPayments.parentPaymentId,
    })
    .from(orderPayments)
    .where(
      and(
        eq(orderPayments.kind, "APPLICATION"),
        eq(orderPayments.appliedKind, "WORKORDER"),
        eq(orderPayments.appliedId, workOrderId),
      ),
    )
    .orderBy(asc(orderPayments.id));
  if (!apps.length) return [];
  const parentIds = Array.from(new Set(apps.map((a) => Number(a.parentPaymentId))));
  const parents = await tx
    .select()
    .from(orderPayments)
    .where(inArray(orderPayments.id, parentIds));
  const parentOf = new Map(parents.map((p) => [Number(p.id), p]));
  // أحاديّ الهدف = لقبضه الأمّ تطبيقٌ واحدٌ فقط (على هذا الأمر).
  const appCounts = await tx
    .select({ parentPaymentId: orderPayments.parentPaymentId, n: sql<number>`COUNT(*)` })
    .from(orderPayments)
    .where(and(inArray(orderPayments.parentPaymentId, parentIds), eq(orderPayments.kind, "APPLICATION")))
    .groupBy(orderPayments.parentPaymentId);
  const countOf = new Map(appCounts.map((r) => [Number(r.parentPaymentId), Number(r.n)]));
  // ردود الأمّهات — القبض المردود جزئياً لا يُختم إيصالُه أبداً (مبلغه الكامل يكذب على سقف المرتجع).
  const refundSums = await tx
    .select({ parentPaymentId: orderPayments.parentPaymentId, v: sql<string>`COALESCE(SUM(${orderPayments.amount}), 0)` })
    .from(orderPayments)
    .where(and(inArray(orderPayments.parentPaymentId, parentIds), eq(orderPayments.kind, "REFUND")))
    .groupBy(orderPayments.parentPaymentId);
  const refundOf = new Map(refundSums.map((r) => [Number(r.parentPaymentId), String(r.v)]));
  return apps.map((a) => {
    const parent = parentOf.get(Number(a.parentPaymentId));
    return {
      applicationId: Number(a.applicationId),
      collectionId: Number(a.parentPaymentId),
      amount: String(a.amount),
      method: (parent?.method ?? "CASH") as DepositMethod,
      receiptId: parent?.receiptId != null ? Number(parent.receiptId) : null,
      draftId: parent != null ? Number(parent.draftId) : null,
      /** عميل القبض لحظته — ساقا الردّ تُكتبان به لا بعميل المسوّدة الحاليّ (قابلٍ للتغيّر). */
      customerId: parent?.customerId != null ? Number(parent.customerId) : null,
      soleTarget:
        (countOf.get(Number(a.parentPaymentId)) ?? 0) === 1 &&
        !money(refundOf.get(Number(a.parentPaymentId)) ?? "0").gt(0),
    };
  });
}

/**
 * ردّ حصص P لأمر شغلٍ يُلغى (تُستدعى داخل معاملة cancelWorkOrder بعد ردّ إيصال N):
 * لكل حصّة قبضٍ مطبَّقة إيصال OUT بطريقة قبضها + قيد PAYMENT_OUT + صفّ REFUND مربوط بأمّه.
 * النقد من درج الفرع بفحص كفايةٍ تراكميّ (نفس ضابط ردّ N في cancel.ts).
 */
export async function refundAppliedCollectionsForWorkOrder(
  tx: Tx,
  args: { workOrderId: number; branchId: number; customerId: number | null; actor: Actor; refundShiftId?: number | null },
) {
  const parts = await appliedCollectionsForWorkOrder(tx, args.workOrderId);
  if (!parts.length) return { refunded: "0.00" };
  let cashShift: { shiftId: number; openingBalance: string } | null = null;
  let cashOutSoFar = money(0);
  let total = money(0);
  for (const part of parts) {
    const amountD = round2(money(part.amount));
    if (amountD.lte(0)) continue;
    let shiftId: number | null;
    if (part.method === "CASH") {
      if (!cashShift) {
        const resolved = await resolveBranchCashShiftTx(tx, args.branchId, args.refundShiftId ?? null);
        cashShift = { shiftId: resolved.shiftId, openingBalance: resolved.openingBalance };
      }
      shiftId = cashShift.shiftId;
      const drawer = await computeExpectedCash(tx, shiftId, cashShift.openingBalance);
      if (amountD.plus(cashOutSoFar).gt(drawer)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `ردّ عربون الطلب يتجاوز النقد المتوفّر في الدرج (المتاح ${drawer.minus(cashOutSoFar).toFixed(2)} < المطلوب ${amountD.toFixed(2)})`,
        });
      }
      cashOutSoFar = cashOutSoFar.plus(amountD);
    } else {
      shiftId = await openShiftIdTx(tx, args.actor.userId, args.branchId, "RECEPTION");
    }
    const rRes = await tx.insert(receipts).values({
      branchId: args.branchId,
      shiftId,
      workOrderId: args.workOrderId,
      direction: "OUT",
      amount: toDbMoney(amountD),
      paymentMethod: part.method,
      cashBucket: part.method === "CASH" ? "DRAWER" : null,
      status: "COMPLETED",
      referenceNumber: `WO-CANCEL-REFUND-${args.workOrderId}`,
      description: `ردّ حصّة عربونٍ مقبوضةٍ سلفاً — إلغاء طلب #${args.workOrderId}`,
      createdBy: args.actor.userId,
    });
    const refundReceiptId = extractInsertId(rRes);
    // عميل ساقَي الردّ = عميل القبض الأمّ (لا عميل أمر الشغل) — تناظرٌ بنيويّ مهما تغيّر الربط.
    await postEntry(tx, {
      entryType: "PAYMENT_OUT",
      branchId: args.branchId,
      receiptId: refundReceiptId,
      customerId: part.customerId ?? args.customerId,
      amount: amountD,
      notes: `استرداد حصّة عربون مقبوضةٍ سلفاً — إلغاء طلب #${args.workOrderId}`,
    });
    if (part.draftId != null) {
      await tx.insert(orderPayments).values({
        draftId: part.draftId,
        branchId: args.branchId,
        customerId: part.customerId ?? args.customerId,
        kind: "REFUND",
        amount: toDbMoney(amountD),
        method: part.method,
        receiptId: refundReceiptId,
        shiftId,
        parentPaymentId: part.collectionId,
        createdBy: args.actor.userId,
      });
    }
    total = total.plus(amountD);
  }
  return { refunded: toDbMoney(round2(total)) };
}

/** ربط إيصالات P أحاديّة الهدف بفاتورة تسليم أمر الشغل (نمط deliver.ts:161-185 حرفياً). */
export async function linkSoleTargetCollectionsToInvoice(tx: Tx, workOrderId: number, invoiceId: number) {
  const parts = await appliedCollectionsForWorkOrder(tx, workOrderId);
  for (const part of parts) {
    if (!part.soleTarget || part.receiptId == null) continue;
    await tx
      .update(receipts)
      .set({ invoiceId })
      .where(and(eq(receipts.id, part.receiptId), sql`${receipts.invoiceId} IS NULL`));
  }
}

/** إجمالي المحتجز غير المُثبَّت المقبوض على وردية (سطر إفصاح Z — I14). */
export async function heldDepositsOfShift(tx: Tx, shiftId: number) {
  // دلالة **الدرج** لا دلالة المسوّدة (مراجعة ش٤): تُطرح ردودُ **هذه الوردية نفسها** فقط —
  // ردٌّ لاحقٌ من درجِ ورديةٍ أخرى يخصّ درجَها هي، وطرحُه هنا كان يحوّر Z المؤرشف رجعياً
  // فيفقد تفسير فائض الدرج التاريخيّ. ولنفس السبب يُضمّ REFUNDED (قُبض على هذا الدرج فعلاً؛
  // ردودُه على هذا الدرج تُطرح بالقيد فيبقى الصافي صادقاً). APPLIED خارجٌ — تفسيرُه سطر
  // فواتير التثبيت على وردية التثبيت.
  const res = await tx.execute(sql`
    SELECT COUNT(DISTINCT op.draftId) AS c,
           CAST(COALESCE(SUM(op.amount - COALESCE(rf.s, 0)), 0) AS CHAR) AS t
    FROM ${orderPayments} op
    LEFT JOIN (
      SELECT parentPaymentId, SUM(amount) AS s
      FROM ${orderPayments}
      WHERE orderPayKind = 'REFUND' AND shiftId = ${shiftId}
      GROUP BY parentPaymentId
    ) rf ON rf.parentPaymentId = op.id
    WHERE op.shiftId = ${shiftId} AND op.orderPayKind = 'COLLECTION' AND op.orderPayStatus IN ('HELD','REFUNDED')
  `);
  const data = (res as unknown as [Array<{ c: number | string; t: string }>])[0] ?? res;
  const row = Array.isArray(data) ? data[0] : undefined;
  return { count: Number(row?.c ?? 0), total: String(row?.t ?? "0.00") };
}

/** أوامر الشغل المرتبطة بمسوّدة عبر تطبيقاتها — لرسالة الإلغاء المديريّ التي تسمّي البنود. */
export async function draftHasWorkOrderApplications(tx: Tx, draftId: number) {
  const rows = await tx
    .select({ appliedId: orderPayments.appliedId })
    .from(orderPayments)
    .where(
      and(eq(orderPayments.draftId, draftId), eq(orderPayments.kind, "APPLICATION"), eq(orderPayments.appliedKind, "WORKORDER")),
    );
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.appliedId));
  const wos = await tx
    .select({ id: workOrders.id, orderNumber: workOrders.orderNumber })
    .from(workOrders)
    .where(inArray(workOrders.id, ids));
  return wos.map((w) => ({ id: Number(w.id), orderNumber: String(w.orderNumber) }));
}
