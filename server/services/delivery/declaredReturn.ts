/**
 * **المرتجعُ المُعلَن** — إغلاقُ توقّع التحصيل قبل وصول الطرد (٢١/٨).
 *
 * شركةُ التوصيل تُعلن أنّ طرداً راجعٌ إلينا قبل أن يصل بأيّام. وحتى الآن لم يكن ثمّة إلّا
 * [`returnConsignment`](./returns.ts) — وهي لحظةُ **الاستلام**: تُعيد المخزون بحركةِ IN،
 * وتُرجع الفاتورة، وتردّ العربون، وتُغلق أمر الشغل. فالموظّف أمام خيارَين كلاهما خطأ:
 *
 *  · **يُشغّلها عند الإعلان** ⇒ يعود للمخزون صنفٌ **لم يصل ولم يُفحَص** — بضاعةٌ تُحسَب
 *    موجودةً وقد تكون تالفةً أو ضائعةً، فتُباع وهي ليست في الرفّ.
 *  · **ينتظر الوصول** ⇒ يبقى الطردُ في «قيد التوصيل» بتعرّضِ تحصيلٍ على الجهة أسابيع،
 *    فتكذب أعمارُ الطرود وتقاريرُ التعرّض.
 *
 * فالإعلانُ هنا يفعل **شيئاً واحداً**: يُحرّر التعرّض التشغيليّ ويَسِم الطرد. ولا يمسّ
 * مخزوناً ولا فاتورةً ولا عربوناً ولا أمرَ شغل — تلك كلُّها للاستلام والفحص.
 *
 * ⚠️ **ولماذا حارسٌ صريحٌ على الازدواج:** `deliveryLedgerEntries.eventKey` **بلا فهرسٍ
 * فريد** في المخطّط — فهو توثيقٌ لا إنفاذ، وإدراجُ نفس المفتاح مرّتين يُحرّر التعرّض
 * **مرّتين** بلا أيّ خطأ. لذلك يمتنع الإعلانُ عن التكرار بـ`returnDeclaredAt`، ويمتنع
 * `returnConsignment` عن إعادة التحرير حين يجده مُعلَناً.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { deliveryConsignments, deliveryParties } from "../../../drizzle/schema";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { adjustDeliveryBalance } from "../ledgerService";
import { withTx } from "../tx";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import type { DeliveryTxActor } from "./types";

/**
 * **الرجوعُ المُعلَن يُغلق كلَّ مخرجٍ إلّا الاسترجاع** (تصويب مراجعة Codex، ٢١/٨).
 *
 * وسمُ الإعلان أعمدةٌ إضافيةٌ لا قيمةُ `parcelStatus` — وهو الصواب (القيمةُ الجديدة تُعمي
 * عشرات الحرّاس صامتاً)، لكنّ ثمنَه أنّ الحرّاس القائمة **لا تراه**، فيبقى الطردُ مقبولاً في:
 *
 *  · `cancelDeliveryAssignment` — يقبل ASSIGNED/FAILED ويكتب `COD_RELEASED` **ثانياً**
 *    (ولا فهرسَ فريد على `eventKey` يمنعه) ⇒ تحريرٌ مزدوجٌ ورصيدٌ دائنٌ وهميّ للجهة.
 *  · تأكيدُ التسليم (بوّابة المندوب أو كشف الشركة) — يُسجّل تحصيلاً على طردٍ حُرِّر تعرّضُه
 *    ⇒ متبقٍّ سالبٌ، ويصير الاسترجاعُ الفعليّ لاحقاً متعذّراً لأنّ مالاً قُبض.
 *
 * فالمخرجُ الوحيد من الحالة المُعلَنة هو **الاسترجاع بعد الاستلام** — وهو مفتوحٌ دائماً،
 * فلا طريقَ مسدود.
 */
