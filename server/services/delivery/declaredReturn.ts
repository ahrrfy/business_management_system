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

export interface DeclareReturnInput {
  consignmentId: number;
  /** سببُ الرجوع — إلزاميّ: «رفض العميل» و«العنوان خاطئ» قراراتُ متابعةٍ مختلفة. */
  reason: string;
  /** رقمُ كشف الشركة الذي أُعلن فيه الرجوع (توثيقيّ). */
  statementNumber?: string | null;
  clientRequestId?: string | null;
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
      returnDeclaredReason: input.statementNumber?.trim()
        ? `${reason} (كشف ${input.statementNumber.trim()})`
        : reason,
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
