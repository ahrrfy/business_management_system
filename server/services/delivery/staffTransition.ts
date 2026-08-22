/**
 * **قناة الموظف المستندية لتقدّم الطرد** (٢٢/٨) — ثاني قنوات الحقيقة الثلاث.
 *
 * لماذا: تقدّم `parcelStatus` كان حكراً على بوّابة المندوب (`transitionConsignmentParcel`)
 * المشروطة بعضويةٍ في `deliveryPartyMembers` — وأغلبُ جهات التوصيل كيانُ بياناتٍ بلا حساب.
 * النتيجة إنتاجياً: ٧٩/٨٤ طرداً جامداً «مُسنَد — لم يخرج» ٩-١٣ يوماً بينما الطرود خرجت
 * وسُلّمت فعلاً. هذه الوحدة تفتح للموظف تسجيلَ ما شهده بيده (سلّم الطرود للمندوب /
 * أبلغته الجهة بالتعذّر) على **نفس** أسماء أحداث البوّابة وأعمدتها حرفياً — قناتان
 * لمصدرَي سلطةٍ مختلفَين (بوّابة المندوب / شهادة الموظف) تكتبان تاريخاً واحداً لا نسختين
 * تنجرفان، والتمييز بينهما في `payload.source` لا في اسم الحدث.
 *
 * لا مالَ هنا إطلاقاً: الانتقالان تشغيليّان (خروج/تعذّر) لا يمسّان عهدةً ولا فاتورةً ولا
 * درجاً — التحصيل والتوريد يبقيان على مساراتهما المحروسة (كشف الشركة / التوريد / الاسترجاع).
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { deliveryConsignments } from "../../../drizzle/schema";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, round2 } from "../money";
import { withTx } from "../tx";
import { appendDeliveryEvent, type ParcelStatus } from "./lifecycle";
import type { DeliveryTxActor } from "./types";

/** تسميات عربية مختصرة لأسباب التخطّي — رسائل موقفية لا قاموسَ حالةٍ للواجهة. */
const PARCEL_AR: Partial<Record<ParcelStatus, string>> = {
  DELIVERED: "مُسلَّم",
  FAILED: "موسومٌ متعذّراً",
  CANCELLED: "ملغى",
  RETURNED: "مُرجَع",
};

/** الحالات التي يصحّ منها «خرج مع المندوب» بيد الموظف — تشمل ASSIGNED عمداً (انظر أدناه). */
const HANDOVER_FROM: ReadonlySet<string> = new Set<ParcelStatus>([
  "ASSIGNED",
  "ACCEPTED",
  "PICKED_UP",
]);

/** الحالات الحيّة التي يصحّ وسمُها متعذّرةً ببلاغ الجهة. */
const FAILABLE_FROM: ReadonlySet<string> = new Set<ParcelStatus>([
  "ASSIGNED",
  "ACCEPTED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
]);

/**
 * عزل الفرع للفعل الموظفيّ — **يفشل مغلقاً**: غيرُ الأدمن بلا فرعٍ مُسنَد لا يطابق شيئاً.
 * (مرآة حارس `declareConsignmentReturn`؛ الأدمن وحده يعبر الفروع — قرار المالك ١٢/٨.)
 */
function branchMismatch(actor: DeliveryTxActor, cnBranchId: number): boolean {
  if (actor.role === "admin") return false;
  return actor.branchId == null || Number(cnBranchId) !== Number(actor.branchId);
}

export interface StaffHandoverInput {
  consignmentIds: number[];
  /** يُملأ في الشاغر فقط — سائقٌ مُسنَدٌ سلفاً لا يُداس (انظر التعليق عند التحديث). */
  assignedUserId?: number | null;
  clientRequestId: string;
}

export interface StaffHandoverResult {
  moved: number;
  skipped: { consignmentId: number; reason: string }[];
}

