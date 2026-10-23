// السداد الكاونتريّ على إرسالية **ثبت تسليمُها** — يفكّ فخّ «متبقٍّ بلا مدخل نقدي» (٢٢/٨).
//
// السياق: طردٌ وصل العميل فعلاً (كشف شركةٍ بتحصيلٍ جزئيّ، أو ختمُ تسليمٍ مستنديّ) ثم جاء
// الزبون للمحلّ يسدّد الباقي. القبض نفسه يجري في معاملة processPayment (إيصال درج + قيد
// PAYMENT_IN + ذمّة العميل) — لكنّ الإرسالية كانت عمياء عنه: `codAmount − collectedAmount`
// يبقى كاملاً فيُطالَب المندوب/الشركة بتوريد نقدٍ لم يمرّ بيدهم قطّ، أو يزدوج تحصيل نفس
// الدينار من البابين. هذه الدالة تُدوّن السداد على الإرسالية **داخل نفس معاملة القبض**:
//   المتبقّي الحيّ للإرسالية = codAmount − collectedAmount − counterSettledAmount.
//
// ما لا تفعله عمداً: لا تمسّ عهدة الجهة (`deliveryParties.currentBalance`) ولا تكتب
// COD_COLLECTED — النقد دخل الدرج مباشرةً ولم يمرّ بيد الجهة، فالقيد الدفتريّ الصحيح هو
// COD_RELEASED (تحرير تعرّضٍ متوقَّع، نفس اصطلاح الإلغاء والرجوع المُعلَن).
import { effectiveDeliveryLedgerEntrySql } from "./legacyLedger";
import Decimal from "decimal.js";
import { and, eq, inArray, sql, or, isNotNull } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryLedgerEntries,
  receipts,
  invoices,
  deliveryShipmentMembers,
} from "../../../drizzle/schema";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { assertNotReturnDeclared } from "./declaredReturn";
import {
  appendDeliveryEvent,
  appendDeliveryLedgerEntry,
  assertConsignmentStatusTransition,
} from "./lifecycle";
import {
  assertCounterCollectionPrelocked,
  hasFulfillmentCounterContractTx,
} from "./guards";

export interface CounterCollectionInput {
  invoiceId: number;
  /** ما طُبِّق فعلاً على الفاتورة في هذه المعاملة (سقفه متبقّي الفاتورة، تحقّق قبل النداء). */
  amount: Decimal | string;
  actorUserId: number;
  /**
   * مفتاح العملية المشتقّ من idempotency القبض القائم في المسار المستدعي — يُبنى منه
   * `eventKey` فريد (`CN:{id}:COUNTER:{refKey}`) فلا يُدوَّن نفس القبض مرّتين عند الإعادة.
   */
  refKey: string;
  receiptId?: number;
  receiptIds?: number[];
}

export interface CounterCollectionResult {
  consignmentId: number;
  /** ما دُوِّن على الإرسالية (قد يقلّ عن `amount` إن كان متبقّيها الحيّ أصغر). */
  applied: string;
  /** المتبقّي الحيّ بعد التدوين. */
  liveRemaining: string;
  /** أُغلقت الإرسالية نهائياً (لا شيء يُورَّد). */
  closed: boolean;
  claimVersion?: number;
  notice?: string;
}

/**
 * يُدوّن سداداً كاونترياً على الإرسالية الحيّة للفاتورة — يُستدعى **داخل** معاملة القبض
 * (نفس tx) بعد التحقّق من سقف المبلغ على الفاتورة؛ أيّ فشلٍ لاحق في المعاملة يعكس التدوين
 * والقبض معاً (ذرّية كاملة).
 *
 * يعود `null` بصمت حين لا شيء يُدوَّن: لا كلّ فاتورةٍ لها إرسالية، ولا كلّ إرساليةٍ
 * بحالةٍ تعنيها الدفعة — والقبض على الفاتورة مشروعٌ في الحالتين (حارس «بالطريق» في
 * guards.ts هو من يرفض ما يجب رفضه قبل الوصول هنا).
 *
 * processPayment يسبق قفل الفاتورة بقفل الجهة والإرسالية، ويستدعي هذا الكاتب بعد
 * الإيصالات الفعلية. المسار القديم يبقى للطرد المسلم فقط؛ طلب التجهيز الموثق يسمح
 * أيضاً بالقبض أثناء الطريق مع تخفيض التعرض ورفع نسخة مطالبة الناقل، دون ختم تسليم وهمي.
 */
