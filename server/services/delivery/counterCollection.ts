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
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryEvents, deliveryLedgerEntries } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import { assertNotReturnDeclared } from "./declaredReturn";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";

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
}

export interface CounterCollectionResult {
  consignmentId: number;
  /** ما دُوِّن على الإرسالية (قد يقلّ عن `amount` إن كان متبقّيها الحيّ أصغر). */
  applied: string;
  /** المتبقّي الحيّ بعد التدوين. */
  liveRemaining: string;
  /** أُغلقت الإرسالية نهائياً (لا شيء يُورَّد). */
  closed: boolean;
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
 * ⚠️ ترتيب الأقفال: معاملة القبض تحمل قفل الفاتورة أولاً ثم تقفل الإرسالية هنا — عكس
 * مسارات التوصيل (جهة←إرسالية←فاتورة). لتضييق النافذة نقرأ بلا قفلٍ أولاً ولا نقفل إلا
 * صفاً مؤهّلاً فعلاً (طردٌ مُسلَّم = المؤكِّد التزم وحرّر أقفاله)؛ وتصادمٌ متبقٍّ مع توريدٍ
 * متزامن يحسمه كاشف deadlock بإعادة محاولةٍ أعلى (retryOnDeadlock في مسار الاستقبال).
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
          eq(deliveryConsignments.parcelStatus, "DELIVERED"),
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
    cn.parcelStatus !== "DELIVERED"
  ) {
    return null;
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
  const applied = Decimal.min(round2(money(input.amount)), Decimal.max(liveRemainingBefore, 0));
  if (applied.lte(0)) return null;

  const newCounterSettled = round2(money(cn.counterSettledAmount ?? "0").plus(applied));
  const liveRemaining = round2(liveRemainingBefore.minus(applied));

  /**
   * **عهدةُ التحصيل المعلّقة = مُحصَّلٌ لم يُورَّد بعد** (Codex P2 #8 — ٢٢/٨): كان الشرط يمنع
   * الإغلاق ما دام `collectedAmount>0` — لكن `collectedAmount` عمودُ **تاريخٍ تراكميّ** لا
   * يُمحى بعد التوريد الجزئيّ. النتيجة: كشفٌ يُحصّل 12k من 20k ⇒ الشركة تورّد الـ12k ⇒
   * `collectedAmount` يبقى 12k (تاريخ) والعهدةُ الفعليّة صفرٌ. يأتي الزبونُ ويسدّد الـ8k
   * بالكاونتر ⇒ الشرطُ القديم يُبقي الطردَ زومبي في طابور التوريد بلا شيءٍ يُورَّد.
   *
   * الإصلاح: قياسُ العهدة من الدفتر الذي يكذّبه الواقعُ لا الصفوف التاريخيّة: `COD_COLLECTED − (COD_REMITTED + COD_WRITTEN_OFF)` لهذه الإرسالية = عهدةٌ حيّةٌ بيد الجهة. صفرٌ ⇒ لا شيء يُورَّد ⇒ إغلاقٌ آمن.
   */
  const custodyRow = (
    await tx
      .select({
        pending: sql<string>`COALESCE(SUM(CASE
          WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount}
          WHEN ${deliveryLedgerEntries.entryType} IN ('COD_REMITTED','COD_WRITTEN_OFF') THEN -${deliveryLedgerEntries.amount}
          ELSE 0 END), 0)`,
      })
      .from(deliveryLedgerEntries)
      .where(eq(deliveryLedgerEntries.consignmentId, Number(cn.id)))
  )[0];
  const pendingCustody = round2(money(custodyRow?.pending ?? "0"));
  const noPendingCustody = pendingCustody.lte(0);
  const close = liveRemaining.isZero() && noPendingCustody;

  await tx
    .update(deliveryConsignments)
    .set({
      counterSettledAmount: toDbMoney(newCounterSettled),
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
    notes: `سداد كاونتري بعد ثبوت التسليم ${cn.consignmentNumber}`,
  });
  await appendDeliveryEvent(tx, {
    eventKey,
    consignmentId: Number(cn.id),
    eventType: "COUNTER_SETTLED",
    fromParcelStatus: cn.parcelStatus,
    toParcelStatus: cn.parcelStatus,
    fromMoneyStatus: cn.moneyStatus,
    toMoneyStatus: close ? "SETTLED" : cn.moneyStatus,
    actorUserId: input.actorUserId,
    // مصدر السلطة يُدوَّن دائماً (نمط COMPANY_STATEMENT/COURIER_PORTAL): هذا المال دخل
    // من الكاونتر بإيصال درجٍ في نفس المعاملة — refKey يصله بمفتاح قبضه.
    payload: { source: "COUNTER", amount: toDbMoney(applied), refKey: input.refKey },
  });

  return {
    consignmentId: Number(cn.id),
    applied: toDbMoney(applied),
    liveRemaining: toDbMoney(liveRemaining),
    closed: close,
  };
}