/**
 * «خرجت الطرود مع المندوب فعلاً» — تسجيلٌ جماعيّ بيد الموظف.
 *
 * عمليةٌ جماعية ⇒ **تخطٍّ مُعلَّل لا throw**: صفٌّ واحد غير مستوفٍ لا يُسقط تسجيل بقية
 * الدفعة (بخلاف المسارات المالية الذرّية) — لا مالَ هنا، وكل طردٍ مستقلٌّ عن أخيه،
 * والموظف يحتاج أن يعرف مَن تخطّيناه ولماذا ليُعالجه بمساره الصحيح.
 *
 * idempotency بالتصميم لا بمفتاحٍ مخزَّن: مخرجُ الدفعة تقريرٌ صفّيّ (moved/skipped[])
 * لا يُمثَّل بـrefId عدديّ واحد، والإعادةُ بنفس المفتاح تمرّ على نفس المسار فتجد الطرود
 * `OUT_FOR_DELIVERY` فتُعيدها في skipped («خارج فعلاً») بلا حدثٍ ثانٍ — ويحرس الفهرسُ
 * الفريد على `deliveryEvents.eventKey` (CN:{id}:STAFF_OUT:{clientRequestId}) أيَّ سباقٍ
 * يفلت من ذلك.
 */
export async function staffHandoverConsignments(
  input: StaffHandoverInput,
  actor: DeliveryTxActor,
): Promise<StaffHandoverResult> {
  // إزالة التكرار + ترتيبٌ تصاعديّ حتميّ: دفعتان متزامنتان تقفلان الصفوف بنفس الترتيب
  // ⇒ لا جمود متقاطع (نفس مبدأ ترتيب الأقفال الموحّد في dispatch.ts).
  const ids = Array.from(new Set(input.consignmentIds.map(Number))).sort((a, b) => a - b);
  if (ids.length === 0) return { moved: 0, skipped: [] };

  return withTx(async (tx) => {
    let moved = 0;
    const skipped: { consignmentId: number; reason: string }[] = [];
    const now = new Date();

    for (const consignmentId of ids) {
      const cn = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, consignmentId))
          .for("update")
          .limit(1)
      )[0];
      if (!cn) {
        skipped.push({ consignmentId, reason: "الإرسالية غير موجودة" });
        continue;
      }
      if (branchMismatch(actor, Number(cn.branchId))) {
        skipped.push({ consignmentId, reason: "تخصّ فرعاً آخر" });
        continue;
      }
      if (cn.status !== "DISPATCHED") {
        skipped.push({ consignmentId, reason: "ليست قيد الإرسال" });
        continue;
      }
      // الرجوعُ المُعلَن أغلق توقّع التحصيل — مخرجُه الوحيد الاسترجاع بعد الاستلام،
      // وتسجيلُ «خروجٍ» عليه يكذّب الكشفَ الذي أعلن رجوعه.
      if (cn.returnDeclaredAt != null) {
        skipped.push({ consignmentId, reason: "أُعلن رجوعها — بانتظار الاستلام والفحص" });
        continue;
      }
      // idempotent عملياً: الطرد الخارج سلفاً يُتخطّى بلا حدثٍ ثانٍ — فتكرار الدفعة آمن.
      if (cn.parcelStatus === "OUT_FOR_DELIVERY") {
        skipped.push({ consignmentId, reason: "خارج فعلاً مع المندوب" });
        continue;
      }
      if (!HANDOVER_FROM.has(cn.parcelStatus)) {
        skipped.push({
          consignmentId,
          reason: `الطرد ${PARCEL_AR[cn.parcelStatus as ParcelStatus] ?? cn.parcelStatus} — لا يُسجَّل له خروج`,
        });
        continue;
      }

      await tx
        .update(deliveryConsignments)
        .set({
          // نفس العمودَين اللذَين تكتبهما البوّابة لهذا الانتقال حرفياً
          // (transitionConsignmentParcel: parcelStatus + outForDeliveryAt).
          parcelStatus: "OUT_FOR_DELIVERY",
          outForDeliveryAt: now,
          // لا تدهس سائقاً مُسنَداً: الإسنادُ سلطةُ الإرسال/قبول السائق؛ الموظف هنا
          // يملأ الشاغر فقط حين يعرف مَن أخذ الطرد يداً بيد.
          ...(input.assignedUserId != null && cn.assignedUserId == null
            ? { assignedUserId: Number(input.assignedUserId) }
            : {}),
        })
        .where(eq(deliveryConsignments.id, Number(cn.id)));

      // القفزة من ASSIGNED مباشرةً **مقصودة ومبرَّرة**: تدرّجُ ACCEPTED→PICKED_UP انضباطُ
      // بوّابة المندوب الذاتية (تسلسل تأكيداته على هاتفه)، لا واقعُ المكتبة — الموظف
      // يسلّم الطرد يداً بيد فيشهد الخروجَ نفسه. لذلك لا `assertParcelTransition` هنا
      // بل الفحص الصريح أعلاه، والحدثُ يحمل fromParcelStatus الحقيقيّ فيبقى التاريخ صادقاً.
      await appendDeliveryEvent(tx, {
        // لاحقة clientRequestId حاملةُ معنى لا زينة: `eventKey` عليه فهرسٌ فريد، والطرد
        // قد يخرج **مرّةً ثانية مشروعة** بعد FAILED→ASSIGNED — مفتاحٌ عارٍ (CN:{id}:STAFF_OUT)
        // كان يُفجّر الدفعة الثانية على القيد الفريد. أمّا إعادةُ نفس الطلب فلا تصل هنا
        // أصلاً (تُتخطّى «خارج فعلاً») ⇒ لا تكرار بالمفتاحَين معاً.
        eventKey: `CN:${cn.id}:STAFF_OUT:${input.clientRequestId}`,
        consignmentId: Number(cn.id),
        // نفس اسم حدث البوّابة للانتقال (eventType = toStatus) — قاموسُ أحداثٍ واحد.
        eventType: "OUT_FOR_DELIVERY",
        fromParcelStatus: cn.parcelStatus,
        toParcelStatus: "OUT_FOR_DELIVERY",
        fromMoneyStatus: cn.moneyStatus,
        toMoneyStatus: cn.moneyStatus,
        actorUserId: actor.userId,
        // مصدرُ السلطة: شهادة الموظف المستندية لا بوّابة المندوب.
        payload: { source: "STAFF_HANDOVER" },
      });
      moved += 1;
    }

    return { moved, skipped };
  });
}