export async function registerCounterCollectionTx(
  tx: Tx,
  input: CounterCollectionInput,
): Promise<CounterCollectionResult | null> {
  // قراءة استرشادية بلا قفل: أغلب الدفعات لفواتير بلا إرسالية إطلاقاً — لا نلمس أقفال
  // جدول الإرساليات لها أبداً (تحاشي تشابكٍ مجانيّ مع confirm/remittance تحت الحمل).
  const candidate = (
    await tx
      .select({ id: deliveryConsignments.id })
      .from(deliveryConsignments)
      .where(
        and(
          eq(deliveryConsignments.invoiceId, input.invoiceId),
          inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
          or(
            eq(deliveryConsignments.parcelStatus, "DELIVERED"),
            and(
              isNotNull(deliveryConsignments.fulfillmentRequestId),
              inArray(deliveryConsignments.parcelStatus, [
                "ASSIGNED",
                "ACCEPTED",
                "PICKED_UP",
                "OUT_FOR_DELIVERY",
                "FAILED",
              ]),
            ),
          ),
        ),
      )
      .limit(1)
  )[0];
  if (!candidate) return null;

  // القفل بالمفتاح الأوّليّ ثم **إعادة فحص الأهلية تحت القفل**: بين القراءتين قد يكون
  // توريدٌ متزامن أغلقها (صارت DELIVERED/SETTLED) — عندها لا شيء يُدوَّن، والقبض على
  // الفاتورة يبقى سليماً (سقفه متبقّي الفاتورة المقفول في processPayment).
  const cn = (
    await tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, Number(candidate.id)))
      .for("update")
      .limit(1)
  )[0];
  if (
    !cn ||
    (cn.status !== "DISPATCHED" && cn.status !== "PARTIAL") ||
    ![
      "DELIVERED",
      "ASSIGNED",
      "ACCEPTED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "FAILED",
    ].includes(cn.parcelStatus)
  ) {
    return null;
  }
  const fulfillment = await hasFulfillmentCounterContractTx(tx, cn);
  if (fulfillment) {
    const [invoice] = await tx
      .select({ paymentMode: invoices.paymentMode })
      .from(invoices)
      .where(eq(invoices.id, input.invoiceId))
      .limit(1);
    // Approved credit debt was never courier goods COD; paying it cannot release a charge claim.
    if (invoice?.paymentMode === "CREDIT") return null;
  }
  if (fulfillment) {
    const ids =
      input.receiptIds ?? (input.receiptId != null ? [input.receiptId] : []);
    const evidence = ids.length
      ? await tx
          .select()
          .from(receipts)
          .where(inArray(receipts.id, ids))
          .for("share")
      : [];
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      evidence.length !== ids.length ||
      evidence.some(
        (r) =>
          r.invoiceId !== input.invoiceId ||
          r.branchId !== cn.branchId ||
          r.direction !== "IN" ||
          r.status !== "COMPLETED" ||
          r.createdBy !== input.actorUserId,
      ) ||
      !evidence
        .reduce((sum, r) => sum.plus(r.amount), money(0))
        .eq(input.amount)
    )
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذر تخفيض مطالبة الناقل",
          why: "إيصالات التحصيل الفعلية لا تطابق الفاتورة والمبلغ والفرع",
          doThis:
            "أعد المحاولة من شاشة تحصيل الفاتورة بإثبات الدفع الأصلي؛ لا تسجل قبضاً أو تحرير عهدة يدوياً",
        }),
      });
  }
  if (cn.parcelStatus !== "DELIVERED") {
    if (!fulfillment) return null;
    assertCounterCollectionPrelocked(tx, input.invoiceId, cn);
  }

  // رجوعٌ مُعلَن = تعرّضُ الإرسالية حُرِّر سلفاً (COD_RELEASED:DECLARED_RETURN) — تدوينُ
  // قبضٍ فوقه يحرّر نفس التعرّض مرّتين ويجعل الاسترجاع الفعليّ متعذّراً. حالةٌ متناقضة
  // (طردٌ «مُسلَّم» و«راجع» معاً) تُرفض بصوتٍ عالٍ لا تخطٍّ صامت — قرارها للمدير.
  assertNotReturnDeclared(cn, "collect");

  // idempotency على refKey: الفهرس الفريد على eventKey هو الإنفاذ النهائيّ، والفحص الصريح
  // هنا يجعل الإعادة no-op هادئاً بدل إسقاط معاملة القبض كلّها بـER_DUP_ENTRY.
  const eventKey = `CN:${Number(cn.id)}:COUNTER:${input.refKey}`;
  const already = (
    await tx
      .select({ id: deliveryEvents.id })
      .from(deliveryEvents)
      .where(eq(deliveryEvents.eventKey, eventKey))
      .limit(1)
  )[0];
  if (already) return null;

  const liveRemainingBefore = round2(
    money(cn.codAmount)
      .minus(money(cn.collectedAmount ?? "0"))
      .minus(money(cn.counterSettledAmount ?? "0")),
  );
  // مقصوصٌ عند الصفر من الجهتين: انحرافٌ تاريخيّ قد يجعل المتبقّي سالباً، ودفعةٌ قد تفوقه
  // (جزءٌ منها يسدّد ما ليس على الإرسالية — مشروعٌ على الفاتورة، لا شأن للإرسالية به).
  const applied = Decimal.min(
    round2(money(input.amount)),
    Decimal.max(liveRemainingBefore, 0),
  );
  if (applied.lte(0)) return null;

  const newCounterSettled = round2(
    money(cn.counterSettledAmount ?? "0").plus(applied),
  );
  const liveRemaining = round2(liveRemainingBefore.minus(applied));

  /**
   * **عهدةُ التحصيل المعلّقة = مُحصَّلٌ لم يُورَّد بعد** (Codex P2 #8 — ٢٢/٨): كان الشرط يمنع
   * الإغلاق ما دام `collectedAmount>0` — لكن `collectedAmount` عمودُ **تاريخٍ تراكميّ** لا
   * يُمحى بعد التوريد الجزئيّ. النتيجة: كشفٌ يُحصّل 12k من 20k ⇒ الشركة تورّد الـ12k ⇒
   * `collectedAmount` يبقى 12k (تاريخ) والعهدةُ الفعليّة صفرٌ. يأتي الزبونُ ويسدّد الـ8k
   * بالكاونتر ⇒ الشرطُ القديم يُبقي الطردَ زومبي في طابور التوريد بلا شيءٍ يُورَّد.
   *
   * الإصلاح: قياسُ النقد من الدفتر الذي يكذّبه الواقعُ لا الصفوف التاريخيّة:
   * `COD_COLLECTED − (COD_REMITTED + COD_RETURNED + COD_WRITTEN_OFF)` لهذه الإرسالية.
   */
  const custodyRow = (
    await tx
      .select({
        pending: sql<string>`COALESCE(SUM(CASE
          WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount}
          WHEN ${deliveryLedgerEntries.entryType} IN ('COD_REMITTED','COD_RETURNED','COD_WRITTEN_OFF') THEN -${deliveryLedgerEntries.amount}
          ELSE 0 END), 0)`,
      })
      .from(deliveryLedgerEntries)
      .where(
        and(
          eq(deliveryLedgerEntries.consignmentId, Number(cn.id)),
          effectiveDeliveryLedgerEntrySql(),
        ),
      )
  )[0];
  const pendingCustody = round2(money(custodyRow?.pending ?? "0"));
  const noPendingCustody = pendingCustody.lte(0);
  const close =
    cn.parcelStatus === "DELIVERED" &&
    liveRemaining.isZero() &&
    noPendingCustody;
  if (close) assertConsignmentStatusTransition(cn.status, "DELIVERED");

  await tx
    .update(deliveryConsignments)
    .set({
      counterSettledAmount: toDbMoney(newCounterSettled),
      ...(fulfillment
        ? {
            codClaimVersion: cn.codClaimVersion + 1,
            ...(!close && liveRemaining.isZero() && noPendingCustody
              ? { moneyStatus: "NOT_APPLICABLE" as const }
              : {}),
          }
        : {}),
      ...(close
        ? {
            status: "DELIVERED" as const,
            moneyStatus: "SETTLED" as const,
            settledAt: new Date(),
          }
        : {}),
    })
    .where(eq(deliveryConsignments.id, Number(cn.id)));

  // COD_RELEASED لا COD_COLLECTED: تحريرُ تعرّضٍ بلا مساس عهدة — النقد لم يمرّ بيد الجهة،
  // فمعادلة العهدة (collected − remitted − writtenOff) لا تتحرّك، ومعادلة التعرّض
  // (assigned − collected − released) تنخفض بما سُدّد.
  await appendDeliveryLedgerEntry(tx, {
    eventKey,
    partyId: Number(cn.partyId),
    consignmentId: Number(cn.id),
    branchId: Number(cn.branchId),
    entryType: "COD_RELEASED",
    amount: toDbMoney(applied),
    actorUserId: input.actorUserId,
    notes: `سداد كاونتري ${cn.parcelStatus === "DELIVERED" ? "بعد ثبوت التسليم" : "أثناء الطريق بطلب تجهيز موثق"} ${cn.consignmentNumber}`,
  });
  await appendDeliveryEvent(tx, {
    eventKey,
    consignmentId: Number(cn.id),
    eventType: "COUNTER_SETTLED",
    fromParcelStatus: cn.parcelStatus,
    toParcelStatus: cn.parcelStatus,
    fromMoneyStatus: cn.moneyStatus,
    toMoneyStatus: close
      ? "SETTLED"
      : fulfillment && liveRemaining.isZero() && noPendingCustody
        ? "NOT_APPLICABLE"
        : cn.moneyStatus,
    actorUserId: input.actorUserId,
    // مصدر السلطة يُدوَّن دائماً (نمط COMPANY_STATEMENT/COURIER_PORTAL): هذا المال دخل
    // من الكاونتر بإيصال درجٍ في نفس المعاملة — refKey يصله بمفتاح قبضه.
    payload: {
      source: "COUNTER",
      amount: toDbMoney(applied),
      refKey: input.refKey,
    },
  });
  let acknowledgementCnId = cn.id;
  let acknowledgementVersion = cn.codClaimVersion + 1;
  if (fulfillment) {
    const [membership] = await tx
      .select({ leaderId: deliveryShipmentMembers.leaderConsignmentId })
      .from(deliveryShipmentMembers)
      .where(eq(deliveryShipmentMembers.consignmentId, cn.id))
      .limit(1);
    if (membership && membership.leaderId !== cn.id) {
      const [leader] = await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, membership.leaderId))
        .for("update")
        .limit(1);
      if (
        !leader ||
        leader.partyId !== cn.partyId ||
        leader.branchId !== cn.branchId ||
        leader.fulfillmentRequestId !== cn.fulfillmentRequestId
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذر تحديث مطالبة الشحنة",
            why: "قائد الشحنة لا يطابق مستند التجهيز والجهة والفرع",
            doThis:
              "حدّث الشحنة وراجع روابط أعضائها مع المسؤول قبل إعادة التحصيل",
          }),
        });
      acknowledgementCnId = leader.id;
      acknowledgementVersion = leader.codClaimVersion + 1;
      await tx
        .update(deliveryConsignments)
        .set({ codClaimVersion: acknowledgementVersion })
        .where(eq(deliveryConsignments.id, leader.id));
    }
    await appendDeliveryEvent(tx, {
      eventKey: `${eventKey}:CLAIM_CHANGED`,
      consignmentId: acknowledgementCnId,
      eventType: "COD_CLAIM_CHANGED",
      actorUserId: input.actorUserId,
      payload: {
        invoiceId: input.invoiceId,
        receiptId: input.receiptId,
        claimVersion: acknowledgementVersion,
        ackRequired: true,
      },
    });
  }

  return {
    consignmentId: Number(cn.id),
    applied: toDbMoney(applied),
    liveRemaining: toDbMoney(liveRemaining),
    closed: close,
    ...(fulfillment
      ? {
          claimVersion: acknowledgementVersion,
          notice:
            "ثبت القبض في المكتبة وتغير مبلغ مطالبة الناقل؛ على الناقل الإقرار بالنسخة الجديدة قبل التحصيل.",
        }
      : {}),
  };
}