export function assertNotReturnDeclared(
  cn: { returnDeclaredAt?: Date | null; consignmentNumber?: string | null },
  action: "cancel" | "deliver" | "collect",
): void {
  if (cn.returnDeclaredAt == null) return;
  const what = action === "cancel"
    ? "لا يُلغى إسنادُ طردٍ أُعلن رجوعُه"
    : action === "deliver"
      ? "لا يُختَم تسليمُ طردٍ أُعلن رجوعُه"
      : "لا يُسجَّل تحصيلٌ على طردٍ أُعلن رجوعُه";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${what} (${cn.consignmentNumber ?? ""}) — تعرّضُه حُرِّر سلفاً؛ أكمِل الاسترجاع بعد استلامه وفحصه.`,
  });
}

export interface DeclareReturnInput {
  consignmentId: number;
  /** سببُ الرجوع — إلزاميّ: «رفض العميل» و«العنوان خاطئ» قراراتُ متابعةٍ مختلفة. */
  reason: string;
  /** رقمُ كشف الشركة الذي أُعلن فيه الرجوع (توثيقيّ). */
  statementNumber?: string | null;
  clientRequestId?: string | null;
}

/** يضمّ السبب ورقم الكشف ضمن حدّ العمود (500) — الرقمُ يُصان والسببُ يُقتطع إن لزم. */
function buildDeclarationNote(reason: string, statementNumber?: string | null): string {
  const stmt = statementNumber?.trim();
  if (!stmt) return reason.slice(0, 500);
  const suffix = ` (كشف ${stmt})`;
  return `${reason.slice(0, Math.max(0, 500 - suffix.length))}${suffix}`;
}

export async function declareConsignmentReturn(input: DeclareReturnInput, actor: DeliveryTxActor) {
  return withTx(async (tx) => {
    const consignmentId = Number(input.consignmentId);
    const reason = input.reason.trim();
    if (reason.length < 3) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سبب رجوع الطرد مطلوب (٣ أحرف على الأقل)" });
    }

    const payloadHash = idempotencyHash({ consignmentId, reason });
    if (input.clientRequestId) {
      const existing = await checkIdempotency(tx, "delivery.declareReturn", input.clientRequestId, payloadHash);
      if (existing != null) {
        if (Number(existing) !== consignmentId) {
          throw new TRPCError({ code: "CONFLICT", message: "مفتاح الإعلان مرتبط بإرسالية أخرى" });
        }
        return { consignmentId, declared: true as const, idempotentReplay: true as const };
      }
    }

    const cn = (
      await tx.select().from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, consignmentId)).for("update").limit(1)
    )[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });

    // **إعادةُ الفحص بعد القفل** (تصويب مراجعة Codex): طلبان متزامنان بنفس المفتاح يمرّان
    // كلاهما من الفحص الأوّل قبل أن يُسجّله أحدهما، ثمّ يتسلسلان على هذا القفل. بلا إعادة
    // الفحص هنا يسقط الثاني على حارس `returnDeclaredAt` بـCONFLICT — أي أنّ **تكراراً
    // عادياً لطلبٍ ناجح يُبلَّغ خطأً** بدل الإعادة الصامتة الموعودة. (نفس نمط الإلغاء.)
    if (input.clientRequestId) {
      const afterLock = await checkIdempotency(tx, "delivery.declareReturn", input.clientRequestId, payloadHash);
      if (afterLock != null) {
        return { consignmentId, declared: true as const, idempotentReplay: true as const };
      }
    }

    // عزلُ الفرع — نفس حارس `returnConsignment` حرفياً (الأدمن وحده يعبُر الفروع).
    const scopedBranch = actor.role === "admin" ? null : (actor.branchId ?? null);
    if (scopedBranch != null && Number(cn.branchId) !== scopedBranch) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخصّ فرعاً آخر" });
    }

    if (cn.returnDeclaredAt != null) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `رجوعُ ${cn.consignmentNumber} مُعلَنٌ سلفاً — بانتظار الاستلام والفحص`,
      });
    }
    if (cn.status !== "DISPATCHED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الإرسالية ${cn.consignmentNumber} ليست بالطريق — لا يُعلَن رجوعُ طردٍ غير مُرسَل`,
      });
    }
    if (cn.parcelStatus === "RETURNED" || cn.parcelStatus === "CANCELLED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الطرد مُرجَعٌ أو ملغىً سلفاً" });
    }
    // ⛔ طردٌ حُصِّل منه مال ليس رجوعاً نظيفاً: تحريرُ تعرّضه يُخفي نقداً بيد الجهة بلا مطالبة.
    // مسارُه الاسترجاعُ الكامل الذي يعرف كيف يردّ ما قُبض.
    const collected = round2(money(cn.collectedAmount ?? "0"));
    if (collected.gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `حُصِّل ${collected.toFixed(2)} على هذه الإرسالية — استعمل الاسترجاع الكامل لا الإعلان`,
      });
    }

    // تحريرُ التعرّض التشغيليّ — نفس معادلة `returnConsignment` بالضبط كي لا ينحرف الطرفان.
    const outstanding = round2(money(cn.codAmount ?? "0").minus(collected));
    if (outstanding.gt(0)) {
      const party = (
        await tx.select({ currentBalance: deliveryParties.currentBalance })
          .from(deliveryParties).where(eq(deliveryParties.id, Number(cn.partyId))).for("update").limit(1)
      )[0];
      const cachedCustody = money(party?.currentBalance ?? "0");
      // الصفوفُ المرحّلة وحدها تحمل عهدةً نقديةً مسجَّلةً في `currentBalance`؛ نعكس منها ما
      // بقي فعلاً ثمّ نحرّر الباقي تعرّضاً غير محصَّل — فتبقى معادلتا العهدة والتعرّض متوازنتين.
      const legacyCustody = cn.custodyRecognizedAt == null
        ? money(0)
        : round2(outstanding.lt(cachedCustody) ? outstanding : cachedCustody);
      if (legacyCustody.gt(0)) {
        await adjustDeliveryBalance(tx, Number(cn.partyId), legacyCustody.neg());
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${consignmentId}:COD_REMITTED:LEGACY_DECLARED_RETURN`,
          partyId: Number(cn.partyId),
          consignmentId,
          branchId: Number(cn.branchId),
          entryType: "COD_REMITTED",
          amount: toDbMoney(legacyCustody),
          actorUserId: actor.userId,
          notes: `عكس عهدة مرحّلة بعد إعلان رجوع ${cn.consignmentNumber}`,
        });
      }
      const exposureToRelease = round2(outstanding.minus(legacyCustody));
      if (exposureToRelease.gt(0)) {
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${consignmentId}:COD_RELEASED:DECLARED_RETURN`,
          partyId: Number(cn.partyId),
          consignmentId,
          branchId: Number(cn.branchId),
          entryType: "COD_RELEASED",
          amount: toDbMoney(exposureToRelease),
          actorUserId: actor.userId,
          notes: `تحرير تحصيل متوقع بعد إعلان رجوع ${cn.consignmentNumber}`,
        });
      }
    }

    await tx.update(deliveryConsignments).set({
      returnDeclaredAt: new Date(),
      returnDeclaredBy: actor.userId,
      // العمودُ `varchar(500)`: السببُ وحده قد يبلغ ٥٠٠، وضمُّ رقم الكشف إليه يتجاوزه ⇒
      // `Data too long` تحت الوضع الصارم، أو بترٌ صامتٌ للنصّ التدقيقيّ تحت المتساهل.
      // نقتطع **بحدود العمود** ونُبقي رقم الكشف (وهو الأقصر والأهمّ للربط بالمستند).
      returnDeclaredReason: buildDeclarationNote(reason, input.statementNumber),
    }).where(eq(deliveryConsignments.id, consignmentId));

    await appendDeliveryEvent(tx, {
      eventKey: `CN:${consignmentId}:RETURN_DECLARED:${input.clientRequestId ?? Date.now()}`,
      consignmentId,
      eventType: "RETURN_DECLARED",
      fromParcelStatus: cn.parcelStatus,
      // ⛔ الحالةُ لا تتغيّر: الطردُ ما زال بالطريق فعلاً حتى يصل.
      toParcelStatus: cn.parcelStatus,
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: cn.moneyStatus,
      actorUserId: actor.userId,
      payload: {
        reason,
        statementNumber: input.statementNumber?.trim() || null,
        releasedExposure: toDbMoney(outstanding),
      },
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "delivery.declareReturn", input.clientRequestId, consignmentId, payloadHash);
    }

    return {
      consignmentId,
      consignmentNumber: cn.consignmentNumber,
      declared: true as const,
      releasedExposure: outstanding.toFixed(2),
      idempotentReplay: false as const,
    };
  });
}