export interface StaffMarkFailedInput {
  consignmentId: number;
  reason: string;
  clientRequestId: string;
}

export interface StaffMarkFailedResult {
  consignmentId: number;
  status: "FAILED";
  replay: boolean;
}

/**
 * «أبلغتنا الجهة بتعذّر التسليم» — وسمٌ بيد الموظف على نفس عمودَي البوّابة
 * (parcelStatus=FAILED + failedAt + failureReason) وبنفس اسم حدثها.
 *
 * عمليةٌ مفردة ⇒ throw صريح (بخلاف الدفعة): الموظف يوثّق بلاغاً بعينه ويحتاج سببَ
 * الرفض فوراً لا تقريرَ تخطٍّ.
 */
export async function staffMarkFailed(
  input: StaffMarkFailedInput,
  actor: DeliveryTxActor,
): Promise<StaffMarkFailedResult> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < 2) {
    // نفس رسالة البوّابة حرفياً — شرطُ السبب واحد أياً كانت القناة.
    throw new TRPCError({ code: "BAD_REQUEST", message: "اكتب سبب تعذر التوصيل" });
  }
  const payloadHash = idempotencyHash({
    consignmentId: Number(input.consignmentId),
    reason,
  });
  return withTx(async (tx) => {
    const replay = await checkIdempotency(
      tx,
      "delivery.staffMarkFailed",
      input.clientRequestId,
      payloadHash,
    );
    if (replay != null)
      return { consignmentId: replay, status: "FAILED" as const, replay: true };

    const cn = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, Number(input.consignmentId)))
        .for("update")
        .limit(1)
    )[0];
    if (!cn)
      throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    // إعادة الفحص بعد القفل (نمط البوّابة): طلبان متزامنان بنفس المفتاح يتسلسلان على
    // قفل الصفّ — بلا هذه الإعادة يسقط الثاني على حارس الحالة بدل الإعادة الصامتة.
    const replayAfterLock = await checkIdempotency(
      tx,
      "delivery.staffMarkFailed",
      input.clientRequestId,
      payloadHash,
    );
    if (replayAfterLock != null)
      return { consignmentId: replayAfterLock, status: "FAILED" as const, replay: true };

    if (branchMismatch(actor, Number(cn.branchId))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخصّ فرعاً آخر" });
    }
    if (cn.status !== "DISPATCHED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الإرسالية ${cn.consignmentNumber} ليست بالطريق — لا يُوسَم بالتعذّر طردٌ غير مُرسَل`,
      });
    }
    if (cn.returnDeclaredAt != null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `رجوعُ ${cn.consignmentNumber} مُعلَنٌ سلفاً — أكمِل الاسترجاع بعد استلامه، لا وسمَ تعذّرٍ فوقه`,
      });
    }
    if (!FAILABLE_FROM.has(cn.parcelStatus)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الطرد ${PARCEL_AR[cn.parcelStatus as ParcelStatus] ?? cn.parcelStatus} — حالته لا تقبل وسم التعذّر`,
      });
    }
    // ⛔ طردٌ حُصِّل منه مالٌ ليس «متعذّراً»: وسمُه كذلك يترك نقداً بيد الجهة على طردٍ
    // يدّعي سجلُّه أنه لم يُسلَّم — التسوية الصادقة عبر كشف الشركة (تحصيل/رجوع) لا هنا.
    const collected = round2(money(cn.collectedAmount ?? "0"));
    if (collected.gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `حُصِّل ${collected.toFixed(2)} على ${cn.consignmentNumber} — لا يُوسَم متعذّراً؛ سوِّه عبر كشف الشركة`,
      });
    }
    // نفس المنطق للسداد بالكاونتر: زبونٌ سدّد بعد ثبوت التسليم ⇒ الطرد وصل، ووسمُ
    // التعذّر فوقه يكذّب مستندَ السداد (فشلٌ مغلق — العمود الجديد 0249).
    const counterSettled = round2(money(cn.counterSettledAmount ?? "0"));
    if (counterSettled.gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `سُدِّد ${counterSettled.toFixed(2)} بالكاونتر على ${cn.consignmentNumber} بعد ثبوت تسليمه — لا يُوسَم متعذّراً`,
      });
    }

    const now = new Date();
    await tx
      .update(deliveryConsignments)
      .set({
        // نفس أعمدة البوّابة لهذا الانتقال حرفياً (failedAt + failureReason).
        parcelStatus: "FAILED",
        failedAt: now,
        failureReason: reason.slice(0, 500),
      })
      .where(eq(deliveryConsignments.id, Number(cn.id)));

    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:FAILED:${input.clientRequestId}`,
      // نفس اسم حدث الفشل الذي تكتبه البوّابة — والمصدر في payload.
      eventType: "FAILED",
      consignmentId: Number(cn.id),
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: "FAILED",
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: cn.moneyStatus,
      actorUserId: actor.userId,
      payload: { source: "STAFF", reason },
    });

    await recordIdempotencyKey(
      tx,
      "delivery.staffMarkFailed",
      input.clientRequestId,
      Number(cn.id),
      payloadHash,
    );

    return { consignmentId: Number(cn.id), status: "FAILED" as const, replay: false };
  });
}
